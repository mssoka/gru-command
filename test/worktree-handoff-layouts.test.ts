import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import * as handoffProof from '../src/worktrees/handoff.js';
import { WorktreeManager } from '../src/worktrees/manager.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * Worktree handoff custody, driven directly against the real manager:
 * `--separate-git-dir` repositories (#372) and the parent-custody binding
 * a child lane is created under (#373).
 */

const repos: FixtureRepo[] = [];
const dirs: string[] = [];
const dbs: LedgerDb[] = [];

afterEach(() => {
  while (dbs.length > 0) dbs.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
  while (repos.length > 0) repos.pop()!.cleanup();
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'gru-handoff-layouts-'));
  dirs.push(path);
  return path;
}

function fixture(name: string): FixtureRepo {
  const repo = makeFixtureRepo(name);
  repos.push(repo);
  return repo;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function manager(): { readonly ledger: LedgerApi; readonly worktrees: WorktreeManager; readonly root: string } {
  const db = new LedgerDb(directory());
  dbs.push(db);
  const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
  const root = directory();
  return { ledger, root, worktrees: new WorktreeManager({ ledger, root, preserveRoot: directory(), setupTimeoutMs: 30_000, enumerateProcesses: () => [] }) };
}

/** Convert a fixture to the layout `git init --separate-git-dir` produces:
 * the checkout's `.git` is a FILE naming the full git directory elsewhere. */
function separateGitDir(repo: FixtureRepo): string {
  const gitdir = join(directory(), 'separate.git');
  renameSync(join(repo.path, '.git'), gitdir);
  writeFileSync(join(repo.path, '.git'), `gitdir: ${gitdir}\n`);
  const canonical = realpathSync(gitdir);
  expect(realpathSync(git(repo.path, ['rev-parse', '--absolute-git-dir']))).toBe(canonical);
  return canonical;
}

describe('worktree handoff with a --separate-git-dir repository (#372)', () => {
  it('creates, proves and releases job and child lanes whose common directory is the separate git dir', async () => {
    const repo = fixture('separate-layout');
    const gitdir = separateGitDir(repo);
    const h = manager();
    const job = h.ledger.addJob({ id: 'sep-job', repo: 'assigned', title: 'separate git dir' });
    const lane = await h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    expect(handoffProof.repositoryCommonDirectory(repo.path)).toBe(gitdir);
    expect(realpathSync(git(lane.path, ['rev-parse', '--git-common-dir']))).toBe(gitdir);
    // The completed handoff proves against the separate common directory.
    expect(() => handoffProof.capturePortLaneHandoff(h.worktrees, lane)()).not.toThrow();
    const child = await h.worktrees.createChildWorktree({ repoPath: repo.path, jobId: job.id, childId: 'sep-child', parentPath: lane.path, authority: 'read-only' });
    expect(child.sha).toBe(lane.sha);
    expect(() => handoffProof.capturePortLaneHandoff(h.worktrees, child)()).not.toThrow();
    // Removal is proven against the same inventory: no retained administration.
    git(repo.path, ['worktree', 'remove', '--force', child.path]);
    expect(() => handoffProof.assertLaneResourcesAbsent(child)).not.toThrow();
  });

  it('refuses a .git file whose gitdir is neither a linked administration nor a git directory', () => {
    const repo = fixture('separate-bogus');
    const bogus = join(directory(), 'not-a-git-dir');
    mkdirSync(bogus);
    rmSync(join(repo.path, '.git'), { recursive: true, force: true });
    writeFileSync(join(repo.path, '.git'), `gitdir: ${bogus}\n`);
    expect(() => handoffProof.repositoryCommonDirectory(repo.path)).toThrow(/neither a linked worktree administration nor a git directory/u);
  });
});

describe('child lane parent custody, called directly (#373)', () => {
  async function parentFixture(name: string) {
    const repo = fixture(name);
    const h = manager();
    const job = h.ledger.addJob({ id: 'custody-parent', repo: 'assigned', title: 'parent' });
    const parent = await h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    const admin = git(parent.path, ['rev-parse', '--absolute-git-dir']);
    const createChild = (overrides: { jobId?: string; parentPath?: string } = {}) => h.worktrees.createChildWorktree({
      repoPath: repo.path, jobId: overrides.jobId ?? job.id, childId: 'custody-child', parentPath: overrides.parentPath ?? parent.path, authority: 'writer',
    });
    const childLeftNothing = (): void => {
      expect(h.ledger.getWorktree('custody-child')).toBeNull();
      expect(existsSync(join(h.root, parent.repoName, 'child-custody-child'))).toBe(false);
      expect(git(repo.path, ['branch', '--list', `gru/${job.id}-child-custody-child`])).toBe('');
    };
    return { repo, h, job, parent, admin, createChild, childLeftNothing };
  }

  it('bases a child on its healthy registered parent', async () => {
    const f = await parentFixture('custody-healthy');
    const child = await f.createChild();
    expect(child.sha).toBe(git(f.parent.path, ['rev-parse', 'HEAD']));
    expect(f.h.ledger.getWorktree('custody-child')?.status).toBe('active');
  });

  it('refuses a parent path the job never registered, or one registered to another job', async () => {
    const f = await parentFixture('custody-unregistered');
    const stray = join(directory(), 'stray');
    git(f.repo.path, ['worktree', 'add', '--detach', '-q', stray]);
    await expect(f.createChild({ parentPath: stray })).rejects.toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
    f.childLeftNothing();
    const other = f.h.ledger.addJob({ id: 'custody-other', repo: 'assigned', title: 'other job' });
    await expect(f.createChild({ jobId: other.id })).rejects.toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
    expect(f.h.ledger.getWorktree('custody-child')).toBeNull();
  });

  it('refuses a parent whose completed handoff receipt changed, before any child Git effect', async () => {
    const f = await parentFixture('custody-receipt');
    const receipt = join(f.admin, 'gru-creation-handoff.json');
    writeFileSync(receipt, readFileSync(receipt, 'utf8').replace('"state":"ready"', '"state":"pending"'));
    await expect(f.createChild()).rejects.toThrow(/handoff unresolved/u);
    f.childLeftNothing();
  });

  it('refuses a parent whose administration is locked, retaining the lock', async () => {
    const f = await parentFixture('custody-locked');
    writeFileSync(join(f.admin, 'locked'), 'foreign custody');
    await expect(f.createChild()).rejects.toThrow(/handoff unresolved/u);
    f.childLeftNothing();
    expect(readFileSync(join(f.admin, 'locked'), 'utf8')).toBe('foreign custody');
  });

  it('refuses a parent whose attachment moved to a foreign branch', async () => {
    const f = await parentFixture('custody-attachment');
    git(f.repo.path, ['branch', 'foreign-parent', f.parent.sha]);
    writeFileSync(join(f.admin, 'HEAD'), 'ref: refs/heads/foreign-parent\n');
    await expect(f.createChild()).rejects.toThrow(/handoff unresolved/u);
    f.childLeftNothing();
    expect(f.h.ledger.getWorktree(f.parent.id)?.status).toBe('active');
  });
});
