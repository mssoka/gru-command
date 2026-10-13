import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { createSilasAutopilotHook } from '../src/dispatch/silas-autopilot-pass.js';
import { ReviewInProgressError } from '../src/dispatch/perkins.js';
import { SilasDriver } from '../src/dispatch/silas-driver.js';
import type { AgentCapabilities, AgentHandle } from '../src/runtime/types.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import type { SilasAutopilotConfig } from '../src/config.js';
import {
  computeSilasDigest,
  consolidatedBlockersFor,
  type ConflictingPrRow,
  type DeliveredWithoutPrRow,
  type DigestRecurringBlocker,
  type PrWithoutReviewRow,
  type ReleaseEligibleRow,
  type SilasOpsDigest,
  type VerdictAwaitingDirectiveRow,
  type VerificationFailureRow,
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
  /** Active decision rows (issue #218): (subject, signal, basis) coverage. */
  heldDecisions: { id: string; subject: string; signal: string; basis: string | null }[];
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
    heldDecisions: [],
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

  coveringDecision(opts: { subject: string; signal: string; basis: string }): { id: string } | null {
    const held = this.state.heldDecisions.find(
      (decision) =>
        decision.subject === opts.subject &&
        decision.signal === opts.signal &&
        (decision.basis === null || decision.basis === opts.basis),
    );
    return held === undefined ? null : { id: held.id };
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
    // Issue #243 H4: the arm binds the sha the green proved, so the awaited
    // review setup cannot re-resolve a newer live PR head.
    expect(calls[0]?.input).toEqual({
      jobId: 'job-review',
      ruleId: 'pr-review-trigger',
      targetRef: sha,
      boundDeliveredSha: sha,
    });
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
      wave: { assertWriterAdmissible: () => {}, clearLaneForWriter: async () => undefined, requestReview: async () => Promise.reject(new Error('unused')) },
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
      wave: { assertWriterAdmissible: () => {}, clearLaneForWriter: async () => undefined, requestReview: async () => Promise.reject(new Error('unused')) },
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
      wave: { assertWriterAdmissible: () => {}, clearLaneForWriter: async () => undefined, requestReview: async () => Promise.reject(new Error('unused')) },
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
      wave: { assertWriterAdmissible: () => {}, clearLaneForWriter: async () => undefined, requestReview: async () => Promise.reject(new Error('unused')) },
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
      wave: { assertWriterAdmissible: () => {}, clearLaneForWriter: async () => undefined, requestReview: async () => Promise.reject(new Error('unused')) },
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
      resolveRemote: () => ({ host: 'github.com', owner: 'example-org', repo: 'gru-command' }),
    });
    await expect(ops.listOpenPrsForHead({ repoPath: '/tmp/lane', branch: 'gru/lane' })).resolves.toEqual([
      { number: 4, url: 'https://github.com/mssoka/gru-command/pull/4' },
    ]);
    expect(asked).toEqual([{ head: 'gru/lane' }]);
  });
});

// ------------------------------------------------------------------
// Fix-round regressions (issue #243 review H1/M1/M2/M4/M5/H5/M6)
// ------------------------------------------------------------------

describe('pass budget, planner side effects and ownership fences', () => {
  it('off runs NO planner: an off delivered-pr-register makes no GitHub lookup (H5)', async () => {
    const ledger = new FakeLedger().job('job-delivered', 'delivered');
    const { ops, calls } = fakeOps({
      listOpenPrsForHead: async () => {
        throw new Error('the off family must not reach GitHub');
      },
    });
    const result = await runSilasAutopilot({
      digest: digest({ deliveredWithoutPr: [deliveredRow()] }),
      config: enabled({ 'delivered-pr-register': 'off' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(0);
    expect(calls).toEqual([]);
  });

  it('the budget is applied before planning: a surplus row performs no lookup (M6)', async () => {
    const rows = Array.from({ length: 25 }, (_, index) => deliveredRow({ jobId: `job-${index}` }));
    const ledger = new FakeLedger();
    for (const row of rows) ledger.job(row.jobId, 'delivered');
    let lookups = 0;
    const { ops } = fakeOps({
      listOpenPrsForHead: async () => {
        lookups += 1;
        return [{ number: 1, url: 'https://github.com/mssoka/gru-command/pull/1' }];
      },
    });
    const result = await runSilasAutopilot({
      digest: digest({ deliveredWithoutPr: rows }),
      config: enabled({ 'delivered-pr-register': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(20);
    expect(lookups).toBe(20);
  });

  it('carries the verdict blocker_fingerprint on the directive (M4)', async () => {
    const ledger = new FakeLedger().job('job-verdict', 'in-review');
    const { ops, calls } = fakeOps();
    await runSilasAutopilot({
      digest: digest({ verdictsAwaitingDirective: [verdictRow()] }),
      config: enabled({ 'verdict-rung-directive': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(calls[0]?.input).toMatchObject({ blockerFingerprint: 'verdict:round-1' });
    expect(ledger.decisions()[0]?.payload).toMatchObject({
      would_call: { blocker_fingerprint: 'verdict:round-1' },
    });
  });

  it('refuses a verdict family while a verification is in flight on the lane (M2)', async () => {
    for (const rules of [
      { 'verdict-rung-directive': 'enforce' },
      { 'verdict-rung-rebrief': 'enforce' },
    ] as SilasAutopilotConfig['rules'][]) {
      const ledger = new FakeLedger().job('job-verdict', 'in-review');
      ledger.state.unsettledVerificationJobs.push('job-verdict');
      const { ops, calls } = fakeOps();
      const row = Object.hasOwn(rules, 'verdict-rung-rebrief')
        ? verdictRow({ recurringBlockers: [blocker({ advice: 'rebrief' })] })
        : verdictRow();
      const result = await runSilasAutopilot({
        digest: digest({ verdictsAwaitingDirective: [row] }),
        config: enabled(rules),
        ledger: ledger.port,
        ops,
      });
      expect(result.decisions).toBe(0);
      expect(result.refusals).toBe(1);
      expect(calls).toEqual([]);
    }
  });

  it('refuses a stale PR registration when a concurrent writer registered during the lookup (M5)', async () => {
    const ledger = new FakeLedger().job('job-delivered', 'delivered');
    const { ops, calls } = fakeOps({
      listOpenPrsForHead: async () => {
        // Another writer wins the network window.
        ledger.state.jobs.get('job-delivered')!.prUrl = 'https://github.com/mssoka/gru-command/pull/99';
        return [{ number: 12, url: 'https://github.com/mssoka/gru-command/pull/12' }];
      },
    });
    const result = await runSilasAutopilot({
      digest: digest({ deliveredWithoutPr: [deliveredRow()] }),
      config: enabled({ 'delivered-pr-register': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(0);
    expect(result.refusals).toBe(1);
    expect(calls.map((call) => call.method)).toEqual(['listOpenPrsForHead']);
  });
});

describe('decision-memory holds (#218) fence the autopilot (issue #243 M1)', () => {
  it('refuses pr-conflict-rebase when an active hold covers the conflicting head', async () => {
    const head = 'b'.repeat(40);
    const ledger = new FakeLedger().job('job-conflict', 'working');
    ledger.state.heldDecisions.push({
      id: 'decision-1',
      subject: 'job:job-conflict',
      signal: 'pr-conflict',
      basis: `pr-conflict:${head}`,
    });
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
  });

  it('refuses a verdict family when an active hold covers the consumed round', async () => {
    const ledger = new FakeLedger().job('job-verdict', 'in-review');
    ledger.state.heldDecisions.push({
      id: 'decision-2',
      subject: 'job:job-verdict',
      signal: 'verdict-rung-directive',
      basis: 'verdict:round-1',
    });
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({ verdictsAwaitingDirective: [verdictRow()] }),
      config: enabled({ 'verdict-rung-directive': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(0);
    expect(result.refusals).toBe(1);
    expect(calls).toEqual([]);
  });

  it('does not defer for a hold that covers another signal', async () => {
    const ledger = new FakeLedger().job('job-verdict', 'in-review');
    ledger.state.heldDecisions.push({
      id: 'decision-3',
      subject: 'job:job-verdict',
      signal: 'pr-conflict',
      basis: null,
    });
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({ verdictsAwaitingDirective: [verdictRow()] }),
      config: enabled({ 'verdict-rung-directive': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(1);
    expect(calls).toHaveLength(1);
  });
});

// ------------------------------------------------------------------
// Production ops composition (issue #243 H1/H2/M3/M9/M10)
// ------------------------------------------------------------------

const FAKE_CAPS: AgentCapabilities = {
  streaming: true,
  steer: 'native',
  resume: 'file',
  images: false,
  thinking: false,
  thinkingLevelControl: false,
  followUp: false,
};

function idleHandle(id: string, opts: { fail?: Error } = {}): AgentHandle {
  return {
    id,
    role: 'minion',
    sessionFile: null,
    async prompt() {
      if (opts.fail !== undefined) throw opts.fail;
    },
    capabilities: FAKE_CAPS,
    async steer() {},
    async followUp() {},
    subscribe() {
      return () => {};
    },
    health() {
      return { state: 'idle' as const, lastActivity: null, sessionFile: null };
    },
    async dispose() {},
  } satisfies AgentHandle;
}

function newRealLedger(): LedgerApi {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-ops-real-'));
  dirs.push(dir);
  return new LedgerApi(new LedgerDb(dir).handle, {});
}

const repos: FixtureRepo[] = [];
afterEach(() => {
  while (repos.length > 0) repos.pop()!.cleanup();
});

function waveStub(overrides: { assertWriterAdmissible?: (jobId: string) => void } = {}) {
  return {
    assertWriterAdmissible: overrides.assertWriterAdmissible ?? ((): void => {}),
    clearLaneForWriter: async () => undefined,
    requestReview: async (): Promise<never> => {
      throw new Error('unused');
    },
  };
}

describe('the production ops binding re-proves writer admission (issue #243 H1)', () => {
  it('refuses a directive on a lane a live review owns — no intent, no supersession', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-h1', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'in-review');
    let superseded = false;
    const ops = createSilasAutopilotOps({
      ledger,
      wave: {
        assertWriterAdmissible: () => {
          throw new ReviewInProgressError(job.id, ['round-live']);
        },
        clearLaneForWriter: async () => {
          superseded = true;
          return undefined;
        },
        requestReview: async (): Promise<never> => {
          throw new Error('unused');
        },
      },
      registry: {} as never,
      worktrees: {} as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await expect(
      ops.sendDirective({ jobId: job.id, directive: 'fix', ruleId: 'verdict-rung-directive', sourceRoundId: 'round-live' }),
    ).rejects.toThrow(/live review owns this lane/);
    expect(superseded).toBe(false);
    expect(ledger.listPendingDirectives({ jobId: job.id })).toHaveLength(0);
  });

  it('refuses a re-brief on a lane a live review owns — no supersession', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-h1b', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'in-review');
    let superseded = false;
    const ops = createSilasAutopilotOps({
      ledger,
      wave: {
        assertWriterAdmissible: () => {
          throw new ReviewInProgressError(job.id, ['round-live']);
        },
        clearLaneForWriter: async () => {
          superseded = true;
          return undefined;
        },
        requestReview: async (): Promise<never> => {
          throw new Error('unused');
        },
      },
      registry: {} as never,
      worktrees: {} as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await expect(
      ops.sendRebrief({ jobId: job.id, note: 'try again', ruleId: 'verdict-rung-rebrief', sourceRoundId: 'round-live' }),
    ).rejects.toThrow(/live review owns this lane/);
    expect(superseded).toBe(false);
    expect(ledger.listPendingRebriefs({ jobId: job.id })).toHaveLength(0);
  });
});

describe('the production directive settlement keeps unknown admission live (issue #243 H2/M9)', () => {
  it('keeps a directive live (reconcile, never failed) when admission is unknown', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-h2', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    ledger.registerAgent({ id: 'min-h2', role: 'minion', jobId: job.id });
    const handle = idleHandle('min-h2', { fail: new Error('transport dropped after the prompt call') });
    const ops = createSilasAutopilotOps({
      ledger,
      wave: waveStub(),
      registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
      worktrees: { listWorktrees: () => [] } as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
      retrySettlement: async () => 'exhausted',
    });
    await ops.sendDirective({
      jobId: job.id,
      directive: 'fix it',
      ruleId: 'verdict-rung-directive',
      sourceRoundId: 'round-h2',
    });
    await vi.waitFor(() => expect(ledger.listPendingDirectives({ jobId: job.id })[0]?.attempts).toBeGreaterThan(0));
    const intent = ledger.listPendingDirectives({ jobId: job.id })[0]!;
    expect(intent.state).not.toBe('failed');
    expect(intent.failReason).toMatch(/^reconcile:/u);
    expect(ledger.latestJobEvent(job.id, 'silas.directive-failed')).toBeNull();
  });

  it('settles a delivered directive on the real ledger with rule_id, source and revision', async () => {
    const repo = makeFixtureRepo();
    repos.push(repo);
    const laneRoot = mkdtempSync(join(tmpdir(), 'autopilot-lanes-'));
    dirs.push(laneRoot);
    const lanes = new InMemoryWorktreePort(laneRoot);
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-m9', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    await lanes.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    ledger.registerAgent({ id: 'min-m9', role: 'minion', jobId: job.id });
    const handle = idleHandle('min-m9');
    const ops = createSilasAutopilotOps({
      ledger,
      wave: waveStub(),
      registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
      worktrees: lanes,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await ops.sendDirective({
      jobId: job.id,
      directive: 'fix it',
      ruleId: 'verdict-rung-directive',
      sourceRoundId: 'round-m9',
      blockerFingerprint: 'verdict:round-m9',
    });
    await vi.waitFor(() => expect(ledger.latestJobEvent(job.id, 'silas.directive-settled')).not.toBeNull());
    expect(ledger.latestJobEvent(job.id, 'silas.directive-sent')?.payload).toMatchObject({
      rule_id: 'verdict-rung-directive',
      source: AUTOPILOT_SOURCE,
      blocker_fingerprint: 'verdict:round-m9',
      source_round_id: 'round-m9',
    });
    expect(ledger.latestJobEvent(job.id, 'job.delivered')?.payload).toMatchObject({
      source: 'silas-directive',
      request_id: ledger.listPendingDirectives({ jobId: job.id })[0]?.requestId,
    });
    expect(ledger.listPendingDirectives({ jobId: job.id })[0]?.state).toBe('settled');
  });

  it('carries a pending material amendment into the turn and stamps its revision (H3)', async () => {
    const repo = makeFixtureRepo();
    repos.push(repo);
    const laneRoot = mkdtempSync(join(tmpdir(), 'autopilot-lanes-'));
    dirs.push(laneRoot);
    const lanes = new InMemoryWorktreePort(laneRoot);
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-h3', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'original' });
    ledger.setJobStatus(job.id, 'working');
    await lanes.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    ledger.registerAgent({ id: 'min-h3', role: 'minion', jobId: job.id });
    const prompted: string[] = [];
    const handle = {
      ...idleHandle('min-h3'),
      async prompt(text: string) {
        prompted.push(text);
      },
    } satisfies AgentHandle;
    const amendment = ledger.addJobAmendment({
      jobId: job.id,
      body: 'ALSO: fix the retry path before you push.',
      effect: 'material',
      approval: { by: 'owner', reference: 'fixture-approval-h3' },
      expectedContractSha256: ledger.effectiveContract(job.id)!.contractSha256,
    });
    expect(amendment.status).toBe('accepted');
    const ops = createSilasAutopilotOps({
      ledger,
      wave: waveStub(),
      registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
      worktrees: lanes,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await ops.sendDirective({
      jobId: job.id,
      directive: 'fix the blocker',
      ruleId: 'verdict-rung-directive',
      sourceRoundId: 'round-h3',
    });
    await vi.waitFor(() => expect(ledger.latestJobEvent(job.id, 'silas.directive-settled')).not.toBeNull());
    // The approved amendment body travels ONCE with the directive turn…
    expect(prompted.join('\n')).toContain('ALSO: fix the retry path before you push.');
    // …and the delivery that settles the turn stamps that exact revision.
    expect(ledger.latestJobEvent(job.id, 'job.delivered')?.payload).toMatchObject({ work_revision: 1 });
  });
});

describe('the production re-brief finalization carries autopilot provenance (issue #243 M3/M10)', () => {
  it('replays rule_id and source onto the durable silas.rebrief receipt', async () => {
    const repo = makeFixtureRepo();
    repos.push(repo);
    const laneRoot = mkdtempSync(join(tmpdir(), 'autopilot-lanes-'));
    dirs.push(laneRoot);
    const lanes = new InMemoryWorktreePort(laneRoot);
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-m10', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    await lanes.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    const handle = idleHandle('fresh-m10');
    const ops = createSilasAutopilotOps({
      ledger,
      wave: waveStub(),
      registry: { getHandle: () => null, spawn: async () => handle, disposeHandle: async () => {} },
      worktrees: lanes,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await ops.sendRebrief({
      jobId: job.id,
      note: 'same blocker three rounds; change the approach',
      ruleId: 'verdict-rung-rebrief',
      sourceRoundId: 'round-m10',
    });
    await vi.waitFor(() => expect(ledger.latestJobEvent(job.id, 'silas.rebrief')).not.toBeNull());
    expect(ledger.latestJobEvent(job.id, 'silas.rebrief')?.payload).toMatchObject({
      rule_id: 'verdict-rung-rebrief',
      source_round_id: 'round-m10',
      source: AUTOPILOT_SOURCE,
    });
    expect(ledger.listPendingRebriefs({ jobId: job.id })).toHaveLength(0);
  });
});

// ------------------------------------------------------------------
// Verification gaps M7/M8 (issue #243)
// ------------------------------------------------------------------

describe('the round-report extractor feeds the autopilot (issue #243 M8)', () => {
  it('a recommended_fix in the consolidated report reaches the templated directive', async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), 'autopilot-artifacts-'));
    dirs.push(artifactDir);
    writeFileSync(
      join(artifactDir, 'consolidated.json'),
      JSON.stringify({
        findings: [
          {
            category: 'correctness',
            title: 'The gate is skipped on retry',
            location: 'src/dispatch/gate.ts:42',
            severity: 'blocker',
            recommended_fix: 'Re-check the guard before the retry path',
          },
        ],
      }),
    );
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-m8', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'in-review');
    const round = ledger.addRound({ jobId: job.id, targetRef: 'a'.repeat(40) });
    ledger.appendCustomEvent({
      kind: 'round.perkins-review',
      roundId: round.id,
      jobId: job.id,
      payload: { artifactDirectory: artifactDir },
    });
    ledger.setRoundStatus(round.id, 'live');
    ledger.setRoundVerdict(round.id, 'changes-requested');
    const measured = await computeSilasDigest({
      ledger,
      config: { stallThresholdMs: 1_800_000, directiveAt: 2, rebriefAt: 3, escalateAt: 4 },
      blockersForRound: consolidatedBlockersFor(ledger),
      trigger: 'sweep',
      now: () => 0,
    });
    expect(measured.verdictsAwaitingDirective[0]?.recurringBlockers[0]?.recommendedFix).toBe(
      'Re-check the guard before the retry path',
    );
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: measured,
      config: enabled({ 'verdict-rung-directive': 'enforce' }),
      ledger: ledger as unknown as AutopilotLedger,
      ops,
    });
    expect(result.decisions).toBe(1);
    const directive = String(calls.find((call) => call.method === 'sendDirective')?.input['directive']);
    expect(directive).toContain('Recommended fix: Re-check the guard before the retry path');
  });
});

describe('the production autopilot hook runs inside a driver trigger (issue #243 M7)', () => {
  it('a driver trigger executes createSilasAutopilotHook before any model wake', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-m7', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'done');
    const released: string[] = [];
    const hook = createSilasAutopilotHook({
      ledger: ledger as unknown as AutopilotLedger,
      config: { enabled: true, rules: { 'sweep-ack': 'enforce' } },
      ops: {
        listOpenPrsForHead: async () => [],
        registerPr: async () => {},
        triggerReview: async () => {},
        sendDirective: async () => {},
        sendRebrief: async () => {},
        releaseLane: async ({ jobId: releasedJobId }) => {
          released.push(releasedJobId);
        },
      },
      digest: async () => digest({ releaseEligible: [releaseRow({ jobId: job.id })] }),
    });
    let slotWakes = 0;
    const driver = new SilasDriver({
      slot: {
        ensure: async () => {
          slotWakes += 1;
          throw new Error('no model wake in this composition test');
        },
        viewFor: () => null,
      } as never,
      ledger: ledger as never,
      worktrees: { listWorktrees: () => [] } as never,
      ops: { baseUrl: 'http://127.0.0.1:0', configPath: 'unused' },
      config: {
        enabled: true,
        sweepIntervalMs: 60_000,
        pollIntervalMs: 0,
        directiveAt: 2,
        rebriefAt: 3,
        escalateAt: 4,
        stallThresholdMs: 1_800_000,
        unchangedRewakeMs: 21_600_000,
        autopilot: { enabled: true, rules: { 'sweep-ack': 'enforce' } },
      },
      skills: [],
      now: () => 0,
      setInterval: (() => 1) as unknown as typeof setInterval,
      clearInterval: (() => {}) as never,
      onDeterministicPass: hook,
    });
    await driver.trigger({ kind: 'job.delivered', jobId: job.id });
    expect(released).toEqual([job.id]);
    expect(ledger.listEvents({ limit: 500 }).some((event) => event.kind === 'silas.reconcile')).toBe(true);
    // The driver's OWN digest for this job is empty: with the hook having
    // handled the row, no model wake happens (issue #243 H7).
    expect(slotWakes).toBe(0);
  });
});
