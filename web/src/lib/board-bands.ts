/**
 * Attention-bucketed job ordering (board UX v4): the board answers WHAT
 * TO DO NEXT, not what happened last. Bands, in order:
 *
 *   1 NEEDS YOU  — unacked action-required, blocked/error, PR conflicting,
 *                  aborted review, failed lenses in the newest round
 *   2 IN FLIGHT  — dispatched, fresh working, in-review
 *   3 SETTLED    — delivered, merged today
 *   4 COLD       — stalled working (30 min, Silas's default threshold),
 *                  parked, done, old merged
 *
 * Recency orders within a band. The bucketer is pure and deterministic so
 * every status × freshness × PR-state combination is unit-testable.
 */

import type { BoardSnapshot, JobView } from './board-protocol.js';
import { derivedPrState } from './board-kpi.js';
import { isSameLocalDay } from './board-time.js';

export type BandId = 'needs-you' | 'in-flight' | 'settled' | 'cold';

/** Stalled demoter threshold: a working lane with no frames for this long
 * sinks to COLD with a stale flag. Matches Silas's default
 * `stall_threshold_ms` (1_800_000) — one number for the whole system. */
export const JOB_STALLED_AFTER_MS = 30 * 60_000;

export const BAND_ORDER: readonly BandId[] = ['needs-you', 'in-flight', 'settled', 'cold'];

export const BAND_LABELS: Readonly<Record<BandId, string>> = {
  'needs-you': 'NEEDS YOU',
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
}

/** The newest frame-ish stamp on the job: agent activity, else the lane's
 * creation, else the record's own last change. */
export function jobRecency(job: JobView): string {
  let newest = job.updatedAt;
  if (job.lastAgentActivity !== null && job.lastAgentActivity > newest) newest = job.lastAgentActivity;
  if (job.lane !== null && job.lane.createdAt > newest) newest = job.lane.createdAt;
  return newest;
}

/** A working lane that has shown no frames past the stall window. No
 * stamp at all is NOT evidence of stalling — never guess. */
export function isStalledWorking(job: JobView, opts: BucketOptions = {}): boolean {
  if (job.status !== 'working') return false;
  const threshold = opts.stalledAfterMs ?? JOB_STALLED_AFTER_MS;
  const stamp = job.lastAgentActivity ?? job.lane?.createdAt ?? null;
  if (stamp === null) return false;
  const then = Date.parse(stamp);
  if (Number.isNaN(then)) return false;
  return (opts.now ?? Date.now()) - then > threshold;
}

/** Every reason a job earns Band 1 (exported for focused tests). */
export function needsYouReasons(job: JobView, unacked: number): readonly string[] {
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
