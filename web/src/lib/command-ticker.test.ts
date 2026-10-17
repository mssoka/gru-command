import { describe, expect, it } from 'vitest';
import { radarLabel, roundLabel, tickerSegments, topReviewRound } from './command-ticker.js';
import type { BoardSnapshot, JobView, RoundView } from './board-protocol.js';

function round(seq: number, status: string): RoundView {
  return {
    id: `r${seq}`,
    seq,
    status,
    verdict: null,
    targetRef: null,
    createdAt: '2026-09-23T10:00:00.000Z',
    updatedAt: '2026-09-23T10:00:00.000Z',
    lenses: [],
    lensAttempts: [],
    blockers: 0,
  };
}

function job(id: string, rounds: readonly RoundView[]): JobView {
  return {
    id,
    repo: 'demo',
    title: id,
    status: 'in-review',
    updatedAt: '2026-09-23T10:00:00.000Z',
    prUrl: null,
    prState: null,
    baseBranch: 'main',
    note: null,
    rounds,
    lane: null,
    lastAgentActivity: null,
  };
}

function snapshot(jobs: readonly JobView[]): BoardSnapshot {
  return {
    repos: [{ name: 'demo', jobs }],
    agents: [],
    notifications: [],
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: 'disabled',
      model: '~typesafe/jev-latest',
      endpoint: 'https://example.invalid',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'test',
      generation: 0,
    },
    unackedActionRequired: 0,
    unackedNeedsOwner: 0,
    wakes: { count: 0, lastAt: null },
    build: null,
    silas: null,
    verify: null,
    selfHeal: null,
  };
}

describe('command-bar pills (cockpit rework)', () => {
  it('renders the RADAR and ROUND pills in order; the MODE segment is gone', () => {
    const segments = tickerSegments({
      boardState: 'open',
      snapshot: snapshot([job('j1', [round(4, 'live')]), job('j2', [round(6, 'pending')])]),
    });
    expect(segments.map((segment) => segment.key)).toEqual(['radar', 'round']);
    expect(segments[0]).toEqual({ key: 'radar', label: 'RADAR LIVE', tone: 'ok' });
    expect(segments[1]).toEqual({ key: 'round', label: 'ROUND 4 LIVE', tone: 'live' });
    expect(segments.some((segment) => segment.label.includes('MODE'))).toBe(false);
  });

  it('maps socket states onto radar words and tones', () => {
    expect(radarLabel('open')).toEqual({ label: 'LIVE', tone: 'ok' });
    expect(radarLabel('stale')).toEqual({ label: 'STALE', tone: 'warn' });
    expect(radarLabel('offline')).toEqual({ label: 'DOWN', tone: 'alert' });
    expect(radarLabel('reconnecting').label).toBe('SYNCING');
    expect(radarLabel('connecting').label).toBe('SYNCING');
    expect(radarLabel('authenticating').label).toBe('SYNCING');
    // Before the board client exists (pairing), the radar is honestly idle.
    expect(radarLabel(null)).toEqual({ label: 'IDLE', tone: 'plain' });
  });

  it('labels a quiet board and an unpaired radar honestly', () => {
    const segments = tickerSegments({ boardState: null, snapshot: null });
    expect(segments[0]).toEqual({ key: 'radar', label: 'RADAR IDLE', tone: 'plain' });
    expect(segments[1]).toEqual({ key: 'round', label: 'NO ROUND', tone: 'none' });
  });

  it('a pending round gets its own tone', () => {
    const [, pill] = tickerSegments({ boardState: 'open', snapshot: snapshot([job('a', [round(7, 'pending')])]) });
    expect(pill).toEqual({ key: 'round', label: 'ROUND 7 PENDING', tone: 'pending' });
  });
});

describe('command ticker — top review round', () => {
  it('picks the highest LIVE round across the whole board', () => {
    const top = topReviewRound(snapshot([job('a', [round(2, 'live'), round(9, 'pending')]), job('b', [round(5, 'live')])]));
    expect(top).toEqual({ seq: 5, status: 'live' });
  });

  it('falls back to the highest PENDING round when nothing is live', () => {
    const top = topReviewRound(snapshot([job('a', [round(3, 'verdict-posted')]), job('b', [round(7, 'pending')])]));
    expect(top).toEqual({ seq: 7, status: 'pending' });
    expect(roundLabel(top)).toBe('ROUND 7 PENDING');
  });

  it('reports NO ROUND for an empty or concluded board', () => {
    expect(topReviewRound(null)).toBeNull();
    expect(topReviewRound(snapshot([]))).toBeNull();
    expect(topReviewRound(snapshot([job('a', [round(1, 'aborted'), round(2, 'verdict-posted')])]))).toBeNull();
    expect(roundLabel(null)).toBe('NO ROUND');
  });
});
