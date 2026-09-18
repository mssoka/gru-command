import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerDb } from '../src/ledger/db.js';
import { LedgerApi } from '../src/ledger/api.js';
import { EventBus } from '../src/events/bus.js';
import { commandReferencesTree, psEnumerator, WorktreeManager, type TreeProcess } from '../src/worktrees/manager.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { runWorktreePortContract } from './helpers/worktree-port-contract.js';

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

function makeHarness(useDefaultEnumerator = false): Harness {
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
    killGraceMs: 25, // real-signal tests stay fast; production default is 1.5 s
    onSweepPaused: ({ worktree, processes }) => {
      escalations.push({
        title: `paused: ${worktree.id}`,
        detail: processes.map((p) => p.pid).join(','),
      });
    },
    ...(useDefaultEnumerator ? {} : { enumerateProcesses: (treePath: string) => enumerator(treePath) }),
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
