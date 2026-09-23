#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type GruCommandConfig } from '../config.js';
import type { RollState } from '../roll/state.js';

/**
 * `gru-service` — the operator CLI for the service's own lifecycle.
 *
 *   gru-service roll [--no-wait] [--json] [--reason <text>] [--timeout-ms <n>]
 *
 * The command asks the running service to roll itself (POST /api/roll,
 * operator-guarded with the pairing token) and — unless --no-wait —
 * follows the roll record until the relaunched service reports the target
 * build SHA on /health. An accepted roll always completes the service-side
 * handoff even if this CLI is interrupted: exit 75 signals the OS service
 * manager to relaunch the unit.
 */

const DEFAULT_FOLLOW_TIMEOUT_MS = 30 * 60_000;
const POLL_INTERVAL_MS = 2_000;
const HEALTH_VERIFY_TIMEOUT_MS = 60_000;

const USAGE = `usage: gru-service roll [--no-wait] [--json] [--reason <text>] [--timeout-ms <n>]

  roll   pull + rebuild the deploy clone on the running service, drain
         in-flight work, then let the OS service manager relaunch it into
         the new build. Exit 0 only after /health reports the target SHA.
`;

export interface ServiceCliOptions {
  readonly action: 'roll';
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
  if (args[0] !== 'roll') {
    return { ok: false, error: `unknown command: ${args[0]}`, help: true };
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
  return { ok: true, options: { action: 'roll', wait, json, reason, timeoutMs } };
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
}

function defaultDeps(): ServiceCliDeps {
  return {
    loadConfig: () => loadConfig(),
    fetchFn: (input, init) => fetch(input, init),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    sleep: (ms) => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); }),
    now: Date.now,
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
      return 'preflight: pulling and rebuilding the deploy clone (old build keeps serving)…';
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
  overrides: Partial<ServiceCliDeps> = {},
): Promise<number> {
  const deps: ServiceCliDeps = { ...defaultDeps(), ...overrides };
  const parsed = parseServiceArgs(argv);
  if (!parsed.ok) {
    if (parsed.error !== '') deps.stderr(`gru-service: ${parsed.error}`);
    if (parsed.help) deps.stderr(USAGE.trimEnd());
    return parsed.help && parsed.error === '' ? 0 : 2;
  }
  const options = parsed.options;

  let config: GruCommandConfig;
  try {
    config = deps.loadConfig();
  } catch (error) {
    deps.stderr(`gru-service: cannot load instance config: ${String((error as Error).message)}`);
    return 1;
  }
  if (config.server.port === 0) {
    deps.stderr('gru-service: the instance binds an ephemeral port; run the roll from the service side (POST /api/roll)');
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
      }),
    });
  } catch (error) {
    deps.stderr(
      `gru-service: service unreachable at ${base} (${String((error as Error).message)}) — ` +
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
      `gru-service: roll refused (HTTP ${res.status}): ${body.detail ?? body.error ?? 'unknown error'}`,
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
        `gru-service: roll did not complete within ${options.timeoutMs} ms ` +
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
        if (options.json) {
          deps.stdout(JSON.stringify({ event: 'verified', roll: state, build_sha: health }));
        } else {
          deps.stdout(`rolled ${state.fromSha ?? 'unknown'} → ${state.toSha} (verified on /health)`);
        }
        return 0;
      }
      if (deps.now() > healthDeadline) {
        deps.stderr(
          `gru-service: roll record is done but /health does not report the target build ` +
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

/** Rollback safety: no auto-rollback v1 — the old dist is git; name the bail. */
function bailHint(stderr: (line: string) => void, state: RollState | null): void {
  const root = state?.repoRoot ?? '<deploy clone>';
  stderr(
    `bail: the swap marker is the only handoff state — to return the service, restore the ` +
      `checkout, rebuild (npm ci && npm run build && npm run build:web in ${root}), and ` +
      'restart the unit (launchctl kickstart -k gui/$(id -u)/com.gru-command.service | systemctl --user restart gru-command)',
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
      process.stderr.write(`gru-service: ${String((error as Error).message)}\n`);
      process.exit(1);
    });
}
