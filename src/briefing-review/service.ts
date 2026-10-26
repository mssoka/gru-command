import { spawnSync } from 'node:child_process';
import type { LedgerApi } from '../ledger/api.js';
import type { NotificationCenter } from '../notifications/center.js';
import type { BundledWorkflowRuntime } from '../workflows/runtime.js';
import {
  briefingReviewBoardView,
  EMPTY_BRIEFING_REVIEW_COUNTS,
  readBriefingReviewCounts,
  type BriefingReviewBoardCounts,
  type BriefingReviewBoardView,
} from './board.js';
import {
  armedByBriefingSha,
  BRIEFING_REVIEW_OBLIGATION_ACTION,
  armedChain,
  armedGenerations,
  BRIEFING_REVIEW_ARMED,
  BRIEFING_REVIEW_PUSHBACK,
  BRIEFING_REVIEW_REFUSED,
  BRIEFING_REVIEW_VERDICT,
  caughtByRevision,
  decisiveVerdict,
  latestLensVerdict,
  reviewPushbacks,
  reviewVerdicts,
  trailingChangesNeeded,
  type ArmedReview,
  type PushbackEvent,
} from './events.js';
import {
  briefingReviewGate,
  type BriefingReviewChainReview,
  type BriefingReviewProvenance,
  type BriefingReviewRequestedProvenance,
} from './gate.js';
import { BRIEFING_REVIEW_HELPER, loadBriefingReviewHelper, type BriefingReviewHelper } from './helper.js';
import {
  assertFindingEvidence,
  BRIEFING_REVIEW_OWNER_ESCALATION,
  BRIEFING_REVIEW_ROUND_CAP,
  BriefingReviewError,
  briefingReviewIdentity,
  canonicalFindings,
  lensJobId,
  markedBriefing,
  parseCommissionRequest,
  parsePushbackRequest,
  parseResultRequest,
  reviewedBriefing,
  TIER_LENSES,
  tierRank,
  unionLenses,
  type BriefingReviewLens,
  type BriefingReviewStage,
  type BriefingReviewTier,
  type BriefingReviewVerdict,
} from './types.js';

/**
 * Nefario, the pre-dispatch briefing review (GH-505).
 *
 * Gru commissions a review of one exact briefing. The review arms durably,
 * dispatches one zero-context read-only planning job per lens, and aggregates
 * the lenses' evidence-bound results into one decisive verdict. The review is
 * binding on readiness and advisory on content: it can hold a dispatch back,
 * never change scope or overrule an owner ruling.
 */

export const BRIEFING_REVIEW_NOTIFICATION_KIND = 'briefing-review-verdict';

export interface BriefingReviewConfig {
  readonly enabled: boolean;
  readonly stage: BriefingReviewStage;
}

export type BriefingReviewLedger = Pick<
  LedgerApi,
  | 'listEventsAfter'
  | 'latestEventByPayloadField'
  | 'getJob'
  | 'appendCustomEvent'
  | 'findReportObligation'
  | 'settleObligation'
>;

export interface BriefingReviewLensJobView {
  readonly lens: string;
  readonly jobId: string;
  /** The ledger job status, or `missing` when no row exists. */
  readonly status: string;
}

export interface BriefingReviewCommissionResult {
  readonly reviewId: string;
  readonly commissionKey: string;
  readonly briefingSha256: string;
  readonly round: number;
  readonly generation: number;
  readonly tier: BriefingReviewTier;
  readonly lenses: readonly string[];
  readonly headSha: string | null;
  readonly jobs: readonly BriefingReviewLensJobView[];
  readonly dispatched: boolean;
  readonly upgraded: boolean;
}

export interface BriefingReviewCommissionOutcome {
  /** 202 when a lens job was newly dispatched, 200 on a converged replay. */
  readonly status: 200 | 202;
  readonly body: BriefingReviewCommissionResult;
}

export interface BriefingReviewResultOutcome {
  readonly reviewId: string;
  readonly lens: string;
  readonly verdict: BriefingReviewVerdict;
  readonly aggregate: BriefingReviewVerdict | null;
  readonly decisive: boolean;
  readonly caught: number;
  readonly jobs: readonly BriefingReviewLensJobView[];
}

export interface BriefingReviewPushbackOutcome {
  readonly reviewId: string;
  readonly generation: number;
  readonly reason: string;
  readonly by: string;
}

export interface BriefingReviewDispatchInput {
  readonly jobId: string;
  readonly repoPath: string;
  readonly title: string;
  readonly briefing: string;
  readonly deliverable: 'investigation';
  readonly readOnly: true;
}

export interface BriefingReviewServiceOptions {
  readonly config: BriefingReviewConfig;
  readonly ledger: BriefingReviewLedger;
  readonly notifications: Pick<NotificationCenter, 'post'>;
  /** The normal dispatch path (POST /api/dispatch's service). */
  readonly dispatch: (input: BriefingReviewDispatchInput) => Promise<unknown>;
  readonly workflow?: () => BundledWorkflowRuntime;
  /** The service's local base URL, named in the lens briefing. */
  readonly apiBase?: () => string | null;
  /** The repository head at commission; null when it cannot be resolved (a
   * commission is never refused for that). */
  readonly headSha?: (repoPath: string) => string | null;
  readonly now?: () => Date;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/** The repository head at commission time, or null — never a refusal. */
function resolveHeadSha(repoPath: string): string | null {
  const result = spawnSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf-8' });
  if (result.error !== undefined || result.status !== 0) return null;
  const rev = result.stdout.trim();
  return /^[0-9a-f]{40,64}$/u.test(rev) ? rev : null;
}

function disabled(): BriefingReviewError {
  return new BriefingReviewError(
    'briefing_review_disabled',
    'briefing review is disabled on this install ([briefing_review] enabled = false); no review is commissioned and no dispatch is held by one',
    503,
  );
}

export class BriefingReviewService {
  constructor(private readonly options: BriefingReviewServiceOptions) {}

  private get ledger(): BriefingReviewLedger {
    return this.options.ledger;
  }

  private helper(): BriefingReviewHelper {
    return loadBriefingReviewHelper(this.options.workflow);
  }

  private jobs(armed: ArmedReview): readonly BriefingReviewLensJobView[] {
    return armed.lenses.map((lens) => {
      const jobId = lensJobId(armed.reviewId, lens);
      return { lens, jobId, status: this.ledger.getJob(jobId)?.status ?? 'missing' };
    });
  }

  private view(armed: ArmedReview, input: {
    readonly dispatched: boolean;
    readonly upgraded: boolean;
    readonly tier: BriefingReviewTier;
    readonly generation: number;
  }): BriefingReviewCommissionResult {
    return {
      reviewId: armed.reviewId,
      commissionKey: armed.commissionKey,
      briefingSha256: armed.briefingSha256,
      round: armed.round,
      generation: input.generation,
      tier: input.tier,
      lenses: armed.lenses,
      headSha: armed.headSha,
      jobs: this.jobs(armed),
      dispatched: input.dispatched,
      upgraded: input.upgraded,
    };
  }

  /** The ledger's newest armed record as this service reads it (fresh from
   * the durable events, never a cached copy). */
  private latest(reviewId: string): ArmedReview | null {
    return armedGenerations(this.ledger, reviewId).at(-1) ?? null;
  }

  private arm(input: {
    readonly reviewId: string;
    readonly commissionKey: string;
    readonly chainKey: string;
    readonly briefingSha256: string;
    readonly repoPath: string;
    readonly title: string;
    readonly tier: BriefingReviewTier;
    readonly justification: string;
    readonly round: number;
    readonly generation: number;
    readonly lenses: readonly BriefingReviewLens[];
    readonly headSha: string | null;
    readonly upgradedFrom: number | null;
  }): ArmedReview {
    this.ledger.appendCustomEvent({
      kind: BRIEFING_REVIEW_ARMED,
      payload: {
        review_id: input.reviewId,
        commission_key: input.commissionKey,
        chain_key: input.chainKey,
        briefing_sha_256: input.briefingSha256,
        repo_path: input.repoPath,
        title: input.title,
        tier: input.tier,
        justification: input.justification,
        round: input.round,
        generation: input.generation,
        lenses: input.lenses,
        head_sha: input.headSha,
        ...(input.upgradedFrom === null ? {} : { upgraded_from: input.upgradedFrom }),
      },
    });
    const armed = this.latest(input.reviewId);
    if (armed === null) {
      throw new BriefingReviewError(
        'briefing_review_not_commissioned',
        `the armed record for review ${input.reviewId} could not be read back after it was written`,
        409,
      );
    }
    return armed;
  }

  /** One lens briefing: the marked briefing verbatim, this lens's question and
   * verified helper section, the identity stamp and the result contract. No
   * consult material, no other lens's findings, no prior round. */
  private lensBriefing(input: {
    readonly armed: ArmedReview;
    readonly lens: ArmedReview['lenses'][number];
    readonly briefing: string;
    readonly helper: BriefingReviewHelper;
  }): string {
    const { armed, lens, briefing, helper } = input;
    const api = this.options.apiBase?.() ?? null;
    const endpoint = `${api ?? '<the service API>'}${'/api/briefing-review/result'}`;
    const jobId = lensJobId(armed.reviewId, lens);
    const body = JSON.stringify({
      repoPath: armed.repoPath,
      briefingSha256: armed.briefingSha256,
      jobId,
      lens,
      verdict: 'READY or CHANGES-NEEDED',
      findings: [{
        code: 'stable-code',
        severity: 'blocking or advisory',
        evidence: 'an exact span copied from the briefing between the markers',
        why_it_blocks: 'what a lane starting from this briefing would get wrong',
      }],
    });
    return [
      `Nefario briefing review — you are the ${lens} lens.`,
      'You stress-test one draft heist briefing before any minion builds against it. You are a',
      'zero-context reviewer: you receive this briefing, this worktree and this lens helper, and',
      'nothing else. You never change the briefing, the repository or the scope.',
      '',
      'Binding (exact; never change it):',
      `- repoPath: ${armed.repoPath}`,
      `- reviewId: ${armed.reviewId}`,
      `- commissionKey: ${armed.commissionKey}`,
      `- round: ${String(armed.round)} (generation ${String(armed.generation)})`,
      `- lens: ${lens}`,
      `- lens job id: ${jobId}`,
      `- briefingSha256: ${armed.briefingSha256}`,
      '',
      'The heist briefing under review, verbatim, between the review markers:',
      '',
      markedBriefing(briefing, armed.reviewId),
      '',
      `GC briefing-review helper (${helper.packageId} ${BRIEFING_REVIEW_HELPER}, sha256 ${helper.sha256}):`,
      '',
      helper.preamble,
      '',
      helper.lensSection(lens),
      '',
      'Submit your result:',
      `- POST ${endpoint}`,
      '- Authenticate with the instance [auth] token as `Authorization: Bearer <token>` (read it from',
      '  the service instance config; never print it).',
      '- Body (exact shape; every field of every finding, nothing else):',
      `  ${body}`,
      '- A 400 names the finding to fix: fix it and submit the corrected result again. An identical',
      '  retry is safe and returns the same answer with no second record.',
      '',
      'Standing orders (this brief is READ-ONLY): work only inside this tree; change nothing,',
      'commit nothing, push nothing, open no pull request, and implement nothing — an unmodified',
      'tree is the expected result. Your deliverable is the submitted result and a completion report',
      `naming review ${armed.reviewId}, your lens and your verdict.`,
    ].join('\n');
  }

  /** Dispatch every armed lens whose deterministic job row does not exist yet
   * (crash repair) and report whether anything new was dispatched. */
  private async dispatchLenses(input: {
    readonly armed: ArmedReview;
    readonly briefing: string;
    readonly helper: BriefingReviewHelper;
  }): Promise<boolean> {
    let dispatched = false;
    for (const lens of input.armed.lenses) {
      const jobId = lensJobId(input.armed.reviewId, lens);
      if (this.ledger.getJob(jobId) !== null) continue;
      const title = `Nefario ${lens} review: ${input.armed.title}`.slice(0, 200);
      await this.options.dispatch({
        jobId,
        repoPath: input.armed.repoPath,
        title,
        briefing: this.lensBriefing({ armed: input.armed, lens, briefing: input.briefing, helper: input.helper }),
        deliverable: 'investigation',
        readOnly: true,
      });
      dispatched = true;
    }
    return dispatched;
  }

  async commission(value: unknown): Promise<BriefingReviewCommissionOutcome> {
    if (!this.options.config.enabled) throw disabled();
    const request = parseCommissionRequest(value);
    // The helper is loaded before anything durable: a package without the
    // verified lens method dispatches nothing (and creates nothing).
    const helper = this.helper();
    const identity = briefingReviewIdentity({ ...request });
    const existing = this.latest(identity.reviewId);
    if (existing !== null) {
      const decided = decisiveVerdict(reviewVerdicts(this.ledger, existing.reviewId), existing.generation) !== null;
      const raising = tierRank(request.tier) > tierRank(existing.tier);
      if (raising && decided) {
        throw new BriefingReviewError(
          'briefing_review_decided',
          `review ${existing.reviewId} already holds a decisive ${existing.tier} verdict; a tier raise cannot re-open it — ` +
            'revise the briefing (CHANGES-NEEDED) or dispatch it (READY), or record a push-back',
          409,
        );
      }
      if (!raising) {
        // Convergence by reviewId: the newest armed generation supplies the
        // effective tier and lenses; a lower or equal tier never downgrades.
        const dispatched = await this.dispatchLenses({ armed: existing, briefing: request.briefing, helper });
        return {
          status: dispatched ? 202 : 200,
          body: this.view(existing, {
            dispatched,
            upgraded: false,
            tier: existing.tier,
            generation: existing.generation,
          }),
        };
      }
      const lenses = unionLenses(existing.lenses, TIER_LENSES[request.tier]);
      const raised = this.arm({
        reviewId: existing.reviewId,
        commissionKey: identity.commissionKey,
        chainKey: existing.chainKey,
        briefingSha256: existing.briefingSha256,
        repoPath: existing.repoPath,
        title: existing.title,
        tier: request.tier,
        justification: request.justification,
        round: existing.round,
        generation: existing.generation + 1,
        lenses: [...lenses],
        headSha: existing.headSha,
        upgradedFrom: existing.generation,
      });
      const dispatched = await this.dispatchLenses({ armed: raised, briefing: request.briefing, helper });
      return {
        status: dispatched ? 202 : 200,
        body: this.view(raised, {
          dispatched,
          upgraded: true,
          tier: raised.tier,
          generation: raised.generation,
        }),
      };
    }
    const trailing = trailingChangesNeeded(this.ledger, identity.chainKey);
    if (trailing >= BRIEFING_REVIEW_ROUND_CAP) {
      throw new BriefingReviewError(
        'briefing_review_round_cap',
        `this heist's last ${String(trailing)} rounds all reached CHANGES-NEEDED; another revision is a disagreement, not a drafting problem — ` +
          `escalate to the owner through ${BRIEFING_REVIEW_OWNER_ESCALATION} instead of revising again`,
        409,
      );
    }
    const round = new Set(armedChain(this.ledger, identity.chainKey).map((record) => record.reviewId)).size + 1;
    const armed = this.arm({
      reviewId: identity.reviewId,
      commissionKey: identity.commissionKey,
      chainKey: identity.chainKey,
      briefingSha256: identity.briefingSha256,
      repoPath: request.repoPath,
      title: request.title,
      tier: request.tier,
      justification: request.justification,
      round,
      generation: 1,
      lenses: [...TIER_LENSES[request.tier]],
      headSha: (this.options.headSha ?? resolveHeadSha)(request.repoPath),
      upgradedFrom: null,
    });
    const dispatched = await this.dispatchLenses({ armed, briefing: request.briefing, helper });
    return {
      status: dispatched ? 202 : 200,
      body: this.view(armed, { dispatched, upgraded: false, tier: armed.tier, generation: armed.generation }),
    };
  }

  /** Accept one lens result, decide whether it settles the review, and record
   * it exactly once. An identical retry converges; a different one is 409. */
  submitResult(value: unknown): BriefingReviewResultOutcome {
    const request = parseResultRequest(value);
    const armed = armedByBriefingSha(this.ledger, request.briefingSha256, request.repoPath);
    if (armed === null) {
      throw new BriefingReviewError(
        'briefing_review_not_commissioned',
        `no briefing review is armed for briefing ${request.briefingSha256} in ${request.repoPath}; commission one with POST /api/briefing-review`,
        409,
      );
    }
    if (!armed.lenses.includes(request.lens)) {
      throw new BriefingReviewError(
        'briefing_review_lens_unknown',
        `lens ${request.lens} is not in the armed lens set (${armed.lenses.join(', ')}) for review ${armed.reviewId}`,
        400,
      );
    }
    const expectedJobId = lensJobId(armed.reviewId, request.lens);
    if (request.jobId !== expectedJobId) {
      throw new BriefingReviewError(
        'briefing_review_job_mismatch',
        `${request.lens}'s deterministic lens job for review ${armed.reviewId} is ${expectedJobId}, not ${request.jobId}`,
        409,
      );
    }
    const job = this.ledger.getJob(expectedJobId);
    if (job === null) {
      throw new BriefingReviewError(
        'briefing_review_not_dispatched',
        `lens job ${expectedJobId} has no ledger row; the commission did not dispatch it`,
        409,
      );
    }
    const reviewed = reviewedBriefing(job.briefing, armed.reviewId);
    if (reviewed === null) {
      throw new BriefingReviewError(
        'briefing_review_not_dispatched',
        `lens job ${expectedJobId} carries no briefing between review ${armed.reviewId}'s markers; nothing can be validated against it`,
        409,
      );
    }
    assertFindingEvidence({ findings: request.findings, verdict: request.verdict, reviewed });
    const verdicts = reviewVerdicts(this.ledger, armed.reviewId);
    const existing = latestLensVerdict(verdicts, request.lens);
    if (existing !== null) {
      if (existing.verdict === request.verdict && canonicalFindings(existing.findings) === canonicalFindings(request.findings)) {
        return this.resultView(armed, request.lens, request.verdict, existing.aggregate, existing.decisive, existing.caught);
      }
      throw new BriefingReviewError(
        'briefing_review_result_conflict',
        `review ${armed.reviewId} already holds a different ${request.lens} result; a lens reports one verdict per review`,
        409,
      );
    }
    // One decisive verdict per (reviewId, generation): a later lens result is
    // recorded but never re-decides a review that already has one.
    const alreadyDecided = decisiveVerdict(verdicts, armed.generation) !== null;
    const othersReady = armed.lenses
      .filter((lens) => lens !== request.lens)
      .every((lens) => latestLensVerdict(verdicts, lens)?.verdict === 'READY');
    const aggregate: BriefingReviewVerdict | null = alreadyDecided
      ? null
      : request.verdict === 'CHANGES-NEEDED'
        ? 'CHANGES-NEEDED'
        : othersReady
          ? 'READY'
          : null;
    const isDecisive = aggregate !== null;
    const caught = aggregate === 'READY'
      ? caughtByRevision({ ledger: this.ledger, chainKey: armed.chainKey, reviewId: armed.reviewId })
      : 0;
    const event = this.ledger.appendCustomEvent({
      kind: BRIEFING_REVIEW_VERDICT,
      jobId: expectedJobId,
      lens: request.lens,
      payload: {
        review_id: armed.reviewId,
        chain_key: armed.chainKey,
        briefing_sha_256: armed.briefingSha256,
        lens: request.lens,
        lens_verdict: request.verdict,
        findings: request.findings.map((finding) => ({
          code: finding.code,
          severity: finding.severity,
          evidence: finding.evidence,
          why_it_blocks: finding.whyItBlocks,
        })),
        round: armed.round,
        generation: armed.generation,
        decisive: isDecisive,
        aggregate,
        caught,
      },
    });
    if (isDecisive) this.announce(armed, { verdict: aggregate, caught });
    this.settleLensReport(armed, expectedJobId, event.seq);
    return this.resultView(armed, request.lens, request.verdict, aggregate, isDecisive, caught);
  }

  private resultView(
    armed: ArmedReview,
    lens: BriefingReviewLens,
    verdict: BriefingReviewVerdict,
    aggregate: BriefingReviewVerdict | null,
    decisive: boolean,
    caught: number,
  ): BriefingReviewResultOutcome {
    return {
      reviewId: armed.reviewId,
      lens,
      verdict,
      aggregate,
      decisive,
      caught,
      jobs: this.jobs(armed),
    };
  }

  /** One notification per decisive (reviewId, generation); the id makes a
   * converged retry silent because the center returns the existing row. */
  private announce(armed: ArmedReview, input: { readonly verdict: BriefingReviewVerdict; readonly caught: number }): void {
    const jobs = armed.lenses.map((lens) => `${lens} (${lensJobId(armed.reviewId, lens)})`).join(', ');
    this.options.notifications.post({
      id: `briefing-review:${armed.reviewId}:${String(armed.generation)}`,
      kind: BRIEFING_REVIEW_NOTIFICATION_KIND,
      routing: 'action-required',
      // The notification model carries two severities: CHANGES-NEEDED is the
      // loud one, READY is informational.
      severity: input.verdict === 'READY' ? 'info' : 'error',
      title: `Briefing review ${input.verdict} — round ${String(armed.round)}, ${armed.tier} tier`,
      detail: [
        `${input.verdict} for review ${armed.reviewId} (round ${String(armed.round)}, generation ${String(armed.generation)}, ${armed.tier} tier).`,
        `Briefing sha256 ${armed.briefingSha256}; heist "${armed.title}" in ${armed.repoPath}.`,
        `Lens jobs: ${jobs}.`,
        input.verdict === 'READY'
          ? `This revision caught ${String(input.caught)} blocking finding(s) the previous round would have sent to a lane.`
          : 'Fix the briefing and re-commission at this tier, escalate to the owner through POST /api/notifications/needs-owner (reserved class scope-design), or record a push-back with POST /api/briefing-review/pushback.',
        'The review is binding on readiness and advisory on content; it never changes scope or overrides an owner ruling.',
      ].join('\n'),
    });
  }

  /** A lens result answers its own job's report debt, so a commission never
   * leaves one action-required row per lens for Gru. */
  private settleLensReport(armed: ArmedReview, jobId: string, evidenceEventSeq: number): void {
    try {
      const debt = this.ledger.findReportObligation(jobId);
      if (debt === null) return;
      if (debt.state !== 'open' && debt.state !== 'waiting' && debt.state !== 'suspended') return;
      this.ledger.settleObligation({
        obligationId: debt.id,
        settlement: {
          kind: 'executed-action',
          action: BRIEFING_REVIEW_OBLIGATION_ACTION,
          evidenceEventSeq,
          evidenceEventKind: BRIEFING_REVIEW_VERDICT,
        },
      });
    } catch (error) {
      // The verdict is durable; a bookkeeping settle that failed is reported,
      // never allowed to un-accept an already-recorded result.
      this.options.log?.('error', 'briefing review could not settle its lens report debt', {
        review: armed.reviewId,
        job: jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Gru's third path: one durable reason that admits the exact sha at
   * stage 2 without claiming the review said READY. */
  pushback(value: unknown): BriefingReviewPushbackOutcome {
    const request = parsePushbackRequest(value);
    const armed = armedByBriefingSha(this.ledger, request.briefingSha256, request.repoPath);
    if (armed === null) {
      throw new BriefingReviewError(
        'briefing_review_not_commissioned',
        `no briefing review is armed for briefing ${request.briefingSha256} in ${request.repoPath}; there is nothing to push back`,
        409,
      );
    }
    const verdicts = reviewVerdicts(this.ledger, armed.reviewId);
    if (decisiveVerdict(verdicts, armed.generation)?.aggregate === 'READY') {
      throw new BriefingReviewError(
        'briefing_review_already_ready',
        `review ${armed.reviewId} is READY — dispatch it with its provenance instead of pushing back`,
        409,
      );
    }
    const existing = reviewPushbacks(this.ledger, armed.reviewId)
      .filter((record) => record.generation === armed.generation)
      .at(-1) ?? null;
    if (existing !== null) {
      if (existing.reason === request.reason) return this.pushbackView(armed, existing);
      throw new BriefingReviewError(
        'briefing_review_pushback_conflict',
        `review ${armed.reviewId} already holds a different push-back reason for generation ${String(armed.generation)}`,
        409,
      );
    }
    const event = this.ledger.appendCustomEvent({
      kind: BRIEFING_REVIEW_PUSHBACK,
      payload: {
        review_id: armed.reviewId,
        briefing_sha_256: armed.briefingSha256,
        generation: armed.generation,
        reason: request.reason,
        by: request.by,
      },
    });
    return this.pushbackView(armed, {
      reviewId: armed.reviewId,
      briefingSha256: armed.briefingSha256,
      generation: armed.generation,
      reason: request.reason,
      by: request.by,
      seq: event.seq,
      ts: event.ts,
    });
  }

  private pushbackView(armed: ArmedReview, record: PushbackEvent): BriefingReviewPushbackOutcome {
    return {
      reviewId: armed.reviewId,
      generation: record.generation,
      reason: record.reason,
      by: record.by,
    };
  }

  /** The dispatch gate: admits or refuses one dispatch and, for a stage-2
   * refusal, records the attempt before anything is created. */
  admitDispatch(input: {
    readonly jobId: string;
    readonly repoPath: string;
    readonly title: string;
    readonly briefing: string;
    readonly requested: BriefingReviewRequestedProvenance | undefined;
  }): BriefingReviewProvenance | null {
    if (!this.options.config.enabled) {
      // The stop state is the whole gate off: nothing to verify, nothing to
      // claim, nothing attached.
      if (input.requested !== undefined) {
        throw disabled();
      }
      return null;
    }
    const identity = briefingReviewIdentity({
      briefing: input.briefing,
      repoPath: input.repoPath,
      title: input.title,
      // The tier only scopes the commission key, which the gate never reads.
      tier: 'low',
    });
    const exact = this.latest(identity.reviewId);
    const verdicts = exact === null ? [] : reviewVerdicts(this.ledger, exact.reviewId);
    const exactVerdict = exact === null ? null : decisiveVerdict(verdicts, exact.generation)?.aggregate ?? null;
    const exactPushback = exact === null
      ? null
      : reviewPushbacks(this.ledger, exact.reviewId).filter((record) => record.generation === exact.generation).at(-1) ?? null;
    const chain = this.chainReviews(identity.chainKey);
    const outcome = briefingReviewGate({
      stage: this.options.config.stage,
      briefing: input.briefing,
      repoPath: input.repoPath,
      title: input.title,
      jobId: input.jobId,
      requested: input.requested,
      exact,
      exactVerdict,
      exactPushback,
      chain,
    });
    if (!outcome.admitted) {
      if (outcome.refusal !== null) {
        this.ledger.appendCustomEvent({
          kind: BRIEFING_REVIEW_REFUSED,
          jobId: input.jobId,
          payload: {
            repo_path: outcome.refusal.repoPath,
            title: outcome.refusal.title,
            briefing_sha_256: outcome.refusal.briefingSha256,
            job_id: outcome.refusal.jobId,
            tier: outcome.refusal.tier,
            reason: outcome.refusal.reason,
          },
        });
      }
      throw outcome.error;
    }
    return outcome.provenance;
  }

  /** Every review this heist's chain has armed, one entry per review (its
   * newest generation), oldest first. */
  private chainReviews(chainKey: string): readonly BriefingReviewChainReview[] {
    const order = [...new Set(armedChain(this.ledger, chainKey).map((record) => record.reviewId))];
    return order.flatMap((reviewId) => {
      const armed = this.latest(reviewId);
      if (armed === null) return [];
      const verdict = decisiveVerdict(reviewVerdicts(this.ledger, reviewId), armed.generation);
      return [{ reviewId, tier: armed.tier, round: armed.round, verdict: verdict?.aggregate ?? null }];
    });
  }

  /** The counts behind the cockpit's Nefario block. A disabled install sends a
   * zeroed block (the feature is deliberately off), never a misleading dashed
   * card. A read that throws propagates to the engine, which logs it and sends
   * null. */
  boardCounts(): BriefingReviewBoardCounts | null {
    if (!this.options.config.enabled) return EMPTY_BRIEFING_REVIEW_COUNTS;
    const now = (this.options.now ?? (() => new Date()))();
    return readBriefingReviewCounts(this.ledger, now);
  }

  /** The wire block, with the configured stage mapped to its literal. */
  boardView(): BriefingReviewBoardView | null {
    return briefingReviewBoardView({ counts: this.boardCounts(), stage: this.options.config.stage });
  }
}
