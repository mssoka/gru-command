import type { MailboxDelivery, MailboxItem } from '../gru-mailbox/types.js';
import type { GruMailbox } from '../gru-mailbox/service.js';
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
import { producerFollowsDecisionThrough } from '../notifications/attention.js';
import {
  incidentBasisOf,
  incidentKeyOf,
  incidentSignalOf,
  incidentSubjectOf,
  isHardFloorRow,
} from './incident.js';
import { redactedText } from '../decisions/questions.js';
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
 *      Issue #506: a RECORDED owner decision is its own wake reason. The
 *      card keeps its `needs-owner` routing (it still belongs on the
 *      FOR YOU surface), but the chosen option's follow-through is Gru's
 *      debt, so the policy bypasses only the routing gate for
 *      reason 'owner-decision'. The claim identity is the pair
 *      (card id, decided_at): a replay or restart cannot wake twice, a
 *      decision never spends the card's incident key, and a decision
 *      recorded while the service was down is seeded at boot. Producer-
 *      carried proposal decisions (Vector, onboarding, GC) are excluded:
 *      their own service executes and resolves the choice, and a Gru wake
 *      would invite a duplicate operation or a premature resolution. Mode
 *      ('never') and the severity floor still apply.
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
 * registered needs-owner rows carry owner decisions and notices;
 * machine recovery rides the disposition path.
 */

export const AWARENESS_STATE_NAME = 'awareness.json';

export const AWARENESS_BLOCK_HEADER = '[gru awareness · service context — not a user message]';

/** Prompt suffix for a policy-started turn (the block itself is prepended). */
export const AWARENESS_WAKE_INSTRUCTION =
  'This turn was started by the service wake policy — no user message is waiting. ' +
  'Directive/rebrief recovery debt requires its concrete generation/hash/head/epoch-fenced recovery endpoint; generic Ops holds and alert disposition do not answer it. Never replay a consumed prompt or Ack an owner-only stop. ' +
  'FOR GRU mailbox items are shared server state. Read GET /api/mailbox for full reason bases, restrictions, receipts and control references. ' +
  'Record next actions with POST /api/mailbox/{id}/disposition using its exact basis, state, owner, detail, references and dependency/recheckAt for waiting or delegated work. ' +
  'Mailbox delivery keys are not notification IDs; the notification instructions below apply only to actual notification IDs. ' +
  'Delivery is only a receipt, never resolution or authority. Reuse actual controls and obligations; do not acknowledge owner stops, merge, restart or infer child completion from a parent. ' +
  'This is machine attention and it is meant to be acted on in-turn: diagnose the item, ' +
  'take one substantive step per incident (a fix lane, a re-arm, or a disposition), and ' +
  'stage the rest. When an owner discussion-only escalation (empty options, discussion true) ' +
  'reaches agreement in chat, attach the agreed options with POST /api/notifications/{id}/decision-options ' +
  '({ options: [{ id, label, consequence }], by: "gru" }) so the owner can record the choice — it records nothing itself. ' +
  'After acting on an action-required alert, explicitly resolve its ' +
  'notification ID with POST /api/notifications/{id}/disposition and a nonempty detail; ' +
  'prompt delivery alone never clears it. A producer-resolved alert (lessons.dream-failed) refuses ' +
  'a disposition: fix its cause and leave it open — it closes itself when its producer succeeds. When the right outcome is a hold or "needs no ' +
  'action", record that decision FIRST with POST /api/decisions (subject, covers, ' +
  'basis_fingerprint, recheck_at, by: "gru") and then disposition the alert — unless it is ' +
  'producer-resolved, which stays open even under a hold (R10-02) — a hold ' +
  'recorded as state keeps the incident from re-waking you; prose does not. Use the ' +
  'subject the wake path consults: for job-scoped alert kinds that is "job:<job id>" — for those ' +
  'job-scoped kinds use the head SHA as basis_fingerprint only when the kind embeds one (github.ci-failed:<job>:<sha>); ' +
  'omit basis_fingerprint entirely for kinds without a SHA (github.pr-conflict:<job>), and name ' +
  'covers with the signal family ("ci-failed", "pr-conflict", "rebrief-unreconciled"). ' +
  'A red default branch (github.default-branch-ci-failed:<owner>/<repo>:<workflow id>:<sha>) has no lane: diagnose ' +
  'the run, open a fix heist from the current head, and hold "incident:github.default-branch-ci-failed:<owner>/<repo>" ' +
  '(covers "ci-failed") with no basis_fingerprint, so the hold reaches every later head and later red heads of that ' +
  'repository carry the in-flight fix as a restriction; disposition each item as waiting on the fix job; a later red ' +
  'head is a new item that resolves the earlier head\'s item and wakes once. It resolves itself when a newer run of ' +
  'that workflow passes or the failing run is re-run green. A decided owner card that wakes you is follow-through debt: ' +
  'carry out its recorded option only within your existing authority (never a final PR merge, restart or destructive ' +
  'act reserved to the owner); otherwise verify that the recorded outcome is true, then resolve the card with ' +
  'POST /api/notifications/{id}/disposition and the action detail; never Ack it, record a different choice, or re-open ' +
  'the question. If the card names a producer that carries out its own decision (shown on the line), verify only — ' +
  'do not repeat the operation or resolve it. In all mode, ' +
  'FYI and needs-owner rows can also wake you; do not act on or Ack an owner-only stop on the ' +
  'owner’s behalf — that rule never authorizes skipping a recorded owner decision. Escalate decisions that are theirs; if nothing is actionable, say so briefly.';

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
  /** Domain-qualified identities and immutable evidence from the actual rendered rows. */
  readonly attentionKeys?: readonly string[];
  readonly mailboxDeliveries?: readonly MailboxDelivery[];
  /** GH-110: false when a morning digest was owed but did not fully render
   * (byte cap). commit() then leaves the owner watermark untouched so the
   * digest is preserved for the next block instead of consumed unseen. */
  readonly digestDelivered?: boolean;
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
  /** GH-119: an owner turn was accepted although prepare() returned no
   * block (nothing to report). Records presence without a digest. */
  recordOwnerPresence?(): void;
  /** Accepted turn_start claims visible IDs and arms unresolved attention;
   * pre-acceptance failures remain pending for retry. */
  noteWakeOutcome?(ok: boolean, detail?: string, injection?: AwarenessInjection): void;
  /** A turn which accepted its block but failed later is not a new wake. */
  noteWakeTurnFailure?(detail: string, injection: AwarenessInjection): void;
  /** Native writer recovery is unsafe: surface a durable owner stop and retry. */
  noteWakeBlocked?(reason: string): void;
  /** Admission can wait on the existing chat lane without opening another controller. */
  noteWakeDeferred?(reason: 'busy'): void;
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
  // Uncapped exact-kind open-incident lookup (wake-stop dedupe).
  | 'findNotificationByKindAndRouting'
  | 'listJobs'
  | 'listAgents'
  | 'coveringDecision'
  // Decision memory reads (issues #218/#224): present on the real ledger;
  // optional so narrow test fakes stay honest. Absent = triage asks run
  // without the open-decisions/dispositions context.
> & Partial<Pick<LedgerApi, 'listDecisions' | 'resolveNotificationsByKindPrefix'>>;

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
  readonly mailbox?: GruMailbox;
  readonly mailboxReconcileIntervalMs?: number;
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

interface DeliveryDebt {
  readonly id: string;
  readonly ids: readonly string[];
  readonly at: number;
  readonly source?: 'chat' | 'wake';
  readonly deliveries?: readonly MailboxDelivery[];
  readonly notificationIds?: readonly string[];
}

// Bare notification IDs are legacy-compatible; synthetic keys are always domain-qualified.
const MAILBOX_KEY_PREFIX = '\u0000mailbox:';
const NOTIFICATION_KEY_PREFIX = '\u0000notification:';
const FAILURE_BASIS_PREFIX = '\u0000mailbox-failure:';
/** Owner-decision wake claim (#506): one identity per (card, decided_at).
 * The card keeps its `needs-owner` routing; the synthetic key is what the
 * wake policy claims so a card's creation wake (all mode) cannot swallow
 * the later follow-through obligation, and a replayed decision cannot
 * burn a second turn. */
const OWNER_DECISION_KEY_PREFIX = '\u0000owner-decision:';

function ownerDecisionKey(notificationId: string, decidedAt: string): string {
  return OWNER_DECISION_KEY_PREFIX + JSON.stringify([notificationId, decidedAt]);
}

function parseOwnerDecisionKey(key: string): { readonly notificationId: string; readonly decidedAt: string } | null {
  if (!key.startsWith(OWNER_DECISION_KEY_PREFIX)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(key.slice(OWNER_DECISION_KEY_PREFIX.length));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [notificationId, decidedAt] = parsed;
  if (typeof notificationId !== 'string' || notificationId === '') return null;
  if (typeof decidedAt !== 'string' || decidedAt === '') return null;
  return { notificationId, decidedAt };
}

class MailboxDeliveryRecoveryError extends Error {
  constructor(batchId: string, key: string) {
    super(`accepted mailbox delivery ${key} in batch ${batchId} lacks reconstructable captured evidence; inspect awareness.json and durable mailbox/wake receipts before repairing this debt`);
    this.name = 'MailboxDeliveryRecoveryError';
  }
}

function validDeliveryDebt(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const batch = raw as Record<string, unknown>;
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === 'string' && id !== '');
  const text = (value: unknown): boolean => typeof value === 'string' && value !== '';
  if (!strings(batch['ids']) || !Number.isSafeInteger(batch['at']) || Number(batch['at']) < 0 ||
      !(batch['id'] === undefined || text(batch['id'])) ||
      !(batch['source'] === undefined || batch['source'] === 'chat' || batch['source'] === 'wake') ||
      !(batch['notificationIds'] === undefined || strings(batch['notificationIds']))) return false;
  const deliveries = batch['deliveries'];
  return deliveries === undefined ? batch['source'] !== 'chat' : Array.isArray(deliveries) && deliveries.every((raw) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
    const delivery = raw as Record<string, unknown>;
    return ['deliveryKey', 'id', 'basis', 'attentionKey'].every((key) => text(delivery[key])) &&
      (delivery['jobId'] === null || text(delivery['jobId'])) && strings(delivery['notificationIds']) &&
      Array.isArray(delivery['reasons']) && delivery['reasons'].every((reason) => typeof reason === 'object' && reason !== null && !Array.isArray(reason) &&
        ['signal', 'label', 'basis'].every((key) => text((reason as Record<string, unknown>)[key]))) &&
      (batch['ids'] as string[]).includes(MAILBOX_KEY_PREFIX + String(delivery['deliveryKey']));
  });
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
    readonly unreceipted?: readonly (Omit<DeliveryDebt, 'id'> & { readonly id?: string })[];
    /** Failed accepted-wake attempts by notification ID or exact mailbox basis.
     * Unchanged-basis grace incarnations share the bounded retry budget.
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
    /** GH-111: install/first-start time, the bounded digest baseline used
     * until the first owner turn is committed. */
    readonly baselineAt?: number;
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
/** Passive board traffic counted as digest ACTIVITY (not Gru action, GH-104). */
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

/** GH-122: notification title/detail is external data that can echo a
 * credential (a provider error quoting a token). The block rides a
 * tool-capable model turn, so redact with the same pass as the event-triage
 * transcript tail. The stored row, and every owner-facing surface, keep the
 * original text. */
function promptSafe(value: string): string {
  return redactedText(value, 2_000);
}

/** promptSafe over every string inside a value (mailbox metadata is external
 * data too: #360 R5-B10). */
function promptSafeDeep(value: unknown): unknown {
  if (typeof value === 'string') return promptSafe(value);
  if (Array.isArray(value)) return value.map(promptSafeDeep);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, promptSafeDeep(inner)]));
  return value;
}

function clampLine(line: string, max: number): string {
  // Ledger titles, details and check names are external data, not prompt
  // structure. No metadata may create another service-context line.
  const safe = line.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, (char) =>
    char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\t' ? '\\t' : `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return safe.length > max ? `${safe.slice(0, max - 1)}…` : safe;
}

/** The recorded owner choice on a card's rendered line (#506): which card
 * (the line already carries id + title), which option, and what follow-through
 * is owed. Empty for an undecided row. A producer-followed card says so
 * explicitly: waking Gru must never repeat that producer's operation. */
function ownerDecisionNote(row: NotificationRecord): string {
  if (row.decidedAt === null || row.decidedOption === null) return '';
  const option = row.decision?.options.find((candidate) => candidate.id === row.decidedOption) ?? null;
  const label = option?.label ?? row.decidedOption;
  const producerFollowed = producerFollowsDecisionThrough(row.kind);
  // The obligation leads and the audit metadata trails: the line is
  // byte/char bounded, so a long title or label must never clip the fact
  // that an option was chosen and its follow-through is owed. The card's
  // consequence stays on the authenticated row, one read away.
  return ` — OWNER DECISION RECORDED: ${JSON.stringify(promptSafe(label))} ` +
    `(option ${JSON.stringify(promptSafe(row.decidedOption))}) — ` +
    (producerFollowed
      ? 'its producer carries this out and closes the card; verify only, do not repeat or resolve'
      : 'follow-through owed; act or confirm, then resolve') +
    ` (decided ${row.decidedAt})`;
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
    return `job ${event.jobId ?? '?'}: minion error${error !== null ? ` — ${promptSafe(error)}` : ''}`;
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
    return `agent ${event.agentId ?? '?'}: errored${error !== null ? ` — ${promptSafe(error)}` : ''}`;
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
  private readonly mailbox: GruMailbox | null;
  private mailboxTimer: ReturnType<typeof setInterval> | null = null;
  private mailboxEventTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly mailboxIntervalMs: number;
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
  /** GH-119: ledger seq a block-free chat prepare() covered, else null. */
  private blockFreeThroughSeq: number | null = null;
  /** GH-111: digest baseline while `lastOwnerAt` is null (no owner turn yet). */
  private readonly digestBaselineAt: number;
  private readonly baselineIsNew: boolean;
  private wakeSink: (() => void) | null = null;
  /** Candidate ids waiting to be released as ONE coalesced wake. */
  private readonly pendingWakeIds: Set<string>;
  /** Issue #112: delivered wake batches whose ledger receipt failed to
   * append. Never re-prompted; retried on flush, reconciled once on boot.
   * `id` is the stable batch identity reconciliation matches receipts by. */
  private readonly unreceipted: DeliveryDebt[];
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
    this.mailbox = opts.mailbox ?? null;
    this.mailboxIntervalMs = opts.mailboxReconcileIntervalMs ?? 300_000;
    // Node clamps larger intervals to 1 ms, turning recovery into a storm.
    if (!Number.isSafeInteger(this.mailboxIntervalMs) || this.mailboxIntervalMs < 1 || this.mailboxIntervalMs > 2_147_483_647) throw new Error('mailbox reconcile interval must be an integer from 1 to 2147483647 ms (Node timer ceiling)');
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
    // Decision (GH-111, docs/decisions/awareness-digest-semantics.md): until
    // the first owner turn, the digest baseline is the persisted install /
    // first-start time. No synthetic owner turn, and history stays bounded
    // by the digest's own 101-row caps and the `since` filters.
    this.baselineIsNew = state.digest?.baselineAt === undefined;
    this.digestBaselineAt = state.digest?.baselineAt ?? this.now();
    const compatibleLegacyRow = (id: string): NotificationRecord | null =>
      id.startsWith('mailbox:') && this.ledger.getNotification(id) === null ? this.mailbox?.getAttentionRow(id) ?? null : null;
    const normalizeLegacyKey = (id: string): string => {
      const row = compatibleLegacyRow(id);
      return row === null ? id : this.rowKey(row);
    };
    this.pendingWakeIds = new Set((state.wake?.pending ?? []).map(normalizeLegacyKey));
    this.unreceipted = (state.wake?.unreceipted ?? []).map((batch, index) => ({
      ...batch,
      id: batch.id ?? `legacy-${index}`,
      ids: batch.deliveries === undefined ? batch.ids.map(normalizeLegacyKey) : [...batch.ids],
      at: batch.at,
    }));
    this.wakeFailures = new Map(Object.entries(state.wake?.wakeFailures ?? {}).map(([id, count]) => {
      const key = normalizeLegacyKey(id);
      return [this.failureKey(key), count];
    }));
    this.wakePolicy = new WakePolicy(
      {
        mode: this.wakeMode,
        minSeverity: opts.wakeMinSeverity ?? 'info',
        minIntervalMs: opts.wakeMinIntervalMs ?? 300_000,
        quietHours: opts.wakeQuietHours ?? null,
      },
      state.wake === undefined ? { woken: [], lastFiredAt: null } : {
        ...state.wake,
        woken: state.wake.woken.flatMap((id) => {
          if (!id.startsWith('mailbox:')) return [id];
          const row = compatibleLegacyRow(id);
          if (row !== null) {
            const item = JSON.parse(row.detail!) as MailboxItem;
            return item.receipt?.attentionKey === item.attentionKey ? [this.rowKey(row)] : [];
          }
          // Bare collision claims cannot prove a genuine delivery; durable domain-linked events replay below.
          return this.mailbox?.getAttentionRow(id) != null ? [] : [id];
        }),
      },
    );
    if (this.baselineIsNew && this.lastOwnerAt === null) {
      try { this.persist(); } catch (error) {
        this.log('error', 'gru awareness baseline persist failed — digest baseline resets on restart', {
          file: this.file, error: String(error),
        });
      }
    }
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
        unreceipted.every(validDeliveryDebt));
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
      const baselineAt = record['baselineAt'];
      if (!(delivered === null || (typeof delivered === 'number' && Number.isFinite(delivered))) ||
          !(ownerAt === undefined || ownerAt === null || (typeof ownerAt === 'number' && Number.isFinite(ownerAt))) ||
          !(baselineAt === undefined || (typeof baselineAt === 'number' && Number.isFinite(baselineAt))) ||
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
        ...(baselineAt !== undefined ? { baselineAt: baselineAt as number } : {}),
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
      ...(unreceipted !== undefined ? { unreceipted: unreceipted as NonNullable<NonNullable<AwarenessState['wake']>['unreceipted']> } : {}),
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
    if (this.mailbox !== null && this.mailboxTimer === null) {
      this.mailboxTimer = setInterval(() => this.reconcileMailboxAttention(), this.mailboxIntervalMs);
      this.mailboxTimer.unref?.();
    }
  }

  private rowKey(row: NotificationRecord): string {
    if (this.mailbox?.captureRow(row) != null) return MAILBOX_KEY_PREFIX + row.id;
    return row.id.startsWith('\u0000') ? NOTIFICATION_KEY_PREFIX + row.id : row.id;
  }

  private attentionRow(id: string): NotificationRecord | null {
    const ownerDecision = parseOwnerDecisionKey(id);
    if (ownerDecision !== null) return this.ledger.getNotification(ownerDecision.notificationId);
    if (id.startsWith(MAILBOX_KEY_PREFIX)) return this.mailbox?.getAttentionRow(id.slice(MAILBOX_KEY_PREFIX.length)) ?? null;
    return this.ledger.getNotification(id.startsWith(NOTIFICATION_KEY_PREFIX) ? id.slice(NOTIFICATION_KEY_PREFIX.length) : id);
  }

  /** The policy candidate for one pending/delivered key. Decision keys keep
   * their reason so the routing gate and incident dedupe stay reason-aware
   * (#506); every other key is the ordinary notification class. */
  private wakeCandidate(id: string, row: NotificationRecord): WakeCandidate {
    return {
      id,
      incidentKey: incidentKeyOf(row),
      routing: row.routing,
      severity: row.severity,
      ...(parseOwnerDecisionKey(id) === null ? {} : { reason: 'owner-decision' as const }),
    };
  }

  /** The wake obligation a recorded owner choice creates (#506). A card
   * never accepts a second decision, so (card id, decided_at) names exactly
   * one follow-through; null for undecided or non-owner rows. */
  private ownerDecisionCandidate(row: NotificationRecord): WakeCandidate | null {
    if (row.routing !== 'needs-owner' || row.decidedAt === null || row.decidedOption === null) return null;
    // The producer executes its own proposal decisions; Gru must not race it.
    if (producerFollowsDecisionThrough(row.kind)) return null;
    return {
      id: ownerDecisionKey(row.id, row.decidedAt),
      incidentKey: incidentKeyOf(row),
      routing: row.routing,
      severity: row.severity,
      reason: 'owner-decision',
    };
  }

  /** The identity a rendered card is delivered under (#506): a decided
   * Gru-owned card is delivered as its per-decision claim even when a bare
   * creation/triage key carried it into the batch, so the receipt claims the
   * obligation and no sibling key stays pending for a second turn. */
  private deliveredIdentity(id: string, row: NotificationRecord): string {
    if (parseOwnerDecisionKey(id) !== null) return id;
    if (row.routing === 'needs-owner' && row.decidedAt !== null && !producerFollowsDecisionThrough(row.kind)) {
      return ownerDecisionKey(row.id, row.decidedAt);
    }
    return id;
  }

  private failureKey(id: string): string {
    const row = this.attentionRow(id);
    const delivery = row === null ? null : this.mailbox?.captureRow(row);
    return delivery == null ? id : FAILURE_BASIS_PREFIX + JSON.stringify([delivery.id, delivery.basis]);
  }

  private mailboxWakeEligible(id: string, row: NotificationRecord): boolean {
    const delivery = this.mailbox?.captureRow(row);
    if (delivery == null) return this.mailbox === null || row.routing !== 'action-required';
    const failures = this.wakeFailures.get(this.failureKey(id)) ?? 0;
    if (failures > WAKE_FAILURE_RETRIES) return false;
    if (this.unreceipted.some((batch) => batch.ids.includes(id))) return false;
    const item = JSON.parse(row.detail!) as MailboxItem;
    return item.state === 'needs-gru' && (item.receipt?.attentionKey !== item.attentionKey || (failures > 0 && this.pendingWakeIds.has(id)));
  }

  private queueMailboxReconciliation(): void {
    if (this.mailboxEventTimer !== null) return;
    this.mailboxEventTimer = setTimeout(() => {
      this.mailboxEventTimer = null;
      this.reconcileMailboxAttention();
    }, 0);
    this.mailboxEventTimer.unref?.();
  }

  private reconcileMailboxAttention(): void {
    if (this.disposed || this.mailbox === null) return;
    // Decision backlog is a boot/live-event obligation, not a per-mailbox-
    // event scan: skip it on routine reconciliations (#506 review).
    try { this.seedBacklog({ seedDecisions: false }); } catch (error) {
      this.log('error', 'mailbox reconciliation failed', { error: String(error) });
    }
  }

  /** Stop the deferred-wake timer (service shutdown / test teardown). */
  dispose(): void {
    this.disposed = true;
    if (this.mailboxTimer !== null) clearInterval(this.mailboxTimer);
    if (this.mailboxEventTimer !== null) clearTimeout(this.mailboxEventTimer);
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
    const block = this.prepareBlock(source);
    if (source === 'chat') this.blockFreeThroughSeq = block === null ? this.ledger.latestEventSeq() : null;
    return block;
  }

  /** GH-119: an accepted owner turn that carried no awareness block (nothing
   * to report) still proves the owner was present. Advance only the owner
   * watermark — through the seq the block-free prepare() saw, so events that
   * landed afterwards stay owed — never the event cursor, the wake claims, or
   * a digest. A no-op unless the last chat prepare() was block-free. */
  recordOwnerPresence(): void {
    if (this.blockFreeThroughSeq === null) return;
    this.lastOwnerAt = this.now();
    this.lastOwnerSeq = Math.max(this.lastOwnerSeq, this.blockFreeThroughSeq);
    this.blockFreeThroughSeq = null;
    try {
      this.persist();
    } catch (error) {
      this.log('error', 'gru awareness presence persist failed — owner presence resets after restart', {
        file: this.file,
        error: String(error),
      });
    }
  }

  private prepareBlock(source: 'chat' | 'wake'): AwarenessInjection | null {
    const latest = this.ledger.latestEventSeq();
    const exclusiveWake = source === 'wake' && this.activeWakeIds !== null;
    const morning = source === 'chat' ? this.morningDigest() : null;
    // A delivered context block is not a disposition. Open machine and
    // owner stops remain in subsequent user turns even after the event
    // cursor advanced; only an active wake uses its exclusive bounded batch.
    // Closed receipts (owner decision D1, code review 2026-10-04): machine
    // rows bound through an agent to a terminal (merged/done/binned) job
    // are the board's
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
        ownerCandidates.push({ id: this.rowKey(row), position: owners.offset + index });
      }
      for (const [index, row] of machineComposed.entries()) {
        machineCandidates.push({ id: this.rowKey(row), position: machine.offset + index });
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
    const notes: { id: string; displayId: string; line: string; mailbox: boolean }[] = [];
    const renderedRows = new Map<string, NotificationRecord>();
    const receiptNotes: { id: string; displayId: string; line: string; mailbox: boolean }[] = [];
    const seenIds = new Set<string>();
    const addNote = (id: string): void => {
      if (seenIds.has(id) || notes.length >= this.limits.maxActionNotes) return;
      const row = this.attentionRow(id);
      if (row === null || row.ackedAt !== null || row.resolvedAt !== null) return;
      // A decided Gru-owned card is DELIVERED under its per-decision identity
      // whichever key carried it into the batch: a batch prepared after the
      // decision then claims the obligation (and cannot leave the sibling
      // pending for a second turn). Producer-carried cards stay bare.
      const effectiveId = this.deliveredIdentity(id, row);
      if (seenIds.has(effectiveId)) return;
      const decision = parseOwnerDecisionKey(effectiveId);
      // The same card can arrive as its own notification AND as a recorded
      // decision (all mode). Render it once, preferring the decision line.
      if (decision !== null && seenIds.has(decision.notificationId)) return;
      if (decision === null && [...seenIds].some((seen) => parseOwnerDecisionKey(seen)?.notificationId === row.id)) return;
      // A stop reclassified while a wake was waiting must never ride a
      // machine-only turn; all mode explicitly opts into owner context. A
      // recorded owner decision is the one owner row that IS machine work.
      // A skipped bare row must not block its decision key: the decision
      // line is the one that belongs in this batch.
      if (exclusiveWake && this.wakeMode === 'action-required' && row.routing !== 'action-required' && decision === null) return;
      seenIds.add(id);
      seenIds.add(effectiveId);
      const decisionNote = ownerDecisionNote(row);
      const detail = row.detail !== null && row.detail !== '' ? ` — ${JSON.stringify(promptSafe(row.detail))}` : '';
      const icon = row.routing === 'action-required' ? '⚠' : row.routing === 'needs-owner' ? '🔔' : 'ℹ';
      renderedRows.set(effectiveId, row);
      if (this.mailbox?.captureRow(row) != null) {
        const item = JSON.parse(row.detail!) as MailboxItem;
        notes.push({ id: effectiveId, displayId: row.id, mailbox: true, line: `- [${row.id}] ${JSON.stringify(promptSafeDeep({ id: item.id, subject: item.subject, title: item.title, notificationIds: item.notificationIds, basis: item.basis, reasons: item.reasons.map((reason) => reason.label), state: item.state, owner: item.owner, dependency: item.disposition?.dependency ?? null, recheckAt: item.disposition?.recheckAt ?? null, receipt: item.receipt, references: item.references, restrictions: item.restrictions.length === 0 ? 'none recorded' : `${item.restrictions.length} recorded restrictions; inspect GET /api/mailbox before acting` }))}` });
        return;
      }
      // A decided card leads with the choice, not the title: the line is
      // bounded, so a long title must never clip away the option and the
      // owed follow-through. The detail stays one authenticated read away.
      const line = decisionNote === ''
        ? `- ${icon} [${row.id}] title=${JSON.stringify(promptSafe(row.title))}${detail} (routing: ${row.routing})`
        : `- ${icon} [${row.id}]${decisionNote} title=${JSON.stringify(promptSafe(row.title))} (routing: ${row.routing})`;
      notes.push({ id: effectiveId, displayId: row.id, mailbox: false, line });
    };
    const addReceipt = (id: string): void => {
      if (receiptNotes.length >= this.limits.maxActionNotes) return;
      const row = this.attentionRow(id);
      if (row === null || row.ackedAt !== null || row.resolvedAt !== null) return;
      const detail = row.detail !== null && row.detail !== '' ? ` — ${JSON.stringify(promptSafe(row.detail))}` : '';
      receiptNotes.push({
        id, displayId: row.id, mailbox: false,
        line: `- 🧾 [${row.id}] title=${JSON.stringify(promptSafe(row.title))}${detail} (closed receipt — no action required)`,
      });
    };
    if (exclusiveWake) {
      for (const id of this.activeWakeIds ?? []) addNote(id);
    } else {
      for (const row of openAttention) addNote(this.rowKey(row));
      for (const row of attention.receipts) addReceipt(this.rowKey(row));
      for (const id of this.pendingWakeIds) {
        const row = this.attentionRow(id);
        if (row !== null && this.isReceiptNotification(row.agentId)) {
          // A stored seed for a row that became a receipt (or predates
          // this rule) is dropped here, never woken.
          this.pendingWakeIds.delete(id);
          continue;
        }
        addNote(id);
      }
    }
    if (this.mailbox === null && !exclusiveWake && notes.length < this.limits.maxActionNotes) {
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
        if (this.isReceiptNotification(this.attentionRow(id)?.agentId ?? null)) continue;
        addNote(id);
      }
    }
    const rendered = this.render(notes, receiptNotes, digestLines, overflow, morning);
    for (const note of notes) {
      if (!note.mailbox || rendered?.ids.includes(note.id)) continue;
      const row = this.attentionRow(note.id);
      if (row !== null) this.recordDeferred({ id: row.id, incidentKey: row.kind, routing: row.routing, severity: row.severity }, 'context-budget', null);
    }
    // Rotation advance (GH-109): move past exactly the composed rows the
    // block rendered (or that closed mid-flight); rows skipped by slot or
    // byte caps stay ahead of the offset and lead the next block. prepare
    // stays read-only otherwise: the advance lands at commit(), so an
    // undelivered block re-prepares unchanged, and a wake's exclusive
    // block discards any stale advance with the passive block it displaced.
    if (owners === null || machine === null) {
      this.pendingRotationAdvance = null;
    } else {
      // A decided card renders/delivers under its per-decision identity, but
      // the queue candidates are keyed by the bare row. Expand so the
      // rotation still consumes the row it actually rendered (#506).
      const renderedIds = new Set((rendered?.ids ?? []).flatMap((id) => {
        const decision = parseOwnerDecisionKey(id);
        return decision === null ? [id] : [id, decision.notificationId];
      }));
      this.pendingRotationAdvance = {
        owner: this.advancePastRendered(owners.offset, ownerCandidates, renderedIds),
        machine: machineCandidates.length > 0
          ? this.advancePastRendered(machine.offset, machineCandidates, renderedIds, new Set(notes.filter((note) => note.mailbox).map((note) => note.id)))
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
    const rows = rendered.ids.flatMap((id) => renderedRows.has(id) ? [renderedRows.get(id)!] : []);
    return { text: rendered.text, coveredThroughSeq: latest,
      notificationIds: rendered.ids.map((id) => renderedRows.get(id)?.id ?? id),
      attentionKeys: rendered.ids, mailboxDeliveries: this.mailbox?.captureDelivery(rows) ?? [],
      ...(morning !== null && !rendered.digestDelivered ? { digestDelivered: false } : {}) };

  }

  /** Commit a delivered block: advance the event cursor and the passive
   * queue rotation (GH-109). Only a user chat turn advances the independent
   * owner watermark used by the morning digest. */
  commit(injection: AwarenessInjection, source: 'chat' | 'wake' = 'chat'): void {
    if (source === 'chat' && (injection.mailboxDeliveries?.length ?? 0) > 0) {
      const batch: DeliveryDebt = { id: randomUUID(), ids: injection.attentionKeys ?? [], at: this.now(),
        source, deliveries: injection.mailboxDeliveries, notificationIds: [] };
      if (this.unreceipted.length >= MAX_UNRECEIPTED_BATCHES) throw new Error('Gru accepted delivery receipt debt exceeds the sidecar cap; inspect the ledger');
      this.unreceipted.push(batch);
      this.persist(); // Accepted evidence is durable BEFORE attempting ledger writes.
      if (this.appendDeliveryReceipt(batch, false)) this.unreceipted.splice(this.unreceipted.indexOf(batch), 1);
      else this.scheduleReceiptRetry();
      this.prunePending();
    }
    if (this.pendingRotationAdvance !== null) {
      this.attentionRotation = { ...this.pendingRotationAdvance };
      this.pendingRotationAdvance = null;
    }
    this.cursor = Math.max(this.cursor, injection.coveredThroughSeq);
    this.lastDeliveredAt = this.now();
    if (source === 'chat' && injection.digestDelivered !== false) {
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
      const row = this.attentionRow(id);
      if (row === null || row.ackedAt !== null || row.resolvedAt !== null || this.isReceiptNotification(row.agentId)) {
        continue;
      }
      if (!this.mailboxWakeEligible(id, row)) continue;
      // The full candidate gate re-runs here minus dedupe (the batch
      // members are claimed by design): a row re-triaged below the
      // severity floor or out of wake routing during the spawn must not
      // ride the prompt (issue #219 review, admission gate).
      const gateSkip = this.wakePolicy.gate(this.wakeCandidate(id, row));
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
    const deliveredKeys = new Set(injection?.attentionKeys ?? injection?.notificationIds ?? []);
    // A batch prepared after a decision renders/delivers the decision
    // identity even when the composed batch held the bare card key (#506).
    const delivered = active
      .map((id) => {
        if (deliveredKeys.has(id)) return id;
        const row = this.attentionRow(id);
        const identity = row === null ? id : this.deliveredIdentity(id, row);
        return deliveredKeys.has(identity) ? identity : null;
      })
      .filter((id): id is string => id !== null);
    this.activeWakeIds = null;
    if (ok && delivered.length > 0) {
      const at = this.now();
      // Park-FIRST protocol (issue #219 review): the batch leaves pending
      // and its ids + incident keys claim BEFORE the receipt append, so
      // every crash window is safe — a delivered turn can never re-prompt
      // (the ids are claimed), and a failed append costs only the owed
      // receipt, which the flush retry and boot reconciliation settle.
      const captures = (injection?.mailboxDeliveries ?? []).filter((delivery) => delivered.includes(MAILBOX_KEY_PREFIX + delivery.deliveryKey));
      const notificationIds = [...new Set([
        ...delivered.filter((id) => !id.startsWith(MAILBOX_KEY_PREFIX)).map((id) => this.attentionRow(id)?.id ?? id),
        ...captures.flatMap((delivery) => delivery.notificationIds),
      ])];
      const batch: DeliveryDebt = { id: randomUUID(), ids: delivered, at, source: 'wake', deliveries: captures, notificationIds };
      if (this.unreceipted.length >= MAX_UNRECEIPTED_BATCHES) {
        throw new Error(
          `gru wake receipt appends keep failing — ${this.unreceipted.length} unreconciled wake batches exceed the sidecar cap; inspect the ledger`,
        );
      }
      this.unreceipted.push(batch);
      this.claimDeliveredBatch(batch); // Captured identities, never a fresh source read.
      this.persist(); // Fail loudly if the accepted evidence cannot be parked durably.
      if (this.appendDeliveryReceipt(batch, false)) {
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
      // A DELIVERED wake is positive evidence that the chat recovery route
      // works again: the owner-only blocked/failed wake stops (owner
      // release 2026-10-11) resolve here instead of waiting for a
      // display receipt or an Ack. The machine alert itself stays open
      // until its own disposition.
      try {
        this.ledger.resolveNotificationsByKindPrefix?.('gru.wake-blocked.', 'chat-recovered');
        this.ledger.resolveNotificationsByKindPrefix?.('gru.wake-blocked-mailbox.', 'chat-recovered');
        this.ledger.resolveNotificationsByKindPrefix?.('gru.wake-failed-escalation.', 'chat-recovered');
      } catch (error) {
        this.log('error', 'wake-stop resolution failed — rows stay open', { error: String(error) });
      }
      // Issue #224 escalation-triage shadow ask at the delivery receipt —
      // the exact point the labelled extractor links (the gru.wake
      // notification_ids), so backtest states and production states share
      // one unit of decision: the delivered wake batch. Fully isolated:
      // a failure here must never touch the wake path.
      try {
        this.recordEscalationTriageShadow(notificationIds);
      } catch (error) {
        this.log('error', 'escalation-triage shadow ask setup failed; wake behavior unchanged', { error: String(error) });
      }
      try {
        this.prunePending();
        this.flushPendingWakes();
      } catch (error) {
        this.log('error', 'gru accepted wake preserved; current-source reconciliation unavailable', { error: String(error) });
      }
      return;
    }
    this.prunePending();
    if (this.mailbox !== null) {
      for (const id of active) {
        if (!id.startsWith(MAILBOX_KEY_PREFIX) || !this.pendingWakeIds.has(id)) continue;
        this.pendingWakeIds.delete(id);
        this.pendingWakeIds.add(id);
      }
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
    const ids = injection.attentionKeys ?? injection.notificationIds ?? [];
    this.recordWakeFailure(detail, ids);
    const retried: string[] = [];
    const escalated: string[] = [];
    for (const id of ids) {
      const capture = injection.mailboxDeliveries?.find((delivery) => MAILBOX_KEY_PREFIX + delivery.deliveryKey === id);
      const failureKey = capture === undefined ? this.failureKey(id) : FAILURE_BASIS_PREFIX + JSON.stringify([capture.id, capture.basis]);
      const count = (this.wakeFailures.get(failureKey) ?? 0) + 1;
      if (count > WAKE_FAILURE_RETRIES) {
        this.wakeFailures.set(failureKey, count);
        escalated.push(id);
      } else {
        this.wakeFailures.set(failureKey, count);
        retried.push(id);
      }
    }
    // Exhausted-only batches also need a durable count: acceptance already
    // removed their pending IDs, so escalation may perform no other write.
    this.persistWakeState();
    if (retried.length > 0) {
      for (const id of retried) {
        this.pendingWakeIds.add(id);
        const row = this.attentionRow(id);
        this.wakePolicy.forget(id);
        if (row !== null && parseOwnerDecisionKey(id) === null) this.wakePolicy.forgetIncident(incidentKeyOf(row));
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
      const row = this.attentionRow(id);
      const key = row === null ? `\u0000id:${id}` : incidentKeyOf(row);
      const group = byIncident.get(key) ?? [];
      group.push(id);
      byIncident.set(key, group);
    }
    for (const [key, group] of byIncident) this.escalateFailedWake(key, group, detail);
  }

  noteWakeDeferred(reason: 'busy'): void {
    for (const id of this.activeWakeIds ?? []) {
      if (!id.startsWith(MAILBOX_KEY_PREFIX)) continue;
      const row = this.attentionRow(id);
      if (row !== null) this.recordDeferred({ id, incidentKey: row.kind, routing: row.routing, severity: row.severity }, reason, null);
    }
  }

  /** Unsafe recovery cannot open a Gru turn. Preserve the pending batch,
   * record the failure and put an explicit needs-owner stop on the bell. */
  noteWakeBlocked(reason: string): void {
    if (this.disposed) return;
    const active = this.activeWakeIds ?? [];
    for (const id of active) {
      const row = this.attentionRow(id);
      if (row?.routing !== 'action-required' || row.ackedAt !== null || row.resolvedAt !== null) continue;
      // Internal attention domains never enter SQLite TEXT identities. Keep
      // mailbox escalations disjoint from the legacy genuine-notification IDs.
      const mailbox = id.startsWith(MAILBOX_KEY_PREFIX);
      const escalationId = `${mailbox ? 'gru-wake-blocked-mailbox' : 'gru-wake-blocked'}:${row.id}`;
      const kind = `${mailbox ? 'gru.wake-blocked-mailbox' : 'gru.wake-blocked'}.${row.id}`;
      try {
        const existing = this.ledger.getNotification(escalationId);
        if (existing !== null && (existing.kind !== kind || existing.routing !== 'needs-owner')) {
          throw new Error(`Gru blocked-wake ID ${escalationId} is already assigned to another notification`);
        }
        // Open-incident deduplication: while ANY row of this incident's
        // kind is open the stop exists and is reused; a resolved or acked
        // row is history, so a NEW block episode posts a fresh stop (the
        // machine alert would otherwise never re-raise its debt to the
        // bell). UNCAPPED exact-kind lookup: a page window would miss an
        // old open stop behind newer notifications and duplicate it.
        const incidentKind = kind;
        const open = this.ledger.findNotificationByKindAndRouting(incidentKind, 'needs-owner', 'unacked');
        if (open === null) {
          const posted = this.ledger.recordNotification({
            id: existing === null ? escalationId : this.nextEscalationId(escalationId),
            kind,
            routing: 'needs-owner',
            severity: 'error',
            title: `Gru wake blocked: ${row.title}`,
            detail: `${mailbox ? 'Mailbox delivery' : 'Notification'} ${row.id} could not reach Gru (${reason}). Restart the service to recover chat safely; the machine alert remains pending for retry.`,
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
    // Keep the audit's notification_ids real: a decision claim identity is a
    // synthetic attention key, not a notification id (docs/CHAT.md).
    const notificationIds = ids.map((id) => parseOwnerDecisionKey(id) === null ? id : this.attentionRow(id)?.id ?? id);
    this.log('error', 'gru wake turn failed', { error: reason, notification_ids: notificationIds });
    try {
      this.ledger.appendCustomEvent({ kind: 'gru.wake-failed', payload: { error: reason, notification_ids: notificationIds } });
    } catch (error) {
      this.log('error', 'gru wake failure event failed', { error: String(error) });
    }
  }

  /** A fresh escalation identity when the canonical one is closed history:
   * `base`, `base:2`, `base:3`… never colliding with a live row. */
  private nextEscalationId(base: string): string {
    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${base}:${suffix}`;
      if (this.ledger.getNotification(candidate) === null) return candidate;
    }
    return `${base}:${this.now()}`;
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
      .map((id) => ({ id, row: this.attentionRow(id) }))
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
    // Name the card(s), never the internal per-decision claim identity.
    const idList = open.map(({ id }) => this.attentionRow(id)?.id ?? id).join(', ');
    try {
      const existing = this.attentionRow(escalationId);
      if (existing !== null && (existing.kind !== kind || existing.routing !== 'needs-owner')) {
        throw new Error(`Gru failed-wake escalation id ${escalationId} is already assigned to another notification`);
      }
      // Open-incident dedupe: an OPEN stop for this exact kind reuses the
      // row; a resolved/acked stop is history, so a fresh exhaustion
      // re-raises the debt with a new identity instead of staying silent.
      // UNCAPPED exact-kind lookup (same reason as the blocked-wake path).
      const open = this.ledger.findNotificationByKindAndRouting(kind, 'needs-owner', 'unacked');
      if (open === null) {
        const posted = this.ledger.recordNotification({
          id: existing === null ? escalationId : this.nextEscalationId(escalationId),
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
        this.wakeFailures.delete(this.failureKey(id));
        this.pendingWakeIds.add(id);
        this.wakePolicy.forget(id);
        if (parseOwnerDecisionKey(id) === null) this.wakePolicy.forgetIncident(incidentKeyOf(row));
      }
      this.persistWakeState();
      this.failedRetryAtMs = this.now() + 5_000;
      this.flushPendingWakes();
    }
  }

  /** Append accepted mailbox evidence and, for autonomous turns, ONE wake
   * receipt. Never throws — the boolean tells the caller whether the ledger
   * took it. `reconciled` marks a boot-time
   * repair so the board can tell the two apart. */
  private appendDeliveryReceipt(batch: Omit<DeliveryDebt, 'id'> & { readonly id?: string }, reconciled: boolean): boolean {
    try {
      const source = batch.source ?? 'wake';
      let deliveries = batch.deliveries ?? [];
      if (batch.deliveries !== undefined) {
        this.mailbox?.receiptCaptured(batch.deliveries, source, batch.id ?? `legacy-${batch.at}`, new Date(batch.at).toISOString());
      } else if (this.mailbox !== null) {
        deliveries = batch.ids.flatMap((id) => {
          const bare = id.startsWith(MAILBOX_KEY_PREFIX) ? id.slice(MAILBOX_KEY_PREFIX.length) : id;
          if (!id.startsWith(MAILBOX_KEY_PREFIX) && !bare.startsWith('mailbox:')) return [];
          // A legacy prefix-bearing genuine row needs explicit source-domain linkage; a bare key alone cannot prove it.
          if (this.ledger.getNotification(bare) !== null) {
            if (batch.notificationIds?.includes(bare)) return [];
            throw new MailboxDeliveryRecoveryError(batch.id ?? 'legacy', bare);
          }
          const row = this.mailbox!.getAttentionRow(bare);
          if (row === null) throw new MailboxDeliveryRecoveryError(batch.id ?? 'legacy', bare);
          return this.mailbox!.captureDelivery([row]);
        });
        this.mailbox.receiptCaptured(deliveries, source, batch.id ?? `legacy-${batch.at}`, new Date(batch.at).toISOString());
      }
      if (source === 'chat') return true;
      const mailboxKeys = batch.deliveries?.map((delivery) => delivery.deliveryKey) ?? batch.ids.filter((id) => id.startsWith(MAILBOX_KEY_PREFIX)).map((id) => id.slice(MAILBOX_KEY_PREFIX.length));
      const notificationIds = batch.notificationIds ?? [...new Set([...batch.ids.filter((id) => !id.startsWith(MAILBOX_KEY_PREFIX)), ...deliveries.flatMap((delivery) => delivery.notificationIds)])];
      this.ledger.appendCustomEvent({ kind: 'gru.wake', payload: {
        notification_ids: notificationIds,
        ...(mailboxKeys.length > 0 ? { mailbox_keys: mailboxKeys, mailbox_count: mailboxKeys.length, notification_count: notificationIds.length } : {}),
        attention_keys: batch.ids,
        count: batch.ids.length, mode: this.wakeMode,
        ...(batch.id !== undefined ? { wake_id: batch.id } : {}),
        ...(reconciled ? { reconciled: true } : {}), wake_at: new Date(batch.at).toISOString(),
      } });
      return true;
    } catch (error) {
      this.log('error', 'gru accepted delivery receipt failed', { error: String(error) });
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
      const batch = this.unreceipted[0]!;
      if (!this.appendDeliveryReceipt(batch, false)) break;
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
      const batch = this.unreceipted[0]!;
      const delivered = batch.id !== undefined && receiptIds.has(batch.id);
      if ((batch.source === 'chat' || !delivered) && !this.appendDeliveryReceipt(batch, true)) break;
      this.unreceipted.shift();
      this.claimDeliveredBatch(batch);
      changed = true;
    }
    if (changed) this.persistWakeState();
    if (this.unreceipted.length > 0) this.scheduleReceiptRetry();
  }

  /** Claim a delivered batch in the dedupe state (ids + incident keys).
   * Idempotent — parking re-claims what the receipt success would claim.
   * wakeFailures survives here too (see noteWakeOutcome). */
  private claimDeliveredBatch(batch: Omit<DeliveryDebt, 'id'>): void {
    if (batch.source === 'chat') return;
    for (const id of batch.ids) {
      this.pendingWakeIds.delete(id);
      // A delivered decision identity also supersedes any restored bare
      // candidate for the same card (#506).
      const decision = parseOwnerDecisionKey(id);
      if (decision !== null) this.pendingWakeIds.delete(decision.notificationId);
    }
    const keys = batch.ids.flatMap((id) => {
      // A decision delivery claims only its per-decision identity (#506).
      // Spending the card's incident key here would suppress a genuinely
      // new machine alert for the same incident.
      if (parseOwnerDecisionKey(id) !== null) return [];
      const capture = batch.deliveries?.find((delivery) => MAILBOX_KEY_PREFIX + delivery.deliveryKey === id);
      if (capture !== undefined) return [capture.deliveryKey];
      const row = this.attentionRow(id);
      return row === null ? [] : [incidentKeyOf(row)];
    });
    this.wakePolicy.fired(batch.ids, Math.max(this.wakePolicy.snapshot().lastFiredAt ?? 0, batch.at), keys);
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
        const payload = payloadOf(event);
        const ids = payload['attention_keys'] ?? (Array.isArray(payload['mailbox_keys']) && Array.isArray(payload['notification_ids'])
          ? [...payload['notification_ids'], ...payload['mailbox_keys'].map((id) => MAILBOX_KEY_PREFIX + String(id))] : payload['notification_ids']);
        if (Array.isArray(ids) && ids.every((id) => typeof id === 'string' && id !== '')) {
          receipts.push({ ...payloadOf(event), notification_ids: ids });
        }
      }
      if (page.length < 500) break;
    }
    return receipts;
  }

  private render(
    actionNotes: readonly { id: string; displayId: string; line: string; mailbox: boolean }[],
    receiptNotes: readonly { id: string; displayId: string; line: string; mailbox: boolean }[],
    digestLines: readonly string[],
    overflow: boolean,
    morning: readonly string[] | null,
  ): { text: string; ids: readonly string[]; digestDelivered: boolean } | null {
    const parts: string[] = [AWARENESS_BLOCK_HEADER];
    const ids: string[] = [];
    let bytes = Buffer.byteLength(AWARENESS_BLOCK_HEADER, 'utf8');
    let truncated = overflow;
    let exhausted = false;
    // GH-110: the morning digest is owner-directed catch-up whose watermark
    // advances at commit, so notes (rendered first) must not be able to
    // spend its bytes. Reserve what the digest lines need (greedy, in
    // order, up to the cap); the reservation is released as the digest
    // renders. A digest that cannot fit whole is reported undelivered.
    let reserved = 0;
    let reservable = 0;
    if (morning !== null) {
      for (const line of morning) {
        const size = Buffer.byteLength(clampLine(line, this.limits.maxLineChars), 'utf8') + 1;
        if (bytes + reserved + size > this.limits.maxBytes) break;
        reserved += size;
        reservable += 1;
      }
    }
    const push = (line: string, force = false, mailbox = false): boolean => {
      if (exhausted && !force) return false;
      const sized = clampLine(line, mailbox ? Number.MAX_SAFE_INTEGER : this.limits.maxLineChars);
      const size = Buffer.byteLength(sized, 'utf8') + 1; // newline
      if (bytes + size + reserved > this.limits.maxBytes) {
        truncated = true;
        if (mailbox) return false; // another item can still fit; never let one large thread hide the tail
        exhausted = true;
        return false;
      }
      parts.push(sized);
      bytes += size;
      return true;
    };

    if (actionNotes.length > 0 && push(this.mailbox !== null ? 'FOR GRU mailbox (delivery is receipt only; operational authority unchanged):' : this.wakeMode === 'all' ? 'Notifications (unacknowledged):' : 'Action required (unacknowledged):')) {
      for (const note of actionNotes) {
        // Never claim an ID whose identifier was clipped by the line/byte
        // bounds. A truncated title is fine; an invisible ID is not.
        if (push(note.line, false, note.mailbox) && parts.at(-1)?.includes(`[${note.displayId}]`)) ids.push(note.id);
      }
    }
    if (receiptNotes.length > 0 && push('Closed receipts (no action required; kept for reference):')) {
      for (const note of receiptNotes) {
        if (push(note.line, false, note.mailbox) && parts.at(-1)?.includes(`[${note.displayId}]`)) ids.push(note.id);
      }
    }
    let digestDelivered = true;
    if (morning !== null) {
      reserved = 0; // released: the reserved bytes are spent right here
      digestDelivered = reservable === morning.length;
      exhausted = false;
      for (const line of morning) if (!push(line)) digestDelivered = false;
    }
    if (digestLines.length > 0) {
      push('Since your last turn:');
      for (const line of digestLines) push(line);
    }
    if (parts.length === 1) return null;
    if (truncated) push('- (further context omitted…)', true);
    return { text: parts.join('\n'), ids, digestDelivered };
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
    if (this.mailbox !== null) {
      let offset = this.attentionRotation.machine;
      let page = this.mailbox.attentionRows(pageSize, offset, true);
      if (page.length === 0 && offset > 0) { offset = 0; page = this.mailbox.attentionRows(pageSize, 0, true); }
      return { offset, live: page, receiptRows: [], noLiveAdvance: 0 };
    }
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
   * everything rendered. Fully attempted oversized mailbox notes receive an
   * explicit budget deferral and rotate too, without receiving a coverage
   * receipt. Slot-skipped rows and ordinary byte-capped notes lead the next
   * block. The advance becomes durable only when the block is accepted.
   */
  private advancePastRendered(
    offset: number,
    candidates: readonly { readonly id: string; readonly position: number }[],
    renderedIds: ReadonlySet<string>,
    attemptedMailboxIds: ReadonlySet<string> = new Set(),
  ): number {
    let lastConsumed = -1;
    for (const candidate of candidates) {
      if (renderedIds.has(candidate.id) || attemptedMailboxIds.has(candidate.id)) {
        lastConsumed = candidate.position;
        continue;
      }
      const row = this.attentionRow(candidate.id);
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
    if (this.morningDigestGapMs <= 0) return null;
    const since = this.lastOwnerAt ?? this.digestBaselineAt;
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
    // Decision (GH-104, docs/decisions/awareness-digest-semantics.md): only
    // durable `notification.resolved` rows attributed `by: 'gru'` are Gru
    // ACTIONS. Deliveries, status changes, verdicts and non-Gru resolutions
    // are passive board ACTIVITY and are labeled separately. Each category
    // counts in its own 101-row window, never a share of a mixed one (#360
    // R5-B11): one Gru action among 100 others is 1, and an older one is
    // still found.
    const resolved = (payload: { key: string; equals?: string; notEquals?: string }) =>
      this.ledger.listEventsAfter(this.lastOwnerSeq, { kinds: ['notification.resolved'], limit: 101, order: 'desc', payload });
    const gruResolutions = resolved({ key: 'by', equals: 'gru' });
    const otherResolutions = resolved({ key: 'by', notEquals: 'gru' });
    const activityCount = boardActions.length + otherResolutions.length;
    const bound = (count: number, capped: boolean): string => (capped ? '100+' : String(count));
    const anyCapped = boardActions.length >= 101 || otherResolutions.length >= 101;
    if (activityCount > 0) push(`- activity: ${bound(activityCount, anyCapped)} board event${activityCount === 1 ? '' : 's'}`);
    if (gruResolutions.length > 0) push(`- Gru actions: ${bound(gruResolutions.length, gruResolutions.length >= 101)} disposition${gruResolutions.length === 1 ? '' : 's'}`);
    const latestDisposition = gruResolutions[0];
    if (latestDisposition !== undefined) {
      const disposition = payloadOf(latestDisposition);
      // #99: `by: 'gru'` names the disposition ROLE, not a proven actor — the
      // board's shared bearer can speak for owner or agent alike. Surface the
      // role and any caller-declared actor rather than over-claiming "Gru".
      const declared = textOf(disposition['declaredActor']);
      const actor = declared !== null ? ` (declared actor: ${promptSafe(declared)})` : '';
      // The recorded detail is external data: redacted like every other (#360 R5-B10).
      const detail = textOf(disposition['detail']);
      push(clampLine(`- Machine disposition [${textOf(disposition['id']) ?? '?'}]: ${detail === null ? 'no detail recorded' : promptSafe(detail)}${actor}`, this.limits.maxLineChars));
    }
    const jobs = this.ledger.listJobs();
    const list = (ids: readonly string[]): string =>
      `${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ` +${ids.length - 3} more` : ''}`;
    const merges = jobs.filter((job) => job.status === 'merged' && Date.parse(job.updatedAt) > since);
    if (merges.length > 0) push(`- merges: ${list(merges.map((job) => job.id))}`);
    // GH-103: staged during the away window means a `job.pr` link event
    // after the owner watermark; a PR open since before it is not news.
    const linkedAway = new Set(
      this.ledger.listEventsAfter(this.lastOwnerSeq, { kinds: ['job.pr'], limit: 101 })
        .flatMap((event) => event.jobId === null || event.jobId === undefined ? [] : [event.jobId]),
    );
    const staged = jobs.filter(
      (job) => job.prUrl !== null && !isJobTerminal(job.status) && linkedAway.has(job.id),
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
        ...(this.unreceipted.length > 0 ? { unreceipted: this.unreceipted.map((batch) => ({ ...batch, ids: [...batch.ids] })) } : {}),
        ...(this.wakeFailures.size > 0 ? { wakeFailures: Object.fromEntries(this.wakeFailures) } : {}),
      },
      digest: { lastDeliveredAt: this.lastDeliveredAt, lastOwnerAt: this.lastOwnerAt, lastOwnerSeq: this.lastOwnerSeq, baselineAt: this.digestBaselineAt },
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
      if (this.mailbox !== null) this.queueMailboxReconciliation();
      const closedId = textOf(payloadOf(event)['id']);
      if (closedId !== null) {
        const row = this.ledger.getNotification(closedId);
        const closedKey = row === null ? closedId : this.rowKey(row);
        this.pendingWakeIds.delete(closedKey);
        // Issue #115: a closed row needs no failure bookkeeping, and its
        // recorded deferrals/escalations must not re-fire stale guards.
        // (Mutate BEFORE the persist so the sidecar never keeps a spent debt.)
        const hadFailure = this.wakeFailures.delete(closedKey);
        // Issue #506: a closed card spends the claims of every decision
        // recorded on it — the follow-through is done, so the per-decision
        // identities must not keep the dedupe set (or a retry) alive.
        let decisionChanged = false;
        for (const key of [...this.pendingWakeIds, ...this.wakePolicy.snapshot().woken]) {
          if (parseOwnerDecisionKey(key)?.notificationId !== closedId) continue;
          this.pendingWakeIds.delete(key);
          this.wakeFailures.delete(key);
          if (this.wakePolicy.forget(key)) decisionChanged = true;
        }
        for (const [key, entry] of this.deferredRechecks) {
          if (entry.notificationId === closedKey) this.deferredRechecks.delete(key);
        }
        const wasDelivered = this.wakePolicy.forget(closedKey);
        if (wasDelivered || hadFailure || decisionChanged) this.persistWakeState();
        // Close any historical timeout follow-up on explicit Gru disposition.
        if (row?.routing === 'action-required') {
          const followUp = this.attentionRow(this.followUpId(closedId));
          if (followUp?.kind === this.followUpKind(closedId)) {
            this.ledger.resolveNotificationById(followUp.id, 'gru-disposition');
          }
        }
      }
      return;
    }
    if (this.mailbox !== null && /^(job\.|round\.|lens\.|agent\.|notification\.|decision\.|obligation\.|directive\.|silas\.directive-|supervision\.|mailbox\.disposition|github\.)/.test(event.kind)) {
      this.queueMailboxReconciliation();
      // Owner decisions use the machine wake sink even when the routing
      // split would keep the card passive (#506); the row lookup below
      // enforces the real eligibility.
      if (event.kind.startsWith('notification.') && event.kind !== 'notification.decision') {
        const id = textOf(payloadOf(event)['id']);
        const row = id === null ? null : this.ledger.getNotification(id);
        if (this.wakeMode !== 'all' || row?.routing === 'action-required') return;
      }
    }
    if (event.kind === 'notification.decision') {
      this.considerOwnerDecision(textOf(payloadOf(event)['id']));
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
    // A decided owner card's obligation is its per-decision candidate, never
    // the bare creation/triage identity. A late triage event must not queue
    // a second, unclaimed candidate for the same card (#506).
    if (row.routing === 'needs-owner' && row.decidedAt !== null) {
      this.considerOwnerDecision(row.id);
      return;
    }
    this.considerCandidate({
      id: this.rowKey(row),
      incidentKey: incidentKeyOf(row),
      routing: row.routing,
      severity: row.severity,
    });
  }

  /** A recorded owner decision opens a follow-through turn (#506): the
   * card stays on the FOR YOU surface, but Gru owes the chosen option's
   * operation and the card's eventual resolution. The persisted row is
   * the authority (the event payload carries no decided_at); a replay or
   * a boot re-seed is deduped by the per-decision claim key. */
  private considerOwnerDecision(notificationId: string | null): void {
    if (notificationId === null || this.wakeMode === 'never') return;
    const row = this.ledger.getNotification(notificationId);
    if (row === null || row.ackedAt !== null || row.resolvedAt !== null) return;
    if (this.isReceiptNotification(row.agentId)) return;
    const candidate = this.ownerDecisionCandidate(row);
    if (candidate === null) return;
    // One card, one obligation: a still-pending creation/triage identity is
    // superseded by its recorded decision (it renders the same line), so a
    // coalesced batch can never leave one identity unclaimed and re-wake.
    this.pendingWakeIds.delete(row.id);
    this.considerCandidate(candidate);
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
    const current = this.attentionRow(candidate.id);
    if (current !== null && !this.mailboxWakeEligible(candidate.id, current)) return { action: 'skip' };
    const decision = this.wakePolicy.decide(candidate, this.now());
    if (decision.action === 'skip') {
      if (decision.reason === 'duplicate-incident') {
        // Hard floors bypass incident dedupe: a re-armed breaker or
        // provider wall for the same subject is a NEW wake obligation
        // (its predecessor row was resolved to re-arm it). ID dedupe
        // still applies to the same open row.
        const floorRow = this.attentionRow(candidate.id);
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
    const row = this.attentionRow(candidate.id);
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
    if (this.mailbox?.captureRow(row) != null) return null; // exact-basis mailbox dispositions own admission, wildcard holds remain restrictions
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
      notificationId: this.rowKey(row),
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
    reason: 'covered' | 'duplicate' | 'failed' | 'mode' | 'routing' | 'severity' | 'rate' | 'quiet' | 'busy' | 'context-budget',
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
      const row = this.attentionRow(entry.notificationId);
      if (row === null || row.ackedAt !== null || row.resolvedAt !== null) continue;
      if (this.isReceiptNotification(row.agentId)) continue;
      this.considerCandidate({
        id: this.rowKey(row),
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
        const payload = payloadOf(event);
        const ids = payload['attention_keys'] ?? (Array.isArray(payload['mailbox_keys']) && Array.isArray(payload['notification_ids'])
          ? [...payload['notification_ids'], ...payload['mailbox_keys'].map((id) => MAILBOX_KEY_PREFIX + String(id))] : payload['notification_ids']);
        if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && id !== '')) continue;
        const missing = (ids as string[]).filter((id) => {
          // Issue #115: an id in bounded failed-turn retry is unclaimed ON
          // PURPOSE while it waits in pending — its receipt records the
          // failed turn, the retry still owes an autonomous attempt. A
          // debt WITHOUT a pending id is a recovered turn; claim normally.
          if (this.wakeFailures.has(this.failureKey(id)) && this.pendingWakeIds.has(id)) return false;
          const row = this.attentionRow(id);
          return row !== null && row.ackedAt === null && row.resolvedAt === null && !known.has(id);
        });
        if (missing.length === 0) continue;
        for (const id of missing) known.add(id);
        const keys = missing
          .filter((id) => parseOwnerDecisionKey(id) === null) // a decision claim never spends the card's incident key
          .map((id) => this.attentionRow(id))
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
  private seedBacklog(options: { readonly seedDecisions?: boolean } = {}): void {
    if (this.disposed || (this.wakeMode === 'never' && this.mailbox === null)) return;
    let seeded = false;
    // Keep every still-open receipt (no 256-ID eviction), but discard
    // terminal IDs from pre-upgrade state or a missed close event.
    for (const id of this.wakePolicy.snapshot().woken) {
      const row = this.attentionRow(id);
      if (row === null || row.ackedAt !== null || row.resolvedAt !== null) {
        this.wakePolicy.forget(id);
        seeded = true;
      }
    }
    const liveFailureKeys = new Set(this.mailbox?.snapshot().items.filter((item) => item.state !== 'resolved')
      .map((item) => FAILURE_BASIS_PREFIX + JSON.stringify([item.id, item.basis])) ?? []);
    for (const key of this.wakeFailures.keys()) {
      const row = key.startsWith(FAILURE_BASIS_PREFIX) ? null : this.attentionRow(key);
      if (key.startsWith(FAILURE_BASIS_PREFIX) ? !liveFailureKeys.has(key) : row === null || row.ackedAt !== null || row.resolvedAt !== null) {
        this.wakeFailures.delete(key);
        seeded = true;
      }
    }
    const before = this.pendingWakeIds.size;
    // Recorded owner decisions are follow-through debt in EVERY non-never
    // mode (#506), not owner row volume: seed them before the mailbox
    // early-return so an action-required boot still owes them.
    if (options.seedDecisions !== false && this.wakeMode !== 'never') {
      try {
        this.seedOwnerDecisionBacklog();
      } catch (error) {
        this.log('error', 'gru owner-decision backlog scan failed', { error: String(error) });
      }
    }
    if (this.mailbox !== null) {
      for (const row of this.mailbox.admissionRows(MAX_BACKLOG_SEED)) {
        const candidate = { id: this.rowKey(row), incidentKey: row.kind, routing: row.routing, severity: row.severity };
        if (this.admitPath(candidate).action === 'admit') this.pendingWakeIds.add(this.rowKey(row));
        else if (this.wakePolicy.gate(candidate) !== null) this.recordMailboxAdmissionDeferral(candidate);
      }
      if (seeded || this.pendingWakeIds.size !== before) this.persistWakeState();
      this.flushPendingWakes();
      if (this.wakeMode !== 'all') return;
    }
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
          if (this.mailbox !== null && row.routing === 'action-required') continue;
          // A decided owner row is seeded as its decision obligation above;
          // the bare creation candidate here would duplicate that turn.
          if (row.routing === 'needs-owner' && row.decidedAt !== null) continue;
          const candidate = {
            id: this.rowKey(row),
            incidentKey: incidentKeyOf(row),
            routing: row.routing,
            severity: row.severity,
          } as const;
          // ONE coalesced backlog wake (the migration rule): admission
          // gates run per row, the flush happens once after the scan.
          if (this.admitPath(candidate).action === 'admit') this.pendingWakeIds.add(this.rowKey(row));
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

  /** Seed recorded decisions whose follow-through wake was never delivered
   * (boot, a lost sidecar, or a decision recorded while the service was
   * down) — #506. The per-decision claim key makes this a no-op after a
   * delivered wake and after a receipt replay; resolved cards never appear
   * because the scan is unacked-only. */
  private seedOwnerDecisionBacklog(): void {
    for (let offset = 0;; offset += MAX_BACKLOG_SEED) {
      const rows = this.ledger.listNotifications({
        unackedOnly: true, routing: 'needs-owner', limit: MAX_BACKLOG_SEED, offset,
      });
      for (const row of rows) {
        if (row.decidedAt === null || row.decidedOption === null) continue;
        if (this.isReceiptNotification(row.agentId)) continue;
        const candidate = this.ownerDecisionCandidate(row);
        if (candidate === null) continue;
        // The decision identity replaces any restored bare candidate.
        this.pendingWakeIds.delete(row.id);
        if (this.admitPath(candidate).action === 'admit') this.pendingWakeIds.add(candidate.id);
      }
      if (rows.length < MAX_BACKLOG_SEED) break;
    }
  }

  private recordMailboxAdmissionDeferral(candidate: WakeCandidate): void {
    const reason = this.wakePolicy.gate(candidate);
    if (reason === 'mode' || reason === 'routing' || reason === 'severity') this.recordDeferred(candidate, reason, null);
  }

  /** The ONE receipt rule for every Gru-facing reader (owner decision D1):
   * a machine row bound through an agent to a terminal (merged/done/
   * binned) job is a closed
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
      for (const id of this.pendingWakeIds) {
        const row = this.attentionRow(id);
        if (row !== null && id.startsWith(MAILBOX_KEY_PREFIX)) this.recordDeferred({ id, incidentKey: row.kind, routing: row.routing, severity: row.severity }, decision.reason, null, new Date(decision.retryAtMs).toISOString());
      }
      this.scheduleWake(decision.retryAtMs, decision.reason);
      return;
    }
    if (this.wakeSink === null) return; // boot binds this later
    this.cancelWakeTimer();
    // GH-116: machine stops lead the batch. A recorded owner decision is a
    // follow-through obligation, not owner-row volume, so it ranks with
    // machine stops rather than behind sustained FYI/owner traffic. Pending
    // ids keep insertion order within a priority class (stable sort).
    const priority = (id: string): number =>
      this.attentionRow(id)?.routing === 'action-required' || parseOwnerDecisionKey(id) !== null ? 0 : 1;
    this.activeWakeIds = [...this.pendingWakeIds]
      .map((id, index) => ({ id, index, rank: priority(id) }))
      .sort((left, right) => left.rank - right.rank || left.index - right.index)
      .slice(0, this.limits.maxActionNotes)
      .map(({ id }) => id);
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
      const row = this.attentionRow(id);
      // (#506) A decision identity supersedes the card's bare creation/triage
      // identity. Leaving both pending would deliver (and claim) only one and
      // re-wake the other on the next interval.
      const supersededByDecision = row !== null && parseOwnerDecisionKey(id) === null &&
        row.routing === 'needs-owner' && row.decidedAt !== null;
      const openAndEligible =
        !supersededByDecision && row !== null && row.ackedAt === null && row.resolvedAt === null && this.mailboxWakeEligible(id, row) &&
        this.wakePolicy.gate(this.wakeCandidate(id, row)) === null;
      if (openAndEligible && !this.wakePolicy.claimed(id)) continue;
      this.pendingWakeIds.delete(id);
      if (row === null || row.ackedAt !== null || row.resolvedAt !== null) this.wakeFailures.delete(id);
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
