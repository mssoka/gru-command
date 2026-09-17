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

/** Pair on a phone viewport: the board is the DEFAULT view (SPEC ruling 11). */
async function pairMobile(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#pairing-view')).toBeVisible();
  await page.locator('#pair-token').fill(REAL_TOKEN);
  await page.locator('#pair-submit').click();
  await expect(page.locator('#board-view')).toBeVisible();
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

test('mobile viewport: board-first, corner bubble, sheet, unread badge over the real socket', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pairMobile(page);
  await expect(page.locator('#chat-bubble')).toBeVisible();
  // The board (not chat) is the phone's landing view; the bubble opens chat.
  await expect(page.locator('#board-view')).toBeVisible();

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

test.describe('board (E6)', () => {
  test('seeded jobs render repo-grouped with lens chips; live push updates', async ({ page }) => {
    // Seed the ledger through the real write API.
    const base = { authorization: `Bearer ${REAL_TOKEN}` };
    const job = { id: 'e2e-board-job', repo: 'e2e-repo', title: 'Board e2e job', baseBranch: 'main' };
    const created = await page.request.post(`http://127.0.0.1:${REAL_PORT}/api/jobs`, { headers: base, data: job });
    expect(created.status()).toBe(201);
    const round = await page.request.post(`http://127.0.0.1:${REAL_PORT}/api/rounds`, { headers: base, data: { jobId: job.id } });
    expect(round.status()).toBe(201);
    const lenses = (await round.json()).lenses as { lens: string; state: string }[];
    expect(lenses.length).toBe(7);

    await pair(page);
    await page.locator('#tab-board').click();
    await expect(page.locator('#board-view')).toBeVisible();
    const repoCard = page.locator('.board-repo', { hasText: 'e2e-repo' });
    await expect(repoCard).toBeVisible();
    await expect(repoCard.locator('.board-job', { hasText: 'Board e2e job' })).toBeVisible();
    // All 7 lens chips render on the round.
    await expect(repoCard.locator('.board-lens')).toHaveCount(7);

    // A status transition through the API pushes a fresh snapshot live.
    const blocked = await page.request.post(`http://127.0.0.1:${REAL_PORT}/api/jobs/e2e-board-job/status`, { headers: base, data: { status: 'working' } });
    expect(blocked.status()).toBe(200);
    await expect(repoCard.locator('.board-job', { hasText: 'Board e2e job' }).locator('.pp-chip', { hasText: 'working' })).toBeVisible();
  });

  test('agent rail lists the gru session; transcripts open, search, page', async ({ page }) => {
    await pair(page);
    await sendAndWaitReply(page, 'board transcript probe');
    await page.locator('#tab-board').click();
    // The gru agent row (the live chat session) appears on the rail; its
    // transcript (claude-code raw-frame forensics) renders the turn.
    const gruRow = page.locator('#board-agents .board-agent', { hasText: 'gru' }).first();
    await expect(gruRow).toBeVisible();
    await gruRow.click();
    const drawer = page.locator('#transcript-drawer');
    await expect(drawer).toBeVisible();
    await expect(
      page.locator('.transcript-entry__text', { hasText: 'board transcript probe' }).first(),
    ).toBeVisible();
    await page.locator('#transcript-close').click();
    await expect(drawer).toBeHidden();

    // Seed a REAL session transcript (pi jsonl format) into the store and
    // bind a ledger agent to it — the full surface: list → open → search.
    const sessionsDir = `${durableHome}/sessions/gru/--e2e-transcript--a1b2c3d4`;
    mkdirSync(sessionsDir, { recursive: true });
    const sessionFile = `${sessionsDir}/2026-01-01T00-00-00-000Z_e2eseed.jsonl`;
    const header = { type: 'session', id: 'e2eseed', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/e2e' };
    const userMsg = (id: string, parent: string | null, text: string) => ({
      type: 'message', id, parentId: parent, timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: text, timestamp: 1000 },
    });
    const asstMsg = (id: string, parent: string, text: string) => ({
      type: 'message', id, parentId: parent, timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'assistant', content: [{ type: 'text', text }], api: 'demo', provider: 'demo', model: 'demo',
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: 'stop', timestamp: 2000,
      },
    });
    writeFileSync(
      sessionFile,
      [header, userMsg('m1', null, 'plan the launch'), asstMsg('m2', 'm1', 'on it, boss'), userMsg('m3', 'm2', 'find the secret sauce'), asstMsg('m4', 'm3', 'tracked on the board')]
        .map((entry) => JSON.stringify(entry))
        .join('\n') + '\n',
    );
    const headers = { authorization: `Bearer ${REAL_TOKEN}` };
    const agent = await page.request.post(`http://127.0.0.1:${REAL_PORT}/api/agents`, {
      headers,
      data: { id: 'e2e-seed-agent', role: 'gru', label: 'seeded transcript', sessionFile },
    });
    expect(agent.status()).toBe(201);

    // The seeded transcript appears in the transcripts list; open it.
    const seedRow = page.locator('#board-transcripts .board-agent', { hasText: 'seeded transcript' });
    await expect(seedRow).toBeVisible();
    await seedRow.click();
    await expect(drawer).toBeVisible();
    await expect(page.locator('.transcript-entry__text', { hasText: 'plan the launch' }).first()).toBeVisible();
    // Search narrows with a snippet match.
    await page.locator('#transcript-search').fill('secret sauce');
    await expect(page.locator('.transcript-match', { hasText: 'secret sauce' }).first()).toBeVisible();
    await page.locator('#transcript-close').click();
    await expect(drawer).toBeHidden();
  });

  test('notification ack round-trip (E7): a blocked job feeds the bell; ack clears it', async ({ page }) => {
    // Seed a blocked job through the real API — the FYI derivation posts a
    // durable notification row server-side.
    const headers = { authorization: `Bearer ${REAL_TOKEN}` };
    const job = { id: 'e2e-ack-job', repo: 'e2e-repo', title: 'Ack round-trip job' };
    await page.request.post(`http://127.0.0.1:${REAL_PORT}/api/jobs`, { headers, data: job });
    await page.request.post(`http://127.0.0.1:${REAL_PORT}/api/jobs/e2e-ack-job/status`, { headers, data: { status: 'blocked' } });

    await pair(page);
    await page.locator('#tab-board').click();
    const bell = page.locator('#notification-bell');
    await expect(bell).toBeVisible();
    // The badge shows while an unseen error exists (CSS keys on data-unread).
    await expect(bell).not.toHaveAttribute('data-unread', '0');
    await bell.click();
    const panel = page.locator('#notification-panel');
    await expect(panel).toBeVisible();
    const row = panel.locator('.board-notification', { hasText: 'e2e-ack-job blocked' });
    await expect(row).toBeVisible();
    // Opening the panel sent the shown receipt (proved on the record).
    const board = await (await page.request.get(`http://127.0.0.1:${REAL_PORT}/api/board`, { headers })).json();
    const seededRow = board.notifications.find((n: { title: string }) => n.title.includes('e2e-ack-job blocked'));
    expect(seededRow.shownAt).not.toBeNull();

    // The ack button clears the row through the human ack.
    await row.locator('.board-notification__ack').click();
    await expect(row.locator('.board-notification__ack')).toHaveText('✓');
    const after = await (await page.request.get(`http://127.0.0.1:${REAL_PORT}/api/board`, { headers })).json();
    const ackedRow = after.notifications.find((n: { title: string }) => n.title.includes('e2e-ack-job blocked'));
    expect(ackedRow.ackedAt).not.toBeNull();
    await bell.click(); // close the panel

    // A NEW notification arriving while paired earns the live toast.
    const job2 = { id: 'e2e-ack-job-2', repo: 'e2e-repo', title: 'Toast probe job' };
    await page.request.post(`http://127.0.0.1:${REAL_PORT}/api/jobs`, { headers, data: job2 });
    await page.request.post(`http://127.0.0.1:${REAL_PORT}/api/jobs/e2e-ack-job-2/status`, { headers, data: { status: 'blocked' } });
    const toast = page.locator('.toast', { hasText: 'e2e-ack-job-2 blocked' });
    await expect(toast).toBeVisible();
  });

  test('unauthenticated board API is a locked door', async ({ page }) => {
    const res = await page.request.get(`http://127.0.0.1:${REAL_PORT}/api/board`);
    expect(res.status()).toBe(401);
    const bad = await page.request.get(`http://127.0.0.1:${REAL_PORT}/api/board`, {
      headers: { authorization: 'Bearer nope' },
    });
    expect(bad.status()).toBe(401);
  });
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
