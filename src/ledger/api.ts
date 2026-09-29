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
  categoryKey,
  parseAuthority,
  parseCategory,
  parseClaim,
  parseNextAction,
  parseReceipts,
  parseSettlement,
  parseWakeCondition,
  resolveObligation,
  type BlockerContext,
  type ObligationAuthority,
  type ObligationCategory,
  type ObligationClaim,
  type ObligationNextAction,
  type ObligationSettlement,
  type ObligationWakeCondition,
  type RecordedReceipt,
} from './obligations.js';

export type { JobStatus, RoundStatus, RoundVerdict, LensState } from './states.js';

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
  readonly state: ObligationState;
  readonly settlement: ObligationSettlement | null;
  readonly dueAt: string | null;
  readonly receiptKind: string | null;
  readonly deadlineAt: string | null;
  readonly recordedReceipts: readonly RecordedReceipt[];
  readonly observations: number;
  readonly firstOriginSeq: number;
  readonly lastOriginSeq: number;
  readonly supersededBy: string | null;
  readonly claim: ObligationClaim | null;
  readonly claimHistory: number;
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

export interface WorktreeRecord {
  /** The owning job id (kind 'job') or round id (kind 'review'). */
  readonly id: string;
  readonly kind: WorktreeKind;
  readonly repoPath: string;
  readonly repoName: string;
  readonly path: string;
  readonly branch: string | null;
  readonly sha: string;
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
    jobId?: string | null;
    roundId?: string | null;
  }): WorktreeRecord {
    if (input.id === '' || input.path === '' || input.repoPath === '' || input.sha === '') {
      throw new Error('worktree id, path, repo path, and sha must be non-empty');
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
          `INSERT INTO worktrees (id, kind, repo_path, repo_name, path, branch, sha, job_id, round_id, status, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
        )
        .run(
          input.id,
          input.kind,
          input.repoPath,
          input.repoName,
          input.path,
          input.branch ?? null,
          input.sha,
          input.jobId ?? null,
          input.roundId ?? null,
          ts,
          ts,
        );
      this.appendEvent({
        kind: 'worktree.created',
        jobId: input.jobId ?? null,
        roundId: input.roundId ?? null,
        payload: { id: input.id, kind: input.kind, path: input.path, branch: input.branch ?? null, sha: input.sha },
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
   * is the one the current worker runs. */
  beginPendingRebrief(input: {
    jobId: string;
    note: string | null;
    briefing: string | null;
  }): readonly PendingRebriefRecord[] {
    if (this.getJob(input.jobId) === null) {
      throw new RecordNotFound(`job "${input.jobId}" not found — a re-brief marker belongs to a real job`);
    }
    const payload = JSON.stringify({ note: input.note, briefing: input.briefing });
    const payloadHash = createHash('sha256').update(payload).digest('hex');
    const baselineSeq = this.latestEventSeq();
    const ts = nowIso();
    return this.transaction(() => {
      const upsert = this.db.prepare(
        `INSERT INTO pending_rebriefs
           (id, job_id, kind, payload, payload_hash, baseline_seq, agent_id, session_file, requested_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
         ON CONFLICT (job_id, kind) DO UPDATE SET
           id = excluded.id,
           payload = excluded.payload,
           payload_hash = excluded.payload_hash,
           baseline_seq = excluded.baseline_seq,
           agent_id = NULL,
           session_file = NULL,
           requested_at = excluded.requested_at,
           updated_at = excluded.updated_at`,
      );
      for (const kind of PENDING_REBRIEF_KINDS) {
        upsert.run(randomUUID(), input.jobId, kind, payload, payloadHash, baselineSeq, ts, ts);
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
      jobId: nstr(row.job_id),
      roundId: nstr(row.round_id),
      status: str(row.status) as WorktreeStatus,
      note: nstr(row.note),
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
    };
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

  listObligations(opts: { jobId?: string; state?: ObligationState } = {}): readonly ObligationRecord[] {
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
    const sql = `SELECT * FROM job_obligations${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid`;
    return (this.db.prepare(sql).all(...(params as never[])) as Row[]).map((row) => this.obligationFromRow(row));
  }

  /** Take a request/generation-fenced claim on an obligation's next
   * action. Records the fence; NEVER authorizes executing work by itself,
   * and lease expiry alone never licenses a replacement holder. */
  claimObligation(input: {
    obligationId: string;
    requestId: string;
    holder: string;
    expiresAt: string;
    expectedGeneration: number;
  }): ObligationRecord {
    if (input.requestId.trim() === '') throw new Error('claim requires a non-empty requestId');
    if (input.holder.trim() === '') throw new Error('claim requires a non-empty holder');
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
      const now = nowIso();
      if (row.claim !== null && row.claim.requestId !== input.requestId && row.claim.expiresAt > now) {
        throw new ClaimHeldError(
          `obligation "${row.id}" is held by request ${row.claim.requestId} (${row.claim.holder}) until ${row.claim.expiresAt}`,
        );
      }
      const replaced = row.claim !== null && row.claim.requestId !== input.requestId;
      this.db
        .prepare(
          'UPDATE job_obligations SET claim = ?, claim_history = claim_history + ?, updated_at = ? WHERE id = ?',
        )
        .run(
          JSON.stringify({
            requestId: input.requestId,
            holder: input.holder,
            generation: row.generation,
            expiresAt: input.expiresAt,
          }),
          replaced ? 1 : 0,
          now,
          row.id,
        );
      this.appendEvent({
        kind: 'job.obligation-claimed',
        jobId: row.jobId,
        payload: { id: row.id, requestId: input.requestId, holder: input.holder, expiresAt: input.expiresAt, replacedExpired: replaced },
      });
      return this.getObligation(row.id) as ObligationRecord;
    });
  }

  /** Release a claim; only the owning request may release it. */
  releaseClaim(input: { obligationId: string; requestId: string }): ObligationRecord {
    return this.transaction(() => {
      const row = this.getObligation(input.obligationId);
      if (row === null) throw new RecordNotFound(`obligation "${input.obligationId}" not found`);
      if (row.claim === null) throw new Error(`obligation "${row.id}" has no claim to release`);
      if (row.claim.requestId !== input.requestId) {
        throw new ClaimHeldError(`obligation "${row.id}" is held by request ${row.claim.requestId}, not ${input.requestId}`);
      }
      this.db
        .prepare('UPDATE job_obligations SET claim = NULL, updated_at = ? WHERE id = ?')
        .run(nowIso(), row.id);
      this.appendEvent({
        kind: 'job.obligation-claim-released',
        jobId: row.jobId,
        payload: { id: row.id, requestId: input.requestId },
      });
      return this.getObligation(row.id) as ObligationRecord;
    });
  }

  /** Record receipt evidence for an obligation. IDEMPOTENT per
   * (kind, eventSeq). A receipt postdating the obligation's watermark may
   * hand a waiting obligation back to open (the decision returns); a
   * receipt NEVER settles — accepted gates require an explicit, validated
   * settlement. A stale (older) receipt is kept as evidence only. */
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
      const applied = input.eventSeq > row.lastOriginSeq;
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
        payload: { id: row.id, receipt_kind: input.kind, event_seq: input.eventSeq, applied, from: row.state, to: state },
      });
      return this.getObligation(row.id) as ObligationRecord;
    });
  }

  /** Settle or close an obligation with a validated, discriminated
   * settlement. Evidence kinds settle; supersession/cancellation/
   * job-terminal close. History is preserved (the row and its events
   * stay); settled/closed are terminal — a recurring incident is a NEW
   * obligation. */
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
      // Evidence settlements are claim-fenced (the owning request proves
      // its continuation). Administrative closes (superseded/cancelled/
      // job-terminal) are durable truth from the job machine itself — they
      // clear any claim rather than being vetoed by it, and the cleared
      // claim stays in claim_history/events for the record.
      if (
        row.claim !== null &&
        row.claim.requestId !== input.requestId &&
        (input.settlement.kind === 'executed-action' || input.settlement.kind === 'accepted-evidence')
      ) {
        throw new ClaimHeldError(
          `obligation "${row.id}" is held by request ${row.claim.requestId} — settle through the owning request or release it first`,
        );
      }
      this.db
        .prepare(
          'UPDATE job_obligations SET state = ?, settlement = ?, claim = NULL, updated_at = ? WHERE id = ?',
        )
        .run(target, JSON.stringify(input.settlement), nowIso(), row.id);
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
   * deadline. Pure state — arming does NOT spawn, notify or execute
   * anything; the phase-3 delegation hook calls this when it actually
   * hands work over, so "waiting" is always backed by durable intent. */
  armReceiptExpectation(input: {
    obligationId: string;
    receiptKind: string;
    deadlineAt: string;
    requestId?: string;
    reason?: string;
  }): ObligationRecord {
    if (input.receiptKind.trim() === '') throw new Error('arming requires a non-empty receiptKind');
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
          `UPDATE job_obligations SET state = 'waiting', receipt_kind = ?, deadline_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(input.receiptKind, input.deadlineAt, nowIso(), row.id);
      this.appendEvent({
        kind: 'job.obligation-state',
        jobId: row.jobId,
        payload: {
          id: row.id,
          from: row.state,
          to: 'waiting',
          receipt_kind: input.receiptKind,
          deadline_at: input.deadlineAt,
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

  /** Close obligations whose continuations were fenced off by newer
   * durable truth (head moved, completion, cancellation, revised ruling,
   * owner hold). Acts ONLY on applicable rows (open/waiting, at or before
   * the watermark); terminal rows and their history are untouched. */
  invalidateStaleContinuations(input: {
    jobId: string;
    newerThanSeq: number;
    reason: string;
  }): readonly ObligationRecord[] {
    return this.transaction(() => {
      if (this.getJob(input.jobId) === null) throw new RecordNotFound(`job "${input.jobId}" not found`);
      const applicable = this.listObligations({ jobId: input.jobId }).filter(
        (row) => (row.state === 'open' || row.state === 'waiting') && row.lastOriginSeq <= input.newerThanSeq,
      );
      const settled: ObligationRecord[] = [];
      for (const row of applicable) {
        settled.push(
          this.settleObligation({
            obligationId: row.id,
            settlement: { kind: 'superseded', byObligationId: null, reason: input.reason },
          }),
        );
      }
      return settled;
    });
  }

  // -- obligation internals (all inside a transaction) ----------------

  /** Apply one typed blocked observation: create a new incident (new
   * generation) or coalesce a duplicate (no generation advance, stable
   * identity, latest plan wins). A terminal row for the same incident is
   * history: the recurrence mints a new incarnation id (#n suffix). */
  private applyBlockedObservation(jobId: string, context: BlockerContext): ObligationRecord {
    const resolved = resolveObligation(context, jobId);
    const existing = this.getObligation(resolved.id);
    const now = nowIso();
    if (existing === null) {
      const id = this.nextIncarnationId(resolved.id);
      const generation = this.currentJobGeneration(jobId) + 1;
      this.db
        .prepare(
          `INSERT INTO job_obligations
             (id, job_id, logical_step, incident_key, generation, category, next_action, wake_condition,
              authority, firing_rule, state, due_at, receipt_kind, deadline_at, recorded_receipts,
              observations, first_origin_seq, last_origin_seq, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, '[]', 1, ?, ?, ?, ?)`,
        )
        .run(
          id,
          jobId,
          resolved.logicalStep,
          resolved.incidentKey,
          generation,
          JSON.stringify(resolved.category),
          JSON.stringify(resolved.nextAction),
          JSON.stringify(resolved.wakeCondition),
          resolved.authority === null ? null : JSON.stringify(resolved.authority),
          resolved.firingRule,
          resolved.dueAt,
          resolved.receiptKind,
          resolved.deadlineAt,
          context.observedAtSeq,
          context.observedAtSeq,
          now,
          now,
        );
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
        },
      });
      return this.getObligation(id) as ObligationRecord;
    }
    if (existing.state === 'settled' || existing.state === 'closed') {
      // Same incident recurring after settlement: history stays, a new
      // incarnation opens at a fresh generation.
      const id = this.nextIncarnationId(existing.id);
      const generation = this.currentJobGeneration(jobId) + 1;
      this.db
        .prepare(
          `INSERT INTO job_obligations
             (id, job_id, logical_step, incident_key, generation, category, next_action, wake_condition,
              authority, firing_rule, state, due_at, receipt_kind, deadline_at, recorded_receipts,
              observations, first_origin_seq, last_origin_seq, superseded_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, '[]', 1, ?, ?, NULL, ?, ?)`,
        )
        .run(
          id,
          jobId,
          resolved.logicalStep,
          resolved.incidentKey,
          generation,
          JSON.stringify(resolved.category),
          JSON.stringify(resolved.nextAction),
          JSON.stringify(resolved.wakeCondition),
          resolved.authority === null ? null : JSON.stringify(resolved.authority),
          resolved.firingRule,
          resolved.dueAt,
          resolved.receiptKind,
          resolved.deadlineAt,
          context.observedAtSeq,
          context.observedAtSeq,
          now,
          now,
        );
      this.db
        .prepare('UPDATE job_obligations SET superseded_by = ?, updated_at = ? WHERE id = ?')
        .run(id, now, existing.id);
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
          recurrence_of: existing.id,
        },
      });
      return this.getObligation(id) as ObligationRecord;
    }
    // Duplicate observation of a live incident: coalesce. Identity,
    // generation and history stay; the latest plan and watermark win.
    const changed: string[] = [];
    const nextPlanChanged =
      JSON.stringify(existing.nextAction) !== JSON.stringify(resolved.nextAction) ||
      JSON.stringify(existing.wakeCondition) !== JSON.stringify(resolved.wakeCondition) ||
      JSON.stringify(existing.authority) !== JSON.stringify(resolved.authority);
    if (nextPlanChanged) changed.push('plan');
    if (existing.dueAt !== resolved.dueAt || existing.deadlineAt !== resolved.deadlineAt) changed.push('bounds');
    this.db
      .prepare(
        `UPDATE job_obligations
           SET observations = observations + 1,
               last_origin_seq = MAX(last_origin_seq, ?),
               next_action = ?, wake_condition = ?, authority = ?, firing_rule = ?,
               due_at = COALESCE(?, due_at), receipt_kind = COALESCE(?, receipt_kind),
               deadline_at = COALESCE(?, deadline_at),
               updated_at = ?
         WHERE id = ?`,
      )
      .run(
        context.observedAtSeq,
        JSON.stringify(resolved.nextAction),
        JSON.stringify(resolved.wakeCondition),
        resolved.authority === null ? null : JSON.stringify(resolved.authority),
        resolved.firingRule,
        resolved.dueAt,
        resolved.receiptKind,
        resolved.deadlineAt,
        now,
        existing.id,
      );
    this.appendEvent({
      kind: 'job.obligation-updated',
      jobId,
      payload: {
        id: existing.id,
        observations: existing.observations + 1,
        last_origin_seq: Math.max(existing.lastOriginSeq, context.observedAtSeq),
        changed,
      },
    });
    return this.getObligation(existing.id) as ObligationRecord;
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
    for (const row of this.listObligations({ jobId })) {
      if (row.state === 'open' || row.state === 'waiting') {
        this.suspendObligation(row.id, reason);
      }
    }
  }

  /** Close the job's applicable obligations (open/waiting/suspended) on a
   * terminal transition — settled rows and history stay untouched. */
  private closeApplicableObligations(jobId: string, terminal: 'done' | 'merged'): void {
    for (const row of this.listObligations({ jobId })) {
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
      firstOriginSeq: Number(row.first_origin_seq),
      lastOriginSeq: Number(row.last_origin_seq),
      supersededBy: nstr(row.superseded_by),
      claim: parseClaim(row.claim === null || row.claim === undefined ? null : str(row.claim)),
      claimHistory: Number(row.claim_history),
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
