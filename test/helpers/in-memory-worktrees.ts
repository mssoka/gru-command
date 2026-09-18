import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { WorktreeLane, WorktreePort, WorktreeSweepResult } from '../../src/dispatch/worktree-port.js';

/**
 * In-memory worktree port (test double for the E8 CORE suites — the real
 * manager is its own lane). Lanes are REAL directories (agents need a cwd)
 * but no git: the core's joins under test are spawn/prompt/board joins,
 * not git mechanics — those live on the manager lane.
 */

export class InMemoryWorktreePort implements WorktreePort {
  readonly root: string;
  private readonly lanes = new Map<string, WorktreeLane>();
  private n = 0;

  constructor(root: string) {
    this.root = root;
  }

  async createJobWorktree(input: { repoPath: string; jobId: string }): Promise<WorktreeLane> {
    return this.create('job', input.repoPath, input.jobId, input.jobId, null, `gru/${input.jobId}`, 'sha-job');
  }

  async createReviewWorktree(input: {
    repoPath: string;
    roundId: string;
    ref: string;
    jobId?: string;
  }): Promise<WorktreeLane> {
    return this.create(
      'review',
      input.repoPath,
      input.roundId,
      input.jobId ?? null,
      input.roundId,
      null,
      `sha-${input.ref}`,
    );
  }

  private create(
    kind: 'job' | 'review',
    repoPath: string,
    id: string,
    jobId: string | null,
    roundId: string | null,
    branch: string | null,
    sha: string,
  ): WorktreeLane {
    if (this.lanes.has(id)) throw new Error(`worktree "${id}" already exists`);
    const repoName = repoPath.split('/').filter(Boolean).pop() ?? repoPath;
    const path = join(this.root, repoName, `${kind === 'job' ? 'job' : 'review'}-${id}`);
    if (existsSync(path)) throw new Error(`worktree path already exists: ${path}`);
    mkdirSync(path, { recursive: true });
    const lane: WorktreeLane = {
      id,
      kind,
      repoPath,
      repoName,
      path,
      branch,
      sha,
      jobId,
      roundId,
      status: 'active',
    };
    this.lanes.set(id, lane);
    this.n += 1;
    return lane;
  }

  getWorktree(id: string): WorktreeLane | null {
    return this.lanes.get(id) ?? null;
  }

  listWorktrees(opts: { jobId?: string } = {}): readonly WorktreeLane[] {
    const all = [...this.lanes.values()];
    return opts.jobId === undefined ? all : all.filter((lane) => lane.jobId === opts.jobId);
  }

  async release(input: { worktreeId: string }): Promise<WorktreeSweepResult> {
    const lane = this.lanes.get(input.worktreeId);
    if (lane === undefined) {
      throw new Error(`worktree "${input.worktreeId}" is not in the registry`);
    }
    if (lane.status === 'swept') {
      return { status: 'swept', preserved: null, branch: 'none', freshHead: 'sha-head' };
    }
    this.lanes.set(input.worktreeId, { ...lane, status: 'swept' });
    rmSync(lane.path, { recursive: true, force: true });
    return { status: 'swept', preserved: null, branch: 'none', freshHead: 'sha-head' };
  }

  /** Test seam: how many lanes were created. */
  get created(): number {
    return this.n;
  }
}
