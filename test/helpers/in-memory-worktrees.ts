import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorktreeLane, WorktreePort, WorktreeSweepResult } from '../../src/dispatch/worktree-port.js';

/**
 * In-memory worktree port (test double for the E8 CORE suites — the real
 * manager is its own lane). Lanes are real directories; when the supplied
 * repository is Git-backed this double uses real linked worktrees so hybrid
 * review tests can freeze exact commits. Non-Git contract fixtures retain the
 * lightweight directory behavior.
 */

export class InMemoryWorktreePort implements WorktreePort {
  readonly root: string;
  private readonly lanes = new Map<string, WorktreeLane>();
  private n = 0;

  constructor(root: string) {
    this.root = root;
  }

  async createJobWorktree(input: { repoPath: string; jobId: string }): Promise<WorktreeLane> {
    return this.create('job', input.repoPath, input.jobId, input.jobId, null, `gru/${input.jobId}`, 'sha-job', 'HEAD');
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
      input.ref,
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
    gitRef: string,
  ): WorktreeLane {
    if (this.lanes.has(id)) throw new Error(`worktree "${id}" already exists`);
    const repoName = repoPath.split('/').filter(Boolean).pop() ?? repoPath;
    const path = join(this.root, repoName, `${kind === 'job' ? 'job' : 'review'}-${id}`);
    if (existsSync(path)) throw new Error(`worktree path already exists: ${path}`);
    let actualSha = sha;
    let isGitRepo = false;
    try {
      execFileSync('git', ['-C', repoPath, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' });
      isGitRepo = true;
    } catch {
      // Contract-only tests intentionally use non-git fixture directories.
    }
    if (isGitRepo) {
      mkdirSync(dirname(path), { recursive: true });
      const args = kind === 'job'
        ? ['-C', repoPath, 'worktree', 'add', '-b', branch as string, path, gitRef]
        : ['-C', repoPath, 'worktree', 'add', '--detach', path, gitRef];
      execFileSync('git', args, { stdio: 'ignore' });
      actualSha = execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    } else {
      mkdirSync(path, { recursive: true });
    }
    const lane: WorktreeLane = {
      id,
      kind,
      repoPath,
      repoName,
      path,
      branch,
      sha: actualSha,
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
    try {
      execFileSync('git', ['-C', lane.repoPath, 'worktree', 'remove', '--force', lane.path], { stdio: 'ignore' });
    } catch {
      rmSync(lane.path, { recursive: true, force: true });
    }
    if (lane.branch !== null) {
      // Job lanes create their own branch; leaving it behind wedges a
      // same-id re-create in later tests.
      try {
        execFileSync('git', ['-C', lane.repoPath, 'branch', '-D', lane.branch], { stdio: 'ignore' });
        execFileSync('git', ['-C', lane.repoPath, 'worktree', 'prune'], { stdio: 'ignore' });
      } catch {
        // Branch cleanup is best-effort for the contract double.
      }
    }
    return { status: 'swept', preserved: null, branch: 'none', freshHead: 'sha-head' };
  }

  /** Test seam: how many lanes were created. */
  get created(): number {
    return this.n;
  }
}
