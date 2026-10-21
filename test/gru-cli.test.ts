import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, type GruCommandConfig } from '../src/config.js';
import type { BuildInfo } from '../src/build-info.js';
import type { DeployDriftView } from '../src/board/deploy-drift.js';
import { runServiceCli, type ServiceCliDeps } from '../src/cli/service.js';
import { deployLine, formatUptime, installerRunnerFor } from '../src/cli/operator.js';

/**
 * The `gru` operator subcommands (#463) beyond the roll itself: update,
 * stop, start and restart --now hand the unit work to the deploy clone's
 * install.sh with exact flags; status reads the running service; logs
 * tails its log. Every seam is injected, so nothing here touches a real
 * service, installer or terminal.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tempConfig(): GruCommandConfig {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-gru-cli-'));
  cleanupDirs.push(dir);
  writeFileSync(join(dir, 'config.toml'), '[server]\nhost = "127.0.0.1"\nport = 7666\n[auth]\ntoken = "gru-cli-token"\n', 'utf-8');
  return loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
}

const BUILD = (rev: string | null): BuildInfo => ({ version: '1.0.2', rev, committedAt: null, builtAt: null });

function drift(overrides: Partial<DeployDriftView> = {}): DeployDriftView {
  return {
    buildRev: 'b'.repeat(40),
    buildCommittedAt: null,
    originMainRev: 'b'.repeat(40),
    originMainCommittedAt: null,
    commitsBehind: 0,
    latestTag: null,
    buildTag: null,
    updateAvailable: false,
    checkedAt: null,
    checkError: null,
    ...overrides,
  };
}

interface Harness {
  readonly deps: Partial<ServiceCliDeps>;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly installer: (readonly string[])[];
  readonly tails: (readonly string[])[];
  readonly urls: string[];
}

function harness(options: {
  readonly installerCode?: number;
  readonly health?: unknown | 'unreachable';
  readonly board?: unknown;
  readonly installed?: string | null;
  readonly config?: GruCommandConfig;
} = {}): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const installer: (readonly string[])[] = [];
  const tails: (readonly string[])[] = [];
  const urls: string[] = [];
  const config = options.config ?? tempConfig();
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    urls.push(url);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer gru-cli-token');
    if (url.endsWith('/health')) {
      if (options.health === 'unreachable' || options.health === undefined) throw new Error('connect ECONNREFUSED');
      return new Response(JSON.stringify(options.health), { status: 200 });
    }
    if (url.endsWith('/api/board')) return new Response(JSON.stringify(options.board ?? {}), { status: 200 });
    throw new Error(`unexpected request ${url}`);
  };
  return {
    deps: {
      loadConfig: () => config,
      fetchFn,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      runInstaller: (args) => { installer.push(args); return options.installerCode ?? 0; },
      runTail: (args) => { tails.push(args); return 0; },
      installedBuild: () => BUILD(options.installed === undefined ? 'b'.repeat(40) : options.installed),
    },
    stdout,
    stderr,
    installer,
    tails,
    urls,
  };
}

describe('gru update / stop / start / restart --now hand off to install.sh', () => {
  it('passes the exact install.sh flags and its exit code through', async () => {
    const h = harness({ installerCode: 3 });
    expect(await runServiceCli(['update'], h.deps)).toBe(3);
    expect(await runServiceCli(['update', '--no-interact'], h.deps)).toBe(3);
    expect(await runServiceCli(['stop'], h.deps)).toBe(3);
    expect(await runServiceCli(['start'], h.deps)).toBe(3);
    expect(await runServiceCli(['restart', '--now'], h.deps)).toBe(3);
    expect(h.installer).toEqual([['--update'], ['--update', '--no-interact'], ['--stop'], ['--start'], ['--restart']]);
  });

  it('refuses unknown options before install.sh runs', async () => {
    const h = harness();
    expect(await runServiceCli(['update', '--force'], h.deps)).toBe(2);
    expect(await runServiceCli(['stop', '--now'], h.deps)).toBe(2);
    expect(await runServiceCli(['restart', '--now', '--json'], h.deps)).toBe(2);
    expect(h.installer).toEqual([]);
    expect(h.stderr.join('\n')).toContain('unknown argument to update: --force');
    expect(h.stderr.join('\n')).toContain('restart --now takes no other options');
  });

  it('runs the real install.sh from its checkout with exactly those flags, hands over its own node, and returns the exit code', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gru-command-installer-')));
    cleanupDirs.push(root);
    const record = join(root, 'record.txt');
    writeFileSync(join(root, 'install.sh'),
      `printf '%s\\n' "$*" "$GRU_COMMAND_NODE" "$(pwd -P)" "$PATH" "$GRU_COMMAND_LAUNCH_PWD" > ${JSON.stringify(record)}\nexit 7\n`);
    expect(installerRunnerFor(root)(['--stop'])).toBe(7);
    const [args, node, cwd, path, launchPwd] = readFileSync(record, 'utf8').trimEnd().split('\n');
    expect(args).toBe('--stop');
    // install.sh decides: the shell's node, or this one when the shell's is missing or too old.
    expect(node).toBe(process.execPath);
    // From the checkout, so a version manager never picks a node from the caller's directory.
    expect(cwd).toBe(root);
    expect(path).toBe(process.env['PATH']);
    // Hints install.sh prints (`<path>/install.sh --service`) are for the caller's directory.
    expect(launchPwd).toBe(process.cwd());
  });

  it('every subcommand answers --help with usage and exit 0, running nothing', async () => {
    const h = harness();
    for (const argv of [['update', '--help'], ['stop', '-h'], ['start', '--help'], ['status', '--help'], ['logs', '-h'], ['restart', '--now', '--help']]) {
      expect(await runServiceCli(argv, h.deps)).toBe(0);
    }
    expect(h.installer).toEqual([]);
    expect(h.tails).toEqual([]);
    expect(h.stderr.filter((line) => line.startsWith('usage: gru <command>'))).toHaveLength(6);
  });

  it('a package root without install.sh is a named refusal, not a crash', () => {
    const notACheckout = mkdtempSync(join(tmpdir(), 'gru-command-not-checkout-'));
    cleanupDirs.push(notACheckout);
    expect(installerRunnerFor(notACheckout)(['--update'])).toBe(1);
  });
});

describe('gru status', () => {
  it('a running service: version, uptime, build, a pending restart, and drift — exit 0', async () => {
    const h = harness({
      health: { version: '1.0.2', uptime_ms: 3 * 3_600_000 + 12 * 60_000, build: { rev: 'b'.repeat(40) } },
      board: { build: drift({ commitsBehind: 3 }) },
      installed: 'c'.repeat(40),
    });
    expect(await runServiceCli(['status'], h.deps)).toBe(0);
    expect(h.stdout).toEqual([
      'Gru Command 1.0.2 is running (up 3h 12m) · build bbbbbbb · http://127.0.0.1:7666',
      'restart pending: build ccccccc is installed but not running yet — gru restart',
      '3 commits behind main — gru update',
    ]);
    expect(h.urls).toEqual(['http://127.0.0.1:7666/health', 'http://127.0.0.1:7666/api/board']);
  });

  it('a service that does not answer: names gru start, exit 1; --json carries the same facts', async () => {
    const down = harness({ health: 'unreachable', installed: 'c'.repeat(40) });
    expect(await runServiceCli(['status'], down.deps)).toBe(1);
    expect(down.stdout).toEqual([
      'Gru Command is not running (no answer at http://127.0.0.1:7666) — start it with: gru start',
      'installed build: ccccccc',
    ]);
    const json = harness({ health: 'unreachable', installed: null });
    expect(await runServiceCli(['status', '--json'], json.deps)).toBe(1);
    expect(JSON.parse(json.stdout[0]!)).toMatchObject({ running: false, installedRev: null, restartPending: false, deploy: null });
    expect(await runServiceCli(['status', '--watch'], json.deps)).toBe(2);
  });

  it('describes drift plainly, from up to date to an unreadable check', () => {
    expect(deployLine(null)).toBe('deploy check: not available yet');
    expect(deployLine(drift())).toBe('up to date with main');
    expect(deployLine(drift({ commitsBehind: 1 }))).toBe('1 commit behind main — gru update');
    expect(deployLine(drift({ updateAvailable: true, latestTag: 'v1.0.3', buildTag: 'v1.0.2', commitsBehind: 4 })))
      .toBe('update available: v1.0.3 (running v1.0.2) — gru update');
    expect(deployLine(drift({ commitsBehind: null, checkError: 'origin unreachable' }))).toBe('deploy check: unknown (origin unreachable)');
    expect(formatUptime(30_000)).toBe('under a minute');
    expect(formatUptime(26 * 3_600_000)).toBe('1d 2h');
  });
});

describe('gru logs', () => {
  it('tails the service log, -n and -f included; a missing log and a bad -n are named errors', async () => {
    const config = tempConfig();
    const missing = harness({ config });
    expect(await runServiceCli(['logs'], missing.deps)).toBe(1);
    expect(missing.stderr.join('\n')).toContain('no service log at');
    expect(missing.tails).toEqual([]);

    const file = join(config.dataDir, 'logs', 'service.log');
    mkdirSync(join(config.dataDir, 'logs'), { recursive: true });
    writeFileSync(file, '{"msg":"booted"}\n');
    const h = harness({ config });
    expect(await runServiceCli(['logs'], h.deps)).toBe(0);
    expect(await runServiceCli(['logs', '-f', '-n', '20'], h.deps)).toBe(0);
    // -F: following survives the logger's rename-based rotation.
    expect(h.tails).toEqual([['-n', '100', file], ['-n', '20', '-F', file]]);
    expect(await runServiceCli(['logs', '-n', '0'], h.deps)).toBe(2);
    expect(await runServiceCli(['logs', '--grep'], h.deps)).toBe(2);
    expect(h.tails).toHaveLength(2);
  });
});

describe('gru usage', () => {
  it('names every subcommand under gru; an unknown one is usage plus exit 2', async () => {
    const help = harness();
    expect(await runServiceCli(['--help'], help.deps)).toBe(0);
    const usage = help.stderr.join('\n');
    expect(usage).toContain('usage: gru <command> [options]');
    for (const command of ['update', 'restart [--now]', 'stop', 'start', 'status [--json]', 'logs [-f] [-n <lines>]', 'version [--json]', 'reset', 'roll']) {
      expect(usage).toContain(`  ${command}`);
    }
    const unknown = harness();
    expect(await runServiceCli(['reload'], unknown.deps)).toBe(2);
    expect(unknown.stderr.join('\n')).toContain('gru: unknown command: reload');
  });
});
