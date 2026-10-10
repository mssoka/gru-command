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

import type { CanonicalReviewVerdict } from './perkins-review/types.js';
import type { PostedReviewReceipt, VerdictReviewEvent } from './perkins.js';

/** The immutable publication intent, journaled before the irreversible POST. */
export const PUBLICATION_ATTEMPT_EVENT = 'round.publication-attempt';
/** A provider-PROVEN receipt retained as uncredited evidence (finality
 * refused it, or restart recovery reconciled it without crediting). */
export const PUBLICATION_RECEIPT_EVENT = 'round.publication-receipt';
/** A bounded reconciliation proved the attempt did not land. */
export const PUBLICATION_ABSENT_EVENT = 'round.publication-absent';
/** A recorded `round.posted` delivery could not be RE-BOUND/credited at
 * restart (for example a transient actor-evidence probe failure): the
 * provider write exists and stays unresolved until reconciliation supports
 * the actual result, so no same-head re-arm may start a second publication. */
export const PUBLICATION_REBIND_UNRESOLVED_EVENT = 'round.publication-rebind-unresolved';

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

export interface PublicationRebindUnresolvedPayload {
  readonly targetSha: string | null;
  readonly reviewId: string | null;
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

/** Strict, THROW-FREE parse of a `round.publication-rebind-unresolved`
 * payload. A malformed marker still holds (the caller fails closed on the
 * event's presence); the parser only decides whether its detail is usable. */
export function parsePublicationRebindUnresolvedPayload(payload: unknown): PublicationRebindUnresolvedPayload | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (!boundedString(value['detail'], 1_000)) return null;
  const targetSha = value['targetSha'];
  const reviewId = value['reviewId'];
  return {
    targetSha: typeof targetSha === 'string' && targetSha.trim() !== '' ? targetSha : null,
    reviewId: typeof reviewId === 'string' && reviewId.trim() !== '' ? reviewId : null,
    detail: value['detail'],
  };
}

/** The minimal ledger surface the guard reads: the full `LedgerApi` and the
 * digest's narrower reader both satisfy it structurally. */
export interface PublicationEvidenceReader {
  latestRoundEvent(roundId: string, kind: string): { readonly seq: number; readonly payload: unknown } | null;
}

export interface PendingPublicationProblem {
  readonly kind: 'uncredited-receipt' | 'unresolved-attempt' | 'unresolved-rebinding' | 'recorded-delivery-unresolved';
  readonly detail: string;
}

/** Best-effort summary of a recorded `round.posted` payload for escalation
 * detail: a structural read only (never a validator). */
function postedDeliverySummary(payload: unknown): { readonly head: string; readonly reviewId: string | null } {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return { head: 'unknown', reviewId: null };
  const value = payload as Record<string, unknown>;
  const head = typeof value['targetSha'] === 'string' && value['targetSha'].trim() !== '' ? value['targetSha'] : 'unknown';
  const receipt = value['receipt'];
  const reviewId = typeof receipt === 'object' && receipt !== null && !Array.isArray(receipt) &&
    typeof (receipt as Record<string, unknown>)['reviewId'] === 'string' && ((receipt as Record<string, unknown>)['reviewId'] as string).trim() !== ''
    ? ((receipt as Record<string, unknown>)['reviewId'] as string)
    : null;
  return { head, reviewId };
}

/** The shared re-arm guard. Returns null only when the round has NO recorded
 * provider delivery without a conclusive outcome. Callers consult it for a
 * round the admission already knows is NOT credited (both mechanical
 * clean-abort paths require an aborted round; a credited delivery leaves the
 * round verdict-posted), so:
 *
 * - a rebind marker that postdates the latest recorded delivery means the
 *   recorded write's re-binding stayed unresolved;
 * - a `round.posted` at all means a provider write was recorded whose credit
 *   was never established - including pre-upgrade rounds aborted after an
 *   unbound promotion whose failure left no marker, and rounds whose rebuild
 *   was interrupted before finalization. The frozen-commit write provably
 *   exists, so a same-head re-arm must not start a second publication until
 *   the delivery is reconciled;
 * - a durable attempt with no recorded delivery stays unresolved unless a
 *   bounded absence proved it did not land (the only conclusive clear for an
 *   unconcluded attempt); an uncredited receipt or a bare intent holds.
 * A malformed attempt or absence payload fails closed. */
export function pendingPublicationAttempt(ledger: PublicationEvidenceReader, roundId: string): PendingPublicationProblem | null {
  const posted = ledger.latestRoundEvent(roundId, 'round.posted');
  const rebindEvent = ledger.latestRoundEvent(roundId, PUBLICATION_REBIND_UNRESOLVED_EVENT);
  if (rebindEvent !== null && (posted === null || rebindEvent.seq > posted.seq)) {
    const rebind = parsePublicationRebindUnresolvedPayload(rebindEvent.payload);
    return {
      kind: 'unresolved-rebinding',
      detail: `a recorded provider delivery${rebind?.reviewId === null || rebind?.reviewId === undefined ? '' : ` (review ${rebind.reviewId})`} on frozen head ${rebind?.targetSha ?? 'unknown'} could not be re-bound/credited at restart, so whether it is the final delivery stays unresolved - reconcile it before re-arming`,
    };
  }
  if (posted !== null) {
    const recorded = postedDeliverySummary(posted.payload);
    // A credited delivery makes the round verdict-posted, which neither
    // re-arm admission accepts; reaching this point therefore means the
    // recorded delivery's credit is unresolved (unbound/interrupted
    // promotion), with or without a durable intent or a rebind marker.
    return {
      kind: 'recorded-delivery-unresolved',
      detail: `a provider delivery recorded on frozen head ${recorded.head}${recorded.reviewId === null ? '' : ` (review ${recorded.reviewId})`} was never credited; the frozen-commit write stays unresolved and no second same-head publication may be re-armed until it is reconciled`,
    };
  }
  const attemptEvent = ledger.latestRoundEvent(roundId, PUBLICATION_ATTEMPT_EVENT);
  if (attemptEvent === null) return null;
  const attempt = parsePublicationAttemptPayload(attemptEvent.payload);
  const head = attempt?.targetSha ?? 'unknown';
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
