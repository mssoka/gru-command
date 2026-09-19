import { expect, test, type Page } from '@playwright/test';
import { WebSocket, type RawData } from 'ws';

/** The mock's token — same env knob the mock itself reads (GRU_MOCK_TOKEN, default 'dev-token'). */
const MOCK_TOKEN = process.env.GRU_MOCK_TOKEN ?? 'dev-token';

/**
 * Smoke: pair → chat → streamed reply → reconnect keeps history,
 * mobile corner bubble, both themes snapshotted. Runs against the
 * dev-only mock (see web/mock/server.ts) via vite preview.
 */

async function pair(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#pairing-view')).toBeVisible();
  await page.locator('#pair-token').fill(MOCK_TOKEN);
  await page.locator('#pair-submit').click();
  await expect(page.locator('#chat-view')).toBeVisible();
}

/** Pair on a phone viewport: the board is the DEFAULT view (SPEC ruling 11). */
async function pairMobile(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#pairing-view')).toBeVisible();
  await page.locator('#pair-token').fill(MOCK_TOKEN);
  await page.locator('#pair-submit').click();
  await expect(page.locator('#board-view')).toBeVisible();
}

async function sendAndWaitReply(page: Page, text: string): Promise<void> {
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-send').click();
  // Own bubble lands acked, the Gru reply streams to a settled turn.
  await expect(page.locator('.msg--user', { hasText: text })).toBeVisible();
  const reply = page.locator('.msg--gru', { hasText: `You said: "${text}"` });
  await expect(reply).toBeVisible();
  await expect(reply).not.toHaveClass(/msg--streaming/);
}

test('pair, send, streamed reply with tool line', async ({ page }) => {
  await pair(page);
  await sendAndWaitReply(page, 'build me a rocket');
  await expect(page.locator('.tool-line', { hasText: 'mock-echo' })).toBeVisible();
});

test('reconnect keeps history after reload (no duplicates)', async ({ page }) => {
  await pair(page);
  await sendAndWaitReply(page, 'remember this message');
  await page.reload();
  // Token persisted → straight into chat; history replays from the log.
  await expect(page.locator('#chat-view')).toBeVisible();
  await expect(page.locator('.msg--user', { hasText: 'remember this message' })).toHaveCount(1);
  await expect(
    page.locator('.msg--gru', { hasText: 'You said: "remember this message"' }),
  ).toHaveCount(1);
});

test('mobile viewport: board-first; chat is a corner bubble that opens a sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pairMobile(page);
  await expect(page.locator('#chat-bubble')).toBeVisible();
  await expect(page.locator('#board-view')).toBeVisible();

  // Open the sheet, send, close it before the reply streams in.
  await page.locator('#chat-bubble').click();
  await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'true');
  await page.locator('#chat-input').fill('mobile hello');
  await page.locator('#chat-send').click();
  await page.locator('#chat-sheet-grip').click();
  await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'false');

  // Deltas arriving while the sheet is closed raise the unread badge.
  await expect(page.locator('#chat-badge')).not.toHaveText('0');

  // Reopen: badge clears, the streamed reply is fully there.
  await page.locator('#chat-bubble').click();
  await expect(page.locator('#chat-badge')).toHaveText('0');
  const reply = page.locator('.msg--gru', { hasText: 'mobile hello' });
  await expect(reply).toBeVisible();
  await expect(reply).not.toHaveClass(/msg--streaming/);
});

test('wrong token: inline error, stays on pairing across reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#pairing-view')).toBeVisible();
  await page.locator('#pair-token').fill('definitely-wrong');
  await page.locator('#pair-submit').click();
  await expect(page.locator('#pair-error')).toBeVisible();
  await expect(page.locator('#pair-error')).toContainText('unauthorized');
  await expect(page.locator('#pairing-view')).toBeVisible();
  // The bad token must not stick: a reload returns to pairing, not a dead chat.
  await page.reload();
  await expect(page.locator('#pairing-view')).toBeVisible();
  await expect(page.locator('#chat-view')).toBeHidden();
});

test('mock controls reject missing/wrong tokens without state changes and valid controls act', async ({ page }) => {
  const initialReset = await page.request.post('http://localhost:8788/__reset', {
    headers: { authorization: `Bearer ${MOCK_TOKEN}` },
  });
  expect(initialReset.ok()).toBe(true);
  await pair(page);
  await sendAndWaitReply(page, 'control-state-survives');

  for (const route of ['__pulse', '__drop', '__reset']) {
    const missing = await page.request.post(`http://localhost:8788/${route}`);
    expect(missing.status(), `${route} missing token`).toBe(401);
    const wrong = await page.request.post(`http://localhost:8788/${route}`, {
      headers: { authorization: 'Bearer definitely-wrong' },
    });
    expect(wrong.status(), `${route} wrong token`).toBe(401);
  }

  // A denied drop did not touch the live socket, and a denied reset did not
  // clear durable mock history.
  await expect(page.locator('#banners .banner')).toBeHidden();
  await sendAndWaitReply(page, 'still-connected-after-denials');
  await page.reload();
  await expect(page.locator('.msg--user', { hasText: 'control-state-survives' })).toHaveCount(1);
  await expect(page.locator('.msg--user', { hasText: 'still-connected-after-denials' })).toHaveCount(1);

  const board = new WebSocket('ws://localhost:8788/board/ws');
  const nextBoardSnapshot = (): Promise<void> => new Promise((resolve, reject) => {
    const onMessage = (data: RawData): void => {
      const frame = JSON.parse(String(data)) as { type?: string };
      if (frame.type !== 'board') return;
      board.off('message', onMessage);
      resolve();
    };
    board.on('message', onMessage);
    board.once('error', reject);
  });
  const initialSnapshot = nextBoardSnapshot();
  await new Promise<void>((resolve, reject) => {
    board.once('open', () => {
      board.send(JSON.stringify({ type: 'auth', token: MOCK_TOKEN }));
      resolve();
    });
    board.once('error', reject);
  });
  await initialSnapshot;
  const pushed = nextBoardSnapshot();
  const pulse = await page.request.post('http://localhost:8788/__pulse', {
    headers: { authorization: `Bearer ${MOCK_TOKEN}` },
  });
  expect(pulse.ok()).toBe(true);
  await pushed;
  board.close();

  const reset = await page.request.post('http://localhost:8788/__reset', {
    headers: { authorization: `Bearer ${MOCK_TOKEN}` },
  });
  expect(reset.ok()).toBe(true);
  await page.reload();
  await expect(page.locator('#chat-view')).toBeVisible();
  await expect(page.locator('.msg--user', { hasText: 'control-state-survives' })).toHaveCount(0);

  const drop = await page.request.post('http://localhost:8788/__drop', {
    headers: { authorization: `Bearer ${MOCK_TOKEN}` },
  });
  expect(drop.ok()).toBe(true);
  await expect(page.locator('#banners .banner')).toBeVisible();
  await expect(page.locator('#banners .banner')).toBeHidden({ timeout: 15_000 });
});

test('socket drop shows a degraded banner that clears on recovery', async ({ page }) => {
  await pair(page);
  const dropped = await page.request.post('http://localhost:8788/__drop', {
    headers: { authorization: `Bearer ${MOCK_TOKEN}` },
  });
  expect(dropped.ok()).toBe(true);
  await expect(page.locator('#banners .banner')).toBeVisible();
  // The client reconnects by itself; the banner clears when the socket opens.
  await expect(page.locator('#banners .banner')).toBeHidden({ timeout: 15_000 });
  // And chat still works after recovery.
  await sendAndWaitReply(page, 'post-drop message');
});

test.describe('board (E6, mock feed)', () => {
  test('repo cards, lens chips, agent rail, notifications render from the mock snapshot', async ({ page }) => {
    await pair(page);
    await page.locator('#tab-board').click();
    await expect(page.locator('#board-view')).toBeVisible();
    await expect(page.locator('.board-repo', { hasText: 'demo-api' })).toBeVisible();
    // The sample round carries all 7 lens chips.
    await expect(page.locator('.board-lens')).toHaveCount(7);
    // The standing crew is on the rail.
    await expect(page.locator('#board-agents .board-agent', { hasText: 'silas' })).toBeVisible();
    // The notification center opens with the sample feed.
    await page.locator('#notification-bell').click();
    await expect(page.locator('.board-notification').first()).toBeVisible();
    await page.locator('#notification-bell').click();
  });

  test('transcript drawer: mock transcript lists, opens, searches', async ({ page }) => {
    await pair(page);
    await page.locator('#tab-board').click();
    const row = page.locator('#board-transcripts .board-agent', { hasText: 'gru' }).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator('#transcript-drawer')).toBeVisible();
    await expect(page.locator('.transcript-entry__text').first()).toBeVisible();
    await page.locator('#transcript-search').fill('secret sauce');
    await expect(page.locator('.transcript-match').first()).toBeVisible();
    await page.locator('#transcript-close').click();
    await expect(page.locator('#transcript-drawer')).toBeHidden();
  });
});

test.describe('themes', () => {
  // Hermetic snapshots: reset the mock log so prior tests' history
  // cannot leak into the frame.
  test.beforeEach(async ({ request }) => {
    const reset = await request.post('http://localhost:8788/__reset', {
      headers: { authorization: `Bearer ${MOCK_TOKEN}` },
    });
    expect(reset.ok()).toBe(true);
  });

  test('light default, dark toggle persists, both snapshotted', async ({ page }) => {
    await pair(page);
    await sendAndWaitReply(page, 'theme check');

    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await expect(page).toHaveScreenshot('chat-light.png', { maxDiffPixelRatio: 0.02 });

    await page.locator('#theme-toggle').click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page).toHaveScreenshot('chat-dark.png', { maxDiffPixelRatio: 0.02 });

    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
  });
});
