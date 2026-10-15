import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative as relativePath } from 'node:path';
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

/** Fixture git: the inherited environment minus any repository routing. */
function git(cwd: string, args: readonly string[]): string {
  const { GIT_DIR: _dir, GIT_WORK_TREE: _tree, GIT_INDEX_FILE: _index, ...inherited } = process.env;
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...inherited, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Every message in an error's cause chain (which custody check fired). */
function reasonsOf(error: unknown): string {
  const messages: string[] = [];
  for (let current: unknown = error; current instanceof Error; current = current.cause) messages.push(current.message);
  return messages.join(' <- ');
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
function separateGitDir(repo: FixtureRepo, relative = false): string {
  const parent = directory();
  const gitdir = join(parent, 'separate.git');
  renameSync(join(repo.path, '.git'), gitdir);
  // git accepts a gitdir relative to the checkout too.
  writeFileSync(join(repo.path, '.git'), `gitdir: ${relative ? join(relativePath(repo.path, parent), 'separate.git') : gitdir}\n`);
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
    // Removal is proven against the same inventory, for the child AND the
    // job lane: no retained administration.
    git(repo.path, ['worktree', 'remove', '--force', child.path]);
    expect(() => handoffProof.assertLaneResourcesAbsent(child)).not.toThrow();
    git(repo.path, ['worktree', 'remove', '--force', lane.path]);
    expect(() => handoffProof.assertLaneResourcesAbsent(lane)).not.toThrow();
    // git prunes the emptied administration directory itself.
    expect(existsSync(join(gitdir, 'worktrees')) ? readdirSync(join(gitdir, 'worktrees')) : []).toEqual([]);
  });

  it('resolves a relative gitdir in the .git file', () => {
    const repo = fixture('separate-relative');
    const gitdir = separateGitDir(repo, true);
    expect(handoffProof.repositoryCommonDirectory(repo.path)).toBe(gitdir);
  });

  it('rolls a failed creation back cleanly in a separate-git-dir repository, keeping the original error', async () => {
    const repo = fixture('separate-rollback');
    mkdirSync(join(repo.path, '.gru-command'), { recursive: true });
    writeFileSync(join(repo.path, '.gru-command/worktree.toml'), '[[setup]]\ncommand = "exit 7"\n');
    git(repo.path, ['add', '.gru-command/worktree.toml']);
    git(repo.path, ['commit', '-qm', 'failing setup']);
    const gitdir = separateGitDir(repo);
    const h = manager();
    const job = h.ledger.addJob({ id: 'sep-rollback', repo: 'assigned', title: 'failing setup' });
    const error = await h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id }).then(() => null, (cause: unknown) => cause);
    expect(error, 'creation fails in its setup').not.toBeNull();
    const reasons = reasonsOf(error);
    expect(reasons).not.toMatch(/missing repository gitdir|commondir|neither a linked worktree administration/u);
    // Nothing partial survives: no lane administration and no branch.
    expect(existsSync(join(gitdir, 'worktrees')) ? readdirSync(join(gitdir, 'worktrees')) : []).toEqual([]);
    expect(git(repo.path, ['branch', '--list', `gru/${job.id}`])).toBe('');
  });

  it('refuses each malformed gitdir layout by name, with the path and the missing piece', () => {
    const cases: readonly (readonly [string, (gitdir: string) => void, RegExp])[] = [
      ['missing', () => {}, /does not exist/u],
      ['a file', (gitdir) => { writeFileSync(gitdir, 'not a directory'); }, /is not a directory/u],
      ['HEAD only', (gitdir) => { mkdirSync(gitdir); writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/main\n'); }, /has no objects directory/u],
      ['no refs', (gitdir) => { mkdirSync(join(gitdir, 'objects'), { recursive: true }); writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/main\n'); }, /has no refs directory/u],
      ['objects is a file', (gitdir) => { mkdirSync(join(gitdir, 'refs'), { recursive: true }); writeFileSync(join(gitdir, 'HEAD'), 'x'); writeFileSync(join(gitdir, 'objects'), 'x'); }, /has no objects directory/u],
      ['empty', (gitdir) => { mkdirSync(gitdir); }, /has no HEAD file/u],
    ];
    for (const [label, make, problem] of cases) {
      const repo = fixture(`separate-bogus-${label.replace(/\W+/gu, '-')}`);
      const bogus = join(directory(), 'bogus.git');
      make(bogus);
      rmSync(join(repo.path, '.git'), { recursive: true, force: true });
      writeFileSync(join(repo.path, '.git'), `gitdir: ${bogus}\n`);
      expect(() => handoffProof.repositoryCommonDirectory(repo.path), label).toThrow(problem);
      expect(() => handoffProof.repositoryCommonDirectory(repo.path), label).toThrow(bogus);
    }
    // A .git file without the gitdir prefix is no layout at all.
    const plain = fixture('separate-no-prefix');
    rmSync(join(plain.path, '.git'), { recursive: true, force: true });
    writeFileSync(join(plain.path, '.git'), 'not a gitdir line\n');
    expect(() => handoffProof.repositoryCommonDirectory(plain.path)).toThrow(/lost its linked gitdir/u);
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
    f.childLeftNothing();
    expect(git(f.repo.path, ['branch', '--list', `gru/${other.id}-child-custody-child`])).toBe('');
  });

  it('refuses a parent whose checkout was removed', async () => {
    const f = await parentFixture('custody-removed');
    rmSync(f.parent.path, { recursive: true, force: true });
    const error = await f.createChild().then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
    f.childLeftNothing();
  });

  it('refuses a parent whose completed handoff receipt changed, before any child Git effect', async () => {
    const f = await parentFixture('custody-receipt');
    const receipt = join(f.admin, 'gru-creation-handoff.json');
    const original = JSON.parse(readFileSync(receipt, 'utf8')) as { state: string; createdAt: string | null };
    expect(original.state).toBe('ready');
    // A well-formed receipt rolled back to its pending phase: it parses, but
    // the completed proof the parent was registered with is gone.
    const pending = JSON.stringify({ ...original, state: 'pending', createdAt: null });
    writeFileSync(receipt, pending);
    expect(readFileSync(receipt, 'utf8')).toBe(pending);
    const error = await f.createChild().then(() => null, (cause: unknown) => cause);
    expect(reasonsOf(error)).toMatch(/handoff unresolved .*completed handoff proof is missing or changed/u);
    f.childLeftNothing();
  });

  it('refuses a parent whose administration is locked, retaining the lock', async () => {
    const f = await parentFixture('custody-locked');
    writeFileSync(join(f.admin, 'locked'), 'foreign custody');
    const error = await f.createChild().then(() => null, (cause: unknown) => cause);
    expect(reasonsOf(error)).toMatch(/handoff unresolved .*managed lane custody is locked or unresolved/u);
    f.childLeftNothing();
    expect(readFileSync(join(f.admin, 'locked'), 'utf8')).toBe('foreign custody');
  });

  it('refuses a parent whose attachment moved to a foreign branch', async () => {
    const f = await parentFixture('custody-attachment');
    git(f.repo.path, ['branch', 'foreign-parent', f.parent.sha]);
    writeFileSync(join(f.admin, 'HEAD'), 'ref: refs/heads/foreign-parent\n');
    const error = await f.createChild().then(() => null, (cause: unknown) => cause);
    expect(reasonsOf(error)).toMatch(/handoff unresolved .*writer handoff attachment changed/u);
    f.childLeftNothing();
    expect(f.h.ledger.getWorktree(f.parent.id)?.status).toBe('active');
  });
});
