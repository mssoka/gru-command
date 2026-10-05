/**
 * Durable pipeline queue — typed domain (approved queue contract,
 * j-239 + j-1064 presentation approval).
 *
 * A complete approved executable briefing is persisted as a queue ENTRY;
 * it becomes executable only through the explicit state machine below.
 * This module is the pure vocabulary and evaluator shared by the ledger
 * boundary (src/ledger/api.ts), the mechanical consumer
 * (src/dispatch/pipeline.ts) and the board projection, so admission and
 * presentation can never disagree about what "ready", "waiting" or a
 * concrete wait reason means.
 *
 * Binding rules (from the approved briefs):
 * - Only entries persisted through the authenticated enqueue API are
 *   executable; nothing here can invent approval from an ACK, age, a
 *   GitHub issue, prose or model inference.
 * - A blocked high-priority entry never head-of-line blocks unrelated
 *   eligible work: the evaluator is per-entry and deterministic.
 * - Waiting reasons are exact: owner hold, missing prerequisite, failed/
 *   cancelled prerequisite, unmet milestone, dependency cycle, exclusive
 *   scope held, or shared-capacity wait. The shared resident budget is
 *   the ONLY capacity authority (read through a provider) — no second
 *   counter lives here.
 * - `admitted` work leaves the pipeline: its lifecycle is the normal job
 *   lifecycle; `failed`/`cancelled` are terminal history.
 */

import { isJobTerminal, type JobStatus } from './states.js';

// ------------------------------------------------------------------
// Vocabulary
// ------------------------------------------------------------------

export const PIPELINE_STATES = ['waiting', 'ready', 'admitting', 'admitted', 'failed', 'cancelled'] as const;
export type PipelineState = (typeof PIPELINE_STATES)[number];

export function isPipelineState(value: string): value is PipelineState {
  return (PIPELINE_STATES as readonly string[]).includes(value);
}

/** Prerequisite milestones are explicit and closed: an entry is eligible
 * only when every prerequisite reached the named milestone. */
export const PIPELINE_MILESTONES = ['admitted', 'delivered', 'merged', 'done'] as const;
export type PipelineMilestone = (typeof PIPELINE_MILESTONES)[number];

export function isPipelineMilestone(value: string): value is PipelineMilestone {
  return (PIPELINE_MILESTONES as readonly string[]).includes(value);
}

export const PIPELINE_PRIORITY_MIN = 0;
export const PIPELINE_PRIORITY_MAX = 9;
export const PIPELINE_PRIORITY_DEFAULT = 5;

export interface PipelinePrerequisite {
  readonly id: string;
  readonly milestone: PipelineMilestone;
}

export interface PipelineClaim {
  readonly holder: string;
  readonly since: string;
}

/** One durable queue entry (current state; history is the events table). */
export interface PipelineEntryRecord {
  readonly id: string;
  readonly repoPath: string;
  readonly repo: string;
  readonly title: string;
  /** The complete approved executable briefing — persisted verbatim and
   * never mutated after acceptance. */
  readonly briefing: string;
  readonly briefingHash: string;
  readonly priority: number;
  /** Durable enqueue ordering: strictly increasing, unique. */
  readonly enqueueSeq: number;
  readonly state: PipelineState;
  readonly holdReason: string | null;
  readonly prerequisites: readonly PipelinePrerequisite[];
  /** Exclusive resource/scope names; entries sharing one serialize. */
  readonly exclusiveScopes: readonly string[];
  /** Idempotency identity of the accepted request (defaults to the id). */
  readonly requestId: string;
  /** sha256 of the canonical accepted payload; a changed replay conflicts. */
  readonly payloadHash: string;
  /** Set once admitted: the job that owns the lifecycle from then on. */
  readonly jobId: string | null;
  readonly claim: PipelineClaim | null;
  readonly failureReason: string | null;
  readonly failureCount: number;
  /** Crash-recovery note (never a failure narrative). */
  readonly reconcileNote: string | null;
  readonly queuedAt: string;
  readonly claimedAt: string | null;
  readonly admittedAt: string | null;
  readonly updatedAt: string;
}

/** The board projection of one active entry (no briefing — list
 * projections never leak private briefings). */
export interface PipelineEntryBoardView {
  readonly id: string;
  readonly repo: string;
  readonly title: string;
  readonly priority: number;
  readonly enqueueSeq: number;
  readonly state: 'waiting' | 'ready' | 'admitting' | 'failed';
  readonly reason: string | null;
  readonly queuedAt: string;
}

export interface PipelineBoardView {
  readonly entries: readonly PipelineEntryBoardView[];
  /** Executable entries only (waiting + ready + admitting) — the full
   * count, never the preview window. Terminal `failed` rows stay visible
   * in `entries` as machine attention but never count as pending work. */
  readonly pending: number;
}

// ------------------------------------------------------------------
// Validation / codecs
// ------------------------------------------------------------------

export function validatePipelinePriority(value: number): number {
  if (!Number.isSafeInteger(value) || value < PIPELINE_PRIORITY_MIN || value > PIPELINE_PRIORITY_MAX) {
    throw new Error(
      `pipeline priority must be an integer in ${PIPELINE_PRIORITY_MIN}..${PIPELINE_PRIORITY_MAX}, got ${String(value)}`,
    );
  }
  return value;
}

/** The shared record-identity contract for entry ids AND prerequisite ids
 * (Perkins r3 warning): an id that cannot be enqueued must never be
 * accepted as a prerequisite, or the dependent waits forever. The ledger
 * boundary uses this same predicate for `requireSafeRecordId`. */
export function isSafePipelineRecordId(value: string, maxLength = 128): boolean {
  return (
    value.length > 0 &&
    value.length <= maxLength &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

function reqStr(source: Record<string, unknown>, key: string, what: string): string {
  const value = source[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${what}.${key} must be a non-empty string`);
  }
  return value;
}

export function parsePipelinePrerequisites(raw: string): readonly PipelinePrerequisite[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('pipeline prerequisites must be a JSON array');
  const seen = new Set<string>();
  return parsed.map((entry) => {
    const record = asRecord(entry, 'pipeline prerequisite');
    const id = reqStr(record, 'id', 'pipeline prerequisite');
    // A prerequisite id is an entry id: it must satisfy the same identity
    // contract as enqueue (exact, unpadded, safe charset, ≤128 chars) or
    // the dependent would wait forever on an unenqueuable id (Perkins r3
    // warning). Legitimate forward references (not yet enqueued) stay
    // allowed — they are valid ids, just absent rows.
    if (id !== id.trim()) {
      throw new Error('pipeline prerequisite id must not be whitespace-padded');
    }
    if (!isSafePipelineRecordId(id)) {
      throw new Error(`pipeline prerequisite id "${id}" must be a safe 128-character record identifier`);
    }
    const milestone = reqStr(record, 'milestone', 'pipeline prerequisite');
    if (!isPipelineMilestone(milestone)) {
      throw new Error(`pipeline prerequisite milestone "${milestone}" is not one of ${PIPELINE_MILESTONES.join(', ')}`);
    }
    if (seen.has(id)) throw new Error(`pipeline prerequisite "${id}" is listed twice`);
    seen.add(id);
    return { id, milestone };
  });
}

export function validatePipelinePrerequisites(prerequisites: readonly PipelinePrerequisite[]): readonly PipelinePrerequisite[] {
  return parsePipelinePrerequisites(JSON.stringify(prerequisites));
}

export function parseExclusiveScopes(raw: string): readonly string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('pipeline exclusive scopes must be a JSON array');
  const seen = new Set<string>();
  return parsed.map((entry) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error('pipeline exclusive scopes must be non-empty strings');
    }
    // Scope names are lock keys: a padded name would mint a DIFFERENT key
    // than its trimmed twin and let apparently-shared work run concur-
    // rently (review: exclusive-lock key identity). Reject padded keys at
    // acceptance — normalization would silently rewrite accepted briefs.
    if (entry !== entry.trim()) {
      throw new Error('pipeline exclusive scope must not be whitespace-padded');
    }
    if (entry.length > 200) throw new Error('pipeline exclusive scope exceeds 200 characters');
    if (seen.has(entry)) throw new Error(`pipeline exclusive scope "${entry}" is listed twice`);
    seen.add(entry);
    return entry;
  });
}

export function validateExclusiveScopes(scopes: readonly string[]): readonly string[] {
  return parseExclusiveScopes(JSON.stringify(scopes));
}

export function parsePipelineClaim(raw: string | null): PipelineClaim | null {
  if (raw === null || raw === '') return null;
  const record = asRecord(JSON.parse(raw), 'pipeline claim');
  return { holder: reqStr(record, 'holder', 'pipeline claim'), since: reqStr(record, 'since', 'pipeline claim') };
}

// ------------------------------------------------------------------
// Deterministic order (approved: priority, enqueue sequence, stable id)
// ------------------------------------------------------------------

export function pipelineOrder(
  left: Pick<PipelineEntryRecord, 'priority' | 'enqueueSeq' | 'id'>,
  right: Pick<PipelineEntryRecord, 'priority' | 'enqueueSeq' | 'id'>,
): number {
  return (
    left.priority - right.priority ||
    left.enqueueSeq - right.enqueueSeq ||
    left.id.localeCompare(right.id)
  );
}

// ------------------------------------------------------------------
// Evaluation (one authority for admission + board)
// ------------------------------------------------------------------

/** The shared resident budget state as the queue sees it (read-only; the
 * budget itself stays the authority). */
export interface PipelineCapacityView {
  readonly capacity: number;
  readonly occupied: number;
  readonly queued: number;
  readonly available: number;
}

export interface PipelineEvaluationContext {
  /** Every entry (any state) — prerequisites resolve against this set. */
  readonly entries: readonly PipelineEntryRecord[];
  /** Job status by job id (null when the job row does not exist). */
  readonly jobStatusOf: (jobId: string) => JobStatus | null;
  /** Durable delivery proof by job id: true only when the ledger holds a
   * recorded successful delivery event for that job. Status alone never
   * proves a briefing turn was delivered (working → in-review/done are
   * legal transitions without one). */
  readonly jobDeliveredOf: (jobId: string) => boolean;
  /** Durable worker-start proof by job id: true only when the job has a
   * registered worker (agent row), a lane worktree or a recorded
   * minion-spawned event — the evidence an `admitted` milestone needs
   * before it can release dependents. */
  readonly jobStartedOf: (jobId: string) => boolean;
  readonly capacity: PipelineCapacityView;
}

export interface PipelineEvaluation {
  /** The honest presentation state (never `admitted`/`cancelled`: those
   * are excluded from the projection before evaluation). */
  readonly state: 'waiting' | 'ready' | 'admitting' | 'failed';
  /** Exact wait/failure reason; null only for a genuinely ready entry. */
  readonly reason: string | null;
}

/** An entry's wait reason that is INDEPENDENT of capacity: hold, cycle,
 * prerequisite state/milestone, exclusive scope. Null = executable now
 * (capacity permitting). */
export function pipelineBlockingReason(
  entry: PipelineEntryRecord,
  ctx: PipelineEvaluationContext,
): string | null {
  if (entry.holdReason !== null && entry.holdReason !== '') {
    return `owner hold: ${entry.holdReason}`;
  }
  const byId = new Map(ctx.entries.map((candidate) => [candidate.id, candidate] as const));
  const cycle = prerequisiteCyclePath(entry, byId);
  if (cycle !== null) return `dependency cycle: ${cycle.join(' → ')}`;
  for (const prerequisite of entry.prerequisites) {
    const dependency = byId.get(prerequisite.id);
    if (dependency === undefined) {
      return `waiting for ${prerequisite.id} — not enqueued`;
    }
    if (dependency.state === 'cancelled') {
      return `prerequisite ${prerequisite.id} cancelled`;
    }
    if (dependency.state === 'failed') {
      return `prerequisite ${prerequisite.id} failed`;
    }
    if (!milestoneReached(prerequisite, dependency, ctx)) {
      return describeUnmetMilestone(prerequisite, dependency, ctx);
    }
  }
  const scopeHold = conflictingScopeHolder(entry, ctx.entries, ctx.jobStatusOf);
  if (scopeHold !== null) {
    return `exclusive scope "${scopeHold.scope}" held by ${scopeHold.id}`;
  }
  return null;
}

/** The full evaluation: a blocking reason wins; otherwise the entry is
 * ready (with a concrete shared-capacity wait when the budget is full or
 * an older resident admission is queued ahead). */
export function evaluatePipelineEntry(
  entry: PipelineEntryRecord,
  ctx: PipelineEvaluationContext,
): PipelineEvaluation {
  switch (entry.state) {
    case 'failed':
      return { state: 'failed', reason: entry.failureReason ?? 'admission failed' };
    case 'admitting':
      return { state: 'admitting', reason: 'dispatch claim in flight' };
    case 'admitted':
    case 'cancelled':
      // Callers exclude these before projecting; evaluating one is a
      // caller bug, not a silent default.
      throw new Error(`pipeline entry "${entry.id}" is ${entry.state} — terminal states are not projected`);
    case 'waiting':
    case 'ready':
      break;
  }
  const blocking = pipelineBlockingReason(entry, ctx);
  if (blocking !== null) return { state: 'waiting', reason: blocking };
  if (ctx.capacity.queued > 0) {
    return {
      state: 'ready',
      reason: `waiting behind ${ctx.capacity.queued} older resident admission${ctx.capacity.queued === 1 ? '' : 's'} in the shared queue`,
    };
  }
  if (ctx.capacity.available < 1) {
    return {
      state: 'ready',
      reason: `waiting for a resident worker slot (${ctx.capacity.occupied}/${ctx.capacity.capacity} busy)`,
    };
  }
  return { state: 'ready', reason: null };
}

function milestoneReached(
  prerequisite: PipelinePrerequisite,
  dependency: PipelineEntryRecord,
  ctx: PipelineEvaluationContext,
): boolean {
  switch (prerequisite.milestone) {
    case 'admitted':
      // The durable milestone release needs worker evidence: an admitted
      // job whose dispatch never started a worker (a blocked, unspawned
      // adoption) must not release dependents (review D2).
      return dependency.state === 'admitted' && dependency.jobId !== null && ctx.jobStartedOf(dependency.jobId);
    case 'delivered': {
      const status = jobStatusOf(dependency, ctx);
      return (status === 'delivered' || status === 'in-review' || status === 'merged' || status === 'done') &&
        dependency.jobId !== null && ctx.jobDeliveredOf(dependency.jobId);
    }
    case 'merged':
      return jobStatusOf(dependency, ctx) === 'merged';
    case 'done':
      return jobStatusOf(dependency, ctx) === 'done';
  }
}

function jobStatusOf(dependency: PipelineEntryRecord, ctx: PipelineEvaluationContext): JobStatus | null {
  if (dependency.jobId === null) return null;
  return ctx.jobStatusOf(dependency.jobId);
}

function describeUnmetMilestone(
  prerequisite: PipelinePrerequisite,
  dependency: PipelineEntryRecord,
  ctx: PipelineEvaluationContext,
): string {
  if (prerequisite.milestone === 'admitted') {
    return `waiting for ${prerequisite.id} to be admitted (now ${dependency.state})`;
  }
  // No job yet: the dependency's own queue state is the honest position
  // ("not started" would read as if no row existed).
  const status = jobStatusOf(dependency, ctx)?.toString() ?? null;
  return `waiting for ${prerequisite.id} to be ${prerequisite.milestone} (now ${status ?? dependency.state})`;
}

/** Scope names held by this entry right now: `admitting` until claimed
 * work lands, then until the admitted job reaches a terminal state. */
export function heldExclusiveScopes(
  entry: PipelineEntryRecord,
  jobStatusOf: (jobId: string) => JobStatus | null,
): readonly string[] {
  if (entry.exclusiveScopes.length === 0) return [];
  if (entry.state === 'admitting') return entry.exclusiveScopes;
  if (entry.state === 'admitted' && entry.jobId !== null) {
    const status = jobStatusOf(entry.jobId);
    if (status !== null && !isJobTerminal(status)) return entry.exclusiveScopes;
  }
  return [];
}

function conflictingScopeHolder(
  entry: PipelineEntryRecord,
  entries: readonly PipelineEntryRecord[],
  jobStatusOf: (jobId: string) => JobStatus | null,
): { readonly id: string; readonly scope: string } | null {
  if (entry.exclusiveScopes.length === 0) return null;
  for (const other of entries) {
    if (other.id === entry.id) continue;
    const held = heldExclusiveScopes(other, jobStatusOf);
    for (const scope of entry.exclusiveScopes) {
      if (held.includes(scope)) return { id: other.id, scope };
    }
  }
  return null;
}

/** The prerequisite path that loops back to `entry` (inclusive), or null
 * when the graph is acyclic for this entry. Only live/waiting edges walk:
 * admitted/failed/cancelled dependencies cannot form a forward cycle that
 * blocks anyone new, and their own prerequisite history is not a gate. */
function prerequisiteCyclePath(
  entry: PipelineEntryRecord,
  byId: ReadonlyMap<string, PipelineEntryRecord>,
): readonly string[] | null {
  const path: string[] = [entry.id];
  const onPath = new Set<string>([entry.id]);
  const walk = (id: string): boolean => {
    if (id === entry.id) {
      path.push(id);
      return true;
    }
    if (onPath.has(id)) return false; // an unrelated loop, not through entry
    const current = byId.get(id);
    if (current === undefined) return false;
    if (current.state === 'admitted' || current.state === 'failed' || current.state === 'cancelled') return false;
    onPath.add(id);
    path.push(id);
    for (const prerequisite of current.prerequisites) {
      if (walk(prerequisite.id)) return true;
    }
    path.pop();
    onPath.delete(id);
    return false;
  };
  for (const prerequisite of entry.prerequisites) {
    if (walk(prerequisite.id)) return path;
  }
  return null;
}

/** Whether an accepted enqueue would create a dependency cycle: walk the
 * prerequisite graph of every planned prerequisite; reaching the entry id
 * from one of its own prerequisites is a cycle. Forward references to
 * not-yet-enqueued ids terminate (missing, not cyclic). */
export function wouldCreatePipelineCycle(
  entryId: string,
  prerequisites: readonly PipelinePrerequisite[],
  existing: readonly PipelineEntryRecord[],
): boolean {
  const byId = new Map(existing.map((candidate) => [candidate.id, candidate] as const));
  const visiting = new Set<string>();
  const walk = (id: string): boolean => {
    if (id === entryId) return true;
    if (visiting.has(id)) return false;
    const current = byId.get(id);
    if (current === undefined) return false;
    visiting.add(id);
    for (const prerequisite of current.prerequisites) {
      if (walk(prerequisite.id)) return true;
    }
    return false;
  };
  for (const prerequisite of prerequisites) {
    if (walk(prerequisite.id)) return true;
  }
  return false;
}
