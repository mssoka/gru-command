import { describe, expect, it, vi } from 'vitest';
import { withRateLimitRetries, pacingSleep, type RetryEvent } from '../src/runtime/rate-limit-retry.js';

const policy = { baseMs: 100, maxMs: 250, maxRetries: 3, patterns: [] };

describe('workflow-owned rate-limit retry', () => {
  it('records every retry, doubles with jitter, clamps, and stops exactly at the retry budget', async () => {
    const events: RetryEvent[] = [];
    const delays: number[] = [];
    let attempts = 0;
    await expect(withRateLimitRetries(async () => { attempts += 1; throw new Error('HTTP 429'); }, {
      policy, record: (event) => events.push(event), jitter: (cap) => cap,
      sleep: async (ms) => { delays.push(ms); },
    })).rejects.toThrow('HTTP 429');
    expect(attempts).toBe(4);
    expect(delays).toEqual([150, 250, 250]);
    expect(events.map((event) => event.kind)).toEqual(['pacing.auto-retry', 'pacing.auto-retry', 'pacing.auto-retry', 'pacing.auto-retry-exhausted']);
    expect(events.at(-1)?.payload.retry).toBe(3);
  });

  it('non-rate-limit failure never sleeps or records a retry', async () => {
    const record = vi.fn();
    const sleep = vi.fn();
    await expect(withRateLimitRetries(async () => { throw new Error('401 invalid credentials'); }, { policy, record, sleep })).rejects.toThrow('401');
    expect(record).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('disabled policy never auto-retries a 429', async () => {
    const record = vi.fn();
    await expect(withRateLimitRetries(async () => { throw new Error('429'); }, { policy: null, record })).rejects.toThrow('429');
    expect(record).not.toHaveBeenCalled();
  });

  it('a recovered turn records recovery after the scheduled retry', async () => {
    const events: RetryEvent[] = [];
    let calls = 0;
    const result = await withRateLimitRetries(async () => { if (++calls === 1) throw new Error('too many requests'); return 42; }, {
      policy, record: (event) => events.push(event), sleep: async () => {}, jitter: () => 0,
    });
    expect(result).toBe(42);
    expect(events.map((event) => event.kind)).toEqual(['pacing.auto-retry', 'pacing.auto-retry-recovered']);
  });

  it('cancellation during real backoff rejects immediately and starts no new turn', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const waiting = pacingSleep(1000, [controller.signal]);
      const failed = expect(waiting).rejects.toThrow('aborted');
      controller.abort();
      await failed;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
