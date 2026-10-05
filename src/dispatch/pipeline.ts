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
import { isJobTerminal } from '../ledger/states.js';
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
  /** The shared resident budget itself (optional seam): when eligible work
   * waits on a full pool, the consumer keeps ONE queued acquire open so
   * the budget's own demand-driven idle-minion reclaim can serve approved
   * work — the same mechanism every other admission uses. The permit is
   * released the moment it grants (wake-up only); admission still reads
   * the budget afresh, so no capacity is bypassed or double-held. */
  readonly budget?: {
    readonly acquire: (signal?: AbortSignal) => Promise<() => void>;
  };
  readonly bus?: EventBus;
  readonly notifications?: NotificationCenter;
  /** Bounded no-job admission attempts before a terminal `failed`. */
  readonly maxAdmissionFailures?: number;
  /** Bounded error/backoff retry base in ms (default 5000). One-shot
   * recovery arming — never a polling daemon; any natural trigger
   * (enqueue, bus event, capacity event) clears it. */
  readonly retryBackoffMs?: number;
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
const DEFAULT_RETRY_BACKOFF_MS = 5_000;
/** Consecutive failed passes before the one-shot recovery stands down and
 * waits for a natural trigger (bounded, never a spin). */
const MAX_CONSECUTIVE_PASS_FAILURES = 3;
/** After a budget wake refusal (reclaim exhaustion), do not re-register
 * demand for this window; natural triggers still admit directly. */
const WAKE_REFUSAL_WINDOW_MS = 60_000;
/** Consecutive admission-finalization failures before the backoff stands
 * down for a natural trigger (bounded, never a tight loop). */
const MAX_CONSECUTIVE_FINALIZE_FAILURES = 3;

/** Reconsideration triggers are EXTERNAL facts — exactly the inputs the
 * evaluator reads. New accepted work (pipeline.enqueued), a deliberate
 * owner hold release (pipeline.hold-cleared) and every job.* transition
 * (status, delivery, worker start) can change eligibility. The consumer's
 * own bookkeeping (claim/requeue/state/…) and transitive notification
 * events carry no new information — re-triggering on them would spin
 * bounded admission retries back-to-back through an outage. */
function isExternalTrigger(kind: string): boolean {
  return kind.startsWith('job.') || kind === 'pipeline.enqueued' || kind === 'pipeline.hold-cleared';
}

export class PipelineService {
  private readonly opts: PipelineServiceOptions;
  private readonly log: Log;
  private readonly maxAdmissionFailures: number;
  private readonly retryBackoffMs: number;
  private running = false;
  private pending = false;
  private disposed = false;
  private unsubscribeBus: (() => void) | null = null;
  private readonly idleResolvers: Array<() => void> = [];
  /** One-shot bounded recovery arming (D4): a failed pass or a requeued
   * admission attempt retries after a backoff when no natural trigger
   * arrives first. Any natural trigger clears it — this is error
   * recovery, never a polling daemon. */
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutivePassFailures = 0;
  /** Demand registration with the shared budget (D1): a queued acquire
   * held ONLY while eligible work is capacity-blocked, released the
   * instant it grants. `wakeRefusedUntil` bounds re-arming after the
   * budget surfaces a reclaim exhaustion. */
  private wakeAbort: AbortController | null = null;
  private wakePending = false;
  private wakeRefusedUntil = 0;
  /** Entries with a live in-flight dispatch claim (this process). An
   * `admitting` row NOT in this set is recovery debt a live pass must
   * reconcile — never invisible until a restart (Perkins r1 blocker 3). */
  private readonly inFlightAdmissions = new Set<string>();
  /** Consecutive admission-finalization failures: after three, the
   * backoff stands down and waits for a natural trigger (bounded, never
   * a tight loop — Perkins r1 blocker 4). */
  private consecutiveFinalizeFailures = 0;

  constructor(opts: PipelineServiceOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.maxAdmissionFailures = opts.maxAdmissionFailures ?? DEFAULT_MAX_ADMISSION_FAILURES;
    this.retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    if (!Number.isSafeInteger(this.maxAdmissionFailures) || this.maxAdmissionFailures < 1) {
      throw new Error(`pipeline maxAdmissionFailures must be a positive safe integer, got ${String(this.maxAdmissionFailures)}`);
    }
    if (!Number.isSafeInteger(this.retryBackoffMs) || this.retryBackoffMs < 1) {
      throw new Error(`pipeline retryBackoffMs must be a positive safe integer, got ${String(this.retryBackoffMs)}`);
    }
    // External facts only (see isExternalTrigger): delivery is
    // synchronous and coalesced by schedule(); self-caused and transitive
    // noise is filtered — no timer, no poller, no self-spin.
    this.unsubscribeBus =
      opts.bus?.subscribe((event) => {
        if (!isExternalTrigger(event.kind)) return;
        this.schedule();
      }) ?? null;
  }

  /** Accept an approved briefing; the durable row exists before this
   * returns and a replay never duplicates work. A replay returns the
   * ACCEPTANCE receipt (the frozen matrix: "the same receipt except
   * `duplicate: true`") — live state is the readback endpoint's job, never
   * a mutated receipt. */
  enqueue(input: PipelineEnqueueInput): PipelineEnqueueReceipt {
    const { record, created } = this.opts.ledger.enqueuePipelineEntry(input);
    // With the bus wired, the durable pipeline.enqueued event IS the
    // trigger (it fired inside the transaction above); a second explicit
    // schedule would disarm a retry an armed pass is already spacing.
    // Without a bus, enqueue self-triggers.
    if (created && this.unsubscribeBus === null) this.schedule();
    return {
      entryId: record.id,
      requestId: record.requestId,
      state: created ? record.state : 'waiting',
      priority: record.priority,
      enqueueSeq: record.enqueueSeq,
      queuedAt: record.queuedAt,
      held: created ? record.holdReason !== null : (input.holdReason ?? null) !== null,
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
      if (this.reconcileClaim(entry) === 'adopted') adopted += 1;
      else requeued += 1;
    }
    this.schedule();
    return { examined, adopted, requeued };
  }

  /** Shared claim reconciliation (boot AND live recovery — Perkins r1
   * blocker 3): a claim whose dispatch is NOT in flight is recovery
   * debt. A committed matching job is NEVER re-dispatched; a job that
   * was committed but never started a worker is surfaced through the
   * existing blocked-obligation vocabulary (blocked status + durable
   * note + one machine card) before adoption (Perkins r2 blocker 5).
   * An unadvanced recovery returns 'failed' so the caller can arm the
   * bounded retry (Perkins r2 blocker 4). */
  private reconcileClaim(entry: PipelineEntryRecord): 'adopted' | 'requeued' | 'failed' {
    const job = this.opts.ledger.getJob(entry.id);
    if (job !== null && job.briefing === entry.briefing) {
      if (!this.opts.ledger.jobHasWorkerStart(entry.id) && !isJobTerminal(job.status) && job.status !== 'blocked') {
        // Interrupted startup (crash between job commit and worker
        // registration): no minion ever ran, so this is recovery debt,
        // not a live handoff. Block it with a durable note and post ONE
        // machine-attention card; still adopt (never re-dispatch).
        try {
          this.opts.ledger.setJobStatus(entry.id, 'blocked');
          this.opts.ledger.noteJob(
            entry.id,
            'pipeline recovery: the job was committed but no worker ever started — resolve the interrupted startup and re-arm',
          );
          this.opts.notifications?.post({
            kind: 'pipeline.adopted-without-worker',
            routing: 'action-required',
            severity: 'error',
            title: `Interrupted admission: ${entry.title}`.slice(0, 200),
            detail:
              `${entry.id} — the job was committed before any minion started; it is blocked for recovery (never re-dispatched)`.slice(
                0,
                1000,
              ),
          });
        } catch (error) {
          this.log('error', 'pipeline interrupted-startup surfacing failed', {
            entry: entry.id,
            error: String(error),
          });
        }
      }
      return this.finalizeAdmission(entry) ? 'adopted' : 'failed';
    }
    try {
      this.opts.ledger.releasePipelineClaim({
        id: entry.id,
        reason: 'admission recovery: no committed job for the claim',
        outcome: 'reconciled',
        note: 'reconciled before any admission evidence existed — the accepted brief is intact and will be reconsidered',
      });
      return 'requeued';
    } catch (error) {
      this.log('error', 'pipeline claim reconciliation failed — bounded retry owns it', {
        entry: entry.id,
        error: String(error),
      });
      return 'failed';
    }
  }

  /** Coalesced trigger; safe to call from any event. A natural trigger
   * supersedes any armed backoff retry (the retry exists only for the
   * case where NO trigger arrives). */
  schedule(): void {
    if (this.disposed) return;
    this.disarmRetry();
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
    this.disarmRetry();
    this.disarmWake();
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
      // Only a FULLY successful pass resets the failure ladder (Perkins r2
      // warning): an early successful section followed by a claim/scan
      // failure must still count toward the bounded stand-down.
      this.consecutivePassFailures = 0;
    } catch (error) {
      // A pass failure is loud and bounded: the durable queue keeps the
      // truth, a one-shot backoff retry owns recovery when no natural
      // trigger arrives, and after three consecutive failed passes the
      // consumer stands down for a natural trigger (never spins). A
      // claim left admitting by the failure is recovered by the next
      // pass's stale-claim reconciliation (or boot).
      this.consecutivePassFailures += 1;
      this.log('error', 'pipeline reconsider pass failed', {
        error: String(error),
        consecutive_failures: this.consecutivePassFailures,
      });
      if (this.consecutivePassFailures <= MAX_CONSECUTIVE_PASS_FAILURES) this.armRetry();
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
      jobDeliveredOf: (jobId) => this.opts.ledger.latestJobEvent(jobId, 'job.delivered') !== null,
      jobStartedOf: (jobId) => this.opts.ledger.jobHasWorkerStart(jobId),
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
    // Live recovery debt (Perkins r1/r2 blockers 3-4): an admitting claim
    // with no in-flight dispatch in THIS process is reconciled by every
    // pass — a transient claim-release/mark failure must not need a
    // restart, and an unadvanced recovery (both writes failing) arms the
    // bounded retry instead of stranding silently.
    let recoveryFailed = false;
    for (const entry of before) {
      if (entry.state !== 'admitting' || this.inFlightAdmissions.has(entry.id)) continue;
      if (this.reconcileClaim(entry) === 'failed') recoveryFailed = true;
    }
    if (recoveryFailed) this.armRetry();
    for (;;) {
      if (this.disposed) return;
      const entries = this.opts.ledger.listPipelineEntries();
      const ctx = this.evalContext(entries);
      const next = entries
        .filter((entry) => entry.state === 'waiting' || entry.state === 'ready')
        .sort(pipelineOrder)
        .find((entry) => pipelineBlockingReason(entry, ctx) === null);
      if (next === undefined) {
        this.disarmWake();
        return;
      }
      const capacity = this.opts.capacity();
      if (capacity.available < 1 || capacity.queued > 0) {
        // Eligible work exists but the shared budget is busy: register
        // the queue's demand with the budget itself so its demand-driven
        // idle-minion reclaim can serve approved work (D1).
        this.armWake(next.id);
        return;
      }
      this.disarmWake();
      const claimed = this.opts.ledger.claimPipelineEntry({ id: next.id, holder: ADMISSION_HOLDER });
      if (claimed === null) continue; // raced; re-read and pick the next entry
      const outcome = await this.admit(claimed);
      // A requeued attempt (or a failed finalization — Perkins r1
      // blocker 4) never retries inside the same pass: the bounded
      // backoff (or any natural trigger) spaces the next attempt
      // instead of burning every attempt on one outage.
      if (outcome === 'requeued') {
        this.armRetry();
        return;
      }
    }
  }

  private async admit(entry: PipelineEntryRecord): Promise<'admitted' | 'adopted' | 'requeued' | 'failed'> {
    this.inFlightAdmissions.add(entry.id);
    try {
      let settled: Promise<unknown>;
      try {
        const outcome = await this.opts.dispatch.dispatch({
          jobId: entry.id,
          repoPath: entry.repoPath,
          title: entry.title,
          briefing: entry.briefing,
        });
        settled = outcome.settled;
        // Observe the background settlement IMMEDIATELY (Perkins r2
        // blocker 3): dispatch returns before bookkeeping runs, and the
        // production unhandled-rejection handler exits the service — a
        // rejection must never depend on the finalization outcome.
        void settled
          .catch(() => {
            /* the job lifecycle recorded the outcome; nothing to duplicate */
          })
          .finally(() => this.schedule());
      } catch (error) {
        const detail = `admission failed: ${String(error).slice(0, 300)}`;
        const job = this.opts.ledger.getJob(entry.id);
        if (job !== null && job.briefing === entry.briefing) {
          // Dispatch committed the job row before failing; its lifecycle
          // owns the failure (blocked + note). Adopt — never re-dispatch.
          // A failed finalization is bounded recovery debt, never a
          // silent success (Perkins r1 blocker 4 / r2 blockers 2-4).
          if (!this.finalizeAdmission(entry)) return 'requeued';
          this.log('warn', 'pipeline entry adopted its pre-existing job after a dispatch failure', {
            entry: entry.id,
            error: detail,
          });
          return 'adopted';
        }
        const failures = entry.failureCount + 1;
        if (failures >= this.maxAdmissionFailures) {
          this.opts.ledger.releasePipelineClaim({ id: entry.id, reason: detail, outcome: 'failed' });
          this.notifyAdmissionFailed(entry, detail);
          return 'failed';
        }
        this.opts.ledger.releasePipelineClaim({
          id: entry.id,
          reason: detail,
          outcome: 'requeue',
          note: `attempt ${failures}/${this.maxAdmissionFailures} failed before any job existed`,
        });
        return 'requeued';
      }
      if (!this.finalizeAdmission(entry)) return 'requeued';
      return 'admitted';
    } finally {
      this.inFlightAdmissions.delete(entry.id);
    }
  }

  /** One-shot bounded backoff arming (D3/D4): fires a single reconsider
   * pass after `retryBackoffMs` unless a natural trigger (enqueue, bus or
   * capacity event) arrives first — any of those clears the timer. Never
   * periodic: recovery, not polling. */
  private armRetry(): void {
    if (this.disposed || this.retryTimer !== null) return;
    if (this.consecutiveFinalizeFailures > MAX_CONSECUTIVE_FINALIZE_FAILURES) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.schedule();
    }, this.retryBackoffMs);
  }

  private disarmRetry(): void {
    if (this.retryTimer === null) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Register the queue's demand with the shared resident budget (D1):
   * ONE queued acquire stays open while eligible work is capacity-
   * blocked, so the budget's demand-driven idle-minion reclaim works for
   * approved pipeline work exactly as it does for every other admission.
   * The permit is released the instant it grants — admission re-reads the
   * budget afresh; nothing is held, bypassed or double-counted. */
  private armWake(entryId: string): void {
    if (this.disposed || this.opts.budget === undefined) return;
    if (this.wakePending || this.wakeAbort !== null) return;
    if (Date.now() < this.wakeRefusedUntil) return;
    const abort = new AbortController();
    this.wakeAbort = abort;
    this.wakePending = true;
    this.opts.budget
      .acquire(abort.signal)
      .then((release) => {
        release(); // wake-up only — the pass re-reads the budget itself
        if (this.wakeAbort === abort) {
          this.wakeAbort = null;
          this.wakePending = false;
        }
        this.schedule();
      })
      .catch((error: unknown) => {
        if (this.wakeAbort === abort) {
          this.wakeAbort = null;
          this.wakePending = false;
        }
        // An INTENTIONAL disarm (eligibility changed — e.g. the last
        // eligible entry was held) cancels its own acquire: that is not
        // capacity feedback and must never open the refusal window
        // (Perkins r1 blocker 5); nor may a stale wake.
        if (abort.signal.aborted) return;
        // The budget surfaced a real decision (reclaim exhaustion): loud,
        // never a spin — re-arming waits out the refusal window; the next
        // natural trigger can still admit the entry directly.
        this.wakeRefusedUntil = Date.now() + WAKE_REFUSAL_WINDOW_MS;
        this.log('error', 'pipeline budget wake refused — capacity stays blocked', {
          entry: entryId,
          error: String(error),
        });
      });
  }

  private disarmWake(): void {
    const abort = this.wakeAbort;
    if (abort === null) return;
    this.wakeAbort = null;
    this.wakePending = false;
    abort.abort();
  }

  /** Bookkeeping-safe admission: a ledger failure after the dispatch side
   * effect must never leave a permanently admitting claim. When a
   * committed matching job exists (dispatch succeeded or adopted), the
   * claim is KEPT as admitting recovery debt — the row holds its
   * exclusive scopes while its worker is live, and live/boot recovery
   * retries the binding (Perkins r2 blocker 2). Only a claim with NO job
   * is returned to waiting. The failure is PROPAGATED (Perkins r1
   * blocker 4): the caller ends the pass and the bounded backoff owns
   * the retry — after three consecutive finalization failures the
   * backoff stands down for a natural trigger (never a tight loop). */
  private finalizeAdmission(entry: PipelineEntryRecord): boolean {
    try {
      this.opts.ledger.markPipelineAdmitted({ id: entry.id, jobId: entry.id });
      this.consecutiveFinalizeFailures = 0;
      return true;
    } catch (error) {
      this.consecutiveFinalizeFailures += 1;
      this.log('error', 'pipeline admission bookkeeping failed — recovery owns the retry', {
        entry: entry.id,
        error: String(error),
        consecutive_failures: this.consecutiveFinalizeFailures,
      });
      let jobExists = false;
      try {
        jobExists = this.opts.ledger.getJob(entry.id) !== null;
      } catch {
        jobExists = true; // unreadable job state: hold the claim, never orphan live work
      }
      if (!jobExists) {
        try {
          this.opts.ledger.releasePipelineClaim({
            id: entry.id,
            reason: `admission bookkeeping failed: ${String(error).slice(0, 300)}`,
            outcome: 'reconciled',
            note: 'reconciled by the live pass; a retry adopts the existing job rather than duplicating it',
          });
        } catch {
          // The ledger itself is failing; the next pass's stale-claim
          // reconciliation (and boot reconciliation) own the claim.
        }
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
