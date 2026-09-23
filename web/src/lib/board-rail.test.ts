import { describe, expect, it } from 'vitest';
import { boardKpis } from './board-kpi.js';
import { railChips } from './board-rail.js';
import type { AgentView, BoardSnapshot, JobView } from './board-protocol.js';

/**
 * The v6 status chip rail: seven chips in fixed order, the v4 health
 * cards' data, and the jobs/PRs/lane counts folded into the TRACKERS
 * chip from the SAME `boardKpis` derivation the v4 KPI strip used.
 */

const NOW = Date.now();

function job(id: string, status: string, overrides: Partial<JobView> = {}): JobView {
  return {
    id,
    repo: 'demo',
    title: id,
    status,
    updatedAt: '2026-01-01T00:00:00.000Z',
    prUrl: null,
    prState: null,
    baseBranch: 'main',
    note: null,
    rounds: [],
    lane: null,
    lastAgentActivity: null,
    ...overrides,
  };
}

function agent(id: string, state: string, role = 'minion'): AgentView {
  return { id, role, label: id, state, lastActivity: null, sessionFile: null, jobId: null, roundId: null, supervision: null };
}

function snapshot(jobs: readonly JobView[], agents: readonly AgentView[] = []): BoardSnapshot {
  return {
    repos: [{ name: 'demo', jobs }],
    agents,
    notifications: [],
    decisions: {
      enabled: true,
      status: 'ready',
      reason: null,
      model: 'typesafe/jev',
      endpoint: 'https://example.invalid',
      credentialPresent: true,
      credentialSource: 'file',
      checkedAt: null,
      incarnation: 'test',
      generation: 1,
    },
    unackedActionRequired: 0,
    build: null,
    silas: null,
    verify: null,
    selfHeal: null,
  };
}

function kpiValues(chips: ReturnType<typeof railChips>): Map<string, number> {
  const values = new Map<string, number>();
  for (const chip of chips) {
    for (const group of chip.kpis ?? []) {
      if (group.total !== undefined) values.set(group.total.kpi, group.total.value);
      for (const value of group.values) values.set(value.kpi, value.value);
    }
  }
  return values;
}

describe('board rail — chips (v6)', () => {
  it('renders the seven chips in the fixed deploy→trackers order', () => {
    const chips = railChips(snapshot([job('w1', 'working')]), NOW);
    expect(chips.map((chip) => chip.id)).toEqual([
      'deploy',
      'reviews',
      'silas',
      'alerts',
      'verify',
      'cure',
      'trackers',
    ]);
    expect(chips.map((chip) => chip.label)).toEqual([
      'DEPLOY',
      'REVIEWS',
      'SILAS',
      'ALERTS',
      'VERIFY',
      'CURE',
      'TRACKERS',
    ]);
  });

  it('folds three KPI groups (jobs/PRs/lanes) into the trackers chip', () => {
    const chips = railChips(snapshot([job('w1', 'working')]), NOW);
    const trackers = chips.find((chip) => chip.id === 'trackers');
    expect(trackers?.kpis?.map((group) => group.label)).toEqual(['JOBS', 'PRS', 'LANES']);
    expect(trackers?.kpis?.map((group) => group.title)).toEqual([
      'working / in-review / merged / done / parked',
      'open / conflicting / merged today',
      'live minions / mid-turn / disposed',
    ]);
    // The health chips carry no folded counts (their flags are the health
    // card's own sub-badge — e.g. REVIEWS carries "12 FAILED").
    expect(chips.filter((chip) => chip.id !== 'trackers').every((chip) => chip.kpis === undefined)).toBe(true);
  });

  it('every folded count equals the v4 KPI derivation (same snapshot)', () => {
    const snap = snapshot(
      [
        job('w1', 'working'),
        job('w2', 'working'),
        job('r1', 'in-review'),
        job('m1', 'merged', { prUrl: 'https://x/1', prState: 'merged', updatedAt: new Date(NOW).toISOString() }),
        job('d1', 'done'),
        job('p1', 'parked'),
        job('i1', 'in-review', { prUrl: 'https://x/2', prState: 'conflicting' }),
        job('o1', 'in-review', { prUrl: 'https://x/3', prState: 'open' }),
      ],
      [
        agent('minion-live', 'streaming'),
        agent('minion-idle', 'idle'),
        agent('minion-dead', 'disposed'),
        agent('lens', 'streaming', 'perkins'),
      ],
    );
    const kpis = boardKpis(snap, new Date(NOW));
    const values = kpiValues(railChips(snap, NOW));

    expect(values.get('jobs.total')).toBe(kpis.jobs.total);
    expect(values.get('jobs.working')).toBe(kpis.jobs.working);
    expect(values.get('jobs.inReview')).toBe(kpis.jobs.inReview);
    expect(values.get('jobs.merged')).toBe(kpis.jobs.merged);
    expect(values.get('jobs.done')).toBe(kpis.jobs.done);
    expect(values.get('jobs.parked')).toBe(kpis.jobs.parked);
    expect(values.get('prs.open')).toBe(kpis.prs.open);
    expect(values.get('prs.conflicting')).toBe(kpis.prs.conflicting);
    expect(values.get('prs.mergedToday')).toBe(kpis.prs.mergedToday);
    expect(values.get('lanes.liveMinions')).toBe(kpis.lanes.liveMinions);
    expect(values.get('lanes.midTurn')).toBe(kpis.lanes.midTurn);
    expect(values.get('lanes.disposed')).toBe(kpis.lanes.disposed);

    // Spot-check the derivation itself so the comparison is not vacuous.
    expect(values.get('jobs.total')).toBe(8);
    expect(values.get('jobs.working')).toBe(2);
    expect(values.get('prs.conflicting')).toBe(1);
    expect(values.get('lanes.liveMinions')).toBe(2);
    expect(values.get('lanes.disposed')).toBe(1);
  });

  it('marks the loud states: an unacked tracker chip flags the count', () => {
    const snap = snapshot([job('i1', 'in-review', { prUrl: 'https://x/2', prState: 'conflicting' })]);
    const trackers = railChips({ ...snap, unackedActionRequired: 2 }, NOW).find((chip) => chip.id === 'trackers');
    expect(trackers?.tone).toBe('alert');
    expect(trackers?.detail).toContain('2 action-required');
  });

  it('carries the health cards verbatim: unwired feeds stay an honest n/a', () => {
    const chips = railChips(snapshot([]), NOW);
    const deploy = chips.find((chip) => chip.id === 'deploy');
    const reviews = chips.find((chip) => chip.id === 'reviews');
    const verify = chips.find((chip) => chip.id === 'verify');
    expect(deploy?.value).toBe('n/a');
    expect(verify?.value).toBe('n/a');
    expect(reviews?.value).toBe('0 active');
    expect(reviews?.tone).toBe('muted');
    expect(chips.find((chip) => chip.id === 'alerts')?.tone).toBe('ok');
  });
});
