import type { LogLevel } from '../logger.js';
import type { EventBus } from '../events/bus.js';
import type { LedgerApi } from '../ledger/api.js';
import {
  evaluatePipelineEntry,
  pipelineBlockingReason,
  pipelineOrder,
  type PipelineBoardView,
  type PipelineCapacityView,
  type PipelineEntryRecord,
  type PipelineEvaluationContext,
  type PipelinePrerequisite,
} from '../ledger/pipeline.js';
import type { AgentEventEnvelope } from '../runtime/registry.js';
import type { NotificationCenter } from '../notifications/center.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * The mechanical Silas-consumed pipeline consumer (owner approvals
 * j-239/j-1064). It watches the durable queue, the ledger bus and the
 * runtime's capacity events, and admits eligible entries through the
 * EXISTING DispatchService — no second scheduler, session or counter:
 *
 * - admission requires the shared resident budget to have a free slot
 *   (`available >= 1`) and no older resident admission queued ahead
 *   (`queued === 0`); the budget itself stays the authority.
 * - a claim is persisted BEFORE dispatch side effects and admits the
 *   entry id as the job id; the job's normal lifecycle takes over from
 *   there (admitted entries leave the pipeline projection).
 * - blocked/high-priority entries are skipped, never head-of-line; a
 *   blocked entry does not stop unrelated eligible work.
 * - reconsideration is triggered by enqueue, relevant bus events
 *   (dependency/job transitions) and runtime capacity events — never a
 *   polling daemon. Boot reconciliation resolves interrupted claims.
 * - dispatch failures never duplicate work: a failed dispatch whose job
 *   row exists is ADOPTED; a failure before any job row requeues with
 *   the reason, bounded attempts then a terminal `failed` + one
 *   machine-attention card.
 */

export interface PipelineCaller {
  readonly by?: string | null;
}

/** The dispatch surface the pipeline needs (DispatchService satisfies it
 * structurally: its outcome carries the background `settled` promise). */
export interface PipelineDispatchPort {
  dispatch(input: {
    readonly jobId: string;
    readonly repoPath: string;
    readonly title: string;
    readonly briefing: string;
  }): Promise<{ readonly settled: Promise<unknown> }>;
}

export interface PipelineServiceOptions {
  readonly ledger: LedgerApi;
  readonly dispatch: PipelineDispatchPort;
  /** The shared resident budget's live state — the ONLY capacity
   * authority; never a queue-local counter. */
  readonly capacity: () => PipelineCapacityView;
  readonly bus?: EventBus;
  readonly notifications?: NotificationCenter;
  /** Bounded no-job admission attempts before a terminal `failed`. */
  readonly maxAdmissionFailures?: number;
  readonly log?: Log;
}

export interface PipelineEnqueueInput {
  readonly id: string;
  readonly requestId?: string;
  readonly repoPath: string;
  readonly title: string;
  readonly briefing: string;
  readonly priority?: number;
  readonly prerequisites?: readonly PipelinePrerequisite[];
  readonly exclusiveScopes?: readonly string[];
  readonly holdReason?: string | null;
  readonly by?: string | null;
}

export interface PipelineEnqueueReceipt {
  readonly entryId: string;
  readonly requestId: string;
  readonly state: string;
  readonly priority: number;
  readonly enqueueSeq: number;
  readonly queuedAt: string;
  readonly held: boolean;
  /** True when this was a replay of an already-accepted request. */
  readonly duplicate: boolean;
}

export interface PipelineReconcileReport {
  readonly examined: number;
  readonly adopted: number;
  readonly requeued: number;
}

const ADMISSION_HOLDER = 'silas-pipeline';
const DEFAULT_MAX_ADMISSION_FAILURES = 3;

export class PipelineService {
  private readonly opts: PipelineServiceOptions;
  private readonly log: Log;
  private readonly maxAdmissionFailures: number;
  private running = false;
  private pending = false;
  private disposed = false;
  private unsubscribeBus: (() => void) | null = null;
  private readonly idleResolvers: Array<() => void> = [];

  constructor(opts: PipelineServiceOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.maxAdmissionFailures = opts.maxAdmissionFailures ?? DEFAULT_MAX_ADMISSION_FAILURES;
    if (!Number.isSafeInteger(this.maxAdmissionFailures) || this.maxAdmissionFailures < 1) {
      throw new Error(`pipeline maxAdmissionFailures must be a positive safe integer, got ${String(this.maxAdmissionFailures)}`);
    }
    // Dependency transitions (job terminal/status), enqueues and every
    // other durable queue change arrive on the ledger bus; delivery is
    // synchronous and coalesced by schedule(). No timer, no poller.
    this.unsubscribeBus = opts.bus?.subscribe(() => this.schedule()) ?? null;
  }

  /** Accept an approved briefing; the durable row exists before this
   * returns and a replay never duplicates work. */
  enqueue(input: PipelineEnqueueInput): PipelineEnqueueReceipt {
    const { record, created } = this.opts.ledger.enqueuePipelineEntry(input);
    if (created) this.schedule();
    return {
      entryId: record.id,
      requestId: record.requestId,
      state: record.state,
      priority: record.priority,
      enqueueSeq: record.enqueueSeq,
      queuedAt: record.queuedAt,
      held: record.holdReason !== null,
      duplicate: !created,
    };
  }

  entry(id: string): PipelineEntryRecord | null {
    return this.opts.ledger.getPipelineEntry(id);
  }

  /** Server-computed board projection (admitted/cancelled excluded;
   * waiting/ready/admitting/failed with exact reasons). */
  view(): PipelineBoardView {
    return this.opts.ledger.pipelineBoardView(this.opts.capacity());
  }

  hold(id: string, reason: string, caller: PipelineCaller = {}): PipelineEntryRecord {
    const record = this.opts.ledger.holdPipelineEntry({ id, reason, by: caller.by ?? null });
    this.schedule();
    return record;
  }

  clearHold(id: string, reason: string | null, caller: PipelineCaller = {}): PipelineEntryRecord {
    const record = this.opts.ledger.clearPipelineHold({ id, reason, by: caller.by ?? null });
    this.schedule();
    return record;
  }

  cancel(id: string, reason: string, caller: PipelineCaller = {}): PipelineEntryRecord {
    const record = this.opts.ledger.cancelPipelineEntry({ id, reason, by: caller.by ?? null });
    this.schedule();
    return record;
  }

  /** Runtime tap: a disposed worker releases a resident permit, which is
   * exactly the event that can unblock a capacity-waiting entry. */
  noteRuntimeEvent(envelope: AgentEventEnvelope): void {
    if (envelope.phase === 'disposed' || envelope.phase === 'spawned') this.schedule();
  }

  /** Boot reconciliation: an `admitting` claim from a previous process
   * either finds its job (adopt, no duplicate dispatch) or returns the
   * entry to waiting with the accepted brief intact. */
  reconcileAtBoot(): PipelineReconcileReport {
    let examined = 0;
    let adopted = 0;
    let requeued = 0;
    for (const entry of this.opts.ledger.listPipelineEntries({ states: ['admitting'] })) {
      examined += 1;
      const job = this.opts.ledger.getJob(entry.id);
      if (job !== null && job.briefing === entry.briefing) {
        if (this.finalizeAdmission(entry)) {
          adopted += 1;
        } else {
          requeued += 1;
        }
        continue;
      }
      this.opts.ledger.releasePipelineClaim({
        id: entry.id,
        reason: 'service restart during admission',
        outcome: 'reconciled',
        note: 'reconciled at boot before any admission evidence existed — the accepted brief is intact and will be reconsidered',
      });
      requeued += 1;
    }
    this.schedule();
    return { examined, adopted, requeued };
  }

  /** Coalesced trigger; safe to call from any event. */
  schedule(): void {
    if (this.disposed) return;
    this.pending = true;
    if (!this.running) void this.run();
  }

  /** Test/ops seam: resolves when no reconsider pass is in flight. */
  whenIdle(): Promise<void> {
    if ((!this.running && !this.pending) || this.disposed) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeBus?.();
    this.unsubscribeBus = null;
    this.settleIdle();
  }

  private settleIdle(): void {
    if ((this.running || this.pending) && !this.disposed) return;
    for (const resolve of this.idleResolvers.splice(0)) resolve();
  }

  private async run(): Promise<void> {
    this.running = true;
    try {
      while (this.pending && !this.disposed) {
        this.pending = false;
        await this.reconsiderOnce();
      }
    } catch (error) {
      // A pass failure is loud but never fatal: the durable queue and
      // the next trigger own recovery; nothing is half-claimed here.
      this.log('error', 'pipeline reconsider pass failed', { error: String(error) });
    } finally {
      this.running = false;
      if (this.pending && !this.disposed) {
        void this.run();
      } else {
        this.settleIdle();
      }
    }
  }

  private evalContext(entries: readonly PipelineEntryRecord[]): PipelineEvaluationContext {
    return {
      entries,
      jobStatusOf: (jobId) => this.opts.ledger.getJob(jobId)?.status ?? null,
      capacity: this.opts.capacity(),
    };
  }

  /** One bounded pass: normalize waiting/ready honestly, then admit
   * eligible entries in the approved order while the SHARED budget has
   * room. Every step re-reads durable state (a claim changes scope
   * holders), so no stale context can double-admit a scope. */
  private async reconsiderOnce(): Promise<void> {
    const before = this.opts.ledger.listPipelineEntries();
    for (const entry of before) {
      if (entry.state !== 'waiting' && entry.state !== 'ready') continue;
      const evaluation = evaluatePipelineEntry(entry, this.evalContext(before));
      const target = evaluation.state === 'waiting' ? 'waiting' : 'ready';
      if (entry.state !== target) {
        this.opts.ledger.setPipelineEntryState({ id: entry.id, state: target, reason: evaluation.reason });
      }
    }
    for (;;) {
      if (this.disposed) return;
      const entries = this.opts.ledger.listPipelineEntries();
      const ctx = this.evalContext(entries);
      const next = entries
        .filter((entry) => entry.state === 'waiting' || entry.state === 'ready')
        .sort(pipelineOrder)
        .find((entry) => pipelineBlockingReason(entry, ctx) === null);
      if (next === undefined) return;
      const capacity = this.opts.capacity();
      if (capacity.available < 1 || capacity.queued > 0) return;
      const claimed = this.opts.ledger.claimPipelineEntry({ id: next.id, holder: ADMISSION_HOLDER });
      if (claimed === null) continue; // raced; re-read and pick the next entry
      await this.admit(claimed);
    }
  }

  private async admit(entry: PipelineEntryRecord): Promise<void> {
    let settled: Promise<unknown>;
    try {
      const outcome = await this.opts.dispatch.dispatch({
        jobId: entry.id,
        repoPath: entry.repoPath,
        title: entry.title,
        briefing: entry.briefing,
      });
      settled = outcome.settled;
    } catch (error) {
      const detail = `admission failed: ${String(error).slice(0, 300)}`;
      const job = this.opts.ledger.getJob(entry.id);
      if (job !== null && job.briefing === entry.briefing) {
        // Dispatch committed the job row before failing; its lifecycle
        // owns the failure (blocked + note). Adopt — never re-dispatch.
        this.finalizeAdmission(entry);
        this.log('warn', 'pipeline entry adopted its pre-existing job after a dispatch failure', {
          entry: entry.id,
          error: detail,
        });
        return;
      }
      const failures = entry.failureCount + 1;
      if (failures >= this.maxAdmissionFailures) {
        this.opts.ledger.releasePipelineClaim({ id: entry.id, reason: detail, outcome: 'failed' });
        this.notifyAdmissionFailed(entry, detail);
      } else {
        this.opts.ledger.releasePipelineClaim({
          id: entry.id,
          reason: detail,
          outcome: 'requeue',
          note: `attempt ${failures}/${this.maxAdmissionFailures} failed before any job existed`,
        });
      }
      return;
    }
    this.finalizeAdmission(entry);
    // The briefing turn runs in the background (dispatch owns it); when it
    // settles, capacity may have moved for a waiting follower. Rejections
    // are owned here so the settled promise never leaks unhandled.
    void settled
      .catch(() => {
        /* the job lifecycle recorded the outcome; nothing to duplicate */
      })
      .finally(() => this.schedule());
  }

  /** Bookkeeping-safe admission: a ledger failure after the dispatch side
   * effect must never leave a permanently admitting claim. It reconciles
   * the row back to waiting; a retry ADOPTS the existing job (the dispatch
   * throws on the duplicate id and the adopt path wins) instead of
   * duplicating work. */
  private finalizeAdmission(entry: PipelineEntryRecord): boolean {
    try {
      this.opts.ledger.markPipelineAdmitted({ id: entry.id, jobId: entry.id });
      return true;
    } catch (error) {
      this.log('error', 'pipeline admission bookkeeping failed — reconciled for a safe retry', {
        entry: entry.id,
        error: String(error),
      });
      try {
        this.opts.ledger.releasePipelineClaim({
          id: entry.id,
          reason: `admission bookkeeping failed: ${String(error).slice(0, 300)}`,
          outcome: 'reconciled',
          note: 'reconciled by the live pass; a retry adopts the existing job rather than duplicating it',
        });
        this.schedule();
      } catch {
        // The ledger itself is failing; boot reconciliation owns the claim.
      }
      return false;
    }
  }

  private notifyAdmissionFailed(entry: PipelineEntryRecord, reason: string): void {
    try {
      this.opts.notifications?.post({
        kind: 'pipeline.admission-failed',
        routing: 'action-required',
        severity: 'error',
        title: `Pipeline admission failed: ${entry.title}`.slice(0, 200),
        detail: `${entry.id} — ${reason}`.slice(0, 1000),
      });
    } catch (error) {
      this.log('error', 'pipeline admission-failure card failed to post', {
        entry: entry.id,
        error: String(error),
      });
    }
  }
}
