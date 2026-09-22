// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentView,
  BoardSnapshot,
  JobView,
  NotificationView,
  RoundView,
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
  } = {},
): BoardSnapshot {
  return {
    repos: [{ name: 'demo', jobs: options.jobs ?? [baseJob()] }],
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
  };
}

function mountBoardDom(): void {
  document.body.innerHTML = `
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
