import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SILAS_CONFIG } from '../src/config.js';
import { laneIsBusy } from '../src/dispatch/branch-idle.js';
import { computeSilasDigest, digestActionCount, SilasDriver, type SilasOpsDigest } from '../src/dispatch/silas-driver.js';
import { LedgerApi, type DecisionRecord, type EventRecord } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import type { AgentHandle } from '../src/runtime/types.js';

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);
const NOW = Date.parse('2030-01-01T00:00:00.000Z');
const closers: Array<() => void> = [];
const databases = new WeakMap<LedgerApi, LedgerDb>();
afterEach(() => {
  while (closers.length > 0) closers.pop()!();
});

function fixture(): LedgerApi {
  const root = mkdtempSync(join(tmpdir(), 'gru-silas-verification-debt-'));
  const db = new LedgerDb(root);
  closers.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const ledger = new LedgerApi(db.handle);
  databases.set(ledger, db);
  return ledger;
}

function correctiveDelivery(ledger: LedgerApi, jobId = 'corrective-job'): void {
  ledger.addJob({ id: jobId, repo: 'fixture-app', title: 'corrective delivery', briefing: 'Ship the approved correction.' });
  ledger.setJobStatus(jobId, 'working');
  ledger.setJobPr(jobId, 'https://github.com/acme/fixture/pull/302');
  for (let revision = 1; revision <= 3; revision += 1) {
    const result = ledger.addJobAmendment({ jobId, body: `Approved correction ${revision}.`, effect: 'material',
      approval: { by: 'owner', reference: `fixture-approval-${revision}` },
      expectedContractSha256: ledger.effectiveContract(jobId)!.contractSha256 });
    expect(result.status).toBe('accepted');
  }
  // The incident had a genuine same-head PASS before the deliberate negatives.
  completed(ledger, jobId, 'full', 'initial-pass', true);
  ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { sha: HEAD, work_revision: 3 } });
}

function completed(ledger: LedgerApi, jobId: string, scope: string, runId: string, ok = false, head = HEAD): EventRecord {
  return ledger.appendCustomEvent({ kind: 'verification.completed', jobId,
    payload: { ok, exit_code: ok ? 0 : 1, scope, run_id: runId, sha: head, tracked_dirty: false } });
}

function disposition(ledger: LedgerApi, jobId: string, scope: string, runId: string,
  overrides: Partial<Parameters<LedgerApi['recordDecision']>[0]> = {}): DecisionRecord {
  return ledger.recordDecision({ subject: `job:${jobId}`, decision: 'dismissed', covers: ['verification-failure'],
    basisFingerprint: `verification-failure:${scope}@${runId}`, by: 'owner',
    reason: 'The named intentional-negative baseline needs no product repair; its FAILED receipt remains.', ...overrides });
}

function digest(ledger: LedgerApi, now = NOW): Promise<SilasOpsDigest> {
  return computeSilasDigest({ ledger, blockersForRound: async () => ({ blockers: [], note: null }),
    config: DEFAULT_SILAS_CONFIG, trigger: 'api', now: () => now });
}

function owed(jobId = 'corrective-job', head = HEAD): object[] {
  return [{ jobId, repo: 'fixture-app', revision: 3, head }];
}

function driverHarness(ledger: LedgerApi, now: () => number = () => NOW): { driver: SilasDriver; prompts: string[] } {
  const prompts: string[] = [];
  const handle: AgentHandle = { id: 'fixture-silas', role: 'silas', sessionFile: null,
    capabilities: { streaming: false, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
    async prompt(text) { prompts.push(text); }, async steer() {}, async followUp() {}, async dispose() {},
    subscribe: () => () => {}, health: () => ({ state: 'idle', lastActivity: null, sessionFile: null }) };
  const driver = new SilasDriver({ ledger, slot: { ensure: async () => handle },
    config: { ...DEFAULT_SILAS_CONFIG, enabled: true, sweepIntervalMs: 0, pollIntervalMs: 0, unchangedRewakeMs: 0 },
    ops: { baseUrl: 'http://127.0.0.1:7665', configPath: '/fixture/config.toml' }, skills: [], now });
  return { driver, prompts };
}

function wakeDigest(prompt: string): SilasOpsDigest {
  const serialized = /```json\n([\s\S]*?)\n```/u.exec(prompt);
  expect(serialized).not.toBeNull();
  return JSON.parse(serialized![1]!) as SilasOpsDigest;
}

describe('Silas corrective verification after exact failure dismissals (GH-302)', () => {
  it('keeps one verification owed after independent same-head baselines are dismissed, without granting review', async () => {
    const ledger = fixture();
    correctiveDelivery(ledger);
    const first = completed(ledger, 'corrective-job', 'baseline', 'negative-1');
    const second = completed(ledger, 'corrective-job', 'r2-baseline', 'negative-2');
    disposition(ledger, 'corrective-job', 'baseline', 'negative-1');
    disposition(ledger, 'corrective-job', 'r2-baseline', 'negative-2');
    const result = await digest(ledger);
    expect(result.verificationsOwed).toEqual(owed());
    expect(result.verificationFailures).toEqual([]);
    expect(result.prWithoutReview).toEqual([]);
    expect(result.revisionContinuations).toEqual([]);
    expect(digestActionCount(result)).toBe(1);
    expect(ledger.correctiveVerificationDebt('corrective-job')).toEqual({ revision: 3, head: HEAD });
    expect(laneIsBusy(ledger, ledger.getJob('corrective-job')!)).toBe(true);
    expect(ledger.listJobEventsByKinds('corrective-job', ['verification.completed']).filter((row) => row.seq === first.seq || row.seq === second.seq))
      .toEqual([second, first]);
  });

  it('routes an unresolved genuine same-head failure to repair, not unchanged verification', async () => {
    const ledger = fixture();
    correctiveDelivery(ledger);
    completed(ledger, 'corrective-job', 'baseline', 'negative');
    disposition(ledger, 'corrective-job', 'baseline', 'negative');
    completed(ledger, 'corrective-job', 'full', 'product-failure');
    const result = await digest(ledger);
    expect(result.verificationFailures).toEqual([expect.objectContaining({ scope: 'full', runId: 'product-failure', head: HEAD })]);
    expect(result.verificationsOwed).toEqual([]);
    expect(result.prWithoutReview).toEqual([]);
    expect(laneIsBusy(ledger, ledger.getJob('corrective-job')!)).toBe(true);
  });

  it('does not borrow a dismissal from another job, scope, run or changed basis', async () => {
    const ledger = fixture();
    correctiveDelivery(ledger);
    completed(ledger, 'corrective-job', 'baseline', 'negative');
    disposition(ledger, 'other-job', 'baseline', 'negative');
    disposition(ledger, 'corrective-job', 'other-scope', 'negative');
    disposition(ledger, 'corrective-job', 'baseline', 'other-run');
    disposition(ledger, 'corrective-job', 'baseline', 'negative', { basisFingerprint: HEAD });
    const result = await digest(ledger);
    expect(result.verificationFailures.map((row) => row.runId)).toEqual(['negative']);
    expect(result.verificationsOwed).toEqual([]);
  });

  it('a newer failed run in the same scope reopens repair while another scope stays dismissed', async () => {
    const ledger = fixture();
    correctiveDelivery(ledger);
    completed(ledger, 'corrective-job', 'baseline', 'negative-1');
    completed(ledger, 'corrective-job', 'r2-baseline', 'negative-2');
    disposition(ledger, 'corrective-job', 'baseline', 'negative-1');
    disposition(ledger, 'corrective-job', 'r2-baseline', 'negative-2');
    completed(ledger, 'corrective-job', 'baseline', 'negative-3');
    const result = await digest(ledger);
    expect(result.verificationFailures.map((row) => [row.scope, row.runId])).toEqual([['baseline', 'negative-3']]);
    expect(result.verificationsOwed).toEqual([]);
  });

  it('a failure on a newly delivered head cannot inherit an old run dismissal', async () => {
    const ledger = fixture();
    correctiveDelivery(ledger);
    completed(ledger, 'corrective-job', 'baseline', 'old-run');
    disposition(ledger, 'corrective-job', 'baseline', 'old-run');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'corrective-job', payload: { sha: NEXT_HEAD, work_revision: 3 } });
    completed(ledger, 'corrective-job', 'baseline', 'new-run', false, NEXT_HEAD);
    const result = await digest(ledger);
    expect(result.verificationFailures).toEqual([expect.objectContaining({ runId: 'new-run', head: NEXT_HEAD })]);
    expect(result.verificationsOwed).toEqual([]);
    expect(ledger.correctiveVerificationDebt('corrective-job')).toEqual({ revision: 3, head: NEXT_HEAD });
  });

  it('wildcard dismissals and non-dismissal decisions are not exact repair dispositions', async () => {
    const ledger = fixture();
    correctiveDelivery(ledger);
    completed(ledger, 'corrective-job', 'baseline', 'negative');
    disposition(ledger, 'corrective-job', 'baseline', 'negative', { basisFingerprint: null });
    for (const decision of ['hold', 'acted', 'superseded', 'covered'] as const) {
      disposition(ledger, 'corrective-job', 'baseline', 'negative', { decision });
      const result = await digest(ledger);
      expect(result.verificationFailures.map((row) => row.runId), decision).toEqual(['negative']);
      expect(result.verificationsOwed, decision).toEqual([]);
    }
  });

  it('clearing the exact dismissal reopens repair without rewriting its failed receipt', async () => {
    const ledger = fixture();
    correctiveDelivery(ledger);
    const failure = completed(ledger, 'corrective-job', 'baseline', 'negative');
    const decision = disposition(ledger, 'corrective-job', 'baseline', 'negative');
    expect((await digest(ledger)).verificationsOwed).toEqual(owed());
    ledger.clearDecision({ id: decision.id, by: 'owner', reason: 'Reconsider the original failure.' });
    const result = await digest(ledger);
    expect(result.verificationFailures.map((row) => row.runId)).toEqual(['negative']);
    expect(result.verificationsOwed).toEqual([]);
    expect(ledger.latestJobEvent('corrective-job', 'verification.completed')).toEqual(failure);
  });

  it('an expired newer exact decision reopens repair instead of falling back to an older dismissal', async () => {
    const ledger = fixture();
    correctiveDelivery(ledger);
    completed(ledger, 'corrective-job', 'baseline', 'negative');
    disposition(ledger, 'corrective-job', 'baseline', 'negative');
    disposition(ledger, 'corrective-job', 'baseline', 'negative', { recheckAt: new Date(NOW + 1_000).toISOString() });
    expect((await digest(ledger)).verificationsOwed).toEqual(owed());
    const result = await digest(ledger, NOW + 1_000);
    expect(result.verificationFailures.map((row) => row.runId)).toEqual(['negative']);
    expect(result.verificationsOwed).toEqual([]);
  });

  it('finds independent exact dismissals past the bounded decision listing window', async () => {
    const ledger = fixture();
    correctiveDelivery(ledger);
    completed(ledger, 'corrective-job', 'baseline', 'negative');
    disposition(ledger, 'corrective-job', 'baseline', 'negative');
    for (let n = 0; n < 510; n += 1) {
      disposition(ledger, 'corrective-job', `other-scope-${n}`, `other-run-${n}`);
    }
    const result = await digest(ledger);
    expect(result.verificationFailures).toEqual([]);
    expect(result.verificationsOwed).toEqual(owed());
  });

  it('exact baseline dismissals never bypass live directives, rebriefs, verification or retirement holds', async () => {
    for (const fence of ['directive', 'rebrief', 'verification', 'retirement'] as const) {
      const ledger = fixture();
      correctiveDelivery(ledger);
      completed(ledger, 'corrective-job', 'baseline', 'negative');
      disposition(ledger, 'corrective-job', 'baseline', 'negative');
      if (fence === 'directive') {
        ledger.beginDirectiveIntent({ jobId: 'corrective-job', directive: 'Implement the correction.', holder: 'fixture' });
      } else if (fence === 'rebrief') {
        ledger.beginPendingRebrief({ jobId: 'corrective-job', note: 'Continue the approved correction.', briefing: 'b' });
      } else if (fence === 'verification') {
        ledger.appendCustomEvent({ kind: 'verification.requested', jobId: 'corrective-job',
          payload: { scope: 'full', run_id: 'pending-run', head: HEAD } });
      } else {
        const intent = ledger.beginDirectiveIntent({ jobId: 'corrective-job', directive: 'Interrupted correction.', holder: 'fixture' });
        ledger.retireInterruptedDirective({ requestId: intent.record.requestId, expectedJobId: 'corrective-job', expectedState: 'dispatching',
          expectedPayloadHash: intent.record.payloadHash, expectedHead: HEAD, lane: { id: 'fixture-lane', resolvedHead: HEAD },
          reason: 'Fixture producer cessation was proven.', by: 'owner' });
        expect(ledger.hasOpenDirectiveRecoveryHold('corrective-job')).toBe(true);
      }
      const result = await digest(ledger);
      expect(result.verificationsOwed, fence).toEqual([]);
      expect(result.prWithoutReview, fence).toEqual([]);
      expect(laneIsBusy(ledger, ledger.getJob('corrective-job')!), fence).toBe(true);
    }
  });

  it('rechecks a dismissal cleared while another job blocker read awaited before publishing the digest', async () => {
    const ledger = fixture();
    correctiveDelivery(ledger);
    completed(ledger, 'corrective-job', 'baseline', 'negative');
    const decision = disposition(ledger, 'corrective-job', 'baseline', 'negative');
    ledger.addJob({ id: 'review-job', repo: 'fixture-app', title: 'review', briefing: 'b' });
    ledger.setJobStatus('review-job', 'working');
    ledger.setJobStatus('review-job', 'in-review');
    const round = ledger.addRound({ jobId: 'review-job', lenses: ['blind'] });
    ledger.setRoundStatus(round.id, 'live');
    ledger.setRoundStatus(round.id, 'verdict-posted');
    ledger.setRoundVerdict(round.id, 'changes-requested');
    ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'review-job', roundId: round.id, payload: { verdict: 'changes-requested' } });
    const result = await computeSilasDigest({ ledger, config: DEFAULT_SILAS_CONFIG, trigger: 'api', now: () => NOW,
      blockersForRound: async () => {
        await Promise.resolve();
        ledger.clearDecision({ id: decision.id, by: 'owner', reason: 'Recheck during the digest await.' });
        return { blockers: [], note: null };
      } });
    expect(ledger.getDecision(decision.id)?.clearedAt).not.toBeNull();
    expect(result.verificationFailures.map((row) => row.runId)).toEqual(['negative']);
    expect(result.verificationsOwed).toEqual([]);
  });

  it('genuine eligible verification clears the debt normally while baseline outcomes stay FAILED', async () => {
    const ledger = fixture();
    correctiveDelivery(ledger);
    const negative = completed(ledger, 'corrective-job', 'baseline', 'negative');
    disposition(ledger, 'corrective-job', 'baseline', 'negative');
    expect((await digest(ledger)).verificationsOwed).toEqual(owed());
    completed(ledger, 'corrective-job', 'typecheck', 'other-head-pass', true, NEXT_HEAD);
    expect((await digest(ledger)).verificationsOwed).toEqual(owed());
    const dirty = ledger.appendCustomEvent({ kind: 'verification.completed', jobId: 'corrective-job',
      payload: { ok: true, exit_code: 0, scope: 'typecheck', run_id: 'dirty-pass', sha: HEAD, tracked_dirty: true } });
    expect((await digest(ledger)).verificationsOwed).toEqual(owed());
    completed(ledger, 'corrective-job', 'typecheck', 'eligible-pass', true);
    const result = await digest(ledger);
    expect(result.verificationsOwed).toEqual([]);
    expect(result.verificationFailures).toEqual([]);
    expect(result.prWithoutReview.map((row) => row.jobId)).toEqual(['corrective-job']);
    expect(laneIsBusy(ledger, ledger.getJob('corrective-job')!)).toBe(false);
    expect(ledger.listJobEventsByKinds('corrective-job', ['verification.completed'])).toContainEqual(negative);
    expect(ledger.listJobEventsByKinds('corrective-job', ['verification.completed'])).toContainEqual(dirty);
  });

  it('keeps a malformed dismissal date actionable without hiding unrelated jobs', async () => {
    const ledger = fixture();
    correctiveDelivery(ledger);
    const failed = completed(ledger, 'corrective-job', 'baseline', 'negative');
    const decision = disposition(ledger, 'corrective-job', 'baseline', 'negative');
    databases.get(ledger)!.handle.prepare('UPDATE decisions SET recheck_at = ? WHERE id = ?').run('not-a-date', decision.id);
    correctiveDelivery(ledger, 'unrelated-job');
    completed(ledger, 'unrelated-job', 'baseline', 'unrelated-negative');
    disposition(ledger, 'unrelated-job', 'baseline', 'unrelated-negative');
    const result = await digest(ledger);
    expect(result.verificationsOwed).toEqual(owed('unrelated-job'));
    expect(result.verificationFailures).toEqual([expect.objectContaining({ jobId: 'corrective-job', runId: 'negative',
      detail: expect.stringContaining(`decision "${decision.id}" has an unparseable recheck_at "not-a-date"`) })]);
    expect(result.verificationFailures[0]?.detail).toContain('correct or clear the decision');
    expect(laneIsBusy(ledger, ledger.getJob('corrective-job')!)).toBe(true);
    expect(ledger.latestJobEvent('corrective-job', 'verification.completed')).toEqual(failed);
  });

  it('a newer wildcard fences older exact dismissals but not later independent exact decisions', async () => {
    const ledger = fixture();
    correctiveDelivery(ledger);
    completed(ledger, 'corrective-job', 'baseline', 'older-negative');
    disposition(ledger, 'corrective-job', 'baseline', 'older-negative');
    expect((await digest(ledger)).verificationsOwed).toEqual(owed());
    disposition(ledger, 'corrective-job', 'baseline', 'older-negative', { decision: 'hold', basisFingerprint: null });
    const fenced = await digest(ledger);
    expect(fenced.verificationFailures.map((row) => row.runId)).toEqual(['older-negative']);
    expect(fenced.verificationsOwed).toEqual([]);
    completed(ledger, 'corrective-job', 'r2-baseline', 'newer-negative');
    disposition(ledger, 'corrective-job', 'r2-baseline', 'newer-negative');
    const independent = await digest(ledger);
    expect(independent.verificationFailures.map((row) => row.runId)).toEqual(['older-negative']);
    expect(independent.verificationsOwed).toEqual([]);
    disposition(ledger, 'corrective-job', 'baseline', 'older-negative');
    expect((await digest(ledger)).verificationsOwed).toEqual(owed());
  });

  it('an unavailable decision reader grants no dismissal and keeps same-head repair actionable', async () => {
    const ledger = fixture();
    correctiveDelivery(ledger);
    completed(ledger, 'corrective-job', 'baseline', 'negative');
    disposition(ledger, 'corrective-job', 'baseline', 'negative');
    Object.defineProperty(ledger, 'listDecisions', { value: undefined });
    const result = await digest(ledger);
    expect(result.verificationFailures.map((row) => row.runId)).toEqual(['negative']);
    expect(result.verificationsOwed).toEqual([]);
  });

  it('failures without a scope or run identity cannot borrow an exact dismissal', async () => {
    for (const missing of ['scope', 'run_id'] as const) {
      const ledger = fixture();
      correctiveDelivery(ledger);
      ledger.appendCustomEvent({ kind: 'verification.completed', jobId: 'corrective-job',
        payload: { ok: false, exit_code: 1, scope: 'baseline', run_id: 'negative', sha: HEAD, tracked_dirty: false, [missing]: null } });
      disposition(ledger, 'corrective-job', 'baseline', 'negative');
      const result = await digest(ledger);
      expect(result.verificationFailures, missing).toEqual([expect.objectContaining({ head: HEAD,
        ...(missing === 'scope' ? { scope: null } : { runId: null }) })]);
      expect(result.verificationsOwed, missing).toEqual([]);
    }
  });

  it('the normal Silas sweep delivers the restored debt to its single wake slot', async () => {
    const ledger = fixture();
    correctiveDelivery(ledger);
    completed(ledger, 'corrective-job', 'baseline', 'negative');
    disposition(ledger, 'corrective-job', 'baseline', 'negative');
    const { driver, prompts } = driverHarness(ledger);
    try {
      await driver.trigger({ kind: 'sweep' });
      expect(prompts).toHaveLength(1);
      expect(wakeDigest(prompts[0]!).verificationsOwed).toEqual(owed());
      expect(wakeDigest(prompts[0]!).verificationFailures).toEqual([]);
      await driver.trigger({ kind: 'sweep' });
      expect(prompts).toHaveLength(1); // unchanged debt is not another producer or wake
    } finally {
      driver.stop();
    }
  });

  it('a dismissal deadline reopens repair through the normal sweep with no new ledger traffic', async () => {
    const ledger = fixture();
    correctiveDelivery(ledger);
    completed(ledger, 'corrective-job', 'baseline', 'negative');
    disposition(ledger, 'corrective-job', 'baseline', 'negative', { recheckAt: new Date(NOW + 1_000).toISOString() });
    let time = NOW;
    const { driver, prompts } = driverHarness(ledger, () => time);
    try {
      await driver.trigger({ kind: 'sweep' });
      expect(prompts).toHaveLength(1);
      expect(wakeDigest(prompts[0]!).verificationsOwed).toEqual(owed());
      const sourceSeq = ledger.listJobEvents('corrective-job', { limit: 1 })[0]!.seq;
      time += 1_000;
      await driver.trigger({ kind: 'sweep' });
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('verificationFailures');
      expect(prompts[1]).toContain('negative');
      const reopened = await digest(ledger, time);
      expect(reopened.verificationFailures.map((row) => row.runId)).toEqual(['negative']);
      expect(reopened.verificationsOwed).toEqual([]);
      expect(ledger.listJobEvents('corrective-job', { limit: 1 })[0]!.seq).toBe(sourceSeq);
      await driver.trigger({ kind: 'sweep' });
      expect(prompts).toHaveLength(2);
    } finally {
      driver.stop();
    }
  });
});

describe('a historical-only delivery owes a current inspection (#361)', () => {
  /** Approved material corrections, then the job's only delivery: a
   * completion recorded WITHOUT a proven current candidate. */
  function historicalOnly(ledger: LedgerApi, jobId = 'historical-job', provenFirst = false): number {
    ledger.addJob({ id: jobId, repo: 'fixture-app', title: 'historical delivery', briefing: 'Ship it.' });
    ledger.setJobStatus(jobId, 'working');
    if (provenFirst) ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { sha: HEAD, work_revision: 0 } });
    for (let revision = 1; revision <= 2; revision += 1) {
      expect(ledger.addJobAmendment({ jobId, body: `Approved correction ${revision}.`, effect: 'material',
        approval: { by: 'owner', reference: `fixture-approval-${revision}` },
        expectedContractSha256: ledger.effectiveContract(jobId)!.contractSha256 }).status).toBe('accepted');
    }
    return ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { sha: null, work_revision: 2, candidate_delivery_proven: false } }).seq;
  }

  it('offers one current-inspection row, and no verification, continuation, PR or review row — review stays fenced', async () => {
    const ledger = fixture();
    const seq = historicalOnly(ledger);
    expect(ledger.latestCandidateDelivery('historical-job')).toBeNull();
    expect(ledger.correctiveVerificationDebt('historical-job')).toEqual({ revision: 2, head: null });
    const result = await digest(ledger);
    expect(result.currentInspections).toEqual([{ jobId: 'historical-job', repo: 'fixture-app', verificationRevision: 2, requiredRevision: 2, historicalDeliverySeq: seq }]);
    expect([result.verificationsOwed, result.revisionContinuations, result.deliveredWithoutPr, result.prWithoutReview]).toEqual([[], [], [], []]);
    expect(digestActionCount(result)).toBe(1);
    expect(laneIsBusy(ledger, ledger.getJob('historical-job')!)).toBe(true);
    // It reaches Silas in its wake digest.
    const { driver, prompts } = driverHarness(ledger);
    try {
      await driver.trigger({ kind: 'sweep' });
      expect(prompts).toHaveLength(1);
      expect(wakeDigest(prompts[0]!).currentInspections).toEqual(result.currentInspections);
    } finally {
      driver.stop();
    }
  });

  it('is withheld while a writer owns the lane or a verification runs', async () => {
    for (const fence of ['directive', 'rebrief', 'verification'] as const) {
      const ledger = fixture();
      historicalOnly(ledger);
      if (fence === 'directive') ledger.beginDirectiveIntent({ jobId: 'historical-job', directive: 'Deliver the current candidate.', holder: 'fixture' });
      else if (fence === 'rebrief') ledger.beginPendingRebrief({ jobId: 'historical-job', note: 'Continue.', briefing: 'b' });
      else ledger.appendCustomEvent({ kind: 'verification.requested', jobId: 'historical-job', payload: { scope: 'full', run_id: 'pending-run', head: HEAD } });
      expect((await digest(ledger)).currentInspections, fence).toEqual([]);
    }
  });

  it('names each obligation on its own: a plain historical completion owes only the candidate\'s verification', async () => {
    const ledger = fixture();
    ledger.addJob({ id: 'plain-job', repo: 'fixture-app', title: 'plain', briefing: 'Ship it.' });
    ledger.setJobStatus('plain-job', 'working');
    const seq = ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'plain-job', payload: { sha: null, work_revision: 0, candidate_delivery_proven: false } }).seq;
    expect((await digest(ledger)).currentInspections).toEqual([{ jobId: 'plain-job', repo: 'fixture-app', verificationRevision: 0, requiredRevision: null, historicalDeliverySeq: seq }]);
    // A later historical delivery is a new inspection (a new seq, so a new request id).
    const later = ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'plain-job', payload: { sha: null, work_revision: 0, candidate_delivery_proven: false } }).seq;
    expect((await digest(ledger)).currentInspections.map((row) => row.historicalDeliverySeq)).toEqual([later]);
  });

  it('stands aside for a failed verification that owns the job, and is rechecked before the digest is published', async () => {
    const ledger = fixture();
    historicalOnly(ledger);
    completed(ledger, 'historical-job', 'full', 'failed-run');
    const failing = await digest(ledger);
    expect(failing.verificationFailures.map((row) => row.jobId)).toEqual(['historical-job']);
    expect(failing.currentInspections).toEqual([]);
    // A writer that takes the lane while the digest is being computed retracts the row.
    const racing = fixture();
    historicalOnly(racing);
    racing.addJob({ id: 'review-job', repo: 'fixture-app', title: 'review', briefing: 'b' });
    racing.setJobStatus('review-job', 'working');
    racing.setJobStatus('review-job', 'in-review');
    const round = racing.addRound({ jobId: 'review-job', lenses: ['blind'] });
    racing.setRoundStatus(round.id, 'live');
    racing.setRoundStatus(round.id, 'verdict-posted');
    racing.setRoundVerdict(round.id, 'changes-requested');
    racing.appendCustomEvent({ kind: 'round.verdict', jobId: 'review-job', roundId: round.id, payload: { verdict: 'changes-requested' } });
    const result = await computeSilasDigest({ ledger: racing, config: DEFAULT_SILAS_CONFIG, trigger: 'api', now: () => NOW,
      blockersForRound: async () => {
        await Promise.resolve();
        racing.beginDirectiveIntent({ jobId: 'historical-job', directive: 'Deliver the current candidate.', holder: 'fixture' });
        return { blockers: [], note: null };
      } });
    expect(result.currentInspections).toEqual([]);
  });

  it('stands aside for a stalled lane and for a minion error that own the job', async () => {
    for (const owner of ['stall', 'error'] as const) {
      const ledger = fixture();
      historicalOnly(ledger);
      if (owner === 'stall') {
        ledger.registerAgent({ id: 'min-historical', role: 'minion', jobId: 'historical-job' });
        ledger.setAgentState('min-historical', 'idle');
      } else {
        ledger.appendCustomEvent({ kind: 'job.minion-error', jobId: 'historical-job', payload: { error: 'provider down' } });
      }
      const result = await digest(ledger);
      expect((owner === 'stall' ? result.stalledWorking : result.minionErrors).map((row) => row.jobId), owner).toEqual(['historical-job']);
      expect(result.currentInspections, owner).toEqual([]);
    }
  });

  it('a stalled row retracted at the publish boundary no longer hides the inspection', async () => {
    const ledger = fixture();
    historicalOnly(ledger);
    ledger.registerAgent({ id: 'min-historical', role: 'minion', jobId: 'historical-job' });
    ledger.setAgentState('min-historical', 'idle');
    // A later job's blocker history is awaited, which opens the gap.
    ledger.addJob({ id: 'review-job', repo: 'fixture-app', title: 'review', briefing: 'b' });
    ledger.setJobStatus('review-job', 'working');
    ledger.setJobStatus('review-job', 'in-review');
    const round = ledger.addRound({ jobId: 'review-job', lenses: ['blind'] });
    ledger.setRoundStatus(round.id, 'live');
    ledger.setRoundStatus(round.id, 'verdict-posted');
    ledger.setRoundVerdict(round.id, 'changes-requested');
    ledger.appendCustomEvent({ kind: 'round.verdict', jobId: 'review-job', roundId: round.id, payload: { verdict: 'changes-requested' } });
    // Jobs are read newest-updated first: the historical lane is computed
    // (its stall included) before the review job's await.
    databases.get(ledger)!.handle.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', 'review-job');
    let awaited = false;
    const result = await computeSilasDigest({ ledger, config: DEFAULT_SILAS_CONFIG, trigger: 'api', now: () => NOW,
      blockersForRound: async () => {
        await Promise.resolve();
        // The worker shows activity during the gap (no job event): the stall
        // is retracted, and nothing else owns the job.
        databases.get(ledger)!.handle.prepare('UPDATE agents SET last_activity = ? WHERE id = ?').run(new Date(NOW).toISOString(), 'min-historical');
        awaited = true;
        return { blockers: [], note: null };
      } });
    expect(awaited).toBe(true);
    expect(result.stalledWorking).toEqual([]);
    expect(result.currentInspections.map((row) => row.jobId)).toEqual(['historical-job']);
  });

  it('retires once a proven current delivery exists, and never duplicates a row that already owns the job', async () => {
    const ledger = fixture();
    historicalOnly(ledger);
    expect((await digest(ledger)).currentInspections).toHaveLength(1);
    // A proven current delivery hands the job back to the ordinary rows.
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'historical-job', payload: { sha: NEXT_HEAD, work_revision: 2 } });
    const delivered = await digest(ledger);
    expect(delivered.currentInspections).toEqual([]);
    expect(delivered.verificationsOwed).toEqual([{ jobId: 'historical-job', repo: 'fixture-app', revision: 2, head: NEXT_HEAD }]);
    // With a proven delivery in the current phase, the continuation row owns the job: no second row.
    const owned = fixture();
    historicalOnly(owned, 'owned-job', true);
    const ownedDigest = await digest(owned);
    expect(ownedDigest.currentInspections).toEqual([]);
    expect(ownedDigest.revisionContinuations).toEqual([{ jobId: 'owned-job', repo: 'fixture-app', requiredRevision: 2, deliveredRevision: 0, pendingVersions: [1, 2] }]);
    // A job with only proven deliveries owes no inspection.
    const quiet = fixture();
    quiet.addJob({ id: 'quiet-job', repo: 'fixture-app', title: 'quiet', briefing: 'Ship it.' });
    quiet.setJobStatus('quiet-job', 'working');
    quiet.appendCustomEvent({ kind: 'job.delivered', jobId: 'quiet-job', payload: { sha: HEAD, work_revision: 0 } });
    expect((await digest(quiet)).currentInspections).toEqual([]);
  });
});

describe('verdict digest is fenced by an unsettled verification (issue #243 original-M2)', () => {
  it('never publishes a verdict row while a verification owns the lane', async () => {
    const ledger = fixture();
    ledger.addJob({ id: 'job-verdict-fence', repo: 'fixture-app', title: 't', briefing: 'b' });
    ledger.setJobStatus('job-verdict-fence', 'working');
    ledger.setJobStatus('job-verdict-fence', 'in-review');
    const round = ledger.addRound({ jobId: 'job-verdict-fence', targetRef: HEAD });
    ledger.setRoundStatus(round.id, 'live');
    ledger.setRoundVerdict(round.id, 'changes-requested');
    // Baseline: with no verification in flight the verdict row is offered.
    const before = await digest(ledger);
    expect(before.verdictsAwaitingDirective.map((row) => row.jobId)).toEqual(['job-verdict-fence']);
    // An unsettled verification owns the lane: the publish boundary must
    // retract the row, so neither the autopilot nor a model wake sees it.
    ledger.appendCustomEvent({
      kind: 'verification.requested',
      jobId: 'job-verdict-fence',
      payload: { scope: 'full', run_id: 'run-verdict-fence', head: HEAD },
    });
    const after = await digest(ledger);
    expect(after.verdictsAwaitingDirective).toEqual([]);
  });
});

describe('verdict wake is suppressed while accepted ownership is unresolved (issue #243 F-M1)', () => {
  it('retracts the verdict row while a live directive owns the lane, and publishes it once free', async () => {
    const ledger = fixture();
    ledger.addJob({ id: 'job-fm1', repo: 'fixture-app', title: 't', briefing: 'b' });
    ledger.setJobStatus('job-fm1', 'working');
    ledger.setJobStatus('job-fm1', 'in-review');
    const round = ledger.addRound({ jobId: 'job-fm1', targetRef: HEAD });
    ledger.setRoundStatus(round.id, 'live');
    ledger.setRoundVerdict(round.id, 'changes-requested');
    const before = await digest(ledger);
    expect(before.verdictsAwaitingDirective.map((row) => row.jobId)).toEqual(['job-fm1']);
    // An accepted directive PRODUCER owns the lane until its completion
    // receipt: the row is not actionable, so it must not buy a model wake.
    const begun = ledger.beginDirectiveIntent({ jobId: 'job-fm1', directive: 'repair the blocker', holder: 'silas-ops' });
    const during = await digest(ledger);
    expect(during.verdictsAwaitingDirective).toEqual([]);
    // Once the request is terminal (free again) the row returns.
    ledger.failDirective({ requestId: begun.record.requestId, reason: 'fixture terminal' });
    const after = await digest(ledger);
    expect(after.verdictsAwaitingDirective.map((row) => row.jobId)).toEqual(['job-fm1']);
  });
});
