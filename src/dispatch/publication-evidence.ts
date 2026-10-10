/**
 * Durable evidence for ONE formal publication attempt (owner correction
 * cycle: native blockers 2 and 3 on PR #289).
 *
 * An irreversible provider write cannot be undone by cancellation or source
 * movement, so the publication boundary must leave durable truth on BOTH
 * sides of the POST:
 *
 * - `round.publication-attempt` is journaled BEFORE the irreversible POST.
 *   It is the immutable intent: without it a crash leaves no trace that a
 *   provider write may exist, and a restart can silently re-publish.
 * - `round.publication-receipt` is journaled IMMEDIATELY after the provider
 *   proof, before any finality check. A moved/cancelled round keeps the
 *   proven frozen-commit receipt as UNCREDITED evidence instead of
 *   discarding it.
 * - `round.publication-absent` is journaled when bounded reconciliation
 *   proves the attempt did not land (a conclusive absence, never assumed).
 *
 * `pendingPublicationAttempt` is the shared re-arm guard: a round whose
 * latest attempt has no conclusive outcome (no credited `round.posted`, no
 * bounded absence) may already hold an unreported provider review, so a new
 * same-head publication must not be re-armed before it is reconciled. The
 * guard reports evidence, never a fabricated result; callers fail closed.
 *
 * This module imports only TYPES from `perkins.ts` (erased at runtime), so
 * `perkins.ts` may import these values without a runtime cycle.
 */

import type { LedgerApi } from '../ledger/api.js';
import type { CanonicalReviewVerdict } from './perkins-review/types.js';
import type { PostedReviewReceipt, VerdictReviewEvent } from './perkins.js';

/** The immutable publication intent, journaled before the irreversible POST. */
export const PUBLICATION_ATTEMPT_EVENT = 'round.publication-attempt';
/** A provider-PROVEN receipt retained as uncredited evidence (finality
 * refused it, or restart recovery reconciled it without crediting). */
export const PUBLICATION_RECEIPT_EVENT = 'round.publication-receipt';
/** A bounded reconciliation proved the attempt did not land. */
export const PUBLICATION_ABSENT_EVENT = 'round.publication-absent';

export interface PublicationAttemptPayload {
  readonly verdict: 'approved' | 'changes-requested';
  readonly canonicalVerdict: CanonicalReviewVerdict;
  readonly url: string;
  readonly host: string;
  readonly targetSha: string;
  readonly baseSha: string;
  readonly publicationFile: string;
  readonly publicationSha256: string;
  readonly reviewEvent: VerdictReviewEvent;
}

export interface PublicationReceiptEvidencePayload extends PublicationAttemptPayload {
  readonly receipt: PostedReviewReceipt;
  /** Always false: a receipt that WAS credited lands as `round.posted`. */
  readonly credited: false;
  /** Why the proven receipt was not credited (or how it was recovered). */
  readonly reason: string;
}

export interface PublicationAbsentPayload {
  readonly targetSha: string;
  readonly publicationSha256: string;
  readonly detail: string;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function boundedString(value: unknown, max: number): value is string {
  return nonEmptyString(value) && value.length <= max;
}

function parseCommon(payload: unknown): PublicationAttemptPayload | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  const verdict = value['verdict'];
  const canonicalVerdict = value['canonicalVerdict'];
  const reviewEvent = value['reviewEvent'];
  if (verdict !== 'approved' && verdict !== 'changes-requested') return null;
  if (typeof canonicalVerdict !== 'string') return null;
  if (verdict === 'approved' ? canonicalVerdict !== 'READY TO MERGE' : !['NEEDS CHANGES', 'MAJOR REWORK NEEDED'].includes(canonicalVerdict)) {
    return null;
  }
  if (reviewEvent !== 'APPROVE' && reviewEvent !== 'REQUEST_CHANGES' && reviewEvent !== 'COMMENT') return null;
  if (!boundedString(value['url'], 2_000) || !boundedString(value['host'], 255)) return null;
  if (!boundedString(value['targetSha'], 200) || !boundedString(value['baseSha'], 200)) return null;
  if (!boundedString(value['publicationFile'], 4_096) || !boundedString(value['publicationSha256'], 128)) return null;
  return {
    verdict,
    canonicalVerdict: canonicalVerdict as CanonicalReviewVerdict,
    url: value['url'],
    host: value['host'],
    targetSha: value['targetSha'],
    baseSha: value['baseSha'],
    publicationFile: value['publicationFile'],
    publicationSha256: value['publicationSha256'],
    reviewEvent,
  };
}

/** Strict, THROW-FREE parse of a `round.publication-attempt` payload. */
export function parsePublicationAttemptPayload(payload: unknown): PublicationAttemptPayload | null {
  return parseCommon(payload);
}

/** Strict, THROW-FREE parse of a `round.publication-receipt` payload. */
export function parsePublicationReceiptEvidencePayload(payload: unknown): PublicationReceiptEvidencePayload | null {
  const common = parseCommon(payload);
  if (common === null) return null;
  const value = payload as Record<string, unknown>;
  if (value['credited'] !== false || !boundedString(value['reason'], 500)) return null;
  const receiptValue = value['receipt'];
  if (typeof receiptValue !== 'object' || receiptValue === null || Array.isArray(receiptValue)) return null;
  const receipt = receiptValue as Record<string, unknown>;
  if (
    !boundedString(receipt['reviewId'], 200) || !boundedString(receipt['actor'], 200) ||
    !boundedString(receipt['event'], 64) || !boundedString(receipt['bodySha256'], 64) ||
    !boundedString(receipt['headSha'], 200) || !boundedString(receipt['baseSha'], 200)
  ) return null;
  const commitId = receipt['commitId'];
  if (commitId !== null && !nonEmptyString(commitId)) return null;
  return {
    ...common,
    credited: false,
    reason: value['reason'],
    receipt: {
      reviewId: receipt['reviewId'], actor: receipt['actor'], event: receipt['event'],
      commitId: commitId as string | null, headSha: receipt['headSha'], baseSha: receipt['baseSha'],
      bodySha256: receipt['bodySha256'],
    },
  };
}

/** Strict, THROW-FREE parse of a `round.publication-absent` payload. */
export function parsePublicationAbsentPayload(payload: unknown): PublicationAbsentPayload | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (!boundedString(value['targetSha'], 200) || !boundedString(value['publicationSha256'], 128) ||
    !boundedString(value['detail'], 1_000)) return null;
  return { targetSha: value['targetSha'], publicationSha256: value['publicationSha256'], detail: value['detail'] };
}

export interface PendingPublicationProblem {
  readonly kind: 'uncredited-receipt' | 'unresolved-attempt';
  readonly detail: string;
}

/** The shared re-arm guard. Returns null only when the round's latest
 * publication attempt has a conclusive outcome: a credited `round.posted`
 * after the attempt (already recorded), or a bounded `round.publication-absent`
 * (proved not to have landed). Anything else - an uncredited proven receipt,
 * a reconciled-but-uncertain attempt, or a bare intent - may describe a
 * provider write that is not yet resolved, so a new same-head publication
 * must not be re-armed. A malformed attempt payload fails closed too. */
export function pendingPublicationAttempt(ledger: LedgerApi, roundId: string): PendingPublicationProblem | null {
  const attemptEvent = ledger.latestRoundEvent(roundId, PUBLICATION_ATTEMPT_EVENT);
  if (attemptEvent === null) return null;
  const attempt = parsePublicationAttemptPayload(attemptEvent.payload);
  const head = attempt?.targetSha ?? 'unknown';
  const posted = ledger.latestRoundEvent(roundId, 'round.posted');
  if (posted !== null && posted.seq > attemptEvent.seq) return null;
  const absent = ledger.latestRoundEvent(roundId, PUBLICATION_ABSENT_EVENT);
  if (absent !== null && absent.seq > attemptEvent.seq && parsePublicationAbsentPayload(absent.payload) !== null) return null;
  const receiptEvent = ledger.latestRoundEvent(roundId, PUBLICATION_RECEIPT_EVENT);
  if (receiptEvent !== null && receiptEvent.seq > attemptEvent.seq) {
    const evidence = parsePublicationReceiptEvidencePayload(receiptEvent.payload);
    return {
      kind: 'uncredited-receipt',
      detail: `an uncredited provider receipt (review ${evidence?.receipt.reviewId ?? 'unknown'}) exists for frozen head ${head}; reconcile it before re-arming a publication on the same head`,
    };
  }
  return {
    kind: 'unresolved-attempt',
    detail: `a publication attempt for frozen head ${head} has no reconciled outcome - the provider may hold an unreviewed publication; reconcile it before re-arming`,
  };
}
