/**
 * TYPED admission/progress OBSERVATION ports (phase2 ruling): the
 * cap/runtime layer EMITS authoritative observations about actual model
 * turns; the sensor CONSUMES them and decides its own one-continuation and
 * progress-gated fan-out. This replaces the phase1 proposal the chief
 * rejected (recordAdmission caller-assertion / fanOutPermitted(jobId) bool):
 * there is no caller-supplied admission claim and no jobId-keyed boolean —
 * every observation carries the exact bindings that make it authoritative.
 *
 * SOURCE ONLY in this phase: no installed cap hook is invented, no resume
 * path is wired to these ports until the matching interface is grounded and
 * ruled. Fakes below are for future test sources.
 */

/** An authoritative ACTUAL turn-start observation emitted by cap/runtime. */
export interface AdmissionObservation {
  /** The recovery claim this admission discharges (atomic claim id). */
  readonly claimId: string;
  /** Incident sequence of the recovering route batch. */
  readonly incidentSeq: number;
  /** Logical slot (silas-ops) when the admitted actor is the COO slot. */
  readonly logicalSlot: string | null;
  /** The admitted agent session + its CURRENT turn identity. */
  readonly agentId: string;
  readonly sessionTurn: string;
  /** Route/credential-generation binding the admitted turn runs under. */
  readonly routeKey: string;
  readonly credentialGeneration: number;
  readonly observedAt: string;
}

/** An authoritative PROGRESS observation (actual model output activity on
 * an admitted continuation) — the fan-out gate's input. */
export interface ProgressObservation {
  readonly claimId: string;
  readonly agentId: string;
  readonly sessionTurn: string;
  readonly routeKey: string;
  readonly credentialGeneration: number;
  readonly observedAt: string;
}

/** The consumer side the sensor implements: ONE continuation first; fan-out
 * only after a ProgressObservation bound to the SAME claim/slot/route. */
export interface AdmissionObservationSink {
  onAdmission(observation: AdmissionObservation): void;
  onProgress(observation: ProgressObservation): void;
}

/** Pure fan-out gate (sensor-owned decision, cap never supplies the bool):
 * expansion is permitted only for observations that bind EXACTLY to the
 * open claim's incident sequence, logical slot, session turn, route and
 * credential generation. Old unrelated job progress or a fresh quota read
 * NEVER releases quality/manual holds or gates fan-out by itself. */
export function fanOutPermittedFor(
  openClaim: {
    readonly claimId: string;
    readonly incidentSeq: number;
    readonly logicalSlot: string | null;
    /** The agent the admission receipt bound to THIS claim. */
    readonly admittedAgentId: string;
    /** The session turn the admission receipt bound to THIS claim. */
    readonly admittedSessionTurn: string;
    readonly routeKey: string;
    readonly credentialGeneration: number;
  },
  progress: ProgressObservation,
): boolean {
  // EVERY binding is enforced: claim, incident sequence, logical slot,
  // admitted actor + session turn, route, credential generation. Old or
  // other-turn output, other claims' progress, or rotated routes never
  // open fan-out.
  return (
    progress.claimId === openClaim.claimId &&
    progress.agentId === openClaim.admittedAgentId &&
    progress.sessionTurn === openClaim.admittedSessionTurn &&
    progress.routeKey === openClaim.routeKey &&
    progress.credentialGeneration === openClaim.credentialGeneration &&
    openClaim.incidentSeq >= 1 &&
    (openClaim.logicalSlot === null || openClaim.logicalSlot.length > 0)
  );
}
