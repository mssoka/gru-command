import type { LogLevel } from '../logger.js';
import type { LedgerApi, JobRecord } from '../ledger/api.js';
import { isJobTerminal } from '../ledger/states.js';
import type { Role } from '../config.js';
import type { AgentHandle, SpawnOptions } from '../runtime/types.js';
import { requireSpawnCwd } from '../roles.js';
import { renderLessonsSection } from '../lessons/references.js';
import type { LessonPointer, LessonsReferencePort } from '../lessons/types.js';
import type { LessonCapturePort } from '../lessons/capture.js';
import type { WorktreeLane, WorktreePort, WorktreeSweepResult } from './worktree-port.js';
import { recordFollowUpDelivery } from './fix-directive.js';

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

    try {
      const working = this.opts.ledger.setJobStatus(job.id, 'working');

      // (3) One worktree per job, fresh head, own branch (ruling 18).
      const worktree = await this.opts.worktrees.createJobWorktree({
        repoPath: input.repoPath,
        jobId: job.id,
      });

      // (4) The minion: a fresh agent session rooted in the PROJECT
      // worktree (ruling 17: dispatch cwd = project root, all runtimes).
      let handle: AgentHandle;
      try {
        const cwd = requireSpawnCwd('minion', worktree.path);
        handle = await this.opts.spawner('minion', { cwd });
      } catch (error) {
        // The lane cannot start — sweep the fresh worktree (preserve
        // first, per ruling 18c) and block the job.
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
      // board shows the arc through ledger events, not this await.
      const lessons = this.opts.lessons?.referencesFor(`${input.title}\n${input.briefing}`) ?? [];
      const settled = handle
        .prompt(
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
          async () => {
            const delivery = recordFollowUpDelivery({ ledger: this.opts.ledger,
              worktrees: this.opts.worktrees, jobId: job.id, agentId: handle.id, source: 'dispatch' });
            if (delivery.note !== null) this.log('warn', 'initial delivery has no resolvable lane head', {
              job: job.id, note: delivery.note, lane: delivery.lanePath,
            });
            this.recordSettleOutcome(job.id, 'delivered');
            this.captureLessons(handle, job.id);
            this.log('info', 'minion briefing turn completed', { job: job.id, agent: handle.id });
            return { ok: true as const };
          },
          (error: unknown) => {
            this.opts.ledger.appendCustomEvent({
              kind: 'job.minion-error',
              jobId: job.id,
              payload: { agentId: handle.id, error: String(error) },
            });
            this.recordSettleOutcome(job.id, 'blocked');
            this.log('error', 'minion briefing turn failed', {
              job: job.id,
              agent: handle.id,
              error: String(error),
            });
            return { ok: false as const, error: String(error) };
          },
        );

      return { job: working, worktree, agentId: handle.id, settled };
    } catch (error) {
      this.opts.ledger.setJobStatus(job.id, 'blocked');
      this.opts.ledger.noteJob(job.id, `dispatch failed: ${String(error)}`);
      throw error;
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
