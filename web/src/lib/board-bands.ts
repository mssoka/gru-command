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

import { isJobConcluded, type AgentView, type BoardSnapshot, type JobView } from './board-protocol.js';
import { derivedPrState } from './board-kpi.js';
import { isSameLocalDay } from './board-time.js';

export type BandId = 'needs-you' | 'in-flight' | 'settled' | 'cold';

/** Stalled demoter threshold: a working lane with no frames for this long
 * sinks to COLD with a stale flag. Matches Silas's default
 * `stall_threshold_ms` (1_800_000) — one number for the whole system. */
export const JOB_STALLED_AFTER_MS = 30 * 60_000;

export const BAND_ORDER: readonly BandId[] = ['needs-you', 'in-flight', 'settled', 'cold'];

export const BAND_LABELS: Readonly<Record<BandId, string>> = {
  'needs-you': 'NEEDS GRU',
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
 * must find it to re-arm). Only when no live worker remains does a stop
 * mark the lane; when several workers are stopped, the NEWEST recorded
 * stop (by lastActivity) speaks for the lane — a superseded worker's
 * cause never masquerades as the current one. Ties keep snapshot order. */
export function stoppedWorkersByJob(agents: readonly AgentView[]): Map<string, WorkerStopView> {
  const stopped = new Map<string, { readonly view: WorkerStopView; readonly at: number }>();
  const liveJobs = new Set<string>();
  for (const agent of agents) {
    if (agent.jobId === null || agent.role !== 'minion') continue;
    const supervision = agent.supervision;
    if (supervision === null || supervision === undefined) {
      // Unsupervised worker: not a supervision stop. A DISPOSED record is
      // not a live worker either — only a running unsupervised worker
      // clears an older stopped record (final independent review E0).
      if (agent.state === 'disposed') continue;
      liveJobs.add(agent.jobId);
      continue;
    }
    if (supervision.state !== 'stopped' && supervision.breakerOpen !== true) {
      liveJobs.add(agent.jobId);
      continue;
    }
    const view: WorkerStopView = { reason: supervision.stopReason ?? null, restarts: supervision.restarts };
    const at = agent.lastActivity === null ? Number.NaN : Date.parse(agent.lastActivity);
    const existing = stopped.get(agent.jobId);
    if (existing === undefined || (Number.isFinite(at) && (!Number.isFinite(existing.at) || at > existing.at))) {
      stopped.set(agent.jobId, { view, at });
    }
  }
  for (const jobId of liveJobs) stopped.delete(jobId);
  const result = new Map<string, WorkerStopView>();
  for (const [jobId, entry] of stopped) result.set(jobId, entry.view);
  return result;
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
  const stamp = job.lastAgentActivity ?? job.lane?.createdAt ?? null;
  if (stamp === null) return false;
  const then = Date.parse(stamp);
  if (Number.isNaN(then)) return false;
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
