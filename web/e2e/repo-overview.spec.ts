import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import {
  isValidSnapshot,
  parseBoardServerFrame,
  type AgentView,
  type BoardSnapshot,
  type RepoOverviewView,
} from '../src/lib/board-protocol.js';

/**
 * Managed repository overview — browser evidence (owner-approved compact
 * rows A), synthetic WebSocket-seeded snapshots only: the production
 * validator/parser must accept every fixture, and the dev mock's default
 * board is never modified. Captures land under the gitignored lane root
 * and are inspected against the approved mockup (row rhythm, badge text +
 * glyph, module below the crew list, light/dark, desktop/narrow).
 *
 * No real GitHub connection is made or clicked: links are asserted as
 * attributes (`https`, `target=_blank`, `rel=noopener`) and never
 * followed; no board control is clicked beyond the CREW/TRANSCRIPTS tab.
 */

const MOCK_TOKEN = process.env.GRU_MOCK_TOKEN ?? 'dev-token';

const CAPTURE_DIR = path.join(
  import.meta.dirname,
  '..',
  '..',
  '_bmad-output',
  'managed-repo-overview',
  'captures',
);

/** A fresh capture run starts empty (stale images must never survive as
 * apparent current-head evidence); removal failures still throw. */
test.beforeAll(() => {
  fs.rmSync(CAPTURE_DIR, { recursive: true, force: true });
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
});

function agent(id: string, role: string, state: string): AgentView {
  return {
    id,
    role,
    label: id,
    state,
    lastActivity: '2026-10-07T11:58:00.000Z',
    sessionFile: `/sessions/${id}.jsonl`,
    jobId: null,
    roundId: null,
    supervision: null,
  };
}

function overview(): RepoOverviewView {
  const now = Date.now();
  const at = (minutesAgo: number): string => new Date(now - minutesAgo * 60_000).toISOString();
  const run = (over: Record<string, unknown>): RepoOverviewView['rows'][number]['run'] =>
    ({
      state: 'passed',
      status: 'completed',
      conclusion: 'success',
      workflow: 'checks',
      branch: 'main',
      runNumber: 41,
      url: 'https://github.com/example/demo/actions/runs/41',
      runStartedAt: at(6),
      runUpdatedAt: at(1),
      ...over,
    }) as RepoOverviewView['rows'][number]['run'];
  const row = (over: Partial<RepoOverviewView['rows'][number]>): RepoOverviewView['rows'][number] => ({
    key: 'demo',
    displayName: 'demo',
    linked: true,
    link: 'https://github.com/example/demo',
    linkReason: null,
    fullName: 'example/demo',
    openPrs: 0,
    openIssues: 0,
    run: run({}),
    freshness: 'fresh',
    checkedAt: at(2),
    lastAttemptAt: at(2),
    error: null,
    ...over,
  });
  return {
    rows: [
      row({ key: 'demo-command', displayName: 'demo-command', openPrs: 2, openIssues: 3, run: run({ state: 'running', status: 'in_progress', conclusion: null }) }),
      row({ key: 'demo-tenant', displayName: 'demo-tenant', openPrs: 0, openIssues: 1, run: run({ state: 'failed', conclusion: 'failure' }) }),
      row({ key: 'demo-studio', displayName: 'demo-studio', openPrs: 4, openIssues: 0 }),
      row({ key: 'demo-forge', displayName: 'demo-forge', openPrs: 1, openIssues: 0, run: run({ state: 'queued', status: 'queued', conclusion: null }) }),
      row({
        key: 'demo-archive',
        displayName: 'demo-archive',
        openPrs: 1,
        openIssues: 5,
        freshness: 'stale',
        checkedAt: at(120),
        lastAttemptAt: at(9),
        error: 'GitHub rate limit (HTTP 403: API rate limit exceeded)',
      }),
      row({ key: 'demo-ledger', displayName: 'demo-ledger', openPrs: 0, openIssues: 2, run: run({ state: 'unknown', conclusion: null }) }),
      row({
        key: 'demo-vault',
        displayName: 'demo-vault',
        openPrs: null,
        openIssues: null,
        run: null,
        freshness: 'unavailable',
        checkedAt: null,
        error: 'HTTP 403: Resource not accessible by personal access token',
      }),
      row({ key: 'demo-scripts', displayName: 'demo-scripts', openPrs: 3, openIssues: 1, run: run({ state: 'cancelled', conclusion: 'cancelled' }) }),
      row({ key: 'demo-sandbox', displayName: 'demo-sandbox', openPrs: 0, openIssues: 2, run: run({ state: 'no-workflow', workflow: null, url: null }) }),
      row({ key: 'demo-lab', displayName: 'demo-lab', linked: false, link: null, linkReason: 'non-GitHub remote', fullName: null, openPrs: null, openIssues: null, run: null, freshness: 'unchecked', checkedAt: null, lastAttemptAt: null }),
      row({ key: 'demo-lab-2', displayName: 'demo-lab-2', linked: false, link: null, linkReason: 'no usable origin remote', fullName: null, openPrs: null, openIssues: null, run: null, freshness: 'unchecked', checkedAt: null, lastAttemptAt: null }),
      row({
        key: 'demo-long-name-with-an-unbreakable-token-abcdefghijklmnopqrstuvwxyz-0123456789',
        displayName: 'demo-long-name-with-an-unbreakable-token-abcdefghijklmnopqrstuvwxyz-0123456789',
        openPrs: 1287,
        openIssues: 340,
        run: run({ workflow: 'nightly-release-verification-and-cross-platform-packaging', url: 'https://github.com/example/demo-long/actions/runs/777' }),
      }),
      row({ key: 'demo-never-run', displayName: 'demo-never-run', openPrs: 0, openIssues: 0, run: run({ state: 'never-run', workflow: null, url: null }) }),
    ],
  };
}

function seededSnapshot(): BoardSnapshot {
  const agents = [
    agent('mock-gru', 'gru', 'idle'),
    agent('mock-silas', 'silas', 'idle'),
    agent('mock-perkins', 'perkins', 'idle'),
    agent('mock-bob', 'bob', 'idle'),
    ...Array.from({ length: 8 }, (_, index) => agent(`mock-minion-${index}`, 'minion', index === 0 ? 'streaming' : 'idle')),
  ];
  return {
    repos: [{ name: 'demo', jobs: [] }],
    agents,
    notifications: [],
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: 'disabled',
      model: '~typesafe/jev-latest',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'repo-overview-proof',
      generation: 0,
    },
    unackedActionRequired: 0,
    unackedNeedsOwner: 0,
    wakes: { count: 0, lastAt: null },
    repoOverview: overview(),
  };
}

async function seedBoard(page: Page): Promise<{ push: (snapshot: BoardSnapshot) => void }> {
  const snapshot = seededSnapshot();
  if (!isValidSnapshot(snapshot)) throw new Error('fixture snapshot fails the production isValidSnapshot validator');
  const frame = parseBoardServerFrame({ type: 'board', snapshot });
  if (frame === null || frame.type !== 'board') throw new Error('fixture board frame fails the production parser');
  let current = snapshot;
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
    push(next: BoardSnapshot) {
      if (!isValidSnapshot(next)) throw new Error('pushed snapshot fails the production validator');
      current = next;
      for (const ws of sockets) ws.send(JSON.stringify({ type: 'board', snapshot: next }));
    },
  };
}

async function pairAndSeed(page: Page): Promise<{ push: (snapshot: BoardSnapshot) => void }> {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  const seed = await seedBoard(page);
  await page.goto('/');
  await expect(page.locator('#pairing-view')).toBeVisible();
  await page.locator('#pair-token').fill(MOCK_TOKEN);
  await page.locator('#pair-submit').click();
  await expect(page.locator('#board-view')).toBeVisible();
  await expect(page.locator('#board-repos .repo-row')).toHaveCount(13);
  // Read-only surface: nothing here ever talks to GitHub from the browser,
  // and the seed never issues a mutating API call.
  const github = requests.filter((url) => /github\.com/u.test(url));
  expect(github, `unexpected GitHub requests: ${github.join(', ')}`).toEqual([]);
  return seed;
}

/** No element may create a horizontal scrollbar at any tested width. */
async function assertNoHorizontalOverflow(page: Page, selectors: readonly string[]): Promise<void> {
  const result = await page.evaluate((list) => {
    const bad: string[] = [];
    for (const selector of list) {
      const node = document.querySelector(selector);
      if (node === null) {
        bad.push(`${selector}: missing`);
        continue;
      }
      if (node.scrollWidth > node.clientWidth + 1) bad.push(`${selector}: ${node.scrollWidth}>${node.clientWidth}`);
    }
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) {
      bad.push('document: overflow');
    }
    return bad;
  }, selectors);
  expect(result).toEqual([]);
}

const STATES = [
  'RUNNING',
  'FAILED',
  'PASSED',
  'QUEUED',
  'STALE · last passed',
  'UNKNOWN',
  'UNAVAILABLE',
  'CANCELLED',
  'NO WORKFLOW',
  'NOT LINKED',
  'NOT LINKED',
  'PASSED',
  'NO RUNS',
] as const;

test('compact rows: states, exact counts, safe links, light/dark desktop and narrow', async ({ page }) => {
  await pairAndSeed(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const rail = page.locator('#agents-rail');

  // The approved status vocabulary, in stable registry order; every badge
  // carries text (and a glyph), so colour is never the only cue.
  const badges = await page.locator('#board-repos .repo-row__badge-text').allTextContents();
  expect(badges).toEqual([...STATES]);
  const glyphs = await page.locator('#board-repos .repo-row__badge-glyph').allTextContents();
  expect(glyphs.slice(0, 9)).toEqual(['↻', '✕', '✓', '⋯', '⌛', '?', '!', '⊘', '∅']);
  expect(glyphs.every((glyph) => glyph.trim() !== '')).toBe(true);

  // Tones actually render: the pp-chip--<tone> contract colours the chips,
  // and a done/alert/work chip must differ in computed background.
  const badgeBg = async (index: number): Promise<string> =>
    page
      .locator('#board-repos .repo-row')
      .nth(index)
      .locator('.repo-row__badge')
      .evaluate((node) => getComputedStyle(node).backgroundColor);
  const workBg = await badgeBg(0);
  const alertBg = await badgeBg(1);
  const doneBg = await badgeBg(2);
  expect(new Set([workBg, alertBg, doneBg]).size, `${workBg} / ${alertBg} / ${doneBg}`).toBe(3);
  expect(doneBg).not.toBe('rgba(0, 0, 0, 0)');

  // Exact counts, including a real zero and an unknown (never a fake 0).
  const heavy = page.locator('#board-repos .repo-row').nth(11);
  await expect(heavy.locator('.repo-row__metric-count').nth(0)).toHaveText('1287');
  await expect(heavy.locator('.repo-row__metric-count').nth(1)).toHaveText('340');
  await expect(page.locator('#board-repos .repo-row').nth(6).locator('.repo-row__metric-count').nth(0)).toHaveText('—');

  // Safe links only: https, new tab, noopener; hostile/absent URLs stay text.
  const linkState = await page.locator('#board-repos a').evaluateAll((nodes) =>
    nodes.map((node) => ({
      href: (node as HTMLAnchorElement).href,
      target: (node as HTMLAnchorElement).target,
      rel: (node as HTMLAnchorElement).rel,
    })),
  );
  expect(linkState.length).toBeGreaterThan(0);
  for (const link of linkState) {
    expect(link.href.startsWith('https://')).toBe(true);
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
  }
  // The unlinked rows render their name as text, not as a link.
  expect(await page.locator('#board-repos .repo-row').nth(9).locator('a.repo-row__name').count()).toBe(0);
  expect(await page.locator('#board-repos .repo-row').nth(9).locator('.repo-row__note').textContent()).toContain(
    'non-GitHub remote',
  );

  // Independent scroll regions: the crew list and the repository list each
  // bound and scroll on their own; the rail keeps its own overflow.
  const scrollState = await page.evaluate(() => {
    const crew = document.getElementById('board-agents') as HTMLElement;
    const list = document.querySelector('.repo-overview__list') as HTMLElement;
    return {
      crewOverflow: getComputedStyle(crew).overflowY,
      crewScrolls: crew.scrollHeight > crew.clientHeight,
      listOverflow: getComputedStyle(list).overflowY,
      listScrolls: list.scrollHeight > list.clientHeight,
    };
  });
  expect(scrollState.crewOverflow).toBe('auto');
  expect(scrollState.crewScrolls).toBe(true);
  expect(scrollState.listOverflow).toBe('auto');
  expect(scrollState.listScrolls).toBe(true);

  await assertNoHorizontalOverflow(page, ['#agents-rail', '#board-agents', '#board-repos', '.repo-overview__list']);

  // Keyboard: the repository link is reachable and focus is visible.
  await page.locator('#board-repos a.repo-row__name').first().focus();
  const focused = await page.evaluate(() => document.activeElement?.className ?? '');
  expect(focused).toContain('repo-row__name');

  for (const theme of ['light', 'dark'] as const) {
    if (theme === 'dark') await page.locator('#theme-toggle').click();
    if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
    else await expect(page.locator('html')).not.toHaveClass(/dark/);
    await page.evaluate(() => window.scrollTo(0, 0));
    await rail.screenshot({ path: path.join(CAPTURE_DIR, `overview-${theme}-desktop.png`) });
    await page.screenshot({ path: path.join(CAPTURE_DIR, `overview-${theme}-desktop-full.png`) });
  }

  // Narrow width (phone): the rail stacks below the board; the module must
  // stay inside the column with no horizontal overflow.
  if (await page.locator('html').evaluate((node) => node.classList.contains('dark'))) {
    await page.locator('#theme-toggle').click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#board-repos .repo-row')).toHaveCount(13);
  // Close the mobile chat sheet if pairing opened it: the capture must show
  // the module, not an overlay (closing the sheet is a local UI toggle).
  if ((await page.locator('#chat-sheet').getAttribute('data-open')) === 'true') {
    await page.locator('#chat-sheet-grip').click();
    await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'false');
  }
  await assertNoHorizontalOverflow(page, ['#board-repos', '.repo-overview__list']);
  // Phone-layout fixed overlays (chat sheet/FAB) can sit over the module in
  // an element capture; suppress them for the CAPTURE ONLY (no product code
  // or layout is changed — the overflow assertions above ran against the
  // real composited layout).
  await page.addStyleTag({
    content: '#chat-sheet, .chat-sheet, .chat-scrim, .gru-fab { display: none !important; }',
  });
  await page.locator('#board-repos').screenshot({ path: path.join(CAPTURE_DIR, 'overview-light-narrow.png') });
  await page.locator('#theme-toggle').click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await assertNoHorizontalOverflow(page, ['#board-repos', '.repo-overview__list']);
  await page.locator('#board-repos').screenshot({ path: path.join(CAPTURE_DIR, 'overview-dark-narrow.png') });
});

test('the overview follows the CREW tab and never leaks into TRANSCRIPTS', async ({ page }) => {
  await pairAndSeed(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const repos = page.locator('#board-repos');
  await expect(repos).toBeVisible();
  // The module is part of the CREW tab's accessibility contract, exactly
  // like the crew panel it sits under.
  await expect(page.locator('#rail-tab-agents')).toHaveAttribute('aria-controls', 'board-agents board-repos');
  await expect(repos).toHaveAttribute('role', 'tabpanel');
  await expect(repos).toHaveAttribute('aria-labelledby', 'rail-tab-agents');
  await page.locator('#rail-tab-transcripts').click();
  await expect(repos).toBeHidden();
  await expect(page.locator('#board-transcripts')).toBeVisible();
  await page.locator('#rail-tab-agents').click();
  await expect(repos).toBeVisible();
  await expect(page.locator('#board-agents')).toBeVisible();
});

test('a live push replaces the overview rows without duplicating them', async ({ page }) => {
  const seed = await pairAndSeed(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('#board-repos .repo-row')).toHaveCount(13);
  const reduced: BoardSnapshot = { ...seededSnapshot(), repoOverview: { rows: overview().rows.slice(0, 2) } };
  seed.push(reduced);
  await expect(page.locator('#board-repos .repo-row')).toHaveCount(2);
  await expect(page.locator('#board-repos .repo-row__badge-text')).toHaveText(['RUNNING', 'FAILED']);
});
