import { describe, expect, it } from 'vitest';
import {
  briefingReviewBoardView,
  briefingReviewCounts,
  EMPTY_BRIEFING_REVIEW_COUNTS,
  readBriefingReviewCounts,
  type BriefingReviewBoardCounts,
} from '../src/briefing-review/board.js';
import type { ArmedReview, BriefingReviewLedgerPort, LensVerdictEvent, RefusalEvent } from '../src/briefing-review/events.js';
import type { EventRecord } from '../src/ledger/api.js';
import { tierEnforcedAt } from '../src/briefing-review/types.js';

/**
 * Nefario on the cockpit (GH-505): the pure count derivation, its day window
 * and its decisive-only rules, plus the bounded read that must never present a
 * silently wrong count. Clock and event timestamps are injected; nothing here
 * reads the wall clock.
 */

const NOW = new Date('2026-10-02T12:00:00');
const TODAY = new Date('2026-10-02T09:00:00').toISOString();
const YESTERDAY = new Date('2026-10-01T23:00:00').toISOString();

function armed(overrides: Partial<ArmedReview> & Pick<ArmedReview, 'reviewId'>): ArmedReview {
  return {
    commissionKey: `commission-${overrides.reviewId}`,
    chainKey: 'chain-1',
    briefingSha256: 'a'.repeat(64),
    repoPath: '/repos/shop',
    title: 'Refunds endpoint',
    tier: 'high',
    justification: 'Touches the refunds API.',
    round: 1,
    generation: 1,
    lenses: ['stranger'],
    headSha: null,
    upgradedFrom: null,
    seq: 1,
    ts: TODAY,
    ...overrides,
  };
}

function verdict(overrides: Partial<LensVerdictEvent>): LensVerdictEvent {
  return {
    reviewId: 'review-1',
    chainKey: 'chain-1',
    briefingSha256: 'a'.repeat(64),
    lens: 'stranger',
    verdict: 'READY',
    findings: [],
    round: 1,
    generation: 1,
    decisive: false,
    aggregate: null,
    caught: 0,
    seq: 1,
    ts: TODAY,
    ...overrides,
  };
}

function refusal(overrides: Partial<RefusalEvent>): RefusalEvent {
  return {
    repoPath: '/repos/shop',
    title: 'Refunds endpoint',
    briefingSha256: 'a'.repeat(64),
    jobId: 'job-1',
    tier: 'high',
    reason: 'pending',
    seq: 1,
    ts: TODAY,
    ...overrides,
  };
}

describe('Nefario board view — the pure derivation', () => {
  it('counts live reviews once, the newest live round and tier, today\'s decisive verdicts and their caught findings', () => {
    const counts = briefingReviewCounts({
      armed: [
        // A tier raise appends a second armed event for the SAME review: it
        // counts once, at its newest generation.
        armed({ reviewId: 'review-live', seq: 1, round: 2, tier: 'medium', generation: 1 }),
        armed({ reviewId: 'review-live', seq: 2, round: 2, tier: 'high', generation: 2 }),
        armed({ reviewId: 'review-done', seq: 3, round: 1 }),
        armed({ reviewId: 'review-old-live', seq: 4, round: 1, ts: YESTERDAY }),
      ],
      verdicts: [
        // A decided review is no longer live.
        verdict({ reviewId: 'review-done', decisive: true, aggregate: 'CHANGES-NEEDED', seq: 5 }),
        // A non-decisive lens submission never counts as a verdict.
        verdict({ reviewId: 'review-live', seq: 6 }),
        // Today's READY verdict caught four blocking findings.
        verdict({ reviewId: 'review-old-live', decisive: true, aggregate: 'READY', caught: 4, seq: 7 }),
        // A prior-day READY verdict is outside the local day window.
        verdict({ reviewId: 'review-prior-day', decisive: true, aggregate: 'READY', caught: 9, ts: YESTERDAY, seq: 8 }),
      ],
      refusals: [refusal({ seq: 9 }), refusal({ ts: YESTERDAY, seq: 10 })],
      now: NOW,
    });
    expect(counts).toEqual({
      // Only review-live still waits for a verdict: a raise of it is one
      // review, and the other two already hold a decisive verdict.
      armed: 1,
      round: 2,
      tier: 'high',
      verdictsToday: 2,
      caught: 4,
      refusalsToday: 1,
    });
  });

  it('has no live round or tier when nothing is live, and the stage maps 1→advisory, 2→high, auto/3→high+medium', () => {
    const empty = briefingReviewCounts({ armed: [], verdicts: [], refusals: [], now: NOW });
    expect(empty).toEqual({ armed: 0, round: null, tier: null, verdictsToday: 0, caught: 0, refusalsToday: 0 });
    const decided = briefingReviewCounts({
      armed: [armed({ reviewId: 'review-1' })],
      verdicts: [verdict({ reviewId: 'review-1', decisive: true, aggregate: 'READY', caught: 0 })],
      refusals: [],
      now: NOW,
    });
    expect(decided).toMatchObject({ armed: 0, round: null, tier: null, caught: 0 });
    // A first-round READY that superseded nothing says so honestly.
    expect(decided.verdictsToday).toBe(1);
    expect(briefingReviewBoardView({ counts: empty, stage: 1 })).toEqual({ ...empty, stage: 'advisory' });
    expect(briefingReviewBoardView({ counts: decided, stage: 2 })).toMatchObject({ stage: 'high' });
    expect(briefingReviewBoardView({ counts: decided, stage: 3 })).toMatchObject({ stage: 'high+medium' });
    expect(briefingReviewBoardView({ counts: decided, stage: 'auto' })).toMatchObject({ stage: 'high+medium' });
    // The explicit stage arms are exhaustive; an out-of-union value fails loud.
    expect(() => briefingReviewBoardView({ counts: empty, stage: 'bogus' as never })).toThrow(/unhandled/);
    expect(() => tierEnforcedAt('high', 'bogus' as never)).toThrow(/unhandled/);
    expect(briefingReviewBoardView({ counts: null, stage: 2 })).toBeNull();
    expect(EMPTY_BRIEFING_REVIEW_COUNTS).toEqual({ armed: 0, round: null, tier: null, verdictsToday: 0, caught: 0, refusalsToday: 0 });
  });
});

describe('Nefario board view — the bounded read', () => {
  function port(kinds: Readonly<Record<string, readonly unknown[]>>): BriefingReviewLedgerPort & { readonly calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      listEventsAfter: ((seq: number, opts?: { kinds?: readonly string[] }) => {
        const kind = opts?.kinds?.[0] ?? '';
        calls.push(`${kind}:${String(seq)}`);
        return (kinds[kind] ?? []) as EventRecord[];
      }) as BriefingReviewLedgerPort['listEventsAfter'],
      latestEventByPayloadField: () => null,
    };
  }

  const event = (kind: string, payload: Record<string, unknown>, ts: string, seq: number): EventRecord => ({
    seq,
    ts,
    kind,
    agentId: null,
    jobId: null,
    roundId: null,
    lens: null,
    payload,
  });

  it('reads the three kinds and derives the same counts a caller could compute directly', () => {
    const armedPayload = {
      review_id: 'review-1',
      commission_key: 'commission-1',
      chain_key: 'chain-1',
      briefing_sha_256: 'a'.repeat(64),
      repo_path: '/repos/shop',
      title: 'Refunds endpoint',
      tier: 'low',
      justification: 'Small change.',
      round: 1,
      generation: 1,
      lenses: ['stranger'],
      head_sha: null,
    };
    const verdictPayload = {
      review_id: 'review-1',
      chain_key: 'chain-1',
      briefing_sha_256: 'a'.repeat(64),
      lens: 'stranger',
      lens_verdict: 'READY',
      findings: [],
      round: 1,
      generation: 1,
      decisive: true,
      aggregate: 'READY',
      caught: 0,
    };
    const ledger = port({
      'briefing.review-armed': [event('briefing.review-armed', armedPayload, TODAY, 1)],
      'briefing.review-verdict': [event('briefing.review-verdict', verdictPayload, TODAY, 2)],
      'briefing.review-refused': [event('briefing.review-refused', { repo_path: '/repos/shop', title: 'x', briefing_sha_256: 'a'.repeat(64), job_id: 'job-1', tier: 'high', reason: 'pending' }, TODAY, 3)],
    });
    expect(readBriefingReviewCounts(ledger, NOW)).toEqual({
      armed: 0,
      round: null,
      tier: null,
      verdictsToday: 1,
      caught: 0,
      refusalsToday: 1,
    });
    expect(ledger.calls).toEqual(['briefing.review-armed:0', 'briefing.review-verdict:0', 'briefing.review-refused:0']);
  });

  it('yields null when any read hits its limit, and never invents a count from unreadable payloads', () => {
    const limit = 5001;
    const full = Array.from({ length: limit }, (_, index) => event('briefing.review-armed', {}, TODAY, index + 1));
    const truncated = port({ 'briefing.review-armed': full });
    expect(readBriefingReviewCounts(truncated, NOW)).toBeNull();
    // A malformed record is dropped, never guessed at.
    const unreadable = port({ 'briefing.review-verdict': [event('briefing.review-verdict', { review_id: 'review-1' }, TODAY, 1)] });
    expect(readBriefingReviewCounts(unreadable, NOW)).toEqual<BriefingReviewBoardCounts>(EMPTY_BRIEFING_REVIEW_COUNTS);
    // A throwing read propagates: the engine logs it and sends null.
    const throwing: BriefingReviewLedgerPort = {
      listEventsAfter: () => { throw new Error('ledger closed'); },
      latestEventByPayloadField: () => null,
    };
    expect(() => readBriefingReviewCounts(throwing, NOW)).toThrow('ledger closed');
  });
});
