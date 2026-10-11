import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import {
  isValidSnapshot,
  parseBoardServerFrame,
  type BoardSnapshot,
  type JobView,
  type NotificationView,
  type OwnerPrView,
} from '../src/lib/board-protocol.js';

/**
 * Notification readability + owner-decision browser regressions (owner
 * release 2026-10-11). Synthetic WebSocket-seeded snapshots only: no
 * product/mock/fixture code is touched, and no real owner notification is
 * ever acknowledged. The fixed long-content fixture carries a long title,
 * paragraphs, unbroken job ids, a 40-character SHA, a UUID and a long
 * path; every measurable claim (no overflow, measured contrast, no
 * side-effect requests, keyboard/disclosure behavior) is asserted, and
 * light/dark/narrow/zoom captures are written for direct inspection.
 *
 * This spec is authored by the build worker; scheduling belongs to the
 * declared `notification-readability` [verify] scope.
 */

const MOCK_TOKEN = process.env.GRU_MOCK_TOKEN ?? 'dev-token';
const CAPTURE_BASE = path.join(import.meta.dirname, '..', '..', '_bmad-output', 'notification-readability');
const CAPTURE_ENV_ROOT = process.env.NOTIFICATION_READABILITY_CAPTURE_ROOT;
const ATTEMPT_ROOT =
  CAPTURE_ENV_ROOT !== undefined && CAPTURE_ENV_ROOT.trim() !== ''
    ? path.resolve(CAPTURE_ENV_ROOT.trim())
    : path.join(CAPTURE_BASE, 'attempts', `${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`);
const MANIFEST_PATH = path.join(ATTEMPT_ROOT, 'capture-manifest.json');
console.log(`[notification-readability] capture root: ${ATTEMPT_ROOT}`);

interface CaptureRecord {
  readonly file: string;
  readonly test: string;
  readonly viewport: string;
  readonly theme: string;
  readonly state: string;
  readonly bytes: number;
  readonly sha256: string;
}
const captureRecords: CaptureRecord[] = [];

function writeCaptureManifest(): void {
  fs.mkdirSync(ATTEMPT_ROOT, { recursive: true });
  fs.writeFileSync(
    MANIFEST_PATH,
    `${JSON.stringify(
      {
        attemptRoot: ATTEMPT_ROOT,
        note: 'viewport captures of the fixed long-content notification fixtures, per theme/width/zoom.',
        captures: captureRecords,
      },
      null,
      2,
    )}\n`,
  );
}

function testSlug(): string {
  const titlePath = test.info().titlePath.join(' > ');
  const base = titlePath.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48);
  return `${base}-${createHash('sha1').update(titlePath).digest('hex').slice(0, 8)}`;
}

async function captureViewport(page: Page, name: string, state: string): Promise<void> {
  fs.mkdirSync(ATTEMPT_ROOT, { recursive: true });
  const file = path.join(ATTEMPT_ROOT, `${testSlug()}-${name}.png`);
  if (fs.existsSync(file)) throw new Error(`capture already exists — refusing to overwrite: ${file}`);
  await page.screenshot({ path: file, fullPage: false });
  const runtime = await page.evaluate(() => ({
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  }));
  captureRecords.push({
    file: path.relative(ATTEMPT_ROOT, file),
    test: test.info().title,
    viewport: runtime.viewport,
    theme: runtime.theme,
    state,
    bytes: fs.statSync(file).size,
    sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  });
  writeCaptureManifest();
}

const T0 = '2026-10-11T00:00:00.000Z';
const LONG_SHA = 'a40e6a963f8c2b1d4e5f60718293a4b5c6d7e8f9';
const LONG_UUID = '2bbd77ac-9851-3b7e-480c-ef21963caf54';
const LONG_PATH = '/Users/example/.gru-command/captures/ops-sweep-20261009T000000Z/reconcile/PR285-interrupted-original-capture-provenance/manifest.json';

const LONG_DIAGNOSTIC =
  `Decisions for job job-1234567890abcdef are blocked: the frozen head ${LONG_SHA} no longer ` +
  `matches the recorded branch state (capture ${LONG_UUID}), and the reconciliation manifest at ` +
  `${LONG_PATH} is missing. ` +
  'No replay, new directive or false restart was attempted; the lane stays stopped until the cause is ' +
  'addressed. The prior attempt aborted after a websocket close1000 and the second completed with warnings.';

/** A long mixed-case mixed-token decision (owner escalation-style). */
function decisionNotification(): NotificationView {
  return {
    id: 'decision-1',
    ts: T0,
    kind: 'gru.owner-escalation',
    routing: 'needs-owner',
    severity: 'info',
    title: 'PR256 resumption requested: interrupted ownership and main integration still block it',
    detail: `${LONG_DIAGNOSTIC}\n\nEvidence: ${LONG_PATH}`,
    agentId: null,
    shownAt: null,
    ackedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    decision: {
      question: 'Approve the slim contract and re-commission the dashboard slim strip lane?',
      context:
        'PR256 is still blocked on interrupted ownership and a conflicting main. The original slim contract remains the agreed scope; nothing has been re-armed since the freeze.',
      recommendation: 'Approve the slim contract; keep PR257 and the external core-recovery repair separate.',
      reservedClass: 'scope-design',
      whyNotDelegable: 'It changes the agreed scope of an owner-visible heist, which Silas and Gru cannot renegotiate on their own.',
      options: [
        {
          id: 'approve',
          label: 'Approve the slim contract',
          consequence: 'Gru re-arms the existing lane inside the original slim contract and reports the outcome.',
        },
        {
          id: 'keep',
          label: 'Keep the current approach',
          consequence: 'The lane stays parked; no worker is re-armed and no merge is prepared.',
        },
      ],
      discussion: false,
    },
    decidedAt: null,
    decidedBy: null,
    decidedOption: null,
  };
}

function machineNotification(): NotificationView {
  return {
    id: 'machine-1',
    ts: T0,
    kind: 'supervision.provider-wall.agent-1.authentication_wall',
    routing: 'action-required',
    severity: 'error',
    title: 'PR285: reconcile restart-interrupted R1 fix and queued continuation before any re-arm',
    detail: LONG_DIAGNOSTIC,
    agentId: null,
    shownAt: null,
    ackedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    decision: null,
    decidedAt: null,
    decidedBy: null,
    decidedOption: null,
  };
}

function feedNotification(): NotificationView {
  return {
    id: 'feed-1',
    ts: T0,
    kind: 'supervision.hang',
    routing: 'fyi',
    severity: 'info',
    title: 'Agent agent-1: turn hang',
    detail: `Restart ladder engaged; evidence at ${LONG_PATH}.`,
    agentId: null,
    shownAt: null,
    ackedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    decision: null,
    decidedAt: null,
    decidedBy: null,
    decidedOption: null,
  };
}

function job(id: string, status: string, title: string): JobView {
  return {
    id,
    repo: 'notification-proof',
    title,
    status,
    updatedAt: T0,
    prUrl: null,
    prState: null,
    baseBranch: 'main',
    note: null,
    rounds: [],
    lane: status === 'blocked' ? null : { branch: `gru/${id}`, sha: 'abc1234def5678', status: 'active', createdAt: T0 },
    lastAgentActivity: null,
  };
}

/** Long receipts across the surfaces: a live FOR YOU decision, a machine
 * error notice, a resolved feed row and a terminal-bound closed receipt. */
function fixtureSnapshot(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  const closedMachine: NotificationView = {
    ...machineNotification(),
    id: 'machine-closed',
    title: 'Closed machine receipt — long diagnostics kept for the record',
    agentId: 'minion-closed',
  };
  const resolvedFeed: NotificationView = {
    ...feedNotification(),
    id: 'feed-resolved',
    resolvedAt: '2026-10-11T00:05:00.000Z',
    resolvedBy: 'runtime',
  };
  return {
    repos: [
      {
        name: 'notification-proof',
        jobs: [job('job-closed', 'merged', 'Concluded heist with a closed receipt notification')],
      },
    ],
    agents: [
      {
        id: 'minion-closed',
        role: 'minion',
        label: null,
        state: 'idle',
        lastActivity: T0,
        sessionFile: null,
        jobId: 'job-closed',
        roundId: null,
        supervision: { state: 'stopped', restarts: 0, breakerOpen: false, stopReason: null, stoppedAt: null },
      },
    ],
    notifications: [decisionNotification(), machineNotification(), resolvedFeed, closedMachine],
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: 'disabled',
      model: '~typesafe/jev-latest',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'notification-proof-incarnation',
      generation: 0,
    },
    unackedActionRequired: 0,
    unackedNeedsOwner: 1,
    wakes: { count: 0, lastAt: null },
    ownerPrs: [],
    ...overrides,
  };
}

interface Seed {
  readonly pageErrors: Error[];
  push(snapshot: BoardSnapshot): void;
}

async function seedBoard(page: Page, initial: BoardSnapshot): Promise<Seed> {
  if (!isValidSnapshot(initial)) throw new Error('fixture snapshot fails the production isValidSnapshot validator');
  const frame = parseBoardServerFrame({ type: 'board', snapshot: initial });
  if (frame === null || frame.type !== 'board') throw new Error('fixture board frame fails the production parser');
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  let current = initial;
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
    pageErrors,
    push(snapshot: BoardSnapshot) {
      if (!isValidSnapshot(snapshot)) throw new Error('pushed snapshot fails the production validator');
      current = snapshot;
      for (const ws of sockets) ws.send(JSON.stringify({ type: 'board', snapshot }));
    },
  };
}

async function pairAndOpenBoard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#pairing-view')).toBeVisible();
  await page.locator('#pair-token').fill(MOCK_TOKEN);
  await page.locator('#pair-submit').click();
  await expect(page.locator('#board-view')).toBeVisible();
}

async function settled(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/** Any horizontal overflow inside the element (card or panel). */
async function overflows(page: Page, selector: string): Promise<{ scrollWidth: number; clientWidth: number }> {
  return page.evaluate((sel) => {
    const element = document.querySelector<HTMLElement>(sel);
    if (element === null) return { scrollWidth: -1, clientWidth: -1 };
    return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
  }, selector);
}

async function bodyOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Measured settled contrast of an element's text against its actual
 * painted surface (opaque backgrounds walked up the ancestor chain). */
async function contrastOf(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const element = document.querySelector<HTMLElement>(sel);
    if (element === null) throw new Error(`missing ${sel}`);
    const parse = (value: string): [number, number, number, number] => {
      const match = /rgba?\(([^)]+)\)/u.exec(value);
      if (match === null) throw new Error(`unparseable color ${value}`);
      const parts = match[1]!.split(',').map((part) => Number.parseFloat(part.trim()));
      return [parts[0]!, parts[1]!, parts[2]!, parts.length > 3 ? parts[3]! : 1];
    };
    const linear = (channel: number): number => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luminance = ([r, g, b]: readonly [number, number, number]): number =>
      0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    const style = getComputedStyle(element);
    const [fr, fg, fb] = parse(style.color);
    let node: HTMLElement | null = element;
    let bg: readonly [number, number, number] = [255, 255, 255];
    while (node !== null) {
      const [r, g, b, a] = parse(getComputedStyle(node).backgroundColor);
      if (a > 0.99) {
        bg = [r, g, b];
        break;
      }
      node = node.parentElement;
    }
    const [lighter, darker] = [luminance([fr, fg, fb]), luminance(bg)].sort((left, right) => right - left);
    return (lighter! + 0.05) / (darker! + 0.05);
  }, selector);
}

async function clickBell(page: Page): Promise<void> {
  const bell = page.locator('#notification-bell');
  await bell.click();
  await expect(page.locator('#notification-panel')).toBeVisible();
}

test.describe('notification readability — fixed long-content fixtures', () => {
  test('desktop 1280 light and dark: the default face is readable and the full evidence sits behind Details', async ({ browser }) => {
    for (const theme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      try {
        const seed = await seedBoard(page, fixtureSnapshot());
        await pairAndOpenBoard(page);
        if (theme === 'dark') {
          await page.locator('#theme-toggle').click();
          await expect(page.locator('html')).toHaveClass(/dark/);
        }
        await settled(page);
        expect(seed.pageErrors).toEqual([]);

        // The decision card: mixed-case title, short metadata label, typed
        // question + recommendation, and Details holding the full evidence.
        const card = page.locator('#board-owner [data-notification-id="decision-1"]');
        await expect(card).toBeVisible();
        await expect(card.locator('.board-notification__title')).toHaveText(
          'PR256 resumption requested: interrupted ownership and main integration still block it',
        );
        await expect(card.locator('.board-notification__question')).toHaveText(
          'Approve the slim contract and re-commission the dashboard slim strip lane?',
        );
        await expect(card.locator('.board-notification__recommendation')).toContainText('Gru recommends');
        // The meta label is separate from the prose (timestamp · channel)
        // and never carries the diagnostic text.
        await expect(card.locator('.board-notification__meta')).toHaveText(/· FOR YOU$/u);
        await expect(card.locator('.board-notification__meta')).not.toContainText('dispatched');
        const titleTransform = await card
          .locator('.board-notification__title')
          .evaluate((element) => getComputedStyle(element).textTransform);
        expect(titleTransform).toBe('none');
        // Full evidence intact inside Details.
        const details = card.locator('.board-notification__details');
        expect(await details.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
        await details.locator('summary').click();
        await expect(details.locator('.board-notification__detail-text')).toContainText(LONG_SHA);
        await expect(details.locator('.board-notification__detail-text')).toContainText(LONG_UUID);
        await expect(details.locator('.board-notification__detail-text')).toContainText(LONG_PATH);

        // No horizontal overflow inside the card or the panel container.
        await settled(page);
        const decisionOverflow = await overflows(page, '#board-owner [data-notification-id="decision-1"]');
        expect(decisionOverflow.scrollWidth).toBeLessThanOrEqual(decisionOverflow.clientWidth + 1);
        expect(await bodyOverflow(page)).toBeLessThanOrEqual(0);

        await captureViewport(page, `${theme}-desktop-1280-decision-details`, `${theme} desktop: decision card with Details open`);

        // The bell mirrors the same readable card for the machine notice.
        await clickBell(page);
        const machine = page.locator('#notification-list [data-notification-id="machine-1"]');
        await expect(machine.locator('.board-notification__title')).toHaveText(
          'PR285: reconcile restart-interrupted R1 fix and queued continuation before any re-arm',
        );
        const machineTransform = await machine
          .locator('.board-notification__title')
          .evaluate((element) => getComputedStyle(element).textTransform);
        expect(machineTransform).toBe('none');
        await machine.locator('.board-notification__details summary').click();
        await expect(machine.locator('.board-notification__detail-text')).toContainText(LONG_SHA);
        await settled(page);
        const machineOverflow = await overflows(page, '#notification-list [data-notification-id="machine-1"]');
        expect(machineOverflow.scrollWidth).toBeLessThanOrEqual(machineOverflow.clientWidth + 1);
        await captureViewport(page, `${theme}-desktop-1280-machine`, `${theme} desktop: NEEDS GRU machine card with Details open`);
      } finally {
        await page.close();
      }
    }
  });

  test('390 / 768 / 1280 widths and a 320px notification container: nothing overflows or clips', async ({ browser }) => {
    for (const width of [390, 768, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        const seed = await seedBoard(page, fixtureSnapshot());
        await pairAndOpenBoard(page);
        await settled(page);
        expect(seed.pageErrors).toEqual([]);
        expect(await bodyOverflow(page)).toBeLessThanOrEqual(0);
        for (const selector of [
          '#board-owner [data-notification-id="decision-1"]',
          '#board-owner [data-notification-id="decision-1"] .board-notification__title',
          '#board-owner [data-notification-id="decision-1"] .board-notification__detail-text',
        ]) {
          const box = await overflows(page, selector);
          expect(box.scrollWidth, `${selector} @${width}`).toBeLessThanOrEqual(box.clientWidth + 1);
        }
        await captureViewport(page, `width-${width}`, `board at ${width}px with the long-content fixture`);
      } finally {
        await page.close();
      }
    }
    // 320px-wide container: the notification panel itself at 320px.
    const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
    try {
      const seed = await seedBoard(page, fixtureSnapshot());
      await pairAndOpenBoard(page);
      await clickBell(page);
      await settled(page);
      expect(seed.pageErrors).toEqual([]);
      expect(await bodyOverflow(page)).toBeLessThanOrEqual(0);
      for (const id of ['decision-1', 'machine-1', 'feed-resolved']) {
        const panelCard = await overflows(page, `#notification-list [data-notification-id="${id}"]`);
        expect(panelCard.scrollWidth, `${id} @320 panel`).toBeLessThanOrEqual(panelCard.clientWidth + 1);
      }
      await captureViewport(page, 'container-320-panel', 'notification panel at a 320px viewport');
    } finally {
      await page.close();
    }
  });

  test('200% zoom emulation: cards reflow, Details and option controls stay reachable', async ({ browser }) => {
    // Disclosed method (same as the board geometry proof): halved CSS
    // viewport at 2x DPR — a genuine reflow test of a 200% zoom shape.
    const context = await browser.newContext({ viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    try {
      const seed = await seedBoard(page, fixtureSnapshot());
      await pairAndOpenBoard(page);
      await settled(page);
      expect(seed.pageErrors).toEqual([]);
      expect(await bodyOverflow(page)).toBeLessThanOrEqual(0);
      const card = page.locator('#board-owner [data-notification-id="decision-1"]');
      const box = await overflows(page, '#board-owner [data-notification-id="decision-1"]');
      expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
      await card.locator('.board-notification__details summary').click();
      await expect(card.locator('.board-notification__detail-text')).toContainText(LONG_PATH);
      const option = card.locator('[data-action-id$=":option:approve"]');
      await option.scrollIntoViewIfNeeded();
      await expect(option).toBeVisible();
      // The control is genuinely reachable: its center is the topmost hit
      // target (no fixed overlay covers the option button).
      const hit = await option.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const topmost = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return topmost !== null && (topmost === element || element.contains(topmost));
      });
      expect(hit).toBe(true);
      await captureViewport(page, 'zoom-200-decision', '200% zoom emulation: decision card with Details open');
    } finally {
      await context.close();
    }
  });

  test('keyboard: Details toggles with the keyboard and keeps focus + open state across a live push', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      const seed = await seedBoard(page, fixtureSnapshot());
      await pairAndOpenBoard(page);
      const summary = page.locator('#board-owner [data-notification-id="decision-1"] .board-notification__details summary');
      await summary.focus();
      await expect(summary).toBeFocused();
      await page.keyboard.press('Enter');
      expect(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)).toBe(true);
      await page.keyboard.press('Enter');
      expect(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)).toBe(false);
      await page.keyboard.press('Enter');
      expect(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)).toBe(true);
      // A live push of the same authoritative snapshot must not steal
      // focus or collapse what the operator opened.
      seed.push(fixtureSnapshot());
      await settled(page);
      const summaryAfter = page.locator('#board-owner [data-notification-id="decision-1"] .board-notification__details summary');
      expect(await summaryAfter.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)).toBe(true);
      await expect(summaryAfter).toBeFocused();
    } finally {
      await page.close();
    }
  });

  test('viewing, expanding and theme changes send no acknowledgement/decision/re-arm; the option sends exactly one validated decision POST', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      const seed = await seedBoard(page, fixtureSnapshot());
      await pairAndOpenBoard(page);
      const sideEffects: { method: string; url: string; body: string }[] = [];
      page.on('request', (request) => {
        if (request.method() === 'GET') return;
        const url = request.url();
        if (!url.includes('/api/notifications')) return;
        sideEffects.push({ method: request.method(), url, body: request.postData() ?? '' });
      });

      // View / expand / theme: no acknowledgement, disposition, decision or
      // re-arm request — display receipts (shown) are the only POSTs allowed.
      const forbidden = (url: string): boolean =>
        url.endsWith('/ack') || url.endsWith('/disposition') || url.endsWith('/decision') || url.includes('rearm');
      const card = page.locator('#board-owner [data-notification-id="decision-1"]');
      await card.locator('.board-notification__details summary').click();
      await card.locator('.board-notification__question').click();
      await page.locator('#theme-toggle').click();
      await page.locator('#theme-toggle').click();
      await clickBell(page);
      await page.locator('#notification-panel [data-notification-id="machine-1"] .board-notification__details summary').click();
      await settled(page);
      expect(sideEffects.filter((entry) => forbidden(entry.url))).toEqual([]);
      // The only requests so far are idempotent display receipts.
      expect(sideEffects.every((entry) => entry.url.endsWith('/shown'))).toBe(true);

      // A decision click sends ONE request with the exact option id, and
      // the decided row renders from the server reply.
      const decidedRow: NotificationView = {
        ...decisionNotification(),
        decidedAt: '2026-10-11T00:10:00.000Z',
        decidedBy: 'web',
        decidedOption: 'approve',
      };
      await page.route('**/api/notifications/*/decision', (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        return route.fulfill({ json: decidedRow });
      });
      const option = page.locator('#board-owner [data-notification-id="decision-1"] [data-action-id$=":option:approve"]');
      await option.scrollIntoViewIfNeeded();
      await option.click();
      await expect(page.locator('#board-owner [data-notification-id="decision-1"]')).toContainText('Decision recorded');
      await expect(page.locator('#board-owner [data-notification-id="decision-1"] [data-action-id$=":option:approve"]')).toHaveCount(0);
      const decisionPosts = sideEffects.filter((entry) => entry.url.endsWith('/decision'));
      expect(decisionPosts).toHaveLength(1);
      expect(JSON.parse(decisionPosts[0]!.body)).toMatchObject({ optionId: 'approve' });
      expect(sideEffects.filter((entry) => entry.url.endsWith('/ack'))).toEqual([]);
      expect(sideEffects.filter((entry) => entry.url.endsWith('/disposition'))).toEqual([]);
      expect(seed.pageErrors).toEqual([]);
    } finally {
      await page.close();
    }
  });

  test('measured settled contrast: live, error and closed-receipt cards meet WCAG AA in both themes', async ({ browser }) => {
    for (const theme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      try {
        const seed = await seedBoard(page, fixtureSnapshot());
        await pairAndOpenBoard(page);
        if (theme === 'dark') {
          await page.locator('#theme-toggle').click();
          await expect(page.locator('html')).toHaveClass(/dark/);
        }
        await clickBell(page);
        await page.locator('#notification-list [data-notification-id="machine-1"] .board-notification__details summary').click();
        await settled(page);
        expect(seed.pageErrors).toEqual([]);
        const pairs: readonly (readonly [string, string])[] = [
          ['#board-owner [data-notification-id="decision-1"] .board-notification__title', 'FOR YOU decision title'],
          ['#board-owner [data-notification-id="decision-1"] .board-notification__meta', 'FOR YOU decision metadata label'],
          ['#board-owner [data-notification-id="decision-1"] .board-notification__context', 'FOR YOU decision context'],
          ['#board-owner [data-notification-id="decision-1"] .board-notification__question', 'decision question'],
          ['#board-owner [data-notification-id="decision-1"] .board-notification__option-consequence', 'option consequence'],
          ['#board-owner [data-notification-id="decision-1"] .board-notification__detail-text', 'expanded evidence text'],
          ['#notification-list [data-notification-id="machine-1"] .board-notification__title', 'machine (error) title'],
          ['#notification-list [data-notification-id="machine-1"] .board-notification__meta', 'machine (error) metadata label'],
          ['#notification-list [data-notification-id="machine-1"] .board-notification__detail-text', 'machine (error) expanded evidence'],
          ['#notification-list [data-notification-id="machine-closed"] .board-notification__title', 'closed receipt title'],
          ['#notification-list [data-notification-id="feed-resolved"] .board-notification__title', 'resolved feed title'],
        ];
        const failures: { pair: string; ratio: number }[] = [];
        for (const [selector, label] of pairs) {
          const ratio = await contrastOf(page, selector);
          if (ratio < 4.5) failures.push({ pair: `${label} (${theme})`, ratio });
        }
        // The closed receipt's meta line exists inside the dashed row.
        const receiptMeta = '#notification-list [data-notification-id="machine-closed"] .board-notification__meta';
        if ((await page.locator(receiptMeta).count()) > 0) {
          const ratio = await contrastOf(page, receiptMeta);
          if (ratio < 4.5) failures.push({ pair: `closed receipt metadata label (${theme})`, ratio });
        }
        expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
        await captureViewport(page, `${theme}-contrast-panel`, `${theme}: panel used for measured contrast`);
      } finally {
        await page.close();
      }
    }
  });
});
