/**
 * Worktree port (Perkins r4 / Gru split ruling): the E8 core (roles,
 * dispatch flow, wave runner, Bob) depends on THIS interface only — the
 * worktree manager implementation lands as its own lane (see
 * docs/WORKTREES.md on that lane). Structural by design: the manager's
 * records and sweep results satisfy this port without importing it.
 */

/** One managed worktree lane (registry shape, ruling 18b). */
export interface WorktreeLane {
  readonly id: string;
  readonly kind: 'job' | 'review';
  readonly repoPath: string;
  readonly repoName: string;
  readonly path: string;
  readonly branch: string | null;
  readonly sha: string;
  readonly jobId: string | null;
  readonly roundId: string | null;
  readonly status: string;
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

/** Fail-loud stand-in while the manager lane is unmerged (core-only boot). */
export class UnavailableWorktreePort implements WorktreePort {
  async createJobWorktree(): Promise<WorktreeLane> {
    throw new Error(WORKTREE_PORT_UNAVAILABLE);
  }
  async createReviewWorktree(): Promise<WorktreeLane> {
    throw new Error(WORKTREE_PORT_UNAVAILABLE);
  }
  getWorktree(): WorktreeLane | null {
    return null;
  }
  listWorktrees(): readonly WorktreeLane[] {
    return [];
  }
  async release(): Promise<WorktreeSweepResult> {
    throw new Error(WORKTREE_PORT_UNAVAILABLE);
  }
}
