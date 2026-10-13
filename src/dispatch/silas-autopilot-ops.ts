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
 * confuse a machine action with the model's own. The re-brief's
 * `silas.rebrief` receipt is written by the existing durable finalizer from
 * its request marker; the marker schema carries `source` (issue #243 M3),
 * so that receipt replays the autopilot provenance too — restart-safe,
 * exactly like its `rule_id`.
 */
import type { LedgerApi } from '../ledger/api.js';
import { isJobTerminal } from '../ledger/states.js';
import type { PacingGate, RetrySettlement } from '../runtime/pacing.js';
import type { NativeAgentTool } from '../runtime/types.js';
import type { LessonsReferencePort } from '../lessons/types.js';
import type { LogLevel } from '../logger.js';
import type { GhApiPort, RepoRef } from './github-poll.js';
import { BranchBusyError } from './branch-idle.js';
import {
  flipJobToWorking,
  rebriefFreshMinion,
  recordFollowUpDelivery,
  routeFixDirectiveToMinion,
  type DirectiveRegistry,
} from './fix-directive.js';
import { ReviewInProgressError, ReviewSupersessionUnconfirmedError, type ReviewRequestInput, type ReviewRequestOutcome } from './perkins.js';
import { checkRebriefTurn, finalizeRebriefRequest, RebriefTurnCancelled } from './rebrief-recovery.js';
import { deliveredTargetSha } from './silas-driver.js';
import {
  AUTOPILOT_SOURCE,
  decisionHold,
  deliveredPrRegisterHold,
  fencesHold,
  reviewEligible,
  sweepAckHold,
  type AutopilotPull,
  type DecisionHoldTriple,
  type SilasAutopilotOps,
} from './silas-autopilot.js';
import { renderFreshRevisionNote, renderRevisionContinuation } from './work-revision.js';
import { amendmentSupersessions, pendingMaterialAmendments } from '../review-inputs/amendments.js';
import type { SilasAutopilotRuleId } from './silas-rules.js';
import type { WorktreePort, WorktreeSweepResult } from './worktree-port.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/** The dispatch-service surface `POST /api/dispatch/pr` calls. */
export interface AutopilotDispatchSurface {
  recordPr(jobId: string, url: string): { readonly prUrl: string | null };
}

/** The review-wave surface `POST /api/dispatch/review` and
 * `POST /api/silas/directive|rebrief` call. */
export interface AutopilotWaveSurface {
  /** Owner rules 3/5 writer admission: a live review whose candidate is
   * still current REFUSES the writer (the branch stays frozen until the
   * verdict); a review made obsolete by a pending material correction is
   * superseded by the gate. The writer paths must call this BEFORE
   * {@link clearLaneForWriter} — the gate does not establish permission. */
  assertWriterAdmissible(jobId: string): void;
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
  /** Service-stopping signal: aborts QUEUED directive/re-brief admission
   * waits (a producer whose seat is taken after stop never starts) and lets
   * a running prompt settle. Absent = no stop ownership (unit tests). */
  readonly stopSignal?: AbortSignal;
  readonly log?: Log;
}

/** The production ops object plus the shutdown drain the assembly owns. */
export interface SilasAutopilotOpsHandle extends SilasAutopilotOps {
  /** Join the in-flight background producers. The service-stop signal aborts
   * queued admission waits (a producer whose seat is not yet taken never
   * starts) and lets running prompts settle. This is a JOIN, never a
   * cessation claim: an unsettled producer is reported, never fabricated
   * away. */
  drain(): Promise<{ readonly settled: boolean; readonly pending: number }>;
}

/** The extension of a `silas.*` receipt payload that marks it as the
 * autopilot's own work. */
export function autopilotReceiptFields(ruleId: SilasAutopilotRuleId): {
  readonly rule_id: SilasAutopilotRuleId;
  readonly source: string;
} {
  return { rule_id: ruleId, source: AUTOPILOT_SOURCE };
}

export function createSilasAutopilotOps(deps: SilasAutopilotOpsDeps): SilasAutopilotOpsHandle {
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

  // The in-flight background producers the assembly drains at shutdown
  // (issue #243 R2-H9). A producer is registered here and removed when it
  // settles; `drain` joins them, it never asserts they ceased.
  const producers = new Set<Promise<unknown>>();
  const ownProducer = (run: Promise<unknown>): void => {
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    producers.add(settled);
    void settled.then(() => producers.delete(settled));
  };
  const drain = async (): Promise<{ readonly settled: boolean; readonly pending: number }> => {
    while (producers.size > 0) {
      await Promise.allSettled([...producers]);
    }
    return { settled: producers.size === 0, pending: producers.size };
  };

  /** A stopped service never starts a new producer (issue #243 R2-H9). The
   * stop signal is what aborts a producer already queued in the pacing gate;
   * this is the synchronous refusal at the accepted boundary. */
  const requireNotStopping = (label: string): void => {
    if (deps.stopSignal?.aborted === true) {
      throw new Error(`the service is stopping — the ${label} is left for LLM Silas`);
    }
  };

  /** Verification ownership re-read at the writer's own boundary (issue #243
   * R2-H2): digest publication can be stale by the time a directive or
   * re-brief is admitted. */
  const requireNoUnsettledVerification = (jobId: string, label: string): void => {
    if (deps.ledger.hasUnsettledVerificationRun(jobId)) {
      throw new Error(`a verification is already in flight on this lane — the ${label} is left for LLM Silas`);
    }
  };

  /** Owner rules 3/5 writer admission: a live review whose candidate is
   * still current REFUSES the writer (the branch stays frozen until the
   * verdict); a review the gate admits is superseded only afterwards. The
   * autopilot's own refusal (a typed `ReviewInProgressError`) is rethrown
   * with the row's disposition named — the deterministic pass counts it as
   * a failed action and leaves the row for LLM Silas. */
  const requireWriterAdmissible = (jobId: string, label: string): void => {
    try {
      deps.wave.assertWriterAdmissible(jobId);
    } catch (error) {
      if (error instanceof ReviewInProgressError) {
        throw new Error(`a live review owns this lane — the ${label} is left for LLM Silas: ${error.message}`);
      }
      throw error;
    }
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
    readonly hold?: DecisionHoldTriple;
  }): Promise<void> => {
    requireNotStopping('PR registration');
    // The FINAL conditional mutation boundary (issue #243 R2-H5): re-prove
    // eligibility, ownership fences, the decision-hold coverage and the
    // absent link after every awaited lookup/admission seam. The service's
    // recordPr/setJobPr would otherwise overwrite a link a concurrent writer
    // landed while this decision was in flight.
    const job = deps.ledger.getJob(input.jobId);
    if (job === null) throw new Error(`job "${input.jobId}" not found`);
    const eligible = reviewEligible(deps.ledger, input.jobId);
    if (eligible !== null) throw new Error(eligible);
    if (job.prUrl !== null) throw new Error(`job "${input.jobId}" already carries a PR — refusing to overwrite the link`);
    const hold = input.hold ?? deliveredPrRegisterHold(deps.ledger, input.jobId);
    const fence = fencesHold(deps.ledger, input.jobId, hold);
    if (fence !== null) throw new Error(fence);
    requireNoUnsettledVerification(input.jobId, 'PR registration');
    const linked = deps.dispatch.recordPr(input.jobId, input.url);
    deps.ledger.appendCustomEvent({
      kind: 'silas.pr-registered',
      jobId: input.jobId,
      payload: { url: linked.prUrl, ...autopilotReceiptFields(input.ruleId) },
    });
  };

  const triggerReview = async (input: {
    readonly jobId: string;
    readonly ruleId: SilasAutopilotRuleId;
    readonly sourceRoundId?: string;
    readonly targetRef?: string;
    readonly boundDeliveredSha?: string;
  }): Promise<void> => {
    requireNotStopping('review request');
    let targetRef = input.targetRef;
    let boundDeliveredSha = input.boundDeliveredSha;
    if (input.sourceRoundId !== undefined) {
      // Re-prove the clean-abort proof at the request boundary exactly as the
      // HTTP endpoint does, and bind the ORIGINALLY proved head A (issue #243
      // R2-H4). A newer delivery B must never be re-read and bound under A's
      // abort provenance — the freeze guard then validates A, not B.
      const round = deps.ledger.getRound(input.sourceRoundId);
      const proof = deps.ledger.latestRoundEvent(input.sourceRoundId, 'round.perkins-incomplete');
      const reason = typeof proof?.payload === 'object' && proof.payload !== null
        ? (proof.payload as { reason?: unknown }).reason
        : null;
      const newestRound = deps.ledger.listRounds(input.jobId).at(-1);
      const deliveredEvent = deps.ledger.latestJobEvent(input.jobId, 'job.delivered');
      const sha = deliveredEvent === null ? null : deliveredTargetSha(deliveredEvent);
      if (
        round?.jobId !== input.jobId || round.status !== 'aborted' || newestRound?.id !== input.sourceRoundId ||
        sha === null || sha !== round.targetRef ||
        (reason !== 'service_restart' && reason !== 'service_restart_missing_review_lane')
      ) {
        throw new Error(
          'the clean-abort source round is not the latest service-restart abort on the unchanged delivered head — re-arm refused',
        );
      }
      if (input.targetRef !== undefined && input.targetRef !== sha) {
        throw new Error('the proved clean-abort head moved during admission — refusing to bind a different head');
      }
      targetRef = sha;
      boundDeliveredSha = sha;
    }
    const requestInput: ReviewRequestInput = {
      jobId: input.jobId,
      ...(targetRef === undefined ? {} : { targetRef }),
      ...(boundDeliveredSha === undefined ? {} : { boundDeliveredSha }),
    };
    // Issue #243 R2-M1: await ADMISSION (the same await the HTTP endpoint
    // performs), never the long review turn. The suppression receipt lands
    // before this pass returns, so the recomputed digest no longer offers the
    // row and no fallback/model wake burns on an already-admitted round.
    let outcome: ReviewRequestOutcome;
    try {
      outcome = await deps.wave.requestReview(requestInput);
    } catch (error) {
      if (error instanceof BranchBusyError) {
        deps.ledger.appendCustomEvent({
          kind: 'silas.review-deferred',
          jobId: input.jobId,
          payload: {
            phase: error.phase,
            blockers: error.refusal().blockers,
            ...(input.sourceRoundId === undefined ? {} : { source_round_id: input.sourceRoundId }),
            ...autopilotReceiptFields(input.ruleId),
          },
        });
        return;
      }
      throw error;
    }
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
    // The long review turn stays backgrounded exactly as the endpoint's
    // tracked run does: the pass is bounded after admission.
    background('review turn', input.jobId, outcome.run);
  };

  const sendDirective = async (input: {
    readonly jobId: string;
    readonly directive: string;
    readonly ruleId: SilasAutopilotRuleId;
    readonly blockerFingerprint?: string;
    readonly sourceRoundId?: string;
  }): Promise<void> => {
    // Owner rules 3/5 writer admission (issue #243 H1), checked in the SAME
    // synchronous tick as the durable intent below — the endpoint's own
    // gate. `clearLaneForWriter` supersedes unconditionally; it does NOT
    // establish permission, so a live review whose candidate is still
    // current must refuse the writer here (the row then stays for LLM
    // Silas). A review made obsolete by a pending material correction is
    // admitted by this same gate.
    requireNotStopping('directive');
    requireWriterAdmissible(input.jobId, 'directive');
    requireNoUnsettledVerification(input.jobId, 'directive');
    const begun = deps.ledger.beginDirectiveIntent({
      jobId: input.jobId,
      directive: input.directive,
      holder: 'silas-ops',
      ...(input.blockerFingerprint === undefined ? {} : { blockerFingerprint: input.blockerFingerprint }),
    });
    const intent = begun.record;
    const contract = deps.ledger.effectiveContract(input.jobId)?.text ?? null;
    // Owner rule 4 (issue #243 H3): the approved material amendments this
    // lane has not delivered travel ONCE with this request — rendered from
    // the amendment set of the SAME tick as the intent's revision stamp, so
    // the delivery that recordFollowUpDelivery stamps is the revision the
    // worker actually received.
    const workRevision = intent.workRevision ?? 0;
    const deliveredRevision = deps.ledger.workRevisionState(input.jobId).delivered;
    const amendmentsAtIntent = deps.ledger.listJobAmendments(input.jobId);
    const continuation = renderRevisionContinuation({
      jobId: input.jobId,
      revision: workRevision,
      deliveredRevision,
      pending: pendingMaterialAmendments(amendmentsAtIntent, deliveredRevision, workRevision),
      supersededBy: amendmentSupersessions(amendmentsAtIntent),
    });
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
      let delivery: Awaited<ReturnType<typeof routeFixDirectiveToMinion>>;
      try {
        delivery = await routeFixDirectiveToMinion({
          registry: deps.registry,
          ledger: deps.ledger,
          worktrees: deps.worktrees,
          jobId: input.jobId,
          directive: input.directive,
          contract,
          // Owner rule 4: a live or resumed session receives the pending
          // amendment bodies; a fresh session reads them in its effective
          // contract and receives the revision note instead.
          ...(continuation === ''
            ? {}
            : { continuation: { block: continuation, freshNote: renderFreshRevisionNote(workRevision) } }),
          // Service-stop ownership (issue #243 R2-H9): the stop signal aborts
          // a QUEUED admission wait so a stopped service never starts this
          // producer, and lets a running prompt settle. It never claims
          // cessation — an aborted turn reports unknown admission below.
          signal: deps.stopSignal ?? new AbortController().signal,
          owner: 'silas-ops',
          ...(deps.workerGate === undefined ? {} : { workerGate: deps.workerGate }),
          ...(deps.retrySettlement === undefined ? {} : { retrySettlement: deps.retrySettlement }),
          ...(deps.lessons === undefined ? {} : { lessons: deps.lessons }),
          ...(deps.parentTools === undefined ? {} : { parentTools: deps.parentTools }),
        });
      } catch (error) {
        // The turn errored with no positive outcome (a stop-abort of a queued
        // admission seat, a runtime interruption). The prompt may or may not
        // have been handed to a worker: keep the request live for
        // reconciliation, never fabricate a no-effect failure.
        deps.ledger.recordDirectiveReconcile({
          requestId: intent.requestId,
          note: `turn interrupted before admission evidence: ${String(error).slice(0, 300)}`,
        });
        return;
      }
      if (!delivery.delivered) {
        if (delivery.admission === 'unknown') {
          // The prompt may already have run (cancellation or a spent retry
          // AFTER the prompt call). Marking the request failed would release
          // the single-writer guard while a prior writer's recovery may
          // still be live — keep it live with a durable reconcile note
          // (issue #243 H2; the endpoint's own rule).
          deps.ledger.recordDirectiveReconcile({
            requestId: intent.requestId,
            note:
              `turn interrupted with unknown admission: ${delivery.note ?? 'no proof of non-delivery'}` +
              ' — no delivery recorded; reconcile settlement/cessation before releasing the request',
          });
          return;
        }
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
        workRevision,
      });
      deps.ledger.recordDirectiveDelivery({ requestId: intent.requestId, eventSeq: followUp.eventSeq });
    })();
    background('directive', input.jobId, run);
    ownProducer(run);
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
    // Owner rules 3/5 writer admission (issue #243 H1), in the SAME
    // synchronous tick as the request below — the endpoint's own gate.
    // `clearLaneForWriter` supersedes unconditionally; it does NOT establish
    // permission, so a live review whose candidate is still current must
    // refuse the writer here (the row then stays for LLM Silas).
    requireNotStopping('re-brief');
    requireWriterAdmissible(input.jobId, 're-brief');
    await deps.wave.clearLaneForWriter({ jobId: input.jobId, writer: `re-brief for job ${input.jobId}` });
    // Re-prove admission after the awaited supersession (the endpoint does
    // the same): a review that armed in the window between the gate and the
    // marker write must refuse the re-brief, never run alongside it.
    requireWriterAdmissible(input.jobId, 're-brief');
    requireNoUnsettledVerification(input.jobId, 're-brief');
    requireNotStopping('re-brief');
    // Issue #243 R2-H3: a newer re-brief admitted during the awaited
    // supersession must NEVER be replaced by this stale request. The marker
    // upsert would otherwise overwrite the newer generation; refuse instead.
    if (deps.ledger.listPendingRebriefs({ jobId: input.jobId }).length > 0) {
      throw new Error(
        `job "${input.jobId}" already has a newer re-brief request pending — refusing to replace it`,
      );
    }
    const contract = deps.ledger.effectiveContract(input.jobId)?.text ?? job.briefing;
    // The markers are durable BEFORE any worker exists (restart-safe), and
    // they carry the firing rule AND the autopilot source (issue #243 M3),
    // so the durable `silas.rebrief` receipt replays both even across a
    // restart mid-turn.
    const markers = deps.ledger.beginPendingRebrief({
      jobId: input.jobId,
      note: input.note,
      briefing: contract,
      ruleId: input.ruleId,
      sourceRoundId: input.sourceRoundId,
      source: AUTOPILOT_SOURCE,
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
          // Service-stop ownership (issue #243 R2-H9): the stop signal aborts
          // a QUEUED re-brief admission wait so a stopped service never starts
          // this producer.
          ...(deps.stopSignal === undefined ? {} : { signal: deps.stopSignal }),
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
    ownProducer(run);
  };

  const releaseLane = async (input: {
    readonly jobId: string;
    readonly ruleId: SilasAutopilotRuleId;
    readonly hold?: DecisionHoldTriple;
  }): Promise<void> => {
    requireNotStopping('sweep-ack release');
    const job = deps.ledger.getJob(input.jobId);
    if (job === null) throw new Error(`job "${input.jobId}" not found`);
    if (!isJobTerminal(job.status)) {
      throw new Error(`job "${input.jobId}" is ${job.status} — sweep-ack releases only terminal lanes`);
    }
    // Final mutation boundary (issue #243 R2-H1): re-prove the decision-hold
    // coverage immediately before the release, after every awaited seam.
    const covered = decisionHold(deps.ledger, input.jobId, input.hold ?? sweepAckHold(job));
    if (covered !== null) throw new Error(covered);
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

  return { listOpenPrsForHead, registerPr, triggerReview, sendDirective, sendRebrief, releaseLane, drain };
}
