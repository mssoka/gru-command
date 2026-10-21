import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configPathFor, DEFAULT_SILAS_CONFIG, loadConfig } from '../src/config.js';
import { WaveRunner, type WaveOutcome } from '../src/dispatch/perkins.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import type { AgentSpawner, DispatchService } from '../src/dispatch/service.js';
import { computeSilasDigest } from '../src/dispatch/silas-driver.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, REVIEW_OWNER_CEASED_KIND } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { RuntimeRegistry, ledgerReviewOwnerCessation, type ReviewOwnerCessationLedger, type ReviewOwnerMarker } from '../src/runtime/registry.js';
import type { AgentHandle } from '../src/runtime/types.js';
import { SessionStore } from '../src/sessions/store.js';
import { processTableAsync, type ProcessTable } from '../src/worktrees/manager.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { GitReviewPort } from './helpers/git-review-port.js';
import { fakeWholeSpawner } from './helpers/perkins-whole-double.js';

/**
 * #464: a restart must not permanently block a job's final review after a
 * claude-code Perkins round it interrupted, and must never accept PID death
 * alone as Claude cessation. Live case: rt-agencies-motion-r1 (owner pid
 * 76355, three disposed sessions, POST /api/dispatch/review refused 400).
 */

const DOUBLE = join(import.meta.dirname, 'helpers', 'claude-double.mjs');
const TOKEN = 'review-owner-cessation-token';
/** Above every platform's pid_max: provably no live process. */
const DEAD_PID = 2147483647;
const LONG_AGO = '2020-01-01T00:00:00.000Z';

const dirs: string[] = [];
const repos: FixtureRepo[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
  while (repos.length > 0) repos.pop()!.cleanup();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A delivered job with its lane, ready for a review round. */
async function reviewJob(name: string) {
  const repo = makeFixtureRepo(name);
  repos.push(repo);
  repo.git(['checkout', '-b', 'feature/review']);
  const target = repo.commitFile('src/main.ts', 'export const answer = 42;\n');
  const db = new LedgerDb(temp(`${name}-db-`));
  closers.push(async () => db.close());
  const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
  const port = new GitReviewPort(temp(`${name}-port-`), 'feature/review', target, ledger);
  const jobId = `job-${name}`;
  await port.createJobWorktree({ repoPath: repo.path, jobId });
  ledger.addJob({ id: jobId, repo: 'fixture', title: name, baseBranch: 'main', briefing: 'Goal: ship it.\nAcceptance 1: it ships.' });
  ledger.setJobStatus(jobId, 'working');
  ledger.registerWorktree(port.listWorktrees({ jobId })[0]!);
  ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { sha: target } });
  const home = temp(`${name}-home-`);
  writeFileSync(configPathFor(home), `workspace_root = "${temp(`${name}-ws-`)}"\n[runtimes]\ndefault = "claude-code"\n`);
  const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
  return { repo, ledger, port, jobId, target, config, home };
}

/** A job whose last round was interrupted with a claude-code owner marker
 * from another process: what the restarted service sees. */
async function interruptedClaudeRound(name: string) {
  const job = await reviewJob(name);
  const old = job.ledger.addRound({ jobId: job.jobId, targetRef: job.target, lenses: ['blind'] });
  const lane = await job.port.createReviewWorktree({ repoPath: job.repo.path, roundId: old.id, ref: job.target, jobId: job.jobId });
  const marker = ownerMarker(job, old.id, DEAD_PID);
  return { ...job, old, lane, marker };
}

type Job = Awaited<ReturnType<typeof reviewJob>>;
type Fixture = Awaited<ReturnType<typeof interruptedClaudeRound>>;

/** The round's write-once owner marker, as Perkins reads it back. */
function ownerMarker(f: Job, roundId: string, pid: number): ReviewOwnerMarker {
  const marker = { roundId, runtimeId: 'claude-code', pid, generation: randomUUID() };
  const event = f.ledger.appendCustomEvent({ kind: 'round.review-owner', jobId: f.jobId, roundId, payload: { ...marker, targetSha: f.target } });
  return { ...marker, recordedAt: event.ts };
}

/** A second interrupted round of the same job, owned by `pid`. */
function otherRound(f: Fixture, pid: number): ReviewOwnerMarker {
  const round = f.ledger.addRound({ jobId: f.jobId, targetRef: f.target, lenses: ['blind'] });
  return ownerMarker(f, round.id, pid);
}

/** A fresh registry for the restarted service: no in-memory cessation. */
function restartedRegistry(f: Job, extra: Partial<ConstructorParameters<typeof RuntimeRegistry>[0]> = {}): RuntimeRegistry {
  return new RuntimeRegistry({
    config: f.config, store: new SessionStore(f.config.dataDir),
    claude: { binary: DOUBLE, reviewSettingsFile: join(f.home, 'absent-review-settings.json') },
    reviewOwnerCessation: ledgerReviewOwnerCessation(() => f.ledger),
    ...extra,
  });
}

/** Registered, disposed sessions of the old round, as the ledger keeps them. */
function registerDisposedSession(f: Fixture, label: string, sessionFile: string | null = null): string {
  const id = randomUUID();
  f.ledger.registerAgent({ id, role: 'perkins', label, jobId: f.jobId, roundId: f.old.id, sessionFile });
  f.ledger.setAgentState(id, 'disposed');
  return id;
}

/** A review lead that refuses its prompt: only admission counts. */
function refusingSpawner(): AgentSpawner {
  const sessions = temp('owner-cessation-sessions-');
  return async (role) => {
    const sessionFile = join(sessions, `${randomUUID()}.jsonl`);
    writeFileSync(sessionFile, '');
    const handle: AgentHandle = {
      role, id: randomUUID(), sessionFile, reviewIsolation: true,
      capabilities: { streaming: false, steer: 'queued', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
      health: () => ({ state: 'idle', lastActivity: null, sessionFile }),
      prompt: async () => { throw new Error('fixture lead refuses'); },
      steer: async () => {}, followUp: async () => {},
      subscribe: () => () => {}, dispose: async () => {},
    };
    return handle;
  };
}

/** The restarted service's wave, owner proofs wired from `registry`. */
function restartedWave(f: Job, registry: RuntimeRegistry, spawner: AgentSpawner = refusingSpawner()): WaveRunner {
  const wave = new WaveRunner({
    ledger: f.ledger, worktrees: f.port, spawner, reviewArtifactRoot: temp('owner-cessation-artifacts-'),
    reconcileReviewAgent: async (agentId, marker) => registry.reviewOwnerCeased(agentId, marker),
    proveReviewHostExit: (input) => registry.proveReviewHostExit(input),
    supersessionDeadlineMs: 1_000,
  });
  closers.push(async () => { await wave.shutdown(); });
  return wave;
}

/** The restarted service's review endpoint over a real wave. */
async function serveReview(f: Fixture, registry: RuntimeRegistry): Promise<(body: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> }>> {
  const wave = restartedWave(f, registry);
  const dir = temp('owner-cessation-server-');
  writeFileSync(join(dir, 'config.toml'), `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`, 'utf-8');
  const server = createDispatchServer({
    config: loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester'),
    dispatch: null as unknown as DispatchService, wave, ledger: f.ledger, pendingProducerBlockers: () => [],
  });
  const http: HttpServer = createServer((req, res) => {
    if (server.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => http.close(() => resolve())));
  const port = (http.address() as AddressInfo).port;
  return async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dispatch/review`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
}

function refusal(response: { json: Record<string, unknown> }): string {
  return String(response.json['detail'] ?? response.json['error']);
}

/** A real process that stays alive until the test kills it. */
function liveProcess(args: readonly string[], cwd: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', ...args], { cwd, stdio: 'ignore' });
  closers.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  });
  return child;
}

async function stop(child: ChildProcess): Promise<void> {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

function hostExitRecords(f: Job) {
  return f.ledger.listEvents({ limit: 1000 }).filter((event) => event.kind === REVIEW_OWNER_CEASED_KIND &&
    (event.payload as { source?: unknown }).source === 'host-exit');
}

const CLEAN_TABLE: ProcessTable = { rootedIn: () => [], naming: () => [], cwdsListed: true };

describe('review-owner cessation survives a restart (#464)', () => {
  it('a restarted registry accepts a claude-code owner from another pid whose host saw it cease, and the review endpoint admits the replacement #contract:review-owner-durable-cessation:claude-code', async () => {
    const f = await interruptedClaudeRound('owner-cessation-durable');
    // The OLD host: its real Claude review lead and one lens are mid-turn
    // when the service shuts down; disposal observes each child's close.
    const owner = restartedRegistry(f);
    const sessions = [
      await owner.spawn('perkins', { cwd: f.lane.path, reviewOwnerGeneration: f.marker.generation,
        reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] } }),
      await owner.spawn('perkins', { cwd: f.lane.path, reviewOwnerGeneration: f.marker.generation,
        isolatedReview: { systemPrompt: 'lens', tools: [] } }),
    ];
    const turns = sessions.map((session, index) => {
      f.ledger.registerAgent({ id: session.id, role: 'perkins', label: index === 0 ? 'lead' : 'edge', jobId: f.jobId,
        roundId: f.old.id, sessionFile: session.sessionFile ?? null });
      return session.prompt(`hold:${join(f.home, 'never-released')}`).catch(() => {});
    });
    for (const session of sessions) await expect.poll(() => session.health().state, { timeout: 10_000 }).toBe('streaming');
    await owner.dispose();
    await Promise.all(turns);
    for (const session of sessions) f.ledger.setAgentState(session.id, 'disposed');
    f.ledger.setRoundStatus(f.old.id, 'aborted');
    expect(f.ledger.listEvents({ limit: 1000 }).filter((event) => event.kind === REVIEW_OWNER_CEASED_KIND).map((event) => event.payload))
      .toEqual(expect.arrayContaining(sessions.map((session) => expect.objectContaining({
        source: 'adapter', roundId: f.old.id, agentId: session.id, generation: f.marker.generation, observerPid: process.pid,
      }))));

    // The RESTARTED service: empty in-memory state, the same ledger.
    const restarted = restartedRegistry(f);
    for (const session of sessions) expect(restarted.reviewOwnerCeased(session.id, f.marker)).toBe(true);
    // The record binds this marker and session only.
    expect(restarted.reviewOwnerCeased(sessions[0]!.id, { ...f.marker, generation: randomUUID() })).toBe(false);
    expect(restarted.reviewOwnerCeased(randomUUID(), f.marker)).toBe(false);
    expect(restarted.reviewOwnerCeased('', f.marker)).toBe(false);
    const post = await serveReview(f, restarted);
    const admitted = await post({ job_id: f.jobId, target_ref: f.target });
    expect(admitted.status).toBe(202);
    expect(admitted.json).toMatchObject({ route: 'perkins' });
    expect(f.ledger.listRounds(f.jobId).map((round) => round.id)).toEqual([f.old.id, admitted.json['round_id']]);
    // The durable record answered: no dead-host proof was needed.
    expect(hostExitRecords(f)).toEqual([]);
  }, 60_000);

  it('without a durable record, PID death alone never admits a claude-code replacement', async () => {
    const f = await interruptedClaudeRound('owner-cessation-pid-alone');
    const agentId = registerDisposedSession(f, 'lead');
    const second = registerDisposedSession(f, 'edge');
    f.ledger.setRoundStatus(f.old.id, 'aborted');
    // The host pid is dead, but the rest of the evidence cannot be read.
    const blind: ProcessTable = { ...CLEAN_TABLE, cwdsListed: false };
    const restarted = restartedRegistry(f, { ownerProcessProbe: () => 'dead', processTable: async () => blind });
    expect(restarted.reviewOwnerCeased(agentId, f.marker)).toBe(false);
    const post = await serveReview(f, restarted);
    const refused = await post({ job_id: f.jobId, target_ref: f.target });
    expect(refused.status).toBe(400);
    expect(refusal(refused)).toMatch(new RegExp(`review owner (${agentId}|${second}) \\(and 1 more session\\(s\\)\\) from round ${f.old.id} may still run; ` +
      'a replacement writer starts only once its cessation is proven \\(dead-host proof refused: the working directories of running processes cannot be listed\\)', 'u'));
    // A registry with no dead-host proof wired refuses the same way.
    const unwired = new RuntimeRegistry({ config: f.config, store: new SessionStore(f.config.dataDir), ownerProcessProbe: () => 'dead' });
    expect(unwired.reviewOwnerCeased(agentId, f.marker)).toBe(false);
    await expect(unwired.proveReviewHostExit({ marker: f.marker, worktreePath: f.lane.path, sessions: [] }))
      .resolves.toMatchObject({ ok: false, problem: expect.stringMatching(/no durable cessation record is wired/u) });
    expect(f.ledger.listRounds(f.jobId)).toHaveLength(1);
    expect(hostExitRecords(f)).toEqual([]);
  }, 60_000);

  it('the dead-host proof refuses while a process rooted in the review worktree lives, then admits and records the proof once it exits', async () => {
    const f = await interruptedClaudeRound('owner-cessation-host-exit');
    registerDisposedSession(f, 'lead');
    registerDisposedSession(f, 'edge');
    f.ledger.setRoundStatus(f.old.id, 'aborted');
    const restarted = restartedRegistry(f);
    const post = await serveReview(f, restarted);
    const straggler = liveProcess([], f.lane.path);
    const refused = await post({ job_id: f.jobId, target_ref: f.target });
    expect(refused.status).toBe(400);
    expect(refusal(refused)).toMatch(new RegExp(
      `dead-host proof refused: pid ${String(straggler.pid)} \\(cwd\\) still rooted in review worktree .*; the replacement starts once it exits`, 'u'));
    expect(f.ledger.listRounds(f.jobId)).toHaveLength(1);
    expect(hostExitRecords(f)).toEqual([]);
    await stop(straggler);
    const admitted = await post({ job_id: f.jobId, target_ref: f.target });
    expect(admitted.status).toBe(202);
    expect(f.ledger.listRounds(f.jobId)).toHaveLength(2);
    const proof = hostExitRecords(f);
    expect(proof).toHaveLength(1);
    expect(proof[0]?.payload).toMatchObject({
      source: 'host-exit', roundId: f.old.id, generation: f.marker.generation, pid: DEAD_PID,
      evidence: { worktreePath: f.lane.path, host: 'dead' },
    });
    // Recorded once: the record answers every later reconciliation.
    expect(restarted.reviewOwnerCeased('', f.marker)).toBe(true);
  }, 120_000);

  it('over a swept review worktree, the proof refuses a live process naming a review session and session locks still held, and frees the gone host\'s own locks', async () => {
    const f = await interruptedClaudeRound('owner-cessation-session');
    await f.port.release({ worktreeId: f.old.id }); // the live case's lane was swept
    const restarted = restartedRegistry(f);
    const sessionDir = new SessionStore(f.config.dataDir).sessionDirFor('perkins', f.lane.path);
    mkdirSync(sessionDir, { recursive: true });
    // A session spawned just before a crash, never registered: found by its file.
    const unregistered = randomUUID();
    const sessionFile = join(sessionDir, `2026-10-21T01-59-57-569Z_${unregistered}.jsonl`);
    writeFileSync(sessionFile, '');
    const input = { marker: f.marker, worktreePath: f.lane.path, sessions: [] };
    const cli = liveProcess(['--session-id', unregistered], temp('owner-cessation-elsewhere-'));
    await expect(restarted.proveReviewHostExit(input)).resolves.toMatchObject({
      ok: false, problem: `pid ${String(cli.pid)} (argv) still names review session ${unregistered}; the replacement starts once it exits`,
    });
    await stop(cli);
    const lock = (holder: Record<string, unknown>): void => writeFileSync(`${sessionFile}.lock`, JSON.stringify({ bootId: 'b', acquiredAt: '', heartbeatAt: '', ...holder }));
    lock({ host: hostname(), pid: process.pid });
    await expect(restarted.proveReviewHostExit(input)).resolves.toMatchObject({
      ok: false, problem: `session lock ${sessionFile}.lock is held by alive pid ${String(process.pid)}`,
    });
    lock({ host: 'elsewhere.example', pid: process.pid });
    await expect(restarted.proveReviewHostExit(input)).resolves.toMatchObject({
      ok: false, problem: `session lock ${sessionFile}.lock is held on host elsewhere.example; remove it once no process holds it`,
    });
    // The gone host's own lock is free under any hostname it recorded.
    lock({ host: 'renamed-laptop.local', pid: DEAD_PID });
    await expect(restarted.proveReviewHostExit(input)).resolves.toMatchObject({
      ok: true, evidence: { sessionIds: [unregistered], sessionFiles: 1, host: 'dead' },
    });
    expect(hostExitRecords(f)).toHaveLength(1);
  }, 120_000);

  it('the proof\'s host check refuses a live or unprobeable host and accepts a reused pid or this process restarted under it', async () => {
    const f = await interruptedClaudeRound('owner-cessation-host-states');
    const clean = { processTable: async () => CLEAN_TABLE };
    const at = (marker: ReviewOwnerMarker) => ({ marker, worktreePath: f.lane.path, sessions: [] });
    const timeless: ReviewOwnerMarker = { roundId: f.marker.roundId, runtimeId: f.marker.runtimeId, pid: f.marker.pid, generation: f.marker.generation };
    await expect(restartedRegistry(f, { ...clean, ownerProcessProbe: () => 'alive' }).proveReviewHostExit(at(timeless)))
      .resolves.toEqual({ ok: false, problem: `its host pid ${String(DEAD_PID)} is still running; the replacement starts once it exits` });
    await expect(restartedRegistry(f, { ...clean, ownerProcessProbe: () => 'unknown' }).proveReviewHostExit(at(f.marker)))
      .resolves.toEqual({ ok: false, problem: `its host pid ${String(DEAD_PID)} cannot be probed` });
    // A live pid whose process started before the marker is the host.
    const parent = otherRound(f, process.ppid);
    await expect(restartedRegistry(f, clean).proveReviewHostExit(at(parent)))
      .resolves.toEqual({ ok: false, problem: `its host pid ${String(process.ppid)} is still running; the replacement starts once it exits` });
    // A process that started after the marker reuses the gone host's pid.
    const reuser = liveProcess([], temp('owner-cessation-reuser-'));
    await expect(restartedRegistry(f, clean).proveReviewHostExit(at({ ...otherRound(f, reuser.pid!), recordedAt: LONG_AGO })))
      .resolves.toMatchObject({ ok: true, evidence: { host: 'pid-reused' } });
    // This process's own marker decides by its adapter evidence only; one an
    // earlier process left under this same pid is a gone host.
    const own = otherRound(f, process.pid);
    await expect(restartedRegistry(f, clean).proveReviewHostExit(at(own)))
      .resolves.toEqual({ ok: false, problem: 'its host is this process, so only its own adapter evidence proves cessation' });
    const restarted = restartedRegistry(f, clean);
    await expect(restarted.proveReviewHostExit(at({ ...own, recordedAt: LONG_AGO })))
      .resolves.toMatchObject({ ok: true, evidence: { host: 'restarted' } });
    expect(restarted.reviewOwnerCeased('', { ...own, recordedAt: LONG_AGO })).toBe(true);
    expect(hostExitRecords(f).map((event) => (event.payload as { evidence: { host: string } }).evidence.host).sort())
      .toEqual(['pid-reused', 'restarted']);
  }, 120_000);

  it('the proof refuses every piece of evidence it cannot read, and a proof it cannot record', async () => {
    const f = await interruptedClaudeRound('owner-cessation-unreadable');
    const input = { marker: f.marker, worktreePath: f.lane.path, sessions: [] };
    await expect(restartedRegistry(f, { processTable: async () => { throw new Error('ps failed'); } }).proveReviewHostExit(input))
      .resolves.toEqual({ ok: false, problem: 'the process table cannot be listed (Error: ps failed)' });
    const clean = restartedRegistry(f, { processTable: async () => CLEAN_TABLE });
    await expect(clean.proveReviewHostExit({ ...input, worktreePath: null }))
      .resolves.toEqual({ ok: false, problem: `round ${f.old.id} has no registered review worktree to check` });
    const sessionDir = new SessionStore(f.config.dataDir).sessionDirFor('perkins', f.lane.path);
    mkdirSync(join(sessionDir, '..'), { recursive: true });
    writeFileSync(sessionDir, 'not a directory');
    await expect(clean.proveReviewHostExit(input)).resolves.toMatchObject({
      ok: false, problem: expect.stringMatching(new RegExp(`^session directory ${sessionDir} cannot be listed`, 'u')),
    });
    rmSync(sessionDir);
    mkdirSync(sessionDir);
    const sessionFile = join(sessionDir, `2026-10-21T01-59-57-569Z_${randomUUID()}.jsonl`);
    writeFileSync(sessionFile, '');
    writeFileSync(`${sessionFile}.lock`, '{torn');
    await expect(clean.proveReviewHostExit(input)).resolves.toMatchObject({
      ok: false, problem: expect.stringMatching(/is unreadable .*; remove it once no process holds it$/u),
    });
    writeFileSync(`${sessionFile}.lock`, '{}');
    await expect(clean.proveReviewHostExit(input)).resolves.toEqual({
      ok: false, problem: `session lock ${sessionFile}.lock names no owner pid; remove it once no process holds it`,
    });
    rmSync(`${sessionFile}.lock`);
    const unrecordable: ReviewOwnerCessationLedger = {
      ...ledgerReviewOwnerCessation(() => f.ledger),
      recordHostExit: () => { throw new Error('ledger closed'); },
    };
    await expect(restartedRegistry(f, { processTable: async () => CLEAN_TABLE, reviewOwnerCessation: unrecordable }).proveReviewHostExit(input))
      .resolves.toEqual({ ok: false, problem: 'the dead-host proof passed but could not be recorded (Error: ledger closed)' });
    expect(hostExitRecords(f)).toEqual([]);
  }, 60_000);

  it('concurrent dead-host proofs of one owner record it once', async () => {
    const f = await interruptedClaudeRound('owner-cessation-once');
    const registry = restartedRegistry(f, { processTable: async () => CLEAN_TABLE });
    const input = { marker: f.marker, worktreePath: f.lane.path, sessions: [] };
    const [first, second] = await Promise.all([registry.proveReviewHostExit(input), registry.proveReviewHostExit(input)]);
    expect(first.ok && second.ok).toBe(true);
    expect(hostExitRecords(f)).toHaveLength(1);
  });

  it('an adapter cessation the ledger cannot keep is logged loudly, never silently lost', async () => {
    const f = await interruptedClaudeRound('owner-cessation-unkept');
    const logs: { level: string; msg: string }[] = [];
    const owner = restartedRegistry(f, {
      log: (level, msg) => logs.push({ level, msg }),
      reviewOwnerCessation: { ...ledgerReviewOwnerCessation(() => f.ledger), recordAdapterCessation: () => { throw new Error('ledger closed'); } },
    });
    const lens = await owner.spawn('perkins', { cwd: f.lane.path, reviewOwnerGeneration: f.marker.generation,
      isolatedReview: { systemPrompt: 'lens', tools: [] } });
    await lens.prompt('review');
    await owner.dispose();
    expect(logs).toContainEqual({ level: 'error',
      msg: 'review-owner cessation could not be recorded; a restarted service must prove the host gone instead' });
    expect(f.ledger.latestRoundEvent(f.old.id, REVIEW_OWNER_CEASED_KIND)).toBeNull();
  }, 60_000);

  it('a writer waiting on a restart-interrupted supersession is refused while the old owner\'s straggler lives, and cleared once it exits', async () => {
    const f = await interruptedClaudeRound('owner-cessation-writer');
    registerDisposedSession(f, 'lead');
    f.ledger.setRoundStatus(f.old.id, 'aborted');
    // The restart cut the supersession before its stop was proven.
    f.ledger.appendCustomEvent({ kind: 'round.superseded', jobId: f.jobId, roundId: f.old.id,
      payload: { reason: 'material amendment #1 accepted', by: 'gru', status: 'live', settled_specialists: [] } });
    const wave = restartedWave(f, restartedRegistry(f));
    expect(wave.activeReview(f.jobId)?.roundIds).toEqual([f.old.id]);
    const straggler = liveProcess([], f.lane.path);
    await expect(wave.clearLaneForWriter({ jobId: f.jobId, writer: 'directive req-1' })).rejects.toThrow(
      new RegExp(`round ${f.old.id} review session\\(s\\) .* not proven ceased \\(dead-host proof refused: pid ${String(straggler.pid)} \\(cwd\\) still rooted`, 'u'));
    await stop(straggler);
    await expect(wave.clearLaneForWriter({ jobId: f.jobId, writer: 'directive req-1' })).resolves.toMatchObject({ confirmed: true });
    expect(wave.activeReview(f.jobId)).toBeNull();
    expect(hostExitRecords(f)).toHaveLength(1);
  }, 120_000);

  it('a process whose working directory is the swept tree, as Linux names it, is still rooted in it', async () => {
    const tree = join(temp('owner-cessation-tree-'), 'review-round-1');
    const child = liveProcess(['owner-cessation-token'], temp('owner-cessation-cwd-'));
    const table = async (cwd: string) => processTableAsync({
      onCwdError: (error) => { throw error; }, listCwds: async () => new Map([[child.pid!, cwd]]),
    });
    expect((await table(`${tree} (deleted)`)).rootedIn(tree)).toEqual([expect.objectContaining({ pid: child.pid, evidence: 'cwd' })]);
    expect((await table(`${tree}/src (deleted)`)).rootedIn(tree)).toEqual([expect.objectContaining({ pid: child.pid, evidence: 'cwd' })]);
    expect((await table(`${tree}-2 (deleted)`)).rootedIn(tree)).toEqual([]);
    const listed = await table(`${tree}-2`);
    expect(listed.naming('owner-cessation-token')).toEqual([expect.objectContaining({ pid: child.pid, evidence: 'argv' })]);
    expect(listed.cwdsListed).toBe(true);
  });

  it('a cessation record binds the round\'s unique owner marker and is never written as a custom event', async () => {
    const f = await interruptedClaudeRound('owner-cessation-ledger');
    expect(() => f.ledger.appendCustomEvent({ kind: REVIEW_OWNER_CEASED_KIND, jobId: f.jobId, roundId: f.old.id,
      payload: { source: 'host-exit', roundId: f.old.id, generation: f.marker.generation, pid: DEAD_PID } }))
      .toThrow(/recorded only through recordReviewOwnerCessation/u);
    expect(() => f.ledger.recordReviewOwnerCessation({ source: 'adapter', agentId: 'lead', generation: randomUUID() }))
      .toThrow(/binds no unique round owner marker; nothing recorded/u);
    expect(() => f.ledger.recordReviewOwnerCessation({ source: 'host-exit', roundId: f.old.id, generation: f.marker.generation,
      pid: process.pid, evidence: {} })).toThrow(/binds no unique round owner marker/u);
    // A second, conflicting marker makes the owner ambiguous: nothing binds.
    f.ledger.appendCustomEvent({ kind: 'round.review-owner', jobId: f.jobId, roundId: f.old.id,
      payload: { ...f.marker, generation: randomUUID(), targetSha: f.target } });
    expect(() => f.ledger.recordReviewOwnerCessation({ source: 'adapter', agentId: 'lead', generation: f.marker.generation }))
      .toThrow(/binds no unique round owner marker/u);
    expect(f.ledger.reviewOwnerCessationRecorded('lead', f.marker)).toBe(false);
  });
});

describe('a graceful shutdown\'s cut is the restart\'s clean abort (#464)', () => {
  const digestOf = (f: Job) => computeSilasDigest({ ledger: f.ledger, blockersForRound: async () => ({ blockers: [], note: null }),
    config: DEFAULT_SILAS_CONFIG, trigger: 'sweep' });

  it('a round cut mid-review records service_restart, and Silas offers its clean-abort re-arm on the unchanged head', async () => {
    const f = await reviewJob('owner-cessation-rearm');
    let leadStarted!: () => void;
    const started = new Promise<void>((resolve) => { leadStarted = resolve; });
    const sessions = temp('owner-cessation-rearm-sessions-');
    const spawner: AgentSpawner = async (role, options = {}) => {
      const sessionFile = join(sessions, `${randomUUID()}.jsonl`);
      writeFileSync(sessionFile, '');
      return {
        role, id: randomUUID(), sessionFile, reviewIsolation: true,
        capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
        async prompt() { if (options.reviewLead !== undefined) leadStarted(); await new Promise<void>(() => {}); },
        async steer() {}, async followUp() {}, subscribe() { return () => {}; },
        health() { return { state: 'streaming', lastActivity: null, sessionFile }; },
        async dispose() {},
      };
    };
    const wave = new WaveRunner({ ledger: f.ledger, worktrees: f.port, spawner, reviewArtifactRoot: temp('owner-cessation-rearm-art-') });
    const running = wave.runRound({ jobId: f.jobId });
    await started;
    await wave.shutdown();
    const outcome = await running as WaveOutcome;
    expect(f.ledger.latestRoundEvent(outcome.round.id, 'round.perkins-incomplete')?.payload).toMatchObject({ reason: 'service_restart' });
    f.ledger.setJobPr(f.jobId, 'https://git.example.invalid/acme/fixture/pull/464');
    expect((await digestOf(f)).prWithoutReview).toMatchObject([
      { jobId: f.jobId, cleanAbort: { roundId: outcome.round.id, ruleId: 'clean-abort-service-restart' } },
    ]);
  }, 120_000);

  it('a round cut after its workflow returned but before finalization records service_restart too', async () => {
    const f = await reviewJob('owner-cessation-finalize');
    const fake = fakeWholeSpawner(temp('owner-cessation-finalize-sessions-'), { childAnswer: () => '[]', specialists: [] });
    const service: { wave?: WaveRunner } = {};
    // The lead's disposal is the workflow's last act: the shutdown lands
    // after the workflow returned, before the round is finalized.
    const spawner: AgentSpawner = async (role, options) => {
      const handle = await fake.spawner(role, options);
      if (options?.reviewLead === undefined) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'dispose') return async () => { void service.wave?.shutdown(); await target.dispose(); };
          const value: unknown = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    service.wave = new WaveRunner({ ledger: f.ledger, worktrees: f.port, spawner, reviewArtifactRoot: temp('owner-cessation-finalize-art-') });
    const outcome = await service.wave.runRound({ jobId: f.jobId }) as WaveOutcome;
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(f.ledger.latestRoundEvent(outcome.round.id, 'round.perkins-incomplete')?.payload).toMatchObject({
      reason: 'service_restart', error: expect.stringContaining('aborted before finalization'),
    });
  }, 120_000);
});
