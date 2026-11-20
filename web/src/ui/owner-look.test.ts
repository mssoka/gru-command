// @vitest-environment happy-dom

/**
 * Owner look (owner picks 2026-11-20): an OPEN owner row wears a headline
 * strip over a calm body — the story beside the owner's call — and the
 * ready PR/MR row wears a green strip. Machine rows, feed rows and closed
 * receipts keep the compact card.
 *
 * At the base every open owner card was the flat compact card (an error
 * one flooded pink), so each assertion on the strip, the split body, the
 * kind badge, the recap and the pill state is the fail-before oracle here.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { BoardSnapshot, NotificationDecisionView, NotificationView, OwnerPrView } from '../lib/board-protocol.js';
import { BoardView } from './board.js';

const T0 = '2026-11-20T17:04:00.000Z';

function mountBoardDom(): void {
  document.body.innerHTML = `
    <div id="command-health" hidden>
      <span id="command-health-summary"></span>
      <span id="command-health-parts"></span>
      <span id="board-decisions"></span>
      <span id="board-wakes" hidden></span>
    </div>
    <div id="board-kpis" hidden></div>
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

function decision(overrides: Partial<NotificationDecisionView> = {}): NotificationDecisionView {
  return {
    question: 'Can you unpause the staging database so I can finish the update?',
    context: 'The app update stopped before going live because the staging database is paused.',
    recommendation: 'Unpause the staging project, then choose the first option.',
    ifNothing: 'If you do nothing, the staging app stays on the old version.',
    reservedClass: 'authority-cost',
    whyNotDelegable: 'Unpausing needs an admin login I do not have.',
    options: [
      { id: 'finish', label: 'I’ve unpaused it — finish the update', consequence: 'I re-run the update and confirm it is live.' },
      { id: 'leave', label: 'Leave staging paused for now', consequence: 'Nothing else happens.' },
    ],
    discussion: false,
    ...overrides,
  };
}

function notification(overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    id: 'ask-1',
    ts: T0,
    kind: 'gru.owner-escalation',
    routing: 'needs-owner',
    severity: 'error',
    title: 'The staging database is paused, so the staging update could not finish',
    detail: 'deploy job-1234 stopped at the migration step',
    agentId: null,
    shownAt: null,
    ackedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    decision: decision(),
    ...overrides,
  };
}

function readyPr(overrides: Partial<OwnerPrView> = {}): OwnerPrView {
  return {
    id: 'owner-pr:job-9',
    jobId: 'job-9',
    jobTitle: 'Root and specialist context compaction',
    repo: 'demo',
    prUrl: 'https://github.com/example/demo/pull/7',
    sha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
    checkedAt: T0,
    ...overrides,
  };
}

function snapshot(notifications: readonly NotificationView[], ownerPrs: readonly OwnerPrView[] = []): BoardSnapshot {
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
      incarnation: 'owner-look-test',
      generation: 0,
    },
    unackedActionRequired: 0,
    unackedNeedsOwner: notifications.filter((item) => item.routing === 'needs-owner').length,
    wakes: { count: 0, lastAt: null },
    ownerPrs,
  };
}

function band(): HTMLElement {
  return document.getElementById('board-owner')!;
}

function cardOf(id: string, root: ParentNode = band()): HTMLElement {
  const card = root.querySelector<HTMLElement>(`[data-notification-id="${id}"]`);
  if (card === null) throw new Error(`no card for ${id}`);
  return card;
}

describe('owner look — the headline strip and the split body', () => {
  beforeEach(mountBoardDom);

  it('an open owner decision carries its kind badge and time on the strip, the story beside the call', () => {
    const view = new BoardView(() => {});
    view.render(snapshot([notification()]));
    const card = cardOf('ask-1');
    expect(card.classList.contains('board-notification--owner')).toBe(true);
    // An ordinary ask has no red edge.
    expect(card.classList.contains('board-notification--destructive')).toBe(false);
    const head = card.querySelector<HTMLElement>(':scope > .board-notification__head')!;
    expect(head.querySelector('.board-notification__title')?.textContent).toBe(
      'The staging database is paused, so the staging update could not finish',
    );
    expect(head.querySelector('.board-notification__kind')?.textContent).toBe('🔑 Access or cost');
    // The short metadata label rides the strip; it is no longer its own row.
    expect(head.querySelector('.board-notification__meta')?.textContent).toMatch(/· FOR YOU$/u);
    expect(card.querySelector(':scope > .board-notification__meta')).toBeNull();

    const body = card.querySelector<HTMLElement>(':scope > .board-notification__body')!;
    const story = body.querySelector<HTMLElement>(':scope > .board-notification__story')!;
    const call = body.querySelector<HTMLElement>(':scope > .board-notification__decision')!;
    // The story: what happened, why it reached the owner, what waiting costs.
    expect(story.querySelector('.board-notification__kicker')?.textContent).toBe('What happened');
    expect(story.querySelector('.board-notification__context')?.textContent).toBe(
      'The app update stopped before going live because the staging database is paused.',
    );
    expect(story.querySelector('.board-notification__why')?.textContent).toBe(
      'Why this needs you: Unpausing needs an admin login I do not have.',
    );
    expect(story.querySelector('.board-notification__if-nothing')?.textContent).toBe(
      'If you do nothing, the staging app stays on the old version.',
    );
    // The call: the question, Gru's advice in its bubble, one tile per choice.
    expect(call.querySelector('.board-notification__kicker')?.textContent).toBe('Your call');
    expect(call.querySelector('.board-notification__question')?.textContent).toBe(
      'Can you unpause the staging database so I can finish the update?',
    );
    expect(call.querySelector('.board-notification__gru-bubble')?.textContent).toBe(
      'Gru recommends: Unpause the staging project, then choose the first option.',
    );
    expect(call.querySelector('.board-notification__why')).toBeNull();
    expect(call.querySelector('.board-notification__if-nothing')).toBeNull();
    const tiles = [...call.querySelectorAll<HTMLElement>('.board-notification__option')];
    expect(tiles.map((tile) => tile.querySelector('button')?.textContent)).toEqual([
      'I’ve unpaused it — finish the update',
      'Leave staging paused for now',
    ]);
    expect(tiles.map((tile) => tile.querySelector('.board-notification__option-consequence')?.textContent)).toEqual([
      'I re-run the update and confirm it is live.',
      'Nothing else happens.',
    ]);
    // The evidence still sits behind Details, after the body.
    expect(card.querySelector(':scope > .board-notification__details')).not.toBeNull();
  });

  it('a producer with no preference speaks in the bubble without the "Gru recommends" label', () => {
    const view = new BoardView(() => {});
    const plain = 'No recommendation: both are safe, and it is your call.';
    view.render(snapshot([notification({ decision: decision({ recommendation: plain }) })]));
    const bubble = cardOf('ask-1').querySelector('.board-notification__gru-bubble')!;
    expect(bubble.textContent).toBe(plain);
    expect(bubble.querySelector('.board-notification__gru-label')).toBeNull();
  });

  it('a destructive ask carries the red edge and its badge; an unknown reserved class gets no badge', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot([
        notification({ id: 'undo', decision: decision({ reservedClass: 'destructive' }) }),
        notification({ id: 'new-class', decision: decision({ reservedClass: 'something-new' }) }),
      ]),
    );
    const undo = cardOf('undo');
    expect(undo.classList.contains('board-notification--destructive')).toBe(true);
    expect(undo.querySelector('.board-notification__kind')?.textContent).toBe('⚠️ Can’t be undone');
    const unknown = cardOf('new-class');
    expect(unknown.classList.contains('board-notification--owner')).toBe(true);
    expect(unknown.classList.contains('board-notification--destructive')).toBe(false);
    expect(unknown.querySelector('.board-notification__kind')).toBeNull();
  });

  it('an answered card leads with the recorded choice and folds the ask under a recap that stays open across a push', () => {
    const view = new BoardView(() => {});
    const answered = notification({ decidedAt: '2026-11-20T17:09:00.000Z', decidedOption: 'finish' });
    view.render(snapshot([answered]));
    let card = cardOf('ask-1');
    expect(card.classList.contains('board-notification--owner')).toBe(true);
    expect(card.classList.contains('board-notification--decided')).toBe(true);
    expect(card.querySelector('.board-notification__state')?.textContent).toBe('decision recorded');
    const order = [...card.children].map((child) => child.className.split(' ')[0]);
    expect(order).toEqual([
      'board-notification__head',
      'board-notification__decided',
      'board-notification__recap',
      'board-notification__details',
    ]);
    expect(card.querySelector(':scope > .board-notification__decided')?.textContent).toBe(
      'Decision recorded: “I’ve unpaused it — finish the update” — awaiting follow-through.',
    );
    let recap = card.querySelector<HTMLDetailsElement>(':scope > .board-notification__recap')!;
    expect(recap.open).toBe(false);
    expect(recap.querySelector('summary')?.textContent).toBe('What you were asked');
    // The whole ask is still on the record, read-only: no live control.
    expect(recap.querySelector('.board-notification__question')?.textContent).toBe(
      'Can you unpause the staging database so I can finish the update?',
    );
    expect(recap.querySelectorAll('.board-notification__option-label')).toHaveLength(2);
    expect(recap.querySelector('.board-notification__option-button')).toBeNull();
    // Opened by the owner, the recap survives the next snapshot push.
    recap.open = true;
    view.render(snapshot([answered]));
    card = cardOf('ask-1');
    recap = card.querySelector<HTMLDetailsElement>(':scope > .board-notification__recap')!;
    expect(recap.open).toBe(true);
    recap.open = false;
    view.render(snapshot([answered]));
    expect(cardOf('ask-1').querySelector<HTMLDetailsElement>(':scope > .board-notification__recap')!.open).toBe(false);
  });

  it('an owner notice wears the strip with its guidance in the body and no kind badge', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot([
        notification({ id: 'notice', kind: 'port-squat', title: 'Another program is using the port', detail: 'pid 123', decision: null }),
      ]),
    );
    const card = cardOf('notice');
    expect(card.classList.contains('board-notification--owner')).toBe(true);
    expect(card.querySelector('.board-notification__kind')).toBeNull();
    expect(card.querySelector(':scope > .board-notification__head .board-notification__meta')).not.toBeNull();
    expect(card.querySelector(':scope > .board-notification__body > .board-notification__guidance')).not.toBeNull();
  });

  it('machine rows and resolved owner rows keep the compact card', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot([
        notification({ id: 'machine', routing: 'action-required' }),
        notification({ id: 'resolved', resolvedAt: '2026-11-20T17:30:00.000Z', resolvedBy: 'gru' }),
      ]),
    );
    (document.getElementById('notification-bell') as HTMLButtonElement).click();
    const panel = document.getElementById('notification-list')!;
    for (const id of ['machine', 'resolved']) {
      const card = cardOf(id, panel);
      expect(card.classList.contains('board-notification--owner'), id).toBe(false);
      expect(card.querySelector('.board-notification__body'), id).toBeNull();
      expect(card.querySelector('.board-notification__kind'), id).toBeNull();
      // The compact card keeps its own metadata row and the stacked block.
      expect(card.querySelector(':scope > .board-notification__meta'), id).not.toBeNull();
      expect(card.querySelector('.board-notification__decision .board-notification__why'), id).not.toBeNull();
      expect(card.querySelector('.board-notification__decision .board-notification__if-nothing'), id).not.toBeNull();
      expect(card.querySelector('.board-notification__recommendation')?.textContent, id).toBe(
        'Gru recommends: Unpause the staging project, then choose the first option.',
      );
    }
  });

  it('the bell shows the same owner face as the band', () => {
    const view = new BoardView(() => {});
    view.render(snapshot([notification()]));
    (document.getElementById('notification-bell') as HTMLButtonElement).click();
    const card = cardOf('ask-1', document.getElementById('notification-list')!);
    expect(card.classList.contains('board-notification--owner')).toBe(true);
    expect(card.querySelector(':scope > .board-notification__body > .board-notification__story')).not.toBeNull();
    expect(card.querySelectorAll('.board-notification__option-button')).toHaveLength(2);
  });
});

describe('owner look — the ready row and the FOR YOU pill', () => {
  beforeEach(mountBoardDom);

  it('a ready PR wears the green strip with the three plain facts above its evidence line', () => {
    const view = new BoardView(() => {});
    view.render(snapshot([], [readyPr()]));
    const row = band().querySelector<HTMLElement>('.board-owner__row--pr')!;
    const strip = row.querySelector<HTMLElement>(':scope > .board-owner__strip')!;
    expect(strip.querySelector('.board-owner__title')?.textContent).toBe('🔀 Root and specialist context compaction');
    expect(strip.querySelector('.board-owner__ready')?.textContent).toBe('ready for you');
    const facts = row.querySelector<HTMLElement>(':scope > .board-owner__facts')!;
    expect([...facts.querySelectorAll('.board-owner__tick')].map((tick) => tick.textContent)).toEqual([
      'Reviewed and approved',
      'Checks are green',
      'Can be merged',
    ]);
    // The exact evidence the three facts stand on is still shown.
    expect(facts.querySelector('.board-owner__meta')?.textContent).toMatch(
      /^📦 demo · review approved @ aaaa1111 · CI green at that head · mergeable · observed \S+ ago$/u,
    );
    expect(row.querySelector<HTMLAnchorElement>(':scope > .board-owner__open')?.textContent).toBe('OPEN PR ↗');
  });

  it('the pill says what is waiting: a question, good news only, an answer in hand, or nothing', () => {
    const view = new BoardView(() => {});
    const answered = notification({ decidedAt: '2026-11-20T17:09:00.000Z', decidedOption: 'finish' });
    view.render(snapshot([]));
    expect(band().dataset.attention).toBe('clear');
    view.render(snapshot([notification()], [readyPr()]));
    expect(band().dataset.attention).toBe('question');
    view.render(snapshot([], [readyPr()]));
    expect(band().dataset.attention).toBe('ready');
    view.render(snapshot([answered]));
    expect(band().dataset.attention).toBe('answered');
  });
});
