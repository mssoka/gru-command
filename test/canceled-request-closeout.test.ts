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
  runBootDirectiveRecovery,
  type CloseoutHttpResult,
  type CloseoutStep,
} from '../src/dispatch/canceled-request-closeout.js';
import type { DirectiveRegistry } from '../src/dispatch/fix-directive.js';
import { CLOSEOUT_ACTOR, CloseoutPendingError, closeoutBlockerFingerprint } from '../src/ledger/closeouts.js';
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
const request = (ctx: Ctx, by: unknown = 'gru', extra: Record<string, unknown> = {}): CloseoutHttpResult | null =>
  ctx.closeout.requestBinning(ctx.jobId, { status: 'binned', ...(by === undefined ? {} : { by }), ...extra });
const mustRequest = (ctx: Ctx, by: unknown = 'gru', extra: Record<string, unknown> = {}): CloseoutHttpResult => {
  const result = request(ctx, by, extra);
  if (result === null) throw new Error('expected the closeout to take the binning request');
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
    expectNoOwnerAttribution(ctx);
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
