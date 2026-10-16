import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

/** Fixture git: the inherited environment minus EVERY `GIT_*` variable (no
 * hook or outer-repository routing can redirect a fixture), plus a fixed
 * identity. */
function git(cwd: string, args: readonly string[]): string {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
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
    // The ORIGINAL setup failure is what surfaces — no layout error masks it.
    const reasons = reasonsOf(error);
    expect(reasons).toMatch(/^worktree setup command exited 7: exit 7\n/u);
    expect(reasons).not.toMatch(/neither a linked worktree administration|has no usable \.git|cannot be resolved/u);
    // Nothing partial survives: no lane administration and no branch.
    expect(existsSync(join(gitdir, 'worktrees')) ? readdirSync(join(gitdir, 'worktrees')) : []).toEqual([]);
    expect(git(repo.path, ['branch', '--list', `gru/${job.id}`])).toBe('');
  });

  it('refuses each malformed gitdir layout by name, with the path and the missing piece', () => {
    const cases: readonly (readonly [string, (gitdir: string) => void, RegExp])[] = [
      ['missing', () => {}, /: it does not exist$/u],
      ['dangling link', (gitdir) => { symlinkSync(join(directory(), 'nowhere'), gitdir); }, /: it does not exist$/u],
      ['looping link', (gitdir) => { symlinkSync(gitdir, gitdir); }, /: it cannot be resolved \(ELOOP\)$/u],
      ['a file', (gitdir) => { writeFileSync(gitdir, 'not a directory'); }, /: it is not a directory$/u],
      ['HEAD only', (gitdir) => { mkdirSync(gitdir); writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/main\n'); }, /: it has no objects directory$/u],
      ['no refs', (gitdir) => { mkdirSync(join(gitdir, 'objects'), { recursive: true }); writeFileSync(join(gitdir, 'HEAD'), 'ref: refs/heads/main\n'); }, /: it has no refs directory$/u],
      ['objects is a file', (gitdir) => { mkdirSync(join(gitdir, 'refs'), { recursive: true }); writeFileSync(join(gitdir, 'HEAD'), 'x'); writeFileSync(join(gitdir, 'objects'), 'x'); }, /: its objects is not a directory$/u],
      ['HEAD is a directory', (gitdir) => { mkdirSync(join(gitdir, 'HEAD'), { recursive: true }); }, /: its HEAD is not a regular file$/u],
      ['empty', (gitdir) => { mkdirSync(gitdir); }, /: it has no HEAD file$/u],
      ['empty commondir', (gitdir) => { mkdirSync(gitdir); writeFileSync(join(gitdir, 'commondir'), '\n'); }, /: its commondir is empty$/u],
      ['dangling commondir', (gitdir) => { mkdirSync(gitdir); writeFileSync(join(gitdir, 'commondir'), '../gone\n'); }, /: its commondir names \.\.\/gone, which cannot be resolved \(ENOENT\)$/u],
      ['commondir to a non-repository', (gitdir) => { mkdirSync(join(gitdir, 'plain'), { recursive: true }); writeFileSync(join(gitdir, 'commondir'), 'plain\n'); }, /: its commondir names .+\/bogus\.git\/plain, which is not a git directory: it has no HEAD file$/u],
      ['commondir to a file', (gitdir) => { mkdirSync(gitdir); writeFileSync(join(gitdir, 'file'), 'x'); writeFileSync(join(gitdir, 'commondir'), 'file\n'); }, /: its commondir names .+\/bogus\.git\/file, which is not a git directory: it is not a directory$/u],
      ['chained commondir', (gitdir) => {
        mkdirSync(join(gitdir, 'next', 'objects'), { recursive: true }); mkdirSync(join(gitdir, 'next', 'refs'));
        writeFileSync(join(gitdir, 'next', 'HEAD'), 'ref: refs/heads/main\n'); writeFileSync(join(gitdir, 'next', 'commondir'), '..\n'); writeFileSync(join(gitdir, 'commondir'), 'next\n');
      }, /: its commondir names .+\/bogus\.git\/next, which is not a git directory: it is itself a linked administration$/u],
      ['uninspectable chained commondir', (gitdir) => {
        mkdirSync(join(gitdir, 'next', 'objects'), { recursive: true }); mkdirSync(join(gitdir, 'next', 'refs'));
        writeFileSync(join(gitdir, 'next', 'HEAD'), 'ref: refs/heads/main\n'); symlinkSync(join(gitdir, 'next', 'commondir'), join(gitdir, 'next', 'commondir')); writeFileSync(join(gitdir, 'commondir'), 'next\n');
      }, /: its commondir names .+\/bogus\.git\/next, which is not a git directory: its commondir cannot be inspected \(ELOOP\)$/u],
      ['unreadable commondir', (gitdir) => { mkdirSync(join(gitdir, 'commondir'), { recursive: true }); }, /: its commondir cannot be read \(handoff metadata is not a regular file\)$/u],
      ['looping HEAD', (gitdir) => { mkdirSync(gitdir); symlinkSync(join(gitdir, 'HEAD'), join(gitdir, 'HEAD')); }, /: its HEAD cannot be inspected \(ELOOP\)$/u],
      ['looping objects', (gitdir) => { mkdirSync(gitdir); writeFileSync(join(gitdir, 'HEAD'), 'x'); symlinkSync(join(gitdir, 'objects'), join(gitdir, 'objects')); }, /: its objects cannot be inspected \(ELOOP\)$/u],
      ['looping refs', (gitdir) => { mkdirSync(join(gitdir, 'objects'), { recursive: true }); writeFileSync(join(gitdir, 'HEAD'), 'x'); symlinkSync(join(gitdir, 'refs'), join(gitdir, 'refs')); }, /: its refs cannot be inspected \(ELOOP\)$/u],
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
    // A .git file without the gitdir prefix, or with more than one line, is no layout at all.
    const plain = fixture('separate-no-prefix');
    rmSync(join(plain.path, '.git'), { recursive: true, force: true });
    writeFileSync(join(plain.path, '.git'), 'not a gitdir line\n');
    expect(() => handoffProof.repositoryCommonDirectory(plain.path)).toThrow(/lost its linked gitdir/u);
    writeFileSync(join(plain.path, '.git'), `gitdir: ${directory()}\nsecond line\n`);
    expect(() => handoffProof.repositoryCommonDirectory(plain.path)).toThrow(/has a \.git file of more than one line/u);
    writeFileSync(join(plain.path, '.git'), `gitdir: ${directory()}\r\nsecond line`);
    expect(() => handoffProof.repositoryCommonDirectory(plain.path)).toThrow(/has a \.git file of more than one line/u);
    // Like git: an empty path is refused, and a file past its bound is unreadable.
    writeFileSync(join(plain.path, '.git'), 'gitdir: \n');
    expect(() => handoffProof.repositoryCommonDirectory(plain.path)).toThrow(`checkout ${plain.path} has a .git file naming an empty gitdir`);
    writeFileSync(join(plain.path, '.git'), `gitdir: ${'x'.repeat(handoffProof.WORKTREE_METADATA_LIMIT)}\n`);
    expect(() => handoffProof.repositoryCommonDirectory(plain.path)).toThrow(`checkout ${plain.path} has an unreadable .git file (handoff metadata exceeds its bound)`);
    // No .git at all is refused by name, with the repository path.
    rmSync(join(plain.path, '.git'), { force: true });
    expect(() => handoffProof.repositoryCommonDirectory(plain.path)).toThrow(`repository ${plain.path} has no usable .git (ENOENT)`);
    // A .git DIRECTORY must be a full git directory too.
    const hollow = fixture('separate-hollow-dotgit');
    rmSync(join(hollow.path, '.git', 'objects'), { recursive: true, force: true });
    expect(() => handoffProof.repositoryCommonDirectory(hollow.path)).toThrow(`repository ${hollow.path} has a .git directory that is not a git directory: it has no objects directory`);
  });

  it('strips only trailing line ends from a .git file, as git does', () => {
    const repo = fixture('separate-line-ends');
    const gitdir = separateGitDir(repo);
    // Any number of trailing CR/LF line ends are no part of the path.
    writeFileSync(join(repo.path, '.git'), `gitdir: ${gitdir}\r\n\n`);
    expect(handoffProof.repositoryCommonDirectory(repo.path)).toBe(gitdir);
    // A trailing space is: git would look for that path, and so does this reading.
    writeFileSync(join(repo.path, '.git'), `gitdir: ${gitdir} \n`);
    expect(() => handoffProof.repositoryCommonDirectory(repo.path))
      .toThrow(`repository gitdir ${gitdir}  is neither a linked worktree administration nor a git directory: it does not exist`);
  });

  it('names the path it resolved to when a gitdir is reached through a link', () => {
    const repo = fixture('separate-linked-gitdir');
    const gitdir = separateGitDir(repo);
    rmSync(join(gitdir, 'HEAD'));
    const alias = join(directory(), 'alias.git');
    symlinkSync(gitdir, alias);
    writeFileSync(join(repo.path, '.git'), `gitdir: ${alias}\n`);
    expect(() => handoffProof.repositoryCommonDirectory(repo.path))
      .toThrow(`repository gitdir ${alias} (resolved to ${gitdir}) is neither a linked worktree administration nor a git directory: it has no HEAD file`);
  });

  it('follows a symlinked .git directory, and refuses a .git symlink to a gitdir file by name', () => {
    const repo = fixture('symlinked-dotgit');
    const real = join(directory(), 'real.git');
    renameSync(join(repo.path, '.git'), real);
    symlinkSync(real, join(repo.path, '.git'));
    expect(handoffProof.repositoryCommonDirectory(repo.path)).toBe(realpathSync(real));
    const gitfileRepo = fixture('symlinked-gitfile');
    const gitdir = separateGitDir(gitfileRepo);
    const gitfile = join(directory(), 'gitfile');
    writeFileSync(gitfile, `gitdir: ${gitdir}\n`);
    rmSync(join(gitfileRepo.path, '.git'));
    symlinkSync(gitfile, join(gitfileRepo.path, '.git'));
    expect(() => handoffProof.repositoryCommonDirectory(gitfileRepo.path)).toThrow(/has a \.git symlink to a gitdir file .* — an unsupported layout/u);
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
    expect(reasonsOf(error)).toMatch(/handoff unresolved .* <- checkout .*job-custody-parent no longer has its linked gitdir file \(ENOENT\)(?: <- |$)/u);
    f.childLeftNothing();
    expect(f.h.ledger.getWorktree(f.parent.id)?.status).toBe('active');
  });

  it('refuses a parent whose .git file was replaced by a directory, by name', async () => {
    const f = await parentFixture('custody-dotgit-replaced');
    rmSync(join(f.parent.path, '.git'));
    mkdirSync(join(f.parent.path, '.git'));
    const error = await f.createChild().then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
    expect(reasonsOf(error)).toMatch(/<- checkout .*job-custody-parent no longer has its linked gitdir file \(\.git is not a regular file\)/u);
    f.childLeftNothing();
    expect(f.h.ledger.getWorktree(f.parent.id)?.status).toBe('active');
  });

  it('refuses a parent whose .git file names a gitdir that is not a directory, by name', async () => {
    const f = await parentFixture('custody-gitdir-file');
    const file = join(directory(), 'not-a-gitdir');
    writeFileSync(file, 'x');
    writeFileSync(join(f.parent.path, '.git'), `gitdir: ${file}\n`);
    const error = await f.createChild().then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
    expect(reasonsOf(error)).toContain(`checkout ${f.parent.path} names gitdir ${file}, which is not a directory`);
    f.childLeftNothing();
    expect(f.h.ledger.getWorktree(f.parent.id)?.status).toBe('active');
  });

  it('refuses a parent whose administration is not a linked worktree administration, by name', async () => {
    const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const corruptions: readonly (readonly [string, (f: Awaited<ReturnType<typeof parentFixture>>) => void, (f: Awaited<ReturnType<typeof parentFixture>>) => RegExp])[] = [
      ['commondir removed', (f) => { rmSync(join(f.admin, 'commondir')); },
        (f) => new RegExp(`lane administration ${escape(f.admin)} has no commondir — it is not a linked worktree administration`, 'u')],
      // The parent's .git pointed at the repository's own git directory: a full git directory, no lane administration.
      ['repository git directory', (f) => { writeFileSync(join(f.parent.path, '.git'), `gitdir: ${realpathSync(join(f.repo.path, '.git'))}\n`); },
        (f) => new RegExp(`lane administration ${escape(realpathSync(join(f.repo.path, '.git')))} has no commondir — it is not a linked worktree administration`, 'u')],
      ['commondir uninspectable', (f) => { rmSync(join(f.admin, 'commondir')); symlinkSync(join(f.admin, 'commondir'), join(f.admin, 'commondir')); },
        (f) => new RegExp(`lane administration ${escape(f.admin)} has a commondir that cannot be inspected \\(ELOOP\\)`, 'u')],
      ['gitdir file removed', (f) => { rmSync(join(f.admin, 'gitdir')); },
        (f) => new RegExp(`lane administration ${escape(f.admin)} has an unreadable gitdir file \\(ENOENT\\)`, 'u')],
      ['gitdir file empty', (f) => { writeFileSync(join(f.admin, 'gitdir'), '\n'); },
        (f) => new RegExp(`lane administration ${escape(f.admin)} has an empty gitdir file`, 'u')],
      ['gitdir file names a missing checkout', (f) => { writeFileSync(join(f.admin, 'gitdir'), '/nowhere/checkout/.git\n'); },
        (f) => new RegExp(`lane administration ${escape(f.admin)} names the checkout git file /nowhere/checkout/\\.git cannot be resolved \\(ENOENT\\)`, 'u')],
      ['HEAD removed', (f) => { rmSync(join(f.admin, 'HEAD')); },
        (f) => new RegExp(`lane administration ${escape(f.admin)} has an unreadable HEAD file \\(ENOENT\\)`, 'u')],
      ['receipt removed', (f) => { rmSync(join(f.admin, 'gru-creation-handoff.json')); },
        (f) => new RegExp(`lane administration ${escape(f.admin)} has no readable handoff receipt \\(ENOENT\\)`, 'u')],
      ['commondir to a non-repository', (f) => { mkdirSync(join(f.admin, 'plain')); writeFileSync(join(f.admin, 'commondir'), 'plain\n'); },
        (f) => new RegExp(`its commondir names ${escape(join(f.admin, 'plain'))}, which is not a git directory: it has no HEAD file`, 'u')],
      ['chained commondir', (f) => {
        const next = join(f.admin, 'next');
        mkdirSync(join(next, 'objects'), { recursive: true }); mkdirSync(join(next, 'refs'));
        writeFileSync(join(next, 'HEAD'), 'ref: refs/heads/main\n'); writeFileSync(join(next, 'commondir'), '..\n'); writeFileSync(join(f.admin, 'commondir'), 'next\n');
      }, (f) => new RegExp(`its commondir names ${escape(join(f.admin, 'next'))}, which is not a git directory: it is itself a linked administration`, 'u')],
    ];
    for (const [label, corrupt, reason] of corruptions) {
      const f = await parentFixture(`custody-admin-${label.replace(/\W+/gu, '-')}`);
      corrupt(f);
      const error = await f.createChild().then(() => null, (cause: unknown) => cause);
      expect(error, label).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
      expect(reasonsOf(error), label).toMatch(reason(f));
      f.childLeftNothing();
      expect(f.h.ledger.getWorktree(f.parent.id)?.status, label).toBe('active');
    }
  });

  it('a handoff begun for a path that cannot be resolved is refused by name, before any receipt', async () => {
    const f = await parentFixture('custody-begin-unresolved');
    const gone = join(directory(), 'gone');
    const before = readdirSync(f.admin).sort();
    expect(() => handoffProof.beginLaneHandoff({ ...f.parent, repoPath: gone }, f.admin, 'token-0123456789abcdef'))
      .toThrow(`repository ${gone} cannot be resolved (ENOENT)`);
    expect(() => handoffProof.beginLaneHandoff({ ...f.parent, path: gone }, f.admin, 'token-0123456789abcdef'))
      .toThrow(`checkout ${gone} cannot be resolved (ENOENT)`);
    expect(readdirSync(f.admin).sort()).toEqual(before);
    // A receipt that cannot be published (one is already there) is refused
    // by name, and its temporary receipt is removed.
    expect(() => handoffProof.beginLaneHandoff(f.parent, f.admin, 'token-0123456789abcdef'))
      .toThrow(`lane administration ${f.admin} cannot take a handoff receipt (EEXIST)`);
    expect(readdirSync(f.admin).sort()).toEqual(before);
  });

  it('refuses a parent whose git administration was removed, by name', async () => {
    const f = await parentFixture('custody-admin-removed');
    rmSync(f.admin, { recursive: true, force: true });
    const error = await f.createChild().then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
    expect(reasonsOf(error)).toMatch(new RegExp(`names gitdir ${f.admin.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}, which cannot be resolved \\(ENOENT\\)`, 'u'));
    f.childLeftNothing();
  });

  it('refuses a parent whose completed handoff receipt changed, before any child Git effect', async () => {
    const f = await parentFixture('custody-receipt');
    const receipt = join(f.admin, 'gru-creation-handoff.json');
    const bytes = readFileSync(receipt, 'utf8');
    const original = JSON.parse(bytes) as { state: string; createdAt: string | null };
    expect(original.state).toBe('ready');
    // The issuer writes compact JSON in this key order, so the rewrite below
    // is a receipt it could have written.
    expect(JSON.stringify(original)).toBe(bytes);
    // A well-formed receipt rolled back to its pending phase: it parses, but
    // the completed proof the parent was registered with is gone.
    writeFileSync(receipt, JSON.stringify({ ...original, state: 'pending', createdAt: null }));
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
