import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GruCommandConfig } from '../config.js';
import type { BuildInfo } from '../build-info.js';
import type { DeployDriftView } from '../board/deploy-drift.js';

/**
 * The `gru` operator subcommands that are not the roll itself (#463):
 * `update`, `stop`, `start` and `restart --now` hand the unit work to the
 * deploy clone's own install.sh (one lifecycle mechanism); `status` reads
 * the running service; `logs` tails its log. Every one runs from any
 * directory: the deploy clone is this CLI's own package root.
 */

/** Run the deploy clone's install.sh with these flags; its exit code. */
export type InstallerRunner = (args: readonly string[]) => number;

/** The caller's directory, or null when it was deleted under them (an agent
 * shell left in a reclaimed lane): install.sh then names absolute paths. */
export function callerDirectory(cwd: () => string = () => process.cwd()): string | null {
  try {
    return cwd();
  } catch {
    return null;
  }
}

export function installerRunnerFor(packageRoot: string): InstallerRunner {
  return (args) => {
    const script = join(packageRoot, 'install.sh');
    if (!existsSync(script)) {
      process.stderr.write(`gru: ${packageRoot} is not a Gru Command checkout (no install.sh) — reinstall with the one-line installer\n`);
      return 1;
    }
    // install.sh uses the shell's node, as running it yourself would; the
    // node this command runs on (GRU_COMMAND_NODE) stands in only when the
    // shell has none or one below the minimum. Run from the checkout, so a
    // version manager never picks a node from the caller's directory.
    const launchPwd = callerDirectory();
    const result = spawnSync('bash', [script, ...args], {
      cwd: packageRoot,
      stdio: 'inherit',
      // The caller's directory, for hints install.sh prints to them.
      env: { ...process.env, GRU_COMMAND_NODE: process.execPath, ...(launchPwd === null ? {} : { GRU_COMMAND_LAUNCH_PWD: launchPwd }) },
    });
    if (result.error !== undefined) {
      process.stderr.write(`gru: could not run ${script}: ${result.error.message}\n`);
      return 1;
    }
    return result.status ?? 1;
  };
}

export interface InstallerCliDeps {
  readonly stderr: (line: string) => void;
  readonly runInstaller: InstallerRunner;
}

const INSTALLER_COMMANDS = {
  update: { flag: '--update', options: ['--no-interact'] },
  stop: { flag: '--stop', options: [] },
  start: { flag: '--start', options: [] },
} as const satisfies Record<string, { readonly flag: string; readonly options: readonly string[] }>;

export type InstallerCommand = keyof typeof INSTALLER_COMMANDS;

export function isInstallerCommand(name: string | undefined): name is InstallerCommand {
  return name !== undefined && Object.hasOwn(INSTALLER_COMMANDS, name);
}

/** `gru update|stop|start`: install.sh owns the unit and the update path. */
export function runInstallerCli(command: InstallerCommand, args: readonly string[], deps: InstallerCliDeps): number {
  const { flag, options } = INSTALLER_COMMANDS[command];
  for (const arg of args) {
    if (!(options as readonly string[]).includes(arg)) {
      deps.stderr(`gru: unknown argument to ${command}: ${arg}${options.length === 0 ? ` (${command} takes none)` : ` (valid: ${options.join(', ')})`}`);
      return 2;
    }
  }
  return deps.runInstaller([flag, ...args]);
}

/**
 * `gru start` and `gru restart --now` (#494): the service loads config.toml
 * when it boots and refuses an invalid one, leaving the unit failing to
 * start (and an immediate restart stops the running service first). The
 * installer runs only once the same check passes here.
 */
export function configCheckedInstaller(
  deps: InstallerCliDeps & { readonly loadConfig: () => GruCommandConfig },
  action: 'start' | 'restart',
): InstallerRunner {
  return (args) => {
    try {
      deps.loadConfig();
    } catch (error) {
      deps.stderr(
        action === 'start'
          ? `gru: not starting the service: config.toml is invalid and the service would refuse it — ${String((error as Error).message)}`
          : `gru: not restarting the service: config.toml is invalid and the service would refuse it; the running service keeps the config it loaded — ${String((error as Error).message)}`,
      );
      return 1;
    }
    return deps.runInstaller(args);
  };
}

/** `gru restart --now`: an immediate service-manager restart. */
export function runRestartNowCli(args: readonly string[], deps: InstallerCliDeps): number {
  const others = args.filter((arg) => arg !== '--now');
  if (others.length > 0) {
    deps.stderr(`gru: restart --now takes no other options (got ${others.join(' ')}) — they belong to the graceful restart`);
    return 2;
  }
  return deps.runInstaller(['--restart']);
}

// ---------------------------------------------------------------------------
// gru logs
// ---------------------------------------------------------------------------

const DEFAULT_LOG_LINES = 100;

export interface LogsCliDeps {
  readonly loadConfig: () => GruCommandConfig;
  readonly stderr: (line: string) => void;
  /** `tail` with these arguments; its exit code. */
  readonly runTail: (args: readonly string[]) => number;
}

export function defaultTail(args: readonly string[]): number {
  const result = spawnSync('tail', [...args], { stdio: 'inherit' });
  if (result.error !== undefined) {
    process.stderr.write(`gru: could not run tail: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? (result.signal === 'SIGINT' ? 130 : 1);
}

/** `gru logs [-f] [-n <lines>]`: the service's own structured log. */
export function runLogsCli(args: readonly string[], deps: LogsCliDeps): number {
  let follow = false;
  let lines = DEFAULT_LOG_LINES;
  const rest = [...args];
  while (rest.length > 0) {
    const arg = rest.shift() as string;
    if (arg === '-f' || arg === '--follow') follow = true;
    else if (arg === '-n' || arg === '--lines') {
      const value = Number(rest.shift());
      if (!Number.isSafeInteger(value) || value < 1) {
        deps.stderr(`gru: ${arg} requires a positive whole number of lines`);
        return 2;
      }
      lines = value;
    } else {
      deps.stderr(`gru: unknown argument to logs: ${arg} (valid: -f, -n <lines>)`);
      return 2;
    }
  }
  let config: GruCommandConfig;
  try {
    config = deps.loadConfig();
  } catch (error) {
    deps.stderr(`gru: cannot load instance config: ${String((error as Error).message)}`);
    return 1;
  }
  const file = join(config.dataDir, 'logs', 'service.log');
  if (!existsSync(file)) {
    deps.stderr(`gru: no service log at ${file} — the service has not written one yet (start it with: gru start)`);
    return 1;
  }
  // -F follows the name, so following survives the logger's rotation.
  return deps.runTail(['-n', String(lines), ...(follow ? ['-F'] : []), file]);
}

// ---------------------------------------------------------------------------
// gru status
// ---------------------------------------------------------------------------

const STATUS_TIMEOUT_MS = 5_000;

export interface StatusCliDeps {
  readonly loadConfig: () => GruCommandConfig;
  readonly fetchFn: typeof fetch;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** The installed (on-disk) build stamp of the deploy clone. */
  readonly installedBuild: () => BuildInfo;
  readonly baseUrl: (config: GruCommandConfig) => string;
}

export interface ServiceStatus {
  readonly running: boolean;
  readonly url: string;
  readonly version: string | null;
  readonly uptimeMs: number | null;
  readonly runningRev: string | null;
  readonly installedRev: string | null;
  /** The installed build differs from the one running: `gru restart` applies it. */
  readonly restartPending: boolean;
  readonly deploy: DeployDriftView | null;
}

async function getJson(deps: StatusCliDeps, url: string, token: string): Promise<{ readonly status: number; readonly body: unknown } | null> {
  try {
    const res = await deps.fetchFn(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return null;
  }
}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

export async function readServiceStatus(deps: StatusCliDeps, config: GruCommandConfig): Promise<ServiceStatus> {
  const url = deps.baseUrl(config);
  const installedRev = deps.installedBuild().rev;
  const health = await getJson(deps, `${url}/health`, config.auth.token);
  if (health === null || health.status !== 200) {
    return { running: false, url, version: null, uptimeMs: null, runningRev: null, installedRev, restartPending: false, deploy: null };
  }
  const version = field(health.body, 'version');
  const uptime = field(health.body, 'uptime_ms');
  const rev = field(field(health.body, 'build'), 'rev');
  const runningRev = typeof rev === 'string' ? rev : null;
  const board = await getJson(deps, `${url}/api/board`, config.auth.token);
  const drift = board !== null && board.status === 200 ? field(board.body, 'build') : null;
  return {
    running: true,
    url,
    version: typeof version === 'string' ? version : null,
    uptimeMs: typeof uptime === 'number' ? uptime : null,
    runningRev,
    installedRev,
    restartPending: runningRev !== null && installedRev !== null && runningRev !== installedRev,
    deploy: typeof drift === 'object' && drift !== null ? (drift as DeployDriftView) : null,
  };
}

function shortRev(rev: string | null): string {
  return rev === null ? 'unknown' : rev.slice(0, 7);
}

export function formatUptime(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'under a minute';
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const mins = minutes % 60;
  return [days > 0 ? `${days}d` : '', hours > 0 ? `${hours}h` : '', mins > 0 ? `${mins}m` : ''].filter(Boolean).join(' ');
}

export function deployLine(deploy: DeployDriftView | null): string {
  if (deploy === null) return 'deploy check: not available yet';
  if (deploy.updateAvailable === true && deploy.latestTag !== null) {
    return `update available: ${deploy.latestTag} (running ${deploy.buildTag ?? 'an untagged build'}) — gru update`;
  }
  if (deploy.commitsBehind === null) {
    return `deploy check: unknown${deploy.checkError === null ? '' : ` (${deploy.checkError})`}`;
  }
  if (deploy.commitsBehind > 0) {
    return `${deploy.commitsBehind} commit${deploy.commitsBehind === 1 ? '' : 's'} behind main — gru update`;
  }
  return 'up to date with main';
}

/** `gru status [--json]`: exit 0 when the service answers, 1 when it does not. */
export async function runStatusCli(args: readonly string[], deps: StatusCliDeps): Promise<number> {
  let json = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else {
      deps.stderr(`gru: unknown argument to status: ${arg} (valid: --json)`);
      return 2;
    }
  }
  let config: GruCommandConfig;
  try {
    config = deps.loadConfig();
  } catch (error) {
    deps.stderr(`gru: cannot load instance config: ${String((error as Error).message)}`);
    return 1;
  }
  const status = await readServiceStatus(deps, config);
  if (json) {
    deps.stdout(JSON.stringify(status));
    return status.running ? 0 : 1;
  }
  if (!status.running) {
    deps.stdout(`Gru Command is not running (no answer at ${status.url}) — start it with: gru start`);
    deps.stdout(`installed build: ${shortRev(status.installedRev)}`);
    return 1;
  }
  deps.stdout(
    `Gru Command ${status.version ?? 'unknown version'} is running` +
      `${status.uptimeMs === null ? '' : ` (up ${formatUptime(status.uptimeMs)})`} · build ${shortRev(status.runningRev)} · ${status.url}`,
  );
  if (status.restartPending) {
    deps.stdout(`restart pending: build ${shortRev(status.installedRev)} is installed but not running yet — gru restart`);
  }
  deps.stdout(deployLine(status.deploy));
  return 0;
}
