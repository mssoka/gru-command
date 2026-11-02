import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { LogLevel } from '../logger.js';
import { redactCredentials } from '../redaction.js';
import {
  BuildRecords,
  DEFAULT_BUILD_OUTPUT_ROOTS,
  inspectReuse,
  observeBuildInputs,
  planCommand,
  type VerificationCheck,
} from './build-reuse.js';
import { OutputRetention, type ReplayedOutput } from './output-retention.js';

export type { VerificationCheck, VerificationCheckStatus } from './build-reuse.js';

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

/** What a submission asks of the run it starts (#427). An attached
 * duplicate joins the run already in flight and asks nothing. */
export interface VerificationRunHooks {
  /** Awaited after the run is admitted to a slot and before its command
   * spawns (a slim lane's restore): it runs inside the run's budget, and
   * the slot covers it, so the job shows a run the whole time. Its signal
   * is the run's: aborted when the run is cancelled (the scheduler is
   * disposed, or the job's verification is cancelled by
   * {@link VerificationScheduler.cancelJob}; a client that disconnects does
   * not cancel a run, which other streams may share), so the step ends, the
   * run never spawns and the slot is released. It should not reject; a
   * rejection is logged and the run still spawns. */
  readonly beforeSpawn?: (signal: AbortSignal) => Promise<void>;
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
  /**
   * Per-step evidence (issue #318), present only when the declared command
   * was decomposed for narrow build reuse. Says which checks really ran,
   * how each ended, and which build step was satisfied by an earlier run.
   */
  readonly checks?: readonly VerificationCheck[];
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
      /** Same-`request_id` re-submits only: what the retained-output replay
       * carried (issue #554). Absent for a different-id attacher (unchanged). */
      readonly replayed_output?: ReplayedOutput;
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
      /** How much of the run's output this replay carried (issue #554): a
       * reconciled receipt is promotable only when this is `complete`. */
      readonly replayed_output?: ReplayedOutput;
    };

export type VerificationProgressSink = (progress: VerificationProgress) => void | Promise<void>;

/** A ledger-bound record the scheduler emits (wired to appendCustomEvent). */
export interface VerificationRecord {
  readonly kind: string;
  readonly jobId: string;
  readonly payload: Record<string, unknown>;
}

export type VerificationRecorder = (record: VerificationRecord) => void;

/** The command lines a verification event carries: the scope's command, the
 * native process's argv, the step that process runs, and the request's dedupe
 * key (the job, directory, scope, head and command joined, the command last). */
const EVENT_COMMAND_FIELDS = ['command', 'process_command', 'step_command', 'dedupe_key'] as const;

/** An event payload as it is recorded (#534): every command line it carries,
 * and each per-step check's, with its credentials masked. The scheduler keeps
 * the raw command in memory (it is the run's identity, and what the process
 * registry digests at spawn); a ledger event, which the board, a review and an
 * audit read, holds it masked. Apply it once, at the record boundary: masking a
 * masked line again is not a no-op for every shape. */
export function maskedEventPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const masked: Record<string, unknown> = { ...payload };
  for (const field of EVENT_COMMAND_FIELDS) {
    const value = masked[field];
    if (typeof value === 'string') masked[field] = redactCredentials(value);
  }
  const checks = masked['checks'];
  if (Array.isArray(checks)) {
    masked['checks'] = (checks as unknown[]).map((check) => {
      const command = (check as { command?: unknown } | null)?.command;
      return typeof command === 'string' ? { ...(check as object), command: redactCredentials(command) } : check;
    });
  }
  return masked;
}

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

/** Raised for a run {@link VerificationScheduler.cancelJob} ended on a job's
 * behalf (issue #559). Distinct from {@link VerificationDisposedError}: an
 * owner cancel is not a shutdown, and the scheduler records it as
 * `verification.cancelled` — never as a shutdown `verification.no-start`. */
export class VerificationCancelledError extends Error {
  readonly code = 'verification_cancelled';
  constructor(
    readonly by: string,
    readonly reason: string,
  ) {
    super(`verification run cancelled by ${by}: ${reason}`);
    this.name = 'VerificationCancelledError';
  }
}

/** What {@link VerificationScheduler.cancelJob} reports for one run: `stopped`
 * only on process-group absence, `unproven` with the live group named. */
export interface VerificationCancelRunOutcome {
  readonly runId: string;
  readonly state: 'stopped' | 'unproven';
  readonly detail: string | null;
}

/** The job-level answer: `stopped` only when EVERY run it holds is stopped.
 * `detail` is the owner-facing reason the verdict is `unproven` — the
 * unproven runs' own details joined, or the reason the scheduler holds no
 * run it can prove gone — and `null` for a `stopped` verdict. */
export interface VerificationCancelJobOutcome {
  readonly state: 'stopped' | 'unproven';
  readonly runs: readonly VerificationCancelRunOutcome[];
  readonly detail: string | null;
}

/** The stop pass's owner-facing reason: every unproven run's own detail,
 * joined; `null` when every run the cancel answered for is proven gone. */
function unprovenCancelDetail(runs: readonly VerificationCancelRunOutcome[]): string | null {
  const details = runs.flatMap((run) =>
    run.state === 'unproven' && run.detail !== null ? [run.detail] : [],
  );
  return details.length === 0 ? null : details.join('; ');
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
  /** The argv a holder that spawns its own command bound with its pid
   * (#427 onboarding proof): the pid's command evidence after a restart. */
  readonly process_command?: string | null;
  /** The bound pid leads its own process group: the holder lives while
   * any member of that group does. */
  readonly process_group?: boolean;
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

class VerificationSpawnFailedError extends Error {
  readonly code = 'spawn_failed';
  constructor(detail: string) { super(detail); this.name = 'VerificationSpawnFailedError'; }
}

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
  readonly reason?: 'scheduler_disposed' | 'spawn_failed';
  readonly error?: string;
  readonly request_ids?: readonly string[];
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
  /** The submission's {@link VerificationRunHooks.beforeSpawn}. */
  readonly beforeSpawn: ((signal: AbortSignal) => Promise<void>) | null;
  /** The run's cancellation, aborted by {@link VerificationScheduler.dispose}
   * and by {@link VerificationScheduler.cancelJob}. */
  readonly cancel: AbortController;
  /** Who cancelled this run (issue #559), set ONCE: a second cancel joins the
   * run instead of signalling it again. Null until then. */
  cancellation: { readonly by: string; readonly reason: string } | null;
}

/** Terminal request_id evidence kept (bounded) for reconnect reconciliation. */
interface RequestHistoryEntry {
  readonly runId: string;
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
  /** The argv bound with {@link VerificationScheduler.bindPid}, else null. */
  processCommand: string | null;
  /** The bound pid leads its own process group (judged by the group). */
  leadsGroup: boolean;
  child: ChildProcess | null;
  /** The step child this slot last spawned, kept after it exited: a cancel
   * (issue #559) proves cessation from ITS process group, which outlives the
   * `child` field the exit detaches. */
  lastChild: ChildProcess | null;
  /** The job's cancellation (issue #559), set ONCE by
   * {@link VerificationScheduler.cancelJob}; read by `execute()` to end the
   * run and record `verification.cancelled`. */
  cancellation: { readonly by: string; readonly reason: string } | null;
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
  /**
   * Test seam for {@link VerificationScheduler.cancelJob}'s cessation proof:
   * when set, it answers whether the cancelled run's process group is still
   * alive INSTEAD of the real `kill(-pgid, 0)` probe. A real group cannot be
   * kept alive on purpose, so the honest `unproven`-after-SIGKILL branch is
   * only deterministically reachable through this hook (issue #559). It is
   * never consulted by the run-timeout path or by dispose().
   */
  readonly cancellationProbe?: () => boolean;
  readonly now?: () => number;
  /**
   * Narrow build reuse (issue #318). Default: enabled with the default
   * output root (`dist/`); `false` runs every declared command exactly as
   * written. There is no config-file off-switch — disabling is this
   * code-level option only.
   */
  readonly buildReuse?: false | { readonly roots?: readonly string[] };
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
/** The margin one kill grace carries into the waits around it (issue #559):
 * the cancel bound is `killGraceMs + this`, capped by
 * {@link CANCEL_BOUND_MAX_MS}, and `execute()` gives its cancelled terminal
 * this margin on top of the grace before it records a group it could not
 * prove gone. */
const CANCEL_SETTLE_MARGIN_MS = 2_000;
/** The cancel's own SIGTERM grace (issue #559). The run-timeout grace
 * (`killGraceMs`, 5 s in production) is longer than the whole cancel bound, so
 * a cancel that waited it out would leave the SIGKILL proof no window at all:
 * a group gets this long to exit on TERM, and the rest of the bound proves it
 * gone. */
const CANCEL_SIGTERM_GRACE_MS = 1_000;
/** Hard ceiling on one attempt's whole cancel — TERM grace, SIGKILL and the
 * proof wait together (issue #559). It sits under `JOB_STOP_JOIN_WAIT_MS`
 * (5 s, `src/shutdown-budget.ts`) so the shutdown join always outlives the
 * cancel it awaits: a pass cut short leaves its `requested` record for the
 * next boot's re-proof instead of running underneath a disposed scheduler.
 * The rest of the stop pass (review supersession) is not bounded by this. */
const CANCEL_BOUND_MAX_MS = 4_500;
/** Cadence of the process-group cessation probe while a cancel waits. */
const GROUP_PROBE_INTERVAL_MS = 20;

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
    ...((record['reason'] === 'scheduler_disposed' || record['reason'] === 'spawn_failed') && state === 'admission-failed' && !started ? { reason: record['reason'],
      ...(typeof record['error'] === 'string' ? { error: record['error'] } : {}),
      ...(Array.isArray(record['request_ids']) && record['request_ids'].every((id) => typeof id === 'string' && VERIFICATION_REQUEST_ID_PATTERN.test(id)) && record['request_ids'].includes(requestId)
        ? { request_ids: record['request_ids'] as string[] } : {}) } : {}),
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

/** Does any member of a process group exist (`kill(-pgid, 0)`)? EPERM
 * also proves existence. */
export function groupAlive(pgid: number): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Signal the child's whole process group (detached spawn) so vitest
 * workers cannot outlive a timed-out shell; fall back to the child. */
/** True while any member of the child's process group exists (signal 0 probe). */
function processGroupAlive(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

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

/** Tracked HEAD state at submission/run start. Candidate qualification opts
 * into untracked inputs too: those bytes are not represented by the HEAD.
 * Ignored evidence/build artifacts remain outside git's candidate status. */
export function readGitState(cwd: string, opts: { readonly includeUntracked?: boolean } = {}): { sha: string | null; trackedDirty: boolean } {
  try {
    const sha = execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 10_000,
    }).trim();
    const dirty =
      execFileSync('git', ['-C', cwd, 'status', '--porcelain', opts.includeUntracked ? '--untracked-files=all' : '--untracked-files=no'], {
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

/** Await `promise` for at most `ms`; false when it is still open. The bound's
 * timer is cleared (and unref'd) so a wait nobody needs never keeps the
 * process alive or leaks past its answer. */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise.then(() => true, () => true), late]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  /** Every run's output from the first byte, kept for same-id replays
   * (issue #554): separate from (and outliving) the bounded history above. */
  private readonly outputRetention: OutputRetention;
  /** Append-only terminal identities: NEVER silently forgotten -> never rerun. */
  private readonly requestIndex = new Map<string, TerminalIdentity>();
  private waiters: Waiter[] = [];
  private sweepTimer: NodeJS.Timeout | null = null;
  private started = false;
  private disposed = false;
  private readonly noStartSettled = new Set<string>();
  /** Run ids whose ONE `verification.cancelled` terminal is already written
   * (issue #559): a second terminal would permanently fence the run. */
  private readonly cancelledSettled = new Set<string>();
  private readonly pendingNoStart = new Map<string, VerificationRecord>();
  private readonly publishingNoStart = new Set<string>();
  private readonly buildRecords = new BuildRecords();
  /** Null = reuse disabled. */
  private readonly buildReuseRoots: readonly string[] | null;

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
    this.outputRetention = new OutputRetention({ now: this.now });
    this.buildReuseRoots =
      opts.buildReuse === false ? null : (opts.buildReuse?.roots ?? DEFAULT_BUILD_OUTPUT_ROOTS);
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

  /** How long after its grant a held slot is released as stale (`max-age`). */
  get staleMaxAge(): number {
    return this.staleMaxAgeMs;
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

  /** True while the job has a run holding a slot (an earlier process's
   * holder included), waiting for one, or accepted and not yet settled
   * (#427: a lane is idle for slimming only when this is false). */
  hasRunFor(jobId: string): boolean {
    return [...this.slots.values()].some((slot) => slot.lease.jobId === jobId) ||
      this.waiters.some((waiter) => waiter.spec.jobId === jobId) ||
      [...this.attempts.values()].some((attempt) => attempt.spec.jobId === jobId);
  }

  /**
   * Stop the job's scheduled verification (issue #559): abort a queued
   * wait, end a readying run before its command spawns, and SIGTERM →
   * (cancel grace) → SIGKILL a running one, ending the run as exactly ONE
   * `verification.cancelled` record.
   *
   * The verdict is evidence, never intent: a run is `stopped` only when its
   * process group is proven gone (`kill(-pgid, 0)`, the timeout path's own
   * rule — a shell's exit is never proof its descendants died), and a group
   * that survives the bound is `unproven` with the reason named, its record
   * left unsettled so a stop/bin verdict still refuses. The run's own
   * settlement is never the verdict: a proven-dead group is `stopped` even
   * while its shell is still draining. A holder this process does not own —
   * one an earlier process minted, or a slot no in-flight attempt backs — is
   * never signalled and never claimed, so it too is `unproven` with its own
   * reason.
   * The scheduler has no ledger and reads none: a run it does not hold is
   * answered by holding nothing, which is never a claim that the run stopped.
   */
  async cancelJob(
    jobId: string,
    input: { readonly by: string; readonly reason: string },
  ): Promise<VerificationCancelJobOutcome> {
    if (this.disposed) {
      return {
        state: 'unproven',
        runs: [],
        detail: 'the verification scheduler is shutting down — it holds no run it can prove gone',
      };
    }
    const cancellation = { by: input.by, reason: input.reason };
    const attempts = [...this.attempts.values()].filter(
      (attempt) => attempt.spec.jobId === jobId && attempt.outcome === null,
    );
    const slots = [...this.slots.values()].filter((slot) => slot.lease.jobId === jobId);
    // Nothing held here: the scheduler cannot and must not read the ledger to
    // find a run it never owned, so it makes no claim about one — and holding
    // nothing is never proof that a run stopped.
    if (attempts.length === 0 && slots.length === 0) {
      return { state: 'unproven', runs: [], detail: 'the scheduler holds no run it can prove gone' };
    }
    const runs: VerificationCancelRunOutcome[] = [];
    const attemptRunIds = new Set(attempts.map((attempt) => attempt.runId));
    for (const slot of slots) {
      if (attemptRunIds.has(slot.lease.runId)) continue;
      runs.push({
        runId: slot.lease.runId,
        state: 'unproven',
        detail: slot.owned
          ? 'the run is granted but holds no in-flight attempt here — the scheduler holds no signal it can prove gone'
          : 'the run was started by an earlier process — this one holds no signal for its process group, so its stop is unproven',
      });
    }
    // Each attempt gets its OWN bound and they run together: one job can hold
    // several scopes, and a resistant group must not starve the next run.
    runs.push(...(await Promise.all(
      attempts.map((attempt) => this.cancelAttempt(attempt, cancellation, this.cancelDeadline())),
    )));
    const state = runs.every((run) => run.state === 'stopped') ? 'stopped' : 'unproven';
    return { state, runs, detail: unprovenCancelDetail(runs) };
  }

  /** One attempt's whole cancel bound: its TERM phase, its SIGKILL and the
   * group-absence proof together stay under {@link CANCEL_BOUND_MAX_MS} and
   * thus under the shutdown join that awaits the pass. */
  private cancelDeadline(): number {
    return Date.now() + Math.min(this.killGraceMs + CANCEL_SETTLE_MARGIN_MS, CANCEL_BOUND_MAX_MS);
  }

  /** What is left of a cancel bound; never negative. */
  private cancelWaitMs(deadline: number): number {
    return Math.max(0, deadline - Date.now());
  }

  /** The TERM phase: the cancel's own short grace, never the run-timeout one
   * and never more than what is left of the bound — SIGKILL must always have
   * a proof window. */
  private cancelTermGraceMs(deadline: number): number {
    return Math.min(CANCEL_SIGTERM_GRACE_MS, this.killGraceMs, this.cancelWaitMs(deadline));
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
        runId: attempt.run_id,
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
    // The append-only identity index survives a failed scheduler-state write.
    // Only explicit current no-start provenance can recover this refusal.
    for (const identity of this.requestIndex.values()) {
      if (identity.reason !== 'scheduler_disposed' && identity.reason !== 'spawn_failed') continue;
      this.pendingNoStart.set(identity.run_id, { kind: 'verification.no-start', jobId: identity.job_id, payload: {
        run_id: identity.run_id, request_ids: identity.request_ids ?? [...this.requestIndex.values()].filter((row) => row.run_id === identity.run_id && row.reason === identity.reason).map((row) => row.request_id),
        scope: identity.scope, command: identity.command, cwd: identity.cwd, head: identity.head, started: false, reason: identity.reason, error: identity.error ?? null,
      } });
    }
    // Older supported state files have the full refusal even before the
    // append-only format gained its explicit reason field.
    for (const history of this.requestHistory.values()) {
      if (!['scheduler_disposed', 'spawn_failed'].includes(history.error?.code ?? '') || history.state !== 'admission-failed' || history.outcome !== null || history.started || this.pendingNoStart.has(history.runId)) continue;
      this.pendingNoStart.set(history.runId, { kind: 'verification.no-start', jobId: history.spec.jobId, payload: {
        run_id: history.runId, request_ids: [...this.requestHistory].filter(([, row]) => row.runId === history.runId && row.state === 'admission-failed' && row.outcome === null && !row.started && row.error?.code === history.error!.code && row.spec.jobId === history.spec.jobId && row.spec.scope === history.spec.scope && row.spec.command === history.spec.command && row.spec.cwd === history.spec.cwd && row.head === history.head).map(([id]) => id), scope: history.spec.scope, command: history.spec.command,
        cwd: history.spec.cwd, head: history.head, started: false, reason: history.error!.code, error: history.error!.detail,
      } });
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
        processCommand: slot.process_command ?? null,
        leadsGroup: slot.process_group === true,
        owned: false,
        child: null,
        lastChild: null,
        cancellation: null,
        requestIds: slot.request_ids ?? [],
      });
    }
    this.reconcileStale();
    this.persist();
    // Persisted live holders are restored first: a retry's persistence must
    // never publish a holder map that still lacks them.
    this.retryNoStart();
    this.sweepTimer = setInterval(() => {
      try {
        this.reconcileStale();
        this.retryNoStart();
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
      } else if (!pidAlive(slot.pid) && !(slot.leadsGroup && groupAlive(slot.pid))) {
        // A holder that leads its own group lives while any member does: a
        // command its leader started may outlive it (#427 onboarding proof).
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
        processCommand: null,
        leadsGroup: false,
        child: null,
        lastChild: null,
        cancellation: null,
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
            head: spec.head ?? null,
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

  /**
   * Bind the pid of a command a lease holder spawned itself (the holder
   * runs its own command under {@link acquire}, #427 onboarding proof) to
   * the lease's slot, persisted as {@link run} records its child: a restart
   * then judges the loaded slot by that pid's liveness (holder-dead, or
   * max-age) instead of releasing it as `no-runner` while the command may
   * still run. `leadsGroup`: the pid leads its own process group, so the
   * slot is judged by the group (`kill(-pgid, 0)`): a member that outlived
   * its leader keeps it held. A slot already released holds nothing to bind.
   */
  bindPid(lease: VerificationLease, pid: number, processCommand: string, opts: { readonly leadsGroup?: boolean } = {}): void {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error(`a verification slot binds a positive integer pid, got ${String(pid)}`);
    const slot = this.slots.get(lease.runId);
    if (slot === undefined) return;
    slot.pid = pid;
    slot.processCommand = processCommand;
    slot.leadsGroup = opts.leadsGroup === true;
    this.persistBestEffort();
  }

  /**
   * The slots of one scope that an earlier process left and this one still
   * holds (their bound pid was alive at the last stale check), with the
   * pid and argv their holder bound. The holder that spawns its own
   * command may end such an orphan and release its slot (#427 onboarding
   * proof); nothing else is offered.
   */
  restoredHolders(scope: string): readonly { readonly lease: VerificationLease; readonly pid: number; readonly processCommand: string | null }[] {
    return [...this.slots.values()]
      .filter((slot) => !slot.owned && slot.lease.scope === scope && slot.pid !== null)
      .map((slot) => ({ lease: slot.lease, pid: slot.pid!, processCommand: slot.processCommand }));
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
    hooks: VerificationRunHooks = {},
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
          // A same-identity re-submit is handed the output it missed before
          // the recorded terminal frame (issue #554): complete when every
          // frame from the first byte is still retained, else `none` or
          // `incomplete` so the receipt stays honestly unpromotable.
          await this.replayCompletedOutput(history.outcome, sink);
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
        if (history.error?.code === 'spawn_failed') { this.retryNoStart(); throw new VerificationSpawnFailedError(history.error.detail); }
        if (history.error?.code === 'scheduler_disposed') {
          this.retryNoStart();
          throw new VerificationDisposedError();
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
        await this.attach(bound, sink, requestId, true);
        return bound.promise;
      }
      // A terminal identity whose full outcome is no longer retained (evicted
      // from the bounded history, or crash-interrupted) is NEVER rerun: the
      // ledger holds the record; the caller mints a new identity. Output kept
      // by the retention store outlives the 64-entry history bound, so a
      // matching completed identity whose frames (and recorded outcome) are
      // still retained replays them instead of expiring.
      const known = this.requestIndex.get(requestId);
      if (known !== undefined) {
        if (known.reason === 'scheduler_disposed') { this.retryNoStart(); throw new VerificationDisposedError(); }
        if (known.reason === 'spawn_failed') { this.retryNoStart(); throw new VerificationSpawnFailedError(known.error ?? 'original native shell spawn failed without a child'); }
        if (known.state === 'admission-failed') {
          this.requestIndex.delete(requestId);
        } else {
          const retainedOutcome =
            known.state === 'completed' &&
            known.job_id === resolvedSpec.jobId &&
            known.scope === resolvedSpec.scope &&
            known.cwd === resolvedSpec.cwd &&
            known.command === resolvedSpec.command &&
            known.head === head
              ? this.outputRetention.recordedOutcome(known.run_id)
              : null;
          if (retainedOutcome === null) {
            throw new VerificationRequestExpiredError(requestId, known.run_id, known.state);
          }
          await this.replayCompletedOutput(retainedOutcome, sink);
          this.safeRecord({
            kind: 'verification.reconciled',
            jobId: resolvedSpec.jobId,
            payload: {
              request_id: requestId,
              run_id: retainedOutcome.runId,
              state: 'completed',
              scope: resolvedSpec.scope,
              head,
            },
          });
          return retainedOutcome;
        }
      }
    }

    const inFlight = this.attempts.get(key);
    if (inFlight !== undefined) {
      await this.attach(inFlight, sink, requestId, false);
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

    const attempt = this.createAttempt(key, resolvedSpec, head, requestId, sink, hooks);
    // Retained output is tracked from acceptance, not from the first byte: a
    // same-`request_id` re-submit that lands while the run is still queued is
    // answered `complete` with nothing missing (issue #554).
    this.outputRetention.begin(attempt.runId);
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
    hooks: VerificationRunHooks = {},
  ): Promise<VerificationOutcome> {
    return this.submit(spec, sink, hooks);
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
          runId: history.runId,
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
          ...(known.reason === 'scheduler_disposed' ? { error: { code: 'scheduler_disposed', detail: new VerificationDisposedError().message } } : known.reason === 'spawn_failed' ? { error: { code: 'spawn_failed', detail: known.error ?? 'original native shell spawn failed without a child' } } : {}),
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
    if (this.disposed) { this.retryNoStart(); return; }
    this.disposed = true;
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const attempt of this.attempts.values()) {
      // A run still readying its lane (#427) stops readying it.
      attempt.cancel.abort();
      // An already-produced childless terminal outcome is not a no-start.
      // A run the owner already cancelled settles on its own terminal —
      // `verification.cancelled` — never as a second shutdown `no-start`.
      if (!attempt.started && attempt.outcome === null && attempt.cancellation === null) this.settleNoStart(attempt);
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
    hooks: VerificationRunHooks,
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
      beforeSpawn: hooks.beforeSpawn ?? null,
      cancel: new AbortController(),
      cancellation: null,
    };
  }

  /** Attach a duplicate submission to the in-flight producer (issue #159).
   * `replay` is set for a same-`request_id` re-submit: that sink alone is
   * handed the run's retained output from byte 0 (issue #554) before the
   * `attached` acknowledgement and the live frames. A different-`request_id`
   * attacher is unchanged: no replay, no replay marker. */
  private async attach(
    attempt: Attempt,
    sink: VerificationProgressSink,
    requestId: string | null,
    replay: boolean,
  ): Promise<void> {
    attempt.sinks.add(sink);
    // Snapshot the retained prefix NOW, before any await: every output frame
    // broadcast from here on fans out to this sink as a live frame, so the
    // snapshot can never duplicate one. A frame broadcast earlier is already
    // in the snapshot and was not sent to this sink.
    const retained = replay ? this.outputRetention.replay(attempt.runId) : null;
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
    if (retained !== null && retained.frames.length > 0) {
      // ONE queue item for the whole prefix: enqueued synchronously in order,
      // so no live frame can interleave with the replayed frames.
      void this.enqueueSinkFrames(attempt, sink, retained.frames);
    }
    // The attach acknowledgement is for THIS caller only — existing
    // subscribers must not receive another client's request identity.
    await this.broadcastTo(attempt, sink, {
      type: 'attached',
      runId: attempt.runId,
      state: attempt.started ? 'running' : 'queued',
      requestId,
      head: attempt.head,
      dedupeKey: attempt.key,
      ...(retained === null ? {} : { replayed_output: retained.replayed }),
    });
    // A terminal frame is enqueued with a snapshot of the sinks that existed
    // at that instant. An attach whose `attached` frame was queued after that
    // snapshot would otherwise end at EOF without a completed frame: deliver
    // the recorded outcome to this sink explicitly (still queue-ordered).
    if (attempt.outcome !== null) {
      await this.broadcastTo(attempt, sink, {
        type: 'completed',
        runId: attempt.runId,
        outcome: attempt.outcome,
        ...(retained === null ? {} : { replayed_output: retained.replayed }),
      });
    }
  }

  /**
   * Queue a frame for ONE sink only, preserving this attempt's frame order.
   * Used by attach() so the acknowledgement and a late terminal frame stay
   * private to the attaching caller while output frames go to every sink.
   */
  private broadcastTo(
    attempt: Attempt,
    sink: VerificationProgressSink,
    frame: VerificationProgress,
  ): Promise<void> {
    return this.enqueueSinkFrames(attempt, sink, [frame]);
  }

  /** One queue item writing several frames to ONE sink, in order (replay). */
  private enqueueSinkFrames(
    attempt: Attempt,
    sink: VerificationProgressSink,
    frames: readonly VerificationProgress[],
  ): Promise<void> {
    attempt.queue = attempt.queue.then(async () => {
      for (const frame of frames) {
        try {
          await sink(frame);
        } catch (error) {
          attempt.sinks.delete(sink);
          this.log('warn', 'verification sink write failed; sink dropped', {
            run: attempt.runId,
            error: String(error),
          });
          return;
        }
      }
    });
    return attempt.queue;
  }

  /**
   * Serialized fan-out to every sink of one attempt. `attached` frames are
   * enqueued behind any terminal frame already queued; a sink that throws
   * is dropped without failing the run (the ledger outcome is the record).
   */
  private broadcast(attempt: Attempt, frame: VerificationProgress): Promise<void> {
    // Retain output from the first byte (issue #554). This is synchronous
    // with the enqueue below, so retention order is exactly frame order.
    if (frame.type === 'output') this.outputRetention.retain(frame);
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

  /**
   * Replay a completed run to a same-`request_id` re-submit (issue #554):
   * the retained output frames from byte 0, then the recorded terminal frame
   * marked `reconciled` with what the replay actually carried. A missing
   * retained output is never hidden: `replayed_output` says `none` or
   * `incomplete`, and the receipt built from it stays unpromotable.
   */
  private async replayCompletedOutput(
    outcome: VerificationOutcome,
    sink: VerificationProgressSink,
  ): Promise<void> {
    const retained = this.outputRetention.replay(outcome.runId);
    for (const frame of retained.frames) await this.writeFrame(sink, frame);
    await this.writeFrame(sink, {
      type: 'completed',
      runId: outcome.runId,
      outcome,
      reconciled: true,
      replayed_output: retained.replayed,
    });
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
      if (attempt.beforeSpawn !== null) {
        try {
          await attempt.beforeSpawn(attempt.cancel.signal);
        } catch (error) {
          this.log('error', 'verification pre-spawn step failed; the run goes ahead', { run: lease.runId, job: lease.jobId, error: String(error) });
        }
      }
      // A run cancelled or disposed while it readied its lane never spawns
      // (#427). The provenance decides the error: an owner cancel is not a
      // shutdown, and the catch below records the kind each one earns.
      if (attempt.cancel.signal.aborted || this.disposed) {
        const cancellation = attempt.cancellation;
        throw cancellation === null
          ? new VerificationDisposedError()
          : new VerificationCancelledError(cancellation.by, cancellation.reason);
      }
      const outcome = await this.execute(lease, (frame) => {
        if (frame.type === 'started') attempt.started = true;
        return this.broadcast(attempt, frame);
      });
      attempt.outcome = outcome;
      // Retention is completed BEFORE the terminal broadcast: a re-submit that
      // races the terminal either attaches (and gets the late terminal) or
      // finds the retained output plus outcome here.
      this.outputRetention.complete(attempt.runId, outcome);
      await this.broadcast(attempt, { type: 'completed', runId: lease.runId, outcome });
      this.rememberHistory(attempt, { state: 'completed', outcome, error: null });
      attempt.resolve(outcome);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      // A per-job cancel that ended the run before its command spawned
      // records its ONE terminal here: never a shutdown `verification.no-start`
      // (wrong provenance), never a second terminal for an already-settled run.
      // Its request history is a typed, retryable admission failure — never a
      // `verification_failed` that reads as evidence about the suite.
      if (failure instanceof VerificationCancelledError && !attempt.started) {
        this.settleCancelledBeforeSpawn(attempt, failure);
        this.rememberHistory(attempt, {
          state: 'admission-failed',
          outcome: null,
          error: { code: failure.code, detail: failure.message },
        });
      } else if ((failure instanceof VerificationDisposedError || failure instanceof VerificationSpawnFailedError) && !attempt.started) this.settleNoStart(attempt, failure);
      else this.rememberHistory(attempt, {
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
      // A run that settled without an outcome has nothing to replay; its
      // retained prefix must not linger as an unprunable live entry.
      if (attempt.outcome === null) this.outputRetention.discard(attempt.runId);
      this.attempts.delete(attempt.key);
      for (const requestId of attempt.requestIds) this.attemptsByRequest.delete(requestId);
      if (attempt.lease !== null) this.release(attempt.lease);
    }
  }

  private settleNoStart(attempt: Attempt, failure: VerificationDisposedError | VerificationSpawnFailedError = new VerificationDisposedError()): void {
    if (attempt.started || this.slots.get(attempt.runId)?.child != null || this.noStartSettled.has(attempt.runId)) return;
    if (this.pendingNoStart.has(attempt.runId)) { this.retryNoStart(); return; }
    this.pendingNoStart.set(attempt.runId, { kind: 'verification.no-start', jobId: attempt.spec.jobId, payload: {
      // The durable identity log is keyed by request id; a request-id-less
      // submission is persisted under a run-derived id so restart can still
      // publish its original refusal and release the ledger fence.
      run_id: attempt.runId, request_ids: attempt.requestIds.size > 0 ? [...attempt.requestIds] : [`anonymous:${attempt.runId}`], scope: attempt.spec.scope, command: attempt.spec.command,
      cwd: attempt.spec.cwd, head: attempt.head, started: false, reason: failure.code, error: failure.message,
    } });
    this.retryNoStart();
  }

  /** A per-job cancel that ended an attempt before its command spawned
   * records the run's ONE terminal (issue #559): `verification.cancelled` with
   * no `verification.started` before it and `process_group_gone: true` —
   * nothing was spawned, so nothing survives. It never writes
   * `verification.completed` (a cancel is an answer to the run, never
   * evidence the suite passed) and never a second terminal for the same run. */
  private settleCancelledBeforeSpawn(attempt: Attempt, failure: VerificationCancelledError): void {
    if (attempt.started || this.cancelledSettled.has(attempt.runId)) return;
    this.cancelledSettled.add(attempt.runId);
    this.safeRecord({
      kind: 'verification.cancelled',
      jobId: attempt.spec.jobId,
      payload: {
        run_id: attempt.runId,
        request_ids: [...attempt.requestIds],
        scope: attempt.spec.scope,
        command: attempt.spec.command,
        cwd: attempt.spec.cwd,
        head: attempt.head,
        started: false,
        cancelled: true,
        by: failure.by,
        reason: failure.reason,
        process_group_gone: true,
      },
    });
  }

  private retryNoStart(): void {
    let published = false;
    for (const [runId, record] of this.pendingNoStart) {
      if (this.publishingNoStart.has(runId)) continue;
      this.publishingNoStart.add(runId);
      try {
        const reason = record.payload['reason'] === 'spawn_failed' ? 'spawn_failed' : 'scheduler_disposed';
        const error = reason === 'spawn_failed' ? new VerificationSpawnFailedError(String(record.payload['error'] ?? 'original native shell spawn failed without a child')) : new VerificationDisposedError();
        for (const requestId of record.payload['request_ids'] as string[]) {
          const history: RequestHistoryEntry = { runId, state: 'admission-failed', started: false, outcome: null,
            completedAt: this.now(), head: record.payload['head'] as string | null,
            spec: { jobId: record.jobId, scope: String(record.payload['scope']), command: String(record.payload['command']), cwd: String(record.payload['cwd']) },
            error: { code: error.code, detail: error.message } };
          // Memory refusal is not a durable receipt. Persist exact provenance
          // first, retain it on failure, then acknowledge ledger publication.
          this.requestHistory.set(requestId, history);
        }
        this.persistBestEffort(); // preserve the entire positively observed attached refusal before any partial journal write
        for (const requestId of record.payload['request_ids'] as string[]) {
          const history = this.requestHistory.get(requestId)!;
          if (this.requestIndex.get(requestId)?.reason !== reason) {
            this.appendTerminalIdentity({ request_id: requestId, run_id: runId, state: 'admission-failed', job_id: record.jobId,
              scope: history.spec.scope, command: history.spec.command, cwd: history.spec.cwd, head: history.head,
              started: false, completed_at: history.completedAt, reason, error: error.message, request_ids: record.payload['request_ids'] as string[] }, true);
          }
        }
        this.persistBestEffort();
        this.recordEvent({ ...record, payload: maskedEventPayload(record.payload) });
        this.noStartSettled.add(runId);
        this.pendingNoStart.delete(runId);
        published = true;
      } catch (error) {
        this.log('error', 'verification no-start persistence/publication failed; original identity retained for retry', { run: runId, error: String(error) });
      } finally { this.publishingNoStart.delete(runId); }
    }
    // Keep the memory history within its bound after every pass, published
    // or not (#363 S09-1-05), and persist it once something published.
    this.boundRequestHistory();
    if (published) this.persistBestEffort();
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
        runId: attempt.runId,
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
    this.boundRequestHistory();
    this.persistBestEffort();
  }

  /** Keep at most MAX_REQUEST_HISTORY terminal entries in memory, oldest out
   * first, once each is durably indexed (#363 S09-1-05): an evicted identity
   * answers from the durable index. A pending no-start whose durable append
   * failed has no index entry, so its history entry is the only copy that
   * answers for it (and the only one persisted for a restart). That
   * unpublished refusal is kept until a retry indexes it, never evicted into
   * an `unknown` that a resubmit would replay. */
  private boundRequestHistory(): void {
    for (const [requestId, entry] of this.requestHistory) {
      if (this.requestHistory.size <= MAX_REQUEST_HISTORY) break;
      if (this.pendingNoStart.has(entry.runId) && !this.requestIndex.has(requestId)) continue;
      this.requestHistory.delete(requestId);
    }
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
  private appendTerminalIdentity(record: TerminalIdentity, durable = false): void {
    try {
      appendFileSync(this.requestLogFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      if (durable) {
        const fd = openSync(this.requestLogFile, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
        const dir = openSync(this.opts.storageDir, 'r');
        try { fsyncSync(dir); } finally { closeSync(dir); }
      }
      this.requestIndex.set(record.request_id, record);
    } catch (error) {
      if (durable) throw error;
      this.requestIndex.set(record.request_id, record); // retain original in-process terminal refusal, never replay on a write error
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
      run_id: entry.runId,
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

  /** Cancel ONE in-flight attempt and report its own cessation evidence.
   * A second cancel joins the run (`cancellation` is already set) instead of
   * signalling it again; it still waits for the same settlement. */
  private async cancelAttempt(
    attempt: Attempt,
    cancellation: { readonly by: string; readonly reason: string },
    deadline: number,
  ): Promise<VerificationCancelRunOutcome> {
    // The slot object outlives its map entry, so its last spawned child is the
    // run's group even after the release below.
    const slot = this.slots.get(attempt.runId);
    if (attempt.cancellation === null) {
      attempt.cancellation = cancellation;
      // Ends a `beforeSpawn` restore and makes the pre-spawn check choose
      // VerificationCancelledError over a shutdown refusal.
      attempt.cancel.abort();
      if (slot !== undefined) slot.cancellation = cancellation;
      // A queued wait has no child to signal: drop it so it never reaches a
      // spawn and never records a lock-wait timeout of its own.
      for (const waiter of this.waiters.filter((queued) => queued.runId === attempt.runId)) {
        this.dropWaiter(waiter);
        waiter.reject(new VerificationCancelledError(cancellation.by, cancellation.reason));
      }
      const target = slot?.child ?? slot?.lastChild ?? null;
      // An absent group grants no authority over a reused number (the timeout
      // path's own rule): signal only a group this run holds a child for or
      // the probe shows alive.
      if (target !== null && (slot?.child != null || processGroupAlive(target))) {
        signalGroup(target, 'SIGTERM');
        // Shell exit is not group cessation: a TERM-resistant descendant
        // outlives its shell (the timeout path's own rule).
        if (!(await this.waitForGroupGone(target, this.cancelTermGraceMs(deadline)))) {
          signalGroup(target, 'SIGKILL');
        }
      }
    }
    // The verdict is the run's LAST group's absence — `kill(-pgid, 0)` over the
    // final child, so it still holds after the exit detached `child` — and
    // never the attempt's settlement: a killed group whose shell is still
    // draining is proven stopped. A second cancel joins here (it signals
    // nothing) and reads the same proof. `execute()` waits for this same fact
    // before writing the run's terminal, so verdict and record agree.
    const lastChild = slot?.lastChild ?? null;
    const gone = await this.waitForGroupGone(lastChild, this.cancelWaitMs(deadline));
    if (!gone) {
      return {
        runId: attempt.runId,
        state: 'unproven',
        detail: `run ${attempt.runId}'s process group ${String(lastChild?.pid ?? 'unknown')} is still alive after SIGTERM and SIGKILL`,
      };
    }
    // Proven gone: what is left of the bound is only for the run's own
    // `verification.cancelled` terminal (the stop pass re-reads the ledger),
    // so a drain slower than the bound can no longer un-prove a dead group.
    await settledWithin(attempt.promise, this.cancelWaitMs(deadline));
    return { runId: attempt.runId, state: 'stopped', detail: null };
  }

  /** Wait up to `ms` for the run's process group to be proven gone. No child
   * means nothing was spawned: cessation is already proven. */
  private async waitForGroupGone(child: ChildProcess | null, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (this.groupGone(child)) return true;
      if (Date.now() >= deadline) return false;
      await delay(Math.min(GROUP_PROBE_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    }
  }

  /** True when the child's whole process group is proven absent. The
   * `cancellationProbe` seam substitutes a test's answer for the real probe
   * (a live group cannot be manufactured on purpose). */
  private groupGone(child: ChildProcess | null): boolean {
    if (child === null) return true;
    if (this.opts.cancellationProbe !== undefined) return !this.opts.cancellationProbe();
    return !processGroupAlive(child);
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
        processCommand: null,
        leadsGroup: false,
        child: null,
        lastChild: null,
        cancellation: null,
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
    if (this.disposed || slot === undefined) throw new VerificationDisposedError(); // disposed between grant and spawn
    // A per-job cancel that landed before any command existed ends the run
    // here — ahead of the head_changed check, so a cancel is never recorded
    // as a completed (failed) run. The catch records its cancelled terminal.
    if (slot.cancellation !== null) {
      throw new VerificationCancelledError(slot.cancellation.by, slot.cancellation.reason);
    }
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
    const env = verificationEnvironment(process.env, {
      runId: lease.runId,
      jobId: lease.jobId,
      scope: lease.scope,
      workers,
    });
    const plan = this.buildReuseRoots === null ? null : planCommand(lease.command);
    const planned = plan !== null && plan.buildIndex !== null && plan.refusal === null;
    const steps: readonly string[] = planned ? plan.steps : [lease.command];
    const checks: VerificationCheck[] = [];

    let startedAt = 0;
    let queuedMs = 0;
    let startedEmitted = false;
    let clockStarted = false;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let current: ChildProcess | null = null;
    let exitCode: number | null = null;
    let signal: string | null = null;
    let timedOut = false;
    const hash = createHash('sha256');
    let outputBytes = 0;
    let outputTail = '';
    let runError: Error | null = null;

    const startClock = (): void => {
      if (clockStarted) return;
      clockStarted = true;
      startedAt = this.now();
      queuedMs = startedAt - lease.queuedAt;
      // ONE unchanged wall-clock bound includes reuse output, without
      // manufacturing a physical started receipt before any child exists.
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        const live = current;
        if (live === null) return;
        signalGroup(live, 'SIGTERM');
        const killTimer = setTimeout(() => {
          // Shell exit is not process-group cessation: a TERM-resistant
          // descendant can outlive its shell. A live group pins its pgid, so
          // a positive probe proves these are still our descendants and an
          // absent group grants no authority over a reused number.
          if (current === live || processGroupAlive(live)) signalGroup(live, 'SIGKILL');
        }, this.killGraceMs);
        killTimer.unref?.();
      }, this.opts.limits.runTimeoutMs);
      timeoutTimer.unref?.();
    };

    const emitStarted = async (): Promise<void> => {
      if (current?.pid === undefined) throw new Error('verification started receipt requires its genuine spawned PID');
      startClock();
      startedEmitted = true;
      this.safeRecord({
        kind: 'verification.started',
        jobId: lease.jobId,
        payload: {
          run_id: lease.runId,
          pid: current.pid,
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
    };

    // Every byte the caller sees is hashed here, so the exact-output proof
    // also covers the scheduler's own reuse note. The count/hash/tail are
    // updated PER FRAME immediately before that frame is enqueued: the sink
    // chain is the only serialization point, so two concurrent consumers
    // (stdout, stderr) can interleave their frames across `await`s, and only
    // this order makes `output_sha256` the hash of the concatenated frame
    // text that a capture actually reassembles (issue #554).
    const emit = async (streamName: 'stdout' | 'stderr', text: string): Promise<void> => {
      for (const frame of splitFrames(text)) {
        outputBytes += Buffer.byteLength(frame);
        hash.update(frame);
        outputTail = (outputTail + frame).slice(-OUTPUT_TAIL_MAX_BYTES);
        await sink({ type: 'output', runId: lease.runId, stream: streamName, text: frame });
      }
    };

    const consume = async (stream: Readable | null, streamName: 'stdout' | 'stderr'): Promise<void> => {
      if (stream === null) return;
      for await (const chunk of stream) {
        await emit(streamName, Buffer.isBuffer(chunk) ? chunk.toString('utf-8') : String(chunk));
      }
    };

    /** Spawn one shell, stream it to EOF, and report how it ended. */
    const runStep = async (
      command: string,
      index: number,
    ): Promise<{ readonly exitCode: number | null; readonly signal: string | null }> => {
      const child = spawn('/bin/sh', ['-c', command], {
        cwd: lease.cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stepExit: number | null = null;
      let stepSignal: string | null = null;
      const exited = new Promise<void>((resolveExit) => {
        child.once('error', (error: Error) => { runError = error; resolveExit(); });
        child.once('exit', (code: number | null, exitSignal: NodeJS.Signals | null) => { stepExit = code; stepSignal = exitSignal; resolveExit(); });
      });
      current = child;
      slot.lastChild = child;
      slot.pid = child.pid ?? null;
      slot.child = child;
      // Real child existence precedes every callback/started-frame await;
      // shutdown must not convert an owned native step into a no-start.
      const attempt = [...this.attempts.values()].find((owner) => owner.runId === lease.runId);
      const earlierStepRan = attempt?.started === true;
      if (attempt !== undefined && child.pid !== undefined) attempt.started = true;
      const spawnResult = await new Promise<Error | null>((resolveSpawn) => {
        child.once('spawn', () => resolveSpawn(null));
        child.once('error', (error: Error) => resolveSpawn(error));
      });
      if (spawnResult !== null) {
        if (child.pid === undefined) {
          current = null; slot.child = null; slot.pid = null;
          // An earlier step already executed under this identity: it is
          // consumed, so report a failed run instead of a replayable no-start.
          if (earlierStepRan) { runError = spawnResult; return { exitCode: null, signal: null }; }
          throw new VerificationSpawnFailedError(spawnResult.message);
        }
        throw spawnResult;
      }
      if (child.pid === undefined) throw new Error('native spawn event has no bound PID; verification ownership is UNKNOWN');
      startClock();
      this.safeRecord({ kind: 'verification.process-started', jobId: lease.jobId, payload: {
        run_id: lease.runId, pid: child.pid, scope: lease.scope, command: lease.command,
        process_command: child.spawnargs.join(' '), step_command: command, step_index: index, step_count: steps.length,
        cwd: lease.cwd, sha: git.sha,
      } });
      this.callbackSafe('onSpawn', () =>
        this.opts.onSpawn?.({ lease, pid: child.pid ?? null, command: child.spawnargs.join(' ') }),
      );
      // Decode at the stream boundary so multi-byte characters split across
      // OS pipe chunks never corrupt the streamed output or the tail.
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      this.persistBestEffort();
      if (!startedEmitted) await emitStarted();

      // The runner's OWN drain cut-off is not the step's verdict. A pipe a
      // stray descendant still holds is closed by `destroy()` below, and the
      // async iteration reports that close as ERR_STREAM_PREMATURE_CLOSE —
      // the runner's action, never evidence against the command (#523: three
      // lanes went red this way in one afternoon, every one on an exit-0
      // step). A stream that really fails BEFORE the cut-off still fails the
      // run: `cutOff` is set only right before the runner destroys the pipes.
      let cutOff = false;
      const streamsDone = Promise.all([
        consume(child.stdout, 'stdout'),
        consume(child.stderr, 'stderr'),
      ]).catch((error: unknown) => {
        if (cutOff) return;
        runError ??= error instanceof Error ? error : new Error(String(error));
      });
      try {
        await exited;
        // Streams normally close with the process; cap the drain so an
        // inherited pipe from a stray grandchild cannot hold the slot.
        const drained = await Promise.race([streamsDone.then(() => true), delay(2_000).then(() => false)]);
        cutOff = !drained;
      } finally {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
      if (cutOff) {
        // Said, not swallowed: the exit verdict stands and the capture names
        // the reason the pipes were closed by the runner. Best effort — a
        // capture that cannot take the note must not decide the run.
        try {
          await emit(
            'stdout',
            `[gru-verify] step ${index + 1}: output pipes were still open 2s after the step exited; the runner closed them (the exit verdict stands).\n`,
          );
        } catch { /* the note is diagnostic only */ }
      }
      // Detach only this exact positively exited native child after drain.
      // A spawn/error without exit remains UNKNOWN and is not erased. The
      // run lease still owns its slot between steps; no new work is admitted.
      if (child.exitCode !== null || child.signalCode !== null) {
        if (current === child) current = null;
        if (slot.child === child) { slot.child = null; slot.pid = null; }
        this.persistBestEffort();
      }
      this.callbackSafe('onSettled', () =>
        this.opts.onSettled?.({ lease, pid: child.pid ?? null, command: child.spawnargs.join(' ') }),
      );
      return { exitCode: stepExit, signal: stepSignal };
    };

    const stepOk = (result: { exitCode: number | null; signal: string | null }): boolean =>
      !timedOut && runError === null && result.exitCode === 0 && result.signal === null;

    let halted = false;
    try {
      for (const [index, step] of steps.entries()) {
        const check = (
          status: VerificationCheck['status'],
          extra: Partial<VerificationCheck> = {},
        ): VerificationCheck => ({
          command: step,
          status,
          ran: status === 'passed' || status === 'failed',
          exitCode: null,
          signal: null,
          durationMs: 0,
          reusedFromRunId: null,
          reuseRefusal: null,
          ...extra,
        });
        // A per-job cancel (issue #559) and a shutdown both stop the NEXT
        // step from spawning; the cause decides the run's provenance — an
        // owner cancel is never recorded as a shutdown refusal.
        // Re-read through the map: the pre-spawn check above proved the run
        // was not cancelled THEN, and a cancel can land between steps.
        const cancelled = this.slots.get(lease.runId)?.cancellation ?? null;
        if (halted || timedOut || cancelled !== null || this.disposed) {
          if (!halted && runError === null) {
            if (cancelled !== null) runError = new VerificationCancelledError(cancelled.by, cancelled.reason);
            else if (this.disposed) runError = new VerificationDisposedError();
          }
          halted = true;
          if (planned) checks.push(check('not-run'));
          continue;
        }

        const isBuild = planned && index === plan.buildIndex;
        let reuseRefusal: string | null = null;
        if (isBuild && this.buildReuseRoots !== null) {
          const records = this.buildRecords;
          const before = observeBuildInputs(lease.cwd, env, this.buildReuseRoots);
          reuseRefusal = records.isBuilding(lease.cwd)
            ? 'build-in-flight'
            : inspectReuse(records.get(lease.cwd), before, lease.head);
          const prior = records.get(lease.cwd);
          if (reuseRefusal === null && prior !== undefined) {
            startClock();
            await emit(
              'stdout',
              `[gru-verify] ${step} reused (not executed) from run ${prior.runId}: head, clean tree, configuration, environment and build outputs are unchanged.\n`,
            );
            checks.push(check('reused', { reusedFromRunId: prior.runId }));
            continue;
          }
          records.beginBuild(lease.cwd);
        }

        const stepStarted = this.now();
        let result: { exitCode: number | null; signal: string | null };
        try {
          result = await runStep(step, index);
        } finally {
          if (isBuild) this.buildRecords.endBuild(lease.cwd);
        }
        exitCode = result.exitCode;
        signal = result.signal;
        const ok = stepOk(result);
        if (planned) {
          checks.push(
            check(ok ? 'passed' : 'failed', {
              exitCode: result.exitCode,
              signal: result.signal,
              durationMs: this.now() - stepStarted,
              reuseRefusal,
            }),
          );
        }
        if (isBuild && ok && this.buildReuseRoots !== null && !this.buildRecords.isBuilding(lease.cwd)) {
          this.buildRecords.remember(
            lease.cwd,
            lease.runId,
            observeBuildInputs(lease.cwd, env, this.buildReuseRoots),
            lease.head,
          );
        }
        if (!ok) halted = true;
      }
    } finally {
      if (timeoutTimer !== null) clearTimeout(timeoutTimer);
    }

    // A genuine childless shutdown may already have durably settled the
    // original run/request as no-start while reuse output was awaited.
    // Preserve that refusal rather than publish/remember a completed run.
    if (this.disposed && !startedEmitted) throw new VerificationDisposedError();
    // A cancel owns the verdict once it lands: a step that exited 0 while the
    // cancel was being delivered is a cancelled run, never a pass. A timeout
    // and a cancel that coincide record the cancel and `timed_out: true`.
    const cancellation = this.slots.get(lease.runId)?.cancellation ?? null;
    if (cancellation !== null) {
      if (runError === null) runError = new VerificationCancelledError(cancellation.by, cancellation.reason);
      halted = true;
    }
    const durationMs = clockStarted ? this.now() - startedAt : 0;
    const ok = !halted && !timedOut && runError === null;
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
      ...(planned ? { checks } : {}),
    };
    if (cancellation !== null) {
      // The record's cessation proof IS the stop verdict's: wait (bounded) for
      // the group the cancel signalled to be proven gone, so a row never
      // claims a still-live group as gone. A group that survives keeps the run
      // unsettled, which is what refuses a stop/bin verdict over it.
      const processGroupGone = await this.waitForGroupGone(
        slot.lastChild,
        this.killGraceMs + CANCEL_SETTLE_MARGIN_MS,
      );
      this.cancelledSettled.add(lease.runId);
      this.safeRecord({
        kind: 'verification.cancelled',
        jobId: lease.jobId,
        payload: {
          ...outcomePayload(outcome),
          cancelled: true,
          by: cancellation.by,
          reason: cancellation.reason,
          head: lease.head,
          started: true,
          process_group_gone: processGroupGone,
          timed_out: outcome.timedOut,
        },
      });
      return outcome;
    }
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
        ...(slot.processCommand === null ? {} : { process_command: slot.processCommand }),
        ...(slot.leadsGroup ? { process_group: true } : {}),
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
      this.recordEvent({ ...record, payload: maskedEventPayload(record.payload) });
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
    ...checksFromPayload(payload['checks']),
  };
}

const CHECK_STATUSES: ReadonlySet<string> = new Set(['passed', 'failed', 'reused', 'not-run']);

/** Parse persisted per-step evidence; any malformed entry drops the whole list (never half-evidence). */
function checksFromPayload(value: unknown): { readonly checks?: readonly VerificationCheck[] } {
  if (!Array.isArray(value)) return {};
  const checks: VerificationCheck[] = [];
  for (const item of value as unknown[]) {
    if (item === null || typeof item !== 'object') return {};
    const c = item as Record<string, unknown>;
    if (
      typeof c['command'] !== 'string' ||
      typeof c['status'] !== 'string' ||
      !CHECK_STATUSES.has(c['status']) ||
      typeof c['ran'] !== 'boolean' ||
      typeof c['durationMs'] !== 'number'
    ) {
      return {};
    }
    checks.push({
      command: c['command'],
      status: c['status'] as VerificationCheck['status'],
      ran: c['ran'],
      exitCode: typeof c['exitCode'] === 'number' ? c['exitCode'] : null,
      signal: typeof c['signal'] === 'string' ? c['signal'] : null,
      durationMs: c['durationMs'],
      reusedFromRunId: typeof c['reusedFromRunId'] === 'string' ? c['reusedFromRunId'] : null,
      reuseRefusal: typeof c['reuseRefusal'] === 'string' ? c['reuseRefusal'] : null,
    });
  }
  return { checks };
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
    ...(outcome.checks === undefined ? {} : { checks: outcome.checks }),
  };
}
