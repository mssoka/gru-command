import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorktreeLane, WorktreePort, WorktreeSweepResult } from '../../src/dispatch/worktree-port.js';

/**
 * Git-backed review port double: the job lane IS the fixture repo (one
 * branch), review lanes are real detached worktrees. Shared by the Perkins
 * wave suites so freeze/ref identity is exercised against real git.
 */
export class GitReviewPort implements WorktreePort {
  private readonly lanes = new Map<string, WorktreeLane>();
  constructor(private readonly root: string, private readonly branch: string, private readonly sha: string) {}

  async createJobWorktree(input: { repoPath: string; jobId: string }): Promise<WorktreeLane> {
    const lane: WorktreeLane = {
      id: input.jobId, kind: 'job', repoPath: input.repoPath, repoName: 'fixture', path: input.repoPath,
      branch: this.branch, sha: this.sha, jobId: input.jobId, roundId: null, status: 'active',
    };
    this.lanes.set(lane.id, lane);
    return lane;
  }

  async createReviewWorktree(input: { repoPath: string; roundId: string; ref: string; jobId?: string }): Promise<WorktreeLane> {
    const path = join(this.root, input.roundId);
    execFileSync('git', ['-C', input.repoPath, 'worktree', 'add', '--detach', path, input.ref], { stdio: 'ignore' });
    const lane: WorktreeLane = {
      id: input.roundId, kind: 'review', repoPath: input.repoPath, repoName: 'fixture', path,
      branch: null, sha: input.ref, jobId: input.jobId ?? null, roundId: input.roundId, status: 'active',
    };
    this.lanes.set(lane.id, lane);
    return lane;
  }

  getWorktree(id: string): WorktreeLane | null { return this.lanes.get(id) ?? null; }
  listWorktrees(options: { jobId?: string } = {}): readonly WorktreeLane[] {
    return [...this.lanes.values()].filter((lane) => options.jobId === undefined || lane.jobId === options.jobId);
  }
  async release(input: { worktreeId: string }): Promise<WorktreeSweepResult> {
    const lane = this.lanes.get(input.worktreeId);
    if (lane === undefined) throw new Error('missing lane');
    if (lane.kind === 'review' && existsSync(lane.path)) {
      execFileSync('git', ['-C', lane.repoPath, 'worktree', 'remove', '--force', lane.path], { stdio: 'ignore' });
    }
    this.lanes.set(lane.id, { ...lane, status: 'swept' });
    return { status: 'swept', preserved: null, branch: 'none', freshHead: this.sha };
  }
}
