import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { LogLevel } from '../logger.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * The verification scheduler (contention fix, owner-approved 2026-09-22):
 * ONE global test budget across every lane.
 *
 * Concurrent lanes used to each run their full suite with a pool sized to
 * the machine's cores — N lanes × cores workers oversubscribed the box
 * (observed load 15–22, vitest RPC timeouts killing green runs). This is a
 * coordination problem, not a capacity one, so the service owns a single
 * cross-lane coordinator:
 *
 *  - at most `maxConcurrent` runs in flight, FIFO beyond that;
 *  - total test workers across runs ≤ `workerBudget` (auto: cores - 2),
 *    enforced by the run wrapper's environment;
 *  - the active holder set is persisted (`<storageDir>/scheduler.json`)
 *    with the runner pid, so a restart releases holders whose pid is dead;
 *  - a queued request that waits past `lockWaitTimeoutMs` fails LOUD with
 *    a typed error + a `verification.lock-timeout` ledger record;
 *  - each run is wall-clock bounded; expiry terminates the whole process
 *    group (shell + workers) with SIGTERM, then SIGKILL.
 *
 * `run()` is the one production entry; `acquire()`/`release()` are the
 * lease primitives it is built on (also the deterministic test surface).
 */

export interface VerificationLimits {
  readonly maxConcurrent: number;
  /** Total concurrent test workers across runs; 0 = auto (cores - 2). */
  readonly workerBudget: number;
  readonly lockWaitTimeoutMs: number;
  readonly runTimeoutMs: number;
}

export interface VerificationRunSpec {
  readonly jobId: string;
  readonly scope: string;
  readonly command: string;
  readonly cwd: string;
}

export interface VerificationLease {
  readonly runId: string;
  readonly jobId: string;
  readonly scope: string;
  readonly command: string;
  readonly cwd: string;
  readonly queuedAt: number;
  readonly grantedAt: number;
}

export interface VerificationOutcome {
  readonly runId: string;
  readonly jobId: string;
  readonly scope: string;
  readonly command: string;
  readonly cwd: string;
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly queuedMs: number;
  readonly durationMs: number;
  readonly sha: string | null;
  /** Tracked-file changes at run start: a dirty run binds to no commit. */
  readonly trackedDirty: boolean;
  readonly workers: number;
  readonly outputBytes: number;
  readonly outputSha256: string;
  readonly outputTail: string;
  /** Spawn-level failure (never a silent exit-code null). */
  readonly error: string | null;
}

export type VerificationProgress =
  | {
      readonly type: 'queued';
      readonly runId: string;
      readonly position: number;
      readonly active: number;
      readonly limit: number;
    }
  | {
      readonly type: 'started';
      readonly runId: string;
      readonly workers: number;
      readonly sha: string | null;
      readonly queuedMs: number;
    }
  | {
      readonly type: 'output';
      readonly runId: string;
      readonly stream: 'stdout' | 'stderr';
      readonly text: string;
    }
  | { readonly type: 'completed'; readonly runId: string; readonly outcome: VerificationOutcome };

export type VerificationProgressSink = (progress: VerificationProgress) => void | Promise<void>;

/** A ledger-bound record the scheduler emits (wired to appendCustomEvent). */
export interface VerificationRecord {
  readonly kind: string;
  readonly jobId: string;
  readonly payload: Record<string, unknown>;
}

export type VerificationRecorder = (record: VerificationRecord) => void;

/** Raised when a queued request waits past lock_wait_timeout_ms. */
export class VerificationLockTimeoutError extends Error {
  readonly code = 'lock_wait_timeout';
  constructor(
    readonly waitMs: number,
    readonly active: number,
    readonly queued: number,
  ) {
    super(
      `verification lock wait exceeded ${waitMs}ms ` +
        `(${active} run(s) active, ${queued} queued) — the request was not left hanging silently`,
    );
    this.name = 'VerificationLockTimeoutError';
  }
}

/** Raised when the scheduler is disposed while a request still waits. */
export class VerificationDisposedError extends Error {
  readonly code = 'scheduler_disposed';
  constructor() {
    super('verification scheduler is shutting down — no new runs are accepted');
    this.name = 'VerificationDisposedError';
  }
}

/** A spawn/settle callback payload: the lease plus the spawned child. */
export interface VerificationSpawnInfo {
  readonly lease: VerificationLease;
  readonly pid: number | null;
  /** The exact argv the child runs (the pid's command evidence). */
  readonly command: string;
}

/** The queue view the board's health row renders (board UX v4): one shared
 * budget, FIFO queue — lock state, depth, and worker headroom at a glance. */
export interface VerificationQueueView {
  /** True while any run holds the single global lock. */
  readonly lockInUse: boolean;
  readonly activeRuns: number;
  readonly queuedRuns: number;
  /** Total workers allowed across all concurrent runs. */
  readonly workerBudget: number;
  /** Workers handed to each run (budget split across concurrency). */
  readonly workersPerRun: number;
}

interface PersistedSlot {
  readonly run_id: string;
  readonly pid: number | null;
  readonly job_id: string;
  readonly scope: string;
  readonly command: string;
  readonly cwd: string;
  readonly granted_at: number;
}

interface PersistedState {
  readonly version: 1;
  readonly slots: readonly PersistedSlot[];
}

interface ActiveSlot {
  readonly lease: VerificationLease;
  /** True when THIS process minted the slot. Loaded holders from an earlier
   * process are never owned — they are judged by pid/age alone. */
  readonly owned: boolean;
  pid: number | null;
  child: ChildProcess | null;
}

interface Waiter {
  readonly runId: string;
  readonly spec: VerificationRunSpec;
  readonly queuedAt: number;
  readonly promise: Promise<VerificationLease>;
  resolve(lease: VerificationLease): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout | null;
  /** Settled by grant, timeout, sink failure, or dispose — never twice. */
  settled: boolean;
}

export interface VerificationSchedulerOptions {
  /** Instance-state directory; the holder file lives at scheduler.json. */
  readonly storageDir: string;
  readonly limits: VerificationLimits;
  readonly record?: VerificationRecorder;
  readonly log?: Log;
  /**
   * Fired once a run's child process exists (owner incident 2026-09-23):
   * the caller records the pid against the lane worktree so a later
   * teardown reaps it (src/worktrees/manager.ts reaps 'registry' evidence).
   * A `pid` of null means the spawn never produced a pid. Errors are
   * logged, never allowed to fail the run.
   */
  readonly onSpawn?: (info: VerificationSpawnInfo) => void;
  /** Fired after the child exited (normal exit, failure, or timeout kill):
   * the lane's process record can be reconciled. Errors are logged. */
  readonly onSettled?: (info: VerificationSpawnInfo) => void;
  /** Stale-sweep cadence while runs wait (default 15 s). */
  readonly sweepIntervalMs?: number;
  /** How long a holder without an in-process child may live before it is
   * released (default: run_timeout_ms × 2). */
  readonly staleMaxAgeMs?: number;
  /** Grace between the timeout's SIGTERM and the follow-up SIGKILL. */
  readonly killGraceMs?: number;
  /** How long dispose() waits for active children to exit. */
  readonly disposeGraceMs?: number;
  readonly now?: () => number;
}

const STATE_FILE = 'scheduler.json';
/** Bound on the per-run output tail carried in the outcome/ledger. */
const OUTPUT_TAIL_MAX_BYTES = 4 * 1024;
/** Cap on one streamed output frame (bytes of text). */
const OUTPUT_FRAME_MAX_BYTES = 8 * 1024;

function defaultWorkerBudget(): number {
  const cores = availableParallelism();
  return Math.max(1, cores - 2);
}

/** Does a pid exist? EPERM also proves existence (not ours to signal). */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Signal the child's whole process group (detached spawn) so vitest
 * workers cannot outlive a timed-out shell; fall back to the child. */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function splitFrames(text: string): readonly string[] {
  if (Buffer.byteLength(text) <= OUTPUT_FRAME_MAX_BYTES) return [text];
  const frames: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index) as number;
    const charBytes = Buffer.byteLength(String.fromCodePoint(codePoint));
    if (bytes + charBytes > OUTPUT_FRAME_MAX_BYTES && index > start) {
      frames.push(text.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += charBytes;
    index += codePoint > 0xffff ? 2 : 1;
  }
  if (start < text.length) frames.push(text.slice(start));
  return frames;
}

/** Tracked HEAD state at run start (evidence binding). */
function readGitState(cwd: string): { sha: string | null; trackedDirty: boolean } {
  try {
    const sha = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
    const dirty =
      execFileSync('git', ['-C', cwd, 'status', '--porcelain', '--untracked-files=no'], {
        encoding: 'utf-8',
        timeout: 10_000,
      }).trim() !== '';
    return { sha: sha === '' ? null : sha, trackedDirty: dirty };
  } catch {
    return { sha: null, trackedDirty: false };
  }
}

/**
 * The worker-budget environment handed to every run. The vitest knobs are
 * the reference runtime's supported form (BOTH pool families are pinned so
 * threads/forks pools cannot outgrow the budget); `GRU_VERIFY_*` carries
 * the same numbers generically for any other runner.
 */
export function verificationEnvironment(
  base: NodeJS.ProcessEnv,
  input: { runId: string; jobId: string; scope: string; workers: number },
): NodeJS.ProcessEnv {
  const workers = String(input.workers);
  return {
    ...base,
    VITEST_MAX_THREADS: workers,
    VITEST_MIN_THREADS: workers,
    VITEST_MAX_FORKS: workers,
    VITEST_MIN_FORKS: workers,
    GRU_VERIFY_RUN_ID: input.runId,
    GRU_VERIFY_JOB_ID: input.jobId,
    GRU_VERIFY_SCOPE: input.scope,
    GRU_VERIFY_WORKERS: workers,
  };
}

export interface StaleRelease {
  readonly runId: string;
  readonly jobId: string;
  readonly pid: number | null;
  /** `holder-dead`: the recorded pid is gone; `no-runner`: the holder was
   * persisted before any runner existed (nothing can be running); `max-age`:
   * an alive pid that outlived the stale cap (a recycled pid). */
  readonly reason: 'holder-dead' | 'no-runner' | 'max-age';
  readonly ageMs: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class VerificationScheduler {
  private readonly opts: VerificationSchedulerOptions;
  private readonly log: Log;
  private readonly recordEvent: VerificationRecorder;
  private readonly now: () => number;
  private readonly workerBudget: number;
  private readonly staleMaxAgeMs: number;
  private readonly killGraceMs: number;
  private readonly disposeGraceMs: number;
  private readonly sweepIntervalMs: number;
  private readonly stateFile: string;
  private readonly slots = new Map<string, ActiveSlot>();
  private waiters: Waiter[] = [];
  private sweepTimer: NodeJS.Timeout | null = null;
  private started = false;
  private disposed = false;

  constructor(opts: VerificationSchedulerOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.recordEvent = opts.record ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
    if (!Number.isInteger(opts.limits.maxConcurrent) || opts.limits.maxConcurrent < 1) {
      throw new Error(`verification scheduler maxConcurrent must be a positive integer, got ${String(opts.limits.maxConcurrent)}`);
    }
    if (opts.limits.workerBudget < 0 || !Number.isInteger(opts.limits.workerBudget)) {
      throw new Error(`verification scheduler workerBudget must be a non-negative integer, got ${String(opts.limits.workerBudget)}`);
    }
    for (const [label, value] of [
      ['lockWaitTimeoutMs', opts.limits.lockWaitTimeoutMs],
      ['runTimeoutMs', opts.limits.runTimeoutMs],
    ] as const) {
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`verification scheduler ${label} must be a positive integer, got ${String(value)}`);
      }
    }
    this.workerBudget = opts.limits.workerBudget > 0 ? opts.limits.workerBudget : defaultWorkerBudget();
    this.staleMaxAgeMs = opts.staleMaxAgeMs ?? opts.limits.runTimeoutMs * 2;
    this.killGraceMs = opts.killGraceMs ?? 5_000;
    this.disposeGraceMs = opts.disposeGraceMs ?? 3_000;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? 15_000;
    this.stateFile = join(opts.storageDir, STATE_FILE);
  }

  /** Total workers allowed across all concurrent runs. */
  get budget(): number {
    return this.workerBudget;
  }

  /** Effective concurrency: the configured limit, clamped so the worker
   * budget can never be exceeded (budget < max_concurrent ⇒ fewer runs,
   * never more workers). */
  get concurrencyLimit(): number {
    return Math.min(this.opts.limits.maxConcurrent, this.workerBudget);
  }

  /** Workers handed to each run: the global budget split across the
   * effective concurrency limit, never below 1. K × workersPerRun ≤ budget. */
  get workersPerRun(): number {
    return Math.max(1, Math.floor(this.workerBudget / this.concurrencyLimit));
  }

  activeCount(): number {
    return this.slots.size;
  }

  /** Board health-row view: a pure read of the scheduler's live counters. */
  view(): VerificationQueueView {
    return {
      lockInUse: this.slots.size > 0,
      activeRuns: this.activeCount(),
      queuedRuns: this.queuedCount(),
      workerBudget: this.budget,
      workersPerRun: this.workersPerRun,
    };
  }

  queuedCount(): number {
    return this.waiters.length;
  }

  /** Load persisted holders, release stale ones, start the sweep. Idempotent. */
  start(): void {
    if (this.started) return;
    if (this.disposed) throw new VerificationDisposedError();
    mkdirSync(this.opts.storageDir, { recursive: true, mode: 0o700 });
    for (const slot of this.loadState().slots) {
      // A persisted slot never has an in-process child (this is a fresh
      // scheduler): it is an orphan candidate until proven dead or aged out.
      this.slots.set(slot.run_id, {
        lease: {
          runId: slot.run_id,
          jobId: slot.job_id,
          scope: slot.scope,
          command: slot.command,
          cwd: slot.cwd,
          queuedAt: slot.granted_at,
          grantedAt: slot.granted_at,
        },
        pid: slot.pid,
        owned: false,
        child: null,
      });
    }
    this.reconcileStale();
    this.persist();
    this.sweepTimer = setInterval(() => {
      try {
        this.reconcileStale();
      } catch (error) {
        this.log('error', 'verification stale sweep failed', { error: String(error) });
      }
    }, this.sweepIntervalMs);
    this.sweepTimer.unref?.();
    this.started = true;
  }

  /**
   * Release holders that cannot be running. Loaded (unowned) holders are
   * judged by evidence: a dead pid, no recorded runner pid at all (the
   * writer crashed between grant and spawn), or age past the stale cap
   * (a recycled pid must not hold the budget forever). In-process slots
   * are never judged here — their child is the proof of life. Returns what
   * was released.
   */
  reconcileStale(): readonly StaleRelease[] {
    const now = this.now();
    const released: StaleRelease[] = [];
    for (const [runId, slot] of this.slots) {
      if (slot.owned) continue;
      const ageMs = now - slot.lease.grantedAt;
      let reason: StaleRelease['reason'] | null = null;
      if (slot.pid === null) {
        reason = 'no-runner';
      } else if (!pidAlive(slot.pid)) {
        reason = 'holder-dead';
      } else if (ageMs > this.staleMaxAgeMs) {
        reason = 'max-age';
      }
      if (reason === null) continue;
      this.slots.delete(runId);
      released.push({ runId, jobId: slot.lease.jobId, pid: slot.pid, reason, ageMs });
      this.safeRecord({
        kind: 'verification.stale-released',
        jobId: slot.lease.jobId,
        payload: {
          run_id: runId,
          pid: slot.pid,
          scope: slot.lease.scope,
          reason,
          age_ms: ageMs,
        },
      });
      this.log('warn', 'stale verification holder released', {
        run: runId,
        pid: slot.pid,
        reason,
        age_ms: ageMs,
      });
    }
    if (released.length > 0) {
      this.persistBestEffort();
      this.pump();
    }
    return released;
  }

  /**
   * Acquire one slot (FIFO when the budget is full). `sink` receives the
   * `queued` frame before anything else for this run — position 0 means
   * granted now. The capacity decision and the state mutation happen
   * atomically (no await between them), so racing callers can never both
   * pass a check for the last free slot.
   */
  async acquire(spec: VerificationRunSpec, sink: VerificationProgressSink = () => {}): Promise<VerificationLease> {
    if (this.disposed) throw new VerificationDisposedError();
    if (!this.started) this.start();
    this.reconcileStale();
    const runId = randomUUID();
    const queuedAt = this.now();
    if (this.slots.size < this.concurrencyLimit) {
      // Claim BEFORE the frame: the check and the insert must not be
      // separated by an await, or two racing callers could both pass.
      const lease = this.mintLease(runId, spec, queuedAt);
      const active = this.slots.size;
      this.slots.set(runId, { lease, owned: true, pid: null, child: null });
      try {
        await sink({ type: 'queued', runId, position: 0, active, limit: this.concurrencyLimit });
      } catch (error) {
        this.release(lease); // the caller never received the lease — do not leak the slot
        throw error;
      }
      if (this.disposed) throw new VerificationDisposedError(); // dispose dropped the claim
      return lease;
    }
    // Full: enqueue synchronously so dispose() and the wait timeout can
    // always settle this waiter, then emit the queued frame.
    let resolveWaiter!: (lease: VerificationLease) => void;
    let rejectWaiter!: (error: Error) => void;
    const promise = new Promise<VerificationLease>((resolve, reject) => {
      resolveWaiter = resolve;
      rejectWaiter = reject;
    });
    const waiter: Waiter = {
      runId,
      spec,
      queuedAt,
      promise,
      resolve: resolveWaiter,
      reject: rejectWaiter,
      timer: null,
      settled: false,
    };
    const timeoutMs = this.opts.limits.lockWaitTimeoutMs;
    if (timeoutMs > 0) {
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return; // granted or dropped while this timer was due
        this.dropWaiter(waiter);
        const waitMs = this.now() - queuedAt;
        this.safeRecord({
          kind: 'verification.lock-timeout',
          jobId: spec.jobId,
          payload: {
            run_id: runId,
            scope: spec.scope,
            command: spec.command,
            wait_ms: waitMs,
            active: this.slots.size,
            queued: this.waiters.length,
          },
        });
        this.log('warn', 'verification lock wait timed out', {
          run: runId,
          job: spec.jobId,
          wait_ms: waitMs,
        });
        rejectWaiter(new VerificationLockTimeoutError(waitMs, this.slots.size, this.waiters.length));
      }, timeoutMs);
      waiter.timer.unref?.();
    }
    this.waiters.push(waiter);
    try {
      await sink({
        type: 'queued',
        runId,
        position: this.waiters.indexOf(waiter) + 1,
        active: this.slots.size,
        limit: this.concurrencyLimit,
      });
    } catch (error) {
      this.dropWaiter(waiter);
      // If a grant raced the failing frame, release the slot too — the
      // caller never received the lease.
      void promise.then(
        (lease) => this.release(lease),
        () => {},
      );
      throw error;
    }
    return promise;
  }

  /** Release a lease (idempotent) and grant the next FIFO waiter. */
  release(lease: VerificationLease): void {
    if (!this.slots.delete(lease.runId)) return;
    this.persistBestEffort();
    this.pump();
  }

  /**
   * The production entry: acquire, run the command in its lane worktree
   * under the global budget, stream progress, release. The returned
   * outcome is always produced (a failed/timed-out run is an outcome,
   * a lock-wait timeout throws {@link VerificationLockTimeoutError}).
   */
  async run(
    spec: VerificationRunSpec,
    sink: VerificationProgressSink = () => {},
  ): Promise<VerificationOutcome> {
    const lease = await this.acquire(spec, sink);
    try {
      const outcome = await this.execute(lease, sink);
      await sink({ type: 'completed', runId: lease.runId, outcome });
      return outcome;
    } finally {
      this.release(lease);
    }
  }

  /** Terminate active runs and refuse new work (service shutdown). */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const waiter of this.waiters.splice(0)) {
      waiter.settled = true;
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      waiter.reject(new VerificationDisposedError());
    }
    const children = [...this.slots.values()]
      .map((slot) => slot.child)
      .filter((child): child is ChildProcess => child !== null);
    const exits = children.map(
      (child) =>
        new Promise<void>((resolveExit) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolveExit();
            return;
          }
          child.once('exit', () => resolveExit());
        }),
    );
    for (const child of children) signalGroup(child, 'SIGTERM');
    await Promise.race([Promise.all(exits), delay(this.disposeGraceMs)]);
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) signalGroup(child, 'SIGKILL');
    }
    // Drop every slot THIS process owns — including one granted but never
    // spawned, so a racing execute() fails loud instead of spawning an
    // unmanaged child after shutdown. Loaded orphans we never owned stay in
    // the state file (their pids may still be live for the next process).
    for (const [runId, slot] of [...this.slots]) {
      if (slot.owned) this.slots.delete(runId);
    }
    this.persistBestEffort();
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private mintLease(runId: string, spec: VerificationRunSpec, queuedAt: number): VerificationLease {
    return {
      runId,
      jobId: spec.jobId,
      scope: spec.scope,
      command: spec.command,
      cwd: spec.cwd,
      queuedAt,
      grantedAt: this.now(),
    };
  }

  /** Drop a queued waiter exactly once (timeout, sink failure). */
  private dropWaiter(waiter: Waiter): void {
    waiter.settled = true;
    if (waiter.timer !== null) {
      clearTimeout(waiter.timer);
      waiter.timer = null;
    }
    const index = this.waiters.indexOf(waiter);
    if (index >= 0) this.waiters.splice(index, 1);
  }

  /** Grant FIFO waiters while capacity remains. */
  private pump(): void {
    while (!this.disposed && this.waiters.length > 0 && this.slots.size < this.concurrencyLimit) {
      const waiter = this.waiters.shift() as Waiter;
      waiter.settled = true;
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      const lease = this.mintLease(waiter.runId, waiter.spec, waiter.queuedAt);
      this.slots.set(waiter.runId, { lease, owned: true, pid: null, child: null });
      waiter.resolve(lease);
    }
  }

  private async execute(
    lease: VerificationLease,
    sink: VerificationProgressSink,
  ): Promise<VerificationOutcome> {
    const workers = this.workersPerRun;
    const git = readGitState(lease.cwd);
    const slot = this.slots.get(lease.runId);
    if (slot === undefined) throw new VerificationDisposedError(); // disposed between grant and spawn
    const child = spawn('/bin/sh', ['-c', lease.command], {
      cwd: lease.cwd,
      env: verificationEnvironment(process.env, {
        runId: lease.runId,
        jobId: lease.jobId,
        scope: lease.scope,
        workers,
      }),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    slot.pid = child.pid ?? null;
    slot.child = child;
    this.callbackSafe('onSpawn', () =>
      this.opts.onSpawn?.({ lease, pid: child.pid ?? null, command: child.spawnargs.join(' ') }),
    );
    // Decode at the stream boundary so multi-byte characters split across
    // OS pipe chunks never corrupt the streamed output or the tail.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    this.persistBestEffort();

    const startedAt = this.now();
    const queuedMs = startedAt - lease.queuedAt;
    this.safeRecord({
      kind: 'verification.started',
      jobId: lease.jobId,
      payload: {
        run_id: lease.runId,
        scope: lease.scope,
        command: lease.command,
        cwd: lease.cwd,
        sha: git.sha,
        workers,
        queued_ms: queuedMs,
      },
    });
    await sink({
      type: 'started',
      runId: lease.runId,
      workers,
      sha: git.sha,
      queuedMs,
    });

    let exitCode: number | null = null;
    let signal: string | null = null;
    let timedOut = false;
    const hash = createHash('sha256');
    let outputBytes = 0;
    let outputTail = '';

    const consume = async (stream: Readable | null, streamName: 'stdout' | 'stderr'): Promise<void> => {
      if (stream === null) return;
      for await (const chunk of stream) {
        const text = Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk);
        outputBytes += Buffer.byteLength(text);
        hash.update(text);
        outputTail = (outputTail + text).slice(-OUTPUT_TAIL_MAX_BYTES);
        for (const frame of splitFrames(text)) {
          await sink({ type: 'output', runId: lease.runId, stream: streamName, text: frame });
        }
      }
    };
    let runError: Error | null = null;
    const streamsDone = Promise.all([
      consume(child.stdout, 'stdout'),
      consume(child.stderr, 'stderr'),
    ]).catch((error: unknown) => {
      runError ??= error instanceof Error ? error : new Error(String(error));
    });
    const exited = new Promise<void>((resolveExit) => {
      child.once('error', (error: Error) => {
        runError = error;
        resolveExit();
      });
      child.once('exit', (code: number | null, exitSignal: NodeJS.Signals | null) => {
        exitCode = code;
        signal = exitSignal;
        resolveExit();
      });
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      signalGroup(child, 'SIGTERM');
      const killTimer = setTimeout(() => signalGroup(child, 'SIGKILL'), this.killGraceMs);
      killTimer.unref?.();
    }, this.opts.limits.runTimeoutMs);
    timeoutTimer.unref?.();
    try {
      await exited;
      // Streams normally close with the process; cap the drain so an
      // inherited pipe from a stray grandchild cannot hold the slot.
      await Promise.race([streamsDone, delay(2_000)]);
    } finally {
      clearTimeout(timeoutTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    // The child is gone (exit or spawn error): reconcile the lane record.
    this.callbackSafe('onSettled', () =>
      this.opts.onSettled?.({ lease, pid: child.pid ?? null, command: child.spawnargs.join(' ') }),
    );

    const durationMs = this.now() - startedAt;
    const ok = !timedOut && runError === null && exitCode === 0 && signal === null;
    const outcome: VerificationOutcome = {
      runId: lease.runId,
      jobId: lease.jobId,
      scope: lease.scope,
      command: lease.command,
      cwd: lease.cwd,
      ok,
      exitCode,
      signal,
      timedOut,
      queuedMs,
      durationMs,
      sha: git.sha,
      trackedDirty: git.trackedDirty,
      workers,
      outputBytes,
      outputSha256: hash.digest('hex'),
      outputTail,
      error: runError === null ? null : String(runError),
    };
    this.safeRecord({
      kind: 'verification.completed',
      jobId: lease.jobId,
      payload: outcomePayload(outcome),
    });
    return outcome;
  }

  private loadState(): PersistedState {
    let text: string;
    try {
      text = readFileSync(this.stateFile, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, slots: [] };
      throw new Error(`verification scheduler state is unreadable: ${String(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`verification scheduler state ${this.stateFile} is not valid JSON: ${String(error)}`);
    }
    const state = parsed as Partial<PersistedState>;
    if (state === null || typeof state !== 'object' || state.version !== 1 || !Array.isArray(state.slots)) {
      throw new Error(`verification scheduler state ${this.stateFile} has an unsupported shape (version must be 1)`);
    }
    return { version: 1, slots: state.slots as readonly PersistedSlot[] };
  }

  /** Atomic persist: the file is replaced whole, never half-written. */
  private persist(): void {
    const state: PersistedState = {
      version: 1,
      slots: [...this.slots.values()].map((slot) => ({
        run_id: slot.lease.runId,
        pid: slot.pid,
        job_id: slot.lease.jobId,
        scope: slot.lease.scope,
        command: slot.lease.command,
        cwd: slot.lease.cwd,
        granted_at: slot.lease.grantedAt,
      })),
    };
    const temporary = `${this.stateFile}.tmp-${process.pid}-${this.now()}`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.stateFile);
  }

  private persistBestEffort(): void {
    try {
      this.persist();
    } catch (error) {
      // The in-process budget stays authoritative; the durable holder file
      // is only stale-detection aid. Loud, never silent.
      this.log('error', 'verification scheduler state write failed', {
        path: this.stateFile,
        error: String(error),
      });
    }
  }

  private safeRecord(record: VerificationRecord): void {
    try {
      this.recordEvent(record);
    } catch (error) {
      this.log('error', 'verification ledger record failed', {
        kind: record.kind,
        job: record.jobId,
        error: String(error),
      });
    }
  }

  /** A spawn/settle callback must never fail the run it reports on. */
  private callbackSafe(name: string, call: () => void): void {
    try {
      call();
    } catch (error) {
      this.log('error', `verification ${name} callback failed`, { error: String(error) });
    }
  }
}

/** The ledger payload for a completed run (also what review evidence reads). */
export function outcomePayload(outcome: VerificationOutcome): Record<string, unknown> {
  return {
    run_id: outcome.runId,
    scope: outcome.scope,
    command: outcome.command,
    cwd: outcome.cwd,
    sha: outcome.sha,
    tracked_dirty: outcome.trackedDirty,
    ok: outcome.ok,
    exit_code: outcome.exitCode,
    signal: outcome.signal,
    timed_out: outcome.timedOut,
    queued_ms: outcome.queuedMs,
    duration_ms: outcome.durationMs,
    workers: outcome.workers,
    output_bytes: outcome.outputBytes,
    output_sha256: outcome.outputSha256,
    output_tail: outcome.outputTail,
    error: outcome.error,
  };
}
