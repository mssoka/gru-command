import type { LedgerApi } from '../ledger/api.js';
import { RecordNotFound } from '../ledger/api.js';
import type { LogLevel } from '../logger.js';
import type { AgentHandle } from '../runtime/types.js';
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
  /** `skipped` means no review service is wired here — it is never a
   * claim that review stopped. */
  readonly state: JobStopTargetState | 'skipped';
  readonly roundIds: readonly string[];
  readonly detail: string | null;
}

export interface JobStopOutcome {
  readonly jobId: string;
  /** `stopped` requires EVERY live target to be positively proven stopped.
   * Anything less is `unproven` with the exact residue named. */
  readonly state: JobStopTargetState;
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
    | 'listAgents'
    | 'listChildWorkers'
    | 'listJobAdmissions'
    | 'hasUnsettledVerificationRun'
    | 'appendCustomEvent'
  >;
  /** The runtime's own live-handle view. A ledger row claiming an open
   * turn is never proof of a handle, and a handle is never proof of a
   * ledger row — both are consulted. */
  readonly handles: { readonly get: (agentId: string) => AgentHandle | null };
  /** Tracked child workers, when the service hosts them. */
  readonly children: Pick<ChildWorkerService, 'cancel'> | null;
  /** The review service, when the service hosts it. */
  readonly reviews: Pick<WaveRunner, 'supersedeReviews'> | null;
  readonly log: Log;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Physical producer stop for an explicit owner hold (issue #455).
 *
 * Parking records an administrative hold; this service answers the
 * SEPARATE question a hold cannot: is a live producer actually gone?
 * It disposes every runtime handle bound to the job, cancels tracked
 * child workers, supersedes live reviews, and then reports each target's
 * own evidence. A disposal that returned, a client that exited, or a job
 * row that reads parked are never treated as cessation.
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

  private async run(input: {
    readonly jobId: string;
    readonly by: string;
    readonly reason: string;
  }): Promise<JobStopOutcome> {
    const { ledger } = this.deps;
    const job = ledger.getJob(input.jobId);
    if (job === null) throw new RecordNotFound(`job "${input.jobId}" not found`);

    ledger.appendCustomEvent({
      kind: 'job.execution-stop',
      jobId: input.jobId,
      payload: { state: 'requested', by: input.by, reason: input.reason, job_status: job.status },
    });

    const agents: JobStopAgentOutcome[] = [];
    for (const agent of ledger.listAgents()) {
      if (agent.jobId !== input.jobId) continue;
      if (agent.state !== 'spawning' && agent.state !== 'streaming') continue;
      const handle = this.deps.handles.get(agent.id);
      if (handle === null) {
        agents.push({
          agentId: agent.id,
          role: agent.role,
          state: 'unproven',
          detail: `ledger records an open ${agent.state} turn but the runtime holds no handle — cessation is unproven (not a claim of stop)`,
        });
        continue;
      }
      try {
        await handle.dispose();
        const evidence = handle.cessationEvidence?.() ?? 'unknown';
        agents.push({
          agentId: agent.id,
          role: agent.role,
          state: evidence === 'ceased' ? 'stopped' : 'unproven',
          detail:
            evidence === 'ceased'
              ? null
              : 'disposal returned without the adapter observing cessation of every owned run and child',
        });
      } catch (error) {
        agents.push({
          agentId: agent.id,
          role: agent.role,
          state: 'unproven',
          detail: `dispose failed: ${describe(error)}`,
        });
      }
    }

    const children: JobStopChildOutcome[] = [];
    const openChildren = ledger.listChildWorkers({ jobId: input.jobId }).filter((child) => child.resultState === null);
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
    if (this.deps.reviews === null) {
      reviews = { state: 'skipped', roundIds: [], detail: 'no review service is wired on this host' };
    } else {
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

    const outcome: JobStopOutcome = {
      jobId: input.jobId,
      state,
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
        state,
        by: input.by,
        reason: input.reason,
        agents: outcome.agents,
        children: outcome.children,
        reviews: outcome.reviews,
        outstanding: outcome.outstanding,
      },
    });
    this.deps.log(state === 'stopped' ? 'info' : 'warn', `job execution stop ${state}`, {
      job: input.jobId,
      agents: outcome.agents.length,
      children: outcome.children.length,
      reviews: outcome.reviews.state,
      outstanding: outcome.outstanding.length,
    });
    return outcome;
  }
}
