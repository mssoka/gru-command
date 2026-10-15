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
const LONG_PATH = '/home/tester/.gru-command/captures/ops-sweep-20261009T000000Z/reconcile/PR285-interrupted-original-capture-provenance/manifest.json';

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

/** A Book of Lessons proposal row (owner decision 2026-10-07): the
 * review body is the actual lesson prose and must stay readable. */
function proposalNotification(): NotificationView {
  return {
    id: 'proposal-1',
    ts: T0,
    kind: 'lessons.proposal',
    routing: 'needs-owner',
    severity: 'info',
    title: 'Book of Lessons: 2 lesson changes proposed',
    detail: 'Two lessons changed in the execution chapter — review the exact before/after text before Accept writes them.',
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

function proposalReviewView(): Record<string, unknown> {
  return {
    id: 'lp-1',
    createdAt: T0,
    notificationId: 'proposal-1',
    entries: 2,
    throughSeq: 9,
    chapters: [
      {
        slug: 'execution-practice',
        title: { before: 'Execution practice', after: 'Execution practice' },
        retired: false,
        summary: { before: 'Restart discipline.', after: 'Restart discipline.' },
        tags: { before: ['ops'], after: ['ops'] },
        added: [
          {
            slug: 'close-shell',
            body: 'Close the shell first.\nThen restart.',
            recurred: 1,
            tags: ['ops'],
            previousBody: null,
            previousRecurred: null,
            previousTags: null,
          },
        ],
        changed: [
          {
            slug: 'drain',
            body: 'Drain before a roll.',
            recurred: 3,
            tags: ['ops'],
            previousBody: 'Drain.',
            previousRecurred: 2,
            previousTags: [],
          },
        ],
        removed: [],
        provenanceTrimmed: 4,
        bodiesTrimmed: 0,
      },
    ],
    index: [],
    decision: null,
    recovery: null,
  };
}

/** A discussion-only owner decision: no options yet, so the card's
 * supported action is the chat route — used to measure the discussion
 * text's contrast under the real text-only zoom. */
function discussionNotification(): NotificationView {
  return {
    id: 'discuss-1',
    ts: T0,
    kind: 'gru.owner-escalation',
    routing: 'needs-owner',
    severity: 'info',
    title: 'Which shape should the dashboard take?',
    detail: 'Talk it through with Gru before a choice is recorded.',
    agentId: null,
    shownAt: null,
    ackedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    decision: {
      question: 'Which shape should the dashboard take?',
      context: 'The discussion has not converged on a concrete option.',
      recommendation: null,
      reservedClass: 'scope-design',
      whyNotDelegable: 'It changes the agreed product scope.',
      options: [],
      discussion: true,
    },
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
    notifications: [decisionNotification(), proposalNotification(), machineNotification(), resolvedFeed, closedMachine],
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
  readonly socketReady: Promise<void>;
  holdNextBoardFrame(): Promise<void>;
  socketCount(): number;
  closeLatestSocket(): Promise<void>;
  push(snapshot: BoardSnapshot): void;
  pushLatest(snapshot: BoardSnapshot): void;
}

async function seedBoard(page: Page, initial: BoardSnapshot, proposal?: Record<string, unknown>): Promise<Seed> {
  if (!isValidSnapshot(initial)) throw new Error('fixture snapshot fails the production isValidSnapshot validator');
  const frame = parseBoardServerFrame({ type: 'board', snapshot: initial });
  if (frame === null || frame.type !== 'board') throw new Error('fixture board frame fails the production parser');
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  let current = initial;
  let withholdNextBoardFrame = false;
  let resolveWithheldBoardFrame: (() => void) | null = null;
  let withheldBoardFrame: Promise<void> | null = null;
  const sockets: WebSocketRoute[] = [];
  let markSocketReady!: () => void;
  const socketReady = new Promise<void>((resolve) => { markSocketReady = resolve; });
  await page.route('**/api/board', (route) => route.fulfill({ json: current }));
  if (proposal !== undefined) {
    await page.route('**/api/lessons/proposal', (route) => route.fulfill({ json: proposal }));
  }
  await page.routeWebSocket(/\/board\/ws$/, (ws: WebSocketRoute) => {
    let seeded = false;
    sockets.push(ws);
    ws.onMessage(() => {
      if (seeded) return;
      seeded = true;
      ws.send(JSON.stringify({ type: 'auth_ok' }));
      if (withholdNextBoardFrame) {
        withholdNextBoardFrame = false;
        resolveWithheldBoardFrame?.();
        resolveWithheldBoardFrame = null;
        return;
      }
      ws.send(JSON.stringify({ type: 'board', snapshot: current }));
      markSocketReady();
    });
  });
  return {
    pageErrors,
    socketReady,
    holdNextBoardFrame() {
      withholdNextBoardFrame = true;
      withheldBoardFrame = new Promise<void>((resolve) => { resolveWithheldBoardFrame = resolve; });
      return withheldBoardFrame;
    },
    socketCount() {
      return sockets.length;
    },
    async closeLatestSocket() {
      const latest = sockets.at(-1);
      if (latest === undefined) throw new Error('no board socket exists to close');
      await latest.close({ code: 1001, reason: 'test connection interruption' });
    },
    push(snapshot: BoardSnapshot) {
      if (!isValidSnapshot(snapshot)) throw new Error('pushed snapshot fails the production validator');
      current = snapshot;
      for (const ws of sockets) ws.send(JSON.stringify({ type: 'board', snapshot }));
    },
    pushLatest(snapshot: BoardSnapshot) {
      if (!isValidSnapshot(snapshot)) throw new Error('pushed snapshot fails the production validator');
      current = snapshot;
      const latest = sockets.at(-1);
      if (latest === undefined) throw new Error('no board socket exists to receive the snapshot');
      latest.send(JSON.stringify({ type: 'board', snapshot }));
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

/** A controlled 200% text-only browser fixture for Chromium, which has no
 * native text-only zoom setting. It changes only notification text nodes:
 * the html/body and every layout container keep their own computed sizes.
 * All baselines are read together after restoring this helper's inline
 * overrides, before any text size is changed, so relative-size descendants
 * cannot inherit an already-doubled base. Fresh nodes after an SPA rebuild
 * are measured the same way; prior nodes keep their original baseline.
 * Tests independently sample rendered font sizes before/after and hold the
 * viewport, DPR, and notification-panel width fixed. This is a direct
 * computed-font-size change, not CSS/page zoom or a screenshot inference. */
async function applyTextOnlyZoom(
  page: Page,
  factor = 2,
  probeSelector = '[data-notification-id="decision-1"] .board-notification__title',
): Promise<{ scaled: number; probeBase: number; probeAfter: number }> {
  return page.evaluate(
    ({ scale, selector }) => {
      if (!Number.isFinite(scale) || scale <= 1) throw new Error(`text-only zoom factor must be greater than 1: ${scale}`);
      const probe = document.querySelector<HTMLElement>(selector);
      if (probe === null) throw new Error(`text-only zoom probe not found: ${selector}`);
      const roots = [
        ...document.querySelectorAll<HTMLElement>('.board-notification'),
        ...document.querySelectorAll<HTMLElement>('#notification-panel'),
      ];
      const candidates = new Set<HTMLElement>();
      for (const root of roots) {
        candidates.add(root);
        for (const element of root.querySelectorAll<HTMLElement>('*')) candidates.add(element);
      }
      const textElements = [...candidates].filter((element) =>
        [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== ''),
      );
      if (!textElements.includes(probe)) {
        throw new Error(`text-only zoom probe is not notification text: ${selector}`);
      }
      const records = textElements.map((element) => {
        const savedBase = Number.parseFloat(element.dataset.textZoomBase ?? '');
        if (element.dataset.textZoomInlineFontSize === undefined) {
          element.dataset.textZoomInlineFontSize = element.style.fontSize;
        }
        // Remove only this helper's prior font override before measuring.
        // A newly-rendered relative-size child therefore sees the original
        // computed parent, not a zoomed ancestor.
        element.style.fontSize = element.dataset.textZoomInlineFontSize;
        return {
          element,
          base: Number.isFinite(savedBase) && savedBase > 0 ? savedBase : null,
        };
      });
      const measured = records.map(({ element, base }) => {
        const original = base ?? Number.parseFloat(getComputedStyle(element).fontSize);
        if (!Number.isFinite(original) || original <= 0) {
          throw new Error(`notification text has no measurable base font size: ${element.tagName.toLowerCase()}`);
        }
        if (base === null) element.dataset.textZoomBase = String(original);
        return { element, base: original };
      });
      for (const { element, base } of measured) element.style.fontSize = `${base * scale}px`;
      return {
        scaled: measured.length,
        probeBase: Number.parseFloat(probe.dataset.textZoomBase ?? ''),
        probeAfter: Number.parseFloat(getComputedStyle(probe).fontSize),
      };
    },
    { scale: factor, selector: probeSelector },
  );
}

async function computedFontSize(page: Page, selector: string): Promise<number> {
  return page.evaluate((query) => {
    const element = document.querySelector<HTMLElement>(query);
    if (element === null) throw new Error(`font-size measurement target not found: ${query}`);
    return Number.parseFloat(getComputedStyle(element).fontSize);
  }, selector);
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

  test('390 / 768 / 1280 widths and a 320px container: expanded content reflows in both themes', async ({ browser }) => {
    for (const theme of ['light', 'dark'] as const) {
      for (const width of [390, 768, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
          const seed = await seedBoard(page, fixtureSnapshot());
          await pairAndOpenBoard(page);
          if (theme === 'dark') {
            await page.locator('#theme-toggle').click();
            await expect(page.locator('html')).toHaveClass(/dark/);
          }
          await settled(page);
          expect(seed.pageErrors).toEqual([]);
          expect(await bodyOverflow(page)).toBeLessThanOrEqual(0);
          // EXPAND the diagnostics before measuring: the checked state is
          // the full open body, never just the collapsed face.
          const card = page.locator('#board-owner [data-notification-id="decision-1"]');
          await card.locator('.board-notification__details summary').click();
          await expect(card.locator('.board-notification__detail-text')).toContainText(LONG_PATH);
          await settled(page);
          for (const selector of [
            '#board-owner [data-notification-id="decision-1"]',
            '#board-owner [data-notification-id="decision-1"] .board-notification__title',
            '#board-owner [data-notification-id="decision-1"] .board-notification__detail-text',
          ]) {
            const box = await overflows(page, selector);
            expect(box.scrollWidth, `${selector} @${width} ${theme}`).toBeLessThanOrEqual(box.clientWidth + 1);
          }
          // Nonzero expanded geometry: the open block is really rendered.
          const detailBox = await card.locator('.board-notification__detail-text').boundingBox();
          expect(detailBox?.width ?? 0, `expanded detail width @${width} ${theme}`).toBeGreaterThan(0);
          expect(detailBox?.height ?? 0, `expanded detail height @${width} ${theme}`).toBeGreaterThan(0);
          await captureViewport(page, `${theme}-width-${width}-expanded`, `${theme} board at ${width}px with expanded diagnostics`);
        } finally {
          await page.close();
        }
      }
    }
    // 320px-wide notification container: the panel width rule subtracts
    // 32px from the viewport, so 352px yields exactly 320px.
    for (const theme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width: 352, height: 800 } });
      try {
        const seed = await seedBoard(page, fixtureSnapshot());
        await pairAndOpenBoard(page);
        if (theme === 'dark') {
          await page.locator('#theme-toggle').click();
          await expect(page.locator('html')).toHaveClass(/dark/);
        }
        await clickBell(page);
        await settled(page);
        expect(seed.pageErrors).toEqual([]);
        expect(
          await page.locator('#notification-panel').evaluate((panel) => panel.getBoundingClientRect().width),
        ).toBe(320);
        expect(await bodyOverflow(page)).toBeLessThanOrEqual(0);
        for (const id of ['decision-1', 'machine-1', 'feed-resolved']) {
          await page.locator(`#notification-list [data-notification-id="${id}"]`).scrollIntoViewIfNeeded();
        }
        await page.locator('#notification-list [data-notification-id="machine-1"] .board-notification__details summary').click();
        await expect(
          page.locator('#notification-list [data-notification-id="machine-1"] .board-notification__detail-text'),
        ).toContainText(LONG_SHA);
        await settled(page);
        for (const id of ['decision-1', 'machine-1', 'feed-resolved']) {
          const panelCard = await overflows(page, `#notification-list [data-notification-id="${id}"]`);
          expect(panelCard.scrollWidth, `${id} @320 panel ${theme}`).toBeLessThanOrEqual(panelCard.clientWidth + 1);
        }
        const expandedBox = await page
          .locator('#notification-list [data-notification-id="machine-1"] .board-notification__detail-text')
          .boundingBox();
        expect(expandedBox?.width ?? 0).toBeGreaterThan(0);
        expect(expandedBox?.height ?? 0).toBeGreaterThan(0);
        await captureViewport(page, `${theme}-container-320-panel-expanded`, `${theme}: notification panel at 320px with diagnostics open`);
      } finally {
        await page.close();
      }
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
      // Bring the control to the middle of the viewport (away from the
      // sticky chrome) and prove it is genuinely reachable: its center is
      // the topmost hit target, and a trial click passes actionability.
      await option.evaluate((element) => element.scrollIntoView({ block: 'center' }));
      await settled(page);
      await expect(option).toBeVisible();
      const hit = await option.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const topmost = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return topmost !== null && (topmost === element || element.contains(topmost));
      });
      expect(hit).toBe(true);
      await option.click({ trial: true });
      await captureViewport(page, 'zoom-200-decision', '200% zoom emulation: decision card with Details open');
    } finally {
      await context.close();
    }
  });

  test('200% PAGE zoom (CSS zoom scales text AND layout together): the board and the proposal review reflow', async ({ browser }) => {
    // This case is page zoom, NOT text-only zoom: `zoom: 2` on the root
    // scales text and layout together and halves the effective layout width
    // (the 1600px window renders like an 800px one). It is retained as a
    // page-zoom reflow check only — the actual 200% TEXT-ONLY requirement is
    // covered by the computed-font-size tests below.
    for (const theme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
      try {
        const seed = await seedBoard(page, fixtureSnapshot(), proposalReviewView());
        await pairAndOpenBoard(page);
        if (theme === 'dark') {
          await page.locator('#theme-toggle').click();
          await expect(page.locator('html')).toHaveClass(/dark/);
        }
        await page.evaluate(() => {
          document.documentElement.style.zoom = '2';
        });
        await settled(page);
        expect(seed.pageErrors).toEqual([]);
        expect(await bodyOverflow(page)).toBeLessThanOrEqual(0);
        // The decision card's expanded evidence block stays rendered.
        const card = page.locator('#board-owner [data-notification-id="decision-1"]');
        await card.locator('.board-notification__details summary').click();
        const detail = card.locator('.board-notification__detail-text');
        await expect(detail).toContainText(LONG_PATH);
        const detailBox = await detail.boundingBox();
        expect(detailBox?.width ?? 0).toBeGreaterThan(0);
        expect(detailBox?.height ?? 0).toBeGreaterThan(0);
        const cardOverflow = await overflows(page, '#board-owner [data-notification-id="decision-1"]');
        expect(cardOverflow.scrollWidth).toBeLessThanOrEqual(cardOverflow.clientWidth + 1);
        // The proposal review's lesson text is readable prose under zoom.
        const proposal = page.locator('#board-owner [data-proposal-id="proposal-1"]');
        await proposal.locator('.board-owner__review > summary').click();
        const reviewText = proposal.locator('.board-owner__review-text').first();
        await expect(reviewText).toContainText('Close the shell first');
        expect(await reviewText.evaluate((element) => getComputedStyle(element).textTransform)).toBe('none');
        const reviewBox = await reviewText.boundingBox();
        expect(reviewBox?.width ?? 0).toBeGreaterThan(0);
        expect(reviewBox?.height ?? 0).toBeGreaterThan(0);
        const proposalOverflow = await overflows(page, '#board-owner [data-proposal-id="proposal-1"]');
        expect(proposalOverflow.scrollWidth).toBeLessThanOrEqual(proposalOverflow.clientWidth + 1);
        await captureViewport(page, `${theme}-page-zoom-200`, `${theme}: 200% page zoom (CSS zoom; text and layout scale), decision + proposal review expanded`);
      } finally {
        await page.close();
      }
    }
  });

  test('actual 200% text-only zoom: rendered text doubles while viewport and container scale stay fixed', async ({ browser }) => {
    for (const theme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      try {
        const withDiscussion = fixtureSnapshot({
          notifications: [...fixtureSnapshot().notifications, discussionNotification()],
        });
        const seed = await seedBoard(page, withDiscussion, proposalReviewView());
        await pairAndOpenBoard(page);
        if (theme === 'dark') {
          await page.locator('#theme-toggle').click();
          await expect(page.locator('html')).toHaveClass(/dark/);
        }
        await settled(page);
        expect(seed.pageErrors).toEqual([]);

        const cardSelector = '#board-owner [data-notification-id="decision-1"]';
        const titleSelector = `${cardSelector} .board-notification__title`;
        const metaSelector = `${cardSelector} .board-notification__meta`;
        const optionSelector = `${cardSelector} [data-action-id$=":option:approve"]`;
        const detailSelector = `${cardSelector} .board-notification__detail-text`;
        const panelDecisionTitleSelector =
          '#notification-list [data-notification-id="decision-1"] .board-notification__title';
        const panelDecisionSummarySelector =
          '#notification-list [data-notification-id="decision-1"] .board-notification__details summary';
        const panelDecisionDetailSelector =
          '#notification-list [data-notification-id="decision-1"] .board-notification__detail-text';
        const panelMachineDetailSelector =
          '#notification-list [data-notification-id="machine-1"] .board-notification__detail-text';
        const relativeProbeSelector = '[data-text-zoom-relative-probe="true"]';
        const card = page.locator(cardSelector);
        const detail = page.locator(detailSelector);
        await card.locator('.board-notification__details summary').click();
        await expect(detail).toContainText(LONG_PATH);
        await clickBell(page);
        const panelDecision = page.locator('#notification-list [data-notification-id="decision-1"]');
        await panelDecision.locator('.board-notification__details summary').click();
        await expect(panelDecision.locator('.board-notification__detail-text')).toContainText(LONG_PATH);
        await page.locator('#notification-list [data-notification-id="machine-1"] .board-notification__details summary').click();
        await expect(page.locator(panelMachineDetailSelector)).toContainText(LONG_SHA);
        // A relative-size descendant proves that the batch records its
        // natural computed baseline before mutating any ancestor.
        await detail.evaluate((element) => {
          const probe = document.createElement('span');
          probe.dataset.textZoomRelativeProbe = 'true';
          probe.style.fontSize = '1.08em';
          probe.textContent = ' relative-size probe';
          element.append(probe);
        });
        // All baselines and fixed-scale invariants are sampled BEFORE the
        // text-only pass, including the notification list and rem layout.
        const before = await page.evaluate(() => {
          const composer = document.querySelector<HTMLElement>('#chat-input');
          if (composer === null) throw new Error('chat composer not found for rem-layout invariant');
          const panel = document.getElementById('notification-panel');
          if (panel === null) throw new Error('notification panel not found for width invariant');
          return {
            viewport: window.innerWidth,
            viewportHeight: window.innerHeight,
            dpr: window.devicePixelRatio,
            ownerWidth: document.getElementById('board-owner')!.getBoundingClientRect().width,
            panelWidth: panel.getBoundingClientRect().width,
            rootFontSize: getComputedStyle(document.documentElement).fontSize,
            bodyFontSize: getComputedStyle(document.body).fontSize,
            bodyZoom: document.body.style.zoom,
            composerMaxHeight: getComputedStyle(composer).maxHeight,
            composerFontSize: getComputedStyle(composer).fontSize,
          };
        });
        const beforeFonts = {
          title: await computedFontSize(page, titleSelector),
          metadata: await computedFontSize(page, metaSelector),
          option: await computedFontSize(page, optionSelector),
          detail: await computedFontSize(page, detailSelector),
          panelTitle: await computedFontSize(page, panelDecisionTitleSelector),
          panelDecisionDetail: await computedFontSize(page, panelDecisionDetailSelector),
          panelDetail: await computedFontSize(page, panelMachineDetailSelector),
          relative: await computedFontSize(page, relativeProbeSelector),
        };
        const titleBefore = await page.locator(titleSelector).boundingBox();

        // The operative text-only mechanism changes computed font sizes on
        // notification text nodes, without applying page/root zoom.
        const zoom = await applyTextOnlyZoom(page);
        expect(zoom.scaled).toBeGreaterThan(0);
        expect(zoom.probeBase).toBeCloseTo(beforeFonts.title, 1);
        // Independent pre/post measurements pin the exact factor, including
        // expanded diagnostics and the notification-list copy.
        expect(zoom.probeAfter).toBeCloseTo(beforeFonts.title * 2, 1);
        expect(await computedFontSize(page, titleSelector)).toBeCloseTo(beforeFonts.title * 2, 1);
        expect(await computedFontSize(page, metaSelector)).toBeCloseTo(beforeFonts.metadata * 2, 1);
        expect(await computedFontSize(page, optionSelector)).toBeCloseTo(beforeFonts.option * 2, 1);
        expect(await computedFontSize(page, detailSelector)).toBeCloseTo(beforeFonts.detail * 2, 1);
        expect(await computedFontSize(page, panelDecisionTitleSelector)).toBeCloseTo(beforeFonts.panelTitle * 2, 1);
        expect(await computedFontSize(page, panelDecisionDetailSelector)).toBeCloseTo(beforeFonts.panelDecisionDetail * 2, 1);
        expect(await computedFontSize(page, panelMachineDetailSelector)).toBeCloseTo(beforeFonts.panelDetail * 2, 1);
        expect(await computedFontSize(page, relativeProbeSelector)).toBeCloseTo(beforeFonts.relative * 2, 1);
        expect(await computedFontSize(page, metaSelector)).toBe(22);
        expect(await computedFontSize(page, optionSelector)).toBe(24);
        const after = await page.evaluate(() => {
          const composer = document.querySelector<HTMLElement>('#chat-input');
          const panel = document.getElementById('notification-panel');
          if (composer === null || panel === null) throw new Error('fixed-layout probe disappeared during text zoom');
          return {
            viewport: window.innerWidth,
            viewportHeight: window.innerHeight,
            dpr: window.devicePixelRatio,
            ownerWidth: document.getElementById('board-owner')!.getBoundingClientRect().width,
            panelWidth: panel.getBoundingClientRect().width,
            rootFontSize: getComputedStyle(document.documentElement).fontSize,
            bodyFontSize: getComputedStyle(document.body).fontSize,
            bodyZoom: document.body.style.zoom,
            composerMaxHeight: getComputedStyle(composer).maxHeight,
            composerFontSize: getComputedStyle(composer).fontSize,
          };
        });
        expect(await page.evaluate(() => document.documentElement.style.zoom)).toBe('');
        expect(await page.evaluate(() => document.documentElement.style.fontSize)).toBe('');
        expect(after.bodyZoom).toBe('');
        expect(after.viewport).toBe(before.viewport);
        expect(after.viewportHeight).toBe(before.viewportHeight);
        expect(after.dpr).toBe(before.dpr);
        expect(after.ownerWidth).toBe(before.ownerWidth);
        expect(after.panelWidth).toBe(before.panelWidth);
        expect(after.rootFontSize).toBe(before.rootFontSize);
        expect(after.bodyFontSize).toBe(before.bodyFontSize);
        expect(after.bodyZoom).toBe(before.bodyZoom);
        expect(after.composerMaxHeight).toBe(before.composerMaxHeight);
        expect(after.composerFontSize).toBe(before.composerFontSize);
        // Actual measured glyph growth at the fixed width: the same title
        // needs more vertical space and never more than its container.
        const titleAfter = await page.locator(titleSelector).boundingBox();
        expect(titleAfter!.height).toBeGreaterThan(titleBefore!.height);
        expect(titleAfter!.width).toBeLessThanOrEqual(titleBefore!.width + 1);

        // Full expanded content: geometry, non-overlap, reachability.
        const detailBox = await detail.boundingBox();
        expect(detailBox?.width ?? 0).toBeGreaterThan(0);
        expect(detailBox?.height ?? 0).toBeGreaterThan(0);
        const cardOverflow = await overflows(page, cardSelector);
        expect(cardOverflow.scrollWidth, `decision card @1280 ${theme} text-only`).toBeLessThanOrEqual(cardOverflow.clientWidth + 1);
        // Close the bell overlay before hit-testing the owner decision control.
        await page.locator('#notification-list [data-notification-id="machine-1"] .board-notification__details summary').click();
        await page.locator('#notification-bell').click();
        await expect(page.locator('#notification-panel')).toBeHidden();
        await page.locator(relativeProbeSelector).evaluate((element) => element.remove());
        const option = page.locator(optionSelector);
        await option.evaluate((element) => element.scrollIntoView({ block: 'center' }));
        await expect(option).toBeVisible();
        const hit = await option.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const topmost = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return topmost !== null && (topmost === element || element.contains(topmost));
        });
        expect(hit).toBe(true);
        await option.click({ trial: true });

        // Focus + open disclosure survive a snapshot replacement. Mark both
        // rendered surfaces so the test proves fresh notification nodes
        // are present before taking their unzoomed baselines.
        const summary = card.locator('.board-notification__details summary');
        await summary.focus();
        expect(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)).toBe(true);
        const titleZoomed = await computedFontSize(page, titleSelector);
        await page.evaluate((selectors) => {
          for (const selector of selectors) {
            const element = document.querySelector<HTMLElement>(selector);
            if (element === null) throw new Error(`rebuild probe target not found: ${selector}`);
            element.setAttribute('data-rebuild-probe', 'before');
          }
        }, [
          titleSelector,
          detailSelector,
          panelDecisionTitleSelector,
          panelDecisionDetailSelector,
          panelMachineDetailSelector,
        ]);
        seed.push(withDiscussion);
        await expect.poll(() => page.locator('[data-rebuild-probe="before"]').count()).toBe(0);
        const summaryAfter = page.locator(
          '#board-owner [data-notification-id="decision-1"] .board-notification__details summary',
        );
        expect(await summaryAfter.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)).toBe(true);
        await expect(summaryAfter).toBeFocused();
        await expect(page.locator(detailSelector)).toBeVisible();
        await page.locator('#notification-bell').click();
        await expect(page.locator('#notification-panel')).toBeVisible();
        const panelDecisionSummaryAfter = page.locator(panelDecisionSummarySelector);
        await expect(panelDecisionSummaryAfter).toBeVisible();
        expect(
          await panelDecisionSummaryAfter.evaluate((element) => (element.parentElement as HTMLDetailsElement).open),
        ).toBe(true);
        const rebuiltPanelDetail = page.locator(panelDecisionDetailSelector);
        await expect(rebuiltPanelDetail).toBeVisible();
        await expect(rebuiltPanelDetail).toContainText(LONG_PATH);
        await page.locator(detailSelector).evaluate((element) => {
          const probe = document.createElement('span');
          probe.dataset.textZoomRelativeProbe = 'true';
          probe.style.fontSize = '1.08em';
          probe.textContent = ' rebuilt relative-size probe';
          element.append(probe);
        });
        const rebuiltFonts = {
          title: await computedFontSize(page, titleSelector),
          detail: await computedFontSize(page, detailSelector),
          panelTitle: await computedFontSize(page, panelDecisionTitleSelector),
          panelDecisionDetail: await computedFontSize(page, panelDecisionDetailSelector),
          panelDetail: await computedFontSize(page, panelMachineDetailSelector),
          relative: await computedFontSize(page, relativeProbeSelector),
        };
        const reapplied = await applyTextOnlyZoom(page);
        // Both expanded decision diagnostics are visible and measured from
        // the fresh DOM before reapplication; relative children cannot
        // compound.
        expect(reapplied.scaled).toBeGreaterThan(0);
        expect(reapplied.probeBase).toBeCloseTo(rebuiltFonts.title, 1);
        expect(reapplied.probeAfter).toBeCloseTo(rebuiltFonts.title * 2, 1);
        expect(await computedFontSize(page, detailSelector)).toBeCloseTo(rebuiltFonts.detail * 2, 1);
        expect(await computedFontSize(page, panelDecisionTitleSelector)).toBeCloseTo(rebuiltFonts.panelTitle * 2, 1);
        await expect(rebuiltPanelDetail).toBeVisible();
        await expect(rebuiltPanelDetail).toContainText(LONG_PATH);
        expect(
          await panelDecisionSummaryAfter.evaluate((element) => (element.parentElement as HTMLDetailsElement).open),
        ).toBe(true);
        expect(await computedFontSize(page, panelDecisionDetailSelector)).toBeCloseTo(rebuiltFonts.panelDecisionDetail * 2, 1);
        expect(await computedFontSize(page, panelMachineDetailSelector)).toBeCloseTo(rebuiltFonts.panelDetail * 2, 1);
        expect(await computedFontSize(page, relativeProbeSelector)).toBeCloseTo(rebuiltFonts.relative * 2, 1);
        await page.locator(relativeProbeSelector).evaluate((element) => element.remove());
        const titleRezoomed = await computedFontSize(page, titleSelector);
        expect(titleRezoomed).toBeCloseTo(titleZoomed, 1);
        expect(await summaryAfter.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)).toBe(true);
        await page.locator('#notification-bell').click();
        await expect(page.locator('#notification-panel')).toBeHidden();

        // Owner-only proposal boundaries stay shown and untouched.
        const proposal = page.locator('#board-owner [data-proposal-id="proposal-1"]');
        await expect(proposal.locator('.board-owner__accept')).toBeVisible();
        await expect(proposal.locator('.board-owner__reject')).toBeVisible();

        // AA 4.5 under text-only zoom: error-card text and the discussion
        // guidance keep their measured contrast in both themes.
        await clickBell(page);
        await expect(
          page.locator('#notification-list [data-notification-id="discuss-1"] .board-notification__discuss-text'),
        ).toBeVisible();
        // The error card's expanded evidence is OPEN when measured (the
        // closed-disclosure state is not the state claimed here).
        await page.locator('#notification-list [data-notification-id="machine-1"] .board-notification__details summary').click();
        await expect(
          page.locator('#notification-list [data-notification-id="machine-1"] .board-notification__detail-text'),
        ).toContainText(LONG_SHA);
        await settled(page);
        const pairs: readonly (readonly [string, string])[] = [
          ['#notification-list [data-notification-id="machine-1"] .board-notification__title', 'machine (error) title'],
          ['#notification-list [data-notification-id="machine-1"] .board-notification__detail-text', 'machine (error) expanded evidence'],
          ['#notification-list [data-notification-id="discuss-1"] .board-notification__discuss-text', 'discussion guidance text'],
        ];
        const failures: { pair: string; ratio: number }[] = [];
        for (const [selector, label] of pairs) {
          const ratio = await contrastOf(page, selector);
          if (ratio < 4.5) failures.push({ pair: `${label} (${theme})`, ratio });
        }
        expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
        // Non-overlap reaches the CONTAINERS, and the page itself does not
        // acquire horizontal scroll under the real text zoom.
        for (const container of ['#board-owner', '#notification-list']) {
          const bounds = await overflows(page, container);
          expect(bounds.scrollWidth, `${container} @1280 ${theme} text-only`).toBeLessThanOrEqual(bounds.clientWidth + 1);
        }
        expect(await bodyOverflow(page)).toBeLessThanOrEqual(0);
        await captureViewport(page, `${theme}-text-only-zoom-200-desktop`, `${theme}: actual 200% text-only zoom, decision Details + discussion card`);
      } finally {
        await page.close();
      }
    }
  });

  test('actual 200% text-only zoom at 390/768/1280 and the 320px container: expanded content stays reachable in both themes', async ({ browser }) => {
    for (const theme of ['light', 'dark'] as const) {
      for (const width of [390, 768, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
          const seed = await seedBoard(page, fixtureSnapshot());
          await pairAndOpenBoard(page);
          if (theme === 'dark') {
            await page.locator('#theme-toggle').click();
            await expect(page.locator('html')).toHaveClass(/dark/);
          }
          await settled(page);
          expect(seed.pageErrors).toEqual([]);
          const cardSelector = '#board-owner [data-notification-id="decision-1"]';
          const titleSelector = `${cardSelector} .board-notification__title`;
          const detailSelector = `${cardSelector} .board-notification__detail-text`;
          const card = page.locator(cardSelector);
          await expect(card).toBeVisible();
          await card.locator('.board-notification__details summary').click();
          await expect(card.locator('.board-notification__detail-text')).toContainText(LONG_PATH);
          await settled(page);
          const titleBase = await computedFontSize(page, titleSelector);
          const detailBase = await computedFontSize(page, detailSelector);
          const zoom = await applyTextOnlyZoom(page);
          expect(zoom.probeBase).toBeCloseTo(titleBase, 1);
          expect(zoom.probeAfter).toBeCloseTo(titleBase * 2, 1);
          expect(await computedFontSize(page, detailSelector)).toBeCloseTo(detailBase * 2, 1);
          for (const selector of [
            '#board-owner [data-notification-id="decision-1"]',
            '#board-owner [data-notification-id="decision-1"] .board-notification__detail-text',
            '#board-owner',
          ]) {
            const box = await overflows(page, selector);
            expect(box.scrollWidth, `${selector} @${width} ${theme} text-only`).toBeLessThanOrEqual(box.clientWidth + 1);
          }
          expect(await bodyOverflow(page)).toBeLessThanOrEqual(0);
          const detailBox = await card.locator('.board-notification__detail-text').boundingBox();
          expect(detailBox?.width ?? 0, `expanded width @${width} ${theme} text-only`).toBeGreaterThan(0);
          expect(detailBox?.height ?? 0, `expanded height @${width} ${theme} text-only`).toBeGreaterThan(0);
          const option = card.locator('[data-action-id$=":option:approve"]');
          await option.evaluate((element) => element.scrollIntoView({ block: 'center' }));
          await settled(page);
          const hit = await option.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const topmost = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return topmost !== null && (topmost === element || element.contains(topmost));
          });
          expect(hit, `option reachable @${width} ${theme} text-only`).toBe(true);
          await captureViewport(page, `${theme}-text-only-zoom-200-width-${width}`, `${theme}: actual 200% text-only zoom at ${width}px`);
        } finally {
          await page.close();
        }
      }
      // The 320px notification container under the same real text zoom.
      // Its width rule subtracts 32px from the viewport, so 352px yields 320px.
      const page = await browser.newPage({ viewport: { width: 352, height: 800 } });
      try {
        const seed = await seedBoard(page, fixtureSnapshot());
        await pairAndOpenBoard(page);
        if (theme === 'dark') {
          await page.locator('#theme-toggle').click();
          await expect(page.locator('html')).toHaveClass(/dark/);
        }
        await clickBell(page);
        await settled(page);
        expect(seed.pageErrors).toEqual([]);
        const panelWidthBefore = await page
          .locator('#notification-panel')
          .evaluate((panel) => panel.getBoundingClientRect().width);
        expect(panelWidthBefore).toBe(320);
        const panelDecision = page.locator('#notification-list [data-notification-id="decision-1"]');
        const panelDecisionTitleSelector = '#notification-list [data-notification-id="decision-1"] .board-notification__title';
        const panelDecisionDetailSelector = '#notification-list [data-notification-id="decision-1"] .board-notification__detail-text';
        const panelMachineDetailSelector = '#notification-list [data-notification-id="machine-1"] .board-notification__detail-text';
        await panelDecision.locator('.board-notification__details summary').click();
        await expect(page.locator(panelDecisionDetailSelector)).toContainText(LONG_PATH);
        await page.locator('#notification-list [data-notification-id="machine-1"] .board-notification__details summary').click();
        await expect(page.locator(panelMachineDetailSelector)).toContainText(LONG_SHA);
        const panelDecisionTitleBase = await computedFontSize(page, panelDecisionTitleSelector);
        const panelDecisionDetailBase = await computedFontSize(page, panelDecisionDetailSelector);
        const panelMachineDetailBase = await computedFontSize(page, panelMachineDetailSelector);
        const zoom = await applyTextOnlyZoom(page, 2, panelDecisionTitleSelector);
        expect(zoom.probeBase).toBeCloseTo(panelDecisionTitleBase, 1);
        expect(zoom.probeAfter).toBeCloseTo(panelDecisionTitleBase * 2, 1);
        expect(await computedFontSize(page, panelDecisionDetailSelector)).toBeCloseTo(panelDecisionDetailBase * 2, 1);
        expect(await computedFontSize(page, panelMachineDetailSelector)).toBeCloseTo(panelMachineDetailBase * 2, 1);
        expect(
          await page.locator('#notification-panel').evaluate((panel) => panel.getBoundingClientRect().width),
        ).toBe(panelWidthBefore);
        await settled(page);
        // Every measured card must be PROVEN present first: a missing card
        // can no longer satisfy the overflow comparison vacuously.
        for (const id of ['decision-1', 'machine-1', 'feed-resolved']) {
          const panelCardLocator = page.locator(`#notification-list [data-notification-id="${id}"]`);
          await panelCardLocator.scrollIntoViewIfNeeded();
          await expect(panelCardLocator).toBeVisible();
          const panelCard = await overflows(page, `#notification-list [data-notification-id="${id}"]`);
          expect(panelCard.scrollWidth, `${id} @320 panel ${theme} text-only`).toBeLessThanOrEqual(panelCard.clientWidth + 1);
        }
        const panelBounds = await overflows(page, '#notification-list');
        expect(panelBounds.scrollWidth, `panel @320 ${theme} text-only`).toBeLessThanOrEqual(panelBounds.clientWidth + 1);
        expect(await bodyOverflow(page)).toBeLessThanOrEqual(0);
        const expandedBox = await page.locator(panelMachineDetailSelector).boundingBox();
        expect(expandedBox?.width ?? 0).toBeGreaterThan(0);
        expect(expandedBox?.height ?? 0).toBeGreaterThan(0);
        const decisionOption = panelDecision.locator('[data-action-id$=":option:approve"]');
        await decisionOption.scrollIntoViewIfNeeded();
        await expect(decisionOption).toBeVisible();
        const decisionOptionHit = await decisionOption.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const topmost = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          return topmost !== null && (topmost === element || element.contains(topmost));
        });
        expect(decisionOptionHit, `decision option reachable @320 panel ${theme} text-only`).toBe(true);
        await decisionOption.click({ trial: true });
        await captureViewport(page, `${theme}-text-only-zoom-200-container-320`, `${theme}: actual 200% text-only zoom, notification panel at 320px`);
      } finally {
        await page.close();
      }
    }
  });

  test('proposal prose and the bell pointer are readable in both themes (expanded review included)', async ({ browser }) => {
    for (const theme of ['light', 'dark'] as const) {
      for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
          const seed = await seedBoard(page, fixtureSnapshot(), proposalReviewView());
          await pairAndOpenBoard(page);
          if (theme === 'dark') {
            await page.locator('#theme-toggle').click();
            await expect(page.locator('html')).toHaveClass(/dark/);
          }
          await settled(page);
          expect(seed.pageErrors).toEqual([]);
          const row = page.locator('#board-owner [data-proposal-id="proposal-1"]');
          await expect(row).toBeVisible();
          // Prose is mixed-case readable text, never the label treatment.
          const context = row.locator('.board-owner__context');
          await expect(context).toContainText('Two lessons changed');
          expect(await context.evaluate((element) => getComputedStyle(element).textTransform)).toBe('none');
          expect(await row.locator('.board-owner__consequence').evaluate((element) => getComputedStyle(element).textTransform)).toBe('none');
          // The prose owns its grid track: its box must NOT intersect the
          // metadata label's box (the stacked-cell overlap is the R1 bug).
          const metaBox = await row.locator('.board-owner__meta').boundingBox();
          const contextBox = await context.boundingBox();
          expect(metaBox).not.toBeNull();
          expect(contextBox).not.toBeNull();
          const metaBottom = metaBox!.y + metaBox!.height;
          const contextBottom = contextBox!.y + contextBox!.height;
          const overlap = metaBox!.y < contextBottom && contextBox!.y < metaBottom;
          expect(overlap, `${theme} @${width}: proposal context overlaps its label`).toBe(false);
          // The review loads on open: readable lesson text, nonzero geometry.
          await row.locator('.board-owner__review > summary').click();
          const reviewText = row.locator('.board-owner__review-text').first();
          await expect(reviewText).toContainText('Close the shell first');
          expect(await reviewText.evaluate((element) => getComputedStyle(element).textTransform)).toBe('none');
          const reviewBox = await reviewText.boundingBox();
          expect(reviewBox?.width ?? 0).toBeGreaterThan(0);
          expect(reviewBox?.height ?? 0).toBeGreaterThan(0);
          // Accept/Reject survive the readability fix.
          await expect(row.locator('.board-owner__accept')).toBeVisible();
          await expect(row.locator('.board-owner__reject')).toBeVisible();
          const rowOverflow = await overflows(page, '#board-owner [data-proposal-id="proposal-1"]');
          expect(rowOverflow.scrollWidth).toBeLessThanOrEqual(rowOverflow.clientWidth + 1);
          expect(await bodyOverflow(page)).toBeLessThanOrEqual(0);
          // The bell copy is a readable pointer, not a label line.
          await clickBell(page);
          const pointer = page.locator('#notification-list .board-owner__pointer-text');
          await expect(pointer).toContainText('Review the changes and decide in FOR YOU');
          expect(await pointer.evaluate((element) => getComputedStyle(element).textTransform)).toBe('none');
          const pointerMeta = await page.locator('#notification-list .board-owner__meta').boundingBox();
          const pointerBox = await pointer.boundingBox();
          expect(pointerMeta).not.toBeNull();
          expect(pointerBox).not.toBeNull();
          const pointerOverlap =
            pointerMeta!.y < pointerBox!.y + pointerBox!.height && pointerBox!.y < pointerMeta!.y + pointerMeta!.height;
          expect(pointerOverlap, `${theme} @${width}: pointer text overlaps its label`).toBe(false);
          await captureViewport(page, `${theme}-proposal-width-${width}`, `${theme}: proposal review expanded at ${width}px`);
        } finally {
          await page.close();
        }
      }
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

  test('stale decision conflicts use the HTTP reason and lock mouse/keyboard retries until refresh', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const refreshRelease: { current: (() => void) | null } = { current: null };
    let refreshRequests = 0;
    let decisionPosts = 0;
    const refreshGate = new Promise<void>((resolve) => {
      refreshRelease.current = resolve;
    });
    const seedSnapshot = fixtureSnapshot();
    const authoritativeSnapshot = fixtureSnapshot({
      notifications: seedSnapshot.notifications.map((notification) =>
        notification.id === 'decision-1'
          ? { ...notification, decidedAt: '2026-10-12T00:00:00.000Z', decidedBy: 'other-view', decidedOption: 'keep' }
          : notification,
      ),
    });
    try {
      const seed = await seedBoard(page, seedSnapshot);
      await pairAndOpenBoard(page);
      await page.route('**/api/board', async (route) => {
        refreshRequests += 1;
        await refreshGate;
        await route.fulfill({ json: authoritativeSnapshot });
      });
      await page.route('**/api/notifications/*/decision', (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        decisionPosts += 1;
        return route.fulfill({
          status: 409,
          json: {
            error: 'decision_refused',
            code: 'decision_recorded',
            detail: 'the decision was already recorded elsewhere',
          },
        });
      });

      const choice = page.locator('#board-owner [data-notification-id="decision-1"] [data-action-id$=":option:approve"]');
      await choice.click();
      await expect.poll(() => decisionPosts).toBe(1);
      await expect.poll(() => refreshRequests).toBe(1);
      await expect(page.locator('#board-owner [data-notification-id="decision-1"] .board-notification__submission--reconciling')).toBeVisible();
      const lockedChoice = page.locator('#board-owner [data-notification-id="decision-1"] [data-action-id$=":option:approve"]');
      await expect(lockedChoice).toHaveAttribute('aria-disabled', 'true');
      // A DOM mouse activation and real keyboard activation both reach the
      // listener despite aria-disabled; the submission guard must refuse them.
      await lockedChoice.evaluate((element) => (element as HTMLButtonElement).click());
      await lockedChoice.focus();
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      expect(decisionPosts).toBe(1);
      expect(seed.pageErrors).toEqual([]);

      // The real BoardClient fetches the authoritative snapshot and delivers
      // it through the production BoardView subscription. The new decision
      // must replace the stale card and clear its reconciliation lock.
      refreshRelease.current?.();
      const decisionCard = page.locator('#board-owner [data-notification-id="decision-1"]');
      await expect(decisionCard.locator('.board-notification__decided')).toContainText('Keep the current approach');
      await expect(decisionCard.locator('.board-notification__submission--reconciling')).toHaveCount(0);
      await expect(decisionCard.locator('[data-action-id$=":option:approve"]')).toHaveCount(0);
      expect(seed.pageErrors).toEqual([]);
    } finally {
      refreshRelease.current?.();
      await page.close();
    }
  });

  test('unknown_option keeps both owner surfaces locked across WebSocket A→B→A until the production HTTP refresh', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const initial = fixtureSnapshot();
    const decision = initial.notifications.find((notification) => notification.id === 'decision-1')?.decision;
    if (decision === null || decision === undefined) throw new Error('decision fixture is missing typed options');
    const withOptions = (options: typeof decision.options): BoardSnapshot =>
      fixtureSnapshot({
        notifications: initial.notifications.map((notification) =>
          notification.id === 'decision-1'
            ? { ...notification, decision: { ...decision, options } }
            : notification,
        ),
      });
    const snapshotB = withOptions([{ id: 'beta', label: 'Use plan B', consequence: 'The owner sees the updated alternative.' }]);
    const snapshotA = withOptions(decision.options);
    let refreshRequests = 0;
    let decisionPosts = 0;
    const releases: (() => void)[] = [];
    try {
      const seed = await seedBoard(page, initial);
      await pairAndOpenBoard(page);
      await seed.socketReady;
      await settled(page);
      await page.route('**/api/board', async (route) => {
        const requestNumber = ++refreshRequests;
        await new Promise<void>((resolve) => { releases[requestNumber - 1] = resolve; });
        await route.fulfill({ json: requestNumber === 1 ? snapshotB : snapshotA });
      });
      await page.route('**/api/notifications/*/decision', (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        decisionPosts += 1;
        return route.fulfill({
          status: 400,
          json: {
            error: 'decision_refused',
            code: 'unknown_option',
            detail: 'the decision options changed elsewhere',
          },
        });
      });

      const ownerCard = page.locator('#board-owner [data-notification-id="decision-1"]');
      await ownerCard.locator('[data-action-id$=":option:approve"]').click();
      await expect.poll(() => decisionPosts).toBe(1);
      await expect.poll(() => refreshRequests).toBe(1);
      await expect(ownerCard.locator('.board-notification__submission--reconciling')).toBeVisible();

      seed.push(snapshotB);
      await expect(ownerCard.locator('[data-action-id$=":option:beta"]')).toBeDisabled();
      seed.push(snapshotA);
      await expect(ownerCard.locator('[data-action-id$=":option:approve"]')).toHaveAttribute('aria-disabled', 'true');
      await page.locator('#notification-bell').click();
      const bellChoice = page.locator('#notification-list [data-notification-id="decision-1"] [data-action-id$=":option:approve"]');
      await expect(bellChoice).toHaveAttribute('aria-disabled', 'true');
      await expect(page.locator('#notification-list [data-notification-id="decision-1"] [data-action-id$=":option:keep"]')).toBeDisabled();

      // The first HTTP answer was asked for before the pushes, so BoardClient
      // must discard it and owe a second, current HTTP snapshot.
      releases[0]!();
      await expect.poll(() => refreshRequests).toBe(2);
      await expect(ownerCard.locator('.board-notification__submission--reconciling')).toBeVisible();
      releases[1]!();
      await expect(ownerCard.locator('[data-action-id$=":option:approve"]')).toBeEnabled();
      await expect(bellChoice).toBeEnabled();
      await expect(ownerCard.locator('.board-notification__submission--reconciling')).toHaveCount(0);
      expect(decisionPosts).toBe(1);
      expect(seed.pageErrors).toEqual([]);
    } finally {
      for (const release of releases) release?.();
      await page.close();
    }
  });

  test('a board disconnect keeps stale owner actions and panel receipts fenced until a fresh production snapshot', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const base = fixtureSnapshot();
    const initial = fixtureSnapshot({ notifications: [...base.notifications, feedNotification()] });
    const releases: (() => void)[] = [];
    let refreshRequests = 0;
    let decisionPosts = 0;
    let acknowledgementPosts = 0;
    const panelShownPosts: string[] = [];
    try {
      const seed = await seedBoard(page, initial);
      await page.route('**/api/notifications/*/shown', async (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        const body = route.request().postDataJSON() as { surface?: unknown };
        if (body.surface === 'web-panel') panelShownPosts.push(route.request().url());
        return route.fulfill({ status: 200, json: { ok: true } });
      });
      await pairAndOpenBoard(page);
      await seed.socketReady;
      await settled(page);

      const ownerChoice = page.locator('#board-owner [data-notification-id="decision-1"] [data-action-id$=":option:approve"]');
      const bellChoice = page.locator('#notification-list [data-notification-id="decision-1"] [data-action-id$=":option:approve"]');
      const seenAction = page.locator('#notification-list [data-notification-id="feed-1"] .board-notification__ack');
      await expect(ownerChoice).toBeEnabled();
      await expect(bellChoice).toBeEnabled();
      await expect(seenAction).toBeEnabled();
      await page.evaluate(() => {
        const owner = document.querySelector<HTMLButtonElement>(
          '#board-owner [data-notification-id="decision-1"] [data-action-id$=":option:approve"]',
        );
        const bell = document.querySelector<HTMLButtonElement>(
          '#notification-list [data-notification-id="decision-1"] [data-action-id$=":option:approve"]',
        );
        const seen = document.querySelector<HTMLButtonElement>(
          '#notification-list [data-notification-id="feed-1"] .board-notification__ack',
        );
        if (owner === null || bell === null || seen === null) throw new Error('live actions must be present before disconnect');
        const testWindow = window as Window & { __r7StaleChoices?: HTMLButtonElement[] };
        testWindow.__r7StaleChoices = [owner, bell, seen];
      });

      await page.route('**/api/board', async (route) => {
        const requestNumber = ++refreshRequests;
        await new Promise<void>((resolve) => { releases[requestNumber - 1] = resolve; });
        await route.fulfill({ json: initial });
      });
      await page.route('**/api/notifications/*/decision', (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        decisionPosts += 1;
        return route.fulfill({
          status: 400,
          json: { error: 'decision_refused', code: 'unknown_option', detail: 'a stale choice was submitted' },
        });
      });
      await page.route('**/api/notifications/*/ack', (route) => {
        if (route.request().method() !== 'POST') return route.fallback();
        acknowledgementPosts += 1;
        return route.fulfill({ status: 200, json: { ok: true } });
      });

      const reconnectedWithoutSnapshot = seed.holdNextBoardFrame();
      await seed.closeLatestSocket();
      await expect(page.locator('#conn-dot')).toHaveClass(/conn-dot--busy/u);
      await expect(ownerChoice).toHaveCount(0);
      await expect(bellChoice).toHaveCount(0);
      await expect(seenAction).toHaveCount(0);
      await expect(page.locator('#board-owner [data-notification-id="decision-1"] .board-notification__option-label')).toHaveCount(2);
      await expect(page.locator('#notification-list [data-notification-id="decision-1"] .board-notification__option-label')).toHaveCount(2);
      await expect.poll(() => seed.socketCount()).toBe(2);
      await reconnectedWithoutSnapshot;
      await expect(page.locator('#conn-dot')).toHaveClass(/conn-dot--busy/u);

      await page.evaluate(() => {
        const testWindow = window as Window & { __r7StaleChoices?: HTMLButtonElement[] };
        for (const choice of testWindow.__r7StaleChoices ?? []) choice.click();
      });
      expect(decisionPosts).toBe(0);
      expect(acknowledgementPosts).toBe(0);
      await clickBell(page);
      expect(panelShownPosts).toEqual([]); // stale panel opening is display, not a shown receipt

      // The reconnection itself is not enough: only its new board snapshot
      // restores the options, on both production-rendered owner surfaces.
      seed.pushLatest(initial);
      await expect(ownerChoice).toBeEnabled();
      await expect(bellChoice).toBeEnabled();
      await expect(seenAction).toBeEnabled();
      await expect(page.locator('#conn-dot')).toHaveClass(/conn-dot--open/u);
      expect(decisionPosts).toBe(0);
      expect(acknowledgementPosts).toBe(0);
      expect(refreshRequests).toBeGreaterThan(0);
      await expect.poll(() => panelShownPosts.length).toBeGreaterThan(0); // the open panel renders the fresh snapshot
      const freshPanelReceipts = panelShownPosts.length;
      await page.locator('#notification-bell').click();
      await expect(page.locator('#notification-panel')).toBeHidden();
      await page.locator('#notification-bell').click();
      await expect(page.locator('#notification-panel')).toBeVisible();
      expect(panelShownPosts).toHaveLength(freshPanelReceipts); // reopening does not duplicate the idempotent surface receipt
      expect(seed.pageErrors).toEqual([]);
    } finally {
      for (const release of releases) release?.();
      await page.close();
    }
  });

  test('Discuss with Gru opens the phone/tablet overlay with the default expanded preference', async ({ browser }) => {
    for (const width of [390, 768] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      try {
        const withDiscussion = fixtureSnapshot({
          notifications: [...fixtureSnapshot().notifications, discussionNotification()],
        });
        const seed = await seedBoard(page, withDiscussion);
        await pairAndOpenBoard(page);
        await settled(page);
        expect(await page.locator('#console').evaluate((element) => element.classList.contains('console--chat-collapsed'))).toBe(false);
        await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'false');
        await page.locator('#board-owner [data-notification-id="discuss-1"] .board-notification__discuss-open').click();
        await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'true');
        await expect(page.locator('#chat-input')).toBeFocused();
        expect(seed.pageErrors).toEqual([]);
      } finally {
        await page.close();
      }
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
