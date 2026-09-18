import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerDb } from '../src/ledger/db.js';
import { LedgerApi } from '../src/ledger/api.js';
import { EventBus } from '../src/events/bus.js';
import { WorktreeManager, type TreeProcess } from '../src/worktrees/manager.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * Worktree manager (SPEC ruling 18): branch-for-jobs at a fresh sha,
 * detached-for-reviews, sequential same-repo creation, preserve-first
 * sweep with pause-and-ask, containment-verified branch delete,
 * registry-only sweeps.
 */

interface Harness {
  repos: FixtureRepo[];
  manager: WorktreeManager;
  ledger: LedgerApi;
  escalations: { title: string; detail: string }[];
  enumerator: ReturnType<typeof vi.fn>;
  make: (name?: string) => FixtureRepo;
  dispose: () => Promise<void>;
}

function makeHarness(): Harness {
  const repos: FixtureRepo[] = [];
  const escalations: { title: string; detail: string }[] = [];
  const ledgerDb = new LedgerDb(mkdtempSync(join(tmpdir(), 'gru-command-wtdata-')));
  const ledger = new LedgerApi(ledgerDb.handle, { bus: new EventBus({}) });
  const enumerator = vi.fn<(treePath: string) => readonly TreeProcess[]>(() => []);
  const manager = new WorktreeManager({
    ledger,
    root: mkdtempSync(join(tmpdir(), 'gru-command-wtroot-')),
    preserveRoot: mkdtempSync(join(tmpdir(), 'gru-command-wtpreserve-')),
    setupTimeoutMs: 30_000,
    onSweepPaused: ({ worktree, processes }) => {
      escalations.push({
        title: `paused: ${worktree.id}`,
        detail: processes.map((p) => p.pid).join(','),
      });
    },
    enumerateProcesses: (treePath) => enumerator(treePath),
  });
  return {
    repos,
    manager,
    ledger,
    escalations,
    enumerator,
    make(name?: string): FixtureRepo {
      const repo = makeFixtureRepo(name ?? 'fixture-wt');
      repos.push(repo);
      return repo;
    },
    async dispose(): Promise<void> {
      for (const repo of repos) repo.cleanup();
      ledgerDb.close();
    },
  };
}

const cleanups: Harness[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!.dispose();
});

function harness(): Harness {
  const h = makeHarness();
  cleanups.push(h);
  return h;
}

describe('worktree manager: creation (ruling 18a/b/d/e)', () => {
  it('creates a job worktree on its own branch at the CURRENT fresh head, registered in the ledger', async () => {
    const h = harness();
    const repo = h.make();
    ledgerJob(h, 'job-alpha', repo);
    const shaBefore = repo.head();
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-alpha' });
    expect(row.branch).toBe('gru/job-alpha');
    expect(row.sha).toBe(shaBefore);
    expect(row.kind).toBe('job');
    expect(row.status).toBe('active');
    // The worktree exists on disk at the registered path, on the branch.
    expect(existsSync(join(row.path, 'README.md'))).toBe(true);
    expect(repo.git(['rev-parse', '--abbrev-ref', 'HEAD'], row.path)).toBe('gru/job-alpha');
    // Registry row is the map (ruling 18b).
    expect(h.ledger.getWorktree('job-alpha')?.path).toBe(row.path);
  });

  it('applies the bootstrap manifest automatically at creation', async () => {
    const h = harness();
    const repo = h.make('fixture-boot');
    mkdirSync(join(repo.path, '.gru-command'), { recursive: true });
    writeFileSync(
      join(repo.path, '.gru-command', 'worktree.toml'),
      '[[setup]]\ncommand = "echo ok > .boot-marker"',
    );
    ledgerJob(h, 'job-boot', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-boot' });
    expect(existsSync(join(row.path, '.boot-marker'))).toBe(true);
  });

  it('rolls the worktree back when the bootstrap manifest fails', async () => {
    const h = harness();
    const repo = h.make('fixture-bootfail');
    mkdirSync(join(repo.path, '.gru-command'), { recursive: true });
    writeFileSync(join(repo.path, '.gru-command', 'worktree.toml'), '[[setup]]\ncommand = "exit 9"');
    ledgerJob(h, 'job-bootfail', repo);
    await expect(
      h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-bootfail' }),
    ).rejects.toThrowError(/exited 9/);
    expect(repo.git(['worktree', 'list'])).not.toContain('job-bootfail');
    expect(h.ledger.getWorktree('job-bootfail')).toBeNull();
  });

  it('resolves a FRESH head per creation — a later job starts at the advanced head, not a held sha', async () => {
    const h = harness();
    const repo = h.make();
    ledgerJob(h, 'job-first', repo);
    ledgerJob(h, 'job-second', repo);
    const first = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-first' });
    const advanced = repo.commitFile('src/next.ts', 'export const next = 2;\n');
    const second = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-second' });
    expect(first.sha).not.toBe(second.sha);
    expect(second.sha).toBe(advanced);
  });

  it('serializes same-repo creation (ruling 18e): concurrent creates all land, each own lane', async () => {
    const h = harness();
    const repo = h.make();
    ledgerJob(h, 'job-a', repo);
    ledgerJob(h, 'job-b', repo);
    ledgerJob(h, 'job-c', repo);
    const rows = await Promise.all(
      ['job-a', 'job-b', 'job-c'].map((jobId) => h.manager.createJobWorktree({ repoPath: repo.path, jobId })),
    );
    const paths = new Set(rows.map((row) => row.path));
    expect(paths.size).toBe(3);
    for (const row of rows) expect(existsSync(row.path)).toBe(true);
  });

  it('creates review worktrees DETACHED — no branch, ever (ruling 18d)', async () => {
    const h = harness();
    const repo = h.make();
    ledgerJob(h, 'job-reviewable', repo);
    const jobRow = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-reviewable' });
    h.ledger.addRound({ jobId: 'job-reviewable', targetRef: jobRow.branch });
    const review = await h.manager.createReviewWorktree({
      repoPath: repo.path,
      roundId: 'job-reviewable-r1',
      ref: jobRow.branch!,
    });
    expect(review.kind).toBe('review');
    expect(review.branch).toBeNull();
    const ref = repo.git(['rev-parse', '--abbrev-ref', 'HEAD'], review.path);
    expect(ref).toBe('HEAD'); // detached
    const branches = repo.git(['branch', '--list', 'gru/*']);
    expect(branches).not.toContain('r1');
  });

  it('refuses a reused branch or path for a second job lane', async () => {
    const h = harness();
    const repo = h.make();
    ledgerJob(h, 'job-dup', repo);
    await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-dup' });
    await expect(
      h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-dup' }),
    ).rejects.toThrowError(/already exists/);
  });
});

describe('worktree manager: sweep (ruling 18c)', () => {
  it('PAUSES on live processes, escalates, and never kills silently', async () => {
    const h = harness();
    const repo = h.make();
    ledgerJob(h, 'job-live', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-live' });
    h.enumerator.mockReturnValue([
      { pid: 424242, command: `node ${row.path}/server.js` },
      { pid: 424243, command: `vim ${row.path}/notes.txt` },
    ]);
    const kill = vi.spyOn(process, 'kill');
    try {
      const result = await h.manager.release({ worktreeId: 'job-live' });
      expect(result.status).toBe('paused');
      if (result.status === 'paused') {
        expect(result.processes).toHaveLength(2);
      }
      // The tree survives; the registry says paused; the ask went out.
      expect(existsSync(row.path)).toBe(true);
      expect(h.ledger.getWorktree('job-live')?.status).toBe('paused');
      expect(h.escalations).toHaveLength(1);
      expect(h.escalations[0]?.detail).toBe('424242,424243');
      // NO kill was issued — pause-and-ask, never a silent kill.
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });

  it('confirmKill kills EXACTLY the enumerated pids after re-check, then completes the sweep', async () => {
    const h = harness();
    const repo = h.make();
    ledgerJob(h, 'job-confirm', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-confirm' });
    writeFileSync(join(row.path, 'deliverable.txt'), 'untracked gold');
    let live = true;
    h.enumerator.mockImplementation((treePath: string) =>
      live ? [{ pid: 999999, command: `watcher ${treePath}` }] : [],
    );
    const kill = vi.spyOn(process, 'kill').mockImplementation(((target: number) => {
      if (target === 999999) {
        live = false;
        return true;
      }
      return true;
    }) as typeof process.kill);
    try {
      const paused = await h.manager.release({ worktreeId: 'job-confirm' });
      expect(paused.status).toBe('paused');
      const swept = await h.manager.release({ worktreeId: 'job-confirm', confirmKill: true });
      expect(swept.status).toBe('swept');
      // The kill decision is on the record.
      const events = h.ledger.listEvents({ limit: 100 });
      expect(events.some((event) => event.kind === 'worktree.kill-confirmed')).toBe(true);
      expect(events.some((event) => event.kind === 'worktree.preserved')).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });

  it('preserves untracked deliverables FIRST, then removes the tree', async () => {
    const h = harness();
    const repo = h.make();
    ledgerJob(h, 'job-deliver', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-deliver' });
    writeFileSync(join(row.path, 'notes-untracked.md'), 'deliverable');
    const result = await h.manager.release({ worktreeId: 'job-deliver' });
    expect(result.status).toBe('swept');
    expect(result.preserved?.count).toBe(1);
    expect(readFileSync(join(result.preserved!.destination, 'notes-untracked.md'), 'utf-8')).toBe(
      'deliverable',
    );
    expect(existsSync(row.path)).toBe(false);
    expect(repo.git(['worktree', 'list'])).not.toContain('job-deliver');
  });

  it('deletes a merged branch (containment-verified) but RETAINS an unmerged one', async () => {
    const h = harness();
    const repo = h.make();
    ledgerJob(h, 'job-merged', repo);
    ledgerJob(h, 'job-unmerged', repo);
    await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-merged' });
    const unmerged = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-unmerged' });

    // merged: advance main to include the job branch's tip? The branch has
    // no extra commits — soft-deleting an untouched branch proves containment.
    const r1 = await h.manager.release({ worktreeId: 'job-merged' });
    expect(r1.status).toBe('swept');
    if (r1.status === 'swept') expect(r1.branch).toBe('deleted');
    expect(repo.git(['branch', '--list', 'gru/job-merged'])).toBe('');

    // unmerged: a commit on the job branch that main will never see.
    writeFileSync(join(unmerged.path, 'orphan.txt'), 'work main never receives');
    repo.git(['add', 'orphan.txt'], unmerged.path);
    repo.git(
      ['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'orphan work'],
      unmerged.path,
    );
    const r2 = await h.manager.release({ worktreeId: 'job-unmerged' });
    expect(r2.status).toBe('swept');
    if (r2.status === 'swept') expect(r2.branch).toBe('retained');
    // The branch SURVIVES containment verification — nothing force-deleted.
    expect(repo.git(['branch', '--list', 'gru/job-unmerged'])).toContain('gru/job-unmerged');
  });

  it('re-resolves the fresh head at release (follow-on work starts from now)', async () => {
    const h = harness();
    const repo = h.make();
    ledgerJob(h, 'job-fresh', repo);
    await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-fresh' });
    const advanced = repo.commitFile('src/advance.ts', 'export const v = 3;\n');
    const result = await h.manager.release({ worktreeId: 'job-fresh' });
    expect(result.status).toBe('swept');
    if (result.status === 'swept') {
      expect(result.freshHead).toBe(advanced);
    }
  });

  it('refuses to sweep anything not in the registry (registry paths only, ruling 18b)', async () => {
    const h = harness();
    await expect(h.manager.release({ worktreeId: 'never-registered' })).rejects.toThrowError(
      /registry paths only/,
    );
  });
});

function ledgerJob(h: Harness, jobId: string, repo: FixtureRepo): void {
  h.ledger.addJob({ id: jobId, repo: repo.path.split('/').pop() ?? 'fixture', title: `job ${jobId}` });
}
