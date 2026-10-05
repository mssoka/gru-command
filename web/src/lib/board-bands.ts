/**
 * Attention-bucketed job ordering (board UX v4): the board answers WHAT
 * TO DO NEXT, not what happened last. Bands, in order:
 *
 *   1 NEEDS GRU  — unacked action-required, blocked/error, PR conflicting,
 *                  aborted review, failed lenses in the newest round —
 *                  review-history causes apply only to work that is
 *                  still open: a concluded merged/done job earns NO
 *                  NEEDS GRU causes at all (closed receipt)
 *   2 IN FLIGHT  — dispatched, fresh working, in-review
 *   3 SETTLED    — delivered, merged today
 *   4 COLD       — stalled working (30 min, Silas's default threshold),
 *                  parked, done, old merged
 *
 * Recency orders within a band. The bucketer is pure and deterministic so
 * every status × freshness × PR-state combination is unit-testable.
 */

import {
  agentActivityOf,
  agentRuntimeOf,
  isJobConcluded,
  type AgentView,
  type BoardSnapshot,
  type JobView,
} from './board-protocol.js';
import { derivedPrState } from './board-kpi.js';
import { isSameLocalDay } from './board-time.js';

export type BandId = 'needs-you' | 'in-flight' | 'settled' | 'cold';

/** Stalled demoter threshold: a working lane with no frames for this long
 * sinks to COLD with a stale flag. Matches Silas's default
 * `stall_threshold_ms` (1_800_000) — one number for the whole system. */
export const JOB_STALLED_AFTER_MS = 30 * 60_000;

export const BAND_ORDER: readonly BandId[] = ['needs-you', 'in-flight', 'settled', 'cold'];

export const BAND_LABELS: Readonly<Record<BandId, string>> = {
  // Display label only (owner approval j-1064): the internal band id
  // stays `needs-you` (classification unchanged); the operator-facing
  // label is FOR GRU.
  'needs-you': 'FOR GRU',
  'in-flight': 'IN FLIGHT',
  settled: 'SETTLED',
  cold: 'COLD',
};

export interface BandedJob {
  readonly job: JobView;
  readonly band: BandId;
  /** Working lane past the stall window — rendered as a stale flag. */
  readonly stale: boolean;
}

export interface BucketOptions {
  readonly now?: number;
  readonly stalledAfterMs?: number;
  /** Unacked action-required counts per job id (from board-signals). */
  readonly unackedByJob?: ReadonlyMap<string, number>;
  /** Supervision-stopped worker views per job id (from the snapshot's
   * agent rows) — a stopped lane is waiting, never silent-stalled. */
  readonly stoppedWorkers?: ReadonlyMap<string, WorkerStopView>;
  /** The stall clock's floor per job: the newest `lastActivity ?? createdAt`
   * stamp among the lane's LIVE minion workers (from the snapshot's agent
   * rows via `liveWorkerStampsByJob`). Mirrors the digest's worker pool so
   * a re-dispatched lane whose fresh worker has no frames yet is never
   * falsely COLD on the superseded stop's old stamp (A1/E1). */
  readonly liveWorkerStamps?: ReadonlyMap<string, number>;
}

/** The newest frame-ish stamp on the job: agent activity, else the lane's
 * creation, else the record's own last change. */
export function jobRecency(job: JobView): string {
  let newest = job.updatedAt;
  if (job.lastAgentActivity !== null && job.lastAgentActivity > newest) newest = job.lastAgentActivity;
  if (job.lane !== null && job.lane.createdAt > newest) newest = job.lane.createdAt;
  return newest;
}

/** The stop truth for one lane: the lane's bound minion worker is
 * supervision-stopped (or breaker-open). Callers decide whether the lane's
 * status makes the waiting state applicable (the board gates on a working
 * job). */
export interface WorkerStopView {
  /** Failure class the supervisor recorded (e.g. `quota_wall`), null on
   * pre-reason snapshots — the stop renders without a cause. */
  readonly reason: string | null;
  readonly restarts: number;
}

/** Stopped-worker views keyed by job id, from the snapshot's agent rows:
 * the LANE'S WORKER (role `minion`) bound to a job whose supervision is
 * stopped or breaker-open marks the lane. A stopped lane is NOT silently
 * working — it is waiting on a human re-arm with a recorded reason.
 * Review agents (role `perkins`) are bound to the job too, but their
 * stops are workflow-owned (e.g. an aborted isolated attempt with the
 * breaker closed): they belong to the round lifecycle and must never
 * make a working lane read as waiting.
 *
 * The lane's CURRENT worker decides: a live (non-stopped, non-breaker)
 * minion bound to the job clears any older stopped record. An
 * unsupervised worker (null supervision view) is not a supervision
 * stop — it counts as live, so a re-dispatched lane whose fresh worker
 * is unsupervised still never reads "waiting" from its previous
 * worker. A stopped record survives its own disposal (the human Ack
 * must find it to re-arm). A stopped worker marks the lane only when no
 * live (non-stopped, non-breaker, non-disposed) worker is NEWER — or
 * none exists; when several workers are stopped, the NEWEST recorded
 * stop speaks for the lane — by activity stamp when known, else by its
 * createdAt registration order, so a stop recorded before its first
 * frame is never masked by an older known one (A8). A KNOWN live stamp
 * must be strictly older for the stop to win: an unknown live stamp (a
 * fresh worker registered before its first activity — last_activity is
 * NULL) favors the live worker, so a re-dispatched lane never reads
 * waiting from its previous worker. */
export function stoppedWorkersByJob(agents: readonly AgentView[]): Map<string, WorkerStopView> {
  const stopped = new Map<string, { readonly view: WorkerStopView; readonly orderAt: number }>();
  const stopKnownAt = new Map<string, number>();
  // A `null` value means at least one live worker's activity stamp is
  // UNKNOWN; that worker favors live and can never be masked by another
  // worker's finite stamp (code review 2026-10-04).
  const liveAt = new Map<string, number | null>();
  // The waiting decision compares KNOWN stamps only — exactly the
  // digest's rule (last_activity is NULL for a worker that has not
  // spoken yet; a fresh registration must not inherit a stop).
  const stamp = (agent: AgentView): number =>
    agent.lastActivity === null ? Number.NaN : Date.parse(agent.lastActivity);
  // Stop recency: the recorded stop time when the server provides it
  // (code review 2026-10-04), else the last frame. A stop AFTER a later
  // frame still wins the lane's displayed cause.
  const stopStamp = (agent: AgentView): number => {
    const view = agent.supervision;
    if (view !== null && view !== undefined && view.stoppedAt !== null && view.stoppedAt !== undefined) {
      const at = Date.parse(view.stoppedAt);
      if (Number.isFinite(at)) return at;
    }
    return stamp(agent);
  };
  // The DISPLAYED stop is the newest by stop time, else activity, else
  // registration order, so a stop recorded before its first frame is
  // never masked by an older known one (A8).
  const orderStamp = (agent: AgentView): number => {
    const known = stopStamp(agent);
    if (Number.isFinite(known)) return known;
    return agent.createdAt === undefined ? Number.NaN : Date.parse(agent.createdAt);
  };
  const bumpLive = (jobId: string, at: number): void => {
    const existing = liveAt.get(jobId);
    if (existing === undefined) {
      liveAt.set(jobId, Number.isFinite(at) ? at : null);
      return;
    }
    if (existing === null || !Number.isFinite(at)) {
      // An unknown-stamp live worker always favors live; once present it
      // can never be replaced by another worker's finite stamp.
      liveAt.set(jobId, null);
      return;
    }
    if (at > existing) liveAt.set(jobId, at);
  };
  for (const agent of agents) {
    if (agent.jobId === null || agent.role !== 'minion') continue;
    // Issue #171: a VERIFIED-historical record is neither a live worker
    // nor a stop source — it belongs to a previous run/import and must
    // not keep a dead lane warm or mask a current stop. Rows without the
    // classification (pre-upgrade servers) keep the legacy read.
    if (agentRuntimeOf(agent) === 'historical') continue;
    const supervision = agent.supervision;
    if (supervision === null || supervision === undefined) {
      // Unsupervised worker: not a supervision stop. A DISPOSED record is
      // not a live worker either — only a running unsupervised worker can
      // clear a stopped record (final independent review E0).
      if (agent.state === 'disposed') continue;
      bumpLive(agent.jobId, stamp(agent));
      continue;
    }
    if (supervision.state !== 'stopped' && supervision.breakerOpen !== true) {
      // A disposed record is not a live worker whether or not the
      // supervisor still returns a view for it (code review 2026-10-04 A2).
      if (agent.state === 'disposed') continue;
      bumpLive(agent.jobId, stamp(agent));
      continue;
    }
    const view: WorkerStopView = { reason: supervision.stopReason ?? null, restarts: supervision.restarts };
    const known = stopStamp(agent);
    const knownPrior = stopKnownAt.get(agent.jobId);
    if (Number.isFinite(known) && (knownPrior === undefined || known > knownPrior)) {
      stopKnownAt.set(agent.jobId, known);
    }
    const orderAt = orderStamp(agent);
    const existing = stopped.get(agent.jobId);
    if (
      existing === undefined ||
      (Number.isFinite(orderAt) && (!Number.isFinite(existing.orderAt) || orderAt > existing.orderAt))
    ) {
      stopped.set(agent.jobId, { view, orderAt });
    }
  }
  const result = new Map<string, WorkerStopView>();
  for (const [jobId, entry] of stopped) {
    const live = liveAt.get(jobId);
    // No live worker at all → the stop speaks. A live worker with an
    // unknown stamp favors live. Otherwise the newest KNOWN stop stamp
    // must be strictly newer than the newest known live stamp. The
    // comparison uses the newest KNOWN stop stamp across the lane's stops
    // (not the displayed one), so the selected reason can never flip the
    // waiting outcome vs the digest.
    const known = stopKnownAt.get(jobId) ?? Number.NaN;
    const waiting =
      live === undefined ||
      (live !== null && Number.isFinite(known) && Number.isFinite(live) && known > live);
    if (waiting) result.set(jobId, entry.view);
  }
  return result;
}

/** The stall clock's per-job floor: the newest `lastActivity ?? createdAt`
 * stamp among the lane's LIVE minion workers — the same live predicate
 * `stoppedWorkersByJob` uses (and the digest's `lastActivity ?? createdAt`
 * pool). A fresh worker registered before its first frame contributes its
 * createdAt, so a re-dispatched lane is never falsely COLD on the
 * superseded stop's old stamp; without a live worker the caller falls
 * back to the job's own recency fields. */
export function liveWorkerStampsByJob(agents: readonly AgentView[]): Map<string, number> {
  const stamps = new Map<string, number>();
  for (const agent of agents) {
    if (agent.jobId === null || agent.role !== 'minion') continue;
    // Issue #171: a verified-historical minion is not a live worker — its
    // frozen stamp must not keep a superseded lane warm.
    if (agentRuntimeOf(agent) === 'historical') continue;
    const supervision = agent.supervision;
    if (
      supervision !== null &&
      supervision !== undefined &&
      (supervision.state === 'stopped' || supervision.breakerOpen === true)
    ) {
      continue;
    }
    // A disposed record is not a live worker, supervised or not: its
    // registration stamp must not keep a stopped lane warm (code review
    // 2026-10-04 A2).
    if (agent.state === 'disposed') continue;
    // Issue #171: the stall clock prefers the supervision event clock —
    // a long-running turn whose ledger row has not been rewritten still
    // has fresh supervision activity, and the crew rail reads that same
    // clock (the job must not read cold while its worker shows quiet).
    const raw = agentActivityOf(agent) ?? agent.createdAt ?? null;
    if (raw === null) continue;
    const at = Date.parse(raw);
    if (Number.isNaN(at)) continue;
    const existing = stamps.get(agent.jobId);
    if (existing === undefined || at > existing) stamps.set(agent.jobId, at);
  }
  return stamps;
}

/** The status-chip label for a stopped lane: an explicit waiting state
 * with its reason (`quota_wall` → "waiting · quota wall"). */
export function workerStopLabel(stop: WorkerStopView): string {
  const reason = stop.reason === null ? '' : stop.reason.replaceAll('_', ' ').trim();
  return reason === '' ? 'waiting' : `waiting · ${reason}`;
}

/** A working lane that has shown no frames past the stall window. No
 * stamp at all is NOT evidence of stalling — never guess. A lane whose
 * worker is supervision-stopped is not stalled either: the silence has a
 * recorded cause (the stop), and COLD is for genuinely-silent lanes. */
export function isStalledWorking(job: JobView, opts: BucketOptions = {}): boolean {
  if (job.status !== 'working') return false;
  if (opts.stoppedWorkers?.has(job.id) === true) return false;
  const threshold = opts.stalledAfterMs ?? JOB_STALLED_AFTER_MS;
  const recorded = job.lastAgentActivity ?? job.lane?.createdAt ?? null;
  const recordedMs = recorded === null ? null : Date.parse(recorded);
  const workerMs = opts.liveWorkerStamps?.get(job.id) ?? null;
  // The stall clock follows the digest's live-worker pool when one exists
  // (newest live minion `lastActivity ?? createdAt`): a recent frame from
  // a non-minion role can no longer keep a silent minion out of COLD
  // (code review 2026-10-04). With no live worker the lane's own recency
  // still applies, exactly as before.
  const then = workerMs !== null ? workerMs : recordedMs;
  if (then === null || Number.isNaN(then)) return false;
  return (opts.now ?? Date.now()) - then > threshold;
}

/** Every reason a job earns Band 1 (exported for focused tests). A
 * terminal job (merged/done) is a closed receipt: neither stale review
 * history nor leftover current-state rows may promote it back into NEEDS
 * GRU (section-truth ruling 2026-09-29; the earlier 2026-09-26 guard
 * suppressed only review history and still let current-state causes
 * promote a concluded lane). Terminal-bound machine rows are attributed
 * as receipts upstream (unackedByJob), so no live cause remains. */
export function needsYouReasons(job: JobView, unacked: number): readonly string[] {
  if (isJobConcluded(job.status)) return [];
  const reasons: string[] = [];
  if (unacked > 0) reasons.push('action-required');
  if (job.status === 'blocked' || job.status === 'error') reasons.push(job.status);
  if (derivedPrState(job) === 'conflicting') reasons.push('PR conflicting');
  const round = job.rounds.at(-1) ?? null;
  if (round !== null) {
    if (round.status === 'aborted') reasons.push('round aborted');
    else if (round.status !== 'verdict-posted' && round.lenses.some((lens) => lens.state === 'error')) {
      reasons.push('lens failed');
    }
  }
  return reasons;
}

export function jobNeedsYou(job: JobView, unacked: number): boolean {
  return needsYouReasons(job, unacked).length > 0;
}

/** Deterministic band for one job. */
export function bandForJob(job: JobView, opts: BucketOptions = {}): BandId {
  const unacked = opts.unackedByJob?.get(job.id) ?? 0;
  // Cascade promoter: any NEEDS-YOU cause outranks everything else.
  if (jobNeedsYou(job, unacked)) return 'needs-you';
  switch (job.status) {
    case 'dispatched':
    case 'in-review':
      return 'in-flight';
    case 'working':
      return isStalledWorking(job, opts) ? 'cold' : 'in-flight';
    case 'delivered':
      return 'settled';
    case 'merged':
      return isSameLocalDay(job.updatedAt, new Date(opts.now ?? Date.now())) ? 'settled' : 'cold';
    default:
      // parked, done, and anything unknown sink — never outrank live work.
      return 'cold';
  }
}

export interface BandedJobs {
  readonly band: BandId;
  readonly jobs: readonly BandedJob[];
}

/** Bucket one repo's jobs: bands in order, recency (newest first) inside,
 * id as the deterministic tiebreaker. Empty bands are omitted. */
export function bucketJobs(jobs: readonly JobView[], opts: BucketOptions = {}): readonly BandedJobs[] {
  const byBand = new Map<BandId, BandedJob[]>();
  for (const job of jobs) {
    const band = bandForJob(job, opts);
    const entry: BandedJob = { job, band, stale: isStalledWorking(job, opts) };
    const group = byBand.get(band);
    if (group === undefined) byBand.set(band, [entry]);
    else group.push(entry);
  }
  return BAND_ORDER.filter((band) => (byBand.get(band)?.length ?? 0) > 0).map((band) => ({
    band,
    jobs: (byBand.get(band) ?? []).sort(
      (left, right) =>
        jobRecency(right.job).localeCompare(jobRecency(left.job)) || left.job.id.localeCompare(right.job.id),
    ),
  }));
}

/** Bucket a whole snapshot (all repos flattened — a repo's jobs can land
 * in different bands; the UI re-groups by repo inside each band). */
export function bucketSnapshot(snapshot: BoardSnapshot, opts: BucketOptions = {}): readonly BandedJobs[] {
  return bucketJobs(
    snapshot.repos.flatMap((repo) => repo.jobs),
    opts,
  );
}

/** Board UX v5: the SETTLED band is a rolling window — the latest N
 * settled jobs render, the older tail lives behind a "+K older settled"
 * footer (expanded for the session). KPI counts are never capped; only
 * the band's glance is. */
export const SETTLED_WINDOW_SIZE = 10;

export interface SettledWindowView {
  readonly jobs: readonly BandedJob[];
  /** Jobs held back behind the expander (0 = fully shown). */
  readonly hidden: number;
}

/** Slice a recency-sorted settled band (newest first) to the rolling
 * window; `expanded` (or a band at/below the limit) shows everything. */
export function settledWindow(
  jobs: readonly BandedJob[],
  expanded: boolean,
  limit = SETTLED_WINDOW_SIZE,
): SettledWindowView {
  if (expanded || jobs.length <= limit) return { jobs, hidden: 0 };
  const shown = Math.max(0, limit);
  return { jobs: jobs.slice(0, shown), hidden: jobs.length - shown };
}
