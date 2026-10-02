import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { adoptBlockedLanes, observeFollowUpDelivery, observePhaseCompletion, reconcileUnmarkedHandbacks } from '../src/dispatch/obligations.js';
import { finalizeRebriefRequest } from '../src/dispatch/rebrief-recovery.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { selectDueObligations } from '../src/ledger/obligations.js';

/**
 * Durable follow-through observers (phase 3 slice) — incidents 131/132/133
 * (same-head audit completes on a still-blocked lane: the next Gru ruling
 * must be durably requested without owner prompting) and the
 * notification-vs-settlement separation (an ack/shown/disposition never
 * settles unfinished work; a delegated phase that misses its deadline
 * returns to attention).
 *
 * Deterministic: real LedgerDb on a temp dir, in-memory bus, explicit
 * event watermarks, no clocks/sockets/providers.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-handback-'));
  cleanupDirs.push(dir);
  return dir;
}

function makeHarness(): {
  db: LedgerDb;
  bus: EventBus;
  ledger: LedgerApi;
  notifications: NotificationCenter;
} {
  const db = new LedgerDb(tmpDir());
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  return { db, bus, ledger, notifications };
}

function seedJob(ledger: LedgerApi, jobId: string, status: 'working' | 'blocked' = 'working'): void {
  ledger.addJob({ id: jobId, repo: 'r', title: jobId });
  ledger.setJobStatus(jobId, 'working');
  if (status === 'blocked') ledger.setJobStatus(jobId, 'blocked');
}

describe('same-head phase completion hands the next decision back durably (incident 1)', () => {
  it('a settled silas-directive phase on a still-blocked lane records ONE hand-back: obligation + action-required card', () => {
    const h = makeHarness();
    seedJob(h.ledger, 'job-hb1', 'blocked');
    const delivered = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-hb1',
      payload: { source: 'silas-directive', sha: 'e933cfde', agentId: 'minion-9' },
    });
    const result = observeFollowUpDelivery({ ledger: h.ledger, notifications: h.notifications }, delivered);
    expect(result).not.toBeNull();
    expect(result?.created).toBe(true);
    const obligation = h.ledger.getObligation(result!.obligationId);
    expect(obligation).toMatchObject({
      jobId: 'job-hb1',
      incidentKey: `phase-handback@${delivered.seq}`,
      state: 'open',
    });
    expect(obligation?.category).toEqual({ kind: 'known', category: 'phase-completion' });
    expect(obligation?.nextAction.kind).toBe('gru-decision');
    expect(obligation?.authority).toBeNull(); // same head is evidence, never authority
    const card = h.ledger.findNotificationByKind(result!.notificationKind, 'unacked');
    expect(card).not.toBeNull();
    expect(card?.routing).toBe('action-required'); // machine wake — never the owner bell
    expect(card?.detail).toContain('e933cfde');
    // A replay of the SAME delivered event coalesces: one obligation, one card.
    const replay = observeFollowUpDelivery({ ledger: h.ledger, notifications: h.notifications }, delivered);
    expect(replay?.created).toBe(false);
    expect(replay?.obligationId).toBe(result?.obligationId);
    expect(
      h.ledger.listObligations({ jobId: 'job-hb1' }).filter((row) => row.incidentKey.startsWith('phase-handback@')),
    ).toHaveLength(1);
    expect(
      h.ledger.listNotifications({ limit: 200 }).filter((row) => row.kind === result!.notificationKind),
    ).toHaveLength(1);
  });

  it('distinct phase completions are distinct hand-backs; non-silas deliveries and unblocked lanes record nothing', () => {
    const h = makeHarness();
    seedJob(h.ledger, 'job-hb2', 'blocked');
    // Normal dispatch delivery is the review flow, not a blocked hand-back.
    const dispatchDelivery = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-hb2',
      payload: { source: 'dispatch', sha: 'aaa' },
    });
    expect(observeFollowUpDelivery({ ledger: h.ledger, notifications: h.notifications }, dispatchDelivery)).toBeNull();
    // A follow-up delivery on a lane that is NOT blocked is the normal loop.
    seedJob(h.ledger, 'job-hb3', 'working');
    const normal = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-hb3',
      payload: { source: 'silas-directive', sha: 'bbb' },
    });
    expect(observeFollowUpDelivery({ ledger: h.ledger, notifications: h.notifications }, normal)).toBeNull();
    // Two distinct completions on the blocked lane: two obligations, two cards.
    const first = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-hb2',
      payload: { source: 'silas-directive', sha: 'ccc' },
    });
    const second = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-hb2',
      payload: { source: 'silas-rebrief', sha: 'ddd' },
    });
    observeFollowUpDelivery({ ledger: h.ledger, notifications: h.notifications }, first);
    observeFollowUpDelivery({ ledger: h.ledger, notifications: h.notifications }, second);
    const handbacks = h.ledger
      .listObligations({ jobId: 'job-hb2' })
      .filter((row) => row.incidentKey.startsWith('phase-handback@'));
    expect(handbacks.map((row) => row.incidentKey).sort()).toEqual(
      [`phase-handback@${first.seq}`, `phase-handback@${second.seq}`].sort(),
    );
  });
});

describe('conservative boot adoption of pre-existing blocked lanes', () => {
  it('adopts ONLY lanes with no obligation history; parked/terminal lanes stay untouched; a second pass is a no-op', () => {
    const h = makeHarness();
    // A lane blocked BEFORE this feature existed: blocked row, no obligation.
    seedJob(h.ledger, 'job-old');
    h.db.handle.prepare("UPDATE jobs SET status = 'blocked' WHERE id = ?").run('job-old');
    // A lane the live system already tracks: blocked through the boundary.
    seedJob(h.ledger, 'job-tracked', 'blocked');
    // Parked and terminal lanes are not adoption territory.
    seedJob(h.ledger, 'job-parked');
    h.ledger.setJobStatus('job-parked', 'parked');
    seedJob(h.ledger, 'job-done');
    h.ledger.setJobStatus('job-done', 'done');

    const first = adoptBlockedLanes({ ledger: h.ledger, notifications: h.notifications });
    expect(first.adopted).toBe(1); // job-old only
    const adopted = h.ledger.listObligations({ jobId: 'job-old' });
    expect(adopted).toHaveLength(1);
    expect(adopted[0]).toMatchObject({ category: { kind: 'unknown' }, state: 'open' });
    expect(adopted[0]?.nextAction.kind).toBe('gru-decision'); // triage owed to Gru
    expect(h.ledger.listObligations({ jobId: 'job-tracked' })).toHaveLength(1); // untouched
    expect(h.ledger.listObligations({ jobId: 'job-parked' })).toHaveLength(0);
    expect(h.ledger.listObligations({ jobId: 'job-done' })).toHaveLength(0);
    const second = adoptBlockedLanes({ ledger: h.ledger, notifications: h.notifications });
    expect(second.adopted).toBe(0);
    expect(h.ledger.listObligations({ jobId: 'job-old' })).toHaveLength(1);
  });

  it('adoption advances past already-adopted lanes across passes — the tail is never starved (N3)', () => {
    const h = makeHarness();
    // Three blocked orphans created before the feature, same updated_at so
    // listJobs' id tiebreak fixes the candidate order (a, b, c).
    seedJob(h.ledger, 'job-adopt-a');
    seedJob(h.ledger, 'job-adopt-b');
    seedJob(h.ledger, 'job-adopt-c');
    h.db.handle
      .prepare("UPDATE jobs SET status = 'blocked', updated_at = '2026-09-28T00:00:00.000Z' WHERE id LIKE 'job-adopt-%'")
      .run();
    const first = adoptBlockedLanes({ ledger: h.ledger, notifications: h.notifications }, { limit: 1 });
    expect(first.adopted).toBe(1);
    // The next pass must move PAST the adopted prefix, not re-scan it.
    const second = adoptBlockedLanes({ ledger: h.ledger, notifications: h.notifications }, { limit: 1 });
    expect(second.adopted).toBe(1);
    const third = adoptBlockedLanes({ ledger: h.ledger, notifications: h.notifications }, { limit: 1 });
    expect(third.adopted).toBe(1);
    const fourth = adoptBlockedLanes({ ledger: h.ledger, notifications: h.notifications }, { limit: 1 });
    expect(fourth.adopted).toBe(0); // exhausted, not starved
    for (const jobId of ['job-adopt-a', 'job-adopt-b', 'job-adopt-c']) {
      expect(h.ledger.listObligations({ jobId })).toHaveLength(1);
    }
  });
});

describe('attention disposition is not settlement; delegated work keeps its debt (incident 4)', () => {
  it('shown/ack alone never settles the obligation; a missed receipt deadline returns to attention', () => {
    const h = makeHarness();
    seedJob(h.ledger, 'job-att', 'blocked');
    const delivered = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-att',
      payload: { source: 'silas-directive', sha: 'abc123' },
    });
    const handback = observeFollowUpDelivery({ ledger: h.ledger, notifications: h.notifications }, delivered);
    expect(handback).not.toBeNull();

    // The operator/Gru reads the card and shows it: the OBLIGATION is
    // untouched, and an ack cannot even clear MACHINE attention — an
    // action-required row requires a Gru disposition, never an erasure.
    const card = h.ledger.findNotificationByKind(handback!.notificationKind, 'unacked');
    expect(card).not.toBeNull();
    h.notifications.markShown(card!.id, 'board');
    expect(() => h.notifications.ack(card!.id, 'gru')).toThrow(/Gru disposition/u);
    // An owner-routed card may be acked by the owner — the CARD clears,
    // the obligation does NOT.
    const ownerCard = h.notifications.postIncident({
      kind: 'owner-hold.card.job-att',
      routing: 'needs-owner',
      severity: 'info',
      title: 'owner hold observed',
      dedupe: 'unacked',
    });
    expect(h.notifications.ack(ownerCard.id, 'owner')?.ackedAt).not.toBeNull();
    const stillOpen = h.ledger.getObligation(handback!.obligationId);
    expect(stillOpen?.state).toBe('open'); // unresolved work cannot be erased by an ack
    expect(stillOpen?.settlement).toBeNull();

    // Delegation: the obligation waits on a correlated receipt with a deadline.
    h.ledger.armReceiptExpectation({
      obligationId: handback!.obligationId,
      receiptKind: 'job.delivered',
      deadlineAt: '2026-09-28T12:00:00.000Z',
      correlation: { requestId: 'phase-req-1' },
      reason: 'next ruling phase delegated to the existing minion lane',
    });
    const waiting = h.ledger.getObligation(handback!.obligationId);
    expect(waiting?.state).toBe('waiting');
    // Deadline passes with no receipt: the boundary is flagged — actionable
    // again, not an endless passive row.
    const selection = selectDueObligations(
      h.ledger.listObligations({ jobId: 'job-att', limit: 10 }),
      '2026-09-28T13:00:00.000Z',
    );
    expect(selection.missedDeadlines.map((row) => row.id)).toContain(handback!.obligationId);
    // The correlated completion hands the decision back; an UNRELATED
    // delivery of the same kind cannot.
    const unrelated = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-att',
      payload: { source: 'silas-directive', request_id: 'some-other-phase' },
    });
    expect(
      h.ledger.recordObligationReceipt({
        obligationId: handback!.obligationId,
        kind: 'job.delivered',
        eventSeq: unrelated.seq,
      }).state,
    ).toBe('waiting');
    const correlated = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-att',
      payload: { source: 'silas-directive', request_id: 'phase-req-1' },
    });
    expect(
      h.ledger.recordObligationReceipt({
        obligationId: handback!.obligationId,
        kind: 'job.delivered',
        eventSeq: correlated.seq,
      }).state,
    ).toBe('open');
  });
});

describe('unmarked blocked-phase hand-back crash-window recovery (r4 blocker 2)', () => {
  it('recovers a delivery whose observer never ran, exactly once and without a worker turn', () => {
    const h = makeHarness();
    seedJob(h.ledger, 'job-uwc1', 'blocked');
    // The delivery committed; the process died before the bus observer ran.
    const delivered = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-uwc1',
      payload: { source: 'silas-directive', sha: 'abc123', agentId: 'minion-9' },
    });
    const report = reconcileUnmarkedHandbacks({ ledger: h.ledger, notifications: h.notifications });
    expect(report.recovered).toBe(1);
    expect(report.published).toBe(1);
    const obligation = h.ledger
      .listObligations({ jobId: 'job-uwc1' })
      .find((row) => row.incidentKey === `phase-handback@${delivered.seq}`);
    expect(obligation?.state).toBe('open');
    const kind = `silas.phase-handback.job-uwc1@${delivered.seq}`;
    const card = h.ledger.findNotificationByKind(kind, 'any');
    expect(card?.routing).toBe('action-required'); // machine wake — never the owner bell
    expect(card?.detail).toContain('abc123');
    // Recovery is not a worker turn: nothing was spawned and no dispatch
    // event was written — only the durable debt and the one card.
    expect(h.ledger.listAgents().filter((agent) => agent.jobId === 'job-uwc1')).toHaveLength(0);
    // Exactly once: a second pass changes nothing.
    const second = reconcileUnmarkedHandbacks({ ledger: h.ledger, notifications: h.notifications });
    expect(second.recovered).toBe(0);
    expect(second.published).toBe(0);
    expect(h.ledger.listNotifications({ limit: 200 }).filter((row) => row.kind === kind)).toHaveLength(1);
  });

  it('recovers the card when the crash landed between the obligation write and its notification', () => {
    const h = makeHarness();
    seedJob(h.ledger, 'job-uwc2', 'blocked');
    const delivered = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-uwc2',
      payload: { source: 'silas-rebrief', sha: 'def456' },
    });
    // Simulate the crash: the observer records the obligation, then the post
    // dies before the card commits.
    const crashing = {
      postIncident(): never {
        throw new Error('process died before the card committed');
      },
    };
    expect(() => observeFollowUpDelivery({ ledger: h.ledger, notifications: crashing }, delivered)).toThrow(/died/);
    // The hand-back debt survived; the card did not. (Other debt — e.g. the
    // initial blocked-transition obligation — may coexist on the lane.)
    expect(
      h.ledger.listObligations({ jobId: 'job-uwc2' }).filter((row) => row.incidentKey === `phase-handback@${delivered.seq}`),
    ).toHaveLength(1);
    const kind = `silas.phase-handback.job-uwc2@${delivered.seq}`;
    expect(h.ledger.findNotificationByKind(kind, 'any')).toBeNull(); // the card did not
    const report = reconcileUnmarkedHandbacks({ ledger: h.ledger, notifications: h.notifications });
    expect(report.recovered).toBe(0); // the obligation already existed — only the card was lost
    expect(report.published).toBe(1);
    const card = h.ledger.findNotificationByKind(kind, 'any');
    expect(card?.routing).toBe('action-required');
    expect(card?.detail).toContain('def456');
    const second = reconcileUnmarkedHandbacks({ ledger: h.ledger, notifications: h.notifications });
    expect(second.published).toBe(0);
    expect(h.ledger.listNotifications({ limit: 200 }).filter((row) => row.kind === kind)).toHaveLength(1);
  });

  it('leaves marked deliveries and unblocked lanes to their own owners', () => {
    const h = makeHarness();
    const worktrees = new InMemoryWorktreePort(join(tmpDir(), 'wt'));
    // A marked phase on a blocked lane: the phase path owns it; the unmarked
    // backstop must not double-publish the event-sequence card.
    seedJob(h.ledger, 'job-uwc3', 'blocked');
    h.ledger.beginPendingRebrief({
      jobId: 'job-uwc3',
      note: 'n',
      briefing: 'b',
      handoff: { kind: 'gru-decision', decision: 'marked' },
    });
    finalizeRebriefRequest({ ledger: h.ledger, worktrees, jobId: 'job-uwc3', minionId: 'm1', lanePath: null, note: 'n' });
    const markedPass = reconcileUnmarkedHandbacks({ ledger: h.ledger, notifications: h.notifications });
    expect(markedPass.deliveries).toBe(0);
    expect(markedPass.published).toBe(0);
    expect(
      h.ledger.listNotifications({ limit: 200 }).filter((row) => row.kind.startsWith('silas.phase-handback.')),
    ).toHaveLength(0);
    // The marked path still completes and publishes exactly ONE card.
    const delivery = h.ledger.latestJobEvent('job-uwc3', 'job.delivered');
    expect(delivery).not.toBeNull();
    expect(observePhaseCompletion({ ledger: h.ledger, notifications: h.notifications }, delivery!)?.created).toBe(true);
    expect(
      h.ledger.listNotifications({ limit: 200 }).filter((row) => row.kind.startsWith('silas.phase-handback.')),
    ).toHaveLength(1);
    // An unblocked lane is the normal review flow: nothing to recover.
    seedJob(h.ledger, 'job-uwc4', 'working');
    h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-uwc4',
      payload: { source: 'silas-directive', sha: 'x' },
    });
    const healthyPass = reconcileUnmarkedHandbacks({ ledger: h.ledger, notifications: h.notifications });
    expect(healthyPass.deliveries).toBe(0);
  });
});
