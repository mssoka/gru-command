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

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('resident worker capacity must be a positive safe integer');
  }

  get occupied(): number { return this.used; }
  get queued(): number { return this.waiting.length; }
  get available(): number { return this.capacity - this.used; }

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
    if (this.available >= head.count) {
      this.waiting.shift();
      head.signal?.removeEventListener('abort', head.onAbort);
      this.used += head.count;
      head.resolve(this.releaseOnce(head.count));
      this.drain();
      return;
    }
    if (this.reclaiming) return;
    // Only reclaim idle minions, never review coordinators or children.
    const candidate = [...this.idle].filter(([handle, record]) =>
      handle.role === 'minion' && record.at !== null,
    ).sort((a, b) => (a[1].at ?? 0) - (b[1].at ?? 0) || a[1].order - b[1].order)[0]?.[0];
    if (candidate === undefined) return;
    this.reclaiming = true;
    this.idle.delete(candidate);
    // The supported handle disposal path releases its own permit. A failed
    // disposal cannot release capacity, and must not spin on the same handle.
    void candidate.dispose().catch((error: unknown) => {
      const index = this.waiting.indexOf(head);
      if (index >= 0) {
        this.waiting.splice(index, 1);
        head.signal?.removeEventListener('abort', head.onAbort);
        head.reject(new Error(`resident idle disposal failed: ${String(error)}`));
      }
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
