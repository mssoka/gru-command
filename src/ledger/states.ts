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
  'in-review',
  'blocked',
  'parked',
  'merged',
  'done',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const JOB_TERMINAL: ReadonlySet<JobStatus> = new Set(['merged', 'done']);

/** dispatched → working → in-review → merged|done; blocked/parked are recoverable side-states. */
const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  dispatched: ['working', 'blocked', 'parked'],
  working: ['in-review', 'blocked', 'parked', 'done'],
  'in-review': ['working', 'blocked', 'parked', 'merged', 'done'],
  blocked: ['dispatched', 'working', 'in-review', 'parked'],
  parked: ['dispatched', 'working', 'in-review', 'blocked'],
  merged: [],
  done: [],
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

export function isJobTerminal(status: JobStatus): boolean {
  return JOB_TERMINAL.has(status);
}

export function isRoundTerminal(status: RoundStatus): boolean {
  return ROUND_TERMINAL.has(status);
}

export function assertJobTransition(from: JobStatus, to: JobStatus): void {
  assertTransition('job', from, to, JOB_TRANSITIONS);
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
