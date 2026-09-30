// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageLike } from '../theme.js';
import { memoryStorage } from '../lib/chat-storage.js';
import type { BoardClient } from '../lib/board-client.js';
import type { BoardSnapshot, NotificationView } from '../lib/board-protocol.js';
import { BoardView } from './board.js';
import {
  OWNER_CHIME_MUTE_KEY,
  OWNER_CHIME_NOTES_HZ,
  OWNER_CHIME_NUDGE_CLASS,
  OWNER_CHIME_PEAK,
  OWNER_CHIME_THROTTLE_MS,
  OwnerChime,
  type ChimeAudioContext,
  type ChimeGainNode,
  type ChimeNotification,
  type ChimeOscillatorNode,
} from './owner-chime.js';

/** Deterministic AudioContext stub: records the scheduled envelope. */
class StubParam {
  readonly writes: Array<{ readonly kind: string; readonly value: number; readonly time: number }> = [];

  setValueAtTime(value: number, time: number): this {
    this.writes.push({ kind: 'set', value, time });
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.writes.push({ kind: 'linear', value, time });
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    this.writes.push({ kind: 'exp', value, time });
    return this;
  }
}

class StubOscillator {
  type = 'sine';
  readonly frequency = new StubParam();
  startAt: number | null = null;
  stopAt: number | null = null;
  /** R4 shape: this node's FIRST stop() call throws (after start()) —
   * exactly the in-progress-note stranded-outside-cleanup bug. */
  failFirstStop = false;

  connect(destination: unknown): unknown {
    return destination;
  }

  start(when?: number): void {
    this.startAt = when ?? 0;
  }

  stop(when?: number): void {
    if (this.failFirstStop) {
      this.failFirstStop = false; // one refusal, then stop() works
      throw new Error('stop refused after start');
    }
    this.stopAt = when ?? 0;
  }
}

class StubGain {
  readonly gain = new StubParam();
  disconnected = false;

  connect(destination: unknown): unknown {
    return destination;
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

class StubAudioContext {
  currentTime = 100;
  /** Playback truth the chime reads — starts 'suspended' like a real
   * browser before the gesture; a successful resume flips it to
   * 'running' (synchronously in the stub, microtask in a browser). */
  state: 'running' | 'suspended' = 'suspended';
  readonly destination: unknown = {};
  readonly oscillators: StubOscillator[] = [];
  readonly gains: StubGain[] = [];
  resumeCalls = 0;
  /** 'ok' resolves; 'reject' rejects; 'throw' throws synchronously;
   * 'gate' parks until releaseResume() flips state and resolves. */
  resumeMode: 'ok' | 'reject' | 'throw' | 'gate' = 'ok';
  /** Scheduling failure: createOscillator throws although the context
   * reports 'running' — the dead/hostile-node regression shape. */
  throwOnCreateOscillator = false;
  /** Partial-scheduling failure (R3): createOscillator throws only on
   * the Nth node ever created (0-based) — e.g. 1 = the second note of
   * the first chime — after earlier notes already started. */
  failOnNthOscillator: number | null = null;
  /** R4 shape: the Nth oscillator's first stop() throws after start(). */
  failStopOnNthOscillator: number | null = null;
  private oscillatorsCreated = 0;
  private gateResolve: (() => void) | null = null;

  createOscillator(): ChimeOscillatorNode {
    if (this.throwOnCreateOscillator) throw new Error('audio node allocation failed');
    if (this.failOnNthOscillator !== null && this.oscillatorsCreated === this.failOnNthOscillator) {
      throw new Error(`audio node ${this.failOnNthOscillator} allocation failed`);
    }
    const oscillator = new StubOscillator();
    if (this.failStopOnNthOscillator !== null && this.oscillatorsCreated === this.failStopOnNthOscillator) {
      oscillator.failFirstStop = true;
    }
    this.oscillatorsCreated += 1;
    this.oscillators.push(oscillator);
    return oscillator;
  }

  createGain(): ChimeGainNode {
    const gain = new StubGain();
    this.gains.push(gain);
    return gain;
  }

  resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.resumeMode === 'throw') throw new Error('resume refused');
    if (this.resumeMode === 'reject') return Promise.reject(new Error('still suspended'));
    if (this.resumeMode === 'gate') {
      return new Promise<void>((resolve) => {
        this.gateResolve = resolve;
      });
    }
    this.state = 'running';
    return Promise.resolve();
  }

  /** The autoplay holdout lifts: resume starts succeeding. */
  resumeSucceeds(): void {
    this.resumeMode = 'ok';
  }

  /** Release a parked 'gate' resume and flip to running. */
  releaseResume(): void {
    this.state = 'running';
    this.gateResolve?.();
    this.gateResolve = null;
  }
}

interface Harness {
  readonly chime: OwnerChime;
  readonly context: StubAudioContext;
  readonly storage: StorageLike;
  readonly indicator: HTMLButtonElement;
  readonly bell: HTMLButtonElement;
  readonly factoryCalls: { count: number };
}

interface HarnessOptions {
  readonly storage?: StorageLike;
  readonly now?: () => number;
  readonly createContext?: () => ChimeAudioContext | null;
  readonly omitFactory?: boolean;
}

function mountDom(): void {
  document.body.innerHTML = `
    <div id="chip-rail" hidden>
      <span id="board-decisions"></span>
      <span id="board-unacked" hidden></span>
      <span id="board-wakes" hidden></span>
    </div>
    <div id="board-jobs"></div>
    <section id="board-owner" hidden></section>
    <div id="board-agents"></div>
    <span id="rail-agents-count">0</span>
    <button id="sound-toggle">🔈</button>
    <button id="notification-bell"><span class="board-bell__badge" id="notification-badge">0</span></button>
    <div id="notification-panel"><div id="notification-list"></div></div>
  `;
}

function harness(options: HarnessOptions = {}): Harness {
  mountDom();
  const context = new StubAudioContext();
  const factoryCalls = { count: 0 };
  const storage = options.storage ?? memoryStorage();
  const createContext = options.omitFactory
    ? undefined
    : options.createContext ??
      (() => {
        factoryCalls.count += 1;
        return context;
      });
  const chime = new OwnerChime({
    storage,
    indicator: document.getElementById('sound-toggle') as HTMLButtonElement,
    bell: document.getElementById('notification-bell') as HTMLButtonElement,
    createContext,
    now: options.now,
  });
  return {
    chime,
    context,
    storage,
    indicator: document.getElementById('sound-toggle') as HTMLButtonElement,
    bell: document.getElementById('notification-bell') as HTMLButtonElement,
    factoryCalls,
  };
}

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

/** A fresh, unhandled notification for the chime seam. */
function fresh(routing: string): ChimeNotification {
  return { routing, ackedAt: null, resolvedAt: null };
}

describe('owner chime — arming (autoplay policy)', () => {
  it('arms on the first interaction anywhere, exactly once', () => {
    const h = harness();
    expect(h.chime.armed).toBe(false);
    expect(h.indicator.dataset.armed).toBe('false');

    document.dispatchEvent(new Event('keydown'));
    expect(h.chime.armed).toBe(true);
    expect(h.factoryCalls.count).toBe(1);
    expect(h.indicator.dataset.armed).toBe('true');
    expect(h.context.resumeCalls).toBe(1);

    // A burst of later gestures never re-arms / rebuilds the graph.
    document.dispatchEvent(new Event('keydown'));
    document.dispatchEvent(new Event('pointerdown'));
    expect(h.factoryCalls.count).toBe(1);
    expect(h.context.resumeCalls).toBe(1);
  });

  it('the speaker indicator enables first, then toggles mute — persisted', () => {
    const h = harness();
    h.indicator.click();
    expect(h.chime.armed).toBe(true);
    expect(h.chime.muted).toBe(false);

    h.indicator.click();
    expect(h.chime.muted).toBe(true);
    expect(h.storage.getItem(OWNER_CHIME_MUTE_KEY)).toBe('true');
    expect(h.indicator.dataset.muted).toBe('true');
    expect(h.indicator.textContent).toBe('🔇');

    h.indicator.click();
    expect(h.chime.muted).toBe(false);
    expect(h.storage.getItem(OWNER_CHIME_MUTE_KEY)).toBeNull();
    expect(h.indicator.textContent).toBe('🔈');
  });

  it('a REJECTED resume never claims armed: arrivals nudge, the throttle is not consumed, and a later gesture retries', () => {
    mountDom();
    const context = new StubAudioContext();
    context.resumeMode = 'reject';
    const chime = new OwnerChime({
      storage: memoryStorage(),
      indicator: document.getElementById('sound-toggle') as HTMLButtonElement,
      bell: document.getElementById('notification-bell') as HTMLButtonElement,
      createContext: () => context,
    });
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(chime.armed).toBe(false); // context exists but cannot play
    expect(context.resumeCalls).toBe(1);

    // Arrivals must NOT be swallowed as silent 'chime' + consumed throttle.
    expect(chime.notify(fresh('needs-owner'))).toBe('nudge');
    expect(context.oscillators).toHaveLength(0);
    expect(chime.notify(fresh('needs-owner'))).toBe('nudge'); // nothing consumed

    // The next gesture retries resume; once it lands, sound is real.
    context.resumeSucceeds();
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(chime.armed).toBe(true);
    expect(context.resumeCalls).toBe(2);
    expect(chime.notify(fresh('needs-owner'))).toBe('chime');
    expect(context.oscillators).toHaveLength(2); // the ONE two-note chime
  });

  it('a resume() that THROWS synchronously is retried, never swallowed as armed', () => {
    mountDom();
    const context = new StubAudioContext();
    context.resumeMode = 'throw';
    const chime = new OwnerChime({
      storage: memoryStorage(),
      indicator: document.getElementById('sound-toggle') as HTMLButtonElement,
      bell: document.getElementById('notification-bell') as HTMLButtonElement,
      createContext: () => context,
    });
    expect(() => document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))).not.toThrow();
    expect(chime.armed).toBe(false);
    expect(chime.notify(fresh('needs-owner'))).toBe('nudge');
    expect(context.oscillators).toHaveLength(0);

    context.resumeSucceeds(); // the synchronous refusal lifts
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(chime.armed).toBe(true);
    expect(chime.notify(fresh('needs-owner'))).toBe('chime');
    expect(context.oscillators).toHaveLength(2);
  });

  it('a SUSPENDED context keeps the visual nudge until resume actually lands', async () => {
    vi.useFakeTimers();
    mountDom();
    const context = new StubAudioContext();
    context.resumeMode = 'gate'; // parks until releaseResume()
    const chime = new OwnerChime({
      storage: memoryStorage(),
      indicator: document.getElementById('sound-toggle') as HTMLButtonElement,
      bell: document.getElementById('notification-bell') as HTMLButtonElement,
      createContext: () => context,
    });
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(chime.armed).toBe(false); // resume in flight, still suspended
    expect(chime.notify(fresh('needs-owner'))).toBe('nudge');
    expect(document.getElementById('notification-bell')?.classList.contains(OWNER_CHIME_NUDGE_CLASS)).toBe(true);
    expect(context.oscillators).toHaveLength(0);

    context.releaseResume(); // the promise resolves, state -> running
    await Promise.resolve(); // let the .then(syncIndicator) microtask run
    expect(chime.armed).toBe(true);
    expect(chime.notify(fresh('needs-owner'))).toBe('chime');
    expect(context.oscillators).toHaveLength(2);
  });

  it('degrades to the visual fallback when Web Audio is unavailable', () => {
    const scope = window as unknown as Record<string, unknown>;
    const saved = { audio: scope.AudioContext, webkit: scope.webkitAudioContext };
    delete scope.AudioContext;
    delete scope.webkitAudioContext;
    try {
      const h = harness({ omitFactory: true });
      expect(h.chime.arm()).toBe(false);
      expect(h.chime.notify(fresh('needs-owner'))).toBe('nudge');
      expect(h.bell.classList.contains(OWNER_CHIME_NUDGE_CLASS)).toBe(true);
    } finally {
      if (saved.audio !== undefined) scope.AudioContext = saved.audio;
      if (saved.webkit !== undefined) scope.webkitAudioContext = saved.webkit;
    }
  });
  it('the speaker says so and disables itself when Web Audio is absent', () => {
    const h = harness({ createContext: () => null });
    h.indicator.click(); // the enabling click
    expect(h.chime.unavailable).toBe(true);
    expect(h.indicator.disabled).toBe(true);
    expect(h.indicator.title).toContain('unavailable');
    expect(h.indicator.getAttribute('aria-label')).toBe(h.indicator.title);
    // A muted-past user with no audio stack gets the same honest control.
    const storage = memoryStorage();
    storage.setItem(OWNER_CHIME_MUTE_KEY, 'true');
    const muted = harness({ storage, createContext: () => null });
    muted.indicator.click();
    expect(muted.indicator.disabled).toBe(true);
  });

  it('a NON-ACTIVATING keydown aimed at the focused speaker arms the chime', () => {
    const h = harness();
    expect(h.chime.armed).toBe(false);
    // The focused speaker receiving ArrowRight: before the fix the guard
    // skipped the speaker for every event type, so this first keyboard
    // interaction armed nothing and a needs-owner arrival merely nudged.
    h.indicator.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(h.chime.armed).toBe(true);
    expect(h.chime.muted).toBe(false); // arming never touched the mute cycle
    expect(h.chime.notify(fresh('needs-owner'))).toBe('chime'); // sounds, no nudge
    expect(h.context.oscillators).toHaveLength(2);
  });

  it('an ACTIVATION key on the speaker enables without double-toggling into mute', () => {
    const h = harness();
    // Space on the focused speaker: the keydown must NOT pre-arm…
    h.indicator.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    expect(h.chime.armed).toBe(false);
    // …so the native activation click it triggers reads enable-first.
    h.indicator.click();
    expect(h.chime.armed).toBe(true);
    expect(h.chime.muted).toBe(false); // enable, never a double-toggle
    // The next activation (Enter) toggles mute, as the cycle promises.
    h.indicator.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    h.indicator.click();
    expect(h.chime.muted).toBe(true);
  });

  it('a click-only activation on another control arms the chime — and the speaker never double-toggles', () => {
    const h = harness();
    expect(h.chime.armed).toBe(false);

    // Click-ONLY activation (AT/switch access, programmatic activation on
    // another control): a click event with no pointerdown/keydown. Before
    // the fix this armed nothing, and the next needs-owner arrival nudged
    // instead of sounding.
    const theme = document.createElement('button');
    theme.id = 'theme-toggle';
    document.body.append(theme);
    theme.click();
    expect(h.chime.armed).toBe(true);
    expect(h.chime.notify(fresh('needs-owner'))).toBe('chime');
    expect(h.context.oscillators).toHaveLength(2);

    // The guard: the speaker's own click-only activation (jsdom fires no
    // pointerdown) must stay enable-first — an unguarded document click
    // listener would pre-arm and make the FIRST speaker click mute.
    const second = harness();
    expect(second.chime.armed).toBe(false);
    second.indicator.click();
    expect(second.chime.armed).toBe(true);
    expect(second.chime.muted).toBe(false); // enable, never a double-toggle
    second.indicator.click();
    expect(second.chime.muted).toBe(true); // the second click mutes, as designed
  });

  it('a transient arm failure retries on the next gesture', () => {
    mountDom();
    const context = new StubAudioContext();
    let fail = true;
    const chime = new OwnerChime({
      storage: memoryStorage(),
      indicator: document.getElementById('sound-toggle') as HTMLButtonElement,
      bell: document.getElementById('notification-bell') as HTMLButtonElement,
      createContext: () => {
        if (fail) throw new Error('resource limit');
        return context;
      },
    });
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(chime.armed).toBe(false); // the throw was transient, not fatal
    expect(chime.unavailable).toBe(false);
    fail = false;
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(chime.armed).toBe(true); // retried and armed
  });

  it('index.html keeps #sound-toggle in the command bar beside the bell', async () => {
    // The chime constructs with mustGet('sound-toggle') at startup — a
    // vanished or renamed button kills the whole app. Pinned in CI here.
    // (vitest's web root is the workspace dir, so index.html is cwd-relative.)
    const { readFileSync } = await import('node:fs');
    const html = readFileSync('index.html', 'utf8');
    const speaker = html.indexOf('id="sound-toggle"');
    const bell = html.indexOf('id="notification-bell"');
    const bar = html.indexOf('class="command-bar"');
    expect(bar).toBeGreaterThanOrEqual(0);
    expect(speaker).toBeGreaterThan(bar);
    expect(bell).toBeGreaterThan(speaker);
  });

});

describe('owner chime — routing gate', () => {
  it('plays exactly one soft two-note chime for a needs-owner arrival', () => {
    const h = harness();
    h.chime.arm();

    expect(h.chime.notify(fresh('needs-owner'))).toBe('chime');
    expect(h.context.oscillators).toHaveLength(2);
    expect(h.context.oscillators.every((oscillator) => oscillator.type === 'sine')).toBe(true);
    expect(h.context.oscillators.map((oscillator) => oscillator.frequency.writes[0]?.value)).toEqual([
      ...OWNER_CHIME_NOTES_HZ,
    ]);
    // ~0.6s total: second note starts ~0.18s after the first, each decays for 0.38s.
    const [first, second] = h.context.oscillators;
    expect(second!.startAt! - first!.startAt!).toBeCloseTo(0.18, 6);
    expect(second!.stopAt! - second!.startAt!).toBeCloseTo(0.4, 6);
    // Low volume: every note peaks at ~-18 dBFS.
    for (const gain of h.context.gains) {
      const peak = gain.gain.writes.find((write) => write.kind === 'linear');
      expect(peak?.value).toBeCloseTo(OWNER_CHIME_PEAK, 6);
      expect(peak?.value).toBeLessThan(0.13);
    }
  });

  it('never sounds for action-required, fyi, or unknown routings', () => {
    const h = harness();
    h.chime.arm();
    expect(h.chime.notify(fresh('action-required'))).toBe('ignored');
    expect(h.chime.notify(fresh('fyi'))).toBe('ignored');
    expect(h.chime.notify(fresh('nope'))).toBe('ignored');
    expect(h.context.oscillators).toHaveLength(0);
    expect(h.bell.classList.contains(OWNER_CHIME_NUDGE_CLASS)).toBe(false);
  });

  it('pulses the bell instead when a needs-owner lands unarmed', () => {
    vi.useFakeTimers();
    const h = harness();
    expect(h.chime.notify(fresh('needs-owner'))).toBe('nudge');
    expect(h.bell.classList.contains(OWNER_CHIME_NUDGE_CLASS)).toBe(true);
    expect(h.context.oscillators).toHaveLength(0);

    vi.advanceTimersByTime(3_000);
    expect(h.bell.classList.contains(OWNER_CHIME_NUDGE_CLASS)).toBe(false);
  });

  it('never sounds for a row another device already acked or resolved', () => {
    const h = harness();
    h.chime.arm();
    const handled: ChimeNotification[] = [
      { routing: 'needs-owner', ackedAt: new Date(0).toISOString(), resolvedAt: null },
      { routing: 'needs-owner', ackedAt: null, resolvedAt: new Date(0).toISOString() },
    ];
    for (const row of handled) {
      expect(h.chime.notify(row)).toBe('ignored');
    }
    expect(h.context.oscillators).toHaveLength(0);
    expect(h.bell.classList.contains(OWNER_CHIME_NUDGE_CLASS)).toBe(false);
  });

});

describe('owner chime — mute', () => {
  it('a storage failure on mute never leaves the UI diverged from storage', () => {
    const storage = memoryStorage();
    const boom = {
      ...storage,
      setItem: () => {
        throw new Error('quota');
      },
    } as typeof storage;
    const h = harness({ storage: boom });
    h.chime.arm();
    expect(() => h.chime.setMuted(true)).toThrow('quota'); // fail loud
    expect(h.chime.muted).toBe(false); // …but nothing half-applied
    expect(storage.getItem(OWNER_CHIME_MUTE_KEY)).toBeNull();
    expect(h.chime.notify(fresh('needs-owner'))).toBe('chime'); // still truthful
  });

  it('persists the mute choice and silences needs-owner across instances', () => {
    const storage = memoryStorage();
    const first = harness({ storage });
    first.chime.setMuted(true);
    expect(storage.getItem(OWNER_CHIME_MUTE_KEY)).toBe('true');

    // A reload (fresh instance, same storage) stays muted.
    const second = harness({ storage });
    expect(second.chime.muted).toBe(true);
    second.chime.arm();
    expect(second.chime.notify(fresh('needs-owner'))).toBe('muted');
    expect(second.context.oscillators).toHaveLength(0);

    // Unmute restores the chime.
    second.chime.setMuted(false);
    expect(second.chime.notify(fresh('needs-owner'))).toBe('chime');
    expect(second.context.oscillators).toHaveLength(2);
  });

  it('stays visually quiet while muted: no chime and no nudge', () => {
    const h = harness();
    h.chime.setMuted(true);
    expect(h.chime.notify(fresh('needs-owner'))).toBe('muted');
    expect(h.bell.classList.contains(OWNER_CHIME_NUDGE_CLASS)).toBe(false);
    expect(h.context.oscillators).toHaveLength(0);
  });
});

describe('owner chime — throttle', () => {
  it('the throttle reads a monotonic clock — wall-clock skew cannot double-ring', () => {
    // The wall clock leaps a minute per call; the monotonic clock advances
    // a second. A Date.now()-backed throttle would ring on the second
    // arrival (>=30s "elapsed"); performance.now() holds the window.
    const mono = { at: 0 };
    vi.spyOn(performance, 'now').mockImplementation(() => (mono.at += 1_000));
    vi.spyOn(Date, 'now').mockImplementation(() => 1_700_000_000_000 + mono.at * 60_000);
    const h = harness(); // no injected `now` — the production default
    h.chime.arm();
    expect(h.chime.notify(fresh('needs-owner'))).toBe('chime');
    expect(h.chime.notify(fresh('needs-owner'))).toBe('throttled');
    expect(h.context.oscillators).toHaveLength(2); // still ONE two-note chime
  });

  it('honors one chime per 30s across a burst', () => {
    let now = 1_000_000;
    const h = harness({ now: () => now });
    h.chime.arm();

    expect(h.chime.notify(fresh('needs-owner'))).toBe('chime');
    expect(h.chime.notify(fresh('needs-owner'))).toBe('throttled');
    now += OWNER_CHIME_THROTTLE_MS - 1;
    expect(h.chime.notify(fresh('needs-owner'))).toBe('throttled');
    now += 1;
    expect(h.chime.notify(fresh('needs-owner'))).toBe('chime');
    expect(h.context.oscillators).toHaveLength(4); // two chimes × two notes
  });
});

describe('owner chime — live board wiring', () => {
  function arrival(id: string, routing: NotificationView['routing']): NotificationView {
    return {
      id,
      ts: '2026-09-23T00:00:00.000Z',
      kind: 'test.arrival',
      routing,
      severity: 'info',
      title: `Notice ${id}`,
      detail: null,
      agentId: null,
      shownAt: null,
      ackedAt: null,
      resolvedAt: null,
      resolvedBy: null,
    };
  }

  function boardSnapshot(notifications: readonly NotificationView[]): BoardSnapshot {
    return {
      repos: [],
      agents: [],
      notifications,
      decisions: {
        enabled: false,
        status: 'disabled',
        reason: null,
        model: 'test-model',
        endpoint: 'test-endpoint',
        credentialPresent: false,
        credentialSource: 'none',
        checkedAt: null,
        incarnation: 'test',
        generation: 0,
      },
      unackedActionRequired: 0,
      unackedNeedsOwner: 0,
      wakes: { count: 0, lastAt: null },
      build: null,
      silas: null,
      verify: null,
      selfHeal: null,
    };
  }

  it('a live burst of needs-owner rows rings exactly one chime', () => {
    const h = harness();
    h.chime.arm();
    const view = new BoardView(() => {});
    view.setToastHandler((notification) => {
      h.chime.notify(notification);
    });

    view.render(boardSnapshot([])); // history baseline: nothing to ring
    view.render(
      boardSnapshot([
        arrival('owner-1', 'needs-owner'),
        arrival('owner-2', 'needs-owner'),
      ]),
    );
    expect(h.context.oscillators).toHaveLength(2); // ONE two-note chime

    // A re-push of the same rows is not a new arrival — still one chime.
    view.render(
      boardSnapshot([
        arrival('owner-1', 'needs-owner'),
        arrival('owner-2', 'needs-owner'),
      ]),
    );
    expect(h.context.oscillators).toHaveLength(2);
  });

  it('a stop() that throws AFTER start() cancels the in-progress note too: nothing stays live, nudge/receipts isolated, retry is one full chime', () => {
    mountDom();
    const context = new StubAudioContext();
    context.failStopOnNthOscillator = 1; // the SECOND note: start() lands, stop() refuses
    const chime = new OwnerChime({
      storage: memoryStorage(),
      indicator: document.getElementById('sound-toggle') as HTMLButtonElement,
      bell: document.getElementById('notification-bell') as HTMLButtonElement,
      createContext: () => context,
    });
    expect(chime.arm()).toBe(true); // playable — the failure is mid-NOTE
    const outcomes: string[] = [];
    const shown: Array<{ id: string; surface: string }> = [];
    const client = {
      markNotificationShown: (id: string, surface: string) => {
        shown.push({ id, surface });
        return Promise.resolve(true);
      },
    } as unknown as BoardClient;
    const view = new BoardView(() => {});
    view.bindClient(client);
    view.setToastHandler((notification) => {
      outcomes.push(chime.notify(notification));
    });

    view.render(boardSnapshot([])); // history baseline

    // Before R4, the in-progress second note never entered the cleanup
    // list: it stayed connected with no stop recorded while notify()
    // returned 'nudge' and left the throttle unconsumed.
    expect(() => view.render(boardSnapshot([arrival('owner-1', 'needs-owner')]))).not.toThrow();
    expect(outcomes).toEqual(['nudge']);
    // Both surfaces record their own display receipt for the visible row:
    // the toast path and the FOR YOU band.
    expect(shown.filter((entry) => entry.surface === 'web-toast').map((entry) => entry.id)).toEqual(['owner-1']);
    expect(shown.filter((entry) => entry.surface === 'web-board').map((entry) => entry.id)).toEqual(['owner-1']);
    expect(
      document.getElementById('notification-bell')?.classList.contains(OWNER_CHIME_NUDGE_CLASS),
    ).toBe(true);
    expect(context.oscillators).toHaveLength(2); // both notes were created…
    // …and NO oscillator remains live: every one is stopped-at-0,
    // including the one whose own stop() had just thrown.
    expect(context.oscillators.every((note) => note.stopAt === 0)).toBe(true);
    expect(context.gains.every((gain) => gain.disconnected)).toBe(true); // no tail stays wired

    // Retry inside the same 30s window (throttle never consumed): ONE
    // full two-note chime, both notes ringing their scheduled decay.
    expect(() => view.render(boardSnapshot([arrival('owner-2', 'needs-owner')]))).not.toThrow();
    expect(outcomes).toEqual(['nudge', 'chime']);
    expect(shown.filter((entry) => entry.surface === 'web-toast').map((entry) => entry.id)).toEqual(['owner-1', 'owner-2']);
    expect(shown.filter((entry) => entry.surface === 'web-board').map((entry) => entry.id)).toEqual(['owner-1', 'owner-2']);
    expect(context.oscillators).toHaveLength(4);
    const retryNotes = context.oscillators.slice(2);
    expect(retryNotes.every((note) => note.startAt !== null)).toBe(true);
    expect(retryNotes.every((note) => note.stopAt !== 0 && note.stopAt !== null)).toBe(true);
    expect(context.gains.slice(2).every((gain) => !gain.disconnected)).toBe(true);
  });

  it('a SECOND-NOTE scheduling failure is atomic through the board wiring: no partial chime rings, nudge and receipts stay intact, an immediate retry is one full chime', () => {
    mountDom();
    const context = new StubAudioContext();
    context.failOnNthOscillator = 1; // the second note of the first chime throws
    const chime = new OwnerChime({
      storage: memoryStorage(),
      indicator: document.getElementById('sound-toggle') as HTMLButtonElement,
      bell: document.getElementById('notification-bell') as HTMLButtonElement,
      createContext: () => context,
    });
    expect(chime.arm()).toBe(true); // playable — the failure is mid-SCHEDULING
    const outcomes: string[] = [];
    const shown: Array<{ id: string; surface: string }> = [];
    const client = {
      markNotificationShown: (id: string, surface: string) => {
        shown.push({ id, surface });
        return Promise.resolve(true);
      },
    } as unknown as BoardClient;
    const view = new BoardView(() => {});
    view.bindClient(client);
    view.setToastHandler((notification) => {
      outcomes.push(chime.notify(notification));
    });

    view.render(boardSnapshot([])); // history baseline

    // Before R3, note 1 stayed scheduled-and-audible while the throw
    // bypassed the throttle — repeated attempts rang partial chimes.
    expect(() => view.render(boardSnapshot([arrival('owner-1', 'needs-owner')]))).not.toThrow();
    expect(outcomes).toEqual(['nudge']);
    // Both surfaces record their own display receipt for the visible row:
    // the toast path and the FOR YOU band.
    expect(shown.filter((entry) => entry.surface === 'web-toast').map((entry) => entry.id)).toEqual(['owner-1']);
    expect(shown.filter((entry) => entry.surface === 'web-board').map((entry) => entry.id)).toEqual(['owner-1']);
    expect(
      document.getElementById('notification-bell')?.classList.contains(OWNER_CHIME_NUDGE_CLASS),
    ).toBe(true); // visual fallback carried the arrival
    expect(context.oscillators).toHaveLength(1); // note 1 was created…
    expect(context.oscillators[0]?.stopAt).toBe(0); // …and cancelled before ringing
    expect(context.gains[0]?.disconnected).toBe(true); // its tail is detached

    // IMMEDIATE retry inside the same 30s window: one FULL two-note
    // chime — no duplicate, no overlap with a partial.
    context.failOnNthOscillator = null;
    expect(() => view.render(boardSnapshot([arrival('owner-2', 'needs-owner')]))).not.toThrow();
    expect(outcomes).toEqual(['nudge', 'chime']);
    expect(shown.filter((entry) => entry.surface === 'web-toast').map((entry) => entry.id)).toEqual(['owner-1', 'owner-2']);
    expect(shown.filter((entry) => entry.surface === 'web-board').map((entry) => entry.id)).toEqual(['owner-1', 'owner-2']);
    expect(context.oscillators).toHaveLength(3); // cancelled note + the two fresh ones
    const retryNotes = context.oscillators.slice(1);
    expect(retryNotes[0]?.startAt).toBeCloseTo(100.01, 6); // the rising pair,
    expect(retryNotes[1]?.startAt).toBeCloseTo(100.19, 6); // gap preserved
    expect(retryNotes.every((note) => note.stopAt !== 0 && note.stopAt !== null)).toBe(true);
    expect(context.gains.slice(1).every((gain) => !gain.disconnected)).toBe(true);
  });

  it('a throwing audio node stays contained through the live board wiring: visual nudge, unconsumed throttle, receipts and remaining notifications still flow', () => {
    mountDom();
    const context = new StubAudioContext();
    context.state = 'running'; // playable: passes the armed gate…
    context.throwOnCreateOscillator = true; // …but scheduling explodes
    const chime = new OwnerChime({
      storage: memoryStorage(),
      indicator: document.getElementById('sound-toggle') as HTMLButtonElement,
      bell: document.getElementById('notification-bell') as HTMLButtonElement,
      createContext: () => context,
    });
    expect(chime.arm()).toBe(true); // playable — the throws below are SCHEDULING failures
    const outcomes: string[] = [];
    const shown: Array<{ id: string; surface: string }> = [];
    const client = {
      markNotificationShown: (id: string, surface: string) => {
        shown.push({ id, surface });
        return Promise.resolve(true);
      },
    } as unknown as BoardClient;
    const view = new BoardView(() => {});
    view.bindClient(client);
    view.setToastHandler((notification) => {
      outcomes.push(chime.notify(notification));
    });

    view.render(boardSnapshot([])); // history baseline
    // Before the containment, this render THREW out of the toast handler,
    // aborting the loop: owner-1 kept no shown receipt and owner-2 was
    // never surfaced at all.
    expect(() =>
      view.render(
        boardSnapshot([arrival('owner-1', 'needs-owner'), arrival('owner-2', 'needs-owner')]),
      ),
    ).not.toThrow();
    expect(outcomes).toEqual(['nudge', 'nudge']); // failure ≠ chime, ≠ throttled
    // Each surface records its own receipt for the rows it displayed.
    expect(shown.filter((entry) => entry.surface === 'web-toast').map((entry) => entry.id).sort()).toEqual(['owner-1', 'owner-2']);
    expect(shown.filter((entry) => entry.surface === 'web-board').map((entry) => entry.id).sort()).toEqual(['owner-1', 'owner-2']);
    expect(
      document.getElementById('notification-bell')?.classList.contains(OWNER_CHIME_NUDGE_CLASS),
    ).toBe(true); // the visual fallback carried the arrival

    // The failure is not a consumed chime: once nodes schedule again the
    // very next arrival rings — the window was never spent.
    context.throwOnCreateOscillator = false;
    view.render(boardSnapshot([arrival('owner-3', 'needs-owner')]));
    expect(outcomes).toEqual(['nudge', 'nudge', 'chime']);
    expect(context.oscillators).toHaveLength(2); // the ONE two-note chime

    // A re-render of the same rows is not a new arrival.
    view.render(boardSnapshot([arrival('owner-3', 'needs-owner')]));
    expect(outcomes).toEqual(['nudge', 'nudge', 'chime']);
  });

  it('a live action-required arrival never rings', () => {
    const h = harness();
    h.chime.arm();
    const view = new BoardView(() => {});
    view.setToastHandler((notification) => {
      h.chime.notify(notification);
    });

    view.render(boardSnapshot([]));
    view.render(boardSnapshot([arrival('machine-1', 'action-required')]));
    expect(h.context.oscillators).toHaveLength(0);
    expect(h.bell.classList.contains(OWNER_CHIME_NUDGE_CLASS)).toBe(false);
  });
});
