import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import {
  AUTOPILOT_DECISION_EVENT,
  AUTOPILOT_SOURCE,
  autopilotRuleMode,
  runSilasAutopilot,
  type AutopilotLedger,
  type SilasAutopilotOps,
} from '../src/dispatch/silas-autopilot.js';
import { createSilasAutopilotOps } from '../src/dispatch/silas-autopilot-ops.js';
import type { SilasAutopilotConfig } from '../src/config.js';
import type {
  ConflictingPrRow,
  DeliveredWithoutPrRow,
  DigestRecurringBlocker,
  PrWithoutReviewRow,
  ReleaseEligibleRow,
  SilasOpsDigest,
  VerdictAwaitingDirectiveRow,
  VerificationFailureRow,
} from '../src/dispatch/silas-driver.js';

/**
 * The Silas autopilot (issue #243). The rule-hit / rule-miss pair for every
 * family, the mode matrix (`off` / `dry-run` / `enforce`), and the receipt
 * provenance the ops binding writes.
 *
 * The digest is built by hand — the autopilot consumes rows, and a digest
 * row is exactly what these tests must hand it — while the ledger port is a
 * faithful, explicitly-driven fake so the fence reads under test are the
 * ones the production port performs.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------
// Ledger fake (the AutopilotLedger surface, explicitly driven)
// ------------------------------------------------------------------

interface FakeEvent {
  seq: number;
  kind: string;
  jobId: string | null;
  payload: Record<string, unknown>;
}

interface FakeLedgerState {
  jobs: Map<string, { id: string; status: string; prUrl: string | null }>;
  events: FakeEvent[];
  rounds: Map<string, { id: string; jobId: string; targetRef: string; status: string }>;
  directives: Map<string, { state: string }>;
  liveDirectiveJobs: string[];
  pendingRebriefJobs: string[];
  recoveryHoldJobs: string[];
  unsettledVerificationJobs: string[];
}

class FakeLedger {
  readonly state: FakeLedgerState = {
    jobs: new Map(),
    events: [],
    rounds: new Map(),
    directives: new Map(),
    liveDirectiveJobs: [],
    pendingRebriefJobs: [],
    recoveryHoldJobs: [],
    unsettledVerificationJobs: [],
  };

  private seq = 0;

  job(id: string, status = 'delivered', prUrl: string | null = null): this {
    this.state.jobs.set(id, { id, status, prUrl });
    return this;
  }

  round(id: string, jobId: string, targetRef: string, status = 'aborted'): this {
    this.state.rounds.set(id, { id, jobId, targetRef, status });
    return this;
  }

  record(jobId: string | null, kind: string, payload: Record<string, unknown> = {}): FakeEvent {
    const event: FakeEvent = { seq: (this.seq += 1), kind, jobId, payload };
    this.state.events.push(event);
    return event;
  }

  get port(): AutopilotLedger {
    return this as unknown as AutopilotLedger;
  }

  decisions(): FakeEvent[] {
    return this.state.events.filter((event) => event.kind === AUTOPILOT_DECISION_EVENT);
  }

  appendCustomEvent(input: { kind: string; jobId?: string; payload?: Record<string, unknown> }): { seq: number } {
    const event = this.record(input.jobId ?? null, input.kind, input.payload ?? {});
    return { seq: event.seq };
  }

  getJob(id: string): { id: string; status: string; prUrl: string | null } | null {
    return this.state.jobs.get(id) ?? null;
  }

  getRound(id: string): { id: string; jobId: string; targetRef: string; status: string } | null {
    return this.state.rounds.get(id) ?? null;
  }

  latestJobEvent(jobId: string, kind: string): FakeEvent | null {
    const matching = this.state.events.filter((event) => event.jobId === jobId && event.kind === kind);
    return matching[matching.length - 1] ?? null;
  }

  getDirective(requestId: string): { state: string } | null {
    return this.state.directives.get(requestId) ?? null;
  }

  listJobEventsByKinds(jobId: string, kinds: readonly string[]): FakeEvent[] {
    return this.state.events.filter((event) => event.jobId === jobId && kinds.includes(event.kind));
  }

  listPendingRebriefs(opts: { jobId?: string } = {}): readonly unknown[] {
    const jobs = opts.jobId === undefined ? this.state.pendingRebriefJobs : this.state.pendingRebriefJobs.filter((id) => id === opts.jobId);
    return jobs.map((jobId) => ({ jobId }));
  }

  listPendingDirectives(input: { jobId: string }): readonly unknown[] {
    return this.state.liveDirectiveJobs.includes(input.jobId) ? [{ jobId: input.jobId }] : [];
  }

  hasOpenDirectiveRecoveryHold(jobId: string): boolean {
    return this.state.recoveryHoldJobs.includes(jobId);
  }

  hasUnsettledVerificationRun(jobId: string): boolean {
    return this.state.unsettledVerificationJobs.includes(jobId);
  }
}

// ------------------------------------------------------------------
// Ops fake (records the calls the production binding would make)
// ------------------------------------------------------------------

interface RecordedCall {
  readonly method: keyof SilasAutopilotOps;
  readonly input: Record<string, unknown>;
}

function fakeOps(overrides: Partial<SilasAutopilotOps> = {}): { ops: SilasAutopilotOps; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const recorded = <K extends keyof SilasAutopilotOps>(method: K, fallback: SilasAutopilotOps[K]): SilasAutopilotOps[K] =>
    (async (input: Record<string, unknown>) => {
      calls.push({ method, input: { ...input } });
      return (overrides[method] ?? fallback)(input as never);
    }) as SilasAutopilotOps[K];
  const noop = async (): Promise<void> => {};
  return {
    ops: {
      listOpenPrsForHead: recorded('listOpenPrsForHead', (async () => []) as SilasAutopilotOps['listOpenPrsForHead']),
      registerPr: recorded('registerPr', noop as SilasAutopilotOps['registerPr']),
      triggerReview: recorded('triggerReview', noop as SilasAutopilotOps['triggerReview']),
      sendDirective: recorded('sendDirective', noop as SilasAutopilotOps['sendDirective']),
      sendRebrief: recorded('sendRebrief', noop as SilasAutopilotOps['sendRebrief']),
      releaseLane: recorded('releaseLane', noop as SilasAutopilotOps['releaseLane']),
    },
    calls,
  };
}

// ------------------------------------------------------------------
// Digest builders
// ------------------------------------------------------------------

function blocker(overrides: Partial<DigestRecurringBlocker> = {}): DigestRecurringBlocker {
  return {
    category: 'correctness',
    title: 'The gate is skipped on retry',
    location: 'src/dispatch/gate.ts:42',
    recommendedFix: 'Re-check the guard before the retry path',
    fingerprint: 'correctness::src/dispatch/gate.ts::the gate is skipped on retry',
    consecutiveRounds: 2,
    advice: 'directive',
    ...overrides,
  };
}

function digest(partial: Partial<SilasOpsDigest> = {}): SilasOpsDigest {
  return {
    computedAt: '2026-10-13T00:00:00.000Z',
    trigger: 'sweep',
    deliveredWithoutPr: [],
    prWithoutReview: [],
    verdictsAwaitingDirective: [],
    stalledWorking: [],
    minionErrors: [],
    verificationFailures: [],
    verificationWaits: [],
    providerRecoveryPending: [],
    conflictingPrs: [],
    releaseEligible: [],
    revisionContinuations: [],
    verificationsOwed: [],
    ...partial,
  };
}

function verdictRow(overrides: Partial<VerdictAwaitingDirectiveRow> = {}): VerdictAwaitingDirectiveRow {
  return {
    jobId: 'job-verdict',
    repo: 'gru-command',
    roundId: 'round-1',
    roundSeq: 1,
    verdict: 'changes-requested',
    blockerCount: 1,
    blockersNote: null,
    recurringBlockers: [blocker()],
    ...overrides,
  };
}

function verificationRow(overrides: Partial<VerificationFailureRow> = {}): VerificationFailureRow {
  return {
    jobId: 'job-verify',
    repo: 'gru-command',
    scope: 'unit',
    runId: 'run-9',
    head: 'a'.repeat(40),
    at: '2026-10-13T00:00:00.000Z',
    detail: 'exit status 1',
    ...overrides,
  };
}

function conflictRow(overrides: Partial<ConflictingPrRow> = {}): ConflictingPrRow {
  return {
    jobId: 'job-conflict',
    repo: 'gru-command',
    branch: 'gru/job-conflict',
    prNumber: 42,
    prUrl: 'https://github.com/mssoka/gru-command/pull/42',
    headSha: 'b'.repeat(40),
    firstSeenAt: '2026-10-13T00:00:00.000Z',
    ...overrides,
  };
}

function prWithoutReviewRow(overrides: Partial<PrWithoutReviewRow> = {}): PrWithoutReviewRow {
  return {
    jobId: 'job-review',
    repo: 'gru-command',
    prUrl: 'https://github.com/mssoka/gru-command/pull/7',
    priorRounds: 0,
    ...overrides,
  };
}

function releaseRow(overrides: Partial<ReleaseEligibleRow> = {}): ReleaseEligibleRow {
  return { jobId: 'job-release', repo: 'gru-command', status: 'done', branch: 'gru/job-release', ...overrides };
}

function deliveredRow(overrides: Partial<DeliveredWithoutPrRow> = {}): DeliveredWithoutPrRow {
  return {
    jobId: 'job-delivered',
    repo: 'gru-command',
    branch: 'gru/job-delivered',
    lanePath: '/tmp/lane/job-delivered',
    minionSessionFile: null,
    deliveredAt: '2026-10-13T00:00:00.000Z',
    ...overrides,
  };
}

const enabled = (rules: SilasAutopilotConfig['rules'] = {}): SilasAutopilotConfig => ({ enabled: true, rules });

// ------------------------------------------------------------------
// The mode matrix
// ------------------------------------------------------------------

describe('autopilot mode resolution (kill switch + per-family modes)', () => {
  it('defaults every family to dry-run, and honors an explicit off/enforce', () => {
    expect(autopilotRuleMode(enabled(), 'sweep-ack')).toBe('dry-run');
    expect(autopilotRuleMode(enabled({ 'sweep-ack': 'off' }), 'sweep-ack')).toBe('off');
    expect(autopilotRuleMode(enabled({ 'sweep-ack': 'enforce' }), 'sweep-ack')).toBe('enforce');
  });

  it('a disabled autopilot records nothing and calls nothing', async () => {
    const ledger = new FakeLedger().job('job-release', 'done');
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({ releaseEligible: [releaseRow()] }),
      config: { enabled: false, rules: { 'sweep-ack': 'enforce' } },
      ledger: ledger.port,
      ops,
    });
    expect(result.enabled).toBe(false);
    expect(result.decisions).toBe(0);
    expect(ledger.decisions()).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('off records no decision and makes no call; dry-run records but makes no call', async () => {
    const offLedger = new FakeLedger().job('job-release', 'done');
    const off = fakeOps();
    const offResult = await runSilasAutopilot({
      digest: digest({ releaseEligible: [releaseRow()] }),
      config: enabled({ 'sweep-ack': 'off' }),
      ledger: offLedger.port,
      ops: off.ops,
    });
    expect(offResult.refusals).toBe(0);
    expect(offResult.decisions).toBe(0);
    expect(offLedger.decisions()).toEqual([]);
    expect(off.calls).toEqual([]);

    const dryLedger = new FakeLedger().job('job-release', 'done');
    const dry = fakeOps();
    const dryResult = await runSilasAutopilot({
      digest: digest({ releaseEligible: [releaseRow()] }),
      config: enabled(),
      ledger: dryLedger.port,
      ops: dry.ops,
    });
    expect(dryResult.decisions).toBe(1);
    expect(dryResult.enforced).toBe(0);
    expect(dry.calls).toEqual([]);
    expect(dryLedger.decisions()).toHaveLength(1);
    expect(dryLedger.decisions()[0]?.payload).toEqual({
      rule_id: 'sweep-ack',
      job: 'job-release',
      action: 'release-lane',
      would_call: {
        endpoint: 'POST /api/dispatch/release',
        job_id: 'job-release',
        rule_id: 'sweep-ack',
      },
      mode: 'dry-run',
    });
  });

  it('enforce performs exactly one call per decision, and reports the failure of one', async () => {
    const ledger = new FakeLedger().job('job-release', 'done');
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({ releaseEligible: [releaseRow()] }),
      config: enabled({ 'sweep-ack': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(1);
    expect(result.enforced).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('releaseLane');
    expect(calls[0]?.input).toEqual({ jobId: 'job-release', ruleId: 'sweep-ack' });
    expect(ledger.decisions()[0]?.payload).toMatchObject({ mode: 'enforce' });

    const failing = fakeOps({
      releaseLane: async () => {
        throw new Error('lane paused');
      },
    });
    const failingLedger = new FakeLedger().job('job-release', 'done');
    const failed = await runSilasAutopilot({
      digest: digest({ releaseEligible: [releaseRow()] }),
      config: enabled({ 'sweep-ack': 'enforce' }),
      ledger: failingLedger.port,
      ops: failing.ops,
    });
    // A failed call is not a receipt: the row stays for LLM Silas and the
    // pass reports the failure honestly.
    expect(failed.decisions).toBe(1);
    expect(failed.enforced).toBe(0);
    expect(failed.failures).toBe(1);
  });

  it('every enforce call carries the family as its rule id', async () => {
    const ledger = new FakeLedger()
      .job('job-release', 'done')
      .job('job-verdict', 'in-review')
      .job('job-verify', 'working');
    const { ops, calls } = fakeOps();
    await runSilasAutopilot({
      digest: digest({
        releaseEligible: [releaseRow()],
        verdictsAwaitingDirective: [verdictRow()],
        verificationFailures: [verificationRow()],
      }),
      config: enabled({ 'sweep-ack': 'enforce', 'verdict-rung-directive': 'enforce', 'verification-repair': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(calls.map((call) => [call.method, call.input['ruleId']])).toEqual([
      ['sendDirective', 'verdict-rung-directive'],
      ['sendDirective', 'verification-repair'],
      ['releaseLane', 'sweep-ack'],
    ]);
  });
});

// ------------------------------------------------------------------
// Family: verdict-rung-directive
// ------------------------------------------------------------------

describe('verdict-rung-directive (rule hit and rule miss)', () => {
  it('templates ONE directive per structured blocker and names the round', async () => {
    const ledger = new FakeLedger().job('job-verdict', 'in-review');
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({
        verdictsAwaitingDirective: [
          verdictRow({
            recurringBlockers: [
              blocker({ title: 'Blocker one', location: 'src/a.ts:1', recommendedFix: 'Do the first thing' }),
              blocker({
                title: 'Blocker two',
                location: 'src/b.ts:9',
                recommendedFix: 'Do the second thing',
                fingerprint: 'correctness::src/b.ts::blocker two',
              }),
            ],
          }),
        ],
      }),
      config: enabled({ 'verdict-rung-directive': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(1);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.method).toBe('sendDirective');
    expect(call?.input['ruleId']).toBe('verdict-rung-directive');
    expect(call?.input['sourceRoundId']).toBe('round-1');
    expect(call?.input['jobId']).toBe('job-verdict');
    const directive = String(call?.input['directive']);
    expect(directive).toContain('- Blocker one (src/a.ts:1)');
    expect(directive).toContain('Recommended fix: Do the first thing');
    expect(directive).toContain('- Blocker two (src/b.ts:9)');
    expect(directive).toContain('Recommended fix: Do the second thing');
  });

  it('refuses (leaving the row for LLM Silas) when a blocker has no recommended fix', async () => {
    const ledger = new FakeLedger().job('job-verdict', 'in-review');
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({
        verdictsAwaitingDirective: [verdictRow({ recurringBlockers: [blocker({ recommendedFix: undefined })] })],
      }),
      config: enabled({ 'verdict-rung-directive': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(0);
    expect(result.refusals).toBe(1);
    expect(calls).toEqual([]);
    expect(ledger.decisions()).toEqual([]);
  });

  it('refuses a blocker with no location, and a row with no blocker at all', async () => {
    for (const row of [
      verdictRow({ recurringBlockers: [blocker({ location: '  ' })] }),
      verdictRow({ recurringBlockers: [], blockerCount: 0 }),
    ]) {
      const ledger = new FakeLedger().job('job-verdict', 'in-review');
      const { ops, calls } = fakeOps();
      const result = await runSilasAutopilot({
        digest: digest({ verdictsAwaitingDirective: [row] }),
        config: enabled({ 'verdict-rung-directive': 'enforce' }),
        ledger: ledger.port,
        ops,
      });
      expect(result.decisions).toBe(0);
      expect(result.refusals).toBe(1);
      expect(calls).toEqual([]);
    }
  });

  it('refuses when the blockers do not uniformly name the directive rung', async () => {
    const ledger = new FakeLedger().job('job-verdict', 'in-review');
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({
        verdictsAwaitingDirective: [
          verdictRow({
            recurringBlockers: [
              blocker(),
              blocker({ advice: 'rebrief', fingerprint: 'correctness::src/c.ts::third' }),
            ],
          }),
        ],
      }),
      config: enabled({ 'verdict-rung-directive': 'enforce', 'verdict-rung-rebrief': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(0);
    expect(calls).toEqual([]);
    expect(result.refusals).toBe(1);
  });
});

// ------------------------------------------------------------------
// Family: verdict-rung-rebrief
// ------------------------------------------------------------------

describe('verdict-rung-rebrief (rule hit and rule miss)', () => {
  it('fires when every blocker names the rebrief rung, and templates the note', async () => {
    const ledger = new FakeLedger().job('job-verdict', 'in-review');
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({
        verdictsAwaitingDirective: [verdictRow({ recurringBlockers: [blocker({ advice: 'rebrief', consecutiveRounds: 3 })] })],
      }),
      config: enabled({ 'verdict-rung-rebrief': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(1);
    expect(calls[0]?.method).toBe('sendRebrief');
    expect(calls[0]?.input['ruleId']).toBe('verdict-rung-rebrief');
    expect(calls[0]?.input['sourceRoundId']).toBe('round-1');
    expect(String(calls[0]?.input['note'])).toContain('- The gate is skipped on retry');
  });

  it('does not fire for the directive rung (rule miss) — the other family owns the row', async () => {
    const ledger = new FakeLedger().job('job-verdict', 'in-review');
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({ verdictsAwaitingDirective: [verdictRow()] }),
      config: enabled({ 'verdict-rung-rebrief': 'enforce', 'verdict-rung-directive': 'off' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(0);
    expect(result.refusals).toBe(0);
    expect(calls).toEqual([]);
    expect(ledger.decisions()).toEqual([]);
  });

  it('leaves the row when the escalation rung is the row advice', async () => {
    const ledger = new FakeLedger().job('job-verdict', 'in-review');
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({
        verdictsAwaitingDirective: [verdictRow({ recurringBlockers: [blocker({ advice: 'escalate', consecutiveRounds: 4 })] })],
      }),
      config: enabled({
        'verdict-rung-directive': 'enforce',
        'verdict-rung-rebrief': 'enforce',
      }),
      ledger: ledger.port,
      ops,
    });
    // verdict-rung-escalate is deliberately not an autopilot family.
    expect(result.decisions).toBe(0);
    expect(calls).toEqual([]);
    expect(result.refusals).toBe(1);
  });
});

// ------------------------------------------------------------------
// Family: verification-repair
// ------------------------------------------------------------------

describe('verification-repair (rule hit and rule miss)', () => {
  it('carries the exact verification-failure fingerprint', async () => {
    const ledger = new FakeLedger().job('job-verify', 'working');
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({ verificationFailures: [verificationRow()] }),
      config: enabled({ 'verification-repair': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(1);
    expect(calls[0]?.input).toMatchObject({
      jobId: 'job-verify',
      ruleId: 'verification-repair',
      blockerFingerprint: 'verification-failure:unit@run-9',
    });
    expect(String(calls[0]?.input['directive'])).toContain('unit verification run FAILED');
  });

  it('refuses a null scope and a null run id (the #117 deferral)', async () => {
    for (const row of [verificationRow({ scope: null }), verificationRow({ runId: null })]) {
      const ledger = new FakeLedger().job('job-verify', 'working');
      const { ops, calls } = fakeOps();
      const result = await runSilasAutopilot({
        digest: digest({ verificationFailures: [row] }),
        config: enabled({ 'verification-repair': 'enforce' }),
        ledger: ledger.port,
        ops,
      });
      expect(result.decisions).toBe(0);
      expect(result.refusals).toBe(1);
      expect(calls).toEqual([]);
    }
  });

  it('refuses while a verification is already in flight on the lane', async () => {
    const ledger = new FakeLedger().job('job-verify', 'working');
    ledger.state.unsettledVerificationJobs.push('job-verify');
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({ verificationFailures: [verificationRow()] }),
      config: enabled({ 'verification-repair': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(0);
    expect(calls).toEqual([]);
  });
});

// ------------------------------------------------------------------
// Family: pr-conflict-rebase
// ------------------------------------------------------------------

describe('pr-conflict-rebase (rule hit and rule miss)', () => {
  it('sends ONE conflict-integration directive with pr-conflict:<head>', async () => {
    const ledger = new FakeLedger().job('job-conflict', 'working');
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({ conflictingPrs: [conflictRow()] }),
      config: enabled({ 'pr-conflict-rebase': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(1);
    expect(calls[0]?.input).toMatchObject({
      jobId: 'job-conflict',
      ruleId: 'pr-conflict-rebase',
      blockerFingerprint: `pr-conflict:${'b'.repeat(40)}`,
    });
    expect(String(calls[0]?.input['directive'])).toContain('Merge the PR base into your task branch');
  });

  it('refuses when the head sha is unknown (no fingerprint to land)', async () => {
    const ledger = new FakeLedger().job('job-conflict', 'working');
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({ conflictingPrs: [conflictRow({ headSha: null })] }),
      config: enabled({ 'pr-conflict-rebase': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(0);
    expect(result.refusals).toBe(1);
    expect(calls).toEqual([]);
  });

  it('refuses once a rebase directive for this head has already failed twice', async () => {
    const ledger = new FakeLedger().job('job-conflict', 'working');
    for (const requestId of ['req-1', 'req-2']) {
      ledger.record('job-conflict', 'silas.directive-sent', {
        request_id: requestId,
        blocker_fingerprint: `pr-conflict:${'b'.repeat(40)}`,
      });
      ledger.state.directives.set(requestId, { state: 'failed' });
    }
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({ conflictingPrs: [conflictRow()] }),
      config: enabled({ 'pr-conflict-rebase': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(0);
    expect(result.refusals).toBe(1);
    expect(calls).toEqual([]);

    // One failure still allows the second attempt.
    ledger.state.directives.set('req-2', { state: 'settled' });
    const retry = fakeOps();
    const second = await runSilasAutopilot({
      digest: digest({ conflictingPrs: [conflictRow()] }),
      config: enabled({ 'pr-conflict-rebase': 'enforce' }),
      ledger: ledger.port,
      ops: retry.ops,
    });
    expect(second.decisions).toBe(1);
  });
});

// ------------------------------------------------------------------
// Family: clean-abort-service-restart
// ------------------------------------------------------------------

describe('clean-abort-service-restart (rule hit and rule miss)', () => {
  it('re-arms the proved head of the clean abort', async () => {
    const sha = 'c'.repeat(40);
    const ledger = new FakeLedger().job('job-abort', 'in-review').round('round-abort', 'job-abort', sha);
    ledger.record('job-abort', 'job.delivered', { sha });
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({
        prWithoutReview: [prWithoutReviewRow({ jobId: 'job-abort', cleanAbort: { roundId: 'round-abort', ruleId: 'clean-abort-service-restart' } })],
      }),
      config: enabled({ 'clean-abort-service-restart': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(1);
    expect(calls[0]?.method).toBe('triggerReview');
    expect(calls[0]?.input).toEqual({
      jobId: 'job-abort',
      ruleId: 'clean-abort-service-restart',
      sourceRoundId: 'round-abort',
    });
  });

  it('refuses when the delivered head moved since the aborted round (stale re-arm)', async () => {
    const ledger = new FakeLedger().job('job-abort', 'in-review').round('round-abort', 'job-abort', 'c'.repeat(40));
    ledger.record('job-abort', 'job.delivered', { sha: 'd'.repeat(40) });
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({
        prWithoutReview: [prWithoutReviewRow({ jobId: 'job-abort', cleanAbort: { roundId: 'round-abort', ruleId: 'clean-abort-service-restart' } })],
      }),
      config: enabled({ 'clean-abort-service-restart': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(0);
    expect(result.refusals).toBe(1);
    expect(calls).toEqual([]);
  });

  it('refuses when the round is not this job’s, or the job is not review-eligible', async () => {
    const foreign = new FakeLedger().job('job-abort', 'in-review').round('round-abort', 'other-job', 'c'.repeat(40));
    foreign.record('job-abort', 'job.delivered', { sha: 'c'.repeat(40) });
    const terminal = new FakeLedger().job('job-abort', 'blocked');
    for (const ledger of [foreign, terminal]) {
      const { ops, calls } = fakeOps();
      const result = await runSilasAutopilot({
        digest: digest({
          prWithoutReview: [prWithoutReviewRow({ jobId: 'job-abort', cleanAbort: { roundId: 'round-abort', ruleId: 'clean-abort-service-restart' } })],
        }),
        config: enabled({ 'clean-abort-service-restart': 'enforce' }),
        ledger: ledger.port,
        ops,
      });
      expect(result.decisions).toBe(0);
      expect(result.refusals).toBe(1);
      expect(calls).toEqual([]);
    }
  });
});

// ------------------------------------------------------------------
// Family: pr-review-trigger
// ------------------------------------------------------------------

describe('pr-review-trigger (rule hit and rule miss)', () => {
  it('arms the review only when ci-green sits on the delivered head', async () => {
    const sha = 'e'.repeat(40);
    const ledger = new FakeLedger().job('job-review', 'delivered');
    ledger.record('job-review', 'job.delivered', { sha });
    ledger.record('job-review', 'github.ci-green', { sha });
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({ prWithoutReview: [prWithoutReviewRow()] }),
      config: enabled({ 'pr-review-trigger': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(1);
    expect(calls[0]?.method).toBe('triggerReview');
    expect(calls[0]?.input).toEqual({ jobId: 'job-review', ruleId: 'pr-review-trigger' });
  });

  it('refuses when the green belongs to an older head', async () => {
    const ledger = new FakeLedger().job('job-review', 'delivered');
    ledger.record('job-review', 'job.delivered', { sha: 'e'.repeat(40) });
    ledger.record('job-review', 'github.ci-green', { sha: 'f'.repeat(40) });
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({ prWithoutReview: [prWithoutReviewRow()] }),
      config: enabled({ 'pr-review-trigger': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(0);
    expect(result.refusals).toBe(1);
    expect(calls).toEqual([]);
  });

  it('refuses when there is no ci-green observation at all', async () => {
    const ledger = new FakeLedger().job('job-review', 'delivered');
    ledger.record('job-review', 'job.delivered', { sha: 'e'.repeat(40) });
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({ prWithoutReview: [prWithoutReviewRow()] }),
      config: enabled({ 'pr-review-trigger': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(0);
    expect(calls).toEqual([]);
  });

  it('never claims a clean-abort row (the re-arm rule owns it)', async () => {
    const ledger = new FakeLedger().job('job-review', 'in-review');
    ledger.record('job-review', 'job.delivered', { sha: 'e'.repeat(40) });
    ledger.record('job-review', 'github.ci-green', { sha: 'e'.repeat(40) });
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({
        prWithoutReview: [
          prWithoutReviewRow({ cleanAbort: { roundId: 'round-abort', ruleId: 'clean-abort-service-restart' } }),
        ],
      }),
      // Only pr-review-trigger is enabled: the clean-abort row must not be
      // claimed by it, and the disabled family records nothing.
      config: enabled({ 'pr-review-trigger': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(0);
    expect(calls).toEqual([]);
  });
});

// ------------------------------------------------------------------
// Family: sweep-ack
// ------------------------------------------------------------------

describe('sweep-ack (rule hit and rule miss)', () => {
  it('releases a terminal job’s lane', async () => {
    const ledger = new FakeLedger().job('job-release', 'done');
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({ releaseEligible: [releaseRow()] }),
      config: enabled({ 'sweep-ack': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(1);
    expect(calls[0]?.method).toBe('releaseLane');
    expect(calls[0]?.input).toEqual({ jobId: 'job-release', ruleId: 'sweep-ack' });
  });

  it('refuses a lane whose job is not terminal any more', async () => {
    const ledger = new FakeLedger().job('job-release', 'working');
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({ releaseEligible: [releaseRow({ status: 'merged' })] }),
      config: enabled({ 'sweep-ack': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(0);
    expect(result.refusals).toBe(1);
    expect(calls).toEqual([]);
  });
});

// ------------------------------------------------------------------
// Family: delivered-pr-register
// ------------------------------------------------------------------

describe('delivered-pr-register (rule hit and rule miss)', () => {
  it('registers the exactly-one open PR for the delivered branch', async () => {
    const ledger = new FakeLedger().job('job-delivered', 'delivered');
    const { ops, calls } = fakeOps({
      listOpenPrsForHead: async () => [{ number: 12, url: 'https://github.com/mssoka/gru-command/pull/12' }],
    });
    const result = await runSilasAutopilot({
      digest: digest({ deliveredWithoutPr: [deliveredRow()] }),
      config: enabled({ 'delivered-pr-register': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(1);
    expect(calls[0]?.method).toBe('listOpenPrsForHead');
    expect(calls[0]?.input).toEqual({ repoPath: '/tmp/lane/job-delivered', branch: 'gru/job-delivered' });
    expect(calls[1]?.method).toBe('registerPr');
    expect(calls[1]?.input).toEqual({
      jobId: 'job-delivered',
      url: 'https://github.com/mssoka/gru-command/pull/12',
      ruleId: 'delivered-pr-register',
    });
  });

  it('refuses zero and several PRs (a real exception — Silas decides)', async () => {
    for (const pulls of [
      [],
      [
        { number: 1, url: 'https://github.com/mssoka/gru-command/pull/1' },
        { number: 2, url: 'https://github.com/mssoka/gru-command/pull/2' },
      ],
    ]) {
      const ledger = new FakeLedger().job('job-delivered', 'delivered');
      const { ops, calls } = fakeOps({ listOpenPrsForHead: async () => pulls });
      const result = await runSilasAutopilot({
        digest: digest({ deliveredWithoutPr: [deliveredRow()] }),
        config: enabled({ 'delivered-pr-register': 'enforce' }),
        ledger: ledger.port,
        ops,
      });
      expect(result.decisions).toBe(0);
      expect(result.refusals).toBe(1);
      expect(calls.map((call) => call.method)).toEqual(['listOpenPrsForHead']);
    }
  });

  it('refuses a row with no branch or no lane path (nothing to ask GitHub about)', async () => {
    for (const row of [deliveredRow({ branch: null }), deliveredRow({ lanePath: null })]) {
      const ledger = new FakeLedger().job('job-delivered', 'delivered');
      const { ops, calls } = fakeOps();
      const result = await runSilasAutopilot({
        digest: digest({ deliveredWithoutPr: [row] }),
        config: enabled({ 'delivered-pr-register': 'enforce' }),
        ledger: ledger.port,
        ops,
      });
      expect(result.decisions).toBe(0);
      expect(calls).toEqual([]);
    }
  });

  it('refuses once the job already carries a PR', async () => {
    const ledger = new FakeLedger().job('job-delivered', 'in-review', 'https://github.com/mssoka/gru-command/pull/3');
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({ deliveredWithoutPr: [deliveredRow()] }),
      config: enabled({ 'delivered-pr-register': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(0);
    expect(calls).toEqual([]);
  });
});

// ------------------------------------------------------------------
// Ownership fences
// ------------------------------------------------------------------

describe('ownership fences leave the row for LLM Silas', () => {
  it('refuses while a live directive, a pending re-brief or a recovery hold owns the lane', async () => {
    for (const fence of ['liveDirectiveJobs', 'pendingRebriefJobs', 'recoveryHoldJobs'] as const) {
      const ledger = new FakeLedger().job('job-verdict', 'in-review');
      ledger.state[fence].push('job-verdict');
      const { ops, calls } = fakeOps();
      const result = await runSilasAutopilot({
        digest: digest({ verdictsAwaitingDirective: [verdictRow()] }),
        config: enabled({ 'verdict-rung-directive': 'enforce' }),
        ledger: ledger.port,
        ops,
      });
      expect(result.decisions, fence).toBe(0);
      expect(result.refusals, fence).toBe(1);
      expect(calls, fence).toEqual([]);
    }
  });

  it('refuses on a terminal lane', async () => {
    const ledger = new FakeLedger().job('job-conflict', 'merged');
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({ conflictingPrs: [conflictRow()] }),
      config: enabled({ 'pr-conflict-rebase': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(0);
    expect(calls).toEqual([]);
  });
});

// ------------------------------------------------------------------
// The ops binding's receipts
// ------------------------------------------------------------------

describe('the production ops binding writes receipts that carry rule_id and source', () => {
  const tempLedger = (): LedgerApi => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-ops-'));
    dirs.push(dir);
    return new LedgerApi(new LedgerDb(dir).handle, {});
  };

  it('silas.pr-registered carries the rule id and the autopilot source', async () => {
    const ledger = tempLedger();
    const job = ledger.addJob({ id: 'job-pr', repo: 'gru-command', title: 'pr', baseBranch: 'main', briefing: 'x' });
    const ops = createSilasAutopilotOps({
      ledger,
      wave: { clearLaneForWriter: async () => undefined, requestReview: async () => Promise.reject(new Error('unused')) },
      registry: {} as never,
      worktrees: {} as never,
      dispatch: {
        recordPr: (jobId, url) => {
          expect(jobId).toBe(job.id);
          return { prUrl: url };
        },
      },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });    await ops.registerPr({ jobId: job.id, url: 'https://github.com/mssoka/gru-command/pull/9', ruleId: 'delivered-pr-register' });
    const receipt = ledger.latestJobEvent(job.id, 'silas.pr-registered');
    expect(receipt?.payload).toMatchObject({
      url: 'https://github.com/mssoka/gru-command/pull/9',
      rule_id: 'delivered-pr-register',
      source: AUTOPILOT_SOURCE,
    });
  });

  it('silas.lane-released carries the rule id and the autopilot source, and a paused release mints nothing', async () => {
    const ledger = tempLedger();
    const job = ledger.addJob({ id: 'job-lane', repo: 'gru-command', title: 'lane', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'done');
    let swept = false;
    const ops = createSilasAutopilotOps({
      ledger,
      wave: { clearLaneForWriter: async () => undefined, requestReview: async () => Promise.reject(new Error('unused')) },
      registry: {} as never,
      worktrees: {
        listWorktrees: () => [{ id: job.id, kind: 'job', status: 'active', branch: 'gru/lane', path: '/tmp/lane' }],
        release: async () => {
          swept = true;
          return { status: 'swept', preserved: null, branch: 'none', freshHead: 'a'.repeat(40) };
        },
      } as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await ops.releaseLane({ jobId: job.id, ruleId: 'sweep-ack' });
    expect(swept).toBe(true);
    expect(ledger.latestJobEvent(job.id, 'silas.lane-released')?.payload).toMatchObject({
      rule_id: 'sweep-ack',
      source: AUTOPILOT_SOURCE,
    });

    const pausedLedger = tempLedger();
    const pausedJob = pausedLedger.addJob({ id: 'job-paused', repo: 'gru-command', title: 'p', baseBranch: 'main', briefing: 'x' });
    pausedLedger.setJobStatus(pausedJob.id, 'working');
    pausedLedger.setJobStatus(pausedJob.id, 'done');
    const pausedOps = createSilasAutopilotOps({
      ledger: pausedLedger,
      wave: { clearLaneForWriter: async () => undefined, requestReview: async () => Promise.reject(new Error('unused')) },
      registry: {} as never,
      worktrees: {
        listWorktrees: () => [{ id: pausedJob.id, kind: 'job', status: 'active', branch: 'gru/p', path: '/tmp/p' }],
        release: async () => ({ status: 'paused', processes: [], preserved: null, note: 'a process is using the tree' }),
      } as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await expect(pausedOps.releaseLane({ jobId: pausedJob.id, ruleId: 'sweep-ack' })).rejects.toThrow(/paused/);
    expect(pausedLedger.latestJobEvent(pausedJob.id, 'silas.lane-released')).toBeNull();
  });

  it('refuses a non-terminal lane and a live child worker before releasing anything', async () => {
    const ledger = tempLedger();
    const job = ledger.addJob({ id: 'job-live', repo: 'gru-command', title: 'live', baseBranch: 'main', briefing: 'x' });
    const release = vi.fn();
    const ops = createSilasAutopilotOps({
      ledger,
      wave: { clearLaneForWriter: async () => undefined, requestReview: async () => Promise.reject(new Error('unused')) },
      registry: {} as never,
      worktrees: { listWorktrees: () => [], release } as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await expect(ops.releaseLane({ jobId: job.id, ruleId: 'sweep-ack' })).rejects.toThrow(/only terminal lanes/);
    expect(release).not.toHaveBeenCalled();
  });

  it('resolves the pull list through the gh port from the lane remote, never a shell call', async () => {
    const ledger = tempLedger();
    const asked: { head: string }[] = [];
    const ops = createSilasAutopilotOps({
      ledger,
      wave: { clearLaneForWriter: async () => undefined, requestReview: async () => Promise.reject(new Error('unused')) },
      registry: {} as never,
      worktrees: {} as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: {
        listPullsForHead: async (input) => {
          asked.push({ head: input.head });
          return [
            { number: 4, headRef: 'gru/lane', headSha: null, state: 'open', merged: false, mergeableState: null, mergeCommitSha: null, url: 'https://github.com/mssoka/gru-command/pull/4' },
            { number: 5, headRef: 'gru/lane', headSha: null, state: 'closed', merged: false, mergeableState: null, mergeCommitSha: null, url: 'https://github.com/mssoka/gru-command/pull/5' },
          ];
        },
      },
      resolveRemote: () => ({ host: 'github.com', owner: 'mssoka', repo: 'gru-command' }),
    });
    await expect(ops.listOpenPrsForHead({ repoPath: '/tmp/lane', branch: 'gru/lane' })).resolves.toEqual([
      { number: 4, url: 'https://github.com/mssoka/gru-command/pull/4' },
    ]);
    expect(asked).toEqual([{ head: 'gru/lane' }]);
  });
});
