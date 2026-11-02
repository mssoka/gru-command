import type { LedgerApi, JobRecord } from '../ledger/api.js';
import {
  CLOSEOUT_ACTOR,
  CLOSEOUT_REASON_MAX_CHARS,
  TerminalLiveWorkError,
  closeoutBlockerFingerprint,
  closeoutRequester,
  type CloseoutBlocker,
  type CloseoutIntent,
  type CloseoutMode,
  type CloseoutSupersededReason,
} from '../ledger/closeouts.js';
import { DirectiveRetirementError, type DirectiveRequestRecord } from '../ledger/directives.js';
import type { LogLevel } from '../logger.js';
import type { PacingGate } from '../runtime/pacing.js';
import { retireInterruptedDirectiveFromRoute, retirementRouteEvidence, type RetirementRouteInput } from './directive-recovery.js';
import type { WorktreePort } from './worktree-port.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Canceled-request closeout (#523).
 *
 * Binning a job whose only live request was deferred before reaching its
 * worker used to take two manual calls (`/retire`, then the status write) and
 * left the request's recovery card active. The service now executes it: the
 * existing binning request is the only authority input (Gru's discard
 * judgment or the owner's explicit cancel, recorded through
 * `POST /api/jobs/{id}/status`); this class adds no authority and never
 * writes `by: "owner"`.
 *
 * Three durable steps, each one transaction (see `LedgerApi.beginCloseout`):
 * S1 the intent, S2 the guarded retirement, S3 the bin + card resolution. A
 * crash leaves the intent `open`, which means resume. The closeout never
 * claims a dispatch, spawns or prompts.
 *
 * A `keep-parked` intent (#564) runs the same S1 and S2 and a different S3
 * (S3'): settle this request's recovery obligation, resolve its card, complete
 * the intent — and leave the job parked, its hold in place. The mode is stored
 * on the intent because a resume replays from the row alone and `job_status`
 * cannot tell the two apart.
 */

export type CloseoutStep = 'intent' | 'retire';

/** What a caller of a closeout path asks for beyond the wire body. */
export interface BinningRequestOptions {
  /** Which S3 the caller owes; absent = `bin`, today's closeout. */
  readonly mode?: CloseoutMode;
  /** The request a request-scoped caller names. Its own completed intent is
   * then the only repeat answered: a parked job survives the closeout, so a
   * later request could otherwise be handed an earlier request's completion. */
  readonly requestId?: string;
}

export interface CanceledRequestCloseoutDeps {
  readonly ledger: LedgerApi;
  /** The worktree manager itself, not the Silas ops surface: the closeout
   * must work whether or not Silas is hosted. */
  readonly worktrees: Pick<WorktreePort, 'listWorktrees'>;
  /** Fresh supervisor ownership, including scheduled backoff/retry turns. */
  readonly pendingProducerBlockers: (jobId: string) => readonly string[];
  /** Pace-gate view: a worker turn queued for the job is live producer evidence. */
  readonly workerGate?: Pick<PacingGate, 'view'>;
  readonly log?: Log;
  /** Test-only seam: runs after S1 and after S2 have committed. A throw
   * simulates a crash at that point; the intent stays `open`. */
  readonly afterStep?: (step: CloseoutStep, intent: CloseoutIntent) => void;
}

export interface CloseoutHttpResult {
  readonly status: number;
  readonly body: unknown;
}

export interface CloseoutEvaluation {
  /** `closeout` when the job meets the eligibility rule for a request. */
  readonly path: 'closeout' | 'binning';
  readonly request: DirectiveRequestRecord | null;
  /** Why the closeout would refuse right now; empty on the `binning` path. */
  readonly blockers: readonly CloseoutBlocker[];
}

export interface CloseoutResumeReport {
  readonly examined: number;
  readonly completed: number;
  readonly stopped: number;
  readonly superseded: number;
  /** `stopped` intents whose blocker fingerprint has not changed. */
  readonly untouched: number;
  readonly failures: readonly { readonly closeoutId: string; readonly error: string }[];
}

type DriveOutcome =
  | { readonly kind: 'complete'; readonly intent: CloseoutIntent; readonly job: JobRecord }
  | { readonly kind: 'stopped'; readonly intent: CloseoutIntent }
  | { readonly kind: 'superseded'; readonly intent: CloseoutIntent };

/** The wire shape of one intent (readback and the 200 `closeout` member). */
export function closeoutIntentView(intent: CloseoutIntent): Record<string, unknown> {
  return {
    id: intent.closeoutId,
    job_id: intent.jobId,
    request_id: intent.requestId,
    generation: intent.generation,
    state: intent.state,
    superseded_reason: intent.supersededReason,
    mode: intent.mode,
    requested_by: intent.requestedBy,
    reason: intent.reason,
    payload_hash: intent.payloadHash,
    job_status: intent.jobStatus,
    intent_seq: intent.intentSeq,
    blockers: intent.blockers,
    blocker_fingerprint: intent.blockerFingerprint,
    created_at: intent.createdAt,
    updated_at: intent.updatedAt,
  };
}

/** A guard's typed refusal as blockers that keep the guard's own code: one
 * per named blocker, or the refusal itself when it names none. */
function blockersOf(error: DirectiveRetirementError): readonly CloseoutBlocker[] {
  return error.blockers.length > 0
    ? error.blockers.map((detail) => ({ code: error.code, detail }))
    : [{ code: error.code, detail: error.message }];
}

function refusedBody(blockers: readonly CloseoutBlocker[]): CloseoutHttpResult {
  return { status: 409, body: { error: 'request_closeout_refused', blockers } };
}

function stoppedBody(intent: CloseoutIntent): CloseoutHttpResult {
  return { status: 409, body: { error: 'request_closeout_stopped', blockers: intent.blockers } };
}

function supersededBody(reason: CloseoutSupersededReason | null): CloseoutHttpResult {
  return { status: 409, body: { error: 'request_closeout_superseded', superseded_reason: reason } };
}

function completeBody(job: JobRecord, intent: CloseoutIntent): CloseoutHttpResult {
  return { status: 200, body: { ...job, closeout: { state: 'complete', id: intent.closeoutId, generation: intent.generation } } };
}

export class CanceledRequestCloseout {
  private readonly deps: CanceledRequestCloseoutDeps;

  constructor(deps: CanceledRequestCloseoutDeps) {
    this.deps = deps;
  }

  private get route(): RetirementRouteInput & { readonly ledger: LedgerApi } {
    const { ledger, worktrees, pendingProducerBlockers, workerGate } = this.deps;
    return { ledger, worktrees, pendingProducerBlockers, ...(workerGate !== undefined ? { workerGate } : {}) };
  }

  /** THE eligibility-and-guard function: the executor and the readback both
   * use it. It runs exactly the guard set `/retire` evaluates for the
   * request (the route-level lane, supervisor and pace-queue checks, then
   * the ledger's `retirementPreflight`) and no other job-level check:
   * `terminalLiveWorkBlockers` lists the request itself while it is
   * `dispatching`, so it stays inside `setJobStatus` as the S3 race refusal. */
  evaluateCloseout(jobId: string): CloseoutEvaluation {
    const request = this.deps.ledger.closeoutCandidate(jobId);
    if (request === null) return { path: 'binning', request: null, blockers: [] };
    return { path: 'closeout', request, blockers: this.retirementBlockers(request) };
  }

  private retirementBlockers(request: DirectiveRequestRecord): readonly CloseoutBlocker[] {
    try {
      const { lane } = retirementRouteEvidence(this.route, request.jobId);
      this.deps.ledger.retirementPreflight(request.requestId, lane.id);
      return [];
    } catch (error) {
      if (error instanceof DirectiveRetirementError) return blockersOf(error);
      throw error;
    }
  }

  /** The readback of one request: which path a binning request would take
   * for its job, whether the closeout would proceed, the current intent's
   * mode, and the request's latest intent. An `open` or `stopped` intent keeps
   * its job on the closeout path (a binning request resumes it) and what
   * refuses is the step it waits on: after S2 the live work binning would
   * meet — or, for a `keep-parked` intent, the gate duty only the duty's own
   * resolution or a terminal status can discharge. An intent whose basis no
   * longer holds reads as not eligible, because the next binning request
   * supersedes it instead of completing it. */
  describe(requestId: string): { readonly path: 'closeout' | 'binning'; readonly eligible: boolean; readonly blockers: readonly CloseoutBlocker[]; readonly mode: CloseoutMode | null; readonly intent: CloseoutIntent | null } {
    const { ledger } = this.deps;
    const row = ledger.getDirective(requestId);
    const intent = ledger.latestCloseoutForRequest(requestId);
    if (row === null) return { path: 'binning', eligible: false, blockers: [], mode: intent?.mode ?? null, intent };
    const active = ledger.activeCloseoutForJob(row.jobId);
    if (active !== null) {
      const waiting = this.currentBlockers(active);
      const stale = waiting.length > 0 ? null : ledger.closeoutStaleness(active.closeoutId);
      const blockers = stale === null ? waiting
        : [{ code: 'intent_stale', detail: `the closeout intent no longer describes the job (${stale}) — the next binning request supersedes it` }];
      return { path: 'closeout', eligible: blockers.length === 0, blockers, mode: active.mode, intent };
    }
    const evaluation = this.evaluateCloseout(row.jobId);
    return { path: evaluation.path, eligible: evaluation.path === 'closeout' && evaluation.blockers.length === 0, blockers: evaluation.blockers,
      mode: intent?.mode ?? null, intent };
  }

  /** Route a binning request (`POST /api/jobs/{id}/status` `{"status":"binned"}`,
   * mode `bin`) or a keep-parked closeout request (`POST
   * /api/silas/directives/{request}/closeout`, mode `keep-parked`). `null`
   * falls through to today's `ledger.setJobStatus`, unchanged. */
  requestBinning(jobId: string, body: Record<string, unknown>, asked: BinningRequestOptions = {}): CloseoutHttpResult | null {
    const { ledger } = this.deps;
    const mode = asked.mode ?? 'bin';
    // 1. Validate the body: a reason is at most 500 characters, whatever the job.
    const rawReason = body['reason'];
    const invalidReason: CloseoutHttpResult = { status: 400, body: { error: 'invalid_reason', detail: `reason must be a string of at most ${CLOSEOUT_REASON_MAX_CHARS} characters` } };
    if (typeof rawReason === 'string' && Array.from(rawReason).length > CLOSEOUT_REASON_MAX_CHARS) return invalidReason;
    const reason = typeof rawReason === 'string' && rawReason !== '' ? rawReason : null;
    // 2. An active intent has the lifecycle — but only for a caller that asks
    // for the same S3: resuming another mode's intent would bin a request that
    // asked to keep the hold, or finish one that asked to bin.
    const active = ledger.activeCloseoutForJob(jobId);
    if (active !== null && active.mode !== mode) {
      return { status: 409, body: { error: 'request_closeout_mode_conflict', active_mode: active.mode, closeout_id: active.closeoutId } };
    }
    // 3. `keep-parked` adds nothing to the job: it finishes the request and
    // leaves the hold in place, so the hold is the mode's premise.
    const job = ledger.getJob(jobId);
    if (mode === 'keep-parked' && job?.status !== 'parked') {
      return { status: 409, body: { error: 'job_not_parked',
        detail: `job "${jobId}" is ${job?.status ?? 'unknown'}, not parked — the keep-parked closeout never changes the job status, so the hold must be in place first` } };
    }
    // 4. An open or stopped intent has the lifecycle.
    if (active !== null) {
      const resumed = this.resume(active);
      // Unchanged blockers: the recorded refusal stands, nothing is written.
      if (resumed === null) return stoppedBody(active);
      // The job reached `binned` by another writer: the binned retry stays the idempotent 200.
      if (resumed.kind === 'superseded' && ledger.getJob(jobId)?.status === 'binned') return null;
      return this.respond(resumed);
    }
    // 5. A completed closeout answers again with its original member.
    if (job !== null && job.status === 'binned') {
      const latest = ledger.latestCloseoutForJob(jobId);
      if (latest !== null && latest.state === 'complete') return completeBody(job, latest);
    }
    // A keep-parked completion leaves the job parked, so the repeat is answered
    // from the intent the caller named — never from another request's.
    if (asked.requestId !== undefined && mode === 'keep-parked' && job !== null) {
      const latest = ledger.latestCloseoutForRequest(asked.requestId);
      if (latest !== null && latest.jobId === jobId && latest.state === 'complete' && latest.mode === 'keep-parked') return completeBody(job, latest);
    }
    // 6. An eligible job takes the closeout; 7. anything else falls through.
    const evaluation = this.evaluateCloseout(jobId);
    if (evaluation.request === null) return null;
    // The closeout stores the reason, so a malformed one is refused here and nowhere else.
    if (rawReason !== undefined && rawReason !== null && typeof rawReason !== 'string') return invalidReason;
    if (evaluation.blockers.length > 0) return refusedBody(evaluation.blockers);
    // S1 evaluates once more inside its transaction: the same function.
    const begun = ledger.beginCloseout({ jobId, requestId: evaluation.request.requestId, mode, requestedBy: closeoutRequester(body['by']), reason,
      evaluate: () => this.evaluateCloseout(jobId).blockers });
    if (begun.kind === 'refused') return refusedBody(begun.blockers);
    this.deps.afterStep?.('intent', begun.intent);
    return this.respond(this.drive(begun.intent));
  }

  /** Complete every `open` intent and retry every `stopped` one whose
   * blocker fingerprint has changed. A failing intent is reported and logged
   * and stays `open` for the next pass: one poisoned intent must not stop the
   * service from booting or the deterministic pass from reaching other work. */
  resumePending(): CloseoutResumeReport {
    const counts = { examined: 0, completed: 0, stopped: 0, superseded: 0, untouched: 0 };
    const failures: { closeoutId: string; error: string }[] = [];
    for (const closeoutId of this.deps.ledger.listActiveCloseoutIds()) {
      counts.examined += 1;
      try {
        const intent = this.deps.ledger.getCloseout(closeoutId) as CloseoutIntent;
        const outcome = this.resume(intent);
        if (outcome === null) counts.untouched += 1;
        else if (outcome.kind === 'complete') counts.completed += 1;
        else if (outcome.kind === 'stopped') counts.stopped += 1;
        else counts.superseded += 1;
      } catch (error) {
        failures.push({ closeoutId, error: String(error) });
        this.deps.log?.('error', 'canceled-request closeout could not resume', { closeout: closeoutId, error: String(error) });
      }
    }
    return { ...counts, failures };
  }

  /** Resume one active intent. A `stopped` intent whose blockers are
   * unchanged is left alone (`null`): no event, no card. */
  private resume(intent: CloseoutIntent): DriveOutcome | null {
    if (intent.state === 'stopped' && closeoutBlockerFingerprint(this.currentBlockers(intent)) === intent.blockerFingerprint) return null;
    return this.drive(intent);
  }

  /** What would refuse the step the intent is waiting on: the retirement
   * guards while the request is still `dispatching`, then the S3 the intent
   * owes — the live work binning refuses, or the gate duty a keep-parked
   * closeout refuses. An intent that is stale has none: `drive` supersedes it. */
  private currentBlockers(intent: CloseoutIntent): readonly CloseoutBlocker[] {
    const request = this.deps.ledger.getDirective(intent.requestId);
    if (request === null) return [];
    if (request.state === 'dispatching') return this.retirementBlockers(request);
    if (request.state === 'retired') {
      return intent.mode === 'keep-parked'
        ? this.deps.ledger.closeoutKeepParkedBlockers(intent.closeoutId)
        : this.deps.ledger.closeoutBinBlockers(intent.jobId);
    }
    return [];
  }

  private respond(outcome: DriveOutcome): CloseoutHttpResult {
    return outcome.kind === 'complete' ? completeBody(outcome.job, outcome.intent)
      : outcome.kind === 'stopped' ? stoppedBody(outcome.intent) : supersededBody(outcome.intent.supersededReason);
  }

  /** Steps S2 and S3 (or S3', by the intent's mode) for an active intent,
   * from wherever it stopped. */
  private drive(intent: CloseoutIntent): DriveOutcome {
    const { ledger } = this.deps;
    const guard = ledger.guardCloseoutRetire(intent.closeoutId);
    if (!guard.ok) return { kind: 'superseded', intent: guard.intent };
    if (!guard.retired) {
      const refusal = this.retire(guard.intent);
      if (refusal !== null) return { kind: 'stopped', intent: ledger.stopCloseout(intent.closeoutId, refusal) };
      this.deps.afterStep?.('retire', guard.intent);
    }
    const completed = guard.intent.mode === 'keep-parked' ? ledger.completeCloseoutKeepParked(intent.closeoutId) : this.completeBinning(intent.closeoutId);
    if (completed.kind === 'refused') return { kind: 'stopped', intent: ledger.stopCloseout(intent.closeoutId, completed.blockers) };
    if (completed.kind === 'superseded') return { kind: 'superseded', intent: completed.intent };
    this.deps.log?.('info', 'canceled-request closeout complete', { closeout: completed.intent.closeoutId, request: completed.intent.requestId,
      job: completed.intent.jobId, generation: completed.intent.generation, mode: completed.intent.mode });
    return { kind: 'complete', intent: completed.intent, job: completed.job };
  }

  /** S3 for a `bin` intent. Live work that appeared after S2 makes
   * `setJobStatus` refuse (`TerminalLiveWorkError`): the step rolls back and
   * the caller records the intent stopped. A keep-parked intent never writes a
   * job status, so that refusal cannot apply to it. */
  private completeBinning(closeoutId: string):
    | { readonly kind: 'complete'; readonly intent: CloseoutIntent; readonly job: JobRecord }
    | { readonly kind: 'superseded'; readonly intent: CloseoutIntent }
    | { readonly kind: 'refused'; readonly blockers: readonly CloseoutBlocker[] } {
    try {
      return this.deps.ledger.completeCloseout(closeoutId);
    } catch (error) {
      if (!(error instanceof TerminalLiveWorkError)) throw error;
      return { kind: 'refused', blockers: error.blockers.map((detail) => ({ code: 'live_work', detail })) };
    }
  }

  /** S2: the guarded retirement, built from fresh state at this moment: the
   * readback's `expected_*` fields and the lane checkout's actual HEAD,
   * attributed to the closeout. Returns the guard that refused, or null. */
  private retire(intent: CloseoutIntent): readonly CloseoutBlocker[] | null {
    const { ledger } = this.deps;
    const row = ledger.getDirective(intent.requestId) as DirectiveRequestRecord;
    try {
      const { resolvedHead } = retirementRouteEvidence(this.route, row.jobId);
      const authority = ledger.directiveCurrentAuthority(row.jobId);
      const obligation = ledger.recoveryObligation(row.jobId, 'directive', row.requestId);
      const base = `canceled heist: its binning closes out the deferred request ${row.requestId} (requested by ${intent.requestedBy})`;
      retireInterruptedDirectiveFromRoute({
        ...this.route,
        requestId: row.requestId,
        expected: {
          jobId: row.jobId,
          state: 'dispatching',
          payloadHash: row.payloadHash,
          head: resolvedHead,
          context: {
            expectedGeneration: obligation?.generation ?? null,
            expectedPlanRevision: obligation?.planRevision ?? null,
            expectedObligationState: obligation?.state ?? null,
            expectedAuthorityEpoch: authority.authorityEpoch,
            expectedWorkRevision: authority.workRevision,
            expectedContractSha256: authority.contractSha256,
          },
        },
        reason: intent.reason === null ? base : `${base}: ${intent.reason}`,
        by: CLOSEOUT_ACTOR,
      });
      return null;
    } catch (error) {
      if (error instanceof DirectiveRetirementError) return blockersOf(error);
      throw error;
    }
  }
}

/** Boot recovery: the directive-progress reconsideration, then the closeout
 * resume. In this order the reconsideration finds a pending closeout's
 * request fenced (it skips it) and the resume finishes the cancel. */
export function runBootDirectiveRecovery(deps: {
  readonly directiveProgress: { reconsider(): void };
  readonly closeout: Pick<CanceledRequestCloseout, 'resumePending'>;
}): CloseoutResumeReport {
  deps.directiveProgress.reconsider();
  return deps.closeout.resumePending();
}

/** The board's `binningCloseout` option, bound to a closeout that may not
 * exist yet (it is built after the board): `null` falls through to today's
 * binning until it does. */
export function binningCloseoutRoute(
  getCloseout: () => Pick<CanceledRequestCloseout, 'requestBinning'> | undefined,
): (jobId: string, body: Record<string, unknown>) => CloseoutHttpResult | null {
  return (jobId, body) => getCloseout()?.requestBinning(jobId, body) ?? null;
}
