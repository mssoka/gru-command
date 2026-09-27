/**
 * Owner chime (owner request 2026-09-23): “a nice subtle notification
 * sound when there is a needs-owner notification”.
 *
 * The ONE sound in Gru Command. Keyed on the notifications routing field:
 * `needs-owner` rings the owner bell; `action-required` (machine queue)
 * and FYI rows are silent by design — machine noise stays machine noise,
 * and rows another device already acked or resolved are history, never
 * fresh audio.
 *
 *  - SOUND — a soft two-note chime synthesized with Web Audio
 *    (deterministic oscillator envelope, no audio assets, ~0.6s,
 *    peak ~-18 dBFS).
 *  - AUTOPLAY — browsers block audio before a user gesture: the chime
 *    arms on the first interaction anywhere (pointer, key, or click —
 *    click-only activation paths count). Until playback is actually
 *    possible (a suspended context, a rejected or thrown resume), an
 *    arrival falls back to a harder bell-badge pulse (no console spam)
 *    and later gestures retry the resume. A browser with no Web Audio
 *    stack gets an honest disabled speaker, not a dead one.
 *  - MUTE — the header speaker indicator enables/mutes; the choice is
 *    persisted in localStorage and never hides the badge.
 *  - THROTTLE — at most one chime per 30s (monotonic clock — wall-clock
 *    skew cannot double-ring or silence it); a burst is one sound plus
 *    the merged badge.
 */

import type { StorageLike } from '../theme.js';

/** Persisted mute choice — independent of badge/panel state. */
export const OWNER_CHIME_MUTE_KEY = 'gru-owner-chime-muted';
/** One chime per window; bursts coalesce (never a loop). */
export const OWNER_CHIME_THROTTLE_MS = 30_000;
/** The only routing that ever sounds. */
export const OWNER_CHIME_ROUTING = 'needs-owner';

/** The arrival shape the chime decides on. Handled rows (`ackedAt`/
 * `resolvedAt`) never sound — the owner already answered them, on this
 * device or another; they are history, not fresh audio. */
export interface ChimeNotification {
  readonly routing: string;
  readonly ackedAt: string | null;
  readonly resolvedAt: string | null;
}
/** Two soft notes: A5 → D6 (a rising perfect fourth). */
export const OWNER_CHIME_NOTES_HZ = [880, 1174.66] as const;
/** ~-18 dBFS peak — a deliberately low, subtle envelope. */
export const OWNER_CHIME_PEAK = 10 ** (-18 / 20);
/** Bell nudge class for the unarmed visual fallback. */
export const OWNER_CHIME_NUDGE_CLASS = 'board-bell--nudge';

const NOTE_GAP_S = 0.18;
const ATTACK_S = 0.012;
const DECAY_S = 0.38;
const TAIL_S = 0.02;
const FLOOR = 0.0001;
const NUDGE_MS = 3_000;

/** Minimal Web Audio surface the chime schedules on. The real
 * `AudioContext` satisfies it structurally; tests inject a stub so the
 * deterministic envelope can be asserted without a browser audio stack. */
export interface ChimeAudioParam {
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  exponentialRampToValueAtTime(value: number, time: number): unknown;
}

export interface ChimeOscillatorNode {
  type: string;
  readonly frequency: ChimeAudioParam;
  connect(destination: unknown): unknown;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface ChimeGainNode {
  readonly gain: ChimeAudioParam;
  connect(destination: unknown): unknown;
  /** Cancellation seam: detaches any already-flowing tail. */
  disconnect(): void;
}

export interface ChimeAudioContext {
  /** Playback truth: 'running' means sound can leave the speakers now;
   * 'suspended' (autoplay holdout, failed resume) means it cannot. */
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  createOscillator(): ChimeOscillatorNode;
  createGain(): ChimeGainNode;
  resume(): Promise<void>;
}

/** What a notify() call decided (asserted by tests; useful in logs). */
export type ChimeOutcome = 'chime' | 'nudge' | 'muted' | 'throttled' | 'ignored';

export interface OwnerChimeOptions {
  readonly storage: StorageLike;
  /** The header speaker indicator — click enables/mutes. */
  readonly indicator: HTMLButtonElement;
  /** The notification bell — the unarmed fallback nudges it. */
  readonly bell: HTMLElement;
  /** Audio seam: tests inject a deterministic stub; browsers get Web Audio. */
  readonly createContext?: () => ChimeAudioContext | null;
  readonly now?: () => number;
  readonly throttleMs?: number;
}

export class OwnerChime {
  private readonly storage: StorageLike;
  private readonly indicator: HTMLButtonElement;
  private readonly bell: HTMLElement;
  private readonly createContext: () => ChimeAudioContext | null;
  /** Monotonic by default (performance.now): a wall-clock jump must
   * neither double-ring inside the 30s window nor silence it until the
   * clock re-passes the last chime. */
  private readonly now: () => number;
  private readonly throttleMs: number;
  private context: ChimeAudioContext | null = null;
  private mutedState: boolean;
  /** Set when the browser exposes no audio stack at all — permanent,
   * surfaced on the speaker instead of promising a click that can never
   * succeed. A construction THROW is transient and stays retryable. */
  private audioUnavailable = false;
  private lastChimeAt: number | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: OwnerChimeOptions) {
    this.storage = options.storage;
    this.indicator = options.indicator;
    this.bell = options.bell;
    this.createContext = options.createContext ?? browserAudioContext;
    this.now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.throttleMs = options.throttleMs ?? OWNER_CHIME_THROTTLE_MS;
    this.mutedState = this.storage.getItem(OWNER_CHIME_MUTE_KEY) === 'true';
    this.indicator.addEventListener('click', () => this.onIndicatorClick());
    if (typeof document !== 'undefined') this.armOnFirstGesture(document);
    this.syncIndicator();
  }

  get armed(): boolean {
    // Playable, not merely constructed: a context that sits suspended
    // (autoplay holdout, rejected or thrown resume) cannot sound, so it
    // must not count as armed — arrivals keep the visual nudge and
    // gestures keep retrying resume until playback is actually possible.
    return this.context !== null && this.context.state === 'running';
  }

  get muted(): boolean {
    return this.mutedState;
  }

  get unavailable(): boolean {
    return this.audioUnavailable;
  }

  /** Arm the audio graph. Idempotent; must run inside a user gesture the
   * first time (browser autoplay policy). Returns true only when audio
   * is PLAYABLE now — a context whose resume() rejected or threw stays
   * un-armed and is retried on a later gesture; callers get the visual
   * fallback, never an exception. A `null` factory result marks the
   * stack permanently absent; a thrown construction stays retryable. */
  arm(): boolean {
    if (this.context === null) {
      if (this.audioUnavailable) return false;
      let context: ChimeAudioContext | null;
      try {
        context = this.createContext();
      } catch {
        return false; // transient (e.g. resource limit) — retry later
      }
      if (context === null) {
        this.audioUnavailable = true; // no audio stack in this browser
        this.syncIndicator();
        return false;
      }
      this.context = context;
    }
    if (this.context.state !== 'running') {
      // Suspended (autoplay holdout or a failed earlier resume): ask
      // again — callers re-arm on later gestures, and the arrival path
      // keeps the visual nudge until this actually lands.
      try {
        void this.context
          .resume()
          .then(() => {
            this.syncIndicator(); // state flipped to 'running'
          })
          .catch(() => {
            /* still suspended: arrivals nudge and the next gesture
               retries — never spam the console */
          });
      } catch {
        /* resume() itself threw synchronously — retryable on a later
           gesture; claiming armed here would silently swallow arrivals */
      }
    }
    this.syncIndicator();
    return this.armed;
  }

  /** Persist the mute choice BEFORE flipping in-memory state, so a
   * throwing storage (quota exhausted, access revoked) fails loudly out
   * of the click without leaving the UI muted-but-unpersisted — the same
   * fail-loud contract the theme toggle follows. */
  setMuted(muted: boolean): void {
    if (this.mutedState === muted) return;
    if (muted) this.storage.setItem(OWNER_CHIME_MUTE_KEY, 'true');
    else this.storage.removeItem(OWNER_CHIME_MUTE_KEY);
    this.mutedState = muted;
    this.syncIndicator();
  }

  /** The single entry point for arrivals: sound only for `needs-owner`
   * rows nobody has handled yet. */
  notify(notification: ChimeNotification): ChimeOutcome {
    if (notification.routing !== OWNER_CHIME_ROUTING) return 'ignored';
    if (notification.ackedAt !== null || notification.resolvedAt !== null) return 'ignored';
    if (this.mutedState) return 'muted';
    if (!this.armed) {
      this.nudge();
      return 'nudge';
    }
    const at = this.now();
    if (this.lastChimeAt !== null && at - this.lastChimeAt < this.throttleMs) return 'throttled';
    try {
      this.play();
    } catch {
      // A Web Audio scheduling failure (a dead or hostile node throwing in
      // create/connect/start) is CONTAINED at this seam: it must not
      // escape into the board pipeline, where it would abort the shown
      // receipt, the remaining snapshot notifications, and the render
      // that follows. The arrival still earns its visual nudge, and the
      // throttle window stays unconsumed — a failed chime is not a chime.
      this.nudge();
      return 'nudge';
    }
    this.lastChimeAt = at; // consumed only by a successfully scheduled chime
    return 'chime';
  }

  /** First interaction anywhere arms the graph — once PLAYABLE. Pointer,
   * key, AND click activation count: some real activation paths (AT/switch
   * access, programmatic activation) produce only a click with no
   * pointerdown/keydown, and those must arm too. A context that exists
   * but stays suspended keeps the listeners: a rejected/thrown resume is
   * retried on the next gesture (a permanently absent stack short-
   * circuits in arm()). The indicator is excluded on every event type —
   * its own handler owns the enable-vs-mute cycle, and a pre-arm here
   * would double-toggle it into mute on the very first click. */
  private armOnFirstGesture(target: Document): void {
    const gesture = (event: Event): void => {
      if (event.target instanceof Node && this.indicator.contains(event.target)) return;
      if (this.armed || this.audioUnavailable) {
        target.removeEventListener('pointerdown', gesture, true);
        target.removeEventListener('keydown', gesture, true);
        target.removeEventListener('click', gesture, true);
        return;
      }
      this.arm();
    };
    target.addEventListener('pointerdown', gesture, true);
    target.addEventListener('keydown', gesture, true);
    target.addEventListener('click', gesture, true);
  }

  /** Speaker cycle: muted → on, off (unarmed) → on, on → muted. With no
   * audio stack at all the speaker says so once and disables itself —
   * never a dead control that keeps promising “enables on first click”. */
  private onIndicatorClick(): void {
    const wasArmed = this.armed;
    this.arm(); // the click is itself the gesture
    if (this.audioUnavailable && !wasArmed) {
      this.indicator.disabled = true;
      this.syncIndicator();
      return;
    }
    if (this.mutedState) {
      this.setMuted(false);
    } else if (wasArmed) {
      this.setMuted(true);
    }
    // else: this very click enabled the chime — stay unmuted.
  }

  private syncIndicator(): void {
    const muted = this.mutedState;
    const armed = this.armed;
    this.indicator.dataset.muted = String(muted);
    this.indicator.dataset.armed = String(armed);
    this.indicator.dataset.unavailable = String(this.audioUnavailable);
    this.indicator.textContent = muted ? '🔇' : '🔈';
    this.indicator.setAttribute('aria-pressed', String(muted));
    const title = this.audioUnavailable
      ? 'Owner chime unavailable — this browser has no Web Audio'
      : muted
        ? 'Owner chime muted — click to unmute'
        : armed
          ? 'Owner chime on — click to mute'
          : 'Owner chime enables on your first click';
    this.indicator.title = title;
    this.indicator.setAttribute('aria-label', title);
  }

  /** The soft two-note pattern: sine oscillators, short attack, long
   * exponential decay, one low peak per note. */
  /** The soft two-note pattern: sine oscillators, short attack, long
   * exponential decay, one low peak per note. SCHEDULING IS ATOMIC — if
   * any note fails to schedule, every note this attempt already created
   * is cancelled (stopped + detached) before the failure propagates, so
   * a partial chime can never ring: the caller's fallback is the visual
   * nudge, and an unconsumed throttle never buys repeated half-chimes. */
  private play(): void {
    const context = this.context;
    if (context === null) return; // only reachable when armed
    const start = context.currentTime + 0.01;
    const [first, second] = OWNER_CHIME_NOTES_HZ;
    const scheduled: Array<{ readonly oscillator: ChimeOscillatorNode; readonly gain: ChimeGainNode }> = [];
    try {
      scheduled.push(this.playNote(context, first, start));
      scheduled.push(this.playNote(context, second, start + NOTE_GAP_S));
    } catch (error) {
      for (const note of scheduled) this.cancelNote(note);
      throw error;
    }
  }

  private playNote(
    context: ChimeAudioContext,
    frequency: number,
    at: number,
  ): { readonly oscillator: ChimeOscillatorNode; readonly gain: ChimeGainNode } {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, at);
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(OWNER_CHIME_PEAK, at + ATTACK_S);
    gain.gain.exponentialRampToValueAtTime(FLOOR, at + DECAY_S);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + DECAY_S + TAIL_S);
    return { oscillator, gain };
  }

  /** Best-effort cancellation of a partially scheduled note. Never
   * throws: stop() on a never-started oscillator (or a hostile node) is
   * already a failed graph — there is nothing audible left to protect. */
  private cancelNote(note: { readonly oscillator: ChimeOscillatorNode; readonly gain: ChimeGainNode }): void {
    try {
      note.oscillator.stop(0); // before/at now: the note never rings on
    } catch {
      /* never started — nothing scheduled to silence */
    }
    try {
      note.gain.disconnect(); // detach any tail already flowing
    } catch {
      /* already detached */
    }
  }

  /** Unarmed fallback: a bounded, stronger bell-badge pulse. */
  private nudge(): void {
    this.bell.classList.add(OWNER_CHIME_NUDGE_CLASS);
    if (this.nudgeTimer !== null) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => {
      this.bell.classList.remove(OWNER_CHIME_NUDGE_CLASS);
      this.nudgeTimer = null;
    }, NUDGE_MS);
  }
}

/** Real Web Audio constructor, when the browser exposes one. `null`
 * means the stack is absent (permanent); a construction throw propagates
 * to arm()'s transient-failure branch. */
function browserAudioContext(): ChimeAudioContext | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  const ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (ctor === undefined) return null;
  return new ctor();
}
