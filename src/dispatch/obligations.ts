import type { BusEvent } from '../events/bus.js';
import type { LedgerApi, PhaseHandoffRecord } from '../ledger/api.js';
import type { LogLevel } from '../logger.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Dispatch-side follow-through observers (phase 3 slice). Pure wiring on
 * the existing event bus, ledger primitives and the existing single Gru
 * wake path (`NotificationCenter.postIncident` → awareness notify_wake).
 * No scheduler, no timer, no second wake path, no execution: the
 * phase-completion hand-back records debt AND routes one action-required
 * Gru row; boot adoption records triage debt only — the digest / FOR YOU
 * projection slices consume those rows later.
 *
 * Incident 131/132/133 (same-head audit completes, lane stays blocked):
 * `flipJobToWorking` intentionally has no effect on a blocked lane, so
 * before this observer the settled turn recorded `job.delivered` and then
 * NOTHING — no hand-back, no next decision, an orphaned blocked row. The
 * hand-back here is the durable fix: one obligation (the debt) plus one
 * action-required row (the wake). Delivery is not approval and a settled
 * turn is not completion.
 */

/** The notifications surface the observers need (structural —
 * NotificationCenter fits). */
export interface FollowThroughNotifications {
  postIncident(input: {
    kind: string;
    routing: 'action-required' | 'needs-owner' | 'fyi';
    severity: 'info' | 'error';
    title: string;
    detail?: string | null;
    agentId?: string | null;
    dedupe: 'unacked' | 'active' | 'all';
  }): { readonly id: string };
}

export interface FollowThroughDeps {
  readonly ledger: LedgerApi;
  readonly notifications: FollowThroughNotifications;
  readonly log?: Log;
}

/** Sources that mark a Silas follow-up turn (a bounded phase). */
const FOLLOW_UP_SOURCES = new Set(['silas-directive', 'silas-rebrief']);

export interface HandBackResult {
  readonly jobId: string;
  readonly obligationId: string;
  readonly notificationKind: string;
  /** true when this call created the hand-back; false when a replay of
   * the same delivered event found it already recorded. */
  readonly created: boolean;
  /** true when THIS call posted the stable-kind card; false when the
   * logical card already existed (any state) or the obligation already
   * carried it. */
  readonly posted: boolean;
}

/**
 * Observe a settled follow-up delivery (`job.delivered` with a Silas
 * source). When the lane is STILL blocked after the phase completed, the
 * next decision is owed durably: the same-head case (no head move is
 * fine) records one phase-completion obligation and ONE action-required
 * Gru hand-back on the existing wake path. Replays of the same delivered
 * event coalesce (the obligation identity carries the event seq; the
 * stable-kind card is never re-posted in any state). A delivery on a lane
 * that is not blocked is the normal review flow — nothing is recorded.
 *
 * Returns null when the event is not a follow-up delivery or the lane
 * needs no hand-back.
 */
export function observeFollowUpDelivery(
  deps: FollowThroughDeps,
  event: Pick<BusEvent, 'kind' | 'jobId' | 'seq' | 'payload'>,
): HandBackResult | null {
  if (event.kind !== 'job.delivered' || event.jobId === null) return null;
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const target = unmarkedHandbackTarget(deps, event.jobId, event.seq, payload);
  if (target === null) return null;
  return recordUnmarkedHandback(deps, target);
}

interface UnmarkedHandbackTarget {
  readonly jobId: string;
  readonly seq: number;
  readonly source: string;
  readonly sha: string | null;
}

/**
 * The durable target of one unmarked hand-back, resolved from ACTUAL
 * durable state — never the caller's claim. The lane must still be blocked
 * at recovery time: a lane that moved on already has its own follow-through
 * (the original blocked fact is what mints this debt).
 */
function unmarkedHandbackTarget(
  deps: FollowThroughDeps,
  jobId: string,
  seq: number,
  payload: Record<string, unknown>,
): UnmarkedHandbackTarget | null {
  const source = typeof payload['source'] === 'string' ? payload['source'] : null;
  if (source === null || !FOLLOW_UP_SOURCES.has(source)) return null;
  // An explicitly marked phase owns its own hand-back path
  // (`observePhaseCompletion`), keyed on the host-owned phase id — never
  // double-publish the event-sequence card for the same delivery.
  const phaseId = typeof payload['phase_id'] === 'string' && payload['phase_id'] !== '' ? payload['phase_id'] : null;
  if (phaseId !== null && deps.ledger.getPhaseHandoff(phaseId) !== null) return null;
  const job = deps.ledger.getJob(jobId);
  if (job === null || job.status !== 'blocked') return null; // normal flow — review/digest owns it
  const sha = typeof payload['sha'] === 'string' && payload['sha'] !== '' ? payload['sha'] : null;
  return { jobId, seq, source, sha };
}

/**
 * The ONE record-and-publish routine every unmarked hand-back rides
 * (live observer and boot backstop), so the crash windows cannot drift
 * from the live path. The debt upsert is idempotent by event identity;
 * the card is the one stable-kind row per delivery event and is never
 * re-posted once any incarnation exists.
 */
function recordUnmarkedHandback(deps: FollowThroughDeps, target: UnmarkedHandbackTarget): HandBackResult {
  // Identity carries the delivered event seq: a distinct phase completion
  // is a distinct hand-back; a replay of the same event coalesces onto
  // the same obligation and the same notification.
  const incidentKey = `phase-handback@${target.seq}`;
  const before = deps.ledger
    .listObligations({ jobId: target.jobId })
    .find((row) => row.incidentKey === incidentKey && row.state !== 'settled' && row.state !== 'closed');
  const obligation = before ?? deps.ledger.recordBlockedObservation(target.jobId, {
    logicalStep: 'operation',
    category: { kind: 'known', category: 'phase-completion' },
    incidentKey,
    observedAtSeq: target.seq,
    description:
      `bounded ${target.source} phase completed while the lane remains blocked ` +
      `(delivered event ${target.seq}${target.sha === null ? '' : `, head ${target.sha}`})`,
    dueAt: null,
  });
  const posted = publishUnmarkedHandbackCard(deps, target, obligation.id);
  deps.log?.('info', 'follow-through hand-back recorded', {
    job: target.jobId,
    obligation: obligation.id,
    notification_kind: `silas.phase-handback.${target.jobId}@${target.seq}`,
    delivered_seq: target.seq,
  });
  return {
    jobId: target.jobId,
    obligationId: obligation.id,
    notificationKind: `silas.phase-handback.${target.jobId}@${target.seq}`,
    created: before === undefined,
    posted,
  };
}

/** The ONE stable-kind card per delivery event. A row of this kind that
 * already exists — unacked, acked or resolved — IS the logical card and
 * is never re-posted (no fresh alert ids to bypass wake dedupe). Returns
 * true only when this call actually posted it. */
function publishUnmarkedHandbackCard(
  deps: FollowThroughDeps,
  target: UnmarkedHandbackTarget,
  obligationId: string,
): boolean {
  const notificationKind = `silas.phase-handback.${target.jobId}@${target.seq}`;
  if (deps.ledger.findNotificationByKind(notificationKind, 'any') !== null) return false;
  deps.notifications.postIncident({
    kind: notificationKind,
    routing: 'action-required',
    severity: 'info',
    title: `Phase completed on blocked job ${target.jobId} — ruling requested`,
    detail:
      `A bounded ${target.source} phase settled` +
      `${target.sha === null ? '' : ` (head ${target.sha})`}` +
      ` but the lane is still blocked. The obligation ${obligationId} durably owes the next Gru ` +
      'ruling (same head is evidence, not approval). No owner prompting is required; this row is ' +
      'the machine hand-back.',
    dedupe: 'unacked',
  });
  return true;
}

export interface UnmarkedReconcileReport {
  /** Window-A candidates examined (delivery committed, observer never ran). */
  readonly deliveries: number;
  /** Window-B candidates examined (obligation live, card never posted). */
  readonly cards: number;
  /** Hand-back obligations recorded by this pass. */
  readonly recovered: number;
  /** Stable-kind cards newly posted by this pass (either window). */
  readonly published: number;
  /** Rows whose recovery threw — counted so a partial pass is never
   * reported as fully reconciled (the row stays for the next pass). */
  readonly failed: number;
  /** Next rowid/seq cursor for each window, or null when the pass reached
   * the tail (the next pass starts over). Durable fairness: a persistently
   * failing prefix cannot starve later eligible hand-backs. */
  readonly deliveriesCursor: number | null;
  readonly cardsCursor: number | null;
}

/**
 * Boot backstop for UNMARKED blocked-phase hand-backs (PR136 r4 blocker
 * 2). The live observer runs only after the delivery commit publishes on
 * the bus; two crash windows can lose the hand-back entirely:
 *
 * (a) the `job.delivered` event committed but the observer never ran —
 *     recovered from the delivery candidate set (no obligation yet);
 * (b) the obligation committed but its action-required card never posted —
 *     recovered from the live-obligation candidate set.
 *
 * Both windows ride the SAME record/publish routine as the live observer
 * and both candidate sets drop rows as they are processed, so bounded
 * passes make progress and re-running a pass is a no-op. Nothing
 * re-dispatches a worker, rings the owner or mints a fresh alert id: the
 * one card is machine action-required, deduped by its stable kind.
 */
export function reconcileUnmarkedHandbacks(
  deps: FollowThroughDeps,
  opts: { limit?: number; deliveriesCursor?: number; cardsCursor?: number } = {},
): UnmarkedReconcileReport {
  const limit = Math.min(Math.max(1, opts.limit ?? 200), 1000);
  let deliveries = 0;
  let cards = 0;
  let recovered = 0;
  let published = 0;
  let failed = 0;
  const deliveryRows = deps.ledger.listUnmarkedHandbackDeliveries(limit, {
    cursor: opts.deliveriesCursor ?? 0,
  });
  for (const event of deliveryRows) {
    if (event.jobId === null) continue;
    deliveries += 1;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const target = unmarkedHandbackTarget(deps, event.jobId, event.seq, payload);
    if (target === null) continue;
    try {
      const result = recordUnmarkedHandback(deps, target);
      if (result.created) recovered += 1;
      if (result.posted) published += 1;
    } catch (error) {
      // One malformed/conflicting row stays VISIBLE and never takes the
      // pass down: the next pass retries it from durable state.
      failed += 1;
      deps.log?.('error', 'unmarked hand-back recovery failed', {
        job: event.jobId,
        seq: event.seq,
        error: String(error),
      });
    }
  }
  const cardPage = deps.ledger.listHandbacksMissingCardsDetailed(limit, {
    cursor: opts.cardsCursor ?? 0,
  });
  cards += cardPage.readable.length + cardPage.malformed;
  // A malformed row is a failed reconciliation, not a silent skip: it is
  // counted and logged while the cursor still advances past it.
  failed += cardPage.malformed;
  if (cardPage.malformed > 0) {
    deps.log?.('error', 'unmarked hand-back card rows could not be decoded', {
      malformed: cardPage.malformed,
    });
  }
  for (const obligation of cardPage.readable) {
    const seq = Number(obligation.incidentKey.slice('phase-handback@'.length));
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      failed += 1;
      deps.log?.('error', 'unmarked hand-back obligation has a malformed incident key', {
        obligation: obligation.id,
        incident_key: obligation.incidentKey,
      });
      continue;
    }
    // The delivery event is the source of the card's detail; a missing
    // event still publishes the same stable-kind card (the obligation is
    // the durable debt — the card must not be lost to a lookup).
    const event = deps.ledger.getEvent(seq);
    const payload = (event?.payload ?? {}) as Record<string, unknown>;
    const source = typeof payload['source'] === 'string' && FOLLOW_UP_SOURCES.has(payload['source'])
      ? payload['source']
      : 'follow-up';
    const sha = typeof payload['sha'] === 'string' && payload['sha'] !== '' ? payload['sha'] : null;
    try {
      if (publishUnmarkedHandbackCard(deps, { jobId: obligation.jobId, seq, source, sha }, obligation.id)) {
        published += 1;
        deps.log?.('info', 'unmarked hand-back card reconciled after a crash window', {
          job: obligation.jobId,
          obligation: obligation.id,
          delivered_seq: seq,
        });
      }
    } catch (error) {
      failed += 1;
      deps.log?.('error', 'unmarked hand-back card recovery failed', {
        job: obligation.jobId,
        seq,
        error: String(error),
      });
    }
  }
  const lastDelivery = deliveryRows[deliveryRows.length - 1];
  const deliveriesCursor =
    deliveryRows.length < limit || lastDelivery === undefined
      ? null
      : lastDelivery.seq;
  const cardsCursor = cardPage.exhausted ? null : cardPage.lastRowid;
  return { deliveries, cards, recovered, published, failed, deliveriesCursor, cardsCursor };
}

export interface AdoptionReport {
  readonly scanned: number;
  readonly adopted: number;
}

/**
 * Conservative boot adoption of pre-existing blocked lanes (migration is
 * triage/retention, never replay): a blocked job with NO obligation
 * history at all gets ONE unknown-triage obligation owed to Gru. Terminal
 * jobs can never be blocked; parked lanes are not scanned (explicit
 * suspension territory, no revival); lanes that already have obligation
 * history — active or settled — are left exactly as the live system left
 * them. The candidate query excludes already-adopted lanes, so the
 * bounded window always holds unadopted work and each pass can reach the
 * next candidates instead of re-scanning an adopted prefix forever (N3).
 */
export function adoptBlockedLanes(deps: FollowThroughDeps, opts: { limit?: number } = {}): AdoptionReport {
  const limit = Math.min(Math.max(1, opts.limit ?? 500), 2000);
  const candidates = deps.ledger.listBlockedJobsWithoutObligations(limit);
  let adopted = 0;
  for (const job of candidates) {
    // The list is a bounded snapshot: re-check the contract it promises
    // (no obligation history) before adopting, so a racing/late history
    // row is skipped, never coalesced into.
    const history = deps.ledger.listObligations({ jobId: job.id, limit: 1 });
    if (history.length > 0) continue; // already tracked — not a migration case
    deps.ledger.recordBlockedObservation(job.id, {
      logicalStep: 'operation',
      category: { kind: 'unknown' },
      observedAtSeq: deps.ledger.latestEventSeq(),
      description: 'boot adoption of a pre-existing blocked lane — triage owed to Gru, never replayed as work',
    });
    adopted += 1;
    deps.log?.('info', 'blocked lane adopted for triage', { job: job.id });
  }
  return { scanned: candidates.length, adopted };
}

// --------------------------------------------------------------------
// Explicit phase-completion handoff (pr136-chief-handoff): an authorized
// bounded phase was MARKED as owing Gru a decision when its request was
// accepted (before any side effect). When that exact phase reaches a
// VALIDATED correlated terminal delivery, the service records the owed
// obligation and publishes ONE deterministic action-required row on the
// existing Gru wake path — no watcher, no minion callback, no LLM
// routing, no second wake pipeline. This is the general case the
// blocked-only legacy observer could not cover: a fresh artifact-only
// dispatch (source=dispatch, working→delivered, no commit/PR) and a
// same-head rebrief on a NONblocked lane both hand back here, while
// omission of the intent keeps ordinary Silas completion unchanged.
// --------------------------------------------------------------------

/** Minimal terminal-event shape the observer/reconciler consume (BusEvent
 * and EventRecord both fit). */
interface DeliveryEventLike {
  readonly kind: string;
  readonly jobId: string | null;
  readonly seq: number;
  readonly payload: unknown;
}

export interface PhaseCompletionResult {
  readonly phaseId: string;
  readonly jobId: string;
  readonly obligationId: string | null;
  readonly notificationId: string | null;
  /** true when THIS call completed an awaiting phase (recorded the debt);
   * false when it finished/replayed an already-completed phase. */
  readonly created: boolean;
  /** true when a durable terminal/parked guard closed the phase without a
   * hand-back (the debt suspended/settled instead of published). */
  readonly closed: boolean;
}

function payloadOf(event: DeliveryEventLike): Record<string, unknown> {
  return (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
}

/**
 * Admission/correlation gate: a delivery can complete a phase only when
 * the phase's OWN admission evidence exists. `job.delivered`, HTTP
 * success/timeout, idle, a nonempty file or an assistant claim alone is
 * never enough; a failed, error-settled or disposed attempt records no
 * admission and therefore cannot masquerade as completion.
 */
function phaseAdmissionValid(
  ledger: FollowThroughDeps['ledger'],
  phase: PhaseHandoffRecord,
  payload: Record<string, unknown>,
): boolean {
  switch (phase.source) {
    case 'silas-directive': {
      if (phase.requestId === null) return false;
      if (payload['request_id'] !== phase.requestId) return false;
      const directive = ledger.getDirective(phase.requestId);
      return (
        directive !== null &&
        directive.jobId === phase.jobId &&
        (directive.state === 'admitted' || directive.state === 'settled')
      );
    }
    case 'silas-rebrief':
      // The re-brief request records its own `silas.rebrief` event (with
      // this phase id) BEFORE the delivery; an interrupted/failed re-brief
      // records none and can never complete. (When the marker pair still
      // exists the delivery is emitted by the same finalizer.)
      return findPhaseRequestEvent(ledger, phase);
    case 'dispatch':
      // The dispatch flow binds the spawned minion before the prompt; a
      // delivery from any other worker is not this phase's completion.
      return phase.minionId !== null && payload['agentId'] === phase.minionId;
  }
}

/** The phase's own request event, postdating its intent watermark. */
function findPhaseRequestEvent(ledger: FollowThroughDeps['ledger'], phase: PhaseHandoffRecord): boolean {
  for (const event of ledger.listJobEvents(phase.jobId, { limit: 1000 })) {
    if (event.kind !== 'silas.rebrief') continue;
    if (event.seq <= phase.intentSeq) continue;
    const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
    if (payload['phase_id'] === phase.phaseId) return true;
  }
  return false;
}

/** The newest correlated terminal delivery for an awaiting phase, or null
 * when none (or none that passes the admission gates). Bounded scan of
 * the job's events; the phase row is the authority, the event is evidence. */
function findPhaseCompletionEvent(
  ledger: FollowThroughDeps['ledger'],
  phase: PhaseHandoffRecord,
): DeliveryEventLike | null {
  for (const event of ledger.listJobEvents(phase.jobId, { limit: 1000 })) {
    if (event.kind !== 'job.delivered') continue;
    if (event.seq <= phase.intentSeq) continue;
    const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
    if (payload['phase_id'] !== phase.phaseId) continue;
    if (payload['source'] !== phase.source) continue;
    if (!phaseAdmissionValid(ledger, phase, payload)) continue;
    return { kind: event.kind, jobId: event.jobId, seq: event.seq, payload: event.payload };
  }
  return null;
}

/**
 * Observe one bus event for a marked phase's validated terminal
 * completion. Returns null when the event is not a completion for an
 * explicitly marked phase; a closed phase stays closed (a late receipt
 * never revives it). Publication is deterministic and deduped by the
 * stable per-phase notification kind, so replays coalesce.
 */
export function observePhaseCompletion(
  deps: FollowThroughDeps,
  event: Pick<BusEvent, 'kind' | 'jobId' | 'seq' | 'payload'>,
): PhaseCompletionResult | null {
  if (event.kind !== 'job.delivered' || event.jobId === null) return null;
  const payload = payloadOf(event);
  const phaseId = typeof payload['phase_id'] === 'string' && payload['phase_id'] !== '' ? payload['phase_id'] : null;
  if (phaseId === null) return null;
  const phase = deps.ledger.getPhaseHandoff(phaseId);
  if (phase === null || phase.jobId !== event.jobId) return null;
  return settlePhaseCompletion(deps, phase, event);
}

/**
 * The shared completion routine (observer and boot reconciliation ride
 * it): complete the awaiting phase once its evidence validates, then
 * record the debt and publish the one stable-kind action-required row.
 * Guards re-read durable state: a terminal job settles the debt
 * `job-terminal` and closes the phase; a parked job SUSPENDS the debt
 * (explicit owner stop — no wake, no resume) and closes the phase. In
 * both guarded cases nothing is published: an owner stop is never a Gru
 * decision, and a terminal lane is never revived.
 */
function settlePhaseCompletion(
  deps: FollowThroughDeps,
  phase: PhaseHandoffRecord,
  event: DeliveryEventLike,
): PhaseCompletionResult | null {
  if (phase.state === 'closed') return null; // terminal history — a late receipt cannot revive it
  if (phase.state === 'completed') return finishPhaseHandoff(deps, phase, false);
  const payload = payloadOf(event);
  if (event.seq <= phase.intentSeq) return null; // an older receipt cannot complete this phase
  if (payload['source'] !== phase.source) return null;
  if (!phaseAdmissionValid(deps.ledger, phase, payload)) {
    deps.log?.('info', 'phase completion evidence rejected — admission gate', {
      phase: phase.phaseId,
      source: phase.source,
      seq: event.seq,
    });
    return null;
  }
  const completed = deps.ledger.completePhaseHandoff({ phaseId: phase.phaseId, completionSeq: event.seq });
  deps.log?.('info', 'phase handoff completed', {
    phase: completed.phaseId,
    job: completed.jobId,
    source: completed.source,
    completion_seq: event.seq,
  });
  return finishPhaseHandoff(deps, completed, true);
}

/**
 * Record the owed obligation (if missing) and publish the ONE stable
 * action-required row (if not yet published), applying the durable
 * terminal/parked guards. Every step is idempotent, so a crash between
 * any two steps is repaired by the next boot reconciliation without a
 * duplicate obligation or card.
 */
function finishPhaseHandoff(
  deps: FollowThroughDeps,
  phase: PhaseHandoffRecord,
  created: boolean,
): PhaseCompletionResult | null {
  if (phase.completionSeq === null) return null; // defensive: completed rows always carry it
  const job = deps.ledger.getJob(phase.jobId);
  if (job === null) return null;
  let obligation = phase.obligationId === null ? null : deps.ledger.getObligation(phase.obligationId);
  if (obligation === null) {
    obligation = deps.ledger.recordBlockedObservation(phase.jobId, {
      logicalStep: 'operation',
      category: { kind: 'known', category: 'phase-completion' },
      incidentKey: `phase-handoff@${phase.phaseId}`,
      observedAtSeq: phase.completionSeq,
      description:
        `explicitly marked ${phase.source} phase completed (event ${phase.completionSeq}); ` +
        `the next decision is owed durably: ${phase.decision}`,
      nextAction: { kind: 'gru-decision', decision: phase.decision },
      firingRule: 'phase-completion-gru-decision',
    });
    deps.ledger.markPhaseHandoffObligation({ phaseId: phase.phaseId, obligationId: obligation.id });
  }
  const obligationId = obligation.id;
  const terminal = job.status === 'done' || job.status === 'merged';
  if (terminal) {
    if (obligation.state === 'open' || obligation.state === 'waiting' || obligation.state === 'suspended') {
      deps.ledger.settleObligation({
        obligationId,
        settlement: { kind: 'job-terminal', jobStatus: job.status },
      });
    }
    deps.ledger.closePhaseHandoff({
      phaseId: phase.phaseId,
      reason: `job reached ${job.status} before the hand-back could be published`,
    });
    deps.log?.('info', 'phase handoff closed by terminal job', { phase: phase.phaseId, job: phase.jobId });
    return { phaseId: phase.phaseId, jobId: phase.jobId, obligationId, notificationId: null, created, closed: true };
  }
  if (job.status === 'parked') {
    if (obligation.state === 'open' || obligation.state === 'waiting') {
      deps.ledger.suspendObligation(
        obligationId,
        'job parked — phase hand-back suspended by explicit durable state (no wake)',
      );
    }
    deps.ledger.closePhaseHandoff({
      phaseId: phase.phaseId,
      reason: 'job parked before the hand-back could be published — debt suspended for explicit resume',
    });
    deps.log?.('info', 'phase handoff suspended by parked job', { phase: phase.phaseId, job: phase.jobId });
    return { phaseId: phase.phaseId, jobId: phase.jobId, obligationId, notificationId: null, created, closed: true };
  }
  if (phase.notificationId !== null) {
    return { phaseId: phase.phaseId, jobId: phase.jobId, obligationId, notificationId: phase.notificationId, created, closed: false };
  }
  const card = deps.notifications.postIncident({
    kind: `silas.phase-handback.${phase.phaseId}`,
    routing: 'action-required',
    severity: 'info',
    title: `Phase completed on job ${phase.jobId} — Gru decision owed`,
    detail:
      `An explicitly marked ${phase.source} phase completed (event ${phase.completionSeq}). ` +
      `The durable obligation ${obligationId} owes the next Gru decision: ${phase.decision}. ` +
      'Completion is evidence, never approval; this row is the machine hand-back on the existing wake path ' +
      'and requires no owner prompt.',
    dedupe: 'all',
  });
  deps.ledger.markPhaseHandoffPublished({ phaseId: phase.phaseId, notificationId: card.id });
  deps.log?.('info', 'phase handoff published', {
    phase: phase.phaseId,
    job: phase.jobId,
    obligation: obligationId,
    notification: card.id,
  });
  return { phaseId: phase.phaseId, jobId: phase.jobId, obligationId, notificationId: card.id, created, closed: false };
}

export interface PhaseReconcileReport {
  readonly examined: number;
  /** Awaiting phases completed by this pass (completion evidence found). */
  readonly completed: number;
  /** Phases whose action-required row was published by this pass. */
  readonly published: number;
  /** Awaiting phases closed WITHOUT a hand-back by a durable guard. */
  readonly closed: number;
  /** Rows whose reconciliation threw — a partial pass must never be
   * reported as fully reconciled. */
  readonly failed: number;
}

/** The durable round-robin cursor scope the phase sweep persists under. */
const PHASE_RECONCILE_SCOPE = 'phase-handoffs';

/**
 * Bounded boot/sweep reconciliation for phase handoffs — the crash-window
 * backstop, riding the existing recovery coordinator (no timer, no new
 * daemon, no re-dispatch). For each awaiting phase it looks for the
 * correlated completion evidence the live observer may have missed
 * (crash between the delivery commit and the observer write); for each
 * completed phase it finishes the obligation/publication steps. An
 * awaiting phase with no evidence is left exactly where it is: the phase
 * is still live or its own request reconciler owns the escalation.
 */
export function reconcilePhaseHandoffs(
  deps: FollowThroughDeps,
  opts: { pageSize?: number; maxPages?: number } = {},
): PhaseReconcileReport {
  const pageSize = Math.min(Math.max(1, opts.pageSize ?? 200), 1000);
  const maxPages = Math.min(Math.max(1, opts.maxPages ?? 20), 1000);
  let examined = 0;
  let completed = 0;
  let published = 0;
  let closed = 0;
  let failed = 0;
  // Durable round-robin cursor (PR136 r4 blocker 3). A pass reads only
  // ACTIONABLE rows — awaiting intents and completed rows missing their
  // obligation/card — so satisfied publication history never consumes its
  // budget. When a pass exhausts its page budget it persists the last
  // examined rowid, so the next pass continues past that prefix instead of
  // re-reading it; a pass that reaches the end resets to the first row.
  // Every actionable row is therefore examined within a bounded number of
  // passes, however many published rows precede it.
  let cursor = deps.ledger.readReconcileCursor(PHASE_RECONCILE_SCOPE) ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
  let lastRowid: number | null = null;
  let reachedEnd = false;
  for (let page = 0; page < maxPages; page += 1) {
    const rows = deps.ledger.listPhaseHandoffs({
      needsAction: true,
      limit: pageSize,
      ...(cursor > 0 ? { cursor } : {}),
    });
    if (rows.length === 0) {
      reachedEnd = true;
      break;
    }
    for (const listed of rows) {
      examined += 1;
      try {
        reconcileOnePhase(deps, listed.phaseId, (bump) => {
          if (bump === 'completed') completed += 1;
          if (bump === 'published') published += 1;
          if (bump === 'closed') closed += 1;
        });
      } catch (error) {
        // One malformed/conflicting row stays VISIBLE and never takes the
        // boot pass down: the next boot retries it from durable state.
        failed += 1;
        deps.log?.('error', 'phase handoff reconciliation row failed', {
          phase: listed.phaseId,
          error: String(error),
        });
      }
    }
    const last = rows[rows.length - 1];
    lastRowid = last === undefined ? null : (deps.ledger.phaseHandoffRowid(last.phaseId) ?? null);
    if (rows.length < pageSize) {
      reachedEnd = true; // the factual tail — the next pass starts over
      break;
    }
    if (lastRowid === null) {
      // A row that cannot produce its rowid is a durable inconsistency:
      // stop the pass loudly, keep the previous cursor (no silent loop).
      deps.log?.('error', 'phase handoff cursor could not advance — pass stopped', {
        phase: last?.phaseId ?? null,
      });
      break;
    }
    cursor = lastRowid;
  }
  if (reachedEnd) {
    if (cursor !== 0) deps.ledger.writeReconcileCursor({ scope: PHASE_RECONCILE_SCOPE, cursor: 0 });
  } else if (lastRowid !== null) {
    deps.ledger.writeReconcileCursor({ scope: PHASE_RECONCILE_SCOPE, cursor: lastRowid });
  }
  return { examined, completed, published, closed, failed };
}

/** Reconcile one phase; the counter bumps are reported to the caller. */
function reconcileOnePhase(
  deps: FollowThroughDeps,
  phaseId: string,
  bump: (counter: 'completed' | 'published' | 'closed') => void,
): void {
  // Re-read: a previous iteration may have advanced this row; a replay
  // must always act on current durable state.
  const phase = deps.ledger.getPhaseHandoff(phaseId);
  if (phase === null) return;
  if (phase.state === 'awaiting') {
    const evidence = findPhaseCompletionEvent(deps.ledger, phase);
    if (evidence !== null) {
      const before = phase.notificationId;
      const result = settlePhaseCompletion(deps, phase, evidence);
      if (result !== null) {
        if (result.created) bump('completed');
        if (result.notificationId !== null && before === null) bump('published');
        if (result.closed) bump('closed');
      }
      return;
    }
    // No completion evidence: a terminal job can never complete, so
    // close the stale intent (no hand-back — the lane is finished).
    const job = deps.ledger.getJob(phase.jobId);
    if (job !== null && (job.status === 'done' || job.status === 'merged')) {
      deps.ledger.closePhaseHandoff({
        phaseId: phase.phaseId,
        reason: `job reached ${job.status} with no completion evidence`,
      });
      bump('closed');
    }
    return;
  }
  // completed: finish the obligation/publication steps (crash windows).
  const before = phase.notificationId;
  const result = finishPhaseHandoff(deps, phase, false);
  if (result !== null && result.notificationId !== null && before === null) bump('published');
  if (result !== null && result.closed && phase.state === 'completed') bump('closed');
}
