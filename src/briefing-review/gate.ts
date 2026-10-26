import type { ArmedReview, BriefingReviewRefusalReason, PushbackEvent } from './events.js';
import {
  BriefingReviewError,
  briefingSha256Of,
  invalidRequest,
  isBriefingReviewVerdict,
  type BriefingReviewProvenanceVerdict,
  type BriefingReviewStage,
  type BriefingReviewTier,
  type BriefingReviewVerdict,
} from './types.js';

/**
 * The dispatch gate (CAP-6): a pure decision over records someone else read.
 *
 * Stage 1 is advisory: a dispatch is never refused for review readiness, and
 * only a FALSE provenance claim is stopped. Stage 2 also refuses a high-tier
 * dispatch whose exact briefing sha has no READY review and no recorded
 * push-back. Medium and low tiers stay advisory in both stages; a heist with
 * no armed review at all is admitted (the server cannot infer an undeclared
 * tier — the role canon carries that obligation).
 */

export interface BriefingReviewRequestedProvenance {
  readonly rounds: number;
  readonly verdict: BriefingReviewVerdict;
  readonly briefingSha256: string;
}

/** What the job records as `briefing.review-dispatched`. */
export interface BriefingReviewProvenance {
  readonly reviewId: string;
  /** The exact briefing sha this review and this dispatch both name. */
  readonly briefingSha256: string;
  readonly round: number;
  readonly generation: number;
  readonly verdict: BriefingReviewProvenanceVerdict;
  readonly tier: BriefingReviewTier;
  readonly pushbackReason: string | null;
}

/** One review of this heist's chain, as the stage-2 fallback scan sees it. */
export interface BriefingReviewChainReview {
  readonly reviewId: string;
  readonly tier: BriefingReviewTier;
  readonly round: number;
  readonly verdict: BriefingReviewVerdict | null;
}

export interface BriefingReviewGateRefusal {
  readonly repoPath: string;
  readonly title: string;
  readonly briefingSha256: string;
  readonly jobId: string;
  readonly tier: BriefingReviewTier;
  readonly reason: BriefingReviewRefusalReason;
}

export interface BriefingReviewGateInput {
  readonly stage: BriefingReviewStage;
  readonly briefing: string;
  readonly repoPath: string;
  readonly title: string;
  readonly jobId: string;
  /** The optional `briefing_review` block the caller supplied. */
  readonly requested: BriefingReviewRequestedProvenance | undefined;
  /** The armed review for this exact briefing + repository, if any. */
  readonly exact: ArmedReview | null;
  /** That review's decisive aggregate verdict (any generation of it). */
  readonly exactVerdict: BriefingReviewVerdict | null;
  /** The current generation's recorded push-back, if any. */
  readonly exactPushback: PushbackEvent | null;
  /** Every review armed for this heist's chain (older rounds included). */
  readonly chain: readonly BriefingReviewChainReview[];
}

export type BriefingReviewGateResult =
  | { readonly admitted: true; readonly provenance: BriefingReviewProvenance | null }
  | { readonly admitted: false; readonly error: BriefingReviewError; readonly refusal: BriefingReviewGateRefusal | null };

function provenance(
  exact: ArmedReview,
  verdict: BriefingReviewProvenanceVerdict,
  pushbackReason: string | null,
): BriefingReviewProvenance {
  return {
    reviewId: exact.reviewId,
    briefingSha256: exact.briefingSha256,
    round: exact.round,
    generation: exact.generation,
    verdict,
    tier: exact.tier,
    pushbackReason,
  };
}

function refused(
  input: BriefingReviewGateInput,
  code: BriefingReviewError['code'],
  status: number,
  detail: string,
  reason: BriefingReviewRefusalReason | null,
): BriefingReviewGateResult {
  return {
    admitted: false,
    error: new BriefingReviewError(code, detail, status),
    refusal: reason === null
      ? null
      : {
          repoPath: input.repoPath,
          title: input.title,
          briefingSha256: briefingSha256Of(input.briefing),
          jobId: input.jobId,
          tier: input.exact?.tier ?? 'high',
          reason,
        },
  };
}

export function briefingReviewGate(input: BriefingReviewGateInput): BriefingReviewGateResult {
  const { exact, exactVerdict, exactPushback, requested, stage } = input;
  const dispatchedSha = briefingSha256Of(input.briefing);
  if (requested !== undefined) {
    // A pushed-back review is dispatched WITHOUT the block: the push-back is
    // the provenance. Supplying a CHANGES-NEEDED claim alongside it would ask
    // the gate to admit what it just refused.
    if (exactPushback !== null) {
      return refused(
        input,
        'briefing_review_invalid_request',
        400,
        `review ${exact?.reviewId ?? ''} was pushed back; dispatch it without a briefing_review block so the push-back is auto-attached`,
        null,
      );
    }
    if (requested.briefingSha256 !== dispatchedSha) {
      return refused(
        input,
        'briefing_review_mismatch',
        409,
        `the dispatch claims briefing_review.briefing_sha256 ${requested.briefingSha256} but the briefing being dispatched is ${dispatchedSha}; ` +
          'the reviewed briefing and the dispatched briefing must be byte-identical',
        null,
      );
    }
    if (exact === null) {
      return refused(
        input,
        'briefing_review_unknown',
        409,
        `no briefing review is armed for briefing ${dispatchedSha} in ${input.repoPath}; commission one with POST /api/briefing-review before claiming its provenance`,
        null,
      );
    }
    if (requested.rounds !== exact.round) {
      return refused(
        input,
        'briefing_review_mismatch',
        409,
        `the dispatch claims briefing_review.rounds ${String(requested.rounds)} but review ${exact.reviewId} is round ${String(exact.round)}`,
        null,
      );
    }
    if (exactVerdict === null || exactVerdict !== requested.verdict) {
      return refused(
        input,
        'briefing_review_pending',
        409,
        `the dispatch claims verdict ${requested.verdict} but review ${exact.reviewId} holds ${exactVerdict ?? 'no verdict yet'}; ` +
          'a claimed verdict is never accepted on trust',
        null,
      );
    }
    if (requested.verdict === 'CHANGES-NEEDED' && stage === 2) {
      return refused(
        input,
        'briefing_review_not_ready',
        409,
        `review ${exact.reviewId} holds CHANGES-NEEDED: fix the briefing and re-commission at this tier, escalate to the owner, ` +
          'or record a push-back with POST /api/briefing-review/pushback and dispatch without the block',
        'changes-needed',
      );
    }
    return { admitted: true, provenance: provenance(exact, requested.verdict, null) };
  }

  if (exact !== null && exactVerdict === 'READY') {
    return { admitted: true, provenance: provenance(exact, 'READY', null) };
  }
  if (exact !== null && exactPushback !== null) {
    return { admitted: true, provenance: provenance(exact, 'PUSHED-BACK', exactPushback.reason) };
  }
  // Medium and low tiers stay advisory at stage 2; so does a heist with no
  // armed review for this sha until the chain scan below finds a high-tier
  // round that covers only an older revision.
  if (stage === 1 || (exact !== null && exact.tier !== 'high')) {
    return { admitted: true, provenance: null };
  }
  if (exact !== null && exactVerdict === 'CHANGES-NEEDED') {
    return refused(
      input,
      'briefing_review_not_ready',
      409,
      `high-tier review ${exact.reviewId} holds CHANGES-NEEDED at stage 2: fix the briefing, escalate to the owner, ` +
        'or record a push-back with POST /api/briefing-review/pushback',
      'changes-needed',
    );
  }
  if (exact !== null) {
    return refused(
      input,
      'briefing_review_pending',
      409,
      `high-tier review ${exact.reviewId} has no verdict yet at stage 2; dispatch after it reaches READY, or record a push-back`,
      'pending',
    );
  }
  const older = input.chain.filter((review) => review.tier === 'high');
  if (older.length > 0) {
    const newest = older[older.length - 1]!;
    return refused(
      input,
      'briefing_review_required',
      409,
      `this stage-2 install reviewed this heist's chain (newest: ${newest.reviewId}, round ${String(newest.round)}) but this exact briefing ` +
        'has no review; commission POST /api/briefing-review for the revised briefing before dispatching it',
      'missing',
    );
  }
  return { admitted: true, provenance: null };
}

/** The optional `briefing_review` block: present-but-malformed is a named
 * 400 before any side effect, never a silent drop. */
export function parseBriefingReviewBlock(value: unknown): BriefingReviewRequestedProvenance | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidRequest('briefing_review must be an object when present');
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!['rounds', 'verdict', 'briefing_sha256'].includes(key)) {
      throw invalidRequest(`briefing_review has unknown field "${key}"`);
    }
  }
  const rounds = raw['rounds'];
  if (typeof rounds !== 'number' || !Number.isSafeInteger(rounds) || rounds < 1) {
    throw invalidRequest('briefing_review.rounds must be a positive integer');
  }
  const verdict = raw['verdict'];
  if (!isBriefingReviewVerdict(verdict)) {
    throw invalidRequest('briefing_review.verdict must be READY|CHANGES-NEEDED (a push-back dispatch omits the block)');
  }
  const sha = raw['briefing_sha256'];
  if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/u.test(sha)) {
    throw invalidRequest('briefing_review.briefing_sha256 must be a lowercase sha256 hex digest');
  }
  return { rounds, verdict, briefingSha256: sha };
}
