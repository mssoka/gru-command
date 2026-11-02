import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { LiveDirectiveState } from './directives.js';
import type { RecoverySubjectKind } from './recovery-owner.js';

/**
 * Owner approvals (#523, #565) — durable record vocabulary and persistence.
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
 *
 * One mechanism, four actions. Each `kind` names one owner-reserved action;
 * what it acts on is a `subject` whose shape the kind fixes
 * (`OWNER_APPROVAL_SUBJECT_OF_KIND`), and the fences the Approve is bound to
 * live on that subject, one shape per subject kind. A row whose kind and
 * subject disagree — or whose fence columns do not match its subject kind —
 * is loud on read, never silently read as another target.
 */

/** The owner-reserved actions an approval can carry out. Two of them
 * (`recovery-owner-resolution`, `recovery-owner-stop`) are never chained:
 * confirming a stop requires a recorded ruling and never records one. */
export const OWNER_APPROVAL_KINDS = [
  'directive-abandon',
  'rebrief-abandon',
  'recovery-owner-resolution',
  'recovery-owner-stop',
] as const;
export type OwnerApprovalKind = (typeof OWNER_APPROVAL_KINDS)[number];

/** The FOR YOU card kind of each approval kind. */
export const OWNER_APPROVAL_CARD_KIND: Readonly<Record<OwnerApprovalKind, string>> = {
  'directive-abandon': 'owner-approval.directive-abandon',
  'rebrief-abandon': 'owner-approval.rebrief-abandon',
  'recovery-owner-resolution': 'owner-approval.recovery-owner-resolution',
  'recovery-owner-stop': 'owner-approval.recovery-owner-stop',
};

/** What an approval is about: one fenced target shape per value. */
export const OWNER_APPROVAL_SUBJECT_KINDS = ['directive', 'rebrief-marker', 'recovery'] as const;
export type OwnerApprovalSubjectKind = (typeof OWNER_APPROVAL_SUBJECT_KINDS)[number];

/** The subject kind each approval kind is about. A kind never changes its
 * target shape, and the row's `subject_kind` is checked against this on
 * write and on read. */
export const OWNER_APPROVAL_SUBJECT_OF_KIND: Readonly<Record<OwnerApprovalKind, OwnerApprovalSubjectKind>> = {
  'directive-abandon': 'directive',
  'rebrief-abandon': 'rebrief-marker',
  'recovery-owner-resolution': 'recovery',
  'recovery-owner-stop': 'recovery',
};

/** The fences of one live directive request's abandonment. */
export interface DirectiveAbandonFences {
  readonly jobId: string;
  readonly state: LiveDirectiveState;
  readonly payloadHash: string;
  /** The request's recovery-debt generation, or null when it owes none. */
  readonly debtGeneration: number | null;
}

/** The fences of one pending re-brief marker generation's abandonment: a
 * marker has no state; it is pending or it is gone. */
export interface RebriefAbandonFences {
  readonly jobId: string;
  readonly payloadHash: string;
  /** The marker's recovery-debt generation, or null when it owes none. */
  readonly debtGeneration: number | null;
}

/** The recovery kinds' contract: exactly what `recordRecoveryOwnerResolution`
 * and `confirmRecoveryOwnerStop` validate, read when Gru asked. `kind` is the
 * recovery subject's own kind (`recoverySubject(kind, id)`). */
export interface RecoveryOwnerContract {
  readonly kind: RecoverySubjectKind;
  readonly transferEventSeq: number;
  readonly expectedTransferFingerprint: string;
  readonly expectedSubjectSha256: string;
  readonly expectedTargetGeneration: number;
  readonly expectedTargetPlanRevision: number;
  readonly expectedLineageSha256: string;
  readonly expectedEpoch: number;
  readonly expectedHead: string;
  readonly expectedWorkRevision: number;
  readonly expectedContractSha256: string;
}

/** The contract plus the job the subject belongs to. */
export interface RecoveryOwnerFences {
  readonly jobId: string;
  readonly contract: RecoveryOwnerContract;
}

/** What an approval is about, with the fences its Approve is bound to. The
 * recovery subject also carries the identity Gru minted once for it. */
export type OwnerApprovalSubject =
  | { readonly kind: 'directive'; readonly id: string; readonly fences: DirectiveAbandonFences }
  | { readonly kind: 'rebrief-marker'; readonly id: string; readonly fences: RebriefAbandonFences }
  | {
    readonly kind: 'recovery';
    readonly id: string;
    readonly fences: RecoveryOwnerFences;
    /** The stable, unused resolution identity: minted at proposal time, never
     * per attempt (a re-mint would record a second ruling). */
    readonly resolutionId: string;
    /** Stop only: the recorded ruling's own fingerprint this confirmation
     * affirms. Null for a ruling, whose identity is `resolutionId`. */
    readonly expectedResolutionFingerprint: string | null;
  };

export type OwnerApprovalSubjectOf<K extends OwnerApprovalSubjectKind> = Extract<OwnerApprovalSubject, { readonly kind: K }>;

/** The record's subject, when it is the expected shape. A row whose kind and
 * subject disagree is loud, never silently read as another target. */
export function ownerApprovalSubject<K extends OwnerApprovalSubjectKind>(
  record: OwnerApprovalRecord,
  kind: K,
): OwnerApprovalSubjectOf<K> {
  if (record.subject.kind !== kind) {
    throw new Error(`owner approval "${record.id}" is about a ${record.subject.kind} subject, not a ${kind} one`);
  }
  return record.subject as OwnerApprovalSubjectOf<K>;
}

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
 * code (`DIRECTIVE_RETIREMENT_REFUSAL_CODES`, `DirectiveCheckpointError`). */
export const OWNER_APPROVAL_REFUSAL_CODES = [
  'card-post-failed',
  'decider-not-owner',
  'abandoned-elsewhere',
  'recorded-elsewhere',
  'stale-fence',
  'execution-error',
] as const;
export type OwnerApprovalRefusalCode = (typeof OWNER_APPROVAL_REFUSAL_CODES)[number];

/** Why a record was refused: a code and the blockers behind it (possibly none). */
export interface OwnerApprovalRefusal {
  readonly code: string;
  readonly blockers: readonly string[];
}

export interface OwnerApprovalRecord {
  readonly id: string;
  readonly kind: OwnerApprovalKind;
  readonly subject: OwnerApprovalSubject;
  readonly jobId: string;
  readonly state: OwnerApprovalState;
  readonly attempts: number;
  readonly reason: string;
  readonly idempotencyKey: string;
  readonly bodyFingerprint: string;
  readonly notificationId: string;
  /** The seq of this record's `owner-approval.executing` event. */
  readonly executingSeq: number | null;
  /** The seq of the audit event that carried the action out: a
   * `silas.directive-abandoned` / `silas.rebrief-abandoned` event, or the
   * recovery kinds' `ruling.recorded` / `silas.recovery-owner-stop-confirmed`
   * event. */
  readonly auditEventSeq: number | null;
  readonly refusal: OwnerApprovalRefusal | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OwnerApprovalHistoryEntry {
  readonly state: string;
  readonly at: string;
  readonly detail: string | null;
}

/** A proposal body, discriminated by the kind of action it asks the owner to
 * carry out: each kind names its target exactly, and the recovery kinds carry
 * the fences they were read at. */
export type OwnerApprovalProposalInput =
  | {
    readonly kind: 'directive-abandon';
    readonly requestId: string;
    readonly reason: string;
    readonly idempotencyKey: string;
  }
  | {
    readonly kind: 'rebrief-abandon';
    readonly markerId: string;
    readonly reason: string;
    readonly idempotencyKey: string;
  }
  | {
    readonly kind: 'recovery-owner-resolution';
    readonly subjectId: string;
    readonly contract: RecoveryOwnerContract;
    readonly resolutionId: string;
    readonly reason: string;
    readonly idempotencyKey: string;
  }
  | {
    readonly kind: 'recovery-owner-stop';
    readonly subjectId: string;
    readonly contract: RecoveryOwnerContract;
    readonly resolutionId: string;
    readonly expectedResolutionFingerprint: string;
    readonly reason: string;
    readonly idempotencyKey: string;
  };

/** What `proposeOwnerApproval` answered. */
export type OwnerApprovalProposal =
  | { readonly kind: 'created'; readonly approval: OwnerApprovalRecord }
  | { readonly kind: 'replayed'; readonly approval: OwnerApprovalRecord }
  | { readonly kind: 'key_conflict'; readonly approval: OwnerApprovalRecord }
  | { readonly kind: 'unknown_subject' }
  | { readonly kind: 'not_live'; readonly state: string; readonly detail: string | null }
  | { readonly kind: 'pending'; readonly approval: OwnerApprovalRecord };

/** How a record ends. */
export type OwnerApprovalOutcome =
  | { readonly state: 'succeeded'; readonly auditEventSeq: number; readonly detail: string }
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

/** The proposal body a record's identity is read from: what an idempotency
 * key is bound to (`by` is always gru). */
export interface OwnerApprovalProposalIdentity {
  readonly kind: OwnerApprovalKind;
  readonly subjectKind: OwnerApprovalSubjectKind;
  readonly subjectId: string;
  readonly resolutionId: string | null;
  readonly expectedResolutionFingerprint: string | null;
  readonly contract: RecoveryOwnerContract | null;
  readonly reason: string;
}

export function ownerApprovalProposalIdentity(input: OwnerApprovalProposalInput): OwnerApprovalProposalIdentity {
  switch (input.kind) {
    case 'directive-abandon':
      return { kind: input.kind, subjectKind: 'directive', subjectId: input.requestId, resolutionId: null,
        expectedResolutionFingerprint: null, contract: null, reason: input.reason };
    case 'rebrief-abandon':
      return { kind: input.kind, subjectKind: 'rebrief-marker', subjectId: input.markerId, resolutionId: null,
        expectedResolutionFingerprint: null, contract: null, reason: input.reason };
    case 'recovery-owner-resolution':
      return { kind: input.kind, subjectKind: 'recovery', subjectId: input.subjectId, resolutionId: input.resolutionId,
        expectedResolutionFingerprint: null, contract: input.contract, reason: input.reason };
    case 'recovery-owner-stop':
      return { kind: input.kind, subjectKind: 'recovery', subjectId: input.subjectId, resolutionId: input.resolutionId,
        expectedResolutionFingerprint: input.expectedResolutionFingerprint, contract: input.contract, reason: input.reason };
  }
}

/** sha256 over the proposal body (kind, subject, resolution identity, the
 * recovery contract and the reason; `by` is always gru): a repeat of an
 * idempotency key with the same body is the same proposal. Field order is the
 * argument list's, never the object's, so a reordered contract cannot make
 * the same proposal look different. */
export function ownerApprovalFingerprint(identity: OwnerApprovalProposalIdentity): string {
  const contract = identity.contract === null ? null : [
    identity.contract.kind, identity.contract.transferEventSeq, identity.contract.expectedTransferFingerprint,
    identity.contract.expectedSubjectSha256, identity.contract.expectedTargetGeneration, identity.contract.expectedTargetPlanRevision,
    identity.contract.expectedLineageSha256, identity.contract.expectedEpoch, identity.contract.expectedHead,
    identity.contract.expectedWorkRevision, identity.contract.expectedContractSha256,
  ];
  return createHash('sha256').update(JSON.stringify([identity.kind, identity.subjectKind, identity.subjectId,
    identity.resolutionId, identity.expectedResolutionFingerprint, contract, identity.reason, 'gru'])).digest('hex');
}

/** The `owner-approval.*` events of one record, in order. A range over the kind
 * index, not `LIKE`: SQLite's `LIKE` is case-insensitive, cannot use the
 * binary-collation index and would scan the whole events table on every
 * readback. `/` is the character after `.`, so the range is the `owner-approval.`
 * prefix exactly. */
export const OWNER_APPROVAL_HISTORY_SQL =
  "SELECT ts, kind, payload FROM events WHERE kind >= 'owner-approval.' AND kind < 'owner-approval/' AND json_extract(payload, '$.id') = ? ORDER BY seq";

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

/** A required non-empty text column. A NULL, an empty string or the literal
 * "null" is a corrupt row, never a target. */
function requiredText(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string' || value.trim() === '' || value === 'null') {
    throw new Error(`owner_approvals.${column} is not a non-empty string (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** A column that must be absent for this subject kind. */
function absentText(row: Row, column: string): null {
  const value = row[column];
  if (value !== null && value !== undefined) {
    throw new Error(`owner_approvals.${column} must be null for this subject (got ${JSON.stringify(value)})`);
  }
  return null;
}

function nullableNumber(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`owner_approvals.${column} is not an integer (got ${JSON.stringify(value)})`);
  return parsed;
}

function requiredNumber(row: Row, column: string): number {
  const value = nullableNumber(row, column);
  if (value === null) throw new Error(`owner_approvals.${column} is null`);
  return value;
}

const RECOVERY_CONTRACT_NUMBERS = [
  'transferEventSeq', 'expectedTargetGeneration', 'expectedTargetPlanRevision', 'expectedEpoch', 'expectedWorkRevision',
] as const;
const RECOVERY_CONTRACT_TEXT = [
  'expectedTransferFingerprint', 'expectedSubjectSha256', 'expectedLineageSha256', 'expectedHead', 'expectedContractSha256',
] as const;

/** The stored recovery contract, one required field at a time: a truncated or
 * foreign object is loud, never a contract with a missing fence. */
export function parseRecoveryOwnerContract(raw: unknown): RecoveryOwnerContract {
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('owner_approvals.fence_contract is not a JSON object');
  }
  const contract = parsed as Record<string, unknown>;
  const kind = contract['kind'];
  if (kind !== 'directive' && kind !== 'rebrief') throw new Error(`owner_approvals.fence_contract.kind is not "directive" or "rebrief" (got ${JSON.stringify(kind)})`);
  const numbers = Object.fromEntries(RECOVERY_CONTRACT_NUMBERS.map((field) => {
    const value = contract[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`owner_approvals.fence_contract.${field} is not a non-negative integer (got ${JSON.stringify(value)})`);
    }
    return [field, value];
  }));
  const text = Object.fromEntries(RECOVERY_CONTRACT_TEXT.map((field) => {
    const value = contract[field];
    if (typeof value !== 'string' || value.trim() === '' || value === 'null') {
      throw new Error(`owner_approvals.fence_contract.${field} is not a non-empty string (got ${JSON.stringify(value)})`);
    }
    return [field, value];
  }));
  return { kind, ...numbers, ...text } as unknown as RecoveryOwnerContract;
}

export function ownerApprovalFromRow(row: Row): OwnerApprovalRecord {
  if (!isState(row['state'])) throw new Error(`owner_approvals row has unknown state "${String(row['state'])}"`);
  if (!isKind(row['kind'])) throw new Error(`owner_approvals row has unknown kind "${String(row['kind'])}"`);
  const kind = row['kind'];
  const id = String(row['id']);
  const subjectKind = OWNER_APPROVAL_SUBJECT_OF_KIND[kind];
  if (row['subject_kind'] !== subjectKind) {
    throw new Error(`owner_approvals row "${id}" records kind "${kind}" with subject_kind "${String(row['subject_kind'])}"; expected "${subjectKind}"`);
  }
  const subjectId = requiredText(row, 'subject_id');
  const code = row['refusal_code'];
  const subject = ((): OwnerApprovalSubject => {
    switch (subjectKind) {
      case 'directive': {
        if (requiredText(row, 'request_id') !== subjectId) {
          throw new Error(`owner_approvals row "${id}" records request_id "${String(row['request_id'])}" beside subject_id "${subjectId}"`);
        }
        const state = row['fence_state'];
        if (state !== 'dispatching' && state !== 'admitted') {
          throw new Error(`owner_approvals row "${id}" has fence_state ${JSON.stringify(state)}; a directive subject needs "dispatching" or "admitted"`);
        }
        return { kind: 'directive', id: subjectId, fences: { jobId: requiredText(row, 'job_id'), state,
          payloadHash: requiredText(row, 'fence_payload_hash'), debtGeneration: nullableNumber(row, 'fence_debt_generation') } };
      }
      case 'rebrief-marker': {
        absentText(row, 'request_id');
        absentText(row, 'fence_state');
        return { kind: 'rebrief-marker', id: subjectId, fences: { jobId: requiredText(row, 'job_id'),
          payloadHash: requiredText(row, 'fence_payload_hash'), debtGeneration: nullableNumber(row, 'fence_debt_generation') } };
      }
      case 'recovery': {
        absentText(row, 'request_id');
        absentText(row, 'fence_state');
        absentText(row, 'fence_payload_hash');
        if (row['fence_debt_generation'] !== null && row['fence_debt_generation'] !== undefined) {
          throw new Error(`owner_approvals row "${id}" records a debt generation for a recovery subject`);
        }
        const expected = row['expected_resolution_fingerprint'];
        if (kind === 'recovery-owner-stop' ? typeof expected !== 'string' || expected.trim() === '' : expected !== null && expected !== undefined) {
          throw new Error(`owner_approvals row "${id}" records expected_resolution_fingerprint ${JSON.stringify(expected)} for kind "${kind}"`);
        }
        return { kind: 'recovery', id: subjectId,
          fences: { jobId: requiredText(row, 'job_id'), contract: parseRecoveryOwnerContract(row['fence_contract_json']) },
          resolutionId: requiredText(row, 'resolution_id'),
          expectedResolutionFingerprint: kind === 'recovery-owner-stop' ? String(expected) : null };
      }
    }
  })();
  return {
    id,
    kind,
    subject,
    jobId: String(row['job_id']),
    state: row['state'],
    attempts: requiredNumber(row, 'attempts'),
    reason: String(row['reason']),
    idempotencyKey: String(row['idempotency_key']),
    bodyFingerprint: String(row['body_fingerprint']),
    notificationId: String(row['notification_id']),
    executingSeq: nullableNumber(row, 'executing_seq'),
    auditEventSeq: nullableNumber(row, 'abandonment_event_seq'),
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

/** The one `proposed`, `approved` or `executing` record of a subject (the
 * partial unique index allows at most one). */
export function selectActiveOwnerApprovalForSubject(
  db: DatabaseSync,
  subjectKind: OwnerApprovalSubjectKind,
  subjectId: string,
): OwnerApprovalRecord | null {
  const row = db.prepare(`SELECT * FROM owner_approvals WHERE subject_kind = ? AND subject_id = ? AND ${stateIn(OWNER_APPROVAL_ACTIVE_STATES)}`)
    .get(subjectKind, subjectId, ...OWNER_APPROVAL_ACTIVE_STATES) as Row | undefined;
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

export function insertOwnerApproval(
  db: DatabaseSync,
  record: Omit<OwnerApprovalRecord, 'state' | 'attempts' | 'executingSeq' | 'auditEventSeq' | 'refusal' | 'jobId'>,
): void {
  const { subject } = record;
  const recovery = subject.kind === 'recovery' ? subject : null;
  db.prepare(
    `INSERT INTO owner_approvals
       (id, kind, subject_kind, subject_id, request_id, job_id, fence_state, fence_payload_hash, fence_debt_generation,
        fence_contract_json, resolution_id, expected_resolution_fingerprint, reason, idempotency_key, body_fingerprint,
        notification_id, state, attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', 0, ?, ?)`,
  ).run(record.id, record.kind, subject.kind, subject.id,
    subject.kind === 'directive' ? subject.id : null,
    subject.fences.jobId,
    subject.kind === 'directive' ? subject.fences.state : null,
    subject.kind === 'recovery' ? null : subject.fences.payloadHash,
    subject.kind === 'recovery' ? null : subject.fences.debtGeneration,
    recovery === null ? null : JSON.stringify(recovery.fences.contract),
    recovery === null ? null : recovery.resolutionId,
    recovery === null ? null : recovery.expectedResolutionFingerprint,
    record.reason, record.idempotencyKey, record.bodyFingerprint, record.notificationId, record.createdAt, record.updatedAt);
}

export function updateOwnerApproval(db: DatabaseSync, id: string, patch: {
  readonly state: OwnerApprovalState;
  readonly attempts?: number;
  readonly executingSeq?: number;
  readonly auditEventSeq?: number;
  readonly refusal?: OwnerApprovalRefusal;
  readonly updatedAt: string;
}): void {
  db.prepare(
    `UPDATE owner_approvals
        SET state = ?, attempts = COALESCE(?, attempts), executing_seq = COALESCE(?, executing_seq),
            abandonment_event_seq = COALESCE(?, abandonment_event_seq),
            refusal_code = COALESCE(?, refusal_code), refusal_blockers = COALESCE(?, refusal_blockers), updated_at = ?
      WHERE id = ?`,
  ).run(patch.state, patch.attempts ?? null, patch.executingSeq ?? null, patch.auditEventSeq ?? null,
    patch.refusal?.code ?? null, patch.refusal === undefined ? null : JSON.stringify(patch.refusal.blockers), patch.updatedAt, id);
}
