import { existsSync } from 'node:fs';
import type { EventBus } from '../events/bus.js';
import type { LedgerApi, WorktreeRecord } from '../ledger/api.js';
import { isReportDeliverable } from '../ledger/obligations.js';
import { isJobTerminal } from '../ledger/states.js';
import type { LogLevel } from '../logger.js';
import type { NotificationCenter } from '../notifications/center.js';
import type { JobWorkerTurns, PrepareWorkerTurn } from '../runtime/pacing.js';
import { laneIsBusy } from '../dispatch/branch-idle.js';
import {
  RESTORE_INCOMPLETE_NOTICE_KIND,
  restoreIncompleteNotice,
  restoreIncompleteNoticeId,
  SPARSE_CHECKOUT_NOTICE_KIND,
  sparseCheckoutNotice,
  sparseCheckoutNoticeId,
  SUBMODULE_WORK_NOTICE_KIND,
  submoduleWorkNotice,
  submoduleWorkNoticeId,
  sweepWorkNotice,
  type SavedWork,
  type SlimResult,
  type WorktreeManager,
  type WorktreeManagerOptions,
} from './manager.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Report-lane slimming (#427 PR 2a). A report job (deliverable review,
 * artifact or investigation) that has delivered keeps its lane while its
 * commissioner decides, and that lane carries its dependency folders. Once
 * the job is `delivered` and idle, GC deletes the `reclaim` folders of the
 * manifest the lane was built from; that manifest's `[[setup]]` restores
 * them before the lane's next minion turn or verification. Slimming is
 * lossless and automatic (owner ruling 2026-10-16).
 *
 * A slim is tried when a job moves to `delivered`, at start, and every five
 * minutes, one job at a time across the service. A lane that is not
 * eligible right now is skipped, and a later reconcile tries it again.
 * Idle means, at the moment of the slim, under the lane's lock:
 *
 * - the job is still a delivered report job and `laneIsBusy` says no (no
 *   live directive, re-brief, revision or unsettled verification run);
 * - no minion turn of the job holds or waits for a worker slot, and no
 *   provider wait of the job is open (its continuation would be a turn);
 * - no verification of the job is being readied, queued or running;
 * - the job's last activity (a minion turn's end, its delivery, a restore
 *   of its lanes or the end of a verification run) is at least
 *   {@link SLIM_MIN_IDLE_MS} old, so a lane its commissioner is still
 *   talking to is not slimmed and restored between every directive. An
 *   activity whose time cannot be read counts as recent, with a warn.
 *
 * The manager adds its own conditions (an active job or writer-child lane,
 * a base manifest with `reclaim` and `[[setup]]`, no process rooted in the
 * tree).
 *
 * The reconcile is quiet and bounded: an already-slim lane and a lane that
 * can never be slimmed (what its manifest says: no manifest, no reclaim or
 * setup, unparseable, or every entry holds a link or copy destination) are
 * skipped without a word; a decision, and the reclaim entries a slim
 * skipped with their reasons, are logged once, when they change; and a lane
 * the manager declined for a passing reason (a process, a git or ledger
 * failure) is not asked again (no process enumeration, no git) until the
 * job has a new turn, delivery, verification or restore, or one reconcile
 * interval has passed.
 */

/** Every five minutes, a delivered report job's lane is tried again. */
export const SLIM_RECONCILE_INTERVAL_MS = 300_000;

/** How long ago a report job's last activity must be before its lanes are
 * slimmed (#427; a constant for now). The disk budget's idle-lane slims
 * (#427 PR 3) use it too. */
export const SLIM_MIN_IDLE_MS = 30 * 60_000;

/** The job events that are its activity: a minion's state change (a turn's
 * end sets it idle), the job's delivery and its status change to
 * `delivered`, a restore of its lanes, and the end of a verification run.
 * The disk budget's idle-lane slims (#427 PR 3) read the same clock. */
export const LAST_ACTIVITY_KINDS = ['agent.state', 'job.delivered', 'job.status', 'worktree.rehydrated', 'verification.completed'] as const;

/** The job events after which a lane the manager declined is asked again:
 * a turn, a delivery, a verification, a restore or a claimed provider
 * continuation. The disk budget (#427 PR 3) asks a lane whose release
 * refused again after the same news. */
export const ANSWER_KINDS = [
  ...LAST_ACTIVITY_KINDS,
  'verification.requested', 'verification.no-start', 'worktree.rehydrate-failed', 'provider.recovery-claimed',
] as const;

export interface ReportLaneSlimmerOptions {
  readonly ledger: Pick<LedgerApi, 'getJob' | 'listJobs' | 'listJobEventsByKinds' | 'openProviderWaitForJob'> & Parameters<typeof laneIsBusy>[0];
  readonly bus: EventBus;
  readonly worktrees: Pick<WorktreeManager, 'slim' | 'listWorktrees' | 'isSlim'>;
  /** The job's minion turns at the pacing gate. */
  readonly workerTurns: (jobId: string) => JobWorkerTurns;
  /** True while a verification of the job is being readied, queued or running. */
  readonly verificationBusy: (jobId: string) => boolean;
  /** Clock seam (default Date.now). */
  readonly now?: () => number;
  readonly log?: Log;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  /** Run at the start of every reconcile (at start and every five minutes):
   * main.ts settles the lane rows whose lane is gone
   * ({@link LaneLifecycleHooks.settleLaneRows}). A failure is logged. */
  readonly onReconcile?: () => void;
}

export class ReportLaneSlimmer {
  private readonly log: Log;
  private readonly now: () => number;
  private unsubscribe: (() => void) | null = null;
  private reconcileTimer: ReturnType<typeof setInterval> | null = null;
  /** Jobs waiting for their pass, in order; one pass runs at a time. */
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private draining: Promise<void> | null = null;
  /** Lanes whose answer can never change. */
  private readonly unslimmable = new Set<string>();
  /** Lanes the manager declined, with the job's activity mark and the
   * time then. */
  private readonly declined = new Map<string, { readonly mark: number; readonly at: number }>();
  /** The last decision logged per lane. */
  private readonly decisions = new Map<string, string>();
  /** The last skipped reclaim entries logged per lane. */
  private readonly skips = new Map<string, string>();
  /** Activity events whose time could not be read, warned about once. */
  private readonly unreadable = new Set<number>();
  /** Aborted by {@link stop}: the manager checks it between entries. */
  private readonly stopping = new AbortController();
  private stopped = false;

  constructor(private readonly opts: ReportLaneSlimmerOptions) {
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
  }

  /** Follow `job.status → delivered`, try every delivered report job now,
   * and again every five minutes. */
  start(): void {
    if (this.unsubscribe !== null || this.stopped) return;
    this.unsubscribe = this.opts.bus.subscribe((event) => {
      if (event.kind !== 'job.status' || event.jobId === null) return;
      if ((event.payload as { to?: unknown } | null)?.to !== 'delivered') return;
      this.slimSoon(event.jobId);
    });
    this.reconcileTimer = (this.opts.setInterval ?? setInterval)(() => {
      try {
        this.reconcile();
      } catch (error) {
        this.log('error', 'lane slimming reconcile failed; the next interval retries it', { error: String(error) });
      }
    }, SLIM_RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref?.();
    this.reconcile();
  }

  /** Stop following and reconciling, and wait for the pass that is running
   * (the service's shutdown awaits this before the ledger closes). */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopping.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.reconcileTimer !== null) (this.opts.clearInterval ?? clearInterval)(this.reconcileTimer);
    this.reconcileTimer = null;
    this.queue.length = 0;
    this.queued.clear();
    await this.idle();
  }

  /** Try every delivered report job's lanes. */
  reconcile(): void {
    try {
      this.opts.onReconcile?.();
    } catch (error) {
      this.log('error', 'lane row settlement failed; the next reconcile retries it', { error: String(error) });
    }
    for (const job of this.opts.ledger.listJobs()) {
      if (job.status === 'delivered' && job.deliverable !== null && isReportDeliverable(job.deliverable)) this.slimSoon(job.id);
    }
  }

  /** Settles once every pass queued so far has finished. */
  async idle(): Promise<void> {
    while (this.draining !== null) await this.draining;
  }

  private slimSoon(jobId: string): void {
    if (this.stopped || this.queued.has(jobId)) return;
    this.queued.add(jobId);
    this.queue.push(jobId);
    this.draining ??= this.drain();
  }

  /** One job's pass at a time, across the service. */
  private async drain(): Promise<void> {
    for (;;) {
      const jobId = this.stopped ? undefined : this.queue.shift();
      if (jobId === undefined) {
        this.draining = null;
        return;
      }
      this.queued.delete(jobId);
      try {
        await this.slimJob(jobId);
      } catch (error) {
        this.log('error', 'lane slimming failed; the next reconcile retries it', { job: jobId, error: String(error) });
      }
    }
  }

  /** Slim each active job or writer-child lane of one delivered report job. */
  async slimJob(jobId: string): Promise<readonly SlimResult[]> {
    const results: SlimResult[] = [];
    const lanes = this.opts.worktrees.listWorktrees({ jobId, status: 'active' })
      .filter((lane) => lane.kind === 'job' || (lane.kind === 'child' && lane.branch !== null));
    const mark = this.activityMark(jobId);
    for (const lane of lanes) {
      if (this.stopped) break;
      if (this.unslimmable.has(lane.id) || this.opts.worktrees.isSlim(lane.id)) continue;
      const busy = this.whyNotIdle(jobId);
      if (busy !== null) {
        this.decide(lane.id, busy);
        continue;
      }
      const declined = this.declined.get(lane.id);
      if (declined !== undefined && declined.mark === mark && this.now() - declined.at < SLIM_RECONCILE_INTERVAL_MS) continue;
      // Stamped before the ask: the next reconcile, one interval after this
      // one began, asks again however long this slim took.
      const asked = this.now();
      const result = await this.opts.worktrees.slim({ worktreeId: lane.id, idle: () => this.whyNotIdle(jobId), signal: this.stopping.signal });
      // Only a pass that ran its plan knows the skipped entries.
      if (result.status === 'slimmed' || result.planned) this.noteSkipped(lane.id, result.skipped);
      if (result.status === 'not-slimmed') {
        if (result.permanent) this.unslimmable.add(lane.id);
        else this.declined.set(lane.id, { mark, at: asked });
        this.decide(lane.id, result.reason);
      } else {
        this.declined.delete(lane.id);
        this.decisions.delete(lane.id);
      }
      results.push(result);
    }
    return results;
  }

  /** Log why a lane is not slimmed, once per change of reason. */
  private decide(laneId: string, reason: string): void {
    if (this.decisions.get(laneId) === reason) return;
    this.decisions.set(laneId, reason);
    this.log('info', 'lane not slimmed', { lane: laneId, reason });
  }

  /** Log the reclaim entries a slim skipped by name, with their reasons,
   * once per change of them. */
  private noteSkipped(laneId: string, skipped: SlimResult['skipped']): void {
    const key = JSON.stringify(skipped);
    if ((this.skips.get(laneId) ?? '[]') === key) return;
    this.skips.set(laneId, key);
    if (skipped.length > 0) this.log('warn', 'lane slimming skipped reclaim entries', { lane: laneId, skipped });
  }

  /** The seq of the job's newest event that could change a declined answer. */
  private activityMark(jobId: string): number {
    return this.opts.ledger.listJobEventsByKinds(jobId, ANSWER_KINDS, { limit: 1 })[0]?.seq ?? 0;
  }

  /** Why the job's lanes cannot be slimmed right now, or null when idle. */
  private whyNotIdle(jobId: string): string | null {
    if (this.stopped) return 'the service is stopping';
    const job = this.opts.ledger.getJob(jobId);
    if (job === null) return 'the job is not in the ledger';
    if (job.deliverable === null || !isReportDeliverable(job.deliverable)) return 'only report jobs are slimmed';
    if (job.status !== 'delivered') return `the job is ${job.status}, not delivered`;
    if (laneIsBusy(this.opts.ledger, job)) return 'the lane is busy (a directive, re-brief, revision or verification is open)';
    const turns = this.opts.workerTurns(jobId);
    if (turns.held > 0 || turns.queued > 0) return `a minion turn holds or waits for a worker slot (${String(turns.held)} held, ${String(turns.queued)} queued)`;
    if (this.opts.ledger.openProviderWaitForJob(jobId) !== null) return 'a provider wait of the job is open (its continuation is a minion turn)';
    if (this.opts.verificationBusy(jobId)) return 'a verification is being readied, queued or running';
    const last = this.opts.ledger.listJobEventsByKinds(jobId, LAST_ACTIVITY_KINDS, { limit: 1 })[0];
    if (last === undefined) return null;
    const at = Date.parse(last.ts);
    if (Number.isNaN(at)) {
      // Never idle on a time nobody can read.
      if (!this.unreadable.has(last.seq)) {
        this.unreadable.add(last.seq);
        this.log('warn', 'a job activity event has a timestamp that cannot be read; its lanes count as not idle', { job: jobId, seq: last.seq, kind: last.kind, ts: last.ts });
      }
      return `the job's last activity (event ${String(last.seq)}) has a timestamp that cannot be read`;
    }
    if (this.now() - at < SLIM_MIN_IDLE_MS) {
      return `the job's last activity (a minion turn's end, its delivery, a restore or a verification) was less than ${String(SLIM_MIN_IDLE_MS / 60_000)} minutes ago`;
    }
    return null;
  }
}

/** The lane hooks the service wires (#427), made in one place so the tests
 * run exactly the closures main.ts passes on. */
export interface LaneLifecycleHooks {
  /** `WorktreeManagerOptions.onWorkSaved`: one FYI row per release that
   * saved a snapshot or a preserve copy. */
  readonly onWorkSaved: NonNullable<WorktreeManagerOptions['onWorkSaved']>;
  /** `WorktreeManagerOptions.onSubmoduleWorkRefused`: one action-required
   * row for Gru per lane and digest (a newer digest closes the older row). */
  readonly onSubmoduleWorkRefused: NonNullable<WorktreeManagerOptions['onSubmoduleWorkRefused']>;
  /** `WorktreeManagerOptions.onRestoreIncomplete`: one action-required row
   * for Gru per lane. */
  readonly onRestoreIncomplete: NonNullable<WorktreeManagerOptions['onRestoreIncomplete']>;
  /** `WorktreeManagerOptions.onSparseCheckoutRefused`: one action-required
   * row for Gru per lane. */
  readonly onSparseCheckoutRefused: NonNullable<WorktreeManagerOptions['onSparseCheckoutRefused']>;
  /** Part of `WorktreeManagerOptions.onSwept`: a lane swept by any path
   * closes every submodule-work row of it (each digest), and its
   * restore-incomplete and sparse-checkout rows. */
  readonly onSwept: (input: { readonly worktree: WorktreeRecord }) => void;
  /** Close the lane rows (submodule work, restore incomplete, sparse
   * checkout) whose lane is swept or no longer in the registry, or whose
   * job is terminal and whose tree is gone: the sweep that should have
   * closed them may never have told anyone (a crash between the two). Run
   * by the slimmer's reconcile ({@link ReportLaneSlimmerOptions.onReconcile}). */
  readonly settleLaneRows: () => void;
  /** The pacing gate's `prepareWorkerTurn`: the turn's stop or cancel ends
   * a restore's setup. */
  readonly beforeWorkerTurn: PrepareWorkerTurn;
  /** A provider-recovery continuation's restore; the service's stop ends
   * setup, and then the continuation neither spawns nor prompts
   * (`'stopped'`). */
  readonly beforeContinuation: (jobId: string) => Promise<'ready' | 'stopped'>;
  /** A verification's restore inside its slot; the run's signal ends
   * setup. */
  readonly beforeVerification: (jobId: string, signal: AbortSignal) => Promise<void>;
}

/** Build the {@link LaneLifecycleHooks}: each restore runs
 * `WorktreeManager.ensureReady` for the job with the caller's signal (a
 * continuation's is the service's stop), and the manager's notices are
 * posted ({@link sweepWorkNotice}, {@link submoduleWorkNotice},
 * {@link restoreIncompleteNotice}). `manager` is read when a hook runs (the
 * pacing gate is built before the manager). */
export function laneLifecycleHooks(deps: {
  readonly manager: () => Pick<WorktreeManager, 'ensureReady'> | null;
  readonly notifications: Pick<NotificationCenter, 'post'>;
  readonly ledger: Pick<LedgerApi, 'resolveNotificationById' | 'resolveNotificationsByIdPrefix' | 'listOpenNotificationsByKinds' | 'getWorktree' | 'getJob'>;
  /** The service's stop: it ends a continuation's restore, and the
   * continuation with it. */
  readonly stopSignal: AbortSignal;
}): LaneLifecycleHooks {
  const restore = async (jobId: string, signal: AbortSignal | undefined): Promise<void> => {
    const manager = deps.manager();
    if (manager === null) throw new Error('a lane restore ran before the worktree manager is up');
    await manager.ensureReady(jobId, signal === undefined ? {} : { signal });
  };
  const resolved = 'lane-released';
  const closeLaneRows = (laneId: string, by: string): void => {
    deps.ledger.resolveNotificationsByIdPrefix(submoduleWorkNoticeId(laneId, ''), by);
    deps.ledger.resolveNotificationById(restoreIncompleteNoticeId(laneId), by);
    deps.ledger.resolveNotificationById(sparseCheckoutNoticeId(laneId), by);
  };
  return {
    onWorkSaved: (input: SavedWork) => { deps.notifications.post(sweepWorkNotice(input)); },
    onSubmoduleWorkRefused: ({ worktree, submodules, digest, previousDigest, staleDiscard }) => {
      deps.notifications.post(submoduleWorkNotice({ worktree, submodules, digest, staleDiscard }));
      // The digest an older row names would be refused now: that row is done.
      if (previousDigest !== null) deps.ledger.resolveNotificationById(submoduleWorkNoticeId(worktree.id, previousDigest), 'submodule-work-changed');
    },
    onRestoreIncomplete: (input) => { deps.notifications.post(restoreIncompleteNotice(input)); },
    onSparseCheckoutRefused: (input) => { deps.notifications.post(sparseCheckoutNotice(input)); },
    onSwept: ({ worktree }) => { closeLaneRows(worktree.id, resolved); },
    settleLaneRows: () => {
      for (const row of deps.ledger.listOpenNotificationsByKinds([SUBMODULE_WORK_NOTICE_KIND, RESTORE_INCOMPLETE_NOTICE_KIND, SPARSE_CHECKOUT_NOTICE_KIND])) {
        const laneId = laneOfRow(row.id);
        if (laneId === null) continue;
        const lane = deps.ledger.getWorktree(laneId);
        const job = lane?.jobId == null ? null : deps.ledger.getJob(lane.jobId);
        const gone = lane === null || lane.status === 'swept' ||
          (!existsSync(lane.path) && (lane.jobId === null || job === null || isJobTerminal(job.status)));
        if (gone) closeLaneRows(laneId, 'lane-gone');
      }
    },
    beforeWorkerTurn: restore,
    beforeContinuation: async (jobId) => {
      await restore(jobId, deps.stopSignal);
      return deps.stopSignal.aborted ? 'stopped' : 'ready';
    },
    beforeVerification: restore,
  };
}

/** The lane a lane row names (its id: `<prefix>:<lane>`, and `:<digest>`
 * after it for a submodule-work row), or null for an id of another shape. */
function laneOfRow(id: string): string | null {
  const submodule = submoduleWorkNoticeId('', '').slice(0, -1);
  if (id.startsWith(submodule)) {
    const rest = id.slice(submodule.length);
    const digest = rest.lastIndexOf(':');
    return digest > 0 ? rest.slice(0, digest) : null;
  }
  for (const prefix of [restoreIncompleteNoticeId(''), sparseCheckoutNoticeId('')]) {
    if (id.startsWith(prefix) && id.length > prefix.length) return id.slice(prefix.length);
  }
  return null;
}

/** Start the slimmer after the service listens: off the heist path, so a
 * failure to start is loud, never fatal. */
export function startLaneSlimmer(slimmer: Pick<ReportLaneSlimmer, 'start'>, log: Log): void {
  try {
    slimmer.start();
  } catch (error) {
    log('error', 'lane slimming failed to start', { error: String(error) });
  }
}
