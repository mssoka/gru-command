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
 *   review lanes — and NOTHING ELSE (a foreign job's lane never leaks
 *   into a scoped list; pinned by exclusion in the contract suite).
 *   Consumers select by `kind`.
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
  /** The owning job id (kind 'job'), round id (kind 'review'), or child
   * agent id (kind 'child'). */
  readonly id: string;
  readonly kind: 'job' | 'review' | 'child';
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

import type { WorktreeBaseSource } from '../ledger/api.js';
import type { LoadedPreBootstrapPatch } from '../worktrees/prebootstrap-patch.js';

/** Read-only identity of the original retained creation, never its raw token. */
export interface RetainedJobCreationInspection {
  readonly jobId: string;
  readonly repoPath: string;
  readonly branch: string;
  readonly sha: string;
  readonly baseSource: WorktreeBaseSource;
  readonly receiptTokenSha256: string;
  readonly producerSettlementSeq: number;
}

/** The worktree subsystem the dispatch flow rides on. */
export interface WorktreePort {
  /** Resolve a review target exactly as `createReviewWorktree` would:
   * an origin tracking ref is FETCHED fresh first and REFUSES when the
   * fetch fails (a stale review is a wrong review); every other ref —
   * explicit commit pins, tags, lane branches — pins exactly. The
   * freeze path resolves through this so a round's frozen identity and
   * its checked-out bytes come from ONE fetch-aware resolution
   * (Perkins blocker: non-PR origin refs were frozen from the stale
   * local tracking sha before the manager could fetch). */
  resolveReviewTarget(input: { repoPath: string; ref: string }): Promise<{
    readonly sha: string;
    readonly baseSource: WorktreeBaseSource | null;
    /** Exact fetched tracking identity; null for intentional local pins. */
    readonly trackingRef: string | null;
  }>;
  createJobWorktree(input: { repoPath: string; jobId: string }): Promise<WorktreeLane>;
  /** Optional explicit capability: an implementation must apply the admitted
   * package inside its owned lane and finish unchanged setup before returning.
   * The lane keeps its creation receipt until completePreBootstrapWorkerAdmission. */
  createJobWorktreeWithPreBootstrapPatch?(input: { repoPath: string; jobId: string; preBootstrapPatch: LoadedPreBootstrapPatch }): Promise<WorktreeLane>;
  /** Spends a patched lane's creation receipt once dispatch recorded its
   * worker (`job.minion-spawned`); every earlier failure keeps it. */
  completePreBootstrapWorkerAdmission?(input: { repoPath: string; jobId: string }): void;
  /** Strict same-job continuation only: inspection is read-only and the
   * create method refuses absent receipts/refs instead of resolving a base,
   * and any receipt other than the one the continuation accepted. */
  inspectRetainedJobCreation?(input: { readonly repoPath: string; readonly jobId: string }): Promise<RetainedJobCreationInspection>;
  createRetainedJobWorktree?(input: {
    readonly repoPath: string;
    readonly jobId: string;
    readonly expected: { readonly receiptTokenSha256: string; readonly producerSettlementSeq: number };
    /** Called once every check passed, before the first checkout work. */
    readonly adopting?: () => void;
  }): Promise<WorktreeLane>;
  createReviewWorktree(input: {
    repoPath: string;
    roundId: string;
    ref: string;
    jobId?: string;
  }): Promise<WorktreeLane>;
  /** Issue #161: a child worker's own lane. `read-only` children get a
   * detached lane at the parent lane's current HEAD (frozen committed
   * bytes, no branch); `writer` children get their own branch
   * `gru/<jobId>-child-<childId>` based at the same HEAD, so a child
   * never mutates the parent's working tree implicitly. */
  createChildWorktree(input: {
    repoPath: string;
    jobId: string;
    childId: string;
    /** The parent's live lane path — the child's base HEAD. */
    parentPath: string;
    authority: 'read-only' | 'writer';
  }): Promise<WorktreeLane>;
  getWorktree(id: string): WorktreeLane | null;
  listWorktrees(opts?: { jobId?: string }): readonly WorktreeLane[];
  release(input: {
    worktreeId: string;
    confirmKill?: boolean;
    baseBranch?: string;
    /** Issue #243 F-H1: an unattended release proves fresh required
     * containment before any forced removal (uncommitted work is
     * snapshotted by every release since #427, never refused). The port
     * carries no submodule discard: only an operator release may pass one. */
    requireReleaseProofs?: boolean;
  }): Promise<WorktreeSweepResult>;
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
  async resolveReviewTarget(): Promise<{ readonly sha: string; readonly baseSource: WorktreeBaseSource | null; readonly trackingRef: string | null }> {
    throw new Error(WORKTREE_PORT_UNAVAILABLE);
  }
  async createJobWorktree(): Promise<WorktreeLane> {
    throw new Error(WORKTREE_PORT_UNAVAILABLE);
  }
  async createJobWorktreeWithPreBootstrapPatch(): Promise<WorktreeLane> {
    throw new Error(WORKTREE_PORT_UNAVAILABLE);
  }
  completePreBootstrapWorkerAdmission(): void {
    throw new Error(WORKTREE_PORT_UNAVAILABLE);
  }
  async createReviewWorktree(): Promise<WorktreeLane> {
    throw new Error(WORKTREE_PORT_UNAVAILABLE);
  }
  async createChildWorktree(): Promise<WorktreeLane> {
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
