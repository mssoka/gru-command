import type { LogLevel } from '../logger.js';
import type { LedgerApi, JobRecord } from '../ledger/api.js';
import type { CompletionHandoffIntent } from '../ledger/obligations.js';
import { isJobTerminal } from '../ledger/states.js';
import type { Role } from '../config.js';
import type { AgentHandle, SpawnOptions } from '../runtime/types.js';
import { requireSpawnCwd } from '../roles.js';
import { renderLessonsSection } from '../lessons/references.js';
import type { LessonPointer, LessonsReferencePort } from '../lessons/types.js';
import type { LessonCapturePort } from '../lessons/capture.js';
import type { WorktreeLane, WorktreePort, WorktreeSweepResult } from './worktree-port.js';
import { recordFollowUpDelivery } from './fix-directive.js';
import { promptVerdictFromHealth, promptWithTerminalVerdict } from '../runtime/prompt-verdict.js';
import type { PromptTurnVerdict } from '../runtime/types.js';
import { settleRetries, RetrySettlementUnavailableError, type PacingGate, type PacingLease, type RetrySettlement } from '../runtime/pacing.js';
import { PR_CREATION_RULE } from './pr-creation.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Dispatch flow (EPICS E8 story 2; SPEC rulings 2/17/18): the Gru-authored
 * briefing becomes a job, ops (the Silas role's mechanical hand) hands it
 * to a minion on a FRESH WORKTREE per job, the minion runs rooted in the
 * project (cwd = the worktree — ruling 17), and the lifecycle lands on the
 * board via the ledger. The PR link and review loop follow.
 */

/** The spawn surface the dispatcher needs (RuntimeRegistry.spawn in
 * production; a plain function so lambdas and bound methods both fit). */
export type AgentSpawner = (
  role: Role,
  options?: SpawnOptions,
) => Promise<AgentHandle>;

export interface DispatchOutcome {
  readonly job: JobRecord;
  readonly worktree: WorktreeLane;
  readonly agentId: string;
  /** Resolves when the minion's briefing turn settles (ok | error). */
  readonly settled: Promise<{ readonly ok: boolean; readonly error?: string }>;
}

export interface DispatchServiceOptions {
  readonly ledger: LedgerApi;
  /** The worktree subsystem (ruling 18) — a port since the Perkins r4
   * split: the manager implementation is its own lane. */
  readonly worktrees: WorktreePort;
  readonly spawner: AgentSpawner;
  /** Provider pacing: FIFO worker (minion turn) admission gate. Absent =
   * off; an unlimited or disabled gate admits immediately. */
  readonly workerGate?: PacingGate;
  /** Provider pacing: the bounded settlement of an automatic rate-limit
   * retry covering a just-delivered worker turn (supervisor-backed in
   * production). The delivery records success only for 'none'/'recovered'
   * and releases its worker lease before waiting so the retry can
   * reacquire admission. Absent = no interlock. */
  readonly retrySettlement?: (agentId: string) => Promise<RetrySettlement>;
  /** Service-stopping signal: aborts a QUEUED admission wait and lets the
   * settlement wait below observe shutdown instead of hanging. Absent =
   * settlement is hook-owned and the queue wait is uncancellable. */
  readonly stopSignal?: AbortSignal;
  /** Book of Lessons injection: pointer lines only, never chapter bodies. */
  readonly lessons?: LessonsReferencePort;
  /** Extracts a minion's opt-in lessons block at delivery settle. */
  readonly lessonsCapture?: LessonCapturePort;
  readonly log?: Log;
}

/** Render the prompt handed to a dispatched minion (contract-shaped). */
export function renderMinionBriefing(input: {
  jobId: string;
  repoName: string;
  branch: string;
  worktreePath: string;
  sha: string;
  briefing: string;
  /** Progressive-disclosure reference lines (no chapter bodies). */
  lessons?: readonly LessonPointer[];
}): string {
  const lessonsSection = renderLessonsSection(input.lessons ?? []);
  return [
    `Dispatch briefing — job ${input.jobId}`,
    `Repo: ${input.repoName}`,
    `Branch: ${input.branch} (worktree: ${input.worktreePath})`,
    `Base head at dispatch: ${input.sha}`,
    '',
    'BRIEFING:',
    input.briefing,
    ...(lessonsSection === '' ? [] : ['', lessonsSection]),
    '',
    PR_CREATION_RULE,
    '',
    'Execute the briefing inside this worktree. Standing orders: work only',
    'inside this tree; commit your work to the branch; verify it (build,',
    'tests, lint — whatever this project calls green) before finishing;',
    'never merge your own pull request. End with a completion report.',
  ].join('\n');
}

export class DispatchService {
  private readonly opts: DispatchServiceOptions;
  private readonly log: Log;

  constructor(opts: DispatchServiceOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  /**
   * Gru authors the briefing; this is the ops handoff. Steps are ordered
   * and loud: job row → worktree (fresh head, own branch) → minion spawn
   * rooted in the worktree → briefing prompt. A failure at any step
   * blocks the job (with note) instead of leaking half a lane; a spawn
   * failure also sweeps the fresh worktree back out.
   */
  async dispatch(input: {
    jobId: string;
    repoPath: string;
    title: string;
    briefing: string;
    /** Explicit completion intent: when present, the phase-handoff guard
     * row is persisted BEFORE any side effect and this exact phase's
     * validated completion owes the named decision durably. Omitted =
     * ordinary Silas completion. */
    completionHandoff?: CompletionHandoffIntent;
  }): Promise<DispatchOutcome> {
    if (input.jobId.trim() === '' || input.title.trim() === '' || input.briefing.trim() === '') {
      throw new Error('dispatch requires a non-empty job id, title, and briefing');
    }
    const repoName = input.repoPath.split('/').filter(Boolean).pop() ?? input.repoPath;

    // (1) The job row: the briefing IS the contract (recorded verbatim).
    const job = this.opts.ledger.addJob({
      id: input.jobId,
      repo: repoName,
      title: input.title,
      briefing: input.briefing,
    });

    // (2) Ops handoff: dispatched → working, on the record.
    this.opts.ledger.appendCustomEvent({
      kind: 'job.handoff',
      jobId: job.id,
      payload: { repo: repoName, repoPath: input.repoPath },
    });

    let handoffPhaseId: string | null = null;
    // Tracks whether THIS run committed the terminal delivery event: a
    // later bookkeeping failure must not close a phase whose completion
    // evidence already exists (the boot reconciler finishes it instead).
    let deliveredRecorded = false;
    let workerLease: PacingLease | null = null;
    const releaseWorker = (): void => {
      const lease = workerLease;
      workerLease = null;
      lease?.release();
    };
    try {
      const working = this.opts.ledger.setJobStatus(job.id, 'working');

      // (2b) Explicit completion intent BEFORE admission/side effects: the
      // durable guard row exists before any worktree or spawn, so a crash
      // mid-dispatch is provably not a completion and the intent survives.
      if (input.completionHandoff !== undefined) {
        handoffPhaseId = this.opts.ledger.beginPhaseHandoff({
          jobId: job.id,
          source: 'dispatch',
          intent: input.completionHandoff,
        }).record.phaseId;
      }

      // (3) One worktree per job, fresh head, own branch (ruling 18).
      const worktree = await this.opts.worktrees.createJobWorktree({
        repoPath: input.repoPath,
        jobId: job.id,
      });

      // (4) The minion: a fresh agent session rooted in the PROJECT
      // worktree (ruling 17: dispatch cwd = project root, all runtimes).
      // Provider pacing: the minion turn waits FIFO for a worker slot when
      // at the configured cap — the lane lands queued on the board with the
      // honest reason and is admitted in order (never rejected, never
      // preempted). Unlimited default admits immediately: zero change.
      if (this.opts.workerGate !== undefined) {
        let queuedReason: string | null = null;
        const lease = await this.opts.workerGate.acquireWorkerTurn({
          id: job.id,
          label: input.title,
          jobId: job.id,
          ...(this.opts.stopSignal !== undefined ? { signal: this.opts.stopSignal } : {}),
          queued: (info) => {
            queuedReason = info.reason;
            this.opts.ledger.noteJob(job.id, info.reason);
          },
        });
        workerLease = lease;
        if (queuedReason !== null) {
          // The lane waited at the cap and is now admitted: replace the queue
          // note so the durable note never keeps claiming a running lane is
          // still queued (the live gate view carries the queue truth).
          this.opts.ledger.noteJob(
            job.id,
            `pacing: admitted after ${lease.waitedMs} ms queue wait`,
          );
        }
      }
      let handle: AgentHandle;
      try {
        const cwd = requireSpawnCwd('minion', worktree.path);
        handle = await this.opts.spawner('minion', { cwd });
      } catch (error) {
        // The lane cannot start — release the pacing slot, sweep the fresh
        // worktree (preserve first, per ruling 18c) and block the job.
        releaseWorker();
        await this.sweepQuietly(worktree.id);
        throw error;
      }
      // Register the minion lane binding OURSELVES (idempotent): the
      // board engine's spawn-envelope registration is an observer, never
      // a precondition — dispatch must not depend on listener ordering.
      this.opts.ledger.registerAgent({
        id: handle.id,
        role: 'minion',
        sessionFile: handle.sessionFile,
        jobId: job.id,
      });
      // Bind the admitted worker to the marked phase BEFORE its prompt runs:
      // a delivery from any other worker can never complete this phase.
      if (handoffPhaseId !== null) {
        this.opts.ledger.bindPhaseHandoffMinion({ phaseId: handoffPhaseId, minionId: handle.id });
      }
      this.opts.ledger.appendCustomEvent({
        kind: 'job.minion-spawned',
        jobId: job.id,
        payload: { agentId: handle.id, worktree: worktree.path, branch: worktree.branch },
      });
      this.log('info', 'minion dispatched', {
        job: job.id,
        agent: handle.id,
        worktree: worktree.path,
      });

      // (5) Deliver the briefing. The turn runs in the background; the
      // board shows the arc through ledger events, not this await. A
      // rate-limited turn stays pending until its bounded automatic retry
      // path concludes — never recorded as delivered while a retry could
      // still carry it, never disposed out from under that retry.
      const lessons = this.opts.lessons?.referencesFor(`${input.title}\n${input.briefing}`) ?? [];
      const settleTurn = async (
        failure: unknown | null,
        verdict: PromptTurnVerdict | null,
      ): Promise<{ readonly ok: boolean; readonly error?: string }> => {
        // Release the slot first: the retry reacquires admission per attempt.
        releaseWorker();
        const settlement = await settleRetries(this.opts.retrySettlement, handle.id, this.opts.stopSignal).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        if (!settlement.ok) {
          if (!(settlement.error instanceof RetrySettlementUnavailableError)) throw settlement.error;
          // A settlement-system fault is not a rate-limit narrative: block
          // the lane loudly with the internal error instead of narrating a
          // retry that never ran.
          const detail = String(settlement.error);
          this.opts.ledger.appendCustomEvent({
            kind: 'job.minion-error',
            jobId: job.id,
            payload: { agentId: handle.id, error: detail },
          });
          this.recordSettleOutcome(job.id, 'blocked');
          this.opts.ledger.noteJob(job.id, `pacing settlement unavailable — internal error: ${detail.slice(0, 200)}`);
          this.log('error', 'briefing turn settlement unavailable', {
            job: job.id,
            agent: handle.id,
            error: detail,
          });
          // A failed attempt never masquerades as a completed marked phase:
          // no delivery was recorded, so the guard row closes with reason.
          this.closeHandoffQuietly(
            handoffPhaseId,
            `dispatch turn failed: pacing settlement unavailable — internal error: ${detail.slice(0, 200)}`,
          );
          return { ok: false as const, error: detail };
        }
        const disposition = settlement.value;
        if (disposition === 'cancelled') {
          // Service stopping: the turn's outcome is unknown. Never report it
          // delivered, and leave a named note instead of claiming the lane is
          // still queued.
          const detail = 'dispatch stopped before the automatic retries settled';
          this.opts.ledger.appendCustomEvent({
            kind: 'job.minion-error',
            jobId: job.id,
            payload: { agentId: handle.id, error: detail },
          });
          this.recordSettleOutcome(job.id, 'blocked');
          this.opts.ledger.noteJob(job.id, `pacing: ${detail}`);
          this.log('warn', 'briefing turn settlement cancelled by shutdown', {
            job: job.id,
            agent: handle.id,
          });
          // The turn recorded no delivery, so the marked phase cannot have
          // completed: close the guard row instead of leaving a stale intent.
          this.closeHandoffQuietly(handoffPhaseId, 'dispatch turn failed: service stopped before the automatic retries settled');
          return { ok: false as const, error: detail };
        }
        const retryFailed = disposition === 'exhausted' || disposition === 'superseded';
        if (failure !== null && disposition !== 'recovered') {
          const error = String(failure);
          this.opts.ledger.appendCustomEvent({
            kind: 'job.minion-error',
            jobId: job.id,
            payload: { agentId: handle.id, error },
          });
          this.recordSettleOutcome(job.id, 'blocked');
          this.log('error', 'minion briefing turn failed', {
            job: job.id,
            agent: handle.id,
            error,
          });
          if (!deliveredRecorded) {
            this.closeHandoffQuietly(handoffPhaseId, `dispatch turn failed: ${error}`);
          }
          return { ok: false as const, error };
        }
        if (retryFailed) {
          const error = `automatic rate-limit retry ${disposition} — the briefing turn did not deliver`;
          this.opts.ledger.appendCustomEvent({
            kind: 'job.minion-error',
            jobId: job.id,
            payload: { agentId: handle.id, error },
          });
          this.recordSettleOutcome(job.id, 'blocked');
          this.log('error', 'minion briefing turn did not survive its automatic retries', {
            job: job.id,
            agent: handle.id,
            disposition,
          });
          this.closeHandoffQuietly(handoffPhaseId, `dispatch turn failed: ${error}`);
          return { ok: false as const, error };
        }
        // Terminal/error correlation (r4 blocker 1): a resolved prompt is
        // not success — both adapters settle fulfilled prompts that ended in
        // an in-band error (Claude result.isError; Pi stopReason 'error').
        // Terminal/error correlation (r4/r5 blocker 1): the verdict was
        // captured by the transport when THIS prompt settled — before any
        // queued successor turn could start — and is held across the retry
        // settlement above. A failed turn never records a phase-tagged
        // delivery and never publishes a completed phase; a retry-recovered
        // disposition is the retry's own clean turn (the supervisor
        // supersedes itself on any further in-band error).
        const evidence =
          disposition === 'recovered'
            ? ({ ok: true, error: null } as const)
            : (verdict ?? promptVerdictFromHealth(handle));
        if (!evidence.ok) {
          return this.recordTurnFailure(
            job.id,
            handle.id,
            handoffPhaseId,
            deliveredRecorded,
            evidence.error ?? 'runtime settled the briefing turn with an in-band error',
          );
        }
        const delivery = recordFollowUpDelivery({ ledger: this.opts.ledger,
          worktrees: this.opts.worktrees, jobId: job.id, agentId: handle.id, source: 'dispatch',
          ...(handoffPhaseId !== null ? { phaseId: handoffPhaseId } : {}) });
        deliveredRecorded = true;
        if (delivery.note !== null) this.log('warn', 'initial delivery has no resolvable lane head', {
          job: job.id, note: delivery.note, lane: delivery.lanePath,
        });
        this.recordSettleOutcome(job.id, 'delivered');
        this.captureLessons(handle, job.id);
        this.log('info', 'minion briefing turn completed', { job: job.id, agent: handle.id, disposition });
        return { ok: true as const };
      };
      const settled = promptWithTerminalVerdict(
        handle,
        renderMinionBriefing({
          jobId: job.id,
          repoName,
          branch: worktree.branch ?? `gru/${job.id}`,
          worktreePath: worktree.path,
          sha: worktree.sha,
          briefing: input.briefing,
          ...(lessons.length > 0 ? { lessons } : {}),
        }),
        { owner: `dispatch:${job.id}` },
      )
        .then(
          (verdict) => settleTurn(null, verdict),
          (error: unknown) => settleTurn(error, null),
        )
        .finally(() => {
          releaseWorker();
        });

      return { job: working, worktree, agentId: handle.id, settled };
    } catch (error) {
      releaseWorker();
      this.opts.ledger.setJobStatus(job.id, 'blocked');
      this.opts.ledger.noteJob(job.id, `dispatch failed: ${String(error)}`);
      this.closeHandoffQuietly(handoffPhaseId, `dispatch failed before admission: ${String(error)}`);
      throw error;
    }
  }

  /** One failure path for a rejected prompt AND a fulfilled-but-error
   * turn: durable error event, blocked lane, and the marked guard row
   * closed only when no delivery was recorded (a recorded delivery means
   * the completion reconcile owns the phase). A failed attempt can never
   * masquerade as a completed marked phase. */
  private recordTurnFailure(
    jobId: string,
    agentId: string,
    phaseId: string | null,
    deliveredRecorded: boolean,
    error: string,
  ): { ok: false; error: string } {
    this.opts.ledger.appendCustomEvent({
      kind: 'job.minion-error',
      jobId,
      payload: { agentId, error },
    });
    this.recordSettleOutcome(jobId, 'blocked');
    if (!deliveredRecorded) {
      this.closeHandoffQuietly(phaseId, `dispatch turn failed: ${error}`);
    }
    this.log('error', 'minion briefing turn failed', { job: jobId, agent: agentId, error });
    return { ok: false as const, error };
  }

  /** Close an awaiting marked-phase guard row after a positive failure.
   * Never closes a completed phase (a recorded delivery already owns it),
   * and a close failure is logged — the row stays awaiting, which is
   * honest, and no completion evidence exists to fabricate a hand-back. */
  private closeHandoffQuietly(phaseId: string | null, reason: string): void {
    if (phaseId === null) return;
    try {
      const phase = this.opts.ledger.getPhaseHandoff(phaseId);
      if (phase !== null && phase.state === 'awaiting') {
        this.opts.ledger.closePhaseHandoff({ phaseId, reason });
      }
    } catch (error) {
      this.log('error', 'phase handoff close after failure also failed', { phase: phaseId, error: String(error) });
    }
  }

  /** Capture the minion's opt-in lessons block (a bonus, never the
   * delivery contract — a failure is logged, not surfaced). */
  private captureLessons(handle: AgentHandle, jobId: string): void {
    if (this.opts.lessonsCapture === undefined) return;
    try {
      this.opts.lessonsCapture.capture({ sessionFile: handle.sessionFile, source: `minion:${jobId}` });
    } catch (error) {
      this.log('error', 'minion lessons capture failed', { job: jobId, error: String(error) });
    }
  }

  /** Record the PR link (the minion's lane artifact; merging is review's).
   * A registered PR opens the review window: working|delivered → in-review.
   * Later states (blocked/parked/merged/done) are left as-is — a link
   * never resurrects a lane. Merge DETECTION is not here: nothing in this
   * service writes 'merged'; that stays the external sweep's (Silas's)
   * call — the remaining external caller of the job machine. */
  recordPr(jobId: string, url: string): JobRecord {
    const job = this.opts.ledger.setJobPr(jobId, url);
    this.opts.ledger.appendCustomEvent({
      kind: 'job.pr-linked',
      jobId,
      payload: { url },
    });
    if (job.status === 'working' || job.status === 'delivered') {
      return this.opts.ledger.setJobStatus(jobId, 'in-review');
    }
    return job;
  }

  /** The job's worktree lanes (the registry is the map — ruling 18b). */
  worktreesFor(jobId: string): readonly WorktreeLane[] {
    return this.opts.worktrees.listWorktrees({ jobId });
  }

  /** Release the job's lane (the port's sweep; the manager lane owns the
   * preserve-first/pause-and-ask mechanics). */
  async release(
    jobId: string,
    opts: { confirmKill?: boolean; baseBranch?: string } = {},
  ): Promise<WorktreeSweepResult | null> {
    const lanes = this.opts.worktrees.listWorktrees({ jobId });
    const active = lanes.find((lane) => lane.status !== 'swept');
    if (active === undefined) return null;
    return this.opts.worktrees.release({
      worktreeId: active.id,
      ...(opts.confirmKill !== undefined ? { confirmKill: opts.confirmKill } : {}),
      ...(opts.baseBranch !== undefined ? { baseBranch: opts.baseBranch } : {}),
    });
  }

  /**
   * Settle status truth (owner report 2026-09-22): the briefing turn
   * settling IS the delivery point — `delivered` on ok, `blocked` on
   * error. `delivered` is legal only from `working` (its sole predecessor
   * in the ledger machine); `blocked` is legal from every non-terminal
   * state. When the job already advanced past the settle point (a PR
   * registered mid-turn lands `in-review` first), the newer truth wins —
   * the settle leaves it in place rather than forcing an illegal hop.
   * Merge detection is NOT here: `merged` remains the external sweep's
   * (Silas's) call — the remaining external caller of the job machine.
   */
  private recordSettleOutcome(jobId: string, status: 'delivered' | 'blocked'): void {
    const current = this.opts.ledger.getJob(jobId);
    if (current === null || current.status === status) return;
    const legal = status === 'blocked' ? !isJobTerminal(current.status) : current.status === 'working';
    if (!legal) {
      this.log('info', 'settle status skipped — job already advanced', {
        job: jobId,
        status: current.status,
        settle: status,
      });
      return;
    }
    this.opts.ledger.setJobStatus(jobId, status);
  }

  private async sweepQuietly(worktreeId: string): Promise<void> {
    try {
      await this.opts.worktrees.release({ worktreeId });
    } catch (error) {
      this.log('error', 'worktree sweep after failed dispatch also failed', {
        worktreeId,
        error: String(error),
      });
    }
  }
}
