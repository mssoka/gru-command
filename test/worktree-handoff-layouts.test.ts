import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    const token = 'token-0123456789abcdef';
    expect(() => handoffProof.beginLaneHandoff(f.parent, f.admin, token))
      .toThrow(new RegExp(`^lane administration ${f.admin.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')} cannot take a handoff receipt \\(EEXIST\\)$`, 'u'));
    expect(readdirSync(f.admin).sort()).toEqual(before);
    const temp = `${join(f.admin, 'gru-creation-handoff.json')}.${token.slice(13)}`;
    // ...and when its temporary receipt cannot be removed either, that is named with its reason.
    fsHooks.beforeUnlink = (path) => { if (path === temp) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
    expect(() => handoffProof.beginLaneHandoff(f.parent, f.admin, token))
      .toThrow(`lane administration ${f.admin} cannot take a handoff receipt (EEXIST) and its temporary receipt ${temp} could not be removed (EBUSY)`);
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
      .toThrow(`lane administration ${f.admin} published its handoff receipt and its temporary receipt ${temp} could not be removed (EBUSY)`);
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
      .toThrow(`lane administration ${f.admin} published its handoff receipt but could not make it durable (EIO), and its temporary receipt ${temp} could not be removed (EBUSY)`);
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
    expect(all!.message).toBe(`lane administration ${f.admin} published its handoff receipt but could not make it durable (EIO), and its temporary receipt ${temp} could not be removed (EBUSY)`);
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
      fsHooks.beforeFsync = failDirectorySync('EIO');
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
    }
    // A child lane.
    const f = await parentFixture('custody-undurable');
    fsHooks.beforeFsync = failDirectorySync('EIO');
    try {
      await expect(f.createChild()).rejects.toThrow(/published its handoff receipt but could not make it durable \(EIO\)$/u);
    } finally { fsHooks.beforeFsync = null; }
    f.childLeftNothing();
    expect(admins(f.repo.path)).toEqual([basename(f.admin)]);
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
