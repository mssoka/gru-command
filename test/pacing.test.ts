import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONCURRENCY_CONFIG, type ConcurrencyConfig } from '../src/config.js';
import {
  backoffDelayMs,
  compileRateLimitPatterns,
  isRateLimitErrorText,
  resolveRateLimitBackoff,
} from '../src/runtime/pacing.js';

/**
 * Provider pacing unit tests (owner heist 2026-09-29, scope-trimmed): the
 * rate-limit class is provider-agnostic and the backoff ladder is bounded by
 * [concurrency] backoff_base_ms / backoff_max_ms / max_auto_retries. The
 * supervisor's wiring (retries, events, ladder fallback, off-by-default) is
 * pinned in supervisor.test.ts.
 */

function concurrencyConfig(overrides: Partial<ConcurrencyConfig> = {}): ConcurrencyConfig {
  return { ...DEFAULT_CONCURRENCY_CONFIG, enabled: true, ...overrides };
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

  it('resolveRateLimitBackoff is off when the section is absent or the budget is zero', () => {
    expect(resolveRateLimitBackoff(DEFAULT_CONCURRENCY_CONFIG)).toBeNull();
    expect(resolveRateLimitBackoff(concurrencyConfig({ maxAutoRetries: 0 }))).toBeNull();
    expect(resolveRateLimitBackoff(concurrencyConfig({ maxAutoRetries: -1 }))).toBeNull();
  });

  it('resolveRateLimitBackoff compiles configured signatures and carries the bounds', () => {
    const policy = resolveRateLimitBackoff(
      concurrencyConfig({
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
        concurrencyConfig({ providers: { 'provider-x': { rateLimitPatterns: ['(unclosed'] } } }),
      ),
    ).toThrow(ConfigError);
    try {
      compileRateLimitPatterns(
        concurrencyConfig({ providers: { 'provider-x': { rateLimitPatterns: ['(unclosed'] } } }),
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
