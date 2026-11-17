import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Capture viewer browser check (docs/PR-MEDIA.md, "The FOR YOU card"): a
 * still on the ready card opens the viewer inside the board, the arrows and
 * the filmstrip flip through the card's captures, no tab ever opens, and
 * Escape puts the owner back on the capture they opened. The dialog holds
 * its size from one capture to the next and fits a phone.
 *
 * Runs against the dev-only mock (Playwright `mock` project) in its
 * `captures` board mode, which serves drawn PNGs from /api/media/<id>
 * (web/mock/captures.ts), and restores the default board afterwards.
 */

const MOCK_TOKEN = process.env.GRU_MOCK_TOKEN ?? 'dev-token';
const MOCK_BASE = 'http://localhost:8788';
const AUTH = { authorization: `Bearer ${MOCK_TOKEN}` };

async function boardMode(page: Page, mode: 'default' | 'captures'): Promise<void> {
  const response = await page.request.post(`${MOCK_BASE}/__board-mode`, { headers: AUTH, data: { mode } });
  expect(response.ok(), `board mode ${mode} accepted`).toBe(true);
}

async function pair(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#pairing-view')).toBeVisible();
  await page.locator('#pair-token').fill(MOCK_TOKEN);
  await page.locator('#pair-submit').click();
  await expect(page.locator('#board-view')).toBeVisible();
}

interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

async function box(locator: Locator): Promise<Box> {
  const bounds = await locator.boundingBox();
  if (bounds === null) throw new Error('element has no box');
  return bounds;
}

/** The dialog pops in with a short scale: boxes are measured only once
 * that animation has finished, never mid-flight. */
async function settled(dialog: Locator): Promise<void> {
  await expect(dialog).toBeVisible();
  await dialog.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
}

const naturalWidth = (image: Locator): Promise<number> => image.evaluate((node) => (node as HTMLImageElement).naturalWidth);

test.describe('capture viewer', () => {
  test.beforeEach(async ({ page }) => {
    const reset = await page.request.post(`${MOCK_BASE}/__reset`, { headers: AUTH });
    expect(reset.ok()).toBe(true);
    await boardMode(page, 'captures');
  });

  test.afterEach(async ({ page }) => {
    await boardMode(page, 'default');
  });

  test('a still opens in the board: arrows and filmstrip flip, no tab opens, Escape returns to the card', async ({ page, context }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await pair(page);
    const stills = page.locator('#board-owner .board-owner__media-strip .board-owner__shot-link');
    await expect(stills).toHaveCount(4);
    // The card offers no new-tab link for a capture any more.
    await expect(page.locator('#board-owner .board-owner__media-strip a')).toHaveCount(0);

    await stills.nth(1).click();
    const dialog = page.locator('.gru-modal__card.media-viewer-card');
    await settled(dialog);
    await expect(dialog.locator('.gru-modal__title')).toHaveText('Fix the payment retry loop');
    const count = dialog.locator('.media-viewer__count');
    await expect(count).toHaveText('2 of 4 · 5f4a3b2c');
    await expect(dialog.locator('.media-viewer__label')).toHaveText('before');
    const image = dialog.locator('.media-viewer__stage img');
    await expect.poll(() => naturalWidth(image)).toBe(1280);
    const stage = dialog.locator('.media-viewer__stage');
    const desktopStage = await box(stage);
    const desktopCard = await box(dialog);

    // → moves on to the phone shot: same dialog, same stage, new picture.
    await page.keyboard.press('ArrowRight');
    await expect(count).toHaveText('3 of 4 · 5f4a3b2c');
    await expect(dialog.locator('.media-viewer__label')).toHaveText('after');
    await expect.poll(() => naturalWidth(image)).toBe(390);
    expect(await box(stage)).toEqual(desktopStage);
    expect(await box(dialog)).toEqual(desktopCard);

    // The ends wrap, and the filmstrip jumps straight to a capture.
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(count).toHaveText('1 of 4 · 5f4a3b2c');
    await page.keyboard.press('ArrowLeft');
    await expect(count).toHaveText('4 of 4 · 5f4a3b2c');
    await dialog.locator('.media-viewer__thumb').nth(1).click();
    await expect(count).toHaveText('2 of 4 · 5f4a3b2c');
    await expect(dialog.locator('.media-viewer__thumb').nth(1)).toHaveAttribute('aria-current', 'true');
    await dialog.locator('.media-viewer__nav--next').click();
    await expect(count).toHaveText('3 of 4 · 5f4a3b2c');
    await dialog.locator('.media-viewer__nav--previous').click();
    await expect(count).toHaveText('2 of 4 · 5f4a3b2c');

    // A 1280 px shot is drawn scaled down in this stage, so it zooms to its
    // own pixels and back; the stage scrolls, the dialog does not grow.
    await expect.poll(() => naturalWidth(image)).toBe(1280);
    const zoom = dialog.locator('.media-viewer__zoom');
    await expect(zoom).toBeEnabled();
    const fitted = await box(image);
    expect(fitted.width).toBeLessThan(1280);
    expect(fitted.x).toBeGreaterThanOrEqual(desktopStage.x);
    expect(fitted.x + fitted.width).toBeLessThanOrEqual(desktopStage.x + desktopStage.width);
    await zoom.click();
    await expect.poll(() => image.evaluate((node) => (node as HTMLImageElement).clientWidth)).toBe(1280);
    expect(await box(stage)).toEqual(desktopStage);
    await zoom.click();
    await expect.poll(async () => (await box(image)).width).toBeLessThan(1280);

    // Nothing left the board: one page, and Escape lands on the opened capture.
    expect(context.pages()).toHaveLength(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(stills.nth(1)).toBeFocused();
    expect(context.pages()).toHaveLength(1);
  });

  test('on a phone the dialog fits the screen and the arrows sit under the stage', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await pair(page);
    const stills = page.locator('#board-owner .board-owner__media-strip .board-owner__shot-link');
    await expect(stills).toHaveCount(4);
    await stills.first().scrollIntoViewIfNeeded();
    await stills.first().click();
    const dialog = page.locator('.gru-modal__card.media-viewer-card');
    await settled(dialog);
    await expect.poll(() => naturalWidth(dialog.locator('.media-viewer__stage img'))).toBe(390);

    const card = await box(dialog);
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.y).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(390);
    expect(card.y + card.height).toBeLessThanOrEqual(844);
    const stage = await box(dialog.locator('.media-viewer__stage'));
    const previous = await box(dialog.locator('.media-viewer__nav--previous'));
    const next = await box(dialog.locator('.media-viewer__nav--next'));
    // Thumb-sized bars under the stage, side by side.
    expect(previous.y).toBeGreaterThanOrEqual(stage.y + stage.height);
    expect(next.y).toBe(previous.y);
    expect(next.x).toBeGreaterThan(previous.x + previous.width - 1);
    expect(previous.height).toBeGreaterThanOrEqual(40);
    // Nothing pushes the page sideways, and the dialog's body has no scroll.
    const overflow = await page.evaluate(() => {
      const body = document.querySelector('.media-viewer-card .gru-modal__body')!;
      return {
        page: document.documentElement.scrollWidth - window.innerWidth,
        body: body.scrollHeight - body.clientHeight,
      };
    });
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.body).toBeLessThanOrEqual(0);

    await dialog.locator('.media-viewer__nav--next').click();
    await expect(dialog.locator('.media-viewer__count')).toHaveText('2 of 4 · 5f4a3b2c');
  });
});
