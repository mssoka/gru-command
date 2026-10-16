import { LIVE_DIRECTIVE_STATES } from '../ledger/directives.js';
import { surfaceRecoveryOwnerTransfer } from './recovery-owner.js';
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
  type DirectiveRegistry,
} from './fix-directive.js';
import type { WorktreePort } from './worktree-port.js';
import type { PacingGate, RetrySettlement } from '../runtime/pacing.js';
import type { NativeAgentTool } from '../runtime/types.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/** Historical marker decoding only. New directives and rebriefs use the
 * shared exact-request/native-checkpoint coordinator. Historical markers
 * never authorize prompt replay or a fresh-session fallback: known spent
 * evidence can settle atomically, terminal requests can retire without
 * execution, and unproven live generations need a concrete guarded Gru
 * decision. No lease or marker age establishes no-effect authority. */

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
  /** Refresh an open incident's detail and title in place (same id, same
   * ack state). NotificationCenter has it; a surface without it cannot
   * refresh a reused card and says so when one needs it. */
  updateDetail?(id: string, detail: string, title?: string): unknown;
}

/** Post a recovery card, and refresh a reused one in place (#363 S07-1-02,
 * S07-3-01): a card deduped onto an older open row would otherwise keep the
 * older generation's marker, hash and instructions. Its id and Ack state stay. */
export function postRecoveryIncident(notifications: RecoveryNotifications, input: Parameters<RecoveryNotifications['postIncident']>[0] & { readonly detail: string }): void {
  const record = notifications.postIncident(input) as { readonly id?: unknown; readonly detail?: unknown; readonly title?: unknown; readonly resolvedAt?: unknown } | null | undefined;
  // Only an open notification record can be stale (a structural surface may return nothing).
  if (record === null || record === undefined || typeof record.id !== 'string' || typeof record.title !== 'string' || record.resolvedAt !== null) return;
  if (record.detail === input.detail && record.title === input.title) return;
  if (notifications.updateDetail === undefined) {
    throw new Error(`recovery card ${record.id} (${input.kind}) was reused with an older generation's detail, and this notifications surface cannot refresh it`);
  }
  notifications.updateDetail(record.id, input.detail, input.title);
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
  /** Issue #161: GC-mediated child-worker tools for a re-dispatched parent
   * session (boot recovery must not strip a parent's commissioning path). */
  readonly parentTools?: (agentId: string) => readonly NativeAgentTool[];
  /** Service-stopping signal: aborts a QUEUED re-brief admission wait and
   * lets the retry-settlement race observe cancellation instead of hanging
   * shutdown. Absent = settlement remains hook-owned. */
  readonly stopSignal?: AbortSignal;
  /** True while the process is deliberately stopping: a turn killed by
   * shutdown is not a recovery failure — the next boot reconsiders evidence. */
  readonly stopping?: () => boolean;
  /** Read-only coverage observation never authorizes historical replay. */
  readonly observeBlindTurn?: (jobId: string, sessionFile: string | null) => void;
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
  /** Always 0: historical observation never re-dispatches a turn (no
   * replay, no fresh-session fallback). Kept for the report's shape. */
  readonly redispatched: number;
  /** Jobs retired synchronously during this scan because the job is
   * terminal (one per job group with at least one marker retired in THIS
   * scan; a group partially retired now and completed by a later scan is
   * counted by each scan that retired part of it). */
  readonly retired: number;
  /** Failed historical groups retained with exact-generation recovery action
   * and a durable bounded retry; never reported as completed or replayed. */
  readonly failed: number;
  /** Already resolved: observation is synchronous and starts no background
   * work. Kept so callers that await it need no change. */
  readonly settled: Promise<void>;
}

/** The shared ledger predicate verifies the exact historical generation,
 * immutable phase or explicit marker/hash correlation, and original facts.
 * A newer same-job event alone never proves a spent request. */
export function pendingRebriefEventLanded(
  ledger: Pick<LedgerApi, 'pendingRebriefReceipt'>,
  marker: PendingRebriefRecord,
): boolean {
  return ledger.pendingRebriefReceipt(marker) !== null;
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
  const rebriefRecorded = false;
  let deliveredSha: string | null = null;
  const deliveryNote: string | null = null;
  let deliveryRecorded = false;
  try {
    if (rebriefMarker !== null && input.ledger.pendingRebriefReceipt(rebriefMarker) === null) {
      throw new Error('historical rebrief completion is unproven — preserve markers and require a guarded Gru recovery decision');
    }
    if (missing.length > 0) {
      // The re-brief event publishes after COMMIT. Its subscribers may
      // terminalize or supersede this request before the next side effect.
      checkRebriefTurn(input.ledger, input.jobId, markers);
      flipJobToWorking(input.ledger, input.jobId);
    }

    const landedDelivery = deliveryMarker === null ? null : input.ledger.pendingRebriefReceipt(deliveryMarker);
    if (deliveryMarker !== null && landedDelivery === null) {
      const lanes = input.worktrees.listWorktrees({ jobId: input.jobId }).filter((lane) => lane.kind === 'job' && lane.status !== 'swept');
      const original = input.ledger.reconstructCompletedRebriefDelivery(markers, lanes.length === 1 ? lanes[0] : undefined);
      if (original === null) throw new Error('historical completion is proven but original delivery HEAD/revision is absent — use exact legacy reconcile-completed control closure and current inspection, never synthesize historical delivery');
      deliveredSha = (original.payload as { sha: string }).sha;
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
  // Clear and settlement commit atomically (issue #189): a settlement
  // failure throws with the markers rolled back, so the queued review
  // handoff keeps its release signal and the next pass can repair.
  if (!input.ledger.clearPendingRebriefsIfCurrentAndSettle(markers)) {
    return { minionId: input.minionId, deliveredSha, deliveryNote, rebriefRecorded, deliveryRecorded, retired: false, retirement: null, superseded: true };
  }
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

/** Boot wrapper reports scoped historical failures without aborting independent initialization. */
export async function reconcilePendingRebriefs(
  deps: ReconcileRebriefDeps,
  opts: { readonly limit?: number } = {},
): Promise<ReconcileReport> {
  return observePendingRebriefs(deps, opts);
}

/** Observe bounded whole historical generations at boot and on ticks.
 * New protocol writers never create these markers. Timestamps (including
 * same-millisecond/future-clock records) cannot hide unknown progress or
 * prove no effects. Only genuine spent evidence or guarded terminal
 * retirement advances; otherwise exact Gru judgment is owed, never replay. */
export function observePendingRebriefs(
  deps: ReconcileRebriefDeps,
  opts: { readonly limit?: number } = {},
): ReconcileReport {
  if (deps.stopSignal?.aborted || deps.stopping?.()) return { examined: 0, completed: 0, redispatched: 0, retired: 0, failed: 0, settled: Promise.resolve() };
  const scope = 'historical-rebrief-observation';
  const retryScope = `${scope}-retry`;
  const limit = opts.limit ?? 100;
  let cursor = deps.ledger.readReconcileCursor(scope) ?? 0;
  const groups = deps.ledger.listPendingRebriefGroups({ afterRowid: cursor, limit });
  // One durable retry slot supplements the fair main page: a failure is
  // reconsidered on the next pass without starving unrelated generations.
  const retryCursor = deps.ledger.readReconcileCursor(retryScope) ?? 0;
  const retryCandidate = retryCursor > 0 ? deps.ledger.listPendingRebriefGroups({ afterRowid: retryCursor - 1, limit: 1 })[0] : undefined;
  const retryGroup = retryCandidate?.cursor === retryCursor ? retryCandidate : undefined;
  let nextRetryCursor = retryGroup === undefined ? 0 : retryCursor;
  const retryOnly = retryGroup !== undefined && !groups.some((group) => group.cursor === retryCursor)
    ? [{ ...retryGroup, fromMainPage: false }] : [];
  const workGroups = [...retryOnly, ...groups.map((group) => ({ ...group, fromMainPage: true }))];
  let examined = 0;
  let completed = 0;
  const redispatched = 0;
  let retired = 0;
  const failures: unknown[] = [];

  for (const { jobId, cursor: groupCursor, fromMainPage } of workGroups) {
    if (deps.stopSignal?.aborted || deps.stopping?.()) break;
    if (fromMainPage) cursor = groupCursor;
    if (groupCursor === retryCursor && nextRetryCursor === retryCursor) nextRetryCursor = 0;
    let expected: readonly PendingRebriefRecord[] | null = null;
    try {
      const group = deps.ledger.listPendingRebriefs({ jobId });
      // A generation settled since the page was listed (a subscriber of an
      // earlier group's settlement, or another pass) is gone, not broken:
      // nothing is left to observe or escalate.
      if (group.length === 0) continue;
      expected = group;
      examined += group.length;
      if (deps.observeBlindTurn !== undefined) {
        // Observe retained access evidence, not an invented new legacy turn.
        // Only an exact recorded primary minion/session for this job is read;
        // coverage observation cannot settle debt or confer work permission.
        const minions = deps.ledger.listImplementerMinions(jobId);
        const sessions = new Set(group.flatMap((marker) => marker.sessionFile !== null &&
          minions.some((agent) => agent.id === marker.agentId && agent.sessionFile === marker.sessionFile)
          ? [marker.sessionFile] : []));
        for (const file of sessions) deps.observeBlindTurn(jobId, file);
      }
      const identityMarker = group.find((marker) => marker.kind === 'silas.rebrief');
      if (identityMarker !== undefined && deps.ledger.recoveryOwnerBasis('rebrief', identityMarker.id).owned) {
        surfaceRecoveryOwnerTransfer(deps, 'rebrief', identityMarker.id);
        continue;
      }
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
        if (deps.ledger.clearPendingRebriefsIfCurrentAndSettle(group)) {
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
        let followUp: ReturnType<LedgerApi['reconstructCompletedRebriefDelivery']>;
        try {
          const lanes = deps.worktrees.listWorktrees({ jobId }).filter((lane) => lane.kind === 'job' && lane.status !== 'swept');
          followUp = deps.ledger.reconstructCompletedRebriefDelivery(group, lanes.length === 1 ? lanes[0] : undefined);
          if (followUp === null) {
            escalateRecoveryFailure(deps, jobId, group, new Error('exact original completion has no original delivery HEAD/revision — use legacy reconcile-completed control closure plus separate current artifact inspection; original-work successor and historical fabrication are forbidden'));
            continue;
          }
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
        if (!deps.ledger.clearPendingRebriefsIfCurrentAndSettle(group)) {
          deps.log?.('warn', 're-brief delivery recorded but request was superseded before clearing', { job: jobId });
          continue;
        }
        // The settlement committed with the clear: the generation is complete
        // whatever the audit append below meets. A lost audit is said loudly,
        // never retained as a failed generation the next pass cannot find.
        completed += 1;
        try {
          deps.ledger.appendCustomEvent({
            kind: 'silas.rebrief-recovered',
            jobId,
            payload: { path: 'delivery-only', delivered_sha: (followUp.payload as { sha: string }).sha, original_provenance: (followUp.payload as { provenance: unknown }).provenance },
          });
        } catch (error) {
          deps.log?.('error', 're-brief recovered but its recovery audit could not be recorded', { job: jobId, error: String(error) });
          continue;
        }
        deps.log?.('info', 're-brief delivery recorded from a crash window', { job: jobId });
        continue;
      }
      if (job === null) {
        escalateRecoveryFailure(deps, jobId, group, new Error(`job "${jobId}" no longer exists — historical progress is unprovable`));
        continue;
      }
      escalateRecoveryFailure(deps, jobId, group, new Error('legacy re-brief has no exact native request checkpoint — original prompt and fresh-session fallback are forbidden; concrete Gru recovery decision required'));
    } catch (error) {
      failures.push(error);
      nextRetryCursor = nextRetryCursor === 0 ? groupCursor : Math.min(nextRetryCursor, groupCursor);
      deps.log?.('error', 'historical re-brief observation failed', { job: jobId, error: String(error) });
      // Storage inspection or inability to persist an actionable fence is
      // still a loud shared-precondition failure, not successful recovery.
      if (expected === null) throw error;
      const current = deps.ledger.listPendingRebriefs({ jobId });
      if (sameRebriefGeneration(current, expected) && expected.every((marker) => current.some((row) =>
        row.id === marker.id && row.agentId === marker.agentId && row.sessionFile === marker.sessionFile && row.workRevision === marker.workRevision))) {
        escalateRecoveryFailure(deps, jobId, expected, error);
      }
    }
  }
  deps.ledger.writeReconcileCursor({ scope: retryScope, cursor: nextRetryCursor });
  deps.ledger.writeReconcileCursor({ scope, cursor: groups.length < limit && !deps.stopSignal?.aborted && !deps.stopping?.() ? 0 : cursor });
  return {
    examined,
    completed,
    redispatched,
    retired,
    failed: failures.length,
    settled: Promise.resolve(),
  };
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
  const marker = group.find((marker) => marker.kind === 'silas.rebrief') ?? group[0];
  const job = deps.ledger.getJob(jobId);
  const debt = marker === undefined || job === null || isJobTerminal(job.status) ? null : deps.ledger.openRebriefRecoveryDebt(marker.id, String(error));
  // Bind the row to the CURRENTLY recorded re-brief worker when one exists
  // (existing agentId semantics) so the escalation is classified as a
  // closed receipt once the lane goes terminal; the in-memory group is a
  // pre-dispatch snapshot and may predate onSpawned's binding, so re-read
  // the markers first (code review 2026-10-04). A lane with no recorded
  // worker stays unbound and live (tracked-review A4).
  const boundAgent =
    deps.ledger
      .listPendingRebriefs({ jobId })
      .find((marker) => marker.agentId !== null)?.agentId ??
    group.find((marker) => marker.agentId !== null)?.agentId ??
    null;
  try {
    postRecoveryIncident(deps.notifications, {
      kind: `silas.rebrief-unreconciled.${jobId}`,
      routing: 'action-required',
      severity: 'error',
      title: `Re-brief recovery failed: job ${jobId}`,
      detail:
        `A re-brief request was mid-flight at service restart and boot recovery could not ` +
        `safely complete the request: ${String(error)}. Pending markers (${kinds}) remain; the ` +
        `original prompt is never replayed. Concrete Gru decision: GET /api/silas/rebriefs/${marker?.id ?? 'unknown'}, then POST its /recover with expected_generation ${debt?.generation ?? 'unknown'}, expected_payload_hash ${marker?.payloadHash ?? 'unknown'}, expected_receipt_evidence_sha256 from that authenticated readback, fresh HEAD, epoch and approved revision/contract. This evidence hash only fences stale intent; lone delivery is partial history, not completion/no effects. If exact original completion lacks original delivery facts, choose legacy-only reconcile-completed with a distinct inspection_request_id: close old control without execution/fabrication and leave a concrete current-inspection obligation, then separately use its existing directive/verification APIs. Suspended/incoherent generations may only transfer exact unknown context to a real job-wide owner hold; successor remains forbidden. A generic hold/prose disposition does not answer this debt.`,
      dedupe: 'unacked',
      agentId: boundAgent,
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
  return reconcilePendingDirectivesForRows(deps, false);
}

/** Boot-only legacy protocol reconciliation. Current requests are owned by
 * DirectiveProgressService and require their exact native checkpoint; only
 * rows predating that protocol may use correlated event-only recovery. */
export function reconcilePendingLegacyDirectives(deps: ReconcileDirectivesDeps): DirectiveReconcileReport {
  return reconcilePendingDirectivesForRows(deps, true);
}

function reconcilePendingDirectivesForRows(
  deps: ReconcileDirectivesDeps,
  legacyOnly: boolean,
): DirectiveReconcileReport {
  const live = listAllLiveDirectives(deps.ledger).filter((row) => !legacyOnly || row.requestKind === null);
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
      postRecoveryIncident(deps.notifications, {
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
        // Bind through the recorded admission worker when one exists so a
        // terminal lane classifies the row as a closed receipt; a request
        // that crashed before admission stays unbound and live (code
        // review 2026-10-04, owner decision D2).
        ...(current.admissionMinion !== null ? { agentId: current.admissionMinion } : {}),
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

/** Durable round-robin cursor scope for the bounded per-pass evidence
 * sweep (issue #163): successive passes continue past the examined prefix,
 * so a fixed prefix of live-but-unsettled requests cannot starve the rows
 * behind it. */
const DIRECTIVE_EVIDENCE_SCOPE = 'directive-evidence';

export interface DirectiveEvidenceReport {
  /** Live requests examined this pass. */
  readonly examined: number;
  /** Requests completed from their own correlated evidence this pass. */
  readonly completed: number;
  /** Rows whose evidence lookup/reconciliation threw — a partial pass must
   * never be reported as fully reconciled. */
  readonly failed: number;
}

/**
 * Bounded per-pass directive reconciliation (issue #163): complete the
 * live requests whose correlated evidence already landed, WITHOUT the boot
 * pass's escalation notes/cards. The boot pass judges and escalates; this
 * pass only advances a request on positive durable evidence (a matching
 * `silas.directive-sent` admission, then a matching `job.delivered`
 * terminal receipt), so it is safe to run from the Silas deterministic
 * pass on every tick — including while a model turn is open. An
 * admission-unknown request is left exactly where it is (visible, live,
 * never replayed); escalation stays a boot/restart judgment.
 */
export function settleDirectivesFromEvidence(
  deps: Pick<ReconcileDirectivesDeps, 'ledger' | 'log'>,
  opts: { pageSize?: number; maxPages?: number } = {},
): DirectiveEvidenceReport {
  const pageSize = Math.min(Math.max(1, opts.pageSize ?? 200), 1000);
  const maxPages = Math.min(Math.max(1, opts.maxPages ?? 5), 1000);
  let cursor = deps.ledger.readReconcileCursor(DIRECTIVE_EVIDENCE_SCOPE) ?? 0;
  if (!Number.isSafeInteger(cursor) || cursor < 0) cursor = 0;
  let examined = 0;
  let completed = 0;
  let failed = 0;
  let lastRowid: number | null = null;
  let reachedEnd = false;
  for (let page = 0; page < maxPages; page += 1) {
    const rows = deps.ledger.listPendingDirectives({
      states: LIVE_DIRECTIVE_STATES,
      limit: pageSize,
      rowidCursor: cursor,
    });
    if (rows.length === 0) {
      reachedEnd = true;
      break;
    }
    for (const row of rows) {
      examined += 1;
      try {
        const recovered = completeDirectiveFromEvidence(deps.ledger, row);
        if (recovered !== null) {
          completed += 1;
          deps.log?.('info', 'directive request settled from correlated evidence', {
            request: recovered.requestId,
            job: recovered.jobId,
            admission_seq: recovered.admissionSeq,
            delivery_seq: recovered.deliverySeq,
          });
        }
      } catch (error) {
        // One malformed/conflicting row stays VISIBLE and never takes the
        // pass down: the next pass retries it from durable state.
        failed += 1;
        deps.log?.('error', 'directive evidence reconciliation row failed', {
          request: row.requestId,
          error: String(error),
        });
      }
    }
    const last = rows[rows.length - 1];
    lastRowid = last === undefined ? null : (deps.ledger.directiveRowid(last.requestId) ?? null);
    if (rows.length < pageSize) {
      reachedEnd = true; // the factual tail — the next pass starts over
      break;
    }
    if (lastRowid === null) {
      deps.log?.('error', 'directive evidence cursor could not advance — pass stopped', {
        request: last?.requestId ?? null,
      });
      break;
    }
    cursor = lastRowid;
  }
  if (reachedEnd) {
    if (cursor !== 0) deps.ledger.writeReconcileCursor({ scope: DIRECTIVE_EVIDENCE_SCOPE, cursor: 0 });
  } else if (lastRowid !== null) {
    deps.ledger.writeReconcileCursor({ scope: DIRECTIVE_EVIDENCE_SCOPE, cursor: lastRowid });
  }
  return { examined, completed, failed };
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
  // Event-only decoding belongs solely to rows accepted by the historical
  // protocol. Every current request requires exact native checkpoint proof,
  // even if its admission binding has already been persisted.
  if (current.requestKind !== null) return null;
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
 * id, by IDENTITY (SQL on `request_id`) rather than a newest-N window:
 * however many newer same-kind events carry other request ids, the
 * correlated receipt is still found. The newest correlated event failing
 * the watermark predicate means every older one fails too, so no walk is
 * needed. */
function findCorrelatedEvent(
  ledger: LedgerApi,
  jobId: string,
  requestId: string,
  kind: string,
  accept: (event: EventRecord) => boolean,
): EventRecord | null {
  const event = ledger.latestJobEventByRequestId(jobId, kind, requestId);
  if (event === null || !accept(event)) return null;
  return event;
}
