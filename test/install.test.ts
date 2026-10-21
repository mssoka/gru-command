import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { reviewPythonExecutable } from '../src/runtime/review-directory-entries.js';
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

describe('install.sh Darwin Python prerequisite', () => {
  const stage = () => {
    const root = mkdtempSync(join(tmpdir(), 'gru-install-python-'));
    cleanupDirs.push(root);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
    copyFileSync(join(repoRoot, 'install.sh'), join(root, 'install.sh'));
    mkdirSync(join(root, 'install', 'launchd'), { recursive: true });
    copyFileSync(join(repoRoot, 'install/launchd/com.gru-command.service.plist.template'),
      join(root, 'install/launchd/com.gru-command.service.plist.template'));
    const invoke = (flags: readonly string[], python: string) => spawnSync('bash', [join(root, 'install.sh'), ...flags], {
      env: { ...process.env, HOME: root, GRU_COMMAND_HOME: join(root, 'instance'),
        GRU_COMMAND_REVIEW_PYTHON: python, PATH: `${bin}:${process.env.PATH ?? ''}` },
      cwd: root, encoding: 'utf8', timeout: 10_000,
    });
    return { root, invoke };
  };

  it('refuses a missing or unusable interpreter before setup, update, or service registration', () => {
    const { root, invoke } = stage();
    const invalid = join(root, 'missing-python');
    for (const flags of [['--no-interact'], ['--update'], ['--service']]) {
      const missing = invoke(flags, invalid);
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain('requires a usable pinned Python 3');
      expect(readFileSync(join(root, 'install.sh'), 'utf8')).toContain('preflight_python');
    }
    const unusable = join(root, 'unusable-python');
    writeFileSync(unusable, '#!/bin/sh\necho credential-looking-output\n', { mode: 0o755 });
    expect(invoke(['--service'], realpathSync(unusable)).stderr).toContain('inherited directory-FD os.scandir');
    expect(invoke(['--service'], realpathSync(unusable)).stderr).not.toContain('credential-looking-output');
    expect(readFileSync(join(root, 'install.sh'), 'utf8')).not.toContain('credential-looking-output');
  });

  it('probes a private bounded child through both inherited FDs, not the invoking cwd', () => {
    const script = readFileSync(join(repoRoot, 'install.sh'), 'utf8');
    expect(script).toContain("fs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'gru-python-fd-probe-'))");
    expect(script).toContain("os.open(\"child\",os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,dir_fd=root)");
    expect(script).toContain("stdio: ['ignore','pipe','pipe',fd,rootFd]");
    expect(script).not.toContain('fs.openSync(process.cwd()');
  });

  it.skipIf(process.platform !== 'darwin')('rejects a working-directory-sensitive shim even when it can pass the installer FD probe', () => {
    const { root, invoke } = stage();
    const python = reviewPythonExecutable();
    const shim = join(root, 'python-shim');
    writeFileSync(shim, `#!/bin/sh\nif [ "$PWD" = "${root}" ]; then exec "${python}" "$@"; fi\nexit 42\n`, { mode: 0o755 });
    const refused = invoke(['--service'], shim);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('requires a usable pinned Python 3');
    expect(refused.stderr).not.toContain('dist/main.js not found');
    expect(existsSync(join(root, 'instance'))).toBe(false);
  });

  it.skipIf(process.platform !== 'darwin')('probes a real inherited FD and pins its stable interpreter in launchd; passive modes remain available', () => {
    const { root, invoke } = stage();
    const python = reviewPythonExecutable();
    const service = invoke(['--service'], python);
    expect(service.stderr).toContain('dist/main.js not found'); // Stops before any service mutation.
    expect(service.stderr).not.toContain('inherited directory-FD os.scandir');
    const update = invoke(['--update'], python);
    expect(update.stderr).toContain('--update requires an existing configured instance');
    const sessionPython = join(root, 'ephemeral-python');
    symlinkSync(python, sessionPython);
    const rendered = invoke(['--print'], sessionPython);
    expect(rendered.status).toBe(0);
    expect(rendered.stdout).toContain(`<key>GRU_COMMAND_REVIEW_PYTHON</key>\n    <string>${python}</string>`);
    expect(rendered.stdout).not.toContain('{{REVIEW_PYTHON}}');
    expect(invoke(['--print'], join(root, 'missing-python')).status).toBe(0);
    expect(invoke(['--help'], join(root, 'missing-python')).status).toBe(0);
    expect(invoke(['--uninstall'], join(root, 'missing-python')).status).toBe(0);
  });
});

describe('install.sh --print rendering', () => {
  it('declares the standalone Perkins resources in the npm package allowlist', () => {
    const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
      files?: string[];
    };
    expect(packageJson.files).toEqual(expect.arrayContaining([
      'dist/',
      'resources/perkins-code-review/policy.json',
      'roles/',
      'tools/verify-perkins-resource.mjs',
    ]));
  });

  it('the packed tarball actually ships the worker instruction assets the no-call-budget contract lives in (issue #158)', () => {
    // The prompt-contract regression reads the repo tree; this pins the
    // PACKAGED set too, so a packaging change cannot ship an install whose
    // coordinators lack the no-cap contract (issue #158 §3). --ignore-scripts
    // skips prepack: the file list is all this needs, and it stays fast.
    const stdout = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const reported = JSON.parse(stdout) as readonly { files: readonly { path: string }[] }[];
    const packed = new Set((reported[0]?.files ?? []).map((file) => file.path));
    for (const asset of [
      'roles/minion.md',
      'roles/silas.md',
      'roles/gru.md',
      'resources/silas-skills/ops-dispatch/SKILL.md',
      'resources/silas-skills/ledger-closeout/SKILL.md',
    ]) {
      expect(packed.has(asset), `${asset} missing from the packed tarball`).toBe(true);
    }
  });

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

  it('the service runs at normal priority on macOS and Linux — never throttled as a background job (owner decision 2026-10-07)', () => {
    // A launchd ProcessType of Background throttled the service and every
    // minion it spawned; the event-loop stalls it caused were logged as
    // "system sleep" and spent the Perkins admission budget.
    const plist = readFileSync(join(repoRoot, 'install', 'launchd', 'com.gru-command.service.plist.template'), 'utf-8');
    expect(plist).toMatch(/<key>ProcessType<\/key>\s*<string>Standard<\/string>/u);
    expect(plist).not.toContain('<string>Background</string>');
    const unit = readFileSync(join(repoRoot, 'install', 'systemd', 'gru-command.service.template'), 'utf-8');
    expect(unit).not.toMatch(/^\s*(?:Nice=\s*[1-9]|CPUSchedulingPolicy=\s*(?:idle|batch)|IOSchedulingClass=\s*idle)/mu);
  });

  it('renders a launchd PATH with stable Node/npm after the session bin disappears', () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-command-launchd-path-'));
    cleanupDirs.push(home);
    const sessionBin = join(home, 'ephemeral version manager', 'bin');
    mkdirSync(sessionBin, { recursive: true });
    symlinkSync(process.execPath, join(sessionBin, 'node'));
    // Render launchd even on Linux CI by selecting the installer OS seam.
    writeFileSync(join(sessionBin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 });
    const stableBin = dirname(realpathSync(process.execPath));
    const { status, stdout } = print({ PATH: `${sessionBin}:/usr/local/bin:/usr/bin:/bin` });
    expect(status).toBe(0);
    const servicePath = stdout.match(/<key>PATH<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
    expect(servicePath).toBeDefined();
    expect(servicePath!.split(':')[0]).toBe(stableBin);
    rmSync(sessionBin, { recursive: true, force: true });
    const npm = spawnSync('sh', ['-c', 'command -v npm && npm --version'], {
      env: { PATH: servicePath! }, encoding: 'utf-8',
    });
    expect(npm.status, `${npm.stdout}\n${npm.stderr}`).toBe(0);
    expect(realpathSync(npm.stdout.split('\n')[0]!)).toBe(realpathSync(join(stableBin, 'npm')));
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

describe('the gru launcher (#463)', () => {
  /** Run install.sh's launcher functions against controlled values; no
   * other installer code runs. Returns the shell's exit status and output. */
  function launcherShell(vars: Readonly<Record<string, string>>, body: string, path?: string) {
    const installScript = join(repoRoot, 'install.sh');
    const script = [
      'set -euo pipefail',
      'err() { echo "install.sh: $*" >&2; }',
      ...Object.entries(vars).map(([name, value]) => `${name}=${shellQuote(value)}`),
      `eval "$(sed -n '/^LAUNCHER_MARKER=/p;/^launcher_path()/,/^}/p;/^is_our_launcher()/,/^}/p;/^sh_single_quote()/,/^}/p;/^write_launcher()/,/^}/p;/^link_cli()/,/^}/p' ${shellQuote(installScript)})"`,
      body,
    ].join('\n');
    return spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PATH: path ?? process.env.PATH ?? '' },
    });
  }

  function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
  }

  function stage() {
    const root = mkdtempSync(join(tmpdir(), 'gru-launcher-'));
    cleanupDirs.push(root);
    // A clone and an instance whose paths need quoting.
    const clone = join(root, "clone it's");
    mkdirSync(join(clone, 'dist', 'cli'), { recursive: true });
    writeFileSync(join(clone, 'install.sh'), '#!/bin/sh\n');
    writeFileSync(join(clone, 'dist', 'cli', 'service.js'),
      "console.log(`HOME=${process.env.GRU_COMMAND_HOME} ARGS=${process.argv.slice(2).join('|')}`);\n");
    const bin = join(root, 'bin');
    const instance = join(root, 'inst ance');
    const node = realpathSync(process.execPath);
    return { root, clone, bin, instance, node, vars: { BIN_DIR: bin, REPO_ROOT: clone, NODE_BIN: node, INSTANCE_DIR: instance } };
  }

  it('pins node, checkout and instance, quotes every path, and runs from any directory', () => {
    const { bin, instance, vars } = stage();
    const linked = launcherShell(vars, 'link_cli');
    expect(linked.status, linked.stderr).toBe(0);
    const launcher = join(bin, 'gru');
    const run = (env: NodeJS.ProcessEnv) => spawnSync(launcher, ['status', 'a b'], { cwd: tmpdir(), encoding: 'utf8', env });
    const { GRU_COMMAND_HOME: _ignored, ...withoutHome } = process.env;
    expect(run(withoutHome).stdout).toBe(`HOME=${instance} ARGS=status|a b\n`);
    // An explicit instance still wins over the pinned one.
    expect(run({ ...withoutHome, GRU_COMMAND_HOME: '/explicit' }).stdout).toBe('HOME=/explicit ARGS=status|a b\n');
  });

  it('a vanished node, build or checkout names its own repair, carrying the instance, instead of a bare exec error', () => {
    const { bin, clone, instance, vars } = stage();
    // Each part quoted as install.sh quotes it, so the printed command pastes as one.
    const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const repair = `GRU_COMMAND_HOME=${q(instance)} ${q(`${clone}/install.sh`)} --update`;
    const gru = () => spawnSync(join(bin, 'gru'), ['version'], { encoding: 'utf8' });
    expect(launcherShell({ ...vars, NODE_BIN: join(clone, 'gone', 'node') }, 'link_cli').status).toBe(0);
    expect(gru()).toMatchObject({ status: 1 });
    expect(gru().stderr).toContain(`is gone; from a shell with a current Node.js run: ${repair}`);
    expect(launcherShell(vars, 'link_cli').status).toBe(0);
    rmSync(join(clone, 'dist', 'cli', 'service.js'));
    expect(gru()).toMatchObject({ status: 1 });
    expect(gru().stderr).toContain(`this install is not built; rebuild it (this also pulls main and restarts the service) with: ${repair}`);
    rmSync(join(clone, 'install.sh'));
    expect(gru()).toMatchObject({ status: 1 });
    expect(gru().stderr).toContain(`the Gru Command checkout at ${clone} is gone; reinstall it with the one-line installer`);
  });

  it('relinking an unchanged launcher is quiet, so setup plus the wizard\'s --service print it once', () => {
    const { vars } = stage();
    const first = launcherShell(vars, 'link_cli');
    expect(first.stdout).toContain("installed the 'gru' command");
    const again = launcherShell(vars, 'link_cli');
    expect(again.status).toBe(0);
    expect(again.stdout).toBe('');
    expect(again.stderr).toBe('');
  });

  it('stays quiet when ours is first on PATH, and warns about a gru ahead of it even when nothing changed', () => {
    const { root, bin, vars } = stage();
    const decoys = join(root, 'decoys');
    mkdirSync(decoys);
    writeFileSync(join(decoys, 'gru'), '#!/bin/sh\necho decoy\n', { mode: 0o755 });
    const first = launcherShell(vars, 'link_cli', `${bin}:${decoys}:${process.env.PATH ?? ''}`);
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("installed the 'gru' command");
    expect(first.stdout).not.toContain('not on your PATH');
    expect(first.stderr).toBe('');
    // Unchanged launcher, a gru that appeared ahead of it since: still reported.
    const shadowed = launcherShell(vars, 'link_cli', `${decoys}:${bin}:${process.env.PATH ?? ''}`);
    expect(shadowed.status).toBe(0);
    expect(shadowed.stdout).toBe('');
    expect(shadowed.stderr).toContain(`another 'gru' comes first on your PATH: ${decoys}/gru`);
  });

  it('an unchanged launcher that lost its exec bit is repaired; one already current needs no writable bin dir', () => {
    const { bin, vars } = stage();
    expect(launcherShell(vars, 'link_cli').status).toBe(0);
    const launcher = join(bin, 'gru');
    chmodSync(launcher, 0o644);
    const repaired = launcherShell(vars, 'link_cli');
    expect(repaired.stdout).toContain("installed the 'gru' command");
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
    chmodSync(bin, 0o555);
    try {
      const current = launcherShell(vars, 'link_cli');
      expect(current.status).toBe(0);
      expect(current.stdout).toBe('');
      expect(current.stderr).toBe('');
    } finally {
      chmodSync(bin, 0o755);
    }
  });

  it('a launcher that cannot be written never stops the install around it', () => {
    const { root, vars } = stage();
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, 'a file where the bin dir would go\n');
    const blocked = launcherShell({ ...vars, BIN_DIR: join(blocker, 'bin') }, 'link_cli; echo "install continues"');
    expect(blocked.status).toBe(0);
    expect(blocked.stdout).toContain('install continues');
    expect(blocked.stderr).toContain("could not install the 'gru' command");
  });
});

describe('install.sh node selection (#463)', () => {
  const bash = execFileSync('/bin/sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim();
  /** One top-level function of install.sh, verbatim. */
  function functionSource(name: string): string {
    const text = readFileSync(join(repoRoot, 'install.sh'), 'utf8');
    const start = text.indexOf(`\n${name}() {\n`);
    expect(start).toBeGreaterThanOrEqual(0);
    return text.slice(start + 1, text.indexOf('\n}\n', start) + 2);
  }
  /** install.sh's node_ok + select_node_bin, with PATH holding only `dir`:
   * the node chosen, and the npm the build would then find (`|`-joined when asked). */
  function selected(dir: string, gruNode?: string, withNpm = false): string {
    const report = withNpm ? 'printf %s "$NODE_BIN|$(command -v npm)"' : 'printf %s "$NODE_BIN"';
    const script = [functionSource('node_ok'), functionSource('select_node_bin'), 'select_node_bin', report].join('\n');
    return spawnSync(bash, ['-c', script], {
      encoding: 'utf8',
      env: { PATH: dir, ...(gruNode === undefined ? {} : { GRU_COMMAND_NODE: gruNode }) },
    }).stdout;
  }

  it('the shell\'s node wins; the node gru runs on stands in only for none or one below the minimum', () => {
    const root = mkdtempSync(join(tmpdir(), 'gru-node-select-'));
    cleanupDirs.push(root);
    const none = join(root, 'none');
    const old = join(root, 'old');
    const current = join(root, 'current');
    for (const dir of [none, old, current]) mkdirSync(dir);
    // A Node.js 18: answers the realpath probe with itself and fails the version check.
    writeFileSync(join(old, 'node'), '#!/bin/sh\ncase "$1" in -p) echo "$0" ;; *) exit 1 ;; esac\n', { mode: 0o755 });
    symlinkSync(process.execPath, join(current, 'node'));
    const gruNode = realpathSync(process.execPath);
    expect(selected(none, gruNode)).toBe(gruNode);
    expect(selected(old, gruNode)).toBe(gruNode);
    // Without `gru` the old node stays, and setup then names the upgrade.
    expect(selected(old)).toBe(join(old, 'node'));
    // A current shell node wins over the handed-over one (a Node upgrade is picked up).
    expect(selected(current, join(old, 'node'))).toBe(realpathSync(process.execPath));
    // A handed-over node that is not executable is no fallback.
    expect(selected(none, join(root, 'missing', 'node'))).toBe('');
  });

  it('when the handed-over node is chosen, npm and node for the build come from beside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'gru-node-npm-'));
    cleanupDirs.push(root);
    const none = join(root, 'none');
    const install = join(root, 'node-install', 'bin');
    mkdirSync(none);
    mkdirSync(install, { recursive: true });
    symlinkSync(process.execPath, join(install, 'node'));
    writeFileSync(join(install, 'npm'), '#!/bin/sh\n', { mode: 0o755 });
    expect(selected(none, join(install, 'node'), true)).toBe(`${join(install, 'node')}|${join(install, 'npm')}`);
  });
});
