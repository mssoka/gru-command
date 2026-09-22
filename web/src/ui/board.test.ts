// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentView,
  BoardSnapshot,
  JobView,
  NotificationView,
  RoundView,
} from '../lib/board-protocol.js';
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

  it('renders the lane strip (branch, base sha, lane age, agent activity age)', () => {
    const view = new BoardView(() => {});
    view.render(snapshot());
    expect(document.querySelector('.board-lane__branch')?.textContent).toContain('gru/job-1');
    expect(document.querySelector('.board-lane__base')?.textContent).toContain('abc1234');
    expect(document.querySelector('.board-lane__age')?.textContent).toMatch(/lane \d+[smhd]/);
    expect(document.querySelector('.board-lane__activity')?.textContent).toMatch(/agent \d+[smhd]/);
  });

  it('renders round progress: done/total lenses, blockers, elapsed, and per-lens attempt counts', () => {
    const view = new BoardView(() => {});
    view.render(snapshot({ jobs: [baseJob({ rounds: [baseRound({ lensAttempts: [{ lens: 'blind', attempts: 2 }, { lens: 'security', attempts: 1 }] })] })] }));
    const progress = document.querySelector('.board-round__progress');
    expect(progress?.textContent).toContain('2/2 lenses');
    expect(progress?.textContent).toContain('1 blocker');
    expect(progress?.querySelector('.board-round__elapsed')?.textContent).toMatch(/\d+[smhd] elapsed/);
    const blind = document.querySelector<HTMLElement>('.board-lens');
    expect(blind?.textContent).toContain('blind ×2');
    expect(blind?.classList.contains('board-lens--blocker')).toBe(true);
    expect(blind?.title).toContain('unsafe retry');
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
