import { describe, expect, it } from 'vitest';
import { boardKpis, collectJobs } from './board-kpi.js';
import { railChips } from './board-rail.js';
import type { AgentView, BoardSnapshot, ChildWorkerCounts, JobView } from './board-protocol.js';

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

function snapshot(
  jobs: readonly JobView[],
  agents: readonly AgentView[] = [],
  children: ChildWorkerCounts | null = { queued: 2, active: 3, finished: 5, lifetimeCreations: 10 },
): BoardSnapshot {
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
    unackedNeedsOwner: 0,
    wakes: { count: 0, lastAt: null },
    build: null,
    silas: null,
    verify: null,
    selfHeal: null,
    children,
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

  it('folds the KPI groups (heists/PRs/crew/children) into the trackers chip', () => {
    const chips = railChips(snapshot([job('w1', 'working')]), NOW);
    const trackers = chips.find((chip) => chip.id === 'trackers');
    expect(trackers?.kpis?.map((group) => group.label)).toEqual(['HEISTS', 'PRS', 'CREW', 'CHILDREN']);
    expect(trackers?.kpis?.map((group) => group.title)).toEqual([
      'working / in-review / merged / done / parked / binned',
      'open / conflicting / merged today',
      'live minions / crew mid-turn / crew disposed',
      'child workers active / queued / finished / created (lifetime logical creations)',
    ]);
    // CREW, not MINIONS: midTurn/disposed count every agent (gru, silas,
    // lens children too) — the label must not promise minions only.
    const crewGroup = trackers?.kpis?.[2];
    expect(crewGroup?.values.map((value) => value.kpi)).toEqual([
      'lanes.liveMinions',
      'lanes.midTurn',
      'lanes.disposed',
    ]);
    // Issue #161: the children group carries present-state counts plus
    // the lifetime logical-creation counter.
    expect(trackers?.kpis?.[3]?.values.map((value) => value.kpi)).toEqual([
      'children.active',
      'children.queued',
      'children.finished',
      'children.lifetimeCreations',
    ]);
    // The health chips carry no folded counts (their flags are the health
    // card's own sub-badge — e.g. REVIEWS carries "12 FAILED").
    expect(chips.filter((chip) => chip.id !== 'trackers').every((chip) => chip.kpis === undefined)).toBe(true);
  });

  it('omits the CHILDREN group when the server reports no child counters (unknown ≠ zero)', () => {
    const chips = railChips(snapshot([job('w1', 'working')], [], null), NOW);
    const trackers = chips.find((chip) => chip.id === 'trackers');
    expect(trackers?.kpis?.map((group) => group.label)).toEqual(['HEISTS', 'PRS', 'CREW']);
    const keys = [...(trackers?.kpis ?? [])].flatMap((group) => group.values.map((value) => value.kpi));
    expect(keys.some((key) => key.startsWith('children.'))).toBe(false);
  });

  it('labels every folded count beside its number (v6.1 ruling 5)', () => {
    const chips = railChips(snapshot([job('w1', 'working')]), NOW);
    const trackers = chips.find((chip) => chip.id === 'trackers');
    for (const group of trackers?.kpis ?? []) {
      for (const value of group.values) {
        expect(value.label, value.kpi).not.toBe('');
      }
    }
    const labels = (trackers?.kpis ?? []).flatMap((group) => group.values.map((value) => value.label));
    expect(labels).toEqual([
      'working',
      'in review',
      'merged',
      'done',
      'parked',
      'binned',
      'open',
      'conflicting',
      'merged today',
      'minions',
      'mid-turn',
      'disposed',
      'active',
      'queued',
      'finished',
      'created',
    ]);
    // No bare slash counters survive — the operator reads the label order.
    expect(trackers?.kpis?.every((group) => group.values.every((value) => value.label !== undefined))).toBe(true);
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
        job('b1', 'binned'),
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
    expect(values.get('jobs.binned')).toBe(1);
    expect(values.get('jobs.binned')).toBe(kpis.jobs.binned);
    expect(values.get('prs.open')).toBe(kpis.prs.open);
    expect(values.get('prs.conflicting')).toBe(kpis.prs.conflicting);
    expect(values.get('prs.mergedToday')).toBe(kpis.prs.mergedToday);
    expect(values.get('lanes.liveMinions')).toBe(kpis.lanes.liveMinions);
    expect(values.get('lanes.midTurn')).toBe(kpis.lanes.midTurn);
    expect(values.get('lanes.disposed')).toBe(kpis.lanes.disposed);
    expect(kpis.children).not.toBeNull();
    expect(values.get('children.active')).toBe(kpis.children!.active);
    expect(values.get('children.queued')).toBe(kpis.children!.queued);
    expect(values.get('children.finished')).toBe(kpis.children!.finished);
    expect(values.get('children.lifetimeCreations')).toBe(kpis.children!.lifetimeCreations);
    // Nonzero on purpose: hard-coded zeros must not pass this check.
    expect(values.get('children.active')).toBe(3);
    expect(values.get('children.queued')).toBe(2);
    expect(values.get('children.finished')).toBe(5);
    expect(values.get('children.lifetimeCreations')).toBe(10);

    // Spot-check the derivation itself so the comparison is not vacuous.
    expect(values.get('jobs.total')).toBe(9);
    expect(values.get('jobs.working')).toBe(2);
    expect(values.get('prs.conflicting')).toBe(1);
    expect(values.get('lanes.liveMinions')).toBe(2);
    expect(values.get('lanes.disposed')).toBe(1);
  });

  it('renders truthful counts in words: singular heist, crew-wide mid-turn (blind r1/r2)', () => {
    const one = railChips(snapshot([job('w1', 'working')]), NOW);
    const oneTrackers = one.find((chip) => chip.id === 'trackers');
    expect(oneTrackers?.kpis?.[0]?.total?.title).toBe('1 heist on the board');
    const two = railChips(snapshot([job('w1', 'working'), job('w2', 'working')]), NOW);
    expect(two.find((chip) => chip.id === 'trackers')?.kpis?.[0]?.total?.title).toBe('2 heists on the board');

    // The CREW group counts the whole crew: a streaming lens child rides
    // mid-turn and the live-minion field pluralizes with its count.
    const mixed = railChips(
      snapshot([job('w1', 'working')], [agent('lens', 'streaming', 'perkins'), agent('m1', 'idle')]),
      NOW,
    );
    const crew = mixed.find((chip) => chip.id === 'trackers')?.kpis?.[2];
    expect(crew?.label).toBe('CREW');
    expect(crew?.values[1]?.value).toBe(1);
    expect(crew?.values[0]?.value).toBe(1);
    expect(crew?.values[0]?.title).toBe('1 live minion');
  });

  it('marks the loud states: an unacked tracker chip flags the count', () => {
    const snap = snapshot([job('i1', 'in-review', { prUrl: 'https://x/2', prState: 'conflicting' })]);
    const trackers = railChips({ ...snap, unackedActionRequired: 2 }, NOW).find((chip) => chip.id === 'trackers');
    expect(trackers?.tone).toBe('alert');
    expect(trackers?.detail).toContain('2 needs Gru');
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

describe('board rail — numeric part splits for the slim strip', () => {
  /** Complete SilasView (current protocol) so each branch reads a real
   * field state, never an `undefined !== null` accident. */
  const silasIdle = (
    overrides: Partial<NonNullable<BoardSnapshot['silas']>> = {},
  ): NonNullable<BoardSnapshot['silas']> => ({
    lastWakeAt: null,
    lastTickAt: null,
    lastReconcileAt: null,
    lastReconcileFailedAt: null,
    reconcileFailedNewer: false,
    lastUsefulActionAt: null,
    nextAction: null,
    openTurnSince: null,
    reconciliationsToday: 0,
    checkedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

  const base = (overrides: Partial<BoardSnapshot>): BoardSnapshot => ({
    repos: [],
    agents: [],
    notifications: [],
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: null,
      model: 'm',
      endpoint: 'https://example.invalid',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 't',
      generation: 0,
    },
    unackedActionRequired: 0,
    unackedNeedsOwner: 0,
    wakes: { count: 0, lastAt: null },
    build: null,
    silas: null,
    verify: null,
    selfHeal: null,
    ...overrides,
  });

  it('splits card values and numeric flags into lead/num/unit from the same derivations', () => {
    const chips = railChips(
      base({
        build: {
          buildRev: 'a'.repeat(40),
          buildCommittedAt: '2026-01-01T00:00:00.000Z',
          originMainRev: 'b'.repeat(40),
          originMainCommittedAt: '2026-01-01T00:00:00.000Z',
          commitsBehind: 43,
          checkedAt: '2026-01-01T00:00:00.000Z',
          checkError: null,
        },
        verify: { lockInUse: true, activeRuns: 1, queuedRuns: 2, workerBudget: 8, workersPerRun: 4 },
        selfHeal: { sessionsResumed: 5, sessionsOrphaned: 3, since: null },
      }),
    );
    const deploy = chips.find((c) => c.id === 'deploy')!;
    expect(deploy.value).toBe('43 behind');
    expect(deploy.valueSplit).toEqual({ lead: '', num: 43, unit: ' behind' });
    expect(deploy.flag).toBe('RESTART PENDING');
    const verify = chips.find((c) => c.id === 'verify')!;
    expect(verify.valueSplit).toEqual({ lead: '', num: null, unit: 'lock held' });
    expect(verify.flagSplit).toEqual({ num: 2, unit: ' QUEUED' });
    const cure = chips.find((c) => c.id === 'cure')!;
    expect(cure.valueSplit).toEqual({ lead: '', num: 5, unit: ' resumed' });
    expect(cure.flagSplit).toEqual({ num: 3, unit: ' ORPHANED' });
    const alerts = chips.find((c) => c.id === 'alerts')!;
    expect(alerts.valueSplit).toEqual({ lead: '', num: 0, unit: '' });
    expect(alerts.flagSplit).toBeNull();
  });

  it('splits the silas wake value; an unparseable stamp stays honest text', () => {
    const chips = railChips(
      base({ silas: silasIdle({ lastWakeAt: new Date(Date.now() - 10 * 60_000).toISOString() }) }),
    );
    const silas = chips.find((c) => c.id === 'silas')!;
    expect(silas.valueSplit.lead).toBe('wake');
    expect(silas.valueSplit.num).toBe(10);
    expect(silas.valueSplit.unit).toBe('m ago');
    const stale = railChips(base({ silas: silasIdle({ lastWakeAt: 'not-a-timestamp' }) }));
    const staleChip = stale.find((c) => c.id === 'silas')!;
    expect(staleChip.valueSplit.num).toBeNull();
    expect(staleChip.valueSplit.unit).toBe('— ago');
  });

  it('splits main\'s #163 silas headline branches with the same reserved slots', () => {
    const failed = railChips(
      base({
        silas: silasIdle({
          reconcileFailedNewer: true,
          lastReconcileFailedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        }),
      }),
    ).find((c) => c.id === 'silas')!;
    expect(failed.value.startsWith('pass failed')).toBe(true);
    expect(failed.valueSplit.lead).toBe('pass failed');
    expect(failed.valueSplit.num).toBe(5);
    expect(failed.valueSplit.unit).toBe('m ago');
    expect(failed.flag).toBe('FAILED');

    const openTurn = railChips(
      base({ silas: silasIdle({ openTurnSince: new Date(Date.now() - 3 * 60_000).toISOString() }) }),
    ).find((c) => c.id === 'silas')!;
    expect(openTurn.valueSplit).toEqual({ lead: 'turn open', num: 3, unit: 'm' });

    const reconciled = railChips(
      base({ silas: silasIdle({ lastReconcileAt: new Date(Date.now() - 8 * 60_000).toISOString() }) }),
    ).find((c) => c.id === 'silas')!;
    expect(reconciled.valueSplit).toEqual({ lead: 'reconciled', num: 8, unit: 'm ago' });

    const none = railChips(base({ silas: silasIdle() })).find((c) => c.id === 'silas')!;
    expect(none.value).toBe('no wakes yet');
    expect(none.valueSplit).toEqual({ lead: '', num: null, unit: 'no wakes yet' });
  });

  it('carries a reserved-slot split contract on every chip: FAILED stays pure text, no split is left empty', () => {
    const failed = railChips(
      base({
        silas: silasIdle({
          reconcileFailedNewer: true,
          lastReconcileFailedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        }),
      }),
    ).find((c) => c.id === 'silas')!;
    // A text-only flag (no numeric part) never fabricates a reserved slot.
    expect(failed.flag).toBe('FAILED');
    expect(failed.flagSplit).toBeNull();
    // Every health card's presentation split is populated from its own
    // derivation — a new card that forgot the split would be caught here
    // before the DOM fallback could silently print a bare value.
    const chips = railChips(
      base({
        build: {
          buildRev: 'a'.repeat(40),
          buildCommittedAt: '2026-01-01T00:00:00.000Z',
          originMainRev: 'b'.repeat(40),
          originMainCommittedAt: '2026-01-01T00:00:00.000Z',
          commitsBehind: 0,
          checkedAt: '2026-01-01T00:00:00.000Z',
          checkError: null,
        },
        silas: silasIdle({ lastWakeAt: new Date(Date.now() - 60_000).toISOString() }),
        verify: { lockInUse: false, activeRuns: 0, queuedRuns: 0, workerBudget: 8, workersPerRun: 4 },
        selfHeal: { sessionsResumed: 0, sessionsOrphaned: 0, since: null },
      }),
    ).filter((chip) => chip.id !== 'trackers');
    expect(chips).toHaveLength(6);
    for (const chip of chips) {
      expect(
        chip.valueSplit.lead !== '' || chip.valueSplit.num !== null || chip.valueSplit.unit !== '',
        `${chip.id} value split populated`,
      ).toBe(true);
    }
  });
});
