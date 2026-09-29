import { ConfigError, type ConcurrencyConfig } from '../config.js';

/**
 * Provider pacing (owner heist 2026-09-29, scope-trimmed 2026-09-29):
 * bounded automatic retry for the provider rate-limit error class only —
 * replacing per-429 owner ACKs. Admission/concurrency gating is deliberately
 * NOT here (PR #131's territory under the same [concurrency] namespace).
 *
 * Provider-agnostic by ruling: no provider name, model, or limit is
 * hardcoded. The generic signatures below are the HTTP 429 family and its
 * plain-language equivalents; anything provider-specific is owner
 * configuration under [concurrency.providers."<id>"] and matches ERROR TEXT
 * only — a CLI or adapter brand is never provider identity.
 */

/** Generic, provider-agnostic rate-limit signatures: the 429 family plus
 * plain-language rate-limit phrasing any provider may emit. Deliberately
 * narrower than the supervisor's quota-wall class: subscription/billing
 * exhaustion ("quota exceeded", "insufficient balance") must never be
 * retried into a silent loop. */
const GENERIC_RATE_LIMIT_PATTERN =
  /\b429\b|too many requests|\bthrottl(?:e|ed|ing)\b|\brate[- ]?limit(?:ed|ing)?\b/i;

/** True when the error text matches the generic 429 family or one of the
 * configured per-provider signatures. Never matches on provider identity. */
export function isRateLimitErrorText(
  errorText: string,
  extraPatterns: readonly RegExp[] = [],
): boolean {
  if (GENERIC_RATE_LIMIT_PATTERN.test(errorText)) return true;
  return extraPatterns.some((pattern) => pattern.test(errorText));
}

/** Compile the configured per-provider signatures. Pattern validity is
 * already enforced at config load; this re-check fails loud rather than
 * trusting a hand-built config object. */
export function compileRateLimitPatterns(config: ConcurrencyConfig): readonly RegExp[] {
  const compiled: RegExp[] = [];
  for (const [providerId, override] of Object.entries(config.providers)) {
    for (const pattern of override.rateLimitPatterns) {
      try {
        compiled.push(new RegExp(pattern, 'i'));
      } catch (error) {
        throw new ConfigError(
          `concurrency.providers."${providerId}".rate_limit_patterns contains an invalid regex: ${(error as Error).message}`,
          '<concurrency>',
          `concurrency.providers."${providerId}"`,
        );
      }
    }
  }
  return compiled;
}

/** Fully-resolved rate-limit retry policy for one service process (config +
 * compiled signatures). `null` means the feature is off — pure pre-pacing
 * behavior is the exact contract the supervisor falls back to. */
export interface RateLimitBackoffPolicy {
  /** Backoff base; doubles per retry. */
  readonly baseMs: number;
  /** Hard bound on any single retry delay (jitter included). */
  readonly maxMs: number;
  /** Automatic retries per rate-limit incident. */
  readonly maxRetries: number;
  /** Compiled extra signatures beyond the generic 429 family. */
  readonly patterns: readonly RegExp[];
}

/** Resolve the runtime policy from config. The section being absent (or an
 * explicit zero retry budget) is the off switch: no retry machinery runs. */
export function resolveRateLimitBackoff(
  config: ConcurrencyConfig,
): RateLimitBackoffPolicy | null {
  if (!config.enabled || config.maxAutoRetries <= 0) return null;
  return {
    baseMs: config.backoffBaseMs,
    maxMs: config.backoffMaxMs,
    maxRetries: config.maxAutoRetries,
    patterns: compileRateLimitPatterns(config),
  };
}

/**
 * Delay for retry n (1-based): base * 2^(n-1), capped at maxMs, plus
 * additive jitter up to half the (pre-jitter) exponential — and the sum is
 * clamped to maxMs so no single delay can ever exceed the configured bound.
 * The pure exponential is therefore the floor of every delay. Exported for
 * deterministic tests of the ladder shape; production callers use the
 * service's jitter seam.
 */
export function backoffDelayMs(
  retry: number,
  baseMs: number,
  maxMs: number,
  jitter: (capMs: number) => number = () => 0,
): number {
  const exponential = Math.min(baseMs * 2 ** Math.max(0, retry - 1), maxMs);
  const jittered = exponential + jitter(exponential / 2);
  return Math.min(jittered, maxMs);
}
