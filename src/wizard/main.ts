#!/usr/bin/env node
/**
 * Gru Command setup wizard (E9; SPEC ruling 14).
 *
 * Interactive by default (plain readline — every question has a default),
 * non-interactive with `--answers '<json>'` (unspecified = defaults, so
 * `'{}'` completes headlessly). Pipeline: runtime probe (warn-and-proceed
 * when no runtime CLI is found) → workspace root → managed-repo pick →
 * runtime/model/thinking picks ("default" sentinel, ruling 16) → bind
 * host → token → config write (timestamped backup first) → first-boot
 * smoke (spawn dist/main.js, poll /health for the 3 liveness signals +
 * identity fingerprint, clean shutdown) → terminal pairing QR
 * (byte-identical payload shape to the web pairing screen; the smoke's
 * discovered port when ephemeral) → optional OS-service registration
 * (install.sh --service — one mechanism, only after a green smoke).
 */

import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as QRCode from 'qrcode';
import { instanceDirFromEnv, RUNTIME_IDS } from '../config.js';
import { probeRuntimes, type RuntimeProbeResult } from '../runtime/probe.js';
import {
  AnswersError,
  generateToken,
  parseAnswers,
  validateHost,
  validateWorkspaceRoot,
  type WizardAnswers,
} from './answers.js';
import {
  buildQrPayload,
  discoverManagedRepos,
  writeInstanceConfig,
} from './steps.js';

const WIZARD_USAGE = 'usage: node dist/wizard/main.js [--answers <json>]';

function fail(message: string, code = 1): never {
  process.stderr.write(`wizard: ${message}\n`);
  process.exit(code);
}

/** The repo root = two levels up from dist/wizard/main.js. */
function repoRootFrom(importMetaUrl: string): string {
  return resolve(dirname(fileURLToPath(importMetaUrl)), '..', '..');
}

function printProbe(results: readonly RuntimeProbeResult[]): void {
  stdout.write('\nRuntime probe:\n');
  for (const result of results) {
    const where = result.installed
      ? `installed ${result.version ?? result.versionRaw ?? '?'} (${result.path})`
      : 'not found';
    stdout.write(`  ${result.id.padEnd(12)} ${where}\n`);
  }
  if (!results.some((result) => result.installed)) {
    stdout.write(
      '\n⚠ No runtime CLI found (pi / claude). You can proceed — the wizard\n' +
      '  writes the config anyway, and adapters fail LOUD at spawn time until\n' +
      '  you install one.\n',
    );
  }
}

/** Default runtime pick: first installed probe (pi preferred), else "pi". */
function defaultRuntimeId(results: readonly RuntimeProbeResult[]): string {
  const installed = results.find((result) => result.installed);
  return installed !== undefined ? installed.id : 'pi';
}

async function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return (await rl.question(question)).trim();
}

async function interactiveAnswers(
  probe: readonly RuntimeProbeResult[],
  repoRoot: string,
): Promise<WizardAnswers> {
  // The piped one-liner re-execs this wizard on an EXHAUSTED pipe: readline
  // would wait on an EOF'd stdin forever. Interactive mode needs a TTY;
  // anything else must say so loud and point at --answers.
  if (stdin.isTTY !== true) {
    fail(
      'no terminal for interactive setup (stdin is not a TTY — a piped\n' +
        'install cannot ask questions). Finish setup in a terminal:\n' +
        `  bash ${repoRoot}/install.sh\n` +
        "or run non-interactively with --answers '<json>'",
      2,
    );
  }
  const rl = createInterface({ input: stdin, output: stdout });

  stdout.write('\nGru Command setup — press Enter to accept every [default].\n');

  // Workspace root (ruling 6: config, never hardcoded).
  let workspaceRoot = '~/code';
  for (;;) {
    const answer = await ask(rl, '\nWorkspace root (holds ONLY your managed repos) [~/code]: ');
    workspaceRoot = answer === '' ? '~/code' : answer;
    try {
      validateWorkspaceRoot(workspaceRoot);
      break;
    } catch (error) {
      stdout.write(`  ✗ ${(error as Error).message}\n`);
    }
  }

  // Managed-repo multi-pick: scan for .git; default = all found. The pick
  // is informational (the config schema has no repos key — the board
  // discovers repos live); it exists to show the user what will land on
  // their board.
  const found = discoverManagedRepos(workspaceRoot.replace(/^~(?=\/|$)/, homedir()));
  let repos: string[] = [];
  if (found.length > 0) {
    stdout.write('\nRepos under the workspace root:\n');
    found.forEach((name, index) => stdout.write(`  ${index + 1}. ${name}\n`));
    for (;;) {
      const answer = await ask(
        rl,
        `Managed repos — comma-separated numbers or names [all ${found.length}]: `,
      );
      if (answer === '') {
        repos = [...found];
        break;
      }
      const picks = answer.split(',').map((part) => part.trim()).filter((part) => part !== '');
      const resolved: string[] = [];
      let bad: string | null = null;
      for (const pick of picks) {
        const byIndex = /^\d+$/.test(pick) ? found[Number(pick) - 1] : undefined;
        const name = byIndex ?? pick;
        if (!found.includes(name)) bad = pick;
        else if (!resolved.includes(name)) resolved.push(name);
      }
      if (bad !== null) {
        stdout.write(`  ✗ not a discovered repo: ${bad}\n`);
        continue;
      }
      repos = resolved;
      break;
    }
  } else {
    stdout.write(
      `\nNo git repos found under ${workspaceRoot} yet — the board will be empty\n` +
      'until you add repos there.\n',
    );
  }

  // Runtime / model / thinking (ruling 16: the "default" sentinel is the
  // recommended pick — the product never hardcodes a model).
  const runtimeDefault = defaultRuntimeId(probe);
  let runtime = runtimeDefault;
  for (;;) {
    const answer = await ask(
      rl,
      `\nDefault runtime — ${RUNTIME_IDS.join(' | ')} [${runtimeDefault}]: `,
    );
    runtime = answer === '' ? runtimeDefault : answer;
    if ((RUNTIME_IDS as readonly string[]).includes(runtime)) break;
    stdout.write(`  ✗ valid runtimes: ${RUNTIME_IDS.join(', ')}\n`);
  }

  const model =
    (await ask(
      rl,
      '\nModel reference — Enter = the runtime\'s own configured model ("default")\n  [default]: ',
    )) || 'default';
  const thinkingLevel =
    (await ask(
      rl,
      "\nThinking level — Enter = the runtime's own (\"default\")\n  [default]: ",
    )) || 'default';

  let host = '127.0.0.1';
  for (;;) {
    const answer = await ask(rl, '\nBind host — your LAN address to pair a phone [127.0.0.1]: ');
    host = answer === '' ? '127.0.0.1' : answer;
    try {
      validateHost(host); // same rule as --answers — invalid input retries, never aborts the run (Perkins r2 H1)
      break;
    } catch (error) {
      stdout.write(`  ✗ ${(error as Error).message}\n`);
    }
  }

  let port = 7665;
  for (;;) {
    const answer = await ask(rl, 'Bind port (0 = ephemeral) [7665]: ');
    if (answer === '') break;
    const parsed = Number(answer);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
      port = parsed;
      break;
    }
    stdout.write('  ✗ port must be an integer 0–65535\n');
  }

  const generated = generateToken();
  const tokenAnswer = await ask(rl, `\nPairing token [${generated}]: `);
  const token = tokenAnswer === '' ? generated : tokenAnswer;

  const registerAnswer =
    (await ask(rl, '\nRegister the OS service (launchd/systemd, starts at login)? [y/N]: ')).toLowerCase();
  const registerService = registerAnswer === 'y' || registerAnswer === 'yes';

  const smokeAnswer =
    (await ask(rl, 'Run the first-boot smoke test now? [Y/n]: ')).toLowerCase();
  const smoke = smokeAnswer !== 'n' && smokeAnswer !== 'no';

  rl.close();
  return parseAnswers(
    JSON.stringify({
      workspace_root: workspaceRoot,
      repos,
      runtime,
      model,
      thinking_level: thinkingLevel,
      host,
      port,
      token,
      register_service: registerService,
      smoke,
    }),
  );
}

// ---------------------------------------------------------------------------
// First-boot smoke: spawn dist/main.js, poll /health for the 3-signal
// liveness + identity fingerprint, then a clean SIGTERM shutdown. A
// timeout fails loud naming the signal that never came.
// ---------------------------------------------------------------------------

interface SmokeOutcome {
  readonly port: number;
  readonly installId: string;
}

/** Last ~2 KB of captured stderr — the tail carries the actual crash. */
function stderrTail(stderrText: string): string {
  return stderrText.slice(-2_000);
}

/** Extract the listening port from the service's JSON log stream. */
export function parseListeningPort(stderrText: string): number | null {
  for (const line of stderrText.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const record = JSON.parse(line) as { msg?: string; port?: unknown };
      if (record.msg === 'listening' && typeof record.port === 'number') {
        return record.port;
      }
    } catch {
      /* not a JSON line — ignore */
    }
  }
  return null;
}

/** Bracket-wrap a bare IPv6 literal for a URL host ([::1]); IPv4 and
 * hostnames pass through unchanged — an unbracketed IPv6 host makes
 * fetch() throw on every iteration. */
export function formatHostForUrl(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** Pre-flight port check (Perkins r2 H2): who holds host:port? Returns
 * 'unknown' when something accepts the connection, null when nothing
 * listens (free), never hangs (short timeout). */
export async function findPortHolder(host: string, port: number): Promise<string | null> {
  const { createConnection } = await import('node:net');
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (value: string | null): void => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1_500, () => done('unknown'));
    socket.on('connect', () => done(socket.remoteAddress ?? 'unknown'));
    socket.on('error', () => done(null)); // ECONNREFUSED etc. — the port is free
  });
}

async function fetchHealth(
  host: string,
  port: number,
  timeoutMs: number,
  token: string,
  /** Returns a named death message when the child is gone, else null —
   * a service that dies mid-poll must fail loud, not poll to timeout. */
  describeDeath: () => string | null = () => null,
): Promise<unknown | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(
        `http://${formatHostForUrl(host === '0.0.0.0' ? '127.0.0.1' : host)}:${port}/health`,
        {
          signal: AbortSignal.timeout(2_000),
          // W-C: the FULL smoke oracle (identity + all three signals)
          // lives behind the pairing token the wizard itself just wrote.
          headers: { authorization: `Bearer ${token}` },
        },
      );
      if (res.ok) return (await res.json()) as unknown;
    } catch {
      /* not up yet */
    }
    const death = describeDeath();
    if (death !== null) throw new Error(death);
    if (Date.now() > deadline) return null;
    await new Promise((wake) => setTimeout(wake, 250));
  }
}

interface HealthShape {
  identity?: { install_id?: unknown };
  liveness?: {
    signals?: {
      health_reachable?: { value?: unknown };
      agent_session?: { state?: unknown };
      session_growth?: { value?: unknown };
    };
  };
}

export async function runFirstBootSmoke(options: {
  repoRoot: string;
  instanceDir: string;
  host: string;
  port: number;
  timeoutMs?: number;
  /** Pairing token (W-C): the full oracle rides the authed surface. */
  token: string;
}): Promise<SmokeOutcome> {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const distMain = join(options.repoRoot, 'dist', 'main.js');
  const child = spawn(process.execPath, [distMain], {
    env: { ...process.env, GRU_COMMAND_HOME: options.instanceDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf-8');
  });
  const kill = (): void => {
    if (child.exitCode === null) child.kill('SIGKILL');
  };
  // A child is dead when it exited (code) OR was killed (signal) — either
  // means the service is gone; polling further would only ever time out.
  const isDead = (): boolean => child.exitCode !== null || child.signalCode !== null;
  const describeDeath = (): string | null =>
    isDead()
      ? `first-boot smoke: the service exited during /health polling (exit code ${child.exitCode}, signal ${child.signalCode ?? 'none'}) — stderr:\n${stderrTail(stderr)}`
      : null;

  try {
    // Resolve the port: fixed when configured, parsed from the listening
    // log line when ephemeral (port 0).
    let port = options.port;
    if (port === 0) {
      const deadline = Date.now() + timeoutMs;
      while (port === 0) {
        port = parseListeningPort(stderr) ?? 0;
        if (port !== 0) break;
        if (isDead()) {
          throw new Error(
            `first-boot smoke: the service exited before listening (exit code ${child.exitCode}, signal ${child.signalCode ?? 'none'}) — stderr:\n${stderrTail(stderr)}`,
          );
        }
        if (Date.now() > deadline) {
          throw new Error(`first-boot smoke: the 'listening' signal never came within ${timeoutMs}ms`);
        }
        await new Promise((wake) => setTimeout(wake, 200));
      }
    }

    const health = (await fetchHealth(
      options.host,
      port,
      timeoutMs,
      options.token,
      describeDeath,
    )) as HealthShape | null;
    if (health === null) {
      throw new Error(
        `first-boot smoke: the 'health_reachable' signal never came within ${timeoutMs}ms (http://${formatHostForUrl(options.host)}:${port}/health)`,
      );
    }
    const signals = health.liveness?.signals;
    if (signals?.health_reachable?.value !== true) {
      throw new Error("first-boot smoke: liveness signal 'health_reachable' never reported true");
    }
    if (typeof signals?.agent_session?.state !== 'string') {
      throw new Error("first-boot smoke: liveness signal 'agent_session' never reported a state");
    }
    if (signals?.session_growth?.value === undefined) {
      throw new Error("first-boot smoke: liveness signal 'session_growth' never reported");
    }
    const installId = health.identity?.install_id;
    if (typeof installId !== 'string' || installId === '') {
      throw new Error('first-boot smoke: the identity fingerprint never reported');
    }

    // Clean shutdown (graceful path, exit 0 — the same contract the OS
    // service relies on).
    const exitCode = await new Promise<number | null>((resolveExit) => {
      child.on('exit', (code) => resolveExit(code));
      child.kill('SIGTERM');
      setTimeout(() => kill(), 10_000).unref?.();
    });
    if (exitCode !== 0) {
      throw new Error(`first-boot smoke: clean shutdown never happened (exit code ${exitCode})`);
    }
    return { port, installId };
  } catch (error) {
    kill();
    if (child.exitCode === null) {
      await new Promise<void>((done) => {
        child.on('exit', () => done());
        setTimeout(done, 2_000).unref?.();
      });
    }
    throw error as Error;
  }
}

// ---------------------------------------------------------------------------

async function main(argv: readonly string[]): Promise<number> {
  let answersJson: string | null = null;
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === undefined) break;
    if (arg === '--answers') {
      const value = rest.shift();
      if (value === undefined) fail('--answers requires a JSON argument\n' + WIZARD_USAGE, 2);
      answersJson = value;
    } else {
      fail(`unknown argument: ${arg}\n${WIZARD_USAGE}`, 2);
    }
  }

  let instanceDir: string;
  try {
    instanceDir = instanceDirFromEnv();
  } catch (error) {
    fail((error as Error).message);
  }
  if (!isAbsolute(instanceDir)) fail(`instance dir must be absolute: ${instanceDir}`);

  const repoRoot = repoRootFrom(import.meta.url);

  stdout.write('Gru Command setup wizard\n=========================');
  const probe = probeRuntimes();
  printProbe(probe);

  let answers: WizardAnswers;
  if (answersJson !== null) {
    try {
      answers = parseAnswers(answersJson);
    } catch (error) {
      if (error instanceof AnswersError) {
        fail(String(error.message), 1); // nothing written — by construction
      }
      throw error;
    }
    stdout.write('\nNon-interactive mode (answers applied; unspecified = defaults).\n');
  } else {
    answers = await interactiveAnswers(probe, repoRoot);
  }

  stdout.write(`\nManaged repos (board grouping): ${answers.repos.length > 0 ? answers.repos.join(', ') : '(none yet)'}\n`);

  // Pre-flight port check (Perkins r2 H2): a fixed port already held by
  // the still-running OLD service would fail the smoke AFTER the new
  // config is written — half-installed. Stop-before-rerun guidance first.
  if (answers.port !== 0) {
    const holder = await findPortHolder(answers.host, answers.port);
    if (holder !== null) {
      fail(
        `port ${answers.port} on ${answers.host} is already in use — if the previous\n` +
          '  service still runs, stop it first (./install.sh --uninstall, or\n' +
          '  systemctl --user stop gru-command / launchctl unload …), then re-run.\n' +
          `  (listener detected${holder === 'unknown' ? '' : ` at ${holder}`})`,
      );
    }
  }

  const { configPath, backupPath } = writeInstanceConfig(instanceDir, answers);
  stdout.write(`\nWrote ${configPath}\n`);
  if (backupPath !== null) stdout.write(`Previous config backed up: ${backupPath}\n`);

  // First-boot smoke BEFORE anything registers a service: a failed smoke
  // must not leave a broken unit behind, and a registered fixed-port
  // service would make the smoke's spawn hit EADDRINUSE.
  let smokePort: number | null = null;
  if (answers.smoke) {
    stdout.write('\nFirst-boot smoke: spawning the service and polling /health…\n');
    try {
      const outcome = await runFirstBootSmoke({
        repoRoot,
        instanceDir,
        host: answers.host,
        port: answers.port,
        token: answers.token,
      });
      smokePort = outcome.port;
      stdout.write(
        `Smoke green: 3-signal liveness + fingerprint ${outcome.installId} on port ${outcome.port}, clean shutdown.\n`,
      );
    } catch (error) {
      fail(String((error as Error).message));
    }
  }

  // Terminal pairing QR — same payload shape the web pairing screen
  // encodes ({"gru-command":1,url,token}); scan it from the phone. With
  // port 0 the URL is only useful AFTER the smoke discovered the real
  // port (and it changes on every boot — say so).
  const displayPort = answers.port === 0 ? (smokePort ?? 0) : answers.port;
  const url = `http://${formatHostForUrl(answers.host)}:${displayPort}`;
  stdout.write(`\nPairing QR (payload ${buildQrPayload(url, answers.token)}):\n`);
  try {
    stdout.write(
      await QRCode.toString(buildQrPayload(url, answers.token), {
        type: 'terminal',
        small: true,
      }),
    );
  } catch {
    stdout.write('(terminal QR unavailable — pair by opening the web UI and typing the token)\n');
  }
  stdout.write(`Pair at ${url} (token: ${answers.token})\n`);
  if (answers.port === 0) {
    stdout.write(
      `Note: port 0 = ephemeral — the port changes each boot ${
        smokePort !== null
          ? '(this one is from the smoke run)'
          : '(the smoke did not run — no port discovered)'
      }; set a fixed [server] port in config.toml for a stable pairing URL.\n`,
    );
  }
  if (answers.host === '127.0.0.1') {
    stdout.write('Loopback-bound: to pair a phone, re-run and bind your LAN address.\n');
  }

  if (answers.registerService) {
    stdout.write('\nRegistering the OS service (install.sh --service)…\n');
    const result = spawnSync('bash', [join(repoRoot, 'install.sh'), '--service'], {
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      fail(`service registration failed (exit ${result.status ?? 'signal'})`);
    }
  }

  stdout.write('\nSetup complete. Start the service: node dist/main.js (or ./install.sh --service).\n');
  return 0;
}

// ESM main guard: run as a CLI (`node dist/wizard/main.js`), stay
// importable under test (vitest's argv[1] is the runner, not this file).
// Compare through realpathSync on BOTH sides: on macOS an absolute
// argv[1] under /var/… resolves against a file:// URL under
// /private/var/… — a raw string compare silently no-ops the wizard.
function sameFileAfterRealpath(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return a === b; // one side vanished — fall back to the raw compare
  }
}
const invokedAsCli =
  process.argv[1] !== undefined &&
  sameFileAfterRealpath(resolve(process.argv[1]), fileURLToPath(import.meta.url));

if (invokedAsCli) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`wizard: fatal: ${String(error)}\n`);
      process.exit(1);
    });
}
