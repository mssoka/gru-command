import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { issueFixtureHandoff } from './fixture-handoff.js';
import { rememberManagedLane } from '../../src/worktrees/handoff.js';
import type { LedgerApi, WorktreeBaseSource } from '../../src/ledger/api.js';
import type { WorktreeLane, WorktreePort, WorktreeSweepResult } from '../../src/dispatch/worktree-port.js';
import { resolveReviewTargetReal } from './git-review-port.js';

/**
 * File-backed review port (R19): lanes persist in a JSON registry under the
 * port root so a REAL child-process crash and the parent's recovery see the
 * same lane state — the honest analogue of the production WorktreeManager,
 * whose registry survives restarts. Review lanes are real detached git
 * worktrees, exactly like GitReviewPort.
 */
export class PersistedReviewPort implements WorktreePort {
  private readonly registryFile: string;

  constructor(
    private readonly root: string,
    private readonly branch: string,
    private readonly sha: string,
    private readonly ledger: LedgerApi,
  ) {
    this.registryFile = join(root, 'lanes.json');
    for (const lane of ledger.listWorktrees()) rememberManagedLane(lane, ledger); // reconstruct, never reissue
  }

  private read(): Map<string, WorktreeLane> {
    const lanes = new Map<string, WorktreeLane>();
    if (existsSync(this.registryFile)) {
      for (const lane of JSON.parse(readFileSync(this.registryFile, 'utf8')) as WorktreeLane[]) {
        lanes.set(lane.id, lane);
      }
    }
    return lanes;
  }

  private write(lanes: Map<string, WorktreeLane>): void {
    writeFileSync(this.registryFile, `${JSON.stringify([...lanes.values()], null, 2)}\n`, 'utf8');
  }

  async resolveReviewTarget(input: { repoPath: string; ref: string }): Promise<{
    readonly sha: string;
    readonly baseSource: WorktreeBaseSource | null;
    readonly trackingRef: string | null;
  }> {
    return resolveReviewTargetReal(input.repoPath, input.ref);
  }

  async createJobWorktree(input: { repoPath: string; jobId: string }): Promise<WorktreeLane> {
    const lanes = this.read();
    const lane: WorktreeLane = {
      id: input.jobId, kind: 'job', repoPath: input.repoPath, repoName: 'fixture', path: input.repoPath,
      branch: this.branch, sha: this.sha, jobId: input.jobId, roundId: null, status: 'active',
    };
    lanes.set(lane.id, lane);
    this.write(lanes);
    return lane;
  }

  async createReviewWorktree(input: { repoPath: string; roundId: string; ref: string; jobId?: string }): Promise<WorktreeLane> {
    if (this.ledger.getRound(input.roundId) === null) throw new Error('persisted review fixture requires its actual owning round before issuance');
    const path = join(this.root, input.roundId);
    execFileSync('git', ['-C', input.repoPath, 'worktree', 'add', '--detach', path, input.ref], { stdio: 'ignore' });
    const lanes = this.read();
    const lane: WorktreeLane = {
      id: input.roundId, kind: 'review', repoPath: input.repoPath, repoName: 'fixture', path,
      branch: null, sha: execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), jobId: input.jobId ?? null, roundId: input.roundId, status: 'active',
    };
    const issued = issueFixtureHandoff(lane, this.ledger);
    lanes.set(lane.id, issued);
    this.write(lanes);
    return issued;
  }

  /** Issue #161: real child lanes (detached read-only / branched writer),
   * persisted like every other lane this port owns. */
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
    const lanes = this.read();
    const lane: WorktreeLane = {
      id: input.childId, kind: 'child', repoPath: input.repoPath, repoName: 'fixture', path,
      branch, sha: base, jobId: input.jobId, roundId: null, status: 'active',
    };
    const issued = issueFixtureHandoff(lane, this.ledger);
    lanes.set(lane.id, issued);
    this.write(lanes);
    return issued;
  }

  getWorktree(id: string): WorktreeLane | null {
    return this.read().get(id) ?? null;
  }

  listWorktrees(options: { jobId?: string } = {}): readonly WorktreeLane[] {
    return [...this.read().values()].filter((lane) => options.jobId === undefined || lane.jobId === options.jobId);
  }

  async release(input: { worktreeId: string }): Promise<WorktreeSweepResult> {
    const lanes = this.read();
    const lane = lanes.get(input.worktreeId);
    if (lane === undefined) throw new Error('missing lane');
    if ((lane.kind === 'review' || lane.kind === 'child') && existsSync(lane.path)) {
      execFileSync('git', ['-C', lane.repoPath, 'worktree', 'remove', '--force', lane.path], { stdio: 'ignore' });
      if (lane.branch !== null) {
        execFileSync('git', ['-C', lane.repoPath, 'branch', '-D', lane.branch], { stdio: 'ignore' });
      }
    }
    if (this.ledger.getWorktree(lane.id) !== null) this.ledger.setWorktreeStatus(lane.id, 'swept', 'fixture-owned release');
    lanes.set(lane.id, { ...lane, status: 'swept' });
    this.write(lanes);
    return { status: 'swept', preserved: null, branch: 'none', freshHead: this.sha };
  }
}
