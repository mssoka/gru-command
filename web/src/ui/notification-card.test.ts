// @vitest-environment happy-dom

/**
 * Readable notification card — fixed long-content contract (owner release
 * 2026-10-11).
 *
 * This file is deliberately self-contained and imports only modules that
 * existed BEFORE the change, so the same bytes can run against an isolated
 * pre-change base snapshot as the fail-before oracle for the pictured
 * defect: the base renders the whole diagnostic prose inside the faint
 * uppercase `.lbl` metadata line and offers no Details disclosure or typed
 * decision controls, so every assertion here REDs there BY ASSERTION
 * (never by import/setup failure). At the change head it passes.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { BoardSnapshot, NotificationDecisionView, NotificationView } from '../lib/board-protocol.js';
import { BoardView } from './board.js';

const T0 = '2026-10-11T00:00:00.000Z';
const LONG_DIAGNOSTIC =
  'Decisions for job job-1234567890abcdef are blocked: the frozen head ' +
  'a40e6a963f8c2b1d4e5f60718293a4b5c6d7e8f9 no longer matches the recorded branch state ' +
  '(capture 2bbd77ac-9851-3b7e-480c-ef21963caf54), and the reconciliation manifest at ' +
  '/home/tester/.gru-command/captures/ops-sweep-20261009T000000Z/reconcile/PR285-interrupted-original-capture-provenance/manifest.json ' +
  'is missing. No replay, new directive or false restart was attempted.';

function mountBoardDom(): void {
  document.body.innerHTML = `
    <div id="command-health" hidden>
      <span id="command-health-summary"></span>
      <span id="command-health-parts"></span>
      <span id="board-decisions"></span>
      <span id="board-wakes" hidden></span>
    </div>
    <section id="board-kpis" hidden></section>
    <nav id="board-nav" hidden></nav>
    <section id="board-owner" hidden></section>
    <div id="board-jobs"></div>
    <div id="board-agents"></div>
    <section id="board-repos" data-rail-panel="agents"></section>
    <span id="rail-agents-count">0</span>
    <button id="notification-bell"><span id="notification-badge">0</span></button>
    <div id="notification-panel"><div id="notification-list"></div></div>
  `;
}

function decision(): NotificationDecisionView {
  return {
    question: 'Approve the slim contract and re-commission the lane?',
    context: 'PR256 is blocked on interrupted ownership and a conflicting main.',
    recommendation: 'Approve the slim contract; keep PR257 separate.',
    reservedClass: 'scope-design',
    whyNotDelegable: 'It changes the agreed scope of an owner-visible heist.',
    options: [
      { id: 'approve', label: 'Approve the slim contract', consequence: 'Gru re-arms the existing lane.' },
      { id: 'keep', label: 'Keep the current approach', consequence: 'The lane stays parked.' },
    ],
    discussion: false,
  };
}

function notification(overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    id: 'n1',
    ts: T0,
    kind: 'test.notice',
    routing: 'action-required',
    severity: 'error',
    title: 'A diagnostic notice with a long title that must wrap',
    detail: LONG_DIAGNOSTIC,
    agentId: null,
    shownAt: null,
    ackedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

function snapshot(notifications: readonly NotificationView[]): BoardSnapshot {
  return {
    repos: [],
    agents: [],
    notifications,
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: 'disabled',
      model: '~typesafe/jev-latest',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'notification-card-test',
      generation: 0,
    },
    unackedActionRequired: 0,
    unackedNeedsOwner: 0,
    wakes: { count: 0, lastAt: null },
  };
}

describe('readable notification card — fixed long-content contract', () => {
  beforeEach(mountBoardDom);

  it('keeps the long mixed-case prose out of the label line and preserves it verbatim behind Details', () => {
    const view = new BoardView(() => {});
    view.render(snapshot([notification({ id: 'long' })]));
    const card = document.querySelector<HTMLElement>('[data-notification-id="long"]');
    // At the pre-change base this is null: the row carries no card identity
    // and no disclosure — the assertion is the fail-before oracle.
    expect(card).not.toBeNull();
    if (card === null) return;
    const details = card.querySelector<HTMLDetailsElement>('.board-notification__details');
    expect(details).not.toBeNull();
    expect(card.querySelector('.board-notification__detail-text')?.textContent).toBe(LONG_DIAGNOSTIC);
    // The short metadata label never carries the diagnostic prose.
    expect(card.querySelector('.board-notification__meta')?.textContent).not.toContain('job-1234567890abcdef');
    expect(card.querySelector('.board-notification__meta')?.textContent).not.toContain('/home/tester/');
  });

  it('renders typed owner decision options with consequences and no generic Ack', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot([
        notification({
          id: 'decision-1',
          kind: 'gru.owner-escalation',
          routing: 'needs-owner',
          severity: 'info',
          title: 'PR256 resumption requested',
          detail: LONG_DIAGNOSTIC,
          decision: decision(),
        }),
      ]),
    );
    const band = document.getElementById('board-owner')!;
    expect(band.querySelector('.board-notification__question')).not.toBeNull();
    expect(band.querySelector('.board-notification__recommendation')?.textContent).toContain('Gru recommends');
    expect(band.querySelector('.board-notification__why')?.textContent).toContain('Why this needs you');
    expect(band.querySelectorAll('.board-notification__option-button')).toHaveLength(2);
    expect(band.textContent).toContain('Gru re-arms the existing lane.');
    // No generic Ack survives on the owner surface (the base renders one).
    expect(band.querySelector('.board-owner__ack')).toBeNull();
    expect(band.querySelector('.board-notification__ack')).toBeNull();
  });

  it('an owner notice explains the manual step instead of inventing a control', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot([
        notification({
          id: 'notice-1',
          kind: 'port-squat',
          routing: 'needs-owner',
          severity: 'error',
          title: 'Foreign process holds port 7665 (pid 123)',
          detail: 'Stop it, then restart the service.',
        }),
      ]),
    );
    const band = document.getElementById('board-owner')!;
    const guidance = band.querySelector('.board-notification__guidance');
    expect(guidance).not.toBeNull();
    expect(guidance?.textContent ?? '').toContain('Stop the foreign process yourself');
    expect(band.querySelector('.board-notification__ack')).toBeNull();
    expect(band.querySelector('.board-owner__ack')).toBeNull();
  });
});
