import { describe, expect, it } from 'vitest';
import { boardKpis, collectJobs } from './board-kpi.js';
import type { AgentView, BoardSnapshot, BuildView, ChildWorkerCounts, DiskView, JobView, SilasView, VectorOnView, VectorView } from './board-protocol.js';
import { cockpitCards, gruQueueLine, healthPill, type CockpitCard } from './cockpit.js';

/**
 * The cockpit (owner-approved rework 2026-10-17): the health pill and the
 * KPI cards read the same derivations the slim strip did — the health
 * cards, `boardKpis`, the review counts and the board's sections — so a
 * card can never disagree with the board below it.
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

function disk(overrides: Partial<DiskView> = {}): DiskView {
  return {
    usedBytes: 4 * 1024 ** 3,
    sharedBytes: 0,
    categories: null,
    freeBytes: 80 * 1024 ** 3,
    totalBytes: 500 * 1024 ** 3,
    volumes: [],
    budgetBytes: 30 * 1024 ** 3,
    floorBytes: 10 * 1024 ** 3,
    reclaimMode: 'automatic',
    overBudget: false,
    belowFloor: false,
    queuedLanes: 0,
    floorQueue: [],
    computedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

const NO_WAKES: SilasView = {
  lastWakeAt: null, lastTickAt: null, lastReconcileAt: null, lastReconcileFailedAt: null, reconcileFailedNewer: false,
  lastUsefulActionAt: null, nextAction: null, openTurnSince: null, reconciliationsToday: 0, checkedAt: new Date(NOW).toISOString(),
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
      job('o', 'in-review', { prUrl: 'https://x/3', prState: 'open' }),
      job('m', 'merged', { prUrl: 'https://x/2', updatedAt: new Date(NOW).toISOString() }),
      job('d', 'done'),
      job('p', 'parked'),
      job('b', 'binned'),
    ];
    // A Perkins session is crew-rail company, never a live minion.
    const agents = [agent('a', 'streaming'), agent('b', 'idle'), agent('c', 'disposed'), agent('p', 'streaming', 'perkins')];
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
    expect(got.get('children.queued')).toBe(2);
    // The parity is not vacuous: the fixture holds an open PR, a
    // conflicting one and live minions.
    expect([kpis.prs.open, kpis.prs.conflicting, kpis.lanes.liveMinions]).toEqual([1, 1, 2]);
    // The stage bar holds the stages toward done, in order, and each stage
    // count carries its stage (the fact's colour key).
    const heists = card(cockpitCards(value, NOW), 'heists');
    expect(heists.flow).toEqual([
      { stage: 'working', value: 1 },
      { stage: 'in-review', value: 2 },
      { stage: 'merged', value: 1 },
      { stage: 'done', value: 1 },
    ]);
    expect(heists.facts.map((fact) => [fact.kpi, fact.stage ?? null])).toEqual([
      ['jobs.working', 'working'],
      ['jobs.inReview', 'in-review'],
      ['jobs.merged', 'merged'],
      ['jobs.done', 'done'],
      ['jobs.parked', null],
      ['jobs.binned', null],
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
    const today = new Date(NOW).toISOString();
    const round = (id: string, status: string, verdict: string | null) => ({
      id, seq: 1, status, verdict, targetRef: null, createdAt: today, updatedAt: today, lenses: [], lensAttempts: [], blockers: 0,
    });
    const vector = (count: number): VectorOnView => ({
      enabled: true, raidMode: 'proposed', proposed: count, queued: count, running: [], capUse: [], maxRaidsPerDay: 2, breakIns: count, fixesAwaitingOwner: count,
    });
    const labels = (cardsNow: readonly CockpitCard[]) => cardsNow.flatMap((entry) => [`${entry.id}:${entry.headline.unit}`, ...entry.facts.map((fact) => `${fact.kpi}:${fact.label}`)]);
    const one = labels(cockpitCards(snapshot(
      [job('v', 'in-review', { rounds: [round('v-1', 'live', null), round('v-0', 'verdict-posted', 'approve')] })],
      [agent('solo', 'idle')],
      { queued: 1, active: 1, finished: 0, lifetimeCreations: 2 },
      { vector: vector(1) },
    ), NOW));
    expect(one).toEqual(expect.arrayContaining([
      'crew:minion', 'children.active:sub-minion', 'children.queued:queued', 'reviews:round active', 'reviews.verdictsToday:verdict today',
      'vector.fixesAwaitingOwner:fix awaiting you', 'vector.breakIns:break-in',
    ]));
    const two = labels(cockpitCards(snapshot(
      [job('v', 'in-review', { rounds: [round('v-2', 'live', null), round('v-1', 'pending', null), round('v-0', 'verdict-posted', 'approve'), round('v-00', 'verdict-posted', 'changes')] })],
      [agent('a', 'idle'), agent('b', 'idle')],
      { queued: 2, active: 2, finished: 0, lifetimeCreations: 4 },
      { vector: vector(2) },
    ), NOW));
    expect(two).toEqual(expect.arrayContaining([
      'crew:minions', 'children.active:sub-minions', 'reviews:rounds active', 'reviews.verdictsToday:verdicts today',
      'vector.fixesAwaitingOwner:fixes awaiting you', 'vector.breakIns:break-ins',
    ]));
  });

  it('omits sub-minions when the server reports no child counters (unknown is not zero); queued ones are a count of their own', () => {
    const crew = card(cockpitCards(snapshot([], [], null), NOW), 'crew');
    expect(crew.facts.map((fact) => fact.kpi)).toEqual(['lanes.midTurn', 'lanes.disposed']);
    expect(crew.notes).toEqual([]);
    const reported = card(cockpitCards(snapshot([], [], { queued: 0, active: 0, finished: 0, lifetimeCreations: 0 }), NOW), 'crew');
    expect(reported.facts.map((fact) => fact.kpi)).toEqual(['lanes.midTurn', 'lanes.disposed', 'children.active']);
    const queued = card(cockpitCards(snapshot([], [], { queued: 2, active: 3, finished: 0, lifetimeCreations: 5 }), NOW), 'crew');
    expect(queued.facts.map((fact) => [fact.kpi, fact.value, fact.label])).toEqual([
      ['lanes.midTurn', 0, 'mid-turn'],
      ['lanes.disposed', 0, 'disposed'],
      ['children.active', 3, 'sub-minions'],
      ['children.queued', 2, 'queued'],
    ]);
    expect(queued.notes).toEqual([]);
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

  it('counts every job a minion commissioned once — nested, surfaced or orphaned — and the heists that commissioned them', () => {
    const jobs = [
      job('impl', 'working'),
      job('other', 'working'),
      job('rev-a', 'working', { parentJobId: 'impl' }),
      job('rev-b', 'delivered', { parentJobId: 'impl' }),
      job('rev-c', 'done', { parentJobId: 'other' }),
      // An orphan (its parent left the board) renders top-level, and is
      // still a megaminion — the crew rail calls its worker one too.
      job('orphan', 'working', { parentJobId: 'gone' }),
    ];
    const mega = card(cockpitCards(snapshot(jobs), NOW), 'megaminions');
    expect(mega.headline).toMatchObject({ kpi: 'megaminions.live', value: '2', unit: 'live' });
    expect(mega.facts).toEqual([expect.objectContaining({ kpi: 'megaminions.finished', value: 2 })]);
    expect(mega.notes).toEqual(['across 3 heists']);
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
    // The cap is per repository over a rolling 24 hours: the aside shows
    // the busiest one's use and the tooltip names every repository.
    expect(on.aside).toBe('2/2 in 24h');
    expect(on.asideTitle).toBe('demo: 2 of 2 raids in the last 24 hours\nother: 1 of 2 raids in the last 24 hours (the cap is per repository)');
    // Enabled but idle: nothing running, no cap used — zeros, not off.
    const idle = card(cockpitCards(snapshot([], [], null, { vector: { ...base, proposed: 0, queued: 0, breakIns: 0, fixesAwaitingOwner: 0, running: [], capUse: [] } }), NOW), 'raids');
    expect(idle).toMatchObject({ off: false, aside: '0/2 in 24h', headline: { kpi: 'vector.running', value: '0' }, notes: [] });
    expect(idle.asideTitle).toBe('No repository has used any of its cap of 2 raids per 24 hours.');
    expect(idle.facts.every((fact) => fact.value === 0 && !fact.alert)).toBe(true);
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
    // A raid on the repository root names the repository alone.
    const root = card(cockpitCards(snapshot([], [], null, { vector: { ...base, running: [{ ...base.running[0]!, packageDir: '.', roundsDone: 0 }] } }), NOW), 'raids');
    expect(root.notes).toEqual(['demo · attack 1/4']);
  });
});

describe('cockpit health pill', () => {
  it('carries the system checks verbatim, problems first, each flag beside it', () => {
    const pill = healthPill(snapshot([], [], null, {
      build: BEHIND,
      verify: { lockInUse: false, activeRuns: 0, queuedRuns: 0, workerBudget: 8, workersPerRun: 4 },
      selfHeal: { sessionsResumed: 2, sessionsOrphaned: 1, since: null },
    }), NOW);
    expect(pill.state).toBe('attention');
    expect(pill.summary).toBe('2 need a look');
    expect(pill.parts.map((part) => [part.id, part.text, part.flag, part.tone, part.problem])).toEqual([
      ['deploy', 'deploy 3 behind', 'RESTART PENDING', 'alert', true],
      ['cure', 'cure 2 resumed', '1 ORPHANED', 'alert', true],
      ['verify', 'verify lock free', null, 'ok', false],
    ]);
    // REVIEWS has its own card and ALERTS rides the attention card.
    expect(pill.parts.map((part) => part.id)).not.toContain('reviews');
    expect(pill.parts.map((part) => part.id)).not.toContain('alerts');
  });

  it('one problem reads singular; an all-unwired board never reads healthy', () => {
    expect(healthPill(snapshot([], [], null, { build: BEHIND }), NOW).summary).toBe('1 needs a look');
    const unwired = healthPill(snapshot([], [], null), NOW);
    expect(unwired).toMatchObject({ state: 'unwired', summary: 'Checks not wired', parts: [] });
    for (const check of ['deploy', 'silas', 'verify', 'cure']) expect(unwired.title).toContain(`${check}: n/a`);
  });

  it('reads healthy only when a wired check reads ok; neutral facts alone are quiet', () => {
    // Silas with no wakes yet and a disk still walking: wired, nothing wrong,
    // nothing verified ok either.
    const quiet = healthPill(snapshot([], [], null, { silas: NO_WAKES, disk: disk({ usedBytes: null }) }), NOW);
    expect(quiet).toMatchObject({ state: 'quiet', summary: 'No problems reported' });
    expect(quiet.parts.map((part) => [part.id, part.tone])).toEqual([['silas', 'muted'], ['disk', 'muted']]);
    const healthy = healthPill(snapshot([], [], null, { silas: NO_WAKES, disk: disk() }), NOW);
    expect(healthy).toMatchObject({ state: 'healthy', summary: 'All healthy' });
  });

  it('carries the disk check, and a check with a flag needs a look even when its tone is calm', () => {
    // Lanes waiting at the floor while the disk itself reads ok: the flag is
    // the problem, so the pill says so and puts it first.
    const pill = healthPill(snapshot([], [], null, {
      verify: { lockInUse: false, activeRuns: 0, queuedRuns: 0, workerBudget: 8, workersPerRun: 4 },
      disk: disk({ queuedLanes: 1 }),
    }), NOW);
    expect(pill).toMatchObject({ state: 'attention', summary: '1 needs a look' });
    expect(pill.parts.map((part) => [part.id, part.text, part.flag, part.tone, part.problem])).toEqual([
      ['disk', 'disk 4.0 GB', '1 QUEUED', 'ok', true],
      ['verify', 'verify lock free', null, 'ok', false],
    ]);
    expect(pill.title).toContain('disk: 4.0 GB');
    const below = healthPill(snapshot([], [], null, { disk: disk({ belowFloor: true, freeBytes: 9 * 1024 ** 3 }) }), NOW);
    expect(below.parts[0]).toMatchObject({ id: 'disk', flag: 'BELOW FLOOR', tone: 'alert', problem: true });
  });
});

describe('cockpit Gru line', () => {
  it('says nothing needs Gru, or how many live alerts wait for Gru, with the live-queue explanation', () => {
    expect(gruQueueLine(0)).toMatchObject({ text: 'nothing needs Gru either · the crew is on it', alert: false });
    expect(gruQueueLine(1)).toMatchObject({ text: '1 live alert waits for Gru', alert: true });
    const busy = gruQueueLine(3);
    expect(busy).toMatchObject({ text: '3 live alerts wait for Gru', alert: true });
    expect(busy.title).toContain('3 live machine-attention notifications awaiting a Gru disposition');
  });

  it('a last-known board says so rather than claiming calm', () => {
    expect(gruQueueLine(0, true).text).toBe('last-known · nothing needs Gru either · the crew is on it');
    expect(gruQueueLine(2, true)).toMatchObject({ text: 'last-known · 2 live alerts wait for Gru', alert: true });
  });
});
