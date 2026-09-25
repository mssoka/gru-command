/**
 * Owner chime (owner request 2026-09-23): “a nice subtle notification
 * sound when there is a needs-owner notification”.
 *
 * The ONE sound in Gru Command. Keyed on the notifications routing field:
 * `needs-owner` rings the owner bell; `action-required` (machine queue)
 * and FYI rows are silent by design — machine noise stays machine noise.
 *
 *  - SOUND — a soft two-note chime synthesized with Web Audio
 *    (deterministic oscillator envelope, no audio assets, ~0.6s,
 *    peak ~-18 dBFS).
 *  - AUTOPLAY — browsers block audio before a user gesture: the chime
 *    arms on the first interaction anywhere. An unarmed arrival falls
 *    back to a harder bell-badge pulse (no console spam).
 *  - MUTE — the header speaker indicator enables/mutes; the choice is
 *    persisted in localStorage and never hides the badge.
 *  - THROTTLE — at most one chime per 30s; a burst is one sound plus the
 *    merged badge.
 */

import type { StorageLike } from '../theme.js';

/** Persisted mute choice — independent of badge/panel state. */
export const OWNER_CHIME_MUTE_KEY = 'gru-owner-chime-muted';
/** One chime per window; bursts coalesce (never a loop). */
export const OWNER_CHIME_THROTTLE_MS = 30_000;
/** The only routing that ever sounds. */
export const OWNER_CHIME_ROUTING = 'needs-owner';
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
}

export interface ChimeAudioContext {
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
  private readonly now: () => number;
  private readonly throttleMs: number;
  private context: ChimeAudioContext | null = null;
  private mutedState: boolean;
  private lastChimeAt: number | null = null;
  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: OwnerChimeOptions) {
    this.storage = options.storage;
    this.indicator = options.indicator;
    this.bell = options.bell;
    this.createContext = options.createContext ?? browserAudioContext;
    this.now = options.now ?? (() => Date.now());
    this.throttleMs = options.throttleMs ?? OWNER_CHIME_THROTTLE_MS;
    this.mutedState = this.storage.getItem(OWNER_CHIME_MUTE_KEY) === 'true';
    this.indicator.addEventListener('click', () => this.onIndicatorClick());
    if (typeof document !== 'undefined') this.armOnFirstGesture(document);
    this.syncIndicator();
  }

  get armed(): boolean {
    return this.context !== null;
  }

  get muted(): boolean {
    return this.mutedState;
  }

  /** Arm the audio graph. Idempotent; must run inside a user gesture the
   * first time (browser autoplay policy). Returns false when Web Audio is
   * unavailable — callers get the visual fallback, never an exception. */
  arm(): boolean {
    if (this.context !== null) return true;
    let context: ChimeAudioContext | null;
    try {
      context = this.createContext();
    } catch {
      return false; // a hostile/absent audio stack: silent + no spam
    }
    if (context === null) return false;
    this.context = context;
    try {
      void context.resume().catch(() => {
        /* still suspended: the graph schedules anyway and plays once the
           page earns audio playback — never spam the console */
      });
    } catch {
      /* resume() itself threw — the graph remains best-effort */
    }
    this.syncIndicator();
    return true;
  }

  /** Persist the mute choice. Muted = silent until unmuted; the badge
   * and panel are untouched by design. */
  setMuted(muted: boolean): void {
    if (this.mutedState === muted) return;
    this.mutedState = muted;
    if (muted) this.storage.setItem(OWNER_CHIME_MUTE_KEY, 'true');
    else this.storage.removeItem(OWNER_CHIME_MUTE_KEY);
    this.syncIndicator();
  }

  /** The single entry point for arrivals: sound only for `needs-owner`. */
  notify(routing: string): ChimeOutcome {
    if (routing !== OWNER_CHIME_ROUTING) return 'ignored';
    if (this.mutedState) return 'muted';
    if (!this.armed) {
      this.nudge();
      return 'nudge';
    }
    const at = this.now();
    if (this.lastChimeAt !== null && at - this.lastChimeAt < this.throttleMs) return 'throttled';
    this.lastChimeAt = at;
    this.play();
    return 'chime';
  }

  /** First interaction anywhere arms the graph — once. */
  private armOnFirstGesture(target: Document): void {
    const gesture = (event: Event): void => {
      // The indicator's own click distinguishes “enable” from “mute”;
      // let it run its course instead of pre-arming here.
      if (event.target instanceof Node && this.indicator.contains(event.target)) return;
      target.removeEventListener('pointerdown', gesture, true);
      target.removeEventListener('keydown', gesture, true);
      this.arm();
    };
    target.addEventListener('pointerdown', gesture, true);
    target.addEventListener('keydown', gesture, true);
  }

  /** Speaker cycle: muted → on, off (unarmed) → on, on → muted. */
  private onIndicatorClick(): void {
    const wasArmed = this.armed;
    this.arm(); // the click is itself the gesture
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
    this.indicator.textContent = muted ? '🔇' : '🔈';
    this.indicator.setAttribute('aria-pressed', String(muted));
    const title = muted
      ? 'Owner chime muted — click to unmute'
      : armed
        ? 'Owner chime on — click to mute'
        : 'Owner chime enables on your first click';
    this.indicator.title = title;
    this.indicator.setAttribute('aria-label', title);
  }

  /** The soft two-note pattern: sine oscillators, short attack, long
   * exponential decay, one low peak per note. */
  private play(): void {
    const context = this.context;
    if (context === null) return; // only reachable when armed
    const start = context.currentTime + 0.01;
    const [first, second] = OWNER_CHIME_NOTES_HZ;
    this.playNote(context, first, start);
    this.playNote(context, second, start + NOTE_GAP_S);
  }

  private playNote(context: ChimeAudioContext, frequency: number, at: number): void {
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

/** Real Web Audio constructor, when the browser exposes one. */
function browserAudioContext(): ChimeAudioContext | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    AudioContext?: new () => AudioContext;
    webkitAudioContext?: new () => AudioContext;
  };
  const ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (ctor === undefined) return null;
  try {
    return new ctor();
  } catch {
    return null;
  }
}
