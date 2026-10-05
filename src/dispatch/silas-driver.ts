import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SilasConfig } from '../config.js';
import type { EventBus } from '../events/bus.js';
import type {
  AgentRecord,
  DirectiveRequestRecord,
  EventRecord,
  JobRecord,
  LedgerApi,
  PendingRebriefRecord,
  RoundRecord,
} from '../ledger/api.js';
import { LIVE_DIRECTIVE_STATES, type DirectiveState } from '../ledger/directives.js';
import type { LogLevel } from '../logger.js';
import { openAttemptStartSeq } from './branch-idle.js';
import type { AgentHandle, SpawnOptions } from '../runtime/types.js';
import type { AgentSupervisionView } from '../supervision/supervisor.js';
import type { GitHubPollTickResult } from './github-poll.js';
import { pendingRecoveryRows } from '../provider-recovery/sensor.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Silas ops driver (EPICS E8 follow-through; owner ruling 2026-09-21).
 *
 * Silas is the hosted ops session (supervised slot `silas-ops`, the
 * gru-main / bob-consolidator pattern). This module is his watchtower and
 * alarm clock — never his hand:
 *
 * - It watches the ledger event bus (job delivered, minion error, round
 *   verdict) and wakes the silas slot on the events that matter.
 * - A config-driven periodic sweep computes a compact digest of actionable
 *   states (delivered without PR; PR awaiting an up-to-date review round;
 *   a NEEDS CHANGES verdict awaiting follow-through, with same-blocker
 *   recurrence analysis; working lanes whose minion has gone idle) and
 *   wakes Silas only when the digest is non-empty.
 * - A config-driven fast poll (`[silas] poll_interval_ms`, default 60 s;
 *   0 disables) observes tracked branches through authenticated `gh api`
 *   (POLL-ONLY — the webhook route is descoped) and mechanically applies
 *   the GitHub state-change mappings: a merged PR closes its lane, a
 *   conflicting PR cascades an action-required notification, CI failure
 *   posts a tiered notification with the run URL, CI green records the
 *   review-gate signal event. Dedupe is by observed state-change; the tier
 *   ladder and the wake kinds are unchanged.
 * - Concurrency follows the decisions runtime's one-slot replay: a trigger
 *   arriving mid-turn is never dropped and never stacks — only the LATEST
 *   queued trigger runs after the open turn settles.
 * - Silas acts through the service's own authenticated ops surface
 *   (`/api/silas/*` plus the dispatch pr/review endpoints); this driver
 *   performs no actions itself. The wake prompt carries the operating
 *   skills (`resources/silas-skills/`) — the files are the in-repo source,
 *   injection is the delivery mechanism, so a clean install needs nothing
 *   else on disk.
 *
 * There is NO hard round cap: while blockers evolve, the loop continues.
 * Only the recurrence ladder below intervenes, and escalation — never an
 * endless loop — is the terminal rung.
 */

// ------------------------------------------------------------------
// Recurrence policy (pure, pinned by tests)
// ------------------------------------------------------------------

/** One review finding as the digest consumes it (the blocker subset of a
 * consolidated Perkins report; the fallback gate's findings share shape). */
export interface RoundBlocker {
  readonly category: string;
  readonly title: string;
  readonly location: string;
}

export type RecurrenceAdvice = 'monitor' | 'directive' | 'rebrief' | 'escalate';

/**
 * Canonical blocker identity: the same defect resurfaces across review
 * rounds with reworded prose, so the fingerprint normalizes the finding's
 * category, location, and title (case and whitespace collapsed). Evidence
 * is deliberately excluded — it changes every round.
 */
export function blockerFingerprint(blocker: RoundBlocker): string {
  const norm = (value: string): string => value.toLowerCase().replace(/\s+/gu, ' ').trim();
  return [norm(blocker.category), norm(blocker.location), norm(blocker.title)].join('::');
}

/**
 * How many CONSECUTIVE verdict rounds (newest first) contain this exact
 * blocker fingerprint. A blocker absent from any round breaks the streak —
 * which is the ruling's "evolving blockers keep looping": a new or changed
 * blocker counts from one again and the loop continues unbounded.
 */
export function consecutiveRecurrence(fingerprint: string, roundsNewestFirst: readonly (readonly RoundBlocker[])[]): number {
  let count = 0;
  for (const round of roundsNewestFirst) {
    if (round.some((blocker) => blockerFingerprint(blocker) === fingerprint)) count += 1;
    else break;
  }
  return count;
}

/**
 * One rung of the recurrence ladder (owner ruling, defaults 2/3/4):
 * same canonical blocker twice → fix directive; third → re-brief a fresh
 * minion; fourth → escalation. Advisory-deterministic: the digest names
 * the rung, Silas executes it through the ops surface.
 */
export function adviseRecurrence(
  consecutiveRounds: number,
  thresholds: Pick<SilasConfig, 'directiveAt' | 'rebriefAt' | 'escalateAt'>,
): RecurrenceAdvice {
  if (consecutiveRounds >= thresholds.escalateAt) return 'escalate';
  if (consecutiveRounds >= thresholds.rebriefAt) return 'rebrief';
  if (consecutiveRounds >= thresholds.directiveAt) return 'directive';
  return 'monitor';
}

/**
 * The action for a blocker on an UNHANDLED changes-requested verdict (the
 * digest lists a verdict only while no silas rung has landed after it).
 * This is NOT the recurrence ladder alone: a blocker on its FIRST verdict
 * still gets the first fix directive — the verdict must be handed to the
 * implementing minion, or the lane never re-opens, no second round can
 * exist, and the 2/3/4 ladder is unreachable. Recurrences then climb the
 * ladder unchanged (directive → re-brief → escalate).
 */
export function adviseFollowThrough(
  consecutiveRounds: number,
  thresholds: Pick<SilasConfig, 'directiveAt' | 'rebriefAt' | 'escalateAt'>,
): RecurrenceAdvice {
  if (consecutiveRounds <= 0) return 'monitor';
  const recurrence = adviseRecurrence(consecutiveRounds, thresholds);
  return recurrence === 'monitor' ? 'directive' : recurrence;
}

// ------------------------------------------------------------------
// Digest (the four actionable states)
// ------------------------------------------------------------------

/** Ledger surface the digest reads (the real LedgerApi satisfies it). */
export interface DigestLedger {
  listJobs(): readonly JobRecord[];
  getJob(id: string): JobRecord | null;
  listRounds(jobId: string): readonly RoundRecord[];
  listJobEvents(jobId: string, opts?: { limit?: number }): readonly EventRecord[];
  /** Job events restricted to an explicit kind set (newest first) — the
   * verification follow-through read rides this so unrelated job traffic
   * cannot age the observed kind out of a fixed window. */
  listJobEventsByKinds(jobId: string, kinds: readonly string[], opts?: { limit?: number }): readonly EventRecord[];
  /** The newest event per (kind, scope): the per-scope verification
   * reduction without a newest-N window. */
  latestJobEventsByPayloadScope(
    jobId: string,
    kinds: readonly string[],
  ): readonly EventRecord[];
  /** Exact multi-payload identity query (retirement fences): found however
   * much newer same-kind traffic carries other identities. */
  hasJobEventWithPayloadValues(
    jobId: string,
    kinds: readonly string[],
    values: readonly { readonly key: string; readonly value: string }[],
    sinceSeq: number,
  ): boolean;
  latestJobEvent(jobId: string, kind: string): EventRecord | null;
  latestRoundEvent(roundId: string, kind: string): EventRecord | null;
  listAgents(): readonly AgentRecord[];
  /** Durable re-brief markers; any row for a job is an unresolved request
   * that fences the job's review-eligibility rows (see the digest below). */
  listPendingRebriefs(opts?: { readonly jobId?: string }): readonly PendingRebriefRecord[];
  /** Accepted directive requests still owing completion (`dispatching` or
   * `admitted`). Presence is the lane's single-writer fence: no competing
   * continuation may be offered while one may still be driving the lane. */
  listPendingDirectives(opts?: {
    readonly jobId?: string;
    readonly states?: readonly DirectiveState[];
  }): readonly DirectiveRequestRecord[];
  /** True while any verification run for the job is unsettled (its newest
   * open event is newer than the same run's newest terminal event). */
  hasUnsettledVerificationRun(jobId: string): boolean;
  listProviderWaits?(opts?: { status?: string }): readonly unknown[];
  listPendingProviderRecoveries?(): readonly unknown[];
}

/** Blockers of one round, with an explicit loud note instead of a silent
 * empty when the consolidated report cannot be read. */
export interface RoundBlockersResult {
  readonly blockers: readonly RoundBlocker[];
  readonly note: string | null;
}

export type BlockersForRound = (roundId: string) => Promise<RoundBlockersResult>;

/**
 * Default blockers port: read the round's consolidated Perkins report via
 * the artifact directory its `round.perkins-review` event recorded. A
 * missing/unreadable report is loud IN the digest, never a throw — one
 * damaged artifact must not blind the whole sweep.
 */
export function consolidatedBlockersFor(ledger: DigestLedger): BlockersForRound {
  return (roundId: string): Promise<RoundBlockersResult> => {
    try {
      const event = ledger.latestRoundEvent(roundId, 'round.perkins-review');
      const directory =
        typeof event?.payload === 'object' && event.payload !== null
          ? (event.payload as { artifactDirectory?: unknown }).artifactDirectory
          : undefined;
      if (typeof directory !== 'string' || directory === '') {
        return Promise.resolve({ blockers: [], note: 'no consolidated report recorded for this round' });
      }
      const file = join(directory, 'consolidated.json');
      const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { findings?: unknown };
      if (!Array.isArray(parsed.findings)) {
        return Promise.resolve({ blockers: [], note: `consolidated report ${file} has no findings array` });
      }
      const blockers = (parsed.findings as unknown[])
        .map((finding) => finding as Partial<RoundBlocker> & { severity?: unknown })
        .filter((finding) => finding.severity === 'blocker')
        .map((finding) => ({
          category: String(finding.category ?? ''),
          title: String(finding.title ?? ''),
          location: String(finding.location ?? ''),
        }));
      return Promise.resolve({ blockers, note: null });
    } catch (error) {
      return Promise.resolve({ blockers: [], note: `blockers unavailable: ${String(error).slice(0, 200)}` });
    }
  };
}

export interface DigestRecurringBlocker extends RoundBlocker {
  readonly fingerprint: string;
  readonly consecutiveRounds: number;
  readonly advice: RecurrenceAdvice;
}

export interface DeliveredWithoutPrRow {
  readonly jobId: string;
  readonly repo: string;
  readonly branch: string | null;
  readonly lanePath: string | null;
  readonly minionSessionFile: string | null;
  readonly deliveredAt: string | null;
}

export interface PrWithoutReviewRow {
  readonly jobId: string;
  readonly repo: string;
  readonly prUrl: string;
  readonly priorRounds: number;
  /** Only these service-restart aborts are known-safe mechanical re-arms. */
  readonly cleanAbort?: { readonly roundId: string; readonly ruleId: 'clean-abort-service-restart' };
}

export interface VerdictAwaitingDirectiveRow {
  readonly jobId: string;
  readonly repo: string;
  readonly roundId: string;
  readonly roundSeq: number;
  readonly verdict: string;
  readonly blockerCount: number;
  readonly blockersNote: string | null;
  readonly recurringBlockers: readonly DigestRecurringBlocker[];
}

export interface StalledWorkingRow {
  readonly jobId: string;
  readonly repo: string;
  readonly minionId: string | null;
  readonly minionState: string | null;
  readonly lastActivity: string | null;
  readonly idleMs: number;
}

export interface MinionErrorRow {
  readonly jobId: string;
  readonly repo: string;
  readonly error: string;
  readonly at: string | null;
}

/** A lane whose newest completed verification FAILED and no repair rung
 * has landed since (issue #163): the next step is a repair decision routed
 * through the existing directive machinery, never an unchanged-head green
 * rerun. Retires on a repair rung, a newer verification activity for the
 * same scope, or a later PASS. */
export interface VerificationFailureRow {
  readonly jobId: string;
  readonly repo: string;
  readonly scope: string | null;
  readonly runId: string | null;
  readonly head: string | null;
  readonly at: string | null;
  readonly detail: string;
}

/** A verification submission whose queue wait timed out (issue #163):
 * capacity, not the lane, answered. The row asks for reconsideration at
 * the same head — never an automatic rerun, never a detached watcher.
 * Retires when a newer verification activity lands for the same scope or
 * the lane is terminal. */
export interface VerificationWaitingRow {
  readonly jobId: string;
  readonly repo: string;
  readonly scope: string | null;
  readonly requestId: string | null;
  /** The head pinned at submission (null when the timeout predates the
   * head-recording form); re-submission must target exactly this head. */
  readonly head: string | null;
  readonly waitMs: number | null;
  readonly at: string | null;
}

/** A provider-recovered lane awaiting its guarded continuation claim
 * (provider-recovery sensor): Silas drives these through the recovery
 * claim endpoint — one continuation per claim, fan-out after actual model
 * progress. */
export interface ProviderRecoveryPendingRow {
  readonly waitId: string;
  readonly jobId: string | null;
  readonly slotId: string | null;
  readonly route: string;
  readonly recoveredAt: string;
}

export interface SilasOpsDigest {
  readonly computedAt: string;
  readonly trigger: string;
  readonly deliveredWithoutPr: readonly DeliveredWithoutPrRow[];
  readonly prWithoutReview: readonly PrWithoutReviewRow[];
  readonly verdictsAwaitingDirective: readonly VerdictAwaitingDirectiveRow[];
  readonly stalledWorking: readonly StalledWorkingRow[];
  readonly minionErrors: readonly MinionErrorRow[];
  readonly verificationFailures: readonly VerificationFailureRow[];
  readonly verificationWaits: readonly VerificationWaitingRow[];
  readonly providerRecoveryPending: readonly ProviderRecoveryPendingRow[];
}

/** Count of actionable rows (event triggers wake even at zero; sweeps do not). */
export function digestActionCount(digest: SilasOpsDigest): number {
  return (
    digest.deliveredWithoutPr.length +
    digest.prWithoutReview.length +
    digest.verdictsAwaitingDirective.length +
    digest.stalledWorking.length +
    digest.minionErrors.length +
    digest.verificationFailures.length +
    digest.verificationWaits.length +
    digest.providerRecoveryPending.length
  );
}

/** Job lane record as the digest needs it (registry worktree shape).
 * Issue #161: 'child' lanes share the job scope but are never selected as
 * the job's own lane. */
interface DigestLane {
  readonly kind: 'job' | 'review' | 'child';
  readonly status: 'active' | 'paused' | 'swept';
  readonly path: string;
  readonly branch: string | null;
}

export interface WorktreeListPort {
  listWorktrees(scope?: { jobId?: string }): readonly DigestLane[];
}

export interface ComputeDigestInput {
  readonly ledger: DigestLedger;
  readonly worktrees?: WorktreeListPort;
  readonly blockersForRound: BlockersForRound;
  readonly config: Pick<SilasConfig, 'stallThresholdMs' | 'directiveAt' | 'rebriefAt' | 'escalateAt'>;
  readonly trigger: string;
  readonly now?: () => number;
  /** The supervisor's live per-agent views. A supervision-stopped worker is
   * waiting on a human re-arm with a recorded cause — the board renders it
   * as waiting, so the digest must not call the same lane stalled. */
  readonly supervisionFor?: (agentId: string) => AgentSupervisionView | null;
}

/** The head sha a delivery event recorded (`job.delivered.payload.sha`) —
 * the follow-up signal's freshness witness; null when absent. */
export function deliveredTargetSha(event: EventRecord): string | null {
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const sha = (payload as { sha?: unknown }).sha;
  return typeof sha === 'string' && sha !== '' ? sha : null;
}

/**
 * The re-review freshness predicate: a re-review is warranted only when the
 * newest delivery PROVES the lane moved past the round's reviewed target.
 * Never compare `events.seq` with `rounds.seq` — those are different domains
 * (global event AUTOINCREMENT vs per-job round ordinal) and the comparison is
 * effectively always true, so an unchanged head would manufacture phantom
 * rounds. No recorded head, or the same head the round already reviewed →
 * no round.
 */
export function followUpChangedTarget(
  delivered: EventRecord,
  round: Pick<RoundRecord, 'targetRef'>,
): boolean {
  const sha = deliveredTargetSha(delivered);
  const target = round.targetRef;
  return sha !== null && target !== null && target !== '' && sha !== target;
}

/** The phase a fallback lifecycle event recorded (payload.phase). */
function fallbackPhaseOf(event: EventRecord): unknown {
  return typeof event.payload === 'object' && event.payload !== null
    ? (event.payload as { phase?: unknown }).phase
    : undefined;
}

/**
 * The review-request receipts the digest can read: the silas trigger that
 * asked for a wave, and the bmad-review fallback gate's own lifecycle
 * event. The fallback route creates no round, so the review-overdue row
 * must retire on these — otherwise it re-fires every sweep and Silas
 * re-triggers a gate that already owns the lane. An `unavailable` phase is
 * the exception: the gate never engaged, nothing reviewed the state, and
 * the row must stay eligible for a later repair.
 */
function latestReviewRequest(ledger: DigestLedger, jobId: string): EventRecord | null {
  const candidates: EventRecord[] = [];
  const trigger = ledger.latestJobEvent(jobId, 'silas.review-triggered');
  if (trigger !== null) candidates.push(trigger);
  const fallback = ledger.latestJobEvent(jobId, 'job.fallback-review');
  if (fallback !== null && fallbackPhaseOf(fallback) !== 'unavailable') candidates.push(fallback);
  return candidates.sort((a, b) => b.seq - a.seq)[0] ?? null;
}

/** Fallback-gate lifecycle phases that answer nothing: the gate never
 * started (`unavailable`), gave up (`blocked`) or was interrupted
 * (`aborted`). A clean-abort re-arm stays eligible after these. */
const FALLBACK_FAILED_PHASES: ReadonlySet<string> = new Set(['unavailable', 'blocked', 'aborted']);

/** Handoff lifecycle kinds that prove a queued review intent never armed a
 * review. `job.review-handoff-started` is the authoritative success;
 * queued/claimed/requeued states are still pending. */
const HANDOFF_UNARMED_KINDS: ReadonlySet<string> = new Set([
  'job.review-handoff-failed',
  'job.review-handoff-held',
  'job.review-handoff-skipped',
]);

/** The job's latest handoff lifecycle event (null when none was recorded). */
function latestHandoffEvent(ledger: DigestLedger, jobId: string): EventRecord | null {
  const kinds = [
    'job.review-handoff-started',
    'job.review-handoff-failed',
    'job.review-handoff-held',
    'job.review-handoff-skipped',
    'job.review-handoff-requeued',
  ];
  return kinds
    .map((kind) => ledger.latestJobEvent(jobId, kind))
    .filter((event): event is EventRecord => event !== null)
    .sort((a, b) => b.seq - a.seq)[0] ?? null;
}

/** A Silas trigger answers only if it actually owns a review state: a
 * queued-route trigger is answered by its handoff, so a handoff that ended
 * without arming a round (failed/held/skipped) AFTER this trigger answers
 * nothing. An older handoff outcome belongs to a previous request. */
function triggerAnswers(ledger: DigestLedger, jobId: string, trigger: EventRecord): boolean {
  const route = typeof trigger.payload === 'object' && trigger.payload !== null
    ? (trigger.payload as { route?: unknown }).route : undefined;
  if (route !== 'queued') return true;
  const handoff = latestHandoffEvent(ledger, jobId);
  if (handoff === null || handoff.seq < trigger.seq) return true;
  return !HANDOFF_UNARMED_KINDS.has(handoff.kind);
}

/** The latest review request that genuinely answers the target's current
 * state: an accepted Silas trigger (any route the server admitted), or a
 * fallback-gate event while the gate is live or passed. A terminal fallback
 * failure newer than the winner negates it — a failed attempt keeps the
 * clean-abort row eligible (g4). A 409 deferral is a different event kind
 * and never counts. */
function latestAnsweringReviewRequest(ledger: DigestLedger, jobId: string): EventRecord | null {
  const trigger = ledger.latestJobEvent(jobId, 'silas.review-triggered');
  const fallback = ledger.latestJobEvent(jobId, 'job.fallback-review');
  const phase = fallback === null ? undefined : fallbackPhaseOf(fallback);
  const fallbackFailed = fallback !== null && typeof phase === 'string' && FALLBACK_FAILED_PHASES.has(phase);
  const candidates: EventRecord[] = [];
  if (trigger !== null && triggerAnswers(ledger, jobId, trigger)) candidates.push(trigger);
  if (fallback !== null && !fallbackFailed) candidates.push(fallback);
  const winner = candidates.sort((a, b) => b.seq - a.seq)[0] ?? null;
  if (fallbackFailed && fallback !== null && (winner === null || fallback.seq > winner.seq)) return null;
  return winner;
}

/** Verification event kinds whose latest event per scope the reduction
 * needs (retirement is a separate identity query). */
const VERIFICATION_SCOPE_KINDS: readonly string[] = ['verification.completed', 'verification.lock-timeout'];

/** A fresh PRODUCER submission at an exact (scope, head), by identity
 * query. Only `verification.requested` counts: `verification.attached`
 * and `verification.started` join a pre-existing attempt and are not a
 * new submission that answers a debt. A missing scope/head falls back to
 * any new producer request. */
function verificationResubmitted(
  ledger: DigestLedger,
  jobId: string,
  scope: string | null,
  head: string | null,
  sinceSeq: number,
): boolean {
  // No recorded scope means no correlated identity: an unrelated scoped
  // request must NEVER retire this debt (it stays until a completion in
  // its own recorded scope, if any).
  if (scope === null) return false;
  const values: { readonly key: string; readonly value: string }[] = [{ key: 'scope', value: scope }];
  if (head !== null) values.push({ key: 'head', value: head });
  return ledger.hasJobEventWithPayloadValues(jobId, ['verification.requested'], values, sinceSeq);
}

function payloadRecord(event: EventRecord): Record<string, unknown> {
  return typeof event.payload === 'object' && event.payload !== null
    ? (event.payload as Record<string, unknown>)
    : {};
}

function payloadString(event: EventRecord, key: string): string | null {
  const value = payloadRecord(event)[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function payloadNumber(event: EventRecord, key: string): number | null {
  const value = payloadRecord(event)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function payloadFlag(event: EventRecord, key: string, expected: boolean): boolean {
  return payloadRecord(event)[key] === expected;
}

/** A one-line honest reason a verification failed (never a fabricated
 * exit status): a timeout or signal outranks an exit code, and a recorded
 * spawn/runner error outranks a misleading zero exit. */
function verificationFailureDetail(event: EventRecord): string {
  const payload = payloadRecord(event);
  if (payload['timed_out'] === true) return 'timed out';
  const signal = payload['signal'];
  if (typeof signal === 'string' && signal !== '') return `signal ${signal}`;
  const error = payload['error'];
  if (typeof error === 'string' && error !== '') return error.slice(0, 200);
  const exitCode = payload['exit_code'];
  if (typeof exitCode === 'number' && Number.isFinite(exitCode)) return `exit ${exitCode}`;
  return 'failed with no exit status';
}

/** The job's current phase-opening evidence. */
interface CurrentPhaseStart {
  /** Newest phase-opening event (the `working` hop or an explicit repair
   * start); null when the ledger carries no phase-opening event. */
  readonly event: EventRecord | null;
  /** Event-sequence watermark of the newest phase-opening evidence. */
  readonly seq: number;
  /** Newest explicit repair start that need not flip status — a directive
   * ADMISSION (`silas.directive-sent`, not the mere acceptance intent) or a
   * claimed provider continuation; 0 when none. */
  readonly repairStartSeq: number;
}

/** The newest explicit start of the job's CURRENT work phase that the digest
 * can read: the attempt start review admission uses (`openAttemptStartSeq` —
 * the latest `working` hop, never a `delivered → in-review` flip), plus the
 * explicit repair starts that never flip status — a directive turn admitted
 * for dispatch (`silas.directive-sent`; an acceptance intent that never
 * admitted work is not a phase) and a claimed provider continuation
 * (`provider.recovery-claimed`). An older `job.delivered` at or before this
 * watermark is history from a previous phase, not proof that the current
 * phase delivered (issue #162). */
function currentPhaseStart(ledger: DigestLedger, jobId: string): CurrentPhaseStart {
  const statusHopSeq = openAttemptStartSeq(ledger, jobId);
  const statusEvent = ledger.latestJobEvent(jobId, 'job.status');
  let seq = statusHopSeq;
  let event: EventRecord | null = statusEvent !== null && statusEvent.seq === statusHopSeq ? statusEvent : null;
  let repairStartSeq = 0;
  for (const kind of ['silas.directive-sent', 'provider.recovery-claimed']) {
    const repair = ledger.latestJobEvent(jobId, kind);
    if (repair !== null && repair.seq > repairStartSeq) repairStartSeq = repair.seq;
    if (repair !== null && repair.seq > seq) {
      seq = repair.seq;
      event = repair;
    }
  }
  return { event, seq, repairStartSeq };
}

/** True while a verification owns the lane. Identity-scoped at the ledger
 * (one run's settlement never resolves another run) and window-free: a busy
 * activity tail can never hide an unsettled run. An unsettled
 * request/start keeps the fence until the scheduler records a terminal
 * event — ownership the digest cannot read fails closed rather than
 * guessing a queue's cessation from age. */
function verificationInFlight(ledger: DigestLedger, jobId: string): boolean {
  return ledger.hasUnsettledVerificationRun(jobId);
}

/** The newest effective activity stamp for one worker: the ledger stamp or
 * the supervisor's own event clock, whichever is newer, falling back to the
 * registration time when neither is known (NaN only when all are absent). */
function effectiveWorkerStamp(input: ComputeDigestInput, agent: AgentRecord): number {
  const ledgerMs = agent.lastActivity === null ? Number.NaN : Date.parse(agent.lastActivity);
  const supervisionIso = input.supervisionFor?.(agent.id)?.lastEventAt ?? null;
  const supervisionMs = supervisionIso === null ? Number.NaN : Date.parse(supervisionIso);
  const known = Number.isFinite(supervisionMs) && (!Number.isFinite(ledgerMs) || supervisionMs > ledgerMs)
    ? supervisionMs
    : ledgerMs;
  return Number.isFinite(known) ? known : Date.parse(agent.createdAt);
}

/** Final publish-boundary recheck for a proposed stalled row: the lane may
 * have delivered, gone terminal, opened a new phase, or gained an owner
 * while a later job's blocker history was awaited. Recomputes the cheap
 * ownership facts only; a stale offer is retracted, never published (no
 * duplicate writers). The silence comparison uses the row's COMPUTE-TIME
 * floor, never a floor reconstructed from a later clock reading. */
function stallStillEligible(
  input: ComputeDigestInput,
  row: StalledWorkingRow,
  phaseSeqAtCompute: number,
  silenceFloorAtCompute: number,
  jobSeqAtCompute: number,
): boolean {
  const ledger = input.ledger;
  const jobId = row.jobId;
  const job = ledger.getJob(jobId);
  if (job === null || (job.status !== 'working' && job.status !== 'in-review')) return false;
  // Any event landing during the await (a delivery, a request, an agent
  // state change) makes the computed offer stale; the next sweep re-derives.
  if ((ledger.listJobEvents(jobId, { limit: 1 })[0]?.seq ?? 0) !== jobSeqAtCompute) return false;
  const phaseStart = currentPhaseStart(ledger, jobId);
  if (phaseStart.seq !== phaseSeqAtCompute) return false;
  const delivered = ledger.latestJobEvent(jobId, 'job.delivered');
  if (delivered !== null && delivered.seq > phaseStart.seq) return false;
  if (ledger.listPendingRebriefs({ jobId }).length > 0) return false;
  if (ledger.listPendingDirectives({ jobId, states: LIVE_DIRECTIVE_STATES }).length > 0) return false;
  if (verificationInFlight(ledger, jobId)) return false;
  const review = latestAnsweringReviewRequest(ledger, jobId);
  if (review !== null && review.seq > phaseStart.seq) return false;
  // Worker revalidation across the WHOLE current set: a stop arriving while
  // the await was open moves the lane to the separately handled
  // waiting/re-arm state; a worker that became live, active, or open-turn
  // makes it owned again.
  const minions = ledger.listAgents().filter((agent) => agent.jobId === jobId && agent.role === 'minion');
  for (const agent of minions) {
    const view = input.supervisionFor?.(agent.id) ?? null;
    if (view === null || (view.state !== 'stopped' && view.breakerOpen !== true)) continue;
    const stopIso = view.stoppedAt ?? null;
    const stopMs = stopIso === null ? effectiveWorkerStamp(input, agent) : Date.parse(stopIso);
    if (!Number.isFinite(stopMs) || stopMs > silenceFloorAtCompute) return false;
  }
  const live = minions.filter((agent) => {
    if (agent.state === 'disposed') return false;
    const view = input.supervisionFor?.(agent.id) ?? null;
    return view === null || (view.state !== 'stopped' && view.breakerOpen !== true);
  });
  for (const agent of live) {
    const view = input.supervisionFor?.(agent.id) ?? null;
    if (view !== null && (view.openTurn || view.openControl === true || view.openToolCalls > 0)) return false;
    const effective = effectiveWorkerStamp(input, agent);
    if (Number.isFinite(effective) && effective > silenceFloorAtCompute) return false;
  }
  if (row.minionId === null) {
    // A no-record offer is answered by any live worker appearing.
    if (live.length > 0) return false;
  } else if (!minions.some((agent) => agent.id === row.minionId)) {
    return false; // the named worker record vanished entirely
  } else if (live.length > 0 && !live.some((agent) => agent.id === row.minionId)) {
    // A different live worker now owns the lane; the named worker's own
    // silence no longer decides.
    return false;
  }
  return true;

}

/**
 * The compact digest of actionable ops states, computed from the ledger
 * alone (the ledger is the record; no runtime or filesystem probing beyond
 * the consolidated-report port):
 *
 * 1. deliveredWithoutPr — job delivered (completion turn settled) but no
 *    PR registered and no review round yet: find and register the PR.
 * 2. prWithoutReview — PR registered and the newest delivery proves the
 *    lane moved past the newest round's reviewed target (or no round exists
 *    yet): request the wave. This is both the first review and the
 *    re-review after a fix round — a delivery on the SAME head the round
 *    already reviewed warrants no new round. A review already REQUESTED
 *    for the current state retires the row: the bmad-review fallback route
 *    creates no round, and without its request event the row would re-fire
 *    every sweep and re-trigger a gate that owns its own fix loop. An
 *    UNRESOLVED re-brief request (durable pending markers) suppresses every
 *    review row for the target: the lane's open re-brief work must not be
 *    offered for review on an older delivery, and only genuine marker
 *    settlement (finalize/recovery) releases it.
 * 3. verdictsAwaitingDirective — the newest round recorded NEEDS CHANGES
 *    and no silas follow-through has landed since that verdict: deliver the
 *    first fix directive per blocker, then the ladder's rung (directive →
 *    re-brief → escalate) for recurrences.
 * 4. stalledWorking — job working while its CURRENT phase (the latest
 *    `working` hop or explicit repair start, never an older delivery) has
 *    not delivered and its minion has shown no activity past the stall
 *    threshold: assess the lane. Accepted operations that still own the
 *    lane — an unresolved re-brief, a live directive request, an in-flight
 *    verification, an answering review — fence the row.
 *
 * plus minionErrors — a minion turn that failed more recently than any
 * delivery — so an error wake always carries its context; and the
 * verification follow-through rows (issue #163) — a failed completed run
 * awaiting a repair decision and a queue wait that timed out awaiting
 * reconsideration — so completion/dependency transitions reach the sweep
 * without a fresh owner message.
 */
export async function computeSilasDigest(input: ComputeDigestInput): Promise<SilasOpsDigest> {
  const now = input.now ?? Date.now;
  const digest: {
    computedAt: string;
    trigger: string;
    deliveredWithoutPr: DeliveredWithoutPrRow[];
    prWithoutReview: PrWithoutReviewRow[];
    verdictsAwaitingDirective: VerdictAwaitingDirectiveRow[];
    stalledWorking: StalledWorkingRow[];
    minionErrors: MinionErrorRow[];
    verificationFailures: VerificationFailureRow[];
    verificationWaits: VerificationWaitingRow[];
    providerRecoveryPending: ProviderRecoveryPendingRow[];
  } = {
    computedAt: new Date(now()).toISOString(),
    trigger: input.trigger,
    deliveredWithoutPr: [],
    prWithoutReview: [],
    verdictsAwaitingDirective: [],
    stalledWorking: [],
    minionErrors: [],
    verificationFailures: [],
    verificationWaits: [],
    providerRecoveryPending: [],
  };
  // One unresolved re-brief request fences the target: a marker exists while
  // a re-brief worker runs (or a restart-recovered request waits for boot
  // reconciliation), and clears only when the request genuinely settles.
  // The review-eligibility rows below never offer such a target on an OLDER
  // delivery — the worker may push a new head at any moment.
  const pendingRebriefJobIds = new Set(input.ledger.listPendingRebriefs().map((marker) => marker.jobId));
  // Phase identity per job, for the publish-boundary rechecks: a phase that
  // opened during a later job's blocker-history await invalidates any row
  // computed against the previous phase.
  const phaseSeqByJob = new Map<string, number>();
  // Per-job newest event sequence at compute time: any event landing during
  // a later job's blocker-history await (delivery, request, agent state)
  // makes the computed rows stale, so the publish boundary retracts them.
  const jobSeqAtComputeByJob = new Map<string, number>();
  // Each proposed stalled row's COMPUTE-TIME silence floor, so the publish
  // recheck compares activity against the immutable floor rather than a
  // floor reconstructed from a later clock reading.
  const stallSilenceFloorByJob = new Map<string, number>();
  for (const job of input.ledger.listJobs()) {
    if (job.status === 'merged' || job.status === 'done') continue;
    const rounds = [...input.ledger.listRounds(job.id)].sort((a, b) => b.seq - a.seq);
    const newestRound = rounds[0] ?? null;
    const delivered = input.ledger.latestJobEvent(job.id, 'job.delivered');
    const minionError = input.ledger.latestJobEvent(job.id, 'job.minion-error');
    // A request retires only the state it answered: it must postdate the
    // latest delivery, so a later unreviewed delivery re-arms the row.
    const reviewRequest = latestReviewRequest(input.ledger, job.id);
    const reviewAlreadyRequested =
      reviewRequest !== null && (delivered === null || reviewRequest.seq > delivered.seq);
    const abortProof = newestRound?.status === 'aborted'
      ? input.ledger.latestRoundEvent(newestRound.id, 'round.perkins-incomplete') : null;
    const abortReason = abortProof !== null && abortProof.roundId === newestRound?.id && typeof abortProof.payload === 'object' && abortProof.payload !== null
      ? (abortProof.payload as { reason?: unknown }).reason : null;
    // The clean-abort row retires on the state it was answered by: an armed
    // Perkins round (the consuming source-round receipt) OR any other
    // accepted review request on the target. A 409 deferral and a terminal
    // fallback failure answer nothing and keep the row eligible (g4).
    const answeringRequest = latestAnsweringReviewRequest(input.ledger, job.id);
    const cleanAbort = newestRound !== null && delivered !== null &&
      newestRound.status === 'aborted' &&
      (abortReason === 'service_restart' || abortReason === 'service_restart_missing_review_lane') &&
      deliveredTargetSha(delivered) !== null && deliveredTargetSha(delivered) === newestRound.targetRef &&
      !(answeringRequest !== null && answeringRequest.seq > (abortProof?.seq ?? 0));

    // The CURRENT phase's opening evidence: the shared attempt start plus
    // explicit repair starts (issue #162). A `job.delivered` at/before this
    // watermark is history; only a newer delivery proves the current phase
    // delivered. Computed for EVERY non-terminal status because an explicit
    // repair start (a claimed provider continuation) can arrive while the
    // status still reads `delivered` — the old head must not remain
    // review-ready. Rows (1) and (2) use the same fact, so a reopened
    // repair is never offered a PR/review step for the old head.
    const phaseStart = currentPhaseStart(input.ledger, job.id);
    const phaseStartSeq = phaseStart.seq;
    const repairStartSeq = phaseStart.repairStartSeq;
    phaseSeqByJob.set(job.id, phaseStartSeq);
    jobSeqAtComputeByJob.set(job.id, input.ledger.listJobEvents(job.id, { limit: 1 })[0]?.seq ?? 0);
    const currentPhaseDelivered = delivered !== null && delivered.seq > phaseStartSeq;
    // Accepted or unresolved operations fence the PR/review offers too: a
    // live directive may already be prompting a minion (admission not yet
    // recorded), an in-flight verification owns the checkout, and an
    // unresolved re-brief owns the lane.
    const rebriefPending = pendingRebriefJobIds.has(job.id);
    const liveDirectiveOwns = input.ledger
      .listPendingDirectives({ jobId: job.id, states: LIVE_DIRECTIVE_STATES }).length > 0;
    const reviewPending = job.status === 'working' || job.status === 'delivered' || job.status === 'in-review';

    // (1) Delivered, no PR yet.
    if (delivered !== null && currentPhaseDelivered && reviewPending && !rebriefPending && !liveDirectiveOwns &&
        job.prUrl === null && rounds.length === 0) {
      const lane = (input.worktrees?.listWorktrees({ jobId: job.id }) ?? []).find((candidate) => candidate.kind === 'job');
      const minion = input.ledger
        .listAgents()
        // Issue #161: child workers are not the job's writer lane.
        .filter((agent) => agent.jobId === job.id && agent.role === 'minion' && agent.parentage !== 'child')
        .sort((a, b) => (b.lastActivity ?? b.createdAt).localeCompare(a.lastActivity ?? a.createdAt))[0];
      digest.deliveredWithoutPr.push({
        jobId: job.id,
        repo: job.repo,
        branch: lane?.branch ?? null,
        lanePath: lane?.path ?? null,
        minionSessionFile: minion?.sessionFile ?? null,
        deliveredAt: delivered.ts,
      });
    }

    // (2) PR registered, review overdue (first or re-review). Any status
    // that owes a review counts: `working` (a PR linked row-side),
    // `delivered` (settled before the PR landed) and `in-review` (the
    // register-PR hop lands there). Blocked/parked/terminal lanes do not.
    // An unresolved re-brief fences every row: the open re-brief turn is the
    // lane's target-owned work, so an OLDER delivery is never offered for
    // first review, re-review or clean-abort rearm.
    if (currentPhaseDelivered && !liveDirectiveOwns && job.prUrl !== null && reviewPending && !rebriefPending) {
      if (cleanAbort && newestRound !== null) {
        digest.prWithoutReview.push({ jobId: job.id, repo: job.repo, prUrl: job.prUrl,
          priorRounds: rounds.length, cleanAbort: { roundId: newestRound.id, ruleId: 'clean-abort-service-restart' } });
      } else if (newestRound === null && !reviewAlreadyRequested) {
        digest.prWithoutReview.push({ jobId: job.id, repo: job.repo, prUrl: job.prUrl, priorRounds: 0 });
      } else if (
        newestRound !== null &&
        delivered !== null &&
        followUpChangedTarget(delivered, newestRound) &&
        !reviewAlreadyRequested
      ) {
        digest.prWithoutReview.push({
          jobId: job.id,
          repo: job.repo,
          prUrl: job.prUrl,
          priorRounds: rounds.length,
        });
      }
    }

    // (3) NEEDS CHANGES verdict awaiting follow-through.
    if (
      newestRound !== null &&
      newestRound.verdict === 'changes-requested' &&
      newestRound.status === 'verdict-posted' &&
      job.status === 'in-review'
    ) {
      const verdictEvent = input.ledger.latestJobEvent(job.id, 'round.verdict');
      const handled = input.ledger
        .listJobEvents(job.id, { limit: 50 })
        .filter((event) => event.kind === 'silas.directive-sent' || event.kind === 'silas.rebrief' || event.kind === 'silas.escalated');
      // Only hand the verdict over when no silas rung has landed after it —
      // a directive whose turn is still running must not re-fire per sweep.
      const alreadyHandled = handled.some((event) => verdictEvent === null || event.seq > verdictEvent.seq);
      if (!alreadyHandled) {
        const verdictRounds = rounds.filter((round) => round.verdict === 'changes-requested');
        const blockerHistory: (readonly RoundBlocker[])[] = [];
        let blockersNote: string | null = null;
        for (const round of verdictRounds) {
          const result = await input.blockersForRound(round.id);
          blockerHistory.push(result.blockers);
          if (result.note !== null && round.id === newestRound.id) blockersNote = result.note;
        }
        // verdictRounds preserves the newest-first order of `rounds`, so the
        // first history entry IS the verdict awaiting follow-through.
        const latest = blockerHistory[0] ?? [];
        const seen = new Map<string, DigestRecurringBlocker>();
        for (const blocker of latest) {
          const fingerprint = blockerFingerprint(blocker);
          if (seen.has(fingerprint)) continue;
          const consecutiveRounds = consecutiveRecurrence(fingerprint, blockerHistory);
          seen.set(fingerprint, {
            ...blocker,
            fingerprint,
            consecutiveRounds,
            advice: adviseFollowThrough(consecutiveRounds, input.config),
          });
        }
        digest.verdictsAwaitingDirective.push({
          jobId: job.id,
          repo: job.repo,
          roundId: newestRound.id,
          roundSeq: newestRound.seq,
          verdict: newestRound.verdict,
          blockerCount: latest.length,
          blockersNote,
          recurringBlockers: [...seen.values()],
        });
      }
    }

    // (4) Stalled lane: the CURRENT phase has not delivered and its worker
    // has gone quiet. The current-phase comparison is the shared attempt
    // start (issue #162): a truthful older delivery never proves the current
    // repair phase delivered. Accepted operations that own the lane keep
    // their fences — an unresolved re-brief request, a live directive
    // request (`dispatching` = admission unknown, `admitted` = turn in
    // flight; both reconcile, never duplicate), an in-flight verification,
    // or a review genuinely answering the current phase (the clean-abort
    // re-arm included). Ownership the digest cannot read fails closed: no
    // competing continuation is offered for a phase another operation may
    // still be driving.
    // An open attempt can live under `in-review` too: a PR link flips a
    // still-working attempt before its delivery settles, and `laneIsBusy`
    // keeps refusing review for exactly that shape — the stall channel must
    // still assess it. A SETTLED in-review (delivered) is review-owned.
    const stallEligible = job.status === 'working' || (job.status === 'in-review' && !currentPhaseDelivered);
    const stallOperationOwns = !stallEligible ||
      rebriefPending ||
      liveDirectiveOwns ||
      verificationInFlight(input.ledger, job.id) ||
      (answeringRequest !== null && answeringRequest.seq > phaseStartSeq);
    if (stallEligible && !currentPhaseDelivered && !stallOperationOwns) {
      const boundMinions = input.ledger
        .listAgents()
        .filter((agent) => agent.jobId === job.id && agent.role === 'minion' && agent.parentage !== 'child');
      // The SAME attribution the board renders (stoppedWorkersByJob): a
      // bound minion is live unless its supervision view says stopped or
      // breaker-open, and a disposed unsupervised record is not a worker.
      // A stop marks the lane only when no live worker exists or the
      // newest live worker's stamp is KNOWN and strictly older; an
      // unknown live stamp (a fresh worker registered before its first
      // activity) favors the live worker. A waiting lane's silence is a
      // human re-arm — this STALL channel never wakes it (the distinct
      // minion-error channel below keeps its genuine-failure wakes).
      const viewOf = (agent: (typeof boundMinions)[number]): AgentSupervisionView | null =>
        input.supervisionFor?.(agent.id) ?? null;
      const stopExempt = (agent: (typeof boundMinions)[number]): boolean => {
        const supervision = viewOf(agent);
        return supervision !== null && (supervision.state === 'stopped' || supervision.breakerOpen === true);
      };
      // Issue #171 parity: the silence clock is the newest of the ledger
      // stamp and the supervisor's own event clock — a long turn whose row
      // was not rewritten still has fresh supervision evidence.
      const stampOf = (agent: (typeof boundMinions)[number]): number => {
        const ledgerMs = agent.lastActivity === null ? Number.NaN : Date.parse(agent.lastActivity);
        const supervision = viewOf(agent)?.lastEventAt ?? null;
        const supervisionMs = supervision === null ? Number.NaN : Date.parse(supervision);
        if (Number.isFinite(supervisionMs) && (!Number.isFinite(ledgerMs) || supervisionMs > ledgerMs)) {
          return supervisionMs;
        }
        return ledgerMs;
      };
      // Positive live ownership: an open turn, control phase or tool call is
      // live work (the board's derivedStatus treats it as streaming), never
      // a lost worker — the stall channel must never duplicate it.
      const hasOpenWork = (agent: (typeof boundMinions)[number]): boolean => {
        const supervision = viewOf(agent);
        return supervision !== null &&
          (supervision.openTurn || supervision.openControl === true || supervision.openToolCalls > 0);
      };
      // A REPAIR phase's own opening is the grace floor: a worker stamp
      // from before the reopen must not make the fresh phase look silent.
      // An initial phase keeps its worker's own registration/activity as
      // the floor (there is no reopen to bound against).
      const repairPhase = repairStartSeq > 0 || (delivered !== null && delivered.seq <= phaseStartSeq);
      const phaseStartMs = repairPhase && phaseStart?.event !== null && phaseStart?.event !== undefined
        ? Date.parse(phaseStart.event.ts)
        : Number.NaN;
      const boundedClock = (agentMs: number): number => {
        if (!Number.isFinite(phaseStartMs)) return agentMs;
        if (!Number.isFinite(agentMs)) return phaseStartMs;
        return Math.max(agentMs, phaseStartMs);
      };
      // Stop recency follows the recorded stop time when the supervisor
      // view provides it, else the last frame (code review 2026-10-04).
      const stopStampOf = (agent: (typeof boundMinions)[number]): number => {
        const iso = viewOf(agent)?.stoppedAt ?? null;
        if (iso !== null) {
          const at = Date.parse(iso);
          if (Number.isFinite(at)) return at;
        }
        return stampOf(agent);
      };
      const live = boundMinions.filter((agent) => {
        if (stopExempt(agent)) return false;
        // A disposed record is not a live worker, supervised or not (A2).
        return agent.state !== 'disposed';
      });
      const openWork = live.some(hasOpenWork);
      const newestKnown = (stamps: readonly number[]): number | null =>
        stamps.filter(Number.isFinite).reduce<number | null>((best, at) => (best === null || at > best ? at : best), null);
      const hasStop = boundMinions.some(stopExempt);
      const stopAt = newestKnown(boundMinions.filter(stopExempt).map(stopStampOf));
      const liveAt = newestKnown(live.map(stampOf));
      // A live worker whose activity is still unknown favors live: the
      // stop never marks the lane (the re-dispatch window), exactly like
      // the board's stoppedWorkersByJob (code review 2026-10-04).
      const hasUnknownLive = live.some((agent) => !Number.isFinite(stampOf(agent)));
      const waiting =
        hasStop &&
        !hasUnknownLive &&
        (live.length === 0 || (stopAt !== null && liveAt !== null && stopAt > liveAt));
      // A repair phase whose worker record is missing (never registered, or
      // lost) is surfaced after its own grace. An initial dispatch with no
      // record stays fail-closed: its startup is owned by the dispatch
      // turn, which blocks the lane with error evidence if it fails — a
      // crashed dispatch is restart recovery, a separate concern (issue
      // #162); its accepted startup must never be called lost work.
      if (!waiting && !openWork) {
        const pool = live.length > 0 ? live : boundMinions.filter((agent) => !stopExempt(agent));
        // The selection and the silence clock use the same supervision-aware
        // stamp as the attribution above (issue #171 parity), falling back
        // to the row's creation when no stamp is known.
        const clockOf = (agent: (typeof boundMinions)[number]): number => {
          const stamped = stampOf(agent);
          return boundedClock(Number.isFinite(stamped) ? stamped : Date.parse(agent.createdAt));
        };
        const minion = pool.sort((a, b) => clockOf(b) - clockOf(a))[0];
        if (minion !== undefined) {
          const lastMs = clockOf(minion);
          if (Number.isFinite(lastMs) && now() - lastMs > input.config.stallThresholdMs) {
            stallSilenceFloorByJob.set(job.id, lastMs);
            digest.stalledWorking.push({
              jobId: job.id,
              repo: job.repo,
              minionId: minion.id,
              minionState: minion.state,
              lastActivity: minion.lastActivity,
              idleMs: now() - lastMs,
            });
          }
        } else if (boundMinions.length === 0 && phaseStart.event !== null && repairPhase) {
          // A REPAIR phase whose worker record is missing (never registered,
          // or lost) is surfaced after its own grace. An initial dispatch
          // with no record stays fail-closed: its startup is owned by the
          // dispatch turn (which blocks the lane on failure), and a crashed
          // dispatch is restart recovery — a separate concern (issue #162).
          const startedMs = Date.parse(phaseStart.event.ts);
          if (Number.isFinite(startedMs) && now() - startedMs > input.config.stallThresholdMs) {
            stallSilenceFloorByJob.set(job.id, startedMs);
            digest.stalledWorking.push({
              jobId: job.id,
              repo: job.repo,
              minionId: null,
              minionState: null,
              lastActivity: null,
              idleMs: now() - startedMs,
            });
          }
        }
      }
    }

    // Context: a minion error more recent than any delivery.
    if (minionError !== null && (delivered === null || minionError.seq > delivered.seq)) {
      digest.minionErrors.push({
        jobId: job.id,
        repo: job.repo,
        error: String((minionError.payload as { error?: unknown })?.error ?? 'unknown error').slice(0, 300),
        at: minionError.ts,
      });
    }

    // (5)+(6) Verification follow-through (issue #163): reduce the job's
    // verification traffic PER SCOPE (latest event per kind+scope, no
    // newest-N window) so an unrelated scope's PASS can never hide a failed
    // scope, every timed-out scope stays visible, and a same-scope retry
    // retires only its own row. Repair rungs are read kind-scoped and a
    // rung retires only the exact failure it names. Terminal lanes are
    // skipped by the loop's terminal guard above.
    const verificationCompleted = input.ledger.latestJobEvent(job.id, 'verification.completed');
    const verificationTimeout = input.ledger.latestJobEvent(job.id, 'verification.lock-timeout');
    if (verificationCompleted !== null || verificationTimeout !== null) {
      const scopedEvents = input.ledger.latestJobEventsByPayloadScope(job.id, VERIFICATION_SCOPE_KINDS);
      const scopeOf = (event: EventRecord): string => payloadString(event, 'scope') ?? '(unknown-scope)';
      const latestCompleted = new Map<string, EventRecord>();
      const latestTimeout = new Map<string, EventRecord>();
      for (const event of scopedEvents) {
        const scope = scopeOf(event);
        if (event.kind === 'verification.completed') {
          if (!latestCompleted.has(scope)) latestCompleted.set(scope, event);
        } else if (!latestTimeout.has(scope)) {
          latestTimeout.set(scope, event);
        }
      }
      // Exact identity retirement: a repair rung retires only the failure
      // whose canonical fingerprint it carries, found by an identity query
      // (no newest-N window can age a landed disposition out of view).
      for (const completed of latestCompleted.values()) {
        if (payloadFlag(completed, 'ok', true)) continue;
        const runId = payloadString(completed, 'run_id');
        const scopeLabel = payloadString(completed, 'scope');
        const head = payloadString(completed, 'sha');
        const fingerprints: string[] = [];
        if (scopeLabel !== null) {
          fingerprints.push(
            runId === null ? `verification-failure:${scopeLabel}` : `verification-failure:${scopeLabel}@${runId}`,
          );
        }
        const repaired = fingerprints.some((fingerprint) =>
          input.ledger.hasJobEventWithPayloadValues(
            job.id,
            ['silas.directive-sent'],
            [{ key: 'blocker_fingerprint', value: fingerprint }],
            completed.seq,
          ),
        );
        // A NEW submission at the FAILED (scope, head) retires the row (a
        // still-failing retry re-arms it with the newer result); another
        // scope or head does not answer this failure.
        const retryInFlight = verificationResubmitted(input.ledger, job.id, scopeLabel, head, completed.seq);
        if (repaired || retryInFlight) continue;
        digest.verificationFailures.push({
          jobId: job.id,
          repo: job.repo,
          scope: scopeLabel,
          runId,
          head,
          at: completed.ts,
          detail: verificationFailureDetail(completed),
        });
      }
      for (const [scopeKey, timeout] of latestTimeout) {
        const head = payloadString(timeout, 'head');
        const scopeLabel = payloadString(timeout, 'scope');
        // A fresh PRODUCER submission at the PINNED (scope, head)
        // supersedes the wait; a completion answers it only for the pinned
        // attempt. Another scope or head is a different operation and does
        // not retire this reconsideration. An attachment or a pre-existing
        // attempt starting is NOT a resubmission.
        const resubmitted = verificationResubmitted(input.ledger, job.id, scopeLabel, head, timeout.seq);
        const completedSameHead =
          head === null || scopeLabel === null
            ? (latestCompleted.get(scopeKey)?.seq ?? -1) > timeout.seq
            : input.ledger.hasJobEventWithPayloadValues(
                job.id,
                ['verification.completed'],
                [
                  { key: 'scope', value: scopeLabel },
                  { key: 'sha', value: head },
                ],
                timeout.seq,
              );
        if (resubmitted || completedSameHead) continue;
        digest.verificationWaits.push({
          jobId: job.id,
          repo: job.repo,
          scope: payloadString(timeout, 'scope'),
          requestId: payloadString(timeout, 'request_id'),
          head,
          waitMs: payloadNumber(timeout, 'wait_ms'),
          at: timeout.ts,
        });
      }
    }
  }
  // Provider-recovery lanes awaiting a guarded continuation claim: the
  // durable pending-delivery rows ARE the restart-safe handoff — every
  // sweep re-arms this row until each wait is claimed or retired, so a
  // lost wake can never strand recovered work.
  if (
    input.ledger.listProviderWaits !== undefined &&
    input.ledger.listPendingProviderRecoveries !== undefined
  ) {
    digest.providerRecoveryPending = [
      ...pendingRecoveryRows(input.ledger as Parameters<typeof pendingRecoveryRows>[0]),
    ];
  }
  // A prior job's blocker history may have awaited after another candidate
  // was already offered. Recheck every proposed review at the final publish
  // boundary — not only the jobs visited after an await. No await follows.
  const phaseUnchanged = (jobId: string): boolean => {
    if (!phaseSeqByJob.has(jobId)) return false;
    const job = input.ledger.getJob(jobId);
    const current = job !== null && (job.status === 'working' || job.status === 'in-review')
      ? currentPhaseStart(input.ledger, jobId).seq
      : 0;
    return phaseSeqByJob.get(jobId) === current;
  };
  const jobSeqUnchanged = (jobId: string): boolean =>
    (input.ledger.listJobEvents(jobId, { limit: 1 })[0]?.seq ?? 0) === (jobSeqAtComputeByJob.get(jobId) ?? -1);
  const reviewOfferFencesHold = (jobId: string): boolean => {
    const job = input.ledger.getJob(jobId);
    return job !== null && job.status !== 'merged' && job.status !== 'done' &&
      phaseUnchanged(jobId) &&
      jobSeqUnchanged(jobId) &&
      !verificationInFlight(input.ledger, jobId) &&
      input.ledger.listPendingRebriefs({ jobId }).length === 0 &&
      input.ledger.listPendingDirectives({ jobId, states: LIVE_DIRECTIVE_STATES }).length === 0;
  };
  return {
    ...digest,
    deliveredWithoutPr: digest.deliveredWithoutPr.filter((row) => {
      if (!reviewOfferFencesHold(row.jobId)) return false;
      const job = input.ledger.getJob(row.jobId);
      return job !== null && job.prUrl === null;
    }),
    prWithoutReview: digest.prWithoutReview.filter((row) => {
      if (!reviewOfferFencesHold(row.jobId)) return false;
      const job = input.ledger.getJob(row.jobId);
      // A review admitted for a new state flips the job (working/delivered →
      // in-review), which the phase-identity recheck above already catches;
      // the row-specific precondition here is only the PR link it names.
      return job !== null && job.prUrl !== null;
    }),
    stalledWorking: digest.stalledWorking.filter((row) => {
      const phaseSeq = phaseSeqByJob.get(row.jobId);
      const silenceFloor = stallSilenceFloorByJob.get(row.jobId);
      const jobSeq = jobSeqAtComputeByJob.get(row.jobId);
      return phaseSeq !== undefined && silenceFloor !== undefined && jobSeq !== undefined &&
        stallStillEligible(input, row, phaseSeq, silenceFloor, jobSeq);
    }),
  };
}

// ------------------------------------------------------------------
// Skills (in-repo source, driver-injected delivery)
// ------------------------------------------------------------------

export interface SkillModule {
  readonly name: string;
  readonly body: string;
}

/** `<package>/resources/silas-skills/` — src/ and dist/ both sit two levels
 * below the package root, so one relative path serves dev and built layouts. */
const SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'resources', 'silas-skills');

/** The compiled verification capture helper (issue #159) shipped in `dist/`,
 * named absolutely in the wake prompt so lanes never hand-roll watchers. */
export const CAPTURE_HELPER_PATH = join(SKILLS_DIR, '..', '..', 'dist', 'verify', 'capture-cli.js');

export const SILAS_SKILL_NAMES = ['ops-dispatch', 'ledger-closeout'] as const;

/**
 * Load the silas operating skills from the shipped resources. Fail loud:
 * the wake prompt is the delivery mechanism, so a missing skill is a
 * broken install, not a silently smaller prompt.
 */
export function loadSilasSkills(
  names: readonly string[] = SILAS_SKILL_NAMES,
  skillsDir: string = SKILLS_DIR,
): readonly SkillModule[] {
  return names.map((name) => {
    const file = join(skillsDir, name, 'SKILL.md');
    let body: string;
    try {
      body = readFileSync(file, 'utf-8');
    } catch (error) {
      throw new Error(
        `silas skill "${name}" is unreadable at ${file} (${String(error)}); ` +
          'the product ships its ops skills under resources/silas-skills — restore them before hosting silas',
      );
    }
    const trimmed = body.trim();
    if (trimmed === '') {
      throw new Error(`silas skill "${name}" at ${file} is empty — the skill needs its instructions`);
    }
    return { name, body: trimmed };
  });
}

// ------------------------------------------------------------------
// The driver
// ------------------------------------------------------------------

/** The supervised-slot surface the driver needs (as bob-scheduler). */
export interface SilasSlot {
  ensure(options?: SpawnOptions): Promise<AgentHandle>;
}

export type SilasTriggerKind =
  | 'job.delivered'
  | 'job.minion-error'
  | 'round.verdict'
  | 'round.perkins-incomplete'
  | 'provider.restored'
  | 'verification.completed'
  | 'verification.lock-timeout'
  | 'sweep';

export interface SilasTrigger {
  readonly kind: SilasTriggerKind;
  readonly jobId?: string;
}

/** The GitHub signal poll's single entry point (`GitHubSignalPoll` satisfies it). */
export interface GitHubPollPort {
  pollOnce(): Promise<GitHubPollTickResult>;
}

/** Bind the supervisor's live per-agent views to the digest's lookup. This
 * is the one seam main.ts wires; it is a factory so the binding is testable
 * without booting the service (final independent review T2). The argument
 * is a GETTER, not the value: the lookup is late-bound exactly like the
 * engine's inline closure, so a construction-order change (or a
 * not-yet-assigned handle) can never freeze a null supervisor and silently
 * disable the stop truth for every lane (twelve-followthrough A4). */
export function supervisionLookup(
  getSupervisor: () => { readonly viewFor: (agentId: string) => AgentSupervisionView | null } | null,
): (agentId: string) => AgentSupervisionView | null {
  return (agentId) => getSupervisor()?.viewFor(agentId) ?? null;
}

export interface SilasDriverOptions {
  readonly slot: SilasSlot;
  readonly ledger: DigestLedger & Pick<LedgerApi, 'appendCustomEvent'>;
  readonly worktrees?: WorktreeListPort;
  readonly config: SilasConfig;
  /** The ops surface Silas acts through: base URL + where the pairing token lives. */
  readonly ops: { readonly baseUrl: string; readonly configPath: string };
  readonly bus?: EventBus;
  /** The supervisor's live per-agent views — the digest reads the SAME stop
   * truth the board renders so a stopped lane is never woken as stalled. */
  readonly supervisionFor?: (agentId: string) => AgentSupervisionView | null;
  /** The fast GitHub signal poll, ticked on `[silas] poll_interval_ms`. */
  readonly githubPoll?: GitHubPollPort;
  /** Operating skills injected into every wake prompt (default: shipped resources). */
  readonly skills?: readonly SkillModule[];
  readonly blockersForRound?: BlockersForRound;
  readonly log?: Log;
  /** Deterministic no-LLM pass hook (chief phase-3 seam, issue #163):
   * invoked at the top of every trigger — bus wake events and sweep ticks
   * alike — BEFORE any slot wake/LLM work. The pass must be bounded; the
   * driver serializes overlapping passes (one pass per observed state) and
   * records the outcome as a durable `silas.reconcile` health event (a
   * failure lands as `silas.reconcile-failed`, never as a completed pass).
   * A thrown error is logged and never breaks the driver. */
  readonly onDeterministicPass?: DeterministicPassHook;
  /** Clock + timer seams for tests. */
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  readonly now?: () => number;
}

/** One deterministic pass observation: which trigger woke the driver and
 * whether a model turn was already open at that instant. */
export interface DeterministicPassContext {
  readonly trigger: SilasTriggerKind;
  readonly wakeInFlight: boolean;
}

/** A bounded no-LLM pass result. `ok: false` marks an incomplete/failed
 * pass (e.g. partial row failures) without a throw; the driver records it
 * as a failed pass and never as a completed reconciliation. Any other
 * entries become the recorded pass counts. */
export interface DeterministicPassResult extends Record<string, unknown> {
  readonly ok?: boolean;
}

/** A bounded no-LLM pass. A plain-object return value is recorded as the
 * pass counts on the `silas.reconcile` health event; void records none. */
export type DeterministicPassHook = (
  context: DeterministicPassContext,
) => void | DeterministicPassResult | Promise<void | DeterministicPassResult>;

interface DeterministicPassOutcome {
  readonly ok: boolean;
  readonly counts: Record<string, unknown> | null;
  readonly error: string | null;
  readonly durationMs: number;
}

const SILAS_WAKE_EVENTS: readonly string[] = ['job.delivered', 'job.minion-error', 'round.verdict', 'round.perkins-incomplete', 'provider.restored'];

/** A bus event worth waking Silas for: the standing kinds unconditionally;
 * verification traffic only when it is a failure or a capacity timeout. A
 * routine PASS must not mint an event wake (it would prompt on every green
 * run), but a failed completed run or a dropped queue waiter is exactly
 * the dependency transition the digest must reconsider.
 */
export function silasWakeEvent(event: { readonly kind: string; readonly payload?: unknown }): boolean {
  if (SILAS_WAKE_EVENTS.includes(event.kind)) return true;
  if (event.kind === 'verification.lock-timeout') return true;
  if (event.kind === 'verification.completed') {
    const payload =
      typeof event.payload === 'object' && event.payload !== null
        ? (event.payload as Record<string, unknown>)
        : {};
    return payload['ok'] !== true;
  }
  return false;
}

export class SilasDriver {
  private readonly opts: SilasDriverOptions;
  private readonly log: Log;
  private readonly skills: readonly SkillModule[];
  private readonly now: () => number;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;
  private readonly unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private wakeInFlight: Promise<void> | null = null;
  private queuedTrigger: SilasTrigger | null = null;
  private passInFlight: Promise<DeterministicPassOutcome> | null = null;
  /** One follow-up pass owed for observations that arrived mid-pass. */
  private passRequeued = false;
  private lastPassOutcome: DeterministicPassOutcome | null = null;
  private disposed = false;

  constructor(opts: SilasDriverOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.skills = opts.skills ?? loadSilasSkills();
    this.now = opts.now ?? Date.now;
    this.setIntervalImpl = opts.setInterval ?? setInterval;
    this.clearIntervalImpl = opts.clearInterval ?? clearInterval;
    if (opts.bus !== undefined) {
      this.unsubscribe = opts.bus.subscribe((event) => {
        if (!silasWakeEvent(event)) return;
        void this.trigger({ kind: event.kind as SilasTriggerKind, jobId: event.jobId ?? undefined });
      });
    }
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /** The fast GitHub signal poll timer (independent of the sweep). */
  get pollRunning(): boolean {
    return this.pollTimer !== null;
  }

  /** Start the periodic sweep and the fast GitHub signal poll (both
   * independent; event wakes are live from construction). */
  start(): void {
    if (!this.opts.config.enabled) {
      this.log('info', 'silas ops driver disabled by config — no slot wakes', {});
      return;
    }
    if (this.timer !== null || this.pollTimer !== null) return;
    if (this.opts.config.sweepIntervalMs <= 0) {
      this.log('info', 'silas sweep disabled (interval 0); event wakes stay live', {});
    } else {
      this.timer = this.setIntervalImpl(() => {
        void this.trigger({ kind: 'sweep' });
      }, this.opts.config.sweepIntervalMs);
      this.timer.unref?.();
      this.log('info', 'silas ops driver started', { sweepIntervalMs: this.opts.config.sweepIntervalMs });
    }
    if (this.opts.githubPoll !== undefined && this.opts.config.pollIntervalMs > 0) {
      this.pollTimer = this.setIntervalImpl(() => {
        void this.runPoll();
      }, this.opts.config.pollIntervalMs);
      this.pollTimer.unref?.();
      this.log('info', 'silas github signal poll started', { pollIntervalMs: this.opts.config.pollIntervalMs });
    }
  }

  stop(): void {
    if (this.timer !== null) {
      this.clearIntervalImpl(this.timer);
      this.timer = null;
    }
    if (this.pollTimer !== null) {
      this.clearIntervalImpl(this.pollTimer);
      this.pollTimer = null;
    }
    this.unsubscribe?.();
    this.disposed = true;
  }

  /**
   * One fast-poll tick. The poll applies its mechanical mappings itself
   * (tier 0/1 within the existing mandate); this driver only owns the timer
   * and the loud failure surface. A tick arriving while the previous one is
   * still running is skipped — the next interval re-observes from the ledger.
   */
  private async runPoll(): Promise<void> {
    const poll = this.opts.githubPoll;
    if (poll === undefined || this.disposed) return;
    if (this.pollInFlight) {
      this.log('info', 'github signal poll still running — tick skipped', {});
      return;
    }
    this.pollInFlight = true;
    try {
      const result = await poll.pollOnce();
      if (result.signals.length > 0) {
        this.log('info', 'github signal poll applied signals', {
          tracked: result.tracked,
          observed: result.observed,
          calls: result.calls,
          signals: result.signals.map((signal) => signal.kind),
        });
      }
    } catch (error) {
      // A failed poll must never take the service down: the next tick retries
      // and the ledger dedupe cursor makes a re-observation idempotent.
      this.log('error', 'github signal poll failed', { error: String(error).slice(0, 300) });
    } finally {
      this.pollInFlight = false;
    }
  }

  /**
   * One wake attempt. Never overlapping: a trigger arriving while a turn
   * is open queues ONE slot (latest wins — the next digest supersedes the
   * stale one) and runs after the open turn settles. A failed wake is
   * logged loud; the next sweep or event retries it.
   *
   * Every trigger records a durable `silas.tick` observation and then runs
   * the deterministic pass (coalescing onto an already-running pass, never
   * stacking a second) before the serialized wake path — so routine
   * follow-through keeps advancing while a long model turn is open, and
   * the health projection can tell a busy turn from a stopped scheduler.
   */
  async trigger(trigger: SilasTrigger): Promise<void> {
    if (this.disposed) return;
    if (!this.opts.config.enabled) return;
    const wakeInFlight = this.wakeInFlight !== null;
    // The tick is the durable proof a timer/event observation happened —
    // independent of whether it led, queued or coalesced into a wake.
    this.recordHealthEvent('silas.tick', {
      trigger: trigger.kind,
      wake_in_flight: wakeInFlight,
      pass_in_flight: this.passInFlight !== null,
    });
    // Deterministic, bounded reconsideration happens before any LLM wake:
    // pending-duty reconciliation never waits for a model turn.
    await this.runDeterministicPass(trigger.kind, wakeInFlight);
    if (this.disposed) return;
    if (this.wakeInFlight !== null) {
      this.queuedTrigger = trigger;
      return;
    }
    const run = this.runWake(trigger);
    this.wakeInFlight = run;
    try {
      await run;
    } finally {
      this.wakeInFlight = null;
      const queued = this.queuedTrigger;
      this.queuedTrigger = null;
      if (queued !== null && !this.disposed) {
        void this.trigger(queued).catch(() => {});
      }
    }
  }

  /** Persist one health observation; the ledger failing must never break
   * the driver (the next tick re-observes). */
  private recordHealthEvent(kind: string, payload: Record<string, unknown>): void {
    try {
      this.opts.ledger.appendCustomEvent({ kind, payload });
    } catch (error) {
      this.log('error', 'silas health event could not be persisted', { kind, error: String(error).slice(0, 300) });
    }
  }

  /**
   * Run the injected deterministic pass with one-pass-in-flight semantics:
   * a trigger arriving while a pass runs COALESCES onto that pass instead
   * of starting a second one. Only the pass's starter records the outcome:
   * `silas.reconcile` on success, `silas.reconcile-failed` on failure —
   * never a completed-reconciliation timestamp for a failed pass. When no
   * hook is wired the pass is a no-op and no reconcile event is emitted
   * (there is no reconciliation to claim).
   */
  private async runDeterministicPass(
    trigger: SilasTriggerKind,
    wakeInFlight: boolean,
  ): Promise<DeterministicPassOutcome> {
    const hook = this.opts.onDeterministicPass;
    if (hook === undefined) return { ok: true, counts: null, error: null, durationMs: 0 };
    if (this.passInFlight !== null) {
      // A fresh observation arrived while the pass ran: the in-flight pass
      // may already have read the ledger before this trigger's event was
      // committed, so ONE follow-up pass is owed. All coalesced triggers
      // await it: the first resumer starts it, the rest join the running
      // follow-up so nobody proceeds to the wake path ahead of it.
      this.passRequeued = true;
      await this.passInFlight;
      if (this.disposed) return { ok: true, counts: null, error: null, durationMs: 0 };
      if (!this.passRequeued) {
        if (this.passInFlight !== null) return this.passInFlight;
        return this.lastPassOutcome ?? { ok: true, counts: null, error: null, durationMs: 0 };
      }
      this.passRequeued = false;
      return this.runDeterministicPass(trigger, wakeInFlight);
    }
    const startedAt = this.now();
    const duration = (): number => Math.max(0, this.now() - startedAt);
    // The sentinel is installed BEFORE the hook runs: a hook whose
    // synchronous portion re-enters trigger() (e.g. publishes a wake-kind
    // event) must coalesce onto this pass, never start a second one.
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const run = (async (): Promise<DeterministicPassOutcome> => {
      await gate;
      try {
        const outcome = await hook({ trigger, wakeInFlight });
        const counts =
          typeof outcome === 'object' && outcome !== null && !Array.isArray(outcome)
            ? (outcome as Record<string, unknown>)
            : null;
        // A hook that returns `ok:false` had partial row failures: record
        // the honest failed pass, never a completed reconciliation.
        return { ok: counts === null || counts['ok'] !== false, counts, error: null, durationMs: duration() };
      } catch (error) {
        return { ok: false, counts: null, error: String(error).slice(0, 300), durationMs: duration() };
      }
    })();
    this.passInFlight = run;
    releaseGate();
    try {
      const outcome = await run;
      this.lastPassOutcome = outcome;
      if (outcome.ok) {
        this.recordHealthEvent('silas.reconcile', {
          trigger,
          ok: true,
          duration_ms: outcome.durationMs,
          wake_in_flight: wakeInFlight,
          ...(outcome.counts === null ? {} : { counts: outcome.counts }),
        });
        // Pass-ATTRIBUTED progress: only the deterministic pass emits this
        // marker, so health never credits unrelated lanes' transitions.
        const advanced = outcome.counts === null ? 0 : outcome.counts['advanced'];
        if (typeof advanced === 'number' && advanced > 0) {
          this.recordHealthEvent('silas.reconcile-advanced', { trigger, advanced });
        }
      } else {
        // A failed pass is recorded under its own kind so the board's
        // completed-reconciliation timestamp can never be advanced by a
        // failure while the last failure stays queryable on its own.
        this.recordHealthEvent('silas.reconcile-failed', {
          trigger,
          ok: false,
          duration_ms: outcome.durationMs,
          wake_in_flight: wakeInFlight,
          ...(outcome.counts === null ? {} : { counts: outcome.counts }),
          error: outcome.error,
        });
        this.log('error', 'deterministic pass incomplete', {
          error: outcome.error,
          ...(outcome.counts === null ? {} : { failures: outcome.counts['failures'] }),
        });
      }
      return outcome;
    } finally {
      this.passInFlight = null;
    }
  }

  /** Compute the digest; wake the slot only when there is something to do
   * (sweeps skip empty digests; event wakes always deliver — the event
   * itself is context Silas should see). */
  private async runWake(trigger: SilasTrigger): Promise<void> {
    let digest: SilasOpsDigest;
    try {
      digest = await computeSilasDigest({
        ledger: this.opts.ledger,
        ...(this.opts.worktrees !== undefined ? { worktrees: this.opts.worktrees } : {}),
        blockersForRound: this.opts.blockersForRound ?? consolidatedBlockersFor(this.opts.ledger),
        config: this.opts.config,
        trigger: trigger.kind,
        now: this.now,
        ...(this.opts.supervisionFor !== undefined ? { supervisionFor: this.opts.supervisionFor } : {}),
      });
    } catch (error) {
      this.log('error', 'silas digest computation failed', { trigger: trigger.kind, error: String(error) });
      return;
    }
    const actionable = digestActionCount(digest);
    if (trigger.kind === 'sweep' && actionable === 0) {
      this.log('info', 'silas sweep found nothing actionable', {});
      return;
    }
    try {
      this.opts.ledger.appendCustomEvent({
        kind: 'silas.wake',
        ...(trigger.jobId !== undefined ? { jobId: trigger.jobId } : {}),
        payload: { trigger: trigger.kind, actionable },
      });
    } catch (error) {
      this.log('error', 'silas wake event could not be persisted', { error: String(error) });
    }
    const prompt = buildWakePrompt({
      digest,
      trigger,
      skills: this.skills,
      ops: this.opts.ops,
    });
    try {
      const handle = await this.opts.slot.ensure();
      await handle.prompt(prompt, { owner: 'silas-driver' });
      this.log('info', 'silas wake delivered', { trigger: trigger.kind, actionable });
    } catch (error) {
      // A failed wake must never take the service down (unhandled
      // rejections are fatal in main): log loud; the next sweep or event
      // retries, and the digest recomputes from the ledger anyway.
      this.log('error', 'silas wake failed', { trigger: trigger.kind, error: String(error) });
    }
  }
}

// ------------------------------------------------------------------
// Wake prompt (the skills' delivery vehicle)
// ------------------------------------------------------------------

export function buildWakePrompt(input: {
  digest: SilasOpsDigest;
  trigger: SilasTrigger;
  skills: readonly SkillModule[];
  ops: { readonly baseUrl: string; readonly configPath: string };
}): string {
  const digestJson = JSON.stringify(input.digest, null, 2);
  return [
    `Silas ops wake — trigger: ${input.trigger.kind}${input.trigger.jobId !== undefined ? ` (job ${input.trigger.jobId})` : ''}`,
    '',
    'You are the operations layer. The digest below lists every lane awaiting',
    'ops follow-through, computed from the ledger moments ago. Work inside',
    'your authority: dispatch, track, close. Never write product code; never',
    'merge. Perkins owns verdict authority. Gru may merge gru-command only',
    'after the required Perkins gate; fallback PASS is not that clearance.',
    'The owner holds merges elsewhere and the fallback gate. Preserve before',
    'remove; escalate novel failures to the chief with pointers, not prose.',
    'Never act on the Gru chat session itself.',
    '',
    '## Ops surface',
    '',
    `The service API is at ${input.ops.baseUrl}. Authenticate EVERY call with`,
    `the pairing token stored in ${input.ops.configPath} (the [auth] token).`,
    'Read it WITHOUT echoing it, for example:',
    '',
    '  TOKEN=$(sed -n \'s/^token = "\\(.*\\)"/\\1/p\' ' + input.ops.configPath + ')',
    '  curl -sf -X POST ' + input.ops.baseUrl + '/api/dispatch/pr \\',
    '    -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \\',
    '    -d \'{"job_id":"...","url":"...","by":"silas"}\'',
    '',
    'A 401 means re-read the token. A 4xx carries a detail message — fix the',
    'request, never retry blind. Pass "by":"silas" so the ledger records the',
    'action as yours.',
    '',
    '## Verification capture helper',
    '',
    'Every verification submission uses the shipped helper (never a',
    'hand-rolled background watcher). It opens a unique exclusive sink',
    'BEFORE the POST, streams every NDJSON frame to EOF, and writes a',
    'receipt binding run id, head/dirty state, exit/outcome and output',
    'length/hash. A lost connection is `unknown`, reconciled by request',
    'identity — never replayed blind:',
    '',
    `  node ${CAPTURE_HELPER_PATH} run --job <job> --scope <scope> \\`,
    `    --sink <data-dir>/captures/<job>-<scope>-<head>.ndjson \\`,
    `    --request-id <stable-id> --expected-head <head-to-verify> \\`,
    `    --url ${input.ops.baseUrl} --config ${input.ops.configPath}`,
    '',
    '## Operating skills',
    '',
    ...input.skills.flatMap((skill) => [`### skill: ${skill.name}`, '', skill.body, '']),
    '## Digest (actionable states, JSON)',
    '',
    '```json',
    digestJson,
    '```',
    '',
    '## Recurrence policy (the ladder — no hard round cap)',
    '',
    'While blockers evolve, the loop continues: fix rounds re-enter review',
    'without limit. A changes-requested verdict awaiting follow-through gets',
    'at least the first fix directive per blocker; when the SAME canonical',
    'blocker (same fingerprint) recurs across consecutive verdict rounds,',
    'follow the advice named per blocker: directive → re-brief a fresh',
    'minion → escalate. Escalation always beats an endless loop.',
    '',
    '## Provider recovery (guarded continuation claims)',
    '',
    'Digest rows under providerRecoveryPending name lanes whose provider',
    'limit recovered — the sensor already verified fresh completed producer',
    'evidence on the exact route. Claim ONE continuation per wait through',
    'the ops surface (POST /api/silas/provider-recovery/claim with',
    '{"wait_id":"...","by":"silas"}); the service rechecks approval,',
    'incident currency, blockers, actor cessation, and lane state, then',
    'resumes the interrupted session. Fan out to further waits only after',
    'the first continuation shows actual model progress. Never ack or',
    'dispose provider-wall notifications on the owner’s behalf — those',
    'stay owner-held.',
    '',
    'Reply with a short completion note: what you did per lane, or why you',
    'left it untouched.',
  ].join('\n');
}
