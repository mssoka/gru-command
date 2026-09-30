/**
 * Read-only residency observations (chief ruling 2026-09-28, phase 2).
 *
 * The cap (RuntimeRegistry + ResidentBudget) owns admission/residency and
 * its authoritative event source. This surface EXPOSES existing runtime
 * facts for observers (e.g. the durable-blocked follow-through sensor); it
 * deliberately has NO caller-writable admission record and NO
 * fan-out-permission flag — admission evidence originates from actual
 * runtime spawn/turn-start events (the registry's agent-event feed), and
 * progress must belong to the same resumed attempt, never historical job
 * activity. Sensor-side keys (continuation claim, incident sequence,
 * logical slot, endpoint/credential generation) are intentionally NOT
 * minted here: the sensor owns its durable waiter/claim/fan-out policy and
 * joins its keys to these observations by agent/session identity.
 */

/** Live, per-handle snapshot of a resident worker session. */
export interface ResidentHandleObservation {
  readonly agentId: string;
  readonly role: string;
  readonly sessionFile: string | null;
  /** Adapter-reported state ('idle' here is a display label, not quiescence). */
  readonly state: string;
}

/** Aggregated pool state at observation time. */
export interface ResidencySnapshot {
  readonly capacity: number;
  readonly occupied: number;
  /** Waiters queued for FIFO admission (review pairs count as one waiter). */
  readonly queued: number;
  readonly reclaimFailures: number;
  readonly handles: readonly ResidentHandleObservation[];
}
