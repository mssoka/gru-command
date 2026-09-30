import { backoffDelayMs, isRateLimitErrorText, type RateLimitBackoffPolicy } from './pacing.js';

export interface RetryEvent {
  readonly kind: 'pacing.auto-retry' | 'pacing.auto-retry-exhausted' | 'pacing.auto-retry-recovered';
  readonly payload: { readonly retry: number; readonly delay_ms?: number; readonly error?: string };
}

export interface RateLimitRetryOptions {
  readonly policy: RateLimitBackoffPolicy | null;
  readonly record: (event: RetryEvent) => void;
  readonly signals?: readonly (AbortSignal | undefined)[];
  readonly sleep?: (ms: number, signals: readonly (AbortSignal | undefined)[]) => Promise<void>;
  readonly jitter?: (capMs: number) => number;
}

export function pacingSleep(ms: number, signals: readonly (AbortSignal | undefined)[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
    const cleanup = (): void => {
      clearTimeout(timer);
      for (const { signal, listener } of listeners) signal.removeEventListener('abort', listener);
    };
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    for (const signal of signals) {
      if (signal === undefined) continue;
      const listener = (): void => { cleanup(); reject(new Error('pacing backoff aborted')); };
      if (signal.aborted) { listener(); return; }
      listeners.push({ signal, listener });
      signal.addEventListener('abort', listener, { once: true });
    }
  });
}

/** Workflow-owned retries: the operation cleans up its failed transport and
 * releases admission before throwing. Only rate limits retry; cancellation,
 * recorder failures, and non-rate-limit errors fail loudly. */
export async function withRateLimitRetries<T>(
  operation: () => Promise<T>,
  options: RateLimitRetryOptions,
): Promise<T> {
  const signals = options.signals ?? [];
  let retry = 0;
  for (;;) {
    if (signals.some((signal) => signal?.aborted === true)) throw new Error('pacing backoff aborted');
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      const policy = options.policy;
      const text = String(error);
      if (signals.some((signal) => signal?.aborted === true) || policy === null || !isRateLimitErrorText(text, policy.patterns)) throw error;
      if (retry >= policy.maxRetries) {
        options.record({ kind: 'pacing.auto-retry-exhausted', payload: { retry, error: text } });
        throw error;
      }
      retry += 1;
      const delay = backoffDelayMs(retry, policy.baseMs, policy.maxMs, options.jitter ?? ((cap) => Math.random() * cap));
      options.record({ kind: 'pacing.auto-retry', payload: { retry, delay_ms: delay, error: text } });
      await (options.sleep ?? pacingSleep)(delay, signals);
      continue;
    }
    if (retry > 0) options.record({ kind: 'pacing.auto-retry-recovered', payload: { retry } });
    return result;
  }
}
