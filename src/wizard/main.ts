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
import { stdout } from 'node:process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { existsSync, openSync, realpathSync } from 'node:fs';
import { ReadStream, WriteStream } from 'node:tty';
import { fileURLToPath } from 'node:url';
import * as QRCode from 'qrcode';
import { configPathFor, expandTilde, instanceDirFromEnv, RUNTIME_IDS } from '../config.js';
import { probeRuntimes, type RuntimeProbeResult } from '../runtime/probe.js';
import {
  AnswersError,
  generateToken,
  parseAnswers,
  resolveBindHost,
  validateWorkspaceRoot,
  type WizardAnswers,
} from './answers.js';
import {
  buildQrPayload,
  discoverManagedRepos,
  generateConfigToml,
  loadExistingInstanceConfig,
  seedAnswersFromConfig,
  writeConfigText,
} from './steps.js';
import { onboardBmadRepo } from './bmad-onboarding.js';

const WIZARD_USAGE =
  'usage: node dist/wizard/main.js [--no-interact] [--answers <json>] [--force]';

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

interface WizardTerminal {
  readonly input: ReadStream;
  readonly output: WriteStream;
}

function openWizardTerminal(repoRoot: string): WizardTerminal {
  if (process.env.GRU_COMMAND_TEST_NO_TTY === '1') {
    fail(
      'no controlling terminal for interactive setup (/dev/tty is unavailable).\n' +
        `Run in a terminal: bash ${repoRoot}/install.sh\n` +
        "or use explicit defaults: bash install.sh --no-interact [--answers '<json>']",
      2,
    );
  }
  try {
    return {
      input: new ReadStream(openSync('/dev/tty', 'r')),
      output: new WriteStream(openSync('/dev/tty', 'w')),
    };
  } catch {
    fail(
      'no controlling terminal for interactive setup (/dev/tty is unavailable).\n' +
        `Run in a terminal: bash ${repoRoot}/install.sh\n` +
        "or use explicit defaults: bash install.sh --no-interact [--answers '<json>']",
      2,
    );
  }
}

async function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return (await rl.question(question)).trim();
}

function yn(value: string): boolean {
  return value.toLowerCase() === 'y' || value.toLowerCase() === 'yes';
}

async function interactiveAnswers(
  probe: readonly RuntimeProbeResult[],
  terminal: WizardTerminal,
  prior: ReturnType<typeof loadExistingInstanceConfig>,
): Promise<WizardAnswers> {
  const rl = createInterface({ input: terminal.input, output: terminal.output });
  const out = terminal.output;
  out.write('\nGru Command setup — press Enter to accept every [default].\n');
  if (prior !== null) {
    out.write(
      `\nExisting config found — Enter keeps its values (round-trip; a timestamped\n` +
        `  backup is written before any rewrite).\n`,
    );
  }

  let workspaceRoot = prior?.workspaceRoot ?? '~/code';
  for (;;) {
    const answer = await ask(
      rl,
      `\nWorkspace root (holds ONLY your managed repos) [${workspaceRoot}]: `,
    );
    workspaceRoot = answer === '' ? workspaceRoot : answer;
    try {
      validateWorkspaceRoot(workspaceRoot);
      break;
    } catch (error) {
      out.write(`  ✗ ${(error as Error).message}\n`);
    }
  }

  const workspaceAbs = workspaceRoot.replace(/^~(?=\/|$)/, homedir());
  const found = discoverManagedRepos(workspaceAbs);
  let repos: string[] = [];
  if (found.length > 0) {
    out.write('\nRepos under the workspace root:\n');
    found.forEach((name, index) => out.write(`  ${index + 1}. ${name}\n`));
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
      const resolvedRepos: string[] = [];
      let bad: string | null = null;
      for (const pick of picks) {
        const byIndex = /^\d+$/.test(pick) ? found[Number(pick) - 1] : undefined;
        const name = byIndex ?? pick;
        if (!found.includes(name)) bad = pick;
        else if (!resolvedRepos.includes(name)) resolvedRepos.push(name);
      }
      if (bad !== null) {
        out.write(`  ✗ not a discovered repo: ${bad}\n`);
        continue;
      }
      repos = resolvedRepos;
      break;
    }
  } else {
    out.write(
      `\nNo git repos found under ${workspaceRoot} yet — the board will be empty\n` +
        'until you add repos there.\n',
    );
  }

  const bmad: Record<string, 'install' | 'reuse' | 'skip'> = {};
  for (const repo of repos) {
    const hasBmad = existsSync(join(workspaceAbs, repo, '_bmad', '_config', 'manifest.yaml'));
    for (;;) {
      const answer = (
        await ask(
          rl,
          hasBmad
            ? `BMAD in ${repo}: existing install found; reuse unchanged or skip? [reuse]: `
            : `BMAD in ${repo}: install official bmm,cis,tea,gds (core implicit)? [Y/n]: `,
        )
      ).toLowerCase();
      if (hasBmad && ['', 'reuse'].includes(answer)) {
        bmad[repo] = 'reuse';
        break;
      }
      if (!hasBmad && ['', 'y', 'yes'].includes(answer)) {
        bmad[repo] = 'install';
        break;
      }
      if (['skip', 'n', 'no'].includes(answer)) {
        bmad[repo] = 'skip';
        break;
      }
      out.write(`  ✗ enter ${hasBmad ? 'reuse or skip' : 'yes or no'}\n`);
    }
  }

  const runtimeDefault = prior?.runtimes.default ?? defaultRuntimeId(probe);
  let runtime = runtimeDefault;
  for (;;) {
    const answer = await ask(
      rl,
      `\nDefault runtime — ${RUNTIME_IDS.join(' | ')} [${runtimeDefault}]: `,
    );
    runtime = answer === '' ? runtimeDefault : answer;
    if ((RUNTIME_IDS as readonly string[]).includes(runtime)) break;
    out.write(`  ✗ valid runtimes: ${RUNTIME_IDS.join(', ')}\n`);
  }

  const modelDefault = prior?.models.default === '' ? 'default' : prior?.models.default ?? 'default';
  const model =
    (await ask(
      rl,
      `\nModel reference — Enter = the runtime's own configured model ("default")\n  [${modelDefault}]: `,
    )) || modelDefault;
  const thinkingDefault =
    prior?.thinking.default === '' ? 'default' : prior?.thinking.default ?? 'default';
  const thinkingLevel =
    (await ask(
      rl,
      `\nThinking level — Enter = the runtime's own ("default")\n  [${thinkingDefault}]: `,
    )) || thinkingDefault;

  // Bind-host input (user-found bug): "yes" passed the old syntax-only
  // check and the config later died with getaddrinfo ENOTFOUND yes. The
  // prompt now demands an ADDRESS, and every entry must be an IP literal
  // or a resolvable hostname — y/n-style tokens are rejected and the
  // wizard re-prompts. 0.0.0.0 (all interfaces) stays a valid answer.
  let host = prior?.server.host ?? '127.0.0.1';
  for (;;) {
    const answer = await ask(
      rl,
      `\nBind host (IP address, e.g. 192.168.1.23 — Enter = ${host} loopback-only) [${host}]: `,
    );
    const candidate = answer === '' ? host : answer;
    try {
      host = await resolveBindHost(candidate);
      break;
    } catch (error) {
      out.write(`  ✗ ${(error as Error).message}\n`);
    }
  }

  let port = prior?.server.port ?? 7665;
  for (;;) {
    const answer = await ask(rl, `Bind port (0 = ephemeral) [${port}]: `);
    if (answer === '') break;
    const parsed = Number(answer);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) {
      port = parsed;
      break;
    }
    out.write('  ✗ port must be an integer 0–65535\n');
  }

  const generated = generateToken();
  const tokenDefault = prior?.auth.token !== undefined && prior.auth.token !== '' ? prior.auth.token : generated;
  const tokenAnswer = await ask(rl, `\nPairing token [${tokenDefault}]: `);
  const token = tokenAnswer === '' ? tokenDefault : tokenAnswer;

  const registerService = yn(
    await ask(rl, '\nRegister the OS service (launchd/systemd, starts at login)? [y/N]: '),
  );
  const smokeAnswer =
    (await ask(rl, 'Run the first-boot smoke test now? [Y/n]: ')).toLowerCase();
  const smoke = smokeAnswer !== 'n' && smokeAnswer !== 'no';
  rl.close();

  const answers = parseAnswers(
    JSON.stringify({
      workspace_root: workspaceRoot,
      repos,
      bmad,
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
  return answers;
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
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    GRU_COMMAND_HOME: options.instanceDir,
  };
  const child = spawn(process.execPath, [distMain], {
    env: childEnv,
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
  let noInteract = false;
  let force = false;
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === undefined) break;
    if (arg === '--answers') {
      const value = rest.shift();
      if (value === undefined) fail('--answers requires a JSON argument\n' + WIZARD_USAGE, 2);
      answersJson = value;
      noInteract = true;
    } else if (arg === '--no-interact') {
      noInteract = true;
    } else if (arg === '--force') {
      force = true;
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

  // Round-trip: load + schema-validate any existing config FIRST. A
  // malformed config fails loud here — a re-run never silently drops or
  // misreads user configuration.
  let prior: ReturnType<typeof loadExistingInstanceConfig> = null;
  try {
    prior = loadExistingInstanceConfig(instanceDir);
  } catch (error) {
    fail(
      `existing config cannot be re-read — fix or remove it before re-running:\n  ${(error as Error).message}`,
    );
  }

  let answers: WizardAnswers;
  let terminal: WizardTerminal | null = null;
  if (noInteract) {
    let rawKeys: ReadonlySet<string> = new Set();
    try {
      // Key names only (for round-trip seeding precedence); parseAnswers
      // owns validation and its documented errors. Guard the plain-object
      // shape so 'null'/arrays/string JSON cannot crash with a raw
      // TypeError before parseAnswers speaks.
      const parsed: unknown = JSON.parse(answersJson ?? '{}');
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        rawKeys = new Set(Object.keys(parsed as Record<string, unknown>));
      }
      // Secrets never belong on the command line (documented contract):
      // the wizard generates or preserves the pairing token itself.
      if (rawKeys.has('token')) {
        fail('secrets are forbidden in --answers: token — the wizard generates or preserves the pairing token', 1);
      }
      answers = seedAnswersFromConfig(parseAnswers(answersJson ?? '{}'), prior, rawKeys);
    } catch (error) {
      if (error instanceof AnswersError) fail(String(error.message), 1);
      throw error;
    }
    // Bind-host acceptance applies on the non-interactive path too: an
    // unresolvable hostname would write a config that dies at boot.
    try {
      await resolveBindHost(answers.host);
    } catch (error) {
      fail(String((error as Error).message));
    }
    stdout.write('\nNon-interactive mode (unspecified answers = documented defaults).\n');
  } else {
    terminal = openWizardTerminal(repoRoot);
    answers = await interactiveAnswers(probe, terminal, prior);
  }

  const configPath = configPathFor(instanceDir);
  if (existsSync(configPath) && !force) {
    fail(`refusing to overwrite existing ${configPath} without --force`);
  }
  const configText = generateConfigToml({ answers, instanceDir, prior });

  stdout.write(
    `\nSelected repos for BMAD onboarding: ${answers.repos.length > 0 ? answers.repos.join(', ') : '(none)'}\n`,
  );
  if (answers.repos.length > 0) {
    stdout.write('BMAD per-repo plan (no workspace-root or unselected-repo writes):\n');
    for (const repo of answers.repos) {
      stdout.write(`  ${repo}: ${answers.bmad[repo] ?? 'skip'}\n`);
    }
  }

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

  const workspaceAbs = expandTilde(answers.workspaceRoot, homedir());
  for (const repo of answers.repos) {
    let action = answers.bmad[repo] ?? 'skip';
    for (;;) {
      const result = onboardBmadRepo(repo, action, { workspaceRoot: workspaceAbs, answers });
      if (result.ready) {
        stdout.write(`BMAD ready in ${repo}: ${result.message}\n`);
        stdout.write(
          `  Commit ${repo}/.gru-command/{worktree.toml,bmad-bootstrap.mjs,bmad-install.json} ` +
            'so fresh worktrees receive the project-local binding.\n',
        );
        break;
      }
      if (action === 'skip') {
        stdout.write(`BMAD not ready in ${repo}: ${result.message}; repo remains managed.\n`);
        break;
      }
      if (terminal === null) {
        fail(
          `BMAD setup for ${repo} is not ready: ${result.message}\n` +
            `Retry after fixing it, or explicitly set answers.bmad.${repo}="skip".`,
        );
      }
      terminal.output.write(`BMAD setup for ${repo} failed: ${result.message}\n`);
      const retryRl = createInterface({ input: terminal.input, output: terminal.output });
      const choice = (await ask(retryRl, 'Retry or skip this repo? [retry/skip]: ')).toLowerCase();
      retryRl.close();
      action = choice === 'skip' ? 'skip' : action;
    }
  }

  // BMAD setup may take minutes. Recheck the fixed port immediately
  // before writing config so a late listener cannot turn a completed
  // setup into a knowingly unbootable instance.
  if (answers.port !== 0) {
    const holder = await findPortHolder(answers.host, answers.port);
    if (holder !== null) {
      fail(`port ${answers.port} on ${answers.host} became occupied during setup; config was not written`);
    }
  }

  const write = writeConfigText(instanceDir, configText, { force });
  stdout.write(`\nWrote ${write.configPath}\n`);
  if (write.backupPath !== null) stdout.write(`Previous config backed up: ${write.backupPath}\n`);

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
