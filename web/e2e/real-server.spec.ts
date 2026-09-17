import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { startRealService, type RealServiceHandle } from '../../test/helpers/real-service.mjs';

/**
 * Real-server smoke (E5c): the REAL service (repo dist/main.js, real
 * config/token flow, real /ws contract) serving web/dist, with the Gru
 * runtime played by the offline claude CLI double — every reply echoes
 * the prompt as `echo: <text>` (test/helpers/claude-double.mjs).
 *
 * The service is managed HERE (not as a playwright webServer) so the
 * restart test can bounce it mid-flight: stopping the service drops
 * every socket (1001 going-away), which is the reconnect trigger —
 * the real server has no test control plane, and network emulation
 * does not cut loopback sockets.
 *
 * Chat texts deliberately avoid the double's sentinel words (crash,
 * error, garbage, partial, think, tool:, no-init, no-result-ok); the
 * `hold:<path>` sentinel is used ON PURPOSE to stall a reply until the
 * test releases it (deterministic unread-badge timing).
 */

/** Shared with test/helpers/real-service.mjs. */
const REAL_TOKEN = process.env.REAL_SERVICE_TOKEN ?? 'e2e-real-pairing-token';
const REAL_PORT = Number(process.env.REAL_SERVICE_PORT ?? 7790);

let service: RealServiceHandle | null = null;
// Durable dirs owned by THIS file: captured at boot so afterAll can
// always clean up, even when a restart fails mid-test (service null).
let durableHome = '';
let durableWorkspace = '';

test.beforeAll(async () => {
  // keepHome: the home/workspace must survive stop() so the restart test
  // can reboot on the same durable state; afterAll removes them.
  service = await startRealService({ port: REAL_PORT, token: REAL_TOKEN, keepHome: true });
  durableHome = service.home;
  durableWorkspace = service.workspace;
});

test.afterAll(async () => {
  await service?.stop();
  service = null;
  rmSync(durableHome, { recursive: true, force: true });
  rmSync(durableWorkspace, { recursive: true, force: true });
  durableHome = '';
  durableWorkspace = '';
});

async function pair(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#pairing-view')).toBeVisible();
  await page.locator('#pair-token').fill(REAL_TOKEN);
  await page.locator('#pair-submit').click();
  await expect(page.locator('#chat-view')).toBeVisible();
}

async function sendAndWaitReply(page: Page, text: string): Promise<void> {
  await page.locator('#chat-input').fill(text);
  await page.locator('#chat-send').click();
  await expect(page.locator('.msg--user', { hasText: text })).toBeVisible();
  const reply = page.locator('.msg--gru', { hasText: `echo: ${text}` });
  await expect(reply).toBeVisible();
  await expect(reply).not.toHaveClass(/msg--streaming/);
}

test('pair with the real token, send, streamed echo reply', async ({ page }) => {
  await pair(page);
  await sendAndWaitReply(page, 'real socket hello');
});

test('reload keeps history from the real frame log (no duplicates)', async ({ page }) => {
  await pair(page);
  await sendAndWaitReply(page, 'remember this over the wire');
  await page.reload();
  await expect(page.locator('#chat-view')).toBeVisible();
  await expect(
    page.locator('.msg--user', { hasText: 'remember this over the wire' }),
  ).toHaveCount(1);
  await expect(
    page.locator('.msg--gru', { hasText: 'echo: remember this over the wire' }),
  ).toHaveCount(1);
});

test('service restart drops the socket; reconnect keeps history and flushes the typed word', async ({ page }) => {
  await pair(page);
  await sendAndWaitReply(page, 'before the restart');

  // Stop the real service: every client socket is closed (1001), the
  // client banners, and a typed word queues locally instead of being lost.
  await service!.stop();
  service = null;

  await expect(page.locator('#banners .banner')).toBeVisible();
  await page.locator('#chat-input').fill('typed while down');
  await page.locator('#chat-send').click();
  await expect(page.locator('.msg--user', { hasText: 'typed while down' })).toBeVisible();

  // Restart on the same durable state (frame log + session pointer live
  // in the home dir): the client re-auths from its high-water mark,
  // replays nothing it already saw, flushes the outbox, and the reply
  // streams. History reads exactly once throughout.
  service = await startRealService({
    port: REAL_PORT,
    token: REAL_TOKEN,
    home: durableHome,
    workspace: durableWorkspace,
  });
  await expect(page.locator('#banners .banner')).toBeHidden({ timeout: 15_000 });
  const flushedReply = page.locator('.msg--gru', { hasText: 'echo: typed while down' });
  await expect(flushedReply).toBeVisible();
  await expect(flushedReply).toHaveCount(1);
  await expect(page.locator('.msg--user', { hasText: 'before the restart' })).toHaveCount(1);
  await expect(page.locator('.msg--user', { hasText: 'typed while down' })).toHaveCount(1);
});

test('mobile viewport: corner bubble, sheet, unread badge over the real socket', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pair(page);
  await expect(page.locator('#chat-bubble')).toBeVisible();

  // Stall the reply (double `hold:` sentinel) so deltas arrive only
  // after the sheet is closed — the badge timing is deterministic.
  const releaseDir = `/tmp/gru-e2e-badge-${Date.now()}`;
  const releaseFile = `${releaseDir}/release`;
  const stalled = `hold:${releaseFile}`;

  await page.locator('#chat-bubble').click();
  await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'true');
  await page.locator('#chat-input').fill(stalled);
  await page.locator('#chat-send').click();
  await page.locator('#chat-sheet-grip').click();
  await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'false');

  // Release the stalled turn: deltas stream in while the sheet is closed.
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(releaseFile, 'go');
  await expect(page.locator('#chat-badge')).not.toHaveText('0');

  await page.locator('#chat-bubble').click();
  await expect(page.locator('#chat-badge')).toHaveText('0');
  const reply = page.locator('.msg--gru', { hasText: `echo: ${stalled}` });
  await expect(reply).toBeVisible();
  await expect(reply).not.toHaveClass(/msg--streaming/);
  rmSync(releaseDir, { recursive: true, force: true });
});

test('wrong token: fatal inline error, stays on pairing across reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#pairing-view')).toBeVisible();
  // The field starts EMPTY everywhere — no mock-token prefill to un-guess.
  await expect(page.locator('#pair-token')).toHaveValue('');
  await page.locator('#pair-token').fill('definitely-wrong');
  await page.locator('#pair-submit').click();
  await expect(page.locator('#pair-error')).toBeVisible();
  await expect(page.locator('#pair-error')).toContainText('unauthorized');
  await expect(page.locator('#pairing-view')).toBeVisible();
  await page.reload();
  await expect(page.locator('#pairing-view')).toBeVisible();
  await expect(page.locator('#chat-view')).toBeHidden();
});

test.describe('themes', () => {
  test('light default, dark toggle persists, both snapshotted', async ({ page }) => {
    await pair(page);
    await sendAndWaitReply(page, 'theme real check');

    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await expect(page).toHaveScreenshot('real-chat-light.png', { maxDiffPixelRatio: 0.02 });

    await page.locator('#theme-toggle').click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page).toHaveScreenshot('real-chat-dark.png', { maxDiffPixelRatio: 0.02 });

    await page.reload();
    await expect(page.locator('html')).toHaveClass(/dark/);
  });
});
