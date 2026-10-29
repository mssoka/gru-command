import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { LiveDirectiveState } from './directives.js';

/**
 * Owner approvals (#523) — durable record vocabulary and persistence.
 *
 * Gru proposes, the owner's Approve on the proposal's FOR YOU card makes the
 * server carry out one owner-reserved action. This module owns the
 * `owner_approvals` row (one per proposal); the transitions are `LedgerApi`
 * transactions, each appending one `owner-approval.<state>` event, and
 * `createOwnerApprovalService` (dispatch) drives them.
 *
 * `proposed` = the card is owed or waiting for the owner. `approved` = the
 * owner said yes and the fences are not yet re-read. `executing` = the
 * action is being carried out (a crash leaves it here: reconcile finishes
 * it, never twice). `succeeded`, `denied`, `refused` and `withdrawn` are
 * terminal.
 */

/** The one action an owner approval carries out today. */
export const OWNER_APPROVAL_KINDS = ['directive-abandon'] as const;
export type OwnerApprovalKind = (typeof OWNER_APPROVAL_KINDS)[number];

/** The FOR YOU card kind of each approval kind. */
export const OWNER_APPROVAL_CARD_KIND: Readonly<Record<OwnerApprovalKind, string>> = {
  'directive-abandon': 'owner-approval.directive-abandon',
};

export const OWNER_APPROVAL_STATES = ['proposed', 'approved', 'executing', 'succeeded', 'denied', 'refused', 'withdrawn'] as const;
export type OwnerApprovalState = (typeof OWNER_APPROVAL_STATES)[number];

export const OWNER_APPROVAL_TERMINAL_STATES: readonly OwnerApprovalState[] = ['succeeded', 'denied', 'refused', 'withdrawn'];
export const OWNER_APPROVAL_ACTIVE_STATES: readonly OwnerApprovalState[] = ['proposed', 'approved', 'executing'];

/** The two state sets as SQL predicates (`?` per state, bound in order), so a
 * new state can never be forgotten by one hand-written list. */
const stateIn = (states: readonly OwnerApprovalState[]): string => `state IN (${states.map(() => '?').join(', ')})`;

/** Attempts at carrying the action out (counting the first) before the record
 * is refused as `execution-error`. */
export const OWNER_APPROVAL_MAX_ATTEMPTS = 3;

/** The longest reason a proposal may carry. */
export const OWNER_APPROVAL_REASON_MAX_CHARS = 500;

/** The refusal codes the service itself gives; a ledger refusal keeps its own
 * code (`DIRECTIVE_RETIREMENT_REFUSAL_CODES`). */
export const OWNER_APPROVAL_REFUSAL_CODES = [
  'card-post-failed',
  'decider-not-owner',
  'abandoned-elsewhere',
  'stale-fence',
  'execution-error',
] as const;
export type OwnerApprovalRefusalCode = (typeof OWNER_APPROVAL_REFUSAL_CODES)[number];

/** Why a record was refused: a code and the blockers behind it (possibly none). */
export interface OwnerApprovalRefusal {
  readonly code: string;
  readonly blockers: readonly string[];
}

/** The facts the owner's Approve is bound to, read when the proposal was made. */
export interface OwnerApprovalFences {
  readonly jobId: string;
  readonly state: LiveDirectiveState;
  readonly payloadHash: string;
  /** The request's recovery-debt generation, or null when it owes none. */
  readonly debtGeneration: number | null;
}

export interface OwnerApprovalRecord {
  readonly id: string;
  readonly kind: OwnerApprovalKind;
  readonly requestId: string;
  readonly jobId: string;
  readonly state: OwnerApprovalState;
  readonly attempts: number;
  readonly fences: OwnerApprovalFences;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly bodyFingerprint: string;
  readonly notificationId: string;
  /** The seq of this record's `owner-approval.executing` event. */
  readonly executingSeq: number | null;
  /** The seq of the `silas.directive-abandoned` event of a succeeded record. */
  readonly abandonmentEventSeq: number | null;
  readonly refusal: OwnerApprovalRefusal | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OwnerApprovalHistoryEntry {
  readonly state: string;
  readonly at: string;
  readonly detail: string | null;
}

/** What `proposeOwnerApproval` answered. */
export type OwnerApprovalProposal =
  | { readonly kind: 'created'; readonly approval: OwnerApprovalRecord }
  | { readonly kind: 'replayed'; readonly approval: OwnerApprovalRecord }
  | { readonly kind: 'key_conflict'; readonly approval: OwnerApprovalRecord }
  | { readonly kind: 'unknown_request' }
  | { readonly kind: 'not_live'; readonly state: string }
  | { readonly kind: 'pending'; readonly approval: OwnerApprovalRecord };

/** How a record ends. */
export type OwnerApprovalOutcome =
  | { readonly state: 'succeeded'; readonly abandonmentEventSeq: number; readonly detail: string }
  | { readonly state: 'denied'; readonly detail: string }
  | { readonly state: 'withdrawn'; readonly detail: string }
  | { readonly state: 'refused'; readonly refusal: OwnerApprovalRefusal; readonly detail: string };

/** The states each ending may be written from. */
export const OWNER_APPROVAL_ENDINGS: Readonly<Record<OwnerApprovalOutcome['state'], readonly OwnerApprovalState[]>> = {
  succeeded: ['executing'],
  denied: ['proposed'],
  withdrawn: ['proposed'],
  refused: ['proposed', 'approved', 'executing'],
};

/** The event kind that records a state change of an approval. */
export const ownerApprovalEventKind = (state: OwnerApprovalState | 'attempt-failed'): string => `owner-approval.${state}`;

/** sha256 over the proposal body (kind, request, reason; `by` is always gru):
 * a repeat of an idempotency key with the same body is the same proposal. */
export function ownerApprovalFingerprint(kind: OwnerApprovalKind, requestId: string, reason: string): string {
  return createHash('sha256').update(JSON.stringify([kind, requestId, reason, 'gru'])).digest('hex');
}

type Row = Record<string, unknown>;

function isState(value: unknown): value is OwnerApprovalState {
  return typeof value === 'string' && (OWNER_APPROVAL_STATES as readonly string[]).includes(value);
}

function isKind(value: unknown): value is OwnerApprovalKind {
  return typeof value === 'string' && (OWNER_APPROVAL_KINDS as readonly string[]).includes(value);
}

function parseBlockers(raw: unknown): readonly string[] {
  const parsed: unknown = JSON.parse(String(raw ?? '[]'));
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== 'string')) {
    throw new Error('owner_approvals.refusal_blockers is not a JSON array of strings');
  }
  return parsed as readonly string[];
}

export function ownerApprovalFromRow(row: Row): OwnerApprovalRecord {
  if (!isState(row['state'])) throw new Error(`owner_approvals row has unknown state "${String(row['state'])}"`);
  if (!isKind(row['kind'])) throw new Error(`owner_approvals row has unknown kind "${String(row['kind'])}"`);
  const code = row['refusal_code'];
  const nullableNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
  return {
    id: String(row['id']),
    kind: row['kind'],
    requestId: String(row['request_id']),
    jobId: String(row['job_id']),
    state: row['state'],
    attempts: Number(row['attempts']),
    fences: {
      jobId: String(row['job_id']),
      state: String(row['fence_state']) as LiveDirectiveState,
      payloadHash: String(row['fence_payload_hash']),
      debtGeneration: nullableNumber(row['fence_debt_generation']),
    },
    reason: String(row['reason']),
    idempotencyKey: String(row['idempotency_key']),
    bodyFingerprint: String(row['body_fingerprint']),
    notificationId: String(row['notification_id']),
    executingSeq: nullableNumber(row['executing_seq']),
    abandonmentEventSeq: nullableNumber(row['abandonment_event_seq']),
    refusal: code === null || code === undefined ? null : { code: String(code), blockers: parseBlockers(row['refusal_blockers']) },
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

export function selectOwnerApproval(db: DatabaseSync, id: string): OwnerApprovalRecord | null {
  const row = db.prepare('SELECT * FROM owner_approvals WHERE id = ?').get(id) as Row | undefined;
  return row === undefined ? null : ownerApprovalFromRow(row);
}

export function selectOwnerApprovalByKey(db: DatabaseSync, idempotencyKey: string): OwnerApprovalRecord | null {
  const row = db.prepare('SELECT * FROM owner_approvals WHERE idempotency_key = ?').get(idempotencyKey) as Row | undefined;
  return row === undefined ? null : ownerApprovalFromRow(row);
}

export function selectOwnerApprovalByNotification(db: DatabaseSync, notificationId: string): OwnerApprovalRecord | null {
  const row = db.prepare('SELECT * FROM owner_approvals WHERE notification_id = ?').get(notificationId) as Row | undefined;
  return row === undefined ? null : ownerApprovalFromRow(row);
}

/** The one `proposed`, `approved` or `executing` record of a request (the
 * partial unique index allows at most one). */
export function selectActiveOwnerApprovalForRequest(db: DatabaseSync, requestId: string): OwnerApprovalRecord | null {
  const row = db.prepare(`SELECT * FROM owner_approvals WHERE request_id = ? AND ${stateIn(OWNER_APPROVAL_ACTIVE_STATES)}`)
    .get(requestId, ...OWNER_APPROVAL_ACTIVE_STATES) as Row | undefined;
  return row === undefined ? null : ownerApprovalFromRow(row);
}

/** The id of every non-terminal record, oldest first. Ids, not parsed rows: a
 * reconcile reads each record inside its own guard, so one row that cannot be
 * parsed never hides the others. */
export function selectActiveOwnerApprovalIds(db: DatabaseSync): readonly string[] {
  return (db.prepare(`SELECT id FROM owner_approvals WHERE ${stateIn(OWNER_APPROVAL_ACTIVE_STATES)} ORDER BY rowid`)
    .all(...OWNER_APPROVAL_ACTIVE_STATES) as Row[]).map((row) => String(row['id']));
}

/** The id of every ended record whose card is still open, oldest first. */
export function selectEndedOwnerApprovalIdsWithOpenCard(db: DatabaseSync): readonly string[] {
  return (db.prepare(
    `SELECT a.id FROM owner_approvals a JOIN notifications n ON n.id = a.notification_id
      WHERE ${stateIn(OWNER_APPROVAL_TERMINAL_STATES).replaceAll('state ', 'a.state ')} AND n.resolved_at IS NULL ORDER BY a.rowid`,
  ).all(...OWNER_APPROVAL_TERMINAL_STATES) as Row[]).map((row) => String(row['id']));
}

export function insertOwnerApproval(db: DatabaseSync, record: Omit<OwnerApprovalRecord, 'state' | 'attempts' | 'executingSeq' | 'abandonmentEventSeq' | 'refusal' | 'jobId'>): void {
  db.prepare(
    `INSERT INTO owner_approvals
       (id, kind, request_id, job_id, fence_state, fence_payload_hash, fence_debt_generation, reason, idempotency_key,
        body_fingerprint, notification_id, state, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 0, ?, ?)`,
  ).run(record.id, record.kind, record.requestId, record.fences.jobId, record.fences.state, record.fences.payloadHash,
    record.fences.debtGeneration, record.reason, record.idempotencyKey, record.bodyFingerprint, record.notificationId,
    record.createdAt, record.updatedAt);
}

export function updateOwnerApproval(db: DatabaseSync, id: string, patch: {
  readonly state: OwnerApprovalState;
  readonly attempts?: number;
  readonly executingSeq?: number;
  readonly abandonmentEventSeq?: number;
  readonly refusal?: OwnerApprovalRefusal;
  readonly updatedAt: string;
}): void {
  db.prepare(
    `UPDATE owner_approvals
        SET state = ?, attempts = COALESCE(?, attempts), executing_seq = COALESCE(?, executing_seq),
            abandonment_event_seq = COALESCE(?, abandonment_event_seq),
            refusal_code = COALESCE(?, refusal_code), refusal_blockers = COALESCE(?, refusal_blockers), updated_at = ?
      WHERE id = ?`,
  ).run(patch.state, patch.attempts ?? null, patch.executingSeq ?? null, patch.abandonmentEventSeq ?? null,
    patch.refusal?.code ?? null, patch.refusal === undefined ? null : JSON.stringify(patch.refusal.blockers), patch.updatedAt, id);
}
