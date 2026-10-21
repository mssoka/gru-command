import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configPathFor, DEFAULT_SILAS_CONFIG, loadConfig } from '../src/config.js';
import { WaveRunner, type WaveOutcome } from '../src/dispatch/perkins.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import type { AgentSpawner, DispatchService } from '../src/dispatch/service.js';
import { pendingPublicationAttempt } from '../src/dispatch/publication-evidence.js';
import { computeSilasDigest } from '../src/dispatch/silas-driver.js';
import type { WorktreeLane } from '../src/dispatch/worktree-port.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, REVIEW_OWNER_CEASED_KIND } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { RuntimeRegistry, ledgerReviewOwnerCessation, type ResidentReviewRound, type ReviewOwnerCessationLedger, type ReviewOwnerMarker } from '../src/runtime/registry.js';
import { hostedByThisProcess, linuxStartTicks, processIdentity, thisProcessIdentity } from '../src/runtime/review-host-exit.js';
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
/** A start identity no live process has. */
const OTHER_HOST = 'ps:Thu Jan  1 00:00:00 1970';

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

/** Holds review-worktree creation until the test releases it. */
class GatedReviewPort extends GitReviewPort {
  reached: () => void = () => {};
  gate: Promise<void> = Promise.resolve();
  override async createReviewWorktree(input: { repoPath: string; roundId: string; ref: string; jobId?: string }): Promise<WorktreeLane> {
    const lane = await super.createReviewWorktree(input);
    this.reached();
    await this.gate;
    return lane;
  }
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
  const port = new GatedReviewPort(temp(`${name}-port-`), 'feature/review', target, ledger);
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
async function interruptedClaudeRound(name: string, host: { readonly pid: number; readonly hostIdentity?: string } = { pid: DEAD_PID, hostIdentity: OTHER_HOST }) {
  const job = await reviewJob(name);
  const old = job.ledger.addRound({ jobId: job.jobId, targetRef: job.target, lenses: ['blind'] });
  const lane = await job.port.createReviewWorktree({ repoPath: job.repo.path, roundId: old.id, ref: job.target, jobId: job.jobId });
  const marker = ownerMarker(job, old.id, host.pid, host.hostIdentity);
  return { ...job, old, lane, marker };
}

type Job = Awaited<ReturnType<typeof reviewJob>>;
type Fixture = Awaited<ReturnType<typeof interruptedClaudeRound>>;

/** The round's write-once owner marker, as Perkins reads it back. */
function ownerMarker(f: Job, roundId: string, pid: number, hostIdentity?: string): ReviewOwnerMarker {
  const marker = { roundId, runtimeId: 'claude-code', pid, generation: randomUUID(), ...(hostIdentity !== undefined ? { hostIdentity } : {}) };
  f.ledger.appendCustomEvent({ kind: 'round.review-owner', jobId: f.jobId, roundId, payload: { ...marker, targetSha: f.target } });
  return marker;
}

/** A second interrupted round of the same job, owned by `pid`. */
function otherRound(f: Fixture, pid: number, hostIdentity?: string): ReviewOwnerMarker {
  const round = f.ledger.addRound({ jobId: f.jobId, targetRef: f.target, lenses: ['blind'] });
  return ownerMarker(f, round.id, pid, hostIdentity);
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

/** A review session that never answers: shutdown is the only way out. */
function hangingSpawner(onLead: () => void = () => {}): AgentSpawner {
  const sessions = temp('owner-cessation-hanging-');
  return async (role, options = {}) => {
    const sessionFile = join(sessions, `${randomUUID()}.jsonl`);
    writeFileSync(sessionFile, '');
    return {
      role, id: randomUUID(), sessionFile, reviewIsolation: true,
      capabilities: { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
      async prompt() { if (options.reviewLead !== undefined) onLead(); await new Promise<void>(() => {}); },
      async steer() {}, async followUp() {}, subscribe() { return () => {}; },
      health() { return { state: 'streaming', lastActivity: null, sessionFile }; },
      async dispose() {},
    };
  };
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
function restartedWave(f: Job, registry: RuntimeRegistry, overrides: Partial<ConstructorParameters<typeof WaveRunner>[0]> = {}): WaveRunner {
  const wave = new WaveRunner({
    ledger: f.ledger, worktrees: f.port, spawner: refusingSpawner(), reviewArtifactRoot: temp('owner-cessation-artifacts-'),
    reconcileReviewAgent: async (agentId, marker) => registry.reviewOwnerCeased(agentId, marker),
    proveReviewHostExit: (input) => registry.proveReviewHostExit(input),
    supersessionDeadlineMs: 1_000,
    ...overrides,
  });
  closers.push(async () => { await wave.shutdown(); });
  return wave;
}

type Post = (body: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> }>;

/** The restarted service's review endpoint over a real wave. */
async function serveReview(f: Fixture, registry: RuntimeRegistry, overrides: Partial<ConstructorParameters<typeof WaveRunner>[0]> = {}): Promise<Post> {
  const wave = restartedWave(f, registry, overrides);
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
  it('a restarted registry accepts a claude-code owner from another pid whose host saw it cease, even while that pid looks alive, and the review endpoint admits the replacement #contract:review-owner-durable-cessation:claude-code', async () => {
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

    // The RESTARTED service: empty in-memory state, the same ledger, and a
    // host pid that looks alive: only the durable record can answer.
    const restarted = restartedRegistry(f, { ownerProcessProbe: () => 'alive' });
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

  it('a service restarted under the crashed owner\'s pid proves that owner gone through the review endpoint', async () => {
    // The marker names THIS pid, with the start identity of the earlier
    // process that held it (a container's pid 1 after a crash).
    const f = await interruptedClaudeRound('owner-cessation-same-pid', { pid: process.pid, hostIdentity: OTHER_HOST });
    registerDisposedSession(f, 'lead');
    f.ledger.setRoundStatus(f.old.id, 'aborted');
    const post = await serveReview(f, restartedRegistry(f));
    const admitted = await post({ job_id: f.jobId, target_ref: f.target });
    expect(admitted.status).toBe(202);
    expect(hostExitRecords(f).map((event) => event.payload)).toMatchObject([
      { source: 'host-exit', pid: process.pid, evidence: { host: 'restarted' } },
    ]);
  }, 60_000);

  it('a recorded proof the wave\'s own cessation check still refuses says so by name', async () => {
    const f = await interruptedClaudeRound('owner-cessation-unaccepted');
    const agentId = registerDisposedSession(f, 'lead');
    f.ledger.setRoundStatus(f.old.id, 'aborted');
    const registry = restartedRegistry(f, { processTable: async () => CLEAN_TABLE });
    const post = await serveReview(f, registry, { reconcileReviewAgent: async () => false });
    const refused = await post({ job_id: f.jobId, target_ref: f.target });
    expect(refused.status).toBe(400);
    expect(refusal(refused)).toContain(`(the dead-host proof is recorded, but this service's cessation check still refuses ${agentId}; ` +
      'the service is miswired: its dead-host proof and cessation check must come from one runtime registry)');
    expect(hostExitRecords(f)).toHaveLength(1);
  }, 60_000);

  it('over a swept review worktree, the proof refuses a live process naming a review session and session locks still held, and frees the gone host\'s own locks', async () => {
    const f = await interruptedClaudeRound('owner-cessation-session');
    await f.port.release({ worktreeId: f.old.id }); // the live case's lane was swept
    const restarted = restartedRegistry(f);
    const sessionDir = new SessionStore(f.config.dataDir).sessionDirFor('perkins', f.lane.path);
    mkdirSync(sessionDir, { recursive: true });
    const sessionFileFor = (id: string): string => {
      const file = join(sessionDir, `2026-10-21T01-59-57-569Z_${id}.jsonl`);
      writeFileSync(file, '');
      return file;
    };
    // Two registered sessions, and one spawned just before a crash that was
    // never registered: found by its file.
    const lead = randomUUID();
    const edge = randomUUID();
    const sessions = [lead, edge].map((agentId) => ({ agentId, sessionFile: sessionFileFor(agentId) }));
    const unregistered = randomUUID();
    const sessionFile = sessionFileFor(unregistered);
    const input = { marker: f.marker, worktreePath: f.lane.path, sessions };
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
      ok: true, evidence: { sessionIds: [lead, edge, unregistered].sort(), sessionFiles: 3, host: 'dead' },
    });
    expect(hostExitRecords(f)).toHaveLength(1);
  }, 120_000);

  it('the proof\'s host check tells the live host from a reused pid or this service restarted under it, by start identity', async () => {
    const f = await interruptedClaudeRound('owner-cessation-host-states');
    const clean = { processTable: async () => CLEAN_TABLE };
    const at = (marker: ReviewOwnerMarker) => ({ marker, worktreePath: f.lane.path, sessions: [] });
    const host = (identity: string | null) => ({ ...clean, ownerProcessProbe: () => 'alive' as const, processIdentity: async () => identity });
    const pid = String(DEAD_PID);
    await expect(restartedRegistry(f, { ...clean, ownerProcessProbe: () => 'unknown' }).proveReviewHostExit(at(f.marker)))
      .resolves.toEqual({ ok: false, problem: `its host pid ${pid} cannot be probed` });
    await expect(restartedRegistry(f, host(OTHER_HOST)).proveReviewHostExit(at(f.marker)))
      .resolves.toEqual({ ok: false, problem: `its host pid ${pid} is still running; the replacement starts once it exits` });
    await expect(restartedRegistry(f, host(null)).proveReviewHostExit(at(f.marker)))
      .resolves.toEqual({ ok: false, problem: `its host pid ${pid} is alive and its start identity cannot be read` });
    const legacy = otherRound(f, DEAD_PID);
    await expect(restartedRegistry(f, host('ps:anything')).proveReviewHostExit(at(legacy))).resolves.toEqual({ ok: false,
      problem: `its host pid ${pid} is still running (the marker records no host identity to tell a reused pid apart); the replacement starts once it exits` });
    expect(hostExitRecords(f)).toEqual([]);
    // Another start identity under the host's pid: a reused pid, with both
    // identities on record.
    await expect(restartedRegistry(f, host('ps:Fri Oct 23 00:00:00 2026')).proveReviewHostExit(at(f.marker))).resolves.toMatchObject({
      ok: true, evidence: { host: 'pid-reused', markerIdentity: OTHER_HOST, observedIdentity: 'ps:Fri Oct 23 00:00:00 2026' },
    });
    // A marker from before identities existed, under a dead pid, is proven
    // gone and recorded like any other.
    const legacyDead = otherRound(f, DEAD_PID);
    const legacyRegistry = restartedRegistry(f, clean);
    await expect(legacyRegistry.proveReviewHostExit(at(legacyDead))).resolves.toMatchObject({ ok: true, evidence: { host: 'dead' } });
    expect(legacyRegistry.reviewOwnerCeased('', legacyDead)).toBe(true);
    // This pid: its own identity is this process, whose adapter evidence
    // alone decides. Every marker this process writes carries that identity,
    // so one with another identity, or none, was left by an earlier process.
    await expect(restartedRegistry(f, clean).proveReviewHostExit(at(otherRound(f, process.pid, thisProcessIdentity()!))))
      .resolves.toEqual({ ok: false, problem: 'its host is this process, so only its own adapter evidence proves cessation' });
    const earlier = otherRound(f, process.pid, OTHER_HOST);
    const restarted = restartedRegistry(f, clean);
    await expect(restarted.proveReviewHostExit(at(earlier))).resolves.toMatchObject({
      ok: true, evidence: { host: 'restarted', markerIdentity: OTHER_HOST, observedIdentity: thisProcessIdentity() },
    });
    expect(restarted.reviewOwnerCeased('', earlier)).toBe(true);
    await expect(restartedRegistry(f, clean).proveReviewHostExit(at(otherRound(f, process.pid)))).resolves.toMatchObject({
      ok: true, evidence: { host: 'restarted', markerIdentity: null },
    });
    // The record binds the marker's own host identity, never one a caller claims.
    expect(() => f.ledger.recordReviewOwnerCessation({ source: 'host-exit', roundId: earlier.roundId, generation: earlier.generation,
      pid: process.pid, hostIdentity: 'ps:forged', evidence: {} })).toThrow(/binds no unique round owner marker/u);
    expect(hostExitRecords(f).map((event) => (event.payload as { evidence: { host: string } }).evidence.host).sort())
      .toEqual(['dead', 'pid-reused', 'restarted', 'restarted']);
  }, 120_000);

  it('the Linux start ticks are read past a process name holding spaces and parentheses', () => {
    const fields = (ticks: string) => `S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 ${ticks} 20 21`;
    expect(linuxStartTicks(`4242 (node) ${fields('987654')}`)).toBe('987654');
    expect(linuxStartTicks(`4242 (tmux: server) ) x) ${fields('31337')}`)).toBe('31337');
    expect(linuxStartTicks(`4242 (node) ${fields('not-a-number')}`)).toBeNull();
    expect(linuxStartTicks('garbage with no name')).toBeNull();
  });

  it('a same-pid marker is this process\'s own only under its own identity, or under any when this process has none', () => {
    const marker = (hostIdentity?: string): ReviewOwnerMarker => ({ roundId: 'r', runtimeId: 'claude-code', pid: process.pid,
      generation: randomUUID(), ...(hostIdentity !== undefined ? { hostIdentity } : {}) });
    expect(hostedByThisProcess(marker('ps:own'), 'ps:own')).toBe(true);
    expect(hostedByThisProcess(marker('ps:earlier'), 'ps:own')).toBe(false);
    expect(hostedByThisProcess(marker(), 'ps:own')).toBe(false);
    // With no identity of its own, this process can tell no marker apart.
    expect(hostedByThisProcess(marker(), null)).toBe(true);
    expect(hostedByThisProcess(marker('ps:earlier'), null)).toBe(true);
    expect(hostedByThisProcess({ ...marker('ps:own'), pid: DEAD_PID }, 'ps:own')).toBe(false);
  });

  it('a pi owner whose pid another process now holds is proven gone by the same proof', async () => {
    const f = await interruptedClaudeRound('owner-cessation-pi-reused');
    const round = f.ledger.addRound({ jobId: f.jobId, targetRef: f.target, lenses: ['blind'] });
    const marker = { roundId: round.id, runtimeId: 'pi', pid: process.ppid, generation: randomUUID(), hostIdentity: OTHER_HOST };
    f.ledger.appendCustomEvent({ kind: 'round.review-owner', jobId: f.jobId, roundId: round.id, payload: { ...marker, targetSha: f.target } });
    const registry = restartedRegistry(f, { processTable: async () => CLEAN_TABLE });
    // pi's own rule (host pid death) cannot answer a live pid.
    expect(registry.reviewOwnerCeased('lead', marker)).toBe(false);
    await expect(registry.proveReviewHostExit({ marker, worktreePath: f.lane.path, sessions: [] }))
      .resolves.toMatchObject({ ok: true, evidence: { host: 'pid-reused' } });
    expect(registry.reviewOwnerCeased('lead', marker)).toBe(true);
  }, 60_000);

  it('the live case\'s shape: a marker from before identities, its lane swept, three disposed sessions, admitted through the review endpoint', async () => {
    const f = await interruptedClaudeRound('owner-cessation-live-shape', { pid: DEAD_PID });
    const sessionDir = new SessionStore(f.config.dataDir).sessionDirFor('perkins', f.lane.path);
    mkdirSync(sessionDir, { recursive: true });
    for (const label of ['lead', 'edge', 'acceptance']) {
      const id = randomUUID();
      const sessionFile = join(sessionDir, `2026-10-21T01-59-57-569Z_${id}.jsonl`);
      writeFileSync(sessionFile, '');
      f.ledger.registerAgent({ id, role: 'perkins', label, jobId: f.jobId, roundId: f.old.id, sessionFile });
      f.ledger.setAgentState(id, 'disposed');
    }
    f.ledger.setRoundStatus(f.old.id, 'aborted');
    await f.port.release({ worktreeId: f.old.id });
    const post = await serveReview(f, restartedRegistry(f));
    const admitted = await post({ job_id: f.jobId, target_ref: f.target });
    expect(admitted.status).toBe(202);
    expect(hostExitRecords(f).map((event) => event.payload)).toMatchObject([
      { pid: DEAD_PID, evidence: { host: 'dead', sessionFiles: 3, worktreePath: f.lane.path } },
    ]);
  }, 60_000);

  it('a process start identity is clock-free, per process, and absent for a dead pid', async () => {
    const own = thisProcessIdentity();
    expect(own).not.toBeNull();
    expect(await processIdentity(process.pid)).toBe(own);
    // macOS start times are whole seconds: start the child in a later one.
    const wait = 1_100 - process.uptime() * 1000;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const child = liveProcess([], temp('owner-cessation-identity-'));
    const childIdentity = await processIdentity(child.pid!);
    expect(childIdentity).not.toBeNull();
    expect(childIdentity).not.toBe(own);
    expect(await processIdentity(DEAD_PID)).toBeNull();
  });

  it('a lock this process holds is never freed as the gone host\'s, even under the same pid', async () => {
    const f = await interruptedClaudeRound('owner-cessation-held-here', { pid: process.pid, hostIdentity: OTHER_HOST });
    const store = new SessionStore(f.config.dataDir);
    const registry = restartedRegistry(f, { store, processTable: async () => CLEAN_TABLE });
    const sessionDir = store.sessionDirFor('perkins', f.lane.path);
    mkdirSync(sessionDir, { recursive: true });
    const sessionFile = join(sessionDir, `2026-10-21T01-59-57-569Z_${randomUUID()}.jsonl`);
    writeFileSync(sessionFile, '');
    store.acquireLock(sessionFile);
    const input = { marker: f.marker, worktreePath: f.lane.path, sessions: [] };
    await expect(registry.proveReviewHostExit(input)).resolves.toEqual({
      ok: false, problem: `session lock ${sessionFile}.lock is held by this process`,
    });
    store.releaseLock(sessionFile);
    await expect(registry.proveReviewHostExit(input)).resolves.toMatchObject({ ok: true, evidence: { host: 'restarted' } });
  }, 60_000);

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
  }, 60_000);

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

  it('a process whose working directory is the swept tree, as Linux names it, is still rooted in it, resolved through the tree\'s parent', async () => {
    const parent = temp('owner-cessation-tree-');
    const tree = join(parent, 'review-round-1');
    const child = liveProcess(['owner-cessation-token'], temp('owner-cessation-cwd-'));
    const table = async (cwd: string) => processTableAsync({
      onCwdError: (error) => { throw error; }, listCwds: async () => new Map([[child.pid!, cwd]]),
    });
    const rooted = [expect.objectContaining({ pid: child.pid, evidence: 'cwd' })];
    expect((await table(`${tree} (deleted)`)).rootedIn(tree)).toEqual(rooted);
    expect((await table(`${tree}/src (deleted)`)).rootedIn(tree)).toEqual(rooted);
    // The OS reports the resolved path: a tree registered through a symlink
    // (macOS: /var → /private/var) is still matched once swept, through its
    // nearest surviving ancestor.
    const linked = join(temp('owner-cessation-link-'), 'data');
    symlinkSync(parent, linked);
    expect((await table(`${join(realpathSync(parent), 'review-round-1')} (deleted)`)).rootedIn(join(linked, 'review-round-1'))).toEqual(rooted);
    // The tree's parent swept too: the next surviving ancestor resolves it.
    expect((await table(`${join(realpathSync(parent), 'gone-parent', 'review-round-2')} (deleted)`))
      .rootedIn(join(linked, 'gone-parent', 'review-round-2'))).toEqual(rooted);
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
      pid: process.pid, hostIdentity: OTHER_HOST, evidence: {} })).toThrow(/binds no unique round owner marker/u);
    // A second, conflicting marker makes the owner ambiguous: nothing binds.
    f.ledger.appendCustomEvent({ kind: 'round.review-owner', jobId: f.jobId, roundId: f.old.id,
      payload: { ...f.marker, generation: randomUUID(), targetSha: f.target } });
    expect(() => f.ledger.recordReviewOwnerCessation({ source: 'adapter', agentId: 'lead', generation: f.marker.generation }))
      .toThrow(/binds no unique round owner marker/u);
    expect(f.ledger.reviewOwnerCessationRecorded('lead', f.marker)).toBe(false);
  });
});

describe('a graceful shutdown\'s cut is the restart\'s clean abort at every stage (#464)', () => {
  const digestOf = (f: Job) => computeSilasDigest({ ledger: f.ledger, blockersForRound: async () => ({ blockers: [], note: null }),
    config: DEFAULT_SILAS_CONFIG, trigger: 'sweep' });

  /** The aborted round records service_restart, and Silas offers its
   * clean-abort re-arm on the unchanged delivered head. */
  async function expectCleanAbortRearm(f: Job, roundId: string): Promise<void> {
    expect(f.ledger.getRound(roundId)?.status).toBe('aborted');
    expect(f.ledger.latestRoundEvent(roundId, 'round.perkins-incomplete')?.payload).toMatchObject({ reason: 'service_restart' });
    f.ledger.setJobPr(f.jobId, 'https://git.example.invalid/acme/fixture/pull/464');
    expect((await digestOf(f)).prWithoutReview).toMatchObject([
      { jobId: f.jobId, cleanAbort: { roundId, ruleId: 'clean-abort-service-restart' } },
    ]);
  }

  function wave(f: Job, options: Partial<ConstructorParameters<typeof WaveRunner>[0]>): WaveRunner {
    const runner = new WaveRunner({ ledger: f.ledger, worktrees: f.port, spawner: hangingSpawner(),
      reviewArtifactRoot: temp('owner-cessation-cut-art-'), ...options });
    closers.push(async () => { await runner.shutdown(); });
    return runner;
  }

  it('during setup', async () => {
    const f = await reviewJob('owner-cessation-cut-setup');
    let release!: () => void;
    f.port.gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { f.port.reached = resolve; });
    const runner = wave(f, {});
    const beginning = runner.beginRound({ jobId: f.jobId }).catch((error: unknown) => error);
    await reached;
    const shutdown = runner.shutdown();
    release();
    await shutdown;
    expect(await beginning).toMatchObject({ message: expect.stringMatching(/shut/u) });
    const roundId = f.ledger.listRounds(f.jobId)[0]!.id;
    const recorded = f.ledger.latestRoundEvent(roundId, 'round.perkins-incomplete')?.payload as { reportFile: string; artifactDirectory: string };
    expect(JSON.parse(readFileSync(join(recorded.artifactDirectory, 'restart-recovery.json'), 'utf8'))).toMatchObject({ reason: 'service_restart' });
    expect(readFileSync(recorded.reportFile, 'utf8')).toContain('review setup interrupted by service shutdown');
    await expectCleanAbortRearm(f, roundId);
  }, 120_000);

  it('during setup under a recorded supersession: withdrawn, superseded, never re-armed', async () => {
    const f = await reviewJob('owner-cessation-cut-setup-superseded');
    let release!: () => void;
    f.port.gate = new Promise<void>((resolve) => { release = resolve; });
    const reached = new Promise<void>((resolve) => { f.port.reached = resolve; });
    const runner = wave(f, {});
    const beginning = runner.beginRound({ jobId: f.jobId }).catch((error: unknown) => error);
    await reached;
    const roundId = f.ledger.listRounds(f.jobId)[0]!.id;
    f.ledger.appendCustomEvent({ kind: 'round.superseded', jobId: f.jobId, roundId,
      payload: { reason: 'material amendment #1 accepted', by: 'gru', status: 'pending', settled_specialists: [] } });
    const shutdown = runner.shutdown();
    release();
    await shutdown;
    await beginning;
    const recorded = f.ledger.latestRoundEvent(roundId, 'round.perkins-incomplete')?.payload as { reason: string; reportFile: string };
    expect(recorded.reason).toBe('superseded');
    expect(readFileSync(recorded.reportFile, 'utf8')).toContain('review setup withdrawn');
    f.ledger.setJobPr(f.jobId, 'https://git.example.invalid/acme/fixture/pull/464');
    expect((await digestOf(f)).prWithoutReview.filter((row) => row.cleanAbort !== undefined)).toEqual([]);
  }, 120_000);

  it('while waiting for resident slots', async () => {
    const f = await reviewJob('owner-cessation-cut-residency');
    let waiting!: () => void;
    const queued = new Promise<void>((resolve) => { waiting = resolve; });
    const runner = wave(f, {
      reserveReviewRound: (signal) => new Promise<ResidentReviewRound>((_resolve, reject) => {
        waiting();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    });
    const begun = await runner.beginRound({ jobId: f.jobId });
    begun.run.catch(() => {});
    await queued;
    await runner.shutdown();
    await begun.run.catch(() => {});
    expect(f.ledger.latestRoundEvent(begun.round.id, 'round.residency-cancelled')).not.toBeNull();
    const recorded = f.ledger.latestRoundEvent(begun.round.id, 'round.perkins-incomplete')?.payload as { reportFile: string; artifactDirectory: string };
    expect(existsSync(join(recorded.artifactDirectory, 'restart-recovery.json'))).toBe(true);
    expect(readFileSync(recorded.reportFile, 'utf8')).toContain('waiting for resident slots');
    await expectCleanAbortRearm(f, begun.round.id);
  }, 120_000);

  it('mid-review, under a claude-code owner marker carrying this process\'s start identity', async () => {
    const f = await reviewJob('owner-cessation-cut-review');
    let leadStarted!: () => void;
    const started = new Promise<void>((resolve) => { leadStarted = resolve; });
    const runner = wave(f, { spawner: hangingSpawner(() => leadStarted()),
      reviewRuntimeIdentity: () => ({ id: 'claude-code', version: 'test-runtime' }) });
    const running = runner.runRound({ jobId: f.jobId });
    await started;
    await runner.shutdown();
    const outcome = await running as WaveOutcome;
    expect(f.ledger.uniqueRoundReviewOwnerMarker(outcome.round.id)?.payload).toMatchObject({
      runtimeId: 'claude-code', pid: process.pid, hostIdentity: thisProcessIdentity(),
    });
    await expectCleanAbortRearm(f, outcome.round.id);
  }, 120_000);

  it('a recorded supersession wins over the shutdown that cut the round: superseded, never re-armed', async () => {
    const f = await reviewJob('owner-cessation-cut-superseded');
    let leadStarted!: () => void;
    const started = new Promise<void>((resolve) => { leadStarted = resolve; });
    const runner = wave(f, { spawner: hangingSpawner(() => leadStarted()) });
    const running = runner.runRound({ jobId: f.jobId });
    await started;
    const roundId = f.ledger.listRounds(f.jobId)[0]!.id;
    // A restart-interrupted supersession: recorded, its abort not yet sent.
    f.ledger.appendCustomEvent({ kind: 'round.superseded', jobId: f.jobId, roundId,
      payload: { reason: 'material amendment #1 accepted', by: 'gru', status: 'live', settled_specialists: [] } });
    await runner.shutdown();
    await running;
    expect(f.ledger.latestRoundEvent(roundId, 'round.perkins-incomplete')?.payload).toMatchObject({ reason: 'superseded' });
    f.ledger.setJobPr(f.jobId, 'https://git.example.invalid/acme/fixture/pull/464');
    expect((await digestOf(f)).prWithoutReview.filter((row) => row.cleanAbort !== undefined)).toEqual([]);
  }, 120_000);

  it('after the workflow returned, before finalization', async () => {
    const f = await reviewJob('owner-cessation-cut-finalize');
    const fake = fakeWholeSpawner(temp('owner-cessation-finalize-sessions-'), { childAnswer: () => '[]', specialists: [] });
    const service: { wave?: WaveRunner; stopping?: Promise<void> } = {};
    // The lead's disposal is the workflow's last act: the shutdown lands
    // after the workflow returned, before the round is finalized.
    const spawner: AgentSpawner = async (role, options) => {
      const handle = await fake.spawner(role, options);
      if (options?.reviewLead === undefined) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === 'dispose') return async () => { service.stopping = service.wave?.shutdown(); await target.dispose(); };
          const value: unknown = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    };
    service.wave = wave(f, { spawner });
    const outcome = await service.wave.runRound({ jobId: f.jobId }) as WaveOutcome;
    await service.stopping;
    expect(outcome.canonicalVerdict).toBe('INCOMPLETE');
    expect(f.ledger.latestRoundEvent(outcome.round.id, 'round.perkins-incomplete')?.payload).toMatchObject({
      error: expect.stringContaining('aborted before finalization'),
    });
    await expectCleanAbortRearm(f, outcome.round.id);
  }, 120_000);

  it('during report delivery: held from re-arm until the next start proves the in-flight post absent', async () => {
    const f = await reviewJob('owner-cessation-cut-delivery');
    const origin = join(temp('owner-cessation-origin-'), 'origin.git');
    execFileSync('git', ['init', '--bare', '--quiet', origin], { stdio: 'ignore' });
    f.repo.git(['remote', 'add', 'origin', origin]);
    f.repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/review']);
    f.ledger.setJobPr(f.jobId, 'https://git.example.invalid/acme/fixture/pull/464');
    const service: { wave?: WaveRunner; stopping?: Promise<void> } = {};
    const artifacts = temp('owner-cessation-delivery-art-');
    service.wave = wave(f, {
      reviewArtifactRoot: artifacts,
      spawner: fakeWholeSpawner(temp('owner-cessation-delivery-sessions-'), { childAnswer: () => '[]', specialists: [] }).spawner,
      prHeadProbe: async () => ({ headRefName: 'feature/review', headSha: f.target }),
      // The shutdown lands inside the provider write, which then fails.
      poster: { post: async (call: { readonly onPreparedIdentity?: (actor: string) => void }) => {
        call.onPreparedIdentity?.('gru-bot');
        service.stopping = service.wave?.shutdown();
        throw new Error('connection reset by shutdown');
      } },
    });
    const outcome = await service.wave.runRound({ jobId: f.jobId }) as WaveOutcome;
    await service.stopping;
    expect(outcome.round.status).toBe('aborted');
    expect(f.ledger.latestRoundEvent(outcome.round.id, 'round.perkins-incomplete')?.payload).toMatchObject({
      reason: 'service_restart', deliveryFailure: 'report_not_posted',
    });
    // The post may have landed: no re-arm while it is unreconciled.
    expect(pendingPublicationAttempt(f.ledger, outcome.round.id)).not.toBeNull();
    expect((await digestOf(f)).prWithoutReview).toEqual([]);
    // The next start asks the provider (nothing POSTs); proven absent, the
    // clean-abort re-arm opens.
    const restarted = wave(f, { reviewArtifactRoot: artifacts,
      poster: { post: async () => { throw new Error('a restart never posts'); },
        reconcile: async (call: { readonly onLookupIdentity?: (actor: string) => void }) => { call.onLookupIdentity?.('gru-bot'); return null; } } });
    await restarted.recoverInterruptedRounds();
    expect(pendingPublicationAttempt(f.ledger, outcome.round.id)).toBeNull();
    expect((await digestOf(f)).prWithoutReview).toMatchObject([
      { jobId: f.jobId, cleanAbort: { roundId: outcome.round.id, ruleId: 'clean-abort-service-restart' } },
    ]);
  }, 120_000);

  it('during report delivery, when the next start finds the post did land: held, retained uncredited, never asked again', async () => {
    const f = await reviewJob('owner-cessation-cut-delivered');
    const origin = join(temp('owner-cessation-origin-'), 'origin.git');
    execFileSync('git', ['init', '--bare', '--quiet', origin], { stdio: 'ignore' });
    f.repo.git(['remote', 'add', 'origin', origin]);
    f.repo.git(['push', '--quiet', 'origin', 'refs/heads/feature/review']);
    f.ledger.setJobPr(f.jobId, 'https://git.example.invalid/acme/fixture/pull/464');
    const service: { wave?: WaveRunner; stopping?: Promise<void> } = {};
    const artifacts = temp('owner-cessation-delivered-art-');
    service.wave = wave(f, {
      reviewArtifactRoot: artifacts,
      spawner: fakeWholeSpawner(temp('owner-cessation-delivered-sessions-'), { childAnswer: () => '[]', specialists: [] }).spawner,
      prHeadProbe: async () => ({ headRefName: 'feature/review', headSha: f.target }),
      poster: { post: async (call: { readonly onPreparedIdentity?: (actor: string) => void }) => {
        call.onPreparedIdentity?.('gru-bot');
        service.stopping = service.wave?.shutdown();
        throw new Error('connection reset by shutdown');
      } },
    });
    const outcome = await service.wave.runRound({ jobId: f.jobId }) as WaveOutcome;
    await service.stopping;
    const ENACTED: Record<string, string> = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' };
    let lookups = 0;
    const found = {
      post: async () => { throw new Error('a restart never posts'); },
      reconcile: async (call: { readonly targetSha: string; readonly body: string; readonly reviewEvent?: string;
        readonly onLookupIdentity?: (actor: string) => void }) => {
        lookups += 1;
        call.onLookupIdentity?.('gru-bot');
        return { reviewId: 'landed-1', actor: 'gru-bot', event: ENACTED[call.reviewEvent ?? 'COMMENT'] ?? 'COMMENTED', commitId: call.targetSha,
          headSha: call.targetSha, baseSha: 'b'.repeat(40), bodySha256: createHash('sha256').update(call.body, 'utf8').digest('hex') };
      },
    };
    await wave(f, { reviewArtifactRoot: artifacts, poster: found }).recoverInterruptedRounds();
    expect(lookups).toBe(1);
    expect(pendingPublicationAttempt(f.ledger, outcome.round.id)?.kind).toBe('uncredited-receipt');
    expect((await digestOf(f)).prWithoutReview).toEqual([]);
    // A later start does not ask again (nor re-escalate) for a post proven present.
    await wave(f, { reviewArtifactRoot: artifacts, poster: found }).recoverInterruptedRounds();
    expect(lookups).toBe(1);
  }, 120_000);
});
