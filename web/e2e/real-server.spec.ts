import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type FileChooser, type Page } from '@playwright/test';
import { pickFreePort, startRealService, type RealServiceHandle } from '../../test/helpers/real-service.mjs';

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

/** SPEC ruling 19 proof oracle: the claude double records the EXACT
 * prompt the agent received ({prompt, images}) — the agent-side receipt
 * for the full-gesture attach tests. Set before the service spawns. */
const DOUBLE_LOG = join(tmpdir(), `gru-e2e-double-${Date.now()}.jsonl`);
const JEV_FETCH_LOG = join(tmpdir(), `gru-e2e-jev-${Date.now()}.jsonl`);
const JEV_MODE_FILE = join(tmpdir(), `gru-e2e-jev-mode-${Date.now()}`);
const JEV_PRELOAD = join(import.meta.dirname, '..', '..', 'test', 'helpers', 'jev-fetch-double.mjs');
process.env.CLAUDE_DOUBLE_LOG = DOUBLE_LOG;

/** Last {prompt, images} the agent-side double received. */
function lastAgentPrompt(): { prompt: string; images: number; argv: string[] } | null {
  try {
    const lines = readFileSync(DOUBLE_LOG, 'utf-8').trim().split('\n');
    const last = lines.at(-1);
    return last === undefined || last === ''
      ? null
      : (JSON.parse(last) as { prompt: string; images: number; argv: string[] });
  } catch {
    return null;
  }
}

let service: RealServiceHandle | null = null;
// Durable dirs owned by THIS file: captured at boot so afterAll can
// always clean up, even when a restart fails mid-test (service null).
let durableHome = '';
let durableWorkspace = '';

test.beforeAll(async () => {
  // keepHome: the home/workspace must survive stop() so the restart test
  // can reboot on the same durable state; afterAll removes them.
  writeFileSync(JEV_MODE_FILE, 'success', 'utf8');
  service = await startRealService({
    port: REAL_PORT,
    token: REAL_TOKEN,
    keepHome: true,
    decisionKey: 'E2E-FILE-CREDENTIAL-CANARY',
    nodeImport: JEV_PRELOAD,
    extraEnv: { JEV_FETCH_LOG, JEV_FETCH_MODE_FILE: JEV_MODE_FILE },
  });
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
  rmSync(JEV_FETCH_LOG, { force: true });
  rmSync(JEV_MODE_FILE, { force: true });
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

test('multi-line prompt rides the real socket intact (agent receives the newline)', async ({ page }) => {
  await pair(page);
  const line1 = 'first real line';
  const line2 = 'second real line';
  const input = page.locator('#chat-input');
  await input.click();
  await page.keyboard.type(line1);
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type(line2);
  await page.keyboard.press('Enter');
  await expect(page.locator('.msg--user', { hasText: line2 })).toBeVisible();
  const reply = page.locator('.msg--gru', { hasText: `echo: ${line1}` });
  await expect(reply).toBeVisible();
  await expect(reply).not.toHaveClass(/msg--streaming/);
  // The rendered user bubble keeps the newline (display side).
  const bubbleText = await page.locator('.msg--user .msg__text').last().textContent();
  expect(bubbleText).toBe(`${line1}\n${line2}`);
  // The composer cleared after the successful send.
  await expect(input).toHaveValue('');
  // AGENT-SIDE receipt: the double's prompt log carries the EXACT
  // composer text — the wire never flattened the newline.
  expect(lastAgentPrompt()?.prompt).toContain(`${line1}\n${line2}`);
});

test('real native compact preserves history and New chat starts unresumed behind a durable epoch', async ({ page }) => {
  await pair(page);
  await sendAndWaitReply(page, 'real context control old words');
  const pointerFile = join(durableHome, 'chat', 'gru-session.json');

  await expect(page.locator('#chat-compact')).toBeEnabled();
  await page.locator('#chat-compact').click();
  await expect(page.locator('.notice-line', { hasText: 'context compacted' })).toBeVisible();
  await expect(page.locator('.msg--user', { hasText: 'real context control old words' })).toHaveCount(1);
  const oldPointer = JSON.parse(readFileSync(pointerFile, 'utf-8')) as {
    sessionFile: string;
    epoch: number;
  };
  const oldBytes = readFileSync(oldPointer.sessionFile);

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#chat-new').click();
  await expect(page.locator('.msg--user', { hasText: 'real context control old words' })).toHaveCount(0);
  const freshPointer = JSON.parse(readFileSync(pointerFile, 'utf-8')) as {
    sessionFile: string;
    epoch: number;
  };
  expect(freshPointer.epoch).toBe(oldPointer.epoch + 1);
  expect(freshPointer.sessionFile).not.toBe(oldPointer.sessionFile);
  expect(readFileSync(oldPointer.sessionFile)).toEqual(oldBytes);

  await page.reload();
  await expect(page.locator('.msg--user', { hasText: 'real context control old words' })).toHaveCount(0);
  await sendAndWaitReply(page, 'first real words in fresh epoch');
  const invocation = lastAgentPrompt();
  expect(invocation?.argv).toContain('--session-id');
  expect(invocation?.argv).not.toContain('--resume');
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
    nodeImport: JEV_PRELOAD,
    extraEnv: { JEV_FETCH_LOG, JEV_FETCH_MODE_FILE: JEV_MODE_FILE },
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

test('Settings recheck shows real degraded → recovered Jev state and resolved incident semantics', async ({ page }) => {
  const configFile = join(durableHome, 'config.toml');
  writeFileSync(configFile, '[decisions.jev]\nenabled = true\n', 'utf8');
  try {
    await pair(page);
    await page.locator('#settings-toggle').click();
    await expect(page.locator('#settings-view')).toBeVisible();
    await expect(page.locator('#decisions-stamp')).toHaveText('READY');
    await expect(page.locator('#decisions-meta')).toContainText('file credential');

    writeFileSync(JEV_MODE_FILE, 'network-error', 'utf8');
    await page.locator('#decisions-recheck').click();
    await expect(page.locator('#decisions-stamp')).toHaveText('FALLBACK');
    await expect(page.locator('#decisions-summary')).toContainText('Deterministic fallback');

    writeFileSync(JEV_MODE_FILE, 'success', 'utf8');
    await page.locator('#decisions-recheck').click();
    await expect(page.locator('#decisions-stamp')).toHaveText('READY');
    await expect(page.locator('#decisions-recheck')).toBeEnabled();

    await page.locator('#notification-bell').click();
    const incident = page.locator('.board-notification', { hasText: 'Jev degraded' }).first();
    await expect(incident).toContainText('resolved');
    await expect(incident.locator('.board-notification__ack')).toHaveCount(0);
  } finally {
    writeFileSync(configFile, '[decisions.jev]\nenabled = false\n', 'utf8');
    await expect.poll(async () => {
      const response = await page.request.get(`http://127.0.0.1:${REAL_PORT}/api/decisions/status`, {
        headers: { authorization: `Bearer ${REAL_TOKEN}` },
      });
      return (await response.json()).status;
    }).toBe('disabled');
  }
});

test('missing-key enabled startup is durable degraded: a browser connected AFTER startup sees the actionable notice', async ({ page }) => {
  const port = await pickFreePort();
  const token = 'e2e-missing-key-token';
  // Enabled config with NO credential anywhere; OPENROUTER_API_KEY is
  // scrubbed from the child environment by the boot helper.
  const service = await startRealService({
    port,
    token,
    decisionsEnabled: true,
    nodeImport: JEV_PRELOAD,
    extraEnv: { JEV_FETCH_LOG, JEV_FETCH_MODE_FILE: JEV_MODE_FILE },
  });
  try {
    await page.goto(`http://127.0.0.1:${port}`);
    await expect(page.locator('#pairing-view')).toBeVisible();
    await page.locator('#pair-token').fill(token);
    await page.locator('#pair-submit').click();
    await expect(page.locator('#chat-view')).toBeVisible();
    // The Settings card shows the honest degraded state, never a ready badge.
    await page.locator('#settings-toggle').click();
    await expect(page.locator('#decisions-stamp')).toHaveText('FALLBACK');
    await expect(page.locator('#decisions-summary')).toContainText('credential');
    // And the durable incident is on the authenticated BOARD surface for a
    // browser that connected after startup (no CLI-only error, no phantom
    // receipt). The panel lives inside #board-view — open the Board tab.
    await page.locator('#tab-board').click();
    await page.locator('#notification-bell').click();
    await expect(page.locator('.board-notification', { hasText: 'Jev degraded' }).first()).toBeVisible();
    await expect(page.locator('.board-notification', { hasText: 'Jev degraded' }).first().locator('.board-notification__ack')).toBeVisible();
  } finally {
    await service.stop();
  }
});

// ---------------------------------------------------------------------------
// The ONE attach flow (SPEC ruling 19) — FULL-GESTURE proof. The briefing
// rule: a UI flow that is green in the suite but dead in a real hand is
// the failure mode this lane must not repeat. Each leg performs the WHOLE
// gesture in a real browser against the real service: press attach →
// pick real material → chip appears → send → the AGENT receives a PATH
// (verified on the agent side via the double's prompt log, not just the
// UI). The on-disk leg carries the fails-pre-fix discriminator: a
// byte-copying implementation would land the file in uploads/ — it MUST
// stay empty.
// ---------------------------------------------------------------------------

test.describe('attach flow (SPEC ruling 19) — full gesture', () => {
  test('on-disk pick: attach → browse → pick a real file → chip → send → agent receives the PATH; uploads dir stays EMPTY (no byte copy)', async ({ page }) => {
    // Real material in the service's real workspace, on disk.
    mkdirSync(join(durableWorkspace, 'plans'), { recursive: true });
    const wsFile = join(durableWorkspace, 'plans', 'heist-plan.md');
    writeFileSync(wsFile, '# the plan\nsteal the moon\n', 'utf-8');
    // Browse resolves REALPATHS (containment) — macOS /var → /private/var.
    const realWsFile = realpathSync(wsFile);

    await pair(page);
    await page.locator('#chat-attach').click();
    await expect(page.locator('#attach-picker')).toBeVisible();
    await expect(page.locator('#attach-picker-path')).toHaveText('/'); // workspace root

    // FULL GESTURE: navigate into plans/, pick the real file.
    await page.locator('.attach-row--dir', { hasText: 'plans' }).click();
    const pick = page.locator('.attach-row--file', { hasText: 'heist-plan.md' });
    await expect(pick).toBeVisible();
    await pick.click();

    // The chip is ready-to-send.
    const chip = page.locator('#chat-chips .attach-chip', { hasText: 'heist-plan.md' });
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('title', realWsFile);

    await page.locator('#chat-input').fill('read the plan');
    await page.locator('#chat-send').click();

    // Own bubble carries the chip; the reply echoes the delivered prompt.
    await expect(page.locator('.msg--user .attach-chip', { hasText: 'heist-plan.md' })).toBeVisible();
    await expect(page.locator('.msg--gru', { hasText: realWsFile })).toBeVisible();

    // AGENT-SIDE receipt (not just UI): the double's prompt log carries
    // the manifest with the absolute workspace path…
    const agentPrompt = lastAgentPrompt();
    expect(agentPrompt?.prompt).toContain('[attached files — read them yourself at these paths]');
    expect(agentPrompt?.prompt).toContain(realWsFile);
    // …and NO image bytes were ever attached through the runtime.
    expect(agentPrompt?.images ?? -1).toBe(0);

    // FAILS-PRE-FIX DISCRIMINATOR (no byte copy): an implementation that
    // copied bytes would materialize the pick into uploads/ — it must
    // hold NOTHING for an on-disk attach.
    expect(readdirSync(join(durableHome, 'uploads'))).toEqual([]);
  });

  test('B2 fails-pre-fix discriminator — PHONE full gesture: attach → device button → chooser → chip → send → agent receives THAT path', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await pairMobile(page);
    await page.locator('#chat-bubble').click();
    await page.locator('#chat-attach').click();
    await expect(page.locator('#attach-picker')).toBeVisible();

    // FULL PHONE ENTRY GESTURE: the visible device button must open the
    // chooser. Deleting its listener makes this promise time out and the
    // named B2 discriminator RED; driving the hidden input directly would
    // be the dock-drag-drop false green this lane exists to prevent.
    const chooserHandled = new Promise<void>((resolve, reject) => {
      const onChooser = (chooser: FileChooser): void => {
        page.off('filechooser', onChooser);
        void chooser
          .setFiles({
            name: 'camera-roll.png',
            mimeType: 'image/png',
            buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
          })
          .then(
            () => {
              clearTimeout(timer);
              resolve();
            },
            (error: unknown) => {
              clearTimeout(timer);
              reject(error instanceof Error ? error : new Error(String(error)));
            },
          );
      };
      const timer = setTimeout(() => {
        page.off('filechooser', onChooser);
        reject(new Error('device button did not open a file chooser'));
      }, 5_000);
      page.on('filechooser', onChooser);
    });
    await page.locator('#attach-picker-device').click();
    await chooserHandled;

    const chip = page.locator('#chat-chips .attach-chip', { hasText: 'camera-roll.png' });
    await expect(chip).toBeVisible();

    await page.locator('#chat-input').fill('what did I just shoot');
    await page.locator('#chat-send').click();
    await expect(page.locator('.msg--user .attach-chip', { hasText: 'camera-roll.png' })).toBeVisible();

    // The file EXISTS under the instance uploads dir (materialized).
    const uploadsDir = join(durableHome, 'uploads');
    const stored = readdirSync(uploadsDir).filter((name) => name.endsWith('camera-roll.png'));
    expect(stored).toHaveLength(1);
    const storedPath = join(uploadsDir, stored[0]!);

    // The sent path points AT it — the agent received THAT path.
    await expect(page.locator('.msg--gru', { hasText: storedPath })).toBeVisible();
    const agentPrompt = lastAgentPrompt();
    expect(agentPrompt?.prompt).toContain(storedPath);
    expect(agentPrompt?.prompt).toContain('(image)');
    expect(agentPrompt?.images ?? -1).toBe(0); // paths only, never bytes
    // Vision-capable runtime (claude declares images): no decline notice.
    await expect(page.locator('.notice-line', { hasText: 'Vision is unavailable' })).toHaveCount(0);
  });

  test('clipboard paste (Mac-screenshot class): paste bytes into the composer → materialized → chip → send', async ({ page }) => {
    await pair(page);
    await page.locator('#chat-input').click();
    await page.evaluate(() => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9]);
      const file = new File([bytes], 'paste-shot.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      document
        .getElementById('chat-input')!
        .dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
        );
    });
    const chip = page.locator('#chat-chips .attach-chip', { hasText: 'paste-shot.png' });
    await expect(chip).toBeVisible();

    // Attachment-only send: no typed words needed (empty text + chips).
    await page.locator('#chat-send').click();
    const uploadsDir = join(durableHome, 'uploads');
    const stored = readdirSync(uploadsDir).filter((name) => name.endsWith('paste-shot.png'));
    expect(stored).toHaveLength(1);
    await expect(
      page.locator('.msg--gru', { hasText: join(uploadsDir, stored[0]!) }),
    ).toBeVisible();
  });

  test('chips replay with history after reload (the durable log carries them)', async ({ page }) => {
    // Self-contained (review r1): no coupling to the earlier legs — this
    // test mints its own chip, reloads, and expects it back.
    mkdirSync(join(durableWorkspace, 'replay'), { recursive: true });
    writeFileSync(join(durableWorkspace, 'replay', 'replay-note.md'), 'replay me\n', 'utf-8');
    await pair(page);
    await page.locator('#chat-attach').click();
    await page.locator('.attach-row--dir', { hasText: 'replay' }).click();
    await page.locator('.attach-row--file', { hasText: 'replay-note.md' }).click();
    await expect(
      page.locator('#chat-chips .attach-chip', { hasText: 'replay-note.md' }),
    ).toBeVisible();
    await page.locator('#chat-input').fill('keep this chip');
    await page.locator('#chat-send').click();
    await expect(
      page.locator('.msg--user .attach-chip', { hasText: 'replay-note.md' }),
    ).toBeVisible();

    await page.reload();
    await expect(page.locator('#chat-view')).toBeVisible();
    // The chip replays on its user bubble from the durable frame log.
    // (History also legitimately carries earlier legs' chips — the
    // shared serial frame log — so no count assertions on those.)
    await expect(
      page.locator('.msg--user .attach-chip', { hasText: 'replay-note.md' }),
    ).toBeVisible();
  });
});
