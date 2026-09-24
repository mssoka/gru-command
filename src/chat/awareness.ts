import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NotifyWakeMode, QuietHours, WakeMinSeverity } from '../config.js';
import type { BusEvent, EventBus } from '../events/bus.js';
import type { LogLevel } from '../logger.js';
import type { EventRecord, LedgerApi, NotificationRecord } from '../ledger/api.js';
import { WakePolicy, type WakeCandidate } from './wake-policy.js';

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
 *      was accepted, so a failed delivery never eats context.
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
  'prompt delivery alone never clears it. In all mode, FYI and needs-owner ' +
  'rows can also wake you; do not act on or Ack an owner-only stop on the ' +
  'owner’s behalf. Escalate decisions that are theirs; if nothing is actionable, say so briefly.';

export interface AwarenessLimits {
  /** Newest digest events per block (older overflow is dropped). */
  readonly maxEvents: number;
  /** Hard byte cap for the whole injected block. */
  readonly maxBytes: number;
  /** Hard character cap for every rendered line. */
  readonly maxLineChars: number;
  /** Action-required notes per block (newest first, then oldest-first order). */
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
  prepare(): AwarenessInjection | null;
  commit(injection: AwarenessInjection, source?: 'chat' | 'wake'): void;
  /** Wake outcome receipt: only a successful turn with the delivered
   * injection may claim its visible IDs. Failed wakes remain pending and
   * record `gru.wake-failed` for operational diagnosis. */
  noteWakeOutcome?(ok: boolean, detail?: string, injection?: AwarenessInjection): void;
}

export type GruAwarenessLedger = Pick<
  LedgerApi,
  | 'getNotification'
  | 'listEventsAfter'
  | 'latestEventSeq'
  | 'appendCustomEvent'
  | 'listNotifications'
  | 'migrateOwnerHeldNotifications'
  | 'recordNotification'
  | 'resolveNotificationById'
  | 'listJobs'
>;

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
  /** First-block-after-gap morning digest threshold; 0 disables. */
  readonly morningDigestGapMs?: number;
  readonly limits?: Partial<AwarenessLimits>;
  /** Forward a newly persisted owner follow-up to the chat notice surface. */
  readonly onFollowUpPosted?: (row: NotificationRecord) => void;
  readonly log?: Log;
  /** Clock seam (tests advance fake timers through this closure). */
  readonly now?: () => number;
}

interface AwarenessState {
  readonly coveredThroughSeq: number;
  readonly wake?: {
    /** v2 means woken IDs were confirmed by a delivered prompt, not merely claimed. */
    readonly version?: 2;
    readonly woken: readonly string[];
    readonly pending?: readonly string[];
    /** Delivered but unresolved machine alerts awaiting owner escalation. */
    readonly followUp?: readonly { readonly id: string; readonly dueAtMs: number }[];
    readonly lastFiredAt: number | null;
    readonly lastAttemptAt?: number | null;
  };
  readonly digest?: {
    readonly lastDeliveredAt: number | null;
    readonly lastOwnerAt?: number | null;
    readonly lastOwnerSeq?: number;
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
const UNRESOLVED_FOLLOW_UP_MS = 30 * 60_000;
const FOLLOW_UP_RETRY_MS = 5 * 60_000;
/** Default morning-digest gap (8 h): first block after a quiet night. */
export const DEFAULT_MORNING_DIGEST_GAP_MS = 28_800_000;
/** Morning-digest kernel kinds — the "actions" count. */
const MORNING_ACTION_KINDS = ['job.delivered', 'job.status', 'round.verdict'] as const;
/** Bounded morning-digest lines (fires/actions/merges/staged PRs). */
const MAX_MORNING_LINES = 6;

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
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
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
  'round.head-moved': (event) => `round ${event.roundId ?? '?'}: head moved after freeze — verdict invalidated`,
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
        return `job ${event.jobId ?? '?'}: bmad-review PASS — clear to merge (merge stays user-held)`;
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
  private readonly log: Log;
  private readonly onFollowUpPosted: (row: NotificationRecord) => void;
  private readonly now: () => number;
  private cursor: number;
  /** Epoch ms of the last delivered block (legacy state compatibility). */
  private lastDeliveredAt: number | null;
  /** Only an owner-directed user turn advances the morning boundary. */
  private lastOwnerAt: number | null;
  private lastOwnerSeq: number;
  private wakeSink: (() => void) | null = null;
  /** Candidate ids waiting to be released as ONE coalesced wake. */
  private readonly pendingWakeIds: Set<string>;
  private readonly followUpDue: Map<string, number>;
  private followUpTimer: ReturnType<typeof setTimeout> | null = null;
  /** One in-flight bounded batch. Its IDs stay pending until prompt receipt. */
  private activeWakeIds: readonly string[] | null = null;
  private failedRetryAtMs = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeTimerAt: number | null = null;
  private disposed = false;

  constructor(opts: GruAwarenessOptions) {
    this.file = join(opts.dir, AWARENESS_STATE_NAME);
    this.ledger = opts.ledger;
    this.limits = { ...AWARENESS_LIMITS, ...(opts.limits ?? {}) };
    if (!Number.isSafeInteger(this.limits.maxActionNotes) || this.limits.maxActionNotes < 1) {
      throw new Error('awareness maxActionNotes must be a positive integer');
    }
    this.wakeMode = opts.wakeMode ?? 'action-required';
    this.morningDigestGapMs = opts.morningDigestGapMs ?? DEFAULT_MORNING_DIGEST_GAP_MS;
    this.log = opts.log ?? (() => {});
    this.onFollowUpPosted = opts.onFollowUpPosted ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
    const state = GruAwareness.loadState(this.file);
    this.cursor = state.coveredThroughSeq;
    this.lastDeliveredAt = state.digest?.lastDeliveredAt ?? null;
    this.lastOwnerAt = state.digest?.lastOwnerAt !== undefined ? state.digest.lastOwnerAt : this.lastDeliveredAt;
    this.lastOwnerSeq = state.digest?.lastOwnerSeq ?? state.coveredThroughSeq;
    this.pendingWakeIds = new Set(state.wake?.pending ?? []);
    this.followUpDue = new Map((state.wake?.followUp ?? []).map(({ id, dueAtMs }) => [id, dueAtMs]));
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
    const lastFiredAt = wakeRecord['lastFiredAt'];
    const pending = wakeRecord['pending'];
    const followUp = wakeRecord['followUp'];
    const version = wakeRecord['version'];
    const lastAttemptAt = wakeRecord['lastAttemptAt'];
    if (
      !Array.isArray(woken) ||
      !woken.every((id): id is string => typeof id === 'string' && id !== '') ||
      !(pending === undefined || (Array.isArray(pending) && pending.every((id): id is string => typeof id === 'string' && id !== ''))) ||
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
    // v1 claimed IDs before the model turn. Its woken set cannot prove
    // receipt (a failed spawn may have stranded a live alert). Prefer one
    // extra wake to losing an unresolved machine incident on upgrade.
    return { coveredThroughSeq: value, wake: {
      version: 2,
      woken: version === 2 ? woken : [],
      lastFiredAt: version === 2 ? lastFiredAt : null,
      lastAttemptAt: version === 2 && typeof lastAttemptAt === 'number' ? lastAttemptAt : null,
      ...(pending !== undefined ? { pending: pending as string[] } : {}),
      ...(followUp !== undefined ? { followUp: followUp as { id: string; dueAtMs: number }[] } : {}),
    }, ...(digest !== undefined ? { digest } : {}) };
  }

  /** Attach the wake action once the chat server exists (late-bound).
   * Reclassify legacy owner stops BEFORE scanning for machine wakes even
   * if composition bound awareness before the notification center. */
  setWakeSink(sink: () => void): void {
    this.ledger.migrateOwnerHeldNotifications();
    this.wakeSink = sink;
    this.restoreFollowUps();
    this.seedBacklog();
    this.flushPendingWakes();
  }

  /** Stop the deferred-wake timer (service shutdown / test teardown). */
  dispose(): void {
    this.disposed = true;
    this.cancelWakeTimer();
    if (this.followUpTimer !== null) clearTimeout(this.followUpTimer);
    this.followUpTimer = null;
  }

  /**
   * Build the context block for a turn, or null when nothing happened
   * (empty case: inject nothing, cost nothing). Does not consume — commit
   * separately once the turn actually received the block.
   */
  prepare(): AwarenessInjection | null {
    const latest = this.ledger.latestEventSeq();
    const morning = this.activeWakeIds === null ? this.morningDigest() : null;
    // A delivered context block is not a disposition. Open machine and
    // owner stops remain in subsequent user turns even after the event
    // cursor advanced; only an active wake uses its exclusive bounded batch.
    const openAttention = (() => {
      if (this.activeWakeIds !== null) return [];
      const owners = this.ledger.listNotifications({ routing: 'needs-owner', unackedOnly: true, limit: this.limits.maxActionNotes });
      const machines = this.ledger.listNotifications({ routing: 'action-required', unackedOnly: true, limit: this.limits.maxActionNotes });
      // Keep both queues represented in a bounded user block. One busy
      // category must not silently crowd out the other indefinitely.
      const ownerSlots = machines.length > 0 && this.limits.maxActionNotes > 1
        ? Math.ceil(this.limits.maxActionNotes / 2) : this.limits.maxActionNotes;
      const selectedOwners = owners.slice(0, ownerSlots);
      return [...selectedOwners, ...machines.slice(0, this.limits.maxActionNotes - selectedOwners.length),
        ...owners.slice(ownerSlots, this.limits.maxActionNotes)];
    })();
    if (latest <= this.cursor && this.pendingWakeIds.size === 0 && morning === null && openAttention.length === 0) return null;

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
    const seenIds = new Set<string>();
    const addNote = (id: string): void => {
      if (seenIds.has(id) || notes.length >= this.limits.maxActionNotes) return;
      seenIds.add(id);
      const row = this.ledger.getNotification(id);
      if (row === null || row.ackedAt !== null || row.resolvedAt !== null) return;
      // A stop reclassified while a wake was waiting must never ride a
      // machine-only turn; all mode explicitly opts into owner context.
      if (this.activeWakeIds !== null && this.wakeMode === 'action-required' && row.routing !== 'action-required') return;
      const detail = row.detail !== null && row.detail !== '' ? ` — ${row.detail}` : '';
      const icon = row.routing === 'action-required' ? '⚠' : row.routing === 'needs-owner' ? '🔔' : 'ℹ';
      notes.push({ id, line: `- ${icon} [${id}] ${row.title}${detail} (routing: ${row.routing})` });
    };
    if (this.activeWakeIds !== null) {
      for (const id of this.activeWakeIds) addNote(id);
    } else {
      for (const row of openAttention) addNote(row.id);
      for (const id of this.pendingWakeIds) addNote(id);
    }
    if (this.activeWakeIds === null && notes.length < this.limits.maxActionNotes) {
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
      for (const id of [...eventIds].reverse()) addNote(id);
    }
    const rendered = this.render(notes, digestLines, overflow, morning);
    if (rendered === null) return null;
    if (this.activeWakeIds !== null && rendered.ids.length === 0) {
      this.log('error', 'wake context has no visible notification IDs; increase awareness line/byte limits', {
        notification_ids: this.activeWakeIds,
      });
      return null;
    }
    return { text: rendered.text, coveredThroughSeq: latest, notificationIds: rendered.ids };
  }

  /** Commit a delivered block: advance the event cursor. Only a user chat
   * turn advances the independent owner watermark used by the morning digest. */
  commit(injection: AwarenessInjection, source: 'chat' | 'wake' = 'chat'): void {
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

  /** Wake receipt: `gru.wake` records only successful delivery. A failed
   * attempt leaves IDs pending and appends a durable `gru.wake-failed`. */
  noteWakeOutcome(ok: boolean, detail?: string, injection?: AwarenessInjection): void {
    if (this.disposed) return;
    const active = this.activeWakeIds ?? [];
    const delivered = active.filter((id) => injection?.notificationIds?.includes(id));
    this.activeWakeIds = null;
    this.prunePending();
    if (ok && delivered.length > 0) {
      for (const id of delivered) this.pendingWakeIds.delete(id);
      const at = this.now();
      this.wakePolicy.fired(delivered, at);
      for (const id of delivered) {
        const row = this.ledger.getNotification(id);
        if (row?.routing === 'action-required' && row.ackedAt === null && row.resolvedAt === null &&
            this.ledger.getNotification(this.followUpId(id)) === null) {
          this.followUpDue.set(id, at + UNRESOLVED_FOLLOW_UP_MS);
        }
      }
      this.failedRetryAtMs = 0;
      this.log('info', 'gru wake opened', { notification_ids: delivered, count: delivered.length, mode: this.wakeMode });
      try {
        this.ledger.appendCustomEvent({ kind: 'gru.wake', payload: { notification_ids: delivered, count: delivered.length, mode: this.wakeMode } });
      } catch (error) {
        this.log('error', 'gru wake ledger event failed', { error: String(error) });
      }
      this.persistWakeState();
      this.scheduleFollowUps();
      this.flushPendingWakes();
      return;
    }
    const reason = detail !== undefined && detail !== '' ? detail : 'no alert context delivered';
    this.log('error', 'gru wake turn failed', { error: reason, notification_ids: active });
    try {
      this.ledger.appendCustomEvent({ kind: 'gru.wake-failed', payload: { error: reason, notification_ids: active } });
    } catch (error) {
      this.log('error', 'gru wake failure event failed', { error: String(error) });
    }
    this.persistWakeState();
    // A failed spawn/prompt must not burn the id. Bound retries so a broken
    // runtime cannot storm when the configured minimum interval is zero.
    if (this.pendingWakeIds.size > 0) {
      this.failedRetryAtMs = this.now() + 5_000;
      this.flushPendingWakes();
    }
  }

  private render(
    actionNotes: readonly { id: string; line: string }[],
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
    if (morning !== null) for (const line of morning) push(line);
    if (digestLines.length > 0) {
      push('Since your last turn:');
      for (const line of digestLines) push(line);
    }
    if (parts.length === 1) return null;
    if (truncated) push('- (further context omitted…)', true);
    return { text: parts.join('\n'), ids };
  }

  /** "While you were away" digest (owner ruling 2026-09-23): the first
   * delivered block after a quiet gap summarises wakes (fires), actions,
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
    const bounded = (label: string, count: number, noun: string): void => {
      if (count > 0) push(`- ${label}: ${count} ${noun}${count === 1 ? '' : 's'}`);
    };
    const wakes = this.ledger.listEventsAfter(this.lastOwnerSeq, { kinds: ['gru.wake'], limit: 100 }).length;
    bounded('fires', wakes, 'wake acted on');
    const actions = this.ledger.listEventsAfter(this.lastOwnerSeq, {
      kinds: [...MORNING_ACTION_KINDS],
      limit: 100,
    }).length;
    bounded('actions', actions, 'board event');
    const jobs = this.ledger.listJobs();
    const list = (ids: readonly string[]): string =>
      `${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ` +${ids.length - 3} more` : ''}`;
    const merges = jobs.filter((job) => job.status === 'merged' && Date.parse(job.updatedAt) > since);
    if (merges.length > 0) push(`- merges: ${list(merges.map((job) => job.id))}`);
    const staged = jobs.filter(
      (job) => job.prUrl !== null && job.status !== 'merged' && job.status !== 'done',
    );
    if (staged.length > 0) push(`- staged PRs: ${list(staged.map((job) => job.id))}`);
    if (lines.length === 0) return null;
    return [`While you were away (since ${new Date(since).toISOString()}):`, ...lines];
  }

  private persist(): void {
    const state: AwarenessState = {
      coveredThroughSeq: this.cursor,
      wake: { version: 2, ...this.wakePolicy.snapshot(), pending: [...this.pendingWakeIds],
        followUp: [...this.followUpDue].map(([id, dueAtMs]) => ({ id, dueAtMs })) },
      digest: { lastDeliveredAt: this.lastDeliveredAt, lastOwnerAt: this.lastOwnerAt, lastOwnerSeq: this.lastOwnerSeq },
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
        const wasDelivered = this.wakePolicy.forget(closedId);
        const wasPending = this.followUpDue.delete(closedId);
        if (wasDelivered || wasPending) this.persistWakeState();
        if (wasPending) this.scheduleFollowUps();
        // Once Gru dispositions the machine row, clear any owner escalation
        // opened by the unresolved-attention timer without forging an Ack.
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
    // Terminal rows never wake — the human already closed the item.
    const row = this.ledger.getNotification(id);
    if (row === null || row.ackedAt !== null || row.resolvedAt !== null) return;
    this.considerCandidate({ id: row.id, routing: row.routing, severity: row.severity });
  }

  /** Route/severity/dedupe gate, then claim or defer — never fire twice for
   * the same id, never fire through the cap of the rate limit. */
  private considerCandidate(candidate: WakeCandidate): void {
    const decision = this.wakePolicy.decide(candidate, this.now());
    if (decision.action === 'skip') {
      this.log('debug', 'gru wake suppressed', {
        notification_id: candidate.id,
        routing: candidate.routing,
        severity: candidate.severity,
        reason: decision.reason,
      });
      return;
    }
    this.pendingWakeIds.add(candidate.id);
    this.persistWakeState();
    if (decision.action === 'wake') {
      this.flushPendingWakes();
      return;
    }
    this.scheduleWake(decision.retryAtMs, decision.reason);
  }

  private followUpId(id: string): string {
    return `gru-follow-up:${id}`;
  }

  private followUpKind(id: string): string {
    return `gru.attention-unresolved.${id}`;
  }

  /** One durable, delayed owner escalation if a delivered machine wake is
   * still unresolved. A prompt receipt alone cannot finish attention. */
  private restoreFollowUps(): void {
    let changed = false;
    for (const [id] of this.followUpDue) {
      const row = this.ledger.getNotification(id);
      if (row?.routing === 'action-required' && row.ackedAt === null && row.resolvedAt === null &&
          this.ledger.getNotification(this.followUpId(id)) === null) continue;
      this.followUpDue.delete(id);
      changed = true;
    }
    // v2 receipts predate the follow-up field: grandfather each still-open
    // machine row into a grace period, never into a new automatic Gru wake.
    for (const id of this.wakePolicy.snapshot().woken) {
      const row = this.ledger.getNotification(id);
      if (row?.routing !== 'action-required' || row.ackedAt !== null || row.resolvedAt !== null ||
          this.followUpDue.has(id) || this.ledger.getNotification(this.followUpId(id)) !== null) continue;
      this.followUpDue.set(id, this.now() + UNRESOLVED_FOLLOW_UP_MS);
      changed = true;
    }
    if (changed) this.persistWakeState();
    this.scheduleFollowUps();
  }

  private scheduleFollowUps(): void {
    if (this.followUpTimer !== null) clearTimeout(this.followUpTimer);
    this.followUpTimer = null;
    if (this.disposed || this.wakeSink === null || this.followUpDue.size === 0) return;
    let due = Infinity;
    for (const at of this.followUpDue.values()) due = Math.min(due, at);
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, due - this.now()));
    const timer = setTimeout(() => {
      this.followUpTimer = null;
      for (const [id, at] of this.followUpDue) {
        if (at > this.now()) continue;
        const row = this.ledger.getNotification(id);
        if (row?.routing !== 'action-required' || row.ackedAt !== null || row.resolvedAt !== null) {
          this.followUpDue.delete(id);
          continue;
        }
        const escalationId = this.followUpId(id);
        try {
          const existing = this.ledger.getNotification(escalationId);
          if (existing !== null && (existing.kind !== this.followUpKind(id) || existing.routing !== 'needs-owner')) {
            throw new Error(`Gru follow-up ID ${escalationId} is already assigned to another notification`);
          }
          if (existing === null) {
            const posted = this.ledger.recordNotification({
              id: escalationId,
              kind: this.followUpKind(id),
              routing: 'needs-owner',
              severity: 'error',
              title: `Gru attention unresolved: ${row.title}`,
              detail: `Notification ${id} was delivered to Gru but remains open after 30 minutes. Check the incident and authorize the next step if needed.`,
            });
            try {
              this.onFollowUpPosted(posted);
            } catch (error) {
              // The durable owner row/bell already exists. A chat notice
              // failure cannot duplicate or retract that escalation.
              this.log('error', 'gru owner follow-up chat notice failed', { notification_id: id, error: String(error) });
            }
          }
          this.followUpDue.delete(id);
        } catch (error) {
          this.log('error', 'gru unresolved attention escalation failed; retrying', { notification_id: id, error: String(error) });
          this.followUpDue.set(id, this.now() + FOLLOW_UP_RETRY_MS);
        }
      }
      this.persistWakeState();
      this.scheduleFollowUps();
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.followUpTimer = timer;
  }

  /** Seed unresolved rows that predate boot. The normal mode filters
   * machine routing in SQL; explicit all mode includes FYI/owner rows. */
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
    try {
      // Filter in SQL BEFORE LIMIT in machine-only mode and page every
      // matching row. Unrelated owner/FYI rows may outnumber this page.
      for (let offset = 0;; offset += MAX_BACKLOG_SEED) {
        const rows = this.ledger.listNotifications({
          unackedOnly: true, ...(this.wakeMode === 'action-required' ? { routing: 'action-required' as const } : {}),
          limit: MAX_BACKLOG_SEED, offset,
        });
        for (const row of rows) {
          if (this.wakePolicy.decide({ id: row.id, routing: row.routing, severity: row.severity }, this.now()).action === 'skip') continue;
          this.pendingWakeIds.add(row.id);
          seeded = true;
        }
        if (rows.length < MAX_BACKLOG_SEED) break;
      }
    } catch (error) {
      this.log('error', 'gru wake backlog scan failed', { error: String(error) });
      return;
    }
    if (seeded) this.persistWakeState();
    this.flushPendingWakes();
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
    // The interval limits attempted autonomous turns, not only successes.
    // Persist before calling the sink so a failed spawn and process restart
    // cannot reset the budget or burn the pending notification IDs.
    this.wakePolicy.attempted(this.now());
    this.persistWakeState();
    try {
      this.wakeSink();
    } catch (error) {
      this.noteWakeOutcome(false, String(error));
    }
  }

  /** Closed or rerouted candidates must not hold a retry timer open. */
  private prunePending(): void {
    let changed = false;
    for (const id of this.pendingWakeIds) {
      const row = this.ledger.getNotification(id);
      if (row !== null && row.ackedAt === null && row.resolvedAt === null &&
          this.wakePolicy.decide({ id, routing: row.routing, severity: row.severity }, this.now()).action !== 'skip') continue;
      this.pendingWakeIds.delete(id);
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
