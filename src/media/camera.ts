import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { repositoryGitEnv } from '../git-env.js';
import type { LogLevel } from '../logger.js';
import { endProcesses } from '../onboarding/proof.js';
import { redactCredentials, utf8Tail } from '../redaction.js';
import { readGitState, VerificationDisposedError, VerificationLockTimeoutError, type VerificationLease } from '../verify/scheduler.js';
import type { VerificationBudget } from '../verify/server.js';
import {
  applyWorktreeManifest,
  captureBaseUrl,
  loadWorktreeManifest,
  RESERVED_CAPTURE_SCOPE,
  type ManifestCapture,
  type WorktreeManifest,
} from '../worktrees/manifest.js';
import type { PlannedCapture } from './shot-list.js';
import { MediaError, validateMediaBytes } from './store.js';
import { CaptureToolError, ShotStepError, stripAnsi, type WebCaptureDriver } from './web-adapter.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * GC's camera (PR media, docs/PR-MEDIA.md "GC's camera"): one run films a
 * minion's shot list at the lane's exact committed head.
 *
 * - It holds ONE slot of the global verification budget for its whole life,
 *   under the reserved scope {@link CAMERA_SCOPE} (the scheduler's records of
 *   it are dropped: a camera run is never verification evidence and never
 *   fences a review).
 * - The lane is readied first (a slim lane gets its setup back), then the
 *   head is proved: HEAD is the named sha and no tracked file is changed.
 * - `[capture] serve` starts the app on a free loopback port the run picks
 *   (`{port}`), in its own process group; the run waits for `ready`, films
 *   each planned capture through the web adapter, and ends the group.
 * - A shot that compares with the base is filmed in a throwaway checkout of
 *   the merge base (`clone --shared`, detached), set up by that commit's own
 *   manifest (or the head's when the base has none), served the same way and
 *   removed afterwards.
 * - The head is proved again at the end: a lane that moved or changed during
 *   the run yields nothing, so no file is ever bound to a head it may not
 *   show.
 *
 * The run returns the files or a named failure; it stores nothing. The
 * director decides what to keep and what to retry.
 */

/** The verification-budget scope a camera run holds its slot under. */
export const CAMERA_SCOPE = RESERVED_CAPTURE_SCOPE;
/** The environment variable the serve shell evaluates its command from: its
 * argv then names the run, so a later boot can tell an orphan is its own. */
export const CAMERA_SERVE_ENV = 'GRU_CAPTURE_SERVE';
/** Grace between SIGTERM and SIGKILL when the app is stopped. */
export const CAMERA_KILL_GRACE_MS = 5_000;
const READY_POLL_MS = 250;
const READY_PROBE_TIMEOUT_MS = 2_000;
const OUTPUT_KEEP_BYTES = 64 * 1024;
const DETAIL_MAX_CHARS = 600;

export type CameraFailureCode =
  | 'head_moved'
  | 'dirty_tree'
  | 'lane_unreadable'
  | 'budget_unavailable'
  | 'tool_missing'
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
  readonly lanePath: string;
  /** The registered repository (the base checkout clones from it). */
  readonly repoPath: string;
  readonly headSha: string;
  /** The merge base; needed only when a plan is a `before` capture. */
  readonly baseSha: string | null;
  /** The head's committed `[capture]` table, with serve and ready. */
  readonly capture: ManifestCapture;
  /** The head's committed manifest (the base checkout's setup when the base
   * commit has none). */
  readonly headManifest: WorktreeManifest;
  readonly plans: readonly PlannedCapture[];
  /** A private folder this run owns; removed when the run ends. */
  readonly workDir: string;
  readonly budget: () => VerificationBudget;
  readonly driver: WebCaptureDriver;
  /** Gives a slim lane its setup back before anything runs in it (#427). */
  readonly ensureReady?: (signal: AbortSignal) => Promise<void>;
  readonly gitState?: (cwd: string) => { readonly sha: string | null; readonly trackedDirty: boolean };
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
  const plain = stripAnsi(text);
  const lines = plain.split('\n').map((part) => part.trimEnd()).filter((part) => part.trim() !== '').slice(-8).join(' ⏎ ');
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
  if (survivors.length > 0) log('error', 'pr media camera: the app outlived SIGKILL', { pid });
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
  const plain = (): string => stripAnsi(app.output());
  for (;;) {
    if (ready.kind === 'output' ? plain().includes(ready.text) : await probeUrl(withPort(ready.url, port))) return;
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
        if (error instanceof ShotStepError) throw new CameraFailure('step_failed', error.message);
        if (error instanceof CaptureToolError) throw new CameraFailure(input.signal.aborted ? 'stopped' : 'tool_missing', error.message);
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

function git(cwd: string, args: readonly string[], timeoutMs = 120_000): Promise<void> {
  return new Promise((resolveGit, rejectGit) => {
    execFile('git', ['-C', cwd, ...args], { env: repositoryGitEnv(true), timeout: timeoutMs, encoding: 'utf-8' }, (error, _stdout, stderr) => {
      if (error === null) resolveGit();
      else rejectGit(new Error(`git ${args[0] ?? ''} failed: ${(stderr || error.message).trim()}`));
    });
  });
}

/** Film the before plans in a throwaway checkout of the merge base. */
async function filmBase(input: CameraRunInput, lease: VerificationLease, plans: readonly PlannedCapture[]): Promise<readonly FilmedCapture[]> {
  if (input.baseSha === null) throw new CameraFailure('base_unavailable', 'a shot compares with the base, but the merge base of this head could not be found');
  const dir = join(input.workDir, 'base');
  try {
    // `clone --shared --no-checkout` + a detached checkout: the repository
    // gains no worktree, ref or index entry.
    await abortable(git(input.workDir, ['clone', '--quiet', '--shared', '--no-checkout', input.repoPath, dir]), input.signal);
    await abortable(git(dir, ['checkout', '--quiet', '--detach', input.baseSha]), input.signal);
  } catch (error) {
    if (error instanceof CameraFailure) throw error;
    throw new CameraFailure('base_unavailable', `the merge base ${input.baseSha.slice(0, 12)} could not be checked out: ${oneLine(error)}`);
  }
  let manifest: WorktreeManifest;
  try {
    manifest = loadWorktreeManifest(dir) ?? input.headManifest;
  } catch (error) {
    throw new CameraFailure('base_setup_failed', `the merge base's ${oneLine(error)}`);
  }
  try {
    await applyWorktreeManifest(manifest, { sourceRoot: input.repoPath, worktreePath: dir, setupTimeoutMs: input.setupTimeoutMs, signal: input.signal });
  } catch (error) {
    if (input.signal.aborted) throw new CameraFailure('stopped', 'the service is stopping');
    throw new CameraFailure('base_setup_failed', `setting up the merge base ${input.baseSha.slice(0, 12)} failed: ${oneLine(error)}`);
  }
  return serveAndFilm(input, lease, dir, plans, 'before');
}

function proveHead(input: CameraRunInput, when: string): void {
  const state = (input.gitState ?? ((cwd: string) => readGitState(cwd)))(input.lanePath);
  if (state.sha === null) throw new CameraFailure('lane_unreadable', `GC could not read the lane's HEAD ${when}`);
  if (state.sha !== input.headSha) {
    throw new CameraFailure('head_moved', `the lane moved from ${input.headSha.slice(0, 12)} to ${state.sha.slice(0, 12)} ${when}; the new head is filmed instead`);
  }
  if (state.trackedDirty) throw new CameraFailure('dirty_tree', `the lane had uncommitted tracked changes ${when}; GC films only a committed head`);
}

/** Film the plans at the lane's head. Never throws for a named failure. */
export async function filmShotList(input: CameraRunInput): Promise<CameraRunResult> {
  const log = input.log ?? (() => {});
  let budget: VerificationBudget;
  try {
    budget = input.budget();
  } catch (error) {
    return { kind: 'failed', code: 'budget_unavailable', detail: `the verification budget is unavailable: ${oneLine(error)}` };
  }
  mkdirSync(input.workDir, { recursive: true, mode: 0o700 });
  const granted = budget.acquire({ jobId: input.jobId, scope: CAMERA_SCOPE, command: input.capture.serve ?? '', cwd: input.lanePath, head: input.headSha });
  let lease: VerificationLease;
  try {
    lease = await abortable(granted, input.signal);
  } catch (error) {
    rmSync(input.workDir, { recursive: true, force: true });
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
    if (input.ensureReady !== undefined) {
      // Like a verification's readying (#427): a failed restore is logged and
      // the run goes ahead; the app's own start then says what is missing.
      await abortable(input.ensureReady(input.signal).catch((error: unknown) => {
        log('warn', 'pr media camera: readying the lane failed; filming goes ahead', { job: input.jobId, error: oneLine(error) });
      }), input.signal);
    }
    proveHead(input, 'before filming');
    const problem = await abortable(input.driver.probe(input.signal), input.signal);
    if (problem !== null) throw new CameraFailure('tool_missing', problem);
    const after = input.plans.filter((plan) => plan.role === 'after');
    const before = input.plans.filter((plan) => plan.role === 'before');
    const filmedAfter = after.length === 0 ? [] : await serveAndFilm(input, lease, input.lanePath, after, 'after');
    const filmedBefore = before.length === 0 ? [] : await filmBase(input, lease, before);
    proveHead(input, 'while it was filmed');
    // The plans' own order (before shots first within each shot).
    const byPlan = new Map<PlannedCapture, Buffer>([...filmedAfter, ...filmedBefore].map((file) => [file.plan, file.bytes]));
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
    throw error;
  } finally {
    budget.release(lease);
    rmSync(input.workDir, { recursive: true, force: true });
  }
}

/** The argv `ps` reports for a pid, or null when it is gone or unreadable. */
function commandOf(pid: number): Promise<string | null> {
  return new Promise((resolveCommand) => {
    execFile('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8', timeout: 10_000 }, (error, stdout) => {
      resolveCommand(error === null ? stdout.trim() || null : null);
    });
  });
}

function alive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Boot: end the apps a camera run of an earlier process left running (the
 * service stopped mid-run, so its detached app group outlived it). Each
 * restored {@link CAMERA_SCOPE} slot names the serve shell's pid, the
 * leader of its own group, with its argv. A live pid running exactly that
 * argv has its group ended and its slot released; a pid that is gone has
 * its slot released; a live pid running anything else (a reused pid) is
 * never signalled, and its slot waits for the scheduler's age limit.
 */
export async function endOrphanedCameraApps(budget: () => VerificationBudget, log: Log = () => {}): Promise<number> {
  let slots: VerificationBudget;
  try {
    slots = budget();
  } catch (error) {
    log('warn', 'pr media camera: the verification budget is unavailable, so an app an earlier run left is not ended now', { error: oneLine(error) });
    return 0;
  }
  let ended = 0;
  for (const holder of slots.restored(CAMERA_SCOPE)) {
    const fields = { run: holder.lease.runId, job: holder.lease.jobId, pid: holder.pid };
    try {
      if (alive(holder.pid)) {
        const running = await commandOf(holder.pid);
        if (running === null || holder.processCommand === null || running !== holder.processCommand) {
          if (alive(holder.pid)) {
            log('warn', 'pr media camera: a budget slot an earlier run left names a live pid that is not its app; it is not signalled and the slot waits for the age limit', { ...fields, recorded: holder.processCommand, running });
            continue;
          }
        } else {
          const survivors = await endProcesses([-holder.pid], CAMERA_KILL_GRACE_MS);
          if (survivors.length > 0) {
            log('error', 'pr media camera: an app an earlier run left outlived SIGKILL; its slot waits for the age limit', fields);
            continue;
          }
          ended += 1;
          log('warn', 'pr media camera: an app an earlier run left running was ended', fields);
        }
      }
      slots.release(holder.lease);
    } catch (error) {
      log('error', 'pr media camera: an app an earlier run left could not be judged; its slot waits for the age limit', { ...fields, error: oneLine(error) });
    }
  }
  return ended;
}
