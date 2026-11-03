import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, type EventRecord } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { DirectiveProgressService, surfaceDirectiveRecovery } from '../src/dispatch/directive-progress.js';
import {
  binningCloseoutRoute,
  CanceledRequestCloseout,
  closeoutIntentView,
  runBootDirectiveRecovery,
  type CloseoutHttpResult,
  type CloseoutStep,
} from '../src/dispatch/canceled-request-closeout.js';
import type { DirectiveRegistry } from '../src/dispatch/fix-directive.js';
import { CLOSEOUT_ACTOR, CloseoutPendingError, closeoutBlockerFingerprint } from '../src/ledger/closeouts.js';
import { DirectiveRetirementError } from '../src/ledger/directives.js';
import { retireInterruptedDirectiveFromRoute } from '../src/dispatch/directive-recovery.js';
import { projectMailbox } from '../src/gru-mailbox/projection.js';
import type { PacingGate } from '../src/runtime/pacing.js';
import type { SpawnOptions } from '../src/runtime/types.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { markHistoricalDirectiveFixture, markLegacyTerminalJobFixture } from './helpers/directive-native-fixture.js';

/**
 * Canceled-request closeout (#523): binning a job whose only live request was
 * deferred before reaching its worker closes the request out completely,
 * resumably and idempotently, executed by the service. Real LedgerApi on a
 * temp database, real git lanes (fixture repo), no providers and no spawns.
 */

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
  vi.restoreAllMocks();
});

interface Ctx {
  readonly dir: string;
  readonly repo: FixtureRepo;
  readonly bus: EventBus;
  readonly worktrees: InMemoryWorktreePort;
  readonly spawns: SpawnOptions[];
  /** Supervisor ownership the closeout reads (empty = none). */
  supervised: string[];
  /** Pace-queue entries the closeout reads (empty = none). */
  queued: { id: string; label: string }[];
  /** Runs after S1 / S2 inside the closeout (throw = crash). */
  hook: ((step: CloseoutStep) => void) | undefined;
  db: LedgerDb;
  ledger: LedgerApi;
  notifications: NotificationCenter;
  closeout: CanceledRequestCloseout;
  readonly jobId: string;
  readonly requestId: string;
  /** The ledger's newest event once the fixture is built. */
  baselineSeq: number;
  /** Reopen the ledger on the same database file (a service restart). */
  restart(): void;
}

function makeCloseout(ctx: Ctx): CanceledRequestCloseout {
  return new CanceledRequestCloseout({
    ledger: ctx.ledger,
    worktrees: ctx.worktrees,
    pendingProducerBlockers: () => ctx.supervised,
    workerGate: { view: () => ({ worker: { queued: ctx.queued } }) } as unknown as Pick<PacingGate, 'view'>,
    afterStep: (step) => ctx.hook?.(step),
  });
}

function boot(jobId: string, requestId: string): Ctx {
  const dir = mkdtempSync(join(tmpdir(), 'gru-closeout-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const repo = makeFixtureRepo('closeout-app');
  cleanups.push(() => repo.cleanup());
  const bus = new EventBus({});
  const db = new LedgerDb(dir);
  const ledger = new LedgerApi(db.handle, { bus });
  const ctx: Ctx = {
    dir, repo, bus, jobId, requestId, baselineSeq: 0, spawns: [], supervised: [], queued: [], hook: undefined,
    worktrees: new InMemoryWorktreePort(join(dir, 'wtroot'), ledger),
    db, ledger, notifications: new NotificationCenter({ ledger, bus }),
    closeout: undefined as unknown as CanceledRequestCloseout,
    restart() {
      ctx.db.close();
      ctx.db = new LedgerDb(dir);
      ctx.ledger = new LedgerApi(ctx.db.handle, { bus });
      ctx.notifications = new NotificationCenter({ ledger: ctx.ledger, bus });
      ctx.closeout = makeCloseout(ctx);
    },
  };
  ctx.closeout = makeCloseout(ctx);
  cleanups.push(() => ctx.db.close());
  return ctx;
}

/** The "deferred" fixture, in the briefing's order: job and lane; a re-brief
 * request claimed for dispatch and positively deferred before any native
 * effect; the recovery debt and its card; the job parked last (when asked). */
async function seedDeferred(ctx: Ctx, jobId: string, requestId: string): Promise<void> {
  ctx.ledger.addJob({ id: jobId, repo: 'closeout-app', title: jobId, briefing: `briefing for ${jobId}` });
  ctx.ledger.setJobStatus(jobId, 'working');
  await ctx.worktrees.createJobWorktree({ repoPath: ctx.repo.path, jobId });
  ctx.ledger.beginRebriefIntent({ jobId, note: 'redo the work', holder: 'silas-ops', requestId });
  expect(ctx.ledger.claimDirectiveDispatch(requestId)).toBe(true);
  const start = ctx.ledger.latestJobEventByRequestId(jobId, 'silas.directive-dispatch-started', requestId)!;
  ctx.ledger.recordDirectiveDispatchDeferral(ctx.ledger.directiveTurnIdentity(requestId), start.seq, 'a supervised producer held the lane');
  surfaceDirectiveRecovery({ ledger: ctx.ledger, notifications: ctx.notifications }, requestId, 'deferred before reaching its worker');
}

async function deferred(opts: { park?: boolean; jobId?: string; requestId?: string } = {}): Promise<Ctx> {
  const jobId = opts.jobId ?? 'job-closeout';
  const requestId = opts.requestId ?? 'req-closeout';
  const ctx = boot(jobId, requestId);
  await seedDeferred(ctx, jobId, requestId);
  if (opts.park === true) ctx.ledger.setJobStatus(jobId, 'parked');
  ctx.baselineSeq = ctx.ledger.latestEventSeq();
  return ctx;
}

const kind = (ctx: Ctx): string => `silas.directive-unreconciled.${ctx.requestId}`;
const cards = (ctx: Ctx): number => ctx.ledger.listNotifications({ limit: 500 }).filter((row) => row.kind === kind(ctx)).length;
const payloadOf = (event: EventRecord): Record<string, unknown> => event.payload as Record<string, unknown>;
const jobEvents = (ctx: Ctx, eventKind: string): EventRecord[] => ctx.ledger.listJobEvents(ctx.jobId).filter((event) => event.kind === eventKind);
const binnedEvents = (ctx: Ctx): EventRecord[] => jobEvents(ctx, 'job.status').filter((event) => payloadOf(event).to === 'binned');
const resolvedEvents = (ctx: Ctx): EventRecord[] => {
  const card = ctx.ledger.findNotificationByKind(kind(ctx), 'any');
  return ctx.ledger.listEvents({ limit: 5000 }).filter((event) => event.kind === 'notification.resolved' && payloadOf(event).id === card?.id);
};
/** This request's `notification.created` rows: a replayed incident adds one of
 * these even when the card table happens to hide it. */
const createdEvents = (ctx: Ctx): EventRecord[] => {
  const ids = new Set(ctx.ledger.listNotifications({ limit: 500 }).filter((row) => row.kind === kind(ctx)).map((row) => row.id));
  return ctx.ledger.listEvents({ limit: 5000 }).filter((event) => event.kind === 'notification.created' && ids.has(String(payloadOf(event).id)));
};
const request = (ctx: Ctx, by: unknown = 'gru', extra: Record<string, unknown> = {}): CloseoutHttpResult | null =>
  ctx.closeout.requestBinning(ctx.jobId, { status: 'binned', ...(by === undefined ? {} : { by }), ...extra });
const mustRequest = (ctx: Ctx, by: unknown = 'gru', extra: Record<string, unknown> = {}): CloseoutHttpResult => {
  const result = request(ctx, by, extra);
  if (result === null) throw new Error('expected the closeout to take the binning request');
  return result;
};
/** The keep-parked closeout request (`POST /api/silas/directives/{request}/closeout`). */
const keepParkedFor = (ctx: Ctx, requestId: string, by: unknown = 'gru', extra: Record<string, unknown> = {}): CloseoutHttpResult | null =>
  ctx.closeout.requestBinning(ctx.jobId, { ...(by === undefined ? {} : { by }), ...extra }, { mode: 'keep-parked', requestId });
const keepParked = (ctx: Ctx, by: unknown = 'gru', extra: Record<string, unknown> = {}): CloseoutHttpResult | null =>
  keepParkedFor(ctx, ctx.requestId, by, extra);
const mustKeepParked = (ctx: Ctx, by: unknown = 'gru', extra: Record<string, unknown> = {}): CloseoutHttpResult => {
  const result = keepParked(ctx, by, extra);
  if (result === null) throw new Error('expected the closeout to take the keep-parked request');
  return result;
};
const mustKeepParkedFor = (ctx: Ctx, requestId: string, by: unknown = 'gru'): CloseoutHttpResult => {
  const result = keepParkedFor(ctx, requestId, by);
  if (result === null) throw new Error(`expected the closeout to take the keep-parked request for "${requestId}"`);
  return result;
};
const bodyOf = (result: CloseoutHttpResult | null): Record<string, unknown> => result?.body as Record<string, unknown>;
const blockersOf = (result: CloseoutHttpResult | null): Array<{ code: string; detail: string }> => bodyOf(result).blockers as Array<{ code: string; detail: string }>;
const debt = (ctx: Ctx) => ctx.ledger.listObligations({ jobId: ctx.jobId }).find((row) => row.incidentKey === `directive-recovery:${ctx.requestId}`);

/** Throw once, at one step, as a crash would. */
function crashAt(ctx: Ctx, step: CloseoutStep): void {
  ctx.hook = (current) => { if (current === step) { ctx.hook = undefined; throw new Error(`crash after ${step}`); } };
}

/** Run once, at one step, then disappear. */
function once(ctx: Ctx, step: CloseoutStep, action: () => void): void {
  ctx.hook = (current) => { if (current === step) { ctx.hook = undefined; action(); } };
}

/** The manual `/retire` of the deferred request, as Gru did before the closeout existed. */
function retireByHand(ctx: Ctx): void {
  const authority = ctx.ledger.directiveCurrentAuthority(ctx.jobId);
  const obligation = ctx.ledger.recoveryObligation(ctx.jobId, 'directive', ctx.requestId);
  const lane = ctx.worktrees.listWorktrees({ jobId: ctx.jobId })[0]!;
  ctx.ledger.retireInterruptedDirective({ requestId: ctx.requestId, expectedJobId: ctx.jobId, expectedState: 'dispatching',
    expectedPayloadHash: ctx.ledger.getDirective(ctx.requestId)!.payloadHash, expectedHead: lane.sha,
    expectedGeneration: obligation?.generation ?? null, expectedPlanRevision: obligation?.planRevision ?? null,
    expectedObligationState: obligation?.state ?? null, expectedAuthorityEpoch: authority.authorityEpoch,
    expectedWorkRevision: authority.workRevision, expectedContractSha256: authority.contractSha256,
    lane: { id: ctx.jobId, resolvedHead: lane.sha }, reason: 'retired by hand', by: 'silas-ops' });
}

/** The end state of a completed cancel (test 1), shared by the interrupt tests. */
function expectCancelled(ctx: Ctx): void {
  expect(ctx.ledger.getDirective(ctx.requestId)).toMatchObject({ state: 'retired', retiredBy: CLOSEOUT_ACTOR });
  expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('binned');
  expect(debt(ctx)).toMatchObject({ state: 'closed', settlement: { kind: 'job-terminal', jobStatus: 'binned' } });
  expect(ctx.ledger.findNotificationByKind(kind(ctx), 'active')).toBeNull();
  expect(ctx.ledger.findNotificationByKind(kind(ctx), 'any')).toMatchObject({ resolvedBy: CLOSEOUT_ACTOR, ackedAt: null });
  const items = projectMailbox(ctx.ledger);
  expect(items.filter((item) => item.jobId === ctx.jobId)).toEqual([]);
  expect(JSON.stringify(items)).not.toContain(ctx.requestId);
  expect(ctx.spawns).toEqual([]);
  expect(ctx.ledger.listPendingDirectives({ jobId: ctx.jobId })).toHaveLength(1);
  // "No spawn" at the persisted record: the closeout never claimed a dispatch, started a producer,
  // admitted a turn or accepted a request after the fixture was built.
  const dispatched = ctx.ledger.listJobEvents(ctx.jobId).filter((event) => event.seq > ctx.baselineSeq && [
    'agent.spawned', 'silas.directive-intent', 'silas.directive-dispatch-started', 'silas.directive-producer-reserved',
    'silas.directive-producer-started', 'silas.directive-sent', 'silas.rebrief'].includes(event.kind));
  expect(dispatched.map((event) => event.kind)).toEqual([]);
}

/** Nothing the closeout wrote is attributed to the owner. */
function expectNoOwnerAttribution(ctx: Ctx): void {
  const intent = ctx.ledger.latestCloseoutForJob(ctx.jobId);
  expect(intent?.requestedBy).not.toBe('owner');
  const row = ctx.ledger.getDirective(ctx.requestId);
  if (row?.retiredBy !== null && row?.retiredBy !== undefined) expect(row.retiredBy).not.toBe('owner');
  const card = ctx.ledger.findNotificationByKind(kind(ctx), 'any');
  if (card?.resolvedBy !== null && card?.resolvedBy !== undefined) expect(card.resolvedBy).not.toBe('owner');
  if (intent !== null) {
    for (const event of ctx.ledger.listJobEvents(ctx.jobId).filter((candidate) => candidate.seq >= intent.intentSeq)) {
      expect(payloadOf(event).by, event.kind).not.toBe('owner');
    }
  }
}

/** The end state of a completed keep-parked closeout (#564): the request is
 * retired and its debt closed by the closeout's own settlement, the card is
 * resolved, and the job is exactly as parked as it was. */
function expectKeptParked(ctx: Ctx): void {
  expect(ctx.ledger.getDirective(ctx.requestId)).toMatchObject({ state: 'retired', retiredBy: CLOSEOUT_ACTOR });
  expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('parked');
  // The debt closes by the closeout's own settlement, never by a job-terminal one,
  // and nothing writes a job status, a delivery, a completion or a no-effect claim.
  expect(debt(ctx)).toMatchObject({ state: 'closed', settlement: { kind: 'cancelled' } });
  expect(binnedEvents(ctx)).toEqual([]);
  expect(jobEvents(ctx, 'job.status').filter((event) => event.seq > ctx.baselineSeq)).toEqual([]);
  expect(jobEvents(ctx, 'job.delivered')).toEqual([]);
  expect(ctx.ledger.getDirective(ctx.requestId)?.holdReleasedBy).toBeNull();
  expect(ctx.ledger.findNotificationByKind(kind(ctx), 'active')).toBeNull();
  expect(ctx.ledger.findNotificationByKind(kind(ctx), 'any')).toMatchObject({ resolvedBy: CLOSEOUT_ACTOR, ackedAt: null });
  expect(JSON.stringify(projectMailbox(ctx.ledger))).not.toContain(ctx.requestId);
  expect(ctx.spawns).toEqual([]);
  // Exactly the closeout's own writes: S1, S2, the debt settlement and S3' —
  // no completion/no-effect/cessation receipt of any kind and no job status.
  expect(ctx.ledger.listJobEvents(ctx.jobId, { order: 'asc' }).filter((event) => event.seq > ctx.baselineSeq).map((event) => event.kind))
    .toEqual(['silas.closeout-intent', 'silas.directive-retired', 'job.obligation-settled', 'silas.closeout-complete']);
}

/** The refusal the real `/retire` route raises for this fixture, mapped to
 * blockers exactly as a guard refusal reaches the closeout: route evidence and
 * the ledger preflight first, then the same expectations the route builds. */
function retireRouteRefusal(ctx: Ctx): Array<{ code: string; detail: string }> {
  const row = ctx.ledger.getDirective(ctx.requestId)!;
  const authority = ctx.ledger.directiveCurrentAuthority(ctx.jobId);
  const obligation = ctx.ledger.recoveryObligation(ctx.jobId, 'directive', ctx.requestId);
  const lane = ctx.worktrees.listWorktrees({ jobId: ctx.jobId })[0]!;
  try {
    retireInterruptedDirectiveFromRoute({
      ledger: ctx.ledger,
      worktrees: ctx.worktrees,
      pendingProducerBlockers: () => ctx.supervised,
      workerGate: { view: () => ({ worker: { queued: ctx.queued } }) } as unknown as Pick<PacingGate, 'view'>,
      requestId: ctx.requestId,
      expected: { jobId: ctx.jobId, state: 'dispatching', payloadHash: row.payloadHash, head: lane.sha,
        context: { expectedGeneration: obligation?.generation ?? null, expectedPlanRevision: obligation?.planRevision ?? null,
          expectedObligationState: obligation?.state ?? null, expectedAuthorityEpoch: authority.authorityEpoch,
          expectedWorkRevision: authority.workRevision, expectedContractSha256: authority.contractSha256 } },
      reason: 'retire by hand',
      by: 'silas-ops',
    });
  } catch (error) {
    if (!(error instanceof DirectiveRetirementError)) throw error;
    return error.blockers.length > 0 ? error.blockers.map((detail) => ({ code: error.code, detail })) : [{ code: error.code, detail: error.message }];
  }
  throw new Error('expected /retire to refuse this request');
}

function progress(ctx: Ctx): DirectiveProgressService {
  const registry: DirectiveRegistry = {
    getHandle: () => null,
    spawn: async (_role, options) => { ctx.spawns.push(options ?? {}); throw new Error('a canceled request must never spawn'); },
    disposeHandle: async () => {},
  };
  return new DirectiveProgressService({ ledger: ctx.ledger, registry, worktrees: ctx.worktrees, notifications: ctx.notifications,
    pendingProducerBlockers: () => [], signal: new AbortController().signal });
}

describe('canceled-request closeout — the cancel (test 1)', () => {
  it('1a. a parked job: the request is retired, the job binned, the debt closed, the card resolved and the mailbox clear', async () => {
    const ctx = await deferred({ park: true });
    expect(debt(ctx)?.state).toBe('suspended');
    // The incident IS on the mailbox before the cancel (the bug's footprint).
    expect(JSON.stringify(projectMailbox(ctx.ledger))).toContain(ctx.requestId);
    const result = mustRequest(ctx, 'gru', { reason: 'discard: the heist is canceled' });
    expect(result.status).toBe(200);
    expect(bodyOf(result)).toMatchObject({ id: ctx.jobId, status: 'binned', closeout: { state: 'complete', generation: 1 } });
    expectCancelled(ctx);
    expectNoOwnerAttribution(ctx);
  });

  it('1b. a working job completes the same way', async () => {
    const ctx = await deferred();
    expect(debt(ctx)?.state).toBe('open');
    const result = mustRequest(ctx);
    expect(result.status).toBe(200);
    expect(bodyOf(result)).toMatchObject({ status: 'binned', closeout: { state: 'complete', generation: 1 } });
    expectCancelled(ctx);
    expect(jobEvents(ctx, 'silas.closeout-intent')).toHaveLength(1);
    expect(jobEvents(ctx, 'silas.directive-retired')).toHaveLength(1);
    expect(binnedEvents(ctx)).toHaveLength(1);
    expect(jobEvents(ctx, 'silas.closeout-complete')).toHaveLength(1);
    // The closeout's own events: exact payloads, attributed to the closeout.
    const intent = ctx.ledger.latestCloseoutForJob(ctx.jobId)!;
    expect(payloadOf(jobEvents(ctx, 'silas.closeout-intent')[0]!)).toEqual({ closeout_id: intent.closeoutId, request_id: ctx.requestId, generation: 1,
      payload_hash: intent.payloadHash, job_status: 'working', mode: 'bin', requested_by: 'gru', reason: null, by: CLOSEOUT_ACTOR });
    expect(payloadOf(jobEvents(ctx, 'silas.closeout-complete')[0]!)).toEqual({ closeout_id: intent.closeoutId, request_id: ctx.requestId, generation: 1, by: CLOSEOUT_ACTOR });
    expect(jobEvents(ctx, 'silas.closeout-intent')[0]!.seq).toBe(intent.intentSeq);
    expectNoOwnerAttribution(ctx);
  });

  it('1c. a completed closeout is never regenerated by later passes: the debt stays closed, no incident returns and nothing is written', async () => {
    const ctx = await deferred();
    expect(mustRequest(ctx).status).toBe(200);
    expectCancelled(ctx);
    const seq = ctx.ledger.latestEventSeq();
    const cardsBefore = cards(ctx);
    const createdBefore = createdEvents(ctx).length;
    const service = progress(ctx);
    service.reconsider(); await service.settled();
    service.reconsider(); await service.settled();
    await service.dispose();
    expect(ctx.closeout.resumePending()).toMatchObject({ examined: 0, completed: 0, superseded: 0, failures: [] });
    // The obligation stays settled: no `waiting`/`open` replay of the debt the closeout closed.
    expect(ctx.ledger.listObligations({ jobId: ctx.jobId }).filter((row) => row.incidentKey === `directive-recovery:${ctx.requestId}`)
      .map((row) => row.state)).toEqual(['closed']);
    expect(debt(ctx)).toMatchObject({ state: 'closed', settlement: { kind: 'job-terminal', jobStatus: 'binned' } });
    // The incident stays answered: no new `notification.created` row of this request's kind.
    expect(createdEvents(ctx)).toHaveLength(createdBefore);
    expect(cards(ctx)).toBe(cardsBefore);
    expect(ctx.ledger.findNotificationByKind(kind(ctx), 'active')).toBeNull();
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
    expect(ctx.spawns).toEqual([]);
    expectNoOwnerAttribution(ctx);
  });
});

describe('canceled-request closeout — keep parked (#564)', () => {
  it('A1. a parked job: the request is retired and its debt closed, and the job stays parked with its hold in place', async () => {
    const ctx = await deferred({ park: true });
    expect(debt(ctx)?.state).toBe('suspended');
    const result = mustKeepParked(ctx, 'gru', { reason: 'discard: the heist is canceled' });
    expect(result.status).toBe(200);
    expect(bodyOf(result)).toMatchObject({ id: ctx.jobId, status: 'parked', closeout: { state: 'complete', generation: 1 } });
    expectKeptParked(ctx);
    const intent = ctx.ledger.latestCloseoutForJob(ctx.jobId)!;
    expect(intent.mode).toBe('keep-parked');
    expect(payloadOf(jobEvents(ctx, 'silas.closeout-intent')[0]!)).toEqual({ closeout_id: intent.closeoutId, request_id: ctx.requestId,
      generation: 1, payload_hash: intent.payloadHash, job_status: 'parked', mode: 'keep-parked', requested_by: 'gru',
      reason: 'discard: the heist is canceled', by: CLOSEOUT_ACTOR });
    expect(payloadOf(jobEvents(ctx, 'silas.closeout-complete')[0]!)).toEqual({ closeout_id: intent.closeoutId, request_id: ctx.requestId,
      generation: 1, mode: 'keep-parked', by: CLOSEOUT_ACTOR });
    // The retirement's durable reason says what this mode does: it never claims a
    // binning, and it is the same text the row keeps.
    const retired = payloadOf(jobEvents(ctx, 'silas.directive-retired')[0]!);
    const retiredReason = `keep-parked closeout: retire the canceled request ${ctx.requestId} and leave its job parked ` +
      '(requested by gru): discard: the heist is canceled';
    expect(retired['reason']).toBe(retiredReason);
    expect(retiredReason).not.toContain('binning');
    expect(ctx.ledger.getDirective(ctx.requestId)?.retireReason).toBe(retiredReason);
    // The readback says which S3 the intent owes, in the describing view and the wire shape.
    expect(ctx.closeout.describe(ctx.requestId)).toMatchObject({ path: 'binning', eligible: false, mode: 'keep-parked', intent: { state: 'complete' } });
    expect(closeoutIntentView(intent)).toMatchObject({ mode: 'keep-parked', state: 'complete' });
    expectNoOwnerAttribution(ctx);
  });

  it('A2. the keep-parked request refuses exactly where /retire refuses (the route-level live-work guard)', async () => {
    const ctx = await deferred({ park: true });
    ctx.supervised = ['restart retry scheduled for minion-1'];
    const retiredByHand = retireRouteRefusal(ctx);
    expect(retiredByHand).toEqual([{ code: 'live_work', detail: 'restart retry scheduled for minion-1' }]);
    const seq = ctx.ledger.latestEventSeq();
    const result = mustKeepParked(ctx);
    expect(result.status).toBe(409);
    expect(bodyOf(result)).toEqual({ error: 'request_closeout_refused', blockers: retiredByHand });
    // A retry of the unchanged request writes nothing and gives the same answer.
    expect(mustKeepParked(ctx)).toEqual(result);
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toBeNull();
    expect(ctx.ledger.getDirective(ctx.requestId)?.state).toBe('dispatching');
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('parked');
  });

  it('A2b. the keep-parked request refuses with the ledger preflight\'s own code (terminal_receipt_present)', async () => {
    const ctx = await deferred({ park: true });
    ctx.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: ctx.jobId, payload: { request_id: ctx.requestId, sha: ctx.repo.head() } });
    const retiredByHand = retireRouteRefusal(ctx);
    expect(retiredByHand.map((blocker) => blocker.code)).toEqual(['terminal_receipt_present']);
    const seq = ctx.ledger.latestEventSeq();
    const result = mustKeepParked(ctx);
    expect(result.status).toBe(409);
    expect(bodyOf(result)).toEqual({ error: 'request_closeout_refused', blockers: retiredByHand });
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toBeNull();
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('parked');
  });

  it('A3. a repeat after completion replays, and a crash after S2 resumes to the same parked end state', async () => {
    const ctx = await deferred({ park: true });
    crashAt(ctx, 'retire');
    expect(() => keepParked(ctx)).toThrow('crash after retire');
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toMatchObject({ state: 'open', generation: 1, mode: 'keep-parked' });
    expect(ctx.ledger.getDirective(ctx.requestId)?.state).toBe('retired');
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('parked');
    expect(debt(ctx)?.state).toBe('suspended');
    ctx.restart();
    expect(ctx.closeout.resumePending()).toMatchObject({ examined: 1, completed: 1, failures: [] });
    expectKeptParked(ctx);
    expect(jobEvents(ctx, 'silas.closeout-intent')).toHaveLength(1);
    expect(jobEvents(ctx, 'silas.directive-retired')).toHaveLength(1);
    expect(jobEvents(ctx, 'silas.closeout-complete')).toHaveLength(1);
    expect(payloadOf(jobEvents(ctx, 'silas.closeout-complete')[0]!).mode).toBe('keep-parked');
    // The repeat is the request's own completed intent: the same member, no event.
    const seq = ctx.ledger.latestEventSeq();
    const first = ctx.closeout.describe(ctx.requestId);
    const repeated = mustKeepParked(ctx);
    expect(repeated.status).toBe(200);
    expect(bodyOf(repeated)).toMatchObject({ status: 'parked', closeout: { state: 'complete', generation: 1 } });
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
    expect(jobEvents(ctx, 'silas.closeout-intent')).toHaveLength(1);
    expect(jobEvents(ctx, 'silas.closeout-complete')).toHaveLength(1);
    expect(ctx.closeout.describe(ctx.requestId)).toEqual(first);
    expectNoOwnerAttribution(ctx);
  });

  it('A4. the hold stays: a fresh directive request on the parked job still needs the owner', async () => {
    const ctx = await deferred({ park: true });
    expect(mustKeepParked(ctx).status).toBe(200);
    expectKeptParked(ctx);
    const later = ctx.ledger.beginDirectiveIntent({ jobId: ctx.jobId, directive: 'carry the discarded work anyway', holder: 'silas-ops', requestId: 'req-later' });
    expect(later.created).toBe(true);
    expect(() => ctx.ledger.assertDirectiveAuthority(ctx.ledger.directiveTurnIdentity('req-later')))
      .toThrow('directive authority is terminal, held or superseded — no work may proceed');
    expect(() => ctx.ledger.claimDirectiveDispatch('req-later')).toThrow(/terminal, held or superseded/);
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('parked');
    expect(ctx.spawns).toEqual([]);
  });

  it('A5. a call that names a request the job\'s closeout does not act on is refused, and the request it would act on is untouched', async () => {
    // The eligibility rule names the job's only live request (req-second); the call
    // names the earlier request, retired by hand and with no intent of its own.
    const ctx = await deferred();
    retireByHand(ctx);
    ctx.ledger.beginRebriefIntent({ jobId: ctx.jobId, note: 'second try', holder: 'silas-ops', requestId: 'req-second' });
    expect(ctx.ledger.claimDirectiveDispatch('req-second')).toBe(true);
    const start = ctx.ledger.latestJobEventByRequestId(ctx.jobId, 'silas.directive-dispatch-started', 'req-second')!;
    ctx.ledger.recordDirectiveDispatchDeferral(ctx.ledger.directiveTurnIdentity('req-second'), start.seq, 'deferred again');
    surfaceDirectiveRecovery({ ledger: ctx.ledger, notifications: ctx.notifications }, 'req-second', 'deferred before reaching its worker');
    ctx.ledger.setJobStatus(ctx.jobId, 'parked');
    ctx.baselineSeq = ctx.ledger.latestEventSeq();
    const secondDebt = ctx.ledger.recoveryObligation(ctx.jobId, 'directive', 'req-second');
    expect(secondDebt).not.toBeNull();
    const mismatch = mustKeepParkedFor(ctx, ctx.requestId);
    expect(mismatch.status).toBe(409);
    expect(bodyOf(mismatch)).toEqual({ error: 'request_closeout_target_mismatch', active_request_id: 'req-second',
      detail: expect.stringContaining('the request "req-closeout" this call names') });
    // Nothing written, and the request the rule names is exactly as it was.
    expect(ctx.ledger.latestEventSeq()).toBe(ctx.baselineSeq);
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toBeNull();
    expect(ctx.ledger.getDirective('req-second')).toMatchObject({ state: 'dispatching', retiredBy: null });
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('parked');
    expect(ctx.ledger.recoveryObligation(ctx.jobId, 'directive', 'req-second')).toEqual(secondDebt);
    // With req-second's own intent open, naming the earlier request is refused the
    // same way and the intent it owns stays where it was.
    crashAt(ctx, 'intent');
    expect(() => mustKeepParkedFor(ctx, 'req-second')).toThrow('crash after intent');
    const intent = ctx.ledger.latestCloseoutForJob(ctx.jobId)!;
    expect(intent).toMatchObject({ state: 'open', requestId: 'req-second', mode: 'keep-parked' });
    const seq = ctx.ledger.latestEventSeq();
    const stillNamed = mustKeepParkedFor(ctx, ctx.requestId);
    expect(stillNamed.status).toBe(409);
    expect(bodyOf(stillNamed)).toEqual({ error: 'request_closeout_target_mismatch', active_request_id: 'req-second',
      detail: expect.stringContaining('the request "req-closeout" this call names') });
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
    expect(ctx.ledger.getCloseout(intent.closeoutId)).toMatchObject({ state: 'open' });
    expect(ctx.ledger.getDirective('req-second')?.state).toBe('dispatching');
    // The request it belongs to still resumes and finishes it.
    expect(mustKeepParkedFor(ctx, 'req-second').status).toBe(200);
    expect(ctx.ledger.getDirective('req-second')).toMatchObject({ state: 'retired', retiredBy: CLOSEOUT_ACTOR });
    expect(ctx.ledger.recoveryObligation(ctx.jobId, 'directive', 'req-second')).toBeNull();
    expect(ctx.ledger.listObligations({ jobId: ctx.jobId }).find((row) => row.incidentKey === 'directive-recovery:req-second'))
      .toMatchObject({ state: 'closed', settlement: { kind: 'cancelled' } });
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('parked');
    expectNoOwnerAttribution(ctx);
  });

  it('an active keep-parked intent whose job left parked is superseded, not answered job_not_parked', async () => {
    const ctx = await deferred({ park: true });
    crashAt(ctx, 'retire');
    expect(() => keepParked(ctx)).toThrow('crash after retire');
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toMatchObject({ state: 'open', mode: 'keep-parked' });
    // The owner resumes the job while the intent is still open: the parked premise
    // no longer holds, so the intent is stale and the caller owns that answer.
    ctx.ledger.setJobStatus(ctx.jobId, 'working');
    const seq = ctx.ledger.latestEventSeq();
    const answered = mustKeepParked(ctx);
    expect(answered.status).toBe(409);
    expect(bodyOf(answered)).toEqual({ error: 'request_closeout_superseded', superseded_reason: 'job-status' });
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toMatchObject({ state: 'superseded', supersededReason: 'job-status', mode: 'keep-parked' });
    // The supersede is the only write: S2's retirement stands, the debt is untouched.
    expect(ctx.ledger.listJobEvents(ctx.jobId, { order: 'asc' }).filter((event) => event.seq > seq).map((event) => event.kind))
      .toEqual(['silas.closeout-superseded']);
    expect(ctx.ledger.getDirective(ctx.requestId)).toMatchObject({ state: 'retired', retiredBy: CLOSEOUT_ACTOR });
    expect(debt(ctx)?.state).toBe('suspended');
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('working');
  });

  it('the gate duty a keep-parked S3\' cannot discharge stops the intent, names it, and the fingerprint stays put', async () => {
    const ctx = await deferred({ park: true });
    const debtId = debt(ctx)!.id;
    ctx.ledger.appendCustomEvent({ kind: 'silas.directive-current-gates-owed', jobId: ctx.jobId,
      payload: { obligation_id: debtId, next_action: { kind: 'gru-decision', decision: 'apply the review correction' } } });
    ctx.baselineSeq = ctx.ledger.latestEventSeq();
    const stopped = mustKeepParked(ctx);
    expect(stopped.status).toBe(409);
    expect(bodyOf(stopped)).toMatchObject({ error: 'request_closeout_stopped' });
    expect(blockersOf(stopped)).toEqual([{ code: 'gate_duty', detail: expect.stringContaining('apply the review correction') }]);
    const intent = ctx.ledger.latestCloseoutForJob(ctx.jobId)!;
    expect(intent).toMatchObject({ state: 'stopped', mode: 'keep-parked', blockerFingerprint: closeoutBlockerFingerprint(intent.blockers) });
    // Nothing partial: the request is retired, the debt is untouched, the card stays, the job stays parked.
    expect(ctx.ledger.getDirective(ctx.requestId)?.state).toBe('retired');
    expect(debt(ctx)?.state).toBe('suspended');
    expect(ctx.ledger.findNotificationByKind(kind(ctx), 'active')).not.toBeNull();
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('parked');
    // The readback shows the same refusal and never advertises an eligible closeout.
    const view = ctx.closeout.describe(ctx.requestId);
    expect(view).toMatchObject({ path: 'closeout', eligible: false, mode: 'keep-parked' });
    expect(view.blockers).toEqual(intent.blockers);
    // Unchanged blockers: a repeat and a pass write nothing.
    const seq = ctx.ledger.latestEventSeq();
    expect(mustKeepParked(ctx)).toEqual(stopped);
    expect(ctx.closeout.resumePending()).toMatchObject({ examined: 1, untouched: 1, completed: 0 });
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
    // A binning request never completes the keep-parked intent behind the operator's back.
    const binned = mustRequest(ctx);
    expect(binned.status).toBe(409);
    expect(bodyOf(binned)).toEqual({ error: 'request_closeout_mode_conflict', active_mode: 'keep-parked', closeout_id: intent.closeoutId });
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('parked');
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
    // The intent still owes the request its end: the fence stays until the duty is resolved.
    expect(ctx.ledger.hasPendingCloseout(ctx.requestId)).toBe(true);
    expect(() => ctx.ledger.claimDirectiveDispatch(ctx.requestId)).toThrow(CloseoutPendingError);
    expect(debt(ctx)?.state).toBe('suspended');
  });

  it('a binned request on an active keep-parked intent is a 409 mode conflict, and the job stays parked', async () => {
    const ctx = await deferred({ park: true });
    crashAt(ctx, 'intent');
    expect(() => keepParked(ctx)).toThrow('crash after intent');
    const intent = ctx.ledger.latestCloseoutForJob(ctx.jobId)!;
    expect(intent).toMatchObject({ state: 'open', mode: 'keep-parked' });
    const seq = ctx.ledger.latestEventSeq();
    const conflict = mustRequest(ctx);
    expect(conflict.status).toBe(409);
    expect(bodyOf(conflict)).toEqual({ error: 'request_closeout_mode_conflict', active_mode: 'keep-parked', closeout_id: intent.closeoutId });
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('parked');
    expect(ctx.ledger.getDirective(ctx.requestId)?.state).toBe('dispatching');
    // The keep-parked request itself still resumes the intent it owns.
    expect(mustKeepParked(ctx).status).toBe(200);
    expectKeptParked(ctx);
  });

  it('a keep-parked request on an active bin intent is a 409 mode conflict, and nothing bins', async () => {
    const ctx = await deferred();
    crashAt(ctx, 'retire');
    expect(() => request(ctx)).toThrow('crash after retire');
    const intent = ctx.ledger.latestCloseoutForJob(ctx.jobId)!;
    expect(intent).toMatchObject({ state: 'open', mode: 'bin' });
    const seq = ctx.ledger.latestEventSeq();
    const conflict = mustKeepParked(ctx);
    expect(conflict.status).toBe(409);
    expect(bodyOf(conflict)).toEqual({ error: 'request_closeout_mode_conflict', active_mode: 'bin', closeout_id: intent.closeoutId });
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('working');
    expect(debt(ctx)?.state).toBe('open');
    // The binning request itself still completes the intent it owns.
    expect(mustRequest(ctx).status).toBe(200);
    expectCancelled(ctx);
  });

  it('a job that is not parked is refused before anything is written (409 job_not_parked)', async () => {
    const ctx = await deferred();
    const seq = ctx.ledger.latestEventSeq();
    const refused = mustKeepParked(ctx);
    expect(refused.status).toBe(409);
    expect(bodyOf(refused)).toEqual({ error: 'job_not_parked',
      detail: `job "${ctx.jobId}" is working, not parked — the keep-parked closeout never changes the job status, so the hold must be in place first` });
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toBeNull();
    expect(ctx.ledger.getDirective(ctx.requestId)?.state).toBe('dispatching');
    expect(debt(ctx)?.state).toBe('open');
    // A reason over the limit is still the closeout's own 400 first.
    expect(mustKeepParked(ctx, 'gru', { reason: 'x'.repeat(501) }).status).toBe(400);
    expect(bodyOf(mustKeepParked(ctx, 'gru', { reason: 'x'.repeat(501) })).error).toBe('invalid_reason');
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
  });
});

describe('canceled-request closeout — pause is not cancel (test 2)', () => {
  it('2. parking is never read as a cancel: reconsider passes, resumePending and a restart leave the request deferred', async () => {
    const ctx = await deferred({ park: true });
    const statusEvents = jobEvents(ctx, 'job.status').length;
    const service = progress(ctx);
    for (let pass = 0; pass < 3; pass += 1) { service.reconsider(); await service.settled(); }
    expect(ctx.closeout.resumePending()).toMatchObject({ examined: 0 });
    await service.dispose();
    ctx.restart();
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('parked');
    expect(ctx.ledger.getDirective(ctx.requestId)?.state).toBe('dispatching');
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toBeNull();
    expect(jobEvents(ctx, 'job.status')).toHaveLength(statusEvents);
    expect(debt(ctx)?.state).toBe('suspended');
    expect(ctx.spawns).toEqual([]);
  });
});

describe('canceled-request closeout — interrupt and retry (test 3)', () => {
  async function interruptThenRetry(step: CloseoutStep): Promise<void> {
    const ctx = await deferred();
    crashAt(ctx, step);
    expect(() => request(ctx)).toThrow(`crash after ${step}`);
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toMatchObject({ state: 'open', generation: 1 });
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('working');
    expect(ctx.ledger.getDirective(ctx.requestId)?.state).toBe(step === 'intent' ? 'dispatching' : 'retired');
    ctx.restart();
    expect(ctx.closeout.resumePending()).toMatchObject({ examined: 1, completed: 1, failures: [] });
    const repeated = mustRequest(ctx);
    expect(repeated.status).toBe(200);
    expect(bodyOf(repeated).closeout).toMatchObject({ state: 'complete', generation: 1 });
    expectCancelled(ctx);
    expect(jobEvents(ctx, 'silas.closeout-intent')).toHaveLength(1);
    expect(jobEvents(ctx, 'silas.directive-retired')).toHaveLength(1);
    expect(binnedEvents(ctx)).toHaveLength(1);
    expect(jobEvents(ctx, 'silas.closeout-complete')).toHaveLength(1);
    expect(resolvedEvents(ctx)).toHaveLength(1);
    expect(cards(ctx)).toBe(1);
    expectNoOwnerAttribution(ctx);
  }

  it('3a. a crash after S1 (intent recorded): a restart resumes it to the same end state', () => interruptThenRetry('intent'));
  it('3b. a crash after S2 (request retired): a restart skips the retirement and finishes', () => interruptThenRetry('retire'));

  it('3c. a repeated request alone (no resumePending) resumes an open intent', async () => {
    const ctx = await deferred();
    crashAt(ctx, 'intent');
    expect(() => request(ctx)).toThrow('crash after intent');
    const resumed = mustRequest(ctx);
    expect(resumed.status).toBe(200);
    expectCancelled(ctx);
    expect(jobEvents(ctx, 'silas.closeout-intent')).toHaveLength(1);
    expectNoOwnerAttribution(ctx);
  });

  it('3d. a failing intent is reported and logged, never thrown, and stays open for the next pass', async () => {
    const ctx = await deferred();
    crashAt(ctx, 'intent');
    expect(() => request(ctx)).toThrow();
    ctx.hook = () => { throw new Error('boom: ledger unavailable'); };
    const report = ctx.closeout.resumePending();
    expect(report).toMatchObject({ examined: 1, completed: 0 });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.error).toContain('boom: ledger unavailable');
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)?.state).toBe('open');
    ctx.hook = undefined;
    expect(ctx.closeout.resumePending()).toMatchObject({ completed: 1, failures: [] });
  });
});

describe('canceled-request closeout — a poisoned row (test 3)', () => {
  it('3e. one intent whose row cannot be read is reported and never hides or blocks the others', async () => {
    const ctx = await deferred();
    await seedDeferred(ctx, 'job-second', 'req-second');
    ctx.hook = (step) => { if (step === 'intent') throw new Error('crash after S1'); };
    expect(() => request(ctx)).toThrow('crash after S1');
    expect(() => ctx.closeout.requestBinning('job-second', { status: 'binned', by: 'gru' })).toThrow('crash after S1');
    ctx.hook = undefined;
    // Damage the first intent's stored blockers: building the list of pending intents must not throw.
    ctx.db.handle.prepare("UPDATE request_closeouts SET blockers = 'not json' WHERE job_id = ?").run(ctx.jobId);
    const report = ctx.closeout.resumePending();
    expect(report).toMatchObject({ examined: 2, completed: 1 });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]?.error).toMatch(/JSON/u);
    expect(ctx.ledger.getJob('job-second')?.status).toBe('binned');
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('working');
  });
});

describe('canceled-request closeout — the redispatch fence (test 4)', () => {
  it('4a. an open intent: the request cannot be claimed, and reconsider spawns and posts nothing', async () => {
    const ctx = await deferred();
    crashAt(ctx, 'intent');
    expect(() => request(ctx)).toThrow();
    expect(() => ctx.ledger.claimDirectiveDispatch(ctx.requestId)).toThrow(CloseoutPendingError);
    expect(() => ctx.ledger.assertDirectiveAuthority(ctx.ledger.directiveTurnIdentity(ctx.requestId))).toThrow(CloseoutPendingError);
    const admissions = vi.spyOn(ctx.ledger, 'beginJobAdmission');
    const before = cards(ctx);
    const service = progress(ctx);
    service.reconsider(); await service.settled(); service.reconsider(); await service.settled();
    await service.dispose();
    expect(admissions).not.toHaveBeenCalled();
    expect(ctx.spawns).toEqual([]);
    expect(cards(ctx)).toBe(before);
    expectNoOwnerAttribution(ctx);
  });

  it('4b. a stopped intent (the S2 race): the same fence holds and reconsider skips the request', async () => {
    const ctx = await deferred();
    let release = (): void => {};
    once(ctx, 'intent', () => { release = ctx.ledger.beginJobAdmission(ctx.jobId, 'late admission'); });
    expect(bodyOf(mustRequest(ctx))).toMatchObject({ error: 'request_closeout_stopped' });
    release();
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)?.state).toBe('stopped');
    expect(ctx.ledger.getDirective(ctx.requestId)?.state).toBe('dispatching');
    expect(() => ctx.ledger.claimDirectiveDispatch(ctx.requestId)).toThrow(CloseoutPendingError);
    const admissions = vi.spyOn(ctx.ledger, 'beginJobAdmission');
    const before = cards(ctx);
    const service = progress(ctx);
    service.reconsider(); await service.settled();
    await service.dispose();
    expect(admissions).not.toHaveBeenCalled();
    expect(ctx.spawns).toEqual([]);
    expect(cards(ctx)).toBe(before);
    expectNoOwnerAttribution(ctx);
  });

  it('4c. surfaceDirectiveRecovery posts no card for a request a closeout owes its end', async () => {
    const ctx = await deferred();
    crashAt(ctx, 'intent');
    expect(() => request(ctx)).toThrow();
    // Gru has already dispositioned the old card: a new one would be a fresh incident.
    ctx.ledger.resolveNotificationById(ctx.ledger.findNotificationByKind(kind(ctx), 'active')!.id, 'gru');
    const before = cards(ctx);
    surfaceDirectiveRecovery({ ledger: ctx.ledger, notifications: ctx.notifications }, ctx.requestId, 'a late failure');
    expect(cards(ctx)).toBe(before);
    expect(ctx.ledger.findNotificationByKind(kind(ctx), 'active')).toBeNull();
  });
});

describe('canceled-request closeout — stopped and retry (test 5)', () => {
  it('5a. a guard that refuses at S2 stops the intent; a repeat and resumePending write nothing; releasing the guard completes it', async () => {
    const ctx = await deferred();
    let release = (): void => {};
    once(ctx, 'intent', () => { release = ctx.ledger.beginJobAdmission(ctx.jobId, 'late admission'); });
    const stopped = mustRequest(ctx);
    expect(stopped.status).toBe(409);
    expect(bodyOf(stopped)).toMatchObject({ error: 'request_closeout_stopped' });
    expect(blockersOf(stopped)).toEqual([{ code: 'live_work', detail: expect.stringContaining('in-flight admission(s): late admission') }]);
    const intent = ctx.ledger.latestCloseoutForJob(ctx.jobId)!;
    expect(intent).toMatchObject({ state: 'stopped', blockerFingerprint: closeoutBlockerFingerprint(intent.blockers) });
    expect(ctx.ledger.getDirective(ctx.requestId)?.state).toBe('dispatching');
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('working');
    expect(jobEvents(ctx, 'silas.closeout-stopped')).toHaveLength(1);
    expect(payloadOf(jobEvents(ctx, 'silas.closeout-stopped')[0]!)).toEqual({ closeout_id: intent.closeoutId, request_id: ctx.requestId, generation: 1,
      blockers: intent.blockers, blocker_fingerprint: intent.blockerFingerprint, by: CLOSEOUT_ACTOR });
    const seq = ctx.ledger.latestEventSeq(); const before = cards(ctx);
    expect(mustRequest(ctx)).toEqual(stopped);
    expect(ctx.closeout.resumePending()).toMatchObject({ examined: 1, untouched: 1, completed: 0 });
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
    expect(cards(ctx)).toBe(before);
    release();
    expect(ctx.closeout.resumePending()).toMatchObject({ examined: 1, completed: 1, failures: [] });
    expectCancelled(ctx);
    expect(jobEvents(ctx, 'silas.directive-retired')).toHaveLength(1);
    expect(jobEvents(ctx, 'silas.closeout-complete')).toHaveLength(1);
    expectNoOwnerAttribution(ctx);
  });

  it('5b. live work that appears after S2 stops the intent at S3 with the request already retired', async () => {
    const ctx = await deferred();
    let release = (): void => {};
    once(ctx, 'retire', () => { release = ctx.ledger.beginJobAdmission(ctx.jobId, 'late admission'); });
    const stopped = mustRequest(ctx);
    expect(stopped.status).toBe(409);
    expect(bodyOf(stopped)).toMatchObject({ error: 'request_closeout_stopped' });
    expect(blockersOf(stopped)).toEqual([{ code: 'live_work', detail: expect.stringContaining('in-flight admission(s): late admission') }]);
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)?.state).toBe('stopped');
    expect(ctx.ledger.getDirective(ctx.requestId)?.state).toBe('retired');
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('working');
    const seq = ctx.ledger.latestEventSeq(); const before = cards(ctx);
    expect(mustRequest(ctx)).toEqual(stopped);
    expect(ctx.closeout.resumePending()).toMatchObject({ examined: 1, untouched: 1 });
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
    expect(cards(ctx)).toBe(before);
    release();
    expect(ctx.closeout.resumePending()).toMatchObject({ completed: 1, failures: [] });
    expectCancelled(ctx);
    expect(jobEvents(ctx, 'silas.directive-retired')).toHaveLength(1);
    expectNoOwnerAttribution(ctx);
  });

  it('5c. a changed blocker set re-attempts the step and records the new blockers', async () => {
    const ctx = await deferred();
    const releases: Array<() => void> = [];
    once(ctx, 'intent', () => { releases.push(ctx.ledger.beginJobAdmission(ctx.jobId, 'first admission')); });
    const first = mustRequest(ctx);
    expect(blockersOf(first)[0]?.detail).toContain('first admission');
    const firstFingerprint = ctx.ledger.latestCloseoutForJob(ctx.jobId)!.blockerFingerprint;
    releases.pop()!();
    releases.push(ctx.ledger.beginJobAdmission(ctx.jobId, 'second admission'));
    const second = mustRequest(ctx);
    expect(bodyOf(second)).toMatchObject({ error: 'request_closeout_stopped' });
    expect(blockersOf(second)[0]?.detail).toContain('second admission');
    const intent = ctx.ledger.latestCloseoutForJob(ctx.jobId)!;
    expect(intent.state).toBe('stopped');
    expect(intent.blockerFingerprint).not.toBe(firstFingerprint);
    expect(jobEvents(ctx, 'silas.closeout-stopped')).toHaveLength(2);
    releases.pop()!();
    expect(mustRequest(ctx).status).toBe(200);
    expectCancelled(ctx);
    expectNoOwnerAttribution(ctx);
  });
});

describe('canceled-request closeout — complete repeat (test 6)', () => {
  it('6. a repeated request after completion returns the original closeout and writes no event', async () => {
    const ctx = await deferred();
    const first = mustRequest(ctx);
    const seq = ctx.ledger.latestEventSeq();
    const again = mustRequest(ctx);
    expect(again.status).toBe(200);
    expect(bodyOf(again).closeout).toEqual(bodyOf(first).closeout);
    expect(bodyOf(again).closeout).toMatchObject({ state: 'complete', generation: 1 });
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
    expect(jobEvents(ctx, 'silas.closeout-intent')).toHaveLength(1);
    expect(jobEvents(ctx, 'silas.closeout-complete')).toHaveLength(1);
    expectNoOwnerAttribution(ctx);
  });
});

describe('canceled-request closeout — stale intent (test 7)', () => {
  it('7a. a job status change after S1 supersedes the intent (job-status), lifts the fence and a new request starts generation 2', async () => {
    const ctx = await deferred();
    once(ctx, 'intent', () => { ctx.ledger.setJobStatus(ctx.jobId, 'delivered'); });
    const superseded = mustRequest(ctx);
    expect(superseded.status).toBe(409);
    expect(bodyOf(superseded)).toEqual({ error: 'request_closeout_superseded', superseded_reason: 'job-status' });
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toMatchObject({ state: 'superseded', supersededReason: 'job-status', generation: 1 });
    expect(jobEvents(ctx, 'silas.closeout-superseded').map(payloadOf)).toEqual([{ closeout_id: ctx.ledger.latestCloseoutForJob(ctx.jobId)!.closeoutId,
      request_id: ctx.requestId, generation: 1, superseded_reason: 'job-status', by: CLOSEOUT_ACTOR }]);
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('delivered');
    expect(ctx.ledger.getDirective(ctx.requestId)?.state).toBe('dispatching');
    // The fence is lifted: a claim is no longer refused by the closeout.
    let claimError: unknown = null;
    try { ctx.ledger.claimDirectiveDispatch(ctx.requestId); } catch (error) { claimError = error; }
    expect(claimError).not.toBeInstanceOf(CloseoutPendingError);
    // Put the request back in its deferred state so it is still eligible.
    const start = ctx.ledger.latestJobEventByRequestId(ctx.jobId, 'silas.directive-dispatch-started', ctx.requestId)!;
    ctx.ledger.recordDirectiveDispatchDeferral(ctx.ledger.directiveTurnIdentity(ctx.requestId), start.seq, 'deferred again');
    const next = mustRequest(ctx);
    expect(next.status).toBe(200);
    expect(bodyOf(next).closeout).toMatchObject({ state: 'complete', generation: 2 });
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('binned');
    expectNoOwnerAttribution(ctx);
  });

  it('7b. new work accepted after S2 supersedes the intent (later-work) and leaves the new request untouched', async () => {
    const ctx = await deferred();
    let fresh: ReturnType<LedgerApi['getDirective']> = null;
    once(ctx, 'retire', () => {
      ctx.ledger.beginDirectiveIntent({ jobId: ctx.jobId, directive: 'fresh authorised work', holder: 'silas-ops', requestId: 'req-fresh' });
      fresh = ctx.ledger.getDirective('req-fresh');
    });
    const superseded = mustRequest(ctx);
    expect(bodyOf(superseded)).toEqual({ error: 'request_closeout_superseded', superseded_reason: 'later-work' });
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toMatchObject({ state: 'superseded', supersededReason: 'later-work' });
    expect(jobEvents(ctx, 'silas.closeout-superseded')).toHaveLength(1);
    expect(payloadOf(jobEvents(ctx, 'silas.closeout-superseded')[0]!)).toMatchObject({ request_id: ctx.requestId, superseded_reason: 'later-work', by: CLOSEOUT_ACTOR });
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('working');
    expect(fresh).not.toBeNull();
    expect(ctx.ledger.getDirective('req-fresh')).toEqual(fresh);
    expectNoOwnerAttribution(ctx);
  });

  it('7c. an amendment accepted after S2 supersedes the intent (control-event)', async () => {
    const ctx = await deferred();
    once(ctx, 'retire', () => {
      const contract = ctx.ledger.effectiveContract(ctx.jobId)!;
      expect(ctx.ledger.addJobAmendment({ jobId: ctx.jobId, body: 'a clarified requirement', effect: 'administrative',
        approval: { by: 'fixture-approver', reference: 'closeout test' }, expectedContractSha256: contract.contractSha256 }).status).toBe('accepted');
    });
    const superseded = mustRequest(ctx);
    expect(bodyOf(superseded)).toEqual({ error: 'request_closeout_superseded', superseded_reason: 'control-event' });
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toMatchObject({ state: 'superseded', supersededReason: 'control-event' });
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('working');
    expectNoOwnerAttribution(ctx);
  });

  it('7d. a request retired by hand after S1 satisfies S2 (the manual retire path stays valid)', async () => {
    const ctx = await deferred();
    once(ctx, 'intent', () => retireByHand(ctx));
    expect(mustRequest(ctx).status).toBe(200);
    expect(ctx.ledger.getDirective(ctx.requestId)).toMatchObject({ state: 'retired', retiredBy: 'silas-ops' });
    expect(jobEvents(ctx, 'silas.directive-retired')).toHaveLength(1);
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('binned');
    // The hand retirement keeps its own attribution; the closeout's writes are still never the owner's.
    expectNoOwnerAttribution(ctx);
  });
});

describe('canceled-request closeout — a stale intent, further cases (test 7)', () => {
  it('7h. an amendment accepted after S1 and before S2 supersedes the intent (control-event) and nothing is retired', async () => {
    const ctx = await deferred();
    once(ctx, 'intent', () => {
      const contract = ctx.ledger.effectiveContract(ctx.jobId)!;
      expect(ctx.ledger.addJobAmendment({ jobId: ctx.jobId, body: 'a clarified requirement', effect: 'administrative',
        approval: { by: 'fixture-approver', reference: 'closeout test' }, expectedContractSha256: contract.contractSha256 }).status).toBe('accepted');
    });
    const superseded = mustRequest(ctx);
    expect(bodyOf(superseded)).toEqual({ error: 'request_closeout_superseded', superseded_reason: 'control-event' });
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toMatchObject({ state: 'superseded', supersededReason: 'control-event' });
    // Revalidation runs BEFORE the retirement: the request was never touched.
    expect(ctx.ledger.getDirective(ctx.requestId)?.state).toBe('dispatching');
    expect(jobEvents(ctx, 'silas.directive-retired')).toEqual([]);
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('working');
    expectNoOwnerAttribution(ctx);
  });

  it('7e. a change to the request itself after S1 supersedes the intent (request-state) and lifts the fence', async () => {
    const ctx = await deferred();
    once(ctx, 'intent', () => { ctx.ledger.failDirective({ requestId: ctx.requestId, reason: 'refused before any prompt' }); });
    const superseded = mustRequest(ctx);
    expect(bodyOf(superseded)).toEqual({ error: 'request_closeout_superseded', superseded_reason: 'request-state' });
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toMatchObject({ state: 'superseded', supersededReason: 'request-state' });
    expect(ctx.ledger.hasPendingCloseout(ctx.requestId)).toBe(false);
    expect(ctx.ledger.getDirective(ctx.requestId)?.state).toBe('failed');
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('working');
    expectNoOwnerAttribution(ctx);
  });

  it('7i. a changed request payload after S2 supersedes the intent (request-state, the payload-hash half 7e never reaches)', async () => {
    const ctx = await deferred();
    // S2 has already retired the request, so the payload hash is the ONE predicate
    // left: a retired request with its original hash and its one own retire event
    // passes every other revalidation the intent owes. It fires HERE, after S2, and
    // not right after S1: between S1 and S2 a changed hash also breaks the
    // deferral-identity predicate, so the !pending half would answer request-state
    // first and mask this comparison — move it earlier and the pin goes vacuous.
    once(ctx, 'retire', () => {
      const restated = JSON.stringify({ directive: 'a restated directive under the same request id', blocker_fingerprint: null });
      ctx.db.handle.prepare('UPDATE pending_directives SET payload = ?, payload_hash = ? WHERE request_id = ?')
        .run(restated, createHash('sha256').update(restated).digest('hex'), ctx.requestId);
    });
    const superseded = mustRequest(ctx);
    expect(superseded.status).toBe(409);
    expect(bodyOf(superseded)).toEqual({ error: 'request_closeout_superseded', superseded_reason: 'request-state' });
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toMatchObject({ state: 'superseded', supersededReason: 'request-state' });
    expect(payloadOf(jobEvents(ctx, 'silas.closeout-superseded')[0]!)).toMatchObject({ request_id: ctx.requestId,
      superseded_reason: 'request-state', by: CLOSEOUT_ACTOR });
    // The retirement itself stands: the superseded intent never bins the job,
    // and the fence it held on the request is lifted.
    expect(jobEvents(ctx, 'silas.directive-retired')).toHaveLength(1);
    expect(ctx.ledger.getDirective(ctx.requestId)?.state).toBe('retired');
    expect(binnedEvents(ctx)).toEqual([]);
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('working');
    expect(ctx.ledger.hasPendingCloseout(ctx.requestId)).toBe(false);
    expectNoOwnerAttribution(ctx);
  });

  it('7f. a stopped intent whose blockers are unchanged writes nothing even when its basis changed; once the guard clears it is superseded', async () => {
    const ctx = await deferred();
    let release = (): void => {};
    once(ctx, 'intent', () => { release = ctx.ledger.beginJobAdmission(ctx.jobId, 'late admission'); });
    const stopped = mustRequest(ctx);
    expect(bodyOf(stopped)).toMatchObject({ error: 'request_closeout_stopped' });
    cleanups.push(() => release());
    ctx.ledger.setJobStatus(ctx.jobId, 'delivered');
    // The admission still holds the lane, so the blockers are unchanged: nothing is written and the answer stands.
    const seq = ctx.ledger.latestEventSeq();
    expect(mustRequest(ctx)).toEqual(stopped);
    expect(ctx.closeout.resumePending()).toMatchObject({ examined: 1, untouched: 1, superseded: 0 });
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)?.state).toBe('stopped');
    // The readback says what the next request would do.
    expect(ctx.closeout.describe(ctx.requestId)).toMatchObject({ path: 'closeout', eligible: false });
    release();
    // The guard cleared: the intent resumes, finds the job status changed and is superseded (the fence is lifted).
    expect(ctx.closeout.resumePending()).toMatchObject({ examined: 1, superseded: 1, completed: 0 });
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toMatchObject({ state: 'superseded', supersededReason: 'job-status' });
    expect(ctx.ledger.hasPendingCloseout(ctx.requestId)).toBe(false);
    expectNoOwnerAttribution(ctx);
  });

  it('7g. a job binned by another writer while its intent is stopped answers the binned retry with the plain 200', async () => {
    const ctx = await deferred();
    let release = (): void => {};
    once(ctx, 'retire', () => { release = ctx.ledger.beginJobAdmission(ctx.jobId, 'late admission'); });
    expect(bodyOf(mustRequest(ctx))).toMatchObject({ error: 'request_closeout_stopped' });
    release();
    // The request is retired and nothing else lives: the plain status write bins the job.
    expect(ctx.ledger.setJobStatus(ctx.jobId, 'binned').status).toBe('binned');
    expect(request(ctx)).toBeNull();
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toMatchObject({ state: 'superseded', supersededReason: 'job-status' });
    expect(ctx.ledger.setJobStatus(ctx.jobId, 'binned').status).toBe('binned');
    expectNoOwnerAttribution(ctx);
  });
});

describe('canceled-request closeout — refusal and fall-through (test 8)', () => {
  async function refused(prepare: (ctx: Ctx) => void, code: string, detail: RegExp): Promise<void> {
    const ctx = await deferred();
    prepare(ctx);
    const seq = ctx.ledger.latestEventSeq();
    const result = mustRequest(ctx);
    expect(result.status).toBe(409);
    expect(bodyOf(result).error).toBe('request_closeout_refused');
    expect(blockersOf(result)).toEqual([{ code, detail: expect.stringMatching(detail) }]);
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toBeNull();
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('working');
    expect(ctx.ledger.getDirective(ctx.requestId)?.state).toBe('dispatching');
  }

  it('8a. a supervisor producer blocker refuses with no intent row and no event', () =>
    refused((ctx) => { ctx.supervised = ['restart retry scheduled for minion-1']; }, 'live_work', /restart retry scheduled/));
  it('8b. a queued pace-gate entry refuses', () =>
    refused((ctx) => { ctx.queued = [{ id: ctx.jobId, label: 'directive redispatch' }]; }, 'live_work', /queued worker turn: directive redispatch/));
  it('8c. an in-flight job admission refuses', () =>
    refused((ctx) => { const release = ctx.ledger.beginJobAdmission(ctx.jobId, 'late admission'); cleanups.push(release); }, 'live_work', /in-flight admission\(s\): late admission/));
  it('8d. an open worker turn refuses', () =>
    refused((ctx) => {
      ctx.ledger.registerAgent({ id: 'minion-open', role: 'minion', jobId: ctx.jobId, sessionFile: join(ctx.dir, 'open.jsonl') });
      ctx.ledger.setAgentState('minion-open', 'streaming');
    }, 'live_work', /open worker turn\(s\): minion-open \(streaming\)/));
  it('8e. a live review round refuses', () =>
    refused((ctx) => { ctx.ledger.addRound({ jobId: ctx.jobId }); }, 'live_work', /live review round\(s\)/));
  it('8f. an unsettled verification run refuses', () =>
    refused((ctx) => { ctx.ledger.appendCustomEvent({ kind: 'verification.requested', jobId: ctx.jobId, payload: { run_id: 'run-open' } }); },
      'live_work', /unsettled verification run/));
  it('8g. a request with a correlated terminal receipt refuses with terminal_receipt_present', () =>
    refused((ctx) => { ctx.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: ctx.jobId, payload: { request_id: ctx.requestId, sha: ctx.repo.head() } }); },
      'terminal_receipt_present', /correlated job\.delivered receipt/));

  it('8h. a legacy request (null request_kind) falls through to today\'s binning, which refuses it', async () => {
    const ctx = await deferred();
    markHistoricalDirectiveFixture(ctx.ledger, ctx.requestId);
    const seq = ctx.ledger.latestEventSeq();
    expect(request(ctx)).toBeNull();
    expect(ctx.closeout.describe(ctx.requestId)).toMatchObject({ path: 'binning', eligible: false });
    expect(() => ctx.ledger.setJobStatus(ctx.jobId, 'binned')).toThrow(/live directive request/);
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toBeNull();
  });

  it('8i. a job with no live request falls through and is binned by today\'s path', () => {
    const ctx = boot('job-plain', 'req-none');
    ctx.ledger.addJob({ id: 'job-plain', repo: 'closeout-app', title: 'plain', briefing: 'b' });
    expect(request(ctx)).toBeNull();
    // A reason the closeout would never store does not change today's response.
    expect(request(ctx, 'gru', { reason: 42 })).toBeNull();
    expect(ctx.ledger.setJobStatus('job-plain', 'binned').status).toBe('binned');
    expect(ctx.ledger.latestCloseoutForJob('job-plain')).toBeNull();
  });

  it('8j. a request never claimed for dispatch falls through', async () => {
    const ctx = boot('job-unclaimed', 'req-unclaimed');
    ctx.ledger.addJob({ id: 'job-unclaimed', repo: 'closeout-app', title: 'u', briefing: 'b' });
    ctx.ledger.setJobStatus('job-unclaimed', 'working');
    ctx.ledger.beginDirectiveIntent({ jobId: 'job-unclaimed', directive: 'never dispatched', holder: 'silas-ops', requestId: 'req-unclaimed' });
    expect(request(ctx)).toBeNull();
    expect(() => ctx.ledger.setJobStatus('job-unclaimed', 'binned')).toThrow(/live directive request/);
  });

  it('8k. a claimed request that was never deferred (dispatch in flight) falls through', async () => {
    const ctx = boot('job-claimed', 'req-claimed');
    ctx.ledger.addJob({ id: 'job-claimed', repo: 'closeout-app', title: 'c', briefing: 'b' });
    ctx.ledger.setJobStatus('job-claimed', 'working');
    ctx.ledger.beginDirectiveIntent({ jobId: 'job-claimed', directive: 'in flight', holder: 'silas-ops', requestId: 'req-claimed' });
    expect(ctx.ledger.claimDirectiveDispatch('req-claimed')).toBe(true);
    expect(request(ctx)).toBeNull();
  });

  it('8l. an admitted request falls through', async () => {
    const ctx = boot('job-admitted', 'req-admitted');
    ctx.ledger.addJob({ id: 'job-admitted', repo: 'closeout-app', title: 'a', briefing: 'b' });
    ctx.ledger.setJobStatus('job-admitted', 'working');
    const intent = ctx.ledger.beginDirectiveIntent({ jobId: 'job-admitted', directive: 'admitted work', holder: 'silas-ops', requestId: 'req-admitted' }).record;
    markHistoricalDirectiveFixture(ctx.ledger, intent.requestId);
    const sent = ctx.ledger.appendCustomEvent({ kind: 'silas.directive-sent', jobId: 'job-admitted', payload: { request_id: intent.requestId, minion_id: 'minion-a' } });
    ctx.ledger.recordDirectiveAdmission({ requestId: intent.requestId, minionId: 'minion-a', eventSeq: sent.seq });
    // Admission alone is what excludes it: it carries a request kind and a dispatch claim again.
    ctx.db.handle.prepare("UPDATE pending_directives SET request_kind = 'directive', dispatch_started_at = ? WHERE request_id = ?")
      .run(new Date().toISOString(), intent.requestId);
    expect(ctx.ledger.getDirective('req-admitted')).toMatchObject({ state: 'admitted', requestKind: 'directive' });
    expect(request(ctx)).toBeNull();
  });

  it('8m. an already binned job without a completed closeout falls through; an unknown job does too', () => {
    const ctx = boot('job-gone', 'req-none');
    ctx.ledger.addJob({ id: 'job-gone', repo: 'closeout-app', title: 'g', briefing: 'b' });
    ctx.ledger.setJobStatus('job-gone', 'binned');
    expect(request(ctx)).toBeNull();
    expect(ctx.closeout.requestBinning('no-such-job', { status: 'binned' })).toBeNull();
  });

  it('8o. a pending legacy re-brief marker beside the deferred request falls through', async () => {
    const ctx = await deferred();
    ctx.db.handle.prepare(`INSERT INTO pending_rebriefs (id, job_id, kind, payload, payload_hash, baseline_seq, requested_at, updated_at)
      VALUES ('legacy-marker', ?, 'silas.rebrief', '{"note":"fold","briefing":"b"}', 'legacy-hash', 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`).run(ctx.jobId);
    expect(ctx.ledger.listPendingRebriefs({ jobId: ctx.jobId })).toHaveLength(1);
    const seq = ctx.ledger.latestEventSeq();
    expect(request(ctx)).toBeNull();
    expect(ctx.closeout.describe(ctx.requestId)).toMatchObject({ path: 'binning', eligible: false });
    expect(() => ctx.ledger.setJobStatus(ctx.jobId, 'binned')).toThrow(/pending re-brief marker/);
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
  });

  it('8q. a deferred request that already carries a recovery decision falls through', async () => {
    const ctx = await deferred();
    ctx.db.handle.prepare('UPDATE pending_directives SET recovery_decision = ? WHERE request_id = ?')
      .run(JSON.stringify({ fingerprint: 'decided', successorId: null, eventSeq: 1 }), ctx.requestId);
    expect(ctx.ledger.getDirective(ctx.requestId)?.recoveryDecision).not.toBeNull();
    const seq = ctx.ledger.latestEventSeq();
    expect(request(ctx)).toBeNull();
    expect(ctx.closeout.describe(ctx.requestId)).toMatchObject({ path: 'binning', eligible: false });
    expect(() => ctx.ledger.setJobStatus(ctx.jobId, 'binned')).toThrow(/live directive request/);
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
  });

  it('8r. a null reason is read as absent', async () => {
    const ctx = await deferred();
    expect(mustRequest(ctx, 'gru', { reason: null }).status).toBe(200);
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)?.reason).toBeNull();
    expect(ctx.ledger.getDirective(ctx.requestId)?.retireReason).not.toContain('null');
  });

  it('8p. S1 evaluates once more inside its transaction: a guard that appears after the pre-check still refuses with no intent row', async () => {
    const ctx = await deferred();
    let calls = 0;
    // The first evaluation (the pre-check) sees no producer; the second (S1, in its transaction) does.
    ctx.closeout = new CanceledRequestCloseout({ ledger: ctx.ledger, worktrees: ctx.worktrees,
      pendingProducerBlockers: () => { calls += 1; return calls > 1 ? ['late producer'] : []; } });
    const seq = ctx.ledger.latestEventSeq();
    const result = mustRequest(ctx);
    expect(calls).toBe(2);
    expect(result.status).toBe(409);
    expect(bodyOf(result).error).toBe('request_closeout_refused');
    expect(blockersOf(result)).toEqual([{ code: 'live_work', detail: 'late producer' }]);
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toBeNull();
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
    expect(ctx.ledger.getDirective(ctx.requestId)?.state).toBe('dispatching');
  });

  it('8n. a reason longer than 500 characters is a 400 invalid_reason, whatever the job', async () => {
    const ctx = await deferred();
    const seq = ctx.ledger.latestEventSeq();
    const tooLong = request(ctx, 'gru', { reason: 'x'.repeat(501) });
    expect(tooLong?.status).toBe(400);
    expect(bodyOf(tooLong).error).toBe('invalid_reason');
    expect(request(ctx, 'gru', { reason: 42 })?.status).toBe(400);
    expect(ctx.closeout.requestBinning('no-such-job', { status: 'binned', reason: 'y'.repeat(501) })?.status).toBe(400);
    expect(ctx.ledger.latestEventSeq()).toBe(seq);
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)).toBeNull();
    // Exactly 500 characters (counted as characters, not UTF-16 units) is accepted.
    expect(request(ctx, 'gru', { reason: '𝒳'.repeat(500) })?.status).toBe(200);
  });
});

describe('canceled-request closeout — body and actors (test 9)', () => {
  it('9a. by "owner" is stored as unattributed and nothing is attributed to the owner', async () => {
    const ctx = await deferred();
    expect(mustRequest(ctx, 'owner').status).toBe(200);
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)?.requestedBy).toBe('unattributed');
    expect(payloadOf(jobEvents(ctx, 'silas.closeout-intent')[0]!).requested_by).toBe('unattributed');
    expectNoOwnerAttribution(ctx);
  });

  it('9b. by "gru" is stored as gru', async () => {
    const ctx = await deferred();
    expect(mustRequest(ctx, 'gru').status).toBe(200);
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)?.requestedBy).toBe('gru');
    expectNoOwnerAttribution(ctx);
  });

  it('9c. a missing by is stored as unattributed, and so is any other label', async () => {
    const first = await deferred();
    // No `by` at all (the helper's default would supply one).
    expect(first.closeout.requestBinning(first.jobId, { status: 'binned' })?.status).toBe(200);
    expect(first.ledger.latestCloseoutForJob(first.jobId)?.requestedBy).toBe('unattributed');
    const second = await deferred();
    expect(mustRequest(second, 'Gru').status).toBe(200);
    expect(second.ledger.latestCloseoutForJob(second.jobId)?.requestedBy).toBe('unattributed');
  });

  it('9d. the reason is stored and appended to the retire reason; the actor is the closeout', async () => {
    const ctx = await deferred();
    expect(mustRequest(ctx, 'gru', { reason: 'cancelled: superseded by the new plan' }).status).toBe(200);
    expect(ctx.ledger.latestCloseoutForJob(ctx.jobId)?.reason).toBe('cancelled: superseded by the new plan');
    const row = ctx.ledger.getDirective(ctx.requestId)!;
    expect(row.retireReason).toContain('cancelled: superseded by the new plan');
    expect(row.retireReason).toContain(ctx.requestId);
    expect(row.retiredBy).toBe(CLOSEOUT_ACTOR);
    expect(payloadOf(jobEvents(ctx, 'silas.directive-retired')[0]!).by).toBe(CLOSEOUT_ACTOR);
    expect(ctx.ledger.findNotificationByKind(kind(ctx), 'any')?.resolvedBy).toBe(CLOSEOUT_ACTOR);
  });
});

describe('canceled-request closeout — shared eligibility (test 10)', () => {
  it('10. the readback\'s path and eligible always match the request\'s outcome', async () => {
    const outcomes: string[] = [];
    const compare = async (label: string, prepare: (ctx: Ctx) => void | Promise<void>, expected: 'complete' | 'refused' | 'fall-through'): Promise<void> => {
      const ctx = await deferred({ jobId: `job-${label}`, requestId: `req-${label}` });
      await prepare(ctx);
      const view = ctx.closeout.describe(ctx.requestId);
      const result = request(ctx);
      if (view.eligible) {
        expect(result?.status, label).toBe(200);
        outcomes.push('complete');
      } else if (view.path === 'closeout') {
        expect(result?.status, label).toBe(409);
        expect(bodyOf(result).error, label).toBe('request_closeout_refused');
        expect(blockersOf(result), label).toEqual(view.blockers);
        expect(view.blockers.length, label).toBeGreaterThan(0);
        outcomes.push('refused');
      } else {
        expect(result, label).toBeNull();
        outcomes.push('fall-through');
      }
      expect(outcomes.at(-1), label).toBe(expected);
    };
    await compare('eligible', () => {}, 'complete');
    await compare('parked', (ctx) => { ctx.ledger.setJobStatus(ctx.jobId, 'parked'); }, 'complete');
    await compare('supervised', (ctx) => { ctx.supervised = ['restart retry scheduled']; }, 'refused');
    await compare('queued', (ctx) => { ctx.queued = [{ id: ctx.jobId, label: 'queued redispatch' }]; }, 'refused');
    await compare('admission', (ctx) => { cleanups.push(ctx.ledger.beginJobAdmission(ctx.jobId, 'late admission')); }, 'refused');
    await compare('receipt', (ctx) => { ctx.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: ctx.jobId, payload: { request_id: ctx.requestId, sha: ctx.repo.head() } }); }, 'refused');
    await compare('legacy', (ctx) => { markHistoricalDirectiveFixture(ctx.ledger, ctx.requestId); }, 'fall-through');
    await compare('terminal', (ctx) => { markLegacyTerminalJobFixture(ctx.ledger, ctx.jobId, 'binned'); }, 'fall-through');
    await compare('turn', (ctx) => {
      ctx.ledger.registerAgent({ id: 'minion-open', role: 'minion', jobId: ctx.jobId, sessionFile: join(ctx.dir, 'open.jsonl') });
      ctx.ledger.setAgentState('minion-open', 'streaming');
    }, 'refused');
    await compare('round', (ctx) => { ctx.ledger.addRound({ jobId: ctx.jobId }); }, 'refused');
    await compare('verification', (ctx) => { ctx.ledger.appendCustomEvent({ kind: 'verification.requested', jobId: ctx.jobId, payload: { run_id: 'run-open' } }); }, 'refused');
    await compare('marker', (ctx) => {
      ctx.db.handle.prepare(`INSERT INTO pending_rebriefs (id, job_id, kind, payload, payload_hash, baseline_seq, requested_at, updated_at)
        VALUES ('legacy-marker', ?, 'silas.rebrief', '{"note":"fold","briefing":"b"}', 'legacy-hash', 0, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`).run(ctx.jobId);
    }, 'fall-through');
    await compare('decided', (ctx) => {
      ctx.db.handle.prepare('UPDATE pending_directives SET recovery_decision = ? WHERE request_id = ?')
        .run(JSON.stringify({ fingerprint: 'decided', successorId: null, eventSeq: 1 }), ctx.requestId);
    }, 'fall-through');
    await compare('unclaimed', (ctx) => { ctx.db.handle.prepare('UPDATE pending_directives SET dispatch_started_at = NULL WHERE request_id = ?').run(ctx.requestId); }, 'fall-through');
  });

  it('10b. a stopped intent reads back as the closeout path with its blockers', async () => {
    const ctx = await deferred();
    let release = (): void => {};
    once(ctx, 'intent', () => { release = ctx.ledger.beginJobAdmission(ctx.jobId, 'late admission'); });
    mustRequest(ctx);
    const view = ctx.closeout.describe(ctx.requestId);
    expect(view).toMatchObject({ path: 'closeout', eligible: false });
    expect(view.intent).toMatchObject({ state: 'stopped', generation: 1 });
    expect(view.blockers).toEqual(view.intent?.blockers);
    release();
    expect(ctx.closeout.describe(ctx.requestId)).toMatchObject({ path: 'closeout', eligible: true, blockers: [] });
    expectNoOwnerAttribution(ctx);
  });
});

describe('canceled-request closeout — the readback path (test 10)', () => {
  it('10c. the path is the job\'s: every request of an eligible job reads closeout, each with its own latest intent', async () => {
    const ctx = await deferred();
    retireByHand(ctx);
    ctx.ledger.beginRebriefIntent({ jobId: ctx.jobId, note: 'second try', holder: 'silas-ops', requestId: 'req-second' });
    expect(ctx.ledger.claimDirectiveDispatch('req-second')).toBe(true);
    const start = ctx.ledger.latestJobEventByRequestId(ctx.jobId, 'silas.directive-dispatch-started', 'req-second')!;
    ctx.ledger.recordDirectiveDispatchDeferral(ctx.ledger.directiveTurnIdentity('req-second'), start.seq, 'deferred again');
    expect(ctx.closeout.describe(ctx.requestId)).toMatchObject({ path: 'closeout', eligible: true, blockers: [], intent: null });
    expect(ctx.closeout.describe('req-second')).toMatchObject({ path: 'closeout', eligible: true, blockers: [], intent: null });
    // A binning request closes out the request the rule names, and the earlier request's own intent stays null.
    expect(mustRequest(ctx).status).toBe(200);
    expect(ctx.ledger.latestCloseoutForRequest('req-second')).toMatchObject({ state: 'complete' });
    expect(ctx.ledger.latestCloseoutForRequest(ctx.requestId)).toBeNull();
    expect(ctx.closeout.describe(ctx.requestId)).toMatchObject({ path: 'binning', eligible: false });
  });

  it('10d. a request an open or stopped intent owes its end reads back as the closeout path after S2 too, with the S3 blockers', async () => {
    const ctx = await deferred();
    let release = (): void => {};
    once(ctx, 'retire', () => { release = ctx.ledger.beginJobAdmission(ctx.jobId, 'late admission'); });
    const stopped = mustRequest(ctx);
    expect(ctx.ledger.getDirective(ctx.requestId)?.state).toBe('retired');
    const view = ctx.closeout.describe(ctx.requestId);
    expect(view).toMatchObject({ path: 'closeout', eligible: false });
    expect(view.blockers).toEqual(blockersOf(stopped));
    expect(view.intent).toMatchObject({ state: 'stopped' });
    release();
    expect(ctx.closeout.describe(ctx.requestId)).toMatchObject({ path: 'closeout', eligible: true, blockers: [] });
    expect(mustRequest(ctx).status).toBe(200);
    expect(ctx.closeout.describe(ctx.requestId)).toMatchObject({ path: 'binning', eligible: false });
    expectNoOwnerAttribution(ctx);
  });
});

describe('canceled-request closeout — the readback of a stale intent (test 10)', () => {
  it('10e. an open intent whose basis changed reads as not eligible, and the next binning request supersedes it', async () => {
    const ctx = await deferred();
    crashAt(ctx, 'intent');
    expect(() => request(ctx)).toThrow('crash after intent');
    expect(ctx.closeout.describe(ctx.requestId)).toMatchObject({ path: 'closeout', eligible: true, blockers: [] });
    ctx.ledger.failDirective({ requestId: ctx.requestId, reason: 'refused before any prompt' });
    const view = ctx.closeout.describe(ctx.requestId);
    expect(view).toMatchObject({ path: 'closeout', eligible: false });
    expect(view.blockers).toEqual([{ code: 'intent_stale', detail: expect.stringContaining('request-state') }]);
    expect(bodyOf(mustRequest(ctx))).toEqual({ error: 'request_closeout_superseded', superseded_reason: 'request-state' });
    expectNoOwnerAttribution(ctx);
  });
});

describe('canceled-request closeout — the blocker fingerprint', () => {
  it('5d. the blocker fingerprint is the sha256 of the sorted codes and details: order-independent and sensitive to both', () => {
    const live = { code: 'live_work', detail: 'in-flight admission(s): x' };
    const receipt = { code: 'terminal_receipt_present', detail: 'receipt at seq 9' };
    const expected = createHash('sha256').update(JSON.stringify([['live_work', 'in-flight admission(s): x'], ['terminal_receipt_present', 'receipt at seq 9']])).digest('hex');
    expect(closeoutBlockerFingerprint([live, receipt])).toBe(expected);
    expect(closeoutBlockerFingerprint([receipt, live])).toBe(expected);
    expect(closeoutBlockerFingerprint([live])).not.toBe(expected);
    expect(closeoutBlockerFingerprint([{ ...live, detail: 'other' }])).not.toBe(closeoutBlockerFingerprint([live]));
    expect(closeoutBlockerFingerprint([{ ...live, code: 'other' }])).not.toBe(closeoutBlockerFingerprint([live]));
    expect(closeoutBlockerFingerprint([])).toBe(createHash('sha256').update('[]').digest('hex'));
  });
});

describe('canceled-request closeout — resume drivers (test 11)', () => {
  it('11a. runBootDirectiveRecovery calls reconsider() first and then completes an open intent', async () => {
    const ctx = await deferred();
    crashAt(ctx, 'intent');
    expect(() => request(ctx)).toThrow();
    ctx.restart();
    const order: string[] = [];
    const report = runBootDirectiveRecovery({
      directiveProgress: { reconsider: () => { order.push(`reconsider:${ctx.ledger.latestCloseoutForJob(ctx.jobId)?.state}`); } },
      closeout: { resumePending: () => { order.push('resume'); return ctx.closeout.resumePending(); } },
    });
    expect(order).toEqual(['reconsider:open', 'resume']);
    expect(report).toMatchObject({ examined: 1, completed: 1, failures: [] });
    expectCancelled(ctx);
    expectNoOwnerAttribution(ctx);
  });

  it('11b. binningCloseoutRoute answers null until the closeout exists, and its result after', async () => {
    const ctx = await deferred();
    let current: CanceledRequestCloseout | undefined = undefined;
    const route = binningCloseoutRoute(() => current);
    expect(route(ctx.jobId, { status: 'binned', by: 'gru' })).toBeNull();
    expect(ctx.ledger.getJob(ctx.jobId)?.status).toBe('working');
    current = ctx.closeout;
    const result = route(ctx.jobId, { status: 'binned', by: 'gru' });
    expect(result?.status).toBe(200);
    expect(bodyOf(result).closeout).toMatchObject({ state: 'complete' });
    expectCancelled(ctx);
    expectNoOwnerAttribution(ctx);
  });
});
