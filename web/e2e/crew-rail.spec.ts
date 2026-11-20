import { expect, test, type Page } from '@playwright/test';

/** The mock's token — same env knob the mock itself reads (GRU_MOCK_TOKEN, default 'dev-token'). */
const MOCK_TOKEN = process.env.GRU_MOCK_TOKEN ?? 'dev-token';

/**
 * Crew-rail acceptance surface (isolated mock fixture, no live data):
 * short authored names, long/Unicode/special-character names, escaped and
 * bounded rendering, retained role/state subtext, accessible full identity
 * at desktop/phone in light/dark. Every capture is named for the theme and
 * viewport it positively asserts before the file is written.
 */

async function pair(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#pairing-view')).toBeVisible();
  await page.locator('#pair-token').fill(MOCK_TOKEN);
  await page.locator('#pair-submit').click();
  await expect(page.locator('#board-view')).toBeVisible();
}

const THEMES = ['light', 'dark'] as const;
const VIEWPORTS = [
  ['desktop', 1280, 900],
  ['phone', 390, 844],
] as const;

const UNICODE_TITLE = 'Přepiš šablony a ověř 名前の長い表示 — <script> & "café" v názvu';
const UNICODE_NAME = 'přepiš <script> & "café"';
const UNICODE_ID = 'mock-minion-unicode';

test('crew rail names: short authored, long/Unicode, full identity, no overflow', async ({ page }, testInfo) => {
  await pair(page);
  const rail = page.locator('#board-agents');
  // The long FALLBACK row (title-derived name, no authored display_name):
  // its name is the longest rendered string in the rail, so the fit
  // assertions below must cover it at every viewport, not only the
  // authored/Unicode rows (blind review 2026-10-05).
  const fallback = rail.locator('.board-agent[data-role="minion"]', { hasText: 'fix the payment retry' });

  // 1. Short authored name: lowercase heist name + one four-character
  //    suffix; the redundant primary `minion` prefix is gone and the
  //    role/state subtext and pill remain.
  const authored = rail.locator('.board-agent[data-role="minion"]', { hasText: 'api docs pass' });
  await expect(authored.locator('.board-agent__name')).toHaveText('api docs pass');
  await expect(authored.locator('.board-agent__hash')).toHaveText('docs');
  await expect(authored.locator('.board-agent__role')).toHaveText('minion · idle');
  await expect(authored.locator('.board-agent__state')).toHaveText('idle');
  await expect(authored).toHaveAttribute(
    'title',
    'Docs pass on the public endpoints — mock-minion-docs — no session file yet',
  );

  // 2. Long/Unicode/special-character authored name: shortened at the
  //    24-grapheme bound, rendered literally (escaped), with the full title
  //    and full id preserved in the tooltip and the accessible name.
  const unicode = rail.locator('.board-agent[data-role="minion"]', { hasText: UNICODE_NAME });
  await expect(unicode.locator('.board-agent__name')).toHaveText(UNICODE_NAME);
  await expect(unicode.locator('.board-agent__hash')).toHaveText('code');
  await expect(unicode.locator('.board-agent__role')).toHaveText('minion · idle');
  await expect(unicode.locator('.board-agent__state')).toHaveText('idle');
  await expect(unicode).toHaveAttribute('title', `${UNICODE_TITLE} — ${UNICODE_ID} — no session file yet`);
  await expect(unicode).toHaveAttribute(
    'aria-label',
    `${UNICODE_NAME} · ${UNICODE_ID} — ${UNICODE_TITLE} — minion · idle`,
  );

  // 3. No minion row reintroduces the primary role-prefix presentation.
  const minionNames = await rail
    .locator('.board-agent[data-role="minion"] .board-agent__name')
    .allTextContents();
  expect(minionNames.length).toBeGreaterThanOrEqual(3);
  expect(minionNames.some((name) => name.startsWith('minion ·'))).toBe(false);

  for (const theme of THEMES) {
    if (theme === 'dark') await page.locator('#theme-toggle').click();
    // Label integrity: each pass positively asserts its ACTUAL html theme
    // before any capture named for it — light is checked, never assumed.
    if (theme === 'dark') {
      await expect(page.locator('html')).toHaveClass(/dark/);
    } else {
      await expect(page.locator('html')).not.toHaveClass(/dark/);
    }
    for (const [viewport, width, height] of VIEWPORTS) {
      await page.setViewportSize({ width, height });
      await fallback.scrollIntoViewIfNeeded();
      await expect(fallback).toBeVisible();
      await unicode.scrollIntoViewIfNeeded();
      await expect(unicode).toBeVisible();
      // The name and the suffix stay inside the card; nothing spills or
      // forces a horizontal scroll on the rail — checked for the Unicode
      // row AND the long fallback row at every viewport.
      const fitOf = (node: HTMLElement) => {
        const name = node.querySelector('.board-agent__name')!;
        const hash = node.querySelector('.board-agent__hash')!;
        const row = node.getBoundingClientRect();
        const nameBox = name.getBoundingClientRect();
        return {
          nameScrollFits: name.scrollWidth <= name.clientWidth,
          nameInsideCard: nameBox.right <= row.right,
          hashInsideCard: hash.getBoundingClientRect().right <= row.right,
          railNoHorizontalOverflow: node.parentElement!.scrollWidth <= node.parentElement!.clientWidth,
        };
      };
      const unicodeFit = await unicode.evaluate(fitOf);
      const fallbackFit = await fallback.evaluate(fitOf);
      expect(unicodeFit).toEqual({
        nameScrollFits: true,
        nameInsideCard: true,
        hashInsideCard: true,
        railNoHorizontalOverflow: true,
      });
      expect(fallbackFit).toEqual({
        nameScrollFits: true,
        nameInsideCard: true,
        hashInsideCard: true,
        railNoHorizontalOverflow: true,
      });
      await rail.screenshot({ path: testInfo.outputPath('crew-captures', `crew-${theme}-${viewport}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }
});

test('crew rail: a list too long for its height ends on "Show all", which really grows the list and folds it back', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await pair(page);
  const rail = page.locator('#board-agents');
  const toggle = rail.locator('[data-section="crew-all"]');
  const size = (): Promise<{ client: number; scroll: number; scrollWidth: number; clientWidth: number }> =>
    rail.evaluate((node) => ({ client: node.clientHeight, scroll: node.scrollHeight, scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
  // The mock crew does not fit the rail's fixed height.
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveText(/^Show all \d+$/u);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  const folded = await size();
  expect(folded.client).toBeLessThanOrEqual(420);
  expect(folded.scroll).toBeGreaterThan(folded.client);
  // The control is pinned to the list's bottom edge: it is on screen
  // without scrolling the list, and it is the list's last child.
  const railBox = (await rail.boundingBox())!;
  const toggleBox = (await toggle.boundingBox())!;
  expect(toggleBox.y + toggleBox.height).toBeLessThanOrEqual(railBox.y + railBox.height + 1);
  expect(await rail.evaluate((node) => node.lastElementChild?.getAttribute('data-section'))).toBe('crew-all');
  // No chip on any row is wider than the rail.
  expect(folded.scrollWidth).toBeLessThanOrEqual(folded.clientWidth + 1);

  await toggle.click();
  await expect(toggle).toHaveText('Show fewer');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(toggle).toBeFocused();
  // The list actually grew: nothing is left to scroll inside it.
  const shown = await size();
  expect(shown.client).toBeGreaterThan(folded.client);
  expect(shown.scroll).toBeLessThanOrEqual(shown.client + 1);

  await toggle.click();
  await expect(toggle).toHaveText(/^Show all \d+$/u);
  await expect(toggle).toBeFocused();
  expect((await size()).client).toBeLessThanOrEqual(420);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

