/**
 * Bounded spawn-retry gate for the single Gru session.
 *
 * The chat server spawns on demand — a client (re)connect that flushes an
 * unacked word can reach the spawn path again immediately. When the spawn
 * fails for a durable reason (unknown model, bad provider config), that
 * turns into a per-reconnect retry loop: the 2026-09-22 07:30 report shows
 * the identical spawn attempted ~5 times in ~5 seconds.
 *
 * This gate spaces consecutive genuine spawn attempts exponentially
 * (base · 2^(failures-1), capped) and never retries by itself: a caller
 * that arrives during the window is rejected fast with the remaining
 * wait, and the NEXT attempt happens on the next message/reconnect after
 * the window expires. A success resets the gate, so a repaired model
 * starts serving immediately.
 */
export class SpawnRetryGate {
  private failures = 0;
  private blockedUntil = 0;

  constructor(
    private readonly baseMs: number,
    private readonly capMs: number,
  ) {}

  /** Consecutive failures since the last successful spawn. */
  get failureCount(): number {
    return this.failures;
  }

  /** Delay (ms) for the failure that just happened. */
  recordFailure(now: number = Date.now()): number {
    this.failures += 1;
    const delay = this.delayFor(this.failures);
    this.blockedUntil = now + delay;
    return delay;
  }

  /** True while a new genuine spawn attempt must wait. */
  isBlocked(now: number = Date.now()): boolean {
    return now < this.blockedUntil;
  }

  /** Remaining cooldown for the caller-facing rejection, in whole ms. */
  blockedFor(now: number = Date.now()): number {
    return Math.max(0, this.blockedUntil - now);
  }

  /** A successful spawn ends the failure episode. */
  reset(): void {
    this.failures = 0;
    this.blockedUntil = 0;
  }

  private delayFor(count: number): number {
    if (this.baseMs <= 0 || this.capMs <= 0) return 0;
    // Cap the exponent so a long outage cannot overflow into Infinity.
    return Math.min(this.baseMs * 2 ** Math.min(count - 1, 26), this.capMs);
  }
}
