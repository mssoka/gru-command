import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * install.sh (E7 story 3): rendering correctness on THIS platform —
 * placeholder substitution, absolute-path resolution through version
 * manager symlinks, path-with-space survival, and flag handling. The
 * script is executed for real with --print (it changes nothing).
 */

const repoRoot = join(import.meta.dirname, '..');
const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function print(env: NodeJS.ProcessEnv = {}): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('bash', [join(repoRoot, 'install.sh'), '--print'], {
      env: { ...process.env, ...env },
      encoding: 'utf-8',
    });
    return { stdout, status: 0 };
  } catch (error) {
    const err = error as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? '', status: err.status ?? 1 };
  }
}

describe('install.sh --print rendering', () => {
  it('renders the platform unit with every placeholder substituted absolutely', () => {
    const { stdout, status } = print();
    expect(status).toBe(0);
    expect(stdout).not.toContain('{{NODE}}');
    expect(stdout).not.toContain('{{REPO_ROOT}}');
    expect(stdout).not.toContain('{{GRU_COMMAND_HOME}}');
    expect(stdout).not.toContain('{{PATH}}');
    // The node path is absolute and stable (resolved through any
    // version-manager symlink — no ephemeral multishell path).
    expect(stdout).toMatch(/\/(dist\/main\.js|node)/);
    if (process.platform === 'darwin') {
      expect(stdout).toContain('<key>Label</key>');
      expect(stdout).toContain('<string>com.gru-command.service</string>');
      expect(stdout).toContain('<key>KeepAlive</key>');
      expect(stdout).toContain('<key>SuccessfulExit</key>');
    } else {
      expect(stdout).toContain('[Unit]');
      expect(stdout).toContain('Restart=on-failure');
      expect(stdout).toContain('WantedBy=default.target');
    }
  });

  it('honors GRU_COMMAND_HOME for the instance dir', () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-install-'));
    cleanupDirs.push(home);
    const { stdout } = print({ GRU_COMMAND_HOME: home });
    expect(stdout).toContain(home);
  });

  it('unknown flags exit non-zero with usage', () => {
    let status = 0;
    try {
      execFileSync('bash', [join(repoRoot, 'install.sh'), '--bogus'], { encoding: 'utf-8', stdio: 'pipe' });
    } catch (error) {
      status = (error as { status?: number }).status ?? 1;
    }
    expect(status).not.toBe(0);
  });

  it('a repo path containing spaces survives rendering (macOS plists; systemd quotes)', () => {
    // Simulate: run from a copy whose path has a space (the script derives
    // REPO_ROOT from its own location).
    const spaced = mkdtempSync(join(tmpdir(), 'gru command install-'));
    cleanupDirs.push(spaced);
mkdirSync(join(spaced, 'install'), { recursive: true });
    copyFileSync(join(repoRoot, 'install.sh'), join(spaced, 'install.sh'));
    for (const unit of ['launchd/com.gru-command.service.plist.template', 'systemd/gru-command.service.template']) {
      mkdirSync(join(spaced, 'install', ...unit.split('/').slice(0, -1)), { recursive: true });
      copyFileSync(join(repoRoot, 'install', unit), join(spaced, 'install', unit));
    }
    const stdout = execFileSync('bash', [join(spaced, 'install.sh'), '--print'], {
      encoding: 'utf-8',
      env: process.env,
    });
    expect(stdout).toContain(spaced);
    if (process.platform !== 'darwin') {
      // systemd ExecStart quotes arguments containing spaces.
      expect(stdout).toMatch(/ExecStart=.*".*gru command install-.*"/);
    }
  });
});

// ---------------------------------------------------------------------------
// W-B (E9 r3 carry): inside_checkout must accept ONLY a real Gru Command
// checkout — repo SHAPE alone let a saved copy inside a foreign repo get
// npm-installed + built before a later guard killed it.
// ---------------------------------------------------------------------------

describe('inside_checkout heuristic (W-B)', () => {
  function insideCheckout(repoRoot: string): number {
    // Extract exactly the function from install.sh and run it against a
    // controlled REPO_ROOT — no installer side effects ever run.
    const script = [
      `REPO_ROOT=${JSON.stringify(repoRoot)}`,
      `eval "$(sed -n '/^inside_checkout()/,/^}/p' ${JSON.stringify(join(repoRoot, 'install.sh'))} || true)"`,
      'if inside_checkout; then exit 0; else exit 1; fi',
    ].join('\n');
    try {
      execFileSync('bash', ['-c', script], { stdio: 'pipe' });
      return 0;
    } catch (error) {
      return (error as { status?: number }).status ?? 1;
    }
  }

  function stageShape(name: string, opts: { packageName: string; git: boolean; withSrc?: boolean; withScript?: boolean }): string {
    const dir = join(tempInstallDir(name), 'root');
    mkdirSync(dir, { recursive: true });
    // npm's real shape: pretty-printed, name on its own line (the
    // anchored heuristic keys on exactly that).
    writeFileSync(
      join(dir, 'package.json'),
      `{\n  "name": "${opts.packageName}",\n  "version": "1.0.0"\n}\n`,
    );
    if (opts.withSrc !== false) mkdirSync(join(dir, 'src'));
    if (opts.withScript !== false) copyFileSync(join(repoRoot, 'install.sh'), join(dir, 'install.sh'));
    if (opts.git) mkdirSync(join(dir, '.git'));
    return dir;
  }

  function tempInstallDir(name: string): string {
    const dir = mkdtempSync(join(tmpdir(), name));
    cleanupDirs.push(dir);
    return dir;
  }

  it('accepts a full Gru Command checkout (positive control)', () => {
    const dir = stageShape('gru-command-inside-real-', { packageName: 'gru-command', git: true });
    expect(insideCheckout(dir)).toBe(0);
  });

  it('accepts a git WORKTREE shape (.git is a file, not a dir)', () => {
    const dir = stageShape('gru-command-inside-worktree-', { packageName: 'gru-command', git: false });
    writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/main/.git/worktrees/one\n');
    expect(insideCheckout(dir)).toBe(0);
  });

  it('rejects a foreign repo with the same shape (own package name, has .git)', () => {
    const dir = stageShape('gru-command-inside-foreign-', { packageName: 'someone-elses-app', git: true });
    expect(insideCheckout(dir)).toBe(1);
  });

  it('rejects a saved copy WITHOUT .git ( Gru Command name, tarball/download shape)', () => {
    const dir = stageShape('gru-command-inside-nogit-', { packageName: 'gru-command', git: false });
    expect(insideCheckout(dir)).toBe(1);
  });

  it('rejects the name+git combo without the checkout layout (no src/)', () => {
    const dir = stageShape('gru-command-inside-nosrc-', { packageName: 'gru-command', git: true, withSrc: false });
    expect(insideCheckout(dir)).toBe(1);
  });
});
