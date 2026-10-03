import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { WORKING_FLAVOR_PHRASES } from '../src/lib/working-flavor.js';

/**
 * Working flavor browser check (owner-approved copy): while Gru is
 * authoritatively busy, the status chip shows an approved phrase
 * immediately and rotates it; swapping every approved label keeps the
 * status slot anchored and the controls where they were, at the desktop
 * console, the tablet drawer, and the phone sheet.
 *
 * The mock's scripted turn settles in ~1.5 s — shorter than one 4 s
 * rotation — so this spec arms the mock's one-shot `/__turn-hold` before
 * sending: the reply parks in `busy` until `/__turn-release`, giving a
 * real, bounded rotation window. Runs against the same dev-only mock as
 * `smoke.spec.ts` (Playwright `mock` project) and resets it first.
 */

const MOCK_TOKEN = process.env.GRU_MOCK_TOKEN ?? 'dev-token';
const MOCK_BASE = 'http://localhost:8788';

async function control(request: APIRequestContext, path: string): Promise<void> {
  const response = await request.post(`${MOCK_BASE}${path}`, {
    headers: { authorization: `Bearer ${MOCK_TOKEN}` },
  });
  expect(response.ok(), `${path} accepted`).toBe(true);
}

async function pair(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#pairing-view')).toBeVisible();
  await page.locator('#pair-token').fill(MOCK_TOKEN);
  await page.locator('#pair-submit').click();
  await expect(page.locator('#chat-view')).toBeVisible();
}

/**
 * Live-layout stress for every approved label: set the visible phrase and
 * assert the slot stays anchored (same left/top/height), the controls keep
 * their exact boxes, the strip keeps its box, and nothing wraps or
 * overflows. The phrase's pill may grow rightward into free space by
 * design; it must never push, wrap, or clip the controls.
 */
async function sweepApprovedLabels(page: Page): Promise<void> {
  const problems = await page.evaluate((phrases: string[]) => {
    const strip = document.getElementById('chat-context-controls') as HTMLElement;
    const chip = document.getElementById('chat-context-status') as HTMLElement;
    const flavor = document.getElementById('chat-context-status-flavor') as HTMLElement;
    const controls = ['chat-compact', 'chat-new'].map(
      (id) => document.getElementById(id) as HTMLElement,
    );
    const boxOf = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const near = (left: number, right: number): boolean => Math.abs(left - right) <= 0.5;
    const sameBox = (
      left: { x: number; y: number; width: number; height: number },
      right: { x: number; y: number; width: number; height: number },
    ): boolean =>
      near(left.x, right.x) &&
      near(left.y, right.y) &&
      near(left.width, right.width) &&
      near(left.height, right.height);

    const baseline = {
      chip: boxOf(chip),
      strip: boxOf(strip),
      controls: controls.map(boxOf),
    };
    const found: string[] = [];
    for (const phrase of phrases) {
      flavor.textContent = `${phrase}…`;
      const now = boxOf(chip);
      if (!near(now.x, baseline.chip.x) || !near(now.y, baseline.chip.y)) {
        found.push(`${phrase}: status slot moved`);
      }
      if (!near(now.height, baseline.chip.height)) {
        found.push(`${phrase}: status slot height jumped`);
      }
      if (!sameBox(boxOf(strip), baseline.strip)) {
        found.push(`${phrase}: context strip reflowed`);
      }
      if (!controls.every((control, index) => sameBox(boxOf(control), baseline.controls[index]!))) {
        found.push(`${phrase}: control moved`);
      }
      if (strip.scrollWidth > strip.clientWidth) {
        found.push(`${phrase}: context strip overflows`);
      }
      const chipBox = chip.getBoundingClientRect();
      const stripBox = strip.getBoundingClientRect();
      if (chipBox.right > stripBox.right + 0.5 || chipBox.left < stripBox.left - 0.5) {
        found.push(`${phrase}: status slot escapes the strip`);
      }
    }
    return found;
  }, [...WORKING_FLAVOR_PHRASES]);
  expect(problems).toEqual([]);
}

test.afterEach(async ({ request }) => {
  // A held turn must never leak into a later spec; release is idempotent.
  await request
    .post(`${MOCK_BASE}/__turn-release`, {
      headers: { authorization: `Bearer ${MOCK_TOKEN}` },
    })
    .catch(() => undefined);
});

test('busy phrases rotate with stable status/control geometry on every surface', async ({
  page,
  request,
}) => {
  await control(request, '/__reset');
  await control(request, '/__turn-hold');

  // Desktop console (>= 1100px: the chat pane is the left console column).
  await page.setViewportSize({ width: 1440, height: 900 });
  await pair(page);
  await expect(page.locator('#chat-main-mount > #chat-view')).toHaveCount(1);

  await page.locator('#chat-input').fill('working flavor check');
  await page.locator('#chat-send').click();

  const flavor = page.locator('#chat-context-status-flavor');
  const status = page.locator('#chat-context-status');
  await expect(flavor).toBeVisible();
  const first = (await flavor.textContent())!;
  expect(first.endsWith('…'), `phrase keeps the ellipsis convention: ${first}`).toBe(true);
  expect(WORKING_FLAVOR_PHRASES, `approved pool contains ${first}`).toContain(first.slice(0, -1));
  await expect(status).toHaveAttribute('aria-label', 'Gru is working; context controls are busy');
  await expect(page.locator('#chat-context-status-label')).toHaveText('Gru is working…');
  await expect(page.locator('#chat-compact')).toBeDisabled();
  await expect(page.locator('#chat-new')).toBeDisabled();

  // One real rotation under the hold, with the controls pinned as it lands.
  const controlsBefore = await page.locator('.chat-context__button').evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
  );
  await expect(flavor).not.toHaveText(first, { timeout: 8000 });
  const second = (await flavor.textContent())!;
  expect(second).not.toBe(first);
  expect(WORKING_FLAVOR_PHRASES).toContain(second.slice(0, -1));
  const controlsAfter = await page.locator('.chat-context__button').evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
  );
  expect(controlsAfter).toEqual(controlsBefore);

  await sweepApprovedLabels(page);

  // Tablet drawer (900–1099px: the FAB opens the chat overlay).
  await page.setViewportSize({ width: 1000, height: 800 });
  await page.locator('#gru-fab').click();
  await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'true');
  await expect(flavor).toBeVisible();
  await sweepApprovedLabels(page);

  // Phone bottom sheet (< 900px: status takes its own row, controls below).
  await page.setViewportSize({ width: 390, height: 844 });
  // The tablet drawer stays open across the width change and now covers
  // the FAB — only tap it when the sheet is actually closed.
  if ((await page.locator('#chat-sheet').getAttribute('data-open')) !== 'true') {
    await page.locator('#gru-fab').click();
  }
  await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'true');
  await expect(flavor).toBeVisible();
  await sweepApprovedLabels(page);

  // Release the held turn: the factual idle chip returns and controls re-enable.
  await control(request, '/__turn-release');
  await expect(status).toHaveText('Context unavailable');
  await expect(flavor).toBeHidden();
  await expect(page.locator('#chat-compact')).toBeEnabled();
});
