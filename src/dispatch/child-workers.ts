import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { LogLevel } from '../logger.js';
import {
  ChildWorkerConflictError,
  RecordNotFound,
  type ChildWorkerAuthority,
  type ChildWorkerRecord,
  type LedgerApi,
} from '../ledger/api.js';
import { isJobTerminal } from '../ledger/states.js';
import type { AgentHandle } from '../runtime/types.js';
import { promptWithTerminalVerdict } from '../runtime/prompt-verdict.js';
import type { PacingGate } from '../runtime/pacing.js';
import { parseTranscriptContent } from '../transcripts/service.js';
import type { AgentSpawner } from './service.js';
import type { WorktreeLane, WorktreePort } from './worktree-port.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Tracked child workers ("sub-minions", issue #161): GC-owned nested
 * workers with durable parentage, idempotent admission through the
 * authenticated dispatch surface, their own lane/session/lifecycle, and a
 * durable result the parent can discover. GC — not a provider-native
 * delegation extension — owns admission, identity, cancellation and the
 * result record.
 *
 * Decisions settled here (issue #161 "decisions to settle at planning"):
 * - Naming/category: children are a RELATIONSHIP over minion-role
 *   sessions (no sixth role): the child's agent row carries
 *   `parentage = 'child'` + `parent_agent_id`, and the board renders
 *   top-level vs child from that honest marker (legacy rows stay
 *   unknown).
 * - Physical topology: unchanged — a child is an independent GC-managed
 *   session, not a mandated separate OS process.
 * - Fanout bound: children never spawn children, and one parent admits
 *   at most MAX_CHILDREN_PER_PARENT logical children.
 * - Result storage: the ledger `child_workers` row carries the terminal
 *   outcome plus the child's own final report text (captured from its
 *   session), with the session file as the durable result reference.
 */

/** One parent admits at most this many logical children (bounded fanout;
 * a named, documented cap — not an arbitrary tool-call/duration bound). */
export const MAX_CHILDREN_PER_PARENT = 4;
/** Bounded task authority: the task text a child may be commissioned with. */
export const CHILD_TASK_MAX_CHARS = 8_000;
export const CHILD_PURPOSE_MAX_CHARS = 500;
export const CHILD_IDEMPOTENCY_KEY_MAX_CHARS = 200;
/** Stored result summaries are bounded (the full report stays readable in
 * the session transcript). */
export const CHILD_RESULT_SUMMARY_MAX_CHARS = 8_000;

/** Tool sets per bounded authority: a read-only child physically cannot
 * write (the runtime is given the narrowed set); a writer child gets the
 * minion role's full set. */
export const READ_ONLY_CHILD_TOOLS: readonly string[] = ['read', 'grep', 'find', 'ls'];

/** Rejection codes name the failed precondition (issue #161 acceptance 1). */
export type ChildWorkerRefusalCode =
  | 'invalid_request'
  | 'unknown_parent'
  | 'parent_not_permitted'
  | 'nested_delegation'
  | 'parent_expired'
  | 'job_mismatch'
  | 'parent_lane_unavailable'
  | 'fanout_cap'
  | 'idempotency_conflict';

/** A named, user-actionable admission refusal. The HTTP surface maps the
 * code + status directly; internal callers get the same truth. */
export class ChildWorkerRefusal extends Error {
  constructor(
    readonly code: ChildWorkerRefusalCode,
    readonly status: number,
    detail: string,
  ) {
    super(detail);
    this.name = 'ChildWorkerRefusal';
  }
}

export interface ChildWorkerRequestInput {
  readonly parentAgentId: string;
  readonly jobId: string;
  readonly purpose: string;
  readonly authority: string;
  readonly task: string;
  readonly idempotencyKey: string;
  readonly label?: string;
}

export interface ChildWorkerAdmission {
  readonly record: ChildWorkerRecord;
  /** True when this call replayed an already-admitted logical child. */
  readonly idempotent: boolean;
}

export interface ChildWorkerServiceOptions {
  readonly ledger: LedgerApi;
  readonly worktrees: WorktreePort;
  readonly spawner: AgentSpawner;
  /** Provider pacing: a child turn consumes the same worker pool as any
   * other minion turn (FIFO; never preempted). Absent = off. */
  readonly workerGate?: PacingGate;
  /** Service-stopping signal: aborts queued admission and marks
   * non-terminal children cancelled instead of leaking a live lane. */
  readonly stopSignal?: AbortSignal;
  readonly log?: Log;
}

/** Render the briefing a child worker receives. The child is a bounded
 * worker with ONE task; the report requirement is explicit so the durable
 * result carries the child's own words, never a fabricated delivery. */
export function renderChildBriefing(input: {
  childId: string;
  parentAgentId: string;
  jobId: string;
  purpose: string;
  authority: ChildWorkerAuthority;
  task: string;
  worktreePath: string;
  branch: string | null;
  baseSha: string | null;
}): string {
  const authorityLine =
    input.authority === 'read-only'
      ? [
          'Authority: read-only. Your tools cannot write. Do not attempt to',
          'modify, create, or delete files; report findings, evidence, and',
          'uncertainty instead.',
        ]
      : [
          'Authority: writer. Commit your work to your own branch; never merge,',
          'never push, and never touch another lane\'s working tree.',
        ];
  return [
    `Child worker briefing — ${input.childId}`,
    `Parent: ${input.parentAgentId} (job ${input.jobId})`,
    `Purpose: ${input.purpose}`,
    `Lane: ${input.worktreePath}${input.branch === null ? ' (detached read-only checkout)' : ` (branch ${input.branch})`}`,
    ...(input.baseSha === null ? [] : [`Base head: ${input.baseSha}`]),
    '',
    ...authorityLine,
    '',
    'TASK:',
    input.task,
    '',
    'You are an independent GC-managed child worker: work only inside this',
    'lane. You cannot commission further workers. End your turn with a',
    'completion report: what you did, the evidence, and any blockers or',
    'uncertainty.',
  ].join('\n');
}

/** Extract the child's own final report text from its session transcript.
 * Returns null when the transcript is unreadable or carries no assistant
 * text — the result then keeps the session file as its durable reference
 * rather than inventing a summary. */
export function extractFinalReport(sessionFile: string | null): string | null {
  if (sessionFile === null) return null;
  try {
    const { entries } = parseTranscriptContent(readFileSync(sessionFile, 'utf-8'));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry !== undefined && entry.kind === 'assistant' && entry.text.trim() !== '') {
        const text = entry.text.trim();
        return text.length > CHILD_RESULT_SUMMARY_MAX_CHARS
          ? `${text.slice(0, CHILD_RESULT_SUMMARY_MAX_CHARS)}…`
          : text;
      }
    }
    return null;
  } catch {
    return null;
  }
}

interface ChildRun {
  readonly controller: AbortController;
  handle: AgentHandle | null;
  /** Set by an explicit cancel; the terminal writer records it. */
  cancelReason: string | null;
}

export class ChildWorkerService {
  private readonly opts: ChildWorkerServiceOptions;
  private readonly log: Log;
  private readonly controller = new AbortController();
  private readonly inFlight = new Set<Promise<unknown>>();
  /** Live runs by child id (queued/running) — the cancellation handle. */
  private readonly live = new Map<string, ChildRun>();

  constructor(opts: ChildWorkerServiceOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    if (opts.stopSignal !== undefined) {
      if (opts.stopSignal.aborted) this.controller.abort();
      else opts.stopSignal.addEventListener('abort', () => this.controller.abort(), { once: true });
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /**
   * Admit one logical child worker (idempotent). Validation is synchronous
   * up to the durable write, so no await can interleave a capability check
   * with admission. The returned record may be `queued` (waiting for the
   * resident budget) or already replay an existing child; the run is
   * tracked in the background and its progress lands in the ledger.
   */
  request(input: ChildWorkerRequestInput): ChildWorkerAdmission {
    const fields = this.validate(input);
    const admission = this.opts.ledger.admitChildWorker({
      id: `child_${randomUUID()}`,
      parentAgentId: fields.parentAgentId,
      jobId: fields.jobId,
      purpose: fields.purpose,
      authority: fields.authority,
      task: fields.task,
      label: fields.label,
      idempotencyKey: fields.idempotencyKey,
    });
    if (!admission.idempotent) {
      this.track(this.run(admission.record));
    }
    return admission;
  }

  /** Every field/precondition refusal names its failed precondition. */
  private validate(input: ChildWorkerRequestInput) {
    const require = (value: string | undefined, field: string): string => {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new ChildWorkerRefusal('invalid_request', 400, `${field} must be a non-empty string`);
      }
      return value;
    };
    const parentAgentId = require(input.parentAgentId, 'parent_agent_id');
    const jobId = require(input.jobId, 'job_id');
    const purpose = require(input.purpose, 'purpose');
    const task = require(input.task, 'task');
    const idempotencyKey = require(input.idempotencyKey, 'idempotency_key');
    if (purpose.length > CHILD_PURPOSE_MAX_CHARS) {
      throw new ChildWorkerRefusal(
        'invalid_request',
        400,
        `purpose exceeds ${CHILD_PURPOSE_MAX_CHARS} characters`,
      );
    }
    if (task.length > CHILD_TASK_MAX_CHARS) {
      throw new ChildWorkerRefusal(
        'invalid_request',
        400,
        `task exceeds ${CHILD_TASK_MAX_CHARS} characters (bounded task authority)`,
      );
    }
    if (idempotencyKey.length > CHILD_IDEMPOTENCY_KEY_MAX_CHARS) {
      throw new ChildWorkerRefusal(
        'invalid_request',
        400,
        `idempotency_key exceeds ${CHILD_IDEMPOTENCY_KEY_MAX_CHARS} characters`,
      );
    }
    if (input.authority !== 'read-only' && input.authority !== 'writer') {
      throw new ChildWorkerRefusal(
        'invalid_request',
        400,
        `authority must be 'read-only' or 'writer', got '${String(input.authority)}'`,
      );
    }
    // A replay of an already-admitted logical child is always answerable,
    // even if the parent has since stopped or expired — the admitted
    // request is immutable and exactly-once.
    const replay = this.opts.ledger
      .listChildWorkers({ parentAgentId })
      .some((child) => child.idempotencyKey === idempotencyKey);
    if (replay) {
      return { parentAgentId, jobId, purpose, task, authority: input.authority as ChildWorkerAuthority, idempotencyKey, label: input.label ?? null };
    }
    const parent = this.opts.ledger.getAgent(parentAgentId);
    if (parent === null) {
      throw new ChildWorkerRefusal(
        'unknown_parent',
        404,
        `unknown parent agent "${parentAgentId}" — no such session in the ledger`,
      );
    }
    if (parent.role !== 'minion') {
      throw new ChildWorkerRefusal(
        'parent_not_permitted',
        403,
        `parent agent "${parentAgentId}" has role "${parent.role}" — only minions may commission child workers`,
      );
    }
    if (parent.parentage === 'child' || parent.parentAgentId !== null) {
      throw new ChildWorkerRefusal(
        'nested_delegation',
        409,
        `parent agent "${parentAgentId}" is itself a child worker — children never spawn children`,
      );
    }
    if (parent.jobId === null) {
      throw new ChildWorkerRefusal(
        'parent_not_permitted',
        403,
        `parent agent "${parentAgentId}" has no job binding — a tracked child needs a parent lane`,
      );
    }
    if (parent.jobId !== jobId) {
      throw new ChildWorkerRefusal(
        'job_mismatch',
        409,
        `parent agent "${parentAgentId}" is bound to job "${parent.jobId}", not "${jobId}"`,
      );
    }
    const job = this.opts.ledger.getJob(jobId);
    if (job === null) {
      throw new ChildWorkerRefusal('invalid_request', 404, `unknown job "${jobId}"`);
    }
    if (isJobTerminal(job.status)) {
      throw new ChildWorkerRefusal(
        'parent_expired',
        409,
        `job "${jobId}" is ${job.status} — an expired lane admits no fresh child worker`,
      );
    }
    if (parent.state === 'disposed') {
      throw new ChildWorkerRefusal(
        'parent_expired',
        409,
        `parent agent "${parentAgentId}" is disposed — a stopped session cannot commission workers`,
      );
    }
    const admittedChildren = this.opts.ledger.listChildWorkers({ parentAgentId });
    if (admittedChildren.length >= MAX_CHILDREN_PER_PARENT) {
      throw new ChildWorkerRefusal(
        'fanout_cap',
        429,
        `parent agent "${parentAgentId}" already admitted ${admittedChildren.length} children ` +
          `(cap ${MAX_CHILDREN_PER_PARENT}) — fanout is bounded`,
      );
    }
    // The parent's live job lane is the child's base; admission without it
    // cannot produce an honest lane, so refuse by precondition.
    const parentLane = this.opts.worktrees
      .listWorktrees({ jobId })
      .find((lane) => lane.kind === 'job' && lane.status === 'active');
    if (parentLane === undefined) {
      throw new ChildWorkerRefusal(
        'parent_lane_unavailable',
        409,
        `job "${jobId}" has no active parent lane — a child lane must base on a live parent lane`,
      );
    }
    return {
      parentAgentId,
      jobId,
      purpose,
      task,
      authority: input.authority as ChildWorkerAuthority,
      idempotencyKey,
      label: input.label ?? null,
    };
  }

  /**
   * The child worker's run: own lane → resident admission (the shared
   * worker budget, FIFO) → spawn with the bounded authority → prompt →
   * durable result → handle disposal. Every failure path lands a terminal
   * `error` result on the record (never a fabricated `done`), and a
   * cancelled admission/stop lands `cancelled`.
   */
  private async run(record: ChildWorkerRecord): Promise<void> {
    let lane: WorktreeLane | null = null;
    let handle: AgentHandle | null = null;
    let lease: { release(): void } | null = null;
    let engineFailure: string | null = null;
    const childController = new AbortController();
    const abortFromService = (): void => childController.abort();
    if (this.signal.aborted) childController.abort();
    else this.signal.addEventListener('abort', abortFromService, { once: true });
    const run: ChildRun = { controller: childController, handle: null, cancelReason: null };
    this.live.set(record.id, run);
    try {
      lane = await this.ensureLane(record);
      if (this.opts.ledger.getChildWorker(record.id)?.state === 'queued') {
        this.opts.ledger.markChildAdmitted(record.id, { worktreeId: lane.id, branch: lane.branch });
      }
      // Provider pacing: the child turn consumes the same worker pool.
      // Resident admission (registry.spawn) bounds LIVE worker sessions;
      // this gate bounds provider-facing turns. Both are FIFO.
      if (this.opts.workerGate !== undefined) {
        lease = await this.opts.workerGate.acquireWorkerTurn({
          id: record.id,
          label: record.label ?? record.purpose,
          jobId: record.jobId,
          signal: childController.signal,
        });
      }
      const isReadOnly = record.authority === 'read-only';
      handle = await this.opts.spawner('minion', {
        cwd: lane.path,
        ...(isReadOnly ? { roleTools: READ_ONLY_CHILD_TOOLS } : {}),
        signal: childController.signal,
      });
      run.handle = handle;
      // Bind identity BEFORE the prompt: the child's agent row carries the
      // parent link and the job, and the runtime tap can never clobber it.
      this.opts.ledger.registerAgent({
        id: handle.id,
        role: 'minion',
        label: record.label ?? `child of ${record.parentAgentId}`,
        jobId: record.jobId,
        sessionFile: handle.sessionFile,
        parentAgentId: record.parentAgentId,
      });
      this.opts.ledger.bindChildAgent(record.id, handle.id);
      this.opts.ledger.markChildStarted(record.id, { sessionFile: handle.sessionFile });
      this.log('info', 'child worker started', {
        child: record.id,
        agent: handle.id,
        parent: record.parentAgentId,
        job: record.jobId,
        authority: record.authority,
        lane: lane.path,
      });
      const briefing = renderChildBriefing({
        childId: record.id,
        parentAgentId: record.parentAgentId,
        jobId: record.jobId,
        purpose: record.purpose,
        authority: record.authority,
        task: record.task,
        worktreePath: lane.path,
        branch: lane.branch,
        baseSha: lane.sha,
      });
      const verdict = await promptWithTerminalVerdict(handle, briefing);
      const result = verdict.ok
        ? ({ state: 'done', summary: extractFinalReport(handle.sessionFile), error: null } as const)
        : ({ state: 'error', summary: null, error: verdict.error ?? 'the child turn settled without positive completion evidence' } as const);
      this.opts.ledger.recordChildResult(record.id, {
        state: result.state,
        summary: result.state === 'done' ? result.summary : result.error,
        ref: handle.sessionFile,
      });
      if (result.state === 'done') {
        this.log('info', 'child worker completed', { child: record.id, agent: handle.id });
      } else {
        this.log('warn', 'child worker errored', { child: record.id, agent: handle.id, error: result.error });
      }
    } catch (error) {
      engineFailure = run.cancelReason !== null
        ? run.cancelReason
        : this.signal.aborted
          ? 'service stopped before the child settled'
          : String(error instanceof Error ? error.message : error);
      this.log('error', 'child worker run failed', { child: record.id, error: engineFailure });
    } finally {
      this.signal.removeEventListener('abort', abortFromService);
      this.live.delete(record.id);
      lease?.release();
      // A recorded result is final; a cancelled admission lands here too
      // (never left non-terminal behind a shutdown).
      try {
        const current = this.opts.ledger.getChildWorker(record.id);
        if (current !== null && current.resultState === null) {
          const cancelled = run.cancelReason !== null || this.signal.aborted;
          this.opts.ledger.recordChildResult(record.id, {
            state: cancelled ? 'cancelled' : 'error',
            summary: engineFailure ?? 'the child run ended without a terminal outcome',
            ref: current.sessionFile,
          });
        }
      } catch (resultError) {
        this.log('error', 'child worker result write failed', {
          child: record.id,
          error: String(resultError),
        });
      }
      if (handle !== null) {
        try {
          await handle.dispose();
        } catch (disposeError) {
          // The resident permit stays counted debt on an unproven dispose;
          // the failure is loud but never masks the recorded result.
          this.log('error', 'child worker dispose failed — resident permit retained as debt', {
            child: record.id,
            agent: handle.id,
            error: String(disposeError),
          });
        }
      }
      // Read-only children leave nothing behind: their detached lane is
      // swept once the run is terminal. Writer children keep their lane
      // (branch deliverables) — release stays an explicit owner action.
      if (lane !== null && record.authority === 'read-only') {
        await this.releaseLaneQuietly(record.id);
      }
    }
  }

  /** Reuse a lane that survived a restart; otherwise create the child
   * worker's own lane at the parent lane's current HEAD. */
  private async ensureLane(record: ChildWorkerRecord): Promise<WorktreeLane> {
    const existing = this.opts.worktrees.getWorktree(record.id);
    if (existing !== null && existing.status !== 'swept') return existing;
    const parentLane = this.opts.worktrees
      .listWorktrees({ jobId: record.jobId })
      .find((lane) => lane.kind === 'job' && lane.status === 'active');
    if (parentLane === undefined) {
      throw new Error(
        `job "${record.jobId}" has no active parent lane — a child lane must base on a live parent lane`,
      );
    }
    return this.opts.worktrees.createChildWorktree({
      repoPath: parentLane.repoPath,
      jobId: record.jobId,
      childId: record.id,
      parentPath: parentLane.path,
      authority: record.authority,
    });
  }

  private async releaseLaneQuietly(worktreeId: string): Promise<void> {
    try {
      const result = await this.opts.worktrees.release({ worktreeId });
      if (result.status === 'paused') {
        this.log('warn', 'child lane release paused on live processes — ask recorded', {
          child: worktreeId,
        });
      }
    } catch (error) {
      this.log('error', 'child lane release failed — lane retained for a later sweep', {
        child: worktreeId,
        error: String(error),
      });
    }
  }

  /**
   * Boot reconciliation (issue #161 edge case: service restarts between
   * admission and result). A child that never bound a session is re-run
   * (idempotent admission, same identity); a child that had a live
   * session is terminally failed with the honest reason — its transcript
   * stays readable, and no fabricated `done` is ever recorded.
   */
  reconcileOnBoot(): { resumed: number; failed: number } {
    let resumed = 0;
    let failed = 0;
    for (const record of this.opts.ledger.listChildWorkers()) {
      if (record.resultState !== null) continue;
      if (record.agentId === null) {
        resumed += 1;
        this.track(this.run(record));
        continue;
      }
      failed += 1;
      this.opts.ledger.recordChildResult(record.id, {
        state: 'error',
        summary: 'service restarted while the child was running — the session did not complete; transcript retained for inspection',
        ref: record.sessionFile,
      });
    }
    return { resumed, failed };
  }

  private track(promise: Promise<unknown>): void {
    this.inFlight.add(promise);
    void promise
      .catch((error: unknown) => {
        this.log('error', 'child worker task crashed outside its contained run', {
          error: String(error),
        });
      })
      .finally(() => this.inFlight.delete(promise));
  }

  /**
   * Cancel a child worker (owner stop or parent cancellation). A terminal
   * child is immutable — the call replays its result. A queued/admitted
   * child is fenced out of admission; a live child's session is disposed
   * and its record lands `cancelled` immediately (the run's own settle is
   * idempotent over the terminal record).
   */
  cancel(childId: string, reason: string): ChildWorkerRecord {
    const record = this.opts.ledger.getChildWorker(childId);
    if (record === null) {
      throw new RecordNotFound(`child worker "${childId}" not found`);
    }
    if (record.resultState !== null) return record;
    const run = this.live.get(childId);
    if (run !== undefined) {
      run.cancelReason = reason;
      run.controller.abort();
      if (run.handle !== null) {
        void run.handle.dispose().catch((error: unknown) => {
          this.log('error', 'cancelled child dispose failed — resident permit retained as debt', {
            child: childId,
            error: String(error),
          });
        });
      }
    }
    return this.opts.ledger.cancelChildWorker(childId, { reason });
  }

  /** Service shutdown: abort queued/running admissions and wait (bounded)
   * for the tracked runs to land their terminal records. */
  async dispose(): Promise<void> {
    this.controller.abort();
    const pending = [...this.inFlight];
    if (pending.length === 0) return;
    await Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => {
        // Stays inside the service's 5 s shutdown force-exit window: the
        // registry's own dispose still owns the handles past this bound.
        const timer = setTimeout(resolve, 3_000);
        timer.unref?.();
      }),
    ]);
  }
}

/** Map a child admission failure onto the HTTP surface. Ledger conflicts
 * (idempotency-key reuse with a different payload, nested/terminal
 * refusals that raced) are 409s with their own code; everything else is
 * the refusal it already is. */
export function childRefusalStatus(error: unknown): { status: number; code: string; detail: string } | null {
  if (error instanceof ChildWorkerRefusal) {
    return { status: error.status, code: error.code, detail: error.message };
  }
  if (error instanceof ChildWorkerConflictError) {
    return { status: 409, code: 'idempotency_conflict', detail: error.message };
  }
  if (error instanceof RecordNotFound) {
    return { status: 404, code: 'not_found', detail: error.message };
  }
  return null;
}
