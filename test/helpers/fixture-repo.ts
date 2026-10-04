import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { markFixtureStep } from './harness-diagnostics.mjs';

/**
 * Local fixture git repo for worktree/dispatch tests (EPICS E8 story 4).
 * Generic names only — no remotes, no network, no project specifics
 * (repo hygiene ruling).
 */

const GIT_IDENTITY = ['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid'];

export interface FixtureRepo {
  readonly path: string;
  /** Commit a new file and return its sha (advances HEAD). */
  commitFile(rel: string, content: string, message?: string): string;
  head(): string;
  git(args: readonly string[], cwd?: string): string;
  cleanup(): void;
}

/** Attach a bare `origin` remote for the fixture, created inside the
 * fixture's temp root so it is cleaned up with the repository. Branches
 * are pushed by the caller (the timing matters for freeze tests). */
export function attachBareOrigin(repo: FixtureRepo): string {
  const origin = join(dirname(repo.path), `${basename(repo.path)}-origin.git`);
  execFileSync('git', ['init', '--bare', '--quiet', origin], { stdio: 'ignore' });
  repo.git(['remote', 'add', 'origin', origin]);
  markFixtureStep('fixture bare origin attached');
  return origin;
}

/** Fixture-prep primitive steps reported by makeFixtureRepo's optional
 * `onStep` observer (T4 attribution, phase pr144-t4-deep-attribution-20261001).
 * Each pip fires AFTER its primitive completes; callers derive durations from
 * the monotonic gaps. Pure observation — bytes, ordering, and git behavior
 * are identical for every caller that omits it (all pre-existing callers do). */
export type FixtureRepoStep = 'tempdir' | 'git-init' | 'seed-files' | 'initial-commit';

export function makeFixtureRepo(
  name = 'fixture-app',
  onStep?: (step: FixtureRepoStep) => void,
): FixtureRepo {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-fixture-'));
  onStep?.('tempdir');
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  const git = (args: readonly string[], cwd: string = path): string =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      // Captured, never inherited: expected-failure assertions stay quiet.
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git(['init', '-b', 'main']);
  onStep?.('git-init');
  writeFileSync(join(path, 'README.md'), `# ${name}\n\nFixture repository for dispatch-flow tests.\n`);
  mkdirSync(join(path, 'src'), { recursive: true });
  writeFileSync(join(path, 'src', 'main.ts'), 'export function answer(): number {\n  return 42;\n}\n');
  onStep?.('seed-files');
  // Historical two-process shape (restored 2026-10-02): `git commit --include .`
  // cannot stage untracked files on a fresh repository — it failed the 26e32a8
  // FULL with "pathspec '.' did not match any file(s) known to git" — so the
  // initial commit keeps `git add .` + `git commit` exactly as authored.
  git([...GIT_IDENTITY, 'add', '.']);
  git([...GIT_IDENTITY, 'commit', '-m', 'fixture: initial state']);
  onStep?.('initial-commit');
  markFixtureStep(`fixture repo initialized: ${name}`);

  const repo: FixtureRepo = {
    path,
    git,
    commitFile(rel: string, content: string, message?: string): string {
      const file = join(path, rel);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, content);
      git([...GIT_IDENTITY, 'add', rel]);
      git([...GIT_IDENTITY, 'commit', '-m', message ?? `fixture: update ${rel}`]);
      const sha = git(['rev-parse', 'HEAD']);
      markFixtureStep(`fixture commit: ${rel}`);
      return sha;
    },
    head(): string {
      return git(['rev-parse', 'HEAD']);
    },
    cleanup(): void {
      // Worktrees hold .git metadata under the fixture; detach them all
      // before the temp dir goes away so nothing dangles into tmp.
      try {
        git(['worktree', 'list', '--porcelain']);
        execFileSync('git', ['worktree', 'prune'], {
          cwd: path,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        /* best effort */
      }
      execFileSync('rm', ['-rf', dir], { encoding: 'utf-8' });
    },
  };
  return repo;
}
