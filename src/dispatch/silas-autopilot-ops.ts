/**
 * The production binding of {@link SilasAutopilotOps} (issue #243).
 *
 * One rule: the autopilot reaches the service through the SAME functions
 * the HTTP endpoints compose — never HTTP. The endpoints themselves are
 * request handlers (they read a body, answer a status, and track an
 * in-process controller); this module is the service half of those
 * handlers, in the same order, with the same durable receipts. Where the
 * endpoint's answer is a 202 because the worker turn is long, this module
 * starts the turn in the background for exactly the same reason: the
 * deterministic pass that calls it must stay bounded.
 *
 * Provenance: every receipt the autopilot can write carries its `rule_id`
 * and `source: 'silas-autopilot'`, so #214's agreement read can never
 * confuse a machine action with the model's own. One limitation is stated
 * rather than hidden: a re-brief's `silas.rebrief` receipt is written by
 * the existing durable finalizer from its request marker, whose fields are
 * the ledger's — it carries the `rule_id`, but the marker has no source
 * column to carry `source`.
 */
import type { LedgerApi } from '../ledger/api.js';
import { isJobTerminal } from '../ledger/states.js';
import type { PacingGate, RetrySettlement } from '../runtime/pacing.js';
import type { NativeAgentTool } from '../runtime/types.js';
import type { LessonsReferencePort } from '../lessons/types.js';
import type { LogLevel } from '../logger.js';
import type { GhApiPort, RepoRef } from './github-poll.js';
import {
  flipJobToWorking,
  rebriefFreshMinion,
  recordFollowUpDelivery,
  routeFixDirectiveToMinion,
  type DirectiveRegistry,
} from './fix-directive.js';
import { ReviewSupersessionUnconfirmedError, type ReviewRequestInput, type ReviewRequestOutcome } from './perkins.js';
import { checkRebriefTurn, finalizeRebriefRequest, RebriefTurnCancelled } from './rebrief-recovery.js';
import { AUTOPILOT_SOURCE, type AutopilotPull, type SilasAutopilotOps } from './silas-autopilot.js';
import type { SilasAutopilotRuleId } from './silas-rules.js';
import type { WorktreePort, WorktreeSweepResult } from './worktree-port.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/** The dispatch-service surface `POST /api/dispatch/pr` calls. */
export interface AutopilotDispatchSurface {
  recordPr(jobId: string, url: string): { readonly prUrl: string | null };
}

/** The review-wave surface `POST /api/dispatch/review` calls. */
export interface AutopilotWaveSurface {
  /** Returns the supersession record (a `Promise<void>`-compatible await
   * target); only rejection matters here. */
  clearLaneForWriter(input: { readonly jobId: string; readonly writer: string }): Promise<unknown>;
  requestReview(input: ReviewRequestInput): Promise<ReviewRequestOutcome>;
}

export interface SilasAutopilotOpsDeps {
  readonly ledger: LedgerApi;
  readonly wave: AutopilotWaveSurface;
  readonly registry: DirectiveRegistry;
  readonly worktrees: WorktreePort;
  readonly dispatch: AutopilotDispatchSurface;
  /** The GitHub port: `gh pr list --head` is asked through this, never by
   * shelling out from the autopilot. */
  readonly gh: Pick<GhApiPort, 'listPullsForHead'>;
  /** Resolves a lane path to its remote (github-poll's own resolver). */
  readonly resolveRemote: (repoPath: string) => RepoRef | null;
  readonly workerGate?: PacingGate;
  readonly retrySettlement?: (agentId: string) => Promise<RetrySettlement>;
  readonly parentTools?: (agentId: string) => readonly NativeAgentTool[];
  readonly lessons?: LessonsReferencePort;
  readonly log?: Log;
}

/** The extension of a `silas.*` receipt payload that marks it as the
 * autopilot's own work. */
export function autopilotReceiptFields(ruleId: SilasAutopilotRuleId): {
  readonly rule_id: SilasAutopilotRuleId;
  readonly source: string;
} {
  return { rule_id: ruleId, source: AUTOPILOT_SOURCE };
}

export function createSilasAutopilotOps(deps: SilasAutopilotOpsDeps): SilasAutopilotOps {
  const log = deps.log ?? ((): void => {});

  /** Run a long worker turn in the background, exactly as the endpoints do
   * (their 202 answers the request before the turn settles). A failure is
   * logged: the receipt is what proves the action, so an unrecorded turn
   * leaves its row for the next pass and for LLM Silas. */
  const background = (label: string, jobId: string, run: Promise<unknown>): void => {
    void run.catch((error: unknown) => {
      log('error', `silas autopilot ${label} failed after acceptance`, {
        job: jobId,
        error: String(error).slice(0, 300),
      });
    });
  };

  const listOpenPrsForHead = async (input: {
    readonly repoPath: string;
    readonly branch: string;
  }): Promise<readonly AutopilotPull[]> => {
    const remote = deps.resolveRemote(input.repoPath);
    if (remote === null) {
      throw new Error(`no github remote resolves for lane "${input.repoPath}"`);
    }
    const pulls = await deps.gh.listPullsForHead({ repo: remote, head: input.branch });
    return pulls
      .filter((pull) => pull.state === 'open' && pull.url !== null)
      .map((pull) => ({ number: pull.number, url: pull.url as string }));
  };

  const registerPr = async (input: {
    readonly jobId: string;
    readonly url: string;
    readonly ruleId: SilasAutopilotRuleId;
  }): Promise<void> => {
    const job = deps.dispatch.recordPr(input.jobId, input.url);
    deps.ledger.appendCustomEvent({
      kind: 'silas.pr-registered',
      jobId: input.jobId,
      payload: { url: job.prUrl, ...autopilotReceiptFields(input.ruleId) },
    });
  };

  const triggerReview = async (input: {
    readonly jobId: string;
    readonly ruleId: SilasAutopilotRuleId;
    readonly sourceRoundId?: string;
  }): Promise<void> => {
    // The envelope may not be long-lived while the review setup runs: the
    // endpoint answers 202 and tracks the run; so does this.
    const controller = new AbortController();
    const run = (async (): Promise<void> => {
      // The clean-abort re-arm freezes the PROVED delivered head: the
      // endpoint re-derives it from the round's target and the newest
      // delivery, and refuses a stale bind.
      const deliverEvent = deps.ledger.latestJobEvent(input.jobId, 'job.delivered');
      const deliveredSha =
        deliverEvent !== null && typeof deliverEvent.payload === 'object' && deliverEvent.payload !== null
          ? (deliverEvent.payload as { sha?: unknown }).sha
          : null;
      const requestInput: ReviewRequestInput = {
        jobId: input.jobId,
        ...(input.sourceRoundId === undefined
          ? {}
          : {
              targetRef: typeof deliveredSha === 'string' ? deliveredSha : undefined,
              boundDeliveredSha: typeof deliveredSha === 'string' ? deliveredSha : undefined,
            }),
      };
      const outcome = await deps.wave.requestReview(requestInput);
      const armed = outcome.route === 'perkins';
      deps.ledger.appendCustomEvent({
        kind: armed ? 'silas.review-triggered' : 'silas.review-deferred',
        jobId: input.jobId,
        payload: {
          route: outcome.route,
          ...(armed && outcome.route === 'perkins' ? { round_id: outcome.round.id } : {}),
          ...(input.sourceRoundId === undefined ? {} : { source_round_id: input.sourceRoundId }),
          ...autopilotReceiptFields(input.ruleId),
        },
      });
    })();
    background('review trigger', input.jobId, run);
    void controller;
  };

  const sendDirective = async (input: {
    readonly jobId: string;
    readonly directive: string;
    readonly ruleId: SilasAutopilotRuleId;
    readonly blockerFingerprint?: string;
    readonly sourceRoundId?: string;
  }): Promise<void> => {
    const begun = deps.ledger.beginDirectiveIntent({
      jobId: input.jobId,
      directive: input.directive,
      holder: 'silas-ops',
      ...(input.blockerFingerprint === undefined ? {} : { blockerFingerprint: input.blockerFingerprint }),
    });
    const intent = begun.record;
    const contract = deps.ledger.effectiveContract(input.jobId)?.text ?? null;
    const releaseAdmission = deps.ledger.beginJobAdmission(input.jobId, `directive ${intent.requestId}`);
    const run = (async (): Promise<void> => {
      try {
        await deps.wave.clearLaneForWriter({ jobId: input.jobId, writer: `directive ${intent.requestId}` });
      } catch (error) {
        if (!(error instanceof ReviewSupersessionUnconfirmedError)) throw error;
        deps.ledger.failDirective({
          requestId: intent.requestId,
          reason: `refused before any prompt: ${error.message}`,
        });
        return;
      }
      const delivery = await routeFixDirectiveToMinion({
        registry: deps.registry,
        ledger: deps.ledger,
        worktrees: deps.worktrees,
        jobId: input.jobId,
        directive: input.directive,
        contract,
        signal: new AbortController().signal,
        owner: 'silas-ops',
        ...(deps.workerGate === undefined ? {} : { workerGate: deps.workerGate }),
        ...(deps.retrySettlement === undefined ? {} : { retrySettlement: deps.retrySettlement }),
        ...(deps.lessons === undefined ? {} : { lessons: deps.lessons }),
        ...(deps.parentTools === undefined ? {} : { parentTools: deps.parentTools }),
      });
      if (!delivery.delivered) {
        // Positive no-effect proof: a durable failure is honest, and the
        // row stays for the next pass.
        deps.ledger.failDirective({
          requestId: intent.requestId,
          reason: delivery.note ?? 'no implementing minion session and no job lane',
        });
        return;
      }
      const sent = deps.ledger.appendCustomEvent({
        kind: 'silas.directive-sent',
        jobId: input.jobId,
        payload: {
          request_id: intent.requestId,
          minion_id: delivery.minionId ?? null,
          ...(input.blockerFingerprint === undefined ? {} : { blocker_fingerprint: input.blockerFingerprint }),
          ...(input.sourceRoundId === undefined ? {} : { source_round_id: input.sourceRoundId }),
          directive_bytes: Buffer.byteLength(input.directive, 'utf-8'),
          ...autopilotReceiptFields(input.ruleId),
        },
      });
      if (delivery.minionId === undefined) {
        deps.ledger.recordDirectiveReconcile({
          requestId: intent.requestId,
          note: 'admission evidence lacked minion identity',
        });
        return;
      }
      deps.ledger.recordDirectiveAdmission({
        requestId: intent.requestId,
        minionId: delivery.minionId,
        eventSeq: sent.seq,
      });
      if (delivery.outcome === 'error') {
        deps.ledger.appendCustomEvent({
          kind: 'job.minion-error',
          jobId: input.jobId,
          payload: { agentId: delivery.minionId, error: delivery.error ?? 'runtime error' },
        });
        deps.ledger.recordDirectiveReconcile({
          requestId: intent.requestId,
          note: 'admitted turn settled with an in-band runtime error — no delivery recorded',
        });
        return;
      }
      flipJobToWorking(deps.ledger, input.jobId);
      const followUp = recordFollowUpDelivery({
        ledger: deps.ledger,
        worktrees: deps.worktrees,
        jobId: input.jobId,
        agentId: delivery.minionId,
        source: 'silas-directive',
        requestId: intent.requestId,
        workRevision: intent.workRevision ?? 0,
      });
      deps.ledger.recordDirectiveDelivery({ requestId: intent.requestId, eventSeq: followUp.eventSeq });
    })();
    background('directive', input.jobId, run);
    run.finally(() => releaseAdmission()).catch(() => {});
  };

  const sendRebrief = async (input: {
    readonly jobId: string;
    readonly note: string;
    readonly ruleId: SilasAutopilotRuleId;
    readonly sourceRoundId: string;
  }): Promise<void> => {
    const job = deps.ledger.getJob(input.jobId);
    if (job === null) throw new Error(`job "${input.jobId}" not found`);
    await deps.wave.clearLaneForWriter({ jobId: input.jobId, writer: `re-brief for job ${input.jobId}` });
    const contract = deps.ledger.effectiveContract(input.jobId)?.text ?? job.briefing;
    // The markers are durable BEFORE any worker exists (restart-safe), and
    // they carry the firing rule, so the `silas.rebrief` receipt replays it.
    const markers = deps.ledger.beginPendingRebrief({
      jobId: input.jobId,
      note: input.note,
      briefing: contract,
      ruleId: input.ruleId,
      sourceRoundId: input.sourceRoundId,
    });
    const workRevision = markers.find((marker) => marker.workRevision !== null)?.workRevision ?? 0;
    const run = (async (): Promise<void> => {
      try {
        const result = await rebriefFreshMinion({
          registry: deps.registry,
          ledger: deps.ledger,
          worktrees: deps.worktrees,
          jobId: input.jobId,
          note: input.note,
          briefing: contract,
          workRevision,
          beforeTurnSideEffect: () => checkRebriefTurn(deps.ledger, input.jobId, markers),
          onSpawned: (worker) => {
            deps.ledger.bindPendingRebriefWorker({
              ids: markers.map((marker) => marker.id),
              agentId: worker.id,
              sessionFile: worker.sessionFile,
            });
          },
          ...(deps.workerGate === undefined ? {} : { workerGate: deps.workerGate }),
          ...(deps.retrySettlement === undefined ? {} : { retrySettlement: deps.retrySettlement }),
          ...(deps.lessons === undefined ? {} : { lessons: deps.lessons }),
          ...(deps.parentTools === undefined ? {} : { parentTools: deps.parentTools }),
        });
        if (result.outcome === 'error') {
          deps.ledger.appendCustomEvent({
            kind: 'job.minion-error',
            jobId: input.jobId,
            payload: { agentId: result.minionId, error: result.error ?? 'runtime error' },
          });
          return;
        }
        finalizeRebriefRequest({
          ledger: deps.ledger,
          worktrees: deps.worktrees,
          jobId: input.jobId,
          minionId: result.minionId,
          lanePath: result.lanePath,
          note: input.note,
          expectedMarkers: markers,
        });
      } catch (error) {
        if (!(error instanceof RebriefTurnCancelled)) throw error;
        // Cancelled before admission: nothing was delivered, so close the
        // markers honestly (the recovery ladder would otherwise resume a
        // request this pass already abandoned).
        finalizeRebriefRequest({
          ledger: deps.ledger,
          worktrees: deps.worktrees,
          jobId: input.jobId,
          minionId: null,
          lanePath: null,
          note: input.note,
          expectedMarkers: markers,
        });
      }
    })();
    background('re-brief', input.jobId, run);
  };

  const releaseLane = async (input: {
    readonly jobId: string;
    readonly ruleId: SilasAutopilotRuleId;
  }): Promise<void> => {
    const job = deps.ledger.getJob(input.jobId);
    if (job === null) throw new Error(`job "${input.jobId}" not found`);
    if (!isJobTerminal(job.status)) {
      throw new Error(`job "${input.jobId}" is ${job.status} — sweep-ack releases only terminal lanes`);
    }
    const outstanding = deps.ledger.listChildWorkers({ jobId: input.jobId }).filter((child) => child.resultState === null);
    if (outstanding.length > 0) {
      throw new Error(
        `job "${input.jobId}" has ${outstanding.length} non-terminal child worker(s) — cancel them first`,
      );
    }
    const lane = deps.worktrees
      .listWorktrees({ jobId: input.jobId })
      .find((candidate) => candidate.kind === 'job' && candidate.status !== 'swept');
    if (lane === undefined) throw new Error(`job "${input.jobId}" has no active job lane`);
    const result: WorktreeSweepResult = await deps.worktrees.release({ worktreeId: lane.id });
    if (result.status !== 'swept') {
      // A paused release is a refusal, never an override: the pause-and-ask
      // rule stays absolute and no receipt is minted.
      throw new Error(`lane "${lane.id}" was paused for acknowledgement, not swept`);
    }
    deps.ledger.appendCustomEvent({
      kind: 'silas.lane-released',
      jobId: input.jobId,
      payload: {
        worktree_id: lane.id,
        by: 'silas',
        branch_disposition: result.branch,
        ...autopilotReceiptFields(input.ruleId),
      },
    });
  };

  return { listOpenPrsForHead, registerPr, triggerReview, sendDirective, sendRebrief, releaseLane };
}
