import { ConfigError, type PacingConfig } from '../config.js';

/**
 * Provider pacing (owner heist 2026-09-29): automatic admission control for
 * minion and Perkins review turns, plus bounded rate-limit auto-backoff —
 * replacing per-429 owner ACKs.
 *
 * Provider-agnostic by ruling: no provider name, model, or limit is
 * hardcoded here. Limits and the master switch come from the `[pacing]`
 * config section; per-provider error signatures come from
 * `[pacing.providers."<id>"]` and match ERROR TEXT only — a CLI or adapter
 * brand is never provider identity (bible: align-preflight-with-runtime-
 * resolution). The generic signatures below are the HTTP 429 family and
 * its plain-language equivalents; anything provider-specific is owner
 * configuration, never code.
 */

/** Generic, provider-agnostic rate-limit signatures: the 429 family plus
 * plain-language rate-limit phrasing any provider may emit. */
const GENERIC_RATE_LIMIT_PATTERN =
  /\b429(?:[\s:-]*(?:too many requests)?(?:\b|$))|\brate[- ]?limit(?:ed|ing)?\b(?:[- ](?:limit|error|exceeded))?|too many requests|requests? throttled|throttling?\b/i;

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
export function compileRateLimitPatterns(config: PacingConfig): readonly RegExp[] {
  const compiled: RegExp[] = [];
  for (const [providerId, override] of Object.entries(config.providers)) {
    for (const pattern of override.rateLimitPatterns) {
      try {
        compiled.push(new RegExp(pattern, 'i'));
      } catch (error) {
        throw new ConfigError(
          `pacing.providers."${providerId}".rate_limit_patterns contains an invalid regex: ${(error as Error).message}`,
          '<pacing>',
          `pacing.providers."${providerId}"`,
        );
      }
    }
  }
  return compiled;
}

/** Fully-resolved pacing policy for one service process (config + compiled
 * signatures). Constructed once in main; consumers receive narrow views. */
export interface ResolvedPacingPolicy {
  readonly enabled: boolean;
  readonly maxConcurrentMinions: number;
  readonly maxConcurrentReviewTurns: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly maxAutoRetries: number;
  readonly rateLimitPatterns: readonly RegExp[];
}

export function resolvePacingPolicy(config: PacingConfig): ResolvedPacingPolicy {
  return {
    enabled: config.enabled,
    maxConcurrentMinions: config.maxConcurrentMinions,
    maxConcurrentReviewTurns: config.maxConcurrentReviewTurns,
    backoffBaseMs: config.backoffBaseMs,
    backoffMaxMs: config.backoffMaxMs,
    maxAutoRetries: config.maxAutoRetries,
    rateLimitPatterns: compileRateLimitPatterns(config),
  };
}

/** Delay for retry n (1-based): base * 2^(n-1), capped at max, plus jitter
 * drawn from [0, cap). Exported for deterministic tests of the ladder shape. */
export function backoffDelayMs(
  retry: number,
  baseMs: number,
  maxMs: number,
  jitter: (cap: number) => number = () => 0,
): number {
  const uncapped = baseMs * 2 ** Math.max(0, retry - 1);
  const capped = Math.min(uncapped, maxMs);
  return capped + jitter(Math.min(uncapped, maxMs) / 2);
}

// ---------------------------------------------------------------------------
// Admission gate
// ---------------------------------------------------------------------------

/** What pool a lease belongs to (worker = minion turns; review = Perkins
 * lead + lens turns). */
export type PacingPool = 'worker' | 'review';

export interface PacingQueueEntryView {
  /** Caller-chosen identity (job id, round id, lens label…). */
  readonly id: string;
  readonly kind: PacingPool;
  /** Human-readable label rendered with the queue (board snapshot data). */
  readonly label: string;
  readonly queuedAt: string;
  /** Why this entry is waiting — always the honest limit, never a guess. */
  readonly reason: string;
}

export interface PacingPoolView {
  /** Configured limit; 0 = unlimited. */
  readonly limit: number;
  readonly running: number;
  readonly queued: readonly PacingQueueEntryView[];
}

export interface PacingGateView {
  readonly enabled: boolean;
  readonly worker: PacingPoolView;
  readonly review: PacingPoolView;
}

/** Durable-record hook (the ledger in production) so queuing and admission
 * land on the record for observability. Must never throw into the gate. */
export type PacingEventRecorder = (event: {
  readonly kind: string;
  readonly agentId?: string | null;
  readonly jobId?: string | null;
  readonly payload?: unknown;
}) => void;

interface PacingWaiter {
  readonly id: string;
  readonly kind: PacingPool;
  readonly label: string;
  readonly queuedAt: string;
  readonly enqueueMs: number;
  readonly resolve: (lease: PacingLease) => void;
}

export interface PacingLease {
  /** Hand the slot back and admit the next queued waiter (FIFO). */
  release(): void;
}

export interface PacingGateOptions {
  readonly enabled: boolean;
  readonly maxConcurrentMinions: number;
  readonly maxConcurrentReviewTurns: number;
  readonly record?: PacingEventRecorder;
  /** Clock seam (default Date.now). */
  readonly now?: () => number;
}

/**
 * FIFO admission gate for model turns (owner ruling: queue, never reject,
 * never starve, never preempt). Two independent pools — worker minion turns
 * and Perkins review turns — each bounded by its configured limit; a limit
 * of 0 (or a disabled feature) admits everyone immediately, which is the
 * shipped default and preserves pre-pacing behavior exactly.
 *
 * Releases hand the slot straight to the head waiter, so a new arrival can
 * never jump an existing queue (no starvation). Every wait is visible via
 * {@link view} — the board renders queued lanes honestly.
 */
export class PacingGate {
  private readonly enabled: boolean;
  private readonly limits: Readonly<Record<PacingPool, number>>;
  private readonly record: PacingEventRecorder | null;
  private readonly now: () => number;
  private readonly running: Record<PacingPool, number> = { worker: 0, review: 0 };
  private readonly queues: Record<PacingPool, PacingWaiter[]> = { worker: [], review: [] };
  private readonly released = new WeakSet<PacingLease>();

  constructor(opts: PacingGateOptions) {
    this.enabled = opts.enabled;
    this.limits = {
      worker: Math.max(0, Math.floor(opts.maxConcurrentMinions)),
      review: Math.max(0, Math.floor(opts.maxConcurrentReviewTurns)),
    };
    this.record = opts.record ?? null;
    this.now = opts.now ?? Date.now;
  }

  /** Acquire a worker (minion) turn slot; queues FIFO while at the limit. */
  acquireWorkerTurn(id: string, label: string): Promise<PacingLease> {
    return this.acquire('worker', id, label);
  }

  /** Acquire a review turn slot (Perkins lead or lens); queues FIFO. */
  acquireReviewTurn(id: string, label: string): Promise<PacingLease> {
    return this.acquire('review', id, label);
  }

  /** Honest snapshot for the board: limits, running counts, and every
   * queued entry with its queue time and reason. */
  view(): PacingGateView {
    return {
      enabled: this.enabled,
      worker: this.poolView('worker'),
      review: this.poolView('review'),
    };
  }

  private poolView(kind: PacingPool): PacingPoolView {
    return {
      limit: this.limits[kind],
      running: this.running[kind],
      queued: this.queues[kind].map((waiter) => ({
        id: waiter.id,
        kind: waiter.kind,
        label: waiter.label,
        queuedAt: waiter.queuedAt,
        reason: this.queueReason(kind),
      })),
    };
  }

  private queueReason(kind: PacingPool): string {
    return kind === 'worker'
      ? `queued: ${this.running.worker}/${this.limits.worker} minion turns running (pacing.max_concurrent_minions)`
      : `queued: ${this.running.review}/${this.limits.review} review turns running (pacing.max_concurrent_review_turns)`;
  }

  private limitFor(kind: PacingPool): number {
    return this.enabled ? this.limits[kind] : 0;
  }

  private acquire(kind: PacingPool, id: string, label: string): Promise<PacingLease> {
    const limit = this.limitFor(kind);
    if (limit === 0 || this.running[kind] < limit) {
      this.running[kind] += 1;
      return Promise.resolve(this.mintLease(kind));
    }
    return new Promise<PacingLease>((resolve) => {
      const waiter: PacingWaiter = {
        id,
        kind,
        label,
        queuedAt: new Date(this.now()).toISOString(),
        enqueueMs: this.now(),
        resolve: (lease) => resolve(lease),
      };
      this.queues[kind].push(waiter);
      this.record?.({
        kind: 'pacing.queued',
        payload: { pool: kind, id, label, position: this.queues[kind].length, limit },
      });
    });
  }

  private mintLease(kind: PacingPool): PacingLease {
    const lease: PacingLease = {
      release: () => {
        if (this.released.has(lease)) {
          throw new Error(`pacing ${kind} lease released twice — caller bookkeeping bug`);
        }
        this.released.add(lease);
        this.running[kind] = Math.max(0, this.running[kind] - 1);
        const next = this.queues[kind].shift();
        if (next === undefined) return;
        this.running[kind] += 1;
        this.record?.({
          kind: 'pacing.admitted',
          payload: {
            pool: kind,
            id: next.id,
            label: next.label,
            waited_ms: Math.max(0, this.now() - next.enqueueMs),
          },
        });
        next.resolve(this.mintLease(kind));
      },
    };
    return lease;
  }
}

// ---------------------------------------------------------------------------
// Rate-limit auto-backoff
// ---------------------------------------------------------------------------

export interface RateLimitBackoffOptions {
  /** When false, run() never retries — the first failure throws (pure
   * pre-pacing behavior). */
  readonly enabled: boolean;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  /** Max automatic retries per incident; 0 = no retry (throw immediately). */
  readonly maxAutoRetries: number;
  /** Error signatures beyond the generic 429 family (from config). */
  readonly rateLimitPatterns?: readonly RegExp[];
  /** Observability hook — production records a ledger event per retry. */
  readonly onRetry?: (info: RateLimitRetryInfo) => void;
  /** Sleep seam (tests use fake clocks; default a real timer). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Jitter seam (tests pin it; default uniform in [0, cap)). */
  readonly jitter?: (capMs: number) => number;
  /** Classification seam (default isRateLimitErrorText with the patterns). */
  readonly classify?: (errorText: string) => boolean;
}

export interface RateLimitRetryInfo {
  /** 1-based retry number about to run. */
  readonly retry: number;
  readonly delayMs: number;
  readonly error: string;
}

export class RateLimitExhaustedError extends Error {
  constructor(
    readonly retries: number,
    readonly lastError: string,
  ) {
    super(
      `rate limit persisted after ${retries} automatic ${retries === 1 ? 'retry' : 'retries'} (last error: ${lastError})`,
    );
    this.name = 'RateLimitExhaustedError';
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function defaultJitter(capMs: number): number {
  return Math.random() * capMs;
}

/**
 * Bounded exponential backoff + jitter for the rate-limit error class ONLY.
 * A non-rate-limit failure (or an exhausted budget) throws immediately —
 * this helper must never turn other failures into silent loops.
 */
export class RateLimitBackoff {
  private readonly opts: RateLimitBackoffOptions;

  constructor(opts: RateLimitBackoffOptions) {
    this.opts = opts;
  }

  /** Run the operation; on a rate-limit-class failure retry with backoff
   * until maxAutoRetries is spent. The last error (wrapped when retries
   * were exhausted) propagates otherwise. */
  async run<T>(operation: (attempt: number) => Promise<T>): Promise<T> {
    const sleep = this.opts.sleep ?? defaultSleep;
    const jitter = this.opts.jitter ?? defaultJitter;
    const classify =
      this.opts.classify ?? ((text: string) => isRateLimitErrorText(text, this.opts.rateLimitPatterns ?? []));
    let attempt = 0;
    for (;;) {
      attempt += 1;
      try {
        return await operation(attempt);
      } catch (error) {
        const text = String(error);
        if (!this.opts.enabled || !classify(text)) throw error;
        const retry = attempt; // the attempt we just spent
        if (retry > this.opts.maxAutoRetries) {
          throw new RateLimitExhaustedError(retry - 1, text.slice(0, 500));
        }
        const delayMs = backoffDelayMs(retry, this.opts.backoffBaseMs, this.opts.backoffMaxMs, jitter);
        this.opts.onRetry?.({ retry, delayMs, error: text.slice(0, 500) });
        await sleep(delayMs);
      }
    }
  }
}
