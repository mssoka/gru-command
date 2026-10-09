import { createHash } from 'node:crypto';

/**
 * Durable directive requests — typed vocabulary (phase 3 slice).
 *
 * A Silas directive is a request to run one implementing turn on a job
 * lane. Its durability contract (chief ruling 2026-09-28, phase 3):
 *
 * - An ATOMIC intent→dispatch claim is persisted BEFORE any prompt/spawn
 *   side effect. A row exists ⇒ the request was accepted; the absence of
 *   a row ⇒ nothing happened (a crash before the insert is provably
 *   side-effect-free and safe to re-request under the same identity).
 * - `dispatching` means side effects are POSSIBLE but native admission
 *   is unknown — never read as "safe to retry". Only positive no-effect
 *   proof plus current permission justifies a retry; absence of a
 *   receipt or an expired lease does not.
 * - `admitted` means a correlated `silas.directive-sent` event bound the
 *   request to an actual minion turn. Admitted without a terminal
 *   receipt is STILL in flight/unknown after a crash: no one fabricates
 *   `job.delivered` from it.
 * - `settled`/`failed` are terminal for the request id: a retry is a NEW
 *   decision with a NEW request id, never a silent replay of consumed
 *   authorization (recovered capacity is not permission — incident
 *   PR131/287e16f2).
 * - `retired` is the guarded, audited CONTROL closure for an interrupted
 *   request: the writer ceased (server-verified) and no correlated
 *   terminal receipt exists or can be fabricated. It claims neither
 *   delivery nor no-effect; the underlying work stays unfinished and a
 *   durable continuation hold keeps automation from resuming the lane
 *   until a NEW accepted request (fresh authorization) releases it.
 *
 * Idempotency identity is the caller's stable `request_id`: the same id
 * with the same canonical payload replays to the SAME row; the same id
 * with a different payload is a CONFLICT, not a new request. The lane is
 * single-writer: while ANY live request exists for the job, ANY different
 * request id (identified or not) fails CLOSED with the live request named
 * — only a replay of that same id proceeds, so a fresh id never starts a
 * second concurrent turn.
 */

export const DIRECTIVE_STATES = ['dispatching', 'admitted', 'settled', 'failed', 'retired'] as const;
export type DirectiveState = (typeof DIRECTIVE_STATES)[number];

export function isDirectiveState(value: string): value is DirectiveState {
  return (DIRECTIVE_STATES as readonly string[]).includes(value);
}

export function isDirectiveTerminal(state: DirectiveState): boolean {
  return state === 'settled' || state === 'failed' || state === 'retired';
}

/** The states a retirement may close (still owing completion). */
export type LiveDirectiveState = 'dispatching' | 'admitted';

/** The two admission classes a retirement must keep distinct: the request
 * never produced a correlated admission, or it was admitted without ever
 * producing a terminal receipt. Neither is success; neither is no-effect. */
export type DirectiveAdmissionClass = 'admission-unknown' | 'admitted-without-terminal';

export function directiveAdmissionClass(record: Pick<DirectiveRequestRecord, 'admissionSeq'>): DirectiveAdmissionClass {
  return record.admissionSeq === null ? 'admission-unknown' : 'admitted-without-terminal';
}

/** Typed refusals of the guarded retirement transition. Every code maps to
 * HTTP 409 at the route: the request is real and the caller must change
 * state or evidence, never retry blindly. `blockers` names the live
 * ownership the service found (never caller-supplied). */
export const DIRECTIVE_RETIREMENT_REFUSAL_CODES = [
  'directive_not_live',
  'retire_conflict',
  'request_mismatch',
  'terminal_receipt_present',
  'admission_evidence_incomplete',
  'stale_head',
  'lane_unavailable',
  'live_work',
] as const;
export type DirectiveRetirementRefusalCode = (typeof DIRECTIVE_RETIREMENT_REFUSAL_CODES)[number];

export class DirectiveRetirementError extends Error {
  readonly code: DirectiveRetirementRefusalCode;
  readonly blockers: readonly string[];

  constructor(code: DirectiveRetirementRefusalCode, message: string, blockers: readonly string[] = []) {
    super(message);
    this.name = 'DirectiveRetirementError';
    this.code = code;
    this.blockers = blockers;
  }
}

/** The canonical retirement intent: the caller's binding expectations plus
 * audit provenance. The fingerprint over exactly these fields is the
 * replay-identity — a replay with changed content is a conflict, never a
 * second transition. */
export interface DirectiveRetirementIntent {
  readonly requestId: string;
  readonly expectedJobId: string;
  readonly expectedState: LiveDirectiveState;
  readonly expectedPayloadHash: string;
  readonly expectedHead: string;
  readonly reason: string;
  readonly by: string;
}

export function directiveRetirementFingerprint(intent: DirectiveRetirementIntent): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        intent.requestId,
        intent.expectedJobId,
        intent.expectedState,
        intent.expectedPayloadHash,
        intent.expectedHead,
        intent.reason,
        intent.by,
      ]),
    )
    .digest('hex');
}

/** The non-terminal states: a request that still owes completion
 * (admission unknown or terminal receipt pending). Guard checks and boot
 * reconciliation MUST query these by state — the table is append-only, so
 * an unfiltered request_id page can never be the live set. */
export const LIVE_DIRECTIVE_STATES = ['dispatching', 'admitted'] as const satisfies readonly DirectiveState[];

/** The durable record of one directive request (current state; full
 * history is the events table). */
export interface DirectiveRequestRecord {
  readonly requestId: string;
  readonly jobId: string;
  /** The directive text exactly as accepted (audit identity). */
  readonly payload: string;
  /** sha256 of the canonical payload — the conflict check. */
  readonly payloadHash: string;
  readonly state: DirectiveState;
  /** events.seq watermark at acceptance; guarded events must post-date it. */
  readonly baselineSeq: number;
  /** Who accepted/dispatched this request (provenance, not authority). */
  readonly claim: { readonly holder: string; readonly since: string } | null;
  /** The correlated `silas.directive-sent` event, once native admission landed. */
  readonly admissionSeq: number | null;
  readonly admissionMinion: string | null;
  /** The correlated terminal `job.delivered` event, once the turn settled. */
  readonly deliverySeq: number | null;
  readonly attempts: number;
  readonly failReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Retirement audit facts (null unless `state` is `retired`). */
  readonly retiredAt: string | null;
  readonly retiredBy: string | null;
  readonly retireReason: string | null;
  /** Canonical-input fingerprint of the one retirement decision. */
  readonly retireFingerprint: string | null;
  /** The binding expectation the decision was made with — exposed so a
   * lost-response retry can reconstruct the identical canonical intent. */
  readonly retireExpectedState: LiveDirectiveState | null;
  readonly retireExpectedHead: string | null;
  /** Continuation hold: set to the identity of the fresh accepted request
   * that superseded this retirement; null while the hold is open. */
  readonly holdReleasedBy: string | null;
  readonly holdReleasedAt: string | null;
  /** The required work revision this request was composed with (owner
   * rule 4): its delivery carries it as the service-bound acknowledgement.
   * null = accepted before work revisions existed. */
  readonly workRevision: number | null;
}

/** One open (or released) continuation hold created by a retirement. The
 * presence of an unreleased hold fences lane automation (review arming,
 * digest offers) until a fresh directive/re-brief request is accepted. */
export interface DirectiveRecoveryHold {
  readonly jobId: string;
  readonly requestId: string;
  readonly admissionClass: DirectiveAdmissionClass;
  readonly retiredAt: string;
  readonly retiredBy: string;
  readonly reason: string;
  readonly releasedBy: string | null;
  readonly releasedAt: string | null;
}
