import { describe, expect, it } from 'vitest';
import {
  WakePolicy,
  localMinuteOfDay,
  parseQuietHours,
  quietHoursActive,
  quietHoursEnd,
  type WakeCandidate,
  type WakePolicyConfig,
} from '../src/chat/wake-policy.js';

/**
 * Wake-policy unit contract (owner ruling 2026-09-23): the severity gate,
 * rate limit, dedupe, and quiet hours that decide whether a notification
 * may OPEN a Gru turn. Pure decisions — no sockets, no timers.
 */

const BASE: WakePolicyConfig = {
  mode: 'action-required',
  minSeverity: 'info',
  minIntervalMs: 300_000,
  quietHours: null,
};

const candidate = (overrides: Partial<WakeCandidate> = {}): WakeCandidate => ({
  id: 'n1',
  routing: 'action-required',
  severity: 'error',
  ...overrides,
});

describe('wake policy — routing gate', () => {
  it("'never' never wakes, whatever the routing", () => {
    const policy = new WakePolicy({ ...BASE, mode: 'never' });
    expect(policy.decide(candidate(), 0)).toEqual({ action: 'skip', reason: 'mode' });
    expect(policy.decide(candidate({ routing: 'fyi' }), 0)).toEqual({ action: 'skip', reason: 'mode' });
  });

  it("'action-required' wakes machine attention and leaves FYI / needs-owner passive", () => {
    const policy = new WakePolicy(BASE);
    expect(policy.decide(candidate(), 0)).toEqual({ action: 'wake' });
    expect(policy.decide(candidate({ id: 'f1', routing: 'fyi' }), 0)).toEqual({
      action: 'skip',
      reason: 'routing',
    });
    expect(policy.decide(candidate({ id: 'o1', routing: 'needs-owner' }), 0)).toEqual({
      action: 'skip',
      reason: 'routing',
    });
  });

  it("'all' wakes every notification class", () => {
    const policy = new WakePolicy({ ...BASE, mode: 'all' });
    for (const [index, routing] of (['fyi', 'action-required', 'needs-owner'] as const).entries()) {
      expect(policy.decide(candidate({ id: `n${index}`, routing }), 0)).toEqual({ action: 'wake' });
    }
  });
});

describe('wake policy — severity gate', () => {
  it("'error' floor suppresses info-severity rows and keeps error rows waking", () => {
    const policy = new WakePolicy({ ...BASE, minSeverity: 'error' });
    expect(policy.decide(candidate({ severity: 'info' }), 0)).toEqual({
      action: 'skip',
      reason: 'severity',
    });
    expect(policy.decide(candidate({ id: 'n2', severity: 'error' }), 0)).toEqual({ action: 'wake' });
  });

  it("'info' floor wakes both severities", () => {
    const policy = new WakePolicy({ ...BASE, minSeverity: 'info' });
    expect(policy.decide(candidate({ severity: 'info' }), 0)).toEqual({ action: 'wake' });
  });
});

describe('wake policy — dedupe', () => {
  it('claims an id on fire; the same id never wakes again', () => {
    const policy = new WakePolicy(BASE);
    expect(policy.decide(candidate(), 1_000)).toEqual({ action: 'wake' });
    policy.fired(['n1'], 1_000);
    expect(policy.decide(candidate(), 1_000)).toEqual({ action: 'skip', reason: 'dedupe' });
    // A different row still wakes (after the rate window).
    expect(policy.decide(candidate({ id: 'n2' }), 1_000 + 300_000)).toEqual({ action: 'wake' });
  });

  it('keeps all 257 open IDs until explicitly closed, across restart', () => {
    const policy = new WakePolicy(BASE);
    const ids = Array.from({ length: 257 }, (_, index) => `n${index}`);
    policy.fired(ids, 0);
    const restarted = new WakePolicy(BASE, policy.snapshot());
    expect(restarted.snapshot().woken).toHaveLength(257);
    expect(restarted.decide(candidate({ id: 'n0' }), 300_000)).toEqual({ action: 'skip', reason: 'dedupe' });
    expect(restarted.forget('n0')).toBe(true);
    expect(restarted.decide(candidate({ id: 'n0' }), 300_000)).toEqual({ action: 'wake' });
  });

  it('round-trips its durable state', () => {
    const first = new WakePolicy(BASE);
    first.fired(['n1'], 5_000);
    const restarted = new WakePolicy(BASE, first.snapshot());
    expect(restarted.decide(candidate(), 5_000)).toEqual({ action: 'skip', reason: 'dedupe' });
  });
});

describe('wake policy — rate limit', () => {
  it('defers inside the interval and names the earliest retry instant', () => {
    const policy = new WakePolicy(BASE);
    policy.fired(['old'], 10_000);
    expect(policy.scheduleDecision(10_000 + 60_000)).toEqual({
      action: 'defer',
      reason: 'rate',
      retryAtMs: 10_000 + 300_000,
    });
    expect(policy.scheduleDecision(10_000 + 300_000)).toEqual({ action: 'wake' });
  });

  it('counts a failed attempt against the interval, durably, without claiming its id', () => {
    const policy = new WakePolicy(BASE);
    policy.attempted(10_000);
    const restarted = new WakePolicy(BASE, policy.snapshot());
    expect(restarted.decide(candidate(), 15_000)).toEqual({ action: 'defer', reason: 'rate', retryAtMs: 310_000 });
    expect(restarted.decide(candidate(), 310_000)).toEqual({ action: 'wake' });
    expect(restarted.snapshot().woken).toEqual([]);
  });

  it('0 disables the cap', () => {
    const policy = new WakePolicy({ ...BASE, minIntervalMs: 0 });
    policy.fired(['old'], 10_000);
    expect(policy.decide(candidate(), 10_000)).toEqual({ action: 'wake' });
  });
});

describe('wake policy — quiet hours', () => {
  it('parses HH:MM-HH:MM, rejects malformed/empty windows, and accepts empty as off', () => {
    expect(parseQuietHours('')).toBeNull();
    expect(parseQuietHours('22:00-07:00')).toEqual({ startMinute: 22 * 60, endMinute: 7 * 60 });
    expect(parseQuietHours('00:30-23:59')).toEqual({ startMinute: 30, endMinute: 23 * 60 + 59 });
    for (const bad of ['22:00', '22:00-25:00', '9:00-17:00', '22:60-23:00', '22:00-22:00', 'evening']) {
      expect(() => parseQuietHours(bad)).toThrowError(/quiet hours/);
    }
  });

  it('detects an in-window instant for same-day and wrapping windows', () => {
    const night = { startMinute: 22 * 60, endMinute: 7 * 60 };
    const at = (iso: string): number => new Date(iso).getTime();
    expect(quietHoursActive(night, at('2026-09-23T23:30:00'))).toBe(true);
    expect(quietHoursActive(night, at('2026-09-23T06:30:00'))).toBe(true);
    expect(quietHoursActive(night, at('2026-09-23T07:00:00'))).toBe(false);
    expect(quietHoursActive(night, at('2026-09-23T12:00:00'))).toBe(false);
    expect(quietHoursActive(null, at('2026-09-23T23:30:00'))).toBe(false);
    const day = { startMinute: 9 * 60, endMinute: 17 * 60 };
    expect(quietHoursActive(day, at('2026-09-23T10:00:00'))).toBe(true);
    expect(quietHoursActive(day, at('2026-09-23T18:00:00'))).toBe(false);
  });

  it('resolves the window end (wrapping windows end next morning)', () => {
    const night = { startMinute: 22 * 60, endMinute: 7 * 60 };
    const late = new Date('2026-09-23T23:30:00').getTime();
    expect(new Date(quietHoursEnd(night, late) ?? 0).getHours()).toBe(7);
    expect(new Date(quietHoursEnd(night, late) ?? 0).getDate()).toBe(24);
    const early = new Date('2026-09-23T06:30:00').getTime();
    expect(new Date(quietHoursEnd(night, early) ?? 0).getDate()).toBe(23);
    expect(quietHoursEnd(night, new Date('2026-09-23T12:00:00').getTime())).toBeNull();
  });

  it('finds a future quiet-hours endpoint across both DST transitions', () => {
    const prior = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const spring = quietHoursEnd({ startMinute: 30, endMinute: 2 * 60 + 30 },
        new Date('2026-03-08T01:45:00-05:00').getTime());
      expect(new Date(spring!).toISOString()).toBe('2026-03-08T07:00:00.000Z'); // 03:00 EDT
      const fallWindow = { startMinute: 30, endMinute: 90 };
      const secondOneAm = new Date('2026-11-01T01:10:00-05:00').getTime();
      expect(quietHoursActive(fallWindow, secondOneAm)).toBe(true);
      expect(new Date(quietHoursEnd(fallWindow, secondOneAm)!).toISOString())
        .toBe('2026-11-01T06:30:00.000Z'); // second 01:30 EST, not first 01:30 EDT
    } finally {
      if (prior === undefined) delete process.env.TZ;
      else process.env.TZ = prior;
    }
  });

  it('defers a wake inside the window to the window end', () => {
    const policy = new WakePolicy({
      ...BASE,
      quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 },
    });
    const at = new Date('2026-09-23T23:00:00').getTime();
    const decision = policy.scheduleDecision(at);
    expect(decision).toMatchObject({ action: 'defer', reason: 'quiet' });
    if (decision.action === 'defer') {
      expect(new Date(decision.retryAtMs).getHours()).toBe(7);
      expect(decision.retryAtMs).toBeGreaterThan(at);
    }
  });

  it('localMinuteOfDay reads the local clock', () => {
    const at = new Date('2026-09-23T14:05:00').getTime();
    expect(localMinuteOfDay(at)).toBe(14 * 60 + 5);
  });
});
