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
import { emitKeypressEvents } from 'node:readline';
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
  validateHost,
  validateWorkspaceRoot,
  type WizardAnswers,
} from './answers.js';
import {
  buildQrPayload,
  discoverManagedRepos,
  generateConfigToml,
  writeConfigText,
} from './steps.js';
import { onboardBmadRepo } from './bmad-onboarding.js';
import {
  checkJev,
  persistJevCredential,
  readJevStatus,
  type JevStatus,
} from './jev-setup.js';

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

interface InteractivePlan {
  readonly answers: WizardAnswers;
  readonly localJevCredential: string | null;
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

async function askMasked(terminal: WizardTerminal, question: string): Promise<string> {
  // Arm raw mode and the key handler before exposing the prompt. A PTY
  // driver (or a very fast paste) may answer as soon as it sees the prompt;
  // writing first creates a race where the terminal itself echoes the secret.
  emitKeypressEvents(terminal.input);
  terminal.input.setRawMode(true);
  terminal.input.resume();
  return new Promise<string>((resolveValue, reject) => {
    const chars: string[] = [];
    const finish = (error?: Error): void => {
      terminal.input.off('keypress', onKey);
      terminal.input.setRawMode(false);
      terminal.output.write('\n');
      if (error !== undefined) reject(error);
      else resolveValue(chars.join(''));
    };
    const onKey = (
      text: string,
      key: { name?: string; ctrl?: boolean; meta?: boolean },
    ): void => {
      if (key.ctrl === true && key.name === 'c') {
        finish(new Error('credential entry cancelled'));
      } else if (key.name === 'return' || key.name === 'enter') {
        finish();
      } else if (key.name === 'backspace') {
        if (chars.pop() !== undefined) terminal.output.write('\b \b');
      } else if (text !== '' && key.ctrl !== true && key.meta !== true) {
        chars.push(text);
        terminal.output.write('*');
      }
    };
    terminal.input.on('keypress', onKey);
    terminal.output.write(question);
  });
}

function yn(value: string): boolean {
  return value.toLowerCase() === 'y' || value.toLowerCase() === 'yes';
}

async function interactiveAnswers(
  probe: readonly RuntimeProbeResult[],
  repoRoot: string,
  instanceDir: string,
  terminal: WizardTerminal,
  decisionsCliPath?: string,
): Promise<InteractivePlan> {
  const rl = createInterface({ input: terminal.input, output: terminal.output });
  const out = terminal.output;
  out.write('\nGru Command setup — press Enter to accept every [default].\n');

  let workspaceRoot = '~/code';
  for (;;) {
    const answer = await ask(rl, '\nWorkspace root (holds ONLY your managed repos) [~/code]: ');
    workspaceRoot = answer === '' ? '~/code' : answer;
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

  const runtimeDefault = defaultRuntimeId(probe);
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
      validateHost(host);
      break;
    } catch (error) {
      out.write(`  ✗ ${(error as Error).message}\n`);
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
    out.write('  ✗ port must be an integer 0–65535\n');
  }

  const generated = generateToken();
  const tokenAnswer = await ask(rl, `\nPairing token [${generated}]: `);
  const token = tokenAnswer === '' ? generated : tokenAnswer;

  const jevEnabled = yn(await ask(rl, '\nEnable optional Jev decisions provider? [y/N]: '));
  let persistEnvCredential = false;
  let requestLocalCredential = false;
  if (jevEnabled) {
    let status: JevStatus;
    try {
      status = readJevStatus({ repoRoot, instanceDir, cliPath: decisionsCliPath });
      out.write(
        `Jev credential status: ${status.credential_present ? 'present' : 'absent'} ` +
          `(${status.credential_source}).\n`,
      );
    } catch (error) {
      out.write(`Jev offline status unavailable: ${(error as Error).message}\n`);
      status = { enabled: false, credential_present: false, credential_source: 'none' };
    }
    if (status.credential_source === 'environment') {
      out.write(
        'Environment-only credentials may disappear when launchd/systemd starts the service.\n',
      );
      persistEnvCredential = yn(
        await ask(rl, 'Persist the environment key to the protected instance store? [y/N]: '),
      );
    } else if (!status.credential_present) {
      requestLocalCredential = yn(
        await ask(rl, 'Enter and persist an OpenRouter key locally (masked)? [y/N]: '),
      );
    }
  }

  const registerService = yn(
    await ask(rl, '\nRegister the OS service (launchd/systemd, starts at login)? [y/N]: '),
  );
  const smokeAnswer =
    (await ask(rl, 'Run the first-boot smoke test now? [Y/n]: ')).toLowerCase();
  const smoke = smokeAnswer !== 'n' && smokeAnswer !== 'no';
  rl.close();

  const localJevCredential = requestLocalCredential
    ? await askMasked(terminal, 'OpenRouter key (input hidden): ')
    : null;
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
      jev_enabled: jevEnabled,
      persist_env_credential: persistEnvCredential,
      register_service: registerService,
      smoke,
    }),
  );
  return { answers, localJevCredential };
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
  // Never leak the shell credential to a service child. Smoke must prove
  // restart-safe instance-store resolution or deterministic fallback.
  delete childEnv.OPENROUTER_API_KEY;
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
  const decisionsCliPath = process.env.GRU_COMMAND_TEST_DECISIONS_CLI;
  stdout.write('Gru Command setup wizard\n=========================');
  const probe = probeRuntimes();
  printProbe(probe);

  let answers: WizardAnswers;
  let localJevCredential: string | null = null;
  let terminal: WizardTerminal | null = null;
  if (noInteract) {
    try {
      answers = parseAnswers(answersJson ?? '{}');
    } catch (error) {
      if (error instanceof AnswersError) fail(String(error.message), 1);
      throw error;
    }
    stdout.write('\nNon-interactive mode (unspecified answers = documented defaults).\n');
  } else {
    terminal = openWizardTerminal(repoRoot);
    const plan = await interactiveAnswers(
      probe,
      repoRoot,
      instanceDir,
      terminal,
      decisionsCliPath,
    );
    answers = plan.answers;
    localJevCredential = plan.localJevCredential;
  }

  const configPath = configPathFor(instanceDir);
  if (existsSync(configPath) && !force) {
    fail(`refusing to overwrite existing ${configPath} without --force`);
  }
  const configText = generateConfigToml({
    answers,
    instanceDir,
    repoRoot,
    decisionsCliPath,
  });

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

  // Validate and persist an explicitly approved key before replacing any
  // config. The Jev child receives the value only on stdin.
  if (answers.jevEnabled && answers.persistEnvCredential) {
    const key = process.env.OPENROUTER_API_KEY;
    if (key === undefined || key.trim() === '') {
      fail(
        'Jev environment persistence was approved, but OPENROUTER_API_KEY is unavailable; ' +
          'config was not written',
      );
    }
    persistJevCredential({ repoRoot, instanceDir, cliPath: decisionsCliPath }, key);
    stdout.write('Jev credential persisted to the protected instance store (value not displayed).\n');
  } else if (answers.jevEnabled && localJevCredential !== null) {
    persistJevCredential(
      { repoRoot, instanceDir, cliPath: decisionsCliPath },
      localJevCredential,
    );
    localJevCredential = null;
    stdout.write('Jev credential persisted to the protected instance store (value not displayed).\n');
  }

  const write = writeConfigText(instanceDir, configText, { force });
  stdout.write(`\nWrote ${write.configPath}\n`);
  if (write.backupPath !== null) stdout.write(`Previous config backed up: ${write.backupPath}\n`);

  if (answers.jevEnabled) {
    try {
      const status = readJevStatus({ repoRoot, instanceDir, cliPath: decisionsCliPath });
      if (status.credential_source === 'environment' && !answers.persistEnvCredential) {
        stdout.write(
          'WARNING: Jev is using an environment-only key; an OS service restart may not receive it.\n',
        );
      }
      const check = checkJev({ repoRoot, instanceDir, cliPath: decisionsCliPath });
      if (check.status === 'ready') {
        stdout.write('Jev readiness: ready.\n');
      } else {
        stdout.write(
          `Jev readiness: degraded (${check.reason ?? 'unknown'}). ` +
            'Gru Command remains usable with deterministic fallback.\n' +
            'Correct it, then run: node dist/decisions/cli.js check --json\n',
        );
      }
    } catch {
      stdout.write(
        'Jev readiness: degraded (local CLI unavailable or malformed). ' +
          'Gru Command remains usable with deterministic fallback.\n' +
          'Correct it, then run: node dist/decisions/cli.js check --json\n',
      );
    }
  }

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
    const serviceEnv = { ...process.env };
    delete serviceEnv.OPENROUTER_API_KEY;
    const result = spawnSync('bash', [join(repoRoot, 'install.sh'), '--service'], {
      env: serviceEnv,
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
