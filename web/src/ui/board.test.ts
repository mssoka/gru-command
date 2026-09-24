// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentView,
  BoardSnapshot,
  BuildView,
  JobView,
  NotificationView,
  RoundView,
  SelfHealView,
  SilasView,
  VerifyQueueView,
} from '../lib/board-protocol.js';
import { memoryStorage } from '../lib/chat-storage.js';
import { boardKpis } from '../lib/board-kpi.js';
import { BoardView, jobFailing } from './board.js';

type DecisionsOverrides = Partial<BoardSnapshot['decisions']>;

function notification(id: string, overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    id,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'test.notice',
    routing: 'action-required',
    severity: 'error',
    title: `Notice ${id}`,
    detail: null,
    agentId: null,
    shownAt: null,
    ackedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

function agent(id: string, overrides: Partial<AgentView> = {}): AgentView {
  return {
    id,
    role: 'perkins',
    label: id,
    state: 'idle',
    lastActivity: '2026-01-01T00:00:00.000Z',
    sessionFile: `/sessions/${id}.jsonl`,
    jobId: null,
    roundId: null,
    supervision: null,
    ...overrides,
  };
}

function baseRound(overrides: Partial<RoundView> = {}): RoundView {
  return {
    id: 'job-1-r1',
    seq: 1,
    status: 'live',
    verdict: null,
    targetRef: 'abc',
    createdAt: new Date(Date.now() - 600_000).toISOString(),
    updatedAt: '2026-01-01T00:30:00.000Z',
    lensAttempts: [
      { lens: 'blind', attempts: 2 },
      { lens: 'security', attempts: 1 },
    ],
    blockers: 1,
    lenses: [
      { lens: 'blind', state: 'done', agentId: 'a1', note: 'blocker — unsafe retry', verdict: 'blocker' },
      { lens: 'security', state: 'done', agentId: null, note: 'clean — nothing found', verdict: 'clean' },
    ],
    ...overrides,
  };
}

function baseJob(overrides: Partial<JobView> = {}): JobView {
  return {
    id: 'job-1',
    repo: 'demo',
    title: 'Review job',
    status: 'in-review',
    updatedAt: '2026-01-01T00:00:00.000Z',
    prUrl: null,
    prState: null,
    baseBranch: 'main',
    note: null,
    rounds: [baseRound()],
    lane: {
      branch: 'gru/job-1',
      sha: 'abc1234deadbeef',
      status: 'active',
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    },
    lastAgentActivity: new Date(Date.now() - 120_000).toISOString(),
    ...overrides,
  };
}

function snapshot(
  options: {
    notifications?: readonly NotificationView[];
    agents?: readonly AgentView[];
    jobs?: readonly JobView[];
    decisions?: DecisionsOverrides;
    unackedActionRequired?: number;
    build?: BuildView | null;
    silas?: SilasView | null;
    verify?: VerifyQueueView | null;
    selfHeal?: SelfHealView | null;
    repos?: readonly { readonly name: string; readonly jobs: readonly JobView[] }[];
    unackedNeedsOwner?: number;
    wakes?: { readonly count: number; readonly lastAt: string | null };
  } = {},
): BoardSnapshot {
  return {
    repos: options.repos ?? [{ name: 'demo', jobs: options.jobs ?? [baseJob()] }],
    agents: options.agents ?? [],
    notifications: options.notifications ?? [],
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: 'disabled',
      model: '~typesafe/jev-latest',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'test-incarnation',
      generation: 0,
      ...options.decisions,
    },
    unackedActionRequired: options.unackedActionRequired ?? 0,
    build: options.build ?? null,
    silas: options.silas ?? null,
    verify: options.verify ?? null,
    selfHeal: options.selfHeal ?? null,
    unackedNeedsOwner: options.unackedNeedsOwner ?? 0,
    wakes: options.wakes ?? { count: 0, lastAt: null },
  };
}

function mountBoardDom(): void {
  document.body.innerHTML = `
    <div id="chip-rail" hidden>
      <span id="board-decisions"></span>
      <span id="board-unacked" hidden></span>
      <span id="board-wakes" hidden></span>
    </div>
    <div id="board-jobs"></div>
    <div id="board-agents"></div>
    <span id="rail-agents-count">0</span>
    <button id="notification-bell"><span id="notification-badge">0</span></button>
    <div id="notification-panel"><div id="notification-list"></div></div>
  `;
}

describe('board view resolved-notification rendering', () => {
  beforeEach(mountBoardDom);

  it('removes ack/badge/toast behavior for resolved rows while retaining active controls', () => {
    const toast = vi.fn();
    const view = new BoardView(() => {});
    view.setToastHandler(toast);
    const first = notification('first', { routing: 'needs-owner' });
    view.render(snapshot({ notifications: [first] }));
    expect(document.querySelectorAll('.board-notification__ack')).toHaveLength(1);

    const resolved = { ...first, resolvedAt: '2026-01-01T00:01:00.000Z', resolvedBy: 'runtime' };
    view.render(snapshot({ notifications: [resolved] }));
    expect(document.querySelector('.board-notification__title')?.textContent).toContain('resolved');
    expect(document.querySelectorAll('.board-notification__ack')).toHaveLength(0);
    expect(document.querySelector<HTMLElement>('#notification-bell')?.dataset.unread).toBe('0');
    expect(document.querySelector<HTMLElement>('#notification-badge')?.textContent).toBe('0');
    expect(toast).not.toHaveBeenCalled();

    view.render(
      snapshot({
        notifications: [
          resolved,
          notification('arrived-resolved', { resolvedAt: '2026-01-01T00:02:00.000Z', resolvedBy: 'runtime' }),
          notification('active', { routing: 'needs-owner' }),
        ],
      }),
    );
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ id: 'active' }));
    expect(document.querySelectorAll('.board-notification__ack')).toHaveLength(1);
  });

  it('routing split: machine rows never ring the bell or toast; needs-owner rows do', () => {
    const toast = vi.fn();
    const view = new BoardView(() => {});
    view.setToastHandler(toast);
    view.render(snapshot({ notifications: [notification('machine')] }));
    expect(toast).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>('#notification-badge')?.textContent).toBe('0');
    expect(document.querySelector('.board-notification-section__head')?.textContent).toContain('FOR YOU');
    const sections = [...document.querySelectorAll('.board-notification-section__head')].map(
      (head) => head.textContent,
    );
    expect(sections).toEqual(['FOR YOU', 'NEEDS GRU']);

    view.render(
      snapshot({
        notifications: [
          notification('machine'),
          notification('owner', { routing: 'needs-owner' }),
        ],
      }),
    );
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ id: 'owner' }));
    const forYou = document.querySelector('.board-notification-section');
    expect(forYou?.querySelector('.board-notification__title')?.textContent).toContain('Notice owner');
    const needsGru = document.querySelectorAll('.board-notification-section')[1];
    expect(needsGru?.querySelector('.board-notification__title')?.textContent).toContain('Notice machine');
  });
});

describe('board v6 — status chip rail (v4 health row relocated)', () => {
  beforeEach(mountBoardDom);

  it('renders the seven chips and discloses the rail on the first snapshot', () => {
    const view = new BoardView(() => {});
    expect(document.getElementById('chip-rail')?.hidden).toBe(true);
    view.render(snapshot());
    const rail = document.getElementById('chip-rail');
    expect(rail?.hidden).toBe(false);
    const chips = [...(rail?.querySelectorAll('.rail-chip') ?? [])].map((node) => node.getAttribute('data-chip'));
    expect(chips).toEqual(['deploy', 'reviews', 'silas', 'alerts', 'verify', 'cure', 'trackers']);
  });

  it('renders the deploy-drift chip with the restart-pending flag when behind', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        build: {
          buildRev: 'a'.repeat(40),
          buildCommittedAt: new Date(Date.now() - 6 * 3_600_000).toISOString(),
          originMainRev: 'b'.repeat(40),
          originMainCommittedAt: new Date().toISOString(),
          commitsBehind: 43,
          checkedAt: new Date().toISOString(),
          checkError: null,
        },
      }),
    );
    const deploy = document.querySelector<HTMLElement>('.rail-chip[data-chip="deploy"]');
    expect(deploy?.querySelector('.rail-chip__value')?.textContent).toBe('43 behind');
    expect(deploy?.querySelector('.rail-chip__flag')?.textContent).toBe('RESTART PENDING');
    expect(deploy?.classList.contains('rail-chip--alert')).toBe(true);
  });

  it('renders n/a honestly for unwired sources (verify queue, cure efficacy)', () => {
    const view = new BoardView(() => {});
    view.render(snapshot());
    const valueOf = (chip: string): string | undefined =>
      document.querySelector<HTMLElement>(`.rail-chip[data-chip="${chip}"] .rail-chip__value`)?.textContent ?? undefined;
    expect(valueOf('deploy')).toBe('n/a');
    expect(valueOf('verify')).toBe('n/a');
    expect(valueOf('cure')).toBe('n/a');
    expect(valueOf('alerts')).toBe('0');
    expect(valueOf('reviews')).toBe('1 active'); // the base job carries a live round
  });

  it('renders the verify queue from the snapshot when the scheduler is wired', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        verify: { lockInUse: true, activeRuns: 1, queuedRuns: 2, workerBudget: 8, workersPerRun: 4 },
      }),
    );
    const verify = document.querySelector<HTMLElement>('.rail-chip[data-chip="verify"]');
    expect(verify?.querySelector('.rail-chip__value')?.textContent).toBe('lock held');
    expect(verify?.querySelector('.rail-chip__flag')?.textContent).toBe('2 QUEUED');
  });

  it('folds the v4 KPI counts into the rail as data-kpi numbers matching boardKpis', () => {
    const jobs = [
      baseJob({ id: 'w1', status: 'working' }),
      baseJob({ id: 'w2', status: 'working' }),
      baseJob({ id: 'r1', status: 'in-review' }),
      baseJob({ id: 'm1', status: 'merged', prUrl: 'https://x/1', prState: 'merged' }),
      baseJob({ id: 'p1', status: 'parked' }),
      baseJob({ id: 'i1', status: 'in-review', prUrl: 'https://x/2', prState: 'conflicting' }),
    ];
    const agents = [
      agent('minion-live', { role: 'minion', state: 'streaming', lastActivity: new Date(Date.now() - 30_000).toISOString() }),
      agent('minion-idle', { role: 'minion', state: 'idle' }),
      agent('minion-dead', { role: 'minion', state: 'disposed' }),
      agent('lens', { role: 'perkins', state: 'streaming', lastActivity: new Date(Date.now() - 600_000).toISOString() }),
    ];
    const snapshotValue = snapshot({ jobs, agents });
    const kpis = boardKpis(snapshotValue);
    const view = new BoardView(() => {});
    view.render(snapshotValue);

    const values = new Map(
      [...document.querySelectorAll<HTMLElement>('[data-kpi]')].map((node) => [
        node.dataset.kpi ?? '',
        Number(node.textContent),
      ]),
    );
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
    // The numbers themselves (not a vacuous mirror).
    expect(values.get('jobs.total')).toBe(6);
    expect(values.get('jobs.working')).toBe(2);
    expect(values.get('prs.conflicting')).toBe(1);
    expect(values.get('lanes.liveMinions')).toBe(2);
    expect(values.get('lanes.disposed')).toBe(1);
    // A conflict is the loudest PR state: the number carries the alert ink.
    const conflicting = [...document.querySelectorAll<HTMLElement>('[data-kpi="prs.conflicting"]')][0];
    expect(conflicting?.classList.contains('rail-kpi__num--alert')).toBe(true);
  });

  it('keeps the Jev decisions chip and unacked badge inside the TRACKERS chip', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        decisions: {
          enabled: true,
          status: 'ready',
          reason: null,
          credentialPresent: true,
          credentialSource: 'file',
          checkedAt: '2026-01-01T00:00:00.000Z',
          generation: 3,
        },
        unackedActionRequired: 2,
      }),
    );
    const trackers = document.querySelector<HTMLElement>('.rail-chip[data-chip="trackers"]');
    expect(trackers).not.toBeNull();
    const chip = trackers?.querySelector<HTMLElement>('#board-decisions');
    expect(chip?.textContent).toBe('Jev: READY');
    expect(chip?.dataset.state).toBe('ready');
    expect(chip?.classList.contains('pp-chip--done')).toBe(true);
    const unacked = trackers?.querySelector<HTMLElement>('#board-unacked');
    expect(unacked?.hidden).toBe(false);
    expect(unacked?.textContent).toContain('2 needs Gru');
  });

  it('shows the NEEDS GRU machine-queue chip only when the table has pending rows', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ unackedActionRequired: 0 }));
    const chip = document.querySelector<HTMLElement>('.rail-chip[data-chip="trackers"] #board-unacked');
    expect(chip?.hidden).toBe(true);
    view.render(snapshot({ unackedActionRequired: 2 }));
    expect(chip?.hidden).toBe(false);
    expect(chip?.textContent).toContain('2 needs Gru');
  });

  it('shows the wake tracker inside TRACKERS with the durable count and last-fire stamp', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ wakes: { count: 0, lastAt: null } }));
    expect(document.querySelector<HTMLElement>('.rail-chip[data-chip="trackers"] #board-wakes')?.hidden).toBe(true);
    view.render(snapshot({ wakes: { count: 3, lastAt: '2026-01-01T00:00:00.000Z' } }));
    const chip = document.querySelector<HTMLElement>('.rail-chip[data-chip="trackers"] #board-wakes');
    expect(chip?.hidden).toBe(false);
    expect(chip?.textContent).toContain('3 wakes');
    expect(chip?.title).toContain('wake turn');
  });
});

describe('board v6 — dense job rows', () => {
  beforeEach(mountBoardDom);

  it('renders one row pair: line 1 dot/title/status, line 2 branch/ages/PR link', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ prUrl: 'https://example.invalid/pr/7' })] }));
    const row = document.querySelector<HTMLElement>('.board-job');
    if (row === null) throw new Error('row missing');
    expect(row.dataset.jobId).toBe('job-1');
    expect(row.dataset.expanded).toBe('false');

    const head = row.querySelector('.board-job__head');
    expect(head?.querySelector('.board-job__dot')?.className).toContain('board-job__dot--rev');
    expect(head?.querySelector('.board-job__chevron')?.textContent).toBe('▸');
    expect(head?.querySelector('.board-job__name')?.textContent).toBe('Review job');
    expect(head?.querySelector('.board-job__status')?.textContent).toBe('in-review');

    const meta = row.querySelector('.board-job__meta');
    expect(meta?.querySelector('.board-job__repo')?.textContent).toBe('📦 demo');
    expect(meta?.querySelector('.board-job__branch')?.textContent).toContain('gru/job-1');
    expect(meta?.querySelector('.board-job__lane-age')?.textContent).toMatch(/lane \d+[smhd]/);
    expect(meta?.querySelector('.board-job__agent-age')?.textContent).toMatch(/agent \d+[smhd]/);
    expect(meta?.querySelector<HTMLAnchorElement>('.board-job__pr')?.getAttribute('href')).toBe(
      'https://example.invalid/pr/7',
    );

    // No detail nodes exist until the row is expanded.
    expect(row.querySelector('.board-job__body')).toBeNull();
    expect(document.querySelector('.board-lane, .board-round, .board-lens, .board-job__note')).toBeNull();
  });

  it('tints failing rows with the alert accent (left border) and leaves clean rows calm', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          baseJob({ id: 'clean', status: 'in-review' }),
          baseJob({ id: 'blocked', status: 'blocked' }),
          baseJob({ id: 'aborted', status: 'in-review', rounds: [baseRound({ status: 'aborted', verdict: null })] }),
          baseJob({
            id: 'lens-error',
            status: 'in-review',
            rounds: [baseRound({ status: 'live', lenses: [{ lens: 'blind', state: 'error', agentId: null, note: null, verdict: null }] })],
          }),
        ],
      }),
    );
    const failing = new Map(
      [...document.querySelectorAll<HTMLElement>('.board-job')].map((row) => [row.dataset.jobId, row.classList.contains('board-job--alert')]),
    );
    expect(failing.get('clean')).toBe(false);
    expect(failing.get('blocked')).toBe(true);
    expect(failing.get('aborted')).toBe(true);
    expect(failing.get('lens-error')).toBe(true);
    // A verdict-posted round closes the alarm.
    expect(jobFailing(baseJob({ rounds: [baseRound({ status: 'verdict-posted' })] }))).toBe(false);
    expect(jobFailing(baseJob({ status: 'done', rounds: [] }))).toBe(false);
  });

  it('expands inline from a click anywhere on the summary and collapses again; the PR link does not toggle', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ prUrl: 'https://example.invalid/pr/7' })] }));
    const row = document.querySelector<HTMLElement>('.board-job');
    if (row === null) throw new Error('row missing');
    const control = row.querySelector<HTMLButtonElement>('.board-job__toggle');
    if (control === null) throw new Error('toggle missing');

    row.querySelector<HTMLElement>('.board-job__meta')?.click();
    expect(row.dataset.expanded).toBe('true');
    expect(control.getAttribute('aria-expanded')).toBe('true');
    expect(row.querySelector('.board-job__body')).not.toBeNull();
    expect(row.querySelector('.board-lane')).not.toBeNull();
    expect(row.querySelector('.board-round')).not.toBeNull();
    expect(row.querySelector('.board-job__chevron')?.textContent).toBe('▾');

    const pr = row.querySelector<HTMLAnchorElement>('.board-job__pr');
    pr?.addEventListener('click', (event) => event.preventDefault());
    pr?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(row.dataset.expanded).toBe('true');

    control.click();
    expect(row.dataset.expanded).toBe('false');
    expect(row.querySelector('.board-job__body')).toBeNull();
    expect(row.querySelector('.board-job__chevron')?.textContent).toBe('▸');
  });

  it('persists per-job expansion in storage and restores it for a fresh view (reload)', () => {
    const storage = memoryStorage();
    const view = new BoardView(() => {}, null, storage);
    view.render(snapshot());
    expect(storage.getItem('gru-board-expanded-jobs')).toBeNull();

    document.querySelector<HTMLButtonElement>('.board-job__toggle')?.click();
    expect(JSON.parse(storage.getItem('gru-board-expanded-jobs') ?? 'null')).toEqual(['job-1']);

    // A fresh view over the same storage = a page reload.
    const reloaded = new BoardView(() => {}, null, storage);
    reloaded.render(snapshot());
    const row = document.querySelector<HTMLElement>('.board-job');
    expect(row?.dataset.expanded).toBe('true');
    expect(row?.querySelector('.board-job__body')).not.toBeNull();

    document.querySelector<HTMLButtonElement>('.board-job__toggle')?.click();
    expect(storage.getItem('gru-board-expanded-jobs')).toBeNull();
    const collapsedAgain = new BoardView(() => {}, null, storage);
    collapsedAgain.render(snapshot());
    expect(document.querySelector<HTMLElement>('.board-job')?.dataset.expanded).toBe('false');
  });

  it('keeps actionable state on the collapsed face: unacked action-required + failed live round', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          baseJob({
            rounds: [
              baseRound({
                lenses: [
                  { lens: 'blind', state: 'done', agentId: 'lens-agent', note: 'blocker — unsafe retry', verdict: 'blocker' },
                  { lens: 'security', state: 'error', agentId: 'lens-agent-2', note: 'provider cap hit', verdict: null },
                  { lens: 'tests', state: 'live', agentId: 'lens-agent-3', note: null, verdict: null },
                ],
              }),
            ],
          }),
        ],
        notifications: [notification('n1', { agentId: 'lens-agent' })],
        agents: [agent('lens-agent', { jobId: 'job-1' })],
        unackedActionRequired: 1,
      }),
    );
    const signal = document.querySelector('.board-job__signal');
    expect(signal?.textContent).toContain('1 action-required');
    expect(signal?.textContent).toContain('1 blocker');
    expect(signal?.textContent).toContain('1 lens failure');
    expect(signal?.classList.contains('pp-chip--alert')).toBe(true);
    expect(document.querySelector('.board-job__body')).toBeNull();
  });

  it('marks an aborted latest round on the collapsed row', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ rounds: [baseRound({ status: 'aborted', verdict: null })] })] }));
    const signal = document.querySelector('.board-job__signal');
    expect(signal?.textContent).toContain('round 1 aborted');
    expect(signal?.classList.contains('pp-chip--alert')).toBe(true);
    expect(document.querySelector('.board-job__body')).toBeNull();
  });

  it('a new live round updates the collapsed signal without auto-expanding', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ rounds: [baseRound({ status: 'pending' })] })] }));
    expect(document.querySelector('.board-job__signal')?.textContent).toContain('pending');

    view.render(snapshot());
    const row = document.querySelector<HTMLElement>('.board-job');
    expect(row?.dataset.expanded).toBe('false');
    expect(row?.querySelector('.board-job__body')).toBeNull();
    expect(row?.querySelector('.board-job__signal')?.textContent).toContain('live');
  });

  it('slides in only the rows new to the view (8px enter animation)', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ id: 'first', status: 'in-review' })] }));
    expect(document.querySelector('.board-job--enter')).toBeNull();

    view.render(
      snapshot({ jobs: [baseJob({ id: 'first', status: 'in-review' }), baseJob({ id: 'second', status: 'in-review' })] }),
    );
    const entering = [...document.querySelectorAll<HTMLElement>('.board-job--enter')].map(
      (node) => node.dataset.jobId,
    );
    expect(entering).toEqual(['second']);
  });
});

describe('board v6 — bands', () => {
  beforeEach(mountBoardDom);

  it('renders sticky band headers with counts in NEEDS YOU → IN FLIGHT → SETTLED → COLD order', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          baseJob({ id: 'cold-1', status: 'parked' }),
          baseJob({ id: 'settled-1', status: 'delivered' }),
          baseJob({ id: 'flight-1', status: 'in-review' }),
          baseJob({ id: 'needs-1', status: 'blocked' }),
        ],
      }),
    );
    const bands = [...document.querySelectorAll<HTMLElement>('#board-jobs .board-band')];
    expect(bands.map((band) => band.querySelector('.board-band__label')?.textContent)).toEqual([
      'NEEDS YOU',
      'IN FLIGHT',
      'SETTLED',
      'COLD',
    ]);
    // Sticky separators: a header per band, carrying the count.
    for (const band of bands) {
      expect(band.querySelector('.board-band__head')).not.toBeNull();
      expect(band.querySelector('.board-band__count')?.textContent).toBe('1 job');
    }
    expect(bands[0]?.querySelector('.board-job')?.getAttribute('data-job-id')).toBe('needs-1');
    expect(bands[1]?.querySelector('.board-job')?.getAttribute('data-job-id')).toBe('flight-1');
    expect(bands[2]?.querySelector('.board-job')?.getAttribute('data-job-id')).toBe('settled-1');
    expect(bands[3]?.querySelector('.board-job')?.getAttribute('data-job-id')).toBe('cold-1');
    expect(bands[0]?.querySelector('.board-job')?.getAttribute('data-band')).toBe('needs-you');
    // Dense rows, not a card grid.
    expect(document.querySelector('.board-band__grid')).toBeNull();
    expect(document.querySelector('.board-band__rows')).not.toBeNull();
  });

  it('promotes a conflicting PR to NEEDS YOU and demotes a stalled working lane to COLD with a stale flag', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          baseJob({
            id: 'conflicting-job',
            status: 'in-review',
            prUrl: 'https://x/1',
            prState: 'conflicting',
          }),
          baseJob({
            id: 'stalled-job',
            status: 'working',
            lastAgentActivity: new Date(Date.now() - 45 * 60_000).toISOString(),
          }),
          baseJob({ id: 'fresh-job', status: 'working' }),
        ],
      }),
    );
    const bands = [...document.querySelectorAll<HTMLElement>('#board-jobs .board-band')];
    expect(bands.map((band) => band.querySelector('.board-band__label')?.textContent)).toEqual(['NEEDS YOU', 'IN FLIGHT', 'COLD']);
    expect(bands[0]?.querySelector('.board-job')?.getAttribute('data-job-id')).toBe('conflicting-job');
    expect(bands[1]?.querySelector('.board-job')?.getAttribute('data-job-id')).toBe('fresh-job');
    const stalled = bands[2]?.querySelector<HTMLElement>('.board-job');
    expect(stalled?.getAttribute('data-job-id')).toBe('stalled-job');
    expect(stalled?.querySelector('.board-job__stale')?.textContent).toBe('stalled');
  });

  it('attributes unacked action-required notifications through agent bindings', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [baseJob({ id: 'quiet-job', status: 'parked' })],
        agents: [agent('minion-1', { role: 'minion', jobId: 'quiet-job' })],
        notifications: [notification('n1', { agentId: 'minion-1' })],
        unackedActionRequired: 1,
      }),
    );
    const band = document.querySelector<HTMLElement>('#board-jobs .board-band');
    expect(band?.querySelector('.board-band__label')?.textContent).toBe('NEEDS YOU');
    expect(band?.querySelector('.board-job')?.getAttribute('data-job-id')).toBe('quiet-job');
  });

  it('credits every row with its repo — grouping rides the rows, not wrapper shells', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        repos: [
          {
            name: 'alpha',
            jobs: [
              baseJob({ id: 'a-needs', repo: 'alpha', status: 'blocked' }),
              baseJob({ id: 'a-flight', repo: 'alpha', status: 'in-review' }),
            ],
          },
          { name: 'beta', jobs: [baseJob({ id: 'b-needs', repo: 'beta', status: 'blocked' })] },
        ],
      }),
    );
    const bands = [...document.querySelectorAll<HTMLElement>('#board-jobs .board-band')];
    const needsYou = bands[0];
    expect(needsYou?.querySelector('.board-band__label')?.textContent).toBe('NEEDS YOU');
    const needsRepos = [...(needsYou?.querySelectorAll('.board-job__repo') ?? [])].map((node) => node.textContent);
    expect(needsRepos).toContain('📦 alpha');
    expect(needsRepos).toContain('📦 beta');
    const flight = bands[1];
    expect(flight?.querySelector('.board-job__repo')?.textContent).toBe('📦 alpha');
  });

  it('renders the latest 10 settled jobs with a +K footer that expands the tail for the session', () => {
    const jobs = Array.from({ length: 12 }, (_, index) =>
      baseJob({
        id: `settled-${String(index).padStart(2, '0')}`,
        status: 'delivered',
        updatedAt: new Date(Date.now() - index * 60_000).toISOString(),
      }),
    );
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs }));

    const settled = document.querySelector('.board-band--settled');
    expect(settled?.querySelectorAll('.board-job')).toHaveLength(10);
    expect(settled?.querySelector('.board-band__count')?.textContent).toBe('12 jobs');
    const more = settled?.querySelector<HTMLButtonElement>('.board-band__more');
    expect(more?.textContent).toBe('+2 older settled');

    more?.click();
    const expanded = document.querySelector('.board-band--settled');
    expect(expanded?.querySelectorAll('.board-job')).toHaveLength(12);
    expect(expanded?.querySelector('.board-band__more')).toBeNull();

    // Expanded is a session state: the next snapshot push keeps it open.
    view.render(snapshot({ jobs }));
    expect(document.querySelectorAll('.board-band--settled .board-job')).toHaveLength(12);
  });

  it('never hides an empty NEEDS YOU — a calm satisfied state carries the good news', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ id: 'flight', status: 'in-review' })] }));
    const needsYou = document.querySelector('.board-band--needs-you');
    expect(needsYou?.querySelector('.board-band__label')?.textContent).toBe('NEEDS YOU');
    expect(needsYou?.querySelector('.board-band__clear-text')?.textContent).toBe('nothing needs you');
    expect(needsYou?.querySelector('.board-band__clear-mark')?.textContent).toBe('✓');
  });
});

describe('board v4.1/v6 — stale review pills on concluded jobs', () => {
  beforeEach(mountBoardDom);

  it('suppresses stale review liveness pills on merged/done rows', () => {
    const view = new BoardView(() => {});
    const quietRound = { blockers: 0, lenses: [], lensAttempts: [] } as const;
    view.render(
      snapshot({
        jobs: [
          baseJob({ id: 'merged-live', status: 'merged', rounds: [baseRound({ ...quietRound, status: 'live' })] }),
          baseJob({ id: 'done-pending', status: 'done', rounds: [baseRound({ ...quietRound, status: 'pending' })] }),
        ],
      }),
    );
    expect(document.querySelector('.board-job__signal')).toBeNull();
  });

  it('renders a merged job’s history quiescent: no blocker/failure chips, one ledger pointer', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          baseJob({
            id: 'merged-aborted',
            status: 'merged',
            rounds: [
              baseRound({ status: 'aborted', verdict: null }),
              baseRound({ id: 'job-1-r2', seq: 2, status: 'verdict-posted', verdict: 'approved', blockers: 0, lenses: [] }),
            ],
          }),
        ],
      }),
    );
    document.querySelector<HTMLButtonElement>('.board-job__toggle')?.click();
    const body = document.querySelector('.board-job__body');
    expect(body).not.toBeNull();
    // Only the LAST round survives, quiet: no blockers/failures chips.
    expect(body?.querySelectorAll('.board-round')).toHaveLength(1);
    expect(body?.querySelector('.board-round--quiescent')).not.toBeNull();
    expect(body?.querySelector('.board-round__blockers')).toBeNull();
    expect(body?.querySelector('.board-round__failures')).toBeNull();
    expect(body?.querySelector('.board-job__reviewed')?.textContent).toContain('review history on the ledger');
  });

  it('keeps live rounds alarming on in-flight jobs (the suppression is scoped to concluded)', () => {
    const view = new BoardView(() => {});
    view.render(snapshot());
    document.querySelector<HTMLButtonElement>('.board-job__toggle')?.click();
    const round = document.querySelector('.board-round');
    expect(round?.classList.contains('board-round--quiescent')).toBe(false);
    expect(document.querySelector('.board-round__blockers')?.textContent).toContain('1 blocker');
  });
});

describe('board agent rail — dense rows, tabs count, disposed collapse', () => {
  beforeEach(mountBoardDom);

  it('collapses disposed rows by default, expands on toggle, and keeps the toggle across pushes', () => {
    const view = new BoardView(() => {});
    const agents = [
      agent('live-lens', { state: 'streaming', label: 'blind:001' }),
      agent('live-gru', { role: 'gru', state: 'idle' }),
      agent('old-gru', { role: 'gru', state: 'disposed', label: 'gru · old epoch' }),
      agent('old-lens', { state: 'disposed', label: 'blind:001#2' }),
    ];
    view.render(snapshot({ agents }));
    // Live rows only — the graveyard is behind the toggle.
    expect(document.querySelectorAll('#board-agents .board-agent')).toHaveLength(2);
    expect(document.querySelector('#board-agents .board-agent--disposed')).toBeNull();
    const toggle = document.querySelector<HTMLButtonElement>('.board-agent-toggle');
    expect(toggle?.textContent).toContain('2 disposed');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    // The AGENTS tab counts the live crew.
    expect(document.getElementById('rail-agents-count')?.textContent).toBe('2');

    toggle?.click();
    expect(document.querySelectorAll('#board-agents .board-agent')).toHaveLength(4);
    expect(document.querySelectorAll('#board-agents .board-agent--disposed')).toHaveLength(2);
    expect(document.querySelector('.board-agent-toggle')?.getAttribute('aria-expanded')).toBe('true');

    // A snapshot push re-renders: the expanded state survives.
    view.render(snapshot({ agents }));
    expect(document.querySelectorAll('#board-agents .board-agent--disposed')).toHaveLength(2);

    document.querySelector<HTMLButtonElement>('.board-agent-toggle')?.click();
    expect(document.querySelectorAll('#board-agents .board-agent')).toHaveLength(2);
  });

  it('renders dense rows: dot + name + hash + role·state subline + right chip', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        agents: [agent('minion-live', { role: 'minion', label: 'Payment lane', state: 'streaming' })],
      }),
    );
    const row = document.querySelector<HTMLElement>('#board-agents .board-agent');
    expect(row?.dataset.state).toBe('streaming');
    expect(row?.querySelector('.board-agent__dot')).not.toBeNull();
    expect(row?.querySelector('.board-agent__name')?.textContent).toBe('Payment lane');
    expect(row?.querySelector('.board-agent__hash')?.textContent).toBe('minion-live'.slice(0, 8));
    expect(row?.querySelector('.board-agent__sub')?.textContent).toContain('minion · streaming');
    expect(row?.querySelector('.board-agent__state')?.textContent).toBe('streaming');
  });

  it('tints error rows with the alert accent', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        agents: [
          agent('faulty', { state: 'error' }),
          agent('healthy', { state: 'idle' }),
        ],
      }),
    );
    const rows = [...document.querySelectorAll<HTMLElement>('#board-agents .board-agent')];
    const byId = new Map(rows.map((row) => [row.querySelector('.board-agent__name')?.textContent, row]));
    expect(byId.get('faulty')?.classList.contains('board-agent--error')).toBe(true);
    expect(byId.get('healthy')?.classList.contains('board-agent--error')).toBe(false);
  });

  it('shows a turn-age counter on streaming agents only', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        agents: [
          agent('streaming-lens', { state: 'streaming', lastActivity: new Date(Date.now() - 90_000).toISOString() }),
          agent('idle-lens', { state: 'idle' }),
          agent('disposed-lens', { state: 'disposed' }),
        ],
      }),
    );
    const streaming = document.querySelector('#board-agents .board-agent');
    expect(streaming?.textContent).toContain('streaming-lens');
    expect(streaming?.querySelector('.board-agent__age')?.textContent).toMatch(/^\d+[smhd] quiet$/);
    expect(document.querySelectorAll('#board-agents .board-agent__age')).toHaveLength(1);
  });
});

describe('board v6 — job status tones', () => {
  beforeEach(mountBoardDom);

  it('renders the delivered chip in the work color family and its dot in the same tone', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ status: 'delivered' })] }));
    const row = document.querySelector('#board-jobs .board-job');
    const chip = row?.querySelector('.board-job__status');
    expect(chip?.textContent).toBe('delivered');
    expect(chip?.className).toContain('pp-chip--work');
    expect(chip?.className).not.toContain('pp-chip--rev');
    expect(row?.querySelector('.board-job__dot')?.className).toContain('board-job__dot--work');
  });
});
