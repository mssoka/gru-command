import type { ArmedReview, BriefingReviewRefusalReason, PushbackEvent } from './events.js';
import {
  BriefingReviewError,
  BRIEFING_REVIEW_ROUND_CAP,
  briefingSha256Of,
  invalidRequest,
  isBriefingReviewVerdict,
  tierEnforcedAt,
  type BriefingReviewProvenanceVerdict,
  type BriefingReviewStage,
  type BriefingReviewTier,
  type BriefingReviewVerdict,
} from './types.js';

/**
 * The dispatch gate (CAP-6): a pure decision over records someone else read.
 *
 * Stage 1 is advisory: a dispatch is never refused for review readiness, and
 * only a FALSE provenance claim is stopped. Stage 2 refuses a high-tier
 * dispatch whose exact briefing sha has no READY review and no recorded
 * push-back. Stage 3 and the default `auto` enforce high and medium; low stays
 * advisory at every stage. A heist with no armed review at all is admitted
 * (the server cannot infer an undeclared tier — the role canon carries that
 * obligation).
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

/** One review of this heist's chain, as the enforced-tier fallback scan sees it. */
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

function stageLabel(stage: BriefingReviewStage): string {
  return stage === 'auto' ? 'auto-by-tier' : `stage ${String(stage)}`;
}

/** The chain's trailing CHANGES-NEEDED reviews, newest first. */
function chainAtCap(chain: readonly BriefingReviewChainReview[]): boolean {
  let trailing = 0;
  for (const review of [...chain].reverse()) {
    if (review.verdict !== 'CHANGES-NEEDED') break;
    trailing += 1;
  }
  return trailing >= BRIEFING_REVIEW_ROUND_CAP;
}

/** The cap routes to push-back + dispatch + one material amendment, never to a
 * re-commission the service will refuse. */
function capRouting(): string {
  return (
    'this heist is at the briefing-review round cap: record a push-back on the last reviewed text, dispatch that exact text, ' +
    'then append one material corrective amendment with POST /api/dispatch/amendment ' +
    "(its approval.reference names owner ruling journal j-1200) that fixes that round's blocking findings"
  );
}

function refused(
  input: BriefingReviewGateInput,
  code: BriefingReviewError['code'],
  status: number,
  detail: string,
  reason: BriefingReviewRefusalReason | null,
  tier: BriefingReviewTier = input.exact?.tier ?? 'high',
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
          tier,
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
        chainAtCap(input.chain)
          ? `no briefing review is armed for briefing ${dispatchedSha} in ${input.repoPath}; ${capRouting()}`
          : `no briefing review is armed for briefing ${dispatchedSha} in ${input.repoPath}; commission one with POST /api/briefing-review before claiming its provenance`,
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
    if (requested.verdict === 'CHANGES-NEEDED' && tierEnforcedAt(exact.tier, stage)) {
      return refused(
        input,
        'briefing_review_not_ready',
        409,
        chainAtCap(input.chain)
          ? `review ${exact.reviewId} holds CHANGES-NEEDED and ${stageLabel(stage)} enforces ${exact.tier}-tier readiness; ${capRouting()}`
          : `review ${exact.reviewId} holds CHANGES-NEEDED and ${stageLabel(stage)} enforces ${exact.tier}-tier readiness: fix the briefing and re-commission at this tier, ` +
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
  // Low tiers always stay advisory; `auto` enforces every non-low tier, stage 3
  // forces high + medium, and stage 2 enforces high only.
  if (stage === 1 || (exact !== null && !tierEnforcedAt(exact.tier, stage))) {
    return { admitted: true, provenance: null };
  }
  if (exact !== null && exactVerdict === 'CHANGES-NEEDED') {
    return refused(
      input,
      'briefing_review_not_ready',
      409,
      chainAtCap(input.chain)
        ? `${stageLabel(stage)} review ${exact.reviewId} holds CHANGES-NEEDED; ${capRouting()}`
        : `${stageLabel(stage)} review ${exact.reviewId} holds CHANGES-NEEDED: fix the briefing and re-commission at this tier, ` +
          'or record a push-back with POST /api/briefing-review/pushback',
      'changes-needed',
    );
  }
  if (exact !== null) {
    return refused(
      input,
      'briefing_review_pending',
      409,
      `${stageLabel(stage)} review ${exact.reviewId} has no verdict yet; dispatch after it reaches READY, or record a push-back`,
      'pending',
    );
  }
  const older = input.chain.filter((review) => tierEnforcedAt(review.tier, stage));
  if (older.length > 0) {
    const newest = older[older.length - 1]!;
    return refused(
      input,
      'briefing_review_required',
      409,
      chainAtCap(input.chain)
        ? `this ${stageLabel(stage)} install reviewed this heist's chain (newest: ${newest.reviewId}, round ${String(newest.round)}) but this exact briefing ` +
          `has no review; ${capRouting()}`
        : `this ${stageLabel(stage)} install reviewed this heist's chain (newest: ${newest.reviewId}, round ${String(newest.round)}) but this exact briefing ` +
          'has no review; commission POST /api/briefing-review for the revised briefing before dispatching it',
      'missing',
      newest.tier,
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
