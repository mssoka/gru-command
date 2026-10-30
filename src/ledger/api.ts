import { projectMailbox, mailboxBasis } from '../gru-mailbox/projection.js';
import { MailboxConflictError, validateMailboxDisposition, type MailboxItem, type MailboxDelivery, type MailboxReceipt, type MailboxDisposition } from './mailbox.js';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { hostname } from 'node:os';
import { loadWorktreeManifest, resolveVerifyCommand } from '../worktrees/manifest.js';
import { HANDOFF_REBOUND_KIND, REPO_MOVED_KIND, type LaneRebind } from '../worktrees/handoff.js';
import { newLaneToken } from '../worktrees/lane-provenance.js';
import { isCommitId, readOnboardingProof } from '../onboarding/proof-record.js';
import { readGitState } from '../verify/scheduler.js';
import { planCommand } from '../verify/build-reuse.js';
import { FROZEN_MANIFEST_MAX_BYTES, readReviewCheckpointBytes, type FrozenReviewInputs } from '../dispatch/perkins-review/artifacts.js';
import { canonicalRebriefEvidence, type RebriefReceiptEvidence } from './rebrief-evidence.js';
import type { RecoverySubject, RecoverySubjectKind, RecoveryOwnerTransfer, RecoveryDecisionHistory, RecoveryOwnerActionInput } from './recovery-owner.js';
import type { IntakeReviewRecord } from '../intake/types.js';
import { canonical as canonicalIntake, digest as intakeDigest, IntakeError } from '../intake/types.js';
import type { DatabaseSync } from 'node:sqlite';
import type { BusEvent, EventBus } from '../events/bus.js';
import type { Role } from '../config.js';
import type { WorktreeLane } from '../dispatch/worktree-port.js';
import type { AgentState } from '../runtime/types.js';
import { isDeepStrictEqual } from 'node:util';
import { DirectiveCheckpointError, directiveProducerLockBlocker, directiveSessionLockBlocker, inspectDirectiveAdmission, inspectDirectiveCheckpoint, inspectDirectiveProducers, readDirectiveBinding, readDirectiveCompletion, readDirectiveSessionHeader, validateDirectiveIdentity, type DirectiveNativeBinding, type DirectiveProducer, type DirectiveTurnIdentity } from '../runtime/directive-checkpoint.js';
import {
  assertAdminCloseoutTransition,
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
  type TerminalJobStatus,
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
  deliveredWorkRevision,
  isAmendmentEffect,
  renderEffectiveContract,
  requiredWorkRevision,
  validateAmendmentDraft,
  type AmendmentEffect,
  type EffectiveContract,
  type JobAmendmentApproval,
  type JobAmendmentRecord,
  type WorkRevisionState,
} from '../review-inputs/amendments.js';
import {
  parseDecisionOptions,
  parseStoredNotificationDecision,
  producerWithdrawable,
  serializeNotificationDecision,
  type NotificationDecision,
  type NotificationDecisionOption,
} from './notification-decision.js';
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
  directiveAdmissionClass,
  DIRECTIVE_RETIREMENT_CONTEXT,
  directiveRetirementFingerprint,
  directiveRetirementHasContext,
  DirectiveRetirementError,
  directiveStateName,
  isProducerCustodyUncertainty,
  isDirectiveState,
  isDirectiveTerminal,
  LIVE_DIRECTIVE_STATES,
  type DirectiveRecoveryHold,
  type DirectiveRequestRecord,
  type DirectiveState,
  type DirectiveRetirementIntent,
  type LiveDirectiveState,
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
import {
  CLOSEOUT_ACTOR,
  closeoutBlockerFingerprint,
  CloseoutPendingError,
  hasActiveCloseout,
  insertCloseout,
  nextCloseoutGeneration,
  selectActiveCloseoutForJob,
  selectActiveCloseoutForRequest,
  selectActiveCloseoutIds,
  selectCloseout,
  selectLatestCloseoutForJob,
  selectLatestCloseoutForRequest,
  TerminalLiveWorkError,
  updateCloseoutState,
  type CloseoutBlocker,
  type CloseoutIntent,
  type CloseoutRequester,
  type CloseoutSupersededReason,
} from './closeouts.js';
import {
  insertOwnerApproval,
  OWNER_APPROVAL_CARD_KIND,
  OWNER_APPROVAL_ENDINGS,
  OWNER_APPROVAL_MAX_ATTEMPTS,
  ownerApprovalEventKind,
  ownerApprovalFingerprint,
  selectActiveOwnerApprovalForRequest,
  selectActiveOwnerApprovalIds,
  selectEndedOwnerApprovalIdsWithOpenCard,
  selectOwnerApproval,
  selectOwnerApprovalByKey,
  selectOwnerApprovalByNotification,
  updateOwnerApproval,
  type OwnerApprovalFences,
  type OwnerApprovalHistoryEntry,
  type OwnerApprovalKind,
  type OwnerApprovalOutcome,
  type OwnerApprovalProposal,
  type OwnerApprovalRecord,
} from './owner-approvals.js';

const VERIFICATION_KIND = 'verification.completed';
const MAX_REBRIEF_RECEIPT_EVIDENCE_EVENTS = 4_096;
const MAX_REBRIEF_RECEIPT_EVIDENCE_BYTES = 8 * 1024 * 1024;
// Native process readback retains the same complete-receipt inspection bounds.
const MAX_VERIFICATION_PROCESS_RECEIPT_EVENTS = MAX_REBRIEF_RECEIPT_EVIDENCE_EVENTS;
const MAX_VERIFICATION_PROCESS_RECEIPT_BYTES = MAX_REBRIEF_RECEIPT_EVIDENCE_BYTES;
export type { JobStatus, RoundStatus, RoundVerdict, LensState } from './states.js';
export type { DirectiveRecoveryHold, DirectiveRequestRecord, DirectiveRetirementRefusalCode, DirectiveState } from './directives.js';
export { DirectiveRetirementError } from './directives.js';
export type { CloseoutBlocker, CloseoutIntent, CloseoutState, CloseoutSupersededReason } from './closeouts.js';
export { CloseoutPendingError, TerminalLiveWorkError } from './closeouts.js';
export type {
  OwnerApprovalFences,
  OwnerApprovalHistoryEntry,
  OwnerApprovalKind,
  OwnerApprovalOutcome,
  OwnerApprovalProposal,
  OwnerApprovalRecord,
  OwnerApprovalRefusal,
  OwnerApprovalState,
} from './owner-approvals.js';
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
  /** The job whose minion commissioned this one (a megaminion's parent
   * heist). One level deep. `null` = a top-level job, or a ledger older
   * than migration job-parent. */
  readonly parentJobId: string | null;
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

export type CreationContinuationState =
  | 'accepted'
  | 'queued'
  | 'admitted'
  | 'delivered'
  | 'failed'
  | 'refused'
  | 'custody-unknown';

function isCreationContinuationState(value: unknown): value is CreationContinuationState {
  return value === 'accepted' || value === 'queued' || value === 'admitted' || value === 'delivered' ||
    value === 'failed' || value === 'refused' || value === 'custody-unknown';
}

/** Immutable identity of one same-job retained initial-creation request. */
export interface CreationContinuationIdentity {
  readonly jobId: string;
  readonly requestId: string;
  readonly generation: number;
  readonly payloadSha256: string;
  readonly handoffSeq: number | null;
  readonly briefingSha256: string | null;
  readonly handoffRepoPath: string | null;
  readonly repoPath: string | null;
  readonly branch: string | null;
  readonly baseSha: string | null;
  readonly baseSource: WorktreeBaseSource | null;
  readonly producerSettlementSeq: number | null;
  readonly receiptTokenSha256: string | null;
}

export interface CreationContinuationTimeline {
  readonly identity: CreationContinuationIdentity;
  readonly events: readonly EventRecord[];
  readonly state: CreationContinuationState;
}

export class CreationContinuationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreationContinuationConflictError';
  }
}

/** The job-level scope of a creation continuation, the route's and the
 * ledger's alike. Returns the refusal, or null. */
export function creationContinuationJobRefusal(job: JobRecord): string | null {
  if (job.status !== 'blocked') return `job "${job.id}" is ${job.status}, not blocked`;
  if (job.deliverable !== null && job.deliverable !== 'pr') return `job "${job.id}" is not a PR-owing initial dispatch`;
  if (job.prUrl !== null || job.targetRef !== null || job.targetSha !== null) {
    return `job "${job.id}" has report or pull-request state incompatible with initial-creation continuation`;
  }
  if (job.briefing === null || job.briefing.trim() === '') return `job "${job.id}" has no original briefing to reuse`;
  return null;
}

/** The one repository rule for a creation continuation, the route's and
 * the ledger's alike: the handoff path's own leaf is the job's recorded
 * repository (dispatch derived it so, a symlinked path included), and the
 * path resolves to the inspected repository (`repoPath`; null before
 * inspection). Returns the refusal, or null. */
export function creationContinuationRepoMismatch(job: Pick<JobRecord, 'id' | 'repo'>, handoffRepoPath: string, repoPath: string | null): string | null {
  const leaf = handoffRepoPath.split('/').filter(Boolean).at(-1) ?? '';
  if (leaf !== job.repo) return `job "${job.id}" records repository "${job.repo}", but its handoff path ${handoffRepoPath} names "${leaf}"`;
  if (repoPath === null) return null;
  let canonical: string;
  try {
    canonical = realpathSync(handoffRepoPath);
  } catch (error) {
    return `job "${job.id}" handoff path ${handoffRepoPath} cannot be resolved: ${error instanceof Error ? error.message : String(error)}`;
  }
  return canonical === repoPath ? null : `job "${job.id}" handoff path ${handoffRepoPath} resolves to ${canonical}, not the inspected repository ${repoPath}`;
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

/** Why an onboarding heist owes a proof (#427 PR 1b):
 * - `no-delivery`: the job has not delivered, so there is no head yet;
 * - `no-commit`: the newest delivery names no full commit id (or is not a
 *   proven current candidate), so the minion must deliver again;
 * - `unproven`: the head has no proof yet;
 * - `failed`: the head's first proof failed, or its record is unreadable
 *   (a record no reader can read is never a pass);
 * - `uncommitted`: the lane holds uncommitted changes the proof never ran,
 *   which the bmad-review fallback would review (set by the fallback's
 *   lane check, never by the ledger). */
export type OnboardingProofDebtReason = 'no-delivery' | 'no-commit' | 'unproven' | 'failed' | 'uncommitted';

/** An onboarding heist's unproven head (#427 PR 1b): the head review waits
 * on (null for `no-delivery` and `no-commit`) and why it waits. */
export interface OnboardingProofDebt {
  readonly head: string | null;
  readonly reason: OnboardingProofDebtReason;
  /** For `uncommitted`: a path the lane's bootstrap placed that is no
   * longer what it placed, named with what may have changed it. */
  readonly detail?: string;
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

/** Alerts only their producer closes (owner decision 2026-10-08): a failing
 * lesson dream's incident resolves when a dream pass completes. A Gru
 * disposition would close it while nothing recovered — and restart the
 * failure streak at pass 1 on the next failing beat. Value: what closes it. */
const PRODUCER_RESOLVED_KINDS: Readonly<Record<string, string>> = {
  'lessons.dream-failed': 'a completed dream pass',
  // #427: the row drives onboarding's retry; a disposition would stop it.
  'onboarding.dispatch-failed': 'a dispatched onboarding heist, or a scan that finds none is needed',
  // #427 PR 1b: one row per stuck (job, head); onboarding closes it.
  'onboarding.proof-attention': 'a passing proof, a newer delivered head, or the onboarding job ending',
  // #427 PR 1b: a crashed proof's verify slot the boot judge kept; onboarding closes it.
  'onboarding.proof-slot-held': 'the slot being released',
  // #427 PR 2a: one row per lane and digest; the lane's sweep (any path) closes it.
  'worktree.submodule-work': 'the lane being swept or gone, or a refusal of it with a newer digest',
  // #427 PR 2a: one row per lane whose setup did not recreate what it made.
  'worktree.restore-incomplete': 'the lane being swept or gone',
  // #427 PR 2a: one row per lane whose release a sparse checkout refuses.
  'worktree.sparse-checkout': 'the lane being swept or gone',
  // #427 PR 3: over the disk budget or under the floor with nothing GC can free.
  'disk.nothing-to-free': 'GC\'s usage being under its budget and the disk\'s free space at or above the floor',
  // #427 PR 3: [worktrees] min_free_disk_gb at or above a watched disk's size.
  'disk.floor-impossible': 'the floor fitting the disks it watches (a config change and a restart)',
};

// The alias d is an immutable delivery. A protected root must cite its
// complete original bytes and a genuinely settled native row/duty. Binding
// and identity object key order cannot hide a candidacy refusal.
const ORIGINAL_NATIVE_GATE_DEBT_SQL = `EXISTS (SELECT 1 FROM events r
  WHERE r.job_id = d.job_id AND r.kind = 'silas.directive-current-gates-owed' AND r.seq > d.seq
    AND json_extract(r.payload, '$.root_kind') = 'original-native-completion' AND json_extract(r.payload, '$.delivery_seq') = d.seq
    AND json_extract(r.payload, '$.request_id') = json_extract(d.payload, '$.request_id')
    AND json_extract(r.payload, '$.native_completion') = d.payload
    AND json_extract(r.payload, '$.sha') IS json_extract(d.payload, '$.sha')
    AND EXISTS (SELECT 1 FROM pending_directives p JOIN job_obligations o ON o.id = json_extract(r.payload, '$.obligation_id')
      WHERE p.request_id = json_extract(r.payload, '$.request_id') AND p.job_id = d.job_id AND p.delivery_seq = d.seq AND p.state = 'settled'
        AND p.native_binding IS NOT NULL AND p.payload_hash = json_extract(r.payload, '$.identity.payloadHash')
        AND p.contract_sha256 = json_extract(r.payload, '$.identity.contractSha256') AND p.work_revision = json_extract(r.payload, '$.identity.workRevision')
        AND p.authority_epoch = json_extract(r.payload, '$.identity.authorityEpoch') AND p.job_id = json_extract(r.payload, '$.identity.jobId')
        AND p.request_id = json_extract(r.payload, '$.identity.requestId')
        AND o.job_id = d.job_id AND o.incident_key = 'directive-current-gates:' || p.request_id AND o.generation = json_extract(r.payload, '$.generation')
        AND o.first_origin_seq = d.seq AND o.next_action = json_extract(r.payload, '$.next_action')))`;

// A modern delivery requires the ledger's independently checked settlement
// decision. Later obligation generations cannot turn a rejected publisher
// flag into eligibility. Old/missing modern decisions remain unproven.
const UNPROVEN_NATIVE_CANDIDATE_SQL = `EXISTS (SELECT 1 FROM pending_directives p WHERE p.job_id = d.job_id
  AND p.request_id = json_extract(d.payload, '$.request_id') AND p.request_kind IS NOT NULL
  AND (p.state != 'settled' OR p.delivery_seq IS NOT d.seq OR COALESCE((SELECT json_extract(s.payload, '$.candidate_delivery_proven')
    FROM events s WHERE s.job_id = d.job_id AND s.kind = 'silas.directive-settled'
      AND json_extract(s.payload, '$.request_id') = p.request_id AND json_extract(s.payload, '$.delivery_seq') = d.seq
    ORDER BY s.seq DESC LIMIT 1), 0) != 1))`;

/** Why a machine disposition of this notification is refused, or null. */
function machineDispositionRefusalOf(current: Pick<NotificationRecord, 'kind' | 'routing'>): string | null {
  if (current.routing !== 'action-required') {
    return 'only action-required notifications accept a machine disposition; owner decisions resolve through the recorded-decision follow-through';
  }
  const closer = producerResolvedBy(current.kind);
  return closer === null ? null : `${current.kind} closes itself on ${closer} — fix its cause and leave the alert open; a disposition is refused`;
}

/** What closes a producer-resolved alert kind, or null for any other kind. */
export function producerResolvedBy(kind: string): string | null {
  return Object.hasOwn(PRODUCER_RESOLVED_KINDS, kind) ? PRODUCER_RESOLVED_KINDS[kind]! : null;
}

export function isNotificationRouting(value: string): value is NotificationRouting {
  return (NOTIFICATION_ROUTINGS as readonly string[]).includes(value);
}

export function isNotificationSeverity(value: string): value is NotificationSeverity {
  return (NOTIFICATION_SEVERITIES as readonly string[]).includes(value);
}

/** Who authenticated a notification decision/disposition and which actor
 * (if any) it declared (decision #99: a shared bearer proves only a paired
 * caller, never an actor). */
export interface NotificationProvenance {
  readonly credential: string;
  readonly declaredActor: string | null;
}

/** A machine disposition the row cannot take (not action-required, or a
 * kind that closes itself): the board route answers it as a typed
 * `409 disposition_refused` (#385). */
export class MachineDispositionRefusedError extends Error {
  constructor(readonly notificationId: string, readonly refusal: string) {
    super(refusal);
    this.name = 'MachineDispositionRefusedError';
  }
}

/** One alert closes ONE stop (#385): a replay of a recorded closure naming
 * another agent or job. */
export class SupervisionStopClosureConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupervisionStopClosureConflictError';
  }
}

/** A notification decision/disposition/adoption was asked to record a blank
 * credential class: a programming error at the caller (every route supplies
 * one), refused before anything is written (#396). */
export class BlankProvenanceCredentialError extends Error {
  constructor(operation: string) {
    super(`${operation} credential must be non-empty`);
    this.name = 'BlankProvenanceCredentialError';
  }
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
  /** Typed owner-decision metadata (null on legacy/machine rows). */
  readonly decision: NotificationDecision | null;
  /** The recorded owner decision — DISTINCT from ack and resolution: it
   * proves the choice was recorded, never that its follow-on operation
   * succeeded. */
  readonly decidedAt: string | null;
  readonly decidedBy: string | null;
  readonly decidedOption: string | null;
}

/** Marker for not-found failures the HTTP surface maps to 404 (typed —
 * never grepped from error text). */
export class NotificationIdentityError extends Error {
  constructor() {
    super('notification id contains NUL; SQLite cannot round-trip this identity — use an ID without NUL characters');
    this.name = 'NotificationIdentityError';
  }
}

export class RecordNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordNotFound';
  }
}

/** Why an administrative closeout was refused. Each refusal is a loud,
 * no-effect failure: nothing is written when it is thrown (the operation
 * validates every guard before its single transaction writes). */
export type AdminCloseoutRefusalCode =
  | 'not-parked'
  | 'not-pr-backed'
  | 'not-pr-owing'
  | 'target-mismatch'
  | 'unconfirmed-pr'
  | 'pr-open'
  | 'pr-merged'
  | 'stale-head'
  | 'live-work'
  | 'already-closed';

/** A guarded administrative closeout refused by a durable-state fact. The
 * HTTP surface maps this to 409 (`closeout_refused` + `code`), never to a
 * malformed-request 400. */
export class AdminCloseoutRefusal extends Error {
  constructor(
    readonly code: AdminCloseoutRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'AdminCloseoutRefusal';
  }
}

/** Why an owner-decision submission was refused. Every refusal is a
 * no-effect failure: nothing is written when it is thrown. The HTTP
 * surface maps `unknown_option` to 400 and the rest to 409. */
export type NotificationDecisionRefusalCode =
  | 'not_owner_decision'
  | 'no_decision'
  | 'unknown_option'
  | 'decision_changed'
  | 'decision_recorded'
  | 'not_open'
  | 'undecided'
  | 'not_discussion'
  | 'decision_present'
  | 'legacy_closed'
  | 'not_withdrawable';

export class NotificationDecisionRefusal extends Error {
  constructor(
    readonly code: NotificationDecisionRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'NotificationDecisionRefusal';
  }
}

/** The provider identity an administrative closeout asserts: the PR is
 * CLOSED and explicitly not merged, at the named head. */
export interface AdminCloseoutProviderEvidence {
  readonly provider: 'github';
  readonly state: 'closed';
  readonly merged: false;
  readonly headSha: string;
  /** The provider's close timestamp when the caller has one (recorded
   * verbatim; never compared — the observation event is the binding). */
  readonly closedAt?: string | null;
}

export interface AdminCloseoutInput {
  readonly jobId: string;
  /** Optimistic concurrency: the only admitted source state. */
  readonly expectedStatus: 'parked';
  /** The exact registered PR target being closed. */
  readonly expectedPrUrl: string;
  readonly provider: AdminCloseoutProviderEvidence;
  /** Why the closeout is authorized (recorded verbatim; bounded). */
  readonly reason: string;
}

export interface AdminCloseoutResult {
  readonly job: JobRecord;
  /** The `job.admin-closeout` audit event (the ORIGINAL on a replay). */
  readonly event: EventRecord;
  readonly idempotent: boolean;
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

/** A round's evidence cannot prove that no review owner started, so no
 * `round.review-no-spawn` receipt is written (#466). */
export class NoSpawnProofRefusedError extends Error {
  constructor(readonly roundId: string) {
    super(`round ${roundId} cannot prove no review owner started: the proof needs a pending or aborted round that never went live, with no specialist starts, no registered agents, no earlier no-spawn receipt and at most one owner marker`);
    this.name = 'NoSpawnProofRefusedError';
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
/** Owner rule 5 (2026-10-08): the lane has exactly one writer request at a
 * time. A directive is refused while a re-brief request stands, and a
 * re-brief while a directive request is live — never two writers. */
export class LaneWriterConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaneWriterConflictError';
  }
}

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

/** A job named a parent (the megaminion family link) the ledger cannot
 * accept: unknown, itself, another repo's, a child itself, or a child
 * that is not a report-type specialist. Thrown before any row is written. */
export class JobParentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobParentError';
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
  /** #486: the lane incarnation's random token, which every session
   * spawned in the lane carries as GRU_LANE_TOKEN (see
   * worktrees/lane-provenance.ts). NULL only for a lane swept before the
   * token existed. */
  readonly laneToken: string | null;
}

/** Durable review-owner cessation (#464): recorded only through
 * `recordReviewOwnerCessation`, which binds it to the round's owner
 * marker, never as a custom event. */
export const REVIEW_OWNER_CEASED_KIND = 'round.review-owner-ceased';

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

/** An owner abandonment of one pending re-brief marker generation (one row
 * per marker of the generation, sharing the audit event). */
export interface RebriefAbandonmentRecord {
  readonly markerId: string;
  readonly jobId: string;
  readonly payloadHash: string;
  readonly baselineSeq: number;
  readonly abandonedAt: string;
  readonly abandonedBy: string;
  readonly abandonReason: string;
  readonly eventSeq: number;
  readonly holdReleasedBy: string | null;
  readonly holdReleasedAt: string | null;
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
  /** Firing-rule provenance (issue #117): the named Silas rule this
   * re-brief answers (e.g. verdict-rung-rebrief) and the round it
   * consumed. The silas.rebrief receipt replays both — restart-safe,
   * because the marker is the durable request. */
  readonly ruleId: string | null;
  readonly sourceRoundId: string | null;
  /** The autopilot provenance (issue #243 M3): `'silas-autopilot'` when the
   * durable request was minted by the code autopilot, null for LLM Silas's
   * own re-brief. The finalizer replays it onto the `silas.rebrief` receipt
   * so #214 can attribute the action. */
  readonly source: string | null;
  /** The required work revision the request was composed with (owner rule
   * 4); the re-brief delivery carries it as its receipt. null = a request
   * accepted before work revisions existed. */
  readonly workRevision: number | null;
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

/** The strict read of one recorded `github.branch-state` observation, as
 * the administrative closeout consumes it. Every field is optional on the
 * wire; anything absent or the wrong type reads as `null` and fails the
 * closeout closed (unconfirmed) — never as a guessed default. */
interface CloseoutObservation {
  readonly repo: string | null;
  readonly prUrl: string | null;
  readonly prNumber: number | null;
  readonly sha: string | null;
  readonly merged: boolean | null;
  readonly prOpen: boolean | null;
}

function parseCloseoutObservation(payload: unknown): CloseoutObservation | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const stringOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const numberOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;
  const booleanOrNull = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);
  return {
    repo: stringOrNull(record['repo']),
    prUrl: stringOrNull(record['pr_url']),
    prNumber: numberOrNull(record['pr_number']),
    sha: stringOrNull(record['sha']),
    merged: booleanOrNull(record['merged']),
    prOpen: booleanOrNull(record['pr_open']),
  };
}

/** True for the canonical ISO-8601 UTC form (or the same without the
 * millisecond fraction) of a REAL calendar timestamp. A shape regex alone
 * would accept impossible dates such as 2026-13-45T99:99:99Z into the
 * audit; the Date round-trip rejects them. */
function isRealIsoUtcTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return false;
  const normalized = value.includes('.') ? value : value.replace(/Z$/u, '.000Z');
  const ms = new Date(normalized).getTime();
  return Number.isFinite(ms) && new Date(ms).toISOString() === normalized;
}

const DIRECTIVE_CONTROL_SQL = `kind IN ('silas.directive-retired', 'silas.directive-abandoned', 'silas.rebrief-abandoned', 'silas.directive-recovery-handoff', 'silas.rebrief-recovery-handoff', 'job.amendment-accepted')
  OR (kind = 'job.status' AND json_extract(payload, '$.to') IN ('parked', 'blocked', 'needs-owner', 'merged', 'done', 'binned'))
  OR (kind = 'job.obligation-recorded' AND json_extract(payload, '$.next_action.kind') = 'owner-decision')
  OR (kind = 'ruling.recorded' AND json_extract(payload, '$.permission') = 'fresh-current-approved-recovery-successor')
  OR kind IN ('silas.recovery-owner-stop-confirmed', 'silas.rebrief-control-closed')`;

export class LedgerApi {
  private readonly db: DatabaseSync;
  private readonly bus: EventBus | null;
  /** Process-local ownership across the asynchronous gap BEFORE a worker
   * has a registered spawning turn. Historical durable requests are NOT a
   * permanent blocker after their runtime attempt settles or crashes. */
  private readonly activeJobAdmissions = new Set<{ readonly jobId: string; readonly kind: string }>();

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
      this.mailboxProjectionCache = null;
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
    if (fields.kind === 'silas.directive-settled' && typeof fields.payload === 'object' && fields.payload !== null &&
        Object.hasOwn(fields.payload, 'candidate_delivery_proven')) this.assertNativeSettlementCandidate(fields.jobId ?? null, fields.payload as Record<string, unknown>);
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
    opts: {
      limit?: number;
      order?: 'asc' | 'desc';
      kinds?: readonly string[];
      /** One top-level payload field that must (or must not) equal a value:
       * a window of its own, never a share of a mixed one (#360 R5-B11). */
      payload?: { readonly key: string; readonly equals?: string; readonly notEquals?: string };
    } = {},
  ): readonly EventRecord[] {
    const limit = opts.limit ?? 100;
    const order = opts.order === 'desc' ? 'DESC' : 'ASC';
    const kinds = opts.kinds;
    let where =
      kinds === undefined || kinds.length === 0
        ? 'seq > ?'
        : `seq > ? AND kind IN (${kinds.map(() => '?').join(', ')})`;
    const params: (number | string)[] = [seq, ...(kinds ?? [])];
    if (opts.payload !== undefined) {
      const { key, equals, notEquals } = opts.payload;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || (equals === undefined) === (notEquals === undefined)) {
        throw new Error('listEventsAfter payload filter needs one plain field name and exactly one of equals/notEquals');
      }
      where += equals !== undefined ? ` AND json_extract(payload, '$.${key}') = ?` : ` AND json_extract(payload, '$.${key}') IS NOT ?`;
      params.push((equals ?? notEquals)!);
    }
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

  /** The newest event of one kind whose top-level payload `field` equals
   * `value`, whatever its job (#427: a lane's own records, which a lane
   * with no job carries too). Meant for rare kinds: it reads every event of
   * the kind. */
  latestEventByPayloadField(kind: string, field: string, value: string): EventRecord | null {
    if (!/^[a-z][a-z0-9_]*$/u.test(field)) throw new Error(`latestEventByPayloadField: "${field}" is not a plain snake_case payload field`);
    const row = this.db
      .prepare('SELECT * FROM events WHERE kind = ? AND json_extract(payload, ?) = ? ORDER BY seq DESC LIMIT 1')
      .get(kind, `$.${field}`, value) as Row | undefined;
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

  /** Durable review-owner cessation (#464), bound to the round's unique
   * owner marker. `adapter`: the owning process saw its adapter report one
   * review session ceased (the record keeps the observer's pid, never
   * requires it: a session id exists only in the process that spawned it).
   * `host-exit`: a later process proved the marker's host and every
   * session of the round gone. A record that binds no unique marker is
   * refused by name, and nothing is written. */
  recordReviewOwnerCessation(input:
    | { readonly source: 'adapter'; readonly agentId: string; readonly generation: string }
    | { readonly source: 'host-exit'; readonly roundId: string; readonly generation: string; readonly pid: number;
      readonly hostIdentity: string | null; readonly evidence: Readonly<Record<string, unknown>> }): EventRecord {
    return this.transaction(() => {
      const candidates = input.source === 'adapter'
        ? this.db.prepare(
          "SELECT * FROM events WHERE kind = 'round.review-owner' AND json_extract(payload, '$.generation') = ? ORDER BY seq ASC LIMIT 2",
        ).all(input.generation) as Row[]
        : this.db.prepare(
          "SELECT * FROM events WHERE round_id = ? AND kind = 'round.review-owner' ORDER BY seq ASC LIMIT 2",
        ).all(input.roundId) as Row[];
      const marker = candidates.length === 1 ? this.eventFromRow(candidates[0]!) : null;
      const owner = marker?.payload as { generation?: unknown; pid?: unknown; hostIdentity?: unknown } | null | undefined;
      if (marker === null || marker.roundId === null || owner?.generation !== input.generation ||
        // The proof judged exactly this marker's host: its pid and identity.
        (input.source === 'host-exit' && (owner.pid !== input.pid || (owner.hostIdentity ?? null) !== input.hostIdentity)) ||
        (input.source === 'adapter' && input.agentId.trim() === '') ||
        this.uniqueRoundReviewOwnerMarker(marker.roundId)?.seq !== marker.seq) {
        throw new Error(`review-owner cessation (${input.source}) for generation ${input.generation} binds no unique round owner marker; nothing recorded`);
      }
      // Recorded once: a concurrent proof (or a late repeat) returns the record.
      const existing = (this.db.prepare('SELECT * FROM events WHERE round_id = ? AND kind = ? ORDER BY seq ASC')
        .all(marker.roundId, REVIEW_OWNER_CEASED_KIND) as Row[]).map((row) => this.eventFromRow(row)).find((event) => {
        const record = event.payload as Record<string, unknown> | null;
        return record !== null && typeof record === 'object' && record['source'] === input.source && record['generation'] === input.generation &&
          (input.source === 'adapter' ? record['agentId'] === input.agentId : record['pid'] === input.pid);
      });
      if (existing !== undefined) return existing;
      return this.appendEvent({
        kind: REVIEW_OWNER_CEASED_KIND, jobId: marker.jobId, roundId: marker.roundId,
        agentId: input.source === 'adapter' ? input.agentId : null,
        payload: input.source === 'adapter'
          ? { source: 'adapter', roundId: marker.roundId, agentId: input.agentId, generation: input.generation, observerPid: process.pid }
          : { source: 'host-exit', roundId: marker.roundId, generation: input.generation, pid: input.pid,
            observerPid: process.pid, evidence: input.evidence },
      });
    });
  }

  /** Whether a durable record proves `agentId` ceased under exactly this
   * owner marker. A `host-exit` proof covers the whole owner, including
   * `''` (the owner before any session registered); an `adapter` record
   * covers only its own session. */
  reviewOwnerCessationRecorded(agentId: string, marker: { readonly roundId: string; readonly generation: string; readonly pid: number }): boolean {
    const rows = this.db.prepare('SELECT * FROM events WHERE round_id = ? AND kind = ? ORDER BY seq ASC')
      .all(marker.roundId, REVIEW_OWNER_CEASED_KIND) as Row[];
    return rows.some((row) => {
      const record = this.eventFromRow(row).payload as Record<string, unknown> | null;
      if (record === null || typeof record !== 'object' || record['roundId'] !== marker.roundId ||
        record['generation'] !== marker.generation) return false;
      if (record['source'] === 'host-exit') return record['pid'] === marker.pid;
      return record['source'] === 'adapter' && agentId !== '' && record['agentId'] === agentId;
    });
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
        throw new NoSpawnProofRefusedError(roundId);
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

  /** One job's bounded event window, newest first by default (ops digests).
   * Evidence surfaces may narrow kinds, cap the rows and request oldest-first
   * without scanning a moving global tail that can omit the job's receipts. */
  listJobEvents(jobId: string, opts: { readonly limit?: number; readonly kinds?: readonly string[]; readonly order?: 'asc' | 'desc' } = {}): readonly EventRecord[] {
    const limit = opts.limit ?? 200;
    const order = opts.order === 'asc' ? 'ASC' : 'DESC';
    const kinds = opts.kinds;
    const where = kinds === undefined || kinds.length === 0
      ? 'job_id = ?'
      : `job_id = ? AND kind IN (${kinds.map(() => '?').join(', ')})`;
    return (this.db.prepare(`SELECT * FROM events WHERE ${where} ORDER BY seq ${order} LIMIT ?`)
      .all(jobId, ...(kinds ?? []), limit) as Row[]).map((row) => this.eventFromRow(row));
  }

  /** R8-2 (gh-169, corrected by j-1594 native-verification-history-search):
   * a job's completed verification runs, KIND-SCOPED and newest-first — the
   * binding-target search must not be truncated by a generic all-kind event
   * window. The history is read in bounded keyset pages over the COMPLETE
   * record: there is NO finite per-job lifetime ceiling, so any history
   * length is reviewable. The scan is lazy — the caller may stop at the
   * first binding run, so the common case fetches one page, while proving
   * absence exhausts every page. Each fetch is bounded by `pageSize`; a
   * storage failure throws while the caller iterates, so a partial read can
   * never masquerade as an empty history. A first-captured `MAX(seq)`
   * watermark bounds every page (`cursor` starts one past it and only
   * decreases), so the page set stays stable and each row is visited
   * exactly once. The returned iterator is single-use — consume it once
   * inside the caller's loop (a second pass yields nothing). The page-size
   * refusal and the watermark read are taken on the FIRST pull, not at the
   * call (a generator body does not run until then). */
  *iterateJobVerificationCompleted(jobId: string, pageSize = 200): Generator<EventRecord, void, void> {
    if (!Number.isInteger(pageSize) || pageSize <= 0) {
      throw new Error(`iterateJobVerificationCompleted pageSize must be a positive integer (got ${String(pageSize)})`);
    }
    const ceilingRow = this.db
      .prepare('SELECT MAX(seq) AS ceiling FROM events WHERE job_id = ? AND kind = ?')
      .get(jobId, VERIFICATION_KIND) as Row | undefined;
    const ceiling = ceilingRow?.ceiling;
    if (ceiling === null || ceiling === undefined) return;
    const watermark = Number(ceiling);
    let cursor = watermark + 1;
    for (;;) {
      const rows = this.db
        .prepare('SELECT * FROM events WHERE job_id = ? AND kind = ? AND seq <= ? AND seq < ? ORDER BY seq DESC LIMIT ?')
        .all(jobId, VERIFICATION_KIND, watermark, cursor, pageSize) as Row[];
      if (rows.length === 0) return;
      for (const row of rows) yield this.eventFromRow(row);
      if (rows.length < pageSize) return;
      cursor = Number(rows[rows.length - 1]!.seq);
    }
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
                  MAX(CASE WHEN kind IN ('verification.completed', 'verification.stale-released', 'verification.reconciled', 'verification.lock-timeout', 'verification.no-start') THEN seq ELSE 0 END) AS settled_seq
           FROM events
           WHERE job_id = ? AND kind IN (
             'verification.requested', 'verification.started', 'verification.completed',
             'verification.stale-released', 'verification.reconciled', 'verification.lock-timeout', 'verification.no-start'
           )
           GROUP BY run_id
         ) WHERE open_seq > settled_seq LIMIT 1`,
      )
      .get(jobId) as Row | undefined;
    return row !== undefined;
  }

  /** Authoritative terminal readback may close only absent matching physical
   * registry rows. Process-group absence prevents detached children being lost;
   * live, EPERM, PID reuse and foreign commands remain untouched. */
  reconcileVerificationProcesses(input: { readonly jobId: string; readonly runId: string; readonly requestId: string;
    readonly command: string; readonly cwd: string; readonly worktreeId: string }): void {
    const absent = (pid: number): boolean => {
      try { process.kill(pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    };
    this.transaction(() => {
      const lane = this.getWorktree(input.worktreeId);
      if (lane?.jobId !== input.jobId || lane.path !== input.cwd) return;
      const terminal = this.db.prepare(`SELECT seq FROM events WHERE job_id = ?
        AND (kind = 'verification.completed' OR kind = 'verification.reconciled' AND json_extract(payload, '$.state') = 'completed')
        AND json_extract(payload, '$.run_id') = ? ORDER BY seq DESC LIMIT 1`).get(input.jobId, input.runId) as Row | undefined;
      const conflictingTerminal = this.db.prepare(`SELECT 1 FROM events WHERE job_id = ? AND kind = 'verification.completed'
        AND json_extract(payload, '$.run_id') = ? AND
        (json_extract(payload, '$.command') IS NOT ? OR json_extract(payload, '$.cwd') IS NOT ?) LIMIT 1`)
        .get(input.jobId, input.runId, input.command, input.cwd);
      if (conflictingTerminal !== undefined) return;
      if (terminal === undefined || !this.hasJobEventWithPayloadValues(input.jobId, ['verification.requested', 'verification.attached'],
        [{ key: 'run_id', value: input.runId }, { key: 'request_id', value: input.requestId }], 0)) return;
      const evidence = this.db.prepare(`SELECT seq, kind,
        CASE WHEN length(CAST(payload AS BLOB)) <= ? THEN payload ELSE NULL END AS payload,
        length(CAST(payload AS BLOB)) AS payload_bytes FROM events WHERE job_id = ?
        AND kind IN ('verification.started', 'verification.process-started')
        AND json_extract(payload, '$.run_id') = ? ORDER BY seq LIMIT ?`)
        .iterate(MAX_VERIFICATION_PROCESS_RECEIPT_BYTES, input.jobId, input.runId, MAX_VERIFICATION_PROCESS_RECEIPT_EVENTS + 1);
      const receipts: Row[] = [];
      let receiptBytes = 0;
      for (const row of evidence) {
        receiptBytes += Number(row.payload_bytes);
        if (receipts.length === MAX_VERIFICATION_PROCESS_RECEIPT_EVENTS || row.payload === null ||
            receiptBytes > MAX_VERIFICATION_PROCESS_RECEIPT_BYTES) {
          throw new DirectiveCheckpointError('verification process receipt inspection exceeds the original complete-evidence bounds; physical ownership remains UNKNOWN');
        }
        receipts.push(row);
      }
      const starts = receipts.filter((row) => row.kind === 'verification.started');
      const started = starts[0];
      if (started === undefined || Number(started.seq) >= Number(terminal.seq)) return;
      const physical = JSON.parse(str(started.payload)) as { pid?: unknown; command?: unknown; cwd?: unknown; sha?: unknown };
      if (!Number.isSafeInteger(physical.pid) || Number(physical.pid) <= 0 || physical.command !== input.command || physical.cwd !== input.cwd ||
          starts.some((event) => { const facts = JSON.parse(str(event.payload)) as typeof physical;
            return Number(event.seq) >= Number(terminal.seq) || facts.pid !== physical.pid || facts.command !== input.command || facts.cwd !== input.cwd; })) return;
      const nativeStarts = receipts.filter((row) => row.kind === 'verification.process-started');
      const identities: Array<{ readonly seq: number; readonly pid: number; readonly command: string }> = [];
      if (nativeStarts.length === 0) {
        // Prior whole-command receipts stay valid exactly as recorded. A null
        // reuse start never gets today's PID or step facts backfilled here.
        identities.push({ seq: Number(started.seq), pid: Number(physical.pid), command: `/bin/sh -c ${input.command}` });
      } else {
        const plan = planCommand(input.command);
        const steps = plan.buildIndex !== null && plan.refusal === null ? plan.steps : [input.command];
        const indices = new Set<number>();
        const pids = new Set<number>();
        let stepCount: number | null = null;
        for (const event of nativeStarts) {
          const facts = JSON.parse(str(event.payload)) as { pid?: unknown; command?: unknown; cwd?: unknown; sha?: unknown;
            process_command?: unknown; step_command?: unknown; step_index?: unknown; step_count?: unknown };
          const index = Number(facts.step_index);
          const count = Number(facts.step_count);
          const pid = Number(facts.pid);
          const monolithic = count === 1 && index === 0 && facts.step_command === input.command;
          if (!Number.isSafeInteger(facts.pid) || pid <= 0 || !Number.isSafeInteger(facts.step_index) || !Number.isSafeInteger(facts.step_count) ||
              index < 0 || count <= 0 || index >= count || indices.has(index) || pids.has(pid) ||
              Number(event.seq) >= Number(terminal.seq) || facts.command !== input.command || facts.cwd !== input.cwd || facts.sha !== physical.sha ||
              facts.process_command !== `/bin/sh -c ${String(facts.step_command)}` ||
              (!monolithic && (count !== steps.length || facts.step_command !== steps[index])) ||
              (stepCount !== null && count !== stepCount)) return;
          stepCount = count;
          indices.add(index); pids.add(pid);
          identities.push({ seq: Number(event.seq), pid, command: String(facts.process_command) });
        }
        if (identities[0]?.pid !== physical.pid) return;
      }
      for (const identity of identities) {
        // Both old and per-step receipts of another run fence PID reuse.
        const conflicting = this.db.prepare(`SELECT 1 FROM events WHERE kind IN ('verification.started', 'verification.process-started')
          AND json_extract(payload, '$.pid') = ? AND (job_id IS NOT ? OR json_extract(payload, '$.run_id') IS NOT ?) LIMIT 1`)
          .get(identity.pid, input.jobId, input.runId);
        if (conflicting !== undefined) continue;
        for (const row of this.listWorktreeProcesses(input.worktreeId)) {
          if (row.pid !== identity.pid || row.state !== 'live' || row.evidence !== 'registry' || row.command !== identity.command || !absent(row.pid) || !absent(-row.pid)) continue;
          this.db.prepare(`UPDATE worktree_processes SET state = 'killed', last_seen = ? WHERE worktree_id = ? AND pid = ? AND state = 'live'`).run(nowIso(), input.worktreeId, row.pid);
          this.appendEvent({ kind: 'verification.process-reconciled', jobId: input.jobId, payload: {
            request_id: input.requestId, run_id: input.runId, started_event_seq: identity.seq, terminal_event_seq: Number(terminal.seq), worktree_id: input.worktreeId,
            pid: row.pid, command: row.command, evidence: 'original-pid-and-process-group-absent',
          } });
        }
      }
    });
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

  private creationContinuationEvents(jobId: string, requestId?: string): readonly EventRecord[] {
    return (this.db.prepare(
      `SELECT * FROM events WHERE job_id = ? AND kind = 'job.creation-continuation'${requestId === undefined ? '' : " AND json_extract(payload, '$.request_id') = ?"} ORDER BY seq ASC`,
    ).all(...(requestId === undefined ? [jobId] : [jobId, requestId]) as string[]) as Row[]).map((row) => this.eventFromRow(row));
  }

  getCreationContinuation(jobId: string, requestId: string): CreationContinuationTimeline | null {
    const events = this.creationContinuationEvents(jobId, requestId);
    const first = events[0];
    if (first === undefined) return null;
    const firstPayload = first.payload as Record<string, unknown>;
    const stateEvent = events.at(-1)!;
    const latest = stateEvent.payload as Record<string, unknown>;
    const baseSource = firstPayload['base_source'];
    if (!(baseSource === null || baseSource === 'origin' || baseSource === 'local-head-fallback')) {
      throw new Error(`creation continuation ${requestId} has an invalid recorded base provenance`);
    }
    const identity: CreationContinuationIdentity = {
      jobId,
      requestId,
      generation: Number(firstPayload['generation']),
      payloadSha256: String(firstPayload['payload_sha256']),
      handoffSeq: typeof firstPayload['handoff_seq'] === 'number' ? firstPayload['handoff_seq'] : null,
      briefingSha256: typeof firstPayload['briefing_sha256'] === 'string' ? firstPayload['briefing_sha256'] : null,
      handoffRepoPath: typeof firstPayload['handoff_repo_path'] === 'string' ? firstPayload['handoff_repo_path'] : null,
      repoPath: typeof firstPayload['repo_path'] === 'string' ? firstPayload['repo_path'] : null,
      branch: typeof firstPayload['branch'] === 'string' ? firstPayload['branch'] : null,
      baseSha: typeof firstPayload['base_sha'] === 'string' ? firstPayload['base_sha'] : null,
      baseSource,
      producerSettlementSeq: typeof firstPayload['producer_settlement_seq'] === 'number' ? firstPayload['producer_settlement_seq'] : null,
      receiptTokenSha256: typeof firstPayload['receipt_token_sha256'] === 'string' ? firstPayload['receipt_token_sha256'] : null,
    };
    const state = latest['state'];
    if (!isCreationContinuationState(state)) throw new Error(`creation continuation ${requestId} has an invalid state`);
    return { identity, events, state };
  }

  getCreationContinuationDispatchEvidence(jobId: string, requestId: string, generation: number): {
    readonly spawned: EventRecord | null;
    readonly delivery: EventRecord | null;
  } {
    const spawned = this.db.prepare(
      "SELECT * FROM events WHERE job_id = ? AND kind = 'job.minion-spawned' AND json_extract(payload, '$.creation_continuation_request_id') = ? AND json_extract(payload, '$.creation_continuation_generation') = ? ORDER BY seq DESC LIMIT 1",
    ).get(jobId, requestId, generation) as Row | undefined;
    const delivery = this.db.prepare(
      "SELECT * FROM events WHERE job_id = ? AND kind = 'job.delivered' AND json_extract(payload, '$.source') = 'dispatch' AND json_extract(payload, '$.creation_continuation_request_id') = ? AND json_extract(payload, '$.creation_continuation_generation') = ? ORDER BY seq DESC LIMIT 1",
    ).get(jobId, requestId, generation) as Row | undefined;
    return {
      spawned: spawned === undefined ? null : this.eventFromRow(spawned),
      delivery: delivery === undefined ? null : this.eventFromRow(delivery),
    };
  }

  /** Read the exact producer close receipt bound to this retained branch.
   * Ref commitment, PID absence and receipt-writer identity are deliberately
   * not accepted as cessation evidence. */
  hasSettledCreationProducer(input: {
    readonly jobId: string;
    readonly branch: string;
    readonly sha: string;
    readonly tokenSha256: string;
  }): EventRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM events WHERE job_id = ? AND kind = 'job.creation-producer-settled'
       AND json_extract(payload, '$.branch') = ? AND json_extract(payload, '$.sha') = ?
       AND json_extract(payload, '$.token_sha256') = ? AND json_extract(payload, '$.close_observed') = 1
       ORDER BY seq DESC LIMIT 1`,
    ).get(input.jobId, input.branch, input.sha, input.tokenSha256) as Row | undefined;
    return row === undefined ? null : this.eventFromRow(row);
  }

  /** WorktreeManager's exact child-handle close observation. This method is
   * the only typed writer of creation-producer cessation evidence; the
   * receipt token's digest correlates it, so one receipt settles once. */
  recordCreationProducerSettlement(input: {
    readonly jobId: string;
    readonly branch: string;
    readonly sha: string;
    readonly tokenSha256: string;
    readonly pid: number;
    readonly exitCode: number | null;
    readonly signal: string | null;
  }): EventRecord {
    if (input.jobId === '' || input.branch !== `gru/${input.jobId}` || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input.sha) ||
        !/^[a-f0-9]{64}$/u.test(input.tokenSha256) || !Number.isSafeInteger(input.pid) || input.pid <= 0 ||
        !(input.exitCode === null || Number.isSafeInteger(input.exitCode)) ||
        !(input.signal === null || typeof input.signal === 'string' && input.signal !== '')) {
      throw new Error('creation producer settlement requires exact job, branch, base, token digest and child close identity');
    }
    return this.transaction(() => {
      const prior = this.db.prepare(
        "SELECT * FROM events WHERE kind = 'job.creation-producer-settled' AND json_extract(payload, '$.token_sha256') = ? ORDER BY seq ASC LIMIT 1",
      ).get(input.tokenSha256) as Row | undefined;
      if (prior !== undefined) {
        const event = this.eventFromRow(prior);
        const payload = event.payload as Record<string, unknown>;
        if (event.jobId !== input.jobId || payload['branch'] !== input.branch || payload['sha'] !== input.sha) {
          throw new Error(`creation receipt ${input.tokenSha256} is already settled for job "${event.jobId ?? ''}" ${String(payload['branch'])} at ${String(payload['sha'])}`);
        }
        return event;
      }
      return this.appendEvent({ kind: 'job.creation-producer-settled', jobId: input.jobId, payload: {
        branch: input.branch, sha: input.sha, token_sha256: input.tokenSha256, pid: input.pid,
        close_observed: true, exit_code: input.exitCode, signal: input.signal,
      } });
    });
  }

  /** Atomically persist one request identity/generation, or return its prior
   * receipt. A competing in-flight request is recorded as refused; it never
   * gets a second admission claim. */
  acceptCreationContinuation(input: {
    readonly jobId: string;
    readonly requestId: string;
    readonly payloadSha256: string;
    readonly handoffSeq: number | null;
    readonly briefingSha256: string | null;
    readonly handoffRepoPath: string | null;
    readonly repoPath: string | null;
    readonly branch: string | null;
    readonly baseSha: string | null;
    readonly baseSource: WorktreeBaseSource | null;
    readonly producerSettlementSeq: number | null;
    readonly receiptTokenSha256: string | null;
    readonly refusalReason?: string;
  }): { readonly created: boolean; readonly timeline: CreationContinuationTimeline } {
    if (input.jobId.trim() === '' || input.requestId.trim() === '' || !/^[a-f0-9]{64}$/u.test(input.payloadSha256)) {
      throw new Error('creation continuation requires a job, request id and SHA-256 payload identity');
    }
    return this.transaction(() => {
      const history = this.creationContinuationEvents(input.jobId);
      const byRequest = new Map<string, EventRecord[]>();
      for (const event of history) {
        const payload = event.payload as Record<string, unknown>;
        const id = payload['request_id'];
        if (typeof id !== 'string') throw new Error(`creation continuation event ${event.seq} has no request id`);
        byRequest.set(id, [...(byRequest.get(id) ?? []), event]);
      }
      const prior = byRequest.get(input.requestId);
      if (prior !== undefined) {
        const payload = prior[0]!.payload as Record<string, unknown>;
        if (payload['payload_sha256'] !== input.payloadSha256) {
          throw new CreationContinuationConflictError(`request id ${input.requestId} was already used with a different payload`);
        }
        const timeline = this.getCreationContinuation(input.jobId, input.requestId);
        if (timeline === null) throw new Error(`creation continuation ${input.requestId} disappeared during readback`);
        return { created: false, timeline };
      }
      const maxGeneration = history.reduce((max, event) => Math.max(max, Number((event.payload as Record<string, unknown>)['generation']) || 0), 0);
      const generation = maxGeneration + 1;
      const latest = (events: readonly EventRecord[]): CreationContinuationState => {
        const state = (events.at(-1)?.payload as Record<string, unknown> | undefined)?.['state'];
        return isCreationContinuationState(state) ? state : 'custody-unknown';
      };
      const unresolved = [...byRequest.entries()].find(([, events]) => {
        const state = latest(events);
        return state === 'accepted' || state === 'queued' || state === 'admitted' || state === 'custody-unknown';
      });
      const job = this.getJob(input.jobId);
      const handoffRows = this.db.prepare("SELECT * FROM events WHERE job_id = ? AND kind = 'job.handoff' ORDER BY seq ASC").all(input.jobId) as Row[];
      const handoff = handoffRows.length === 1 ? this.eventFromRow(handoffRows[0]!) : null;
      const handoffPayload = handoff?.payload as Record<string, unknown> | undefined;
      const briefingMatches = job?.briefing !== null && job?.briefing !== undefined &&
        createHash('sha256').update(job.briefing, 'utf8').digest('hex') === input.briefingSha256;
      const producer = input.producerSettlementSeq === null ? null : this.getEvent(input.producerSettlementSeq);
      const producerPayload = producer?.payload as Record<string, unknown> | undefined;
      const producerMatches = producer?.kind === 'job.creation-producer-settled' && producer.jobId === input.jobId &&
        producerPayload?.['branch'] === input.branch && producerPayload?.['sha'] === input.baseSha &&
        producerPayload?.['token_sha256'] === input.receiptTokenSha256 && producerPayload?.['close_observed'] === true;
      const scope = (): string | null => {
        if (unresolved !== undefined) return `another continuation request ${unresolved[0]} owns this job's continuation fence`;
        if (this.getDirective(input.requestId) !== null) return `request id ${input.requestId} names a directive request; a continuation needs its own id`;
        if (job === null) return `job "${input.jobId}" does not exist`;
        const jobRefusal = creationContinuationJobRefusal(job);
        if (jobRefusal !== null) return jobRefusal;
        if (!briefingMatches) return `job "${input.jobId}" has no unchanged original briefing`;
        if (this.listJobAmendments(input.jobId).length > 0) return `job "${input.jobId}" has an amended contract outside initial-dispatch continuation`;
        if (handoff === null || handoff.seq !== input.handoffSeq || input.handoffRepoPath === null || handoffPayload?.['repoPath'] !== input.handoffRepoPath) {
          return `job "${input.jobId}" has no unique matching original handoff`;
        }
        if (input.repoPath === null) return `job "${input.jobId}" has no inspected repository`;
        const repoMismatch = creationContinuationRepoMismatch(job, input.handoffRepoPath, input.repoPath);
        if (repoMismatch !== null) return repoMismatch;
        if (input.branch !== `gru/${input.jobId}` || input.baseSha === null ||
            !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input.baseSha) || input.baseSource === null ||
            !/^[a-f0-9]{64}$/u.test(input.receiptTokenSha256 ?? '') || !producerMatches) {
          return `job "${input.jobId}" has no exact positive retained-creation producer settlement`;
        }
        if (this.getWorktree(input.jobId) !== null) return `job "${input.jobId}" already has a registered worktree`;
        if (this.listAgents().some((agent) => agent.jobId === input.jobId)) return `job "${input.jobId}" already has an agent record`;
        if (this.listJobAdmissions(input.jobId).length > 0) return `job "${input.jobId}" already has a live admission`;
        const owner = this.creationContinuationLaneOwner(input.jobId);
        if (owner !== null) return owner;
        if (this.listPhaseHandoffs({ jobId: input.jobId, limit: 1000 }).length > 0) {
          return `job "${input.jobId}" has a prior phase-handoff contract that this continuation does not rewrite`;
        }
        if (this.db.prepare("SELECT 1 FROM events WHERE job_id = ? AND kind IN ('job.minion-spawned', 'job.delivered', 'agent.attached') LIMIT 1").get(input.jobId) !== undefined) {
          return `job "${input.jobId}" already has worker or delivery history`;
        }
        return null;
      };
      const scopeProblem = input.refusalReason ?? scope();
      const identity: CreationContinuationIdentity = {
        jobId: input.jobId, requestId: input.requestId, generation, payloadSha256: input.payloadSha256,
        handoffSeq: input.handoffSeq, briefingSha256: input.briefingSha256, handoffRepoPath: input.handoffRepoPath,
        repoPath: input.repoPath,
        branch: input.branch, baseSha: input.baseSha, baseSource: input.baseSource,
        producerSettlementSeq: input.producerSettlementSeq, receiptTokenSha256: input.receiptTokenSha256,
      };
      const initialState: CreationContinuationState = scopeProblem === null ? 'accepted' : 'refused';
      this.appendEvent({ kind: 'job.creation-continuation', jobId: identity.jobId, payload: {
        request_id: identity.requestId, generation: identity.generation, payload_sha256: identity.payloadSha256, state: initialState,
        stage: initialState, handoff_seq: identity.handoffSeq, briefing_sha256: identity.briefingSha256,
        handoff_repo_path: identity.handoffRepoPath, repo_path: identity.repoPath, branch: identity.branch, base_sha: identity.baseSha,
        base_source: identity.baseSource, producer_settlement_seq: identity.producerSettlementSeq,
        ...(identity.receiptTokenSha256 !== null ? { receipt_token_sha256: identity.receiptTokenSha256 } : {}),
        ...(scopeProblem !== null ? { reason: scopeProblem.slice(0, 1000) } : {}),
      } });
      const timeline = this.getCreationContinuation(input.jobId, input.requestId);
      if (timeline === null) throw new Error(`creation continuation ${input.requestId} could not be read after recording`);
      return { created: true, timeline };
    });
  }

  /** The lane owners a creation continuation never starts beside, at
   * acceptance and again once it holds the job admission: a live directive
   * request or a pending re-brief. Returns the refusal, or null. */
  creationContinuationLaneOwner(jobId: string): string | null {
    const directive = this.listPendingDirectives({ jobId, states: LIVE_DIRECTIVE_STATES, limit: 1 })[0];
    if (directive !== undefined) return `job "${jobId}" has a live directive request (${directive.requestId}, ${directive.state}) that owns the lane`;
    if (this.listPendingRebriefs({ jobId }).length > 0) return `job "${jobId}" has a pending re-brief that owns the lane`;
    return null;
  }

  /** Persist queue, actual custody, actual admission, delivery or a named
   * outcome against the exact accepted request. Delivered/admitted states
   * require their ordinary dispatch event to have landed first. */
  recordCreationContinuationState(input: {
    readonly jobId: string;
    readonly requestId: string;
    readonly generation: number;
    readonly state?: CreationContinuationState;
    readonly stage: string;
    readonly details?: Readonly<Record<string, unknown>>;
  }): CreationContinuationTimeline {
    return this.transaction(() => {
      const prior = this.getCreationContinuation(input.jobId, input.requestId);
      if (prior === null || prior.identity.generation !== input.generation) throw new CreationContinuationConflictError('creation continuation identity/generation changed');
      const terminal = prior.state === 'delivered' || prior.state === 'failed' || prior.state === 'refused' || prior.state === 'custody-unknown';
      if (terminal) {
        if (input.state === prior.state && prior.events.some((event) => (event.payload as Record<string, unknown>)['stage'] === input.stage)) return prior;
        throw new CreationContinuationConflictError(`creation continuation ${input.requestId} is already ${prior.state}`);
      }
      const state = input.state ?? prior.state;
      const allowed: Readonly<Record<CreationContinuationState, readonly CreationContinuationState[]>> = {
        accepted: ['accepted', 'queued', 'admitted', 'delivered', 'failed', 'refused', 'custody-unknown'],
        queued: ['queued', 'admitted', 'delivered', 'failed', 'refused', 'custody-unknown'],
        admitted: ['admitted', 'delivered', 'failed', 'custody-unknown'],
        delivered: [], failed: [], refused: [], 'custody-unknown': [],
      };
      if (!allowed[prior.state].includes(state)) throw new CreationContinuationConflictError(`creation continuation cannot move ${prior.state} → ${state}`);
      if (input.stage.trim() === '') throw new Error('creation continuation stage must be non-empty');
      const details = input.details ?? {};
      if (input.stage === 'custody-adopted') {
        const lane = this.getWorktree(input.jobId);
        if (lane === null || lane.branch !== prior.identity.branch || lane.sha !== prior.identity.baseSha || lane.baseSource !== prior.identity.baseSource || lane.repoPath !== prior.identity.repoPath) {
          throw new CreationContinuationConflictError('registered worktree does not match the retained continuation identity');
        }
      }
      if (state === 'admitted') {
        const spawned = this.db.prepare("SELECT * FROM events WHERE job_id = ? AND kind = 'job.minion-spawned' AND json_extract(payload, '$.creation_continuation_request_id') = ? AND json_extract(payload, '$.creation_continuation_generation') = ? ORDER BY seq DESC LIMIT 1").get(input.jobId, input.requestId, input.generation) as Row | undefined;
        if (spawned === undefined || (details['agent_id'] !== undefined && (this.eventFromRow(spawned).payload as Record<string, unknown>)['agentId'] !== details['agent_id'])) {
          throw new CreationContinuationConflictError('actual continuation admission has no matching job.minion-spawned receipt');
        }
      }
      if (state === 'delivered') {
        const delivered = this.db.prepare("SELECT 1 FROM events WHERE job_id = ? AND kind = 'job.delivered' AND json_extract(payload, '$.source') = 'dispatch' AND json_extract(payload, '$.creation_continuation_request_id') = ? AND json_extract(payload, '$.creation_continuation_generation') = ? LIMIT 1").get(input.jobId, input.requestId, input.generation);
        if (delivered === undefined) throw new CreationContinuationConflictError('delivery state requires the exact correlated job.delivered receipt');
      }
      this.appendEvent({ kind: 'job.creation-continuation', jobId: input.jobId, payload: {
        request_id: input.requestId, generation: input.generation, payload_sha256: prior.identity.payloadSha256,
        state, stage: input.stage, ...details,
      } });
      const timeline = this.getCreationContinuation(input.jobId, input.requestId);
      if (timeline === null) throw new Error('creation continuation disappeared after state write');
      return timeline;
    });
  }

  /** A job's lifetime counters for one event kind: how many such events
   * exist, and how many DISTINCT entries their JSON-array payload `field`
   * holds, an entry's identity being the named event payload keys plus the
   * named entry keys (issue #355: a re-scan of the same transcript re-reports
   * a read; the distinct count does not grow with it). One statement over
   * the COMPLETE record — one consistent snapshot, nothing ages out of a
   * window. A malformed event (no array `field`, or a non-object entry) is
   * refused by name, never counted as zero. Every key is a fixed
   * caller-supplied name (never request data). */
  countJobEventsAndDistinctArrayEntries(
    jobId: string,
    kind: string,
    field: string,
    identity: { readonly event: readonly string[]; readonly entry: readonly string[] },
  ): { readonly events: number; readonly distinct: number } {
    for (const key of [field, ...identity.event, ...identity.entry]) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
        throw new Error(`payload key must be a simple JSON key (got ${JSON.stringify(key)})`);
      }
    }
    if (identity.event.length + identity.entry.length === 0) {
      throw new Error('a distinct count needs at least one identity key');
    }
    const parts = [
      ...identity.event.map((key) => `json_extract(e.payload, '$.${key}')`),
      ...identity.entry.map((key) => `json_extract(p.value, '$.${key}')`),
    ].join(', ');
    const scope = `e.job_id = ? AND e.kind = ? AND json_type(e.payload, '$.${field}') = 'array'`;
    let row: { events: number; malformedEvents: number; malformedEntries: number; distinctEntries: number };
    try {
      row = this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM events WHERE job_id = ? AND kind = ?) AS events,
           (SELECT COUNT(*) FROM events WHERE job_id = ? AND kind = ? AND json_type(payload, '$.${field}') IS NOT 'array') AS malformedEvents,
           (SELECT COUNT(*) FROM events e, json_each(e.payload, '$.${field}') p WHERE ${scope} AND p.type <> 'object') AS malformedEntries,
           (SELECT COUNT(DISTINCT json_array(${parts})) FROM events e, json_each(e.payload, '$.${field}') p WHERE ${scope} AND p.type = 'object') AS distinctEntries`,
      )
      .get(jobId, kind, jobId, kind, jobId, kind, jobId, kind) as { events: number; malformedEvents: number; malformedEntries: number; distinctEntries: number };
    } catch (error) {
      // Only a corrupt payload is named as one (SQLite's malformed-JSON
      // error); any other failure — busy, closed, or a bad path, which is a
      // query bug — stays what it is.
      if (!/malformed JSON/iu.test(String(error))) throw error;
      throw new Error(`job "${jobId}" has a ${kind} event whose payload cannot be read as JSON (${String(error)}) — refusing to count; inspect the ledger`, { cause: error });
    }
    if (row.malformedEvents > 0 || row.malformedEntries > 0) {
      throw new Error(
        `job "${jobId}" has ${String(row.malformedEvents)} ${kind} event(s) without a "${field}" array and ${String(row.malformedEntries)} non-object "${field}" entr(ies) — refusing to count them; inspect the ledger`,
      );
    }
    return { events: Number(row.events), distinct: Number(row.distinctEntries) };
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

  /** The newest job event of one kind whose top-level payload `field`
   * equals `value` — answered over the job's COMPLETE record, so unrelated
   * traffic (even of the same kind) can never push it out of a window. */
  latestJobEventByPayloadField(jobId: string, kind: string, field: string, value: string): EventRecord | null {
    if (!/^[a-z][a-z0-9_]*$/u.test(field)) throw new Error(`latestJobEventByPayloadField: "${field}" is not a plain snake_case payload field`);
    const row = this.db
      .prepare(`SELECT * FROM events WHERE job_id = ? AND kind = ? AND json_extract(payload, ?) = ? ORDER BY seq DESC LIMIT 1`)
      .get(jobId, kind, `$.${field}`, value) as Row | undefined;
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
    /** The commissioning job (a megaminion's parent heist). Only a
     * report-type job (review/artifact/investigation) may name one, and
     * the parent must exist, share the repo, and itself be top-level;
     * every refusal is a JobParentError. */
    parentJobId?: string | null;
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
    // Job family (migration job-parent): same upgrade-fixture rule — a
    // caller that SUPPLIES a parent on an older schema fails loud.
    const parentJobId = input.parentJobId ?? null;
    if (parentJobId !== null) {
      if (!this.jobsColumns().has('parent_job_id')) {
        throw new JobParentError('job parent requires migration job-parent (the column is missing on this database)');
      }
      if (parentJobId.trim() === '') {
        throw new JobParentError('job parent_job_id must be a non-empty string when present');
      }
      if (parentJobId === input.id) {
        throw new JobParentError(`job "${input.id}" cannot name itself as its parent job`);
      }
      // A megaminion is a specialist handing back a report; a PR-owing
      // lane is a heist in its own right and never hides under another.
      if (input.deliverable === undefined || input.deliverable === null || !isReportDeliverable(input.deliverable)) {
        throw new JobParentError(
          `job "${input.id}" names parent job "${parentJobId}" but is not a report-type job — ` +
            'only review/artifact/investigation specialists nest under a heist',
        );
      }
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
      if (parentJobId !== null) {
        const parent = this.getJob(parentJobId);
        if (parent === null) {
          throw new JobParentError(`job "${input.id}" names parent job "${parentJobId}", which does not exist`);
        }
        if (parent.repo !== input.repo) {
          throw new JobParentError(
            `job "${input.id}" (repo ${input.repo}) names parent job "${parentJobId}" from another repo (${parent.repo})`,
          );
        }
        if (parent.parentJobId !== null) {
          throw new JobParentError(
            `job "${input.id}" names parent job "${parentJobId}", which is itself a child of "${parent.parentJobId}" — ` +
              'job families are one level deep; commission it from the top-level job instead',
          );
        }
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
      if (parentJobId !== null) {
        this.db.prepare('UPDATE jobs SET parent_job_id = ? WHERE id = ?').run(parentJobId, input.id);
      }
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
          ...(parentJobId !== null ? { parent_job_id: parentJobId } : {}),
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

  /** The one jobs-row status write + `job.status` event. Callers assert
   * their own transition first (the generic machine vs. the audited
   * administrative-closeout edge); the write shape lives in one place. */
  private writeJobStatus(id: string, from: JobStatus, to: JobStatus, extra?: Readonly<Record<string, unknown>>): EventRecord {
    this.db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(to, nowIso(), id);
    return this.appendEvent({ kind: 'job.status', jobId: id, payload: { ...extra, from, to } });
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
        if (status === 'binned') {
          // A discard closes debt but does NOT stop its producers. Refuse
          // atomically until the owner/chief has stopped target-owned work;
          // a bare status write must never conceal a live worker or review.
          const blockers = this.terminalLiveWorkBlockers(id);
          if (blockers.length > 0) throw new TerminalLiveWorkError(id, blockers);
        } else if (status === 'done') {
          // `done` is a decision, not an observed fact (`merged` is, and is
          // accepted): it must not close over live directive control.
          const live = this.doneBlockers(id);
          if (live.length > 0) {
            throw new Error(`job "${id}" has live directive control — settle, retire or (the owner) abandon it before marking the job done: ${live.join('; ')}`);
          }
        }
        const event = this.writeJobStatus(id, current.status, status);
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
        } else if (isJobTerminal(status)) {
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

  /** Administrative closeout (owner ruling j-1115): the ONE audited path
   * that terminalizes a parked PR-backed lane whose provider PR is
   * independently recorded CLOSED without merge. It never fakes a
   * working/in-review hop and never infers merge/READY: the lane closes as
   * `done` (the existing non-merge terminal) in one transaction that
   * appends the audit, records the direct status hop and closes the
   * applicable obligations with `job-terminal` abandonment semantics.
   *
   * Guards, all evaluated before anything is written:
   * - explicit expected state/target identity (stale requests fail loud);
   * - the job's latest recorded `github.branch-state` observation must say
   *   the PR is closed (`pr_open === false`), not merged (`merged ===
   *   false`) and name exactly the expected url + head sha;
   * - no target-owned live work: live directive requests, pending re-brief
   *   markers, spawning/streaming worker turns, non-terminal tracked
   *   children, pending/live review rounds or unsettled verification runs
   *   refuse the closeout.
   *
   * Repeated identical requests return the recorded closeout idempotently;
   * a changed request against an already-closed lane is refused, never
   * silently folded into the recorded one. Directive and re-brief rows are
   * read (a live one refuses) but never rewritten, nor are worktrees,
   * rounds, agents or children — historical uncertain-control rows stay
   * truthful history. */
  adminCloseParkedJob(input: AdminCloseoutInput): AdminCloseoutResult {
    if (input.expectedStatus !== 'parked') {
      throw new Error(
        `administrative closeout admits expected_status "parked" only (got ${JSON.stringify(input.expectedStatus)})`,
      );
    }
    const expectedPrUrl = typeof input.expectedPrUrl === 'string' ? input.expectedPrUrl.trim() : '';
    if (expectedPrUrl === '' || expectedPrUrl.length > 2_000 || /[\p{Cc}]/u.test(expectedPrUrl)) {
      throw new Error('expected_pr_url must be a bounded non-empty PR url');
    }
    // Shape: an absolute https URL with no credentials, query or fragment.
    // The recorded provider observation below still binds the exact
    // identity; this only rejects junk that could never be a PR target.
    let parsedPrUrl: URL;
    try {
      parsedPrUrl = new URL(expectedPrUrl);
    } catch {
      throw new Error('expected_pr_url must be an absolute https url');
    }
    if (
      parsedPrUrl.protocol !== 'https:' ||
      parsedPrUrl.host === '' ||
      parsedPrUrl.username !== '' ||
      parsedPrUrl.password !== '' ||
      parsedPrUrl.search !== '' ||
      parsedPrUrl.hash !== ''
    ) {
      throw new Error('expected_pr_url must be an absolute https url without credentials, query or fragment');
    }
    const evidence = input.provider;
    if (typeof evidence !== 'object' || evidence === null) {
      throw new Error('provider evidence must be an object');
    }
    if (evidence.provider !== 'github') {
      throw new Error(`administrative closeout supports provider "github" only (got ${JSON.stringify(evidence.provider)})`);
    }
    if (evidence.state !== 'closed') {
      throw new Error(`provider state must be "closed" for a closed-without-merge closeout (got ${JSON.stringify(evidence.state)})`);
    }
    if (evidence.merged !== false) {
      throw new Error('provider merged must be exactly false — a merged PR is never an administrative closeout');
    }
    const headSha = typeof evidence.headSha === 'string' ? evidence.headSha.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(headSha)) {
      throw new Error(`provider head_sha must be a full 40- or 64-character hex commit sha (got ${JSON.stringify(evidence.headSha)})`);
    }
    const closedAt = evidence.closedAt ?? null;
    if (closedAt !== null && (typeof closedAt !== 'string' || !isRealIsoUtcTimestamp(closedAt))) {
      throw new Error(`provider closed_at must be a real ISO-8601 UTC timestamp when present (got ${JSON.stringify(closedAt)})`);
    }
    const reason = input.reason.trim();
    if (reason === '' || reason.length > 2_000 || /[\p{Cc}]/u.test(reason.replaceAll('\n', '').replaceAll('\t', ''))) {
      throw new Error('reason must be bounded printable text (1-2000 characters)');
    }

    return this.transaction(() => {
      const job = this.getJob(input.jobId);
      if (job === null) throw new RecordNotFound(`job "${input.jobId}" not found`);
      // Replay identity covers every validated request field in a fixed
      // order: a changed request is a different identity, never a silent
      // overwrite of the recorded closeout. It is checked BEFORE the
      // current-row target guards so an identical retry still returns the
      // recorded event even if the lane's pr_url was later re-pointed.
      const requestSha256 = createHash('sha256')
        .update(
          JSON.stringify({
            job_id: job.id,
            expected_status: 'parked',
            expected_pr_url: expectedPrUrl,
            provider: { provider: 'github', state: 'closed', merged: false, head_sha: headSha, closed_at: closedAt },
            reason,
          }),
        )
        .digest('hex');

      if (job.status === 'done') {
        const recorded = this.latestJobEvent(job.id, 'job.admin-closeout');
        const recordedSha =
          recorded !== null && typeof recorded.payload === 'object' && recorded.payload !== null
            ? (recorded.payload as { request_sha256?: unknown }).request_sha256
            : undefined;
        if (recorded !== null && recordedSha === requestSha256) {
          return { job, event: recorded, idempotent: true };
        }
        if (recorded === null) {
          throw new AdminCloseoutRefusal(
            'already-closed',
            `job "${job.id}" is done — not by this administrative operation; re-read the record`,
          );
        }
        if (typeof recordedSha !== 'string') {
          throw new AdminCloseoutRefusal(
            'already-closed',
            `job "${job.id}" is already done and its recorded closeout (event ${recorded.seq}) carries no readable request identity — inspect the recorded event before retrying`,
          );
        }
        throw new AdminCloseoutRefusal(
          'already-closed',
          `job "${job.id}" is already done under a DIFFERENT administrative closeout request (event ${recorded.seq}); a changed request never overwrites the recorded one`,
        );
      }
      // Target identity next: a request about another PR/lane never
      // matches, whatever the current status.
      if (job.prUrl === null) {
        throw new AdminCloseoutRefusal(
          'not-pr-backed',
          `job "${job.id}" has no registered PR — administrative closeout closes PR-backed lanes only`,
        );
      }
      if (job.deliverable !== null && job.deliverable !== 'pr') {
        throw new AdminCloseoutRefusal(
          'not-pr-owing',
          `job "${job.id}" is a ${job.deliverable} lane — report-only lanes are outside the administrative closeout`,
        );
      }
      if (job.prUrl !== expectedPrUrl) {
        throw new AdminCloseoutRefusal(
          'target-mismatch',
          `job "${job.id}" registers PR "${job.prUrl}", not "${expectedPrUrl}" — stale target identity`,
        );
      }
      if (job.status !== 'parked') {
        throw new AdminCloseoutRefusal(
          'not-parked',
          `job "${job.id}" is ${job.status} — administrative closeout admits only a parked lane (expected_status "parked")`,
        );
      }

      // Provider identity: the ledger's OWN recorded observation must say
      // CLOSED without merge at exactly this target/head. No observation,
      // an open PR, a merge or a moved head all fail closed.
      const observationEvent = this.latestJobEvent(job.id, 'github.branch-state');
      const observation = observationEvent === null ? null : parseCloseoutObservation(observationEvent.payload);
      if (observationEvent === null || observation === null) {
        throw new AdminCloseoutRefusal(
          'unconfirmed-pr',
          `job "${job.id}" has no recorded provider observation — the PR state is unconfirmed; the closeout needs the poll's closed-without-merge record`,
        );
      }
      if (observation.prUrl !== expectedPrUrl) {
        throw new AdminCloseoutRefusal(
          'target-mismatch',
          `the recorded provider observation names "${observation.prUrl ?? 'no url'}", not "${expectedPrUrl}" — stale target identity`,
        );
      }
      // Defense in depth: when the observation carries a PR number or repo
      // it must agree with the number/repo the recorded URL names.
      const urlPrNumber = /\/pull\/(\d+)\/?$/u.exec(parsedPrUrl.pathname)?.[1] ?? null;
      if (observation.prNumber !== null && urlPrNumber !== null && String(observation.prNumber) !== urlPrNumber) {
        throw new AdminCloseoutRefusal(
          'target-mismatch',
          `the recorded provider observation cites PR #${String(observation.prNumber)} for "${expectedPrUrl}" — inconsistent target identity`,
        );
      }
      const urlPathSegments = parsedPrUrl.pathname.split('/').filter((segment) => segment !== '');
      const urlRepo = urlPathSegments.length >= 2 ? `${urlPathSegments[0]}/${urlPathSegments[1]}` : null;
      if (observation.repo !== null && urlRepo !== null && observation.repo !== urlRepo) {
        throw new AdminCloseoutRefusal(
          'target-mismatch',
          `the recorded provider observation names repo "${observation.repo}" for "${expectedPrUrl}" — inconsistent target identity`,
        );
      }
      if (observation.prOpen === true) {
        throw new AdminCloseoutRefusal(
          'pr-open',
          `job "${job.id}" has a recorded OPEN PR (${expectedPrUrl}) — an open PR is never administratively closed`,
        );
      }
      if (observation.prOpen !== false) {
        throw new AdminCloseoutRefusal(
          'unconfirmed-pr',
          `job "${job.id}" has no recorded closed observation for ${expectedPrUrl} — unconfirmed PR state`,
        );
      }
      if (observation.merged === true) {
        throw new AdminCloseoutRefusal(
          'pr-merged',
          `job "${job.id}" records a MERGED PR — the merge path owns that disposition, never a closeout`,
        );
      }
      if (observation.merged !== false) {
        throw new AdminCloseoutRefusal(
          'unconfirmed-pr',
          `job "${job.id}" has no recorded not-merged observation — unconfirmed merge state`,
        );
      }
      if (observation.sha === null) {
        throw new AdminCloseoutRefusal(
          'unconfirmed-pr',
          `job "${job.id}" has no recorded provider head for ${expectedPrUrl} — unconfirmed target identity`,
        );
      }
      if (observation.sha.toLowerCase() !== headSha) {
        throw new AdminCloseoutRefusal(
          'stale-head',
          `recorded provider head ${observation.sha} does not match the requested ${headSha} — stale head`,
        );
      }

      // Live-work fence: refusal names every live directive control and
      // running producer.
      const blockers = this.terminalLiveWorkBlockers(job.id);
      if (blockers.length > 0) {
        throw new AdminCloseoutRefusal(
          'live-work',
          `job "${job.id}" has target-owned live work — closeout would orphan or conceal it: ${blockers.join('; ')}`,
        );
      }

      // ONE transaction: audit first, then the direct parked → done hop,
      // then obligation closure. A throw anywhere rolls all of it back.
      assertAdminCloseoutTransition(job.status, 'done');
      const event = this.appendEvent({
        kind: 'job.admin-closeout',
        jobId: job.id,
        payload: {
          disposition: 'closed-without-merge',
          expected_status: 'parked',
          expected_pr_url: expectedPrUrl,
          provider: { provider: 'github', state: 'closed', merged: false, head_sha: headSha, closed_at: closedAt },
          observation: {
            event_seq: observationEvent.seq,
            observed_at: observationEvent.ts,
            repo: observation.repo,
            pr_url: observation.prUrl,
            pr_number: observation.prNumber,
            sha: observation.sha,
            pr_open: false,
            merged: false,
          },
          reason,
          request_sha256: requestSha256,
        },
      });
      this.writeJobStatus(job.id, 'parked', 'done');
      this.closeApplicableObligations(job.id, 'done');
      return { job: this.getJob(job.id) as JobRecord, event, idempotent: false };
    });
  }

  /** Durable blockers for binning, an irreversible discard: live directive
   * requests, pending re-brief markers and running producers. Idle/disposed/
   * historical bookkeeping rows are NOT execution evidence (issue #171
   * ownership classifies leftovers at the runtime boundary; a historical gap
   * must not block a truthful closure). */
  private terminalLiveWorkBlockers(jobId: string): readonly string[] {
    return [...this.doneBlockers(jobId), ...this.liveProducerBlockers(jobId)];
  }

  /** Live directive control by name: live directive requests and pending
   * re-brief markers. Each closes through its own path (settlement,
   * evidence-fenced retirement, re-brief recovery, owner abandonment); no
   * `done` or binned write closes over one. The single-writer rule keeps
   * the list short. */
  doneBlockers(jobId: string): readonly string[] {
    const live = this.listPendingDirectives({ jobId, states: LIVE_DIRECTIVE_STATES });
    const markers = this.listPendingRebriefs({ jobId });
    return [
      ...(live.length === 0 ? [] : [`live directive request(s): ${live.map((request) => `${request.requestId} (${request.state})`).join(', ')}`]),
      ...(markers.length === 0 ? [] : [`pending re-brief marker(s): ${markers.map((marker) => `${marker.id} (${marker.kind})`).join(', ')}`]),
    ];
  }

  /** Producers the service can see running: open worker turns, in-flight
   * admissions, non-terminal tracked children, live review rounds and
   * unsettled verification runs. */
  private liveProducerBlockers(jobId: string): readonly string[] {
    const blockers: string[] = [];
    const openTurns = this.listAgents().filter(
      (agent) => agent.jobId === jobId && (agent.state === 'spawning' || agent.state === 'streaming'),
    );
    if (openTurns.length > 0) {
      blockers.push(`open worker turn(s): ${openTurns.map((agent) => `${agent.id} (${agent.state})`).join(', ')}`);
    }
    const admissions = [...this.activeJobAdmissions].filter((entry) => entry.jobId === jobId);
    if (admissions.length > 0) {
      blockers.push(`in-flight admission(s): ${admissions.map((entry) => entry.kind).join(', ')}`);
    }
    const children = this.listChildWorkers({ jobId }).filter((child) => child.resultState === null);
    if (children.length > 0) {
      blockers.push(`non-terminal child worker(s): ${children.map((child) => child.id).join(', ')}`);
    }
    const rounds = this.listRounds(jobId).filter((round) => round.status === 'pending' || round.status === 'live');
    if (rounds.length > 0) {
      blockers.push(`live review round(s): ${rounds.map((round) => `${round.id} (${round.status})`).join(', ')}`);
    }
    if (this.hasUnsettledVerificationRun(jobId)) {
      blockers.push('unsettled verification run(s) hold the lane');
    }
    return blockers;
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
    /** Required (owner rule 1, 2026-10-08): does the approved change need
     * implementation (`material`) or not (`administrative`)? */
    readonly effect: AmendmentEffect;
  }): AddJobAmendmentResult {
    return this.transaction(() => {
      const job = this.getJob(input.jobId);
      if (job === null) {
        // events.job_id carries no foreign key, so the refusal stays visible
        // even when the named job never existed.
        return this.rejectAmendment(input.jobId, 'job-not-found', `job "${input.jobId}" not found`, input);
      }
      if (isJobTerminal(job.status)) {
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
      if (!isAmendmentEffect(input.effect)) {
        return this.rejectAmendment(
          input.jobId,
          'invalid',
          'effect must be "material" (the change requires implementation) or "administrative" (no implementation)',
          input,
        );
      }
      const requestSha = amendmentRequestSha256({
        body: input.body,
        supersedes,
        approval: input.approval,
        expectedContractSha256: input.expectedContractSha256,
        effect: input.effect,
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
        effect: input.effect,
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
             contract_sha256, request_sha256, idempotency_key, created_at, effect
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          amendment.effect,
        );
      const revision = requiredWorkRevision([...existing, amendment]);
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
          effect: amendment.effect,
          required_work_revision: revision,
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
      readonly effect?: unknown;
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
        ...(isAmendmentEffect(input.effect) ? { effect: input.effect } : {}),
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

  private amendmentEffectFromRow(row: Row): AmendmentEffect | null {
    const raw = nstr(row.effect);
    if (raw === null) return null;
    if (!isAmendmentEffect(raw)) throw new Error(`job_amendments row ${str(row.id)} has unknown effect "${raw}"`);
    return raw;
  }

  /** The job's work revisions (owner rule 2): `required` is the highest
   * material amendment version (0 when none); `delivered` is the revision
   * the newest candidate `job.delivered` carried (0 when it carried none). A review
   * may freeze only when delivered >= required. */
  workRevisionState(jobId: string): WorkRevisionState {
    const required = requiredWorkRevision(this.listJobAmendments(jobId));
    return { required, delivered: deliveredWorkRevision(this.latestCandidateDelivery(jobId)) };
  }

  latestCandidateDelivery(jobId: string): EventRecord | null {
    return this.latestDeliveryForGates(jobId, true);
  }

  /** Latest exact successful native report handback, independent of whether
   * its checkout qualifies as a code/review candidate. This is a distinct
   * projection: malformed, accepted-only, interrupted, mismatched, or
   * historical-bookkeeping delivery facts are not report completion. */
  latestReportHandbackDelivery(jobId: string): EventRecord | null {
    const job = this.getJob(jobId);
    if (job === null || job.deliverable === null || !isReportDeliverable(job.deliverable)) return null;
    const rows = this.db.prepare(`SELECT * FROM events WHERE job_id = ? AND kind = 'job.delivered'
      AND json_extract(payload, '$.source') IN ('silas-directive', 'silas-rebrief') ORDER BY seq DESC`)
      .all(jobId) as Row[];
    for (const row of rows) {
      const event = this.eventFromRow(row);
      if (this.isNativeReportHandbackDelivery(event)) return event;
    }
    return null;
  }

  /** Crash-window recovery for the ONE commissioner handback. It consumes
   * only an exact persisted native report delivery, not candidate freshness;
   * opening the obligation and its lineage event is atomic and idempotent. */
  reconcileReportHandback(jobId: string): { readonly obligation: ObligationRecord; readonly created: boolean } | null {
    return this.transaction(() => {
      const job = this.getJob(jobId);
      if (job === null || (job.status !== 'working' && job.status !== 'delivered') ||
          job.deliverable === null || !isReportDeliverable(job.deliverable)) return null;
      // Steady state: a delivered report already carrying its live obligation
      // needs no revalidation — skip the native-evidence rescan entirely.
      if (job.status === 'delivered') {
        const existing = this.findReportObligation(jobId);
        if (existing !== null && (existing.state === 'open' || existing.state === 'waiting' || existing.state === 'suspended')) {
          return { obligation: existing, created: false };
        }
      }
      const delivery = this.latestReportHandbackDelivery(jobId);
      if (delivery === null) return null;
      // A previous successful report does not prove a later follow-through
      // that reopened the lane. The exact receipt must postdate the latest
      // transition to working regardless of the job's current status: a newer
      // non-native/missing receipt may already have changed it back to delivered.
      const latestWorking = this.latestJobEventByPayloadField(jobId, 'job.status', 'to', 'working');
      if (latestWorking === null || latestWorking.seq >= delivery.seq) return null;
      // A newer request may own the lane without having changed its status yet.
      // Do not let the old report complete its handback while that work is live.
      if (this.listPendingDirectives({ jobId, states: LIVE_DIRECTIVE_STATES, limit: 1 }).length > 0 ||
          this.listPendingRebriefs({ jobId }).length > 0) return null;
      if (job.status === 'working') this.setJobStatus(jobId, 'delivered');
      return this.openReportHandbackLineage(jobId, delivery.seq);
    });
  }

  /** Open (idempotently) the one canonical commissioner obligation and
   * record its exact delivery lineage. Shared by settlement-time handback
   * and crash-window recovery so the open+lineage pair cannot drift apart. */
  private openReportHandbackLineage(jobId: string, deliveredSeq: number): { readonly obligation: ObligationRecord; readonly created: boolean } {
    const opened = this.openReportObligation({ jobId, observedAtSeq: deliveredSeq });
    if (opened.created) {
      this.appendEvent({ kind: 'job.report-handback', jobId,
        payload: { obligation_id: opened.obligation.id, delivered_seq: deliveredSeq } });
    }
    return opened;
  }

  /** Non-candidate history still owes its separate current-candidate gate.
   * Only freshness/revision projections exclude it. */
  private latestDeliveryForGates(jobId: string, candidateOnly: boolean): EventRecord | null {
    const row = this.db.prepare(`SELECT d.* FROM events d WHERE d.job_id = ? AND d.kind = 'job.delivered'
      AND (? = 0 OR COALESCE(json_extract(d.payload, '$.candidate_delivery_proven'), 1) != 0)
      AND (? = 0 OR NOT ${UNPROVEN_NATIVE_CANDIDATE_SQL})
      AND (? = 0 OR NOT ${ORIGINAL_NATIVE_GATE_DEBT_SQL}) ORDER BY d.seq DESC LIMIT 1`)
      .get(jobId, candidateOnly ? 1 : 0, candidateOnly ? 1 : 0, candidateOnly ? 1 : 0) as Row | undefined;
    return row === undefined ? null : this.eventFromRow(row);
  }

  /** Owner decision 2026-10-09 (option A): a CORRECTIVE delivery — the
   * first delivery that carried the job's current work revision (> 0) —
   * owes a passing scheduler verification on its exact head before any
   * review arms. The debt follows the newest delivery while it lasts (a
   * repair of a failed verification owes its own pass) and is discharged
   * once a review round ADMITTED after the corrective delivery (went live). Null =
   * no debt; otherwise the revision and the head that must be verified
   * (null when the delivery could not resolve its head: any later pass on
   * the job counts). */
  correctiveVerificationDebt(jobId: string): { readonly revision: number; readonly head: string | null } | null {
    const newest = this.latestDeliveryForGates(jobId, false);
    if (newest === null) return null;
    const native = (typeof newest.payload === 'object' && newest.payload !== null ? newest.payload : {}) as { candidate_delivery_proven?: unknown; work_revision?: unknown };
    if (native.candidate_delivery_proven === false || this.db.prepare(`SELECT 1 FROM events d WHERE d.seq = ? AND (${ORIGINAL_NATIVE_GATE_DEBT_SQL} OR ${UNPROVEN_NATIVE_CANDIDATE_SQL})`).get(newest.seq) !== undefined) {
      // Historical completion is a fact, not candidate authority. A later
      // proven current delivery must identify the candidate before review.
      return { revision: typeof native.work_revision === 'number' ? native.work_revision : 0, head: null };
    }
    const revision = deliveredWorkRevision(newest);
    if (revision === 0) return null;
    const first = this.db.prepare(
      `SELECT MIN(seq) AS seq FROM events
        WHERE job_id = ? AND kind = 'job.delivered' AND json_extract(payload, '$.work_revision') = ?`,
    ).get(jobId, revision) as { seq: number | null } | undefined;
    const correctiveSeq = first?.seq ?? newest.seq;
    // Only the delivery that FIRST carried this revision is corrective: an
    // earlier delivery at the same or a higher revision means the revision
    // is not new (revisions are monotonic per job).
    // Discharged only by a review that actually ADMITTED the corrected work
    // (its round went live) — a round created and then refused at
    // admission/preflight reviewed nothing.
    const payload = typeof newest.payload === 'object' && newest.payload !== null
      ? (newest.payload as { sha?: unknown }) : {};
    const head = typeof payload.sha === 'string' && payload.sha !== '' ? payload.sha : null;
    // A live round of a head delivered at or after the corrective delivery
    // (any head when the newest is unknown) admitted the corrected work; a
    // forced round of an unrelated target admits nothing.
    const reviewedSince = this.db.prepare(
      `SELECT 1 FROM events e JOIN rounds r ON r.id = e.round_id
        WHERE e.job_id = ? AND e.kind = 'round.status' AND json_extract(e.payload, '$.to') = 'live' AND e.seq > ?
          AND (? IS NULL OR r.target_ref IN (
            SELECT json_extract(d.payload, '$.sha') FROM events d
             WHERE d.job_id = ? AND d.kind = 'job.delivered' AND d.seq >= ?)) LIMIT 1`,
    ).get(jobId, correctiveSeq, head, jobId, correctiveSeq) !== undefined;
    if (reviewedSince) return null;
    // The pass must post-date the approved correction it answers: a run of
    // the same bytes recorded before the amendment proves nothing about it.
    const amendmentSeq = (this.db.prepare(
      `SELECT MAX(seq) AS seq FROM events WHERE job_id = ? AND kind = 'job.amendment-accepted'
         AND json_extract(payload, '$.version') = ?`,
    ).get(jobId, revision) as { seq: number | null } | undefined)?.seq ?? 0;
    // The LATEST clean run decides: a later failure on the same head
    // re-fences review even after an earlier pass.
    const latest = (head !== null
      ? this.db.prepare(
        `SELECT json_extract(payload, '$.ok') AS ok FROM events WHERE job_id = ? AND kind = 'verification.completed'
           AND json_extract(payload, '$.sha') = ? AND seq > ?
           AND COALESCE(json_extract(payload, '$.tracked_dirty'), 0) != 1 ORDER BY seq DESC LIMIT 1`,
      ).get(jobId, head, amendmentSeq)
      : this.db.prepare(
        `SELECT json_extract(payload, '$.ok') AS ok FROM events WHERE job_id = ? AND kind = 'verification.completed'
           AND seq > ? AND COALESCE(json_extract(payload, '$.tracked_dirty'), 0) != 1 ORDER BY seq DESC LIMIT 1`,
      ).get(jobId, newest.seq)) as { ok: number | null } | undefined;
    return latest?.ok === 1 ? null : { revision, head };
  }

  /** The job's newest `job.delivered`, read as correctiveVerificationDebt
   * reads it (`latestDeliveryForGates(jobId, false)`), and the head it
   * identifies for review: its sha, or null when that delivery is not a
   * proven current candidate (historical bookkeeping, an unproven native
   * candidate, original native gate debt) or names no full commit id (40 or
   * 64 lowercase hex characters, the only head a proof clones). Null when
   * the job has no delivery. The onboarding fence and the onboarding
   * service's follow-through both read the head here (#427 PR 1b). */
  newestDeliveredHead(jobId: string): { readonly seq: number; readonly head: string | null } | null {
    const newest = this.latestDeliveryForGates(jobId, false);
    if (newest === null) return null;
    const payload = (typeof newest.payload === 'object' && newest.payload !== null ? newest.payload : {}) as { candidate_delivery_proven?: unknown; sha?: unknown };
    if (payload.candidate_delivery_proven === false || this.db.prepare(`SELECT 1 FROM events d WHERE d.seq = ? AND (${ORIGINAL_NATIVE_GATE_DEBT_SQL} OR ${UNPROVEN_NATIVE_CANDIDATE_SQL})`).get(newest.seq) !== undefined) {
      // A current candidate delivery must identify the head.
      return { seq: newest.seq, head: null };
    }
    return { seq: newest.seq, head: typeof payload.sha === 'string' && isCommitId(payload.sha) ? payload.sha : null };
  }

  /** #427 PR 1b: an onboarding heist (a job an `onboarding.dispatched`
   * event names; that event carries the job only in its payload) is
   * reviewed only on a head code has proven. The head is the one
   * {@link newestDeliveredHead} identifies; the debt stands until the
   * FIRST `onboarding.proof` of that exact head passed (the first proof of
   * a head stands, as the onboarding service reads it). Null = no debt;
   * otherwise the head that must pass (null when there is none) and why. */
  onboardingProofDebt(jobId: string): OnboardingProofDebt | null {
    if (!this.isOnboardingJob(jobId)) return null;
    const newest = this.newestDeliveredHead(jobId);
    if (newest === null) return { head: null, reason: 'no-delivery' };
    return newest.head === null ? { head: null, reason: 'no-commit' } : this.onboardingProofOf(jobId, newest.head);
  }

  /** The proof debt of one exact head (#427 PR 1b): what a freeze of that
   * sha owes. Null when the job is no onboarding heist or the first proof
   * of that head passed. */
  onboardingProofDebtAt(jobId: string, head: string): OnboardingProofDebt | null {
    return this.isOnboardingJob(jobId) ? this.onboardingProofOf(jobId, head) : null;
  }

  /** #427: a job is an onboarding heist only when an `onboarding.dispatched` event names it. */
  isOnboardingJob(jobId: string): boolean {
    return this.db.prepare(
      `SELECT 1 FROM events WHERE kind = 'onboarding.dispatched' AND json_extract(payload, '$.job_id') = ? LIMIT 1`,
    ).get(jobId) !== undefined;
  }

  /** The FIRST `onboarding.proof` of one head of a job: the proof that
   * stands for that head (#427 PR 1b), or null when it has none. */
  firstOnboardingProof(jobId: string, head: string): EventRecord | null {
    const row = this.db.prepare(
      `SELECT * FROM events WHERE job_id = ? AND kind = 'onboarding.proof'
         AND json_extract(payload, '$.head') = ? ORDER BY seq ASC LIMIT 1`,
    ).get(jobId, head) as Row | undefined;
    return row === undefined ? null : this.eventFromRow(row);
  }

  /** Read by the one proof reader: a first record it cannot read (an
   * unknown outcome, malformed failures) fences like a failure and never
   * lifts the fence. */
  private onboardingProofOf(jobId: string, head: string): OnboardingProofDebt | null {
    const first = this.firstOnboardingProof(jobId, head);
    if (first === null) return { head, reason: 'unproven' };
    return readOnboardingProof(first.payload)?.passed === true ? null : { head, reason: 'failed' };
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
      effect: this.amendmentEffectFromRow(row),
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
          `INSERT INTO worktrees (id, kind, repo_path, repo_name, path, branch, sha, base_source, job_id, round_id, status, note, created_at, updated_at, lane_token)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?)`,
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
          newLaneToken(),
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

  /** #486: the lane not yet swept whose registered path is exactly `path`
   * (paths are unique), or null: the lane a session spawned there belongs to. */
  findLiveWorktreeAtPath(path: string): WorktreeRecord | null {
    const row = this.db.prepare("SELECT * FROM worktrees WHERE path = ? AND status <> 'swept'").get(path) as Row | undefined;
    return row === undefined ? null : this.worktreeFromRow(row);
  }

  /** #486: the lane a lane token belongs to, or null. */
  findWorktreeByLaneToken(token: string): WorktreeRecord | null {
    const row = this.db.prepare('SELECT * FROM worktrees WHERE lane_token = ?').get(token) as Row | undefined;
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
      // #464: a swept tree holds no process; what is still recorded live
      // left on its own, in the same transaction as the sweep.
      if (status === 'swept') this.recordWorktreeProcessesExited({ worktreeId: id, pids: 'all-live', reason: 'worktree-swept' });
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

  /** Point a lane at its repository's new place (#427 PR 2b): `repo_path`
   * changes (no migration: the column exists; it may stay the same when
   * only the repository's git directory moved) and `worktree.repo-moved
   * { id, from, to }` is recorded, with, in the same transaction and the
   * very next event, the rebinding of the lane's creation handoff
   * (`worktree.handoff-rebound { id, from, to, move_seq }`, `move_seq` the
   * move's seq) when it has one. Custody takes a rebinding only so paired,
   * and appendCustomEvent refuses both kinds. A move to the same
   * `repo_path` is refused unless its rebinding moves the repository's
   * real place or its git directory: nothing moved, so nothing is recorded. */
  moveWorktreeRepo(input: { readonly id: string; readonly repoPath: string; readonly rebind: Pick<LaneRebind, 'from' | 'to'> | null }): WorktreeRecord {
    if (input.repoPath === '') throw new Error('a moved worktree needs its new repo path');
    return this.transaction(() => {
      const current = this.getWorktree(input.id);
      if (current === null) throw new RecordNotFound(`worktree "${input.id}" not found`);
      if (input.repoPath === current.repoPath &&
        (input.rebind === null || (input.rebind.from.repo === input.rebind.to.repo && input.rebind.from.common === input.rebind.to.common))) {
        throw new Error(`worktree "${input.id}" did not move: its repository stays at ${current.repoPath} and its git directory did not move, so no move of it is recorded`);
      }
      this.db.prepare('UPDATE worktrees SET repo_path = ?, updated_at = ? WHERE id = ?').run(input.repoPath, nowIso(), input.id);
      const move = this.appendEvent({
        kind: REPO_MOVED_KIND,
        jobId: current.jobId,
        roundId: current.roundId,
        payload: { id: input.id, from: current.repoPath, to: input.repoPath },
      });
      if (input.rebind !== null) {
        this.appendEvent({
          kind: HANDOFF_REBOUND_KIND,
          jobId: current.jobId,
          roundId: current.roundId,
          payload: { id: input.id, from: input.rebind.from, to: input.rebind.to, move_seq: move.seq },
        });
      }
      return this.getWorktree(input.id) as WorktreeRecord;
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
      // #464: a row that exited returns to live only through a pause's fresh
      // enumeration of a process rooted in the tree again (never by pid
      // liveness), and the event says so.
      const exited = this.db.prepare("SELECT 1 FROM worktree_processes WHERE worktree_id = ? AND pid = ? AND state = 'exited'");
      const revived = input.state === 'live'
        ? input.processes.map((proc) => proc.pid).filter((pid) => exited.get(input.worktreeId, pid) !== undefined) : [];
      const upsert = this.db.prepare(
        `INSERT INTO worktree_processes (worktree_id, pid, command, evidence, state, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (worktree_id, pid) DO UPDATE SET
           state = excluded.state,
           command = excluded.command,
           last_seen = excluded.last_seen,
           -- #486: a reap by the lane's token is the row's proof, whatever
           -- first tied the pid to the tree; and a row that had left 'live'
           -- (killed, exited) recorded live again is another process, or one
           -- seen afresh, with the evidence it is seen by now (stale
           -- 'registry' or 'lane-token' proof never carries over). A live row
           -- keeps the evidence it was first found by.
           evidence = CASE WHEN excluded.evidence = 'lane-token' OR (state <> 'live' AND excluded.state = 'live') THEN excluded.evidence ELSE evidence END`,
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
          ...(revived.length > 0 ? { revived } : {}),
        },
      });
    });
  }

  /** #464: recorded `live` processes that left the tree move to `exited`
   * with one audited event:
   * - `not-enumerated`: named pids a release's fresh enumeration no longer
   *   finds rooted in the tree, and that are dead;
   * - `worktree-swept`: every remaining live row of a swept tree, except the
   *   `registry` rows their own reconcile owns.
   * Rows already out of `live` are untouched. Returns the pids moved. */
  recordWorktreeProcessesExited(input:
    | { readonly worktreeId: string; readonly reason: 'not-enumerated'; readonly pids: readonly number[] }
    | { readonly worktreeId: string; readonly reason: 'worktree-swept'; readonly pids: 'all-live' }): readonly number[] {
    return this.transaction(() => {
      const worktree = this.getWorktree(input.worktreeId);
      if (worktree === null) throw new RecordNotFound(`worktree "${input.worktreeId}" not found`);
      if (input.reason === 'worktree-swept' && worktree.status !== 'swept') {
        throw new Error(`worktree "${input.worktreeId}" is ${worktree.status}, not swept: its processes are not proven gone`);
      }
      const live = (this.db.prepare("SELECT pid FROM worktree_processes WHERE worktree_id = ? AND state = 'live' AND evidence <> 'registry' ORDER BY pid")
        .all(input.worktreeId) as Row[]).map((row) => Number(row.pid));
      const wanted = input.pids === 'all-live' ? null : new Set(input.pids);
      const moved = live.filter((pid) => wanted === null || wanted.has(pid));
      if (moved.length === 0) return [];
      const ts = nowIso();
      const exit = this.db.prepare("UPDATE worktree_processes SET state = 'exited', last_seen = ? WHERE worktree_id = ? AND pid = ? AND state = 'live'");
      for (const pid of moved) exit.run(ts, input.worktreeId, pid);
      this.appendEvent({
        kind: 'worktree.processes-exited',
        jobId: worktree.jobId,
        roundId: worktree.roundId,
        payload: { id: input.worktreeId, pids: moved, reason: input.reason },
      });
      return moved;
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
      if (isJobTerminal(job.status)) {
        throw new Error(`cannot create a review round for terminal job "${input.jobId}" (${job.status})`);
      }
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

  /** {@link admitReviewRound}, also returning the round's OWN provisional
   * status event (null when the job was not flipped) — read inside the
   * transaction, so a subscriber that writes another status when the flip
   * is published can never be mistaken for it (R8-10). */
  admitReviewRoundWithFlip(input: Parameters<LedgerApi['admitReviewRound']>[0]): { readonly round: RoundRecord; readonly flipSeq: number | null } {
    return this.transaction(() => {
      const before = this.latestJobEvent(input.jobId, 'job.status')?.seq ?? 0;
      const round = this.admitReviewRound(input);
      const flip = this.db.prepare(
        "SELECT seq FROM events WHERE job_id = ? AND kind = 'job.status' AND seq > ? ORDER BY seq ASC LIMIT 1",
      ).get(input.jobId, before) as { seq: number } | undefined;
      return { round, flipSeq: flip === undefined ? null : Number(flip.seq) };
    });
  }

  /** Undo only this round's provisional status flip. An admitted successor
   * owns the job status now: an older setup failure must not roll it back. */
  restoreReviewSetupStatus(input: {
    readonly jobId: string;
    readonly roundId: string;
    readonly priorStatus: 'working' | 'blocked';
    /** The open attempt the round interrupted (`openAttemptStartSeq` at its
     * flip). A restored `working` hop resumes that attempt — it is not a
     * reopened lane, so its earlier delivery still settles it. */
    readonly attemptStartSeq?: number;
    /** This round's own provisional status event (R7-10): restore only
     * while it is still the job's latest status event — a generation
     * written since (a reopened attempt) is never undone or concealed. */
    readonly expectedStatusSeq?: number;
  }): boolean {
    return this.transaction(() => {
      const job = this.getJob(input.jobId);
      const round = this.getRound(input.roundId);
      const latest = this.db.prepare('SELECT id FROM rounds WHERE job_id = ? ORDER BY seq DESC LIMIT 1')
        .get(input.jobId) as { id: string } | undefined;
      if (job?.status !== 'in-review' || round?.jobId !== input.jobId ||
        round.status !== 'aborted' || latest?.id !== input.roundId) return false;
      if (input.expectedStatusSeq !== undefined &&
        this.latestJobEvent(input.jobId, 'job.status')?.seq !== input.expectedStatusSeq) return false;
      if (input.priorStatus === 'working' && input.attemptStartSeq !== undefined) {
        assertJobTransition(job.status, 'working');
        this.writeJobStatus(input.jobId, job.status, 'working', {
          restoredAfterRound: input.roundId, attemptStartSeq: input.attemptStartSeq,
        });
      } else {
        this.setJobStatus(input.jobId, input.priorStatus);
      }
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

  latestSupervisionEvent(agentId: string): EventRecord | null {
    const row = this.db.prepare(`SELECT * FROM events WHERE agent_id = ?
      AND kind IN ('supervision.escalated', 'supervision.breaker', 'supervision.rearmed', 'supervision.rearm-fenced', 'supervision.stop-superseded') ORDER BY seq DESC LIMIT 1`).get(agentId) as Row | undefined;
    return row === undefined ? null : this.eventFromRow(row);
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

  /** Whether a breaker alert's stop was closed as superseded (#385): the
   * durable record a retried disposition is answered from, across restarts. */
  hasSupervisionStopSuperseded(notificationId: string): boolean {
    return this.supervisionStopClosure(notificationId) !== undefined;
  }

  /** The FIRST recorded closure of this alert's stop — the binding one.
   * Every closure this ledger writes names a non-blank agent and job (the
   * writer's own rule, applied here the same way); a row missing either
   * (never written here) closes no alert's stop: neither this lookup nor a
   * replayed write binds to it. Restart hydration is separate — it reads an
   * agent's own latest lifecycle row by agent id. */
  private supervisionStopClosure(notificationId: string): { readonly agentId: string; readonly jobId: string } | undefined {
    const rows = this.db.prepare(
      "SELECT agent_id AS agentId, job_id AS jobId FROM events WHERE kind = 'supervision.stop-superseded' AND json_extract(payload, '$.notification_id') = ? ORDER BY seq ASC",
    ).all(notificationId) as Array<{ agentId: unknown; jobId: unknown }>;
    const complete = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
    const first = rows.find((row) => complete(row.agentId) && complete(row.jobId));
    return first === undefined ? undefined : { agentId: first.agentId as string, jobId: first.jobId as string };
  }

  /** Records a superseded-stop closure (#385) at most ONCE per alert: the
   * check and the append share one transaction, so no interleaving can
   * record it twice. True when this call recorded it. */
  recordSupervisionStopSuperseded(input: {
    readonly agentId: string;
    readonly jobId: string;
    readonly payload: Readonly<Record<string, unknown>> & { readonly notification_id: string };
  }): boolean {
    for (const [name, value] of [['agentId', input.agentId], ['jobId', input.jobId], ['notification_id', input.payload.notification_id]] as const) {
      if (typeof value !== 'string' || value.trim() === '') throw new Error(`a superseded-stop closure needs a non-blank ${name}`);
    }
    if (input.payload['job_id'] !== undefined && input.payload['job_id'] !== input.jobId) {
      throw new Error(`a superseded-stop closure names job "${String(input.payload['job_id'])}" in its payload but "${input.jobId}" as its job`);
    }
    return this.transaction(() => {
      const prior = this.supervisionStopClosure(input.payload.notification_id);
      if (prior !== undefined) {
        // The same alert closes ONE stop: a replay naming another agent or
        // job is a conflict, never "already recorded".
        if (prior.agentId !== input.agentId || prior.jobId !== input.jobId) {
          throw new SupervisionStopClosureConflictError(`alert "${input.payload.notification_id}" already closed the stop of agent "${prior.agentId}" on job "${prior.jobId}" — not agent "${input.agentId}" on job "${input.jobId}"`);
        }
        return false;
      }
      this.appendCustomEvent({ kind: 'supervision.stop-superseded', agentId: input.agentId, jobId: input.jobId, payload: { ...input.payload } });
      return true;
    });
  }

  /**
   * Durable supervision stop truth for restart hydration (code review
   * 2026-10-04): the latest supervision lifecycle event per agent, kept
   * only when that latest event is a STOP. A re-arm event clears the stop;
   * a later re-arm-fenced event restores stop truth, so an accepted re-arm
   * followed by asynchronous refusal remains stopped after a restart.
   */
  durableSupervisionStops(): Map<
    string,
    {
      readonly role: Role;
      readonly reason: string | null;
      readonly restarts: number;
      readonly notificationId: string | null;
      readonly pendingFenceReason: string | null;
    }
  > {
    const rows = this.db
      .prepare(
        `SELECT e.agent_id AS agent_id, a.role AS role, e.kind AS kind, e.payload AS payload
           FROM events e
           JOIN (
             SELECT agent_id, MAX(seq) AS seq
               FROM events
              WHERE agent_id IS NOT NULL
                AND kind IN ('supervision.escalated', 'supervision.breaker', 'supervision.rearmed', 'supervision.rearm-fenced', 'supervision.stop-superseded')
              GROUP BY agent_id
           ) latest ON latest.agent_id = e.agent_id AND latest.seq = e.seq
           JOIN agents a ON a.id = e.agent_id
          WHERE e.kind IN ('supervision.escalated', 'supervision.breaker', 'supervision.rearm-fenced')`,
      )
      .all() as Array<{ agent_id: string; role: Role; payload: string }>;
    const stops = new Map<
      string,
      {
        role: Role;
        reason: string | null;
        restarts: number;
        notificationId: string | null;
        pendingFenceReason: string | null;
      }
    >();
    for (const row of rows) {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        // A malformed payload still yields a cause-less stop: the presence
        // of the stop event is the authoritative fact.
      }
      const reason =
        typeof payload['stop_reason'] === 'string'
          ? payload['stop_reason']
          : typeof payload['class'] === 'string'
            ? payload['class']
            : typeof payload['reason'] === 'string'
              ? payload['reason']
              : null;
      const restarts =
        typeof payload['restarts'] === 'number' && Number.isFinite(payload['restarts'])
          ? payload['restarts']
          : 0;
      const pendingFenceReason =
        typeof payload['pending_rearm_fence_reason'] === 'string' ? payload['pending_rearm_fence_reason'] : null;
      let notificationId =
        typeof payload['control_notification_id'] === 'string'
          ? payload['control_notification_id']
          : typeof payload['notification_id'] === 'string'
            ? payload['notification_id']
            : null;
      if (notificationId !== null) {
        const openControl = this.db
          .prepare('SELECT id FROM notifications WHERE id = ? AND resolved_at IS NULL AND acked_at IS NULL')
          .get(notificationId) as { id: string } | undefined;
        if (openControl === undefined) notificationId = null;
      }
      if (notificationId === null) {
        const openControl = this.db
          .prepare(
            `SELECT id FROM notifications
              WHERE agent_id = ?
                AND resolved_at IS NULL
                AND acked_at IS NULL
                AND (
                  kind IN ('supervision.breaker', 'supervision.rearm-fenced')
                  OR kind LIKE 'supervision.provider-wall.%'
                )
              ORDER BY ts DESC, id DESC
              LIMIT 1`,
          )
          .get(row.agent_id) as { id: string } | undefined;
        notificationId = openControl?.id ?? null;
      }
      stops.set(row.agent_id, { role: row.role, reason, restarts, notificationId, pendingFenceReason });
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

  /** Issue #161: the child workers that have not finished and that a
   * release of `lane` would abandon: a child lane's own child, or every one
   * of a job lane's job. Every release an operator or the owner asks for
   * refuses while any is left (#486: the owner's answer to a paused sweep's
   * card too). */
  unfinishedChildWorkersOf(lane: Pick<WorktreeLane, 'id' | 'kind' | 'jobId'>): readonly ChildWorkerRecord[] {
    if (lane.kind === 'child') {
      const child = this.getChildWorker(lane.id);
      return child !== null && child.resultState === null ? [child] : [];
    }
    if (lane.kind !== 'job' || lane.jobId === null) return [];
    return this.listChildWorkers({ jobId: lane.jobId }).filter((child) => child.resultState === null);
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
    // A lane's move and its handoff's rebinding are custody facts only
    // moveWorktreeRepo records, together (#427 PR 2b).
    if (fields.kind === REPO_MOVED_KIND || fields.kind === HANDOFF_REBOUND_KIND) {
      throw new Error(`${fields.kind} is recorded only with a lane's repository move (moveWorktreeRepo), never as a custom event`);
    }
    if (fields.kind === REVIEW_OWNER_CEASED_KIND) {
      throw new Error(`${fields.kind} is recorded only through recordReviewOwnerCessation, which binds it to the round's owner marker, never as a custom event`);
    }
    if (fields.kind === 'job.creation-producer-settled' || fields.kind === 'job.creation-continuation') {
      throw new Error(`${fields.kind} is recorded only through its typed creation-continuation method`);
    }
    return this.transaction(() => {
      if (fields.kind === 'silas.directive-producer-ceased' || fields.kind === 'silas.directive-producer-unknown') {
        this.validateDirectiveProducerReceipt(fields.jobId ?? null, fields.payload);
      }
      return this.appendEvent({
        kind: fields.kind,
        agentId: fields.agentId ?? null,
        jobId: fields.jobId ?? null,
        roundId: fields.roundId ?? null,
        lens: fields.lens ?? null,
        payload: fields.payload,
      });
    });
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
    /** Firing-rule provenance (issue #117): the named Silas rule and the
     * round it consumes. Persisted in the marker payload so the receipt
     * carries them even when a restart replays the request. `source`
     * (issue #243 M3) rides the same payload so an autopilot-minted
     * re-brief's receipt is attributable. */
    ruleId?: string;
    sourceRoundId?: string;
    source?: string;
  }): readonly PendingRebriefRecord[] {
    return this.transaction(() => {
      // The revision is bound in the SAME transaction as the marker: the
      // fresh worker's prompt carries the effective contract at exactly this
      // revision, and the re-brief delivery carries it as its receipt.
      const payload = JSON.stringify({
        note: input.note,
        briefing: input.briefing,
        ...(input.ruleId !== undefined ? { rule_id: input.ruleId } : {}),
        ...(input.sourceRoundId !== undefined ? { source_round_id: input.sourceRoundId } : {}),
        ...(input.source !== undefined ? { source: input.source } : {}),
        work_revision: requiredWorkRevision(this.listJobAmendments(input.jobId)),
      });
      const payloadHash = createHash('sha256').update(payload).digest('hex');
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
      // One writer per lane (owner rule 5): a live directive request may
      // already be prompting the lane's minion.
      const liveDirective = this.listPendingDirectives({ jobId: input.jobId, states: LIVE_DIRECTIVE_STATES, limit: 1 })[0];
      if (liveDirective !== undefined) {
        throw new LaneWriterConflictError(
          `job "${input.jobId}" has a live directive request (${liveDirective.requestId}, ${liveDirective.state}) — ` +
            'it owns the lane; wait for it to settle or retire it before re-briefing',
        );
      }
      this.assertNoProviderProducer(input.jobId);
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
      // A fresh accepted re-brief is a separately authorized, identity-
      // checked handoff too: it supersedes an open retirement hold on this
      // lane, and its marker id is the recorded releaser.
      const markers = this.listPendingRebriefs({ jobId: input.jobId });
      const releaser = markers[0]?.id ?? `rebrief:${input.jobId}`;
      this.releaseDirectiveRecoveryHolds(input.jobId, releaser);
      return markers;
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

  /** Page whole historical job generations, never half a marker pair.
   * The row cursor is observation fairness only, not effect/work authority. */
  listPendingRebriefGroups(input: { readonly afterRowid: number; readonly limit: number }): readonly {
    readonly jobId: string; readonly cursor: number;
  }[] {
    if (!Number.isSafeInteger(input.afterRowid) || input.afterRowid < 0 ||
        !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1000) {
      throw new Error('historical rebrief observation requires a nonnegative row cursor and a job limit of 1–1000');
    }
    const rows = this.db.prepare(`SELECT job_id, MIN(rowid) AS cursor FROM pending_rebriefs
      GROUP BY job_id HAVING MIN(rowid) > ? ORDER BY cursor LIMIT ?`).all(input.afterRowid, input.limit) as Row[];
    return rows.map((row) => ({ jobId: str(row.job_id), cursor: Number(row.cursor) }));
  }

  /** Exact historical receipt interpretation shared by observation,
   * transactional settlement, retirement audit and guarded Gru decisions.
   * A sequence watermark alone is never request correlation. */
  pendingRebriefReceipt(marker: PendingRebriefRecord, eventSeq?: number): EventRecord | null {
    const raw = this.db.prepare('SELECT * FROM pending_rebriefs WHERE id = ?').get(marker.id) as Row | undefined;
    if (raw === undefined || str(raw.job_id) !== marker.jobId || str(raw.kind) !== marker.kind ||
        Number(raw.baseline_seq) !== marker.baselineSeq || nstr(raw.phase_id) !== marker.phaseId ||
        nstr(raw.agent_id) !== marker.agentId || str(raw.payload_hash) !== marker.payloadHash ||
        createHash('sha256').update(str(raw.payload)).digest('hex') !== marker.payloadHash) return null;
    const phase = marker.phaseId === null ? null : this.getPhaseHandoff(marker.phaseId);
    if (marker.phaseId !== null && (phase === null || phase.jobId !== marker.jobId ||
        phase.source !== 'silas-rebrief' || phase.intentSeq !== marker.baselineSeq ||
        phase.requestId !== null && phase.requestId !== marker.id ||
        phase.minionId !== null && marker.agentId !== null && phase.minionId !== marker.agentId)) return null;
    const peers = this.db.prepare('SELECT * FROM pending_rebriefs WHERE job_id = ? AND baseline_seq = ? AND payload_hash = ? AND phase_id IS ?')
      .all(marker.jobId, marker.baselineSeq, marker.payloadHash, marker.phaseId) as Row[];
    const minions = new Set([marker.agentId, phase?.minionId ?? null, ...peers.map((peer) => nstr(peer.agent_id))].filter((id): id is string => id !== null));
    if (minions.size > 1) return null;
    const expectedMinion = [...minions][0] ?? null;
    // An unmarked receipt needs all original identity facts; none may be
    // borrowed from today's approval or a newer worker/session.
    if (expectedMinion === null || phase === null && marker.workRevision === null) return null;
    const revisions = new Set([marker.workRevision, ...peers.map((peer) => this.pendingRebriefFromRow(peer).workRevision)]
      .filter((revision): revision is number => revision !== null));
    if (revisions.size > 1) return null;
    const expectedRevision = [...revisions][0] ?? null;
    if (phase !== null && expectedRevision !== null) {
      // Old production silas.rebrief receipts did not duplicate revision.
      // The immutable original phase supplies correlation, not today's
      // revision. Every available same-generation receipt must agree.
      const conflicting = this.db.prepare(`SELECT seq FROM events WHERE job_id = ? AND seq > ?
        AND kind IN ('silas.rebrief', 'job.delivered') AND json_extract(payload, '$.phase_id') = ?
        AND json_type(payload, '$.work_revision') IS NOT NULL
        AND (json_type(payload, '$.work_revision') != 'integer' OR json_extract(payload, '$.work_revision') != ?)
        AND (json_type(payload, '$.payload_hash') IS NULL OR json_extract(payload, '$.payload_hash') = ?)
        AND (json_type(payload, '$.marker_id') IS NULL OR json_extract(payload, '$.marker_id') IN (${peers.map(() => '?').join(',')})) LIMIT 1`)
        .get(marker.jobId, marker.baselineSeq, marker.phaseId, expectedRevision, marker.payloadHash, ...peers.map((peer) => str(peer.id)));
      if (conflicting !== undefined) return null;
    }
    const where = ['job_id = ?', 'kind = ?', 'seq > ?'];
    const params: (string | number | null)[] = [marker.jobId, marker.kind, marker.baselineSeq];
    if (phase === null) {
      where.push("json_extract(payload, '$.marker_id') = ?", "json_extract(payload, '$.payload_hash') = ?",
        "(json_type(payload, '$.phase_id') IS NULL OR json_extract(payload, '$.phase_id') IS NULL)");
      params.push(marker.id, marker.payloadHash);
    } else {
      where.push("json_extract(payload, '$.phase_id') = ?",
        "(json_type(payload, '$.marker_id') IS NULL OR json_extract(payload, '$.marker_id') = ?)",
        "(json_type(payload, '$.payload_hash') IS NULL OR json_extract(payload, '$.payload_hash') = ?)");
      params.push(marker.phaseId, marker.id, marker.payloadHash);
    }
    const minionKey = marker.kind === 'silas.rebrief' ? 'minion_id' : 'agentId';
    where.push(`json_type(payload, '$.${minionKey}') = 'text'`, `length(json_extract(payload, '$.${minionKey}')) > 0`);
    if (expectedMinion !== null) {
      where.push(`json_extract(payload, '$.${minionKey}') = ?`);
      params.push(expectedMinion);
    }
    if (expectedRevision !== null) {
      where.push(phase === null || marker.kind === 'job.delivered' ?
        "(json_type(payload, '$.work_revision') = 'integer' AND json_extract(payload, '$.work_revision') = ?)" :
        "(json_type(payload, '$.work_revision') IS NULL OR (json_type(payload, '$.work_revision') = 'integer' AND json_extract(payload, '$.work_revision') = ?))");
      params.push(expectedRevision);
    }
    const predicate = where.join(' AND ');
    const row = this.db.prepare(`SELECT * FROM events WHERE ${predicate}${eventSeq === undefined ? '' : ' AND seq = ?'} ORDER BY seq DESC LIMIT 1`)
      .get(...params, ...(eventSeq === undefined ? [] : [eventSeq])) as Row | undefined;
    if (row === undefined) return null;
    const receipt = this.eventFromRow(row);
    const head = (receipt.payload as { readonly sha?: unknown } | null)?.sha;
    // A requested event seq is a readback selector, not permission to hide
    // another correlated receipt's contradictory original completion HEAD.
    const conflict = this.db.prepare(`SELECT seq FROM events WHERE ${predicate}
      AND json_type(payload, '$.sha') IS NOT NULL AND json_extract(payload, '$.sha') IS NOT ? LIMIT 1`)
      .get(...params, typeof head === 'string' ? head : null);
    return conflict === undefined ? receipt : null;
  }

  originalRebriefDeliveryFacts(markerId: string): { readonly completionSeq: number; readonly minionId: string; readonly sha: string; readonly workRevision: number } | null {
    const marker = this.listPendingRebriefs().find((row) => row.id === markerId && row.kind === 'silas.rebrief');
    if (marker === undefined) return null;
    const receipt = this.pendingRebriefReceipt(marker);
    const payload = receipt?.payload as { minion_id?: unknown; sha?: unknown; work_revision?: unknown } | undefined;
    // pendingRebriefReceipt independently correlates the exact original
    // phase/generation/minion and every available revision. Old marked
    // completions need not duplicate their original marker's revision.
    // An unmarked or unknown original must never borrow today's revision.
    const workRevision = payload?.work_revision === undefined && marker.phaseId !== null
      ? marker.workRevision : payload?.work_revision;
    if (receipt === null || typeof payload?.minion_id !== 'string' || typeof payload.sha !== 'string' ||
        !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(payload.sha) || typeof workRevision !== 'number' ||
        !Number.isSafeInteger(workRevision) || workRevision < 0) return null;
    return { completionSeq: receipt.seq, minionId: payload.minion_id, sha: payload.sha, workRevision };
  }

  /** Current eligibility is separate from immutable historical outcome.
   * Only the original successful native HEAD/identity plus an exact clean
   * current job lane can establish candidate proof; caller flags cannot. */
  private rebriefCurrentCandidateProof(marker: PendingRebriefRecord,
    facts: NonNullable<ReturnType<LedgerApi['originalRebriefDeliveryFacts']>>, lane?: WorktreeLane) {
    if (lane === undefined || lane.kind !== 'job' || lane.status !== 'active' || lane.jobId !== marker.jobId || marker.sessionFile === null) return null;
    const binding = readDirectiveBinding(marker.sessionFile, marker.id);
    if (binding === null || binding.agentId !== facts.minionId || binding.identity.jobId !== marker.jobId ||
        binding.identity.payloadHash !== marker.payloadHash || binding.identity.workRevision !== facts.workRevision) return null;
    const proof = inspectDirectiveCheckpoint(marker.sessionFile, binding.identity);
    if (proof.state !== 'terminal' || !proof.ok || !isDeepStrictEqual(proof.binding, binding)) return null;
    const receipt = readDirectiveCompletion(marker.sessionFile, binding.identity, proof.checkpointId);
    if (receipt === null || receipt.head !== facts.sha) return null;
    const header = readDirectiveSessionHeader(marker.sessionFile);
    if (header.cwd !== lane.path || header.id !== binding.sessionId) return null;
    const current = this.directiveCurrentAuthority(marker.jobId);
    if (current.workRevision !== facts.workRevision || current.contractSha256 !== binding.identity.contractSha256 ||
        current.authorityEpoch !== binding.identity.authorityEpoch) return null;
    try { this.assertRecoveryJobPermission(marker.jobId); }
    catch (error) { if (error instanceof DirectiveCheckpointError) return null; throw error; }
    const git = readGitState(lane.path, { includeUntracked: true });
    if (git.sha !== facts.sha || git.trackedDirty || lane.branch === null) return null;
    try {
      const branch = execFileSync('git', ['-C', lane.path, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
      if (branch !== lane.branch) return null;
    } catch { return null; } // unavailable branch proves no candidacy; original completion is retained separately
    return { lane_id: lane.id, lane_path: lane.path, sha: facts.sha, identity: binding.identity,
      checkpoint_id: proof.checkpointId, binding, receipt };
  }

  /** Reconstruct only explicit ORIGINAL facts. Today's branch or approval
   * never supplies a historical SHA/revision. Optional current-lane proof
   * determines candidate eligibility separately, without executing work. */
  reconstructCompletedRebriefDelivery(expected: readonly PendingRebriefRecord[], currentLane?: WorktreeLane): EventRecord | null {
    return this.transaction(() => {
      const jobId = expected[0]?.jobId;
      if (jobId === undefined || !this.matchesPendingRebriefGeneration(jobId, expected)) throw new PendingRebriefNoLongerCurrent('superseded');
      const job = this.getJob(jobId);
      if (job === null || isJobTerminal(job.status)) throw new PendingRebriefNoLongerCurrent('terminal');
      const completion = expected.find((row) => row.kind === 'silas.rebrief');
      const delivery = expected.find((row) => row.kind === 'job.delivered');
      if (completion === undefined || delivery === undefined) throw new DirectiveCheckpointError('historical lost delivery requires a coherent exact generation');
      const existing = this.pendingRebriefReceipt(delivery);
      if (existing !== null) return existing;
      const facts = this.originalRebriefDeliveryFacts(completion.id);
      if (facts === null) return null;
      // This is ledger-only reconstruction from immutable original facts:
      // no current checkout is needed, but every job/lane producer remains
      // fenced by the same complete retirement ownership predicate.
      const blockers = this.rebriefProgressBlockers(completion.id, jobId);
      if (blockers.length > 0) throw new DirectiveCheckpointError(`original delivery reconstruction producer cessation unproven: ${blockers.join('; ')}`);
      if (!this.matchesPendingRebriefGeneration(jobId, expected)) throw new PendingRebriefNoLongerCurrent('superseded');
      const currentJob = this.getJob(jobId);
      if (currentJob === null || isJobTerminal(currentJob.status)) throw new PendingRebriefNoLongerCurrent('terminal');
      const candidateProof = this.rebriefCurrentCandidateProof(completion, facts, currentLane);
      const finalBlockers = candidateProof === null ? [] : this.rebriefProgressBlockers(completion.id, jobId);
      if (finalBlockers.length > 0) throw new DirectiveCheckpointError(`current candidate producer cessation unproven: ${finalBlockers.join('; ')}`);
      const reconstructed = this.appendEvent({ kind: 'job.delivered', jobId, agentId: facts.minionId,
        payload: { agentId: facts.minionId, source: 'silas-rebrief', sha: facts.sha, work_revision: facts.workRevision,
          candidate_delivery_proven: candidateProof !== null, historical_bookkeeping_only: true, current_candidate_proof: candidateProof,
          marker_id: delivery.id, payload_hash: delivery.payloadHash, ...(delivery.phaseId === null ? {} : { phase_id: delivery.phaseId }),
          provenance: { kind: 'original-correlated-completion', event_seq: facts.completionSeq } } });
      this.ensureReportHandback(jobId, reconstructed.seq);
      return reconstructed;
    });
  }

  /** Versioned stale-input fence, not completion/cessation/permission proof.
   * Potentially relevant conflicting receipts remain explicitly unproven;
   * explicit other generations/jobs do not perturb this subject. */
  rebriefReceiptEvidence(markerId: string): RebriefReceiptEvidence {
    const markerRow = this.db.prepare('SELECT * FROM pending_rebriefs WHERE id = ?').get(markerId) as Row | undefined;
    if (markerRow === undefined) throw new RecordNotFound(`rebrief marker "${markerId}" not found`);
    const marker = this.pendingRebriefFromRow(markerRow);
    const group = this.listPendingRebriefs({ jobId: marker.jobId });
    const markers = group.map(({ id, jobId, kind, payloadHash, baselineSeq, phaseId, agentId, sessionFile, workRevision }) =>
      ({ id, jobId, kind, payloadHash, baselineSeq, phaseId, agentId, sessionFile, workRevision }));
    const phaseRow = marker.phaseId === null ? null : this.getPhaseHandoff(marker.phaseId);
    const phase = phaseRow === null ? null : { phaseId: phaseRow.phaseId, jobId: phaseRow.jobId, source: phaseRow.source,
      requestId: phaseRow.requestId, generation: phaseRow.generation, intentSeq: phaseRow.intentSeq, minionId: phaseRow.minionId };
    const ids = group.map((row) => row.id);
    const evidenceRows = this.db.prepare(`SELECT seq, ts, kind, agent_id, job_id, round_id, lens,
      CASE WHEN length(CAST(payload AS BLOB)) <= ? THEN payload ELSE NULL END AS payload
      FROM events WHERE job_id = ? AND seq > ?
      AND kind IN ('silas.rebrief', 'job.delivered') AND (
        json_extract(payload, '$.marker_id') IN (${ids.map(() => '?').join(',')})
        OR json_extract(payload, '$.request_id') IN (${ids.map(() => '?').join(',')})
        OR json_extract(payload, '$.phase_id') = ?
        OR (json_extract(payload, '$.marker_id') IS NULL AND json_extract(payload, '$.request_id') IS NULL
          AND json_extract(payload, '$.phase_id') IS NULL)) ORDER BY seq LIMIT ?`).iterate(
            MAX_REBRIEF_RECEIPT_EVIDENCE_BYTES, marker.jobId, Math.min(...group.map((row) => row.baselineSeq)),
            ...ids, ...ids, marker.phaseId, MAX_REBRIEF_RECEIPT_EVIDENCE_EVENTS + 1);
    const rows: Row[] = [];
    let payloadBytes = 0;
    for (const row of evidenceRows) {
      if (rows.length === MAX_REBRIEF_RECEIPT_EVIDENCE_EVENTS) {
        throw new DirectiveCheckpointError(`rebrief receipt evidence exceeds the ${MAX_REBRIEF_RECEIPT_EVIDENCE_EVENTS}-event inspection limit; complete history cannot be established`);
      }
      if (row.payload !== null) payloadBytes += Buffer.byteLength(str(row.payload), 'utf8');
      if (row.payload === null || payloadBytes > MAX_REBRIEF_RECEIPT_EVIDENCE_BYTES) {
        throw new DirectiveCheckpointError(`rebrief receipt evidence exceeds the ${MAX_REBRIEF_RECEIPT_EVIDENCE_BYTES}-byte inspection limit; complete history cannot be established`);
      }
      rows.push(row);
    }
    const receipts = rows.map((row) => {
      const event = this.eventFromRow(row);
      return { seq: event.seq, kind: event.kind, jobId: event.jobId, agentId: event.agentId,
        classification: group.some((candidate) => candidate.kind === event.kind && this.pendingRebriefReceipt(candidate, event.seq) !== null)
          ? 'accepted' as const : 'unproven' as const, payload: event.payload };
    });
    const facts = { version: 1 as const, markers, phase, receipts };
    return { ...facts, sha256: createHash('sha256').update(canonicalRebriefEvidence(facts)).digest('hex') };
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
  private closeOrdinaryRebriefRecovery(markers: readonly PendingRebriefRecord[], eventSeq: number, eventKind: string): void {
    for (const marker of markers) {
      if (this.recoveryOwnerBasis('rebrief', marker.id).owned) continue;
      const debts = this.listObligations({ jobId: marker.jobId }).filter((debt) => debt.incidentKey === `rebrief-recovery:${marker.id}` &&
        (debt.state === 'open' || debt.state === 'waiting') && debt.nextAction.kind === 'gru-decision');
      for (const debt of debts) this.settleObligation({ obligationId: debt.id, settlement: { kind: 'executed-action',
        action: eventKind === 'silas.rebrief-retired' ? 'exact terminal legacy control administratively retired, not completed' : 'exact original guarded receipt pair settled', evidenceEventSeq: eventSeq, evidenceEventKind: eventKind } });
      const card = this.findNotificationByKindAndRouting(`silas.rebrief-unreconciled.${marker.jobId}`, 'action-required', 'active');
      // The production incident is job-keyed and deduplicated across generations.
      // Its producer-issued recovery pointer correlates only the routine card;
      // it is not authority/effect evidence and never releases an owner hold.
      const correlated = debts.some((debt) => card?.detail?.includes(`/api/silas/rebriefs/${marker.id}, then POST its /recover with expected_generation ${debt.generation}, expected_payload_hash ${marker.payloadHash},`));
      // An abandonment-advice card (unproven custody) never carries that
      // correlate string, so a transient blocker's card would wake Gru
      // forever once the markers later retire or settle. Resolve it too when
      // this job has no pending marker left and no open recovery debt.
      const staleAdvice = card?.detail?.includes('owner decision: ask the owner to abandon the unknown custody') === true &&
        this.listPendingRebriefs({ jobId: marker.jobId }).length === 0 &&
        this.listObligations({ jobId: marker.jobId }).every((debt) => debt.state !== 'open' && debt.state !== 'waiting');
      if ((correlated || staleAdvice) && card?.routing === 'action-required' && (card.agentId === null || card.agentId === marker.agentId)) this.resolveNotificationById(card.id, 'rebrief-recovery-evidence');
    }
  }

  private assertOrdinaryRebriefResolutionReleased(markers: readonly PendingRebriefRecord[]): void {
    for (const marker of markers) {
      const basis = this.recoveryOwnerBasis('rebrief', marker.id);
      const history = this.recoveryDecisionHistory('rebrief', marker.id).at(-1);
      const transfer = history?.ownerTransfer;
      if (basis.owned) throw new DirectiveCheckpointError('original legacy resolution remains owned by its transferred owner reservation');
      if (transfer != null) {
        const target = this.getObligation(transfer.target.id);
        const confirmation = target?.settlement?.kind === 'executed-action' ? this.getEvent(target.settlement.evidenceEventSeq) : null;
        const facts = confirmation?.payload as { transfer_event_seq?: unknown; subject_kind?: unknown; subject_id?: unknown; target?: { id?: unknown; generation?: unknown; planRevision?: unknown } } | undefined;
        const explicitlyReleased = target?.state === 'settled' && confirmation?.kind === 'silas.recovery-owner-stop-confirmed' && confirmation.jobId === marker.jobId &&
          facts?.transfer_event_seq === history!.eventSeq && facts.subject_kind === 'rebrief' && facts.subject_id === marker.id && facts.target?.id === target.id &&
          facts.target.generation === target.generation && facts.target.planRevision === target.planRevision;
        if (!explicitlyReleased && !isJobTerminal(this.getJob(marker.jobId)!.status)) throw new DirectiveCheckpointError('original legacy owner transfer is unresolved or changed; new receipts are not owner release');
      }
      const retained = this.listObligations({ jobId: marker.jobId }).some((debt) => debt.incidentKey === `rebrief-recovery:${marker.id}` &&
        (debt.state === 'suspended' || (debt.state === 'open' || debt.state === 'waiting') && debt.claim !== null));
      if (retained) throw new DirectiveCheckpointError('exact original legacy recovery resolution remains suspended or claimed');
    }
  }

  clearPendingRebriefsIfCurrentAndSettle(expected: readonly PendingRebriefRecord[]): boolean {
    const jobId = expected[0]?.jobId;
    if (jobId === undefined) throw new Error('settling a re-brief generation requires markers');
    return this.transaction(() => {
      if (!this.matchesPendingRebriefGeneration(jobId, expected)) return false;
      this.assertSettleableRebriefGeneration(jobId, expected);
      this.assertOrdinaryRebriefResolutionReleased(expected);
      const event = this.appendEvent({ kind: 'silas.rebrief-settled', jobId, payload: { markers: expected } });
      this.closeOrdinaryRebriefRecovery(expected, event.seq, event.kind);
      this.clearPendingRebriefs(expected.map((marker) => marker.id));
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
      const landed = this.pendingRebriefReceipt(marker) !== null;
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
        const landed = this.pendingRebriefReceipt(row) !== null;
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
      this.assertOrdinaryRebriefResolutionReleased(retired);
      const event = this.appendEvent({
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
      this.closeOrdinaryRebriefRecovery(retired, event.seq, event.kind);
      const remove = this.db.prepare('DELETE FROM pending_rebriefs WHERE id = ?');
      for (const row of retired) remove.run(row.id);
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

  /** The open (waiting/recovered-pending) provider wait of one job, or
   * null — lane slimming (#427) treats a job whose minion may still be
   * continued as busy. */
  openProviderWaitForJob(jobId: string): ProviderWaitRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM provider_waits WHERE job_id = ? AND status IN ('waiting','recovered-pending')
         ORDER BY created_at DESC, id LIMIT 1`,
      )
      .get(jobId) as Row | undefined;
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

  /** Reserve one runtime admission BEFORE its first await. The status
   * transaction sees this ownership until the attempt finishes; a restart
   * loses only process-local ownership, not historical intent/events. */
  beginJobAdmission(jobId: string, kind: string): () => void {
    const job = this.getJob(jobId);
    if (job === null || isJobTerminal(job.status)) {
      throw new Error(`cannot admit ${kind} for job "${jobId}" (${job?.status ?? 'missing'})`);
    }
    const prior = this.listJobAdmissions(jobId);
    // The one admission that may nest under a `property repair` allocation is
    // a directive whose durable request is held by that same repair service.
    const ownRepairDirective = kind.startsWith('directive ') && prior.filter((entry) => entry.startsWith('property ')).every((entry) => entry.startsWith('property repair ')) &&
      this.getDirective(kind.slice('directive '.length))?.claim?.holder === 'property-contract-repair';
    if (!ownRepairDirective && ((kind.startsWith('property ') && prior.length > 0) || (prior.some((entry) => entry.startsWith('property ')) && !kind.startsWith('provider wait establishment ')))) throw new LaneWriterConflictError(`job "${jobId}" has a competing property/producer admission — wait for its proven settlement`);
    const admission = { jobId, kind };
    this.activeJobAdmissions.add(admission);
    return () => { this.activeJobAdmissions.delete(admission); };
  }

  /** A durable claimed wait is permission to attempt ONE runtime recovery,
   * not a permanent live producer after its turn settles. */
  beginProviderContinuation(waitId: string, jobId: string): () => void {
    const wait = this.getProviderWait(waitId);
    if (wait === null || wait.status !== 'claimed' || wait.waiterKind !== 'job-minion' || wait.jobId !== jobId) {
      throw new Error(`provider continuation ${waitId} must belong to a claimed job-minion wait for "${jobId}"`);
    }
    return this.beginJobAdmission(jobId, `provider continuation ${waitId}`);
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

  /** Hand a claimed wait back (#427): compare-and-set claimed →
   * recovered-pending, only for a claim whose continuation never spawned
   * (the service stopped while it restored the job's lanes), so the next
   * claimant replays it. Returns true when THIS call released it. */
  releaseProviderWaitClaim(id: string, payload?: Record<string, unknown>): boolean {
    return this.transaction(() => {
      const result = this.db
        .prepare("UPDATE provider_waits SET status = 'recovered-pending', updated_at = ? WHERE id = ? AND status = 'claimed'")
        .run(nowIso(), id);
      if (result.changes !== 1) return false;
      const wait = this.getProviderWait(id);
      this.appendEvent({
        kind: 'provider.wait-status',
        jobId: wait?.jobId ?? null,
        agentId: wait?.agentId ?? null,
        payload: { id, from: 'claimed', to: 'recovered-pending', ...(payload ?? {}) },
      });
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
    decision?: NotificationDecision | null;
  }): NotificationRecord {
    if (input.id === '' || input.title === '') {
      throw new Error('notification id and title must be non-empty');
    }
    if (input.id.includes('\u0000')) throw new NotificationIdentityError();
    return this.transaction(() => {
      if (this.getNotification(input.id) !== null) {
        throw new Error(`notification "${input.id}" already exists`);
      }
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO notifications (id, ts, kind, routing, severity, title, detail, agent_id, decision_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          input.decision === undefined || input.decision === null
            ? null
            : serializeNotificationDecision(input.decision),
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
   * agent binding does NOT belong to a terminal (merged/done/binned) job.
   * A row
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

  /** The ledger event sequence of a provider wait's establishment (its
   * `provider.wait-established` event) — insertion order, never wall-clock
   * time — or null when it has none. */
  providerWaitEstablishedSeq(id: string): number | null {
    const row = this.db
      .prepare("SELECT seq FROM events WHERE kind = 'provider.wait-established' AND json_extract(payload, '$.id') = ? ORDER BY seq LIMIT 1")
      .get(id) as Row | undefined;
    return row === undefined ? null : Number(row.seq);
  }

  /** The most recently INSERTED notification of an exact kind — insertion
   * order, never wall-clock ts, so a clock step back cannot reorder it. */
  latestNotificationByKind(kind: string): NotificationRecord | null {
    const row = this.db.prepare('SELECT * FROM notifications WHERE kind = ? ORDER BY rowid DESC LIMIT 1')
      .get(kind) as Row | undefined;
    return row === undefined ? null : this.notificationFromRow(row);
  }

  /** Report replacements are ordered by insertion, including same-timestamp UUID ties. */
  latestReportHandbackNotification(jobId: string): NotificationRecord | null {
    return this.latestNotificationByKind(`silas.report-handback.${jobId}`);
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
   * Unanswered typed owner decisions are deliberately excluded; they remain
   * open for the guarded decision/follow-through path. Every changed row emits
   * an event so connected status/notification surfaces refresh immediately.
   */
  resolveNotificationsByKindPrefix(prefix: string, by: string): readonly NotificationRecord[] {
    if (prefix === '' || by === '') throw new Error('resolution prefix/by must be non-empty');
    return this.transaction(() => {
      const escaped = prefix.replace(/[\\%_]/g, '\\$&');
      const rows = this.db
        .prepare(
          "SELECT * FROM notifications WHERE kind LIKE ? ESCAPE '\\' AND resolved_at IS NULL AND NOT (routing = 'needs-owner' AND decision_json IS NOT NULL AND decided_at IS NULL) ORDER BY ts, id",
        )
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

  /** Resolve every open row whose id starts with `prefix` (#427: the rows
   * about one lane, `worktree-submodule-work:<lane>:` for each digest).
   * Unanswered typed owner decisions remain open, as for kind prefixes. */
  resolveNotificationsByIdPrefix(prefix: string, by: string): readonly NotificationRecord[] {
    if (prefix === '' || by === '') throw new Error('resolution prefix/by must be non-empty');
    return this.transaction(() => {
      const escaped = prefix.replace(/[\\%_]/g, '\\$&');
      const rows = this.db
        .prepare(
          "SELECT id FROM notifications WHERE id LIKE ? ESCAPE '\\' AND resolved_at IS NULL AND NOT (routing = 'needs-owner' AND decision_json IS NOT NULL AND decided_at IS NULL) ORDER BY ts, id",
        )
        .all(`${escaped}%`) as Row[];
      const resolved: NotificationRecord[] = [];
      for (const raw of rows) {
        const record = this.resolveNotificationById(str(raw.id), by);
        if (record !== null) resolved.push(record);
      }
      return resolved;
    });
  }

  /** Open rows whose kind starts with exactly `prefix`, case included
   * (#486: a lane's sweep-pause cards, `worktree-sweep-paused:<lane>:<pause>`),
   * oldest first. */
  listOpenNotificationsByKindPrefix(prefix: string): readonly NotificationRecord[] {
    if (prefix === '') throw new Error('kind prefix must be non-empty');
    const rows = this.db
      .prepare('SELECT id FROM notifications WHERE substr(kind, 1, length(?)) = ? AND resolved_at IS NULL ORDER BY ts, id')
      .all(prefix, prefix) as Row[];
    return rows.map((raw) => this.getNotification(str(raw.id))).filter((record): record is NotificationRecord => record !== null);
  }

  /** The open (unresolved) rows of some kinds (#427: the lane rows a
   * reconcile settles once their lane is gone). */
  listOpenNotificationsByKinds(kinds: readonly string[]): readonly NotificationRecord[] {
    if (kinds.length === 0) return [];
    const rows = this.db
      .prepare(`SELECT id FROM notifications WHERE kind IN (${kinds.map(() => '?').join(', ')}) AND resolved_at IS NULL ORDER BY ts, id`)
      .all(...kinds) as Row[];
    return rows.map((raw) => this.getNotification(str(raw.id))).filter((record): record is NotificationRecord => record !== null);
  }

  /** Resolve every open row of an EXACT kind (no LIKE wildcard semantics):
   * producer-evidence settlement where one kind must never bleed into a
   * lookalike kind that shares its prefix (e.g. `triage` vs `triage-extra`).
   * Unanswered typed owner decisions remain open for the guarded follow-through. */
  resolveNotificationsByExactKind(kind: string, by: string): readonly NotificationRecord[] {
    if (kind === '' || by === '') throw new Error('resolution kind/by must be non-empty');
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          "SELECT * FROM notifications WHERE kind = ? AND resolved_at IS NULL AND NOT (routing = 'needs-owner' AND decision_json IS NOT NULL AND decided_at IS NULL) ORDER BY ts, id",
        )
        .all(kind) as Row[];
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

  /** Replace an OPEN notification's detail (and, when given, title) in place — id, acknowledgement
   * and routing unchanged (a long-running incident refreshing its latest
   * cause). A resolved or missing row is left as-is and returned (or null). */
  updateNotificationDetail(id: string, detail: string, title?: string): NotificationRecord | null {
    return this.transaction(() => {
      const current = this.getNotification(id);
      const nextTitle = title ?? current?.title;
      if (current === null || current.resolvedAt !== null || (current.detail === detail && current.title === nextTitle)) return current;
      this.db.prepare('UPDATE notifications SET detail = ?, title = ? WHERE id = ?').run(detail, nextTitle ?? current.title, id);
      this.appendEvent({ kind: 'notification.updated', agentId: current.agentId, payload: { id } });
      return this.getNotification(id);
    });
  }

  /** Resolve one exact incident ID without acknowledging it for the owner.
   * Generic producer settlement cannot hide an unanswered typed owner decision;
   * it must be recorded and then resolved through the guarded follow-through path. */
  resolveNotificationById(id: string, by: string): NotificationRecord | null {
    if (by.trim() === '') throw new Error('resolution by must be non-empty');
    return this.transaction(() => {
      const current = this.getNotification(id);
      if (current === null || current.resolvedAt !== null) return current;
      if (current.routing === 'needs-owner' && current.decision !== null && current.decidedAt === null) {
        throw new NotificationDecisionRefusal(
          'undecided',
          `notification "${id}" is an unanswered owner decision and cannot be resolved by a generic producer`,
        );
      }
      this.db.prepare('UPDATE notifications SET resolved_at = ?, resolved_by = ? WHERE id = ?')
        .run(nowIso(), by, id);
      this.appendEvent({ kind: 'notification.resolved', agentId: current.agentId, payload: { id, by } });
      return this.getNotification(id);
    });
  }

  /**
   * Producer withdrawal of a stale owner PROPOSAL (#351): the thing proposed
   * changed before the owner answered, so the question no longer exists.
   * Only kinds the attention registry marks producer-withdrawable qualify; a
   * decided proposal is never withdrawn (its follow-through owns it), and an
   * already-resolved row is returned as it is. Audited with `withdrawn: true`.
   */
  withdrawOwnerProposal(id: string, detail: string): NotificationRecord | null {
    if (detail.trim() === '') throw new Error('proposal withdrawal detail must be non-empty');
    return this.transaction(() => {
      const current = this.getNotification(id);
      if (current === null || current.resolvedAt !== null) return current;
      if (current.routing !== 'needs-owner' || !producerWithdrawable(current.kind)) {
        throw new NotificationDecisionRefusal('not_withdrawable', `notification "${id}" (${current.kind}) is not a producer-withdrawable owner proposal`);
      }
      if (current.decidedAt !== null) {
        throw new NotificationDecisionRefusal('decision_recorded', `notification "${id}" already records decision "${current.decidedOption}"; it is carried out, never withdrawn`);
      }
      this.db.prepare('UPDATE notifications SET resolved_at = ?, resolved_by = ? WHERE id = ?').run(nowIso(), 'producer-withdrawn', id);
      this.appendEvent({ kind: 'notification.resolved', agentId: current.agentId, payload: { id, by: 'producer-withdrawn', detail, withdrawn: true } });
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

  /** Follow-through resolution for a DECIDED owner decision (owner
   * release 2026-10-11): after the recorded choice's operation completes,
   * its owner (Gru/Silas) resolves the row with the action detail. An
   * UNDECIDED owner row is refused — resolution may never silence a
   * question the owner has not answered, and no display receipt or age
   * ever closes one. Distinct from `disposeMachineNotification` (machine
   * attention) and from `ackNotification` (feed/notice only).
   *
   * `by: 'gru'` names the follow-through ROLE, exactly as a machine
   * disposition does: the audit event carries the authorising credential
   * class and any caller-declared actor, never a claimed identity (#99,
   * #396). */
  resolveOwnerDecision(
    id: string,
    detail: string,
    // Required, never defaulted (#396): every caller states the credential
    // that authenticated it and any actor it declared.
    provenance: NotificationProvenance,
  ): NotificationRecord | null {
    if (detail.trim() === '') throw new Error('owner-decision resolution detail must be non-empty');
    if (provenance.credential.trim() === '') throw new BlankProvenanceCredentialError('owner-decision resolution');
    return this.transaction(() => {
      const current = this.getNotification(id);
      if (current === null) return null;
      if (current.routing !== 'needs-owner') {
        throw new NotificationDecisionRefusal(
          'not_owner_decision',
          `notification "${id}" is ${current.routing}; use the disposition route for machine attention`,
        );
      }
      if (current.decidedAt === null) {
        throw new NotificationDecisionRefusal(
          'undecided',
          `notification "${id}" has no recorded owner decision — it cannot be resolved by follow-through`,
        );
      }
      if (current.resolvedAt !== null) return current; // idempotent
      this.db.prepare('UPDATE notifications SET resolved_at = ?, resolved_by = ? WHERE id = ?')
        .run(nowIso(), 'gru', id);
      this.appendEvent({
        kind: 'notification.resolved',
        agentId: current.agentId,
        payload: {
          id,
          by: 'gru',
          detail,
          owner_decision: current.decidedOption,
          credential: provenance.credential,
          declaredActor: provenance.declaredActor,
        },
      });
      return this.getNotification(id) as NotificationRecord;
    });
  }

  /** Why a machine disposition of this notification would be refused, or
   * null — the SAME rule `disposeMachineNotification` enforces, read first
   * so a route can refuse before any other effect (#385). The disposal
   * re-checks it in its own transaction and stays the authority. */
  machineDispositionRefusal(id: string): string | null {
    const current = this.getNotification(id);
    return current === null ? null : machineDispositionRefusalOf(current);
  }

  /** Explicit machine disposition, distinct from the owner's Ack.
   * A successful wake prompt by itself never calls this method.
   *
   * `by: 'gru'` names the disposition ROLE (machine rows are Gru's to
   * dispose); it is NOT proof of who held the pen. The audit event carries
   * the credential class that authorised the call and any caller-declared
   * actor so the record never claims provenance it cannot prove (#99). */
  disposeMachineNotification(
    id: string,
    detail: string,
    provenance: NotificationProvenance = { credential: 'internal', declaredActor: null },
  ): NotificationRecord | null {
    if (detail.trim() === '') throw new Error('machine disposition detail must be non-empty');
    if (provenance.credential.trim() === '') throw new BlankProvenanceCredentialError('machine disposition');
    return this.transaction(() => {
      const current = this.getNotification(id);
      if (current === null) return null;
      const refusal = machineDispositionRefusalOf(current);
      if (refusal !== null) throw new MachineDispositionRefusedError(id, refusal);
      if (current.resolvedAt !== null || current.ackedAt !== null) return current;
      this.db.prepare('UPDATE notifications SET resolved_at = ?, resolved_by = ? WHERE id = ?')
        .run(nowIso(), 'gru', id);
      this.appendEvent({ kind: 'notification.resolved', agentId: current.agentId, payload: { id, by: 'gru', detail, credential: provenance.credential, declaredActor: provenance.declaredActor } });
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
      if (current.routing === 'needs-owner' && current.decision !== null) {
        throw new Error(
          'this typed owner decision is recorded with POST /api/notifications/:id/decision; an Ack cannot erase the question',
        );
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

  /** Record the owner's typed decision on a needs-owner row. The ONLY
   * supported effect of a recorded option is the durable decision itself
   * (plus its audit event): follow-through stays with Gru/Silas and the
   * row remains visible with `decidedAt` set until its producer resolves
   * it — recording a decision never resolves, acks or hides the row.
   * Browser callers supply the displayed decision so a reused option id
   * cannot silently bind an old label to a new consequence. */
  recordNotificationDecision(
    id: string,
    optionId: string,
    by: string,
    expectedDecision?: NotificationDecision,
  ): NotificationRecord | null {
    if (by.trim() === '') throw new Error('decision by must be non-empty');
    return this.transaction(() => {
      const current = this.getNotification(id);
      if (current === null) return null;
      if (current.routing !== 'needs-owner') {
        throw new NotificationDecisionRefusal(
          'not_owner_decision',
          `notification "${id}" is ${current.routing}; only owner decisions accept a recorded choice`,
        );
      }
      if (current.decision === null) {
        throw new NotificationDecisionRefusal(
          'no_decision',
          `notification "${id}" carries no typed decision — no option can be recorded`,
        );
      }
      if (
        expectedDecision !== undefined &&
        serializeNotificationDecision(current.decision) !== serializeNotificationDecision(expectedDecision)
      ) {
        throw new NotificationDecisionRefusal(
          'decision_changed',
          `notification "${id}" no longer carries the decision that was displayed; refresh before choosing`,
        );
      }
      if (current.decidedAt !== null) {
        // Same option: an idempotent replay (a retried click confirms the
        // recorded choice), even when follow-through has since resolved the
        // row. An unknown option remains a typed input error; a different
        // valid option is refused rather than silently replacing the record.
        if (current.decidedOption === optionId) return current;
        if (!current.decision.options.some((candidate) => candidate.id === optionId)) {
          throw new NotificationDecisionRefusal(
            'unknown_option',
            `option "${optionId}" is not one of this decision's options`,
          );
        }
        throw new NotificationDecisionRefusal(
          'decision_recorded',
          `notification "${id}" already records decision "${current.decidedOption}"; it is not replaced`,
        );
      }
      if (current.resolvedAt !== null) {
        throw new NotificationDecisionRefusal('not_open', `notification "${id}" is already resolved`);
      }
      const option = current.decision.options.find((candidate) => candidate.id === optionId);
      if (option === undefined) {
        throw new NotificationDecisionRefusal(
          'unknown_option',
          `option "${optionId}" is not one of this decision's options`,
        );
      }
      this.db
        .prepare('UPDATE notifications SET decided_at = ?, decided_by = ?, decided_option = ? WHERE id = ?')
        .run(nowIso(), by, optionId, id);
      this.appendEvent({
        kind: 'notification.decision',
        agentId: current.agentId,
        payload: { id, optionId, by },
      });
      return this.getNotification(id) as NotificationRecord;
    });
  }

  /** Attach concrete options to an EXISTING discussion-only decision
   * (owner release 2026-10-11): the supported bridge from a discussion in
   * chat to a recordable owner choice. Only an undecided, unresolved,
   * discussion-only `needs-owner` row accepts this; the update is audited
   * and never records a choice itself — the owner still records the
   * decision through `recordNotificationDecision`, and follow-through
   * resolves through `resolveOwnerDecision`. */
  updateNotificationDecisionOptions(
    id: string,
    options: readonly NotificationDecisionOption[],
    by: string,
  ): NotificationRecord | null {
    if (by.trim() === '') throw new Error('decision-options by must be non-empty');
    // Deep-validate at THIS write boundary too: a malformed option set would
    // serialize happily and later read back as silently-dropped corruption
    // (the stored-decision parser reads corrupt JSON as "no decision").
    const validated = parseDecisionOptions(options);
    if (validated.length === 0) throw new Error('decision-options requires at least one option');
    return this.transaction(() => {
      const current = this.getNotification(id);
      if (current === null) return null;
      if (current.routing !== 'needs-owner') {
        throw new NotificationDecisionRefusal(
          'not_owner_decision',
          `notification "${id}" is ${current.routing}; only owner decisions accept attached options`,
        );
      }
      if (current.decision === null) {
        throw new NotificationDecisionRefusal(
          'no_decision',
          `notification "${id}" carries no typed decision — no options can be attached`,
        );
      }
      if (current.resolvedAt !== null) {
        throw new NotificationDecisionRefusal('not_open', `notification "${id}" is already resolved`);
      }
      if (current.decidedAt !== null) {
        throw new NotificationDecisionRefusal(
          'decision_recorded',
          `notification "${id}" already records decision "${current.decidedOption}" — its options are not replaced`,
        );
      }
      if (current.decision.discussion !== true) {
        throw new NotificationDecisionRefusal(
          'not_discussion',
          `notification "${id}" is not a discussion decision — its producer-authored options are not replaced`,
        );
      }
      const next: NotificationDecision = { ...current.decision, options: [...validated] };
      this.db
        .prepare('UPDATE notifications SET decision_json = ? WHERE id = ?')
        .run(serializeNotificationDecision(next), id);
      this.appendEvent({
        kind: 'notification.decision-options',
        agentId: current.agentId,
        payload: { id, by, option_ids: validated.map((option) => option.id) },
      });
      return this.getNotification(id) as NotificationRecord;
    });
  }

  /** Upgrade-in-place for an idempotent owner-escalation replay (#395): a
   * row written before typed decisions were required (decision null) and
   * still OPEN adopts the replayed typed decision, so the owner gets the
   * typed options on the ONE existing FOR YOU item instead of a 409 forever
   * (or a second item). A closed (acked/resolved) legacy row is refused —
   * a decision can never be attached to an already-closed question. */
  adoptLegacyOwnerDecision(
    id: string,
    decision: NotificationDecision,
    provenance: NotificationProvenance,
  ): NotificationRecord | null {
    if (provenance.credential.trim() === '') throw new BlankProvenanceCredentialError('decision adoption');
    return this.transaction(() => {
      const current = this.getNotification(id);
      if (current === null) return null;
      if (current.routing !== 'needs-owner') {
        throw new NotificationDecisionRefusal(
          'not_owner_decision',
          `notification "${id}" is ${current.routing}; only owner decisions adopt a typed decision`,
        );
      }
      const stored = this.db.prepare('SELECT decision_json FROM notifications WHERE id = ?').get(id) as { decision_json: string | null } | undefined;
      if (stored === undefined) return null;
      // Legacy means the STORED column is empty — never a stored decision
      // that merely failed to parse — and nothing was ever decided on it.
      const storedDecision = stored.decision_json !== null;
      const alreadyDecided = current.decidedOption !== null;
      if (current.decision !== null || storedDecision || alreadyDecided) {
        throw new NotificationDecisionRefusal(
          'decision_present',
          `notification "${id}" already carries a typed decision — it is never replaced`,
        );
      }
      if (current.resolvedAt !== null || current.ackedAt !== null) {
        throw new NotificationDecisionRefusal(
          'legacy_closed',
          `notification "${id}" was closed before it carried a typed decision — use a new key for a new decision`,
        );
      }
      this.db
        .prepare('UPDATE notifications SET decision_json = ? WHERE id = ?')
        .run(serializeNotificationDecision(decision), id);
      this.appendEvent({
        kind: 'notification.decision-adopted',
        agentId: current.agentId,
        payload: { id, credential: provenance.credential, declaredActor: provenance.declaredActor, option_ids: decision.options.map((option) => option.id) },
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
      parentJobId: nstr(row.parent_job_id),
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
      laneToken: nstr(row.lane_token),
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
  /** Follow only this inspection gate duty's durable supersession lineage. */
  private currentGateDutyAction(obligationId: string): ObligationNextAction | null {
    const row = this.getObligation(obligationId); if (row === null) return null;
    const roots = this.db.prepare("SELECT payload FROM events WHERE job_id = ? AND kind IN ('silas.rebrief-current-gates-owed', 'silas.directive-current-gates-owed') ORDER BY seq").all(row.jobId) as Row[];
    for (const root of roots) {
      const payload = JSON.parse(root.payload as string) as { obligation_id: string; next_action: ObligationNextAction };
      if (typeof payload.obligation_id !== 'string' || payload.next_action?.kind !== 'gru-decision') throw new DirectiveCheckpointError('current gate action lineage is malformed');
      let cursor: string | null = payload.obligation_id; const seen = new Set<string>();
      while (cursor !== null) {
        if (seen.has(cursor)) throw new DirectiveCheckpointError('current gate action transfer lineage is cyclic');
        seen.add(cursor); if (cursor === obligationId) return payload.next_action;
        const settlement: ObligationSettlement | undefined = this.getObligation(cursor)?.settlement ?? undefined;
        cursor = settlement?.kind === 'superseded' ? settlement.byObligationId : null;
      }
    }
    return null;
  }

  /** Bounded completion of this protected recovery duty, never a universal receipt. */
  private assertCurrentGateDutyCompleted(row: ObligationRecord, action: ObligationNextAction, evidenceSeq: number): void {
    const refuse = (message: string): never => { throw new DirectiveCheckpointError(`current gate duty ${message}`); };
    const citedReview = this.getEvent(evidenceSeq);
    if (citedReview?.kind !== 'round.perkins-review') refuse('cannot be discharged by generic evidence, inspection, historical receipts or prose');
    this.assertRecoveryJobPermission(row.jobId);
    if (row.state === 'suspended' || row.claim !== null) refuse('retains suspended or claimed ownership');
    const roots = this.db.prepare("SELECT * FROM events WHERE job_id = ? AND kind IN ('silas.rebrief-current-gates-owed', 'silas.directive-current-gates-owed') ORDER BY seq").all(row.jobId) as Row[];
    const root = roots.map((record) => this.eventFromRow(record)).find((event) => isDeepStrictEqual((event.payload as { next_action?: unknown }).next_action, action));
    if (root === undefined || root.seq >= evidenceSeq) refuse('requires exact original action before evidence');
    const origin = root!.payload as { identity: DirectiveTurnIdentity; delivery_seq: number; sha: string | null };
    validateDirectiveIdentity(origin.identity);
    const original = this.getDirective(origin.identity.requestId);
    const delivery = this.getEvent(origin.delivery_seq);
    if (original?.nativeTarget === null || original?.nativeTarget === undefined || original.nativeBinding === null || delivery?.jobId !== row.jobId || delivery.kind !== 'job.delivered' || !isDeepStrictEqual(this.directiveTurnIdentity(original.requestId), origin.identity)) refuse('original accepted delivery binding is unavailable');
    const delivered = delivery!.payload as { native_completion?: { identity?: unknown; binding?: unknown }; sha?: unknown };
    if (delivered.sha !== origin.sha || !isDeepStrictEqual(delivered.native_completion?.identity, origin.identity) || !isDeepStrictEqual(delivered.native_completion?.binding, original!.nativeBinding)) refuse('original delivery provenance changed');
    const originalProof = inspectDirectiveCheckpoint(original!.nativeTarget!.sessionFile, origin.identity);
    const originalCompletion = originalProof.state === 'terminal' && originalProof.ok ? readDirectiveCompletion(original!.nativeTarget!.sessionFile, origin.identity, originalProof.checkpointId) : null;
    const physical = inspectDirectiveProducers(original!.nativeTarget!.sessionFile, origin.identity);
    if ((originalCompletion?.head ?? null) !== origin.sha || !(originalProof.state === 'terminal' && originalProof.ok && isDeepStrictEqual(originalProof.binding, original!.nativeBinding)) ||
        !physical.some(({ producer }) => isDeepStrictEqual(producer.identity, origin.identity) && producer.agentId === original!.nativeBinding!.agentId && producer.sessionId === original!.nativeBinding!.sessionId) ||
        physical.some(({ evidence }) => evidence === 'unknown') || directiveSessionLockBlocker(original!.nativeTarget!.sessionFile) !== null) refuse('original proof or physical ownership remains UNKNOWN');
    const candidate = this.latestCandidateDelivery(row.jobId);
    const facts = candidate?.payload as { sha?: unknown; work_revision?: unknown; candidate_delivery_proven?: unknown; native_completion?: { identity?: DirectiveTurnIdentity; binding?: unknown } } | undefined;
    const identity = facts?.native_completion?.identity;
    const current = identity === undefined ? null : this.getDirective(identity.requestId);
    const required = requiredWorkRevision(this.listJobAmendments(row.jobId));
    if (candidate === null || typeof facts?.sha !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(facts.sha) || facts.candidate_delivery_proven !== true || facts.work_revision !== required || identity === undefined || current?.deliverySeq !== candidate.seq || current.nativeTarget === null || !isDeepStrictEqual(this.directiveTurnIdentity(current.requestId), identity) || !isDeepStrictEqual(current.nativeBinding, facts.native_completion?.binding)) refuse('requires positively established current native candidate');
    if (citedReview!.seq <= candidate!.seq) refuse('review evidence predates the current candidate delivery');
    if (candidate!.seq !== delivery!.seq) {
      const starts = this.db.prepare("SELECT * FROM events WHERE job_id = ? AND kind = 'silas.directive-producer-ceased' AND json_extract(payload, '$.request_id') = ? ORDER BY seq").all(row.jobId, original!.requestId) as Row[];
      const originalCeased = starts.map((event) => this.eventFromRow(event)).find((event) => {
        const fields = event.payload as { producer_start_seq?: number; producer_identity?: unknown; native_producer?: unknown };
        const start = fields.producer_start_seq === undefined ? null : this.getEvent(fields.producer_start_seq);
        return start?.kind === 'silas.directive-producer-started' && start.jobId === row.jobId && start.seq < event.seq &&
          isDeepStrictEqual(fields.producer_identity, origin.identity) && physical.some(({ producer }) => isDeepStrictEqual(producer.identity, origin.identity) && isDeepStrictEqual(fields.native_producer, producer) &&
            isDeepStrictEqual((start.payload as { native_producer?: unknown }).native_producer, producer));
      });
      const anchor = Math.min(root!.seq, originalCeased?.seq ?? root!.seq);
      if (current!.baselineSeq < anchor || current!.admissionSeq === null || current!.admissionSeq <= anchor) refuse('current native acceptance does not establish original-to-current causal chronology');
    }
    const currentProof = inspectDirectiveCheckpoint(current!.nativeTarget!.sessionFile, identity!);
    const currentCompletion = currentProof.state === 'terminal' && currentProof.ok ? readDirectiveCompletion(current!.nativeTarget!.sessionFile, identity!, currentProof.checkpointId) : null;
    if (currentCompletion?.head !== facts!.sha || !(currentProof.state === 'terminal' && isDeepStrictEqual(currentProof.binding, current!.nativeBinding))) refuse('current candidate original completion is unproven');
    const currentPhysical = inspectDirectiveProducers(current!.nativeTarget!.sessionFile, identity!);
    if (currentPhysical.length === 0 || currentPhysical.some(({ evidence }) => evidence !== 'ceased') || directiveSessionLockBlocker(current!.nativeTarget!.sessionFile) !== null) refuse('current candidate physical ownership remains UNKNOWN');
    const lanes = this.listWorktrees({ jobId: row.jobId }).filter((lane) => lane.kind === 'job' && lane.status !== 'swept');
    if (lanes.length !== 1) refuse('requires exact current candidate lane');
    const lane = lanes[0]!;
    const blockers = this.directiveRetirementBlockers(original!, lane.id);
    if (blockers.length > 0) refuse(`producer ownership remains: ${blockers.join('; ')}`);
    const declared = loadWorktreeManifest(lane.path);
    if (declared === null) refuse('requires host declared full verification scope');
    const command = resolveVerifyCommand(declared!, 'full');
    const git = readGitState(lane.path, { includeUntracked: true });
    if (git.sha !== facts!.sha || git.trackedDirty) refuse('current candidate HEAD moved or tracked/untracked input tree is dirty');
    const attempts = this.db.prepare("SELECT * FROM events WHERE job_id = ? AND kind = 'verification.requested' AND json_extract(payload, '$.scope') = 'full' ORDER BY seq DESC LIMIT 1").get(row.jobId) as Row | undefined;
    if (attempts === undefined) refuse('requires declared full scheduler attempt');
    const requested = this.eventFromRow(attempts!); const request = requested.payload as Record<string, unknown>;
    const amendedAt = this.latestJobEvent(row.jobId, 'job.amendment-accepted')?.seq ?? 0;
    if (requested.seq <= Math.max(root!.seq, amendedAt, candidate!.seq) || request['command'] !== command || request['cwd'] !== lane.path || request['head'] !== facts!.sha || typeof request['request_id'] !== 'string' || typeof request['run_id'] !== 'string') refuse('newest full scheduler request has stale or foreign bindings or predates the current candidate delivery');
    const latestFull = this.db.prepare("SELECT payload FROM events WHERE job_id = ? AND kind IN ('verification.requested', 'verification.started', 'verification.completed', 'verification.reconciled', 'verification.no-start', 'verification.stale-released', 'verification.lock-timeout') AND json_extract(payload, '$.scope') = 'full' ORDER BY seq DESC LIMIT 1").get(row.jobId) as Row | undefined;
    if (latestFull === undefined || (JSON.parse(str(latestFull.payload)) as { run_id?: unknown }).run_id !== request['run_id']) refuse('newer relevant full attempt is failed or UNKNOWN');
    const lifecycle = this.db.prepare("SELECT * FROM events WHERE job_id = ? AND kind LIKE 'verification.%' AND json_extract(payload, '$.run_id') = ? ORDER BY seq").all(row.jobId, request['run_id'] as string) as Row[];
    const events = lifecycle.map((event) => this.eventFromRow(event));
    const starts = events.filter((event) => event.kind === 'verification.started');
    const completedReadback = (event: EventRecord): boolean => {
      if (event.kind !== 'verification.reconciled') return false;
      const readback = event.payload as Record<string, unknown>;
      if (readback['state'] !== 'completed' || readback['scope'] !== 'full' || readback['head'] !== facts!.sha || typeof readback['request_id'] !== 'string') return false;
      // Read-only replays of a bound request are not additional executions.
      // Contradictory or unbound readbacks remain terminal refusal evidence.
      return events.some((bound) => {
        const binding = bound.payload as Record<string, unknown>;
        return ['verification.requested', 'verification.attached'].includes(bound.kind) && bound.seq < event.seq &&
          binding['request_id'] === readback['request_id'] && binding['scope'] === 'full' && binding['head'] === facts!.sha;
      });
    };
    const terminals = events.filter((event) => ['verification.completed', 'verification.reconciled', 'verification.no-start', 'verification.stale-released', 'verification.lock-timeout'].includes(event.kind) && !completedReadback(event));
    const terminal = terminals[0]; const start = starts[0]; const run = terminal?.payload as Record<string, unknown> | undefined;
    const started = start?.payload as Record<string, unknown> | undefined;
    if (starts.length !== 1 || terminals.length !== 1 || terminal?.kind !== 'verification.completed' || start!.seq <= requested.seq || terminal.seq <= start!.seq || terminal.seq >= evidenceSeq || !Number.isSafeInteger(started?.['pid']) || Number(started?.['pid']) <= 0 || started?.['command'] !== command || started['cwd'] !== lane.path || started['sha'] !== facts!.sha || run?.['command'] !== command || run['scope'] !== 'full' || run['cwd'] !== lane.path || run['sha'] !== facts!.sha || run['tracked_dirty'] !== false || run['ok'] !== true || run['exit_code'] !== 0 || run['signal'] !== null || run['error'] !== null || run['timed_out'] !== false || !Number.isSafeInteger(run['output_bytes']) || Number(run['output_bytes']) < 0 || typeof run['output_sha256'] !== 'string' || !/^[0-9a-f]{64}$/.test(run['output_sha256'])) refuse('newest full scheduler start/terminal/output capture is incomplete, failed or UNKNOWN');
    const round = this.listRounds(row.jobId).at(-1);
    const review = citedReview;
    const reviewed = review?.payload as Record<string, unknown> | undefined;
    if (round === undefined || round.status !== 'verdict-posted' || round.verdict !== 'approved' || review === null || review.seq <= candidate!.seq || review.roundId !== round.id || review.jobId !== row.jobId || review.kind !== 'round.perkins-review' || this.latestRoundEvent(round.id, 'round.perkins-review')?.seq !== review.seq || reviewed?.['canonicalVerdict'] !== 'READY TO MERGE' || reviewed['blockers'] !== 0 || reviewed['complete'] !== true || reviewed['headMoved'] !== false || reviewed['reviewScope'] !== 'whole' || reviewed['finalPassRequired'] === true || reviewed['targetSha'] !== facts!.sha || typeof reviewed['artifactDirectory'] !== 'string') refuse('requires newest actual complete approved whole-change review after the current candidate delivery');
    const bytes = readReviewCheckpointBytes(reviewed!['artifactDirectory'] as string, 'manifest.json', FROZEN_MANIFEST_MAX_BYTES);
    const manifest = JSON.parse(bytes.toString('utf8')) as FrozenReviewInputs;
    const receipt = this.latestRoundEvent(round!.id, 'round.freeze-manifest');
    const acceptance = this.effectiveContract(row.jobId);
    const reviewLanes = this.listWorktrees({ jobId: row.jobId }).filter((worktree) => worktree.kind === 'review' && worktree.roundId === round!.id);
    if (receipt === null || receipt.seq >= review!.seq || (receipt.payload as { sha256?: unknown }).sha256 !== createHash('sha256').update(bytes).digest('hex') || manifest.roundId !== round!.id || reviewLanes.length !== 1 || manifest.repoPath !== reviewLanes[0]!.path || manifest.targetSha !== facts!.sha || manifest.schemaVersion !== 2 || manifest.recoveryIdentity === null || manifest.recoveryIdentity.jobId !== row.jobId || acceptance === null || !isDeepStrictEqual(manifest.acceptance, { version: acceptance.version, baseSha256: acceptance.baseSha256, contractSha256: acceptance.contractSha256, amendmentIds: acceptance.amendmentIds })) refuse('frozen current acceptance/provenance is missing or changed');
  }

  settleObligation(input: {
    obligationId: string;
    settlement: ObligationSettlement;
    requestId?: string;
  }): ObligationRecord {
    return this.transaction(() => {
      const row = this.getObligation(input.obligationId);
      if (row === null) throw new RecordNotFound(`obligation "${input.obligationId}" not found`);
      const gateDuty = this.currentGateDutyAction(row.id);
      if (gateDuty !== null) {
        const disposition = input.settlement;
        if (disposition.kind === 'job-terminal') {
          if (!isJobTerminal(this.getJob(row.jobId)?.status as JobStatus) || this.getJob(row.jobId)?.status !== disposition.jobStatus) throw new DirectiveCheckpointError('current gate duty requires actual matching terminal job state');
        } else if (disposition.kind === 'superseded') {
          const recipient = disposition.byObligationId === null ? null : this.getObligation(disposition.byObligationId);
          if (recipient === null || recipient.id === row.id || recipient.jobId !== row.jobId || ['settled', 'closed'].includes(recipient.state) || this.currentGateDutyAction(recipient.id) !== null ||
              !['gru-decision', 'owner-decision'].includes(recipient.nextAction.kind) || !('decision' in recipient.nextAction) || !('decision' in gateDuty) || recipient.nextAction.decision !== gateDuty.decision) {
            throw new DirectiveCheckpointError('current gate duty requires a distinct live same-job action transfer preserving exact still-owed bindings');
          }
        } else if (disposition.kind === 'executed-action' || disposition.kind === 'accepted-evidence') {
          this.assertCurrentGateDutyCompleted(row, gateDuty, disposition.evidenceEventSeq);
        } else throw new DirectiveCheckpointError('current gate duty cannot be discharged by generic evidence, inspection, historical receipts or prose');
      }
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
      // A settled report debt answers its handback card HERE, at the one
      // boundary every closure path rides (disposition, auto-supersede,
      // terminal status transitions, stale-continuation invalidation) — no
      // path can close the debt and leave a false outstanding action.
      if (row.incidentKey === reportIncidentKey(row.jobId)) {
        this.resolveReportHandbackCard(row.jobId, 'code');
      }
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
        if (this.currentGateDutyAction(row.id) !== null) continue; // already attention-only; its sealed duty survives newer inputs
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
      const gateDuty = this.currentGateDutyAction(active.id);
      if (gateDuty !== null && !isDeepStrictEqual(active.nextAction, resolved.nextAction)) throw new DirectiveCheckpointError('current gate action plan cannot mutate or launder sealed remaining duty bindings');
    }
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
  private closeApplicableObligations(jobId: string, terminal: TerminalJobStatus): void {
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
    // ACTIVE (unresolved) only: a resolved prior card must never win the
    // tie-break against its own repost and leave that repost outstanding.
    const card = this.findNotificationByKind(`silas.report-handback.${jobId}`, 'active');
    if (card !== null) this.resolveNotificationById(card.id, by);
  }

  /** Validate an actual report handback from its settled request and current
   * native receipt/cessation evidence. Candidate-tree cleanliness is
   * deliberately not consulted here. This is one of four hand-maintained
   * encodings of the request↔receipt correlation family — keep it in sync
   * with UNPROVEN_NATIVE_CANDIDATE_SQL, isReconstructedReportCandidateDelivery,
   * and assertNativeSettlementCandidate when the correlation rules change. */
  private isNativeReportHandbackDelivery(event: EventRecord): boolean {
    if (event.kind !== 'job.delivered' || event.jobId === null) return false;
    const payload = typeof event.payload === 'object' && event.payload !== null ? event.payload as Record<string, unknown> : null;
    if (payload === null || (payload['source'] !== 'silas-directive' && payload['source'] !== 'silas-rebrief') ||
        typeof payload['request_id'] !== 'string' || payload['request_id'].trim() === '' ||
        typeof payload['candidate_delivery_proven'] !== 'boolean') return false;
    const historical = payload['historical_bookkeeping_only'];
    if (historical !== undefined && typeof historical !== 'boolean') return false;
    if (historical === true) return false;
    const request = this.getDirective(payload['request_id']);
    const expectedSource = request?.requestKind === 'rebrief' ? 'silas-rebrief' : 'silas-directive';
    if (request === null || request.jobId !== event.jobId || request.requestKind === null || payload['source'] !== expectedSource ||
        request.state !== 'settled' || request.deliverySeq !== event.seq || request.nativeBinding === null || request.nativeTarget === null ||
        request.workRevision !== payload['work_revision'] || request.nativeBinding.agentId !== payload['agentId']) return false;
    const native = payload['native_completion'];
    if (typeof native !== 'object' || native === null || Array.isArray(native)) return false;
    const completion = native as Record<string, unknown>;
    try {
      const identity = this.directiveTurnIdentity(request.requestId);
      if (!isDeepStrictEqual(completion['identity'], identity) || !isDeepStrictEqual(completion['binding'], request.nativeBinding)) return false;
      this.assertNativeDirectiveDelivery(request, payload);
      return true;
    } catch (error) {
      // A proof mismatch is not completion: fail closed, retain the delivered
      // report, and let a later pass retry once the original native evidence
      // is readable again. No fact is repaired or inferred here. Unreadable
      // evidence is not a mismatch — it must surface to the caller's failure
      // accounting, never silently disqualify (same idiom as the settlement
      // candidate projection).
      if (error instanceof DirectiveCheckpointError) return false;
      throw error;
    }
  }

  /** Existing lost-delivery reconstruction is report-qualified only when its
   * own native path recorded the complete original facts and the ordinary
   * candidate projection still identifies this exact delivery. It remains
   * explicitly historical and cannot qualify a dirty/non-candidate tree. */
  private isReconstructedReportCandidateDelivery(event: EventRecord): boolean {
    if (event.kind !== 'job.delivered' || event.jobId === null) return false;
    const job = this.getJob(event.jobId);
    const payload = typeof event.payload === 'object' && event.payload !== null ? event.payload as Record<string, unknown> : null;
    const provenance = payload?.['provenance'];
    const currentProof = payload?.['current_candidate_proof'];
    return job !== null && job.deliverable !== null && isReportDeliverable(job.deliverable) && payload !== null &&
      payload['source'] === 'silas-rebrief' && payload['historical_bookkeeping_only'] === true &&
      payload['candidate_delivery_proven'] === true && typeof payload['marker_id'] === 'string' &&
      typeof payload['payload_hash'] === 'string' && typeof provenance === 'object' && provenance !== null &&
      !Array.isArray(provenance) && (provenance as Record<string, unknown>)['kind'] === 'original-correlated-completion' &&
      typeof currentProof === 'object' && currentProof !== null && !Array.isArray(currentProof) &&
      this.latestCandidateDelivery(event.jobId)?.seq === event.seq;
  }

  /** Ensure a durable report handback accompanies a correlated native report
   * or a reconstructed historical report whose independent candidate proof is
   * still current. Called inside the owning transaction so the open and the
   * cited delivery cannot be split across a crash. */
  private ensureReportHandback(jobId: string, deliveredSeq: number): void {
    const delivery = this.getEvent(deliveredSeq);
    if (delivery === null || delivery.jobId !== jobId ||
        !this.isNativeReportHandbackDelivery(delivery) && !this.isReconstructedReportCandidateDelivery(delivery)) return;
    const job = this.getJob(jobId);
    if (job === null || job.deliverable === null || !isReportDeliverable(job.deliverable)) return;
    this.openReportHandbackLineage(jobId, deliveredSeq);
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

  /** Report-type jobs with recorded deliverable status or a working status
   * whose exact native receipt may have landed before its status flip. The
   * backstop validates each candidate's own native proof before promoting
   * working → delivered or opening commissioner debt. Legacy NULL rows stay
   * excluded; same keyset paging contract as the supersede scan. */
  listReportHandbackRecoveryJobs(limit = 200, opts: { cursor?: number } = {}): readonly JobRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(`listReportHandbackRecoveryJobs requires a positive integer limit, got ${String(limit)}`);
    }
    const placeholders = REPORT_DELIVERABLES.map(() => '?').join(', ');
    const cursorClause = opts.cursor !== undefined ? 'AND rowid > ?' : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM jobs WHERE status IN ('working', 'delivered') AND deliverable IN (${placeholders}) ${cursorClause}
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
    kind?: 'directive' | 'rebrief';
    sourceContext?: { readonly ruleId?: string; readonly sourceRoundId?: string; readonly source?: string };
    /** Explicit completion intent; omitted = ordinary directive. */
    handoff?: CompletionHandoffIntent;
    /** The owner accepts this fresh request (by "owner", confirm_intent):
     * the only acceptance that releases an owner-abandonment hold. */
    ownerAccepted?: boolean;
  }): { readonly record: DirectiveRequestRecord; readonly created: boolean } {
    if (input.directive.trim() === '') throw new Error('directive text must be non-empty');
    if (input.holder.trim() === '') throw new Error('directive intent requires a non-empty holder');
    if (input.requestId !== undefined) {
      const reserved = this.db.prepare(`SELECT * FROM events WHERE kind = 'silas.rebrief-control-closed'
        AND json_extract(payload, '$.inspection_request_id') = ? ORDER BY seq DESC LIMIT 1`).get(input.requestId) as Row | undefined;
      if (reserved !== undefined) {
        const closure = this.eventFromRow(reserved);
        const facts = closure.payload as { inspection_directive: unknown };
        if (closure.jobId !== input.jobId || facts.inspection_directive !== input.directive || input.kind === 'rebrief') {
          throw new DirectiveCheckpointError('reserved current inspection identity requires this job’s exact separately approved current-inspection directive');
        }
      }
    }
    const job = this.getJob(input.jobId);
    if (job === null) throw new RecordNotFound(`job "${input.jobId}" not found`);
    const normalizeSourceContext = (context: { readonly ruleId?: string; readonly sourceRoundId?: string; readonly source?: string } | null | undefined) =>
      context === null || context === undefined || context.ruleId === undefined && context.sourceRoundId === undefined && context.source === undefined ? null :
        { ...(context.ruleId === undefined ? {} : { ruleId: context.ruleId }), ...(context.sourceRoundId === undefined ? {} : { sourceRoundId: context.sourceRoundId }),
          // Autopilot provenance (issue #243 M3): replayed onto the receipts.
          ...(context.source === undefined ? {} : { source: context.source }) };
    const sourceContext = normalizeSourceContext(input.sourceContext);
    const payload = JSON.stringify({ directive: input.directive, blocker_fingerprint: input.blockerFingerprint ?? null,
      ...(input.kind === 'rebrief' ? { request_kind: 'rebrief', rule_id: sourceContext?.ruleId ?? null, source_round_id: sourceContext?.sourceRoundId ?? null, ...(sourceContext?.source === undefined ? {} : { source: sourceContext.source }) } : {}) });
    const payloadHash = createHash('sha256').update(payload).digest('hex');
    return this.transaction(() => {
      if (input.requestId !== undefined) {
        const existing = this.getDirective(input.requestId);
        if (existing !== null) {
          if (existing.payloadHash !== payloadHash || !isDeepStrictEqual(normalizeSourceContext(existing.sourceContext), sourceContext)) {
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
              source: input.kind === 'rebrief' ? 'silas-rebrief' : 'silas-directive',
              intent: input.handoff,
              requestId: existing.requestId,
            });
          }
          return { record: existing, created: false }; // durable replay — the accepted request, unchanged
        }
      }
      // A replay of a stored id reads its outcome on any job; only a new
      // request needs a lane that still takes work.
      if (isJobTerminal(job.status)) {
        throw new Error(`job "${input.jobId}" is ${job.status} — terminal lanes take no directives`);
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
      // One writer per lane (owner rule 5): an unresolved re-brief request
      // owns the lane until it genuinely settles.
      if (this.listPendingRebriefs({ jobId: input.jobId }).length > 0) {
        throw new LaneWriterConflictError(
          `job "${input.jobId}" has an unresolved re-brief request — it owns the lane until it settles; ` +
            'wait for its settlement (or its boot reconciliation) before sending a directive',
        );
      }
      // The owner-approved property repair service holds its own `property
      // repair` allocation across its directive turns; that is the one
      // admission a property-repair directive may coexist with.
      this.assertNoProviderProducer(input.jobId, input.holder === 'property-contract-repair' ? (kind) => kind.startsWith('property repair ') : undefined);
      const requestId = input.requestId ?? randomUUID();
      const ts = nowIso();
      // The revision is bound in the SAME transaction as the intent: the
      // prompt composed for this request carries exactly these amendments.
      const workRevision = requiredWorkRevision(this.listJobAmendments(input.jobId));
      this.db
        .prepare(
          `INSERT INTO pending_directives
             (request_id, job_id, payload, payload_hash, state, baseline_seq, claim, attempts, created_at, updated_at, work_revision, authority_epoch, contract_snapshot, contract_sha256, request_kind, source_context)
           VALUES (?, ?, ?, ?, 'dispatching', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          workRevision,
          this.directiveRecoveryEpoch(input.jobId),
          this.effectiveContract(input.jobId)?.text ?? null,
          this.effectiveContract(input.jobId)?.contractSha256 ?? createHash('sha256').update('').digest('hex'),
          input.kind ?? 'directive',
          sourceContext === null ? null : JSON.stringify(sourceContext),
        );
      // A fresh accepted directive is the separately authorized, identity-
      // checked handoff that supersedes an open retirement hold on this
      // lane (the hold's own release record names THIS request).
      this.releaseDirectiveRecoveryHolds(input.jobId, requestId, input.ownerAccepted === true);
      this.db.prepare('UPDATE pending_directives SET authority_epoch = ? WHERE request_id = ?').run(this.directiveRecoveryEpoch(input.jobId), requestId);
      this.appendEvent({
        kind: 'silas.directive-intent',
        jobId: input.jobId,
        payload: {
          request_id: requestId,
          holder: input.holder,
          directive_bytes: Buffer.byteLength(input.directive, 'utf-8'),
          work_revision: workRevision,
        },
      });
      if (input.handoff !== undefined) {
        this.beginPhaseHandoff({
          jobId: input.jobId,
          source: input.kind === 'rebrief' ? 'silas-rebrief' : 'silas-directive',
          intent: input.handoff,
          requestId,
        });
      }
      return { record: this.getDirective(requestId) as DirectiveRequestRecord, created: true };
    });
  }

  beginRebriefIntent(input: { readonly jobId: string; readonly note: string; readonly holder: string; readonly requestId?: string;
    readonly handoff?: CompletionHandoffIntent; readonly sourceContext?: { readonly ruleId?: string; readonly sourceRoundId?: string; readonly source?: string };
    readonly ownerAccepted?: boolean }): ReturnType<LedgerApi['beginDirectiveIntent']> {
    return this.beginDirectiveIntent({ jobId: input.jobId, directive: input.note, holder: input.holder, kind: 'rebrief',
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }), ...(input.handoff === undefined ? {} : { handoff: input.handoff }),
      ...(input.sourceContext === undefined ? {} : { sourceContext: input.sourceContext }), ...(input.ownerAccepted === true ? { ownerAccepted: true } : {}) });
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

  directiveTurnIdentity(requestId: string): DirectiveTurnIdentity {
    const row = this.getDirective(requestId);
    if (row === null) throw new RecordNotFound(`directive request "${requestId}" not found`);
    if (row.authorityEpoch === null || row.workRevision === null || row.contractSha256 === null) throw new DirectiveCheckpointError('legacy directive authority is unprovable — Gru decision required');
    return { requestId, jobId: row.jobId, payloadHash: row.payloadHash, workRevision: row.workRevision, contractSha256: row.contractSha256, authorityEpoch: row.authorityEpoch };
  }

  assertDirectiveAuthority(identity: DirectiveTurnIdentity): void {
    validateDirectiveIdentity(identity);
    this.assertNoPendingCloseout(identity.requestId);
    const row = this.getDirective(identity.requestId);
    const job = this.getJob(identity.jobId);
    if (row === null || !isDeepStrictEqual(this.directiveTurnIdentity(row.requestId), identity) || isDirectiveTerminal(row.state) ||
        job === null || isJobTerminal(job.status) || job.status === 'parked' ||
        this.hasOpenDirectiveRecoveryHold(identity.jobId) || this.directiveRecoveryEpoch(identity.jobId) !== identity.authorityEpoch) {
      throw new DirectiveCheckpointError('directive authority is terminal, held or superseded — no work may proceed');
    }
    if (requiredWorkRevision(this.listJobAmendments(identity.jobId)) !== identity.workRevision ||
        (this.effectiveContract(identity.jobId)?.contractSha256 ?? createHash('sha256').update('').digest('hex')) !== identity.contractSha256) {
      throw new DirectiveCheckpointError('accepted directive revision/contract is superseded — original continuation is forbidden');
    }
    if (row.nativeTarget !== null && !this.listImplementerMinions(identity.jobId).some((agent) =>
      agent.id === row.nativeTarget!.agentId && agent.sessionFile === row.nativeTarget!.sessionFile && agent.parentage !== 'child')) {
      throw new DirectiveCheckpointError('original logical minion/session authority changed — continuation is forbidden');
    }
    this.assertRecoveryJobPermission(identity.jobId);
  }

  assertRecoveryJobPermission(jobId: string): void {
    const job = this.getJob(jobId);
    if (!job || isJobTerminal(job.status) || job.status === 'parked' || this.hasOpenDirectiveRecoveryHold(jobId)) throw new DirectiveCheckpointError('recovery job is terminal, parked or held');
    if (this.listObligations({ jobId: jobId }).some((debt) =>
      (debt.state === 'open' || debt.state === 'waiting' || debt.state === 'suspended') && debt.nextAction.kind === 'owner-decision')) {
      throw new DirectiveCheckpointError('owner-only decision holds this job — recovery cannot acknowledge it');
    }
    if (this.db.prepare(`SELECT 1 FROM notifications n JOIN agents a ON a.id = n.agent_id
      WHERE a.job_id = ? AND n.routing = 'needs-owner' AND n.acked_at IS NULL AND n.resolved_at IS NULL LIMIT 1`).get(jobId)) {
      throw new DirectiveCheckpointError('owner-only stop holds this job — recovery cannot acknowledge it');
    }
  }

  /** Reserves the dispatch (once). A reservation alone is no cleanup
   * blocker — see directiveCleanupBlockers (#362). */
  claimDirectiveDispatch(requestId: string): boolean {
    return this.transaction(() => {
      this.assertNoPendingCloseout(requestId);
      const identity = this.directiveTurnIdentity(requestId);
      const cleanupBlockers = this.directiveCleanupBlockers(identity.jobId);
      if (cleanupBlockers.length > 0) throw new DirectiveCheckpointError(`original producer cessation unproven: ${cleanupBlockers.join('; ')}`);
      this.assertDirectiveAuthority(identity);
      const row = this.getDirective(requestId)!;
      if (row.dispatchStartedAt !== null && !this.hasDirectiveDispatchDeferral(requestId)) return false;
      this.appendEvent({ kind: 'silas.directive-producer-reserved', jobId: identity.jobId, payload: { fact: 'reservation', request_id: requestId, producer_identity: identity } });
      this.db.prepare('UPDATE pending_directives SET dispatch_started_at = ? WHERE request_id = ?').run(nowIso(), requestId);
      this.appendEvent({ kind: 'silas.directive-dispatch-started', jobId: row.jobId, payload: { request_id: requestId } });
      return true;
    });
  }

  /** Exact positive no-native-effect receipt, never inferred from missing
   * targets, claim age, spawn errors or a missing onPrepared callback. */
  recordDirectiveDispatchDeferral(identity: DirectiveTurnIdentity, dispatchStartSeq: number, reason: string): void {
    this.transaction(() => {
      this.assertDirectiveAuthority(identity);
      const row = this.getDirective(identity.requestId)!;
      const start = this.latestJobEventByRequestId(identity.jobId, 'silas.directive-dispatch-started', identity.requestId);
      if (row.state !== 'dispatching' || row.nativeTarget !== null || row.nativeBinding !== null || row.recoveryCheckpoint !== null ||
          start?.seq !== dispatchStartSeq || !reason.trim()) throw new DirectiveCheckpointError('pre-native deferral does not bind the exact unconsumed dispatch reservation');
      this.appendEvent({ kind: 'silas.directive-dispatch-deferred', jobId: identity.jobId,
        payload: { request_id: identity.requestId, dispatch_start_seq: dispatchStartSeq, identity, reason, native_effects: 'none' } });
    });
  }

  hasDirectiveDispatchDeferral(requestId: string): boolean {
    const row = this.getDirective(requestId);
    if (row === null || row.state !== 'dispatching' || row.nativeTarget !== null || row.nativeBinding !== null || row.recoveryCheckpoint !== null) return false;
    const start = this.latestJobEventByRequestId(row.jobId, 'silas.directive-dispatch-started', requestId);
    const deferred = this.latestJobEventByRequestId(row.jobId, 'silas.directive-dispatch-deferred', requestId);
    const facts = deferred?.payload as { dispatch_start_seq?: unknown; identity?: unknown; native_effects?: unknown } | undefined;
    return start !== null && deferred !== null && deferred.seq > start.seq && facts?.dispatch_start_seq === start.seq &&
      facts.native_effects === 'none' && isDeepStrictEqual(facts.identity, this.directiveTurnIdentity(requestId));
  }

  prepareDirectiveTarget(requestId: string, target: { readonly agentId: string; readonly sessionFile: string }): void {
    this.transaction(() => {
      const identity = this.directiveTurnIdentity(requestId);
      this.assertDirectiveAuthority(identity);
      const row = this.getDirective(requestId)!;
      const agent = this.getAgent(target.agentId);
      if (agent?.jobId !== row.jobId || agent.sessionFile !== target.sessionFile || agent.parentage === 'child') throw new DirectiveCheckpointError('native directive target does not match the logical job minion/session');
      if (row.nativeTarget !== null && !isDeepStrictEqual(row.nativeTarget, target)) throw new DirectiveCheckpointError('native directive target cannot be replaced');
      this.db.prepare('UPDATE pending_directives SET native_target = ? WHERE request_id = ?').run(JSON.stringify(target), requestId);
    });
  }

  bindDirectiveNativeAdmission(binding: DirectiveNativeBinding): DirectiveRequestRecord {
    return this.transaction(() => {
      validateDirectiveIdentity(binding.identity);
      const row = this.getDirective(binding.identity.requestId);
      if (row === null || isDirectiveTerminal(row.state) || !isDeepStrictEqual(this.directiveTurnIdentity(row.requestId), binding.identity)) throw new DirectiveCheckpointError('native admission does not match a live accepted request');
      // Both runtimes attest exact admission (#424: claude-code by its CLI echo).
      if ((binding.runtime !== 'pi' && binding.runtime !== 'claude-code') || !binding.sessionId || !binding.userEntryId || !/^[a-f0-9]{64}$/.test(binding.promptHash) ||
          row.nativeTarget?.agentId !== binding.agentId || row.nativeTarget?.sessionFile !== binding.sessionFile) throw new DirectiveCheckpointError('actual native admission identity is incomplete/mismatched');
      const actual = inspectDirectiveAdmission(binding.sessionFile, binding.identity);
      if (!isDeepStrictEqual(actual, binding)) throw new DirectiveCheckpointError('native admission does not match actual durable user readback');
      if (row.nativeBinding !== null) {
        if (!isDeepStrictEqual(row.nativeBinding, binding)) throw new DirectiveCheckpointError('actual native admission cannot be rebound');
        return row;
      }
      const sent = this.appendEvent({ kind: 'silas.directive-sent', jobId: row.jobId,
        payload: { request_id: row.requestId, minion_id: binding.agentId, native_binding: binding,
          ...(row.sourceContext?.ruleId === undefined ? {} : { rule_id: row.sourceContext.ruleId }),
          ...(row.sourceContext?.sourceRoundId === undefined ? {} : { source_round_id: row.sourceContext.sourceRoundId }),
          ...(row.sourceContext?.source === undefined ? {} : { source: row.sourceContext.source }),
          blocker_fingerprint: (JSON.parse(row.payload) as { blocker_fingerprint?: unknown }).blocker_fingerprint ?? null } });
      this.db.prepare('UPDATE pending_directives SET native_binding = ? WHERE request_id = ?').run(JSON.stringify(binding), row.requestId);
      const admitted = this.recordDirectiveAdmission({ requestId: row.requestId, minionId: binding.agentId, eventSeq: sent.seq });
      // Fresh accepted successor admission is a real handoff, not retirement.
      const predecessors = this.db.prepare("SELECT request_id FROM pending_directives WHERE job_id = ? AND json_extract(recovery_decision, '$.successorId') = ?").all(row.jobId, row.requestId) as Row[];
      for (const predecessor of predecessors) this.settleDirectiveRecoveryDebt(str(predecessor.request_id), sent.seq, 'silas.directive-sent');
      const rebriefs = this.db.prepare('SELECT marker_id FROM rebrief_recovery_decisions WHERE successor_id = ?').all(row.requestId) as Row[];
      for (const marker of rebriefs) {
        const debt = this.recoveryObligation(row.jobId, 'rebrief', str(marker.marker_id));
        if (debt !== null && (debt.state === 'open' || debt.state === 'waiting')) {
          this.settleObligation({ obligationId: debt.id, settlement: { kind: 'executed-action', action: 'actual rebrief recovery successor admission', evidenceEventSeq: sent.seq, evidenceEventKind: sent.kind } });
          const card = this.findNotificationByKind(`silas.rebrief-unreconciled.${row.jobId}`, 'active');
          if (card?.routing === 'action-required') this.resolveNotificationById(card.id, 'rebrief-recovery-evidence');
        }
      }
      return admitted;
    });
  }

  appendCustomEventIfCurrentDirective(fields: { readonly kind: string; readonly jobId: string; readonly payload: unknown }, identity: DirectiveTurnIdentity): EventRecord {
    return this.transaction(() => { this.assertDirectiveAuthority(identity); return this.appendEvent(fields); });
  }

  startDirectiveProducer(identity: DirectiveTurnIdentity, producer: DirectiveProducer): number {
    return this.transaction(() => {
      this.assertDirectiveAuthority(identity);
      const target = this.getDirective(identity.requestId)!.nativeTarget;
      if (!isDeepStrictEqual(producer.identity, identity) || producer.agentId !== target?.agentId || producer.sessionFile !== target.sessionFile ||
          !producer.incarnation || !producer.sessionId || !producer.host || !Number.isSafeInteger(producer.pid) || producer.pid <= 0) {
        throw new DirectiveCheckpointError('native producer start must bind the exact prepared physical request/session authority');
      }
      const blockers = this.directiveCleanupBlockers(identity.jobId);
      if (blockers.length > 0) throw new DirectiveCheckpointError(`original producer cessation unproven: ${blockers.join('; ')}`);
      this.appendEvent({ kind: 'silas.directive-producer-started', jobId: identity.jobId,
        payload: { request_id: identity.requestId, producer_identity: identity, native_producer: producer } });
      return this.directiveProducerStart(identity);
    });
  }

  directiveProducerStart(identity: DirectiveTurnIdentity): number {
    const event = this.latestJobEventByRequestId(identity.jobId, 'silas.directive-producer-started', identity.requestId);
    const payload = event?.payload as { producer_identity?: unknown } | undefined;
    if (event === null || !isDeepStrictEqual(payload?.producer_identity, identity)) throw new DirectiveCheckpointError('exact directive producer start receipt missing');
    return event.seq;
  }

  private validateDirectiveProducerReceipt(jobId: string | null, raw: unknown): void {
    const payload = raw as { producer_start_seq?: unknown; producer_identity?: DirectiveTurnIdentity; request_id?: unknown; agent_id?: unknown; session_file?: unknown } | undefined;
    if (payload?.producer_start_seq === undefined) return; // legacy records cannot consume a new start fence
    const start = typeof payload.producer_start_seq === 'number' ? this.getEvent(payload.producer_start_seq) : null;
    const identity = payload.producer_identity;
    const row = typeof payload.request_id === 'string' ? this.getDirective(payload.request_id) : null;
    if (identity === undefined || row === null || start?.kind !== 'silas.directive-producer-started' || start.jobId !== jobId || row.jobId !== jobId ||
        !isDeepStrictEqual((start.payload as { producer_identity?: unknown }).producer_identity, identity) ||
        !isDeepStrictEqual(this.directiveTurnIdentity(row.requestId), identity) || identity.requestId !== payload.request_id ||
        row.nativeTarget?.agentId !== payload.agent_id || row.nativeTarget?.sessionFile !== payload.session_file ||
        !isDeepStrictEqual((start.payload as { native_producer?: unknown }).native_producer, (raw as { native_producer?: unknown }).native_producer)) {
      throw new DirectiveCheckpointError('producer cleanup receipt does not bind the exact original start/request/minion/session authority');
    }
  }

  /** A dispatch reservation alone is deliberately NOT a cleanup blocker
   * (#362): every route prompts only after onPrepared has committed the
   * native target and the producer start (each of which IS fenced here), so
   * a crash between registry.spawn() and onPrepared left no native effect —
   * the spawned registration leaves the agent idle, with no open turn. The
   * reserved request is never replayed (its claim is spent) and owes a
   * recovery decision; a successor may proceed at once. Pinned by the
   * crash-window tests in restart-recovery-progress.test.ts. */
  private directiveCleanupBlockers(jobId: string, ownProducerStartSeq?: number): readonly string[] {
    const rows = this.db.prepare(`SELECT seq, kind, payload FROM events e WHERE e.job_id = ?
      AND e.kind IN ('silas.directive-producer-unknown', 'silas.directive-producer-ceased')
      AND NOT EXISTS (SELECT 1 FROM events newer WHERE newer.job_id = e.job_id AND newer.seq > e.seq
        AND newer.kind IN ('silas.directive-producer-unknown', 'silas.directive-producer-ceased')
        AND json_extract(newer.payload, '$.request_id') = json_extract(e.payload, '$.request_id')
        AND json_extract(newer.payload, '$.agent_id') = json_extract(e.payload, '$.agent_id')
        AND json_extract(newer.payload, '$.session_file') IS json_extract(e.payload, '$.session_file')
        AND ((json_extract(e.payload, '$.producer_start_seq') IS NOT NULL
          AND json_extract(newer.payload, '$.producer_start_seq') = json_extract(e.payload, '$.producer_start_seq'))
          OR json_extract(newer.payload, '$.producer_unknown_seq') = e.seq))`).all(jobId) as Row[];
    type CleanupReceipt = { readonly request_id?: unknown; readonly agent_id?: unknown; readonly session_file?: unknown;
      readonly producer_start_seq?: unknown; readonly producer_identity?: unknown; readonly native_producer?: DirectiveProducer };
    const ceasedByStart = new Map<number, readonly { readonly seq: number; readonly receipt: CleanupReceipt }[]>();
    for (const row of rows) {
      if (row.kind !== 'silas.directive-producer-ceased') continue;
      const receipt = JSON.parse(str(row.payload)) as CleanupReceipt;
      if (typeof receipt.producer_start_seq !== 'number') continue;
      ceasedByStart.set(receipt.producer_start_seq, [...(ceasedByStart.get(receipt.producer_start_seq) ?? []), { seq: Number(row.seq), receipt }]);
    }
    const starts = this.db.prepare(`SELECT seq, payload FROM events WHERE job_id = ? AND kind = 'silas.directive-producer-started'`).all(jobId) as Row[];
    const pending = starts.filter((row) => {
      if (Number(row.seq) === ownProducerStartSeq) return false;
      const start = JSON.parse(str(row.payload)) as CleanupReceipt;
      // The write boundary accepts structural identity, not JSON property
      // order. Readback must keep that same exact physical start contract.
      return !(ceasedByStart.get(Number(row.seq)) ?? []).some(({ seq, receipt }) => seq > Number(row.seq) && start.native_producer !== undefined &&
        receipt.request_id === start.request_id && receipt.agent_id === start.native_producer.agentId &&
        receipt.session_file === start.native_producer.sessionFile &&
        isDeepStrictEqual(receipt.producer_identity, start.producer_identity) &&
        isDeepStrictEqual(receipt.native_producer, start.native_producer));
    }).map((row) => {
      const payload = JSON.parse(str(row.payload)) as { request_id: string };
      return `unproven producer cleanup: request ${payload.request_id}, start ${Number(row.seq)} — original-owner cessation receipt required; inspect exact native/controller evidence before Gru judgment`;
    });
    return [...pending, ...rows.filter((row) => row.kind === 'silas.directive-producer-unknown').map((row) => {
      const payload = JSON.parse(str(row.payload)) as { request_id: string; agent_id: string };
      return `unproven producer cleanup: minion ${payload.agent_id}, request ${payload.request_id}`;
    })];
  }

  directiveProgressBlockers(requestId: string, laneId: string, ownSpawningAgentId?: string, ownProducerStartSeq?: number, ownNativeProducer?: DirectiveProducer): readonly string[] {
    const row = this.getDirective(requestId);
    if (row === null) throw new RecordNotFound(`directive request "${requestId}" not found`);
    if (ownProducerStartSeq !== undefined && this.directiveProducerStart(this.directiveTurnIdentity(requestId)) !== ownProducerStartSeq) {
      throw new DirectiveCheckpointError('current producer token does not match this exact request start');
    }
    if (ownNativeProducer !== undefined) {
      const start = ownProducerStartSeq === undefined ? null : this.getEvent(ownProducerStartSeq);
      const identity = this.directiveTurnIdentity(requestId);
      const agent = this.getAgent(ownNativeProducer.agentId);
      if (start === null || !isDeepStrictEqual((start.payload as { native_producer?: unknown }).native_producer, ownNativeProducer) ||
          !isDeepStrictEqual(ownNativeProducer.identity, identity) || ownNativeProducer.pid !== process.pid || ownNativeProducer.host !== hostname() ||
          agent?.jobId !== row.jobId || agent.parentage === 'child' || agent.sessionFile !== ownNativeProducer.sessionFile ||
          row.nativeTarget?.agentId !== ownNativeProducer.agentId || row.nativeTarget.sessionFile !== ownNativeProducer.sessionFile ||
          agent.state === 'streaming' && row.nativeBinding === null ||
          row.nativeBinding !== null && row.nativeBinding.sessionId !== ownNativeProducer.sessionId) {
        throw new DirectiveCheckpointError('active native producer does not bind the exact current physical request/session/start token');
      }
      const physical = inspectDirectiveProducers(ownNativeProducer.sessionFile);
      const current = physical.find(({ producer }) => isDeepStrictEqual(producer, ownNativeProducer));
      if (current?.evidence !== 'unknown' || physical.some(({ producer, evidence }) => producer.incarnation !== ownNativeProducer.incarnation && evidence === 'unknown')) {
        throw new DirectiveCheckpointError('active native producer is ceased/unbound or another physical incarnation remains UNKNOWN');
      }
    }
    return this.directiveRetirementBlockers(row, laneId, ownSpawningAgentId, ownProducerStartSeq, ownNativeProducer);
  }

  claimDirectiveCheckpoint(identity: DirectiveTurnIdentity, checkpointId: string): void {
    if (checkpointId.trim() === '') throw new DirectiveCheckpointError('native checkpoint id required');
    this.transaction(() => {
      this.assertDirectiveAuthority(identity);
      const row = this.getDirective(identity.requestId)!;
      if (row.nativeBinding === null || row.recoveryCheckpoint !== null) throw new DirectiveCheckpointError('native continuation already claimed or admission unproven — reconcile actual native progress, never retry by age');
      this.db.prepare('UPDATE pending_directives SET recovery_checkpoint = ? WHERE request_id = ?').run(checkpointId, row.requestId);
      this.appendEvent({ kind: 'silas.directive-continuation-claimed', jobId: row.jobId,
        payload: { request_id: row.requestId, checkpoint_id: checkpointId, native_binding: row.nativeBinding } });
    });
  }

  recoveryDecisionHistory(kind: RecoverySubjectKind, subjectId: string): readonly RecoveryDecisionHistory[] {
    const eventKind = kind === 'directive' ? 'silas.directive-recovery-decided' : 'silas.rebrief-recovery-decided';
    const key = kind === 'directive' ? 'request_id' : 'marker_id';
    const rows = this.db.prepare(`SELECT * FROM events WHERE kind = ? AND json_extract(payload, '$.${key}') = ? ORDER BY seq`)
      .all(eventKind, subjectId) as Row[];
    return rows.map((row) => {
      const event = this.eventFromRow(row);
      const payload = event.payload as { fingerprint: string; generation: number; decision: { kind: string; requestId?: string }; owner_transfer?: RecoveryOwnerTransfer; current_inspection_obligation_id?: string };
      if (typeof payload.fingerprint !== 'string') throw new DirectiveCheckpointError('recovery decision history lacks its immutable fingerprint');
      return { eventSeq: event.seq, fingerprint: payload.fingerprint, generation: payload.generation,
        successorId: payload.decision.kind === 'successor' || payload.decision.kind === 'rebrief-successor' ? payload.decision.requestId ?? null : null,
        ownerTransfer: payload.owner_transfer ?? null, currentInspectionObligationId: payload.current_inspection_obligation_id ?? null };
    });
  }

  rebriefCurrentActionObligationLineages(markerId: string): readonly {
    readonly decisionEvent: EventRecord;
    readonly gateEvents: readonly EventRecord[];
    readonly obligations: readonly ObligationRecord[];
    readonly currentObligation: ObligationRecord;
  }[] {
    return this.recoveryDecisionHistory('rebrief', markerId).filter((history) => history.currentInspectionObligationId !== null).map((history) => {
      const decisionEvent = this.getEvent(history.eventSeq);
      if (decisionEvent === null || decisionEvent.jobId === null) throw new DirectiveCheckpointError('current action lineage original decision is unavailable');
      const root = this.getObligation(history.currentInspectionObligationId!);
      if (root === null || root.jobId !== decisionEvent.jobId || root.incidentKey !== `rebrief-current-inspection:${markerId}`) throw new DirectiveCheckpointError('current action lineage inspection root is missing or foreign');
      const obligations: ObligationRecord[] = []; const seen = new Set<string>(); let cursor = root;
      while (true) {
        if (seen.has(cursor.id)) throw new DirectiveCheckpointError('current action obligation lineage is cyclic');
        seen.add(cursor.id); obligations.push(cursor);
        if (cursor.settlement?.kind !== 'superseded') break;
        if (cursor.settlement.byObligationId === null) throw new DirectiveCheckpointError('current action obligation lineage loses its owed successor');
        const next = this.getObligation(cursor.settlement.byObligationId);
        if (next === null || next.jobId !== root.jobId) throw new DirectiveCheckpointError('current action obligation lineage successor is missing or foreign');
        const protectedAction = this.currentGateDutyAction(next.id);
        if (protectedAction === null || !('decision' in protectedAction) || !('decision' in next.nextAction) || next.nextAction.decision !== protectedAction.decision) throw new DirectiveCheckpointError('current action obligation lineage successor bindings changed or are unproven');
        cursor = next;
      }
      const gateRows = this.db.prepare("SELECT * FROM events WHERE job_id = ? AND kind = 'silas.rebrief-current-gates-owed' AND json_extract(payload, '$.marker_id') = ? ORDER BY seq").all(root.jobId, markerId) as Row[];
      const gateEvents = gateRows.map((row) => this.eventFromRow(row)).filter((event) =>
        obligations.some((row) => row.id === (event.payload as { obligation_id?: unknown }).obligation_id));
      return { decisionEvent, gateEvents, obligations, currentObligation: cursor };
    });
  }

  recoverySubject(kind: RecoverySubjectKind, subjectId: string): RecoverySubject {
    let jobId: string;
    let snapshot: unknown;
    if (kind === 'directive') {
      const row = this.getDirective(subjectId);
      if (row === null) throw new RecordNotFound(`directive request "${subjectId}" not found`);
      jobId = row.jobId;
      snapshot = { requestId: row.requestId, jobId, payloadHash: row.payloadHash, baselineSeq: row.baselineSeq,
        workRevision: row.workRevision, contractSha256: row.contractSha256, authorityEpoch: row.authorityEpoch,
        nativeTarget: row.nativeTarget, nativeBinding: row.nativeBinding, admissionSeq: row.admissionSeq,
        admissionMinion: row.admissionMinion, deliverySeq: row.deliverySeq, recoveryCheckpoint: row.recoveryCheckpoint };
    } else {
      const evidence = this.rebriefReceiptEvidence(subjectId);
      jobId = evidence.markers[0]!.jobId;
      snapshot = evidence;
    }
    return { kind, id: subjectId, jobId, snapshot, snapshotSha256: createHash('sha256').update(canonicalRebriefEvidence(snapshot)).digest('hex') };
  }

  private ownerRecoveryTarget(id: string, jobId: string): ObligationRecord {
    const target = this.getObligation(id);
    if (target === null || target.jobId !== jobId || target.logicalStep !== 'operation' ||
        target.category.kind !== 'known' || target.category.category !== 'owner-hold' ||
        target.nextAction.kind !== 'owner-decision' || !['open', 'waiting', 'suspended'].includes(target.state)) {
      throw new DirectiveCheckpointError('owner transfer requires this job’s real live job-wide operation owner-hold; generic, limited or foreign decisions cannot qualify');
    }
    return target;
  }

  private makeOwnerRecoveryTransfer(subject: RecoverySubject, debt: ObligationRecord, targetId: string): RecoveryOwnerTransfer {
    const target = this.ownerRecoveryTarget(targetId, subject.jobId);
    const { id, jobId, logicalStep, generation, planRevision, category, authority, nextAction, firstOriginSeq, lastOriginSeq } = target;
    return { subject, debtId: debt.id, generation: debt.generation,
      target: { id, jobId, logicalStep, generation, planRevision, category, authority, nextAction, firstOriginSeq, lastOriginSeq },
      epoch: this.directiveRecoveryEpoch(subject.jobId) };
  }

  private closeOwnerTransferredRecoveryDebt(debt: ObligationRecord, transfer: RecoveryOwnerTransfer, event: EventRecord): void {
    this.settleObligation({ obligationId: debt.id, settlement: debt.state === 'suspended'
      ? { kind: 'superseded', byObligationId: transfer.target.id, reason: `exact recovery subject transferred by event ${event.seq}` }
      : { kind: 'executed-action', action: `exact recovery subject transferred to owner obligation ${transfer.target.id}`,
        evidenceEventSeq: event.seq, evidenceEventKind: event.kind } });
  }

  private recoveryOwnerLineage(transfer: RecoveryOwnerTransfer): { readonly sha256: string; readonly events: readonly EventRecord[] } {
    const snapshot = transfer.subject.snapshot as { authorityEpoch?: number; baselineSeq?: number; markers?: readonly { baselineSeq: number }[] };
    const from = snapshot.authorityEpoch ?? snapshot.baselineSeq ?? Math.min(...(snapshot.markers ?? []).map((marker) => marker.baselineSeq));
    const rows = this.db.prepare(`SELECT * FROM events WHERE job_id = ? AND seq > ? AND
      ((${DIRECTIVE_CONTROL_SQL}) OR (kind IN ('job.obligation-state', 'job.obligation-settled', 'job.obligation-updated') AND json_extract(payload, '$.id') = ?)) ORDER BY seq`)
      .all(transfer.subject.jobId, from, transfer.target.id) as Row[];
    const events = rows.map((row) => this.eventFromRow(row));
    const facts = events.map(({ seq, kind, jobId, payload }) => ({ seq, kind, jobId, payload }));
    return { events, sha256: createHash('sha256').update(canonicalRebriefEvidence(facts)).digest('hex') };
  }

  private ownerLineagePermits(transfer: RecoveryOwnerTransfer, events: readonly EventRecord[]): boolean {
    return events.every((event) => {
      const payload = event.payload as Record<string, unknown>;
      if (event.kind === 'job.amendment-accepted') return true;
      if (event.kind.startsWith('job.obligation-')) return payload['id'] === transfer.target.id;
      if (event.kind === 'job.status') return event.seq >= transfer.target.firstOriginSeq &&
        (payload['to'] === 'parked' || payload['to'] === 'blocked');
      if (event.kind === 'ruling.recorded' || event.kind === 'silas.recovery-owner-stop-confirmed') {
        const recorded = this.recoveryDecisionHistory(transfer.subject.kind, transfer.subject.id)
          .find((decision) => decision.eventSeq === payload['transfer_event_seq']);
        // Earlier exact owner actions remain immutable lineage, not a
        // grant for this new incarnation/plan. A current ruling and its
        // genuine confirmation are still separately required below.
        return payload['by'] === 'owner' && payload['subject_id'] === transfer.subject.id &&
          payload['subject_kind'] === transfer.subject.kind && recorded?.ownerTransfer?.target.id === transfer.target.id;
      }
      return false;
    });
  }

  recoveryOwnerResolution(kind: RecoverySubjectKind, subjectId: string, resolutionId?: string): EventRecord | null {
    const row = this.db.prepare(`SELECT * FROM events WHERE kind = 'ruling.recorded'
      AND json_extract(payload, '$.permission') = 'fresh-current-approved-recovery-successor'
      AND json_extract(payload, '$.subject_kind') = ? AND json_extract(payload, '$.subject_id') = ?
      ${resolutionId === undefined ? '' : "AND json_extract(payload, '$.resolution_id') = ?"} ORDER BY seq DESC LIMIT 1`)
      .get(kind, subjectId, ...(resolutionId === undefined ? [] : [resolutionId])) as Row | undefined;
    return row === undefined ? null : this.eventFromRow(row);
  }

  recoveryOwnerReadback(kind: RecoverySubjectKind, subjectId: string): {
    readonly history: readonly RecoveryDecisionHistory[]; readonly transfer: RecoveryDecisionHistory | null;
    readonly target: ObligationRecord | null; readonly lineageSha256: string | null;
    readonly resolution: EventRecord | null; readonly confirmation: EventRecord | null;
    readonly ownerActionRecipe: unknown;
  } {
    const history = this.recoveryDecisionHistory(kind, subjectId);
    const latest = history.at(-1) ?? null;
    const transfer = latest?.ownerTransfer === null ? null : latest;
    const target = transfer?.ownerTransfer === undefined || transfer.ownerTransfer === null ? null : this.getObligation(transfer.ownerTransfer.target.id);
    const resolution = this.recoveryOwnerResolution(kind, subjectId);
    const row = this.db.prepare(`SELECT * FROM events WHERE kind = 'silas.recovery-owner-stop-confirmed'
      AND json_extract(payload, '$.subject_kind') = ? AND json_extract(payload, '$.subject_id') = ? ORDER BY seq DESC LIMIT 1`)
      .get(kind, subjectId) as Row | undefined;
    return { history, transfer, target,
      lineageSha256: transfer?.ownerTransfer == null ? null : this.recoveryOwnerLineage(transfer.ownerTransfer).sha256,
      resolution, confirmation: row === undefined ? null : this.eventFromRow(row),
      ownerActionRecipe: transfer?.ownerTransfer == null ? null : {
        recordPath: `/api/silas/${kind === 'directive' ? 'directives' : 'rebriefs'}/${encodeURIComponent(subjectId)}/owner-resolution`,
        confirmPath: `/api/silas/${kind === 'directive' ? 'directives' : 'rebriefs'}/${encodeURIComponent(subjectId)}/owner-resolution/confirm-stop`,
        explicitAttribution: 'owner', confirmIntent: true, stableResolutionIdRequired: true,
        transferEventSeq: transfer.eventSeq, transferFingerprint: transfer.fingerprint,
        subjectSha256: transfer.ownerTransfer.subject.snapshotSha256, targetId: transfer.ownerTransfer.target.id,
        targetGeneration: transfer.ownerTransfer.target.generation, targetPlanRevision: transfer.ownerTransfer.target.planRevision,
        lineageSha256: this.recoveryOwnerLineage(transfer.ownerTransfer).sha256,
        currentAuthority: this.directiveCurrentAuthority(transfer.ownerTransfer.subject.jobId),
        currentEpoch: this.directiveRecoveryEpoch(transfer.ownerTransfer.subject.jobId),
        warning: 'Shared bearer attribution is not independently verified identity. Record permission, separately affirm/confirm the real governing target, then explicitly unpark the job if intended. No action executes work or proves original effects/cessation/completion. A separate fresh Gru generation/judgment is required.' } };
  }

  private validateRecoveryOwnerAction(input: RecoveryOwnerActionInput): { readonly subject: RecoverySubject; readonly transfer: RecoveryDecisionHistory; readonly target: ObligationRecord; readonly lineage: { readonly sha256: string; readonly events: readonly EventRecord[] } } {
    const subject = this.recoverySubject(input.kind, input.subjectId);
    const transfer = this.recoveryDecisionHistory(input.kind, input.subjectId).at(-1);
    if (transfer?.ownerTransfer == null || transfer.eventSeq !== input.transferEventSeq ||
        transfer.fingerprint !== input.expectedTransferFingerprint || subject.snapshotSha256 !== input.expectedSubjectSha256 ||
        transfer.ownerTransfer.subject.snapshotSha256 !== subject.snapshotSha256) throw new DirectiveCheckpointError('owner resolution transfer/subject snapshot is stale or unproven');
    const target = this.ownerRecoveryTarget(transfer.ownerTransfer.target.id, subject.jobId);
    if (target.generation !== input.expectedTargetGeneration || target.planRevision !== input.expectedTargetPlanRevision ||
        target.generation !== transfer.ownerTransfer.target.generation || target.planRevision !== transfer.ownerTransfer.target.planRevision) {
      throw new DirectiveCheckpointError('owner resolution target generation/plan changed — separately fenced transfer required');
    }
    const lineage = this.recoveryOwnerLineage(transfer.ownerTransfer);
    if (lineage.sha256 !== input.expectedLineageSha256 || !this.ownerLineagePermits(transfer.ownerTransfer, lineage.events) ||
        this.directiveRecoveryEpoch(subject.jobId) !== input.expectedEpoch || !input.reason.trim()) throw new DirectiveCheckpointError('owner resolution stop lineage/epoch is stale, unrelated or incomplete');
    const job = this.getJob(subject.jobId);
    if (job === null || isJobTerminal(job.status)) throw new DirectiveCheckpointError('terminal work cannot receive a recovery owner grant');
    this.assertFreshRecoveryContract(subject.jobId, input.expectedWorkRevision, input.expectedContractSha256);
    return { subject, transfer, target, lineage };
  }

  /** Explicit owner-attributed input only. This records narrowly scoped
   * permission, never resumes/Acks/stops a producer or executes work. */
  recordRecoveryOwnerResolution(input: RecoveryOwnerActionInput): { readonly event: EventRecord; readonly idempotent: boolean } {
    const fingerprint = createHash('sha256').update(canonicalRebriefEvidence({ version: 1, ...input })).digest('hex');
    return this.transaction(() => {
      if (!input.resolutionId.trim()) throw new DirectiveCheckpointError('owner resolution requires a stable unused identity');
      const prior = this.recoveryOwnerResolution(input.kind, input.subjectId, input.resolutionId);
      if (prior !== null) {
        if ((prior.payload as { fingerprint?: unknown }).fingerprint !== fingerprint) throw new DirectiveCheckpointError('owner resolution identity conflicts');
        return { event: prior, idempotent: true };
      }
      const { subject, transfer, target, lineage } = this.validateRecoveryOwnerAction(input);
      const event = this.appendCustomEvent({ kind: 'ruling.recorded', jobId: subject.jobId,
        payload: { version: 1, by: 'owner', permission: 'fresh-current-approved-recovery-successor', resolution_id: input.resolutionId,
          ref: `recovery-owner:${input.kind}:${input.subjectId}:${input.resolutionId}`, ruling_version: '1', fingerprint,
          subject_kind: input.kind, subject_id: input.subjectId, subject, transfer_event_seq: transfer.eventSeq,
          transfer_fingerprint: transfer.fingerprint, target: transfer.ownerTransfer!.target,
          stop_lineage: lineage.events.map(({ seq, kind, jobId, payload }) => ({ seq, kind, jobId, payload })),
          work_revision: input.expectedWorkRevision, contract_sha256: input.expectedContractSha256, head: input.expectedHead,
          epoch: input.expectedEpoch, reason: input.reason, target_state: target.state } });
      return { event, idempotent: false };
    });
  }

  /** A separate explicit owner action affirms the actual governing stop.
   * Only this target is legally resumed/settled; parking/cards stay intact. */
  confirmRecoveryOwnerStop(input: RecoveryOwnerActionInput, expectedResolutionFingerprint: string): { readonly event: EventRecord; readonly idempotent: boolean } {
    const fingerprint = createHash('sha256').update(canonicalRebriefEvidence({ version: 1, ...input, expectedResolutionFingerprint })).digest('hex');
    return this.transaction(() => {
      const priorRow = this.db.prepare(`SELECT * FROM events WHERE kind = 'silas.recovery-owner-stop-confirmed'
        AND json_extract(payload, '$.subject_kind') = ? AND json_extract(payload, '$.subject_id') = ? AND json_extract(payload, '$.resolution_id') = ?`)
        .get(input.kind, input.subjectId, input.resolutionId) as Row | undefined;
      if (priorRow !== undefined) {
        const prior = this.eventFromRow(priorRow);
        if ((prior.payload as { fingerprint?: unknown }).fingerprint !== fingerprint) throw new DirectiveCheckpointError('owner stop confirmation identity conflicts');
        return { event: prior, idempotent: true };
      }
      const { subject, transfer, target } = this.validateRecoveryOwnerAction(input);
      const ruling = this.recoveryOwnerResolution(input.kind, input.subjectId, input.resolutionId);
      const permission = ruling?.payload as { fingerprint?: unknown; subject?: RecoverySubject; transfer_event_seq?: unknown; work_revision?: unknown; contract_sha256?: unknown; head?: unknown } | undefined;
      if (ruling === null || permission?.fingerprint !== expectedResolutionFingerprint ||
          permission.subject?.snapshotSha256 !== subject.snapshotSha256 || permission.transfer_event_seq !== transfer.eventSeq ||
          permission.work_revision !== input.expectedWorkRevision || permission.contract_sha256 !== input.expectedContractSha256 ||
          permission.head !== input.expectedHead) throw new DirectiveCheckpointError('owner stop confirmation ruling/scope is missing, stale or conflicting');
      const event = this.appendCustomEvent({ kind: 'silas.recovery-owner-stop-confirmed', jobId: subject.jobId,
        payload: { version: 1, by: 'owner', subject_kind: input.kind, subject_id: input.subjectId, subject,
          resolution_id: input.resolutionId, ruling_event_seq: ruling.seq, ruling_fingerprint: expectedResolutionFingerprint,
          transfer_event_seq: transfer.eventSeq, target: transfer.ownerTransfer!.target, fingerprint, reason: input.reason } });
      if (target.state === 'suspended') this.resumeObligation(target.id, `explicit owner stop confirmation ${event.seq}`);
      this.settleObligation({ obligationId: target.id, settlement: { kind: 'executed-action',
        action: 'explicit owner confirmed governing recovery stop resolved', evidenceEventSeq: event.seq, evidenceEventKind: event.kind } });
      return { event, idempotent: false };
    });
  }

  recoveryOwnerBasis(kind: RecoverySubjectKind, subjectId: string): {
    readonly owned: boolean; readonly changed: boolean; readonly confirmed: boolean;
    readonly observedAtSeq: number; readonly resolutionEventSeq: number | null;
  } {
    const view = this.recoveryOwnerReadback(kind, subjectId);
    const transfer = view.transfer?.ownerTransfer;
    if (transfer == null) return { owned: false, changed: false, confirmed: false, observedAtSeq: 0, resolutionEventSeq: null };
    const subject = this.recoverySubject(kind, subjectId);
    const unchanged = subject.snapshotSha256 === transfer.subject.snapshotSha256 && view.target !== null &&
      view.target.generation === transfer.target.generation && view.target.planRevision === transfer.target.planRevision;
    const held = unchanged && view.target!.nextAction.kind === 'owner-decision' &&
      ['open', 'waiting', 'suspended'].includes(view.target!.state) && this.ownerLineagePermits(transfer, this.recoveryOwnerLineage(transfer).events);
    const confirmation = view.confirmation?.payload as { transfer_event_seq?: unknown; ruling_event_seq?: unknown; subject?: RecoverySubject; target?: RecoveryOwnerTransfer['target'] } | undefined;
    const permission = view.resolution?.payload as { transfer_event_seq?: unknown; subject?: RecoverySubject; target?: RecoveryOwnerTransfer['target']; work_revision?: unknown; contract_sha256?: unknown } | undefined;
    const current = this.directiveCurrentAuthority(subject.jobId);
    const confirmed = unchanged && view.target?.state === 'settled' && view.target.settlement?.kind === 'executed-action' &&
      view.target.settlement.evidenceEventSeq === view.confirmation?.seq &&
      confirmation?.transfer_event_seq === view.transfer!.eventSeq && confirmation.ruling_event_seq === view.resolution?.seq &&
      confirmation.subject?.snapshotSha256 === subject.snapshotSha256 && permission?.subject?.snapshotSha256 === subject.snapshotSha256 &&
      permission.transfer_event_seq === view.transfer!.eventSeq && permission.work_revision === current.workRevision &&
      permission.contract_sha256 === current.contractSha256 && this.ownerLineagePermits(transfer, this.recoveryOwnerLineage(transfer).events);
    const activity = this.db.prepare(`SELECT MAX(seq) AS seq FROM events WHERE job_id = ? AND (
      (${DIRECTIVE_CONTROL_SQL}) OR (kind IN ('job.obligation-state', 'job.obligation-settled', 'job.obligation-updated') AND json_extract(payload, '$.id') = ?)
      OR (kind IN ('silas.directive-sent', 'job.delivered', 'silas.rebrief') AND (json_extract(payload, '$.request_id') = ? OR json_extract(payload, '$.marker_id') = ?)))`)
      .get(subject.jobId, transfer.target.id, subjectId, subjectId) as Row;
    const awaitingExplicitUnpark = confirmed && this.getJob(subject.jobId)?.status === 'parked';
    return { owned: held || awaitingExplicitUnpark, changed: !held && !awaitingExplicitUnpark, confirmed, observedAtSeq: Math.max(Number(activity.seq ?? 0), view.transfer!.eventSeq),
      resolutionEventSeq: confirmed ? view.resolution!.seq : null };
  }

  private observeRecoveryDebt(kind: RecoverySubjectKind, subjectId: string, jobId: string, baselineSeq: number, context: BlockerContext): ObligationRecord {
    const basis = this.recoveryOwnerBasis(kind, subjectId);
    const debt = this.recordBlockedObservation(jobId, { ...context, observedAtSeq: basis.changed ? Math.max(baselineSeq, basis.observedAtSeq) : baselineSeq });
    const parked = this.preserveParkedRecoveryDebt(debt);
    if (basis.changed && !basis.confirmed && (parked.state === 'open' || parked.state === 'waiting')) {
      return this.suspendObligation(parked.id, 'recorded owner transfer changed without genuine governing owner resolution — no work authority');
    }
    return parked;
  }

  /** Exact live recovery identity, including owner-suspended debt. A bounded
   * UI history page is not an identity lookup or a generation fence. */
  recoveryObligation(jobId: string, kind: RecoverySubjectKind, subjectId: string): ObligationRecord | null {
    return this.activeIncarnation(jobId, 'operation', `${kind}-recovery:${subjectId}`);
  }

  openDirectiveRecoveryDebt(requestId: string, reason: string): ObligationRecord {
    const row = this.getDirective(requestId);
    if (row === null || isDirectiveTerminal(row.state)) throw new DirectiveCheckpointError('only live directive requests owe recovery judgment');
    return this.transaction(() => this.observeRecoveryDebt('directive', requestId, row.jobId, row.baselineSeq, {
      logicalStep: 'operation', incidentKey: `directive-recovery:${requestId}`,
      category: { kind: 'known', category: 'restart-recovery' }, observedAtSeq: row.baselineSeq,
      description: `Request ${requestId}; hash ${row.payloadHash}; revision ${String(row.workRevision)}; epoch ${String(row.authorityEpoch)}; ${reason}`,
      nextAction: { kind: 'gru-decision', decision: this.directiveCleanupBlockers(row.jobId).length > 0
        ? 'inspect the exact original producer start and native/controller evidence; obtain original producer cessation attestation before guarded retirement/successor; if inaccessible, ask the owner — the owner may abandon the unknown custody (the owner-only exit that holds the lane for a fresh owner-accepted request) or bin the job; never replay or infer cessation'
        : 'inspect exact native request evidence; choose a guarded fresh successor (rebrief-successor when the work needs a fresh session) or name the reserved owner decision; ' +
          'if it was already retired and a later request carrying its work was actually admitted, settle with reconcile-admitted naming that request' } }));
  }

  settleDirectiveRecoveryDebt(requestId: string, eventSeq: number, eventKind: string): void {
    const row = this.getDirective(requestId);
    if (row === null) throw new RecordNotFound(`directive request "${requestId}" not found`);
    const event = this.getEvent(eventSeq);
    const payload = event?.payload as { request_id?: unknown; decision?: { kind?: unknown; obligationId?: unknown } } | undefined;
    const successor = row.recoveryDecision?.successorId === null || row.recoveryDecision === null ? null : this.getDirective(row.recoveryDecision.successorId);
    const admission = eventKind === 'silas.directive-sent' && successor !== null && successor.nativeBinding !== null && successor.admissionSeq === eventSeq && payload?.request_id === successor.requestId;
    const delivery = eventKind === 'job.delivered' && (payload?.request_id === row.requestId && row.deliverySeq === eventSeq || successor !== null && payload?.request_id === successor.requestId && successor.deliverySeq === eventSeq);
    const owner = eventKind === 'silas.directive-recovery-decided' && row.recoveryDecision?.eventSeq === eventSeq && row.recoveryDecision.successorId === null && payload?.decision?.kind === 'owner-decision';
    if (event?.jobId !== row.jobId || event.kind !== eventKind || (!admission && !delivery && !owner)) throw new DirectiveCheckpointError('recovery debt requires actual correlated successor admission, completion or a consumed reserved-owner decision');
    const debt = this.recoveryObligation(row.jobId, 'directive', requestId);
    if (debt !== null && (debt.state === 'open' || debt.state === 'waiting')) {
      this.settleObligation({ obligationId: debt.id, settlement: { kind: 'executed-action', action: 'directive recovery handoff/completion or reserved owner decision', evidenceEventSeq: eventSeq, evidenceEventKind: eventKind } });
    }
    const card = this.findNotificationByKind(`silas.directive-unreconciled.${requestId}`, 'active');
    if (card?.routing === 'action-required') this.resolveNotificationById(card.id, 'directive-recovery-evidence');
  }

  openRebriefRecoveryDebt(markerId: string, reason: string): ObligationRecord {
    const marker = this.listPendingRebriefs().find((row) => row.id === markerId);
    if (marker === undefined) throw new RecordNotFound(`rebrief marker "${markerId}" not found`);
    return this.transaction(() => this.observeRecoveryDebt('rebrief', markerId, marker.jobId, marker.baselineSeq, {
      logicalStep: 'operation', incidentKey: `rebrief-recovery:${markerId}`,
      category: { kind: 'known', category: 'restart-recovery' }, observedAtSeq: marker.baselineSeq,
      description: `Rebrief ${markerId}; hash ${marker.payloadHash}; baseline ${marker.baselineSeq}; ${reason}`,
      nextAction: { kind: 'gru-decision', decision: 'guarded retirement of this exact legacy marker generation plus fresh named successor, or concrete reserved owner decision' } }));
  }

  /** Discovery after parking must not create an executable routine debt;
   * repeated observation also never resumes an already-suspended row. */
  private preserveParkedRecoveryDebt(debt: ObligationRecord): ObligationRecord {
    return this.getJob(debt.jobId)?.status === 'parked' && (debt.state === 'open' || debt.state === 'waiting')
      ? this.suspendObligation(debt.id, 'job parked — recovery judgment remains owner-suspended') : debt;
  }

  isRecoverySuccessor(requestId: string): boolean {
    return this.db.prepare("SELECT 1 FROM pending_directives WHERE json_extract(recovery_decision, '$.successorId') = ? UNION ALL SELECT 1 FROM rebrief_recovery_decisions WHERE successor_id = ? LIMIT 1").get(requestId, requestId) !== undefined;
  }

  getRebriefRecoveryDecision(markerId: string, generation?: number): { readonly fingerprint: string; readonly successorId: string | null; readonly eventSeq: number } | null {
    if (generation !== undefined) return this.recoveryDecisionHistory('rebrief', markerId).find((decision) => decision.generation === generation) ?? null;
    const row = this.db.prepare('SELECT * FROM rebrief_recovery_decisions WHERE marker_id = ?').get(markerId) as Row | undefined;
    return row === undefined ? null : { fingerprint: str(row.fingerprint), successorId: nstr(row.successor_id), eventSeq: Number(row.event_seq) };
  }

  rebriefProgressBlockers(markerId: string, laneId: string): readonly string[] {
    return this.rebriefOwnership(markerId, laneId).map(({ text }) => text);
  }

  /** `rebriefProgressBlockers`, each entry tagged as `directiveOwnership`
   * tags its own: an unbound or unproven historical session is `unknown`
   * custody, a session lock or any other producer is `live`. */
  private rebriefOwnership(markerId: string, laneId: string): readonly { readonly text: string; readonly custody: 'unknown' | 'live' }[] {
    const marker = this.listPendingRebriefs().find((row) => row.id === markerId);
    if (marker === undefined) throw new RecordNotFound(`rebrief marker "${markerId}" not found`);
    const blockers = this.directiveOwnership({ jobId: marker.jobId, requestId: markerId }, laneId)
      .filter(({ text }) => text !== 'unresolved re-brief request(s) own the lane');
    const unknown = (text: string) => blockers.push({ text, custody: 'unknown' });
    const peers = this.listPendingRebriefs({ jobId: marker.jobId }).filter((row) => row.payloadHash === marker.payloadHash && row.baselineSeq === marker.baselineSeq && row.phaseId === marker.phaseId);
    if (marker.agentId === null || marker.sessionFile === null || marker.workRevision === null || peers.some((row) => row.agentId !== marker.agentId || row.sessionFile !== marker.sessionFile)) {
      return [...blockers, { text: 'original historical native session ownership is unbound/UNKNOWN', custody: 'unknown' }];
    }
    try {
      const header = readDirectiveSessionHeader(marker.sessionFile);
      const owners = inspectDirectiveProducers(marker.sessionFile);
      const epoch = Number((this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS epoch FROM events WHERE job_id = ? AND seq <= ? AND (${DIRECTIVE_CONTROL_SQL})`).get(marker.jobId, marker.baselineSeq) as Row).epoch);
      const original = owners.filter(({ producer }) => peers.some((row) => row.id === producer.identity.requestId) && producer.identity.jobId === marker.jobId &&
        producer.identity.payloadHash === marker.payloadHash && producer.identity.workRevision === marker.workRevision && producer.identity.authorityEpoch === epoch &&
        producer.agentId === marker.agentId && producer.sessionFile === marker.sessionFile && producer.sessionId === header.id);
      for (const { producer } of original) {
        const association = readDirectiveBinding(marker.sessionFile, producer.identity.requestId);
        if (association === null || !isDeepStrictEqual(association.identity, producer.identity) || association.agentId !== marker.agentId || association.sessionId !== header.id || association.sessionFile !== marker.sessionFile) throw new DirectiveCheckpointError('original historical accepted identity/association is unavailable or changed');
        inspectDirectiveAdmission(marker.sessionFile, producer.identity);
        const checkpoint = inspectDirectiveCheckpoint(marker.sessionFile, producer.identity);
        if (checkpoint.state === 'unknown' || checkpoint.state === 'terminal' && !checkpoint.ok) unknown('original historical native effects/checkpoint remain UNKNOWN');
      }
      if (header.type !== 'session' || original.length === 0 || owners.some(({ evidence }) => evidence !== 'ceased')) unknown('original historical native physical cessation remains UNKNOWN');
      const last = owners.at(-1); if (last !== undefined) { const lock = directiveProducerLockBlocker(last.producer); if (lock !== null) blockers.push({ text: lock, custody: 'live' }); }
    } catch (error) { unknown(`original historical native ownership unreadable: ${String(error)}`); }
    return blockers;
  }

  /** Internal read-only control preflight for stopping an obsolete review.
   * This is never cessation, admission or execution authority. Exact consumed
   * generations skip clearance; the original transactional decision still
   * revalidates every producer/permission predicate after the awaited stop. */
  validateRecoverySuccessorBeforeWriterClearance(input: (
    ({ readonly subjectKind: 'directive' } & Parameters<LedgerApi['consumeDirectiveRecoveryDecision']>[0]) |
    ({ readonly subjectKind: 'rebrief' } & Parameters<LedgerApi['consumeRebriefRecoveryDecision']>[0])
  ) & { readonly decision: { readonly kind: 'successor'; readonly requestId: string; readonly directive: string } |
    { readonly kind: 'rebrief-successor'; readonly requestId: string; readonly note: string } }): string | null {
    if (input.subjectKind === 'directive') {
      const row = this.getDirective(input.requestId);
      if (row === null) throw new RecordNotFound(`directive request "${input.requestId}" not found`);
      if (this.recoveryDecisionHistory('directive', row.requestId).some((entry) => entry.generation === input.generation)) return null;
      const debt = this.recoveryObligation(row.jobId, 'directive', row.requestId);
      if (debt?.state === 'suspended' || debt?.generation !== input.generation || row.payloadHash !== input.expectedPayloadHash || this.directiveRecoveryEpoch(row.jobId) !== input.expectedEpoch ||
          input.expectedHead !== input.lane.resolvedHead || !input.reason.trim()) throw new DirectiveCheckpointError('recovery generation/hash/head/epoch decision is stale or incomplete');
      const job = this.getJob(row.jobId);
      if (job === null || isJobTerminal(job.status) || isDirectiveTerminal(row.state)) throw new DirectiveCheckpointError('terminal work cannot be revived by recovery');
      const owner = this.recoveryOwnerBasis('directive', row.requestId);
      if (owner.changed && !owner.confirmed) throw new DirectiveCheckpointError('governing owner stop has no genuine confirmed resolution — fresh work remains forbidden');
      this.assertRecoveryJobPermission(row.jobId);
      this.assertFreshRecoveryContract(row.jobId, input.expectedWorkRevision, input.expectedContractSha256);
      if (row.authorityEpoch !== null && row.authorityEpoch !== input.expectedEpoch) {
        const changes = this.db.prepare(`SELECT kind FROM events WHERE job_id = ? AND seq > ? AND seq <= ? AND (${DIRECTIVE_CONTROL_SQL})`).all(row.jobId, row.authorityEpoch, input.expectedEpoch) as Row[];
        if (!owner.confirmed && (changes.length === 0 || changes.some((event) => event.kind !== 'job.amendment-accepted'))) throw new DirectiveCheckpointError('non-amendment authority change cannot revive the old request');
      }
      const text = input.decision.kind === 'successor' ? input.decision.directive : input.decision.note;
      if (input.decision.requestId === row.requestId || !input.decision.requestId.trim() || !text.trim() || this.getDirective(input.decision.requestId) !== null) throw new DirectiveCheckpointError('successor must name a fresh unused request and nonempty directive or note');
      this.assertNoCompletedNativeRetirement(row);
      // Refuse before any writer clearance stops a review: a successor
      // retires the original, which unknown custody never allows.
      const custody = this.directiveCustodyGaps(row);
      if (custody.length > 0) throw new DirectiveRetirementError('live_work', `directive request "${row.requestId}" has unknown producer custody — no successor can retire it; the owner decides (abandonment)`, custody);
      return row.jobId;
    }
    if (this.getRebriefRecoveryDecision(input.markerId, input.generation) !== null) return null;
    if (!/^[a-f0-9]{64}$/.test(input.expectedReceiptEvidenceSha256)) throw new DirectiveCheckpointError('legacy recovery requires expected_receipt_evidence_sha256 from authenticated readback');
    const marker = this.listPendingRebriefs().find((entry) => entry.id === input.markerId);
    if (marker === undefined) throw new RecordNotFound(`rebrief marker "${input.markerId}" not found`);
    const group = this.listPendingRebriefs({ jobId: marker.jobId });
    if (group.length !== 2 || !group.some((entry) => entry.kind === 'silas.rebrief') || !group.some((entry) => entry.kind === 'job.delivered') ||
        !group.every((entry) => entry.payloadHash === marker.payloadHash && entry.baselineSeq === marker.baselineSeq && entry.phaseId === marker.phaseId)) throw new DirectiveCheckpointError('legacy rebrief marker generation is incoherent — explicit owner evidence repair required');
    if (this.rebriefReceiptEvidence(marker.id).sha256 !== input.expectedReceiptEvidenceSha256) throw new DirectiveCheckpointError('legacy receipt evidence changed — read the exact generation again before judging');
    const debt = this.recoveryObligation(marker.jobId, 'rebrief', marker.id);
    const job = this.getJob(marker.jobId);
    if (debt?.state === 'suspended' || debt?.generation !== input.generation || marker.payloadHash !== input.expectedPayloadHash || this.directiveRecoveryEpoch(marker.jobId) !== input.expectedEpoch ||
        input.expectedHead !== input.lane.resolvedHead || !input.reason.trim() || job === null || isJobTerminal(job.status)) throw new DirectiveCheckpointError('legacy rebrief decision is stale, terminal or incomplete');
    const owner = this.recoveryOwnerBasis('rebrief', marker.id);
    if (owner.changed && !owner.confirmed) throw new DirectiveCheckpointError('governing owner stop has no genuine confirmed resolution — fresh work remains forbidden');
    this.assertRecoveryJobPermission(marker.jobId);
    this.assertFreshRecoveryContract(marker.jobId, input.expectedWorkRevision, input.expectedContractSha256);
    if (!input.decision.requestId.trim() || !input.decision.directive.trim() || this.getDirective(input.decision.requestId) !== null) throw new DirectiveCheckpointError('legacy rebrief successor must name a fresh unused request and nonempty directive');
    const completed = group.find((entry) => entry.kind === 'silas.rebrief');
    if (completed !== undefined && this.pendingRebriefReceipt(completed) !== null) throw new DirectiveCheckpointError('legacy rebrief has guarded completion evidence — settlement owns it');
    return marker.jobId;
  }

  consumeRebriefRecoveryDecision(input: {
    readonly markerId: string; readonly generation: number; readonly expectedPayloadHash: string; readonly expectedHead: string;
    readonly expectedReceiptEvidenceSha256: string;
    readonly expectedEpoch: number; readonly expectedWorkRevision?: number; readonly expectedContractSha256?: string; readonly lane: { readonly id: string; readonly resolvedHead: string }; readonly reason: string;
    readonly decision: { readonly kind: 'successor'; readonly requestId: string; readonly directive: string } |
      { readonly kind: 'owner-decision'; readonly obligationId: string } |
      { readonly kind: 'reconcile-completed'; readonly inspectionRequestId: string };
  }): { readonly successor: DirectiveRequestRecord | null; readonly idempotent: boolean } {
    if (!/^[a-f0-9]{64}$/.test(input.expectedReceiptEvidenceSha256)) throw new DirectiveCheckpointError('legacy recovery requires expected_receipt_evidence_sha256 from authenticated readback');
    const fingerprint = createHash('sha256').update(canonicalRebriefEvidence([1, input.markerId, input.generation, input.expectedPayloadHash, input.expectedHead, input.expectedEpoch, input.expectedWorkRevision, input.expectedContractSha256, input.expectedReceiptEvidenceSha256, input.reason, input.decision])).digest('hex');
    return this.transaction(() => {
      const prior = this.getRebriefRecoveryDecision(input.markerId, input.generation);
      if (prior !== null) {
        if (prior.fingerprint !== fingerprint) throw new DirectiveCheckpointError('legacy rebrief recovery decision conflicts');
        return { successor: prior.successorId === null ? null : this.getDirective(prior.successorId), idempotent: true };
      }
      const marker = this.listPendingRebriefs().find((row) => row.id === input.markerId);
      if (marker === undefined) throw new RecordNotFound(`rebrief marker "${input.markerId}" not found`);
      const group = this.listPendingRebriefs({ jobId: marker.jobId });
      if (input.decision.kind !== 'owner-decision' && (group.length !== 2 || !group.some((row) => row.kind === 'silas.rebrief') || !group.some((row) => row.kind === 'job.delivered') ||
          !group.every((row) => row.payloadHash === marker.payloadHash && row.baselineSeq === marker.baselineSeq && row.phaseId === marker.phaseId))) throw new DirectiveCheckpointError('legacy rebrief marker generation is incoherent — explicit owner evidence repair required');
      const receiptEvidence = this.rebriefReceiptEvidence(input.markerId);
      if (receiptEvidence.sha256 !== input.expectedReceiptEvidenceSha256) throw new DirectiveCheckpointError('legacy receipt evidence changed — read the exact generation again before judging');
      const currentDebt = this.recoveryObligation(marker.jobId, 'rebrief', input.markerId);
      const debt = currentDebt !== null && (currentDebt.state === 'open' || currentDebt.state === 'waiting' || input.decision.kind !== 'successor' && currentDebt.state === 'suspended') ? currentDebt : null;
      const job = this.getJob(marker.jobId);
      if (!debt || debt.generation !== input.generation || marker.payloadHash !== input.expectedPayloadHash ||
          input.expectedEpoch !== this.directiveRecoveryEpoch(marker.jobId) || input.expectedHead !== input.lane.resolvedHead || !input.reason.trim() ||
          !job || isJobTerminal(job.status)) throw new DirectiveCheckpointError('legacy rebrief decision is stale, terminal or incomplete');
      let successor: DirectiveRequestRecord | null = null;
      let ownerTransfer: RecoveryOwnerTransfer | null = null;
      let currentInspectionDebt: ObligationRecord | null = null;
      const ownerBasis = this.recoveryOwnerBasis('rebrief', marker.id);
      if (input.decision.kind === 'successor') {
        if (ownerBasis.changed && !ownerBasis.confirmed) throw new DirectiveCheckpointError('governing owner stop has no genuine confirmed resolution — fresh work remains forbidden');
        this.assertRecoveryJobPermission(marker.jobId);
        this.assertFreshRecoveryContract(marker.jobId, input.expectedWorkRevision, input.expectedContractSha256);
        const blockers = this.rebriefProgressBlockers(marker.id, input.lane.id);
        if (blockers.length > 0) throw new DirectiveCheckpointError(`legacy rebrief producer cessation unproven: ${blockers.join('; ')}`);
        if (this.getDirective(input.decision.requestId) !== null) throw new DirectiveCheckpointError('legacy rebrief successor must name a fresh unused request');
        // Completion-first: exact rebrief completion can reconcile its lost
        // delivery. A lone delivery remains partial history, not proof that
        // the original turn completed or should be repeated.
        const completed = group.find((row) => row.kind === 'silas.rebrief');
        if (completed !== undefined && this.pendingRebriefReceipt(completed) !== null) throw new DirectiveCheckpointError('legacy rebrief has guarded completion evidence — settlement owns it');
        this.db.prepare('DELETE FROM pending_rebriefs WHERE job_id = ? AND payload_hash = ? AND baseline_seq = ?').run(marker.jobId, marker.payloadHash, marker.baselineSeq);
        if (marker.phaseId !== null) this.closePhaseHandoff({ phaseId: marker.phaseId, reason: `legacy rebrief retired without completion: ${input.reason}` });
        this.appendEvent({ kind: 'silas.rebrief-retired', jobId: marker.jobId, payload: { markers: group, reason: input.reason, by: 'gru-recovery', expected_head: input.expectedHead, lane_id: input.lane.id,
          receipt_evidence: receiptEvidence, receipt_evidence_sha256: receiptEvidence.sha256,
          guarded_event_landed: group.map((row) => ({ marker_id: row.id, kind: row.kind,
            landed: receiptEvidence.receipts.some((receipt) => receipt.kind === row.kind && receipt.classification === 'accepted') })) } });
        this.appendEvent({ kind: 'silas.rebrief-recovery-handoff', jobId: marker.jobId, payload: { marker_id: marker.id, request_id: input.decision.requestId } });
        successor = this.beginDirectiveIntent({ jobId: marker.jobId, requestId: input.decision.requestId, directive: input.decision.directive, holder: 'gru-recovery' }).record;
      } else if (input.decision.kind === 'reconcile-completed') {
        if (ownerBasis.changed && !ownerBasis.confirmed) throw new DirectiveCheckpointError('governing owner stop has no genuine confirmed resolution — current inspection remains forbidden');
        this.assertFreshRecoveryContract(marker.jobId, input.expectedWorkRevision, input.expectedContractSha256);
        const blockers = this.rebriefProgressBlockers(marker.id, input.lane.id);
        if (blockers.length > 0) throw new DirectiveCheckpointError(`completed control closure producer cessation unproven: ${blockers.join('; ')}`);
        const completion = group.find((row) => row.kind === 'silas.rebrief');
        const completedReceipt = completion === undefined ? null : this.pendingRebriefReceipt(completion);
        if (completedReceipt === null) throw new DirectiveCheckpointError('non-executing completed reconciliation requires exact original completion proof');
        if (this.originalRebriefDeliveryFacts(completion!.id) !== null || group.every((row) => this.pendingRebriefReceipt(row) !== null)) {
          throw new DirectiveCheckpointError('legacy rebrief has reconcilable original delivery facts — settlement owns it');
        }
        const reservedInspection = this.db.prepare(`SELECT 1 FROM events WHERE kind = 'silas.rebrief-control-closed'
          AND json_extract(payload, '$.inspection_request_id') = ?`).get(input.decision.inspectionRequestId);
        if (!input.decision.inspectionRequestId.trim() || this.getDirective(input.decision.inspectionRequestId) !== null || reservedInspection !== undefined) {
          throw new DirectiveCheckpointError('current artifact inspection requires a distinct unused request identity');
        }
        const instruction = `Inspect CURRENT source and artifacts for job ${marker.jobId} after administrative closure of completed historical rebrief ${marker.id}. ` +
          `Never replay the original prompt, repeat its effects or fabricate its missing delivery/HEAD/revision. Establish new current evidence and request the applicable verification/review gates under the current approved contract; this does not prove historical delivery or READY.`;
        const closure = this.appendEvent({ kind: 'silas.rebrief-control-closed', jobId: marker.jobId,
          payload: { version: 1, marker_id: marker.id, markers: group, completion_event_seq: completedReceipt.seq,
            receipt_evidence: receiptEvidence, receipt_evidence_sha256: receiptEvidence.sha256, by: 'gru', reason: input.reason,
            inspection_request_id: input.decision.inspectionRequestId, inspection_directive: instruction,
            current_authority: this.directiveCurrentAuthority(marker.jobId), expected_head: input.expectedHead, lane_id: input.lane.id,
            note: 'non-executing old control closure only; absent historical facts remain absent' } });
        currentInspectionDebt = this.recordBlockedObservation(marker.jobId, { logicalStep: 'verification',
          incidentKey: `rebrief-current-inspection:${marker.id}`, category: { kind: 'known', category: 'restart-recovery' },
          observedAtSeq: closure.seq, nextAction: { kind: 'gru-decision', decision:
            `After current permission and every producer fence pass, use POST /api/silas/directive with job_id ${marker.jobId}, request_id ${input.decision.inspectionRequestId}, and exact directive: ${instruction} Then use existing verification/review APIs. These produce CURRENT evidence only.` } });
        try { this.assertRecoveryJobPermission(marker.jobId); } catch (error) {
          if (!(error instanceof DirectiveCheckpointError)) throw error;
          currentInspectionDebt = this.suspendObligation(currentInspectionDebt.id, `current inspection remains stopped: ${error.message}`);
        }
        this.db.prepare('DELETE FROM pending_rebriefs WHERE job_id = ? AND payload_hash = ? AND baseline_seq = ?').run(marker.jobId, marker.payloadHash, marker.baselineSeq);
        if (marker.phaseId !== null) this.closePhaseHandoff({ phaseId: marker.phaseId, reason: 'administrative completed control closure; no historical delivery facts fabricated' });
      } else {
        ownerTransfer = this.makeOwnerRecoveryTransfer(this.recoverySubject('rebrief', marker.id), debt, input.decision.obligationId);
      }
      const event = this.appendEvent({ kind: 'silas.rebrief-recovery-decided', jobId: marker.jobId,
        payload: { marker_id: marker.id, markers: group, generation: input.generation, expected_head: input.expectedHead, epoch: input.expectedEpoch, expected_work_revision: input.expectedWorkRevision, expected_contract_sha256: input.expectedContractSha256,
          fingerprint, receipt_evidence: receiptEvidence, expected_receipt_evidence_sha256: input.expectedReceiptEvidenceSha256,
          owner_transfer: ownerTransfer, owner_resolution_event_seq: ownerBasis.resolutionEventSeq,
          current_inspection_obligation_id: currentInspectionDebt?.id ?? null, decision: input.decision, reason: input.reason } });
      this.db.prepare(`INSERT INTO rebrief_recovery_decisions (marker_id, job_id, fingerprint, successor_id, event_seq) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (marker_id) DO UPDATE SET fingerprint = excluded.fingerprint, successor_id = excluded.successor_id, event_seq = excluded.event_seq`)
        .run(marker.id, marker.jobId, fingerprint, successor?.requestId ?? null, event.seq);
      if (currentInspectionDebt !== null) this.settleObligation({ obligationId: debt.id,
        settlement: { kind: 'superseded', byObligationId: currentInspectionDebt.id, reason: `exact completed control closed by event ${event.seq}; current inspection ${currentInspectionDebt.id} remains owed` } });
      if (ownerTransfer !== null || currentInspectionDebt !== null) {
        if (ownerTransfer !== null) this.closeOwnerTransferredRecoveryDebt(debt, ownerTransfer, event);
        const card = this.findNotificationByKind(`silas.rebrief-unreconciled.${marker.jobId}`, 'active');
        if (card?.routing === 'action-required') this.resolveNotificationById(card.id, 'rebrief-recovery-evidence');
      }
      return { successor, idempotent: false };
    });
  }

  /** Synchronous route evidence and the decision/retirement/fresh acceptance
   * share one transaction. Refusal rolls back every row, hold and audit. */
  consumeDirectiveRecoveryDecision(input: {
    readonly requestId: string; readonly generation: number; readonly expectedPayloadHash: string;
    readonly expectedHead: string; readonly expectedEpoch: number; readonly expectedWorkRevision?: number; readonly expectedContractSha256?: string; readonly lane: { readonly id: string; readonly resolvedHead: string };
    readonly reason: string;
    readonly decision: { readonly kind: 'successor'; readonly requestId: string; readonly directive: string } |
      // A fresh-session successor (#470): accepted as a rebrief, the only
      // request kind dispatched with `freshSession`.
      { readonly kind: 'rebrief-successor'; readonly requestId: string; readonly note: string } |
      { readonly kind: 'owner-decision'; readonly obligationId: string } |
      // Non-executing (#470): an already-retired request's debt settles on a
      // later request's actual native admission on the same lane.
      { readonly kind: 'reconcile-admitted'; readonly admittedRequestId: string };
  }): { readonly successor: DirectiveRequestRecord | null; readonly idempotent: boolean } {
    const facts = [input.requestId, input.generation, input.expectedPayloadHash, input.expectedHead, input.expectedEpoch, input.expectedWorkRevision, input.expectedContractSha256, input.reason, input.decision];
    // Canonical, like the rebrief decision's (#363 S02-0-02): the same
    // decision with its properties in another order is the same decision.
    const fingerprint = createHash('sha256').update(canonicalRebriefEvidence(facts)).digest('hex');
    // A decision consumed before that recorded the insertion-order spelling;
    // its exact replay still matches.
    const legacyFingerprint = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
    return this.transaction(() => {
      const row = this.getDirective(input.requestId);
      if (row === null) throw new RecordNotFound(`directive request "${input.requestId}" not found`);
      const prior = this.recoveryDecisionHistory('directive', row.requestId).find((decision) => decision.generation === input.generation);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint && prior.fingerprint !== legacyFingerprint) throw new DirectiveCheckpointError('recovery decision conflicts with the consumed decision');
        return { successor: prior.successorId === null ? null : this.getDirective(prior.successorId), idempotent: true };
      }
      const currentDebt = this.recoveryObligation(row.jobId, 'directive', row.requestId);
      const debt = currentDebt !== null && (currentDebt.state === 'open' || currentDebt.state === 'waiting' || input.decision.kind === 'owner-decision' && currentDebt.state === 'suspended') ? currentDebt : null;
      if (!debt || debt.generation !== input.generation || row.payloadHash !== input.expectedPayloadHash ||
          this.directiveRecoveryEpoch(row.jobId) !== input.expectedEpoch || input.expectedHead !== input.lane.resolvedHead || !input.reason.trim()) throw new DirectiveCheckpointError('recovery generation/hash/head/epoch decision is stale or incomplete');
      const job = this.getJob(row.jobId);
      if (!job || isJobTerminal(job.status)) throw new DirectiveCheckpointError('terminal work cannot be revived by recovery');
      if (input.decision.kind === 'reconcile-admitted' ? row.state !== 'retired' : isDirectiveTerminal(row.state)) {
        throw new DirectiveCheckpointError(input.decision.kind === 'reconcile-admitted'
          ? `request is ${directiveStateName(row)}, not retired — a live request takes a successor decision; only a retired request's debt reconciles to a later admission`
          : 'terminal work cannot be revived by recovery');
      }
      let successor: DirectiveRequestRecord | null = null;
      let ownerTransfer: RecoveryOwnerTransfer | null = null;
      let admission: { readonly requestId: string; readonly admissionSeq: number; readonly admissionMinion: string | null; readonly workRevision: number;
        readonly retiredWorkRevision: number; readonly retirementSeq: number; readonly laneId: string } | null = null;
      const ownerBasis = this.recoveryOwnerBasis('directive', row.requestId);
      if (input.decision.kind === 'successor' || input.decision.kind === 'rebrief-successor') {
        if (ownerBasis.changed && !ownerBasis.confirmed) throw new DirectiveCheckpointError('governing owner stop has no genuine confirmed resolution — fresh work remains forbidden');
        this.assertRecoveryJobPermission(row.jobId);
        this.assertFreshRecoveryContract(row.jobId, input.expectedWorkRevision, input.expectedContractSha256);
        if (row.authorityEpoch !== null && row.authorityEpoch !== input.expectedEpoch) {
          const changes = this.db.prepare(`SELECT kind FROM events WHERE job_id = ? AND seq > ? AND seq <= ? AND (${DIRECTIVE_CONTROL_SQL})`).all(row.jobId, row.authorityEpoch, input.expectedEpoch) as Row[];
          if (!ownerBasis.confirmed && (changes.length === 0 || changes.some((event) => event.kind !== 'job.amendment-accepted'))) throw new DirectiveCheckpointError('non-amendment authority change cannot revive the old request');
        }
        if (input.decision.requestId === row.requestId || this.getDirective(input.decision.requestId) !== null) throw new DirectiveCheckpointError('successor must name a fresh unused request id');
        this.retireInterruptedDirective({ requestId: row.requestId, expectedJobId: row.jobId, expectedState: row.state as LiveDirectiveState,
          expectedPayloadHash: input.expectedPayloadHash, expectedHead: input.expectedHead, expectedGeneration: input.generation,
          // This transaction just fenced the decision on the same incarnation.
          expectedPlanRevision: debt.planRevision, expectedObligationState: debt.state,
          expectedAuthorityEpoch: input.expectedEpoch, expectedWorkRevision: input.expectedWorkRevision,
          expectedContractSha256: input.expectedContractSha256, lane: input.lane, reason: input.reason, by: 'gru-recovery' });
        successor = (input.decision.kind === 'successor'
          ? this.beginDirectiveIntent({ jobId: row.jobId, requestId: input.decision.requestId, directive: input.decision.directive, holder: 'gru-recovery' })
          : this.beginRebriefIntent({ jobId: row.jobId, requestId: input.decision.requestId, note: input.decision.note, holder: 'gru-recovery' })).record;
      } else if (input.decision.kind === 'reconcile-admitted') {
        if (debt.claim !== null) throw new DirectiveCheckpointError(`recovery debt is claimed by request ${debt.claim.requestId} — release it before reconciling`);
        admission = this.laterSameLaneAdmission(row, input.decision.admittedRequestId, input.lane.id);
      } else {
        ownerTransfer = this.makeOwnerRecoveryTransfer(this.recoverySubject('directive', row.requestId), debt, input.decision.obligationId);
      }
      const event = this.appendEvent({ kind: 'silas.directive-recovery-decided', jobId: row.jobId,
        payload: { request_id: row.requestId, generation: input.generation, payload_hash: row.payloadHash, expected_head: input.expectedHead,
          authority_epoch: input.expectedEpoch, expected_work_revision: input.expectedWorkRevision, expected_contract_sha256: input.expectedContractSha256,
          fingerprint, owner_transfer: ownerTransfer, owner_resolution_event_seq: ownerBasis.resolutionEventSeq, decision: input.decision, reason: input.reason,
          ...(admission === null ? {} : { admission: { request_id: admission.requestId, admission_seq: admission.admissionSeq, admission_minion: admission.admissionMinion,
            work_revision: admission.workRevision, retired_work_revision: admission.retiredWorkRevision, retirement_seq: admission.retirementSeq, lane_id: admission.laneId } }) } });
      this.db.prepare('UPDATE pending_directives SET recovery_decision = ? WHERE request_id = ?').run(JSON.stringify({ fingerprint, successorId: successor?.requestId ?? null, eventSeq: event.seq }), row.requestId);
      if (ownerTransfer !== null) {
        this.closeOwnerTransferredRecoveryDebt(debt, ownerTransfer, event);
        const card = this.findNotificationByKind(`silas.directive-unreconciled.${row.requestId}`, 'active');
        if (card?.routing === 'action-required') this.resolveNotificationById(card.id, 'directive-recovery-owner-transfer');
      }
      if (admission !== null) {
        this.settleObligation({ obligationId: debt.id, settlement: { kind: 'executed-action',
          action: `retired request's recovery reconciled to the later actual native admission of ${admission.requestId} (decision event ${event.seq})`,
          evidenceEventSeq: admission.admissionSeq, evidenceEventKind: 'silas.directive-sent' } });
        const card = this.findNotificationByKind(`silas.directive-unreconciled.${row.requestId}`, 'active');
        if (card?.routing === 'action-required') this.resolveNotificationById(card.id, 'directive-recovery-evidence');
      }
      return { successor, idempotent: false };
    });
  }

  /** The evidence an orphaned retired request's debt settles on (#470): a
   * different request of the same job whose ACTUAL native admission (its
   * correlated `silas.directive-sent`) postdates the retirement, at the same
   * or a higher work revision, while the lane the retirement bound is still
   * the job's one live lane. Admission requires that single live lane, so an
   * admission after the retirement ran on it. Acceptance alone, an earlier
   * admission or a lower revision never qualifies. */
  private laterSameLaneAdmission(row: DirectiveRequestRecord, admittedRequestId: string, laneId: string) {
    const retired = this.latestJobEventByRequestId(row.jobId, 'silas.directive-retired', row.requestId);
    if (retired === null) throw new DirectiveCheckpointError(`retired request ${row.requestId} has no silas.directive-retired receipt — retirement evidence is missing`);
    const retiredLane = (retired.payload as { lane_id?: unknown }).lane_id;
    if (retiredLane !== laneId) throw new DirectiveCheckpointError(`the retirement bound lane ${String(retiredLane)}, not the job's live lane ${laneId} — a later admission is not on the same lane`);
    const admitted = this.getDirective(admittedRequestId);
    if (admitted === null || admitted.requestId === row.requestId) {
      throw new DirectiveCheckpointError(`reconcile-admitted must name another request of job ${row.jobId}; "${admittedRequestId}" is not one`);
    }
    if (admitted.jobId !== row.jobId) throw new DirectiveCheckpointError(`request ${admitted.requestId} belongs to job ${admitted.jobId}, not ${row.jobId}`);
    const sent = admitted.admissionSeq === null ? null : this.getEvent(admitted.admissionSeq);
    if (admitted.nativeBinding === null || sent === null || sent.kind !== 'silas.directive-sent' || sent.jobId !== row.jobId ||
        (sent.payload as { request_id?: unknown }).request_id !== admitted.requestId ||
        !isDeepStrictEqual((sent.payload as { native_binding?: unknown }).native_binding, admitted.nativeBinding)) {
      throw new DirectiveCheckpointError(`request ${admitted.requestId} has no actual native admission (state ${admitted.state}) — acceptance alone never settles recovery debt`);
    }
    if (sent.seq <= retired.seq) throw new DirectiveCheckpointError(`request ${admitted.requestId} was admitted at seq ${sent.seq}, before the retirement at seq ${retired.seq} — only a later admission can carry the retired work`);
    if (row.workRevision === null || admitted.workRevision === null || admitted.workRevision < row.workRevision) {
      throw new DirectiveCheckpointError(`request ${admitted.requestId} carries work revision ${String(admitted.workRevision)}, lower than (or unknown against) the retired request's ${String(row.workRevision)} — it does not cover the retired work`);
    }
    return { requestId: admitted.requestId, admissionSeq: sent.seq, admissionMinion: admitted.admissionMinion, workRevision: admitted.workRevision,
      retiredWorkRevision: row.workRevision, retirementSeq: retired.seq, laneId };
  }

  /** A named recovery successor that ends (failed or retired) without actual
   * native admission can never settle its predecessor's debt, and that
   * debt's generation is already consumed by the decision (#470). Supersede
   * the debt into a fresh generation (still suspended if it was), so Gru can
   * settle it with `reconcile-admitted` once a later request carrying the
   * work is admitted instead of leaving it stranded. Runs inside the
   * successor's terminal transition and from the boot repair below; the
   * consumed-generation match makes it fire once. Returns debts reopened. */
  private reopenStrandedRecoveryDebt(successor: DirectiveRequestRecord): number {
    if (successor.admissionSeq !== null || (successor.state !== 'failed' && successor.state !== 'retired')) return 0;
    const predecessors = this.db.prepare("SELECT request_id FROM pending_directives WHERE job_id = ? AND json_extract(recovery_decision, '$.successorId') = ?")
      .all(successor.jobId, successor.requestId) as Row[];
    let reopened = 0;
    for (const predecessor of predecessors) {
      const requestId = str(predecessor.request_id);
      const debt = this.recoveryObligation(successor.jobId, 'directive', requestId);
      if (debt === null || !['open', 'waiting', 'suspended'].includes(debt.state) ||
          !this.recoveryDecisionHistory('directive', requestId).some((decision) => decision.generation === debt.generation && decision.successorId === successor.requestId)) continue;
      // An owner-abandoned successor's outcome is unknown: it may have carried
      // the work. Nothing reads it as unadmitted or plans a fresh request;
      // whether the work still needs doing is the owner's decision.
      const abandoned = successor.abandonedAt !== null;
      const cause = abandoned
        ? `named successor ${successor.requestId} was abandoned by the owner with its outcome unknown`
        : `named successor ${successor.requestId} ended ${successor.state} without native admission`;
      // The newest seq on the job: the new incarnation can never read as a stale replay.
      const audit = this.appendEvent({ kind: 'silas.directive-recovery-reopened', jobId: debt.jobId,
        payload: { request_id: requestId, successor_request_id: successor.requestId, successor_state: directiveStateName(successor),
          superseded_obligation_id: debt.id, consumed_generation: debt.generation } });
      this.settleObligation({ obligationId: debt.id, settlement: { kind: 'superseded',
        byObligationId: this.nextIncarnationId(obligationId(debt.jobId, 'operation', debt.incidentKey)), reason: cause } });
      const next = this.observeRecoveryDebt('directive', requestId, debt.jobId, audit.seq, { logicalStep: 'operation', incidentKey: debt.incidentKey,
        category: debt.category, observedAtSeq: audit.seq, ...(debt.description === null ? {} : { description: debt.description }),
        nextAction: abandoned
          ? { kind: 'owner-decision', decision: `${cause}. Whether this retired request's approved work still needs doing is the owner's decision: ` +
              'nothing records that the successor ran, or that it did not.' }
          : { kind: 'gru-decision', decision: `${cause}, so it cannot settle this retired request's debt, and the retired request takes no new successor. ` +
          'First inspect the job\'s later requests: if one carrying the approved work is live or already admitted, use it; only otherwise begin a fresh ' +
          'request (POST /api/silas/directive or /api/silas/rebrief). Once that request is actually admitted on this lane, settle this debt at its new ' +
          `generation with POST /api/silas/directives/${requestId}/recover decision reconcile-admitted naming it` } });
      const reopenedDebt = debt.state === 'suspended' && next.state !== 'suspended' ? this.suspendObligation(next.id, `suspension carried over from superseded ${debt.id}`) : next;
      // The old card names the consumed generation and advises a successor
      // the retired request can no longer take. An open reopened debt reaches
      // Gru through the obligation mailbox; a suspended one does not, so its
      // card stays as the only pointer to the debt (read its generation back).
      const card = this.findNotificationByKind(`silas.directive-unreconciled.${requestId}`, 'active');
      if (reopenedDebt.state !== 'suspended' && card?.routing === 'action-required') this.resolveNotificationById(card.id, 'directive-recovery-reopened');
      reopened += 1;
    }
    return reopened;
  }

  /** Boot repair (#470): reopen debts stranded by named successors that ended
   * unadmitted before the terminal-transition hook existed. Idempotent. Each
   * successor repairs in its own transaction; one that refuses is reported
   * by name and never blocks the others or the service start. */
  reopenStrandedRecoveryDebts(): { readonly reopened: number; readonly failures: readonly {
    readonly jobId: string; readonly predecessorId: string; readonly successorId: string; readonly error: string }[] } {
    const rows = this.db.prepare(`SELECT DISTINCT p.job_id, p.request_id AS predecessor_id, s.request_id AS successor_id FROM pending_directives p
      JOIN pending_directives s ON s.request_id = json_extract(p.recovery_decision, '$.successorId')
      WHERE s.admission_seq IS NULL AND s.state IN ('failed', 'retired') ORDER BY p.rowid`).all() as Row[];
    let reopened = 0;
    const failures: { readonly jobId: string; readonly predecessorId: string; readonly successorId: string; readonly error: string }[] = [];
    for (const row of rows) {
      const successorId = str(row.successor_id);
      try { reopened += this.transaction(() => this.reopenStrandedRecoveryDebt(this.getDirective(successorId) as DirectiveRequestRecord)); }
      catch (error) { failures.push({ jobId: str(row.job_id), predecessorId: str(row.predecessor_id), successorId, error: String(error) }); }
    }
    return { reopened, failures };
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
      if (row.state === 'admitted' && row.admissionSeq === input.eventSeq && row.admissionMinion === input.minionId) {
        if (row.requestKind !== null && row.nativeBinding === null) throw new DirectiveCheckpointError('current directive requires exact adapter-owned native admission');
        return row; // exact replay
      }
      if (row.state !== 'dispatching') {
        throw new Error(`directive request "${input.requestId}" is ${directiveStateName(row)} — admission evidence cannot bind here`);
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
      if (row.requestKind !== null && (row.nativeBinding === null || !isDeepStrictEqual(payload['native_binding'], row.nativeBinding) ||
          row.nativeBinding.agentId !== input.minionId)) throw new DirectiveCheckpointError('current directive requires exact adapter-owned native admission');
      if (payload['minion_id'] !== input.minionId) throw new Error('directive admission minion identity mismatch');
      if (payload['request_id'] !== input.requestId) {
        throw new Error(`admission for "${input.requestId}" cites an event whose payload is not correlated to this request`);
      }
      this.db
        .prepare("UPDATE pending_directives SET state = 'admitted', admission_seq = ?, admission_minion = ?, updated_at = ? WHERE request_id = ?")
        .run(input.eventSeq, input.minionId, nowIso(), input.requestId);
      return this.getDirective(input.requestId) as DirectiveRequestRecord;
    });
  }

  recordHistoricalNativeDirectiveCompletion(identity: DirectiveTurnIdentity, laneId: string): DirectiveRequestRecord {
    return this.transaction(() => {
      const row = this.getDirective(identity.requestId);
      if (row === null || !isDeepStrictEqual(this.directiveTurnIdentity(row.requestId), identity) || row.nativeTarget === null || row.nativeBinding === null || row.state !== 'admitted') throw new DirectiveCheckpointError('historical completion requires exact original admitted native request');
      const job = this.getJob(row.jobId);
      const authority = this.directiveCurrentAuthority(row.jobId);
      if (job === null || job.status !== 'parked' && authority.workRevision === identity.workRevision && authority.contractSha256 === identity.contractSha256 && authority.authorityEpoch === identity.authorityEpoch) throw new DirectiveCheckpointError('historical-only completion requires positively changed or parked current authority');
      if (this.recoveryOwnerBasis('directive', row.requestId).owned || this.recoveryDecisionHistory('directive', row.requestId).some((history) => history.ownerTransfer !== null)) throw new DirectiveCheckpointError('historical completion cannot release original transferred owner context');
      if (this.hasOpenDirectiveRecoveryHold(row.jobId) || this.listObligations({ jobId: row.jobId }).some((debt) => ['open', 'waiting', 'suspended'].includes(debt.state) && debt.nextAction.kind === 'owner-decision') ||
          this.db.prepare("SELECT 1 FROM notifications n JOIN agents a ON a.id = n.agent_id WHERE a.job_id = ? AND n.routing = 'needs-owner' AND n.acked_at IS NULL AND n.resolved_at IS NULL").get(row.jobId) !== undefined) throw new DirectiveCheckpointError('historical completion retains original owner stop');
      const held = this.listObligations({ jobId: row.jobId }).some((debt) => debt.incidentKey === `directive-recovery:${row.requestId}` && (debt.state === 'suspended' || debt.claim !== null));
      if (held) throw new DirectiveCheckpointError('historical completion retains suspended or claimed original recovery context');
      const ownReservations = new Set([`directive ${row.requestId}`, `directive recovery ${row.requestId}`, `rebrief ${row.requestId}`]);
      const reservations = this.listJobAdmissions(row.jobId).filter((kind) => !ownReservations.has(kind));
      const blockers = this.directiveRetirementBlockers(row, laneId).filter((blocker) => !blocker.startsWith('in-flight admission(s):'));
      if (blockers.length + reservations.length > 0) throw new DirectiveCheckpointError(`historical completion producer fences: ${[...blockers, ...reservations].join('; ')}`);
      const proof = inspectDirectiveCheckpoint(row.nativeTarget.sessionFile, identity);
      if (proof.state !== 'terminal' || !proof.ok || !isDeepStrictEqual(proof.binding, row.nativeBinding)) throw new DirectiveCheckpointError('historical completion requires exact original successful native ancestry');
      const completion = readDirectiveCompletion(row.nativeTarget.sessionFile, identity, proof.checkpointId);
      const physical = inspectDirectiveProducers(row.nativeTarget.sessionFile);
      const owners = physical.filter(({ producer }) => isDeepStrictEqual(producer.identity, identity));
      if (owners.length === 0 || owners.some(({ producer }) => producer.agentId !== proof.binding.agentId || producer.sessionId !== proof.binding.sessionId) ||
          completion !== null && !owners.some(({ producer }) => isDeepStrictEqual(producer, completion.producer)) ||
          physical.some(({ evidence }) => evidence === 'unknown') || directiveSessionLockBlocker(row.nativeTarget.sessionFile) !== null) throw new DirectiveCheckpointError('historical completion original physical receipt is unbound or UNKNOWN');
      for (const { producer } of physical) {
        const association = readDirectiveBinding(row.nativeTarget.sessionFile, producer.identity.requestId);
        const checkpoint = inspectDirectiveCheckpoint(row.nativeTarget.sessionFile, producer.identity);
        if (association === null || !isDeepStrictEqual(association.identity, producer.identity) || association.agentId !== producer.agentId || association.sessionId !== producer.sessionId || association.sessionFile !== producer.sessionFile || producer.agentId !== proof.binding.agentId || producer.sessionId !== proof.binding.sessionId || checkpoint.state !== 'terminal' || !checkpoint.ok) throw new DirectiveCheckpointError('historical completion older or foreign native incarnation remains unbound/UNKNOWN');
      }
      const phase = this.findPhaseHandoffByRequest({ jobId: row.jobId, requestId: row.requestId });
      if (row.requestKind === 'rebrief' && this.latestJobEventByRequestId(row.jobId, 'silas.rebrief', row.requestId) === null) this.appendEvent({ kind: 'silas.rebrief', jobId: row.jobId, payload: {
        request_id: row.requestId, minion_id: proof.binding.agentId, note: (JSON.parse(row.payload) as { directive: string }).directive,
        ...(phase === null ? {} : { phase_id: phase.phaseId }), ...(row.sourceContext?.ruleId === undefined ? {} : { rule_id: row.sourceContext.ruleId }),
        ...(row.sourceContext?.sourceRoundId === undefined ? {} : { source_round_id: row.sourceContext.sourceRoundId }),
        ...(row.sourceContext?.source === undefined ? {} : { source: row.sourceContext.source }),
      } });
      const delivery = this.appendEvent({ kind: 'job.delivered', jobId: row.jobId, agentId: proof.binding.agentId,
        payload: { request_id: row.requestId, agentId: proof.binding.agentId, source: row.requestKind === 'rebrief' ? 'silas-rebrief' : 'silas-directive', sha: completion?.head ?? null,
          work_revision: identity.workRevision, candidate_delivery_proven: false, historical_bookkeeping_only: true, ...(phase === null ? {} : { phase_id: phase.phaseId }),
          native_completion: { identity, checkpoint_id: proof.checkpointId, binding: proof.binding, receipt: completion, physical_cessation: physical } } });
      // The shared settlement boundary retains exactly one protected duty,
      // including historical-only completions. Do not rotate its generation
      // by observing the same delivery twice with different reason text.
      return this.recordDirectiveDelivery({ requestId: row.requestId, eventSeq: delivery.seq });
    });
  }

  private retainOriginalNativeGateDebt(row: DirectiveRequestRecord, delivery: EventRecord | BusEvent, reason: string): void {
    const identity = this.directiveTurnIdentity(row.requestId);
    const authority = this.directiveCurrentAuthority(row.jobId);
    const sha = (delivery.payload as { sha: string | null }).sha;
    const duty = this.preserveParkedRecoveryDebt(this.recordBlockedObservation(row.jobId, { logicalStep: 'verification', incidentKey: `directive-current-gates:${row.requestId}`,
      observedAtSeq: delivery.seq, category: { kind: 'known', category: 'restart-recovery' }, nextAction: { kind: 'gru-decision', decision: `Original native request ${row.requestId} completed accepted identity ${JSON.stringify(identity)} at recorded HEAD ${sha ?? 'UNPROVEN/null'}, original delivery ${delivery.seq}. Current candidacy is unproven: ${reason}. Current approved inputs ${JSON.stringify(authority)} still require a genuine current candidate and existing POST /api/verify declared full gate plus POST /api/dispatch/review actual complete whole-change review. Historical completion is neither current delivery authority nor PASS/READY.` } }));
    this.appendEvent({ kind: 'silas.directive-current-gates-owed', jobId: row.jobId, payload: { root_kind: 'original-native-completion', request_id: row.requestId,
      identity, delivery_seq: delivery.seq, sha, native_completion: delivery.payload, obligation_id: duty.id, generation: duty.generation, next_action: duty.nextAction } });
  }

  /** Original completion is already proven separately. Current eligibility
   * is established here, never by the publisher's positive flag. */
  private nativeCandidateRefusal(row: DirectiveRequestRecord, payload: Record<string, unknown>): string | null {
    try {
      this.assertDirectiveAuthority(this.directiveTurnIdentity(row.requestId));
      if (payload['historical_bookkeeping_only'] === true) return 'publisher retained historical-only bookkeeping';
      const binding = row.nativeBinding!;
      const header = readDirectiveSessionHeader(binding.sessionFile);
      const lanes = this.listWorktrees({ jobId: row.jobId }).filter((lane) => lane.kind === 'job' && lane.status !== 'swept');
      if (lanes.length !== 1 || header.type !== 'session' || header.id !== binding.sessionId || header.cwd !== lanes[0]!.path) return 'original native session/cwd does not bind the unique current original lane';
      const lane = lanes[0]!;
      const own = new Set([`directive ${row.requestId}`, `directive recovery ${row.requestId}`, `rebrief ${row.requestId}`]);
      const blockers = this.directiveRetirementBlockers(row, lane.id).filter((blocker) => !blocker.startsWith('in-flight admission(s):'));
      const reservations = this.listJobAdmissions(row.jobId).filter((kind) => !own.has(kind));
      if (blockers.length + reservations.length > 0) return `current producer fences: ${[...blockers, ...reservations].join('; ')}`;
      const git = readGitState(lane.path, { includeUntracked: true });
      if (git.sha === null || git.sha !== payload['sha'] || git.trackedDirty) return 'current original lane HEAD is different, dirty or unproven';
      const branch = execFileSync('git', ['-C', lane.path, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
      if (lane.branch === null || branch !== lane.branch) return 'current branch differs from the original registered lane';
      return null;
    } catch (error) { return `current original-lane/authority inspection refused: ${String(error)}`; }
  }

  /** Custom event writers cannot forge a positive settlement decision or
   * retrospectively upgrade a completed original request. This guard also
   * protects the internal append path, not just one public facade. */
  private assertNativeSettlementCandidate(jobId: string | null, facts: Record<string, unknown>): void {
    const row = typeof facts['request_id'] === 'string' ? this.getDirective(facts['request_id']) : null;
    const delivery = Number.isSafeInteger(facts['delivery_seq']) ? this.getEvent(Number(facts['delivery_seq'])) : null;
    if (row === null || row.state !== 'admitted' || row.requestKind === null || row.jobId !== jobId ||
        delivery?.kind !== 'job.delivered' || delivery.jobId !== jobId || typeof facts['candidate_delivery_proven'] !== 'boolean') {
      throw new DirectiveCheckpointError('native settlement candidacy requires its exact original admitted delivery; completed history cannot be upgraded');
    }
    const payload = delivery.payload as Record<string, unknown>;
    if (payload['request_id'] !== row.requestId || payload['work_revision'] !== row.workRevision || payload['agentId'] !== row.nativeBinding?.agentId ||
        row.admissionSeq === null || delivery.seq <= row.admissionSeq) throw new DirectiveCheckpointError('native settlement candidate receipt has foreign original bindings');
    this.assertNativeDirectiveDelivery(row, payload);
    if (facts['candidate_delivery_proven'] && (payload['candidate_delivery_proven'] !== true || this.nativeCandidateRefusal(row, payload) !== null)) {
      throw new DirectiveCheckpointError('native settlement candidacy lacks independently proven current original-lane/HEAD/authority');
    }
  }

  private assertNativeDirectiveDelivery(row: DirectiveRequestRecord, payload: Record<string, unknown>): void {
    const binding = row.nativeBinding;
    if (binding === null || row.nativeTarget?.agentId !== binding.agentId || row.nativeTarget.sessionFile !== binding.sessionFile) {
      throw new DirectiveCheckpointError('current directive delivery lacks its exact original native target');
    }
    const owner = this.recoveryOwnerBasis('directive', row.requestId);
    if (owner.owned || owner.changed && !owner.confirmed) throw new DirectiveCheckpointError('native completion cannot release original transferred owner context without genuine governing owner resolution');
    const identity = this.directiveTurnIdentity(row.requestId);
    const proof = inspectDirectiveCheckpoint(binding.sessionFile, identity);
    if (proof.state !== 'terminal' || !proof.ok || !isDeepStrictEqual(proof.binding, binding)) {
      throw new DirectiveCheckpointError('current directive delivery requires its exact successful native terminal checkpoint');
    }
    const physical = inspectDirectiveProducers(binding.sessionFile);
    const owners = physical.filter(({ producer }) => isDeepStrictEqual(producer.identity, identity));
    if (owners.length === 0 || owners.some(({ producer }) => producer.agentId !== binding.agentId || producer.sessionId !== binding.sessionId) ||
        physical.some(({ evidence }) => evidence === 'unknown') || directiveSessionLockBlocker(binding.sessionFile) !== null) {
      throw new DirectiveCheckpointError('current directive delivery retains UNKNOWN native physical ownership');
    }
    const completion = readDirectiveCompletion(binding.sessionFile, identity, proof.checkpointId);
    if (completion !== null && !owners.some(({ producer }) => isDeepStrictEqual(producer, completion.producer))) {
      throw new DirectiveCheckpointError('current directive completion receipt has unbound native physical ownership');
    }
    const native = typeof payload['native_completion'] === 'object' && payload['native_completion'] !== null
      ? payload['native_completion'] as Record<string, unknown> : null;
    const recorded = native?.['physical_cessation'];
    if (payload['sha'] !== (completion?.head ?? null) || typeof payload['candidate_delivery_proven'] !== 'boolean' ||
        payload['candidate_delivery_proven'] && (completion === null || completion.head === null) ||
        native === null || !isDeepStrictEqual(native['identity'], identity) || native['checkpoint_id'] !== proof.checkpointId ||
        !isDeepStrictEqual(native['binding'], binding) || !isDeepStrictEqual(native['receipt'], completion) ||
        !Array.isArray(recorded) || !recorded.every((record) => typeof record === 'object' && record !== null &&
          ['ceased', 'host-absent'].includes(String(record.evidence)) && physical.some(({ producer }) => isDeepStrictEqual(producer, record.producer))) ||
        !owners.every(({ producer }) => recorded.some((record) => isDeepStrictEqual(producer, record.producer)))) {
      throw new DirectiveCheckpointError('current directive delivery does not bind its exact native completion provenance');
    }
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
        throw new Error(`directive request "${input.requestId}" is ${directiveStateName(row)} — terminal delivery requires admitted state`);
      }
      if (row.requestKind !== null && row.nativeBinding === null) throw new DirectiveCheckpointError('current directive delivery requires exact native admission');
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
      let candidateProven = false;
      if (row.requestKind !== null) {
        if (payload['work_revision'] !== row.workRevision || payload['agentId'] !== row.nativeBinding?.agentId) throw new DirectiveCheckpointError('original delivery revision/minion identity differs from accepted native admission');
        this.assertNativeDirectiveDelivery(row, payload);
        if (payload['candidate_delivery_proven'] === true) {
          const reason = this.nativeCandidateRefusal(row, payload);
          candidateProven = reason === null;
          if (reason !== null) this.retainOriginalNativeGateDebt(row, event, reason);
        } else {
          this.retainOriginalNativeGateDebt(row, event, payload['historical_bookkeeping_only'] === true
            ? 'current authority is changed or parked'
            : 'publisher could not establish a current original-lane candidate');
        }
      }
      // Durable action marker and, for modern requests, the independently
      // checked candidacy decision. All writes publish only after commit.
      this.appendEvent({ kind: 'silas.directive-settled', jobId: row.jobId,
        payload: { request_id: input.requestId, delivery_seq: input.eventSeq,
          ...(row.requestKind === null ? {} : { candidate_delivery_proven: candidateProven }) } });
      this.db
        .prepare("UPDATE pending_directives SET state = 'settled', delivery_seq = ?, updated_at = ? WHERE request_id = ?")
        .run(input.eventSeq, nowIso(), input.requestId);
      // Qualify report handback only after exact terminal readback is visible
      // inside this transaction. Completion history alone cannot open current
      // commissioner disposition; replay/landed-delivery recovery remains
      // idempotent, and every write still publishes only after commit.
      this.ensureReportHandback(row.jobId, event.seq);
      this.settleDirectiveRecoveryDebt(row.requestId, input.eventSeq, 'job.delivered');
      // A separate current inspection may discharge only its explicitly
      // named current-action debt, never the missing historical delivery.
      const inspections = this.db.prepare(`SELECT * FROM events WHERE kind = 'silas.rebrief-control-closed' AND job_id = ?
        AND json_extract(payload, '$.inspection_request_id') = ? AND seq < ?`).all(row.jobId, row.requestId, row.baselineSeq) as Row[];
      for (const raw of inspections) {
        const closure = this.eventFromRow(raw);
        const facts = closure.payload as { marker_id: string; inspection_directive: string };
        const accepted = JSON.parse(row.payload) as { directive?: unknown };
        if (typeof accepted.directive !== 'string' || accepted.directive.trim() === '') throw new DirectiveCheckpointError('current inspection accepted payload lacks its canonical directive');
        if (accepted.directive !== facts.inspection_directive || row.nativeBinding === null) throw new DirectiveCheckpointError('current inspection request is not the exact separately admitted inspection action');
        const debt = this.listObligations({ jobId: row.jobId }).find((candidate) => candidate.incidentKey === `rebrief-current-inspection:${facts.marker_id}` &&
          ['open', 'waiting', 'suspended'].includes(candidate.state));
        if (debt !== undefined) {
          const identity = this.directiveTurnIdentity(row.requestId);
          const duty = this.preserveParkedRecoveryDebt(this.recordBlockedObservation(row.jobId, { logicalStep: 'verification',
            incidentKey: `rebrief-current-gates:${facts.marker_id}`, category: { kind: 'known', category: 'restart-recovery' }, observedAtSeq: event.seq,
            nextAction: { kind: 'gru-decision', decision: `CURRENT gate actions remain owed after inspection ${row.requestId}, delivery ${event.seq}, original closure ${closure.seq}; accepted identity ${JSON.stringify(identity)}; recorded inspection HEAD ${typeof payload['sha'] === 'string' ? payload['sha'] : 'UNPROVEN/null'}. Use existing POST /api/verify and POST /api/dispatch/review APIs with exact current approved inputs and real applicable verification/review evidence, or a separately explicit guarded safe action transfer. If these inputs are superseded or HEAD unproven, establish fresh current evidence first. Inspection delivery and historical receipts prove neither gates nor READY.` } }));
          this.appendEvent({ kind: 'silas.rebrief-current-gates-owed', jobId: row.jobId, payload: { marker_id: facts.marker_id, closure_seq: closure.seq,
            inspection_request_id: row.requestId, delivery_seq: event.seq, identity, sha: typeof payload['sha'] === 'string' ? payload['sha'] : null, obligation_id: duty.id, generation: duty.generation, next_action: duty.nextAction } });
          this.settleObligation({ obligationId: debt.id, settlement: { kind: 'superseded', byObligationId: duty.id,
            reason: `actual separately authorized CURRENT inspection ${row.requestId} completed; applicable current verification/review action explicitly remains owned by ${duty.id}` } });
        }
      }
      if (row.requestKind === 'rebrief') this.appendEvent({ kind: 'silas.rebrief-settled', jobId: row.jobId, payload: { request_id: row.requestId, delivery_seq: input.eventSeq } });
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
      if (row.state === 'retired') {
        throw new Error(`directive request "${input.requestId}" is retired — a late failure cannot rewrite a consumed decision`);
      }
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
      const phase = this.findPhaseHandoffByRequest({ jobId: row.jobId, requestId: row.requestId });
      if (phase?.state === 'awaiting') this.closePhaseHandoff({ phaseId: phase.phaseId, reason: input.reason });
      const record = this.getDirective(input.requestId) as DirectiveRequestRecord;
      this.reopenStrandedRecoveryDebt(record);
      return record;
    });
  }

  /** Bump a request's attempt counter without changing state (durable
   * reconcile passes are bounded and visible; "unknown" never silently
   * becomes "retried"). A retired request is a consumed decision — late
   * reconciliation cannot rewrite it. */
  recordDirectiveReconcile(input: { requestId: string; note: string }): DirectiveRequestRecord {
    return this.transaction(() => {
      const row = this.getDirective(input.requestId);
      if (row === null) throw new RecordNotFound(`directive request "${input.requestId}" not found`);
      if (isDirectiveTerminal(row.state)) return row;
      this.db
        .prepare('UPDATE pending_directives SET attempts = attempts + 1, fail_reason = ?, updated_at = ? WHERE request_id = ?')
        .run(`reconcile: ${input.note}`, nowIso(), input.requestId);
      return this.getDirective(input.requestId) as DirectiveRequestRecord;
    });
  }

  // ------------------------------------------------------------------
  // Guarded interrupted-directive recovery (owner approval j-1348)
  //
  // `retired` closes ONLY an interrupted request's control ownership, and
  // only after the service itself re-derives a fresh cessation predicate
  // from durable ownership marks plus the caller's binding expectations.
  // The caller contributes request/lane binding, the recovery obligation's
  // generation/plan/state, current epoch/revision/contract expectations and
  // audit labels — never physical cessation evidence. Unknown producer
  // custody refuses; owner abandonment is that case's exit. The transition
  // runs in ONE transaction: refusal checks, admission preservation, the
  // state flip, exactly one `silas.directive-retired` audit event, the
  // durable continuation hold, and the closure (never completion) of an
  // awaiting phase handoff all commit or roll back together.
  // ------------------------------------------------------------------

  /** Live ownership that forbids retiring an interrupted request. Every
   * read is durable state or the process-local admission registry (the
   * same boundary every producer must reserve before its first await), so
   * a synchronous check inside the state transaction is authoritative. */
  private directiveRetirementBlockers(row: Pick<DirectiveRequestRecord, 'requestId' | 'jobId'>, laneId: string, ownSpawningAgentId?: string, ownProducerStartSeq?: number, ownNativeProducer?: DirectiveProducer): readonly string[] {
    return this.directiveOwnership(row, laneId, ownSpawningAgentId, ownProducerStartSeq, ownNativeProducer).map(({ text }) => text);
  }

  /** The same ownership, each entry tagged: `unknown` when it records only
   * that a producer's cessation is unproven (unproven cleanup, a missing or
   * unreadable producer journal), `live` when it names a producer that runs
   * or is about to (a session lock, an open turn, an admission, a child, a
   * re-brief or another request owning the lane, a provider continuation, a
   * verification run, a review round, a lane process). */
  private directiveOwnership(row: Pick<DirectiveRequestRecord, 'requestId' | 'jobId'>, laneId: string, ownSpawningAgentId?: string, ownProducerStartSeq?: number,
    ownNativeProducer?: DirectiveProducer): readonly { readonly text: string; readonly custody: 'unknown' | 'live' }[] {
    const blockers: { text: string; custody: 'unknown' | 'live' }[] = this.directiveCleanupBlockers(row.jobId, ownProducerStartSeq)
      .map((text) => ({ text, custody: 'unknown' }));
    const unknown = (text: string) => blockers.push({ text, custody: 'unknown' });
    const live = (text: string) => blockers.push({ text, custody: 'live' });
    const target = this.getDirective(row.requestId)?.nativeTarget;
    if (target != null && ownNativeProducer === undefined) {
      try {
        const identity = this.directiveTurnIdentity(row.requestId);
        const owners = inspectDirectiveProducers(target.sessionFile);
        const original = owners.filter(({ producer }) => isDeepStrictEqual(producer.identity, identity));
        const last = owners.at(-1);
        const lock = last === undefined ? null : directiveProducerLockBlocker(last.producer);
        if (lock !== null) live(lock);
        if (original.length === 0 || owners.some(({ evidence }) => evidence === 'unknown')) unknown('original native physical owner cessation remains UNKNOWN');
        else if (original.some(({ evidence }) => evidence === 'host-absent')) {
          const checkpoint = inspectDirectiveCheckpoint(target.sessionFile, identity);
          if (checkpoint.state === 'unknown' || checkpoint.state === 'terminal' && !checkpoint.ok) unknown('original host absent but native effects/checkpoint remain UNKNOWN');
        }
      } catch (error) { unknown(`original native physical ownership unreadable: ${String(error)}`); }
    }
    const openTurns = this.listAgents().filter(
      (agent) => agent.jobId === row.jobId && ((agent.state === 'spawning' && agent.id !== ownSpawningAgentId) ||
        // Only progress callers can supply a validated current physical owner.
        // Retirement, generic logical-ID reuse and every other turn still block.
        agent.state === 'streaming' && !(agent.id === ownNativeProducer?.agentId && agent.sessionFile === ownNativeProducer.sessionFile)),
    );
    if (openTurns.length > 0) {
      live(`open worker turn(s): ${openTurns.map((agent) => `${agent.id} (${agent.state})`).join(', ')}`);
    }
    const admissions = this.listJobAdmissions(row.jobId);
    if (admissions.length > 0) live(`in-flight admission(s): ${admissions.join(', ')}`);
    const children = this.listChildWorkers({ jobId: row.jobId }).filter((child) => child.resultState === null);
    if (children.length > 0) {
      live(`non-terminal child worker(s): ${children.map((child) => `${child.id} (${child.state})`).join(', ')}`);
    }
    if (this.listPendingRebriefs({ jobId: row.jobId }).length > 0) {
      live('unresolved re-brief request(s) own the lane');
    }
    const otherLive = this.listPendingDirectives({ jobId: row.jobId, states: LIVE_DIRECTIVE_STATES }).filter(
      (other) => other.requestId !== row.requestId,
    );
    if (otherLive.length > 0) {
      live(`other live directive request(s): ${otherLive.map((other) => `${other.requestId} (${other.state})`).join(', ')}`);
    }
    const waits = this.listOpenProviderWaitsForJob(row.jobId);
    if (waits.length > 0) {
      live(`open provider continuation(s): ${waits.map((wait) => `${wait.id} (${wait.status})`).join(', ')}`);
    }
    if (this.hasUnsettledVerificationRun(row.jobId)) live('unsettled verification run(s) hold the lane');
    const rounds = this.listRounds(row.jobId).filter((round) => round.status === 'pending' || round.status === 'live');
    if (rounds.length > 0) {
      live(`live review round(s): ${rounds.map((round) => `${round.id} (${round.status})`).join(', ')}`);
    }
    // #464: a swept lane runs nothing; a row it left `live` (recorded
    // before sweeps moved them to `exited`) never fences a writer.
    const liveProcesses = this.db
      .prepare(
        `SELECT DISTINCT p.worktree_id AS worktree_id, p.pid AS pid
           FROM worktree_processes p
           JOIN worktrees w ON w.id = p.worktree_id
          WHERE p.state = 'live' AND w.status <> 'swept' AND (w.job_id = ? OR p.worktree_id = ?)
          ORDER BY p.worktree_id, p.pid`,
      )
      .all(row.jobId, laneId) as Row[];
    if (liveProcesses.length > 0) {
      live(
        `live lane process(es): ${liveProcesses
          .map((proc) => `${str(proc.worktree_id)} pid ${Number(proc.pid)}`)
          .join(', ')}`,
      );
    }
    return blockers;
  }

  /** Native terminal truth owns completion even before its ledger delivery.
   * Current candidacy and current permission never erase accepted history. */
  private assertNoCompletedNativeRetirement(row: DirectiveRequestRecord): void {
    if (row.nativeBinding === null || row.nativeTarget === null) return;
    const proof = inspectDirectiveCheckpoint(row.nativeBinding.sessionFile, this.directiveTurnIdentity(row.requestId));
    if (proof.state === 'terminal' && proof.ok && isDeepStrictEqual(proof.binding, row.nativeBinding)) {
      throw new DirectiveRetirementError('terminal_receipt_present', `directive request "${row.requestId}" has successful native completion — normal settlement owns it; do not clear writers or retire it to execute a successor`);
    }
  }

  /** Why the service cannot name who held this request, after its admission
   * evidence is bound. A row from before native producer identity has no
   * producer journal to read, and an admission minion that never registered
   * has no custody to inspect: unknown custody stays unknown and refuses
   * retirement (owner abandonment is the exit; it claims nothing). */
  directiveCustodyGaps(row: DirectiveRequestRecord): readonly string[] {
    const gaps: string[] = [];
    if (row.requestKind === null || row.authorityEpoch === null || row.workRevision === null || row.contractSha256 === null) {
      gaps.push(`original producer custody UNKNOWN: request ${row.requestId} predates the native producer identity and journal`);
    }
    // History, not the mutable current binding: a minion spawned on this job
    // (its `agent.spawned` record) or bound to it now was registered here.
    if (row.admissionMinion !== null && this.getAgent(row.admissionMinion)?.jobId !== row.jobId &&
        this.db.prepare("SELECT 1 FROM events WHERE kind = 'agent.spawned' AND agent_id = ? AND job_id = ? LIMIT 1").get(row.admissionMinion, row.jobId) === undefined) {
      gaps.push(`original producer custody UNKNOWN: admission minion ${row.admissionMinion} has no registration on job ${row.jobId}`);
    }
    return gaps;
  }

  /** An admitted row whose bound admission no longer matches its exact sent
   * event, request, minion and (for native rows) binding. */
  private directiveAdmissionIdentityGap(row: DirectiveRequestRecord): string | null {
    if (row.state !== 'admitted') return null;
    const sent = row.admissionSeq === null ? null : this.getEvent(row.admissionSeq);
    const payload = (typeof sent?.payload === 'object' && sent.payload !== null ? sent.payload : {}) as Record<string, unknown>;
    if (sent === null || sent.kind !== 'silas.directive-sent' || sent.jobId !== row.jobId ||
        sent.seq <= row.baselineSeq || payload['request_id'] !== row.requestId ||
        row.admissionMinion === null || payload['minion_id'] !== row.admissionMinion ||
        row.requestKind !== null && (row.nativeBinding === null || !isDeepStrictEqual(payload['native_binding'], row.nativeBinding))) {
      return `directive request "${row.requestId}" has inconsistent bound admission identity — reconcile the actual turn first`;
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Owner approvals (#523)
  //
  // Gru proposes one owner-reserved action; the owner's Approve on the
  // proposal's card makes the service carry it out. Every state change is one
  // transaction that appends an `owner-approval.<state>` event; at most one
  // non-terminal record exists per request.
  // ------------------------------------------------------------------

  getOwnerApproval(id: string): OwnerApprovalRecord | null {
    return selectOwnerApproval(this.db, id);
  }

  /** The record whose FOR YOU card is this notification. */
  ownerApprovalForNotification(notificationId: string): OwnerApprovalRecord | null {
    return selectOwnerApprovalByNotification(this.db, notificationId);
  }

  /** The request's `proposed`, `approved` or `executing` record, if any. */
  activeOwnerApprovalForRequest(requestId: string): OwnerApprovalRecord | null {
    return selectActiveOwnerApprovalForRequest(this.db, requestId);
  }

  /** The id of every non-terminal record, oldest first. */
  listActiveOwnerApprovalIds(): readonly string[] {
    return selectActiveOwnerApprovalIds(this.db);
  }

  /** The id of every ended record whose card is still open, oldest first. */
  listEndedOwnerApprovalIdsWithOpenCard(): readonly string[] {
    return selectEndedOwnerApprovalIdsWithOpenCard(this.db);
  }

  /** The record's state changes in order, from its `owner-approval.*` events. */
  ownerApprovalHistory(id: string): readonly OwnerApprovalHistoryEntry[] {
    const rows = this.db
      .prepare("SELECT ts, kind, payload FROM events WHERE kind LIKE 'owner-approval.%' AND json_extract(payload, '$.id') = ? ORDER BY seq")
      .all(id) as Row[];
    return rows.map((row) => {
      const detail = (JSON.parse(str(row.payload)) as { detail?: unknown }).detail;
      return { state: str(row.kind).slice('owner-approval.'.length), at: str(row.ts), detail: typeof detail === 'string' ? detail : null };
    });
  }

  /** The facts a directive-abandon approval is bound to, as they are now: the
   * request's job, its state as readers name it, its payload hash and its
   * recovery-debt generation (null when it owes none). Null for an unknown
   * request. */
  ownerApprovalFenceReadback(requestId: string): { readonly jobId: string; readonly state: string; readonly payloadHash: string; readonly debtGeneration: number | null } | null {
    const row = this.getDirective(requestId);
    if (row === null) return null;
    return { jobId: row.jobId, state: directiveStateName(row), payloadHash: row.payloadHash,
      debtGeneration: this.recoveryObligation(row.jobId, 'directive', row.requestId)?.generation ?? null };
  }

  /** Record a proposal: the replay of an idempotency key first, then the
   * request (it exists and is live), then the one-open-record rule. Nothing
   * is written unless a record is created. */
  proposeOwnerApproval(input: {
    readonly kind: OwnerApprovalKind;
    readonly requestId: string;
    readonly reason: string;
    readonly idempotencyKey: string;
  }): OwnerApprovalProposal {
    return this.transaction((): OwnerApprovalProposal => {
      const fingerprint = ownerApprovalFingerprint(input.kind, input.requestId, input.reason);
      const keyed = selectOwnerApprovalByKey(this.db, input.idempotencyKey);
      if (keyed !== null) return { kind: keyed.bodyFingerprint === fingerprint ? 'replayed' : 'key_conflict', approval: keyed };
      const row = this.getDirective(input.requestId);
      if (row === null) return { kind: 'unknown_request' };
      if (row.state !== 'dispatching' && row.state !== 'admitted') return { kind: 'not_live', state: directiveStateName(row) };
      const active = selectActiveOwnerApprovalForRequest(this.db, input.requestId);
      if (active !== null) return { kind: 'pending', approval: active };
      const fences: OwnerApprovalFences = { jobId: row.jobId, state: row.state, payloadHash: row.payloadHash,
        debtGeneration: this.recoveryObligation(row.jobId, 'directive', row.requestId)?.generation ?? null };
      const id = `oa-${randomUUID()}`;
      const notificationId = `owner-approval:${id}`;
      const ts = nowIso();
      insertOwnerApproval(this.db, { id, kind: input.kind, requestId: input.requestId, fences, reason: input.reason,
        idempotencyKey: input.idempotencyKey, bodyFingerprint: fingerprint, notificationId, createdAt: ts, updatedAt: ts });
      this.appendEvent({ kind: ownerApprovalEventKind('proposed'), jobId: row.jobId,
        payload: { id, approval_kind: input.kind, request_id: input.requestId, notification_id: notificationId,
          card_kind: OWNER_APPROVAL_CARD_KIND[input.kind], fences, detail: 'proposed by gru' } });
      return { kind: 'created', approval: selectOwnerApproval(this.db, id) as OwnerApprovalRecord };
    });
  }

  private ownerApprovalOrThrow(id: string, from: readonly OwnerApprovalRecord['state'][], to: string): OwnerApprovalRecord {
    const current = selectOwnerApproval(this.db, id);
    if (current === null) throw new RecordNotFound(`owner approval "${id}" not found`);
    if (!from.includes(current.state)) {
      throw new Error(`owner approval "${id}" is ${current.state} — it moves to ${to} only from ${from.join(' or ')}`);
    }
    return current;
  }

  /** The owner said yes: `proposed` → `approved`. */
  approveOwnerApproval(id: string, detail: string): OwnerApprovalRecord {
    return this.transaction(() => {
      const current = this.ownerApprovalOrThrow(id, ['proposed'], 'approved');
      updateOwnerApproval(this.db, id, { state: 'approved', updatedAt: nowIso() });
      this.appendEvent({ kind: ownerApprovalEventKind('approved'), jobId: current.jobId,
        payload: { id, request_id: current.requestId, detail } });
      return selectOwnerApproval(this.db, id) as OwnerApprovalRecord;
    });
  }

  /** The fences held: `approved` → `executing`, remembering the event's seq
   * so an abandonment can be told apart as before or after it. */
  beginOwnerApprovalExecution(id: string, detail: string): OwnerApprovalRecord {
    return this.transaction(() => {
      const current = this.ownerApprovalOrThrow(id, ['approved'], 'executing');
      const event = this.appendEvent({ kind: ownerApprovalEventKind('executing'), jobId: current.jobId,
        payload: { id, request_id: current.requestId, detail } });
      updateOwnerApproval(this.db, id, { state: 'executing', executingSeq: event.seq, updatedAt: nowIso() });
      return selectOwnerApproval(this.db, id) as OwnerApprovalRecord;
    });
  }

  /** End a record: `succeeded` from `executing`, `denied` and `withdrawn` from
   * `proposed`, `refused` from any non-terminal state. */
  endOwnerApproval(id: string, outcome: OwnerApprovalOutcome): OwnerApprovalRecord {
    return this.transaction(() => {
      const current = this.ownerApprovalOrThrow(id, OWNER_APPROVAL_ENDINGS[outcome.state], outcome.state);
      updateOwnerApproval(this.db, id, {
        state: outcome.state,
        ...(outcome.state === 'succeeded' ? { abandonmentEventSeq: outcome.abandonmentEventSeq } : {}),
        ...(outcome.state === 'refused' ? { refusal: outcome.refusal } : {}),
        updatedAt: nowIso(),
      });
      this.appendEvent({ kind: ownerApprovalEventKind(outcome.state), jobId: current.jobId,
        payload: { id, request_id: current.requestId, detail: outcome.detail,
          ...(outcome.state === 'succeeded' ? { abandonment_event_seq: outcome.abandonmentEventSeq } : {}),
          ...(outcome.state === 'refused' ? { code: outcome.refusal.code, blockers: outcome.refusal.blockers } : {}) } });
      return selectOwnerApproval(this.db, id) as OwnerApprovalRecord;
    });
  }

  /** One failed attempt at carrying the action out: counted and recorded; it
   * stays `executing` for the next reconcile, and the last allowed attempt
   * ends it `refused` as `execution-error` in the same transaction. */
  recordOwnerApprovalAttemptFailure(id: string, message: string): OwnerApprovalRecord {
    return this.transaction(() => {
      const current = this.ownerApprovalOrThrow(id, ['executing'], 'another attempt');
      const attempts = current.attempts + 1;
      updateOwnerApproval(this.db, id, { state: 'executing', attempts, updatedAt: nowIso() });
      this.appendEvent({ kind: ownerApprovalEventKind('attempt-failed'), jobId: current.jobId,
        payload: { id, request_id: current.requestId, attempt: attempts, detail: message } });
      if (attempts >= OWNER_APPROVAL_MAX_ATTEMPTS) {
        return this.endOwnerApproval(id, { state: 'refused', refusal: { code: 'execution-error', blockers: [message] },
          detail: `Not run: execution-error after ${String(attempts)} attempts` });
      }
      return selectOwnerApproval(this.db, id) as OwnerApprovalRecord;
    });
  }

  // ------------------------------------------------------------------
  // Canceled-request closeout (#523)
  //
  // Binning a job whose only live request was deferred before reaching its
  // worker: S1 `beginCloseout` records the intent, S2 is the guarded
  // retirement (`retireInterruptedDirective`), S3 `completeCloseout` bins the
  // job, resolves the request's card and completes the intent. Each step is
  // one transaction; a crash leaves the intent `open`, which means resume.
  // ------------------------------------------------------------------

  getCloseout(closeoutId: string): CloseoutIntent | null {
    return selectCloseout(this.db, closeoutId);
  }

  /** The newest generation for one request, whatever its state. */
  latestCloseoutForRequest(requestId: string): CloseoutIntent | null {
    return selectLatestCloseoutForRequest(this.db, requestId);
  }

  /** The newest intent of any request on the job. */
  latestCloseoutForJob(jobId: string): CloseoutIntent | null {
    return selectLatestCloseoutForJob(this.db, jobId);
  }

  /** The job's `open` or `stopped` intent, if any. */
  activeCloseoutForJob(jobId: string): CloseoutIntent | null {
    return selectActiveCloseoutForJob(this.db, jobId);
  }

  /** The id of every `open` or `stopped` intent, oldest first. */
  listActiveCloseoutIds(): readonly string[] {
    return selectActiveCloseoutIds(this.db);
  }

  /** True while an `open` or `stopped` intent owes this request its end. */
  hasPendingCloseout(requestId: string): boolean {
    return hasActiveCloseout(this.db, requestId);
  }

  /** The redispatch fence: a request a closeout owes its end is never dispatched. */
  private assertNoPendingCloseout(requestId: string): void {
    const pending = selectActiveCloseoutForRequest(this.db, requestId);
    if (pending !== null) throw new CloseoutPendingError(requestId, pending.closeoutId, pending.state);
  }

  /** The request a binning request would close out, or null when the job
   * does not meet the eligibility rule: a non-terminal job (the status
   * machine admits binned) whose ONLY live request is `dispatching`, carries
   * a request kind, was claimed for dispatch and then positively deferred
   * before any native effect, has no recovery decision, and which no pending
   * re-brief marker accompanies. Equivalently, `doneBlockers(jobId)` names
   * exactly that one request. */
  closeoutCandidate(jobId: string): DirectiveRequestRecord | null {
    const job = this.getJob(jobId);
    if (job === null || isJobTerminal(job.status)) return null;
    try { assertJobTransition(job.status, 'binned'); } catch { return null; }
    const live = this.listPendingDirectives({ jobId, states: LIVE_DIRECTIVE_STATES });
    if (live.length !== 1 || this.listPendingRebriefs({ jobId }).length > 0) return null;
    const request = live[0] as DirectiveRequestRecord;
    if (request.state !== 'dispatching' || request.requestKind === null || request.dispatchStartedAt === null || request.recoveryDecision !== null) return null;
    try { if (!this.hasDirectiveDispatchDeferral(request.requestId)) return null; }
    catch (error) {
      // Legacy authority that cannot be proven is never a deferral.
      if (error instanceof DirectiveCheckpointError) return null;
      throw error;
    }
    return request;
  }

  /** S1: re-run the one evaluation inside the transaction, then record the
   * intent (`open`) and its `silas.closeout-intent` event. A refusal writes
   * nothing. */
  beginCloseout(input: {
    readonly jobId: string;
    readonly requestId: string;
    readonly requestedBy: CloseoutRequester;
    readonly reason: string | null;
    readonly evaluate: () => readonly CloseoutBlocker[];
  }): { readonly kind: 'begun'; readonly intent: CloseoutIntent } | { readonly kind: 'refused'; readonly blockers: readonly CloseoutBlocker[] } {
    return this.transaction(() => {
      const candidate = this.closeoutCandidate(input.jobId);
      if (candidate === null || candidate.requestId !== input.requestId) {
        return { kind: 'refused' as const, blockers: [{ code: 'closeout_not_eligible',
          detail: `job "${input.jobId}" no longer meets the closeout eligibility rule for request "${input.requestId}"` }] };
      }
      if (selectActiveCloseoutForRequest(this.db, input.requestId) !== null) {
        throw new Error(`directive request "${input.requestId}" already has an open or stopped closeout — resume it, never start a second`);
      }
      const blockers = input.evaluate();
      if (blockers.length > 0) return { kind: 'refused' as const, blockers };
      const job = this.getJob(input.jobId) as JobRecord;
      const generation = nextCloseoutGeneration(this.db, input.requestId);
      const closeoutId = randomUUID();
      const event = this.appendEvent({ kind: 'silas.closeout-intent', jobId: input.jobId,
        payload: { closeout_id: closeoutId, request_id: input.requestId, generation, payload_hash: candidate.payloadHash,
          job_status: job.status, requested_by: input.requestedBy, reason: input.reason, by: CLOSEOUT_ACTOR } });
      const ts = nowIso();
      insertCloseout(this.db, { closeoutId, jobId: input.jobId, requestId: input.requestId, generation, payloadHash: candidate.payloadHash,
        jobStatus: job.status, intentSeq: event.seq, requestedBy: input.requestedBy, reason: input.reason, createdAt: ts, updatedAt: ts });
      return { kind: 'begun' as const, intent: selectCloseout(this.db, closeoutId) as CloseoutIntent };
    });
  }

  /** The first failing revalidation predicate for an active intent, or null
   * (plus whether S2 is already satisfied). The intent stores only fixed
   * identities; the closeout's own writes are recognised by event identity
   * (its one `silas.directive-retired`), never by comparing epoch values.
   *  P1 the job status still equals the stored one;
   *  P2 before S2 the request is still `dispatching` with its deferral and no
   *     recovery decision, or `retired` by a retire event after the intent;
   *     before S3 it is `retired` and not abandoned;
   *  P3 no other request row on the job was accepted after the intent;
   *  P4 the control events after the intent are at most this request's one
   *     `silas.directive-retired`. */
  private closeoutStaleReason(intent: CloseoutIntent, before: 'retire' | 'bin'): { readonly reason: CloseoutSupersededReason | null; readonly retired: boolean } {
    const job = this.getJob(intent.jobId);
    const row = this.getDirective(intent.requestId);
    const retireEvent = this.latestJobEventByRequestId(intent.jobId, 'silas.directive-retired', intent.requestId, { sinceSeq: intent.intentSeq });
    const retired = row !== null && row.state === 'retired' && row.abandonedAt === null && retireEvent !== null;
    if (job === null || job.status !== intent.jobStatus) return { reason: 'job-status', retired };
    if (row === null || row.payloadHash !== intent.payloadHash) return { reason: 'request-state', retired };
    if (before === 'retire') {
      const pending = row.state === 'dispatching' && row.recoveryDecision === null && this.hasDirectiveDispatchDeferral(row.requestId);
      if (!pending && !retired) return { reason: 'request-state', retired };
    } else if (row.state !== 'retired' || row.abandonedAt !== null) {
      return { reason: 'request-state', retired };
    }
    const later = this.db.prepare('SELECT 1 FROM pending_directives WHERE job_id = ? AND request_id <> ? AND baseline_seq >= ? LIMIT 1')
      .get(intent.jobId, intent.requestId, intent.intentSeq);
    if (later !== undefined) return { reason: 'later-work', retired };
    const control = this.db.prepare(`SELECT seq, kind, payload FROM events WHERE job_id = ? AND seq > ? AND (${DIRECTIVE_CONTROL_SQL}) ORDER BY seq`)
      .all(intent.jobId, intent.intentSeq) as Row[];
    const own = control.filter((event) => event.kind === 'silas.directive-retired' &&
      (JSON.parse(str(event.payload)) as { request_id?: unknown }).request_id === intent.requestId);
    if (control.length > own.length || own.length > 1) return { reason: 'control-event', retired };
    return { reason: null, retired };
  }

  private supersedeCloseout(intent: CloseoutIntent, reason: CloseoutSupersededReason): CloseoutIntent {
    updateCloseoutState(this.db, intent.closeoutId, { state: 'superseded', supersededReason: reason, updatedAt: nowIso() });
    this.appendEvent({ kind: 'silas.closeout-superseded', jobId: intent.jobId,
      payload: { closeout_id: intent.closeoutId, request_id: intent.requestId, generation: intent.generation, superseded_reason: reason, by: CLOSEOUT_ACTOR } });
    return selectCloseout(this.db, intent.closeoutId) as CloseoutIntent;
  }

  private activeCloseoutOrThrow(closeoutId: string): CloseoutIntent {
    const intent = selectCloseout(this.db, closeoutId);
    if (intent === null) throw new RecordNotFound(`closeout "${closeoutId}" not found`);
    if (intent.state !== 'open' && intent.state !== 'stopped') {
      throw new Error(`closeout "${closeoutId}" is ${intent.state} — only an open or stopped closeout takes a step`);
    }
    return intent;
  }

  /** Revalidate before S2. A stale intent is superseded (fence lifted) and
   * returned; otherwise `retired` says S2 is already satisfied (a retire of
   * this request after the intent, by the closeout or by hand). */
  guardCloseoutRetire(closeoutId: string): { readonly ok: true; readonly retired: boolean; readonly intent: CloseoutIntent } | { readonly ok: false; readonly intent: CloseoutIntent } {
    return this.transaction(() => {
      const intent = this.activeCloseoutOrThrow(closeoutId);
      const stale = this.closeoutStaleReason(intent, 'retire');
      if (stale.reason !== null) return { ok: false as const, intent: this.supersedeCloseout(intent, stale.reason) };
      return { ok: true as const, retired: stale.retired, intent };
    });
  }

  /** Why an active intent no longer describes the job (the first failing
   * revalidation predicate), or null while it still does. A read: nothing is
   * superseded here; the next step does that. */
  closeoutStaleness(closeoutId: string): CloseoutSupersededReason | null {
    const intent = this.activeCloseoutOrThrow(closeoutId);
    const retired = this.getDirective(intent.requestId)?.state === 'retired';
    return this.closeoutStaleReason(intent, retired ? 'bin' : 'retire').reason;
  }

  /** The blockers binning would meet right now: the live work `setJobStatus`
   * refuses (S3). A stopped intent whose request is already retired is
   * re-evaluated against exactly this. */
  closeoutBinBlockers(jobId: string): readonly CloseoutBlocker[] {
    return this.terminalLiveWorkBlockers(jobId).map((detail) => ({ code: 'live_work', detail }));
  }

  /** S3: revalidate, bin the job (status, `job.status` event, obligations
   * closed `job-terminal`/`binned`), resolve the request's card — never an
   * Ack — and complete the intent, in one transaction. Live work that
   * appeared after S2 makes `setJobStatus` refuse (`TerminalLiveWorkError`);
   * the whole step rolls back and the caller records the intent stopped. */
  completeCloseout(closeoutId: string): { readonly kind: 'complete'; readonly intent: CloseoutIntent; readonly job: JobRecord } | { readonly kind: 'superseded'; readonly intent: CloseoutIntent } {
    return this.transaction(() => {
      const intent = this.activeCloseoutOrThrow(closeoutId);
      const stale = this.closeoutStaleReason(intent, 'bin');
      if (stale.reason !== null) return { kind: 'superseded' as const, intent: this.supersedeCloseout(intent, stale.reason) };
      const job = this.setJobStatus(intent.jobId, 'binned');
      const card = this.findNotificationByKind(`silas.directive-unreconciled.${intent.requestId}`, 'active');
      if (card?.routing === 'action-required') this.resolveNotificationById(card.id, CLOSEOUT_ACTOR);
      updateCloseoutState(this.db, intent.closeoutId, { state: 'complete', updatedAt: nowIso() });
      this.appendEvent({ kind: 'silas.closeout-complete', jobId: intent.jobId,
        payload: { closeout_id: intent.closeoutId, request_id: intent.requestId, generation: intent.generation, by: CLOSEOUT_ACTOR } });
      return { kind: 'complete' as const, intent: selectCloseout(this.db, intent.closeoutId) as CloseoutIntent, job };
    });
  }

  /** Record a guard that refused AFTER preflight (a race): the intent is
   * `stopped` with the blockers and their fingerprint. Recording the same
   * fingerprint again writes nothing. */
  stopCloseout(closeoutId: string, blockers: readonly CloseoutBlocker[]): CloseoutIntent {
    return this.transaction(() => {
      const intent = this.activeCloseoutOrThrow(closeoutId);
      if (intent.state === 'stopped' && intent.blockerFingerprint === closeoutBlockerFingerprint(blockers)) return intent;
      updateCloseoutState(this.db, closeoutId, { state: 'stopped', blockers, updatedAt: nowIso() });
      const stopped = selectCloseout(this.db, closeoutId) as CloseoutIntent;
      this.appendEvent({ kind: 'silas.closeout-stopped', jobId: intent.jobId,
        payload: { closeout_id: intent.closeoutId, request_id: intent.requestId, generation: intent.generation, blockers,
          blocker_fingerprint: stopped.blockerFingerprint, by: CLOSEOUT_ACTOR } });
      return stopped;
    });
  }

  /** The caller-independent guards of a live retirement, in the order the
   * retirement evaluates them: live ownership, completed native work, a
   * correlated terminal receipt, bound admission evidence and unknown
   * producer custody. Throws the typed refusal; returns the row with its
   * correlated admission evidence bound (the only write, and only for a
   * row that has such evidence). `retireInterruptedDirective` and the
   * canceled-request closeout evaluate exactly this set, so a request is
   * refused for the same reasons on either path. The caller's expectations
   * (generation, authority, head) are NOT here: they compare caller input. */
  retirementPreflight(requestId: string, laneId: string): DirectiveRequestRecord {
    return this.transaction(() => {
      const row = this.getDirective(requestId);
      if (row === null) throw new RecordNotFound(`directive request "${requestId}" not found`);
      if (row.state !== 'dispatching' && row.state !== 'admitted') {
        throw new DirectiveRetirementError('directive_not_live',
          `directive request "${requestId}" is ${directiveStateName(row)} — only a live request can be retired`);
      }
      const blockers = this.directiveRetirementBlockers(row, laneId);
      if (blockers.length > 0) {
        throw new DirectiveRetirementError(
          'live_work',
          `job "${row.jobId}" still has live ownership — retirement would conceal or orphan it`,
          blockers,
        );
      }
      this.assertNoCompletedNativeRetirement(row);
      // A correlated terminal receipt means normal settlement owns this
      // request; retirement must never overwrite it.
      const delivered = this.latestJobEventByRequestId(row.jobId, 'job.delivered', row.requestId);
      if (delivered !== null) {
        throw new DirectiveRetirementError(
          'terminal_receipt_present',
          `directive request "${requestId}" has a correlated job.delivered receipt at seq ${delivered.seq} — ` +
            'normal settlement (or the reconciler) owns it; do not overwrite a terminal receipt',
        );
      }
      // Preserve prior admission information when present: a correlated
      // admission event binds FIRST through the existing validated
      // transition, so the retired row truthfully reads
      // `admitted-without-terminal` instead of erasing the real turn.
      let current = row;
      if (current.state === 'dispatching') {
        const sent = this.latestJobEventByRequestId(row.jobId, 'silas.directive-sent', row.requestId);
        if (sent !== null) {
          const payload = (typeof sent.payload === 'object' && sent.payload !== null ? sent.payload : {}) as Record<string, unknown>;
          const minionId = typeof payload['minion_id'] === 'string' && payload['minion_id'] !== '' ? payload['minion_id'] : null;
          if (minionId === null) {
            throw new DirectiveRetirementError(
              'admission_evidence_incomplete',
              `directive request "${requestId}" has correlated admission evidence at seq ${sent.seq} without a minion identity — ` +
                'reconcile the actual turn before closing control',
            );
          }
          try {
            current = this.recordDirectiveAdmission({ requestId: row.requestId, minionId, eventSeq: sent.seq });
          } catch (error) {
            throw new DirectiveRetirementError(
              'admission_evidence_incomplete',
              `directive request "${requestId}" correlated admission evidence is inconsistent: ${String(error)}`,
            );
          }
        }
      }
      const admissionGap = this.directiveAdmissionIdentityGap(current);
      if (admissionGap !== null) throw new DirectiveRetirementError('admission_evidence_incomplete', admissionGap);
      // Last, unknown custody: no producer identity/journal or no
      // registered admission minion means no cessation can be verified.
      const custody = this.directiveCustodyGaps(current);
      if (custody.length > 0) {
        throw new DirectiveRetirementError('live_work',
          `directive request "${requestId}" has unknown producer custody — retirement cannot verify cessation`, custody);
      }
      return current;
    });
  }

  /** Guarded control closure. See the block comment above for the contract. */
  retireInterruptedDirective(input: {
    requestId: string;
    expectedJobId: string;
    expectedState: LiveDirectiveState;
    expectedPayloadHash: string;
    expectedHead: string;
    expectedGeneration?: number | null;
    expectedPlanRevision?: number | null;
    expectedObligationState?: ObligationState | null;
    expectedAuthorityEpoch?: number;
    expectedWorkRevision?: number;
    expectedContractSha256?: string;
    /** Server-resolved lane evidence; required on the live path and
     * deliberately ignored on the consumed-replay path (the lane may be
     * gone by then — the decision is already durable). */
    lane?: { readonly id: string; readonly resolvedHead: string };
    reason: string;
    by: string;
  }): { readonly record: DirectiveRequestRecord; readonly idempotent: boolean; readonly phaseClosed: string | null } {
    if (input.reason.trim() === '') throw new Error('directive retirement requires a reason');
    if (input.by.trim() === '') throw new Error('directive retirement requires a by label');
    const { lane: _lane, ...intent } = input;
    return this.transaction(() => {
      const row = this.getDirective(input.requestId);
      if (row === null) throw new RecordNotFound(`directive request "${input.requestId}" not found`);
      // A terminal request is decided by its state alone, before any
      // expectation is read: no body can make a settled/failed row live.
      if (row.state === 'settled' || row.state === 'failed') {
        throw new DirectiveRetirementError(
          'directive_not_live',
          `directive request "${input.requestId}" is ${directiveStateName(row)} — only a live request can be retired`,
        );
      }
      if (row.state === 'retired') {
        // One logical operation is idempotent; changed intent is a conflict.
        // A partial context can never be the recorded one.
        let fingerprint: string | null = null;
        try { fingerprint = directiveRetirementFingerprint(intent); }
        catch (error) { if (!(error instanceof DirectiveRetirementError && error.code === 'incomplete_context')) throw error; }
        if (row.retireFingerprint !== fingerprint) {
          throw new DirectiveRetirementError(
            'retire_conflict',
            `directive request "${input.requestId}" was retired by a different decision — ` +
              'a retirement is one exact logical operation; the recorded outcome stands (replay it with the recorded retire_expected_* fields)',
          );
        }
        // The original call may have closed an awaiting phase handoff;
        // the replay reports the same closure it produced (never null when
        // THIS retirement closed it).
        const phase = this.findPhaseHandoffByRequest({ jobId: row.jobId, requestId: row.requestId });
        const phaseClosed = phase !== null && phase.state === 'closed' &&
          phase.closeReason !== null && phase.closeReason.startsWith('directive request retired without completion')
          ? phase.phaseId
          : null;
        return { record: row, idempotent: true, phaseClosed };
      }
      // Binding expectations: identity, payload, expected class and state.
      if (row.jobId !== input.expectedJobId) {
        throw new DirectiveRetirementError(
          'request_mismatch',
          `directive request "${input.requestId}" belongs to job ${row.jobId}, not ${input.expectedJobId}`,
        );
      }
      if (row.state !== input.expectedState) {
        throw new DirectiveRetirementError(
          'request_mismatch',
          `directive request "${input.requestId}" is ${row.state}, not the expected ${input.expectedState} — read the row again`,
        );
      }
      if (row.payloadHash !== input.expectedPayloadHash) {
        throw new DirectiveRetirementError(
          'request_mismatch',
          `directive request "${input.requestId}" payload hash does not match the accepted request`,
        );
      }
      const fingerprint = directiveRetirementFingerprint(intent satisfies DirectiveRetirementIntent);
      if (!directiveRetirementHasContext(intent)) {
        throw new DirectiveRetirementError('incomplete_context',
          `live directive retirement of "${input.requestId}" requires ${Object.values(DIRECTIVE_RETIREMENT_CONTEXT).join(', ')} from fresh readback`);
      }
      // The exact obligation incarnation: a same-generation re-plan (a new
      // next action) or state change is as stale as a new generation.
      const currentDebt = this.recoveryObligation(row.jobId, 'directive', row.requestId);
      if ((currentDebt?.generation ?? null) !== input.expectedGeneration ||
          (currentDebt?.planRevision ?? null) !== input.expectedPlanRevision ||
          (currentDebt?.state ?? null) !== input.expectedObligationState) {
        throw new DirectiveRetirementError('stale_generation',
          `directive request "${input.requestId}" recovery obligation generation, plan or state changed — read the exact obligation again`);
      }
      const currentAuthority = this.directiveCurrentAuthority(row.jobId);
      if (input.expectedAuthorityEpoch !== currentAuthority.authorityEpoch ||
          input.expectedWorkRevision !== currentAuthority.workRevision ||
          input.expectedContractSha256 !== currentAuthority.contractSha256) {
        throw new DirectiveRetirementError('stale_authority',
          `directive request "${input.requestId}" current control epoch or approved work inputs changed — read authority again`);
      }
      if (input.lane === undefined) {
        throw new Error(`retirement of live directive request "${input.requestId}" requires resolved lane evidence`);
      }
      if (input.expectedHead !== input.lane.resolvedHead) {
        throw new DirectiveRetirementError(
          'stale_head',
          `directive request "${input.requestId}" retirement bound head ${input.expectedHead} but the lane now resolves ${input.lane.resolvedHead} — ` +
            're-verify the writer ceased at the current head',
        );
      }
      const current = this.retirementPreflight(row.requestId, input.lane.id);
      const admissionClass = directiveAdmissionClass(current);
      const ts = nowIso();
      this.db
        .prepare(
          `UPDATE pending_directives
              SET state = 'retired', retired_at = ?, retired_by = ?, retire_reason = ?, retire_fingerprint = ?,
                  retire_expected_state = ?, retire_expected_head = ?, retire_expected_generation = ?,
                  retire_expected_plan_revision = ?, retire_expected_obligation_state = ?, retire_expected_authority_epoch = ?,
                  retire_expected_work_revision = ?, retire_expected_contract_sha256 = ?, updated_at = ?
            WHERE request_id = ?`,
        )
        .run(ts, input.by, input.reason, fingerprint, input.expectedState, input.expectedHead, input.expectedGeneration ?? null,
          input.expectedPlanRevision ?? null, input.expectedObligationState ?? null, input.expectedAuthorityEpoch ?? null,
          input.expectedWorkRevision ?? null, input.expectedContractSha256 ?? null, ts, row.requestId);
      // An awaiting phase handoff attached to this request can never
      // complete from it: close it (never complete it) with the truthful
      // reason, in the same transaction — and carry the closed id on the
      // audit event so the durable correlation is one fact, not a lookup.
      const phase = this.findPhaseHandoffByRequest({ jobId: row.jobId, requestId: row.requestId });
      let phaseClosed: string | null = null;
      if (phase !== null && phase.state === 'awaiting') {
        this.closePhaseHandoff({
          phaseId: phase.phaseId,
          reason: `directive request retired without completion: ${input.reason}`,
        });
        phaseClosed = phase.phaseId;
      }
      this.appendEvent({
        kind: 'silas.directive-retired',
        jobId: row.jobId,
        payload: {
          request_id: row.requestId,
          by: input.by,
          reason: input.reason,
          admission_class: admissionClass,
          admission_seq: current.admissionSeq,
          admission_minion: current.admissionMinion,
          expected_state: input.expectedState,
          expected_head: input.expectedHead,
          expected_generation: input.expectedGeneration,
          expected_plan_revision: input.expectedPlanRevision,
          expected_obligation_state: input.expectedObligationState,
          expected_authority_epoch: input.expectedAuthorityEpoch,
          expected_work_revision: input.expectedWorkRevision,
          expected_contract_sha256: input.expectedContractSha256,
          lane_id: input.lane.id,
          phase_handoff_closed: phaseClosed,
        },
      });
      const record = this.getDirective(row.requestId) as DirectiveRequestRecord;
      this.reopenStrandedRecoveryDebt(record);
      // Retirement ends what the request's card asks for, unless a recovery
      // debt still owes a decision: the card stays its pointer until that
      // debt settles (or reopens), which resolves it.
      const card = this.findNotificationByKind(`silas.directive-unreconciled.${row.requestId}`, 'active');
      if (card?.routing === 'action-required' && this.recoveryObligation(row.jobId, 'directive', row.requestId) === null) {
        this.resolveNotificationById(card.id, 'directive-retired');
      }
      return { record, idempotent: false, phaseClosed };
    });
  }

  /** Owner abandonment: the exit for a live request whose producer custody
   * the service cannot establish, so retirement stays refused: no producer
   * identity or journal, a minion with no registration on the job, unproven
   * cleanup, no or several lanes. Only those unknowns may be abandoned; any
   * producer known to be live or about to run (a lane process, a provider
   * continuation, a session lock, a re-brief or other request owning the
   * lane, an open turn, an admission, a supervised restart or retry) refuses
   * by name. It records the request `failed` with `abandoned_*` facts and an
   * open continuation hold, closes the request's own recovery debt and card
   * as outcome-unknown, and appends one `silas.directive-abandoned` audit
   * naming what stays unknown and why retirement was refused. It claims no
   * completion, no effect and no cessation, and clears no producer-
   * uncertainty record. Owner only; idempotent by request id. */
  abandonLiveDirective(input: {
    requestId: string;
    expectedJobId: string;
    /** `abandoned` only to replay an abandonment rebuilt from readback. */
    expectedState: LiveDirectiveState | 'abandoned';
    expectedPayloadHash: string;
    /** Route evidence: the single resolved lane, or why none could be bound. */
    lane: { readonly id: string; readonly resolvedHead: string } | { readonly unavailable: string };
    /** Route-side ownership (supervisor, pace queue): producer-custody
     * uncertainty may be abandoned, every other entry refuses. */
    routeBlockers: readonly string[];
    reason: string;
    by: string;
  }): { readonly record: DirectiveRequestRecord; readonly idempotent: boolean; readonly event: EventRecord } {
    if (input.by !== 'owner') throw new Error('directive abandonment is the owner\'s decision: by must be "owner"');
    if (input.reason.trim() === '') throw new Error('directive abandonment requires a reason');
    return this.transaction(() => {
      const row = this.getDirective(input.requestId);
      if (row === null) throw new RecordNotFound(`directive request "${input.requestId}" not found`);
      if (row.jobId !== input.expectedJobId || row.payloadHash !== input.expectedPayloadHash) {
        throw new DirectiveRetirementError('request_mismatch',
          `directive request "${input.requestId}" does not match the expected job and payload hash — read the row again`);
      }
      if (row.abandonedAt !== null) {
        const recorded = this.latestJobEventByRequestId(row.jobId, 'silas.directive-abandoned', row.requestId);
        if (recorded === null) throw new Error(`directive request "${row.requestId}" is abandoned but its silas.directive-abandoned audit is missing`);
        return { record: row, idempotent: true, event: recorded };
      }
      if (isDirectiveTerminal(row.state)) {
        throw new DirectiveRetirementError('directive_not_live',
          `directive request "${input.requestId}" is ${directiveStateName(row)} — only a live request can be abandoned`);
      }
      if (row.state !== input.expectedState) {
        throw new DirectiveRetirementError('request_mismatch',
          `directive request "${input.requestId}" is ${row.state}, not the expected ${input.expectedState} — read the row again`);
      }
      // Settlement owns a request with completion evidence.
      this.assertNoCompletedNativeRetirement(row);
      const delivered = this.latestJobEventByRequestId(row.jobId, 'job.delivered', row.requestId);
      if (delivered !== null) {
        throw new DirectiveRetirementError('terminal_receipt_present',
          `directive request "${input.requestId}" has a correlated job.delivered receipt at seq ${delivered.seq} — normal settlement owns it`);
      }
      const laneId = 'unavailable' in input.lane ? null : input.lane.id;
      const ownership = [...this.directiveOwnership(row, laneId ?? ''),
        ...input.routeBlockers.map((text) => ({ text, custody: isProducerCustodyUncertainty(text) ? 'unknown' as const : 'live' as const }))];
      const live = ownership.filter(({ custody }) => custody === 'live').map(({ text }) => text);
      if (live.length > 0) {
        throw new DirectiveRetirementError('live_work',
          `job "${row.jobId}" has a producer that is live or about to run — abandonment closes only unknown custody, never known live work`, live);
      }
      // Why retirement is refused: unknown custody only, read by the service.
      const refused = [
        ...('unavailable' in input.lane ? [input.lane.unavailable] : []),
        ...ownership.map(({ text }) => text),
      ];
      // A correlated admission binds first, as in retirement, so the audit
      // keeps the real turn instead of erasing it.
      let current = row;
      const sent = row.state === 'dispatching' ? this.latestJobEventByRequestId(row.jobId, 'silas.directive-sent', row.requestId) : null;
      if (sent !== null) {
        const minionId = (sent.payload as { minion_id?: unknown } | null)?.minion_id;
        if (typeof minionId !== 'string' || minionId === '') refused.push(`correlated admission evidence at seq ${sent.seq} has no minion identity`);
        else {
          try { current = this.recordDirectiveAdmission({ requestId: row.requestId, minionId, eventSeq: sent.seq }); }
          catch (error) { refused.push(`correlated admission evidence at seq ${sent.seq} is inconsistent: ${String(error)}`); }
        }
      }
      const admissionGap = this.directiveAdmissionIdentityGap(current);
      refused.push(...(admissionGap === null ? [] : [admissionGap]), ...this.directiveCustodyGaps(current));
      if (refused.length === 0) {
        throw new DirectiveRetirementError('retirement_available',
          `directive request "${input.requestId}" can be retired: the service verifies its cessation — ` +
            `use POST /api/silas/directives/${input.requestId}/retire with fresh readback instead`);
      }
      const ts = nowIso();
      this.db
        .prepare(`UPDATE pending_directives SET state = 'failed', fail_reason = ?, abandoned_at = ?, abandoned_by = ?, abandon_reason = ?, updated_at = ?
          WHERE request_id = ?`)
        .run(`abandoned by the owner; outcome and producer custody unknown: ${input.reason}`, ts, input.by, input.reason, ts, row.requestId);
      const phase = this.findPhaseHandoffByRequest({ jobId: row.jobId, requestId: row.requestId });
      if (phase?.state === 'awaiting') {
        this.closePhaseHandoff({ phaseId: phase.phaseId, reason: `directive request abandoned by the owner without completion: ${input.reason}` });
      }
      const event = this.appendEvent({
        kind: 'silas.directive-abandoned',
        jobId: row.jobId,
        payload: {
          request_id: row.requestId,
          by: input.by,
          reason: input.reason,
          expected_state: input.expectedState,
          admission_class: directiveAdmissionClass(current),
          admission_seq: current.admissionSeq,
          admission_minion: current.admissionMinion,
          lane_id: laneId,
          unknown: ['outcome', 'native effects', 'producer custody'],
          claims: 'none: no completion, no no-effect, no cessation',
          retirement_refused: refused,
        },
      });
      // What the abandonment ends: the request's own recovery debt (closed,
      // outcome unknown — no successor plan) and its unreconciled card.
      const debt = this.recoveryObligation(row.jobId, 'directive', row.requestId);
      if (debt !== null) {
        this.settleObligation({ obligationId: debt.id, settlement: { kind: 'cancelled',
          reason: `abandoned by the owner (event ${event.seq}); outcome unknown — no successor and no no-effect claim` } });
      }
      const card = this.findNotificationByKind(`silas.directive-unreconciled.${row.requestId}`, 'active');
      if (card?.routing === 'action-required') this.resolveNotificationById(card.id, 'directive-abandoned');
      const record = this.getDirective(row.requestId) as DirectiveRequestRecord;
      this.reopenStrandedRecoveryDebt(record);
      return { record, idempotent: false, event };
    });
  }

  /** The recorded owner abandonment that consumed this marker, if any. */
  rebriefAbandonment(markerId: string): RebriefAbandonmentRecord | null {
    const row = this.db.prepare('SELECT * FROM rebrief_abandonments WHERE marker_id = ?').get(markerId) as Row | undefined;
    return row === undefined ? null : { markerId: str(row.marker_id), jobId: str(row.job_id), payloadHash: str(row.payload_hash),
      baselineSeq: Number(row.baseline_seq), abandonedAt: str(row.abandoned_at), abandonedBy: str(row.abandoned_by),
      abandonReason: str(row.abandon_reason), eventSeq: Number(row.event_seq), holdReleasedBy: nstr(row.hold_released_by),
      holdReleasedAt: nstr(row.hold_released_at) };
  }

  /** Owner abandonment of a pending re-brief marker generation whose
   * producer custody is unknown: the marker's exit to binned. The contract
   * of `abandonLiveDirective`: a producer known to be live or about to run
   * refuses by name, unknown custody may be abandoned. The generation's
   * markers are deleted with one `silas.rebrief-abandoned` audit and an open
   * continuation hold; their recovery debts and card close as
   * outcome-unknown. It claims no completion, no effect and no cessation.
   * Owner only; idempotent by marker id. */
  abandonPendingRebrief(input: {
    markerId: string;
    expectedJobId: string;
    expectedPayloadHash: string;
    lane: { readonly id: string; readonly resolvedHead: string } | { readonly unavailable: string };
    routeBlockers: readonly string[];
    reason: string;
    by: string;
  }): { readonly record: RebriefAbandonmentRecord; readonly idempotent: boolean; readonly event: EventRecord } {
    if (input.by !== 'owner') throw new Error('re-brief abandonment is the owner\'s decision: by must be "owner"');
    if (input.reason.trim() === '') throw new Error('re-brief abandonment requires a reason');
    return this.transaction(() => {
      const prior = this.rebriefAbandonment(input.markerId);
      const marker = this.listPendingRebriefs().find((row) => row.id === input.markerId);
      const identity = prior ?? marker;
      if (identity === undefined) throw new RecordNotFound(`rebrief marker "${input.markerId}" not found`);
      if (identity.jobId !== input.expectedJobId || identity.payloadHash !== input.expectedPayloadHash) {
        throw new DirectiveRetirementError('request_mismatch',
          `rebrief marker "${input.markerId}" does not match the expected job and payload hash — read the marker again`);
      }
      if (prior !== null) return { record: prior, idempotent: true, event: this.getEvent(prior.eventSeq) as EventRecord };
      const found = marker as PendingRebriefRecord;
      const group = this.listPendingRebriefs({ jobId: found.jobId })
        .filter((row) => row.payloadHash === found.payloadHash && row.baselineSeq === found.baselineSeq);
      const landed = group.map((row) => ({ marker_id: row.id, kind: row.kind, landed: this.pendingRebriefReceipt(row) !== null }));
      if (PENDING_REBRIEF_KINDS.every((kind) => landed.some((row) => row.kind === kind && row.landed))) {
        throw new DirectiveRetirementError('terminal_receipt_present',
          `rebrief marker "${input.markerId}" has both guarded receipts — settlement of the pair owns it`);
      }
      const laneId = 'unavailable' in input.lane ? null : input.lane.id;
      const ownership = [...this.rebriefOwnership(found.id, laneId ?? ''),
        ...input.routeBlockers.map((text) => ({ text, custody: isProducerCustodyUncertainty(text) ? 'unknown' as const : 'live' as const }))];
      const live = ownership.filter(({ custody }) => custody === 'live').map(({ text }) => text);
      if (live.length > 0) {
        throw new DirectiveRetirementError('live_work',
          `job "${found.jobId}" has a producer that is live or about to run — abandonment closes only unknown custody, never known live work`, live);
      }
      const refused = [...('unavailable' in input.lane ? [input.lane.unavailable] : []), ...ownership.map(({ text }) => text)];
      if (refused.length === 0) {
        throw new DirectiveRetirementError('retirement_available',
          `rebrief marker "${input.markerId}" has verifiable cessation — use POST /api/silas/rebriefs/${input.markerId}/recover instead`);
      }
      const ts = nowIso();
      const remove = this.db.prepare('DELETE FROM pending_rebriefs WHERE id = ?');
      for (const row of group) remove.run(row.id);
      if (found.phaseId !== null) {
        const phase = this.getPhaseHandoff(found.phaseId);
        if (phase?.state === 'awaiting') this.closePhaseHandoff({ phaseId: found.phaseId, reason: `re-brief abandoned by the owner without completion: ${input.reason}` });
      }
      const event = this.appendEvent({ kind: 'silas.rebrief-abandoned', jobId: found.jobId, payload: {
        marker_id: input.markerId, markers: group, by: input.by, reason: input.reason, lane_id: laneId, guarded_event_landed: landed,
        unknown: ['outcome', 'native effects', 'producer custody'], claims: 'none: no completion, no no-effect, no cessation', retirement_refused: refused } });
      const insert = this.db.prepare(`INSERT INTO rebrief_abandonments (marker_id, job_id, payload_hash, baseline_seq, abandoned_at, abandoned_by, abandon_reason, event_seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const row of group) insert.run(row.id, row.jobId, row.payloadHash, row.baselineSeq, ts, input.by, input.reason, event.seq);
      for (const row of group) {
        const debt = this.recoveryObligation(row.jobId, 'rebrief', row.id);
        if (debt !== null) this.settleObligation({ obligationId: debt.id, settlement: { kind: 'cancelled',
          reason: `abandoned by the owner (event ${event.seq}); outcome unknown — no successor and no no-effect claim` } });
      }
      const card = this.findNotificationByKindAndRouting(`silas.rebrief-unreconciled.${found.jobId}`, 'action-required', 'active');
      if (card !== null) this.resolveNotificationById(card.id, 'rebrief-abandoned');
      return { record: this.rebriefAbandonment(input.markerId) as RebriefAbandonmentRecord, idempotent: false, event };
    });
  }

  /** Continuation holds created by retirements and owner abandonments,
   * oldest first. An OPEN hold (`releasedBy === null`) fences lane automation
   * until a fresh accepted directive/re-brief identity supersedes it (for an
   * abandonment hold, only one the owner accepts). */
  listDirectiveRecoveryHolds(opts: {
    jobId?: string;
    openOnly?: boolean;
    /** Projection-only isolation: report damaged debt loudly, then keep
     * healthy holds visible. Strict callers still throw on any bad row. */
    onMalformed?: (requestId: string, jobId: string, error: unknown) => void;
  } = {}): readonly DirectiveRecoveryHold[] {
    const where: string[] = ["(state = 'retired' OR abandoned_at IS NOT NULL)"];
    const markerWhere: string[] = ['1 = 1'];
    const params: unknown[] = [];
    if (opts.jobId !== undefined) {
      where.push('job_id = ?');
      markerWhere.push('job_id = ?');
      params.push(opts.jobId);
    }
    if (opts.openOnly === true) {
      where.push('hold_released_by IS NULL');
      markerWhere.push('hold_released_by IS NULL');
    }
    const rows = this.db
      .prepare(`SELECT * FROM pending_directives WHERE ${where.join(' AND ')}`)
      .all(...(params as never[])) as Row[];
    const holds = rows.flatMap((row): DirectiveRecoveryHold[] => {
      try {
        const record = this.directiveFromRow(row);
        const abandoned = record.abandonedAt !== null;
        const closedAt = abandoned ? record.abandonedAt : record.retiredAt;
        const closedBy = abandoned ? record.abandonedBy : record.retiredBy;
        const reason = abandoned ? record.abandonReason : record.retireReason;
        if (closedAt === null || closedBy === null || reason === null) {
          throw new Error(
            `pending_directives row "${record.requestId}" is ${abandoned ? 'abandoned' : 'retired'} but is missing its audit facts — ` +
              'the record is inconsistent and cannot be projected',
          );
        }
        return [{
          kind: abandoned ? 'abandoned' : 'retired',
          jobId: record.jobId,
          requestId: record.requestId,
          admissionClass: directiveAdmissionClass(record),
          retiredAt: closedAt,
          retiredBy: closedBy,
          reason,
          releasedBy: record.holdReleasedBy,
          releasedAt: record.holdReleasedAt,
        }];
      } catch (error) {
        if (opts.onMalformed === undefined) throw error;
        opts.onMalformed(str(row.request_id), str(row.job_id), error);
        return [];
      }
    });
    const markers = this.db
      .prepare(`SELECT * FROM rebrief_abandonments WHERE ${markerWhere.join(' AND ')}`)
      .all(...(params as never[])) as Row[];
    for (const row of markers) {
      holds.push({ kind: 'rebrief-abandoned', jobId: str(row.job_id), requestId: str(row.marker_id), admissionClass: 'admission-unknown',
        retiredAt: str(row.abandoned_at), retiredBy: str(row.abandoned_by), reason: str(row.abandon_reason),
        releasedBy: nstr(row.hold_released_by), releasedAt: nstr(row.hold_released_at) });
    }
    return holds.sort((left, right) => left.retiredAt.localeCompare(right.retiredAt) || left.requestId.localeCompare(right.requestId));
  }

  /** True while an unreleased retirement or abandonment hold fences the
   * job's automation. */
  hasOpenDirectiveRecoveryHold(jobId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS open FROM pending_directives WHERE job_id = ? AND (state = 'retired' OR abandoned_at IS NOT NULL) AND hold_released_by IS NULL
        UNION ALL SELECT 1 AS open FROM rebrief_abandonments WHERE job_id = ? AND hold_released_by IS NULL LIMIT 1`)
      .get(jobId, jobId) as Row | undefined;
    return row !== undefined;
  }

  /** Release every open hold for a job from a fresh, audited producer
   * acceptance (new directive request id or re-brief marker id). An open
   * owner-abandonment hold refuses the acceptance unless the owner accepts
   * it. Runs inside the accepting transaction; a replay never releases
   * again. */
  private releaseDirectiveRecoveryHolds(jobId: string, byIdentity: string, ownerAccepted = false): void {
    const holds = this.listDirectiveRecoveryHolds({ jobId });
    if (holds.length === 0) return;
    const abandoned = holds.filter((hold) => hold.releasedBy === null && hold.kind !== 'retired');
    if (abandoned.length > 0 && !ownerAccepted) {
      throw new LaneWriterConflictError(`job "${jobId}" is held by the owner's abandonment of ${abandoned.map((hold) => hold.requestId).join(', ')} — ` +
        'its producer custody is unknown: the lane stays held for the owner; ask the owner to resolve it (or bin the job) — no self-service release exists');
    }
    if (abandoned.length > 0 && ownerAccepted) {
      // The owner accepted, but an abandoned control's original producer may
      // still be live: releasing now would admit a fresh request whose own
      // dispatch later refuses on unproven cessation, stranding it. Refuse
      // while any cleanup blocker remains, naming each and pointing at
      // binning — the one exit that does not need that producer.
      const blockers = this.directiveCleanupBlockers(jobId);
      if (blockers.length > 0) {
        throw new LaneWriterConflictError(`job "${jobId}" is held by the owner's abandonment of ${abandoned.map((hold) => hold.requestId).join(', ')} and its original producer cleanup is still unproven (${blockers.join('; ')}) — ` +
          'the owner must bin the job instead: a fresh accepted request cannot dispatch while cessation is unproven');
      }
    }
    const ts = nowIso();
    this.db
      .prepare(
        "UPDATE pending_directives SET hold_released_by = ?, hold_released_at = ?, updated_at = ? WHERE job_id = ? AND (state = 'retired' OR abandoned_at IS NOT NULL) AND hold_released_by IS NULL",
      )
      .run(byIdentity, ts, ts, jobId);
    this.db.prepare('UPDATE rebrief_abandonments SET hold_released_by = ?, hold_released_at = ? WHERE job_id = ? AND hold_released_by IS NULL').run(byIdentity, ts, jobId);
    // Exact durable ordering, not wall-clock age. This is an accepted
    // authority handoff, never a work-delivery or retirement receipt.
    this.appendEvent({ kind: 'silas.directive-recovery-handoff', jobId,
      payload: { request_id: byIdentity, retired_request_ids: holds.map((hold) => hold.requestId),
        ...(abandoned.length === 0 ? {} : { owner_accepted_abandoned_ids: abandoned.map((hold) => hold.requestId) }) } });
  }

  /** A wait must not carry its saved prompt across a fresh retirement
   * handoff. Unknown/missing ordered evidence is NOT permission and stays
   * a blocker; only proven superseded debt can be ignored. */
  providerWaitRetirementIdentity(wait: Pick<ProviderWaitRecord, 'jobId' | 'id'>): 'current' | 'superseded' | 'unknown' {
    if (wait.jobId === null) return 'current';
    const holds = this.listDirectiveRecoveryHolds({ jobId: wait.jobId });
    if (holds.length === 0) return 'current';
    if (holds.some((hold) => hold.releasedBy === null)) return 'unknown';
    const handoff = this.latestJobEvent(wait.jobId, 'silas.directive-recovery-handoff');
    const payload = (typeof handoff?.payload === 'object' && handoff.payload !== null ? handoff.payload : {}) as Record<string, unknown>;
    const retiredIds = payload['retired_request_ids'];
    if (handoff === null || typeof payload['request_id'] !== 'string' ||
        !Array.isArray(retiredIds) || !holds.every((hold) => retiredIds.includes(hold.requestId))) return 'unknown';
    const values = [{ key: 'id', value: wait.id }];
    if (!this.hasJobEventWithPayloadValues(wait.jobId, ['provider.wait-established'], values, 0)) return 'unknown';
    return this.hasJobEventWithPayloadValues(wait.jobId, ['provider.wait-established'], values, handoff.seq)
      ? 'current' : 'superseded';
  }

  directiveCurrentAuthority(jobId: string): { readonly workRevision: number; readonly contractSha256: string; readonly authorityEpoch: number } {
    if (this.getJob(jobId) === null) throw new RecordNotFound(`job "${jobId}" not found`);
    return { workRevision: requiredWorkRevision(this.listJobAmendments(jobId)),
      contractSha256: this.effectiveContract(jobId)?.contractSha256 ?? createHash('sha256').update('').digest('hex'),
      authorityEpoch: this.directiveRecoveryEpoch(jobId) };
  }

  private assertFreshRecoveryContract(jobId: string, revision: number | undefined, hash: string | undefined): void {
    const currentHash = this.effectiveContract(jobId)?.contractSha256 ?? createHash('sha256').update('').digest('hex');
    if (!Number.isSafeInteger(revision) || revision !== requiredWorkRevision(this.listJobAmendments(jobId)) || hash !== currentHash) {
      throw new DirectiveCheckpointError('fresh successor approved revision/contract expectations are stale or missing');
    }
  }

  /** Native control epoch, not clock age or a caller's authority label. */
  directiveRecoveryEpoch(jobId: string): number {
    this.listDirectiveRecoveryHolds({ jobId }); // strict audit validation
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq), 0) AS epoch FROM events
      WHERE job_id = ? AND (${DIRECTIVE_CONTROL_SQL})`).get(jobId) as Row;
    return row['epoch'] as number;
  }

  private assertNoProviderProducer(jobId: string, exempt?: (kind: string) => boolean): void {
    const admissions = this.listJobAdmissions(jobId).filter((kind) => (kind.startsWith('provider ') || kind.startsWith('property ')) && exempt?.(kind) !== true);
    const claims = this.listOpenProviderWaitsForJob(jobId)
      .filter((wait) => wait.status === 'claimed')
      .map((wait) => `claimed provider continuation ${wait.id}`);
    if (admissions.length > 0 || claims.length > 0) {
      throw new AmbiguousDirectiveError(`job "${jobId}" still has provider ownership (${[...admissions, ...claims].join(', ')}) — wait for native cessation before a fresh directive or re-brief`);
    }
  }

  /** The in-flight process-local admissions for one job (the same registry
   * every producer reserves before its first await). Exposed read-only so
   * guarded operations can refuse while any producer is between reservation
   * and registration. */
  listJobAdmissions(jobId: string): readonly string[] {
    return [...this.activeJobAdmissions].filter((entry) => entry.jobId === jobId).map((entry) => entry.kind);
  }

  /** Open provider-recovery ownership for one job: a waiting/claimable or
   * claimed continuation is live producer evidence and forbids retiring a
   * request on that lane. */
  listOpenProviderWaitsForJob(jobId: string): readonly ProviderWaitRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM provider_waits WHERE job_id = ? AND status IN ('waiting','recovered-pending','claimed')
         ORDER BY created_at, id`,
      )
      .all(jobId) as Row[];
    return rows.map((row) => this.providerWaitFromRow(row)).filter((wait) => {
      if (wait.status !== 'claimed') return this.providerWaitRetirementIdentity(wait) !== 'superseded';
      // Superseding permission cannot prove a spawned producer ceased.
      // Only a closed turn or acknowledged pre-turn disposal is terminal;
      // spawn/cleanup errors remain unknown even after a newer handoff.
      return !this.hasJobEventWithPayloadValues(jobId, ['provider.continuation-completed'], [{ key: 'wait_id', value: wait.id }], 0) &&
        !['turn', 'authorization'].some((stage) => this.hasJobEventWithPayloadValues(jobId, ['provider.continuation-failed'],
          [{ key: 'wait_id', value: wait.id }, { key: 'stage', value: stage }], 0));
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

  /** Append-only review history plus a transactional CAS head. Frozen
   * approval identities commit before any individual pipeline enqueue. */
  recordIntakeReview(record: IntakeReviewRecord): void {
    this.transaction(() => {
      const head = this.getIntakeReview(record.repoPath, record.intakeId);
      const replay = this.getIntakeReview(record.repoPath, record.intakeId, record.token);
      if (replay !== null) {
        if (canonicalIntake(replay) !== canonicalIntake(record)) throw new IntakeError('intake_acceptance_conflict', 'Review token already binds different bytes', 409);
        return;
      }
      if ((head?.token ?? null) !== record.previousToken) throw new IntakeError('intake_stale_review', 'Review changed or was rejected; read back before deciding', 409);
      const rejected = this.db.prepare("SELECT token FROM intake_reviews WHERE repo_path = ? AND intake_id = ? AND revision_id = ? AND status = 'rejected'").get(record.repoPath, record.intakeId, record.revisionId);
      if (rejected !== undefined) throw new IntakeError('intake_stale_review', 'Rejected revisions cannot be reopened; create a new revision', 409);
      if (record.status !== 'reviewed' && (head?.status !== 'reviewed' || head.revisionId !== record.revisionId)) throw new IntakeError('intake_stale_review', 'Only the exact currently reviewed revision can be approved or rejected', 409);
      if (record.status === 'reviewed' && head?.revisionId === record.revisionId && head.status !== 'reviewed') throw new IntakeError('intake_stale_review', 'Rejected or accepted revisions cannot be reopened; create a new revision', 409);
      const approved = this.db.prepare("SELECT token FROM intake_reviews WHERE repo_path = ? AND intake_id = ? AND revision_id = ? AND status = 'approved'").get(record.repoPath, record.intakeId, record.revisionId);
      if (approved !== undefined) throw new IntakeError('intake_acceptance_conflict', 'This revision already has an immutable accepted selection; retry its original approval', 409);
      const serialized = canonicalIntake(record);
      this.verifyIntakeHistoryBudget(record.repoPath, record.intakeId, Buffer.byteLength(serialized));
      this.db.prepare('INSERT INTO intake_reviews(token, repo_path, intake_id, revision_id, status, record) VALUES (?, ?, ?, ?, ?, ?)').run(record.token, record.repoPath, record.intakeId, record.revisionId, record.status, serialized);
      this.db.prepare('INSERT INTO intake_review_heads(repo_path, intake_id, token) VALUES (?, ?, ?) ON CONFLICT(repo_path, intake_id) DO UPDATE SET token = excluded.token').run(record.repoPath, record.intakeId, record.token);
      this.appendEvent({ kind: `intake.${record.status}`, payload: { intake_id: record.intakeId, revision_id: record.revisionId, token: record.token, selected: record.selected } });
    });
  }

  /** Bound total retained verification work before loading/parsing/hashing any
   * decision. Over-budget history stays intact for restoration/inspection. */
  private verifyIntakeHistoryBudget(repoPath: string, intakeId: string, additionalBytes = 0): void {
    const size = this.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(record AS BLOB))), 0) AS bytes FROM intake_reviews WHERE repo_path = ? AND intake_id = ?').get(repoPath, intakeId) as { count: number; bytes: number };
    if (size.count + (additionalBytes > 0 ? 1 : 0) > 4096) throw new IntakeError('intake_storage_error', 'Intake history reached its 4096-decision verification bound; create a new intake for further revisions, retaining this history', 500);
    if (size.bytes + additionalBytes > 8 * 1024 * 1024) throw new IntakeError('intake_storage_error', 'Intake history reached its 8-MiB byte verification bound; create a new intake for further revisions, retaining this history', 500);
  }

  /** The one approved decision of an intake revision, if any (#429): an
   * identical approval retry enqueues its frozen entries, not a re-render. */
  getApprovedIntakeReview(repoPath: string, intakeId: string, revisionId: string): IntakeReviewRecord | null {
    this.verifyIntakeHistoryBudget(repoPath, intakeId);
    const row = this.db.prepare("SELECT token FROM intake_reviews WHERE repo_path = ? AND intake_id = ? AND revision_id = ? AND status = 'approved'").get(repoPath, intakeId, revisionId) as { token: string } | undefined;
    return row === undefined ? null : this.getIntakeReview(repoPath, intakeId, row.token);
  }

  /** Every approved decision of an intake, oldest first (#429): a heist an
   * earlier revision accepted satisfies a later revision's prerequisite. */
  listApprovedIntakeReviews(repoPath: string, intakeId: string): readonly IntakeReviewRecord[] {
    this.verifyIntakeHistoryBudget(repoPath, intakeId);
    const rows = this.db.prepare("SELECT token FROM intake_reviews WHERE repo_path = ? AND intake_id = ? AND status = 'approved' ORDER BY rowid").all(repoPath, intakeId) as { token: string }[];
    return rows.map(({ token }) => this.getIntakeReview(repoPath, intakeId, token)!);
  }

  getIntakeReview(repoPath: string, intakeId: string, token?: string): IntakeReviewRecord | null {
    this.verifyIntakeHistoryBudget(repoPath, intakeId);
    const row = token === undefined
      ? this.db.prepare('SELECT r.* FROM intake_review_heads h LEFT JOIN intake_reviews r ON r.token = h.token WHERE h.repo_path = ? AND h.intake_id = ?').get(repoPath, intakeId)
      : this.db.prepare('SELECT * FROM intake_reviews WHERE token = ? AND repo_path = ? AND intake_id = ?').get(token, repoPath, intakeId);
    if (row === undefined) {
      if (token === undefined && this.db.prepare('SELECT token FROM intake_reviews WHERE repo_path = ? AND intake_id = ? LIMIT 1').get(repoPath, intakeId) !== undefined) throw new IntakeError('intake_storage_error', 'Review history exists without its coordination head; restore the intake ledger before deciding', 500);
      return null;
    }
    try {
      let ancestor: Row | undefined = row as Row;
      let first: IntakeReviewRecord | undefined;
      const visited = new Set<string>();
      // Iterative, bounded ancestry verification: a valid head cannot conceal
      // a deleted rejection or a damaged predecessor beneath it.
      while (ancestor !== undefined) {
        if (visited.size >= 4096) throw new Error('Review ancestry exceeds 4096 decisions');
        const record = JSON.parse(str(ancestor.record)) as IntakeReviewRecord;
        const { token: savedToken, ...body } = record;
        if (visited.has(savedToken)) throw new Error('Cyclic review ancestry');
        if (savedToken !== intakeDigest(canonicalIntake(body)) || savedToken !== ancestor.token || record.repoPath !== repoPath || record.intakeId !== intakeId || ancestor.repo_path !== repoPath || ancestor.intake_id !== intakeId || record.revisionId !== ancestor.revision_id || record.status !== ancestor.status) throw new Error('Review bytes or binding are damaged');
        visited.add(savedToken); first ??= record;
        if (record.previousToken === null) break;
        if (typeof record.previousToken !== 'string' || !/^[a-f0-9]{64}$/u.test(record.previousToken)) throw new Error('Invalid review predecessor');
        ancestor = this.db.prepare('SELECT * FROM intake_reviews WHERE token = ? AND repo_path = ? AND intake_id = ?').get(record.previousToken, repoPath, intakeId) as Row | undefined;
        if (ancestor === undefined) throw new Error('Missing review ancestor; restore the intake ledger');
      }
      return first!;
    } catch (error) { throw new IntakeError('intake_storage_error', `Cannot verify durable intake decision: ${String(error)}`, 500); }
  }

  /** Indexed durable enqueue witness; no event payload list is loaded. */
  hasPipelineEnqueueEvidence(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM events WHERE kind = 'pipeline.enqueued' AND json_valid(payload) AND json_extract(payload, '$.entry_id') = ? LIMIT 1").get(id) !== undefined;
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
      jobDeliveredOf: (jobId) => this.latestCandidateDelivery(jobId) !== null,
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
    const retireExpectedStateRaw = nstr(row.retire_expected_state);
    if (retireExpectedStateRaw !== null && retireExpectedStateRaw !== 'dispatching' && retireExpectedStateRaw !== 'admitted') {
      throw new Error(
        `pending_directives row "${str(row.request_id)}" has unknown retirement expected state "${retireExpectedStateRaw}"`,
      );
    }
    const requestId = str(row.request_id);
    const retireInteger = (column: string): number | null => {
      const value = row[column];
      if (value === null || value === undefined) return null;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new Error(`pending_directives row "${requestId}" has malformed ${column}`);
      }
      return value;
    };
    const retireExpectedContractSha256 = nstr(row.retire_expected_contract_sha256);
    if (retireExpectedContractSha256 !== null && !/^[a-f0-9]{64}$/u.test(retireExpectedContractSha256)) {
      throw new Error(`pending_directives row "${requestId}" has malformed retire_expected_contract_sha256`);
    }
    const retireExpectedObligationState = nstr(row.retire_expected_obligation_state);
    if (retireExpectedObligationState !== null && !isObligationState(retireExpectedObligationState)) {
      throw new Error(`pending_directives row "${requestId}" has unknown retire_expected_obligation_state "${retireExpectedObligationState}"`);
    }
    const nativeTarget = row.native_target == null ? null : JSON.parse(str(row.native_target)) as DirectiveRequestRecord['nativeTarget'];
    const nativeBinding = row.native_binding == null ? null : JSON.parse(str(row.native_binding)) as DirectiveNativeBinding;
    if (nativeTarget !== null && (!nativeTarget.agentId || !nativeTarget.sessionFile)) throw new DirectiveCheckpointError('malformed directive native target');
    if (nativeBinding !== null) {
      validateDirectiveIdentity(nativeBinding.identity);
      if (nativeBinding.identity.requestId !== row.request_id || nativeBinding.identity.jobId !== row.job_id || nativeBinding.identity.payloadHash !== row.payload_hash ||
          nativeBinding.identity.workRevision !== row.work_revision || nativeBinding.identity.authorityEpoch !== row.authority_epoch ||
          nativeBinding.agentId !== nativeTarget?.agentId || nativeBinding.sessionFile !== nativeTarget?.sessionFile || !nativeBinding.userEntryId) throw new DirectiveCheckpointError('malformed/mismatched directive native admission readback');
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
      retiredAt: nstr(row.retired_at),
      retiredBy: nstr(row.retired_by),
      retireReason: nstr(row.retire_reason),
      retireFingerprint: nstr(row.retire_fingerprint),
      retireExpectedState: retireExpectedStateRaw,
      retireExpectedHead: nstr(row.retire_expected_head),
      retireExpectedGeneration: retireInteger('retire_expected_generation'),
      retireExpectedPlanRevision: retireInteger('retire_expected_plan_revision'),
      retireExpectedObligationState,
      retireExpectedAuthorityEpoch: retireInteger('retire_expected_authority_epoch'),
      retireExpectedWorkRevision: retireInteger('retire_expected_work_revision'),
      retireExpectedContractSha256,
      abandonedAt: nstr(row.abandoned_at),
      abandonedBy: nstr(row.abandoned_by),
      abandonReason: nstr(row.abandon_reason),
      holdReleasedBy: nstr(row.hold_released_by),
      holdReleasedAt: nstr(row.hold_released_at),
      workRevision: row.work_revision === null || row.work_revision === undefined ? null : Number(row.work_revision),
      requestKind: row.request_kind == null ? null : str(row.request_kind) as DirectiveRequestRecord['requestKind'],
      sourceContext: row.source_context == null ? null : JSON.parse(str(row.source_context)) as DirectiveRequestRecord['sourceContext'],
      authorityEpoch: row.authority_epoch == null ? null : Number(row.authority_epoch),
      contractSnapshot: nstr(row.contract_snapshot),
      contractSha256: nstr(row.contract_sha256),
      dispatchStartedAt: nstr(row.dispatch_started_at),
      nativeTarget,
      nativeBinding,
      recoveryCheckpoint: nstr(row.recovery_checkpoint),
      recoveryDecision: row.recovery_decision == null ? null : JSON.parse(str(row.recovery_decision)) as DirectiveRequestRecord['recoveryDecision'],
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
    let payload: { note?: unknown; briefing?: unknown; rule_id?: unknown; source_round_id?: unknown; source?: unknown; work_revision?: unknown };
    try {
      payload = JSON.parse(str(row.payload)) as {
        note?: unknown; briefing?: unknown; rule_id?: unknown; source_round_id?: unknown; source?: unknown; work_revision?: unknown;
      };
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
      ruleId: nstr(payload.rule_id),
      sourceRoundId: nstr(payload.source_round_id),
      source: nstr(payload.source),
      workRevision: typeof payload.work_revision === 'number' && Number.isSafeInteger(payload.work_revision) &&
        payload.work_revision >= 0 ? payload.work_revision : null,
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

  private mailboxProjectionCache: { readonly changes: number; readonly version: number; readonly items: readonly MailboxItem[]; readonly nextCheckAt: number } | null = null;

  private mailboxDatabaseRevision(): { readonly changes: number; readonly version: number } {
    const changes = Number((this.db.prepare('SELECT total_changes() AS changes').get() as Row).changes);
    const version = Number((this.db.prepare('PRAGMA data_version').get() as Row).data_version);
    return { changes, version };
  }

  /** Event watermarks alone cannot detect source writes that emit no event. */
  private mailboxSourceProjection(now: number): readonly MailboxItem[] {
    const revision = this.mailboxDatabaseRevision();
    const cache = this.mailboxProjectionCache;
    if (cache !== null && now < cache.nextCheckAt && cache.changes === revision.changes && cache.version === revision.version) return cache.items;
    let nextCheckAt = Infinity;
    const items = projectMailbox(this, now, (at) => { nextCheckAt = Math.min(nextCheckAt, at); });
    this.mailboxProjectionCache = { ...revision, items, nextCheckAt };
    return items;
  }

  /** Adopt an authenticated pre-GH313 incident wait only when its report source stayed unchanged. */
  private migrateLegacyReportCustody(source: MailboxItem, previous: ReadonlyMap<string, MailboxItem>, now: string): MailboxItem | null {
    if (source.kind !== 'incident' || source.reasons.length !== 1) return null;
    const kind = source.reasons[0]!.label;
    const jobId = /^silas\.report-handback\.(.+)$/u.exec(kind)?.[1];
    if (jobId === undefined) return null;
    const current = this.latestReportHandbackNotification(jobId);
    const job = this.getJob(jobId);
    const debt = this.findReportObligation(jobId);
    if (current === null || job === null || debt === null) return null;
    const candidates: { readonly item: MailboxItem; readonly seq: number }[] = [];
    let latestRulingSeq = 0;
    for (const old of previous.values()) {
      if (old.kind !== 'incident' || old.notificationIds.length !== 1 || !old.reasons.some((reason) => reason.label === kind)) continue;
      const row = this.getNotification(old.notificationIds[0]!);
      if (row === null || row.kind !== kind) continue;
      const key = `notification:${row.id}`;
      if (old.id !== `incident:${mailboxBasis(key)}`) continue;
      const ruling = this.db.prepare(`SELECT seq, payload FROM events WHERE kind = 'mailbox.disposition'
        AND json_extract(payload, '$.id') = ? ORDER BY seq DESC LIMIT 1`).get(old.id) as Row | undefined;
      if (ruling === undefined) continue;
      // Any newer report-wide ruling wins, including explicit needs-gru/resolved rulings.
      latestRulingSeq = Math.max(latestRulingSeq, Number(ruling.seq));
      const saved = old.disposition;
      if (old.subject !== source.subject || saved?.state !== 'waiting' || saved.sourceObligationId !== undefined
        || saved.basis !== old.basis || row.detail !== current.detail || row.severity !== current.severity) continue;
      const legacyReason = mailboxBasis([mailboxBasis([key, mailboxBasis([key, row.kind, row.detail, row.severity])]), null]);
      if (old.basis !== mailboxBasis([[source.reasons[0]!.signal, legacyReason]])) continue;
      if (JSON.stringify((JSON.parse(str(ruling.payload)) as { disposition: MailboxDisposition }).disposition) !== JSON.stringify(saved)) continue;
      // Mailbox receipts/dispositions are metadata, never source mutations. Other later job writes
      // remain unprovable without an old source fingerprint and must restore attention.
      if (Date.parse(job.updatedAt) > Date.parse(saved.recordedAt) || Date.parse(debt.updatedAt) > Date.parse(saved.recordedAt)
        || this.db.prepare(`SELECT 1 FROM events WHERE job_id = ? AND seq > ?
          AND kind NOT IN ('mailbox.disposition', 'mailbox.received', 'mailbox.report-custody-migrated') LIMIT 1`)
          .get(jobId, Number(ruling.seq)) !== undefined) continue;
      try { validateMailboxDisposition(this, old, saved, now, true); }
      catch (error) { if (!(error instanceof MailboxConflictError)) throw error; continue; }
      candidates.push({ item: old, seq: Number(ruling.seq) });
    }
    const old = candidates.find((candidate) => candidate.seq === latestRulingSeq)?.item;
    if (old === undefined) return null;
    const disposition = { ...old.disposition!, basis: source.basis };
    this.appendEvent({ kind: 'mailbox.report-custody-migrated', payload: {
      from_id: old.id, from_basis: old.basis, id: source.id, basis: source.basis,
      original_disposition: old.disposition, notification_id: current.id, obligation_id: debt.id,
    } });
    return { ...old, id: source.id, basis: source.basis, disposition };
  }

  /** Additive mailbox metadata only: this path never changes operational rows. */
  reconcileMailbox(now = nowIso()): readonly MailboxItem[] {
    return this.transaction(() => {
      const projected = this.mailboxSourceProjection(Date.parse(now));
      const previous = new Map(this.listMailboxItems().map((item) => [item.id, item]));
      const liveIds = new Set(projected.map((item) => item.id));
      const items = projected.map((source): MailboxItem => {
        const old = previous.get(source.id) ?? this.migrateLegacyReportCustody(source, previous, now) ?? undefined;
        const saved = old?.disposition?.sourceObligationId === undefined ? old?.disposition ?? null : null;
        let supported = saved?.basis === source.basis;
        if (supported && saved !== null) {
          try { validateMailboxDisposition(this, source, saved, now, true); }
          catch (error) { if (!(error instanceof MailboxConflictError)) throw error; supported = false; }
        }
        const disposition = supported ? saved : source.disposition ?? saved;
        const applicable = supported ? saved : source.disposition;
        const due = applicable !== null && applicable.sourceObligationId === undefined && ((applicable.recheckAt !== null && Date.parse(applicable.recheckAt) <= Date.parse(now))
          || (source.followUpAt ?? []).some((at) => Date.parse(at) > Date.parse(applicable.recordedAt) && Date.parse(at) <= Date.parse(now)));
        const state = applicable !== null && !due ? applicable.state : 'needs-gru';
        const baseAttentionKey = `${source.id}@${mailboxBasis([source.basis, applicable?.recordedAt ?? (saved?.basis === source.basis ? [saved.recordedAt, 'unsupported'] : null), due ? applicable?.recheckAt : null, (source.followUpAt ?? []).filter((at) => Date.parse(at) <= Date.parse(now))])}`;
        const receipt = old?.receipt ?? null;
        // Delivery without a next action owes a bounded recheck. Retain its
        // incarnation through the grace window; only due unhandled debt gets
        // a new key, so restart and duplicate events cannot create a storm.
        const sameAttention = receipt?.basis === source.basis && (receipt.attentionKey === baseAttentionKey || receipt.attentionKey.startsWith(`${baseAttentionKey}:unhandled:`));
        const attentionKey = state === 'needs-gru' && sameAttention
          ? Date.parse(now) - Date.parse(receipt.receivedAt) >= 300_000
            ? `${baseAttentionKey}:unhandled:${receipt.receivedAt}` : receipt.attentionKey
          : baseAttentionKey;
        const references = [...new Map([...source.references, ...(applicable?.references ?? [])].map((ref) => [`${ref.kind}:${ref.id}`, ref])).values()];
        return { ...source, references, disposition, state, owner: applicable?.owner ?? 'gru', receipt: old?.receipt ?? null, attentionKey };
      });
      for (const old of previous.values()) {
        if (!liveIds.has(old.id)) items.push({ ...old, state: 'resolved', restrictions: [...old.restrictions.filter((value) => value !== 'Source evidence no longer raises attention'), 'Source evidence no longer raises attention'] });
      }
      for (const item of items) {
        const encoded = JSON.stringify(item);
        if (JSON.stringify(previous.get(item.id)) === encoded) continue;
        this.db.prepare(`INSERT INTO gru_mailbox (id, item, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET item = excluded.item, updated_at = excluded.updated_at`).run(item.id, encoded, now);
      }
      if (this.mailboxProjectionCache !== null) this.mailboxProjectionCache = { ...this.mailboxProjectionCache, ...this.mailboxDatabaseRevision() };
      return items.sort((a, b) => a.id.localeCompare(b.id));
    });
  }

  listMailboxItems(): readonly MailboxItem[] {
    return (this.db.prepare('SELECT item FROM gru_mailbox ORDER BY id').all() as Row[]).map((row) => JSON.parse(str(row.item)) as MailboxItem);
  }

  recordMailboxDisposition(id: string, input: unknown, now = nowIso()): MailboxItem {
    return this.transaction(() => {
      const item = this.reconcileMailbox(now).find((candidate) => candidate.id === id);
      if (item === undefined) throw new RecordNotFound(`mailbox item "${id}" not found`);
      const disposition = validateMailboxDisposition(this, item, input, now, true);
      if (item.disposition !== null && JSON.stringify({ ...item.disposition, recordedAt: null }) === JSON.stringify({ ...disposition, recordedAt: null })) return item;
      validateMailboxDisposition(this, item, input, now);
      const updated: MailboxItem = { ...item, disposition };
      this.db.prepare('UPDATE gru_mailbox SET item = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(updated), now, id);
      this.appendEvent({ kind: 'mailbox.disposition', jobId: item.jobId, payload: { id, disposition } });
      return this.reconcileMailbox(now).find((candidate) => candidate.id === id)!;
    });
  }

  recordMailboxReceipt(id: string, basis: string, source: 'chat' | 'wake', deliveryId: string, now = nowIso()): void {
    return this.transaction(() => {
      const item = this.reconcileMailbox(now).find((candidate) => candidate.id === id);
      if (item === undefined || item.basis !== basis) throw new MailboxConflictError('mailbox receipt basis is stale');
      if (item.receipt?.deliveryId === deliveryId && item.receipt.source === source) return;
      this.recordCapturedMailboxReceipt({ deliveryKey: `mailbox:${mailboxBasis(item.attentionKey)}`, id, jobId: item.jobId,
        basis, attentionKey: item.attentionKey, reasons: item.reasons, notificationIds: item.notificationIds }, source, deliveryId, now, now);
    });
  }

  /** Historical evidence is durable even when it no longer matches the live attention incarnation. */
  recordCapturedMailboxReceipt(delivery: MailboxDelivery, source: 'chat' | 'wake', deliveryId: string, receivedAt: string, now = nowIso()): void {
    if (source !== 'chat' && source !== 'wake') throw new Error('mailbox receipt source must be chat or wake');
    if (deliveryId.trim() === '') throw new Error('mailbox deliveryId must be nonblank');
    if (!isRealIsoUtcTimestamp(receivedAt) || new Date(receivedAt).toISOString() !== receivedAt || Date.parse(receivedAt) > Date.parse(now)) {
      throw new Error('mailbox receivedAt must be a canonical ISO timestamp no later than receipt recovery');
    }
    if (delivery.deliveryKey !== `mailbox:${mailboxBasis(delivery.attentionKey)}` || !delivery.attentionKey.startsWith(`${delivery.id}@`)) {
      throw new Error('mailbox captured delivery identity does not match its attention incarnation');
    }
    return this.transaction(() => {
      const receipt = { basis: delivery.basis, source, deliveryId, receivedAt, attentionKey: delivery.attentionKey };
      const prior = this.db.prepare(`SELECT payload FROM events WHERE kind = 'mailbox.received'
        AND json_extract(payload, '$.id') = ? AND json_extract(payload, '$.receipt.source') = ?
        AND json_extract(payload, '$.receipt.deliveryId') = ? AND json_extract(payload, '$.receipt.attentionKey') = ? LIMIT 1`)
        .get(delivery.id, source, deliveryId, delivery.attentionKey) as Row | undefined;
      if (prior !== undefined) {
        const payload = JSON.parse(str(prior.payload)) as { readonly receipt: MailboxReceipt; readonly delivery?: MailboxDelivery };
        const sameReceipt = payload.receipt.basis === receipt.basis && payload.receipt.source === source
          && payload.receipt.deliveryId === deliveryId && payload.receipt.receivedAt === receivedAt && payload.receipt.attentionKey === delivery.attentionKey;
        const fingerprint = (value: MailboxDelivery): string => mailboxBasis([value.deliveryKey, value.id, value.jobId, value.basis, value.attentionKey,
          value.reasons.map((reason) => [reason.signal, reason.label, reason.basis]), value.notificationIds]);
        if (!sameReceipt || (payload.delivery !== undefined && fingerprint(payload.delivery) !== fingerprint(delivery))) {
          throw new MailboxConflictError('mailbox delivery replay changed captured evidence or original delivery time');
        }
        return;
      }
      const item = this.reconcileMailbox(now).find((candidate) => candidate.id === delivery.id);
      if (item !== undefined && item.basis === delivery.basis && item.attentionKey === delivery.attentionKey
        && (item.receipt === null || Date.parse(item.receipt.receivedAt) <= Date.parse(receivedAt))) {
        this.db.prepare('UPDATE gru_mailbox SET item = ?, updated_at = ? WHERE id = ?').run(JSON.stringify({ ...item, receipt }), now, item.id);
      }
      this.appendEvent({ kind: 'mailbox.received', jobId: delivery.jobId, payload: { id: delivery.id, receipt, reasons: delivery.reasons, delivery } });
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
      decision: parseStoredNotificationDecision(nstr(row.decision_json)),
      decidedAt: nstr(row.decided_at),
      decidedBy: nstr(row.decided_by),
      decidedOption: nstr(row.decided_option),
    };
  }
}
