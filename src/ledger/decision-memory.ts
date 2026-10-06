import { canonicalIsoTimestamp } from './obligations.js';

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
}

/** Bounds — every write boundary validates against these. */
export const DECISION_SUBJECT_MAX_LENGTH = 256;
export const DECISION_REASON_MAX_LENGTH = 2_000;
export const DECISION_FINGERPRINT_MAX_LENGTH = 256;
export const DECISION_SIGNAL_MAX_LENGTH = 64;
export const DECISION_SIGNALS_MAX_COUNT = 16;

/** A subject is a kind-prefixed stable key: `job:j-123`,
 * `pr:mssoka/gru-command#148`, `incident:pr-conflict:<hash>`. The prefix
 * makes the subject vocabulary explicit; the key part stays opaque. */
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
  return value;
}

/** Signal kinds are short bounded tokens (`pr-conflict`, `ci-failed`). */
export function validateDecisionSignal(value: string): string {
  if (value.length === 0 || value.length > DECISION_SIGNAL_MAX_LENGTH) {
    throw new Error(`decision signal must be 1-${DECISION_SIGNAL_MAX_LENGTH} characters`);
  }
  if (/[\p{Cc}]/u.test(value)) {
    throw new Error('decision signal must not contain control characters');
  }
  return value;
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
        : canonicalIsoTimestamp(input.recheckAt, 'decision recheckAt'),
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
}): DecisionRecord {
  if (!isDecisionKind(values.decision)) {
    throw new Error(`decision row "${values.id}" carries unknown decision kind "${values.decision}"`);
  }
  if (!isDecisionActor(values.by)) {
    throw new Error(`decision row "${values.id}" carries unknown actor "${values.by}"`);
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
  };
}
