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
afterEach(() => {
  while (closers.length > 0) closers.pop()!();
});

function fixture(): LedgerApi {
  const root = mkdtempSync(join(tmpdir(), 'gru-silas-verification-debt-'));
  const db = new LedgerDb(root);
  closers.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return new LedgerApi(db.handle);
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

describe('Silas corrective verification after exact failure dismissals (GH-302)', () => {
  it('keeps one verification owed after independent same-head baselines are dismissed, without granting review', async () => {
    const ledger = fixture();
    correctiveDelivery(ledger);
    const first = completed(ledger, 'corrective-job', 'baseline', 'negative-1');
    const second = completed(ledger, 'corrective-job', 'r2-baseline', 'negative-2');
    disposition(ledger, 'corrective-job', 'baseline', 'negative-1');
    disposition(ledger, 'corrective-job', 'r2-baseline', 'negative-2');
    const result = await digest(ledger);
    expect(result.verificationFailures).toEqual([]);
    expect(result.verificationsOwed).toEqual(owed());
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
    completed(ledger, 'corrective-job', 'typecheck', 'eligible-pass', true, NEXT_HEAD);
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

  it('the normal Silas sweep delivers the restored debt to its single wake slot', async () => {
    const ledger = fixture();
    correctiveDelivery(ledger);
    completed(ledger, 'corrective-job', 'baseline', 'negative');
    disposition(ledger, 'corrective-job', 'baseline', 'negative');
    const prompts: string[] = [];
    const handle: AgentHandle = { id: 'fixture-silas', role: 'silas', sessionFile: null,
      capabilities: { streaming: false, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false },
      async prompt(text) { prompts.push(text); }, async steer() {}, async followUp() {}, async dispose() {},
      subscribe: () => () => {}, health: () => ({ state: 'idle', lastActivity: null, sessionFile: null }) };
    const driver = new SilasDriver({ ledger, slot: { ensure: async () => handle },
      config: { ...DEFAULT_SILAS_CONFIG, enabled: true, sweepIntervalMs: 0, pollIntervalMs: 0, unchangedRewakeMs: 0 },
      ops: { baseUrl: 'http://127.0.0.1:7665', configPath: '/fixture/config.toml' }, skills: [], now: () => NOW });
    try {
      await driver.trigger({ kind: 'sweep' });
      expect(prompts).toHaveLength(1);
      const serialized = /```json\n([\s\S]*?)\n```/u.exec(prompts[0]!);
      expect(serialized).not.toBeNull();
      const delivered = JSON.parse(serialized![1]!) as SilasOpsDigest;
      expect(delivered.verificationsOwed).toEqual(owed());
      expect(delivered.verificationFailures).toEqual([]);
      await driver.trigger({ kind: 'sweep' });
      expect(prompts).toHaveLength(1); // unchanged debt is not another producer or wake
    } finally {
      driver.stop();
    }
  });
});
