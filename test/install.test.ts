import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
      expect(stdout).toContain('<string>gru-command-install-v2</string>');
      expect(stdout).toContain('<key>KeepAlive</key>');
      expect(stdout).toContain('<key>SuccessfulExit</key>');
    } else {
      expect(stdout).toContain('[Unit]');
      expect(stdout).toContain('X-GruCommandManagedBy=gru-command-install-v2');
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
    // Extract the shared identity helpers + wrapper and run them against a
    // controlled REPO_ROOT — no installer side effects ever run.
    const script = [
      `REPO_ROOT=${JSON.stringify(repoRoot)}`,
      `NODE_BIN=${JSON.stringify(process.execPath)}`,
      `eval "$(sed -n '/^checkout_package_name()/,/^run_setup()/p' ${JSON.stringify(join(repoRoot, 'install.sh'))} | sed '$d')"`,
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
    if (opts.withSrc !== false) {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', '.keep'), 'checkout-shape fixture\n');
    }
    if (opts.withScript !== false) copyFileSync(join(repoRoot, 'install.sh'), join(dir, 'install.sh'));
    if (opts.git) {
      execFileSync('git', ['init', '-q', '-b', 'main', dir]);
      execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.invalid']);
      execFileSync('git', ['-C', dir, 'config', 'user.name', 'Install Test']);
      execFileSync('git', ['-C', dir, 'add', '.']);
      execFileSync('git', ['-C', dir, 'commit', '-q', '-m', 'fixture']);
    }
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

  it('accepts a real git WORKTREE (.git is a valid gitdir file)', () => {
    const source = stageShape('gru-command-inside-worktree-source-', { packageName: 'gru-command', git: true });
    const dir = join(tempInstallDir('gru-command-inside-worktree-'), 'worktree');
    execFileSync('git', ['-C', source, 'worktree', 'add', '-b', 'fixture-worktree', dir]);
    expect(insideCheckout(dir)).toBe(0);
  });

  it('rejects a foreign manifest even when a nested name says gru-command', () => {
    const dir = stageShape('gru-command-inside-foreign-', { packageName: 'someone-elses-app', git: true });
    // Keep the nested key on its own line: the pre-fix anchored grep
    // accepted this foreign package because it could not distinguish
    // top-level JSON keys from nested ones.
    writeFileSync(
      join(dir, 'package.json'),
      `{
  "name": "someone-elses-app",
  "metadata": {
    "name": "gru-command"
  },
  "version": "1.0.0"
}
`,
    );
    const manifest = readFileSync(join(dir, 'package.json'), 'utf-8');
    // The original grep accepted this nested line; this assertion makes
    // the fixture a real pre-fix discriminator rather than mere prose.
    expect(/^(?:\{\s*)?\s*"name"\s*:\s*"gru-command"/m.test(manifest)).toBe(true);
    expect(insideCheckout(dir)).toBe(1);
  });

  it('rejects empty and stale .git shapes that are not a checkout with HEAD', () => {
    const empty = stageShape('gru-command-inside-empty-git-', { packageName: 'gru-command', git: false });
    mkdirSync(join(empty, '.git'));
    expect(insideCheckout(empty)).toBe(1);

    const stale = stageShape('gru-command-inside-stale-git-', { packageName: 'gru-command', git: false });
    writeFileSync(join(stale, '.git'), 'gitdir: /definitely/missing/worktree\n');
    expect(insideCheckout(stale)).toBe(1);
  });

  it('rejects a saved copy WITHOUT .git ( Gru Command name, tarball/download shape)', () => {
    const dir = stageShape('gru-command-inside-nogit-', { packageName: 'gru-command', git: false });
    expect(insideCheckout(dir)).toBe(1);
  });

  it('rejects the name+git combo without the checkout layout (no src/)', () => {
    const dir = stageShape('gru-command-inside-nosrc-', { packageName: 'gru-command', git: true, withSrc: false });
    expect(insideCheckout(dir)).toBe(1);
  });

  it('reuses one product-checkout predicate for the current root and clone target', () => {
    const source = readFileSync(join(repoRoot, 'install.sh'), 'utf-8');
    expect(source).toContain('is_product_checkout "$REPO_ROOT"');
    expect(source).toContain('is_product_checkout "$CLONE_TARGET"');
    expect((source.match(/grep -Eq/g) ?? [])).toHaveLength(0);
  });
});
