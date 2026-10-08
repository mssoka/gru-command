import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, type DirectiveRequestRecord, type JobRecord } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { loadConfig, DEFAULT_SILAS_CONFIG, type Role } from '../src/config.js';
import { createDispatchServer, type DispatchServer } from '../src/dispatch/server.js';
import { DispatchService } from '../src/dispatch/service.js';
import { WaveRunner } from '../src/dispatch/perkins.js';
import { fakeWholeSpawner } from './helpers/perkins-whole-double.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { originHeadProbe } from './helpers/pr-head-probe.js';
import { BoardEngine } from '../src/board/engine.js';
import { computeSilasDigest } from '../src/dispatch/silas-driver.js';
import { reconcilePendingDirectives, settleDirectivesFromEvidence } from '../src/dispatch/rebrief-recovery.js';
import { findBusyLanes, laneIsBusy } from '../src/dispatch/branch-idle.js';
import { resolveGitCommit } from '../src/dispatch/perkins-review/artifacts.js';
import type { WorktreeLane } from '../src/dispatch/worktree-port.js';
import { PacingGate } from '../src/runtime/pacing.js';
import { directiveRetirementFingerprint } from '../src/ledger/directives.js';
import { claimProviderRecoveryContinuation } from '../src/provider-recovery/resume.js';
import type { AgentCapabilities, AgentHandle, SpawnOptions } from '../src/runtime/types.js';

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

async function boot(opts: { wrapLedger?: (ledger: LedgerApi) => LedgerApi; workerGate?: PacingGate;
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
  const spawns: { role: Role; options: SpawnOptions }[] = [];
  const reviewSessions = join(dir, 'review-sessions');
  mkdirSync(reviewSessions, { recursive: true });
  const hybrid = fakeWholeSpawner(reviewSessions, { childAnswer: () => '[]' });
  let promptSeq = 0;
  const liveHandles = new Map<string, AgentHandle>();
  const spawner = async (role: Role, options?: SpawnOptions): Promise<AgentHandle> => {
    spawns.push({ role, options: options ?? {} });
    if (role === 'perkins') return hybrid.spawner(role, options);
    const id = `agent-${spawns.length}`;
    const handle: AgentHandle = {
      role,
      id,
      sessionFile: null,
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
      },
      async steer() {},
      async followUp() {},
      subscribe() {
        return () => {};
      },
      health() {
        return { state: 'idle' as const, lastActivity: null, sessionFile: null };
      },
      async dispose() {},
    };
    liveHandles.set(id, handle);
    return handle;
  };
  const dispatch = new DispatchService({ ledger, worktrees, spawner });
  const wave = new WaveRunner({
    ledger,
    worktrees,
    spawner,
    bus,
    poster: {
      async post(input: { readonly targetSha: string; readonly body: string }) {
        return {
          reviewId: '9001',
          actor: 'gru-bot',
          event: 'COMMENTED',
          commitId: input.targetSha,
          headSha: input.targetSha,
          baseSha: 'stub-base',
          bodySha256: 'stub-body',
        };
      },
    },
    reviewArtifactRoot: join(dir, 'reviews'),
    prHeadProbe: originHeadProbe(),
  });
  const server = createDispatchServer({
    config: cfg,
    dispatch,
    wave,
    ledger,
    ...(opts.workerGate !== undefined ? { workerGate: opts.workerGate } : {}),
    ...(opts.pendingProducerBlockers !== undefined ? { pendingProducerBlockers: opts.pendingProducerBlockers } : {}),
    silasOps: {
      registry: {
        getHandle: (id: string) => liveHandles.get(id) ?? null,
        spawn: (role: Role, spawnOptions?: SpawnOptions) => spawner(role, spawnOptions),
        disposeHandle: async (handle: AgentHandle) => {
          liveHandles.delete(handle.id);
        },
      },
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
    const markers = h.ledger.beginPendingRebrief({ jobId: 'job-l', note: 'fold', briefing: 'b' });
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

  it('releases the hold on a fresh accepted re-brief by its marker identity', async () => {
    const repo = makeFixtureRepo('retire-hold-rebrief');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-y', 'req-y');
    expect((await retire(h, 'req-y', laneHead(lane))).status).toBe(200);
    expect(h.ledger.hasOpenDirectiveRecoveryHold('job-y')).toBe(true);

    const rebrief = await call(h.port, 'POST', '/api/silas/rebrief', { job_id: 'job-y', note: 'fold the fix' }, TOKEN);
    expect(rebrief.status).toBe(200);
    const hold = h.ledger.listDirectiveRecoveryHolds({ jobId: 'job-y' })[0];
    expect(hold?.releasedBy).not.toBeNull();
    expect(h.ledger.hasOpenDirectiveRecoveryHold('job-y')).toBe(false);
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
    const sent = h.ledger.appendCustomEvent({
      kind: 'silas.directive-sent',
      jobId: 'job-z',
      payload: { request_id: 'req-z-next', minion_id: 'minion-z' },
    });
    h.ledger.recordDirectiveAdmission({ requestId: 'req-z-next', minionId: 'minion-z', eventSeq: sent.seq });
    const delivered = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-z',
      payload: { request_id: 'req-z-next', source: 'silas-directive', sha: laneHead(lane) },
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
    const sent = h.ledger.appendCustomEvent({ kind: 'silas.directive-sent', jobId: 'job-admission-mismatch',
      payload: { request_id: 'req-admission-mismatch', minion_id: 'actual-minion' } });
    h.ledger.recordDirectiveAdmission({ requestId: 'req-admission-mismatch', eventSeq: sent.seq, minionId: 'different-minion' });
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
