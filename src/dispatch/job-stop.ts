import type { BusEvent } from '../events/bus.js';
import type { LedgerApi } from '../ledger/api.js';
import { RecordNotFound } from '../ledger/api.js';
import type { LogLevel } from '../logger.js';
import { adapterCessationEvidence, type AgentHandle } from '../runtime/types.js';
import type { ChildWorkerService } from './child-workers.js';
import type { WaveRunner } from './perkins.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/** One target's verdict. `stopped` is only ever recorded on positive
 * cessation evidence; `unproven` preserves the truth when the service
 * cannot prove the producer is gone (issue #455). A pass records `stopped`
 * only when every live target is proven AND at least one target was proven;
 * registry absence is never evidence of cessation (#562). */
export type JobStopTargetState = 'stopped' | 'unproven';

export interface JobStopAgentOutcome {
  readonly agentId: string;
  readonly role: string;
  readonly state: JobStopTargetState;
  readonly detail: string | null;
}

export interface JobStopChildOutcome {
  readonly childId: string;
  readonly state: JobStopTargetState;
  readonly detail: string | null;
}

export interface JobStopReviewOutcome {
  /** `skipped` means no review service is wired AND the ledger records no
   * live round — it is never a claim that review stopped. */
  readonly state: JobStopTargetState | 'skipped';
  readonly roundIds: readonly string[];
  readonly detail: string | null;
}

export interface JobStopOutcome {
  readonly jobId: string;
  /** `stopped` requires EVERY live target to be positively proven stopped
   * AND at least one proven target. Anything less is `unproven` with the
   * exact residue named; an empty target set is never `stopped`. */
  readonly state: JobStopTargetState;
  /** True when the job left the owner hold while this pass was awaited:
   * the physical results are still reported, but the verdict no longer
   * governs the lane and must not read as a current stop. */
  readonly superseded: boolean;
  readonly by: string;
  readonly reason: string;
  readonly agents: readonly JobStopAgentOutcome[];
  readonly children: readonly JobStopChildOutcome[];
  readonly reviews: JobStopReviewOutcome;
  readonly outstanding: readonly string[];
}

export interface JobStopDeps {
  readonly ledger: Pick<
    LedgerApi,
    | 'getJob'
    | 'listJobs'
    | 'latestJobEvent'
    | 'listJobEventsByKinds'
    | 'listAgents'
    | 'listRounds'
    | 'listChildWorkers'
    | 'listJobAdmissions'
    | 'hasUnsettledVerificationRun'
    | 'appendCustomEvent'
  >;
  /** The runtime's own live-handle view. A ledger row claiming an open
   * turn is never proof of a handle, and a handle is never proof of a
   * ledger row — both are consulted. */
  readonly handles: { readonly list: () => readonly AgentHandle[] };
  /** Tracked child workers, when the service hosts them. */
  readonly children: Pick<ChildWorkerService, 'cancel'> | null;
  /** The review service, when the service hosts it. */
  readonly reviews: Pick<WaveRunner, 'supersedeReviews'> | null;
  /** Issue #559: stop the job's scheduled verification through the
   * scheduler's per-job seam, and say whether its process group is proven
   * gone. Absent: a run this pass cannot reach stays the residue today's text
   * names, and is never reported stopped. */
  readonly cancelVerification?: (input: {
    readonly jobId: string;
    readonly by: string;
    readonly reason: string;
  }) => Promise<{ readonly state: 'stopped' | 'unproven'; readonly detail?: string | null }>;
  /** Called once for every unproven pass, including boot re-proofs. */
  readonly notifyUnproven?: (outcome: JobStopOutcome) => void;
  /** Called when a later pass proves the stop (or the owner resumed):
   * the producer-side incident is settled, never left ringing. */
  readonly notifyResolved?: (jobId: string) => void;
  readonly log: Log;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The residue an owner must inspect when a stop is not proven. Pure and
 * exported so the owner-facing notice and the durable event cannot drift. */
export function jobStopResidue(outcome: JobStopOutcome): readonly string[] {
  return [
    ...outcome.agents
      .filter((agent) => agent.state === 'unproven')
      .map((agent) => `${agent.agentId}: ${agent.detail ?? 'unproven'}`),
    ...outcome.children
      .filter((child) => child.state === 'unproven')
      .map((child) => `${child.childId}: ${child.detail ?? 'unproven'}`),
    ...(outcome.reviews.state === 'unproven' ? [`review: ${outcome.reviews.detail ?? 'unproven'}`] : []),
    ...outcome.outstanding,
  ];
}

/** The owner-facing notice for an unproven stop. Pure and exported so the
 * incident title/detail can be asserted, and so the residue text an owner
 * reads is the same text the durable event records. */
export function jobStopUnprovenNotice(outcome: JobStopOutcome): { readonly title: string; readonly detail: string } {
  return {
    title: `Parked job ${outcome.jobId}: producer stop is unproven`,
    detail:
      `The explicit owner hold is recorded, but the service cannot prove every producer stopped: ${jobStopResidue(outcome).join('; ')}. ` +
      'The job stays parked and new verifications, child workers and initial dispatches are refused until the residue settles. ' +
      'Where nothing is running for the lane, resuming or closing the job lifts the hold; this notice settles on the next stop reconcile at boot.',
  };
}

/**
 * Physical producer stop for an explicit owner hold (issue #455).
 *
 * Parking records an administrative hold; this service answers the
 * SEPARATE question a hold cannot: is a live producer actually gone?
 * It disposes every runtime handle bound to the job (regardless of what
 * the durable agent row currently says), cancels tracked child workers,
 * supersedes live reviews, and then reports each target's own evidence.
 * A disposal that returned, a client that exited, or a job row that reads
 * parked are never treated as cessation.
 *
 * The durable `job.execution-stop` event is written twice: `requested`
 * before any effect (so a crash mid-stop leaves honest intent), then the
 * final verdict. A caller may retry; only an in-flight pass is joined.
 *
 * A `stopped` verdict needs every live target proven AND at least one
 * proven target: an empty registry (nothing spawned, nothing left after a
 * restart, everything already disposed) is not evidence of cessation, and
 * a vacuous review confirmation proves nothing (#562).
 */
export class JobExecutionStop {
  private readonly inFlight = new Map<string, Promise<JobStopOutcome>>();

  constructor(private readonly deps: JobStopDeps) {}

  stop(input: { readonly jobId: string; readonly by: string; readonly reason: string }): Promise<JobStopOutcome> {
    const running = this.inFlight.get(input.jobId);
    if (running !== undefined) return running;
    const pass = this.run(input).finally(() => {
      if (this.inFlight.get(input.jobId) === pass) this.inFlight.delete(input.jobId);
    });
    this.inFlight.set(input.jobId, pass);
    return pass;
  }

  /** Await every pass started so far (shutdown join). */
  async settled(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()]);
    }
  }

  /** Re-prove stops a restart interrupted (`requested`) or could not prove
   * (`unproven`) for lanes that are still parked, and settle an open
   * producer incident for a lane the owner resumed. Returns the pass count. */
  async reconcileOnBoot(): Promise<number> {
    let passes = 0;
    for (const job of this.deps.ledger.listJobs()) {
      const latest = this.deps.ledger.latestJobEvent(job.id, 'job.execution-stop');
      const hasEvent = latest !== null;
      const state = (latest?.payload as { readonly state?: unknown } | null)?.state;
      if (hasEvent && state !== 'requested' && state !== 'unproven') continue;
      if (job.status !== 'parked') {
        // The hold was lifted (or the job moved on): no stop pass will run
        // again, so the open owner incident is settled here. Without any
        // stop event there is nothing to settle — and no write, so boot
        // does not open a transaction for every historical lane.
        if (hasEvent) this.deps.notifyResolved?.(job.id);
        continue;
      }
      passes += 1;
      try {
        await this.stop({
          jobId: job.id,
          by: 'service:boot',
          reason: 're-proving an interrupted or unproven producer stop for a parked lane',
        });
      } catch (error) {
        this.deps.log('error', 'job execution stop boot re-proof failed', {
          job: job.id,
          error: describe(error),
        });
      }
    }
    return passes;
  }

  private async run(input: {
    readonly jobId: string;
    readonly by: string;
    readonly reason: string;
  }): Promise<JobStopOutcome> {
    const { ledger, log } = this.deps;
    const job = ledger.getJob(input.jobId);
    if (job === null) throw new RecordNotFound(`job "${input.jobId}" not found`);

    // Captured before this pass writes its own intent: a lane with no
    // `job.execution-stop` history at all was parked before stop events
    // existed, so an empty registry says nothing about its producers.
    const priorStopEvent = ledger.latestJobEvent(input.jobId, 'job.execution-stop');
    const legacy = priorStopEvent === null;
    const requested = ledger.appendCustomEvent({
      kind: 'job.execution-stop',
      jobId: input.jobId,
      payload: { state: 'requested', by: input.by, reason: input.reason, job_status: job.status },
    });

    const jobAgents = ledger.listAgents().filter((agent) => agent.jobId === input.jobId);
    const openChildren = ledger.listChildWorkers({ jobId: input.jobId }).filter((child) => child.resultState === null);
    // A tracked child's own agent row is answered by the child cancellation
    // target below; reporting it twice would make a proven stop look unproven.
    const childAgentIds = new Set(openChildren.flatMap((child) => (child.agentId === null ? [] : [child.agentId])));
    const agentById = new Map(jobAgents.map((agent) => [agent.id, agent]));
    const agents: JobStopAgentOutcome[] = [];
    const covered = new Set<string>();
    // A live handle is a producer even when its agent row reads idle/error:
    // the row is a projection, the runtime handle is the process.
    for (const handle of this.deps.handles.list()) {
      const agent = agentById.get(handle.id);
      if (agent === undefined) continue;
      covered.add(agent.id);
      try {
        await handle.dispose();
      } catch (error) {
        agents.push({
          agentId: agent.id,
          role: handle.role,
          state: 'unproven',
          detail: `dispose failed: ${describe(error)}`,
        });
        continue;
      }
      const evidence = adapterCessationEvidence(handle);
      agents.push({
        agentId: agent.id,
        role: handle.role,
        state: evidence === 'ceased' ? 'stopped' : 'unproven',
        detail:
          evidence === 'ceased'
            ? null
            : 'disposal returned without the adapter observing cessation of every owned run and child',
      });
    }
    // The other direction: the ledger claims an open turn the runtime no
    // longer holds. That is not a proven stop either.
    for (const agent of jobAgents) {
      if (covered.has(agent.id)) continue;
      if (childAgentIds.has(agent.id)) continue;
      if (agent.state !== 'spawning' && agent.state !== 'streaming') continue;
      agents.push({
        agentId: agent.id,
        role: agent.role,
        state: 'unproven',
        detail: `ledger records an open ${agent.state} turn but the runtime holds no handle — cessation is unproven (not a claim of stop)`,
      });
    }

    const children: JobStopChildOutcome[] = [];
    if (openChildren.length > 0 && this.deps.children === null) {
      for (const child of openChildren) {
        children.push({
          childId: child.id,
          state: 'unproven',
          detail: 'a non-terminal child worker exists but this service hosts no child-worker cancellation',
        });
      }
    } else if (this.deps.children !== null) {
      for (const child of openChildren) {
        try {
          const record = await this.deps.children.cancel(child.id, `${input.reason} (owner hold)`);
          children.push({
            childId: child.id,
            state: record.resultState === null ? 'unproven' : 'stopped',
            detail: record.resultState === null ? 'cancellation did not reach a terminal result' : null,
          });
        } catch (error) {
          children.push({ childId: child.id, state: 'unproven', detail: `cancel failed: ${describe(error)}` });
        }
      }
    }

    let reviews: JobStopReviewOutcome;
    if (this.deps.reviews !== null) {
      try {
        const outcome = await this.deps.reviews.supersedeReviews({
          jobId: input.jobId,
          reason: input.reason,
          by: input.by,
        });
        reviews = {
          state: outcome.confirmed ? 'stopped' : 'unproven',
          roundIds: outcome.roundIds,
          detail: outcome.detail,
        };
      } catch (error) {
        reviews = { state: 'unproven', roundIds: [], detail: `review supersession failed: ${describe(error)}` };
      }
    } else {
      // No review service here: only a ledger with no live round makes
      // `skipped` honest.
      const liveRounds = ledger
        .listRounds(input.jobId)
        .filter((round) => round.status === 'pending' || round.status === 'live');
      reviews = liveRounds.length > 0
        ? {
            state: 'unproven',
            roundIds: liveRounds.map((round) => round.id),
            detail: 'live review round(s) are recorded but this service hosts no review stop',
          }
        : { state: 'skipped', roundIds: [], detail: 'no review service is wired and no live round is recorded' };
    }

    // Review evidence proves a stop only when it proves something: a
    // genuine round supersession (already proven terminal by
    // `supersedeReviews`) or the job-level receipt for a fallback gate
    // written after the current hold began. `fence` is therefore the CURRENT
    // HOLD's start — the later of the `job.status` park that opened the hold
    // and the lane's prior stop event — so a receipt written after that park
    // proves review cessation for THIS hold, including one an interrupted
    // pass of this same hold wrote before it died (the boot re-proof honours
    // it: the hold did not change, so neither does the fence). A receipt
    // written before the hold (the writer gate, an accepted material
    // amendment) proves nothing about it and can never prove a stop it has
    // nothing to do with. Only a lane with no park event at all — legacy —
    // falls back to this pass's own `requested` write, the only fence such a
    // lane has. The vacuous `confirmed: true` a lane with no review
    // operation gets back is evidence of nothing, so it can neither prove a
    // stop nor count as a target.
    const parkedAt = ledger
      .listJobEventsByKinds(input.jobId, ['job.status']) // newest first, so `.find` is the latest park
      .find((event) => (event.payload as { readonly to?: unknown } | null)?.to === 'parked');
    const fence = parkedAt !== undefined
      ? Math.max(priorStopEvent?.seq ?? 0, parkedAt.seq)
      : (priorStopEvent?.seq ?? requested.seq);
    const reviewProven =
      reviews.state === 'stopped' &&
      (reviews.roundIds.length > 0 ||
        (ledger.latestJobEvent(input.jobId, 'job.review-supersession-confirmed')?.seq ?? 0) > fence);

    // A verification the job holds is the job's producer too (issue #559):
    // stop it, then re-read the predicate — a cancel whose process group is
    // proven gone settles the run, and only that proof drops the residue.
    // An unproven cancel (a live group, a holder this process cannot signal)
    // stays residue with the scheduler's own reason.
    const outstanding: string[] = [];
    let unsettledVerification = ledger.hasUnsettledVerificationRun(input.jobId);
    if (unsettledVerification && this.deps.cancelVerification !== undefined) {
      let verdict: { readonly state: 'stopped' | 'unproven'; readonly detail?: string | null };
      try {
        verdict = await this.deps.cancelVerification({ jobId: input.jobId, by: input.by, reason: input.reason });
      } catch (error) {
        verdict = { state: 'unproven', detail: `the verification cancel failed: ${describe(error)}` };
      }
      unsettledVerification = ledger.hasUnsettledVerificationRun(input.jobId);
      if (verdict.state === 'unproven') {
        outstanding.push(verdict.detail ?? 'a scheduled verification is still unproven');
      } else if (unsettledVerification) {
        outstanding.push(
          'a scheduled verification was cancelled, but its run is still recorded as unsettled — it may still run',
        );
      }
    } else if (unsettledVerification) {
      outstanding.push(
        'an unsettled verification run remains — it may finish; this service hosts no per-job verification stop',
      );
    }
    // A proven-gone cancel IS a proven stop target — the run was a live
    // producer — and the proof is the LEDGER row, never this pass's verdict:
    // the pass that cancels writes `verification.cancelled` and a later pass
    // (the boot re-proof) reads it back, so the lane is not left concluding
    // that absence proves nothing. Like `reviewProven`, only a row written
    // after the hold's fence proves THIS hold, and a `process_group_gone:
    // false` row is an unproven cancel: neither a target nor a residue.
    const verificationProven = !unsettledVerification &&
      ledger
        .listJobEventsByKinds(input.jobId, ['verification.cancelled'])
        .some((event) =>
          (event.payload as { readonly process_group_gone?: unknown } | null)?.process_group_gone === true &&
          event.seq > fence);
    const provenTargets =
      agents.filter((agent) => agent.state === 'stopped').length +
      children.filter((child) => child.state === 'stopped').length +
      (reviewProven ? 1 : 0) +
      (verificationProven ? 1 : 0);
    const admissions = ledger.listJobAdmissions(input.jobId);
    if (admissions.length > 0) {
      outstanding.push(`in-flight producer admission(s) remain: ${admissions.join(', ')}`);
    }

    // A vacuous review `stopped` (no rounds, no job-level receipt) is "no
    // review target": it is neither proof nor residue. A failed/unknown
    // review stays residue.
    const noResidue =
      agents.every((agent) => agent.state === 'stopped') &&
      children.every((child) => child.state === 'stopped') &&
      reviews.state !== 'unproven' &&
      outstanding.length === 0;
    // With no proven target, the residue channel carries the reason to the
    // owner notice and `jobStopResidue()`: the pass cannot settle on absence.
    if (noResidue && provenTargets === 0) {
      outstanding.push(
        legacy
          ? 'parked before stop events existed; registry absence is not evidence'
          : 'no stop target exists — registry absence is not evidence of cessation',
      );
    }
    const state: JobStopTargetState = noResidue && provenTargets > 0 ? 'stopped' : 'unproven';
    const current = ledger.getJob(input.jobId);
    const superseded = current === null || current.status !== 'parked';

    const outcome: JobStopOutcome = {
      jobId: input.jobId,
      state,
      superseded,
      by: input.by,
      reason: input.reason,
      agents,
      children,
      reviews,
      outstanding,
    };
    ledger.appendCustomEvent({
      kind: 'job.execution-stop',
      jobId: input.jobId,
      payload: {
        state: superseded ? 'superseded' : state,
        physical_state: state,
        superseded,
        job_status: current?.status ?? null,
        by: input.by,
        reason: input.reason,
        agents: outcome.agents,
        children: outcome.children,
        reviews: outcome.reviews,
        outstanding: outcome.outstanding,
      },
    });
    log(superseded || state === 'stopped' ? 'info' : 'warn', `job execution stop ${superseded ? 'superseded' : state}`, {
      job: input.jobId,
      agents: outcome.agents.length,
      children: outcome.children.length,
      reviews: outcome.reviews.state,
      outstanding: outcome.outstanding.length,
    });
    if (!superseded && state === 'unproven') this.deps.notifyUnproven?.(outcome);
    else this.deps.notifyResolved?.(input.jobId);
    return outcome;
  }
}

export interface JobStopWatcherDeps {
  readonly bus: { subscribe(listener: (event: BusEvent) => void): () => void };
  readonly stop: Pick<JobExecutionStop, 'stop'>;
  readonly notifyFailed: (jobId: string, error: unknown) => void;
  readonly log: Log;
}

/** Watch the durable park transition and run the physical stop. Kept as a
 * small seam so the wiring itself (not just the stop pass) is testable. */
export function watchParkedJobs(deps: JobStopWatcherDeps): () => void {
  return deps.bus.subscribe((event) => {
    if (event.kind !== 'job.status') return;
    const jobId = event.jobId;
    if (jobId === null) return;
    const to = (event.payload as { readonly to?: unknown } | null)?.to;
    if (to !== 'parked') return;
    void deps.stop
      .stop({
        jobId,
        by: 'service:park',
        reason: 'job parked — the explicit owner hold stops live producers',
      })
      .catch((error: unknown) => {
        deps.log('error', 'job parked: producer stop failed', { job: jobId, error: describe(error) });
        try {
          deps.notifyFailed(jobId, error);
        } catch (notifyError) {
          deps.log('error', 'job parked: stop-failure notice failed', {
            job: jobId,
            error: describe(notifyError),
          });
        }
      });
  });
}
