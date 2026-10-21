import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { markFixtureStep, OwnedCommandTimeoutError, runOwnedCommand } from './helpers/harness-diagnostics.mjs';

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

// Cost repair (a6 FULL-red follow-through): each simulated installation fans
// out into node/npm/child chains, and the heaviest leg (three full installer
// runs) can cross the unchanged 30s body deadline on a loaded vitest worker.
// Quiet npm startup removes the update-notifier child and progress work from
// every spawned installation; no installer behavior or assertion changes.

let lastStderr = '';

/** Flags only — never echo answer values or fixture paths into diagnostics. */
function commandLabel(args: readonly string[]): string {
  return args
    .map((arg) => (arg.startsWith('--') ? (arg.split('=')[0] ?? arg) : '<arg>'))
    .slice(0, 6)
    .join(' ');
}

/**
 * Below the 120s heavy ceiling every run() caller uses, so a stalled
 * installer surfaces as its own deadline error (owned child reaped, partial
 * output in the diagnostics) instead of a bare test-level timeout.
 */
const INSTALL_DEADLINE_MS = 100_000;

async function run(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; status: number }> {
  const label = `install.sh ${commandLabel(args)}`;
  try {
    const result = await runOwnedCommand('bash', [script, ...args], {
      label,
      deadlineMs: INSTALL_DEADLINE_MS,
      // Each simulated installation owns its config home even when the test
      // runner supplies an XDG_CONFIG_HOME outside the fixture's HOME.
      env: {
        ...process.env,
        ...env,
        ...(env.HOME ? { XDG_CONFIG_HOME: join(env.HOME, '.config') } : {}),
        // Likewise the `gru` launcher: never into a runner-set bin dir.
        ...(env.HOME ? { GRU_COMMAND_BIN_DIR: join(env.HOME, '.local', 'bin') } : {}),
        npm_config_update_notifier: 'false',
        npm_config_progress: 'false',
      },
    });
    const status = result.status ?? 1;
    lastStderr = status === 0 ? '' : result.stderr;
    markFixtureStep(`install.sh ${commandLabel(args)} → exit ${status}`);
    return { stdout: result.stdout, stderr: status === 0 ? '' : result.stderr, status };
  } catch (error) {
    // A deadline overrun fails loud: mapping it to exit 1 would let a
    // stalled installer pass as an expected refusal. The helper already
    // SIGTERMed/SIGKILLed the owned child.
    if (error instanceof OwnedCommandTimeoutError) {
      lastStderr = error.stderr;
      markFixtureStep(`${label} → timeout`);
    }
    throw error;
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
      // The self-roll CLI stub the installer delegates to when it detects an
      // in-service (agent-owned) update: records its argv on stdout.
      'writeFileSync("dist/cli/service.js", "#!/usr/bin/env node\\nconsole.log(\'FIXTURE-ROLL-RAN \' + process.argv.slice(2).join(\' \'));\\n");',
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

const ptyPlatform = process.platform === 'darwin' || process.platform === 'linux';
const ptySkipOptOut = process.env['GRU_TEST_SKIP_PTY'] === '1';
const ptyCapable = expectAvailable() && ptyPlatform && !ptySkipOptOut;

/** The unit path install.sh writes under a sandbox HOME. run() and every
 * launcher pin XDG_CONFIG_HOME to HOME/.config, so a runner-set
 * XDG_CONFIG_HOME can never redirect the real unit write (#36). */
function sandboxUnitPath(home: string): string {
  return process.platform === 'darwin'
    ? join(home, 'Library', 'LaunchAgents', 'com.gru-command.service.plist')
    : join(home, '.config', 'systemd', 'user', 'gru-command.service');
}

interface ManagerSeam {
  manager: string;
  managerLog: string;
  unit: string;
  env: NodeJS.ProcessEnv;
}

/** One fake launchctl/systemctl that logs its argv; `body` adds behaviour.
 * Real unit files still land under the sandbox HOME — assertions check
 * those REAL effects, never echo text alone. */
function fakeManagerSeam(home: string, name: string, body: readonly string[]): ManagerSeam {
  const managerLog = join(home, `${name}.log`);
  const manager = join(home, name);
  writeFileSync(
    manager,
    ['#!/usr/bin/env bash', 'printf "%s\\n" "$*" >> "$GRU_MANAGER_LOG"', ...body, 'exit 0', ''].join('\n'),
    { encoding: 'utf-8', mode: 0o755 },
  );
  return {
    manager,
    managerLog,
    unit: sandboxUnitPath(home),
    env: {
      GRU_MANAGER_LOG: managerLog,
      GRU_COMMAND_LAUNCHCTL: manager,
      GRU_COMMAND_SYSTEMCTL: manager,
    },
  };
}

function serviceManagerSeam(home: string): ManagerSeam {
  return fakeManagerSeam(home, 'service-manager', []);
}

/** Fake service manager that reports THE CALLER'S PROCESS GROUP as the
 * running service main pid — i.e. the installer really is a descendant of
 * the managed service (the agent-owned shape). On macOS `launchctl list`
 * carries `<pid>\t<status>\t<label>`; on Linux `systemctl show -p MainPID`
 * answers the pid. Everything else is logged like the plain seam. */
function inServiceManagerSeam(home: string): ManagerSeam {
  return fakeManagerSeam(home, 'in-service-manager', [
    'pgid="$(ps -o pgid= -p "$PPID" | tr -d " ")"',
    'case "$*" in',
    '  *"show -p MainPID"*) printf "%s" "$pgid" ;;',
    '  list*) printf "%s\\t0\\tcom.gru-command.service\\n" "$pgid" ;;',
    'esac',
  ]);
}

/** True when the manager log holds no unit-registration/restart calls —
 * the in-service `list`/`show` probe is allowed, a registration is not. */
function noRegistrationCalls(managerLog: string): boolean {
  if (!existsSync(managerLog)) return true;
  const calls = readFileSync(managerLog, 'utf-8');
  return (
    !/^(unload|load)\b/m.test(calls) &&
    !calls.includes('daemon-reload') &&
    !calls.includes('enable gru-command') &&
    !calls.includes('restart gru-command')
  );
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

interface LauncherOptions {
  readonly home: string;
  readonly instance: string;
  readonly cwd: string;
  /** Final shell command, e.g. `exec bash ./install.sh`. */
  readonly command: string;
  readonly seam?: ManagerSeam;
  readonly extraExports?: Readonly<Record<string, string>>;
  readonly name?: string;
}

/** The ONE launcher template (#36 dedupe): sandboxed HOME/XDG/instance and
 * optional service-manager seam, then a caller-chosen final command. */
function writeLauncher(options: LauncherOptions): string {
  const launcher = join(options.home, options.name ?? 'launcher.sh');
  const exports: Record<string, string> = {
    HOME: options.home,
    XDG_CONFIG_HOME: join(options.home, '.config'),
    GRU_COMMAND_BIN_DIR: join(options.home, '.local', 'bin'),
    GRU_COMMAND_HOME: options.instance,
    ...(options.seam === undefined
      ? {}
      : {
          GRU_MANAGER_LOG: options.seam.managerLog,
          GRU_COMMAND_LAUNCHCTL: options.seam.manager,
          GRU_COMMAND_SYSTEMCTL: options.seam.manager,
        }),
    ...options.extraExports,
  };
  writeFileSync(
    launcher,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      ...Object.entries(exports).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
      `cd ${shellQuote(options.cwd)}`,
      options.command,
      '',
    ].join('\n'),
    { encoding: 'utf-8', mode: 0o755 },
  );
  return launcher;
}

function ptyUpdaterLauncher(home: string, target: string, instance: string, seam: ManagerSeam): string {
  return writeLauncher({ home, instance, seam, cwd: target, command: 'exec bash ./install.sh' });
}

/** Drive a launcher on a REAL pty: optionally answer the register prompt
 * with `send` (Tcl-escaped text, e.g. "n\\r" or "\\004" for Ctrl-D). */
function ptyRun(launcher: string, send: string | null, promptText = 'register one now'): string {
  const expectScript = [
    'set timeout 300',
    `spawn bash ${launcher}`,
    ...(send === null ? [] : [`expect "${promptText}"`, `send -- "${send}"`]),
    'expect eof',
    'set result [wait]',
    'exit [lindex $result 3]',
  ].join('\n');
  return execFileSync('expect', ['-c', expectScript], {
    encoding: 'utf-8',
    timeout: 360_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).replace(/\r/g, '');
}

/** Run a command in its OWN session (setsid via detached) so /dev/tty is
 * unreachable — the cron/CI shape, deterministically, on any machine and
 * without python3. */
function runDetached(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; status: number | null }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], { detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
    const timer = setTimeout(() => {
      try { process.kill(-(child.pid ?? 0), 'SIGKILL'); } catch { /* already gone */ }
      rejectRun(new Error(`detached run timed out\n${stdout}\n${stderr}`));
    }, 300_000);
    child.on('error', (error) => { clearTimeout(timer); rejectRun(error); });
    child.on('close', (status) => { clearTimeout(timer); resolveRun({ stdout, stderr, status }); });
  });
}

describe('install.sh setup mode (one-line path)', () => {
  it('piped install: clones when absent → deps → build → wizard (marker written)', async () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    // The one-liner case: a bare directory holding ONLY install.sh
    // (what curl|bash actually runs) — no checkout around it.
    const bare = tempDir('gru-command-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const target = join(home, 'gru-command');
    const verifyLog = join(home, 'perkins-verify.log');

    const { stdout, status } = await run(
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

  it('fails closed before setup when the built Perkins MCP bridge is missing', async () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const bare = tempDir('gru-command-missing-mcp-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const instance = join(home, '.gru-command');
    const result = await run(join(bare, 'install.sh'), ['--no-interact'], {
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

  it('a newly recreated clone preserves a retained instance config instead of rerunning setup', async () => {
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
    const result = await run(join(bare, 'install.sh'), ['--no-interact'], {
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

  it.skipIf(!ptyCapable)('literal cat|bash install keeps prompts on /dev/tty and completes in one invocation', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const bare = tempDir('gru-command-pipe-pty-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const instance = join(home, '.gru-command');
    const launcher = writeLauncher({
      home,
      instance,
      cwd: bare,
      command: 'cat install.sh | bash',
      extraExports: {
        GRU_COMMAND_ORIGIN: `file://${fixture}`,
        GRU_COMMAND_TARGET: join(home, 'gru-command'),
      },
    });
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

  it('second run fast-forwards the existing clean checkout, preserves config, and does not re-run wizard', async () => {
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
    expect((await run(join(bare, 'install.sh'), ['--answers', '{"token":"preserved"}'], env)).status).toBe(0);
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
    const second = await run(join(bare, 'install.sh'), ['--no-interact'], { ...env, ...seam.env });
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

  it('fast-forwards an old target before executing target-local installer logic', async () => {
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
    const result = await run(join(bare, 'install.sh'), ['--no-interact'], {
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

  it('refuses a dirty existing checkout before pull/build and preserves its config', async () => {
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
    expect((await run(join(bare, 'install.sh'), ['--answers', '{"token":"keep-me"}'], env)).status).toBe(0);
    const before = readFileSync(join(instance, 'config.toml'), 'utf-8');
    writeFileSync(join(target, 'local-untracked.txt'), 'do not delete', 'utf-8');
    const updated = await run(join(bare, 'install.sh'), [], env);
    expect(updated.status).toBe(1);
    expect(updated.stderr).toContain('refusing to update a dirty checkout');
    expect(readFileSync(join(target, 'local-untracked.txt'), 'utf-8')).toBe('do not delete');
    expect(readFileSync(join(instance, 'config.toml'), 'utf-8')).toBe(before);
  });

  it('refuses a non-fast-forward divergent checkout without reset', async () => {
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
    expect((await run(join(bare, 'install.sh'), ['--answers', '{}'], env)).status).toBe(0);
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
    const updated = await run(join(bare, 'install.sh'), [], env);
    expect(updated.status).toBe(1);
    expect(updated.stderr).toContain('fast-forward-only update failed');
    expect(existsSync(join(target, 'local-commit.txt'))).toBe(true);
  });

  it('refuses a foreign unit with the same public name', async () => {
    // Split from the former composite: the foreign refusal runs under its own unchanged body ceiling.
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const bare = tempDir('gru-command-service-update-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const target = join(home, 'gru-command');
    const instance = join(home, '.gru-command');
    const { manager, managerLog } = serviceManagerSeam(home);
    const unit = sandboxUnitPath(home);
    const env = {
      HOME: home,
      GRU_COMMAND_HOME: instance,
      GRU_COMMAND_ORIGIN: `file://${fixture}`,
      GRU_COMMAND_TARGET: target,
      GRU_MANAGER_LOG: managerLog,
      GRU_COMMAND_LAUNCHCTL: manager,
      GRU_COMMAND_SYSTEMCTL: manager,
    };
    // The instance is provisioned directly (the retained-config pattern the
    // neighbouring update test uses). The contract under test is service
    // ownership on the update path, and the first bare run below still
    // exercises clone-when-absent + build before the restart decision; the
    // setup+wizard leg this replaces spent a full extra installer cycle on
    // coverage this file carries in its own dedicated cases.
    mkdirSync(instance, { recursive: true });
    writeFileSync(join(instance, 'config.toml'), 'retained-user-config\n');

    const managerCallsBefore = existsSync(managerLog) ? readFileSync(managerLog, 'utf-8') : '';
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, '/someone/else/dist/main.js\n/someone/else/.gru-command\n');
    // The foreign-unit refusal is a public-entry contract: exercise the
    // one-line wrapper's existing-checkout update path, not only the
    // checkout-local installer. The owned-service leg below stays local.
    const foreign = await run(join(bare, 'install.sh'), [], env);
    expect(foreign.status).toBe(1);
    expect(foreign.stderr).toContain('refusing to restart unrelated service unit');
    expect(readFileSync(unit, 'utf-8')).toContain('/someone/else');
    // The refusal must not reach the service manager: the call log is
    // unchanged, so the foreign unit is never restarted.
    expect(existsSync(managerLog) ? readFileSync(managerLog, 'utf-8') : '').toBe(managerCallsBefore);
  });

  it('restarts only an owned service unit', async () => {
    // Split from the former composite: the owned restart runs under its own unchanged body ceiling.
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const bare = tempDir('gru-command-service-update-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const target = join(home, 'gru-command');
    const instance = join(home, '.gru-command');
    const { manager, managerLog } = serviceManagerSeam(home);
    const unit = sandboxUnitPath(home);
    const env = {
      HOME: home,
      GRU_COMMAND_HOME: instance,
      GRU_COMMAND_ORIGIN: `file://${fixture}`,
      GRU_COMMAND_TARGET: target,
      GRU_MANAGER_LOG: managerLog,
      GRU_COMMAND_LAUNCHCTL: manager,
      GRU_COMMAND_SYSTEMCTL: manager,
    };
    expect((await run(join(bare, 'install.sh'), ['--answers', '{}'], env)).status).toBe(0);

    const renderedOwned = await run(join(target, 'install.sh'), ['--print'], env);
    expect(renderedOwned.status, renderedOwned.stderr).toBe(0);
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, renderedOwned.stdout);
    const owned = await run(join(target, 'install.sh'), [], env);
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

  it('owned unit SUCCESS through the public one-line wrapper: ff-only update, rebuild, exact manager calls (#20)', async () => {
    // The wrapper (bare/install.sh) is what `curl | bash` runs. It must pull
    // the existing checkout fast-forward-only, re-exec the checkout's
    // installer, rebuild, and restart the OWNED unit through the manager —
    // never the wizard, never a re-clone.
    const { fixture, home, target, instance, seam } = stageConfiguredAbsentUnit();
    const bare = tempDir('gru-command-wrapper-owned-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    // Upstream advances so the update has something to fast-forward to.
    writeFileSync(join(fixture, 'upstream-change.txt'), 'new upstream commit\n');
    execFileSync('git', ['-C', fixture, 'add', '-A']);
    execFileSync('git', [
      '-C', fixture, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture',
      'commit', '-qm', 'upstream advance',
    ]);
    const env = {
      HOME: home,
      GRU_COMMAND_HOME: instance,
      GRU_COMMAND_ORIGIN: `file://${fixture}`,
      GRU_COMMAND_TARGET: target,
      ...seam.env,
    };
    const rendered = await run(join(target, 'install.sh'), ['--print'], env);
    expect(rendered.status, rendered.stderr).toBe(0);
    mkdirSync(dirname(seam.unit), { recursive: true });
    writeFileSync(seam.unit, rendered.stdout);
    expect(existsSync(seam.managerLog)).toBe(false);

    const result = await run(join(bare, 'install.sh'), [], env);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('reusing existing checkout');
    expect(result.stdout).toContain('updating source with git pull --ff-only');
    expect(result.stdout).toContain('restarting owned Gru Command service');
    expect(result.stdout).toContain('update complete; existing config preserved');
    expect(result.stdout).not.toContain('WIZARD-RAN');
    expect(result.stdout).not.toContain('cloning');
    // Fast-forward landed, deps/build ran in the checkout.
    expect(readFileSync(join(target, 'upstream-change.txt'), 'utf-8')).toBe('new upstream commit\n');
    expect(existsSync(join(target, 'dist', 'main.js'))).toBe(true);
    // Config untouched; unit still names this checkout.
    expect(readFileSync(join(instance, 'config.toml'), 'utf-8')).toBe('preserved\n');
    expect(readFileSync(seam.unit, 'utf-8')).toContain(`${target}/dist/main.js`);
    // Deterministic manager-call assertions: the owned restart sequence,
    // in order, exactly once, with no stop/disable/uninstall side calls.
    const calls = readFileSync(seam.managerLog, 'utf-8').trim().split('\n');
    const lifecycle = calls.filter((call) => !/^(list|--user show -p MainPID)/.test(call));
    if (process.platform === 'darwin') {
      expect(lifecycle).toEqual([`unload ${seam.unit}`, `load ${seam.unit}`]);
    } else {
      expect(lifecycle).toEqual([
        '--user daemon-reload',
        '--user enable gru-command.service',
        '--user restart gru-command.service',
      ]);
    }
  }, 120_000);

  it.skipIf(process.platform !== 'linux')('systemd unit retains stable Node/npm PATH after a version-manager session expires', async () => {
    const { fixture, home } = buildFixtureRepo();
    // Direct --service requires an already-built service entrypoint.
    mkdirSync(join(fixture, 'dist'), { recursive: true });
    writeFileSync(join(fixture, 'dist', 'main.js'), '// fixture service\n');
    const sessionBin = join(home, 'ephemeral version manager', 'bin');
    mkdirSync(sessionBin, { recursive: true });
    symlinkSync(process.execPath, join(sessionBin, 'node'));
    const stableBin = dirname(realpathSync(process.execPath));
    expect(existsSync(join(stableBin, 'npm'))).toBe(true);
    const seam = serviceManagerSeam(home);
    const result = await run(join(fixture, 'install.sh'), ['--service'], {
      HOME: home,
      GRU_COMMAND_HOME: join(home, '.gru-command'),
      PATH: `${sessionBin}:/usr/local/bin:/usr/bin:/bin`,
      ...seam.env,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const unit = readFileSync(seam.unit, 'utf-8');
    const servicePath = unit.match(/^Environment="PATH=([^"]+)"$/m)?.[1];
    expect(servicePath).toBeDefined();
    expect(servicePath!.split(':')[0]).toBe(stableBin);
    rmSync(sessionBin, { recursive: true, force: true });
    const npm = spawnSync('sh', ['-c', 'command -v npm && npm --version'], {
      env: { PATH: servicePath! }, encoding: 'utf-8',
    });
    expect(npm.status, `${npm.stdout}\n${npm.stderr}`).toBe(0);
    expect(realpathSync(npm.stdout.split('\n')[0]!)).toBe(realpathSync(join(stableBin, 'npm')));
  });

  it.skipIf(process.platform !== 'linux')('systemd PATH escapes quotes, backslashes and percent specifiers without losing the stable bin', async () => {
    const home = tempDir('gru-command-path-escape-');
    const odd = join(home, 'quoted"back\\slash%bin');
    const supplied = `${process.env.PATH ?? '/usr/bin:/bin'}:${odd}`;
    const result = await run(join(repoRoot, 'install.sh'), ['--print'], { HOME: home, PATH: supplied });
    expect(result.status, result.stderr).toBe(0);
    const encoded = supplied.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
    expect(result.stdout).toContain(`Environment="PATH=${dirname(realpathSync(process.execPath))}:${encoded}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"`);
    expect(result.stdout).not.toContain('{{PATH}}');
  });

  it.skipIf(process.platform !== 'linux')('newline PATH fails before writing a unit or calling the service manager', async () => {
    const { fixture, home } = buildFixtureRepo();
    mkdirSync(join(fixture, 'dist'), { recursive: true });
    writeFileSync(join(fixture, 'dist', 'main.js'), '// fixture service\n');
    const seam = serviceManagerSeam(home);
    const env = { HOME: home, GRU_COMMAND_HOME: join(home, '.gru-command'), ...seam.env };
    const rendered = await run(join(fixture, 'install.sh'), ['--print'], env);
    expect(rendered.status, rendered.stderr).toBe(0);
    mkdirSync(dirname(seam.unit), { recursive: true });
    writeFileSync(seam.unit, rendered.stdout);
    const result = await run(join(fixture, 'install.sh'), ['--service'], {
      ...env,
      PATH: `${process.env.PATH ?? '/usr/bin:/bin'}\nmalformed`,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('PATH contains a newline');
    expect(readFileSync(seam.unit, 'utf-8')).toBe(rendered.stdout);
    expect(existsSync(`${seam.unit}.r`)).toBe(false);
    expect(existsSync(seam.managerLog)).toBe(false);
  });

  it.skipIf(process.platform !== 'linux')('fixture HOME contains service units even with a foreign XDG config home', async () => {
    const home = tempDir('gru-command-sandbox-home-');
    const outside = tempDir('gru-command-foreign-xdg-');
    const outsideUnit = join(outside, 'systemd', 'user', 'gru-command.service');
    mkdirSync(dirname(outsideUnit), { recursive: true });
    writeFileSync(outsideUnit, 'unrelated-user-unit\n');
    const result = await run(join(repoRoot, 'install.sh'), ['--uninstall'], {
      HOME: home,
      XDG_CONFIG_HOME: outside,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('not installed');
    expect(readFileSync(outsideUnit, 'utf-8')).toBe('unrelated-user-unit\n');
  });

  it('--no-interact + absent unit: the updater REGISTERS the service (unit written + manager called)', async () => {
    const { home, target, instance, seam } = stageConfiguredAbsentUnit();
    const result = await run(join(target, 'install.sh'), ['--no-interact'], {
      HOME: home,
      GRU_COMMAND_HOME: instance,
      ...seam.env,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('update complete; existing config preserved');
    expect(result.stdout).not.toContain('WIZARD-RAN');
    expectRegisteredUnit(seam.managerLog, seam.unit, target, instance);
  });

  it.skipIf(!ptyCapable)('interactive + absent unit + default answer: prompts, then REGISTERS the service', () => {
    const { home, target, instance, seam } = stageConfiguredAbsentUnit();
    const output = ptyRun(ptyUpdaterLauncher(home, target, instance, seam), '\\r');
    expect(output).toContain('register one now');
    expect(output).toContain('installed:');
    expect(output).toContain('update complete; existing config preserved');
    expectRegisteredUnit(seam.managerLog, seam.unit, target, instance);
  }, 400_000);

  it.skipIf(!ptyCapable)('interactive + absent unit + decline: NO install, recovery hint, exit success', () => {
    const { home, target, instance, seam } = stageConfiguredAbsentUnit();
    const output = ptyRun(ptyUpdaterLauncher(home, target, instance, seam), 'n\\r');
    expect(output).toContain('register one now');
    expect(output).toContain('update complete; existing config preserved');
    expect(output).toContain('no service installed or running — ./install.sh --service registers it later');
    expect(output).not.toContain(`installed: ${seam.unit}`);
    expect(existsSync(seam.unit)).toBe(false);
    // The in-service probe may consult the manager (`list`), but a decline
    // must never register or touch the unit.
    expect(noRegistrationCalls(seam.managerLog)).toBe(true);
  }, 400_000);

  it.skipIf(!ptyCapable)('interactive + absent unit + UNRECOGNIZED answer: err-and-decline, nothing registered (#36)', () => {
    const { home, target, instance, seam } = stageConfiguredAbsentUnit();
    const output = ptyRun(ptyUpdaterLauncher(home, target, instance, seam), 'maybe\\r');
    expect(output).toContain("unrecognized answer 'maybe' — not registering");
    expect(output).toContain('update complete; existing config preserved');
    expect(output).toContain('no service installed or running — ./install.sh --service registers it later');
    expect(existsSync(seam.unit)).toBe(false);
    expect(noRegistrationCalls(seam.managerLog)).toBe(true);
  }, 400_000);

  it.skipIf(!ptyCapable)('interactive + absent unit + mixed-case answers: yEs registers, nO declines (#36)', () => {
    const registered = stageConfiguredAbsentUnit();
    const yes = ptyRun(ptyUpdaterLauncher(registered.home, registered.target, registered.instance, registered.seam), 'yEs\\r');
    expect(yes).not.toContain('unrecognized answer');
    expectRegisteredUnit(registered.seam.managerLog, registered.seam.unit, registered.target, registered.instance);

    const declined = stageConfiguredAbsentUnit();
    const no = ptyRun(ptyUpdaterLauncher(declined.home, declined.target, declined.instance, declined.seam), 'nO\\r');
    expect(no).not.toContain('unrecognized answer');
    expect(no).toContain('--service registers it later');
    expect(existsSync(declined.seam.unit)).toBe(false);
    expect(noRegistrationCalls(declined.seam.managerLog)).toBe(true);
  }, 800_000);

  it.skipIf(!ptyCapable)('interactive + absent unit + EOF (Ctrl-D) at the prompt: declines instead of auto-registering (#36)', () => {
    const { home, target, instance, seam } = stageConfiguredAbsentUnit();
    const output = ptyRun(ptyUpdaterLauncher(home, target, instance, seam), '\\004');
    expect(output).toContain('no answer (end of input) — not registering');
    expect(output).toContain('update complete; existing config preserved');
    expect(output).toContain('--service registers it later');
    expect(existsSync(seam.unit)).toBe(false);
    expect(noRegistrationCalls(seam.managerLog)).toBe(true);
  }, 400_000);

  it.skipIf(!ptyCapable)('piped cat|bash updater + absent unit: prompt reads the TTY, not the script pipe (decline)', () => {
    const { home, target, instance, seam } = stageConfiguredAbsentUnit();
    const launcher = writeLauncher({ home, instance, seam, cwd: target, command: 'cat ./install.sh | bash' });
    const output = ptyRun(launcher, 'n\\r');
    // The prompt reached the controlling terminal and the answer was read
    // from it — the piped SCRIPT was never consumed as the reply.
    expect(output).toContain('register one now');
    expect(output).toContain('update complete; existing config preserved');
    expect(output).toContain('no service installed or running — ./install.sh --service registers it later');
    expect(output).not.toContain(`installed: ${seam.unit}`);
    expect(existsSync(seam.unit)).toBe(false);
    expect(noRegistrationCalls(seam.managerLog)).toBe(true);
  }, 400_000);

  it.skipIf(!ptyCapable)('decline from a DIFFERENT directory prints the absolute --service hint (launch cwd, not checkout cwd) (#36)', () => {
    const { home, target, instance, seam } = stageConfiguredAbsentUnit();
    const elsewhere = tempDir('gru-command-hint-cwd-');
    const launcher = writeLauncher({ home, instance, seam, cwd: elsewhere, command: `exec bash ${shellQuote(join(target, 'install.sh'))}` });
    const output = ptyRun(launcher, 'n\\r');
    // A relative ./install.sh would not exist in the operator's directory.
    expect(output).toMatch(/no service installed or running — \/\S+\/gru-command\/install\.sh --service registers it later/);
    expect(output).not.toContain('— ./install.sh --service');
    expect(existsSync(seam.unit)).toBe(false);
  }, 400_000);

  it.skipIf(!ptyCapable)('run the way gru runs it (from the checkout, the caller\'s directory handed over), the declined hint is still absolute (#463)', () => {
    const { home, target, instance, seam } = stageConfiguredAbsentUnit();
    const elsewhere = tempDir('gru-command-hint-launch-pwd-');
    const launcher = writeLauncher({
      home, instance, seam, cwd: target, command: 'exec bash ./install.sh',
      extraExports: { GRU_COMMAND_LAUNCH_PWD: elsewhere },
    });
    const output = ptyRun(launcher, 'n\\r');
    expect(output).toMatch(/no service installed or running — \/\S+\/gru-command\/install\.sh --service registers it later/);
    expect(output).not.toContain('— ./install.sh --service');
  }, 400_000);

  it.skipIf(!ptyCapable)('prompt_register_service leaves a caller-held fd 3 intact (#36)', () => {
    const home = tempDir('gru-command-fd3-');
    const keep = join(home, 'fd3-keep.txt');
    writeFileSync(keep, 'fd3-still-open\n');
    const installScript = join(repoRoot, 'install.sh');
    const body = join(home, 'fd3-body.sh');
    writeFileSync(
      body,
      [
        'set +e',
        `eval "$(sed -n '/^err()/p' ${shellQuote(installScript)}; sed -n '/^classify_register_reply()/,/^}/p' ${shellQuote(installScript)}; sed -n '/^prompt_register_service()/,/^}/p' ${shellQuote(installScript)})"`,
        'inside_managed_service_pgroup() { return 1; }',
        `exec 3< ${shellQuote(keep)}`,
        'prompt_register_service',
        'echo "PROMPT-RC=$?"',
        'IFS= read -r line <&3 && echo "FD3:$line" || echo "FD3:CLOBBERED"',
        '',
      ].join('\n'),
      'utf-8',
    );
    // stdin is /dev/null (not a tty) so the /dev/tty branch runs; the pty
    // still provides the controlling terminal to answer on.
    const launcher = writeLauncher({ home, instance: join(home, 'i'), cwd: home, command: `bash ${shellQuote(body)} < /dev/null` });
    const output = ptyRun(launcher, 'n\\r');
    expect(output).toContain('PROMPT-RC=1');
    expect(output).toContain('FD3:fd3-still-open');
    expect(output).not.toContain('CLOBBERED');
  });

  it('classify_register_reply: empty/y/yes any case register; n/no any case decline; the rest unrecognized (#36)', () => {
    const installScript = join(repoRoot, 'install.sh');
    const table: ReadonlyArray<readonly [string, string]> = [
      ['', 'register'], ['y', 'register'], ['Y', 'register'], ['yes', 'register'], ['Yes', 'register'],
      ['YES', 'register'], ['yEs', 'register'], ['yeS', 'register'], ['YEs', 'register'],
      ['n', 'decline'], ['N', 'decline'], ['no', 'decline'], ['No', 'decline'], ['nO', 'decline'], ['NO', 'decline'],
      ['maybe', 'unrecognized'], ['yy', 'unrecognized'], ['yes please', 'unrecognized'], ['0', 'unrecognized'],
    ];
    for (const [reply, expected] of table) {
      const out = execFileSync('bash', ['-c', `eval "$(sed -n '/^classify_register_reply()/,/^}/p' ${shellQuote(installScript)})"; classify_register_reply "$1"`, 'bash', reply], { encoding: 'utf-8' }).trim();
      expect(out, `reply ${JSON.stringify(reply)}`).toBe(expected);
    }
  });

  it('headless run (no terminal, no --no-interact): defaults to REGISTER with a stderr notice', async () => {
    const { home, target, instance, seam } = stageConfiguredAbsentUnit();
    const launcher = writeLauncher({ home, instance, seam, cwd: target, command: 'exec bash ./install.sh' });
    const proc = await runDetached('bash', [launcher], { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GRU_COMMAND_HOME: instance });
    expect(proc.status, `${proc.stdout}\n${proc.stderr}`).toBe(0);
    // The no-terminal outcome is announced, never silent, and the prompt
    // itself is not shown (there is no terminal to show it on).
    expect(proc.stderr).toContain('no terminal for the register prompt');
    expect(proc.stdout).not.toContain('register one now');
    expect(proc.stdout).toContain('update complete; existing config preserved');
    expectRegisteredUnit(seam.managerLog, seam.unit, target, instance);
  }, 400_000);

  it('--update + absent unit routes through the same registration path (no terminal: default register, announced) (#36)', async () => {
    const { home, target, instance, seam } = stageConfiguredAbsentUnit();
    const launcher = writeLauncher({ home, instance, seam, cwd: target, command: 'exec bash ./install.sh --update' });
    const proc = await runDetached('bash', [launcher], { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), GRU_COMMAND_HOME: instance });
    expect(proc.status, `${proc.stdout}\n${proc.stderr}`).toBe(0);
    expect(proc.stdout).toContain('updating source with git pull --ff-only');
    expect(proc.stderr).toContain('no terminal for the register prompt');
    expect(proc.stdout).not.toContain('WIZARD-RAN');
    expectRegisteredUnit(seam.managerLog, seam.unit, target, instance);
  }, 400_000);

  it('--update --no-interact + absent unit registers without prompting (#36)', async () => {
    const { home, target, instance, seam } = stageConfiguredAbsentUnit();
    const result = await run(join(target, 'install.sh'), ['--update', '--no-interact'], { HOME: home, GRU_COMMAND_HOME: instance, ...seam.env });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('updating source with git pull --ff-only');
    expect(result.stdout).not.toContain('register one now');
    expectRegisteredUnit(seam.managerLog, seam.unit, target, instance);
  });

  it('updater never consults --answers register_service: --update rejects --answers, and --answers routes to the wizard (#36 deliberate routing)', async () => {
    const { home, target, instance, seam } = stageConfiguredAbsentUnit();
    const env = { HOME: home, GRU_COMMAND_HOME: instance, ...seam.env };
    const rejected = await run(join(target, 'install.sh'), ['--update', '--answers', '{"register_service":true}'], env);
    expect(rejected.status).toBe(2);
    expect(rejected.stderr).toContain('--update preserves config and cannot be combined with --answers or --force');
    // --answers (+ --force over the existing config) goes to the wizard, which
    // owns register_service; the updater's absent-unit branch never runs.
    const routed = await run(join(target, 'install.sh'), ['--answers', '{"register_service":false}', '--force'], env);
    expect(routed.status, `${routed.stdout}\n${routed.stderr}`).toBe(0);
    expect(routed.stdout).toContain('WIZARD-RAN');
    expect(routed.stdout).not.toContain('update complete; existing config preserved');
    expect(existsSync(seam.unit)).toBe(false);
    expect(noRegistrationCalls(seam.managerLog)).toBe(true);
  });

  it('a runner-set XDG_CONFIG_HOME can never redirect the unit write outside the sandbox HOME (#36)', async () => {
    const { home, target, instance, seam } = stageConfiguredAbsentUnit();
    const outside = tempDir('gru-command-ambient-xdg-');
    const result = await run(join(target, 'install.sh'), ['--no-interact'], {
      HOME: home,
      XDG_CONFIG_HOME: outside,
      GRU_COMMAND_HOME: instance,
      ...seam.env,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expectRegisteredUnit(seam.managerLog, seam.unit, target, instance);
    expect(existsSync(join(outside, 'systemd'))).toBe(false);
  });

  it('in-service restart delegates to gru roll --detach and never unload/loads', async () => {
    // Function-level pin for the delegation branch: the in-service process
    // group IS detected (fake manager reports our own pgid), the unit IS
    // owned, and the served restart must be the roll CLI — never the unit
    // lifecycle calls. Ownership itself is covered by its own tests; this
    // exercises the branch on every pty-less machine (Linux CI included).
    const home = tempDir('gru-command-in-service-fn-');
    const instance = join(home, '.gru-command');
    const { manager, managerLog } = inServiceManagerSeam(home);
    const rollLog = join(home, 'roll.log');
    const repoRoot = tempDir('gru-command-in-service-repo-');
    const installScript = join(import.meta.dirname, '..', 'install.sh');
    mkdirSync(join(repoRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'dist', 'cli', 'service.js'),
      [
        '#!/usr/bin/env node',
        "require('node:fs').appendFileSync(process.env.GRU_ROLL_LOG, `argv:${process.argv.slice(2).join(' ')}\n`);",
        '',
      ].join('\n'),
      'utf-8',
    );
    const script = [
      `REPO_ROOT=${shellQuote(repoRoot)}`,
      `OS=${process.platform === 'darwin' ? 'darwin' : 'linux'}`,
      `LABEL=com.gru-command.service`,
      `INSTANCE_DIR=${shellQuote(instance)}`,
      `NODE_BIN=${shellQuote(process.execPath)}`,
      `LAUNCHCTL_BIN=${shellQuote(manager)}`,
      `SYSTEMCTL_BIN=${shellQuote(manager)}`,
      `GRU_MANAGER_LOG=${shellQuote(managerLog)}`,
      `GRU_ROLL_LOG=${shellQuote(rollLog)}`,
      `export GRU_MANAGER_LOG GRU_ROLL_LOG`,
      `eval "$(sed -n '/^managed_service_pid()/,/^}/p' ${shellQuote(installScript)}; sed -n '/^inside_managed_service_pgroup()/,/^}/p' ${shellQuote(installScript)}; sed -n '/^restart_owned_service_in_service()/,/^}/p' ${shellQuote(installScript)}; sed -n '/^install_service()/,/^}/p' ${shellQuote(installScript)}; sed -n '/^restart_owned_service()/,/^}/p' ${shellQuote(installScript)})"`,
      `restart_owned_service`,
      '',
    ].join('\n');
    const stdout = execFileSync('bash', ['-c', script], {
      env: { ...process.env, HOME: home },
      encoding: 'utf-8',
    });
    expect(stdout).toContain("delegating the restart to 'gru roll --detach'");
    expect(stdout).toContain('the service relaunches itself once its drain settles, unless the roll fails later; check it with gru status and gru logs');
    // Through preflight only: the relaunch ends this shell with the service.
    expect(readFileSync(rollLog, 'utf-8')).toBe('argv:roll --detach\n');
    const calls = existsSync(managerLog) ? readFileSync(managerLog, 'utf-8') : '';
    expect(calls).not.toMatch(/^unload/m);
    expect(calls).not.toMatch(/^load/m);
    expect(calls).not.toContain('daemon-reload');
    expect(calls).not.toContain('restart gru-command');
  });

  it('an in-service roll the service refuses fails the update, named, and never claims a relaunch (#463)', async () => {
    // Function-level pin for the delegation branch: the in-service process
    // group IS detected (fake manager reports our own pgid), the unit IS
    // owned, and the served restart must be the roll CLI — never the unit
    // lifecycle calls. Ownership itself is covered by its own tests; this
    // exercises the branch on every pty-less machine (Linux CI included).
    const home = tempDir('gru-command-in-service-fn-');
    const instance = join(home, '.gru-command');
    const { manager, managerLog } = inServiceManagerSeam(home);
    const rollLog = join(home, 'roll.log');
    const repoRoot = tempDir('gru-command-in-service-repo-');
    const installScript = join(import.meta.dirname, '..', 'install.sh');
    mkdirSync(join(repoRoot, 'dist', 'cli'), { recursive: true });
    writeFileSync(
      join(repoRoot, 'dist', 'cli', 'service.js'),
      [
        '#!/usr/bin/env node',
        "require('node:fs').appendFileSync(process.env.GRU_ROLL_LOG, `argv:${process.argv.slice(2).join(' ')}\n`);",
        'process.exit(1);',
        '',
      ].join('\n'),
      'utf-8',
    );
    const script = [
      `REPO_ROOT=${shellQuote(repoRoot)}`,
      'set -euo pipefail',
      'err() { echo "install.sh: $*" >&2; }',
      `OS=${process.platform === 'darwin' ? 'darwin' : 'linux'}`,
      `LABEL=com.gru-command.service`,
      `INSTANCE_DIR=${shellQuote(instance)}`,
      `NODE_BIN=${shellQuote(process.execPath)}`,
      `LAUNCHCTL_BIN=${shellQuote(manager)}`,
      `SYSTEMCTL_BIN=${shellQuote(manager)}`,
      `GRU_MANAGER_LOG=${shellQuote(managerLog)}`,
      `GRU_ROLL_LOG=${shellQuote(rollLog)}`,
      `export GRU_MANAGER_LOG GRU_ROLL_LOG`,
      `eval "$(sed -n '/^managed_service_pid()/,/^}/p' ${shellQuote(installScript)}; sed -n '/^inside_managed_service_pgroup()/,/^}/p' ${shellQuote(installScript)}; sed -n '/^restart_owned_service_in_service()/,/^}/p' ${shellQuote(installScript)}; sed -n '/^install_service()/,/^}/p' ${shellQuote(installScript)}; sed -n '/^restart_owned_service()/,/^}/p' ${shellQuote(installScript)})"`,
      `restart_owned_service`,
      '',
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], { env: { ...process.env, HOME: home }, encoding: 'utf-8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('the service refused the roll: the new build is on disk but the service still runs the old one');
    expect(result.stdout).not.toContain('relaunches itself');
    expect(readFileSync(rollLog, 'utf-8')).toBe('argv:roll --detach\n');
  });

  it.skipIf(!ptyCapable)('in-service pty update (absent unit): no prompt hang — auto-registers with a notice', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const target = join(home, 'gru-command');
    execFileSync('git', ['clone', '-q', `file://${fixture}`, target], { stdio: 'pipe' });
    const instance = join(home, '.gru-command');
    mkdirSync(instance, { recursive: true });
    writeFileSync(join(instance, 'config.toml'), 'preserved\n');
    const seam = inServiceManagerSeam(home);
    const launcher = ptyUpdaterLauncher(home, target, instance, seam);
    // A REAL pty (no human on it): the exact shape that used to block the
    // register prompt forever on /dev/tty reads.
    const output = ptyRun(launcher, null);
    expect(output).toContain('running inside the managed service');
    expect(output).not.toContain('register one now');
    expect(output).toContain('update complete; existing config preserved');
    expectRegisteredUnit(seam.managerLog, seam.unit, target, instance);
  }, 340_000);

  it('installs the gru launcher (#463): it runs the clone\'s CLI from any directory, refreshes on update, never replaces a foreign gru, and --uninstall removes only its own', async () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const bare = tempDir('gru-command-launcher-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const target = join(home, 'gru-command');
    const instance = join(home, '.gru-command');
    const seam = serviceManagerSeam(home);
    const env = {
      HOME: home,
      GRU_COMMAND_HOME: instance,
      GRU_COMMAND_ORIGIN: `file://${fixture}`,
      GRU_COMMAND_TARGET: target,
      ...seam.env,
    };
    const launcher = join(home, '.local', 'bin', 'gru');
    const fresh = await run(join(bare, 'install.sh'), ['--answers', '{}'], env);
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(fresh.stdout).toContain(`installed the 'gru' command: ${launcher}`);
    // The sandbox PATH never holds the sandbox bin dir: the installer says how to add it.
    expect(fresh.stdout).toContain(`export PATH="${join(home, '.local', 'bin')}:$PATH"`);
    const launched = execFileSync(launcher, ['version', '--json'], { cwd: tmpdir(), encoding: 'utf-8', env: { ...process.env, HOME: home } });
    expect(launched).toBe('FIXTURE-ROLL-RAN version --json\n');
    expect(readFileSync(launcher, 'utf-8')).toContain('# gru-command launcher (managed by install.sh)');
    // It pins this install's instance, as the unit does.
    expect(readFileSync(launcher, 'utf-8')).toContain(`GRU_COMMAND_HOME='${instance}'`);

    // Ours is refreshed by an update…
    writeFileSync(launcher, '#!/bin/sh\n# gru-command launcher (managed by install.sh)\nexit 9\n', { mode: 0o755 });
    const update = ['--update', '--no-interact'];
    expect((await run(join(target, 'install.sh'), update, env)).status).toBe(0);
    expect(readFileSync(launcher, 'utf-8')).toContain(`${target}/dist/cli/service.js`);
    // …a foreign `gru` never is, and the install still succeeds…
    writeFileSync(launcher, '#!/bin/sh\necho someone-elses-gru\n', { mode: 0o755 });
    const foreign = await run(join(target, 'install.sh'), update, env);
    expect(foreign.status).toBe(0);
    expect(foreign.stdout).not.toContain("installed the 'gru' command");
    expect(readFileSync(launcher, 'utf-8')).toBe('#!/bin/sh\necho someone-elses-gru\n');
    // …and --uninstall removes only its own.
    const keptForeign = await run(join(target, 'install.sh'), ['--uninstall'], env);
    expect(keptForeign.status).toBe(0);
    expect(keptForeign.stdout).toContain('this installer did not write it');
    expect(existsSync(launcher)).toBe(true);
    rmSync(launcher);
    expect((await run(join(target, 'install.sh'), update, env)).status).toBe(0);
    const removed = await run(join(target, 'install.sh'), ['--uninstall'], env);
    expect(removed.status).toBe(0);
    expect(removed.stdout).toContain(`removed the 'gru' command: ${launcher}`);
    expect(existsSync(launcher)).toBe(false);
  });

  it('--stop/--start/--restart (#463) act on the owned unit only, with exact manager calls; inside the service, stop and an immediate restart refuse', async () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const instance = join(home, '.gru-command');
    const unit = sandboxUnitPath(home);
    const darwin = process.platform === 'darwin';
    const label = 'com.gru-command.service';
    const domain = `gui/${process.getuid?.() ?? 0}/${label}`;
    const base = { HOME: home, GRU_COMMAND_HOME: instance };
    const plain = serviceManagerSeam(home);
    expect((await run(join(fixture, 'install.sh'), ['--answers', '{"smoke":false}'], { ...base, ...plain.env })).status).toBe(0);
    const install = join(fixture, 'install.sh');
    const calls = (seam: ManagerSeam): string[] => existsSync(seam.managerLog)
      ? readFileSync(seam.managerLog, 'utf-8').split('\n').filter((line) => line !== '' && !line.startsWith('list') && !line.includes('show -p MainPID'))
      : [];

    // No unit: every mode names the registration command.
    for (const mode of ['--stop', '--start', '--restart']) {
      const absent = await run(install, [mode], { ...base, ...plain.env });
      expect(absent.status).not.toBe(0);
      expect(absent.stderr).toContain(`${fixture}/install.sh --service`);
    }
    expect(calls(plain)).toEqual([]);

    const rendered = await run(install, ['--print'], { ...base, ...plain.env });
    expect(rendered.status, rendered.stderr).toBe(0);
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, rendered.stdout);

    // Owned, not loaded: a macOS stop says so (unloading it would be an
    // error); start and restart load it. systemd's stop is idempotent.
    const stopped = await run(install, ['--stop'], { ...base, ...plain.env });
    expect(stopped.status).toBe(0);
    if (darwin) expect(stopped.stdout).toContain('already stopped');
    for (const mode of ['--start', '--restart']) {
      expect((await run(install, [mode], { ...base, ...plain.env })).status).toBe(0);
    }
    expect(calls(plain)).toEqual(darwin
      ? [`load ${unit}`, `load ${unit}`]
      : ['--user stop gru-command.service', '--user start gru-command.service', '--user restart gru-command.service']);

    // Loaded (macOS): stop unloads, start and restart go through kickstart.
    const loaded = fakeManagerSeam(home, 'loaded-manager', [
      'case "$*" in',
      `  list*) printf -- "-\\t0\\t${label}\\n" ;;`,
      'esac',
    ]);
    for (const mode of ['--stop', '--start', '--restart']) {
      expect((await run(install, [mode], { ...base, ...loaded.env })).status).toBe(0);
    }
    expect(calls(loaded)).toEqual(darwin
      ? [`unload ${unit}`, `kickstart ${domain}`, `kickstart -k ${domain}`]
      : ['--user stop gru-command.service', '--user start gru-command.service', '--user restart gru-command.service']);

    // Already running elsewhere: start is a no-op that says so.
    const running = fakeManagerSeam(home, 'running-manager', [
      'case "$*" in',
      '  *"show -p MainPID"*) printf "4242" ;;',
      `  list*) printf "4242\\t0\\t${label}\\n" ;;`,
      'esac',
    ]);
    const already = await run(install, ['--start'], { ...base, ...running.env });
    expect(already.status).toBe(0);
    expect(already.stdout).toContain('already running (pid 4242)');
    expect(calls(running)).toEqual([]);

    // Inside the managed service: stop and an immediate restart refuse.
    const inside = inServiceManagerSeam(home);
    const insideStop = await run(install, ['--stop'], { ...base, ...inside.env });
    expect(insideStop.status).not.toBe(0);
    expect(insideStop.stderr).toContain("run 'gru stop' from a terminal outside the service");
    const insideRestart = await run(install, ['--restart'], { ...base, ...inside.env });
    expect(insideRestart.status).not.toBe(0);
    expect(insideRestart.stderr).toContain("use 'gru restart --detach' instead");
    expect(calls(inside)).toEqual([]);

    // A foreign unit is never touched.
    writeFileSync(unit, 'foreign-user-unit\n');
    const foreignSeam = fakeManagerSeam(home, 'foreign-manager', []);
    for (const mode of ['--stop', '--start', '--restart']) {
      const refused = await run(install, [mode], { ...base, ...foreignSeam.env });
      expect(refused.status).not.toBe(0);
      expect(refused.stderr).toContain('refusing to touch unrelated service unit');
    }
    expect(calls(foreignSeam)).toEqual([]);
    expect(readFileSync(unit, 'utf-8')).toBe('foreign-user-unit\n');
  });

  it('direct --service/--uninstall also enforce exact unit ownership', async () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const instance = join(home, '.gru-command');
    const { manager, managerLog } = serviceManagerSeam(home);
    const env = {
      HOME: home,
      GRU_COMMAND_HOME: instance,
      GRU_MANAGER_LOG: managerLog,
      GRU_COMMAND_LAUNCHCTL: manager,
      GRU_COMMAND_SYSTEMCTL: manager,
    };
    expect((await run(join(fixture, 'install.sh'), ['--answers', '{"smoke":false}'], env)).status).toBe(0);
    const unit = sandboxUnitPath(home);
    mkdirSync(dirname(unit), { recursive: true });
    writeFileSync(unit, 'foreign-user-unit\n');
    const refusedRegister = await run(join(fixture, 'install.sh'), ['--service'], env);
    expect(refusedRegister.status).not.toBe(0);
    expect(readFileSync(unit, 'utf-8')).toBe('foreign-user-unit\n');
    const refusedUninstall = await run(join(fixture, 'install.sh'), ['--uninstall'], env);
    expect(refusedUninstall.status).not.toBe(0);
    expect(readFileSync(unit, 'utf-8')).toBe('foreign-user-unit\n');

    const rendered = await run(join(fixture, 'install.sh'), ['--print'], env);
    expect(rendered.status, rendered.stderr).toBe(0);
    const unmarked = process.platform === 'darwin'
      ? rendered.stdout.replace(
          '  <key>GruCommandManagedBy</key>\n  <string>gru-command-install-v2</string>\n',
          '',
        )
      : rendered.stdout.replace('X-GruCommandManagedBy=gru-command-install-v2\n', '');
    writeFileSync(unit, unmarked);
    expect((await run(join(fixture, 'install.sh'), ['--uninstall'], env)).status).not.toBe(0);
    expect(readFileSync(unit, 'utf-8')).toBe(unmarked);
    if (process.platform === 'darwin') {
      const wrongExecutable = rendered.stdout.replace(
        `<string>${process.execPath}</string>`,
        '<string>/usr/bin/false</string>',
      );
      expect(wrongExecutable).not.toBe(rendered.stdout);
      writeFileSync(unit, wrongExecutable);
      expect((await run(join(fixture, 'install.sh'), ['--uninstall'], env)).status).not.toBe(0);
      expect(readFileSync(unit, 'utf-8')).toBe(wrongExecutable);
    }
    const previousNode = rendered.stdout.replace(process.execPath, '/opt/previous-node/bin/node');
    expect(previousNode).not.toBe(rendered.stdout);
    writeFileSync(unit, previousNode);
    expect((await run(join(fixture, 'install.sh'), ['--uninstall'], env)).status).toBe(0);
    expect(existsSync(unit)).toBe(false);
    writeFileSync(unit, rendered.stdout);
    expect((await run(join(fixture, 'install.sh'), ['--uninstall'], env)).status).toBe(0);
    expect(existsSync(unit)).toBe(false);
    // --service refreshes a stale launcher of ours with the unit (#463).
    const launcher = join(home, '.local', 'bin', 'gru');
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, "#!/bin/sh\n# gru-command launcher (managed by install.sh)\nexec '/opt/previous-node/bin/node' '/elsewhere/dist/cli/service.js' \"$@\"\n", { mode: 0o755 });
    expect((await run(join(fixture, 'install.sh'), ['--service'], env)).status).toBe(0);
    expect(readFileSync(unit, 'utf-8')).toBe(rendered.stdout);
    const refreshed = readFileSync(launcher, 'utf-8');
    expect(refreshed).toContain(`GRU_COMMAND_HOME='${instance}'`);
    expect(refreshed).toContain(`'${fixture}/dist/cli/service.js' "$@"`);
    expect(refreshed).not.toContain('/opt/previous-node');
  });

  it('inside a clone: no flags clone the product — deps+build+wizard only', async () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const elsewhere = join(home, 'should-not-exist');
    const { stdout, status } = await run(join(fixture, 'install.sh'), ['--answers', '{}'], {
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

  it('--no-interact alone completes with documented defaults and never opens the TTY', async () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const result = await run(join(fixture, 'install.sh'), ['--no-interact'], {
      HOME: home,
      GRU_COMMAND_HOME: join(home, '.gru-command'),
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('WIZARD-RAN --no-interact');
  });

  it('--answers=<json> equals-form parses identically (wizard marker written)', async () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const { stdout, status } = await run(join(fixture, 'install.sh'), ['--answers={}'], {
      HOME: home,
      GRU_COMMAND_HOME: join(home, '.gru-command'),
    });
    expect(status, stdout).toBe(0);
    expect(stdout).toContain('WIZARD-RAN');
    expect(existsSync(join(home, '.gru-command', 'config.toml'))).toBe(true);
  });

  it('--answers combined with --print exits 2 with a named mode-conflict error', async () => {
    for (const args of [['--answers', '{}', '--print'], ['--print', '--answers', '{}']]) {
      const { status, stderr } = await run(join(repoRoot, 'install.sh'), args, {});
      expect(status, String(args)).toBe(2);
      expect(stderr).toContain('--answers is only valid with setup mode');
      expect(stderr).toContain('--print');
    }
  });

  it('rejects update without a config and refuses a pre-positioned checkout from another origin', async () => {
    const noConfigHome = tempDir('gru-command-update-no-config-home-');
    const noConfigBare = tempDir('gru-command-update-no-config-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(noConfigBare, 'install.sh'));
    const noConfigTarget = join(noConfigHome, 'gru-command');
    const noConfig = await run(join(noConfigBare, 'install.sh'), ['--update'], {
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
    const wrongOrigin = await run(join(bare, 'install.sh'), [], {
      HOME: first.home,
      GRU_COMMAND_HOME: instance,
      GRU_COMMAND_TARGET: target,
      GRU_COMMAND_ORIGIN: `file://${second.fixture}`,
    });
    expect(wrongOrigin.status).toBe(1);
    expect(wrongOrigin.stderr).toContain('unexpected origin');
    expect(readFileSync(join(instance, 'config.toml'), 'utf-8')).toBe('preserved\n');
  });

  it('clone failure (bad GRU_COMMAND_ORIGIN) exits non-zero with a named error', async () => {
    const home = tempDir('gru-command-clonefail-home-');
    const bare = tempDir('gru-command-clonefail-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const { stdout, status } = await run(
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

  it('re-exec guard: GRU_COMMAND_REEXEC=1 outside a checkout exits 1, named', async () => {
    const home = tempDir('gru-command-reexec-home-');
    const bare = tempDir('gru-command-reexec-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const { stderr, status } = await run(join(bare, 'install.sh'), ['--answers', '{}'], {
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
  it('unknown flags exit 2 with usage', async () => {
    const { status, stderr } = await run(join(repoRoot, 'install.sh'), ['--bogus'], {});
    expect(status).toBe(2);
    expect(stderr).toContain('unknown flag');
  });

  it('--print renders the platform unit absolutely; changes nothing', async () => {
    const { stdout, status } = await run(join(repoRoot, 'install.sh'), ['--print'], {});
    expect(status).toBe(0);
    expect(stdout).not.toContain('{{NODE}}');
    expect(stdout).not.toContain('{{REPO_ROOT}}');
    expect(stdout).not.toContain('{{GRU_COMMAND_HOME}}');
    expect(stdout).not.toContain('{{PATH}}');
  });

  it('--uninstall on a clean machine reports not-installed, exit 0', async () => {
    const home = tempDir('gru-command-uninstall-');
    const { stdout, status } = await run(join(repoRoot, 'install.sh'), ['--uninstall'], { HOME: home });
    expect(status, stdout).toBe(0);
    expect(stdout).toMatch(/not installed/);
  });

  it('--service refuses loudly when dist/main.js is missing', async () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const { stderr, status } = await run(join(fixture, 'install.sh'), ['--service'], { HOME: home });
    expect(status).toBe(1);
    expect(stderr).toContain('dist/main.js not found');
  });

  it('--answers= (empty) exits 2 — never a silent flip to interactive (Perkins r2 note)', async () => {
    const { status, stderr } = await run(join(repoRoot, 'install.sh'), ['--answers='], {});
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

  it('--service mode gates before unit registration', async () => {
    const shim = oldNodeShim();
    const { stderr, status } = await run(join(repoRoot, 'install.sh'), ['--service'], {
      PATH: `${shim}:${process.env.PATH ?? ''}`,
    });
    expect(status).toBe(1);
    expect(stderr).toContain('node >= 22.19 required');
    expect(stderr).toContain('v18.20.0');
  });

  it('setup mode (inside a checkout) gates before deps/build', async () => {
    const shim = oldNodeShim();
    const { stderr, status } = await run(join(repoRoot, 'install.sh'), [], {
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

describe('pty gate (no silent PTY skips)', () => {
  it('expect(1) is present on pty platforms, or the run explicitly opts out', () => {
    if (!ptyPlatform || ptySkipOptOut) return;
    expect(expectAvailable(), 'expect(1) is missing — install expect or set GRU_TEST_SKIP_PTY=1 to opt out explicitly.').toBe(true);
  });
});
