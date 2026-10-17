import { describe, expect, it } from 'vitest';
import { boardKpis, collectJobs } from './board-kpi.js';
import type { AgentView, BoardSnapshot, BuildView, ChildWorkerCounts, JobView, VectorOnView, VectorView } from './board-protocol.js';
import { cockpitCards, gruQueueLine, healthPill, type CockpitCard } from './cockpit.js';

/**
 * The cockpit (owner-approved rework 2026-10-17): the health pill and the
 * KPI cards read the same derivations the slim strip did — the health
 * cards, `boardKpis`, the review counts and the job families — so a card
 * can never disagree with the board below it.
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
  extra: Partial<BoardSnapshot> = {},
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
    ...extra,
  };
}

function card(cards: readonly CockpitCard[], id: CockpitCard['id']): CockpitCard {
  const found = cards.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`card ${id} missing`);
  return found;
}

function values(cards: readonly CockpitCard[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const entry of cards) {
    if (entry.headline.kpi !== null) out.set(entry.headline.kpi, Number(entry.headline.value));
    for (const fact of entry.facts) out.set(fact.kpi, fact.value);
  }
  return out;
}

const BEHIND: BuildView = {
  buildRev: 'a'.repeat(40),
  buildCommittedAt: new Date(NOW - 3_600_000).toISOString(),
  originMainRev: 'b'.repeat(40),
  originMainCommittedAt: new Date(NOW).toISOString(),
  commitsBehind: 3,
  checkedAt: new Date(NOW).toISOString(),
  checkError: null,
};

describe('cockpit cards', () => {
  it('renders five cards in the fixed order, and the raids card only when the server sent its block', () => {
    expect(cockpitCards(snapshot([]), NOW).map((entry) => entry.id)).toEqual(['heists', 'megaminions', 'crew', 'prs', 'reviews']);
    const vector: VectorView = { enabled: false, raidMode: 'proposed', maxRaidsPerDay: 2 };
    expect(cockpitCards(snapshot([], [], null, { vector }), NOW).map((entry) => entry.id)).toEqual(['heists', 'megaminions', 'crew', 'prs', 'reviews', 'raids']);
    expect(cockpitCards(snapshot([], [], null, { vector: null }), NOW).map((entry) => entry.id)).not.toContain('raids');
  });

  it('every count equals the v4 KPI derivation on the same snapshot', () => {
    const jobs = [
      job('w', 'working'),
      job('r', 'in-review', { prUrl: 'https://x/1', prState: 'conflicting' }),
      job('m', 'merged', { prUrl: 'https://x/2', updatedAt: new Date(NOW).toISOString() }),
      job('d', 'done'),
      job('p', 'parked'),
      job('b', 'binned'),
    ];
    const agents = [agent('a', 'streaming'), agent('b', 'idle'), agent('c', 'disposed')];
    const value = snapshot(jobs, agents);
    const kpis = boardKpis(value, new Date(NOW), collectJobs(value));
    const got = values(cockpitCards(value, NOW));
    expect(got.get('jobs.total')).toBe(kpis.jobs.total);
    for (const key of ['working', 'inReview', 'merged', 'done', 'parked', 'binned'] as const) expect(got.get(`jobs.${key}`), key).toBe(kpis.jobs[key]);
    expect(got.get('prs.open')).toBe(kpis.prs.open);
    expect(got.get('prs.conflicting')).toBe(kpis.prs.conflicting);
    expect(got.get('prs.mergedToday')).toBe(kpis.prs.mergedToday);
    expect(got.get('lanes.liveMinions')).toBe(kpis.lanes.liveMinions);
    expect(got.get('lanes.midTurn')).toBe(kpis.lanes.midTurn);
    expect(got.get('lanes.disposed')).toBe(kpis.lanes.disposed);
    expect(got.get('children.active')).toBe(3);
    // The stage bar holds the stages toward done, in order.
    expect(card(cockpitCards(value, NOW), 'heists').flow).toEqual([
      { stage: 'working', value: 1 },
      { stage: 'in-review', value: 1 },
      { stage: 'merged', value: 1 },
      { stage: 'done', value: 1 },
    ]);
  });

  it('labels every count beside its number, in truthful words (singular and plural)', () => {
    const cards = cockpitCards(snapshot([job('only', 'working')], [agent('solo', 'idle')]), NOW);
    for (const entry of cards) {
      expect(entry.headline.unit, entry.id).toBeTruthy();
      for (const fact of entry.facts) {
        expect(fact.label, fact.kpi).toBeTruthy();
        expect(fact.title, fact.kpi).toBeTruthy();
      }
    }
    expect(card(cards, 'heists').headline).toMatchObject({ value: '1', unit: 'on the board', title: '1 heist on the board' });
    expect(card(cards, 'crew').headline).toMatchObject({ value: '1', unit: 'minion' });
    expect(card(cards, 'reviews').headline.unit).toBe('rounds active');
  });

  it('omits sub-minions when the server reports no child counters (unknown is not zero)', () => {
    const crew = card(cockpitCards(snapshot([], [], null), NOW), 'crew');
    expect(crew.facts.map((fact) => fact.kpi)).toEqual(['lanes.midTurn', 'lanes.disposed']);
    expect(crew.notes).toEqual([]);
    const reported = card(cockpitCards(snapshot([], [], { queued: 0, active: 0, finished: 0, lifetimeCreations: 0 }), NOW), 'crew');
    expect(reported.facts.map((fact) => fact.kpi)).toEqual(['lanes.midTurn', 'lanes.disposed', 'children.active']);
  });

  it('flags only non-zero alert counts: a conflicting PR and a failed round', () => {
    const today = new Date(NOW).toISOString();
    const round = (id: string, status: string) => ({
      id, seq: 1, status, verdict: null, targetRef: null, createdAt: today, updatedAt: today, lenses: [], lensAttempts: [], blockers: 0,
    });
    const calm = cockpitCards(snapshot([job('w', 'working')]), NOW);
    expect(calm.flatMap((entry) => entry.facts).filter((fact) => fact.alert)).toEqual([]);
    const loud = cockpitCards(snapshot([
      job('c', 'in-review', { prUrl: 'https://x/1', prState: 'conflicting', rounds: [round('c-r1', 'aborted')] }),
    ]), NOW);
    expect(loud.flatMap((entry) => entry.facts).filter((fact) => fact.alert).map((fact) => fact.kpi)).toEqual(['prs.conflicting', 'reviews.failedToday']);
  });

  it('counts megaminions once each — nested or surfaced — and the heists they belong to', () => {
    const jobs = [
      job('impl', 'working'),
      job('other', 'working'),
      job('rev-a', 'working', { parentJobId: 'impl' }),
      job('rev-b', 'delivered', { parentJobId: 'impl' }),
      job('rev-c', 'done', { parentJobId: 'other' }),
      // An orphan (parent absent) is a top-level heist, never a megaminion.
      job('orphan', 'working', { parentJobId: 'gone' }),
    ];
    const mega = card(cockpitCards(snapshot(jobs), NOW), 'megaminions');
    expect(mega.headline).toMatchObject({ kpi: 'megaminions.live', value: '1', unit: 'live' });
    expect(mega.facts).toEqual([expect.objectContaining({ kpi: 'megaminions.finished', value: 2 })]);
    expect(mega.notes).toEqual(['across 2 heists']);
    expect(card(cockpitCards(snapshot([job('solo', 'working')]), NOW), 'megaminions').notes).toEqual(['none commissioned']);
  });

  it('the raids card: dashed when off, the running raid and its attack when on, a second raid never hidden', () => {
    const base: VectorOnView = {
      enabled: true, raidMode: 'autonomous', proposed: 2, queued: 1, maxRaidsPerDay: 2, breakIns: 4, fixesAwaitingOwner: 1,
      capUse: [{ repo: 'demo', used: 2 }, { repo: 'other', used: 1 }],
      running: [{ repo: 'demo', packageDir: 'src/refunds', roundsDone: 4, maxRounds: 4, startedAt: '2026-10-17T19:00:00.000Z' }],
    };
    const off = card(cockpitCards(snapshot([], [], null, { vector: { enabled: false, raidMode: 'proposed', maxRaidsPerDay: 2 } }), NOW), 'raids');
    expect(off).toMatchObject({ off: true, headline: { kpi: null, value: 'off' }, facts: [], notes: ['opt in: [vector] enabled = true'] });
    const on = card(cockpitCards(snapshot([], [], null, { vector: base }), NOW), 'raids');
    expect(on.off).toBe(false);
    // The cap is per repository: the aside shows the busiest one's use and
    // the tooltip names every repository.
    expect(on.aside).toBe('2/2 today');
    expect(on.asideTitle).toBe('demo: 2 of 2 raids in the last 24 hours\nother: 1 of 2 raids in the last 24 hours (the cap is per repository)');
    const idle = card(cockpitCards(snapshot([], [], null, { vector: { ...base, capUse: [] } }), NOW), 'raids');
    expect(idle.aside).toBe('0/2 today');
    expect(idle.asideTitle).toBe('No repository has used any of its daily cap of 2 raids.');
    // The attack in progress never reads past the cap (4 done of 4 is 4/4).
    expect(on.notes).toEqual(['demo src/refunds · attack 4/4']);
    expect(on.facts.map((fact) => [fact.kpi, fact.value, fact.alert])).toEqual([
      ['vector.proposed', 2, false],
      ['vector.queued', 1, false],
      ['vector.fixesAwaitingOwner', 1, true],
      ['vector.breakIns', 4, false],
    ]);
    const two = card(cockpitCards(snapshot([], [], null, { vector: { ...base, running: [{ ...base.running[0]!, roundsDone: 1 }, { ...base.running[0]!, packageDir: 'src/payouts' }] } }), NOW), 'raids');
    expect(two.headline.value).toBe('2');
    expect(two.notes).toEqual(['demo src/refunds · attack 2/4', '+1 more running']);
  });
});

describe('cockpit health pill', () => {
  it('carries the system checks verbatim, problems first, each flag beside it', () => {
    const pill = healthPill(snapshot([], [], null, {
      build: BEHIND,
      verify: { lockInUse: false, activeRuns: 0, queuedRuns: 0, workerBudget: 8, workersPerRun: 4 },
      selfHeal: { sessionsResumed: 2, sessionsOrphaned: 1, since: null },
    }), NOW);
    expect(pill.attention).toBe(true);
    expect(pill.summary).toBe('2 need a look');
    expect(pill.parts.map((part) => [part.id, part.text, part.flag, part.tone])).toEqual([
      ['deploy', 'deploy 3 behind', 'RESTART PENDING', 'alert'],
      ['cure', 'cure 2 resumed', '1 ORPHANED', 'alert'],
      ['verify', 'verify lock free', null, 'ok'],
    ]);
    // REVIEWS has its own card and ALERTS rides the attention card.
    expect(pill.parts.map((part) => part.id)).not.toContain('reviews');
    expect(pill.parts.map((part) => part.id)).not.toContain('alerts');
  });

  it('one problem reads singular; an all-unwired board never reads healthy', () => {
    expect(healthPill(snapshot([], [], null, { build: BEHIND }), NOW).summary).toBe('1 needs a look');
    const unwired = healthPill(snapshot([], [], null), NOW);
    expect(unwired).toMatchObject({ attention: false, summary: 'Checks not wired', parts: [] });
    for (const check of ['deploy', 'silas', 'verify', 'cure']) expect(unwired.title).toContain(`${check}: n/a`);
  });
});

describe('cockpit Gru line', () => {
  it('says nothing needs Gru, or how many live machine rows Gru is handling, with the live-queue explanation', () => {
    expect(gruQueueLine(0).text).toBe('nothing needs Gru either · the crew is on it');
    const busy = gruQueueLine(3);
    expect(busy.text).toBe('Gru is handling 3 more in FOR GRU');
    expect(busy.title).toContain('3 live machine-attention notifications awaiting a Gru disposition');
  });
});
