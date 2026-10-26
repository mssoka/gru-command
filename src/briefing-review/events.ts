import type { EventRecord, LedgerApi } from '../ledger/api.js';
import {
  BRIEFING_REVIEW_LENSES,
  blockingFindings,
  isBriefingReviewLens,
  isBriefingReviewTier,
  isBriefingReviewVerdict,
  type BriefingReviewFinding,
  type BriefingReviewLens,
  type BriefingReviewTier,
  type BriefingReviewVerdict,
  type FindingSeverity,
} from './types.js';

/**
 * Nefario's durable facts: five ledger event kinds, their snake_case payloads
 * and the readers over them. Payload keys are snake_case so the ledger's
 * payload-field guard applies; API bodies stay camelCase.
 *
 * No new ledger read API is introduced: everything here reads through
 * `listEventsAfter` / `latestEventByPayloadField`, exactly like the board's
 * other event-derived views.
 */

export const BRIEFING_REVIEW_ARMED = 'briefing.review-armed';
export const BRIEFING_REVIEW_VERDICT = 'briefing.review-verdict';
export const BRIEFING_REVIEW_REFUSED = 'briefing.review-refused';
export const BRIEFING_REVIEW_PUSHBACK = 'briefing.review-pushback';
export const BRIEFING_REVIEW_DISPATCHED = 'briefing.review-dispatched';

/** The action recorded when an accepted lens result settles its own job's
 * report debt, so a commission never leaves one action-required row per lens. */
export const BRIEFING_REVIEW_OBLIGATION_ACTION = 'Nefario lens result accepted';

/** The bounded read: one more than the limit the board may consume, so a
 * read that hits it is provably truncated (never silently wrong counts). */
export const BRIEFING_REVIEW_READ_LIMIT = 5001;

export type BriefingReviewRefusalReason = 'missing' | 'pending' | 'changes-needed';

/** The newest armed record for one review identity (or one generation). */
export interface ArmedReview {
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
  readonly seq: number;
  readonly ts: string;
}

/** One lens submission, or the decisive aggregate verdict, on the same kind. */
export interface LensVerdictEvent {
  readonly reviewId: string;
  readonly chainKey: string;
  readonly briefingSha256: string;
  readonly lens: BriefingReviewLens;
  readonly verdict: BriefingReviewVerdict;
  readonly findings: readonly BriefingReviewFinding[];
  readonly round: number;
  readonly generation: number;
  readonly decisive: boolean;
  readonly aggregate: BriefingReviewVerdict | null;
  /** Blocking findings the revision superseded; 0 unless a decisive READY. */
  readonly caught: number;
  readonly seq: number;
  readonly ts: string;
}

export interface RefusalEvent {
  readonly repoPath: string;
  readonly title: string;
  readonly briefingSha256: string;
  readonly jobId: string;
  readonly tier: BriefingReviewTier;
  readonly reason: BriefingReviewRefusalReason;
  readonly seq: number;
  readonly ts: string;
}

export interface PushbackEvent {
  readonly reviewId: string;
  readonly briefingSha256: string;
  readonly generation: number;
  readonly reason: string;
  readonly by: string;
  readonly seq: number;
  readonly ts: string;
}

function payloadOf(event: EventRecord): Record<string, unknown> {
  return (event.payload ?? {}) as Record<string, unknown>;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

function findingOf(value: unknown): BriefingReviewFinding | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const code = text(raw['code']);
  const severity = raw['severity'];
  const evidence = typeof raw['evidence'] === 'string' ? raw['evidence'] : null;
  const why = typeof raw['why_it_blocks'] === 'string' ? raw['why_it_blocks'] : null;
  if (code === null || evidence === null || why === null) return null;
  if (severity !== 'blocking' && severity !== 'advisory') return null;
  return { code, severity: severity as FindingSeverity, evidence, whyItBlocks: why };
}

/** A malformed record reads as null — an unreadable fact is never guessed,
 * and the board's view treats it as absent rather than inventing one. */
export function readArmed(event: EventRecord): ArmedReview | null {
  const p = payloadOf(event);
  const reviewId = text(p['review_id']);
  const commissionKey = text(p['commission_key']);
  const chainKey = text(p['chain_key']);
  const briefingSha256 = text(p['briefing_sha_256']);
  const repoPath = text(p['repo_path']);
  const title = text(p['title']);
  const justification = typeof p['justification'] === 'string' ? p['justification'] : null;
  const tier = p['tier'];
  const round = count(p['round']);
  const generation = count(p['generation']);
  const lenses = p['lenses'];
  const headSha = p['head_sha'];
  const upgradedFrom = p['upgraded_from'];
  if (reviewId === null || commissionKey === null || chainKey === null || briefingSha256 === null ||
      repoPath === null || title === null || justification === null || !isBriefingReviewTier(tier) ||
      round === null || generation === null || !Array.isArray(lenses)) return null;
  const armed = lenses.filter(isBriefingReviewLens);
  if (armed.length !== lenses.length || armed.length === 0) return null;
  if (headSha !== null && headSha !== undefined && typeof headSha !== 'string') return null;
  if (upgradedFrom !== null && upgradedFrom !== undefined && count(upgradedFrom) === null) return null;
  return {
    reviewId,
    commissionKey,
    chainKey,
    briefingSha256,
    repoPath,
    title,
    tier,
    justification,
    round,
    generation,
    lenses: BRIEFING_REVIEW_LENSES.filter((lens) => armed.includes(lens)),
    headSha: typeof headSha === 'string' ? headSha : null,
    upgradedFrom: count(upgradedFrom),
    seq: event.seq,
    ts: event.ts,
  };
}

export function readVerdict(event: EventRecord): LensVerdictEvent | null {
  const p = payloadOf(event);
  const reviewId = text(p['review_id']);
  const chainKey = text(p['chain_key']);
  const briefingSha256 = text(p['briefing_sha_256']);
  const lens = p['lens'];
  const verdict = p['lens_verdict'];
  const round = count(p['round']);
  const generation = count(p['generation']);
  const findings = p['findings'];
  const decisive = p['decisive'];
  const aggregate = p['aggregate'];
  const caught = p['caught'];
  if (reviewId === null || chainKey === null || briefingSha256 === null || !isBriefingReviewLens(lens) ||
      !isBriefingReviewVerdict(verdict) || round === null || generation === null ||
      !Array.isArray(findings) || typeof decisive !== 'boolean') return null;
  const parsed = findings.map(findingOf);
  if (parsed.some((finding) => finding === null)) return null;
  if (aggregate !== null && aggregate !== undefined && !isBriefingReviewVerdict(aggregate)) return null;
  if (decisive && aggregate === undefined) return null;
  return {
    reviewId,
    chainKey,
    briefingSha256,
    lens,
    verdict,
    findings: parsed as readonly BriefingReviewFinding[],
    round,
    generation,
    decisive,
    aggregate: isBriefingReviewVerdict(aggregate) ? aggregate : null,
    caught: count(caught) ?? 0,
    seq: event.seq,
    ts: event.ts,
  };
}

export function readRefusal(event: EventRecord): RefusalEvent | null {
  const p = payloadOf(event);
  const repoPath = text(p['repo_path']);
  const title = text(p['title']);
  const briefingSha256 = text(p['briefing_sha_256']);
  const jobId = text(p['job_id']);
  const tier = p['tier'];
  const reason = p['reason'];
  if (repoPath === null || title === null || briefingSha256 === null || jobId === null || !isBriefingReviewTier(tier)) return null;
  if (reason !== 'missing' && reason !== 'pending' && reason !== 'changes-needed') return null;
  return { repoPath, title, briefingSha256, jobId, tier, reason, seq: event.seq, ts: event.ts };
}

export function readPushback(event: EventRecord): PushbackEvent | null {
  const p = payloadOf(event);
  const reviewId = text(p['review_id']);
  const briefingSha256 = text(p['briefing_sha_256']);
  const generation = count(p['generation']);
  const reason = text(p['reason']);
  const by = text(p['by']);
  if (reviewId === null || briefingSha256 === null || generation === null || reason === null || by === null) return null;
  return { reviewId, briefingSha256, generation, reason, by, seq: event.seq, ts: event.ts };
}

/** The ledger surface the briefing review reads: existing APIs only. */
export type BriefingReviewLedgerPort = Pick<LedgerApi, 'listEventsAfter' | 'latestEventByPayloadField'>;

/** Every armed generation for one review, oldest first (a raise appends). */
export function armedGenerations(ledger: BriefingReviewLedgerPort, reviewId: string): readonly ArmedReview[] {
  return ledger
    .listEventsAfter(0, { kinds: [BRIEFING_REVIEW_ARMED], order: 'asc', limit: 200, payload: { key: 'review_id', equals: reviewId } })
    .map(readArmed)
    .filter((record): record is ArmedReview => record !== null);
}

/** The newest armed record for one review identity, or null. */
export function latestArmed(ledger: BriefingReviewLedgerPort, reviewId: string): ArmedReview | null {
  return armedGenerations(ledger, reviewId).at(-1) ?? null;
}

/** Every armed review in one heist chain, oldest first. */
export function armedChain(ledger: BriefingReviewLedgerPort, chainKey: string): readonly ArmedReview[] {
  return ledger
    .listEventsAfter(0, { kinds: [BRIEFING_REVIEW_ARMED], order: 'asc', limit: 500, payload: { key: 'chain_key', equals: chainKey } })
    .map(readArmed)
    .filter((record): record is ArmedReview => record !== null);
}

/** The armed review covering one exact briefing sha in one repository. */
export function armedByBriefingSha(ledger: BriefingReviewLedgerPort, briefingSha256: string, repoPath: string): ArmedReview | null {
  const armed = ledger
    .listEventsAfter(0, { kinds: [BRIEFING_REVIEW_ARMED], order: 'desc', limit: 200, payload: { key: 'briefing_sha_256', equals: briefingSha256 } })
    .map(readArmed)
    .filter((record): record is ArmedReview => record !== null)
    .filter((record) => record.repoPath === repoPath);
  return armed[0] ?? null;
}

/** Every verdict event for one review, oldest first. */
export function reviewVerdicts(ledger: BriefingReviewLedgerPort, reviewId: string): readonly LensVerdictEvent[] {
  return ledger
    .listEventsAfter(0, { kinds: [BRIEFING_REVIEW_VERDICT], order: 'asc', limit: 5000, payload: { key: 'review_id', equals: reviewId } })
    .map(readVerdict)
    .filter((record): record is LensVerdictEvent => record !== null);
}

/** Every recorded push-back for one review, oldest first. */
export function reviewPushbacks(ledger: BriefingReviewLedgerPort, reviewId: string): readonly PushbackEvent[] {
  return ledger
    .listEventsAfter(0, { kinds: [BRIEFING_REVIEW_PUSHBACK], order: 'asc', limit: 200, payload: { key: 'review_id', equals: reviewId } })
    .map(readPushback)
    .filter((record): record is PushbackEvent => record !== null);
}

/** The latest verdict a lens submitted for one review, whatever its
 * generation (an inherited result still satisfies a raise). */
export function latestLensVerdict(
  verdicts: readonly LensVerdictEvent[],
  lens: BriefingReviewLens,
): LensVerdictEvent | null {
  return verdicts.filter((verdict) => verdict.lens === lens).at(-1) ?? null;
}

/** The decisive aggregate verdict of one generation, or null while pending. */
export function decisiveVerdict(
  verdicts: readonly LensVerdictEvent[],
  generation: number,
): LensVerdictEvent | null {
  return verdicts.filter((verdict) => verdict.decisive && verdict.generation === generation).at(-1) ?? null;
}

/** A READY aggregate requires every armed lens to hold a READY result. */
export function everyLensReady(
  verdicts: readonly LensVerdictEvent[],
  lenses: readonly BriefingReviewLens[],
): boolean {
  return lenses.every((lens) => latestLensVerdict(verdicts, lens)?.verdict === 'READY');
}
/** The blocking findings an accepted READY revision superseded: the sum
 * over the latest verdict of every lens of the immediately preceding
 * CHANGES-NEEDED round of the same chain. 0 when nothing was superseded. */
export function caughtByRevision(input: {
  readonly ledger: BriefingReviewLedgerPort;
  readonly chainKey: string;
  readonly reviewId: string;
}): number {
  const chain = armedChain(input.ledger, input.chainKey);
  const order = [...new Set(chain.map((record) => record.reviewId))];
  const index = order.indexOf(input.reviewId);
  if (index <= 0) return 0;
  const previous = order[index - 1]!;
  const previousVerdicts = reviewVerdicts(input.ledger, previous);
  const decisive = previousVerdicts.filter((verdict) => verdict.decisive).at(-1) ?? null;
  if (decisive?.aggregate !== 'CHANGES-NEEDED') return 0;
  return BRIEFING_REVIEW_LENSES.reduce((sum, lens) => {
    const latest = latestLensVerdict(previousVerdicts, lens);
    return sum + (latest === null ? 0 : blockingFindings(latest.findings));
  }, 0);
}

/** The trailing run of CHANGES-NEEDED rounds at the head of one chain. A
 * pending review or a READY verdict ends the run (a READY resets the cap). */
export function trailingChangesNeeded(ledger: BriefingReviewLedgerPort, chainKey: string): number {
  const order = [...new Set(armedChain(ledger, chainKey).map((record) => record.reviewId))];
  let trailing = 0;
  for (const reviewId of [...order].reverse()) {
    const verdicts = reviewVerdicts(ledger, reviewId);
    const decisive = verdicts.filter((verdict) => verdict.decisive).at(-1) ?? null;
    if (decisive?.aggregate !== 'CHANGES-NEEDED') break;
    trailing += 1;
  }
  return trailing;
}

