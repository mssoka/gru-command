import { describe, expect, it, vi } from 'vitest';
import { BobScheduler, BOB_CONSOLIDATION_PROMPT, type BobSlot } from '../src/dispatch/bob-scheduler.js';
import type { AgentHandle } from '../src/runtime/types.js';

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
