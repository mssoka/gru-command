/**
 * Worktree port (Perkins r4 split; contract hardened r5): the E8 core
 * (roles, dispatch flow, wave runner, Bob) depends on THIS interface
 * only — the worktree manager implementation lands as its own lane (see
 * docs/WORKTREES.md on that lane). Structural by design: the manager's
 * records and sweep results satisfy this port without importing it.
 *
 * ## PORT CONTRACT (binding on every implementation — pinned by
 * ## test/helpers/worktree-port-contract.ts, which the manager lane runs
 * ## against its real implementation)
 *
 * - **Lane ids ARE owner ids** (the registry's primary key): a `job`
 *   lane's `id` is the owning JOB id; a `review` lane's `id` is the
 *   owning ROUND id. One live lane per owner. `release()` and
 *   `getWorktree()` key on exactly these ids.
 * - **Discovery is by job scope, never by id guessing**:
 *   `listWorktrees({ jobId })` returns the job's job-lane AND its linked
 *   review lanes. Consumers select by `kind`.
 * - **Status values** are exactly 'active' | 'paused' | 'swept':
 *   creation yields 'active'; a successful release yields 'swept'
 *   (idempotent on repeat); 'paused' only ever carries a recorded ask.
 * - **Registry paths only**: releasing an unknown id REJECTS; nothing is
 *   swept that was not registered.
 * - **Lanes are real directories**: `path` exists while the lane is
 *   live and is removed by the release that sweeps it.
 */

/** One managed worktree lane (registry shape, ruling 18b). */
export interface WorktreeLane {
  /** The owning job id (kind 'job') or round id (kind 'review'). */
  readonly id: string;
  readonly kind: 'job' | 'review';
  readonly repoPath: string;
  readonly repoName: string;
  readonly path: string;
  readonly branch: string | null;
  readonly sha: string;
  readonly jobId: string | null;
  readonly roundId: string | null;
  readonly status: 'active' | 'paused' | 'swept';
}

/** A process a sweep paused on (the ask's evidence). */
export interface WorktreeProcessEvidence {
  readonly pid: number;
  readonly command: string;
  readonly evidence: string;
}

export interface WorktreeSweepPaused {
  readonly status: 'paused';
  readonly processes: readonly WorktreeProcessEvidence[];
  readonly preserved: { count: number; destination: string } | null;
  readonly note: string;
}

export interface WorktreeSweepSwept {
  readonly status: 'swept';
  readonly preserved: { count: number; destination: string } | null;
  readonly branch: 'deleted' | 'retained' | 'none';
  readonly freshHead: string;
}

export type WorktreeSweepResult = WorktreeSweepPaused | WorktreeSweepSwept;

/** The worktree subsystem the dispatch flow rides on. */
export interface WorktreePort {
  createJobWorktree(input: { repoPath: string; jobId: string }): Promise<WorktreeLane>;
  createReviewWorktree(input: {
    repoPath: string;
    roundId: string;
    ref: string;
    jobId?: string;
  }): Promise<WorktreeLane>;
  getWorktree(id: string): WorktreeLane | null;
  listWorktrees(opts?: { jobId?: string }): readonly WorktreeLane[];
  release(input: { worktreeId: string; confirmKill?: boolean; baseBranch?: string }): Promise<WorktreeSweepResult>;
}

export const WORKTREE_PORT_UNAVAILABLE =
  'worktree manager lane is not installed — dispatch worktrees unavailable ' +
  '(the worktree-manager lane provides the implementation; wire it in main.ts)';

/**
 * Fail-loud stand-in while the manager lane is unmerged (core-only boot).
 * EVERY method surfaces the unavailability — reads included (Perkins r5
 * B3): a null lane or an empty list here would be indistinguishable
 * from "no lanes" and would misdiagnose downstream ("no worktree in the
 * registry") instead of naming the missing subsystem.
 */
export class UnavailableWorktreePort implements WorktreePort {
  async createJobWorktree(): Promise<WorktreeLane> {
    throw new Error(WORKTREE_PORT_UNAVAILABLE);
  }
  async createReviewWorktree(): Promise<WorktreeLane> {
    throw new Error(WORKTREE_PORT_UNAVAILABLE);
  }
  getWorktree(_id: string): WorktreeLane | null {
    throw new Error(WORKTREE_PORT_UNAVAILABLE);
  }
  listWorktrees(_opts?: { jobId?: string }): readonly WorktreeLane[] {
    throw new Error(WORKTREE_PORT_UNAVAILABLE);
  }
  async release(): Promise<WorktreeSweepResult> {
    throw new Error(WORKTREE_PORT_UNAVAILABLE);
  }
}
