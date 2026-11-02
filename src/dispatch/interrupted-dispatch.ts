import type { LedgerApi } from '../ledger/api.js';
import type { JobStatus } from '../ledger/states.js';
import type { LogLevel } from '../logger.js';
import type { FollowThroughNotifications } from './obligations.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/** The durable note every interrupted initial dispatch carries. The wording
 * matches the pipeline's `surfaceInterruptedStartup` obligation, so an
 * operator who has resolved one already knows this one. */
export const INTERRUPTED_DISPATCH_NOTE =
  'dispatched before any minion started — no worker ever started; resolve the interrupted dispatch and re-arm';

/** Candidates examined per page. A crash in the dispatch window is rare, so
 * one small page covers a boot; the page loop is the bound, not a cursor. */
const PAGE_SIZE = 100;
/** Hard page cap: an unbounded pass would let a large damaged ledger hold the
 * boot sequence. Whatever is left is examined on the next trigger. */
const MAX_PAGES = 5;
/**
 * The facts ONE candidate is judged on, each read by the caller from the
 * durable record. Kept as a plain data shape so the layer-2 decision is pure
 * and independently pinnable (the SQL pre-filter is layer 1).
 */
export interface InterruptedDispatchEvidence {
  readonly status: JobStatus;
  readonly workerStarted: boolean;
  readonly handoff: boolean;
  readonly activeLane: boolean;
  readonly admissions: readonly string[];
  readonly laneOwner: string | null;
  readonly openProviderWaits: number;
  readonly pipelineAdmitting: boolean;
  readonly unsettledVerification: boolean;
}

export interface InterruptedDispatchVerdict {
  readonly block: boolean;
  /** Why the candidate was skipped; null when `block` is true. */
  readonly reason: string | null;
}

/**
 * The layer-2 decision over facts the caller already read: is this `working`
 * job an interrupted INITIAL dispatch (committed, lane created, no minion
 * ever) that must be surfaced as blocked?
 *
 * Every guard here protects live work, in cheapest-first order — the
 * in-memory admission first, then the durable lane/worker evidence, then the
 * ownership claims (a continuation lane owner, an open provider wait, the
 * pipeline's own admission claim) and finally the verification run. Exported
 * so a test pins each guard without going through the SQL pre-filter: a
 * future divergence in the "too strict" direction is a silent hang, which is
 * exactly what this file must never do quietly.
 */
export function interruptedDispatchVerdict(evidence: InterruptedDispatchEvidence): InterruptedDispatchVerdict {
  if (evidence.status !== 'working') {
    return { block: false, reason: `job status is ${evidence.status}, not working` };
  }
  // In-memory: a dispatch holding its admission has not finished failing yet.
  if (evidence.admissions.length > 0) {
    return { block: false, reason: `in-flight dispatch admission (${evidence.admissions.join(', ')})` };
  }
  if (!evidence.activeLane) {
    return { block: false, reason: 'no active job lane' };
  }
  if (evidence.workerStarted) {
    return { block: false, reason: 'a minion started for this job' };
  }
  if (!evidence.handoff) {
    return { block: false, reason: 'no job.handoff event — the dispatch never reached its handoff' };
  }
  if (evidence.laneOwner !== null) {
    return { block: false, reason: evidence.laneOwner };
  }
  if (evidence.openProviderWaits > 0) {
    return { block: false, reason: `${evidence.openProviderWaits} open provider wait(s) hold the lane` };
  }
  if (evidence.pipelineAdmitting) {
    return { block: false, reason: 'the pipeline owns this dispatch (entry state admitting)' };
  }
  if (evidence.unsettledVerification) {
    // A lane interrupted with an older unsettled run stays `working`: that is
    // the stop/verification concern (#559), not an interrupted dispatch.
    return { block: false, reason: 'an unsettled verification run holds the lane' };
  }
  return { block: true, reason: null };
}

export interface InterruptedDispatchDeps {
  readonly ledger: Pick<
    LedgerApi,
    | 'listInterruptedDispatchCandidates'
    | 'jobRowid'
    | 'getJob'
    | 'hasLiveJobLane'
    | 'listJobAdmissions'
    | 'jobHasWorkerStart'
    | 'latestJobEvent'
    | 'getPipelineEntry'
    | 'creationContinuationLaneOwner'
    | 'listOpenProviderWaitsForJob'
    | 'hasUnsettledVerificationRun'
    | 'setJobStatus'
    | 'noteJob'
  >;
  readonly notifications: FollowThroughNotifications;
  readonly log?: Log;
}

export interface InterruptedDispatchReport {
  /** Candidates the pre-filter returned. */
  readonly examined: number;
  /** Jobs this pass surfaced as blocked (status + note + one card). */
  readonly blocked: readonly string[];
  /** Candidates a guard excluded, each entry naming the guard's reason. */
  readonly skipped: readonly string[];
  /** Candidates whose writes threw (retried on the next pass). */
  readonly failed: number;
}

/**
 * Surface an initial dispatch interrupted between its recorded handoff and
 * its first minion (issue #560, #503 P2).
 *
 * A crash inside the dispatch window — after `job.handoff` + `working`, after
 * the job lane exists, and before any minion spawned — leaves the job
 * `working` forever: the in-process failure handler never runs, the
 * pipeline's `surfaceInterruptedStartup` needs an `admitting` entry a plain
 * `POST /api/dispatch` never has, and Silas's stall detector excludes
 * initial dispatch. This pass is the missing witness: it blocks such a lane
 * with a durable note and ONE action-required card, so recovery is owed
 * visibly instead of hanging.
 *
 * SYNCHRONY IS LOAD-BEARING. Every ledger call here is synchronous, so the
 * guard block and the write that follows it run in one JavaScript turn: a
 * concurrent dispatch cannot take its admission or create its lane between
 * the guard and the write. Do not add an `await` to this file — it would
 * reintroduce exactly the window this pass reports on.
 *
 * It never dispatches, sweeps, disposes or mutates a worktree: the lane (and
 * whatever process evidence it holds) is left exactly as found.
 */
export function reconcileInterruptedDispatches(
  deps: InterruptedDispatchDeps,
  opts: { readonly limit?: number } = {},
): InterruptedDispatchReport {
  // `limit` caps the CANDIDATES one pass examines (a page loop may read
  // several pages to reach it); the rest is left to the next trigger.
  const limit = opts.limit ?? PAGE_SIZE * MAX_PAGES;
  const blocked: string[] = [];
  const skipped: string[] = [];
  let examined = 0;
  let failed = 0;
  let cursor: number | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const remaining = limit - examined;
    if (remaining <= 0) break;
    const pageSize = Math.min(remaining, PAGE_SIZE);
    const candidates = deps.ledger.listInterruptedDispatchCandidates(
      pageSize,
      cursor === null ? {} : { cursor },
    );
    if (candidates.length === 0) break;
    for (const candidate of candidates) {
      examined += 1;
      // Layer 1 already proved the status; re-read costs one row and keeps
      // the write below anchored on the row the facts were read from.
      const job = deps.ledger.getJob(candidate.id);
      if (job === null) continue;
      // Facts in guard order: the in-memory admission is free, everything
      // after it is one indexed row.
      const evidence: InterruptedDispatchEvidence = {
        status: job.status,
        admissions: deps.ledger.listJobAdmissions(job.id),
        activeLane: deps.ledger.hasLiveJobLane(job.id),
        workerStarted: deps.ledger.jobHasWorkerStart(job.id),
        handoff: deps.ledger.latestJobEvent(job.id, 'job.handoff') !== null,
        laneOwner: deps.ledger.creationContinuationLaneOwner(job.id),
        openProviderWaits: deps.ledger.listOpenProviderWaitsForJob(job.id).length,
        pipelineAdmitting: deps.ledger.getPipelineEntry(job.id)?.state === 'admitting',
        unsettledVerification: deps.ledger.hasUnsettledVerificationRun(job.id),
      };
      const verdict = interruptedDispatchVerdict(evidence);
      if (!verdict.block) {
        skipped.push(`${job.id}: ${verdict.reason ?? 'not an interrupted dispatch'}`);
        continue;
      }
      try {
        // The note lands FIRST: a status write lost to a crash leaves the job
        // a candidate, so the next pass retries with the obligation already
        // recorded (a repeated identical note, never a silent block).
        deps.ledger.noteJob(job.id, INTERRUPTED_DISPATCH_NOTE);
        deps.ledger.setJobStatus(job.id, 'blocked');
        deps.notifications.postIncident({
          kind: `dispatch.interrupted.${job.id}`,
          routing: 'action-required',
          severity: 'error',
          title: `Interrupted dispatch: ${job.title}`.slice(0, 200),
          // 'active': one card per job until it is resolved; a resolve
          // followed by a fresh interruption posts a new one.
          detail: (
            `${job.id} — the job was committed and its lane exists, but no minion ever started; ` +
            'it is blocked for recovery (never re-dispatched) and the interrupted dispatch must be ' +
            'resolved before the lane is re-armed.'
          ).slice(0, 1000),
          dedupe: 'active',
        });
        blocked.push(job.id);
      } catch (error) {
        failed += 1;
        deps.log?.('error', 'interrupted dispatch could not be surfaced — retried on the next pass', {
          job: job.id,
          error: String(error).slice(0, 300),
        });
      }
    }
    if (candidates.length < pageSize) break;
    const last = candidates[candidates.length - 1];
    // Keyset paging on the rowid the query orders by; a row that failed to
    // write is behind this cursor, so its retry happens on the next pass.
    cursor = last === undefined ? null : deps.ledger.jobRowid(last.id);
    if (cursor === null) break;
  }

  return { examined, blocked, skipped, failed };
}
