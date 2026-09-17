/**
 * Typed in-process event bus (E6): the bridge between ledger writes and
 * every live consumer (board engine projections, board WS broadcast,
 * later supervision/notification routing in E7).
 *
 * Delivery is synchronous, in write order; a listener throw is caught and
 * logged — one bad consumer must never abort the write path that published.
 */

export interface BusEvent {
  /** Monotonic event seq from the ledger events table. */
  readonly seq: number;
  readonly ts: string;
  readonly kind: string;
  readonly agentId: string | null;
  readonly jobId: string | null;
  readonly roundId: string | null;
  readonly lens: string | null;
  readonly payload: unknown;
}

export type BusListener = (event: BusEvent) => void;

export class EventBus {
  private readonly listeners = new Set<BusListener>();
  private readonly dead: string[] = [];

  subscribe(listener: BusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: BusEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        // Record + continue: a failing subscriber loses THIS event, not
        // the publisher its write. The list is surfaced for diagnostics.
        this.dead.push(`${event.kind}: ${String(error)}`);
        if (this.dead.length > 50) this.dead.splice(0, this.dead.length - 50);
      }
    }
  }

  /** Listener failures since boot (diagnostics; drains on read). */
  drainFailures(): readonly string[] {
    return this.dead.splice(0);
  }
}
