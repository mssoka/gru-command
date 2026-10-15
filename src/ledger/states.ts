/**
 * Ledger state machines (E6 story 1) — explicit transition maps.
 *
 * Every status the ledger records walks one of these machines; illegal
 * transitions throw (the ledger is the API of record — a silent coercion
 * would forge history). Recoverable states (blocked/parked) return to a
 * legal resume point; terminal states never leave.
 */

export const JOB_STATUSES = [
  'dispatched',
  'working',
  'delivered',
  'in-review',
  'blocked',
  'parked',
  'merged',
  'done',
  'binned',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * The terminal job statuses, declared ONCE: the union type, the Set and
 * the `isJobTerminal` predicate all derive from this list, so a future
 * terminal status cannot land in the Set while the predicate's union
 * narrows to something else (the web cross-build alarm reads this
 * declaration too).
 */
const TERMINAL_JOB_STATUS_LIST = ['merged', 'done', 'binned'] as const;
export type TerminalJobStatus = (typeof TERMINAL_JOB_STATUS_LIST)[number];
const JOB_TERMINAL: ReadonlySet<JobStatus> = new Set(TERMINAL_JOB_STATUS_LIST);

/**
 * dispatched → working → delivered → in-review → merged|done;
 * blocked/parked are recoverable side-states. `delivered` is the settle
 * point: the minion's briefing turn completed (ok) and no PR is on
 * record yet; a registered PR moves it to `in-review`. `working →
 * in-review` stays legal for a PR registered before the turn settles.
 * A Silas follow-through (directive or re-brief) re-opens a delivered
 * lane (`delivered → working`): the fresh attempt supersedes the prior
 * delivery. `merged` has NO internal writer: merge detection belongs to
 * the external sweep (Silas) — the remaining external caller.
 *
 * `binned` is the terminal DISCARDED state (owner/chief cancelled a
 * lane): every non-terminal status may be binned, and `binned` never
 * leaves — it is terminal on the same contract as merged/done (no
 * resumption, obligations close as abandonment). merged/done can NOT be
 * binned: their history is already closed truth.
 */
const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  dispatched: ['working', 'blocked', 'parked', 'binned'],
  working: ['delivered', 'in-review', 'blocked', 'parked', 'done', 'binned'],
  delivered: ['working', 'in-review', 'blocked', 'parked', 'done', 'binned'],
  'in-review': ['working', 'blocked', 'parked', 'merged', 'done', 'binned'],
  blocked: ['dispatched', 'working', 'in-review', 'parked', 'binned'],
  parked: ['dispatched', 'working', 'in-review', 'blocked', 'binned'],
  merged: [],
  done: [],
  binned: [],
};

export const ROUND_STATUSES = ['pending', 'live', 'verdict-posted', 'aborted'] as const;
export type RoundStatus = (typeof ROUND_STATUSES)[number];

const ROUND_TERMINAL: ReadonlySet<RoundStatus> = new Set(['verdict-posted', 'aborted']);

const ROUND_TRANSITIONS: Readonly<Record<RoundStatus, readonly RoundStatus[]>> = {
  pending: ['live', 'aborted'],
  live: ['verdict-posted', 'aborted'],
  'verdict-posted': [],
  aborted: [],
};

export const ROUND_VERDICTS = ['approved', 'changes-requested', 'commented'] as const;
export type RoundVerdict = (typeof ROUND_VERDICTS)[number];

export const LENS_STATES = ['pending', 'live', 'done', 'error'] as const;
export type LensState = (typeof LENS_STATES)[number];

const LENS_TRANSITIONS: Readonly<Record<LensState, readonly LensState[]>> = {
  pending: ['live', 'error', 'done'],
  live: ['done', 'error'],
  done: [],
  error: [],
};

/** Durable follow-through obligation lifecycle (blocked-heist follow-
 * through, phase 2). `open` owes its next action now; `waiting` has
 * delegated/armed a phase and expects a typed receipt (deadline bounded);
 * `suspended` is an explicit human hold (parking/owner hold) that only an
 * explicit durable resume leaves; `settled` closed WITH accepted evidence
 * (executed action or accepted gate); `closed` ended without a settlement
 * claim (superseded/cancelled/job-terminal) — history is preserved either
 * way. settled/closed are terminal: an obligation never resurrects; a new
 * incident on the same lane is a NEW obligation. */
export const OBLIGATION_STATES = ['open', 'waiting', 'settled', 'suspended', 'closed'] as const;
export type ObligationState = (typeof OBLIGATION_STATES)[number];

const OBLIGATION_TERMINAL: ReadonlySet<ObligationState> = new Set(['settled', 'closed']);

const OBLIGATION_TRANSITIONS: Readonly<Record<ObligationState, readonly ObligationState[]>> = {
  open: ['waiting', 'settled', 'suspended', 'closed'],
  waiting: ['open', 'settled', 'suspended', 'closed'],
  settled: [],
  suspended: ['open', 'closed'],
  closed: [],
};

function assertTransition<T extends string>(
  machine: string,
  from: T,
  to: T,
  legal: Readonly<Record<T, readonly T[]>>,
): void {
  const allowed = legal[from];
  if (allowed === undefined) {
    throw new Error(`${machine} illegal status "${from}" (not a known status)`);
  }
  if (!allowed.includes(to)) {
    throw new Error(`${machine} illegal transition ${from} → ${to} (legal: ${allowed.join(', ') || 'none — terminal'})`);
  }
}

export function isJobTerminal(status: JobStatus): status is TerminalJobStatus {
  return JOB_TERMINAL.has(status);
}

/** Raw-string form of the predicate (parsers validating persisted values
 * use the SAME declaration instead of re-typing the terminal names). */
export function isTerminalJobStatus(value: string): value is TerminalJobStatus {
  return (TERMINAL_JOB_STATUS_LIST as readonly string[]).includes(value);
}

/** The terminal statuses as a list — the one source every SQL IN-list (and
 * any future consumer) derives from, so the terminal set cannot drift
 * between the predicate and a hand-written literal. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = JOB_STATUSES.filter((status) =>
  JOB_TERMINAL.has(status),
);

export function isRoundTerminal(status: RoundStatus): boolean {
  return ROUND_TERMINAL.has(status);
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  assertTransition('job', from, to, JOB_TRANSITIONS);
}

/** The audited administrative-closeout edge (owner ruling j-1115): a parked
 * PR-backed lane whose provider PR is independently recorded CLOSED without
 * merge closes truthfully as `done`. Deliberately NOT part of
 * `JOB_TRANSITIONS`: the generic status write keeps refusing parked → done,
 * and only the guarded, evidence-bound operation
 * (`LedgerApi.adminCloseParkedJob`) admits this edge. */
export function assertAdminCloseoutTransition(from: JobStatus, to: JobStatus): void {
  if (from === 'parked' && to === 'done') return;
  throw new Error(`job administrative closeout ${from} → ${to} is not admitted (only parked → done)`);
}

export function assertRoundTransition(from: RoundStatus, to: RoundStatus): void {
  assertTransition('round', from, to, ROUND_TRANSITIONS);
}

export function assertLensTransition(from: LensState, to: LensState): void {
  assertTransition('lens', from, to, LENS_TRANSITIONS);
}

export function isJobStatus(value: string): value is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(value);
}

export function isRoundStatus(value: string): value is RoundStatus {
  return (ROUND_STATUSES as readonly string[]).includes(value);
}

export function isRoundVerdict(value: string): value is RoundVerdict {
  return (ROUND_VERDICTS as readonly string[]).includes(value);
}

export function isLensState(value: string): value is LensState {
  return (LENS_STATES as readonly string[]).includes(value);
}

export function isObligationState(value: string): value is ObligationState {
  return (OBLIGATION_STATES as readonly string[]).includes(value);
}

export function isObligationTerminal(state: ObligationState): boolean {
  return OBLIGATION_TERMINAL.has(state);
}

export function assertObligationTransition(from: ObligationState, to: ObligationState): void {
  assertTransition('obligation', from, to, OBLIGATION_TRANSITIONS);
}
