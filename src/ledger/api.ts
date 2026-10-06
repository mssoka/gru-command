import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BusEvent, EventBus } from '../events/bus.js';
import type { Role } from '../config.js';
import type { AgentState } from '../runtime/types.js';
import {
  assertJobTransition,
  assertLensTransition,
  assertObligationTransition,
  assertRoundTransition,
  isJobStatus,
  isJobTerminal,
  isLensState,
  isObligationState,
  isRoundStatus,
  isRoundVerdict,
  TERMINAL_JOB_STATUSES,
  type JobStatus,
  type LensState,
  type ObligationState,
  type RoundStatus,
  type RoundVerdict,
} from './states.js';
import {
  AMENDMENT_CONTRACT_MAX_BYTES,
  AMENDMENT_MAX_IDEMPOTENCY_KEY_CHARS,
  amendmentBodySha256,
  amendmentRequestSha256,
  renderEffectiveContract,
  validateAmendmentDraft,
  type EffectiveContract,
  type JobAmendmentApproval,
  type JobAmendmentRecord,
} from '../review-inputs/amendments.js';
import {
  canonicalIsoTimestamp,
  categoryKey,
  defaultFiringRule,
  isObligationLogicalStep,
  isPhaseHandoffSource,
  isPhaseHandoffState,
  isReportDeliverable,
  MAX_COMPLETION_HANDOFF_DECISION,
  obligationId,
  reportIncidentKey,
  reportLogicalStep,
  REPORT_BACKFILL_EVENT,
  REPORT_DELIVERABLES,
  REPORT_DISPOSITION_EVENT,
  REPORT_SUPERSEDED_EVENT,
  type ReportDeliverable,
  type ReportDispositionOutcome,
  parseAuthority,
  parseCategory,
  parseClaim,
  parseClaimLog,
  parseNextAction,
  parseReceiptCorrelation,
  parseReceipts,
  parseSettlement,
  parseWakeCondition,
  phaseHandoffId,
  resolveObligation,
  type BlockerContext,
  type ClaimLogEntry,
  type ClaimLogDisposition,
  type CompletionHandoffIntent,
  type ObligationAuthority,
  type ObligationCategory,
  type ObligationClaim,
  type ObligationNextAction,
  type ObligationSettlement,
  type ObligationWakeCondition,
  type PhaseHandoffRecord,
  type PhaseHandoffSource,
  type PhaseHandoffState,
  type ReceiptCorrelation,
  type RecordedReceipt,
  type ResolvedObligation,
} from './obligations.js';
import {
  isDirectiveState,
  isDirectiveTerminal,
  LIVE_DIRECTIVE_STATES,
  type DirectiveRequestRecord,
  type DirectiveState,
} from './directives.js';
import {
  evaluatePipelineEntry,
  isPipelineState,
  isSafePipelineRecordId,
  parseExclusiveScopes,
  parsePipelineClaim,
  parsePipelinePrerequisites,
  pipelineOrder,
  PIPELINE_PRIORITY_DEFAULT,
  validateExclusiveScopes,
  validatePipelinePrerequisites,
  validatePipelinePriority,
  wouldCreatePipelineCycle,
  type PipelineBoardView,
  type PipelineEntryBoardView,
  type PipelineEntryRecord,
  type PipelineEvaluationContext,
  type PipelinePrerequisite,
  type PipelineState,
} from './pipeline.js';
import {
  canonicalizeDecisionInput,
  decisionFromRowValues,
  DECISION_ACTORS,
  isDecisionActor,
  validateDecisionReason,
  validateDecisionSignal,
  type CanonicalDecisionInput,
  type DecisionActor,
  type DecisionKind,
  type DecisionRecord,
} from './decision-memory.js';

const VERIFICATION_KIND = 'verification.completed';
export type { JobStatus, RoundStatus, RoundVerdict, LensState } from './states.js';
export type { DirectiveRequestRecord, DirectiveState } from './directives.js';
export type {
  DecisionActor,
  DecisionKind,
  DecisionRecord,
} from './decision-memory.js';
export { DECISION_ACTORS, DECISION_KINDS } from './decision-memory.js';
export type {
  CompletionHandoffIntent,
  PhaseHandoffRecord,
  PhaseHandoffSource,
  PhaseHandoffState,
} from './obligations.js';
export type {
  PipelineBoardView,
  PipelineEntryBoardView,
  PipelineEntryRecord,
  PipelineMilestone,
  PipelinePrerequisite,
  PipelineState,
} from './pipeline.js';

type Row = Record<string, unknown>;

/**
 * The API of record (EPICS E6 story 1): every mutation updates its row AND
 * appends an events row in ONE transaction, then publishes the event on
 * the bus. The events table is append-only history; the entity tables are
 * current state. The board rebuilds entirely from here after any restart.
 */

/** The standard 9-lens whole-change catalog (future-round fallback only;
 * production rounds pass the pinned policy's applicable catalog). */
export const DEFAULT_LENSES = [
  'blind',
  'edge',
  'acceptance',
  'security',
  'architecture',
  'codebase',
  'tests',
  'performance',
  'operations',
] as const;

/** Upper bound for an authored job display name (Gru ruling G2,
 * 2026-09-29): a short card label, bounded at every write boundary —
 * 100 UTF-16 code units, comfortably above the 24-grapheme rail bound
 * the board renders. */
export const JOB_DISPLAY_NAME_MAX_LENGTH = 100;

/** True when the value carries at least one visible character: zero-width
 * and format controls (Unicode Cf), controls (Cc), and combining marks
 * (M) do not count — a name made only of them renders an empty card. */
export function hasVisibleCharacters(value: string): boolean {
  return value.replace(/[\p{Cf}\p{Cc}\p{M}\s]/gu, '') !== '';
}

export type JobDeliverable = 'pr' | 'review' | 'artifact' | 'investigation';

export interface JobRecord {
  readonly id: string;
  readonly repo: string;
  readonly title: string;
  /** Optional short heist name; the full title remains authoritative. */
  readonly displayName: string | null;
  /** The deliverable kind (E19). `null` = legacy row, treated as `'pr'`. */
  readonly deliverable: JobDeliverable | null;
  /** Who commissioned this report-type job and owes its disposition
   * (issue #220). `null` = legacy row or a PR-owing lane. */
  readonly commissioner: string | null;
  /** The target this report reviewed: the PR URL and the exact reviewed
   * head sha. The auto-supersede pass reads both. `null` = legacy row or
   * a PR-owing lane (or a target-less artifact/investigation job). */
  readonly targetRef: string | null;
  readonly targetSha: string | null;
  readonly status: JobStatus;
  readonly baseBranch: string | null;
  readonly prUrl: string | null;
  readonly note: string | null;
  /** The briefing this job executes (E8; Gru-authored, Silas-executed).
   * IMMUTABLE history: canonical amendments are appended separately and
   * rendered into the effective acceptance at review freeze. */
  readonly briefing: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Why an amendment write was refused (each refusal is audited as a
 * `job.amendment-rejected` ledger event). */
export type AddJobAmendmentRejectionCode =
  | 'job-not-found'
  | 'job-terminal'
  | 'no-briefing'
  | 'invalid'
  | 'stale'
  | 'idempotency-conflict';

/** Result of one amendment write: accepted (with the effective contract) or
 * a named refusal. Stale/idempotency conflicts carry the current contract so
 * a caller can re-read and retry deterministically. */
export type AddJobAmendmentResult =
  | {
      readonly status: 'accepted';
      readonly amendment: JobAmendmentRecord;
      readonly contract: EffectiveContract;
      readonly idempotent: boolean;
    }
  | {
      readonly status: 'rejected';
      readonly code: AddJobAmendmentRejectionCode;
      readonly reason: string;
      readonly currentContractSha256?: string;
      readonly currentVersion?: number;
    };

export interface LensChipRecord {
  readonly lens: string;
  readonly state: LensState;
  readonly agentId: string | null;
  readonly note: string | null;
  readonly updatedAt: string;
}

export interface RoundRecord {
  readonly id: string;
  readonly jobId: string;
  readonly seq: number;
  readonly status: RoundStatus;
  readonly targetRef: string | null;
  readonly verdict: RoundVerdict | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lenses: readonly LensChipRecord[];
}

/** Issue #161: the honest parentage category of an agent row. `child`
 * means a durable parent link exists; `top-level` means the registering
 * owner explicitly declared the session parentless; NULL means genuinely
 * unknown (legacy rows written before child workers existed) — never
 * reconstructed from names, jobs, or labels. */
export type AgentParentage = 'top-level' | 'child';

/** Issue #161: bounded task authority of a child worker. A `read-only`
 * child is spawned with the read-only tool set and a detached lane; a
 * `writer` child gets the minion write tools and its own named branch.
 * A child never inherits or exceeds its parent's authority. */
export const CHILD_WORKER_AUTHORITIES = ['read-only', 'writer'] as const;
export type ChildWorkerAuthority = (typeof CHILD_WORKER_AUTHORITIES)[number];

/** Issue #161 child lifecycle. `queued` = admitted and waiting for its
 * lane; `admitted` = a lane exists and the spawn is waiting for resident
 * budget admission; `active` = a live session is running the task;
 * `done`/`error` are the terminal transport outcomes; `cancelled` is an
 * explicit stop. */
export const CHILD_WORKER_STATES = ['queued', 'admitted', 'active', 'done', 'error', 'cancelled'] as const;
export type ChildWorkerState = (typeof CHILD_WORKER_STATES)[number];

export function isChildWorkerState(value: string): value is ChildWorkerState {
  return (CHILD_WORKER_STATES as readonly string[]).includes(value);
}

export function isChildWorkerAuthority(value: string): value is ChildWorkerAuthority {
  return (CHILD_WORKER_AUTHORITIES as readonly string[]).includes(value);
}

/** Terminal child result outcomes. `done` is a successful terminal
 * outcome (the run's own turn settled cleanly); it is NEVER inferred from
 * a resolved prompt alone, a reconnect, or a session resume. */
export const CHILD_RESULT_STATES = ['done', 'error', 'cancelled'] as const;
export type ChildResultState = (typeof CHILD_RESULT_STATES)[number];

/** One tracked child worker (issue #161). The row is 1:1 with the child's
 * agent row and is also the durable admission + lifetime-creation record. */
export interface ChildWorkerRecord {
  /** The durable child-worker identity minted at admission. */
  readonly id: string;
  /** The spawned agent row (null while queued — no session exists yet). */
  readonly agentId: string | null;
  readonly parentAgentId: string;
  readonly jobId: string;
  readonly purpose: string;
  readonly authority: ChildWorkerAuthority;
  readonly task: string;
  readonly label: string | null;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly state: ChildWorkerState;
  readonly worktreeId: string | null;
  readonly branch: string | null;
  readonly sessionFile: string | null;
  readonly resultState: ChildResultState | null;
  /** The child's own final report text, captured from its session at
   * terminal settle (never fabricated). Null when extraction failed. */
  readonly resultSummary: string | null;
  /** Durable reference for the result: the child's session file. */
  readonly resultRef: string | null;
  readonly createdAt: string;
  readonly admittedAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly updatedAt: string;
}

/** Counters over child_workers rows. `queued` includes `admitted` (lane
 * exists, resident admission still waiting); `active` means a live
 * session is running. `lifetimeCreations` counts ROWS — one per logical
 * child creation — so idempotent retries, session resumes and
 * replacement sessions can never double-count, and no total is ever
 * inferred from labels or events. */
export interface ChildWorkerCounts {
  readonly queued: number;
  readonly active: number;
  readonly finished: number;
  readonly lifetimeCreations: number;
}

export interface AgentRecord {
  readonly id: string;
  readonly role: Role;
  readonly label: string | null;
  readonly jobId: string | null;
  readonly roundId: string | null;
  readonly state: AgentState;
  readonly lastActivity: string | null;
  readonly sessionFile: string | null;
  /** Issue #161 durable parent link (null for top-level and legacy rows). */
  readonly parentAgentId: string | null;
  /** Issue #161 parentage category; null = unknown (legacy row). */
  readonly parentage: AgentParentage | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EventRecord {
  readonly seq: number;
  readonly ts: string;
  readonly kind: string;
  readonly agentId: string | null;
  readonly jobId: string | null;
  readonly roundId: string | null;
  readonly lens: string | null;
  readonly payload: unknown;
}

/** Notification routing (SPEC ruling 13; owner routing split 2026-09-23):
 * 'fyi' → the standing feed; 'action-required' → MACHINE attention — it
 * wakes Gru (per the wake policy) and never rings the owner bell;
 * 'needs-owner' → the ONLY human-facing class (FOR YOU band + bell +
 * morning digest). */
export const NOTIFICATION_ROUTINGS = ['fyi', 'action-required', 'needs-owner'] as const;
export type NotificationRouting = (typeof NOTIFICATION_ROUTINGS)[number];

export const NOTIFICATION_SEVERITIES = ['info', 'error'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export function isOwnerHeldNotificationKind(kind: string): boolean {
  // NOTE (provider-recovery machine-ownership amendment, 2026-09-29): the
  // `supervision.provider-wall.*` family is deliberately NOT force-held
  // here. The supervisor decides machine ownership BEFORE posting: an
  // eligible machine-owned stop posts `action-required` (MACHINE attention
  // — no owner chime, no ACK required, resolved by the wait lifecycle),
  // and every ineligible/failed classification posts `needs-owner` as the
  // conservative fallback (the supervisor passes that routing explicitly).
  return kind.startsWith('decisions.degraded.') ||
    ['supervision.breaker', 'port-squat', 'roll-port-squat', 'worktree-sweep-paused'].includes(kind);
}

export function isNotificationRouting(value: string): value is NotificationRouting {
  return (NOTIFICATION_ROUTINGS as readonly string[]).includes(value);
}

export function isNotificationSeverity(value: string): value is NotificationSeverity {
  return (NOTIFICATION_SEVERITIES as readonly string[]).includes(value);
}

/** One durable notification row (EPICS E7 story 2 — the notification log
 * lives in the ledger; ack ids are the proven-ack contract). */
export interface NotificationRecord {
  readonly id: string;
  readonly ts: string;
  readonly kind: string;
  readonly routing: NotificationRouting;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly detail: string | null;
  readonly agentId: string | null;
  readonly shownAt: string | null;
  readonly shownBy: string | null;
  readonly ackedAt: string | null;
  readonly ackedBy: string | null;
  /** System resolution is distinct from a human acknowledgement. */
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
}

/** Marker for not-found failures the HTTP surface maps to 404 (typed —
 * never grepped from error text). */
export class RecordNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordNotFound';
  }
}

/** A guarded re-brief write lost its admitted request or the job closed. */
export class PendingRebriefNoLongerCurrent extends Error {
  constructor(readonly reason: 'terminal' | 'superseded') {
    super(`pending re-brief is no longer current: ${reason}`);
    this.name = 'PendingRebriefNoLongerCurrent';
  }
}

/** A continuation was fenced out: the obligation moved to a different
 * generation (a newer distinct incident superseded the caller's view) or
 * the request does not own the current claim. Never retried blind —
 * re-derive from current durable state first. */
export class StaleContinuationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleContinuationError';
  }
}

/** The obligation is held by another live request's claim. Lease expiry
 * alone does NOT authorize replacing the holder (see ObligationClaim). */
export class ClaimHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaimHeldError';
  }
}

/** A directive request id was reused with a DIFFERENT canonical payload —
 * a conflict, never a silent replacement of the accepted request. */
export class DirectiveConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectiveConflictError';
  }
}

/** A directive repeat arrived while another request for the job is live.
 * The lane is single-writer: ANY different request id (identified or not)
 * fails closed with the live request named — only a replay of that same id
 * proceeds, so a fresh id never starts a second concurrent turn. */
export class AmbiguousDirectiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousDirectiveError';
  }
}

/** The phase-handoff row already exists under this request id with a
 * DIFFERENT decision (or a second completion/binding contradicts the
 * recorded one). The durable intent is part of the request identity;
 * changed intent needs a new request. */
export class PhaseHandoffConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhaseHandoffConflictError';
  }
}

/** An accepted pipeline request was replayed with changed content, or a
 * stable id collides with existing work — the accepted brief is never
 * silently overwritten. */
export class PipelineConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineConflictError';
  }
}

/** A child-worker idempotency key was reused with a DIFFERENT canonical
 * payload. The admitted request is immutable; a changed request needs a
 * new key — never a silent replacement of the tracked child. */
export class ChildWorkerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChildWorkerConflictError';
  }
}

/** A decision client_key was replayed with DIFFERENT canonical content.
 * The recorded decision is immutable history; a changed decision needs a
 * new key — never a silent replacement of a hold or disposition. */
export class DecisionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionConflictError';
  }
}

/** One durable follow-through obligation (current state; full history is
 * the events table). See src/ledger/obligations.ts for the vocabulary. */
export interface ObligationRecord {
  readonly id: string;
  readonly jobId: string;
  readonly logicalStep: string;
  readonly incidentKey: string;
  /** The job's blocked-generation at this incident's creation. Only a NEW
   * distinct incident advances the job generation; duplicates never do. */
  readonly generation: number;
  readonly category: ObligationCategory;
  readonly nextAction: ObligationNextAction;
  readonly wakeCondition: ObligationWakeCondition;
  readonly authority: ObligationAuthority | null;
  readonly firingRule: string;
  /** Optional human context supplied at the blocked boundary — evidence
   * and triage material only, never execution authority. */
  readonly description: string | null;
  readonly state: ObligationState;
  readonly settlement: ObligationSettlement | null;
  readonly dueAt: string | null;
  readonly receiptKind: string | null;
  readonly deadlineAt: string | null;
  readonly recordedReceipts: readonly RecordedReceipt[];
  readonly observations: number;
  /** Bumped ONLY when a duplicate observation changed the plan (next
   * action / authority / wake condition): the revision that fences claims
   * derived from the older plan (ruling C). */
  readonly planRevision: number;
  readonly firstOriginSeq: number;
  readonly lastOriginSeq: number;
  readonly supersededBy: string | null;
  readonly claim: ObligationClaim | null;
  /** Full identity of every prior claim and how it left — never a bare
   * counter (ruling D). */
  readonly claimLog: readonly ClaimLogEntry[];
  readonly receiptCorrelation: ReceiptCorrelation | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ------------------------------------------------------------------
// Worktree registry (E8; SPEC ruling 18b — the ledger is the
// authoritative map job → worktree → branch; sweeps match THESE
// paths only, never id-proximity or labels).
// ------------------------------------------------------------------

export const WORKTREE_KINDS = ['job', 'review', 'child'] as const;
export type WorktreeKind = (typeof WORKTREE_KINDS)[number];

export const WORKTREE_STATUSES = ['active', 'paused', 'swept'] as const;
export type WorktreeStatus = (typeof WORKTREE_STATUSES)[number];

export function isWorktreeKind(value: string): value is WorktreeKind {
  return (WORKTREE_KINDS as readonly string[]).includes(value);
}

export function isWorktreeStatus(value: string): value is WorktreeStatus {
  return (WORKTREE_STATUSES as readonly string[]).includes(value);
}

/** How a lane's base sha was resolved (owner incident 2026-09-23):
 * 'origin' = the freshly-fetched origin default-branch tip;
 * 'local-head-fallback' = the declared degraded path (fetch failed — the
 * lane may be stale and that fact is recorded, never silent). */
export const WORKTREE_BASE_SOURCES = ['origin', 'local-head-fallback'] as const;
export type WorktreeBaseSource = (typeof WORKTREE_BASE_SOURCES)[number];

export function isWorktreeBaseSource(value: string): value is WorktreeBaseSource {
  return (WORKTREE_BASE_SOURCES as readonly string[]).includes(value);
}

export interface WorktreeRecord {
  /** The owning job id (kind 'job') or round id (kind 'review'). */
  readonly id: string;
  readonly kind: WorktreeKind;
  readonly repoPath: string;
  readonly repoName: string;
  readonly path: string;
  readonly branch: string | null;
  readonly sha: string;
  /** How `sha` was resolved — 'origin' (fetched origin tip) or
   * 'local-head-fallback' (degraded path; the lane may be stale).
   * NULL for rows written before the provenance migration and for
   * review rows pinned to an exact commit (their sha IS their
   * provenance). */
  readonly baseSource: WorktreeBaseSource | null;
  readonly jobId: string | null;
  readonly roundId: string | null;
  readonly status: WorktreeStatus;
  readonly note: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ------------------------------------------------------------------
// Pending re-briefs (Silas follow-through restart safety): the durable
// request marker written BEFORE a re-brief worker is spawned. Each marker
// guards ONE ledger event; it clears only when that event lands. A boot
// reconciliation consumes any marker whose event never landed, so a
// service restart mid-turn can never silence the lane. A terminal job
// takes no fresh markers, and its obsolete markers are retired through
// `retirePendingRebriefs` (audit + deletion, one transaction).
// ------------------------------------------------------------------

export const PENDING_REBRIEF_KINDS = ['silas.rebrief', 'job.delivered'] as const;
export type PendingRebriefKind = (typeof PENDING_REBRIEF_KINDS)[number];

export function isPendingRebriefKind(value: string): value is PendingRebriefKind {
  return (PENDING_REBRIEF_KINDS as readonly string[]).includes(value);
}

// ------------------------------------------------------------------
// Provider-recovery waits (owner-approved 2026-09-28): EXPLICIT durable
// provider-wait state. A row exists only after a supported provider-aware
// classifier established a temporary recoverable limit from real runtime
// rejection evidence — never from generic blocked status, prose, or
// backlog membership. Route rows carry the shared probe cadence/budget;
// the pending-recovery marker is the restart-safe delivery handoff.
// ------------------------------------------------------------------

export const PROVIDER_WAIT_STATUSES = ['waiting', 'recovered-pending', 'claimed', 'cancelled', 'superseded'] as const;
export type ProviderWaitStatus = (typeof PROVIDER_WAIT_STATUSES)[number];

export const PROVIDER_WAITER_KINDS = ['job-minion', 'silas-slot'] as const;
export type ProviderWaiterKind = (typeof PROVIDER_WAITER_KINDS)[number];

export function isProviderWaitStatus(value: string): value is ProviderWaitStatus {
  return (PROVIDER_WAIT_STATUSES as readonly string[]).includes(value);
}

export function isProviderWaiterKind(value: string): value is ProviderWaiterKind {
  return (PROVIDER_WAITER_KINDS as readonly string[]).includes(value);
}

/** The saved continuation reference: what to re-deliver when the provider
 * returns (the interrupted turn's prompt/owner snapshot; no secrets). */
export interface ProviderWaitContinuation {
  readonly promptText: string | null;
  readonly promptOwner: string | null;
  readonly hadOpenTurn: boolean;
}

export interface ProviderWaitRecord {
  readonly id: string;
  /** Canonical provider/model + credential binding key (sensor-defined). */
  readonly routeKey: string;
  readonly provider: string;
  readonly model: string;
  /** EXACT catalog endpoint at establishment (verified at probe/claim). */
  readonly endpoint: string;
  readonly credentialFingerprint: string;
  readonly waiterKind: ProviderWaiterKind;
  readonly jobId: string | null;
  readonly agentId: string | null;
  readonly slotId: string | null;
  readonly sessionFile: string | null;
  readonly continuation: ProviderWaitContinuation | null;
  /** Typed establishment evidence (r1 #1): the job status observed when the
   * provider stop was classified — post-establishment churn into
   * blocked/delivered/in-review is EXPECTED interrupted-turn settle, not a
   * generic hold; a job already in those states at establishment holds as a
   * pre-existing (generic/unknown) block — except a `blocked` status the
   * ledger attributes to this wait's own failing turn (the dispatch settle
   * raced the wait), which stays eligible (r4). */
  readonly jobStatusAtEstablishment: string | null;
  /** Durable logical lineage across replacement actors (r1 #12):
   * `job:<id>` or `slot:<id>` — stable through rebriefs, unlike agent ids. */
  readonly lineageKey: string | null;
  /** The recovery BATCH that flipped this wait (claim membership key). */
  readonly recoveryBatchId: string | null;
  readonly incidentId: string;
  readonly incidentGeneration: number;
  readonly status: ProviderWaitStatus;
  readonly reasonClass: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Shared per-route probe state: cadence, rolling budget, backoff,
 * incident sequence, false-recovery accounting. Durable so a restart
 * never re-baselines away an outstanding wait or its budget. The
 * incident sequence advances on every NEW provider-wall incident on the
 * route (renewed quota included) so each recovery delivers exactly once. */
export interface ProviderRouteRecord {
  readonly routeKey: string;
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
  readonly credentialFingerprint: string;
  readonly incidentSeq: number;
  readonly windowStart: string;
  readonly attemptsInWindow: number;
  readonly nextCheckAt: string;
  readonly lastAttemptAt: string | null;
  readonly lastResult: string | null;
  readonly consecutiveProbeFailures: number;
  readonly falseRecoveryCount: number;
  readonly suspendedUntil: string | null;
  readonly updatedAt: string;
}

/** The restart-safe recovery delivery marker: written when valid producer
 * evidence clears a route, consumed when every eligible waiter has been
 * claimed or retired. UNIQUE per route+incident generation — duplicate
 * recovery observations can never double-deliver. */
export interface PendingProviderRecoveryRecord {
  readonly id: string;
  readonly routeKey: string;
  readonly incidentGeneration: number;
  /** Non-secret JSON digest of the producer evidence that cleared the route. */
  readonly evidence: string;
  readonly createdAt: string;
}

export interface PendingRebriefRecord {
  readonly id: string;
  readonly jobId: string;
  /** The ledger event this marker guards. */
  readonly kind: PendingRebriefKind;
  /** Note handed to the re-brief worker (what stalled, what to do differently). */
  readonly note: string | null;
  /** The job briefing at request time — the re-brief prompt's contract half. */
  readonly briefing: string | null;
  /** sha256 of the exact request payload (audit identity). */
  readonly payloadHash: string;
  /** events.seq high-water at request time; the guarded event must post-date it. */
  readonly baselineSeq: number;
  /** The spawned re-brief worker, once known (resume hint after a crash). */
  readonly agentId: string | null;
  readonly sessionFile: string | null;
  /** The phase-handoff row this marker pair belongs to, when the request
   * carried an explicit completion intent (host-owned identity; the
   * delivery event must carry it). Null = ordinary re-brief. */
  readonly phaseId: string | null;
  readonly requestedAt: string;
}

/** A marker snapshot examined by a caller that wants to retire a request.
 * The row is deleted ONLY while it still matches this identity. The audit's
 * `guarded_event_landed` flag is recomputed from the ledger's own events at
 * transaction time, never taken from this snapshot. */
export interface PendingRebriefRetireCandidate {
  readonly id: string;
  readonly kind: PendingRebriefKind;
  /** sha256 of the exact request payload — identity half. */
  readonly payloadHash: string;
  /** Request-time event watermark — identity half. */
  readonly baselineSeq: number;
}

/** The outcome of one terminal-retirement attempt. A refusal or a full
 * identity skip leaves the markers in place and appends NO ledger row —
 * that disposition is log-only by design; only an actual retirement is
 * audited (`silas.rebrief-retired`). */
export interface PendingRebriefRetirement {
  /** The markers this call deleted (identity matched at the boundary). */
  readonly retired: readonly PendingRebriefRecord[];
  /** Candidate ids whose current row no longer matches the examined
   * identity (a newer request generation, or an already-consumed marker).
   * Empty on a boundary refusal: no row was read or compared there. */
  readonly skippedIds: readonly string[];
  /** The boundary refusal: nothing was deleted or recorded. */
  readonly refused: 'job-missing' | 'job-not-terminal' | 'events-already-landed' | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function str(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`ledger row field is not a string: ${String(value)}`);
  return value;
}

function nstr(value: unknown): string | null {
  return value === null || value === undefined ? null : str(value);
}

export function requireSafeRecordId(value: string, name: string, maxLength = 128): void {
  if (!isSafePipelineRecordId(value, maxLength)) {
    throw new Error(`${name} must be a safe ${maxLength}-character record identifier`);
  }
}

export class LedgerApi {
  private readonly db: DatabaseSync;
  private readonly bus: EventBus | null;

  constructor(db: DatabaseSync, opts: { bus?: EventBus } = {}) {
    this.db = db;
    this.bus = opts.bus ?? null;
  }

  // ------------------------------------------------------------------
  // Event plumbing — one transaction, row + event, then bus publish.
  // ------------------------------------------------------------------

  private inTransaction = false;
  /** Events accumulated inside the open transaction, published only
   * after a successful COMMIT — subscribers never see rolled-back work. */
  private pendingEvents: BusEvent[] = [];

  private transaction<T>(write: () => T): T {
    if (this.inTransaction) return write(); // re-entrant: the outer txn owns commit/rollback + publish
    this.inTransaction = true;
    this.db.exec('BEGIN');
    let result: T;
    try {
      result = write();
      this.db.exec('COMMIT');
    } catch (error) {
      this.pendingEvents.length = 0; // rolled back — phantom events are never published
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
    const events = this.pendingEvents.splice(0);
    for (const event of events) this.bus?.publish(event);
    return result;
  }

  private appendEvent(fields: {
    kind: string;
    agentId?: string | null;
    jobId?: string | null;
    roundId?: string | null;
    lens?: string | null;
    payload?: unknown;
  }): BusEvent {
    const ts = nowIso();
    const info = this.db
      .prepare(
        `INSERT INTO events (ts, kind, agent_id, job_id, round_id, lens, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ts,
        fields.kind,
        fields.agentId ?? null,
        fields.jobId ?? null,
        fields.roundId ?? null,
        fields.lens ?? null,
        JSON.stringify(fields.payload ?? {}),
      );
    const event: BusEvent = {
      seq: Number(info.lastInsertRowid),
      ts,
      kind: fields.kind,
      agentId: fields.agentId ?? null,
      jobId: fields.jobId ?? null,
      roundId: fields.roundId ?? null,
      lens: fields.lens ?? null,
      payload: fields.payload ?? {},
    };
    this.pendingEvents.push(event);
    return event;
  }

  /** All (round, lens) chips bound to an agent — indexed, no table scans. */
  listLensBindings(agentId: string): { roundId: string; lens: string }[] {
    return (
      this.db
        .prepare('SELECT round_id, lens FROM lens_states WHERE agent_id = ? ORDER BY rowid')
        .all(agentId) as Row[]
    ).map((row) => ({ roundId: str(row.round_id), lens: str(row.lens) }));
  }

  listEvents(opts: { limit?: number } = {}): readonly EventRecord[] {
    const limit = opts.limit ?? 100;
    return (
      this.db
        .prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?')
        .all(limit) as Row[]
    ).map((row) => this.eventFromRow(row));
  }

  /** Events strictly after `seq` (the awareness digest window), bounded and
   * ordered — oldest-first by default, newest-first with `order: 'desc'`.
   * `kinds` narrows to an explicit set (empty/omitted = every kind). */
  listEventsAfter(
    seq: number,
    opts: { limit?: number; order?: 'asc' | 'desc'; kinds?: readonly string[] } = {},
  ): readonly EventRecord[] {
    const limit = opts.limit ?? 100;
    const order = opts.order === 'desc' ? 'DESC' : 'ASC';
    const kinds = opts.kinds;
    const where =
      kinds === undefined || kinds.length === 0
        ? 'seq > ?'
        : `seq > ? AND kind IN (${kinds.map(() => '?').join(', ')})`;
    const params: (number | string)[] = [seq, ...(kinds ?? [])];
    return (
      this.db
        .prepare(`SELECT * FROM events WHERE ${where} ORDER BY seq ${order} LIMIT ?`)
        .all(...params, limit) as Row[]
    ).map((row) => this.eventFromRow(row));
  }

  /** Highest events.seq, or 0 when the table is empty. The cursor the Gru
   * awareness digest advances past one delivered turn at a time. */
  latestEventSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as Row;
    return Number(row.seq);
  }

  /** One event by seq, or null — the receipt/settlement evidence check
   * (ruling A: no fabricated sequence may settle debt). */
  getEvent(seq: number): EventRecord | null {
    if (!Number.isSafeInteger(seq) || seq < 0) return null;
    const row = this.db.prepare('SELECT * FROM events WHERE seq = ?').get(seq) as Row | undefined;
    return row === undefined ? null : this.eventFromRow(row);
  }

  /** How many durable events of one kind exist (the board's wake tracker). */
  countEvents(kind: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE kind = ?').get(kind) as Row;
    return Number(row.n);
  }

  /** Newest durable event of one kind (the board's wake tracker stamp). */
  latestEventOfKind(kind: string): EventRecord | null {
    const row = this.db
      .prepare('SELECT * FROM events WHERE kind = ? ORDER BY seq DESC LIMIT 1')
      .get(kind) as Row | undefined;
    return row === undefined ? null : this.eventFromRow(row);
  }

  /** Latest durable event for one review round/kind (restart reconciliation). */
  latestRoundEvent(roundId: string, kind: string): EventRecord | null {
    const row = this.db
      .prepare('SELECT * FROM events WHERE round_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1')
      .get(roundId, kind) as Row | undefined;
    return row === undefined ? null : this.eventFromRow(row);
  }

  /** Exactly one immutable freeze receipt must bind a reusable manifest.
   * A second event cannot supersede the original digest. */
  uniqueRoundFreezeManifestReceipt(roundId: string): EventRecord | null {
    const rows = this.db.prepare(
      "SELECT * FROM events WHERE round_id = ? AND kind = 'round.freeze-manifest' ORDER BY seq ASC LIMIT 2",
    ).all(roundId) as Row[];
    return rows.length === 1 ? this.eventFromRow(rows[0]!) : null;
  }

  /** Only one pre-spawn owner marker can attest a round's runtime host.
   * A later conflicting marker is ambiguity, never a replacement authority. */
  uniqueRoundReviewOwnerMarker(roundId: string): EventRecord | null {
    const rows = this.db.prepare(
      "SELECT * FROM events WHERE round_id = ? AND kind = 'round.review-owner' ORDER BY seq ASC LIMIT 2",
    ).all(roundId) as Row[];
    return rows.length === 1 ? this.eventFromRow(rows[0]!) : null;
  }

  /** A single ledger-bound negative proof for a setup that never initiated
   * spawning. A duplicate or contradictory marker cannot authorize reuse. */
  uniqueRoundNoSpawnReceipt(roundId: string): EventRecord | null {
    const rows = this.db.prepare(
      "SELECT * FROM events WHERE round_id = ? AND kind = 'round.review-no-spawn' ORDER BY seq ASC LIMIT 2",
    ).all(roundId) as Row[];
    return rows.length === 1 ? this.eventFromRow(rows[0]!) : null;
  }

  /** Atomically record a no-spawn setup failure and abort its round. A
   * previous live transition is durable spawn-initiation evidence, even if
   * the spawner threw before it could register an agent. */
  abortReviewSetupWithoutSpawn(roundId: string): void {
    this.transaction(() => {
      const round = this.getRound(roundId);
      const owner = this.latestRoundEvent(roundId, 'round.review-owner');
      if (round === null || (round.status !== 'pending' && round.status !== 'aborted') ||
        (owner !== null && this.uniqueRoundReviewOwnerMarker(roundId) === null) ||
        this.latestRoundEvent(roundId, 'round.review-no-spawn') !== null ||
        this.db.prepare("SELECT 1 FROM events WHERE round_id = ? AND kind = 'round.status' AND json_extract(payload, '$.to') = 'live' LIMIT 1")
          .get(roundId) !== undefined ||
        this.listRoundSpecialistStarts(roundId).length !== 0 ||
        this.listAgents().some((agent) => agent.roundId === roundId)) {
        throw new Error(`round ${roundId} cannot prove no review owner started`);
      }
      const generation = randomUUID();
      this.appendEvent({ kind: 'round.review-no-spawn', jobId: round.jobId, roundId,
        payload: { roundId, generation,
          ownerGeneration: (owner?.payload as { generation?: unknown } | null)?.generation ?? null } });
      if (round.status === 'pending') this.setRoundStatus(roundId, 'aborted');
    });
  }

  /** Bounded immutable start journal for one review owner. A missing artifact
   * cannot erase a charged specialist attempt during selective recovery. */
  listRoundSpecialistStarts(roundId: string): readonly EventRecord[] {
    return (this.db.prepare(
      "SELECT * FROM events WHERE round_id = ? AND kind = 'round.specialist-started' ORDER BY seq ASC LIMIT 17",
    ).all(roundId) as Row[]).map((row) => this.eventFromRow(row));
  }

  /** Source-byte receipts for settled attempts; a rewritten artifact cannot
   * authenticate itself by rewriting its own embedded digest. */
  listRoundSpecialistSettlements(roundId: string): readonly EventRecord[] {
    return (this.db.prepare(
      "SELECT * FROM events WHERE round_id = ? AND kind = 'round.specialist-settled' ORDER BY seq ASC LIMIT 17",
    ).all(roundId) as Row[]).map((row) => this.eventFromRow(row));
  }

  /** One job's events, newest first (ops digest scans; bounded). */
  listJobEvents(jobId: string, opts: { limit?: number } = {}): readonly EventRecord[] {
    const limit = opts.limit ?? 200;
    return (
      this.db
        .prepare('SELECT * FROM events WHERE job_id = ? ORDER BY seq DESC LIMIT ?')
        .all(jobId, limit) as Row[]
    ).map((row) => this.eventFromRow(row));
  }

  /** R8-2 (gh-169): a job's completed verification runs, KIND-SCOPED and
   * newest-first — the binding-target search must not be truncated by a
   * generic all-kind event window. The bound is a loud ceiling: a job with
   * more completed verification runs than this window throws instead of
   * letting absence masquerade as "no binding run". */
  listJobVerificationCompleted(jobId: string, limit = 200): readonly EventRecord[] {
    const rows = this.db
      .prepare('SELECT COUNT(*) AS total FROM events WHERE job_id = ? AND kind = ?')
      .all(jobId, VERIFICATION_KIND) as Row[];
    const total = typeof rows[0]?.total === 'number' ? (rows[0] as { total: number }).total : 0;
    if (total > limit) {
      throw new Error(`verification history window exceeded for job ${jobId} (${total} completed runs > ${limit}) — cannot prove the newest target-bound run from a truncated search`);
    }
    return (this.db
      .prepare('SELECT * FROM events WHERE job_id = ? AND kind = ? ORDER BY seq DESC LIMIT ?')
      .all(jobId, VERIFICATION_KIND, limit) as Row[]).map((row) => this.eventFromRow(row));
  }

  /** True while any verification RUN for the job is unsettled: its latest
   * open lifecycle event (`requested`/`started`) is newer than the latest
   * settlement for that SAME run id. Identity-scoped and window-free — one
   * run's completion never resolves another run, and a long activity tail
   * can never hide an open run. `verification.attached` settles nothing
   * (issue #159). */
  hasUnsettledVerificationRun(jobId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS unsettled FROM (
           SELECT json_extract(payload, '$.run_id') AS run_id,
                  MAX(CASE WHEN kind IN ('verification.requested', 'verification.started') THEN seq ELSE 0 END) AS open_seq,
                  MAX(CASE WHEN kind IN ('verification.completed', 'verification.stale-released', 'verification.reconciled', 'verification.lock-timeout') THEN seq ELSE 0 END) AS settled_seq
           FROM events
           WHERE job_id = ? AND kind IN (
             'verification.requested', 'verification.started', 'verification.completed',
             'verification.stale-released', 'verification.reconciled', 'verification.lock-timeout'
           )
           GROUP BY run_id
         ) WHERE open_seq > settled_seq LIMIT 1`,
      )
      .get(jobId) as Row | undefined;
    return row !== undefined;
  }

  /** Latest durable event for one job/kind (ops follow-through checks). */
  latestJobEvent(jobId: string, kind: string): EventRecord | null {
    const row = this.db
      .prepare('SELECT * FROM events WHERE job_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1')
      .get(jobId, kind) as Row | undefined;
    return row === undefined ? null : this.eventFromRow(row);
  }

  /** Job events restricted to an explicit kind set (newest first). Digest
   * and reconcile read paths use it so unrelated job traffic cannot push
   * the observed kind out of a fixed newest-N window. */
  listJobEventsByKinds(
    jobId: string,
    kinds: readonly string[],
    opts: { limit?: number } = {},
  ): readonly EventRecord[] {
    if (kinds.length === 0) throw new Error('listJobEventsByKinds requires at least one kind');
    const limit = opts.limit ?? 200;
    const placeholders = kinds.map(() => '?').join(', ');
    return (
      this.db
        .prepare(`SELECT * FROM events WHERE job_id = ? AND kind IN (${placeholders}) ORDER BY seq DESC LIMIT ?`)
        .all(jobId, ...(kinds as string[]), limit) as Row[]
    ).map((row) => this.eventFromRow(row));
  }

  /** A marked request's guarded event, however many newer unrelated job
   * events exist. The request's watermark and phase must both match. */
  latestJobPhaseEvent(jobId: string, kind: string, phaseId: string, baselineSeq: number): EventRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM events WHERE job_id = ? AND kind = ? AND seq > ?
       AND json_extract(payload, '$.phase_id') = ? ORDER BY seq DESC LIMIT 1`,
    ).get(jobId, kind, baselineSeq, phaseId) as Row | undefined;
    return row === undefined ? null : this.eventFromRow(row);
  }

  /** A request-correlated event by identity, not recency: the correlated
   * receipt is found however many newer same-kind events carry other
   * request ids (restart-safe admission/delivery reconciliation). */
  latestJobEventByRequestId(
    jobId: string,
    kind: string,
    requestId: string,
    opts: { sinceSeq?: number } = {},
  ): EventRecord | null {
    if (requestId.trim() === '') throw new Error('latestJobEventByRequestId requires a non-empty requestId');
    const row = this.db
      .prepare(
        `SELECT * FROM events WHERE job_id = ? AND kind = ? AND seq > ?
         AND json_extract(payload, '$.request_id') = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(jobId, kind, opts.sinceSeq ?? -1, requestId) as Row | undefined;
    return row === undefined ? null : this.eventFromRow(row);
  }

  /** The newest event per (kind, scope) for a job. The verification
   * follow-through reduction rides this so an unresolved scope can never
   * age out behind newer traffic from other scopes (no newest-N window). */
  latestJobEventsByPayloadScope(
    jobId: string,
    kinds: readonly string[],
  ): readonly EventRecord[] {
    if (kinds.length === 0) throw new Error('latestJobEventsByPayloadScope requires at least one kind');
    // One grouped pass over the job's events (no per-row correlated MAX)
    // and NO cap: the result set is one row per (kind, scope), bounded by
    // the configured scope set, so an older unresolved scope can never be
    // dropped by a newest-N cutoff.
    const placeholders = kinds.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT e.* FROM events e
          WHERE e.seq IN (
            SELECT MAX(s.seq) FROM events s
             WHERE s.job_id = ? AND s.kind IN (${placeholders})
             GROUP BY s.kind, json_extract(s.payload, '$.scope')
          )
          ORDER BY e.seq DESC`,
      )
      .all(jobId, ...(kinds as string[])) as Row[];
    return rows.map((row) => this.eventFromRow(row));
  }

  /** Does a job event of one of these kinds exist after `sinceSeq` with
   * EXACT payload key/value matches for every pair? The identity check for
   * retirement fences: a matching fingerprint/head/scope/request is found
   * no matter how much newer same-kind traffic carries other identities. */
  hasJobEventWithPayloadValues(
    jobId: string,
    kinds: readonly string[],
    values: readonly { readonly key: string; readonly value: string }[],
    sinceSeq: number,
  ): boolean {
    if (kinds.length === 0) throw new Error('hasJobEventWithPayloadValues requires at least one kind');
    if (values.length === 0) throw new Error('hasJobEventWithPayloadValues requires at least one payload match');
    const placeholders = kinds.map(() => '?').join(', ');
    const matches = values.map(() => `json_extract(payload, '$.' || ?) = ?`).join(' AND ');
    const params: unknown[] = [jobId, ...(kinds as string[]), sinceSeq];
    for (const { key, value } of values) params.push(key, value);
    const row = this.db
      .prepare(
        `SELECT 1 AS found FROM events
          WHERE job_id = ? AND kind IN (${placeholders}) AND seq > ? AND ${matches}
          LIMIT 1`,
      )
      .get(...(params as never[])) as Row | undefined;
    return row !== undefined;
  }

  /** Newest event among an explicit kind set (board health cards: the
   * last Silas wake). An empty kind set is a caller bug — throw loudly. */
  latestEventOfKinds(kinds: readonly string[]): EventRecord | null {
    if (kinds.length === 0) throw new Error('latestEventOfKinds requires at least one kind');
    const placeholders = kinds.map(() => '?').join(', ');
    const row = this.db
      .prepare(`SELECT * FROM events WHERE kind IN (${placeholders}) ORDER BY seq DESC LIMIT 1`)
      .get(...kinds) as Row | undefined;
    return row === undefined ? null : this.eventFromRow(row);
  }

  /** Count of events among an explicit kind set at/after an ISO timestamp
   * (board health cards: today's Silas reconciliations). ISO stamps share
   * one shape, so lexicographic `>=` is the same boundary the ledger
   * writes. An empty kind set is a caller bug — throw loudly. */
  countEventsSince(kinds: readonly string[], since: string): number {
    if (kinds.length === 0) throw new Error('countEventsSince requires at least one kind');
    const placeholders = kinds.map(() => '?').join(', ');
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM events WHERE ts >= ? AND kind IN (${placeholders})`)
      .get(since, ...kinds) as Row;
    return Number(row.count);
  }

  private eventFromRow(row: Row): EventRecord {
    return {
      seq: Number(row.seq),
      ts: str(row.ts),
      kind: str(row.kind),
      agentId: nstr(row.agent_id),
      jobId: nstr(row.job_id),
      roundId: nstr(row.round_id),
      lens: nstr(row.lens),
      payload: JSON.parse(str(row.payload)) as unknown,
    };
  }

  // ------------------------------------------------------------------
  // Jobs
  // ------------------------------------------------------------------

  /** Cached jobs-table column set (upgrade fixtures open handles on older
   *  migration prefixes; the API must keep working there). */
  private jobsColumnCache: Set<string> | null = null;

  private jobsColumns(): Set<string> {
    if (this.jobsColumnCache === null) {
      const rows = this.db.prepare('PRAGMA table_info(jobs)').all() as Array<{ name?: unknown }>;
      this.jobsColumnCache = new Set(rows.map((row) => String(row.name)));
    }
    return this.jobsColumnCache;
  }

  addJob(input: {
    id: string;
    repo: string;
    title: string;
    displayName?: string | null;
    baseBranch?: string | null;
    briefing?: string | null;
    deliverable?: JobDeliverable | null;
    /** Issue #220 report-job closure: who commissioned the report and
     * what it reviewed. Persisted verbatim; validated below. */
    commissioner?: string | null;
    targetRef?: string | null;
    targetSha?: string | null;
  }): JobRecord {
    if (input.id === '' || input.repo === '' || input.title === '') {
      throw new Error('job id, repo, and title must be non-empty');
    }
    requireSafeRecordId(input.id, 'job id');
    // Runtime callers (direct dispatch, imported JS) do not share the HTTP
    // validator: refuse an unknown deliverable at the durable write so a
    // bad value can never silently change digest routing.
    if (input.deliverable !== undefined && input.deliverable !== null &&
        input.deliverable !== 'pr' && input.deliverable !== 'review' &&
        input.deliverable !== 'artifact' && input.deliverable !== 'investigation') {
      throw new Error(`unknown job deliverable "${String(input.deliverable)}"`);
    }
    // Upgrade fixtures open handles on older migration prefixes where the
    // deliverable column does not exist yet; a caller that SUPPLIES the
    // field there fails loud rather than silently dropping it.
    const hasDeliverable = this.jobsColumns().has('deliverable');
    if (input.deliverable !== undefined && input.deliverable !== null && !hasDeliverable) {
      throw new Error('job deliverable requires migration job-deliverable (the column is missing on this database)');
    }
    // Issue #220 report-job closure columns (commissioner/target_ref/
    // target_sha): same upgrade-fixture rule as deliverable — a caller
    // that SUPPLIES the field on an older schema fails loud rather than
    // silently dropping it.
    const hasReportColumns = this.jobsColumns().has('commissioner');
    const suppliedReportFields =
      (input.commissioner !== undefined && input.commissioner !== null) ||
      (input.targetRef !== undefined && input.targetRef !== null) ||
      (input.targetSha !== undefined && input.targetSha !== null);
    if (suppliedReportFields && !hasReportColumns) {
      throw new Error('job commissioner/target requires migration job-report-closure (the columns are missing on this database)');
    }
    for (const [field, value] of [
      ['commissioner', input.commissioner],
      ['target_ref', input.targetRef],
      ['target_sha', input.targetSha],
    ] as const) {
      if (value !== undefined && value !== null && value.trim() === '') {
        throw new Error(`job ${field} must be a non-empty string when present`);
      }
    }
    // A report target is only meaningful on a report-type job; PR-owing
    // lanes carry their own PR via setJobPr, never a dispatch target.
    const isReportKind = input.deliverable !== undefined && input.deliverable !== null &&
      input.deliverable !== 'pr' && isReportDeliverable(input.deliverable);
    if (!isReportKind && (input.targetRef !== undefined || input.targetSha !== undefined)) {
      throw new Error(`job target_ref/target_sha are report-job fields — job "${input.id}" is not a report-type deliverable`);
    }
    if (input.displayName !== undefined && input.displayName !== null && input.displayName.trim() === '') {
      throw new Error('job display name must be a non-empty string');
    }
    const displayName = input.displayName?.trim() ?? null;
    if (displayName !== null) {
      // A name made only of invisible characters (ZWSP/ZWJ, bidi and
      // format controls, combining marks) would render an empty card.
      if (!hasVisibleCharacters(displayName)) {
        throw new Error('job display name must contain visible characters');
      }
      if (displayName.length > JOB_DISPLAY_NAME_MAX_LENGTH) {
        throw new Error(`job display name exceeds ${JOB_DISPLAY_NAME_MAX_LENGTH} characters`);
      }
    }
    return this.transaction(() => {
      if (this.getJob(input.id) !== null) {
        throw new Error(`job "${input.id}" already exists`);
      }
      // Reservation fence (Perkins r3 blocker 1): an accepted pipeline
      // entry owns its id across BOTH creation surfaces. The only seam
      // allowed through is the entry's own admission claim (`admitting`),
      // which the consumer persists before it may dispatch. A ledger
      // older than the pipeline migration has no reservations to honour.
      const reserved = this.hasPipelineTable() ? this.getPipelineEntry(input.id) : null;
      if (reserved !== null && reserved.state !== 'admitting') {
        throw new PipelineConflictError(
          `job id "${input.id}" is reserved by an accepted pipeline entry (${reserved.state}) — a direct job cannot take it`,
        );
      }
      const ts = nowIso();
      this.db
        .prepare(
          hasDeliverable
            ? hasReportColumns
              ? `INSERT INTO jobs (id, repo, title, status, base_branch, pr_url, note, briefing, display_name, deliverable, commissioner, target_ref, target_sha, created_at, updated_at)
                 VALUES (?, ?, ?, 'dispatched', ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
              : `INSERT INTO jobs (id, repo, title, status, base_branch, pr_url, note, briefing, display_name, deliverable, created_at, updated_at)
                 VALUES (?, ?, ?, 'dispatched', ?, NULL, NULL, ?, ?, ?, ?, ?)`
            : `INSERT INTO jobs (id, repo, title, status, base_branch, pr_url, note, briefing, display_name, created_at, updated_at)
               VALUES (?, ?, ?, 'dispatched', ?, NULL, NULL, ?, ?, ?, ?)`,
        )
        .run(
          input.id, input.repo, input.title, input.baseBranch ?? null, input.briefing ?? null, displayName,
          ...(hasDeliverable ? [input.deliverable ?? null] : []),
          ...(hasReportColumns
            ? [input.commissioner ?? null, input.targetRef ?? null, input.targetSha ?? null]
            : []),
          ts, ts,
        );
      this.appendEvent({
        kind: 'job.created',
        jobId: input.id,
        payload: {
          repo: input.repo,
          title: input.title,
          display_name: displayName,
          ...(isReportKind
            ? { commissioner: input.commissioner ?? null, target_ref: input.targetRef ?? null, target_sha: input.targetSha ?? null }
            : {}),
        },
      });
      return this.getJob(input.id) as JobRecord;
    });
  }

  getJob(id: string): JobRecord | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : this.jobFromRow(row);
  }

  listJobs(repo?: string): readonly JobRecord[] {
    const rows =
      repo === undefined
        ? (this.db.prepare('SELECT * FROM jobs ORDER BY updated_at DESC, id').all() as Row[])
        : (this.db.prepare('SELECT * FROM jobs WHERE repo = ? ORDER BY updated_at DESC, id').all(repo) as Row[]);
    return rows.map((row) => this.jobFromRow(row));
  }

  /** Blocked jobs with NO obligation history at all — the bounded boot
   * adoption candidate set. Already-adopted lanes are excluded BY the
   * query, so a fixed window can never keep re-scanning the adopted
   * prefix while the tail starves (N3). */
  listBlockedJobsWithoutObligations(limit: number): readonly JobRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(`listBlockedJobsWithoutObligations requires a positive integer limit, got ${String(limit)}`);
    }
    const rows = this.db
      .prepare(
        `SELECT j.* FROM jobs j
          WHERE j.status = 'blocked'
            AND NOT EXISTS (SELECT 1 FROM job_obligations o WHERE o.job_id = j.id)
          ORDER BY j.updated_at DESC, j.id
          LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((row) => this.jobFromRow(row));
  }

  setJobStatus(id: string, status: string, context?: BlockerContext): JobRecord {
    if (!isJobStatus(status)) throw new Error(`unknown job status "${status}"`);
    if (context !== undefined && status !== 'blocked') {
      throw new Error('a blocker context may only accompany a blocked transition');
    }
    return this.transaction(() => {
      const current = this.getJob(id);
      if (current === null) throw new RecordNotFound(`job "${id}" not found`);
      if (current.status !== status) {
        assertJobTransition(current.status, status);
        this.db
          .prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?')
          .run(status, nowIso(), id);
        const event = this.appendEvent({ kind: 'job.status', jobId: id, payload: { from: current.status, to: status } });
        // Status/obligation consistency lives AT this transactional boundary
        // (chief ruling A): every writer — dispatch, HTTP API, future hooks —
        // rides it. A blocked transition synthesizes/refreshes obligations
        // from the typed context, or from a safe unknown-triage default when
        // no context is given (a legitimate block is never rejected for a
        // missing description). Parking suspends the applicable obligations;
        // terminal states close them (history preserved, never erased).
        if (status === 'blocked') {
          this.applyBlockedObservation(
            id,
            context ?? { logicalStep: 'operation', category: { kind: 'unknown' }, observedAtSeq: event.seq },
          );
        } else if (status === 'parked') {
          this.suspendApplicableObligations(id, 'job parked — obligation suspended by explicit durable state');
        } else if (status === 'done' || status === 'merged') {
          this.closeApplicableObligations(id, status);
        }
      } else if (status === 'blocked' && context !== undefined) {
        // A repeated blocked observation on an already-blocked job is still
        // an observation: the same transactional boundary must record it.
        const event = this.appendEvent({
          kind: 'job.status',
          jobId: id,
          payload: { from: current.status, to: status, note: 're-observed blocked' },
        });
        this.applyBlockedObservation(id, context ?? { logicalStep: 'operation', category: { kind: 'unknown' }, observedAtSeq: event.seq });
      }
      return this.getJob(id) as JobRecord;
    });
  }

  noteJob(id: string, note: string): JobRecord {
    return this.transaction(() => {
      const current = this.getJob(id);
      if (current === null) throw new RecordNotFound(`job "${id}" not found`);
      this.db.prepare('UPDATE jobs SET note = ?, updated_at = ? WHERE id = ?').run(note, nowIso(), id);
      this.appendEvent({ kind: 'job.note', jobId: id, payload: { note } });
      return this.getJob(id) as JobRecord;
    });
  }

  setJobPr(id: string, url: string): JobRecord {
    return this.transaction(() => {
      const current = this.getJob(id);
      if (current === null) throw new RecordNotFound(`job "${id}" not found`);
      this.db.prepare('UPDATE jobs SET pr_url = ?, updated_at = ? WHERE id = ?').run(url, nowIso(), id);
      this.appendEvent({ kind: 'job.pr', jobId: id, payload: { url } });
      return this.getJob(id) as JobRecord;
    });
  }

  setJobBriefing(id: string, briefing: string): JobRecord {
    if (briefing.trim() === '') throw new Error('job briefing must be non-empty');
    return this.transaction(() => {
      const current = this.getJob(id);
      if (current === null) throw new RecordNotFound(`job "${id}" not found`);
      // Canonical amendments hang off the ORIGINAL briefing bytes: once any
      // amendment is accepted, the briefing is history and cannot be
      // rewritten (append a new amendment instead).
      if (this.listJobAmendments(id).length > 0) {
        throw new Error(`job "${id}" has accepted canonical amendments; the briefing cannot be rewritten`);
      }
      this.db.prepare('UPDATE jobs SET briefing = ?, updated_at = ? WHERE id = ?').run(briefing, nowIso(), id);
      this.appendEvent({ kind: 'job.briefing', jobId: id, payload: { bytes: briefing.length } });
      return this.getJob(id) as JobRecord;
    });
  }

  // ------------------------------------------------------------------
  // Canonical job amendments (owner ruling j-969)
  // ------------------------------------------------------------------

  /** Every accepted amendment for a job, in version order (append-only). */
  listJobAmendments(jobId: string): readonly JobAmendmentRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM job_amendments WHERE job_id = ? ORDER BY version')
      .all(jobId) as Row[];
    return rows.map((row) => this.amendmentFromRow(row));
  }

  /** The job's effective acceptance: original briefing + accepted amendments. */
  effectiveContract(jobId: string): EffectiveContract | null {
    const job = this.getJob(jobId);
    if (job === null) return null;
    return renderEffectiveContract(job.briefing, this.listJobAmendments(jobId));
  }

  /**
   * Accept one append-only amendment. Optimistic concurrency binds the
   * request to the effective contract hash the writer read; a stale write is
   * rejected (and audited), never merged. An idempotency key makes retries
   * deterministic: the same key + same request fingerprint returns the
   * already-accepted amendment; the same key with a different request is a
   * conflict. The original briefing is never rewritten.
   */
  addJobAmendment(input: {
    readonly jobId: string;
    readonly body: string;
    readonly supersedes?: readonly string[];
    readonly approval: JobAmendmentApproval;
    readonly expectedContractSha256: string;
    readonly idempotencyKey?: string | null;
  }): AddJobAmendmentResult {
    return this.transaction(() => {
      const job = this.getJob(input.jobId);
      if (job === null) {
        // events.job_id carries no foreign key, so the refusal stays visible
        // even when the named job never existed.
        return this.rejectAmendment(input.jobId, 'job-not-found', `job "${input.jobId}" not found`, input);
      }
      if (job.status === 'merged' || job.status === 'done') {
        return this.rejectAmendment(input.jobId, 'job-terminal', `job "${input.jobId}" is ${job.status} — terminal lanes take no amendments`, input);
      }
      if (job.briefing === null || job.briefing.trim() === '') {
        return this.rejectAmendment(input.jobId, 'no-briefing', 'job has no recorded briefing to amend', input);
      }
      const briefing = job.briefing;
      const existing = this.listJobAmendments(input.jobId);
      const current = renderEffectiveContract(briefing, existing);
      const supersedes = input.supersedes ?? [];
      const idempotencyKey = input.idempotencyKey ?? null;
      if (idempotencyKey !== null) {
        if (
          idempotencyKey.trim() === '' ||
          idempotencyKey.length > AMENDMENT_MAX_IDEMPOTENCY_KEY_CHARS ||
          [...idempotencyKey].some((character) => {
            const code = character.codePointAt(0) ?? 0;
            return (code < 32 && character !== '\n' && character !== '\t') || code === 127;
          })
        ) {
          return this.rejectAmendment(input.jobId, 'invalid', 'idempotency_key must be bounded printable text', input);
        }
      }
      const requestSha = amendmentRequestSha256({
        body: input.body,
        supersedes,
        approval: input.approval,
        expectedContractSha256: input.expectedContractSha256,
      });
      // Retry determinism outranks staleness: the same idempotency key and
      // request fingerprint always resolves to the same accepted amendment,
      // even when later amendments have since moved the contract.
      if (idempotencyKey !== null) {
        const priorRow = this.db
          .prepare('SELECT * FROM job_amendments WHERE job_id = ? AND idempotency_key = ?')
          .get(input.jobId, idempotencyKey) as Row | undefined;
        if (priorRow !== undefined) {
          const prior = this.amendmentFromRow(priorRow);
          if (prior.requestSha256 === requestSha) {
            return { status: 'accepted' as const, amendment: prior, contract: current, idempotent: true };
          }
          return this.rejectAmendment(
            input.jobId,
            'idempotency-conflict',
            'idempotency_key was already used for a different amendment request',
            input,
          );
        }
      }
      if (input.expectedContractSha256 !== current.contractSha256) {
        return this.rejectAmendment(
          input.jobId,
          'stale',
          `expected_contract_sha256 does not match the current effective contract (now version ${current.version})`,
          input,
          { currentContractSha256: current.contractSha256, currentVersion: current.version },
        );
      }
      const draftError = validateAmendmentDraft({
        body: input.body,
        supersedes,
        approval: input.approval,
        existingAmendmentIds: existing.map((amendment) => amendment.id),
      });
      if (draftError !== null) {
        return this.rejectAmendment(input.jobId, 'invalid', draftError, input);
      }
      // An original:<anchor> supersession is a claim about the briefing: the
      // anchor must actually occur there, or the recorded provenance is false.
      const missingAnchor = supersedes.find(
        (entry) => entry.startsWith('original:') && !briefing.includes(entry.slice('original:'.length)),
      );
      if (missingAnchor !== undefined) {
        return this.rejectAmendment(
          input.jobId,
          'invalid',
          `supersedes anchor "${missingAnchor.slice('original:'.length)}" does not occur in the original briefing`,
          input,
        );
      }
      const createdAt = nowIso();
      const provisional: JobAmendmentRecord = {
        id: randomUUID(),
        jobId: input.jobId,
        version: existing.length + 1,
        body: input.body,
        bodySha256: amendmentBodySha256(input.body),
        supersedes: [...supersedes],
        approval: { by: input.approval.by, reference: input.approval.reference },
        previousContractSha256: current.contractSha256,
        contractSha256: '',
        requestSha256: requestSha,
        idempotencyKey,
        createdAt,
      };
      const rendered = renderEffectiveContract(briefing, [...existing, provisional]);
      const contractSha256 = rendered.contractSha256;
      if (Buffer.byteLength(rendered.text ?? '', 'utf8') > AMENDMENT_CONTRACT_MAX_BYTES) {
        return this.rejectAmendment(
          input.jobId,
          'invalid',
          `the rendered effective contract would exceed ${AMENDMENT_CONTRACT_MAX_BYTES} UTF-8 bytes`,
          input,
        );
      }
      const amendment: JobAmendmentRecord = { ...provisional, contractSha256 };
      this.db
        .prepare(
          `INSERT INTO job_amendments (
             id, job_id, version, body, body_sha256, supersedes,
             approval_by, approval_reference, previous_contract_sha256,
             contract_sha256, request_sha256, idempotency_key, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          amendment.id,
          amendment.jobId,
          amendment.version,
          amendment.body,
          amendment.bodySha256,
          JSON.stringify(amendment.supersedes),
          amendment.approval.by,
          amendment.approval.reference,
          amendment.previousContractSha256,
          amendment.contractSha256,
          amendment.requestSha256,
          amendment.idempotencyKey,
          amendment.createdAt,
        );
      this.appendEvent({
        kind: 'job.amendment-accepted',
        jobId: input.jobId,
        payload: {
          amendment_id: amendment.id,
          version: amendment.version,
          body_sha256: amendment.bodySha256,
          body_bytes: Buffer.byteLength(amendment.body, 'utf8'),
          previous_contract_sha256: amendment.previousContractSha256,
          contract_sha256: amendment.contractSha256,
          supersedes: amendment.supersedes,
          approval_by: amendment.approval.by,
          approval_reference: amendment.approval.reference,
          idempotency_key: amendment.idempotencyKey,
        },
      });
      return { status: 'accepted' as const, amendment, contract: rendered, idempotent: false };
    });
  }

  private rejectAmendment(
    jobId: string,
    code: AddJobAmendmentRejectionCode,
    reason: string,
    input: {
      readonly body: string;
      readonly supersedes?: readonly string[];
      readonly approval: JobAmendmentApproval;
      readonly expectedContractSha256: string;
      readonly idempotencyKey?: string | null;
    },
    current?: { readonly currentContractSha256: string; readonly currentVersion: number },
  ): AddJobAmendmentResult {
    this.appendEvent({
      kind: 'job.amendment-rejected',
      jobId,
      payload: {
        code,
        reason: reason.slice(0, 500),
        body_sha256: amendmentBodySha256(input.body),
        body_bytes: Buffer.byteLength(input.body, 'utf8'),
        supersedes: input.supersedes ?? [],
        expected_contract_sha256: input.expectedContractSha256,
        approval_by: input.approval.by.slice(0, 200),
        approval_reference: input.approval.reference.slice(0, 500),
        ...(input.idempotencyKey != null ? { idempotency_key: input.idempotencyKey.slice(0, 200) } : {}),
        ...(current !== undefined
          ? { current_contract_sha256: current.currentContractSha256, current_version: current.currentVersion }
          : {}),
      },
    });
    return {
      status: 'rejected',
      code,
      reason,
      ...(current !== undefined
        ? { currentContractSha256: current.currentContractSha256, currentVersion: current.currentVersion }
        : {}),
    };
  }

  private amendmentFromRow(row: Row): JobAmendmentRecord {
    let supersedes: unknown;
    try {
      supersedes = JSON.parse(str(row.supersedes));
    } catch (error) {
      throw new Error(`job_amendments row ${str(row.id)} supersedes is not valid JSON: ${String(error)}`);
    }
    if (!Array.isArray(supersedes) || supersedes.some((entry) => typeof entry !== 'string')) {
      throw new Error(`job_amendments row ${str(row.id)} supersedes must be a JSON string array`);
    }
    return {
      id: str(row.id),
      jobId: str(row.job_id),
      version: Number(row.version),
      body: str(row.body),
      bodySha256: str(row.body_sha256),
      supersedes: supersedes as string[],
      approval: { by: str(row.approval_by), reference: str(row.approval_reference) },
      previousContractSha256: str(row.previous_contract_sha256),
      contractSha256: str(row.contract_sha256),
      requestSha256: str(row.request_sha256),
      idempotencyKey: nstr(row.idempotency_key),
      createdAt: str(row.created_at),
    };
  }

  // ------------------------------------------------------------------
  // Worktree registry (E8; SPEC ruling 18b)
  // ------------------------------------------------------------------

  registerWorktree(input: {
    id: string;
    kind: string;
    repoPath: string;
    repoName: string;
    path: string;
    branch?: string | null;
    sha: string;
    /** Base provenance (the manager always declares it for lanes it
     * creates; omitted = unknown, e.g. legacy callers). */
    baseSource?: WorktreeBaseSource | null;
    jobId?: string | null;
    roundId?: string | null;
  }): WorktreeRecord {
    if (input.id === '' || input.path === '' || input.repoPath === '' || input.sha === '') {
      throw new Error('worktree id, path, repo path, and sha must be non-empty');
    }
    if (
      input.baseSource !== undefined &&
      input.baseSource !== null &&
      !isWorktreeBaseSource(input.baseSource)
    ) {
      throw new Error(
        `unknown worktree base source "${input.baseSource}" (valid: ${WORKTREE_BASE_SOURCES.join(', ')})`,
      );
    }
    if (!isWorktreeKind(input.kind)) {
      throw new Error(`unknown worktree kind "${input.kind}" (valid: ${WORKTREE_KINDS.join(', ')})`);
    }
    if (input.kind === 'job' && (input.jobId === null || input.jobId === undefined)) {
      throw new Error(`worktree "${input.id}" of kind 'job' requires its owning job id`);
    }
    if (input.kind === 'review' && (input.roundId === null || input.roundId === undefined)) {
      throw new Error(`worktree "${input.id}" of kind 'review' requires its owning round id`);
    }
    if (input.kind === 'child' && (input.jobId === null || input.jobId === undefined)) {
      throw new Error(`worktree "${input.id}" of kind 'child' requires its owning job id`);
    }
    if (input.jobId !== null && input.jobId !== undefined && this.getJob(input.jobId) === null) {
      throw new RecordNotFound(`job "${input.jobId}" not found — a worktree lane belongs to a real job`);
    }
    if (input.roundId !== null && input.roundId !== undefined && this.getRound(input.roundId) === null) {
      throw new RecordNotFound(`round "${input.roundId}" not found — a review worktree belongs to a real round`);
    }
    return this.transaction(() => {
      if (this.getWorktree(input.id) !== null) {
        throw new Error(`worktree "${input.id}" already exists`);
      }
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO worktrees (id, kind, repo_path, repo_name, path, branch, sha, base_source, job_id, round_id, status, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
        )
        .run(
          input.id,
          input.kind,
          input.repoPath,
          input.repoName,
          input.path,
          input.branch ?? null,
          input.sha,
          input.baseSource ?? null,
          input.jobId ?? null,
          input.roundId ?? null,
          ts,
          ts,
        );
      this.appendEvent({
        kind: 'worktree.created',
        jobId: input.jobId ?? null,
        roundId: input.roundId ?? null,
        payload: {
          id: input.id,
          kind: input.kind,
          path: input.path,
          branch: input.branch ?? null,
          sha: input.sha,
          baseSource: input.baseSource ?? null,
        },
      });
      return this.getWorktree(input.id) as WorktreeRecord;
    });
  }

  getWorktree(id: string): WorktreeRecord | null {
    const row = this.db.prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : this.worktreeFromRow(row);
  }

  listWorktrees(opts: { status?: string; jobId?: string } = {}): readonly WorktreeRecord[] {
    let rows: Row[];
    if (opts.status !== undefined) {
      if (!isWorktreeStatus(opts.status)) {
        throw new Error(`unknown worktree status "${opts.status}"`);
      }
      rows = this.db.prepare('SELECT * FROM worktrees WHERE status = ? ORDER BY created_at, id').all(opts.status) as Row[];
    } else {
      rows = this.db.prepare('SELECT * FROM worktrees ORDER BY created_at, id').all() as Row[];
    }
    const all = rows.map((row) => this.worktreeFromRow(row));
    return opts.jobId === undefined ? all : all.filter((row) => row.jobId === opts.jobId);
  }

  setWorktreeStatus(id: string, status: string, note?: string): WorktreeRecord {
    if (!isWorktreeStatus(status)) throw new Error(`unknown worktree status "${status}"`);
    return this.transaction(() => {
      const current = this.getWorktree(id);
      if (current === null) throw new RecordNotFound(`worktree "${id}" not found`);
      this.db
        .prepare('UPDATE worktrees SET status = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?')
        .run(status, note ?? null, nowIso(), id);
      this.appendEvent({
        kind: 'worktree.status',
        jobId: current.jobId,
        roundId: current.roundId,
        payload: { id, from: current.status, to: status, ...(note !== undefined ? { note } : {}) },
      });
      return this.getWorktree(id) as WorktreeRecord;
    });
  }

  noteWorktree(id: string, note: string): WorktreeRecord {
    return this.transaction(() => {
      const current = this.getWorktree(id);
      if (current === null) throw new RecordNotFound(`worktree "${id}" not found`);
      this.db.prepare('UPDATE worktrees SET note = ?, updated_at = ? WHERE id = ?').run(note, nowIso(), id);
      this.appendEvent({
        kind: 'worktree.note',
        jobId: current.jobId,
        roundId: current.roundId,
        payload: { id, note },
      });
      return this.getWorktree(id) as WorktreeRecord;
    });
  }

  /** Observed-process records (SPEC ruling 18b's spawned-processes arm):
   * every pid a pause or confirmed kill is grounded on lands here — the
   * registry is the authoritative map job → worktree → branch →
   * processes, so the ask can always name what was live. */
  recordWorktreeProcesses(input: {
    worktreeId: string;
    processes: readonly { pid: number; command: string; evidence: string }[];
    state: 'live' | 'killed';
  }): void {
    if (input.processes.length === 0) return;
    if (this.getWorktree(input.worktreeId) === null) {
      throw new RecordNotFound(`worktree "${input.worktreeId}" not found`);
    }
    this.transaction(() => {
      const ts = nowIso();
      const upsert = this.db.prepare(
        `INSERT INTO worktree_processes (worktree_id, pid, command, evidence, state, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (worktree_id, pid) DO UPDATE SET
           state = excluded.state,
           command = excluded.command,
           last_seen = excluded.last_seen`,
      );
      for (const proc of input.processes) {
        upsert.run(input.worktreeId, proc.pid, proc.command, proc.evidence, input.state, ts, ts);
      }
      this.appendEvent({
        kind: 'worktree.processes',
        payload: {
          id: input.worktreeId,
          state: input.state,
          pids: input.processes.map((proc) => proc.pid),
        },
      });
    });
  }

  listWorktreeProcesses(worktreeId: string): readonly {
    readonly pid: number;
    readonly command: string;
    readonly evidence: string;
    readonly state: string;
    readonly lastSeen: string;
  }[] {
    return (
      this.db
        .prepare('SELECT pid, command, evidence, state, last_seen FROM worktree_processes WHERE worktree_id = ? ORDER BY first_seen, pid')
        .all(worktreeId) as Row[]
    ).map((row) => ({
      pid: Number(row.pid),
      command: str(row.command),
      evidence: str(row.evidence),
      state: str(row.state),
      lastSeen: str(row.last_seen),
    }));
  }

  // ------------------------------------------------------------------
  // Rounds (review waves) + lens chips
  // ------------------------------------------------------------------

  addRound(input: {
    jobId: string;
    seq?: number;
    lenses?: readonly string[];
    targetRef?: string | null;
  }): RoundRecord {
    const lenses = input.lenses === undefined || input.lenses.length === 0 ? [...DEFAULT_LENSES] : [...input.lenses];
    for (const lens of lenses) {
      if (lens === '') throw new Error('lens names must be non-empty');
    }
    if (new Set(lenses).size !== lenses.length) {
      throw new Error('lens names must be unique within a round');
    }
    return this.transaction(() => {
      const job = this.getJob(input.jobId);
      if (job === null) throw new RecordNotFound(`job "${input.jobId}" not found`);
      let seq = input.seq;
      if (seq === undefined) {
        const row = this.db
          .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM rounds WHERE job_id = ?')
          .get(input.jobId) as Row;
        seq = Number(row.next);
      }
      const id = `${input.jobId}-r${seq}`;
      if (this.getRound(id) !== null) throw new Error(`round "${id}" already exists`);
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO rounds (id, job_id, seq, status, target_ref, verdict, lenses, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, NULL, ?, ?, ?)`,
        )
        .run(id, input.jobId, seq, input.targetRef ?? null, JSON.stringify(lenses), ts, ts);
      const chip = this.db.prepare(
        'INSERT INTO lens_states (round_id, lens, state, agent_id, note, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)',
      );
      for (const lens of lenses) chip.run(id, lens, 'pending', ts);
      this.appendEvent({ kind: 'round.created', jobId: input.jobId, roundId: id, payload: { seq, lenses } });
      return this.getRound(id) as RoundRecord;
    });
  }

  /** Compare-and-set review admission under the ledger transaction: two
   * service/runner instances cannot each mint a round after independently
   * reconciling the same predecessor. The status flip and round creation
   * commit together (or neither does). Runtime cessation is proven by the
   * caller before this boundary; a changed predecessor requires reproof. */
  admitReviewRound(input: {
    readonly jobId: string;
    readonly expectedLatestRoundId: string | null;
    readonly expectedJobStatus: JobStatus;
    readonly lenses: readonly string[];
    readonly targetRef: string;
  }): RoundRecord {
    return this.transaction(() => {
      const job = this.getJob(input.jobId);
      if (job === null) throw new RecordNotFound(`job "${input.jobId}" not found`);
      const latest = this.db.prepare('SELECT id FROM rounds WHERE job_id = ? ORDER BY seq DESC LIMIT 1')
        .get(input.jobId) as { id: string } | undefined;
      if ((latest?.id ?? null) !== input.expectedLatestRoundId || job.status !== input.expectedJobStatus) {
        throw new Error(`review admission for job ${input.jobId} changed during reconciliation; retry ownership proof before replacement`);
      }
      const active = this.db.prepare("SELECT id FROM rounds WHERE job_id = ? AND status IN ('pending', 'live') LIMIT 1")
        .get(input.jobId) as { id: string } | undefined;
      if (active !== undefined) {
        throw new Error(`review round ${active.id} still owns job ${input.jobId}; reconcile its live owner before replacement`);
      }
      if (job.status === 'working' || job.status === 'blocked') this.setJobStatus(input.jobId, 'in-review');
      return this.addRound({ jobId: input.jobId, lenses: input.lenses, targetRef: input.targetRef });
    });
  }

  /** Undo only this round's provisional status flip. An admitted successor
   * owns the job status now: an older setup failure must not roll it back. */
  restoreReviewSetupStatus(input: {
    readonly jobId: string;
    readonly roundId: string;
    readonly priorStatus: 'working' | 'blocked';
  }): boolean {
    return this.transaction(() => {
      const job = this.getJob(input.jobId);
      const round = this.getRound(input.roundId);
      const latest = this.db.prepare('SELECT id FROM rounds WHERE job_id = ? ORDER BY seq DESC LIMIT 1')
        .get(input.jobId) as { id: string } | undefined;
      if (job?.status !== 'in-review' || round?.jobId !== input.jobId ||
        round.status !== 'aborted' || latest?.id !== input.roundId) return false;
      this.setJobStatus(input.jobId, input.priorStatus);
      return true;
    });
  }

  getRound(id: string): RoundRecord | null {
    const row = this.db.prepare('SELECT * FROM rounds WHERE id = ?').get(id) as Row | undefined;
    if (row === undefined) return null;
    const chips = this.db
      .prepare('SELECT * FROM lens_states WHERE round_id = ? ORDER BY rowid')
      .all(id) as Row[];
    return {
      id: str(row.id),
      jobId: str(row.job_id),
      seq: Number(row.seq),
      status: str(row.status) as RoundStatus,
      targetRef: nstr(row.target_ref),
      verdict: nstr(row.verdict) as RoundVerdict | null,
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
      lenses: chips.map((chip) => ({
        lens: str(chip.lens),
        state: str(chip.state) as LensState,
        agentId: nstr(chip.agent_id),
        note: nstr(chip.note),
        updatedAt: str(chip.updated_at),
      })),
    };
  }

  listRounds(jobId: string): readonly RoundRecord[] {
    const rows = this.db
      .prepare('SELECT id FROM rounds WHERE job_id = ? ORDER BY seq')
      .all(jobId) as Row[];
    return rows.map((row) => this.getRound(str(row.id)) as RoundRecord);
  }

  /**
   * Every round still in flight (pending/live), across all jobs — the roll
   * drain probe. Rounds are terminal at verdict-posted/aborted; anything
   * non-terminal is work the service should finish or abandon before a swap.
   */
  listActiveRounds(): readonly RoundRecord[] {
    const rows = this.db
      .prepare("SELECT id FROM rounds WHERE status IN ('pending', 'live') ORDER BY created_at, id")
      .all() as Row[];
    return rows.map((row) => this.getRound(str(row.id)) as RoundRecord);
  }

  setRoundStatus(id: string, status: string): RoundRecord {
    if (!isRoundStatus(status)) throw new Error(`unknown round status "${status}"`);
    return this.transaction(() => {
      const round = this.getRound(id);
      if (round === null) throw new RecordNotFound(`round "${id}" not found`);
      if (round.status !== status) {
        assertRoundTransition(round.status, status);
        this.db.prepare('UPDATE rounds SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
        this.appendEvent({
          kind: 'round.status',
          jobId: round.jobId,
          roundId: id,
          payload: { from: round.status, to: status },
        });
      }
      return this.getRound(id) as RoundRecord;
    });
  }

  setRoundVerdict(id: string, verdict: string): RoundRecord {
    if (!isRoundVerdict(verdict)) throw new Error(`unknown round verdict "${verdict}"`);
    return this.transaction(() => {
      const round = this.getRound(id);
      if (round === null) throw new RecordNotFound(`round "${id}" not found`);
      this.db.prepare('UPDATE rounds SET verdict = ?, updated_at = ? WHERE id = ?').run(verdict, nowIso(), id);
      this.appendEvent({
        kind: 'round.verdict',
        jobId: round.jobId,
        roundId: id,
        payload: { verdict },
      });
      // A posted verdict IS the verdict-posted state — keep the machine
      // coherent (abort after verdict stays legal only from live…
      // verdict-posted is terminal, so this is a one-way door).
      if (round.status !== 'verdict-posted' && round.status !== 'aborted') {
        this.setRoundStatus(id, 'verdict-posted');
      }
      return this.getRound(id) as RoundRecord;
    });
  }

  setRoundTarget(id: string, ref: string): RoundRecord {
    return this.transaction(() => {
      const round = this.getRound(id);
      if (round === null) throw new RecordNotFound(`round "${id}" not found`);
      this.db.prepare('UPDATE rounds SET target_ref = ?, updated_at = ? WHERE id = ?').run(ref, nowIso(), id);
      this.appendEvent({ kind: 'round.target', jobId: round.jobId, roundId: id, payload: { ref } });
      return this.getRound(id) as RoundRecord;
    });
  }

  /** ATOMIC verdict + deferred-lens-chip finalization (gh-169 round-5
   * P1): the verdict transition and the deferred not-used chip writes
   * commit in ONE transaction — a failure partway leaves NOTHING
   * committed (the round stays live, the chips stay pending, the abort
   * path stays legal), and a posted verdict can never coexist with a
   * mixed or pending deferred-chip set. */
  finalizeRoundVerdictWithLensOutcomes(
    id: string,
    verdict: string,
    outcomes: ReadonlyArray<{ readonly lens: string; readonly state: 'done' | 'error'; readonly note: string }>,
  ): RoundRecord {
    if (!isRoundVerdict(verdict)) throw new Error(`unknown round verdict "${verdict}"`);
    return this.transaction(() => {
      const round = this.getRound(id);
      if (round === null) throw new RecordNotFound(`round "${id}" not found`);
      for (const outcome of outcomes) {
        const chip = round.lenses.find((entry) => entry.lens === outcome.lens);
        if (chip === undefined) throw new RecordNotFound(`round "${id}" has no lens "${outcome.lens}"`);
        if (chip.state === 'pending' || chip.state === 'live') {
          assertLensTransition(chip.state, outcome.state);
          this.db
            .prepare('UPDATE lens_states SET state = ?, note = ?, updated_at = ? WHERE round_id = ? AND lens = ?')
            .run(outcome.state, outcome.note, nowIso(), id, outcome.lens);
          this.appendEvent({
            kind: 'lens.status',
            jobId: round.jobId,
            roundId: id,
            lens: outcome.lens,
            payload: { from: chip.state, to: outcome.state, note: outcome.note },
          });
        }
      }
      return this.setRoundVerdict(id, verdict);
    });
  }

  /** Bind a lens chip to its live agent session (chip state derives from it). */
  bindLens(roundId: string, lens: string, agentId: string): RoundRecord {
    return this.transaction(() => {
      const round = this.getRound(roundId);
      if (round === null) throw new RecordNotFound(`round "${roundId}" not found`);
      const chip = round.lenses.find((entry) => entry.lens === lens);
      if (chip === undefined) throw new RecordNotFound(`round "${roundId}" has no lens "${lens}"`);
      this.db
        .prepare('UPDATE lens_states SET agent_id = ?, updated_at = ? WHERE round_id = ? AND lens = ?')
        .run(agentId, nowIso(), roundId, lens);
      // Backfill the agent's round/job wiring: runtime-tap registration
      // (spawn envelopes) carries no round context — binding is the ONE
      // call that connects chip to agent to round.
      this.db
        .prepare(
          'UPDATE agents SET round_id = ?, job_id = COALESCE(job_id, ?), updated_at = ? WHERE id = ? AND round_id IS NULL',
        )
        .run(roundId, round.jobId, nowIso(), agentId);
      this.appendEvent({
        kind: 'lens.bound',
        jobId: round.jobId,
        roundId,
        lens,
        agentId,
        payload: { agentId },
      });
      return this.getRound(roundId) as RoundRecord;
    });
  }

  /** Explicit lens outcome (done/error + note) — set by the wave runner or derived rules. */
  setLensOutcome(roundId: string, lens: string, state: string, note?: string): RoundRecord {
    if (!isLensState(state)) throw new Error(`unknown lens state "${state}"`);
    return this.transaction(() => {
      const round = this.getRound(roundId);
      if (round === null) throw new RecordNotFound(`round "${roundId}" not found`);
      const chip = round.lenses.find((entry) => entry.lens === lens);
      if (chip === undefined) throw new RecordNotFound(`round "${roundId}" has no lens "${lens}"`);
      if (chip.state !== state) {
        assertLensTransition(chip.state, state);
        this.db
          .prepare('UPDATE lens_states SET state = ?, note = ?, updated_at = ? WHERE round_id = ? AND lens = ?')
          .run(state, note ?? chip.note, nowIso(), roundId, lens);
        this.appendEvent({
          kind: 'lens.status',
          jobId: round.jobId,
          roundId,
          lens,
          agentId: chip.agentId,
          payload: { from: chip.state, to: state, ...(note !== undefined ? { note } : {}) },
        });
      }
      return this.getRound(roundId) as RoundRecord;
    });
  }

  /** Lens-chip derivation helper: LIVE on turn activity (idempotent). */
  markLensLive(roundId: string, lens: string): RoundRecord {
    const round = this.getRound(roundId);
    if (round === null) throw new RecordNotFound(`round "${roundId}" not found`);
    const chip = round.lenses.find((entry) => entry.lens === lens);
    if (chip === undefined || chip.state === 'live' || chip.state === 'done' || chip.state === 'error') {
      return round; // already live or resolved — idempotent, no event
    }
    return this.setLensOutcome(roundId, lens, 'live');
  }

  // ------------------------------------------------------------------
  // Agents
  // ------------------------------------------------------------------

  registerAgent(input: {
    id: string;
    role: Role;
    label?: string | null;
    jobId?: string | null;
    roundId?: string | null;
    sessionFile?: string | null;
    /** Issue #161: the durable parent link for a child worker. When set,
     * the row's parentage is `child` and the parent must already exist. */
    parentAgentId?: string | null;
    /** Issue #161: explicit parentage for a known-parentless session.
     * Omitted (with no parent link) leaves parentage NULL — genuinely
     * unknown, never a fabricated top-level declaration. */
    parentage?: AgentParentage | null;
  }): AgentRecord {
    if (input.id === '') throw new Error('agent id must be non-empty');
    if (input.parentAgentId !== undefined && input.parentAgentId !== null && input.parentAgentId === '') {
      throw new Error('parent agent id must be non-empty when declared');
    }
    if (input.parentage !== undefined && input.parentage !== null &&
        input.parentage !== 'top-level' && input.parentage !== 'child') {
      throw new Error(`unknown agent parentage "${String(input.parentage)}" (valid: top-level, child)`);
    }
    if (input.parentAgentId !== undefined && input.parentAgentId !== null &&
        input.parentage !== undefined && input.parentage !== null && input.parentage !== 'child') {
      throw new Error('a parent link declares parentage "child" — parentage and parent link disagree');
    }
    return this.transaction(() => {
      const existing = this.getAgent(input.id);
      const ts = nowIso();
      if (input.parentAgentId !== undefined && input.parentAgentId !== null && existing === null && this.getAgent(input.parentAgentId) === null) {
        throw new RecordNotFound(`parent agent "${input.parentAgentId}" not found — a child row needs a real parent`);
      }
      const parentAgentId = input.parentAgentId !== undefined && input.parentAgentId !== null
        ? input.parentAgentId
        : (existing?.parentAgentId ?? null);
      const declaredParentage: AgentParentage | null = parentAgentId !== null
        ? 'child'
        : (input.parentage !== undefined ? input.parentage : (existing?.parentage ?? null));
      if (existing === null) {
        this.db
          .prepare(
            `INSERT INTO agents (id, role, label, job_id, round_id, state, last_activity, session_file, parent_agent_id, parentage, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'spawning', NULL, ?, ?, ?, ?, ?)`,
          )
          .run(input.id, input.role, input.label ?? null, input.jobId ?? null, input.roundId ?? null, input.sessionFile ?? null, parentAgentId, declaredParentage, ts, ts);
        this.appendEvent({
          kind: 'agent.spawned',
          agentId: input.id,
          jobId: input.jobId ?? null,
          roundId: input.roundId ?? null,
          payload: {
            role: input.role,
            label: input.label ?? null,
            ...(parentAgentId !== null ? { parentAgentId } : {}),
          },
        });
      } else {
        // The runtime spawn tap knows the spawn role only. Fallback review
        // workers spawn as minions, then receive their durable Perkins role;
        // a resumed spawn must never turn them into implementer candidates.
        const role = existing.role === 'perkins' && input.role === 'minion' ? existing.role : input.role;
        this.db
          .prepare(
            `UPDATE agents SET role = ?, label = COALESCE(?, label), job_id = COALESCE(?, job_id),
             round_id = COALESCE(?, round_id), session_file = COALESCE(?, session_file),
             parent_agent_id = COALESCE(?, parent_agent_id), parentage = COALESCE(?, parentage), updated_at = ? WHERE id = ?`,
          )
          .run(
            role,
            input.label ?? null,
            input.jobId ?? null,
            input.roundId ?? null,
            input.sessionFile ?? null,
            parentAgentId,
            declaredParentage,
            ts,
            input.id,
          );
      }
      return this.getAgent(input.id) as AgentRecord;
    });
  }

  getAgent(id: string): AgentRecord | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : this.agentFromRow(row);
  }

  listAgents(): readonly AgentRecord[] {
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY updated_at DESC, id').all() as Row[];
    return rows.map((row) => this.agentFromRow(row));
  }

  /** The implementing minions of one job, newest spawn first: role-minion
   * rows MINUS review-only sessions (Gru ruling 2026-09-29 on the phase8
   * finding). A session is review-only when existing data says so — the
   * review-worker role (Perkins lead, lens specialists, fallback reviewer),
   * review-round membership (`round_id`), or a bound lens chip — and a
   * review-only session must never win a latest-minion pick (re-brief
   * resume, Silas digest, fix-directive routing). Recency is spawn order
   * (`created_at`): observer state writes refresh `updated_at` on older
   * rows, so a revisited old implementer must not outrank the newest.
   * Query-side exclusion only: no schema change, and the lens subquery
   * rides idx_lens_agent. */
  listImplementerMinions(jobId: string): readonly AgentRecord[] {
    // Implementer-only selection (crew-heist-labels): role 'minion' for the
    // job, never round- or lens-bound review sessions. Issue #161 union:
    // a tracked child worker is never the primary lane worker either.
    // Newest spawn first: created_at has millisecond precision, so ties
    // break by rowid DESC — SQLite's monotonic insertion order — never by
    // the incidental alphabetical order of the UUID id column.
    const rows = this.db
      .prepare(
        `SELECT * FROM agents
         WHERE job_id = ? AND role = 'minion' AND round_id IS NULL
           AND (parentage IS NULL OR parentage <> 'child')
           AND NOT EXISTS (SELECT 1 FROM lens_states WHERE lens_states.agent_id = agents.id)
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(jobId) as Row[];
    return rows.map((row) => this.agentFromRow(row));
  }

  setAgentState(id: string, state: AgentState, error?: string): AgentRecord {
    return this.transaction(() => {
      const agent = this.getAgent(id);
      if (agent === null) throw new RecordNotFound(`agent "${id}" not found`);
      const ts = nowIso();
      this.db
        .prepare('UPDATE agents SET state = ?, last_activity = ?, updated_at = ? WHERE id = ?')
        .run(state, ts, ts, id);
      if (agent.state !== state) {
        this.appendEvent({
          kind: 'agent.state',
          agentId: id,
          jobId: agent.jobId,
          roundId: agent.roundId,
          payload: { from: agent.state, to: state, ...(error !== undefined ? { error } : {}) },
        });
      }
      return this.getAgent(id) as AgentRecord;
    });
  }

  /**
   * Durable supervision stop truth for restart hydration (code review
   * 2026-10-04): the latest supervision lifecycle event per agent, kept
   * only when that latest event is a STOP. A re-arm event clears the stop,
   * so an acked/re-armed agent never reads stopped after a restart.
   */
  durableSupervisionStops(): Map<
    string,
    { readonly role: Role; readonly reason: string | null; readonly restarts: number }
  > {
    const rows = this.db
      .prepare(
        `SELECT e.agent_id AS agent_id, a.role AS role, e.kind AS kind, e.payload AS payload
           FROM events e
           JOIN (
             SELECT agent_id, MAX(seq) AS seq
               FROM events
              WHERE agent_id IS NOT NULL
                AND kind IN ('supervision.escalated', 'supervision.breaker', 'supervision.rearmed')
              GROUP BY agent_id
           ) latest ON latest.agent_id = e.agent_id AND latest.seq = e.seq
           JOIN agents a ON a.id = e.agent_id
          WHERE e.kind IN ('supervision.escalated', 'supervision.breaker')`,
      )
      .all() as Array<{ agent_id: string; role: Role; payload: string }>;
    const stops = new Map<string, { role: Role; reason: string | null; restarts: number }>();
    for (const row of rows) {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        // A malformed payload still yields a cause-less stop: the presence
        // of the stop event is the authoritative fact.
      }
      const reason =
        typeof payload['class'] === 'string'
          ? payload['class']
          : typeof payload['reason'] === 'string'
            ? payload['reason']
            : null;
      const restarts =
        typeof payload['restarts'] === 'number' && Number.isFinite(payload['restarts'])
          ? payload['restarts']
          : 0;
      stops.set(row.agent_id, { role: row.role, reason, restarts });
    }
    return stops;
  }

  /** Attach a live agent to its job lane (E8 dispatch wiring; the spawn
   * envelope carries no job context — this is the one call that binds).
   * (Superseded in the dispatch path by registerAgent-with-jobId, which
   * makes the binding independent of observer ordering; retained as the
   * API-of-record surface for external surfaces.) */
  attachAgentToJob(agentId: string, jobId: string): AgentRecord {
    return this.transaction(() => {
      const agent = this.getAgent(agentId);
      if (agent === null) throw new RecordNotFound(`agent "${agentId}" not found`);
      if (this.getJob(jobId) === null) throw new RecordNotFound(`job "${jobId}" not found`);
      this.db
        .prepare('UPDATE agents SET job_id = ?, updated_at = ? WHERE id = ?')
        .run(jobId, nowIso(), agentId);
      this.appendEvent({ kind: 'agent.attached', agentId, jobId, payload: { jobId } });
      return this.getAgent(agentId) as AgentRecord;
    });
  }

  /** Attach a live agent to a review round (E8 wave wiring). */
  attachAgentToRound(agentId: string, roundId: string): AgentRecord {
    return this.transaction(() => {
      const agent = this.getAgent(agentId);
      if (agent === null) throw new RecordNotFound(`agent "${agentId}" not found`);
      const round = this.getRound(roundId);
      if (round === null) throw new RecordNotFound(`round "${roundId}" not found`);
      this.db
        .prepare('UPDATE agents SET round_id = ?, job_id = COALESCE(job_id, ?), updated_at = ? WHERE id = ?')
        .run(roundId, round.jobId, nowIso(), agentId);
      this.appendEvent({ kind: 'agent.attached', agentId, jobId: round.jobId, roundId, payload: { roundId } });
      return this.getAgent(agentId) as AgentRecord;
    });
  }

  // ------------------------------------------------------------------
  // Tracked child workers (issue #161)
  // ------------------------------------------------------------------

  /**
   * Idempotent admission of one LOGICAL child worker. The child's agent
   * row and its child_workers admission row land in ONE transaction, so
   * a crash can never strand a child identity without its admission
   * record (or vice versa). A retry with the same (parent, idempotency
   * key) replays the existing child; the same key with a different
   * canonical payload fails loud (`ChildWorkerConflictError`) and never
   * replaces the admitted request. The payload hash is computed HERE
   * from the canonical fields — callers cannot desynchronize it.
   *
   * Structural invariants enforced at this boundary (not just at the
   * HTTP edge): the parent exists and is not itself a child (recursive
   * fanout is bounded — children never spawn children), the parent's
   * job binding matches the declared job, and the job is not terminal
   * (an expired lane admits no fresh worker).
   */
  admitChildWorker(input: {
    id: string;
    parentAgentId: string;
    jobId: string;
    purpose: string;
    authority: ChildWorkerAuthority;
    task: string;
    label?: string | null;
    idempotencyKey: string;
  }): { readonly record: ChildWorkerRecord; readonly idempotent: boolean } {
    for (const [field, value] of [
      ['child agent id', input.id],
      ['parent agent id', input.parentAgentId],
      ['job id', input.jobId],
      ['purpose', input.purpose],
      ['task', input.task],
      ['idempotency key', input.idempotencyKey],
    ] as const) {
      if (value.trim() === '') throw new Error(`child worker ${field} must be non-empty`);
    }
    if (!isChildWorkerAuthority(input.authority)) {
      throw new Error(
        `unknown child worker authority "${String(input.authority)}" (valid: ${CHILD_WORKER_AUTHORITIES.join(', ')})`,
      );
    }
    const payload = JSON.stringify({
      parent_agent_id: input.parentAgentId,
      job_id: input.jobId,
      purpose: input.purpose,
      authority: input.authority,
      task: input.task,
      label: input.label ?? null,
    });
    const payloadHash = createHash('sha256').update(payload).digest('hex');
    return this.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM child_workers WHERE parent_agent_id = ? AND idempotency_key = ?')
        .get(input.parentAgentId, input.idempotencyKey) as Row | undefined;
      if (existing !== undefined) {
        if (str(existing.payload_hash) !== payloadHash) {
          throw new ChildWorkerConflictError(
            `idempotency key "${input.idempotencyKey}" was already admitted for parent ` +
              `"${input.parentAgentId}" with a different payload — the admitted request is immutable`,
          );
        }
        return { record: this.childWorkerFromRow(existing), idempotent: true };
      }
      const parent = this.getAgent(input.parentAgentId);
      if (parent === null) {
        throw new RecordNotFound(`parent agent "${input.parentAgentId}" not found — a child needs a real parent`);
      }
      if (parent.parentage === 'child' || parent.parentAgentId !== null) {
        throw new ChildWorkerConflictError(
          `parent agent "${parent.id}" is itself a child worker — children never spawn children`,
        );
      }
      if (parent.jobId !== null && parent.jobId !== input.jobId) {
        throw new ChildWorkerConflictError(
          `parent agent "${parent.id}" is bound to job "${parent.jobId}", not "${input.jobId}"`,
        );
      }
      const job = this.getJob(input.jobId);
      if (job === null) {
        throw new RecordNotFound(`job "${input.jobId}" not found — a child worker belongs to a real job`);
      }
      if (isJobTerminal(job.status)) {
        throw new ChildWorkerConflictError(
          `job "${input.jobId}" is ${job.status} — an expired lane admits no fresh child worker`,
        );
      }
      const ts = nowIso();
      // The child's agent row is written AT admission with its product-
      // owned id, so the durable identity (agent row, child record and
      // lane) exists before any session — a queued child is visible on
      // the board and can be navigated to immediately. The spawn binds
      // the session FILE, never a new identity (SpawnOptions.agentId).
      this.db
        .prepare(
          `INSERT INTO agents (id, role, label, job_id, round_id, state, last_activity, session_file, parent_agent_id, parentage, created_at, updated_at)
           VALUES (?, 'minion', ?, ?, NULL, 'spawning', NULL, NULL, ?, 'child', ?, ?)`,
        )
        .run(
          input.id,
          input.label ?? `child of ${input.parentAgentId}`,
          input.jobId,
          input.parentAgentId,
          ts,
          ts,
        );
      this.db
        .prepare(
          `INSERT INTO child_workers
             (id, agent_id, parent_agent_id, job_id, purpose, authority, task, label, idempotency_key,
              payload_hash, state, worktree_id, branch, session_file, result_state, result_summary,
              result_ref, created_at, admitted_at, started_at, finished_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, ?)`,
        )
        .run(
          input.id,
          input.id,
          input.parentAgentId,
          input.jobId,
          input.purpose,
          input.authority,
          input.task,
          input.label ?? null,
          input.idempotencyKey,
          payloadHash,
          ts,
          ts,
        );
      this.appendEvent({
        kind: 'agent.spawned',
        agentId: input.id,
        jobId: input.jobId,
        payload: { role: 'minion', label: input.label ?? null, parentAgentId: input.parentAgentId },
      });
      this.appendEvent({
        kind: 'child.queued',
        agentId: input.id,
        jobId: input.jobId,
        payload: {
          childId: input.id,
          parentAgentId: input.parentAgentId,
          purpose: input.purpose,
          authority: input.authority,
          idempotencyKey: input.idempotencyKey,
        },
      });
      return { record: this.getChildWorker(input.id) as ChildWorkerRecord, idempotent: false };
    });
  }

  getChildWorker(id: string): ChildWorkerRecord | null {
    const row = this.db.prepare('SELECT * FROM child_workers WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : this.childWorkerFromRow(row);
  }

  /** The child record owned by an agent id (the supervision restart policy
   * resolver keys on this; null = not a tracked child). */
  childWorkerByAgent(agentId: string): ChildWorkerRecord | null {
    const row = this.db
      .prepare('SELECT * FROM child_workers WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(agentId) as Row | undefined;
    return row === undefined ? null : this.childWorkerFromRow(row);
  }

  listChildWorkers(
    opts: { jobId?: string; parentAgentId?: string; state?: ChildWorkerState } = {},
  ): readonly ChildWorkerRecord[] {
    if (opts.state !== undefined && !isChildWorkerState(opts.state)) {
      throw new Error(`unknown child worker state "${opts.state}"`);
    }
    const clauses: string[] = [];
    const values: string[] = [];
    if (opts.jobId !== undefined) {
      clauses.push('job_id = ?');
      values.push(opts.jobId);
    }
    if (opts.parentAgentId !== undefined) {
      clauses.push('parent_agent_id = ?');
      values.push(opts.parentAgentId);
    }
    if (opts.state !== undefined) {
      clauses.push('state = ?');
      values.push(opts.state);
    }
    const where = clauses.length === 0 ? '' : ` WHERE ${clauses.join(' AND ')}`;
    const rows = this.db
      .prepare(`SELECT * FROM child_workers${where} ORDER BY created_at, id`)
      .all(...values) as Row[];
    return rows.map((row) => this.childWorkerFromRow(row));
  }

  /** The child's lane exists and its spawn is starting. */
  markChildAdmitted(id: string, input: { worktreeId: string; branch: string | null }): ChildWorkerRecord {
    return this.transaction(() => {
      const record = this.getChildWorker(id);
      if (record === null) throw new RecordNotFound(`child worker "${id}" not found`);
      if (record.state !== 'queued') {
        throw new ChildWorkerConflictError(
          `child worker "${id}" is ${record.state} — only a queued child can be admitted`,
        );
      }
      const ts = nowIso();
      this.db
        .prepare(
          `UPDATE child_workers SET state = 'admitted', worktree_id = ?, branch = ?, admitted_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(input.worktreeId, input.branch, ts, ts, id);
      this.appendEvent({
        kind: 'child.admitted',
        agentId: record.agentId,
        jobId: record.jobId,
        payload: { childId: id, worktreeId: input.worktreeId, branch: input.branch },
      });
      return this.getChildWorker(id) as ChildWorkerRecord;
    });
  }

  /** A live child session is running the task. */
  markChildStarted(id: string, input: { sessionFile: string | null }): ChildWorkerRecord {
    return this.transaction(() => {
      const record = this.getChildWorker(id);
      if (record === null) throw new RecordNotFound(`child worker "${id}" not found`);
      if (record.state !== 'admitted') {
        throw new ChildWorkerConflictError(
          `child worker "${id}" is ${record.state} — only an admitted child can start`,
        );
      }
      const ts = nowIso();
      this.db
        .prepare(
          `UPDATE child_workers SET state = 'active', session_file = ?, started_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(input.sessionFile, ts, ts, id);
      this.appendEvent({
        kind: 'child.started',
        agentId: record.agentId,
        jobId: record.jobId,
        payload: { childId: id, sessionFile: input.sessionFile },
      });
      return this.getChildWorker(id) as ChildWorkerRecord;
    });
  }

  /**
   * Record the child's terminal result. First write wins: a repeated
   * settle (a resume or a late duplicate observation) replays the
   * existing terminal record instead of overwriting it — the result
   * belongs to the run that finished, once.
   */
  recordChildResult(
    id: string,
    input: { state: ChildResultState; summary: string | null; ref: string | null },
  ): ChildWorkerRecord {
    if (!(CHILD_RESULT_STATES as readonly string[]).includes(input.state)) {
      throw new Error(`unknown child result state "${String(input.state)}"`);
    }
    return this.transaction(() => {
      const record = this.getChildWorker(id);
      if (record === null) throw new RecordNotFound(`child worker "${id}" not found`);
      if (record.resultState !== null) return record;
      const ts = nowIso();
      this.db
        .prepare(
          `UPDATE child_workers SET state = ?, result_state = ?, result_summary = ?, result_ref = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(input.state, input.state, input.summary, input.ref, ts, ts, id);
      this.appendEvent({
        kind: 'child.result',
        agentId: record.agentId,
        jobId: record.jobId,
        payload: { childId: id, state: input.state, summary: input.summary, ref: input.ref },
      });
      return this.getChildWorker(id) as ChildWorkerRecord;
    });
  }

  /** Cancel a non-terminal child (owner stop or parent cancellation).
   * Terminal records are immutable: a second cancel replays the result. */
  cancelChildWorker(id: string, input: { reason: string }): ChildWorkerRecord {
    return this.transaction(() => {
      const record = this.getChildWorker(id);
      if (record === null) throw new RecordNotFound(`child worker "${id}" not found`);
      if (record.resultState !== null) return record;
      return this.recordChildResult(id, {
        state: 'cancelled',
        summary: input.reason,
        // The transcript stays discoverable even for a cancelled child.
        ref: record.resultRef ?? record.sessionFile,
      });
    });
  }

  /** Present-state + lifetime counters. Every number is a SQL aggregate
   * over child_workers rows; `lifetimeCreations` is the row count, so
   * retries/resumes cannot double-count and restart changes nothing.
   * `queued` includes `admitted` — a child whose lane exists but whose
   * resident admission is still waiting is NOT active; `active` means a
   * live session is running the task. */
  countChildWorkers(): ChildWorkerCounts {
    const rows = this.db
      .prepare('SELECT state, COUNT(*) AS n FROM child_workers GROUP BY state')
      .all() as Array<{ state: string; n: number }>;
    let queued = 0;
    let active = 0;
    let finished = 0;
    for (const row of rows) {
      if (row.state === 'queued' || row.state === 'admitted') queued += row.n;
      else if (row.state === 'active') active += row.n;
      else finished += row.n;
    }
    return { queued, active, finished, lifetimeCreations: queued + active + finished };
  }

  /** Per-parent family counters (the board's parent rows). */
  childCountsByParent(): ReadonlyMap<string, ChildWorkerCounts> {
    const rows = this.db
      .prepare('SELECT parent_agent_id, state, COUNT(*) AS n FROM child_workers GROUP BY parent_agent_id, state')
      .all() as Array<{ parent_agent_id: string; state: string; n: number }>;
    const counts = new Map<string, { queued: number; active: number; finished: number }>();
    for (const row of rows) {
      const entry = counts.get(row.parent_agent_id) ?? { queued: 0, active: 0, finished: 0 };
      if (row.state === 'queued' || row.state === 'admitted') entry.queued += row.n;
      else if (row.state === 'active') entry.active += row.n;
      else entry.finished += row.n;
      counts.set(row.parent_agent_id, entry);
    }
    return new Map(
      [...counts.entries()].map(([parent, entry]) => [
        parent,
        { ...entry, lifetimeCreations: entry.queued + entry.active + entry.finished },
      ]),
    );
  }

  appendCustomEvent(fields: {
    kind: string;
    agentId?: string | null;
    jobId?: string | null;
    roundId?: string | null;
    lens?: string | null;
    payload?: unknown;
  }): BusEvent {
    return this.transaction(() =>
      this.appendEvent({
        kind: fields.kind,
        agentId: fields.agentId ?? null,
        jobId: fields.jobId ?? null,
        roundId: fields.roundId ?? null,
        lens: fields.lens ?? null,
        payload: fields.payload,
      }),
    );
  }

  /** Delivery-only crash recovery: check the exact admitted markers and
   * job status under the SAME write transaction as the event. A concurrent
   * terminal commit cannot slip between the guard and a fabricated delivery. */
  appendCustomEventIfCurrentRebrief(
    fields: Parameters<LedgerApi['appendCustomEvent']>[0],
    expected: readonly PendingRebriefRecord[],
  ): BusEvent {
    const jobId = fields.jobId;
    if (jobId === undefined || jobId === null) throw new Error('guarded re-brief event requires a job id');
    return this.transaction(() => {
      if (!this.matchesPendingRebriefGeneration(jobId, expected)) {
        throw new PendingRebriefNoLongerCurrent('superseded');
      }
      const job = this.getJob(jobId);
      if (job === null) throw new RecordNotFound(`job "${jobId}" no longer exists — guarded re-brief delivery refused`);
      if (isJobTerminal(job.status)) throw new PendingRebriefNoLongerCurrent('terminal');
      return this.appendEvent(fields);
    });
  }

  // ------------------------------------------------------------------
  // Pending re-briefs (see the type block above)
  // ------------------------------------------------------------------

  /** Persist a re-brief REQUEST before any worker is spawned: one durable
   * marker per guarded event (`silas.rebrief` + `job.delivered`), carrying
   * the request payload, its hash, and the event-sequence watermark below
   * which an event cannot answer this request. A newer request for the
   * same job+kind supersedes the older marker (upsert) — the latest note
   * is the one the current worker runs. When the request carries an
   * explicit completion intent, the phase-handoff guard row is created in
   * the SAME transaction (before any side effect) and its id lands on both
   * markers; a newer re-brief supersedes the older awaiting phase — its
   * late receipt can never hand back a lane the request no longer owns. */
  beginPendingRebrief(input: {
    jobId: string;
    note: string | null;
    briefing: string | null;
    /** Explicit completion intent; omitted = ordinary re-brief (no phase). */
    handoff?: CompletionHandoffIntent;
  }): readonly PendingRebriefRecord[] {
    const payload = JSON.stringify({ note: input.note, briefing: input.briefing });
    const payloadHash = createHash('sha256').update(payload).digest('hex');
    return this.transaction(() => {
      // The HTTP caller pre-checks, but admission is the boundary of
      // record: a terminal transition between that check and the write is
      // refused HERE, so a terminal lane can never receive a fresh marker
      // (refused before any handoff row is created below).
      const job = this.getJob(input.jobId);
      if (job === null) {
        throw new RecordNotFound(`job "${input.jobId}" not found — a re-brief marker belongs to a real job`);
      }
      if (isJobTerminal(job.status)) {
        throw new Error(`job "${input.jobId}" is ${job.status} — terminal lanes are never re-briefed`);
      }
      let phaseId: string | null = null;
      if (input.handoff !== undefined) {
        for (const prior of this.listPhaseHandoffs({
          jobId: input.jobId,
          source: 'silas-rebrief',
          states: ['awaiting'],
        })) {
          this.closePhaseHandoff({
            phaseId: prior.phaseId,
            reason: 'superseded by a newer re-brief request',
          });
        }
        phaseId = this.beginPhaseHandoff({
          jobId: input.jobId,
          source: 'silas-rebrief',
          intent: input.handoff,
        }).record.phaseId;
      }
      const baselineSeq = this.latestEventSeq();
      const ts = nowIso();
      const upsert = this.db.prepare(
        `INSERT INTO pending_rebriefs
           (id, job_id, kind, payload, payload_hash, baseline_seq, agent_id, session_file, phase_id, requested_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
         ON CONFLICT (job_id, kind) DO UPDATE SET
           id = excluded.id,
           payload = excluded.payload,
           payload_hash = excluded.payload_hash,
           baseline_seq = excluded.baseline_seq,
           agent_id = NULL,
           session_file = NULL,
           phase_id = excluded.phase_id,
           requested_at = excluded.requested_at,
           updated_at = excluded.updated_at`,
      );
      for (const kind of PENDING_REBRIEF_KINDS) {
        upsert.run(randomUUID(), input.jobId, kind, payload, payloadHash, baselineSeq, phaseId, ts, ts);
      }
      return this.listPendingRebriefs({ jobId: input.jobId });
    });
  }

  /** Bind the spawned re-brief worker to its markers (before its prompt is
   * delivered) so a crash mid-turn can resume the exact session. */
  bindPendingRebriefWorker(input: {
    ids: readonly string[];
    agentId: string;
    sessionFile: string | null;
  }): void {
    if (input.agentId === '') throw new Error('pending-rebrief worker id must be non-empty');
    this.transaction(() => {
      const update = this.db.prepare(
        'UPDATE pending_rebriefs SET agent_id = ?, session_file = ?, updated_at = ? WHERE id = ?',
      );
      const ts = nowIso();
      for (const id of input.ids) update.run(input.agentId, input.sessionFile, ts, id);
    });
  }

  listPendingRebriefs(opts: { jobId?: string } = {}): readonly PendingRebriefRecord[] {
    const rows =
      opts.jobId === undefined
        ? (this.db.prepare('SELECT * FROM pending_rebriefs ORDER BY job_id, kind').all() as Row[])
        : (this.db
            .prepare('SELECT * FROM pending_rebriefs WHERE job_id = ? ORDER BY kind')
            .all(opts.jobId) as Row[]);
    return rows.map((row) => this.pendingRebriefFromRow(row));
  }

  /** Clear markers ONLY once their guarded events landed. Deleting is the
   * clearing: the events table remains the durable history. */
  clearPendingRebriefs(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.transaction(() => {
      const remove = this.db.prepare('DELETE FROM pending_rebriefs WHERE id = ?');
      for (const id of ids) remove.run(id);
    });
  }

  /** Complete the still-admitted re-brief generation AND publish its durable
   * settlement signal in ONE transaction (issue #189): the identity-checked
   * marker deletion and the `silas.rebrief-settled` append commit together
   * or not at all. The previous clear-then-append ordering stranded queued
   * review handoffs: a failure after the clear committed left neither the
   * markers a pending-marker scan needs to repair the gap nor the event a
   * queued handoff waits on. Here a settlement failure rolls the deletion
   * back, so the markers stay for the next pass and the next attempt can
   * still release the handoff; a success publishes the settlement on the
   * bus exactly once, only after COMMIT, and never for a superseded
   * generation, a retirement, or a malformed pair.
   *
   * The boundary enforces LEDGER TRUTH, never a caller assertion: the rows
   * must form one complete, coherent marker pair (one marker per guarded
   * kind, identical phase id, payload hash, and baseline watermark) whose
   * guarded events have already landed — mirroring how
   * `retirePendingRebriefs` re-verifies event truth inside its transaction.
   * A caller that asks to settle an unfinished or incoherent request is a
   * bug: the transaction aborts with a named refusal and nothing is deleted
   * or published. The atomicity guarantee is the ledger's durability — the
   * event row commits with the clear; delivery to a given live bus listener
   * afterwards is the bus's own contract (a failing listener drops that
   * event for itself and restart recovery re-arms from `job.delivered`). */
  clearPendingRebriefsIfCurrentAndSettle(expected: readonly PendingRebriefRecord[]): boolean {
    const jobId = expected[0]?.jobId;
    if (jobId === undefined) throw new Error('settling a re-brief generation requires markers');
    return this.transaction(() => {
      if (!this.matchesPendingRebriefGeneration(jobId, expected)) return false;
      this.assertSettleableRebriefGeneration(jobId, expected);
      this.clearPendingRebriefs(expected.map((marker) => marker.id));
      this.appendEvent({ kind: 'silas.rebrief-settled', jobId });
      return true;
    });
  }

  /** Refuse — loudly, before any deletion — a generation that must never
   * publish settlement: an incomplete or incoherent marker pair, or a
   * marker whose guarded event has not landed. Ledger truth only: the
   * events table decides, never the caller's snapshot. */
  private assertSettleableRebriefGeneration(jobId: string, expected: readonly PendingRebriefRecord[]): void {
    const coherentPair = expected.length === 2 &&
      PENDING_REBRIEF_KINDS.every((kind) => expected.some((marker) => marker.kind === kind)) &&
      expected[0] !== undefined && expected[1] !== undefined &&
      expected[0].phaseId === expected[1].phaseId &&
      expected[0].payloadHash === expected[1].payloadHash &&
      expected[0].baselineSeq === expected[1].baselineSeq;
    if (!coherentPair) {
      throw new Error(`job "${jobId}" cannot settle a re-brief: the marker pair is incomplete or incoherent — settlement requires one marker per guarded kind with identical phase id, payload hash, and baseline watermark`);
    }
    for (const marker of expected) {
      const landed = marker.phaseId === null
        ? (this.latestJobEvent(marker.jobId, marker.kind)?.seq ?? 0) > marker.baselineSeq
        : this.db.prepare(
          `SELECT 1 FROM events
           WHERE job_id = ? AND kind = ? AND seq > ? AND json_extract(payload, '$.phase_id') = ?
           LIMIT 1`,
        ).get(marker.jobId, marker.kind, marker.baselineSeq, marker.phaseId) !== undefined;
      if (!landed) {
        throw new Error(`job "${jobId}" cannot settle a re-brief: the guarded event ${marker.kind} has not landed past the request watermark — markers must clear only when their events exist`);
      }
    }
  }

  private matchesPendingRebriefGeneration(jobId: string, expected: readonly PendingRebriefRecord[]): boolean {
    if (expected.length === 0 || expected.some((marker) => marker.jobId !== jobId)) return false;
    const current = this.listPendingRebriefs({ jobId });
    return current.length === expected.length && expected.every((marker) => current.some((row) =>
      row.id === marker.id && row.kind === marker.kind && row.payloadHash === marker.payloadHash &&
      row.baselineSeq === marker.baselineSeq && row.phaseId === marker.phaseId));
  }

  /** Retire pending re-brief markers whose request can never be honored:
   * the job is terminal, so no turn will ever record the guarded events
   * and no re-dispatch is legal. Unlike `clearPendingRebriefs` (success:
   * the guarded events landed), retirement is an administrative
   * cancellation, so the audit event and the deletion commit in ONE
   * transaction. A candidate retires ONLY while its row still matches the
   * examined identity (id + kind + payload hash + baseline watermark): an
   * older pass can never erase a newer request generation, and a replay
   * (or a concurrent pass) finds nothing to delete and records nothing.
   * The audit's `guarded_event_landed` flags are the ledger's own event
   * truth at transaction time — never a caller snapshot. */
  retirePendingRebriefs(input: {
    jobId: string;
    reason: string;
    candidates: readonly PendingRebriefRetireCandidate[];
  }): PendingRebriefRetirement {
    return this.transaction(() => {
      const refused = (why: NonNullable<PendingRebriefRetirement['refused']>): PendingRebriefRetirement => ({
        retired: [],
        // Refusal is a boundary outcome, not identity drift: no row was read
        // or compared, so nothing is "skipped" — the `refused` discriminator
        // carries the state and the markers stay untouched.
        skippedIds: [],
        refused: why,
      });
      // Boundary recheck: the caller saw terminal, but the deletion is
      // irreversible, so the record re-verifies inside the transaction.
      const job = this.getJob(input.jobId);
      if (job === null) return refused('job-missing');
      if (!isJobTerminal(job.status)) return refused('job-not-terminal');

      const rows = this.listPendingRebriefs({ jobId: input.jobId });
      const retired: PendingRebriefRecord[] = [];
      const skippedIds: string[] = [];
      // Duplicate candidate ids are deduplicated before any row work: one
      // marker id retires once and the audit names it once, so a caller-side
      // duplicate can never overstate the deletion or double-list the audit.
      const seen = new Set<string>();
      // The landed flag is ledger truth, recomputed here: a caller snapshot
      // could otherwise write a permanently untruthful audit row (e.g.
      // "never landed" for a delivery that did land).
      const guardedEventLanded = new Map<string, boolean>();
      for (const candidate of input.candidates) {
        if (seen.has(candidate.id)) continue;
        seen.add(candidate.id);
        const row = rows.find((current) => current.id === candidate.id);
        if (
          row === undefined ||
          row.kind !== candidate.kind ||
          row.payloadHash !== candidate.payloadHash ||
          row.baselineSeq !== candidate.baselineSeq
        ) {
          skippedIds.push(candidate.id);
          continue;
        }
        const landed = row.phaseId === null
          ? (this.latestJobEvent(row.jobId, row.kind)?.seq ?? 0) > row.baselineSeq
          : this.db.prepare(
            `SELECT 1 FROM events
             WHERE job_id = ? AND kind = ? AND seq > ? AND json_extract(payload, '$.phase_id') = ?
             LIMIT 1`,
          ).get(row.jobId, row.kind, row.baselineSeq, row.phaseId) !== undefined;
        guardedEventLanded.set(row.id, landed);
        retired.push(row);
      }
      if (retired.length === 0) {
        return { retired: [], skippedIds, refused: null };
      }
      // A fully honored pair is a completion, not an administrative
      // cancellation. Check ledger event truth inside this transaction,
      // before either the deletion or its retirement audit can commit.
      if (retired.length === 2 && skippedIds.length === 0 &&
          PENDING_REBRIEF_KINDS.every((kind) => retired.some((row) => row.kind === kind)) &&
          retired.every((row) => guardedEventLanded.get(row.id) === true)) {
        return refused('events-already-landed');
      }
      const remove = this.db.prepare('DELETE FROM pending_rebriefs WHERE id = ?');
      for (const row of retired) remove.run(row.id);
      this.appendEvent({
        kind: 'silas.rebrief-retired',
        jobId: input.jobId,
        payload: {
          job_status: job.status,
          reason: input.reason,
          retired: retired.map((row) => ({
            id: row.id,
            kind: row.kind,
            payload_hash: row.payloadHash,
            baseline_seq: row.baselineSeq,
            note: row.note,
            agent_id: row.agentId,
            session_file: row.sessionFile,
            requested_at: row.requestedAt,
            guarded_event_landed: guardedEventLanded.get(row.id) ?? false,
          })),
          skipped_ids: skippedIds,
        },
      });
      return { retired, skippedIds, refused: null };
    });
  }

  // ------------------------------------------------------------------
  // Provider-recovery waits (see the type block above)
  // ------------------------------------------------------------------

  /** Persist one EXPLICIT provider wait. The caller (the sensor's
   * recorder) has already established eligibility from structured
   * evidence; the ledger just records. Idempotent per incident: the same
   * incident id updates its row instead of stacking a duplicate. */
  recordProviderWait(input: {
    id: string;
    routeKey: string;
    provider: string;
    model: string;
    endpoint: string;
    credentialFingerprint: string;
    waiterKind: ProviderWaiterKind;
    jobId: string | null;
    agentId: string | null;
    slotId: string | null;
    sessionFile: string | null;
    continuation: ProviderWaitContinuation | null;
    jobStatusAtEstablishment: string | null;
    lineageKey: string | null;
    incidentId: string;
    incidentGeneration: number;
    reasonClass: string;
  }): ProviderWaitRecord {
    if (input.id === '' || input.routeKey === '' || input.incidentId === '') {
      throw new Error('provider wait id, route key, and incident id must be non-empty');
    }
    return this.transaction(() => {
      const ts = nowIso();
      const existing = this.db.prepare('SELECT id FROM provider_waits WHERE incident_id = ?').get(input.incidentId) as Row | undefined;
      if (existing !== undefined) {
        // Idempotent replay for a LIVE wait. A terminal row (claimed /
        // cancelled / superseded) is NEVER revived to 'waiting' (r4 note:
        // the old unconditional UPDATE broke the terminality invariant); it
        // is returned unchanged so a stale replay cannot resurrect it.
        const current = this.getProviderWait(str(existing.id)) as ProviderWaitRecord;
        if (current.status !== 'waiting') return current;
        this.db
          .prepare(
            `UPDATE provider_waits SET session_file = ?, continuation = ?, updated_at = ? WHERE id = ? AND status = 'waiting'`,
          )
          .run(input.sessionFile, JSON.stringify(input.continuation ?? {}), ts, str(existing.id));
        return this.getProviderWait(str(existing.id)) as ProviderWaitRecord;
      }
      this.db
        .prepare(
          `INSERT INTO provider_waits
             (id, route_key, provider, model, endpoint, credential_fingerprint, waiter_kind, job_id, agent_id, slot_id,
              session_file, continuation, job_status_at_establishment, lineage_key, incident_id, incident_generation,
              status, reason_class, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?)`,
        )
        .run(
          input.id,
          input.routeKey,
          input.provider,
          input.model,
          input.endpoint,
          input.credentialFingerprint,
          input.waiterKind,
          input.jobId,
          input.agentId,
          input.slotId,
          input.sessionFile,
          JSON.stringify(input.continuation ?? {}),
          input.jobStatusAtEstablishment,
          input.lineageKey,
          input.incidentId,
          input.incidentGeneration,
          input.reasonClass,
          ts,
          ts,
        );
      this.appendEvent({
        kind: 'provider.wait-established',
        jobId: input.jobId,
        agentId: input.agentId,
        payload: {
          id: input.id,
          route: input.routeKey,
          waiter: input.waiterKind,
          reason: input.reasonClass,
          incident_generation: input.incidentGeneration,
        },
      });
      return this.getProviderWait(input.id) as ProviderWaitRecord;
    });
  }

  getProviderWait(id: string): ProviderWaitRecord | null {
    const row = this.db.prepare('SELECT * FROM provider_waits WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : this.providerWaitFromRow(row);
  }

  /** The open (waiting/recovered-pending) provider wait for one agent, or
   * null — the supervisor's guarded owned re-arm verifies with this. */
  openProviderWaitForAgent(agentId: string): ProviderWaitRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM provider_waits WHERE agent_id = ? AND status IN ('waiting','recovered-pending')
         ORDER BY created_at DESC, id LIMIT 1`,
      )
      .get(agentId) as Row | undefined;
    return row === undefined ? null : this.providerWaitFromRow(row);
  }

  listProviderWaits(opts: { status?: ProviderWaitStatus; routeKey?: string } = {}): readonly ProviderWaitRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (opts.status !== undefined) {
      clauses.push('status = ?');
      params.push(opts.status);
    }
    if (opts.routeKey !== undefined) {
      clauses.push('route_key = ?');
      params.push(opts.routeKey);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM provider_waits${where} ORDER BY created_at, id`)
      .all(...params) as Row[];
    return rows.map((row) => this.providerWaitFromRow(row));
  }

  /** r1 #10: ATOMIC claim-before-spawn. Compare-and-set
   * recovered-pending → claimed; returns true only when THIS caller won —
   * concurrent claimants and replays lose without side effects. */
  claimProviderWaitAtomic(id: string, payload?: Record<string, unknown>): boolean {
    return this.transaction(() => {
      const result = this.db
        .prepare("UPDATE provider_waits SET status = 'claimed', updated_at = ? WHERE id = ? AND status = 'recovered-pending'")
        .run(nowIso(), id);
      if (result.changes !== 1) return false;
      const wait = this.getProviderWait(id);
      this.appendEvent({
        kind: 'provider.wait-claimed',
        jobId: wait?.jobId ?? null,
        agentId: wait?.agentId ?? null,
        payload: { id, ...(payload ?? {}) },
      });
      // r4 finding 3: the claim is a terminal transition too — resolve the
      // wait's OWN linked machine-routed incident under the same guard the
      // status path uses (never needs-owner; never another wait's stop).
      if (wait !== null && wait.incidentId !== null) {
        const incident = this.getNotification(wait.incidentId);
        if (incident !== null && incident.routing === 'action-required' && incident.resolvedAt === null) {
          this.resolveNotificationById(incident.id, 'provider-recovery-sensor');
        }
      }
      return true;
    });
  }

  /** Link a machine-owned stop incident onto an established wait (the
   * incident lifecycle resolves with the wait's own terminal transition). */
  setProviderWaitIncident(id: string, incidentId: string): void {
    this.transaction(() => {
      this.db
        .prepare('UPDATE provider_waits SET incident_id = ?, updated_at = ? WHERE id = ?')
        .run(incidentId, nowIso(), id);
    });
  }

  /** Update a wait's status (guarded state machine: a terminal row never
   * returns to waiting; only the sensor's re-queue path may move
   * recovered-pending → waiting, and only while its claim never admitted). */
  setProviderWaitStatus(
    id: string,
    status: ProviderWaitStatus,
    payload?: Record<string, unknown>,
  ): ProviderWaitRecord {
    if (!isProviderWaitStatus(status)) throw new Error(`unknown provider wait status "${status}"`);
    return this.transaction(() => {
      const current = this.getProviderWait(id);
      if (current === null) throw new RecordNotFound(`provider wait "${id}" not found`);
      if (current.status === status) return current;
      const terminal = current.status === 'cancelled' || current.status === 'superseded' || current.status === 'claimed';
      if (terminal) {
        throw new Error(
          `provider wait "${id}" is ${current.status} (terminal) — cannot become ${status}`,
        );
      }
      if (status === 'waiting' && current.status !== 'recovered-pending') {
        throw new Error(
          `provider wait "${id}" can re-enter waiting only from recovered-pending (is ${current.status})`,
        );
      }
      if (status === 'claimed' && current.status !== 'recovered-pending') {
        throw new Error(
          `provider wait "${id}" can be claimed only from recovered-pending (is ${current.status})`,
        );
      }
      this.db
        .prepare('UPDATE provider_waits SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, nowIso(), id);
      this.appendEvent({
        kind: 'provider.wait-status',
        jobId: current.jobId,
        agentId: current.agentId,
        payload: { id, from: current.status, to: status, ...(payload ?? {}) },
      });
      // Machine-owned incident lifecycle: a wait reaching a terminal state
      // resolves ONLY its own linked incident, and ONLY when that incident
      // is machine-routed (never needs-owner — owner stops stay owner-held).
      if (status === 'claimed' || status === 'cancelled' || status === 'superseded') {
        const incident = current.incidentId !== null ? this.getNotification(current.incidentId) : null;
        if (incident !== null && incident.routing === 'action-required' && incident.resolvedAt === null) {
          this.resolveNotificationById(incident.id, 'provider-recovery-sensor');
        }
      }
      return this.getProviderWait(id) as ProviderWaitRecord;
    });
  }

  /** Upsert the shared per-route probe state. The sensor owns every field
   * transition; the ledger records it atomically with its event. */
  upsertProviderRoute(
    input: ProviderRouteRecord,
    event?: { kind: string; payload?: Record<string, unknown> },
  ): ProviderRouteRecord {
    return this.transaction(() => {
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO provider_routes
             (route_key, provider, model, endpoint, credential_fingerprint, incident_seq, window_start,
              attempts_in_window, next_check_at, last_attempt_at, last_result, consecutive_probe_failures,
              false_recovery_count, suspended_until, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(route_key) DO UPDATE SET
             provider = excluded.provider,
             model = excluded.model,
             endpoint = excluded.endpoint,
             credential_fingerprint = excluded.credential_fingerprint,
             incident_seq = excluded.incident_seq,
             window_start = excluded.window_start,
             attempts_in_window = excluded.attempts_in_window,
             next_check_at = excluded.next_check_at,
             last_attempt_at = excluded.last_attempt_at,
             last_result = excluded.last_result,
             consecutive_probe_failures = excluded.consecutive_probe_failures,
             false_recovery_count = excluded.false_recovery_count,
             suspended_until = excluded.suspended_until,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.routeKey,
          input.provider,
          input.model,
          input.endpoint,
          input.credentialFingerprint,
          input.incidentSeq,
          input.windowStart,
          input.attemptsInWindow,
          input.nextCheckAt,
          input.lastAttemptAt,
          input.lastResult,
          input.consecutiveProbeFailures,
          input.falseRecoveryCount,
          input.suspendedUntil,
          ts,
        );
      if (event !== undefined) {
        this.appendEvent({ kind: event.kind, payload: event.payload ?? {} });
      }
      return this.getProviderRoute(input.routeKey) as ProviderRouteRecord;
    });
  }

  getProviderRoute(routeKey: string): ProviderRouteRecord | null {
    const row = this.db.prepare('SELECT * FROM provider_routes WHERE route_key = ?').get(routeKey) as Row | undefined;
    return row === undefined ? null : this.providerRouteFromRow(row);
  }

  listProviderRoutes(): readonly ProviderRouteRecord[] {
    const rows = this.db.prepare('SELECT * FROM provider_routes ORDER BY route_key').all() as Row[];
    return rows.map((row) => this.providerRouteFromRow(row));
  }

  /** ATOMIC recovery-batch handoff (r1 #7/#8): one transaction inserts the
   * delivery marker, appends the single `provider.restored` event (the ONE
   * durable Silas delivery path — the bus wake), flips EVERY bound waiter
   * to recovered-pending, and stamps the batch id on each. Partial states
   * are unobservable; a duplicate batch id is a no-op returning null. */
  commitProviderRecoveryBatch(input: {
    id: string;
    routeKey: string;
    incidentGenerations: readonly number[];
    evidence: Record<string, unknown>;
    waiters: readonly { readonly id: string; readonly jobId: string | null }[];
  }): PendingProviderRecoveryRecord | null {
    return this.transaction(() => {
      const existing = this.db
        .prepare('SELECT id FROM pending_provider_recovery WHERE id = ?')
        .get(input.id) as Row | undefined;
      if (existing !== undefined) return null;
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO pending_provider_recovery (id, route_key, incident_generation, evidence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(input.id, input.routeKey, Math.max(...input.incidentGenerations, 0), JSON.stringify(input.evidence), ts, ts);
      const flip = this.db.prepare(
        `UPDATE provider_waits SET status = 'recovered-pending', recovery_batch_id = ?, updated_at = ?
         WHERE id IN (${input.waiters.map(() => '?').join(', ')}) AND status = 'waiting'`,
      );
      // Marker-only batches (no bound waiters) are legal; the UPDATE is
      // skipped so the SQL never degenerates to an empty IN list.
      if (input.waiters.length > 0) {
        flip.run(input.id, ts, ...input.waiters.map((waiter) => waiter.id));
      }
      this.appendEvent({
        kind: 'provider.restored',
        ...(input.waiters.find((w) => w.jobId !== null)?.jobId !== undefined
          ? { jobId: input.waiters.find((w) => w.jobId !== null)?.jobId ?? null }
          : {}),
        payload: {
          batch_id: input.id,
          route: input.routeKey,
          incident_generations: [...input.incidentGenerations],
          waiters: input.waiters.map((waiter) => waiter.id),
          evidence: input.evidence,
        },
      });
      return this.getPendingProviderRecovery(input.routeKey, Math.max(...input.incidentGenerations, 0));
    });
  }

  getPendingProviderRecoveryById(id: string): PendingProviderRecoveryRecord | null {
    const row = this.db
      .prepare('SELECT * FROM pending_provider_recovery WHERE id = ?')
      .get(id) as Row | undefined;
    return row === undefined ? null : this.pendingProviderRecoveryFromRow(row);
  }

  getPendingProviderRecovery(routeKey: string, incidentGeneration: number): PendingProviderRecoveryRecord | null {
    const row = this.db
      .prepare('SELECT * FROM pending_provider_recovery WHERE route_key = ? AND incident_generation = ?')
      .get(routeKey, incidentGeneration) as Row | undefined;
    return row === undefined ? null : this.pendingProviderRecoveryFromRow(row);
  }

  listPendingProviderRecoveries(): readonly PendingProviderRecoveryRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM pending_provider_recovery ORDER BY created_at, route_key')
      .all() as Row[];
    return rows.map((row) => this.pendingProviderRecoveryFromRow(row));
  }

  /** Clear the delivery marker once every eligible waiter settled. */
  clearPendingProviderRecovery(id: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM pending_provider_recovery WHERE id = ?').run(id);
    });
  }

  // ------------------------------------------------------------------
  // Pre-I/O probe reservations (r1 #5): attempt/budget/cadence are charged
  // BEFORE the network I/O in one transaction; a crash between reservation
  // and outcome settles as spent-unknown, never a refund or duplicate.
  // ------------------------------------------------------------------

  /** Atomically reserve the next probe for a route: refuses while an
   * unexpired reservation exists (no overlapping checks, no
   * post-crash immediate duplicate). Returns the prior reservation when
   * it blocks, else null (= reserved). */
  reserveProviderProbe(input: {
    routeKey: string;
    reservedAt: string;
    expiresAt: string;
  }): { readonly routeKey: string; readonly reservedAt: string; readonly expiresAt: string; readonly outcome: string } | null {
    return this.transaction(() => {
      const existing = this.db
        .prepare('SELECT * FROM provider_probe_reservations WHERE route_key = ?')
        .get(input.routeKey) as Row | undefined;
      if (existing !== undefined) {
        return {
          routeKey: str(existing.route_key),
          reservedAt: str(existing.reserved_at),
          expiresAt: str(existing.expires_at),
          outcome: str(existing.outcome),
        };
      }
      this.db
        .prepare(
          `INSERT INTO provider_probe_reservations (route_key, reserved_at, expires_at, outcome)
           VALUES (?, ?, ?, 'reserved')`,
        )
        .run(input.routeKey, input.reservedAt, input.expiresAt);
      return null;
    });
  }

  getProviderProbeReservation(routeKey: string): {
    readonly routeKey: string;
    readonly reservedAt: string;
    readonly expiresAt: string;
    readonly outcome: string;
  } | null {
    const row = this.db
      .prepare('SELECT * FROM provider_probe_reservations WHERE route_key = ?')
      .get(routeKey) as Row | undefined;
    if (row === undefined) return null;
    return {
      routeKey: str(row.route_key),
      reservedAt: str(row.reserved_at),
      expiresAt: str(row.expires_at),
      outcome: str(row.outcome),
    };
  }

  /** Mark an interrupted reservation as spent-unknown (crash settle) — the
   * attempt stays charged; the cadence was already advanced. */
  markProviderProbeSpentUnknown(routeKey: string): void {
    this.transaction(() => {
      this.db
        .prepare("UPDATE provider_probe_reservations SET outcome = 'spent-unknown' WHERE route_key = ?")
        .run(routeKey);
    });
  }

  /** Release the reservation once the outcome is durably recorded. */
  releaseProviderProbeReservation(routeKey: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM provider_probe_reservations WHERE route_key = ?').run(routeKey);
    });
  }

  // ------------------------------------------------------------------
  // Notifications (EPICS E7 story 2) — the durable notification log.
  // Every mutation is atomic with its event row and bus-published so all
  // surfaces (board push, chat notices, toasts) converge on one record.
  // ------------------------------------------------------------------

  recordNotification(input: {
    id: string;
    kind: string;
    routing: NotificationRouting;
    severity: NotificationSeverity;
    title: string;
    detail?: string | null;
    agentId?: string | null;
  }): NotificationRecord {
    if (input.id === '' || input.title === '') {
      throw new Error('notification id and title must be non-empty');
    }
    return this.transaction(() => {
      if (this.getNotification(input.id) !== null) {
        throw new Error(`notification "${input.id}" already exists`);
      }
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO notifications (id, ts, kind, routing, severity, title, detail, agent_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          ts,
          input.kind,
          input.routing,
          input.severity,
          input.title,
          input.detail ?? null,
          input.agentId ?? null,
        );
      this.appendEvent({
        kind: 'notification.created',
        agentId: input.agentId ?? null,
        payload: { id: input.id, routing: input.routing, severity: input.severity, title: input.title },
      });
      return this.getNotification(input.id) as NotificationRecord;
    });
  }

  getNotification(id: string): NotificationRecord | null {
    const row = this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : this.notificationFromRow(row);
  }

  listNotifications(opts: { limit?: number; offset?: number; unackedOnly?: boolean; routing?: NotificationRouting } = {}): readonly NotificationRecord[] {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('notification page limit must be positive and offset must be non-negative');
    }
    const clauses = [
      ...(opts.unackedOnly ? ['acked_at IS NULL', 'resolved_at IS NULL'] : []),
      ...(opts.routing !== undefined ? ['routing = ?'] : []),
    ];
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return (this.db.prepare(`SELECT * FROM notifications${where} ORDER BY ts DESC, id LIMIT ? OFFSET ?`)
      .all(...(opts.routing !== undefined ? [opts.routing] : []), limit, offset) as Row[])
      .map((row) => this.notificationFromRow(row));
  }

  /** Count action-required notifications still awaiting a machine
   * disposition, INCLUDING terminal-bound closed receipts. Read straight
   * from the TABLE — not the bounded feed window. Receipts belong to the
   * record and the bell; the live NEEDS GRU queue is
   * `countLivePendingActionRequired` — prefer that one for anything the
   * board renders as live work. This accessor is DIAGNOSTIC/TEST-ONLY
   * (the durable receipt record); production paths should use the live
   * count or `listNotifications` directly. */
  countPendingActionRequiredIncludingReceipts(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM notifications WHERE routing = 'action-required' AND acked_at IS NULL AND resolved_at IS NULL",
      )
      .get() as Row;
    return Number(row.n);
  }

  /** The LIVE form of the count above: unacked action-required rows whose
   * agent binding does NOT belong to a terminal (merged/done) job. A row
   * bound to a terminal job is a closed receipt — the record keeps it
   * (nothing is acked or resolved here), but it is not live Gru work, so
   * the queue count does not count it. Rows with no agent binding stay
   * global (no job → cannot be terminal). Same table-read discipline as
   * `countPendingActionRequiredIncludingReceipts` — never the feed window.
   * The terminal statuses derive from `TERMINAL_JOB_STATUSES` so this SQL
   * can never drift from `isJobTerminal`. */
  countLivePendingActionRequired(): number {
    const terminalPlaceholders = TERMINAL_JOB_STATUSES.map(() => '?').join(', ');
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM notifications
         WHERE routing = 'action-required' AND acked_at IS NULL AND resolved_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM agents JOIN jobs ON agents.job_id = jobs.id
             WHERE agents.id = notifications.agent_id AND jobs.status IN (${terminalPlaceholders})
           )`,
      )
      .get(...TERMINAL_JOB_STATUSES) as Row;
    return Number(row.n);
  }

  /** Count needs-owner notifications still awaiting a human ack — the FOR
   * YOU queue (the only class that rings the bell). */
  countPendingNeedsOwner(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM notifications WHERE routing = 'needs-owner' AND acked_at IS NULL AND resolved_at IS NULL",
      )
      .get() as Row;
    return Number(row.n);
  }

  /** Enrich an already-durable provisional notification after async triage. */
  updateNotificationTriage(id: string, routing: NotificationRouting, detail: string | null): NotificationRecord | null {
    return this.transaction(() => {
      const current = this.getNotification(id);
      if (current === null || current.ackedAt !== null || current.resolvedAt !== null) return null;
      const changed = this.db
        .prepare('UPDATE notifications SET routing = ?, detail = ? WHERE id = ? AND acked_at IS NULL AND resolved_at IS NULL')
        .run(routing, detail, id);
      if (changed.changes === 0) return null;
      this.appendEvent({
        kind: 'notification.triaged',
        agentId: current.agentId,
        payload: { id, routing },
      });
      return this.getNotification(id);
    });
  }

  findNotificationByKind(kind: string, mode: 'any' | 'unacked' | 'active' | boolean = 'any'): NotificationRecord | null {
    const normalized = mode === true ? 'unacked' : mode === false ? 'any' : mode;
    const sql = normalized === 'unacked'
      ? 'SELECT * FROM notifications WHERE kind = ? AND acked_at IS NULL AND resolved_at IS NULL ORDER BY ts DESC, id LIMIT 1'
      : normalized === 'active'
        ? 'SELECT * FROM notifications WHERE kind = ? AND resolved_at IS NULL ORDER BY ts DESC, id LIMIT 1'
        : 'SELECT * FROM notifications WHERE kind = ? ORDER BY ts DESC, id LIMIT 1';
    const row = this.db.prepare(sql).get(kind) as Row | undefined;
    return row === undefined ? null : this.notificationFromRow(row);
  }

  /**
   * Routing-scoped open-incident lookup (Perkins R1/R2, gh-97): the plain
   * kind lookup ties-break by id (ts DESC, id ASC), so a legacy
   * machine-routed row can keep winning the dedupe over a same-millisecond
   * owner row. Callers that must honor a specific routing ask THIS query,
   * with the SAME mode semantics as findNotificationByKind: 'unacked' →
   * newest UNACKED+UNRESOLVED row of the exact kind AND routing (an acked
   * owner row is spent — a new trip may mint a new one); 'active' → newest
   * UNRESOLVED row even if ACKed (an ack records that a human saw the
   * incident; the row stays the one active incident until resolved, per
   * the decisions.degraded producer contract); 'any' → newest row of any
   * state. Never the other routing class.
   */
  findNotificationByKindAndRouting(
    kind: string,
    routing: NotificationRouting,
    mode: 'any' | 'unacked' | 'active' = 'unacked',
  ): NotificationRecord | null {
    const sql = mode === 'unacked'
      ? 'SELECT * FROM notifications WHERE kind = ? AND routing = ? AND acked_at IS NULL AND resolved_at IS NULL ORDER BY ts DESC, id LIMIT 1'
      : mode === 'active'
        ? 'SELECT * FROM notifications WHERE kind = ? AND routing = ? AND resolved_at IS NULL ORDER BY ts DESC, id LIMIT 1'
        : 'SELECT * FROM notifications WHERE kind = ? AND routing = ? ORDER BY ts DESC, id LIMIT 1';
    const row = this.db.prepare(sql).get(kind, routing) as Row | undefined;
    return row === undefined ? null : this.notificationFromRow(row);
  }

  /**
   * Resolve product incidents without forging a human acknowledgement.
   * Every changed row emits an event so connected status/notification
   * surfaces refresh immediately.
   */
  resolveNotificationsByKindPrefix(prefix: string, by: string): readonly NotificationRecord[] {
    if (prefix === '' || by === '') throw new Error('resolution prefix/by must be non-empty');
    return this.transaction(() => {
      const escaped = prefix.replace(/[\\%_]/g, '\\$&');
      const rows = this.db
        .prepare("SELECT * FROM notifications WHERE kind LIKE ? ESCAPE '\\' AND resolved_at IS NULL ORDER BY ts, id")
        .all(`${escaped}%`) as Row[];
      const resolved: NotificationRecord[] = [];
      for (const raw of rows) {
        const id = str(raw.id);
        const at = nowIso();
        this.db
          .prepare('UPDATE notifications SET resolved_at = ?, resolved_by = ? WHERE id = ? AND resolved_at IS NULL')
          .run(at, by, id);
        this.appendEvent({
          kind: 'notification.resolved',
          agentId: nstr(raw.agent_id),
          payload: { id, by },
        });
        resolved.push(this.getNotification(id) as NotificationRecord);
      }
      return resolved;
    });
  }

  /** Resolve one exact incident ID without acknowledging it for the owner. */
  resolveNotificationById(id: string, by: string): NotificationRecord | null {
    if (by.trim() === '') throw new Error('resolution by must be non-empty');
    return this.transaction(() => {
      const current = this.getNotification(id);
      if (current === null || current.resolvedAt !== null) return current;
      this.db.prepare('UPDATE notifications SET resolved_at = ?, resolved_by = ? WHERE id = ?')
        .run(nowIso(), by, id);
      this.appendEvent({ kind: 'notification.resolved', agentId: current.agentId, payload: { id, by } });
      return this.getNotification(id);
    });
  }

  /**
   * Record a display receipt (the shown:true doctrine): idempotent per
   * surface — a repeated receipt for the same surface is a no-op that
   * appends nothing (receipts must never spam the event log). Returns the
   * row, or null when the id is unknown.
   */
  markNotificationShown(id: string, surface: string): NotificationRecord | null {
    if (surface === '') throw new Error('surface must be non-empty');
    return this.transaction(() => {
      const current = this.getNotification(id);
      if (current === null) return null;
      const surfaces = new Set(
        current.shownBy === null ? [] : current.shownBy.split(','),
      );
      if (current.shownAt !== null && surfaces.has(surface)) return current;
      const shownAt = current.shownAt ?? nowIso();
      const shownBy = [...surfaces, surface].sort().join(',');
      this.db
        .prepare('UPDATE notifications SET shown_at = ?, shown_by = ? WHERE id = ?')
        .run(shownAt, shownBy, id);
      this.appendEvent({
        kind: 'notification.shown',
        agentId: current.agentId,
        payload: { id, surface },
      });
      return this.getNotification(id) as NotificationRecord;
    });
  }

  /** Explicit machine disposition, distinct from the owner's Ack.
   * A successful wake prompt by itself never calls this method. */
  disposeMachineNotification(id: string, detail: string): NotificationRecord | null {
    if (detail.trim() === '') throw new Error('machine disposition detail must be non-empty');
    return this.transaction(() => {
      const current = this.getNotification(id);
      if (current === null) return null;
      if (current.routing !== 'action-required') {
        throw new Error('only action-required notifications accept a Gru disposition; owner stops require owner acknowledgement');
      }
      if (current.resolvedAt !== null || current.ackedAt !== null) return current;
      this.db.prepare('UPDATE notifications SET resolved_at = ?, resolved_by = ? WHERE id = ?')
        .run(nowIso(), 'gru', id);
      this.appendEvent({ kind: 'notification.resolved', agentId: current.agentId, payload: { id, by: 'gru', detail } });
      return this.getNotification(id) as NotificationRecord;
    });
  }

  /** Human ack for owner/FYI only. Machine alerts require a disposition. */
  ackNotification(id: string, by: string): NotificationRecord | null {
    if (by === '') throw new Error('acked-by must be non-empty');
    return this.transaction(() => {
      const current = this.getNotification(id);
      if (current === null) return null;
      if (current.routing === 'action-required') {
        throw new Error('action-required notifications require a Gru disposition; Ack cannot clear machine attention');
      }
      if (current.ackedAt !== null) return current;
      this.db
        .prepare('UPDATE notifications SET acked_at = ?, acked_by = ? WHERE id = ?')
        .run(nowIso(), by, id);
      this.appendEvent({
        kind: 'notification.acked',
        agentId: current.agentId,
        payload: { id, by, routing: current.routing },
      });
      return this.getNotification(id) as NotificationRecord;
    });
  }

  // ------------------------------------------------------------------
  // Row mapping
  // ------------------------------------------------------------------

  private jobFromRow(row: Row): JobRecord {
    return {
      id: str(row.id),
      repo: str(row.repo),
      title: str(row.title),
      displayName: nstr(row.display_name),
      deliverable: nstr(row.deliverable) as JobDeliverable | null,
      commissioner: nstr(row.commissioner),
      targetRef: nstr(row.target_ref),
      targetSha: nstr(row.target_sha),
      status: str(row.status) as JobStatus,
      baseBranch: nstr(row.base_branch),
      prUrl: nstr(row.pr_url),
      note: nstr(row.note),
      briefing: nstr(row.briefing),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }

  private worktreeFromRow(row: Row): WorktreeRecord {
    return {
      id: str(row.id),
      kind: str(row.kind) as WorktreeKind,
      repoPath: str(row.repo_path),
      repoName: str(row.repo_name),
      path: str(row.path),
      branch: nstr(row.branch),
      sha: str(row.sha),
      baseSource: this.worktreeBaseSourceFromRow(row),
      jobId: nstr(row.job_id),
      roundId: nstr(row.round_id),
      status: str(row.status) as WorktreeStatus,
      note: nstr(row.note),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }

  private childWorkerFromRow(row: Row): ChildWorkerRecord {
    const authority = str(row.authority);
    if (!isChildWorkerAuthority(authority)) {
      throw new Error(`child_workers row ${str(row.id)} has unknown authority "${authority}"`);
    }
    const state = str(row.state);
    if (!isChildWorkerState(state)) {
      throw new Error(`child_workers row ${str(row.id)} has unknown state "${state}"`);
    }
    const resultState = nstr(row.result_state);
    if (resultState !== null && !(CHILD_RESULT_STATES as readonly string[]).includes(resultState)) {
      throw new Error(`child_workers row ${str(row.id)} has unknown result state "${resultState}"`);
    }
    return {
      id: str(row.id),
      agentId: nstr(row.agent_id),
      parentAgentId: str(row.parent_agent_id),
      jobId: str(row.job_id),
      purpose: str(row.purpose),
      authority,
      task: str(row.task),
      label: nstr(row.label),
      idempotencyKey: str(row.idempotency_key),
      payloadHash: str(row.payload_hash),
      state,
      worktreeId: nstr(row.worktree_id),
      branch: nstr(row.branch),
      sessionFile: nstr(row.session_file),
      resultState: resultState as ChildResultState | null,
      resultSummary: nstr(row.result_summary),
      resultRef: nstr(row.result_ref),
      createdAt: str(row.created_at),
      admittedAt: nstr(row.admitted_at),
      startedAt: nstr(row.started_at),
      finishedAt: nstr(row.finished_at),
      updatedAt: str(row.updated_at),
    };
  }

  /** A stored base source must be one of the known labels — an unknown
   * value means a migration/code mismatch and is never coerced. */
  private worktreeBaseSourceFromRow(row: Row): WorktreeBaseSource | null {
    const value = nstr(row.base_source);
    if (value === null) return null;
    if (!isWorktreeBaseSource(value)) {
      throw new Error(`worktrees row ${str(row.id)} has unknown base_source "${value}"`);
    }
    return value;
  }

  private agentFromRow(row: Row): AgentRecord {
    const parentage = nstr(row.parentage);
    if (parentage !== null && parentage !== 'top-level' && parentage !== 'child') {
      throw new Error(`agents row ${str(row.id)} has unknown parentage "${parentage}"`);
    }
    return {
      id: str(row.id),
      role: str(row.role) as Role,
      label: nstr(row.label),
      jobId: nstr(row.job_id),
      roundId: nstr(row.round_id),
      state: str(row.state) as AgentState,
      lastActivity: nstr(row.last_activity),
      sessionFile: nstr(row.session_file),
      parentAgentId: nstr(row.parent_agent_id),
      parentage,
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }

  // ------------------------------------------------------------------
  // Durable follow-through obligations (phase 2 foundation).
  // Pure state + fences: nothing here executes work, schedules anything,
  // or wakes anyone. API writers must go through setJobStatus (or
  // recordBlockedObservation, the observer backstop) — never raw SQL.
  // ------------------------------------------------------------------

  /** The observer backstop for blocked observations that did not ride a
   * setJobStatus call (e.g. an async event-bus reconcile noticing a gap).
   * Same transactional path, same semantics; correctness does not depend
   * on it (the boundary is authoritative). */
  recordBlockedObservation(jobId: string, context: BlockerContext): ObligationRecord {
    return this.transaction(() => {
      if (this.getJob(jobId) === null) throw new RecordNotFound(`job "${jobId}" not found`);
      return this.applyBlockedObservation(jobId, context);
    });
  }

  /** Window-A backstop candidates (PR136 r4 blocker 2): follow-up
   * `job.delivered` events whose delivery happened during a BLOCKED
   * episode of the lane and whose hand-back obligation was never recorded
   * (crash between the delivery commit and the observer). The lane's
   * CURRENT blocked status is not enough — joining a historical healthy
   * delivery to an unrelated later block would revive completed work
   * (PR136 r5 blocker 3) — so the query reconstructs the status AT
   * DELIVERY from the job's own status events: the latest `job.status`
   * transition before the delivery must have entered `blocked`. A lane
   * with no provable blocked episode is excluded. Already-tracked
   * deliveries (and deliveries owned by an existing marked phase row) are
   * excluded BY the query, so bounded passes always reach the tail. */
  listUnmarkedHandbackDeliveries(limit: number, opts: { cursor?: number } = {}): readonly EventRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(`listUnmarkedHandbackDeliveries requires a positive integer limit, got ${String(limit)}`);
    }
    if (opts.cursor !== undefined && (!Number.isSafeInteger(opts.cursor) || opts.cursor < 0)) {
      throw new Error('listUnmarkedHandbackDeliveries cursor must be a safe non-negative event seq');
    }
    const rows = this.db
      .prepare(
        `SELECT e.* FROM events e
           JOIN jobs j ON j.id = e.job_id
          WHERE e.kind = 'job.delivered'
            AND j.status = 'blocked'
            AND json_valid(e.payload)
            AND e.seq > ?
            AND json_extract(e.payload, '$.source') IN ('silas-directive', 'silas-rebrief')
            AND COALESCE((
              SELECT json_extract(s.payload, '$.to')
                FROM events s
               WHERE s.job_id = e.job_id
                 AND s.kind = 'job.status'
                 AND s.seq < e.seq
               ORDER BY s.seq DESC
               LIMIT 1
            ), '') = 'blocked'
            AND (
              json_extract(e.payload, '$.phase_id') IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM phase_handoffs p WHERE p.phase_id = json_extract(e.payload, '$.phase_id')
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM job_obligations o
               WHERE o.job_id = e.job_id
                 AND o.logical_step = 'operation'
                 AND o.incident_key = 'phase-handback@' || e.seq
            )
          ORDER BY e.seq ASC
          LIMIT ?`,
      )
      .all(opts.cursor ?? 0, limit) as Row[];
    return rows.map((row) => this.eventFromRow(row));
  }

  /** Window-B backstop candidates (PR136 r4 blocker 2): unmarked
   * phase-handback obligations that are still live but whose stable-kind
   * action-required card was never published (crash between the obligation
   * write and the notification). A published card — even a resolved/acked
   * one — removes the row from the candidate set. */
  listHandbacksMissingCards(limit: number, opts: { cursor?: number } = {}): readonly ObligationRecord[] {
    return this.listHandbacksMissingCardsDetailed(limit, opts).readable;
  }

  /** Window-B candidates with per-row decode isolation: one malformed
   * obligation row is reported (never re-thrown into a bounded pass) while
   * the readable rows stay available and the cursor can advance past the
   * malformed prefix. */
  listHandbacksMissingCardsDetailed(
    limit: number,
    opts: { cursor?: number } = {},
  ): {
    readonly readable: readonly ObligationRecord[];
    readonly malformed: number;
    readonly lastRowid: number | null;
    readonly exhausted: boolean;
  } {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(`listHandbacksMissingCards requires a positive integer limit, got ${String(limit)}`);
    }
    if (opts.cursor !== undefined && (!Number.isSafeInteger(opts.cursor) || opts.cursor < 0)) {
      throw new Error('listHandbacksMissingCards cursor must be a safe non-negative rowid');
    }
    const rows = this.db
      .prepare(
        `SELECT o.rowid AS _rowid, o.* FROM job_obligations o
          WHERE o.logical_step = 'operation'
            AND o.incident_key LIKE 'phase-handback@%'
            AND o.state IN ('open', 'waiting')
            AND o.rowid > ?
            AND NOT EXISTS (
              SELECT 1 FROM notifications n
               WHERE n.kind = 'silas.phase-handback.' || o.job_id || '@' || substr(o.incident_key, 16)
            )
          ORDER BY o.rowid ASC
          LIMIT ?`,
      )
      .all(opts.cursor ?? 0, limit) as Row[];
    const readable: ObligationRecord[] = [];
    let malformed = 0;
    for (const row of rows) {
      try {
        readable.push(this.obligationFromRow(row));
      } catch {
        malformed += 1;
      }
    }
    const last = rows[rows.length - 1];
    return {
      readable,
      malformed,
      lastRowid: last === undefined ? null : Number(last._rowid),
      exhausted: rows.length < limit,
    };
  }

  getObligation(id: string): ObligationRecord | null {
    const row = this.db.prepare('SELECT * FROM job_obligations WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : this.obligationFromRow(row);
  }

  listObligations(
    opts: {
      jobId?: string;
      state?: ObligationState;
      /** Multi-state filter for lifecycle sweeps (exactly one of
       * `state`/`states` may be given). */
      states?: readonly ObligationState[];
      limit?: number;
      cursor?: number;
      /** Inclusive rowid ceiling: a stable watermark for paged sweeps. */
      maxRowid?: number;
    } = {},
  ): readonly ObligationRecord[] {
    // Bounded by default and hard-capped (ruling E): a reconcile/adoption
    // pass never scans unbounded, and a cursor pages past the cap.
    const limit = Math.min(Math.max(1, opts.limit ?? 200), 1000);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.jobId !== undefined) {
      where.push('job_id = ?');
      params.push(opts.jobId);
    }
    if (opts.states !== undefined) {
      if (opts.states.length === 0) throw new Error('listObligations "states" filter must not be empty');
      for (const state of opts.states) {
        if (!isObligationState(state)) throw new Error(`listObligations got unknown obligation state "${state}"`);
      }
      where.push(`state IN (${opts.states.map(() => '?').join(', ')})`);
      params.push(...opts.states);
    } else if (opts.state !== undefined) {
      where.push('state = ?');
      params.push(opts.state);
    }
    if (opts.cursor !== undefined) {
      where.push('rowid > ?');
      params.push(opts.cursor);
    }
    if (opts.maxRowid !== undefined) {
      where.push('rowid <= ?');
      params.push(opts.maxRowid);
    }
    const sql = `SELECT rowid AS _rowid, * FROM job_obligations${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid LIMIT ?`;
    return (this.db.prepare(sql).all(...(params as never[]), limit) as Row[]).map((row) =>
      this.obligationFromRow(row),
    );
  }

  /** One obligation's rowid cursor (pagination anchor). */
  obligationRowid(id: string): number | null {
    const row = this.db.prepare('SELECT rowid AS _rowid FROM job_obligations WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : Number(row._rowid);
  }

  /** Queue-facing listing (ruling E): one malformed row must stay VISIBLE
   * as a triage problem without poisoning the whole pass. `readable`
   * carries parsed rows; `malformed` carries the raw id plus the parse
   * error — never silently dropped, never fatal to the rest. */
  listObligationsDetailed(
    opts: { jobId?: string; state?: ObligationState; limit?: number; cursor?: number } = {},
  ): { readable: readonly ObligationRecord[]; malformed: readonly { id: string; error: string }[] } {
    const limit = Math.min(Math.max(1, opts.limit ?? 200), 1000);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.jobId !== undefined) {
      where.push('job_id = ?');
      params.push(opts.jobId);
    }
    if (opts.state !== undefined) {
      where.push('state = ?');
      params.push(opts.state);
    }
    if (opts.cursor !== undefined) {
      where.push('rowid > ?');
      params.push(opts.cursor);
    }
    const sql = `SELECT rowid AS _rowid, * FROM job_obligations${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid LIMIT ?`;
    const rows = this.db.prepare(sql).all(...(params as never[]), limit) as Row[];
    const readable: ObligationRecord[] = [];
    const malformed: { id: string; error: string }[] = [];
    for (const row of rows) {
      try {
        readable.push(this.obligationFromRow(row));
      } catch (error) {
        const rawId = typeof row['id'] === 'string' ? row['id'] : `rowid:${String(row['_rowid'])}`;
        malformed.push({ id: rawId, error: String(error) });
      }
    }
    return { readable, malformed };
  }

  /** Is this obligation's authority CURRENTLY VALID against durable
   * facts (ruling E)? An unverifiable reference is a visible
   * NON-EXECUTABLE decision, never a grant. Attribution limits
   * (issue #99, unchanged): a shared bearer token means caller-supplied
   * `by`/source text never proves owner/Gru identity — validity is
   * checked against ledger facts only.
   *
   * - No authority ⇒ non-executable (attention-only).
   * - `accepted-operation` ⇒ the named directive request must exist,
   *   belong to this job, and be actually admitted or settled — accepted,
   *   not merely typed. The authority's `version` field is caller-supplied
   *   provenance TEXT and is not independently validated here; only the
   *   durable directive request grounds executability.
   * - `chief-ruling`/`owner-ruling` ⇒ a `ruling.recorded` event with the
   *   exact ref and version must exist on this job; prose or a path is
   *   never proof. */
  verifyObligationAuthority(obligationId: string): { executable: boolean; reason: string } {
    const row = this.getObligation(obligationId);
    if (row === null) throw new RecordNotFound(`obligation "${obligationId}" not found`);
    const authority = row.authority;
    if (authority === null) {
      return { executable: false, reason: 'no typed authority — attention-only' };
    }
    if (authority.source === 'accepted-operation') {
      const directive = this.getDirective(authority.operationId);
      if (directive === null) {
        return { executable: false, reason: `accepted operation "${authority.operationId}" has no durable directive request` };
      }
      if (directive.jobId !== row.jobId) {
        return { executable: false, reason: `accepted operation "${authority.operationId}" belongs to job ${directive.jobId}, not ${row.jobId}` };
      }
      if (directive.state !== 'admitted' && directive.state !== 'settled') {
        return { executable: false, reason: `accepted operation "${authority.operationId}" is ${directive.state} — accepted admission required` };
      }
      return {
        executable: true,
        reason:
          `operation ${authority.operationId} is durably admitted; the authority's version field ` +
          `"${authority.version}" is caller-supplied provenance, not independently validated`,
      };
    }
    // A ruling is valid while SOME durably recorded ruling event carries
    // its exact ref+version — later unrelated rulings must not shadow an
    // earlier matching one (latest-only would report a false negative).
    const event = this.listJobEvents(row.jobId, { limit: 1000 }).find((candidate) => {
      if (candidate.kind !== 'ruling.recorded') return false;
      const payload = (typeof candidate.payload === 'object' && candidate.payload !== null ? candidate.payload : {}) as Record<string, unknown>;
      return payload['ref'] === authority.rulingRef && payload['version'] === authority.version;
    });
    if (event === undefined) {
      return {
        executable: false,
        reason: `no durably recorded ruling event answers "${authority.rulingRef}" v"${authority.version}" — attention decision required`,
      };
    }
    return { executable: true, reason: `ruling ${authority.rulingRef} v${authority.version} is durably recorded` };
  }

  /** Take a request/generation-fenced claim on an obligation's next
   * action. Records the fence; NEVER authorizes executing work by itself
   * (a silas-mechanical obligation must already carry typed authority —
   * a claim cannot mint it). Lease expiry alone never licenses a
   * replacement holder: superseding an EXPIRED claim requires positive
   * reconciliation proof, recorded with the full prior identity in the
   * claim log (ruling D). */
  claimObligation(input: {
    obligationId: string;
    requestId: string;
    holder: string;
    expiresAt: string;
    expectedGeneration: number;
    /** Positive disposition proof for superseding an EXPIRED claim —
     * e.g. the ledger/actor facts checked. Ignored when no claim exists. */
    supersedeProof?: string;
  }): ObligationRecord {
    if (input.requestId.trim() === '') throw new Error('claim requires a non-empty requestId');
    if (input.holder.trim() === '') throw new Error('claim requires a non-empty holder');
    const expiresAt = canonicalIsoTimestamp(input.expiresAt, 'claim expiresAt');
    return this.transaction(() => {
      const row = this.getObligation(input.obligationId);
      if (row === null) throw new RecordNotFound(`obligation "${input.obligationId}" not found`);
      if (row.state !== 'open' && row.state !== 'waiting') {
        throw new Error(`obligation "${row.id}" is ${row.state} — only open/waiting obligations can be claimed`);
      }
      if (row.generation !== input.expectedGeneration) {
        throw new StaleContinuationError(
          `generation fence on "${row.id}": continuation expected generation ${input.expectedGeneration}, ` +
            `the obligation is at ${row.generation} — re-derive from current durable state before acting`,
        );
      }
      if (row.nextAction.kind === 'silas-mechanical' && row.authority === null) {
        throw new Error(
          `obligation "${row.id}" names mechanical action "${row.nextAction.action}" without typed authority — ` +
            'a claim is a coordination fence, never a grant; the obligation is attention-only until authority exists',
        );
      }
      const now = nowIso();
      if (row.claim !== null && row.claim.requestId !== input.requestId) {
        const expired = row.claim.expiresAt !== null && row.claim.expiresAt <= now;
        if (!expired) {
          throw new ClaimHeldError(
            `obligation "${row.id}" is held by request ${row.claim.requestId} (${row.claim.holder}) until ${row.claim.expiresAt}`,
          );
        }
        if (input.supersedeProof === undefined || input.supersedeProof.trim() === '') {
          throw new ClaimHeldError(
            `obligation "${row.id}" claim by ${row.claim.requestId} expired at ${row.claim.expiresAt}, but expiry alone ` +
              'transfers nothing — the reconciliation path must positively dispose of the old claim first ' +
              '(supply supersedeProof with the checked evidence)',
          );
        }
      }
      if (row.claim !== null && row.claim.requestId === input.requestId && row.claim.holder !== input.holder) {
        throw new ClaimHeldError(
          `request ${input.requestId} holds "${row.id}" as ${row.claim.holder} — the same request id cannot change holder`,
        );
      }
      const replacing = row.claim !== null && row.claim.requestId !== input.requestId;
      const claim: ObligationClaim = { requestId: input.requestId, holder: input.holder, generation: row.generation, expiresAt };
      const log = replacing
        ? [
            ...row.claimLog,
            {
              requestId: row.claim!.requestId,
              holder: row.claim!.holder,
              generation: row.claim!.generation,
              expiresAt: row.claim!.expiresAt,
              disposition: 'superseded-expired-reconciled' as ClaimLogDisposition,
              at: now,
              proof: input.supersedeProof ?? null,
              supersededByRequest: input.requestId,
            },
          ]
        : row.claimLog;
      this.db
        .prepare('UPDATE job_obligations SET claim = ?, claim_log = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(claim), JSON.stringify(log), now, row.id);
      this.appendEvent({
        kind: 'job.obligation-claimed',
        jobId: row.jobId,
        payload: {
          id: row.id,
          requestId: input.requestId,
          holder: input.holder,
          expiresAt,
          ...(replacing ? { supersededExpired: row.claim!.requestId, proof: input.supersedeProof } : {}),
        },
      });
      return this.getObligation(row.id) as ObligationRecord;
    });
  }

  /** Release a claim; only the owning request may release it, and the
   * full identity of the released claim lands in the claim log. */
  releaseClaim(input: { obligationId: string; requestId: string }): ObligationRecord {
    return this.transaction(() => {
      const row = this.getObligation(input.obligationId);
      if (row === null) throw new RecordNotFound(`obligation "${input.obligationId}" not found`);
      if (row.claim === null) throw new Error(`obligation "${row.id}" has no claim to release`);
      if (row.claim.requestId !== input.requestId) {
        throw new ClaimHeldError(`obligation "${row.id}" is held by request ${row.claim.requestId}, not ${input.requestId}`);
      }
      const log: readonly ClaimLogEntry[] = [
        ...row.claimLog,
        {
          requestId: row.claim.requestId,
          holder: row.claim.holder,
          generation: row.claim.generation,
          expiresAt: row.claim.expiresAt,
          disposition: 'released',
          at: nowIso(),
          proof: null,
          supersededByRequest: null,
        },
      ];
      this.db
        .prepare('UPDATE job_obligations SET claim = NULL, claim_log = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(log), nowIso(), row.id);
      this.appendEvent({
        kind: 'job.obligation-claim-released',
        jobId: row.jobId,
        payload: { id: row.id, requestId: input.requestId },
      });
      return this.getObligation(row.id) as ObligationRecord;
    });
  }

  /** Record receipt evidence for an obligation. IDEMPOTENT per
   * (kind, eventSeq). The receipt must cite an ACTUAL ledger event:
   * it must exist, carry exactly that kind, and belong to the
   * obligation's job — a fabricated sequence or a wrong-job event is
   * refused, never settled on (ruling A). When the obligation armed a
   * correlation, an event that does not carry the delegated phase's
   * identity is recorded as unapplied evidence: a later unrelated event
   * of the same kind cannot satisfy an older expectation. A receipt
   * postdating the obligation's watermark may hand a waiting obligation
   * back to open (the decision returns); a receipt NEVER settles —
   * accepted gates require an explicit, validated settlement. */
  recordObligationReceipt(input: {
    obligationId: string;
    kind: string;
    eventSeq: number;
    at?: string;
  }): ObligationRecord {
    if (!Number.isSafeInteger(input.eventSeq) || input.eventSeq < 0) {
      throw new Error('receipt requires a safe non-negative eventSeq');
    }
    return this.transaction(() => {
      const row = this.getObligation(input.obligationId);
      if (row === null) throw new RecordNotFound(`obligation "${input.obligationId}" not found`);
      const duplicate = row.recordedReceipts.some(
        (receipt) => receipt.kind === input.kind && receipt.eventSeq === input.eventSeq,
      );
      if (duplicate) return row; // already recorded — replay is a no-op
      // Evidence grounding (ruling A): the cited event must really exist,
      // be of the claimed kind, and belong to this obligation's job.
      const event = this.getEvent(input.eventSeq);
      if (event === null) {
        throw new Error(
          `receipt for "${row.id}" cites event seq ${input.eventSeq} which does not exist — ` +
            'a receipt without a real correlated event is refused',
        );
      }
      if (event.kind !== input.kind) {
        throw new Error(
          `receipt for "${row.id}" claims kind "${input.kind}" but event ${input.eventSeq} is "${event.kind}"`,
        );
      }
      if (event.jobId !== row.jobId) {
        throw new Error(
          `receipt for "${row.id}" cites event ${input.eventSeq} of job ${String(event.jobId)} — a wrong-job event cannot answer this obligation's debt`,
        );
      }
      // Correlation (ruling A): when the expectation was armed with the
      // delegated phase's identity, the event must carry it. A mismatch is
      // recorded as unapplied evidence — visible, never satisfying.
      const correlation = row.receiptCorrelation;
      let correlated = true;
      if (correlation !== null) {
        const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
        if (correlation.requestId !== undefined && payload['request_id'] !== correlation.requestId) correlated = false;
        if (correlation.minionId !== undefined && payload['agentId'] !== correlation.minionId && payload['minion_id'] !== correlation.minionId) {
          correlated = false;
        }
      }
      const applied = correlated && input.eventSeq > row.lastOriginSeq;
      const receipts: RecordedReceipt[] = [
        ...row.recordedReceipts,
        { kind: input.kind, eventSeq: input.eventSeq, at: input.at ?? nowIso(), applied },
      ];
      let state: ObligationState = row.state;
      if (applied && row.state === 'waiting' && row.receiptKind === input.kind) {
        state = 'open'; // phase completion hands the decision back — not delivery/approval
      }
      this.db
        .prepare(
          `UPDATE job_obligations
             SET recorded_receipts = ?, last_origin_seq = MAX(last_origin_seq, ?), state = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(receipts), input.eventSeq, state, nowIso(), row.id);
      this.appendEvent({
        kind: 'job.obligation-receipt',
        jobId: row.jobId,
        payload: {
          id: row.id,
          receipt_kind: input.kind,
          event_seq: input.eventSeq,
          applied,
          ...(correlated ? {} : { correlation: 'mismatch — recorded as evidence only' }),
          from: row.state,
          to: state,
        },
      });
      return this.getObligation(row.id) as ObligationRecord;
    });
  }

  /** Settle or close an obligation with a validated, discriminated
   * settlement. Evidence kinds cite a REAL ledger event (it must exist,
   * belong to this obligation's job, and carry the exact cited kind —
   * no fabricated sequence or wrong-job/gate event settles debt,
   * ruling A); administrative closes (superseded/cancelled/job-terminal)
   * are durable truth from the job machine itself and clear any claim
   * rather than being vetoed by it. History is preserved (the row and
   * its events stay); settled/closed are terminal — a recurring incident
   * is a NEW obligation. */
  settleObligation(input: {
    obligationId: string;
    settlement: ObligationSettlement;
    requestId?: string;
  }): ObligationRecord {
    return this.transaction(() => {
      const row = this.getObligation(input.obligationId);
      if (row === null) throw new RecordNotFound(`obligation "${input.obligationId}" not found`);
      const target: ObligationState =
        input.settlement.kind === 'executed-action' || input.settlement.kind === 'accepted-evidence'
          ? 'settled'
          : 'closed';
      assertObligationTransition(row.state, target);
      if (
        input.settlement.kind === 'executed-action' ||
        input.settlement.kind === 'accepted-evidence'
      ) {
        // Evidence grounding (ruling A): the cited event must exist, sit
        // on this obligation's job, and carry the exact cited kind. Mere
        // typed JSON is not proof; the ledger fact is.
        const event = this.getEvent(input.settlement.evidenceEventSeq);
        if (event === null) {
          throw new Error(
            `settlement for "${row.id}" cites evidence event seq ${input.settlement.evidenceEventSeq} which does not exist — refused`,
          );
        }
        if (event.jobId !== row.jobId) {
          throw new Error(
            `settlement for "${row.id}" cites evidence event ${input.settlement.evidenceEventSeq} of job ${String(event.jobId)} — refused`,
          );
        }
        if (event.kind !== input.settlement.evidenceEventKind) {
          throw new Error(
            `settlement for "${row.id}" cites kind "${input.settlement.evidenceEventKind}" but event ${input.settlement.evidenceEventSeq} is "${event.kind}" — refused`,
          );
        }
      }
      // Evidence settlements are claim-fenced (the owning request proves
      // its continuation). Administrative closes clear the claim and log
      // its identity — the durable truth outranks the fence, and the
      // history records who lost it.
      if (
        row.claim !== null &&
        row.claim.requestId !== input.requestId &&
        (input.settlement.kind === 'executed-action' || input.settlement.kind === 'accepted-evidence')
      ) {
        throw new ClaimHeldError(
          `obligation "${row.id}" is held by request ${row.claim.requestId} — settle through the owning request or release it first`,
        );
      }
      const administrative = target === 'closed';
      const supersededBy = input.settlement.kind === 'superseded' ? input.settlement.byObligationId : null;
      const log: readonly ClaimLogEntry[] =
        row.claim === null
          ? row.claimLog
          : [
              ...row.claimLog,
              {
                requestId: row.claim.requestId,
                holder: row.claim.holder,
                generation: row.claim.generation,
                expiresAt: row.claim.expiresAt,
                disposition: administrative ? 'terminal-close' : 'released',
                at: nowIso(),
                proof: `settlement: ${input.settlement.kind}`,
                supersededByRequest: null,
              },
            ];
      this.db
        .prepare(
          'UPDATE job_obligations SET state = ?, settlement = ?, superseded_by = COALESCE(?, superseded_by), claim = NULL, claim_log = ?, updated_at = ? WHERE id = ?',
        )
        .run(target, JSON.stringify(input.settlement), supersededBy, JSON.stringify(log), nowIso(), row.id);
      this.appendEvent({
        kind: 'job.obligation-settled',
        jobId: row.jobId,
        payload: { id: row.id, from: row.state, to: target, settlement: input.settlement },
      });
      return this.getObligation(row.id) as ObligationRecord;
    });
  }

  /** Arm a receipt expectation: the obligation's next action is delegated
   * to a phase that owes a typed receipt (e.g. job.delivered) by a
   * deadline. `correlation` pins the expectation to the delegated
   * phase's actual identity (request/minion) — without a match, a
   * same-kind event is evidence but never satisfaction (ruling A).
   * Pure state — arming does NOT spawn, notify or execute anything; the
   * delegation hook calls this when it actually hands work over, so
   * "waiting" is always backed by durable intent. */
  armReceiptExpectation(input: {
    obligationId: string;
    receiptKind: string;
    deadlineAt: string;
    correlation?: ReceiptCorrelation;
    requestId?: string;
    reason?: string;
  }): ObligationRecord {
    if (input.receiptKind.trim() === '') throw new Error('arming requires a non-empty receiptKind');
    const deadlineAt = canonicalIsoTimestamp(input.deadlineAt, 'arming deadlineAt');
    return this.transaction(() => {
      const row = this.getObligation(input.obligationId);
      if (row === null) throw new RecordNotFound(`obligation "${input.obligationId}" not found`);
      assertObligationTransition(row.state, 'waiting');
      if (row.claim !== null && row.claim.requestId !== input.requestId) {
        throw new ClaimHeldError(
          `obligation "${row.id}" is held by request ${row.claim.requestId} — arm through the owning request or release it first`,
        );
      }
      this.db
        .prepare(
          `UPDATE job_obligations SET state = 'waiting', receipt_kind = ?, deadline_at = ?, receipt_correlation = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          input.receiptKind,
          deadlineAt,
          input.correlation === undefined ? null : JSON.stringify(input.correlation),
          nowIso(),
          row.id,
        );
      this.appendEvent({
        kind: 'job.obligation-state',
        jobId: row.jobId,
        payload: {
          id: row.id,
          from: row.state,
          to: 'waiting',
          receipt_kind: input.receiptKind,
          deadline_at: deadlineAt,
          ...(input.correlation !== undefined ? { correlation: input.correlation } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        },
      });
      return this.getObligation(row.id) as ObligationRecord;
    });
  }

  /** Explicit durable suspension (owner hold / parking). Never inferred
   * from a notification ack, prose, or a check name. */
  suspendObligation(id: string, reason: string): ObligationRecord {
    return this.transaction(() => {
      const row = this.getObligation(id);
      if (row === null) throw new RecordNotFound(`obligation "${id}" not found`);
      assertObligationTransition(row.state, 'suspended');
      this.db
        .prepare("UPDATE job_obligations SET state = 'suspended', updated_at = ? WHERE id = ?")
        .run(nowIso(), row.id);
      this.appendEvent({
        kind: 'job.obligation-state',
        jobId: row.jobId,
        payload: { id: row.id, from: row.state, to: 'suspended', reason },
      });
      return this.getObligation(row.id) as ObligationRecord;
    });
  }

  /** Explicit durable resume (only a human/chief decision does this). */
  resumeObligation(id: string, reason: string): ObligationRecord {
    return this.transaction(() => {
      const row = this.getObligation(id);
      if (row === null) throw new RecordNotFound(`obligation "${id}" not found`);
      assertObligationTransition(row.state, 'open');
      this.db
        .prepare("UPDATE job_obligations SET state = 'open', updated_at = ? WHERE id = ?")
        .run(nowIso(), row.id);
      this.appendEvent({
        kind: 'job.obligation-state',
        jobId: row.jobId,
        payload: { id: row.id, from: row.state, to: 'open', reason },
      });
      return this.getObligation(row.id) as ObligationRecord;
    });
  }

  /** Reclassify obligations whose continuations were fenced off by newer
   * durable truth (head moved, completion, cancellation, revised ruling,
   * owner hold). The old EXECUTION authority dies; the still-owed debt
   * does NOT: each reclassified row closes as `superseded` linked to a
   * genuine successor created ATOMICALLY in the same transaction — fresh
   * generation, attention-routed Gru re-derivation, no carried authority
   * or claim (ruling B: a new owner hold must not erase verification/
   * review obligations; only an explicit applicable cancellation or
   * terminal disposition ends the debt). Acts ONLY on applicable rows
   * (open/waiting, at or before the watermark); terminal rows and
   * history are untouched. */
  invalidateStaleContinuations(input: {
    jobId: string;
    newerThanSeq: number;
    reason: string;
  }): { readonly superseded: readonly ObligationRecord[]; readonly successors: readonly ObligationRecord[] } {
    return this.transaction(() => {
      if (this.getJob(input.jobId) === null) throw new RecordNotFound(`job "${input.jobId}" not found`);
      const applicable = this.listApplicableObligations(input.jobId, ['open', 'waiting']).filter(
        (row) => row.lastOriginSeq <= input.newerThanSeq,
      );
      const superseded: ObligationRecord[] = [];
      const successors: ObligationRecord[] = [];
      for (const row of applicable) {
        // The successor is the same incident's debt re-derived under the
        // newer truth: attention-only (no carried authority), fresh
        // generation, unclaimed. The old row closes LINKED to it — the
        // debt visibly continues, it did not vanish.
        const logicalStep = isObligationLogicalStep(row.logicalStep) ? row.logicalStep : 'operation';
        const successorId = this.nextIncarnationId(obligationId(row.jobId, logicalStep, row.incidentKey));
        this.settleObligation({
          obligationId: row.id,
          settlement: { kind: 'superseded', byObligationId: successorId, reason: input.reason },
        });
        const generation = this.currentJobGeneration(input.jobId) + 1;
        const successorPlan: ObligationNextAction = {
          kind: 'gru-decision',
          decision: `re-derive the next action after durable truth changed: ${input.reason}`,
        };
        const now = nowIso();
        this.db
          .prepare(
            `INSERT INTO job_obligations
               (id, job_id, logical_step, incident_key, generation, description, category, next_action, wake_condition,
                authority, firing_rule, state, recorded_receipts, observations, first_origin_seq, last_origin_seq,
                created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'open', '[]', 1, ?, ?, ?, ?)`,
          )
          .run(
            successorId,
            row.jobId,
            logicalStep,
            row.incidentKey,
            generation,
            row.description,
            JSON.stringify(row.category),
            JSON.stringify(successorPlan),
            JSON.stringify(defaultFiringRule(row.category).wakeCondition),
            defaultFiringRule(row.category).id,
            input.newerThanSeq,
            input.newerThanSeq,
            now,
            now,
          );
        this.appendEvent({
          kind: 'job.obligation-recorded',
          jobId: row.jobId,
          payload: {
            id: successorId,
            generation,
            category: categoryKey(row.category),
            next_action: successorPlan,
            firing_rule: defaultFiringRule(row.category).id,
            authority: null,
            reclassified_of: row.id,
            reason: input.reason,
          },
        });
        superseded.push(this.getObligation(row.id) as ObligationRecord);
        successors.push(this.getObligation(successorId) as ObligationRecord);
      }
      return { superseded, successors };
    });
  }

  /** Apply one typed blocked observation. The lookup is the tuple's
   * ACTIVE incarnation — never just the base id, which may be settled
   * history while a live `#2` incarnation exists (ruling C). Semantics:
   * - live incarnation ⇒ coalesce: stable identity and generation; a
   *   strictly newer observation applies its plan, and a CHANGED plan
   *   bumps `plan_revision` and fences claims derived from the older
   *   plan; a stale replay (seq at/below the row's watermark) changes
   *   nothing — it never regresses the watermark or overwrites a newer
   *   plan.
   * - all incarnations terminal ⇒ a recurrence mints the next free
   *   incarnation id at a fresh generation — but only when the
   *   observation postdates the tuple's newest watermark; an older
   *   replay is evidence and must NOT reopen settled history.
   * - fresh tuple ⇒ the first incarnation opens.
   * The partial unique index enforces one active incarnation per tuple
   * transactionally (a race fails loud instead of minting duplicates). */
  private applyBlockedObservation(jobId: string, context: BlockerContext): ObligationRecord {
    const resolved = resolveObligation(context, jobId);
    const now = nowIso();
    const active = this.activeIncarnation(jobId, resolved.logicalStep, resolved.incidentKey);
    if (active !== null) {
      return this.coalesceObservation(active, resolved, context, now);
    }
    const newestWatermark = this.newestIncarnationWatermark(jobId, resolved.logicalStep, resolved.incidentKey);
    if (newestWatermark !== null && context.observedAtSeq <= newestWatermark) {
      this.appendEvent({
        kind: 'job.obligation-stale-observation',
        jobId,
        payload: {
          incident_key: resolved.incidentKey,
          logical_step: resolved.logicalStep,
          observed_at_seq: context.observedAtSeq,
          newest_watermark: newestWatermark,
          note: 'observation predates the tuple history — evidence only, no reopen',
        },
      });
      return this.latestIncarnation(jobId, resolved.logicalStep, resolved.incidentKey) as ObligationRecord;
    }
    const id = this.nextIncarnationId(obligationId(jobId, resolved.logicalStep, resolved.incidentKey));
    const generation = this.currentJobGeneration(jobId) + 1;
    this.insertObligationRow({ id, jobId, resolved, generation, observedAtSeq: context.observedAtSeq, now });
    this.appendEvent({
      kind: 'job.obligation-recorded',
      jobId,
      payload: {
        id,
        generation,
        category: categoryKey(resolved.category),
        next_action: resolved.nextAction,
        firing_rule: resolved.firingRule,
        authority: resolved.authority,
        description: resolved.description,
      },
    });
    return this.getObligation(id) as ObligationRecord;
  }

  /** Coalesce a duplicate observation of the LIVE incarnation. */
  private coalesceObservation(
    existing: ObligationRecord,
    resolved: ResolvedObligation,
    context: BlockerContext,
    now: string,
  ): ObligationRecord {
    if (context.observedAtSeq <= existing.lastOriginSeq) {
      this.appendEvent({
        kind: 'job.obligation-stale-observation',
        jobId: existing.jobId,
        payload: {
          id: existing.id,
          observed_at_seq: context.observedAtSeq,
          newest_watermark: existing.lastOriginSeq,
          note: 'stale replay — evidence only, plan and watermark untouched',
        },
      });
      return existing;
    }
    const planChanged =
      categoryKey(existing.category) !== categoryKey(resolved.category) ||
      JSON.stringify(existing.nextAction) !== JSON.stringify(resolved.nextAction) ||
      JSON.stringify(existing.wakeCondition) !== JSON.stringify(resolved.wakeCondition) ||
      JSON.stringify(existing.authority) !== JSON.stringify(resolved.authority) ||
      existing.firingRule !== resolved.firingRule;
    const changed: string[] = [];
    if (planChanged) changed.push('plan');
    if (existing.dueAt !== resolved.dueAt || existing.deadlineAt !== resolved.deadlineAt) changed.push('bounds');
    // A changed plan is a NEW authority revision (ruling C): claims taken
    // under the old plan are fenced and their full identity moves to the
    // claim log, so an old continuation cannot ride new wording.
    let claim: ObligationClaim | null = existing.claim;
    let claimLog: readonly ClaimLogEntry[] = existing.claimLog;
    let planRevision = existing.planRevision;
    if (planChanged) {
      planRevision += 1;
      if (existing.claim !== null) {
        claimLog = [
          ...claimLog,
          {
            requestId: existing.claim.requestId,
            holder: existing.claim.holder,
            generation: existing.claim.generation,
            expiresAt: existing.claim.expiresAt,
            disposition: 'plan-revision' as ClaimLogDisposition,
            at: now,
            proof: `plan revision ${planRevision}`,
            supersededByRequest: null,
          },
        ];
        claim = null;
      }
    }
    this.db
      .prepare(
        `UPDATE job_obligations
           SET observations = observations + 1,
               last_origin_seq = ?,
               description = COALESCE(?, description),
               category = ?, next_action = ?, wake_condition = ?, authority = ?, firing_rule = ?,
               due_at = COALESCE(?, due_at), receipt_kind = COALESCE(?, receipt_kind),
               deadline_at = COALESCE(?, deadline_at),
               plan_revision = ?, claim = ?, claim_log = ?,
               updated_at = ?
         WHERE id = ?`,
      )
      .run(
        context.observedAtSeq,
        resolved.description,
        JSON.stringify(resolved.category),
        JSON.stringify(resolved.nextAction),
        JSON.stringify(resolved.wakeCondition),
        resolved.authority === null ? null : JSON.stringify(resolved.authority),
        resolved.firingRule,
        resolved.dueAt,
        resolved.receiptKind,
        resolved.deadlineAt,
        planRevision,
        claim === null ? null : JSON.stringify(claim),
        JSON.stringify(claimLog),
        now,
        existing.id,
      );
    this.appendEvent({
      kind: 'job.obligation-updated',
      jobId: existing.jobId,
      payload: {
        id: existing.id,
        observations: existing.observations + 1,
        last_origin_seq: context.observedAtSeq,
        ...(resolved.description !== null ? { description: resolved.description } : {}),
        changed,
        ...(planChanged ? { plan_revision: planRevision, claim_fenced: existing.claim !== null } : {}),
      },
    });
    return this.getObligation(existing.id) as ObligationRecord;
  }

  /** Insert one fresh obligation incarnation (first or recurrence). */
  private insertObligationRow(input: {
    id: string;
    jobId: string;
    resolved: ResolvedObligation;
    generation: number;
    observedAtSeq: number;
    now: string;
  }): void {
    const { resolved } = input;
    this.db
      .prepare(
        `INSERT INTO job_obligations
           (id, job_id, logical_step, incident_key, generation, description, category, next_action, wake_condition,
            authority, firing_rule, state, due_at, receipt_kind, deadline_at, receipt_correlation,
            recorded_receipts, observations, first_origin_seq, last_origin_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, '[]', 1, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.jobId,
        resolved.logicalStep,
        resolved.incidentKey,
        input.generation,
        resolved.description,
        JSON.stringify(resolved.category),
        JSON.stringify(resolved.nextAction),
        JSON.stringify(resolved.wakeCondition),
        resolved.authority === null ? null : JSON.stringify(resolved.authority),
        resolved.firingRule,
        resolved.dueAt,
        resolved.receiptKind,
        resolved.deadlineAt,
        resolved.receiptCorrelation === null ? null : JSON.stringify(resolved.receiptCorrelation),
        input.observedAtSeq,
        input.observedAtSeq,
        input.now,
        input.now,
      );
  }

  /** The tuple's live (non-terminal) incarnation, if any — the ONLY row a
   * duplicate observation may coalesce into (ruling C). */
  private activeIncarnation(jobId: string, logicalStep: string, incidentKey: string): ObligationRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM job_obligations
          WHERE job_id = ? AND logical_step = ? AND incident_key = ?
            AND state NOT IN ('settled', 'closed')
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(jobId, logicalStep, incidentKey) as Row | undefined;
    return row === undefined ? null : this.obligationFromRow(row);
  }

  /** The tuple's newest incarnation in any state (replay-guard anchor). */
  private latestIncarnation(jobId: string, logicalStep: string, incidentKey: string): ObligationRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM job_obligations
          WHERE job_id = ? AND logical_step = ? AND incident_key = ?
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(jobId, logicalStep, incidentKey) as Row | undefined;
    return row === undefined ? null : this.obligationFromRow(row);
  }

  /** Highest watermark across the tuple's incarnations, or null for a
   * fresh tuple. An observation at/below it is a replay, not a reopen. */
  private newestIncarnationWatermark(jobId: string, logicalStep: string, incidentKey: string): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(last_origin_seq) AS watermark FROM job_obligations
          WHERE job_id = ? AND logical_step = ? AND incident_key = ?`,
      )
      .get(jobId, logicalStep, incidentKey) as Row | undefined;
    const value = row?.watermark;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  /** The job's current blocked-generation = the max generation across its
   * obligation rows (0 when none). */
  private currentJobGeneration(jobId: string): number {
    const row = this.db
      .prepare('SELECT MAX(generation) AS generation FROM job_obligations WHERE job_id = ?')
      .get(jobId) as Row | undefined;
    const value = row?.generation;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  /** First free incarnation id for a recurring incident
   * (base, base#2, base#3, ...). History is append-only. */
  private nextIncarnationId(base: string): string {
    let candidate = base;
    let n = 1;
    while (this.getObligation(candidate) !== null) {
      n += 1;
      candidate = `${base}#${n}`;
    }
    return candidate;
  }

  /** Suspend the job's applicable obligations (open/waiting). Used by the
   * parked transition; explicit human/chief resume re-opens. */
  private suspendApplicableObligations(jobId: string, reason: string): void {
    for (const row of this.listApplicableObligations(jobId, ['open', 'waiting'])) {
      this.suspendObligation(row.id, reason);
    }
  }

  /** Close the job's applicable obligations (open/waiting/suspended) on a
   * terminal transition — settled rows and history stay untouched. */
  private closeApplicableObligations(jobId: string, terminal: 'done' | 'merged'): void {
    for (const row of this.listApplicableObligations(jobId, ['open', 'waiting', 'suspended'])) {
      this.settleObligation({
        obligationId: row.id,
        settlement: { kind: 'job-terminal', jobStatus: terminal },
      });
    }
  }

  // ------------------------------------------------------------------
  // Report-job closure (issue #220): a delivered report-type job owes its
  // commissioner ONE disposition. The debt is a job_obligations row with
  // incident key `report:<jobId>`; the dispositions (acted / dismissed /
  // superseded) and the code auto-supersede settle it and move the job
  // delivered → done. Everything here rides ONE transaction per action:
  // status/obligation consistency lives at this boundary (chief ruling A).
  // ------------------------------------------------------------------

  /** Open the ONE report-closure obligation owed by the commissioner of a
   * delivered report-type job. Idempotent: the active incarnation of the
   * `report:<jobId>` incident is returned unchanged (a duplicate delivery
   * or a replay opens nothing). Fails loud on a missing job, a PR-owing
   * deliverable, or a non-delivered status — a report obligation is
   * meaningless anywhere else. */
  openReportObligation(input: {
    jobId: string;
    /** The delivered handback event that proves the report exists. */
    observedAtSeq: number;
    note?: string;
  }): { readonly obligation: ObligationRecord; readonly created: boolean } {
    return this.transaction(() => {
      const job = this.getJob(input.jobId);
      if (job === null) throw new RecordNotFound(`job "${input.jobId}" not found`);
      if (job.deliverable === null || !isReportDeliverable(job.deliverable)) {
        throw new Error(
          `job "${input.jobId}" has deliverable "${String(job.deliverable)}" — report obligations open only on ${REPORT_DELIVERABLES.join('/')} jobs`,
        );
      }
      if (!Number.isSafeInteger(input.observedAtSeq) || input.observedAtSeq < 0) {
        throw new Error('openReportObligation requires a safe non-negative observedAtSeq');
      }
      const incidentKey = reportIncidentKey(job.id);
      const active = this.activeIncarnation(job.id, reportLogicalStep(job.deliverable), incidentKey);
      if (active !== null) return { obligation: active, created: false };
      const step = reportLogicalStep(job.deliverable);
      const resolved = resolveObligation(
        {
          logicalStep: step,
          category: { kind: 'known', category: 'phase-completion' },
          incidentKey,
          observedAtSeq: input.observedAtSeq,
          nextAction: {
            kind: 'gru-decision',
            decision:
              `commissioner ${job.commissioner ?? 'gru'} owes the ${job.deliverable} report disposition: ` +
              'acted (route findings as a directive), dismissed (with a reason), or superseded',
          },
          description:
            input.note ??
            `report handback delivered — commissioner ${job.commissioner ?? 'gru'} owes one disposition ` +
            `(job ${job.id}${job.targetRef === null ? '' : `, target ${job.targetRef}`})`,
        },
        job.id,
      );
      const id = this.nextIncarnationId(obligationId(job.id, step, incidentKey));
      const generation = this.currentJobGeneration(job.id) + 1;
      this.insertObligationRow({
        id,
        jobId: job.id,
        resolved,
        generation,
        observedAtSeq: input.observedAtSeq,
        now: nowIso(),
      });
      this.appendEvent({
        kind: 'job.obligation-recorded',
        jobId: job.id,
        payload: {
          id,
          generation,
          category: categoryKey(resolved.category),
          next_action: resolved.nextAction,
          firing_rule: resolved.firingRule,
          authority: null,
          commissioner: job.commissioner ?? 'gru',
          description: resolved.description,
        },
      });
      return { obligation: this.getObligation(id) as ObligationRecord, created: true };
    });
  }

  /** The job's report-closure obligation — the live incarnation when one
   * is open, else the newest row in any state (history for audits), else
   * null. Direct indexed queries: a long obligation history (page 200+)
   * must never hide the live debt from a disposition. */
  findReportObligation(jobId: string): ObligationRecord | null {
    const incident = reportIncidentKey(jobId);
    const active = this.db
      .prepare(
        `SELECT * FROM job_obligations
          WHERE job_id = ? AND incident_key = ?
            AND state IN ('open', 'waiting', 'suspended')
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(jobId, incident) as Row | undefined;
    if (active !== undefined) return this.obligationFromRow(active);
    const newest = this.db
      .prepare(
        'SELECT * FROM job_obligations WHERE job_id = ? AND incident_key = ? ORDER BY rowid DESC LIMIT 1',
      )
      .get(jobId, incident) as Row | undefined;
    return newest === undefined ? null : this.obligationFromRow(newest);
  }

  /** The commissioner settles a delivered report: ONE transaction records
   * the disposition event, settles the report obligation with the typed
   * settlement, and moves the job delivered → done (legal per states.ts).
   * `acted` requires the directive job id the findings were routed to (the
   * job must exist — routing findings to nothing is not an action);
   * `dismissed`/`superseded` require a non-empty reason. Idempotence is
   * NOT attempted: settling twice is a caller bug (the obligation is
   * terminal after the first call and the second fails loud). */
  settleReportDisposition(input: {
    jobId: string;
    outcome: ReportDispositionOutcome;
    note?: string;
    directiveJobId?: string;
    by?: string;
  }): { readonly job: JobRecord; readonly obligation: ObligationRecord } {
    return this.transaction(() => {
      const job = this.getJob(input.jobId);
      if (job === null) throw new RecordNotFound(`job "${input.jobId}" not found`);
      if (job.status !== 'delivered') {
        throw new Error(
          `job "${input.jobId}" is ${job.status} — dispositions settle a DELIVERED report (delivered → done)`,
        );
      }
      if (job.deliverable === null || !isReportDeliverable(job.deliverable)) {
        throw new Error(
          `job "${input.jobId}" has deliverable "${String(job.deliverable)}" — dispositions apply to ${REPORT_DELIVERABLES.join('/')} jobs`,
        );
      }
      const note = input.note?.trim() ?? '';
      // The recorded commissioner owes the decision; the chief (gru) may
      // always close on their behalf. Any other caller is refused: a debt
      // assigned to silas must not be settled by an unrelated actor.
      const actor = input.by ?? job.commissioner ?? 'gru';
      if (job.commissioner !== null && actor !== job.commissioner && actor !== 'gru') {
        throw new Error(
          `job "${job.id}" is commissioned by "${job.commissioner}" — only that commissioner (or gru, the chief) may settle it (got "${actor}")`,
        );
      }
      if (input.outcome === 'acted') {
        if (input.directiveJobId === undefined || input.directiveJobId.trim() === '') {
          throw new Error('disposition acted requires directive_job_id — findings route as a directive to the target lane');
        }
        const directive = this.getJob(input.directiveJobId);
        if (directive === null) {
          throw new RecordNotFound(`directive job "${input.directiveJobId}" not found — route findings to a real job`);
        }
        if (directive.repo !== job.repo) {
          throw new Error(
            `directive job "${directive.id}" belongs to repo "${directive.repo}", but the report reviewed "${job.repo}" — ` +
              'route findings to the target lane, not another repository',
          );
        }
      } else if (note === '') {
        throw new Error(`disposition ${input.outcome} requires a non-empty note (the recorded reason)`);
      }
      const obligation = this.findReportObligation(input.jobId);
      if (obligation === null || (obligation.state !== 'open' && obligation.state !== 'waiting' && obligation.state !== 'suspended')) {
        throw new Error(
          `job "${input.jobId}" has no open report obligation (incident ${reportIncidentKey(input.jobId)}) — nothing owes a disposition`,
        );
      }
      const event = this.appendEvent({
        kind: REPORT_DISPOSITION_EVENT,
        jobId: job.id,
        payload: {
          outcome: input.outcome,
          note: note === '' ? null : note,
          directive_job_id: input.directiveJobId ?? null,
          obligation_id: obligation.id,
          by: input.by ?? job.commissioner ?? 'gru',
        },
      });
      const settlement: ObligationSettlement =
        input.outcome === 'acted'
          ? {
              kind: 'executed-action',
              action: `report findings routed to directive job ${String(input.directiveJobId)}`,
              evidenceEventSeq: event.seq,
              evidenceEventKind: REPORT_DISPOSITION_EVENT,
            }
          : input.outcome === 'dismissed'
            ? { kind: 'cancelled', reason: note }
            : { kind: 'superseded', byObligationId: null, reason: note };
      const settled = this.settleObligation({ obligationId: obligation.id, settlement });
      // The handback card (posted by the deterministic pass) is answered by
      // this settlement: a resolved debt must never leave a false
      // outstanding action behind.
      this.resolveReportHandbackCard(job.id, actor);
      const done = this.setJobStatus(job.id, 'done');
      return { job: done, obligation: settled };
    });
  }

  /** Code auto-supersede (issue #220): durable proof the report's target
   * merged or its head moved past the reviewed sha retires the owed
   * disposition — the findings can no longer apply to the target. ONE
   * transaction: obligation settles as superseded, `report.superseded`
   * records the reason, the job moves delivered → done. Fails loud when
   * the job is not a delivered report-type job or no obligation is open —
   * a caller scanning stale candidates re-reads the row and moves on. */
  supersedeReportObligation(input: { jobId: string; reason: string }): {
    readonly job: JobRecord;
    readonly obligation: ObligationRecord;
  } {
    return this.transaction(() => {
      const job = this.getJob(input.jobId);
      if (job === null) throw new RecordNotFound(`job "${input.jobId}" not found`);
      if (job.status !== 'delivered') {
        throw new Error(`job "${input.jobId}" is ${job.status} — auto-supersede retires a DELIVERED report`);
      }
      const obligation = this.findReportObligation(input.jobId);
      if (obligation === null || (obligation.state !== 'open' && obligation.state !== 'waiting' && obligation.state !== 'suspended')) {
        throw new Error(
          `job "${input.jobId}" has no open report obligation (incident ${reportIncidentKey(input.jobId)}) — nothing to supersede`,
        );
      }
      const settled = this.settleObligation({
        obligationId: obligation.id,
        settlement: { kind: 'superseded', byObligationId: null, reason: input.reason },
      });
      this.resolveReportHandbackCard(job.id, 'code');
      this.appendEvent({
        kind: REPORT_SUPERSEDED_EVENT,
        jobId: job.id,
        payload: {
          reason: input.reason,
          target_ref: job.targetRef,
          target_sha: job.targetSha,
          obligation_id: obligation.id,
        },
      });
      const done = this.setJobStatus(job.id, 'done');
      return { job: done, obligation: settled };
    });
  }

  /** Resolve the job's stable-kind handback card, if one was posted and is
   * still open — called from every settlement path so a closed debt never
   * leaves a false outstanding action. */
  private resolveReportHandbackCard(jobId: string, by: string): void {
    const card = this.findNotificationByKind(`silas.report-handback.${jobId}`, 'any');
    if (card !== null && card.resolvedAt === null) this.resolveNotificationById(card.id, by);
  }

  /** One job's rowid (keyset pagination anchor). */
  jobRowid(id: string): number | null {
    const row = this.db.prepare('SELECT rowid AS _rowid FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : Number(row._rowid);
  }

  /** The auto-supersede scan set, straight from SQL: delivered report-type
   * jobs carrying a target (the reviewed sha is optional — a merged target
   * needs only the PR url). Legacy NULL-deliverable rows and PR-owing
   * lanes never appear — the backfill owns the former, and a PR lane's
   * merge path is the machine's, not this pass's. Keyset-paged by rowid
   * (`cursor`) so a persistently unchanged prefix cannot starve the tail:
   * the caller resumes past the last examined row on its next pass. */
  listReportClosureCandidates(limit = 200, opts: { cursor?: number } = {}): readonly JobRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(`listReportClosureCandidates requires a positive integer limit, got ${String(limit)}`);
    }
    const placeholders = REPORT_DELIVERABLES.map(() => '?').join(', ');
    const cursorClause = opts.cursor !== undefined ? 'AND rowid > ?' : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE status = 'delivered' AND deliverable IN (${placeholders})
           AND target_ref IS NOT NULL ${cursorClause}
         ORDER BY rowid LIMIT ?`,
      )
      .all(...REPORT_DELIVERABLES, ...(opts.cursor !== undefined ? [opts.cursor] : []), limit) as Row[];
    return rows.map((row) => this.jobFromRow(row));
  }

  /** Every delivered report-type job with its kind RECORDED — the
   * deterministic pass's crash-window backstop set for a lost obligation
   * open. Legacy NULL rows are excluded by construction: the backfill CLI
   * owns them and the owner reviews its dry-run first. Same keyset paging
   * contract as the supersede scan. */
  listDeliveredReportJobs(limit = 200, opts: { cursor?: number } = {}): readonly JobRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(`listDeliveredReportJobs requires a positive integer limit, got ${String(limit)}`);
    }
    const placeholders = REPORT_DELIVERABLES.map(() => '?').join(', ');
    const cursorClause = opts.cursor !== undefined ? 'AND rowid > ?' : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE status = 'delivered' AND deliverable IN (${placeholders}) ${cursorClause}
         ORDER BY rowid LIMIT ?`,
      )
      .all(...REPORT_DELIVERABLES, ...(opts.cursor !== undefined ? [opts.cursor] : []), limit) as Row[];
    return rows.map((row) => this.jobFromRow(row));
  }

  /** The job that owns a PR url — the merge/head signals land THERE, and
   * a report's auto-supersede reads them through this lookup. */
  findJobByPrUrl(url: string): JobRecord | null {
    if (url.trim() === '') return null;
    const row = this.db.prepare('SELECT * FROM jobs WHERE pr_url = ? ORDER BY updated_at DESC, id LIMIT 1').get(url) as Row | undefined;
    return row === undefined ? null : this.jobFromRow(row);
  }

  /** Legacy backfill (issue #220): the delivered, PR-less rows whose
   * deliverable was never recorded (pre-E19 lanes). The backfill CLI
   * classifies and proposes; only --apply writes. */
  listLegacyDeliveredJobs(limit = 1000, opts: { cursor?: number } = {}): readonly JobRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(`listLegacyDeliveredJobs requires a positive integer limit, got ${String(limit)}`);
    }
    const cursorClause = opts.cursor !== undefined ? 'AND rowid > ?' : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE status = 'delivered' AND pr_url IS NULL AND deliverable IS NULL ${cursorClause}
         ORDER BY rowid LIMIT ?`,
      )
      .all(...(opts.cursor !== undefined ? [opts.cursor] : []), limit) as Row[];
    return rows.map((row) => this.jobFromRow(row));
  }

  /** Backfill write for ONE legacy row (idempotent): stamp the inferred
   * deliverable only while the column is still NULL, stamp inferable
   * target fields, append `report.backfilled`, and open the report
   * obligation owed by the recorded (or default) commissioner. The
   * superseded outcome additionally settles the obligation and closes the
   * job delivered → done. Re-running a proposal that already landed is a
   * no-op returning the current row. */
  applyReportBackfill(input: {
    jobId: string;
    deliverable: ReportDeliverable;
    outcome: 'obligation-opened' | 'superseded';
    reason: string;
    commissioner?: string | null;
    targetRef?: string | null;
    targetSha?: string | null;
  }): { readonly job: JobRecord; readonly applied: boolean } {
    return this.transaction(() => {
      const job = this.getJob(input.jobId);
      if (job === null) throw new RecordNotFound(`job "${input.jobId}" not found`);
      if (job.status !== 'delivered') return { job, applied: false }; // already closed — idempotent replay
      // This row was already backfilled (the whole apply is one transaction:
      // stamp + obligation + report.backfilled + optional supersede commit
      // together), so a replayed stale plan is a true no-op — no duplicate
      // audit event, no second obligation.
      if (this.latestJobEvent(job.id, REPORT_BACKFILL_EVENT) !== null) return { job, applied: false };
      // The plan was computed on a changed row: a PR link or an explicit
      // deliverable stamp (another actor got there first) means this is no
      // longer a legacy row — never stamp over live truth with a stale plan.
      if (job.prUrl !== null || job.deliverable !== null) return { job, applied: false };
      const stamp = (column: 'deliverable' | 'commissioner' | 'target_ref' | 'target_sha', value: string | null): void => {
        this.db.prepare(`UPDATE jobs SET ${column} = ?, updated_at = ? WHERE id = ? AND ${column} IS NULL`).run(value, nowIso(), job.id);
      };
      stamp('deliverable', input.deliverable);
      stamp('commissioner', input.commissioner ?? null);
      stamp('target_ref', input.targetRef ?? null);
      stamp('target_sha', input.targetSha ?? null);
      const current = this.getJob(job.id) as JobRecord;
      // A delivered legacy row whose delivery event is missing has no
      // handback to open an obligation from: fail loud and leave the row in
      // the scan for the owner instead of stamping it into invisible debt.
      const latestDelivered = this.latestJobEvent(job.id, 'job.delivered');
      if (latestDelivered === null) {
        throw new Error(
          `job "${job.id}" is delivered with no job.delivered event — its handback is not proven; refusing to backfill`,
        );
      }
      this.openReportObligation({ jobId: job.id, observedAtSeq: latestDelivered.seq });
      this.appendEvent({
        kind: REPORT_BACKFILL_EVENT,
        jobId: job.id,
        payload: {
          outcome: input.outcome,
          reason: input.reason,
          deliverable: input.deliverable,
          commissioner: current.commissioner,
          target_ref: current.targetRef,
          target_sha: current.targetSha,
        },
      });
      if (input.outcome === 'superseded') {
        this.supersedeReportObligation({ jobId: job.id, reason: input.reason });
      }
      return { job: this.getJob(job.id) as JobRecord, applied: true };
    });
  }

  /**
   * Every obligation of one job matching a state set, read in bounded
   * state-filtered cursor pages up to a rowid watermark captured first
   * (r6 warning): a long settled/closed history prefix must never hide
   * newer live debt from the whole-job lifecycle sweeps. Callers run this
   * inside the status transaction, so the watermark keeps the page set
   * stable and every row is visited exactly once. */
  private listApplicableObligations(
    jobId: string,
    states: readonly ObligationState[],
  ): readonly ObligationRecord[] {
    const ceilingRow = this.db
      .prepare('SELECT MAX(rowid) AS ceiling FROM job_obligations WHERE job_id = ?')
      .get(jobId) as Row | undefined;
    const ceiling = ceilingRow?.ceiling;
    if (ceiling === null || ceiling === undefined) return [];
    const watermark = Number(ceiling);
    const pageSize = 200;
    const rows: ObligationRecord[] = [];
    let cursor = 0;
    for (;;) {
      const page = this.listObligations({
        jobId,
        states,
        limit: pageSize,
        cursor,
        maxRowid: watermark,
      });
      rows.push(...page);
      if (page.length < pageSize) return rows;
      const last = page[page.length - 1];
      if (last === undefined) return rows;
      const rowid = this.obligationRowid(last.id);
      if (rowid === null) return rows; // defensive: a listed row always has its rowid
      cursor = rowid;
    }
  }

  private obligationFromRow(row: Row): ObligationRecord {
    const state = str(row.state);
    if (!isObligationState(state)) {
      throw new Error(`job_obligations row "${str(row.id)}" has unknown state "${state}"`);
    }
    return {
      id: str(row.id),
      jobId: str(row.job_id),
      logicalStep: str(row.logical_step),
      incidentKey: str(row.incident_key),
      generation: Number(row.generation),
      description: nstr(row.description),
      category: parseCategory(str(row.category)),
      nextAction: parseNextAction(str(row.next_action)),
      wakeCondition: parseWakeCondition(str(row.wake_condition)),
      authority: parseAuthority(row.authority === null || row.authority === undefined ? null : str(row.authority)),
      firingRule: str(row.firing_rule),
      state,
      settlement: row.settlement === null || row.settlement === undefined ? null : parseSettlement(str(row.settlement)),
      dueAt: nstr(row.due_at),
      receiptKind: nstr(row.receipt_kind),
      deadlineAt: nstr(row.deadline_at),
      recordedReceipts: parseReceipts(str(row.recorded_receipts)),
      observations: Number(row.observations),
      planRevision: Number(row.plan_revision),
      firstOriginSeq: Number(row.first_origin_seq),
      lastOriginSeq: Number(row.last_origin_seq),
      supersededBy: nstr(row.superseded_by),
      claim: parseClaim(row.claim === null || row.claim === undefined ? null : str(row.claim)),
      claimLog: parseClaimLog(str(row.claim_log)),
      receiptCorrelation: parseReceiptCorrelation(
        row.receipt_correlation === null || row.receipt_correlation === undefined
          ? null
          : str(row.receipt_correlation),
      ),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }

  private providerWaitFromRow(row: Row): ProviderWaitRecord {
    const status = str(row.status);
    if (!isProviderWaitStatus(status)) {
      throw new Error(`provider_waits row has unknown status "${status}"`);
    }
    const waiterKind = str(row.waiter_kind);
    if (!isProviderWaiterKind(waiterKind)) {
      throw new Error(`provider_waits row has unknown waiter kind "${waiterKind}"`);
    }
    let continuation: ProviderWaitContinuation | null = null;
    const raw = nstr(row.continuation);
    if (raw !== null && raw !== '') {
      try {
        const parsed = JSON.parse(raw) as Partial<ProviderWaitContinuation>;
        continuation = {
          promptText: typeof parsed.promptText === 'string' ? parsed.promptText : null,
          promptOwner: typeof parsed.promptOwner === 'string' ? parsed.promptOwner : null,
          hadOpenTurn: parsed.hadOpenTurn === true,
        };
      } catch (error) {
        throw new Error(`provider_waits row ${str(row.id)} continuation is not valid JSON: ${String(error)}`);
      }
    }
    return {
      id: str(row.id),
      routeKey: str(row.route_key),
      provider: str(row.provider),
      model: str(row.model),
      endpoint: str(row.endpoint),
      credentialFingerprint: str(row.credential_fingerprint),
      waiterKind,
      jobId: nstr(row.job_id),
      agentId: nstr(row.agent_id),
      slotId: nstr(row.slot_id),
      sessionFile: nstr(row.session_file),
      continuation,
      jobStatusAtEstablishment: nstr(row.job_status_at_establishment),
      lineageKey: nstr(row.lineage_key),
      recoveryBatchId: nstr(row.recovery_batch_id),
      incidentId: str(row.incident_id),
      incidentGeneration: Number(row.incident_generation),
      status,
      reasonClass: str(row.reason_class),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }

  // ------------------------------------------------------------------
  // Explicit phase-completion handoffs (pr136-chief-handoff). A guard
  // row persisted BEFORE admission/side effects; a validated correlated
  // completion; publication recorded on the same row. Nothing here
  // executes work, wakes anyone by itself, or mints authority — the debt
  // lives in job_obligations and the wake rides NotificationCenter.
  // ------------------------------------------------------------------

  /** Persist the completion intent for an authorized phase. Idempotent
   * per request id: a replay returns the SAME row (changed decision is a
   * conflict — the intent is part of the request identity). The host mints
   * the deterministic `phase-handoff:<job>:<source>:<generation>` id. */
  beginPhaseHandoff(input: {
    jobId: string;
    source: PhaseHandoffSource;
    intent: CompletionHandoffIntent;
    requestId?: string | null;
  }): { readonly record: PhaseHandoffRecord; readonly created: boolean } {
    if (!isPhaseHandoffSource(input.source)) {
      throw new Error(`phase handoff source "${String(input.source)}" is unknown`);
    }
    const decision = input.intent.decision.trim();
    if (decision === '') throw new Error('phase handoff requires a non-empty decision');
    if (decision.length > MAX_COMPLETION_HANDOFF_DECISION) {
      throw new Error(`phase handoff decision exceeds ${MAX_COMPLETION_HANDOFF_DECISION} characters`);
    }
    return this.transaction(() => {
      const job = this.getJob(input.jobId);
      if (job === null) throw new RecordNotFound(`job "${input.jobId}" not found`);
      const requestId = input.requestId ?? null;
      if (requestId !== null) {
        const existing = this.findPhaseHandoffByRequest({ jobId: input.jobId, requestId });
        if (existing !== null) {
          if (existing.decision !== decision) {
            throw new PhaseHandoffConflictError(
              `phase handoff for request "${requestId}" was accepted with a different decision — ` +
                'the intent is part of the durable request; changed intent needs a new request',
            );
          }
          return { record: existing, created: false };
        }
      }
      const generation = this.nextPhaseHandoffGeneration(input.jobId);
      const phaseId = phaseHandoffId(input.jobId, input.source, generation);
      const intentEvent = this.appendEvent({
        kind: 'job.phase-handoff-intent',
        jobId: input.jobId,
        payload: {
          phase_id: phaseId,
          source: input.source,
          generation,
          request_id: requestId,
          decision,
        },
      });
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO phase_handoffs
             (phase_id, job_id, source, request_id, generation, decision, state, intent_seq, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'awaiting', ?, ?, ?)`,
        )
        .run(phaseId, input.jobId, input.source, requestId, generation, decision, intentEvent.seq, ts, ts);
      return { record: this.getPhaseHandoff(phaseId) as PhaseHandoffRecord, created: true };
    });
  }

  getPhaseHandoff(phaseId: string): PhaseHandoffRecord | null {
    const row = this.db.prepare('SELECT * FROM phase_handoffs WHERE phase_id = ?').get(phaseId) as Row | undefined;
    return row === undefined ? null : this.phaseHandoffFromRow(row);
  }

  /** Bounded listing for reconciliation/adoption. `cursor` is the rowid
   * of the previous page's last row (append-only-safe paging).
   * `needsAction` narrows to rows a reconcile pass can still move —
   * `awaiting` intents plus `completed` rows missing their obligation or
   * card — so already-published history never consumes a bounded pass's
   * budget and the tail keeps fair progress (PR136 r4 blocker 3). */
  listPhaseHandoffs(
    opts: {
      jobId?: string;
      source?: PhaseHandoffSource;
      states?: readonly PhaseHandoffState[];
      limit?: number;
      cursor?: number;
      needsAction?: boolean;
    } = {},
  ): readonly PhaseHandoffRecord[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 200), 1000);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.jobId !== undefined) {
      where.push('job_id = ?');
      params.push(opts.jobId);
    }
    if (opts.source !== undefined) {
      if (!isPhaseHandoffSource(opts.source)) {
        throw new Error(`listPhaseHandoffs got unknown phase source "${String(opts.source)}"`);
      }
      where.push('source = ?');
      params.push(opts.source);
    }
    if (opts.states !== undefined) {
      if (opts.states.length === 0) throw new Error('listPhaseHandoffs "states" filter must not be empty');
      for (const state of opts.states) {
        if (!isPhaseHandoffState(state)) throw new Error(`listPhaseHandoffs got unknown phase state "${state}"`);
      }
      where.push(`state IN (${opts.states.map(() => '?').join(', ')})`);
      params.push(...opts.states);
    }
    if (opts.needsAction === true) {
      // Satisfied history (completed + obligation + card) is not actionable:
      // excluding it here is what keeps a bounded pass from re-reading the
      // same published prefix forever.
      where.push(
        "(state = 'awaiting' OR (state = 'completed' AND (obligation_id IS NULL OR notification_id IS NULL)))",
      );
    }
    if (opts.cursor !== undefined) {
      where.push('rowid > ?');
      params.push(opts.cursor);
    }
    const sql = `SELECT rowid AS _rowid, * FROM phase_handoffs${
      where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
    } ORDER BY rowid LIMIT ?`;
    return (this.db.prepare(sql).all(...(params as never[]), limit) as Row[]).map((row) => this.phaseHandoffFromRow(row));
  }

  /** The rowid cursor for one phase (pagination anchor). */
  phaseHandoffRowid(phaseId: string): number | null {
    const row = this.db.prepare('SELECT rowid AS _rowid FROM phase_handoffs WHERE phase_id = ?').get(phaseId) as
      | Row
      | undefined;
    return row === undefined ? null : Number(row._rowid);
  }

  /** Durable round-robin cursor for one bounded reconcile scope (PR136 r4
   * blocker 3): successive bounded passes continue where the previous pass
   * stopped, so no fixed prefix — however much satisfied history it holds —
   * can starve the actionable rows behind it. */
  readReconcileCursor(scope: string): number | null {
    if (scope.trim() === '') throw new Error('reconcile cursor scope must be non-empty');
    const row = this.db.prepare('SELECT cursor FROM reconcile_cursors WHERE scope = ?').get(scope) as Row | undefined;
    return row === undefined ? null : Number(row.cursor);
  }

  /** Advance one reconcile scope's cursor (idempotent upsert). */
  writeReconcileCursor(input: { scope: string; cursor: number }): void {
    if (input.scope.trim() === '') throw new Error('reconcile cursor scope must be non-empty');
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 0) {
      throw new Error('reconcile cursor must be a safe non-negative rowid');
    }
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO reconcile_cursors (scope, cursor, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(scope) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
        )
        .run(input.scope, input.cursor, nowIso());
    });
  }

  /** The newest phase row a directive request authorized, if any. */
  findPhaseHandoffByRequest(input: { jobId: string; requestId: string }): PhaseHandoffRecord | null {
    if (input.requestId.trim() === '') throw new Error('findPhaseHandoffByRequest requires a non-empty requestId');
    const row = this.db
      .prepare('SELECT * FROM phase_handoffs WHERE job_id = ? AND request_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(input.jobId, input.requestId) as Row | undefined;
    return row === undefined ? null : this.phaseHandoffFromRow(row);
  }

  /** Bind the spawned admitted worker to its awaiting phase (dispatch
   * path). Idempotent for the same worker; a different worker is a
   * conflict — a phase has exactly one admitted minion. */
  bindPhaseHandoffMinion(input: { phaseId: string; minionId: string }): PhaseHandoffRecord {
    if (input.minionId.trim() === '') throw new Error('phase handoff binding requires a non-empty minion id');
    return this.transaction(() => {
      const row = this.getPhaseHandoff(input.phaseId);
      if (row === null) throw new RecordNotFound(`phase handoff "${input.phaseId}" not found`);
      if (row.state !== 'awaiting') {
        throw new PhaseHandoffConflictError(`phase handoff "${row.phaseId}" is ${row.state} — it takes no worker binding`);
      }
      if (row.minionId !== null) {
        if (row.minionId !== input.minionId) {
          throw new PhaseHandoffConflictError(
            `phase handoff "${row.phaseId}" is already bound to minion ${row.minionId}, not ${input.minionId}`,
          );
        }
        return row;
      }
      this.db
        .prepare('UPDATE phase_handoffs SET minion_id = ?, updated_at = ? WHERE phase_id = ?')
        .run(input.minionId, nowIso(), row.phaseId);
      return this.getPhaseHandoff(row.phaseId) as PhaseHandoffRecord;
    });
  }

  /** Record the VALIDATED terminal completion. Callers must have checked
   * the correlation/admission gates (dispatch-side observers own that);
   * this primitive only enforces the state machine and the one-completion
   * invariant. A completion at/before the intent watermark is refused —
   * an older receipt can never complete a newer phase. */
  completePhaseHandoff(input: { phaseId: string; completionSeq: number }): PhaseHandoffRecord {
    if (!Number.isSafeInteger(input.completionSeq) || input.completionSeq < 0) {
      throw new Error('phase handoff completion requires a safe non-negative event seq');
    }
    return this.transaction(() => {
      const row = this.getPhaseHandoff(input.phaseId);
      if (row === null) throw new RecordNotFound(`phase handoff "${input.phaseId}" not found`);
      if (row.state === 'closed') {
        throw new PhaseHandoffConflictError(`phase handoff "${row.phaseId}" is closed — a late completion cannot reopen it`);
      }
      if (row.state === 'completed') {
        if (row.completionSeq === input.completionSeq) return row; // idempotent replay
        throw new PhaseHandoffConflictError(
          `phase handoff "${row.phaseId}" already completed at event ${row.completionSeq} — a second receipt cannot rewrite it`,
        );
      }
      if (input.completionSeq <= row.intentSeq) {
        throw new PhaseHandoffConflictError(
          `phase handoff "${row.phaseId}" completion cites event ${input.completionSeq} at/before its intent watermark ${row.intentSeq}`,
        );
      }
      this.db
        .prepare("UPDATE phase_handoffs SET state = 'completed', completion_seq = ?, updated_at = ? WHERE phase_id = ?")
        .run(input.completionSeq, nowIso(), row.phaseId);
      this.appendEvent({
        kind: 'job.phase-handoff-completed',
        jobId: row.jobId,
        payload: { phase_id: row.phaseId, source: row.source, completion_seq: input.completionSeq },
      });
      return this.getPhaseHandoff(row.phaseId) as PhaseHandoffRecord;
    });
  }

  /** Record the owed obligation on the completed phase (idempotent; a
   * different obligation id would fork the debt and is refused). */
  markPhaseHandoffObligation(input: { phaseId: string; obligationId: string }): PhaseHandoffRecord {
    if (input.obligationId.trim() === '') throw new Error('phase handoff obligation id must be non-empty');
    return this.transaction(() => {
      const row = this.getPhaseHandoff(input.phaseId);
      if (row === null) throw new RecordNotFound(`phase handoff "${input.phaseId}" not found`);
      if (row.state !== 'completed') {
        throw new PhaseHandoffConflictError(`phase handoff "${row.phaseId}" is ${row.state} — only a completed phase carries a debt`);
      }
      if (row.obligationId !== null) {
        if (row.obligationId !== input.obligationId) {
          throw new PhaseHandoffConflictError(
            `phase handoff "${row.phaseId}" already names obligation ${row.obligationId}, not ${input.obligationId}`,
          );
        }
        return row;
      }
      this.db
        .prepare('UPDATE phase_handoffs SET obligation_id = ?, updated_at = ? WHERE phase_id = ?')
        .run(input.obligationId, nowIso(), row.phaseId);
      return this.getPhaseHandoff(row.phaseId) as PhaseHandoffRecord;
    });
  }

  /** Record the published action-required row (idempotent; a different id
   * would mean a second card for one phase and is refused). */
  markPhaseHandoffPublished(input: { phaseId: string; notificationId: string }): PhaseHandoffRecord {
    if (input.notificationId.trim() === '') throw new Error('phase handoff notification id must be non-empty');
    return this.transaction(() => {
      const row = this.getPhaseHandoff(input.phaseId);
      if (row === null) throw new RecordNotFound(`phase handoff "${input.phaseId}" not found`);
      if (row.state !== 'completed') {
        throw new PhaseHandoffConflictError(`phase handoff "${row.phaseId}" is ${row.state} — only a completed phase publishes`);
      }
      if (row.notificationId !== null) {
        if (row.notificationId !== input.notificationId) {
          throw new PhaseHandoffConflictError(
            `phase handoff "${row.phaseId}" already published ${row.notificationId}, not ${input.notificationId}`,
          );
        }
        return row;
      }
      this.db
        .prepare('UPDATE phase_handoffs SET notification_id = ?, updated_at = ? WHERE phase_id = ?')
        .run(input.notificationId, nowIso(), row.phaseId);
      return this.getPhaseHandoff(row.phaseId) as PhaseHandoffRecord;
    });
  }

  /** Close an awaiting/completed phase without a hand-back (failure,
   * cancellation, supersession, terminal/parked guard). Idempotent for a
   * closed row; the reason is durable provenance. closed never reopens. */
  closePhaseHandoff(input: { phaseId: string; reason: string }): PhaseHandoffRecord {
    if (input.reason.trim() === '') throw new Error('phase handoff close requires a reason');
    return this.transaction(() => {
      const row = this.getPhaseHandoff(input.phaseId);
      if (row === null) throw new RecordNotFound(`phase handoff "${input.phaseId}" not found`);
      if (row.state === 'closed') return row;
      this.db
        .prepare("UPDATE phase_handoffs SET state = 'closed', close_reason = ?, updated_at = ? WHERE phase_id = ?")
        .run(input.reason, nowIso(), row.phaseId);
      this.appendEvent({
        kind: 'job.phase-handoff-closed',
        jobId: row.jobId,
        payload: { phase_id: row.phaseId, source: row.source, from: row.state, reason: input.reason },
      });
      return this.getPhaseHandoff(row.phaseId) as PhaseHandoffRecord;
    });
  }

  /** Per-job monotonic phase generation (1-based). */
  private nextPhaseHandoffGeneration(jobId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(generation), 0) AS generation FROM phase_handoffs WHERE job_id = ?')
      .get(jobId) as Row | undefined;
    const value = row?.generation;
    return (typeof value === 'number' && Number.isFinite(value) ? value : 0) + 1;
  }

  private phaseHandoffFromRow(row: Row): PhaseHandoffRecord {
    const state = str(row.state);
    if (!isPhaseHandoffState(state)) {
      throw new Error(`phase_handoffs row "${str(row.phase_id)}" has unknown state "${state}"`);
    }
    const source = str(row.source);
    if (!isPhaseHandoffSource(source)) {
      throw new Error(`phase_handoffs row "${str(row.phase_id)}" has unknown source "${source}"`);
    }
    return {
      phaseId: str(row.phase_id),
      jobId: str(row.job_id),
      source,
      requestId: nstr(row.request_id),
      generation: Number(row.generation),
      decision: str(row.decision),
      state,
      intentSeq: Number(row.intent_seq),
      minionId: nstr(row.minion_id),
      completionSeq: row.completion_seq === null || row.completion_seq === undefined ? null : Number(row.completion_seq),
      obligationId: nstr(row.obligation_id),
      notificationId: nstr(row.notification_id),
      closeReason: nstr(row.close_reason),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }

  private providerRouteFromRow(row: Row): ProviderRouteRecord {
    return {
      routeKey: str(row.route_key),
      provider: str(row.provider),
      model: str(row.model),
      endpoint: str(row.endpoint),
      credentialFingerprint: str(row.credential_fingerprint),
      incidentSeq: Number(row.incident_seq),
      lastResult: nstr(row.last_result),
      suspendedUntil: nstr(row.suspended_until),
      windowStart: str(row.window_start),
      attemptsInWindow: Number(row.attempts_in_window),
      nextCheckAt: str(row.next_check_at),
      lastAttemptAt: nstr(row.last_attempt_at),
      consecutiveProbeFailures: Number(row.consecutive_probe_failures),
      falseRecoveryCount: Number(row.false_recovery_count),
      updatedAt: str(row.updated_at),
    };
  }

  // ------------------------------------------------------------------
  // Durable directive requests (phase 3 slice): request-scoped
  // intent/claim/admission/receipt/reconciliation. The durable row is the
  // single source of truth; HTTP responses only report it. No prompt/
  // spawn side effect may precede the atomic intent→dispatch claim, and
  // no caller-supplied text can mark a request admitted or delivered —
  // only a correlated ledger event can.
  // ------------------------------------------------------------------

  /** Accept a directive request: persists the atomic intent→dispatch
   * claim BEFORE any side effect (ruling: an intent without admission is
   * NOT proof of no side effect — but an intent with NO claim transition
   * cannot have had one). Returns `created: false` when this call was a
   * durable REPLAY of an existing request: the caller must NOT start
   * another turn — only the creating call ever owns side effects. Same
   * request id + same canonical payload replays to the SAME row; same id
   * + different payload is a conflict. While ANY live request exists for
   * the job, ANY different request id (identified or not) fails CLOSED
   * with the live request named — the lane is single-writer, so a fresh
   * id never starts a second concurrent turn. When the
   * request carries an explicit completion intent (`handoff`), the
   * phase-handoff guard row is persisted in the SAME transaction — before
   * any side effect — and a live REPLAY may attach the intent to the
   * existing request (idempotent by request id); an already-terminal
   * request is never retro-marked. */
  beginDirectiveIntent(input: {
    jobId: string;
    directive: string;
    blockerFingerprint?: string;
    holder: string;
    requestId?: string;
    /** Explicit completion intent; omitted = ordinary directive. */
    handoff?: CompletionHandoffIntent;
  }): { readonly record: DirectiveRequestRecord; readonly created: boolean } {
    if (input.directive.trim() === '') throw new Error('directive text must be non-empty');
    if (input.holder.trim() === '') throw new Error('directive intent requires a non-empty holder');
    const job = this.getJob(input.jobId);
    if (job === null) throw new RecordNotFound(`job "${input.jobId}" not found`);
    if (job.status === 'merged' || job.status === 'done') {
      throw new Error(`job "${input.jobId}" is ${job.status} — terminal lanes take no directives`);
    }
    const payload = JSON.stringify({ directive: input.directive, blocker_fingerprint: input.blockerFingerprint ?? null });
    const payloadHash = createHash('sha256').update(payload).digest('hex');
    return this.transaction(() => {
      if (input.requestId !== undefined) {
        const existing = this.getDirective(input.requestId);
        if (existing !== null) {
          if (existing.payloadHash !== payloadHash) {
            throw new DirectiveConflictError(
              `directive request "${input.requestId}" was accepted with a different payload — ` +
                'a request id identifies one exact request; submit the changed work under a new id',
            );
          }
          if (existing.jobId !== input.jobId) {
            throw new DirectiveConflictError(
              `directive request "${input.requestId}" belongs to job ${existing.jobId}, not ${input.jobId}`,
            );
          }
          if (input.handoff !== undefined && !isDirectiveTerminal(existing.state)) {
            // A live replay may attach (or confirm) the explicit completion
            // intent for THIS request — same request identity, idempotent.
            this.beginPhaseHandoff({
              jobId: input.jobId,
              source: 'silas-directive',
              intent: input.handoff,
              requestId: existing.requestId,
            });
          }
          return { record: existing, created: false }; // durable replay — the accepted request, unchanged
        }
      }
      // Fail CLOSED while ANY live request for the job exists: the lane is
      // single-writer, so a DIFFERENT request id must never start a second
      // concurrent turn (never reopen the PR133 window with a fresh id).
      // A replay of the live request itself already returned above; the
      // refusal always NAMES the live request so the caller can retry with
      // the same id, wait, or reconcile. Query the LIVE states directly
      // (a bounded page ordered by request_id cannot be the live set: the
      // table is append-only, so terminal rows would crowd live ones past
      // the page forever).
      const live = this.listPendingDirectives({
        jobId: input.jobId,
        states: LIVE_DIRECTIVE_STATES,
        limit: 1,
      })[0];
      if (live !== undefined) {
        throw new AmbiguousDirectiveError(
          `a directive for job "${input.jobId}" is already live (request ${live.requestId}, state ${live.state}) — ` +
            'retry with that SAME request_id, wait for it to settle, or reconcile it first; ' +
            'a different request id never starts a second concurrent turn on the lane',
        );
      }
      const requestId = input.requestId ?? randomUUID();
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO pending_directives
             (request_id, job_id, payload, payload_hash, state, baseline_seq, claim, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'dispatching', ?, ?, 0, ?, ?)`,
        )
        .run(
          requestId,
          input.jobId,
          payload,
          payloadHash,
          this.latestEventSeq(),
          JSON.stringify({ holder: input.holder, since: ts }),
          ts,
          ts,
        );
      this.appendEvent({
        kind: 'silas.directive-intent',
        jobId: input.jobId,
        payload: { request_id: requestId, holder: input.holder, directive_bytes: Buffer.byteLength(input.directive, 'utf-8') },
      });
      if (input.handoff !== undefined) {
        this.beginPhaseHandoff({
          jobId: input.jobId,
          source: 'silas-directive',
          intent: input.handoff,
          requestId,
        });
      }
      return { record: this.getDirective(requestId) as DirectiveRequestRecord, created: true };
    });
  }

  getDirective(requestId: string): DirectiveRequestRecord | null {
    const row = this.db.prepare('SELECT * FROM pending_directives WHERE request_id = ?').get(requestId) as Row | undefined;
    return row === undefined ? null : this.directiveFromRow(row);
  }

  listPendingDirectives(
    opts: {
      jobId?: string;
      state?: DirectiveState;
      states?: readonly DirectiveState[];
      limit?: number;
      cursor?: string;
      /** Integer rowid cursor (reconcile pagination): continues AFTER the
       * given rowid in insertion order. Mutually exclusive with the string
       * request-id cursor. */
      rowidCursor?: number;
    } = {},
  ): readonly DirectiveRequestRecord[] {
    if (opts.state !== undefined && opts.states !== undefined) {
      throw new Error('listPendingDirectives takes either "state" or "states", never both');
    }
    const limit = Math.min(Math.max(1, opts.limit ?? 200), 1000);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.jobId !== undefined) {
      where.push('job_id = ?');
      params.push(opts.jobId);
    }
    if (opts.state !== undefined) {
      where.push('state = ?');
      params.push(opts.state);
    } else if (opts.states !== undefined) {
      if (opts.states.length === 0) {
        throw new Error('listPendingDirectives "states" filter must not be empty');
      }
      for (const state of opts.states) {
        if (!isDirectiveState(state)) throw new Error(`listPendingDirectives got unknown directive state "${state}"`);
      }
      where.push(`state IN (${opts.states.map(() => '?').join(', ')})`);
      params.push(...opts.states);
    }
    if (opts.cursor !== undefined && opts.rowidCursor !== undefined) {
      throw new Error('listPendingDirectives takes either the request-id cursor or the rowid cursor, never both');
    }
    if (opts.cursor !== undefined) {
      where.push('request_id > ?');
      params.push(opts.cursor);
    }
    if (opts.rowidCursor !== undefined) {
      if (!Number.isSafeInteger(opts.rowidCursor) || opts.rowidCursor < 0) {
        throw new Error('listPendingDirectives rowidCursor must be a safe non-negative rowid');
      }
      where.push('rowid > ?');
      params.push(opts.rowidCursor);
    }
    const order = opts.rowidCursor !== undefined ? 'rowid' : 'request_id';
    const sql = `SELECT * FROM pending_directives${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`;
    return (this.db.prepare(sql).all(...(params as never[]), limit) as Row[]).map((row) => this.directiveFromRow(row));
  }

  /** The rowid cursor for one directive request (reconcile pagination
   * anchor). */
  directiveRowid(requestId: string): number | null {
    if (requestId.trim() === '') throw new Error('directiveRowid requires a non-empty requestId');
    const row = this.db.prepare('SELECT rowid AS _rowid FROM pending_directives WHERE request_id = ?').get(requestId) as
      | Row
      | undefined;
    return row === undefined ? null : Number(row._rowid);
  }

  /** Bind a request to its ACTUAL native admission: the correlated
   * `silas.directive-sent` event must exist, carry this request id, sit
   * on this job and postdate the acceptance watermark. Adapter spawn
   * returns, board idle and HTTP 200 prove nothing. */
  recordDirectiveAdmission(input: { requestId: string; minionId: string; eventSeq: number }): DirectiveRequestRecord {
    if (input.minionId.trim() === '') throw new Error('directive admission requires a non-empty minion id');
    return this.transaction(() => {
      const row = this.getDirective(input.requestId);
      if (row === null) throw new RecordNotFound(`directive request "${input.requestId}" not found`);
      if (row.state === 'admitted' && row.admissionSeq === input.eventSeq) return row; // idempotent replay
      if (row.state !== 'dispatching') {
        throw new Error(`directive request "${input.requestId}" is ${row.state} — admission evidence cannot bind here`);
      }
      const event = this.getEvent(input.eventSeq);
      if (event === null) throw new Error(`admission for "${input.requestId}" cites event seq ${input.eventSeq} which does not exist`);
      if (event.kind !== 'silas.directive-sent') {
        throw new Error(`admission for "${input.requestId}" must cite a silas.directive-sent event, got "${event.kind}"`);
      }
      if (event.jobId !== row.jobId) {
        throw new Error(`admission for "${input.requestId}" cites event ${input.eventSeq} of job ${String(event.jobId)} — wrong job`);
      }
      if (event.seq <= row.baselineSeq) {
        throw new Error(`admission for "${input.requestId}" cites event ${input.eventSeq} at/before the acceptance watermark ${row.baselineSeq}`);
      }
      const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
      if (payload['request_id'] !== input.requestId) {
        throw new Error(`admission for "${input.requestId}" cites an event whose payload is not correlated to this request`);
      }
      this.db
        .prepare("UPDATE pending_directives SET state = 'admitted', admission_seq = ?, admission_minion = ?, updated_at = ? WHERE request_id = ?")
        .run(input.eventSeq, input.minionId, nowIso(), input.requestId);
      return this.getDirective(input.requestId) as DirectiveRequestRecord;
    });
  }

  /** Record the request's terminal receipt: the correlated `job.delivered`
   * event must exist, carry this request id, belong to the job and
   * postdate admission. A delivery for another phase/request can never
   * settle this one. */
  recordDirectiveDelivery(input: { requestId: string; eventSeq: number }): DirectiveRequestRecord {
    return this.transaction(() => {
      const row = this.getDirective(input.requestId);
      if (row === null) throw new RecordNotFound(`directive request "${input.requestId}" not found`);
      if (row.state === 'settled' && row.deliverySeq === input.eventSeq) return row; // idempotent replay
      if (row.state !== 'admitted') {
        throw new Error(`directive request "${input.requestId}" is ${row.state} — terminal delivery requires admitted state`);
      }
      const event = this.getEvent(input.eventSeq);
      if (event === null) throw new Error(`delivery for "${input.requestId}" cites event seq ${input.eventSeq} which does not exist`);
      if (event.kind !== 'job.delivered') {
        throw new Error(`delivery for "${input.requestId}" must cite a job.delivered event, got "${event.kind}"`);
      }
      if (event.jobId !== row.jobId) {
        throw new Error(`delivery for "${input.requestId}" cites event ${input.eventSeq} of job ${String(event.jobId)} — wrong job`);
      }
      if (row.admissionSeq !== null && event.seq <= row.admissionSeq) {
        throw new Error(`delivery for "${input.requestId}" cites event ${input.eventSeq} at/before admission ${row.admissionSeq}`);
      }
      const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
      if (payload['request_id'] !== input.requestId) {
        throw new Error(`delivery for "${input.requestId}" cites an event whose payload is not correlated to this request`);
      }
      this.db
        .prepare("UPDATE pending_directives SET state = 'settled', delivery_seq = ?, updated_at = ? WHERE request_id = ?")
        .run(input.eventSeq, nowIso(), input.requestId);
      // Durable action marker: a settlement is machine follow-through and
      // must be visible to health/action projections (issue #163 review).
      this.appendEvent({
        kind: 'silas.directive-settled',
        jobId: row.jobId,
        payload: { request_id: input.requestId, delivery_seq: input.eventSeq },
      });
      return this.getDirective(input.requestId) as DirectiveRequestRecord;
    });
  }

  /** Record a DURABLE failure for a request (positive failure evidence:
   * the router returned an explicit no-delivery proof, or a late turn
   * error surfaced). Never used for "no receipt yet" — that stays
   * dispatching/admitted for reconciliation, visibly, with attempts
   * counted. */
  failDirective(input: { requestId: string; reason: string }): DirectiveRequestRecord {
    if (input.reason.trim() === '') throw new Error('directive failure requires a reason');
    return this.transaction(() => {
      const row = this.getDirective(input.requestId);
      if (row === null) throw new RecordNotFound(`directive request "${input.requestId}" not found`);
      if (row.state === 'settled') {
        throw new Error(`directive request "${input.requestId}" already settled — a late failure cannot rewrite it`);
      }
      if (row.state === 'failed') return row;
      this.db
        .prepare("UPDATE pending_directives SET state = 'failed', fail_reason = ?, attempts = attempts + 1, updated_at = ? WHERE request_id = ?")
        .run(input.reason, nowIso(), input.requestId);
      this.appendEvent({
        kind: 'silas.directive-failed',
        jobId: row.jobId,
        payload: { request_id: input.requestId, reason: input.reason },
      });
      return this.getDirective(input.requestId) as DirectiveRequestRecord;
    });
  }

  /** Bump a request's attempt counter without changing state (durable
   * reconcile passes are bounded and visible; "unknown" never silently
   * becomes "retried"). */
  recordDirectiveReconcile(input: { requestId: string; note: string }): DirectiveRequestRecord {
    return this.transaction(() => {
      const row = this.getDirective(input.requestId);
      if (row === null) throw new RecordNotFound(`directive request "${input.requestId}" not found`);
      if (row.state === 'settled' || row.state === 'failed') return row;
      this.db
        .prepare('UPDATE pending_directives SET attempts = attempts + 1, fail_reason = ?, updated_at = ? WHERE request_id = ?')
        .run(`reconcile: ${input.note}`, nowIso(), input.requestId);
      return this.getDirective(input.requestId) as DirectiveRequestRecord;
    });
  }

  // ------------------------------------------------------------------
  // Durable pipeline queue (owner approvals j-239/j-1064)
  //
  // A complete approved executable briefing persists here BEFORE any
  // worker exists. Only this authenticated boundary writes entries; the
  // state machine keeps every claim atomic (claim before side effect)
  // and every crash reconcilable. The ledger never spawns anything —
  // src/dispatch/pipeline.ts is the mechanical consumer.
  // ------------------------------------------------------------------

  /** Accept one approved executable briefing. A replay of the same
   * request id with the identical canonical payload returns the SAME
   * durable row (created:false); changed content, an occupied id, an
   * occupied job id, or a dependency cycle fails CLOSED. */
  enqueuePipelineEntry(input: {
    id: string;
    requestId?: string;
    repoPath: string;
    title: string;
    briefing: string;
    priority?: number;
    prerequisites?: readonly PipelinePrerequisite[];
    exclusiveScopes?: readonly string[];
    holdReason?: string | null;
    by?: string | null;
  }): { readonly record: PipelineEntryRecord; readonly created: boolean } {
    if (input.repoPath.trim() === '' || input.title.trim() === '' || input.briefing.trim() === '') {
      throw new Error('pipeline enqueue requires a non-empty repo path, title, and briefing');
    }
    requireSafeRecordId(input.id, 'pipeline entry id');
    const priority = input.priority === undefined ? PIPELINE_PRIORITY_DEFAULT : validatePipelinePriority(input.priority);
    const prerequisites = input.prerequisites === undefined ? [] : validatePipelinePrerequisites(input.prerequisites);
    if (prerequisites.some((prerequisite) => prerequisite.id === input.id)) {
      throw new Error(`pipeline entry "${input.id}" cannot depend on itself`);
    }
    const exclusiveScopes = input.exclusiveScopes === undefined ? [] : validateExclusiveScopes(input.exclusiveScopes);
    const holdReason =
      input.holdReason === undefined || input.holdReason === null || input.holdReason.trim() === ''
        ? null
        : input.holdReason.trim().slice(0, 500);
    const requestId = input.requestId === undefined || input.requestId.trim() === '' ? input.id : input.requestId;
    const repo = input.repoPath.split('/').filter(Boolean).pop() ?? input.repoPath;
    // Canonical accepted payload: the briefing is immutable; a changed
    // replay of the same request is a conflict, never an overwrite.
    const canonical = JSON.stringify({
      id: input.id,
      repo_path: input.repoPath,
      repo,
      title: input.title,
      briefing: input.briefing,
      priority,
      prerequisites,
      exclusive_scopes: exclusiveScopes,
      hold_reason: holdReason,
    });
    const payloadHash = createHash('sha256').update(canonical).digest('hex');

    return this.transaction(() => {
      const existingByRequest = this.getPipelineEntryByRequestId(requestId);
      if (existingByRequest !== null) {
        if (existingByRequest.payloadHash !== payloadHash || existingByRequest.id !== input.id) {
          throw new PipelineConflictError(
            `pipeline request "${requestId}" was accepted with different content — ` +
              'an accepted brief is immutable; submit changed work under a new request id',
          );
        }
        return { record: existingByRequest, created: false };
      }
      if (this.getPipelineEntry(input.id) !== null) {
        throw new PipelineConflictError(
          `pipeline entry "${input.id}" already exists — a new request cannot reuse an accepted entry id`,
        );
      }
      if (this.getJob(input.id) !== null) {
        throw new PipelineConflictError(
          `pipeline entry id "${input.id}" collides with an existing job — pick a fresh stable id`,
        );
      }
      if (wouldCreatePipelineCycle(input.id, prerequisites, this.listPipelineEntries())) {
        throw new PipelineConflictError(
          `pipeline prerequisites for "${input.id}" would form a dependency cycle — fix the prerequisites or the entry order`,
        );
      }
      const ts = nowIso();
      const maxRow = this.db.prepare('SELECT COALESCE(MAX(enqueue_seq), 0) AS seq FROM pipeline_entries').get() as Row;
      const enqueueSeq = Number(maxRow.seq) + 1;
      this.db
        .prepare(
          `INSERT INTO pipeline_entries
             (id, repo_path, repo, title, briefing, briefing_hash, priority, enqueue_seq, state,
              hold_reason, prerequisites, exclusive_scopes, request_id, payload_hash, failure_count,
              queued_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          input.id,
          input.repoPath,
          repo,
          input.title,
          input.briefing,
          createHash('sha256').update(input.briefing).digest('hex'),
          priority,
          enqueueSeq,
          holdReason,
          JSON.stringify(prerequisites),
          JSON.stringify(exclusiveScopes),
          requestId,
          payloadHash,
          ts,
          ts,
        );
      this.appendEvent({
        kind: 'pipeline.enqueued',
        payload: {
          entry_id: input.id,
          request_id: requestId,
          priority,
          enqueue_seq: enqueueSeq,
          hold: holdReason !== null,
          briefing_bytes: Buffer.byteLength(input.briefing, 'utf-8'),
          by: input.by ?? null,
        },
      });
      return { record: this.getPipelineEntry(input.id) as PipelineEntryRecord, created: true };
    });
  }

  getPipelineEntry(id: string): PipelineEntryRecord | null {
    const row = this.db.prepare('SELECT * FROM pipeline_entries WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : this.pipelineEntryFromRow(row);
  }

  /** Whether this ledger's schema contains the pipeline table (a ledger
   * frozen before the pipeline migration must keep normal job creation
   * working). Cached: a table never appears after construction. */
  private pipelineTableReady: boolean | null = null;

  private hasPipelineTable(): boolean {
    if (this.pipelineTableReady === null) {
      this.pipelineTableReady =
        this.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pipeline_entries'")
          .get() !== undefined;
    }
    return this.pipelineTableReady;
  }

  private getPipelineEntryByRequestId(requestId: string): PipelineEntryRecord | null {
    const row = this.db.prepare('SELECT * FROM pipeline_entries WHERE request_id = ?').get(requestId) as Row | undefined;
    return row === undefined ? null : this.pipelineEntryFromRow(row);
  }

  /** Every entry in durable enqueue order, optionally state-narrowed. */
  listPipelineEntries(opts: { states?: readonly PipelineState[] } = {}): readonly PipelineEntryRecord[] {
    if (opts.states !== undefined && opts.states.length === 0) {
      throw new Error('listPipelineEntries "states" filter must not be empty');
    }
    const where =
      opts.states === undefined ? '' : ` WHERE state IN (${opts.states.map(() => '?').join(', ')})`;
    const rows = this.db
      .prepare(`SELECT * FROM pipeline_entries${where} ORDER BY enqueue_seq ASC`)
      .all(...(opts.states ?? [])) as Row[];
    return rows.map((row) => this.pipelineEntryFromRow(row));
  }

  /** Atomic admission claim: waiting|ready without a hold becomes
   * `admitting` with the claim persisted BEFORE any side effect. A
   * non-claimable row returns null (never a silent no-op throw); a
   * concurrent claimer loses the race through the WHERE guard. */
  claimPipelineEntry(input: { id: string; holder: string }): PipelineEntryRecord | null {
    if (input.holder.trim() === '') throw new Error('pipeline claim requires a non-empty holder');
    return this.transaction(() => {
      const row = this.getPipelineEntry(input.id);
      if (row === null) throw new RecordNotFound(`pipeline entry "${input.id}" not found`);
      if ((row.state !== 'waiting' && row.state !== 'ready') || row.holdReason !== null) return null;
      const ts = nowIso();
      const info = this.db
        .prepare(
          `UPDATE pipeline_entries
              SET state = 'admitting', claim = ?, claimed_at = ?, updated_at = ?
            WHERE id = ? AND state IN ('waiting','ready') AND hold_reason IS NULL`,
        )
        .run(JSON.stringify({ holder: input.holder, since: ts }), ts, ts, input.id);
      if (Number(info.changes) === 0) return null;
      this.appendEvent({
        kind: 'pipeline.claimed',
        payload: { entry_id: input.id, holder: input.holder },
      });
      return this.getPipelineEntry(input.id) as PipelineEntryRecord;
    });
  }

  /** Bind the claim to the actual job that owns the lifecycle from now
   * on. The job must exist AND carry this entry's exact briefing AND
   * repository — adoption of unrelated work is refused (Perkins r3
   * blocker 1: briefing equality alone is not identity). */
  markPipelineAdmitted(input: { id: string; jobId: string }): PipelineEntryRecord {
    return this.transaction(() => {
      const row = this.getPipelineEntry(input.id);
      if (row === null) throw new RecordNotFound(`pipeline entry "${input.id}" not found`);
      if (row.state === 'admitted' && row.jobId === input.jobId) return row; // idempotent replay
      if (row.state !== 'admitting') {
        throw new Error(`pipeline entry "${input.id}" is ${row.state} — admission requires an admitting claim`);
      }
      const job = this.getJob(input.jobId);
      if (job === null) throw new Error(`pipeline admission for "${input.id}" requires job "${input.jobId}" to exist`);
      if (job.briefing !== row.briefing || job.repo !== row.repo) {
        throw new Error(
          `job "${input.jobId}" does not carry the accepted pipeline entry's briefing/repository — refusing adoption`,
        );
      }
      const ts = nowIso();
      this.db
        .prepare("UPDATE pipeline_entries SET state = 'admitted', job_id = ?, admitted_at = ?, updated_at = ? WHERE id = ?")
        .run(input.jobId, ts, ts, input.id);
      this.appendEvent({ kind: 'pipeline.admitted', payload: { entry_id: input.id, job_id: input.jobId } });
      return this.getPipelineEntry(input.id) as PipelineEntryRecord;
    });
  }

  /** Resolve an admitting claim without an admission. `requeue` counts a
   * failed attempt (returns to waiting); `failed` is the bounded terminal
   * outcome; `reconciled` is the crash path (no failure counted). */
  releasePipelineClaim(input: {
    id: string;
    reason: string;
    outcome: 'requeue' | 'failed' | 'reconciled';
    note?: string | null;
  }): PipelineEntryRecord {
    if (input.reason.trim() === '') throw new Error('pipeline claim release requires a reason');
    return this.transaction(() => {
      const row = this.getPipelineEntry(input.id);
      if (row === null) throw new RecordNotFound(`pipeline entry "${input.id}" not found`);
      if (row.state !== 'admitting') {
        // Idempotent replay of an already-resolved claim.
        if (
          (input.outcome === 'failed' && row.state === 'failed') ||
          (input.outcome !== 'failed' && (row.state === 'waiting' || row.state === 'ready'))
        ) {
          return row;
        }
        throw new Error(`pipeline entry "${input.id}" is ${row.state} — no admitting claim to release`);
      }
      const ts = nowIso();
      if (input.outcome === 'failed') {
        this.db
          .prepare(
            `UPDATE pipeline_entries
                SET state = 'failed', failure_reason = ?, failure_count = failure_count + 1,
                    claim = NULL, updated_at = ?
              WHERE id = ?`,
          )
          .run(input.reason, ts, input.id);
      } else if (input.outcome === 'requeue') {
        this.db
          .prepare(
            `UPDATE pipeline_entries
                SET state = 'waiting', failure_reason = ?, failure_count = failure_count + 1,
                    reconcile_note = ?, claim = NULL, updated_at = ?
              WHERE id = ?`,
          )
          .run(input.reason, input.note ?? null, ts, input.id);
      } else {
        this.db
          .prepare(
            `UPDATE pipeline_entries
                SET state = 'waiting', reconcile_note = ?, claim = NULL, updated_at = ?
              WHERE id = ?`,
          )
          .run(input.note ?? input.reason, ts, input.id);
      }
      this.appendEvent({
        kind:
          input.outcome === 'failed'
            ? 'pipeline.failed'
            : input.outcome === 'requeue'
              ? 'pipeline.requeued'
              : 'pipeline.reconciled',
        payload: { entry_id: input.id, reason: input.reason, ...(input.note != null ? { note: input.note } : {}) },
      });
      return this.getPipelineEntry(input.id) as PipelineEntryRecord;
    });
  }

  /** Persist an eligibility-classified waiting|ready state (the
   * mechanical consumer's normalization); terminal/claim states refuse. */
  setPipelineEntryState(input: {
    id: string;
    state: 'waiting' | 'ready';
    reason?: string | null;
  }): PipelineEntryRecord {
    return this.transaction(() => {
      const row = this.getPipelineEntry(input.id);
      if (row === null) throw new RecordNotFound(`pipeline entry "${input.id}" not found`);
      if (row.state !== 'waiting' && row.state !== 'ready') {
        throw new Error(`pipeline entry "${input.id}" is ${row.state} — only waiting/ready can be normalized`);
      }
      if (row.state === input.state) return row;
      const ts = nowIso();
      this.db.prepare('UPDATE pipeline_entries SET state = ?, updated_at = ? WHERE id = ?').run(input.state, ts, input.id);
      this.appendEvent({
        kind: 'pipeline.state',
        payload: {
          entry_id: input.id,
          from: row.state,
          to: input.state,
          ...(input.reason != null ? { reason: input.reason } : {}),
        },
      });
      return this.getPipelineEntry(input.id) as PipelineEntryRecord;
    });
  }

  /** Explicit owner hold: the entry stays waiting with the reason; no
   * reclaim path bypasses it (only `clearPipelineHold` leaves it, and
   * that is a deliberate supported mutation, never an inferred ACK). */
  holdPipelineEntry(input: { id: string; reason: string; by?: string | null }): PipelineEntryRecord {
    if (input.reason.trim() === '') throw new Error('pipeline hold requires a reason');
    return this.transaction(() => {
      const row = this.getPipelineEntry(input.id);
      if (row === null) throw new RecordNotFound(`pipeline entry "${input.id}" not found`);
      if (row.state === 'admitting') {
        throw new Error(`pipeline entry "${input.id}" has a live admission claim — a hold cannot race it`);
      }
      if (row.state === 'admitted' || row.state === 'failed' || row.state === 'cancelled') {
        throw new Error(`pipeline entry "${input.id}" is ${row.state} — it can no longer be held`);
      }
      const reason = input.reason.trim().slice(0, 500);
      const ts = nowIso();
      this.db
        .prepare("UPDATE pipeline_entries SET hold_reason = ?, state = 'waiting', updated_at = ? WHERE id = ?")
        .run(reason, ts, input.id);
      this.appendEvent({
        kind: 'pipeline.held',
        payload: { entry_id: input.id, reason, by: input.by ?? null },
      });
      return this.getPipelineEntry(input.id) as PipelineEntryRecord;
    });
  }

  /** Deliberate release of an explicit hold (owner decision, not an ACK). */
  clearPipelineHold(input: { id: string; reason?: string | null; by?: string | null }): PipelineEntryRecord {
    return this.transaction(() => {
      const row = this.getPipelineEntry(input.id);
      if (row === null) throw new RecordNotFound(`pipeline entry "${input.id}" not found`);
      if (row.state !== 'waiting' && row.state !== 'ready') {
        throw new Error(`pipeline entry "${input.id}" is ${row.state} — only a waiting/ready hold can be cleared`);
      }
      if (row.holdReason === null) return row; // idempotent
      const ts = nowIso();
      this.db.prepare('UPDATE pipeline_entries SET hold_reason = NULL, updated_at = ? WHERE id = ?').run(ts, input.id);
      this.appendEvent({
        kind: 'pipeline.hold-cleared',
        payload: { entry_id: input.id, reason: input.reason ?? null, by: input.by ?? null },
      });
      return this.getPipelineEntry(input.id) as PipelineEntryRecord;
    });
  }

  /** Terminal cancellation before/without an admission claim. A live
   * admission claim is never cancelled out from under its dispatch. */
  cancelPipelineEntry(input: { id: string; reason: string; by?: string | null }): PipelineEntryRecord {
    if (input.reason.trim() === '') throw new Error('pipeline cancellation requires a reason');
    return this.transaction(() => {
      const row = this.getPipelineEntry(input.id);
      if (row === null) throw new RecordNotFound(`pipeline entry "${input.id}" not found`);
      if (row.state === 'cancelled') return row; // idempotent
      if (row.state === 'admitting') {
        throw new Error(`pipeline entry "${input.id}" has a live admission claim — reconciliation owns it`);
      }
      if (row.state === 'failed') {
        // Terminal failure is durable history: overwriting it with a
        // cancellation would erase the exact failure reason downstream
        // dependents (and their diagnosis) were recorded against.
        throw new Error(
          `pipeline entry "${input.id}" already failed terminally — its failure record is preserved; supersede it with a fresh request`,
        );
      }
      if (row.state === 'admitted') {
        throw new Error(`pipeline entry "${input.id}" is admitted — its job lifecycle owns it now`);
      }
      const ts = nowIso();
      this.db
        .prepare(
          "UPDATE pipeline_entries SET state = 'cancelled', hold_reason = NULL, failure_reason = ?, updated_at = ? WHERE id = ?",
        )
        .run(input.reason.trim().slice(0, 500), ts, input.id);
      this.appendEvent({
        kind: 'pipeline.cancelled',
        payload: { entry_id: input.id, reason: input.reason, by: input.by ?? null },
      });
      return this.getPipelineEntry(input.id) as PipelineEntryRecord;
    });
  }

  /** Board projection (server-computed, evidence-bound): every active
   * entry (waiting/ready/admitting/failed), evaluated against the live
   * job statuses, durable delivery/worker-start proofs and shared
   * capacity, in the approved deterministic order. Admitted/cancelled
   * entries are excluded — admitted work lives in the normal job
   * lifecycle, cancelled work is terminal. No briefings. `pending` counts
   * executable work only (waiting + ready + admitting); terminal `failed`
   * rows stay visible as attention, never as pending. */
  pipelineBoardView(capacity: PipelineEvaluationContext['capacity']): PipelineBoardView {
    const entries = this.listPipelineEntries();
    const ctx: PipelineEvaluationContext = {
      entries,
      jobStatusOf: (jobId) => this.getJob(jobId)?.status ?? null,
      jobDeliveredOf: (jobId) => this.latestJobEvent(jobId, 'job.delivered') !== null,
      jobStartedOf: (jobId) => this.jobHasWorkerStart(jobId),
      capacity,
    };
    const rows: PipelineEntryBoardView[] = entries
      .filter((entry) => entry.state !== 'admitted' && entry.state !== 'cancelled')
      .map((entry) => {
        const evaluation = evaluatePipelineEntry(entry, ctx);
        return {
          id: entry.id,
          repo: entry.repo,
          title: entry.title,
          priority: entry.priority,
          enqueueSeq: entry.enqueueSeq,
          state: evaluation.state,
          reason: evaluation.reason,
          queuedAt: entry.queuedAt,
        };
      })
      .sort((left, right) =>
        pipelineOrder(
          { priority: left.priority, enqueueSeq: left.enqueueSeq, id: left.id },
          { priority: right.priority, enqueueSeq: right.enqueueSeq, id: right.id },
        ),
      );
    return {
      entries: rows,
      pending: rows.filter((row) => row.state !== 'failed').length,
    };
  }

  /** Durable minion-start evidence for a job: a job-bound TOP-LEVEL
   * minion agent row (real dispatch registers exactly that identity after
   * a successful spawn — `role='minion'`, `parentage='top-level'`) or a
   * recorded `job.minion-spawned` event. Neither a worktree row (created
   * BEFORE spawning, retained swept on failure), nor a job-bound Perkins
   * reviewer row, nor an unstarted child identity counts as a started
   * worker (Perkins r1/r2 blocker 1). Public: the mechanical pipeline
   * consumer builds the same evidence context as the board projection. */
  jobHasWorkerStart(jobId: string): boolean {
    const agent = this.db
      .prepare("SELECT id FROM agents WHERE job_id = ? AND role = 'minion' AND parentage = 'top-level' LIMIT 1")
      .get(jobId) as Row | undefined;
    if (agent !== undefined) return true;
    return this.latestJobEvent(jobId, 'job.minion-spawned') !== null;
  }

  private pipelineEntryFromRow(row: Row): PipelineEntryRecord {
    const state = str(row.state);
    if (!isPipelineState(state)) throw new Error(`pipeline_entries row "${str(row.id)}" has unknown state "${state}"`);
    return {
      id: str(row.id),
      repoPath: str(row.repo_path),
      repo: str(row.repo),
      title: str(row.title),
      briefing: str(row.briefing),
      briefingHash: str(row.briefing_hash),
      priority: Number(row.priority),
      enqueueSeq: Number(row.enqueue_seq),
      state,
      holdReason: nstr(row.hold_reason),
      prerequisites: parsePipelinePrerequisites(str(row.prerequisites)),
      exclusiveScopes: parseExclusiveScopes(str(row.exclusive_scopes)),
      requestId: str(row.request_id),
      payloadHash: str(row.payload_hash),
      jobId: nstr(row.job_id),
      claim: parsePipelineClaim(nstr(row.claim)),
      failureReason: nstr(row.failure_reason),
      failureCount: Number(row.failure_count),
      reconcileNote: nstr(row.reconcile_note),
      queuedAt: str(row.queued_at),
      claimedAt: nstr(row.claimed_at),
      admittedAt: nstr(row.admitted_at),
      updatedAt: str(row.updated_at),
    };
  }

  private directiveFromRow(row: Row): DirectiveRequestRecord {
    const state = str(row.state);
    if (!isDirectiveState(state)) throw new Error(`pending_directives row "${str(row.request_id)}" has unknown state "${state}"`);
    let claim: { holder: string; since: string } | null = null;
    if (row.claim !== null && row.claim !== undefined) {
      const parsed = JSON.parse(str(row.claim)) as Record<string, unknown>;
      const holder = parsed['holder'];
      const since = parsed['since'];
      if (typeof holder !== 'string' || holder === '' || typeof since !== 'string' || since === '') {
        throw new Error(`pending_directives row "${str(row.request_id)}" has a malformed claim`);
      }
      claim = { holder, since };
    }
    return {
      requestId: str(row.request_id),
      jobId: str(row.job_id),
      payload: str(row.payload),
      payloadHash: str(row.payload_hash),
      state,
      baselineSeq: Number(row.baseline_seq),
      claim,
      admissionSeq: row.admission_seq === null || row.admission_seq === undefined ? null : Number(row.admission_seq),
      admissionMinion: nstr(row.admission_minion),
      deliverySeq: row.delivery_seq === null || row.delivery_seq === undefined ? null : Number(row.delivery_seq),
      attempts: Number(row.attempts),
      failReason: nstr(row.fail_reason),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }
  private pendingProviderRecoveryFromRow(row: Row): PendingProviderRecoveryRecord {
    return {
      id: str(row.id),
      routeKey: str(row.route_key),
      incidentGeneration: Number(row.incident_generation),
      evidence: str(row.evidence),
      createdAt: str(row.created_at),
    };
  }

  private pendingRebriefFromRow(row: Row): PendingRebriefRecord {
    const kind = str(row.kind);
    if (!isPendingRebriefKind(kind)) {
      throw new Error(`pending_rebriefs row has unknown kind "${kind}"`);
    }
    let payload: { note?: unknown; briefing?: unknown };
    try {
      payload = JSON.parse(str(row.payload)) as { note?: unknown; briefing?: unknown };
    } catch (error) {
      throw new Error(`pending_rebriefs row ${str(row.id)} payload is not valid JSON: ${String(error)}`);
    }
    return {
      id: str(row.id),
      jobId: str(row.job_id),
      kind,
      note: nstr(payload.note),
      briefing: nstr(payload.briefing),
      payloadHash: str(row.payload_hash),
      baselineSeq: Number(row.baseline_seq),
      agentId: nstr(row.agent_id),
      sessionFile: nstr(row.session_file),
      phaseId: nstr(row.phase_id),
      requestedAt: str(row.requested_at),
    };
  }

  // ------------------------------------------------------------------
  // Decision memory (issue #218) — typed holds and dispositions.
  // ------------------------------------------------------------------

  /** Record a decision (hold/disposition) on a subject. Idempotent on
   * `clientKey`: a retry with the same key and the same canonical content
   * returns the ORIGINAL row (no second row, no second event); the same
   * key with changed content throws DecisionConflictError — a recorded
   * decision is history, not a mutable slot. Appends `decision.recorded`. */
  recordDecision(
    input: {
      subject: string;
      decision: DecisionKind;
      covers: readonly string[];
      basisFingerprint?: string | null;
      reason: string;
      by: DecisionActor;
      clientKey?: string;
      recheckAt?: string | null;
    },
  ): DecisionRecord {
    const canonical: CanonicalDecisionInput = canonicalizeDecisionInput(input);
    return this.transaction(() => {
      if (input.clientKey !== undefined) {
        const existing = this.decisionByClientKey(input.clientKey);
        if (existing !== null) {
          this.assertDecisionReplayMatches(existing, canonical, input.clientKey);
          return existing;
        }
      }
      const id = randomUUID();
      // Monotonic created_at: two decisions inside one millisecond still
      // order newest-first (created_at DESC, id ASC tie-breaks on random
      // uuids) — the trigger query's "newest matching decision wins" must
      // be deterministic, and the bounded-retry backlog must not invert.
      const latest = this.db.prepare('SELECT MAX(created_at) AS ts FROM decisions').get() as Row | undefined;
      const latestTs = latest?.ts === undefined || latest.ts === null ? null : str(latest.ts);
      let ts = nowIso();
      if (latestTs !== null && ts <= latestTs) {
        ts = new Date(Date.parse(latestTs) + 1).toISOString();
      }
      this.db
        .prepare(
          `INSERT INTO decisions
             (id, subject, decision, covers, basis_fingerprint, reason, by, client_key, created_at, recheck_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          canonical.subject,
          canonical.decision,
          JSON.stringify(canonical.covers),
          canonical.basisFingerprint,
          canonical.reason,
          canonical.by,
          input.clientKey ?? null,
          ts,
          canonical.recheckAt,
        );
      this.appendEvent({
        kind: 'decision.recorded',
        payload: {
          id,
          subject: canonical.subject,
          decision: canonical.decision,
          covers: canonical.covers,
          basis_fingerprint: canonical.basisFingerprint,
          by: canonical.by,
          recheck_at: canonical.recheckAt,
        },
      });
      return this.getDecision(id) as DecisionRecord;
    });
  }

  /** Clear a decision (the subject re-opens). Unknown ids throw a typed
   * RecordNotFound; an already-cleared decision is an idempotent no-op
   * (the FIRST clearing is history — a repeat never re-stamps it).
   * Appends `decision.cleared`. */
  clearDecision(input: { id: string; by: DecisionActor; reason: string }): DecisionRecord {
    if (!isDecisionActor(input.by)) {
      throw new Error(`unknown decision actor "${String(input.by)}" — expected one of ${DECISION_ACTORS.join(', ')}`);
    }
    validateDecisionReason(input.reason);
    return this.transaction(() => {
      const current = this.getDecision(input.id);
      if (current === null) throw new RecordNotFound(`decision "${input.id}" not found`);
      if (current.clearedAt !== null) return current;
      const ts = nowIso();
      this.db
        .prepare('UPDATE decisions SET cleared_at = ?, cleared_by = ?, cleared_reason = ? WHERE id = ?')
        .run(ts, input.by, input.reason, input.id);
      this.appendEvent({
        kind: 'decision.cleared',
        payload: { id: input.id, subject: current.subject, by: input.by, reason: input.reason },
      });
      return this.getDecision(input.id) as DecisionRecord;
    });
  }

  /** List decisions, newest first. `activeOnly` keeps the covering
   * candidates (not cleared); `subject` narrows to one key; `offset`
   * pages (the covering query walks pages to exhaustion). Bounded.
   * Same-millisecond creates tie-break by INSERTION order (rowid DESC) —
   * a random id would make "newest" nondeterministic. */
  listDecisions(opts: { subject?: string; activeOnly?: boolean; limit?: number; offset?: number } = {}): readonly DecisionRecord[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 1000);
    const offset = Math.max(0, opts.offset ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('decision page offset must be non-negative');
    }
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.subject !== undefined) {
      where.push('subject = ?');
      params.push(opts.subject);
    }
    if (opts.activeOnly === true) where.push('cleared_at IS NULL');
    const sql = `SELECT * FROM decisions${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`;
    return (this.db.prepare(sql).all(...(params as never[]), limit, offset) as Row[]).map((row) =>
      this.decisionFromRow(row),
    );
  }

  /** Count decisions (`activeOnly` = not cleared) — the board pairs its
   * bounded activeDecisions window with this truthful total so a hidden
   * overflow is visible, never silent. */
  countDecisions(opts: { activeOnly?: boolean } = {}): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM decisions${opts.activeOnly === true ? ' WHERE cleared_at IS NULL' : ''}`)
      .get() as Row;
    return Number(row.n);
  }

  getDecision(id: string): DecisionRecord | null {
    const row = this.db.prepare('SELECT * FROM decisions WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : this.decisionFromRow(row);
  }

  /** THE trigger query (issue #218): is signal `signal` on `subject`
   * covered by an active decision whose basis still matches at `now`?
   * Only the NEWEST active decision that lists the signal in `covers` is
   * the candidate: if it fails (basis moved, recheck passed) the subject
   * is NOT covered — an older, broader hold on the same subject+signal
   * must never shadow the re-open a newer decision promised. The scan is
   * exhaustive for the subject (pages to the end): coverage is the
   * correctness-critical read, so it is never truncated by a listing
   * window. Returns a decision only when ALL of these hold:
   * - it is not cleared;
   * - its `covers` include `signal`;
   * - its `basis_fingerprint` is null or equals `basis` (a changed basis
   *   re-opens the subject);
   * - its `recheck_at` is null or later than `now` (a passed recheck
   *   re-opens the subject). */
  coveringDecision(opts: { subject: string; signal: string; basis: string; now?: string }): DecisionRecord | null {
    if (opts.signal.length === 0) throw new Error('coveringDecision "signal" must be non-empty');
    if (opts.basis.length === 0) throw new Error('coveringDecision "basis" must be non-empty');
    const nowMs = Date.parse(opts.now ?? nowIso());
    if (!Number.isFinite(nowMs)) throw new Error(`coveringDecision "now" must be a parseable timestamp, got "${String(opts.now)}"`);
    validateDecisionSignal(opts.signal);
    // Page to exhaustion: a hold older than any single listing window
    // must still be found (bounded per subject, newest first).
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const page = this.listDecisions({ subject: opts.subject, activeOnly: true, limit: pageSize, offset });
      for (const row of page) {
        if (!row.covers.includes(opts.signal)) continue;
        if (row.basisFingerprint !== null && row.basisFingerprint !== opts.basis) return null;
        if (row.recheckAt !== null) {
          const recheckMs = Date.parse(row.recheckAt);
          if (!Number.isFinite(recheckMs)) {
            throw new Error(`decision "${row.id}" carries an unparseable recheck_at "${row.recheckAt}"`);
          }
          if (recheckMs <= nowMs) return null;
        }
        return row;
      }
      if (page.length < pageSize) return null;
    }
  }

  private decisionByClientKey(clientKey: string): DecisionRecord | null {
    const row = this.db.prepare('SELECT * FROM decisions WHERE client_key = ?').get(clientKey) as Row | undefined;
    return row === undefined ? null : this.decisionFromRow(row);
  }

  /** A client_key replay must carry the SAME canonical decision — else it
   * is a conflict, never a silent replacement of the recorded hold. */
  private assertDecisionReplayMatches(existing: DecisionRecord, canonical: CanonicalDecisionInput, clientKey: string): void {
    const same =
      existing.subject === canonical.subject &&
      existing.decision === canonical.decision &&
      existing.covers.join('\u0000') === canonical.covers.join('\u0000') &&
      existing.basisFingerprint === canonical.basisFingerprint &&
      existing.reason === canonical.reason &&
      existing.by === canonical.by &&
      existing.recheckAt === canonical.recheckAt;
    if (!same) {
      throw new DecisionConflictError(
        `decision client_key "${clientKey}" was already recorded as a different decision (id "${existing.id}") — a recorded decision is history; use a new key`,
      );
    }
  }

  private decisionFromRow(row: Row): DecisionRecord {
    return decisionFromRowValues({
      id: str(row.id),
      subject: str(row.subject),
      decision: str(row.decision),
      covers: str(row.covers),
      basis_fingerprint: nstr(row.basis_fingerprint),
      reason: str(row.reason),
      by: str(row.by),
      client_key: nstr(row.client_key),
      created_at: str(row.created_at),
      recheck_at: nstr(row.recheck_at),
      cleared_at: nstr(row.cleared_at),
      cleared_by: nstr(row.cleared_by),
      cleared_reason: nstr(row.cleared_reason),
    });
  }

  private notificationFromRow(row: Row): NotificationRecord {
    return {
      id: str(row.id),
      ts: str(row.ts),
      kind: str(row.kind),
      routing: str(row.routing) as NotificationRouting,
      severity: str(row.severity) as NotificationSeverity,
      title: str(row.title),
      detail: nstr(row.detail),
      agentId: nstr(row.agent_id),
      shownAt: nstr(row.shown_at),
      shownBy: nstr(row.shown_by),
      ackedAt: nstr(row.acked_at),
      ackedBy: nstr(row.acked_by),
      resolvedAt: nstr(row.resolved_at),
      resolvedBy: nstr(row.resolved_by),
    };
  }
}
