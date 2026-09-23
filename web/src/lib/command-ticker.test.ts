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
    build: null,
    silas: null,
    verify: null,
    selfHeal: null,
  };
}

describe('command ticker (v6)', () => {
  it('renders MODE / RADAR / ROUND segments in order', () => {
    const segments = tickerSegments({
      view: 'board',
      layout: 'cockpit',
      boardState: 'open',
      snapshot: snapshot([job('j1', [round(4, 'live')]), job('j2', [round(6, 'pending')])]),
    });
    expect(segments.map((segment) => segment.key)).toEqual(['mode', 'radar', 'round']);
    expect(segments[0]?.label).toBe('MODE: COCKPIT · BOARD');
    expect(segments[1]?.label).toBe('RADAR: LIVE');
    expect(segments[1]?.tone).toBe('ok');
    expect(segments[2]?.label).toBe('ROUND 4 ACTIVE');
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

  it('labels the mobile lens and a quiet board honestly', () => {
    const segments = tickerSegments({
      view: 'chat',
      layout: 'single',
      boardState: null,
      snapshot: null,
    });
    expect(segments[0]?.label).toBe('MODE: MOBILE · CHAT');
    expect(segments[1]?.label).toBe('RADAR: IDLE');
    expect(segments[2]?.label).toBe('NO ROUND ACTIVE');
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

  it('reports NO ROUND ACTIVE for an empty or concluded board', () => {
    expect(topReviewRound(null)).toBeNull();
    expect(topReviewRound(snapshot([]))).toBeNull();
    expect(topReviewRound(snapshot([job('a', [round(1, 'aborted'), round(2, 'verdict-posted')])]))).toBeNull();
    expect(roundLabel(null)).toBe('NO ROUND ACTIVE');
  });
});
