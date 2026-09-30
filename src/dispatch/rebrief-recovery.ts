import { existsSync } from 'node:fs';
import { isJobTerminal } from '../ledger/states.js';
import type {
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
 * instead of re-dispatching or escalating forever.
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
  /** True when the job was already terminal at the boundary: the request
   * was administratively retired instead of recorded (no event, no
   * delivery, no reopen). */
  readonly retired: boolean;
}

export interface ReconcileReport {
  /** Markers examined this pass (already-claimed markers are not examined twice). */
  readonly examined: number;
  /** Jobs whose guarded events were already landed and whose markers cleared. */
  readonly completed: number;
  /** Jobs handed to a background re-dispatch (resume or fresh worker). */
  readonly redispatched: number;
  /** Jobs whose obsolete request family was administratively retired
   * because the job is terminal (one per job group, this pass). */
  readonly retired: number;
  /** Settles when every background re-dispatch has settled — resumed,
   * escalated, or abandoned because the process is stopping. Boot does not
   * await it (a re-brief turn is long); tests do. */
  readonly settled: Promise<void>;
}

/**
 * Has this marker's guarded event landed? The event must post-date the
 * request's sequence watermark — an older event of the same kind cannot
 * answer a newer request.
 */
export function pendingRebriefEventLanded(
  ledger: Pick<LedgerApi, 'latestJobEvent'>,
  marker: PendingRebriefRecord,
): boolean {
  const event = ledger.latestJobEvent(marker.jobId, marker.kind);
  return event !== null && event.seq > marker.baselineSeq;
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
}): PendingRebriefFinalize {
  const markers = input.ledger.listPendingRebriefs({ jobId: input.jobId });
  if (markers.length === 0) {
    // No markers means the request already finalized (events landed) — a
    // replay is a no-op, never a duplicate event. Every live re-brief
    // begins its markers before it can reach here.
    return { minionId: input.minionId, deliveredSha: null, deliveryNote: null, rebriefRecorded: false, deliveryRecorded: false, retired: false };
  }
  const missing = markers.filter((marker) => !pendingRebriefEventLanded(input.ledger, marker));
  const job = input.ledger.getJob(input.jobId);
  if (missing.length > 0 && job !== null && isJobTerminal(job.status)) {
    // The job went terminal under the turn's feet: the guarded events can
    // no longer be honored truthfully. Retire the request instead of
    // recording a stale late completion (no reopen, no fabricated
    // delivery, no kill — the turn's artifacts stay on the lane).
    const retirement = retireTerminalRebriefs(input.ledger, job, markers);
    return {
      minionId: input.minionId,
      deliveredSha: null,
      deliveryNote: null,
      rebriefRecorded: false,
      deliveryRecorded: false,
      retired: retirement.retired.length > 0,
    };
  }
  const rebriefMarker = markers.find((marker) => marker.kind === 'silas.rebrief') ?? null;
  const deliveryMarker = markers.find((marker) => marker.kind === 'job.delivered') ?? null;

  let rebriefRecorded = false;
  if (rebriefMarker === null || !pendingRebriefEventLanded(input.ledger, rebriefMarker)) {
    input.ledger.appendCustomEvent({
      kind: 'silas.rebrief',
      jobId: input.jobId,
      payload: { minion_id: input.minionId, lane: input.lanePath, note: input.note },
    });
    rebriefRecorded = true;
  }
  flipJobToWorking(input.ledger, input.jobId);

  let deliveredSha: string | null = null;
  let deliveryNote: string | null = null;
  let deliveryRecorded = false;
  if (deliveryMarker === null || !pendingRebriefEventLanded(input.ledger, deliveryMarker)) {
    const followUp = recordFollowUpDelivery({
      ledger: input.ledger,
      worktrees: input.worktrees,
      jobId: input.jobId,
      agentId: input.minionId,
      source: 'silas-rebrief',
    });
    deliveredSha = followUp.sha;
    deliveryNote = followUp.note;
    deliveryRecorded = true;
  } else {
    // The delivery already landed (reconcile caught a crash window): report
    // the recorded head without appending a duplicate.
    const payload = input.ledger.latestJobEvent(input.jobId, 'job.delivered')?.payload;
    if (typeof payload === 'object' && payload !== null) {
      const sha = (payload as { sha?: unknown }).sha;
      deliveredSha = typeof sha === 'string' && sha !== '' ? sha : null;
    }
  }

  // Markers clear ONLY now — every guarded event exists.
  input.ledger.clearPendingRebriefs(markers.map((marker) => marker.id));
  return { minionId: input.minionId, deliveredSha, deliveryNote, rebriefRecorded, deliveryRecorded, retired: false };
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
    const missing = group.filter((marker) => !pendingRebriefEventLanded(deps.ledger, marker));
    if (missing.length === 0) {
      deps.ledger.clearPendingRebriefs(group.map((marker) => marker.id));
      completed += 1;
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
        });
      }
      continue;
    }
    // The turn settled before the restart and only the follow-up delivery
    // record was lost (`silas.rebrief` posted first). The lane is already
    // delivered; record the delivery directly instead of rerunning a turn.
    if (missing.every((marker) => marker.kind === 'job.delivered')) {
      const anchor = group.find((marker) => marker.kind === 'job.delivered') ?? group[0];
      const followUp = recordFollowUpDelivery({
        ledger: deps.ledger,
        worktrees: deps.worktrees,
        jobId,
        agentId: anchor?.agentId ?? null,
        source: 'silas-rebrief',
      });
      deps.ledger.clearPendingRebriefs(group.map((marker) => marker.id));
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
      const retirement = retireTerminalRebriefs(deps.ledger, job, group);
      if (retirement.retired.length > 0) {
        deps.log?.('info', 're-brief request retired: job terminal before re-dispatch', {
          job: jobId,
          status: job.status,
        });
      }
      return;
    }
    const lane = deps.worktrees
      .listWorktrees({ jobId })
      .find((candidate) => candidate.kind === 'job' && candidate.status !== 'swept');
    if (lane === undefined) {
      throw new Error(`job "${jobId}" has no active job lane — a re-brief needs its worktree`);
    }
    const rebriefMarker = group.find((marker) => marker.kind === 'silas.rebrief') ?? group[0];
    const note = rebriefMarker?.note ?? '';
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
      path = resumeFile !== null ? 'resumed' : 'redispatched';
    } catch (error) {
      if (resumeFile === null) throw error;
      deps.log?.('warn', 're-brief resume failed — retrying with a fresh worker', {
        job: jobId,
        resume_file: resumeFile,
        error: String(error),
      });
      result = await runRebriefTurn(deps, { jobId, note, briefing: job.briefing, group });
    }
    const finalized = finalizeRebriefRequest({
      ledger: deps.ledger,
      worktrees: deps.worktrees,
      jobId,
      minionId: result.minionId,
      lanePath: result.lanePath,
      note,
    });
    if (finalized.retired) {
      // The job reached terminal while the recovered turn was in flight:
      // the ledger already recorded the retirement, the turn's artifacts
      // stay on the lane, and no recovery/delivery event is fabricated.
      deps.log?.('info', 're-brief recovery closed: job went terminal mid-turn', {
        job: jobId,
        path,
        minion_id: result.minionId,
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
  ledger: Pick<LedgerApi, 'latestJobEvent' | 'retirePendingRebriefs'>,
  job: { readonly id: string; readonly status: JobStatus },
  group: readonly PendingRebriefRecord[],
): PendingRebriefRetirement {
  const candidates: PendingRebriefRetireCandidate[] = group.map((marker) => ({
    id: marker.id,
    kind: marker.kind,
    payloadHash: marker.payloadHash,
    baselineSeq: marker.baselineSeq,
    guardedEventLanded: pendingRebriefEventLanded(ledger, marker),
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
