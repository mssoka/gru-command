import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardEngine } from '../src/board/engine.js';
import { createBoardServer, type BoardServer } from '../src/board/server.js';
import { loadConfig, type Role } from '../src/config.js';
import { DecisionRuntime } from '../src/decisions/runtime.js';
import { observeTerminalJobDirective, surfaceDirectiveRecovery } from '../src/dispatch/directive-progress.js';
import {
  createOwnerApprovalService,
  DIRECTIVE_ABANDON_CARD_KIND,
  OWNER_APPROVAL_RECONCILE_INTERVAL_MS,
  ownerApprovalReasonPrefix,
  type OwnerApprovalService,
  type OwnerApprovalStep,
} from '../src/dispatch/owner-approvals.js';
import { resolveGitCommit } from '../src/dispatch/perkins-review/artifacts.js';
import { WaveRunner } from '../src/dispatch/perkins.js';
import { DispatchService } from '../src/dispatch/service.js';
import { createDispatchServer, type DispatchServer } from '../src/dispatch/server.js';
import type { DirectiveRegistry } from '../src/dispatch/fix-directive.js';
import type { WorktreeLane } from '../src/dispatch/worktree-port.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, type NotificationRecord } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { producerWithdrawable } from '../src/ledger/notification-decision.js';
import {
  OWNER_APPROVAL_MAX_ATTEMPTS,
  OWNER_APPROVAL_REASON_MAX_CHARS,
  OWNER_APPROVAL_STATES,
} from '../src/ledger/owner-approvals.js';
import { ownerAttentionFor, producerFollowsDecisionThrough, requiresTypedDecision } from '../src/notifications/attention.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { PacingGate } from '../src/runtime/pacing.js';
import type { AgentHandle, SpawnOptions } from '../src/runtime/types.js';
import { TranscriptService } from '../src/transcripts/service.js';
import { historicalLiveRequest, seededLiveRequest } from './helpers/directive-fixtures.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { originHeadProbe } from './helpers/pr-head-probe.js';

/**
 * Owner approval of abandonment (#523).
 *
 * The owner answers one FOR YOU card; the server carries out the native owner
 * abandonment. Proven here through the REAL dispatch HTTP surface, the REAL
 * board decision route, the REAL LedgerApi on a temp database and real git
 * fixture lanes: proposal answers, every card field, every state and refusal
 * code, the fresh-fence revalidation, crash-safe reconcile windows, bounded
 * retry and both text surfaces. No provider, no live spawn, no production
 * path.
 *
 * Every behavioral test's FIRST assertion is about the request itself — the
 * only fact the owner delegated: abandoned, or untouched.
 */

const TOKEN = 'test-token-owner-approvals';

const cleanupDirs: string[] = [];
const cleanupRepos: FixtureRepo[] = [];
const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.close();
  while (cleanupRepos.length > 0) cleanupRepos.pop()!.cleanup();
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

interface IntervalState {
  fn: (() => void) | null;
  period: number | null;
  started: number;
  cleared: number;
}

interface Harness {
  readonly dir: string;
  readonly port: number;
  readonly ledger: LedgerApi;
  readonly db: LedgerDb;
  readonly bus: EventBus;
  readonly notifications: NotificationCenter;
  readonly worktrees: InMemoryWorktreePort;
  readonly server: DispatchServer;
  readonly board: BoardServer;
  readonly interval: IntervalState;
  /** The dispatch server's owner-approval surface, always the current service. */
  readonly service: { current: OwnerApprovalService };
  readonly spawns: { role: Role; options: SpawnOptions | undefined }[];
  /** A fresh service over the same ledger (the "restart"): stops the old one. */
  restart(options?: BootOptions): OwnerApprovalService;
  close(): Promise<void>;
}

interface BootOptions {
  /** Steps whose completion throws — a crash stand-in after the durable write. */
  readonly crashAt?: readonly OwnerApprovalStep[];
  /** Do not start the service (no bus subscription, no interval). */
  readonly startService?: boolean;
  /** Host the routes on the dispatch server (default true). */
  readonly host?: boolean;
  /** Replace the notification write path (a card post that throws). */
  readonly notifications?: Pick<NotificationCenter, 'post'>;
  readonly workerGate?: PacingGate;
  readonly pendingProducerBlockers?: (jobId: string) => readonly string[];
}

async function boot(options: BootOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-owner-approvals-'));
  cleanupDirs.push(dir);
  writeFileSync(join(dir, 'config.toml'), `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`, 'utf-8');
  mkdirSync(join(dir, 'wtroot'));
  const cfg = loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
  const db = new LedgerDb(dir);
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  const worktrees = new InMemoryWorktreePort(join(dir, 'wtroot'), ledger);
  const spawns: { role: Role; options: SpawnOptions | undefined }[] = [];
  const spawner = async (role: Role, spawnOptions?: SpawnOptions): Promise<AgentHandle> => {
    spawns.push({ role, options: spawnOptions });
    throw new Error('owner approvals must never spawn or prompt');
  };
  const dispatch = new DispatchService({ ledger, worktrees, spawner });
  const wave = new WaveRunner({
    ledger,
    worktrees,
    spawner,
    bus,
    poster: { async post(): Promise<never> { throw new Error('owner approvals must never post a review'); } },
    reviewArtifactRoot: join(dir, 'reviews'),
    prHeadProbe: originHeadProbe(),
  });
  const registry: DirectiveRegistry = {
    getHandle: () => null,
    spawn: (role, spawnOptions) => spawner(role, spawnOptions),
    disposeHandle: async () => {},
  };
  const interval: IntervalState = { fn: null, period: null, started: 0, cleared: 0 };
  const service: { current: OwnerApprovalService } = { current: undefined as unknown as OwnerApprovalService };
  const workerGate = options.workerGate;
  const pendingProducerBlockers = options.pendingProducerBlockers ?? (() => []);

  const makeService = (overrides: BootOptions = {}): OwnerApprovalService => {
    const crashAt = overrides.crashAt ?? options.crashAt ?? [];
    const gate = overrides.workerGate ?? workerGate;
    return createOwnerApprovalService({
      ledger,
      notifications: overrides.notifications ?? options.notifications ?? notifications,
      bus,
      worktrees,
      ...(gate === undefined ? {} : { workerGate: gate }),
      pendingProducerBlockers: overrides.pendingProducerBlockers ?? pendingProducerBlockers,
      log: () => {},
      setInterval: ((fn: () => void, ms?: number) => {
        interval.fn = fn;
        interval.period = ms ?? null;
        interval.started += 1;
        return 1 as unknown as NodeJS.Timeout;
      }) as unknown as typeof setInterval,
      clearInterval: ((() => {
        interval.cleared += 1;
        return undefined;
      }) as unknown) as typeof clearInterval,
      ...(crashAt.length > 0 ? { afterStep: (step: OwnerApprovalStep) => {
        if (crashAt.includes(step)) throw new Error(`fixture crash after ${step}`);
      } } : {}),
    });
  };

  service.current = makeService();
  const decisions = new DecisionRuntime(cfg.decisions, {
    instanceDir: cfg.instanceDir,
    env: { GRU_COMMAND_HOME: cfg.instanceDir },
    home: '/home/tester',
    watchConfig: false,
  });
  const board = createBoardServer({
    config: cfg,
    engine: new BoardEngine({ ledger, bus }),
    ledger,
    transcripts: new TranscriptService(join(dir, 'sessions'), { ledger }),
    bus,
    notifications,
    decisionsStatus: () => decisions.status(),
    onDecisionsRecheck: () => decisions.recheck(),
    pushDebounceMs: 10,
  });
  const server = createDispatchServer({
    config: cfg,
    dispatch,
    wave,
    ledger,
    pendingProducerBlockers,
    silasOps: { registry, worktrees, notifications },
    ...(options.host === false ? {} : {
      ownerApprovals: { handle: (req, res, path) => service.current.handle(req, res, path) },
    }),
  });
  const http: HttpServer = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (server.requestHook(req, res, path)) return;
    if (board.requestHook(req, res, path)) return;
    res.writeHead(404);
    res.end();
  });
  board.attach(http);
  await new Promise<void>((resolveListen) => http.listen(0, '127.0.0.1', resolveListen));
  const port = (http.address() as AddressInfo).port;

  const harness: Harness = {
    dir,
    port,
    ledger,
    db,
    bus,
    notifications,
    worktrees,
    server,
    board,
    interval,
    service,
    spawns,
    restart(restartOptions: BootOptions = {}): OwnerApprovalService {
      service.current.stop();
      service.current = makeService(restartOptions);
      return service.current;
    },
    close: async () => {
      service.current.stop();
      server.dispose();
      await board.dispose();
      decisions.dispose();
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
      db.close();
    },
  };
  harnesses.push(harness);
  if (options.startService !== false) service.current.start();
  return harness;
}

async function call(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = TOKEN,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      connection: 'close',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
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

const REASON = 'original producer custody cannot be established';

function proposalBody(requestId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'directive-abandon', request_id: requestId, reason: REASON, by: 'gru', idempotency_key: `key-${requestId}`, ...overrides };
}

async function propose(h: Harness, requestId: string, overrides: Record<string, unknown> = {}): Promise<{ status: number; json: unknown }> {
  return call(h.port, 'POST', '/api/owner-approvals', proposalBody(requestId, overrides));
}

/** Every owner-approval card posted so far. */
function approvalCards(h: Harness): readonly NotificationRecord[] {
  return h.ledger.listNotifications({ limit: 500 }).filter((row) => row.kind === DIRECTIVE_ABANDON_CARD_KIND);
}

function approvalCard(h: Harness, notificationId: string): NotificationRecord {
  const card = h.ledger.getNotification(notificationId);
  if (card === null) throw new Error(`no owner-approval card ${notificationId}`);
  return card;
}

/** One recorded choice through the board's real decision route. */
async function decide(h: Harness, cardId: string, optionId: string, by?: string): Promise<{ status: number; json: unknown }> {
  const card = h.ledger.getNotification(cardId);
  if (card === null || card.decision === null) throw new Error(`no decidable card ${cardId}`);
  return call(h.port, 'POST', `/api/notifications/${encodeURIComponent(cardId)}/decision`, {
    optionId,
    ...(by === undefined ? {} : { by }),
    expectedDecision: card.decision,
  });
}

/** The approval a proposal answered with. */
function createdApproval(response: { status: number; json: unknown }): Record<string, unknown> {
  return field<Record<string, unknown>>(response.json, 'approval');
}

function eventsOfKind(h: Harness, kind: string): readonly { readonly seq: number; readonly payload: Record<string, unknown> }[] {
  return h.ledger.listEvents({ limit: 1_000 })
    .filter((event) => event.kind === kind)
    .map((event) => ({ seq: event.seq, payload: (event.payload ?? {}) as Record<string, unknown> }));
}

function countEvents(h: Harness, kind: string): number {
  return eventsOfKind(h, kind).length;
}

function abandonmentEvents(h: Harness): readonly { readonly seq: number; readonly payload: Record<string, unknown> }[] {
  return eventsOfKind(h, 'silas.directive-abandoned');
}

/** The request's state as the readback names it, for the "request first" assertions. */
function requestState(h: Harness, requestId: string): string | null {
  const row = h.ledger.getDirective(requestId);
  return row === null ? null : row.abandonedAt !== null ? 'abandoned' : row.state;
}

/** The one card kind's resolution event detail. */
function resolutionDetail(h: Harness, cardId: string): unknown {
  const resolved = eventsOfKind(h, 'notification.resolved').find((event) => event.payload['id'] === cardId);
  return resolved?.payload['detail'];
}

/** Retire a live request the ordinary way (a fixture that only needs "no longer live"). */
function retireLive(h: Harness, requestId: string, lane: WorktreeLane): void {
  const row = h.ledger.getDirective(requestId);
  if (row === null) throw new Error(`no request ${requestId}`);
  const head = resolveGitCommit(lane.path, 'HEAD');
  const authority = h.ledger.directiveCurrentAuthority(row.jobId);
  const obligation = h.ledger.recoveryObligation(row.jobId, 'directive', requestId);
  h.ledger.retireInterruptedDirective({ requestId, expectedJobId: row.jobId, expectedState: row.state as 'dispatching' | 'admitted',
    expectedPayloadHash: row.payloadHash, expectedHead: head, expectedGeneration: obligation?.generation ?? null,
    expectedPlanRevision: obligation?.planRevision ?? null, expectedObligationState: obligation?.state ?? null,
    expectedAuthorityEpoch: authority.authorityEpoch, expectedWorkRevision: authority.workRevision,
    expectedContractSha256: authority.contractSha256, lane: { id: lane.id, resolvedHead: head },
    reason: 'writer ceased; no terminal receipt can exist', by: 'silas-ops' });
}

async function jobLane(h: Harness, jobId: string): Promise<WorktreeLane> {
  const [lane] = await h.worktrees.listWorktrees({ jobId });
  if (lane === undefined) throw new Error(`no lane for ${jobId}`);
  return lane;
}

describe('owner approval of abandonment', () => {
  it('abandons an unknown-custody request as outcome-unknown and closes the card with what happened', async () => {
    const repo = makeFixtureRepo('oa-unknown-custody');
    cleanupRepos.push(repo);
    const h = await boot();
    await historicalLiveRequest(h, repo, 'job-debt', 'req-debt');
    surfaceDirectiveRecovery({ ledger: h.ledger, notifications: h.notifications }, 'req-debt', 'restart interrupted the writer');
    const debt = h.ledger.recoveryObligation('job-debt', 'directive', 'req-debt')!;
    const proposal = await propose(h, 'req-debt');
    const approval = createdApproval(proposal);
    const id = field<string>(approval, 'id');
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    await decide(h, card.id, 'approve', 'owner');

    // The request first: the owner's Approve closed it.
    expect(requestState(h, 'req-debt')).toBe('abandoned');
    expect(h.ledger.getOwnerApproval(id)).toMatchObject({ state: 'succeeded', attempts: 0 });
    const abandonments = abandonmentEvents(h);
    expect(abandonments).toHaveLength(1);
    expect(abandonments[0]!.payload).toMatchObject({ by: 'owner', reason: `${ownerApprovalReasonPrefix(id)}${REASON}` });
    expect(h.ledger.getOwnerApproval(id)?.abandonmentEventSeq).toBe(abandonments[0]!.seq);
    // What a native /abandon ends: the request's own debt and card.
    expect(h.ledger.getObligation(debt.id)).toMatchObject({ state: 'closed' });
    expect(h.ledger.recoveryObligation('job-debt', 'directive', 'req-debt')).toBeNull();
    expect(h.ledger.findNotificationByKind('silas.directive-unreconciled.req-debt', 'active')).toBeNull();
    // The proposal card closes with the succeeded text.
    const resolved = approvalCard(h, card.id);
    expect(resolved.resolvedAt).not.toBeNull();
    expect(resolved.resolvedBy).toBe('gru');
    expect(resolutionDetail(h, card.id)).toBe(`Abandoned as outcome-unknown (abandonment event seq ${String(abandonments[0]!.seq)}).`);
    // Nothing replayed, nothing spawned: no turn, delivery or retirement.
    expect(h.spawns).toEqual([]);
    for (const kind of ['silas.directive-sent', 'job.delivered', 'silas.directive-retired']) {
      expect(countEvents(h, kind), kind).toBe(0);
    }
  });

  it('abandons a live request on a merged job whose lane is gone: the job stays merged and nothing is replayed', async () => {
    const repo = makeFixtureRepo('oa-merged-job');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await historicalLiveRequest(h, repo, 'job-bound', 'req-bound');
    h.ledger.registerAgent({ id: 'minion-bound', role: 'minion', jobId: 'job-bound', sessionFile: join(h.dir, 'none.jsonl') });
    h.ledger.setAgentState('minion-bound', 'idle');
    const sent = h.ledger.appendCustomEvent({ kind: 'silas.directive-sent', jobId: 'job-bound', payload: { request_id: 'req-bound', minion_id: 'minion-bound' } });
    h.ledger.recordDirectiveAdmission({ requestId: 'req-bound', minionId: 'minion-bound', eventSeq: sent.seq });
    surfaceDirectiveRecovery({ ledger: h.ledger, notifications: h.notifications }, 'req-bound', 'restart interrupted the writer');
    h.ledger.setJobStatus('job-bound', 'in-review');
    h.ledger.setJobStatus('job-bound', 'merged');
    observeTerminalJobDirective({ ledger: h.ledger, notifications: h.notifications } as unknown as Parameters<typeof observeTerminalJobDirective>[0], 'req-bound');
    // The lane is gone: resolveRetirementLane reports it unavailable.
    await h.worktrees.release({ worktreeId: lane.id });
    const proposal = await propose(h, 'req-bound');
    const approval = createdApproval(proposal);
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    await decide(h, card.id, 'approve', 'owner');

    expect(requestState(h, 'req-bound')).toBe('abandoned');
    expect(h.ledger.getJob('job-bound')?.status).toBe('merged');
    expect(h.ledger.getOwnerApproval(field<string>(approval, 'id'))?.state).toBe('succeeded');
    // Unknown custody as outcome-unknown: no completion, no no-effect, no cessation claim.
    const abandoned = abandonmentEvents(h);
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]!.payload['claims']).toBe('none: no completion, no no-effect, no cessation');
    expect((abandoned[0]!.payload['retirement_refused'] as string[]).join('\n')).toContain('no live lane worktree');
    // The fixture's own admission evidence stands; the approval replays nothing.
    expect(countEvents(h, 'silas.directive-sent')).toBe(1);
    expect(countEvents(h, 'silas.directive-retired')).toBe(0);
    expect(countEvents(h, 'job.delivered')).toBe(0);
    expect(h.ledger.findNotificationByKind('silas.directive-unreconciled.req-bound', 'active')).toBeNull();
  });

  it('a Deny runs nothing and closes the card with the denied text', async () => {
    const repo = makeFixtureRepo('oa-deny');
    cleanupRepos.push(repo);
    const h = await boot();
    await historicalLiveRequest(h, repo, 'job-deny', 'req-deny');
    const proposal = await propose(h, 'req-deny');
    const approval = createdApproval(proposal);
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    expect((await decide(h, card.id, 'deny', 'owner')).status).toBe(200);

    expect(requestState(h, 'req-deny')).toBe('dispatching');
    expect(h.ledger.getOwnerApproval(field<string>(approval, 'id'))?.state).toBe('denied');
    expect(abandonmentEvents(h)).toEqual([]);
    expect(approvalCard(h, card.id).resolvedAt).not.toBeNull();
    expect(resolutionDetail(h, card.id)).toBe('Denied by the owner; nothing was run.');
  });

  it('refuses retirement_available and names ordinary retirement on the card', async () => {
    const repo = makeFixtureRepo('oa-retirement-available');
    cleanupRepos.push(repo);
    const h = await boot();
    await seededLiveRequest(h, repo, 'job-retire', 'req-retire');
    const proposal = await propose(h, 'req-retire');
    const approval = createdApproval(proposal);
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    await decide(h, card.id, 'approve', 'owner');

    expect(requestState(h, 'req-retire')).toBe('dispatching');
    const record = h.ledger.getOwnerApproval(field<string>(approval, 'id'))!;
    expect(record.state).toBe('refused');
    expect(record.refusal).toEqual({ code: 'retirement_available', blockers: [] });
    expect(resolutionDetail(h, card.id)).toBe('Not run: retirement_available\nOrdinary retirement is available; Gru retires it instead.');
    expect(abandonmentEvents(h)).toEqual([]);
  });
});

describe('owner approval — the Approve is bound to the fences read when Gru asked', () => {
  const stale = async (
    label: string,
    stage: (h: Harness, requestId: string, lane: WorktreeLane) => string,
    expected: (requestId: string) => string,
  ): Promise<void> => {
    const repo = makeFixtureRepo(`oa-stale-${label}`);
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await historicalLiveRequest(h, repo, `job-stale-${label}`, `req-stale-${label}`);
    const proposal = await propose(h, `req-stale-${label}`);
    const approval = createdApproval(proposal);
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    const blocker = stage(h, `req-stale-${label}`, lane);
    await decide(h, card.id, 'approve', 'owner');
    expect(requestState(h, `req-stale-${label}`)).toBe(expected(`req-stale-${label}`));
    const record = h.ledger.getOwnerApproval(field<string>(approval, 'id'))!;
    expect(record.state).toBe('refused');
    expect(record.refusal).toEqual({ code: 'stale-fence', blockers: [blocker] });
    expect(abandonmentEvents(h)).toEqual([]);
  };

  it('refuses a changed state', async () => {
    await stale('state', (h, requestId) => {
      const before = h.ledger.getDirective(requestId)!;
      const sent = h.ledger.appendCustomEvent({ kind: 'silas.directive-sent', jobId: before.jobId, payload: { request_id: requestId, minion_id: 'minion-admitted' } });
      h.ledger.recordDirectiveAdmission({ requestId, minionId: 'minion-admitted', eventSeq: sent.seq });
      return `state: expected ${before.state}, actual admitted`;
    }, () => 'admitted');
  });

  it('refuses a changed payload hash (staged by direct SQL: no production path changes it)', async () => {
    await stale('hash', (h, requestId) => {
      const before = h.ledger.getDirective(requestId)!;
      const staged = 'a'.repeat(64);
      // Test-only stage: an accepted request's payload hash is immutable
      // through every production path, so this fence is only reachable by
      // writing the column the way a schema-level stand-in would.
      (h.ledger as unknown as { readonly db: DatabaseSync }).db
        .prepare('UPDATE pending_directives SET payload_hash = ? WHERE request_id = ?').run(staged, requestId);
      return `payload_hash: expected ${before.payloadHash}, actual ${staged}`;
    }, () => 'dispatching');
  });

  it('refuses a changed recovery-debt generation', async () => {
    await stale('debt', (h, requestId) => {
      const debt = h.ledger.openDirectiveRecoveryDebt(requestId, 'fixture: a restart interrupted the writer');
      return `debt_generation: expected null, actual ${String(debt.generation)}`;
    }, () => 'dispatching');
  });

  it('refuses abandoned-elsewhere when another route abandoned the request after the Approve was recorded', async () => {
    const repo = makeFixtureRepo('oa-abandoned-elsewhere');
    cleanupRepos.push(repo);
    const h = await boot({ crashAt: ['approved-written'] });
    await historicalLiveRequest(h, repo, 'job-elsewhere', 'req-elsewhere');
    const proposal = await propose(h, 'req-elsewhere');
    const approval = createdApproval(proposal);
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    await decide(h, card.id, 'approve', 'owner');
    expect(h.ledger.getOwnerApproval(field<string>(approval, 'id'))?.state).toBe('approved');
    // The owner's terminal route, not this service, closes the request.
    const row = h.ledger.getDirective('req-elsewhere')!;
    const abandoned = await call(h.port, 'POST', '/api/silas/directives/req-elsewhere/abandon', {
      expected_job_id: row.jobId, expected_state: row.state, expected_payload_hash: row.payloadHash,
      reason: 'owner closed it directly', by: 'owner', confirm_intent: true,
    });
    expect(abandoned.status).toBe(200);
    h.restart().reconcile();
    expect(requestState(h, 'req-elsewhere')).toBe('abandoned');
    const record = h.ledger.getOwnerApproval(field<string>(approval, 'id'))!;
    expect(record.state).toBe('refused');
    expect(record.refusal?.code).toBe('abandoned-elsewhere');
    // Exactly the route's one abandonment: this service ran none.
    expect(abandonmentEvents(h)).toHaveLength(1);
    expect(abandonmentEvents(h)[0]!.payload['reason']).toBe('owner closed it directly');
  });

  it('refuses live_work when a producer appears after the proposal, and reconcile never asks twice', async () => {
    const repo = makeFixtureRepo('oa-live-work');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await historicalLiveRequest(h, repo, 'job-live', 'req-live');
    const proposal = await propose(h, 'req-live');
    const approval = createdApproval(proposal);
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    h.ledger.recordWorktreeProcesses({ worktreeId: lane.id, processes: [{ pid: 4242, command: 'node writer.js', evidence: 'cwd' }], state: 'live' });
    await decide(h, card.id, 'approve', 'owner');

    expect(requestState(h, 'req-live')).toBe('dispatching');
    const record = h.ledger.getOwnerApproval(field<string>(approval, 'id'))!;
    expect(record.state).toBe('refused');
    expect(record.refusal?.code).toBe('live_work');
    expect(record.refusal?.blockers).toContain(`live lane process(es): ${lane.id} pid 4242`);
    const cards = approvalCards(h).length;
    const ids = h.ledger.listActiveOwnerApprovalIds();
    const events = h.ledger.listEvents({ limit: 1_000 }).map((event) => event.seq);
    const once = h.restart();
    once.reconcile();
    once.reconcile();
    expect(approvalCards(h).length).toBe(cards);
    expect(h.ledger.listActiveOwnerApprovalIds()).toEqual(ids);
    expect(h.ledger.listEvents({ limit: 1_000 }).map((event) => event.seq)).toEqual(events);
    expect(abandonmentEvents(h)).toEqual([]);
  });

  it('refuses every decider that is not exactly owner, with Approve and with Deny', async () => {
    const repo = makeFixtureRepo('oa-deciders');
    cleanupRepos.push(repo);
    const h = await boot();
    const deciders = [undefined, 'gru', 'Gru', 'silas', ' owner'] as const;
    for (const [index, decider] of deciders.entries()) {
      for (const option of ['approve', 'deny'] as const) {
        const requestId = `req-decider-${String(index)}-${option}`;
        await historicalLiveRequest(h, repo, `job-decider-${String(index)}-${option}`, requestId);
        const proposal = await propose(h, requestId);
        const approval = createdApproval(proposal);
        const card = approvalCard(h, field<string>(approval, 'notification_id'));
        const recorded = await decide(h, card.id, option, decider);
        const label = `${String(decider)} ${option}`;
        expect(recorded.status, label).toBe(200);
        expect(h.ledger.getNotification(card.id)?.decidedBy, label).toBe(decider ?? 'web');
        expect(requestState(h, requestId), label).toBe('dispatching');
        const record = h.ledger.getOwnerApproval(field<string>(approval, 'id'))!;
        expect(record.state, label).toBe('refused');
        expect(record.refusal?.code, label).toBe('decider-not-owner');
        expect(record.refusal?.blockers, label).toContain(`decided by ${JSON.stringify(decider ?? 'web')}, not "owner"`);
      }
    }
    expect(abandonmentEvents(h)).toEqual([]);
    expect(h.spawns).toEqual([]);
  });
});

describe('owner approval — crash windows finish on reconcile, never twice', () => {
  it('record written, card not posted: reconcile (a) posts it once', async () => {
    const repo = makeFixtureRepo('oa-crash-record');
    cleanupRepos.push(repo);
    const h = await boot({ crashAt: ['record-written'] });
    await historicalLiveRequest(h, repo, 'job-c1', 'req-c1');
    expect((await propose(h, 'req-c1')).status).toBe(400);
    const [id] = h.ledger.listActiveOwnerApprovalIds();
    const record = h.ledger.getOwnerApproval(id!)!;
    expect(record.state).toBe('proposed');
    expect(h.ledger.getNotification(record.notificationId)).toBeNull();
    const restarted = h.restart();
    restarted.start();
    restarted.reconcile();
    expect(h.ledger.getNotification(record.notificationId)).not.toBeNull();
    expect(approvalCards(h)).toHaveLength(1);
    expect(h.ledger.listActiveOwnerApprovalIds()).toEqual([id]);
    // The posted card still carries the owner's Approve to the native abandonment.
    await decide(h, record.notificationId, 'approve', 'owner');
    expect(requestState(h, 'req-c1')).toBe('abandoned');
    expect(h.ledger.getOwnerApproval(id!)?.state).toBe('succeeded');
    expect(abandonmentEvents(h)).toHaveLength(1);
  });

  it('a decision recorded while no service was subscribed: the next start (b) processes it', async () => {
    const repo = makeFixtureRepo('oa-crash-decision');
    cleanupRepos.push(repo);
    const h = await boot({ startService: false });
    await historicalLiveRequest(h, repo, 'job-c2', 'req-c2');
    const proposal = await propose(h, 'req-c2');
    const approval = createdApproval(proposal);
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    expect((await decide(h, card.id, 'approve', 'owner')).status).toBe(200);
    // No subscriber ran it: the record is still proposed and the request live.
    expect(requestState(h, 'req-c2')).toBe('dispatching');
    expect(h.ledger.getOwnerApproval(field<string>(approval, 'id'))?.state).toBe('proposed');
    h.service.current.start();
    expect(requestState(h, 'req-c2')).toBe('abandoned');
    expect(h.ledger.getOwnerApproval(field<string>(approval, 'id'))?.state).toBe('succeeded');
    expect(abandonmentEvents(h)).toHaveLength(1);
  });

  it('approved written, execution not started: reconcile (c) revalidates and executes once', async () => {
    const repo = makeFixtureRepo('oa-crash-approved');
    cleanupRepos.push(repo);
    const h = await boot({ crashAt: ['approved-written'] });
    await historicalLiveRequest(h, repo, 'job-c3', 'req-c3');
    const proposal = await propose(h, 'req-c3');
    const approval = createdApproval(proposal);
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    await decide(h, card.id, 'approve', 'owner');
    expect(requestState(h, 'req-c3')).toBe('dispatching');
    expect(h.ledger.getOwnerApproval(field<string>(approval, 'id'))?.state).toBe('approved');
    const restarted = h.restart();
    restarted.reconcile();
    restarted.reconcile();
    expect(requestState(h, 'req-c3')).toBe('abandoned');
    expect(h.ledger.getOwnerApproval(field<string>(approval, 'id'))?.state).toBe('succeeded');
    expect(abandonmentEvents(h)).toHaveLength(1);
  });

  it('ledger abandoned, record not settled: reconcile (d) reads its own audit as succeeded', async () => {
    const repo = makeFixtureRepo('oa-crash-ledger');
    cleanupRepos.push(repo);
    const h = await boot({ crashAt: ['ledger-abandoned'] });
    await historicalLiveRequest(h, repo, 'job-c4', 'req-c4');
    const proposal = await propose(h, 'req-c4');
    const approval = createdApproval(proposal);
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    await decide(h, card.id, 'approve', 'owner');
    expect(requestState(h, 'req-c4')).toBe('abandoned');
    expect(h.ledger.getOwnerApproval(field<string>(approval, 'id'))?.state).toBe('executing');
    const own = abandonmentEvents(h);
    expect(own).toHaveLength(1);
    const restarted = h.restart();
    restarted.reconcile();
    restarted.reconcile();
    const record = h.ledger.getOwnerApproval(field<string>(approval, 'id'))!;
    expect(record.state).toBe('succeeded');
    expect(record.abandonmentEventSeq).toBe(own[0]!.seq);
    expect(abandonmentEvents(h)).toHaveLength(1);
  });

  it('a foreign abandonment after executing was written: reconcile (d) refuses abandoned-elsewhere', async () => {
    const repo = makeFixtureRepo('oa-crash-foreign');
    cleanupRepos.push(repo);
    const h = await boot({ crashAt: ['executing-written'] });
    await historicalLiveRequest(h, repo, 'job-c5', 'req-c5');
    const proposal = await propose(h, 'req-c5');
    const approval = createdApproval(proposal);
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    await decide(h, card.id, 'approve', 'owner');
    expect(h.ledger.getOwnerApproval(field<string>(approval, 'id'))?.state).toBe('executing');
    const row = h.ledger.getDirective('req-c5')!;
    const abandoned = await call(h.port, 'POST', '/api/silas/directives/req-c5/abandon', {
      expected_job_id: row.jobId, expected_state: row.state, expected_payload_hash: row.payloadHash,
      reason: 'the owner closed it on the terminal route', by: 'owner', confirm_intent: true,
    });
    expect(abandoned.status).toBe(200);
    expect(requestState(h, 'req-c5')).toBe('abandoned');
    h.restart().reconcile();
    expect(requestState(h, 'req-c5')).toBe('abandoned');
    const record = h.ledger.getOwnerApproval(field<string>(approval, 'id'))!;
    expect(record.state).toBe('refused');
    expect(record.refusal?.code).toBe('abandoned-elsewhere');
    expect(abandonmentEvents(h)).toHaveLength(1);
  });

  it('executing written with no abandonment: reconcile (e) revalidates and executes once', async () => {
    const repo = makeFixtureRepo('oa-crash-executing');
    cleanupRepos.push(repo);
    const h = await boot({ crashAt: ['executing-written'] });
    await historicalLiveRequest(h, repo, 'job-c6', 'req-c6');
    const proposal = await propose(h, 'req-c6');
    const approval = createdApproval(proposal);
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    await decide(h, card.id, 'approve', 'owner');
    expect(h.ledger.getOwnerApproval(field<string>(approval, 'id'))?.state).toBe('executing');
    expect(requestState(h, 'req-c6')).toBe('dispatching');
    const restarted = h.restart();
    restarted.reconcile();
    restarted.reconcile();
    expect(requestState(h, 'req-c6')).toBe('abandoned');
    expect(h.ledger.getOwnerApproval(field<string>(approval, 'id'))?.state).toBe('succeeded');
    expect(abandonmentEvents(h)).toHaveLength(1);
  });

  it('terminal written, card open: reconcile (f) closes the card with the succeeded text', async () => {
    const repo = makeFixtureRepo('oa-crash-terminal');
    cleanupRepos.push(repo);
    const h = await boot({ crashAt: ['terminal-written'] });
    await historicalLiveRequest(h, repo, 'job-c7', 'req-c7');
    const proposal = await propose(h, 'req-c7');
    const approval = createdApproval(proposal);
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    await decide(h, card.id, 'approve', 'owner');
    expect(requestState(h, 'req-c7')).toBe('abandoned');
    const record = h.ledger.getOwnerApproval(field<string>(approval, 'id'))!;
    expect(record.state).toBe('succeeded');
    expect(approvalCard(h, card.id).resolvedAt).toBeNull();
    h.restart().reconcile();
    expect(approvalCard(h, card.id).resolvedAt).not.toBeNull();
    expect(resolutionDetail(h, card.id)).toBe(`Abandoned as outcome-unknown (abandonment event seq ${String(record.abandonmentEventSeq)}).`);
  });

  it('card withdrawn, record still proposed: reconcile (g) ends it withdrawn', async () => {
    const repo = makeFixtureRepo('oa-crash-withdrawn');
    cleanupRepos.push(repo);
    const h = await boot({ crashAt: ['card-withdrawn'] });
    await seededLiveRequest(h, repo, 'job-c8', 'req-c8');
    const proposal = await propose(h, 'req-c8');
    const approval = createdApproval(proposal);
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    retireLive(h, 'req-c8', await jobLane(h, 'job-c8'));
    // The withdraw path runs on reconcile: card withdrawn, then the crash.
    h.service.current.reconcile();
    expect(requestState(h, 'req-c8')).toBe('retired');
    expect(h.ledger.getOwnerApproval(field<string>(approval, 'id'))?.state).toBe('proposed');
    expect(approvalCard(h, card.id).resolvedBy).toBe('producer-withdrawn');
    h.restart().reconcile();
    expect(requestState(h, 'req-c8')).toBe('retired');
    expect(h.ledger.getOwnerApproval(field<string>(approval, 'id'))?.state).toBe('withdrawn');
    expect(h.ledger.listActiveOwnerApprovalIds()).toEqual([]);
    expect(abandonmentEvents(h)).toEqual([]);
  });

  it('succeeds once with a real card close, and a second reconcile appends nothing', async () => {
    const repo = makeFixtureRepo('oa-once');
    cleanupRepos.push(repo);
    const h = await boot();
    await historicalLiveRequest(h, repo, 'job-once', 'req-once');
    const proposal = await propose(h, 'req-once');
    const approval = createdApproval(proposal);
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    await decide(h, card.id, 'approve', 'owner');
    expect(requestState(h, 'req-once')).toBe('abandoned');
    const seqs = h.ledger.listEvents({ limit: 1_000 }).map((event) => event.seq);
    h.restart().reconcile();
    expect(h.ledger.listEvents({ limit: 1_000 }).map((event) => event.seq)).toEqual(seqs);
    expect(abandonmentEvents(h)).toHaveLength(1);
  });
});

describe('owner approval — a failing action is bounded and says so without leaking a credential', () => {
  const SENTINEL = 'AbCdEf123456';

  it('counts attempts across restarts and refuses execution-error on the third', async () => {
    const repo = makeFixtureRepo('oa-execution-error');
    cleanupRepos.push(repo);
    const h = await boot();
    await historicalLiveRequest(h, repo, 'job-e1', 'req-e1');
    const proposal = await propose(h, 'req-e1');
    const approval = createdApproval(proposal);
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    vi.spyOn(h.ledger, 'abandonLiveDirective').mockImplementation(() => {
      throw new Error(`native abandonment transport failed (Authorization: Bearer ${SENTINEL}) while the ledger was busy`);
    });
    await decide(h, card.id, 'approve', 'owner');
    expect(h.ledger.getOwnerApproval(field<string>(approval, 'id'))).toMatchObject({ state: 'executing', attempts: 1 });
    h.restart().reconcile();
    expect(h.ledger.getOwnerApproval(field<string>(approval, 'id'))).toMatchObject({ state: 'executing', attempts: 2 });
    h.restart().reconcile();
    expect(requestState(h, 'req-e1')).toBe('dispatching');
    const record = h.ledger.getOwnerApproval(field<string>(approval, 'id'))!;
    expect(record.state).toBe('refused');
    expect(record.attempts).toBe(3);
    expect(countEvents(h, 'owner-approval.attempt-failed')).toBe(OWNER_APPROVAL_MAX_ATTEMPTS);
    expect(record.refusal?.code).toBe('execution-error');
    const message = record.refusal?.blockers[0] ?? '';
    expect([...message].length).toBeLessThanOrEqual(300);
    expect(message).not.toContain(SENTINEL);
    expect(message).toContain('Bearer');
    expect(abandonmentEvents(h)).toEqual([]);
    expect(approvalCard(h, card.id).resolvedAt).not.toBeNull();
  });
});

describe('owner approval — proposal answers and readback', () => {
  it('answers 201, 200 for a same-body replay, 409 for a changed body, 409 while pending, 409 not live and 404 unknown', async () => {
    const repo = makeFixtureRepo('oa-answers');
    cleanupRepos.push(repo);
    const h = await boot();
    await seededLiveRequest(h, repo, 'job-a1', 'req-a1');
    const created = await propose(h, 'req-a1');
    expect(created.status).toBe(201);
    expect(createdApproval(created)).toMatchObject({ kind: 'directive-abandon', request_id: 'req-a1', job_id: 'job-a1',
      state: 'proposed', attempts: 0, reason: REASON });
    // Same key and same body: the same proposal.
    const replayed = await propose(h, 'req-a1');
    expect(replayed.status).toBe(200);
    expect(field<string>(createdApproval(replayed), 'id')).toBe(field<string>(createdApproval(created), 'id'));
    expect(approvalCards(h)).toHaveLength(1);
    // Same key, different body.
    const conflict = await propose(h, 'req-a1', { reason: 'a different reason' });
    expect(conflict.status).toBe(409);
    expect(field<string>(conflict.json, 'error')).toBe('owner_approval_key_conflict');
    // Another key while the request's record is still open.
    const pending = await propose(h, 'req-a1', { idempotency_key: 'another-key' });
    expect(pending.status).toBe(409);
    expect(field<string>(pending.json, 'error')).toBe('owner_approval_pending');
    expect(field<string>(pending.json, 'approval_id')).toBe(field<string>(createdApproval(created), 'id'));
    // An unknown request.
    const unknown = await propose(h, 'req-missing');
    expect(unknown.status).toBe(404);
    expect(field<string>(unknown.json, 'error')).toBe('owner_approval_unknown_request');
    // A request that is no longer live.
    retireLive(h, 'req-a1', await jobLane(h, 'job-a1'));
    const notLive = await propose(h, 'req-a1', { idempotency_key: 'third-key' });
    expect(notLive.status).toBe(409);
    expect(field<string>(notLive.json, 'error')).toBe('owner_approval_not_live');
  });

  it('rejects malformed input and any producer other than gru', async () => {
    const repo = makeFixtureRepo('oa-input');
    cleanupRepos.push(repo);
    const h = await boot();
    await historicalLiveRequest(h, repo, 'job-i1', 'req-i1');
    const cases: readonly [string, Record<string, unknown>][] = [
      ['blank reason', { reason: '   ' }],
      ['carriage return', { reason: 'line one\rline two' }],
      ['DEL', { reason: `bad${String.fromCodePoint(0x7f)}byte` }],
      ['too long', { reason: 'x'.repeat(OWNER_APPROVAL_REASON_MAX_CHARS + 1) }],
      ['bad key', { idempotency_key: 'has spaces' }],
      ['empty key', { idempotency_key: '' }],
      ['owner attribution', { by: 'owner' }],
      ['missing by', { by: undefined }],
      ['unknown kind', { kind: 'rebrief-abandon' }],
    ];
    for (const [label, overrides] of cases) {
      const refused = await propose(h, 'req-i1', overrides);
      expect(refused.status, label).toBe(400);
      expect(field<string>(refused.json, 'error'), label).toBe('bad_request');
    }
    expect(approvalCards(h)).toEqual([]);
    expect(h.ledger.listActiveOwnerApprovalIds()).toEqual([]);
    // Tab and LF are allowed reason characters.
    const allowed = await propose(h, 'req-i1', { reason: 'custody\tunknown\nrestart' });
    expect(allowed.status).toBe(201);
  });

  it('refuses a card post that throws and ends the record card-post-failed', async () => {
    const repo = makeFixtureRepo('oa-card-post');
    cleanupRepos.push(repo);
    const h = await boot({ notifications: { post: () => { throw new Error('notification store unavailable'); } } });
    await historicalLiveRequest(h, repo, 'job-p1', 'req-p1');
    const created = await propose(h, 'req-p1');
    expect(created.status).toBe(201);
    expect(createdApproval(created)).toMatchObject({ state: 'refused', outcome: { refusal: { code: 'card-post-failed' } } });
    expect(requestState(h, 'req-p1')).toBe('dispatching');
    expect(approvalCards(h)).toEqual([]);
  });

  it('authenticates every route and answers 503 when the service is not hosted', async () => {
    const repo = makeFixtureRepo('oa-auth');
    cleanupRepos.push(repo);
    const h = await boot();
    await historicalLiveRequest(h, repo, 'job-auth', 'req-auth');
    expect((await call(h.port, 'POST', '/api/owner-approvals', proposalBody('req-auth'), null)).status).toBe(401);
    expect((await call(h.port, 'GET', '/api/owner-approvals/oa-missing', undefined, null)).status).toBe(401);
    expect((await call(h.port, 'POST', '/api/owner-approvals', proposalBody('req-auth'), 'wrong-token')).status).toBe(401);
    const missing = await call(h.port, 'GET', '/api/owner-approvals/oa-missing');
    expect(missing.status).toBe(404);
    expect(field<string>(missing.json, 'error')).toBe('owner_approval_not_found');
    const other = await boot({ host: false });
    const unhosted = await call(other.port, 'POST', '/api/owner-approvals', proposalBody('req-auth'));
    expect(unhosted.status).toBe(503);
    expect(field<string>(unhosted.json, 'error')).toBe('owner_approvals_not_hosted');
    expect((await call(other.port, 'GET', '/api/owner-approvals/oa-x')).status).toBe(503);
  });

  it('POST’s approval is exactly the GET body, with the four fences and ordered history', async () => {
    const repo = makeFixtureRepo('oa-readback');
    cleanupRepos.push(repo);
    const h = await boot();
    await historicalLiveRequest(h, repo, 'job-r1', 'req-r1');
    const created = await propose(h, 'req-r1');
    const approval = createdApproval(created);
    const id = field<string>(approval, 'id');
    const read = await call(h.port, 'GET', `/api/owner-approvals/${id}`);
    expect(read.status).toBe(200);
    expect(read.json).toEqual(approval);
    expect(read.json).toMatchObject({
      id,
      kind: 'directive-abandon',
      request_id: 'req-r1',
      job_id: 'job-r1',
      state: 'proposed',
      attempts: 0,
      notification_id: `owner-approval:${id}`,
      fences: { job_id: 'job-r1', state: 'dispatching', payload_hash: h.ledger.getDirective('req-r1')?.payloadHash, debt_generation: null },
      outcome: { abandonment_event_seq: null, refusal: null },
    });
    expect(field<unknown[]>(read.json, 'history')).toEqual([{ state: 'proposed', at: expect.any(String), detail: 'proposed by gru' }]);
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    await decide(h, card.id, 'approve', 'owner');
    const settled = await call(h.port, 'GET', `/api/owner-approvals/${id}`);
    expect(field<{ readonly state: string }[]>(settled.json, 'history').map((entry) => entry.state))
      .toEqual(['proposed', 'approved', 'executing', 'succeeded']);
    expect(field<Record<string, unknown>>(settled.json, 'outcome')).toMatchObject({
      abandonment_event_seq: abandonmentEvents(h)[0]!.seq, refusal: null });
  });
});

describe('owner approval — the card the owner answers', () => {
  it('carries every required field, the full reason and the four fences', async () => {
    const repo = makeFixtureRepo('oa-card-fields');
    cleanupRepos.push(repo);
    const h = await boot();
    await historicalLiveRequest(h, repo, 'job-f1', 'req-f1');
    const reason = `custody unknown: ${'detail '.repeat(70)}`.slice(0, OWNER_APPROVAL_REASON_MAX_CHARS);
    expect(reason.length).toBe(OWNER_APPROVAL_REASON_MAX_CHARS);
    const created = await propose(h, 'req-f1', { reason });
    const approval = createdApproval(created);
    const id = field<string>(approval, 'id');
    const row = h.ledger.getDirective('req-f1')!;
    const card = approvalCard(h, `owner-approval:${id}`);
    expect(card).toMatchObject({
      kind: DIRECTIVE_ABANDON_CARD_KIND,
      routing: 'needs-owner',
      severity: 'error',
      title: 'Abandon directive request req-f1?',
      agentId: null,
      decidedAt: null,
      resolvedAt: null,
    });
    expect(card.decision).toMatchObject({
      question: 'Abandon directive request req-f1 as outcome-unknown?',
      recommendation: null,
      reservedClass: 'destructive',
      whyNotDelegable: 'Abandonment is owner-reserved: only the owner may close a request whose producer custody is unknown.',
      discussion: false,
    });
    expect(card.decision?.context).toBe(`Request req-f1 on job job-f1 (dispatching). Reason: ${reason.slice(0, 200)}`);
    expect([...card.decision!.context].length).toBeLessThanOrEqual(600);
    expect(card.decision?.options.map((option) => option.id)).toEqual(['approve', 'deny']);
    expect(card.decision?.options[0]).toEqual({ id: 'approve', label: 'Approve',
      consequence: 'Closes the request as outcome-unknown. Nothing is replayed. No completion, no-effect or cessation is recorded. ' +
        "The job's status is unchanged. The lane stays held until the job is binned or fresh owner-accepted work is admitted there." });
    expect(card.decision?.options[1]).toEqual({ id: 'deny', label: 'Deny', consequence: 'Nothing runs. The request stays as it is.' });
    for (const option of card.decision!.options) expect([...option.consequence].length).toBeLessThanOrEqual(400);
    expect(card.detail).toContain(`Reason: ${reason}`);
    for (const fence of [`job_id: ${row.jobId}`, `state: ${row.state}`, `payload_hash: ${row.payloadHash}`, 'debt_generation: none']) {
      expect(card.detail, fence).toContain(fence);
    }
  });
});

describe('owner approval — reconcile, withdrawal and shutdown', () => {
  it('runs reconcile on the interval and stop() clears it', async () => {
    const repo = makeFixtureRepo('oa-interval');
    cleanupRepos.push(repo);
    const h = await boot({ crashAt: ['record-written'] });
    await historicalLiveRequest(h, repo, 'job-t1', 'req-t1');
    expect(h.interval.period).toBe(OWNER_APPROVAL_RECONCILE_INTERVAL_MS);
    expect(h.interval.started).toBe(1);
    expect((await propose(h, 'req-t1')).status).toBe(400);
    const [id] = h.ledger.listActiveOwnerApprovalIds();
    const record = h.ledger.getOwnerApproval(id!)!;
    expect(h.ledger.getNotification(record.notificationId)).toBeNull();
    // One reconcile (what an interval tick runs) posts the card the crash lost.
    h.service.current.reconcile();
    expect(h.ledger.getNotification(record.notificationId)).not.toBeNull();
    // One injected interval tick is one reconcile: it closes an open card of
    // an ended record.
    h.ledger.endOwnerApproval(id!, { state: 'withdrawn', detail: 'fixture: no choice is needed' });
    expect(approvalCard(h, record.notificationId).resolvedAt).toBeNull();
    h.interval.fn!();
    expect(approvalCard(h, record.notificationId).resolvedBy).toBe('producer-withdrawn');
    h.service.current.stop();
    expect(h.interval.cleared).toBe(1);
    h.service.current.stop();
    expect(h.interval.cleared).toBe(1);
  });

  it('withdraws a proposed card once its request is retired, leaving no non-terminal record', async () => {
    const repo = makeFixtureRepo('oa-withdraw');
    cleanupRepos.push(repo);
    const h = await boot();
    const { lane } = await seededLiveRequest(h, repo, 'job-w1', 'req-w1');
    const proposal = await propose(h, 'req-w1');
    const approval = createdApproval(proposal);
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    retireLive(h, 'req-w1', lane);
    h.service.current.reconcile();
    expect(requestState(h, 'req-w1')).toBe('retired');
    expect(h.ledger.getOwnerApproval(field<string>(approval, 'id'))?.state).toBe('withdrawn');
    expect(h.ledger.listActiveOwnerApprovalIds()).toEqual([]);
    expect(approvalCard(h, card.id).resolvedBy).toBe('producer-withdrawn');
    expect(abandonmentEvents(h)).toEqual([]);
  });

  it('a withdrawal that finds a recorded decision processes it instead', async () => {
    const repo = makeFixtureRepo('oa-withdraw-decided');
    cleanupRepos.push(repo);
    const h = await boot({ startService: false });
    await historicalLiveRequest(h, repo, 'job-w2', 'req-w2');
    const proposal = await propose(h, 'req-w2');
    const approval = createdApproval(proposal);
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    expect((await decide(h, card.id, 'approve', 'owner')).status).toBe(200);
    const row = h.ledger.getDirective('req-w2')!;
    expect((await call(h.port, 'POST', '/api/silas/directives/req-w2/abandon', {
      expected_job_id: row.jobId, expected_state: row.state, expected_payload_hash: row.payloadHash,
      reason: 'the owner closed it on the terminal route', by: 'owner', confirm_intent: true,
    })).status).toBe(200);
    h.service.current.start();
    expect(requestState(h, 'req-w2')).toBe('abandoned');
    const record = h.ledger.getOwnerApproval(field<string>(approval, 'id'))!;
    // The decision was carried out (and refused as stale), never withdrawn.
    expect(record.state).toBe('refused');
    expect(record.refusal?.code).toBe('abandoned-elsewhere');
    expect(approvalCard(h, card.id).resolvedBy).toBe('gru');
  });
});

describe('owner approval — registration and wiring', () => {
  it('registers the kind as owner-required, decision-required, producer-followed and producer-withdrawable', () => {
    expect(DIRECTIVE_ABANDON_CARD_KIND).toBe('owner-approval.directive-abandon');
    expect(ownerAttentionFor(DIRECTIVE_ABANDON_CARD_KIND)).toBe('owner-required');
    expect(requiresTypedDecision(DIRECTIVE_ABANDON_CARD_KIND)).toBe(true);
    expect(producerFollowsDecisionThrough(DIRECTIVE_ABANDON_CARD_KIND)).toBe(true);
    expect(producerWithdrawable(DIRECTIVE_ABANDON_CARD_KIND)).toBe(true);
    // Exactly one action: a lookalike kind is not registered.
    expect(requiresTypedDecision('owner-approval.directive-abandon.other')).toBe(false);
    expect(producerWithdrawable('owner-approval.directive-abandon.other')).toBe(false);
    expect(OWNER_APPROVAL_STATES).toEqual(['proposed', 'approved', 'executing', 'succeeded', 'denied', 'refused', 'withdrawn']);
  });

  it('serves the routes through the service itself, end to end', async () => {
    const repo = makeFixtureRepo('oa-direct-service');
    cleanupRepos.push(repo);
    const h = await boot({ startService: false });
    await historicalLiveRequest(h, repo, 'job-s1', 'req-s1');
    // A bare server that mounts only the service: no dispatch server in front.
    const http: HttpServer = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      void h.service.current.handle(req, res, path).then((handled) => {
        if (!handled && !res.headersSent) { res.writeHead(404); res.end(); }
      });
    });
    await new Promise<void>((resolveListen) => http.listen(0, '127.0.0.1', resolveListen));
    const port = (http.address() as AddressInfo).port;
    try {
      const created = await call(port, 'POST', '/api/owner-approvals', { ...proposalBody('req-s1'), idempotency_key: 'direct-key' });
      expect(created.status).toBe(201);
      const approval = createdApproval(created);
      const read = await call(port, 'GET', `/api/owner-approvals/${field<string>(approval, 'id')}`);
      expect(read.status).toBe(200);
      expect(read.json).toEqual(approval);
      h.service.current.start();
      await decide(h, field<string>(approval, 'notification_id'), 'approve', 'owner');
      expect(requestState(h, 'req-s1')).toBe('abandoned');
      expect(h.ledger.getOwnerApproval(field<string>(approval, 'id'))?.state).toBe('succeeded');
    } finally {
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
    }
  });

  it('main.ts constructs, starts and hosts the service and hands it to shutdown', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf-8');
    expect(source).toContain('const ownerApprovals: OwnerApprovalService | undefined =');
    expect(source).toContain('createOwnerApprovalService(');
    expect(source).toContain('ownerApprovals.start()');
    expect(source).toContain('state.ownerApprovals = ownerApprovals');
    // Passed to the dispatch server as its owner-approval surface.
    expect(source).toContain('...(ownerApprovals !== undefined ? { ownerApprovals } : {})');
    // Hosted only where the abandon route's worktrees are: Silas ops.
    expect(source).toContain('config.silas.enabled && silasSlot !== null');
    const shutdown = readFileSync(join(import.meta.dirname, '..', 'src', 'service-shutdown.ts'), 'utf-8');
    expect(shutdown).toContain('state.ownerApprovals.stop()');
  });
});

describe('owner approval — the text that sends Gru and the owner to the new route', () => {
  it('both unknown-custody cards ask for a proposal and carry no terminal recipe', async () => {
    const repo = makeFixtureRepo('oa-text');
    cleanupRepos.push(repo);
    const h = await boot();
    await historicalLiveRequest(h, repo, 'job-x1', 'req-x1');
    surfaceDirectiveRecovery({ ledger: h.ledger, notifications: h.notifications }, 'req-x1', 'restart interrupted the writer');
    const debtCard = h.ledger.findNotificationByKind('silas.directive-unreconciled.req-x1', 'active')!;
    // The terminal-job card is a different request's card: same kind, its own row.
    await historicalLiveRequest(h, repo, 'job-x2', 'req-x2');
    h.ledger.registerAgent({ id: 'minion-x2', role: 'minion', jobId: 'job-x2', sessionFile: join(h.dir, 'none-x2.jsonl') });
    h.ledger.setAgentState('minion-x2', 'idle');
    const sent = h.ledger.appendCustomEvent({ kind: 'silas.directive-sent', jobId: 'job-x2', payload: { request_id: 'req-x2', minion_id: 'minion-x2' } });
    h.ledger.recordDirectiveAdmission({ requestId: 'req-x2', minionId: 'minion-x2', eventSeq: sent.seq });
    h.ledger.setJobStatus('job-x2', 'in-review');
    h.ledger.setJobStatus('job-x2', 'merged');
    observeTerminalJobDirective({ ledger: h.ledger, notifications: h.notifications } as unknown as Parameters<typeof observeTerminalJobDirective>[0], 'req-x2');
    const terminalCard = h.ledger.findNotificationByKind('silas.directive-unreconciled.req-x2', 'active')!;
    expect(terminalCard.id).not.toBe(debtCard.id);
    const cases = [
      ['debt', debtCard.detail ?? '', 'It needs the owner: '],
      ['terminal', terminalCard.detail ?? '', 'if its producer custody is unknown, '],
    ] as const;
    for (const [label, detail, marker] of cases) {
      expect(detail, label).toContain('POST /api/owner-approvals');
      expect(detail, label).toContain('ask the owner whether to abandon it');
      expect(detail, label).not.toContain('confirm_intent');
      expect(detail, label).not.toContain('by "owner"');
      // The ask never spells the terminal URL. The same card still carries
      // the inspect/retire readback routes that are NOT this recipe, so the
      // URL assertion is scoped to the ask sentence, not the whole card.
      const ask = detail.slice(detail.indexOf(marker));
      expect(ask, label).toContain(marker);
      expect(ask, label).toContain('POST /api/owner-approvals');
      expect(ask, label).not.toContain('/api/silas/directives/');
      expect(ask, label).not.toContain('confirm_intent');
      expect(ask, label).not.toContain('by "owner"');
    }
  });

  it('roles/gru.md routes a directive request to the proposal and keeps the re-brief marker instruction', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'roles', 'gru.md'), 'utf-8').replace(/\s+/gu, ' ');
    expect(source).toContain('For a directive request, propose abandonment with `POST /api/owner-approvals`; the owner\'s Approve carries it out.');
    expect(source).toContain('For a re-brief marker, ask the owner whether to abandon it, quoting the card.');
    expect(source).toContain('Never call `/abandon`, record the owner\'s decision, or send owner attribution yourself.');
  });

  it('docs/DIRECTIVE-RECOVERY.md documents both routes, every state and every refusal code', () => {
    const doc = readFileSync(join(import.meta.dirname, '..', 'docs', 'DIRECTIVE-RECOVERY.md'), 'utf-8');
    expect(doc).toContain('Owner approval of abandonment');
    expect(doc).toContain('POST /api/owner-approvals');
    expect(doc).toContain('POST /api/silas/directives/{request_id}/abandon');
    for (const state of OWNER_APPROVAL_STATES) expect(doc, state).toContain(state);
    for (const code of ['card-post-failed', 'decider-not-owner', 'abandoned-elsewhere', 'stale-fence', 'execution-error',
      'retirement_available', 'live_work', 'directive_not_live', 'request_mismatch', 'terminal_receipt_present']) {
      expect(doc, code).toContain(code);
    }
    expect(doc).toContain('expectedDecision');
    expect(doc).toContain('confirm_intent');
  });
});

describe('owner approval — the abandonment audit stays attributable', () => {
  it('records the approval id in the native abandonment reason and the owner as its author', async () => {
    const repo = makeFixtureRepo('oa-audit');
    cleanupRepos.push(repo);
    const h = await boot();
    await historicalLiveRequest(h, repo, 'job-u1', 'req-u1');
    const created = await propose(h, 'req-u1');
    const approval = createdApproval(created);
    const card = approvalCard(h, field<string>(approval, 'notification_id'));
    await decide(h, card.id, 'approve', 'owner');
    expect(requestState(h, 'req-u1')).toBe('abandoned');
    const [abandonment] = abandonmentEvents(h);
    expect(abandonment!.payload).toMatchObject({ by: 'owner', request_id: 'req-u1',
      reason: `${ownerApprovalReasonPrefix(field<string>(approval, 'id'))}${REASON}` });
    const cardEvent = eventsOfKind(h, 'notification.decision').find((event) => event.payload['id'] === card.id);
    expect(cardEvent?.payload['by']).toBe('owner');
    expect(h.ledger.getOwnerApproval(field<string>(approval, 'id'))?.state).toBe('succeeded');
  });
});
