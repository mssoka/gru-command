import type { NotifyWakeMode, QuietHours } from '../config.js';

/**
 * Gru wake policy (owner ruling 2026-09-23): a critical notification must
 * OPEN a Gru turn, not wait for the user. The awareness layer used to stop
 * at passive injection — between user messages nothing of Gru ran, so
 * action-required alerts sat unacked until the user pinged. This module is
 * the decision layer that closes that gap, deliberately isolated from the
 * chat server (pinned by unit tests, no sockets):
 *
 *   - ROUTING GATE — `notify_wake = "action-required"` wakes on machine
 *     attention ('action-required' rows); `"all"` wakes on every
 *     notification; `"never"` is passive-only. 'needs-owner' rows are the
 *     human's business — under the routing split they ring the owner bell
 *     and never burn a machine turn (only the explicit 'all' mode wakes
 *     for them too).
 *   - SEVERITY GATE — `wake_min_severity` raises the bar for a wake
 *     without changing routing ('error' wakes only on error-severity
 *     rows).
 *   - DEDUPE — one wake per notification id; a repeated event for the
 *     same unacked row (or a restart) never burns a second turn. IDs of
 *     open incidents persist; terminal rows are pruned by awareness.
 *   - RATE LIMIT — `wake_min_interval_ms` (default 5 min) bounds
 *     autonomous turns; candidates inside the window coalesce into ONE
 *     trailing wake (the awareness layer batches their ids).
 *   - QUIET HOURS — `wake_quiet_hours = "22:00-07:00"` defers wakes to
 *     the window's end. Off by default; local time; windows may wrap
 *     midnight.
 *
 * The policy is pure decision logic plus delivered IDs and the latest
 * attempted/successful wake time. Timers, persistence, and turns live in
 * GruAwareness / the chat server.
 */

export type WakeSeverity = 'info' | 'error';

/** Minimal routing shape the policy consumes (the ledger's union). */
export interface WakeCandidate {
  readonly id: string;
  /** Issue #219: the incident identity (alert kind + subject + head SHA
   * where applicable) — a re-detected incident under a NEW notification ID
   * carries the SAME key and must not open a second wake. */
  readonly incidentKey: string;
  readonly routing: 'fyi' | 'action-required' | 'needs-owner';
  readonly severity: WakeSeverity;
}

export type WakeSkipReason = 'mode' | 'routing' | 'severity' | 'dedupe' | 'duplicate-incident';

export type WakeDecision =
  | { readonly action: 'wake' }
  /** Allowed, but not yet: rate limit or quiet hours. `retryAtMs` is the
   * earliest instant the schedule allows; the caller coalesces until then. */
  | { readonly action: 'defer'; readonly reason: 'rate' | 'quiet'; readonly retryAtMs: number }
  | { readonly action: 'skip'; readonly reason: WakeSkipReason };

export interface WakePolicyConfig {
  readonly mode: NotifyWakeMode;
  readonly minSeverity: WakeSeverity;
  /** Minimum interval between autonomous wake turns; 0 disables the cap. */
  readonly minIntervalMs: number;
  readonly quietHours: QuietHours | null;
}

export interface WakePolicyState {
  /** Notification IDs present in a successfully delivered wake turn. */
  readonly woken: readonly string[];
  /** Epoch ms of the newest successful wake (null before the first one). */
  readonly lastFiredAt: number | null;
  /** Epoch ms of the newest attempted turn, including failed spawns/prompts. */
  readonly lastAttemptAt?: number | null;
  /** Issue #219: incident keys already woken. Unlike `woken` IDs (pruned
   * when the row closes), keys PERSIST across resolutions — a re-detected
   * incident under a fresh row ID stays a duplicate. Bounded by
   * WOKEN_INCIDENT_CAP with oldest-first eviction; a key evicted after a
   * long quiet period may wake once more, which is honest (the incident
   * is old) rather than harmful. */
  readonly wokenIncidents?: readonly string[];
}

/** Maximum remembered incident keys (insertion-ordered eviction). */
export const WOKEN_INCIDENT_CAP = 512;

const SEVERITY_RANK: Readonly<Record<WakeSeverity, number>> = { info: 0, error: 1 };

/** Local minute-of-day for an epoch instant (quiet hours are local time —
 * the operator's "night", not UTC's). */
export function localMinuteOfDay(atMs: number): number {
  const date = new Date(atMs);
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Is `atMs` inside the quiet window? Windows may wrap midnight
 * (22:00-07:00 is active from 22:00 to 06:59:59…). Null window = off.
 */
export function quietHoursActive(window: QuietHours | null, atMs: number): boolean {
  if (window === null) return false;
  const minute = localMinuteOfDay(atMs);
  if (window.startMinute < window.endMinute) {
    return minute >= window.startMinute && minute < window.endMinute;
  }
  return minute >= window.startMinute || minute < window.endMinute;
}

/**
 * The epoch instant the quiet window ends at/after `atMs` — the deferral
 * target. Only meaningful while the window is active; returns null when it
 * is not.
 */
export function quietHoursEnd(window: QuietHours | null, atMs: number): number | null {
  if (!quietHoursActive(window, atMs)) return null;
  // Walk epoch minutes rather than using Date.setHours: on fall-back it
  // chooses the *first* occurrence of an ambiguous hour, which can be in
  // the past while the second occurrence is still quiet. On spring-forward
  // the configured end minute may not exist at all. Find the first future
  // non-quiet instant (at most one local day plus DST adjustment).
  const minuteMs = 60_000;
  for (let next = Math.floor(atMs / minuteMs) * minuteMs + minuteMs;
    next <= atMs + 26 * 60 * minuteMs; next += minuteMs) {
    if (!quietHoursActive(window, next)) return next;
  }
  throw new Error('wake quiet window has no future endpoint within 26 hours');
}

/** Validate the operator's `"HH:MM-HH:MM"` quiet window; empty = off. */
export function parseQuietHours(value: string): QuietHours | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(trimmed);
  if (match === null) {
    throw new Error(
      `quiet hours must be "HH:MM-HH:MM" (local time, e.g. "22:00-07:00"), got "${value}"`,
    );
  }
  const startMinute = Number(match[1]) * 60 + Number(match[2]);
  const endMinute = Number(match[3]) * 60 + Number(match[4]);
  if (Number(match[1]) > 23 || Number(match[3]) > 23 || Number(match[2]) > 59 || Number(match[4]) > 59) {
    throw new Error(`quiet hours out of range (00:00-23:59), got "${value}"`);
  }
  if (startMinute === endMinute) {
    throw new Error(`quiet hours window "${value}" is empty (start equals end)`);
  }
  return { startMinute, endMinute };
}

/** Does this candidate's routing/severity/dedupe allow a wake at all? */
function candidateGate(
  config: WakePolicyConfig,
  candidate: WakeCandidate,
  woken: ReadonlySet<string>,
  wokenIncidents: { readonly has: (key: string) => boolean },
): WakeDecision {
  if (config.mode === 'never') return { action: 'skip', reason: 'mode' };
  const routingWakes =
    candidate.routing === 'action-required' || config.mode === 'all';
  if (!routingWakes) return { action: 'skip', reason: 'routing' };
  if (SEVERITY_RANK[candidate.severity] < SEVERITY_RANK[config.minSeverity]) {
    return { action: 'skip', reason: 'severity' };
  }
  // ID dedupe (a repeated event for the same row) and incident dedupe
  // (issue #219: a re-detected incident under a new row ID) both hold.
  if (woken.has(candidate.id)) return { action: 'skip', reason: 'dedupe' };
  if (wokenIncidents.has(candidate.incidentKey)) {
    return { action: 'skip', reason: 'duplicate-incident' };
  }
  return { action: 'wake' };
}

export class WakePolicy {
  private readonly config: WakePolicyConfig;
  private readonly woken: Set<string>;
  /** Insertion-ordered incident keys (issue #219); oldest evicted at cap. */
  private readonly wokenIncidents: Map<string, null>;
  private lastFiredAt: number | null;
  private lastAttemptAt: number | null;

  constructor(config: WakePolicyConfig, state: WakePolicyState = { woken: [], lastFiredAt: null }) {
    this.config = config;
    this.woken = new Set(state.woken);
    this.wokenIncidents = new Map(
      (state.wokenIncidents ?? []).slice(-WOKEN_INCIDENT_CAP).map((key) => [key, null as never]),
    );
    this.lastFiredAt = state.lastFiredAt;
    this.lastAttemptAt = state.lastAttemptAt ?? null;
  }

  /** Full decision for one candidate at one instant (candidate gate +
   * schedule). Does not mutate — callers claim ids with `fired()`. */
  decide(candidate: WakeCandidate, atMs: number): WakeDecision {
    const gate = candidateGate(this.config, candidate, this.woken, this.wokenIncidents);
    if (gate.action !== 'wake') return gate;
    return this.scheduleDecision(atMs);
  }

  /** Routing/severity/mode eligibility WITHOUT dedupe or schedule — the
   * admission boundary re-check (issue #102) runs this for an
   * already-claimed batch, whose members are by then in the dedupe state
   * by design. Returns the skip reason, or null when still eligible. */
  gate(candidate: WakeCandidate): WakeSkipReason | null {
    if (this.config.mode === 'never') return 'mode';
    const routingWakes =
      candidate.routing === 'action-required' || this.config.mode === 'all';
    if (!routingWakes) return 'routing';
    if (SEVERITY_RANK[candidate.severity] < SEVERITY_RANK[this.config.minSeverity]) return 'severity';
    return null;
  }

  /** Rate-limit + quiet-hours decision for a pending batch at one instant
   * (no candidate gates; the batch members already passed them). */
  scheduleDecision(atMs: number): WakeDecision {
    const newestAttempt = Math.max(this.lastFiredAt ?? -Infinity, this.lastAttemptAt ?? -Infinity);
    if (this.config.minIntervalMs > 0 && Number.isFinite(newestAttempt)) {
      const earliest = newestAttempt + this.config.minIntervalMs;
      if (atMs < earliest) return { action: 'defer', reason: 'rate', retryAtMs: earliest };
    }
    if (quietHoursActive(this.config.quietHours, atMs)) {
      const end = quietHoursEnd(this.config.quietHours, atMs);
      // quietHoursActive true implies a resolvable end; fail loud rather
      // than silently dropping the wake if that invariant ever breaks.
      if (end === null) {
        throw new Error('wake policy invariant violated: quiet window active without an end');
      }
      return { action: 'defer', reason: 'quiet', retryAtMs: end };
    }
    return { action: 'wake' };
  }

  /** An attempted turn consumes the autonomous-turn budget even on error. */
  attempted(atMs: number): void {
    this.lastAttemptAt = atMs;
  }

  /** Claim only IDs delivered in a successful turn, plus their incident
   * keys (issue #219) so the re-detected incident cannot wake again. */
  fired(ids: readonly string[], atMs: number, incidentKeys: readonly string[] = []): void {
    for (const id of ids) this.woken.add(id);
    for (const key of incidentKeys) {
      this.wokenIncidents.delete(key); // re-insert to keep recency order honest
      this.wokenIncidents.set(key, null as never);
      if (this.wokenIncidents.size > WOKEN_INCIDENT_CAP) {
        const oldest = this.wokenIncidents.keys().next().value;
        if (oldest !== undefined) this.wokenIncidents.delete(oldest);
      }
    }
    this.lastFiredAt = atMs;
  }

  /** Terminal rows no longer need ID dedupe memory; live IDs never age
   * out. Incident keys deliberately persist (issue #219) — a resolved row
   * does not spend its incident's key. */
  forget(id: string): boolean {
    return this.woken.delete(id);
  }

  /** Issue #115: a failed accepted turn rolls its bounded-retry incidents
   * back OUT of the dedupe state so the retry can re-claim them. The
   * `gru.wake` receipt stays on the ledger (the turn DID open — board
   * truth); only the wake-eligibility claim is released. */
  forgetIncident(key: string): boolean {
    return this.wokenIncidents.delete(key);
  }

  /** Is this notification id already claimed by a delivered wake? The
   * pending-set prune uses this: an id claimed by receipt replay is DONE
   * and must not sit in pending waiting to re-prompt. */
  claimed(id: string): boolean {
    return this.woken.has(id);
  }

  snapshot(): WakePolicyState {
    return {
      woken: [...this.woken],
      wokenIncidents: [...this.wokenIncidents.keys()],
      lastFiredAt: this.lastFiredAt,
      lastAttemptAt: this.lastAttemptAt,
    };
  }
}
