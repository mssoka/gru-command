/**
 * Silas autopilot (issue #243) — the unambiguous rule families executed in
 * plain code, BEFORE any LLM wake.
 *
 * Every family reads the freshly computed digest and RE-READS the ownership
 * fences immediately before acting — live directives, pending re-briefs,
 * in-flight verification, directive-recovery holds and decision-memory
 * holds (#218) — then calls the SAME service functions the matching HTTP
 * endpoint composes, never HTTP. Each action's receipt carries `rule_id`
 * and `source: 'silas-autopilot'`.
 *
 * Decision-memory holds (#218): the publish boundary does NOT apply them;
 * this module asks the coverage query itself for each row (see
 * {@link decisionHold}). The signal is the mailbox incident vocabulary
 * where one is established (`pr-conflict`, `verification-failure`); every
 * other family uses its own landed rule id as the signal — the deliberate
 * mapping for families whose vocabulary the mailbox does not name.
 *
 * Posture (the issue's rollout):
 *  - `enabled` is the global kill switch. When it is false nothing is
 *    recorded and nothing is called.
 *  - every family's mode defaults to `dry-run`: the decision is recorded
 *    as a `silas.autopilot-decision` event naming the call it WOULD make,
 *    and no call is made. `enforce` performs exactly one call. `off` does
 *    neither.
 *  - a REFUSAL is not a decision: the family declines (the case is not
 *    unambiguous), records nothing that #214 could read as agreement, and
 *    leaves the row to LLM Silas. Refusals are logged and counted.
 *
 * Deterministic ambiguity boundaries, stated once so a reviewer can hold
 * the code to them:
 *  - a verdict row fires ONE family, chosen by the rung its recurring
 *    blockers uniformly name. A row whose blockers disagree is a judgment
 *    about which correction to make now, and stays with LLM Silas.
 *  - `verdict-rung-directive` requires title, location and recommended fix
 *    on every blocker: a templated bullet never invents one.
 *  - `verdict-rung-escalate` is not an autopilot family at all.
 */
import type { SilasAutopilotConfig, SilasAutopilotRuleMode } from '../config.js';
import type { LedgerApi } from '../ledger/api.js';
import { LIVE_DIRECTIVE_STATES } from '../ledger/directives.js';
import type { LogLevel } from '../logger.js';
import { SILAS_AUTOPILOT_RULE_IDS, type SilasAutopilotRuleId } from './silas-rules.js';
import {
  deliveredTargetSha,
  type ConflictingPrRow,
  type DeliveredWithoutPrRow,
  type DigestRecurringBlocker,
  type PrWithoutReviewRow,
  type ReleaseEligibleRow,
  type SilasOpsDigest,
  type VerdictAwaitingDirectiveRow,
  type VerificationFailureRow,
} from './silas-driver.js';

/** The decision event dry-run records (and enforce records too, so #214 can
 * compare every decision with what LLM Silas actually did). */
export const AUTOPILOT_DECISION_EVENT = 'silas.autopilot-decision';

/** The provenance suffix every autopilot receipt carries, so #214 can tell
 * machine actions from LLM Silas's own. */
export const AUTOPILOT_SOURCE = 'silas-autopilot';

/** Bound on the rows one family PLANS per pass (decisions + refusals): the
 * pass runs inside the driver's deterministic hook and must stay bounded.
 * It is applied BEFORE the planner runs, so a surplus row never spends a
 * planner side effect (the delivered-pr-register GitHub lookup) just to be
 * dropped. A skipped row is left for LLM Silas exactly as a refusal is. */
const MAX_ROWS_PER_FAMILY = 20;

/** One open pull request as the PR-registration family consumes it. */
export interface AutopilotPull {
  readonly number: number;
  readonly url: string;
}

/**
 * The service seam. Each method performs the SAME call sequence over the
 * same service functions the matching HTTP endpoint uses — never HTTP. A
 * throw is a failed action: the row stays for LLM Silas and no receipt is
 * claimed.
 */
export interface SilasAutopilotOps {
  /** `gh pr list --repo <repo> --head <branch> --state open --json
   * number,url` through github-poll's gh port, resolved from the lane's
   * own remote (the lane path is the only repo handle the digest carries). */
  readonly listOpenPrsForHead: (input: {
    readonly repoPath: string;
    readonly branch: string;
  }) => Promise<readonly AutopilotPull[]>;
  /** The function `POST /api/dispatch/pr` calls. */
  readonly registerPr: (input: {
    readonly jobId: string;
    readonly url: string;
    readonly ruleId: SilasAutopilotRuleId;
  }) => Promise<void>;
  /** The function `POST /api/dispatch/review` calls. `targetRef`/
   * `boundDeliveredSha` bind the reviewed head to the sha the green proved
   * (issue #187); the clean-abort re-arm derives the same binding from its
   * source round. */
  readonly triggerReview: (input: {
    readonly jobId: string;
    readonly ruleId: SilasAutopilotRuleId;
    readonly sourceRoundId?: string;
    readonly targetRef?: string;
    readonly boundDeliveredSha?: string;
  }) => Promise<void>;
  /** The function `POST /api/silas/directive` calls. */
  readonly sendDirective: (input: {
    readonly jobId: string;
    readonly directive: string;
    readonly ruleId: SilasAutopilotRuleId;
    readonly blockerFingerprint?: string;
    readonly sourceRoundId?: string;
  }) => Promise<void>;
  /** The function `POST /api/silas/rebrief` calls. */
  readonly sendRebrief: (input: {
    readonly jobId: string;
    readonly note: string;
    readonly ruleId: SilasAutopilotRuleId;
    readonly sourceRoundId: string;
  }) => Promise<void>;
  /** The function `POST /api/dispatch/release` calls for a sweep-ack. */
  readonly releaseLane: (input: {
    readonly jobId: string;
    readonly ruleId: SilasAutopilotRuleId;
  }) => Promise<void>;
}

/** The ledger surface the families read and receipt through. */
export type AutopilotLedger = Pick<
  LedgerApi,
  | 'appendCustomEvent'
  | 'getJob'
  | 'getRound'
  | 'latestJobEvent'
  | 'getDirective'
  | 'listJobEventsByKinds'
  | 'listPendingRebriefs'
  | 'listPendingDirectives'
  | 'hasOpenDirectiveRecoveryHold'
  | 'hasUnsettledVerificationRun'
  | 'coveringDecision'
>;

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/** One family's resolved setting for this pass. */
export function autopilotRuleMode(
  config: SilasAutopilotConfig,
  ruleId: SilasAutopilotRuleId,
): SilasAutopilotRuleMode {
  return config.rules[ruleId] ?? 'dry-run';
}

/** A call the family would make (recorded verbatim in the decision event,
 * then performed by {@link performCall} in enforce mode — the decision and
 * the call can never carry different bodies). */
interface AutopilotCall {
  readonly action: string;
  readonly wouldCall: Record<string, unknown>;
}

type Verdict =
  | { readonly kind: 'act'; readonly call: AutopilotCall }
  | { readonly kind: 'refuse'; readonly reason: string };

const refuse = (reason: string): Verdict => ({ kind: 'refuse', reason });
const act = (action: string, wouldCall: Record<string, unknown>): Verdict => ({ kind: 'act', call: { action, wouldCall } });

/** Rung agreement: the rung EVERY blocker of the row names, or null when
 * they disagree (a judgment call, left to LLM Silas). */
function uniformAdvice(blockers: readonly DigestRecurringBlocker[]): string | null {
  const first = blockers[0];
  if (first === undefined) return null;
  return blockers.every((blocker) => blocker.advice === first.advice) ? first.advice : null;
}

// ------------------------------------------------------------------
// Templates (one per code action; deterministic text, no model)
// ------------------------------------------------------------------

export function renderBlockerDirective(row: VerdictAwaitingDirectiveRow): string {
  return [
    `Fix directive for job ${row.jobId} — Perkins round ${row.roundId} returned changes-requested.`,
    '',
    'Resolve every blocker below in your own worktree, then verify and push normally:',
    '',
    ...row.recurringBlockers.flatMap((blocker) => [
      `- ${blocker.title} (${blocker.location})`,
      `  Recommended fix: ${blocker.recommendedFix ?? ''}`,
    ]),
    '',
    'Push the repair on the same branch; the re-review arms when your delivery lands.',
    `Do not widen scope beyond these ${row.recurringBlockers.length} blocker(s).`,
  ].join('\n');
}

export function renderVerificationRepairDirective(row: VerificationFailureRow): string {
  return [
    `Verification repair for job ${row.jobId}: the newest ${row.scope ?? ''} verification run FAILED.`,
    '',
    `Recorded failure: ${row.detail}`,
    `Run: ${row.runId ?? 'unknown'}${row.head === null ? '' : ` at head ${row.head}`}`,
    '',
    'Repair the real cause in your own worktree — never weaken the gate, and never',
    're-run an unchanged head merely to recover logs. When the repair is pushed,',
    'submit a NEW verification at the repaired head with a new request id through',
    'the shipped capture helper.',
  ].join('\n');
}

export function renderConflictDirective(row: ConflictingPrRow): string {
  return [
    `Conflict integration for job ${row.jobId}${row.prUrl === null ? '' : ` (${row.prUrl})`}: the open PR head is dirty against its base.`,
    '',
    'Merge the PR base into your task branch and resolve the conflicts in your own',
    "worktree: keep the base's established changes and the agreed feature, record",
    'the actual input SHAs, then verify and push normally — never rebase, reset or',
    'force-push, and never move a head under an active review freeze.',
  ].join('\n');
}

export function renderRebriefNote(row: VerdictAwaitingDirectiveRow): string {
  return [
    `Fresh worker needed for job ${row.jobId}: the same blocker(s) recurred across`,
    `consecutive Perkins rounds (round ${row.roundId}, rung: rebrief) — the current`,
    'worker is not converging on them. Start from the effective contract and treat',
    'each blocker as unsolved:',
    '',
    ...row.recurringBlockers.map((blocker) => `- ${blocker.title} (${blocker.location})`),
    '',
    'Do what the previous worker did not: read each blocker in the round report and',
    'change the approach rather than repeating it.',
  ].join('\n');
}

// ------------------------------------------------------------------
// Per-family planning (pure: digest row + ledger reads → verdict)
// ------------------------------------------------------------------

/** One row's #218 coverage identity: the signal family it raises and the
 * basis fingerprint the decision must have been made against. */
interface DecisionHoldTriple {
  readonly signal: string;
  readonly basis: string;
}

/** The #218 coverage query for one row (issue #218): does an active decision
 * hold actually cover this row's (subject, signal, basis)? The subject is
 * always the job — the mailbox vocabulary. A malformed decision row must
 * never take the pass down: the read fails loud in the log and the row is
 * treated as UNCOVERED (the autopilot may act), matching the awareness
 * layer's fail-toward-waking posture. */
function decisionHold(ledger: AutopilotLedger, jobId: string, triple: DecisionHoldTriple): string | null {
  const decision = ledger.coveringDecision({ subject: `job:${jobId}`, signal: triple.signal, basis: triple.basis });
  return decision === null ? null : `an active decision (${decision.id}) covers ${triple.signal}`;
}

/** Fences re-read IMMEDIATELY before acting: the digest applied them at its
 * publish boundary, and a moment has passed since. Uncertain ownership
 * fails closed — the row stays for LLM Silas. `hold` is the row's #218
 * coverage triple (absent when the family raises no signal). */
function fencesHold(ledger: AutopilotLedger, jobId: string, hold?: DecisionHoldTriple): string | null {
  const job = ledger.getJob(jobId);
  if (job === null) return 'job not found';
  if (job.status === 'merged' || job.status === 'done' || job.status === 'binned') {
    return `job is ${job.status}`;
  }
  if (ledger.listPendingRebriefs({ jobId }).length > 0) return 'a re-brief request is unresolved on this lane';
  if (ledger.listPendingDirectives({ jobId, states: LIVE_DIRECTIVE_STATES }).length > 0) {
    return 'a live directive owns this lane';
  }
  if (ledger.hasOpenDirectiveRecoveryHold(jobId)) return 'an open directive-recovery hold owns this lane';
  if (hold !== undefined) {
    const covered = decisionHold(ledger, jobId, hold);
    if (covered !== null) return covered;
  }
  return null;
}

/** The review-eligibility statuses (`reviewEligibleStatus`). */
function reviewEligible(ledger: AutopilotLedger, jobId: string): string | null {
  const job = ledger.getJob(jobId);
  if (job === null) return 'job not found';
  if (job.status !== 'working' && job.status !== 'delivered' && job.status !== 'in-review') {
    return `job is ${job.status} — no review is offered on this status`;
  }
  return null;
}

/** `verdict-rung-directive`: structured blockers → templated directive. */
function planVerdictDirective(row: VerdictAwaitingDirectiveRow, ledger: AutopilotLedger): Verdict {
  const fence = fencesHold(ledger, row.jobId, {
    signal: 'verdict-rung-directive',
    basis: `verdict:${row.roundId}`,
  });
  if (fence !== null) return refuse(fence);
  if (ledger.hasUnsettledVerificationRun(row.jobId)) return refuse('a verification is already in flight on this lane');
  for (const blocker of row.recurringBlockers) {
    if (blocker.title.trim() === '' || blocker.location.trim() === '') {
      return refuse(`blocker "${blocker.fingerprint}" lacks a title or location`);
    }
    if (blocker.recommendedFix === undefined || blocker.recommendedFix.trim() === '') {
      return refuse(`blocker "${blocker.fingerprint}" carries no recommended fix`);
    }
  }
  return act('send-directive', {
    endpoint: 'POST /api/silas/directive',
    job_id: row.jobId,
    rule_id: 'verdict-rung-directive',
    source_round_id: row.roundId,
    // The digest row's stable verdict identity, so #214's dedup and the
    // receipt's audit key match the way pr-conflict:<head> and
    // verification-failure:<scope>@<run> do (issue #243 family table).
    blocker_fingerprint: `verdict:${row.roundId}`,
    blocker_count: row.recurringBlockers.length,
    directive: renderBlockerDirective(row),
  });
}

/** `verdict-rung-rebrief`: the ladder's fresh-worker rung. */
function planVerdictRebrief(row: VerdictAwaitingDirectiveRow, ledger: AutopilotLedger): Verdict {
  const fence = fencesHold(ledger, row.jobId, {
    signal: 'verdict-rung-rebrief',
    basis: `verdict:${row.roundId}`,
  });
  if (fence !== null) return refuse(fence);
  if (ledger.hasUnsettledVerificationRun(row.jobId)) return refuse('a verification is already in flight on this lane');
  if (row.recurringBlockers.length === 0) return refuse('the verdict row carries no structured blocker to re-brief against');
  return act('send-rebrief', {
    endpoint: 'POST /api/silas/rebrief',
    job_id: row.jobId,
    rule_id: 'verdict-rung-rebrief',
    source_round_id: row.roundId,
    blocker_count: row.recurringBlockers.length,
    note: renderRebriefNote(row),
  });
}

/** `verification-repair`: the exact failed verification debt. */
function planVerificationRepair(row: VerificationFailureRow, ledger: AutopilotLedger): Verdict {
  const fence = fencesHold(ledger, row.jobId, {
    signal: 'verification-failure',
    basis: `verification-failure:${row.scope ?? ''}@${row.runId ?? ''}`,
  });
  if (fence !== null) return refuse(fence);
  // The #117 deferral: a null scope cannot be named, and the digest retires
  // the debt only on the EXACT fingerprint — an unscoped rung would re-fire
  // every pass. A null run id has the same problem.
  if (row.scope === null || row.scope.trim() === '') return refuse('the failure has no scope to name');
  if (row.runId === null || row.runId.trim() === '') return refuse('the failure has no run id to fingerprint');
  if (ledger.hasUnsettledVerificationRun(row.jobId)) return refuse('a verification is already in flight on this lane');
  return act('send-directive', {
    endpoint: 'POST /api/silas/directive',
    job_id: row.jobId,
    rule_id: 'verification-repair',
    blocker_fingerprint: `verification-failure:${row.scope}@${row.runId}`,
    directive: renderVerificationRepairDirective(row),
  });
}

/** `pr-conflict-rebase`: ONE conflict-integration directive per head. */
function planConflictRebase(row: ConflictingPrRow, ledger: AutopilotLedger): Verdict {
  const fence = fencesHold(ledger, row.jobId, {
    signal: 'pr-conflict',
    basis: row.headSha === null ? 'pr-conflict:unknown' : `pr-conflict:${row.headSha}`,
  });
  if (fence !== null) return refuse(fence);
  if (row.headSha === null || row.headSha.trim() === '') return refuse('the conflict row carries no head sha to fingerprint');
  const fingerprint = `pr-conflict:${row.headSha}`;
  const failed = ledger.listJobEventsByKinds(row.jobId, ['silas.directive-sent']).filter((event) => {
    const payload = typeof event.payload === 'object' && event.payload !== null ? event.payload : {};
    const record = payload as { blocker_fingerprint?: unknown; request_id?: unknown };
    if (record.blocker_fingerprint !== fingerprint || typeof record.request_id !== 'string') return false;
    return ledger.getDirective(record.request_id)?.state === 'failed';
  });
  if (failed.length >= 2) {
    return refuse(`a conflict-integration directive for head ${row.headSha.slice(0, 12)} already failed ${failed.length}×`);
  }
  return act('send-directive', {
    endpoint: 'POST /api/silas/directive',
    job_id: row.jobId,
    rule_id: 'pr-conflict-rebase',
    blocker_fingerprint: fingerprint,
    directive: renderConflictDirective(row),
  });
}

/** `clean-abort-service-restart`: re-arm the proved clean abort's head. */
function planCleanAbortRebrief(row: PrWithoutReviewRow, ledger: AutopilotLedger): Verdict {
  const cleanAbort = row.cleanAbort;
  if (cleanAbort === undefined) return refuse('the row is not a clean-abort row');
  const eligible = reviewEligible(ledger, row.jobId);
  if (eligible !== null) return refuse(eligible);
  const fence = fencesHold(ledger, row.jobId, {
    signal: 'clean-abort-service-restart',
    basis: `round:${cleanAbort.roundId}`,
  });
  if (fence !== null) return refuse(fence);
  const round = ledger.getRound(cleanAbort.roundId);
  if (round === null || round.jobId !== row.jobId) return refuse('the clean-abort round does not belong to this job');
  // Freshness: the re-arm freezes the PROVED delivered head, so a delivery
  // that moved the head since the abort makes the re-arm stale.
  const delivered = ledger.latestJobEvent(row.jobId, 'job.delivered');
  const sha = delivered === null ? null : deliveredTargetSha(delivered);
  if (sha === null) return refuse('the delivered head is not resolvable — the re-arm cannot be bound');
  if (round.targetRef !== sha) return refuse('the delivered head moved since the aborted round — the re-arm is stale');
  return act('trigger-review', {
    endpoint: 'POST /api/dispatch/review',
    job_id: row.jobId,
    rule_id: 'clean-abort-service-restart',
    source_round_id: cleanAbort.roundId,
  });
}

/** `pr-review-trigger`: arm the first/re-review on a green delivered head. */
function planReviewTrigger(row: PrWithoutReviewRow, ledger: AutopilotLedger): Verdict {
  if (row.cleanAbort !== undefined) return refuse('the clean-abort rule owns this row');
  const eligible = reviewEligible(ledger, row.jobId);
  if (eligible !== null) return refuse(eligible);
  const job = ledger.getJob(row.jobId);
  const fence = fencesHold(ledger, row.jobId, {
    signal: 'pr-review-trigger',
    basis: job === null ? 'pr-review:unknown' : `pr-review:${job.prUrl ?? 'none'}`,
  });
  if (fence !== null) return refuse(fence);
  // #187's final eligibility recheck: the green must be ON the delivered
  // head — a green from an older commit never authorizes the arm.
  const delivered = ledger.latestJobEvent(row.jobId, 'job.delivered');
  const deliveredSha = delivered === null ? null : deliveredTargetSha(delivered);
  if (deliveredSha === null) return refuse('the delivered head is not resolvable — the arm cannot be bound');
  const green = ledger.latestJobEvent(row.jobId, 'github.ci-green');
  const greenSha =
    green !== null && typeof green.payload === 'object' && green.payload !== null
      ? (green.payload as { sha?: unknown }).sha
      : null;
  if (typeof greenSha !== 'string' || greenSha !== deliveredSha) {
    return refuse('no github.ci-green observation on the delivered head');
  }
  // The reviewed head is the one the green proved: bind it exactly, so the
  // awaited review setup cannot re-resolve a newer live PR head and the
  // freeze boundary re-proves the same delivered sha (issue #187).
  return act('trigger-review', {
    endpoint: 'POST /api/dispatch/review',
    job_id: row.jobId,
    rule_id: 'pr-review-trigger',
    target_ref: deliveredSha,
    bound_delivered_sha: deliveredSha,
  });
}

/** `sweep-ack`: release a terminal job's own lane. The release surface
 * re-proves terminality and child-worker state itself. */
function planSweepAck(row: ReleaseEligibleRow, ledger: AutopilotLedger): Verdict {
  const job = ledger.getJob(row.jobId);
  if (job === null) return refuse('job not found');
  if (job.status !== 'merged' && job.status !== 'done' && job.status !== 'binned') {
    return refuse(`job is ${job.status} — sweep-ack releases only terminal lanes`);
  }
  return act('release-lane', {
    endpoint: 'POST /api/dispatch/release',
    job_id: row.jobId,
    rule_id: 'sweep-ack',
  });
}

/** `delivered-pr-register`: exactly one open PR for the delivered branch. */
async function planDeliveredPrRegister(
  row: DeliveredWithoutPrRow,
  ledger: AutopilotLedger,
  listOpenPrsForHead: SilasAutopilotOps['listOpenPrsForHead'],
): Promise<Verdict> {
  const eligible = reviewEligible(ledger, row.jobId);
  if (eligible !== null) return refuse(eligible);
  const fence = fencesHold(ledger, row.jobId);
  if (fence !== null) return refuse(fence);
  const job = ledger.getJob(row.jobId);
  if (job === null) return refuse('job not found');
  if (job.prUrl !== null) return refuse('the job already carries a PR');
  if (row.branch === null || row.branch.trim() === '') return refuse('the delivered lane has no branch to ask GitHub about');
  if (row.lanePath === null || row.lanePath.trim() === '') {
    return refuse('the delivered lane has no worktree path to resolve its remote from');
  }
  const pulls = await listOpenPrsForHead({ repoPath: row.lanePath, branch: row.branch });
  if (pulls.length === 0) return refuse('no open PR was found for the delivered branch');
  const [pull] = pulls;
  if (pulls.length > 1 || pull === undefined) {
    return refuse(`${pulls.length} open PRs were found for the delivered branch — ambiguous`);
  }
  // Recheck after the awaited lookup (issue #243 M5): another writer may
  // have registered a PR during the network window; this stale decision
  // must never overwrite it (setJobPr overwrites unconditionally).
  const afterLookup = ledger.getJob(row.jobId);
  if (afterLookup === null) return refuse('job not found');
  if (afterLookup.prUrl !== null) return refuse('the job already carries a PR');
  return act('register-pr', {
    endpoint: 'POST /api/dispatch/pr',
    job_id: row.jobId,
    url: pull.url,
    branch: row.branch,
  });
}

// ------------------------------------------------------------------
// The pass
// ------------------------------------------------------------------

export interface AutopilotRuleCounts {
  readonly mode: SilasAutopilotRuleMode;
  readonly decisions: number;
  readonly enforced: number;
  readonly refusals: number;
  readonly failures: number;
}

/** The mutable accumulator behind {@link AutopilotRuleCounts}. */
interface MutableRuleCounts {
  mode: SilasAutopilotRuleMode;
  decisions: number;
  enforced: number;
  refusals: number;
  failures: number;
}

export interface SilasAutopilotPassResult extends Record<string, unknown> {
  readonly ok: boolean;
  readonly enabled: boolean;
  readonly decisions: number;
  readonly enforced: number;
  readonly refusals: number;
  readonly failures: number;
  readonly rules: Readonly<Record<string, AutopilotRuleCounts>>;
}

export interface SilasAutopilotInput {
  readonly digest: SilasOpsDigest;
  readonly config: SilasAutopilotConfig;
  readonly ledger: AutopilotLedger;
  readonly ops: SilasAutopilotOps;
  readonly log?: Log;
}

/**
 * Run every enabled family against the freshly computed digest. One pass
 * per deterministic observation; a family that refuses or fails leaves its
 * row untouched for LLM Silas.
 */
export async function runSilasAutopilot(input: SilasAutopilotInput): Promise<SilasAutopilotPassResult> {
  const log = input.log ?? ((): void => {});
  const counts: Record<string, MutableRuleCounts> = {};
  for (const ruleId of SILAS_AUTOPILOT_RULE_IDS) {
    counts[ruleId] = {
      mode: autopilotRuleMode(input.config, ruleId),
      decisions: 0,
      enforced: 0,
      refusals: 0,
      failures: 0,
    };
  }
  if (!input.config.enabled) {
    return { ok: true, enabled: false, decisions: 0, enforced: 0, refusals: 0, failures: 0, rules: counts };
  }

  const decline = (ruleId: SilasAutopilotRuleId, jobId: string, reason: string): void => {
    counts[ruleId]!.refusals += 1;
    log('info', 'silas autopilot refused — leaving the row to LLM Silas', { rule: ruleId, job: jobId, reason });
  };

  /** Record one decision and (in enforce mode) perform exactly one call. */
  const decide = async (ruleId: SilasAutopilotRuleId, jobId: string, call: AutopilotCall): Promise<void> => {
    const rule = counts[ruleId]!;
    rule.decisions += 1;
    input.ledger.appendCustomEvent({
      kind: AUTOPILOT_DECISION_EVENT,
      jobId,
      payload: {
        rule_id: ruleId,
        job: jobId,
        action: call.action,
        would_call: call.wouldCall,
        mode: rule.mode,
      },
    });
    if (rule.mode !== 'enforce') return;
    try {
      await performCall(ruleId, jobId, call, input.ops);
      rule.enforced += 1;
    } catch (error) {
      // A refused or failed call is not a receipt: the row stays for LLM
      // Silas, and the pass reports the failure honestly.
      rule.failures += 1;
      log('warn', 'silas autopilot action failed — the row stays for LLM Silas', {
        rule: ruleId,
        job: jobId,
        error: String(error).slice(0, 300),
      });
    }
  };

  const plan = async (
    ruleId: SilasAutopilotRuleId,
    jobId: string,
    settle: () => Verdict | Promise<Verdict>,
  ): Promise<void> => {
    const rule = counts[ruleId]!;
    // `off` means the family does not run at all: no decision, no refusal
    // count, no log, and NO planner side effect (the delivered-pr-register
    // planner performs a GitHub lookup). Its rows stay for LLM Silas
    // untouched.
    if (rule.mode === 'off') return;
    // The pass budget is applied BEFORE the planner runs (issue #243 M6): a
    // surplus row is skipped without spending a sequential lookup. A skipped
    // row is left for LLM Silas exactly as a refusal is.
    if (rule.decisions + rule.refusals >= MAX_ROWS_PER_FAMILY) return;
    const resolved = await settle();
    if (resolved.kind === 'refuse') {
      decline(ruleId, jobId, resolved.reason);
      return;
    }
    await decide(ruleId, jobId, resolved.call);
  };

  const digest = input.digest;
  for (const row of digest.verdictsAwaitingDirective) {
    const rung = uniformAdvice(row.recurringBlockers);
    if (rung === 'directive') {
      await plan('verdict-rung-directive', row.jobId, () => planVerdictDirective(row, input.ledger));
    } else if (rung === 'rebrief') {
      await plan('verdict-rung-rebrief', row.jobId, () => planVerdictRebrief(row, input.ledger));
    } else if (counts['verdict-rung-directive']!.mode !== 'off' && counts['verdict-rung-rebrief']!.mode !== 'off') {
      decline(
        'verdict-rung-directive',
        row.jobId,
        row.recurringBlockers.length === 0
          ? 'the verdict row carries no structured blocker to template'
          : `the blockers do not uniformly name one rung (advice: ${row.recurringBlockers.map((b) => b.advice).join(', ')})`,
      );
    }
  }
  for (const row of digest.verificationFailures) {
    await plan('verification-repair', row.jobId, () => planVerificationRepair(row, input.ledger));
  }
  for (const row of digest.conflictingPrs) {
    await plan('pr-conflict-rebase', row.jobId, () => planConflictRebase(row, input.ledger));
  }
  for (const row of digest.prWithoutReview) {
    if (row.cleanAbort !== undefined) {
      await plan('clean-abort-service-restart', row.jobId, () => planCleanAbortRebrief(row, input.ledger));
    } else {
      await plan('pr-review-trigger', row.jobId, () => planReviewTrigger(row, input.ledger));
    }
  }
  for (const row of digest.releaseEligible) {
    await plan('sweep-ack', row.jobId, () => planSweepAck(row, input.ledger));
  }
  for (const row of digest.deliveredWithoutPr) {
    await plan('delivered-pr-register', row.jobId, () =>
      planDeliveredPrRegister(row, input.ledger, input.ops.listOpenPrsForHead),
    );
  }

  const totals = Object.values(counts).reduce(
    (acc, rule) => ({
      decisions: acc.decisions + rule.decisions,
      enforced: acc.enforced + rule.enforced,
      refusals: acc.refusals + rule.refusals,
      failures: acc.failures + rule.failures,
    }),
    { decisions: 0, enforced: 0, refusals: 0, failures: 0 },
  );
  return { ok: true, enabled: true, ...totals, rules: counts };
}

/** Perform the one call a decision names. Together with the planners above
 * this is the single place a digest row becomes a service call. */
async function performCall(
  ruleId: SilasAutopilotRuleId,
  jobId: string,
  call: AutopilotCall,
  ops: SilasAutopilotOps,
): Promise<void> {
  const stringField = (field: string): string => String(call.wouldCall[field] ?? '');
  const optionalField = (field: string): string | undefined => {
    const value = call.wouldCall[field];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  switch (ruleId) {
    case 'verdict-rung-directive':
    case 'verification-repair':
    case 'pr-conflict-rebase': {
      const sourceRoundId = optionalField('source_round_id');
      const blockerFingerprint = optionalField('blocker_fingerprint');
      await ops.sendDirective({
        jobId,
        directive: stringField('directive'),
        ruleId,
        ...(sourceRoundId === undefined ? {} : { sourceRoundId }),
        ...(blockerFingerprint === undefined ? {} : { blockerFingerprint }),
      });
      return;
    }
    case 'verdict-rung-rebrief': {
      await ops.sendRebrief({ jobId, note: stringField('note'), ruleId, sourceRoundId: stringField('source_round_id') });
      return;
    }
    case 'clean-abort-service-restart': {
      await ops.triggerReview({ jobId, ruleId, sourceRoundId: stringField('source_round_id') });
      return;
    }
    case 'pr-review-trigger': {
      // The reviewed head is bound to the sha the green proved (issue #187),
      // so the awaited review setup cannot re-resolve a newer live PR head.
      const targetRef = optionalField('target_ref');
      const boundDeliveredSha = optionalField('bound_delivered_sha');
      await ops.triggerReview({
        jobId,
        ruleId,
        ...(targetRef === undefined ? {} : { targetRef }),
        ...(boundDeliveredSha === undefined ? {} : { boundDeliveredSha }),
      });
      return;
    }
    case 'delivered-pr-register': {
      await ops.registerPr({ jobId, url: stringField('url'), ruleId });
      return;
    }
    case 'sweep-ack': {
      await ops.releaseLane({ jobId, ruleId });
      return;
    }
  }
}
