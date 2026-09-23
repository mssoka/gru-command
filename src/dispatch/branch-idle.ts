import { spawnSync } from 'node:child_process';
import type { EventRecord, JobRecord } from '../ledger/api.js';
import type { JobStatus } from '../ledger/states.js';
import type { WorktreeLane } from './worktree-port.js';

/**
 * Branch-idle guard (proven 2026-09-23; cost: two wasted review rounds): a
 * review round must not freeze while a lane is actively working/pushing the
 * target branch — the round races the push and dies obsolete (or delivers a
 * verdict on a superseded head).
 *
 * The rule is enforced at the API and at every review-round entry point, so
 * manual calls, the Silas auto-arm path, and integrations all inherit it.
 * A refusal is HTTP 409 `branch_busy` with the blocking lanes named; the
 * `force: true` flag is the human escape hatch, and forced rounds are tagged
 * in the round manifest and the event log.
 *
 * "Busy" means the lane's CURRENT attempt has not delivered: status
 * dispatched/working and no `job.delivered` event newer than the attempt
 * start (the latest `job.status → working` hop). A settled delivery clears
 * busy even while the status still reads working — `delivered` is the
 * review-ready point, and the refusal's own hint says "wait for lane
 * delivery".
 */

export const BRANCH_BUSY_HINT = 'wait for lane delivery or dispatch with force';

/** Statuses whose lane may be mid-flight (dispatched = the lane is about to
 * be created and pushed; working = the attempt is open). */
export const BRANCH_BUSY_STATUSES: readonly JobStatus[] = ['dispatched', 'working'];

/** One lane that owns (or is about to own) the reviewed branch. */
export interface BranchIdleBlocker {
  readonly jobId: string;
  readonly status: JobStatus;
  readonly branch: string;
}

/** The 409 body shape (snake_case: this is the wire contract). */
export interface BranchBusyResponse {
  readonly error: 'branch_busy';
  readonly blockers: readonly { readonly job_id: string; readonly status: JobStatus; readonly branch: string }[];
  readonly hint: string;
}

/** Where the check ran: the arm intake or the freeze (race window close). */
export type BranchIdlePhase = 'arm' | 'freeze';

/** The tag a forced round carries into its frozen manifest. */
export interface BranchIdleTag {
  readonly forced: true;
  readonly targetBranch: string;
  readonly blockers: readonly BranchIdleBlocker[];
}

export function branchBusyPayload(input: {
  readonly targetBranch: string;
  readonly blockers: readonly BranchIdleBlocker[];
}): BranchBusyResponse {
  return {
    error: 'branch_busy',
    blockers: input.blockers.map((blocker) => ({
      job_id: blocker.jobId,
      status: blocker.status,
      branch: blocker.branch,
    })),
    hint: BRANCH_BUSY_HINT,
  };
}

/** The typed refusal every caller maps to 409. */
export class BranchBusyError extends Error {
  readonly targetBranch: string;
  readonly blockers: readonly BranchIdleBlocker[];
  readonly phase: BranchIdlePhase;

  constructor(targetBranch: string, blockers: readonly BranchIdleBlocker[], phase: BranchIdlePhase) {
    super(
      `branch "${targetBranch}" is busy (${blockers
        .map((blocker) => `${blocker.jobId}: ${blocker.status}`)
        .join(', ')}); ${BRANCH_BUSY_HINT}`,
    );
    this.name = 'BranchBusyError';
    this.targetBranch = targetBranch;
    this.blockers = blockers;
    this.phase = phase;
  }

  refusal(): BranchBusyResponse {
    return branchBusyPayload({ targetBranch: this.targetBranch, blockers: this.blockers });
  }
}

/** Ledger surface the guard reads (the real LedgerApi satisfies it). */
export interface BranchIdleLedger {
  listJobs(): readonly JobRecord[];
  latestJobEvent(jobId: string, kind: string): EventRecord | null;
}

/** The branch a job lane is created on (worktree manager convention; also
 * the branch a `dispatched` job is about to create). */
export function laneBranch(jobId: string): string {
  return `gru/${jobId}`;
}

/** Normalize a git ref to the branch name it compares as. `refs/heads/x`
 * and `refs/remotes/<remote>/x` both compare as `x` (the lane pushes a
 * local branch whose remote head carries the same name). */
export function normalizeBranch(ref: string): string {
  const trimmed = ref.trim();
  const heads = /^refs\/heads\/(.+)$/u.exec(trimmed);
  if (heads !== null) return heads[1]!;
  const remotes = /^refs\/remotes\/[^/]+\/(.+)$/u.exec(trimmed);
  if (remotes !== null) return remotes[1]!;
  return trimmed;
}

/** The branch an explicit `target_ref` names; null when it names none (a
 * commit pin, or an unresolvable ref) — the caller then keeps the lane's
 * branch as the concerned branch. */
export function branchNameForRef(repoPath: string | null, ref: string): string | null {
  if (repoPath === null) return null;
  let resolved: string;
  try {
    const result = spawnSync(
      'git',
      ['-C', repoPath, 'rev-parse', '--symbolic-full-name', '--verify', ref],
      { encoding: 'utf-8', timeout: 10_000 },
    );
    if (result.error !== undefined || result.status !== 0) return null;
    resolved = (result.stdout ?? '').trim();
  } catch {
    return null;
  }
  if (!resolved.startsWith('refs/heads/') && !resolved.startsWith('refs/remotes/')) return null;
  return normalizeBranch(resolved);
}

/** Resolve the branch a review request targets: the branch an explicit
 * `target_ref` names, otherwise the job lane's branch (the default review
 * target), otherwise the convention branch the lane is about to create. */
export function resolveReviewTargetBranch(input: {
  readonly jobId: string;
  readonly targetRef?: string | undefined;
  readonly lanePath: string | null;
  readonly laneBranch: string | null;
}): string {
  const explicit =
    input.targetRef !== undefined && input.targetRef.trim() !== ''
      ? branchNameForRef(input.lanePath, input.targetRef)
      : null;
  if (explicit !== null) return explicit;
  if (input.laneBranch !== null && input.laneBranch.trim() !== '') return normalizeBranch(input.laneBranch);
  return laneBranch(input.jobId);
}

/** Seq of the job's latest `job.status → working` hop (0 when the attempt
 * start predates any status event — a `dispatched` job). */
function attemptStartedSeq(ledger: BranchIdleLedger, jobId: string): number {
  const latest = ledger.latestJobEvent(jobId, 'job.status');
  if (latest === null) return 0;
  const payload = latest.payload;
  const to = typeof payload === 'object' && payload !== null ? (payload as { to?: unknown }).to : undefined;
  return to === 'working' ? latest.seq : 0;
}

/** The busy predicate: the attempt is open and has not delivered yet. */
export function laneIsBusy(ledger: BranchIdleLedger, job: JobRecord): boolean {
  if (!BRANCH_BUSY_STATUSES.includes(job.status)) return false;
  const delivered = ledger.latestJobEvent(job.id, 'job.delivered');
  if (delivered === null) return true;
  return delivered.seq <= attemptStartedSeq(ledger, job.id);
}

/** Every busy lane whose branch is the reviewed target. The reviewed job is
 * NOT exempt: its own lane is the primary race — a fix loop re-opened the
 * branch and the arm must wait for that attempt to deliver. A linked PR's
 * head ref is the lane branch by construction (the manager opens every lane
 * on `gru/<jobId>` and the minion pushes that branch), so comparing the
 * recorded lane branch covers both clauses without a code-host call at arm
 * time. A `dispatched` job without a registry row yet compares as the
 * branch it is about to create. */
export function findBusyLanes(input: {
  readonly ledger: BranchIdleLedger;
  readonly lanes: readonly WorktreeLane[];
  readonly targetBranch: string;
  /** Status to evaluate the reviewed job with instead of its live row: the
   * round's own working→in-review flip is bookkeeping and must not mask the
   * lane it moved. */
  readonly reviewedStatus?: { readonly jobId: string; readonly status: JobStatus } | undefined;
}): readonly BranchIdleBlocker[] {
  const target = normalizeBranch(input.targetBranch);
  const blockers: BranchIdleBlocker[] = [];
  for (const job of input.ledger.listJobs()) {
    const status =
      input.reviewedStatus !== undefined && input.reviewedStatus.jobId === job.id
        ? input.reviewedStatus.status
        : job.status;
    if (!laneIsBusy(input.ledger, { ...job, status })) continue;
    const jobLanes = input.lanes.filter((candidate) => candidate.kind === 'job' && candidate.jobId === job.id);
    const lane = jobLanes.find((candidate) => candidate.status !== 'swept') ?? jobLanes[0];
    const branch =
      lane !== undefined && lane.branch !== null && lane.branch.trim() !== ''
        ? normalizeBranch(lane.branch)
        : laneBranch(job.id);
    if (branch !== target) continue;
    blockers.push({ jobId: job.id, status, branch });
  }
  return blockers;
}
