import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { repositoryGitEnv } from '../git-env.js';
import type { LogLevel } from '../logger.js';
import { endProcesses } from '../onboarding/proof.js';
import { redactCredentials, utf8Tail } from '../redaction.js';
import { VerificationDisposedError, VerificationLockTimeoutError, type VerificationLease } from '../verify/scheduler.js';
import type { VerificationBudget } from '../verify/server.js';
import { psEnumeratorAsync } from '../worktrees/manager.js';
import {
  applyWorktreeManifest,
  captureBaseUrl,
  loadWorktreeManifest,
  RESERVED_CAPTURE_SCOPE,
  type ManifestCapture,
  type WorktreeManifest,
} from '../worktrees/manifest.js';
import { removeTree } from '../worktrees/reclaim.js';
import type { PlannedCapture } from './shot-list.js';
import { MediaError, mediaRoot, validateMediaBytes } from './store.js';
import { CaptureToolError, ShotStepError, stripAnsi, type WebCaptureDriver } from './web-adapter.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * GC's camera (PR media, docs/PR-MEDIA.md "GC's camera"): one run films a
 * minion's shot list at an exact committed head.
 *
 * - The browser tool is probed first, so a host without it costs nothing.
 * - It holds ONE slot of the global verification budget for its whole life,
 *   under the reserved scope {@link CAMERA_SCOPE} (the scheduler's records of
 *   it are dropped: a camera run is never verification evidence and never
 *   fences a review).
 * - Nothing runs in the minion's lane. Each commit is filmed in a throwaway
 *   checkout under the run's private folder (`clone --shared`, then a
 *   detached checkout: the repository gains no worktree, ref or index
 *   entry), set up by that commit's own manifest, exactly as a fresh lane
 *   is. The checkout IS the commit, so its tree is clean by construction and
 *   nothing the app writes can reach the lane.
 * - `[capture] serve` starts the app there on a free loopback port the run
 *   picks (`{port}`), in its own process group; the run waits for `ready`,
 *   films each planned capture through the web adapter, and ends the group.
 * - A shot that compares with the base is filmed the same way in a checkout
 *   of the merge base, set up by that commit's own manifest (or the head's
 *   when the base has none). It is filmed first: a base that cannot be set
 *   up fails the run before the head is filmed.
 * - The lane must still sit at the head at the end: a lane that moved yields
 *   nothing, so no file is bound to a head the lane has left.
 *
 * The run returns the files or a named failure; it stores nothing. The
 * director decides what to keep and what to retry.
 */

/** The verification-budget scope a camera run holds its slot under. */
export const CAMERA_SCOPE = RESERVED_CAPTURE_SCOPE;
/** The environment variable the serve shell evaluates its command from: its
 * argv then names the run. */
export const CAMERA_SERVE_ENV = 'GRU_CAPTURE_SERVE';
/** The folder (under the media home) every run's checkouts live in. */
export const CAMERA_WORK_DIR = '.camera';
/** Grace between SIGTERM and SIGKILL when the app is stopped. */
export const CAMERA_KILL_GRACE_MS = 5_000;
const READY_POLL_MS = 250;
const READY_PROBE_TIMEOUT_MS = 2_000;
const GIT_TIMEOUT_MS = 120_000;
const OUTPUT_KEEP_BYTES = 64 * 1024;
const DETAIL_MAX_CHARS = 600;

export type CameraFailureCode =
  | 'head_moved'
  | 'lane_unreadable'
  | 'budget_unavailable'
  | 'tool_missing'
  | 'checkout_failed'
  | 'setup_failed'
  | 'serve_failed'
  | 'ready_timeout'
  | 'step_failed'
  | 'capture_invalid'
  | 'base_unavailable'
  | 'base_setup_failed'
  | 'stopped';

export interface FilmedCapture {
  readonly plan: PlannedCapture;
  readonly bytes: Buffer;
}

export type CameraRunResult =
  | { readonly kind: 'filmed'; readonly files: readonly FilmedCapture[] }
  | { readonly kind: 'failed'; readonly code: CameraFailureCode; readonly detail: string };

export interface CameraRunInput {
  readonly jobId: string;
  readonly runId: string;
  /** The job's lane: read (its HEAD), never written or served from. */
  readonly lanePath: string;
  /** The registered repository the checkouts clone from (they share its
   * objects, so every lane commit is there). */
  readonly repoPath: string;
  readonly headSha: string;
  /** The merge base; needed only when a plan is a `before` capture. */
  readonly baseSha: string | null;
  /** The head's committed `[capture]` table, with serve and ready. */
  readonly capture: ManifestCapture;
  /** The head's committed manifest: the head checkout's setup, and the base
   * checkout's when the base commit has none. */
  readonly headManifest: WorktreeManifest;
  readonly plans: readonly PlannedCapture[];
  /** A private folder this run owns; removed when the run ends. */
  readonly workDir: string;
  readonly budget: () => VerificationBudget;
  readonly driver: WebCaptureDriver;
  readonly setupTimeoutMs: number;
  readonly signal: AbortSignal;
  readonly log?: Log;
}

class CameraFailure extends Error {
  constructor(readonly code: CameraFailureCode, detail: string) {
    super(detail);
    this.name = 'CameraFailure';
  }
}

function oneLine(error: unknown): string {
  const text = String(error instanceof Error ? error.message : error).replace(/\s+/gu, ' ').trim();
  return redactCredentials(text.length <= DETAIL_MAX_CHARS ? text : `${text.slice(0, DETAIL_MAX_CHARS)}…`);
}

/** The tail of the app's output, ANSI colors removed, redacted, bounded. */
function outputTail(text: string): string {
  const lines = stripAnsi(text).split('\n').map((part) => part.trimEnd()).filter((part) => part.trim() !== '').slice(-8).join(' ⏎ ');
  return redactCredentials(lines.length <= DETAIL_MAX_CHARS ? lines : `…${lines.slice(-DETAIL_MAX_CHARS)}`);
}

/** A free loopback port (bound, read and released: the app binds it next). */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : null;
      server.close(() => (port === null ? rejectPort(new Error('no port was assigned')) : resolvePort(port)));
    });
  });
}

export function withPort(template: string, port: number): string {
  return template.split('{port}').join(String(port));
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new CameraFailure('stopped', 'the service is stopping'));
  return new Promise((resolveWork, rejectWork) => {
    const onAbort = (): void => rejectWork(new CameraFailure('stopped', 'the service is stopping'));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolveWork(value); },
      (error: unknown) => { signal.removeEventListener('abort', onAbort); rejectWork(error instanceof Error ? error : new Error(String(error))); },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return abortable(new Promise((resolveSleep) => setTimeout(resolveSleep, ms)), signal);
}

/** One git command, off the event loop, killed when the run stops. */
function git(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolveGit, rejectGit) => {
    execFile('git', ['-C', cwd, ...args], { env: repositoryGitEnv(true), timeout: GIT_TIMEOUT_MS, encoding: 'utf-8', signal, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (signal.aborted) rejectGit(new CameraFailure('stopped', 'the service is stopping'));
        else if (error === null) resolveGit(stdout.trim());
        else rejectGit(new Error(`git ${args[0] ?? ''} failed: ${(stderr || error.message).trim()}`));
      });
  });
}

/** A running app: its group, its output so far, and how it ended. */
interface ServedApp {
  readonly child: ChildProcess;
  readonly output: () => string;
  readonly exited: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
  exitedNow: boolean;
}

function startApp(input: {
  readonly command: string;
  readonly cwd: string;
  readonly port: number;
  readonly runId: string;
  readonly onSpawn: (pid: number, processCommand: string) => void;
}): ServedApp {
  let child: ChildProcess;
  try {
    // The shell evaluates the command from its environment, so its argv
    // names the run whatever the command is.
    child = spawn('/bin/sh', ['-c', `eval "$${CAMERA_SERVE_ENV}" # pr media camera ${input.runId}`], {
      cwd: input.cwd,
      env: { ...repositoryGitEnv(false), [CAMERA_SERVE_ENV]: input.command, GRU_CAPTURE_PORT: String(input.port), GRU_CAPTURE_RUN_ID: input.runId },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new CameraFailure('serve_failed', `[capture] serve could not be started: ${oneLine(error)}`);
  }
  let text = '';
  const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')] as const;
  const take = (chunk: string): void => {
    text = utf8Tail(text + chunk, OUTPUT_KEEP_BYTES);
  };
  child.stdout?.on('data', (chunk: Buffer) => take(decoders[0].write(chunk)));
  child.stderr?.on('data', (chunk: Buffer) => take(decoders[1].write(chunk)));
  const app: ServedApp = {
    child,
    output: () => text,
    exitedNow: false,
    exited: new Promise((resolveExit) => {
      child.once('error', () => {
        app.exitedNow = true;
        resolveExit({ code: null, signal: null });
      });
      child.once('close', (code, signal) => {
        app.exitedNow = true;
        resolveExit({ code, signal });
      });
    }),
  };
  if (child.pid !== undefined) input.onSpawn(child.pid, child.spawnargs.join(' '));
  return app;
}

async function stopApp(app: ServedApp, log: Log): Promise<void> {
  const pid = app.child.pid;
  if (pid === undefined) return;
  const survivors = await endProcesses([-pid], CAMERA_KILL_GRACE_MS);
  if (survivors.length > 0) log('error', 'pr media camera: the app outlived SIGKILL; the next boot ends it', { pid });
}

async function probeUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(READY_PROBE_TIMEOUT_MS) });
    await response.body?.cancel().catch(() => undefined);
    return response.status < 400;
  } catch {
    return false;
  }
}

async function waitReady(app: ServedApp, capture: ManifestCapture, port: number, signal: AbortSignal): Promise<void> {
  const ready = capture.ready;
  if (ready === null) throw new CameraFailure('serve_failed', '[capture] declares no ready condition');
  const deadline = Date.now() + capture.readyTimeoutMs;
  for (;;) {
    if (ready.kind === 'output' ? stripAnsi(app.output()).includes(ready.text) : await probeUrl(withPort(ready.url, port))) return;
    if (app.exitedNow) {
      const exit = await app.exited;
      throw new CameraFailure('serve_failed',
        `[capture] serve exited (${exit.code === null ? `signal ${String(exit.signal)}` : `code ${exit.code}`}) before it was ready: ${outputTail(app.output()) || 'no output'}`);
    }
    if (Date.now() >= deadline) {
      throw new CameraFailure('ready_timeout',
        `the app was not ready after ${capture.readyTimeoutMs} ms (${ready.kind === 'url' ? `no answer below 400 from ${withPort(ready.url, port)}` : `no output containing ${JSON.stringify(ready.text)}`}): ${outputTail(app.output()) || 'no output'}`);
    }
    await sleep(READY_POLL_MS, signal);
  }
}

/** Serve the app in `cwd` and film every plan against it. */
async function serveAndFilm(input: CameraRunInput, lease: VerificationLease, cwd: string, plans: readonly PlannedCapture[], label: string): Promise<readonly FilmedCapture[]> {
  const log = input.log ?? (() => {});
  const serve = input.capture.serve;
  if (serve === null) throw new CameraFailure('serve_failed', '[capture] declares no serve command');
  const port = await freeLoopbackPort();
  const budget = input.budget();
  const app = startApp({
    command: withPort(serve, port),
    cwd,
    port,
    runId: input.runId,
    onSpawn: (pid, processCommand) => {
      try {
        budget.bindPid(lease, pid, processCommand, { leadsGroup: true });
      } catch (error) {
        log('error', 'pr media camera: the app pid could not be bound to its budget slot; a restart may release the slot early', { pid, error: oneLine(error) });
      }
    },
  });
  try {
    await waitReady(app, input.capture, port, input.signal);
    const baseUrl = withPort(captureBaseUrl(input.capture), port);
    const filmed: FilmedCapture[] = [];
    for (const [index, plan] of plans.entries()) {
      if (input.signal.aborted) throw new CameraFailure('stopped', 'the service is stopping');
      const outFile = join(input.workDir, `${label}-${index}.${plan.kind === 'clip' ? 'webm' : 'png'}`);
      try {
        await input.driver.shoot({ baseUrl, plan, outFile, workDir: input.workDir, signal: input.signal });
      } catch (error) {
        if (input.signal.aborted) throw new CameraFailure('stopped', 'the service is stopping');
        if (error instanceof ShotStepError) throw new CameraFailure('step_failed', error.message);
        if (error instanceof CaptureToolError) throw new CameraFailure('tool_missing', error.message);
        throw error;
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(outFile);
      } catch (error) {
        throw new CameraFailure('capture_invalid', `shot "${plan.shotId}" at ${plan.viewport.name} wrote no file: ${oneLine(error)}`);
      }
      try {
        validateMediaBytes(bytes);
      } catch (error) {
        if (error instanceof MediaError) throw new CameraFailure('capture_invalid', `shot "${plan.shotId}" at ${plan.viewport.name}: ${error.message}`);
        throw error;
      }
      if (app.exitedNow) throw new CameraFailure('serve_failed', `[capture] serve exited while shot "${plan.shotId}" was filmed: ${outputTail(app.output()) || 'no output'}`);
      filmed.push({ plan, bytes });
    }
    return filmed;
  } finally {
    await stopApp(app, log);
  }
}

/** A throwaway checkout of `sha`, set up by its own manifest (or
 * `fallback` when the commit has none), as a fresh lane is. */
async function checkoutAt(input: CameraRunInput, sha: string, name: 'head' | 'base', fallback: WorktreeManifest): Promise<string> {
  const dir = join(input.workDir, name);
  const what = name === 'head' ? `the head ${sha.slice(0, 12)}` : `the merge base ${sha.slice(0, 12)}`;
  try {
    await git(input.workDir, ['clone', '--quiet', '--shared', '--no-checkout', input.repoPath, dir], input.signal);
    await git(dir, ['checkout', '--quiet', '--detach', sha], input.signal);
  } catch (error) {
    if (error instanceof CameraFailure) throw error;
    throw new CameraFailure(name === 'head' ? 'checkout_failed' : 'base_unavailable', `${what} could not be checked out: ${oneLine(error)}`);
  }
  const setupFailed: CameraFailureCode = name === 'head' ? 'setup_failed' : 'base_setup_failed';
  let manifest: WorktreeManifest;
  try {
    manifest = loadWorktreeManifest(dir) ?? fallback;
  } catch (error) {
    throw new CameraFailure(setupFailed, `${what}: ${oneLine(error)}`);
  }
  try {
    await applyWorktreeManifest(manifest, { sourceRoot: input.repoPath, worktreePath: dir, setupTimeoutMs: input.setupTimeoutMs, signal: input.signal });
  } catch (error) {
    if (input.signal.aborted) throw new CameraFailure('stopped', 'the service is stopping');
    throw new CameraFailure(setupFailed, `setting up ${what} failed: ${oneLine(error)}`);
  }
  return dir;
}

async function proveLane(input: CameraRunInput, when: string): Promise<void> {
  let sha: string;
  try {
    sha = await git(input.lanePath, ['rev-parse', 'HEAD'], input.signal);
  } catch (error) {
    if (error instanceof CameraFailure) throw error;
    throw new CameraFailure('lane_unreadable', `GC could not read the lane's HEAD ${when}: ${oneLine(error)}`);
  }
  if (sha !== input.headSha) {
    throw new CameraFailure('head_moved', `the lane moved from ${input.headSha.slice(0, 12)} to ${sha.slice(0, 12)} ${when}; the new head is filmed instead`);
  }
}

/** Film the plans at the head (and the merge base). Never throws for a
 * named failure, and never throws for the folder it could not remove. */
export async function filmShotList(input: CameraRunInput): Promise<CameraRunResult> {
  const log = input.log ?? (() => {});
  const before = input.plans.filter((plan) => plan.role === 'before');
  const after = input.plans.filter((plan) => plan.role === 'after');
  // Cheap refusals first: no budget slot is waited for to learn them.
  let problem: string | null;
  try {
    problem = await abortable(input.driver.probe(input.signal), input.signal);
  } catch (error) {
    return { kind: 'failed', code: error instanceof CameraFailure ? error.code : 'tool_missing', detail: oneLine(error) };
  }
  if (problem !== null) return { kind: 'failed', code: 'tool_missing', detail: problem };
  if (before.length > 0 && input.baseSha === null) {
    return { kind: 'failed', code: 'base_unavailable', detail: 'a shot compares with the base, but the merge base of this head could not be found' };
  }
  let budget: VerificationBudget;
  try {
    budget = input.budget();
  } catch (error) {
    return { kind: 'failed', code: 'budget_unavailable', detail: `the verification budget is unavailable: ${oneLine(error)}` };
  }
  const granted = budget.acquire({ jobId: input.jobId, scope: CAMERA_SCOPE, command: input.capture.serve ?? '', cwd: input.workDir, head: input.headSha });
  let lease: VerificationLease;
  try {
    lease = await abortable(granted, input.signal);
  } catch (error) {
    if (error instanceof CameraFailure) {
      void granted.then((late) => budget.release(late), () => {});
      return { kind: 'failed', code: 'stopped', detail: error.message };
    }
    if (error instanceof VerificationLockTimeoutError) {
      return { kind: 'failed', code: 'budget_unavailable', detail: `the verification budget wait timed out after ${String(error.waitMs)} ms` };
    }
    if (error instanceof VerificationDisposedError) return { kind: 'failed', code: 'stopped', detail: 'the service is stopping' };
    return { kind: 'failed', code: 'budget_unavailable', detail: `no verification budget slot: ${oneLine(error)}` };
  }
  try {
    mkdirSync(input.workDir, { recursive: true, mode: 0o700 });
    await proveLane(input, 'before filming');
    const filmedBefore = before.length === 0
      ? []
      : await serveAndFilm(input, lease, await checkoutAt(input, input.baseSha!, 'base', input.headManifest), before, 'before');
    const filmedAfter = after.length === 0
      ? []
      : await serveAndFilm(input, lease, await checkoutAt(input, input.headSha, 'head', input.headManifest), after, 'after');
    await proveLane(input, 'while it was filmed');
    // The plans' own order (before shots first within each shot).
    const byPlan = new Map<PlannedCapture, Buffer>([...filmedBefore, ...filmedAfter].map((file) => [file.plan, file.bytes]));
    const files = input.plans.map((plan) => {
      const bytes = byPlan.get(plan);
      if (bytes === undefined) throw new CameraFailure('capture_invalid', `shot "${plan.shotId}" at ${plan.viewport.name} produced no file`);
      return { plan, bytes };
    });
    log('info', 'pr media camera: shot list filmed', { job: input.jobId, run: input.runId, head: input.headSha, files: files.length });
    return { kind: 'filmed', files };
  } catch (error) {
    if (error instanceof CameraFailure) return { kind: 'failed', code: error.code, detail: error.message };
    if (input.signal.aborted) return { kind: 'failed', code: 'stopped', detail: 'the service is stopping' };
    return { kind: 'failed', code: 'serve_failed', detail: `the camera run failed unexpectedly: ${oneLine(error)}` };
  } finally {
    budget.release(lease);
    await removeTree(input.workDir).catch((error: unknown) => {
      log('warn', 'pr media camera: the run folder could not be removed; the next boot removes it', { run: input.runId, error: oneLine(error) });
    });
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Boot: end what the runs of an earlier process left running (the service
 * stopped mid-run, so a detached app group, or a browser session that never
 * closed, outlived it), then remove their folders. Every such process works
 * in a run's private folder under `<data_dir>/media/.camera/`, so that is the
 * evidence: each process rooted there (its working directory, or its
 * command line) is ended, with the group of each restored
 * {@link CAMERA_SCOPE} slot that leads one of them. A restored slot whose
 * pid is gone afterwards is released; a live pid rooted elsewhere (a
 * reused pid) is never signalled, and its slot waits for the scheduler's
 * age limit. Returns how many processes were ended.
 */
export async function endOrphanedCameraApps(budget: () => VerificationBudget, dataDir: string, log: Log = () => {}): Promise<number> {
  const root = join(mediaRoot(dataDir), CAMERA_WORK_DIR);
  let slots: VerificationBudget | null = null;
  try {
    slots = budget();
  } catch (error) {
    log('warn', 'pr media camera: the verification budget is unavailable, so slots an earlier run left are not released now', { error: oneLine(error) });
  }
  const restored = slots?.restored(CAMERA_SCOPE) ?? [];
  let ended = 0;
  if (existsSync(root)) {
    const rooted = await psEnumeratorAsync(root, {
      onCwdError: (error) => log('warn', 'pr media camera: working directories could not be listed; only processes naming a run folder are ended', { error: oneLine(error) }),
    });
    const pids = new Set(rooted.map((entry) => entry.pid).filter((pid) => pid !== process.pid));
    const targets = [...pids, ...restored.filter((holder) => pids.has(holder.pid)).map((holder) => -holder.pid)];
    if (targets.length > 0) {
      const survivors = await endProcesses(targets, CAMERA_KILL_GRACE_MS);
      ended = pids.size;
      log('warn', 'pr media camera: processes an earlier run left were ended', { pids: [...pids], survivors });
    }
    await removeTree(root).catch((error: unknown) => {
      log('warn', 'pr media camera: an earlier run\'s folder could not be removed', { error: oneLine(error) });
    });
  }
  for (const holder of restored) {
    if (alive(holder.pid)) {
      log('warn', 'pr media camera: a budget slot an earlier run left names a live pid that is not one of its processes; it is not signalled and the slot waits for the age limit', { run: holder.lease.runId, pid: holder.pid });
      continue;
    }
    slots?.release(holder.lease);
  }
  return ended;
}
