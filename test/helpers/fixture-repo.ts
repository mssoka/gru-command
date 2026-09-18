import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';

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

export function makeFixtureRepo(name = 'fixture-app'): FixtureRepo {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-fixture-'));
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
  writeFileSync(join(path, 'README.md'), `# ${name}\n\nFixture repository for dispatch-flow tests.\n`);
  mkdirSync(join(path, 'src'), { recursive: true });
  writeFileSync(join(path, 'src', 'main.ts'), 'export function answer(): number {\n  return 42;\n}\n');
  git([...GIT_IDENTITY, 'add', '.']);
  git([...GIT_IDENTITY, 'commit', '-m', 'fixture: initial state']);

  const repo: FixtureRepo = {
    path,
    git,
    commitFile(rel: string, content: string, message?: string): string {
      const file = join(path, rel);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, content);
      git([...GIT_IDENTITY, 'add', rel]);
      git([...GIT_IDENTITY, 'commit', '-m', message ?? `fixture: update ${rel}`]);
      return git(['rev-parse', 'HEAD']);
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
