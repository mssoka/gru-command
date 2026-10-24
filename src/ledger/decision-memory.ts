import { canonicalIsoTimestamp } from './obligations.js';
import { isSafePipelineRecordId } from './pipeline.js';

/**
 * Decision memory (issue #218): typed holds and dispositions stored as
 * ledger state the triggers can read. Prose memory ("resolved under the
 * existing hold") is not state — every re-detection re-woke the chief to
 * rediscover it. A decision row names the subject it covers, the signal
 * kinds it covers, the state fingerprint it was made against, and when to
 * look again. `coveringDecision` is THE trigger query: "is signal S on
 * subject X covered by an active decision whose basis still matches?"
 *
 * Attribution (issue #99, unchanged): `by` is stored as supplied — a
 * CLAIM, never identity proof. The ops bearer token is shared, so no
 * write path proves who authored a decision; the vocabulary is pinned so
 * at least the claim is auditable.
 */

/** The decision vocabulary. `hold` = park the subject under a stated
 * reason; `dismissed` = needs no action; `acted` = action was taken;
 * `superseded` = a newer decision replaces this one; `covered` = an
 * explicit coverage grant for the named signals. */
export type DecisionKind = 'hold' | 'dismissed' | 'acted' | 'superseded' | 'covered';

/** Who claims the decision (a claim — see #99): the chief, the ops
 * supervisor, the owner, or deterministic code. */
export type DecisionActor = 'gru' | 'silas' | 'owner' | 'code';

/** How a decision's `covers` is read (#503, migration 32): `family` since
 * signal families; `pre-family` for every decision recorded before, which
 * matches only the signal the pre-family derivation gave a row. */
export type DecisionCoversScheme = 'family' | 'pre-family';

export const DECISION_KINDS: readonly DecisionKind[] = ['hold', 'dismissed', 'acted', 'superseded', 'covered'];
export const DECISION_ACTORS: readonly DecisionActor[] = ['gru', 'silas', 'owner', 'code'];

export function isDecisionKind(value: unknown): value is DecisionKind {
  return typeof value === 'string' && (DECISION_KINDS as readonly string[]).includes(value);
}

export function isDecisionActor(value: unknown): value is DecisionActor {
  return typeof value === 'string' && (DECISION_ACTORS as readonly string[]).includes(value);
}

/** One durable decision. Rows are never rewritten — a clear stamps
 * `clearedAt`/`clearedBy`/`clearedReason` and `coveringDecision` stops
 * returning the row; history keeps everything. */
export interface DecisionRecord {
  readonly id: string;
  /** `'job:<id>'` | `'pr:<repo>#<n>'` | `'incident:<kind>:<key>'` — a
   * kind-prefixed stable key (see validateDecisionSubject). */
  readonly subject: string;
  readonly decision: DecisionKind;
  /** Signal kinds this decision covers, e.g. `['pr-conflict','ci-failed']`
   * (canonical: deduped, sorted). */
  readonly covers: readonly string[];
  /** State fingerprint at decision time (head SHA / incident hash).
   * `null` = the decision holds on ANY basis. */
  readonly basisFingerprint: string | null;
  readonly reason: string;
  /** A claim, never identity proof (#99). */
  readonly by: DecisionActor;
  /** Caller idempotency key — a retry with the same key and content
   * returns the original row instead of creating a second decision. */
  readonly clientKey: string | null;
  readonly createdAt: string;
  /** Scheduled re-look: `null` = none (a basis change still re-opens the
   * subject). Once `now` passes `recheckAt` the decision stops covering. */
  readonly recheckAt: string | null;
  readonly clearedAt: string | null;
  readonly clearedBy: string | null;
  readonly clearedReason: string | null;
  /** How `covers` is read (#503): a `pre-family` decision matches only
   * pre-family signals, so its family-looking tokens may cover nothing. */
  readonly coversScheme: DecisionCoversScheme;
}

/** Bounds — every write boundary validates against these. */
export const DECISION_SUBJECT_MAX_LENGTH = 256;
export const DECISION_REASON_MAX_LENGTH = 2_000;
export const DECISION_FINGERPRINT_MAX_LENGTH = 256;
export const DECISION_SIGNAL_MAX_LENGTH = 64;
const REPORT_HANDBACK_SIGNAL_PREFIX = 'report-handback.';
/** Preserve the complete generated signal for every supported 128-character job id. */
const REPORT_HANDBACK_SIGNAL_MAX_LENGTH = REPORT_HANDBACK_SIGNAL_PREFIX.length + 128;
export const DECISION_SIGNALS_MAX_COUNT = 16;

/** The subject kinds the issue enumerates — 'job:<id>',
 * 'pr:<repo>#<n>', 'incident:<kind>:<key>'. A new kind is a deliberate
 * vocabulary extension (db migration comment + this list together),
 * never a silently-accepted near-miss that can never match a trigger. */
export const DECISION_SUBJECT_KINDS: readonly string[] = ['job', 'pr', 'incident'];

/** A subject is one of the documented kind-prefixed stable keys.
 * Anything else would be stored, never match a trigger query, and
 * silently hold nothing — reject it at the write boundary instead. */
export function validateDecisionSubject(value: string): string {
  if (value.length === 0 || value.length > DECISION_SUBJECT_MAX_LENGTH) {
    throw new Error(`decision subject must be 1-${DECISION_SUBJECT_MAX_LENGTH} characters`);
  }
  if (/[\p{Cc}]/u.test(value)) {
    throw new Error('decision subject must not contain control characters');
  }
  const colon = value.indexOf(':');
  if (colon <= 0 || colon === value.length - 1) {
    throw new Error(`decision subject must be "<kind>:<key>" (e.g. "pr:<repo>#<n>"), got "${value}"`);
  }
  const kind = value.slice(0, colon);
  if (!(DECISION_SUBJECT_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `unknown decision subject kind "${kind}" — expected one of ${DECISION_SUBJECT_KINDS.map((k) => `${k}:`).join(', ')}`,
    );
  }
  return value;
}

/** Signal families are canonical lowercase tokens (`pr-conflict`,
 * `ci-failed`, `directive-unreconciled`); since #503 no derived family
 * carries an instance id (`incidentSignalOf`). The report-handback suffix
 * is an exact, case-sensitive job identity, not a family to lowercase or
 * truncate. */
export function validateDecisionSignal(value: string): string {
  const reportHandback = value.startsWith(REPORT_HANDBACK_SIGNAL_PREFIX);
  const maxLength = reportHandback ? REPORT_HANDBACK_SIGNAL_MAX_LENGTH : DECISION_SIGNAL_MAX_LENGTH;
  if (value.length === 0 || value.length > maxLength) {
    throw new Error(`decision signal must be 1-${maxLength} characters`);
  }
  if (reportHandback && isSafePipelineRecordId(value.slice(REPORT_HANDBACK_SIGNAL_PREFIX.length))) return value;
  // Keep every formerly valid short token readable. Only a complete safe
  // report job identity grants the larger bound or a case-sensitive suffix.
  if (value.length > DECISION_SIGNAL_MAX_LENGTH) {
    throw new Error(`decision signal longer than ${DECISION_SIGNAL_MAX_LENGTH} characters must be report-handback.<safe job id>, got "${value}"`);
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(value)) {
    if (reportHandback) throw new Error(`decision signal report-handback suffix must be a safe job id (case preserved), got "${value}"`);
    throw new Error(`decision signal must be a lowercase token of [a-z0-9._-], got "${value}"`);
  }
  return value;
}

/** #503: a new decision names a signal no row can raise any more — one
 * instance of a family (`supervision.turn-orphaned.<agent>`). It would be
 * stored and never match; the caller covers the family instead. */
export class RetiredDecisionSignalError extends Error {
  constructor(readonly signal: string, readonly family: string) {
    super(`decision signal "${signal}" names one instance of the signal family "${family}" (#503): cover "${family}" — ` +
      'the subject and basis pin the instance');
    this.name = 'RetiredDecisionSignalError';
  }
}

/** Whether `value` passes validateDecisionSignal: the write boundary, and so
 * every stored `covers` entry (reads re-validate). */
export function isDecisionSignal(value: string): boolean {
  try {
    validateDecisionSignal(value);
    return true;
  } catch {
    return false;
  }
}

/** Canonical `covers`: non-empty, bounded, deduped, sorted — so an
 * idempotent retry compares equal regardless of caller ordering. */
export function canonicalDecisionCovers(covers: readonly string[]): readonly string[] {
  if (!Array.isArray(covers) || covers.length === 0) {
    throw new Error('decision covers must be a non-empty array of signal kinds');
  }
  if (covers.length > DECISION_SIGNALS_MAX_COUNT) {
    throw new Error(`decision covers must not exceed ${DECISION_SIGNALS_MAX_COUNT} signal kinds`);
  }
  const seen = new Set<string>();
  for (const signal of covers) {
    if (typeof signal !== 'string') throw new Error('decision covers must be an array of strings');
    seen.add(validateDecisionSignal(signal));
  }
  return [...seen].sort();
}

export function validateDecisionReason(value: string): string {
  if (value.length === 0 || value.length > DECISION_REASON_MAX_LENGTH) {
    throw new Error(`decision reason must be 1-${DECISION_REASON_MAX_LENGTH} characters`);
  }
  return value;
}

export function validateDecisionFingerprint(value: string): string {
  if (value.length === 0 || value.length > DECISION_FINGERPRINT_MAX_LENGTH) {
    throw new Error(`decision basis fingerprint must be 1-${DECISION_FINGERPRINT_MAX_LENGTH} characters`);
  }
  if (/[\p{Cc}]/u.test(value)) {
    throw new Error('decision basis fingerprint must not contain control characters');
  }
  return value;
}

/** Canonical write input — everything validated and normalized in one
 * place so the api boundary and the HTTP boundary cannot drift. */
export interface CanonicalDecisionInput {
  readonly subject: string;
  readonly decision: DecisionKind;
  readonly covers: readonly string[];
  readonly basisFingerprint: string | null;
  readonly reason: string;
  readonly by: DecisionActor;
  readonly clientKey: string | null;
  readonly recheckAt: string | null;
}

/** Strict ISO-8601 UTC shape for `recheck_at`: the issue asks for an ISO
 * timestamp, and Date.parse alone would also accept prose like
 * "March 5 2030" — canonicalize only what is unambiguously ISO. */
function requireIsoUtcTimestamp(value: string, what: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u.test(value)) {
    throw new Error(`${what} must be an ISO 8601 UTC timestamp (e.g. 2030-01-01T00:00:00.000Z), got "${value}"`);
  }
  return canonicalIsoTimestamp(value, what);
}

/** Validate + canonicalize a decision write. `recheckAt` is canonicalized
 * to a UTC ISO string so string comparison in queries is sound. */
export function canonicalizeDecisionInput(input: {
  subject: string;
  decision: DecisionKind;
  covers: readonly string[];
  basisFingerprint?: string | null;
  reason: string;
  by: DecisionActor;
  recheckAt?: string | null;
}): CanonicalDecisionInput {
  if (!isDecisionKind(input.decision)) {
    throw new Error(`unknown decision kind "${String(input.decision)}" — expected one of ${DECISION_KINDS.join(', ')}`);
  }
  if (!isDecisionActor(input.by)) {
    throw new Error(`unknown decision actor "${String(input.by)}" — expected one of ${DECISION_ACTORS.join(', ')} (attribution is a claim, see #99)`);
  }
  return {
    subject: validateDecisionSubject(input.subject),
    decision: input.decision,
    covers: canonicalDecisionCovers(input.covers),
    basisFingerprint:
      input.basisFingerprint === null || input.basisFingerprint === undefined
        ? null
        : validateDecisionFingerprint(input.basisFingerprint),
    reason: validateDecisionReason(input.reason),
    by: input.by,
    clientKey: null,
    recheckAt:
      input.recheckAt === null || input.recheckAt === undefined
        ? null
        : requireIsoUtcTimestamp(input.recheckAt, 'decision recheckAt'),
  };
}

export function parseDecisionCovers(json: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new Error(`decision covers column is not valid JSON: ${String(error)}`);
  }
  return canonicalDecisionCovers(parsed as readonly string[]);
}

export function decisionFromRowValues(values: {
  id: string;
  subject: string;
  decision: string;
  covers: string;
  basis_fingerprint: string | null;
  reason: string;
  by: string;
  client_key: string | null;
  created_at: string;
  recheck_at: string | null;
  cleared_at: string | null;
  cleared_by: string | null;
  cleared_reason: string | null;
  covers_scheme: string;
}): DecisionRecord {
  if (!isDecisionKind(values.decision)) {
    throw new Error(`decision row "${values.id}" carries unknown decision kind "${values.decision}"`);
  }
  if (!isDecisionActor(values.by)) {
    throw new Error(`decision row "${values.id}" carries unknown actor "${values.by}"`);
  }
  if (values.covers_scheme !== 'family' && values.covers_scheme !== 'pre-family') {
    throw new Error(`decision row "${values.id}" carries unknown covers scheme "${values.covers_scheme}"`);
  }
  return {
    id: values.id,
    subject: values.subject,
    decision: values.decision,
    covers: parseDecisionCovers(values.covers),
    basisFingerprint: values.basis_fingerprint,
    reason: values.reason,
    by: values.by,
    clientKey: values.client_key,
    createdAt: values.created_at,
    recheckAt: values.recheck_at,
    clearedAt: values.cleared_at,
    clearedBy: values.cleared_by,
    clearedReason: values.cleared_reason,
    coversScheme: values.covers_scheme,
  };
}
