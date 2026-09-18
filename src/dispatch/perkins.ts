import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { LogLevel } from '../logger.js';
import type { LedgerApi, RoundRecord, RoundVerdict } from '../ledger/api.js';
import { DEFAULT_LENSES } from '../ledger/api.js';
import type { WorktreeManager } from '../worktrees/manager.js';
import type { AgentSpawner } from './service.js';
import { requireSpawnCwd } from '../roles.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Perkins wave runner (EPICS E8 story 3; SPEC rulings 15/18d): one review
 * round = a multi-lens agent fleet on a DETACHED worktree at the ref
 * under review. Per-lens chips live on the board (the ledger's lens
 * states, driven by the runtime tap + explicit outcomes); verdicts
 * consolidate honestly; the comment-verdict posts to the PR via `gh`
 * (injectable — tests never shell out).
 */

/** The per-lens severity vocabulary (strict; SPEC ruling 15). */
export const LENS_VERDICTS = ['blocker', 'warning', 'note', 'clean'] as const;
export type LensVerdict = (typeof LENS_VERDICTS)[number];

export function isLensVerdict(value: string): value is LensVerdict {
  return (LENS_VERDICTS as readonly string[]).includes(value);
}

/** One lens's structured result ('error' = the lens could not conclude). */
export type LensResult =
  | { readonly state: 'done'; readonly verdict: LensVerdict; readonly note?: string }
  | { readonly state: 'error'; readonly note: string };

/** What each lens hunts (generic canon; the persona lives in roles/perkins.md). */
export const LENS_INSTRUCTIONS: Readonly<Record<string, string>> = {
  blind:
    'Review the change as a careful stranger with no context advantage: ' +
    'would the diff alone convince you it is correct? Question assumptions the code makes that the reader cannot verify.',
  edge:
    'Hunt boundaries: empty inputs, off-by-one, overflow, races, partial failure, retry and restart paths, concurrency and interleavings.',
  acceptance:
    'Judge the change against its own stated goal: does it do the thing it exists to do? Name what the acceptance criteria are and whether each is met.',
  security:
    'Audit trust boundaries: injection, path traversal, authentication and authorization gaps, secret handling, unsafe deserialization, egress.',
  architecture:
    'Assess fit: layering, coupling, dependency direction, and whether the change flows with the codebase\u2019s shape or fights it.',
  codebase:
    'Check consistency with this project\u2019s own conventions and patterns: naming, error handling idioms, module boundaries, test style.',
  tests:
    'Interrogate the tests: do they prove the claim, what is uncovered, and would they fail before the change? Untested behavior is unproven behavior.',
};

/** The strict protocol every lens agent ends its turn with. Worded so
 * the PROMPT itself can never match the extraction regex (the protocol
 * line names a PLACEHOLDER, not a verdict word — a false match would
 * forge a verdict from the prompt echo). */
export const LENS_VERDICT_PROTOCOL =
  'End your final message with a line of exactly this shape — LENS-VERDICT: <one of: blocker, warning, note, clean> — ' +
  'where blocker = a defect that must be fixed before merge, warning = a real concern short of blocking, ' +
  'note = an observation worth recording, clean = nothing found.';

export interface LensContext {
  readonly jobId: string;
  readonly roundId: string;
  readonly lens: string;
  readonly worktreePath: string;
  readonly targetRef: string;
}

/** Drives one lens to a structured result. Injectable for tests. */
export type LensDriver = (ctx: LensContext) => Promise<LensResult>;

/** Verdict posting (EPICS E8 story 3: comment-verdict via gh). */
export interface VerdictPoster {
  post(input: { readonly prUrl: string; readonly body: string }): Promise<void>;
}

/** `gh pr comment` poster — parses owner/repo/number from the PR URL. */
export class GhPrPoster implements VerdictPoster {
  constructor(private readonly binary = 'gh') {}

  async post(input: { readonly prUrl: string; readonly body: string }): Promise<void> {
    const match = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(input.prUrl.trim());
    if (match === null) {
      throw new Error(`cannot parse a PR reference out of "${input.prUrl}" — expected .../owner/repo/pull/<number>`);
    }
    const owner = match[1] as string;
    const repo = match[2] as string;
    const prNumber = match[3] as string;
    const result = spawnSync(
      this.binary,
      ['pr', 'comment', prNumber, '--repo', `${owner}/${repo}`, '--body-file', '-'],
      { input: input.body, encoding: 'utf-8', timeout: 30_000 },
    );
    if (result.error !== undefined) {
      throw new Error(`gh is unavailable (${String(result.error)}) — verdict recorded, comment not posted`);
    }
    if (result.status !== 0) {
      throw new Error(
        `gh pr comment exited ${result.status}: ${(result.stderr ?? '').trim().slice(0, 500)}`,
      );
    }
  }
}

/**
 * Consolidation policy (honest arithmetic, never averaging): any blocker
 * or warning → changes-requested; only notes/clean → approved; ANY lens
 * that could not conclude (no result) → null — a hole in the wall of
 * proof escalates instead of softening the verdict.
 */
export function consolidateVerdict(results: readonly (LensResult | null)[]): RoundVerdict | null {
  if (results.some((result) => result === null || result.state === 'error')) return null;
  const verdicts = results.map((result) => (result as { verdict: LensVerdict }).verdict);
  if (verdicts.some((verdict) => verdict === 'blocker' || verdict === 'warning')) {
    return 'changes-requested';
  }
  return 'approved';
}

/** Extract the LAST structured verdict line from an agent's session file. */
export function verdictFromSessionFile(sessionFile: string): LensVerdict | null {
  let text: string;
  try {
    text = readFileSync(sessionFile, 'utf-8');
  } catch {
    return null;
  }
  const pattern = /LENS-VERDICT:\s*(blocker|warning|note|clean)/gi;
  let last: LensVerdict | null = null;
  for (const match of text.matchAll(pattern)) {
    last = match[1]!.toLowerCase() as LensVerdict;
  }
  return last;
}

function lensPrompt(ctx: LensContext, instruction: string): string {
  return [
    `Review lens "${ctx.lens}" — round ${ctx.roundId} on job ${ctx.jobId}.`,
    `The change under review is checked out (detached) at ref "${ctx.targetRef}" in: ${ctx.worktreePath}`,
    `Your lens: ${instruction}`,
    '',
    'Ground every finding: name the file and line, and how to verify it.',
    'Severity vocabulary is strict: blocker, warning, note — nothing else.',
    LENS_VERDICT_PROTOCOL,
  ].join('\n');
}

export interface WaveRunnerOptions {
  readonly ledger: LedgerApi;
  readonly manager: WorktreeManager;
  readonly spawner: AgentSpawner;
  readonly poster?: VerdictPoster;
  /** Escalation hook (fail-loud): production wires the notification center. */
  readonly escalate?: (title: string, detail: string) => void;
  /** Override the default lens driver (production: spawn + parse). */
  readonly driveLens?: LensDriver;
  readonly log?: Log;
}

export interface WaveOutcome {
  readonly round: RoundRecord;
  readonly results: readonly (LensResult | null)[];
  readonly verdict: RoundVerdict | null;
  readonly posted: boolean;
}

export class WaveRunner {
  private readonly opts: WaveRunnerOptions;
  private readonly log: Log;

  constructor(opts: WaveRunnerOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  /** Run one round to completion (tests + service callers). */
  async runRound(input: {
    jobId: string;
    targetRef?: string;
    lenses?: readonly string[];
  }): Promise<WaveOutcome> {
    const begun = await this.beginRound(input);
    return begun.run;
  }

  /** Set the round up (job in review, chips created, detached worktree,
   * fleet LAUNCHED) and return immediately — the outcome promise is the
   * board's to watch, not the HTTP caller's. */
  async beginRound(input: {
    jobId: string;
    targetRef?: string;
    lenses?: readonly string[];
  }): Promise<{ readonly round: RoundRecord; readonly run: Promise<WaveOutcome> }> {
    const job = this.opts.ledger.getJob(input.jobId);
    if (job === null) throw new Error(`job "${input.jobId}" not found — nothing to review`);
    if (job.status === 'merged' || job.status === 'done') {
      throw new Error(`job "${input.jobId}" is ${job.status} — terminal lanes do not go back under review`);
    }
    const jobWorktree = this.opts.ledger.getWorktree(input.jobId);
    if (jobWorktree === null) {
      throw new Error(
        `job "${input.jobId}" has no worktree in the registry — the review reads the repo through its job lane (SPEC ruling 18b)`,
      );
    }
    const lenses =
      input.lenses === undefined || input.lenses.length === 0 ? [...DEFAULT_LENSES] : [...input.lenses];
    const targetRef = input.targetRef ?? jobWorktree.branch ?? jobWorktree.sha;

    // Job enters review; round goes live with its chips.
    const flippedFrom =
      job.status === 'working' || job.status === 'blocked' ? job.status : null;
    if (flippedFrom !== null) {
      this.opts.ledger.setJobStatus(job.id, 'in-review');
    }
    const round = this.opts.ledger.addRound({ jobId: job.id, lenses, targetRef });

    // Detached-for-reviews (ruling 18d): reviews never grow branch debris.
    // A setup failure aborts the round loudly and restores the job to the
    // lane status THIS call flipped — never a pending-forever round with a
    // job stuck in review.
    let reviewWorktree;
    try {
      reviewWorktree = await this.opts.manager.createReviewWorktree({
        repoPath: jobWorktree.repoPath,
        roundId: round.id,
        ref: targetRef,
      });
      this.opts.ledger.setRoundStatus(round.id, 'live');
    } catch (error) {
      this.opts.ledger.setRoundStatus(round.id, 'aborted');
      if (flippedFrom !== null) this.opts.ledger.setJobStatus(job.id, flippedFrom);
      throw error;
    }
    this.log('info', 'review round live', {
      job: job.id,
      round: round.id,
      lenses: lenses.length,
      targetRef,
    });

    return { round, run: this.runFleet(job, round, lenses, reviewWorktree.path, targetRef) };
  }

  private async runFleet(
    job: { readonly id: string; readonly prUrl: string | null },
    round: RoundRecord,
    lenses: readonly string[],
    worktreePath: string,
    targetRef: string,
  ): Promise<WaveOutcome> {
    // The fleet: one agent per lens, all bound to their chips.
    const driver = this.opts.driveLens ?? this.defaultDriver(worktreePath, targetRef);
    const ctxs = lenses.map((lens) => ({
      jobId: job.id,
      roundId: round.id,
      lens,
      worktreePath,
      targetRef,
    }));
    const settled = await Promise.all(
      ctxs.map(async (ctx) => {
        try {
          const result = await driver(ctx);
          if (result.state === 'done') {
            this.opts.ledger.setLensOutcome(ctx.roundId, ctx.lens, 'done', result.verdict);
          } else {
            this.opts.ledger.setLensOutcome(ctx.roundId, ctx.lens, 'error', result.note);
          }
          return result;
        } catch (error) {
          // A lens that THREW still owes the record its error chip.
          this.opts.ledger.setLensOutcome(ctx.roundId, ctx.lens, 'error', String(error));
          return null;
        }
      }),
    );

    // Consolidation — honest arithmetic (see consolidateVerdict).
    const verdict = consolidateVerdict(settled);
    if (verdict === null) {
      const failed = settled
        .map((result, index) => (result === null || result.state === 'error' ? lenses[index] : null))
        .filter((lens): lens is string => lens !== null);
      this.opts.escalate?.(
        `Review round ${round.id} could not conclude`,
        `lenses failed: ${failed.join(', ')} — verdict withheld (no softening); rerun the round or inspect the lens transcripts`,
      );
      this.opts.ledger.appendCustomEvent({
        kind: 'round.lens-failures',
        jobId: job.id,
        roundId: round.id,
        payload: { failed },
      });
      this.log('error', 'review round has failed lenses — verdict withheld', {
        job: job.id,
        round: round.id,
        failed,
      });
      await this.sweepReviewWorktree(round.id);
      return { round: this.opts.ledger.getRound(round.id) as RoundRecord, results: settled, verdict: null, posted: false };
    }

    // Record of record first (the ledger IS the record); then post.
    this.opts.ledger.setRoundVerdict(round.id, verdict);
    let posted = false;
    if (job.prUrl !== null && this.opts.poster !== undefined) {
      try {
        await this.opts.poster.post({
          prUrl: job.prUrl,
          body: this.renderVerdictComment(round.id, verdict, lenses, settled),
        });
        posted = true;
        this.opts.ledger.appendCustomEvent({
          kind: 'round.posted',
          jobId: job.id,
          roundId: round.id,
          payload: { verdict, url: job.prUrl },
        });
      } catch (error) {
        this.opts.escalate?.(
          `Verdict for round ${round.id} posted to the ledger but NOT to the pull request`,
          String(error),
        );
        this.opts.ledger.appendCustomEvent({
          kind: 'round.post-failed',
          jobId: job.id,
          roundId: round.id,
          payload: { verdict, error: String(error) },
        });
        this.log('error', 'verdict comment post failed', { round: round.id, error: String(error) });
      }
    }
    await this.sweepReviewWorktree(round.id);
    return { round: this.opts.ledger.getRound(round.id) as RoundRecord, results: settled, verdict, posted };
  }

  /**
   * A finished round releases its DETACHED worktree (ruling 18c sweep —
   * preserve-first, pause-and-ask if a lens left a live process behind).
   * Sweep failure is logged + escalated, never fatal to the recorded
   * round outcome — but rounds never leak worktrees silently.
   */
  private async sweepReviewWorktree(roundId: string): Promise<void> {
    try {
      const result = await this.opts.manager.release({ worktreeId: roundId });
      if (result.status === 'paused') {
        this.opts.escalate?.(
          `Review worktree for round ${roundId} paused on live processes`,
          `the sweep found live processes rooted in the review tree — acknowledge to finish the cleanup`,
        );
      }
    } catch (error) {
      this.log('error', 'review worktree sweep failed', { round: roundId, error: String(error) });
      this.opts.escalate?.(
        `Review worktree for round ${roundId} could not be swept`,
        String(error),
      );
    }
  }

  /** Production driver: spawn a perkins agent per lens, parse the protocol line. */
  private defaultDriver(worktreePath: string, _targetRef: string): LensDriver {
    return async (ctx) => {
      const instruction = LENS_INSTRUCTIONS[ctx.lens] ?? `Review the change from your own expert angle ("${ctx.lens}").`;
      const cwd = requireSpawnCwd('perkins', worktreePath);
      const handle = await this.opts.spawner('perkins', { cwd });
      // Bind the lens + round wiring ourselves (idempotent; observer
      // ordering is never a precondition of the wave).
      this.opts.ledger.registerAgent({
        id: handle.id,
        role: 'perkins',
        sessionFile: handle.sessionFile,
        roundId: ctx.roundId,
        jobId: ctx.jobId,
      });
      this.opts.ledger.bindLens(ctx.roundId, ctx.lens, handle.id);
      try {
        await handle.prompt(lensPrompt(ctx, instruction), { owner: `perkins:${ctx.roundId}:${ctx.lens}` });
      } catch (error) {
        return { state: 'error', note: `lens turn failed: ${String(error)}` };
      }
      if (handle.sessionFile === null) {
        return { state: 'error', note: 'lens session not persisted — no verdict to read' };
      }
      const verdict = verdictFromSessionFile(handle.sessionFile);
      if (verdict === null) {
        return {
          state: 'error',
          note: 'no LENS-VERDICT line in the lens agent\u2019s final output — the protocol is mandatory',
        };
      }
      return { state: 'done', verdict };
    };
  }

  /** The PR comment body (plain, factual — persona never enters the record). */
  private renderVerdictComment(
    roundId: string,
    verdict: RoundVerdict,
    lenses: readonly string[],
    results: readonly (LensResult | null)[],
  ): string {
    const lines = [`Perkins review round ${roundId} — verdict: ${verdict}`, ''];
    for (const [index, lens] of lenses.entries()) {
      const result = results[index] ?? null;
      if (result === null || result.state === 'error') {
        lines.push(`- ${lens}: ERROR — ${result === null ? 'lens crashed' : result.note}`);
      } else if (result.state === 'done') {
        lines.push(`- ${lens}: ${result.verdict}${result.note !== undefined ? ` — ${result.note}` : ''}`);
      }
    }
    return lines.join('\n');
  }
}
