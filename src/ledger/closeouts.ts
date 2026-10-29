import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DirectiveCheckpointError } from '../runtime/directive-checkpoint.js';

/**
 * Canceled-request closeout (#523) — durable intent vocabulary and persistence.
 *
 * Binning a job whose only live request is a directive request that was
 * deferred before reaching its worker is a three-step closeout: S1 records the
 * intent, S2 retires the request, S3 bins the job and resolves the request's
 * card. This module owns the `request_closeouts` row; the steps themselves are
 * `LedgerApi` transactions and `CanceledRequestCloseout` (dispatch) drives them.
 *
 * `open` = the intent is recorded and the service owes the remaining steps (a
 * crash leaves it here: it means resume). `stopped` = a guard that passed
 * preflight refused later (a race); the recorded blockers and their
 * fingerprint say why. `complete` and `superseded` are terminal.
 */

/** The attribution of every closeout write: retired_by, the card's
 * resolved_by and the intent events' `by`. Never `owner`. */
export const CLOSEOUT_ACTOR = 'canceled-request-closeout';

/** The longest free-text reason a binning request may carry. */
export const CLOSEOUT_REASON_MAX_CHARS = 500;

export const CLOSEOUT_STATES = ['open', 'stopped', 'complete', 'superseded'] as const;
export type CloseoutState = (typeof CLOSEOUT_STATES)[number];

/** Why an intent no longer describes the job: the first failing revalidation predicate. */
export const CLOSEOUT_SUPERSEDED_REASONS = ['job-status', 'request-state', 'later-work', 'control-event'] as const;
export type CloseoutSupersededReason = (typeof CLOSEOUT_SUPERSEDED_REASONS)[number];

export const CLOSEOUT_REQUESTERS = ['gru', 'unattributed'] as const;
export type CloseoutRequester = (typeof CLOSEOUT_REQUESTERS)[number];

/** A claim, never identity proof: only the exact label `gru` is kept. */
export function closeoutRequester(by: unknown): CloseoutRequester {
  return by === 'gru' ? 'gru' : 'unattributed';
}

/** One refusal reason, keeping the guard's own code. */
export interface CloseoutBlocker {
  readonly code: string;
  readonly detail: string;
}

/** sha256 of the sorted blocker codes and details: two evaluations that
 * refuse for the same reasons share a fingerprint, so a repeated request
 * can tell "still blocked" from "something changed". */
export function closeoutBlockerFingerprint(blockers: readonly CloseoutBlocker[]): string {
  const pairs = blockers.map(({ code, detail }) => [code, detail] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
}

export interface CloseoutIntent {
  readonly closeoutId: string;
  readonly jobId: string;
  readonly requestId: string;
  /** Per-request counter; a superseded intent is followed by generation + 1. */
  readonly generation: number;
  readonly payloadHash: string;
  /** The job status at S1; the P1 revalidation predicate compares against it. */
  readonly jobStatus: string;
  /** The seq of the `silas.closeout-intent` event (S1). */
  readonly intentSeq: number;
  readonly state: CloseoutState;
  readonly supersededReason: CloseoutSupersededReason | null;
  readonly requestedBy: CloseoutRequester;
  readonly reason: string | null;
  readonly blockers: readonly CloseoutBlocker[];
  readonly blockerFingerprint: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The closeout owes this request its end: a redispatch is refused until the
 * intent completes or is superseded. A checkpoint refusal like any other, so
 * every existing catch site treats it as one. */
export class CloseoutPendingError extends DirectiveCheckpointError {
  readonly requestId: string;
  readonly closeoutId: string;
  constructor(requestId: string, closeoutId: string, state: CloseoutState) {
    super(`directive request "${requestId}" is being closed out by its job's binning (closeout ${closeoutId} is ${state}) — it must not be redispatched`);
    this.name = 'CloseoutPendingError';
    this.requestId = requestId;
    this.closeoutId = closeoutId;
  }
}

/** Binning refused for live work AFTER the request was retired (S3). Same
 * message the generic status write has always produced. */
export class TerminalLiveWorkError extends Error {
  readonly blockers: readonly string[];
  constructor(jobId: string, blockers: readonly string[]) {
    super(`job "${jobId}" has target-owned live work — stop it before binning: ${blockers.join('; ')}`);
    this.name = 'TerminalLiveWorkError';
    this.blockers = blockers;
  }
}

type Row = Record<string, unknown>;

function isCloseoutState(value: unknown): value is CloseoutState {
  return typeof value === 'string' && (CLOSEOUT_STATES as readonly string[]).includes(value);
}

function parseBlockers(raw: unknown): readonly CloseoutBlocker[] {
  const parsed: unknown = JSON.parse(String(raw ?? '[]'));
  if (!Array.isArray(parsed)) throw new Error('request_closeouts.blockers is not a JSON array');
  return parsed.map((entry): CloseoutBlocker => {
    const { code, detail } = (entry ?? {}) as { code?: unknown; detail?: unknown };
    if (typeof code !== 'string' || typeof detail !== 'string') throw new Error('request_closeouts.blockers holds a malformed entry');
    return { code, detail };
  });
}

export function closeoutFromRow(row: Row): CloseoutIntent {
  if (!isCloseoutState(row['state'])) throw new Error(`request_closeouts row has unknown state "${String(row['state'])}"`);
  const reason = row['superseded_reason'];
  return {
    closeoutId: String(row['closeout_id']),
    jobId: String(row['job_id']),
    requestId: String(row['request_id']),
    generation: Number(row['generation']),
    payloadHash: String(row['payload_hash']),
    jobStatus: String(row['job_status']),
    intentSeq: Number(row['intent_seq']),
    state: row['state'],
    supersededReason: reason === null || reason === undefined ? null : (reason as CloseoutSupersededReason),
    requestedBy: closeoutRequester(row['requested_by']),
    reason: row['reason'] === null || row['reason'] === undefined ? null : String(row['reason']),
    blockers: parseBlockers(row['blockers']),
    blockerFingerprint: row['blocker_fingerprint'] === null || row['blocker_fingerprint'] === undefined ? null : String(row['blocker_fingerprint']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

export function selectCloseout(db: DatabaseSync, closeoutId: string): CloseoutIntent | null {
  const row = db.prepare('SELECT * FROM request_closeouts WHERE closeout_id = ?').get(closeoutId) as Row | undefined;
  return row === undefined ? null : closeoutFromRow(row);
}

/** The newest generation for one request, whatever its state. */
export function selectLatestCloseoutForRequest(db: DatabaseSync, requestId: string): CloseoutIntent | null {
  const row = db.prepare('SELECT * FROM request_closeouts WHERE request_id = ? ORDER BY generation DESC LIMIT 1').get(requestId) as Row | undefined;
  return row === undefined ? null : closeoutFromRow(row);
}

/** The newest intent of any request on the job (insertion order, not wall-clock time). */
export function selectLatestCloseoutForJob(db: DatabaseSync, jobId: string): CloseoutIntent | null {
  const row = db.prepare('SELECT * FROM request_closeouts WHERE job_id = ? ORDER BY rowid DESC LIMIT 1').get(jobId) as Row | undefined;
  return row === undefined ? null : closeoutFromRow(row);
}

/** The one `open` or `stopped` intent of a request (the partial unique index allows at most one). */
export function selectActiveCloseoutForRequest(db: DatabaseSync, requestId: string): CloseoutIntent | null {
  const row = db.prepare("SELECT * FROM request_closeouts WHERE request_id = ? AND state IN ('open', 'stopped')").get(requestId) as Row | undefined;
  return row === undefined ? null : closeoutFromRow(row);
}

export function selectActiveCloseoutForJob(db: DatabaseSync, jobId: string): CloseoutIntent | null {
  const row = db.prepare("SELECT * FROM request_closeouts WHERE job_id = ? AND state IN ('open', 'stopped') ORDER BY rowid DESC LIMIT 1").get(jobId) as Row | undefined;
  return row === undefined ? null : closeoutFromRow(row);
}

export function hasActiveCloseout(db: DatabaseSync, requestId: string): boolean {
  return db.prepare("SELECT 1 FROM request_closeouts WHERE request_id = ? AND state IN ('open', 'stopped') LIMIT 1").get(requestId) !== undefined;
}

/** The id of every `open` or `stopped` intent, oldest first. Ids, not parsed
 * rows: a resume loop reads each row inside its own guard, so one row that
 * cannot be parsed never hides the others. */
export function selectActiveCloseoutIds(db: DatabaseSync): readonly string[] {
  return (db.prepare("SELECT closeout_id FROM request_closeouts WHERE state IN ('open', 'stopped') ORDER BY rowid").all() as Row[])
    .map((row) => String(row['closeout_id']));
}

export function nextCloseoutGeneration(db: DatabaseSync, requestId: string): number {
  const row = db.prepare('SELECT COALESCE(MAX(generation), 0) AS latest FROM request_closeouts WHERE request_id = ?').get(requestId) as Row;
  return Number(row['latest']) + 1;
}

export function insertCloseout(db: DatabaseSync, intent: Omit<CloseoutIntent, 'supersededReason' | 'blockers' | 'blockerFingerprint' | 'state'>): void {
  db.prepare(
    `INSERT INTO request_closeouts
       (closeout_id, job_id, request_id, generation, payload_hash, job_status, intent_seq, state,
        superseded_reason, requested_by, reason, blockers, blocker_fingerprint, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, '[]', NULL, ?, ?)`,
  ).run(intent.closeoutId, intent.jobId, intent.requestId, intent.generation, intent.payloadHash, intent.jobStatus,
    intent.intentSeq, intent.requestedBy, intent.reason, intent.createdAt, intent.updatedAt);
}

export function updateCloseoutState(db: DatabaseSync, closeoutId: string, patch: {
  readonly state: CloseoutState;
  readonly supersededReason?: CloseoutSupersededReason | null;
  readonly blockers?: readonly CloseoutBlocker[];
  readonly updatedAt: string;
}): void {
  const blockers = patch.blockers ?? [];
  db.prepare(
    `UPDATE request_closeouts
        SET state = ?, superseded_reason = ?, blockers = ?, blocker_fingerprint = ?, updated_at = ?
      WHERE closeout_id = ?`,
  ).run(patch.state, patch.supersededReason ?? null, JSON.stringify(blockers),
    patch.state === 'stopped' ? closeoutBlockerFingerprint(blockers) : null, patch.updatedAt, closeoutId);
}
