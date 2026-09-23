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
import { BoardView } from './board.js';

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
  };
}

function mountBoardDom(): void {
  document.body.innerHTML = `
    <div id="board-kpis"></div>
    <div id="board-health"></div>
    <div id="board-jobs"></div>
    <div id="board-agents"></div>
    <button id="notification-bell"><span id="notification-badge">0</span></button>
    <div id="notification-panel"><div id="notification-list"></div></div>
    <span id="board-decisions"></span>
    <span id="board-unacked" hidden></span>
  `;
}

describe('board view resolved-notification rendering', () => {
  beforeEach(mountBoardDom);

  it('removes ack/badge/toast behavior for resolved rows while retaining active controls', () => {
    const toast = vi.fn();
    const view = new BoardView(() => {});
    view.setToastHandler(toast);
    const first = notification('first');
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
          notification('active'),
        ],
      }),
    );
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ id: 'active' }));
    expect(document.querySelectorAll('.board-notification__ack')).toHaveLength(1);
  });
});

describe('board trackers', () => {
  beforeEach(mountBoardDom);

  it('renders the lane strip (branch, base sha, lane age, agent activity age) once expanded', () => {
    const view = new BoardView(() => {});
    view.render(snapshot());
    expect(document.querySelector('.board-lane')).toBeNull(); // collapsed default
    document.querySelector<HTMLButtonElement>('.board-job__toggle')?.click();
    expect(document.querySelector('.board-lane__branch')?.textContent).toContain('gru/job-1');
    expect(document.querySelector('.board-lane__base')?.textContent).toContain('abc1234');
    expect(document.querySelector('.board-lane__age')?.textContent).toMatch(/lane \d+[smhd]/);
    expect(document.querySelector('.board-lane__activity')?.textContent).toMatch(/agent \d+[smhd]/);
  });

  it('condenses the round header: progress, blockers and failures inline; lens chips behind the row', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ rounds: [baseRound({ lensAttempts: [{ lens: 'blind', attempts: 2 }, { lens: 'security', attempts: 1 }] })] })] }));
    document.querySelector<HTMLButtonElement>('.board-job__toggle')?.click();
    const round = document.querySelector<HTMLButtonElement>('.board-round__toggle');
    expect(round?.textContent).toContain('round 1');
    expect(round?.textContent).toContain('live');
    expect(round?.textContent).toContain('2/2 lenses');
    expect(round?.textContent).toContain('1 blocker');
    expect(round?.querySelector('.board-round__elapsed')?.textContent).toMatch(/\d+[smhd] elapsed/);
    expect(round?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelectorAll('.board-lens')).toHaveLength(0);

    round?.click();
    expect(round?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('.board-lens')).toHaveLength(2);
    const blind = document.querySelector<HTMLElement>('.board-lens');
    expect(blind?.textContent).toContain('blind ×2');
    expect(blind?.classList.contains('board-lens--blocker')).toBe(true);
    expect(blind?.title).toContain('unsafe retry');

    round?.click();
    expect(document.querySelectorAll('.board-lens')).toHaveLength(0);
  });

  it('renders the Jev decisions chip with the live status tone', () => {
    const view = new BoardView(() => {});
    view.render(snapshot());
    const chip = document.querySelector<HTMLElement>('#board-decisions');
    expect(chip?.textContent).toBe('Jev: OFF');
    expect(chip?.dataset.state).toBe('disabled');

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
      }),
    );
    expect(chip?.textContent).toBe('Jev: READY');
    expect(chip?.dataset.state).toBe('ready');
    expect(chip?.classList.contains('pp-chip--done')).toBe(true);
  });

  it('shows the unacked action-required badge only when the table has pending rows', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ unackedActionRequired: 0 }));
    const chip = document.querySelector<HTMLElement>('#board-unacked');
    expect(chip?.hidden).toBe(true);

    view.render(snapshot({ unackedActionRequired: 2 }));
    expect(chip?.hidden).toBe(false);
    expect(chip?.textContent).toContain('2 action-required');
  });
});

describe('board agent rail — disposed collapse and turn-age', () => {
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

describe('board view job status chips', () => {
  beforeEach(mountBoardDom);

  it('renders the delivered chip in the work color family (the same token in light and dark)', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ status: 'delivered' })] }));
    const chip = document.querySelector('#board-jobs .board-job .pp-chip');
    expect(chip?.textContent).toBe('delivered');
    expect(chip?.className).toContain('pp-chip--work');
    // The tone class carries the state color in both themes (tokens.css).
    expect(chip?.className).not.toContain('pp-chip--rev');
  });
});

describe('board card collapse (v3)', () => {
  beforeEach(mountBoardDom);

  function clickToggle(card: Element): void {
    card.querySelector<HTMLButtonElement>('.board-job__toggle')?.click();
  }

  it('renders collapsed cards as summary only: title, status, one meta line, PR link', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ prUrl: 'https://example.invalid/pr/7' })] }));
    const card = document.querySelector('.board-job');
    expect(card?.querySelector('.board-job__name')?.textContent).toBe('Review job');
    expect(card?.querySelector('.board-job__status')?.textContent).toBe('in-review');
    expect(card?.querySelector<HTMLAnchorElement>('.board-job__pr')?.getAttribute('href')).toBe(
      'https://example.invalid/pr/7',
    );
    expect(card?.querySelector('.board-job__meta')?.textContent).toContain('job-1');
    // No detail nodes exist until the card is expanded.
    expect(card?.querySelector('.board-job__body')).toBeNull();
    expect(document.querySelector('.board-lane, .board-round, .board-lens, .board-job__note')).toBeNull();
    const control = card?.querySelector<HTMLButtonElement>('.board-job__toggle');
    expect(control?.tagName).toBe('BUTTON');
    expect(control?.getAttribute('aria-expanded')).toBe('false');
    expect(card?.querySelector('.board-job__chevron')?.textContent).toBe('▸');
  });

  it('expands from a click anywhere on the summary and collapses again; the PR link does not toggle', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ prUrl: 'https://example.invalid/pr/7' })] }));
    const card = document.querySelector<HTMLElement>('.board-job');
    if (card === null) throw new Error('card missing');
    const control = card.querySelector<HTMLButtonElement>('.board-job__toggle');
    if (control === null) throw new Error('toggle missing');

    card.querySelector<HTMLElement>('.board-job__meta')?.click();
    expect(card.dataset.expanded).toBe('true');
    expect(control.getAttribute('aria-expanded')).toBe('true');
    expect(card.querySelector('.board-job__body')).not.toBeNull();
    expect(card.querySelector('.board-lane')).not.toBeNull();
    expect(card.querySelector('.board-round')).not.toBeNull();
    expect(card.querySelector('.board-job__chevron')?.textContent).toBe('▾');

    // The PR link owns its click — the card stays open. (The test cancels
    // the navigation itself; the component's stopPropagation is the claim.)
    const pr = card.querySelector<HTMLAnchorElement>('.board-job__pr');
    pr?.addEventListener('click', (event) => event.preventDefault());
    pr?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(card.dataset.expanded).toBe('true');

    control.click();
    expect(card.dataset.expanded).toBe('false');
    expect(control.getAttribute('aria-expanded')).toBe('false');
    expect(card.querySelector('.board-job__body')).toBeNull();
    expect(card.querySelector('.board-job__chevron')?.textContent).toBe('▸');
  });

  it('persists per-job expansion in storage and restores it for a fresh view (reload)', () => {
    const storage = memoryStorage();
    const view = new BoardView(() => {}, null, storage);
    view.render(snapshot());
    expect(storage.getItem('gru-board-expanded-jobs')).toBeNull();

    clickToggle(document.querySelector('.board-job') as Element);
    expect(JSON.parse(storage.getItem('gru-board-expanded-jobs') ?? 'null')).toEqual(['job-1']);

    // A fresh view over the same storage = a page reload.
    const reloaded = new BoardView(() => {}, null, storage);
    reloaded.render(snapshot());
    const card = document.querySelector<HTMLElement>('.board-job');
    expect(card?.dataset.expanded).toBe('true');
    expect(card?.querySelector('.board-job__body')).not.toBeNull();

    clickToggle(card as Element);
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

  it('marks an aborted latest round on the collapsed card', () => {
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
    const card = document.querySelector<HTMLElement>('.board-job');
    expect(card?.dataset.expanded).toBe('false');
    expect(card?.querySelector('.board-job__body')).toBeNull();
    expect(card?.querySelector('.board-job__signal')?.textContent).toContain('live');
  });
});

describe('board v4 — KPI strip', () => {
  beforeEach(mountBoardDom);

  it('renders job status, PR, and lane counts derived from the same snapshot', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot({
        jobs: [
          baseJob({ id: 'w1', status: 'working' }),
          baseJob({ id: 'w2', status: 'working' }),
          baseJob({ id: 'r1', status: 'in-review' }),
          baseJob({ id: 'm1', status: 'merged', prUrl: 'https://x/1', prState: 'merged' }),
          baseJob({ id: 'p1', status: 'parked' }),
          baseJob({ id: 'i1', status: 'in-review', prUrl: 'https://x/2', prState: 'conflicting' }),
        ],
        agents: [
          agent('minion-live', { role: 'minion', state: 'streaming', lastActivity: new Date(Date.now() - 30_000).toISOString() }),
          agent('minion-idle', { role: 'minion', state: 'idle' }),
          agent('minion-dead', { role: 'minion', state: 'disposed' }),
          agent('lens', { role: 'perkins', state: 'streaming', lastActivity: new Date(Date.now() - 600_000).toISOString() }),
        ],
      }),
    );
    const groups = [...document.querySelectorAll('#board-kpis .board-kpi')];
    expect(groups).toHaveLength(3);
    const text = document.getElementById('board-kpis')?.textContent ?? '';
    expect(text).toContain('working');
    expect(text).toContain('in-review');
    expect(text).toContain('merged today');
    expect(text).toContain('live minions');
    expect(text).toContain('disposed');

    const stats = [...document.querySelectorAll<HTMLElement>('#board-kpis .board-kpi__stat')].map((node) => ({
      label: node.querySelector('.board-kpi__label')?.textContent ?? '',
      value: node.querySelector('.board-kpi__value')?.textContent ?? '',
    }));
    const byLabel = new Map(stats.map((stat) => [stat.label, stat.value]));
    expect(byLabel.get('working')).toBe('2');
    expect(byLabel.get('in-review')).toBe('2');
    expect(byLabel.get('merged')).toBe('1');
    expect(byLabel.get('parked')).toBe('1');
    expect(byLabel.get('conflicting')).toBe('1');
    expect(byLabel.get('open')).toBe('0');
    expect(byLabel.get('live minions')).toBe('2');
    expect(byLabel.get('mid-turn')).toBe('2');
    expect(byLabel.get('disposed')).toBe('1');
    // Mid-turn carries the oldest quiet age.
    const midTurn = [...document.querySelectorAll<HTMLElement>('#board-kpis .board-kpi__stat')].find(
      (node) => node.querySelector('.board-kpi__label')?.textContent === 'mid-turn',
    );
    expect(midTurn?.querySelector('.board-kpi__age')?.textContent).toMatch(/oldest \d+[smhd]/);
  });
});

describe('board v4 — health row', () => {
  beforeEach(mountBoardDom);

  it('renders the deploy-drift card with the restart-pending flag when behind', () => {
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
    const deploy = document.querySelector<HTMLElement>('.board-health__card[data-card="deploy"]');
    expect(deploy?.querySelector('.board-health__value')?.textContent).toBe('43 behind');
    expect(deploy?.querySelector('.board-health__flag')?.textContent).toBe('RESTART PENDING');
    expect(deploy?.classList.contains('board-health__card--alert')).toBe(true);
    expect(document.querySelectorAll('.board-health__card')).toHaveLength(6);
  });

  it('renders n/a honestly for unwired sources (verify queue, cure efficacy)', () => {
    const view = new BoardView(() => {});
    view.render(snapshot());
    const valueOf = (card: string): string | undefined =>
      document
        .querySelector<HTMLElement>(`.board-health__card[data-card="${card}"] .board-health__value`)
        ?.textContent ?? undefined;
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
    const verify = document.querySelector<HTMLElement>('.board-health__card[data-card="verify"]');
    expect(verify?.querySelector('.board-health__value')?.textContent).toBe('lock held');
    expect(verify?.querySelector('.board-health__detail')?.textContent).toContain('2 queued');
  });
});

describe('board v4 — attention-bucketed job ordering', () => {
  beforeEach(mountBoardDom);

  it('renders bands in NEEDS YOU → IN FLIGHT → SETTLED → COLD order with visible headers', () => {
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
    expect(bands[0]?.querySelector('.board-job')?.getAttribute('data-job-id')).toBe('needs-1');
    expect(bands[1]?.querySelector('.board-job')?.getAttribute('data-job-id')).toBe('flight-1');
    expect(bands[2]?.querySelector('.board-job')?.getAttribute('data-job-id')).toBe('settled-1');
    expect(bands[3]?.querySelector('.board-job')?.getAttribute('data-job-id')).toBe('cold-1');
    // Band membership rides the row too.
    expect(bands[0]?.querySelector('.board-job')?.getAttribute('data-band')).toBe('needs-you');
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

  it('keeps repo grouping inside a band (a repo appears once per band it has jobs in)', () => {
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
    const repoNames = [...(needsYou?.querySelectorAll('.board-repo__name') ?? [])].map((node) => node.textContent);
    expect(repoNames).toEqual(['📦 alpha', '📦 beta']);
    const flight = bands[1];
    expect(flight?.querySelector('.board-repo__name')?.textContent).toBe('📦 alpha');
  });
});
