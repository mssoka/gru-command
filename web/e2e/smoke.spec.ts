import { expect, test, type Page } from '@playwright/test';

/**
 * Smoke: pair → chat → streamed reply → reconnect keeps history,
 * mobile corner bubble, both themes snapshotted. Runs against the
 * dev-only mock (see web/mock/server.ts) via vite preview.
 */

async function pair(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#pairing-view')).toBeVisible();
  // localhost prefills the mock's default token — just press Pair.
  await page.locator('#pair-submit').click();
  await expect(page.locator('#chat-view')).toBeVisible();
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

test('mobile viewport: chat is a corner bubble that opens a sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pair(page);
  await expect(page.locator('#chat-bubble')).toBeVisible();

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

test('socket drop shows a degraded banner that clears on recovery', async ({ page }) => {
  await pair(page);
  await page.request.post('http://localhost:8788/__drop');
  await expect(page.locator('#banners .banner')).toBeVisible();
  // The client reconnects by itself; the banner clears when the socket opens.
  await expect(page.locator('#banners .banner')).toBeHidden({ timeout: 15_000 });
  // And chat still works after recovery.
  await sendAndWaitReply(page, 'post-drop message');
});

test.describe('themes', () => {
  // Hermetic snapshots: reset the mock log so prior tests' history
  // cannot leak into the frame.
  test.beforeEach(async ({ request }) => {
    await request.post('http://localhost:8788/__reset');
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
