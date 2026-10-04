import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { BoardEngine } from '../src/board/engine.js';
import type { DeployDriftView } from '../src/board/deploy-drift.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function fresh(engineOptions: Partial<ConstructorParameters<typeof BoardEngine>[0]> = {}): {
  api: LedgerApi;
  engine: BoardEngine;
} {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-board-v4-'));
  cleanupDirs.push(dir);
  const db = new LedgerDb(dir);
  const bus = new EventBus();
  const api = new LedgerApi(db.handle, { bus });
  return { api, engine: new BoardEngine({ ledger: api, bus, ...engineOptions }) };
}

describe('board engine — v4 snapshot blocks', () => {
  it('ships null build/verify/selfHeal and an empty-but-real Silas view when unwired', () => {
    const { engine } = fresh({ now: () => Date.parse('2026-09-23T12:00:00.000Z') });
    const snapshot = engine.snapshot();
    expect(snapshot.build).toBeNull();
    expect(snapshot.verify).toBeNull();
    expect(snapshot.selfHeal).toBeNull();
    expect(snapshot.silas).toEqual({
      lastWakeAt: null,
      lastTickAt: null,
      lastReconcileAt: null,
      lastReconcileFailedAt: null,
      reconcileFailedNewer: false,
      lastUsefulActionAt: null,
      nextAction: null,
      openTurnSince: null,
      reconciliationsToday: 0,
      checkedAt: '2026-09-23T12:00:00.000Z',
    });
  });

  it('carries injected deploy-drift / verify-queue / self-heal views verbatim', () => {
    const drift: DeployDriftView = {
      buildRev: 'a'.repeat(40),
      buildCommittedAt: '2026-09-20T10:00:00.000Z',
      originMainRev: 'b'.repeat(40),
      originMainCommittedAt: '2026-09-22T08:00:00.000Z',
      commitsBehind: 43,
      checkedAt: '2026-09-23T12:00:00.000Z',
      checkError: null,
    };
    const { engine } = fresh({
      buildDrift: () => drift,
      verifyQueue: () => ({ lockInUse: true, activeRuns: 1, queuedRuns: 2, workerBudget: 8, workersPerRun: 4 }),
      selfHeal: () => ({ sessionsResumed: 3, sessionsOrphaned: 1, since: '2026-09-23T09:00:00.000Z' }),
    });
    const snapshot = engine.snapshot();
    expect(snapshot.build).toEqual(drift);
    expect(snapshot.verify).toEqual({ lockInUse: true, activeRuns: 1, queuedRuns: 2, workerBudget: 8, workersPerRun: 4 });
    expect(snapshot.selfHeal).toEqual({ sessionsResumed: 3, sessionsOrphaned: 1, since: '2026-09-23T09:00:00.000Z' });
  });

  it('derives Silas health from the durable event stream: last wake + state corrections today', () => {
    const realNow = Date.now();
    const { api, engine } = fresh({ now: () => realNow });
    api.appendCustomEvent({ kind: 'silas.pr-registered', payload: { url: 'https://example.invalid/pr/1' } });
    api.appendCustomEvent({ kind: 'silas.wake', payload: { trigger: 'sweep', actionable: 2 } });
    api.appendCustomEvent({ kind: 'silas.rebrief', payload: {} });
    api.appendCustomEvent({ kind: 'some.other.kind', payload: {} });
    const view = engine.snapshot().silas;
    expect(view.lastWakeAt).not.toBeNull();
    expect(view.reconciliationsToday).toBe(2); // pr-registered + rebrief; the wake itself is not a reconciliation
    expect(view.checkedAt).toBe(new Date(realNow).toISOString());

    // An engine whose clock is two days ahead sees zero "today" events —
    // the day boundary is real, not a rolling total.
    const { engine: later } = fresh({ now: () => realNow + 48 * 60 * 60 * 1_000 });
    // Reuse the same ledger? fresh() mints one; assert on an empty ledger
    // instead: no events ⇒ null wake + zero count.
    expect(later.snapshot().silas).toMatchObject({ lastWakeAt: null, reconciliationsToday: 0 });

    // Same ledger, clock forwarded: today's window excludes yesterday's events.
    const forwarded = new BoardEngine({
      ledger: api,
      bus: new EventBus(),
      now: () => realNow + 48 * 60 * 60 * 1_000,
    });
    expect(forwarded.snapshot().silas.reconciliationsToday).toBe(0);
    expect(forwarded.snapshot().silas.lastWakeAt).not.toBeNull(); // the record outlives the day
  });

  it('separates tick/reconcile health by outcome and reports an open turn from supervision (#163)', () => {
    const stamp = '2026-09-23T12:00:00.000Z';
    const { api, engine } = fresh({
      now: () => Date.parse(stamp),
      // A live silas record with an open turn is the only source of
      // openTurnSince; the wake marker supplies the start timestamp.
      supervisionFor: (agentId) =>
        agentId === 'silas-live'
          ? {
              agentId,
              role: 'silas',
              slotId: 'silas-ops',
              state: 'watching',
              restarts: 0,
              breakerOpen: false,
              stopReason: null,
              openTurn: true,
              openControl: false,
              openToolCalls: 0,
              lastEventAt: stamp,
              lastFileBytes: 1,
            }
          : null,
    });
    api.registerAgent({ id: 'silas-live', role: 'silas' });
    api.setAgentState('silas-live', 'streaming');
    const wake = api.appendCustomEvent({ kind: 'silas.wake', payload: { trigger: 'sweep', actionable: 1 } });
    const tick = api.appendCustomEvent({ kind: 'silas.tick', payload: { trigger: 'sweep', wake_in_flight: true } });
    api.appendCustomEvent({ kind: 'silas.reconcile-failed', payload: { trigger: 'sweep', ok: false, error: 'oh no' } });
    const action = api.appendCustomEvent({ kind: 'silas.escalated', jobId: null, payload: {} });
    const down = engine.snapshot().silas;
    expect(down.lastTickAt).toBe(tick.ts);
    expect(down.lastReconcileAt).toBeNull(); // a failed pass is never a completed reconciliation
    expect(down.lastReconcileFailedAt).not.toBeNull();
    expect(down.reconcileFailedNewer).toBe(true); // a newer failure outranks the old success
    expect(down.lastUsefulActionAt).toBe(action.ts);
    expect(down.openTurnSince).toBe(wake.ts);

    api.appendCustomEvent({ kind: 'silas.reconcile', payload: { trigger: 'sweep', ok: true, counts: {} } });
    const recovered = engine.snapshot().silas;
    expect(recovered.lastReconcileAt).not.toBeNull();
    expect(recovered.lastReconcileFailedAt).not.toBeNull(); // history stays honest
    expect(recovered.reconcileFailedNewer).toBe(false); // the newest pass is the success
  });

  it('derives PR state from the record: none → open → merged (conflicting awaits its sweep)', () => {
    const { api, engine } = fresh();
    const job = api.addJob({ id: 'pr-state-job', repo: 'demo-repo', title: 'PR state' });
    api.setJobStatus(job.id, 'working');
    expect(engine.snapshot().repos.flatMap((r) => r.jobs).find((j) => j.id === job.id)?.prState).toBeNull();

    api.setJobPr(job.id, 'https://example.invalid/pr/7');
    api.setJobStatus(job.id, 'in-review');
    expect(engine.snapshot().repos.flatMap((r) => r.jobs).find((j) => j.id === job.id)?.prState).toBe('open');

    api.setJobStatus(job.id, 'merged');
    expect(engine.snapshot().repos.flatMap((r) => r.jobs).find((j) => j.id === job.id)?.prState).toBe('merged');
  });
  it('attributes only Silas-issued actions and projects the durable next action (#163 review)', () => {
    const { api, engine } = fresh({ now: () => Date.now() });
    const job = api.addJob({ id: 'job-next', repo: 'demo', title: 't', briefing: 'b' });
    api.setJobStatus(job.id, 'working');
    // An unrelated obligation write is machine debt, never a Silas action.
    api.recordBlockedObservation(job.id, {
      logicalStep: 'operation',
      category: { kind: 'unknown' },
      observedAtSeq: api.latestEventSeq(),
    });
    const machine = engine.snapshot().silas;
    expect(machine.lastUsefulActionAt).toBeNull();
    expect(machine.reconciliationsToday).toBe(0);
    expect(machine.nextAction).toContain('gru-decision');
    expect(machine.nextAction).toContain(job.id);

    // A Silas-issued machine action advances both the timestamp and today's
    // count.
    const settled = api.appendCustomEvent({ kind: 'silas.directive-settled', jobId: job.id, payload: {} });
    const silas = engine.snapshot().silas;
    expect(silas.lastUsefulActionAt).toBe(settled.ts);
    expect(silas.reconciliationsToday).toBe(1);
  });
});
