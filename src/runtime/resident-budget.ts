import type { AgentHandle } from './types.js';

/** Atomic, FIFO admission of resident worker permits. A round takes its lead
 * and first child together; later single-worker arrivals cannot steal the
 * first permit freed while the round is at the head of the queue. */
export class ResidentBudget {
  private used = 0;
  private readonly waiting: Array<{
    readonly count: number;
    readonly resolve: (release: () => void) => void;
    readonly reject: (error: Error) => void;
    readonly signal?: AbortSignal;
    readonly onAbort: () => void;
  }> = [];
  private readonly idle = new Map<AgentHandle, { at: number | null; order: number; readonly eligible: () => boolean }>();
  private nextIdleOrder = 0;
  private reclaiming = false;
  private stopped = false;
  /** Drain epoch: one admission decision at the head of the queue. Each
   * eligible idle worker is attempted at most once per epoch; a FAILED
   * disposal is recorded (and never re-attempted this epoch, so our own
   * failure-driven changed() callback cannot spin). A SUCCESSFUL partial
   * reclaim is progress, not exhaustion — the head waiter stays queued and
   * retains the freed capacity for its own admission. */
  private epoch = 0;
  private epochHead: unknown = null;
  private readonly epochTried = new Set<AgentHandle>();
  private reclaimFailures = 0;

  /** Durable, deduplicated reclaim-failure observations (one per handle
   * per drain epoch, by construction). The registry relays these; the
   * budget owns no ledger. */
  onReclaimFailure?: (observation: {
    readonly agentId: string;
    readonly generation: number;
    readonly attempt: number;
    readonly error: string;
  }) => void;

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('resident worker capacity must be a positive safe integer');
  }

  get reclaimFailureCount(): number { return this.reclaimFailures; }

  get occupied(): number { return this.used; }
  get queued(): number { return this.waiting.length; }
  get available(): number { return this.capacity - this.used; }

  /** Idle minions THIS budget would attempt to reclaim right now — the
   * same role + health + eligibility predicate the reclaim path uses
   * (read-only observation; no reservation, no side effects). */
  eligibleIdleCount(): number {
    let count = 0;
    for (const [handle, record] of this.idle) {
      if (handle.role !== 'minion') continue;
      try {
        if (handle.health().state === 'idle' && record.eligible()) count += 1;
      } catch {
        // A throwing probe is not eligibility.
      }
    }
    return count;
  }

  /** Keep an idle resident warm until the oldest safe one is needed. */
  watch(handle: AgentHandle, eligible: () => boolean, at: number = Date.now()): void {
    this.idle.set(handle, { eligible, at: handle.health().state === 'idle' && eligible() ? at : null,
      order: this.nextIdleOrder++,
    });
  }

  unwatch(handle: AgentHandle): void { this.idle.delete(handle); }
  /** Called when an in-flight prompt/control settles or a supervisor event
   * changes eligibility: a waiting request must not require another spawn. */
  changed(): void { this.drain(); }

  async acquire(count = 1, signal?: AbortSignal): Promise<() => void> {
    if (!Number.isSafeInteger(count) || count < 1 || count > this.capacity) {
      throw new Error(`resident request of ${count} cannot fit capacity ${this.capacity}`);
    }
    if (this.stopped || signal?.aborted) throw new Error('resident admission cancelled');
    return new Promise((resolve, reject) => {
      const request = {
        count, resolve, reject, signal,
        onAbort: () => {
          const index = this.waiting.indexOf(request);
          if (index < 0) return;
          this.waiting.splice(index, 1);
          signal?.removeEventListener('abort', request.onAbort);
          reject(new Error('resident admission cancelled'));
          this.drain();
        },
      };
      this.waiting.push(request);
      signal?.addEventListener('abort', request.onAbort, { once: true });
      this.drain();
    });
  }

  /** Optional lens concurrency only takes truly spare capacity; it never
   * waits behind a competing round and cannot deadlock its own lead. */
  tryAcquire(): (() => void) | null {
    if (this.stopped || this.waiting.length > 0 || this.used >= this.capacity) return null;
    this.used += 1;
    return this.releaseOnce(1);
  }

  private releaseOnce(count: number): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.used -= count;
      this.drain();
    };
  }

  private drain(): void {
    if (this.stopped) return;
    for (const [handle, record] of this.idle) {
      if (handle.health().state !== 'idle' || !record.eligible()) record.at = null;
      else if (record.at === null) { record.at = Date.now(); record.order = this.nextIdleOrder++; }
    }
    const head = this.waiting[0];
    if (head === undefined) return;
    if (head.signal?.aborted) { head.onAbort(); return; }
    // A new waiter at the head starts a new drain epoch: every eligible
    // idle worker is reconsidered exactly once for it, regardless of how
    // the previous waiter left the queue.
    if (head !== this.epochHead) {
      this.epochHead = head;
      this.epoch += 1;
      this.epochTried.clear();
    }
    if (this.available >= head.count) {
      this.waiting.shift();
      head.signal?.removeEventListener('abort', head.onAbort);
      this.used += head.count;
      head.resolve(this.releaseOnce(head.count));
      this.drain();
      return;
    }
    if (this.reclaiming) return;
    // Only reclaim idle minions, never review coordinators or children. A
    // candidate that already failed THIS drain epoch is not reattempted —
    // our own failure-driven changed() callback must not spin the queue.
    const candidate = [...this.idle].filter(([handle, record]) =>
      handle.role === 'minion' && record.at !== null && !this.epochTried.has(handle),
    ).sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0) || a[1].order - b[1].order)[0]?.[0];
    if (candidate === undefined) {
      // Nothing eligible to attempt: the steady state of a full house with
      // no warm eligible worker — the waiter stays QUEUED and a future
      // release/changed() re-drains. Only a genuine epoch exhaustion (every
      // eligible idle worker was tried and every disposal FAILED) is
      // surfaced loud to the head waiter; a successful reclaim that freed
      // too little capacity keeps the waiter queued (demand-driven
      // reservation), never rejects it.
      if (this.epochTried.size === 0) return;
      // Epoch exhausted: every attempted disposal failed. Surface the real
      // decision to the head waiter — capacity stays truthful, nothing is
      // force-released.
      const index = this.waiting.indexOf(head);
      if (index >= 0) {
        this.waiting.splice(index, 1);
        head.signal?.removeEventListener('abort', head.onAbort);
        head.reject(new Error(
          `resident reclaim exhausted: ${this.epochTried.size} eligible idle worker(s) failed disposal this epoch; ` +
          'free a worker or raise [concurrency] max_workers',
        ));
      }
      return;
    }
    this.reclaiming = true;
    this.idle.delete(candidate);
    // The supported handle disposal path releases its own permit. A failed
    // disposal cannot release capacity; it keeps its permit and the drain
    // continues fairly with the next genuinely different candidate. Only
    // failures are recorded for the epoch's exhaustion decision.
    void candidate.dispose().catch((error: unknown) => {
      this.reclaimFailures += 1;
      this.epochTried.add(candidate);
      this.onReclaimFailure?.({
        agentId: candidate.id, generation: this.epoch, attempt: this.epochTried.size,
        error: String(error),
      });
    }).finally(() => {
      this.reclaiming = false;
      this.drain();
    });
  }

  shutdown(): void {
    this.stopped = true;
    for (const request of this.waiting.splice(0)) {
      request.signal?.removeEventListener('abort', request.onAbort);
      request.reject(new Error('resident admission cancelled by shutdown'));
    }
  }
}
