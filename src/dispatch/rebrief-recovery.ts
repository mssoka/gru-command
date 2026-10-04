import { existsSync } from 'node:fs';
import { LIVE_DIRECTIVE_STATES } from '../ledger/directives.js';
import type {
  DirectiveRequestRecord,
  EventRecord,
  LedgerApi,
  NotificationRouting,
  NotificationSeverity,
  PendingRebriefRecord,
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
 * every failure, so the next boot retries.
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

export interface PendingRebriefFinalize {
  readonly minionId: string | null;
  readonly deliveredSha: string | null;
  readonly deliveryNote: string | null;
  readonly rebriefRecorded: boolean;
  readonly deliveryRecorded: boolean;
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
  /** Jobs handed to a background re-dispatch (resume or fresh worker). */
  readonly redispatched: number;
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
  ledger: Pick<LedgerApi, 'latestJobEvent'>,
  marker: PendingRebriefRecord,
): boolean {
  const event = ledger.latestJobEvent(marker.jobId, marker.kind);
  return event !== null && event.seq > marker.baselineSeq;
}

/** The marker's own guarded event, correlated to the phase when marked.
 * Unmarked markers keep the legacy newest-event predicate. */
function pendingRebriefGuardedEvent(
  ledger: Pick<LedgerApi, 'latestJobEvent' | 'listJobEvents'>,
  marker: PendingRebriefRecord,
  phaseId: string | null,
): EventRecord | null {
  if (phaseId === null) {
    const event = ledger.latestJobEvent(marker.jobId, marker.kind);
    return event !== null && event.seq > marker.baselineSeq ? event : null;
  }
  for (const event of ledger.listJobEvents(marker.jobId, { limit: 1000 })) {
    if (event.kind !== marker.kind) continue;
    if (event.seq <= marker.baselineSeq) continue;
    const payload = (typeof event.payload === 'object' && event.payload !== null ? event.payload : {}) as Record<string, unknown>;
    if (payload['phase_id'] === phaseId) return event;
  }
  return null;
}

function publishRebriefSettlement(ledger: LedgerApi, jobId: string): void {
  // Unlike job.delivered, this event is published AFTER marker retirement.
  // Queued review handoffs can now retry without treating an old delivery
  // as proof that a newer re-brief has settled.
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
  /** The phase identity this turn was started under (host-owned). When the
   * markers now carry a DIFFERENT identity, a newer request replaced them
   * mid-turn: skip recording entirely. Omitted = legacy callers (no fence). */
  readonly expectedPhaseId?: string | null;
}): PendingRebriefFinalize {
  const markers = input.ledger.listPendingRebriefs({ jobId: input.jobId });
  if (markers.length === 0) {
    // No markers means the request already finalized (events landed) — a
    // replay is a no-op, never a duplicate event. Every live re-brief
    // begins its markers before it can reach here.
    return {
      minionId: input.minionId,
      deliveredSha: null,
      deliveryNote: null,
      rebriefRecorded: false,
      deliveryRecorded: false,
      superseded: false,
    };
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
        superseded: true,
      };
    }
  }
  const rebriefMarker = markers.find((marker) => marker.kind === 'silas.rebrief') ?? null;
  const deliveryMarker = markers.find((marker) => marker.kind === 'job.delivered') ?? null;
  // Host-owned phase identity: when this request carried an explicit
  // completion intent, every guarded event must carry it so the delivery
  // can complete exactly this phase (never an event-sequence guess).
  const phaseId = markers.find((marker) => marker.phaseId !== null)?.phaseId ?? null;

  let rebriefRecorded = false;
  if (rebriefMarker === null || pendingRebriefGuardedEvent(input.ledger, rebriefMarker, phaseId) === null) {
    input.ledger.appendCustomEvent({
      kind: 'silas.rebrief',
      jobId: input.jobId,
      payload: {
        minion_id: input.minionId,
        lane: input.lanePath,
        note: input.note,
        ...(phaseId !== null ? { phase_id: phaseId } : {}),
      },
    });
    rebriefRecorded = true;
  }
  flipJobToWorking(input.ledger, input.jobId);

  let deliveredSha: string | null = null;
  let deliveryNote: string | null = null;
  let deliveryRecorded = false;
  const landedDelivery = deliveryMarker === null ? null : pendingRebriefGuardedEvent(input.ledger, deliveryMarker, phaseId);
  if (landedDelivery === null) {
    const followUp = recordFollowUpDelivery({
      ledger: input.ledger,
      worktrees: input.worktrees,
      jobId: input.jobId,
      agentId: input.minionId,
      source: 'silas-rebrief',
      ...(phaseId !== null ? { phaseId } : {}),
    });
    deliveredSha = followUp.sha;
    deliveryNote = followUp.note;
    deliveryRecorded = true;
  } else {
    // The delivery already landed (reconcile caught a crash window): report
    // the recorded head without appending a duplicate — read from the
    // phase-correlated event, never from an unrelated delivery.
    const payload = landedDelivery.payload;
    if (typeof payload === 'object' && payload !== null) {
      const sha = (payload as { sha?: unknown }).sha;
      deliveredSha = typeof sha === 'string' && sha !== '' ? sha : null;
    }
  }

  // Markers clear ONLY now — every guarded event exists.
  input.ledger.clearPendingRebriefs(markers.map((marker) => marker.id));
  publishRebriefSettlement(input.ledger, input.jobId);
  return { minionId: input.minionId, deliveredSha, deliveryNote, rebriefRecorded, deliveryRecorded, superseded: false };
}

/** Markers this process is actively recovering — a second reconcile pass
 * (same boot, or a boot racing an open recovery) never double-dispatches. */
const activeClaims = new Set<string>();

/**
 * Boot reconciliation: for every pending marker older than this boot whose
 * guarded event never landed, either finish the recording (turn settled,
 * only the delivery record was lost) or re-dispatch a worker — resuming
 * the interrupted session when one exists, fresh otherwise — and record
 * the missing events when it settles. Failures escalate action-required.
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
    return { examined: 0, completed: 0, redispatched: 0, settled: Promise.resolve() };
  }
  const byJob = new Map<string, PendingRebriefRecord[]>();
  for (const marker of markers) {
    const group = byJob.get(marker.jobId);
    if (group === undefined) byJob.set(marker.jobId, [marker]);
    else group.push(marker);
  }

  let completed = 0;
  let redispatched = 0;
  const background: Promise<void>[] = [];
  for (const [jobId, group] of byJob) {
    const groupPhaseId = group.find((marker) => marker.phaseId !== null)?.phaseId ?? null;
    const missing = group.filter((marker) => pendingRebriefGuardedEvent(deps.ledger, marker, groupPhaseId) === null);
    if (missing.length === 0) {
      deps.ledger.clearPendingRebriefs(group.map((marker) => marker.id));
      publishRebriefSettlement(deps.ledger, jobId);
      completed += 1;
      continue;
    }
    // The turn settled before the restart and only the follow-up delivery
    // record was lost (`silas.rebrief` posted first). The lane is already
    // delivered; record the delivery directly instead of rerunning a turn.
    if (missing.every((marker) => marker.kind === 'job.delivered')) {
      const anchor = group.find((marker) => marker.kind === 'job.delivered') ?? group[0];
      const phaseId = group.find((marker) => marker.phaseId !== null)?.phaseId ?? null;
      const followUp = recordFollowUpDelivery({
        ledger: deps.ledger,
        worktrees: deps.worktrees,
        jobId,
        agentId: anchor?.agentId ?? null,
        source: 'silas-rebrief',
        ...(phaseId !== null ? { phaseId } : {}),
      });
      deps.ledger.clearPendingRebriefs(group.map((marker) => marker.id));
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
    if (job.status === 'merged' || job.status === 'done') {
      throw new Error(`job "${jobId}" is ${job.status} — terminal lanes are never re-briefed`);
    }
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
      if (resumeFile === null) throw error;
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
    });
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
        `re-dispatch the worker: ${String(error)}. Pending markers (${kinds}) remain; the ` +
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
