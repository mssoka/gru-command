import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { BusEvent, EventBus } from '../events/bus.js';
import type { Role } from '../config.js';
import type { AgentState } from '../runtime/types.js';
import {
  assertJobTransition,
  assertLensTransition,
  assertObligationTransition,
  assertRoundTransition,
  isJobStatus,
  isLensState,
  isObligationState,
  isRoundStatus,
  isRoundVerdict,
  type JobStatus,
  type LensState,
  type ObligationState,
  type RoundStatus,
  type RoundVerdict,
} from './states.js';
import {
  canonicalIsoTimestamp,
  categoryKey,
  defaultFiringRule,
  isObligationLogicalStep,
  isPhaseHandoffSource,
  isPhaseHandoffState,
  MAX_COMPLETION_HANDOFF_DECISION,
  obligationId,
  parseAuthority,
  parseCategory,
  parseClaim,
  parseClaimLog,
  parseNextAction,
  parseReceiptCorrelation,
  parseReceipts,
  parseSettlement,
  parseWakeCondition,
  phaseHandoffId,
  resolveObligation,
  type BlockerContext,
  type ClaimLogEntry,
  type ClaimLogDisposition,
  type CompletionHandoffIntent,
  type ObligationAuthority,
  type ObligationCategory,
  type ObligationClaim,
  type ObligationNextAction,
  type ObligationSettlement,
  type ObligationWakeCondition,
  type PhaseHandoffRecord,
  type PhaseHandoffSource,
  type PhaseHandoffState,
  type ReceiptCorrelation,
  type RecordedReceipt,
  type ResolvedObligation,
} from './obligations.js';
import {
  isDirectiveState,
  isDirectiveTerminal,
  LIVE_DIRECTIVE_STATES,
  type DirectiveRequestRecord,
  type DirectiveState,
} from './directives.js';

export type { JobStatus, RoundStatus, RoundVerdict, LensState } from './states.js';
export type { DirectiveRequestRecord, DirectiveState } from './directives.js';
export type {
  CompletionHandoffIntent,
  PhaseHandoffRecord,
  PhaseHandoffSource,
  PhaseHandoffState,
} from './obligations.js';

type Row = Record<string, unknown>;

/**
 * The API of record (EPICS E6 story 1): every mutation updates its row AND
 * appends an events row in ONE transaction, then publishes the event on
 * the bus. The events table is append-only history; the entity tables are
 * current state. The board rebuilds entirely from here after any restart.
 */

/** The standard 7-lens review set (briefing: 7 chips per round). */
export const DEFAULT_LENSES = [
  'blind',
  'edge',
  'acceptance',
  'security',
  'architecture',
  'codebase',
  'tests',
] as const;

export interface JobRecord {
  readonly id: string;
  readonly repo: string;
  readonly title: string;
  readonly status: JobStatus;
  readonly baseBranch: string | null;
  readonly prUrl: string | null;
  readonly note: string | null;
  /** The briefing this job executes (E8; Gru-authored, Silas-executed). */
  readonly briefing: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LensChipRecord {
  readonly lens: string;
  readonly state: LensState;
  readonly agentId: string | null;
  readonly note: string | null;
  readonly updatedAt: string;
}

export interface RoundRecord {
  readonly id: string;
  readonly jobId: string;
  readonly seq: number;
  readonly status: RoundStatus;
  readonly targetRef: string | null;
  readonly verdict: RoundVerdict | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lenses: readonly LensChipRecord[];
}

export interface AgentRecord {
  readonly id: string;
  readonly role: Role;
  readonly label: string | null;
  readonly jobId: string | null;
  readonly roundId: string | null;
  readonly state: AgentState;
  readonly lastActivity: string | null;
  readonly sessionFile: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EventRecord {
  readonly seq: number;
  readonly ts: string;
  readonly kind: string;
  readonly agentId: string | null;
  readonly jobId: string | null;
  readonly roundId: string | null;
  readonly lens: string | null;
  readonly payload: unknown;
}

/** Notification routing (SPEC ruling 13; owner routing split 2026-09-23):
 * 'fyi' → the standing feed; 'action-required' → MACHINE attention — it
 * wakes Gru (per the wake policy) and never rings the owner bell;
 * 'needs-owner' → the ONLY human-facing class (FOR YOU band + bell +
 * morning digest). */
export const NOTIFICATION_ROUTINGS = ['fyi', 'action-required', 'needs-owner'] as const;
export type NotificationRouting = (typeof NOTIFICATION_ROUTINGS)[number];

export const NOTIFICATION_SEVERITIES = ['info', 'error'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

export function isOwnerHeldNotificationKind(kind: string): boolean {
  return kind.startsWith('decisions.degraded.') ||
    kind.startsWith('supervision.provider-wall.') ||
    ['supervision.breaker', 'port-squat', 'roll-port-squat', 'worktree-sweep-paused'].includes(kind);
}

export function isNotificationRouting(value: string): value is NotificationRouting {
  return (NOTIFICATION_ROUTINGS as readonly string[]).includes(value);
}

export function isNotificationSeverity(value: string): value is NotificationSeverity {
  return (NOTIFICATION_SEVERITIES as readonly string[]).includes(value);
}

/** One durable notification row (EPICS E7 story 2 — the notification log
 * lives in the ledger; ack ids are the proven-ack contract). */
export interface NotificationRecord {
  readonly id: string;
  readonly ts: string;
  readonly kind: string;
  readonly routing: NotificationRouting;
  readonly severity: NotificationSeverity;
  readonly title: string;
  readonly detail: string | null;
  readonly agentId: string | null;
  readonly shownAt: string | null;
  readonly shownBy: string | null;
  readonly ackedAt: string | null;
  readonly ackedBy: string | null;
  /** System resolution is distinct from a human acknowledgement. */
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
}

/** Marker for not-found failures the HTTP surface maps to 404 (typed —
 * never grepped from error text). */
export class RecordNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordNotFound';
  }
}

/** A continuation was fenced out: the obligation moved to a different
 * generation (a newer distinct incident superseded the caller's view) or
 * the request does not own the current claim. Never retried blind —
 * re-derive from current durable state first. */
export class StaleContinuationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleContinuationError';
  }
}

/** The obligation is held by another live request's claim. Lease expiry
 * alone does NOT authorize replacing the holder (see ObligationClaim). */
export class ClaimHeldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaimHeldError';
  }
}

/** A directive request id was reused with a DIFFERENT canonical payload —
 * a conflict, never a silent replacement of the accepted request. */
export class DirectiveConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectiveConflictError';
  }
}

/** A directive repeat arrived while another request for the job is live.
 * The lane is single-writer: ANY different request id (identified or not)
 * fails closed with the live request named — only a replay of that same id
 * proceeds, so a fresh id never starts a second concurrent turn. */
export class AmbiguousDirectiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmbiguousDirectiveError';
  }
}

/** The phase-handoff row already exists under this request id with a
 * DIFFERENT decision (or a second completion/binding contradicts the
 * recorded one). The durable intent is part of the request identity;
 * changed intent needs a new request. */
export class PhaseHandoffConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhaseHandoffConflictError';
  }
}

/** One durable follow-through obligation (current state; full history is
 * the events table). See src/ledger/obligations.ts for the vocabulary. */
export interface ObligationRecord {
  readonly id: string;
  readonly jobId: string;
  readonly logicalStep: string;
  readonly incidentKey: string;
  /** The job's blocked-generation at this incident's creation. Only a NEW
   * distinct incident advances the job generation; duplicates never do. */
  readonly generation: number;
  readonly category: ObligationCategory;
  readonly nextAction: ObligationNextAction;
  readonly wakeCondition: ObligationWakeCondition;
  readonly authority: ObligationAuthority | null;
  readonly firingRule: string;
  /** Optional human context supplied at the blocked boundary — evidence
   * and triage material only, never execution authority. */
  readonly description: string | null;
  readonly state: ObligationState;
  readonly settlement: ObligationSettlement | null;
  readonly dueAt: string | null;
  readonly receiptKind: string | null;
  readonly deadlineAt: string | null;
  readonly recordedReceipts: readonly RecordedReceipt[];
  readonly observations: number;
  /** Bumped ONLY when a duplicate observation changed the plan (next
   * action / authority / wake condition): the revision that fences claims
   * derived from the older plan (ruling C). */
  readonly planRevision: number;
  readonly firstOriginSeq: number;
  readonly lastOriginSeq: number;
  readonly supersededBy: string | null;
  readonly claim: ObligationClaim | null;
  /** Full identity of every prior claim and how it left — never a bare
   * counter (ruling D). */
  readonly claimLog: readonly ClaimLogEntry[];
  readonly receiptCorrelation: ReceiptCorrelation | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ------------------------------------------------------------------
// Worktree registry (E8; SPEC ruling 18b — the ledger is the
// authoritative map job → worktree → branch; sweeps match THESE
// paths only, never id-proximity or labels).
// ------------------------------------------------------------------

export const WORKTREE_KINDS = ['job', 'review'] as const;
export type WorktreeKind = (typeof WORKTREE_KINDS)[number];

export const WORKTREE_STATUSES = ['active', 'paused', 'swept'] as const;
export type WorktreeStatus = (typeof WORKTREE_STATUSES)[number];

export function isWorktreeKind(value: string): value is WorktreeKind {
  return (WORKTREE_KINDS as readonly string[]).includes(value);
}

export function isWorktreeStatus(value: string): value is WorktreeStatus {
  return (WORKTREE_STATUSES as readonly string[]).includes(value);
}

/** How a lane's base sha was resolved (owner incident 2026-09-23):
 * 'origin' = the freshly-fetched origin default-branch tip;
 * 'local-head-fallback' = the declared degraded path (fetch failed — the
 * lane may be stale and that fact is recorded, never silent). */
export const WORKTREE_BASE_SOURCES = ['origin', 'local-head-fallback'] as const;
export type WorktreeBaseSource = (typeof WORKTREE_BASE_SOURCES)[number];

export function isWorktreeBaseSource(value: string): value is WorktreeBaseSource {
  return (WORKTREE_BASE_SOURCES as readonly string[]).includes(value);
}

export interface WorktreeRecord {
  /** The owning job id (kind 'job') or round id (kind 'review'). */
  readonly id: string;
  readonly kind: WorktreeKind;
  readonly repoPath: string;
  readonly repoName: string;
  readonly path: string;
  readonly branch: string | null;
  readonly sha: string;
  /** How `sha` was resolved — 'origin' (fetched origin tip) or
   * 'local-head-fallback' (degraded path; the lane may be stale).
   * NULL for rows written before the provenance migration and for
   * review rows pinned to an exact commit (their sha IS their
   * provenance). */
  readonly baseSource: WorktreeBaseSource | null;
  readonly jobId: string | null;
  readonly roundId: string | null;
  readonly status: WorktreeStatus;
  readonly note: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ------------------------------------------------------------------
// Pending re-briefs (Silas follow-through restart safety): the durable
// request marker written BEFORE a re-brief worker is spawned. Each marker
// guards ONE ledger event; it clears only when that event lands. A boot
// reconciliation consumes any marker whose event never landed, so a
// service restart mid-turn can never silence the lane.
// ------------------------------------------------------------------

export const PENDING_REBRIEF_KINDS = ['silas.rebrief', 'job.delivered'] as const;
export type PendingRebriefKind = (typeof PENDING_REBRIEF_KINDS)[number];

export function isPendingRebriefKind(value: string): value is PendingRebriefKind {
  return (PENDING_REBRIEF_KINDS as readonly string[]).includes(value);
}

export interface PendingRebriefRecord {
  readonly id: string;
  readonly jobId: string;
  /** The ledger event this marker guards. */
  readonly kind: PendingRebriefKind;
  /** Note handed to the re-brief worker (what stalled, what to do differently). */
  readonly note: string | null;
  /** The job briefing at request time — the re-brief prompt's contract half. */
  readonly briefing: string | null;
  /** sha256 of the exact request payload (audit identity). */
  readonly payloadHash: string;
  /** events.seq high-water at request time; the guarded event must post-date it. */
  readonly baselineSeq: number;
  /** The spawned re-brief worker, once known (resume hint after a crash). */
  readonly agentId: string | null;
  readonly sessionFile: string | null;
  /** The phase-handoff row this marker pair belongs to, when the request
   * carried an explicit completion intent (host-owned identity; the
   * delivery event must carry it). Null = ordinary re-brief. */
  readonly phaseId: string | null;
  readonly requestedAt: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function str(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`ledger row field is not a string: ${String(value)}`);
  return value;
}

function nstr(value: unknown): string | null {
  return value === null || value === undefined ? null : str(value);
}

export function requireSafeRecordId(value: string, name: string, maxLength = 128): void {
  if (
    value.length > maxLength ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ||
    value === '.' ||
    value === '..'
  ) {
    throw new Error(`${name} must be a safe ${maxLength}-character record identifier`);
  }
}

export class LedgerApi {
  private readonly db: DatabaseSync;
  private readonly bus: EventBus | null;

  constructor(db: DatabaseSync, opts: { bus?: EventBus } = {}) {
    this.db = db;
    this.bus = opts.bus ?? null;
  }

  // ------------------------------------------------------------------
  // Event plumbing — one transaction, row + event, then bus publish.
  // ------------------------------------------------------------------

  private inTransaction = false;
  /** Events accumulated inside the open transaction, published only
   * after a successful COMMIT — subscribers never see rolled-back work. */
  private pendingEvents: BusEvent[] = [];

  private transaction<T>(write: () => T): T {
    if (this.inTransaction) return write(); // re-entrant: the outer txn owns commit/rollback + publish
    this.inTransaction = true;
    this.db.exec('BEGIN');
    let result: T;
    try {
      result = write();
      this.db.exec('COMMIT');
    } catch (error) {
      this.pendingEvents.length = 0; // rolled back — phantom events are never published
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.inTransaction = false;
    }
    const events = this.pendingEvents.splice(0);
    for (const event of events) this.bus?.publish(event);
    return result;
  }

  private appendEvent(fields: {
    kind: string;
    agentId?: string | null;
    jobId?: string | null;
    roundId?: string | null;
    lens?: string | null;
    payload?: unknown;
  }): BusEvent {
    const ts = nowIso();
    const info = this.db
      .prepare(
        `INSERT INTO events (ts, kind, agent_id, job_id, round_id, lens, payload)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ts,
        fields.kind,
        fields.agentId ?? null,
        fields.jobId ?? null,
        fields.roundId ?? null,
        fields.lens ?? null,
        JSON.stringify(fields.payload ?? {}),
      );
    const event: BusEvent = {
      seq: Number(info.lastInsertRowid),
      ts,
      kind: fields.kind,
      agentId: fields.agentId ?? null,
      jobId: fields.jobId ?? null,
      roundId: fields.roundId ?? null,
      lens: fields.lens ?? null,
      payload: fields.payload ?? {},
    };
    this.pendingEvents.push(event);
    return event;
  }

  /** All (round, lens) chips bound to an agent — indexed, no table scans. */
  listLensBindings(agentId: string): { roundId: string; lens: string }[] {
    return (
      this.db
        .prepare('SELECT round_id, lens FROM lens_states WHERE agent_id = ? ORDER BY rowid')
        .all(agentId) as Row[]
    ).map((row) => ({ roundId: str(row.round_id), lens: str(row.lens) }));
  }

  listEvents(opts: { limit?: number } = {}): readonly EventRecord[] {
    const limit = opts.limit ?? 100;
    return (
      this.db
        .prepare('SELECT * FROM events ORDER BY seq DESC LIMIT ?')
        .all(limit) as Row[]
    ).map((row) => this.eventFromRow(row));
  }

  /** Events strictly after `seq` (the awareness digest window), bounded and
   * ordered — oldest-first by default, newest-first with `order: 'desc'`.
   * `kinds` narrows to an explicit set (empty/omitted = every kind). */
  listEventsAfter(
    seq: number,
    opts: { limit?: number; order?: 'asc' | 'desc'; kinds?: readonly string[] } = {},
  ): readonly EventRecord[] {
    const limit = opts.limit ?? 100;
    const order = opts.order === 'desc' ? 'DESC' : 'ASC';
    const kinds = opts.kinds;
    const where =
      kinds === undefined || kinds.length === 0
        ? 'seq > ?'
        : `seq > ? AND kind IN (${kinds.map(() => '?').join(', ')})`;
    const params: (number | string)[] = [seq, ...(kinds ?? [])];
    return (
      this.db
        .prepare(`SELECT * FROM events WHERE ${where} ORDER BY seq ${order} LIMIT ?`)
        .all(...params, limit) as Row[]
    ).map((row) => this.eventFromRow(row));
  }

  /** Highest events.seq, or 0 when the table is empty. The cursor the Gru
   * awareness digest advances past one delivered turn at a time. */
  latestEventSeq(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events').get() as Row;
    return Number(row.seq);
  }

  /** One event by seq, or null — the receipt/settlement evidence check
   * (ruling A: no fabricated sequence may settle debt). */
  getEvent(seq: number): EventRecord | null {
    if (!Number.isSafeInteger(seq) || seq < 0) return null;
    const row = this.db.prepare('SELECT * FROM events WHERE seq = ?').get(seq) as Row | undefined;
    return row === undefined ? null : this.eventFromRow(row);
  }

  /** How many durable events of one kind exist (the board's wake tracker). */
  countEvents(kind: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM events WHERE kind = ?').get(kind) as Row;
    return Number(row.n);
  }

  /** Newest durable event of one kind (the board's wake tracker stamp). */
  latestEventOfKind(kind: string): EventRecord | null {
    const row = this.db
      .prepare('SELECT * FROM events WHERE kind = ? ORDER BY seq DESC LIMIT 1')
      .get(kind) as Row | undefined;
    return row === undefined ? null : this.eventFromRow(row);
  }

  /** Latest durable event for one review round/kind (restart reconciliation). */
  latestRoundEvent(roundId: string, kind: string): EventRecord | null {
    const row = this.db
      .prepare('SELECT * FROM events WHERE round_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1')
      .get(roundId, kind) as Row | undefined;
    return row === undefined ? null : this.eventFromRow(row);
  }

  /** One job's events, newest first (ops digest scans; bounded). */
  listJobEvents(jobId: string, opts: { limit?: number } = {}): readonly EventRecord[] {
    const limit = opts.limit ?? 200;
    return (
      this.db
        .prepare('SELECT * FROM events WHERE job_id = ? ORDER BY seq DESC LIMIT ?')
        .all(jobId, limit) as Row[]
    ).map((row) => this.eventFromRow(row));
  }

  /** Latest durable event for one job/kind (ops follow-through checks). */
  latestJobEvent(jobId: string, kind: string): EventRecord | null {
    const row = this.db
      .prepare('SELECT * FROM events WHERE job_id = ? AND kind = ? ORDER BY seq DESC LIMIT 1')
      .get(jobId, kind) as Row | undefined;
    return row === undefined ? null : this.eventFromRow(row);
  }

  /** Newest event among an explicit kind set (board health cards: the
   * last Silas wake). An empty kind set is a caller bug — throw loudly. */
  latestEventOfKinds(kinds: readonly string[]): EventRecord | null {
    if (kinds.length === 0) throw new Error('latestEventOfKinds requires at least one kind');
    const placeholders = kinds.map(() => '?').join(', ');
    const row = this.db
      .prepare(`SELECT * FROM events WHERE kind IN (${placeholders}) ORDER BY seq DESC LIMIT 1`)
      .get(...kinds) as Row | undefined;
    return row === undefined ? null : this.eventFromRow(row);
  }

  /** Count of events among an explicit kind set at/after an ISO timestamp
   * (board health cards: today's Silas reconciliations). ISO stamps share
   * one shape, so lexicographic `>=` is the same boundary the ledger
   * writes. An empty kind set is a caller bug — throw loudly. */
  countEventsSince(kinds: readonly string[], since: string): number {
    if (kinds.length === 0) throw new Error('countEventsSince requires at least one kind');
    const placeholders = kinds.map(() => '?').join(', ');
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM events WHERE ts >= ? AND kind IN (${placeholders})`)
      .get(since, ...kinds) as Row;
    return Number(row.count);
  }

  private eventFromRow(row: Row): EventRecord {
    return {
      seq: Number(row.seq),
      ts: str(row.ts),
      kind: str(row.kind),
      agentId: nstr(row.agent_id),
      jobId: nstr(row.job_id),
      roundId: nstr(row.round_id),
      lens: nstr(row.lens),
      payload: JSON.parse(str(row.payload)) as unknown,
    };
  }

  // ------------------------------------------------------------------
  // Jobs
  // ------------------------------------------------------------------

  addJob(input: {
    id: string;
    repo: string;
    title: string;
    baseBranch?: string | null;
    briefing?: string | null;
  }): JobRecord {
    if (input.id === '' || input.repo === '' || input.title === '') {
      throw new Error('job id, repo, and title must be non-empty');
    }
    requireSafeRecordId(input.id, 'job id');
    return this.transaction(() => {
      if (this.getJob(input.id) !== null) {
        throw new Error(`job "${input.id}" already exists`);
      }
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO jobs (id, repo, title, status, base_branch, pr_url, note, briefing, created_at, updated_at)
           VALUES (?, ?, ?, 'dispatched', ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(input.id, input.repo, input.title, input.baseBranch ?? null, input.briefing ?? null, ts, ts);
      this.appendEvent({ kind: 'job.created', jobId: input.id, payload: { repo: input.repo, title: input.title } });
      return this.getJob(input.id) as JobRecord;
    });
  }

  getJob(id: string): JobRecord | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : this.jobFromRow(row);
  }

  listJobs(repo?: string): readonly JobRecord[] {
    const rows =
      repo === undefined
        ? (this.db.prepare('SELECT * FROM jobs ORDER BY updated_at DESC, id').all() as Row[])
        : (this.db.prepare('SELECT * FROM jobs WHERE repo = ? ORDER BY updated_at DESC, id').all(repo) as Row[]);
    return rows.map((row) => this.jobFromRow(row));
  }

  /** Blocked jobs with NO obligation history at all — the bounded boot
   * adoption candidate set. Already-adopted lanes are excluded BY the
   * query, so a fixed window can never keep re-scanning the adopted
   * prefix while the tail starves (N3). */
  listBlockedJobsWithoutObligations(limit: number): readonly JobRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error(`listBlockedJobsWithoutObligations requires a positive integer limit, got ${String(limit)}`);
    }
    const rows = this.db
      .prepare(
        `SELECT j.* FROM jobs j
          WHERE j.status = 'blocked'
            AND NOT EXISTS (SELECT 1 FROM job_obligations o WHERE o.job_id = j.id)
          ORDER BY j.updated_at DESC, j.id
          LIMIT ?`,
      )
      .all(limit) as Row[];
    return rows.map((row) => this.jobFromRow(row));
  }

  setJobStatus(id: string, status: string, context?: BlockerContext): JobRecord {
    if (!isJobStatus(status)) throw new Error(`unknown job status "${status}"`);
    if (context !== undefined && status !== 'blocked') {
      throw new Error('a blocker context may only accompany a blocked transition');
    }
    return this.transaction(() => {
      const current = this.getJob(id);
      if (current === null) throw new RecordNotFound(`job "${id}" not found`);
      if (current.status !== status) {
        assertJobTransition(current.status, status);
        this.db
          .prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?')
          .run(status, nowIso(), id);
        const event = this.appendEvent({ kind: 'job.status', jobId: id, payload: { from: current.status, to: status } });
        // Status/obligation consistency lives AT this transactional boundary
        // (chief ruling A): every writer — dispatch, HTTP API, future hooks —
        // rides it. A blocked transition synthesizes/refreshes obligations
        // from the typed context, or from a safe unknown-triage default when
        // no context is given (a legitimate block is never rejected for a
        // missing description). Parking suspends the applicable obligations;
        // terminal states close them (history preserved, never erased).
        if (status === 'blocked') {
          this.applyBlockedObservation(
            id,
            context ?? { logicalStep: 'operation', category: { kind: 'unknown' }, observedAtSeq: event.seq },
          );
        } else if (status === 'parked') {
          this.suspendApplicableObligations(id, 'job parked — obligation suspended by explicit durable state');
        } else if (status === 'done' || status === 'merged') {
          this.closeApplicableObligations(id, status);
        }
      } else if (status === 'blocked' && context !== undefined) {
        // A repeated blocked observation on an already-blocked job is still
        // an observation: the same transactional boundary must record it.
        const event = this.appendEvent({
          kind: 'job.status',
          jobId: id,
          payload: { from: current.status, to: status, note: 're-observed blocked' },
        });
        this.applyBlockedObservation(id, context ?? { logicalStep: 'operation', category: { kind: 'unknown' }, observedAtSeq: event.seq });
      }
      return this.getJob(id) as JobRecord;
    });
  }

  noteJob(id: string, note: string): JobRecord {
    return this.transaction(() => {
      const current = this.getJob(id);
      if (current === null) throw new RecordNotFound(`job "${id}" not found`);
      this.db.prepare('UPDATE jobs SET note = ?, updated_at = ? WHERE id = ?').run(note, nowIso(), id);
      this.appendEvent({ kind: 'job.note', jobId: id, payload: { note } });
      return this.getJob(id) as JobRecord;
    });
  }

  setJobPr(id: string, url: string): JobRecord {
    return this.transaction(() => {
      const current = this.getJob(id);
      if (current === null) throw new RecordNotFound(`job "${id}" not found`);
      this.db.prepare('UPDATE jobs SET pr_url = ?, updated_at = ? WHERE id = ?').run(url, nowIso(), id);
      this.appendEvent({ kind: 'job.pr', jobId: id, payload: { url } });
      return this.getJob(id) as JobRecord;
    });
  }

  setJobBriefing(id: string, briefing: string): JobRecord {
    if (briefing.trim() === '') throw new Error('job briefing must be non-empty');
    return this.transaction(() => {
      const current = this.getJob(id);
      if (current === null) throw new RecordNotFound(`job "${id}" not found`);
      this.db.prepare('UPDATE jobs SET briefing = ?, updated_at = ? WHERE id = ?').run(briefing, nowIso(), id);
      this.appendEvent({ kind: 'job.briefing', jobId: id, payload: { bytes: briefing.length } });
      return this.getJob(id) as JobRecord;
    });
  }

  // ------------------------------------------------------------------
  // Worktree registry (E8; SPEC ruling 18b)
  // ------------------------------------------------------------------

  registerWorktree(input: {
    id: string;
    kind: string;
    repoPath: string;
    repoName: string;
    path: string;
    branch?: string | null;
    sha: string;
    /** Base provenance (the manager always declares it for lanes it
     * creates; omitted = unknown, e.g. legacy callers). */
    baseSource?: WorktreeBaseSource | null;
    jobId?: string | null;
    roundId?: string | null;
  }): WorktreeRecord {
    if (input.id === '' || input.path === '' || input.repoPath === '' || input.sha === '') {
      throw new Error('worktree id, path, repo path, and sha must be non-empty');
    }
    if (
      input.baseSource !== undefined &&
      input.baseSource !== null &&
      !isWorktreeBaseSource(input.baseSource)
    ) {
      throw new Error(
        `unknown worktree base source "${input.baseSource}" (valid: ${WORKTREE_BASE_SOURCES.join(', ')})`,
      );
    }
    if (!isWorktreeKind(input.kind)) {
      throw new Error(`unknown worktree kind "${input.kind}" (valid: ${WORKTREE_KINDS.join(', ')})`);
    }
    if (input.kind === 'job' && (input.jobId === null || input.jobId === undefined)) {
      throw new Error(`worktree "${input.id}" of kind 'job' requires its owning job id`);
    }
    if (input.kind === 'review' && (input.roundId === null || input.roundId === undefined)) {
      throw new Error(`worktree "${input.id}" of kind 'review' requires its owning round id`);
    }
    if (input.jobId !== null && input.jobId !== undefined && this.getJob(input.jobId) === null) {
      throw new RecordNotFound(`job "${input.jobId}" not found — a worktree lane belongs to a real job`);
    }
    if (input.roundId !== null && input.roundId !== undefined && this.getRound(input.roundId) === null) {
      throw new RecordNotFound(`round "${input.roundId}" not found — a review worktree belongs to a real round`);
    }
    return this.transaction(() => {
      if (this.getWorktree(input.id) !== null) {
        throw new Error(`worktree "${input.id}" already exists`);
      }
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO worktrees (id, kind, repo_path, repo_name, path, branch, sha, base_source, job_id, round_id, status, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
        )
        .run(
          input.id,
          input.kind,
          input.repoPath,
          input.repoName,
          input.path,
          input.branch ?? null,
          input.sha,
          input.baseSource ?? null,
          input.jobId ?? null,
          input.roundId ?? null,
          ts,
          ts,
        );
      this.appendEvent({
        kind: 'worktree.created',
        jobId: input.jobId ?? null,
        roundId: input.roundId ?? null,
        payload: {
          id: input.id,
          kind: input.kind,
          path: input.path,
          branch: input.branch ?? null,
          sha: input.sha,
          baseSource: input.baseSource ?? null,
        },
      });
      return this.getWorktree(input.id) as WorktreeRecord;
    });
  }

  getWorktree(id: string): WorktreeRecord | null {
    const row = this.db.prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : this.worktreeFromRow(row);
  }

  listWorktrees(opts: { status?: string; jobId?: string } = {}): readonly WorktreeRecord[] {
    let rows: Row[];
    if (opts.status !== undefined) {
      if (!isWorktreeStatus(opts.status)) {
        throw new Error(`unknown worktree status "${opts.status}"`);
      }
      rows = this.db.prepare('SELECT * FROM worktrees WHERE status = ? ORDER BY created_at, id').all(opts.status) as Row[];
    } else {
      rows = this.db.prepare('SELECT * FROM worktrees ORDER BY created_at, id').all() as Row[];
    }
    const all = rows.map((row) => this.worktreeFromRow(row));
    return opts.jobId === undefined ? all : all.filter((row) => row.jobId === opts.jobId);
  }

  setWorktreeStatus(id: string, status: string, note?: string): WorktreeRecord {
    if (!isWorktreeStatus(status)) throw new Error(`unknown worktree status "${status}"`);
    return this.transaction(() => {
      const current = this.getWorktree(id);
      if (current === null) throw new RecordNotFound(`worktree "${id}" not found`);
      this.db
        .prepare('UPDATE worktrees SET status = ?, note = COALESCE(?, note), updated_at = ? WHERE id = ?')
        .run(status, note ?? null, nowIso(), id);
      this.appendEvent({
        kind: 'worktree.status',
        jobId: current.jobId,
        roundId: current.roundId,
        payload: { id, from: current.status, to: status, ...(note !== undefined ? { note } : {}) },
      });
      return this.getWorktree(id) as WorktreeRecord;
    });
  }

  noteWorktree(id: string, note: string): WorktreeRecord {
    return this.transaction(() => {
      const current = this.getWorktree(id);
      if (current === null) throw new RecordNotFound(`worktree "${id}" not found`);
      this.db.prepare('UPDATE worktrees SET note = ?, updated_at = ? WHERE id = ?').run(note, nowIso(), id);
      this.appendEvent({
        kind: 'worktree.note',
        jobId: current.jobId,
        roundId: current.roundId,
        payload: { id, note },
      });
      return this.getWorktree(id) as WorktreeRecord;
    });
  }

  /** Observed-process records (SPEC ruling 18b's spawned-processes arm):
   * every pid a pause or confirmed kill is grounded on lands here — the
   * registry is the authoritative map job → worktree → branch →
   * processes, so the ask can always name what was live. */
  recordWorktreeProcesses(input: {
    worktreeId: string;
    processes: readonly { pid: number; command: string; evidence: string }[];
    state: 'live' | 'killed';
  }): void {
    if (input.processes.length === 0) return;
    if (this.getWorktree(input.worktreeId) === null) {
      throw new RecordNotFound(`worktree "${input.worktreeId}" not found`);
    }
    this.transaction(() => {
      const ts = nowIso();
      const upsert = this.db.prepare(
        `INSERT INTO worktree_processes (worktree_id, pid, command, evidence, state, first_seen, last_seen)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (worktree_id, pid) DO UPDATE SET
           state = excluded.state,
           command = excluded.command,
           last_seen = excluded.last_seen`,
      );
      for (const proc of input.processes) {
        upsert.run(input.worktreeId, proc.pid, proc.command, proc.evidence, input.state, ts, ts);
      }
      this.appendEvent({
        kind: 'worktree.processes',
        payload: {
          id: input.worktreeId,
          state: input.state,
          pids: input.processes.map((proc) => proc.pid),
        },
      });
    });
  }

  listWorktreeProcesses(worktreeId: string): readonly {
    readonly pid: number;
    readonly command: string;
    readonly evidence: string;
    readonly state: string;
    readonly lastSeen: string;
  }[] {
    return (
      this.db
        .prepare('SELECT pid, command, evidence, state, last_seen FROM worktree_processes WHERE worktree_id = ? ORDER BY first_seen, pid')
        .all(worktreeId) as Row[]
    ).map((row) => ({
      pid: Number(row.pid),
      command: str(row.command),
      evidence: str(row.evidence),
      state: str(row.state),
      lastSeen: str(row.last_seen),
    }));
  }

  // ------------------------------------------------------------------
  // Rounds (review waves) + lens chips
  // ------------------------------------------------------------------

  addRound(input: {
    jobId: string;
    seq?: number;
    lenses?: readonly string[];
    targetRef?: string | null;
  }): RoundRecord {
    const lenses = input.lenses === undefined || input.lenses.length === 0 ? [...DEFAULT_LENSES] : [...input.lenses];
    for (const lens of lenses) {
      if (lens === '') throw new Error('lens names must be non-empty');
    }
    if (new Set(lenses).size !== lenses.length) {
      throw new Error('lens names must be unique within a round');
    }
    return this.transaction(() => {
      const job = this.getJob(input.jobId);
      if (job === null) throw new RecordNotFound(`job "${input.jobId}" not found`);
      let seq = input.seq;
      if (seq === undefined) {
        const row = this.db
          .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM rounds WHERE job_id = ?')
          .get(input.jobId) as Row;
        seq = Number(row.next);
      }
      const id = `${input.jobId}-r${seq}`;
      if (this.getRound(id) !== null) throw new Error(`round "${id}" already exists`);
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO rounds (id, job_id, seq, status, target_ref, verdict, lenses, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, NULL, ?, ?, ?)`,
        )
        .run(id, input.jobId, seq, input.targetRef ?? null, JSON.stringify(lenses), ts, ts);
      const chip = this.db.prepare(
        'INSERT INTO lens_states (round_id, lens, state, agent_id, note, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)',
      );
      for (const lens of lenses) chip.run(id, lens, 'pending', ts);
      this.appendEvent({ kind: 'round.created', jobId: input.jobId, roundId: id, payload: { seq, lenses } });
      return this.getRound(id) as RoundRecord;
    });
  }

  getRound(id: string): RoundRecord | null {
    const row = this.db.prepare('SELECT * FROM rounds WHERE id = ?').get(id) as Row | undefined;
    if (row === undefined) return null;
    const chips = this.db
      .prepare('SELECT * FROM lens_states WHERE round_id = ? ORDER BY rowid')
      .all(id) as Row[];
    return {
      id: str(row.id),
      jobId: str(row.job_id),
      seq: Number(row.seq),
      status: str(row.status) as RoundStatus,
      targetRef: nstr(row.target_ref),
      verdict: nstr(row.verdict) as RoundVerdict | null,
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
      lenses: chips.map((chip) => ({
        lens: str(chip.lens),
        state: str(chip.state) as LensState,
        agentId: nstr(chip.agent_id),
        note: nstr(chip.note),
        updatedAt: str(chip.updated_at),
      })),
    };
  }

  listRounds(jobId: string): readonly RoundRecord[] {
    const rows = this.db
      .prepare('SELECT id FROM rounds WHERE job_id = ? ORDER BY seq')
      .all(jobId) as Row[];
    return rows.map((row) => this.getRound(str(row.id)) as RoundRecord);
  }

  /**
   * Every round still in flight (pending/live), across all jobs — the roll
   * drain probe. Rounds are terminal at verdict-posted/aborted; anything
   * non-terminal is work the service should finish or abandon before a swap.
   */
  listActiveRounds(): readonly RoundRecord[] {
    const rows = this.db
      .prepare("SELECT id FROM rounds WHERE status IN ('pending', 'live') ORDER BY created_at, id")
      .all() as Row[];
    return rows.map((row) => this.getRound(str(row.id)) as RoundRecord);
  }

  setRoundStatus(id: string, status: string): RoundRecord {
    if (!isRoundStatus(status)) throw new Error(`unknown round status "${status}"`);
    return this.transaction(() => {
      const round = this.getRound(id);
      if (round === null) throw new RecordNotFound(`round "${id}" not found`);
      if (round.status !== status) {
        assertRoundTransition(round.status, status);
        this.db.prepare('UPDATE rounds SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
        this.appendEvent({
          kind: 'round.status',
          jobId: round.jobId,
          roundId: id,
          payload: { from: round.status, to: status },
        });
      }
      return this.getRound(id) as RoundRecord;
    });
  }

  setRoundVerdict(id: string, verdict: string): RoundRecord {
    if (!isRoundVerdict(verdict)) throw new Error(`unknown round verdict "${verdict}"`);
    return this.transaction(() => {
      const round = this.getRound(id);
      if (round === null) throw new RecordNotFound(`round "${id}" not found`);
      this.db.prepare('UPDATE rounds SET verdict = ?, updated_at = ? WHERE id = ?').run(verdict, nowIso(), id);
      this.appendEvent({
        kind: 'round.verdict',
        jobId: round.jobId,
        roundId: id,
        payload: { verdict },
      });
      // A posted verdict IS the verdict-posted state — keep the machine
      // coherent (abort after verdict stays legal only from live…
      // verdict-posted is terminal, so this is a one-way door).
      if (round.status !== 'verdict-posted' && round.status !== 'aborted') {
        this.setRoundStatus(id, 'verdict-posted');
      }
      return this.getRound(id) as RoundRecord;
    });
  }

  setRoundTarget(id: string, ref: string): RoundRecord {
    return this.transaction(() => {
      const round = this.getRound(id);
      if (round === null) throw new RecordNotFound(`round "${id}" not found`);
      this.db.prepare('UPDATE rounds SET target_ref = ?, updated_at = ? WHERE id = ?').run(ref, nowIso(), id);
      this.appendEvent({ kind: 'round.target', jobId: round.jobId, roundId: id, payload: { ref } });
      return this.getRound(id) as RoundRecord;
    });
  }

  /** Bind a lens chip to its live agent session (chip state derives from it). */
  bindLens(roundId: string, lens: string, agentId: string): RoundRecord {
    return this.transaction(() => {
      const round = this.getRound(roundId);
      if (round === null) throw new RecordNotFound(`round "${roundId}" not found`);
      const chip = round.lenses.find((entry) => entry.lens === lens);
      if (chip === undefined) throw new RecordNotFound(`round "${roundId}" has no lens "${lens}"`);
      this.db
        .prepare('UPDATE lens_states SET agent_id = ?, updated_at = ? WHERE round_id = ? AND lens = ?')
        .run(agentId, nowIso(), roundId, lens);
      // Backfill the agent's round/job wiring: runtime-tap registration
      // (spawn envelopes) carries no round context — binding is the ONE
      // call that connects chip to agent to round.
      this.db
        .prepare(
          'UPDATE agents SET round_id = ?, job_id = COALESCE(job_id, ?), updated_at = ? WHERE id = ? AND round_id IS NULL',
        )
        .run(roundId, round.jobId, nowIso(), agentId);
      this.appendEvent({
        kind: 'lens.bound',
        jobId: round.jobId,
        roundId,
        lens,
        agentId,
        payload: { agentId },
      });
      return this.getRound(roundId) as RoundRecord;
    });
  }

  /** Explicit lens outcome (done/error + note) — set by the wave runner or derived rules. */
  setLensOutcome(roundId: string, lens: string, state: string, note?: string): RoundRecord {
    if (!isLensState(state)) throw new Error(`unknown lens state "${state}"`);
    return this.transaction(() => {
      const round = this.getRound(roundId);
      if (round === null) throw new RecordNotFound(`round "${roundId}" not found`);
      const chip = round.lenses.find((entry) => entry.lens === lens);
      if (chip === undefined) throw new RecordNotFound(`round "${roundId}" has no lens "${lens}"`);
      if (chip.state !== state) {
        assertLensTransition(chip.state, state);
        this.db
          .prepare('UPDATE lens_states SET state = ?, note = ?, updated_at = ? WHERE round_id = ? AND lens = ?')
          .run(state, note ?? chip.note, nowIso(), roundId, lens);
        this.appendEvent({
          kind: 'lens.status',
          jobId: round.jobId,
          roundId,
          lens,
          agentId: chip.agentId,
          payload: { from: chip.state, to: state, ...(note !== undefined ? { note } : {}) },
        });
      }
      return this.getRound(roundId) as RoundRecord;
    });
  }

  /** Lens-chip derivation helper: LIVE on turn activity (idempotent). */
  markLensLive(roundId: string, lens: string): RoundRecord {
    const round = this.getRound(roundId);
    if (round === null) throw new RecordNotFound(`round "${roundId}" not found`);
    const chip = round.lenses.find((entry) => entry.lens === lens);
    if (chip === undefined || chip.state === 'live' || chip.state === 'done' || chip.state === 'error') {
      return round; // already live or resolved — idempotent, no event
    }
    return this.setLensOutcome(roundId, lens, 'live');
  }

  // ------------------------------------------------------------------
  // Agents
  // ------------------------------------------------------------------

  registerAgent(input: {
    id: string;
    role: Role;
    label?: string | null;
    jobId?: string | null;
    roundId?: string | null;
    sessionFile?: string | null;
  }): AgentRecord {
    if (input.id === '') throw new Error('agent id must be non-empty');
    return this.transaction(() => {
      const existing = this.getAgent(input.id);
      const ts = nowIso();
      if (existing === null) {
        this.db
          .prepare(
            `INSERT INTO agents (id, role, label, job_id, round_id, state, last_activity, session_file, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'spawning', NULL, ?, ?, ?)`,
          )
          .run(input.id, input.role, input.label ?? null, input.jobId ?? null, input.roundId ?? null, input.sessionFile ?? null, ts, ts);
        this.appendEvent({
          kind: 'agent.spawned',
          agentId: input.id,
          jobId: input.jobId ?? null,
          roundId: input.roundId ?? null,
          payload: { role: input.role, label: input.label ?? null },
        });
      } else {
        this.db
          .prepare(
            `UPDATE agents SET role = ?, label = COALESCE(?, label), job_id = COALESCE(?, job_id),
             round_id = COALESCE(?, round_id), session_file = COALESCE(?, session_file), updated_at = ? WHERE id = ?`,
          )
          .run(
            input.role,
            input.label ?? null,
            input.jobId ?? null,
            input.roundId ?? null,
            input.sessionFile ?? null,
            ts,
            input.id,
          );
      }
      return this.getAgent(input.id) as AgentRecord;
    });
  }

  getAgent(id: string): AgentRecord | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : this.agentFromRow(row);
  }

  listAgents(): readonly AgentRecord[] {
    const rows = this.db.prepare('SELECT * FROM agents ORDER BY updated_at DESC, id').all() as Row[];
    return rows.map((row) => this.agentFromRow(row));
  }

  setAgentState(id: string, state: AgentState, error?: string): AgentRecord {
    return this.transaction(() => {
      const agent = this.getAgent(id);
      if (agent === null) throw new RecordNotFound(`agent "${id}" not found`);
      const ts = nowIso();
      this.db
        .prepare('UPDATE agents SET state = ?, last_activity = ?, updated_at = ? WHERE id = ?')
        .run(state, ts, ts, id);
      if (agent.state !== state) {
        this.appendEvent({
          kind: 'agent.state',
          agentId: id,
          jobId: agent.jobId,
          roundId: agent.roundId,
          payload: { from: agent.state, to: state, ...(error !== undefined ? { error } : {}) },
        });
      }
      return this.getAgent(id) as AgentRecord;
    });
  }

  /** Attach a live agent to its job lane (E8 dispatch wiring; the spawn
   * envelope carries no job context — this is the one call that binds).
   * (Superseded in the dispatch path by registerAgent-with-jobId, which
   * makes the binding independent of observer ordering; retained as the
   * API-of-record surface for external surfaces.) */
  attachAgentToJob(agentId: string, jobId: string): AgentRecord {
    return this.transaction(() => {
      const agent = this.getAgent(agentId);
      if (agent === null) throw new RecordNotFound(`agent "${agentId}" not found`);
      if (this.getJob(jobId) === null) throw new RecordNotFound(`job "${jobId}" not found`);
      this.db
        .prepare('UPDATE agents SET job_id = ?, updated_at = ? WHERE id = ?')
        .run(jobId, nowIso(), agentId);
      this.appendEvent({ kind: 'agent.attached', agentId, jobId, payload: { jobId } });
      return this.getAgent(agentId) as AgentRecord;
    });
  }

  /** Attach a live agent to a review round (E8 wave wiring). */
  attachAgentToRound(agentId: string, roundId: string): AgentRecord {
    return this.transaction(() => {
      const agent = this.getAgent(agentId);
      if (agent === null) throw new RecordNotFound(`agent "${agentId}" not found`);
      const round = this.getRound(roundId);
      if (round === null) throw new RecordNotFound(`round "${roundId}" not found`);
      this.db
        .prepare('UPDATE agents SET round_id = ?, job_id = COALESCE(job_id, ?), updated_at = ? WHERE id = ?')
        .run(roundId, round.jobId, nowIso(), agentId);
      this.appendEvent({ kind: 'agent.attached', agentId, jobId: round.jobId, roundId, payload: { roundId } });
      return this.getAgent(agentId) as AgentRecord;
    });
  }

  appendCustomEvent(fields: {
    kind: string;
    agentId?: string | null;
    jobId?: string | null;
    roundId?: string | null;
    lens?: string | null;
    payload?: unknown;
  }): BusEvent {
    return this.transaction(() =>
      this.appendEvent({
        kind: fields.kind,
        agentId: fields.agentId ?? null,
        jobId: fields.jobId ?? null,
        roundId: fields.roundId ?? null,
        lens: fields.lens ?? null,
        payload: fields.payload,
      }),
    );
  }

  // ------------------------------------------------------------------
  // Pending re-briefs (see the type block above)
  // ------------------------------------------------------------------

  /** Persist a re-brief REQUEST before any worker is spawned: one durable
   * marker per guarded event (`silas.rebrief` + `job.delivered`), carrying
   * the request payload, its hash, and the event-sequence watermark below
   * which an event cannot answer this request. A newer request for the
   * same job+kind supersedes the older marker (upsert) — the latest note
   * is the one the current worker runs. When the request carries an
   * explicit completion intent, the phase-handoff guard row is created in
   * the SAME transaction (before any side effect) and its id lands on both
   * markers; a newer re-brief supersedes the older awaiting phase — its
   * late receipt can never hand back a lane the request no longer owns. */
  beginPendingRebrief(input: {
    jobId: string;
    note: string | null;
    briefing: string | null;
    /** Explicit completion intent; omitted = ordinary re-brief (no phase). */
    handoff?: CompletionHandoffIntent;
  }): readonly PendingRebriefRecord[] {
    if (this.getJob(input.jobId) === null) {
      throw new RecordNotFound(`job "${input.jobId}" not found — a re-brief marker belongs to a real job`);
    }
    const payload = JSON.stringify({ note: input.note, briefing: input.briefing });
    const payloadHash = createHash('sha256').update(payload).digest('hex');
    const baselineSeq = this.latestEventSeq();
    const ts = nowIso();
    return this.transaction(() => {
      let phaseId: string | null = null;
      if (input.handoff !== undefined) {
        for (const prior of this.listPhaseHandoffs({
          jobId: input.jobId,
          source: 'silas-rebrief',
          states: ['awaiting'],
        })) {
          this.closePhaseHandoff({
            phaseId: prior.phaseId,
            reason: 'superseded by a newer re-brief request',
          });
        }
        phaseId = this.beginPhaseHandoff({
          jobId: input.jobId,
          source: 'silas-rebrief',
          intent: input.handoff,
        }).record.phaseId;
      }
      const upsert = this.db.prepare(
        `INSERT INTO pending_rebriefs
           (id, job_id, kind, payload, payload_hash, baseline_seq, agent_id, session_file, phase_id, requested_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
         ON CONFLICT (job_id, kind) DO UPDATE SET
           id = excluded.id,
           payload = excluded.payload,
           payload_hash = excluded.payload_hash,
           baseline_seq = excluded.baseline_seq,
           agent_id = NULL,
           session_file = NULL,
           phase_id = excluded.phase_id,
           requested_at = excluded.requested_at,
           updated_at = excluded.updated_at`,
      );
      for (const kind of PENDING_REBRIEF_KINDS) {
        upsert.run(randomUUID(), input.jobId, kind, payload, payloadHash, baselineSeq, phaseId, ts, ts);
      }
      return this.listPendingRebriefs({ jobId: input.jobId });
    });
  }

  /** Bind the spawned re-brief worker to its markers (before its prompt is
   * delivered) so a crash mid-turn can resume the exact session. */
  bindPendingRebriefWorker(input: {
    ids: readonly string[];
    agentId: string;
    sessionFile: string | null;
  }): void {
    if (input.agentId === '') throw new Error('pending-rebrief worker id must be non-empty');
    this.transaction(() => {
      const update = this.db.prepare(
        'UPDATE pending_rebriefs SET agent_id = ?, session_file = ?, updated_at = ? WHERE id = ?',
      );
      const ts = nowIso();
      for (const id of input.ids) update.run(input.agentId, input.sessionFile, ts, id);
    });
  }

  listPendingRebriefs(opts: { jobId?: string } = {}): readonly PendingRebriefRecord[] {
    const rows =
      opts.jobId === undefined
        ? (this.db.prepare('SELECT * FROM pending_rebriefs ORDER BY job_id, kind').all() as Row[])
        : (this.db
            .prepare('SELECT * FROM pending_rebriefs WHERE job_id = ? ORDER BY kind')
            .all(opts.jobId) as Row[]);
    return rows.map((row) => this.pendingRebriefFromRow(row));
  }

  /** Clear markers ONLY once their guarded events landed. Deleting is the
   * clearing: the events table remains the durable history. */
  clearPendingRebriefs(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.transaction(() => {
      const remove = this.db.prepare('DELETE FROM pending_rebriefs WHERE id = ?');
      for (const id of ids) remove.run(id);
    });
  }

  // ------------------------------------------------------------------
  // Notifications (EPICS E7 story 2) — the durable notification log.
  // Every mutation is atomic with its event row and bus-published so all
  // surfaces (board push, chat notices, toasts) converge on one record.
  // ------------------------------------------------------------------

  recordNotification(input: {
    id: string;
    kind: string;
    routing: NotificationRouting;
    severity: NotificationSeverity;
    title: string;
    detail?: string | null;
    agentId?: string | null;
  }): NotificationRecord {
    if (input.id === '' || input.title === '') {
      throw new Error('notification id and title must be non-empty');
    }
    return this.transaction(() => {
      if (this.getNotification(input.id) !== null) {
        throw new Error(`notification "${input.id}" already exists`);
      }
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO notifications (id, ts, kind, routing, severity, title, detail, agent_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          ts,
          input.kind,
          input.routing,
          input.severity,
          input.title,
          input.detail ?? null,
          input.agentId ?? null,
        );
      this.appendEvent({
        kind: 'notification.created',
        agentId: input.agentId ?? null,
        payload: { id: input.id, routing: input.routing, severity: input.severity, title: input.title },
      });
      return this.getNotification(input.id) as NotificationRecord;
    });
  }

  getNotification(id: string): NotificationRecord | null {
    const row = this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : this.notificationFromRow(row);
  }

  listNotifications(opts: { limit?: number; offset?: number; unackedOnly?: boolean; routing?: NotificationRouting } = {}): readonly NotificationRecord[] {
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit <= 0 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('notification page limit must be positive and offset must be non-negative');
    }
    const clauses = [
      ...(opts.unackedOnly ? ['acked_at IS NULL', 'resolved_at IS NULL'] : []),
      ...(opts.routing !== undefined ? ['routing = ?'] : []),
    ];
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    return (this.db.prepare(`SELECT * FROM notifications${where} ORDER BY ts DESC, id LIMIT ? OFFSET ?`)
      .all(...(opts.routing !== undefined ? [opts.routing] : []), limit, offset) as Row[])
      .map((row) => this.notificationFromRow(row));
  }

  /** Count action-required notifications still awaiting a machine
   * disposition — the NEEDS GRU queue (self-clearing; the human bell is
   * not rung by these). Read straight from the TABLE — not the bounded
   * feed window — so the tracker stays true. */
  countPendingActionRequired(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM notifications WHERE routing = 'action-required' AND acked_at IS NULL AND resolved_at IS NULL",
      )
      .get() as Row;
    return Number(row.n);
  }

  /** Count needs-owner notifications still awaiting a human ack — the FOR
   * YOU queue (the only class that rings the bell). */
  countPendingNeedsOwner(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM notifications WHERE routing = 'needs-owner' AND acked_at IS NULL AND resolved_at IS NULL",
      )
      .get() as Row;
    return Number(row.n);
  }

  /** Enrich an already-durable provisional notification after async triage. */
  updateNotificationTriage(id: string, routing: NotificationRouting, detail: string | null): NotificationRecord | null {
    return this.transaction(() => {
      const current = this.getNotification(id);
      if (current === null || current.ackedAt !== null || current.resolvedAt !== null) return null;
      const changed = this.db
        .prepare('UPDATE notifications SET routing = ?, detail = ? WHERE id = ? AND acked_at IS NULL AND resolved_at IS NULL')
        .run(routing, detail, id);
      if (changed.changes === 0) return null;
      this.appendEvent({
        kind: 'notification.triaged',
        agentId: current.agentId,
        payload: { id, routing },
      });
      return this.getNotification(id);
    });
  }

  findNotificationByKind(kind: string, mode: 'any' | 'unacked' | 'active' | boolean = 'any'): NotificationRecord | null {
    const normalized = mode === true ? 'unacked' : mode === false ? 'any' : mode;
    const sql = normalized === 'unacked'
      ? 'SELECT * FROM notifications WHERE kind = ? AND acked_at IS NULL AND resolved_at IS NULL ORDER BY ts DESC, id LIMIT 1'
      : normalized === 'active'
        ? 'SELECT * FROM notifications WHERE kind = ? AND resolved_at IS NULL ORDER BY ts DESC, id LIMIT 1'
        : 'SELECT * FROM notifications WHERE kind = ? ORDER BY ts DESC, id LIMIT 1';
    const row = this.db.prepare(sql).get(kind) as Row | undefined;
    return row === undefined ? null : this.notificationFromRow(row);
  }

  /**
   * Routing-scoped open-incident lookup (Perkins R1/R2, gh-97): the plain
   * kind lookup ties-break by id (ts DESC, id ASC), so a legacy
   * machine-routed row can keep winning the dedupe over a same-millisecond
   * owner row. Callers that must honor a specific routing ask THIS query,
   * with the SAME mode semantics as findNotificationByKind: 'unacked' →
   * newest UNACKED+UNRESOLVED row of the exact kind AND routing (an acked
   * owner row is spent — a new trip may mint a new one); 'active' → newest
   * UNRESOLVED row even if ACKed (an ack records that a human saw the
   * incident; the row stays the one active incident until resolved, per
   * the decisions.degraded producer contract); 'any' → newest row of any
   * state. Never the other routing class.
   */
  findNotificationByKindAndRouting(
    kind: string,
    routing: NotificationRouting,
    mode: 'any' | 'unacked' | 'active' = 'unacked',
  ): NotificationRecord | null {
    const sql = mode === 'unacked'
      ? 'SELECT * FROM notifications WHERE kind = ? AND routing = ? AND acked_at IS NULL AND resolved_at IS NULL ORDER BY ts DESC, id LIMIT 1'
      : mode === 'active'
        ? 'SELECT * FROM notifications WHERE kind = ? AND routing = ? AND resolved_at IS NULL ORDER BY ts DESC, id LIMIT 1'
        : 'SELECT * FROM notifications WHERE kind = ? AND routing = ? ORDER BY ts DESC, id LIMIT 1';
    const row = this.db.prepare(sql).get(kind, routing) as Row | undefined;
    return row === undefined ? null : this.notificationFromRow(row);
  }

  /**
   * Resolve product incidents without forging a human acknowledgement.
   * Every changed row emits an event so connected status/notification
   * surfaces refresh immediately.
   */
  resolveNotificationsByKindPrefix(prefix: string, by: string): readonly NotificationRecord[] {
    if (prefix === '' || by === '') throw new Error('resolution prefix/by must be non-empty');
    return this.transaction(() => {
      const escaped = prefix.replace(/[\\%_]/g, '\\$&');
      const rows = this.db
        .prepare("SELECT * FROM notifications WHERE kind LIKE ? ESCAPE '\\' AND resolved_at IS NULL ORDER BY ts, id")
        .all(`${escaped}%`) as Row[];
      const resolved: NotificationRecord[] = [];
      for (const raw of rows) {
        const id = str(raw.id);
        const at = nowIso();
        this.db
          .prepare('UPDATE notifications SET resolved_at = ?, resolved_by = ? WHERE id = ? AND resolved_at IS NULL')
          .run(at, by, id);
        this.appendEvent({
          kind: 'notification.resolved',
          agentId: nstr(raw.agent_id),
          payload: { id, by },
        });
        resolved.push(this.getNotification(id) as NotificationRecord);
      }
      return resolved;
    });
  }

  /** Resolve one exact incident ID without acknowledging it for the owner. */
  resolveNotificationById(id: string, by: string): NotificationRecord | null {
    if (by.trim() === '') throw new Error('resolution by must be non-empty');
    return this.transaction(() => {
      const current = this.getNotification(id);
      if (current === null || current.resolvedAt !== null) return current;
      this.db.prepare('UPDATE notifications SET resolved_at = ?, resolved_by = ? WHERE id = ?')
        .run(nowIso(), by, id);
      this.appendEvent({ kind: 'notification.resolved', agentId: current.agentId, payload: { id, by } });
      return this.getNotification(id);
    });
  }

  /**
   * Record a display receipt (the shown:true doctrine): idempotent per
   * surface — a repeated receipt for the same surface is a no-op that
   * appends nothing (receipts must never spam the event log). Returns the
   * row, or null when the id is unknown.
   */
  markNotificationShown(id: string, surface: string): NotificationRecord | null {
    if (surface === '') throw new Error('surface must be non-empty');
    return this.transaction(() => {
      const current = this.getNotification(id);
      if (current === null) return null;
      const surfaces = new Set(
        current.shownBy === null ? [] : current.shownBy.split(','),
      );
      if (current.shownAt !== null && surfaces.has(surface)) return current;
      const shownAt = current.shownAt ?? nowIso();
      const shownBy = [...surfaces, surface].sort().join(',');
      this.db
        .prepare('UPDATE notifications SET shown_at = ?, shown_by = ? WHERE id = ?')
        .run(shownAt, shownBy, id);
      this.appendEvent({
        kind: 'notification.shown',
        agentId: current.agentId,
        payload: { id, surface },
      });
      return this.getNotification(id) as NotificationRecord;
    });
  }

  /** Explicit machine disposition, distinct from the owner's Ack.
   * A successful wake prompt by itself never calls this method. */
  disposeMachineNotification(id: string, detail: string): NotificationRecord | null {
    if (detail.trim() === '') throw new Error('machine disposition detail must be non-empty');
    return this.transaction(() => {
      const current = this.getNotification(id);
      if (current === null) return null;
      if (current.routing !== 'action-required') {
        throw new Error('only action-required notifications accept a Gru disposition; owner stops require owner acknowledgement');
      }
      if (current.resolvedAt !== null || current.ackedAt !== null) return current;
      this.db.prepare('UPDATE notifications SET resolved_at = ?, resolved_by = ? WHERE id = ?')
        .run(nowIso(), 'gru', id);
      this.appendEvent({ kind: 'notification.resolved', agentId: current.agentId, payload: { id, by: 'gru', detail } });
      return this.getNotification(id) as NotificationRecord;
    });
  }

  /** Human ack for owner/FYI only. Machine alerts require a disposition. */
  ackNotification(id: string, by: string): NotificationRecord | null {
    if (by === '') throw new Error('acked-by must be non-empty');
    return this.transaction(() => {
      const current = this.getNotification(id);
      if (current === null) return null;
      if (current.routing === 'action-required') {
        throw new Error('action-required notifications require a Gru disposition; Ack cannot clear machine attention');
      }
      if (current.ackedAt !== null) return current;
      this.db
        .prepare('UPDATE notifications SET acked_at = ?, acked_by = ? WHERE id = ?')
        .run(nowIso(), by, id);
      this.appendEvent({
        kind: 'notification.acked',
        agentId: current.agentId,
        payload: { id, by, routing: current.routing },
      });
      return this.getNotification(id) as NotificationRecord;
    });
  }

  // ------------------------------------------------------------------
  // Row mapping
  // ------------------------------------------------------------------

  private jobFromRow(row: Row): JobRecord {
    return {
      id: str(row.id),
      repo: str(row.repo),
      title: str(row.title),
      status: str(row.status) as JobStatus,
      baseBranch: nstr(row.base_branch),
      prUrl: nstr(row.pr_url),
      note: nstr(row.note),
      briefing: nstr(row.briefing),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }

  private worktreeFromRow(row: Row): WorktreeRecord {
    return {
      id: str(row.id),
      kind: str(row.kind) as WorktreeKind,
      repoPath: str(row.repo_path),
      repoName: str(row.repo_name),
      path: str(row.path),
      branch: nstr(row.branch),
      sha: str(row.sha),
      baseSource: this.worktreeBaseSourceFromRow(row),
      jobId: nstr(row.job_id),
      roundId: nstr(row.round_id),
      status: str(row.status) as WorktreeStatus,
      note: nstr(row.note),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }

  /** A stored base source must be one of the known labels — an unknown
   * value means a migration/code mismatch and is never coerced. */
  private worktreeBaseSourceFromRow(row: Row): WorktreeBaseSource | null {
    const value = nstr(row.base_source);
    if (value === null) return null;
    if (!isWorktreeBaseSource(value)) {
      throw new Error(`worktrees row ${str(row.id)} has unknown base_source "${value}"`);
    }
    return value;
  }

  private agentFromRow(row: Row): AgentRecord {
    return {
      id: str(row.id),
      role: str(row.role) as Role,
      label: nstr(row.label),
      jobId: nstr(row.job_id),
      roundId: nstr(row.round_id),
      state: str(row.state) as AgentState,
      lastActivity: nstr(row.last_activity),
      sessionFile: nstr(row.session_file),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }

  // ------------------------------------------------------------------
  // Durable follow-through obligations (phase 2 foundation).
  // Pure state + fences: nothing here executes work, schedules anything,
  // or wakes anyone. API writers must go through setJobStatus (or
  // recordBlockedObservation, the observer backstop) — never raw SQL.
  // ------------------------------------------------------------------

  /** The observer backstop for blocked observations that did not ride a
   * setJobStatus call (e.g. an async event-bus reconcile noticing a gap).
   * Same transactional path, same semantics; correctness does not depend
   * on it (the boundary is authoritative). */
  recordBlockedObservation(jobId: string, context: BlockerContext): ObligationRecord {
    return this.transaction(() => {
      if (this.getJob(jobId) === null) throw new RecordNotFound(`job "${jobId}" not found`);
      return this.applyBlockedObservation(jobId, context);
    });
  }

  getObligation(id: string): ObligationRecord | null {
    const row = this.db.prepare('SELECT * FROM job_obligations WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : this.obligationFromRow(row);
  }

  listObligations(
    opts: { jobId?: string; state?: ObligationState; limit?: number; cursor?: number } = {},
  ): readonly ObligationRecord[] {
    // Bounded by default and hard-capped (ruling E): a reconcile/adoption
    // pass never scans unbounded, and a cursor pages past the cap.
    const limit = Math.min(Math.max(1, opts.limit ?? 200), 1000);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.jobId !== undefined) {
      where.push('job_id = ?');
      params.push(opts.jobId);
    }
    if (opts.state !== undefined) {
      where.push('state = ?');
      params.push(opts.state);
    }
    if (opts.cursor !== undefined) {
      where.push('rowid > ?');
      params.push(opts.cursor);
    }
    const sql = `SELECT rowid AS _rowid, * FROM job_obligations${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid LIMIT ?`;
    return (this.db.prepare(sql).all(...(params as never[]), limit) as Row[]).map((row) =>
      this.obligationFromRow(row),
    );
  }

  /** One obligation's rowid cursor (pagination anchor). */
  obligationRowid(id: string): number | null {
    const row = this.db.prepare('SELECT rowid AS _rowid FROM job_obligations WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? null : Number(row._rowid);
  }

  /** Queue-facing listing (ruling E): one malformed row must stay VISIBLE
   * as a triage problem without poisoning the whole pass. `readable`
   * carries parsed rows; `malformed` carries the raw id plus the parse
   * error — never silently dropped, never fatal to the rest. */
  listObligationsDetailed(
    opts: { jobId?: string; state?: ObligationState; limit?: number; cursor?: number } = {},
  ): { readable: readonly ObligationRecord[]; malformed: readonly { id: string; error: string }[] } {
    const limit = Math.min(Math.max(1, opts.limit ?? 200), 1000);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.jobId !== undefined) {
      where.push('job_id = ?');
      params.push(opts.jobId);
    }
    if (opts.state !== undefined) {
      where.push('state = ?');
      params.push(opts.state);
    }
    if (opts.cursor !== undefined) {
      where.push('rowid > ?');
      params.push(opts.cursor);
    }
    const sql = `SELECT rowid AS _rowid, * FROM job_obligations${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid LIMIT ?`;
    const rows = this.db.prepare(sql).all(...(params as never[]), limit) as Row[];
    const readable: ObligationRecord[] = [];
    const malformed: { id: string; error: string }[] = [];
    for (const row of rows) {
      try {
        readable.push(this.obligationFromRow(row));
      } catch (error) {
        const rawId = typeof row['id'] === 'string' ? row['id'] : `rowid:${String(row['_rowid'])}`;
        malformed.push({ id: rawId, error: String(error) });
      }
    }
    return { readable, malformed };
  }

  /** Is this obligation's authority CURRENTLY VALID against durable
   * facts (ruling E)? An unverifiable reference is a visible
   * NON-EXECUTABLE decision, never a grant. Attribution limits
   * (issue #99, unchanged): a shared bearer token means caller-supplied
   * `by`/source text never proves owner/Gru identity — validity is
   * checked against ledger facts only.
   *
   * - No authority ⇒ non-executable (attention-only).
   * - `accepted-operation` ⇒ the named directive request must exist,
   *   belong to this job, and be actually admitted or settled — accepted,
   *   not merely typed. The authority's `version` field is caller-supplied
   *   provenance TEXT and is not independently validated here; only the
   *   durable directive request grounds executability.
   * - `chief-ruling`/`owner-ruling` ⇒ a `ruling.recorded` event with the
   *   exact ref and version must exist on this job; prose or a path is
   *   never proof. */
  verifyObligationAuthority(obligationId: string): { executable: boolean; reason: string } {
    const row = this.getObligation(obligationId);
    if (row === null) throw new RecordNotFound(`obligation "${obligationId}" not found`);
    const authority = row.authority;
    if (authority === null) {
      return { executable: false, reason: 'no typed authority — attention-only' };
    }
    if (authority.source === 'accepted-operation') {
      const directive = this.getDirective(authority.operationId);
      if (directive === null) {
        return { executable: false, reason: `accepted operation "${authority.operationId}" has no durable directive request` };
      }
      if (directive.jobId !== row.jobId) {
        return { executable: false, reason: `accepted operation "${authority.operationId}" belongs to job ${directive.jobId}, not ${row.jobId}` };
      }
      if (directive.state !== 'admitted' && directive.state !== 'settled') {
        return { executable: false, reason: `accepted operation "${authority.operationId}" is ${directive.state} — accepted admission required` };
      }
      return {
        executable: true,
        reason:
          `operation ${authority.operationId} is durably admitted; the authority's version field ` +
          `"${authority.version}" is caller-supplied provenance, not independently validated`,
      };
    }
    // A ruling is valid while SOME durably recorded ruling event carries
    // its exact ref+version — later unrelated rulings must not shadow an
    // earlier matching one (latest-only would report a false negative).
    const event = this.listJobEvents(row.jobId, { limit: 1000 }).find((candidate) => {
      if (candidate.kind !== 'ruling.recorded') return false;
      const payload = (typeof candidate.payload === 'object' && candidate.payload !== null ? candidate.payload : {}) as Record<string, unknown>;
      return payload['ref'] === authority.rulingRef && payload['version'] === authority.version;
    });
    if (event === undefined) {
      return {
        executable: false,
        reason: `no durably recorded ruling event answers "${authority.rulingRef}" v"${authority.version}" — attention decision required`,
      };
    }
    return { executable: true, reason: `ruling ${authority.rulingRef} v${authority.version} is durably recorded` };
  }

  /** Take a request/generation-fenced claim on an obligation's next
   * action. Records the fence; NEVER authorizes executing work by itself
   * (a silas-mechanical obligation must already carry typed authority —
   * a claim cannot mint it). Lease expiry alone never licenses a
   * replacement holder: superseding an EXPIRED claim requires positive
   * reconciliation proof, recorded with the full prior identity in the
   * claim log (ruling D). */
  claimObligation(input: {
    obligationId: string;
    requestId: string;
    holder: string;
    expiresAt: string;
    expectedGeneration: number;
    /** Positive disposition proof for superseding an EXPIRED claim —
     * e.g. the ledger/actor facts checked. Ignored when no claim exists. */
    supersedeProof?: string;
  }): ObligationRecord {
    if (input.requestId.trim() === '') throw new Error('claim requires a non-empty requestId');
    if (input.holder.trim() === '') throw new Error('claim requires a non-empty holder');
    const expiresAt = canonicalIsoTimestamp(input.expiresAt, 'claim expiresAt');
    return this.transaction(() => {
      const row = this.getObligation(input.obligationId);
      if (row === null) throw new RecordNotFound(`obligation "${input.obligationId}" not found`);
      if (row.state !== 'open' && row.state !== 'waiting') {
        throw new Error(`obligation "${row.id}" is ${row.state} — only open/waiting obligations can be claimed`);
      }
      if (row.generation !== input.expectedGeneration) {
        throw new StaleContinuationError(
          `generation fence on "${row.id}": continuation expected generation ${input.expectedGeneration}, ` +
            `the obligation is at ${row.generation} — re-derive from current durable state before acting`,
        );
      }
      if (row.nextAction.kind === 'silas-mechanical' && row.authority === null) {
        throw new Error(
          `obligation "${row.id}" names mechanical action "${row.nextAction.action}" without typed authority — ` +
            'a claim is a coordination fence, never a grant; the obligation is attention-only until authority exists',
        );
      }
      const now = nowIso();
      if (row.claim !== null && row.claim.requestId !== input.requestId) {
        const expired = row.claim.expiresAt !== null && row.claim.expiresAt <= now;
        if (!expired) {
          throw new ClaimHeldError(
            `obligation "${row.id}" is held by request ${row.claim.requestId} (${row.claim.holder}) until ${row.claim.expiresAt}`,
          );
        }
        if (input.supersedeProof === undefined || input.supersedeProof.trim() === '') {
          throw new ClaimHeldError(
            `obligation "${row.id}" claim by ${row.claim.requestId} expired at ${row.claim.expiresAt}, but expiry alone ` +
              'transfers nothing — the reconciliation path must positively dispose of the old claim first ' +
              '(supply supersedeProof with the checked evidence)',
          );
        }
      }
      if (row.claim !== null && row.claim.requestId === input.requestId && row.claim.holder !== input.holder) {
        throw new ClaimHeldError(
          `request ${input.requestId} holds "${row.id}" as ${row.claim.holder} — the same request id cannot change holder`,
        );
      }
      const replacing = row.claim !== null && row.claim.requestId !== input.requestId;
      const claim: ObligationClaim = { requestId: input.requestId, holder: input.holder, generation: row.generation, expiresAt };
      const log = replacing
        ? [
            ...row.claimLog,
            {
              requestId: row.claim!.requestId,
              holder: row.claim!.holder,
              generation: row.claim!.generation,
              expiresAt: row.claim!.expiresAt,
              disposition: 'superseded-expired-reconciled' as ClaimLogDisposition,
              at: now,
              proof: input.supersedeProof ?? null,
              supersededByRequest: input.requestId,
            },
          ]
        : row.claimLog;
      this.db
        .prepare('UPDATE job_obligations SET claim = ?, claim_log = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(claim), JSON.stringify(log), now, row.id);
      this.appendEvent({
        kind: 'job.obligation-claimed',
        jobId: row.jobId,
        payload: {
          id: row.id,
          requestId: input.requestId,
          holder: input.holder,
          expiresAt,
          ...(replacing ? { supersededExpired: row.claim!.requestId, proof: input.supersedeProof } : {}),
        },
      });
      return this.getObligation(row.id) as ObligationRecord;
    });
  }

  /** Release a claim; only the owning request may release it, and the
   * full identity of the released claim lands in the claim log. */
  releaseClaim(input: { obligationId: string; requestId: string }): ObligationRecord {
    return this.transaction(() => {
      const row = this.getObligation(input.obligationId);
      if (row === null) throw new RecordNotFound(`obligation "${input.obligationId}" not found`);
      if (row.claim === null) throw new Error(`obligation "${row.id}" has no claim to release`);
      if (row.claim.requestId !== input.requestId) {
        throw new ClaimHeldError(`obligation "${row.id}" is held by request ${row.claim.requestId}, not ${input.requestId}`);
      }
      const log: readonly ClaimLogEntry[] = [
        ...row.claimLog,
        {
          requestId: row.claim.requestId,
          holder: row.claim.holder,
          generation: row.claim.generation,
          expiresAt: row.claim.expiresAt,
          disposition: 'released',
          at: nowIso(),
          proof: null,
          supersededByRequest: null,
        },
      ];
      this.db
        .prepare('UPDATE job_obligations SET claim = NULL, claim_log = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(log), nowIso(), row.id);
      this.appendEvent({
        kind: 'job.obligation-claim-released',
        jobId: row.jobId,
        payload: { id: row.id, requestId: input.requestId },
      });
      return this.getObligation(row.id) as ObligationRecord;
    });
  }

  /** Record receipt evidence for an obligation. IDEMPOTENT per
   * (kind, eventSeq). The receipt must cite an ACTUAL ledger event:
   * it must exist, carry exactly that kind, and belong to the
   * obligation's job — a fabricated sequence or a wrong-job event is
   * refused, never settled on (ruling A). When the obligation armed a
   * correlation, an event that does not carry the delegated phase's
   * identity is recorded as unapplied evidence: a later unrelated event
   * of the same kind cannot satisfy an older expectation. A receipt
   * postdating the obligation's watermark may hand a waiting obligation
   * back to open (the decision returns); a receipt NEVER settles —
   * accepted gates require an explicit, validated settlement. */
  recordObligationReceipt(input: {
    obligationId: string;
    kind: string;
    eventSeq: number;
    at?: string;
  }): ObligationRecord {
    if (!Number.isSafeInteger(input.eventSeq) || input.eventSeq < 0) {
      throw new Error('receipt requires a safe non-negative eventSeq');
    }
    return this.transaction(() => {
      const row = this.getObligation(input.obligationId);
      if (row === null) throw new RecordNotFound(`obligation "${input.obligationId}" not found`);
      const duplicate = row.recordedReceipts.some(
        (receipt) => receipt.kind === input.kind && receipt.eventSeq === input.eventSeq,
      );
      if (duplicate) return row; // already recorded — replay is a no-op
      // Evidence grounding (ruling A): the cited event must really exist,
      // be of the claimed kind, and belong to this obligation's job.
      const event = this.getEvent(input.eventSeq);
      if (event === null) {
        throw new Error(
          `receipt for "${row.id}" cites event seq ${input.eventSeq} which does not exist — ` +
            'a receipt without a real correlated event is refused',
        );
      }
      if (event.kind !== input.kind) {
        throw new Error(
          `receipt for "${row.id}" claims kind "${input.kind}" but event ${input.eventSeq} is "${event.kind}"`,
        );
      }
      if (event.jobId !== row.jobId) {
        throw new Error(
          `receipt for "${row.id}" cites event ${input.eventSeq} of job ${String(event.jobId)} — a wrong-job event cannot answer this obligation's debt`,
        );
      }
      // Correlation (ruling A): when the expectation was armed with the
      // delegated phase's identity, the event must carry it. A mismatch is
      // recorded as unapplied evidence — visible, never satisfying.
      const correlation = row.receiptCorrelation;
      let correlated = true;
      if (correlation !== null) {
        const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
        if (correlation.requestId !== undefined && payload['request_id'] !== correlation.requestId) correlated = false;
        if (correlation.minionId !== undefined && payload['agentId'] !== correlation.minionId && payload['minion_id'] !== correlation.minionId) {
          correlated = false;
        }
      }
      const applied = correlated && input.eventSeq > row.lastOriginSeq;
      const receipts: RecordedReceipt[] = [
        ...row.recordedReceipts,
        { kind: input.kind, eventSeq: input.eventSeq, at: input.at ?? nowIso(), applied },
      ];
      let state: ObligationState = row.state;
      if (applied && row.state === 'waiting' && row.receiptKind === input.kind) {
        state = 'open'; // phase completion hands the decision back — not delivery/approval
      }
      this.db
        .prepare(
          `UPDATE job_obligations
             SET recorded_receipts = ?, last_origin_seq = MAX(last_origin_seq, ?), state = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(JSON.stringify(receipts), input.eventSeq, state, nowIso(), row.id);
      this.appendEvent({
        kind: 'job.obligation-receipt',
        jobId: row.jobId,
        payload: {
          id: row.id,
          receipt_kind: input.kind,
          event_seq: input.eventSeq,
          applied,
          ...(correlated ? {} : { correlation: 'mismatch — recorded as evidence only' }),
          from: row.state,
          to: state,
        },
      });
      return this.getObligation(row.id) as ObligationRecord;
    });
  }

  /** Settle or close an obligation with a validated, discriminated
   * settlement. Evidence kinds cite a REAL ledger event (it must exist,
   * belong to this obligation's job, and carry the exact cited kind —
   * no fabricated sequence or wrong-job/gate event settles debt,
   * ruling A); administrative closes (superseded/cancelled/job-terminal)
   * are durable truth from the job machine itself and clear any claim
   * rather than being vetoed by it. History is preserved (the row and
   * its events stay); settled/closed are terminal — a recurring incident
   * is a NEW obligation. */
  settleObligation(input: {
    obligationId: string;
    settlement: ObligationSettlement;
    requestId?: string;
  }): ObligationRecord {
    return this.transaction(() => {
      const row = this.getObligation(input.obligationId);
      if (row === null) throw new RecordNotFound(`obligation "${input.obligationId}" not found`);
      const target: ObligationState =
        input.settlement.kind === 'executed-action' || input.settlement.kind === 'accepted-evidence'
          ? 'settled'
          : 'closed';
      assertObligationTransition(row.state, target);
      if (
        input.settlement.kind === 'executed-action' ||
        input.settlement.kind === 'accepted-evidence'
      ) {
        // Evidence grounding (ruling A): the cited event must exist, sit
        // on this obligation's job, and carry the exact cited kind. Mere
        // typed JSON is not proof; the ledger fact is.
        const event = this.getEvent(input.settlement.evidenceEventSeq);
        if (event === null) {
          throw new Error(
            `settlement for "${row.id}" cites evidence event seq ${input.settlement.evidenceEventSeq} which does not exist — refused`,
          );
        }
        if (event.jobId !== row.jobId) {
          throw new Error(
            `settlement for "${row.id}" cites evidence event ${input.settlement.evidenceEventSeq} of job ${String(event.jobId)} — refused`,
          );
        }
        if (event.kind !== input.settlement.evidenceEventKind) {
          throw new Error(
            `settlement for "${row.id}" cites kind "${input.settlement.evidenceEventKind}" but event ${input.settlement.evidenceEventSeq} is "${event.kind}" — refused`,
          );
        }
      }
      // Evidence settlements are claim-fenced (the owning request proves
      // its continuation). Administrative closes clear the claim and log
      // its identity — the durable truth outranks the fence, and the
      // history records who lost it.
      if (
        row.claim !== null &&
        row.claim.requestId !== input.requestId &&
        (input.settlement.kind === 'executed-action' || input.settlement.kind === 'accepted-evidence')
      ) {
        throw new ClaimHeldError(
          `obligation "${row.id}" is held by request ${row.claim.requestId} — settle through the owning request or release it first`,
        );
      }
      const administrative = target === 'closed';
      const supersededBy = input.settlement.kind === 'superseded' ? input.settlement.byObligationId : null;
      const log: readonly ClaimLogEntry[] =
        row.claim === null
          ? row.claimLog
          : [
              ...row.claimLog,
              {
                requestId: row.claim.requestId,
                holder: row.claim.holder,
                generation: row.claim.generation,
                expiresAt: row.claim.expiresAt,
                disposition: administrative ? 'terminal-close' : 'released',
                at: nowIso(),
                proof: `settlement: ${input.settlement.kind}`,
                supersededByRequest: null,
              },
            ];
      this.db
        .prepare(
          'UPDATE job_obligations SET state = ?, settlement = ?, superseded_by = COALESCE(?, superseded_by), claim = NULL, claim_log = ?, updated_at = ? WHERE id = ?',
        )
        .run(target, JSON.stringify(input.settlement), supersededBy, JSON.stringify(log), nowIso(), row.id);
      this.appendEvent({
        kind: 'job.obligation-settled',
        jobId: row.jobId,
        payload: { id: row.id, from: row.state, to: target, settlement: input.settlement },
      });
      return this.getObligation(row.id) as ObligationRecord;
    });
  }

  /** Arm a receipt expectation: the obligation's next action is delegated
   * to a phase that owes a typed receipt (e.g. job.delivered) by a
   * deadline. `correlation` pins the expectation to the delegated
   * phase's actual identity (request/minion) — without a match, a
   * same-kind event is evidence but never satisfaction (ruling A).
   * Pure state — arming does NOT spawn, notify or execute anything; the
   * delegation hook calls this when it actually hands work over, so
   * "waiting" is always backed by durable intent. */
  armReceiptExpectation(input: {
    obligationId: string;
    receiptKind: string;
    deadlineAt: string;
    correlation?: ReceiptCorrelation;
    requestId?: string;
    reason?: string;
  }): ObligationRecord {
    if (input.receiptKind.trim() === '') throw new Error('arming requires a non-empty receiptKind');
    const deadlineAt = canonicalIsoTimestamp(input.deadlineAt, 'arming deadlineAt');
    return this.transaction(() => {
      const row = this.getObligation(input.obligationId);
      if (row === null) throw new RecordNotFound(`obligation "${input.obligationId}" not found`);
      assertObligationTransition(row.state, 'waiting');
      if (row.claim !== null && row.claim.requestId !== input.requestId) {
        throw new ClaimHeldError(
          `obligation "${row.id}" is held by request ${row.claim.requestId} — arm through the owning request or release it first`,
        );
      }
      this.db
        .prepare(
          `UPDATE job_obligations SET state = 'waiting', receipt_kind = ?, deadline_at = ?, receipt_correlation = ?, updated_at = ? WHERE id = ?`,
        )
        .run(
          input.receiptKind,
          deadlineAt,
          input.correlation === undefined ? null : JSON.stringify(input.correlation),
          nowIso(),
          row.id,
        );
      this.appendEvent({
        kind: 'job.obligation-state',
        jobId: row.jobId,
        payload: {
          id: row.id,
          from: row.state,
          to: 'waiting',
          receipt_kind: input.receiptKind,
          deadline_at: deadlineAt,
          ...(input.correlation !== undefined ? { correlation: input.correlation } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        },
      });
      return this.getObligation(row.id) as ObligationRecord;
    });
  }

  /** Explicit durable suspension (owner hold / parking). Never inferred
   * from a notification ack, prose, or a check name. */
  suspendObligation(id: string, reason: string): ObligationRecord {
    return this.transaction(() => {
      const row = this.getObligation(id);
      if (row === null) throw new RecordNotFound(`obligation "${id}" not found`);
      assertObligationTransition(row.state, 'suspended');
      this.db
        .prepare("UPDATE job_obligations SET state = 'suspended', updated_at = ? WHERE id = ?")
        .run(nowIso(), row.id);
      this.appendEvent({
        kind: 'job.obligation-state',
        jobId: row.jobId,
        payload: { id: row.id, from: row.state, to: 'suspended', reason },
      });
      return this.getObligation(row.id) as ObligationRecord;
    });
  }

  /** Explicit durable resume (only a human/chief decision does this). */
  resumeObligation(id: string, reason: string): ObligationRecord {
    return this.transaction(() => {
      const row = this.getObligation(id);
      if (row === null) throw new RecordNotFound(`obligation "${id}" not found`);
      assertObligationTransition(row.state, 'open');
      this.db
        .prepare("UPDATE job_obligations SET state = 'open', updated_at = ? WHERE id = ?")
        .run(nowIso(), row.id);
      this.appendEvent({
        kind: 'job.obligation-state',
        jobId: row.jobId,
        payload: { id: row.id, from: row.state, to: 'open', reason },
      });
      return this.getObligation(row.id) as ObligationRecord;
    });
  }

  /** Reclassify obligations whose continuations were fenced off by newer
   * durable truth (head moved, completion, cancellation, revised ruling,
   * owner hold). The old EXECUTION authority dies; the still-owed debt
   * does NOT: each reclassified row closes as `superseded` linked to a
   * genuine successor created ATOMICALLY in the same transaction — fresh
   * generation, attention-routed Gru re-derivation, no carried authority
   * or claim (ruling B: a new owner hold must not erase verification/
   * review obligations; only an explicit applicable cancellation or
   * terminal disposition ends the debt). Acts ONLY on applicable rows
   * (open/waiting, at or before the watermark); terminal rows and
   * history are untouched. */
  invalidateStaleContinuations(input: {
    jobId: string;
    newerThanSeq: number;
    reason: string;
  }): { readonly superseded: readonly ObligationRecord[]; readonly successors: readonly ObligationRecord[] } {
    return this.transaction(() => {
      if (this.getJob(input.jobId) === null) throw new RecordNotFound(`job "${input.jobId}" not found`);
      const applicable = this.listObligations({ jobId: input.jobId, limit: 1000 }).filter(
        (row) => (row.state === 'open' || row.state === 'waiting') && row.lastOriginSeq <= input.newerThanSeq,
      );
      const superseded: ObligationRecord[] = [];
      const successors: ObligationRecord[] = [];
      for (const row of applicable) {
        // The successor is the same incident's debt re-derived under the
        // newer truth: attention-only (no carried authority), fresh
        // generation, unclaimed. The old row closes LINKED to it — the
        // debt visibly continues, it did not vanish.
        const logicalStep = isObligationLogicalStep(row.logicalStep) ? row.logicalStep : 'operation';
        const successorId = this.nextIncarnationId(obligationId(row.jobId, logicalStep, row.incidentKey));
        this.settleObligation({
          obligationId: row.id,
          settlement: { kind: 'superseded', byObligationId: successorId, reason: input.reason },
        });
        const generation = this.currentJobGeneration(input.jobId) + 1;
        const successorPlan: ObligationNextAction = {
          kind: 'gru-decision',
          decision: `re-derive the next action after durable truth changed: ${input.reason}`,
        };
        const now = nowIso();
        this.db
          .prepare(
            `INSERT INTO job_obligations
               (id, job_id, logical_step, incident_key, generation, description, category, next_action, wake_condition,
                authority, firing_rule, state, recorded_receipts, observations, first_origin_seq, last_origin_seq,
                created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'open', '[]', 1, ?, ?, ?, ?)`,
          )
          .run(
            successorId,
            row.jobId,
            logicalStep,
            row.incidentKey,
            generation,
            row.description,
            JSON.stringify(row.category),
            JSON.stringify(successorPlan),
            JSON.stringify(defaultFiringRule(row.category).wakeCondition),
            defaultFiringRule(row.category).id,
            input.newerThanSeq,
            input.newerThanSeq,
            now,
            now,
          );
        this.appendEvent({
          kind: 'job.obligation-recorded',
          jobId: row.jobId,
          payload: {
            id: successorId,
            generation,
            category: categoryKey(row.category),
            next_action: successorPlan,
            firing_rule: defaultFiringRule(row.category).id,
            authority: null,
            reclassified_of: row.id,
            reason: input.reason,
          },
        });
        superseded.push(this.getObligation(row.id) as ObligationRecord);
        successors.push(this.getObligation(successorId) as ObligationRecord);
      }
      return { superseded, successors };
    });
  }

  /** Apply one typed blocked observation. The lookup is the tuple's
   * ACTIVE incarnation — never just the base id, which may be settled
   * history while a live `#2` incarnation exists (ruling C). Semantics:
   * - live incarnation ⇒ coalesce: stable identity and generation; a
   *   strictly newer observation applies its plan, and a CHANGED plan
   *   bumps `plan_revision` and fences claims derived from the older
   *   plan; a stale replay (seq at/below the row's watermark) changes
   *   nothing — it never regresses the watermark or overwrites a newer
   *   plan.
   * - all incarnations terminal ⇒ a recurrence mints the next free
   *   incarnation id at a fresh generation — but only when the
   *   observation postdates the tuple's newest watermark; an older
   *   replay is evidence and must NOT reopen settled history.
   * - fresh tuple ⇒ the first incarnation opens.
   * The partial unique index enforces one active incarnation per tuple
   * transactionally (a race fails loud instead of minting duplicates). */
  private applyBlockedObservation(jobId: string, context: BlockerContext): ObligationRecord {
    const resolved = resolveObligation(context, jobId);
    const now = nowIso();
    const active = this.activeIncarnation(jobId, resolved.logicalStep, resolved.incidentKey);
    if (active !== null) {
      return this.coalesceObservation(active, resolved, context, now);
    }
    const newestWatermark = this.newestIncarnationWatermark(jobId, resolved.logicalStep, resolved.incidentKey);
    if (newestWatermark !== null && context.observedAtSeq <= newestWatermark) {
      this.appendEvent({
        kind: 'job.obligation-stale-observation',
        jobId,
        payload: {
          incident_key: resolved.incidentKey,
          logical_step: resolved.logicalStep,
          observed_at_seq: context.observedAtSeq,
          newest_watermark: newestWatermark,
          note: 'observation predates the tuple history — evidence only, no reopen',
        },
      });
      return this.latestIncarnation(jobId, resolved.logicalStep, resolved.incidentKey) as ObligationRecord;
    }
    const id = this.nextIncarnationId(obligationId(jobId, resolved.logicalStep, resolved.incidentKey));
    const generation = this.currentJobGeneration(jobId) + 1;
    this.insertObligationRow({ id, jobId, resolved, generation, observedAtSeq: context.observedAtSeq, now });
    this.appendEvent({
      kind: 'job.obligation-recorded',
      jobId,
      payload: {
        id,
        generation,
        category: categoryKey(resolved.category),
        next_action: resolved.nextAction,
        firing_rule: resolved.firingRule,
        authority: resolved.authority,
        description: resolved.description,
      },
    });
    return this.getObligation(id) as ObligationRecord;
  }

  /** Coalesce a duplicate observation of the LIVE incarnation. */
  private coalesceObservation(
    existing: ObligationRecord,
    resolved: ResolvedObligation,
    context: BlockerContext,
    now: string,
  ): ObligationRecord {
    if (context.observedAtSeq <= existing.lastOriginSeq) {
      this.appendEvent({
        kind: 'job.obligation-stale-observation',
        jobId: existing.jobId,
        payload: {
          id: existing.id,
          observed_at_seq: context.observedAtSeq,
          newest_watermark: existing.lastOriginSeq,
          note: 'stale replay — evidence only, plan and watermark untouched',
        },
      });
      return existing;
    }
    const planChanged =
      categoryKey(existing.category) !== categoryKey(resolved.category) ||
      JSON.stringify(existing.nextAction) !== JSON.stringify(resolved.nextAction) ||
      JSON.stringify(existing.wakeCondition) !== JSON.stringify(resolved.wakeCondition) ||
      JSON.stringify(existing.authority) !== JSON.stringify(resolved.authority) ||
      existing.firingRule !== resolved.firingRule;
    const changed: string[] = [];
    if (planChanged) changed.push('plan');
    if (existing.dueAt !== resolved.dueAt || existing.deadlineAt !== resolved.deadlineAt) changed.push('bounds');
    // A changed plan is a NEW authority revision (ruling C): claims taken
    // under the old plan are fenced and their full identity moves to the
    // claim log, so an old continuation cannot ride new wording.
    let claim: ObligationClaim | null = existing.claim;
    let claimLog: readonly ClaimLogEntry[] = existing.claimLog;
    let planRevision = existing.planRevision;
    if (planChanged) {
      planRevision += 1;
      if (existing.claim !== null) {
        claimLog = [
          ...claimLog,
          {
            requestId: existing.claim.requestId,
            holder: existing.claim.holder,
            generation: existing.claim.generation,
            expiresAt: existing.claim.expiresAt,
            disposition: 'plan-revision' as ClaimLogDisposition,
            at: now,
            proof: `plan revision ${planRevision}`,
            supersededByRequest: null,
          },
        ];
        claim = null;
      }
    }
    this.db
      .prepare(
        `UPDATE job_obligations
           SET observations = observations + 1,
               last_origin_seq = ?,
               description = COALESCE(?, description),
               category = ?, next_action = ?, wake_condition = ?, authority = ?, firing_rule = ?,
               due_at = COALESCE(?, due_at), receipt_kind = COALESCE(?, receipt_kind),
               deadline_at = COALESCE(?, deadline_at),
               plan_revision = ?, claim = ?, claim_log = ?,
               updated_at = ?
         WHERE id = ?`,
      )
      .run(
        context.observedAtSeq,
        resolved.description,
        JSON.stringify(resolved.category),
        JSON.stringify(resolved.nextAction),
        JSON.stringify(resolved.wakeCondition),
        resolved.authority === null ? null : JSON.stringify(resolved.authority),
        resolved.firingRule,
        resolved.dueAt,
        resolved.receiptKind,
        resolved.deadlineAt,
        planRevision,
        claim === null ? null : JSON.stringify(claim),
        JSON.stringify(claimLog),
        now,
        existing.id,
      );
    this.appendEvent({
      kind: 'job.obligation-updated',
      jobId: existing.jobId,
      payload: {
        id: existing.id,
        observations: existing.observations + 1,
        last_origin_seq: context.observedAtSeq,
        ...(resolved.description !== null ? { description: resolved.description } : {}),
        changed,
        ...(planChanged ? { plan_revision: planRevision, claim_fenced: existing.claim !== null } : {}),
      },
    });
    return this.getObligation(existing.id) as ObligationRecord;
  }

  /** Insert one fresh obligation incarnation (first or recurrence). */
  private insertObligationRow(input: {
    id: string;
    jobId: string;
    resolved: ResolvedObligation;
    generation: number;
    observedAtSeq: number;
    now: string;
  }): void {
    const { resolved } = input;
    this.db
      .prepare(
        `INSERT INTO job_obligations
           (id, job_id, logical_step, incident_key, generation, description, category, next_action, wake_condition,
            authority, firing_rule, state, due_at, receipt_kind, deadline_at, receipt_correlation,
            recorded_receipts, observations, first_origin_seq, last_origin_seq, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, '[]', 1, ?, ?, ?, ?)`,
      )
      .run(
        input.id,
        input.jobId,
        resolved.logicalStep,
        resolved.incidentKey,
        input.generation,
        resolved.description,
        JSON.stringify(resolved.category),
        JSON.stringify(resolved.nextAction),
        JSON.stringify(resolved.wakeCondition),
        resolved.authority === null ? null : JSON.stringify(resolved.authority),
        resolved.firingRule,
        resolved.dueAt,
        resolved.receiptKind,
        resolved.deadlineAt,
        resolved.receiptCorrelation === null ? null : JSON.stringify(resolved.receiptCorrelation),
        input.observedAtSeq,
        input.observedAtSeq,
        input.now,
        input.now,
      );
  }

  /** The tuple's live (non-terminal) incarnation, if any — the ONLY row a
   * duplicate observation may coalesce into (ruling C). */
  private activeIncarnation(jobId: string, logicalStep: string, incidentKey: string): ObligationRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM job_obligations
          WHERE job_id = ? AND logical_step = ? AND incident_key = ?
            AND state NOT IN ('settled', 'closed')
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(jobId, logicalStep, incidentKey) as Row | undefined;
    return row === undefined ? null : this.obligationFromRow(row);
  }

  /** The tuple's newest incarnation in any state (replay-guard anchor). */
  private latestIncarnation(jobId: string, logicalStep: string, incidentKey: string): ObligationRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM job_obligations
          WHERE job_id = ? AND logical_step = ? AND incident_key = ?
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(jobId, logicalStep, incidentKey) as Row | undefined;
    return row === undefined ? null : this.obligationFromRow(row);
  }

  /** Highest watermark across the tuple's incarnations, or null for a
   * fresh tuple. An observation at/below it is a replay, not a reopen. */
  private newestIncarnationWatermark(jobId: string, logicalStep: string, incidentKey: string): number | null {
    const row = this.db
      .prepare(
        `SELECT MAX(last_origin_seq) AS watermark FROM job_obligations
          WHERE job_id = ? AND logical_step = ? AND incident_key = ?`,
      )
      .get(jobId, logicalStep, incidentKey) as Row | undefined;
    const value = row?.watermark;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  /** The job's current blocked-generation = the max generation across its
   * obligation rows (0 when none). */
  private currentJobGeneration(jobId: string): number {
    const row = this.db
      .prepare('SELECT MAX(generation) AS generation FROM job_obligations WHERE job_id = ?')
      .get(jobId) as Row | undefined;
    const value = row?.generation;
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }

  /** First free incarnation id for a recurring incident
   * (base, base#2, base#3, ...). History is append-only. */
  private nextIncarnationId(base: string): string {
    let candidate = base;
    let n = 1;
    while (this.getObligation(candidate) !== null) {
      n += 1;
      candidate = `${base}#${n}`;
    }
    return candidate;
  }

  /** Suspend the job's applicable obligations (open/waiting). Used by the
   * parked transition; explicit human/chief resume re-opens. */
  private suspendApplicableObligations(jobId: string, reason: string): void {
    for (const row of this.listObligations({ jobId, limit: 1000 })) {
      if (row.state === 'open' || row.state === 'waiting') {
        this.suspendObligation(row.id, reason);
      }
    }
  }

  /** Close the job's applicable obligations (open/waiting/suspended) on a
   * terminal transition — settled rows and history stay untouched. */
  private closeApplicableObligations(jobId: string, terminal: 'done' | 'merged'): void {
    for (const row of this.listObligations({ jobId, limit: 1000 })) {
      if (row.state === 'open' || row.state === 'waiting' || row.state === 'suspended') {
        this.settleObligation({
          obligationId: row.id,
          settlement: { kind: 'job-terminal', jobStatus: terminal },
        });
      }
    }
  }

  private obligationFromRow(row: Row): ObligationRecord {
    const state = str(row.state);
    if (!isObligationState(state)) {
      throw new Error(`job_obligations row "${str(row.id)}" has unknown state "${state}"`);
    }
    return {
      id: str(row.id),
      jobId: str(row.job_id),
      logicalStep: str(row.logical_step),
      incidentKey: str(row.incident_key),
      generation: Number(row.generation),
      description: nstr(row.description),
      category: parseCategory(str(row.category)),
      nextAction: parseNextAction(str(row.next_action)),
      wakeCondition: parseWakeCondition(str(row.wake_condition)),
      authority: parseAuthority(row.authority === null || row.authority === undefined ? null : str(row.authority)),
      firingRule: str(row.firing_rule),
      state,
      settlement: row.settlement === null || row.settlement === undefined ? null : parseSettlement(str(row.settlement)),
      dueAt: nstr(row.due_at),
      receiptKind: nstr(row.receipt_kind),
      deadlineAt: nstr(row.deadline_at),
      recordedReceipts: parseReceipts(str(row.recorded_receipts)),
      observations: Number(row.observations),
      planRevision: Number(row.plan_revision),
      firstOriginSeq: Number(row.first_origin_seq),
      lastOriginSeq: Number(row.last_origin_seq),
      supersededBy: nstr(row.superseded_by),
      claim: parseClaim(row.claim === null || row.claim === undefined ? null : str(row.claim)),
      claimLog: parseClaimLog(str(row.claim_log)),
      receiptCorrelation: parseReceiptCorrelation(
        row.receipt_correlation === null || row.receipt_correlation === undefined
          ? null
          : str(row.receipt_correlation),
      ),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }

  // ------------------------------------------------------------------
  // Explicit phase-completion handoffs (pr136-chief-handoff). A guard
  // row persisted BEFORE admission/side effects; a validated correlated
  // completion; publication recorded on the same row. Nothing here
  // executes work, wakes anyone by itself, or mints authority — the debt
  // lives in job_obligations and the wake rides NotificationCenter.
  // ------------------------------------------------------------------

  /** Persist the completion intent for an authorized phase. Idempotent
   * per request id: a replay returns the SAME row (changed decision is a
   * conflict — the intent is part of the request identity). The host mints
   * the deterministic `phase-handoff:<job>:<source>:<generation>` id. */
  beginPhaseHandoff(input: {
    jobId: string;
    source: PhaseHandoffSource;
    intent: CompletionHandoffIntent;
    requestId?: string | null;
  }): { readonly record: PhaseHandoffRecord; readonly created: boolean } {
    if (!isPhaseHandoffSource(input.source)) {
      throw new Error(`phase handoff source "${String(input.source)}" is unknown`);
    }
    const decision = input.intent.decision.trim();
    if (decision === '') throw new Error('phase handoff requires a non-empty decision');
    if (decision.length > MAX_COMPLETION_HANDOFF_DECISION) {
      throw new Error(`phase handoff decision exceeds ${MAX_COMPLETION_HANDOFF_DECISION} characters`);
    }
    return this.transaction(() => {
      const job = this.getJob(input.jobId);
      if (job === null) throw new RecordNotFound(`job "${input.jobId}" not found`);
      const requestId = input.requestId ?? null;
      if (requestId !== null) {
        const existing = this.findPhaseHandoffByRequest({ jobId: input.jobId, requestId });
        if (existing !== null) {
          if (existing.decision !== decision) {
            throw new PhaseHandoffConflictError(
              `phase handoff for request "${requestId}" was accepted with a different decision — ` +
                'the intent is part of the durable request; changed intent needs a new request',
            );
          }
          return { record: existing, created: false };
        }
      }
      const generation = this.nextPhaseHandoffGeneration(input.jobId);
      const phaseId = phaseHandoffId(input.jobId, input.source, generation);
      const intentEvent = this.appendEvent({
        kind: 'job.phase-handoff-intent',
        jobId: input.jobId,
        payload: {
          phase_id: phaseId,
          source: input.source,
          generation,
          request_id: requestId,
          decision,
        },
      });
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO phase_handoffs
             (phase_id, job_id, source, request_id, generation, decision, state, intent_seq, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'awaiting', ?, ?, ?)`,
        )
        .run(phaseId, input.jobId, input.source, requestId, generation, decision, intentEvent.seq, ts, ts);
      return { record: this.getPhaseHandoff(phaseId) as PhaseHandoffRecord, created: true };
    });
  }

  getPhaseHandoff(phaseId: string): PhaseHandoffRecord | null {
    const row = this.db.prepare('SELECT * FROM phase_handoffs WHERE phase_id = ?').get(phaseId) as Row | undefined;
    return row === undefined ? null : this.phaseHandoffFromRow(row);
  }

  /** Bounded listing for reconciliation/adoption. `cursor` is the rowid
   * of the previous page's last row (append-only-safe paging). */
  listPhaseHandoffs(
    opts: {
      jobId?: string;
      source?: PhaseHandoffSource;
      states?: readonly PhaseHandoffState[];
      limit?: number;
      cursor?: number;
    } = {},
  ): readonly PhaseHandoffRecord[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 200), 1000);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.jobId !== undefined) {
      where.push('job_id = ?');
      params.push(opts.jobId);
    }
    if (opts.source !== undefined) {
      if (!isPhaseHandoffSource(opts.source)) {
        throw new Error(`listPhaseHandoffs got unknown phase source "${String(opts.source)}"`);
      }
      where.push('source = ?');
      params.push(opts.source);
    }
    if (opts.states !== undefined) {
      if (opts.states.length === 0) throw new Error('listPhaseHandoffs "states" filter must not be empty');
      for (const state of opts.states) {
        if (!isPhaseHandoffState(state)) throw new Error(`listPhaseHandoffs got unknown phase state "${state}"`);
      }
      where.push(`state IN (${opts.states.map(() => '?').join(', ')})`);
      params.push(...opts.states);
    }
    if (opts.cursor !== undefined) {
      where.push('rowid > ?');
      params.push(opts.cursor);
    }
    const sql = `SELECT rowid AS _rowid, * FROM phase_handoffs${
      where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
    } ORDER BY rowid LIMIT ?`;
    return (this.db.prepare(sql).all(...(params as never[]), limit) as Row[]).map((row) => this.phaseHandoffFromRow(row));
  }

  /** The rowid cursor for one phase (pagination anchor). */
  phaseHandoffRowid(phaseId: string): number | null {
    const row = this.db.prepare('SELECT rowid AS _rowid FROM phase_handoffs WHERE phase_id = ?').get(phaseId) as
      | Row
      | undefined;
    return row === undefined ? null : Number(row._rowid);
  }

  /** The newest phase row a directive request authorized, if any. */
  findPhaseHandoffByRequest(input: { jobId: string; requestId: string }): PhaseHandoffRecord | null {
    if (input.requestId.trim() === '') throw new Error('findPhaseHandoffByRequest requires a non-empty requestId');
    const row = this.db
      .prepare('SELECT * FROM phase_handoffs WHERE job_id = ? AND request_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(input.jobId, input.requestId) as Row | undefined;
    return row === undefined ? null : this.phaseHandoffFromRow(row);
  }

  /** Bind the spawned admitted worker to its awaiting phase (dispatch
   * path). Idempotent for the same worker; a different worker is a
   * conflict — a phase has exactly one admitted minion. */
  bindPhaseHandoffMinion(input: { phaseId: string; minionId: string }): PhaseHandoffRecord {
    if (input.minionId.trim() === '') throw new Error('phase handoff binding requires a non-empty minion id');
    return this.transaction(() => {
      const row = this.getPhaseHandoff(input.phaseId);
      if (row === null) throw new RecordNotFound(`phase handoff "${input.phaseId}" not found`);
      if (row.state !== 'awaiting') {
        throw new PhaseHandoffConflictError(`phase handoff "${row.phaseId}" is ${row.state} — it takes no worker binding`);
      }
      if (row.minionId !== null) {
        if (row.minionId !== input.minionId) {
          throw new PhaseHandoffConflictError(
            `phase handoff "${row.phaseId}" is already bound to minion ${row.minionId}, not ${input.minionId}`,
          );
        }
        return row;
      }
      this.db
        .prepare('UPDATE phase_handoffs SET minion_id = ?, updated_at = ? WHERE phase_id = ?')
        .run(input.minionId, nowIso(), row.phaseId);
      return this.getPhaseHandoff(row.phaseId) as PhaseHandoffRecord;
    });
  }

  /** Record the VALIDATED terminal completion. Callers must have checked
   * the correlation/admission gates (dispatch-side observers own that);
   * this primitive only enforces the state machine and the one-completion
   * invariant. A completion at/before the intent watermark is refused —
   * an older receipt can never complete a newer phase. */
  completePhaseHandoff(input: { phaseId: string; completionSeq: number }): PhaseHandoffRecord {
    if (!Number.isSafeInteger(input.completionSeq) || input.completionSeq < 0) {
      throw new Error('phase handoff completion requires a safe non-negative event seq');
    }
    return this.transaction(() => {
      const row = this.getPhaseHandoff(input.phaseId);
      if (row === null) throw new RecordNotFound(`phase handoff "${input.phaseId}" not found`);
      if (row.state === 'closed') {
        throw new PhaseHandoffConflictError(`phase handoff "${row.phaseId}" is closed — a late completion cannot reopen it`);
      }
      if (row.state === 'completed') {
        if (row.completionSeq === input.completionSeq) return row; // idempotent replay
        throw new PhaseHandoffConflictError(
          `phase handoff "${row.phaseId}" already completed at event ${row.completionSeq} — a second receipt cannot rewrite it`,
        );
      }
      if (input.completionSeq <= row.intentSeq) {
        throw new PhaseHandoffConflictError(
          `phase handoff "${row.phaseId}" completion cites event ${input.completionSeq} at/before its intent watermark ${row.intentSeq}`,
        );
      }
      this.db
        .prepare("UPDATE phase_handoffs SET state = 'completed', completion_seq = ?, updated_at = ? WHERE phase_id = ?")
        .run(input.completionSeq, nowIso(), row.phaseId);
      this.appendEvent({
        kind: 'job.phase-handoff-completed',
        jobId: row.jobId,
        payload: { phase_id: row.phaseId, source: row.source, completion_seq: input.completionSeq },
      });
      return this.getPhaseHandoff(row.phaseId) as PhaseHandoffRecord;
    });
  }

  /** Record the owed obligation on the completed phase (idempotent; a
   * different obligation id would fork the debt and is refused). */
  markPhaseHandoffObligation(input: { phaseId: string; obligationId: string }): PhaseHandoffRecord {
    if (input.obligationId.trim() === '') throw new Error('phase handoff obligation id must be non-empty');
    return this.transaction(() => {
      const row = this.getPhaseHandoff(input.phaseId);
      if (row === null) throw new RecordNotFound(`phase handoff "${input.phaseId}" not found`);
      if (row.state !== 'completed') {
        throw new PhaseHandoffConflictError(`phase handoff "${row.phaseId}" is ${row.state} — only a completed phase carries a debt`);
      }
      if (row.obligationId !== null) {
        if (row.obligationId !== input.obligationId) {
          throw new PhaseHandoffConflictError(
            `phase handoff "${row.phaseId}" already names obligation ${row.obligationId}, not ${input.obligationId}`,
          );
        }
        return row;
      }
      this.db
        .prepare('UPDATE phase_handoffs SET obligation_id = ?, updated_at = ? WHERE phase_id = ?')
        .run(input.obligationId, nowIso(), row.phaseId);
      return this.getPhaseHandoff(row.phaseId) as PhaseHandoffRecord;
    });
  }

  /** Record the published action-required row (idempotent; a different id
   * would mean a second card for one phase and is refused). */
  markPhaseHandoffPublished(input: { phaseId: string; notificationId: string }): PhaseHandoffRecord {
    if (input.notificationId.trim() === '') throw new Error('phase handoff notification id must be non-empty');
    return this.transaction(() => {
      const row = this.getPhaseHandoff(input.phaseId);
      if (row === null) throw new RecordNotFound(`phase handoff "${input.phaseId}" not found`);
      if (row.state !== 'completed') {
        throw new PhaseHandoffConflictError(`phase handoff "${row.phaseId}" is ${row.state} — only a completed phase publishes`);
      }
      if (row.notificationId !== null) {
        if (row.notificationId !== input.notificationId) {
          throw new PhaseHandoffConflictError(
            `phase handoff "${row.phaseId}" already published ${row.notificationId}, not ${input.notificationId}`,
          );
        }
        return row;
      }
      this.db
        .prepare('UPDATE phase_handoffs SET notification_id = ?, updated_at = ? WHERE phase_id = ?')
        .run(input.notificationId, nowIso(), row.phaseId);
      return this.getPhaseHandoff(row.phaseId) as PhaseHandoffRecord;
    });
  }

  /** Close an awaiting/completed phase without a hand-back (failure,
   * cancellation, supersession, terminal/parked guard). Idempotent for a
   * closed row; the reason is durable provenance. closed never reopens. */
  closePhaseHandoff(input: { phaseId: string; reason: string }): PhaseHandoffRecord {
    if (input.reason.trim() === '') throw new Error('phase handoff close requires a reason');
    return this.transaction(() => {
      const row = this.getPhaseHandoff(input.phaseId);
      if (row === null) throw new RecordNotFound(`phase handoff "${input.phaseId}" not found`);
      if (row.state === 'closed') return row;
      this.db
        .prepare("UPDATE phase_handoffs SET state = 'closed', close_reason = ?, updated_at = ? WHERE phase_id = ?")
        .run(input.reason, nowIso(), row.phaseId);
      this.appendEvent({
        kind: 'job.phase-handoff-closed',
        jobId: row.jobId,
        payload: { phase_id: row.phaseId, source: row.source, from: row.state, reason: input.reason },
      });
      return this.getPhaseHandoff(row.phaseId) as PhaseHandoffRecord;
    });
  }

  /** Per-job monotonic phase generation (1-based). */
  private nextPhaseHandoffGeneration(jobId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(generation), 0) AS generation FROM phase_handoffs WHERE job_id = ?')
      .get(jobId) as Row | undefined;
    const value = row?.generation;
    return (typeof value === 'number' && Number.isFinite(value) ? value : 0) + 1;
  }

  private phaseHandoffFromRow(row: Row): PhaseHandoffRecord {
    const state = str(row.state);
    if (!isPhaseHandoffState(state)) {
      throw new Error(`phase_handoffs row "${str(row.phase_id)}" has unknown state "${state}"`);
    }
    const source = str(row.source);
    if (!isPhaseHandoffSource(source)) {
      throw new Error(`phase_handoffs row "${str(row.phase_id)}" has unknown source "${source}"`);
    }
    return {
      phaseId: str(row.phase_id),
      jobId: str(row.job_id),
      source,
      requestId: nstr(row.request_id),
      generation: Number(row.generation),
      decision: str(row.decision),
      state,
      intentSeq: Number(row.intent_seq),
      minionId: nstr(row.minion_id),
      completionSeq: row.completion_seq === null || row.completion_seq === undefined ? null : Number(row.completion_seq),
      obligationId: nstr(row.obligation_id),
      notificationId: nstr(row.notification_id),
      closeReason: nstr(row.close_reason),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }

  // ------------------------------------------------------------------
  // Durable directive requests (phase 3 slice): request-scoped
  // intent/claim/admission/receipt/reconciliation. The durable row is the
  // single source of truth; HTTP responses only report it. No prompt/
  // spawn side effect may precede the atomic intent→dispatch claim, and
  // no caller-supplied text can mark a request admitted or delivered —
  // only a correlated ledger event can.
  // ------------------------------------------------------------------

  /** Accept a directive request: persists the atomic intent→dispatch
   * claim BEFORE any side effect (ruling: an intent without admission is
   * NOT proof of no side effect — but an intent with NO claim transition
   * cannot have had one). Returns `created: false` when this call was a
   * durable REPLAY of an existing request: the caller must NOT start
   * another turn — only the creating call ever owns side effects. Same
   * request id + same canonical payload replays to the SAME row; same id
   * + different payload is a conflict. While ANY live request exists for
   * the job, ANY different request id (identified or not) fails CLOSED
   * with the live request named — the lane is single-writer, so a fresh
   * id never starts a second concurrent turn. When the
   * request carries an explicit completion intent (`handoff`), the
   * phase-handoff guard row is persisted in the SAME transaction — before
   * any side effect — and a live REPLAY may attach the intent to the
   * existing request (idempotent by request id); an already-terminal
   * request is never retro-marked. */
  beginDirectiveIntent(input: {
    jobId: string;
    directive: string;
    blockerFingerprint?: string;
    holder: string;
    requestId?: string;
    /** Explicit completion intent; omitted = ordinary directive. */
    handoff?: CompletionHandoffIntent;
  }): { readonly record: DirectiveRequestRecord; readonly created: boolean } {
    if (input.directive.trim() === '') throw new Error('directive text must be non-empty');
    if (input.holder.trim() === '') throw new Error('directive intent requires a non-empty holder');
    const job = this.getJob(input.jobId);
    if (job === null) throw new RecordNotFound(`job "${input.jobId}" not found`);
    if (job.status === 'merged' || job.status === 'done') {
      throw new Error(`job "${input.jobId}" is ${job.status} — terminal lanes take no directives`);
    }
    const payload = JSON.stringify({ directive: input.directive, blocker_fingerprint: input.blockerFingerprint ?? null });
    const payloadHash = createHash('sha256').update(payload).digest('hex');
    return this.transaction(() => {
      if (input.requestId !== undefined) {
        const existing = this.getDirective(input.requestId);
        if (existing !== null) {
          if (existing.payloadHash !== payloadHash) {
            throw new DirectiveConflictError(
              `directive request "${input.requestId}" was accepted with a different payload — ` +
                'a request id identifies one exact request; submit the changed work under a new id',
            );
          }
          if (existing.jobId !== input.jobId) {
            throw new DirectiveConflictError(
              `directive request "${input.requestId}" belongs to job ${existing.jobId}, not ${input.jobId}`,
            );
          }
          if (input.handoff !== undefined && !isDirectiveTerminal(existing.state)) {
            // A live replay may attach (or confirm) the explicit completion
            // intent for THIS request — same request identity, idempotent.
            this.beginPhaseHandoff({
              jobId: input.jobId,
              source: 'silas-directive',
              intent: input.handoff,
              requestId: existing.requestId,
            });
          }
          return { record: existing, created: false }; // durable replay — the accepted request, unchanged
        }
      }
      // Fail CLOSED while ANY live request for the job exists: the lane is
      // single-writer, so a DIFFERENT request id must never start a second
      // concurrent turn (never reopen the PR133 window with a fresh id).
      // A replay of the live request itself already returned above; the
      // refusal always NAMES the live request so the caller can retry with
      // the same id, wait, or reconcile. Query the LIVE states directly
      // (a bounded page ordered by request_id cannot be the live set: the
      // table is append-only, so terminal rows would crowd live ones past
      // the page forever).
      const live = this.listPendingDirectives({
        jobId: input.jobId,
        states: LIVE_DIRECTIVE_STATES,
        limit: 1,
      })[0];
      if (live !== undefined) {
        throw new AmbiguousDirectiveError(
          `a directive for job "${input.jobId}" is already live (request ${live.requestId}, state ${live.state}) — ` +
            'retry with that SAME request_id, wait for it to settle, or reconcile it first; ' +
            'a different request id never starts a second concurrent turn on the lane',
        );
      }
      const requestId = input.requestId ?? randomUUID();
      const ts = nowIso();
      this.db
        .prepare(
          `INSERT INTO pending_directives
             (request_id, job_id, payload, payload_hash, state, baseline_seq, claim, attempts, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'dispatching', ?, ?, 0, ?, ?)`,
        )
        .run(
          requestId,
          input.jobId,
          payload,
          payloadHash,
          this.latestEventSeq(),
          JSON.stringify({ holder: input.holder, since: ts }),
          ts,
          ts,
        );
      this.appendEvent({
        kind: 'silas.directive-intent',
        jobId: input.jobId,
        payload: { request_id: requestId, holder: input.holder, directive_bytes: Buffer.byteLength(input.directive, 'utf-8') },
      });
      if (input.handoff !== undefined) {
        this.beginPhaseHandoff({
          jobId: input.jobId,
          source: 'silas-directive',
          intent: input.handoff,
          requestId,
        });
      }
      return { record: this.getDirective(requestId) as DirectiveRequestRecord, created: true };
    });
  }

  getDirective(requestId: string): DirectiveRequestRecord | null {
    const row = this.db.prepare('SELECT * FROM pending_directives WHERE request_id = ?').get(requestId) as Row | undefined;
    return row === undefined ? null : this.directiveFromRow(row);
  }

  listPendingDirectives(
    opts: {
      jobId?: string;
      state?: DirectiveState;
      states?: readonly DirectiveState[];
      limit?: number;
      cursor?: string;
    } = {},
  ): readonly DirectiveRequestRecord[] {
    if (opts.state !== undefined && opts.states !== undefined) {
      throw new Error('listPendingDirectives takes either "state" or "states", never both');
    }
    const limit = Math.min(Math.max(1, opts.limit ?? 200), 1000);
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.jobId !== undefined) {
      where.push('job_id = ?');
      params.push(opts.jobId);
    }
    if (opts.state !== undefined) {
      where.push('state = ?');
      params.push(opts.state);
    } else if (opts.states !== undefined) {
      if (opts.states.length === 0) {
        throw new Error('listPendingDirectives "states" filter must not be empty');
      }
      for (const state of opts.states) {
        if (!isDirectiveState(state)) throw new Error(`listPendingDirectives got unknown directive state "${state}"`);
      }
      where.push(`state IN (${opts.states.map(() => '?').join(', ')})`);
      params.push(...opts.states);
    }
    if (opts.cursor !== undefined) {
      where.push('request_id > ?');
      params.push(opts.cursor);
    }
    const sql = `SELECT * FROM pending_directives${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY request_id LIMIT ?`;
    return (this.db.prepare(sql).all(...(params as never[]), limit) as Row[]).map((row) => this.directiveFromRow(row));
  }

  /** Bind a request to its ACTUAL native admission: the correlated
   * `silas.directive-sent` event must exist, carry this request id, sit
   * on this job and postdate the acceptance watermark. Adapter spawn
   * returns, board idle and HTTP 200 prove nothing. */
  recordDirectiveAdmission(input: { requestId: string; minionId: string; eventSeq: number }): DirectiveRequestRecord {
    if (input.minionId.trim() === '') throw new Error('directive admission requires a non-empty minion id');
    return this.transaction(() => {
      const row = this.getDirective(input.requestId);
      if (row === null) throw new RecordNotFound(`directive request "${input.requestId}" not found`);
      if (row.state === 'admitted' && row.admissionSeq === input.eventSeq) return row; // idempotent replay
      if (row.state !== 'dispatching') {
        throw new Error(`directive request "${input.requestId}" is ${row.state} — admission evidence cannot bind here`);
      }
      const event = this.getEvent(input.eventSeq);
      if (event === null) throw new Error(`admission for "${input.requestId}" cites event seq ${input.eventSeq} which does not exist`);
      if (event.kind !== 'silas.directive-sent') {
        throw new Error(`admission for "${input.requestId}" must cite a silas.directive-sent event, got "${event.kind}"`);
      }
      if (event.jobId !== row.jobId) {
        throw new Error(`admission for "${input.requestId}" cites event ${input.eventSeq} of job ${String(event.jobId)} — wrong job`);
      }
      if (event.seq <= row.baselineSeq) {
        throw new Error(`admission for "${input.requestId}" cites event ${input.eventSeq} at/before the acceptance watermark ${row.baselineSeq}`);
      }
      const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
      if (payload['request_id'] !== input.requestId) {
        throw new Error(`admission for "${input.requestId}" cites an event whose payload is not correlated to this request`);
      }
      this.db
        .prepare("UPDATE pending_directives SET state = 'admitted', admission_seq = ?, admission_minion = ?, updated_at = ? WHERE request_id = ?")
        .run(input.eventSeq, input.minionId, nowIso(), input.requestId);
      return this.getDirective(input.requestId) as DirectiveRequestRecord;
    });
  }

  /** Record the request's terminal receipt: the correlated `job.delivered`
   * event must exist, carry this request id, belong to the job and
   * postdate admission. A delivery for another phase/request can never
   * settle this one. */
  recordDirectiveDelivery(input: { requestId: string; eventSeq: number }): DirectiveRequestRecord {
    return this.transaction(() => {
      const row = this.getDirective(input.requestId);
      if (row === null) throw new RecordNotFound(`directive request "${input.requestId}" not found`);
      if (row.state === 'settled' && row.deliverySeq === input.eventSeq) return row; // idempotent replay
      if (row.state !== 'admitted') {
        throw new Error(`directive request "${input.requestId}" is ${row.state} — terminal delivery requires admitted state`);
      }
      const event = this.getEvent(input.eventSeq);
      if (event === null) throw new Error(`delivery for "${input.requestId}" cites event seq ${input.eventSeq} which does not exist`);
      if (event.kind !== 'job.delivered') {
        throw new Error(`delivery for "${input.requestId}" must cite a job.delivered event, got "${event.kind}"`);
      }
      if (event.jobId !== row.jobId) {
        throw new Error(`delivery for "${input.requestId}" cites event ${input.eventSeq} of job ${String(event.jobId)} — wrong job`);
      }
      if (row.admissionSeq !== null && event.seq <= row.admissionSeq) {
        throw new Error(`delivery for "${input.requestId}" cites event ${input.eventSeq} at/before admission ${row.admissionSeq}`);
      }
      const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
      if (payload['request_id'] !== input.requestId) {
        throw new Error(`delivery for "${input.requestId}" cites an event whose payload is not correlated to this request`);
      }
      this.db
        .prepare("UPDATE pending_directives SET state = 'settled', delivery_seq = ?, updated_at = ? WHERE request_id = ?")
        .run(input.eventSeq, nowIso(), input.requestId);
      return this.getDirective(input.requestId) as DirectiveRequestRecord;
    });
  }

  /** Record a DURABLE failure for a request (positive failure evidence:
   * the router returned an explicit no-delivery proof, or a late turn
   * error surfaced). Never used for "no receipt yet" — that stays
   * dispatching/admitted for reconciliation, visibly, with attempts
   * counted. */
  failDirective(input: { requestId: string; reason: string }): DirectiveRequestRecord {
    if (input.reason.trim() === '') throw new Error('directive failure requires a reason');
    return this.transaction(() => {
      const row = this.getDirective(input.requestId);
      if (row === null) throw new RecordNotFound(`directive request "${input.requestId}" not found`);
      if (row.state === 'settled') {
        throw new Error(`directive request "${input.requestId}" already settled — a late failure cannot rewrite it`);
      }
      if (row.state === 'failed') return row;
      this.db
        .prepare("UPDATE pending_directives SET state = 'failed', fail_reason = ?, attempts = attempts + 1, updated_at = ? WHERE request_id = ?")
        .run(input.reason, nowIso(), input.requestId);
      this.appendEvent({
        kind: 'silas.directive-failed',
        jobId: row.jobId,
        payload: { request_id: input.requestId, reason: input.reason },
      });
      return this.getDirective(input.requestId) as DirectiveRequestRecord;
    });
  }

  /** Bump a request's attempt counter without changing state (durable
   * reconcile passes are bounded and visible; "unknown" never silently
   * becomes "retried"). */
  recordDirectiveReconcile(input: { requestId: string; note: string }): DirectiveRequestRecord {
    return this.transaction(() => {
      const row = this.getDirective(input.requestId);
      if (row === null) throw new RecordNotFound(`directive request "${input.requestId}" not found`);
      if (row.state === 'settled' || row.state === 'failed') return row;
      this.db
        .prepare('UPDATE pending_directives SET attempts = attempts + 1, fail_reason = ?, updated_at = ? WHERE request_id = ?')
        .run(`reconcile: ${input.note}`, nowIso(), input.requestId);
      return this.getDirective(input.requestId) as DirectiveRequestRecord;
    });
  }

  private directiveFromRow(row: Row): DirectiveRequestRecord {
    const state = str(row.state);
    if (!isDirectiveState(state)) throw new Error(`pending_directives row "${str(row.request_id)}" has unknown state "${state}"`);
    let claim: { holder: string; since: string } | null = null;
    if (row.claim !== null && row.claim !== undefined) {
      const parsed = JSON.parse(str(row.claim)) as Record<string, unknown>;
      const holder = parsed['holder'];
      const since = parsed['since'];
      if (typeof holder !== 'string' || holder === '' || typeof since !== 'string' || since === '') {
        throw new Error(`pending_directives row "${str(row.request_id)}" has a malformed claim`);
      }
      claim = { holder, since };
    }
    return {
      requestId: str(row.request_id),
      jobId: str(row.job_id),
      payload: str(row.payload),
      payloadHash: str(row.payload_hash),
      state,
      baselineSeq: Number(row.baseline_seq),
      claim,
      admissionSeq: row.admission_seq === null || row.admission_seq === undefined ? null : Number(row.admission_seq),
      admissionMinion: nstr(row.admission_minion),
      deliverySeq: row.delivery_seq === null || row.delivery_seq === undefined ? null : Number(row.delivery_seq),
      attempts: Number(row.attempts),
      failReason: nstr(row.fail_reason),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
  }

  private pendingRebriefFromRow(row: Row): PendingRebriefRecord {
    const kind = str(row.kind);
    if (!isPendingRebriefKind(kind)) {
      throw new Error(`pending_rebriefs row has unknown kind "${kind}"`);
    }
    let payload: { note?: unknown; briefing?: unknown };
    try {
      payload = JSON.parse(str(row.payload)) as { note?: unknown; briefing?: unknown };
    } catch (error) {
      throw new Error(`pending_rebriefs row ${str(row.id)} payload is not valid JSON: ${String(error)}`);
    }
    return {
      id: str(row.id),
      jobId: str(row.job_id),
      kind,
      note: nstr(payload.note),
      briefing: nstr(payload.briefing),
      payloadHash: str(row.payload_hash),
      baselineSeq: Number(row.baseline_seq),
      agentId: nstr(row.agent_id),
      sessionFile: nstr(row.session_file),
      phaseId: nstr(row.phase_id),
      requestedAt: str(row.requested_at),
    };
  }

  private notificationFromRow(row: Row): NotificationRecord {
    return {
      id: str(row.id),
      ts: str(row.ts),
      kind: str(row.kind),
      routing: str(row.routing) as NotificationRouting,
      severity: str(row.severity) as NotificationSeverity,
      title: str(row.title),
      detail: nstr(row.detail),
      agentId: nstr(row.agent_id),
      shownAt: nstr(row.shown_at),
      shownBy: nstr(row.shown_by),
      ackedAt: nstr(row.acked_at),
      ackedBy: nstr(row.acked_by),
      resolvedAt: nstr(row.resolved_at),
      resolvedBy: nstr(row.resolved_by),
    };
  }
}
