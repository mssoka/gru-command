import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
  /**
   * Client-minted idempotency key (issue #159): the SAME request_id always
   * reconciles to the same attempt — an in-flight submission attaches, a
   * completed one replays its recorded terminal outcome, and a typed
   * never-started admission failure may be retried. Omitted = no durable
   * identity beyond the single-flight key.
   */
  readonly requestId?: string;
  /**
   * Tracked HEAD resolved at submission; part of the single-flight key so
   * a changed head is a NEW verification, never a duplicate attach. The
   * outcome still binds the true head execute() reads at spawn.
   */
  readonly head?: string | null;
}

export interface VerificationLease {
  readonly runId: string;
  readonly jobId: string;
  readonly scope: string;
  readonly command: string;
  readonly cwd: string;
  readonly head: string | null;
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
      readonly type: 'attached';
      readonly runId: string;
      readonly state: 'queued' | 'running';
      readonly requestId: string | null;
      readonly head: string | null;
      readonly dedupeKey: string;
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
  | {
      readonly type: 'completed';
      readonly runId: string;
      readonly outcome: VerificationOutcome;
      /** True when a replayed request_id returned the recorded outcome
       * instead of running a new producer. */
      readonly reconciled?: boolean;
    };

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

/**
 * Raised when an identical (job, lane, scope, head, command) submission is
 * already represented by a holder THIS process does not own — a restart
 * orphan whose runner may still be alive. The caller reconciles against the
 * named run; a second producer is never minted (issue #159).
 */
export class VerificationDuplicateError extends Error {
  readonly code = 'duplicate_in_flight';
  constructor(
    readonly runId: string,
    readonly state: 'queued' | 'running',
    detail?: string,
  ) {
    super(detail ?? `an identical verification is already in flight as run ${runId} (${state})`);
    this.name = 'VerificationDuplicateError';
  }
}

/** Raised when a request_id is replayed with a different job/scope/head. */
export class VerificationRequestConflictError extends Error {
  readonly code = 'request_id_conflict';
  constructor(readonly requestId: string) {
    super(`request_id "${requestId}" is bound to a different verification spec — mint a new request_id`);
    this.name = 'VerificationRequestConflictError';
  }
}

/**
 * Raised when a terminal request identity is no longer retained for replay
 * (its full outcome was evicted from the bounded history cache, or a crash
 * interrupted it): replaying it would be an unknown-authority rerun. The
 * ledger keeps the run's record; the caller mints a fresh identity.
 */
export class VerificationRequestExpiredError extends Error {
  readonly code = 'request_id_expired';
  constructor(
    readonly requestId: string,
    readonly runId: string,
    readonly terminalState: 'completed' | 'interrupted',
  ) {
    super(
      `request_id "${requestId}" reached a terminal ${terminalState} state (run ${runId}) whose outcome is not retained for replay — ` +
        'refusing to rerun; inspect the ledger verification.completed record and mint a NEW request_id for any re-verification',
    );
    this.name = 'VerificationRequestExpiredError';
  }
}

/** The client-supplied request identity grammar (bounded; URL-safe). */
export const VERIFICATION_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export function isValidVerificationRequestId(value: string): boolean {
  return VERIFICATION_REQUEST_ID_PATTERN.test(value);
}

export type VerificationAttemptState =
  | 'unknown'
  | 'accepted'
  | 'running'
  | 'completed'
  | 'admission-failed'
  /** Started before a crash/restart; its outcome was never recorded and it
   * is not replayable — a re-verification uses a NEW request identity. */
  | 'interrupted';

/** The reconcile answer for `GET /api/verify/status` (issue #159). */
export interface VerificationAttemptStatus {
  readonly state: VerificationAttemptState;
  readonly requestId: string | null;
  readonly runId: string | null;
  readonly jobId: string | null;
  readonly scope: string | null;
  readonly command: string | null;
  readonly cwd: string | null;
  readonly head: string | null;
  readonly trackedDirty: boolean | null;
  /** True once the run's child exists (a `started` frame was emitted).
   * An admission failure with started=false may be retried. */
  readonly started: boolean;
  /** Terminal outcome, present only for state 'completed'. */
  readonly outcome?: VerificationOutcome;
  /** Typed failure for 'admission-failed'. */
  readonly error?: { readonly code: string; readonly detail: string };
}

export interface VerificationAttemptLookup {
  readonly requestId?: string;
  readonly jobId?: string;
  readonly scope?: string;
  readonly cwd?: string;
  readonly head?: string | null;
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
  readonly head?: string | null;
  /** Client request identities bound to this holder (reconcile across restart). */
  readonly request_ids?: readonly string[];
  readonly granted_at: number;
}

interface PersistedAttempt {
  readonly request_id: string;
  readonly run_id: string;
  readonly job_id: string;
  readonly scope: string;
  readonly command: string;
  readonly cwd: string;
  readonly head: string | null;
  readonly tracked_dirty: boolean;
  readonly started: boolean;
  readonly state: 'completed' | 'admission-failed';
  readonly completed_at: number;
  readonly outcome: Record<string, unknown> | null;
  readonly error: { readonly code: string; readonly detail: string } | null;
}

interface PersistedState {
  readonly version: 1;
  readonly slots: readonly PersistedSlot[];
  readonly attempts?: readonly PersistedAttempt[];
}

/**
 * Durable terminal identity (append-only `requests.ndjson`). The bounded
 * in-memory history carries replayable outcomes; this index guarantees an
 * identity is NEVER silently forgotten and rerun — an evicted or
 * crash-interrupted identity answers as terminal and refuses replay.
 */
type TerminalIdentityState = 'completed' | 'admission-failed' | 'interrupted';

interface TerminalIdentity {
  readonly request_id: string;
  readonly run_id: string;
  readonly state: TerminalIdentityState;
  readonly job_id: string;
  readonly scope: string;
  readonly command: string;
  readonly cwd: string;
  readonly head: string | null;
  readonly started: boolean;
  readonly completed_at: number;
}

/** One in-flight single-flight attempt: the shared producer plus every attached sink. */
interface Attempt {
  readonly key: string;
  readonly runId: string;
  readonly spec: VerificationRunSpec;
  readonly head: string | null;
  /** Every client request identity bound to this producer (primary + attached). */
  readonly requestIds: Set<string>;
  readonly sinks: Set<VerificationProgressSink>;
  readonly promise: Promise<VerificationOutcome>;
  resolve(outcome: VerificationOutcome): void;
  reject(error: Error): void;
  /** Serialized fan-out: an `attached` frame can never overtake a terminal one. */
  queue: Promise<void>;
  started: boolean;
  outcome: VerificationOutcome | null;
  lease: VerificationLease | null;
}

/** Terminal request_id evidence kept (bounded) for reconnect reconciliation. */
interface RequestHistoryEntry {
  readonly state: 'completed' | 'admission-failed';
  readonly spec: VerificationRunSpec;
  readonly head: string | null;
  readonly completedAt: number;
  readonly outcome: VerificationOutcome | null;
  readonly started: boolean;
  readonly error: { readonly code: string; readonly detail: string } | null;
}

interface ActiveSlot {
  readonly lease: VerificationLease;
  /** True when THIS process minted the slot. Loaded holders from an earlier
   * process are never owned — they are judged by pid/age alone. */
  readonly owned: boolean;
  pid: number | null;
  child: ChildProcess | null;
  /** Client request identities bound to this holder. */
  requestIds: readonly string[];
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
/** Append-only terminal request identities (outlives bounded outcome history). */
const REQUEST_LOG_FILE = 'requests.ndjson';
/** Bound on the per-run output tail carried in the outcome/ledger. */
const OUTPUT_TAIL_MAX_BYTES = 4 * 1024;
/** Bound on completed/admission-failed request records kept for reconciliation. */
const MAX_REQUEST_HISTORY = 64;
/** The output tail retained in a persisted request record (bounded state file). */
const PERSISTED_TAIL_CHARS = 512;

function normalizeRequestId(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!VERIFICATION_REQUEST_ID_PATTERN.test(value)) {
    throw new Error(
      `verification request_id must match ${String(VERIFICATION_REQUEST_ID_PATTERN)} (≤128 URL-safe chars), got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** The single-flight identity: same job + lane + scope + head + command. */
function attemptKey(spec: VerificationRunSpec, head: string | null): string {
  return [spec.jobId, spec.cwd, spec.scope, head ?? 'no-head', spec.command].join('\u0000');
}

function sameSubmission(
  left: Pick<VerificationRunSpec, 'jobId' | 'scope' | 'cwd' | 'command'>,
  leftHead: string | null,
  right: Pick<VerificationRunSpec, 'jobId' | 'scope' | 'cwd' | 'command'>,
  rightHead: string | null,
): boolean {
  return (
    left.jobId === right.jobId &&
    left.scope === right.scope &&
    left.cwd === right.cwd &&
    left.command === right.command &&
    leftHead === rightHead
  );
}

/** Validate one append-only terminal identity line. */
function parseTerminalIdentity(value: unknown): TerminalIdentity | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const requestId = record['request_id'];
  const runId = record['run_id'];
  const state = record['state'];
  const jobId = record['job_id'];
  const scope = record['scope'];
  const command = record['command'];
  const cwd = record['cwd'];
  const head = record['head'];
  const started = record['started'];
  const completedAt = record['completed_at'];
  if (typeof requestId !== 'string' || !VERIFICATION_REQUEST_ID_PATTERN.test(requestId)) return null;
  if (typeof runId !== 'string' || runId === '') return null;
  if (state !== 'completed' && state !== 'admission-failed' && state !== 'interrupted') return null;
  if (
    typeof jobId !== 'string' ||
    typeof scope !== 'string' ||
    typeof command !== 'string' ||
    typeof cwd !== 'string'
  ) {
    return null;
  }
  if (head !== null && typeof head !== 'string') return null;
  if (typeof started !== 'boolean') return null;
  if (typeof completedAt !== 'number' || !Number.isFinite(completedAt)) return null;
  return {
    request_id: requestId,
    run_id: runId,
    state,
    job_id: jobId,
    scope,
    command,
    cwd,
    head,
    started,
    completed_at: completedAt,
  };
}
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

/** Tracked HEAD state at submission and at run start (evidence binding). */
export function readGitState(cwd: string): { sha: string | null; trackedDirty: boolean } {
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
  private readonly requestLogFile: string;
  private readonly slots = new Map<string, ActiveSlot>();
  /** In-flight single-flight attempts by dedupe key (issue #159). */
  private readonly attempts = new Map<string, Attempt>();
  /** The same attempts by client request identity. */
  private readonly attemptsByRequest = new Map<string, Attempt>();
  /** Bounded terminal request history for reconnect reconciliation. */
  private readonly requestHistory = new Map<string, RequestHistoryEntry>();
  /** Append-only terminal identities: NEVER silently forgotten -> never rerun. */
  private readonly requestIndex = new Map<string, TerminalIdentity>();
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
    this.requestLogFile = join(opts.storageDir, REQUEST_LOG_FILE);
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
    this.loadRequestIndex();
    const persisted = this.loadState();
    for (const attempt of persisted.attempts ?? []) {
      this.requestHistory.set(attempt.request_id, {
        state: attempt.state,
        spec: {
          jobId: attempt.job_id,
          scope: attempt.scope,
          command: attempt.command,
          cwd: attempt.cwd,
          head: attempt.head,
        },
        head: attempt.head,
        completedAt: attempt.completed_at,
        outcome: attempt.state === 'completed' ? outcomeFromPersisted(attempt) : null,
        started: attempt.started,
        error: attempt.error,
      });
    }
    for (const slot of persisted.slots) {
      // A persisted slot never has an in-process child (this is a fresh
      // scheduler): it is an orphan candidate until proven dead or aged out.
      this.slots.set(slot.run_id, {
        lease: {
          runId: slot.run_id,
          jobId: slot.job_id,
          scope: slot.scope,
          command: slot.command,
          cwd: slot.cwd,
          head: slot.head ?? null,
          queuedAt: slot.granted_at,
          grantedAt: slot.granted_at,
        },
        pid: slot.pid,
        owned: false,
        child: null,
        requestIds: slot.request_ids ?? [],
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
      // A started orphan's outcome is unrecorded: mark every bound identity
      // interrupted so a reconnect reports the truth and refuses a rerun.
      const interrupted =
        slot.pid === null ? [] : this.markInterruptedIdentities(slot);
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
          interrupted_request_ids: interrupted,
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
  async acquire(
    spec: VerificationRunSpec,
    sink: VerificationProgressSink = () => {},
    runId: string = randomUUID(),
  ): Promise<VerificationLease> {
    if (this.disposed) throw new VerificationDisposedError();
    if (!this.started) this.start();
    this.reconcileStale();
    const queuedAt = this.now();
    if (this.slots.size < this.concurrencyLimit) {
      // Claim BEFORE the frame: the check and the insert must not be
      // separated by an await, or two racing callers could both pass.
      const lease = this.mintLease(runId, spec, queuedAt);
      const active = this.slots.size;
      this.slots.set(runId, {
        lease,
        owned: true,
        pid: null,
        child: null,
        requestIds: spec.requestId === undefined ? [] : [spec.requestId],
      });
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
            request_id: spec.requestId ?? null,
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
   * The production entry: single-flight admission, run the command in its
   * lane worktree under the global budget, stream progress, release. The
   * returned outcome is always produced (a failed/timed-out run is an
   * outcome, a lock-wait timeout throws {@link VerificationLockTimeoutError}).
   *
   * Identical submissions share ONE producer (issue #159): a duplicate
   * attaches to the in-flight attempt and receives the same terminal
   * outcome; a `request_id` replay of a completed attempt returns the
   * RECORDED outcome (no rerun); a typed never-started admission failure
   * may be retried. A changed head or a completed run is never permanently
   * suppressed — a fresh submission mints a fresh producer.
   */
  async submit(
    spec: VerificationRunSpec,
    sink: VerificationProgressSink = () => {},
  ): Promise<VerificationOutcome> {
    if (this.disposed) throw new VerificationDisposedError();
    if (!this.started) this.start();
    // A dead/orphaned holder must not masquerade as an in-flight duplicate.
    this.reconcileStale();
    const requestId = normalizeRequestId(spec.requestId);
    const head = spec.head !== undefined ? spec.head : readGitState(spec.cwd).sha;
    const resolvedSpec: VerificationRunSpec = { ...spec, head };
    const key = attemptKey(resolvedSpec, head);

    // Durable request identity first: a replay reconciles to the recorded
    // terminal state instead of minting a second producer.
    if (requestId !== null) {
      const history = this.requestHistory.get(requestId);
      if (history !== undefined) {
        if (!sameSubmission(history.spec, history.head, resolvedSpec, head)) {
          throw new VerificationRequestConflictError(requestId);
        }
        if (history.state === 'completed') {
          if (history.outcome === null) {
            // Recorded completion without a replayable outcome: rerunning
            // would be a replay of unknown authority — refuse loud instead.
            throw new Error(
              `recorded outcome for request_id "${requestId}" is unreadable — refusing to rerun; inspect the ledger verification.completed record`,
            );
          }
          await this.writeFrame(sink, {
            type: 'completed',
            runId: history.outcome.runId,
            outcome: history.outcome,
            reconciled: true,
          });
          this.safeRecord({
            kind: 'verification.reconciled',
            jobId: resolvedSpec.jobId,
            payload: {
              request_id: requestId,
              run_id: history.outcome.runId,
              state: 'completed',
              scope: resolvedSpec.scope,
              head,
            },
          });
          return history.outcome;
        }
        // Admission failure with no started run: the retry is explicitly
        // allowed — drop the record and admit a fresh attempt.
        this.requestHistory.delete(requestId);
        this.persistBestEffort();
      }
      // A live producer bound to this identity wins even when the head or
      // command drifted while it waited: the accepted execution is the run
      // the reconnect must reconcile with (its spawn-time head check
      // reports any real drift honestly).
      const bound = this.attemptsByRequest.get(requestId);
      if (bound !== undefined) {
        if (
          bound.spec.jobId !== resolvedSpec.jobId ||
          bound.spec.scope !== resolvedSpec.scope ||
          bound.spec.cwd !== resolvedSpec.cwd
        ) {
          throw new VerificationRequestConflictError(requestId);
        }
        await this.attach(bound, sink, requestId);
        return bound.promise;
      }
      // A terminal identity whose full outcome is no longer retained (evicted
      // from the bounded history, or crash-interrupted) is NEVER rerun: the
      // ledger holds the record; the caller mints a new identity.
      const known = this.requestIndex.get(requestId);
      if (known !== undefined) {
        if (known.state === 'admission-failed') {
          this.requestIndex.delete(requestId);
        } else {
          throw new VerificationRequestExpiredError(requestId, known.run_id, known.state);
        }
      }
    }

    const inFlight = this.attempts.get(key);
    if (inFlight !== undefined) {
      await this.attach(inFlight, sink, requestId);
      return inFlight.promise;
    }

    // A persisted holder THIS process does not own already represents an
    // identical submission (a restart orphan whose runner may be alive):
    // refuse to mint a producer and name the run for reconciliation.
    for (const slot of this.slots.values()) {
      if (slot.owned) continue;
      if (
        slot.lease.jobId === resolvedSpec.jobId &&
        slot.lease.scope === resolvedSpec.scope &&
        slot.lease.cwd === resolvedSpec.cwd &&
        slot.lease.command === resolvedSpec.command &&
        (slot.lease.head == null || slot.lease.head === head)
      ) {
        throw new VerificationDuplicateError(slot.lease.runId, 'running');
      }
    }

    const attempt = this.createAttempt(key, resolvedSpec, head, requestId, sink);
    this.attempts.set(key, attempt);
    for (const id of attempt.requestIds) this.attemptsByRequest.set(id, attempt);
    this.safeRecord({
      kind: 'verification.requested',
      jobId: resolvedSpec.jobId,
      payload: {
        request_id: requestId,
        run_id: attempt.runId,
        scope: resolvedSpec.scope,
        command: resolvedSpec.command,
        cwd: resolvedSpec.cwd,
        head,
        dedupe_key: key,
      },
    });
    void this.executeAttempt(attempt);
    return attempt.promise;
  }

  /** Back-compat production entry; identical to {@link submit}. */
  async run(
    spec: VerificationRunSpec,
    sink: VerificationProgressSink = () => {},
  ): Promise<VerificationOutcome> {
    return this.submit(spec, sink);
  }

  /**
   * Reconcile surface (issue #159): answer accepted/running/completed/
   * admission-failed for a request identity, or for a job/scope/head
   * lookup. A completed attempt replays its recorded outcome; a started
   * attempt is never replayable as a new run.
   */
  attemptStatus(lookup: VerificationAttemptLookup): VerificationAttemptStatus {
    if (this.started) this.reconcileStale();
    const requestId = normalizeRequestId(lookup.requestId);
    if (requestId !== null) {
      const inFlight = this.attemptsByRequest.get(requestId);
      if (inFlight !== undefined) return statusFromAttempt(inFlight, requestId);
      const history = this.requestHistory.get(requestId);
      if (history !== undefined) {
        return {
          state: history.state,
          requestId,
          runId: history.outcome?.runId ?? null,
          jobId: history.spec.jobId,
          scope: history.spec.scope,
          command: history.spec.command,
          cwd: history.spec.cwd,
          head: history.head,
          trackedDirty: history.outcome?.trackedDirty ?? null,
          started: history.started,
          ...(history.outcome !== null ? { outcome: history.outcome } : {}),
          ...(history.error !== null ? { error: history.error } : {}),
        };
      }
      // A restart orphan keeps the request identity on its persisted holder
      // so a reconnect still reconciles to the run instead of replaying.
      for (const slot of this.slots.values()) {
        if (!slot.requestIds.includes(requestId)) continue;
        return {
          state: slot.pid === null ? 'accepted' : 'running',
          requestId,
          runId: slot.lease.runId,
          jobId: slot.lease.jobId,
          scope: slot.lease.scope,
          command: slot.lease.command,
          cwd: slot.lease.cwd,
          head: slot.lease.head,
          trackedDirty: null,
          started: slot.pid !== null,
        };
      }
      // Durable terminal identities survive outcome eviction and restarts:
      // report the terminal state (without the evicted outcome), never
      // `unknown` — an unknown answer is not replay authority.
      const known = this.requestIndex.get(requestId);
      if (known !== undefined) {
        return {
          state: known.state,
          requestId,
          runId: known.run_id,
          jobId: known.job_id,
          scope: known.scope,
          command: known.command,
          cwd: known.cwd,
          head: known.head,
          trackedDirty: null,
          started: known.started,
        };
      }
      // An explicit unknown request identity never borrows another
      // attempt's state through a job fallback.
      return {
        state: 'unknown',
        requestId,
        runId: null,
        jobId: lookup.jobId ?? null,
        scope: lookup.scope ?? null,
        command: null,
        cwd: lookup.cwd ?? null,
        head: lookup.head ?? null,
        trackedDirty: null,
        started: false,
      };
    }

    const jobId = lookup.jobId !== undefined && lookup.jobId !== '' ? lookup.jobId : null;
    if (jobId !== null) {
      for (const attempt of this.attempts.values()) {
        if (attempt.spec.jobId !== jobId) continue;
        if (lookup.scope !== undefined && attempt.spec.scope !== lookup.scope) continue;
        if (lookup.cwd !== undefined && attempt.spec.cwd !== lookup.cwd) continue;
        if (lookup.head !== undefined && attempt.head !== lookup.head) continue;
        return statusFromAttempt(attempt, null);
      }
      for (const slot of this.slots.values()) {
        if (slot.owned || slot.lease.jobId !== jobId) continue;
        if (lookup.scope !== undefined && slot.lease.scope !== lookup.scope) continue;
        if (lookup.cwd !== undefined && slot.lease.cwd !== lookup.cwd) continue;
        if (lookup.head !== undefined && slot.lease.head !== lookup.head) continue;
        return {
          state: 'running',
          requestId: null,
          runId: slot.lease.runId,
          jobId: slot.lease.jobId,
          scope: slot.lease.scope,
          command: slot.lease.command,
          cwd: slot.lease.cwd,
          head: slot.lease.head,
          trackedDirty: null,
          started: true,
        };
      }
    }

    return {
      state: 'unknown',
      requestId,
      runId: null,
      jobId,
      scope: lookup.scope ?? null,
      command: null,
      cwd: lookup.cwd ?? null,
      head: lookup.head ?? null,
      trackedDirty: null,
      started: false,
    };
  }

  /** In-flight attempt count by dedupe key (board/tests). */
  inFlightCount(): number {
    return this.attempts.size;
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

  /** Mint the shared producer for one dedupe key. */
  private createAttempt(
    key: string,
    spec: VerificationRunSpec,
    head: string | null,
    requestId: string | null,
    sink: VerificationProgressSink,
  ): Attempt {
    let resolveAttempt!: (outcome: VerificationOutcome) => void;
    let rejectAttempt!: (error: Error) => void;
    const promise = new Promise<VerificationOutcome>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    return {
      key,
      runId: randomUUID(),
      spec,
      head,
      requestIds: new Set(requestId === null ? [] : [requestId]),
      sinks: new Set([sink]),
      promise,
      resolve: resolveAttempt,
      reject: rejectAttempt,
      queue: Promise.resolve(),
      started: false,
      outcome: null,
      lease: null,
    };
  }

  /** Attach a duplicate submission to the in-flight producer (issue #159). */
  private async attach(
    attempt: Attempt,
    sink: VerificationProgressSink,
    requestId: string | null,
  ): Promise<void> {
    attempt.sinks.add(sink);
    if (requestId !== null) {
      attempt.requestIds.add(requestId);
      this.attemptsByRequest.set(requestId, attempt);
      const slot = this.slots.get(attempt.runId);
      if (slot !== undefined) slot.requestIds = [...attempt.requestIds];
      this.persistBestEffort();
    }
    this.safeRecord({
      kind: 'verification.attached',
      jobId: attempt.spec.jobId,
      payload: {
        request_id: requestId,
        run_id: attempt.runId,
        scope: attempt.spec.scope,
        head: attempt.head,
        state: attempt.started ? 'running' : 'queued',
      },
    });
    await this.broadcast(attempt, {
      type: 'attached',
      runId: attempt.runId,
      state: attempt.started ? 'running' : 'queued',
      requestId,
      head: attempt.head,
      dedupeKey: attempt.key,
    });
    // A terminal frame is enqueued with a snapshot of the sinks that existed
    // at that instant. An attach whose `attached` frame was queued after that
    // snapshot would otherwise end at EOF without a completed frame: deliver
    // the recorded outcome to this sink explicitly.
    if (attempt.outcome !== null) {
      await this.writeFrame(sink, {
        type: 'completed',
        runId: attempt.runId,
        outcome: attempt.outcome,
      });
    }
  }

  /**
   * Serialized fan-out to every sink of one attempt. `attached` frames are
   * enqueued behind any terminal frame already queued; a sink that throws
   * is dropped without failing the run (the ledger outcome is the record).
   */
  private broadcast(attempt: Attempt, frame: VerificationProgress): Promise<void> {
    // Snapshot the sinks at enqueue time: a sink that attaches AFTER an
    // already-queued frame must not receive that frame out of order — its
    // first frame is the `attached` one enqueued by attach().
    const targets = [...attempt.sinks];
    attempt.queue = attempt.queue.then(async () => {
      for (const sink of targets) {
        try {
          await sink(frame);
        } catch (error) {
          attempt.sinks.delete(sink);
          this.log('warn', 'verification sink write failed; sink dropped', {
            run: attempt.runId,
            error: String(error),
          });
        }
      }
    });
    return attempt.queue;
  }

  /** Best-effort single-sink write (reconcile replay). */
  private async writeFrame(sink: VerificationProgressSink, frame: VerificationProgress): Promise<void> {
    try {
      await sink(frame);
    } catch (error) {
      this.log('warn', 'verification sink write failed', {
        run: frame.runId,
        error: String(error),
      });
    }
  }

  /** Run one admitted attempt and settle every attached caller exactly once. */
  private async executeAttempt(attempt: Attempt): Promise<void> {
    try {
      const lease = await this.acquire(
        attempt.spec,
        (frame) => this.broadcast(attempt, frame),
        attempt.runId,
      );
      attempt.lease = lease;
      // Sync every request identity bound while the attempt was queued so a
      // restart orphan still reconciles by request id, not just by key.
      const slot = this.slots.get(lease.runId);
      if (slot !== undefined) slot.requestIds = [...attempt.requestIds];
      this.persistBestEffort();
      const outcome = await this.execute(lease, (frame) => {
        if (frame.type === 'started') attempt.started = true;
        return this.broadcast(attempt, frame);
      });
      attempt.outcome = outcome;
      await this.broadcast(attempt, { type: 'completed', runId: lease.runId, outcome });
      this.rememberHistory(attempt, { state: 'completed', outcome, error: null });
      attempt.resolve(outcome);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.rememberHistory(attempt, {
        state: failure instanceof VerificationLockTimeoutError ? 'admission-failed' : null,
        outcome: null,
        error:
          failure instanceof VerificationLockTimeoutError
            ? { code: failure.code, detail: failure.message }
            : failure instanceof VerificationDisposedError || failure instanceof VerificationDuplicateError
              ? null
              : { code: 'verification_failed', detail: failure.message },
      });
      attempt.reject(failure);
    } finally {
      this.attempts.delete(attempt.key);
      for (const requestId of attempt.requestIds) this.attemptsByRequest.delete(requestId);
      if (attempt.lease !== null) this.release(attempt.lease);
    }
  }

  /** Record (or forget) every bound request identity for reconciliation. */
  private rememberHistory(
    attempt: Attempt,
    terminal: {
      readonly state: 'completed' | 'admission-failed' | null;
      readonly outcome: VerificationOutcome | null;
      readonly error: { code: string; detail: string } | null;
    },
  ): void {
    if (attempt.requestIds.size === 0) return;
    for (const requestId of attempt.requestIds) {
      if (terminal.state === null) {
        this.requestHistory.delete(requestId);
        continue;
      }
      const completedAt = this.now();
      this.requestHistory.set(requestId, {
        state: terminal.state,
        spec: attempt.spec,
        head: attempt.head,
        completedAt,
        outcome: terminal.outcome,
        started: attempt.started,
        error: terminal.error,
      });
      this.appendTerminalIdentity({
        request_id: requestId,
        run_id: attempt.outcome?.runId ?? attempt.runId,
        state: terminal.state,
        job_id: attempt.spec.jobId,
        scope: attempt.spec.scope,
        command: attempt.spec.command,
        cwd: attempt.spec.cwd,
        head: attempt.head,
        started: attempt.started,
        completed_at: completedAt,
      });
    }
    while (this.requestHistory.size > MAX_REQUEST_HISTORY) {
      const oldest = this.requestHistory.keys().next().value;
      if (oldest === undefined) break;
      this.requestHistory.delete(oldest);
    }
    this.persistBestEffort();
  }

  /** Load the append-only terminal identity index (torn tails skipped loud). */
  private loadRequestIndex(): void {
    let text: string;
    try {
      text = readFileSync(this.requestLogFile, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`verification request log ${this.requestLogFile} is unreadable: ${String(error)}`);
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.log('warn', 'verification request log line skipped: not valid JSON', {
          path: this.requestLogFile,
        });
        continue;
      }
      const record = parseTerminalIdentity(parsed);
      if (record === null) {
        this.log('warn', 'verification request log line skipped: unsupported shape', {
          path: this.requestLogFile,
        });
        continue;
      }
      this.requestIndex.set(record.request_id, record);
    }
  }

  /** Append one terminal identity (append-only; the log is never rewritten). */
  private appendTerminalIdentity(record: TerminalIdentity): void {
    this.requestIndex.set(record.request_id, record);
    try {
      appendFileSync(this.requestLogFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch (error) {
      this.log('error', 'verification request identity append failed', {
        path: this.requestLogFile,
        request: record.request_id,
        error: String(error),
      });
    }
  }

  /** Mark a released orphan's bound identities interrupted (started, no outcome). */
  private markInterruptedIdentities(slot: ActiveSlot): string[] {
    const marked: string[] = [];
    for (const requestId of slot.requestIds) {
      if (this.requestIndex.has(requestId)) continue;
      this.appendTerminalIdentity({
        request_id: requestId,
        run_id: slot.lease.runId,
        state: 'interrupted',
        job_id: slot.lease.jobId,
        scope: slot.lease.scope,
        command: slot.lease.command,
        cwd: slot.lease.cwd,
        head: slot.lease.head,
        started: slot.pid !== null,
        completed_at: this.now(),
      });
      marked.push(requestId);
    }
    return marked;
  }

  private persistedAttempts(): PersistedAttempt[] {
    return [...this.requestHistory.entries()].map(([requestId, entry]) => ({
      request_id: requestId,
      run_id: entry.outcome?.runId ?? '',
      job_id: entry.spec.jobId,
      scope: entry.spec.scope,
      command: entry.spec.command,
      cwd: entry.spec.cwd,
      head: entry.head,
      tracked_dirty: entry.outcome?.trackedDirty ?? false,
      started: entry.started,
      state: entry.state,
      completed_at: entry.completedAt,
      outcome: entry.outcome === null ? null : compactOutcome(entry.outcome),
      error: entry.error,
    }));
  }

  private mintLease(runId: string, spec: VerificationRunSpec, queuedAt: number): VerificationLease {
    return {
      runId,
      jobId: spec.jobId,
      scope: spec.scope,
      command: spec.command,
      cwd: spec.cwd,
      head: spec.head ?? null,
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
      this.slots.set(waiter.runId, {
        lease,
        owned: true,
        pid: null,
        child: null,
        requestIds: waiter.spec.requestId === undefined ? [] : [waiter.spec.requestId],
      });
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
    // Exact-head evidence: a queue wait can span a push. Running the new
    // head under the old submission would silently verify the wrong
    // revision, so fail honestly instead (no spawn, no false PASS).
    if (lease.head !== null && git.sha !== lease.head) {
      const outcome: VerificationOutcome = {
        runId: lease.runId,
        jobId: lease.jobId,
        scope: lease.scope,
        command: lease.command,
        cwd: lease.cwd,
        ok: false,
        exitCode: null,
        signal: null,
        timedOut: false,
        queuedMs: this.now() - lease.queuedAt,
        durationMs: 0,
        sha: git.sha,
        trackedDirty: git.trackedDirty,
        workers,
        outputBytes: 0,
        outputSha256: createHash('sha256').digest('hex'),
        outputTail: '',
        error:
          `head_changed: lane moved from ${lease.head} to ${git.sha ?? 'unknown'} before the run started — ` +
          'a changed head is a new verification, never a replay',
      };
      this.safeRecord({
        kind: 'verification.completed',
        jobId: lease.jobId,
        payload: outcomePayload(outcome),
      });
      return outcome;
    }
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
    if (state.attempts !== undefined && !Array.isArray(state.attempts)) {
      throw new Error(`verification scheduler state ${this.stateFile} has an unsupported attempts shape`);
    }
    return {
      version: 1,
      slots: state.slots as readonly PersistedSlot[],
      attempts: (state.attempts ?? []) as readonly PersistedAttempt[],
    };
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
        head: slot.lease.head,
        request_ids: slot.requestIds,
        granted_at: slot.lease.grantedAt,
      })),
      attempts: this.persistedAttempts(),
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

/** The reconcile status for one in-flight attempt. */
function statusFromAttempt(attempt: Attempt, requestId: string | null): VerificationAttemptStatus {
  return {
    state: attempt.started ? 'running' : 'accepted',
    requestId,
    runId: attempt.runId,
    jobId: attempt.spec.jobId,
    scope: attempt.spec.scope,
    command: attempt.spec.command,
    cwd: attempt.spec.cwd,
    head: attempt.head,
    trackedDirty: null,
    started: attempt.started,
  };
}

/** Bound the persisted output tail (the full tail lives in the ledger). */
function compactOutcome(outcome: VerificationOutcome): Record<string, unknown> {
  return { ...outcome, outputTail: outcome.outputTail.slice(-PERSISTED_TAIL_CHARS) };
}

/** Reconstruct a persisted completed outcome; null when the record is unreadable. */
function outcomeFromPersisted(attempt: PersistedAttempt): VerificationOutcome | null {
  const payload = attempt.outcome;
  if (payload === null || attempt.run_id === '') return null;
  const text = (key: string): string | null => (typeof payload[key] === 'string' ? (payload[key] as string) : null);
  const number = (key: string): number | null =>
    typeof payload[key] === 'number' && Number.isFinite(payload[key]) ? (payload[key] as number) : null;
  const flag = (key: string, fallback: boolean): boolean =>
    typeof payload[key] === 'boolean' ? (payload[key] as boolean) : fallback;
  const scope = text('scope');
  const command = text('command');
  const cwd = text('cwd');
  if (scope === null || command === null || cwd === null) return null;
  return {
    runId: attempt.run_id,
    jobId: attempt.job_id,
    scope,
    command,
    cwd,
    ok: flag('ok', false),
    exitCode: number('exitCode'),
    signal: text('signal'),
    timedOut: flag('timedOut', false),
    queuedMs: number('queuedMs') ?? 0,
    durationMs: number('durationMs') ?? 0,
    sha: text('sha'),
    trackedDirty: flag('trackedDirty', false),
    workers: number('workers') ?? 1,
    outputBytes: number('outputBytes') ?? 0,
    outputSha256: text('outputSha256') ?? '',
    outputTail: text('outputTail') ?? '',
    error: text('error'),
  };
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
