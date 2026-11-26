import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import {
  isValidLessonProposal,
  isValidSnapshot,
  LESSONS_PROPOSAL_KIND,
  type BoardSnapshot,
  type LessonProposalView,
  type NotificationView,
} from '../src/lib/board-protocol.js';

/**
 * Book of Lessons proposal on a phone (owner decision 2026-10-07; review
 * redesign 2026-11-26): the For You card stays one column inside the
 * viewport, its review sheet fills the phone and scrolls only vertically,
 * and Accept all / Reject all are reachable in the sheet's foot and on the
 * card. Measured in a real browser
 * layout, not read from CSS text. Synthetic fixtures on the board's two
 * channels (`/board/ws` push and `GET /api/board`) plus the review fetch;
 * pairing runs against the real dev mock. No decision is ever clicked.
 */

const MOCK_TOKEN = process.env.GRU_MOCK_TOKEN ?? 'dev-token';
const T0 = '2026-10-07T00:00:00.000Z';
const NOTICE_ID = 'lessons-proposal:prop-phone';
const LONG = 'an-unbreakable-journal-handle-'.repeat(4);

const NOTICE: NotificationView = {
  id: NOTICE_ID,
  ts: T0,
  kind: LESSONS_PROPOSAL_KIND,
  routing: 'needs-owner',
  severity: 'info',
  title: 'Book of Lessons: 3 lesson changes proposed',
  detail: 'distilled from 4 journal entries',
  agentId: null,
  shownAt: null,
  ackedAt: null,
  resolvedAt: null,
  resolvedBy: null,
};

const REVIEW: LessonProposalView = {
  id: 'prop-phone',
  createdAt: T0,
  notificationId: NOTICE_ID,
  entries: 4,
  throughSeq: 42,
  chapters: [
    {
      slug: 'ops-restarts',
      title: { before: 'Ops restarts', after: 'Operations: restarts and rolling deploys across every hosted service' },
      retired: false,
      summary: { before: 'Restart discipline.', after: `Restart and roll discipline — ${LONG}` },
      tags: { before: ['ops'], after: ['ops', 'rolling-deploys', 'restarts'] },
      added: [
        {
          slug: 'close-the-shell-before-restarting',
          body: `Close the live shell before a restart; a held session keeps the old process alive. ${LONG}`,
          recurred: 1,
          tags: ['restarts'],
          previousBody: null,
          previousRecurred: null,
          previousTags: null,
        },
      ],
      changed: [
        {
          slug: 'drain-before-a-roll',
          body: 'Drain the queue before a roll, then confirm the drain finished.',
          recurred: 3,
          tags: ['rolling-deploys'],
          previousBody: 'Drain before a roll.',
          previousRecurred: 2,
          previousTags: [],
        },
      ],
      removed: [{ slug: 'old-restart-note', body: 'Restart twice if unsure.', recurred: 1, tags: [], reason: 'cap' }],
      provenanceTrimmed: 2,
      bodiesTrimmed: 0,
    },
  ],
  index: [
    {
      slug: 'ops-restarts',
      before: { summary: 'Restart discipline.', tags: ['ops'] },
      after: { summary: `Restart and roll discipline — ${LONG}`, tags: ['ops', 'rolling-deploys', 'restarts'] },
    },
  ],
  decision: null,
  recovery: null,
};

function snapshot(): BoardSnapshot {
  return {
    repos: [],
    agents: [],
    notifications: [NOTICE],
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: 'disabled',
      model: '~typesafe/jev-latest',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'lesson-proposal-proof',
      generation: 0,
    },
    unackedActionRequired: 0,
    unackedNeedsOwner: 1,
    wakes: { count: 0, lastAt: null },
    pipeline: { entries: [], pending: 0 },
  };
}

async function seed(page: Page): Promise<{ readonly pageErrors: Error[]; readonly decisions: string[] }> {
  const board = snapshot();
  if (!isValidSnapshot(board)) throw new Error('fixture snapshot fails the production validator');
  if (!isValidLessonProposal(REVIEW)) throw new Error('fixture review fails the production validator');
  const pageErrors: Error[] = [];
  const decisions: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await page.route('**/api/board', (route) => route.fulfill({ json: board }));
  await page.route('**/api/notifications/*/shown', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/api/lessons/proposal', (route) => route.fulfill({ json: REVIEW }));
  await page.route('**/api/lessons/proposal/*/*', (route) => {
    decisions.push(route.request().url());
    return route.abort();
  });
  await page.routeWebSocket(/\/board\/ws$/, (ws: WebSocketRoute) => {
    let seeded = false;
    ws.onMessage(() => {
      if (seeded) return;
      seeded = true;
      ws.send(JSON.stringify({ type: 'auth_ok' }));
      ws.send(JSON.stringify({ type: 'board', snapshot: board }));
    });
  });
  return { pageErrors, decisions };
}

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly width: number;
}

for (const width of [360, 375, 390]) {
  test(`the proposal card stays one column and its review sheet fills the phone with Accept all / Reject all reachable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    const { pageErrors, decisions } = await seed(page);
    await page.goto('/');
    await expect(page.locator('#pairing-view')).toBeVisible();
    await page.locator('#pair-token').fill(MOCK_TOKEN);
    await page.locator('#pair-submit').click();
    await expect(page.locator('#board-view')).toBeVisible();

    const row = page.locator('#board-owner .board-owner__row--proposal');
    await expect(row).toBeVisible();
    // The card reads its review on its own and shows the counts.
    await expect(row.locator('.board-lessons__tally')).toContainText('+ 1 new');

    const card = await row.evaluate((node) => {
      const box = (element: Element | null): Box | null => {
        if (element === null) return null;
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width };
      };
      const body = node.querySelector('.board-lessons__body')!;
      const parts = ['.board-lessons__strip', '.board-lessons__story', '.board-lessons__call'].map((selector) => box(node.querySelector(selector)));
      return {
        row: box(node)!,
        parts,
        columns: getComputedStyle(body).gridTemplateColumns.trim().split(/\s+/u).length,
        rowOverflow: node.scrollWidth - node.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        viewport: window.innerWidth,
      };
    });
    expect(card.columns).toBe(1);
    expect(card.parts.every((part) => part !== null)).toBe(true);
    const parts = card.parts as Box[];
    // Stacked in one column: each part starts below the previous one and
    // sits inside the row, which sits inside the viewport.
    for (let index = 1; index < parts.length; index += 1) expect(parts[index]!.top).toBeGreaterThanOrEqual(parts[index - 1]!.bottom - 1);
    for (const part of parts) {
      expect(part.left).toBeGreaterThanOrEqual(card.row.left - 1);
      expect(part.right).toBeLessThanOrEqual(card.row.right + 1);
    }
    expect(parts[0]!.width).toBeGreaterThan(0);
    expect(card.row.left).toBeGreaterThanOrEqual(0);
    expect(card.row.right).toBeLessThanOrEqual(card.viewport);
    expect(card.rowOverflow).toBeLessThanOrEqual(0);
    expect(card.pageOverflow).toBeLessThanOrEqual(0);

    // The review opens over the board, the whole phone wide and high; its
    // long text scrolls inside it, never sideways.
    await row.locator('.board-lessons__see').click();
    const sheet = page.locator('dialog.board-lessons-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.board-lessons__text').first()).toContainText('Close the live shell');
    const fit = await sheet.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const body = node.querySelector('.board-lessons-sheet__body')!;
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        bodyOverflowX: body.scrollWidth - body.clientWidth,
        bodyScrolls: body.scrollHeight > body.clientHeight,
      };
    });
    expect(fit.left).toBeGreaterThanOrEqual(-1);
    expect(fit.top).toBeGreaterThanOrEqual(-1);
    expect(fit.right).toBeLessThanOrEqual(fit.viewport.width + 1);
    expect(fit.bottom).toBeLessThanOrEqual(fit.viewport.height + 1);
    expect(fit.right - fit.left).toBeGreaterThanOrEqual(fit.viewport.width - 2);
    expect(fit.bodyOverflowX).toBeLessThanOrEqual(0);

    // Accept all and Reject all: on screen at the sheet's foot without
    // scrolling, and the topmost element at their centres.
    const hitTest = async (button: import('@playwright/test').Locator): Promise<void> => {
      await expect(button).toBeEnabled();
      const hit = await button.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const inViewport = rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight;
        const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return { inViewport, hit: top === node || node.contains(top) };
      });
      expect(hit).toEqual({ inViewport: true, hit: true });
    };
    for (const selector of ['.board-owner__accept', '.board-owner__reject']) await hitTest(sheet.locator(`.board-lessons-sheet__actions ${selector}`));

    // Close returns to the card, whose own buttons are reachable too.
    await sheet.locator('.board-lessons-sheet__close').click();
    await expect(sheet).toBeHidden();
    await expect(row.locator('.board-lessons__see')).toBeFocused();
    for (const selector of ['.board-owner__accept', '.board-owner__reject']) {
      const button = row.locator(selector);
      await button.scrollIntoViewIfNeeded();
      await hitTest(button);
    }
    expect(decisions).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}
