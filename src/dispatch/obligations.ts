import type { BusEvent } from '../events/bus.js';
import type { LedgerApi } from '../ledger/api.js';
import type { LogLevel } from '../logger.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Dispatch-side follow-through observers (phase 3 slice). Pure wiring on
 * the existing event bus, ledger primitives and the existing single Gru
 * wake path (`NotificationCenter.postIncident` → awareness notify_wake).
 * No scheduler, no timer, no second wake path, no execution: these
 * observers only record debt and route attention.
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
  }): unknown;
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
}

/**
 * Observe a settled follow-up delivery (`job.delivered` with a Silas
 * source). When the lane is STILL blocked after the phase completed, the
 * next decision is owed durably: the same-head case (no head move is
 * fine) records one phase-completion obligation and ONE action-required
 * Gru hand-back on the existing wake path. Replays of the same delivered
 * event coalesce (the obligation identity carries the event seq; the
 * notification dedupes until acked). A delivery on a lane that is not
 * blocked is the normal review flow — nothing is recorded here.
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
  const source = typeof payload['source'] === 'string' ? payload['source'] : null;
  if (source === null || !FOLLOW_UP_SOURCES.has(source)) return null;
  const job = deps.ledger.getJob(event.jobId);
  if (job === null) return null;
  if (job.status !== 'blocked') return null; // normal flow — review/digest owns it

  const sha = typeof payload['sha'] === 'string' && payload['sha'] !== '' ? payload['sha'] : null;
  // Identity carries the delivered event seq: a distinct phase completion
  // is a distinct hand-back; a replay of the same event coalesces onto
  // the same obligation and the same notification (dedupe 'unacked').
  const incidentKey = `phase-handback@${event.seq}`;
  const before = deps.ledger
    .listObligations({ jobId: event.jobId })
    .find((row) => row.incidentKey === incidentKey && row.state !== 'settled' && row.state !== 'closed');
  const obligation = deps.ledger.recordBlockedObservation(event.jobId, {
    logicalStep: 'operation',
    category: { kind: 'known', category: 'phase-completion' },
    incidentKey,
    observedAtSeq: event.seq,
    description:
      `bounded ${source} phase completed while the lane remains blocked ` +
      `(delivered event ${event.seq}${sha === null ? '' : `, head ${sha}`})`,
    dueAt: null,
  });
  const notificationKind = `silas.phase-handback.${event.jobId}@${event.seq}`;
  deps.notifications.postIncident({
    kind: notificationKind,
    routing: 'action-required',
    severity: 'info',
    title: `Phase completed on blocked job ${event.jobId} — ruling requested`,
    detail:
      `A bounded ${source} phase settled` +
      `${sha === null ? '' : ` (head ${sha})`}` +
      ` but the lane is still blocked. The obligation ${obligation.id} durably owes the next Gru ` +
      'ruling (same head is evidence, not approval). No owner prompting is required; this row is ' +
      'the machine hand-back.',
    dedupe: 'unacked',
  });
  deps.log?.('info', 'follow-through hand-back recorded', {
    job: event.jobId,
    obligation: obligation.id,
    notification_kind: notificationKind,
    delivered_seq: event.seq,
  });
  return {
    jobId: event.jobId,
    obligationId: obligation.id,
    notificationKind,
    created: before === undefined,
  };
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
 * them. Bounded per pass.
 */
export function adoptBlockedLanes(deps: FollowThroughDeps, opts: { limit?: number } = {}): AdoptionReport {
  const limit = Math.min(Math.max(1, opts.limit ?? 500), 2000);
  const blocked = deps.ledger
    .listJobs()
    .filter((job) => job.status === 'blocked')
    .slice(0, limit);
  let adopted = 0;
  for (const job of blocked) {
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
  return { scanned: blocked.length, adopted };
}
