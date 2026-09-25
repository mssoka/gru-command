// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StorageLike } from '../theme.js';
import { memoryStorage } from '../lib/chat-storage.js';
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

  connect(destination: unknown): unknown {
    return destination;
  }

  start(when?: number): void {
    this.startAt = when ?? 0;
  }

  stop(when?: number): void {
    this.stopAt = when ?? 0;
  }
}

class StubGain {
  readonly gain = new StubParam();

  connect(destination: unknown): unknown {
    return destination;
  }
}

class StubAudioContext {
  currentTime = 100;
  readonly destination: unknown = {};
  readonly oscillators: StubOscillator[] = [];
  readonly gains: StubGain[] = [];
  resumeCalls = 0;

  createOscillator(): ChimeOscillatorNode {
    const oscillator = new StubOscillator();
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
    return Promise.resolve();
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
    </div>
    <div id="board-jobs"></div>
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

  it('degrades to the visual fallback when Web Audio is unavailable', () => {
    const scope = window as unknown as Record<string, unknown>;
    const saved = { audio: scope.AudioContext, webkit: scope.webkitAudioContext };
    delete scope.AudioContext;
    delete scope.webkitAudioContext;
    try {
      const h = harness({ omitFactory: true });
      expect(h.chime.arm()).toBe(false);
      expect(h.chime.notify('needs-owner')).toBe('nudge');
      expect(h.bell.classList.contains(OWNER_CHIME_NUDGE_CLASS)).toBe(true);
    } finally {
      if (saved.audio !== undefined) scope.AudioContext = saved.audio;
      if (saved.webkit !== undefined) scope.webkitAudioContext = saved.webkit;
    }
  });
});

describe('owner chime — routing gate', () => {
  it('plays exactly one soft two-note chime for a needs-owner arrival', () => {
    const h = harness();
    h.chime.arm();

    expect(h.chime.notify('needs-owner')).toBe('chime');
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
    expect(h.chime.notify('action-required')).toBe('ignored');
    expect(h.chime.notify('fyi')).toBe('ignored');
    expect(h.chime.notify('nope')).toBe('ignored');
    expect(h.context.oscillators).toHaveLength(0);
    expect(h.bell.classList.contains(OWNER_CHIME_NUDGE_CLASS)).toBe(false);
  });

  it('pulses the bell instead when a needs-owner lands unarmed', () => {
    vi.useFakeTimers();
    const h = harness();
    expect(h.chime.notify('needs-owner')).toBe('nudge');
    expect(h.bell.classList.contains(OWNER_CHIME_NUDGE_CLASS)).toBe(true);
    expect(h.context.oscillators).toHaveLength(0);

    vi.advanceTimersByTime(3_000);
    expect(h.bell.classList.contains(OWNER_CHIME_NUDGE_CLASS)).toBe(false);
  });
});

describe('owner chime — mute', () => {
  it('persists the mute choice and silences needs-owner across instances', () => {
    const storage = memoryStorage();
    const first = harness({ storage });
    first.chime.setMuted(true);
    expect(storage.getItem(OWNER_CHIME_MUTE_KEY)).toBe('true');

    // A reload (fresh instance, same storage) stays muted.
    const second = harness({ storage });
    expect(second.chime.muted).toBe(true);
    second.chime.arm();
    expect(second.chime.notify('needs-owner')).toBe('muted');
    expect(second.context.oscillators).toHaveLength(0);

    // Unmute restores the chime.
    second.chime.setMuted(false);
    expect(second.chime.notify('needs-owner')).toBe('chime');
    expect(second.context.oscillators).toHaveLength(2);
  });

  it('stays visually quiet while muted: no chime and no nudge', () => {
    const h = harness();
    h.chime.setMuted(true);
    expect(h.chime.notify('needs-owner')).toBe('muted');
    expect(h.bell.classList.contains(OWNER_CHIME_NUDGE_CLASS)).toBe(false);
    expect(h.context.oscillators).toHaveLength(0);
  });
});

describe('owner chime — throttle', () => {
  it('honors one chime per 30s across a burst', () => {
    let now = 1_000_000;
    const h = harness({ now: () => now });
    h.chime.arm();

    expect(h.chime.notify('needs-owner')).toBe('chime');
    expect(h.chime.notify('needs-owner')).toBe('throttled');
    now += OWNER_CHIME_THROTTLE_MS - 1;
    expect(h.chime.notify('needs-owner')).toBe('throttled');
    now += 1;
    expect(h.chime.notify('needs-owner')).toBe('chime');
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
      h.chime.notify(notification.routing);
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

  it('a live action-required arrival never rings', () => {
    const h = harness();
    h.chime.arm();
    const view = new BoardView(() => {});
    view.setToastHandler((notification) => {
      h.chime.notify(notification.routing);
    });

    view.render(boardSnapshot([]));
    view.render(boardSnapshot([arrival('machine-1', 'action-required')]));
    expect(h.context.oscillators).toHaveLength(0);
    expect(h.bell.classList.contains(OWNER_CHIME_NUDGE_CLASS)).toBe(false);
  });
});
