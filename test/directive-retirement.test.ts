import { bindOriginalRebriefSdkOwner } from './helpers/directive-native-fixture.js';
import type { DirectiveRegistry } from '../src/dispatch/fix-directive.js';
import { DirectiveProgressService } from '../src/dispatch/directive-progress.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, type DirectiveRequestRecord, type JobRecord } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { loadConfig, DEFAULT_SILAS_CONFIG, DEFAULT_PROVIDER_RECOVERY_CONFIG, type Role } from '../src/config.js';
import { createDispatchServer, type DispatchServer } from '../src/dispatch/server.js';
import { DispatchService } from '../src/dispatch/service.js';
import { WaveRunner } from '../src/dispatch/perkins.js';
import { fakeWholeSpawner } from './helpers/perkins-whole-double.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { attachBareOrigin, makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { originHeadProbe } from './helpers/pr-head-probe.js';
import { withNativeDirectiveFixture, markHistoricalDirectiveFixture, admitNativeDirectiveFixture } from './helpers/directive-native-fixture.js';
import { BoardEngine } from '../src/board/engine.js';
import { VerificationScheduler } from '../src/verify/scheduler.js';
import { computeSilasDigest } from '../src/dispatch/silas-driver.js';
import { reconcilePendingDirectives, reconcilePendingRebriefs, settleDirectivesFromEvidence } from '../src/dispatch/rebrief-recovery.js';
import { findBusyLanes, laneIsBusy } from '../src/dispatch/branch-idle.js';
import { resolveGitCommit } from '../src/dispatch/perkins-review/artifacts.js';
import type { WorktreeLane } from '../src/dispatch/worktree-port.js';
import { PacingGate } from '../src/runtime/pacing.js';
import { directiveRetirementFingerprint } from '../src/ledger/directives.js';
import { claimProviderRecoveryContinuation } from '../src/provider-recovery/resume.js';
import { establishProviderWait, ProviderRecoverySensor } from '../src/provider-recovery/sensor.js';
import type { AgentCapabilities, AgentHandle, AgentState, SpawnOptions } from '../src/runtime/types.js';

/**
 * Guarded interrupted-directive recovery (owner approval j-1348).
 *
 * Route + ledger acceptance matrix through the REAL dispatch HTTP surface,
 * the REAL LedgerApi on a temp database, and real registry lanes (git
 * fixture repo). No providers, no live spawns of real runtimes, no
 * production paths. The suite discriminates both admission classes, every
 * refusal predicate (positive + negative), replay/conflict, late evidence,
 * rollback, consumer fences and persistence compatibility.
 */

const TOKEN = 'test-token-directive-retirement';
const FAKE_CAPABILITIES: AgentCapabilities = {
  streaming: true,
  steer: 'native',
  resume: 'file',
  images: false,
  thinking: false,
  thinkingLevelControl: false,
  followUp: false,
};

const cleanupDirs: string[] = [];
const cleanupRepos: FixtureRepo[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close();
  while (cleanupRepos.length > 0) cleanupRepos.pop()!.cleanup();
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface Harness {
  readonly wave: WaveRunner;
  readonly registry: DirectiveRegistry;
  readonly dir: string;
  readonly port: number;
  readonly ledger: LedgerApi;
  readonly db: LedgerDb;
  readonly worktrees: InMemoryWorktreePort;
  readonly notifications: NotificationCenter;
  readonly spawns: { role: Role; options: SpawnOptions }[];
  readonly server: DispatchServer;
  close(): Promise<void>;
}

async function boot(opts: { completeReview?: boolean; wrapLedger?: (ledger: LedgerApi) => LedgerApi; workerGate?: PacingGate;
  pendingProducerBlockers?: (jobId: string) => readonly string[] } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-retirement-'));
  cleanupDirs.push(dir);
  writeFileSync(join(dir, 'config.toml'), `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`, 'utf-8');
  mkdirSync(join(dir, 'wtroot'));
  mkdirSync(join(dir, 'wtpreserve'));
  const cfg = loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
  const db = new LedgerDb(dir);
  const bus = new EventBus({});
  const rawLedger = new LedgerApi(db.handle, { bus });
  const ledger = opts.wrapLedger === undefined ? rawLedger : opts.wrapLedger(rawLedger);
  const notifications = new NotificationCenter({ ledger, bus });
  const worktrees = new InMemoryWorktreePort(join(dir, 'wtroot'));
  if (opts.completeReview === true) {
    const recordLane = (lane: WorktreeLane): WorktreeLane => {
      ledger.registerWorktree({ id: lane.id, kind: lane.kind, repoPath: lane.repoPath, repoName: lane.repoName,
        path: lane.path, branch: lane.branch, sha: lane.sha, jobId: lane.jobId, roundId: lane.roundId });
      return lane;
    };
    const jobLane = worktrees.createJobWorktree.bind(worktrees); const reviewLane = worktrees.createReviewWorktree.bind(worktrees);
    vi.spyOn(worktrees, 'createJobWorktree').mockImplementation(async (input) => recordLane(await jobLane(input)));
    vi.spyOn(worktrees, 'createReviewWorktree').mockImplementation(async (input) => recordLane(await reviewLane(input)));
  }
  const spawns: { role: Role; options: SpawnOptions }[] = [];
  const reviewSessions = join(dir, 'review-sessions');
  mkdirSync(reviewSessions, { recursive: true });
  const hybrid = fakeWholeSpawner(reviewSessions, { childAnswer: () => '[]' });
  let promptSeq = 0;
  const liveHandles = new Map<string, AgentHandle>();
  const spawner = async (role: Role, options?: SpawnOptions): Promise<AgentHandle> => {
    spawns.push({ role, options: options ?? {} });
    if (role === 'perkins') {
      const handle = await hybrid.spawner(role, options);
      if (opts.completeReview !== true) return handle;
      return { ...handle,
        async prompt(...args: Parameters<AgentHandle['prompt']>) {
          await handle.prompt(...args);
          if (ledger.getAgent(handle.id) !== null) ledger.setAgentState(handle.id, 'idle');
        },
        async dispose() { await handle.dispose(); if (ledger.getAgent(handle.id) !== null) ledger.setAgentState(handle.id, 'disposed'); },
      };
    }
    const id = options?.agentId ?? `agent-${spawns.length}`;
    const sessionFile = options?.resumeFile ?? join(dir, 'native-sessions', `${id}.jsonl`);
    let state: AgentState = 'idle';
    const handle: AgentHandle = {
      role,
      id,
      sessionFile,
      capabilities: FAKE_CAPABILITIES,
      async prompt(_text: string) {
        if (role !== 'minion' || options?.cwd === undefined) return;
        promptSeq += 1;
        const file = join(options.cwd, `retire-deliverable-${id}-${promptSeq}.txt`);
        writeFileSync(file, 'settled\n');
        execFileSync('git', ['-C', options.cwd, 'add', file]);
        execFileSync(
          'git',
          ['-C', options.cwd, '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', `test: deliverable ${promptSeq}`],
          { stdio: 'ignore' },
        );
        state = 'idle';
      },
      async steer() {},
      async followUp() {},
      subscribe() {
        return () => {};
      },
      health() {
        return { state, lastActivity: null, sessionFile };
      },
      async dispose() { state = 'disposed'; },
    };
    const managed = role === 'minion' ? withNativeDirectiveFixture(handle, sessionFile, (next) => {
      state = next;
      if (ledger.getAgent(id) !== null) ledger.setAgentState(id, next);
    }, options?.cwd === undefined ? undefined : () => resolveGitCommit(options.cwd!, 'HEAD')) : handle;
    liveHandles.set(id, managed);
    return managed;
  };
  const dispatch = new DispatchService({ ledger, worktrees, spawner });
  const wave = new WaveRunner({
    ledger,
    worktrees,
    spawner,
    bus,
    poster: {
      async post(input: { readonly targetSha: string; readonly body: string; readonly baseSha: string }) {
        return {
          reviewId: '9001',
          actor: 'gru-bot',
          event: 'COMMENTED',
          commitId: input.targetSha,
          headSha: input.targetSha,
          baseSha: opts.completeReview === true ? input.baseSha : 'stub-base',
          bodySha256: opts.completeReview === true ? createHash('sha256').update(input.body, 'utf8').digest('hex') : 'stub-body',
        };
      },
    },
    reviewArtifactRoot: join(dir, 'reviews'),
    ...(opts.completeReview === true ? {
      reviewPreflight: async () => ({ ok: true as const, failures: [], reviewModel: { role: 'perkins' as const, modelRef: 'fixture-model-v1', settings: {}, authEnv: {}, routingSha256: 'fixture-safe-route' } }),
      reviewRuntimeIdentity: () => ({ id: 'pi', version: 'test-runtime-v1' }),
    } : {}),
    prHeadProbe: opts.completeReview === true ? async ({ repoPath, branchRef }) => ({ headRefName: branchRef, headSha: resolveGitCommit(repoPath, branchRef) }) : originHeadProbe(),
  });
  const registry: DirectiveRegistry = {
    getHandle: (id: string) => liveHandles.get(id) ?? null,
    spawn: (role: Role, spawnOptions?: SpawnOptions) => spawner(role, spawnOptions),
    disposeHandle: async (handle: AgentHandle) => { await handle.dispose(); liveHandles.delete(handle.id); },
  };
  const server = createDispatchServer({
    config: cfg,
    dispatch,
    wave,
    ledger,
    ...(opts.workerGate !== undefined ? { workerGate: opts.workerGate } : {}),
    pendingProducerBlockers: opts.pendingProducerBlockers ?? (() => []),
    silasOps: {
      registry,
      worktrees,
      notifications,
    },
  });
  const http: HttpServer = createServer((req, res) => {
    if (server.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolveListen) => http.listen(0, '127.0.0.1', resolveListen));
  const port = (http.address() as AddressInfo).port;
  const harness: Harness = {
    wave, registry,
    dir,
    port,
    ledger,
    db,
    worktrees,
    notifications,
    spawns,
    server,
    close: async () => {
      server.dispose();
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
      await wave.shutdown();
      db.close();
    },
  };
  harnesses.push(harness);
  return harness;
}

async function call(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function field<T>(json: unknown, key: string): T {
  if (typeof json !== 'object' || json === null) throw new Error(`no json for field ${key}`);
  return (json as Record<string, unknown>)[key] as T;
}

function seedJob(h: Harness, jobId: string, status = 'working'): JobRecord {
  const job = h.ledger.addJob({ id: jobId, repo: 'fixture-app', title: jobId, briefing: `briefing for ${jobId}` });
  if (status !== 'dispatched') h.ledger.setJobStatus(jobId, status as never);
  return job;
}

async function seedLane(h: Harness, repo: FixtureRepo, jobId: string): Promise<WorktreeLane> {
  return h.worktrees.createJobWorktree({ repoPath: repo.path, jobId });
}

function laneHead(lane: WorktreeLane): string {
  return resolveGitCommit(lane.path, 'HEAD');
}

function retireBody(
  row: DirectiveRequestRecord,
  head: string,
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  // A terminal row's caller originally saw a live state; default to the
  // still-live expectation so the ledger — never the body validator —
  // decides not-live refusals and consumed-replay identity.
  const expectedState = row.state === 'dispatching' || row.state === 'admitted' ? row.state : 'dispatching';
  return {
    expected_job_id: row.jobId,
    expected_state: expectedState,
    expected_payload_hash: row.payloadHash,
    expected_head: head,
    reason: 'writer ceased; no terminal receipt can exist',
    by: 'silas-ops',
    ...overrides,
  };
}

async function retire(
  h: Harness,
  requestId: string,
  head: string,
  overrides: Partial<Record<string, unknown>> = {},
  token: string | null = TOKEN,
): Promise<{ status: number; json: unknown }> {
  const row = h.ledger.getDirective(requestId);
  if (row === null) throw new Error(`no directive request ${requestId}`);
  const rawBody = overrides['body'];
  const body = typeof rawBody === 'object' && rawBody !== null ? rawBody : retireBody(row, head, overrides);
  return call(h.port, 'POST', `/api/silas/directives/${encodeURIComponent(requestId)}/retire`, body, token ?? undefined);
}

function eventKinds(h: Harness): string[] {
  return h.ledger.listEvents({ limit: 500 }).map((event) => event.kind);
}

function countEvents(h: Harness, kind: string): number {
  return h.ledger.listEvents({ limit: 500 }).filter((event) => event.kind === kind).length;
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  if (!condition()) throw new Error(`timed out waiting for ${what}`);
}

/** One live intent on a ready lane with the fixture repo. */
async function seededLiveRequest(
  h: Harness,
  repo: FixtureRepo,
  jobId: string,
  requestId: string,
): Promise<{ lane: WorktreeLane; row: DirectiveRequestRecord }> {
  seedJob(h, jobId);
  const lane = await seedLane(h, repo, jobId);
  const begun = h.ledger.beginDirectiveIntent({ jobId, directive: `repair ${jobId}`, holder: 'silas-ops', requestId });
  return { lane, row: begun.record };
}

describe('directive retirement — evidence-fenced control closure', () => {
  it('retires an admission-unknown request: one audit event, truthful readback, open hold', async () => {
    const repo = makeFixtureRepo('retire-success');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane, row } = await seededLiveRequest(h, repo, 'job-a', 'req-a');
    expect(row.state).toBe('dispatching');

    const result = await retire(h, 'req-a', laneHead(lane));
    expect(result.status).toBe(200);
    expect(field<string>(result.json, 'state')).toBe('retired');
    expect(field<boolean>(result.json, 'idempotent')).toBe(false);
    expect(field<string>(result.json, 'admission_class')).toBe('admission-unknown');
    expect(field<number | null>(result.json, 'admission_seq')).toBeNull();

    const after = h.ledger.getDirective('req-a');
    expect(after?.state).toBe('retired');
    expect(after?.admissionSeq).toBeNull();
    expect(after?.deliverySeq).toBeNull();
    expect(after?.retiredBy).toBe('silas-ops');
    expect(after?.retireReason).toBe('writer ceased; no terminal receipt can exist');
    expect(after?.retireExpectedState).toBe('dispatching');
    expect(after?.retireExpectedHead).toBe(laneHead(lane));
    expect(after?.holdReleasedBy).toBeNull();
    // A lost-response retry can reconstruct the canonical intent from the
    // readback alone: the recorded expectations are exposed.
    expect(field<string>(result.json, 'retire_expected_state')).toBe('dispatching');
    expect(field<string>(result.json, 'retire_expected_head')).toBe(laneHead(lane));
    expect(countEvents(h, 'silas.directive-retired')).toBe(1);
    // No fabricated lifecycle event of any other kind.
    expect(countEvents(h, 'silas.directive-sent')).toBe(0);
    expect(countEvents(h, 'job.delivered')).toBe(0);
    expect(countEvents(h, 'silas.directive-settled')).toBe(0);
    expect(countEvents(h, 'silas.directive-failed')).toBe(0);
    // No worker was spawned; the job row is untouched.
    expect(h.spawns).toHaveLength(0);
    expect(h.ledger.getJob('job-a')?.status).toBe('working');

    // Authenticated readback reports the closure truthfully.
    const readback = await call(h.port, 'GET', '/api/silas/directives/req-a', undefined, TOKEN);
    expect(readback.status).toBe(200);
    expect(field<string>(readback.json, 'state')).toBe('retired');
    expect(field<string>(readback.json, 'admission_class')).toBe('admission-unknown');
    expect(field<string>(readback.json, 'payload_hash')).toBe(row.payloadHash);
    expect(field<string>(readback.json, 'retire_expected_state')).toBe('dispatching');
    expect(field<string>(readback.json, 'retire_expected_head')).toBe(laneHead(lane));
    expect(field<string>(field<Record<string, unknown>>(readback.json, 'states'), 'retired')).toContain(
      'control ownership closed',
    );
    expect(field<unknown>(readback.json, 'delivery_seq')).toBeNull();
  });

  it('retires an admitted-without-terminal request preserving its admission evidence', async () => {
    const repo = makeFixtureRepo('retire-admitted');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-b', 'req-b');
    markHistoricalDirectiveFixture(h.ledger, 'req-b');
    const sent = h.ledger.appendCustomEvent({
      kind: 'silas.directive-sent',
      jobId: 'job-b',
      payload: { request_id: 'req-b', minion_id: 'minion-b' },
    });
    h.ledger.recordDirectiveAdmission({ requestId: 'req-b', minionId: 'minion-b', eventSeq: sent.seq });

    const result = await retire(h, 'req-b', laneHead(lane));
    expect(result.status).toBe(200);
    expect(field<string>(result.json, 'admission_class')).toBe('admitted-without-terminal');
    expect(field<number>(result.json, 'admission_seq')).toBe(sent.seq);
    expect(field<string>(result.json, 'minion_id')).toBe('minion-b');
    const after = h.ledger.getDirective('req-b');
    expect(after?.state).toBe('retired');
    expect(after?.admissionSeq).toBe(sent.seq);
    expect(after?.admissionMinion).toBe('minion-b');
    expect(after?.deliverySeq).toBeNull();
    expect(countEvents(h, 'silas.directive-retired')).toBe(1);
    // The retired approval event carries the class, never a receipt claim.
    const retired = h.ledger.listEvents({ limit: 500 }).find((event) => event.kind === 'silas.directive-retired');
    const payload = retired?.payload as Record<string, unknown>;
    expect(payload['admission_class']).toBe('admitted-without-terminal');
    expect(payload['admission_minion']).toBe('minion-b');
  });

  it('preserves a correlated but unbound admission instead of discarding it', async () => {
    const repo = makeFixtureRepo('retire-unbound');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-c', 'req-c');
    markHistoricalDirectiveFixture(h.ledger, 'req-c');
    // The crash window: the admission EVENT landed, the row was never bound.
    const sent = h.ledger.appendCustomEvent({
      kind: 'silas.directive-sent',
      jobId: 'job-c',
      payload: { request_id: 'req-c', minion_id: 'minion-c' },
    });
    expect(h.ledger.getDirective('req-c')?.state).toBe('dispatching');

    const result = await retire(h, 'req-c', laneHead(lane));
    expect(result.status).toBe(200);
    expect(field<string>(result.json, 'admission_class')).toBe('admitted-without-terminal');
    const after = h.ledger.getDirective('req-c');
    expect(after?.admissionSeq).toBe(sent.seq);
    expect(after?.admissionMinion).toBe('minion-c');
    expect(after?.state).toBe('retired');
  });

  it('refuses a correlated terminal receipt so normal settlement owns the request', async () => {
    const repo = makeFixtureRepo('retire-terminal-receipt');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-d', 'req-d');
    markHistoricalDirectiveFixture(h.ledger, 'req-d');
    const sent = h.ledger.appendCustomEvent({
      kind: 'silas.directive-sent',
      jobId: 'job-d',
      payload: { request_id: 'req-d', minion_id: 'minion-d' },
    });
    h.ledger.recordDirectiveAdmission({ requestId: 'req-d', minionId: 'minion-d', eventSeq: sent.seq });
    h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-d', payload: { request_id: 'req-d', sha: 'sha-d' } });

    const refused = await retire(h, 'req-d', laneHead(lane));
    expect(refused.status).toBe(409);
    expect(field<string>(refused.json, 'error')).toBe('terminal_receipt_present');
    expect(h.ledger.getDirective('req-d')?.state).toBe('admitted');
    expect(countEvents(h, 'silas.directive-retired')).toBe(0);

    // The ordinary reconciler then settles it — the receipt was not lost.
    const report = settleDirectivesFromEvidence({ ledger: h.ledger });
    expect(report.completed).toBe(1);
    expect(h.ledger.getDirective('req-d')?.state).toBe('settled');
  });

  it('refuses settled requests and requests with incomplete admission identity', async () => {
    const repo = makeFixtureRepo('retire-refusals');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-e', 'req-e');
    h.ledger.failDirective({ requestId: 'req-e', reason: 'positive no-effect proof' });
    const settledRefusal = await retire(h, 'req-e', laneHead(lane));
    expect(settledRefusal.status).toBe(409);
    expect(field<string>(settledRefusal.json, 'error')).toBe('directive_not_live');

    // A correlated sent event without minion identity cannot bind: fail closed.
    seedJob(h, 'job-f');
    const laneF = await seedLane(h, repo, 'job-f');
    h.ledger.beginDirectiveIntent({ jobId: 'job-f', directive: 'x', holder: 'silas-ops', requestId: 'req-f' });
    h.ledger.appendCustomEvent({ kind: 'silas.directive-sent', jobId: 'job-f', payload: { request_id: 'req-f' } });
    const incomplete = await retire(h, 'req-f', laneHead(laneF));
    expect(incomplete.status).toBe(409);
    expect(field<string>(incomplete.json, 'error')).toBe('admission_evidence_incomplete');
    expect(h.ledger.getDirective('req-f')?.state).toBe('dispatching');
  });

  it('refuses missing and mismatched identities without changing anything', async () => {
    const repo = makeFixtureRepo('retire-identities');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane, row } = await seededLiveRequest(h, repo, 'job-g', 'req-g');
    const head = laneHead(lane);
    const before = eventKinds(h);

    const missing = await call(
      h.port,
      'POST',
      '/api/silas/directives/req-nope/retire',
      retireBody(row, head),
      TOKEN,
    );
    expect(missing.status).toBe(404);

    const wrongJob = await retire(h, 'req-g', head, { expected_job_id: 'job-other' });
    expect(wrongJob.status).toBe(409);
    expect(field<string>(wrongJob.json, 'error')).toBe('request_mismatch');

    const wrongHash = await retire(h, 'req-g', head, { expected_payload_hash: 'f'.repeat(64) });
    expect(wrongHash.status).toBe(409);
    expect(field<string>(wrongHash.json, 'error')).toBe('request_mismatch');

    const wrongState = await retire(h, 'req-g', head, { expected_state: 'admitted' });
    expect(wrongState.status).toBe(409);
    expect(field<string>(wrongState.json, 'error')).toBe('request_mismatch');

    const staleHead = await retire(h, 'req-g', 'a'.repeat(40));
    expect(staleHead.status).toBe(409);
    expect(field<string>(staleHead.json, 'error')).toBe('stale_head');

    const badState = await retire(h, 'req-g', head, { expected_state: 'teleported' });
    expect(badState.status).toBe(400);

    const badHead = await retire(h, 'req-g', 'zzzz');
    expect(badHead.status).toBe(400);

    // Every refusal above left the row, events and holds untouched.
    expect(h.ledger.getDirective('req-g')?.state).toBe('dispatching');
    expect(eventKinds(h)).toEqual(before);
    expect(h.ledger.listDirectiveRecoveryHolds({ openOnly: true })).toHaveLength(0);

    // A valid uppercase object id is normalized, never misread as stale.
    const upper = await retire(h, 'req-g', head.toUpperCase());
    expect(upper.status).toBe(200);
    expect(h.ledger.getDirective('req-g')?.retireExpectedHead).toBe(head);
    expect(h.ledger.getDirective('req-g')?.state).toBe('retired');
  });

  it('refuses a head that moved after the caller verified it, then accepts the fresh head', async () => {
    const repo = makeFixtureRepo('retire-stale-head');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-h', 'req-h');
    const oldHead = laneHead(lane);
    // Advance the lane itself; the fixture repo's main branch never moves it.
    execFileSync('git', ['-C', lane.path, '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '--allow-empty', '-m', 'lane moved'], { stdio: 'ignore' });
    const refused = await retire(h, 'req-h', oldHead);
    expect(refused.status).toBe(409);
    expect(field<string>(refused.json, 'error')).toBe('stale_head');
    const accepted = await retire(h, 'req-h', laneHead(lane));
    expect(accepted.status).toBe(200);
    expect(h.ledger.getDirective('req-h')?.state).toBe('retired');
  });
});

describe('directive retirement — checked-out lane identity', () => {
  it('binds the checked-out HEAD, not a stale registered branch tip', async () => {
    const repo = makeFixtureRepo('retire-detached');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane, row } = await seededLiveRequest(h, repo, 'job-detached', 'req-detached');
    const oldHead = laneHead(lane);
    execFileSync('git', ['-C', lane.path, 'checkout', '--detach'], { stdio: 'ignore' });
    execFileSync('git', ['-C', lane.path, '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid',
      'commit', '--allow-empty', '-m', 'detached lane moved'], { stdio: 'ignore' });
    expect(resolveGitCommit(lane.path, lane.branch!)).toBe(oldHead);
    expect(laneHead(lane)).not.toBe(oldHead);
    const before = eventKinds(h);
    const refused = await retire(h, row.requestId, oldHead);
    expect(refused.status).toBe(409);
    expect(field<string>(refused.json, 'error')).toBe('stale_head');
    expect(h.ledger.getDirective(row.requestId)).toEqual(row);
    expect(eventKinds(h)).toEqual(before);
    expect((await retire(h, row.requestId, laneHead(lane))).status).toBe(200);
  });

  it('refuses ambiguous or inaccessible lanes without changing control evidence', async () => {
    const repo = makeFixtureRepo('retire-ambiguous');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane, row } = await seededLiveRequest(h, repo, 'job-ambiguous', 'req-ambiguous');
    const head = laneHead(lane);
    const before = eventKinds(h);
    const lanes = vi.spyOn(h.worktrees, 'listWorktrees');
    lanes.mockReturnValue([lane, { ...lane, id: 'another-lane' }]);
    expect(field<string>((await retire(h, row.requestId, head)).json, 'error')).toBe('lane_unavailable');
    lanes.mockReturnValue([{ ...lane, path: join(h.dir, 'missing-lane') }]);
    expect(field<string>((await retire(h, row.requestId, head)).json, 'error')).toBe('lane_unavailable');
    expect(h.ledger.getDirective(row.requestId)).toEqual(row);
    expect(eventKinds(h)).toEqual(before);
    expect(h.ledger.listDirectiveRecoveryHolds({ openOnly: true })).toEqual([]);
    lanes.mockRestore();
    expect((await retire(h, row.requestId, head)).status).toBe(200);
  });
});

describe('directive retirement — live ownership fails closed', () => {
  it('refuses while an agent turn is spawning/streaming and succeeds once disposed', async () => {
    const repo = makeFixtureRepo('retire-live-agent');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-i', 'req-i');
    h.ledger.registerAgent({ id: 'minion-live', role: 'minion', jobId: 'job-i' });
    h.ledger.setAgentState('minion-live', 'spawning');

    const spawning = await retire(h, 'req-i', laneHead(lane));
    expect(spawning.status).toBe(409);
    expect(field<string>(spawning.json, 'error')).toBe('live_work');
    expect((field<string[]>(spawning.json, 'blockers') ?? []).join(' ')).toContain('minion-live');

    h.ledger.setAgentState('minion-live', 'streaming');
    const streaming = await retire(h, 'req-i', laneHead(lane));
    expect(streaming.status).toBe(409);
    expect(field<string>(streaming.json, 'error')).toBe('live_work');

    h.ledger.setAgentState('minion-live', 'disposed');
    const accepted = await retire(h, 'req-i', laneHead(lane));
    expect(accepted.status).toBe(200);
  });

  it('refuses while a child worker is non-terminal even after its agent row is disposed', async () => {
    const repo = makeFixtureRepo('retire-child');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-j', 'req-j');
    h.ledger.registerAgent({ id: 'parent-j', role: 'minion', jobId: 'job-j' });
    h.ledger.admitChildWorker({
      id: 'child-j',
      parentAgentId: 'parent-j',
      jobId: 'job-j',
      purpose: 'verify something',
      authority: 'read-only',
      task: 'read',
      idempotencyKey: 'child-j-key',
    });
    // Both agent rows are disposed; the child's durable worker record is
    // still non-terminal, so the lane is not free.
    h.ledger.setAgentState('parent-j', 'disposed');
    h.ledger.setAgentState('child-j', 'disposed');

    const refused = await retire(h, 'req-j', laneHead(lane));
    expect(refused.status).toBe(409);
    expect((field<string[]>(refused.json, 'blockers') ?? []).join(' ')).toContain('child-j');
    h.ledger.recordChildResult('child-j', { state: 'done', summary: null, ref: null });
    expect((await retire(h, 'req-j', laneHead(lane))).status).toBe(200);
  });

  it('refuses while a job admission is in flight', async () => {
    const repo = makeFixtureRepo('retire-admission');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-k', 'req-k');
    const release = h.ledger.beginJobAdmission('job-k', 'probe producer');
    const refused = await retire(h, 'req-k', laneHead(lane));
    expect(refused.status).toBe(409);
    expect((field<string[]>(refused.json, 'blockers') ?? []).join(' ')).toContain('probe producer');
    release();
    expect((await retire(h, 'req-k', laneHead(lane))).status).toBe(200);
  });

  it('refuses while a pace-gate worker turn is queued for the job', async () => {
    const repo = makeFixtureRepo('retire-queued');
    cleanupRepos.push(repo);
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 1 });
    const h = await boot({ workerGate: gate });
    const { lane } = await seededLiveRequest(h, repo, 'job-queued', 'req-queued');
    // Fill the single slot, then queue a real producer acquisition for the job.
    const held = await gate.acquireWorkerTurn({ id: 'holder', label: 'other lane', jobId: 'other-job' });
    const queued = gate.acquireWorkerTurn({ id: 'job-queued', label: 'directive (fresh minion) → job-queued', jobId: 'job-queued' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(gate.view().worker.queued.some((entry) => entry.id === 'job-queued')).toBe(true);

    const refused = await retire(h, 'req-queued', laneHead(lane));
    expect(refused.status).toBe(409);
    expect(field<string>(refused.json, 'error')).toBe('live_work');
    expect((field<string[]>(refused.json, 'blockers') ?? []).join(' ')).toContain('queued worker turn');

    held.release();
    (await queued).release();
    expect(gate.view().worker.queued).toEqual([]);
    expect((await retire(h, 'req-queued', laneHead(lane))).status).toBe(200);
  });

  it('refuses while a re-brief marker is unresolved', async () => {
    const repo = makeFixtureRepo('retire-rebrief');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-l', 'req-l');
    // A live directive and a re-brief marker can no longer be ACCEPTED
    // together (owner rule 5: one writer per lane), but rows written before
    // that fence existed can still coexist: seed the legacy marker pair
    // directly, to prove retirement still refuses that shape.
    expect(() => h.ledger.beginPendingRebrief({ jobId: 'job-l', note: 'fold', briefing: 'b' }))
      .toThrow(/live directive request/);
    const legacy = h.db.handle.prepare(
      `INSERT INTO pending_rebriefs (id, job_id, kind, payload, payload_hash, baseline_seq, requested_at, updated_at)
       VALUES (?, 'job-l', ?, '{"note":"fold","briefing":"b"}', 'legacy-hash', 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
    );
    legacy.run('legacy-rebrief', 'silas.rebrief');
    legacy.run('legacy-delivered', 'job.delivered');
    const markers = h.ledger.listPendingRebriefs({ jobId: 'job-l' });
    expect(markers).toHaveLength(2);
    const refused = await retire(h, 'req-l', laneHead(lane));
    expect(refused.status).toBe(409);
    expect((field<string[]>(refused.json, 'blockers') ?? []).join(' ')).toContain('re-brief');
    h.ledger.clearPendingRebriefs(markers.map((marker) => marker.id));
    expect((await retire(h, 'req-l', laneHead(lane))).status).toBe(200);
  });

  it('refuses while a provider continuation is open or claimed', async () => {
    const repo = makeFixtureRepo('retire-provider');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-m', 'req-m');
    h.ledger.recordProviderWait({
      id: 'wait-m',
      routeKey: 'route-m',
      provider: 'p',
      model: 'm',
      endpoint: 'e',
      credentialFingerprint: 'fp',
      waiterKind: 'job-minion',
      jobId: 'job-m',
      agentId: null,
      slotId: null,
      sessionFile: null,
      continuation: null,
      jobStatusAtEstablishment: 'working',
      lineageKey: null,
      incidentId: 'incident-m',
      incidentGeneration: 1,
      reasonClass: 'temporary-limit',
    });
    const refused = await retire(h, 'req-m', laneHead(lane));
    expect(refused.status).toBe(409);
    expect((field<string[]>(refused.json, 'blockers') ?? []).join(' ')).toContain('wait-m');

    // Recovered-pending is still a live claimable continuation.
    h.ledger.setProviderWaitStatus('wait-m', 'recovered-pending');
    const recovered = await retire(h, 'req-m', laneHead(lane));
    expect(recovered.status).toBe(409);
    expect((field<string[]>(recovered.json, 'blockers') ?? []).join(' ')).toContain('recovered-pending');

    // A claimed continuation is a live producer.
    expect(h.ledger.claimProviderWaitAtomic('wait-m')).toBe(true);
    const claimed = await retire(h, 'req-m', laneHead(lane));
    expect(claimed.status).toBe(409);
    expect((field<string[]>(claimed.json, 'blockers') ?? []).join(' ')).toContain('claimed');

    // A terminal wait releases the lane (same-shape job).
    seedJob(h, 'job-m2');
    const laneM2 = await seedLane(h, repo, 'job-m2');
    h.ledger.beginDirectiveIntent({ jobId: 'job-m2', directive: 'x', holder: 'silas-ops', requestId: 'req-m2' });
    h.ledger.recordProviderWait({
      id: 'wait-m2',
      routeKey: 'route-m2',
      provider: 'p',
      model: 'm',
      endpoint: 'e',
      credentialFingerprint: 'fp',
      waiterKind: 'job-minion',
      jobId: 'job-m2',
      agentId: null,
      slotId: null,
      sessionFile: null,
      continuation: null,
      jobStatusAtEstablishment: 'working',
      lineageKey: null,
      incidentId: 'incident-m2',
      incidentGeneration: 1,
      reasonClass: 'temporary-limit',
    });
    h.ledger.setProviderWaitStatus('wait-m2', 'cancelled', { reason: 'test' });
    expect((await retire(h, 'req-m2', laneHead(laneM2))).status).toBe(200);
  });

  it('refuses while an unsettled verification run holds the lane', async () => {
    const repo = makeFixtureRepo('retire-verify');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-n', 'req-n');
    h.ledger.appendCustomEvent({ kind: 'verification.requested', jobId: 'job-n', payload: { run_id: 'run-n' } });
    const refused = await retire(h, 'req-n', laneHead(lane));
    expect(refused.status).toBe(409);
    expect((field<string[]>(refused.json, 'blockers') ?? []).join(' ')).toContain('verification');
    h.ledger.appendCustomEvent({ kind: 'verification.completed', jobId: 'job-n', payload: { run_id: 'run-n' } });
    expect((await retire(h, 'req-n', laneHead(lane))).status).toBe(200);
  });

  it('refuses while a review round is pending or live', async () => {
    const repo = makeFixtureRepo('retire-round');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-o', 'req-o');
    const round = h.ledger.addRound({ jobId: 'job-o' });
    const pending = await retire(h, 'req-o', laneHead(lane));
    expect(pending.status).toBe(409);
    expect((field<string[]>(pending.json, 'blockers') ?? []).join(' ')).toContain(`${round.id} (pending)`);
    h.ledger.setRoundStatus(round.id, 'live');
    const live = await retire(h, 'req-o', laneHead(lane));
    expect(live.status).toBe(409);
    expect((field<string[]>(live.json, 'blockers') ?? []).join(' ')).toContain(`${round.id} (live)`);
    h.ledger.setRoundStatus(round.id, 'aborted');
    expect((await retire(h, 'req-o', laneHead(lane))).status).toBe(200);
  });

  it('refuses while a live lane process is recorded, then succeeds after the kill sweep', async () => {
    const repo = makeFixtureRepo('retire-process');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-p', 'req-p');
    h.ledger.registerWorktree({
      id: lane.id,
      kind: 'job',
      repoPath: repo.path,
      repoName: 'fixture-app',
      path: lane.path,
      branch: lane.branch,
      sha: laneHead(lane),
      jobId: 'job-p',
    });
    h.ledger.recordWorktreeProcesses({
      worktreeId: lane.id,
      processes: [{ pid: 4242, command: 'node dist/main.js', evidence: 'cwd' }],
      state: 'live',
    });
    const refused = await retire(h, 'req-p', laneHead(lane));
    expect(refused.status).toBe(409);
    expect((field<string[]>(refused.json, 'blockers') ?? []).join(' ')).toContain('4242');
    h.ledger.recordWorktreeProcesses({
      worktreeId: lane.id,
      processes: [{ pid: 4242, command: 'node dist/main.js', evidence: 'cwd' }],
      state: 'killed',
    });
    expect((await retire(h, 'req-p', laneHead(lane))).status).toBe(200);
  });

  it('refuses when the job has no resolvable lane and never guesses', async () => {
    const repo = makeFixtureRepo('retire-no-lane');
    cleanupRepos.push(repo);
    const h = await boot();
    seedJob(h, 'job-q');
    h.ledger.beginDirectiveIntent({ jobId: 'job-q', directive: 'x', holder: 'silas-ops', requestId: 'req-q' });
    const refused = await retire(h, 'req-q', 'a'.repeat(40));
    expect(refused.status).toBe(409);
    expect(field<string>(refused.json, 'error')).toBe('lane_unavailable');
    expect(h.ledger.getDirective('req-q')?.state).toBe('dispatching');
  });

  it('requires authentication before any state work', async () => {
    const repo = makeFixtureRepo('retire-auth');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-r', 'req-r');
    const result = await retire(h, 'req-r', laneHead(lane), {}, null);
    expect(result.status).toBe(401);
    expect(h.ledger.getDirective('req-r')?.state).toBe('dispatching');
    expect(countEvents(h, 'silas.directive-retired')).toBe(0);
  });
});

describe('directive retirement — idempotency, conflicts and late evidence', () => {
  it('replays idempotently with one audit event, refuses changed intent', async () => {
    const repo = makeFixtureRepo('retire-idempotent');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-s', 'req-s');
    const head = laneHead(lane);
    const first = await retire(h, 'req-s', head);
    expect(first.status).toBe(200);
    expect(field<boolean>(first.json, 'idempotent')).toBe(false);

    const replay = await retire(h, 'req-s', head);
    expect(replay.status).toBe(200);
    expect(field<boolean>(replay.json, 'idempotent')).toBe(true);
    expect(countEvents(h, 'silas.directive-retired')).toBe(1);

    const conflictingReason = await retire(h, 'req-s', head, { reason: 'a different story' });
    expect(conflictingReason.status).toBe(409);
    expect(field<string>(conflictingReason.json, 'error')).toBe('retire_conflict');

    const conflictingHead = await retire(h, 'req-s', 'b'.repeat(40));
    expect(conflictingHead.status).toBe(409);
    expect(field<string>(conflictingHead.json, 'error')).toBe('retire_conflict');
    expect(countEvents(h, 'silas.directive-retired')).toBe(1);
    expect(h.ledger.getDirective('req-s')?.state).toBe('retired');

    // A lost-response retry reconstructs the identical canonical intent
    // from the readback alone and replays idempotently.
    const readback = await call(h.port, 'GET', '/api/silas/directives/req-s', undefined, TOKEN);
    const reconstructed = await call(
      h.port,
      'POST',
      '/api/silas/directives/req-s/retire',
      {
        expected_job_id: field<string>(readback.json, 'job_id'),
        expected_state: field<string>(readback.json, 'retire_expected_state'),
        expected_payload_hash: field<string>(readback.json, 'payload_hash'),
        expected_head: field<string>(readback.json, 'retire_expected_head'),
        reason: field<string>(readback.json, 'retire_reason'),
        by: field<string>(readback.json, 'retired_by'),
      },
      TOKEN,
    );
    expect(reconstructed.status).toBe(200);
    expect(field<boolean>(reconstructed.json, 'idempotent')).toBe(true);
    expect(countEvents(h, 'silas.directive-retired')).toBe(1);
  });

  it('pins the canonical retirement fingerprint as a durable format constant', () => {
    // retire_fingerprint is the replay identity persisted for the life of
    // the record: a future change that reorders or extends the hashed
    // preimage would silently turn every existing replay into a conflict.
    // This golden value is the format contract.
    const fingerprint = directiveRetirementFingerprint({
      requestId: 'req-golden',
      expectedJobId: 'job-golden',
      expectedState: 'dispatching',
      expectedPayloadHash: '0'.repeat(64),
      expectedHead: '1'.repeat(40),
      reason: 'writer ceased',
      by: 'silas-ops',
    });
    expect(fingerprint).toBe('5f3198a42e1724892a714e3508561be919d694a473c41fae73e551c5c2f3a610');
  });

  it('never replays a consumed request id as a new turn', async () => {
    const repo = makeFixtureRepo('retire-consumed');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-t', 'req-t');
    expect((await retire(h, 'req-t', laneHead(lane))).status).toBe(200);
    const before = h.ledger.getDirective('req-t');
    expect(before?.state).toBe('retired');

    const replay = await call(
      h.port,
      'POST',
      '/api/silas/directive',
      { job_id: 'job-t', directive: 'repair job-t', request_id: 'req-t' },
      TOKEN,
    );
    expect(replay.status).toBe(200);
    expect(field<string>(replay.json, 'state')).toBe('retired');
    expect(field<boolean>(replay.json, 'replay')).toBe(true);
    expect(field<string>(replay.json, 'note')).toContain('new request id');
    // The replay path carries the same retirement facts as the readback.
    expect(field<string>(replay.json, 'admission_class')).toBe('admission-unknown');
    expect(field<string>(replay.json, 'retired_by')).toBe('silas-ops');
    expect(field<string>(replay.json, 'retire_reason')).toBe('writer ceased; no terminal receipt can exist');
    expect(field<string>(replay.json, 'retire_expected_state')).toBe('dispatching');
    expect(countEvents(h, 'silas.directive-sent')).toBe(0);
    expect(h.spawns).toHaveLength(0);
    const conflicting = await call(h.port, 'POST', '/api/silas/directive',
      { job_id: 'job-t', directive: 'different repair', request_id: 'req-t' }, TOKEN);
    expect(conflicting.status).toBe(409);
    expect(h.ledger.getDirective('req-t')).toEqual(before);
    expect(h.ledger.hasOpenDirectiveRecoveryHold('job-t')).toBe(true);
    expect(h.spawns).toHaveLength(0);
  });

  it('cannot be rewritten by a late delivery, failure or reconcile note', async () => {
    const repo = makeFixtureRepo('retire-late');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-u', 'req-u');
    expect((await retire(h, 'req-u', laneHead(lane))).status).toBe(200);
    const before = h.ledger.getDirective('req-u');
    const retiredAt = before?.updatedAt;
    const lateSent = h.ledger.appendCustomEvent({ kind: 'silas.directive-sent', jobId: 'job-u',
      payload: { request_id: 'req-u', minion_id: 'minion-late' } });
    expect(() => h.ledger.recordDirectiveAdmission({ requestId: 'req-u', minionId: 'minion-late', eventSeq: lateSent.seq }))
      .toThrow(/retired/u);

    const late = h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-u', payload: { request_id: 'req-u' } });
    expect(() => h.ledger.recordDirectiveDelivery({ requestId: 'req-u', eventSeq: late.seq })).toThrow(/retired/u);
    expect(() => h.ledger.failDirective({ requestId: 'req-u', reason: 'late failure' })).toThrow(/retired/u);
    const reconciled = h.ledger.recordDirectiveReconcile({ requestId: 'req-u', note: 'late note' });
    expect(reconciled.state).toBe('retired');
    expect(reconciled.attempts).toBe(h.ledger.getDirective('req-u')?.attempts);

    expect(h.ledger.getDirective('req-u')).toEqual(before);
    expect(h.ledger.hasOpenDirectiveRecoveryHold('job-u')).toBe(true);
    expect(h.ledger.getDirective('req-u')?.updatedAt).toBe(retiredAt);
    expect(countEvents(h, 'silas.directive-settled')).toBe(0);
    expect(countEvents(h, 'silas.directive-failed')).toBe(0);
    const pass = settleDirectivesFromEvidence({ ledger: h.ledger });
    expect(pass.completed).toBe(0);
    expect(h.ledger.getDirective('req-u')?.state).toBe('retired');
  });

  it('closes (never completes) an awaiting phase handoff in the same transaction', async () => {
    const repo = makeFixtureRepo('retire-phase');
    cleanupRepos.push(repo);
    const h = await boot();
    seedJob(h, 'job-v');
    const lane = await seedLane(h, repo, 'job-v');
    const begun = h.ledger.beginDirectiveIntent({
      jobId: 'job-v',
      directive: 'finish the bounded phase',
      holder: 'silas-ops',
      requestId: 'req-v',
      handoff: { kind: 'gru-decision', decision: 'rule on the phase' },
    });
    const phase = h.ledger.findPhaseHandoffByRequest({ jobId: 'job-v', requestId: 'req-v' });
    expect(phase?.state).toBe('awaiting');
    expect(begun.record.state).toBe('dispatching');

    const result = await retire(h, 'req-v', laneHead(lane));
    expect(result.status).toBe(200);
    expect(field<string>(result.json, 'phase_handoff_closed')).toBe(phase?.phaseId);
    expect(h.ledger.getPhaseHandoff(phase!.phaseId)?.state).toBe('closed');
    expect(h.ledger.getPhaseHandoff(phase!.phaseId)?.closeReason).toContain('retired without completion');
    expect(countEvents(h, 'job.phase-handoff-completed')).toBe(0);
    expect(h.ledger.listObligations({ jobId: 'job-v' })).toHaveLength(0);
    // The audit event carries the closed phase and the binding expectations
    // as one durable fact set.
    const retired = h.ledger.listEvents({ limit: 500 }).find((event) => event.kind === 'silas.directive-retired');
    const payload = retired?.payload as Record<string, unknown>;
    expect(payload['phase_handoff_closed']).toBe(phase?.phaseId);
    expect(payload['expected_state']).toBe('dispatching');
    expect(payload['expected_head']).toBe(laneHead(lane));
    // An identical replay reports the same closure (never a lost fact).
    const replay = await retire(h, 'req-v', laneHead(lane));
    expect(replay.status).toBe(200);
    expect(field<boolean>(replay.json, 'idempotent')).toBe(true);
    expect(field<string>(replay.json, 'phase_handoff_closed')).toBe(phase?.phaseId);
    // A fresh lane later (the hold release) resolves the phase reference by
    // request identity, not by re-closing anything.
    expect(countEvents(h, 'job.phase-handoff-closed')).toBe(1);
  });

  it('rolls back the whole retirement when a later step in the transaction throws', async () => {
    const repo = makeFixtureRepo('retire-rollback');
    cleanupRepos.push(repo);
    const h = await boot({
      wrapLedger: (ledger) => {
        const view = Object.create(ledger) as LedgerApi;
        Object.defineProperty(view, 'closePhaseHandoff', {
          value: () => {
            throw new Error('forced phase-close failure');
          },
        });
        return view;
      },
    });
    seedJob(h, 'job-w');
    const lane = await seedLane(h, repo, 'job-w');
    h.ledger.beginDirectiveIntent({
      jobId: 'job-w',
      directive: 'finish',
      holder: 'silas-ops',
      requestId: 'req-w',
      handoff: { kind: 'gru-decision', decision: 'rule' },
    });
    const phase = h.ledger.findPhaseHandoffByRequest({ jobId: 'job-w', requestId: 'req-w' });
    const result = await retire(h, 'req-w', laneHead(lane));
    expect(result.status).toBe(400);
    // Nothing partial committed: no state flip, no audit event, no hold.
    expect(h.ledger.getDirective('req-w')?.state).toBe('dispatching');
    expect(countEvents(h, 'silas.directive-retired')).toBe(0);
    expect(h.ledger.listDirectiveRecoveryHolds({ openOnly: true })).toHaveLength(0);
    expect(h.ledger.getPhaseHandoff(phase!.phaseId)?.state).toBe('awaiting');
  });
});

describe('directive retirement — continuation boundary and consumers', () => {
  it('fences the lane until a fresh accepted request releases the hold', async () => {
    const repo = makeFixtureRepo('retire-hold');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-x', 'req-x');
    // An unrelated phase delivered after the status hop. Once the subject
    // request retires, ONLY its hold keeps this otherwise idle lane busy.
    h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-x', payload: { source: 'previous-phase' } });
    expect((await retire(h, 'req-x', laneHead(lane))).status).toBe(200);

    const job = h.ledger.getJob('job-x') as JobRecord;
    const withoutHold = Object.assign(Object.create(h.ledger) as LedgerApi,
      { hasOpenDirectiveRecoveryHold: () => false });
    expect(laneIsBusy(withoutHold, job)).toBe(false);
    expect(laneIsBusy(h.ledger, job)).toBe(true);
    expect(h.ledger.hasOpenDirectiveRecoveryHold('job-x')).toBe(true);
    const lanes = h.worktrees.listWorktrees({ jobId: 'job-x' });
    expect(findBusyLanes({ ledger: h.ledger, lanes, targetBranch: 'gru/job-x' }).map((blocker) => blocker.jobId)).toEqual([
      'job-x',
    ]);

    // A fresh directive is the separately authorized, identity-checked
    // handoff: acceptance releases the hold by ITS request id.
    const accepted = await call(
      h.port,
      'POST',
      '/api/silas/directive',
      { job_id: 'job-x', directive: 'fresh authorized repair', request_id: 'req-x-next' },
      TOKEN,
    );
    expect(accepted.status).toBe(202);
    const hold = h.ledger.listDirectiveRecoveryHolds({ jobId: 'job-x' })[0];
    expect(hold?.releasedBy).toBe('req-x-next');
    expect(hold?.releasedAt).not.toBeNull();
    expect(h.ledger.hasOpenDirectiveRecoveryHold('job-x')).toBe(false);

    await waitFor(() => h.ledger.getDirective('req-x-next')?.state === 'settled', 'the fresh directive to settle');
    expect(h.ledger.latestJobEvent('job-x', 'job.delivered')).not.toBeNull();
    expect(laneIsBusy(h.ledger, h.ledger.getJob('job-x') as JobRecord)).toBe(false);
  });

  it('releases the hold on a fresh accepted re-brief by its new durable request identity', async () => {
    const repo = makeFixtureRepo('retire-hold-rebrief');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-y', 'req-y');
    expect((await retire(h, 'req-y', laneHead(lane))).status).toBe(200);
    expect(h.ledger.hasOpenDirectiveRecoveryHold('job-y')).toBe(true);

    const rebrief = await call(h.port, 'POST', '/api/silas/rebrief', { job_id: 'job-y', note: 'fold the fix', request_id: 'req-y-rebrief' }, TOKEN);
    expect(rebrief.status).toBe(202);
    expect(field<string>(rebrief.json, 'request_id')).toBe('req-y-rebrief');
    const hold = h.ledger.listDirectiveRecoveryHolds({ jobId: 'job-y' })[0];
    expect(hold?.releasedBy).toBe('req-y-rebrief');
    expect(h.ledger.hasOpenDirectiveRecoveryHold('job-y')).toBe(false);
    expect(h.ledger.listPendingRebriefs({ jobId: 'job-y' })).toEqual([]);
    await waitFor(() => h.ledger.getDirective('req-y-rebrief')?.state === 'settled', 'the exact native rebrief completion');
    expect(h.ledger.getDirective('req-y-rebrief')?.nativeBinding).not.toBeNull();
    expect(h.ledger.latestJobEventByRequestId('job-y', 'job.delivered', 'req-y-rebrief')).not.toBeNull();
  });

  it('suppresses digest offers and never arms review while the hold is open', async () => {
    const repo = makeFixtureRepo('retire-digest');
    cleanupRepos.push(repo);
    const h = await boot();
    seedJob(h, 'job-z');
    const lane = await seedLane(h, repo, 'job-z');
    // A delivered phase with a registered PR that would ordinarily be
    // offered for review.
    h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-z',
      payload: { source: 'silas-directive', sha: laneHead(lane) },
    });
    h.ledger.setJobStatus('job-z', 'in-review');
    h.ledger.setJobPr('job-z', 'https://git.example.invalid/fixture-owner/fixture-app/pull/77');

    const digest = async () =>
      computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
    // Baseline discrimination: with no fence at all, the offer exists.
    expect((await digest()).prWithoutReview.map((row) => row.jobId)).toEqual(['job-z']);

    h.ledger.beginDirectiveIntent({ jobId: 'job-z', directive: 'repair', holder: 'silas-ops', requestId: 'req-z' });
    expect((await digest()).prWithoutReview).toEqual([]);
    expect((await retire(h, 'req-z', laneHead(lane))).status).toBe(200);
    // The open hold alone suppresses the offer — no live request needed.
    expect((await digest()).prWithoutReview).toEqual([]);
    expect((await digest()).stalledWorking).toEqual([]);
    expect((await digest()).deliveredWithoutPr).toEqual([]);

    // A fresh accepted request releases the hold; once its turn settles the
    // ordinary offer returns — the fence was the closed control decision,
    // not a permanent lane freeze.
    h.ledger.beginDirectiveIntent({ jobId: 'job-z', directive: 'fresh repair', holder: 'silas-ops', requestId: 'req-z-next' });
    admitNativeDirectiveFixture(h.ledger, 'req-z-next', 'minion-z', join(h.dir, 'minion-z.jsonl'));
    const delivered = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-z',
      payload: { request_id: 'req-z-next', source: 'silas-directive', sha: laneHead(lane), agentId: 'minion-z', work_revision: h.ledger.getDirective('req-z-next')!.workRevision },
    });
    h.ledger.recordDirectiveDelivery({ requestId: 'req-z-next', eventSeq: delivered.seq });
    expect((await digest()).prWithoutReview.map((row) => row.jobId)).toEqual(['job-z']);
  });

  it('suppresses all continuation offers until a fresh request supersedes the hold', async () => {
    const repo = makeFixtureRepo('retire-all-offers');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-offers', 'req-offers');
    h.ledger.setJobStatus('job-offers', 'in-review');
    const round = h.ledger.addRound({ jobId: 'job-offers', lenses: ['blind'] });
    h.ledger.setRoundStatus(round.id, 'live');
    h.ledger.setRoundVerdict(round.id, 'changes-requested');
    h.ledger.appendCustomEvent({ kind: 'job.minion-error', jobId: 'job-offers', payload: { error: 'interrupted' } });
    h.ledger.appendCustomEvent({ kind: 'verification.completed', jobId: 'job-offers',
      payload: { scope: 'full', run_id: 'run-failed', sha: laneHead(lane), ok: false } });
    h.ledger.appendCustomEvent({ kind: 'verification.lock-timeout', jobId: 'job-offers',
      payload: { scope: 'focused', request_id: 'verify-wait', head: laneHead(lane), wait_ms: 10 } });
    const digest = () => computeSilasDigest({ ledger: h.ledger, blockersForRound: async () => ({ blockers: [], note: null }),
      config: DEFAULT_SILAS_CONFIG, trigger: 'sweep' });
    const baseline = await digest();
    expect(baseline.verdictsAwaitingDirective).toHaveLength(1);
    expect(baseline.verificationFailures).toHaveLength(1);
    expect(baseline.verificationWaits).toHaveLength(1);
    expect(baseline.minionErrors).toHaveLength(1);
    expect((await retire(h, 'req-offers', laneHead(lane))).status).toBe(200);
    const before = eventKinds(h);
    const fenced = await digest();
    expect(fenced.verdictsAwaitingDirective).toEqual([]);
    expect(fenced.verificationFailures).toEqual([]);
    expect(fenced.verificationWaits).toEqual([]);
    expect(fenced.minionErrors).toEqual([]);
    expect(eventKinds(h)).toEqual(before);
    expect(h.spawns).toEqual([]);
    h.ledger.beginDirectiveIntent({ jobId: 'job-offers', directive: 'new authority', holder: 'silas-ops', requestId: 'req-offers-next' });
    h.ledger.failDirective({ requestId: 'req-offers-next', reason: 'fixture no-effect proof' });
    const released = await digest();
    expect(released.verdictsAwaitingDirective).toHaveLength(1);
    expect(released.verificationFailures).toHaveLength(1);
    expect(released.verificationWaits).toHaveLength(1);
    expect(released.minionErrors).toHaveLength(1);
  });

  it('retracts continuation offers when retirement happens during an awaited digest read', async () => {
    const repo = makeFixtureRepo('retire-offer-race');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-offer-race', 'req-offer-race');
    h.ledger.setJobStatus('job-offer-race', 'in-review');
    const round = h.ledger.addRound({ jobId: 'job-offer-race', lenses: ['blind'] });
    h.ledger.setRoundStatus(round.id, 'live');
    h.ledger.setRoundVerdict(round.id, 'changes-requested');
    let raced = false;
    const digest = await computeSilasDigest({ ledger: h.ledger, blockersForRound: async () => {
      raced = true;
      expect((await retire(h, 'req-offer-race', laneHead(lane))).status).toBe(200);
      return { blockers: [], note: null };
    }, config: DEFAULT_SILAS_CONFIG, trigger: 'sweep' });
    expect(raced).toBe(true);
    expect(digest.verdictsAwaitingDirective).toEqual([]);
    expect(h.ledger.hasOpenDirectiveRecoveryHold('job-offer-race')).toBe(true);
    expect(h.spawns).toEqual([]);
  });

  it('blocks late provider evidence from resuming or offering a retired lane', async () => {
    const repo = makeFixtureRepo('retire-late-provider');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-provider-late', 'req-provider-late');
    expect((await retire(h, 'req-provider-late', laneHead(lane))).status).toBe(200);
    h.ledger.recordProviderWait({ id: 'wait-late', routeKey: 'route-late', provider: 'p', model: 'm', endpoint: 'e',
      credentialFingerprint: 'fp', waiterKind: 'job-minion', jobId: 'job-provider-late', agentId: null, slotId: null,
      sessionFile: null, continuation: null, jobStatusAtEstablishment: 'working', lineageKey: null,
      incidentId: 'incident-late', incidentGeneration: 1, reasonClass: 'temporary-limit' });
    h.ledger.commitProviderRecoveryBatch({ id: 'batch-late', routeKey: 'route-late', incidentGenerations: [1],
      evidence: { stopReason: 'stop' }, waiters: [{ id: 'wait-late', jobId: 'job-provider-late' }] });
    const claim = () => claimProviderRecoveryContinuation({ ledger: h.ledger, worktrees: h.worktrees,
      registry: { getHandle: () => null, disposeHandle: async () => {},
        spawn: async () => { throw new Error('must not spawn'); } } }, 'wait-late', 'silas');
    for (const status of ['working', 'parked', 'blocked'] as const) {
      h.ledger.setJobStatus('job-provider-late', status);
      const beforeClaim = eventKinds(h);
      const result = await claim();
      expect(result.outcome).toBe('skipped');
      if (result.outcome === 'skipped') expect(result.why).toContain('retirement hold');
      expect(h.ledger.getProviderWait('wait-late')?.status).toBe('recovered-pending');
      expect(eventKinds(h)).toEqual(beforeClaim);
    }
    h.ledger.setJobStatus('job-provider-late', 'working');
    expect(h.ledger.getProviderWait('wait-late')?.status).toBe('recovered-pending');
    expect(h.ledger.hasOpenDirectiveRecoveryHold('job-provider-late')).toBe(true);
    const digest = await computeSilasDigest({ ledger: h.ledger, blockersForRound: async () => ({ blockers: [], note: null }),
      config: DEFAULT_SILAS_CONFIG, trigger: 'sweep' });
    expect(digest.providerRecoveryPending).toEqual([]);
    expect(h.spawns).toEqual([]);
    h.ledger.beginDirectiveIntent({ jobId: 'job-provider-late', directive: 'new authority', holder: 'silas-ops',
      requestId: 'req-provider-late-next' });
    const released = await computeSilasDigest({ ledger: h.ledger, blockersForRound: async () => ({ blockers: [], note: null }),
      config: DEFAULT_SILAS_CONFIG, trigger: 'sweep' });
    expect(released.providerRecoveryPending).toEqual([]);
    const freshOwned = await claim();
    expect(freshOwned.outcome === 'skipped' ? freshOwned.why : '').toContain('fresh producer');
    expect(h.ledger.getProviderWait('wait-late')?.status).toBe('recovered-pending');
    h.ledger.failDirective({ requestId: 'req-provider-late-next', reason: 'fixture no-effect proof' });
    const oldPrompt = await claim();
    expect(oldPrompt.outcome === 'skipped' ? oldPrompt.why : '').toContain('predates');
    const settledDigest = await computeSilasDigest({ ledger: h.ledger, blockersForRound: async () => ({ blockers: [], note: null }),
      config: DEFAULT_SILAS_CONFIG, trigger: 'sweep' });
    expect(settledDigest.providerRecoveryPending).toEqual([]);
    expect(h.ledger.getProviderWait('wait-late')?.status).toBe('recovered-pending');
    expect(h.spawns).toEqual([]);
    expect(h.ledger.listOpenProviderWaitsForJob('job-provider-late')).toEqual([]);
    const oldWait = h.ledger.getProviderWait('wait-late')!;
    expect(h.ledger.providerWaitRetirementIdentity(oldWait)).toBe('superseded');
    const latest = h.ledger.latestJobEvent.bind(h.ledger);
    const missingHandoff = vi.spyOn(h.ledger, 'latestJobEvent').mockImplementation((jobId, kind) =>
      kind === 'silas.directive-recovery-handoff' ? null : latest(jobId, kind));
    expect(h.ledger.providerWaitRetirementIdentity(oldWait)).toBe('unknown');
    expect(h.ledger.listOpenProviderWaitsForJob('job-provider-late').map((wait) => wait.id)).toEqual(['wait-late']);
    expect((await claim()).outcome).toBe('skipped');
    missingHandoff.mockRestore();

    // A genuinely NEW wait is ordered after the accepted handoff. Even a
    // regressed wall clock is irrelevant; authority is the durable sequence.
    h.ledger.recordProviderWait({ ...oldWait, id: 'wait-fresh-after-handoff', incidentId: 'incident-fresh', incidentGeneration: 2 });
    h.db.handle.prepare('UPDATE provider_waits SET created_at = ? WHERE id = ?')
      .run('1970-01-01T00:00:00.000Z', 'wait-fresh-after-handoff');
    h.ledger.commitProviderRecoveryBatch({ id: 'batch-fresh-after-handoff', routeKey: 'route-late', incidentGenerations: [2],
      evidence: { stopReason: 'stop' }, waiters: [{ id: 'wait-fresh-after-handoff', jobId: 'job-provider-late' }] });
    const freshWait = h.ledger.getProviderWait('wait-fresh-after-handoff')!;
    expect(h.ledger.providerWaitRetirementIdentity(freshWait)).toBe('current');
    const prompt = vi.fn();
    const continued = await claimProviderRecoveryContinuation({ ledger: h.ledger, worktrees: h.worktrees,
      registry: { getHandle: () => null, disposeHandle: async () => {}, spawn: async () => ({
        id: 'fresh-provider-after-handoff', role: 'minion', sessionFile: null, capabilities: FAKE_CAPABILITIES,
        prompt: async (text: string) => { prompt(text); }, steer: async () => {}, followUp: async () => {},
        subscribe: () => () => {}, health: () => ({ state: 'idle', lastActivity: null, sessionFile: null }), dispose: async () => {},
      }) } }, freshWait.id, 'silas');
    expect(continued.outcome).toBe('continued');
    expect(prompt).toHaveBeenCalledOnce();
    expect(h.ledger.getProviderWait('wait-late')?.status).toBe('recovered-pending');
    h.ledger.setAgentState('fresh-provider-after-handoff', 'disposed');
    h.ledger.beginDirectiveIntent({ jobId: 'job-provider-late', directive: 'later interrupted turn', holder: 'silas-ops',
      requestId: 'req-provider-late-later' });
    expect((await retire(h, 'req-provider-late-later', laneHead(lane))).status).toBe(200);
  });

  it('fails loudly when retired audit facts or expectation state are inconsistent', async () => {
    const repo = makeFixtureRepo('retire-inconsistent');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-inconsistent', 'req-inconsistent');
    expect((await retire(h, 'req-inconsistent', laneHead(lane))).status).toBe(200);
    h.db.handle.prepare('UPDATE pending_directives SET retire_reason = NULL WHERE request_id = ?').run('req-inconsistent');
    expect(() => h.ledger.listDirectiveRecoveryHolds({ jobId: 'job-inconsistent' })).toThrow(/missing its audit facts/u);
    h.db.handle.prepare('UPDATE pending_directives SET retire_expected_state = ? WHERE request_id = ?')
      .run('teleported', 'req-inconsistent');
    expect(() => h.ledger.getDirective('req-inconsistent')).toThrow(/retirement expected state/u);
  });

  it('shows the open hold in the board next action', async () => {
    const repo = makeFixtureRepo('retire-board');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-aa', 'req-aa');
    expect((await retire(h, 'req-aa', laneHead(lane))).status).toBe(200);
    const engine = new BoardEngine({ ledger: h.ledger, bus: new EventBus({}) });
    expect(engine.snapshot().silas.nextAction).toContain('req-aa');
    expect(engine.snapshot().silas.nextAction).toContain('retired');
  });

  it('keeps boot and tick reconcilers away from retired rows and leaves live rows escalated', async () => {
    const repo = makeFixtureRepo('retire-reconcile');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-ab', 'req-ab');
    expect((await retire(h, 'req-ab', laneHead(lane))).status).toBe(200);
    seedJob(h, 'job-ac');
    await seedLane(h, repo, 'job-ac');
    h.ledger.beginDirectiveIntent({ jobId: 'job-ac', directive: 'still live', holder: 'silas-ops', requestId: 'req-ac' });

    const bootPass = reconcilePendingDirectives({ ledger: h.ledger, notifications: h.notifications });
    expect(bootPass.examined).toBe(1);
    expect(bootPass.completed).toBe(0);
    expect(bootPass.escalated).toBe(1);
    expect(h.ledger.getDirective('req-ab')?.state).toBe('retired');
    const tick = settleDirectivesFromEvidence({ ledger: h.ledger });
    expect(tick.examined).toBe(1);
    expect(tick.completed).toBe(0);
  });

  it('never silently resumes work and refuses the retired lane to a forced caller', async () => {
    const repo = makeFixtureRepo('retire-noforce');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-ad', 'req-ad');
    // A live producer keeps the lane occupied; a force flag cannot change it.
    h.ledger.registerAgent({ id: 'minion-ad', role: 'minion', jobId: 'job-ad' });
    h.ledger.setAgentState('minion-ad', 'streaming');
    const forced = await retire(h, 'req-ad', laneHead(lane), { force: true });
    expect(forced.status).toBe(409);
    expect(field<string>(forced.json, 'error')).toBe('live_work');
    expect(h.spawns).toHaveLength(0);
    expect(countEvents(h, 'silas.directive-retired')).toBe(0);
  });

  it('does not revive a terminal job and preserves owner decisions', async () => {
    const repo = makeFixtureRepo('retire-terminal-job');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-ae', 'req-ae');
    h.ledger.recordDecision({
      subject: 'job:job-ae',
      decision: 'hold',
      covers: ['main-integration'],
      reason: 'owner stop holds until the owner says otherwise',
      by: 'owner',
    });
    h.ledger.setJobStatus('job-ae', 'binned');
    const result = await retire(h, 'req-ae', laneHead(lane));
    expect(result.status).toBe(200);
    expect(h.ledger.getJob('job-ae')?.status).toBe('binned');
    // A hold on a terminal job is inert and is never projected as board
    // debt (terminal lanes can never accept the releasing request).
    expect(h.ledger.hasOpenDirectiveRecoveryHold('job-ae')).toBe(true);
    const engine = new BoardEngine({ ledger: h.ledger, bus: new EventBus({}) });
    expect(engine.snapshot().silas.nextAction ?? '').not.toContain('req-ae');

    // A newer live-lane hold is still surfaced: the inert terminal hold
    // never masks it.
    const repoB = makeFixtureRepo('retire-terminal-job-b');
    cleanupRepos.push(repoB);
    const { lane: laneB } = await seededLiveRequest(h, repoB, 'job-ag', 'req-ag');
    expect((await retire(h, 'req-ag', laneHead(laneB))).status).toBe(200);
    expect(engine.snapshot().silas.nextAction ?? '').toContain('req-ag');

    // Terminal-job guard preserved: no fresh directive to a binned lane.
    const refusedDirective = await call(
      h.port,
      'POST',
      '/api/silas/directive',
      { job_id: 'job-ae', directive: 'resume', request_id: 'req-ae-next' },
      TOKEN,
    );
    expect(refusedDirective.status).toBe(400);
    expect(String(field<string>(refusedDirective.json, 'detail'))).toContain('terminal');
    // Owner stop untouched.
    const decisions = h.ledger.listDecisions({ subject: 'job:job-ae', activeOnly: true });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.clearedAt).toBeNull();
  });

  it('refuses held review jobs with force, a foreign target, or both', async () => {
    const repo = makeFixtureRepo('retire-review-escape');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-review-escape', 'req-review-escape');
    h.ledger.setJobStatus('job-review-escape', 'delivered');
    h.ledger.setJobPr('job-review-escape', 'https://github.com/example/fixture/pull/1');
    expect((await retire(h, 'req-review-escape', laneHead(lane))).status).toBe(200);
    for (const extra of [{ force: true }, { target_ref: 'gru/unrelated' }, { force: true, target_ref: 'gru/unrelated' }]) {
      const result = await call(h.port, 'POST', '/api/dispatch/review', { job_id: 'job-review-escape', ...extra }, TOKEN);
      expect(result.status).toBe(409);
      expect(field<string>(result.json, 'error')).toBe('branch_busy');
    }
    expect(h.ledger.listRounds('job-review-escape')).toEqual([]);
    expect(h.spawns).toEqual([]);
    expect(countEvents(h, 'branch-idle.forced')).toBe(0);
    expect(countEvents(h, 'silas.directive-retired')).toBe(1);
  });

  it('refuses pending supervisor ownership even with an idle durable agent', async () => {
    const repo = makeFixtureRepo('retire-supervisor-pending');
    cleanupRepos.push(repo);
    let pending: 'active' | 'unreadable' | 'ceased' = 'active';
    const h = await boot({ pendingProducerBlockers: (jobId) => {
      if (pending === 'unreadable') throw new Error('supervision unavailable');
      return pending === 'active' ? [`supervised producer: ${jobId}`] : [];
    } });
    const { lane } = await seededLiveRequest(h, repo, 'job-supervisor-pending', 'req-supervisor-pending');
    h.ledger.registerAgent({ id: 'idle-supervised', role: 'minion', jobId: 'job-supervisor-pending' });
    h.ledger.setAgentState('idle-supervised', 'idle');
    const before = eventKinds(h);
    const result = await retire(h, 'req-supervisor-pending', laneHead(lane));
    expect(result.status).toBe(409);
    expect(field<string>(result.json, 'error')).toBe('live_work');
    expect((field<string[]>(result.json, 'blockers') ?? []).join(' ')).toContain('supervised producer');
    expect(eventKinds(h)).toEqual(before);
    expect(h.ledger.getDirective('req-supervisor-pending')?.state).toBe('dispatching');
    pending = 'unreadable';
    const unknown = await retire(h, 'req-supervisor-pending', laneHead(lane));
    expect(unknown.status).toBe(409);
    expect(field<string>(unknown.json, 'error')).toBe('live_work');
    expect(eventKinds(h)).toEqual(before);
    pending = 'ceased';
    expect((await retire(h, 'req-supervisor-pending', laneHead(lane))).status).toBe(200);
  });

  it('refuses agent-ID-keyed paced retries for the job', async () => {
    const repo = makeFixtureRepo('retire-agent-paced');
    cleanupRepos.push(repo);
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 1 });
    const lease = await gate.acquireWorkerTurn({ id: 'other-job', label: 'other-job', jobId: 'other-job' });
    const abort = new AbortController();
    const queued = gate.acquireWorkerTurn({ id: 'paced-agent', label: 'rate-limit retry', agentId: 'paced-agent', jobId: 'job-agent-paced', signal: abort.signal });
    const observed = queued.catch(() => null);
    const h = await boot({ workerGate: gate });
    try {
      const { lane } = await seededLiveRequest(h, repo, 'job-agent-paced', 'req-agent-paced');
      h.ledger.registerAgent({ id: 'paced-agent', role: 'minion', jobId: 'job-agent-paced' });
      const result = await retire(h, 'req-agent-paced', laneHead(lane));
      expect(result.status).toBe(409);
      expect(field<string>(result.json, 'error')).toBe('live_work');
      expect((field<string[]>(result.json, 'blockers') ?? []).join(' ')).toContain('queued worker turn');
      expect(countEvents(h, 'silas.directive-retired')).toBe(0);
    } finally {
      abort.abort();
      lease.release();
      await observed;
    }
  });

  it('refuses an admitted row whose bound minion disagrees with its sent receipt', async () => {
    const repo = makeFixtureRepo('retire-admission-mismatch');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-admission-mismatch', 'req-admission-mismatch');
    markHistoricalDirectiveFixture(h.ledger, 'req-admission-mismatch');
    const sent = h.ledger.appendCustomEvent({ kind: 'silas.directive-sent', jobId: 'job-admission-mismatch',
      payload: { request_id: 'req-admission-mismatch', minion_id: 'actual-minion' } });
    const accepted = h.ledger.getDirective('req-admission-mismatch');
    const beforeAdmission = eventKinds(h);
    expect(() => h.ledger.recordDirectiveAdmission({ requestId: 'req-admission-mismatch', eventSeq: sent.seq, minionId: 'different-minion' }))
      .toThrow('directive admission minion identity mismatch');
    expect(h.ledger.getDirective('req-admission-mismatch')).toEqual(accepted);
    expect(eventKinds(h)).toEqual(beforeAdmission);
    h.ledger.recordDirectiveAdmission({ requestId: 'req-admission-mismatch', eventSeq: sent.seq, minionId: 'actual-minion' });
    // Isolated historical corruption exercises retirement's separate guard;
    // the public admission API correctly cannot construct this mismatch.
    h.db.handle.prepare('UPDATE pending_directives SET admission_minion = ? WHERE request_id = ?')
      .run('different-minion', 'req-admission-mismatch');
    const before = eventKinds(h);
    const result = await retire(h, 'req-admission-mismatch', laneHead(lane));
    expect(result.status).toBe(409);
    expect(field<string>(result.json, 'error')).toBe('admission_evidence_incomplete');
    expect(eventKinds(h)).toEqual(before);
    expect(h.ledger.getDirective('req-admission-mismatch')?.state).toBe('admitted');
  });

  it('returns typed lane_unavailable when the registry itself throws', async () => {
    const repo = makeFixtureRepo('retire-registry-unreadable');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-registry-unreadable', 'req-registry-unreadable');
    const head = laneHead(lane);
    const before = eventKinds(h);
    vi.spyOn(h.worktrees, 'listWorktrees').mockImplementation(() => { throw new Error('registry inaccessible'); });
    const result = await retire(h, 'req-registry-unreadable', head);
    expect(result.status).toBe(409);
    expect(field<string>(result.json, 'error')).toBe('lane_unavailable');
    expect(eventKinds(h)).toEqual(before);
    expect(h.ledger.getDirective('req-registry-unreadable')?.state).toBe('dispatching');
  });

  it('keeps unproven claimed waits fenced but permits retirement after a genuine terminal receipt', async () => {
    const repo = makeFixtureRepo('retire-historical-claim');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-historical-claim', 'req-historical-claim');
    h.ledger.recordProviderWait({ id: 'wait-historical', routeKey: 'route-historical', provider: 'p', model: 'm', endpoint: 'e',
      credentialFingerprint: 'fp', waiterKind: 'job-minion', jobId: 'job-historical-claim', agentId: null, slotId: null,
      sessionFile: null, continuation: null, jobStatusAtEstablishment: 'working', lineageKey: null,
      incidentId: 'incident-historical', incidentGeneration: 1, reasonClass: 'temporary-limit' });
    h.ledger.commitProviderRecoveryBatch({ id: 'batch-historical', routeKey: 'route-historical', incidentGenerations: [1],
      evidence: { stopReason: 'stop' }, waiters: [{ id: 'wait-historical', jobId: 'job-historical-claim' }] });
    expect(h.ledger.claimProviderWaitAtomic('wait-historical', { by: 'silas' })).toBe(true);
    expect((await retire(h, 'req-historical-claim', laneHead(lane))).status).toBe(409);
    h.ledger.appendCustomEvent({ kind: 'provider.continuation-completed', jobId: 'job-historical-claim', payload: { wait_id: 'some-other-wait' } });
    expect((await retire(h, 'req-historical-claim', laneHead(lane))).status).toBe(409);
    h.ledger.appendCustomEvent({ kind: 'provider.continuation-completed', jobId: 'job-historical-claim', payload: { wait_id: 'wait-historical' } });
    expect((await retire(h, 'req-historical-claim', laneHead(lane))).status).toBe(200);
    expect(h.ledger.getProviderWait('wait-historical')?.status).toBe('claimed');
    expect(countEvents(h, 'job.delivered')).toBe(0);
  });

  it('isolates malformed retired audit debt without hiding a healthy board hold', async () => {
    const repo = makeFixtureRepo('retire-board-damaged');
    cleanupRepos.push(repo);
    const h = await boot();
    const bad = await seededLiveRequest(h, repo, 'job-board-bad', 'req-board-bad');
    expect((await retire(h, 'req-board-bad', laneHead(bad.lane))).status).toBe(200);
    const good = await seededLiveRequest(h, repo, 'job-board-good', 'req-board-good');
    expect((await retire(h, 'req-board-good', laneHead(good.lane))).status).toBe(200);
    h.db.handle.prepare('UPDATE pending_directives SET retire_reason = NULL WHERE request_id = ?').run('req-board-bad');
    const log = vi.fn();
    const engine = new BoardEngine({ ledger: h.ledger, bus: new EventBus({}), log });
    expect(engine.snapshot().silas.nextAction).toContain('req-board-good');
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('audit is inconsistent'), expect.objectContaining({ requestId: 'req-board-bad' }));
    expect(() => h.ledger.listDirectiveRecoveryHolds()).toThrow(/missing its audit facts/u);
    expect(h.ledger.hasOpenDirectiveRecoveryHold('job-board-bad')).toBe(true);
  });

  it('rechecks fresh producer ownership when retirement and acceptance both occur during a digest await', async () => {
    const repo = makeFixtureRepo('retire-fresh-owner-race');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-fresh-owner-race', 'req-fresh-owner-race');
    h.ledger.setJobStatus('job-fresh-owner-race', 'in-review');
    const round = h.ledger.addRound({ jobId: 'job-fresh-owner-race', lenses: ['blind'] });
    h.ledger.setRoundStatus(round.id, 'live');
    h.ledger.setRoundVerdict(round.id, 'changes-requested');
    let raced = false;
    const digest = await computeSilasDigest({ ledger: h.ledger, blockersForRound: async () => {
      raced = true;
      expect((await retire(h, 'req-fresh-owner-race', laneHead(lane))).status).toBe(200);
      h.ledger.beginDirectiveIntent({ jobId: 'job-fresh-owner-race', directive: 'fresh owner', holder: 'silas-ops', requestId: 'req-fresh-owner-race-next' });
      return { blockers: [], note: null };
    }, config: DEFAULT_SILAS_CONFIG, trigger: 'sweep' });
    expect(raced).toBe(true);
    expect(h.ledger.hasOpenDirectiveRecoveryHold('job-fresh-owner-race')).toBe(false);
    expect(h.ledger.getDirective('req-fresh-owner-race-next')?.state).toBe('dispatching');
    expect(digest.verdictsAwaitingDirective).toEqual([]);
    expect(digest.providerRecoveryPending).toEqual([]);
    expect(h.spawns).toEqual([]);
  });

  it('refuses fresh directive and re-brief acceptance while a provider observation is pending', async () => {
    const repo = makeFixtureRepo('provider-observation-exclusive');
    cleanupRepos.push(repo);
    const h = await boot();
    const jobId = 'job-observation-exclusive';
    const { lane } = await seededLiveRequest(h, repo, jobId, 'req-observation-old');
    expect((await retire(h, 'req-observation-old', laneHead(lane))).status).toBe(200);
    h.ledger.beginDirectiveIntent({ jobId, directive: 'first authority', holder: 'silas-ops', requestId: 'req-observation-first' });
    h.ledger.failDirective({ requestId: 'req-observation-first', reason: 'fixture no-effect proof' });
    let finish!: (route: { endpoint: string; credentialFingerprint: string }) => void;
    const route = new Promise<{ endpoint: string; credentialFingerprint: string }>((resolve) => { finish = resolve; });
    const sensor = new ProviderRecoverySensor({ config: { ...DEFAULT_PROVIDER_RECOVERY_CONFIG, enabled: true, glmGenerationFallback: true },
      ledger: h.ledger, notifications: h.notifications, wake: { trigger: async () => {} }, silasHosted: () => true,
      probe: { resolveRoute: () => route, probe: async () => { throw new Error('must not probe'); } } });
    const pending = establishProviderWait(sensor, { agentId: 'observation-exclusive-agent', role: 'minion', slotId: null, jobId,
      sessionFile: null, failureClass: 'quota_wall', provider: 'zai-coding-cn', model: 'glm-5.3',
      typed: { origin: 'provider-message', status: 429, bodyCode: '1302' }, errorMessage: '429 usage window limit', incidentId: null,
      continuation: { promptText: 'older saved prompt', promptOwner: 'minion-brief', hadOpenTurn: true } });
    let wait: Awaited<typeof pending> = null;
    try {
      const before = eventKinds(h);
      expect(() => h.ledger.beginDirectiveIntent({ jobId, directive: 'newer authority', holder: 'silas-ops', requestId: 'req-observation-next' })).toThrow(/provider ownership/u);
      expect(() => h.ledger.beginPendingRebrief({ jobId, note: 'newer authority', briefing: null })).toThrow(/provider ownership/u);
      expect(h.ledger.getDirective('req-observation-next')).toBeNull();
      expect(h.ledger.listPendingRebriefs({ jobId })).toEqual([]);
      expect(eventKinds(h)).toEqual(before);
    } finally {
      finish({ endpoint: 'https://fixture.invalid', credentialFingerprint: 'fp' });
      wait = await pending;
      sensor.stop();
    }
    expect(wait).not.toBeNull();
    const unchanged = h.ledger.getProviderWait(wait!.id);
    h.ledger.beginDirectiveIntent({ jobId, directive: 'newer authority', holder: 'silas-ops', requestId: 'req-observation-next' });
    expect(h.ledger.providerWaitRetirementIdentity(wait!)).toBe('superseded');
    expect(h.ledger.getProviderWait(wait!.id)).toEqual(unchanged);
  });

  it('fences a real pending provider-wall route lookup before any wait is recorded', async () => {
    const repo = makeFixtureRepo('retire-pending-observation');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-pending-observation', 'req-pending-observation');
    h.ledger.registerAgent({ id: 'stopped-observation-agent', role: 'minion', jobId: 'job-pending-observation' });
    h.ledger.setAgentState('stopped-observation-agent', 'error');
    let resolveRoute!: (route: { endpoint: string; credentialFingerprint: string }) => void;
    const route = new Promise<{ endpoint: string; credentialFingerprint: string }>((resolve) => { resolveRoute = resolve; });
    const sensor = new ProviderRecoverySensor({ config: { ...DEFAULT_PROVIDER_RECOVERY_CONFIG, enabled: true, glmGenerationFallback: true },
      ledger: h.ledger, notifications: h.notifications, wake: { trigger: async () => {} }, silasHosted: () => true,
      probe: { resolveRoute: () => route, probe: async () => { throw new Error('must not probe'); } } });
    const pending = establishProviderWait(sensor, { agentId: 'stopped-observation-agent', role: 'minion', slotId: null,
      jobId: 'job-pending-observation', sessionFile: null, failureClass: 'quota_wall', provider: 'zai-coding-cn', model: 'glm-5.3',
      typed: { origin: 'provider-message', status: 429, bodyCode: '1302' }, errorMessage: '429 usage window limit', incidentId: null,
      continuation: { promptText: 'old interrupted prompt', promptOwner: 'minion-brief', hadOpenTurn: true } });
    let wait: Awaited<typeof pending> = null;
    try {
      expect(h.ledger.listProviderWaits()).toEqual([]);
      const before = eventKinds(h);
      const result = await retire(h, 'req-pending-observation', laneHead(lane));
      expect(result.status).toBe(409);
      expect(field<string>(result.json, 'error')).toBe('live_work');
      expect((field<string[]>(result.json, 'blockers') ?? []).join(' ')).toContain('provider wait establishment');
      expect(eventKinds(h)).toEqual(before);
    } finally {
      resolveRoute({ endpoint: 'https://fixture.invalid', credentialFingerprint: 'fixture-fingerprint' });
      wait = await pending;
      sensor.stop();
    }
    expect(wait).not.toBeNull();
    expect(h.ledger.listJobAdmissions('job-pending-observation')).toEqual([]);
    h.ledger.setProviderWaitStatus(wait!.id, 'cancelled', { why: 'fixture writer ceased; no continuation' });
    expect((await retire(h, 'req-pending-observation', laneHead(lane))).status).toBe(200);
  });

  it('retracts the old verdict when a fresh accepted directive fully settles during the await', async () => {
    const repo = makeFixtureRepo('retire-settled-owner-race');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-settled-owner-race', 'req-settled-owner-race');
    h.ledger.setJobStatus('job-settled-owner-race', 'in-review');
    const round = h.ledger.addRound({ jobId: 'job-settled-owner-race', lenses: ['blind'] });
    h.ledger.setRoundStatus(round.id, 'live');
    h.ledger.setRoundVerdict(round.id, 'changes-requested');
    const digest = await computeSilasDigest({ ledger: h.ledger, blockersForRound: async () => {
      expect((await retire(h, 'req-settled-owner-race', laneHead(lane))).status).toBe(200);
      h.ledger.beginDirectiveIntent({ jobId: 'job-settled-owner-race', directive: 'fresh repair', holder: 'silas-ops', requestId: 'req-settled-owner-next' });
      admitNativeDirectiveFixture(h.ledger, 'req-settled-owner-next', 'fresh-settled-minion', join(h.dir, 'fresh-settled-minion.jsonl'));
      const delivered = h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-settled-owner-race',
        payload: { request_id: 'req-settled-owner-next', minion_id: 'fresh-settled-minion', agentId: 'fresh-settled-minion', work_revision: h.ledger.getDirective('req-settled-owner-next')!.workRevision, sha: laneHead(lane) } });
      h.ledger.recordDirectiveDelivery({ requestId: 'req-settled-owner-next', eventSeq: delivered.seq });
      return { blockers: [], note: null };
    }, config: DEFAULT_SILAS_CONFIG, trigger: 'sweep' });
    expect(h.ledger.getDirective('req-settled-owner-next')?.state).toBe('settled');
    expect(h.ledger.hasOpenDirectiveRecoveryHold('job-settled-owner-race')).toBe(false);
    expect(digest.verdictsAwaitingDirective).toEqual([]);
  });

  it('keeps terminal holds inert while cancelling terminal provider debt and closing its wake batch', async () => {
    const repo = makeFixtureRepo('retire-terminal-provider-debt');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-terminal-provider', 'req-terminal-provider');
    h.ledger.setJobStatus('job-terminal-provider', 'binned');
    expect((await retire(h, 'req-terminal-provider', laneHead(lane))).status).toBe(200);
    h.ledger.recordProviderWait({ id: 'wait-terminal-provider', routeKey: 'route-terminal-provider', provider: 'p', model: 'm', endpoint: 'e',
      credentialFingerprint: 'fp', waiterKind: 'job-minion', jobId: 'job-terminal-provider', agentId: null, slotId: null,
      sessionFile: null, continuation: null, jobStatusAtEstablishment: 'working', lineageKey: null,
      incidentId: 'incident-terminal-provider', incidentGeneration: 1, reasonClass: 'temporary-limit' });
    h.ledger.commitProviderRecoveryBatch({ id: 'batch-terminal-provider', routeKey: 'route-terminal-provider', incidentGenerations: [1],
      evidence: { stopReason: 'stop' }, waiters: [{ id: 'wait-terminal-provider', jobId: 'job-terminal-provider' }] });
    const result = await claimProviderRecoveryContinuation({ ledger: h.ledger, worktrees: h.worktrees,
      registry: { getHandle: () => null, disposeHandle: async () => {}, spawn: async () => { throw new Error('must not spawn'); } } },
      'wait-terminal-provider', 'silas');
    expect(result.outcome).toBe('skipped');
    expect(h.ledger.getProviderWait('wait-terminal-provider')?.status).toBe('cancelled');
    const wake = vi.fn();
    const sensor = new ProviderRecoverySensor({ config: { ...DEFAULT_PROVIDER_RECOVERY_CONFIG, enabled: true },
      ledger: h.ledger, notifications: h.notifications, wake: { trigger: async () => { wake(); } }, silasHosted: () => true,
      probe: { resolveRoute: async () => null, probe: async () => { throw new Error('must not probe'); } } });
    expect(await sensor.reconcileAtBoot()).toEqual({ rewoken: 0 });
    sensor.stop();
    expect(h.ledger.listPendingProviderRecoveries()).toEqual([]);
    expect(wake).not.toHaveBeenCalled();
    expect(h.ledger.getJob('job-terminal-provider')?.status).toBe('binned');
    expect(h.ledger.hasOpenDirectiveRecoveryHold('job-terminal-provider')).toBe(true);
  });

  it('fences fresh acceptance during spawn and preserves owner holds plus unknown cleanup ownership', async () => {
    const repo = makeFixtureRepo('retire-claim-authority-race');
    cleanupRepos.push(repo);
    for (const cleanupFails of [false, true]) {
      const h = await boot();
      const jobId = `job-claim-authority-${cleanupFails}`;
      const oldId = `req-claim-authority-${cleanupFails}`;
      const { lane } = await seededLiveRequest(h, repo, jobId, oldId);
      expect((await retire(h, oldId, laneHead(lane))).status).toBe(200);
      h.ledger.beginDirectiveIntent({ jobId, directive: 'first fresh authority', holder: 'silas-ops', requestId: `${oldId}-first` });
      h.ledger.failDirective({ requestId: `${oldId}-first`, reason: 'fixture no-effect proof' });
      const waitId = `wait-claim-authority-${cleanupFails}`;
      h.ledger.recordProviderWait({ id: waitId, routeKey: 'route-claim-authority', provider: 'p', model: 'm', endpoint: 'e',
        credentialFingerprint: 'fp', waiterKind: 'job-minion', jobId, agentId: null, slotId: null,
        sessionFile: null, continuation: { promptText: 'saved older prompt', promptOwner: 'old-owner', hadOpenTurn: true },
        jobStatusAtEstablishment: 'working', lineageKey: null, incidentId: waitId, incidentGeneration: 1, reasonClass: 'temporary-limit' });
      h.ledger.commitProviderRecoveryBatch({ id: 'batch-claim-authority', routeKey: 'route-claim-authority', incidentGenerations: [1],
        evidence: { stopReason: 'stop' }, waiters: [{ id: waitId, jobId }] });
      let started!: () => void;
      const spawning = new Promise<void>((resolve) => { started = resolve; });
      let finishSpawn!: (handle: AgentHandle) => void;
      const spawn = new Promise<AgentHandle>((resolve) => { finishSpawn = resolve; });
      const prompt = vi.fn();
      const dispose = vi.fn(async () => { if (cleanupFails) throw new Error('fixture disposal unavailable'); });
      const pending = claimProviderRecoveryContinuation({ ledger: h.ledger, worktrees: h.worktrees,
        registry: { getHandle: () => null, disposeHandle: async () => {}, spawn: async () => { started(); return spawn; } } }, waitId, 'silas');
      await spawning;
      const nextId = `${oldId}-next`;
      expect(() => h.ledger.beginDirectiveIntent({ jobId, directive: 'newer authority', holder: 'silas-ops', requestId: nextId })).toThrow(/provider ownership/u);
      expect(() => h.ledger.beginPendingRebrief({ jobId, note: 'newer authority', briefing: null })).toThrow(/provider ownership/u);
      h.ledger.setJobStatus(jobId, 'parked');
      finishSpawn({ id: 'superseded-returned-minion', role: 'minion', sessionFile: null, capabilities: FAKE_CAPABILITIES,
        prompt: async (text) => { prompt(text); }, steer: async () => {}, followUp: async () => {}, subscribe: () => () => {},
        health: () => ({ state: 'idle', lastActivity: null, sessionFile: null }), dispose });
      const result = await pending;
      expect(result.outcome).toBe('skipped');
      expect(prompt).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
      expect(h.ledger.getJob(jobId)?.status).toBe('parked');
      expect(h.ledger.getDirective(nextId)).toBeNull();
      expect(countEvents(h, 'job.minion-error')).toBe(0);
      expect(h.ledger.getProviderWait(waitId)?.status).toBe('claimed');
      if (cleanupFails) {
        expect(h.ledger.listJobAdmissions(jobId)).toContain(`provider continuation ${waitId}`);
        expect(h.ledger.listOpenProviderWaitsForJob(jobId).map((wait) => wait.id)).toContain(waitId);
        expect(() => h.ledger.beginDirectiveIntent({ jobId, directive: 'newer authority', holder: 'silas-ops', requestId: nextId })).toThrow(/provider ownership/u);
      } else {
        expect(h.ledger.listJobAdmissions(jobId)).toEqual([]);
        expect(h.ledger.listOpenProviderWaitsForJob(jobId)).toEqual([]);
        expect(() => h.ledger.beginDirectiveIntent({ jobId, directive: 'newer authority', holder: 'silas-ops', requestId: nextId })).not.toThrow();
      }
    }
  });

  it('refuses an HTTP H2 and a re-brief while the provider H1 prompt is actually pending', async () => {
    const repo = makeFixtureRepo('provider-prompt-exclusive');
    cleanupRepos.push(repo);
    const h = await boot();
    const jobId = 'job-provider-prompt-exclusive';
    const { lane } = await seededLiveRequest(h, repo, jobId, 'req-prompt-old');
    expect((await retire(h, 'req-prompt-old', laneHead(lane))).status).toBe(200);
    h.ledger.beginDirectiveIntent({ jobId, directive: 'first authority', holder: 'silas-ops', requestId: 'req-prompt-first' });
    h.ledger.failDirective({ requestId: 'req-prompt-first', reason: 'fixture no-effect proof' });
    h.ledger.recordProviderWait({ id: 'wait-prompt-exclusive', routeKey: 'route-prompt-exclusive', provider: 'p', model: 'm', endpoint: 'e',
      credentialFingerprint: 'fp', waiterKind: 'job-minion', jobId, agentId: null, slotId: null, sessionFile: null,
      continuation: { promptText: 'authorized H1', promptOwner: 'first-owner', hadOpenTurn: true }, jobStatusAtEstablishment: 'working',
      lineageKey: null, incidentId: 'incident-prompt-exclusive', incidentGeneration: 1, reasonClass: 'temporary-limit' });
    h.ledger.commitProviderRecoveryBatch({ id: 'batch-prompt-exclusive', routeKey: 'route-prompt-exclusive', incidentGenerations: [1],
      evidence: { stopReason: 'stop' }, waiters: [{ id: 'wait-prompt-exclusive', jobId }] });
    let finish!: () => void;
    const turn = new Promise<void>((resolve) => { finish = resolve; });
    let started!: () => void;
    const prompting = new Promise<void>((resolve) => { started = resolve; });
    const pending = claimProviderRecoveryContinuation({ ledger: h.ledger, worktrees: h.worktrees,
      registry: { getHandle: () => null, disposeHandle: async () => {}, spawn: async () => ({
        id: 'provider-prompting-minion', role: 'minion', sessionFile: null, capabilities: FAKE_CAPABILITIES,
        prompt: async () => { started(); await turn; }, steer: async () => {}, followUp: async () => {}, subscribe: () => () => {},
        health: () => ({ state: 'idle', lastActivity: null, sessionFile: null }), dispose: async () => {},
      }) } }, 'wait-prompt-exclusive', 'silas');
    await prompting;
    let result: Awaited<typeof pending> | null = null;
    try {
      const before = eventKinds(h);
      const refused = await call(h.port, 'POST', '/api/silas/directive', { job_id: jobId, directive: 'H2', request_id: 'req-prompt-h2' }, TOKEN);
      expect(refused.status).toBe(409);
      expect(JSON.stringify(refused.json)).toContain('provider ownership');
      expect(() => h.ledger.beginPendingRebrief({ jobId, note: 'H2', briefing: null })).toThrow(/provider ownership/u);
      expect(h.ledger.getDirective('req-prompt-h2')).toBeNull();
      expect(eventKinds(h)).toEqual(before);
      expect(h.spawns).toEqual([]);
    } finally {
      finish();
      result = await pending;
    }
    expect(result?.outcome).toBe('continued');
    expect(h.ledger.listJobAdmissions(jobId)).toEqual([]);
    expect((await call(h.port, 'POST', '/api/silas/directive', { job_id: jobId, directive: 'H2', request_id: 'req-prompt-h2' }, TOKEN)).status).toBe(202);
  });

  it('persists the retirement and hold across a database reopen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-retire-persist-'));
    cleanupDirs.push(dir);
    const db1 = new LedgerDb(dir);
    const api1 = new LedgerApi(db1.handle, { bus: new EventBus({}) });
    api1.addJob({ id: 'job-af', repo: 'r', title: 't', briefing: 'b' });
    api1.setJobStatus('job-af', 'working');
    api1.beginDirectiveIntent({ jobId: 'job-af', directive: 'x', holder: 'silas-ops', requestId: 'req-af' });
    const retired = api1.retireInterruptedDirective({
      requestId: 'req-af',
      expectedJobId: 'job-af',
      expectedState: 'dispatching',
      expectedPayloadHash: api1.getDirective('req-af')!.payloadHash,
      expectedHead: 'a'.repeat(40),
      lane: { id: 'lane-af', resolvedHead: 'a'.repeat(40) },
      reason: 'ceased',
      by: 'silas-ops',
    });
    expect(retired.record.state).toBe('retired');
    db1.close();

    const db2 = new LedgerDb(dir);
    const api2 = new LedgerApi(db2.handle, { bus: new EventBus({}) });
    const reloaded = api2.getDirective('req-af');
    expect(reloaded?.state).toBe('retired');
    expect(reloaded?.retiredBy).toBe('silas-ops');
    expect(reloaded?.retireReason).toBe('ceased');
    expect(reloaded?.retireFingerprint).not.toBeNull();
    expect(api2.hasOpenDirectiveRecoveryHold('job-af')).toBe(true);
    expect(api2.listDirectiveRecoveryHolds({ jobId: 'job-af' })[0]?.admissionClass).toBe('admission-unknown');
    const replay = api2.retireInterruptedDirective({ requestId: 'req-af', expectedJobId: 'job-af',
      expectedState: reloaded!.retireExpectedState!, expectedPayloadHash: reloaded!.payloadHash,
      expectedHead: reloaded!.retireExpectedHead!, reason: reloaded!.retireReason!, by: reloaded!.retiredBy! });
    expect(replay.idempotent).toBe(true);
    expect(api2.listJobEventsByKinds('job-af', ['silas.directive-retired'])).toHaveLength(1);
    db2.close();
  });
});

describe('exact recovery reserved-owner HTTP lifecycle', () => {
  async function ownerFixture(kind: 'directives' | 'rebriefs') {
    const h = await boot(); const repo = makeFixtureRepo('recovery-owner-http'); cleanupRepos.push(repo);
    const jobId = `owner-${kind}`; seedJob(h, jobId); const lane = await seedLane(h, repo, jobId);
    const original = h.ledger.beginDirectiveIntent({ jobId, requestId: `${jobId}-original`, directive: 'approved original', holder: 'gru' }).record;
    let subjectId = original.requestId; let payloadHash = original.payloadHash;
    if (kind === 'rebriefs') {
      h.ledger.failDirective({ requestId: original.requestId, reason: 'fixture never dispatched' });
      const originals = h.ledger.beginPendingRebrief({ jobId, note: 'historical unresolved', briefing: 'original approved scope' });
      await bindOriginalRebriefSdkOwner(h.ledger, originals, { cwd: lane.path, dataDir: h.dir, agentId: 'original-owner-minion' });
      const marker = h.ledger.listPendingRebriefs({ jobId }).find((row) => row.kind === 'silas.rebrief')!;
      subjectId = marker.id; payloadHash = marker.payloadHash;
    }
    const debt = kind === 'directives' ? h.ledger.openDirectiveRecoveryDebt(subjectId, 'unknown original effects')
      : h.ledger.openRebriefRecoveryDebt(subjectId, 'unknown original effects');
    h.ledger.setJobStatus(jobId, 'parked');
    // This real job-wide owner hold governs the explicit parking event,
    // not the later routine recovery-debt suspension event.
    const governingStop = h.ledger.latestJobEvent(jobId, 'job.status')!;
    expect(governingStop.payload).toMatchObject({ to: 'parked' });
    const target = h.ledger.recordBlockedObservation(jobId, { logicalStep: 'operation', incidentKey: 'reserved-owner-budget',
      category: { kind: 'known', category: 'owner-hold' }, observedAtSeq: governingStop.seq,
      nextAction: { kind: 'owner-decision', decision: 'owner must explicitly authorize the narrow current approved continuation budget' } });
    h.ledger.suspendObligation(target.id, 'real reserved owner stop suspended while parked');
    const ownerStop = h.notifications.postIncident({ kind: `owner-budget.${jobId}`, routing: 'needs-owner', severity: 'error',
      title: 'real reserved owner budget decision', detail: 'owner action required', dedupe: 'active' });
    const route = `/api/silas/${kind}/${subjectId}`;
    const recoveryBody = (generation = debt.generation) => ({ by: 'gru', expected_generation: generation,
      expected_payload_hash: payloadHash, expected_head: laneHead(lane), expected_epoch: h.ledger.directiveRecoveryEpoch(jobId),
      expected_work_revision: h.ledger.directiveCurrentAuthority(jobId).workRevision,
      expected_contract_sha256: h.ledger.directiveCurrentAuthority(jobId).contractSha256,
      ...(kind === 'rebriefs' ? { expected_receipt_evidence_sha256: h.ledger.rebriefReceiptEvidence(subjectId).sha256 } : {}),
      reason: 'reserved owner stop governs the exact preserved recovery subject' });
    const transferBody = { ...recoveryBody(), decision: { kind: 'owner-decision', obligation_id: target.id } };
    const transferred = await call(h.port, 'POST', `${route}/recover`, transferBody, TOKEN);
    expect(transferred.status).toBe(200);
    expect(h.ledger.getObligation(debt.id)?.state).toBe('closed');
    expect(h.ledger.getObligation(target.id)?.state).toBe('suspended');
    const actionBody = async (resolutionId = 'owner-permission-one') => {
      const readback = await call(h.port, 'GET', route, undefined, TOKEN); expect(readback.status).toBe(200);
      const view = field<ReturnType<LedgerApi['recoveryOwnerReadback']>>(readback.json, 'recovery_owner');
      const transfer = view.transfer!; const subjectSha = field<string>(readback.json, 'recovery_subject_sha256');
      const authority = h.ledger.directiveCurrentAuthority(jobId);
      return { by: 'owner', confirm_intent: true, resolution_id: resolutionId, expected_transfer_event_seq: transfer.eventSeq,
        expected_transfer_fingerprint: transfer.fingerprint, expected_subject_sha256: subjectSha,
        expected_target_generation: transfer.ownerTransfer!.target.generation, expected_target_plan_revision: transfer.ownerTransfer!.target.planRevision,
        expected_lineage_sha256: view.lineageSha256, expected_epoch: authority.authorityEpoch, expected_head: laneHead(lane),
        expected_work_revision: authority.workRevision, expected_contract_sha256: authority.contractSha256,
        reason: 'explicit narrow owner permission for this exact current approved scope and recorded governing stop' };
    };
    return { h, lane, jobId, original, subjectId, payloadHash, debt, target, ownerStop, route, recoveryBody, transferBody, actionBody };
  }

  async function assertOwnerLifecycle(kind: 'directives' | 'rebriefs') {
    const f = await ownerFixture(kind); const { h } = f;
    const permissionBody = await f.actionBody();
    const permission = await call(h.port, 'POST', `${f.route}/owner-resolution`, permissionBody, TOKEN); expect(permission.status, JSON.stringify(permission.json)).toBe(200);
    const ruling = field<{ payload: { fingerprint: string } }>(permission.json, 'receipt');
    expect(h.ledger.getObligation(f.target.id)?.state).toBe('suspended'); expect(h.ledger.getJob(f.jobId)?.status).toBe('parked');
    expect(h.ledger.getNotification(f.ownerStop.id)?.ackedAt).toBeNull(); expect(h.spawns).toEqual([]);
    const confirms = { ...await f.actionBody(), expected_resolution_fingerprint: ruling.payload.fingerprint };
    const confirmed = await call(h.port, 'POST', `${f.route}/owner-resolution/confirm-stop`, confirms, TOKEN); expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
    expect(h.ledger.getObligation(f.target.id)?.state).toBe('settled'); expect(h.ledger.getObligation(f.debt.id)?.state).toBe('closed');
    expect(h.ledger.getJob(f.jobId)?.status).toBe('parked'); expect(h.ledger.getNotification(f.ownerStop.id)?.ackedAt).toBeNull();
    expect(h.spawns).toEqual([]);
    expect((await call(h.port, 'POST', `${f.route}/owner-resolution`, permissionBody, TOKEN)).json).toMatchObject({ idempotent: true });
    expect((await call(h.port, 'POST', `${f.route}/owner-resolution/confirm-stop`, confirms, TOKEN)).json).toMatchObject({ idempotent: true });
    // Separate explicit board intent; neither owner HTTP action invokes it.
    h.ledger.setJobStatus(f.jobId, 'working');
    const next = kind === 'directives' ? h.ledger.openDirectiveRecoveryDebt(f.subjectId, 'owner stop genuinely resolved')
      : h.ledger.openRebriefRecoveryDebt(f.subjectId, 'owner stop genuinely resolved');
    expect(next.id).not.toBe(f.debt.id); expect(next.state).toBe('open'); expect(next.generation).toBeGreaterThan(f.debt.generation);
    expect((await call(h.port, 'POST', `${f.route}/recover`, f.transferBody, TOKEN)).json).toMatchObject({ idempotent: true });
    const successorId = `${f.jobId}-fresh-successor`;
    const successorBody = { ...f.recoveryBody(next.generation),
      decision: { kind: 'successor', request_id: successorId, directive: 'inspect preserved artifacts; finish only current approved remaining scope' } };
    const accepted = await call(h.port, 'POST', `${f.route}/recover`, successorBody, TOKEN);
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(202);
    for (let i = 0; i < 200 && h.ledger.getDirective(successorId)?.state !== 'settled'; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.ledger.getDirective(successorId)?.state).toBe('settled'); expect(h.ledger.getObligation(next.id)?.state).toBe('settled');
    expect(h.ledger.getObligation(f.debt.id)?.state).toBe('closed'); expect(h.ledger.getNotification(f.ownerStop.id)?.ackedAt).toBeNull();
    const history = h.ledger.recoveryDecisionHistory(kind === 'directives' ? 'directive' : 'rebrief', f.subjectId);
    expect(history.map((row) => row.generation)).toEqual([f.debt.generation, next.generation]);
    expect(history[0]?.ownerTransfer?.target.id).toBe(f.target.id); expect(history[1]?.successorId).toBe(successorId);
    const spawnsBeforeReplay = h.spawns.length;
    const admissionBeforeReplay = h.ledger.getDirective(successorId)?.admissionSeq;
    expect(admissionBeforeReplay).toEqual(expect.any(Number));
    const eventsBeforeReplay = h.ledger.listJobEventsByKinds(f.jobId, ['silas.directive-sent', 'job.delivered']);
    const replay = await call(h.port, 'POST', `${f.route}/recover`, successorBody, TOKEN);
    expect(replay.status, JSON.stringify(replay.json)).toBe(200);
    expect(replay.json).toMatchObject({ idempotent: true, successor_request_id: successorId });
    expect(h.spawns).toHaveLength(spawnsBeforeReplay);
    expect(h.ledger.getDirective(successorId)?.admissionSeq).toBe(admissionBeforeReplay);
    expect(h.ledger.listJobEventsByKinds(f.jobId, ['silas.directive-sent', 'job.delivered'])).toEqual(eventsBeforeReplay);
    expect(h.ledger.recoveryDecisionHistory(kind === 'directives' ? 'directive' : 'rebrief', f.subjectId)).toEqual(history);
    expect(h.ledger.getObligation(next.id)?.state).toBe('settled'); expect(h.ledger.getObligation(f.debt.id)?.state).toBe('closed');
    expect(h.ledger.getNotification(f.ownerStop.id)?.ackedAt).toBeNull();
    expect((await call(h.port, 'POST', `${f.route}/recover`, f.transferBody, TOKEN)).json).toMatchObject({ idempotent: true });
    expect(h.ledger.getDirective(f.original.requestId)).toMatchObject({ workRevision: f.original.workRevision,
      authorityEpoch: f.original.authorityEpoch, contractSha256: f.original.contractSha256, contractSnapshot: f.original.contractSnapshot });
  }

  async function assertLiveOwnerConfirmation(state: 'open' | 'waiting') {
    const f = await ownerFixture('directives'); const { h } = f;
    h.ledger.resumeObligation(f.target.id, 'explicit fixture owner resumed this exact stop');
    if (state === 'waiting') h.ledger.armReceiptExpectation({ obligationId: f.target.id, receiptKind: 'owner.confirmed', deadlineAt: new Date(Date.now() + 60000).toISOString() });
    const permission = await call(h.port, 'POST', `${f.route}/owner-resolution`, await f.actionBody(), TOKEN); expect(permission.status).toBe(200);
    const ruling = field<{ payload: { fingerprint: string } }>(permission.json, 'receipt');
    const before = h.ledger.latestEventSeq();
    const confirmed = await call(h.port, 'POST', `${f.route}/owner-resolution/confirm-stop`, { ...await f.actionBody(), expected_resolution_fingerprint: ruling.payload.fingerprint }, TOKEN);
    expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200); expect(h.ledger.getObligation(f.target.id)?.state).toBe('settled');
    expect(h.ledger.listJobEventsByKinds(f.jobId, ['job.obligation-state']).filter((event) => event.seq > before)).toEqual([]);
    expect(h.ledger.getJob(f.jobId)?.status).toBe('parked'); expect(h.ledger.getNotification(f.ownerStop.id)?.ackedAt).toBeNull(); expect(h.spawns).toEqual([]);
  }
  it('explicit confirmation settles the exact open owner target without an artificial resume', () => assertLiveOwnerConfirmation('open'));
  it('explicit confirmation settles the exact waiting owner target without an artificial resume', () => assertLiveOwnerConfirmation('waiting'));

  it('native suspended owner transfer records permission, confirms only its stop, then separately accepts one fresh-generation successor', async () => {
    await assertOwnerLifecycle('directives');
  });
  it('legacy suspended owner transfer retains evidence/history, records permission and separately hands off one current successor', async () => {
    await assertOwnerLifecycle('rebriefs');
  });

  it('owner HTTP writers reject non-owner attribution, missing explicit intent, stale ruling/scope and authority without touching stops or work', async () => {
    const f = await ownerFixture('directives'); const body = await f.actionBody(); const { h } = f;
    expect((await call(h.port, 'POST', `${f.route}/owner-resolution`, body)).status).toBe(401);
    expect((await call(h.port, 'POST', `${f.route}/owner-resolution`, { ...body, by: 'gru' }, TOKEN)).status).toBe(400);
    expect((await call(h.port, 'POST', `${f.route}/owner-resolution`, { ...body, confirm_intent: false }, TOKEN)).status).toBe(400);
    for (const changed of [{ expected_subject_sha256: '0'.repeat(64) }, { expected_epoch: body.expected_epoch + 1 },
      { expected_work_revision: body.expected_work_revision + 1 }, { expected_contract_sha256: '0'.repeat(64) },
      { expected_target_generation: body.expected_target_generation + 1 }, { expected_target_plan_revision: body.expected_target_plan_revision + 1 },
      { expected_lineage_sha256: '0'.repeat(64) }, { expected_head: '0'.repeat(40) }]) {
      expect((await call(h.port, 'POST', `${f.route}/owner-resolution`, { ...body, ...changed }, TOKEN)).status).toBe(409);
    }
    expect((await call(h.port, 'POST', `${f.route}/owner-resolution/confirm-stop`, { ...body, expected_resolution_fingerprint: '0'.repeat(64) }, TOKEN)).status).toBe(409);
    expect(h.ledger.getObligation(f.target.id)?.state).toBe('suspended'); expect(h.ledger.getJob(f.jobId)?.status).toBe('parked');
    expect(h.ledger.latestJobEvent(f.jobId, 'ruling.recorded')).toBeNull(); expect(h.spawns).toEqual([]);
    expect(h.ledger.getNotification(f.ownerStop.id)?.ackedAt).toBeNull();
  });

  it('changed owner plan creates one suspended fresh Gru incarnation, preserving the original consumed decision and denying successors', async () => {
    const f = await ownerFixture('directives'); const { h } = f; const originalHistory = h.ledger.recoveryDecisionHistory('directive', f.subjectId);
    const source = h.ledger.appendCustomEvent({ kind: 'job.note', jobId: f.jobId, payload: { reason: 'owner budget changed' } });
    h.ledger.recordBlockedObservation(f.jobId, { logicalStep: 'operation', incidentKey: 'reserved-owner-budget',
      category: { kind: 'known', category: 'owner-hold' }, observedAtSeq: source.seq,
      nextAction: { kind: 'owner-decision', decision: 'owner must decide the changed budget; no previous grant applies' } });
    const next = h.ledger.openDirectiveRecoveryDebt(f.subjectId, 'governing owner plan changed');
    const again = h.ledger.openDirectiveRecoveryDebt(f.subjectId, 'governing owner plan changed');
    expect(next.id).not.toBe(f.debt.id); expect(again.id).toBe(next.id); expect(again.generation).toBe(next.generation);
    expect(next.state).toBe('suspended'); expect(h.ledger.getObligation(f.debt.id)?.state).toBe('closed');
    expect(h.ledger.recoveryDecisionHistory('directive', f.subjectId)).toEqual(originalHistory);
    expect((await call(h.port, 'POST', `${f.route}/recover`, f.transferBody, TOKEN)).json).toMatchObject({ idempotent: true });
    const refused = await call(h.port, 'POST', `${f.route}/recover`, { ...f.recoveryBody(next.generation),
      decision: { kind: 'successor', request_id: 'forbidden-plan-successor', directive: 'do not execute' } }, TOKEN);
    expect(refused.status).toBe(409); expect(h.ledger.getDirective('forbidden-plan-successor')).toBeNull(); expect(h.spawns).toEqual([]);
  });
  it('generic owner-target closure creates suspended debt, never permission or original prompt revival', async () => {
    const f = await ownerFixture('directives'); const { h } = f;
    h.ledger.settleObligation({ obligationId: f.target.id, settlement: { kind: 'cancelled', reason: 'generic administrative closure — not permission' } });
    h.ledger.setJobStatus(f.jobId, 'working');
    const next = h.ledger.openDirectiveRecoveryDebt(f.subjectId, 'target closed without genuine resolution');
    expect(next.id).not.toBe(f.debt.id); expect(next.state).toBe('suspended');
    expect((await call(h.port, 'POST', `${f.route}/recover`, { ...f.recoveryBody(next.generation),
      decision: { kind: 'successor', request_id: 'closure-forbidden', directive: 'do not execute' } }, TOKEN)).status).toBe(409);
    expect(h.ledger.getDirective('closure-forbidden')).toBeNull(); expect(h.spawns).toEqual([]);
    expect(h.ledger.recoveryDecisionHistory('directive', f.subjectId)).toHaveLength(1);
    expect(h.ledger.getNotification(f.ownerStop.id)?.ackedAt).toBeNull();
  });

  it('recorded owner permission cannot confirm a changed scope, unrelated hold or epoch; its immutable attribution does not grant work', async () => {
    const f = await ownerFixture('directives'); const { h } = f; const body = await f.actionBody();
    const granted = await call(h.port, 'POST', `${f.route}/owner-resolution`, body, TOKEN);
    expect(granted.status, JSON.stringify(granted.json)).toBe(200); const ruling = field<{ payload: { fingerprint: string } }>(granted.json, 'receipt');
    const confirmation = { ...await f.actionBody(), expected_resolution_fingerprint: ruling.payload.fingerprint };
    const other = h.ledger.recordBlockedObservation(f.jobId, { logicalStep: 'operation', incidentKey: 'unrelated-owner-stop',
      category: { kind: 'known', category: 'owner-hold' }, observedAtSeq: h.ledger.latestEventSeq(), nextAction: { kind: 'owner-decision', decision: 'a separate reserved decision' } });
    expect((await call(h.port, 'POST', `${f.route}/owner-resolution/confirm-stop`, confirmation, TOKEN)).status).toBe(409);
    expect((await call(h.port, 'POST', `${f.route}/owner-resolution/confirm-stop`, { ...await f.actionBody(), expected_resolution_fingerprint: ruling.payload.fingerprint }, TOKEN)).status).toBe(409);
    expect(h.ledger.getObligation(f.target.id)?.state).toBe('suspended'); expect(h.ledger.getObligation(other.id)?.state).toBe('open');
    expect((await call(h.port, 'POST', `${f.route}/owner-resolution`, body, TOKEN)).json).toMatchObject({ idempotent: true });
    expect(h.ledger.latestJobEvent(f.jobId, 'silas.recovery-owner-stop-confirmed')).toBeNull(); expect(h.spawns).toEqual([]);
  });

  it('P28 genuine late completed receipts cannot conceal the still-held transferred owner after the snapshot changes', async () => {
    const f = await ownerFixture('rebriefs'); const { h } = f;
    const markers = h.ledger.listPendingRebriefs({ jobId: f.jobId }); const originalHash = h.ledger.rebriefReceiptEvidence(f.subjectId).sha256;
    for (const marker of markers) h.ledger.appendCustomEvent({ kind: marker.kind, jobId: marker.jobId, payload: { marker_id: marker.id, payload_hash: marker.payloadHash,
      minion_id: marker.agentId, agentId: marker.agentId, work_revision: marker.workRevision } });
    expect(h.ledger.rebriefReceiptEvidence(f.subjectId).sha256).not.toBe(originalHash);
    expect(h.ledger.recoveryOwnerBasis('rebrief', f.subjectId).owned).toBe(false);
    for (let restart = 0; restart < 2; restart += 1) {
      const db = new LedgerDb(h.dir); const ledger = new LedgerApi(db.handle);
      try { expect(() => ledger.clearPendingRebriefsIfCurrentAndSettle(markers)).toThrow(/owner transfer.*new receipts/); expect(ledger.listPendingRebriefs({ jobId: f.jobId })).toEqual(markers); }
      finally { db.close(); }
    }
    const renewed = h.ledger.openRebriefRecoveryDebt(f.subjectId, 'updated immutable facts need explicit owner resolution');
    expect((await call(h.port, 'POST', `${f.route}/recover`, { ...f.recoveryBody(renewed.generation), decision: { kind: 'owner-decision', obligation_id: f.target.id } }, TOKEN)).status).toBe(200);
    const permission = await call(h.port, 'POST', `${f.route}/owner-resolution`, await f.actionBody('release-current-facts'), TOKEN); expect(permission.status).toBe(200);
    const ruling = h.ledger.getEvent(field<number>(permission.json, 'event_seq'))!;
    expect((await call(h.port, 'POST', `${f.route}/owner-resolution/confirm-stop`, { ...await f.actionBody('release-current-facts'), expected_resolution_fingerprint: (ruling.payload as { fingerprint: string }).fingerprint }, TOKEN)).status).toBe(200);
    h.ledger.setJobStatus(f.jobId, 'working');
    expect(h.ledger.clearPendingRebriefsIfCurrentAndSettle(markers)).toBe(true); expect(h.ledger.clearPendingRebriefsIfCurrentAndSettle(markers)).toBe(false);
    expect(h.ledger.listJobEventsByKinds(f.jobId, ['silas.rebrief-settled'])).toHaveLength(1); expect(h.spawns).toEqual([]);
  });

  it('incoherent historical generation may only transfer its exact unknown evidence to the real reserved owner stop', async () => {
    const h = await boot(); const repo = makeFixtureRepo('owner-incoherent'); cleanupRepos.push(repo);
    const jobId = 'incoherent-owner-job'; seedJob(h, jobId); const lane = await seedLane(h, repo, jobId);
    const markers = h.ledger.beginPendingRebrief({ jobId, note: 'unknown pair', briefing: 'approved scope' });
    const marker = markers.find((row) => row.kind === 'silas.rebrief')!;
    h.ledger.clearPendingRebriefs(markers.filter((row) => row.kind === 'job.delivered').map((row) => row.id));
    h.ledger.setJobStatus(jobId, 'parked'); const debt = h.ledger.openRebriefRecoveryDebt(marker.id, 'incomplete unknown generation');
    const target = h.ledger.recordBlockedObservation(jobId, { logicalStep: 'operation', incidentKey: 'owner-budget',
      category: { kind: 'known', category: 'owner-hold' }, observedAtSeq: h.ledger.latestEventSeq(), nextAction: { kind: 'owner-decision', decision: 'owner must decide the reserved budget and evidence repair' } });
    const route = `/api/silas/rebriefs/${marker.id}/recover`;
    const body = { by: 'gru', expected_generation: debt.generation, expected_payload_hash: marker.payloadHash,
      expected_receipt_evidence_sha256: h.ledger.rebriefReceiptEvidence(marker.id).sha256,
      expected_head: laneHead(lane), expected_epoch: h.ledger.directiveRecoveryEpoch(jobId), reason: 'exact unknown context handed to real reserved owner',
      decision: { kind: 'owner-decision', obligation_id: target.id } };
    const malformed = await call(h.port, 'POST', route, { ...body, decision: { kind: 'successor', request_id: 'incoherent-forbidden', directive: 'never infer coherence' } }, TOKEN);
    expect(malformed.status).toBe(400); expect(malformed.json).toMatchObject({ detail: 'successor requires current expected_work_revision and expected_contract_sha256' });
    const authority = h.ledger.directiveCurrentAuthority(jobId);
    const incoherent = await call(h.port, 'POST', route, { ...body, expected_work_revision: authority.workRevision,
      expected_contract_sha256: authority.contractSha256, decision: { kind: 'successor', request_id: 'incoherent-forbidden', directive: 'never infer coherence' } }, TOKEN);
    expect(incoherent.status).toBe(409); expect(incoherent.json).toMatchObject({ detail: expect.stringContaining('incoherent') });
    expect((await call(h.port, 'POST', route, body, TOKEN)).status).toBe(200);
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(1); expect(h.ledger.getObligation(debt.id)?.state).toBe('closed');
    expect(h.ledger.getObligation(target.id)?.state).toBe('open');
    const audit = h.ledger.recoveryDecisionHistory('rebrief', marker.id)[0]!;
    expect(audit.ownerTransfer?.subject.snapshot).toEqual(h.ledger.rebriefReceiptEvidence(marker.id));
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull(); expect(h.spawns).toEqual([]);
  });

});

describe('legacy proven completion without fabricated historical delivery', () => {
  async function completedFixture(full = false) {
    const h = await boot({ completeReview: full }); const repo = makeFixtureRepo('completed-control-http'); cleanupRepos.push(repo);
    if (full) { attachBareOrigin(repo); repo.git(['push', 'origin', 'main']); }
    const jobId = 'completed-control-job'; seedJob(h, jobId); const lane = await seedLane(h, repo, jobId);
    if (full) {
      h.ledger.setJobPr(jobId, 'https://github.com/example/fixture/pull/1');
      mkdirSync(join(lane.path, '.gru-command'), { recursive: true });
      writeFileSync(join(lane.path, '.gru-command', 'worktree.toml'), '[verify]\nfull = "test ! -f .P37-fail && printf verified"\n');
      execFileSync('git', ['-C', lane.path, 'add', '.gru-command/worktree.toml']);
      execFileSync('git', ['-C', lane.path, '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'declare genuine full fixture gate'], { stdio: 'ignore' });
    }
    const originalMarkers = h.ledger.beginPendingRebrief({ jobId, note: 'old completed work', briefing: 'original approved scope',
      handoff: { kind: 'gru-decision', decision: 'original phase completion' } });
    await bindOriginalRebriefSdkOwner(h.ledger, originalMarkers, { cwd: lane.path, dataDir: h.dir, agentId: 'original-completed-minion' });
    const markers = h.ledger.listPendingRebriefs({ jobId }); const marker = markers.find((row) => row.kind === 'silas.rebrief')!;
    const original = h.ledger.appendCustomEvent({ kind: 'silas.rebrief', jobId, agentId: 'original-completed-minion',
      payload: { phase_id: marker.phaseId, minion_id: 'original-completed-minion', note: 'real completed original phase; no duplicated revision or historical HEAD' } });
    const debt = h.ledger.openRebriefRecoveryDebt(marker.id, 'exact completion, absent historical delivery facts');
    const route = `/api/silas/rebriefs/${marker.id}`;
    const readback = await call(h.port, 'GET', route, undefined, TOKEN);
    expect(readback.status).toBe(200);
    const evidence = field<ReturnType<LedgerApi['rebriefReceiptEvidence']>>(readback.json, 'receipt_evidence');
    expect(evidence).toEqual(h.ledger.rebriefReceiptEvidence(marker.id));
    const receiptHash = field<string>(readback.json, 'receipt_evidence_sha256');
    expect(receiptHash).toBe(evidence.sha256);
    const body = () => ({ by: 'gru', expected_generation: debt.generation, expected_payload_hash: marker.payloadHash,
      expected_receipt_evidence_sha256: receiptHash,
      expected_head: laneHead(lane), expected_epoch: h.ledger.directiveRecoveryEpoch(jobId),
      expected_work_revision: h.ledger.directiveCurrentAuthority(jobId).workRevision,
      expected_contract_sha256: h.ledger.directiveCurrentAuthority(jobId).contractSha256,
      reason: 'close completed original control without inventing missing historical facts',
      decision: { kind: 'reconcile-completed', inspection_request_id: 'separate-current-inspection' } });
    return { h, lane, jobId, markers, marker, original, debt, route, body };
  }

  async function verifiedCurrentGateFixture() {
    const f = await completedFixture(true); const { h } = f;
    expect((await call(h.port, 'POST', `${f.route}/recover`, f.body(), TOKEN)).status).toBe(200);
    const closure = h.ledger.latestJobEvent(f.jobId, 'silas.rebrief-control-closed')!;
    expect((await call(h.port, 'POST', '/api/silas/directive', { job_id: f.jobId, request_id: 'separate-current-inspection', directive: (closure.payload as { inspection_directive: string }).inspection_directive }, TOKEN)).status).toBe(202);
    await waitFor(() => h.ledger.getDirective('separate-current-inspection')?.state === 'settled', 'P37 real inspection');
    const root = h.ledger.latestJobEvent(f.jobId, 'silas.rebrief-current-gates-owed')!;
    const duty = h.ledger.getObligation((root.payload as { obligation_id: string }).obligation_id)!;
    execFileSync('git', ['-C', f.lane.path, 'push', 'origin', f.lane.branch!], { stdio: 'ignore' });
    const scheduler = new VerificationScheduler({ storageDir: join(h.dir, 'verify'), limits: { maxConcurrent: 1, workerBudget: 1, lockWaitTimeoutMs: 5000, runTimeoutMs: 5000 }, record: (event) => { h.ledger.appendCustomEvent(event); } });
    try {
      const outcome = await scheduler.submit({ jobId: f.jobId, scope: 'full', command: 'test ! -f .P37-fail && printf verified', cwd: f.lane.path, requestId: 'P37-original-full' }, () => {});
      expect(outcome.ok).toBe(true); expect(outcome.trackedDirty).toBe(false);
      const begun = await h.wave.beginRound({ jobId: f.jobId, targetRef: f.lane.branch! }); const result = await begun.run;
      expect(result, JSON.stringify(h.ledger.listJobEventsByKinds(f.jobId, ['round.error', 'round.status', 'round.perkins-review']))).toMatchObject({ verdict: 'approved' });
      const evidence = h.ledger.latestRoundEvent(begun.round.id, 'round.perkins-review')!;
      expect(evidence.payload).toMatchObject({ canonicalVerdict: 'READY TO MERGE', complete: true, reviewScope: 'whole' });
      return { f, h, root, duty, scheduler, evidence };
    } catch (error) { await scheduler.dispose(); throw error; }
  }

  it('P37 unknown newer pending and aborted round remains fenced without fabricated ownership cleanup', async () => {
    const { f, h, root, duty, scheduler, evidence } = await verifiedCurrentGateFixture();
    try {
      const disposition = { kind: 'accepted-evidence' as const, gate: 'older genuine complete gates', evidenceEventKind: evidence.kind, evidenceEventSeq: evidence.seq };
      const pending = h.ledger.addRound({ jobId: f.jobId, lenses: [], targetRef: f.lane.branch! });
      expect(() => h.ledger.settleObligation({ obligationId: duty.id, settlement: disposition })).toThrow(/producer ownership/);
      h.ledger.setRoundStatus(pending.id, 'aborted');
      expect(() => h.ledger.settleObligation({ obligationId: duty.id, settlement: disposition })).toThrow(/newest/);
      await expect(h.wave.beginRound({ jobId: f.jobId, targetRef: f.lane.branch! })).rejects.toThrow(/no trusted no-spawn proof|ownership is unknown/);
      expect(h.ledger.latestRoundEvent(pending.id, 'round.perkins-review')).toBeNull();
      expect(h.ledger.getObligation(duty.id)?.state).toBe('open'); expect(h.ledger.getEvent(root.seq)).toEqual(root);
      const db = new LedgerDb(h.dir); const reopened = new LedgerApi(db.handle);
      try { expect(() => reopened.settleObligation({ obligationId: duty.id, settlement: disposition })).toThrow(/newest/); expect(reopened.getObligation(duty.id)?.state).toBe('open'); }
      finally { db.close(); }
    } finally { await scheduler.dispose(); }
  });

  it('P37 actual declared full scheduler and newest complete whole review settle exact protected duty without rewriting its root', async () => {
    const { f, h, root, duty, scheduler, evidence } = await verifiedCurrentGateFixture();
    try {
      const originalPayload = evidence.payload as Record<string, unknown>;
      for (const change of [{ canonicalVerdict: 'NEEDS CHANGES' }, { blockers: 1 }, { complete: false }, { headMoved: true },
        { reviewScope: 'delta' }, { finalPassRequired: true }, { targetSha: 'a'.repeat(40) }]) {
        h.db.handle.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(JSON.stringify({ ...originalPayload, ...change }), evidence.seq);
        expect(() => h.ledger.settleObligation({ obligationId: duty.id, settlement: { kind: 'accepted-evidence', gate: 'adversarial incomplete current review', evidenceEventSeq: evidence.seq, evidenceEventKind: evidence.kind } })).toThrow(/current gate duty/);
      }
      h.db.handle.prepare('UPDATE events SET payload = ? WHERE seq = ?').run(JSON.stringify(originalPayload), evidence.seq);
      const readme = join(f.lane.path, 'README.md'); const savedReadme = readFileSync(readme);
      writeFileSync(readme, 'different tracked current bytes');
      expect(() => h.ledger.settleObligation({ obligationId: duty.id, settlement: { kind: 'accepted-evidence', gate: 'dirty candidate', evidenceEventSeq: evidence.seq, evidenceEventKind: evidence.kind } })).toThrow(/dirty/);
      writeFileSync(readme, savedReadme);
      const disposition = { kind: 'accepted-evidence' as const, evidenceEventSeq: evidence.seq, evidenceEventKind: evidence.kind, gate: 'genuine current local full and actual whole review' };
      const claimed = h.ledger.claimObligation({ obligationId: duty.id, requestId: 'P37-owner-claim', holder: 'owner', expiresAt: '2099-01-01T00:00:00.000Z', expectedGeneration: duty.generation });
      expect(() => h.ledger.settleObligation({ obligationId: duty.id, settlement: disposition, requestId: 'P37-owner-claim' })).toThrow(/claimed/);
      expect(h.ledger.getObligation(duty.id)?.claim).toEqual(claimed.claim); h.ledger.releaseClaim({ obligationId: duty.id, requestId: 'P37-owner-claim' });
      h.ledger.suspendObligation(duty.id, 'real owner hold');
      expect(() => h.ledger.settleObligation({ obligationId: duty.id, settlement: disposition })).toThrow();
      h.ledger.resumeObligation(duty.id, 'explicit actual owner hold release');
      const recipient = h.ledger.recordBlockedObservation(f.jobId, { logicalStep: 'verification', incidentKey: 'P37-exact-transfer', observedAtSeq: root.seq,
        category: { kind: 'known', category: 'restart-recovery' }, nextAction: { kind: 'gru-decision', decision: (duty.nextAction as { decision: string }).decision } });
      h.ledger.settleObligation({ obligationId: duty.id, settlement: { kind: 'superseded', byObligationId: recipient.id, reason: 'preserve original current gate bindings' } });
      expect(() => h.ledger.recordBlockedObservation(f.jobId, { logicalStep: 'verification', incidentKey: recipient.incidentKey, observedAtSeq: h.ledger.latestEventSeq() + 1,
        category: { kind: 'known', category: 'restart-recovery' }, nextAction: { kind: 'owner-decision', decision: 'replace original sealed current duty with unbound owner prose' } })).toThrow(/launder/);
      const fresh = new VerificationScheduler({ storageDir: join(h.dir, 'verify-again'), limits: { maxConcurrent: 1, workerBudget: 1, lockWaitTimeoutMs: 5000, runTimeoutMs: 5000 }, record: (event) => { h.ledger.appendCustomEvent(event); } });
      try {
        writeFileSync(join(f.lane.path, '.P37-fail'), 'fail exact declared full');
        expect((await fresh.submit({ jobId: f.jobId, requestId: 'P37-newest-failure', scope: 'full', command: 'test ! -f .P37-fail && printf verified', cwd: f.lane.path })).ok).toBe(false);
        rmSync(join(f.lane.path, '.P37-fail'));
        expect(() => h.ledger.settleObligation({ obligationId: recipient.id, settlement: disposition })).toThrow(/current gate duty/);
      } finally { await fresh.dispose(); }
      const currentAuthority = h.ledger.directiveCurrentAuthority(f.jobId);
      h.ledger.addJobAmendment({ jobId: f.jobId, body: 'administrative clarification, not new implementation', effect: 'administrative', supersedes: [], approval: { by: 'owner', reference: 'P37-admin' }, expectedContractSha256: currentAuthority.contractSha256 });
      expect(() => h.ledger.settleObligation({ obligationId: recipient.id, settlement: disposition })).toThrow(/current gate duty/);
      const finalScheduler = new VerificationScheduler({ storageDir: join(h.dir, 'verify-admin'), limits: { maxConcurrent: 1, workerBudget: 1, lockWaitTimeoutMs: 5000, runTimeoutMs: 5000 }, record: (event) => { h.ledger.appendCustomEvent(event); } });
      try {
        expect((await finalScheduler.submit({ jobId: f.jobId, requestId: 'P37-current-admin-full', scope: 'full', command: 'test ! -f .P37-fail && printf verified', cwd: f.lane.path })).ok).toBe(true);
        const later = await h.wave.beginRound({ jobId: f.jobId, targetRef: f.lane.branch! }); expect((await later.run).verdict).toBe('approved');
        const newest = h.ledger.latestRoundEvent(h.ledger.listRounds(f.jobId).at(-1)!.id, 'round.perkins-review')!;
        expect(newest.payload).toMatchObject({ reviewScope: 'whole', complete: true });
        const db = new LedgerDb(h.dir); const reopened = new LedgerApi(db.handle);
        try { expect(reopened.settleObligation({ obligationId: recipient.id, settlement: { ...disposition, evidenceEventSeq: newest.seq } }).state).toBe('settled'); }
        finally { db.close(); }
      } finally { await finalScheduler.dispose(); }
      expect(h.ledger.getEvent(root.seq)).toEqual(root); expect(h.ledger.latestJobEvent(f.jobId, 'verification.ready')).toBeNull();
      const historicCandidate = h.ledger.latestCandidateDelivery(f.jobId)!;
      const completedSettlement = h.ledger.getObligation(recipient.id)!.settlement!;
      h.ledger.addJobAmendment({ jobId: f.jobId, body: 'new material scope still requires independently delivered current revision', effect: 'material', supersedes: [], approval: { by: 'owner', reference: 'P37-material' }, expectedContractSha256: h.ledger.directiveCurrentAuthority(f.jobId).contractSha256 });
      expect(() => h.ledger.settleObligation({ obligationId: recipient.id, settlement: completedSettlement })).toThrow(/current native candidate/);
      expect(h.ledger.workRevisionState(f.jobId)).toEqual({ required: 2, delivered: 0 });
      const unknown = h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.jobId, payload: { sha: null, work_revision: 2, candidate_delivery_proven: false } });
      expect(h.ledger.latestCandidateDelivery(f.jobId)?.seq).toBe(unknown.seq);
      expect(() => h.ledger.settleObligation({ obligationId: recipient.id, settlement: completedSettlement })).toThrow(/current native candidate/);
      expect(h.ledger.getObligation(recipient.id)?.state).toBe('settled');
      expect(h.ledger.getEvent(historicCandidate.seq)).toEqual(historicCandidate);
    } finally { await scheduler.dispose(); }
  });

  it('exact non-executing closure leaves owned executable current inspection, immutable absent historical facts and replay-safe audit', async () => {
    const f = await completedFixture(); const { h } = f;
    const observed = await reconcilePendingRebriefs({ ledger: h.ledger, worktrees: h.worktrees,
      registry: { getHandle: () => null, spawn: async () => { throw new Error('historical observer must never spawn'); },
        disposeHandle: async () => { throw new Error('historical observer owns no handle to dispose'); } }, notifications: h.notifications });
    await observed.settled; expect(observed.completed).toBe(0);
    expect(h.ledger.latestJobEvent(f.jobId, 'job.delivered')).toBeNull(); expect(h.spawns).toEqual([]);
    const body = f.body(); const closed = await call(h.port, 'POST', `${f.route}/recover`, body, TOKEN); expect(closed.status).toBe(200);
    expect(h.ledger.latestJobEvent(f.jobId, 'job.delivered')).toBeNull(); expect(h.ledger.listPendingRebriefs({ jobId: f.jobId })).toEqual([]);
    expect(h.ledger.getObligation(f.debt.id)?.state).toBe('closed'); expect(h.spawns).toEqual([]);
    expect(h.ledger.getEvent(f.original.seq)?.payload).toEqual(f.original.payload);
    const audit = h.ledger.latestJobEvent(f.jobId, 'silas.rebrief-control-closed')!;
    expect(audit.payload).toMatchObject({ markers: f.markers, completion_event_seq: f.original.seq, inspection_request_id: 'separate-current-inspection' });
    const readback = await call(h.port, 'GET', f.route, undefined, TOKEN);
    const debts = field<ReturnType<LedgerApi['getObligation']>[]>(readback.json, 'current_inspection_obligations');
    expect(debts).toHaveLength(1); expect(debts[0]?.state).toBe('open'); expect(debts[0]?.nextAction.kind).toBe('gru-decision');
    expect((await call(h.port, 'POST', `${f.route}/recover`, body, TOKEN)).json).toMatchObject({ idempotent: true });
    const instruction = (audit.payload as { inspection_directive: string }).inspection_directive;
    const current = await call(h.port, 'POST', '/api/silas/directive', { job_id: f.jobId, request_id: 'separate-current-inspection', directive: instruction }, TOKEN);
    expect(current.status, JSON.stringify(current.json)).toBe(202);
    for (let i = 0; i < 200 && h.ledger.getDirective('separate-current-inspection')?.state !== 'settled'; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.ledger.getDirective('separate-current-inspection')?.state).toBe('settled'); expect(h.ledger.getObligation(debts[0]!.id)?.state).toBe('closed');
    const gateDuty = h.ledger.listObligations({ jobId: f.jobId }).find((row) => row.incidentKey === `rebrief-current-gates:${f.marker.id}`)!;
    expect(gateDuty.state).toBe('open'); expect(gateDuty.nextAction).toMatchObject({ kind: 'gru-decision', decision: expect.stringContaining('POST /api/verify') });
    expect(h.ledger.getObligation(debts[0]!.id)?.settlement).toMatchObject({ kind: 'superseded', byObligationId: gateDuty.id });
    expect(h.ledger.latestJobEvent(f.jobId, 'silas.rebrief-current-gates-owed')?.payload).toMatchObject({ closure_seq: audit.seq, inspection_request_id: 'separate-current-inspection', obligation_id: gateDuty.id });
    const delivery = h.ledger.latestJobEvent(f.jobId, 'job.delivered')!;
    expect(delivery.payload).toMatchObject({ request_id: 'separate-current-inspection' });
    expect((delivery.payload as Record<string, unknown>)['marker_id']).toBeUndefined();
    expect(h.ledger.getEvent(f.original.seq)?.payload).toEqual(f.original.payload);
    expect(h.ledger.latestJobEvent(f.jobId, 'verification.ready')).toBeNull();
  });

  it('P32 current gate duty refuses generic evidence and binding laundering while retaining safe transferred ownership across restart', async () => {
    const f = await completedFixture(); const { h } = f;
    expect((await call(h.port, 'POST', `${f.route}/recover`, f.body(), TOKEN)).status).toBe(200);
    const audit = h.ledger.latestJobEvent(f.jobId, 'silas.rebrief-control-closed')!;
    const instruction = (audit.payload as { inspection_directive: string }).inspection_directive;
    expect((await call(h.port, 'POST', '/api/silas/directive', { job_id: f.jobId, request_id: 'separate-current-inspection', directive: instruction }, TOKEN)).status).toBe(202);
    await waitFor(() => h.ledger.getDirective('separate-current-inspection')?.state === 'settled', 'actual current inspection delivery');
    const duty = h.ledger.listObligations({ jobId: f.jobId }).find((row) => row.incidentKey === `rebrief-current-gates:${f.marker.id}`)!;
    expect(duty, 'inspection must transfer concrete still-open current gate ownership').toBeDefined();
    const delivery = h.ledger.latestJobEvent(f.jobId, 'job.delivered')!;
    for (const event of [f.original, delivery]) expect(() => h.ledger.settleObligation({ obligationId: duty.id, settlement: {
      kind: 'executed-action', action: 'generic prose cannot complete current gates', evidenceEventSeq: event.seq, evidenceEventKind: event.kind } })).toThrow(/current gate duty/);
    for (const id of [null, duty.id, f.debt.id]) expect(() => h.ledger.settleObligation({ obligationId: duty.id, settlement: {
      kind: 'superseded', byObligationId: id, reason: 'unsafe target' } })).toThrow(/distinct live/);
    const recipient = h.ledger.recordBlockedObservation(f.jobId, { logicalStep: 'verification', incidentKey: 'explicit-current-gate-action-transfer', observedAtSeq: h.ledger.latestEventSeq(),
      category: { kind: 'known', category: 'restart-recovery' }, nextAction: duty.nextAction });
    h.ledger.settleObligation({ obligationId: duty.id, settlement: { kind: 'superseded', byObligationId: recipient.id, reason: 'explicit separate action ownership preserving every still-owed binding' } });
    for (let restart = 0; restart < 2; restart += 1) {
      const db = new LedgerDb(h.dir); const ledger = new LedgerApi(db.handle);
      try {
        expect(ledger.getObligation(recipient.id)?.nextAction).toEqual(duty.nextAction);
        expect(() => ledger.settleObligation({ obligationId: recipient.id, settlement: { kind: 'accepted-evidence', gate: 'current applicable gates', evidenceEventSeq: delivery.seq, evidenceEventKind: delivery.kind } })).toThrow(/current gate duty/);
        expect(() => ledger.recordBlockedObservation(f.jobId, { logicalStep: 'verification', incidentKey: recipient.incidentKey, observedAtSeq: ledger.latestEventSeq() + 1,
          category: { kind: 'known', category: 'restart-recovery' }, nextAction: { kind: 'gru-decision', decision: 'inspection alone answered every gate' } })).toThrow(/launder/);
        expect(() => ledger.settleObligation({ obligationId: recipient.id, settlement: { kind: 'job-terminal', jobStatus: 'binned' } })).toThrow(/actual matching terminal/);
        ledger.recordDirectiveDelivery({ requestId: 'separate-current-inspection', eventSeq: delivery.seq });
        expect(ledger.listJobEventsByKinds(f.jobId, ['silas.rebrief-current-gates-owed'])).toHaveLength(1);
        expect(ledger.getObligation(recipient.id)?.state).toBe('open');
      } finally { db.close(); }
    }
    expect(h.ledger.getEvent(f.original.seq)?.payload).toEqual(f.original.payload);
    h.ledger.setJobStatus(f.jobId, 'binned'); expect(h.ledger.getObligation(recipient.id)?.state).toBe('closed');
    expect(h.ledger.getObligation(recipient.id)?.settlement).toEqual({ kind: 'job-terminal', jobStatus: 'binned' });
  });

  it('P38 authenticated rebrief readback retains inspection history and follows exact live gate owner through restart and terminal closure', async () => {
    const f = await completedFixture(); const { h } = f;
    expect((await call(h.port, 'POST', `${f.route}/recover`, f.body(), TOKEN)).status).toBe(200);
    const audit = h.ledger.latestJobEvent(f.jobId, 'silas.rebrief-control-closed')!;
    const instruction = (audit.payload as { inspection_directive: string }).inspection_directive;
    expect((await call(h.port, 'POST', '/api/silas/directive', { job_id: f.jobId, request_id: 'separate-current-inspection', directive: instruction }, TOKEN)).status).toBe(202);
    await waitFor(() => h.ledger.getDirective('separate-current-inspection')?.state === 'settled', 'P38 current inspection');
    const duty = h.ledger.listObligations({ jobId: f.jobId }).find((row) => row.incidentKey === `rebrief-current-gates:${f.marker.id}`)!;
    const originalGate = h.ledger.latestJobEvent(f.jobId, 'silas.rebrief-current-gates-owed')!;
    for (let noise = 0; noise < 205; noise += 1) h.ledger.appendCustomEvent({ kind: 'silas.rebrief-current-gates-owed', jobId: f.jobId,
      payload: { marker_id: `P38-unrelated-${noise}`, obligation_id: `P38-unrelated-debt-${noise}`, next_action: { kind: 'gru-decision', decision: 'unrelated later action' } } });
    const recipient = h.ledger.recordBlockedObservation(f.jobId, { logicalStep: 'verification', incidentKey: 'P38-explicit-owner', observedAtSeq: h.ledger.latestEventSeq(),
      category: { kind: 'known', category: 'owner-hold' }, nextAction: { kind: 'owner-decision', decision: (duty.nextAction as { decision: string }).decision } });
    h.ledger.settleObligation({ obligationId: duty.id, settlement: { kind: 'superseded', byObligationId: recipient.id, reason: 'exact binding-preserving owner transfer' } });
    h.ledger.suspendObligation(recipient.id, 'owner hold is real and must stay visible');
    const response = await call(h.port, 'GET', f.route, undefined, TOKEN);
    expect(response.status).toBe(200);
    const json = response.json as Record<string, unknown>;
    const lineages = json['current_action_obligation_lineages'] as { gateEvents: { payload: unknown }[]; obligations: { id: string }[]; currentObligation: { id: string; state: string; nextAction: unknown } }[];
    expect(lineages).toHaveLength(1); expect(lineages[0]!.obligations).toHaveLength(3);
    expect(lineages[0]!.gateEvents).toHaveLength(1); expect(lineages[0]!.gateEvents[0]!.payload).toEqual(originalGate.payload);
    expect(lineages[0]!.currentObligation).toMatchObject({ id: recipient.id, state: 'suspended', nextAction: recipient.nextAction });
    expect(json['current_inspection_obligations']).toHaveLength(1);
    for (let restart = 0; restart < 2; restart += 1) {
      const db = new LedgerDb(h.dir); const ledger = new LedgerApi(db.handle);
      try {
        const lineage = ledger.rebriefCurrentActionObligationLineages(f.marker.id)[0]!;
        expect(lineage.currentObligation).toMatchObject({ id: recipient.id, state: 'suspended' }); expect(lineage.gateEvents[0]?.payload).toEqual(originalGate.payload);
      }
      finally { db.close(); }
    }
    h.ledger.setJobStatus(f.jobId, 'binned');
    const terminal = (await call(h.port, 'GET', f.route, undefined, TOKEN)).json as Record<string, unknown>;
    expect(terminal['current_action_obligation_lineages']).toEqual(h.ledger.rebriefCurrentActionObligationLineages(f.marker.id));
    expect(h.ledger.getObligation(recipient.id)?.state).toBe('closed');
    const original = h.ledger.getObligation(duty.id)!.settlement;
    for (const id of ['missing-P38-successor', duty.id]) {
      h.db.handle.prepare('UPDATE job_obligations SET settlement = ? WHERE id = ?').run(JSON.stringify({ kind: 'superseded', byObligationId: id, reason: 'corrupt durable lineage' }), duty.id);
      expect(() => h.ledger.rebriefCurrentActionObligationLineages(f.marker.id)).toThrow(/missing or foreign|cyclic/);
      const refused = await call(h.port, 'GET', f.route, undefined, TOKEN);
      expect(refused.status).toBe(400); expect(JSON.stringify(refused.json)).toMatch(/lineage/);
    }
    h.db.handle.prepare('UPDATE job_obligations SET settlement = ? WHERE id = ?').run(JSON.stringify(original), duty.id);
  });

  it('completed control closure refuses stale receipt/current scope, foreign proof and live/queued producers without effects', async () => {
    const f = await completedFixture(); const { h } = f; const body = f.body();
    for (const changed of [{ expected_receipt_evidence_sha256: '0'.repeat(64) }, { expected_work_revision: body.expected_work_revision + 1 },
      { expected_contract_sha256: '0'.repeat(64) }, { expected_head: '0'.repeat(40) }, { expected_epoch: body.expected_epoch + 1 }]) {
      expect((await call(h.port, 'POST', `${f.route}/recover`, { ...body, ...changed }, TOKEN)).status).toBe(409);
    }
    const release = h.ledger.beginJobAdmission(f.jobId, 'fixture queued producer');
    try { expect((await call(h.port, 'POST', `${f.route}/recover`, body, TOKEN)).status).toBe(409); } finally { release(); }
    h.ledger.registerAgent({ id: 'live-original', role: 'minion', jobId: f.jobId, sessionFile: null }); h.ledger.setAgentState('live-original', 'streaming');
    expect((await call(h.port, 'POST', `${f.route}/recover`, body, TOKEN)).status).toBe(409);
    expect(h.ledger.listPendingRebriefs({ jobId: f.jobId })).toEqual(f.markers); expect(h.ledger.getObligation(f.debt.id)?.state).toBe('open');
    expect(h.ledger.latestJobEvent(f.jobId, 'silas.rebrief-control-closed')).toBeNull(); expect(h.ledger.latestJobEvent(f.jobId, 'job.delivered')).toBeNull(); expect(h.spawns).toEqual([]);
  });

  it('held completed control closure preserves real owner stop and parking while suspending its current inspection', async () => {
    const f = await completedFixture(); const { h } = f; h.ledger.setJobStatus(f.jobId, 'parked');
    const owner = h.ledger.recordBlockedObservation(f.jobId, { logicalStep: 'operation', incidentKey: 'owner-budget',
      category: { kind: 'known', category: 'owner-hold' }, observedAtSeq: h.ledger.latestEventSeq(), nextAction: { kind: 'owner-decision', decision: 'reserved owner budget still stopped' } });
    const closed = await call(h.port, 'POST', `${f.route}/recover`, f.body(), TOKEN); expect(closed.status).toBe(200);
    const next = h.ledger.listObligations({ jobId: f.jobId }).find((row) => row.incidentKey === `rebrief-current-inspection:${f.marker.id}`)!;
    expect(next.state).toBe('suspended'); expect(h.ledger.getObligation(owner.id)?.state).toBe('open'); expect(h.ledger.getJob(f.jobId)?.status).toBe('parked');
    expect(h.ledger.latestJobEvent(f.jobId, 'job.delivered')).toBeNull(); expect(h.spawns).toEqual([]);
  });
});

async function assertAuthenticatedRebriefClearance(revoke: boolean) {
  const h = await boot(); const repo = makeFixtureRepo('authenticated-rebrief-clearance'); cleanupRepos.push(repo);
  seedJob(h, 'http-clearance-job'); await seedLane(h, repo, 'http-clearance-job');
  let allowed = false; let release!: () => void; let reached!: () => void;
  const hold = new Promise<void>((done) => { release = done; }); const boundary = new Promise<void>((done) => { reached = done; });
  const actualClearance = h.wave.clearLaneForWriter.bind(h.wave);
  const clearance = vi.spyOn(h.wave, 'clearLaneForWriter').mockImplementation(async (input) => {
    if (!allowed) throw new Error('original review disposal remains unproven');
    if (revoke) { reached(); await hold; }
    return actualClearance(input);
  });
  const result = await call(h.port, 'POST', '/api/silas/rebrief', { job_id: 'http-clearance-job', note: 'original accepted rebrief', request_id: 'http-original-rebrief' }, TOKEN);
  expect(result.status).toBe(202);
  await waitFor(() => h.ledger.hasDirectiveDispatchDeferral('http-original-rebrief'), 'durable actual HTTP clearance refusal');
  await waitFor(() => h.ledger.listJobAdmissions('http-clearance-job').length === 0, 'original HTTP reservation release');
  const accepted = h.ledger.getDirective('http-original-rebrief')!; expect(accepted.nativeTarget).toBeNull(); expect(h.spawns).toEqual([]);
  const service = new DirectiveProgressService({ ledger: h.ledger, registry: h.registry, worktrees: h.worktrees, notifications: h.notifications,
    signal: new AbortController().signal, pendingProducerBlockers: () => [], clearLaneForWriter: (input) => h.wave.clearLaneForWriter(input) });
  try {
    service.reconsider(); await service.settled(); expect(h.spawns).toEqual([]);
    allowed = true; service.reconsider();
    if (revoke) { await boundary; h.ledger.setJobStatus(accepted.jobId, 'parked'); release(); }
    await service.settled(); service.reconsider(); await service.settled();
    const final = h.ledger.getDirective(accepted.requestId)!;
    expect(final.state).toBe(revoke ? 'dispatching' : 'settled');
    expect(final).toMatchObject({ requestId: accepted.requestId, payloadHash: accepted.payloadHash, payload: accepted.payload, authorityEpoch: accepted.authorityEpoch, workRevision: accepted.workRevision });
    if (revoke) { expect(h.spawns).toEqual([]); expect(final.nativeTarget).toBeNull(); expect(h.ledger.latestJobEventByRequestId(accepted.jobId, 'job.delivered', accepted.requestId)).toBeNull(); }
    else { expect(h.spawns.filter((spawn) => spawn.role === 'minion')).toHaveLength(1); expect(h.ledger.latestJobEventByRequestId(accepted.jobId, 'job.delivered', accepted.requestId)).not.toBeNull(); }
    expect(clearance.mock.calls.length).toBeGreaterThanOrEqual(3);
  } finally { release(); await service.dispose(); clearance.mockRestore(); }
}
it('authenticated HTTP rebrief gate refusal preserves the original accepted request until shared reconsideration positively clears it', () => assertAuthenticatedRebriefClearance(false));
it('authenticated HTTP rebrief reconsideration rechecks owner authority after awaited clearance before native work', () => assertAuthenticatedRebriefClearance(true));
