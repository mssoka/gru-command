import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import {
  UnavailableWorktreePort,
  WORKTREE_PORT_UNAVAILABLE,
  type WorktreePort,
} from '../src/dispatch/worktree-port.js';
import { DispatchService } from '../src/dispatch/service.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { runWorktreePortContract } from './helpers/worktree-port-contract.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * The port contract runs for the in-memory double (the core's test
 * implementation) and the unavailable port is pinned fail-loud on every
 * surface — writes AND reads (Perkins r5 B2/B3).
 */

const cleanupDirs: string[] = [];
const cleanupRepos: FixtureRepo[] = [];
afterEach(() => {
  while (cleanupRepos.length > 0) cleanupRepos.pop()!.cleanup();
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

runWorktreePortContract('in-memory test double', async () => {
  const repo = makeFixtureRepo('fixture-port');
  cleanupRepos.push(repo);
  const port = new InMemoryWorktreePort(mkdtempSync(join(tmpdir(), 'gru-command-port-')));
  return {
    port,
    repoPath: repo.path,
    async seedJob() {},
    async seedRound() {},
    async cleanup() {},
  };
});

describe('UnavailableWorktreePort: fail-loud on EVERY surface (r5 B2/B3)', () => {
  it('writes throw WORKTREE_PORT_UNAVAILABLE — never a silent no-op', async () => {
    const port: WorktreePort = new UnavailableWorktreePort();
    await expect(port.createJobWorktree({ repoPath: '/x', jobId: 'j' })).rejects.toThrowError(
      WORKTREE_PORT_UNAVAILABLE,
    );
    await expect(
      port.createReviewWorktree({ repoPath: '/x', roundId: 'r', ref: 'HEAD' }),
    ).rejects.toThrowError(WORKTREE_PORT_UNAVAILABLE);
    await expect(port.release({ worktreeId: 'j' })).rejects.toThrowError(WORKTREE_PORT_UNAVAILABLE);
  });

  it('READS throw too — a null lane or empty list would misdiagnose as "no lanes"', () => {
    const port = new UnavailableWorktreePort();
    expect(() => port.getWorktree('any')).toThrowError(WORKTREE_PORT_UNAVAILABLE);
    expect(() => port.listWorktrees()).toThrowError(WORKTREE_PORT_UNAVAILABLE);
    expect(() => port.listWorktrees({ jobId: 'any' })).toThrowError(WORKTREE_PORT_UNAVAILABLE);
  });

  it('dispatch through the unavailable port fails LOUD, blocks the job, names the subsystem', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gru-command-unavail-'));
    cleanupDirs.push(dataDir);
    const repo = makeFixtureRepo('fixture-unavail');
    cleanupRepos.push(repo);
    const ledgerDb = new LedgerDb(dataDir);
    const ledger = new LedgerApi(ledgerDb.handle, { bus: new EventBus({}) });
    const dispatch = new DispatchService({
      ledger,
      worktrees: new UnavailableWorktreePort(),
      spawner: async () => {
        throw new Error('spawner must not be reached');
      },
    });
    try {
      await expect(
        dispatch.dispatch({
          jobId: 'job-unavail',
          repoPath: repo.path,
          title: 'doomed',
          briefing: 'cannot start without the manager lane',
        }),
      ).rejects.toThrowError(WORKTREE_PORT_UNAVAILABLE);
      // Loud AND honest: the job is blocked with the real reason recorded.
      const job = ledger.getJob('job-unavail');
      expect(job?.status).toBe('blocked');
      expect(job?.note).toMatch(/worktree manager lane is not installed/);
    } finally {
      ledgerDb.close();
    }
  });

  it('the review path surfaces the unavailability — never a false "no worktree in the registry"', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'gru-command-unavail2-'));
    cleanupDirs.push(dataDir);
    const ledgerDb = new LedgerDb(dataDir);
    const ledger = new LedgerApi(ledgerDb.handle, { bus: new EventBus({}) });
    const { WaveRunner } = await import('../src/dispatch/perkins.js');
    const wave = new WaveRunner({
      ledger,
      worktrees: new UnavailableWorktreePort(),
      spawner: async () => {
        throw new Error('spawner must not be reached');
      },
    });
    ledger.addJob({ id: 'job-review-unavail', repo: 'r', title: 't' });
    try {
      await expect(wave.runRound({ jobId: 'job-review-unavail' })).rejects.toThrowError(
        WORKTREE_PORT_UNAVAILABLE,
      );
    } finally {
      ledgerDb.close();
    }
  });
});
