import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactCredentials } from '../redaction.js';
import type { PlannedCapture, ShotStep } from './shot-list.js';

/**
 * The camera's web adapter (PR media, docs/PR-MEDIA.md "GC's camera"): it
 * films one planned capture by driving the `agent-browser` CLI against the
 * app the run started on a loopback port.
 *
 * Isolation is the point. The camera never touches the owner's browser,
 * profile or accounts, and never visits anything but the lane's app:
 *
 * - every command names a fresh `--session` and an empty `--config` file the
 *   run wrote, so neither `~/.agent-browser/config.json` nor a repository's
 *   `agent-browser.json` (the command runs in the run's private folder,
 *   never the lane) can point it at a profile, an extension or a proxy;
 * - every `AGENT_BROWSER_*` variable of the service's environment is
 *   dropped;
 * - `--allowed-domains` names only the app's loopback host, so a step that
 *   navigates elsewhere fails instead of loading it.
 *
 * Commands run with an argv (no shell), each bounded in time and stopped by
 * the run's signal. The session is closed whatever the outcome.
 */

/** One capture to film. */
export interface WebShotRequest {
  /** The app's origin for this run, `http://127.0.0.1:<port>`. */
  readonly baseUrl: string;
  readonly plan: PlannedCapture;
  /** Absolute path of the file to write (`.png` still, `.webm` clip). */
  readonly outFile: string;
  /** The run's private folder: the adapter's config and working directory. */
  readonly workDir: string;
  readonly signal: AbortSignal;
}

/** A step of the shot list failed against the app: the shot list's or the
 * app's fault, not the camera's. */
export class ShotStepError extends Error {
  constructor(readonly shotId: string, readonly step: number, message: string) {
    super(message);
    this.name = 'ShotStepError';
  }
}

/** The camera cannot film web shots on this host (the tool is missing or
 * broken): infrastructure, retried later. */
export class CaptureToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureToolError';
  }
}

export interface WebCaptureDriver {
  /** Null when the tool is ready; otherwise what to install or fix. */
  probe(signal: AbortSignal): Promise<string | null>;
  /** Film one capture into `outFile`. Throws {@link ShotStepError} or
   * {@link CaptureToolError}. */
  shoot(request: WebShotRequest): Promise<void>;
}

/** The result of one CLI call. */
export interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Spawn failure (`ENOENT` = not installed), timeout or stop. */
  readonly error: string | null;
}

export type CliRunner = (
  argv: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly timeoutMs: number; readonly signal: AbortSignal },
) => Promise<CliResult>;

export const AGENT_BROWSER_BIN = 'agent-browser';
/** One action's wait (the tool's own default timeout). */
export const WEB_STEP_TIMEOUT_MS = 15_000;
/** Slack the process gets past its action timeout before it is killed. */
const COMMAND_SLACK_MS = 15_000;
/** The session close: given time on an ordinary run, bounded tightly when
 * the run was stopped (a stopping service waits for it). A browser that
 * outlives it works in the run's folder: the run's own cleanup ends it, or
 * the next boot does. */
const CLOSE_TIMEOUT_MS = 30_000;
const STOPPED_CLOSE_TIMEOUT_MS = 3_000;
/** A clip keeps rolling this long after its last step, so the result shows. */
export const CLIP_TAIL_MS = 1_000;
const DETAIL_MAX_CHARS = 300;

export const runCli: CliRunner = (argv, options) =>
  new Promise((resolveRun) => {
    const [file, ...args] = argv;
    if (file === undefined) {
      resolveRun({ code: null, stdout: '', stderr: '', error: 'empty command' });
      return;
    }
    execFile(file, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      signal: options.signal,
      maxBuffer: 1024 * 1024,
      encoding: 'utf-8',
      killSignal: 'SIGKILL',
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolveRun({ code: 0, stdout, stderr, error: null });
        return;
      }
      const failure = error as NodeJS.ErrnoException & { code?: unknown; killed?: boolean };
      if (typeof failure.code === 'number') {
        resolveRun({ code: failure.code, stdout, stderr, error: null });
        return;
      }
      resolveRun({ code: null, stdout, stderr, error: failure.killed === true ? 'timed out' : String(failure.code ?? failure.message) });
    });
  });

/** The service environment minus every `AGENT_BROWSER_*` override, plus the
 * camera's own action timeout. */
export function cameraBrowserEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (!key.startsWith('AGENT_BROWSER_')) env[key] = value;
  }
  env['AGENT_BROWSER_DEFAULT_TIMEOUT'] = String(WEB_STEP_TIMEOUT_MS);
  return env;
}

/** ANSI escape sequences (colors, cursor moves): built from the escape
 * character so the pattern holds no literal control character. */
const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;?]*[A-Za-z]`, 'gu');

/** Text with its ANSI escape sequences removed. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

function detail(result: CliResult): string {
  const text = stripAnsi(result.error ?? `${result.stdout}\n${result.stderr}`)
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(' ');
  const bounded = text.length <= DETAIL_MAX_CHARS ? text : `${text.slice(0, DETAIL_MAX_CHARS)}…`;
  return redactCredentials(bounded === '' ? `exit ${String(result.code)}` : bounded);
}

function describeStep(step: ShotStep): string {
  switch (step.action) {
    case 'open': return `open ${JSON.stringify(step.path)}`;
    case 'click': return `click ${JSON.stringify(step.selector)}`;
    case 'type': return `type into ${JSON.stringify(step.selector)}`;
    case 'wait_for_text': return `wait for text ${JSON.stringify(step.text)}`;
  }
}

/** The agent-browser arguments for one step (after the session options). */
export function stepArgs(step: ShotStep, baseUrl: string): readonly string[] {
  switch (step.action) {
    case 'open': return ['open', `${baseUrl}${step.path}`];
    case 'click': return ['click', step.selector];
    // "type" replaces the field's value: a shot shows one deterministic state.
    case 'type': return ['fill', step.selector, step.text];
    case 'wait_for_text': return ['wait', '--text', step.text];
  }
}

/** The `agent-browser` driver. */
export class AgentBrowserDriver implements WebCaptureDriver {
  constructor(
    private readonly run: CliRunner = runCli,
    private readonly baseEnv: () => NodeJS.ProcessEnv = () => process.env,
  ) {}

  async probe(signal: AbortSignal): Promise<string | null> {
    const result = await this.run([AGENT_BROWSER_BIN, '--version'], {
      cwd: process.cwd(), env: cameraBrowserEnv(this.baseEnv()), timeoutMs: 30_000, signal,
    });
    if (result.code === 0 && /agent-browser/iu.test(result.stdout)) return null;
    if (result.error === 'ENOENT') {
      return 'agent-browser is not installed on the Gru Command host: run `npm install -g agent-browser && agent-browser install`';
    }
    return `agent-browser --version failed: ${detail(result)}`;
  }

  async shoot(request: WebShotRequest): Promise<void> {
    const { plan } = request;
    const host = new URL(request.baseUrl).hostname.replace(/^\[|\]$/gu, '');
    const config = join(request.workDir, `agent-browser-${randomUUID()}.json`);
    writeFileSync(config, '{}\n', { mode: 0o600, flag: 'wx' });
    const session = `gc-capture-${randomUUID().slice(0, 8)}`;
    const env = cameraBrowserEnv(this.baseEnv());
    const base = [AGENT_BROWSER_BIN, '--config', config, '--session', session, '--allowed-domains', host];
    const call = (args: readonly string[]): Promise<CliResult> =>
      this.run([...base, ...args], { cwd: request.workDir, env, timeoutMs: WEB_STEP_TIMEOUT_MS + COMMAND_SLACK_MS, signal: request.signal });
    const must = async (args: readonly string[], what: string, step: number | null): Promise<void> => {
      const result = await call(args);
      if (result.code === 0) return;
      if (result.error === 'ENOENT') throw new CaptureToolError('agent-browser is not installed on the Gru Command host');
      if (request.signal.aborted) throw new CaptureToolError('the capture run was stopped');
      // No exit status (killed past its bound, or never started): the tool
      // failed, not the step. A step's own failure is a non-zero exit.
      if (result.code === null || result.error !== null) throw new CaptureToolError(`agent-browser ${what} did not finish: ${detail(result)}`);
      if (step === null) throw new CaptureToolError(`agent-browser ${what} failed: ${detail(result)}`);
      throw new ShotStepError(plan.shotId, step, `shot "${plan.shotId}" step ${step + 1} (${what}) failed at ${plan.viewport.name}: ${detail(result)}`);
    };
    try {
      await must(['set', 'viewport', String(plan.viewport.width), String(plan.viewport.height)], 'set viewport', null);
      const [first, ...rest] = plan.steps;
      if (first === undefined || first.action !== 'open') throw new ShotStepError(plan.shotId, 0, `shot "${plan.shotId}" must start with an open step`);
      if (plan.kind === 'clip') {
        // The recording starts on the first page, so the clip shows the
        // whole flow; it rolls a moment past the last step.
        await must(['record', 'start', request.outFile, `${request.baseUrl}${first.path}`], describeStep(first), 0);
        for (const [index, step] of rest.entries()) await must(stepArgs(step, request.baseUrl), describeStep(step), index + 1);
        await must(['wait', String(CLIP_TAIL_MS)], 'clip tail', null);
        await must(['record', 'stop'], 'record stop', null);
      } else {
        for (const [index, step] of plan.steps.entries()) await must(stepArgs(step, request.baseUrl), describeStep(step), index);
        await must(['screenshot', request.outFile], 'screenshot', null);
      }
    } finally {
      // Best effort, and never under the run's signal (a stopped run still
      // closes its browser): a session left open ends with the tool's daemon.
      await this.run([...base, 'close'], {
        cwd: request.workDir, env, timeoutMs: request.signal.aborted ? STOPPED_CLOSE_TIMEOUT_MS : CLOSE_TIMEOUT_MS, signal: new AbortController().signal,
      })
        .catch(() => undefined);
    }
  }
}
