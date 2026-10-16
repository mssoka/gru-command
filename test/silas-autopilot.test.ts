import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LedgerApi } from '../src/ledger/api.js';
import { LIVE_DIRECTIVE_STATES } from '../src/ledger/directives.js';
import { LedgerDb } from '../src/ledger/db.js';
import {
  AUTOPILOT_DECISION_EVENT,
  AUTOPILOT_SOURCE,
  autopilotRuleMode,
  runSilasAutopilot,
  type AutopilotLedger,
  type SilasAutopilotOps,
} from '../src/dispatch/silas-autopilot.js';
import { BranchBusyError } from '../src/dispatch/branch-idle.js';
import { createSilasAutopilotOps, type SilasAutopilotOpsDeps } from '../src/dispatch/silas-autopilot-ops.js';
import { composeDeterministicPass, createSilasAutopilotHook } from '../src/dispatch/silas-autopilot-pass.js';
import { ReviewInProgressError, WaveRunner } from '../src/dispatch/perkins.js';
import type { AgentSpawner } from '../src/dispatch/service.js';
import { SilasDriver } from '../src/dispatch/silas-driver.js';
import { PacingGate } from '../src/runtime/pacing.js';
import type { WorktreeSweepResult } from '../src/dispatch/worktree-port.js';
import type { AgentCapabilities, AgentHandle } from '../src/runtime/types.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { withNativeDirectiveFixture } from './helpers/directive-native-fixture.js';
import { GitReviewPort } from './helpers/git-review-port.js';
import { nativeSeams } from './helpers/silas-native-seams.js';
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
  /** Durable FAILED directive requests, with their stored payload JSON
   * (issue #243 R2-H6: the conflict cutoff reads these, not sent receipts). */
  failedDirectives: { jobId: string; requestId: string; payload: string }[];
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
    failedDirectives: [],
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

  /** The newest event of a kind whose payload field equals the value. */
  latestJobEventByPayloadField(jobId: string, kind: string, field: string, value: string): FakeEvent | null {
    return [...this.state.events].reverse().find((event) => event.jobId === jobId && event.kind === kind &&
      (event.payload as Record<string, unknown> | undefined)?.[field] === value) ?? null;
  }

  /** Newest first and capped, exactly like the real ledger's query. */
  listJobEventsByKinds(jobId: string, kinds: readonly string[], opts: { limit?: number } = {}): FakeEvent[] {
    return this.state.events
      .filter((event) => event.jobId === jobId && kinds.includes(event.kind))
      .reverse()
      .slice(0, opts.limit ?? 200);
  }

  listPendingRebriefs(opts: { jobId?: string } = {}): readonly unknown[] {
    const jobs = opts.jobId === undefined ? this.state.pendingRebriefJobs : this.state.pendingRebriefJobs.filter((id) => id === opts.jobId);
    return jobs.map((jobId) => ({ jobId }));
  }

  listPendingDirectives(input: { jobId: string; states?: readonly string[]; limit?: number; cursor?: string }): readonly {
    jobId: string;
    requestId: string;
    payload: string;
  }[] {
    if (input.states?.includes('failed') === true) {
      // Request-id sort + cursor + cap, exactly like the real ledger, so a
      // paging regression is observable (issue #243 F-M3).
      const sorted = this.state.failedDirectives
        .filter((record) => record.jobId === input.jobId)
        .sort((left, right) => left.requestId.localeCompare(right.requestId))
        .filter((record) => input.cursor === undefined || record.requestId > input.cursor)
        .map((record) => ({ jobId: record.jobId, requestId: record.requestId, payload: record.payload }));
      const limit = input.limit ?? 200;
      return sorted.slice(0, limit);
    }
    return this.state.liveDirectiveJobs.includes(input.jobId)
      ? [{ jobId: input.jobId, requestId: `${input.jobId}-live`, payload: '{}' }]
      : [];
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
        // Issue #243 R2-H1: the row's #218 coverage identity rides the
        // decision so the ops mutation boundary can re-prove it.
        hold_signal: 'sweep-ack',
        hold_basis: 'status:done',
      },
      mode: 'dry-run',
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
  });

  it('records a persisting row decision ONCE per (rule, job, fingerprint); a changed decision records anew (#369)', async () => {
    const ledger = new FakeLedger().job('job-release', 'done');
    const ops = fakeOps();
    const pass = (mode?: 'enforce') => runSilasAutopilot({
      digest: digest({ releaseEligible: [releaseRow()] }),
      config: mode === undefined ? enabled() : enabled({ 'sweep-ack': mode }),
      ledger: ledger.port,
      ops: ops.ops,
    });
    // The same unchanged row across three passes is ONE decision event...
    for (let index = 0; index < 3; index += 1) expect((await pass()).decisions).toBe(1);
    expect(ledger.decisions()).toHaveLength(1);
    // ...while a changed decision (here the family's mode) records anew.
    await pass('enforce');
    expect(ledger.decisions()).toHaveLength(2);
    expect(ledger.decisions().map((event) => (event.payload as { mode: string }).mode)).toEqual(['dry-run', 'enforce']);
    // Another job's decision for the same rule never masks this one.
    ledger.job('job-other', 'done');
    await runSilasAutopilot({
      digest: digest({ releaseEligible: [releaseRow({ jobId: 'job-other' })] }),
      config: enabled(), ledger: ledger.port, ops: ops.ops,
    });
    expect(ledger.decisions().filter((event) => event.jobId === 'job-other')).toHaveLength(1);
  });

  it('a rule\'s last decision is found past any number of other rules\' decisions on the job (#369)', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-release', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'done');
    const ops = fakeOps();
    const pass = () => runSilasAutopilot({ digest: digest({ releaseEligible: [releaseRow()] }), config: enabled(), ledger, ops: ops.ops });
    const ruleDecisions = () => ledger.listJobEventsByKinds(job.id, [AUTOPILOT_DECISION_EVENT], { limit: 1000 })
      .filter((event) => (event.payload as { rule_id?: string }).rule_id === 'sweep-ack');
    await pass();
    expect(ruleDecisions()).toHaveLength(1);
    // More decisions from another rule than any fixed newest-N window holds.
    for (let index = 0; index < 300; index += 1) {
      ledger.appendCustomEvent({ kind: AUTOPILOT_DECISION_EVENT, jobId: job.id, payload: { rule_id: 'pr-review-trigger', job: job.id, action: 'noop', would_call: { index }, mode: 'dry-run' } });
    }
    await pass();
    expect(ruleDecisions()).toHaveLength(1);
    expect(() => ledger.latestJobEventByPayloadField(job.id, AUTOPILOT_DECISION_EVENT, "rule_id') OR 1=1 --", 'x')).toThrow(/not a plain snake_case payload field/u);
  });

  it('a decision recorded before fingerprints existed is the same decision on upgrade (#369)', async () => {
    const ledger = new FakeLedger().job('job-release', 'done');
    const ops = fakeOps();
    const pass = () => runSilasAutopilot({ digest: digest({ releaseEligible: [releaseRow()] }), config: enabled(), ledger: ledger.port, ops: ops.ops });
    await pass();
    const [first] = ledger.decisions();
    const { fingerprint: _fingerprint, ...legacy } = first!.payload as Record<string, unknown>;
    // Rewrite history as a pre-#369 deployment left it: no fingerprint, and
    // its would-call object read back with its keys in another order.
    const reversed = (value: unknown): unknown => value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, member]) => [key, reversed(member)])) : value;
    (first as { payload: unknown }).payload = { ...legacy, would_call: reversed(legacy['would_call']) };
    expect(JSON.stringify((first!.payload as { would_call?: unknown }).would_call)).not.toBe(JSON.stringify(legacy["would_call"]));
    await pass();
    expect(ledger.decisions()).toHaveLength(1);
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
    expect(calls[0]?.input).toEqual({
      jobId: 'job-release',
      ruleId: 'sweep-ack',
      hold: { signal: 'sweep-ack', basis: 'status:done' },
    });
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

  it('counts UNSENT durable failures for this head (issue #243 R2-H6)', async () => {
    const ledger = new FakeLedger().job('job-conflict', 'working');
    const fingerprint = `pr-conflict:${'b'.repeat(40)}`;
    // Two durable FAILED requests with this head fingerprint — and NOT one
    // `silas.directive-sent` receipt between them (a refused supersession or
    // positive no-delivery records `silas.directive-failed` alone). The old
    // sent-receipt-only count left this counter at zero and re-fired.
    for (const requestId of ['req-1', 'req-2']) {
      ledger.state.failedDirectives.push({
        jobId: 'job-conflict',
        requestId,
        payload: JSON.stringify({ directive: 'x', blocker_fingerprint: fingerprint }),
      });
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
    ledger.state.failedDirectives.pop();
    const retry = fakeOps();
    const second = await runSilasAutopilot({
      digest: digest({ conflictingPrs: [conflictRow()] }),
      config: enabled({ 'pr-conflict-rebase': 'enforce' }),
      ledger: ledger.port,
      ops: retry.ops,
    });
    expect(second.decisions).toBe(1);

    // A failure for a DIFFERENT head never counts against this one.
    ledger.state.failedDirectives.push({
      jobId: 'job-conflict',
      requestId: 'req-other',
      payload: JSON.stringify({ directive: 'x', blocker_fingerprint: `pr-conflict:${'c'.repeat(40)}` }),
    });
    const third = fakeOps();
    const otherHead = await runSilasAutopilot({
      digest: digest({ conflictingPrs: [conflictRow()] }),
      config: enabled({ 'pr-conflict-rebase': 'enforce' }),
      ledger: ledger.port,
      ops: third.ops,
    });
    expect(otherHead.decisions).toBe(1);
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
      hold: { signal: 'clean-abort-service-restart', basis: 'round:round-abort' },
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
    ledger.record('job-review', 'github.ci-green', { sha, repo: 'mssoka/gru-command' });
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
      hold: { signal: 'pr-review-trigger', basis: 'pr-review:none' },
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
    expect(calls[0]?.input).toEqual({
      jobId: 'job-release',
      ruleId: 'sweep-ack',
      hold: { signal: 'sweep-ack', basis: 'status:done' },
    });
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
      hold: { signal: 'delivered-pr-register', basis: 'delivered:none' },
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
    ledger.setJobStatus(job.id, 'working');
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
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
      ...nativeSeams,
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
      ...nativeSeams,
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
      ...nativeSeams,
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
      ...nativeSeams,
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

/** A real job lane (a git worktree on its own branch) — the native directive
 * executor refuses fresh effects without a registered, checked-out lane. */
async function nativeLanes(jobId: string, ledger: LedgerApi): Promise<InMemoryWorktreePort> {
  const repo = makeFixtureRepo();
  repos.push(repo);
  const laneRoot = mkdtempSync(join(tmpdir(), 'autopilot-native-lanes-'));
  dirs.push(laneRoot);
  const lanes = new InMemoryWorktreePort(laneRoot, ledger);
  await lanes.createJobWorktree({ repoPath: repo.path, jobId });
  return lanes;
}

/** Wrap a fake handle with the native directive attestation the production
 * runtime provides, bound to the job lane's cwd. */
function nativeHandle(base: AgentHandle, lanes: InMemoryWorktreePort, jobId: string): AgentHandle {
  const lane = lanes.listWorktrees({ jobId })[0]!;
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-native-session-'));
  dirs.push(dir);
  return withNativeDirectiveFixture(base, join(dir, `${base.id}.jsonl`), () => {}, () => null, lane.path);
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

function waveStub(overrides: {
  assertWriterAdmissible?: (jobId: string) => void;
  clearLaneForWriter?: (input: { readonly jobId: string; readonly writer: string }) => Promise<unknown>;
  requestReview?: SilasAutopilotOpsDeps['wave']['requestReview'];
} = {}) {
  return {
    assertWriterAdmissible: overrides.assertWriterAdmissible ?? ((): void => {}),
    clearLaneForWriter: overrides.clearLaneForWriter ?? (async (): Promise<unknown> => undefined),
    requestReview: overrides.requestReview ?? (async (): Promise<never> => {
      throw new Error('unused');
    }),
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
      ...nativeSeams,
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
      ...nativeSeams,
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
      ...nativeSeams,
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
    const ledger = newRealLedger();
    const lanes = new InMemoryWorktreePort(laneRoot, ledger);
    const job = ledger.addJob({ id: 'job-m9', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    await lanes.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    const handle = nativeHandle(idleHandle('min-m9'), lanes, job.id);
    ledger.registerAgent({ id: 'min-m9', role: 'minion', jobId: job.id, sessionFile: handle.sessionFile });
    ledger.setAgentState('min-m9', 'idle');
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub(),
      registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async (target) => { await target.dispose(); } },
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
    await vi.waitFor(() => expect(ledger.listPendingDirectives({ jobId: job.id })[0]?.state).toBe('settled'));
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
    const ledger = newRealLedger();
    const lanes = new InMemoryWorktreePort(laneRoot, ledger);
    const job = ledger.addJob({ id: 'job-h3', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'original' });
    ledger.setJobStatus(job.id, 'working');
    await lanes.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    const prompted: string[] = [];
    const handle = nativeHandle({
      ...idleHandle('min-h3'),
      async prompt(text: string) {
        prompted.push(text);
      },
    }, lanes, job.id);
    ledger.registerAgent({ id: 'min-h3', role: 'minion', jobId: job.id, sessionFile: handle.sessionFile });
    ledger.setAgentState('min-h3', 'idle');
    const amendment = ledger.addJobAmendment({
      jobId: job.id,
      body: 'ALSO: fix the retry path before you push.',
      effect: 'material',
      approval: { by: 'owner', reference: 'fixture-approval-h3' },
      expectedContractSha256: ledger.effectiveContract(job.id)!.contractSha256,
    });
    expect(amendment.status).toBe('accepted');
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub(),
      registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async (target) => { await target.dispose(); } },
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
    await vi.waitFor(() => expect(ledger.listPendingDirectives({ jobId: job.id })[0]?.state).toBe('settled'));
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
    const ledger = newRealLedger();
    const lanes = new InMemoryWorktreePort(laneRoot, ledger);
    const job = ledger.addJob({ id: 'job-m10', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    await lanes.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    const handle = nativeHandle(idleHandle('fresh-m10'), lanes, job.id);
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
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
    expect(ledger.listPendingDirectives({ jobId: job.id, states: LIVE_DIRECTIVE_STATES, limit: 5 })).toEqual([]);
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

// ------------------------------------------------------------------
// Round-2 findings (issue #243 R2-H1..H9, R2-M1..M4)
// ------------------------------------------------------------------

describe('R2-H1 decision holds cover sweep-ack and delivered-pr-register', () => {
  it('refuses sweep-ack while an active hold covers the release', async () => {
    const ledger = new FakeLedger().job('job-release', 'done');
    ledger.state.heldDecisions.push({ id: 'd-sweep', subject: 'job:job-release', signal: 'sweep-ack', basis: null });
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({ releaseEligible: [releaseRow()] }),
      config: enabled({ 'sweep-ack': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(0);
    expect(result.refusals).toBe(1);
    expect(calls).toEqual([]);
  });

  it('refuses delivered-pr-register while an active hold covers the delivered head', async () => {
    const ledger = new FakeLedger().job('job-delivered', 'delivered');
    ledger.state.heldDecisions.push({
      id: 'd-reg',
      subject: 'job:job-delivered',
      signal: 'delivered-pr-register',
      basis: null,
    });
    const { ops, calls } = fakeOps({
      listOpenPrsForHead: async () => [{ number: 1, url: 'https://github.com/mssoka/gru-command/pull/1' }],
    });
    const result = await runSilasAutopilot({
      digest: digest({ deliveredWithoutPr: [deliveredRow()] }),
      config: enabled({ 'delivered-pr-register': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.decisions).toBe(0);
    expect(result.refusals).toBe(1);
    expect(calls).toEqual([]);
  });

  it('the ops final mutation boundary re-proves the sweep-ack hold before touching the lane', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-r2h1-sweep', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'done');
    ledger.recordDecision({
      subject: `job:${job.id}`,
      decision: 'hold',
      covers: ['sweep-ack'],
      by: 'owner',
      reason: 'owner-held custody',
    });
    let released = false;
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub(),
      registry: {} as never,
      worktrees: {
        listWorktrees: () => [{ id: job.id, kind: 'job', status: 'active', branch: 'gru/x', path: '/tmp/x' }],
        release: async () => {
          released = true;
          return { status: 'swept', preserved: null, branch: 'none', freshHead: 'a'.repeat(40) };
        },
      } as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await expect(ops.releaseLane({ jobId: job.id, ruleId: 'sweep-ack' })).rejects.toThrow(/an active decision/);
    expect(released).toBe(false);
  });

  it('the ops registration boundary re-proves the delivered-pr-register hold', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-r2h1-reg', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    ledger.recordDecision({
      subject: `job:${job.id}`,
      decision: 'hold',
      covers: ['delivered-pr-register'],
      by: 'owner',
      reason: 'owner-held registration',
    });
    let linked = false;
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub(),
      registry: {} as never,
      worktrees: {} as never,
      dispatch: {
        recordPr: () => {
          linked = true;
          return { prUrl: 'https://github.com/mssoka/gru-command/pull/1' };
        },
      },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await expect(
      ops.registerPr({ jobId: job.id, url: 'https://github.com/mssoka/gru-command/pull/1', ruleId: 'delivered-pr-register' }),
    ).rejects.toThrow(/an active decision/);
    expect(linked).toBe(false);
  });
});

describe('R2-H2 verification ownership fences the conflict writer', () => {
  it('refuses the conflict planner while a verification is in flight', async () => {
    const ledger = new FakeLedger().job('job-conflict', 'working');
    ledger.state.unsettledVerificationJobs.push('job-conflict');
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

  it('the ops directive boundary refuses while a verification is in flight (real ledger)', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-r2h2', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    ledger.appendCustomEvent({
      kind: 'verification.requested',
      jobId: job.id,
      payload: { scope: 'full', run_id: 'run-r2h2', head: 'a'.repeat(40) },
    });
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub(),
      registry: {} as never,
      worktrees: {} as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await expect(
      ops.sendDirective({
        jobId: job.id,
        directive: 'x',
        ruleId: 'pr-conflict-rebase',
        blockerFingerprint: `pr-conflict:${'b'.repeat(40)}`,
      }),
    ).rejects.toThrow(/verification is already in flight/);
    expect(ledger.listPendingDirectives({ jobId: job.id })).toHaveLength(0);
  });
});

describe('R2-H3 a stale re-brief never replaces a newer pending request', () => {
  it('refuses when a newer re-brief generation is already admitted', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-r2h3', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    // A newer request admitted during this producer's awaited supersession.
    const newer = ledger.beginRebriefIntent({
      jobId: job.id,
      note: 'newer admitted request',
      holder: 'silas-ops',
      sourceContext: { ruleId: 'verdict-rung-rebrief', sourceRoundId: 'round-newer' },
    }).record;
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub(),
      registry: {} as never,
      worktrees: {} as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await expect(
      ops.sendRebrief({ jobId: job.id, note: 'stale request', ruleId: 'verdict-rung-rebrief', sourceRoundId: 'round-stale' }),
    ).rejects.toThrow(/is already live/);
    // The newer generation survives byte-for-byte.
    expect(ledger.getDirective(newer.requestId)?.state).toBe(newer.state);
    expect(ledger.listPendingDirectives({ jobId: job.id, states: LIVE_DIRECTIVE_STATES, limit: 5 }).map((row) => row.requestId))
      .toEqual([newer.requestId]);
  });
});

describe('R2-H4 clean-abort carries the proved head through admission (real ledger)', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const seedCleanAbort = (ledger: LedgerApi, jobId: string): { readonly jobId: string; readonly roundId: string } => {
    const job = ledger.addJob({ id: jobId, repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'in-review');
    const round = ledger.addRound({ jobId: job.id, targetRef: A });
    ledger.setRoundStatus(round.id, 'aborted');
    ledger.appendCustomEvent({
      kind: 'round.perkins-incomplete',
      roundId: round.id,
      jobId: job.id,
      payload: { reason: 'service_restart' },
    });
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: job.id, payload: { sha: A } });
    return { jobId: job.id, roundId: round.id };
  };

  it('forwards the proved head A and refuses when a newer delivery B landed', async () => {
    const ledger = newRealLedger();
    const { jobId, roundId } = seedCleanAbort(ledger, 'job-r2h4');
    const captured: Record<string, unknown>[] = [];
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub({
        requestReview: (async (input: Record<string, unknown>) => {
          captured.push({ ...input });
          return { route: 'queued', jobId, requestSeq: 1, run: Promise.resolve() };
        }) as unknown as SilasAutopilotOpsDeps['wave']['requestReview'],
      }),
      registry: {} as never,
      worktrees: {} as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await ops.triggerReview({
      jobId,
      ruleId: 'clean-abort-service-restart',
      sourceRoundId: roundId,
      targetRef: A,
      boundDeliveredSha: A,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ targetRef: A, boundDeliveredSha: A });

    // A newer delivery B must make the re-arm refuse, never rebind B under
    // head A's abort provenance.
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { sha: B } });
    await expect(
      ops.triggerReview({
        jobId,
        ruleId: 'clean-abort-service-restart',
        sourceRoundId: roundId,
        targetRef: A,
        boundDeliveredSha: A,
      }),
    ).rejects.toThrow(/not the latest service-restart abort|refusing to bind/);
  });
});

describe('R2-H5 the post-lookup / mutation boundary re-proves ownership', () => {
  it('refuses the planner when a re-brief lands during the GitHub lookup', async () => {
    const ledger = new FakeLedger().job('job-delivered', 'delivered');
    const { ops, calls } = fakeOps({
      listOpenPrsForHead: async () => {
        ledger.state.pendingRebriefJobs.push('job-delivered');
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

  it('the ops registration boundary refuses once the lane went terminal', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-r2h5', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'done');
    let linked = false;
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub(),
      registry: {} as never,
      worktrees: {} as never,
      dispatch: {
        recordPr: () => {
          linked = true;
          return { prUrl: null };
        },
      },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await expect(
      ops.registerPr({ jobId: job.id, url: 'https://github.com/mssoka/gru-command/pull/9', ruleId: 'delivered-pr-register' }),
    ).rejects.toThrow(/no review is offered|already carries a PR|job is done/);
    expect(linked).toBe(false);
  });

  it('the ops registration boundary refuses while a verification is in flight (real ledger)', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-r2h5v', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    ledger.appendCustomEvent({
      kind: 'verification.requested',
      jobId: job.id,
      payload: { scope: 'full', run_id: 'run-r2h5v', head: 'a'.repeat(40) },
    });
    let linked = false;
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub(),
      registry: {} as never,
      worktrees: {} as never,
      dispatch: {
        recordPr: () => {
          linked = true;
          return { prUrl: null };
        },
      },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await expect(
      ops.registerPr({
        jobId: job.id,
        url: 'https://github.com/mssoka/gru-command/pull/9',
        ruleId: 'delivered-pr-register',
      }),
    ).rejects.toThrow(/verification is already in flight/);
    expect(linked).toBe(false);
  });
});

describe('R2-M1 review admission is awaited through admission', () => {
  const A_HEAD = 'a'.repeat(40);
  it('triggerReview does not settle until the wave admits the request, then records the receipt', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-r2m1', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'in-review');
    let releaseReview!: () => void;
    const reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve;
    });
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub({
        requestReview: (async () => {
          await reviewGate;
          return { route: 'perkins', round: { id: 'round-r2m1' } as never, run: Promise.resolve() as never };
        }) as unknown as SilasAutopilotOpsDeps['wave']['requestReview'],
      }),
      registry: {} as never,
      worktrees: {} as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    let settled = false;
    const call = ops
      .triggerReview({ jobId: job.id, ruleId: 'pr-review-trigger', targetRef: A_HEAD, boundDeliveredSha: A_HEAD })
      .then(() => {
        settled = true;
      });
    await Promise.resolve();
    await Promise.resolve();
    // Admission is still pending: the producer must NOT have returned, or the
    // recomputed digest still offers the row and a model wake burns.
    expect(settled).toBe(false);
    expect(ledger.latestJobEvent(job.id, 'silas.review-triggered')).toBeNull();
    releaseReview();
    await call;
    expect(settled).toBe(true);
    expect(ledger.latestJobEvent(job.id, 'silas.review-triggered')?.payload).toMatchObject({
      route: 'perkins',
      round_id: 'round-r2m1',
    });
  });
});

describe('R2-M2 a failed enforced action fails the pass', () => {
  it('runSilasAutopilot reports ok:false when an action fails', async () => {
    const ledger = new FakeLedger().job('job-release', 'done');
    const { ops } = fakeOps({
      releaseLane: async () => {
        throw new Error('lane paused');
      },
    });
    const result = await runSilasAutopilot({
      digest: digest({ releaseEligible: [releaseRow()] }),
      config: enabled({ 'sweep-ack': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    expect(result.failures).toBe(1);
    expect(result.ok).toBe(false);
  });

  it('the production hook propagates the unsuccessful result', async () => {
    const ledger = new FakeLedger().job('job-release', 'done');
    const hook = createSilasAutopilotHook({
      ledger: ledger.port,
      config: enabled({ 'sweep-ack': 'enforce' }),
      ops: {
        listOpenPrsForHead: async () => [],
        registerPr: async () => {},
        triggerReview: async () => {},
        sendDirective: async () => {},
        sendRebrief: async () => {},
        releaseLane: async () => {
          throw new Error('lane paused');
        },
      },
      digest: async () => digest({ releaseEligible: [releaseRow()] }),
    });
    const outcome = (await hook({ trigger: 'sweep', wakeInFlight: false })) as { readonly ok: boolean };
    expect(outcome.ok).toBe(false);
  });
});

describe('R2-H9 service-stop ownership of directive/re-brief producers', () => {
  it('refuses to start a directive after the stop signal aborted', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-r2h9a', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    const stop = new AbortController();
    stop.abort();
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub(),
      registry: {} as never,
      worktrees: {} as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
      stopSignal: stop.signal,
    });
    await expect(
      ops.sendDirective({ jobId: job.id, directive: 'x', ruleId: 'verdict-rung-directive', sourceRoundId: 'r' }),
    ).rejects.toThrow(/service is stopping/);
    expect(ledger.listPendingDirectives({ jobId: job.id })).toHaveLength(0);
  });

  it('a queued producer whose stop signal aborts never starts, and drain joins it', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-r2h9b', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    const lanes = await nativeLanes(job.id, ledger);
    const handle = nativeHandle(idleHandle('min-r2h9'), lanes, job.id);
    ledger.registerAgent({ id: 'min-r2h9', role: 'minion', jobId: job.id, sessionFile: handle.sessionFile });
    ledger.setAgentState('min-r2h9', 'idle');
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const holder = await gate.acquireWorkerTurn({ id: 'holder', label: 'hold the pool' });
    const stop = new AbortController();
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub(),
      registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
      worktrees: lanes,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
      workerGate: gate,
      stopSignal: stop.signal,
    });
    await ops.sendDirective({ jobId: job.id, directive: 'x', ruleId: 'verdict-rung-directive', sourceRoundId: 'r' });
    await vi.waitFor(() => expect(gate.view().worker.queued).toHaveLength(1));
    stop.abort();
    await vi.waitFor(() => expect(gate.view().worker.queued).toHaveLength(0));
    holder.release();
    const drained = await ops.drain();
    expect(drained.settled).toBe(true);
    // The prompt never ran: no sent receipt, and the request never failed
    // (fail-closed reconcile keeps it live for boot reconciliation).
    expect(ledger.latestJobEvent(job.id, 'silas.directive-sent')).toBeNull();
    const intent = ledger.listPendingDirectives({ jobId: job.id })[0];
    expect(intent?.state).not.toBe('failed');
  });
});

describe('sweep-ack custody: the autopilot mints no fabricated preservation evidence', () => {
  const custodyOps = (ledger: LedgerApi, release: () => Promise<WorktreeSweepResult>, status = 'active') =>
    createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub(),
      registry: {} as never,
      worktrees: {
        listWorktrees: () =>
          status === 'active'
            ? [{ id: 'job-custody', kind: 'job', status: 'active', branch: 'gru/custody', path: '/tmp/custody' }]
            : [],
        release,
      } as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });

  it('a paused (custody-preserving) release refuses and mints NO receipt', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-custody', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'done');
    const ops = custodyOps(ledger, async () => ({
      status: 'paused',
      processes: [],
      preserved: null,
      note: 'a process is using the tree',
    }) as WorktreeSweepResult);
    await expect(ops.releaseLane({ jobId: job.id, ruleId: 'sweep-ack' })).rejects.toThrow(/paused/);
    expect(ledger.latestJobEvent(job.id, 'silas.lane-released')).toBeNull();
  });

  it('a successful release records its branch disposition and cannot be replayed', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-custody', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'done');
    let released = false;
    const ops = custodyOps(ledger, async () => {
      released = true;
      return { status: 'swept', preserved: { count: 2, destination: '/tmp/preserved' }, branch: 'retained', freshHead: 'a'.repeat(40) };
    });
    await ops.releaseLane({ jobId: job.id, ruleId: 'sweep-ack' });
    expect(released).toBe(true);
    expect(ledger.latestJobEvent(job.id, 'silas.lane-released')?.payload).toMatchObject({
      worktree_id: 'job-custody',
      branch_disposition: 'retained',
      rule_id: 'sweep-ack',
      source: AUTOPILOT_SOURCE,
    });
    // The lane is gone; a replay cannot mint a second receipt.
    const replay = custodyOps(ledger, async () => {
      throw new Error('must not release twice');
    }, 'swept');
    await expect(replay.releaseLane({ jobId: job.id, ruleId: 'sweep-ack' })).rejects.toThrow(/no active job lane/);
    const receipts = ledger
      .listJobEvents(job.id)
      .filter((event) => event.kind === 'silas.lane-released');
    expect(receipts).toHaveLength(1);
  });
});

// ------------------------------------------------------------------
// R2-M4: the production ops + REAL WaveRunner admission/freeze seam
// ------------------------------------------------------------------

describe('R2-M4 production ops drive a REAL WaveRunner admission/freeze', () => {
  const makeRealWaveFixture = async (name: string): Promise<{
    readonly jobId: string;
    readonly deliveredSha: string;
    readonly liveHeadB: string;
    readonly artifacts: string;
    readonly ledger: LedgerApi;
    readonly port: GitReviewPort;
  }> => {
    const repo = makeFixtureRepo(name);
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/r2m4']);
    // A = the delivered/green head; B = the branch head it must NOT silently
    // freeze instead. A real branch advance is the exact "live head moved"
    // shape the ops forwarding must pin past.
    const deliveredSha = repo.commitFile('src/a.ts', 'export const a = 1;\n');
    const liveHeadB = repo.commitFile('src/b.ts', 'export const b = 2;\n');
    const root = mkdtempSync(join(tmpdir(), `r2m4-${name}-port-`));
    dirs.push(root);
    const artifacts = mkdtempSync(join(tmpdir(), `r2m4-${name}-art-`));
    dirs.push(artifacts);
    const ledger = newRealLedger();
    const port = new GitReviewPort(root, 'feature/r2m4', deliveredSha, ledger);
    const job = ledger.addJob({ id: name, repo: 'fixture', title: name, baseBranch: 'main', briefing: 'review this' });
    await port.createJobWorktree({ repoPath: repo.path, jobId: name });
    ledger.setJobStatus(job.id, 'working');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: job.id, payload: { sha: deliveredSha } });
    return { jobId: name, deliveredSha, liveHeadB, artifacts, ledger, port };
  };

  const opsFor = (f: { readonly ledger: LedgerApi; readonly port: GitReviewPort }, wave: WaveRunner) =>
    createSilasAutopilotOps({
      ...nativeSeams,
      ledger: f.ledger,
      wave,
      registry: {} as never,
      worktrees: f.port,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });

  it('freezes the ops-supplied head A through real admission (positive control)', async () => {
    const f = await makeRealWaveFixture('r2m4-positive');
    const wave = new WaveRunner({
      ledger: f.ledger,
      worktrees: f.port,
      spawner: vi.fn() as unknown as AgentSpawner,
      reviewArtifactRoot: f.artifacts,
      reviewPreflight: async () => ({ ok: true as const, failures: [] }),
    });
    // The production pr-review-trigger arm now carries the M2 final green
    // guard: seed the usable green the planner would have seen.
    f.ledger.appendCustomEvent({ kind: 'github.ci-green', jobId: f.jobId, payload: { sha: f.deliveredSha } });
    await opsFor(f, wave).triggerReview({
      jobId: f.jobId,
      ruleId: 'pr-review-trigger',
      targetRef: f.deliveredSha,
      boundDeliveredSha: f.deliveredSha,
    });
    const rounds = f.ledger.listRounds(f.jobId);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.targetRef).toBe(f.deliveredSha);
    expect(rounds[0]?.targetRef).not.toBe(f.liveHeadB);
    expect(f.ledger.latestJobEvent(f.jobId, 'silas.review-triggered')?.payload).toMatchObject({ route: 'perkins' });
    await wave.shutdown();
  }, 60_000);

  it('refuses a delivered-head drift to B during real admission, arming no round (negative control)', async () => {
    const f = await makeRealWaveFixture('r2m4-stale');
    let releasePreflight!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    let preflightCalls = 0;
    const wave = new WaveRunner({
      ledger: f.ledger,
      worktrees: f.port,
      spawner: vi.fn() as unknown as AgentSpawner,
      reviewArtifactRoot: f.artifacts,
      reviewPreflight: async () => {
        preflightCalls += 1;
        await gate;
        return { ok: true as const, failures: [] };
      },
    });
    const call = opsFor(f, wave).triggerReview({
      jobId: f.jobId,
      ruleId: 'pr-review-trigger',
      targetRef: f.deliveredSha,
      boundDeliveredSha: f.deliveredSha,
    });
    await vi.waitFor(() => expect(preflightCalls).toBe(1));
    // A newer delivery lands while the request sits inside the awaited
    // pre-flight — the controlled boundary immediately before the freeze.
    f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.jobId, payload: { sha: f.liveHeadB } });
    releasePreflight();
    await expect(call).rejects.toThrow(/delivered head moved during review setup/);
    // The freeze-bound check runs after the round row exists, so the row is
    // created and then ABORTED — it is never armed, and its target is the
    // PROVED head A, never the drifted B. No suppression receipt lands.
    const rounds = f.ledger.listRounds(f.jobId);
    expect(rounds.length).toBeGreaterThanOrEqual(1);
    for (const round of rounds) {
      expect(round.status).toBe('aborted');
      expect(round.targetRef).toBe(f.deliveredSha);
    }
    expect(rounds.some((round) => round.targetRef === f.liveHeadB)).toBe(false);
    expect(f.ledger.latestJobEvent(f.jobId, 'silas.review-triggered')).toBeNull();
    await wave.shutdown();
  }, 60_000);

  it('refuses a delivery B injected during the FINAL post-freeze probe (issue #243 F-H7)', async () => {
    const f = await makeRealWaveFixture('fh7-stale');
    const wave = new WaveRunner({
      ledger: f.ledger,
      worktrees: f.port,
      spawner: vi.fn() as unknown as AgentSpawner,
      reviewArtifactRoot: f.artifacts,
      reviewPreflight: async () => ({ ok: true as const, failures: [] }),
      // The freeze observer runs AFTER the pre-probe bound check and BEFORE the
      // asynchronous advertised-tip probe. Injecting B here lands the drift in
      // exactly the window the branch-idle recheck cannot see (an explicitly
      // pinned SHA A stays immutable, so movement alone never catches it).
      reviewFreezeObserver: () => {
        f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.jobId, payload: { sha: f.liveHeadB } });
      },
    });
    await expect(
      opsFor(f, wave).triggerReview({
        jobId: f.jobId,
        ruleId: 'pr-review-trigger',
        targetRef: f.deliveredSha,
        boundDeliveredSha: f.deliveredSha,
      }),
    ).rejects.toThrow(/bound delivered head moved during the final admission probe/);
    const rounds = f.ledger.listRounds(f.jobId);
    for (const round of rounds) {
      expect(round.status).toBe('aborted');
      expect(round.targetRef).not.toBe(f.liveHeadB);
    }
    expect(f.ledger.latestJobEvent(f.jobId, 'silas.review-triggered')).toBeNull();
    await wave.shutdown();
  }, 60_000);

  it('still arms when no delivery drift lands during the final probe (positive control)', async () => {
    const f = await makeRealWaveFixture('fh7-clean');
    const wave = new WaveRunner({
      ledger: f.ledger,
      worktrees: f.port,
      spawner: vi.fn() as unknown as AgentSpawner,
      reviewArtifactRoot: f.artifacts,
      reviewPreflight: async () => ({ ok: true as const, failures: [] }),
    });
    f.ledger.appendCustomEvent({ kind: 'github.ci-green', jobId: f.jobId, payload: { sha: f.deliveredSha } });
    await opsFor(f, wave).triggerReview({
      jobId: f.jobId,
      ruleId: 'pr-review-trigger',
      targetRef: f.deliveredSha,
      boundDeliveredSha: f.deliveredSha,
    });
    const rounds = f.ledger.listRounds(f.jobId);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.targetRef).toBe(f.deliveredSha);
    await wave.shutdown();
  }, 60_000);

  it('refuses an OWNER HOLD that lands during the awaited review preflight (issue #243 F-H2)', async () => {
    const f = await makeRealWaveFixture('fh2-late-hold');
    const hold = { signal: 'pr-review-trigger', basis: 'pr-review:none' };
    let releasePreflight!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    let preflightCalls = 0;
    const wave = new WaveRunner({
      ledger: f.ledger,
      worktrees: f.port,
      spawner: vi.fn() as unknown as AgentSpawner,
      reviewArtifactRoot: f.artifacts,
      reviewPreflight: async () => {
        preflightCalls += 1;
        await gate;
        return { ok: true as const, failures: [] };
      },
    });
    const call = opsFor(f, wave).triggerReview({
      jobId: f.jobId,
      ruleId: 'pr-review-trigger',
      targetRef: f.deliveredSha,
      boundDeliveredSha: f.deliveredSha,
      hold,
    });
    await vi.waitFor(() => expect(preflightCalls).toBe(1));
    // An owner hold lands while the request sits in the awaited preflight.
    f.ledger.recordDecision({
      subject: `job:${f.jobId}`,
      decision: 'hold',
      covers: ['pr-review-trigger'],
      basisFingerprint: 'pr-review:none',
      by: 'owner',
      reason: 'owner hold arrived during the review preflight',
    });
    releasePreflight();
    await expect(call).rejects.toThrow(/covers pr-review-trigger/);
    for (const round of f.ledger.listRounds(f.jobId)) expect(round.status).toBe('aborted');
    expect(f.ledger.latestJobEvent(f.jobId, 'silas.review-triggered')).toBeNull();
    await wave.shutdown();
  }, 60_000);

  it('refuses when the delivered-head CI goes PENDING during the awaited preflight (issue #243 F-M2)', async () => {
    const f = await makeRealWaveFixture('fm2-late-pending');
    let releasePreflight!: () => void;
    const gate = new Promise<void>((resolve) => {
      releasePreflight = resolve;
    });
    let preflightCalls = 0;
    const wave = new WaveRunner({
      ledger: f.ledger,
      worktrees: f.port,
      spawner: vi.fn() as unknown as AgentSpawner,
      reviewArtifactRoot: f.artifacts,
      reviewPreflight: async () => {
        preflightCalls += 1;
        await gate;
        return { ok: true as const, failures: [] };
      },
    });
    // A green first (the state the planner would have seen).
    f.ledger.appendCustomEvent({ kind: 'github.ci-green', jobId: f.jobId, payload: { sha: f.deliveredSha } });
    const call = opsFor(f, wave).triggerReview({
      jobId: f.jobId,
      ruleId: 'pr-review-trigger',
      targetRef: f.deliveredSha,
      boundDeliveredSha: f.deliveredSha,
    });
    await vi.waitFor(() => expect(preflightCalls).toBe(1));
    // The newest observation flips to pending at the same head mid-air.
    f.ledger.appendCustomEvent({
      kind: 'github.branch-state',
      jobId: f.jobId,
      payload: { sha: f.deliveredSha, ci: { sha: f.deliveredSha, status: 'pending' } },
    });
    releasePreflight();
    await expect(call).rejects.toThrow(/no longer usable green/);
    for (const round of f.ledger.listRounds(f.jobId)) expect(round.status).toBe('aborted');
    expect(f.ledger.latestJobEvent(f.jobId, 'silas.review-triggered')).toBeNull();
    await wave.shutdown();
  }, 60_000);

  it('arms when nothing changes during the awaited preflight (unchanged control)', async () => {
    const f = await makeRealWaveFixture('fm2-unchanged');
    const wave = new WaveRunner({
      ledger: f.ledger,
      worktrees: f.port,
      spawner: vi.fn() as unknown as AgentSpawner,
      reviewArtifactRoot: f.artifacts,
      reviewPreflight: async () => ({ ok: true as const, failures: [] }),
    });
    f.ledger.appendCustomEvent({ kind: 'github.ci-green', jobId: f.jobId, payload: { sha: f.deliveredSha } });
    await opsFor(f, wave).triggerReview({
      jobId: f.jobId,
      ruleId: 'pr-review-trigger',
      targetRef: f.deliveredSha,
      boundDeliveredSha: f.deliveredSha,
    });
    const rounds = f.ledger.listRounds(f.jobId);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.targetRef).toBe(f.deliveredSha);
    await wave.shutdown();
  }, 60_000);
});

// ------------------------------------------------------------------
// Audit fix round (issue #243 F-M2/F-M3/F-H2/F-H3/F-H4)
// ------------------------------------------------------------------

describe('F-M2 the newest CI observation governs green-only review eligibility', () => {
  const armReview = async (ledger: FakeLedger) => {
    const { ops, calls } = fakeOps();
    const result = await runSilasAutopilot({
      digest: digest({ prWithoutReview: [prWithoutReviewRow({ jobId: 'job-review' })] }),
      config: enabled({ 'pr-review-trigger': 'enforce' }),
      ledger: ledger.port,
      ops,
    });
    return { result, calls };
  };

  it('arms when the newest observation on the delivered head is green (control)', async () => {
    const A = 'e'.repeat(40);
    const ledger = new FakeLedger().job('job-review', 'delivered');
    ledger.record('job-review', 'job.delivered', { sha: A });
    ledger.record('job-review', 'github.ci-green', { sha: A, repo: 'mssoka/gru-command' });
    const { result, calls } = await armReview(ledger);
    expect(result.decisions).toBe(1);
    expect(calls[0]?.method).toBe('triggerReview');
  });

  it('refuses a green that carries NO repository binding (issue #243 M2)', async () => {
    const A = 'e'.repeat(40);
    const ledger = new FakeLedger().job('job-review', 'delivered');
    ledger.record('job-review', 'job.delivered', { sha: A });
    ledger.record('job-review', 'github.ci-green', { sha: A });
    const { result, calls } = await armReview(ledger);
    expect(result.decisions).toBe(0);
    expect(result.refusals).toBe(1);
    expect(calls).toEqual([]);
  });

  it('refuses a green observed on a DIFFERENT repository (issue #243 M2)', async () => {
    const A = 'e'.repeat(40);
    const ledger = new FakeLedger().job('job-review', 'delivered');
    ledger.record('job-review', 'job.delivered', { sha: A });
    ledger.record('job-review', 'github.ci-green', { sha: A, repo: 'other-owner/other-repo' });
    const { result, calls } = await armReview(ledger);
    expect(result.decisions).toBe(0);
    expect(result.refusals).toBe(1);
    expect(calls).toEqual([]);
  });

  it('refuses when a NEWER failed observation lands on the same head', async () => {
    const A = 'e'.repeat(40);
    const ledger = new FakeLedger().job('job-review', 'delivered');
    ledger.record('job-review', 'job.delivered', { sha: A });
    ledger.record('job-review', 'github.ci-green', { sha: A });
    ledger.record('job-review', 'github.ci-failed', { sha: A });
    const { result, calls } = await armReview(ledger);
    expect(result.decisions).toBe(0);
    expect(result.refusals).toBe(1);
    expect(calls).toEqual([]);
  });

  it('refuses when the newer branch-state cursor reports pending on the same head', async () => {
    const A = 'e'.repeat(40);
    const ledger = new FakeLedger().job('job-review', 'delivered');
    ledger.record('job-review', 'job.delivered', { sha: A });
    ledger.record('job-review', 'github.ci-green', { sha: A });
    ledger.record('job-review', 'github.branch-state', { sha: A, ci: { sha: A, status: 'pending' } });
    const { result, calls } = await armReview(ledger);
    expect(result.decisions).toBe(0);
    expect(result.refusals).toBe(1);
    expect(calls).toEqual([]);
  });

  it('does not fall back to an older green when the NEWEST observation is malformed', async () => {
    const A = 'e'.repeat(40);
    const ledger = new FakeLedger().job('job-review', 'delivered');
    ledger.record('job-review', 'job.delivered', { sha: A });
    ledger.record('job-review', 'github.ci-green', { sha: A });
    // A newer malformed signal (no sha) must not fall back to the older green.
    ledger.record('job-review', 'github.ci-failed', { note: 'malformed newest observation' });
    const { result, calls } = await armReview(ledger);
    expect(result.decisions).toBe(0);
    expect(result.refusals).toBe(1);
    expect(calls).toEqual([]);
  });

  it('refuses when the newest branch-state carries no usable ci state', async () => {
    const A = 'e'.repeat(40);
    const ledger = new FakeLedger().job('job-review', 'delivered');
    ledger.record('job-review', 'job.delivered', { sha: A });
    ledger.record('job-review', 'github.ci-green', { sha: A });
    ledger.record('job-review', 'github.branch-state', { sha: A, ci: null });
    const { result, calls } = await armReview(ledger);
    expect(result.decisions).toBe(0);
    expect(result.refusals).toBe(1);
    expect(calls).toEqual([]);
  });
});

describe('F-M3 the conflict failure cutoff pages the whole durable history', () => {
  it('refuses after two matching failures behind more than one page of unrelated failures', async () => {
    const ledger = new FakeLedger().job('job-conflict', 'working');
    const fingerprint = `pr-conflict:${'b'.repeat(40)}`;
    for (let index = 0; index < 1_000; index += 1) {
      ledger.state.failedDirectives.push({
        jobId: 'job-conflict',
        requestId: `000${String(index).padStart(4, '0')}`,
        payload: JSON.stringify({ blocker_fingerprint: 'pr-conflict:other' }),
      });
    }
    for (const requestId of ['zzzz-match-1', 'zzzz-match-2']) {
      ledger.state.failedDirectives.push({
        jobId: 'job-conflict',
        requestId,
        payload: JSON.stringify({ blocker_fingerprint: fingerprint }),
      });
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
  });
});

describe('F-H2 the admission boundary re-proves a hold that lands after planning', () => {
  it('refuses a re-brief when its coverage hold lands during the awaited supersession', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-fh2-w', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    const hold = { signal: 'verdict-rung-rebrief', basis: 'verdict:round-late' };
    let held = false;
    const wave = waveStub({
      clearLaneForWriter: async () => {
        if (!held) {
          held = true;
          ledger.recordDecision({
            subject: `job:${job.id}`,
            decision: 'hold',
            covers: ['verdict-rung-rebrief'],
            basisFingerprint: 'verdict:round-late',
            by: 'owner',
            reason: 'owner hold arrived during the awaited supersession',
          });
        }
        return undefined;
      },
    });
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave,
      registry: {} as never,
      worktrees: {} as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await ops.sendRebrief({ jobId: job.id, note: 'n', ruleId: 'verdict-rung-rebrief', sourceRoundId: 'round-late', hold });
    await ops.drain();
    expect(held).toBe(true);
    // Proven no-effect refusal: the durable request FAILS by name (never left
    // live for reconcile) and nothing was prompted.
    const [request] = ledger.listPendingDirectives({ jobId: job.id });
    expect(request?.state).toBe('failed');
    expect(request?.failReason).toMatch(/refused before any prompt.*covers verdict-rung-rebrief/);
    expect(ledger.listPendingDirectives({ jobId: job.id, states: LIVE_DIRECTIVE_STATES, limit: 5 })).toEqual([]);
  });

  it('refuses a directive when its coverage hold lands during the awaited supersession', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-fh2-d', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    const hold = { signal: 'verdict-rung-directive', basis: 'verdict:round-late' };
    let held = false;
    const wave = waveStub({
      clearLaneForWriter: async () => {
        held = true;
        ledger.recordDecision({
          subject: `job:${job.id}`,
          decision: 'hold',
          covers: ['verdict-rung-directive'],
          basisFingerprint: 'verdict:round-late',
          by: 'owner',
          reason: 'owner hold arrived during the awaited supersession',
        });
        return undefined;
      },
    });
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave,
      registry: {} as never,
      worktrees: {} as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await ops.sendDirective({ jobId: job.id, directive: 'x', ruleId: 'verdict-rung-directive', sourceRoundId: 'round-late', hold });
    await vi.waitFor(() => expect(held).toBe(true));
    await ops.drain();
    expect(ledger.latestJobEvent(job.id, 'silas.directive-sent')).toBeNull();
    expect(ledger.listPendingDirectives({ jobId: job.id })[0]?.state).not.toBe('settled');
  });
});

describe('#368 review admission receipts and the final pull-request binding', () => {
  const A = 'f'.repeat(40);
  const base = (requestReview: SilasAutopilotOpsDeps['wave']['requestReview'], prUrl: string | null = null) => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-368', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    ledger.setJobStatus(job.id, 'delivered');
    if (prUrl !== null) ledger.setJobPr(job.id, prUrl);
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: job.id, payload: { sha: A } });
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub({ requestReview }),
      registry: {} as never,
      worktrees: { listWorktrees: () => [] } as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    return { ledger, job, ops };
  };

  it('a busy branch defers the review with a durable receipt instead of failing the pass', async () => {
    const { ledger, job, ops } = base(async () => {
      throw new BranchBusyError('gru/job-368', [{ jobId: 'job-other', status: 'working', branch: 'gru/job-368' } as never], 'arm');
    });
    await ops.triggerReview({ jobId: job.id, ruleId: 'pr-review-trigger', targetRef: A, boundDeliveredSha: A });
    const deferred = ledger.latestJobEvent(job.id, 'silas.review-deferred');
    expect(deferred?.payload).toMatchObject({ phase: 'arm', blockers: [expect.objectContaining({ job_id: 'job-other', status: 'working' })] });
    expect(ledger.latestJobEvent(job.id, 'silas.review-triggered')).toBeNull();
  });

  it('a non-Perkins route is recorded as deferred, never as an armed review', async () => {
    const { ledger, job, ops } = base(async () => ({ route: 'bmad-review-fallback', failedLegs: [], skillInstalled: false, clearToMerge: false, run: Promise.resolve() }) as never);
    await ops.triggerReview({ jobId: job.id, ruleId: 'pr-review-trigger', targetRef: A, boundDeliveredSha: A });
    expect(ledger.latestJobEvent(job.id, 'silas.review-deferred')?.payload).toMatchObject({ route: 'bmad-review-fallback' });
    expect(ledger.latestJobEvent(job.id, 'silas.review-triggered')).toBeNull();
  });

  it('the final admission guard binds the CI observation to the job pull request: none or another PR refuses', async () => {
    let guard: (() => void) | undefined;
    const { ledger, job, ops } = base(async (input) => {
      guard = input.finalAdmissionGuard;
      throw new Error('captured');
    }, 'https://github.com/mssoka/gru-command/pull/42');
    await expect(ops.triggerReview({ jobId: job.id, ruleId: 'pr-review-trigger', targetRef: A, boundDeliveredSha: A })).rejects.toThrow('captured');
    expect(guard).toBeDefined();
    ledger.appendCustomEvent({ kind: 'github.ci-green', jobId: job.id, payload: { sha: A } });
    expect(() => guard!()).toThrow(/carries no pull-request binding/);
    ledger.appendCustomEvent({ kind: 'github.ci-green', jobId: job.id, payload: { sha: A, pr: 7 } });
    expect(() => guard!()).toThrow(/belongs to a different pull request/);
    ledger.appendCustomEvent({ kind: 'github.ci-green', jobId: job.id, payload: { sha: A, pr: 42 } });
    expect(() => guard!()).not.toThrow();
  });
});

describe('F-H3 verification ownership is re-proved after the pacing wait', () => {
  it('a directive queued behind pacing never prompts after a verification takes the lane', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-fh3', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    ledger.registerAgent({ id: 'min-fh3', role: 'minion', jobId: job.id });
    ledger.setAgentState('min-fh3', 'idle');
    let prompted = 0;
    const lanes = await nativeLanes(job.id, ledger);
    const handle = nativeHandle({
      ...idleHandle('min-fh3'),
      async prompt() {
        prompted += 1;
      },
    }, lanes, job.id);
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const holder = await gate.acquireWorkerTurn({ id: 'holder', label: 'hold the pool' });
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub(),
      registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
      worktrees: lanes,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
      workerGate: gate,
    });
    await ops.sendDirective({ jobId: job.id, directive: 'x', ruleId: 'verdict-rung-directive', sourceRoundId: 'round-fh3' });
    await vi.waitFor(() => expect(gate.view().worker.queued).toHaveLength(1));
    // The verification takes ownership while the producer waits for its seat.
    ledger.appendCustomEvent({
      kind: 'verification.requested',
      jobId: job.id,
      payload: { scope: 'full', run_id: 'run-fh3', head: 'a'.repeat(40) },
    });
    holder.release();
    await vi.waitFor(() => expect(gate.view().worker.queued).toHaveLength(0));
    await ops.drain();
    expect(prompted).toBe(0);
    expect(ledger.latestJobEvent(job.id, 'silas.directive-sent')).toBeNull();
    // #364: the post-wait refusal is before any prompt — a positive no-effect,
    // so the request FAILS by name and never stays live fencing the lane.
    const [request] = ledger.listPendingDirectives({ jobId: job.id });
    expect(request?.state).toBe('failed');
    expect(request?.failReason).toMatch(/^refused before any prompt: .*verification/);
    expect(ledger.listPendingDirectives({ jobId: job.id, states: LIVE_DIRECTIVE_STATES, limit: 5 })).toEqual([]);
  });
});

describe('#364 only a named admission refusal fails the request', () => {
  it('a ledger fault while re-proving after the pacing wait keeps the request live for reconciliation', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-364-fault', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    ledger.registerAgent({ id: 'min-364', role: 'minion', jobId: job.id });
    ledger.setAgentState('min-364', 'idle');
    let prompted = 0;
    const lanes = await nativeLanes(job.id, ledger);
    const handle = nativeHandle({ ...idleHandle('min-364'), async prompt() { prompted += 1; } }, lanes, job.id);
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const holder = await gate.acquireWorkerTurn({ id: 'holder', label: 'hold the pool' });
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub(),
      registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
      worktrees: lanes,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
      workerGate: gate,
    });
    await ops.sendDirective({ jobId: job.id, directive: 'x', ruleId: 'verdict-rung-directive', sourceRoundId: 'round-364' });
    await vi.waitFor(() => expect(gate.view().worker.queued).toHaveLength(1));
    // The verification-ownership re-read itself fails after the wait.
    vi.spyOn(ledger, 'hasUnsettledVerificationRun').mockImplementation(() => { throw new Error('ledger read failed'); });
    holder.release();
    await vi.waitFor(() => expect(gate.view().worker.queued).toHaveLength(0));
    await ops.drain();
    expect(prompted).toBe(0);
    const [request] = ledger.listPendingDirectives({ jobId: job.id });
    expect(request?.state).not.toBe('failed');
    expect(ledger.listPendingDirectives({ jobId: job.id, states: LIVE_DIRECTIVE_STATES, limit: 5 })).toHaveLength(1);
  });
});

describe('F-H4 the shutdown producer join settles after disposal releases the handle', () => {
  it('a RUNNING gated re-brief producer is released by disposal before the join settles', async () => {
    const repo = makeFixtureRepo();
    repos.push(repo);
    const laneRoot = mkdtempSync(join(tmpdir(), 'fh4-rebrief-lanes-'));
    dirs.push(laneRoot);
    const ledger = newRealLedger();
    const lanes = new InMemoryWorktreePort(laneRoot, ledger);
    const job = ledger.addJob({ id: 'job-fh4r', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    await lanes.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    let entered = false;
    let disposed = false;
    let openPrompt!: () => void;
    const promptGate = new Promise<void>((resolve) => {
      openPrompt = resolve;
    });
    // The running re-brief awaits its prompt directly; only DISPOSING the
    // handle (production: registry.dispose()) rejects it — the stop signal
    // does not reach this open await.
    const handle = nativeHandle({
      ...idleHandle('min-fh4r'),
      async prompt() {
        entered = true;
        await promptGate;
        if (disposed) throw new Error('handle disposed during shutdown');
      },
      async dispose() {
        disposed = true;
        openPrompt();
      },
    }, lanes, job.id);
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub(),
      registry: {
        getHandle: () => null,
        spawn: async () => handle,
        disposeHandle: async () => {
          await handle.dispose();
        },
      },
      worktrees: lanes,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await ops.sendRebrief({
      jobId: job.id,
      note: 'same blocker; try differently',
      ruleId: 'verdict-rung-rebrief',
      sourceRoundId: 'round-fh4',
    });
    await vi.waitFor(() => expect(entered).toBe(true));
    // Production shutdown order: the registry disposal releases the running
    // producer's handle BEFORE the join. No invented grace/ceiling is used.
    await handle.dispose();
    const drained = await ops.drain();
    expect(drained.settled).toBe(true);
    expect(drained.pending).toBe(0);
    // Honest accounting: the PRODUCER settled, but the unresolved request
    // request remains live (ownership retained, never fabricated as ceased).
    expect(ledger.listPendingDirectives({ jobId: job.id, states: LIVE_DIRECTIVE_STATES, limit: 5 }).length).toBeGreaterThan(0);
  }, 30_000);
});

describe('F-M4 the production composition fails the pass on either half failure', () => {
  const drivePass = async (durableOk: boolean, autopilotOk: boolean) => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-fm4', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    const driver = new SilasDriver({
      slot: {
        ensure: async () => {
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
        autopilot: { enabled: false, rules: {} },
      },
      skills: [],
      now: () => 0,
      setInterval: (() => 1) as unknown as typeof setInterval,
      clearInterval: (() => {}) as never,
      onDeterministicPass: composeDeterministicPass(
        async () => ({ ok: durableOk, durable: true }),
        async () => ({ ok: autopilotOk, autopilot: true }),
      ),
    });
    await driver.trigger({ kind: 'job.delivered', jobId: job.id });
    const events = ledger.listEvents({ limit: 500 });
    return {
      failed: events.some((event) => event.kind === 'silas.reconcile-failed'),
      completed: events.some((event) => event.kind === 'silas.reconcile'),
    };
  };

  it('fails the pass when the durable half fails and the autopilot succeeds', async () => {
    const outcome = await drivePass(false, true);
    expect(outcome.failed).toBe(true);
    expect(outcome.completed).toBe(false);
  });

  it('fails the pass when the autopilot half fails and the durable succeeds', async () => {
    const outcome = await drivePass(true, false);
    expect(outcome.failed).toBe(true);
    expect(outcome.completed).toBe(false);
  });

  it('records a completed reconciliation when both halves succeed (control)', async () => {
    const outcome = await drivePass(true, true);
    expect(outcome.failed).toBe(false);
    expect(outcome.completed).toBe(true);
  });
});

describe('F-M1 the real driver does not wake for verdict work an accepted producer owns', () => {
  const driveWakes = async (ledger: LedgerApi, jobId: string): Promise<number> => {
    const prompts: string[] = [];
    const handle = {
      ...idleHandle('silas-fm1'),
      role: 'silas' as const,
      async prompt(text: string) {
        prompts.push(text);
      },
    } satisfies AgentHandle;
    const driver = new SilasDriver({
      slot: { ensure: async () => handle, viewFor: () => null } as never,
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
        autopilot: { enabled: false, rules: {} },
      },
      skills: [],
      now: () => 0,
      setInterval: (() => 1) as unknown as typeof setInterval,
      clearInterval: (() => {}) as never,
    });
    await driver.trigger({ kind: 'job.delivered', jobId });
    return prompts.length;
  };

  const seedVerdictJob = (ledger: LedgerApi, jobId: string): void => {
    ledger.addJob({ id: jobId, repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'b' });
    ledger.setJobStatus(jobId, 'working');
    ledger.setJobStatus(jobId, 'in-review');
    const round = ledger.addRound({ jobId, targetRef: 'a'.repeat(40) });
    ledger.setRoundStatus(round.id, 'live');
    ledger.setRoundVerdict(round.id, 'changes-requested');
  };

  it('a gated LIVE accepted directive suppresses the redundant model wake', async () => {
    const ledger = newRealLedger();
    const jobId = 'job-fm1w';
    seedVerdictJob(ledger, jobId);
    const lanes = await nativeLanes(jobId, ledger);
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = nativeHandle({
      ...idleHandle('min-fm1w'),
      async prompt() {
        entered = true;
        await gate;
      },
    }, lanes, jobId);
    ledger.registerAgent({ id: 'min-fm1w', role: 'minion', jobId, sessionFile: handle.sessionFile });
    ledger.setAgentState('min-fm1w', 'idle');
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub(),
      registry: { getHandle: () => handle, spawn: async () => handle, disposeHandle: async () => {} },
      worktrees: lanes,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await ops.sendDirective({ jobId, directive: 'x', ruleId: 'verdict-rung-directive', sourceRoundId: 'round-x' });
    await vi.waitFor(() => expect(entered).toBe(true));
    // The accepted producer owns the lane: the driver must not buy a turn.
    expect(await driveWakes(ledger, jobId)).toBe(0);
    release();
    await vi.waitFor(() => expect((ledger.getDirective(ledger.listPendingDirectives({ jobId })[0]?.requestId ?? '')?.state ?? '') === 'settled'));
  }, 30_000);

  it('a terminally REFUSED directive still publishes the row (wake control)', async () => {
    const ledger = newRealLedger();
    const jobId = 'job-fm1refuse';
    seedVerdictJob(ledger, jobId);
    const begun = ledger.beginDirectiveIntent({ jobId, directive: 'x', holder: 'silas-ops' });
    ledger.failDirective({ requestId: begun.record.requestId, reason: 'fixture no-effect refusal' });
    expect(await driveWakes(ledger, jobId)).toBe(1);
  }, 30_000);

  it('a gated LIVE accepted re-brief suppresses the redundant model wake', async () => {
    const repo = makeFixtureRepo();
    repos.push(repo);
    const laneRoot = mkdtempSync(join(tmpdir(), 'fm1-rebrief-lanes-'));
    dirs.push(laneRoot);
    const ledger = newRealLedger();
    const lanes = new InMemoryWorktreePort(laneRoot, ledger);
    const jobId = 'job-fm1rebrief';
    seedVerdictJob(ledger, jobId);
    await lanes.createJobWorktree({ repoPath: repo.path, jobId });
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = nativeHandle({
      ...idleHandle('min-fm1rebrief'),
      async prompt() {
        entered = true;
        await gate;
      },
    }, lanes, jobId);
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub(),
      registry: { getHandle: () => null, spawn: async () => handle, disposeHandle: async () => {} },
      worktrees: lanes,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });
    await ops.sendRebrief({ jobId, note: 'same blocker; try differently', ruleId: 'verdict-rung-rebrief', sourceRoundId: 'round-x' });
    await vi.waitFor(() => expect(entered).toBe(true));
    expect(await driveWakes(ledger, jobId)).toBe(0);
    release();
    await vi.waitFor(() => expect(ledger.listPendingDirectives({ jobId, states: LIVE_DIRECTIVE_STATES, limit: 5 })).toHaveLength(0));
  }, 30_000);
});

describe('F-H3 verification ownership re-proved at the fresh-spawn and re-brief boundaries', () => {
  it('a FRESH-spawn directive never spawns after verification takes the lane during the pacing wait', async () => {
    const repo = makeFixtureRepo();
    repos.push(repo);
    const laneRoot = mkdtempSync(join(tmpdir(), 'fh3-fresh-lanes-'));
    dirs.push(laneRoot);
    const ledger = newRealLedger();
    const lanes = new InMemoryWorktreePort(laneRoot, ledger);
    const job = ledger.addJob({ id: 'job-fh3-fresh', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    await lanes.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    let spawns = 0;
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const holder = await gate.acquireWorkerTurn({ id: 'holder', label: 'hold the pool' });
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub(),
      registry: {
        getHandle: () => null,
        spawn: async () => {
          spawns += 1;
          throw new Error('must not spawn after verification took the lane');
        },
        disposeHandle: async () => {},
      },
      worktrees: lanes,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
      workerGate: gate,
    });
    await ops.sendDirective({ jobId: job.id, directive: 'x', ruleId: 'verdict-rung-directive', sourceRoundId: 'r' });
    await vi.waitFor(() => expect(gate.view().worker.queued).toHaveLength(1));
    ledger.appendCustomEvent({
      kind: 'verification.requested',
      jobId: job.id,
      payload: { scope: 'full', run_id: 'run-fh3-fresh', head: 'a'.repeat(40) },
    });
    holder.release();
    await vi.waitFor(() => expect(gate.view().worker.queued).toHaveLength(0));
    await ops.drain();
    expect(spawns).toBe(0);
    expect(ledger.latestJobEvent(job.id, 'silas.directive-sent')).toBeNull();
  }, 30_000);

  it('a re-brief never spawns after verification takes the lane during the pacing wait', async () => {
    const repo = makeFixtureRepo();
    repos.push(repo);
    const laneRoot = mkdtempSync(join(tmpdir(), 'fh3-rebrief-lanes-'));
    dirs.push(laneRoot);
    const ledger = newRealLedger();
    const lanes = new InMemoryWorktreePort(laneRoot, ledger);
    const job = ledger.addJob({ id: 'job-fh3-rebrief', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    await lanes.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    let spawns = 0;
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const holder = await gate.acquireWorkerTurn({ id: 'holder', label: 'hold the pool' });
    const ops = createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave: waveStub(),
      registry: {
        getHandle: () => null,
        spawn: async () => {
          spawns += 1;
          throw new Error('must not spawn after verification took the lane');
        },
        disposeHandle: async () => {},
      },
      worktrees: lanes,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
      workerGate: gate,
    });
    await ops.sendRebrief({ jobId: job.id, note: 'n', ruleId: 'verdict-rung-rebrief', sourceRoundId: 'r' });
    await vi.waitFor(() => expect(gate.view().worker.queued).toHaveLength(1));
    ledger.appendCustomEvent({
      kind: 'verification.requested',
      jobId: job.id,
      payload: { scope: 'full', run_id: 'run-fh3-rebrief', head: 'a'.repeat(40) },
    });
    holder.release();
    await vi.waitFor(() => expect(gate.view().worker.queued).toHaveLength(0));
    await ops.drain();
    expect(spawns).toBe(0);
    // The refusal closes the durable markers: a pending marker would wedge the
    // lane and a boot reconcile would re-deliver a re-brief the pass refused.
    expect(ledger.listPendingRebriefs({ jobId: job.id })).toEqual([]);
  }, 30_000);
});

describe('enforce-mode writer admission gaps (PR349 independent review)', () => {
  const retireWithOpenHold = (ledger: LedgerApi, jobId: string): string => {
    const begun = ledger.beginDirectiveIntent({ jobId, directive: 'earlier', holder: 'silas-ops' });
    const { db } = ledger as unknown as { readonly db: import('node:sqlite').DatabaseSync };
    db.prepare("UPDATE pending_directives SET state = 'retired', hold_released_by = NULL WHERE request_id = ?").run(begun.record.requestId);
    expect(ledger.hasOpenDirectiveRecoveryHold(jobId)).toBe(true);
    return begun.record.requestId;
  };
  const opsFor = (ledger: LedgerApi, wave = waveStub()) =>
    createSilasAutopilotOps({
      ...nativeSeams,
      ledger,
      wave,
      registry: {} as never,
      worktrees: {} as never,
      dispatch: { recordPr: () => ({ prUrl: null }) },
      gh: { listPullsForHead: async () => [] },
      resolveRemote: () => null,
    });

  it('a directive refuses (and releases NOTHING) when a recovery hold landed after planning', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-rh-d', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    retireWithOpenHold(ledger, job.id);
    await expect(
      opsFor(ledger).sendDirective({ jobId: job.id, directive: 'x', ruleId: 'verdict-rung-directive', sourceRoundId: 'r' }),
    ).rejects.toThrow(/directive-recovery hold/);
    expect(ledger.hasOpenDirectiveRecoveryHold(job.id)).toBe(true);
    expect(ledger.listPendingDirectives({ jobId: job.id, states: LIVE_DIRECTIVE_STATES, limit: 5 })).toEqual([]);
  });

  it('a re-brief refuses (and releases NOTHING) when a recovery hold landed after planning', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-rh-r', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    retireWithOpenHold(ledger, job.id);
    await expect(
      opsFor(ledger).sendRebrief({ jobId: job.id, note: 'n', ruleId: 'verdict-rung-rebrief', sourceRoundId: 'r' }),
    ).rejects.toThrow(/directive-recovery hold/);
    expect(ledger.hasOpenDirectiveRecoveryHold(job.id)).toBe(true);
    expect(ledger.listPendingDirectives({ jobId: job.id, states: LIVE_DIRECTIVE_STATES, limit: 5 })).toEqual([]);
  });

  it('a re-brief whose request is refused by the ledger supersedes NO review', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-rb-order', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    // A different live writer request: beginRebriefIntent refuses by name.
    ledger.beginDirectiveIntent({ jobId: job.id, directive: 'live', holder: 'silas-ops' });
    let cleared = 0;
    const ops = opsFor(ledger, waveStub({ clearLaneForWriter: async () => { cleared += 1; return undefined; } }));
    await expect(
      ops.sendRebrief({ jobId: job.id, note: 'n', ruleId: 'verdict-rung-rebrief', sourceRoundId: 'r' }),
    ).rejects.toThrow(/already live/);
    expect(cleared).toBe(0);
  });

  it('a directive whose verification took the lane during supersession FAILS by name, not reconcile', async () => {
    const ledger = newRealLedger();
    const job = ledger.addJob({ id: 'job-c-fail', repo: 'gru-command', title: 't', baseBranch: 'main', briefing: 'x' });
    ledger.setJobStatus(job.id, 'working');
    const wave = waveStub({
      clearLaneForWriter: async () => {
        ledger.appendCustomEvent({ kind: 'verification.requested', jobId: job.id, payload: { scope: 'full', run_id: 'run-c', head: 'a'.repeat(40) } });
        return undefined;
      },
    });
    await opsFor(ledger, wave).sendDirective({ jobId: job.id, directive: 'x', ruleId: 'verdict-rung-directive', sourceRoundId: 'r' });
    await vi.waitFor(() => expect(ledger.listPendingDirectives({ jobId: job.id })[0]?.state).toBe('failed'));
    expect(ledger.listPendingDirectives({ jobId: job.id })[0]?.failReason).toMatch(/refused before any prompt.*verification/);
  });
});
