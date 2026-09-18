import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import type { WorktreePort } from '../../src/dispatch/worktree-port.js';

/**
 * The WorktreePort CONTRACT (Perkins r5 B1) — binding on EVERY
 * implementation. The core runs it against the in-memory test double;
 * the manager lane runs it against the REAL manager. A formally
 * compliant port that minted its own ids or invented statuses would
 * fail here, not in production.
 */

export interface PortContractHarness {
  readonly port: WorktreePort;
  /** A real repo path lanes can be created against. */
  readonly repoPath: string;
  /** Ensure the ledger owner row exists (FK registries need it). */
  seedJob(jobId: string): Promise<void>;
  seedRound(jobId: string, roundId: string): Promise<void>;
  cleanup(): Promise<void>;
}

export function runWorktreePortContract(name: string, make: () => Promise<PortContractHarness>): void {
  describe(`WorktreePort contract: ${name}`, () => {
    let h: PortContractHarness;

    it('JOB LANES: id === jobId, kind/status/branch per contract, real directory', async () => {
      h = await make();
      await h.seedJob('contract-job');
      const lane = await h.port.createJobWorktree({ repoPath: h.repoPath, jobId: 'contract-job' });
      expect(lane.id).toBe('contract-job'); // ids ARE owner ids (contract)
      expect(lane.kind).toBe('job');
      expect(lane.status).toBe('active');
      expect(lane.branch).not.toBeNull(); // branch-for-jobs
      expect(lane.jobId).toBe('contract-job');
      expect(existsSync(lane.path)).toBe(true); // lanes are real directories
    });

    it('DISCOVERY: listWorktrees({jobId}) scopes the job lane + linked review lanes; never id-guessing', async () => {
      const lanes = h.port.listWorktrees({ jobId: 'contract-job' });
      expect(lanes.some((lane) => lane.kind === 'job' && lane.id === 'contract-job')).toBe(true);
      await h.seedRound('contract-job', 'contract-job-r1');
      const review = await h.port.createReviewWorktree({
        repoPath: h.repoPath,
        roundId: 'contract-job-r1',
        ref: 'HEAD',
        jobId: 'contract-job',
      });
      const after = h.port.listWorktrees({ jobId: 'contract-job' });
      expect(after.some((lane) => lane.kind === 'job')).toBe(true);
      expect(after.some((lane) => lane.kind === 'review' && lane.id === 'contract-job-r1')).toBe(true);
      // getWorktree mirrors the registry under the same id convention.
      expect(h.port.getWorktree('contract-job')?.kind).toBe('job');
      expect(h.port.getWorktree('contract-job-r1')?.kind).toBe('review');
      // Review lanes are detached (branch-for-jobs ONLY — no review debris).
      expect(review.branch).toBeNull();
      expect(review.roundId).toBe('contract-job-r1');
      expect(review.jobId).toBe('contract-job'); // linkage by construction
    });

    it('RELEASE: sweeps the lane (tree gone, status swept), idempotent on repeat', async () => {
      const jobLane = h.port.listWorktrees({ jobId: 'contract-job' }).find((lane) => lane.kind === 'job');
      expect(jobLane).toBeDefined();
      const first = await h.port.release({ worktreeId: jobLane!.id });
      expect(first.status).toBe('swept');
      expect(h.port.getWorktree(jobLane!.id)?.status).toBe('swept');
      expect(existsSync(jobLane!.path)).toBe(false); // the sweep removed the tree
      const again = await h.port.release({ worktreeId: jobLane!.id });
      expect(again.status).toBe('swept'); // idempotent
      // The review lane releases under its own id (round id convention).
      const reviewFirst = await h.port.release({ worktreeId: 'contract-job-r1' });
      expect(reviewFirst.status).toBe('swept');
      expect(h.port.getWorktree('contract-job-r1')?.status).toBe('swept');
    });

    it('REGISTRY PATHS ONLY: releasing an unknown id rejects loudly', async () => {
      await expect(h.port.release({ worktreeId: 'never-registered' })).rejects.toThrowError(
        /registry/,
      );
      expect(h.port.getWorktree('never-registered')).toBeNull();
    });

    it('cleanup', async () => {
      await h.cleanup();
    });
  });
}
