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
 *
 * Idempotency identity is the caller's stable `request_id`: the same id
 * with the same canonical payload replays to the SAME row; the same id
 * with a different payload is a CONFLICT, not a new request. Callers
 * that cannot supply an id fail CLOSED on an ambiguous repeat while
 * another request for the job is live — they never silently duplicate.
 */

export const DIRECTIVE_STATES = ['dispatching', 'admitted', 'settled', 'failed'] as const;
export type DirectiveState = (typeof DIRECTIVE_STATES)[number];

export function isDirectiveState(value: string): value is DirectiveState {
  return (DIRECTIVE_STATES as readonly string[]).includes(value);
}

export function isDirectiveTerminal(state: DirectiveState): boolean {
  return state === 'settled' || state === 'failed';
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
}
