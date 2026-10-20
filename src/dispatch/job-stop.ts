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
 * cannot prove the producer is gone (issue #455). */
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
  /** `stopped` requires EVERY live target to be positively proven stopped.
   * Anything less is `unproven` with the exact residue named. */
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
      const state = (latest?.payload as { readonly state?: unknown } | null)?.state;
      if (state !== 'requested' && state !== 'unproven') continue;
      if (job.status !== 'parked') {
        // The hold was lifted (or the job moved on): no stop pass will run
        // again, so the open owner incident is settled here.
        this.deps.notifyResolved?.(job.id);
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

    ledger.appendCustomEvent({
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

    // A pre-existing verification cannot be interrupted through the
    // scheduler's per-job surface; an in-flight admission is pre-spawn
    // work this pass does not own. Both are named, never hidden behind a
    // `stopped` verdict.
    const outstanding: string[] = [];
    if (ledger.hasUnsettledVerificationRun(input.jobId)) {
      outstanding.push('an unsettled verification run remains — it may finish; no per-job scheduler stop exists');
    }
    const admissions = ledger.listJobAdmissions(input.jobId);
    if (admissions.length > 0) {
      outstanding.push(`in-flight producer admission(s) remain: ${admissions.join(', ')}`);
    }

    const state: JobStopTargetState =
      agents.every((agent) => agent.state === 'stopped') &&
      children.every((child) => child.state === 'stopped') &&
      (reviews.state === 'stopped' || reviews.state === 'skipped') &&
      outstanding.length === 0
        ? 'stopped'
        : 'unproven';
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
