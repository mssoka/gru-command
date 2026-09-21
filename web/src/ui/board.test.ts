// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardSnapshot, NotificationView } from '../lib/board-protocol.js';
import { BoardView } from './board.js';

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

function snapshot(notifications: readonly NotificationView[] = []): BoardSnapshot {
  return {
    repos: [{
      name: 'demo',
      jobs: [{
        id: 'job-1', repo: 'demo', title: 'Review job', status: 'in-review',
        updatedAt: '2026-01-01T00:00:00.000Z', prUrl: null, baseBranch: 'main', note: null,
        rounds: [{
          id: 'job-1-r1', seq: 1, status: 'live', verdict: null, targetRef: 'abc',
          updatedAt: '2026-01-01T00:00:00.000Z',
          lenses: [{
            lens: 'security', state: 'done', agentId: null,
            note: 'diagnostic prose changed completely',
          }],
        }],
      }],
    }],
    agents: [],
    notifications,
    decisions: {
      enabled: false, status: 'disabled', reason: 'disabled', model: '~typesafe/jev-latest',
      endpoint: 'https://openrouter.ai/api/alpha/decisions', credentialPresent: false,
      credentialSource: 'none', checkedAt: null, incarnation: 'test-incarnation', generation: 0,
    },
  };
}

describe('board view resolved-notification rendering', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="board-jobs"></div>
      <div id="board-agents"></div>
      <button id="notification-bell"></button>
      <div id="notification-panel"><div id="notification-list"></div></div>
    `;
  });

  it('removes ack/badge/toast behavior for resolved rows while retaining active controls', () => {
    const toast = vi.fn();
    const view = new BoardView(() => {});
    view.setToastHandler(toast);
    const first = notification('first');
    view.render(snapshot([first]));
    expect(document.querySelectorAll('.board-notification__ack')).toHaveLength(1);

    const resolved = { ...first, resolvedAt: '2026-01-01T00:01:00.000Z', resolvedBy: 'runtime' };
    view.render(snapshot([resolved]));
    expect(document.querySelector('.board-notification__title')?.textContent).toContain('resolved');
    expect(document.querySelectorAll('.board-notification__ack')).toHaveLength(0);
    expect(document.querySelector<HTMLElement>('#notification-bell')?.dataset.unread).toBe('0');
    expect(toast).not.toHaveBeenCalled();

    view.render(snapshot([
      resolved,
      notification('arrived-resolved', { resolvedAt: '2026-01-01T00:02:00.000Z', resolvedBy: 'runtime' }),
      notification('active'),
    ]));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ id: 'active' }));
    expect(document.querySelectorAll('.board-notification__ack')).toHaveLength(1);
  });
});
