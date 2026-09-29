import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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
 * Durable follow-through obligations — ledger foundation tests (repaired
 * under the phase-3 chief ruling, 2026-09-28).
 *
 * Deterministic by construction: a real LedgerDb on a temp directory, an
 * in-memory bus, explicit event watermarks read back from REAL appended
 * events (receipts and settlements validate against actual ledger facts —
 * fabricated sequence numbers are refused by design), scripted reopens
 * (restart), and no clocks, sockets, providers or spawns anywhere.
 *
 * The repairs covered here (A–E):
 * - A: receipts/settlements correlate to real events (existence, kind,
 *   job, phase correlation); evidence never settles from typed JSON alone.
 * - B: stale continuations reclassify onto a LINKED successor — debt is
 *   never silently erased.
 * - C: the ACTIVE incarnation is found (no duplicate #n minting); stale
 *   replays never reopen settled incidents or regress watermarks; a
 *   changed plan bumps plan_revision and fences claims.
 * - D: claim replacement across an expired lease requires positive
 *   reconciliation proof; full prior-claim identity in the claim log.
 * - E: authority is validated against ledger facts; firing rule/category
 *   compatibility; bounded listings with malformed rows visible.
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

  it('a blocked transition WITH a typed context records the obligation in the same transaction', () => {
    api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    api.addJob({ id: 'job-a', repo: 'r', title: 'Job A' });
    api.setJobStatus('job-a', 'working');
    const seq = api.latestEventSeq();
    const job = api.setJobStatus('job-a', 'blocked', ownerHoldContext(seq));
    expect(job.status).toBe('blocked');
    const obligations = api.listObligations({ jobId: 'job-a' });
    expect(obligations).toHaveLength(1);
    expect(obligations[0]?.id).toBe('job-a:operation:quota-exhausted');
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

  it('an explicit firing rule must MATCH the observed category (repair E)', () => {
    expect(() =>
      api.setJobStatus('job-c', 'blocked', {
        logicalStep: 'implementation',
        category: { kind: 'known', category: 'lane-unavailable' },
        observedAtSeq: 5,
        firingRule: 'owner-hold-needs-owner', // registered for owner-hold
      }),
    ).toThrow(/registered for category/u);
  });
});

describe('obligations — duplicate observations vs distinct incidents (repair C)', () => {
  let api: LedgerApi;

  it('duplicate observations of the SAME incident coalesce: one row, stable id, NO generation advance', () => {
    api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    api.addJob({ id: 'job-d', repo: 'r', title: 'Job D' });
    api.setJobStatus('job-d', 'working');
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
      'npm-test-failed',
      'perkins-r1',
      'quota-exhausted',
    ].sort());
    // Each new distinct incident advanced the job generation; duplicates never did.
    expect(rows.map((row) => row.generation).sort()).toEqual([1, 2, 3]);
    // The owner hold stays owner-routed; the machine decisions stay machine-routed.
    const routings = rows.map((row) => obligationRouting(row.nextAction));
    expect(routings).toContain('needs-owner');
    expect(routings.filter((route) => route === 'action-required')).toHaveLength(2);
  });

  it('a settled incident recurring mints a NEW incarnation; a duplicate observation coalesces into the ACTIVE one (never a #3)', () => {
    const first = api.listObligations({ jobId: 'job-d' }).find((row) => row.incidentKey === 'quota-exhausted')!;
    api.settleObligation({
      obligationId: first.id,
      settlement: { kind: 'cancelled', reason: 'owner cancelled the hold' },
    });
    api.recordBlockedObservation('job-d', ownerHoldContext(30)); // same incident again → #2
    const rows = api.listObligations({ jobId: 'job-d' });
    expect(rows).toHaveLength(4);
    const oldRow = rows.find((row) => row.id === first.id);
    const newRow = rows.find((row) => row.id === `${first.id}#2`);
    expect(oldRow?.state).toBe('closed');
    expect(newRow?.state).toBe('open');
    expect(newRow?.generation).toBe(4);
    // REPAIR C: the ACTIVE incarnation is the lookup target — a fresh
    // observation of the same incident coalesces into #2 instead of
    // minting a duplicate #3.
    api.recordBlockedObservation('job-d', ownerHoldContext(34));
    const after = api.listObligations({ jobId: 'job-d' });
    expect(after).toHaveLength(4);
    expect(after.find((row) => row.id === `${first.id}#2`)?.observations).toBe(2);
    expect(after.find((row) => row.id === `${first.id}#3`)).toBeUndefined();
  });

  it('a STALE replay never reopens settled history or regresses the watermark', () => {
    const row = api.listObligations({ jobId: 'job-d' }).find((item) => item.id === 'job-d:operation:quota-exhausted#2')!;
    const beforeObservations = row.observations;
    // An old observation (at/below the tuple watermark) replays: evidence only.
    api.recordBlockedObservation('job-d', ownerHoldContext(31));
    const after = api.listObligations({ jobId: 'job-d' }).find((item) => item.id === row.id)!;
    expect(after.observations).toBe(beforeObservations);
    expect(after.lastOriginSeq).toBe(34);
    expect(api.latestJobEvent('job-d', 'job.obligation-stale-observation')).not.toBeNull();
  });

  it('a CHANGED plan bumps plan_revision and FENCES the claim taken under the old plan', () => {
    const row = api.listObligations({ jobId: 'job-d' }).find((item) => item.id === 'job-d:operation:quota-exhausted#2')!;
    api.claimObligation({
      obligationId: row.id,
      requestId: 'req-plan-old',
      holder: 'silas-ops',
      expiresAt: '2099-01-01T00:00:00.000Z',
      expectedGeneration: row.generation,
    });
    // An UNCHANGED duplicate does not bump the revision.
    api.recordBlockedObservation('job-d', ownerHoldContext(35));
    expect(api.getObligation(row.id)?.planRevision).toBe(0);
    expect(api.getObligation(row.id)?.claim?.requestId).toBe('req-plan-old');
    // A CHANGED plan (new next decision) bumps the revision and fences the claim.
    api.recordBlockedObservation('job-d', {
      ...ownerHoldContext(36),
      nextAction: { kind: 'owner-decision', decision: 'owner hold: superseded by a fresh ruling' },
    });
    const fenced = api.getObligation(row.id)!;
    expect(fenced.planRevision).toBe(1);
    expect(fenced.claim).toBeNull();
    expect(fenced.claimLog.at(-1)).toMatchObject({
      requestId: 'req-plan-old',
      disposition: 'plan-revision',
    });
  });
});

describe('obligations — receipts correlate to REAL events; they never settle (repair A)', () => {
  let api: LedgerApi;
  let obligationId: string;

  it('a waiting obligation reopens on a CORRELATED job.delivered and stays unsettled; mismatches/scares are refused or unapplied', () => {
    api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    api.addJob({ id: 'job-e', repo: 'r', title: 'Job E' });
    api.addJob({ id: 'job-other', repo: 'r', title: 'Job other' });
    api.setJobStatus('job-e', 'working');
    // A stale delivered event, appended BEFORE the obligation exists: it can
    // never satisfy a later expectation (its seq sits below the watermark).
    const staleDelivered = api.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-e',
      payload: { source: 'silas-directive', request_id: 'req-e' },
    });
    api.setJobStatus('job-e', 'blocked', {
      logicalStep: 'audit',
      category: { kind: 'known', category: 'verification-failure' },
      incidentKey: 'read-only-audit-phase',
      observedAtSeq: staleDelivered.seq,
    });
    obligationId = api.listObligations({ jobId: 'job-e' })[0]?.id as string;
    api.armReceiptExpectation({
      obligationId,
      receiptKind: 'job.delivered',
      deadlineAt: '2026-09-28T12:00:00.000Z',
      correlation: { requestId: 'req-e' },
      reason: 'read-only audit phase delegated to the existing minion lane',
    });
    expect(api.getObligation(obligationId)?.state).toBe('waiting');

    // A fabricated sequence is refused outright.
    expect(() => api.recordObligationReceipt({ obligationId, kind: 'job.delivered', eventSeq: 999_999 })).toThrow(
      /does not exist/u,
    );
    // A wrong-kind citation is refused outright.
    const note = api.appendCustomEvent({ kind: 'job.note', jobId: 'job-e', payload: { note: 'x' } });
    expect(() => api.recordObligationReceipt({ obligationId, kind: 'job.delivered', eventSeq: note.seq })).toThrow(
      /is "job.note"/u,
    );
    // A wrong-job event is refused outright.
    const otherDelivered = api.appendCustomEvent({ kind: 'job.delivered', jobId: 'job-other', payload: {} });
    expect(() =>
      api.recordObligationReceipt({ obligationId, kind: 'job.delivered', eventSeq: otherDelivered.seq }),
    ).toThrow(/wrong-job/u);

    // A later UNRELATED delivery (same kind, no correlation) is recorded as
    // evidence only — it does NOT satisfy this phase's expectation.
    const unrelated = api.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-e',
      payload: { source: 'silas-directive', request_id: 'some-other-request' },
    });
    const unrelatedRecorded = api.recordObligationReceipt({
      obligationId,
      kind: 'job.delivered',
      eventSeq: unrelated.seq,
    });
    expect(unrelatedRecorded.state).toBe('waiting'); // still owed
    expect(unrelatedRecorded.recordedReceipts.at(-1)).toMatchObject({ eventSeq: unrelated.seq, applied: false });

    // The CORRELATED delivery reopens the decision — hand-back, not delivery/approval.
    const correlated = api.appendCustomEvent({
      kind: 'job.delivered',
      jobId: 'job-e',
      payload: { source: 'silas-directive', request_id: 'req-e' },
    });
    const handedBack = api.recordObligationReceipt({
      obligationId,
      kind: 'job.delivered',
      eventSeq: correlated.seq,
    });
    expect(handedBack.state).toBe('open');
    expect(handedBack.settlement).toBeNull();

    // Receipt replay is idempotent; the stale event stays unapplied evidence.
    const replay = api.recordObligationReceipt({ obligationId, kind: 'job.delivered', eventSeq: correlated.seq });
    expect(replay.updatedAt).toBe(handedBack.updatedAt);
    const stale = api.recordObligationReceipt({ obligationId, kind: 'job.delivered', eventSeq: staleDelivered.seq });
    expect(stale.recordedReceipts.find((receipt) => receipt.eventSeq === staleDelivered.seq)?.applied).toBe(false);
    expect(stale.state).toBe('open');
  });

  it('settlement evidence must cite a REAL event on the right job and kind — typed JSON alone settles nothing (repair A)', () => {
    // Fabricated sequence refused.
    expect(() =>
      api.settleObligation({
        obligationId,
        requestId: 'req-settle',
        settlement: { kind: 'accepted-evidence', gate: 'perkins-ready', evidenceEventSeq: 424_242, evidenceEventKind: 'ruling.recorded' },
      }),
    ).toThrow(/does not exist/u);
    // Wrong job refused.
    const otherEvent = api.appendCustomEvent({ kind: 'ruling.recorded', jobId: 'job-other', payload: { ref: 'r1', version: 'v1' } });
    expect(() =>
      api.settleObligation({
        obligationId,
        requestId: 'req-settle',
        settlement: { kind: 'accepted-evidence', gate: 'perkins-ready', evidenceEventSeq: otherEvent.seq, evidenceEventKind: 'ruling.recorded' },
      }),
    ).toThrow(/refused/u);
    // Wrong kind refused.
    const wrongKind = api.appendCustomEvent({ kind: 'job.note', jobId: 'job-e', payload: {} });
    expect(() =>
      api.settleObligation({
        obligationId,
        requestId: 'req-settle',
        settlement: { kind: 'accepted-evidence', gate: 'perkins-ready', evidenceEventSeq: wrongKind.seq, evidenceEventKind: 'ruling.recorded' },
      }),
    ).toThrow(/refused/u);
    // A real, right-kind, right-job event settles with the gate named.
    const settledEventsBefore = api.countEvents('job.obligation-settled');
    const realEvidence = api.appendCustomEvent({ kind: 'ruling.recorded', jobId: 'job-e', payload: { ref: 'chief-1', version: 'v1' } });
    const settled = api.settleObligation({
      obligationId,
      requestId: 'req-settle',
      settlement: { kind: 'accepted-evidence', gate: 'perkins-ready', evidenceEventSeq: realEvidence.seq, evidenceEventKind: 'ruling.recorded' },
    });
    expect(settled.state).toBe('settled');
    expect(api.countEvents('job.obligation-settled')).toBe(settledEventsBefore + 1);
    // Terminal never resurrects.
    expect(() => api.resumeObligation(obligationId, 'late second thought')).toThrow(/illegal transition/u);
  });

  it('a FAILED settlement is atomic: no partial state, no settlement event', () => {
    api.addJob({ id: 'job-s2', repo: 'r', title: 'Job S2' });
    api.setJobStatus('job-s2', 'working');
    api.setJobStatus('job-s2', 'blocked', {
      logicalStep: 'operation',
      category: { kind: 'unknown' },
      observedAtSeq: api.latestEventSeq(),
    });
    const id = api.listObligations({ jobId: 'job-s2' })[0]!.id;
    const eventsBefore = api.countEvents('job.obligation-settled');
    expect(() =>
      api.settleObligation({
        obligationId: id,
        settlement: { kind: 'executed-action', action: 'register-pr', evidenceEventSeq: 888_888, evidenceEventKind: 'silas.directive-sent' },
      }),
    ).toThrow(/does not exist/u);
    expect(api.getObligation(id)?.state).toBe('open');
    expect(api.getObligation(id)?.settlement).toBeNull();
    expect(api.countEvents('job.obligation-settled')).toBe(eventsBefore);
  });
});

describe('obligations — claims are fences; expiry alone transfers nothing (repair D)', () => {
  let api: LedgerApi;
  let obligationId: string;

  it('a generation fence rejects a stale continuation loudly', () => {
    api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    api.addJob({ id: 'job-f', repo: 'r', title: 'Job F' });
    api.setJobStatus('job-f', 'working');
    api.setJobStatus('job-f', 'blocked', {
      logicalStep: 'implementation',
      category: { kind: 'unknown' },
      observedAtSeq: api.latestEventSeq(),
    });
    obligationId = api.listObligations({ jobId: 'job-f' })[0]?.id as string;
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

  it('a live claim is held; an EXPIRED claim still refuses replacement without positive reconciliation proof', () => {
    api.claimObligation({
      obligationId,
      requestId: 'req-1',
      holder: 'silas-ops',
      expiresAt: '2000-01-01T00:00:00.000Z', // long expired
      expectedGeneration: 1,
    });
    // Expiry alone is not a replacement license.
    expect(() =>
      api.claimObligation({
        obligationId,
        requestId: 'req-2',
        holder: 'reconciler',
        expiresAt: '2099-01-02T00:00:00.000Z',
        expectedGeneration: 1,
      }),
    ).toThrow(/expiry alone/u);
    // With recorded reconciliation proof the replacement lands, preserving
    // the FULL prior claim identity — never a bare counter.
    const replaced = api.claimObligation({
      obligationId,
      requestId: 'req-2',
      holder: 'reconciler',
      expiresAt: '2099-01-03T00:00:00.000Z',
      expectedGeneration: 1,
      supersedeProof: 'checked: no live handle, session closed, no in-flight turn on the old request',
    });
    expect(replaced.claim?.requestId).toBe('req-2');
    expect(replaced.claimLog).toEqual([
      {
        requestId: 'req-1',
        holder: 'silas-ops',
        generation: 1,
        expiresAt: '2000-01-01T00:00:00.000Z',
        disposition: 'superseded-expired-reconciled',
        at: expect.any(String),
        proof: 'checked: no live handle, session closed, no in-flight turn on the old request',
        supersededByRequest: 'req-2',
      },
    ]);
  });

  it('the same request id cannot change holder; release is owner-fenced and logged', () => {
    expect(() =>
      api.claimObligation({
        obligationId,
        requestId: 'req-2',
        holder: 'impostor',
        expiresAt: '2099-01-04T00:00:00.000Z',
        expectedGeneration: 1,
      }),
    ).toThrow(/cannot change holder/u);
    expect(() => api.releaseClaim({ obligationId, requestId: 'req-1' })).toThrow(ClaimHeldError);
    const released = api.releaseClaim({ obligationId, requestId: 'req-2' });
    expect(released.claim).toBeNull();
    expect(released.claimLog.at(-1)).toMatchObject({ requestId: 'req-2', disposition: 'released' });
  });

  it('a mechanical obligation stripped of its authority cannot be claimed — a claim never mints a writer license', () => {
    const dir = tmpDir();
    const db = new LedgerDb(dir);
    const raw = new LedgerApi(db.handle, { bus: new EventBus() });
    raw.addJob({ id: 'job-mech', repo: 'r', title: 'Job mech' });
    raw.setJobStatus('job-mech', 'working');
    raw.setJobStatus('job-mech', 'blocked', {
      logicalStep: 'review',
      category: { kind: 'known', category: 'review-verdict' },
      incidentKey: 'mech-1',
      observedAtSeq: raw.latestEventSeq(),
      nextAction: { kind: 'silas-mechanical', action: 'request-review' },
      authority: { source: 'chief-ruling', rulingRef: 'r1', version: 'v1' },
    });
    const id = raw.listObligations({ jobId: 'job-mech' })[0]!.id;
    // Simulate the authority being invalidated away (stale continuation).
    db.handle.prepare('UPDATE job_obligations SET authority = NULL WHERE id = ?').run(id);
    expect(() =>
      raw.claimObligation({
        obligationId: id,
        requestId: 'req-mech',
        holder: 'silas-ops',
        expiresAt: '2099-01-01T00:00:00.000Z',
        expectedGeneration: 1,
      }),
    ).toThrow(/attention-only/u);
  });

  it('claim timestamps are canonicalized at the boundary (repair D)', () => {
    expect(() =>
      api.claimObligation({
        obligationId,
        requestId: 'req-bad-time',
        holder: 'silas-ops',
        expiresAt: 'not-a-time',
        expectedGeneration: 1,
      }),
    ).toThrow(/ISO timestamp/u);
  });
});

describe('obligations — park/terminal act only on APPLICABLE rows; history survives', () => {
  let api: LedgerApi;

  it('parking suspends; terminal closes with job-terminal; settled history is kept', () => {
    api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    api.addJob({ id: 'job-g', repo: 'r', title: 'Job G' });
    api.setJobStatus('job-g', 'working');
    api.setJobStatus('job-g', 'blocked', ownerHoldContext(api.latestEventSeq()));
    const settledRow = api.recordBlockedObservation('job-g', {
      logicalStep: 'review',
      category: { kind: 'known', category: 'review-verdict' },
      incidentKey: 'r1',
      observedAtSeq: api.latestEventSeq(),
    });
    const evidence = api.appendCustomEvent({ kind: 'silas.directive-sent', jobId: 'job-g', payload: { request_id: 'x', minion_id: 'm1' } });
    api.settleObligation({
      obligationId: settledRow.id,
      settlement: { kind: 'executed-action', action: 'request-review', evidenceEventSeq: evidence.seq, evidenceEventKind: 'silas.directive-sent' },
    });

    api.setJobStatus('job-g', 'parked');
    const rows = api.listObligations({ jobId: 'job-g' });
    expect(rows.find((row) => row.incidentKey === 'quota-exhausted')?.state).toBe('suspended');
    expect(rows.find((row) => row.state === 'settled')?.settlement?.kind).toBe('executed-action');

    // A duplicate observation while parked-suspended does not silently resume.
    api.setJobStatus('job-g', 'blocked', ownerHoldContext(api.latestEventSeq()));
    expect(api.listObligations({ jobId: 'job-g' }).find((row) => row.incidentKey === 'quota-exhausted')?.state).toBe(
      'suspended',
    );
    api.setJobStatus('job-g', 'working');
    expect(api.listObligations({ jobId: 'job-g' }).find((row) => row.incidentKey === 'quota-exhausted')?.state).toBe(
      'suspended', // explicit durable resume only
    );
    api.resumeObligation('job-g:operation:quota-exhausted', 'chief resumed the hold decision');
    expect(api.getObligation('job-g:operation:quota-exhausted')?.state).toBe('open');
    api.setJobStatus('job-g', 'done');
    const finalRows = api.listObligations({ jobId: 'job-g' });
    expect(finalRows.every((row) => row.state === 'closed' || row.state === 'settled')).toBe(true);
    expect(finalRows.find((row) => row.incidentKey === 'quota-exhausted')?.settlement).toEqual({
      kind: 'job-terminal',
      jobStatus: 'done',
    });
    expect(finalRows.find((row) => row.state === 'settled')?.settlement?.kind).toBe('executed-action');
  });
});

describe('obligations — restart persistence, reclassification, authority validation', () => {
  it('claims, generations and receipts survive a reopen (restart)', () => {
    const dir = tmpDir();
    const first = new LedgerApi(new LedgerDb(dir).handle, { bus: new EventBus() });
    first.addJob({ id: 'job-h', repo: 'r', title: 'Job H' });
    first.setJobStatus('job-h', 'working');
    first.setJobStatus('job-h', 'blocked', {
      logicalStep: 'verification',
      category: { kind: 'known', category: 'verification-failure' },
      incidentKey: 'ci-window',
      observedAtSeq: first.latestEventSeq(),
    });
    const obligationId = first.listObligations({ jobId: 'job-h' })[0]?.id as string;
    first.claimObligation({
      obligationId,
      requestId: 'req-restart',
      holder: 'silas-ops',
      expiresAt: '2099-01-01T00:00:00.000Z',
      expectedGeneration: 1,
    });
    const reopened = new LedgerApi(new LedgerDb(dir).handle, { bus: new EventBus() });
    const after = reopened.listObligations({ jobId: 'job-h' });
    expect(after).toHaveLength(1);
    expect(after[0]?.claim?.requestId).toBe('req-restart');
    expect(after[0]?.generation).toBe(1);
  });

  it('invalidateStaleContinuations RECLASSIFIES onto a linked successor — debt never silently erased (repair B)', () => {
    const api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    api.addJob({ id: 'job-i', repo: 'r', title: 'Job I' });
    api.setJobStatus('job-i', 'working');
    api.setJobStatus('job-i', 'blocked', {
      ...ownerHoldContext(4),
      nextAction: { kind: 'owner-decision', decision: 'owner hold: resolve or release the hold' },
      authority: { source: 'chief-ruling', rulingRef: 'old-ruling', version: 'v1' },
    });
    api.recordBlockedObservation('job-i', {
      logicalStep: 'verification',
      category: { kind: 'known', category: 'quality-gate' },
      incidentKey: 'gate-later',
      observedAtSeq: 9,
    });
    const result = api.invalidateStaleContinuations({
      jobId: 'job-i',
      newerThanSeq: 5,
      reason: 'head moved past the fenced continuation',
    });
    expect(result.superseded).toHaveLength(1);
    const oldRow = result.superseded[0]!;
    const successor = result.successors[0]!;
    expect(oldRow.incidentKey).toBe('quota-exhausted');
    expect(oldRow.state).toBe('closed');
    expect(oldRow.settlement).toMatchObject({ kind: 'superseded', byObligationId: successor.id });
    expect(oldRow.supersededBy).toBe(successor.id);
    // The debt continues: same incident, fresh generation, attention-only,
    // authority STRIPPED, no carried claim.
    expect(successor.state).toBe('open');
    expect(successor.incidentKey).toBe('quota-exhausted');
    expect(successor.generation).toBe(3);
    expect(successor.authority).toBeNull();
    expect(successor.nextAction.kind).toBe('gru-decision');
    // Rows newer than the watermark are untouched.
    const later = api.listObligations({ jobId: 'job-i' }).find((row) => row.incidentKey === 'gate-later');
    expect(later?.state).toBe('open');
  });

  it('authority is validated against LEDGER FACTS — an unverifiable reference is non-executable (repair E)', () => {
    const api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    api.addJob({ id: 'job-j', repo: 'r', title: 'Job J' });
    api.setJobStatus('job-j', 'working');
    api.setJobStatus('job-j', 'blocked', {
      logicalStep: 'review',
      category: { kind: 'known', category: 'review-verdict' },
      incidentKey: 'auth-1',
      observedAtSeq: api.latestEventSeq(),
      nextAction: { kind: 'silas-mechanical', action: 'request-review' },
      authority: { source: 'chief-ruling', rulingRef: 'chief-1', version: 'v1' },
    });
    const id = api.listObligations({ jobId: 'job-j' })[0]!.id;
    // No ruling.recorded event exists yet: NOT executable (visible decision).
    expect(api.verifyObligationAuthority(id)).toMatchObject({ executable: false });
    // A wrong-version record does not validate.
    api.appendCustomEvent({ kind: 'ruling.recorded', jobId: 'job-j', payload: { ref: 'chief-1', version: 'v2' } });
    expect(api.verifyObligationAuthority(id).executable).toBe(false);
    // The matching ref+version IS current authority.
    api.appendCustomEvent({ kind: 'ruling.recorded', jobId: 'job-j', payload: { ref: 'chief-1', version: 'v1' } });
    expect(api.verifyObligationAuthority(id)).toMatchObject({ executable: true });
    // No authority at all: attention-only.
    api.recordBlockedObservation('job-j', {
      logicalStep: 'operation',
      category: { kind: 'unknown' },
      incidentKey: 'plain',
      observedAtSeq: api.latestEventSeq(),
    });
    const plain = api.listObligations({ jobId: 'job-j' }).find((row) => row.incidentKey === 'plain')!;
    expect(api.verifyObligationAuthority(plain.id)).toMatchObject({ executable: false });
  });

  it('an accepted-operation authority is valid only when its directive request is durably admitted (repair E)', () => {
    const api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    api.addJob({ id: 'job-k', repo: 'r', title: 'Job K' });
    api.setJobStatus('job-k', 'working');
    api.setJobStatus('job-k', 'blocked', {
      logicalStep: 'implementation',
      category: { kind: 'known', category: 'quality-gate' },
      incidentKey: 'op-auth',
      observedAtSeq: api.latestEventSeq(),
      nextAction: { kind: 'silas-mechanical', action: 'register-pr' },
      authority: { source: 'accepted-operation', operationId: 'req-op-1', version: 'v1' },
    });
    const id = api.listObligations({ jobId: 'job-k' })[0]!.id;
    expect(api.verifyObligationAuthority(id)).toMatchObject({ executable: false }); // no such request
    api.beginDirectiveIntent({ jobId: 'job-k', directive: 'fix it', holder: 'silas-ops', requestId: 'req-op-1' });
    expect(api.verifyObligationAuthority(id)).toMatchObject({ executable: false }); // accepted, not yet admitted
    const sent = api.appendCustomEvent({
      kind: 'silas.directive-sent',
      jobId: 'job-k',
      payload: { request_id: 'req-op-1', minion_id: 'minion-7' },
    });
    api.recordDirectiveAdmission({ requestId: 'req-op-1', minionId: 'minion-7', eventSeq: sent.seq });
    expect(api.verifyObligationAuthority(id)).toMatchObject({ executable: true });
  });

  it('listings are bounded with cursors, and a malformed row stays VISIBLE without poisoning the queue (repair E)', () => {
    const dir = tmpDir();
    const db = new LedgerDb(dir);
    const api = new LedgerApi(db.handle, { bus: new EventBus() });
    api.addJob({ id: 'job-l', repo: 'r', title: 'Job L' });
    api.setJobStatus('job-l', 'working');
    for (const [step, key] of [
      ['operation', 'one'],
      ['review', 'two'],
      ['verification', 'three'],
    ] as const) {
      api.recordBlockedObservation('job-l', {
        logicalStep: step,
        category: { kind: 'unknown' },
        incidentKey: key,
        observedAtSeq: api.latestEventSeq(),
      });
    }
    const page1 = api.listObligations({ jobId: 'job-l', limit: 2 });
    expect(page1).toHaveLength(2);
    const cursor = api.obligationRowid(page1[1]!.id) as number;
    const page2 = api.listObligations({ jobId: 'job-l', limit: 2, cursor });
    expect(page2).toHaveLength(1);
    // A row the parser cannot read surfaces as a triage problem, never as a
    // silent disappearance or a whole-queue failure.
    db.handle
      .prepare(
        `INSERT INTO job_obligations
           (id, job_id, logical_step, incident_key, generation, category, next_action, wake_condition,
            firing_rule, state, recorded_receipts, observations, first_origin_seq, last_origin_seq, created_at, updated_at)
         VALUES ('job-l:operation:corrupt', 'job-l', 'operation', 'corrupt', 9, '{not-json', '{}', '{}', 'unknown-triage-gru', 'open', '[]', 1, 1, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run();
    const detailed = api.listObligationsDetailed({ jobId: 'job-l', limit: 100 });
    expect(detailed.readable.map((row) => row.id)).not.toContain('job-l:operation:corrupt');
    expect(detailed.malformed).toHaveLength(1);
    expect(detailed.malformed[0]?.id).toBe('job-l:operation:corrupt');
    expect(detailed.malformed[0]?.error.length).toBeGreaterThan(0);
    expect(() => api.listObligations({ jobId: 'job-l', limit: 100 })).toThrow();
  });

  it('unknown obligations are refused loudly (RecordNotFound) — no silent no-ops', () => {
    const api = new LedgerApi(new LedgerDb(tmpDir()).handle, { bus: new EventBus() });
    expect(() => api.recordBlockedObservation('no-such-job', ownerHoldContext(1))).toThrow(RecordNotFound);
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
