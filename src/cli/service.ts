#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type GruCommandConfig } from '../config.js';
import { readBuildInfo, type BuildInfo } from '../build-info.js';
import { SERVICE_NAME, VERSION } from '../version.js';
import { defaultListenerProbe, type ListenerOwner, type ListenerProbe } from '../listener-probe.js';
import type { RollState } from '../roll/state.js';
import { runResetCli, type ResetCliDeps } from './reset.js';
import { defaultPackageRoot } from '../build-info.js';
import {
  defaultTail,
  installerRunnerFor,
  isInstallerCommand,
  runInstallerCli,
  runLogsCli,
  runRestartNowCli,
  runStatusCli,
  type InstallerRunner,
} from './operator.js';

/**
 * `gru` — the operator CLI for the service's own lifecycle (#463). The
 * installer puts a `gru` launcher on PATH; `gru-service` is the same entry
 * under its older name.
 *
 *   gru update [--no-interact]     the deploy clone's install.sh --update
 *   gru restart [--now] [roll options]
 *   gru stop | gru start           install.sh --stop / --start
 *   gru status [--json]            running build, installed build, drift
 *   gru logs [-f] [-n <lines>]     the service log
 *   gru roll [--no-wait] [--json] [--reason <text>] [--timeout-ms <n>]
 *   gru version [--json]           (offline: no service needed)
 *   gru --version                  (alias of version)
 *   gru reset [--yes] [--delete-branches] [--delete-refs]   (src/cli/reset.ts)
 *
 * The roll command asks the running service to roll itself (POST
 * /api/roll, operator-guarded with the pairing token) and — unless
 * --no-wait — follows the roll record until the relaunched service
 * reports the target build SHA on /health. An accepted roll always
 * completes the service-side handoff even if this CLI is interrupted:
 * exit 75 signals the OS service manager to relaunch the unit. `restart`
 * is the same roll in restart mode: no pull and no build, so the service
 * drains and relaunches its current build.
 */

const DEFAULT_FOLLOW_TIMEOUT_MS = 30 * 60_000;
const POLL_INTERVAL_MS = 2_000;
const HEALTH_VERIFY_TIMEOUT_MS = 60_000;

const USAGE = `usage: gru <command> [options]

  update [--no-interact]   pull main, rebuild, and restart the service
                           (the deploy clone's install.sh --update)
  restart [--now]          relaunch the service on the build it already has,
                           e.g. after editing config.toml. It first waits for
                           in-flight turns to settle (up to [roll]
                           drain_timeout_ms); --now restarts at once and boot
                           recovery resumes the turns it cut. Also takes
                           --no-wait, --json, --reason and --timeout-ms.
  stop                     stop the service; it stays down until gru start or
                           your next login
  start                    start the service
  status [--json]          running build, installed build, and how far behind
                           main; exits 1 when the service is not running
  logs [-f] [-n <lines>]   show the service log (-f follows it)
  version [--json]         the installed version and build SHA (offline)
  reset [--yes] [--delete-branches] [--delete-refs]
                           with the service stopped: remove every GC lane from
                           the managed repositories and empty the data
                           directory, keeping config.toml (gru reset --help)
  roll [--no-wait] [--json] [--reason <text>] [--timeout-ms <n>]
                           update through the running service: pull and
                           rebuild, drain, relaunch, and verify on /health

  gru-service is the same command under its older name.
`;

const VERSION_USAGE = `usage: gru version [--json]

  version  print the installed GC version and the build stamp this
           installation was compiled from (no config, no network).
`;

/** The installed CLI's own identity — package version plus the build
 * stamp written at build time. Not the RUNNING service's identity: this
 * command is offline and never guesses across a mismatched checkout. */
export interface VersionInfo {
  readonly service: string;
  readonly version: string;
  readonly rev: string | null;
  readonly committedAt: string | null;
  readonly builtAt: string | null;
}

export function currentVersionInfo(build: BuildInfo = readBuildInfo()): VersionInfo {
  return {
    service: SERVICE_NAME,
    // The stamp is what this installation BUILT. Fall back to the checkout's
    // package.json only for pre-stamp builds (the SHA is still exact).
    version: build.version ?? VERSION,
    rev: build.rev,
    committedAt: build.committedAt,
    builtAt: build.builtAt,
  };
}

/** Machine form is one JSON object; human form is one line a user can
 * paste into a bug report. */
export function formatVersion(info: VersionInfo, json: boolean): string {
  if (json) return JSON.stringify(info);
  const rev = info.rev === null ? 'unknown' : info.rev.slice(0, 7);
  const when = info.committedAt ?? info.builtAt;
  return `${info.service} ${info.version} · build ${rev}${when === null ? '' : ` (${when})`}`;
}

export interface VersionCliDeps {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly build: () => BuildInfo;
}

/** `gru version [--json]`: offline, strict, no config read. */
export function runVersionCli(args: readonly string[], deps: VersionCliDeps): number {
  let json = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg === '-h' || arg === '--help') {
      deps.stderr(VERSION_USAGE.trimEnd());
      return 0;
    } else {
      deps.stderr(`gru: unknown argument: ${arg}`);
      deps.stderr(VERSION_USAGE.trimEnd());
      return 2;
    }
  }
  deps.stdout(formatVersion(currentVersionInfo(deps.build()), json));
  return 0;
}

export interface ServiceCliOptions {
  /** `restart` is a roll in restart mode: no pull, no build. */
  readonly action: 'roll' | 'restart';
  readonly wait: boolean;
  readonly json: boolean;
  readonly reason: string | null;
  readonly timeoutMs: number;
}

export type ServiceCliParse =
  | { readonly ok: true; readonly options: ServiceCliOptions }
  | { readonly ok: false; readonly error: string; readonly help: boolean };

export function parseServiceArgs(argv: readonly string[]): ServiceCliParse {
  const args = [...argv];
  if (args.length === 0) {
    return { ok: false, error: 'missing command', help: true };
  }
  if (args[0] === '-h' || args[0] === '--help') {
    return { ok: false, error: '', help: true };
  }
  const action = args[0];
  if (action !== 'roll' && action !== 'restart') {
    return { ok: false, error: `unknown command: ${action}`, help: true };
  }
  args.shift();
  let wait = true;
  let json = false;
  let reason: string | null = null;
  let timeoutMs = DEFAULT_FOLLOW_TIMEOUT_MS;
  while (args.length > 0) {
    const arg = args.shift() as string;
    if (arg === '--no-wait') wait = false;
    else if (arg === '--json') json = true;
    else if (arg === '--reason') {
      const value = args.shift();
      if (value === undefined || value.trim() === '') {
        return { ok: false, error: '--reason requires a non-empty value', help: false };
      }
      reason = value.trim();
    } else if (arg === '--timeout-ms') {
      const value = Number(args.shift());
      if (!Number.isInteger(value) || value < 1_000) {
        return { ok: false, error: '--timeout-ms requires an integer >= 1000', help: false };
      }
      timeoutMs = value;
    } else if (arg === '-h' || arg === '--help') {
      return { ok: false, error: '', help: true };
    } else {
      return { ok: false, error: `unknown argument: ${arg}`, help: true };
    }
  }
  return { ok: true, options: { action, wait, json, reason, timeoutMs } };
}

/** Host to DIAL (a wildcard bind is dialed on loopback). */
export function dialHost(host: string): string {
  if (host === '0.0.0.0' || host === '*') return '127.0.0.1';
  if (host === '::' || host === '0:0:0:0:0:0:0:0') return '[::1]';
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
  return host;
}

export function serviceBaseUrl(config: GruCommandConfig): string {
  return `http://${dialHost(config.server.host)}:${config.server.port}`;
}

export interface ServiceCliDeps {
  readonly loadConfig: () => GruCommandConfig;
  readonly fetchFn: typeof fetch;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  /** Listener ownership probe (owner incident 2026-09-23): after a roll
   * reports done, the /health answer is only trusted when the port's
   * listener is the adopted process (pid match), never a squatter. */
  readonly probeListeners: ListenerProbe;
  /** The deploy clone's install.sh (update, stop, start, restart --now). */
  readonly runInstaller: InstallerRunner;
  /** `tail` for `gru logs`. */
  readonly runTail: (args: readonly string[]) => number;
  /** The installed (on-disk) build stamp, for `gru status`. */
  readonly installedBuild: () => BuildInfo;
}

function defaultDeps(): ServiceCliDeps {
  return {
    runInstaller: installerRunnerFor(defaultPackageRoot()),
    runTail: defaultTail,
    installedBuild: readBuildInfo,
    loadConfig: () => loadConfig(),
    fetchFn: (input, init) => fetch(input, init),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    sleep: (ms) => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); }),
    now: Date.now,
    probeListeners: (host, port) => defaultListenerProbe(host, port),
  };
}

interface RollApiBody {
  readonly roll?: RollState | null;
  readonly status?: string;
  readonly error?: string;
  readonly detail?: string;
}

function phaseLine(state: RollState): string {
  switch (state.phase) {
    case 'preflight':
      return state.mode === 'restart'
        ? 'preflight: checking the installed build (restart: no pull, no build)…'
        : 'preflight: pulling and rebuilding the deploy clone (old build keeps serving)…';
    case 'drain': {
      const inFlight = state.drain?.inFlightAtStart.length ?? 0;
      return inFlight > 0
        ? `drain: waiting for ${inFlight} in-flight item(s) to settle…`
        : 'drain: waiting for in-flight work to settle…';
    }
    case 'swap':
      return 'swap: marker written — exiting for the supervised relaunch…';
    case 'done':
      return 'done: the relaunched service adopted the roll.';
    case 'verify':
      return 'verify: the relaunched service is checking its build…';
    case 'failed':
      return `failed: ${state.error?.detail ?? 'unknown error'}`;
    default:
      return state.phase;
  }
}

export async function runServiceCli(
  argv: readonly string[],
  overrides: Partial<ServiceCliDeps> & { readonly reset?: Partial<ResetCliDeps>; readonly build?: () => BuildInfo } = {},
): Promise<number> {
  if (argv[0] === 'version' || argv[0] === '--version' || argv[0] === '-v') {
    return runVersionCli(argv.slice(1), {
      stdout: overrides.stdout ?? ((line) => process.stdout.write(`${line}\n`)),
      stderr: overrides.stderr ?? ((line) => process.stderr.write(`${line}\n`)),
      build: overrides.build ?? readBuildInfo,
    });
  }
  if (argv[0] === 'reset') {
    // The seams both commands share pass through; `reset` holds reset's own.
    const { loadConfig: load, fetchFn, stdout, stderr, probeListeners, reset } = overrides;
    const shared = Object.fromEntries(Object.entries({ loadConfig: load, fetchFn, stdout, stderr, probeListeners }).filter(([, value]) => value !== undefined));
    return runResetCli(argv.slice(1), { ...shared, ...reset });
  }
  const deps: ServiceCliDeps = { ...defaultDeps(), ...overrides };
  const command = argv[0];
  if (isInstallerCommand(command)) return runInstallerCli(command, argv.slice(1), deps);
  if (command === 'restart' && argv.includes('--now')) return runRestartNowCli(argv.slice(1), deps);
  if (command === 'status') return runStatusCli(argv.slice(1), { ...deps, baseUrl: serviceBaseUrl });
  if (command === 'logs') return runLogsCli(argv.slice(1), deps);
  const parsed = parseServiceArgs(argv);
  if (!parsed.ok) {
    if (parsed.error !== '') deps.stderr(`gru: ${parsed.error}`);
    if (parsed.help) deps.stderr(USAGE.trimEnd());
    return parsed.help && parsed.error === '' ? 0 : 2;
  }
  const options = parsed.options;

  let config: GruCommandConfig;
  try {
    config = deps.loadConfig();
  } catch (error) {
    deps.stderr(`gru: cannot load instance config: ${String((error as Error).message)}`);
    return 1;
  }
  if (config.server.port === 0) {
    deps.stderr('gru: the instance binds an ephemeral port; run the roll from the service side (POST /api/roll)');
    return 1;
  }
  const base = serviceBaseUrl(config);
  const headers = {
    authorization: `Bearer ${config.auth.token}`,
    'content-type': 'application/json',
  };

  const emit = (event: string, state: RollState | null): void => {
    if (options.json) {
      deps.stdout(JSON.stringify({ event, roll: state }));
    } else if (state !== null) {
      deps.stdout(`roll ${state.rollId}: ${phaseLine(state)}`);
    }
  };

  // --- trigger -----------------------------------------------------------
  let state: RollState | null = null;
  let res: Response;
  try {
    res = await deps.fetchFn(`${base}/api/roll`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requested_by: 'gru-service-cli',
        ...(options.reason !== null ? { reason: options.reason } : {}),
        ...(options.action === 'restart' ? { mode: 'restart' } : {}),
      }),
    });
  } catch (error) {
    deps.stderr(
      `gru: service unreachable at ${base} (${String((error as Error).message)}) — ` +
        'the self-roll requires the running OS service',
    );
    return 1;
  }
  let body: RollApiBody;
  try {
    body = (await res.json()) as RollApiBody;
  } catch {
    body = {};
  }
  if (res.status === 202) {
    state = body.roll ?? null;
    emit('accepted', state);
  } else if (res.status === 409) {
    state = body.roll ?? null;
    if (!options.json) deps.stdout('a roll is already in progress — attaching to it');
    emit('attached', state);
  } else {
    deps.stderr(
      `gru: roll refused (HTTP ${res.status}): ${body.detail ?? body.error ?? 'unknown error'}`,
    );
    return 1;
  }
  if (!options.wait) return 0;

  // --- follow ------------------------------------------------------------
  const deadline = deps.now() + options.timeoutMs;
  let lastPhase: string | null = null;
  let healthDeadline: number | null = null;
  for (;;) {
    if (deps.now() > deadline) {
      deps.stderr(
        `gru: roll did not complete within ${options.timeoutMs} ms ` +
          `(last phase: ${state?.phase ?? 'unknown'}, last error: ${state?.error?.detail ?? 'none'})`,
      );
      bailHint(deps.stderr, state);
      return 1;
    }
    if (state !== null && state.phase !== lastPhase) {
      if (state.phase === 'failed') emit('failed', state);
      else if (lastPhase !== null || state.phase !== 'preflight') emit('phase', state);
      lastPhase = state.phase;
    }
    if (state !== null && state.phase === 'failed') {
      return 1;
    }
    if (state !== null && state.phase === 'done') {
      healthDeadline ??= deps.now() + HEALTH_VERIFY_TIMEOUT_MS;
    }
    // Verify against /health once the record says done (the relaunched
    // process may still be binding its socket).
    const expectedSha = state?.toSha ?? null;
    if (state !== null && state.phase === 'done' && healthDeadline !== null) {
      const health = await readHealthSha(deps, base, config);
      if (health !== undefined && expectedSha !== null && health === expectedSha) {
        // The /health build matches — but WHO answered? (owner incident
        // 2026-09-23): require the port's listener to be the adopted
        // process. A foreign pid means the squatter may have answered; a
        // 200 alone is never read as success.
        const foreign = await foreignHealthListener(deps, config, state);
        if (foreign !== null) {
          deps.stderr(
            `gru: /health reports the target build but the listener on ` +
              `${dialHost(config.server.host)}:${config.server.port} is pid ${foreign.pid}` +
              `${foreign.command === '' ? '' : ` (${foreign.command})`}, not the relaunched service ` +
              `(pid ${state.verify?.pid ?? 'unknown'}) — a foreign listener answered. ` +
              `Action required: stop the squatter process and re-run gru ${options.action}.`,
          );
          bailHint(deps.stderr, state);
          return 1;
        }
        if (options.json) {
          deps.stdout(JSON.stringify({ event: 'verified', roll: state, build_sha: health }));
        } else if (state.mode === 'restart') {
          deps.stdout(`restarted on build ${state.toSha} (verified on /health)`);
        } else {
          deps.stdout(`rolled ${state.fromSha ?? 'unknown'} → ${state.toSha} (verified on /health)`);
        }
        return 0;
      }
      if (deps.now() > healthDeadline) {
        deps.stderr(
          `gru: roll record is done but /health does not report the target build ` +
            `(expected ${expectedSha ?? 'unknown'}, got ${health ?? 'unreachable'})`,
        );
        bailHint(deps.stderr, state);
        return 1;
      }
    }
    await deps.sleep(POLL_INTERVAL_MS);
    try {
      const poll = await deps.fetchFn(`${base}/api/roll`, { method: 'GET', headers });
      if (poll.status === 200) {
        const polled = ((await poll.json()) as RollApiBody).roll ?? null;
        if (polled !== null) state = polled;
      }
    } catch {
      // The service is down between swap and relaunch — expected; keep
      // polling until the deadline distinguishes relaunch from stillborn.
    }
  }
}

async function readHealthSha(
  deps: ServiceCliDeps,
  base: string,
  config: GruCommandConfig,
): Promise<string | null | undefined> {
  try {
    const res = await deps.fetchFn(`${base}/health`, {
      method: 'GET',
      headers: { authorization: `Bearer ${config.auth.token}` },
    });
    if (res.status !== 200) return undefined;
    const body = (await res.json()) as { build?: { rev?: unknown } };
    const rev = body.build?.rev;
    return typeof rev === 'string' ? rev : null;
  } catch {
    return undefined;
  }
}

/**
 * The listener on the instance port when it is NOT the adopted process —
 * the `/health` 200 of a squatter must never read as a verified roll.
 * Returns null when the record carries no pid, nobody listens, or the
 * platform has no probe (the build-sha match then stands as before).
 */
async function foreignHealthListener(
  deps: ServiceCliDeps,
  config: GruCommandConfig,
  state: RollState,
): Promise<ListenerOwner | null> {
  const verifyPid = state.verify?.pid;
  if (typeof verifyPid !== 'number') return null;
  const owners = await deps.probeListeners(dialHost(config.server.host), config.server.port);
  if (owners === null) return null;
  return owners.find((owner) => owner.pid !== verifyPid) ?? null;
}

/** Rollback safety: no auto-rollback v1 — the old dist is git; name the bail. */
function bailHint(stderr: (line: string) => void, state: RollState | null): void {
  const root = state?.repoRoot ?? '<deploy clone>';
  stderr(
    `bail: the swap marker is the only handoff state — to return the service, restore the ` +
      `checkout, rebuild (npm ci && npm run build && npm run build:web in ${root}), and ` +
      'restart the unit (gru restart --now)',
  );
}

function sameFileAfterRealpath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b;
  }
}

const invokedAsCli =
  process.argv[1] !== undefined &&
  sameFileAfterRealpath(resolve(process.argv[1]), fileURLToPath(import.meta.url));

if (invokedAsCli) {
  runServiceCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`gru: ${String((error as Error).message)}\n`);
      process.exit(1);
    });
}
