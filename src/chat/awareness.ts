import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NotifyWakeMode, QuietHours, WakeMinSeverity } from '../config.js';
import { DECISION_SURFACE_ESCALATION_TRIAGE, escalationTriageDecisionRequest } from '../decisions/questions.js';
import type { DecisionMemoryFacts, EscalationFacts } from '../decisions/questions.js';
import type { DecisionService } from '../decisions/types.js';
import type { BusEvent, EventBus } from '../events/bus.js';
import { isJobTerminal } from '../ledger/states.js';
import type { LogLevel } from '../logger.js';
import type { DecisionRecord, EventRecord, LedgerApi, NotificationRecord } from '../ledger/api.js';
import {
  incidentBasisOf,
  incidentKeyOf,
  incidentSignalOf,
  incidentSubjectOf,
  isHardFloorRow,
} from './incident.js';
import { WakePolicy, type WakeCandidate, type WakeDecision } from './wake-policy.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Gru awareness (dispatch briefing 2026-09-22): escalations and lane
 * digests must reach the chat brain.
 *
 * Two mechanisms, one boundary:
 *
 *   1. PASSIVE INJECTION — before each Gru turn (a user prompt, or a
 *      session wake under the [chat] notify_wake policy) `prepare()` renders
 *      a compact, bounded block: unacknowledged action-required
 *      notifications plus a one-line-per-event digest of what happened on
 *      the ledger since the previous delivered block. The chat server
 *      prepends it to the prompt and calls `commit()` only after the prompt
 *      was accepted, so a failed delivery never eats context. The open
 *      queues are sampled through a durable rotation offset (GH-109): each
 *      passive block consumes one bounded page per queue, so a sustained
 *      backlog deeper than the block still reaches the brain in bounded
 *      cycles and a fresh cycle leads with the newest rows.
 *
 *   2. WAKE POLICY — `onBusEvent` watches notification events; with
 *      notify_wake = 'action-required' (the default since the owner ruling
 *      2026-09-23) a machine-attention row OPENS a turn through the wake
 *      sink so a critical alert is acted on without the user pinging.
 *      The decision (routing/severity gate, per-id dedupe, minimum
 *      interval, quiet hours) lives in `wake-policy.ts`; this layer owns
 *      batching (candidates inside the window coalesce into ONE trailing
 *      wake), persistence, and the timer that releases a deferred wake.
 *      Every opened wake is logged and appended to the ledger as
 *      `gru.wake` so the board / self-heal trackers can count them.
 *
 *      Issue #219 reworks the wake on three axes. INCIDENT DEDUPE: the
 *      policy claims incident KEYS (see incident.ts), so a re-detected
 *      incident under a new notification ID opens no second wake; the
 *      avoidance is recorded as a `gru.wake-deferred` event (reason
 *      'duplicate'). HOLD-COVERED DEFERRAL: when the decision-memory
 *      trigger query (#218 `coveringDecision`) reports the incident
 *      covered by an active, basis-matched decision, the wake DEFERS —
 *      the notification stays visible exactly as today, the deferral
 *      records the decision id and a recheck (durable in the decision
 *      row; the timer bound is 60 min), and the incident becomes
 *      wake-eligible again when the recheck passes or the basis changes.
 *      Hard floors (breakers, provider walls, `needs-owner`) never defer;
 *      `[chat] wake_defer_covered = false` restores today's behavior.
 *      RECEIPT-FIRST (#112): the `gru.wake` ledger append commits BEFORE
 *      the dedupe state; a failed append parks the delivered batch as
 *      unreceipted (never re-prompted, never re-woken) and boot
 *      reconciliation re-appends the missing receipt exactly once.
 *      BOUNDED FAILURE RECOVERY (#115): an accepted turn that fails later
 *      re-arms its incidents as pending with at most two retries on the
 *      existing backoff; persistent failure produces exactly one
 *      truthful `needs-owner` escalation per incident.
 *
 * The event cursor and the owner-directed morning watermark are separately
 * durable under the chat dir; wake turns never consume the owner's digest.
 * Content is derived from the ledger only — an acked or resolved notification is
 * never injected; action-required rows are Gru's machine queue while
 * needs-owner rows keep the owner's acknowledgement.
 */

export const AWARENESS_STATE_NAME = 'awareness.json';

export const AWARENESS_BLOCK_HEADER = '[gru awareness · service context — not a user message]';

/** Prompt suffix for a policy-started turn (the block itself is prepended). */
export const AWARENESS_WAKE_INSTRUCTION =
  'This turn was started by the service wake policy — no user message is waiting. ' +
  'This is machine attention and it is meant to be acted on in-turn: diagnose the item, ' +
  'take one substantive step per incident (a fix lane, a re-arm, or a disposition), and ' +
  'stage the rest. After acting on an action-required alert, explicitly resolve its ' +
  'notification ID with POST /api/notifications/{id}/disposition and a nonempty detail; ' +
  'prompt delivery alone never clears it. When the right outcome is a hold or "needs no ' +
  'action", record that decision FIRST with POST /api/decisions (subject, covers, ' +
  'basis_fingerprint, recheck_at, by: "gru") and then disposition the alert — a hold ' +
  'recorded as state keeps the incident from re-waking you; prose does not. Use the ' +
  'subject the wake path consults: for job-scoped alert kinds that is "job:<job id>" — use ' +
  'the head SHA as basis_fingerprint only when the kind embeds one (github.ci-failed:<job>:<sha>); ' +
  'omit basis_fingerprint entirely for kinds without a SHA (github.pr-conflict:<job>), and name ' +
  'covers with the signal family ("ci-failed", "pr-conflict", "rebrief-unreconciled"). In all mode, ' +
  'FYI and needs-owner rows can also wake you; do not act on or Ack an owner-only stop on the ' +
  'owner’s behalf. Escalate decisions that are theirs; if nothing is actionable, say so briefly.';

export interface AwarenessLimits {
  /** Newest digest events per block (older overflow is dropped). */
  readonly maxEvents: number;
  /** Hard byte cap for the whole injected block. */
  readonly maxBytes: number;
  /** Hard character cap for every rendered line. */
  readonly maxLineChars: number;
  /** Action-required notes per block. A fresh rotation cycle leads with
   * the newest rows; subsequent passive blocks rotate through the open
   * queue (bounded fair coverage, GH-109). */
  readonly maxActionNotes: number;
}

export const AWARENESS_LIMITS: AwarenessLimits = {
  maxEvents: 12,
  maxBytes: 4_096,
  maxLineChars: 240,
  maxActionNotes: 8,
};

/** One context block prepared for a turn. `coveredThroughSeq` is the ledger
 * high-water mark the block accounts for — commit advances the cursor to
 * exactly this seq, never beyond it, so events arriving mid-delivery stay
 * queued for the next block. */
export interface AwarenessInjection {
  readonly text: string;
  readonly coveredThroughSeq: number;
  /** Only IDs actually rendered in this bounded block may be claimed. */
  readonly notificationIds?: readonly string[];
}

/** The chat server's narrow view of the awareness layer (injection provider
 * + delivery receipt). The wake decision stays inside the layer. */
export interface GruAwarenessPort {
  prepare(source?: 'chat' | 'wake'): AwarenessInjection | null;
  /** Revalidate the active batch at the chat admission boundary. */
  admitWake?(): boolean;
  /** Charge an admitted prompt against the minimum wake interval. */
  noteWakeAttempt?(): void;
  commit(injection: AwarenessInjection, source?: 'chat' | 'wake'): void;
  /** Accepted turn_start claims visible IDs and arms unresolved attention;
   * pre-acceptance failures remain pending for retry. */
  noteWakeOutcome?(ok: boolean, detail?: string, injection?: AwarenessInjection): void;
  /** A turn which accepted its block but failed later is not a new wake. */
  noteWakeTurnFailure?(detail: string, injection: AwarenessInjection): void;
  /** Native writer recovery is unsafe: surface a durable owner stop and retry. */
  noteWakeBlocked?(reason: string): void;
}

export type GruAwarenessLedger = Pick<
  LedgerApi,
  | 'getNotification'
  | 'listEventsAfter'
  | 'latestEventSeq'
  | 'appendCustomEvent'
  | 'listNotifications'
  | 'recordNotification'
  | 'resolveNotificationById'
  | 'listJobs'
  | 'listAgents'
  | 'coveringDecision'
  // Decision memory reads (issues #218/#224): present on the real ledger;
  // optional so narrow test fakes stay honest. Absent = triage asks run
  // without the open-decisions/dispositions context.
> & Partial<Pick<LedgerApi, 'listDecisions'>>;

/** The escalation notification kinds the triage surface applies to — the
 * Silas-authored family: the ops endpoint's `silas.escalation` and the
 * job-suffixed `silas.escalated:<jobId>` rows. Deliberately narrower than
 * the labelled extractor's historical net (which also caught unrelated
 * `*escalat*` kinds): production asks must not spend on notifications
 * Silas did not author. */
export function isSilasEscalationKind(kind: string): boolean {
  return kind === 'silas.escalation' || kind.startsWith('silas.escalated');
}

/** The decision-memory subject a Silas escalation row points at
 * (`silas.escalated:<jobId>` → `job:<jobId>`; the production
 * `silas.escalation` kind binds no job in its kind, so the caller
 * resolves the bound minion's job). Null when neither names a job. */
export function escalationDecisionSubject(kind: string, agentJobId?: string | null): string | null {
  const jobId = kind.match(/^silas\.escalated:(.+)$/u)?.[1];
  if (jobId !== undefined) return `job:${jobId}`;
  if (agentJobId !== undefined && agentJobId !== null && agentJobId !== '') return `job:${agentJobId}`;
  return null;
}


export interface GruAwarenessOptions {
  /** Chat dir (same home as the frame log); the cursor sidecar lives here. */
  readonly dir: string;
  readonly ledger: GruAwarenessLedger;
  /** Notification events drive the wake decision. */
  readonly bus?: Pick<EventBus, 'subscribe'>;
  /** Default 'action-required' (owner ruling 2026-09-23: machine
   * attention opens a turn; 'never' is passive-only). */
  readonly wakeMode?: NotifyWakeMode;
  /** Minimum interval between autonomous wake turns; 0 disables it. */
  readonly wakeMinIntervalMs?: number;
  /** Severity floor for a wake ('info' = every routed row). */
  readonly wakeMinSeverity?: WakeMinSeverity;
  /** Local-time quiet window (null/off). */
  readonly wakeQuietHours?: QuietHours | null;
  /** Issue #219 kill switch: hold-covered deferral (`[chat]
   * wake_defer_covered`, default ON per the #213 machine-wake ruling).
   * false restores pre-#219 behavior: a covered incident wakes anyway. */
  readonly wakeDeferCovered?: boolean;
  /** First-block-after-gap morning digest threshold; 0 disables. */
  readonly morningDigestGapMs?: number;
  readonly limits?: Partial<AwarenessLimits>;
  /** Forward a newly persisted owner follow-up to the chat notice surface. */
  readonly onFollowUpPosted?: (row: NotificationRecord) => void;
  readonly log?: Log;
  /** Clock seam (tests advance fake timers through this closure). */
  readonly now?: () => number;
  /** Issue #224 shadow wiring: the decision service asked for escalation
   * triage at the delivery receipt, the per-surface readiness gate, and
   * the per-surface mode reader. SHADOW ONLY — asks fire exclusively
   * when the surface's configured mode is `shadow` and the routed
   * profile is ready; the runtime records the provider answer next to
   * the deterministic baseline and this layer ignores the outcome
   * entirely: the wake policy's decision is untouched. Omitting any of
   * the three leaves awareness exactly as before. */
  readonly decisions?: Pick<DecisionService, 'decide'>;
  readonly readyForSurface?: (surface: string) => boolean;
  readonly modeForSurface?: (surface: string) => 'off' | 'shadow' | 'enforce' | null;
}

interface AwarenessState {
  readonly coveredThroughSeq: number;
  readonly wake?: {
    /** v2 means woken IDs were confirmed by a delivered prompt, not merely claimed. */
    readonly version?: 2;
    readonly woken: readonly string[];
    readonly pending?: readonly string[];
    /** Issue #112: wake batches whose `gru.wake` receipt append failed.
     * The turn happened — these are NEVER re-prompted; only the receipt
     * is owed, retried on flush and reconciled exactly once on boot.
     * `id` is the stable batch identity the reconciliation matches the
     * receipt by (issue #219 review: id-set matching can pair a retried
     * turn with the wrong earlier receipt). */
    readonly unreceipted?: readonly { readonly id?: string; readonly ids: readonly string[]; readonly at: number }[];
    /** Issue #115: failed accepted-wake attempts per notification ID.
     * At WAKE_FAILURE_RETRIES the truthful owner escalation replaces the
     * autonomous path for that incident. */
    readonly wakeFailures?: Readonly<Record<string, number>>;
    /** Legacy sidecars may contain retired timeout follow-ups; never re-arm them. */
    readonly followUp?: readonly { readonly id: string; readonly dueAtMs: number }[];
    readonly lastFiredAt: number | null;
    readonly lastAttemptAt?: number | null;
  };
  readonly digest?: {
    readonly lastDeliveredAt: number | null;
    readonly lastOwnerAt?: number | null;
    readonly lastOwnerSeq?: number;
  };
  /** Passive queue rotation offsets (GH-109); absent in legacy state
   * files, which start a fresh cycle at the newest rows. */
  readonly attention?: {
    readonly machineOffset: number;
    readonly ownerOffset: number;
  };
}

/** Notification event kinds that carry a routing decision. */
const NOTIFICATION_EVENT_KINDS = ['notification.created', 'notification.triaged'] as const;
/** Scan cap for notification events; the render cap is maxActionNotes. */
const MAX_NOTIFICATION_SCAN = 200;
/** Backlog page size after owner-held legacy rows are reclassified. */
const MAX_BACKLOG_SEED = 50;
/** Node clamps longer setTimeout delays to 1 ms; chain safe slices. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** Default morning-digest gap (8 h): first block after a quiet night. */
export const DEFAULT_MORNING_DIGEST_GAP_MS = 28_800_000;
/** Morning-digest kernel kinds — the "actions" count. */
const MORNING_ACTION_KINDS = ['job.delivered', 'job.status', 'round.verdict'] as const;
/** Bounded morning-digest lines (fires/actions/merges/staged PRs). */
const MAX_MORNING_LINES = 6;
/** Issue #219: an uncovered-later recheck for a hold-covered deferral is
 * clamped to this bound even when the decision names no recheck_at — a
 * held incident must come back on its own within bounded time. */
export const WAKE_COVERED_RECHECK_BOUND_MS = 3_600_000;
/** Issue #219: retries for an accepted-but-failed wake turn before the
 * truthful owner escalation replaces the autonomous path (#115). */
export const WAKE_FAILURE_RETRIES = 2;
/** Issue #219: retry delay for a wake whose ledger receipt failed to
 * append (#112) — the turn happened; only the receipt is owed. */
const WAKE_RECEIPT_RETRY_MS = 5_000;
/** Issue #219: cap on parked unreceipted wake batches (#112). One wake
 * batch exists per turn, so reaching this means the ledger has been down
 * across many turns — fail loud instead of growing the sidecar forever. */
const MAX_UNRECEIPTED_BATCHES = 8;

function payloadOf(event: EventRecord | BusEvent): Record<string, unknown> {
  const payload = event.payload;
  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampLine(line: string, max: number): string {
  // Ledger titles, details and check names are external data, not prompt
  // structure. No metadata may create another service-context line.
  const safe = line.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (char) =>
    char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\t' ? '\\t' : `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return safe.length > max ? `${safe.slice(0, max - 1)}…` : safe;
}

/**
 * Curated digest rules — one line per ledger event. Unknown kinds are
 * deliberately omitted: the digest is a bounded status sheet, not a log
 * re-print. Notification events are handled by the action-required note
 * path, never here.
 */
const DIGEST_RULES: Readonly<Record<string, (event: EventRecord) => string | null>> = {
  'job.created': (event) => {
    const repo = textOf(payloadOf(event).repo);
    return `job ${event.jobId ?? '?'} created${repo !== null ? ` (${repo})` : ''}`;
  },
  'job.handoff': (event) => `job ${event.jobId ?? '?'}: ops handoff`,
  'job.minion-spawned': (event) => `job ${event.jobId ?? '?'}: minion ${textOf(payloadOf(event).agentId) ?? '?'} spawned`,
  'job.delivered': (event) => `job ${event.jobId ?? '?'}: briefing delivered to minion ${textOf(payloadOf(event).agentId) ?? '?'}`,
  'job.minion-error': (event) => {
    const error = textOf(payloadOf(event).error);
    return `job ${event.jobId ?? '?'}: minion error${error !== null ? ` — ${error}` : ''}`;
  },
  'job.pr-linked': (event) => `job ${event.jobId ?? '?'}: pull request linked`,
  'job.status': (event) => {
    const payload = payloadOf(event);
    return `job ${event.jobId ?? '?'}: ${textOf(payload.from) ?? '?'} → ${textOf(payload.to) ?? '?'}`;
  },
  'round.created': (event) => `round ${event.roundId ?? '?'}: review round started`,
  'round.status': (event) => {
    const payload = payloadOf(event);
    return `round ${event.roundId ?? '?'}: ${textOf(payload.from) ?? '?'} → ${textOf(payload.to) ?? '?'}`;
  },
  'round.verdict': (event) => `round ${event.roundId ?? '?'}: verdict ${textOf(payloadOf(event).verdict) ?? '?'}`,
  'round.perkins-review': (event) => {
    const payload = payloadOf(event);
    const verdict = textOf(payload.canonicalVerdict) ?? 'review complete';
    const blockers = numberOf(payload.blockers);
    return `round ${event.roundId ?? '?'}: Perkins ${verdict}${
      blockers !== null ? ` — ${blockers} blocker(s)` : ''
    } (${payload.complete === false ? 'incomplete proof' : 'proof complete'})`;
  },
  'round.perkins-incomplete': (event) => {
    const payload = payloadOf(event);
    const reason = textOf(payload.reason) ?? textOf(payload.error);
    return `round ${event.roundId ?? '?'}: review INCOMPLETE${reason !== null ? ` — ${reason}` : ''}`;
  },
  'round.posted': (event) => {
    const verdict = textOf(payloadOf(event).canonicalVerdict);
    return `round ${event.roundId ?? '?'}: report posted to the pull request${verdict !== null ? ` (${verdict})` : ''}`;
  },
  'round.head-moved': (event) => {
    const cause = textOf(payloadOf(event).cause);
    return cause === null
      ? `round ${event.roundId ?? '?'}: head moved after freeze — verdict invalidated`
      : `round ${event.roundId ?? '?'}: review source changed after freeze (${cause}) — verdict invalidated`;
  },
  'round.post-recovered': (event) => {
    const verdict = textOf(payloadOf(event).postedVerdict);
    return `round ${event.roundId ?? '?'}: recorded verdict recovered after restart${verdict !== null ? ` (${verdict})` : ''}`;
  },
  'job.fallback-review': (event) => {
    const payload = payloadOf(event);
    const phase = textOf(payload.phase) ?? 'update';
    switch (phase) {
      case 'started':
        return `job ${event.jobId ?? '?'}: bmad-review gate engaged (Perkins unavailable)`;
      case 'triaged': {
        const blockers = numberOf(payload.blockers) ?? 0;
        const notes = numberOf(payload.notes) ?? 0;
        return `job ${event.jobId ?? '?'}: bmad-review round ${numberOf(payload.iteration) ?? '?'} — ${blockers} blocker(s), ${notes} note(s)`;
      }
      case 'fix-directive': {
        const blockers = numberOf(payload.blockers) ?? 0;
        return `job ${event.jobId ?? '?'}: fix directive${payload.delivered === false ? ' NOT delivered' : ' delivered'} (${blockers} blocker(s))`;
      }
      case 'pass':
        // The fallback PASS is the review-of-record for routing and fixes,
        // never a Perkins READY: it must not read as merge clearance.
        return `job ${event.jobId ?? '?'}: bmad-review PASS — review/fix routing cleared (not a Perkins READY; merge stays user-held)`;
      case 'blocked':
        return `job ${event.jobId ?? '?'}: bmad-review BLOCKED${textOf(payload.reason) !== null ? ` — ${textOf(payload.reason)!}` : ''}`;
      case 'unavailable':
        return `job ${event.jobId ?? '?'}: review gate unavailable${textOf(payload.note) !== null ? ` — ${textOf(payload.note)!}` : ''}`;
      default:
        return `job ${event.jobId ?? '?'}: bmad-review ${phase}`;
    }
  },
  'worktree.created': (event) => `lane ${textOf(payloadOf(event).id) ?? event.jobId ?? '?'} created`,
  'worktree.status': (event) => {
    const payload = payloadOf(event);
    return `lane ${textOf(payload.id) ?? '?'}: ${textOf(payload.from) ?? '?'} → ${textOf(payload.to) ?? '?'}`;
  },
  'worktree.paused': (event) => `lane ${textOf(payloadOf(event).id) ?? '?'}: sweep paused — live processes need a decision`,
  'worktree.swept': (event) => `lane ${textOf(payloadOf(event).id) ?? '?'}: swept`,
  'lens.status': (event) => {
    const payload = payloadOf(event);
    if (payload.to !== 'error') return null;
    const note = textOf(payload.note);
    return `round ${event.roundId ?? '?'}: lens ${event.lens ?? '?'} failed${note !== null ? ` — ${note}` : ''}`;
  },
  'agent.state': (event) => {
    const payload = payloadOf(event);
    if (payload.to !== 'error') return null;
    const error = textOf(payload.error);
    return `agent ${event.agentId ?? '?'}: errored${error !== null ? ` — ${error}` : ''}`;
  },
  'supervision.escalated': (event) => {
    const failureClass = textOf(payloadOf(event).class);
    return `supervisor: agent ${event.agentId ?? '?'} stopped${failureClass !== null ? ` — ${failureClass}` : ''}`;
  },
  'supervision.breaker': (event) => `supervisor: crash-loop breaker open for agent ${event.agentId ?? '?'}`,
};

export class GruAwareness {
  readonly file: string;
  private readonly ledger: GruAwarenessLedger;
  private readonly limits: AwarenessLimits;
  private readonly wakePolicy: WakePolicy;
  private readonly wakeMode: NotifyWakeMode;
  private readonly morningDigestGapMs: number;
  /** Issue #219 kill switch: hold-covered deferral (default ON). */
  private readonly coveredDeferralEnabled: boolean;
  private readonly log: Log;
  private readonly onFollowUpPosted: (row: NotificationRecord) => void;
  private readonly now: () => number;
  private cursor: number;
  /** Per-queue rotation offsets for passive blocks (GH-109): durable so a
   * restart resumes the coverage cycle instead of replaying the newest
   * page forever. */
  private attentionRotation: { machine: number; owner: number };
  /** Rotation advance computed by the last prepare() — applied only by
   * commit(), so an undelivered block re-prepares unchanged. One exception:
   * a null block (receipt-only page or empty queues) is never delivered, so
   * prepare() applies its wall/wrap advance in memory to keep the rotation
   * live (GH-109). */
  private pendingRotationAdvance: { readonly machine: number; readonly owner: number } | null = null;
  /** Epoch ms of the last delivered block (legacy state compatibility). */
  private lastDeliveredAt: number | null;
  /** Only an owner-directed user turn advances the morning boundary. */
  private lastOwnerAt: number | null;
  private lastOwnerSeq: number;
  private wakeSink: (() => void) | null = null;
  /** Candidate ids waiting to be released as ONE coalesced wake. */
  private readonly pendingWakeIds: Set<string>;
  /** Issue #112: delivered wake batches whose ledger receipt failed to
   * append. Never re-prompted; retried on flush, reconciled once on boot.
   * `id` is the stable batch identity reconciliation matches receipts by. */
  private readonly unreceipted: { readonly id: string; readonly ids: readonly string[]; readonly at: number }[];
  /** Issue #115: accepted-turn failure counts per notification ID. */
  private readonly wakeFailures: Map<string, number>;
  /** Issue #219: hold-covered deferrals awaiting their recheck, by
   * incident key. Recomputed from the decision rows after a restart (the
   * coverage query re-derives the same answer), so this stays memory-only. */
  private readonly deferredRechecks = new Map<
    string,
    { readonly atMs: number; readonly decisionId: string; readonly notificationId: string }
  >();
  /** In-memory de-duplication for the `gru.wake-deferred` event stream:
   * one avoidance event per (reason, notification id) per process — the
   * bus can deliver created + triaged for the same row. */
  private readonly deferredRecorded = new Set<string>();
  private deferredTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredTimerAt: number | null = null;
  /** Issue #112: pending retry timer for the unreceipted receipt appends. */
  private receiptTimer: ReturnType<typeof setTimeout> | null = null;
  /** One in-flight bounded batch. Its IDs stay pending until prompt receipt. */
  private activeWakeIds: readonly string[] | null = null;
  private failedRetryAtMs = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeTimerAt: number | null = null;
  /** Issue #224 shadow wiring (see GruAwarenessOptions). */
  private readonly decisions: Pick<DecisionService, 'decide'> | null;
  private readonly readyForSurface: ((surface: string) => boolean) | null;
  private readonly modeForSurface: ((surface: string) => 'off' | 'shadow' | 'enforce' | null) | null;
  /** Escalation-triage shadow dedupe (issue #224): notification ids whose
   * candidate already fired an ask this process. A spend guard against
   * the created→triaged event double-delivery, not a correctness
   * contract; FIFO-evicted at 512 ids. */
  private readonly askedEscalations = new Set<string>();
  private disposed = false;

  constructor(opts: GruAwarenessOptions) {
    this.file = join(opts.dir, AWARENESS_STATE_NAME);
    this.ledger = opts.ledger;
    this.limits = { ...AWARENESS_LIMITS, ...(opts.limits ?? {}) };
    if (!Number.isSafeInteger(this.limits.maxActionNotes) || this.limits.maxActionNotes < 1) {
      throw new Error('awareness maxActionNotes must be a positive integer');
    }
    this.wakeMode = opts.wakeMode ?? 'action-required';
    this.coveredDeferralEnabled = opts.wakeDeferCovered ?? true;
    this.morningDigestGapMs = opts.morningDigestGapMs ?? DEFAULT_MORNING_DIGEST_GAP_MS;
    this.decisions = opts.decisions ?? null;
    this.readyForSurface = opts.readyForSurface ?? null;
    this.modeForSurface = opts.modeForSurface ?? null;
    this.log = opts.log ?? (() => {});
    this.onFollowUpPosted = opts.onFollowUpPosted ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
    const state = GruAwareness.loadState(this.file);
    this.cursor = state.coveredThroughSeq;
    this.attentionRotation = {
      machine: state.attention?.machineOffset ?? 0,
      owner: state.attention?.ownerOffset ?? 0,
    };
    this.lastDeliveredAt = state.digest?.lastDeliveredAt ?? null;
    this.lastOwnerAt = state.digest?.lastOwnerAt !== undefined ? state.digest.lastOwnerAt : this.lastDeliveredAt;
    this.lastOwnerSeq = state.digest?.lastOwnerSeq ?? state.coveredThroughSeq;
    this.pendingWakeIds = new Set(state.wake?.pending ?? []);
    this.unreceipted = (state.wake?.unreceipted ?? []).map((batch, index) => ({
      id: batch.id ?? `legacy-${index}`,
      ids: [...batch.ids],
      at: batch.at,
    }));
    this.wakeFailures = new Map(Object.entries(state.wake?.wakeFailures ?? {}));
    this.wakePolicy = new WakePolicy(
      {
        mode: this.wakeMode,
        minSeverity: opts.wakeMinSeverity ?? 'info',
        minIntervalMs: opts.wakeMinIntervalMs ?? 300_000,
        quietHours: opts.wakeQuietHours ?? null,
      },
      state.wake ?? { woken: [], lastFiredAt: null },
    );
    opts.bus?.subscribe((event) => this.onBusEvent(event));
  }

  /**
   * Read the durable state. An absent file is the documented start state
   * (cursor 0 = the first prepared block covers the newest bounded window;
   * no wakes claimed). A present-but-invalid file fails loud — a silent
   * reset would re-inject context the brain already received and re-burn
   * wakes the policy already claimed.
   */
  private static loadState(file: string): AwarenessState {
    if (!existsSync(file)) return { coveredThroughSeq: 0 };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf-8'));
    } catch (error) {
      throw new Error(
        `gru awareness state ${file} is unreadable (${String(error)}); ` +
          'refusing to guess — inspect or remove the file (a fresh cursor starts at the beginning)',
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(
        `gru awareness state ${file} has no coveredThroughSeq; ` +
          'refusing to guess — inspect or remove the file (a fresh cursor starts at the beginning)',
      );
    }
    const record = parsed as Record<string, unknown>;
    const value = record['coveredThroughSeq'];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `gru awareness state ${file} has an invalid coveredThroughSeq; ` +
          'refusing to guess — inspect or remove the file (a fresh cursor starts at the beginning)',
      );
    }
    const wake = record['wake'] === undefined ? { woken: [], lastFiredAt: null } : record['wake'];
    if (typeof wake !== 'object' || wake === null || Array.isArray(wake)) {
      throw new Error(
        `gru awareness state ${file} has an invalid wake section; ` +
          'refusing to guess — inspect or remove the file (a fresh cursor starts at the beginning)',
      );
    }
    const wakeRecord = wake as Record<string, unknown>;
    const woken = wakeRecord['woken'];
    const wokenIncidents = wakeRecord['wokenIncidents'];
    const lastFiredAt = wakeRecord['lastFiredAt'];
    const pending = wakeRecord['pending'];
    const followUp = wakeRecord['followUp'];
    const version = wakeRecord['version'];
    const lastAttemptAt = wakeRecord['lastAttemptAt'];
    const unreceipted = wakeRecord['unreceipted'];
    const wakeFailures = wakeRecord['wakeFailures'];
    const validWokenIncidents =
      wokenIncidents === undefined ||
      (Array.isArray(wokenIncidents) && wokenIncidents.every((key) => typeof key === 'string' && key !== ''));
    const validUnreceipted =
      unreceipted === undefined ||
      (Array.isArray(unreceipted) &&
        unreceipted.every(
          (batch): batch is { readonly ids: string[]; readonly at: number } =>
            typeof batch === 'object' && batch !== null &&
            Array.isArray((batch as { ids?: unknown }).ids) &&
            ((batch as { ids: unknown[] }).ids).every((id) => typeof id === 'string' && id !== '') &&
            Number.isSafeInteger((batch as { at?: unknown }).at) &&
            (batch as { at: number }).at >= 0,
        ));
    const validWakeFailures =
      wakeFailures === undefined ||
      (typeof wakeFailures === 'object' && wakeFailures !== null && !Array.isArray(wakeFailures) &&
        Object.entries(wakeFailures).every(
          ([id, count]) => id !== '' && typeof count === 'number' && Number.isSafeInteger(count) && count > 0,
        ));
    if (
      !validWokenIncidents ||
      !Array.isArray(woken) ||
      !woken.every((id): id is string => typeof id === 'string' && id !== '') ||
      !(pending === undefined || (Array.isArray(pending) && pending.every((id): id is string => typeof id === 'string' && id !== ''))) ||
      !validUnreceipted ||
      !validWakeFailures ||
      !(followUp === undefined || (Array.isArray(followUp) && followUp.every((entry): entry is { id: string; dueAtMs: number } =>
        typeof entry === 'object' && entry !== null && typeof (entry as { id?: unknown }).id === 'string' &&
        (entry as { id: string }).id !== '' && Number.isSafeInteger((entry as { dueAtMs?: unknown }).dueAtMs) &&
        (entry as { dueAtMs: number }).dueAtMs >= 0))) ||
      !(version === undefined || version === 2) ||
      !(lastAttemptAt === undefined || lastAttemptAt === null || (typeof lastAttemptAt === 'number' && Number.isFinite(lastAttemptAt))) ||
      !(lastFiredAt === null || (typeof lastFiredAt === 'number' && Number.isFinite(lastFiredAt)))
    ) {
      throw new Error(
        `gru awareness state ${file} has an invalid wake section; ` +
          'refusing to guess — inspect or remove the file (a fresh cursor starts at the beginning)',
      );
    }
    const digestRecord = record['digest'];
    let digest: AwarenessState['digest'];
    if (digestRecord !== undefined) {
      if (typeof digestRecord !== 'object' || digestRecord === null || Array.isArray(digestRecord)) {
        throw new Error(
          `gru awareness state ${file} has an invalid digest section; ` +
            'refusing to guess — inspect or remove the file (a fresh cursor starts at the beginning)',
        );
      }
      const record = digestRecord as Record<string, unknown>;
      const delivered = record['lastDeliveredAt'];
      const ownerAt = record['lastOwnerAt'];
      const ownerSeq = record['lastOwnerSeq'];
      if (!(delivered === null || (typeof delivered === 'number' && Number.isFinite(delivered))) ||
          !(ownerAt === undefined || ownerAt === null || (typeof ownerAt === 'number' && Number.isFinite(ownerAt))) ||
          !(ownerSeq === undefined || (typeof ownerSeq === 'number' && Number.isSafeInteger(ownerSeq) && ownerSeq >= 0))) {
        throw new Error(
          `gru awareness state ${file} has an invalid digest section; ` +
            'refusing to guess — inspect or remove the file (a fresh cursor starts at the beginning)',
        );
      }
      digest = {
        lastDeliveredAt: delivered as number | null,
        ...(ownerAt !== undefined ? { lastOwnerAt: ownerAt as number | null } : {}),
        ...(ownerSeq !== undefined ? { lastOwnerSeq: ownerSeq as number } : {}),
      };
    }
    const attentionRecord = record['attention'];
    let attention: AwarenessState['attention'];
    if (attentionRecord !== undefined) {
      if (typeof attentionRecord !== 'object' || attentionRecord === null || Array.isArray(attentionRecord)) {
        throw new Error(
          `gru awareness state ${file} has an invalid attention section; ` +
            'refusing to guess — inspect or remove the file (a fresh cursor starts at the beginning)',
        );
      }
      const offsets = attentionRecord as Record<string, unknown>;
      const validOffset = (value: unknown): value is number =>
        typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
      if (!validOffset(offsets['machineOffset']) || !validOffset(offsets['ownerOffset'])) {
        throw new Error(
          `gru awareness state ${file} has an invalid attention section; ` +
            'refusing to guess — inspect or remove the file (a fresh cursor starts at the beginning)',
        );
      }
      attention = { machineOffset: offsets['machineOffset'] as number, ownerOffset: offsets['ownerOffset'] as number };
    }
    // v1 claimed IDs before the model turn. Its woken set cannot prove
    // receipt (a failed spawn may have stranded a live alert). Prefer one
    // extra wake to losing an unresolved machine incident on upgrade.
    return { coveredThroughSeq: value, wake: {
      version: 2,
      woken: version === 2 ? woken : [],
      lastFiredAt: version === 2 ? lastFiredAt : null,
      lastAttemptAt: version === 2 && typeof lastAttemptAt === 'number' ? lastAttemptAt : null,
      ...(version === 2 && wokenIncidents !== undefined ? { wokenIncidents: wokenIncidents as string[] } : {}),
      ...(pending !== undefined ? { pending: pending as string[] } : {}),
      ...(unreceipted !== undefined ? { unreceipted: unreceipted as { id?: string; ids: string[]; at: number }[] } : {}),
      ...(wakeFailures !== undefined ? { wakeFailures: wakeFailures as Record<string, number> } : {}),
      ...(followUp !== undefined ? { followUp: followUp as { id: string; dueAtMs: number }[] } : {}),
    }, ...(digest !== undefined ? { digest } : {}),
    ...(attention !== undefined ? { attention } : {}) };
  }

  /** Attach the wake action once the chat server exists (late-bound).
   * Existing machine-routed rows remain Gru's backlog, not owner bell items. */
  setWakeSink(sink: () => void): void {
    this.wakeSink = sink;
    this.reconcileUnreceiptedReceipts();
    this.reconcileWakeReceipts();
    this.seedBacklog();
    this.flushPendingWakes();
  }

  /** Stop the deferred-wake timer (service shutdown / test teardown). */
  dispose(): void {
    this.disposed = true;
    this.cancelWakeTimer();
    if (this.deferredTimer !== null) clearTimeout(this.deferredTimer);
    this.deferredTimer = null;
    this.deferredTimerAt = null;
    if (this.receiptTimer !== null) clearTimeout(this.receiptTimer);
    this.receiptTimer = null;
  }

  /**
   * Build the context block for a turn, or null when nothing happened
   * (empty case: inject nothing, cost nothing). Does not consume — commit
   * separately once the turn actually received the block.
   */
  prepare(source: 'chat' | 'wake' = 'chat'): AwarenessInjection | null {
    const latest = this.ledger.latestEventSeq();
    const exclusiveWake = source === 'wake' && this.activeWakeIds !== null;
    const morning = source === 'chat' ? this.morningDigest() : null;
    // A delivered context block is not a disposition. Open machine and
    // owner stops remain in subsequent user turns even after the event
    // cursor advanced; only an active wake uses its exclusive bounded batch.
    // Closed receipts (owner decision D1, code review 2026-10-04): machine
    // rows bound through an agent to a merged/done job are the board's
    // receipts. They are LABELED here and rendered under their own
    // section, never counted as machine attention and never wake seeds.
    const owners = exclusiveWake ? null : this.rotatedOwnerQueue();
    const machine = exclusiveWake ? null : this.rotatedMachineQueue();
    // Composed candidate rows with their absolute queue positions: the
    // rotation advance is computed from what the delivered block actually
    // rendered (GH-109), never from the fetched page alone — slot and byte
    // caps must not silently consume rows they never showed.
    const ownerCandidates: { readonly id: string; readonly position: number }[] = [];
    const machineCandidates: { readonly id: string; readonly position: number }[] = [];
    const attention = (() => {
      if (owners === null || machine === null) return { live: [] as NotificationRecord[], receipts: [] as NotificationRecord[] };
      // Keep both queues represented in a bounded user block. One busy
      // category must not silently crowd out the other indefinitely.
      const ownerSlots = machine.live.length > 0 && this.limits.maxActionNotes > 1
        ? Math.ceil(this.limits.maxActionNotes / 2) : this.limits.maxActionNotes;
      const selectedOwners = owners.rows.slice(0, ownerSlots);
      const machineComposed = machine.live.slice(0, this.limits.maxActionNotes - selectedOwners.length);
      for (const [index, row] of owners.rows.slice(0, this.limits.maxActionNotes).entries()) {
        ownerCandidates.push({ id: row.id, position: owners.offset + index });
      }
      for (const [index, row] of machineComposed.entries()) {
        machineCandidates.push({ id: row.id, position: machine.offset + index });
      }
      return {
        live: [...selectedOwners, ...machineComposed,
          ...owners.rows.slice(ownerSlots, this.limits.maxActionNotes)],
        receipts: machine.receiptRows,
      };
    })();
    const openAttention = attention.live;
    if (latest <= this.cursor && this.pendingWakeIds.size === 0 && morning === null && openAttention.length === 0) {
      // A page holding only closed receipts (or empty queues) renders
      // nothing — a null block, never delivered. The rotation must still
      // move (GH-109): advancing only at commit would wedge the offset
      // behind a receipt tail or an exact-tail alignment forever. Advance
      // in memory so the next prepare() reaches live rows; the next
      // delivered block persists it.
      if (owners !== null && machine !== null) {
        this.attentionRotation = { machine: machine.noLiveAdvance, owner: owners.noLiveAdvance };
        this.pendingRotationAdvance = null;
      }
      return null;
    }

    const reverse = <T>(items: readonly T[]): T[] => [...items].reverse();
    // Overfetch, then keep the newest maxEvents DIGESTIBLE lines: derived
    // notification.* rows mirror board events and must not crowd out the
    // status lines inside a fixed window.
    const scanLimit = this.limits.maxEvents * 4 + 1;
    const digestScan = this.ledger.listEventsAfter(this.cursor, {
      limit: scanLimit,
      order: 'desc',
    });
    let overflow = digestScan.length >= scanLimit;
    const digestLinesNewestFirst: string[] = [];
    for (const event of digestScan) {
      if (event.kind.startsWith('notification.')) continue;
      const rule = DIGEST_RULES[event.kind];
      if (rule === undefined) continue;
      const line = rule(event);
      if (line === null || line === '') continue;
      if (digestLinesNewestFirst.length === this.limits.maxEvents) {
        overflow = true;
        break;
      }
      digestLinesNewestFirst.push(line);
    }
    const digestLines = reverse(digestLinesNewestFirst);

    // Pending IDs are independent of the cursor: a passive delivery may
    // have covered an event before the wake policy was enabled. The active
    // batch is exclusive — never include/claim an unrelated new row in it.
    const notes: { id: string; line: string }[] = [];
    const receiptNotes: { id: string; line: string }[] = [];
    const seenIds = new Set<string>();
    const addNote = (id: string): void => {
      if (seenIds.has(id) || notes.length >= this.limits.maxActionNotes) return;
      seenIds.add(id);
      const row = this.ledger.getNotification(id);
      if (row === null || row.ackedAt !== null || row.resolvedAt !== null) return;
      // A stop reclassified while a wake was waiting must never ride a
      // machine-only turn; all mode explicitly opts into owner context.
      if (exclusiveWake && this.wakeMode === 'action-required' && row.routing !== 'action-required') return;
      const detail = row.detail !== null && row.detail !== '' ? ` — ${JSON.stringify(row.detail)}` : '';
      const icon = row.routing === 'action-required' ? '⚠' : row.routing === 'needs-owner' ? '🔔' : 'ℹ';
      notes.push({ id, line: `- ${icon} [${id}] title=${JSON.stringify(row.title)}${detail} (routing: ${row.routing})` });
    };
    const addReceipt = (id: string): void => {
      if (receiptNotes.length >= this.limits.maxActionNotes) return;
      const row = this.ledger.getNotification(id);
      if (row === null || row.ackedAt !== null || row.resolvedAt !== null) return;
      const detail = row.detail !== null && row.detail !== '' ? ` — ${JSON.stringify(row.detail)}` : '';
      receiptNotes.push({
        id,
        line: `- 🧾 [${id}] title=${JSON.stringify(row.title)}${detail} (closed receipt — no action required)`,
      });
    };
    if (exclusiveWake) {
      for (const id of this.activeWakeIds ?? []) addNote(id);
    } else {
      for (const row of openAttention) addNote(row.id);
      for (const row of attention.receipts) addReceipt(row.id);
      for (const id of this.pendingWakeIds) {
        const row = this.ledger.getNotification(id);
        if (row !== null && this.isReceiptNotification(row.agentId)) {
          // A stored seed for a row that became a receipt (or predates
          // this rule) is dropped here, never woken.
          this.pendingWakeIds.delete(id);
          continue;
        }
        addNote(id);
      }
    }
    if (!exclusiveWake && notes.length < this.limits.maxActionNotes) {
      // The event scan covers newly triaged rows as well as the SQL-backed
      // open queue; older events cannot hide unresolved attention.
      const notificationEvents = this.ledger.listEventsAfter(this.cursor, {
        limit: MAX_NOTIFICATION_SCAN,
        order: 'desc',
        kinds: [...NOTIFICATION_EVENT_KINDS],
      });
      const eventIds = notificationEvents
        .filter((event) => payloadOf(event)['routing'] === 'action-required' || payloadOf(event)['routing'] === 'needs-owner')
        .map((event) => textOf(payloadOf(event)['id']))
        .filter((id): id is string => id !== null);
      for (const id of [...eventIds].reverse()) {
        if (this.isReceiptNotification(this.ledger.getNotification(id)?.agentId ?? null)) continue;
        addNote(id);
      }
    }
    const rendered = this.render(notes, receiptNotes, digestLines, overflow, morning);
    // Rotation advance (GH-109): move past exactly the composed rows the
    // block rendered (or that closed mid-flight); rows skipped by slot or
    // byte caps stay ahead of the offset and lead the next block. prepare
    // stays read-only otherwise: the advance lands at commit(), so an
    // undelivered block re-prepares unchanged, and a wake's exclusive
    // block discards any stale advance with the passive block it displaced.
    if (owners === null || machine === null) {
      this.pendingRotationAdvance = null;
    } else {
      const renderedIds = new Set(rendered?.ids ?? []);
      this.pendingRotationAdvance = {
        owner: this.advancePastRendered(owners.offset, ownerCandidates, renderedIds),
        machine: machineCandidates.length > 0
          ? this.advancePastRendered(machine.offset, machineCandidates, renderedIds)
          : machine.noLiveAdvance,
      };
    }
    if (rendered === null) return null;
    if (exclusiveWake && rendered.ids.length === 0) {
      this.log('error', 'wake context has no visible notification IDs; increase awareness line/byte limits', {
        notification_ids: this.activeWakeIds,
      });
      return null;
    }
    return { text: rendered.text, coveredThroughSeq: latest, notificationIds: rendered.ids };
  }

  /** Commit a delivered block: advance the event cursor and the passive
   * queue rotation (GH-109). Only a user chat turn advances the independent
   * owner watermark used by the morning digest. */
  commit(injection: AwarenessInjection, source: 'chat' | 'wake' = 'chat'): void {
    if (this.pendingRotationAdvance !== null) {
      this.attentionRotation = { ...this.pendingRotationAdvance };
      this.pendingRotationAdvance = null;
    }
    this.cursor = Math.max(this.cursor, injection.coveredThroughSeq);
    this.lastDeliveredAt = this.now();
    if (source === 'chat') {
      this.lastOwnerAt = this.lastDeliveredAt;
      this.lastOwnerSeq = Math.max(this.lastOwnerSeq, injection.coveredThroughSeq);
    }
    try {
      this.persist();
    } catch (error) {
      // At-least-once beats lost context: the in-memory cursor keeps this
      // process correct; a restart would re-inject this block (bounded).
      this.log('error', 'gru awareness cursor persist failed — context may re-inject after restart', {
        file: this.file,
        error: String(error),
      });
    }
  }

  /** If chat/spawn barriers crossed into quiet hours, release the batch
   * back to its durable pending set and arm the policy's future deadline.
   * Issue #102: this is ALSO the admission boundary — it runs after every
   * awaited spawn, so every batch member is re-checked against the row
   * state and the hold coverage HERE, not only when the batch was
   * composed. Rows that closed during the spawn drop out silently; rows a
   * decision now covers move to a covered deferral (with its recheck);
   * a batch with no eligible member left cancels the turn. */
  admitWake(): boolean {
    if (this.activeWakeIds === null) return false;
    const stillEligible: string[] = [];
    for (const id of this.activeWakeIds) {
      const row = this.ledger.getNotification(id);
      if (row === null || row.ackedAt !== null || row.resolvedAt !== null || this.isReceiptNotification(row.agentId)) {
        continue;
      }
      // The full candidate gate re-runs here minus dedupe (the batch
      // members are claimed by design): a row re-triaged below the
      // severity floor or out of wake routing during the spawn must not
      // ride the prompt (issue #219 review, admission gate).
      const gateSkip = this.wakePolicy.gate({
        id: row.id,
        incidentKey: incidentKeyOf(row),
        routing: row.routing,
        severity: row.severity,
      });
      if (gateSkip !== null) {
        this.log('debug', 'gru wake batch member no longer gate-eligible', {
          notification_id: id, reason: gateSkip,
        });
        continue;
      }
      const covering = this.coverageFor(row);
      if (covering !== null) {
        this.deferCoveredWake(row, covering);
        continue;
      }
      stillEligible.push(id);
    }
    if (stillEligible.length === 0) {
      // Nothing survived revalidation: no wake without eligible IDs
      // (issue #102). The batch members are already durably pending
      // (closed ones are dropped by the next prune), so nothing strands.
      this.activeWakeIds = null;
      this.persistWakeState();
      return false;
    }
    this.activeWakeIds = stillEligible;
    const decision = this.wakePolicy.scheduleDecision(this.now());
    if (decision.action !== 'defer') return true;
    this.activeWakeIds = null;
    this.persistWakeState();
    this.scheduleWake(decision.retryAtMs, decision.reason);
    return false;
  }

  noteWakeAttempt(): void {
    if (this.activeWakeIds === null) throw new Error('cannot charge a wake without an active batch');
    this.wakePolicy.attempted(this.now());
    this.persistWakeState();
  }

  /** Wake receipt at accepted turn_start: `gru.wake` records delivery, not
   * action or resolution. A pre-acceptance failure retains pending IDs.
   * Issue #112: the receipt commits BEFORE the dedupe state — a failed
   * append parks the delivered batch as unreceipted (never re-prompted;
   * the append is retried, and boot reconciliation repairs the gap) so
   * board truth and the sidecar can never disagree silently. */
  noteWakeOutcome(ok: boolean, detail?: string, injection?: AwarenessInjection): void {
    if (this.disposed) return;
    const active = this.activeWakeIds ?? [];
    const delivered = active.filter((id) => injection?.notificationIds?.includes(id));
    this.activeWakeIds = null;
    this.prunePending();
    if (ok && delivered.length > 0) {
      const at = this.now();
      // Park-FIRST protocol (issue #219 review): the batch leaves pending
      // and its ids + incident keys claim BEFORE the receipt append, so
      // every crash window is safe — a delivered turn can never re-prompt
      // (the ids are claimed), and a failed append costs only the owed
      // receipt, which the flush retry and boot reconciliation settle.
      const batch = { id: randomUUID(), ids: delivered, at };
      for (const id of delivered) {
        // NOTE: wakeFailures deliberately survives acceptance (issue #115):
        // acceptance fires at turn START, before the turn body can fail —
        // clearing here would reset the bounded-retry count every cycle.
        // The debt dies when the row resolves (onBusEvent), when pruning
        // drops a closed row, or when the escalation spends it.
        this.pendingWakeIds.delete(id);
      }
      this.claimDeliveredBatch(batch);
      if (this.unreceipted.length >= MAX_UNRECEIPTED_BATCHES) {
        throw new Error(
          `gru wake receipt appends keep failing — ${this.unreceipted.length} unreconciled wake batches exceed the sidecar cap; inspect the ledger`,
        );
      }
      this.unreceipted.push(batch);
      this.persistWakeState();
      if (this.appendWakeReceipt(batch, false)) {
        this.unreceipted.splice(this.unreceipted.indexOf(batch), 1);
      } else {
        this.log('error', 'gru wake receipt append failed — parked as unreceipted, retrying', {
          notification_ids: delivered,
        });
        this.scheduleReceiptRetry();
      }
      this.failedRetryAtMs = 0;
      this.log('info', 'gru wake opened', { notification_ids: delivered, count: delivered.length, mode: this.wakeMode });
      this.persistWakeState();
      // Issue #224 escalation-triage shadow ask at the delivery receipt —
      // the exact point the labelled extractor links (the gru.wake
      // notification_ids), so backtest states and production states share
      // one unit of decision: the delivered wake batch. Fully isolated:
      // a failure here must never touch the wake path.
      try {
        this.recordEscalationTriageShadow(delivered);
      } catch (error) {
        this.log('error', 'escalation-triage shadow ask setup failed; wake behavior unchanged', { error: String(error) });
      }
      this.flushPendingWakes();
      return;
    }
    const reason = detail !== undefined && detail !== '' ? detail : 'no alert context delivered';
    this.wakePolicy.attempted(this.now());
    this.recordWakeFailure(reason, active);
    this.persistWakeState();
    // A failed spawn/prompt must not burn the id. Bound retries so a broken
    // runtime cannot storm when the configured minimum interval is zero.
    if (this.pendingWakeIds.size > 0) {
      this.failedRetryAtMs = this.now() + 5_000;
      this.flushPendingWakes();
    }
  }

  /** The block already reached Gru: retain its receipt and deadline even
   * when the remainder of the turn fails. Issue #115: the incidents go
   * back to the pending set with a BOUNDED retry on the existing backoff
   * — their wake claim (id + incident key) rolls back so the retry can
   * re-claim; the receipt stays (the turn DID open). Once the bound is
   * spent, exactly one truthful needs-owner escalation per incident
   * replaces the autonomous path (owner stops are never self-armed by
   * machines — the escalation is a notice, not a breaker). */
  noteWakeTurnFailure(detail: string, injection: AwarenessInjection): void {
    if (this.disposed) return;
    const ids = injection.notificationIds ?? [];
    this.recordWakeFailure(detail, ids);
    const retried: string[] = [];
    const escalated: string[] = [];
    for (const id of ids) {
      const count = (this.wakeFailures.get(id) ?? 0) + 1;
      if (count > WAKE_FAILURE_RETRIES) {
        this.wakeFailures.delete(id);
        escalated.push(id);
      } else {
        this.wakeFailures.set(id, count);
        retried.push(id);
      }
    }
    if (retried.length > 0) {
      for (const id of retried) {
        this.pendingWakeIds.add(id);
        const row = this.ledger.getNotification(id);
        this.wakePolicy.forget(id);
        if (row !== null) this.wakePolicy.forgetIncident(incidentKeyOf(row));
      }
      this.persistWakeState();
      this.failedRetryAtMs = this.now() + 5_000;
      this.flushPendingWakes();
    }
    // One escalation per INCIDENT (issue #219 review): a coalesced batch
    // can carry two ids of the same already-woken-key incident — they
    // group onto one owner stop, never one per notification id.
    const byIncident = new Map<string, string[]>();
    for (const id of escalated) {
      const row = this.ledger.getNotification(id);
      const key = row === null ? `\u0000id:${id}` : incidentKeyOf(row);
      const group = byIncident.get(key) ?? [];
      group.push(id);
      byIncident.set(key, group);
    }
    for (const [key, group] of byIncident) this.escalateFailedWake(key, group, detail);
  }

  /** Unsafe recovery cannot open a Gru turn. Preserve the pending batch,
   * record the failure and put an explicit needs-owner stop on the bell. */
  noteWakeBlocked(reason: string): void {
    if (this.disposed) return;
    const active = this.activeWakeIds ?? [];
    for (const id of active) {
      const row = this.ledger.getNotification(id);
      if (row?.routing !== 'action-required' || row.ackedAt !== null || row.resolvedAt !== null) continue;
      const escalationId = `gru-wake-blocked:${id}`;
      try {
        const existing = this.ledger.getNotification(escalationId);
        if (existing !== null && (existing.kind !== `gru.wake-blocked.${id}` || existing.routing !== 'needs-owner')) {
          throw new Error(`Gru blocked-wake ID ${escalationId} is already assigned to another notification`);
        }
        if (existing === null) {
          const posted = this.ledger.recordNotification({
            id: escalationId,
            kind: `gru.wake-blocked.${id}`,
            routing: 'needs-owner',
            severity: 'error',
            title: `Gru wake blocked: ${row.title}`,
            detail: `Notification ${id} could not reach Gru (${reason}). Restart the service to recover chat safely; the machine alert remains pending for retry.`,
          });
          try { this.onFollowUpPosted(posted); } catch (error) {
            this.log('error', 'gru blocked-wake chat notice failed', { notification_id: id, error: String(error) });
          }
        }
      } catch (error) {
        this.log('error', 'gru blocked-wake owner escalation failed; retrying', { notification_id: id, error: String(error) });
      }
    }
    this.noteWakeOutcome(false, `chat recovery blocked: ${reason}`);
  }

  private recordWakeFailure(reason: string, ids: readonly string[]): void {
    this.log('error', 'gru wake turn failed', { error: reason, notification_ids: ids });
    try {
      this.ledger.appendCustomEvent({ kind: 'gru.wake-failed', payload: { error: reason, notification_ids: ids } });
    } catch (error) {
      this.log('error', 'gru wake failure event failed', { error: String(error) });
    }
  }

  /** Issue #115 terminal path: exactly one truthful needs-owner escalation
   * per incident whose bounded retries are spent. Idempotent by escalation
   * notification id (keyed by the incident, so two ids of one incident
   * share the stop) — a repeat failure never spams the bell. A FAILED
   * escalation posting is never silent: the ids re-arm as pending on the
   * existing backoff, so the bounded cycle runs again and the escalation
   * is retried until the ledger takes it. */
  private escalateFailedWake(incidentKey: string, ids: readonly string[], detail: string): void {
    const open = ids
      .map((id) => ({ id, row: this.ledger.getNotification(id) }))
      .filter(({ row }) => row !== null && row.ackedAt === null && row.resolvedAt === null)
      .map(({ id, row }) => ({ id, row: row as NotificationRecord }));
    if (open.length === 0) return;
    for (const { id } of open) {
      if (this.pendingWakeIds.delete(id)) this.persistWakeState();
    }
    const representative = open[0]!.row;
    this.recordDeferred(
      { id: representative.id, incidentKey, routing: representative.routing, severity: representative.severity },
      'failed',
      null,
    );
    // Escalation identity: the incident key, sanitized and bounded — two
    // ids of one incident share one stop.
    const sanitized = incidentKey.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
    const escalationId = `gru-wake-failed:${sanitized}`;
    const kind = `gru.wake-failed-escalation.${sanitized}`;
    const idList = open.map(({ id }) => id).join(', ');
    try {
      const existing = this.ledger.getNotification(escalationId);
      if (existing !== null && (existing.kind !== kind || existing.routing !== 'needs-owner')) {
        throw new Error(`Gru failed-wake escalation id ${escalationId} is already assigned to another notification`);
      }
      if (existing === null) {
        const posted = this.ledger.recordNotification({
          id: escalationId,
          kind,
          routing: 'needs-owner',
          severity: 'error',
          title: `Gru wake turn failed repeatedly: ${representative.title}`,
          detail:
            `Autonomous wake retries (${WAKE_FAILURE_RETRIES}) for incident ${incidentKey} failed on notification(s) ${idList}; ` +
            `last error: ${detail}. The machine alert remains open — this stop replaces the autonomous path until you act.`,
        });
        try { this.onFollowUpPosted(posted); } catch (error) {
          this.log('error', 'gru failed-wake chat notice failed', { notification_ids: ids, error: String(error) });
        }
      }
    } catch (error) {
      // The escalation is OWED (issue #219 review): re-arm a fresh bounded
      // cycle so the next exhaustion retries the owner stop — never a
      // silently stranded incident.
      this.log('error', 'gru failed-wake owner escalation failed; re-arming the bounded retry cycle', {
        incident_key: incidentKey,
        notification_ids: ids,
        error: String(error),
      });
      for (const { id, row } of open) {
        this.wakeFailures.delete(id);
        this.pendingWakeIds.add(id);
        this.wakePolicy.forget(id);
        this.wakePolicy.forgetIncident(incidentKeyOf(row));
      }
      this.persistWakeState();
      this.failedRetryAtMs = this.now() + 5_000;
      this.flushPendingWakes();
    }
  }

  /** Issue #112: append ONE wake receipt. Never throws — the boolean tells
   * the caller whether the ledger took it. `reconciled` marks a boot-time
   * repair so the board can tell the two apart. */
  private appendWakeReceipt(
    batch: { readonly id?: string; readonly ids: readonly string[]; readonly at: number },
    reconciled: boolean,
  ): boolean {
    try {
      this.ledger.appendCustomEvent({
        kind: 'gru.wake',
        payload: {
          notification_ids: batch.ids,
          count: batch.ids.length,
          mode: this.wakeMode,
          ...(batch.id !== undefined ? { wake_id: batch.id } : {}),
          ...(reconciled ? { reconciled: true } : {}),
          wake_at: new Date(batch.at).toISOString(),
        },
      });
      return true;
    } catch (error) {
      this.log('error', 'gru wake ledger event failed', { error: String(error) });
      return false;
    }
  }

  private scheduleReceiptRetry(): void {
    if (this.disposed || this.receiptTimer !== null) return;
    const timer = setTimeout(() => {
      this.receiptTimer = null;
      this.retryUnreceiptedReceipts();
    }, WAKE_RECEIPT_RETRY_MS);
    (timer as { unref?: () => void }).unref?.();
    this.receiptTimer = timer;
  }

  /** Retry the parked receipt appends (issue #112). On success the batch
   * graduates (already claimed by the park-first protocol — only the
   * receipt was owed); the delivery timestamp stays the ORIGINAL wake
   * time, never the retry. A still-failing ledger re-arms the retry —
   * the receipt can never stay missing while the process runs. */
  private retryUnreceiptedReceipts(): void {
    if (this.disposed) return;
    let changed = false;
    while (this.unreceipted.length > 0) {
      const batch = this.unreceipted[0] as { readonly id?: string; readonly ids: readonly string[]; readonly at: number };
      if (!this.appendWakeReceipt(batch, false)) break;
      this.unreceipted.shift();
      this.claimDeliveredBatch(batch);
      changed = true;
    }
    if (changed) this.persistWakeState();
    if (this.unreceipted.length > 0) this.scheduleReceiptRetry();
  }

  /** Issue #112 boot reconciliation: a wake batch parked as unreceipted is
   * repaired exactly once — if the ledger provably holds the receipt (the
   * receipt carrying the batch's stable `wake_id`), the parked copy is
   * dropped; if not, the receipt is appended here. Either way the ids are
   * (already) claimed: never a duplicate turn, never a lost board total. */
  private reconcileUnreceiptedReceipts(): void {
    if (this.unreceipted.length === 0) return;
    const receiptIds = new Set(
      this.wakeReceiptsSince(this.unreceipted[0]?.at ?? 0)
        .map((receipt) => ('wake_id' in receipt ? String(receipt['wake_id']) : null))
        .filter((id): id is string => id !== null),
    );
    let changed = false;
    while (this.unreceipted.length > 0) {
      const batch = this.unreceipted[0] as { readonly id?: string; readonly ids: readonly string[]; readonly at: number };
      const delivered = batch.id !== undefined && receiptIds.has(batch.id);
      if (!delivered && !this.appendWakeReceipt(batch, true)) break;
      this.unreceipted.shift();
      this.claimDeliveredBatch(batch);
      changed = true;
    }
    if (changed) this.persistWakeState();
  }

  /** Claim a delivered batch in the dedupe state (ids + incident keys).
   * Idempotent — parking re-claims what the receipt success would claim.
   * wakeFailures survives here too (see noteWakeOutcome). */
  private claimDeliveredBatch(batch: { readonly ids: readonly string[]; readonly at: number }): void {
    for (const id of batch.ids) {
      this.pendingWakeIds.delete(id);
    }
    const keys = batch.ids
      .map((id) => this.ledger.getNotification(id))
      .filter((row): row is NotificationRecord => row !== null)
      .map((row) => incidentKeyOf(row));
    this.wakePolicy.fired(batch.ids, batch.at, keys);
  }

  /** The payloads of `gru.wake` events at/after `sinceMs` (issue #112
   * reconciliation probe) — id sets plus the stable batch id when present. */
  private wakeReceiptsSince(sinceMs: number): readonly Record<string, unknown>[] {
    const sinceIso = new Date(Math.max(0, sinceMs - 60_000)).toISOString();
    const receipts: Record<string, unknown>[] = [];
    let cursor = 0;
    for (;;) {
      const page = this.ledger.listEventsAfter(cursor, { kinds: ['gru.wake'], limit: 500 });
      for (const event of page) {
        cursor = event.seq;
        if (event.ts < sinceIso) continue;
        const ids = payloadOf(event)['notification_ids'];
        if (Array.isArray(ids) && ids.every((id) => typeof id === 'string' && id !== '')) {
          receipts.push(payloadOf(event));
        }
      }
      if (page.length < 500) break;
    }
    return receipts;
  }

  private render(
    actionNotes: readonly { id: string; line: string }[],
    receiptNotes: readonly { id: string; line: string }[],
    digestLines: readonly string[],
    overflow: boolean,
    morning: readonly string[] | null,
  ): { text: string; ids: readonly string[] } | null {
    const parts: string[] = [AWARENESS_BLOCK_HEADER];
    const ids: string[] = [];
    let bytes = Buffer.byteLength(AWARENESS_BLOCK_HEADER, 'utf8');
    let truncated = overflow;
    let exhausted = false;
    const push = (line: string, force = false): boolean => {
      if (exhausted && !force) return false;
      const sized = clampLine(line, this.limits.maxLineChars);
      const size = Buffer.byteLength(sized, 'utf8') + 1; // newline
      if (bytes + size > this.limits.maxBytes) {
        truncated = true;
        exhausted = true;
        return false;
      }
      parts.push(sized);
      bytes += size;
      return true;
    };

    if (actionNotes.length > 0 && push(this.wakeMode === 'all' ? 'Notifications (unacknowledged):' : 'Action required (unacknowledged):')) {
      for (const note of actionNotes) {
        // Never claim an ID whose identifier was clipped by the line/byte
        // bounds. A truncated title is fine; an invisible ID is not.
        if (push(note.line) && parts.at(-1)?.includes(`[${note.id}]`)) ids.push(note.id);
      }
    }
    if (receiptNotes.length > 0 && push('Closed receipts (no action required; kept for reference):')) {
      for (const note of receiptNotes) {
        if (push(note.line) && parts.at(-1)?.includes(`[${note.id}]`)) ids.push(note.id);
      }
    }
    if (morning !== null) for (const line of morning) push(line);
    if (digestLines.length > 0) {
      push('Since your last turn:');
      for (const line of digestLines) push(line);
    }
    if (parts.length === 1) return null;
    if (truncated) push('- (further context omitted…)', true);
    return { text: parts.join('\n'), ids };
  }

  /**
   * Rotated open needs-owner page for a passive block (GH-109): sampling
   * only the newest rows starved every older open row once the sustained
   * queue outgrew the block. Each block reads one bounded page starting at
   * the queue's rotation offset; an empty page means the offset landed
   * exactly on the consumed tail, so the cycle restarts at the newest rows
   * within the same block instead of spending a user turn on nothing.
   *
   * Offsets page a live queue: rows created between blocks shift the
   * window. Coverage of a stable backlog is the GH-109 contract — arrival
   * churn extends the cycle by the inserted volume rather than breaking
   * it. The advance itself is computed by {@link advancePastRendered} from
   * the rows a delivered block actually rendered.
   */
  private rotatedOwnerQueue(): {
    readonly offset: number;
    readonly rows: readonly NotificationRecord[];
    /** Advance for a block that composed no owner rows (nothing to show):
     * an empty page is the consumed tail — wrap to the newest rows. */
    readonly noLiveAdvance: number;
  } {
    const pageSize = this.limits.maxActionNotes;
    let offset = this.attentionRotation.owner;
    let page = this.ledger.listNotifications({
      routing: 'needs-owner', unackedOnly: true, limit: pageSize, offset,
    });
    if (page.length === 0 && offset > 0) {
      offset = 0;
      page = this.ledger.listNotifications({
        routing: 'needs-owner', unackedOnly: true, limit: pageSize, offset,
      });
    }
    return { offset, rows: page, noLiveAdvance: 0 };
  }

  /**
   * Rotated open action-required page for a passive block (GH-109), split
   * into live machine attention and this page's closed receipts (D1). The
   * page overfetches so receipts cannot crowd live rows out of the bounded
   * slots. An empty page (offset landed exactly on the consumed tail)
   * restarts at the newest rows within the same block.
   *
   * Offsets page a live queue: rows created between blocks shift the
   * window (stable-backlog coverage is the GH-109 contract; arrival churn
   * extends the cycle rather than breaking it). A full page holding only
   * receipts is skipped in one step — a receipt wall must not stall live
   * coverage.
   */
  private rotatedMachineQueue(): {
    readonly offset: number;
    readonly live: readonly NotificationRecord[];
    readonly receiptRows: readonly NotificationRecord[];
    /** Advance for a block that composed no live rows: skip a full
     * receipts-only page in one step; a short page wraps to the newest. */
    readonly noLiveAdvance: number;
  } {
    const pageSize = this.limits.maxActionNotes;
    // Overfetch so receipts cannot crowd live rows out of the page; each
    // side is then sliced to the block's bounded slots.
    const fetchLimit = Math.max(pageSize * 4, 16);
    let offset = this.attentionRotation.machine;
    let page = this.ledger.listNotifications({
      routing: 'action-required', unackedOnly: true, limit: fetchLimit, offset,
    });
    if (page.length === 0 && offset > 0) {
      offset = 0;
      page = this.ledger.listNotifications({
        routing: 'action-required', unackedOnly: true, limit: fetchLimit, offset,
      });
    }
    const { receipts, live } = this.classifyNotifications(page);
    const liveSlots = live.slice(0, pageSize);
    return {
      offset,
      live: liveSlots,
      receiptRows: page.filter((row) => receipts.has(row.id)).slice(0, pageSize),
      noLiveAdvance: page.length < pageSize ? 0 : offset + page.length,
    };
  }

  /**
   * Rotation advance from what a delivered block actually rendered (GH-109):
   * move to the first composed row the block did NOT render — rows the block
   * closed mid-flight count as consumed — or past the last composed row when
   * everything rendered. Rows skipped by slot or byte caps therefore lead the
   * next block; no open row is ever passed over twice, and a block whose
   * first candidate stayed invisible leaves the offset untouched.
   */
  private advancePastRendered(
    offset: number,
    candidates: readonly { readonly id: string; readonly position: number }[],
    renderedIds: ReadonlySet<string>,
  ): number {
    let lastConsumed = -1;
    for (const candidate of candidates) {
      if (renderedIds.has(candidate.id)) {
        lastConsumed = candidate.position;
        continue;
      }
      const row = this.ledger.getNotification(candidate.id);
      if (row === null || row.ackedAt !== null || row.resolvedAt !== null) {
        lastConsumed = candidate.position;
        continue;
      }
      break; // still open and undelivered — it leads the next block
    }
    return lastConsumed >= 0 ? lastConsumed + 1 : offset;
  }

  /** "While you were away" digest (owner ruling 2026-09-23): the first
   * delivered block after a quiet gap summarises delivered wakes (fires), actions,
   * merges, and staged PRs from the ledger — the morning catch-up. Derived
   * from the ledger alone; null when the gap was short or nothing landed. */
  private morningDigest(): readonly string[] | null {
    if (this.morningDigestGapMs <= 0 || this.lastOwnerAt === null) return null;
    const since = this.lastOwnerAt;
    if (this.now() - since < this.morningDigestGapMs) return null;
    const lines: string[] = [];
    const push = (line: string): void => {
      if (lines.length < MAX_MORNING_LINES) lines.push(line);
    };
    const capped = (label: string, count: number, noun: string): void => {
      if (count > 0) push(`- ${label}: ${count >= 101 ? '100+' : count} ${noun}${count === 1 ? '' : 's'}`);
    };
    const wakes = this.ledger.listEventsAfter(this.lastOwnerSeq, { kinds: ['gru.wake'], limit: 101 });
    capped('fires', wakes.length, 'wake delivered');
    const boardActions = this.ledger.listEventsAfter(this.lastOwnerSeq, { kinds: [...MORNING_ACTION_KINDS], limit: 101 });
    const resolutions = this.ledger.listEventsAfter(this.lastOwnerSeq, { kinds: ['notification.resolved'], limit: 101, order: 'desc' });
    const actionCount = boardActions.length + resolutions.length;
    if (actionCount > 0) push(`- actions: ${boardActions.length >= 101 || resolutions.length >= 101 ? '100+' : actionCount} board event${actionCount === 1 ? '' : 's'}`);
    const latestDisposition = resolutions.find((event) => payloadOf(event)['by'] === 'gru');
    if (latestDisposition !== undefined) {
      push(clampLine(`- Gru disposition [${textOf(payloadOf(latestDisposition)['id']) ?? '?'}]: ${textOf(payloadOf(latestDisposition)['detail']) ?? 'no detail recorded'}`, this.limits.maxLineChars));
    }
    const jobs = this.ledger.listJobs();
    const list = (ids: readonly string[]): string =>
      `${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ` +${ids.length - 3} more` : ''}`;
    const merges = jobs.filter((job) => job.status === 'merged' && Date.parse(job.updatedAt) > since);
    if (merges.length > 0) push(`- merges: ${list(merges.map((job) => job.id))}`);
    const staged = jobs.filter(
      (job) => job.prUrl !== null && !isJobTerminal(job.status),
    );
    if (staged.length > 0) push(`- staged PRs: ${list(staged.map((job) => job.id))}`);
    if (lines.length === 0) return null;
    return [`While you were away (since ${new Date(since).toISOString()}):`, ...lines];
  }

  private persist(): void {
    const state: AwarenessState = {
      coveredThroughSeq: this.cursor,
      wake: {
        version: 2,
        ...this.wakePolicy.snapshot(),
        pending: [...this.pendingWakeIds],
        ...(this.unreceipted.length > 0 ? { unreceipted: this.unreceipted.map((batch) => ({ id: batch.id, ids: [...batch.ids], at: batch.at })) } : {}),
        ...(this.wakeFailures.size > 0 ? { wakeFailures: Object.fromEntries(this.wakeFailures) } : {}),
      },
      digest: { lastDeliveredAt: this.lastDeliveredAt, lastOwnerAt: this.lastOwnerAt, lastOwnerSeq: this.lastOwnerSeq },
      attention: { machineOffset: this.attentionRotation.machine, ownerOffset: this.attentionRotation.owner },
    };
    const staging = `${this.file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      writeFileSync(staging, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
      renameSync(staging, this.file);
    } catch (error) {
      try {
        rmSync(staging, { force: true });
      } catch {
        /* best effort — the active state was never replaced */
      }
      throw error;
    }
  }

  /** Wake policy decision on one bus event (notification rows only). The
   * persisted row — not the event payload — is the authority for routing
   * and severity: `notification.triaged` carries no severity, and a row
   * acked/resolved in the write that published the event must never wake. */
  private onBusEvent(event: BusEvent): void {
    if (this.disposed) return;
    if (event.kind === 'notification.acked' || event.kind === 'notification.resolved') {
      const closedId = textOf(payloadOf(event)['id']);
      if (closedId !== null) {
        const row = this.ledger.getNotification(closedId);
        // Issue #115: a closed row needs no failure bookkeeping, and its
        // recorded deferrals/escalations must not re-fire stale guards.
        // (Mutate BEFORE the persist so the sidecar never keeps a spent debt.)
        const hadFailure = this.wakeFailures.delete(closedId);
        for (const [key, entry] of this.deferredRechecks) {
          if (entry.notificationId === closedId) this.deferredRechecks.delete(key);
        }
        const wasDelivered = this.wakePolicy.forget(closedId);
        if (wasDelivered || hadFailure) this.persistWakeState();
        // Close any historical timeout follow-up on explicit Gru disposition.
        if (row?.routing === 'action-required') {
          const followUp = this.ledger.getNotification(this.followUpId(closedId));
          if (followUp?.kind === this.followUpKind(closedId)) {
            this.ledger.resolveNotificationById(followUp.id, 'gru-disposition');
          }
        }
      }
      return;
    }
    if (this.wakeMode === 'never') return;
    if (event.kind !== 'notification.created' && event.kind !== 'notification.triaged') return;
    const payload = payloadOf(event);
    const id = textOf(payload['id']);
    if (id === null) return;
    // Terminal rows never wake — the human already closed the item. A row
    // that is now a closed receipt is not wake-eligible either; drop any
    // stored seed it may hold (owner decision D1).
    const row = this.ledger.getNotification(id);
    if (row === null || row.ackedAt !== null || row.resolvedAt !== null) return;
    if (this.isReceiptNotification(row.agentId)) {
      if (this.pendingWakeIds.delete(row.id)) this.persistWakeState();
      return;
    }
    this.considerCandidate({
      id: row.id,
      incidentKey: incidentKeyOf(row),
      routing: row.routing,
      severity: row.severity,
    });
  }

  /** Issue #224 escalation-triage SHADOW ask, fired at the delivery
   * receipt for one delivered wake batch whose rows include
   * Silas-authored escalations. SHADOW ONLY: the callers gate on the
   * surface's explicit `shadow` mode plus readiness, the runtime records
   * what the provider WOULD have triaged next to the deterministic
   * baseline and still serves the deterministic answer, and this layer
   * ignores the outcome — wake behavior cannot change. Fire-and-forget
   * with isolated logging; never delays the wake path. The state shape
   * is the labelled extractor's exactly: one wake (`notification_count`
   * over the whole delivered batch — the same ids the `gru.wake` event
   * records, which is what the extractor links on), the Silas-authored
   * escalation rows inside it, and — when the subjects carry any —
   * decision memory (#218). */
  private recordEscalationTriageShadow(deliveredIds: readonly string[]): void {
    if (this.decisions === null) return;
    if (this.readyForSurface?.(DECISION_SURFACE_ESCALATION_TRIAGE) !== true) return;
    if (this.modeForSurface?.(DECISION_SURFACE_ESCALATION_TRIAGE) !== 'shadow') return;
    const rows = deliveredIds
      .map((id) => this.ledger.getNotification(id))
      .filter((row): row is NotificationRecord => row !== null && isSilasEscalationKind(row.kind));
    if (rows.length === 0) return;
    const dedupeKey = rows.map((row) => row.id).sort().join('\u0000');
    if (this.askedEscalations.has(dedupeKey)) return;
    if (this.askedEscalations.size >= 512) {
      const oldest = this.askedEscalations.values().next().value;
      if (oldest !== undefined) this.askedEscalations.delete(oldest);
    }
    this.askedEscalations.add(dedupeKey);
    const escalations: readonly EscalationFacts[] = rows.map((row) => ({ kind: row.kind, title: row.title, detail: row.detail }));
    // Decision memory (#218) read-only context for the escalated
    // subjects; absent rows (or an optional-less ledger port) simply ask
    // without the context keys, exactly like the labelled states.
    const memory: { openDecisions?: readonly DecisionMemoryFacts[]; recentDispositions?: readonly DecisionMemoryFacts[] } = {};
    if (this.ledger.listDecisions !== undefined) {
      const subjects = [
        ...new Set(
          rows.map((row) => {
            const agent = row.agentId !== null ? this.ledger.listAgents().find((candidate) => candidate.id === row.agentId) : undefined;
            return escalationDecisionSubject(row.kind, agent?.jobId ?? null);
          }),
        ),
      ].filter((subject): subject is string => subject !== null);
      if (subjects.length > 0) {
        const toFacts = (decision: DecisionRecord): DecisionMemoryFacts => ({
          decision: decision.decision,
          reason: decision.reason,
          by: decision.by,
          covers: decision.covers.join(','),
          basis_fingerprint: decision.basisFingerprint,
          recheck_at: decision.recheckAt,
        });
        try {
          const open = subjects.flatMap((subject) => this.ledger.listDecisions!({ subject, activeOnly: true, limit: 4 }));
          if (open.length > 0) memory['openDecisions'] = open.slice(0, 12).map(toFacts);
          const recent = subjects.flatMap((subject) => this.ledger.listDecisions!({ subject, limit: 3 }));
          if (recent.length > 0) memory['recentDispositions'] = recent.slice(0, 12).map(toFacts);
        } catch (error) {
          // Memory is enrichment: a failed read still asks, just without it.
          this.log('debug', 'decision memory read for escalation triage failed; asking without it', {
            error: String(error),
          });
        }
      }
    }
    void this.decisions
      .decide(
        escalationTriageDecisionRequest({
          escalations,
          mode: this.wakeMode,
          ...(memory['openDecisions'] !== undefined ? { openDecisions: memory['openDecisions'] } : {}),
          ...(memory['recentDispositions'] !== undefined ? { recentDispositions: memory['recentDispositions'] } : {}),
        }),
        { surface: DECISION_SURFACE_ESCALATION_TRIAGE },
      )
      .catch((error: unknown) => {
        this.log('error', 'escalation-triage shadow ask failed; wake behavior unchanged', {
          error: String(error),
        });
      });
  }

  /** The shared admission path (issue #219): the policy gates (mode,
   * routing, severity, ID + incident dedupe), then the hold-coverage
   * query. 'skip' and 'deferred' end the candidate; 'admit' carries the
   * schedule decision for the caller's batching (bus events flush
   * immediately; the boot backlog flushes once). */
  private admitPath(
    candidate: WakeCandidate,
  ): { readonly action: 'skip' | 'deferred' } | { readonly action: 'admit'; readonly decision: WakeDecision } {
    // An unreceipted wake (issue #112) already delivered these IDs — a
    // replayed event must not open a duplicate turn while the receipt is
    // still owed.
    if (this.unreceipted.some((batch) => batch.ids.includes(candidate.id))) {
      this.log('debug', 'gru wake suppressed — delivered batch awaits its receipt', {
        notification_id: candidate.id,
      });
      return { action: 'skip' };
    }
    const decision = this.wakePolicy.decide(candidate, this.now());
    if (decision.action === 'skip') {
      if (decision.reason === 'duplicate-incident') {
        // Hard floors bypass incident dedupe: a re-armed breaker or
        // provider wall for the same subject is a NEW wake obligation
        // (its predecessor row was resolved to re-arm it). ID dedupe
        // still applies to the same open row.
        const floorRow = this.ledger.getNotification(candidate.id);
        if (floorRow !== null && isHardFloorRow(floorRow)) {
          return { action: 'admit', decision: { action: 'wake' } as WakeDecision };
        }
        // Issue #219: a re-detected incident under a NEW row id is the
        // avoidance signal the board reports — record it once per row.
        this.recordDeferred(candidate, 'duplicate', null);
      }
      this.log('debug', 'gru wake suppressed', {
        notification_id: candidate.id,
        incident_key: candidate.incidentKey,
        routing: candidate.routing,
        severity: candidate.severity,
        reason: decision.reason,
      });
      return { action: 'skip' };
    }
    const row = this.ledger.getNotification(candidate.id);
    const covering = row !== null ? this.coverageFor(row) : null;
    if (covering !== null) {
      this.deferCoveredWake(row as NotificationRecord, covering);
      return { action: 'deferred' };
    }
    return { action: 'admit', decision };
  }

  /** Route/severity/dedupe gate, then cover/claim or defer — never fire
   * twice for the same id or incident, never fire through the cap of the
   * rate limit, and never wake an incident a current decision covers
   * (issue #219 hold-covered deferral; hard floors never defer). */
  private considerCandidate(candidate: WakeCandidate): void {
    const path = this.admitPath(candidate);
    if (path.action !== 'admit') return;
    this.considerCandidateAdmitted(candidate, path.decision);
  }

  private considerCandidateAdmitted(candidate: WakeCandidate, decision: WakeDecision): void {
    this.pendingWakeIds.add(candidate.id);
    this.persistWakeState();
    if (decision.action === 'wake') {
      this.flushPendingWakes();
      return;
    }
    if (decision.action === 'defer') {
      this.scheduleWake(decision.retryAtMs, decision.reason);
    }
  }

  /** The hold-coverage query for one open row (issue #218 + #219): null
   * when the row may wake — deferral disabled, a hard floor, or no active
   * basis-matched decision covers its (subject, signal). */
  private coverageFor(row: NotificationRecord): DecisionRecord | null {
    if (!this.coveredDeferralEnabled) return null;
    if (isHardFloorRow(row)) return null;
    try {
      return this.ledger.coveringDecision({
        subject: incidentSubjectOf(row),
        signal: incidentSignalOf(row),
        basis: incidentBasisOf(row),
      });
    } catch (error) {
      // A malformed decision row must not take the wake path down: treat
      // coverage as absent (fail toward waking) and leave the failure loud.
      this.log('error', 'gru wake coverage query failed — waking', {
        notification_id: row.id,
        error: String(error),
      });
      return null;
    }
  }

  /** Hold-covered deferral (issue #219): the notification stays visible
   * exactly as today; the wake is deferred to the decision's recheck (or
   * the 60-minute bound) and recorded once on the board's avoidance
   * stream. When the recheck passes or the basis changes, the coverage
   * query stops answering and the incident is wake-eligible again. */
  private deferCoveredWake(row: NotificationRecord, covering: DecisionRecord): void {
    const recheckFromDecision =
      covering.recheckAt !== null ? Date.parse(covering.recheckAt) : Number.NaN;
    const recheckAtMs =
      Number.isFinite(recheckFromDecision)
        ? Math.min(recheckFromDecision, this.now() + WAKE_COVERED_RECHECK_BOUND_MS)
        : this.now() + WAKE_COVERED_RECHECK_BOUND_MS;
    this.recordDeferred(
      { id: row.id, incidentKey: incidentKeyOf(row), routing: row.routing, severity: row.severity },
      'covered',
      covering.id,
      new Date(recheckAtMs).toISOString(),
    );
    this.deferredRechecks.set(incidentKeyOf(row), {
      atMs: Math.max(recheckAtMs, this.now() + 1),
      decisionId: covering.id,
      notificationId: row.id,
    });
    this.log('info', 'gru wake deferred — covered by an active decision', {
      notification_id: row.id,
      incident_key: incidentKeyOf(row),
      decision_id: covering.id,
      recheck_at: new Date(recheckAtMs).toISOString(),
    });
    this.armDeferredRecheck();
  }

  /** Append the board's avoidance record (issue #219): ONE
   * `gru.wake-deferred` event per (reason, notification id) — durable, so
   * a restart's backlog re-seed cannot double-count a still-covered row
   * on the board and the yield report. The in-memory guard short-circuits
   * the common repeat (created + triaged for the same row); the ledger
   * scan is the durable backstop. */
  private recordDeferred(
    candidate: Pick<WakeCandidate, 'id' | 'incidentKey' | 'routing' | 'severity'>,
    reason: 'covered' | 'duplicate' | 'failed',
    decisionId: string | null,
    recheckAt?: string,
  ): void {
    const guard = `${reason}:${candidate.id}`;
    if (this.deferredRecorded.has(guard)) return;
    if (this.hasDeferredEvent(reason, candidate.id)) {
      this.deferredRecorded.add(guard);
      return;
    }
    this.deferredRecorded.add(guard);
    try {
      this.ledger.appendCustomEvent({
        kind: 'gru.wake-deferred',
        payload: {
          reason,
          notification_id: candidate.id,
          incident_key: candidate.incidentKey,
          ...(decisionId !== null ? { decision_id: decisionId } : {}),
          ...(recheckAt !== undefined ? { recheck_at: recheckAt } : {}),
        },
      });
    } catch (error) {
      this.deferredRecorded.delete(guard);
      this.log('error', 'gru wake-deferred event failed', { error: String(error) });
    }
  }

  /** Durable deferral idempotency: does the avoidance stream already hold
   * an event for this (reason, notification id)? Bounded scan — the
   * stream grows once per suppressed wake, never per notification event. */
  private hasDeferredEvent(reason: string, notificationId: string): boolean {
    let cursor = 0;
    for (;;) {
      const page = this.ledger.listEventsAfter(cursor, { kinds: ['gru.wake-deferred'], limit: 500 });
      for (const event of page) {
        cursor = event.seq;
        const payload = payloadOf(event);
        if (payload['reason'] === reason && payload['notification_id'] === notificationId) return true;
      }
      if (page.length < 500) break;
    }
    return false;
  }

  /** Release the earliest covered-deferral recheck: re-run the incident
   * through the ordinary admission path. The coverage query decides — a
   * re-hold defers again, a passed recheck or changed basis wakes. */
  private armDeferredRecheck(): void {
    if (this.disposed) return;
    let earliest: number | null = null;
    for (const entry of this.deferredRechecks.values()) {
      if (earliest === null || entry.atMs < earliest) earliest = entry.atMs;
    }
    if (earliest === null) return;
    if (this.deferredTimer !== null && this.deferredTimerAt !== null && this.deferredTimerAt <= earliest) return;
    if (this.deferredTimer !== null) clearTimeout(this.deferredTimer);
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, earliest - this.now()));
    this.deferredTimerAt = earliest;
    const timer = setTimeout(() => {
      this.deferredTimer = null;
      this.deferredTimerAt = null;
      this.releaseCoveredRechecks();
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.deferredTimer = timer;
  }

  private releaseCoveredRechecks(): void {
    const now = this.now();
    const due = [...this.deferredRechecks.entries()].filter(([, entry]) => entry.atMs <= now);
    for (const [key, entry] of due) {
      this.deferredRechecks.delete(key);
      const row = this.ledger.getNotification(entry.notificationId);
      if (row === null || row.ackedAt !== null || row.resolvedAt !== null) continue;
      if (this.isReceiptNotification(row.agentId)) continue;
      this.considerCandidate({
        id: row.id,
        incidentKey: incidentKeyOf(row),
        routing: row.routing,
        severity: row.severity,
      });
    }
    this.armDeferredRecheck();
  }

  private followUpId(id: string): string {
    return `gru-follow-up:${id}`;
  }

  private followUpKind(id: string): string {
    return `gru.attention-unresolved.${id}`;
  }

  /** Ledger receipts survive a torn or failed awareness.json write. Replay
   * every successful delivery before backlog admission so restart cannot
   * open a second autonomous turn for an already-delivered open ID. The
   * replay claims incident keys too (issue #219): a receipt for a row
   * spends its incident's key exactly as a live wake would. One deliberate
   * exception (issue #115): ids sitting in bounded failed-turn retry are
   * unclaimed ON PURPOSE — their receipt records the failed turn, the
   * retry still owes an autonomous attempt. */
  private reconcileWakeReceipts(): void {
    let cursor = 0;
    let changed = false;
    const known = new Set(this.wakePolicy.snapshot().woken);
    for (;;) {
      const page = this.ledger.listEventsAfter(cursor, { kinds: ['gru.wake'], limit: 500 });
      for (const event of page) {
        cursor = event.seq;
        const ids = payloadOf(event)['notification_ids'];
        if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id !== '')) continue;
        const missing = (ids as string[]).filter((id) => {
          // Issue #115: an id in bounded failed-turn retry is unclaimed ON
          // PURPOSE while it waits in pending — its receipt records the
          // failed turn, the retry still owes an autonomous attempt. A
          // debt WITHOUT a pending id is a recovered turn; claim normally.
          if (this.wakeFailures.has(id) && this.pendingWakeIds.has(id)) return false;
          const row = this.ledger.getNotification(id);
          return row !== null && row.ackedAt === null && row.resolvedAt === null && !known.has(id);
        });
        if (missing.length === 0) continue;
        for (const id of missing) known.add(id);
        const keys = missing
          .map((id) => this.ledger.getNotification(id))
          .filter((row): row is NotificationRecord => row !== null)
          .map((row) => incidentKeyOf(row));
        this.wakePolicy.fired(missing, Math.max(this.wakePolicy.snapshot().lastFiredAt ?? 0, Date.parse(event.ts) || 0), keys);
        changed = true;
      }
      if (page.length < 500) break;
    }
    if (changed) this.persistWakeState();
  }

  /** Seed unresolved rows that predate boot. The normal mode filters
   * machine routing in SQL; explicit all mode includes FYI/owner rows.
   * Seeding goes through the ordinary admission path (issue #219): a seed
   * whose incident is a duplicate or whose subject a decision covers
   * defers exactly as a fresh bus-event candidate would. */
  private seedBacklog(): void {
    if (this.wakeMode === 'never' || this.disposed) return;
    let seeded = false;
    // Keep every still-open receipt (no 256-ID eviction), but discard
    // terminal IDs from pre-upgrade state or a missed close event.
    for (const id of this.wakePolicy.snapshot().woken) {
      const row = this.ledger.getNotification(id);
      if (row === null || row.ackedAt !== null || row.resolvedAt !== null) {
        this.wakePolicy.forget(id);
        seeded = true;
      }
    }
    const before = this.pendingWakeIds.size;
    try {
      // Filter in SQL BEFORE LIMIT in machine-only mode and page every
      // matching row. Unrelated owner/FYI rows may outnumber this page.
      for (let offset = 0;; offset += MAX_BACKLOG_SEED) {
        const rows = this.ledger.listNotifications({
          unackedOnly: true, ...(this.wakeMode === 'action-required' ? { routing: 'action-required' as const } : {}),
          limit: MAX_BACKLOG_SEED, offset,
        });
        const { receipts, live } = this.classifyNotifications(rows);
        // A closed receipt is never a wake seed; a stored seed for one is
        // dropped (owner decision D1, code review 2026-10-04).
        for (const id of receipts) {
          if (this.pendingWakeIds.delete(id)) seeded = true;
        }
        for (const row of live) {
          const candidate = {
            id: row.id,
            incidentKey: incidentKeyOf(row),
            routing: row.routing,
            severity: row.severity,
          } as const;
          // ONE coalesced backlog wake (the migration rule): admission
          // gates run per row, the flush happens once after the scan.
          if (this.admitPath(candidate).action === 'admit') this.pendingWakeIds.add(row.id);
        }
        if (rows.length < MAX_BACKLOG_SEED) break;
      }
    } catch (error) {
      this.log('error', 'gru wake backlog scan failed', { error: String(error) });
      return;
    }
    if (seeded || this.pendingWakeIds.size !== before) this.persistWakeState();
    this.flushPendingWakes();
  }

  /** The ONE receipt rule for every Gru-facing reader (owner decision D1):
   * a machine row bound through an agent to a merged/done job is a closed
   * receipt, not live machine attention. The same rule the board renders;
   * unknown/unbound rows stay live. */
  private classifyNotifications<T extends { readonly id: string; readonly agentId: string | null }>(
    rows: readonly T[],
  ): { readonly receipts: Set<string>; readonly live: T[] } {
    const concluded = new Set(
      this.ledger
        .listJobs()
        .filter((job) => isJobTerminal(job.status))
        .map((job) => job.id),
    );
    if (concluded.size === 0) return { receipts: new Set(), live: [...rows] };
    const agentJob = new Map(
      this.ledger
        .listAgents()
        .filter((agent) => agent.jobId !== null)
        .map((agent) => [agent.id, agent.jobId as string]),
    );
    const receipts = new Set<string>();
    const live: T[] = [];
    for (const row of rows) {
      const jobId = row.agentId === null ? null : agentJob.get(row.agentId) ?? null;
      if (jobId !== null && concluded.has(jobId)) receipts.add(row.id);
      else live.push(row);
    }
    return { receipts, live };
  }

  /** Single-row form of {@link classifyNotifications} for event-time and
   * stored-seed checks. */
  private isReceiptNotification(agentId: string | null): boolean {
    if (agentId === null) return false;
    const agent = this.ledger.listAgents().find((candidate) => candidate.id === agentId);
    if (agent === undefined || agent.jobId === null) return false;
    const job = this.ledger.listJobs().find((candidate) => candidate.id === agent.jobId);
    return job !== undefined && isJobTerminal(job.status);
  }

  /** Release the pending batch as ONE turn when the schedule allows; while
   * it does not, arm the timer for the earliest allowed instant. */
  private flushPendingWakes(): void {
    if (this.disposed || this.activeWakeIds !== null) return;
    this.prunePending();
    if (this.pendingWakeIds.size === 0) return;
    if (this.now() < this.failedRetryAtMs) {
      const gate = this.wakePolicy.scheduleDecision(this.now());
      this.scheduleWake(Math.max(this.failedRetryAtMs, gate.action === 'defer' ? gate.retryAtMs : 0),
        gate.action === 'defer' ? gate.reason : 'rate');
      return;
    }
    const decision = this.wakePolicy.scheduleDecision(this.now());
    if (decision.action === 'defer') {
      this.scheduleWake(decision.retryAtMs, decision.reason);
      return;
    }
    if (this.wakeSink === null) return; // boot binds this later
    this.cancelWakeTimer();
    this.activeWakeIds = [...this.pendingWakeIds].slice(0, this.limits.maxActionNotes);
    // The batch is durably pending; charge the attempt only at actual chat
    // admission (a queued wake may cross into quiet hours before prompt()).
    this.persistWakeState();
    try {
      this.wakeSink();
    } catch (error) {
      this.noteWakeOutcome(false, String(error));
    }
  }

  /** Closed, rerouted, or ALREADY-CLAIMED candidates must not hold a
   * retry timer open — an id claimed by receipt replay is delivered and
   * sitting in pending only until this prune removes it. Incident dedupe
   * alone is NOT a prune reason: it is an admission decision (admitPath),
   * and pruning by it would undo the hard-floor bypass before its wake
   * could flush (issue #219 review). */
  private prunePending(): void {
    let changed = false;
    for (const id of this.pendingWakeIds) {
      const row = this.ledger.getNotification(id);
      const openAndEligible =
        row !== null && row.ackedAt === null && row.resolvedAt === null &&
        this.wakePolicy.gate({ id, incidentKey: incidentKeyOf(row), routing: row.routing, severity: row.severity }) === null;
      if (openAndEligible && !this.wakePolicy.claimed(id)) continue;
      this.pendingWakeIds.delete(id);
      this.wakeFailures.delete(id);
      changed = true;
    }
    if (changed) this.persistWakeState();
  }

  private persistWakeState(): void {
    try {
      this.persist();
    } catch (error) {
      this.log('error', 'gru wake state persist failed — pending alerts will be rescanned on boot', {
        file: this.file, error: String(error),
      });
    }
  }

  /** Arm the deferred-wake timer; the earliest pending deadline wins. */
  private scheduleWake(retryAtMs: number, reason: 'rate' | 'quiet'): void {
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, retryAtMs - this.now()));
    if (this.wakeTimer !== null && this.wakeTimerAt !== null && this.wakeTimerAt <= retryAtMs) {
      return;
    }
    this.cancelWakeTimer();
    this.wakeTimerAt = retryAtMs;
    this.log('info', 'gru wake deferred', {
      reason,
      retry_in_ms: delay,
      pending: this.pendingWakeIds.size,
    });
    const timer = setTimeout(() => {
      this.wakeTimer = null;
      this.wakeTimerAt = null;
      this.flushPendingWakes();
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.wakeTimer = timer;
  }

  private cancelWakeTimer(): void {
    if (this.wakeTimer !== null) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    this.wakeTimerAt = null;
  }
}
