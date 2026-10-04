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
import type { AgentHandle, NativeAgentTool, SpawnOptions } from '../runtime/types.js';
import { promptWithTerminalVerdict } from '../runtime/prompt-verdict.js';
import {
  settleRetries,
  RetrySettlementUnavailableError,
  type PacingGate,
  type RetrySettlement,
} from '../runtime/pacing.js';
import { parseTranscriptContent } from '../transcripts/service.js';
import type { Role } from '../config.js';
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
 *   at most MAX_CHILDREN_PER_PARENT logical children. Admission also
 *   refuses `budget` when the shared resident pool has no free permit and
 *   no reclaimable idle minion, so a parent waiting on its child can never
 *   deadlock the pool (the issue's named budget/capacity precondition)
 *   while genuinely runnable children still queue FIFO in the registry.
 * - Parent capability: a top-level minion receives a scoped, parent-bound
 *   capability token (only its hash is stored) that authorizes child
 *   requests/reads/cancels for THAT parent; the operator pairing token
 *   remains a superset authority. The token is written to a private
 *   credential file (0600) named in the minion's briefing — never the
 *   operator token.
 * - Result storage: the ledger `child_workers` row carries the terminal
 *   outcome plus the child's own final report text (anchored to the
 *   turn's transcript suffix), with the session file as the reference.
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

/** Rejection codes name the failed precondition (issue #161 acceptance 1).
 * `budget` is the shared resident-capacity precondition: refusal (not an
 * unsatisfiable queue) when no permit is free and none can be reclaimed. */
export type ChildWorkerRefusalCode =
  | 'invalid_request'
  | 'unknown_parent'
  | 'parent_not_permitted'
  | 'nested_delegation'
  | 'parent_expired'
  | 'job_mismatch'
  | 'parent_lane_unavailable'
  | 'fanout_cap'
  | 'budget'
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

/** A child-worker spawn may carry a pre-reserved resident permit. */
export type ChildWorkerSpawner = (
  role: Role,
  options: SpawnOptions,
  residentRelease?: () => void,
) => Promise<AgentHandle>;

/** The supervisor's per-agent restart policy (late-bound). */
export type ChildRestartPolicy =
  | { readonly options: SpawnOptions }
  | { readonly refuse: string };

export interface ChildWorkerServiceOptions {
  readonly ledger: LedgerApi;
  readonly worktrees: WorktreePort;
  readonly spawner: ChildWorkerSpawner;
  /** Provider pacing: a child turn consumes the same worker pool as any
   * other minion turn (FIFO; never preempted). Absent = off. */
  readonly workerGate?: PacingGate;
  /** Provider pacing: the bounded settlement of an automatic rate-limit
   * retry covering the just-delivered child turn (supervisor-backed in
   * production). A child result is recorded only after any pending retry
   * has settled — a `done`/`error` never races a recovery still in flight
   * (#160 delivery truth). Absent = no interlock. */
  readonly retrySettlement?: (agentId: string) => Promise<RetrySettlement>;
  /** Service-stopping signal: aborts queued admission, disposes live child
   * handles and marks non-terminal children cancelled with the stop named. */
  readonly stopSignal?: AbortSignal;
  /** Resident-budget probe for the admission deadlock fence. `available`
   * is free capacity; `reclaimable` is the budget's OWN eligible-idle
   * count (never a bare health-state guess). Absent = no probe. */
  readonly residentProbe?: () => {
    readonly available: number;
    readonly reclaimable: number;
  };
  /** Atomic resident reservation (the same FIFO pool spawn charges): a
   * child reserves its permit at run start, so a free-seat probe race can
   * never admit an unsatisfiable queue. Absent = the spawner charges. */
  readonly reserveResident?: (signal?: AbortSignal) => Promise<() => void>;
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

/** Count assistant entries in a session transcript (the anchor for
 * "this turn's report"). NULL = unreadable/absent: a failed baseline is
 * never treated as an empty session (a later readable transcript could
 * otherwise donate a prior turn's report). */
export function countAssistantEntries(sessionFile: string | null): number | null {
  if (sessionFile === null) return null;
  try {
    const { entries } = parseTranscriptContent(readFileSync(sessionFile, 'utf-8'));
    return entries.filter((entry) => entry.kind === 'assistant').length;
  } catch {
    return null;
  }
}

/**
 * Extract the child's own FINAL report from the transcript suffix after
 * `fromAssistantIndex` — the entries THIS child turn produced. The report
 * must be the turn's LAST transcript entry (a trailing assistant message):
 * an interim progress message followed by more work (or by no closing
 * message) is NOT a completion report and returns null, so the result
 * records a named collection failure instead of publishing commentary as
 * a durable result. `fromAssistantIndex` null = an unreadable baseline,
 * which also refuses (the anchor cannot be proven).
 */
export function extractFinalReport(
  sessionFile: string | null,
  fromAssistantIndex: number | null,
): string | null {
  if (sessionFile === null || fromAssistantIndex === null) return null;
  try {
    const { entries } = parseTranscriptContent(readFileSync(sessionFile, 'utf-8'));
    const last = entries.at(-1);
    // Trailing non-message frames (claude raw stream frames) are inert:
    // the final message itself must still be the assistant report.
    let candidateIndex = entries.length - 1;
    while (candidateIndex >= 0 && entries[candidateIndex]?.kind === 'other') candidateIndex -= 1;
    const candidate = entries[candidateIndex];
    if (last === undefined || candidate === undefined || candidate.kind !== 'assistant') return null;
    // Count assistant entries up to and including the candidate — it must
    // sit at or after this turn's anchor.
    const assistantUpTo = entries
      .slice(0, candidateIndex + 1)
      .filter((entry) => entry.kind === 'assistant').length;
    if (assistantUpTo <= fromAssistantIndex) return null;
    const text = candidate.text.trim();
    if (text === '') return null;
    return text.length > CHILD_RESULT_SUMMARY_MAX_CHARS
      ? `${text.slice(0, CHILD_RESULT_SUMMARY_MAX_CHARS)}…`
      : text;
  } catch {
    return null;
  }
}

interface ChildRun {
  readonly controller: AbortController;
  handle: AgentHandle | null;
  /** Set by an explicit cancel/shutdown; the terminal writer records it. */
  cancelReason: string | null;
  /** The run's own promise (cancel awaits it for the proof-aware result). */
  task: Promise<void> | null;
}

export class ChildWorkerService {
  private readonly opts: ChildWorkerServiceOptions;
  private readonly log: Log;
  private readonly controller = new AbortController();
  private readonly inFlight = new Set<Promise<unknown>>();
  /** Live runs by child id (queued/running) — cancellation handles. */
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

  // ------------------------------------------------------------------
  // GC-mediated parent tools (the minion-facing request surface)
  // ------------------------------------------------------------------

  /**
   * The product-native tools injected into a PARENT session (issue #161):
   * request/list/cancel bound to one agent id by CLOSURE. No bearer secret
   * reaches the session or its filesystem — the runtime executes these in
   * the service process, so a sibling worker cannot impersonate the
   * parent the way a readable credential file would allow.
   */
  parentTools(agentId: string): readonly NativeAgentTool[] {
    const stringField = (input: Record<string, unknown>, field: string): string => {
      const value = input[field];
      if (typeof value !== 'string' || value.trim() === '') {
        throw new ChildWorkerRefusal('invalid_request', 400, `${field} must be a non-empty string`);
      }
      return value;
    };
    const toolInput = (input: unknown): Record<string, unknown> =>
      typeof input === 'object' && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    const failureText = (error: unknown): string => {
      const refusal = childRefusalStatus(error);
      return JSON.stringify({
        error: refusal?.code ?? 'failed',
        detail: refusal?.detail ?? String(error instanceof Error ? error.message : error),
      });
    };
    return [
      {
        name: 'request_child_worker',
        description:
          'Commission ONE independent GC-tracked child worker (a bounded minion) for this session\'s job. ' +
          'The child gets its own lane, session and durable result; read-only authority cannot write, ' +
          'writer authority gets its own branch. Children cannot spawn children. Use the returned child_id ' +
          'with list_child_workers to discover the result.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['purpose', 'authority', 'task', 'idempotency_key'],
          properties: {
            purpose: { type: 'string', description: 'Why this child is needed (bounded, <=500 chars).' },
            authority: { type: 'string', enum: ['read-only', 'writer'], description: 'Bounded task authority.' },
            task: { type: 'string', description: 'The task the child executes (bounded, <=8000 chars).' },
            idempotency_key: { type: 'string', description: 'Caller-supplied key; a retry with the same key returns the same child.' },
            label: { type: 'string', description: 'Optional short label.' },
          },
        },
        execute: async (input) => {
          try {
            const fields = toolInput(input);
            const parent = this.opts.ledger.getAgent(agentId);
            if (parent === null || parent.jobId === null) {
              throw new ChildWorkerRefusal('unknown_parent', 404, `parent agent "${agentId}" is not a bound minion session`);
            }
            const admission = this.request({
              parentAgentId: agentId,
              jobId: parent.jobId,
              purpose: stringField(fields, 'purpose'),
              authority: stringField(fields, 'authority'),
              task: stringField(fields, 'task'),
              idempotencyKey: stringField(fields, 'idempotency_key'),
              ...(typeof fields['label'] === 'string' && fields['label'].trim() !== '' ? { label: fields['label'] } : {}),
            });
            return {
              text: JSON.stringify({
                child_id: admission.record.id,
                state: admission.record.state,
                authority: admission.record.authority,
                idempotent: admission.idempotent,
              }),
              details: { childId: admission.record.id, state: admission.record.state },
            };
          } catch (error) {
            return { text: failureText(error) };
          }
        },
      },
      {
        name: 'list_child_workers',
        description:
          'List this session\'s GC-tracked child workers with their lifecycle state and durable result ' +
          '(result_state, result_summary, result_ref). This is how a parent discovers completion or failure.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        execute: async () => {
          const children = this.opts.ledger.listChildWorkers({ parentAgentId: agentId }).map((child) => ({
            child_id: child.id,
            purpose: child.purpose,
            authority: child.authority,
            state: child.state,
            result_state: child.resultState,
            result_summary: child.resultSummary,
            result_ref: child.resultRef,
          }));
          return { text: JSON.stringify({ children }), details: { count: children.length } };
        },
      },
      {
        name: 'cancel_child_worker',
        description:
          'Cancel one of this session\'s child workers (by child_id). Terminal children are immutable. ' +
          'Cancellation is proof-aware: a session that cannot prove cessation stays non-terminal.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['child_id'],
          properties: {
            child_id: { type: 'string', description: 'The child id returned by request_child_worker.' },
            reason: { type: 'string', description: 'Optional reason recorded with the cancellation.' },
          },
        },
        execute: async (input) => {
          try {
            const fields = toolInput(input);
            const childId = stringField(fields, 'child_id');
            const child = this.opts.ledger.getChildWorker(childId);
            if (child === null || child.parentAgentId !== agentId) {
              throw new ChildWorkerRefusal('unknown_parent', 404, `child "${childId}" is not owned by this session`);
            }
            const record = await this.cancel(
              childId,
              typeof fields['reason'] === 'string' && fields['reason'].trim() !== ''
                ? fields['reason']
                : 'cancelled by the parent session',
            );
            return {
              text: JSON.stringify({ child_id: record.id, state: record.state, result_state: record.resultState }),
              details: { childId: record.id, state: record.state },
            };
          } catch (error) {
            return { text: failureText(error) };
          }
        },
      },
    ];
  }

  // ------------------------------------------------------------------
  // Admission
  // ------------------------------------------------------------------

  /**
   * Admit one logical child worker (idempotent). Validation is synchronous
   * up to the durable write, so no await can interleave a capability check
   * with admission. The returned record may be `queued` (waiting for its
   * lane/resident admission) or already replay an existing child; the run
   * is tracked in the background and its progress lands in the ledger.
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
      this.start(admission.record);
    }
    return admission;
  }

  private start(record: ChildWorkerRecord): void {
    const task = this.run(record);
    const entry = this.live.get(record.id);
    if (entry !== undefined) entry.task = task;
    this.track(task);
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
    // Resident-capacity deadlock fence (review finding): a child is
    // admitted only when the shared pool has a free permit OR a reclaimable
    // idle minion; otherwise the parent gets the issue's named
    // budget/capacity refusal instead of an unsatisfiable queue (a parent
    // blocked on its child would otherwise hold the last seats forever).
    const probe = this.opts.residentProbe?.();
    if (probe !== undefined && probe.available < 1 && probe.reclaimable < 1) {
      throw new ChildWorkerRefusal(
        'budget',
        429,
        'resident worker capacity is fully occupied and no eligible idle minion can be reclaimed — ' +
          'retry once capacity frees (children consume the same [concurrency] max_workers pool)',
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

  // ------------------------------------------------------------------
  // Run lifecycle
  // ------------------------------------------------------------------

  /** Revalidate parent/job/lane authority immediately before any start or
   * restart — admission-time checks alone cannot see a parent that stopped
   * while the child waited (issue #161 AC6). Returns a refusal reason. */
  private ineligibility(record: ChildWorkerRecord): string | null {
    const parent = this.opts.ledger.getAgent(record.parentAgentId);
    if (parent === null) return `parent agent "${record.parentAgentId}" no longer exists`;
    if (parent.parentage === 'child' || parent.parentAgentId !== null) {
      return `parent agent "${record.parentAgentId}" is itself a child worker`;
    }
    if (parent.state === 'disposed') return `parent agent "${record.parentAgentId}" is disposed`;
    const job = this.opts.ledger.getJob(record.jobId);
    if (job === null) return `job "${record.jobId}" no longer exists`;
    if (isJobTerminal(job.status)) return `job "${record.jobId}" is ${job.status} — the lane expired`;
    return null;
  }

  /**
   * The child worker's run: own lane → spawn (shared resident budget, FIFO)
   * → provider pacing → prompt → durable result → handle disposal. Every
   * failure path lands a terminal `error` result (never a fabricated
   * `done`); cancellation records `cancelled` only when cessation is
   * proven, else a named unproven-cessation error.
   */
  private async run(record: ChildWorkerRecord): Promise<void> {
    let lane: WorktreeLane | null = null;
    let handle: AgentHandle | null = null;
    let lease: { release(): void } | null = null;
    let residentRelease: (() => void) | null = null;
    let engineFailure: string | null = null;
    /** The child briefing was actually delivered to the model. */
    let delivered = false;
    const childController = new AbortController();
    const abortFromService = (): void => childController.abort();
    if (this.signal.aborted) childController.abort();
    else this.signal.addEventListener('abort', abortFromService, { once: true });
    const run: ChildRun = { controller: childController, handle: null, cancelReason: null, task: null };
    this.live.set(record.id, run);
    try {
      const preLane = this.ineligibility(record);
      if (preLane !== null) {
        this.opts.ledger.recordChildResult(record.id, { state: 'error', summary: preLane, ref: null });
        return;
      }
      lane = await this.ensureLane(record);
      if (this.opts.ledger.getChildWorker(record.id)?.state === 'queued') {
        this.opts.ledger.markChildAdmitted(record.id, { worktreeId: lane.id, branch: lane.branch });
      }
      // The lane creation awaited: revalidate before spending a session.
      const postLane = this.ineligibility(record);
      if (postLane !== null) {
        this.opts.ledger.recordChildResult(record.id, { state: 'error', summary: postLane, ref: null });
        return;
      }
      const isReadOnly = record.authority === 'read-only';
      // Spawn BEFORE provider pacing: the session waits for the resident
      // permit (a durable FIFO admission), and only then does it take a
      // scarce provider turn slot — a child blocked on capacity can never
      // hold the pacing pool hostage. Issue #161 round 2: the permit is
      // RESERVED up front through the budget, so two racing admissions can
      // never both act on one free-seat observation.
      if (this.opts.reserveResident !== undefined) {
        residentRelease = await this.opts.reserveResident(childController.signal);
      }
      try {
        handle = await this.opts.spawner(
          'minion',
          {
            cwd: lane.path,
            agentId: record.id,
            ...(isReadOnly ? { roleTools: READ_ONLY_CHILD_TOOLS } : {}),
            signal: childController.signal,
          },
          residentRelease ?? undefined,
        );
        residentRelease = null; // ownership passed to the spawned handle
      } catch (error) {
        residentRelease?.();
        residentRelease = null;
        throw error;
      }
      run.handle = handle;
      // The admission row already carries the identity; bind the session
      // file and (idempotently) refresh the parent link.
      this.opts.ledger.registerAgent({
        id: handle.id,
        role: 'minion',
        label: record.label ?? `child of ${record.parentAgentId}`,
        jobId: record.jobId,
        sessionFile: handle.sessionFile,
        parentAgentId: record.parentAgentId,
      });
      // Resident admission may have waited a long time: revalidate once
      // more before the model acts.
      const postAdmission = this.ineligibility(record);
      if (postAdmission !== null) {
        this.opts.ledger.recordChildResult(record.id, { state: 'error', summary: postAdmission, ref: handle.sessionFile });
        return;
      }
      if (this.opts.workerGate !== undefined) {
        lease = await this.opts.workerGate.acquireWorkerTurn({
          id: record.id,
          label: record.label ?? record.purpose,
          jobId: record.jobId,
          signal: childController.signal,
        });
      }
      if (run.cancelReason !== null || childController.signal.aborted || this.signal.aborted) {
        throw new Error(run.cancelReason ?? 'stopped before delivery');
      }
      // The pacing wait is asynchronous too: revalidate AFTER it, so a
      // parent/job that expired while the turn slot was queued fences the
      // child before any briefing is delivered.
      const postPacing = this.ineligibility(record);
      if (postPacing !== null) {
        this.opts.ledger.recordChildResult(record.id, { state: 'error', summary: postPacing, ref: handle.sessionFile });
        return;
      }
      const assistantBefore = countAssistantEntries(handle.sessionFile);
      if (assistantBefore === null) {
        this.opts.ledger.recordChildResult(record.id, {
          state: 'error',
          summary: 'the child transcript baseline is unreadable — refusing to anchor a report to an unknown suffix',
          ref: handle.sessionFile,
        });
        return;
      }
      // The child is `active` only when its briefing is actually about to
      // be delivered (a pacing wait is still queued/admitted truth).
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
      delivered = true;
      const verdict = await promptWithTerminalVerdict(handle, briefing);
      // Shutdown/cancel takes precedence over a late successful settle:
      // a stopped child never records `done`.
      if (run.cancelReason !== null || this.signal.aborted) {
        engineFailure = run.cancelReason ?? 'service stopped before the child settled';
        return;
      }
      // Release the turn slot BEFORE the settlement wait: the automatic
      // retry reacquires its own pacing admission.
      lease?.release();
      lease = null;
      const settlement = await settleRetries(
        this.opts.retrySettlement,
        handle.id,
        this.signal,
      ).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (run.cancelReason !== null || this.signal.aborted) {
        engineFailure = run.cancelReason ?? 'service stopped before the child settled';
        return;
      }
      if (!settlement.ok) {
        if (!(settlement.error instanceof RetrySettlementUnavailableError)) throw settlement.error;
        const detail = String(settlement.error);
        this.opts.ledger.recordChildResult(record.id, {
          state: 'error',
          summary: `pacing settlement unavailable — internal error: ${detail.slice(0, 200)}`,
          ref: handle.sessionFile,
        });
        return;
      }
      if (settlement.value === 'cancelled') {
        engineFailure = 'service stopped before the automatic retries settled';
        return;
      }
      if (settlement.value === 'exhausted' || settlement.value === 'superseded') {
        this.opts.ledger.recordChildResult(record.id, {
          state: 'error',
          summary: `automatic rate-limit retry ${settlement.value} — the child turn did not deliver`,
          ref: handle.sessionFile,
        });
        this.log('warn', 'child worker did not survive its automatic retries', {
          child: record.id,
          agent: handle.id,
          disposition: settlement.value,
        });
        return;
      }
      const evidence = settlement.value === 'recovered' ? { ok: true, error: null } : verdict;
      if (!evidence.ok) {
        this.opts.ledger.recordChildResult(record.id, {
          state: 'error',
          summary: evidence.error ?? 'the child turn settled without positive completion evidence',
          ref: handle.sessionFile,
        });
        this.log('warn', 'child worker errored', { child: record.id, agent: handle.id, error: evidence.error });
        return;
      }
      // Delivery truth (#160/#161): a clean turn must ALSO carry the
      // child's own final report; a successful turn without one is a named
      // result-collection failure, never a fully reported `done`.
      const summary = extractFinalReport(handle.sessionFile, assistantBefore);
      if (summary === null) {
        this.opts.ledger.recordChildResult(record.id, {
          state: 'error',
          summary: 'the child turn completed but no final report followed it in the transcript — transcript retained',
          ref: handle.sessionFile,
        });
        this.log('warn', 'child worker completed without a collectable report', { child: record.id, agent: handle.id });
        return;
      }
      this.opts.ledger.recordChildResult(record.id, { state: 'done', summary, ref: handle.sessionFile });
      this.log('info', 'child worker completed', { child: record.id, agent: handle.id });
    } catch (error) {
      engineFailure = run.cancelReason !== null
        ? run.cancelReason
        : this.signal.aborted
          ? 'service stopped before the child settled'
          : String(error instanceof Error ? error.message : error);
      this.log('error', 'child worker run failed', { child: record.id, error: engineFailure });
    } finally {
      this.signal.removeEventListener('abort', abortFromService);
      lease?.release();
      let ceased = handle === null;
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
        ceased = safeHealthState(handle) === 'disposed';
      }
      // A recorded result is final. The cancelled path terminalizes ONLY
      // with proven cessation; an unproven stop stays NON-TERMINAL (the
      // session may still be live), records durable stop debt, and keeps
      // its live run so a later cancel can retry the proof-aware stop.
      try {
        const current = this.opts.ledger.getChildWorker(record.id);
        if (current !== null && current.resultState === null) {
          const cancelled = run.cancelReason !== null || this.signal.aborted;
          if (cancelled && !ceased) {
            this.opts.ledger.appendCustomEvent({
              kind: 'child.stop-unproven',
              agentId: handle?.id ?? null,
              jobId: record.jobId,
              payload: {
                childId: record.id,
                reason: run.cancelReason ?? 'service stopped',
                health: safeHealthState(handle),
                note: 'cancellation could not prove cessation; the record stays non-terminal and the permit remains counted debt',
              },
            });
            this.log('warn', 'child stop could not prove cessation — record stays non-terminal', {
              child: record.id,
              health: safeHealthState(handle),
            });
          } else if (cancelled) {
            this.opts.ledger.recordChildResult(record.id, {
              state: 'cancelled',
              summary: engineFailure ?? run.cancelReason ?? 'cancelled',
              ref: current.resultRef ?? current.sessionFile,
            });
          } else {
            this.opts.ledger.recordChildResult(record.id, {
              state: 'error',
              summary: engineFailure ?? 'the child run ended without a terminal outcome',
              ref: current.sessionFile,
            });
          }
        }
      } catch (resultError) {
        this.log('error', 'child worker result write failed', {
          child: record.id,
          error: String(resultError),
        });
      }
      const terminal = this.opts.ledger.getChildWorker(record.id)?.resultState !== null;
      if (terminal) this.live.delete(record.id);
      else if (handle !== null) run.handle = handle; // stop debt: keep the handle for a proof-aware retry
      // Read-only children leave nothing behind: their detached lane is
      // swept once the run is terminal. A child whose turn was never
      // delivered (fenced, cancelled or aborted before the prompt) has no
      // deliverables either, whatever its authority. Writer children that
      // actually delivered keep their lane (branch deliverables) — release
      // stays an explicit owner action. An UNPROVEN stop never releases:
      // the session may still own the checkout.
      if (
        lane !== null &&
        (record.authority === 'read-only' || !delivered) &&
        this.opts.ledger.getChildWorker(record.id)?.resultState !== null
      ) {
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
   * Cancel a child worker (owner stop or parent cancellation). Awaiting
   * THIS call resolves after the run's proof-aware finalization: `cancelled`
   * is recorded ONLY when cessation is proven; an unproven stop returns the
   * still-non-terminal record (durable `child.stop-unproven` debt), and a
   * later cancel retries the disposal. A terminal child is immutable.
   */
  async cancel(childId: string, reason: string): Promise<ChildWorkerRecord> {
    const record = this.opts.ledger.getChildWorker(childId);
    if (record === null) {
      throw new RecordNotFound(`child worker "${childId}" not found`);
    }
    if (record.resultState !== null) return record;
    const run = this.live.get(childId);
    if (run === undefined) {
      // No live run (not started yet, or already finalized): record the
      // cancellation; a not-yet-started run's revalidation sees the
      // terminal record before it can deliver anything.
      return this.opts.ledger.cancelChildWorker(childId, { reason });
    }
    run.cancelReason = reason;
    run.controller.abort();
    if (run.handle !== null) {
      try {
        await run.handle.dispose();
      } catch (error) {
        this.log('error', 'cancelled child dispose failed — permit retained as debt', {
          child: childId,
          error: String(error),
        });
      }
    }
    if (run.task !== null) await run.task;
    // Only the run's own finalizer terminalizes: an unproven stop stays
    // non-terminal, and the caller sees that honestly.
    return this.opts.ledger.getChildWorker(childId) as ChildWorkerRecord;
  }

  /**
   * Boot reconciliation (issue #161 edge case: service restarts between
   * admission and result). A child that never bound a session is re-run
   * under the same identity (only when its parent/job are still usable); a
   * child that had a live session is terminally failed with the honest
   * reason, and its read-only lane is swept through the preserve-first
   * release path — never a fabricated `done`, never a leaked detached lane.
   */
  reconcileOnBoot(): { resumed: number; failed: number } {
    let resumed = 0;
    let failed = 0;
    for (const record of this.opts.ledger.listChildWorkers()) {
      if (record.resultState !== null) {
        // A terminal record may still own a live read-only lane (crash
        // between the result write and the release in `run`'s finally).
        if (record.authority === 'read-only') {
          void this.releaseLaneQuietly(record.id);
        }
        continue;
      }
      if (record.sessionFile === null) {
        const reason = this.ineligibility(record);
        if (reason === null) {
          resumed += 1;
          this.start(record);
        } else {
          failed += 1;
          this.opts.ledger.recordChildResult(record.id, {
            state: 'error',
            summary: `service restarted before the child started, and it is no longer eligible: ${reason}`,
            ref: null,
          });
          if (record.authority === 'read-only') void this.releaseLaneQuietly(record.id);
        }
        continue;
      }
      failed += 1;
      this.opts.ledger.recordChildResult(record.id, {
        state: 'error',
        summary: 'service restarted while the child was running — the session did not complete; transcript retained for inspection',
        ref: record.sessionFile,
      });
      if (record.authority === 'read-only') void this.releaseLaneQuietly(record.id);
    }
    return { resumed, failed };
  }

  /**
   * The supervisor's late-bound restart policy for a child agent: a child
   * is ALWAYS restarted in its own lane with its bounded tool authority
   * (never the default cwd/full minion set). When the lane is gone or the
   * parent/job expired, the restart is refused and the child terminalizes
   * honestly.
   */
  restartPolicy(agentId: string, role: string): ChildRestartPolicy | undefined {
    if (role !== 'minion') return undefined;
    const record = this.opts.ledger.childWorkerByAgent(agentId);
    if (record === null) return undefined; // not a tracked child
    if (record.resultState !== null) return { refuse: `child worker "${record.id}" is already terminal` };
    // SETTLED DECISION (issue #161 review round 2): a tracked child is a
    // SINGLE-RUN logical worker. A supervision restart would create a
    // second live session under one logical-child result, with two writers
    // to the same lane and no owner for the restarted turn's outcome — so
    // the restart is refused and the child terminalizes honestly (stopped,
    // with the reason recorded); the parent requests a NEW child instead.
    // The supervisor's breaker/stop/ownership still apply in full.
    const reason = this.ineligibility(record) ?? 'child workers are single-run; a replacement session would duplicate the logical child';
    this.opts.ledger.recordChildResult(record.id, {
      state: 'error',
      summary: `supervision restart refused: ${reason}`,
      ref: record.sessionFile,
    });
    if (record.authority === 'read-only') void this.releaseLaneQuietly(record.id);
    return { refuse: reason };
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

  /** Service shutdown: abort queued/running admissions, dispose live child
   * handles (so no prompt outlives the service), then wait (bounded) for
   * the tracked runs to land their terminal records. */
  async dispose(): Promise<void> {
    this.controller.abort();
    for (const run of this.live.values()) {
      run.cancelReason ??= 'service stopped before the child settled';
      run.controller.abort();
      if (run.handle !== null) {
        void run.handle.dispose().catch((error: unknown) => {
          this.log('error', 'child dispose during shutdown failed — permit retained as debt', {
            error: String(error),
          });
        });
      }
    }
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

function safeHealthState(handle: AgentHandle | null): string {
  if (handle === null) return 'disposed';
  try {
    return handle.health().state;
  } catch {
    return 'unknown';
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
