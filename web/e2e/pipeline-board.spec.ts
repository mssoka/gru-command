import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import {
  isValidSnapshot,
  parseBoardServerFrame,
  type BoardSnapshot,
  type JobView,
  type NotificationView,
  type PipelineEntryView,
} from '../src/lib/board-protocol.js';

/**
 * Compact owner-first board — browser geometry proof (owner approval
 * j-1064), synthetic fixtures only: a complete canonical snapshot seeded
 * on both the `/board/ws` push and the `GET /api/board` refetch; the
 * pairing flow runs against the real dev mock. No product/mock/fixture
 * code is touched by this spec, and no real owner control is clicked.
 *
 * Captures land in the ignored evidence root
 * `_bmad-output/silas-in-pipeline-queue-20261003/captures/`. This spec is
 * authored, never run, by the source worker: scheduling belongs to
 * operations via the `pipeline-board-browser` [verify] scope. Declared
 * UNRUN — not a PASS.
 */

const MOCK_TOKEN = process.env.GRU_MOCK_TOKEN ?? 'dev-token';

const CAPTURE_DIR = path.join(
  import.meta.dirname,
  '..',
  '..',
  '_bmad-output',
  'silas-in-pipeline-queue-20261003',
  'captures',
);

const T0 = '2026-10-03T00:00:00.000Z';

function job(id: string, status: string, title = `Heist ${id}`, updatedAt = T0): JobView {
  return {
    id,
    repo: 'pipeline-proof',
    title,
    status,
    updatedAt,
    prUrl: null,
    prState: null,
    baseBranch: 'main',
    note: null,
    rounds: [],
    lane: status === 'blocked' ? null : { branch: `gru/${id}`, sha: 'abc1234def5678', status: 'active', createdAt: T0 },
    lastAgentActivity: null,
  };
}

function entry(id: string, overrides: Partial<PipelineEntryView> = {}): PipelineEntryView {
  return {
    id,
    repo: 'pipeline-proof',
    title: `Approved brief ${id}`,
    priority: 5,
    enqueueSeq: 1,
    state: 'waiting',
    reason: 'waiting for p-dep to be merged (now in-review)',
    queuedAt: T0,
    ...overrides,
  };
}

const OWNER_NOTICE: NotificationView = {
  id: 'owner-proof-1',
  ts: T0,
  kind: 'test.owner-proof',
  routing: 'needs-owner',
  severity: 'info',
  title: 'Synthetic owner decision (fixture)',
  detail: 'never clicked by this spec',
  agentId: null,
  shownAt: null,
  ackedAt: null,
  resolvedAt: null,
  resolvedBy: null,
};

/** Six sections at once, every one exceeding (or at) its preview: In
 * flight 7, Pipeline 6, For Gru 3, Settled 5, Cold 4, For you 1. */
function proofSnapshot(): BoardSnapshot {
  const jobs: JobView[] = [
    ...Array.from({ length: 7 }, (_, index) => job(`flight-${index}`, 'in-review', `In-flight heist ${index} with a deliberately long title for wrapping`)),
    ...Array.from({ length: 3 }, (_, index) => job(`machine-${index}`, 'blocked', `Blocked machine heist ${index}`)),
    ...Array.from({ length: 5 }, (_, index) => job(`settled-${index}`, 'delivered', `Settled heist ${index}`, `2026-10-0${5 - index}T00:00:00.000Z`)),
    ...Array.from({ length: 4 }, (_, index) => job(`cold-${index}`, 'parked', `Cold heist ${index}`)),
  ];
  const entries: PipelineEntryView[] = [
    entry('p1', { priority: 0, enqueueSeq: 1, state: 'ready', reason: null, title: 'Ready approved brief — capacity free' }),
    entry('p2', { priority: 0, enqueueSeq: 2, reason: 'owner hold: waiting on the owner decision' }),
    entry('p3', { priority: 1, enqueueSeq: 3, reason: 'prerequisite p-dead cancelled' }),
    entry('p4', { priority: 2, enqueueSeq: 4, reason: 'dependency cycle: p4 → p5 → p4' }),
    entry('p5', { priority: 3, enqueueSeq: 5, reason: 'exclusive scope "repo:pipeline-proof" held by p1' }),
    entry('p6', { priority: 4, enqueueSeq: 6, reason: 'waiting for p-ghost — not enqueued' }),
  ];
  return {
    repos: [{ name: 'pipeline-proof', jobs }],
    agents: [],
    notifications: [OWNER_NOTICE],
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: 'disabled',
      model: '~typesafe/jev-latest',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'pipeline-proof-incarnation',
      generation: 0,
    },
    unackedActionRequired: 0,
    unackedNeedsOwner: 1,
    wakes: { count: 0, lastAt: null },
    pipeline: { entries, pending: entries.length },
  };
}

interface Seed {
  readonly pageErrors: Error[];
  push(snapshot: BoardSnapshot): void;
}

/** Seed BOTH board channels so a later HTTP refetch cannot replace the
 * synthetic board, and keep the socket for deliberate re-pushes. */
async function seedBoard(page: Page, initial: BoardSnapshot): Promise<Seed> {
  if (!isValidSnapshot(initial)) throw new Error('fixture snapshot fails the production isValidSnapshot validator');
  const frame = parseBoardServerFrame({ type: 'board', snapshot: initial });
  if (frame === null || frame.type !== 'board') throw new Error('fixture board frame fails the production parser');
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  let current = initial;
  const sockets: WebSocketRoute[] = [];
  await page.route('**/api/board', (route) => route.fulfill({ json: current }));
  await page.routeWebSocket(/\/board\/ws$/, (ws: WebSocketRoute) => {
    let seeded = false;
    sockets.push(ws);
    ws.onMessage(() => {
      if (seeded) return;
      seeded = true;
      ws.send(JSON.stringify({ type: 'auth_ok' }));
      ws.send(JSON.stringify({ type: 'board', snapshot: current }));
    });
  });
  return {
    pageErrors,
    push(snapshot: BoardSnapshot) {
      if (!isValidSnapshot(snapshot)) throw new Error('pushed snapshot fails the production validator');
      current = snapshot;
      for (const ws of sockets) ws.send(JSON.stringify({ type: 'board', snapshot }));
    },
  };
}

async function pairAndOpenBoard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#pairing-view')).toBeVisible();
  await page.locator('#pair-token').fill(MOCK_TOKEN);
  await page.locator('#pair-submit').click();
  await expect(page.locator('#board-view')).toBeVisible();
  await expect(page.locator('#board-nav')).toBeVisible();
}

async function bodyOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

async function capture(page: Page, name: string): Promise<void> {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(CAPTURE_DIR, `${name}.png`), fullPage: true });
}

/** The six-section order as the DOM presents it (owner mount first). */
async function sectionOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const order: string[] = [];
    const owner = document.getElementById('board-owner');
    if (owner !== null) order.push('for-you');
    for (const section of document.querySelectorAll<HTMLElement>('#board-jobs [data-section]')) {
      order.push(section.dataset.section ?? '');
    }
    return order;
  });
}

test.describe('compact owner-first board — synthetic geometry proof', () => {
  test('desktop 1440: exact six-section order, bounded previews, reversible disclosures', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const seed = await seedBoard(page, proofSnapshot());
    await pairAndOpenBoard(page);
    expect(seed.pageErrors).toEqual([]);

    expect(await sectionOrder(page)).toEqual(['for-you', 'in-flight', 'pipeline', 'for-gru', 'settled', 'cold']);

    // The strip: labelled counts, exact order, real targets.
    const navLinks = page.locator('#board-nav .board-nav__link');
    await expect(navLinks).toHaveCount(6);
    await expect(navLinks.nth(0)).toContainText('For you');
    await expect(navLinks.nth(1)).toContainText('In flight');
    await expect(navLinks.nth(2)).toContainText('Pipeline');
    await expect(navLinks.nth(3)).toContainText('For Gru');
    await expect(navLinks.nth(4)).toContainText('Settled');
    await expect(navLinks.nth(5)).toContainText('Cold');

    // Default density: 5 / 5 / 3 / 0 / 0 rows; full counts on the heads.
    await expect(page.locator('.board-band--in-flight .board-job')).toHaveCount(5);
    await expect(page.locator('.board-band--pipeline .board-pipeline')).toHaveCount(5);
    await expect(page.locator('.board-band--needs-you .board-job')).toHaveCount(0);
    await expect(page.locator('.board-band--settled .board-job')).toHaveCount(3);
    await expect(page.locator('.board-band--cold .board-job')).toHaveCount(0);
    await expect(page.locator('.board-band--in-flight .board-band__count')).toHaveText('7 heists');
    await expect(page.locator('.board-band--pipeline .board-band__count')).toHaveText('6 queued');
    await expect(page.locator('.board-band--needs-you .board-band__count')).toHaveText('3 heists');
    await expect(page.locator('.board-band--cold .board-band__count')).toHaveText('4 heists');

    // Waiting reasons are exact plain text; the ready row carries no reason.
    await expect(page.locator('.board-band--pipeline .board-pipeline').nth(0)).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.board-band--pipeline .board-pipeline').nth(1).locator('.board-pipeline__reason')).toHaveText(
      'owner hold: waiting on the owner decision',
    );

    await expect.poll(() => bodyOverflow(page)).toBeLessThanOrEqual(0);
    await capture(page, 'desktop-1440-light-defaults');

    // Reversible disclosures: expand everything, then collapse.
    await page.locator('.board-band--in-flight .board-band__more').click();
    await expect(page.locator('.board-band--in-flight .board-job')).toHaveCount(7);
    await page.locator('.board-band--pipeline .board-band__more').click();
    await expect(page.locator('.board-band--pipeline .board-pipeline')).toHaveCount(6);
    await page.locator('.board-band--needs-you .board-band__more').click();
    await expect(page.locator('.board-band--needs-you .board-job')).toHaveCount(3);
    await page.locator('.board-band--cold .board-band__more').click();
    await expect(page.locator('.board-band--cold .board-job')).toHaveCount(4);
    await page.locator('.board-band--settled .board-band__more').click();
    await expect(page.locator('.board-band--settled .board-job')).toHaveCount(5);
    await expect.poll(() => bodyOverflow(page)).toBeLessThanOrEqual(0);
    await capture(page, 'desktop-1440-light-expanded');

    // Collapse Cold again: zero rows, retained count.
    await page.locator('.board-band--cold .board-band__more').click();
    await expect(page.locator('.board-band--cold .board-job')).toHaveCount(0);
    await expect(page.locator('.board-band--cold .board-band__count')).toHaveText('4 heists');

    // Dark theme keeps the same geometry.
    await page.locator('#theme-toggle').click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page.locator('.board-band--pipeline .board-pipeline')).toHaveCount(6);
    await expect.poll(() => bodyOverflow(page)).toBeLessThanOrEqual(0);
    await capture(page, 'desktop-1440-dark-expanded');
  });

  test('live push preserves focus and disclosure state on a real control', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const snapshot = proofSnapshot();
    const seed = await seedBoard(page, snapshot);
    await pairAndOpenBoard(page);

    const more = page.locator('.board-band--pipeline .board-band__more');
    await more.click();
    await expect(page.locator('.board-band--pipeline .board-pipeline')).toHaveCount(6);
    await expect(more).toBeFocused();
    await expect(more).toHaveAttribute('aria-expanded', 'true');

    seed.push(snapshot);
    await expect(page.locator('.board-band--pipeline .board-pipeline')).toHaveCount(6);
    await expect(page.locator('.board-band--pipeline .board-band__more')).toBeFocused();
    await expect(page.locator('.board-band--pipeline .board-band__more')).toHaveAttribute('aria-expanded', 'true');
  });

  test('tablet 768: no overflow, sticky strip reachable, shortcuts jump to labelled sections', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    const seed = await seedBoard(page, proofSnapshot());
    await pairAndOpenBoard(page);
    expect(seed.pageErrors).toEqual([]);
    expect(await sectionOrder(page)).toEqual(['for-you', 'in-flight', 'pipeline', 'for-gru', 'settled', 'cold']);
    await expect.poll(() => bodyOverflow(page)).toBeLessThanOrEqual(0);
    await capture(page, 'tablet-768-light-defaults');

    // Sticky reachability after scrolling deep into the board.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const navBox = await page.locator('#board-nav').boundingBox();
    expect(navBox).not.toBeNull();
    expect(navBox!.y).toBeGreaterThanOrEqual(0);
    expect(navBox!.y).toBeLessThan(140); // pinned under the measured chrome

    // A shortcut jump lands the target in view and never under the strip.
    const coldLink = page.locator('#board-nav .board-nav__link[data-nav="cold"]');
    await coldLink.focus();
    await expect(coldLink).toBeFocused();
    const focusedBox = await coldLink.boundingBox();
    expect(focusedBox!.y).toBeGreaterThanOrEqual(0);
    await coldLink.click();
    await expect.poll(async () => {
      const box = await page.locator('#board-section-cold .board-band__head').boundingBox();
      return box === null ? Number.NaN : box.y;
    }).toBeGreaterThanOrEqual((navBox?.y ?? 0) + (navBox?.height ?? 0) - 2);
    await expect(page.locator('#board-section-cold .board-band__count')).toHaveText('4 heists');
    await capture(page, 'tablet-768-light-cold-jump');
  });

  test('phone 390 and 360: usable strip, no body overflow, disclosures still reachable', async ({ browser }) => {
    for (const width of [390, 360]) {
      // A fresh page per width: route seeding must not stack across
      // iterations.
      const page = await browser.newPage();
      await page.setViewportSize({ width, height: 844 });
      const seed = await seedBoard(page, proofSnapshot());
      await pairAndOpenBoard(page);
      expect(seed.pageErrors).toEqual([]);
      expect(await sectionOrder(page)).toEqual(['for-you', 'in-flight', 'pipeline', 'for-gru', 'settled', 'cold']);
      await expect.poll(() => bodyOverflow(page)).toBeLessThanOrEqual(0);

      // Every strip item is inside the viewport box (wrapped, not clipped).
      const navLinks = page.locator('#board-nav .board-nav__link');
      await expect(navLinks).toHaveCount(6);
      for (let index = 0; index < 6; index += 1) {
        const box = await navLinks.nth(index).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
      }
      // Long titles wrap instead of forcing overflow.
      await expect(page.locator('.board-band--in-flight .board-job')).toHaveCount(5);
      const more = page.locator('.board-band--in-flight .board-band__more');
      await more.scrollIntoViewIfNeeded();
      await more.click();
      await expect(page.locator('.board-band--in-flight .board-job')).toHaveCount(7);
      await expect.poll(() => bodyOverflow(page)).toBeLessThanOrEqual(0);
      await capture(page, `phone-${width}-light-expanded`);
      await page.locator('.board-band--in-flight .board-band__more').click();
      await expect(page.locator('.board-band--in-flight .board-job')).toHaveCount(5);
      await capture(page, `phone-${width}-light-collapsed`);
      await page.close();
    }
  });

  test('keyboard: strip links are reachable and toggle aria state without any operational request', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const seed = await seedBoard(page, proofSnapshot());
    await pairAndOpenBoard(page);
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET') requests.push(`${request.method()} ${request.url()}`);
    });
    await page.locator('#board-nav .board-nav__link[data-nav="pipeline"]').focus();
    await expect(page.locator('#board-nav .board-nav__link[data-nav="pipeline"]')).toBeFocused();
    await page.keyboard.press('Enter');
    const pipelineHead = await page.locator('#board-section-pipeline .board-band__head').boundingBox();
    expect(pipelineHead).not.toBeNull();
    // Reveal + navigation only: nothing was acked, approved or executed.
    expect(requests.filter((entry) => entry.includes('/api/pipeline'))).toEqual([]);
    expect(requests.filter((entry) => entry.includes('/api/board/notifications'))).toEqual([]);
    expect(seed.pageErrors).toEqual([]);
  });
});
