import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NotifyWakeMode } from '../config.js';
import type { BusEvent, EventBus } from '../events/bus.js';
import type { LogLevel } from '../logger.js';
import type { EventRecord, LedgerApi } from '../ledger/api.js';

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
 *      notify_wake = 'action-required' an action-required row may start a
 *      turn through the wake sink, with 'all' every notification may. The
 *      default 'never' never wakes: no model turn runs by itself.
 *
 * The cursor (`coveredThroughSeq`) is durable under the chat dir, so a
 * restart never replays context the brain already received. Content is
 * derived from the ledger only — an acked or resolved notification is
 * never injected, and the human still owns every acknowledgement.
 */

export const AWARENESS_STATE_NAME = 'awareness.json';

export const AWARENESS_BLOCK_HEADER = '[gru awareness · service context — not a user message]';

/** Prompt suffix for a policy-started turn (the block itself is prepended). */
export const AWARENESS_WAKE_INSTRUCTION =
  'This turn was started by the service notify_wake policy — no user message is waiting. ' +
  'Review the service context above; if the human must be told something, say it plainly now; ' +
  'otherwise reply briefly.';

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
}

export type GruAwarenessLedger = Pick<
  LedgerApi,
  'getNotification' | 'listEventsAfter' | 'latestEventSeq'
>;

export interface GruAwarenessOptions {
  /** Chat dir (same home as the frame log); the cursor sidecar lives here. */
  readonly dir: string;
  readonly ledger: GruAwarenessLedger;
  /** Notification events drive the wake decision. */
  readonly bus?: Pick<EventBus, 'subscribe'>;
  /** Default 'never' (passive injection only). */
  readonly wakeMode?: NotifyWakeMode;
  readonly limits?: Partial<AwarenessLimits>;
  readonly log?: Log;
}

interface AwarenessState {
  readonly coveredThroughSeq: number;
}

/** Notification event kinds that carry a routing decision. */
const NOTIFICATION_EVENT_KINDS = ['notification.created', 'notification.triaged'] as const;
/** Scan cap for notification events; the render cap is maxActionNotes. */
const MAX_NOTIFICATION_SCAN = 200;
/** Wake-dedupe memory (id set) — bounded so a long-lived service cannot grow forever. */
const MAX_WAKE_IDS = 256;

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
    return `round ${event.roundId ?? '?'}: Perkins ${verdict} (${payload.complete === false ? 'incomplete proof' : 'proof complete'})`;
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
  private readonly wakeMode: NotifyWakeMode;
  private readonly log: Log;
  private cursor: number;
  private wakeSink: (() => void) | null = null;
  /** Notification ids that already drove a wake (bounded insertion order). */
  private readonly woken = new Set<string>();

  constructor(opts: GruAwarenessOptions) {
    this.file = join(opts.dir, AWARENESS_STATE_NAME);
    this.ledger = opts.ledger;
    this.limits = { ...AWARENESS_LIMITS, ...(opts.limits ?? {}) };
    this.wakeMode = opts.wakeMode ?? 'never';
    this.log = opts.log ?? (() => {});
    this.cursor = GruAwareness.loadCursor(this.file);
    opts.bus?.subscribe((event) => this.onBusEvent(event));
  }

  /**
   * Read the durable cursor. An absent file is the documented start state
   * (cursor 0 = the first prepared block covers the newest bounded window).
   * A present-but-invalid file fails loud — a silent reset would re-inject
   * context the brain already received.
   */
  private static loadCursor(file: string): number {
    if (!existsSync(file)) return 0;
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
    const value = (parsed as Record<string, unknown>)['coveredThroughSeq'];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(
        `gru awareness state ${file} has an invalid coveredThroughSeq; ` +
          'refusing to guess — inspect or remove the file (a fresh cursor starts at the beginning)',
      );
    }
    return value;
  }

  /** Attach the wake action once the chat server exists (late-bound). */
  setWakeSink(sink: () => void): void {
    this.wakeSink = sink;
  }

  /**
   * Build the context block for a turn, or null when nothing happened
   * (empty case: inject nothing, cost nothing). Does not consume — commit
   * separately once the turn actually received the block.
   */
  prepare(): AwarenessInjection | null {
    const latest = this.ledger.latestEventSeq();
    if (latest <= this.cursor) return null;

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

    // Action notes ride a kind-filtered scan so a busy digest window can
    // never hide an escalation older than maxEvents. Newest ids are kept
    // under the note cap, then rendered oldest-first.
    const notificationEvents = this.ledger.listEventsAfter(this.cursor, {
      limit: MAX_NOTIFICATION_SCAN,
      order: 'desc',
      kinds: [...NOTIFICATION_EVENT_KINDS],
    });
    const seenIds = new Set<string>();
    const notes: string[] = [];
    for (const event of notificationEvents) {
      const payload = payloadOf(event);
      if (payload['routing'] !== 'action-required') continue;
      const id = textOf(payload['id']);
      if (id === null || seenIds.has(id)) continue;
      seenIds.add(id);
      const row = this.ledger.getNotification(id);
      if (row === null || row.ackedAt !== null || row.resolvedAt !== null) continue;
      const detail = row.detail !== null && row.detail !== '' ? ` — ${row.detail}` : '';
      notes.push(`- ⚠ ${row.title}${detail}`);
      if (notes.length >= this.limits.maxActionNotes) break;
    }
    notes.reverse();

    const text = this.render(notes, digestLines, overflow);
    if (text === null) return null;
    return { text, coveredThroughSeq: latest };
  }

  /** Commit a delivered block: advance the durable cursor to exactly the
   * seq the block accounted for. Never regresses on out-of-order commits. */
  commit(injection: AwarenessInjection): void {
    this.cursor = Math.max(this.cursor, injection.coveredThroughSeq);
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

  private render(
    actionNotes: readonly string[],
    digestLines: readonly string[],
    overflow: boolean,
  ): string | null {
    const parts: string[] = [AWARENESS_BLOCK_HEADER];
    let bytes = Buffer.byteLength(AWARENESS_BLOCK_HEADER, 'utf8');
    let truncated = overflow;
    let exhausted = false;
    const push = (line: string, force = false): void => {
      if (exhausted && !force) return;
      const sized = clampLine(line, this.limits.maxLineChars);
      const size = Buffer.byteLength(sized, 'utf8') + 1; // newline
      if (bytes + size > this.limits.maxBytes) {
        truncated = true;
        exhausted = true;
        return;
      }
      parts.push(sized);
      bytes += size;
    };

    if (actionNotes.length > 0) {
      push('Action required (unacknowledged):');
      for (const note of actionNotes) push(note);
    }
    if (digestLines.length > 0) {
      push('Since your last turn:');
      for (const line of digestLines) push(line);
    }
    if (parts.length === 1) return null;
    if (truncated) push('- (further context omitted…)', true);
    return parts.join('\n');
  }

  private persist(): void {
    const state: AwarenessState = { coveredThroughSeq: this.cursor };
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

  /** Wake policy decision on one bus event (notification rows only). */
  private onBusEvent(event: BusEvent): void {
    if (this.wakeMode === 'never') return;
    if (event.kind !== 'notification.created' && event.kind !== 'notification.triaged') return;
    const payload = payloadOf(event);
    const id = textOf(payload['id']);
    if (id === null || this.woken.has(id)) return;
    const routing = payload['routing'];
    const wake =
      routing === 'action-required' || (this.wakeMode === 'all' && routing === 'fyi');
    if (!wake) return;
    // Terminal rows never wake — the human already closed the item.
    const row = this.ledger.getNotification(id);
    if (row === null || row.ackedAt !== null || row.resolvedAt !== null) return;
    this.woken.add(id);
    if (this.woken.size > MAX_WAKE_IDS) {
      const oldest = this.woken.values().next().value;
      if (oldest !== undefined) this.woken.delete(oldest);
    }
    this.wakeSink?.();
  }
}
