import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerDb } from '../src/ledger/db.js';
import { LedgerApi } from '../src/ledger/api.js';
import { EventBus } from '../src/events/bus.js';
import { commandReferencesTree, psEnumerator, WorktreeManager, type TreeProcess } from '../src/worktrees/manager.js';
import { attachBareOrigin, makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { runWorktreePortContract } from './helpers/worktree-port-contract.js';

/**
 * Worktree manager (SPEC ruling 18): branch-for-jobs at a fresh sha,
 * detached-for-reviews, sequential same-repo creation, preserve-first
 * sweep with pause-and-ask, containment-verified branch delete,
 * registry-only sweeps.
 */

interface BaseFallbackNotice {
  worktreeId: string;
  jobId: string;
  repoPath: string;
  repoName: string;
  defaultBranch: string | null;
  sha: string;
  detail: string;
}

interface Harness {
  repos: FixtureRepo[];
  manager: WorktreeManager;
  ledger: LedgerApi;
  escalations: { title: string; detail: string }[];
  baseFallbacks: BaseFallbackNotice[];
  enumerator: ReturnType<typeof vi.fn>;
  make: (name?: string) => FixtureRepo;
  dispose: () => Promise<void>;
}

function makeHarness(useDefaultEnumerator = false): Harness {
  const repos: FixtureRepo[] = [];
  const escalations: { title: string; detail: string }[] = [];
  const baseFallbacks: BaseFallbackNotice[] = [];
  const ledgerDb = new LedgerDb(mkdtempSync(join(tmpdir(), 'gru-command-wtdata-')));
  const ledger = new LedgerApi(ledgerDb.handle, { bus: new EventBus({}) });
  const enumerator = vi.fn<(treePath: string) => readonly TreeProcess[]>(() => []);
  const manager = new WorktreeManager({
    ledger,
    root: mkdtempSync(join(tmpdir(), 'gru-command-wtroot-')),
    preserveRoot: mkdtempSync(join(tmpdir(), 'gru-command-wtpreserve-')),
    setupTimeoutMs: 30_000,
    killGraceMs: 25, // real-signal tests stay fast; production default is 1.5 s
    onSweepPaused: ({ worktree, processes }) => {
      escalations.push({
        title: `paused: ${worktree.id}`,
        detail: processes.map((p) => p.pid).join(','),
      });
    },
    onBaseFallback: (input) => baseFallbacks.push({ ...input }),
    ...(useDefaultEnumerator ? {} : { enumerateProcesses: (treePath: string) => enumerator(treePath) }),
  });
  return {
    repos,
    manager,
    ledger,
    escalations,
    baseFallbacks,
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

function harness(useDefaultEnumerator = false): Harness {
  const h = makeHarness(useDefaultEnumerator);
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
    mkdirSync(join(repo.path, '.gru-command'), { recursive: true });
    writeFileSync(
      join(repo.path, '.gru-command', 'worktree.toml'),
      '[[setup]]\ncommand = "echo bootstrap-output > .boot-marker"',
    );
    ledgerJob(h, 'job-reviewable', repo);
    const jobRow = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-reviewable' });
    expect(existsSync(join(jobRow.path, '.boot-marker'))).toBe(true);
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
    expect(existsSync(join(review.path, '.boot-marker'))).toBe(false);
    expect(repo.git(['status', '--porcelain=v1', '--untracked-files=all', '--ignored'], review.path)).toBe('');
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

const GIT_IDENTITY = ['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid'];

/** A fixture with a real bare origin whose HEAD points at the pushed
 * default branch — the cached shape a host clone actually has. */
function originBacked(h: Harness, name: string, branch = 'main'): { repo: FixtureRepo; origin: string } {
  const repo = h.make(name);
  const origin = attachBareOrigin(repo);
  repo.git(['push', '--quiet', 'origin', `refs/heads/${branch}`]);
  execFileSync('git', ['-C', origin, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`], { stdio: 'ignore' });
  repo.git(['remote', 'set-head', 'origin', branch]);
  return { repo, origin };
}

/** Advance `branch` on the bare origin from an isolated clone, leaving the
 * host clone's local checkout AND its origin/<branch> ref behind — the
 * exact "lane branched from a stale base" incident shape. Returns the live
 * origin tip. */
function advanceOrigin(origin: string, branch: string, rel: string, content: string): string {
  const clone = mkdtempSync(join(tmpdir(), 'gru-wt-origin-clone-'));
  try {
    execFileSync('git', ['clone', '--quiet', '--branch', branch, origin, clone], { stdio: 'ignore' });
    writeFileSync(join(clone, rel), content, 'utf-8');
    execFileSync('git', ['-C', clone, 'add', rel], { stdio: 'ignore' });
    execFileSync('git', ['-C', clone, ...GIT_IDENTITY, 'commit', '-m', 'advance origin head'], { stdio: 'ignore' });
    execFileSync('git', ['-C', clone, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], { stdio: 'ignore' });
    return execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

describe('base resolution (owner incident 2026-09-23): the lane branches from FETCHED origin, never the host clone', () => {
  it('freshHead fetches origin, then the created lane branches from the fetched sha', async () => {
    const h = harness();
    const { repo, origin } = originBacked(h, 'fixture-origin-fresh');
    ledgerJob(h, 'job-fetched', repo);
    const staleLocal = repo.head();
    const tip = advanceOrigin(origin, 'main', 'src/advanced.ts', 'export const advanced = 1;\n');
    expect(tip).not.toBe(staleLocal); // the host clone really is behind

    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-fetched' });
    expect(row.sha).toBe(tip);
    expect(row.baseSource).toBe('origin');
    // The ACTUAL branched-from commit is the fetched sha (on disk too).
    expect(repo.git(['rev-parse', 'HEAD'], row.path)).toBe(tip);
    // The fetch updated the tracking ref (the refs are FETCHED, not stale).
    expect(repo.git(['rev-parse', 'refs/remotes/origin/main'])).toBe(tip);
    expect(h.baseFallbacks).toEqual([]);
  });

  it('resolves the repo default branch (remote HEAD) — never a hardcoded main', async () => {
    const h = harness();
    const repo = h.make('fixture-origin-trunk');
    repo.git(['branch', '-m', 'main', 'trunk']);
    const origin = attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/trunk']);
    execFileSync('git', ['-C', origin, 'symbolic-ref', 'HEAD', 'refs/heads/trunk'], { stdio: 'ignore' });
    repo.git(['remote', 'set-head', 'origin', 'trunk']);
    ledgerJob(h, 'job-trunk', repo);
    const tip = advanceOrigin(origin, 'trunk', 'src/trunk.ts', 'export const trunk = 1;\n');
    expect(repo.git(['branch', '--list', 'main'])).toBe(''); // no main anywhere

    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-trunk' });
    expect(row.sha).toBe(tip);
    expect(row.baseSource).toBe('origin');
  });

  it('fetch failure falls back to local HEAD with the degrade VISIBLE (registry + event + FYI sink)', async () => {
    const h = harness();
    const repo = h.make('fixture-origin-down');
    repo.git(['remote', 'add', 'origin', join(repo.path, '..', 'no-such-origin.git')]);
    ledgerJob(h, 'job-offline', repo);
    const local = repo.commitFile('src/local-work.ts', 'export const local = 1;\n');

    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-offline' });
    expect(row.sha).toBe(local);
    expect(row.baseSource).toBe('local-head-fallback');
    expect(repo.git(['rev-parse', 'HEAD'], row.path)).toBe(local);
    // Staleness becomes durable and visible — never silent.
    expect(h.ledger.getWorktree('job-offline')?.baseSource).toBe('local-head-fallback');
    const created = h.ledger.listEvents({ limit: 100 }).find((event) => event.kind === 'worktree.created');
    expect(created?.payload).toMatchObject({ baseSource: 'local-head-fallback', sha: local });
    expect(h.baseFallbacks).toHaveLength(1);
    expect(h.baseFallbacks[0]).toMatchObject({
      worktreeId: 'job-offline',
      jobId: 'job-offline',
      repoName: 'fixture-origin-down',
      sha: local,
    });
    expect(h.baseFallbacks[0]?.detail).toMatch(/no-such-origin|fetch/i);
  });

  it('review lanes never check out a stale origin tip: the tracking ref is fetched first', async () => {
    const h = harness();
    const { repo, origin } = originBacked(h, 'fixture-review-origin');
    ledgerJob(h, 'job-review-origin', repo);
    h.ledger.addRound({ jobId: 'job-review-origin', targetRef: 'HEAD' });
    const stale = repo.git(['rev-parse', 'refs/remotes/origin/main']);
    const tip = advanceOrigin(origin, 'main', 'src/review.ts', 'export const review = 1;\n');
    expect(tip).not.toBe(stale);

    const review = await h.manager.createReviewWorktree({
      repoPath: repo.path,
      roundId: 'job-review-origin-r1',
      ref: 'origin/main',
    });
    expect(review.sha).toBe(tip);
    expect(review.baseSource).toBe('origin');
    expect(repo.git(['rev-parse', 'HEAD'], review.path)).toBe(tip);
  });

  it('a review ref that names origin REFUSES to degrade silently when the fetch fails', async () => {
    const h = harness();
    const repo = h.make('fixture-review-down');
    attachBareOrigin(repo);
    repo.git(['push', '--quiet', 'origin', 'refs/heads/main']);
    repo.git(['remote', 'set-url', 'origin', join(repo.path, '..', 'missing-origin.git')]);
    ledgerJob(h, 'job-review-down', repo);
    h.ledger.addRound({ jobId: 'job-review-down', targetRef: 'HEAD' });

    await expect(
      h.manager.createReviewWorktree({ repoPath: repo.path, roundId: 'job-review-down-r1', ref: 'origin/main' }),
    ).rejects.toThrowError(/origin\/main.*fetch|refusing to check out a possibly stale/);
    // No half-created lane: nothing registered, no review debris.
    expect(h.manager.getWorktree('job-review-down-r1')).toBeNull();
  });
});

describe('worktree manager: sweep (ruling 18c)', () => {
  it('PAUSES on live processes, escalates, and never kills silently', async () => {
    const h = harness();
    const repo = h.make();
    ledgerJob(h, 'job-live', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-live' });
    h.enumerator.mockReturnValue([
      { pid: 424242, command: `node ${row.path}/server.js`, evidence: 'argv' },
      { pid: 424243, command: `vim ${row.path}/notes.txt`, evidence: 'argv' },
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
      live ? [{ pid: 999999, command: `watcher ${treePath}`, evidence: 'argv' as const }] : [],
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


describe('default process enumeration (the pause-and-ask mechanism, ruling 18c)', () => {
  it('finds a live process whose command line references the registered tree, and only that tree', async () => {
    const h = harness();
    const repo = h.make();
    ledgerJob(h, 'job-ps', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-ps' });
    // A long-lived process with the worktree path in its argv — exactly
    // what a dev server or watcher spawned inside the tree looks like.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', row.path], {
      stdio: 'ignore',
    });
    try {
      let found: readonly TreeProcess[] = [];
      await vi.waitFor(
        () => {
          found = psEnumerator(row.path);
          expect(found.length).toBeGreaterThan(0);
        },
        { timeout: 5_000 },
      );
      expect(found.some((process) => process.pid === child.pid)).toBe(true);
      // Registry paths only: a tree path nobody references stays clear.
      expect(psEnumerator(join(row.path, '..', 'no-such-tree'))).toHaveLength(0);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('Perkins r1 B1: quoted deliverables are never destroyed', () => {
  it('preserves untracked files with spaces, quotes, and non-ASCII names exactly (--porcelain -z)', async () => {
    const h = harness();
    const repo = h.make();
    ledgerJob(h, 'job-quoted', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-quoted' });
    // Names that C-quoting would mangle: spaces, an embedded quote, non-ASCII.
    const deliverables: readonly [string, string][] = [
      ['notes with spaces.md', 'space-deliverable'],
      ["quote's file.txt", 'quote-deliverable'],
      ['über-deliverable-✓.txt', 'unicode-deliverable'],
    ];
    for (const [name, content] of deliverables) {
      writeFileSync(join(row.path, name), content);
    }
    const result = await h.manager.release({ worktreeId: 'job-quoted' });
    expect(result.status).toBe('swept');
    expect(result.preserved?.count).toBe(deliverables.length);
    // Every name preserved VERBATIM — no C-quotes survived into the paths.
    for (const [name, content] of deliverables) {
      expect(readFileSync(join(result.preserved!.destination, name), 'utf-8')).toBe(content);
    }
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'aborts the sweep (tree intact) when a deliverable cannot be preserved — never sacrifices it',
    async () => {
      const h = harness();
      const repo = h.make();
      ledgerJob(h, 'job-unpreservable', repo);
      const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-unpreservable' });
      const guarded = join(row.path, 'guarded.txt');
      writeFileSync(guarded, 'must not be lost');
      chmodSync(guarded, 0o000); // copy will fail: present, but unreadable
      try {
        await expect(h.manager.release({ worktreeId: 'job-unpreservable' })).rejects.toThrowError(
          /sweep aborted: deliverable "guarded.txt" could not be preserved/,
        );
        // ABORT means the tree is retained and the deliverable still exists.
        expect(existsSync(guarded)).toBe(true);
        expect(h.ledger.getWorktree('job-unpreservable')?.status).toBe('active');
      } finally {
        chmodSync(guarded, 0o644);
      }
    },
  );
});

describe('Perkins r1 B2: argv matching is path-boundary, sibling lanes are untouchable', () => {
  it('commandReferencesTree matches whole paths only', () => {
    const tree = '/root/repo/job-a';
    expect(commandReferencesTree(`node ${tree}/server.js`, tree)).toBe(true); // inside the tree
    expect(commandReferencesTree(`vim ${tree}`, tree)).toBe(true); // exactly the tree
    expect(commandReferencesTree(`cd "${tree}" && npm run dev`, tree)).toBe(true); // quoted
    expect(commandReferencesTree(`node --cwd=${tree} x.js`, tree)).toBe(true); // flag value
    expect(commandReferencesTree(`vim /root/repo/job-a-2/notes`, tree)).toBe(false); // SIBLING LANE
    expect(commandReferencesTree(`node /root/repo/job-a.tar/x`, tree)).toBe(false); // different name
    expect(commandReferencesTree(`node /other/root/repo/job-a`, tree)).toBe(false); // longer path
    expect(commandReferencesTree('node elsewhere.js', tree)).toBe(false);
  });

  it('a live process rooted in the SIBLING lane is invisible to this lane (real ps)', async () => {
    const h = harness(true); // default enumerator
    const repo = h.make();
    ledgerJob(h, 'job-a', repo);
    ledgerJob(h, 'job-a-2', repo);
    const lane = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-a' });
    const sibling = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-a-2' });
    // The process's argv names ONLY the sibling tree.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', sibling.path], {
      stdio: 'ignore',
    });
    try {
      await vi.waitFor(
        () => {
          expect(psEnumerator(sibling.path).some((p) => p.pid === child.pid)).toBe(true);
        },
        { timeout: 5_000 },
      );
      // The sibling's process does NOT tie to this lane by substring.
      const found = psEnumerator(lane.path);
      expect(found.some((p) => p.pid === child.pid)).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('Perkins r1 B3: cwd-rooted processes are caught even with clean argv', () => {
  it('finds a process whose working directory is the tree but whose argv names no path', async () => {
    const h = harness(true);
    const repo = h.make();
    ledgerJob(h, 'job-cwd', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-cwd' });
    // argv is just `node -e <script>` — no path anywhere in it.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      cwd: row.path,
      stdio: 'ignore',
    });
    try {
      let found: readonly TreeProcess[] = [];
      await vi.waitFor(
        () => {
          found = psEnumerator(row.path).filter((p) => p.pid === child.pid);
          expect(found.length).toBe(1);
        },
        { timeout: 5_000 },
      );
      expect(found[0]?.evidence).toBe('cwd');
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('Perkins r1 B4: the pause-and-ask join against the DEFAULT enumerator', () => {
  it('release() pauses on a real cwd-rooted process: tree intact, no kill, registry evidence', async () => {
    const h = harness(true); // production enumerator — no injection anywhere in this path
    const repo = h.make();
    ledgerJob(h, 'job-join', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-join' });
    writeFileSync(join(row.path, 'deliverable.txt'), 'present through the pause');

    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: row.path,
      stdio: 'ignore',
    });
    const kill = vi.spyOn(process, 'kill');
    try {
      await vi.waitFor(
        () => {
          expect(psEnumerator(row.path).some((p) => p.pid === child.pid)).toBe(true);
        },
        { timeout: 5_000 },
      );

      // The join: release with live processes → PAUSE, never remove, never kill.
      const paused = await h.manager.release({ worktreeId: 'job-join' });
      expect(paused.status).toBe('paused');
      expect(existsSync(join(row.path, 'deliverable.txt'))).toBe(true);
      expect(existsSync(row.path)).toBe(true);
      expect(kill).not.toHaveBeenCalled();
      expect(h.escalations).toHaveLength(1);
      expect(h.ledger.getWorktree('job-join')?.status).toBe('paused');
      // Ruling 18b arm: the ask is grounded in registry rows, by pid.
      const recorded = h.ledger.listWorktreeProcesses('job-join');
      expect(recorded.some((p) => p.pid === child.pid && p.state === 'live')).toBe(true);

      // The process leaving clears the pause — the sweep then completes.
      child.kill('SIGKILL');
      await vi.waitFor(
        () => {
          expect(psEnumerator(row.path)).toHaveLength(0);
        },
        { timeout: 5_000 },
      );
      const swept = await h.manager.release({ worktreeId: 'job-join' });
      expect(swept.status).toBe('swept');
      expect(swept.preserved?.count).toBe(1);
      expect(readFileSync(join(swept.preserved!.destination, 'deliverable.txt'), 'utf-8')).toBe(
        'present through the pause',
      );
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      kill.mockRestore();
    }
  });
});

describe('Perkins r2 B1: failed bootstrap rollback un-wedges the job id', () => {
  it('a failed setup deletes the branch it created — the SAME job id retries cleanly', async () => {
    const h = harness();
    const repo = h.make('fixture-unwedge');
    const { mkdirSync: mk, writeFileSync: wf } = await import('node:fs');
    mk(join(repo.path, '.gru-command'), { recursive: true });
    wf(join(repo.path, '.gru-command', 'worktree.toml'), '[[setup]]\ncommand = "exit 5"');
    ledgerJob(h, 'job-wedge', repo);
    await expect(
      h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-wedge' }),
    ).rejects.toThrowError(/exited 5/);
    // No leftover branch wedging the id…
    expect(repo.git(['branch', '--list', 'gru/job-wedge'])).toBe('');
    // …so the retry (with the manifest fixed) succeeds on the SAME id.
    wf(join(repo.path, '.gru-command', 'worktree.toml'), '[[setup]]\ncommand = "true"');
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-wedge' });
    expect(row.branch).toBe('gru/job-wedge');
    expect(existsSync(row.path)).toBe(true);
  });
});

describe('Perkins r2 B2/B3: confirmed kills hit exactly the acknowledged set, for real', () => {
  it('kill-confirmed event names the paused pid; the real process dies; the sweep completes', async () => {
    const h = harness(true); // default enumerator, real signals
    const repo = h.make();
    ledgerJob(h, 'job-ack', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-ack' });
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: row.path,
      stdio: 'ignore',
    });
    try {
      await vi.waitFor(
        () => {
          expect(psEnumerator(row.path).some((p) => p.pid === child.pid)).toBe(true);
        },
        { timeout: 5_000 },
      );
      const paused = await h.manager.release({ worktreeId: 'job-ack' });
      expect(paused.status).toBe('paused');
      const confirmed = await h.manager.release({ worktreeId: 'job-ack', confirmKill: true });
      expect(confirmed.status).toBe('swept');
      // The acknowledged pid — recorded at the pause — is the killed one.
      const killEvent = h.ledger
        .listEvents({ limit: 200 })
        .find((event) => event.kind === 'worktree.kill-confirmed');
      expect(killEvent?.payload).toMatchObject({ pids: [child.pid] });
      expect(h.ledger.listWorktreeProcesses('job-ack').find((p) => p.pid === child.pid)?.state).toBe(
        'killed',
      );
      expect(child.kill(0)).toBe(false); // gone for real
      expect(existsSync(row.path)).toBe(false);
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {
        /* reaped by the confirmed kill */
      }
    }
  });

  it('a SIGTERM-trapping process gets the grace escalation: TERM ignored → SIGKILL → swept', async () => {
    const h = harness(true);
    const repo = h.make();
    ledgerJob(h, 'job-stubborn', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-stubborn' });
    // Traps SIGTERM: only SIGKILL ends it — the grace ladder must engage.
    const child = spawn(
      process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 60000)'],
      { cwd: row.path, stdio: 'ignore' },
    );
    try {
      await vi.waitFor(
        () => {
          expect(psEnumerator(row.path).some((p) => p.pid === child.pid)).toBe(true);
        },
        { timeout: 5_000 },
      );
      await expect(h.manager.release({ worktreeId: 'job-stubborn' })).resolves.toMatchObject({
        status: 'paused',
      });
      const confirmed = await h.manager.release({
        worktreeId: 'job-stubborn',
        confirmKill: true,
      });
      expect(confirmed.status).toBe('swept');
      expect(child.kill(0)).toBe(false);
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {
        /* reaped */
      }
    }
  });

  it('survivors of BOTH signals re-pause the sweep (branch leg, OS-failure shape)', async () => {
    const h = harness();
    const repo = h.make();
    ledgerJob(h, 'job-unkillable', repo);
    await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-unkillable' });
    h.enumerator.mockReturnValue([{ pid: 777777, command: 'unkillable watcher', evidence: 'argv' }]);
    await h.manager.release({ worktreeId: 'job-unkillable' }); // pause, records 777777
    // Simulate an OS that refuses both signals (kill "succeeds" as a call
    // but the pid survives every signal — EPERM-flavored reality).
    const kill = vi.spyOn(process, 'kill').mockImplementation(((target: number, signal?: string) => {
      void target;
      void signal;
      return true;
    }) as typeof process.kill);
    try {
      const result = await h.manager.release({ worktreeId: 'job-unkillable', confirmKill: true });
      expect(result.status).toBe('paused');
      if (result.status === 'paused') {
        expect(result.note).toMatch(/survived the acknowledged kill/);
        expect(result.processes.map((p) => p.pid)).toContain(777777);
      }
      expect(h.ledger.getWorktree('job-unkillable')?.status).toBe('paused');
    } finally {
      kill.mockRestore();
    }
  });

  it('confirmKill is NEVER honored without a recorded pause — the ask comes first', async () => {
    const h = harness();
    const repo = h.make();
    ledgerJob(h, 'job-noask', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-noask' });
    h.enumerator.mockReturnValue([{ pid: 555555, command: 'just appeared', evidence: 'argv' }]);
    const kill = vi.spyOn(process, 'kill');
    try {
      // First-ever release with confirmKill already set: no pause on record.
      const result = await h.manager.release({ worktreeId: 'job-noask', confirmKill: true });
      expect(result.status).toBe('paused'); // it asked instead of killing
      expect(kill).not.toHaveBeenCalled();
      // The ask is on the record for the NEXT call to answer.
      expect(
        h.ledger.listWorktreeProcesses('job-noask').some((p) => p.pid === 555555 && p.state === 'live'),
      ).toBe(true);
      expect(existsSync(row.path)).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });
});

describe('Perkins r3: the kill contract discriminators (recorded set, not the living set)', () => {
  function cwdChild(cwd: string) {
    return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { cwd, stdio: 'ignore' });
  }

  it('DISCRIMINATOR: confirm kills ONLY the acknowledged pid — a later arrival gets its own ask', async () => {
    const h = harness(true); // default enumerator, real signals
    const repo = h.make();
    ledgerJob(h, 'job-disc', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-disc' });
    const first = cwdChild(row.path);
    try {
      await vi.waitFor(
        () => {
          expect(psEnumerator(row.path).some((p) => p.pid === first.pid)).toBe(true);
        },
        { timeout: 5_000 },
      );
      // Pause records EXACTLY the first process.
      const paused = await h.manager.release({ worktreeId: 'job-disc' });
      expect(paused.status).toBe('paused');
      if (paused.status === 'paused') expect(paused.processes.map((p) => p.pid)).toEqual([first.pid]);

      // A NEWCOMER arrives after the ask was recorded — never acknowledged.
      const newcomer = cwdChild(row.path);
      try {
        await vi.waitFor(
          () => {
            expect(psEnumerator(row.path).some((p) => p.pid === newcomer.pid)).toBe(true);
          },
          { timeout: 5_000 },
        );
        const confirmed = await h.manager.release({ worktreeId: 'job-disc', confirmKill: true });
        // The acknowledged pid was killed…
        expect(first.kill(0)).toBe(false);
        // …and ONLY it: the newcomer survives the first confirm…
        expect(confirmed.status).toBe('paused');
        if (confirmed.status === 'paused') {
          expect(confirmed.processes.map((p) => p.pid)).toEqual([newcomer.pid]);
          expect(confirmed.note).toMatch(/NEW process/);
        }
        expect(newcomer.kill(0)).toBe(true);
        // …and gets its own ask on the record, answerable in turn.
        const asked = h.ledger.listWorktreeProcesses('job-disc');
        expect(asked.find((p) => p.pid === newcomer.pid)?.state).toBe('live');
        expect(asked.find((p) => p.pid === first.pid)?.state).toBe('killed');
        const second = await h.manager.release({ worktreeId: 'job-disc', confirmKill: true });
        expect(second.status).toBe('swept');
        expect(newcomer.kill(0)).toBe(false);
      } finally {
        try {
          newcomer.kill('SIGKILL');
        } catch {
          /* reaped */
        }
      }
    } finally {
      try {
        first.kill('SIGKILL');
      } catch {
        /* reaped */
      }
    }
  });

  it('DISCRIMINATOR: an acknowledged pid that left on its own kills nothing; the newcomer still re-asks', async () => {
    const h = harness(true);
    const repo = h.make();
    ledgerJob(h, 'job-gone', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-gone' });
    const first = cwdChild(row.path);
    try {
      await vi.waitFor(
        () => {
          expect(psEnumerator(row.path).some((p) => p.pid === first.pid)).toBe(true);
        },
        { timeout: 5_000 },
      );
      await expect(h.manager.release({ worktreeId: 'job-gone' })).resolves.toMatchObject({
        status: 'paused',
      });
      // The acknowledged process leaves on its own; a different one arrives.
      first.kill('SIGKILL');
      const newcomer = cwdChild(row.path);
      try {
        await vi.waitFor(
          () => {
            expect(psEnumerator(row.path).some((p) => p.pid === newcomer.pid)).toBe(true);
          },
          { timeout: 5_000 },
        );
        const confirmed = await h.manager.release({ worktreeId: 'job-gone', confirmKill: true });
        // Nothing unacknowledged was touched: the newcomer is alive, re-asked.
        expect(confirmed.status).toBe('paused');
        expect(newcomer.kill(0)).toBe(true);
        expect(h.ledger.listWorktreeProcesses('job-gone').find((p) => p.pid === newcomer.pid)?.state).toBe(
          'live',
        );
      } finally {
        try {
          newcomer.kill('SIGKILL');
        } catch {
          /* reaped */
        }
      }
    } finally {
      try {
        first.kill('SIGKILL');
      } catch {
        /* reaped */
      }
    }
  });
});

describe('Perkins r4 B1: manifest [[link]] lanes are releasable (the link is a deliverable)', () => {
  it('DISCRIMINATOR: a symlinked dir lane releases; the link is preserved as a link, not fatal', async () => {
    const h = harness();
    const repo = h.make('fixture-linklane');
    // The manifest links a shared DIRECTORY into every fresh worktree —
    // the exact shape the bootstrap manifest exists for.
    mkdirSync(join(repo.path, '_shared'), { recursive: true });
    writeFileSync(join(repo.path, '_shared', 'knowledge.txt'), 'shared knowledge');
    mkdirSync(join(repo.path, '.gru-command'), { recursive: true });
    writeFileSync(join(repo.path, '.gru-command', 'worktree.toml'), '[[link]]\nat = "_shared"\nto = "_shared"');
    ledgerJob(h, 'job-link', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-link' });
    // Lane reality: an untracked symlink + an untracked regular deliverable.
    writeFileSync(join(row.path, 'deliverable.txt'), 'plain deliverable');

    // BEFORE any fix this rejects (EISDIR through copyFileSync) and the
    // lane is unreleasable FOREVER. It must sweep and preserve BOTH.
    const result = await h.manager.release({ worktreeId: 'job-link' });
    expect(result.status).toBe('swept');
    expect(result.preserved?.count).toBe(2);
    // The regular deliverable…
    expect(readFileSync(join(result.preserved!.destination, 'deliverable.txt'), 'utf-8')).toBe(
      'plain deliverable',
    );
    // …and the link, preserved AS A LINK pointing where it pointed.
    const preservedLink = join(result.preserved!.destination, '_shared');
    expect(lstatSync(preservedLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(preservedLink)).toBe(join(realpathSync(repo.path), '_shared'));
    expect(existsSync(row.path)).toBe(false);
  });
});


describe('owner incident 2026-09-23: the sweep reaps its OWN spawned services', () => {
  it('DISCRIMINATOR: a registry-tracked lane service is reaped on release — no ask, killed for real', async () => {
    const h = harness(true); // production enumerator: the in-tree cross-check is real
    const repo = h.make();
    ledgerJob(h, 'job-track', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-track' });
    // A detached service the verification scheduler would spawn for the
    // lane: cwd = the tree, own process group.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
      cwd: row.path,
      stdio: 'ignore',
      detached: true,
    });
    try {
      await vi.waitFor(
        () => {
          expect(psEnumerator(row.path).some((p) => p.pid === child.pid)).toBe(true);
        },
        { timeout: 5_000 },
      );
      // Exactly what POST /api/verify records at spawn (evidence 'registry').
      h.ledger.recordWorktreeProcesses({
        worktreeId: 'job-track',
        processes: [
          { pid: child.pid as number, command: `node -e track-${child.pid}`, evidence: 'registry' },
        ],
        state: 'live',
      });

      const swept = await h.manager.release({ worktreeId: 'job-track' });
      expect(swept.status).toBe('swept');
      // Our own child never became a human ask…
      expect(h.escalations).toHaveLength(0);
      // …and it is gone for real (SIGTERM grace → SIGKILL if needed).
      expect(child.kill(0)).toBe(false);
      expect(h.ledger.listWorktreeProcesses('job-track').find((p) => p.pid === child.pid)?.state).toBe(
        'killed',
      );
      const event = h.ledger
        .listEvents({ limit: 200 })
        .find((candidate) => candidate.kind === 'worktree.service-reaped');
      expect(event?.payload).toMatchObject({ pids: [child.pid] });
      expect(existsSync(row.path)).toBe(false);
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {
        /* reaped by the sweep */
      }
    }
  });

  it('NEVER signals a tracked pid that is alive but no longer rooted in the tree (pid-reuse guard)', async () => {
    const h = harness(); // injected enumerator returns [] — nothing rooted in the lane
    const repo = h.make();
    ledgerJob(h, 'job-reuse', repo);
    await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-reuse' });
    const outsider = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      h.ledger.recordWorktreeProcesses({
        worktreeId: 'job-reuse',
        processes: [
          { pid: outsider.pid as number, command: `node -e reused-${outsider.pid}`, evidence: 'registry' },
        ],
        state: 'live',
      });
      const swept = await h.manager.release({ worktreeId: 'job-reuse' });
      expect(swept.status).toBe('swept');
      // The outsider was never signalled; the stale row is reconciled so it
      // can never be killed by a later confirm either.
      expect(outsider.kill(0)).toBe(true);
      expect(
        h.ledger.listWorktreeProcesses('job-reuse').find((p) => p.pid === outsider.pid)?.state,
      ).toBe('killed');
    } finally {
      try {
        outsider.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  });
});

// Perkins r5: the REAL manager satisfies the core's WorktreePort contract
// (same suite the in-memory double runs on PR #12) — the cross-lane
// handshake. If the manager ever minted its own ids or invented statuses,
// it fails here, not in the core's flow.
{
  const repo = makeFixtureRepo('fixture-manager-contract');
  const dataDir = mkdtempSync(join(tmpdir(), 'gru-command-mcontract-'));
  const root = mkdtempSync(join(tmpdir(), 'gru-command-mcontractroot-'));
  const preserveRoot = mkdtempSync(join(tmpdir(), 'gru-command-mcontractpreserve-'));
  const ledgerDb = new LedgerDb(dataDir);
  const ledger = new LedgerApi(ledgerDb.handle, { bus: new EventBus({}) });
  const manager = new WorktreeManager({
    ledger,
    root,
    preserveRoot,
    setupTimeoutMs: 30_000,
    killGraceMs: 25,
  });
  runWorktreePortContract('the real WorktreeManager', async () => ({
    port: manager,
    repoPath: repo.path,
    async seedJob(jobId: string) {
      ledger.addJob({ id: jobId, repo: 'fixture-manager-contract', title: 'contract' });
      ledger.setJobStatus(jobId, 'working');
    },
    async seedRound(jobId: string, roundId: string) {
      ledger.addRound({ jobId, targetRef: 'HEAD' });
      void roundId; // the round id is the addRound-derived id (<jobId>-rN)
    },
    async cleanup() {
      ledgerDb.close();
      repo.cleanup();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
      rmSync(preserveRoot, { recursive: true, force: true });
    },
  }));
}

describe('Perkins lane-B r1: creation registration sits INSIDE the rollback guard', () => {
  it('DISCRIMINATOR: a registration failure rolls back tree AND branch — no unregistered debris', async () => {
    const h = harness();
    const repo = h.make('fixture-regfail');
    // NO job row seeded: registerWorktree will reject AFTER the tree and
    // branch exist on disk. Before the fix that debris wedged every retry.
    await expect(
      h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-never-registered' }),
    ).rejects.toThrowError(/not found/);
    // No tree, no branch, no wedge: the rollback guard covered registration.
    const debris = h.manager.listWorktrees().find((lane) => lane.id === 'job-never-registered');
    expect(debris).toBeUndefined();
    expect(repo.git(['branch', '--list', 'gru/job-never-registered'])).toBe('');
    // And the retry (with the row seeded) is clean.
    ledgerJob(h, 'job-never-registered', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-never-registered' });
    expect(row.branch).toBe('gru/job-never-registered');
  });
});

describe('Perkins lane-B r1: the sweep tail can never strand a non-swept row over a removed tree', () => {
  function detachMainHead(repo: FixtureRepo): void {
    // A detached-HEAD main checkout: symbolic-ref HEAD fails — the exact
    // post-removal tail hazard.
    repo.git(['checkout', '--detach']);
  }

  it('DISCRIMINATOR: a tail failure after removal still flips the row swept — no eternal wedge', async () => {
    const h = harness();
    const repo = h.make('fixture-tailfail');
    ledgerJob(h, 'job-tailfail', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-tailfail' });
    // An unmerged commit forces the branch-delete leg to resolve a base…
    writeFileSync(join(row.path, 'orphan.txt'), 'unmerged');
    repo.git(['add', 'orphan.txt'], row.path);
    repo.git(
      ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-m', 'orphan'],
      row.path,
    );
    // …and the detached main HEAD makes the fallback resolution fail.
    detachMainHead(repo);

    // Before the fix: remove succeeds, symbolic-ref throws, the release
    // REJECTS with the row stranded ACTIVE over a REMOVED tree — and every
    // retry dies in preserveUntracked. It must resolve swept instead.
    const result = await h.manager.release({ worktreeId: 'job-tailfail' });
    expect(result.status).toBe('swept');
    expect(h.ledger.getWorktree('job-tailfail')?.status).toBe('swept');
    expect(existsSync(row.path)).toBe(false);
    // No wedge: the retry is an idempotent swept, never a rejection.
    const again = await h.manager.release({ worktreeId: 'job-tailfail' });
    expect(again.status).toBe('swept');
  });

  it('DISCRIMINATOR: base_branch flows through the confirm-kill tail (no stranded lane on a detached repo)', async () => {
    const h = harness();
    const repo = h.make('fixture-basepass');
    ledgerJob(h, 'job-basepass', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-basepass' });
    // An UNMERGED lane commit + a detached main HEAD: without the explicit
    // baseBranch reaching the tail, the symbolic-ref fallback throws AFTER
    // removal (the stranded-row wedge). With it: containment is checked
    // against 'main', fails honestly, and the branch is RETAINED.
    writeFileSync(join(row.path, 'orphan.txt'), 'unmerged work');
    repo.git(['add', 'orphan.txt'], row.path);
    repo.git(
      ['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-m', 'orphan work'],
      row.path,
    );
    detachMainHead(repo);

    // The process stays "live" for every enumeration until the confirmed
    // kill lands — the confirm-kill TAIL is the code under test.
    let killed = false;
    h.enumerator.mockImplementation(() =>
      killed ? [] : [{ pid: 111111, command: 'watcher', evidence: 'argv' as const }],
    );
    const paused = await h.manager.release({ worktreeId: 'job-basepass' }); // pause (records the ask)
    expect(paused.status).toBe('paused');
    const kill = vi
      .spyOn(process, 'kill')
      .mockImplementation((() => {
        killed = true;
        return true;
      }) as typeof process.kill);
    try {
      const result = await h.manager.release({
        worktreeId: 'job-basepass',
        confirmKill: true,
        baseBranch: 'main',
      });
      expect(result.status).toBe('swept');
      if (result.status === 'swept') {
        // Containment verified against the GIVEN base — unmerged → retained.
        expect(result.branch).toBe('retained');
      }
      expect(repo.git(['branch', '--list', 'gru/job-basepass'])).toContain('gru/job-basepass');
    } finally {
      kill.mockRestore();
    }
  });
});

describe('Perkins lane-B r2: the sweep-tail catch leg is PINNED (fires on a real git failure)', () => {
  it('DISCRIMINATOR: a post-removal branch-delete failure still flips swept + records sweep-tail-failed', async () => {
    const h = harness();
    const repo = h.make('fixture-catchleg');
    ledgerJob(h, 'job-catchleg', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-catchleg' });
    // Contained work (merged into main) — and a STALE REF LOCK on the
    // lane's branch: after the lane's removal, `branch -D` genuinely
    // refuses ("cannot lock ref … File exists"). A real post-removal
    // tail failure, no mocks.
    writeFileSync(join(row.path, 'work.txt'), 'contained work');
    repo.git(['add', 'work.txt'], row.path);
    repo.git(['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-m', 'work'], row.path);
    repo.git(['merge', row.branch!]);
    const refDir = join(repo.path, '.git', 'refs', 'heads', 'gru');
    writeFileSync(join(refDir, `${'job-catchleg'}.lock`), '');

    const result = await h.manager.release({ worktreeId: 'job-catchleg', baseBranch: 'main' });
    expect(result.status).toBe('swept'); // the catch-and-mark held
    expect(h.ledger.getWorktree('job-catchleg')?.status).toBe('swept');
    // The catch leg's OWN record — deleting the try/catch must lose this.
    const events = h.ledger.listEvents({ limit: 200 });
    expect(events.some((event) => event.kind === 'worktree.sweep-tail-failed')).toBe(true);
    // The branch survives the failed delete (locked ref).
    expect(repo.git(['branch', '--list', row.branch!])).toContain(row.branch!);
    // Retry is an idempotent swept — no wedge.
    const again = await h.manager.release({ worktreeId: 'job-catchleg' });
    expect(again.status).toBe('swept');
  });
});

describe('Perkins lane-B r2/r3: crash-window reconciliation (row stranded over a removed tree)', () => {
  it('DISCRIMINATOR: a CONTAINED lane reconciles swept WITH its branch deleted — no debris, no wedge', async () => {
    const h = harness();
    const repo = h.make('fixture-crashwin');
    ledgerJob(h, 'job-crashwin', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-crashwin' });
    // The lane's work is CONTAINED (merged into main), then the crash
    // window: the tree is removed out of band, the row never flipped.
    writeFileSync(join(row.path, 'work.txt'), 'merged work');
    repo.git(['add', 'work.txt'], row.path);
    repo.git(['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-m', 'work'], row.path);
    repo.git(['merge', row.branch!]);
    repo.git(['worktree', 'remove', '--force', row.path]);
    expect(existsSync(row.path)).toBe(false);
    expect(h.ledger.getWorktree('job-crashwin')?.status).toBe('active');

    // Before this fix the reconcile abandoned the branch ('none' + debris
    // left) — re-creating the job wedged on 'branch already exists'.
    const result = await h.manager.release({ worktreeId: 'job-crashwin', baseBranch: 'main' });
    expect(result.status).toBe('swept');
    if (result.status === 'swept') {
      expect(result.branch).toBe('deleted'); // the TRUE outcome, not 'none'
    }
    expect(h.ledger.getWorktree('job-crashwin')?.status).toBe('swept');
    // NO BRANCH DEBRIS: the containment-verified disposal ran.
    expect(repo.git(['branch', '--list', row.branch!])).toBe('');
    expect(
      h.ledger.listEvents({ limit: 200 }).some((event) => event.kind === 'worktree.reconciled'),
    ).toBe(true);
    // The id is immediately reusable — no manual surgery.
    ledgerJob(h, 'job-crashwin-2', repo);
    const fresh = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-crashwin-2' });
    expect(existsSync(fresh.path)).toBe(true);
    // Retry of the reconciled lane is an idempotent swept.
    const again = await h.manager.release({ worktreeId: 'job-crashwin' });
    expect(again.status).toBe('swept');
  });

  it('DISCRIMINATOR: an UNCONTAINED lane reconciles swept with its branch RETAINED — never over-deleted', async () => {
    const h = harness();
    const repo = h.make('fixture-crashwin-unmerged');
    ledgerJob(h, 'job-cu', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-cu' });
    // Unmerged work + the crash window.
    writeFileSync(join(row.path, 'orphan.txt'), 'unmerged work');
    repo.git(['add', 'orphan.txt'], row.path);
    repo.git(['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-m', 'orphan'], row.path);
    repo.git(['worktree', 'remove', '--force', row.path]);

    const result = await h.manager.release({ worktreeId: 'job-cu', baseBranch: 'main' });
    expect(result.status).toBe('swept');
    if (result.status === 'swept') {
      expect(result.branch).toBe('retained'); // containment checked, honestly
    }
    expect(h.ledger.getWorktree('job-cu')?.status).toBe('swept');
    // The uncontained branch SURVIVES — nothing force-deleted on faith.
    expect(repo.git(['branch', '--list', row.branch!])).toContain(row.branch!);
    expect(
      h.ledger.listEvents({ limit: 200 }).some((event) => event.kind === 'worktree.branch-retained'),
    ).toBe(true);
  });
});

describe('Perkins lane-B r4: a swept row with a surviving branch HEALS on release (no silent debris)', () => {
  it('DISCRIMINATOR: swept + tree gone + branch present → release disposes it and reports the true outcome', async () => {
    const h = harness();
    const repo = h.make('fixture-heal');
    ledgerJob(h, 'job-heal', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-heal' });
    // Contained work; then the reconcile's OWN crash window: the row was
    // flipped swept but the branch disposal never ran (tree gone too).
    writeFileSync(join(row.path, 'work.txt'), 'merged work');
    repo.git(['add', 'work.txt'], row.path);
    repo.git(['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-m', 'work'], row.path);
    repo.git(['merge', row.branch!]);
    repo.git(['worktree', 'remove', '--force', row.path]);
    h.ledger.setWorktreeStatus('job-heal', 'swept'); // flipped, disposal skipped

    // Before the heal: every retry returned swept/branch:'none' silently
    // while `git branch --list` still printed the branch → same-id
    // re-creation wedged. The retry must HEAL: true outcome + no debris.
    const healed = await h.manager.release({ worktreeId: 'job-heal', baseBranch: 'main' });
    expect(healed.status).toBe('swept');
    if (healed.status === 'swept') expect(healed.branch).toBe('deleted');
    expect(repo.git(['branch', '--list', row.branch!])).toBe('');
    // The id is reusable immediately.
    ledgerJob(h, 'job-heal-2', repo);
    const fresh = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-heal-2' });
    expect(existsSync(fresh.path)).toBe(true);
    // A further retry is a clean no-op now (nothing left to heal).
    const clean = await h.manager.release({ worktreeId: 'job-heal' });
    expect(clean.status).toBe('swept');
  });

  it('DISCRIMINATOR: a disposal FAILURE during the heal is loud (tail-failed event) and heals on a later retry', async () => {
    const h = harness();
    const repo = h.make('fixture-heal-lock');
    ledgerJob(h, 'job-hl', repo);
    const row = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-hl' });
    writeFileSync(join(row.path, 'work.txt'), 'merged work');
    repo.git(['add', 'work.txt'], row.path);
    repo.git(['-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-m', 'work'], row.path);
    repo.git(['merge', row.branch!]);
    repo.git(['worktree', 'remove', '--force', row.path]);
    h.ledger.setWorktreeStatus('job-hl', 'swept');
    // A stale ref lock makes the heal's disposal genuinely fail.
    const lockFile = join(repo.path, '.git', 'refs', 'heads', 'gru', 'job-hl.lock');
    writeFileSync(lockFile, '');

    const failed = await h.manager.release({ worktreeId: 'job-hl', baseBranch: 'main' });
    expect(failed.status).toBe('swept'); // the heal failure never wedges the release
    // LOUD, not silent: the failure is on the record (the r4 contract).
    expect(
      h.ledger.listEvents({ limit: 200 }).some((event) => event.kind === 'worktree.sweep-tail-failed'),
    ).toBe(true);
    expect(repo.git(['branch', '--list', row.branch!])).toContain(row.branch!); // survives

    // The obstruction clears — the NEXT retry heals.
    const { unlinkSync } = await import('node:fs');
    unlinkSync(lockFile);
    const healed = await h.manager.release({ worktreeId: 'job-hl', baseBranch: 'main' });
    expect(healed.status).toBe('swept');
    if (healed.status === 'swept') expect(healed.branch).toBe('deleted');
    expect(repo.git(['branch', '--list', row.branch!])).toBe('');
  });
});
