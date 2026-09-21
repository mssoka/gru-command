import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * install.sh setup mode (E9): the one-line-install pipeline exercised
 * for real against a local file:// clone FIXTURE — a minimal
 * product-shaped repo (real install.sh + a build that produces stub
 * dist/main.js + dist/wizard/main.js). Proves: clone-when-absent,
 * deps+build, wizard exec, no-reclone inside a checkout, no-reclone
 * when the target already holds the checkout — plus the E7 flag
 * contracts re-pinned (--print / --uninstall / unknown flag).
 */

const repoRoot = join(import.meta.dirname, '..');
const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

let lastStderr = '';

function run(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('bash', [script, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      timeout: 120_000,
    });
    lastStderr = '';
    return { stdout, stderr: '', status: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; status?: number };
    lastStderr = err.stderr ?? '';
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.status ?? 1 };
  }
}

/** A minimal product-shaped repo the one-liner can clone and build. */
function buildFixtureRepo(): { fixture: string; home: string } {
  const fixture = tempDir('gru-command-fixture-src-');
  const home = tempDir('gru-command-fixture-home-');
  copyFileSync(join(repoRoot, 'install.sh'), join(fixture, 'install.sh'));
  for (const unit of [
    'launchd/com.gru-command.service.plist.template',
    'systemd/gru-command.service.template',
  ]) {
    const target = join(fixture, 'install', unit);
    mkdirSync(join(fixture, 'install', ...unit.split('/').slice(0, -1)), { recursive: true });
    copyFileSync(join(repoRoot, 'install', unit), target);
  }
  // A product checkout is a Gru Command checkout: package.json NAMED
  // gru-command + src/ + install.sh + .git (W-B tightened the heuristic —
  // repo shape alone no longer passes).
  mkdirSync(join(fixture, 'src'), { recursive: true });
  writeFileSync(join(fixture, 'src', 'marker.ts'), 'export {};\n', 'utf-8');
  mkdirSync(join(fixture, 'resources', 'perkins-code-review'), { recursive: true });
  writeFileSync(
    join(fixture, 'resources', 'perkins-code-review', 'policy.json'),
    '{"fixture":"tracked-product-root-resource-v1"}\n',
    'utf-8',
  );
  mkdirSync(join(fixture, 'tools'), { recursive: true });
  writeFileSync(
    join(fixture, 'tools', 'verify-perkins-resource.mjs'),
    [
      "import { appendFileSync, existsSync, realpathSync } from 'node:fs';",
      "import { join } from 'node:path';",
      "const root = realpathSync(process.argv[2] ?? '');",
      "for (const path of ['resources/perkins-code-review/policy.json', 'dist/runtime/review-mcp-server.mjs']) {",
      "  if (!existsSync(join(root, path))) throw new Error('missing Perkins fixture asset: ' + path);",
      "}",
      "if (process.env.GRU_PERKINS_VERIFY_LOG) appendFileSync(process.env.GRU_PERKINS_VERIFY_LOG, root + '\\n');",
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(join(fixture, '.gitignore'), 'node_modules/\ndist/\npackage-lock.json\n', 'utf-8');
  writeFileSync(
    join(fixture, 'package.json'),
    JSON.stringify(
      {
        name: 'gru-command',
        version: '0.0.0',
        private: true,
        type: 'module',
        scripts: { build: 'node make-dist.mjs', 'build:web': 'node make-web.mjs' },
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  // The fixture "build" produces the two artifacts install.sh checks for.
  writeFileSync(
    join(fixture, 'make-dist.mjs'),
    [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      'mkdirSync("dist/wizard", { recursive: true });',
      'mkdirSync("dist/cli", { recursive: true });',
      'mkdirSync("dist/runtime", { recursive: true });',
      'writeFileSync("dist/main.js", "// fixture service stub\\n");',
      'writeFileSync("dist/cli/config-generate.js", "// fixture config CLI stub\\n");',
      'if (process.env.GRU_FIXTURE_OMIT_MCP !== "1") writeFileSync("dist/runtime/review-mcp-server.mjs", "// fixture scoped review MCP bridge\\n");',
      // The fixture wizard stub: records that it ran + the answers it got,
      // into the instance dir — the real wizard is covered by the
      // rehearsal + wizard tests.
      'writeFileSync("dist/wizard/main.js", `#!/usr/bin/env node',
      "import { mkdirSync, openSync, writeFileSync } from 'node:fs';",
      "import { createInterface } from 'node:readline/promises';",
      "import { ReadStream, WriteStream } from 'node:tty';",
      'const home = process.env.GRU_COMMAND_HOME ?? "";',
      "let answers = process.argv.slice(2).join(' ');",
      "if (answers === '') {",
      "  const input = new ReadStream(openSync('/dev/tty', 'r'));",
      "  const output = new WriteStream(openSync('/dev/tty', 'w'));",
      "  const rl = createInterface({ input, output });",
      "  answers = 'interactive:' + (await rl.question('FIXTURE WIZARD PROMPT: ')).trim();",
      "  rl.close();",
      "}",
      "if (home) { mkdirSync(home, { recursive: true });",
      '  writeFileSync(home + "/config.toml", "wizard-ran: " + answers); }',
      'console.log("WIZARD-RAN " + answers);',
      'process.exit(0);',
      '`);',
      '',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    join(fixture, 'make-web.mjs'),
    [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      'mkdirSync("web/dist", { recursive: true });',
      'writeFileSync("web/dist/install-built.txt", "built by installer\\n");',
      '',
    ].join('\n'),
    'utf-8',
  );
  // gitInitCommit(fixture) is the CALLER's first step (kept separate so
  // each test controls its fixture's git state).
  return { fixture, home };
}

function gitInitCommit(dir: string): void {
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', [
    '-C', dir, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture',
    'commit', '-qm', 'fixture product',
  ]);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function expectAvailable(): boolean {
  try {
    execFileSync('which', ['expect'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function python3Available(): boolean {
  try {
    execFileSync('which', ['python3'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Sandbox service-manager seam: a fake launchctl/systemctl that logs its
 * argv. Real unit files still land under the sandbox HOME — assertions
 * check those REAL effects, never echo text alone. */
function serviceManagerSeam(home: string): {
  manager: string;
  managerLog: string;
  unit: string;
  env: NodeJS.ProcessEnv;
} {
  const managerLog = join(home, 'manager.log');
  const manager = join(home, 'service-manager');
  writeFileSync(manager, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$GRU_MANAGER_LOG"\nexit 0\n', {
    encoding: 'utf-8',
    mode: 0o755,
  });
  const unit = process.platform === 'darwin'
    ? join(home, 'Library', 'LaunchAgents', 'com.gru-command.service.plist')
    : join(home, '.config', 'systemd', 'user', 'gru-command.service');
  return {
    manager,
    managerLog,
    unit,
    env: {
      GRU_MANAGER_LOG: managerLog,
      GRU_COMMAND_LAUNCHCTL: manager,
      GRU_COMMAND_SYSTEMCTL: manager,
    },
  };
}

/** REAL-effect proof that the absent-unit path registered the service:
 * the unit exists under the sandbox HOME, names this checkout's service
 * entrypoint AND this instance's data dir, and the platform manager was
 * actually invoked. */
function expectRegisteredUnit(
  managerLog: string,
  unit: string,
  repoTarget: string,
  instance: string,
): void {
  expect(existsSync(unit)).toBe(true);
  const unitText = readFileSync(unit, 'utf-8');
  expect(unitText).toContain(`${repoTarget}/dist/main.js`);
  expect(unitText).toContain(instance);
  const calls = readFileSync(managerLog, 'utf-8');
  if (process.platform === 'darwin') {
    expect(calls.split('\n')).toContain(`load ${unit}`);
  } else {
    expect(calls).toMatch(
      /--user daemon-reload[\s\S]*--user enable gru-command\.service[\s\S]*--user restart gru-command\.service/,
    );
  }
}

/** A configured instance whose clone already sits at head, plus the
 * service-manager seam — the exact preconditions of the safe updater's
 * absent-unit path. */
function stageConfiguredAbsentUnit(): { fixture: string; home: string; target: string; instance: string; seam: ReturnType<typeof serviceManagerSeam> } {
  const { fixture, home } = buildFixtureRepo();
  gitInitCommit(fixture);
  const target = join(home, 'gru-command');
  execFileSync('git', ['clone', '-q', `file://${fixture}`, target], { stdio: 'pipe' });
  const instance = join(home, '.gru-command');
  mkdirSync(instance, { recursive: true });
  writeFileSync(join(instance, 'config.toml'), 'preserved\n');
  return { fixture, home, target, instance, seam: serviceManagerSeam(home) };
}

function ptyUpdaterLauncher(home: string, target: string, instance: string, seam: ReturnType<typeof serviceManagerSeam>): string {
  const launcher = join(home, 'launch-updater.sh');
  writeFileSync(
    launcher,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `export HOME=${shellQuote(home)}`,
      `export GRU_COMMAND_HOME=${shellQuote(instance)}`,
      `export GRU_MANAGER_LOG=${shellQuote(seam.managerLog)}`,
      `export GRU_COMMAND_LAUNCHCTL=${shellQuote(seam.manager)}`,
      `export GRU_COMMAND_SYSTEMCTL=${shellQuote(seam.manager)}`,
      `cd ${shellQuote(target)}`,
      'exec bash ./install.sh',
      '',
    ].join('\n'),
    { encoding: 'utf-8', mode: 0o755 },
  );
  return launcher;
}

describe('install.sh setup mode (one-line path)', () => {
  it('piped install: clones when absent → deps → build → wizard (marker written)', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    // The one-liner case: a bare directory holding ONLY install.sh
    // (what curl|bash actually runs) — no checkout around it.
    const bare = tempDir('gru-command-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const target = join(home, 'gru-command');
    const verifyLog = join(home, 'perkins-verify.log');

    const { stdout, status } = run(
      join(bare, 'install.sh'),
      ['--answers', '{"token":"fixture-token"}'],
      {
        HOME: home,
        GRU_COMMAND_HOME: join(home, '.gru-command'),
        GRU_COMMAND_ORIGIN: `file://${fixture}`,
        GRU_COMMAND_TARGET: target,
        GRU_PERKINS_VERIFY_LOG: verifyLog,
      },
    );
    expect(status, stdout).toBe(0);
    // Clone landed and was built.
    expect(existsSync(join(target, 'package.json'))).toBe(true);
    expect(existsSync(join(target, 'dist/main.js'))).toBe(true);
    expect(readFileSync(join(target, 'web', 'dist', 'install-built.txt'), 'utf-8')).toContain(
      'built by installer',
    );
    expect(
      readFileSync(join(target, 'resources', 'perkins-code-review', 'policy.json'), 'utf-8'),
    ).toContain('tracked-product-root-resource-v1');
    expect(existsSync(join(target, 'tools', 'verify-perkins-resource.mjs'))).toBe(true);
    // The wizard ran non-interactively with the forwarded answers.
    const config = join(home, '.gru-command', 'config.toml');
    expect(existsSync(config)).toBe(true);
    expect(stdout).toContain('WIZARD-RAN');
    expect(stdout).toContain('verifying installed Perkins resources');
    expect(readFileSync(verifyLog, 'utf-8').trim()).toBe(realpathSync(target));
  });

  it('fails closed before setup when the built Perkins MCP bridge is missing', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const bare = tempDir('gru-command-missing-mcp-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const instance = join(home, '.gru-command');
    const result = run(join(bare, 'install.sh'), ['--no-interact'], {
      HOME: home,
      GRU_COMMAND_HOME: instance,
      GRU_COMMAND_ORIGIN: `file://${fixture}`,
      GRU_COMMAND_TARGET: join(home, 'gru-command'),
      GRU_FIXTURE_OMIT_MCP: '1',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('build did not produce dist/runtime/review-mcp-server.mjs');
    expect(existsSync(join(instance, 'config.toml'))).toBe(false);
  });

  it('a newly recreated clone preserves a retained instance config instead of rerunning setup', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const bare = tempDir('gru-command-retained-config-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const instance = join(home, '.gru-command');
    mkdirSync(instance, { recursive: true });
    writeFileSync(join(instance, 'config.toml'), 'retained-user-config\n');
    const seam = serviceManagerSeam(home);
    // --no-interact: the retained instance's ABSENT unit is auto-registered
    // (user-ruled update contract) — asserted by REAL effect below.
    const result = run(join(bare, 'install.sh'), ['--no-interact'], {
      HOME: home,
      GRU_COMMAND_HOME: instance,
      GRU_COMMAND_ORIGIN: `file://${fixture}`,
      GRU_COMMAND_TARGET: join(home, 'gru-command'),
      ...seam.env,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('update complete; existing config preserved');
    expect(result.stdout).not.toContain('WIZARD-RAN');
    expect(readFileSync(join(instance, 'config.toml'), 'utf-8')).toBe('retained-user-config\n');
    expectRegisteredUnit(seam.managerLog, seam.unit, join(home, 'gru-command'), instance);
  });

  it.skipIf(!expectAvailable())('literal cat|bash install keeps prompts on /dev/tty and completes in one invocation', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const bare = tempDir('gru-command-pipe-pty-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const instance = join(home, '.gru-command');
    const launcher = join(bare, 'launch.sh');
    writeFileSync(
      launcher,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `export HOME=${shellQuote(home)}`,
        `export GRU_COMMAND_HOME=${shellQuote(instance)}`,
        `export GRU_COMMAND_ORIGIN=${shellQuote(`file://${fixture}`)}`,
        `export GRU_COMMAND_TARGET=${shellQuote(join(home, 'gru-command'))}`,
        `cd ${shellQuote(bare)}`,
        'cat install.sh | bash',
        '',
      ].join('\n'),
      { encoding: 'utf-8', mode: 0o755 },
    );
    const expectScript = [
      'set timeout 120',
      `spawn bash ${launcher}`,
      'expect -ex {FIXTURE WIZARD PROMPT: }',
      'send -- "from-dev-tty\\r"',
      'expect eof',
      'set result [wait]',
      'exit [lindex $result 3]',
    ].join('\n');
    const output = execFileSync('expect', ['-c', expectScript], {
      encoding: 'utf-8',
      timeout: 150_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\r/g, '');
    expect(output).toContain('cloning');
    expect(output).toContain('FIXTURE WIZARD PROMPT');
    expect(output).toContain('WIZARD-RAN interactive:from-dev-tty');
    expect(readFileSync(join(instance, 'config.toml'), 'utf-8')).toContain(
      'interactive:from-dev-tty',
    );
  }, 180_000);

  it('second run fast-forwards the existing clean checkout, preserves config, and does not re-run wizard', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const bare = tempDir('gru-command-bare2-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const target = join(home, 'gru-command');
    const instance = join(home, '.gru-command');
    const env = {
      HOME: home,
      GRU_COMMAND_HOME: instance,
      GRU_COMMAND_ORIGIN: `file://${fixture}`,
      GRU_COMMAND_TARGET: target,
    };
    expect(run(join(bare, 'install.sh'), ['--answers', '{"token":"preserved"}'], env).status).toBe(0);
    const before = readFileSync(join(instance, 'config.toml'), 'utf-8');
    writeFileSync(join(fixture, 'remote-update.txt'), 'pulled', 'utf-8');
    writeFileSync(
      join(fixture, 'resources', 'perkins-code-review', 'policy.json'),
      '{"fixture":"tracked-product-root-resource-v2"}\n',
      'utf-8',
    );
    execFileSync('git', [
      '-C', fixture, 'add', 'remote-update.txt', 'resources/perkins-code-review/policy.json',
    ]);
    execFileSync('git', [
      '-C', fixture, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture',
      'commit', '-qm', 'fixture update',
    ]);

    const seam = serviceManagerSeam(home);
    const second = run(join(bare, 'install.sh'), ['--no-interact'], { ...env, ...seam.env });
    expect(second.status, `${second.stdout}\n${second.stderr}`).toBe(0);
    expectRegisteredUnit(seam.managerLog, seam.unit, target, instance);
    expect(existsSync(join(target, 'remote-update.txt'))).toBe(true);
    expect(
      readFileSync(join(target, 'resources', 'perkins-code-review', 'policy.json'), 'utf-8'),
    ).toContain('tracked-product-root-resource-v2');
    expect(existsSync(join(target, 'tools', 'verify-perkins-resource.mjs'))).toBe(true);
    expect(readFileSync(join(instance, 'config.toml'), 'utf-8')).toBe(before);
    expect(second.stdout).toContain('git pull --ff-only');
    expect(second.stdout).toContain('update complete; existing config preserved');
    expect(second.stdout).not.toContain('WIZARD-RAN');
  });

  it('fast-forwards an old target before executing target-local installer logic', () => {
    const { fixture, home } = buildFixtureRepo();
    const currentInstaller = readFileSync(join(fixture, 'install.sh'), 'utf-8');
    writeFileSync(
      join(fixture, 'install.sh'),
      '#!/usr/bin/env bash\nprintf old > "$OLD_INSTALLER_MARKER"\nexit 77\n',
    );
    gitInitCommit(fixture);
    const target = join(home, 'gru-command');
    execFileSync('git', ['clone', `file://${fixture}`, target], { stdio: 'pipe' });
    writeFileSync(join(fixture, 'install.sh'), currentInstaller);
    execFileSync('git', ['-C', fixture, 'add', 'install.sh']);
    execFileSync('git', [
      '-C', fixture, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture',
      'commit', '-qm', 'new installer',
    ]);

    const bare = tempDir('gru-command-old-target-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const instance = join(home, '.gru-command');
    mkdirSync(instance, { recursive: true });
    writeFileSync(join(instance, 'config.toml'), 'preserved\n');
    const oldMarker = join(home, 'old-installer-ran');
    const seam = serviceManagerSeam(home);
    const result = run(join(bare, 'install.sh'), ['--no-interact'], {
      HOME: home,
      GRU_COMMAND_HOME: instance,
      GRU_COMMAND_ORIGIN: `file://${fixture}`,
      GRU_COMMAND_TARGET: target,
      OLD_INSTALLER_MARKER: oldMarker,
      ...seam.env,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(oldMarker)).toBe(false);
    expect(readFileSync(join(instance, 'config.toml'), 'utf-8')).toBe('preserved\n');
    expectRegisteredUnit(seam.managerLog, seam.unit, target, instance);
  });

  it('refuses a dirty existing checkout before pull/build and preserves its config', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const bare = tempDir('gru-command-dirty-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const target = join(home, 'gru-command');
    const instance = join(home, '.gru-command');
    const env = {
      HOME: home,
      GRU_COMMAND_HOME: instance,
      GRU_COMMAND_ORIGIN: `file://${fixture}`,
      GRU_COMMAND_TARGET: target,
    };
    expect(run(join(bare, 'install.sh'), ['--answers', '{"token":"keep-me"}'], env).status).toBe(0);
    const before = readFileSync(join(instance, 'config.toml'), 'utf-8');
    writeFileSync(join(target, 'local-untracked.txt'), 'do not delete', 'utf-8');
    const updated = run(join(bare, 'install.sh'), [], env);
    expect(updated.status).toBe(1);
    expect(updated.stderr).toContain('refusing to update a dirty checkout');
    expect(readFileSync(join(target, 'local-untracked.txt'), 'utf-8')).toBe('do not delete');
    expect(readFileSync(join(instance, 'config.toml'), 'utf-8')).toBe(before);
  });

  it('refuses a non-fast-forward divergent checkout without reset', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const bare = tempDir('gru-command-diverged-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const target = join(home, 'gru-command');
    const env = {
      HOME: home,
      GRU_COMMAND_HOME: join(home, '.gru-command'),
      GRU_COMMAND_ORIGIN: `file://${fixture}`,
      GRU_COMMAND_TARGET: target,
    };
    expect(run(join(bare, 'install.sh'), ['--answers', '{}'], env).status).toBe(0);
    writeFileSync(join(target, 'local-commit.txt'), 'local', 'utf-8');
    execFileSync('git', ['-C', target, 'add', 'local-commit.txt']);
    execFileSync('git', [
      '-C', target, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture',
      'commit', '-qm', 'local divergence',
    ]);
    writeFileSync(join(fixture, 'remote-commit.txt'), 'remote', 'utf-8');
    execFileSync('git', ['-C', fixture, 'add', 'remote-commit.txt']);
    execFileSync('git', [
      '-C', fixture, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture',
      'commit', '-qm', 'remote divergence',
    ]);
    const updated = run(join(bare, 'install.sh'), [], env);
    expect(updated.status).toBe(1);
    expect(updated.stderr).toContain('fast-forward-only update failed');
    expect(existsSync(join(target, 'local-commit.txt'))).toBe(true);
  });

  it('restarts only an owned service and refuses a foreign unit with the same public name', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const bare = tempDir('gru-command-service-update-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const target = join(home, 'gru-command');
    const instance = join(home, '.gru-command');
    const managerLog = join(home, 'manager.log');
    const manager = join(home, 'service-manager');
    writeFileSync(manager, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$GRU_MANAGER_LOG"\nexit 0\n', {
      encoding: 'utf-8',
      mode: 0o755,
    });
    const unit = process.platform === 'darwin'
      ? join(home, 'Library', 'LaunchAgents', 'com.gru-command.service.plist')
      : join(home, '.config', 'systemd', 'user', 'gru-command.service');
    const env = {
      HOME: home,
      GRU_COMMAND_HOME: instance,
      GRU_COMMAND_ORIGIN: `file://${fixture}`,
      GRU_COMMAND_TARGET: target,
      GRU_MANAGER_LOG: managerLog,
      GRU_COMMAND_LAUNCHCTL: manager,
      GRU_COMMAND_SYSTEMCTL: manager,
    };
    expect(run(join(bare, 'install.sh'), ['--answers', '{}'], env).status).toBe(0);

    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, '/someone/else/dist/main.js\n/someone/else/.gru-command\n');
    const foreign = run(join(bare, 'install.sh'), [], env);
    expect(foreign.status).toBe(1);
    expect(foreign.stderr).toContain('refusing to restart unrelated service unit');
    expect(readFileSync(unit, 'utf-8')).toContain('/someone/else');

    const renderedOwned = run(join(target, 'install.sh'), ['--print'], env);
    expect(renderedOwned.status, renderedOwned.stderr).toBe(0);
    writeFileSync(unit, renderedOwned.stdout);
    const owned = run(join(bare, 'install.sh'), [], env);
    expect(owned.status, `${owned.stdout}\n${owned.stderr}`).toBe(0);
    expect(owned.stdout).toContain('restarting owned Gru Command service');
    const managerCalls = readFileSync(managerLog, 'utf-8');
    if (process.platform === 'darwin') {
      expect(managerCalls.split('\n')).toContain(`load ${unit}`);
    } else {
      expect(managerCalls).toMatch(/--user daemon-reload[\s\S]*--user enable gru-command\.service[\s\S]*--user restart gru-command\.service/);
    }
    expect(readFileSync(unit, 'utf-8')).toContain(`${target}/dist/main.js`);
  });

  it('--no-interact + absent unit: the updater REGISTERS the service (unit written + manager called)', () => {
    const { home, target, instance, seam } = stageConfiguredAbsentUnit();
    const result = run(join(target, 'install.sh'), ['--no-interact'], {
      HOME: home,
      GRU_COMMAND_HOME: instance,
      ...seam.env,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('update complete; existing config preserved');
    expect(result.stdout).not.toContain('WIZARD-RAN');
    expectRegisteredUnit(seam.managerLog, seam.unit, target, instance);
  });

  it.skipIf(!expectAvailable())('interactive + absent unit + default answer: prompts, then REGISTERS the service', () => {
    const { home, target, instance, seam } = stageConfiguredAbsentUnit();
    const launcher = ptyUpdaterLauncher(home, target, instance, seam);
    const expectScript = [
      'set timeout 300',
      `spawn bash ${launcher}`,
      'expect "register one now"',
      'send -- "\\r"',
      'expect eof',
      'set result [wait]',
      'exit [lindex $result 3]',
    ].join('\n');
    const output = execFileSync('expect', ['-c', expectScript], {
      encoding: 'utf-8',
      timeout: 360_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\r/g, '');
    expect(output).toContain('register one now');
    expect(output).toContain('installed:');
    expect(output).toContain('update complete; existing config preserved');
    expectRegisteredUnit(seam.managerLog, seam.unit, target, instance);
  }, 400_000);

  it.skipIf(!expectAvailable())('interactive + absent unit + decline: NO install, recovery hint, exit success', () => {
    const { home, target, instance, seam } = stageConfiguredAbsentUnit();
    const launcher = ptyUpdaterLauncher(home, target, instance, seam);
    const expectScript = [
      'set timeout 300',
      `spawn bash ${launcher}`,
      'expect "register one now"',
      'send -- "n\\r"',
      'expect eof',
      'set result [wait]',
      'exit [lindex $result 3]',
    ].join('\n');
    const output = execFileSync('expect', ['-c', expectScript], {
      encoding: 'utf-8',
      timeout: 360_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\r/g, '');
    expect(output).toContain('register one now');
    expect(output).toContain('update complete; existing config preserved');
    expect(output).toContain('no service installed or running — ./install.sh --service registers it later');
    expect(output).not.toContain(`installed: ${seam.unit}`);
    expect(existsSync(seam.unit)).toBe(false);
    expect(existsSync(seam.managerLog)).toBe(false);
  }, 400_000);

  it.skipIf(!expectAvailable())('piped cat|bash updater + absent unit: prompt reads the TTY, not the script pipe (decline)', () => {
    const { home, target, instance, seam } = stageConfiguredAbsentUnit();
    const launcher = join(home, 'launch-piped-updater.sh');
    writeFileSync(
      launcher,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `export HOME=${shellQuote(home)}`,
        `export GRU_COMMAND_HOME=${shellQuote(instance)}`,
        `export GRU_MANAGER_LOG=${shellQuote(seam.managerLog)}`,
        `export GRU_COMMAND_LAUNCHCTL=${shellQuote(seam.manager)}`,
        `export GRU_COMMAND_SYSTEMCTL=${shellQuote(seam.manager)}`,
        `cd ${shellQuote(target)}`,
        'cat ./install.sh | bash',
        '',
      ].join('\n'),
      { encoding: 'utf-8', mode: 0o755 },
    );
    const expectScript = [
      'set timeout 300',
      `spawn bash ${launcher}`,
      'expect "register one now"',
      'send -- "n\\r"',
      'expect eof',
      'set result [wait]',
      'exit [lindex $result 3]',
    ].join('\n');
    const output = execFileSync('expect', ['-c', expectScript], {
      encoding: 'utf-8',
      timeout: 360_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\r/g, '');
    // The prompt reached the controlling terminal and the answer was read
    // from it — the piped SCRIPT was never consumed as the reply.
    expect(output).toContain('register one now');
    expect(output).toContain('update complete; existing config preserved');
    expect(output).toContain('no service installed or running — ./install.sh --service registers it later');
    expect(output).not.toContain(`installed: ${seam.unit}`);
    expect(existsSync(seam.unit)).toBe(false);
    expect(existsSync(seam.managerLog)).toBe(false);
  }, 400_000);

  it.skipIf(!python3Available())('headless run (no terminal, no --no-interact): defaults to REGISTER with a stderr notice', () => {
    const { home, target, instance, seam } = stageConfiguredAbsentUnit();
    const launcher = join(home, 'launch-headless-updater.sh');
    writeFileSync(
      launcher,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        `export HOME=${shellQuote(home)}`,
        `export GRU_COMMAND_HOME=${shellQuote(instance)}`,
        `export GRU_MANAGER_LOG=${shellQuote(seam.managerLog)}`,
        `export GRU_COMMAND_LAUNCHCTL=${shellQuote(seam.manager)}`,
        `export GRU_COMMAND_SYSTEMCTL=${shellQuote(seam.manager)}`,
        `cd ${shellQuote(target)}`,
        // Detach from the controlling terminal so /dev/tty is unreachable
        // — the cron/CI shape, deterministically, on any test machine.
        `exec ${shellQuote(execFileSync('which', ['python3']).toString().trim())} -c 'import os\nos.setsid()\nos.execvp("bash", ["bash", "./install.sh"])'`,
        '',
      ].join('\n'),
      { encoding: 'utf-8', mode: 0o755 },
    );
    const proc = spawnSync('bash', [launcher], {
      encoding: 'utf-8',
      timeout: 300_000,
      env: {
        ...process.env,
        HOME: home,
        GRU_COMMAND_HOME: instance,
      },
    });
    expect(proc.status, `${proc.stdout}\n${proc.stderr}`).toBe(0);
    // The no-terminal outcome is announced, never silent, and the prompt
    // itself is not shown (there is no terminal to show it on).
    expect(proc.stderr).toContain('no terminal for the register prompt');
    expect(proc.stdout).not.toContain('register one now');
    expect(proc.stdout).toContain('update complete; existing config preserved');
    expectRegisteredUnit(seam.managerLog, seam.unit, target, instance);
  }, 400_000);

  it('direct --service/--uninstall also enforce exact unit ownership', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const instance = join(home, '.gru-command');
    const managerLog = join(home, 'manager.log');
    const manager = join(home, 'service-manager');
    writeFileSync(manager, '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$GRU_MANAGER_LOG"\nexit 0\n', {
      encoding: 'utf-8',
      mode: 0o755,
    });
    const env = {
      HOME: home,
      GRU_COMMAND_HOME: instance,
      GRU_MANAGER_LOG: managerLog,
      GRU_COMMAND_LAUNCHCTL: manager,
      GRU_COMMAND_SYSTEMCTL: manager,
    };
    expect(run(join(fixture, 'install.sh'), ['--answers', '{"smoke":false}'], env).status).toBe(0);
    const unit = process.platform === 'darwin'
      ? join(home, 'Library', 'LaunchAgents', 'com.gru-command.service.plist')
      : join(home, '.config', 'systemd', 'user', 'gru-command.service');
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, 'foreign-user-unit\n');
    const refusedRegister = run(join(fixture, 'install.sh'), ['--service'], env);
    expect(refusedRegister.status).not.toBe(0);
    expect(readFileSync(unit, 'utf-8')).toBe('foreign-user-unit\n');
    const refusedUninstall = run(join(fixture, 'install.sh'), ['--uninstall'], env);
    expect(refusedUninstall.status).not.toBe(0);
    expect(readFileSync(unit, 'utf-8')).toBe('foreign-user-unit\n');

    const rendered = run(join(fixture, 'install.sh'), ['--print'], env);
    expect(rendered.status, rendered.stderr).toBe(0);
    const unmarked = process.platform === 'darwin'
      ? rendered.stdout.replace(
          '  <key>GruCommandManagedBy</key>\n  <string>gru-command-install-v2</string>\n',
          '',
        )
      : rendered.stdout.replace('X-GruCommandManagedBy=gru-command-install-v2\n', '');
    writeFileSync(unit, unmarked);
    expect(run(join(fixture, 'install.sh'), ['--uninstall'], env).status).not.toBe(0);
    expect(readFileSync(unit, 'utf-8')).toBe(unmarked);
    if (process.platform === 'darwin') {
      const wrongExecutable = rendered.stdout.replace(
        `<string>${process.execPath}</string>`,
        '<string>/usr/bin/false</string>',
      );
      expect(wrongExecutable).not.toBe(rendered.stdout);
      writeFileSync(unit, wrongExecutable);
      expect(run(join(fixture, 'install.sh'), ['--uninstall'], env).status).not.toBe(0);
      expect(readFileSync(unit, 'utf-8')).toBe(wrongExecutable);
    }
    const previousNode = rendered.stdout.replace(process.execPath, '/opt/previous-node/bin/node');
    expect(previousNode).not.toBe(rendered.stdout);
    writeFileSync(unit, previousNode);
    expect(run(join(fixture, 'install.sh'), ['--uninstall'], env).status).toBe(0);
    expect(existsSync(unit)).toBe(false);
    writeFileSync(unit, rendered.stdout);
    expect(run(join(fixture, 'install.sh'), ['--uninstall'], env).status).toBe(0);
    expect(existsSync(unit)).toBe(false);
    expect(run(join(fixture, 'install.sh'), ['--service'], env).status).toBe(0);
    expect(readFileSync(unit, 'utf-8')).toBe(rendered.stdout);
  });

  it('inside a clone: no flags clone the product — deps+build+wizard only', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const elsewhere = join(home, 'should-not-exist');
    const { stdout, status } = run(join(fixture, 'install.sh'), ['--answers', '{}'], {
      HOME: home,
      GRU_COMMAND_HOME: join(home, '.gru-command'),
      GRU_COMMAND_TARGET: elsewhere,
      GRU_COMMAND_ORIGIN: `file://${fixture}`,
    });
    expect(status, stdout).toBe(0);
    // No re-clone happened: the target dir was never created.
    expect(existsSync(elsewhere)).toBe(false);
    expect(existsSync(join(home, '.gru-command', 'config.toml'))).toBe(true);
  });

  it('--no-interact alone completes with documented defaults and never opens the TTY', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const result = run(join(fixture, 'install.sh'), ['--no-interact'], {
      HOME: home,
      GRU_COMMAND_HOME: join(home, '.gru-command'),
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('WIZARD-RAN --no-interact');
  });

  it('--answers=<json> equals-form parses identically (wizard marker written)', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const { stdout, status } = run(join(fixture, 'install.sh'), ['--answers={}'], {
      HOME: home,
      GRU_COMMAND_HOME: join(home, '.gru-command'),
    });
    expect(status, stdout).toBe(0);
    expect(stdout).toContain('WIZARD-RAN');
    expect(existsSync(join(home, '.gru-command', 'config.toml'))).toBe(true);
  });

  it('--answers combined with --print exits 2 with a named mode-conflict error', () => {
    for (const args of [['--answers', '{}', '--print'], ['--print', '--answers', '{}']]) {
      const { status, stderr } = run(join(repoRoot, 'install.sh'), args, {});
      expect(status, String(args)).toBe(2);
      expect(stderr).toContain('--answers is only valid with setup mode');
      expect(stderr).toContain('--print');
    }
  });

  it('rejects update without a config and refuses a pre-positioned checkout from another origin', () => {
    const noConfigHome = tempDir('gru-command-update-no-config-home-');
    const noConfigBare = tempDir('gru-command-update-no-config-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(noConfigBare, 'install.sh'));
    const noConfigTarget = join(noConfigHome, 'gru-command');
    const noConfig = run(join(noConfigBare, 'install.sh'), ['--update'], {
      HOME: noConfigHome,
      GRU_COMMAND_HOME: join(noConfigHome, '.gru-command'),
      GRU_COMMAND_TARGET: noConfigTarget,
    });
    expect(noConfig.status).toBe(1);
    expect(noConfig.stderr).toContain('--update requires an existing configured instance');
    expect(existsSync(noConfigTarget)).toBe(false);

    const first = buildFixtureRepo();
    const second = buildFixtureRepo();
    gitInitCommit(first.fixture);
    gitInitCommit(second.fixture);
    const target = join(first.home, 'gru-command');
    execFileSync('git', ['clone', `file://${first.fixture}`, target], { stdio: 'pipe' });
    const instance = join(first.home, '.gru-command');
    mkdirSync(instance, { recursive: true });
    writeFileSync(join(instance, 'config.toml'), 'preserved\n');
    const bare = tempDir('gru-command-origin-guard-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const wrongOrigin = run(join(bare, 'install.sh'), [], {
      HOME: first.home,
      GRU_COMMAND_HOME: instance,
      GRU_COMMAND_TARGET: target,
      GRU_COMMAND_ORIGIN: `file://${second.fixture}`,
    });
    expect(wrongOrigin.status).toBe(1);
    expect(wrongOrigin.stderr).toContain('unexpected origin');
    expect(readFileSync(join(instance, 'config.toml'), 'utf-8')).toBe('preserved\n');
  });

  it('clone failure (bad GRU_COMMAND_ORIGIN) exits non-zero with a named error', () => {
    const home = tempDir('gru-command-clonefail-home-');
    const bare = tempDir('gru-command-clonefail-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const { stdout, status } = run(
      join(bare, 'install.sh'),
      ['--answers', '{}'],
      {
        HOME: home,
        GRU_COMMAND_HOME: join(home, '.gru-command'),
        GRU_COMMAND_ORIGIN: `file://${join(home, 'no-such-origin-repo')}`,
        GRU_COMMAND_TARGET: join(home, 'gru-command'),
      },
    );
    expect(status, stdout).not.toBe(0);
    expect(stdout).toMatch(/cloning/);
    // git names the failure (fatal: repository … does not exist) — loud,
    // never a silent no-op.
    expect(lastStderr).toMatch(/fatal|repository|clone/i);
    expect(existsSync(join(home, 'gru-command'))).toBe(false);
  });

  it('re-exec guard: GRU_COMMAND_REEXEC=1 outside a checkout exits 1, named', () => {
    const home = tempDir('gru-command-reexec-home-');
    const bare = tempDir('gru-command-reexec-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const { stderr, status } = run(join(bare, 'install.sh'), ['--answers', '{}'], {
      HOME: home,
      GRU_COMMAND_HOME: join(home, '.gru-command'),
      GRU_COMMAND_REEXEC: '1',
    });
    expect(status).toBe(1);
    expect(stderr).toContain('re-exec landed outside a product checkout');
    expect(existsSync(join(home, '.gru-command', 'config.toml'))).toBe(false);
  });
});

describe('install.sh E7 flag contracts (re-pinned)', () => {
  it('unknown flags exit 2 with usage', () => {
    const { status, stderr } = run(join(repoRoot, 'install.sh'), ['--bogus'], {});
    expect(status).toBe(2);
    expect(stderr).toContain('unknown flag');
  });

  it('--print renders the platform unit absolutely; changes nothing', () => {
    const { stdout, status } = run(join(repoRoot, 'install.sh'), ['--print'], {});
    expect(status).toBe(0);
    expect(stdout).not.toContain('{{NODE}}');
    expect(stdout).not.toContain('{{REPO_ROOT}}');
    expect(stdout).not.toContain('{{GRU_COMMAND_HOME}}');
    expect(stdout).not.toContain('{{PATH}}');
  });

  it('--uninstall on a clean machine reports not-installed, exit 0', () => {
    const home = tempDir('gru-command-uninstall-');
    const { stdout, status } = run(join(repoRoot, 'install.sh'), ['--uninstall'], { HOME: home });
    expect(status, stdout).toBe(0);
    expect(stdout).toMatch(/not installed/);
  });

  it('--service refuses loudly when dist/main.js is missing', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const { stderr, status } = run(join(fixture, 'install.sh'), ['--service'], { HOME: home });
    expect(status).toBe(1);
    expect(stderr).toContain('dist/main.js not found');
  });

  it('--answers= (empty) exits 2 — never a silent flip to interactive (Perkins r2 note)', () => {
    const { status, stderr } = run(join(repoRoot, 'install.sh'), ['--answers='], {});
    expect(status).toBe(2);
    expect(stderr).toContain("--answers was given an empty value");
    expect(stderr).toContain("--answers '{}'");
  });
});

describe('node version gate (>= 22.19) — Perkins r1 W11', () => {
  /** A PATH shim that claims v18 and fails every -e probe: node_ok must
   * trip in BOTH --service and setup modes, before any registration or
   * install runs. */
  function oldNodeShim(): string {
    const dir = tempDir('gru-command-oldnode-bin-');
    writeFileSync(
      join(dir, 'node'),
      '#!/usr/bin/env bash\nif [[ "${1:-}" == "--version" ]]; then echo "v18.20.0"; fi\nexit 1\n',
      { encoding: 'utf-8', mode: 0o755 },
    );
    return dir;
  }

  it('--service mode gates before unit registration', () => {
    const shim = oldNodeShim();
    const { stderr, status } = run(join(repoRoot, 'install.sh'), ['--service'], {
      PATH: `${shim}:${process.env.PATH ?? ''}`,
    });
    expect(status).toBe(1);
    expect(stderr).toContain('node >= 22.19 required');
    expect(stderr).toContain('v18.20.0');
  });

  it('setup mode (inside a checkout) gates before deps/build', () => {
    const shim = oldNodeShim();
    const { stderr, status } = run(join(repoRoot, 'install.sh'), [], {
      PATH: `${shim}:${process.env.PATH ?? ''}`,
      // A answers-free run would exec the wizard after the gate — the
      // gate must stop it long before that.
      GRU_COMMAND_HOME: join(shim, '..', 'never-created'),
    });
    expect(status).toBe(1);
    expect(stderr).toContain('node >= 22.19 required');
    expect(existsSync(join(shim, '..', 'never-created'))).toBe(false);
  });
});
