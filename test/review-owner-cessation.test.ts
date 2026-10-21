import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configPathFor, loadConfig } from '../src/config.js';
import { WaveRunner } from '../src/dispatch/perkins.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import type { AgentSpawner, DispatchService } from '../src/dispatch/service.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, REVIEW_OWNER_CEASED_KIND } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { RuntimeRegistry, ledgerReviewOwnerCessation, type ReviewOwnerMarker } from '../src/runtime/registry.js';
import type { AgentHandle } from '../src/runtime/types.js';
import { SessionStore } from '../src/sessions/store.js';
import type { ProcessTable } from '../src/worktrees/manager.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { GitReviewPort } from './helpers/git-review-port.js';

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

/** A job whose last round was interrupted with a claude-code owner marker
 * from another process: what the restarted service sees. */
async function interruptedClaudeRound(name: string) {
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
  const old = ledger.addRound({ jobId, targetRef: target, lenses: ['blind'] });
  const lane = await port.createReviewWorktree({ repoPath: repo.path, roundId: old.id, ref: target, jobId });
  const marker: ReviewOwnerMarker = { roundId: old.id, runtimeId: 'claude-code', pid: DEAD_PID, generation: randomUUID() };
  ledger.appendCustomEvent({ kind: 'round.review-owner', jobId, roundId: old.id, payload: { ...marker, targetSha: target } });
  const home = temp(`${name}-home-`);
  writeFileSync(configPathFor(home), `workspace_root = "${temp(`${name}-ws-`)}"\n[runtimes]\ndefault = "claude-code"\n`);
  const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
  return { ledger, port, jobId, target, old, lane, marker, config, home };
}

type Fixture = Awaited<ReturnType<typeof interruptedClaudeRound>>;

/** A fresh registry for the restarted service: no in-memory cessation. */
function restartedRegistry(f: Fixture, extra: Partial<ConstructorParameters<typeof RuntimeRegistry>[0]> = {}): RuntimeRegistry {
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

/** The restarted service's review endpoint over a real wave. Its spawner
 * answers the replacement lead with a refusal, so only admission counts. */
async function serveReview(f: Fixture, registry: RuntimeRegistry): Promise<(body: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> }>> {
  const sessions = temp('owner-cessation-sessions-');
  const spawner: AgentSpawner = async (role) => {
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
  const wave = new WaveRunner({
    ledger: f.ledger, worktrees: f.port, spawner, reviewArtifactRoot: temp('owner-cessation-artifacts-'),
    reconcileReviewAgent: async (agentId, marker) => registry.reviewOwnerCeased(agentId, marker),
    proveReviewHostExit: (input) => registry.proveReviewHostExit(input),
  });
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
  closers.push(async () => {
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await wave.shutdown();
  });
  const port = (http.address() as AddressInfo).port;
  return async (body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/dispatch/review`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
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

function hostExitRecords(f: Fixture) {
  return f.ledger.listEvents({ limit: 1000 }).filter((event) => event.kind === REVIEW_OWNER_CEASED_KIND &&
    (event.payload as { source?: unknown }).source === 'host-exit');
}

describe('review-owner cessation survives a restart (#464)', () => {
  it('a restarted registry accepts a claude-code owner from another pid whose host saw it cease, and the review endpoint admits the replacement #contract:review-owner-durable-cessation:claude-code', async () => {
    const f = await interruptedClaudeRound('owner-cessation-durable');
    // The OLD host: its real Claude review lead is mid-turn when the
    // service shuts down; disposal observes the child's close (ceased).
    const owner = restartedRegistry(f);
    const lead = await owner.spawn('perkins', {
      cwd: f.lane.path, reviewOwnerGeneration: f.marker.generation,
      reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] },
    });
    f.ledger.registerAgent({ id: lead.id, role: 'perkins', label: 'lead', jobId: f.jobId, roundId: f.old.id, sessionFile: lead.sessionFile ?? null });
    const turn = lead.prompt(`hold:${join(f.home, 'never-released')}`).catch(() => {});
    await expect.poll(() => lead.health().state, { timeout: 10_000 }).toBe('streaming');
    await owner.dispose();
    await turn;
    f.ledger.setAgentState(lead.id, 'disposed');
    f.ledger.setRoundStatus(f.old.id, 'aborted');
    expect(f.ledger.latestRoundEvent(f.old.id, REVIEW_OWNER_CEASED_KIND)?.payload).toMatchObject({
      source: 'adapter', roundId: f.old.id, agentId: lead.id, generation: f.marker.generation, observerPid: process.pid,
    });

    // The RESTARTED service: empty in-memory state, the same ledger.
    const restarted = restartedRegistry(f);
    expect(restarted.reviewOwnerCeased(lead.id, f.marker)).toBe(true);
    // The record binds this marker and session only.
    expect(restarted.reviewOwnerCeased(lead.id, { ...f.marker, generation: randomUUID() })).toBe(false);
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
    f.ledger.setRoundStatus(f.old.id, 'aborted');
    // The host pid is dead, but the rest of the evidence cannot be read.
    const blind: ProcessTable = { rootedIn: () => [], naming: () => [], cwdsListed: false };
    const restarted = restartedRegistry(f, { ownerProcessProbe: () => 'dead', processTable: async () => blind });
    expect(restarted.reviewOwnerCeased(agentId, f.marker)).toBe(false);
    const post = await serveReview(f, restarted);
    const refused = await post({ job_id: f.jobId, target_ref: f.target });
    expect(refused.status).toBe(400);
    expect(String(refused.json['detail'] ?? refused.json['error'])).toMatch(
      new RegExp(`review owner ${agentId} from round ${f.old.id} may still run; reconcile runtime cessation .*dead-host proof refused: the working directories of running processes cannot be listed`, 'u'));
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
    expect(String(refused.json['detail'] ?? refused.json['error'])).toMatch(
      new RegExp(`dead-host proof refused: pid ${String(straggler.pid)} \\(cwd\\) still rooted in review worktree`, 'u'));
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
      evidence: { worktreePath: f.lane.path },
    });
    // Recorded once: the record answers every later reconciliation.
    expect(restarted.reviewOwnerCeased('', f.marker)).toBe(true);
  }, 120_000);

  it('the dead-host proof refuses a live process naming a review session and a session lock held by a live pid', async () => {
    const f = await interruptedClaudeRound('owner-cessation-session');
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
      ok: false, problem: `pid ${String(cli.pid)} (argv) still names review session ${unregistered}`,
    });
    await stop(cli);
    writeFileSync(`${sessionFile}.lock`, JSON.stringify({ host: hostname(), pid: process.pid, bootId: 'live', acquiredAt: '', heartbeatAt: '' }));
    await expect(restarted.proveReviewHostExit(input)).resolves.toMatchObject({
      ok: false, problem: `session lock ${sessionFile}.lock is held by alive pid ${String(process.pid)}`,
    });
    // A lock its dead host left behind is free.
    writeFileSync(`${sessionFile}.lock`, JSON.stringify({ host: hostname(), pid: DEAD_PID, bootId: 'gone', acquiredAt: '', heartbeatAt: '' }));
    await expect(restarted.proveReviewHostExit(input)).resolves.toMatchObject({
      ok: true, evidence: { sessionIds: [unregistered], sessionFiles: 1 },
    });
    expect(hostExitRecords(f)).toHaveLength(1);
  }, 120_000);

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
