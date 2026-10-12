import { describe, expect, it } from 'vitest';
import {
  PUBLICATION_ABSENT_EVENT,
  PUBLICATION_ATTEMPT_EVENT,
  PUBLICATION_REBIND_UNRESOLVED_EVENT,
  PUBLICATION_RECEIPT_EVENT,
  parsePublicationAbsentPayload,
  parsePublicationAttemptPayload,
  parsePublicationIdentityPayload,
  pendingPublicationAttempt,
  type PublicationEvidenceReader,
} from '../src/dispatch/publication-evidence.js';

const TARGET = '1'.repeat(40);

const attempt = {
  verdict: 'approved', canonicalVerdict: 'READY TO MERGE',
  url: 'https://github.com/acme/widget/pull/7', host: 'github.com',
  targetSha: TARGET, baseSha: '2'.repeat(40),
  publicationFile: '/tmp/round/perkins-report.publication.md', publicationSha256: 'a'.repeat(64),
  reviewEvent: 'APPROVE',
} as const;

const receipt = {
  reviewId: '9001', actor: 'gru-bot', event: 'APPROVED', commitId: TARGET,
  headSha: TARGET, baseSha: '2'.repeat(40), bodySha256: 'a'.repeat(64),
} as const;

/** One immutable round-event stream read through the guard's exact seam. */
function ledgerWith(events: ReadonlyArray<{ kind: string; seq: number; payload: unknown }>): PublicationEvidenceReader {
  return {
    latestRoundEvent: (_roundId: string, kind: string) => {
      const matching = events.filter((event) => event.kind === kind);
      const latest = matching[matching.length - 1];
      return latest === undefined ? null : { seq: latest.seq, payload: latest.payload };
    },
  };
}

describe('publication re-arm guard', () => {
  it('clears a round that never recorded a publication attempt', () => {
    expect(pendingPublicationAttempt(ledgerWith([]), 'r1')).toBeNull();
  });

  it('does not let an absence record override a later retained provider receipt', () => {
    const problem = pendingPublicationAttempt(ledgerWith([
      { kind: PUBLICATION_ATTEMPT_EVENT, seq: 1, payload: attempt },
      { kind: PUBLICATION_ABSENT_EVENT, seq: 2, payload: { targetSha: TARGET, publicationSha256: attempt.publicationSha256, detail: 'bounded absence' } },
      { kind: PUBLICATION_RECEIPT_EVENT, seq: 3, payload: { ...attempt, receipt, credited: false, reason: 'recovered receipt' } },
    ]), 'receipt-after-absence');
    expect(problem?.kind).toBe('uncredited-receipt');
    expect(problem?.detail).toContain('9001');
  });

  it('does not clear an absence whose target or body digest differs from the attempt or is malformed', () => {
    const mismatches: readonly unknown[] = [
      { targetSha: '3'.repeat(40), publicationSha256: attempt.publicationSha256, detail: 'wrong target' },
      { targetSha: attempt.targetSha, publicationSha256: 'b'.repeat(64), detail: 'wrong digest' },
      { targetSha: attempt.targetSha, publicationSha256: attempt.publicationSha256 },
    ];
    for (const [index, absence] of mismatches.entries()) {
      const problem = pendingPublicationAttempt(ledgerWith([
        { kind: PUBLICATION_ATTEMPT_EVENT, seq: 1, payload: attempt },
        { kind: PUBLICATION_ABSENT_EVENT, seq: 2, payload: absence },
      ]), `mismatch-${index}`);
      expect(problem?.kind).toBe('unresolved-attempt');
    }
  });

  it('holds a bare attempt as unresolved until its provider outcome is reconciled', () => {
    const problem = pendingPublicationAttempt(ledgerWith([
      { kind: PUBLICATION_ATTEMPT_EVENT, seq: 1, payload: attempt },
    ]), 'r1');
    expect(problem?.kind).toBe('unresolved-attempt');
    expect(problem?.detail).toContain(TARGET);
  });

  it('holds an uncredited receipt even when its publication-attempt marker is missing', () => {
    const problem = pendingPublicationAttempt(ledgerWith([
      { kind: PUBLICATION_RECEIPT_EVENT, seq: 1, payload: { ...attempt, receipt, credited: false, reason: 'recovered receipt' } },
    ]), 'r1');
    expect(problem?.kind).toBe('uncredited-receipt');
    expect(problem?.detail).toContain('9001');
    expect(problem?.detail).toContain(TARGET);

    const malformed = pendingPublicationAttempt(ledgerWith([
      { kind: PUBLICATION_RECEIPT_EVENT, seq: 1, payload: { credited: false, reason: 'malformed' } },
    ]), 'malformed-r1');
    expect(malformed?.kind).toBe('uncredited-receipt');
    expect(malformed?.detail).toContain('unknown');

    const laterAbsence = pendingPublicationAttempt(ledgerWith([
      { kind: PUBLICATION_RECEIPT_EVENT, seq: 1, payload: { ...attempt, receipt, credited: false, reason: 'recovered receipt' } },
      { kind: PUBLICATION_ABSENT_EVENT, seq: 2, payload: { targetSha: TARGET, publicationSha256: attempt.publicationSha256, detail: 'contradictory later absence' } },
    ]), 'receipt-before-absence');
    expect(laterAbsence?.kind).toBe('uncredited-receipt');
    expect(laterAbsence?.detail).toContain('9001');
  });

  it('holds an uncredited receipt as a provider write that must be reconciled first', () => {
    const problem = pendingPublicationAttempt(ledgerWith([
      { kind: PUBLICATION_ATTEMPT_EVENT, seq: 1, payload: attempt },
      { kind: PUBLICATION_RECEIPT_EVENT, seq: 2, payload: { ...attempt, receipt, credited: false, reason: 'pending-finality-checks' } },
    ]), 'r1');
    expect(problem?.kind).toBe('uncredited-receipt');
    expect(problem?.detail).toContain('9001');
  });

  it('clears only a bounded absence for an attempt with no recorded delivery', () => {
    expect(pendingPublicationAttempt(ledgerWith([
      { kind: PUBLICATION_ATTEMPT_EVENT, seq: 1, payload: attempt },
      { kind: PUBLICATION_ABSENT_EVENT, seq: 2, payload: { targetSha: TARGET, publicationSha256: 'a'.repeat(64), detail: 'proved absent' } },
    ]), 'r1')).toBeNull();
  });

  it('holds ANY recorded delivery whose credit is unresolved, with or without intent or marker', () => {
    // The pre-upgrade terminal shape: a historical round.posted (COMMENT-era
    // receipt, no intent, no marker) aborted after an unbound promotion.
    const historical = {
      verdict: 'approved', canonicalVerdict: 'READY TO MERGE',
      url: 'https://github.com/acme/widget/pull/7', host: 'github.com',
      targetSha: TARGET, baseSha: 'b'.repeat(40),
      publicationFile: '/tmp/round/perkins-report.publication.md', publicationSha256: 'a'.repeat(64),
      receipt: { reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: TARGET, headSha: TARGET, baseSha: 'b'.repeat(40), bodySha256: 'a'.repeat(64) },
      reconciled: false,
    };
    const noIntent = pendingPublicationAttempt(ledgerWith([
      { kind: 'round.posted', seq: 1, payload: historical },
    ]), 'r1');
    expect(noIntent?.kind).toBe('recorded-delivery-unresolved');
    expect(noIntent?.detail).toContain(TARGET);
    expect(noIntent?.detail).toContain('9001');
    // An attempt whose delivered record was never credited holds the same way.
    expect(pendingPublicationAttempt(ledgerWith([
      { kind: PUBLICATION_ATTEMPT_EVENT, seq: 1, payload: attempt },
      { kind: 'round.posted', seq: 2, payload: historical },
    ]), 'r1')?.kind).toBe('recorded-delivery-unresolved');
    // A stale marker does not change that: the later recorded delivery is
    // still uncredited.
    expect(pendingPublicationAttempt(ledgerWith([
      { kind: PUBLICATION_REBIND_UNRESOLVED_EVENT, seq: 1, payload: { targetSha: TARGET, reviewId: '9001', detail: 'old rebind failure' } },
      { kind: 'round.posted', seq: 2, payload: historical },
    ]), 'r1')?.kind).toBe('recorded-delivery-unresolved');
  });

  it('holds a marker-only recorded delivery (no durable intent) as unresolved rebinding', () => {
    // The pre-upgrade shape with a failed rebind marker: the marker check
    // precedes the recorded-delivery hold and names the failed rebinding.
    const problem = pendingPublicationAttempt(ledgerWith([
      { kind: 'round.posted', seq: 1, payload: { verdict: 'approved' } },
      { kind: PUBLICATION_REBIND_UNRESOLVED_EVENT, seq: 2, payload: { targetSha: TARGET, reviewId: '9001', detail: 'unbound at restart' } },
    ]), 'r1');
    expect(problem?.kind).toBe('unresolved-rebinding');
    expect(problem?.detail).toContain('9001');
    expect(problem?.detail).toContain(TARGET);
  });

  it('requires formal publication intent to agree with its verdict while preserving COMMENT', () => {
    expect(parsePublicationAttemptPayload({ ...attempt, reviewEvent: 'REQUEST_CHANGES' })).toBeNull();
    expect(parsePublicationAttemptPayload({ ...attempt, reviewEvent: 'COMMENT' })).not.toBeNull();
    const changesRequested = {
      ...attempt, verdict: 'changes-requested', canonicalVerdict: 'NEEDS CHANGES', reviewEvent: 'APPROVE',
    };
    expect(parsePublicationAttemptPayload(changesRequested)).toBeNull();
    expect(parsePublicationAttemptPayload({ ...changesRequested, reviewEvent: 'REQUEST_CHANGES' })).not.toBeNull();
  });

  it('parses a well-formed prepared posting identity and rejects malformed evidence', () => {
    expect(parsePublicationIdentityPayload({ actor: 'gru-bot', host: 'github.com', targetSha: TARGET }))
      .toEqual({ actor: 'gru-bot', host: 'github.com', targetSha: TARGET });
    // Malformed/absent identity evidence never certifies a restart absence.
    expect(parsePublicationIdentityPayload({ actor: 'gru-bot', host: 'github.com' })).toBeNull();
    expect(parsePublicationIdentityPayload({ actor: '', host: 'github.com', targetSha: TARGET })).toBeNull();
    expect(parsePublicationIdentityPayload({ actor: 7, host: 'github.com', targetSha: TARGET })).toBeNull();
    expect(parsePublicationIdentityPayload(null)).toBeNull();
  });

  it('fails closed on a malformed attempt or absence payload', () => {
    expect(pendingPublicationAttempt(ledgerWith([
      { kind: PUBLICATION_ATTEMPT_EVENT, seq: 1, payload: { verdict: 'approved' } },
    ]), 'r1')?.kind).toBe('unresolved-attempt');
    // A malformed absence certificate is not a conclusion.
    expect(pendingPublicationAttempt(ledgerWith([
      { kind: PUBLICATION_ATTEMPT_EVENT, seq: 1, payload: attempt },
      { kind: PUBLICATION_ABSENT_EVENT, seq: 2, payload: { targetSha: TARGET } },
    ]), 'r1')?.kind).toBe('unresolved-attempt');

    // Matching arbitrary strings are not publication-digest evidence. Both
    // the intent and the absence marker must carry canonical SHA-256 hex.
    const malformedDigests = ['x', 'a'.repeat(63), 'g'.repeat(64), 'A'.repeat(64), 'a'.repeat(65)];
    for (const [index, digest] of malformedDigests.entries()) {
      expect(parsePublicationAttemptPayload({ ...attempt, publicationSha256: digest })).toBeNull();
      expect(parsePublicationAbsentPayload({ targetSha: TARGET, publicationSha256: digest, detail: 'bounded absence' })).toBeNull();
      expect(pendingPublicationAttempt(ledgerWith([
        { kind: PUBLICATION_ATTEMPT_EVENT, seq: 1, payload: { ...attempt, publicationSha256: digest } },
        { kind: PUBLICATION_ABSENT_EVENT, seq: 2, payload: { targetSha: TARGET, publicationSha256: digest, detail: 'bounded absence' } },
      ]), `malformed-digest-${index}`)?.kind).toBe('unresolved-attempt');
    }
  });

  it('holds a recorded delivery that predates the attempt as recorded-but-uncredited', () => {
    // A posted event OLDER than the latest attempt is still an uncredited
    // recorded delivery (the round is aborted at consultation time).
    expect(pendingPublicationAttempt(ledgerWith([
      { kind: 'round.posted', seq: 1, payload: { verdict: 'approved' } },
      { kind: PUBLICATION_ATTEMPT_EVENT, seq: 2, payload: attempt },
    ]), 'r1')?.kind).toBe('recorded-delivery-unresolved');
  });
});
