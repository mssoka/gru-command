import { existsSync } from 'node:fs';
import { LIVE_DIRECTIVE_STATES } from '../ledger/directives.js';
import { isJobTerminal } from '../ledger/states.js';
import { PendingRebriefNoLongerCurrent } from '../ledger/api.js';
import type {
  DirectiveRequestRecord,
  EventRecord,
  LedgerApi,
  NotificationRouting,
  NotificationSeverity,
  PendingRebriefRecord,
  PendingRebriefRetireCandidate,
  PendingRebriefRetirement,
  JobStatus,
} from '../ledger/api.js';
import type { LogLevel } from '../logger.js';
import {
  flipJobToWorking,
  rebriefFreshMinion,
  recordFollowUpDelivery,
  type DirectiveRegistry,
} from './fix-directive.js';
import type { WorktreePort } from './worktree-port.js';
import type { PacingGate, RetrySettlement } from '../runtime/pacing.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Re-brief restart safety (Silas finding 2026-09-23): a re-brief request
 * mid-flight at service restart lost BOTH the worker and the event
 * recording — no `silas.rebrief`, no `job.delivered`, nothing to reconcile
 * at boot. The cure is a durable-marker pair written BEFORE the worker is
 * spawned and cleared ONLY when its guarded event lands:
 *
 * - `silas.rebrief` — the request event (the lane was re-briefed), and
 * - `job.delivered` — the follow-up delivery signal (the settled turn's
 *   lane head; what re-arms the digest's re-review freshness predicate).
 *
 * At boot, `reconcilePendingRebriefs` consumes every marker whose guarded
 * event never landed: it prefers to resume the interrupted worker's
 * session (the #42 orphan-cure shape: resume, then re-deliver the prompt),
 * falls back to a fresh worker on the same lane, and records the missing
 * events when that turn settles. A re-dispatch that fails escalates as
 * action-required — visibly stalled, never silently. The marker outlives
 * every failure, so the next boot retries. A marker whose job has since
 * reached terminal (`merged`/`done`) is the exception: the request can
 * never be honored, so boot retires it administratively — one
 * `silas.rebrief-retired` audit committed with the marker deletion —
 * instead of re-dispatching or escalating forever. Spent markers (both
 * guarded events already landed) are not retired: they clear as the
 * completion they are, with no retirement audit.
 *
 * This module owns the recording half of the flow (events + marker
 * clearing); the HTTP endpoint and the boot reconciler both ride it, so
 * the two paths cannot drift.
 */

/** The notifications surface recovery needs (structural — NotificationCenter fits). */
export interface RecoveryNotifications {
  postIncident(input: {
    kind: string;
    routing: NotificationRouting;
    severity: NotificationSeverity;
    title: string;
    detail?: string | null;
    agentId?: string | null;
    dedupe: 'unacked' | 'active' | 'all';
  }): unknown;
}

export interface ReconcileRebriefDeps {
  readonly registry: DirectiveRegistry;
  readonly ledger: LedgerApi;
  readonly worktrees: WorktreePort;
  readonly notifications: RecoveryNotifications;
  readonly log?: Log;
  /** Provider pacing: worker (minion turn) admission gate for re-dispatched
   * re-briefs. Absent = off. */
  readonly workerGate?: PacingGate;
  /** Provider pacing: bounded settlement of an automatic rate-limit retry
   * covering a re-dispatched re-brief turn (supervisor-backed in
   * production). The recovery records delivered only for
   * 'none'/'recovered'. */
  readonly retrySettlement?: (agentId: string) => Promise<RetrySettlement>;
  /** Service-stopping signal: aborts a QUEUED re-brief admission wait and
   * lets the retry-settlement race observe cancellation instead of hanging
   * shutdown. Absent = settlement remains hook-owned. */
  readonly stopSignal?: AbortSignal;
  /** True while the process is deliberately stopping: a turn killed by
   * shutdown is not a recovery failure — the next boot retries the marker. */
  readonly stopping?: () => boolean;
}

/** The incomplete-attempt disposition when the terminal branch examined
 * the request but retired nothing (a refused boundary or an identity drift):
 * the markers stay for the next pass. See `PendingRebriefFinalize.retirement`. */
export interface PendingRebriefRetirementDetail {
  readonly refused: PendingRebriefRetirement['refused'];
  readonly skippedIds: PendingRebriefRetirement['skippedIds'];
}

export interface PendingRebriefFinalize {
  readonly minionId: string | null;
  readonly deliveredSha: string | null;
  readonly deliveryNote: string | null;
  readonly rebriefRecorded: boolean;
  readonly deliveryRecorded: boolean;
  /** True when this call actually retired the request: the job was terminal
   * and the identity-checked marker deletion committed (no event, no
   * delivery, no reopen). A defensive boundary that refuses, or an identity
   * drift that skips every candidate, retires nothing and reports false,
   * carrying the disposition in `retirement`. */
  readonly retired: boolean;
  /** Set when the terminal branch examined the request: either it retired
   * nothing (a refused boundary or an identity drift — the caller must not
   * report the request as recovered; markers stay for the next pass), or
   * it retired partially and this carries the skipped ids (refused null).
   * Null when no terminal retirement was attempted or when it retired the
   * request completely. */
  readonly retirement: PendingRebriefRetirementDetail | null;
  /** true when the markers were replaced by a NEWER re-brief request while
   * this turn was in flight: nothing was recorded and nothing was cleared —
   * the newer request owns the lane, and an older receipt can never
   * complete a newer phase. */
  readonly superseded: boolean;
}

export interface ReconcileReport {
  /** Markers examined this pass (already-claimed markers are not examined twice). */
  readonly examined: number;
  /** Jobs whose guarded events were already landed and whose markers cleared. */
  readonly completed: number;
  /** Jobs QUEUED for a background re-dispatch (resume or fresh worker)
   * during this scan. The turn settles after boot; a retirement it reaches
   * mid-turn is logged per job and audited, not counted here. */
  readonly redispatched: number;
  /** Jobs retired synchronously during this scan because the job is
   * terminal (one per job group with at least one marker retired in THIS
   * scan; a group partially retired now and completed by a later scan is
   * counted by each scan that retired part of it). A retirement reached
   * mid-turn is logged per job and audited, not counted here. */
  readonly retired: number;
  /** Settles when every background re-dispatch has settled — resumed,
   * escalated, or abandoned because the process is stopping. Boot does not
   * await it (a re-brief turn is long); tests do. */
  readonly settled: Promise<void>;
}

/**
 * Has this marker's guarded event landed? The event must post-date the
 * request's sequence watermark — an older event of the same kind cannot
 * answer a newer request. When the marker belongs to a MARKED phase
 * (`phaseId` set), the event must ALSO carry that phase id: an unrelated
 * delivery/re-brief of the same kind can never satisfy this request's
 * marker (an older/other receipt cannot complete or cancel it).
 */
export function pendingRebriefEventLanded(
  ledger: Pick<LedgerApi, 'latestJobEvent' | 'latestJobPhaseEvent'>,
  marker: PendingRebriefRecord,
): boolean {
  return pendingRebriefGuardedEvent(ledger, marker, marker.phaseId) !== null;
}

/** The marker's own guarded event, correlated to the phase when marked.
 * Unmarked markers keep the legacy newest-event predicate. */
function pendingRebriefGuardedEvent(
  ledger: Pick<LedgerApi, 'latestJobEvent' | 'latestJobPhaseEvent'>,
  marker: PendingRebriefRecord,
  phaseId: string | null,
): EventRecord | null {
  if (phaseId === null) {
    const event = ledger.latestJobEvent(marker.jobId, marker.kind);
    return event !== null && event.seq > marker.baselineSeq ? event : null;
  }
  return ledger.latestJobPhaseEvent(marker.jobId, marker.kind, phaseId, marker.baselineSeq);
}

function publishRebriefSettlement(ledger: LedgerApi, jobId: string): void {
  // Only after identity-checked completion clears the markers: a queued
  // review handoff can now retry, never on a superseded or retired turn.
  ledger.appendCustomEvent({ kind: 'silas.rebrief-settled', jobId });
}

/**
 * Record a settled re-brief turn's events and clear its markers. Idempotent
 * per marker: an event that already landed since the request watermark is
 * never re-appended (a reconcile finishing a crash window records only
 * what is missing), and markers clear only after both events exist.
 */
export function finalizeRebriefRequest(input: {
  readonly ledger: LedgerApi;
  readonly worktrees: WorktreePort;
  readonly jobId: string;
  readonly minionId: string | null;
  readonly lanePath: string | null;
  readonly note: string | null;
  /** Request-generation snapshot from admission. Both marker ids and their
   * payload/watermark identity must still match, including unmarked turns. */
  readonly expectedMarkers?: readonly PendingRebriefRecord[];
  /** Legacy phase-only callers; new turn callers pass expectedMarkers. */
  readonly expectedPhaseId?: string | null;
}): PendingRebriefFinalize {
  const markers = input.ledger.listPendingRebriefs({ jobId: input.jobId });
  if (markers.length === 0) {
    // No markers means there is nothing to finalize: a replay is a no-op.
    // A turn with an admitted generation cannot claim recovery from this
    // absence (the markers may have been retired or consumed elsewhere).
    return { minionId: input.minionId, deliveredSha: null, deliveryNote: null, rebriefRecorded: false, deliveryRecorded: false, retired: false, retirement: null, superseded: input.expectedMarkers !== undefined };
  }
  if (input.expectedMarkers !== undefined && !sameRebriefGeneration(markers, input.expectedMarkers)) {
    return { minionId: input.minionId, deliveredSha: null, deliveryNote: null, rebriefRecorded: false, deliveryRecorded: false, retired: false, retirement: null, superseded: true };
  }
  if (input.expectedPhaseId !== undefined) {
    const currentPhaseId = markers.find((marker) => marker.phaseId !== null)?.phaseId ?? null;
    if (currentPhaseId !== input.expectedPhaseId) {
      // A newer request's markers own the lane now: this settled turn's
      // events must NOT be recorded against them (an older receipt cannot
      // complete a newer phase), and the newer markers must stay pending.
      return {
        minionId: input.minionId,
        deliveredSha: null,
        deliveryNote: null,
        rebriefRecorded: false,
        deliveryRecorded: false,
        retired: false,
        retirement: null,
        superseded: true,
      };
    }
  }
  if (!isCompleteRebriefPair(markers)) throw incompleteRebriefPairError(input.jobId);
  const missing = markers.filter((marker) => !pendingRebriefEventLanded(input.ledger, marker));
  const job = input.ledger.getJob(input.jobId);
  if (missing.length > 0 && job === null) {
    // Fail closed: a marker whose job row is gone can never be finalized
    // truthfully — recording guarded events would mint history for an
    // absent job. The markers stay for the next honest boundary.
    throw new Error(`job "${input.jobId}" no longer exists — pending re-brief markers cannot be finalized`);
  }
  if (missing.length > 0 && job !== null && isJobTerminal(job.status)) {
    // The job went terminal under the turn's feet: the guarded events can
    // no longer be honored truthfully. Retire the request instead of
    // recording a stale late completion (no reopen, no fabricated
    // delivery, no kill — the turn's artifacts stay on the lane).
    const retirement = retireTerminalRebriefs(input.ledger, job, markers);
    if (retirement.retired.length === 0) {
      // The defensive boundary refused or the identity drifted: nothing was
      // deleted or recorded. Report the disposition so no caller claims a
      // recovery that did not happen.
      return {
        minionId: input.minionId,
        deliveredSha: null,
        deliveryNote: null,
        rebriefRecorded: false,
        deliveryRecorded: false,
        retired: false,
        retirement: { refused: retirement.refused, skippedIds: retirement.skippedIds },
        superseded: false,
      };
    }
    return {
      minionId: input.minionId,
      deliveredSha: null,
      deliveryNote: null,
      rebriefRecorded: false,
      deliveryRecorded: false,
      retired: true,
      // A partial retirement must still trace what was deliberately left
      // behind (the spec edge row promises "caller logs skipped ids"); a
      // complete retirement carries no disposition.
      retirement: retirement.skippedIds.length > 0
        ? { refused: retirement.refused, skippedIds: retirement.skippedIds }
        : null,
      superseded: false,
    };
  }
  const rebriefMarker = markers.find((marker) => marker.kind === 'silas.rebrief') ?? null;
  const deliveryMarker = markers.find((marker) => marker.kind === 'job.delivered') ?? null;
  // Host-owned phase identity: when this request carried an explicit
  // completion intent, every guarded event must carry it so the delivery
  // can complete exactly this phase (never an event-sequence guess).
  const phaseId = markers.find((marker) => marker.phaseId !== null)?.phaseId ?? null;

  let rebriefRecorded = false;
  let deliveredSha: string | null = null;
  let deliveryNote: string | null = null;
  let deliveryRecorded = false;
  try {
    if (rebriefMarker !== null && pendingRebriefGuardedEvent(input.ledger, rebriefMarker, phaseId) === null) {
      input.ledger.appendCustomEventIfCurrentRebrief({
        kind: 'silas.rebrief',
        jobId: input.jobId,
        payload: {
          minion_id: input.minionId,
          lane: input.lanePath,
          note: input.note,
          ...(phaseId !== null ? { phase_id: phaseId } : {}),
        },
      }, markers);
      rebriefRecorded = true;
    }
    if (missing.length > 0) {
      // The re-brief event publishes after COMMIT. Its subscribers may
      // terminalize or supersede this request before the next side effect.
      checkRebriefTurn(input.ledger, input.jobId, markers);
      flipJobToWorking(input.ledger, input.jobId);
    }

    const landedDelivery = deliveryMarker === null ? null : pendingRebriefGuardedEvent(input.ledger, deliveryMarker, phaseId);
    if (deliveryMarker !== null && landedDelivery === null) {
      const followUp = recordFollowUpDelivery({
        ledger: {
          appendCustomEvent: (fields) => input.ledger.appendCustomEventIfCurrentRebrief(fields, markers),
        },
        worktrees: input.worktrees,
        jobId: input.jobId,
        agentId: input.minionId,
        source: 'silas-rebrief',
        ...(phaseId !== null ? { phaseId } : {}),
      });
      deliveredSha = followUp.sha;
      deliveryNote = followUp.note;
      deliveryRecorded = true;
    } else if (landedDelivery !== null) {
      // Reconcile caught a crash window: read the phase-correlated head,
      // never an unrelated delivery, without appending a duplicate.
      const payload = landedDelivery.payload;
      if (typeof payload === 'object' && payload !== null) {
        const sha = (payload as { sha?: unknown }).sha;
        deliveredSha = typeof sha === 'string' && sha !== '' ? sha : null;
      }
    }
  } catch (error) {
    if (!(error instanceof PendingRebriefNoLongerCurrent || error instanceof RebriefTurnCancelled)) throw error;
    // Re-derive whether the events were honored before terminality, or the
    // exact admitted generation must be retired. Never operate on its heir.
    return finalizeRebriefRequest({ ...input, expectedMarkers: markers });
  }

  // Event publication may have replaced the markers after delivery. The
  // identity-checked clear must not claim that older turn recovered an heir.
  if (!input.ledger.clearPendingRebriefsIfCurrent(markers)) {
    return { minionId: input.minionId, deliveredSha, deliveryNote, rebriefRecorded, deliveryRecorded, retired: false, retirement: null, superseded: true };
  }
  publishRebriefSettlement(input.ledger, input.jobId);
  return { minionId: input.minionId, deliveredSha, deliveryNote, rebriefRecorded, deliveryRecorded, retired: false, retirement: null, superseded: false };
}

/** Both guarded events must belong to the same request, not merely have
 * the right kinds. Persisted mismatches stay visible for operator repair. */
function isCompleteRebriefPair(markers: readonly PendingRebriefRecord[]): boolean {
  if (markers.length !== 2 || !markers.some((marker) => marker.kind === 'silas.rebrief') ||
      !markers.some((marker) => marker.kind === 'job.delivered')) return false;
  const [first, second] = markers;
  return first !== undefined && second !== undefined && first.phaseId === second.phaseId &&
    first.payloadHash === second.payloadHash && first.baselineSeq === second.baselineSeq;
}

class IncompleteRebriefPairError extends Error {
  constructor(jobId: string) {
    super(`job "${jobId}" has an incomplete marker pair or incoherent marker pair — pending re-brief cannot be recovered or retired; inspect phase id, payload hash and baseline watermark for repair`);
    this.name = 'IncompleteRebriefPairError';
  }
}

function incompleteRebriefPairError(jobId: string): IncompleteRebriefPairError {
  return new IncompleteRebriefPairError(jobId);
}

/** A replaced pair cannot be bound, completed, or retired by an older turn. */
function sameRebriefGeneration(current: readonly PendingRebriefRecord[], expected: readonly PendingRebriefRecord[]): boolean {
  return current.length === expected.length && expected.every((marker) => current.some((row) =>
    row.id === marker.id && row.kind === marker.kind && row.payloadHash === marker.payloadHash &&
    row.baselineSeq === marker.baselineSeq && row.phaseId === marker.phaseId));
}

export class RebriefTurnCancelled extends Error {
  constructor(readonly reason: 'terminal' | 'superseded') {
    super(`re-brief turn cancelled before admission: ${reason}`);
    this.name = 'RebriefTurnCancelled';
  }
}

/** Checked just before disposal/spawn and again after spawn, before prompt.
 * No await may separate the check from the corresponding side effect. */
export function checkRebriefTurn(ledger: Pick<LedgerApi, 'getJob' | 'listPendingRebriefs'>, jobId: string, expected: readonly PendingRebriefRecord[]): void {
  if (!sameRebriefGeneration(ledger.listPendingRebriefs({ jobId }), expected)) throw new RebriefTurnCancelled('superseded');
  const job = ledger.getJob(jobId);
  if (job === null) throw new Error(`job "${jobId}" no longer exists — pending re-brief markers cannot be admitted`);
  if (isJobTerminal(job.status)) throw new RebriefTurnCancelled('terminal');
}

/** Markers this process is actively recovering — a second reconcile pass
 * (same boot, or a boot racing an open recovery) never double-dispatches. */
const activeClaims = new Set<string>();

/**
 * Boot reconciliation: for every pending marker older than this boot whose
 * guarded event never landed, either finish the recording (turn settled,
 * only the delivery record was lost) or re-dispatch a worker — resuming
 * the interrupted session when one exists, fresh otherwise — and record
 * the missing events when it settles. A terminal job's obsolete request is
 * retired with a durable audit instead (it can never be honored).
 * Failures escalate action-required.
 */
export async function reconcilePendingRebriefs(
  deps: ReconcileRebriefDeps,
  opts: { readonly bootAt?: Date } = {},
): Promise<ReconcileReport> {
  const bootAt = opts.bootAt ?? new Date();
  const markers = deps.ledger
    .listPendingRebriefs()
    .filter((marker) => Date.parse(marker.requestedAt) < bootAt.getTime() && !activeClaims.has(marker.id));
  if (markers.length === 0) {
    return { examined: 0, completed: 0, redispatched: 0, retired: 0, settled: Promise.resolve() };
  }
  const byJob = new Map<string, PendingRebriefRecord[]>();
  for (const marker of markers) {
    const group = byJob.get(marker.jobId);
    if (group === undefined) byJob.set(marker.jobId, [marker]);
    else group.push(marker);
  }

  let completed = 0;
  let redispatched = 0;
  let retired = 0;
  const background: Promise<void>[] = [];
  for (const [jobId, group] of byJob) {
    const completePair = isCompleteRebriefPair(group);
    if (!completePair) {
      // Without both marker kinds we cannot prove completion OR justify an
      // administrative cancellation. Keep the anomaly visible even if the
      // job is terminal and the surviving guarded event already landed.
      escalateRecoveryFailure(deps, jobId, group, incompleteRebriefPairError(jobId));
      continue;
    }
    const missing = group.filter((marker) => !pendingRebriefEventLanded(deps.ledger, marker));
    if (missing.length === 0) {
      if (deps.ledger.clearPendingRebriefsIfCurrent(group)) {
        publishRebriefSettlement(deps.ledger, jobId);
        completed += 1;
      } else deps.log?.('warn', 're-brief spent markers superseded before clearing', { job: jobId });
      continue;
    }
    // A terminal job can never honor the request. Retire it
    // administratively (audited, identity-checked) instead of fabricating
    // a delivery or escalating again at every boot. This precedes the
    // delivery-only crash shortcut on purpose: terminality must never
    // mint a delivery.
    const job = deps.ledger.getJob(jobId);
    if (job !== null && isJobTerminal(job.status)) {
      const retirement = retireTerminalRebriefs(deps.ledger, job, group);
      if (retirement.retired.length > 0) {
        retired += 1;
        deps.log?.('info', 're-brief request retired: job is terminal', {
          job: jobId,
          status: job.status,
          markers: retirement.retired.map((marker) => `${marker.kind}:${marker.id}`).join(', '),
          ...(retirement.skippedIds.length > 0 ? { skipped: retirement.skippedIds } : {}),
        });
      } else {
        // Defensive boundary: a refusal or identity drift leaves the markers
        // for the next pass — surface it rather than skipping in silence.
        deps.log?.('warn', 're-brief retirement retired nothing', {
          job: jobId,
          status: job.status,
          refused: retirement.refused,
          skipped: retirement.skippedIds,
        });
      }
      continue;
    }
    // The turn settled before the restart and only the follow-up delivery
    // record was lost (`silas.rebrief` posted first). The lane is already
    // delivered; record the delivery directly instead of rerunning a turn.
    // A missing job row must NOT take this shortcut (it would mint a
    // delivery for a job that does not exist): it falls through to the
    // re-dispatch boundary, which escalates honestly with the markers kept.
    if (job !== null && completePair && missing.every((marker) => marker.kind === 'job.delivered')) {
      const anchor = group.find((marker) => marker.kind === 'job.delivered') ?? group[0];
      const phaseId = group.find((marker) => marker.phaseId !== null)?.phaseId ?? null;
      let followUp: ReturnType<typeof recordFollowUpDelivery>;
      try {
        followUp = recordFollowUpDelivery({
          // Lane lookup can invoke an injected port (or take time). The
          // status/generation guard and event write share one ledger txn.
          ledger: {
            appendCustomEvent: (fields) => deps.ledger.appendCustomEventIfCurrentRebrief(fields, group),
          },
          worktrees: deps.worktrees,
          jobId,
          agentId: anchor?.agentId ?? null,
          source: 'silas-rebrief',
          ...(phaseId !== null ? { phaseId } : {}),
        });
      } catch (error) {
        if (!(error instanceof PendingRebriefNoLongerCurrent)) throw error;
        const finalized = finalizeRebriefRequest({
          ledger: deps.ledger, worktrees: deps.worktrees, jobId,
          minionId: null, lanePath: null, note: null, expectedMarkers: group,
        });
        if (finalized.retired) retired += 1;
        deps.log?.('info', 're-brief delivery-only shortcut cancelled before recording', {
          job: jobId, reason: error.reason, retired: finalized.retired,
          superseded: finalized.superseded,
          ...(finalized.retirement !== null ? { refused: finalized.retirement.refused, skipped: finalized.retirement.skippedIds } : {}),
        });
        continue;
      }
      if (!deps.ledger.clearPendingRebriefsIfCurrent(group)) {
        deps.log?.('warn', 're-brief delivery recorded but request was superseded before clearing', { job: jobId });
        continue;
      }
      publishRebriefSettlement(deps.ledger, jobId);
      deps.ledger.appendCustomEvent({
        kind: 'silas.rebrief-recovered',
        jobId,
        payload: { path: 'delivery-only', delivered_sha: followUp.sha },
      });
      deps.log?.('info', 're-brief delivery recorded from a crash window', { job: jobId });
      completed += 1;
      continue;
    }
    redispatched += 1;
    background.push(redispatchGroup(deps, jobId, group));
  }
  return {
    examined: markers.length,
    completed,
    redispatched,
    retired,
    settled: Promise.all(background).then(() => undefined),
  };
}

/** One job's re-dispatch: resume when a session exists, fresh otherwise;
 * record the missing events on settle; escalate when recovery fails. */
async function redispatchGroup(
  deps: ReconcileRebriefDeps,
  jobId: string,
  group: readonly PendingRebriefRecord[],
): Promise<void> {
  for (const marker of group) activeClaims.add(marker.id);
  let path: 'resumed' | 'redispatched' = 'redispatched';
  try {
    const job = deps.ledger.getJob(jobId);
    if (job === null) throw new Error(`job "${jobId}" no longer exists`);
    if (isJobTerminal(job.status)) {
      // Defensive second boundary: the pass that queued this group saw a
      // nonterminal job. If terminality landed anyway, retire (never
      // re-dispatch, never escalate an unhonorable request).
      const currentMarkers = deps.ledger.listPendingRebriefs({ jobId });
      if (currentMarkers.length > 0 && !isCompleteRebriefPair(currentMarkers)) {
        throw incompleteRebriefPairError(jobId);
      }
      const retirement = retireTerminalRebriefs(deps.ledger, job, group);
      if (retirement.retired.length > 0) {
        deps.log?.('info', 're-brief request retired: job terminal before re-dispatch', {
          job: jobId,
          status: job.status,
        });
      } else {
        deps.log?.('warn', 're-brief retirement retired nothing before re-dispatch', {
          job: jobId,
          status: job.status,
          refused: retirement.refused,
          skipped: retirement.skippedIds,
        });
      }
      return;
    }
    if (!isCompleteRebriefPair(group)) throw incompleteRebriefPairError(jobId);
    const lane = deps.worktrees
      .listWorktrees({ jobId })
      .find((candidate) => candidate.kind === 'job' && candidate.status !== 'swept');
    if (lane === undefined) {
      throw new Error(`job "${jobId}" has no active job lane — a re-brief needs its worktree`);
    }
    const rebriefMarker = group.find((marker) => marker.kind === 'silas.rebrief') ?? group[0];
    const note = rebriefMarker?.note ?? '';
    const expectedPhaseId = group.find((marker) => marker.phaseId !== null)?.phaseId ?? null;
    const resumeFile = resolveResumeFile(deps, jobId, group);
    let result: Awaited<ReturnType<typeof rebriefFreshMinion>>;
    try {
      result = await runRebriefTurn(deps, {
        jobId,
        note,
        briefing: job.briefing,
        group,
        ...(resumeFile !== null ? { resumeFile } : {}),
      });
      throwIfTurnInBandError(result);
      path = resumeFile !== null ? 'resumed' : 'redispatched';
    } catch (error) {
      if (resumeFile === null || error instanceof RebriefTurnCancelled) throw error;
      deps.log?.('warn', 're-brief resume failed — retrying with a fresh worker', {
        job: jobId,
        resume_file: resumeFile,
        error: String(error),
      });
      result = await runRebriefTurn(deps, { jobId, note, briefing: job.briefing, group });
      throwIfTurnInBandError(result);
    }
    const finalized = finalizeRebriefRequest({
      ledger: deps.ledger,
      worktrees: deps.worktrees,
      jobId,
      minionId: result.minionId,
      lanePath: result.lanePath,
      note,
      expectedPhaseId,
      expectedMarkers: group,
    });
    if (finalized.retired) {
      // The job reached terminal while the recovered turn was in flight:
      // the ledger already recorded the retirement, the turn's artifacts
      // stay on the lane, and no recovery/delivery event is fabricated.
      // A partial retirement keeps its kept-marker ids visible at this
      // surface too (the audit is the durable record; the log must not
      // drop what the caller-reported disposition carries).
      deps.log?.('info', 're-brief recovery closed: job went terminal mid-turn', {
        job: jobId,
        path,
        minion_id: result.minionId,
        ...(finalized.retirement !== null
          ? { refused: finalized.retirement.refused, skipped: finalized.retirement.skippedIds }
          : {}),
      });
      return;
    }
    if (finalized.retirement !== null) {
      // The terminal boundary examined the request but retired nothing
      // (refusal or identity drift). The markers stay for the next pass and
      // no recovery event may claim the request was recovered.
      deps.log?.('warn', 're-brief recovery closed without retirement: markers kept', {
        job: jobId,
        path,
        refused: finalized.retirement.refused,
        skipped: finalized.retirement.skippedIds,
      });
      return;
    }
    if (finalized.superseded) {
      // A newer re-brief request replaced the markers while this recovery
      // turn ran: record nothing (its own turn owns the lane) and keep the
      // newer markers pending. The older receipt is evidence only.
      deps.log?.('warn', 're-brief recovery turn superseded by a newer request — nothing recorded', {
        job: jobId,
      });
      return;
    }
    deps.ledger.appendCustomEvent({
      kind: 'silas.rebrief-recovered',
      jobId,
      payload: {
        path,
        minion_id: result.minionId,
        rebrief_recorded: finalized.rebriefRecorded,
        delivery_recorded: finalized.deliveryRecorded,
        delivered_sha: finalized.deliveredSha,
      },
    });
    deps.log?.('info', 're-brief recovered after restart', {
      job: jobId,
      path,
      minion_id: result.minionId,
    });
  } catch (error) {
    const currentJob = deps.ledger.getJob(jobId);
    const currentMarkers = deps.ledger.listPendingRebriefs({ jobId });
    if (error instanceof IncompleteRebriefPairError || (currentMarkers.length > 0 && !isCompleteRebriefPair(currentMarkers))) {
      escalateRecoveryFailure(deps, jobId, group, incompleteRebriefPairError(jobId));
      return;
    }
    if (error instanceof RebriefTurnCancelled || (currentJob !== null && isJobTerminal(currentJob.status))) {
      // A failed turn after a terminal flip is no longer actionable. Close
      // only the admitted generation; the failure must not resurrect its
      // markers or raise an obsolete action-required incident.
      const finalized = finalizeRebriefRequest({
        ledger: deps.ledger, worktrees: deps.worktrees, jobId,
        minionId: null, lanePath: null, note: null, expectedMarkers: group,
      });
      deps.log?.('info', 're-brief recovery closed after cancellation or terminal turn failure', {
        job: jobId, error: String(error), retired: finalized.retired,
        superseded: finalized.superseded,
        ...(finalized.retirement !== null ? { refused: finalized.retirement.refused, skipped: finalized.retirement.skippedIds } : {}),
      });
      return;
    }
    if (deps.stopping?.() === true) {
      // Shutdown killed the turn, not a recovery failure: markers stay for
      // the next boot, and no incident is posted for a planned restart.
      deps.log?.('warn', 're-brief recovery interrupted by shutdown — marker kept for the next boot', {
        job: jobId,
        error: String(error),
      });
      return;
    }
    escalateRecoveryFailure(deps, jobId, group, error);
  } finally {
    for (const marker of group) activeClaims.delete(marker.id);
  }
}

/** Spawn (optionally resuming) the re-brief worker, binding its markers
 * before the prompt is delivered. */
function runRebriefTurn(
  deps: ReconcileRebriefDeps,
  input: {
    jobId: string;
    note: string;
    briefing: string | null;
    group: readonly PendingRebriefRecord[];
    resumeFile?: string;
  },
): ReturnType<typeof rebriefFreshMinion> {
  return rebriefFreshMinion({
    registry: deps.registry,
    ledger: deps.ledger,
    worktrees: deps.worktrees,
    ...(deps.workerGate !== undefined ? { workerGate: deps.workerGate } : {}),
    ...(deps.retrySettlement !== undefined ? { retrySettlement: deps.retrySettlement } : {}),
    ...(deps.stopSignal !== undefined ? { signal: deps.stopSignal } : {}),
    jobId: input.jobId,
    note: input.note,
    briefing: input.briefing,
    ...(input.resumeFile !== undefined ? { resumeFile: input.resumeFile } : {}),
    beforeTurnSideEffect: () => checkRebriefTurn(deps.ledger, input.jobId, input.group),
    onSpawned: (worker) => {
      deps.ledger.bindPendingRebriefWorker({
        ids: input.group.map((marker) => marker.id),
        agentId: worker.id,
        sessionFile: worker.sessionFile,
      });
    },
  });
}

/** A recovery turn that RESOLVED with an in-band runtime error is a
 * failed turn, not a delivery: it must take the same failure ladder as a
 * rejected prompt (resume retry, then a bounded escalation) and never
 * record guarded events or complete a marked phase. */
function throwIfTurnInBandError(result: Awaited<ReturnType<typeof rebriefFreshMinion>>): void {
  if (result.outcome === 'error') {
    throw new Error(`re-brief turn settled with an in-band runtime error: ${result.error ?? 'unknown'}`);
  }
}

/** The interrupted worker's session, when one exists on disk: the marker's
 * bound session first, then the job's latest minion (a crash between spawn
 * and marker binding). No resumable session means a fresh worker. */
function resolveResumeFile(
  deps: ReconcileRebriefDeps,
  jobId: string,
  group: readonly PendingRebriefRecord[],
): string | null {
  const markerSession = group.find((marker) => marker.sessionFile !== null)?.sessionFile ?? null;
  const latestMinion = deps.ledger
    .listAgents()
    .find((agent) => agent.jobId === jobId && agent.role === 'minion' && agent.sessionFile !== null);
  const candidates = [markerSession, latestMinion?.sessionFile ?? null];
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== '' && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Stable audit reason: the request is closed administratively because the
 * job reached a terminal status first. */
const TERMINAL_REBRIEF_RETIREMENT_REASON =
  'job reached a terminal status before the re-brief request was honored';

/** A terminal job's pending re-brief request can never be honored: retire
 * its markers with a durable audit instead of re-dispatching or escalating
 * forever. The ledger transaction re-verifies both the job status and each
 * marker's identity before deleting. */
function retireTerminalRebriefs(
  ledger: Pick<LedgerApi, 'retirePendingRebriefs'>,
  job: { readonly id: string; readonly status: JobStatus },
  group: readonly PendingRebriefRecord[],
): PendingRebriefRetirement {
  const candidates: PendingRebriefRetireCandidate[] = group.map((marker) => ({
    id: marker.id,
    kind: marker.kind,
    payloadHash: marker.payloadHash,
    baselineSeq: marker.baselineSeq,
  }));
  return ledger.retirePendingRebriefs({
    jobId: job.id,
    reason: TERMINAL_REBRIEF_RETIREMENT_REASON,
    candidates,
  });
}

function escalateRecoveryFailure(
  deps: ReconcileRebriefDeps,
  jobId: string,
  group: readonly PendingRebriefRecord[],
  error: unknown,
): void {
  const kinds = group.map((marker) => marker.kind).join(', ');
  try {
    deps.notifications.postIncident({
      kind: `silas.rebrief-unreconciled.${jobId}`,
      routing: 'action-required',
      severity: 'error',
      title: `Re-brief recovery failed: job ${jobId}`,
      detail:
        `A re-brief request was mid-flight at service restart and boot recovery could not ` +
        `safely complete the request: ${String(error)}. Pending markers (${kinds}) remain; the ` +
        'next boot retries — or re-brief the lane once the cause is cleared.',
      dedupe: 'unacked',
    });
  } catch (notificationError) {
    deps.log?.('error', 're-brief recovery escalation could not be posted', {
      job: jobId,
      error: String(error),
      notification_error: String(notificationError),
    });
  }
  deps.log?.('error', 're-brief recovery failed', { job: jobId, error: String(error) });
}

// --------------------------------------------------------------------
// Directive-request reconciliation (same coordinator, second marker
// family). The contract (chief ruling 2026-09-28 phase 3): a durable
// intent that never reached native admission is ADMISSION-UNKNOWN — a
// crash may have happened after I/O and before the admission record, so
// absence of a receipt is not proof of no side effect and NEVER licenses
// an automatic retry. Admitted without a terminal receipt is STILL in
// flight/unknown: nothing fabricates `job.delivered`. Both cases get ONE
// bounded, stable-id action-required escalation naming the request; the
// actual completion is reconciled from correlated evidence first.
// --------------------------------------------------------------------

export interface ReconcileDirectivesDeps {
  readonly ledger: LedgerApi;
  readonly notifications: RecoveryNotifications;
  readonly log?: Log;
}

export interface DirectiveReconcileReport {
  /** Live (dispatching/admitted) requests examined this pass. */
  readonly examined: number;
  /** Requests completed from their own correlated evidence — no retry,
   * no new worker: the crash window contained only record-keeping. */
  readonly completed: number;
  /** Requests escalated action-required for a bounded Gru decision. */
  readonly escalated: number;
}

/**
 * Boot reconciliation for directive requests. Deterministic and bounded:
 * every LIVE (dispatching/admitted) request is examined — read in bounded
 * cursor pages, never a request_id-ordered first page (the table is
 * append-only, so terminal history would crowd live rows past a fixed
 * page forever) — one escalation per request (stable kind ⇒ the
 * notification dedupe holds across boots — no fresh alert ids to bypass
 * dedupe), no provider calls, no worker spawns, no re-dispatch.
 */
export function reconcilePendingDirectives(deps: ReconcileDirectivesDeps): DirectiveReconcileReport {
  const live = listAllLiveDirectives(deps.ledger);
  let completed = 0;
  let escalated = 0;
  for (const row of live) {
    const recovered = completeDirectiveFromEvidence(deps.ledger, row);
    if (recovered !== null) {
      deps.log?.('info', 'directive request completed from correlated evidence', {
        request: row.requestId,
        job: row.jobId,
        admission_seq: recovered.admissionSeq,
        delivery_seq: recovered.deliverySeq,
      });
      completed += 1;
      continue;
    }
    // Recovery may have JUST recorded the admission from correlated
    // evidence: the note and card must describe the durable
    // post-recovery state, never the pre-recovery snapshot (W1).
    const current = deps.ledger.getDirective(row.requestId) ?? row;
    const admissionUnknown = current.state === 'dispatching';
    deps.ledger.recordDirectiveReconcile({
      requestId: current.requestId,
      note: admissionUnknown ? 'admission-unknown at boot' : 'admitted without terminal receipt at boot',
    });
    try {
      deps.notifications.postIncident({
        kind: `silas.directive-unreconciled.${current.requestId}`,
        routing: 'action-required',
        severity: 'error',
        title: `Directive request ${current.requestId} unreconciled after restart (job ${current.jobId})`,
        detail: admissionUnknown
          ? 'The request was accepted and a dispatch claim was taken, but no native admission evidence ' +
            'exists after restart: a prompt may have been delivered (crash after I/O, before the admission ' +
            'record). Do NOT re-dispatch without a Gru decision; reconcile the actual minion/session state first.'
          : `The request was admitted${current.admissionMinion === null ? '' : ` to minion ${current.admissionMinion}`} ` +
            'but no correlated terminal receipt exists after restart. The turn may still be completing in its ' +
            'session: do not re-dispatch; reconcile the actual completion before recording anything.',
        dedupe: 'unacked',
      });
      escalated += 1;
    } catch (error) {
      deps.log?.('error', 'directive recovery escalation could not be posted', {
        request: current.requestId,
        error: String(error),
      });
    }
  }
  return { examined: live.length, completed, escalated };
}

/** Page size for the boot pass: small enough to bound one query, large
 * enough that the common case is one page. */
const DIRECTIVE_RECONCILE_PAGE = 200;

/** Every live request, read in bounded cursor pages: the cursor advances
 * past each examined page, so a live row after any amount of terminal
 * history is still examined (boundedness limits the work per query, it
 * never drops live work). */
function listAllLiveDirectives(ledger: LedgerApi): readonly DirectiveRequestRecord[] {
  const live: DirectiveRequestRecord[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = ledger.listPendingDirectives({
      states: LIVE_DIRECTIVE_STATES,
      limit: DIRECTIVE_RECONCILE_PAGE,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    live.push(...page);
    if (page.length < DIRECTIVE_RECONCILE_PAGE) return live;
    const last = page[page.length - 1];
    if (last === undefined) return live;
    cursor = last.requestId;
  }
}

/** Complete a request from its own correlated ledger evidence — never
 * from a caller assertion. Admission first (a matching
 * `silas.directive-sent` postdating acceptance), then delivery (a
 * matching `job.delivered` postdating admission). Missing evidence
 * returns null: unknown stays unknown. */
function completeDirectiveFromEvidence(ledger: LedgerApi, row: DirectiveRequestRecord): DirectiveRequestRecord | null {
  let current = row;
  if (current.state === 'dispatching') {
    const sent = findCorrelatedEvent(ledger, current.jobId, current.requestId, 'silas.directive-sent', (event) => event.seq > current.baselineSeq);
    if (sent === null) return null;
    const payload = (typeof sent.payload === 'object' && sent.payload !== null ? sent.payload : {}) as Record<string, unknown>;
    const minionId = typeof payload['minion_id'] === 'string' && payload['minion_id'] !== '' ? payload['minion_id'] : null;
    if (minionId === null) return null; // admission found but identity missing — escalate, never guess
    current = ledger.recordDirectiveAdmission({ requestId: current.requestId, minionId, eventSeq: sent.seq });
  }
  if (current.state === 'admitted') {
    const delivered = findCorrelatedEvent(
      ledger,
      current.jobId,
      current.requestId,
      'job.delivered',
      (event) => current.admissionSeq === null || event.seq > current.admissionSeq,
    );
    if (delivered !== null) {
      return ledger.recordDirectiveDelivery({ requestId: current.requestId, eventSeq: delivered.seq });
    }
    return null;
  }
  return current;
}

/** Newest event of one kind whose payload is correlated to the request
 * id and passes the caller's watermark predicate. */
function findCorrelatedEvent(
  ledger: LedgerApi,
  jobId: string,
  requestId: string,
  kind: string,
  accept: (event: EventRecord) => boolean,
): EventRecord | null {
  const events = ledger.listJobEvents(jobId, { limit: 500 });
  for (const event of events) {
    if (event.kind !== kind) continue;
    const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
    if (payload['request_id'] !== requestId) continue;
    if (!accept(event)) continue;
    return event;
  }
  return null;
}
