import { describe, expect, it } from 'vitest';
import {
  PUBLICATION_ABSENT_EVENT,
  PUBLICATION_ATTEMPT_EVENT,
  PUBLICATION_RECEIPT_EVENT,
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

  it('holds a bare attempt as unresolved until its provider outcome is reconciled', () => {
    const problem = pendingPublicationAttempt(ledgerWith([
      { kind: PUBLICATION_ATTEMPT_EVENT, seq: 1, payload: attempt },
    ]), 'r1');
    expect(problem?.kind).toBe('unresolved-attempt');
    expect(problem?.detail).toContain(TARGET);
  });

  it('holds an uncredited receipt as a provider write that must be reconciled first', () => {
    const problem = pendingPublicationAttempt(ledgerWith([
      { kind: PUBLICATION_ATTEMPT_EVENT, seq: 1, payload: attempt },
      { kind: PUBLICATION_RECEIPT_EVENT, seq: 2, payload: { ...attempt, receipt, credited: false, reason: 'pending-finality-checks' } },
    ]), 'r1');
    expect(problem?.kind).toBe('uncredited-receipt');
    expect(problem?.detail).toContain('9001');
  });

  it('clears an attempt that a later credited round.posted or bounded absence resolved', () => {
    expect(pendingPublicationAttempt(ledgerWith([
      { kind: PUBLICATION_ATTEMPT_EVENT, seq: 1, payload: attempt },
      { kind: 'round.posted', seq: 2, payload: { verdict: 'approved' } },
    ]), 'r1')).toBeNull();
    expect(pendingPublicationAttempt(ledgerWith([
      { kind: PUBLICATION_ATTEMPT_EVENT, seq: 1, payload: attempt },
      { kind: PUBLICATION_ABSENT_EVENT, seq: 2, payload: { targetSha: TARGET, publicationSha256: 'a'.repeat(64), detail: 'proved absent' } },
    ]), 'r1')).toBeNull();
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
  });

  it('ignores an attempt superseded by an earlier posted/absence event order', () => {
    // A posted/absence event OLDER than the latest attempt cannot resolve it.
    expect(pendingPublicationAttempt(ledgerWith([
      { kind: 'round.posted', seq: 1, payload: { verdict: 'approved' } },
      { kind: PUBLICATION_ATTEMPT_EVENT, seq: 2, payload: attempt },
    ]), 'r1')?.kind).toBe('unresolved-attempt');
  });
});
