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

test('multi-line composer (desktop, fine pointer): Shift+Enter newlines, grows without horizontal overflow, Enter sends intact', async ({ page }) => {
  await pair(page);
  const input = page.locator('#chat-input');
  const restHeight = (await input.boundingBox())!.height;

  const line1 = 'steal the moon';
  const line2 = 'minions assemble at dawn';
  await input.click();
  await page.keyboard.type(line1);
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type(line2);
  await expect(input).toHaveValue(`${line1}\n${line2}`);

  // The composer visibly grew, the composer itself fits the viewport,
  // and the chat panel still fits one column (document-level scrollWidth
  // is polluted by a PRE-EXISTING nav overflow at narrow widths — the
  // composer surface is what this lane owns).
  const grownHeight = (await input.boundingBox())!.height;
  expect(grownHeight).toBeGreaterThan(restHeight);
  expect((await input.boundingBox())!.x).toBeGreaterThanOrEqual(0);
  const panelFits = await page.evaluate(() => {
    const panel = document.getElementById('chat-view')!;
    return panel.scrollWidth <= panel.clientWidth;
  });
  expect(panelFits).toBe(true);

  // Enter (no Shift) sends; the newline arrives in the log INTACT.
  await page.keyboard.press('Enter');
  const bubbleText = await page.locator('.msg--user .msg__text').last().textContent();
  expect(bubbleText).toBe(`${line1}\n${line2}`);
  const reply = page.locator('.msg--gru', { hasText: `You said: "${line1}` });
  await expect(reply).toBeVisible();
  await expect(reply).not.toHaveClass(/msg--streaming/);

  // The composer collapsed back to its rest height after the send.
  await expect
    .poll(async () => (await input.boundingBox())!.height)
    .toBeLessThanOrEqual(restHeight + 1);
  await expect(input).toHaveValue('');
});

test('composer caps at ~10rem and scrolls internally past the cap', async ({ page }) => {
  await pair(page);
  const input = page.locator('#chat-input');
  const lines = Array.from({ length: 14 }, (_, i) => `line ${i + 1} of the tall draft`);
  await input.fill(lines.join('\n'));
  const geo = await input.evaluate((el) => ({
    height: (el as HTMLElement).getBoundingClientRect().height,
    scrollH: (el as HTMLTextAreaElement).scrollHeight,
    clientH: (el as HTMLElement).clientHeight,
  }));
  expect(geo.height).toBeLessThanOrEqual(161); // max-height: 10rem + rounding
  expect(geo.scrollH).toBeGreaterThan(geo.clientH); // internal scroll engaged
  await page.locator('#chat-send').click();
  await expect(page.locator('.msg--user', { hasText: 'line 14 of the tall draft' })).toBeVisible();
  // Send collapsed the capped composer back to one row.
  await expect(input).toHaveValue('');
  await expect.poll(async () => (await input.boundingBox())!.height).toBeLessThanOrEqual(70);
});

test('touch composer on a 390px phone (coarse pointer): return inserts a newline, send button visible, click-to-send works', async ({ browser }) => {
  // Emulate the TOUCH INPUT MODALITY, not just the width: the composer
  // keys off `(pointer: coarse)`, which phones match and a narrow DESKTOP
  // window does not. hasTouch is what flips Chromium's pointer media.
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const page = await context.newPage();
  await pairMobile(page);
  await page.locator('#gru-fab').click();
  await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'true');
  const input = page.locator('#chat-input');
  const restHeight = (await input.boundingBox())!.height;
  expect(
    await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches),
  ).toBe(true); // the emulation premise itself, asserted

  // The return key is labeled for its actual job, and the SEND BUTTON is
  // visible — on touch it is the send gesture.
  await expect(input).toHaveAttribute('enterkeyhint', 'enter');
  await expect(page.locator('#chat-send')).toBeVisible();

  await input.click();
  await page.keyboard.type('line one of the plan');
  // RETURN KEY MUST NOT SEND on touch — it inserts a newline.
  await page.keyboard.press('Enter');
  await page.keyboard.type('line two of the plan');
  await expect(input).toHaveValue('line one of the plan\nline two of the plan');
  // Nothing of MINE was sent (the shared mock log replays earlier tests'
  // user bubbles, so the no-send check is text-scoped, not count-based).
  await expect(page.locator('.msg--user', { hasText: 'line one of the plan' })).toHaveCount(0);
  expect((await input.boundingBox())!.height).toBeGreaterThan(restHeight);
  expect((await input.boundingBox())!.x).toBeGreaterThanOrEqual(0);
  // The composer surface never overflows horizontally inside the sheet
  // (document-level scrollWidth is polluted by a PRE-EXISTING nav
  // overflow at narrow widths — the composer surface is what this lane
  // owns).
  const sheetFits = await page.evaluate(() => {
    const sheet = document.getElementById('chat-sheet')!;
    return sheet.scrollWidth <= sheet.clientWidth;
  });
  expect(sheetFits).toBe(true);
  // Controls stay reachable: attach + send sit inside the viewport, on
  // BOTH axes (a grown composer must not push them off the phone screen).
  for (const control of ['#chat-attach', '#chat-send']) {
    const box = (await page.locator(control).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
  }

  // Click-to-send works; the newline arrives INTACT and the composer
  // cleared + collapsed.
  await page.locator('#chat-send').click();
  await expect(page.locator('.msg--user', { hasText: 'line two of the plan' })).toBeVisible();
  const bubbleText = await page.locator('.msg--user .msg__text').last().textContent();
  expect(bubbleText).toBe('line one of the plan\nline two of the plan');
  await expect(input).toHaveValue('');
  await expect
    .poll(async () => (await input.boundingBox())!.height)
    .toBeLessThanOrEqual(restHeight + 1);
  await context.close();
});

test('context controls compact in place and New chat advances a reload-safe empty view', async ({ page }) => {
  await pair(page);
  await sendAndWaitReply(page, 'context control old words');
  await expect(page.locator('#chat-context-status')).toHaveText('Context unavailable');

  await expect(page.locator('#chat-compact')).toBeEnabled();
  await page.locator('#chat-compact').click();
  await expect(page.locator('#chat-context-status')).toHaveText('Compacting context…');
  await expect(page.locator('.msg--user', { hasText: 'context control old words' })).toHaveCount(1);
  await expect(page.locator('.notice-line', { hasText: 'context compacted' })).toBeVisible();

  const compactFailure = await page.request.post('http://localhost:8788/__compact-fail', {
    headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
  });
  expect(compactFailure.ok()).toBe(true);
  await expect(page.locator('#chat-compact')).toBeEnabled();
  await page.locator('#chat-compact').click();
  await expect(page.locator('#chat-context-status')).toHaveText('Compacting context…');
  await expect(
    page.locator('.notice-line', { hasText: 'compact context failed: mock native compact failed' }),
  ).toBeVisible();
  await expect(page.locator('.msg--user', { hasText: 'context control old words' })).toHaveCount(1);

  page.once('dialog', (dialog) => dialog.dismiss());
  await page.locator('#chat-new').click();
  await expect(page.locator('.msg--user', { hasText: 'context control old words' })).toHaveCount(1);

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#chat-new').click();
  await expect(page.locator('.msg--user', { hasText: 'context control old words' })).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.msg--user', { hasText: 'context control old words' })).toHaveCount(0);
  await sendAndWaitReply(page, 'first words in fresh epoch');
});

test('failed New chat restores history and delivers a word typed in the pending view once', async ({ page }) => {
  await pair(page);
  await sendAndWaitReply(page, 'retired words before failed reset');
  const armFailure = await page.request.post('http://localhost:8788/__new-chat-fail', {
    headers: { authorization: `Bearer ${MOCK_TOKEN}` },
  });
  expect(armFailure.ok()).toBe(true);

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#chat-new').click();
  await expect(page.locator('#chat-context-status')).toHaveText('Starting new chat…');
  await expect(page.locator('.msg--user', { hasText: 'retired words before failed reset' })).toHaveCount(0);
  await page.locator('#chat-input').fill('word typed during failed reset');
  await page.locator('#chat-send').click();
  await expect(page.locator('.msg--user', { hasText: 'word typed during failed reset' })).toHaveCount(1);
  await page.reload();
  await expect(page.locator('#chat-view')).toBeVisible();
  await expect(page.locator('.msg--user', { hasText: 'word typed during failed reset' })).toHaveCount(1);

  // The failed reset surfaces on reconnect: the notice lands and history is
  // restored EXACTLY once. (The transient empty view between reload and the
  // inferred failure is not deterministically observable — this lane asserts
  // the end state, not a racing intermediate frame.)
  await expect(
    page.locator('.notice-line', { hasText: 'New chat did not complete before reconnect' }),
  ).toBeVisible();
  await expect(page.locator('.msg--user', { hasText: 'retired words before failed reset' })).toHaveCount(1);
  await expect(page.locator('.msg--user', { hasText: 'word typed during failed reset' })).toHaveCount(1);
  const reply = page.locator('.msg--gru', { hasText: 'You said: "word typed during failed reset"' });
  await expect(reply).toHaveCount(1);
  await expect(reply).not.toHaveClass(/msg--streaming/);
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
  await expect(page.locator('#gru-fab')).toBeVisible();
  await expect(page.locator('#board-view')).toBeVisible();

  // Open the sheet, send, close it before the reply streams in.
  await page.locator('#gru-fab').click();
  await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'true');
  await page.locator('#chat-input').fill('mobile hello');
  await page.locator('#chat-send').click();
  await page.locator('#chat-sheet-grip').click();
  await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'false');

  // Deltas arriving while the sheet is closed raise the unread badge.
  await expect(page.locator('#chat-badge')).not.toHaveText('0');

  // Reopen: badge clears, the streamed reply is fully there.
  await page.locator('#gru-fab').click();
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

test('legacy outbox migration is atomic and browser tabs keep independent queues', async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem('gru-pairing-token', 'migration-test-invalid-token');
    localStorage.setItem(
      'gru-outbox',
      JSON.stringify([
        { client_msg_id: 'legacy-only', text: 'legacy queued word', status: 'queued' },
        { client_msg_id: 'duplicate', text: 'legacy duplicate', status: 'queued' },
      ]),
    );
    sessionStorage.setItem(
      'gru-outbox',
      JSON.stringify([
        { client_msg_id: 'tab-a-only', text: 'tab A queued word', status: 'queued' },
        { client_msg_id: 'duplicate', text: 'tab A wins duplicate', status: 'queued' },
      ]),
    );
  });
  await page.goto('/');
  await expect(page.locator('#pair-error')).toContainText('unauthorized');
  const migrated = await page.evaluate(() => ({
    legacy: localStorage.getItem('gru-outbox'),
    outbox: JSON.parse(sessionStorage.getItem('gru-outbox') ?? '[]') as Array<{
      client_msg_id: string;
      text: string;
    }>,
  }));
  expect(migrated.legacy).toBeNull();
  expect(migrated.outbox.map((entry) => entry.client_msg_id)).toEqual([
    'tab-a-only',
    'duplicate',
    'legacy-only',
  ]);
  expect(migrated.outbox.find((entry) => entry.client_msg_id === 'duplicate')?.text).toBe(
    'tab A wins duplicate',
  );
  await expect(page.locator('.msg--user', { hasText: 'tab A queued word' })).toHaveCount(1);

  const tabB = await context.newPage();
  await tabB.addInitScript(() => {
    localStorage.setItem('gru-pairing-token', 'migration-test-invalid-token');
    sessionStorage.setItem(
      'gru-outbox',
      JSON.stringify([
        { client_msg_id: 'tab-b-only', text: 'tab B queued word', status: 'queued' },
      ]),
    );
  });
  await tabB.goto('/');
  await expect(tabB.locator('#pair-error')).toContainText('unauthorized');
  await expect(tabB.locator('.msg--user', { hasText: 'tab B queued word' })).toHaveCount(1);
  await expect(tabB.locator('.msg--user', { hasText: 'tab A queued word' })).toHaveCount(0);
  await expect(page.locator('.msg--user', { hasText: 'tab B queued word' })).toHaveCount(0);
  await tabB.close();
});

test('mock controls reject missing/wrong tokens without state changes and valid controls act', async ({ page }) => {
  const initialReset = await page.request.post('http://localhost:8788/__reset', {
    headers: { authorization: `Bearer ${MOCK_TOKEN}` },
  });
  expect(initialReset.ok()).toBe(true);
  await pair(page);
  await sendAndWaitReply(page, 'control-state-survives');

  for (const route of ['__pulse', '__drop', '__reset', '__compact-fail', '__new-chat-fail']) {
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
  await page.locator('#chat-compact').click();
  await expect(page.locator('#chat-context-announcement')).toHaveText(
    'Context compacted successfully',
  );

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
  test('dense rows collapse by default; expanding reveals the round lens chips', async ({ page }) => {
    await pair(page);
    await expect(page.locator('#board-view')).toBeVisible();
    // v4 bands lead the board; rows group under sticky band separators.
    await expect(page.locator('.board-band__label').first()).toHaveText('NEEDS YOU');
    await expect(
      page.locator('.board-band--needs-you .board-job', { hasText: 'Merge main into the retry branch' }),
    ).toBeVisible();

    // Collapsed default: summary face only — no detail nodes in the DOM.
    const job = page.locator('.board-job', { hasText: 'Fix the payment retry loop' });
    await expect(job).toHaveAttribute('data-expanded', 'false');
    await expect(job.locator('.board-job__body')).toHaveCount(0);
    await expect(page.locator('.board-lens')).toHaveCount(0);
    // Line 1 carries the status dot + chip; line 2 the repo/branch/ages.
    await expect(job.locator('.board-job__dot')).toBeVisible();
    await expect(job.locator('.board-job__branch')).toContainText('gru/demo-api-payment-fix');
    // The one compact signal carries the live round + the unacked notice.
    const signal = job.locator('.board-job__signal');
    await expect(signal).toContainText('live');
    await expect(signal).toContainText('action-required');

    // Expand the row, then the round row: all 7 lens chips appear.
    await job.locator('.board-job__toggle').click();
    await expect(job).toHaveAttribute('data-expanded', 'true');
    await expect(job.locator('.board-lane')).toBeVisible();
    const round = job.locator('.board-round__toggle');
    await expect(round).toContainText('3/7 lenses');
    await expect(round).toContainText('1 blocker');
    await round.click();
    await expect(page.locator('.board-lens')).toHaveCount(7);
    // The standing crew is on the rail.
    await expect(page.locator('#board-agents .board-agent', { hasText: 'silas' })).toBeVisible();
    // The notification center opens with the sample feed.
    await page.locator('#notification-bell').click();
    await expect(page.locator('.board-notification').first()).toBeVisible();
    await page.locator('#notification-bell').click();
  });

  test('v6: the chip rail carries the v4 health row + folded KPI counts, bands stay ordered', async ({ page }) => {
    await pair(page);
    await expect(page.locator('#board-view')).toBeVisible();

    // The global rail replaces the old KPI strip + health row: seven chips.
    await expect(page.locator('#chip-rail')).toBeVisible();
    await expect(page.locator('#chip-rail .rail-chip')).toHaveCount(7);
    const railText = (await page.locator('#chip-rail').textContent()) ?? '';
    for (const label of ['DEPLOY', 'REVIEWS', 'SILAS', 'ALERTS', 'VERIFY', 'CURE', 'TRACKERS']) {
      expect(railText).toContain(label);
    }
    // The folded counts are the v4 KPI values (data-kpi keys).
    for (const kpi of [
      'jobs.total',
      'jobs.working',
      'jobs.inReview',
      'jobs.merged',
      'jobs.done',
      'jobs.parked',
      'prs.open',
      'prs.conflicting',
      'prs.mergedToday',
      'lanes.liveMinions',
      'lanes.midTurn',
      'lanes.disposed',
    ]) {
      await expect(page.locator(`#chip-rail [data-kpi="${kpi}"]`)).toHaveCount(1);
    }

    // Deploy drift is mandatory and reads the mock's 3-behind build.
    const deploy = page.locator('.rail-chip[data-chip="deploy"]');
    await expect(deploy).toContainText('3 behind');
    await expect(deploy.locator('.rail-chip__flag')).toHaveText('RESTART PENDING');
    await expect(page.locator('.rail-chip[data-chip="verify"]')).toContainText('lock free');
    await expect(page.locator('.rail-chip[data-chip="cure"] .rail-chip__value')).toHaveText('n/a');

    // Bands in priority order, headers sticky separators with counts.
    await expect(page.locator('.board-band__label')).toHaveText(['NEEDS YOU', 'IN FLIGHT', 'SETTLED', 'COLD']);
    const bandSticky = await page
      .locator('.board-band--in-flight .board-band__head')
      .evaluate((node) => getComputedStyle(node).position);
    expect(bandSticky).toBe('sticky');
    await expect(page.locator('.board-band--settled .board-band__count')).toHaveText('12 heists');
    // The stalled working lane sank to COLD carrying the stale flag.
    const stalled = page.locator('.board-band--cold .board-job', { hasText: 'Backfill the audit log' });
    await expect(stalled).toBeVisible();
    await expect(stalled.locator('.board-job__stale')).toHaveText('stalled');
  });

  test('row disclosure persists per job across a reload (v3)', async ({ page }) => {
    await pair(page);
    const job = page.locator('.board-job', { hasText: 'Fix the payment retry loop' });
    await expect(job).toHaveAttribute('data-expanded', 'false');

    // Collapsed board is dramatically shorter than the disclosed detail.
    const collapsedHeight = await page.evaluate(
      () => document.querySelector('#board-jobs')?.scrollHeight ?? 0,
    );
    await job.locator('.board-job__toggle').click();
    await expect(job).toHaveAttribute('data-expanded', 'true');
    await expect(job.locator('.board-lane')).toBeVisible();
    const expandedHeight = await page.evaluate(
      () => document.querySelector('#board-jobs')?.scrollHeight ?? 0,
    );
    expect(expandedHeight).toBeGreaterThan(collapsedHeight);

    // Reload: the expanded job comes back expanded (per-job localStorage).
    await page.reload();
    await expect(job).toHaveAttribute('data-expanded', 'true');

    // Collapse it again; the next reload comes back collapsed.
    await job.locator('.board-job__toggle').click();
    await expect(job).toHaveAttribute('data-expanded', 'false');
    await page.reload();
    await expect(job).toHaveAttribute('data-expanded', 'false');
    await expect(job.locator('.board-job__body')).toHaveCount(0);
  });

  test('trackers: lane strip, round progress, decisions + unacked, disposed collapse', async ({ page }) => {
    await pair(page);
    await expect(page.locator('#board-view')).toBeVisible();

    // The lane strip lives in the expanded detail (v2 surface, v3 default).
    const card = page.locator('.board-job', { hasText: 'Fix the payment retry loop' });
    await card.locator('.board-job__toggle').click();
    const lane = card.locator('.board-lane');
    await expect(lane).toBeVisible();
    await expect(lane.locator('.board-lane__branch')).toContainText('gru/demo-api-payment-fix');
    await expect(lane.locator('.board-lane__base')).toContainText('abc1234');
    await expect(lane.locator('.board-lane__age')).toContainText('heist');
    await expect(lane.locator('.board-lane__activity')).toContainText('minion');

    // Round header: lens count, blockers, elapsed; chips behind the row.
    const round = card.locator('.board-round__toggle');
    await expect(round).toContainText('/7 lenses');
    await expect(round.locator('.board-round__blockers')).toContainText('1 blocker');
    await expect(round.locator('.board-round__elapsed')).toContainText('elapsed');
    await round.click();
    await expect(page.locator('.board-lens', { hasText: 'blind ×2' })).toBeVisible();
    await expect(page.locator('.board-lens--blocker')).toHaveCount(1);

    // Jev decisions chip + unacked action-required badge stay global in the rail.
    await expect(page.locator('#board-decisions')).toContainText('Jev: READY');
    await expect(page.locator('#board-unacked')).toBeVisible();

    // Disposed rows collapse by default behind the toggle on the CREW tab.
    const rail = page.locator('#board-agents');
    await expect(rail.locator('.board-agent--disposed')).toHaveCount(0);
    const toggle = rail.locator('.board-agent-toggle');
    await expect(toggle).toContainText('1 disposed');
    await toggle.click();
    await expect(rail.locator('.board-agent--disposed')).toHaveCount(1);
    // Streaming silas carries the client-side turn-age counter.
    await expect(rail.locator('.board-agent__age').first()).toContainText('quiet');
  });

  test('trackers render in dark theme and on a narrow phone viewport', async ({ page }) => {
    await pair(page);
    const card = page.locator('.board-job', { hasText: 'Fix the payment retry loop' });
    await card.locator('.board-job__toggle').click();
    await expect(card.locator('.board-lane')).toBeVisible();
    await page.locator('#theme-toggle').click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    // Same tracker surfaces stay rendered with the dark tokens applied.
    await expect(page.locator('#board-decisions')).toBeVisible();
    await expect(card.locator('.board-round__toggle')).toBeVisible();
    await expect(card.locator('.board-lane__age')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#chip-rail')).toBeVisible();
    await expect(page.locator('#board-unacked')).toBeVisible();
    await expect(page.locator('#board-agents .board-agent').first()).toBeVisible();
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(fits).toBe(true);
  });

  test('transcript drawer: mock transcript lists, opens, searches', async ({ page }) => {
    await pair(page);
    // Transcripts live behind the rail's TRANSCRIPTS tab (v6).
    await page.locator('#rail-tab-transcripts').click();
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

test.describe('cockpit layout (v6)', () => {
  test('1440px: three panes + drag splitters; the drag persists, double-click resets, settled window rolls', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await pair(page);

    // All three panes render at once: chat left, board center, agents rail right.
    await expect(page.locator('#chat-main-mount > #chat-view')).toHaveCount(1);
    await expect(page.locator('#board-view')).toBeVisible();
    await expect(page.locator('#agents-rail')).toBeVisible();
    const chatBox = (await page.locator('#chat-main-mount').boundingBox())!;
    const boardBox = (await page.locator('#board-view').boundingBox())!;
    const railBox = (await page.locator('#agents-rail').boundingBox())!;
    expect(chatBox.x + chatBox.width).toBeLessThanOrEqual(boardBox.x);
    expect(boardBox.x + boardBox.width).toBeLessThanOrEqual(railBox.x + 1);

    // Both drag boundaries are live handles.
    const splitter = page.locator('#splitter-chat');
    const railSplitter = page.locator('#splitter-rail');
    await expect(splitter).toBeVisible();
    await expect(railSplitter).toBeVisible();

    // Default chat is ~30% of the container (floored at 420) — wider than v5's 380.
    expect(chatBox.width).toBeGreaterThanOrEqual(420);

    // Drag the chat boundary right: the pane resizes and the pair persists.
    const handle = (await splitter.boundingBox())!;
    await page.mouse.move(handle.x + 2, handle.y + 80);
    await page.mouse.down();
    await page.mouse.move(handle.x + 2 + 140, handle.y + 80, { steps: 6 });
    await page.mouse.up();
    const widened = (await page.locator('#chat-main-mount').boundingBox())!;
    expect(widened.width).toBeGreaterThan(chatBox.width + 100);
    const persisted = await page.evaluate(() => localStorage.getItem('gru-pane-sizes'));
    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted ?? '{}')).toHaveProperty('cockpit.chat');

    // Reload: the user's widths come back (poll through the 180ms grid tween).
    await page.reload();
    await expect
      .poll(async () => Math.abs((await page.locator('#chat-main-mount').boundingBox())!.width - widened.width))
      .toBeLessThanOrEqual(2);
    const reloaded = (await page.locator('#chat-main-mount').boundingBox())!;
    expect(Math.abs(reloaded.width - widened.width)).toBeLessThanOrEqual(2);

    // Double-click resets both panes to their defaults (settle first so the
    // reset target is measured, not the tween's midpoint).
    const handleAgain = (await splitter.boundingBox())!;
    await page.mouse.dblclick(handleAgain.x + 2, handleAgain.y + 80);
    await expect
      .poll(async () => Math.abs((await page.locator('#chat-main-mount').boundingBox())!.width - chatBox.width))
      .toBeLessThanOrEqual(2);

    // The settled window rolls: 12 settled → 10 rows + a +2 footer.
    await expect(page.locator('.board-band--settled .board-job')).toHaveCount(10);
    const more = page.locator('.board-band--settled .board-band__more');
    await expect(more).toHaveText('+2 older settled');
    await more.click();
    await expect(page.locator('.board-band--settled .board-job')).toHaveCount(12);
    await expect(page.locator('.board-band--settled .board-band__more')).toHaveCount(0);

    // The FAB collapses the pane to the slim rail (and back); the choice persists.
    await page.locator('#gru-fab').click();
    await expect(page.locator('#console')).toHaveClass(/console--chat-collapsed/);
    await expect(page.locator('#chat-rail')).toBeVisible();
    // The grid column animates (180ms), so poll for the board reclaiming x.
    await expect
      .poll(async () => (await page.locator('#board-view').boundingBox())!.x)
      .toBeLessThan(boardBox.x);
    await page.reload();
    await expect(page.locator('#chat-rail')).toBeVisible();
    await page.locator('#chat-rail').click();
    await expect(page.locator('#chat-main-mount > #chat-view')).toHaveCount(1);
    await expect(page.locator('#chat-rail')).toBeHidden();
  });

  test('1100px cockpit edge: three panes, floor widths hold, no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 });
    await pair(page);

    await expect(page.locator('#chat-main-mount > #chat-view')).toHaveCount(1);
    await expect(page.locator('#splitter-chat')).toBeVisible();
    await expect(page.locator('#splitter-rail')).toBeVisible();
    const chatBox = (await page.locator('#chat-main-mount').boundingBox())!;
    expect(chatBox.width).toBeGreaterThanOrEqual(420);
    const railBox = (await page.locator('#agents-rail').boundingBox())!;
    expect(railBox.width).toBeGreaterThanOrEqual(240);
    const fits = await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    );
    expect(fits).toBe(true);
  });

  test('1000px two-pane: board + rail, FAB opens the dimmed overlay chat', async ({ page }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await pair(page);

    // The chat panel lives in the overlay sheet; the board + rail hold the page.
    await expect(page.locator('#chat-sheet #chat-view')).toHaveCount(1);
    await expect(page.locator('#board-view')).toBeVisible();
    await expect(page.locator('#agents-rail')).toBeVisible();
    await expect(page.locator('#splitter-chat')).toBeHidden();

    await page.locator('#gru-fab').click();
    await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'true');
    await expect(page.locator('#chat-scrim')).toBeVisible();
    await expect(page.locator('#chat-input')).toBeVisible();
    // The board is still rendered behind the dim.
    await expect(page.locator('#board-view')).toBeVisible();
    await page.locator('#chat-scrim').click();
    await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'false');
    await expect(page.locator('#chat-scrim')).toBeHidden();
  });

  test('single column at 800px: rail stacks below, FAB overlay sheet over the board', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 });
    await pair(page);

    const mainBox = (await page.locator('.board-main').boundingBox())!;
    const sideBox = (await page.locator('#agents-rail').boundingBox())!;
    expect(sideBox.y).toBeGreaterThanOrEqual(mainBox.y + mainBox.height - 1);

    await page.locator('#gru-fab').click();
    await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'true');
    await expect(page.locator('#chat-scrim')).toBeVisible();
    await expect(page.locator('#board-view')).toBeVisible();
    await expect(page.locator('#chat-input')).toBeVisible();
    await page.locator('#chat-sheet-grip').click();
    await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'false');
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

test.describe('phone chrome', () => {
  /** The document must never scroll sideways: the AC number, verbatim. */
  async function assertNoHorizontalOverflow(page: Page): Promise<void> {
    const { scrollWidth, clientWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(
      scrollWidth,
      `document scrolls sideways: ${scrollWidth} > ${clientWidth}`,
    ).toBeLessThanOrEqual(clientWidth);
  }

  /** Visible AND fully inside the viewport — no clipped chrome controls. */
  async function assertReachable(page: Page, selector: string): Promise<void> {
    const loc = page.locator(selector);
    await expect(loc).toBeVisible();
    const box = await loc.boundingBox();
    expect(box, `${selector} rendered`).not.toBeNull();
    const vw = await page.evaluate(() => document.documentElement.clientWidth);
    expect(box!.x, `${selector} left edge on screen`).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `${selector} right edge on screen`).toBeLessThanOrEqual(vw);
  }

  const CHROME_CONTROLS = ['#theme-toggle', '#settings-toggle'];

  /** Top-anchored overlays must clear the nav, whatever its wrapped
   * height: kills any mutation of --phone-nav-clearance to less than the
   * nav height (token→0px fails both assertions; the deleted per-overlay
   * override falls back to 58/64px and fails too). Not a guard against
   * deleting the token itself — var() then goes auto/static-position. */
  async function assertOverlaysClearNav(page: Page): Promise<void> {
    // #board-view's .reveal animates a transform for 0.4s; a running
    // transform makes board-view the absolute panel's containing block
    // and would mask a too-small top. Wait it out so both overlays are
    // measured against the viewport like in steady state.
    await page.waitForFunction(
      () => getComputedStyle(document.querySelector('#board-view')!).transform === 'none',
      undefined,
      { timeout: 5_000 },
    );
    const m = await page.evaluate(() => ({
      navBottom: document.querySelector('.command-bar')!.getBoundingClientRect().bottom,
      panelTop: document.querySelector('#notification-panel')!.getBoundingClientRect().top,
      toastTop: document.querySelector('#toasts')!.getBoundingClientRect().top,
    }));
    expect(m.panelTop, 'notification panel clears the nav').toBeGreaterThanOrEqual(m.navBottom);
    expect(m.toastTop, 'toast stack clears the nav').toBeGreaterThanOrEqual(m.navBottom);
  }

  test('nav fits the phone: zero horizontal overflow on chat and board, every control reachable', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });

    // Chat surface (pre-pair the same chrome renders over the pairing card).
    await page.goto('/');
    await expect(page.locator('#pairing-view')).toBeVisible();
    await assertNoHorizontalOverflow(page);
    // Direct tagline-suppression coverage: the decorative line is phone-off.
    await expect(page.locator('.command-bar__tagline')).toBeHidden();
    for (const selector of CHROME_CONTROLS) {
      await assertReachable(page, selector);
    }

    // Board surface (paired mobile: board is the default view, bell shows).
    await pairMobile(page);
    await expect(page.locator('#board-view')).toBeVisible();
    await expect(page.locator('#notification-bell')).toBeVisible();
    await assertNoHorizontalOverflow(page);
    for (const selector of [...CHROME_CONTROLS, '#notification-bell']) {
      await assertReachable(page, selector);
    }

    // Perkins r1 blocker: the clearance overrides are load-bearing — open
    // the panel and prove both top-anchored overlays sit below the nav.
    await page.locator('#notification-bell').click();
    await expect(page.locator('.board-notification').first()).toBeVisible();
    await assertOverlaysClearNav(page);
    await page.locator('#notification-bell').click();

    // Chat surface, paired: the phone chat is the corner-bubble sheet.
    await page.locator('#gru-fab').click();
    await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'true');
    await assertNoHorizontalOverflow(page);
    await page.locator('#chat-sheet-grip').click();
    await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'false');
    await assertNoHorizontalOverflow(page);
  });

  test('561px band: the single-row nav still fits without overflow or clipped controls', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 561, height: 844 });
    await page.goto('/');
    await expect(page.locator('#pairing-view')).toBeVisible();
    await assertNoHorizontalOverflow(page);
    // The tagline only drops under the phone breakpoint.
    await expect(page.locator('.command-bar__tagline')).toBeVisible();
    for (const selector of CHROME_CONTROLS) {
      await assertReachable(page, selector);
    }

    // Paired, the bell joins the nav — the worst-case (widest) header.
    await pairMobile(page);
    await expect(page.locator('#board-view')).toBeVisible();
    await expect(page.locator('#notification-bell')).toBeVisible();
    await assertNoHorizontalOverflow(page);
    for (const selector of [...CHROME_CONTROLS, '#notification-bell']) {
      await assertReachable(page, selector);
    }
  });
});
