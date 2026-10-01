import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { parseCompletionHandoffIntent } from '../src/ledger/obligations.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { observeFollowUpDelivery, observePhaseCompletion, reconcilePhaseHandoffs } from '../src/dispatch/obligations.js';
import { finalizeRebriefRequest } from '../src/dispatch/rebrief-recovery.js';
import { DispatchService } from '../src/dispatch/service.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import type { AgentCapabilities, AgentHandle } from '../src/runtime/types.js';

/**
 * Explicit phase-completion handoffs (pr136-chief-handoff). Deterministic:
 * a real LedgerDb on a temp dir, an in-memory bus, explicit event
 * watermarks, no clocks/sockets/providers. Covers the fresh artifact-only
 * dispatch, the same-head re-brief on blocked AND nonblocked lanes, the
 * admission gates, the crash-window reconciliation, the terminal/parked
 * guards and the disposition-is-not-settlement rule.
 */

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
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-phase-handoffs-'));
  cleanupDirs.push(dir);
  return dir;
}

function makeHarness(): { db: LedgerDb; bus: EventBus; ledger: LedgerApi; notifications: NotificationCenter } {
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

function fakeMinion(id: string, prompt: () => Promise<void>): AgentHandle {
  return {
    role: 'minion',
    id,
    sessionFile: null,
    capabilities: FAKE_CAPABILITIES,
    prompt,
    async steer() {},
    async followUp() {},
    subscribe() {
      return () => {};
    },
    health() {
      return { state: 'idle', lastActivity: null, sessionFile: null };
    },
    async dispose() {},
  };
}

function payloadOf(event: { payload: unknown }): Record<string, unknown> {
  return (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
}

describe('explicit phase-completion handoff (fresh dispatch and same-head rebrief)', () => {
  it('a marked fresh artifact phase completes working→delivered with no PR and hands back exactly once', async () => {
    const h = makeHarness();
    const repoPath = tmpDir();
    const worktrees = new InMemoryWorktreePort(join(tmpDir(), 'wt'));
    const service = new DispatchService({
      ledger: h.ledger,
      worktrees,
      spawner: async () => fakeMinion('minion-ph-service', async () => {}),
    });
    h.bus.subscribe((event) => {
      observePhaseCompletion({ ledger: h.ledger, notifications: h.notifications }, event);
    });
    const outcome = await service.dispatch({
      jobId: 'job-ph-svc',
      repoPath,
      title: 'bounded audit',
      briefing: 'audit only; no commit expected',
      completionHandoff: { kind: 'gru-decision', decision: 'rule on the completed audit follow-through' },
    });
    expect((await outcome.settled).ok).toBe(true);
    expect(h.ledger.getJob('job-ph-svc')?.status).toBe('delivered'); // settle point, no PR
    const phases = h.ledger.listPhaseHandoffs({ jobId: 'job-ph-svc' });
    expect(phases).toHaveLength(1);
    expect(phases[0]?.state).toBe('completed');
    const obligation = h.ledger.getObligation(phases[0]!.obligationId!);
    expect(obligation).toMatchObject({
      jobId: 'job-ph-svc',
      incidentKey: `phase-handoff@${phases[0]!.phaseId}`,
      state: 'open',
      category: { kind: 'known', category: 'phase-completion' },
    });
    expect(obligation?.nextAction).toEqual({
      kind: 'gru-decision',
      decision: 'rule on the completed audit follow-through',
    });
    expect(obligation?.authority).toBeNull(); // completion is evidence, never authority
    const card = h.ledger.findNotificationByKind(`silas.phase-handback.${phases[0]!.phaseId}`, 'unacked');
    expect(card).not.toBeNull();
    expect(card?.routing).toBe('action-required'); // machine wake, never the owner bell
    // A boot replay changes nothing: one obligation, one card.
    const replay = reconcilePhaseHandoffs({ ledger: h.ledger, notifications: h.notifications });
    expect(replay.published).toBe(0);
    expect(
      h.ledger.listNotifications({ limit: 200 }).filter((row) => row.kind === `silas.phase-handback.${phases[0]!.phaseId}`),
    ).toHaveLength(1);
  });

  it('unmarked deliveries never hand back; the legacy blocked-only observer keeps its behavior', () => {
    const h = makeHarness();
    seedJob(h.ledger, 'job-ph-neg', 'working');
    const plain = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-ph-neg',
      payload: { source: 'dispatch', agentId: 'minion-x', sha: 'abc' },
    });
    expect(observePhaseCompletion({ ledger: h.ledger, notifications: h.notifications }, plain)).toBeNull();
    expect(observeFollowUpDelivery({ ledger: h.ledger, notifications: h.notifications }, plain)).toBeNull();
    expect(h.ledger.listObligations({ jobId: 'job-ph-neg' })).toHaveLength(0);
    expect(h.ledger.listNotifications({ limit: 200 })).toHaveLength(0);

    seedJob(h.ledger, 'job-ph-neg2', 'blocked');
    const legacy = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-ph-neg2',
      payload: { source: 'silas-directive', sha: 'def' },
    });
    expect(observePhaseCompletion({ ledger: h.ledger, notifications: h.notifications }, legacy)).toBeNull();
    expect(observeFollowUpDelivery({ ledger: h.ledger, notifications: h.notifications }, legacy)?.created).toBe(true);
  });

  it('a marked re-brief hands back on blocked AND nonblocked lanes without double publication', () => {
    const h = makeHarness();
    const worktrees = new InMemoryWorktreePort(join(tmpDir(), 'wt'));
    // Blocked lane: the legacy observer would fire for an unmarked delivery;
    // the marked delivery belongs to the phase path alone.
    seedJob(h.ledger, 'job-ph-rb1', 'blocked');
    const markers = h.ledger.beginPendingRebrief({
      jobId: 'job-ph-rb1',
      note: 'same head; finish the audit',
      briefing: 'b',
      handoff: { kind: 'gru-decision', decision: 'rule on the re-briefed audit' },
    });
    const phaseId = markers.find((marker) => marker.phaseId !== null)?.phaseId ?? null;
    expect(phaseId).not.toBeNull();
    expect(h.ledger.getPhaseHandoff(phaseId!)?.state).toBe('awaiting');
    finalizeRebriefRequest({
      ledger: h.ledger,
      worktrees,
      jobId: 'job-ph-rb1',
      minionId: 'minion-rb1',
      lanePath: null,
      note: 'same head; finish the audit',
    });
    const rebriefEvent = h.ledger.latestJobEvent('job-ph-rb1', 'silas.rebrief');
    expect(payloadOf(rebriefEvent!)['phase_id']).toBe(phaseId);
    const delivery = h.ledger.latestJobEvent('job-ph-rb1', 'job.delivered');
    expect(payloadOf(delivery!)['phase_id']).toBe(phaseId);
    const result = observePhaseCompletion({ ledger: h.ledger, notifications: h.notifications }, delivery!);
    expect(result?.created).toBe(true);
    expect(observeFollowUpDelivery({ ledger: h.ledger, notifications: h.notifications }, delivery!)).toBeNull();
    expect(
      h.ledger.listNotifications({ limit: 200 }).filter((row) => row.kind.includes('phase-handback')),
    ).toHaveLength(1);

    // Nonblocked lane: same-head completion still hands back.
    seedJob(h.ledger, 'job-ph-rb2', 'working');
    h.ledger.beginPendingRebrief({
      jobId: 'job-ph-rb2',
      note: 'finish it',
      briefing: 'b',
      handoff: { kind: 'gru-decision', decision: 'rule on the nonblocked lane' },
    });
    finalizeRebriefRequest({
      ledger: h.ledger,
      worktrees,
      jobId: 'job-ph-rb2',
      minionId: 'minion-rb2',
      lanePath: null,
      note: 'finish it',
    });
    const delivery2 = h.ledger.latestJobEvent('job-ph-rb2', 'job.delivered');
    expect(observePhaseCompletion({ ledger: h.ledger, notifications: h.notifications }, delivery2!)?.created).toBe(true);
    expect(h.ledger.getJob('job-ph-rb2')?.status).toBe('working'); // not blocked, still handed back
  });

  it('a marked directive completes only after its request is admitted; boot reconciliation closes the gap', () => {
    const h = makeHarness();
    seedJob(h.ledger, 'job-ph-dir', 'working');
    h.ledger.beginDirectiveIntent({
      jobId: 'job-ph-dir',
      directive: 'fix the blocker',
      holder: 'silas-ops',
      requestId: 'req-ph-dir',
      handoff: { kind: 'gru-decision', decision: 'rule on the fix phase' },
    });
    const phase = h.ledger.getPhaseHandoff('phase-handoff:job-ph-dir:silas-directive:1');
    expect(phase?.state).toBe('awaiting');
    const delivery = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-ph-dir',
      payload: { source: 'silas-directive', request_id: 'req-ph-dir', phase_id: phase!.phaseId, agentId: 'minion-d', sha: 'head' },
    });
    // Dispatching (no admission evidence yet): delivery alone completes nothing.
    expect(observePhaseCompletion({ ledger: h.ledger, notifications: h.notifications }, delivery)).toBeNull();
    expect(h.ledger.getPhaseHandoff(phase!.phaseId)?.state).toBe('awaiting');
    // The correlated native admission lands, then the boot backstop
    // completes the phase from the already-committed delivery.
    const sent = h.ledger.appendCustomEvent({
      kind: 'silas.directive-sent',
      jobId: 'job-ph-dir',
      payload: { request_id: 'req-ph-dir', minion_id: 'minion-d' },
    });
    h.ledger.recordDirectiveAdmission({ requestId: 'req-ph-dir', minionId: 'minion-d', eventSeq: sent.seq });
    const report = reconcilePhaseHandoffs({ ledger: h.ledger, notifications: h.notifications });
    expect(report.completed).toBe(1);
    expect(report.published).toBe(1);
    expect(h.ledger.getPhaseHandoff(phase!.phaseId)?.state).toBe('completed');
    expect(
      h.ledger.findNotificationByKind(`silas.phase-handback.${phase!.phaseId}`, 'unacked')?.routing,
    ).toBe('action-required');
  });

  it('failed attempts never masquerade as completion: the dispatch failure closes the phase; a failed directive stays closed', async () => {
    const h = makeHarness();
    const worktrees = new InMemoryWorktreePort(join(tmpDir(), 'wt'));
    const service = new DispatchService({
      ledger: h.ledger,
      worktrees,
      spawner: async () =>
        fakeMinion('minion-ph-fail', async () => {
          throw new Error('the turn exploded');
        }),
    });
    h.bus.subscribe((event) => {
      observePhaseCompletion({ ledger: h.ledger, notifications: h.notifications }, event);
    });
    const outcome = await service.dispatch({
      jobId: 'job-ph-fail',
      repoPath: tmpDir(),
      title: 'failing phase',
      briefing: 'b',
      completionHandoff: { kind: 'gru-decision', decision: 'never owed' },
    });
    expect((await outcome.settled).ok).toBe(false);
    const failed = h.ledger.listPhaseHandoffs({ jobId: 'job-ph-fail' })[0];
    expect(failed?.state).toBe('closed');
    expect(failed?.completionSeq).toBeNull();
    expect(
      h.ledger.listNotifications({ limit: 200 }).filter((row) => row.kind.includes('phase-handback')),
    ).toHaveLength(0);

    seedJob(h.ledger, 'job-ph-dfail', 'working');
    h.ledger.beginDirectiveIntent({
      jobId: 'job-ph-dfail',
      directive: 'd',
      holder: 'silas-ops',
      requestId: 'req-ph-dfail',
      handoff: { kind: 'gru-decision', decision: 'never owed either' },
    });
    const phase2 = h.ledger.listPhaseHandoffs({ jobId: 'job-ph-dfail' })[0];
    h.ledger.failDirective({ requestId: 'req-ph-dfail', reason: 'positive no-effect proof' });
    h.ledger.closePhaseHandoff({ phaseId: phase2!.phaseId, reason: 'directive request failed' });
    const late = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-ph-dfail',
      payload: { source: 'silas-directive', request_id: 'req-ph-dfail', phase_id: phase2!.phaseId },
    });
    expect(observePhaseCompletion({ ledger: h.ledger, notifications: h.notifications }, late)).toBeNull();
    expect(h.ledger.getPhaseHandoff(phase2!.phaseId)?.state).toBe('closed');
    expect(
      h.ledger.listNotifications({ limit: 200 }).filter((row) => row.kind.includes('phase-handback')),
    ).toHaveLength(0);
  });
});

describe('phase-handoff reconciliation, guards and disposition', () => {
  it('crash windows reconcile to exactly one hand-back: delivery-before-observer and completion-before-publication', () => {
    const h = makeHarness();
    // (a) The delivery committed (crash before the observer ran).
    seedJob(h.ledger, 'job-ph-c1', 'working');
    h.ledger.beginPhaseHandoff({
      jobId: 'job-ph-c1',
      source: 'dispatch',
      intent: { kind: 'gru-decision', decision: 'd1' },
    });
    const p1 = h.ledger.listPhaseHandoffs({ jobId: 'job-ph-c1' })[0]!;
    h.ledger.bindPhaseHandoffMinion({ phaseId: p1.phaseId, minionId: 'm1' });
    h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-ph-c1',
      payload: { source: 'dispatch', agentId: 'm1', phase_id: p1.phaseId },
    });
    const first = reconcilePhaseHandoffs({ ledger: h.ledger, notifications: h.notifications });
    expect(first.completed).toBe(1);
    expect(first.published).toBe(1);
    // A duplicate delivery and a second pass change nothing.
    h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-ph-c1',
      payload: { source: 'dispatch', agentId: 'm1', phase_id: p1.phaseId },
    });
    const second = reconcilePhaseHandoffs({ ledger: h.ledger, notifications: h.notifications });
    expect(second.completed).toBe(0);
    expect(second.published).toBe(0);
    expect(
      h.ledger.listObligations({ jobId: 'job-ph-c1' }).filter((row) => row.incidentKey.startsWith('phase-handoff@')),
    ).toHaveLength(1);
    expect(
      h.ledger.listNotifications({ limit: 200 }).filter((row) => row.kind === `silas.phase-handback.${p1.phaseId}`),
    ).toHaveLength(1);

    // (b) The completion was recorded (crash before the obligation and/or the card).
    seedJob(h.ledger, 'job-ph-c2', 'working');
    h.ledger.beginPhaseHandoff({
      jobId: 'job-ph-c2',
      source: 'dispatch',
      intent: { kind: 'gru-decision', decision: 'd2' },
    });
    const p2 = h.ledger.listPhaseHandoffs({ jobId: 'job-ph-c2' })[0]!;
    h.ledger.bindPhaseHandoffMinion({ phaseId: p2.phaseId, minionId: 'm2' });
    const d2 = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-ph-c2',
      payload: { source: 'dispatch', agentId: 'm2', phase_id: p2.phaseId },
    });
    h.ledger.completePhaseHandoff({ phaseId: p2.phaseId, completionSeq: d2.seq });
    const third = reconcilePhaseHandoffs({ ledger: h.ledger, notifications: h.notifications });
    expect(third.published).toBe(1);
    const finished = h.ledger.getPhaseHandoff(p2.phaseId)!;
    expect(finished.obligationId).not.toBeNull();
    expect(finished.notificationId).not.toBeNull();
    const fourth = reconcilePhaseHandoffs({ ledger: h.ledger, notifications: h.notifications });
    expect(fourth.published).toBe(0);
  });

  it('a newer request is never completed by an older receipt; a superseded phase stays closed', () => {
    const h = makeHarness();
    const worktrees = new InMemoryWorktreePort(join(tmpDir(), 'wt'));
    seedJob(h.ledger, 'job-ph-sup', 'blocked');
    const first = h.ledger.beginPendingRebrief({
      jobId: 'job-ph-sup',
      note: 'one',
      briefing: 'b',
      handoff: { kind: 'gru-decision', decision: 'first' },
    });
    const firstPhaseId = first.find((marker) => marker.phaseId !== null)?.phaseId ?? null;
    const second = h.ledger.beginPendingRebrief({
      jobId: 'job-ph-sup',
      note: 'two',
      briefing: 'b',
      handoff: { kind: 'gru-decision', decision: 'second' },
    });
    const secondPhaseId = second.find((marker) => marker.phaseId !== null)?.phaseId ?? null;
    expect(firstPhaseId).not.toBeNull();
    expect(secondPhaseId).not.toBe(firstPhaseId);
    expect(h.ledger.getPhaseHandoff(firstPhaseId!)?.state).toBe('closed'); // superseded
    expect(h.ledger.getPhaseHandoff(secondPhaseId!)?.state).toBe('awaiting');
    // The OLD turn's finalize must not record against the newer markers.
    const staleFinalize = finalizeRebriefRequest({
      ledger: h.ledger,
      worktrees,
      jobId: 'job-ph-sup',
      minionId: 'minion-old',
      lanePath: null,
      note: 'one',
      expectedPhaseId: firstPhaseId,
    });
    expect(staleFinalize.superseded).toBe(true);
    expect(staleFinalize.rebriefRecorded).toBe(false);
    expect(h.ledger.listPendingRebriefs({ jobId: 'job-ph-sup' })).toHaveLength(2); // newer markers intact
    // A late receipt for the superseded phase cannot revive or complete it.
    const late = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-ph-sup',
      payload: { source: 'silas-rebrief', phase_id: firstPhaseId },
    });
    expect(observePhaseCompletion({ ledger: h.ledger, notifications: h.notifications }, late)).toBeNull();
    expect(h.ledger.getPhaseHandoff(firstPhaseId!)?.state).toBe('closed');
    expect(h.ledger.getPhaseHandoff(secondPhaseId!)?.state).toBe('awaiting');
    // The newer request's own turn finalizes normally and completes ITS phase.
    const currentFinalize = finalizeRebriefRequest({
      ledger: h.ledger,
      worktrees,
      jobId: 'job-ph-sup',
      minionId: 'minion-new',
      lanePath: null,
      note: 'two',
      expectedPhaseId: secondPhaseId,
    });
    expect(currentFinalize.superseded).toBe(false);
    expect(currentFinalize.deliveryRecorded).toBe(true);
    expect(h.ledger.listPendingRebriefs({ jobId: 'job-ph-sup' })).toHaveLength(0);
    const delivery = h.ledger.latestJobEvent('job-ph-sup', 'job.delivered');
    const completed = observePhaseCompletion({ ledger: h.ledger, notifications: h.notifications }, delivery!);
    expect(completed?.created).toBe(true);
    expect(completed?.phaseId).toBe(secondPhaseId);
    expect(
      h.ledger.listNotifications({ limit: 200 }).filter((row) => row.kind.includes('phase-handback')),
    ).toHaveLength(1);
  });

  it('terminal and parked jobs receive no card; the owner hold is untouched', () => {
    const h = makeHarness();
    // Terminal: the debt is recorded and immediately closed as job-terminal.
    seedJob(h.ledger, 'job-ph-term', 'working');
    h.ledger.beginPhaseHandoff({
      jobId: 'job-ph-term',
      source: 'dispatch',
      intent: { kind: 'gru-decision', decision: 't' },
    });
    const pt = h.ledger.listPhaseHandoffs({ jobId: 'job-ph-term' })[0]!;
    h.ledger.bindPhaseHandoffMinion({ phaseId: pt.phaseId, minionId: 'mt' });
    h.ledger.setJobStatus('job-ph-term', 'done');
    const dt = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-ph-term',
      payload: { source: 'dispatch', agentId: 'mt', phase_id: pt.phaseId },
    });
    const res = observePhaseCompletion({ ledger: h.ledger, notifications: h.notifications }, dt);
    expect(res).not.toBeNull();
    expect(res?.notificationId).toBeNull();
    expect(h.ledger.getPhaseHandoff(pt.phaseId)?.state).toBe('closed');
    expect(h.ledger.getObligation(res!.obligationId!)?.state).toBe('closed'); // job-terminal settlement

    // Parked + owner hold: the debt suspends, no wake, no auto-ACK.
    seedJob(h.ledger, 'job-ph-park', 'working');
    const ownerCard = h.notifications.post({
      kind: 'gru.owner-escalation',
      routing: 'needs-owner',
      severity: 'error',
      title: 'owner stop',
      detail: 'owner-controlled',
    });
    h.ledger.beginPhaseHandoff({
      jobId: 'job-ph-park',
      source: 'dispatch',
      intent: { kind: 'gru-decision', decision: 'p' },
    });
    const pp = h.ledger.listPhaseHandoffs({ jobId: 'job-ph-park' })[0]!;
    h.ledger.bindPhaseHandoffMinion({ phaseId: pp.phaseId, minionId: 'mp' });
    h.ledger.setJobStatus('job-ph-park', 'parked');
    const dp = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-ph-park',
      payload: { source: 'dispatch', agentId: 'mp', phase_id: pp.phaseId },
    });
    const res2 = observePhaseCompletion({ ledger: h.ledger, notifications: h.notifications }, dp);
    expect(res2?.notificationId).toBeNull();
    expect(h.ledger.getObligation(res2!.obligationId!)?.state).toBe('suspended');
    expect(h.ledger.getPhaseHandoff(pp.phaseId)?.state).toBe('closed');
    expect(
      h.ledger.listNotifications({ limit: 200 }).filter((row) => row.kind.includes('phase-handback')),
    ).toHaveLength(0);
    const ownerRow = h.ledger.listNotifications({ routing: 'needs-owner', unackedOnly: true, limit: 200 }).find(
      (row) => row.id === ownerCard.id,
    );
    expect(ownerRow?.ackedAt).toBeNull(); // no fabricated owner ACK
  });

  it('disposition is not settlement: shown/ack leaves the debt owed; accepted evidence settles it', () => {
    const h = makeHarness();
    seedJob(h.ledger, 'job-ph-disp', 'working');
    h.ledger.beginPhaseHandoff({
      jobId: 'job-ph-disp',
      source: 'dispatch',
      intent: { kind: 'gru-decision', decision: 'rule' },
    });
    const phase = h.ledger.listPhaseHandoffs({ jobId: 'job-ph-disp' })[0]!;
    h.ledger.bindPhaseHandoffMinion({ phaseId: phase.phaseId, minionId: 'md' });
    const delivery = h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-ph-disp',
      payload: { source: 'dispatch', agentId: 'md', phase_id: phase.phaseId },
    });
    const result = observePhaseCompletion({ ledger: h.ledger, notifications: h.notifications }, delivery);
    expect(result?.created).toBe(true);
    const card = h.ledger.findNotificationByKind(`silas.phase-handback.${phase.phaseId}`, 'unacked');
    expect(card).not.toBeNull();
    h.notifications.markShown(card!.id, 'board');
    expect(() => h.notifications.ack(card!.id, 'gru')).toThrow(/Gru disposition/);
    expect(h.ledger.getObligation(result!.obligationId!)?.state).toBe('open'); // the card is not the debt
    const evidence = h.ledger.appendCustomEvent({
      kind: 'ruling.recorded',
      jobId: 'job-ph-disp',
      payload: { ref: 'ph-ruling', version: '1' },
    });
    h.ledger.settleObligation({
      obligationId: result!.obligationId!,
      settlement: {
        kind: 'accepted-evidence',
        gate: 'gru-ruling',
        evidenceEventSeq: evidence.seq,
        evidenceEventKind: 'ruling.recorded',
      },
    });
    expect(h.ledger.getObligation(result!.obligationId!)?.state).toBe('settled');
  });

  it('intent validation and request-id replay are enforced at the boundary', () => {
    expect(() => parseCompletionHandoffIntent(null)).toThrow(/completion_handoff/u);
    expect(() => parseCompletionHandoffIntent('gru-decision')).toThrow(/completion_handoff/u);
    expect(() => parseCompletionHandoffIntent({ kind: 'owner-decision', decision: 'd' })).toThrow(/gru-decision/u);
    expect(() => parseCompletionHandoffIntent({ kind: 'gru-decision', decision: '   ' })).toThrow(/decision/u);
    expect(parseCompletionHandoffIntent({ kind: 'gru-decision', decision: '  trim me  ' })).toEqual({
      kind: 'gru-decision',
      decision: 'trim me',
    });
    const h = makeHarness();
    seedJob(h.ledger, 'job-ph-val', 'working');
    const first = h.ledger.beginPhaseHandoff({
      jobId: 'job-ph-val',
      source: 'dispatch',
      requestId: 'req-ph-val',
      intent: { kind: 'gru-decision', decision: 'same' },
    });
    const replay = h.ledger.beginPhaseHandoff({
      jobId: 'job-ph-val',
      source: 'dispatch',
      requestId: 'req-ph-val',
      intent: { kind: 'gru-decision', decision: 'same' },
    });
    expect(replay.created).toBe(false);
    expect(replay.record.phaseId).toBe(first.record.phaseId);
    expect(() =>
      h.ledger.beginPhaseHandoff({
        jobId: 'job-ph-val',
        source: 'dispatch',
        requestId: 'req-ph-val',
        intent: { kind: 'gru-decision', decision: 'changed' },
      }),
    ).toThrow(/different decision/u);
    expect(() =>
      h.ledger.completePhaseHandoff({ phaseId: first.record.phaseId, completionSeq: first.record.intentSeq }),
    ).toThrow(/watermark/u);
    expect(() => h.ledger.listPhaseHandoffs({ states: [] })).toThrow(/must not be empty/u);
    expect(() => h.ledger.closePhaseHandoff({ phaseId: first.record.phaseId, reason: ' ' })).toThrow(/reason/u);
  });

  it('boot reconciliation pages past a processed prefix without starving later phases', () => {
    const h = makeHarness();
    seedJob(h.ledger, 'job-ph-page', 'working');
    h.ledger.beginPhaseHandoff({
      jobId: 'job-ph-page',
      source: 'dispatch',
      intent: { kind: 'gru-decision', decision: 'a' },
    });
    const a = h.ledger.listPhaseHandoffs({ jobId: 'job-ph-page' })[0]!;
    h.ledger.bindPhaseHandoffMinion({ phaseId: a.phaseId, minionId: 'ma' });
    h.ledger.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-ph-page',
      payload: { source: 'dispatch', agentId: 'ma', phase_id: a.phaseId },
    });
    h.ledger.beginPhaseHandoff({
      jobId: 'job-ph-page',
      source: 'dispatch',
      intent: { kind: 'gru-decision', decision: 'b' },
    });
    const report = reconcilePhaseHandoffs({ ledger: h.ledger, notifications: h.notifications }, { pageSize: 1 });
    expect(report.examined).toBe(2);
    expect(report.completed).toBe(1);
    expect(h.ledger.getPhaseHandoff(a.phaseId)?.state).toBe('completed');
    const b = h.ledger.listPhaseHandoffs({ jobId: 'job-ph-page', states: ['awaiting'] });
    expect(b).toHaveLength(1);
    expect(b[0]?.decision).toBe('b');
  });
});
