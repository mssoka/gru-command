import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import {
  ClaimHeldError,
  LedgerApi,
  RecordNotFound,
  StaleContinuationError,
} from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import {
  obligationRouting,
  selectDueObligations,
  type ObligationDueView,
} from '../src/ledger/obligations.js';

/**
 * Durable follow-through obligations — ledger foundation tests (phase 2).
 *
 * Deterministic by construction: a real LedgerDb on a temp directory, an
 * in-memory bus, explicit ISO timestamps, scripted reopens (restart), and
 * no clocks, sockets, providers or spawns anywhere. These tests were
 * authored WITH the foundation and are the red/green contract for the
 * next phase's first verification window (execution was out of scope in
 * the phase that wrote them, per its ruling).
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-ledger-obligations-'));
  cleanupDirs.push(dir);
  return dir;
}

function ownerHoldContext(seq: number) {
  return {
    logicalStep: 'operation' as const,
    category: { kind: 'known' as const, category: 'owner-hold' as const },
    incidentKey: 'quota-exhausted',
    observedAtSeq: seq,
    description: 'owner quota hold observed at the boundary',
  };
}

describe('obligations — blocked-transition boundary', () => {
  let api: LedgerApi;
  let dir: string;

  beforeAll(() => {
    dir = tmpDir();
    api = new LedgerApi(new LedgerDb(dir).handle, { bus: new EventBus() });
    api.addJob({ id: 'job-a', repo: 'r', title: 'Job A' });
    api.setJobStatus('job-a', 'working');
  });

  it('a blocked transition WITH a typed context records the obligation in the same transaction', () => {
    const job = api.setJobStatus('job-a', 'blocked', ownerHoldContext(10));
    expect(job.status).toBe('blocked');
    const obligations = api.listObligations({ jobId: 'job-a' });
    expect(obligations).toHaveLength(1);
    expect(obligations[0]?.id).toBe('job-a:operation:known:owner-hold');
    expect(obligations[0]?.category).toEqual({ kind: 'known', category: 'owner-hold' });
    // Owner holds route to the owner surface — never a machine turn.
    expect(obligations[0]?.nextAction.kind).toBe('owner-decision');
    expect(obligationRouting(obligations[0]!.nextAction)).toBe('needs-owner');
    expect(obligations[0]?.state).toBe('open');
    expect(obligations[0]?.observations).toBe(1);
  });

  it('a blocked transition WITHOUT context synthesizes a NON-EXECUTABLE unknown-triage obligation — the block is never rejected', () => {
    api.addJob({ id: 'job-b', repo: 'r', title: 'Job B' });
    api.setJobStatus('job-b', 'working');
    const job = api.setJobStatus('job-b', 'blocked'); // no context at all
    expect(job.status).toBe('blocked'); // the legitimate block landed
    const obligations = api.listObligations({ jobId: 'job-b' });
    expect(obligations).toHaveLength(1);
    expect(obligations[0]?.category).toEqual({ kind: 'unknown' });
    expect(obligations[0]?.nextAction.kind).toBe('gru-decision');
    expect(obligations[0]?.authority).toBeNull(); // never guessed into execution authority
    expect(obligationRouting(obligations[0]!.nextAction)).toBe('action-required');
  });

  it('rejects a blocker context on a non-blocked transition (fail loud, no silent drop)', () => {
    api.addJob({ id: 'job-c', repo: 'r', title: 'Job C' });
    expect(() => api.setJobStatus('job-c', 'parked', ownerHoldContext(3))).toThrow(
      /blocker context may only accompany a blocked transition/u,
    );
  });

  it('an invalid discriminated shape throws — a mechanical action without typed authority is refused', () => {
    expect(() =>
      api.setJobStatus('job-c', 'blocked', {
        logicalStep: 'implementation',
        category: { kind: 'known', category: 'lane-unavailable' },
        observedAtSeq: 4,
        nextAction: { kind: 'silas-mechanical', action: 'register-pr' }, // no authority
      }),
    ).toThrow(/requires typed authority/u);
  });
});

describe('obligations — duplicate observations vs distinct incidents', () => {
  let api: LedgerApi;

  beforeAll(() => {
    api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    api.addJob({ id: 'job-d', repo: 'r', title: 'Job D' });
    api.setJobStatus('job-d', 'working');
  });

  it('duplicate observations of the SAME incident coalesce: one row, stable id, NO generation advance', () => {
    api.setJobStatus('job-d', 'blocked', ownerHoldContext(10));
    api.recordBlockedObservation('job-d', ownerHoldContext(14)); // duplicate
    api.recordBlockedObservation('job-d', ownerHoldContext(17)); // duplicate
    const rows = api.listObligations({ jobId: 'job-d' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.observations).toBe(3);
    expect(rows[0]?.generation).toBe(1);
    expect(rows[0]?.lastOriginSeq).toBe(17);
    expect(rows[0]?.firstOriginSeq).toBe(10);
  });

  it('distinct simultaneous blockers COEXIST as separate obligations (owner stop + verification failure + review verdict)', () => {
    api.recordBlockedObservation('job-d', {
      logicalStep: 'verification',
      category: { kind: 'known', category: 'verification-failure' },
      incidentKey: 'npm-test-failed',
      observedAtSeq: 20,
    });
    api.recordBlockedObservation('job-d', {
      logicalStep: 'review',
      category: { kind: 'known', category: 'review-verdict' },
      incidentKey: 'perkins-r1',
      observedAtSeq: 21,
    });
    const rows = api.listObligations({ jobId: 'job-d' });
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.incidentKey).sort()).toEqual([
      'known:owner-hold',
      'npm-test-failed',
      'perkins-r1',
    ].sort());
    // Each new distinct incident advanced the job generation; duplicates never did.
    expect(rows.map((row) => row.generation).sort()).toEqual([1, 2, 3]);
    // The owner hold stays owner-routed; the machine decisions stay machine-routed.
    const routings = rows.map((row) => obligationRouting(row.nextAction));
    expect(routings).toContain('needs-owner');
    expect(routings.filter((route) => route === 'action-required')).toHaveLength(2);
  });

  it('a settled incident recurring mints a NEW incarnation (history preserved, never resurrected)', () => {
    const first = api.listObligations({ jobId: 'job-d' })[0]!;
    api.settleObligation({
      obligationId: first.id,
      settlement: { kind: 'cancelled', reason: 'owner cancelled the hold' },
    });
    api.recordBlockedObservation('job-d', ownerHoldContext(30)); // same incident again
    const rows = api.listObligations({ jobId: 'job-d' });
    expect(rows).toHaveLength(4);
    const oldRow = rows.find((row) => row.id === first.id);
    const newRow = rows.find((row) => row.id === `${first.id}#2`);
    expect(oldRow?.state).toBe('closed');
    expect(newRow?.state).toBe('open');
    expect(newRow?.generation).toBe(4);
  });
});

describe('obligations — receipts never settle; deadlines hand decisions back', () => {
  let api: LedgerApi;
  let obligationId: string;

  beforeAll(() => {
    api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    api.addJob({ id: 'job-e', repo: 'r', title: 'Job E' });
    api.setJobStatus('job-e', 'working');
    api.setJobStatus('job-e', 'blocked', {
      logicalStep: 'audit',
      category: { kind: 'known', category: 'verification-failure' },
      incidentKey: 'read-only-audit-phase',
      observedAtSeq: 5,
      dueAt: null,
      receiptKind: 'job.delivered',
      deadlineAt: '2026-09-28T12:00:00.000Z',
    });
    obligationId = api.listObligations({ jobId: 'job-e' })[0]?.id as string;
  });

  it('a waiting obligation with a generic job.delivered receipt REOPENS the decision — never settles it', () => {
    // Delegation armed: the phase owes a job.delivered receipt by a deadline.
    api.armReceiptExpectation({
      obligationId,
      receiptKind: 'job.delivered',
      deadlineAt: '2026-09-28T12:00:00.000Z',
      reason: 'read-only audit phase delegated to the existing minion lane',
    });
    expect(api.getObligation(obligationId)?.state).toBe('waiting');
    const afterReceipt = api.recordObligationReceipt({
      obligationId,
      kind: 'job.delivered',
      eventSeq: 9,
    });
    expect(afterReceipt.state).toBe('open'); // hand-back, not delivery/approval
    expect(afterReceipt.settlement).toBeNull(); // a receipt NEVER settles
  });

  it('receipt replay is idempotent; a stale receipt is evidence only (no state change)', () => {
    const before = api.getObligation(obligationId)!;
    const replay = api.recordObligationReceipt({ obligationId, kind: 'job.delivered', eventSeq: 9 });
    expect(replay.updatedAt).toBe(before.updatedAt); // duplicate (kind, seq) = no-op
    const stale = api.recordObligationReceipt({ obligationId, kind: 'job.delivered', eventSeq: 1 });
    expect(stale.recordedReceipts.some((receipt) => receipt.eventSeq === 1 && receipt.applied === false)).toBe(
      true,
    );
    expect(stale.state).toBe('open'); // stale evidence reopens nothing
  });

  it('settlement requires explicit validated evidence kinds (accepted gate), from the owning request', () => {
    const settled = api.settleObligation({
      obligationId,
      requestId: 'req-1',
      settlement: { kind: 'accepted-evidence', gate: 'chief-ruling-20260928', evidenceEventSeq: 12 },
    });
    expect(settled.state).toBe('settled');
    expect(settled.settlement).toEqual({
      kind: 'accepted-evidence',
      gate: 'chief-ruling-20260928',
      evidenceEventSeq: 12,
    });
    expect(() =>
      api.resumeObligation(obligationId, 'late second thought'),
    ).toThrow(/illegal transition/u); // terminal never resurrects
  });
});

describe('obligations — claims are fences, never writer licenses', () => {
  let api: LedgerApi;
  let obligationId: string;

  beforeAll(() => {
    api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    api.addJob({ id: 'job-f', repo: 'r', title: 'Job F' });
    api.setJobStatus('job-f', 'working');
    api.setJobStatus('job-f', 'blocked', {
      logicalStep: 'implementation',
      category: { kind: 'unknown' },
      observedAtSeq: 3,
    });
    obligationId = api.listObligations({ jobId: 'job-f' })[0]?.id as string;
  });

  it('a generation fence rejects a stale continuation loudly', () => {
    expect(() =>
      api.claimObligation({
        obligationId,
        requestId: 'req-old',
        holder: 'silas-ops',
        expiresAt: '2099-01-01T00:00:00.000Z',
        expectedGeneration: 99,
      }),
    ).toThrow(StaleContinuationError);
  });

  it('a live claim by another request is held — lease expiry ALONE still refuses, an expired one may be replaced (history kept)', () => {
    api.claimObligation({
      obligationId,
      requestId: 'req-1',
      holder: 'silas-ops',
      expiresAt: '2099-01-01T00:00:00.000Z',
      expectedGeneration: 1,
    });
    expect(() =>
      api.claimObligation({
        obligationId,
        requestId: 'req-2',
        holder: 'silas-ops',
        expiresAt: '2099-01-02T00:00:00.000Z',
        expectedGeneration: 1,
      }),
    ).toThrow(ClaimHeldError);
    // The lease expires (wall clock is explicit, deterministic).
    const expired = api.claimObligation({
      obligationId,
      requestId: 'req-2',
      holder: 'reconciler',
      expiresAt: '2099-01-03T00:00:00.000Z',
      expectedGeneration: 1,
    });
    expect(expired.claim?.requestId).toBe('req-2');
    expect(expired.claimHistory).toBe(1); // replacement recorded, never silent
  });

  it('release is owner-fenced; a foreign request cannot release', () => {
    expect(() => api.releaseClaim({ obligationId, requestId: 'req-1' })).toThrow(ClaimHeldError);
    expect(api.releaseClaim({ obligationId, requestId: 'req-2' }).claim).toBeNull();
  });
});

describe('obligations — park/terminal act only on APPLICABLE rows; history survives', () => {
  let api: LedgerApi;

  beforeAll(() => {
    api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    api.addJob({ id: 'job-g', repo: 'r', title: 'Job G' });
    api.setJobStatus('job-g', 'working');
    api.setJobStatus('job-g', 'blocked', ownerHoldContext(6));
    const settledRow = api.recordBlockedObservation('job-g', {
      logicalStep: 'review',
      category: { kind: 'known', category: 'review-verdict' },
      incidentKey: 'r1',
      observedAtSeq: 7,
    });
    api.settleObligation({
      obligationId: settledRow.id,
      settlement: { kind: 'executed-action', action: 'register-pr', evidenceEventSeq: 8 },
    });
  });

  it('parking suspends open/waiting obligations; settled rows and their history are untouched', () => {
    api.setJobStatus('job-g', 'parked');
    const rows = api.listObligations({ jobId: 'job-g' });
    const open = rows.find((row) => row.state === 'suspended');
    expect(open?.incidentKey).toBe('known:owner-hold');
    expect(rows.find((row) => row.state === 'settled')?.settlement?.kind).toBe('executed-action');
  });

  it('leaving parked does not silently resume — explicit resume only; terminal closes applicable rows with job-terminal settlement', () => {
    api.setJobStatus('job-g', 'blocked', ownerHoldContext(11)); // duplicate while parked-suspended: still suspended
    expect(api.listObligations({ jobId: 'job-g' }).find((row) => row.incidentKey === 'known:owner-hold')?.state).toBe(
      'suspended',
    );
    api.setJobStatus('job-g', 'working'); // resume the lane...
    expect(api.listObligations({ jobId: 'job-g' }).find((row) => row.incidentKey === 'known:owner-hold')?.state).toBe(
      'suspended', // ...but the obligation stays suspended until an explicit durable resume
    );
    api.resumeObligation('job-g:operation:known:owner-hold', 'chief resumed the hold decision');
    expect(api.getObligation('job-g:operation:known:owner-hold')?.state).toBe('open');
    api.setJobStatus('job-g', 'done');
    const rows = api.listObligations({ jobId: 'job-g' });
    expect(rows.every((row) => row.state === 'closed' || row.state === 'settled')).toBe(true);
    expect(
      rows.find((row) => row.incidentKey === 'known:owner-hold')?.settlement,
    ).toEqual({ kind: 'job-terminal', jobStatus: 'done' });
    expect(rows.find((row) => row.state === 'settled')?.settlement?.kind).toBe('executed-action'); // history kept
  });
});

describe('obligations — restart persistence and stale-continuation invalidation', () => {
  let dir: string;

  beforeAll(() => {
    dir = tmpDir();
  });

  it('claims, generations and receipts survive a reopen (restart); unknown applied versions still refuse (existing guard)', () => {
    const first = new LedgerApi(new LedgerDb(dir).handle, { bus: new EventBus() });
    first.addJob({ id: 'job-h', repo: 'r', title: 'Job H' });
    first.setJobStatus('job-h', 'working');
    first.setJobStatus('job-h', 'blocked', {
      logicalStep: 'verification',
      category: { kind: 'known', category: 'verification-failure' },
      incidentKey: 'ci-window',
      observedAtSeq: 2,
    });
    const obligationId = first.listObligations({ jobId: 'job-h' })[0]?.id as string;
    first.claimObligation({
      obligationId,
      requestId: 'req-restart',
      holder: 'silas-ops',
      expiresAt: '2099-01-01T00:00:00.000Z',
      expectedGeneration: 1,
    });
    // Reopen on the same file: the durable obligation state is all still there.
    const reopened = new LedgerApi(new LedgerDb(dir).handle, { bus: new EventBus() });
    const after = reopened.listObligations({ jobId: 'job-h' });
    expect(after).toHaveLength(1);
    expect(after[0]?.claim?.requestId).toBe('req-restart');
    expect(after[0]?.generation).toBe(1);
  });

  it('invalidateStaleContinuations closes ONLY applicable rows at/before the watermark, preserving the newer one', () => {
    const api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    api.addJob({ id: 'job-i', repo: 'r', title: 'Job I' });
    api.setJobStatus('job-i', 'working');
    api.setJobStatus('job-i', 'blocked', ownerHoldContext(4));
    api.recordBlockedObservation('job-i', {
      logicalStep: 'verification',
      category: { kind: 'known', category: 'quality-gate' },
      incidentKey: 'gate-later',
      observedAtSeq: 9,
    });
    const closed = api.invalidateStaleContinuations({
      jobId: 'job-i',
      newerThanSeq: 5,
      reason: 'head moved past the fenced continuation',
    });
    expect(closed).toHaveLength(1);
    expect(closed[0]?.incidentKey).toBe('known:owner-hold');
    expect(closed[0]?.settlement?.kind).toBe('superseded');
    const survivors = api.listObligations({ jobId: 'job-i' }).filter((row) => row.state === 'open');
    expect(survivors.map((row) => row.incidentKey)).toEqual(['gate-later']);
  });

  it('unknown obligations are refused loudly (RecordNotFound) — no silent no-ops', () => {
    const api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    expect(() =>
      api.recordBlockedObservation('no-such-job', ownerHoldContext(1)),
    ).toThrow(RecordNotFound);
  });
});

describe('obligations — pure due-selection / projection contract', () => {
  const views: readonly ObligationDueView[] = [
    {
      id: 'a',
      state: 'open',
      nextAction: { kind: 'gru-decision', decision: 'rule' },
      dueAt: null,
      deadlineAt: null,
    },
    {
      id: 'b',
      state: 'open',
      nextAction: { kind: 'owner-decision', decision: 'release hold' },
      dueAt: '2030-01-01T00:00:00.000Z',
      deadlineAt: null,
    },
    {
      id: 'c',
      state: 'waiting',
      nextAction: { kind: 'gru-decision', decision: 'await receipt' },
      dueAt: null,
      deadlineAt: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'd',
      state: 'settled',
      nextAction: { kind: 'gru-decision', decision: 'done' },
      dueAt: null,
      deadlineAt: null,
    },
  ];

  it('selects due open rows, flags missed deadlines (a signal, never a writer license), ignores terminal rows', () => {
    const selection = selectDueObligations(views, '2026-06-01T00:00:00.000Z');
    expect(selection.due.map((row) => row.id)).toEqual(['a']); // b is not due yet
    expect(selection.missedDeadlines.map((row) => row.id)).toEqual(['c']);
    const later = selectDueObligations(views, '2031-01-01T00:00:00.000Z');
    expect(later.due.map((row) => row.id).sort()).toEqual(['a', 'b']);
  });
});
