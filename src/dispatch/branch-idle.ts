import { spawnSync } from 'node:child_process';
import type { EventRecord, JobRecord, PendingRebriefRecord } from '../ledger/api.js';
import { isJobTerminal, type JobStatus } from '../ledger/states.js';
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
 * "Busy" means either:
 *
 * 1. the lane's CURRENT attempt has not delivered: status
 *    dispatched/working/in-review and no `job.delivered` event newer than
 *    the attempt start. The attempt starts at the newest `working` hop —
 *    or, when a PR link flips an OPEN attempt to `in-review` before it
 *    settles, at that flip itself. A settled delivery clears busy even
 *    while the status still reads working or in-review (`delivered` is
 *    the review-ready point, and the refusal's own hint says "wait for lane
 *    delivery"); a `delivered → in-review` flip starts nothing; or
 * 2. the job has an UNRESOLVED re-brief request: any durable pending marker
 *    (`pending_rebriefs`) means target-owned work is in flight — the
 *    re-brief worker's open turn, or a restart-recovered request not yet
 *    reconciled. A status flip to delivered/in-review and a late
 *    `job.delivered` from the pre-re-brief worker cannot clear a newer
 *    request; the marker clears only when the request genuinely settles
 *    (`finalizeRebriefRequest` / boot reconciliation).
 *
 * Terminal (`merged`/`done`) jobs are never busy: a stale marker left on a
 * terminal job must not block an unrelated review or resurrect the job.
 */

export const BRANCH_BUSY_HINT = 'wait for lane delivery or re-brief request settlement, or dispatch with force';

/** Statuses whose lane may be mid-flight (dispatched = the lane is about to
 * be created and pushed; working = the attempt is open; in-review = a PR
 * link can land mid-attempt before delivery). */
export const BRANCH_BUSY_STATUSES: readonly JobStatus[] = ['dispatched', 'working', 'in-review'];

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
  /** Newest-first bounded history; the guard pages back to the `working`
   * hop behind an `in-review` flip. */
  listJobEvents(jobId: string, opts?: { readonly limit?: number }): readonly EventRecord[];
  /** Durable re-brief markers; any row for a job is an unresolved
   * target-owned request (presence is the fact — see laneIsBusy). */
  listPendingRebriefs(opts?: { readonly jobId?: string }): readonly PendingRebriefRecord[];
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

/** The status event immediately before `flipSeq`. A `working → in-review`
 * flip can only follow the `working` hop that started the attempt, so the
 * newest older status event IS that hop. Paged because the ledger exposes
 * only a limit-bounded newest-first window. */
function previousStatusSeq(ledger: BranchIdleLedger, jobId: string, flipSeq: number): number | null {
  let limit = 200;
  for (;;) {
    const events = ledger.listJobEvents(jobId, { limit });
    const previous = events.find((event) => event.seq < flipSeq && event.kind === 'job.status');
    if (previous !== undefined) return previous.seq;
    // Fewer rows than requested means the history is exhausted.
    if (events.length < limit || limit >= 12_800) return null;
    limit *= 4;
  }
}

/** Seq of the job's current attempt start (0 when none is open). The
 * start is the newest `job.status → working` hop, or — when a PR link
 * moves the job to `in-review` BEFORE its turn settles — the `working` hop
 * immediately behind that flip: the flip belongs to the still-open
 * attempt, not the absence of one. A `delivered → in-review` flip starts
 * nothing. Every other latest-status shape starts nothing. */
export function openAttemptStartSeq(ledger: BranchIdleLedger, jobId: string): number {
  const latest = ledger.latestJobEvent(jobId, 'job.status');
  if (latest === null) return 0;
  const payload = typeof latest.payload === 'object' && latest.payload !== null
    ? (latest.payload as { from?: unknown; to?: unknown })
    : {};
  if (payload.to === 'working') return latest.seq;
  if (payload.to === 'in-review' && payload.from === 'working') {
    const hop = previousStatusSeq(ledger, jobId, latest.seq);
    if (hop !== null) return hop;
    // The status history is unreachable past the page cap. A delivery newer
    // than the flip settles the attempt the flip belongs to, so the lane
    // clears; otherwise fail closed and treat the attempt as open (a later
    // delivery clears it — never a permanent busy).
    const delivered = ledger.latestJobEvent(jobId, 'job.delivered');
    return delivered !== null && delivered.seq > latest.seq ? 0 : Number.MAX_SAFE_INTEGER;
  }
  return 0;
}

/** Newest explicit repair start that need not flip status: an admitted
 * directive turn (`silas.directive-sent`) or a claimed provider
 * continuation (`provider.recovery-claimed`). The digest's stalled-phase
 * detector reads the same events; review admission must not arm on a head
 * whose repair is still open (issue #162). */
function latestRepairStartSeq(ledger: Pick<BranchIdleLedger, 'latestJobEvent'>, jobId: string): number {
  let newest = 0;
  for (const kind of ['silas.directive-sent', 'provider.recovery-claimed']) {
    const event = ledger.latestJobEvent(jobId, kind);
    if (event !== null && event.seq > newest) newest = event.seq;
  }
  return newest;
}

/** The busy predicate: the attempt is open and has not delivered yet, or a
 * newer re-brief request is still unresolved. */
export function laneIsBusy(ledger: BranchIdleLedger, job: JobRecord): boolean {
  // Terminal lanes are never busy: the marker retirement lane owns stale
  // terminal markers, and they must not block anything in the meantime.
  if (isJobTerminal(job.status)) return false;
  // An unresolved re-brief fences the lane regardless of delivery or status:
  // the worker's turn may push a new head after this check. Deliberately
  // presence-based — a late delivery event from the previous worker cannot
  // answer a newer request, so it must not release this fence.
  if (ledger.listPendingRebriefs({ jobId: job.id }).length > 0) return true;
  if (!BRANCH_BUSY_STATUSES.includes(job.status)) return false;
  const delivered = ledger.latestJobEvent(job.id, 'job.delivered');
  if (delivered === null) return true;
  if (delivered.seq <= openAttemptStartSeq(ledger, job.id)) return true;
  // A repair admitted after the delivery keeps the lane busy even when no
  // status hop recorded it (fallback-review flows stay `working`).
  return delivered.seq <= latestRepairStartSeq(ledger, job.id);
}

/** Every busy lane whose branch is the reviewed target. The reviewed job is
 * NOT exempt: its own lane is the primary race — a fix loop re-opened the
 * branch and the arm must wait for that attempt to deliver. A linked PR's
 * head ref is the lane branch ONLY when the lane follows the manager's
 * push discipline (open on `gru/<jobId>`, push that branch). A rebase or
 * salvage lane that checks out its own branch and pushes a FOREIGN PR
 * branch is not detectable from the registry today (g25/#121): the guard
 * compares recorded lane branches, and no declared push target exists. A
 * `dispatched` job without a registry row yet compares as the branch it is
 * about to create. Terminal jobs are never busy. */
export function findBusyLanes(input: {
  readonly ledger: BranchIdleLedger;
  readonly lanes: readonly WorktreeLane[];
  readonly targetBranch: string;
  /** Status to evaluate the reviewed job with instead of its live row: the
   * round's own working→in-review flip is bookkeeping and must not mask the
   * lane it moved. The attempt start resolves from the ledger's status
   * history, so the flip itself never counts as an open attempt. */
  readonly reviewedStatus?: { readonly jobId: string; readonly status: JobStatus } | undefined;
}): readonly BranchIdleBlocker[] {
  const target = normalizeBranch(input.targetBranch);
  const blockers: BranchIdleBlocker[] = [];
  for (const job of input.ledger.listJobs()) {
    // A historical pre-review status is only valid while the job is still
    // nonterminal. A concurrent done/merged transition is authoritative.
    if (isJobTerminal(job.status)) continue;
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
