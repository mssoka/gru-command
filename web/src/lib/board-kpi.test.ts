import { describe, expect, it } from 'vitest';
import type { AgentView, BoardSnapshot, JobView } from './board-protocol.js';
import { boardKpis, derivedPrState, jobStatusCounts, laneCounts, prCounts } from './board-kpi.js';

const NOW = new Date(2026, 8, 23, 12, 0, 0); // local noon — day-boundary tests stay timezone-robust
const ISO = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();

function job(id: string, overrides: Partial<JobView> = {}): JobView {
  return {
    id,
    repo: 'demo',
    title: id,
    status: 'working',
    updatedAt: ISO(-3_600_000),
    prUrl: null,
    prState: null,
    baseBranch: null,
    note: null,
    rounds: [],
    lane: null,
    lastAgentActivity: null,
    ...overrides,
  };
}

function agent(id: string, overrides: Partial<AgentView> = {}): AgentView {
  return {
    id,
    role: 'minion',
    label: null,
    state: 'idle',
    lastActivity: null,
    sessionFile: null,
    jobId: null,
    roundId: null,
    supervision: null,
    ...overrides,
  };
}

function fixture(): BoardSnapshot {
  return {
    repos: [
      {
        name: 'demo',
        jobs: [
          job('working-1'),
          job('working-2'),
          job('review-1', { status: 'in-review' }),
          job('merged-today', { status: 'merged', prUrl: 'https://x/1', prState: 'merged', updatedAt: ISO(-3_600_000) }),
          job('merged-old', { status: 'merged', prUrl: 'https://x/2', prState: 'merged', updatedAt: ISO(-72 * 3_600_000) }),
          job('done-1', { status: 'done' }),
          job('parked-1', { status: 'parked' }),
          job('blocked-1', { status: 'blocked' }),
          job('conflicting-1', { status: 'in-review', prUrl: 'https://x/3', prState: 'conflicting' }),
          job('open-1', { status: 'in-review', prUrl: 'https://x/4', prState: 'open' }),
        ],
      },
      { name: 'site', jobs: [job('dispatched-1', { status: 'dispatched' })] },
    ],
    agents: [
      agent('minion-live-1', { state: 'streaming', lastActivity: ISO(-30_000) }),
      agent('minion-live-2', { state: 'idle' }),
      agent('minion-old', { state: 'disposed' }),
      agent('lens-streaming', { role: 'perkins', state: 'streaming', lastActivity: ISO(-900_000) }),
      agent('silas', { role: 'silas', state: 'streaming', lastActivity: ISO(-5_000) }),
      agent('another-disposed', { role: 'gru', state: 'disposed' }),
    ],
    notifications: [],
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: null,
      model: 'm',
      endpoint: 'e',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'x',
      generation: 0,
    },
    unackedActionRequired: 0,
  };
}

describe('board KPIs — counts over the live snapshot', () => {
  it('counts the five job statuses listed on the strip (blocked/dispatched stay off it)', () => {
    const snapshot = fixture();
    const kpis = boardKpis(snapshot, NOW);
    expect(kpis.jobs).toEqual({ working: 2, inReview: 3, merged: 2, done: 1, parked: 1, total: 11 });
  });

  it('counts PRs: open, conflicting, merged today (old merges excluded)', () => {
    const jobs = fixture().repos.flatMap((repo) => repo.jobs);
    expect(prCounts(jobs, NOW)).toEqual({ open: 1, conflicting: 1, mergedToday: 1 });
  });

  it('derives PR state from the record when no producer has written it', () => {
    expect(derivedPrState(job('no-pr'))).toBeNull();
    expect(derivedPrState(job('url', { prUrl: 'https://x/1' }))).toBe('open');
    expect(derivedPrState(job('merged', { status: 'merged' }))).toBe('merged');
    // An explicit wire value always wins.
    expect(derivedPrState(job('wire', { prUrl: 'https://x/2', prState: 'conflicting' }))).toBe('conflicting');
  });

  it('counts lanes: live minions, mid-turn with the oldest quiet stamp, disposed', () => {
    const lanes = laneCounts(fixture().agents);
    expect(lanes.liveMinions).toBe(2); // the disposed minion is not live
    expect(lanes.midTurn).toBe(3); // two minions + one lens stream right now
    expect(lanes.midTurnOldestAt).toBe(ISO(-900_000)); // oldest quiet turn surfaces
    expect(lanes.disposed).toBe(2);
  });

  it('counts nothing rather than NaN on an empty board', () => {
    const empty = { ...fixture(), repos: [], agents: [] };
    const kpis = boardKpis(empty, NOW);
    expect(kpis.jobs).toEqual({ working: 0, inReview: 0, merged: 0, done: 0, parked: 0, total: 0 });
    expect(kpis.prs).toEqual({ open: 0, conflicting: 0, mergedToday: 0 });
    expect(kpis.lanes).toEqual({ liveMinions: 0, midTurn: 0, midTurnOldestAt: null, disposed: 0 });
  });

  it('jobStatusCounts ignores unknown statuses in the named buckets but counts them in total', () => {
    const counts = jobStatusCounts([job('a'), job('b', { status: 'future-status' })]);
    expect(counts).toMatchObject({ working: 1, total: 2 });
  });
});
