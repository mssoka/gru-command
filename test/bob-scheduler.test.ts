import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  BOB_CONSOLIDATION_PROMPT,
  BOB_STATE_FILE,
  BobScheduleError,
  BobScheduler,
  bobStateFile,
  loadBobState,
  saveBobState,
  singleFlightSlot,
  type BobSlot,
  type BobStatePort,
} from '../src/dispatch/bob-scheduler.js';
import type { LogLevel } from '../src/logger.js';
import type { AgentCapabilities, AgentHandle } from '../src/runtime/types.js';

const FAKE_CAPABILITIES: AgentCapabilities = {
  streaming: true,
  steer: 'native',
  resume: 'file',
  images: false,
  thinking: false,
  thinkingLevelControl: false,
  followUp: false,
};

/**
 * Bob's periodic consolidation trigger (EPICS E8 story 4): interval-driven,
 * disabled at 0, never overlapping, loud on failure.
 */

function makeSlot(): { slot: BobSlot; prompts: { text: string; owner?: string }[]; failWith?: Error } {
  const prompts: { text: string; owner?: string }[] = [];
  const state: { failWith?: Error } = {};
  const handle: AgentHandle = {
    role: 'bob',
    id: 'bob-1',
    sessionFile: null,
    capabilities: FAKE_CAPABILITIES,
    prompt(text: string, options?: { owner?: string }) {
      prompts.push({ text, owner: options?.owner });
      if (state.failWith !== undefined) return Promise.reject(state.failWith);
      return Promise.resolve();
    },
    async steer() {},
    async followUp() {},
    subscribe() {
      return () => {};
    },
    health() {
      return { state: 'idle', lastActivity: null, sessionFile: null };
    },
    async dispose() {},
  };
  return {
    slot: { ensure: async () => handle },
    prompts,
    get failWith() {
      return state.failWith;
    },
    set failWith(error: Error | undefined) {
      state.failWith = error;
    },
  };
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** An in-memory schedule seam: what production persists on disk. */
function makeState(lastBobAt: string | null = null): BobStatePort & { beats: string[]; last(): string | null } {
  const beats: string[] = [];
  const state = { lastBobAt };
  return {
    beats,
    last: () => state.lastBobAt,
    lastBobAt: () => state.lastBobAt,
    recordBeat: (at: Date) => {
      beats.push(at.toISOString());
      state.lastBobAt = at.toISOString();
    },
  };
}

function collectLogs(): { logs: { level: LogLevel; msg: string }[]; log: (level: LogLevel, msg: string) => void } {
  const logs: { level: LogLevel; msg: string }[] = [];
  return { logs, log: (level, msg) => logs.push({ level, msg }) };
}

describe('bob scheduler (E8 story 4)', () => {
  it('prompts the bob slot with consolidation instructions on tick', async () => {
    const s = makeSlot();
    const scheduler = new BobScheduler({ intervalMs: 1_000, slot: s.slot });
    const result = await scheduler.tick();
    expect(result.prompted).toBe(true);
    expect(s.prompts).toHaveLength(1);
    expect(s.prompts[0]?.text).toBe(BOB_CONSOLIDATION_PROMPT);
    expect(s.prompts[0]?.owner).toBe('bob-scheduler');
  });

  it('fires on the interval once started, and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const s = makeSlot();
      const scheduler = new BobScheduler({ intervalMs: 100, slot: s.slot });
      scheduler.start();
      expect(scheduler.running).toBe(true);
      await vi.advanceTimersByTimeAsync(350);
      expect(s.prompts.length).toBeGreaterThanOrEqual(3);
      scheduler.stop();
      expect(scheduler.running).toBe(false);
      const fired = s.prompts.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(s.prompts.length).toBe(fired);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never overlaps: a busy tick skips the beat instead of queueing two', async () => {
    const s = makeSlot();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slot: BobSlot = {
      ensure: async () => {
        await gate;
        return (await s.slot.ensure()) as AgentHandle;
      },
    };
    const scheduler = new BobScheduler({ intervalMs: 10, slot });
    const first = scheduler.tick();
    const skipped = await scheduler.tick();
    expect(skipped.prompted).toBe(false);
    expect(skipped.note).toMatch(/still running/);
    release();
    const done = await first;
    expect(done.prompted).toBe(true);
  });

  it('interval 0 disables the trigger entirely', async () => {
    vi.useFakeTimers();
    try {
      const s = makeSlot();
      const scheduler = new BobScheduler({ intervalMs: 0, slot: s.slot });
      scheduler.start();
      expect(scheduler.running).toBe(false);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(s.prompts).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed prompt is reported, never thrown — the next interval retries', async () => {
    const s = makeSlot();
    s.failWith = new Error('model outage');
    const scheduler = new BobScheduler({ intervalMs: 1_000, slot: s.slot });
    const result = await scheduler.tick();
    expect(result.prompted).toBe(false);
    expect(result.note).toMatch(/model outage/);
  });
});

describe('bob scheduler: due-based cadence (issue #451)', () => {
  /** A fake clock: start at a fixed instant, run timers forward, and let
   * the scheduler read the same clock the timers advance. */
  function withClock<T>(start: string, run: () => Promise<T>): Promise<T> {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(start));
    return run().finally(() => {
      vi.useRealTimers();
    });
  }

  it('no persisted lastBobAt means due immediately: one beat on boot', async () => {
    await withClock('2026-10-19T12:00:00.000Z', async () => {
      const s = makeSlot();
      const state = makeState(null);
      const scheduler = new BobScheduler({ intervalMs: WEEK_MS, slot: s.slot, state });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.prompts).toHaveLength(1);
      expect(state.beats).toEqual(['2026-10-19T12:00:00.000Z']);
      scheduler.stop();
    });
  });

  it('a lastBobAt two days old: no boot beat, the next beat is ~5 days out, not 7', async () => {
    await withClock('2026-10-19T12:00:00.000Z', async () => {
      const s = makeSlot();
      const state = makeState('2026-10-17T12:00:00.000Z'); // 2 days ago
      const scheduler = new BobScheduler({ intervalMs: WEEK_MS, slot: s.slot, state });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(4 * DAY_MS);
      expect(s.prompts).toHaveLength(0); // the week was NOT reset by the boot
      await vi.advanceTimersByTimeAsync(DAY_MS - 1);
      expect(s.prompts).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.prompts).toHaveLength(1); // exactly at lastBobAt + 7 days
      expect(state.beats).toEqual(['2026-10-24T12:00:00.000Z']);
      scheduler.stop();
    });
  });

  it('a restart mid-interval inherits the persisted schedule instead of resetting it', async () => {
    await withClock('2026-10-19T12:00:00.000Z', async () => {
      const state = makeState(null);
      const first = new BobScheduler({ intervalMs: WEEK_MS, slot: makeSlot().slot, state, now: () => new Date() });
      first.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(state.beats).toHaveLength(1);
      first.stop();
      // Two days later the service restarts: the week is already 2 days in.
      await vi.advanceTimersByTimeAsync(2 * DAY_MS);
      const s = makeSlot();
      const second = new BobScheduler({ intervalMs: WEEK_MS, slot: s.slot, state });
      second.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.prompts).toHaveLength(0); // no boot beat
      await vi.advanceTimersByTimeAsync(5 * DAY_MS - 1);
      expect(s.prompts).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(s.prompts).toHaveLength(1);
      second.stop();
    });
  });

  it('a beat already running is skipped and logged, and never advances the schedule', async () => {
    const s = makeSlot();
    const state = makeState(null);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slot: BobSlot = {
      ensure: async () => {
        await gate;
        return (await s.slot.ensure()) as AgentHandle;
      },
    };
    const { logs, log } = collectLogs();
    const scheduler = new BobScheduler({ intervalMs: WEEK_MS, slot, state, log });
    const first = scheduler.tick();
    const skipped = await scheduler.tick();
    expect(skipped.prompted).toBe(false);
    expect(logs).toContainEqual({ level: 'info', msg: 'bob beat skipped — previous consolidation still running' });
    // A skipped beat is not a completed consolidation.
    expect(state.beats).toEqual([]);
    release();
    await expect(first).resolves.toEqual({ prompted: true });
    expect(state.beats).toHaveLength(1);
  });

  it('a completed beat still counts when its schedule timestamp cannot be persisted', async () => {
    const s = makeSlot();
    const { logs, log } = collectLogs();
    const scheduler = new BobScheduler({
      intervalMs: WEEK_MS,
      slot: s.slot,
      state: {
        lastBobAt: () => null,
        recordBeat: () => {
          throw new Error('disk full');
        },
      },
      log,
    });
    await expect(scheduler.tick()).resolves.toEqual({ prompted: true });
    expect(s.prompts).toHaveLength(1);
    expect(logs).toContainEqual({
      level: 'error',
      msg: 'bob consolidation completed but its schedule timestamp could not be persisted',
    });
  });

  it('a failed consolidation does not advance lastBobAt — the next beat retries', async () => {
    const s = makeSlot();
    s.failWith = new Error('model outage');
    const state = makeState(null);
    const scheduler = new BobScheduler({ intervalMs: WEEK_MS, slot: s.slot, state });
    const result = await scheduler.tick();
    expect(result.prompted).toBe(false);
    expect(state.beats).toEqual([]);
    expect(state.last()).toBeNull();
  });

  it('a future lastBobAt never delays a beat past one interval (clock rollback)', async () => {
    await withClock('2026-10-19T12:00:00.000Z', async () => {
      const s = makeSlot();
      const state = makeState('2026-10-21T12:00:00.000Z'); // 2 days AHEAD of the clock
      const scheduler = new BobScheduler({ intervalMs: WEEK_MS, slot: s.slot, state });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(s.prompts).toHaveLength(0); // not due yet
      await vi.advanceTimersByTimeAsync(WEEK_MS - 1);
      expect(s.prompts).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      // Clamped to one interval, not lastBobAt + interval (9 days).
      expect(s.prompts).toHaveLength(1);
      expect(state.beats).toEqual(['2026-10-26T12:00:00.000Z']);
      scheduler.stop();
    });
  });

  it('an unparsable persisted timestamp refuses to arm instead of guessing', () => {
    const scheduler = new BobScheduler({
      intervalMs: WEEK_MS,
      slot: makeSlot().slot,
      state: { lastBobAt: () => 'soon', recordBeat: () => {} },
    });
    expect(() => scheduler.start()).toThrow(BobScheduleError);
    expect(scheduler.running).toBe(false);
  });

  it('interval 0 stays the hard off switch, even when long overdue', async () => {
    await withClock('2026-10-19T12:00:00.000Z', async () => {
      const s = makeSlot();
      const state = makeState('2020-01-01T00:00:00.000Z');
      const scheduler = new BobScheduler({ intervalMs: 0, slot: s.slot, state });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(WEEK_MS);
      expect(scheduler.running).toBe(false);
      expect(s.prompts).toHaveLength(0);
      expect(state.beats).toEqual([]);
    });
  });
});

describe('bob schedule persistence (issue #451)', () => {
  const dir = (): string => mkdtempSync(join(tmpdir(), 'gru-bob-state-'));

  it('round-trips through the data-home state file', () => {
    const file = join(dir(), BOB_STATE_FILE);
    expect(loadBobState(file)).toEqual({ version: 1, lastBobAt: null });
    const port = bobStateFile(file);
    port.recordBeat(new Date('2026-10-19T12:00:00.000Z'));
    expect(loadBobState(file)).toEqual({ version: 1, lastBobAt: '2026-10-19T12:00:00.000Z' });
    expect(port.lastBobAt()).toBe('2026-10-19T12:00:00.000Z');
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ version: 1, lastBobAt: '2026-10-19T12:00:00.000Z' });
  });

  it('a corrupt record fails loud instead of guessing a cadence', () => {
    const file = join(dir(), BOB_STATE_FILE);
    for (const text of ['not json', '[]', '{"version":2,"lastBobAt":null}', '{"version":1,"lastBobAt":"soon"}']) {
      writeFileSync(file, text, 'utf-8');
      expect(() => loadBobState(file), text).toThrow(BobScheduleError);
    }
  });

  it('a failed write is a named error with no staging debris', () => {
    const root = dir();
    const file = join(root, 'missing', BOB_STATE_FILE);
    expect(() => saveBobState(file, { version: 1, lastBobAt: null })).toThrow(BobScheduleError);
    expect(readdirSync(root)).toEqual([]);
  });

  it('saving never leaves a half-written file behind', () => {
    const file = join(dir(), BOB_STATE_FILE);
    saveBobState(file, { version: 1, lastBobAt: '2026-10-19T12:00:00.000Z' });
    saveBobState(file, { version: 1, lastBobAt: '2026-10-26T12:00:00.000Z' });
    expect(loadBobState(file).lastBobAt).toBe('2026-10-26T12:00:00.000Z');
    expect(readFileSync(file, 'utf-8')).toBe('{\n  "version": 1,\n  "lastBobAt": "2026-10-26T12:00:00.000Z"\n}\n');
  });
});

describe('single-flight slot (issue #451: one memory agent, two triggers)', () => {
  it('coalesces concurrent ensures onto one spawn and clears after it settles', async () => {
    const handle = {} as AgentHandle;
    let spawns = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slot = singleFlightSlot({
      ensure: async () => {
        spawns += 1;
        await gate;
        return handle;
      },
    });
    const first = slot.ensure();
    const second = slot.ensure();
    expect(spawns).toBe(1); // the dream pass and Bob's knock share one spawn
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([handle, handle]);
    // Once settled, the next ensure is a fresh spawn, not a cached handle.
    await expect(slot.ensure()).resolves.toBe(handle);
    expect(spawns).toBe(2);
  });
});
