import { ConfigError, type PacingConfig } from '../config.js';

/**
 * Provider pacing (owner heist 2026-09-29): config-driven FIFO admission
 * caps for minion turns and Perkins review turns, plus bounded automatic
 * retry for the provider rate-limit error class — replacing per-429 owner
 * ACKs.
 *
 * Provider-agnostic by ruling: no provider name, model, or limit is
 * hardcoded. Limits and the master switch come from the [pacing] config
 * section; provider-keyed
 * error signatures match ERROR TEXT only — a CLI or adapter brand is never
 * provider identity (bible: align-preflight-with-runtime-resolution). The
 * signatures are global text signatures; the provider keys are
 * organizational labels, never a match scope.
 */

/** Generic, provider-agnostic rate-limit signatures: the 429 family plus
 * plain-language rate-limit phrasing any provider may emit. Deliberately
 * narrower than the supervisor's quota-wall class: subscription/billing
 * exhaustion ("quota exceeded", "insufficient balance") must never be
 * retried into a silent loop. */
const GENERIC_RATE_LIMIT_PATTERN =
  /\b429\b|too many requests|\bthrottl(?:e|ed|ing)\b|\brate[- ]?limit(?:ed|ing)?\b/i;

/** True when the error text matches the generic 429 family or one of the
 * configured signatures. Never matches on provider identity. */
export function isRateLimitErrorText(
  errorText: string,
  extraPatterns: readonly RegExp[] = [],
): boolean {
  if (GENERIC_RATE_LIMIT_PATTERN.test(errorText)) return true;
  return extraPatterns.some((pattern) => pattern.test(errorText));
}

/** Compile the configured rate-limit signatures. Pattern validity is
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

/** Resolve the runtime backoff policy from config. The section being absent
 * (or an explicit zero retry budget) is the off switch: no retry machinery
 * runs. */
export function resolveRateLimitBackoff(config: PacingConfig): RateLimitBackoffPolicy | null {
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

// ---------------------------------------------------------------------------
// Admission gate (FIFO, no starvation, no rejection, never preempt)
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

/** Honest board-snapshot view: enabled flag, both pools, running counts,
 * and every queued entry with its queue time and reason. */
export interface PacingGateView {
  readonly enabled: boolean;
  readonly worker: PacingPoolView;
  readonly review: PacingPoolView;
}

/** Durable-record hook (the ledger in production) so queuing and admission
 * land on the record for observability. A throw fails the affected acquire
 * loudly without consuming a slot. */
export type PacingEventRecorder = (event: {
  readonly kind: string;
  readonly jobId?: string | null;
  readonly agentId?: string | null;
  readonly payload?: unknown;
}) => void;

export interface PacingAcquireInput {
  /** Caller-chosen identity (job id, round id, lens label…). */
  readonly id: string;
  /** Human-readable label rendered with the queue (board snapshot data). */
  readonly label: string;
  readonly jobId?: string | null;
  readonly agentId?: string | null;
  /** Cancels a QUEUED wait (live turns are never preempted). A wait that
   * was already admitted resolves with its lease instead. */
  readonly signal?: AbortSignal;
  /** Called synchronously when this acquire had to queue (never when it was
   * admitted immediately), so the caller can land the honest reason on its
   * own record. */
  readonly queued?: (info: { readonly position: number; readonly limit: number; readonly reason: string }) => void;
}

/** A held slot. Release hands the slot straight to the head waiter. */
export interface PacingLease {
  /** Hand the slot back and admit the next queued waiter (FIFO). Releasing
   * twice is a caller bug and throws. */
  release(): void;
  /** Time spent queued before admission; 0 when admitted immediately. */
  readonly waitedMs: number;
}

export interface PacingGateOptions {
  readonly enabled: boolean;
  readonly maxConcurrentMinions: number;
  readonly maxConcurrentReviewTurns: number;
  readonly record?: PacingEventRecorder;
  /** Clock seam (default Date.now). */
  readonly now?: () => number;
}

interface PacingWaiter {
  readonly id: string;
  readonly kind: PacingPool;
  readonly label: string;
  readonly jobId: string | null;
  readonly agentId: string | null;
  readonly queuedAt: string;
  readonly enqueueMs: number;
  readonly signal: AbortSignal | undefined;
  resolve: (lease: PacingLease) => void;
  reject: (error: Error) => void;
  onAbort: (() => void) | null;
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
  private readonly released = new WeakSet<object>();

  constructor(opts: PacingGateOptions) {
    this.enabled = opts.enabled;
    this.limits = {
      worker: Math.max(0, Math.floor(opts.maxConcurrentMinions)),
      review: Math.max(0, Math.floor(opts.maxConcurrentReviewTurns)),
    };
    this.record = opts.record ?? null;
    this.now = opts.now ?? Date.now;
  }

  /** Acquire a worker (minion turn) slot; queues FIFO while at the limit. */
  acquireWorkerTurn(input: PacingAcquireInput): Promise<PacingLease> {
    return this.acquire('worker', input);
  }

  /** Acquire a review turn slot (Perkins lead or lens); queues FIFO. */
  acquireReviewTurn(input: PacingAcquireInput): Promise<PacingLease> {
    return this.acquire('review', input);
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
      limit: this.limitFor(kind),
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

  private acquire(kind: PacingPool, input: PacingAcquireInput): Promise<PacingLease> {
    if (input.signal?.aborted === true) return Promise.reject(new Error('pacing wait aborted'));
    const limit = this.limitFor(kind);
    if (limit === 0 || this.running[kind] < limit) {
      this.running[kind] += 1;
      return Promise.resolve(this.mintLease(kind, 0));
    }
    return new Promise<PacingLease>((resolve, reject) => {
      const waiter: PacingWaiter = {
        id: input.id,
        kind,
        label: input.label,
        jobId: input.jobId ?? null,
        agentId: input.agentId ?? null,
        queuedAt: new Date(this.now()).toISOString(),
        enqueueMs: this.now(),
        signal: input.signal,
        resolve: () => {},
        reject: () => {},
        onAbort: null,
      };
      waiter.resolve = (lease) => {
        if (waiter.onAbort !== null && waiter.signal !== undefined) {
          waiter.signal.removeEventListener('abort', waiter.onAbort);
          waiter.onAbort = null;
        }
        resolve(lease);
      };
      waiter.reject = (error) => {
        if (waiter.onAbort !== null && waiter.signal !== undefined) {
          waiter.signal.removeEventListener('abort', waiter.onAbort);
          waiter.onAbort = null;
        }
        reject(error);
      };
      this.queues[kind].push(waiter);
      try {
        this.recordEvent('pacing.queued', waiter, {
          pool: kind, position: this.queues[kind].length, limit,
        });
        input.queued?.({
          position: this.queues[kind].length, limit, reason: this.queueReason(kind),
        });
      } catch (error) {
        this.queues[kind].splice(this.queues[kind].indexOf(waiter), 1);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (input.signal !== undefined) {
        waiter.onAbort = () => {
          const index = this.queues[kind].indexOf(waiter);
          if (index < 0) return; // already admitted; the lease holder releases
          this.queues[kind].splice(index, 1);
          try {
            this.recordEvent('pacing.wait-cancelled', waiter, { pool: kind });
            waiter.reject(new Error('pacing wait aborted'));
          } catch (error) {
            waiter.reject(error instanceof Error ? error : new Error(String(error)));
          }
        };
        if (input.signal.aborted) {
          waiter.onAbort();
        } else {
          input.signal.addEventListener('abort', waiter.onAbort, { once: true });
        }
      }
    });
  }

  private mintLease(kind: PacingPool, waitedMs: number): PacingLease {
    const lease: PacingLease = {
      waitedMs,
      release: () => {
        if (this.released.has(lease)) {
          throw new Error(`pacing ${kind} lease released twice — caller bookkeeping bug`);
        }
        this.released.add(lease);
        this.running[kind] = Math.max(0, this.running[kind] - 1);
        // A recorder failure rejects THAT waiter loudly, not an orphaned
        // lease. Continue draining so healthy queued callers cannot starve.
        for (;;) {
          const next = this.queues[kind].shift();
          if (next === undefined) return;
          const waited = Math.max(0, this.now() - next.enqueueMs);
          try {
            this.recordEvent('pacing.admitted', next, { pool: kind, waited_ms: waited });
          } catch (error) {
            next.reject(error instanceof Error ? error : new Error(String(error)));
            continue;
          }
          this.running[kind] += 1;
          next.resolve(this.mintLease(kind, waited));
          return;
        }
      },
    };
    return lease;
  }

  private recordEvent(
    kind: string,
    waiter: Pick<PacingWaiter, 'id' | 'label' | 'jobId' | 'agentId'>,
    payload: Record<string, unknown>,
  ): void {
    this.record?.({
      kind,
      jobId: waiter.jobId,
      agentId: waiter.agentId,
      payload: { id: waiter.id, label: waiter.label, ...payload },
    });
  }
}

/** Fully-resolved pacing policy for one service process: the optional
 * rate-limit backoff policy plus the admission gate (always present; a
 * disabled gate admits everyone immediately). */
export interface ResolvedPacingPolicy {
  readonly backoff: RateLimitBackoffPolicy | null;
  readonly gate: PacingGate;
}

export function resolvePacingPolicy(
  config: PacingConfig,
  opts: { readonly record?: PacingEventRecorder; readonly now?: () => number } = {},
): ResolvedPacingPolicy {
  return {
    backoff: resolveRateLimitBackoff(config),
    gate: new PacingGate({
      enabled: config.enabled,
      maxConcurrentMinions: config.maxConcurrentMinions,
      maxConcurrentReviewTurns: config.maxConcurrentReviewTurns,
      ...(opts.record !== undefined ? { record: opts.record } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    }),
  };
}
