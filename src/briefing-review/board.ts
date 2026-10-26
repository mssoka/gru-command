import type {
  ArmedReview,
  BriefingReviewLedgerPort,
  LensVerdictEvent,
  RefusalEvent,
} from './events.js';
import {
  BRIEFING_REVIEW_ARMED,
  BRIEFING_REVIEW_READ_LIMIT,
  BRIEFING_REVIEW_REFUSED,
  BRIEFING_REVIEW_VERDICT,
  readArmed,
  readRefusal,
  readVerdict,
} from './events.js';
import type { BriefingReviewStage, BriefingReviewTier } from './types.js';

/**
 * Nefario on the cockpit (CAP-7): the counts the Nefario card shows, derived
 * purely from durable events with the clock injected, plus the bounded read
 * that feeds them. A read that throws or hits its limit yields null — the card
 * then says it could not read, never a silently wrong count.
 */

export interface BriefingReviewBoardCounts {
  /** Reviews whose newest armed generation has no decisive verdict. */
  readonly armed: number;
  /** The round of the newest live review (null when nothing is live). */
  readonly round: number | null;
  readonly tier: BriefingReviewTier | null;
  /** Decisive verdict events recorded on the server's local day. */
  readonly verdictsToday: number;
  /** Blocking findings those READY verdicts caught before dispatch. */
  readonly caught: number;
  /** Stage-2 refusals recorded on the server's local day. */
  readonly refusalsToday: number;
}

export type BriefingReviewStageName = 'advisory' | 'high' | 'high+medium';

export interface BriefingReviewBoardView extends BriefingReviewBoardCounts {
  readonly stage: BriefingReviewStageName;
}

export const EMPTY_BRIEFING_REVIEW_COUNTS: BriefingReviewBoardCounts = {
  armed: 0,
  round: null,
  tier: null,
  verdictsToday: 0,
  caught: 0,
  refusalsToday: 0,
};

export function briefingReviewStageName(stage: BriefingReviewStage): BriefingReviewStageName {
  if (stage === 1) return 'advisory';
  if (stage === 2) return 'high';
  if (stage === 3 || stage === 'auto') return 'high+medium';
  throw new Error(`unhandled briefing review stage ${String(stage)}`);
}

function localDayStart(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

function today(eventTs: string, start: number): boolean {
  const at = Date.parse(eventTs);
  return Number.isFinite(at) && at >= start && at < start + 86_400_000;
}

export function briefingReviewCounts(input: {
  readonly armed: readonly ArmedReview[];
  readonly verdicts: readonly LensVerdictEvent[];
  readonly refusals: readonly RefusalEvent[];
  readonly now: Date;
}): BriefingReviewBoardCounts {
  const newestByReview = new Map<string, ArmedReview>();
  for (const record of input.armed) {
    const current = newestByReview.get(record.reviewId);
    if (current === undefined || record.seq > current.seq) newestByReview.set(record.reviewId, record);
  }
  const decided = new Set(
    input.verdicts.filter((verdict) => verdict.decisive).map((verdict) => `${verdict.reviewId}\0${String(verdict.generation)}`),
  );
  const live = [...newestByReview.values()]
    .filter((record) => !decided.has(`${record.reviewId}\0${String(record.generation)}`))
    .sort((left, right) => right.seq - left.seq);
  const newestLive = live[0] ?? null;
  const start = localDayStart(input.now);
  const decisiveToday = input.verdicts.filter((verdict) => verdict.decisive && today(verdict.ts, start));
  return {
    armed: live.length,
    round: newestLive?.round ?? null,
    tier: newestLive?.tier ?? null,
    verdictsToday: decisiveToday.length,
    caught: decisiveToday
      .filter((verdict) => verdict.aggregate === 'READY')
      .reduce((sum, verdict) => sum + verdict.caught, 0),
    refusalsToday: input.refusals.filter((refusal) => today(refusal.ts, start)).length,
  };
}

/** The bounded read behind the card. A read that throws propagates (the engine
 * logs it and sends null); a read at its limit returns null by itself. */
export function readBriefingReviewCounts(
  ledger: BriefingReviewLedgerPort,
  now: Date,
): BriefingReviewBoardCounts | null {
  const limit = BRIEFING_REVIEW_READ_LIMIT;
  const armed = ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_ARMED], order: 'asc', limit });
  const verdicts = ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_VERDICT], order: 'asc', limit });
  const refusals = ledger.listEventsAfter(0, { kinds: [BRIEFING_REVIEW_REFUSED], order: 'asc', limit });
  if (armed.length >= limit || verdicts.length >= limit || refusals.length >= limit) return null;
  return briefingReviewCounts({
    armed: armed.map((event) => readArmed(event)).filter((record): record is ArmedReview => record !== null),
    verdicts: verdicts.map((event) => readVerdict(event)).filter((record): record is LensVerdictEvent => record !== null),
    refusals: refusals.map((event) => readRefusal(event)).filter((record): record is RefusalEvent => record !== null),
    now,
  });
}

export function briefingReviewBoardView(input: {
  readonly counts: BriefingReviewBoardCounts | null;
  readonly stage: BriefingReviewStage;
}): BriefingReviewBoardView | null {
  if (input.counts === null) return null;
  return { ...input.counts, stage: briefingReviewStageName(input.stage) };
}
