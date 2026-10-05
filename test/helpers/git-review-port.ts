import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorktreeBaseSource } from '../../src/ledger/api.js';
import type { WorktreeLane, WorktreePort, WorktreeSweepResult } from '../../src/dispatch/worktree-port.js';
import { isExactOriginBranchSpelling } from '../../src/worktrees/manager.js';

/**
 * Git-backed review port double: the job lane IS the fixture repo (one
 * branch), review lanes are real detached worktrees. Shared by the Perkins
 * wave suites so freeze/ref identity is exercised against real git.
 */

/** Production-faithful review-target resolution for git-backed doubles —
 * the manager's discipline, verbatim: a ref naming an origin tracking ref
 * is FETCHED fresh (refusing when the fetch fails — never a stale local
 * resolution), origin/HEAD resolves through the live default-branch
 * symref, and everything else (commit pins, tags, local branches) pins
 * exactly. */
export function resolveReviewTargetReal(
  repoPath: string,
  ref: string,
): { readonly sha: string; readonly baseSource: WorktreeBaseSource | null } {
  // (1) An EXACT origin-branch spelling classifies FIRST (Perkins R5): a
  // local branch or tag named origin/topic would otherwise DWIM-shadow
  // the remote ref and pin local bytes. Fetch fresh, fail closed;
  // origin/HEAD resolves through the live default branch; origin-prefixed
  // revision expressions (origin/main~1) are NOT exact spellings and pin.
  if (isExactOriginBranchSpelling(ref)) {
    const stripped = ref.replace(/^(?:refs\/)?remotes\/origin\/|^origin\//u, '');
    let branch = stripped;
    if (stripped === 'HEAD') {
      const head = spawnSync('git', ['-C', repoPath, 'ls-remote', '--symref', 'origin', 'HEAD'], { encoding: 'utf-8' });
      const match = head.status === 0 ? /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/mu.exec(head.stdout) : null;
      if (match === null || match[1] === undefined || match[1] === '') {
        throw new Error(`review ref ${ref} names origin/HEAD but the default branch is unresolvable — refusing to freeze a possibly stale tip`);
      }
      branch = match[1];
    }
    const fetched = spawnSync(
      'git',
      ['-C', repoPath, 'fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { encoding: 'utf-8' },
    );
    if (fetched.status !== 0) {
      throw new Error(
        `review ref ${ref} names origin/${branch} but fetching it fresh failed: ${(fetched.stderr ?? '').trim()} — ` +
          'refusing to freeze a possibly stale tip',
      );
    }
    const sha = execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`], {
      encoding: 'utf-8',
    }).trim();
    return { sha, baseSource: 'origin' };
  }
  // (2) Everything else: local DWIM, then the exact pin.
  const sym = spawnSync('git', ['-C', repoPath, 'rev-parse', '--symbolic-full-name', '--verify', ref], {
    encoding: 'utf-8',
  });
  const fullName = sym.status === 0 ? sym.stdout.trim() : '';
  const prefix = 'refs/remotes/origin/';
  if (fullName.startsWith(prefix) && fullName.length > prefix.length) {
    const stripped = fullName.slice(prefix.length);
    let branch = stripped;
    if (stripped === 'HEAD') {
      const head = spawnSync('git', ['-C', repoPath, 'ls-remote', '--symref', 'origin', 'HEAD'], { encoding: 'utf-8' });
      const match = head.status === 0 ? /^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/mu.exec(head.stdout) : null;
      if (match === null || match[1] === undefined || match[1] === '') {
        throw new Error(`review ref ${ref} names origin/HEAD but the default branch is unresolvable — refusing to freeze a possibly stale tip`);
      }
      branch = match[1];
    }
    const fetched = spawnSync(
      'git',
      ['-C', repoPath, 'fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
      { encoding: 'utf-8' },
    );
    if (fetched.status !== 0) {
      throw new Error(
        `review ref ${ref} names origin/${branch} but fetching it fresh failed: ${(fetched.stderr ?? '').trim()} — ` +
          'refusing to freeze a possibly stale tip',
      );
    }
    const sha = execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', `refs/remotes/origin/${branch}^{commit}`], {
      encoding: 'utf-8',
    }).trim();
    return { sha, baseSource: 'origin' };
  }
  const sha = execFileSync('git', ['-C', repoPath, 'rev-parse', '--verify', `${ref}^{commit}`], {
    encoding: 'utf-8',
  }).trim();
  return { sha, baseSource: null };
}
export class GitReviewPort implements WorktreePort {
  private readonly lanes = new Map<string, WorktreeLane>();
  constructor(private readonly root: string, private readonly branch: string, private readonly sha: string) {}

  async resolveReviewTarget(input: { repoPath: string; ref: string }): Promise<{
    readonly sha: string;
    readonly baseSource: WorktreeBaseSource | null;
  }> {
    return resolveReviewTargetReal(input.repoPath, input.ref);
  }

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

  /** Issue #161: a real child lane (detached for read-only authority, own
   * branch for writers) based at the parent lane's HEAD. */
  async createChildWorktree(input: {
    repoPath: string;
    jobId: string;
    childId: string;
    parentPath: string;
    authority: 'read-only' | 'writer';
  }): Promise<WorktreeLane> {
    const path = join(this.root, `child-${input.childId}`);
    const base = execFileSync('git', ['-C', input.parentPath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
    const branch = input.authority === 'writer' ? `gru/${input.jobId}-child-${input.childId}` : null;
    if (branch === null) {
      execFileSync('git', ['-C', input.repoPath, 'worktree', 'add', '--detach', path, base], { stdio: 'ignore' });
    } else {
      execFileSync('git', ['-C', input.repoPath, 'worktree', 'add', '-b', branch, path, base], { stdio: 'ignore' });
    }
    const lane: WorktreeLane = {
      id: input.childId, kind: 'child', repoPath: input.repoPath, repoName: 'fixture', path,
      branch, sha: base, jobId: input.jobId, roundId: null, status: 'active',
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
    if ((lane.kind === 'review' || lane.kind === 'child') && existsSync(lane.path)) {
      execFileSync('git', ['-C', lane.repoPath, 'worktree', 'remove', '--force', lane.path], { stdio: 'ignore' });
      if (lane.branch !== null) {
        execFileSync('git', ['-C', lane.repoPath, 'branch', '-D', lane.branch], { stdio: 'ignore' });
      }
    }
    this.lanes.set(lane.id, { ...lane, status: 'swept' });
    return { status: 'swept', preserved: null, branch: 'none', freshHead: this.sha };
  }
}
