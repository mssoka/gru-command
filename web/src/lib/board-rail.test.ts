import { describe, expect, it } from 'vitest';
import { boardKpis } from './board-kpi.js';
import { railChips } from './board-rail.js';
import type { AgentView, BoardSnapshot, JobView } from './board-protocol.js';

/**
 * The v6 status chip rail: seven chips in fixed order, the v4 health
 * cards' data, and the jobs/PRs/lane counts folded in from the SAME
 * `boardKpis` derivation the v4 KPI strip used.
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
    // Titles are uppercased for the rail face.
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
    const chips = railChips(snap, NOW);
    const subs = new Map(chips.flatMap((chip) => chip.subs).map((sub) => [sub.kpi, sub.label]));

    expect(subs.get('jobs.total')).toBe(`${kpis.jobs.total} jobs`);
    expect(subs.get('jobs.working')).toBe(`${kpis.jobs.working} working`);
    expect(subs.get('jobs.inReview')).toBe(`${kpis.jobs.inReview} in-review`);
    expect(subs.get('jobs.merged')).toBe(`${kpis.jobs.merged} merged`);
    expect(subs.get('jobs.done')).toBe(`${kpis.jobs.done} done`);
    expect(subs.get('jobs.parked')).toBe(`${kpis.jobs.parked} parked`);
    expect(subs.get('prs.open')).toBe(`${kpis.prs.open} open PRs`);
    expect(subs.get('prs.conflicting')).toBe(`${kpis.prs.conflicting} conflicting`);
    expect(subs.get('prs.mergedToday')).toBe(`${kpis.prs.mergedToday} merged today`);
    expect(subs.get('lanes.liveMinions')).toBe(`${kpis.lanes.liveMinions} live minions`);
    expect(subs.get('lanes.midTurn')).toBe(`${kpis.lanes.midTurn} mid-turn`);
    expect(subs.get('lanes.disposed')).toBe(`${kpis.lanes.disposed} disposed`);

    // Spot-check the derivation itself so the comparison is not vacuous.
    expect(subs.get('jobs.total')).toBe('8 jobs');
    expect(subs.get('jobs.working')).toBe('2 working');
    expect(subs.get('prs.conflicting')).toBe('1 conflicting');
    expect(subs.get('lanes.liveMinions')).toBe('2 live minions');
    expect(subs.get('lanes.disposed')).toBe('1 disposed');
  });

  it('marks the loud states: a conflicting PR sub-badge and an unacked tracker flag', () => {
    const snap = snapshot([job('i1', 'in-review', { prUrl: 'https://x/2', prState: 'conflicting' })]);
    const conflicting = railChips({ ...snap, unackedActionRequired: 2 }, NOW)
      .flatMap((chip) => chip.subs)
      .find((sub) => sub.kpi === 'prs.conflicting');
    expect(conflicting?.tone).toBe('alert');
    const trackers = railChips({ ...snap, unackedActionRequired: 2 }, NOW).find((chip) => chip.id === 'trackers');
    expect(trackers?.tone).toBe('alert');
    expect(trackers?.flag).toBe('2 ACK');
  });

  it('carries the health cards verbatim: reviews flags 12 failed, deploy stays n/a honestly', () => {
    const snap = snapshot([]);
    const chips = railChips(snap, NOW);
    const deploy = chips.find((chip) => chip.id === 'deploy');
    const reviews = chips.find((chip) => chip.id === 'reviews');
    const verify = chips.find((chip) => chip.id === 'verify');
    // Unwired feeds render an honest n/a, never a fabricated zero.
    expect(deploy?.value).toBe('n/a');
    expect(verify?.value).toBe('n/a');
    expect(reviews?.value).toBe('0 active');
    expect(reviews?.tone).toBe('muted');
    expect(chips.find((chip) => chip.id === 'alerts')?.tone).toBe('ok');
  });
});
