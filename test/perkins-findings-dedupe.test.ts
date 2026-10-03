import { describe, expect, it } from 'vitest';
import { dedupeVerifiedFindings, type FindingSeverity, type VerifiedFinding } from '../src/dispatch/perkins-review/types.js';

const TITLE = 'Native settings token reaches the prefix stripper';
const LOCATION = 'src/helper.ts:1';

/** Build one same-key verified finding; round and severity vary per case. */
function finding(severity: FindingSeverity, roundOrigin: number, overrides: Partial<VerifiedFinding> = {}): VerifiedFinding {
  return {
    source: 'lead',
    severity,
    category: 'correctness',
    title: TITLE,
    location: LOCATION,
    evidence: `export function helper(ref: string): string { return ref.slice(ref.indexOf("/") + 1); } /* r${roundOrigin} */`,
    detail: 'The helper strips the prefix without validating it.',
    recommended_fix: 'Validate the prefix before slicing.',
    verification: {
      disposition: 'confirmed',
      evidence: 'return ref.slice(ref.indexOf("/") + 1);',
      reason: `verified in round ${roundOrigin}`,
    },
    sources: ['lead'],
    roundOrigin,
    ...overrides,
  };
}

describe('dedupeVerifiedFindings judgment recency', () => {
  // gh-88 / R26: the stored display origin is the oldest round (Math.min), but
  // it must never decide which same-round duplicate wins the retained judgment.
  it('keeps the round-3 blocker when a later round-3 warning duplicates it after a carried round-2 merge', () => {
    const deduped = dedupeVerifiedFindings([
      finding('blocker', 2, { sources: ['security'] }),
      finding('blocker', 3, { sources: ['codebase'] }),
      finding('warning', 3, { sources: ['tests'] }),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.severity).toBe('blocker');
    expect(deduped[0]?.verification.reason).toBe('verified in round 3');
    expect(deduped[0]?.roundOrigin).toBe(2);
    expect(deduped[0]?.sources).toEqual(['codebase', 'security', 'tests']);
  });

  it('keeps the round-3 blocker when the round-3 warning arrives first (order-independent)', () => {
    const deduped = dedupeVerifiedFindings([
      finding('blocker', 2),
      finding('warning', 3),
      finding('blocker', 3),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.severity).toBe('blocker');
    expect(deduped[0]?.roundOrigin).toBe(2);
  });

  it('lets a genuinely newer round downgrade an older severity (recency, not global max severity)', () => {
    const deduped = dedupeVerifiedFindings([
      finding('blocker', 2, { sources: ['security'] }),
      finding('warning', 3, { sources: ['codebase'] }),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.severity).toBe('warning');
    expect(deduped[0]?.verification.reason).toBe('verified in round 3');
    expect(deduped[0]?.roundOrigin).toBe(2);
    expect(deduped[0]?.sources).toEqual(['codebase', 'security']);
  });

  it('carries the latest judgment through repeated duplicates across several rounds', () => {
    const deduped = dedupeVerifiedFindings([
      finding('note', 2),
      finding('blocker', 3),
      finding('warning', 3),
      finding('blocker', 3),
      finding('warning', 4),
      finding('note', 4),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.severity).toBe('warning');
    expect(deduped[0]?.verification.reason).toBe('verified in round 4');
    expect(deduped[0]?.roundOrigin).toBe(2);
  });

  it('never lets an older carried round replace a newer retained judgment', () => {
    const deduped = dedupeVerifiedFindings([
      finding('note', 3),
      finding('blocker', 2),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.severity).toBe('note');
    expect(deduped[0]?.roundOrigin).toBe(2);
  });

  it('keeps the earlier entry on a same-round same-severity tie and unions sources', () => {
    const deduped = dedupeVerifiedFindings([
      finding('warning', 3, { evidence: 'earlier evidence', sources: ['security'] }),
      finding('warning', 3, { evidence: 'later evidence', sources: ['codebase'] }),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.evidence).toBe('earlier evidence');
    expect(deduped[0]?.sources).toEqual(['codebase', 'security']);
  });

  it('keys on the normalized lowercase title and location', () => {
    const deduped = dedupeVerifiedFindings([
      finding('warning', 3, { title: '  Native  Settings Token ', location: 'src/helper.ts:1' }),
      finding('blocker', 3, { title: 'native settings token', location: '  src/helper.ts:1 ' }),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.severity).toBe('blocker');
    expect(deduped[0]?.roundOrigin).toBe(3);
  });

  it('keeps the severity-desc then location/title output order for distinct keys', () => {
    const deduped = dedupeVerifiedFindings([
      finding('warning', 2, { title: 'Second', location: 'src/b.ts:1' }),
      finding('blocker', 2, { title: 'Top', location: 'src/c.ts:1' }),
      finding('warning', 2, { title: 'First', location: 'src/a.ts:1' }),
    ]);
    expect(deduped.map((entry) => entry.title)).toEqual(['Top', 'First', 'Second']);
    expect(deduped.map((entry) => entry.severity)).toEqual(['blocker', 'warning', 'warning']);
  });

  it('dedupes repeated sources in the retained union and keeps them sorted', () => {
    const deduped = dedupeVerifiedFindings([
      finding('warning', 3, { sources: ['security'] }),
      finding('warning', 3, { sources: ['security', 'tests'] }),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.sources).toEqual(['security', 'tests']);
  });

  it('returns empty and single-entry inputs unchanged', () => {
    expect(dedupeVerifiedFindings([])).toEqual([]);
    const only = finding('note', 2);
    expect(dedupeVerifiedFindings([only])).toEqual([only]);
  });

  it('never mutates its input or its entries', () => {
    const input = [
      finding('blocker', 2, { sources: ['security'] }),
      finding('warning', 3, { sources: ['tests'] }),
    ];
    const snapshot = JSON.stringify(input);
    const deduped = dedupeVerifiedFindings(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input).toHaveLength(2);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]).not.toBe(input[0]);
    expect(deduped[0]).not.toBe(input[1]);
    expect(deduped[0]?.sources).toEqual(['security', 'tests']);
  });
});
