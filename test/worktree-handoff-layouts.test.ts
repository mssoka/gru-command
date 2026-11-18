import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative as relativePath } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// node:fs passes through; a test may make one write or removal fail.
const { fsHooks } = vi.hoisted(() => ({ fsHooks: {
  beforeWrite: null as ((path: string) => void) | null,
  beforeUnlink: null as ((path: string) => void) | null,
  beforeFsync: null as ((fd: number) => void) | null,
  beforeClose: null as ((fd: number) => void) | null,
} }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: ((...args: Parameters<typeof actual.writeFileSync>) => { fsHooks.beforeWrite?.(String(args[0])); return actual.writeFileSync(...args); }) as typeof actual.writeFileSync,
    unlinkSync: ((...args: Parameters<typeof actual.unlinkSync>) => { fsHooks.beforeUnlink?.(String(args[0])); return actual.unlinkSync(...args); }) as typeof actual.unlinkSync,
    fsyncSync: ((fd: number) => { fsHooks.beforeFsync?.(fd); return actual.fsyncSync(fd); }) as typeof actual.fsyncSync,
    closeSync: ((fd: number) => { fsHooks.beforeClose?.(fd); return actual.closeSync(fd); }) as typeof actual.closeSync,
  };
});
afterEach(() => { fsHooks.beforeWrite = null; fsHooks.beforeUnlink = null; fsHooks.beforeFsync = null; fsHooks.beforeClose = null; });
/** An fsync hook failing only a directory's sync — by what the fd is, never by counting syncs. */
const failDirectorySync = (code: string) => (fd: number): void => {
  if (fstatSync(fd).isDirectory()) throw Object.assign(new Error('sync failed'), { code });
};
/** Fail only the WORKTREE ADMIN directory's fsync, so an earlier durable
 * creation receipt (issue #453) is written normally and the handoff
 * receipt's own durability is the one under test. */
const failWorktreeAdminSync = (code: string, repoPath: string) => (fd: number): void => {
  if (!fstatSync(fd).isDirectory()) return;
  const container = join(realpathSync(join(repoPath, '.git')), 'worktrees');
  if (!existsSync(container)) return;
  const ino = fstatSync(fd).ino;
  if (readdirSync(container).some((entry) => { try { return statSync(join(container, entry)).ino === ino; } catch { return false; } })) {
    throw Object.assign(new Error('sync failed'), { code });
  }
};
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import * as handoffProof from '../src/worktrees/handoff.js';
import { sweepWorkNotice, WorktreeManager, type SavedWork, type WorktreeManagerOptions } from '../src/worktrees/manager.js';
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

function manager(extra: Partial<WorktreeManagerOptions> = {}): { readonly ledger: LedgerApi; readonly worktrees: WorktreeManager; readonly root: string } {
  const db = new LedgerDb(directory());
  dbs.push(db);
  const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
  const root = directory();
  return { ledger, root, worktrees: new WorktreeManager({ ledger, root, preserveRoot: directory(), setupTimeoutMs: 30_000, enumerateProcesses: () => [], ...extra }) };
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

  // This case builds 22 real parent fixtures (each a git repo plus a linked
  // worktree) and corrupts one administration in each. On a co-tenant host
  // the 2026-10-27 #511 full run observed a single fixture init take 30.6s
  // (normally ~0.3s), so the 30s fast-phase default cut the case mid-loop.
  // The work and its assertions are unchanged; the case carries the budget
  // its real git workload needs under the load the suite actually sees.
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
        (f) => new RegExp(`lane administration ${escape(f.admin)}'s checkout git file /nowhere/checkout/\\.git cannot be resolved \\(ENOENT\\)`, 'u')],
      ['gitdir file of two lines', (f) => { writeFileSync(join(f.admin, 'gitdir'), `${join(f.parent.path, '.git')}\nsecond\n`); },
        (f) => new RegExp(`lane administration ${escape(f.admin)} has a gitdir file of more than one line`, 'u')],
      ['writer branch ref unreadable', (f) => {
        const ref = join(realpathSync(join(f.repo.path, '.git')), 'refs', 'heads', f.parent.branch!);
        rmSync(ref); mkdirSync(ref);
      }, () => /writer branch ref .* is unreadable \(handoff metadata is not a regular file\)/u],
      ['writer branch ref through a link', (f) => {
        const ref = join(realpathSync(join(f.repo.path, '.git')), 'refs', 'heads', f.parent.branch!);
        const elsewhere = join(directory(), 'ref'); writeFileSync(elsewhere, readFileSync(ref)); rmSync(ref); symlinkSync(elsewhere, ref);
      }, () => /writer branch is not direct: its ref .* is reached through a link/u],
      ['writer branch ref dangling link', (f) => {
        // packed-refs lists the branch: a fall-through to it would pass.
        const common = realpathSync(join(f.repo.path, '.git'));
        git(f.repo.path, ['pack-refs', '--all']);
        const ref = join(common, 'refs', 'heads', f.parent.branch!);
        rmSync(ref, { force: true }); mkdirSync(dirname(ref), { recursive: true }); symlinkSync(join(directory(), 'missing'), ref);
      }, () => /writer branch ref .* cannot be resolved \(ENOENT\)/u],
      ['writer branch ref a looping link', (f) => {
        const ref = join(realpathSync(join(f.repo.path, '.git')), 'refs', 'heads', f.parent.branch!);
        rmSync(ref); symlinkSync(ref, ref);
      }, () => /writer branch ref .* cannot be resolved \(ELOOP\)/u],
      ['writer branch ref under a file', (f) => {
        // The branch directory replaced by a file: corruption, never absence.
        const common = realpathSync(join(f.repo.path, '.git'));
        const branchDir = dirname(join(common, 'refs', 'heads', f.parent.branch!));
        rmSync(branchDir, { recursive: true }); writeFileSync(branchDir, 'x');
      }, () => /writer branch ref .* cannot be inspected \(ENOTDIR\)/u],
      ['writer refs/heads a link', (f) => {
        const common = realpathSync(join(f.repo.path, '.git'));
        renameSync(join(common, 'refs', 'heads'), join(common, 'refs', 'heads-real'));
        symlinkSync(join(common, 'refs', 'heads-real'), join(common, 'refs', 'heads'));
      }, () => /writer branch is not direct: its ref .* lies under a linked directory .*\/refs\/heads$/u],
      ['writer branch ref under a dangling directory link', (f) => {
        const common = realpathSync(join(f.repo.path, '.git'));
        git(f.repo.path, ['pack-refs', '--all']);
        const branchDir = dirname(join(common, 'refs', 'heads', f.parent.branch!));
        rmSync(branchDir, { recursive: true, force: true }); symlinkSync(join(directory(), 'gone'), branchDir);
      }, () => /writer branch is not direct: its ref .* lies under a linked directory/u],
      ['packed refs a looping link', (f) => {
        const common = realpathSync(join(f.repo.path, '.git'));
        rmSync(join(common, 'refs', 'heads', f.parent.branch!)); rmSync(join(common, 'packed-refs'), { force: true });
        symlinkSync(join(common, 'packed-refs'), join(common, 'packed-refs'));
      }, () => /packed refs .*packed-refs is unreadable \(handoff metadata is not a regular file\)/u],
      ['writer branch ref junk', (f) => {
        writeFileSync(join(realpathSync(join(f.repo.path, '.git')), 'refs', 'heads', f.parent.branch!), 'junk\n');
      }, () => /writer branch is not direct: its ref .* does not hold a commit id of the lane's length/u],
      ['packed refs unreadable', (f) => {
        const common = realpathSync(join(f.repo.path, '.git'));
        rmSync(join(common, 'refs', 'heads', f.parent.branch!)); rmSync(join(common, 'packed-refs'), { force: true }); mkdirSync(join(common, 'packed-refs'));
      }, () => /packed refs .*packed-refs is unreadable \(handoff metadata is not a regular file\)/u],
      ['no writer ref at all', (f) => {
        const common = realpathSync(join(f.repo.path, '.git'));
        rmSync(join(common, 'refs', 'heads', f.parent.branch!)); rmSync(join(common, 'packed-refs'), { force: true });
      }, (f) => new RegExp(`writer branch ${escape(f.parent.branch!)} has neither a loose ref nor a packed-refs file`, 'u')],
      ['gitdir file holding a NUL', (f) => { writeFileSync(join(f.admin, 'gitdir'), `${join(f.parent.path, '.git')}\0\n`); },
        (f) => new RegExp(`lane administration ${escape(f.admin)} has a gitdir file holding a NUL byte`, 'u')],
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
      try {
        corrupt(f);
        const error = await f.createChild().then(() => null, (cause: unknown) => cause);
        expect(error, label).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
        expect(reasonsOf(error), label).toMatch(reason(f));
      } finally {
        // Git itself cannot list branches past a packed-refs directory: undo
        // that case's corruption whatever the assertions above found.
        if (label.startsWith('packed refs')) rmSync(join(realpathSync(join(f.repo.path, '.git')), 'packed-refs'), { recursive: true, force: true });
        // Git cannot list branches past a branch directory turned file or link either.
        if (label.startsWith('writer branch ref under')) {
          const branchDir = dirname(join(realpathSync(join(f.repo.path, '.git')), 'refs', 'heads', f.parent.branch!));
          rmSync(branchDir, { recursive: true, force: true });
        }
      }
      f.childLeftNothing();
      expect(f.h.ledger.getWorktree(f.parent.id)?.status, label).toBe('active');
    }
  }, 120_000);

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
    const token = 'token-0123456789abcdef';
    expect(() => handoffProof.beginLaneHandoff(f.parent, f.admin, token))
      .toThrow(new RegExp(`^lane administration ${f.admin.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} cannot take a handoff receipt \\(EEXIST\\)$`, 'u'));
    expect(readdirSync(f.admin).sort()).toEqual(before);
    const temp = `${join(f.admin, 'gru-creation-handoff.json')}.${token.slice(13)}`;
    // ...and when its temporary receipt cannot be removed either, that is named with its reason.
    fsHooks.beforeUnlink = (path) => { if (path === temp) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
    expect(() => handoffProof.beginLaneHandoff(f.parent, f.admin, token))
      .toThrow(`lane administration ${f.admin} cannot take a handoff receipt (EEXIST) and its temporary receipt could not be removed (EBUSY)`);
    fsHooks.beforeUnlink = null;
    rmSync(temp);
    // A write that fails partway (the exclusive open made the file) still removes it.
    fsHooks.beforeWrite = (path) => {
      if (!/^\d+$/u.test(path)) return;
      fsHooks.beforeWrite = null;
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    };
    expect(() => handoffProof.beginLaneHandoff(f.parent, f.admin, token)).toThrow(`lane administration ${f.admin} cannot take a handoff receipt (ENOSPC)`);
    expect(readdirSync(f.admin).sort()).toEqual(before);
    // An fsync failure is the write's failure: the temp is removed, and a
    // close failure after it never replaces the reported reason.
    let failed = -1;
    fsHooks.beforeFsync = (fd) => { fsHooks.beforeFsync = null; failed = fd; throw Object.assign(new Error('io'), { code: 'EIO' }); };
    fsHooks.beforeClose = (fd) => {
      if (fd !== failed) return;
      fsHooks.beforeClose = null;
      closeSync(fd);
      throw Object.assign(new Error('close'), { code: 'EBADF' });
    };
    expect(() => handoffProof.beginLaneHandoff(f.parent, f.admin, token)).toThrow(`lane administration ${f.admin} cannot take a handoff receipt (EIO)`);
    fsHooks.beforeClose = null;
    expect(readdirSync(f.admin).sort()).toEqual(before);
    // A filesystem that cannot fsync is no reason to refuse.
    expect(() => { fsHooks.beforeFsync = () => { throw Object.assign(new Error('unsupported'), { code: 'EINVAL' }); }; try { handoffProof.beginLaneHandoff(f.parent, f.admin, token); } finally { fsHooks.beforeFsync = null; } })
      .toThrow(`lane administration ${f.admin} cannot take a handoff receipt (EEXIST)`);
    expect(readdirSync(f.admin).sort()).toEqual(before);
    // A temporary name that already existed is not this call's to remove.
    writeFileSync(temp, 'foreign');
    expect(() => handoffProof.beginLaneHandoff(f.parent, f.admin, token)).toThrow(`lane administration ${f.admin} cannot take a handoff receipt (EEXIST)`);
    expect(readFileSync(temp, 'utf8')).toBe('foreign');
    rmSync(temp);
    // A published receipt whose temporary file cannot be removed says so.
    const receipt = readFileSync(join(f.admin, 'gru-creation-handoff.json'), 'utf8');
    rmSync(join(f.admin, 'gru-creation-handoff.json'));
    fsHooks.beforeUnlink = (path) => { if (path === temp) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
    expect(() => handoffProof.beginLaneHandoff(f.parent, f.admin, token))
      .toThrow(`lane administration ${f.admin} published its handoff receipt and its temporary receipt could not be removed (EBUSY)`);
    fsHooks.beforeUnlink = null;
    rmSync(temp);
    // A receipt published but not made durable is named as published, never as untaken.
    rmSync(join(f.admin, 'gru-creation-handoff.json'));
    fsHooks.beforeFsync = failDirectorySync('EIO');
    expect(() => handoffProof.beginLaneHandoff(f.parent, f.admin, token))
      .toThrow(`lane administration ${f.admin} published its handoff receipt but could not make it durable (EIO)`);
    fsHooks.beforeFsync = null;
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(join(f.admin, 'gru-creation-handoff.json'))).toBe(true);
    // ...and when its temporary receipt cannot be removed either, both are said.
    rmSync(join(f.admin, 'gru-creation-handoff.json'));
    fsHooks.beforeFsync = failDirectorySync('EIO');
    fsHooks.beforeUnlink = (path) => { if (path === temp) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
    expect(() => handoffProof.beginLaneHandoff(f.parent, f.admin, token))
      .toThrow(`lane administration ${f.admin} published its handoff receipt but could not make it durable (EIO), and its temporary receipt could not be removed (EBUSY)`);
    fsHooks.beforeFsync = null; fsHooks.beforeUnlink = null;
    rmSync(temp);
    // ...and with the directory's close failing too, every failure is in the cause.
    rmSync(join(f.admin, 'gru-creation-handoff.json'));
    fsHooks.beforeFsync = failDirectorySync('EIO');
    fsHooks.beforeClose = (fd) => {
      if (!fstatSync(fd).isDirectory()) return;
      fsHooks.beforeClose = null;
      closeSync(fd);
      throw Object.assign(new Error('close'), { code: 'EBADF' });
    };
    fsHooks.beforeUnlink = (path) => { if (path === temp) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
    const all = (() => { try { handoffProof.beginLaneHandoff(f.parent, f.admin, token); return null; } catch (error) { return error as Error; } })();
    fsHooks.beforeFsync = null; fsHooks.beforeClose = null; fsHooks.beforeUnlink = null;
    expect(all).not.toBeNull();
    expect(all!.message).toBe(`lane administration ${f.admin} published its handoff receipt but could not make it durable (EIO), and its temporary receipt could not be removed (EBUSY)`);
    // The temporary name carries the token's tail; no message names it.
    expect(all!.message).not.toContain(token.slice(13));
    const [durability, cleanup] = (all!.cause as AggregateError).errors as [AggregateError, { code: string }];
    expect([(durability.errors as { code: string }[]).map((error) => error.code), cleanup.code]).toEqual([['EIO', 'EBADF'], 'EBUSY']);
    rmSync(temp);
    // ...nor does the directory's close failure replace its sync failure.
    rmSync(join(f.admin, 'gru-creation-handoff.json'));
    let directoryFd = -1;
    let closeFired = false;
    fsHooks.beforeFsync = (fd) => { if (fstatSync(fd).isDirectory()) { directoryFd = fd; throw Object.assign(new Error('io'), { code: 'EIO' }); } };
    const failDirectoryClose = (fd: number): void => {
      if (!fstatSync(fd).isDirectory()) return;
      fsHooks.beforeClose = null;
      closeFired = true;
      closeSync(fd);
      throw Object.assign(new Error('close'), { code: 'EBADF' });
    };
    fsHooks.beforeClose = failDirectoryClose;
    const both = (() => { try { handoffProof.beginLaneHandoff(f.parent, f.admin, token); return null; } catch (error) { return error as Error; } })();
    fsHooks.beforeFsync = null; fsHooks.beforeClose = null;
    expect(both).not.toBeNull();
    expect(both?.message).toBe(`lane administration ${f.admin} published its handoff receipt but could not make it durable (EIO)`);
    expect([directoryFd > -1, closeFired]).toEqual([true, true]);
    // ...the close failure travels with it.
    expect(((both?.cause as AggregateError).errors as { code: string }[]).map((error) => error.code)).toEqual(['EIO', 'EBADF']);
    expect(existsSync(temp)).toBe(false);
    // Even a sync that throws no error object at all is a failure, never success.
    rmSync(join(f.admin, 'gru-creation-handoff.json'));
    fsHooks.beforeFsync = (fd) => { if (fstatSync(fd).isDirectory()) throw undefined as unknown as Error; };
    expect(() => handoffProof.beginLaneHandoff(f.parent, f.admin, token))
      .toThrow(`lane administration ${f.admin} published its handoff receipt but could not make it durable (undefined)`);
    fsHooks.beforeFsync = null;
    expect(existsSync(temp)).toBe(false);
    // A directory close failure alone, after a sync that succeeded, is a failure to make it durable too.
    rmSync(join(f.admin, 'gru-creation-handoff.json'));
    closeFired = false;
    fsHooks.beforeClose = failDirectoryClose;
    expect(() => handoffProof.beginLaneHandoff(f.parent, f.admin, token))
      .toThrow(`lane administration ${f.admin} published its handoff receipt but could not make it durable (EBADF)`);
    fsHooks.beforeClose = null;
    expect(closeFired).toBe(true);
    expect(existsSync(temp)).toBe(false);
    // A filesystem that cannot fsync a file, or a directory (EINVAL, ENOTSUP), publishes all the same.
    for (const code of ['EINVAL', 'ENOTSUP']) {
      for (const kind of ['file', 'directory'] as const) {
        rmSync(join(f.admin, 'gru-creation-handoff.json'));
        let refused = 0;
        fsHooks.beforeFsync = (fd) => {
          if (fstatSync(fd).isDirectory() !== (kind === 'directory')) return;
          refused += 1;
          throw Object.assign(new Error('unsupported'), { code });
        };
        try {
          expect(() => handoffProof.beginLaneHandoff(f.parent, f.admin, token), `${code} ${kind}`).not.toThrow();
        } finally { fsHooks.beforeFsync = null; }
        expect(refused, `${code} ${kind}`).toBe(1);
        expect(existsSync(join(f.admin, 'gru-creation-handoff.json')), `${code} ${kind}`).toBe(true);
        expect(existsSync(temp), `${code} ${kind}`).toBe(false);
      }
    }
    writeFileSync(join(f.admin, 'gru-creation-handoff.json'), receipt);
    expect(readdirSync(f.admin).sort()).toEqual(before);
  });

  it('a lane whose published receipt cannot be made durable is rolled back whole, receipt and all — job, review and child alike', async () => {
    const admins = (repoPath: string): string[] => {
      const dir = join(realpathSync(join(repoPath, '.git')), 'worktrees');
      return existsSync(dir) ? readdirSync(dir).sort() : [];
    };
    /** Retained creation receipts (#453): a rolled-back attempt spends its own. */
    const creationReceipts = (repoPath: string): string[] => {
      const dir = join(realpathSync(join(repoPath, '.git')), 'gru-creation');
      return existsSync(dir) ? readdirSync(dir).filter((entry) => entry.endsWith('.json')) : [];
    };
    /** Every lane checkout under a manager's root, as `<repo>/<lane>`. */
    const checkouts = (root: string): string[] => (existsSync(root)
      ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
        .flatMap((repo) => readdirSync(join(root, repo.name)).map((lane) => `${repo.name}/${lane}`)).sort()
      : []);
    // A job lane, and a review lane.
    for (const kind of ['job', 'review'] as const) {
      const repo = fixture(`undurable-${kind}`);
      const h = manager();
      const job = h.ledger.addJob({ id: `undurable-${kind}`, repo: 'assigned', title: kind });
      const before = admins(repo.path);
      const lanesBefore = checkouts(h.root);
      fsHooks.beforeFsync = failWorktreeAdminSync('EIO', repo.path);
      try {
        const creating = kind === 'job'
          ? h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id })
          : h.worktrees.createReviewWorktree({ repoPath: repo.path, roundId: `round-${kind}`, ref: git(repo.path, ['rev-parse', 'HEAD']), jobId: job.id });
        await expect(creating, kind).rejects.toThrow(/published its handoff receipt but could not make it durable \(EIO\)$/u);
      } finally { fsHooks.beforeFsync = null; }
      expect(h.ledger.getWorktree(kind === 'job' ? job.id : `round-${kind}`), kind).toBeNull();
      expect(admins(repo.path), kind).toEqual(before);
      // No checkout is left behind (a review lane is detached: it never had a branch).
      expect(checkouts(h.root), kind).toEqual(lanesBefore);
      if (kind === 'job') expect(git(repo.path, ['branch', '--list', `gru/${job.id}`])).toBe('');
      // The creation receipt is spent with the rollback (#453).
      expect(creationReceipts(repo.path), kind).toEqual([]);
    }
    // A child lane.
    const f = await parentFixture('custody-undurable');
    fsHooks.beforeFsync = failWorktreeAdminSync('EIO', f.repo.path);
    try {
      await expect(f.createChild()).rejects.toThrow(/published its handoff receipt but could not make it durable \(EIO\)$/u);
    } finally { fsHooks.beforeFsync = null; }
    f.childLeftNothing();
    expect(admins(f.repo.path)).toEqual([basename(f.admin)]);
    expect(creationReceipts(f.repo.path)).toEqual([]);
  });

  it('a receipt gone after capture is refused by name at the next check', async () => {
    const f = await parentFixture('custody-receipt-gone');
    const check = handoffProof.capturePortLaneHandoff(f.h.worktrees, f.parent);
    rmSync(join(f.admin, 'gru-creation-handoff.json'));
    const error = (() => { try { check(); return null; } catch (caught) { return caught; } })();
    expect(error).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
    expect(reasonsOf(error)).toContain(`lane administration ${f.admin} has an unreadable gru-creation-handoff.json file (ENOENT)`);
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

describe('lane release in a repository whose worktree inventory holds other lanes and folders GC did not create', () => {
  type Fixture = Awaited<ReturnType<typeof laneFixture>>;
  const kindsOf = (h: ReturnType<typeof manager>): readonly string[] => h.ledger.listEvents({ limit: 1000 }).map((event) => event.kind);
  const eventsOf = (h: ReturnType<typeof manager>, kind: string) => h.ledger.listEvents({ limit: 1000 }).filter((event) => event.kind === kind);
  const adminOf = (lane: { readonly path: string }): string => git(lane.path, ['rev-parse', '--absolute-git-dir']);
  const outcomeOf = <T>(run: Promise<T>) => run.then((result) => ({ result, error: null as unknown }), (error: unknown) => ({ result: null, error }));

  async function laneFixture(name: string, extra: Partial<WorktreeManagerOptions> = {}) {
    const repo = fixture(name);
    const h = manager(extra);
    const job = h.ledger.addJob({ id: name, repo: 'assigned', title: 'release custody' });
    const lane = await h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    return { repo, h, lane, container: join(handoffProof.repositoryCommonDirectory(repo.path), 'worktrees') };
  }

  /** One folder of the inventory, holding exactly `files`. Git prunes the
   * inventory itself once its last worktree is removed, so it is made again. */
  function folder(container: string, name: string, files: Readonly<Record<string, string>>): string {
    const path = join(container, name);
    mkdirSync(path, { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(path, file), text);
    return path;
  }

  /** What the owner's repository holds besides the lane: two sibling lanes of
   * its own, desktop-tool worktrees whose folders never held a gitdir, a
   * worktree whose checkout was deleted (git would prune it), one whose
   * checkout stood under a folder that is gone, and folders that cannot be
   * told what they are (a backlink that is no path, an empty one, a folder
   * where the backlink should be, an unreadable receipt, another lane's
   * receipt, a plain file). None is the lane's. */
  async function seedOthers(f: Fixture) {
    const siblings = [];
    for (const id of ['sibling-a', 'sibling-b']) {
      const job = f.h.ledger.addJob({ id: `${f.lane.id}-${id}`, repo: 'assigned', title: id });
      siblings.push(await f.h.worktrees.createJobWorktree({ repoPath: f.repo.path, jobId: job.id }));
    }
    const receipt = JSON.parse(readFileSync(join(adminOf(f.lane), 'gru-creation-handoff.json'), 'utf8')) as Record<string, unknown>;
    const before = new Set(readdirSync(f.container));
    const prunable = join(directory(), 'prunable-checkout');
    git(f.repo.path, ['worktree', 'add', '--detach', '-q', prunable]);
    rmSync(prunable, { recursive: true, force: true });
    const prunableFolders = readdirSync(f.container).filter((entry) => !before.has(entry)).map((entry) => join(f.container, entry));
    expect(prunableFolders).toHaveLength(1);
    const stray = join(f.container, 'stray-file');
    writeFileSync(stray, 'x');
    const folderBacklink = folder(f.container, 'folder-backlink', {});
    mkdirSync(join(folderBacklink, 'gitdir'));
    const others = [
      folder(f.container, 'desktop-a', { HEAD: 'ref: refs/heads/main\n', commondir: '../..\n', 'desktop-worktree-marker': '' }),
      folder(f.container, 'desktop-b', { HEAD: 'ref: refs/heads/main\n', commondir: '../..\n', 'desktop-worktree-marker': '' }),
      folder(f.container, 'gone-parent', { gitdir: `${join(directory(), 'missing', 'checkout', '.git')}\n` }),
      folder(f.container, 'odd-backlink', { gitdir: 'not-a-checkout\n' }),
      folder(f.container, 'empty-backlink', { gitdir: '' }),
      folderBacklink,
      folder(f.container, 'unreadable-receipt', { 'gru-creation-handoff.json': '{' }),
      folder(f.container, 'other-lane-receipt', { 'gru-creation-handoff.json': JSON.stringify({ ...receipt, id: 'other-lane', path: `${String(receipt.path)}-other` }) }),
      stray,
      ...prunableFolders,
    ];
    return { siblings, others };
  }

  /** The lane's checkout, administration, branch and row as they were, and
   * nothing recorded about its release. */
  function expectUntouched(f: Fixture, why: string): void {
    expect(existsSync(f.lane.path), why).toBe(true);
    expect(git(f.repo.path, ['worktree', 'list', '--porcelain']), why).toContain(`worktree ${realpathSync(f.lane.path)}`);
    expect(existsSync(join(adminOf(f.lane), 'gru-creation-handoff.json')), why).toBe(true);
    expect(git(f.repo.path, ['branch', '--list', f.lane.branch ?? '']), why).not.toBe('');
    expect(f.h.ledger.getWorktree(f.lane.id)?.status, why).toBe('active');
    expect(kindsOf(f.h).filter((kind) => /^worktree\.(?:swept|preserved|reconciled|release-aborted|sweep-tail-failed)$/u.test(kind)), why).toEqual([]);
  }

  /** A `log` option that acts once, the first time the release's own tail
   * resolves the base after its checkout is gone: a foreign tool, or the path
   * re-created, at that moment is the race a removal leaves open. */
  function afterRemoval() {
    let target: { readonly path: string; readonly act: () => void } | null = null;
    const log: WorktreeManagerOptions['log'] = (_level, message) => {
      if (target !== null && message.startsWith('base resolution degraded') && !existsSync(target.path)) {
        const { act } = target;
        target = null;
        act();
      }
    };
    return { log, arm: (path: string, act: () => void): void => { target = { path, act }; } };
  }

  it('completes the release, with its usual record, beside sibling lanes and folders that are not its own', async () => {
    const f = await laneFixture('release-beside-others');
    const { siblings, others } = await seedOthers(f);
    const outcome = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
    expect(outcome.error).toBeNull();
    expect(outcome.result?.status).toBe('swept');
    expect(existsSync(f.lane.path)).toBe(false);
    expect(f.h.ledger.getWorktree(f.lane.id)?.status).toBe('swept');
    expect(eventsOf(f.h, 'worktree.swept').map((event) => (event.payload as { id: string }).id)).toEqual([f.lane.id]);
    expect(eventsOf(f.h, 'worktree.sweep-tail-failed')).toEqual([]);
    expect(git(f.repo.path, ['worktree', 'list', '--porcelain']).split('\n')).not.toContain(`worktree ${join(realpathSync(dirname(f.lane.path)), basename(f.lane.path))}`);
    // Nothing of the others' is touched.
    for (const sibling of siblings) {
      expect(existsSync(sibling.path)).toBe(true);
      expect(f.h.ledger.getWorktree(sibling.id)?.status).toBe('active');
    }
    for (const other of others) expect(existsSync(other), other).toBe(true);
  }, 120_000);

  it('refuses with a 400-class custody error before removing anything on a pre-removal conflict, and completes once it is cleared', async () => {
    const cases: readonly (readonly [string, (f: Fixture) => () => void])[] = [
      ['a handoff receipt rolled back to pending', (f) => {
        const file = join(adminOf(f.lane), 'gru-creation-handoff.json');
        const bytes = readFileSync(file, 'utf8');
        writeFileSync(file, JSON.stringify({ ...(JSON.parse(bytes) as Record<string, unknown>), state: 'pending', createdAt: null }));
        return () => writeFileSync(file, bytes);
      }],
      ['a locked administration', (f) => {
        const file = join(adminOf(f.lane), 'locked');
        writeFileSync(file, 'foreign custody');
        return () => rmSync(file);
      }],
      ['a second folder holding a receipt for the lane', (f) => {
        const receipt = readFileSync(join(adminOf(f.lane), 'gru-creation-handoff.json'), 'utf8');
        const second = folder(f.container, 'stale-administration', { 'gru-creation-handoff.json': receipt });
        return () => rmSync(second, { recursive: true, force: true });
      }],
      ['a second folder whose backlink names the checkout', (f) => {
        const second = folder(f.container, 'second-administration', { gitdir: `${join(realpathSync(dirname(f.lane.path)), basename(f.lane.path), '.git')}\n` });
        return () => rmSync(second, { recursive: true, force: true });
      }],
    ];
    for (const [label, conflict] of cases) {
      const f = await laneFixture(`release-conflict-${label.replace(/\W+/gu, '-')}`);
      const clear = conflict(f);
      const outcome = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
      expect(outcome.error, label).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
      expectUntouched(f, label);
      clear();
      expect((await f.h.worktrees.release({ worktreeId: f.lane.id })).status, label).toBe('swept');
      expect(kindsOf(f.h), label).toContain('worktree.swept');
    }
  }, 120_000);

  it('still pauses a release before anything is removed while a process works in the lane', async () => {
    const f = await laneFixture('release-live-process', {
      enumerateProcesses: (tree) => [{ pid: 2_000_000, command: 'node serve.js', evidence: 'cwd', cwd: tree }],
    });
    const result = await f.h.worktrees.release({ worktreeId: f.lane.id });
    expect(result.status).toBe('paused');
    expect(existsSync(f.lane.path)).toBe(true);
    expect(existsSync(join(adminOf(f.lane), 'gru-creation-handoff.json'))).toBe(true);
    expect(git(f.repo.path, ['branch', '--list', f.lane.branch ?? ''])).not.toBe('');
    expect(kindsOf(f.h).filter((kind) => /^worktree\.(?:swept|reconciled|release-aborted|sweep-tail-failed)$/u.test(kind))).toEqual([]);
  });

  it('records the verify stage and refuses with the residue when its own resources stand after the removal, and a later release finishes', async () => {
    for (const label of ['its checkout path is re-created', 'its administration folder is still there', 'its administration folder is back with nothing but a HEAD file'] as const) {
      const hook = afterRemoval();
      const f = await laneFixture(`release-residue-${label.replace(/\W+/gu, '-')}`, { log: hook.log });
      const admin = adminOf(f.lane);
      const residue = label === 'its checkout path is re-created' ? [f.lane.path] : [admin];
      const resource = residue[0]!;
      hook.arm(f.lane.path, () => {
        if (resource === f.lane.path) mkdirSync(resource, { recursive: true });
        else {
          // With a backlink the inventory names it; with none, and no receipt, only the lane's own folder, found by its name, can.
          const files: Record<string, string> = label === 'its administration folder is still there'
            ? { gitdir: `${join(realpathSync(dirname(f.lane.path)), basename(f.lane.path), '.git')}\n` }
            : { HEAD: 'ref: refs/heads/main\n' };
          folder(dirname(resource), basename(resource), files);
        }
      });
      const outcome = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
      expect(outcome.error, label).toMatchObject({ name: 'LaneResidueError', residue });
      expect((outcome.error as Error).message, label).toContain(resource);
      expect(f.h.ledger.getWorktree(f.lane.id)?.status, label).toBe('active');
      expect(kindsOf(f.h), label).not.toContain('worktree.swept');
      expect(eventsOf(f.h, 'worktree.sweep-tail-failed').map((event) => event.payload), label).toEqual([
        { id: f.lane.id, stage: 'verify', error: (outcome.error as Error).message, residue },
      ]);
      expect(git(f.repo.path, ['branch', '--list', f.lane.branch ?? ''])).not.toBe('');
      // The row stays, and the same release finishes once the residue is cleared.
      rmSync(resource, { recursive: true, force: true });
      expect((await f.h.worktrees.release({ worktreeId: f.lane.id })).status, label).toBe('swept');
      expect(f.h.ledger.getWorktree(f.lane.id)?.status, label).toBe('swept');
      expect(kindsOf(f.h), label).toContain('worktree.reconciled');
    }
  }, 120_000);

  it('completes a release whose removal ran even when other folders turn up broken meanwhile', async () => {
    const hook = afterRemoval();
    const f = await laneFixture('release-others-after-removal', { log: hook.log });
    const admin = adminOf(f.lane);
    hook.arm(f.lane.path, () => {
      folder(f.container, 'raced-odd-backlink', { gitdir: 'not-a-checkout\n' });
      writeFileSync(join(f.container, 'raced-stray-file'), 'x');
      // Git reuses a freed folder name for another checkout: it is not the lane's, whatever it is called.
      folder(dirname(admin), basename(admin), { gitdir: `${join(directory(), 'someone-elses-checkout', '.git')}\n` });
    });
    const outcome = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
    expect(outcome.error).toBeNull();
    expect(outcome.result?.status).toBe('swept');
    expect(f.h.ledger.getWorktree(f.lane.id)?.status).toBe('swept');
    expect(kindsOf(f.h)).toContain('worktree.swept');
    expect(eventsOf(f.h, 'worktree.sweep-tail-failed')).toEqual([]);
    // The injection ran (a completed release without it would pass too).
    expect(existsSync(join(f.container, 'raced-odd-backlink'))).toBe(true);
  });

  it('refuses with a 400-class custody error, touching nothing, a lane whose checkout is gone but whose own administration stands', async () => {
    for (const label of ['deleted by hand', 'replaced by a dangling link'] as const) {
      const f = await laneFixture(`release-orphan-${label.replace(/\W+/gu, '-')}`);
      const admin = adminOf(f.lane);
      rmSync(f.lane.path, { recursive: true });
      if (label === 'replaced by a dangling link') symlinkSync(join(directory(), 'missing'), f.lane.path);
      const outcome = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
      // No removal ran in this release, so this is no residue: the 400 it always was.
      expect(outcome.error, label).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
      expect(existsSync(join(admin, 'gru-creation-handoff.json')), label).toBe(true);
      expect(f.h.ledger.getWorktree(f.lane.id)?.status, label).toBe('active');
      expect(git(f.repo.path, ['branch', '--list', f.lane.branch ?? ''])).not.toBe('');
      expect(kindsOf(f.h).filter((kind) => /^worktree\.(?:swept|preserved|reconciled|release-aborted|sweep-tail-failed)$/u.test(kind)), label).toEqual([]);
    }
  }, 120_000);

  it('refuses by name an absence it cannot prove, and proves it when its own administration is on record', async () => {
    const f = await laneFixture('release-unprovable-absence');
    const own = adminOf(f.lane);
    git(f.repo.path, ['worktree', 'remove', '--force', f.lane.path]);
    // The inventory cannot be read (a plain file where the folder was), as with an unavailable volume.
    rmSync(f.container, { recursive: true, force: true });
    writeFileSync(f.container, 'not a folder');
    expect(existsSync(own)).toBe(false);
    // The ledger recorded this lane's own folder at its handoff: it is absent, whatever the inventory says.
    expect(() => handoffProof.assertLaneResourcesAbsent(f.lane)).not.toThrow();
    // A lane with nothing on record cannot be shown absent from an inventory nobody can read.
    const unrecorded = { ...f.lane, id: 'unrecorded-lane', path: join(directory(), 'unrecorded-checkout') };
    const refused = (() => { try { handoffProof.assertLaneResourcesAbsent(unrecorded); return null; } catch (error) { return error; } })();
    expect(refused).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
    expect(reasonsOf(refused)).toContain('its absence cannot be proven');
    // So is a repository that is gone: by name, never a raw filesystem error.
    const homeless = { ...unrecorded, repoPath: join(directory(), 'gone-repository') };
    const missing = (() => { try { handoffProof.assertLaneResourcesAbsent(homeless); return null; } catch (error) { return error; } })();
    expect(missing).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
    // A lane whose administration IS on record proves nothing when the repository holding it cannot be reached:
    // a path missing there is no evidence of absence.
    const g = await laneFixture('release-unreachable-repository');
    rmSync(g.lane.path, { recursive: true });
    renameSync(g.repo.path, join(dirname(g.repo.path), 'moved-away'));
    const unreachable = (() => { try { handoffProof.assertLaneResourcesAbsent(g.lane); return null; } catch (error) { return error; } })();
    expect(unreachable).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
    expect(reasonsOf(unreachable)).toContain('its absence cannot be proven');
    // A checkout missing from a folder that cannot be reached (an unmounted volume) is not shown gone either.
    const h2 = await laneFixture('release-unreachable-folder');
    const unmounted = (() => { try { handoffProof.assertLaneResourcesAbsent({ ...h2.lane, path: join(directory(), 'missing-folder', 'checkout') }); return null; } catch (error) { return error; } })();
    expect(unmounted).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
    expect(reasonsOf(unmounted)).toContain('cannot be reached');
    // Nor is one whose holding folder is a plain file: nothing can stand under it, and nothing shows the lane was ever removed.
    const plain = join(directory(), 'plain-file');
    writeFileSync(plain, 'not a folder');
    const underFile = (() => { try { handoffProof.assertLaneResourcesAbsent({ ...h2.lane, path: join(plain, 'checkout') }); return null; } catch (error) { return error; } })();
    expect(underFile).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
    expect(reasonsOf(underFile)).toContain('is not a folder');
  }, 120_000);

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)('does not reconcile a row whose own administration stands in an inventory that cannot be read', async () => {
    const f = await laneFixture('release-unreadable-inventory');
    const admin = adminOf(f.lane);
    rmSync(f.lane.path, { recursive: true });
    chmodSync(f.container, 0o000);
    try {
      const outcome = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
      expect(outcome.error).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
      expect(f.h.ledger.getWorktree(f.lane.id)?.status).toBe('active');
      expect(kindsOf(f.h).filter((kind) => /^worktree\.(?:swept|preserved|reconciled|release-aborted|sweep-tail-failed)$/u.test(kind))).toEqual([]);
    } finally { chmodSync(f.container, 0o755); }
    expect(existsSync(admin)).toBe(true);
    expect(git(f.repo.path, ['branch', '--list', f.lane.branch ?? ''])).not.toBe('');
  });

  it('keeps the record of saved work when residue refuses the release, and the release that finishes the lane tells the owner', async () => {
    for (const retry of ['the residue is cleared by hand', 'a retry meets the residue still in place first', 'the branch cannot be deleted'] as const) {
      const hook = afterRemoval();
      const told: { readonly snapshot: { readonly ref: string } | null; readonly preserved: { readonly count: number } | null }[] = [];
      const f = await laneFixture(`release-residue-saved-${retry.replace(/\W+/gu, '-')}`, { log: hook.log, onWorkSaved: (saved) => { told.push(saved); } });
      writeFileSync(join(f.lane.path, 'README.md'), 'an uncommitted edit\n');
      writeFileSync(join(f.lane.path, 'notes.txt'), 'an untracked deliverable\n');
      hook.arm(f.lane.path, () => mkdirSync(f.lane.path, { recursive: true }));
      const outcome = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
      expect(outcome.error, retry).toMatchObject({ name: 'LaneResidueError', residue: [f.lane.path] });
      const [refusal] = eventsOf(f.h, 'worktree.sweep-tail-failed').map((event) => event.payload as Record<string, unknown>);
      expect(refusal, retry).toMatchObject({ id: f.lane.id, stage: 'verify', residue: [f.lane.path], preserved: { files: 1 }, snapshot: { files: 1 } });
      const ref = (refusal!['snapshot'] as { ref: string }).ref;
      expect(ref, retry).toMatch(/^refs\/gru\/preserved\//u);
      expect(git(f.repo.path, ['rev-parse', '--verify', ref]), retry).toMatch(/^[0-9a-f]{40}$/u);
      expect(told, retry).toEqual([]);
      // Whatever lands in the lane's record meanwhile (a part-way removal finished, a branch that would not go), the owner is still told.
      if (retry === 'the residue is cleared by hand') rmSync(f.lane.path, { recursive: true, force: true });
      if (retry === 'a retry meets the residue still in place first') {
        // The lane is not finished while it stands: the same refusal again, which tells nobody anything yet.
        expect((await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }))).error, retry).toMatchObject({ name: 'LaneResidueError', residue: [f.lane.path] });
        expect(told, retry).toEqual([]);
        rmSync(f.lane.path, { recursive: true, force: true });
      }
      if (retry === 'the branch cannot be deleted') {
        rmSync(f.lane.path, { recursive: true, force: true });
        writeFileSync(join(handoffProof.repositoryCommonDirectory(f.repo.path), 'refs', 'heads', `${f.lane.branch ?? ''}.lock`), '');
      }
      expect((await f.h.worktrees.release({ worktreeId: f.lane.id })).status, retry).toBe('swept');
      expect(told, retry).toHaveLength(1);
      expect(told[0]?.snapshot?.ref, retry).toBe(ref);
      expect(told[0]?.preserved?.count, retry).toBe(1);
    }
  }, 120_000);

  it('writes a failed tail to the record of its own lane when residue refuses, never onto the next lane', async () => {
    const hook = afterRemoval();
    const f = await laneFixture('release-residue-tail-leak', { log: hook.log });
    const otherJob = f.h.ledger.addJob({ id: 'release-residue-tail-leak-other', repo: 'assigned', title: 'the next lane' });
    const other = await f.h.worktrees.createJobWorktree({ repoPath: f.repo.path, jobId: otherJob.id });
    // The tail's base step fails after the removal, and the lane's own path is back.
    hook.arm(f.lane.path, () => { mkdirSync(f.lane.path, { recursive: true }); throw new Error('base resolution broke'); });
    const outcome = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
    expect(outcome.error).toMatchObject({ name: 'LaneResidueError' });
    const failures = (id: string) => eventsOf(f.h, 'worktree.sweep-tail-failed').map((event) => event.payload as { id: string; stage?: string; error: string }).filter((payload) => payload.id === id);
    expect(failures(f.lane.id).map((payload) => payload.stage ?? 'tail').sort()).toEqual(['tail', 'verify']);
    expect(failures(f.lane.id).find((payload) => payload.stage === undefined)?.error).toContain('base resolution broke');
    // The next lane's release is clean, and its record carries nothing of the first lane's failure.
    expect((await f.h.worktrees.release({ worktreeId: other.id })).status).toBe('swept');
    expect(failures(other.id)).toEqual([]);
  }, 120_000);

  it('completes a release whose removal ran even when the inventory cannot be read afterwards', async () => {
    const hook = afterRemoval();
    const f = await laneFixture('release-inventory-unreadable-after-removal', { log: hook.log });
    // After the removal, a plain file stands where the repository's inventory was.
    hook.arm(f.lane.path, () => { rmSync(f.container, { recursive: true, force: true }); writeFileSync(f.container, 'not a folder'); });
    const outcome = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
    expect(outcome.error).toBeNull();
    expect(outcome.result?.status).toBe('swept');
    expect(f.h.ledger.getWorktree(f.lane.id)?.status).toBe('swept');
    expect(kindsOf(f.h)).toContain('worktree.swept');
    expect(eventsOf(f.h, 'worktree.sweep-tail-failed')).toEqual([]);
    // The injection ran (a completed release without it would pass too).
    expect(lstatSync(f.container).isFile()).toBe(true);
  });

  it('refuses, touching nothing, a release whose half-removed checkout still has its own administration standing', async () => {
    const f = await laneFixture('release-half-removed-own-administration');
    const admin = adminOf(f.lane);
    // The checkout has lost its git file, and its administration folder its backlink: nothing names the tree,
    // but the folder the ledger recorded for this lane is still there, so git did not delete it.
    rmSync(join(f.lane.path, '.git'));
    rmSync(join(admin, 'gitdir'));
    const outcome = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
    expect(outcome.error).toBeInstanceOf(Error);
    // A refusal before any removal: never the residue answer (the 409), and nothing is recorded.
    expect(outcome.error).not.toBeInstanceOf(handoffProof.LaneResidueError);
    // No part-way removal was finished: the tree, the folder, the branch and the row are as they were.
    expect(existsSync(join(f.lane.path, 'README.md'))).toBe(true);
    expect(existsSync(join(admin, 'gru-creation-handoff.json'))).toBe(true);
    expect(f.h.ledger.getWorktree(f.lane.id)?.status).toBe('active');
    expect(git(f.repo.path, ['branch', '--list', f.lane.branch ?? ''])).not.toBe('');
    expect(kindsOf(f.h).filter((kind) => /^worktree\.(?:swept|preserved|reconciled|release-aborted|sweep-tail-failed)$/u.test(kind))).toEqual([]);
  });

  it('finds a differently named administration of the lane by its backlink or its receipt, before and after the removal', async () => {
    for (const shape of ['a backlink before the removal', 'a receipt before the removal', 'a backlink after the removal'] as const) {
      const hook = afterRemoval();
      const f = await laneFixture(`release-renamed-administration-${shape.replace(/\W+/gu, '-')}`, { log: hook.log });
      const receipt = readFileSync(join(adminOf(f.lane), 'gru-creation-handoff.json'), 'utf8');
      const checkoutGit = join(realpathSync(dirname(f.lane.path)), basename(f.lane.path), '.git');
      const renamed = join(f.container, 'renamed-administration');
      const plant = () => { folder(f.container, 'renamed-administration', shape === 'a receipt before the removal' ? { 'gru-creation-handoff.json': receipt } : { gitdir: `${checkoutGit}\n` }); };
      if (shape === 'a backlink after the removal') {
        hook.arm(f.lane.path, plant);
        const outcome = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
        expect(outcome.error, shape).toMatchObject({ name: 'LaneResidueError', residue: [renamed] });
        expect(eventsOf(f.h, 'worktree.sweep-tail-failed').map((event) => (event.payload as { stage?: string }).stage), shape).toEqual(['verify']);
      } else {
        // The lane's own folder is gone and its checkout too (an earlier release stopped); another folder still names it.
        git(f.repo.path, ['worktree', 'remove', '--force', f.lane.path]);
        plant();
        const outcome = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
        expect(outcome.error, shape).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
        expect(f.h.ledger.getWorktree(f.lane.id)?.status, shape).toBe('active');
        expect(git(f.repo.path, ['branch', '--list', f.lane.branch ?? ''])).not.toBe('');
        expect(kindsOf(f.h).filter((kind) => /^worktree\.(?:swept|preserved|reconciled|release-aborted|sweep-tail-failed)$/u.test(kind)), shape).toEqual([]);
      }
      expect(existsSync(renamed), shape).toBe(true);
    }
  }, 120_000);

  it('tells the owner what a refused release saved for a lane with no job, whatever was recorded in between', async () => {
    const hook = afterRemoval();
    const told: { readonly snapshot: { readonly ref: string } | null }[] = [];
    const repo = fixture('release-jobless-saved-work');
    const h = manager({ log: hook.log, onWorkSaved: (saved) => { told.push(saved); } });
    h.ledger.addJob({ id: 'release-jobless-owner', repo: 'assigned', title: 'owner of the round' });
    h.ledger.addRound({ jobId: 'release-jobless-owner', targetRef: 'HEAD' });
    // The lane is made without a job id, as a round's review lane is.
    const lane = await h.worktrees.createReviewWorktree({ repoPath: repo.path, roundId: 'release-jobless-owner-r1', ref: 'HEAD' });
    expect(h.ledger.getWorktree(lane.id)?.jobId).toBeNull();
    writeFileSync(join(lane.path, 'README.md'), 'an uncommitted edit\n');
    hook.arm(lane.path, () => mkdirSync(lane.path, { recursive: true }));
    const outcome = await outcomeOf(h.worktrees.release({ worktreeId: lane.id }));
    expect(outcome.error).toMatchObject({ name: 'LaneResidueError', residue: [lane.path] });
    // Something else of the lane's is recorded before the release that finishes it (a base step that failed, say).
    h.ledger.appendCustomEvent({ kind: 'worktree.sweep-tail-failed', jobId: null, roundId: lane.roundId, payload: { id: lane.id, error: 'a base step failed' } });
    rmSync(lane.path, { recursive: true, force: true });
    expect((await h.worktrees.release({ worktreeId: lane.id })).status).toBe('swept');
    expect(h.ledger.listEvents({ limit: 1000 }).filter((event) => event.kind === 'worktree.sweep-tail-failed')).toHaveLength(2);
    expect(told).toHaveLength(1);
    expect(told[0]?.snapshot?.ref).toMatch(/^refs\/gru\/preserved\//u);
  }, 120_000);

  it('does not announce saved work twice when the flip of the reconciled row fails and is retried', async () => {
    const hook = afterRemoval();
    const told: unknown[] = [];
    const f = await laneFixture('release-saved-work-flip-retry', { log: hook.log, onWorkSaved: (saved) => { told.push(saved); } });
    writeFileSync(join(f.lane.path, 'README.md'), 'an uncommitted edit\n');
    hook.arm(f.lane.path, () => mkdirSync(f.lane.path, { recursive: true }));
    expect((await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }))).error).toMatchObject({ name: 'LaneResidueError' });
    rmSync(f.lane.path, { recursive: true, force: true });
    // The write that flips the row fails once: the release logs it and the row stays active, so nobody is told yet.
    const flip = vi.spyOn(f.h.ledger, 'setWorktreeStatus').mockImplementationOnce(() => { throw new Error('the ledger is down'); });
    await f.h.worktrees.release({ worktreeId: f.lane.id });
    expect(f.h.ledger.getWorktree(f.lane.id)?.status).toBe('active');
    expect(told).toEqual([]);
    flip.mockRestore();
    expect((await f.h.worktrees.release({ worktreeId: f.lane.id })).status).toBe('swept');
    expect(f.h.ledger.getWorktree(f.lane.id)?.status).toBe('swept');
    expect(told).toHaveLength(1);
  }, 120_000);

  it('reconciles a row whose checkout is already gone beside other lanes and folders, so a stranded release finishes', async () => {
    const f = await laneFixture('release-stranded-row');
    const { siblings, others } = await seedOthers(f);
    // What an interrupted release left behind: the checkout and its git folder gone, the row still active.
    git(f.repo.path, ['worktree', 'remove', '--force', f.lane.path]);
    expect(f.h.ledger.getWorktree(f.lane.id)?.status).toBe('active');
    expect(() => handoffProof.assertLaneResourcesAbsent(f.lane)).not.toThrow();
    const outcome = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
    expect(outcome.error).toBeNull();
    expect(outcome.result?.status).toBe('swept');
    expect(f.h.ledger.getWorktree(f.lane.id)?.status).toBe('swept');
    expect(kindsOf(f.h)).toContain('worktree.reconciled');
    for (const sibling of siblings) expect(f.h.ledger.getWorktree(sibling.id)?.status).toBe('active');
    for (const other of others) expect(existsSync(other), other).toBe(true);
  }, 120_000);

  it('tells the owner what a refused release saved even when the record of its refusal cannot be written', async () => {
    const hook = afterRemoval();
    const told: SavedWork[] = [];
    const f = await laneFixture('release-residue-saved-unrecorded', { log: hook.log, onWorkSaved: (saved) => { told.push(saved); } });
    writeFileSync(join(f.lane.path, 'README.md'), 'an uncommitted edit\n');
    writeFileSync(join(f.lane.path, 'notes.txt'), 'an untracked deliverable\n');
    hook.arm(f.lane.path, () => mkdirSync(f.lane.path, { recursive: true }));
    // The ledger takes every record but the one that names the residue.
    const append = f.h.ledger.appendCustomEvent.bind(f.h.ledger);
    const down = vi.spyOn(f.h.ledger, 'appendCustomEvent').mockImplementation((fields) => {
      if (fields.kind === 'worktree.sweep-tail-failed' && (fields.payload as { stage?: string }).stage === 'verify') throw new Error('the ledger is down');
      return append(fields);
    });
    const outcome = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
    expect(outcome.error).toMatchObject({ name: 'LaneResidueError', residue: [f.lane.path] });
    expect(eventsOf(f.h, 'worktree.sweep-tail-failed')).toEqual([]);
    // No record of the lane names the saved work, and a later reconcile cannot find it: the refusal itself tells the owner.
    expect(told).toHaveLength(1);
    expect(told[0]?.snapshot?.ref).toMatch(/^refs\/gru\/preserved\//u);
    expect(told[0]?.preserved?.count).toBe(1);
    // The lane is not released yet (its row is active and the answer was a refusal): the notice does not say it was.
    expect(told[0]?.unfinished).toBe(true);
    const notice = sweepWorkNotice(told[0]!).detail;
    expect(notice).toContain('could not finish');
    expect(notice).toContain(told[0]!.snapshot!.ref);
    expect(notice).not.toContain('was released');
    down.mockRestore();
    // The release that finishes the lane has nothing on record to tell again.
    rmSync(f.lane.path, { recursive: true, force: true });
    expect((await f.h.worktrees.release({ worktreeId: f.lane.id })).status).toBe('swept');
    expect(told).toHaveLength(1);
  }, 120_000);

  it('answers a retry while the residue still stands with the residue refusal again, touching nothing, and finishes once it is cleared', async () => {
    for (const shape of ['its administration folder is still there', 'its administration folder is back with nothing but a HEAD file', 'its checkout is re-created beside its administration folder', 'its checkout is re-created'] as const) {
      const hook = afterRemoval();
      const f = await laneFixture(`release-residue-retry-${shape.replace(/\W+/gu, '-')}`, { log: hook.log });
      const admin = adminOf(f.lane);
      const checkoutGit = join(realpathSync(dirname(f.lane.path)), basename(f.lane.path), '.git');
      const administration = shape !== 'its checkout is re-created';
      const checkout = shape.startsWith('its checkout is re-created');
      const residue = [...(checkout ? [f.lane.path] : []), ...(administration ? [admin] : [])];
      hook.arm(f.lane.path, () => {
        if (administration) folder(dirname(admin), basename(admin), shape === 'its administration folder is back with nothing but a HEAD file' ? { HEAD: 'ref: refs/heads/main\n' } : { gitdir: `${checkoutGit}\n` });
        if (checkout) {
          mkdirSync(f.lane.path, { recursive: true });
          writeFileSync(join(f.lane.path, 'theirs.txt'), 'not the lane\'s own\n');
        }
      });
      const first = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
      expect(first.error, shape).toMatchObject({ name: 'LaneResidueError', residue });
      const recorded = f.h.ledger.listEvents({ limit: 1000 });
      expect(eventsOf(f.h, 'worktree.sweep-tail-failed'), shape).toHaveLength(1);
      // The same release again, the residue still there: the same answer, naming it. This request ran no removal:
      // nothing is touched (a re-created folder is not deleted or copied) and nothing more is recorded.
      const retry = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
      expect(retry.error, shape).toBeInstanceOf(handoffProof.LaneResidueError);
      expect(retry.error, shape).toMatchObject({ name: 'LaneResidueError', residue });
      expect(f.h.ledger.getWorktree(f.lane.id)?.status, shape).toBe('active');
      expect(f.h.ledger.listEvents({ limit: 1000 }), shape).toEqual(recorded);
      expect(git(f.repo.path, ['branch', '--list', f.lane.branch ?? '']), shape).not.toBe('');
      for (const path of residue) expect(existsSync(path), `${shape}: ${path}`).toBe(true);
      if (checkout) expect(readFileSync(join(f.lane.path, 'theirs.txt'), 'utf8'), shape).toBe('not the lane\'s own\n');
      // Cleared, the release finishes.
      for (const path of residue) rmSync(path, { recursive: true, force: true });
      expect((await f.h.worktrees.release({ worktreeId: f.lane.id })).status, shape).toBe('swept');
      expect(f.h.ledger.getWorktree(f.lane.id)?.status, shape).toBe('swept');
    }
  }, 120_000);

  it('keeps the refusal before removal, a 400 that touches nothing, for a retry whose lane has no marker', async () => {
    for (const ending of ['the verify record could not be written', 'a later swept record ends the marker', 'a later reconciled record ends the marker'] as const) {
      const hook = afterRemoval();
      const f = await laneFixture(`release-no-marker-${ending.replace(/\W+/gu, '-')}`, { log: hook.log });
      const admin = adminOf(f.lane);
      hook.arm(f.lane.path, () => { folder(dirname(admin), basename(admin), { gitdir: `${join(realpathSync(dirname(f.lane.path)), basename(f.lane.path), '.git')}\n` }); });
      const append = f.h.ledger.appendCustomEvent.bind(f.h.ledger);
      const down = ending !== 'the verify record could not be written' ? null : vi.spyOn(f.h.ledger, 'appendCustomEvent').mockImplementation((fields) => {
        if (fields.kind === 'worktree.sweep-tail-failed' && (fields.payload as { stage?: string }).stage === 'verify') throw new Error('the ledger is down');
        return append(fields);
      });
      const first = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
      expect(first.error, ending).toMatchObject({ name: 'LaneResidueError', residue: [admin] });
      down?.mockRestore();
      // Once the removal is on the record as completed (a release whose flip failed after it wrote its swept row), the marker is spent.
      if (ending === 'a later swept record ends the marker') f.h.ledger.appendCustomEvent({ kind: 'worktree.swept', jobId: f.lane.jobId, roundId: f.lane.roundId, payload: { id: f.lane.id, path: f.lane.path, preserved: 0, branch: 'none', freshHead: '', snapshot: null } });
      if (ending === 'a later reconciled record ends the marker') f.h.ledger.appendCustomEvent({ kind: 'worktree.reconciled', jobId: f.lane.jobId, roundId: f.lane.roundId, payload: { id: f.lane.id, path: f.lane.path, priorStatus: 'active', branch: 'none' } });
      const recorded = f.h.ledger.listEvents({ limit: 1000 });
      const retry = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
      // No marker: no removal is known to have run, so the own folder that stands is a custody conflict, a 400 before removal.
      expect(retry.error, ending).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
      expect(reasonsOf(retry.error), ending).toContain(admin);
      expect(f.h.ledger.getWorktree(f.lane.id)?.status, ending).toBe('active');
      expect(f.h.ledger.listEvents({ limit: 1000 }), ending).toEqual(recorded);
      expect(existsSync(admin), ending).toBe(true);
      expect(git(f.repo.path, ['branch', '--list', f.lane.branch ?? '']), ending).not.toBe('');
    }
  }, 120_000);

  it('copies what is re-created over a lane whose removal completed before it deletes it, whatever an earlier aborted release saved, and tells the owner of the saved work once', async () => {
    const told: { readonly snapshot: { readonly ref: string } | null; readonly preserved: { readonly count: number } | null }[] = [];
    let lock: string | null = null;
    const f = await laneFixture('release-stale-aborted', {
      log: (_level, message) => {
        // The first release saves the lane's work, and a lock appears before its removal runs: it aborts.
        if (lock !== null && message === 'uncommitted work saved before the sweep') {
          writeFileSync(lock, 'foreign custody');
          lock = null;
        }
      },
      onWorkSaved: (saved) => { told.push(saved); },
    });
    writeFileSync(join(f.lane.path, 'README.md'), 'an uncommitted edit\n');
    writeFileSync(join(f.lane.path, 'notes.txt'), 'an untracked deliverable\n');
    const locked = join(adminOf(f.lane), 'locked');
    lock = locked;
    expect((await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }))).error).toBeInstanceOf(Error);
    expect(eventsOf(f.h, 'worktree.release-aborted')).toHaveLength(1);
    expect(existsSync(f.lane.path)).toBe(true);
    rmSync(locked);
    // The next release reuses what the aborted one saved, removes the checkout and tells the owner. The write that
    // flips the row fails, so the row stays active with its removal on the record as swept.
    const flip = vi.spyOn(f.h.ledger, 'setWorktreeStatus').mockImplementationOnce(() => { throw new Error('the ledger is down'); });
    expect((await f.h.worktrees.release({ worktreeId: f.lane.id })).status).toBe('swept');
    flip.mockRestore();
    expect(f.h.ledger.getWorktree(f.lane.id)?.status).toBe('active');
    expect(told).toHaveLength(1);
    // Then a file of someone's own is back at the lane's path. The aborted release is older than a completed removal:
    // nothing it saved covers what stands there now.
    mkdirSync(f.lane.path, { recursive: true });
    writeFileSync(join(f.lane.path, 'recreated.txt'), 'back again\n');
    expect((await f.h.worktrees.release({ worktreeId: f.lane.id })).status).toBe('swept');
    const copies = eventsOf(f.h, 'worktree.preserved').map((event) => event.payload as { readonly destination: string; readonly remains?: boolean }).filter((payload) => payload.remains === true);
    expect(copies).toHaveLength(1);
    expect(readFileSync(join(copies[0]!.destination, 'recreated.txt'), 'utf8')).toBe('back again\n');
    // The snapshot of the first release is told once, not once more by the release that finishes the lane.
    expect(told.map((saved) => saved.snapshot?.ref).filter((ref) => ref !== undefined)).toHaveLength(1);
  }, 120_000);

  it('answers a swept row whose own resources stand when the release starts with the refusal before removal, writing nothing and keeping its branch', async () => {
    const f = await laneFixture('release-swept-residue-at-entry');
    const branch = f.lane.branch ?? '';
    expect((await f.h.worktrees.release({ worktreeId: f.lane.id })).status).toBe('swept');
    // A surviving branch the heal of a swept row would dispose of, and the lane's path back.
    git(f.repo.path, ['branch', branch, 'HEAD']);
    mkdirSync(f.lane.path, { recursive: true });
    const recorded = f.h.ledger.listEvents({ limit: 1000 });
    const outcome = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
    expect(outcome.error).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
    expect(f.h.ledger.getWorktree(f.lane.id)?.status).toBe('swept');
    expect(f.h.ledger.listEvents({ limit: 1000 })).toEqual(recorded);
    expect(git(f.repo.path, ['branch', '--list', branch])).not.toBe('');
  }, 120_000);

  it('keeps a swept row swept, answering 200 with a warning that names the residue, when its own resources turn up after the branch step', async () => {
    const warnings: { readonly message: string; readonly fields: unknown }[] = [];
    let armed: { readonly repo: string; readonly branch: string; readonly path: string } | null = null;
    const f = await laneFixture('release-swept-residue-after-branch', {
      log: (level, message, fields) => {
        if (level === 'warn') warnings.push({ message, fields });
        // The fresh head is resolved after the branch step; the lane's path comes back then.
        if (armed !== null && message.startsWith('base resolution degraded') && git(armed.repo, ['branch', '--list', armed.branch]) === '' && !existsSync(armed.path)) {
          const { path } = armed;
          armed = null;
          mkdirSync(path, { recursive: true });
        }
      },
    });
    const branch = f.lane.branch ?? '';
    expect((await f.h.worktrees.release({ worktreeId: f.lane.id })).status).toBe('swept');
    git(f.repo.path, ['branch', branch, 'HEAD']);
    const recorded = f.h.ledger.listEvents({ limit: 1000 });
    warnings.length = 0;
    armed = { repo: f.repo.path, branch, path: f.lane.path };
    const outcome = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
    // The branch step ran (the branch is gone), then the path came back: the release still answers, and records nothing.
    expect(outcome.error).toBeNull();
    expect(outcome.result?.status).toBe('swept');
    expect(existsSync(f.lane.path)).toBe(true);
    expect(git(f.repo.path, ['branch', '--list', branch])).toBe('');
    expect(f.h.ledger.getWorktree(f.lane.id)?.status).toBe('swept');
    expect(f.h.ledger.listEvents({ limit: 1000 })).toEqual(recorded);
    expect(warnings.filter((warning) => JSON.stringify(warning.fields).includes(f.lane.path)).length).toBeGreaterThan(0);
  }, 120_000);

  it('answers a swept row whose own resources turn up while it asks origin about its branch with the refusal before removal, keeping the branch', async () => {
    const hook = afterRemoval();
    const f = await laneFixture('release-swept-residue-before-branch', { log: hook.log });
    const branch = f.lane.branch ?? '';
    expect((await f.h.worktrees.release({ worktreeId: f.lane.id })).status).toBe('swept');
    git(f.repo.path, ['branch', branch, 'HEAD']);
    const recorded = f.h.ledger.listEvents({ limit: 1000 });
    // The first fresh-base resolution of the heal asks origin whether the surviving branch may go; the path is back by then.
    hook.arm(f.lane.path, () => mkdirSync(f.lane.path, { recursive: true }));
    const outcome = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
    expect(outcome.error).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
    expect(existsSync(f.lane.path)).toBe(true);
    expect(f.h.ledger.getWorktree(f.lane.id)?.status).toBe('swept');
    expect(f.h.ledger.listEvents({ limit: 1000 })).toEqual(recorded);
    expect(git(f.repo.path, ['branch', '--list', branch])).not.toBe('');
  }, 120_000);

  it('answers a lane whose checkout is already gone with the refusal before removal when its own resources turn up after its branch step, recording nothing', async () => {
    let armed: { readonly repo: string; readonly branch: string; readonly path: string; readonly act: () => void } | null = null;
    const f = await laneFixture('release-reconcile-late-residue', {
      log: (_level, message) => {
        // After the branch step (the branch is gone) the fresh head is resolved; the lane's own git folder is back by then.
        if (armed !== null && message.startsWith('base resolution degraded') && git(armed.repo, ['branch', '--list', armed.branch]) === '') {
          const { act } = armed;
          armed = null;
          act();
        }
      },
    });
    const admin = adminOf(f.lane);
    // What an interrupted release left behind: the checkout and its git folder gone, the row active, the branch still there.
    git(f.repo.path, ['worktree', 'remove', '--force', f.lane.path]);
    armed = { repo: f.repo.path, branch: f.lane.branch ?? '', path: f.lane.path, act: () => { folder(dirname(admin), basename(admin), { gitdir: `${join(realpathSync(dirname(f.lane.path)), basename(f.lane.path), '.git')}\n` }); } };
    // No removal ran in this request: the same refusal as at the start, and no record that would mark the lane.
    const outcome = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
    expect(outcome.error).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
    expect(existsSync(admin)).toBe(true);
    expect(git(f.repo.path, ['branch', '--list', f.lane.branch ?? ''])).toBe('');
    expect(f.h.ledger.getWorktree(f.lane.id)?.status).toBe('active');
    expect(kindsOf(f.h).filter((kind) => /^worktree\.(?:swept|preserved|reconciled|release-aborted|sweep-tail-failed)$/u.test(kind))).toEqual([]);
    // It stays the refusal before removal while the folder stands, and the release finishes once it is cleared.
    expect((await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }))).error).toBeInstanceOf(handoffProof.WorktreeHandoffUnresolvedError);
    rmSync(admin, { recursive: true, force: true });
    expect((await f.h.worktrees.release({ worktreeId: f.lane.id })).status).toBe('swept');
    expect(kindsOf(f.h)).toContain('worktree.reconciled');
  }, 120_000);

  it('answers the residue of a request that finished a half-removed checkout with the residue refusal, never a 400, and marks the lane', async () => {
    let armed: { readonly repo: string; readonly branch: string; readonly act: () => void } | null = null;
    const told: SavedWork[] = [];
    const f = await laneFixture('release-finisher-late-residue', {
      log: (_level, message) => {
        // After the branch step (the branch is gone) the fresh head is resolved; the lane's own git folder is back by then.
        if (armed !== null && message.startsWith('base resolution degraded') && git(armed.repo, ['branch', '--list', armed.branch]) === '') {
          const { act } = armed;
          armed = null;
          act();
        }
      },
      onWorkSaved: (saved) => { told.push(saved); },
    });
    const admin = adminOf(f.lane);
    writeFileSync(join(f.lane.path, 'notes.txt'), 'an untracked deliverable\n');
    // What a removal that failed part way leaves: git deleted its folder for the lane, the checkout's files are still there.
    rmSync(admin, { recursive: true, force: true });
    armed = { repo: f.repo.path, branch: f.lane.branch ?? '', act: () => { folder(dirname(admin), basename(admin), { gitdir: `${join(realpathSync(dirname(f.lane.path)), basename(f.lane.path), '.git')}\n` }); } };
    // This request deleted the rest of the checkout itself: a removal ran in it, so what stands afterwards is residue.
    const outcome = await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }));
    expect(outcome.error).toMatchObject({ name: 'LaneResidueError', residue: [admin] });
    expect(existsSync(f.lane.path)).toBe(false);
    expect(git(f.repo.path, ['branch', '--list', f.lane.branch ?? ''])).toBe('');
    expect(f.h.ledger.getWorktree(f.lane.id)?.status).toBe('active');
    const rows = eventsOf(f.h, 'worktree.sweep-tail-failed').map((event) => event.payload as { stage?: string; preserved?: { files: number } });
    expect(rows.map((row) => row.stage).sort()).toEqual(['remove', 'verify']);
    expect(kindsOf(f.h)).not.toContain('worktree.reconciled');
    // What the request saved is not told "released" while the lane stays unfinished: the residue record carries it.
    expect(told).toEqual([]);
    const copied = rows.find((row) => row.stage === 'verify')?.preserved?.files ?? 0;
    expect(copied).toBeGreaterThan(0);
    // The lane is marked: the retry answers the same residue refusal, touching nothing and recording nothing.
    const recorded = f.h.ledger.listEvents({ limit: 1000 });
    expect((await outcomeOf(f.h.worktrees.release({ worktreeId: f.lane.id }))).error).toMatchObject({ name: 'LaneResidueError', residue: [admin] });
    expect(f.h.ledger.listEvents({ limit: 1000 })).toEqual(recorded);
    expect(told).toEqual([]);
    rmSync(admin, { recursive: true, force: true });
    expect((await f.h.worktrees.release({ worktreeId: f.lane.id })).status).toBe('swept');
    expect(kindsOf(f.h)).toContain('worktree.reconciled');
    // The release that finishes the lane tells the owner, once, in the usual words.
    expect(told).toHaveLength(1);
    expect(told[0]?.preserved?.count).toBe(copied);
    expect(told[0]?.unfinished).toBeUndefined();
  }, 120_000);

  it('finds the marker of a refused release after a restart: a new manager over the same ledger file answers the same residue refusal', async () => {
    const hook = afterRemoval();
    const repo = fixture('release-marker-restart');
    const dir = directory();
    const root = directory();
    const preserveRoot = directory();
    const start = (db: LedgerDb) => {
      const ledger = new LedgerApi(db.handle, { bus: new EventBus() });
      return { ledger, worktrees: new WorktreeManager({ ledger, root, preserveRoot, setupTimeoutMs: 30_000, enumerateProcesses: () => [], log: hook.log }) };
    };
    const first = new LedgerDb(dir);
    const before = start(first);
    const job = before.ledger.addJob({ id: 'release-marker-restart', repo: 'assigned', title: 'release custody' });
    const lane = await before.worktrees.createJobWorktree({ repoPath: repo.path, jobId: job.id });
    const admin = adminOf(lane);
    hook.arm(lane.path, () => { folder(dirname(admin), basename(admin), { gitdir: `${join(realpathSync(dirname(lane.path)), basename(lane.path), '.git')}\n` }); });
    expect((await outcomeOf(before.worktrees.release({ worktreeId: lane.id }))).error).toMatchObject({ name: 'LaneResidueError', residue: [admin] });
    first.close();
    // A restart: the ledger file is opened again, by a manager that has seen none of this.
    const second = new LedgerDb(dir);
    dbs.push(second);
    const after = start(second);
    const retry = await outcomeOf(after.worktrees.release({ worktreeId: lane.id }));
    expect(retry.error).toMatchObject({ name: 'LaneResidueError', residue: [admin] });
    expect(after.ledger.getWorktree(lane.id)?.status).toBe('active');
    expect(existsSync(admin)).toBe(true);
    rmSync(admin, { recursive: true, force: true });
    expect((await after.worktrees.release({ worktreeId: lane.id })).status).toBe('swept');
  }, 120_000);
});
