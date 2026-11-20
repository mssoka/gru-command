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

  it('Gru\'s pick is marked on the recommended tile only, and an unmarked decision marks none', () => {
    const view = new BoardView(() => {});
    view.render(
      snapshot([
        notification({ id: 'marked', decision: decision({ recommendedOption: 'leave' }) }),
        notification({ id: 'unmarked' }),
        notification({ id: 'dangling', decision: decision({ recommendedOption: 'first' }) }),
      ]),
    );
    const tiles = (id: string): HTMLElement[] => [...cardOf(id).querySelectorAll<HTMLElement>('.board-notification__option')];
    // The mark follows the producer's option id — here the SECOND choice.
    expect(tiles('marked').map((tile) => tile.classList.contains('board-notification__option--pick'))).toEqual([false, true]);
    expect(tiles('marked').map((tile) => tile.querySelector('.board-notification__pick')?.textContent ?? null)).toEqual([
      null,
      '★ Gru’s pick',
    ]);
    // The tag sits above the button; the button's own name is unchanged and
    // every choice stays a live control.
    const picked = tiles('marked')[1]!;
    expect([...picked.children].map((child) => child.className.split(' ')[0])).toEqual([
      'board-notification__pick',
      'board-notification__option-button',
      'board-notification__option-consequence',
    ]);
    expect(picked.querySelector('button')?.textContent).toBe('Leave staging paused for now');
    expect(cardOf('marked').querySelectorAll('button.board-notification__option-button')).toHaveLength(2);
    // No mark from the producer, or a mark naming no option: nothing is marked.
    for (const id of ['unmarked', 'dangling']) {
      expect(cardOf(id).querySelector('.board-notification__option--pick'), id).toBeNull();
      expect(cardOf(id).querySelector('.board-notification__pick'), id).toBeNull();
    }
  });

  it('the recap of an answered card keeps Gru\'s pick; the compact card never shows one', () => {
    const view = new BoardView(() => {});
    const marked = decision({ recommendedOption: 'finish' });
    view.render(
      snapshot([
        notification({ id: 'answered', decision: marked, decidedAt: '2026-11-20T17:09:00.000Z', decidedOption: 'leave' }),
        notification({ id: 'machine', routing: 'action-required', decision: marked }),
      ]),
    );
    const recapTiles = [...cardOf('answered').querySelectorAll<HTMLElement>('.board-notification__recap .board-notification__option')];
    expect(recapTiles.map((tile) => tile.querySelector('.board-notification__pick')?.textContent ?? null)).toEqual(['★ Gru’s pick', null]);
    (document.getElementById('notification-bell') as HTMLButtonElement).click();
    const machine = cardOf('machine', document.getElementById('notification-list')!);
    expect(machine.querySelectorAll('.board-notification__option')).toHaveLength(2);
    expect(machine.querySelector('.board-notification__pick')).toBeNull();
    expect(machine.querySelector('.board-notification__option--pick')).toBeNull();
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
    // "Ready" is as of the last observation, and the strip says when.
    expect(strip.querySelector('.board-owner__checked')?.textContent).toMatch(/^checked \S+ ago$/u);
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

  it('an answered card leaves the count and the headline and is named as Gru\'s work', () => {
    const view = new BoardView(() => {});
    const answered = notification({ id: 'answered', decidedAt: '2026-11-20T17:09:00.000Z', decidedOption: 'finish' });
    const second = notification({ id: 'answered-2', decidedAt: '2026-11-20T17:10:00.000Z', decidedOption: 'leave' });
    const count = (): string | null | undefined => band().querySelector('.board-band__count')?.textContent;
    const headline = (): string | null | undefined => band().querySelector('.board-owner__headline')?.textContent;
    const answeredLine = (): string | null | undefined => band().querySelector('.board-owner__answered')?.textContent;

    // One open question, one answer in hand, one ready PR: two things need
    // the owner; the answer is Gru's.
    view.render(snapshot([notification({ id: 'open' }), answered], [readyPr()]));
    expect(count()).toBe('2 pending');
    expect(headline()).toBe('2 things need you');
    expect(answeredLine()).toBe('Gru is carrying out 1 answer');
    // The answered card is still on the band — the record stays visible.
    expect(band().querySelector('[data-notification-id="answered"]')).not.toBeNull();

    // Only answers in hand: nothing needs the owner, and the band is not
    // the empty state (the rows are still there).
    view.render(snapshot([answered, second]));
    expect(count()).toBe('0 pending');
    expect(headline()).toBe('Nothing needs you');
    expect(answeredLine()).toBe('Gru is carrying out 2 answers');
    expect(band().dataset.empty).toBe('false');
    expect(band().querySelectorAll('.board-notification--decided')).toHaveLength(2);

    // No answers in hand: no such line at all.
    view.render(snapshot([notification({ id: 'open' })]));
    expect(count()).toBe('1 pending');
    expect(headline()).toBe('1 thing needs you');
    expect(band().querySelector('.board-owner__answered')).toBeNull();
  });

  it('a decision that arrives already answered never taps the shoulder; an open one does', () => {
    const view = new BoardView(() => {});
    const toasted: string[] = [];
    view.setToastHandler((item) => toasted.push(item.id));
    // History present at the first render never toasts.
    view.render(snapshot([]));
    // Two new arrivals: one the owner answered on another device while this
    // browser was away, one still open.
    view.render(
      snapshot([
        notification({ id: 'answered-elsewhere', decidedAt: '2026-11-20T17:09:00.000Z', decidedOption: 'finish' }),
        notification({ id: 'still-open' }),
      ]),
    );
    expect(toasted).toEqual(['still-open']);
  });

  it('with only answers in hand the band never says "nothing needs Gru either"', () => {
    const view = new BoardView(() => {});
    const answered = notification({ id: 'answered', decidedAt: '2026-11-20T17:09:00.000Z', decidedOption: 'finish' });
    // Gru's own queue is empty, but Gru is carrying out an answer: the quiet
    // line would contradict the one before it.
    view.render(snapshot([answered]));
    const summary = band().querySelector('.board-owner__summary')!;
    expect([...summary.children].map((node) => node.textContent)).toEqual(['Nothing needs you', 'Gru is carrying out 1 answer']);
    // A busy machine queue is still named, after Gru's share.
    view.render({ ...snapshot([answered]), unackedActionRequired: 2 });
    expect([...band().querySelector('.board-owner__summary')!.children].map((node) => node.className.split(' ').at(-1))).toEqual([
      'board-owner__headline',
      'board-owner__answered',
      'board-owner__gru',
    ]);
    // With something still owed and no answers, the quiet line stays.
    view.render(snapshot([notification({ id: 'open' })]));
    expect(band().querySelector('.board-owner__gru')?.textContent).toContain('nothing needs Gru either');
  });

  it('an open question shows ahead of newer answered cards, and the expander names what it hides', () => {
    const view = new BoardView(() => {});
    const answered = [1, 2, 3, 4, 5, 6].map((n) =>
      notification({ id: `answered-${n}`, ts: `2026-11-20T18:0${n}:00.000Z`, decidedAt: '2026-11-20T18:30:00.000Z', decidedOption: 'finish' }),
    );
    view.render(snapshot([...answered, notification({ id: 'open', ts: '2026-11-20T09:00:00.000Z' })]));
    const cards = [...band().querySelectorAll<HTMLElement>('[data-notification-id]')].map((card) => card.dataset.notificationId);
    expect(cards[0]).toBe('open');
    expect(band().querySelector('.board-band__count')?.textContent).toBe('1 pending');
    expect(band().querySelector('.board-band__more')?.textContent).toBe('+1 answered');
  });

  it('an answered decision never rings the bell badge as unread', () => {
    // The badge counts owner rows the bell has not shown, so the panel
    // stays closed here (an open panel marks its rows seen).
    const closePanel = (): void => {
      document.getElementById('notification-panel')!.hidden = true;
    };
    const badge = (): string | null => document.getElementById('notification-badge')!.textContent;
    closePanel();
    const view = new BoardView(() => {});
    view.render(snapshot([notification({ id: 'open' })]));
    expect(badge()).toBe('1');
    // A browser that never showed the row gets it already answered (the
    // owner answered elsewhere): nothing to ring for.
    mountBoardDom();
    closePanel();
    const fresh = new BoardView(() => {});
    fresh.render(snapshot([notification({ id: 'answered', decidedAt: '2026-11-20T17:09:00.000Z', decidedOption: 'finish' })]));
    expect(badge()).toBe('0');
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

describe('owner look — rows that are not open asks, and focus', () => {
  beforeEach(mountBoardDom);

  it('an acked owner row is a feed row: it keeps the compact card, with no strip and no live control', () => {
    // The band drops an acked row (it is no longer owed), and the bell lists
    // it under FEED. It must not come back there dressed as an open question.
    const view = new BoardView(() => {});
    view.render(
      snapshot([
        notification({ id: 'acked-ask', ackedAt: '2026-11-20T17:20:00.000Z' }),
        notification({ id: 'acked-notice', kind: 'port-squat', decision: null, ackedAt: '2026-11-20T17:21:00.000Z' }),
      ]),
    );
    expect(band().querySelector('[data-notification-id]')).toBeNull();
    expect(band().dataset.attention).toBe('clear');
    (document.getElementById('notification-bell') as HTMLButtonElement).click();
    const panel = document.getElementById('notification-list')!;
    for (const id of ['acked-ask', 'acked-notice']) {
      const card = cardOf(id, panel);
      expect(card.classList.contains('board-notification--owner'), id).toBe(false);
      expect(card.querySelector('.board-notification__body'), id).toBeNull();
      expect(card.querySelector(':scope > .board-notification__meta'), id).not.toBeNull();
      expect(card.querySelector('.board-notification__state')?.textContent, id).toBe('seen');
      expect(card.querySelector('.board-notification__option-button'), id).toBeNull();
    }
  });

  it('focus on the recap lands on the card when the follow-through resolves the row', () => {
    const view = new BoardView(() => {});
    const answered = notification({ decidedAt: '2026-11-20T17:09:00.000Z', decidedOption: 'finish' });
    view.render(snapshot([answered]));
    (document.getElementById('notification-bell') as HTMLButtonElement).click();
    const panel = document.getElementById('notification-list')!;
    const summary = cardOf('ask-1', panel).querySelector<HTMLElement>('.board-notification__recap > summary')!;
    expect(summary.dataset.focusKey).toBe('notif:ask-1:recap');
    summary.tabIndex = 0;
    summary.focus();
    expect(document.activeElement).toBe(summary);
    // Resolved: the row becomes a compact feed card with no recap. Focus
    // stays on that card, never on <body>.
    view.render(snapshot([{ ...answered, resolvedAt: '2026-11-20T17:30:00.000Z', resolvedBy: 'gru' }]));
    const card = cardOf('ask-1', panel);
    expect(card.querySelector('.board-notification__recap')).toBeNull();
    expect(document.activeElement).toBe(card);
  });

  it('a notice whose kind has no guidance wears the strip with Details straight under it', () => {
    const view = new BoardView(() => {});
    view.render(snapshot([notification({ id: 'bare', kind: 'test.unregistered-owner-kind', decision: null })]));
    const card = cardOf('bare');
    expect(card.classList.contains('board-notification--owner')).toBe(true);
    expect([...card.children].map((child) => child.className.split(' ')[0])).toEqual([
      'board-notification__head',
      'board-notification__details',
    ]);
  });
});
