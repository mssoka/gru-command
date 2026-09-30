import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_PACING_CONFIG, type PacingConfig } from '../src/config.js';
import {
  backoffDelayMs,
  compileRateLimitPatterns,
  isRateLimitErrorText,
  PacingGate,
  resolvePacingPolicy,
  resolveRateLimitBackoff,
} from '../src/runtime/pacing.js';

/**
 * Provider pacing unit tests (owner heist 2026-09-29): the rate-limit class
 * is provider-agnostic, the backoff ladder is bounded by [pacing]
 * backoff_base_ms / backoff_max_ms / max_auto_retries, and the FIFO
 * admission gate queues worker/review turns without rejecting or
 * preempting. The supervisor's wiring (retries, events, ladder fallback,
 * off-by-default) is pinned in supervisor.test.ts.
 */

function pacingConfig(overrides: Partial<PacingConfig> = {}): PacingConfig {
  return { ...DEFAULT_PACING_CONFIG, enabled: true, ...overrides };
}

describe('rate-limit error class (provider-agnostic)', () => {
  it('matches the 429 family and plain-language rate-limit signatures', () => {
    const rateLimited = [
      '429: {"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}',
      'HTTP 429',
      'status 429 (Too Many Requests)',
      'RateLimited by upstream',
      'rate limit hit',
      'rate-limited: slow down',
      'ratelimit exceeded',
      'too many requests',
      'requests are throttled',
      'throttling active',
    ];
    for (const text of rateLimited) {
      expect(isRateLimitErrorText(text), text).toBe(true);
    }
  });

  it('does not match auth, billing, transport, server, or hang failures', () => {
    const notRateLimited = [
      'HTTP 401 unauthorized',
      'invalid api key',
      'quota exceeded',
      'insufficient balance',
      'billing hard limit reached',
      'ECONNRESET while reading response',
      'HTTP 500 internal server error',
      'turn hang detected after 900000ms',
      'fatal: session crashed',
      'port 42901 connection refused',
    ];
    for (const text of notRateLimited) {
      expect(isRateLimitErrorText(text), text).toBe(false);
    }
  });

  it('matches configured per-provider signatures without any provider name in code', () => {
    expect(isRateLimitErrorText('pacing code 1302 from the provider', [])).toBe(false);
    expect(
      isRateLimitErrorText('pacing code 1302 from the provider', [/pacing code \d+/i]),
    ).toBe(true);
    expect(isRateLimitErrorText('PACING CODE 1302', [/pacing code \d+/i])).toBe(true);
  });

  it('resolveRateLimitBackoff is enabled by default, off when disabled or the budget is zero', () => {
    expect(resolveRateLimitBackoff(DEFAULT_PACING_CONFIG)).toMatchObject({ maxRetries: 5 });
    expect(resolveRateLimitBackoff(pacingConfig({ enabled: false }))).toBeNull();
    expect(resolveRateLimitBackoff(pacingConfig({ maxAutoRetries: 0 }))).toBeNull();
    expect(resolveRateLimitBackoff(pacingConfig({ maxAutoRetries: -1 }))).toBeNull();
  });

  it('resolveRateLimitBackoff compiles configured signatures and carries the bounds', () => {
    const policy = resolveRateLimitBackoff(
      pacingConfig({
        backoffBaseMs: 250,
        backoffMaxMs: 5_000,
        maxAutoRetries: 4,
        providers: { 'provider-x': { rateLimitPatterns: ['pacing code \\d+'] } },
      }),
    );
    expect(policy).toEqual({
      baseMs: 250,
      maxMs: 5_000,
      maxRetries: 4,
      patterns: [/pacing code \d+/i],
    });
    expect(policy?.patterns[0]?.test('PACING CODE 42')).toBe(true);
  });

  it('compileRateLimitPatterns rejects an invalid hand-built pattern with a named error', () => {
    expect(() =>
      compileRateLimitPatterns(
        pacingConfig({ providers: { 'provider-x': { rateLimitPatterns: ['(unclosed'] } } }),
      ),
    ).toThrow(ConfigError);
    try {
      compileRateLimitPatterns(
        pacingConfig({ providers: { 'provider-x': { rateLimitPatterns: ['(unclosed'] } } }),
      );
    } catch (error) {
      expect(String((error as Error).message)).toContain('provider-x');
    }
  });
});

describe('bounded exponential backoff + jitter', () => {
  it('doubles from the base and clamps at the max', () => {
    expect(backoffDelayMs(1, 1_000, 60_000)).toBe(1_000);
    expect(backoffDelayMs(2, 1_000, 60_000)).toBe(2_000);
    expect(backoffDelayMs(3, 1_000, 60_000)).toBe(4_000);
    expect(backoffDelayMs(6, 1_000, 60_000)).toBe(32_000);
    expect(backoffDelayMs(7, 1_000, 60_000)).toBe(60_000); // 64s -> capped
    expect(backoffDelayMs(20, 1_000, 60_000)).toBe(60_000);
    // A base above the cap cannot invert the ladder either.
    expect(backoffDelayMs(1, 5_000, 2_000)).toBe(2_000);
  });

  it('adds jitter above the pure exponential and never exceeds the max', () => {
    // Maximal jitter (its cap): delay = min(1.5 * exponential, max).
    const maximal = (capMs: number): number => capMs;
    expect(backoffDelayMs(1, 100, 1_000, maximal)).toBe(150);
    expect(backoffDelayMs(2, 100, 1_000, maximal)).toBe(300);
    expect(backoffDelayMs(3, 100, 1_000, maximal)).toBe(600);
    // 800 + 400 = 1200 -> clamped to the configured bound.
    expect(backoffDelayMs(4, 100, 1_000, maximal)).toBe(1_000);
    // The jitter seam receives half the pre-jitter exponential, so a real
    // random in [0, cap) can never push a delay past 1.5x the exponential.
    const caps: number[] = [];
    backoffDelayMs(3, 100, 1_000, (capMs) => {
      caps.push(capMs);
      return capMs / 2;
    });
    expect(caps).toEqual([200]);
    for (let retry = 1; retry <= 30; retry += 1) {
      const delay = backoffDelayMs(retry, 100, 1_000, maximal);
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(1_000);
    }
  });
});

describe('FIFO admission gate (minion turns + Perkins review turns)', () => {
  it('a disabled or unlimited gate admits immediately and records nothing', async () => {
    for (const gate of [
      new PacingGate({
        enabled: false,
        maxConcurrentMinions: 1,
        maxConcurrentReviewTurns: 1,
        record: () => {
          throw new Error('a disabled gate must never record queue events');
        },
      }),
      new PacingGate({ enabled: true, maxConcurrentMinions: 0, maxConcurrentReviewTurns: 0 }),
    ]) {
      const lease = await gate.acquireWorkerTurn({ id: 'job-a', label: 'Job A' });
      expect(lease.waitedMs).toBe(0);
      expect(gate.view().worker.running).toBe(1);
      lease.release();
      expect(gate.view().worker.running).toBe(0);
    }
  });

  it('queues FIFO at the limit and releases hand the slot to the head waiter', async () => {
    const events: Array<{ kind: string; payload?: unknown }> = [];
    const gate = new PacingGate({
      enabled: true,
      maxConcurrentMinions: 1,
      maxConcurrentReviewTurns: 0,
      record: (event) => events.push({ kind: event.kind, payload: event.payload }),
      now: () => 1_000,
    });
    const first = await gate.acquireWorkerTurn({ id: 'job-a', label: 'Job A' });
    const bQueued: string[] = [];
    const cQueued: string[] = [];
    const b = gate.acquireWorkerTurn({
      id: 'job-b',
      label: 'Job B',
      queued: (info) => bQueued.push(`${info.position}@${info.limit}:${info.reason}`),
    });
    const c = gate.acquireWorkerTurn({
      id: 'job-c',
      label: 'Job C',
      queued: (info) => cQueued.push(`${info.position}@${info.limit}`),
    });
    const view = gate.view();
    expect(view.worker.running).toBe(1);
    expect(view.worker.queued.map((entry) => entry.id)).toEqual(['job-b', 'job-c']);
    expect(view.worker.queued[0]?.reason).toContain('max_concurrent_minions');
    expect(bQueued).toEqual(['1@1:queued: 1/1 minion turns running (pacing.max_concurrent_minions)']);
    expect(cQueued).toEqual(['2@1']);
    // Releasing the holder admits B first (FIFO), never C, and the queued
    // promise resolves only then.
    let bAdmitted = false;
    void b.then(() => {
      bAdmitted = true;
    });
    await Promise.resolve();
    expect(bAdmitted).toBe(false);
    first.release();
    const bLease = await b;
    expect(bAdmitted).toBe(true);
    expect(gate.view().worker.running).toBe(1);
    expect(gate.view().worker.queued.map((entry) => entry.id)).toEqual(['job-c']);
    bLease.release();
    const cLease = await c;
    expect(gate.view().worker.queued).toHaveLength(0);
    expect(cLease.waitedMs).toBe(0);
    cLease.release();
    expect(events.map((event) => event.kind)).toEqual([
      'pacing.queued',
      'pacing.queued',
      'pacing.admitted',
      'pacing.admitted',
    ]);
    expect(events[2]?.payload).toMatchObject({ id: 'job-b', pool: 'worker' });
  });

  it('never starves: a fresh arrival cannot jump an existing queue', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const holder = await gate.acquireWorkerTurn({ id: 'job-a', label: 'A' });
    const order: string[] = [];
    const b = gate.acquireWorkerTurn({ id: 'job-b', label: 'B' }).then((lease) => {
      order.push('b');
      return lease;
    });
    const c = gate.acquireWorkerTurn({ id: 'job-c', label: 'C' }).then((lease) => {
      order.push('c');
      return lease;
    });
    holder.release();
    const bLease = await b;
    expect(order).toEqual(['b']);
    bLease.release();
    const cLease = await c;
    expect(order).toEqual(['b', 'c']);
    cLease.release();
  });

  it('keeps worker and review pools independent', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 1 });
    const worker = await gate.acquireWorkerTurn({ id: 'job-a', label: 'A' });
    const review = await gate.acquireReviewTurn({ id: 'round-1', label: 'lead' });
    expect(gate.view().worker.running).toBe(1);
    expect(gate.view().review.running).toBe(1);
    const queuedReview = gate.acquireReviewTurn({ id: 'round-2', label: 'lead' });
    expect(gate.view().review.queued.map((entry) => entry.id)).toEqual(['round-2']);
    review.release();
    const second = await queuedReview;
    expect(gate.view().review.running).toBe(1);
    worker.release();
    second.release();
  });

  it('releasing a lease twice throws (caller bookkeeping bug)', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const lease = await gate.acquireWorkerTurn({ id: 'job-a', label: 'A' });
    lease.release();
    expect(() => lease.release()).toThrow(/released twice/);
  });

  it('cancels a QUEUED wait on abort without touching the live holder', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const holder = await gate.acquireWorkerTurn({ id: 'job-a', label: 'A' });
    const controller = new AbortController();
    const queued = gate.acquireWorkerTurn({ id: 'job-b', label: 'B', signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toThrow(/aborted/);
    expect(gate.view().worker.queued).toHaveLength(0);
    expect(gate.view().worker.running).toBe(1);
    holder.release();
    expect(gate.view().worker.running).toBe(0);
  });

  it('an abort AFTER admission leaves the lease held (release is the caller’s)', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const controller = new AbortController();
    const lease = await gate.acquireWorkerTurn({ id: 'job-a', label: 'A', signal: controller.signal });
    controller.abort();
    expect(gate.view().worker.running).toBe(1);
    lease.release();
    expect(gate.view().worker.running).toBe(0);
  });

  it('resolvePacingPolicy wires the backoff policy and the gate from one config', async () => {
    const resolved = resolvePacingPolicy(
      pacingConfig({ maxConcurrentMinions: 2, maxConcurrentReviewTurns: 3, maxAutoRetries: 2 }),
    );
    expect(resolved.backoff).toMatchObject({ baseMs: 1_000, maxMs: 60_000, maxRetries: 2 });
    const a = await resolved.gate.acquireWorkerTurn({ id: 'a', label: 'A' });
    const b = await resolved.gate.acquireWorkerTurn({ id: 'b', label: 'B' });
    expect(resolved.gate.view().worker.running).toBe(2);
    const queued = resolved.gate.acquireWorkerTurn({ id: 'c', label: 'C' });
    expect(resolved.gate.view().worker.queued).toHaveLength(1);
    a.release();
    b.release();
    (await queued).release();
  });
});


describe('pacing callback failures never strand admission', () => {
  it('rejects a throwing queue callback and removes its ghost waiter', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const holder = await gate.acquireWorkerTurn({ id: 'a', label: 'a' });
    await expect(gate.acquireWorkerTurn({ id: 'bad', label: 'bad', queued: () => { throw new Error('note failed'); } })).rejects.toThrow('note failed');
    expect(gate.view().worker.queued).toEqual([]);
    holder.release();
    const next = await gate.acquireWorkerTurn({ id: 'next', label: 'next' });
    next.release();
    expect(gate.view().worker.running).toBe(0);
  });

  it('a throwing queue recorder rejects loudly without leaking a waiter', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0,
      record: () => { throw new Error('ledger unavailable'); } });
    const holder = await gate.acquireWorkerTurn({ id: 'a', label: 'a' });
    await expect(gate.acquireWorkerTurn({ id: 'bad', label: 'bad' })).rejects.toThrow('ledger unavailable');
    holder.release();
    expect(gate.view().worker).toMatchObject({ running: 0, queued: [] });
  });

  it('admission recorder failure rejects only its waiter and drains the next FIFO entry', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0,
      record: (event) => { if (event.kind === 'pacing.admitted' && (event.payload as { id: string }).id === 'bad') throw new Error('admit failed'); } });
    const holder = await gate.acquireWorkerTurn({ id: 'a', label: 'a' });
    const bad = gate.acquireWorkerTurn({ id: 'bad', label: 'bad' });
    const failed = expect(bad).rejects.toThrow('admit failed');
    const next = gate.acquireWorkerTurn({ id: 'next', label: 'next' });
    holder.release();
    await failed;
    (await next).release();
    expect(gate.view().worker).toMatchObject({ running: 0, queued: [] });
  });
});
