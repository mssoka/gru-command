import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test, type Browser, type Page, type WebSocketRoute } from '@playwright/test';
import {
  isValidSnapshot,
  parseBoardServerFrame,
  type BoardSnapshot,
  type JobView,
  type NotificationView,
  type PipelineEntryView,
} from '../src/lib/board-protocol.js';

/**
 * Compact owner-first board — browser geometry proof (owner approval
 * j-1064), synthetic fixtures only: a complete canonical snapshot seeded
 * on both the `/board/ws` push and the `GET /api/board` refetch; the
 * pairing flow runs against the real dev mock. No product/mock/fixture
 * code is touched by this spec, and no real owner control is clicked.
 *
 * Capture discipline (acceptance E): two honest kinds, both recorded in
 * `capture-manifest.json` with per-file sha256:
 *   - `viewport-*`          live viewport screenshots — the claimed
 *                           visibility/occlusion state (hit-tested).
 *   - `stitched-fullpage-*` Playwright fullPage renders of the expanded
 *                           document. Kept for continuity, labelled as
 *                           NOT viewport-visibility evidence: sticky
 *                           chrome and off-screen fixed overlays can
 *                           render at non-runtime positions by capture
 *                           mechanics alone (observed on the prior
 *                           attempt's images).
 *
 * Every attempt writes to its own uniquely named root (env override
 * `PIPELINE_BOARD_CAPTURE_ROOT`, else a UTC stamp + pid under the ignored
 * evidence base); the exact root is printed to the run output, so a later
 * gate attempt can never overwrite an earlier attempt's screenshots.
 *
 * This spec is authored, never run, by the source worker: scheduling
 * belongs to operations via the `pipeline-board-browser` [verify] scope.
 * Declared UNRUN — not a PASS.
 */

const MOCK_TOKEN = process.env.GRU_MOCK_TOKEN ?? 'dev-token';

const CAPTURE_BASE = path.join(
  import.meta.dirname,
  '..',
  '..',
  '_bmad-output',
  'silas-in-pipeline-queue-20261003',
);
const CAPTURE_ENV_ROOT = process.env.PIPELINE_BOARD_CAPTURE_ROOT;
const ATTEMPT_ROOT =
  CAPTURE_ENV_ROOT !== undefined && CAPTURE_ENV_ROOT.trim() !== ''
    ? path.resolve(CAPTURE_ENV_ROOT.trim())
    : path.join(CAPTURE_BASE, 'attempts', `${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`);
const MANIFEST_PATH = path.join(ATTEMPT_ROOT, 'capture-manifest.json');
// One line in the scheduled run output: the exact per-attempt root ops
// must read to find this attempt's captures and manifest.
console.log(`[pipeline-board] capture root: ${ATTEMPT_ROOT}`);

interface CaptureRecord {
  readonly file: string;
  readonly kind: 'viewport' | 'stitched-fullpage';
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
        note:
          'viewport-* = live viewport screenshots (the claimed visibility/occlusion state); ' +
          'stitched-fullpage-* = Playwright fullPage renders of the expanded/stitched document, ' +
          'NOT viewport-visibility evidence (sticky chrome and off-screen fixed overlays can render at non-runtime positions).',
        captures: captureRecords,
      },
      null,
      2,
    )}\n`,
  );
}

/** Record one produced capture with runtime viewport/theme and its hash.
 * Refuses a second record for the same relative file: one file identity,
 * one claim (the earlier attempt's overwritten-identity defect). */
async function recordCapture(
  page: Page,
  file: string,
  kind: CaptureRecord['kind'],
  state: string,
): Promise<void> {
  const runtime = await page.evaluate(() => ({
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  }));
  const relative = path.relative(ATTEMPT_ROOT, file);
  if (captureRecords.some((record) => record.file === relative)) {
    throw new Error(`duplicate capture identity ${relative} — every capture must be unique within an attempt`);
  }
  captureRecords.push({
    file: relative,
    kind,
    test: test.info().title,
    viewport: runtime.viewport,
    theme: runtime.theme,
    state,
    bytes: fs.statSync(file).size,
    sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
  });
  writeCaptureManifest();
}

/** Stable per-test slug for file identities: the full title path plus a
 * short digest, so two tests can never compose the same output path. */
function testSlug(): string {
  const titlePath = test.info().titlePath.join(' > ');
  const base = titlePath.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48);
  return `${base}-${createHash('sha1').update(titlePath).digest('hex').slice(0, 8)}`;
}

function selectorSlug(selector: string): string {
  return selector.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 48) || 'target';
}

/** Unique-within-attempt capture path; an existing path is a hard error —
 * never a silent re-use or overwrite of an earlier artifact. */
function uniqueCapturePath(kind: CaptureRecord['kind'], name: string): string {
  fs.mkdirSync(ATTEMPT_ROOT, { recursive: true });
  const file = path.join(ATTEMPT_ROOT, `${kind}-${testSlug()}-${name}.png`);
  if (fs.existsSync(file)) {
    throw new Error(`capture output already exists — refusing to overwrite an earlier artifact: ${file}`);
  }
  return file;
}

const T0 = '2026-10-03T00:00:00.000Z';

function job(id: string, status: string, title = `Heist ${id}`, updatedAt = T0): JobView {
  return {
    id,
    repo: 'pipeline-proof',
    title,
    status,
    updatedAt,
    prUrl: null,
    prState: null,
    baseBranch: 'main',
    note: null,
    rounds: [],
    lane: status === 'blocked' ? null : { branch: `gru/${id}`, sha: 'abc1234def5678', status: 'active', createdAt: T0 },
    lastAgentActivity: null,
  };
}

function entry(id: string, overrides: Partial<PipelineEntryView> = {}): PipelineEntryView {
  return {
    id,
    repo: 'pipeline-proof',
    title: `Approved brief ${id}`,
    priority: 5,
    enqueueSeq: 1,
    state: 'waiting',
    reason: 'waiting for p-dep to be merged (now in-review)',
    queuedAt: T0,
    ...overrides,
  };
}

const OWNER_NOTICE: NotificationView = {
  id: 'owner-proof-1',
  ts: T0,
  kind: 'test.owner-proof',
  routing: 'needs-owner',
  severity: 'info',
  title: 'Synthetic owner decision (fixture)',
  detail: 'never clicked by this spec',
  agentId: null,
  shownAt: null,
  ackedAt: null,
  resolvedAt: null,
  resolvedBy: null,
};

/** Six sections at once, every one exceeding (or at) its preview: In
 * flight 7, Pipeline 6, For Gru 3, Settled 5, Cold 4, For you 1. */
function proofSnapshot(): BoardSnapshot {
  const jobs: JobView[] = [
    ...Array.from({ length: 7 }, (_, index) => job(`flight-${index}`, 'in-review', `In-flight heist ${index} with a deliberately long title for wrapping`)),
    ...Array.from({ length: 3 }, (_, index) => job(`machine-${index}`, 'blocked', `Blocked machine heist ${index}`)),
    ...Array.from({ length: 5 }, (_, index) => job(`settled-${index}`, 'delivered', `Settled heist ${index}`, `2026-10-0${5 - index}T00:00:00.000Z`)),
    ...Array.from({ length: 4 }, (_, index) => job(`cold-${index}`, 'parked', `Cold heist ${index}`)),
  ];
  const entries: PipelineEntryView[] = [
    entry('p1', { priority: 0, enqueueSeq: 1, state: 'ready', reason: null, title: 'Ready approved brief — capacity free' }),
    entry('p2', { priority: 0, enqueueSeq: 2, reason: 'owner hold: waiting on the owner decision' }),
    entry('p3', { priority: 1, enqueueSeq: 3, reason: 'prerequisite p-dead cancelled' }),
    entry('p4', { priority: 2, enqueueSeq: 4, reason: 'dependency cycle: p4 → p5 → p4' }),
    entry('p5', { priority: 3, enqueueSeq: 5, reason: 'exclusive scope "repo:pipeline-proof" held by p1' }),
    entry('p6', { priority: 4, enqueueSeq: 6, reason: 'waiting for p-ghost — not enqueued' }),
  ];
  return {
    repos: [{ name: 'pipeline-proof', jobs }],
    agents: [],
    notifications: [OWNER_NOTICE],
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: 'disabled',
      model: '~typesafe/jev-latest',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'pipeline-proof-incarnation',
      generation: 0,
    },
    unackedActionRequired: 0,
    unackedNeedsOwner: 1,
    wakes: { count: 0, lastAt: null },
    pipeline: { entries, pending: entries.length },
  };
}

interface Seed {
  readonly pageErrors: Error[];
  push(snapshot: BoardSnapshot): void;
}

const LONG_TOKEN = 'x'.repeat(120);

/** Large-count + long-label fixture (acceptance E: "exercise long labels,
 * large counts"): In flight 26, Pipeline 26, For Gru 9, Settled 21, Cold
 * 12, For you 1 — every section above its preview limit, with an
 * unbreakable token in titles/reasons to prove `overflow-wrap` reflow. */
function largeSnapshot(): BoardSnapshot {
  const stamp = (index: number): string => new Date(Date.parse(T0) + (1000 - index) * 60_000).toISOString();
  const longLabel = (index: number): string => `Long-label heist ${index} — ${LONG_TOKEN} — one wrapping row`;
  const jobs: JobView[] = [
    ...Array.from({ length: 26 }, (_, index) => job(`flight-${index}`, 'in-review', longLabel(index), stamp(index))),
    ...Array.from({ length: 9 }, (_, index) => job(`machine-${index}`, 'blocked', longLabel(100 + index), stamp(100 + index))),
    ...Array.from({ length: 21 }, (_, index) => job(`settled-${index}`, 'delivered', longLabel(200 + index), stamp(200 + index))),
    ...Array.from({ length: 12 }, (_, index) => job(`cold-${index}`, 'parked', longLabel(300 + index), stamp(300 + index))),
  ];
  const waitingReasons = [
    `owner hold: deciding on ${LONG_TOKEN}`,
    `waiting for p-ghost — not enqueued (${LONG_TOKEN})`,
    `prerequisite p-dead cancelled after ${LONG_TOKEN}`,
    `dependency cycle: p4 → p5 → p4 (${LONG_TOKEN})`,
    `exclusive scope "repo:${LONG_TOKEN}" held by p1`,
  ];
  const entries: PipelineEntryView[] = Array.from({ length: 26 }, (_, index) =>
    entry(`p${index + 1}`, {
      priority: index % 5,
      enqueueSeq: index + 1,
      state: index === 0 ? 'ready' : 'waiting',
      reason: index === 0 ? null : waitingReasons[index % waitingReasons.length] ?? null,
      title: `Approved brief ${index + 1} — ${LONG_TOKEN}`,
    }),
  );
  return {
    repos: [{ name: 'pipeline-proof', jobs }],
    agents: [],
    notifications: [OWNER_NOTICE],
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: 'disabled',
      model: '~typesafe/jev-latest',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'pipeline-proof-incarnation',
      generation: 0,
    },
    unackedActionRequired: 0,
    unackedNeedsOwner: 1,
    wakes: { count: 0, lastAt: null },
    pipeline: { entries, pending: entries.length },
  };
}

/** Seed BOTH board channels so a later HTTP refetch cannot replace the
 * synthetic board, and keep the socket for deliberate re-pushes. */
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
  await expect(page.locator('#board-nav')).toBeVisible();
}

async function bodyOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Stitched full-document capture (continuity only): fullPage renders are
 * explicitly NOT viewport-visibility evidence. */
async function capture(page: Page, name: string, state = 'full-document render'): Promise<void> {
  const file = uniqueCapturePath('stitched-fullpage', name);
  await page.screenshot({ path: file, fullPage: true });
  await recordCapture(page, file, 'stitched-fullpage', state);
}

/** Live viewport capture: the claimed on-screen state at this moment. */
async function captureViewport(page: Page, name: string, state = 'viewport'): Promise<void> {
  const file = uniqueCapturePath('viewport', name);
  await page.screenshot({ path: file, fullPage: false });
  await recordCapture(page, file, 'viewport', state);
}

interface HitTarget {
  readonly found: boolean;
  readonly inViewport: boolean;
  readonly hit: boolean;
}

/** Center hit-target + viewport containment for one selector: the live
 * occlusion check (sticky chrome, drawer or any other element covering
 * the control fails the hit test). */
async function hitTarget(page: Page, selector: string): Promise<HitTarget> {
  return page.evaluate((sel) => {
    const element = document.querySelector<HTMLElement>(sel);
    if (element === null) return { found: false, inViewport: false, hit: false };
    const rect = element.getBoundingClientRect();
    const topmost = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return {
      found: true,
      // Strict full-viewport containment (unchanged acceptance): negative
      // top/left or any coordinate past the right/bottom edge fails, and
      // occlusion is the separate strict `hit` check.
      inViewport:
        rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight,
      hit: topmost !== null && (topmost === element || element.contains(topmost)),
    };
  }, selector);
}

/** Make a control actually reachable before the strict containment probe:
 * keep the browser's minimal placement, then iteratively correct residual
 * edge overflow (three of the four preserved b86af16 RED failures — run
 * f6998e40 — were this 0<1px bottom sliver; the fourth was the stale fixed
 * nav bound replaced at 065bbf6; 52b744fa is the later relaxed-green
 * masking run, never the failure) and sticky-chrome occlusion with
 * explicit scrolls — the scroll a real user would perform. Handles a cover
 * above OR below the control. Bounded; if the control cannot be cleared,
 * the strict probe below still fails truthfully. The oracle admits nothing
 * off-viewport. */
async function scrollFullyIntoView(page: Page, selector: string): Promise<void> {
  await page
    .locator(selector)
    .first()
    .evaluate((el) => {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const pad = 8;
      for (let i = 0; i < 6; i += 1) {
        const rect = el.getBoundingClientRect();
        const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const covered = !(top !== null && (top === el || el.contains(top)));
        if (covered && top !== null) {
          // Score both escape directions against the covering element and
          // take the feasible smaller move: down (scroll up) when the cover
          // sits above the control, up (scroll down) when it sits below.
          const cover = top.getBoundingClientRect();
          const downNeed = Math.max(0, cover.bottom + pad - rect.top);
          const upNeed = Math.max(0, rect.bottom - (cover.top - pad));
          const roomDown = Math.max(0, window.innerHeight - pad - rect.bottom);
          const roomUp = Math.max(0, rect.top - pad);
          const canDown = downNeed > 0.5 && downNeed <= roomDown;
          const canUp = upNeed > 0.5 && upNeed <= roomUp;
          if (canDown && (!canUp || downNeed <= upNeed)) {
            window.scrollBy(0, -downNeed);
            continue;
          }
          if (canUp) {
            window.scrollBy(0, upNeed);
            continue;
          }
          break;
        }
        if (rect.bottom > window.innerHeight - pad) {
          window.scrollBy(0, rect.bottom - (window.innerHeight - pad));
          continue;
        }
        if (rect.top < pad) {
          window.scrollBy(0, rect.top - pad);
          continue;
        }
        break;
      }
    });
}

async function expectReachable(page: Page, selector: string): Promise<void> {
  const target = await hitTarget(page, selector);
  if (!target.found || !target.inViewport || !target.hit) {
    // Evidence FIRST (a unique live viewport capture + geometry/occluder
    // sidecar at the failing instant), then the strict oracle still fails
    // the test: diagnostics never mask a genuinely covered target.
    await collectFailureContext(page, selector);
  }
  expect(target.found, `missing ${selector}`).toBe(true);
  expect(target.inViewport, `${selector} fully inside the viewport`).toBe(true);
  expect(target.hit, `${selector} center is the topmost hit target (not covered)`).toBe(true);
}

/** Failure-instant evidence for a covered/unreachable target: which
 * element is topmost at the center and the full hit stack, target/chrome/
 * nav/band-head rectangles, scroll offsets and computed scroll styles,
 * plus a two-frame re-measure that distinguishes a stale measurement from
 * real coverage. Written only when the strict oracle is about to fail. */
async function collectFailureContext(page: Page, selector: string): Promise<void> {
  fs.mkdirSync(ATTEMPT_ROOT, { recursive: true });
  const base = path.join(
    ATTEMPT_ROOT,
    `failure-${testSlug()}-${selectorSlug(selector)}-${Date.now()}`,
  );
  if (fs.existsSync(`${base}.json`) || fs.existsSync(`${base}.png`)) {
    throw new Error(`failure-context path already exists — refusing to overwrite: ${base}`);
  }
  const probe = await page.evaluate((sel) => {
    const describe = (element: Element | null): string => {
      if (element === null) return 'null';
      const id = element.id === '' ? '' : `#${element.id}`;
      const classes =
        typeof element.className === 'string' && element.className.trim() !== ''
          ? `.${element.className.trim().split(/\s+/u).join('.')}`
          : '';
      return `${element.tagName.toLowerCase()}${id}${classes}`;
    };
    const rectOf = (element: Element | null): { x: number; y: number; width: number; height: number } | null => {
      if (element === null) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    const target = document.querySelector<HTMLElement>(sel);
    if (target === null) {
      return { selector: sel, target: null, note: 'target missing at failure time' };
    }
    const box = target.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const band = target.closest('.board-band');
    const head = band?.querySelector('.board-band__head') ?? null;
    const targetStyle = getComputedStyle(target);
    const htmlStyle = getComputedStyle(document.documentElement);
    return {
      selector: sel,
      target: {
        element: describe(target),
        rect: rectOf(target),
        isActiveElement: document.activeElement === target,
        scrollMarginTop: targetStyle.scrollMarginTop,
        position: targetStyle.position,
      },
      center: { x: cx, y: cy },
      hitStack: document.elementsFromPoint(cx, cy).slice(0, 8).map((element) => ({
        element: describe(element),
        rect: rectOf(element),
      })),
      scroll: {
        x: window.scrollX,
        y: window.scrollY,
        documentHeight: document.documentElement.scrollHeight,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      },
      chrome: {
        commandBar: rectOf(document.getElementById('command-bar')),
        chipRail: rectOf(document.getElementById('chip-rail')),
        nav: rectOf(document.getElementById('board-nav')),
      },
      bandHead: head === null ? null : { element: describe(head), rect: rectOf(head) },
      activeElement: describe(document.activeElement),
      html: {
        scrollPaddingTop: htmlStyle.scrollPaddingTop,
        scrollBehavior: htmlStyle.scrollBehavior,
      },
    };
  }, selector);
  const settled = await page.evaluate(async (sel) => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const target = document.querySelector<HTMLElement>(sel);
    if (target === null) return { rect: null, topmost: null, hit: false };
    const box = target.getBoundingClientRect();
    const topmost = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
      topmost: topmost === null ? null : `${topmost.tagName.toLowerCase()}${topmost.id === '' ? '' : `#${topmost.id}`}`,
      hit: topmost !== null && (topmost === target || target.contains(topmost)),
    };
  }, selector);
  fs.writeFileSync(
    `${base}.json`,
    `${JSON.stringify({ capturedAt: new Date().toISOString(), test: test.info().title, probe, settled }, null, 2)}\n`,
  );
  await page.screenshot({ path: `${base}.png`, fullPage: false });
  await recordCapture(page, `${base}.png`, 'viewport', `failure context for ${selector} (sidecar ${path.basename(base)}.json)`);
}

/** The six-section order as the DOM presents it (owner mount first). */
async function sectionOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const order: string[] = [];
    const owner = document.getElementById('board-owner');
    if (owner !== null) order.push('for-you');
    for (const section of document.querySelectorAll<HTMLElement>('#board-jobs [data-section]')) {
      order.push(section.dataset.section ?? '');
    }
    return order;
  });
}

const NAV_IDS = ['for-you', 'in-flight', 'pipeline', 'for-gru', 'settled', 'cold'] as const;

interface ViewportCase {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

/** One real-viewport proof: order, default density, sticky reachability at
 * an anchor jump, disclosure expansion and focused-target occlusion — with
 * live viewport captures at every claimed state (plus one labelled stitched
 * render for continuity). Phone cases also exercise the EXISTING chat
 * overlay controls (FAB opens, grip closes) with both states recorded; no
 * chat policy, header or drawer design is changed. */
async function viewportProof(browser: Browser, viewportCase: ViewportCase, theme: 'light' | 'dark'): Promise<void> {
  const { name, width, height } = viewportCase;
  const page = await browser.newPage({ viewport: { width, height } });
  try {
    const seed = await seedBoard(page, proofSnapshot());
    await pairAndOpenBoard(page);
    if (theme === 'dark') {
      await page.locator('#theme-toggle').click();
      await expect(page.locator('html')).toHaveClass(/dark/);
    }
    expect(seed.pageErrors).toEqual([]);
    expect(await sectionOrder(page)).toEqual([...NAV_IDS]);

    // The existing chat drawer is CLOSED here (the fixture never opens it
    // and the spec does not click an opener): record the state rather than
    // assume it; the stitched artifact of a prior attempt rendered it at a
    // non-runtime position, which is why viewport captures are the proof.
    const sheetState = (await page.locator('#chat-sheet').getAttribute('data-open')) ?? 'missing';
    expect(sheetState).toBe('false');
    await expect.poll(() => bodyOverflow(page)).toBeLessThanOrEqual(0);
    for (const nav of NAV_IDS) await expectReachable(page, `#board-nav .board-nav__link[data-nav="${nav}"]`);
    await captureViewport(page, `${name}-${theme}-defaults`, `default density viewport (chat sheet data-open=${sheetState})`);
    await capture(page, `${name}-${theme}-defaults`, 'stitched full-document render (not viewport evidence)');

    // Sticky reachability: an anchor jump lands the settled head below the
    // pinned strip, and the shortcut itself stays an uncovered hit target.
    await page.locator('#board-nav .board-nav__link[data-nav="settled"]').click();
    await expect
      .poll(async () => {
        const navBox = await page.locator('#board-nav').boundingBox();
        const headBox = await page.locator('#board-section-settled .board-band__head').boundingBox();
        if (navBox === null || headBox === null) return Number.NaN;
        return headBox.y - (navBox.y + navBox.height);
      })
      .toBeGreaterThanOrEqual(-2);
    await expectReachable(page, '#board-nav .board-nav__link[data-nav="settled"]');
    await expectReachable(page, '.board-band--settled .board-band__head');
    await captureViewport(page, `${name}-${theme}-settled-jump`, 'scrolled anchor-jump viewport');

    // Disclosure state: the clicks themselves are actionability/occlusion
    // checks; the expanded rows and the focused toggle must stay uncovered.
    await page.locator('.board-band--pipeline .board-band__more').click();
    await expect(page.locator('.board-band--pipeline .board-pipeline')).toHaveCount(6);
    await page.locator('.board-band--cold .board-band__more').click();
    await expect(page.locator('.board-band--cold .board-job')).toHaveCount(4);
    await scrollFullyIntoView(page, '.board-band--cold .board-job');
    await expectReachable(page, '.board-band--cold .board-job');
    await page.locator('.board-band--cold .board-band__more').focus();
    await expect(page.locator('.board-band--cold .board-band__more')).toBeFocused();
    await scrollFullyIntoView(page, '.board-band--cold .board-band__more');
    await expectReachable(page, '.board-band--cold .board-band__more');
    // Every section disclosure control, focused in turn: a focused target
    // that a sticky chrome/drawer covered would fail its hit test.
    for (const [label, band] of [
      ['in-flight', '.board-band--in-flight'],
      ['pipeline', '.board-band--pipeline'],
      ['for-gru', '.board-band--needs-you'],
      ['settled', '.board-band--settled'],
      ['cold', '.board-band--cold'],
    ] as const) {
      const selector = `${band} .board-band__more`;
      await page.locator(selector).focus();
      await expect(page.locator(selector), `${label} toggle focus`).toBeFocused();
      await scrollFullyIntoView(page, selector);
      await expectReachable(page, selector);
    }
    await captureViewport(page, `${name}-${theme}-expanded-focus`, 'expanded + focused-target viewport');

    if (name.startsWith('phone')) {
      // Existing overlay controls, exercised with both states recorded.
      await page.locator('#gru-fab').click();
      await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'true');
      await captureViewport(page, `${name}-${theme}-chat-open-recorded`, 'recorded overlay state (chat open via FAB; not a board defect state)');
      await page.locator('#chat-sheet-grip').click();
      await expect(page.locator('#chat-sheet')).toHaveAttribute('data-open', 'false');
      await expectReachable(page, '#board-nav .board-nav__link[data-nav="cold"]');
      await captureViewport(page, `${name}-${theme}-chat-closed`, 'overlay closed via grip; board controls reachable');
    }
  } finally {
    await page.close();
  }
}

/** Large-count + long-label proof for one viewport (acceptance E). */
async function largeCountsProof(browser: Browser, viewportCase: ViewportCase): Promise<void> {
  const page = await browser.newPage({ viewport: { width: viewportCase.width, height: viewportCase.height } });
  try {
    const seed = await seedBoard(page, largeSnapshot());
    await pairAndOpenBoard(page);
    expect(seed.pageErrors).toEqual([]);
    expect(await sectionOrder(page)).toEqual([...NAV_IDS]);

    // Full authoritative counts (26/26/9/21/12) with bounded previews
    // (5/5/3/0/0) and an unbreakable 120-char token in every label.
    await expect(page.locator('.board-band--in-flight .board-band__count')).toHaveText('26 heists');
    await expect(page.locator('.board-band--pipeline .board-band__count')).toHaveText('26 queued');
    await expect(page.locator('.board-band--needs-you .board-band__count')).toHaveText('9 heists');
    await expect(page.locator('.board-band--settled .board-band__count')).toHaveText('21 heists');
    await expect(page.locator('.board-band--cold .board-band__count')).toHaveText('12 heists');
    await expect(page.locator('#board-nav .board-nav__link[data-nav="pipeline"] .board-nav__count')).toHaveText('26');
    await expect(page.locator('.board-band--in-flight .board-job')).toHaveCount(5);
    await expect(page.locator('.board-band--pipeline .board-pipeline')).toHaveCount(5);
    await expect(page.locator('.board-band--settled .board-job')).toHaveCount(3);
    await expect(page.locator('.board-band--needs-you .board-job')).toHaveCount(0);
    await expect(page.locator('.board-band--cold .board-job')).toHaveCount(0);
    await expect.poll(() => bodyOverflow(page)).toBeLessThanOrEqual(0);
    await captureViewport(page, `${viewportCase.name}-light-largecounts-defaults`, 'large counts default density viewport');
    await capture(page, `${viewportCase.name}-light-largecounts-defaults`, 'stitched full-document render (not viewport evidence)');

    // Reversible disclosures reach every hidden row; long labels never
    // force horizontal overflow.
    await page.locator('.board-band--in-flight .board-band__more').click();
    await expect(page.locator('.board-band--in-flight .board-job')).toHaveCount(26);
    await page.locator('.board-band--pipeline .board-band__more').click();
    await expect(page.locator('.board-band--pipeline .board-pipeline')).toHaveCount(26);
    await page.locator('.board-band--needs-you .board-band__more').click();
    await expect(page.locator('.board-band--needs-you .board-job')).toHaveCount(9);
    await page.locator('.board-band--settled .board-band__more').click();
    await expect(page.locator('.board-band--settled .board-job')).toHaveCount(21);
    await page.locator('.board-band--cold .board-band__more').click();
    await expect(page.locator('.board-band--cold .board-job')).toHaveCount(12);
    await expect.poll(() => bodyOverflow(page)).toBeLessThanOrEqual(0);
    await expectReachable(page, '#board-nav .board-nav__link[data-nav="pipeline"]');
    await captureViewport(page, `${viewportCase.name}-light-largecounts-expanded`, 'large counts fully expanded viewport');
  } finally {
    await page.close();
  }
}

test.describe('compact owner-first board — synthetic geometry proof', () => {
  test('desktop 1440: exact six-section order, bounded previews, reversible disclosures', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const seed = await seedBoard(page, proofSnapshot());
    await pairAndOpenBoard(page);
    expect(seed.pageErrors).toEqual([]);

    expect(await sectionOrder(page)).toEqual(['for-you', 'in-flight', 'pipeline', 'for-gru', 'settled', 'cold']);

    // The strip: labelled counts, exact order, real targets.
    const navLinks = page.locator('#board-nav .board-nav__link');
    await expect(navLinks).toHaveCount(6);
    await expect(navLinks.nth(0)).toContainText('For you');
    await expect(navLinks.nth(1)).toContainText('In flight');
    await expect(navLinks.nth(2)).toContainText('Pipeline');
    await expect(navLinks.nth(3)).toContainText('For Gru');
    await expect(navLinks.nth(4)).toContainText('Settled');
    await expect(navLinks.nth(5)).toContainText('Cold');

    // Default density: 5 / 5 / 3 / 0 / 0 rows; full counts on the heads.
    await expect(page.locator('.board-band--in-flight .board-job')).toHaveCount(5);
    await expect(page.locator('.board-band--pipeline .board-pipeline')).toHaveCount(5);
    await expect(page.locator('.board-band--needs-you .board-job')).toHaveCount(0);
    await expect(page.locator('.board-band--settled .board-job')).toHaveCount(3);
    await expect(page.locator('.board-band--cold .board-job')).toHaveCount(0);
    await expect(page.locator('.board-band--in-flight .board-band__count')).toHaveText('7 heists');
    await expect(page.locator('.board-band--pipeline .board-band__count')).toHaveText('6 queued');
    await expect(page.locator('.board-band--needs-you .board-band__count')).toHaveText('3 heists');
    await expect(page.locator('.board-band--cold .board-band__count')).toHaveText('4 heists');

    // Waiting reasons are exact plain text; the ready row carries no reason.
    await expect(page.locator('.board-band--pipeline .board-pipeline').nth(0)).toHaveAttribute('data-state', 'ready');
    await expect(page.locator('.board-band--pipeline .board-pipeline').nth(1).locator('.board-pipeline__reason')).toHaveText(
      'owner hold: waiting on the owner decision',
    );

    await expect.poll(() => bodyOverflow(page)).toBeLessThanOrEqual(0);
    await capture(page, 'desktop-1440-light-defaults');

    // Reversible disclosures: expand everything, then collapse.
    await page.locator('.board-band--in-flight .board-band__more').click();
    await expect(page.locator('.board-band--in-flight .board-job')).toHaveCount(7);
    await page.locator('.board-band--pipeline .board-band__more').click();
    await expect(page.locator('.board-band--pipeline .board-pipeline')).toHaveCount(6);
    await page.locator('.board-band--needs-you .board-band__more').click();
    await expect(page.locator('.board-band--needs-you .board-job')).toHaveCount(3);
    await page.locator('.board-band--cold .board-band__more').click();
    await expect(page.locator('.board-band--cold .board-job')).toHaveCount(4);
    await page.locator('.board-band--settled .board-band__more').click();
    await expect(page.locator('.board-band--settled .board-job')).toHaveCount(5);
    await expect.poll(() => bodyOverflow(page)).toBeLessThanOrEqual(0);
    await capture(page, 'desktop-1440-light-expanded');

    // Collapse Cold again: zero rows, retained count.
    await page.locator('.board-band--cold .board-band__more').click();
    await expect(page.locator('.board-band--cold .board-job')).toHaveCount(0);
    await expect(page.locator('.board-band--cold .board-band__count')).toHaveText('4 heists');

    // Dark theme keeps the same geometry.
    await page.locator('#theme-toggle').click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(page.locator('.board-band--pipeline .board-pipeline')).toHaveCount(6);
    await expect.poll(() => bodyOverflow(page)).toBeLessThanOrEqual(0);
    await capture(page, 'desktop-1440-dark-expanded');
  });

  test('live push preserves focus and disclosure state on a real control', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const snapshot = proofSnapshot();
    const seed = await seedBoard(page, snapshot);
    await pairAndOpenBoard(page);

    const more = page.locator('.board-band--pipeline .board-band__more');
    await more.click();
    await expect(page.locator('.board-band--pipeline .board-pipeline')).toHaveCount(6);
    await expect(more).toBeFocused();
    await expect(more).toHaveAttribute('aria-expanded', 'true');

    seed.push(snapshot);
    await expect(page.locator('.board-band--pipeline .board-pipeline')).toHaveCount(6);
    await expect(page.locator('.board-band--pipeline .board-band__more')).toBeFocused();
    await expect(page.locator('.board-band--pipeline .board-band__more')).toHaveAttribute('aria-expanded', 'true');
  });

  test('tablet 768: no overflow, sticky strip reachable, shortcuts jump to labelled sections', async ({ page }) => {
    await page.setViewportSize({ width: 768, height: 1024 });
    const seed = await seedBoard(page, proofSnapshot());
    await pairAndOpenBoard(page);
    expect(seed.pageErrors).toEqual([]);
    expect(await sectionOrder(page)).toEqual(['for-you', 'in-flight', 'pipeline', 'for-gru', 'settled', 'cold']);
    await expect.poll(() => bodyOverflow(page)).toBeLessThanOrEqual(0);
    await capture(page, 'tablet-768-light-defaults');

    // Sticky reachability after scrolling deep into the board (a mid-list
    // position, not the absolute bottom where a sticky box may release at
    // its container edge).
    await page.locator('#board-section-settled').scrollIntoViewIfNeeded();
    const navBox = await page.locator('#board-nav').boundingBox();
    const railBox = await page.locator('#chip-rail').boundingBox();
    expect(navBox).not.toBeNull();
    expect(railBox).not.toBeNull();
    expect(navBox!.y).toBeGreaterThanOrEqual(0);
    // Pinned under the measured chrome: the nav's sticky top follows the
    // globally measured chrome height, so its top sits at the strip's
    // bottom edge — bounded on BOTH sides so neither an under-measured
    // chrome (nav overlapping the strip) nor a larger gap passes.
    const railBottom = railBox!.y + railBox!.height;
    expect(navBox!.y).toBeGreaterThanOrEqual(railBottom - 1);
    expect(navBox!.y).toBeLessThanOrEqual(railBottom + 1);

    // A shortcut jump lands the target in view and never under the strip.
    const coldLink = page.locator('#board-nav .board-nav__link[data-nav="cold"]');
    await coldLink.focus();
    await expect(coldLink).toBeFocused();
    const focusedBox = await coldLink.boundingBox();
    expect(focusedBox!.y).toBeGreaterThanOrEqual(0);
    await coldLink.click();
    await expect.poll(async () => {
      const box = await page.locator('#board-section-cold .board-band__head').boundingBox();
      return box === null ? Number.NaN : box.y;
    }).toBeGreaterThanOrEqual((navBox?.y ?? 0) + (navBox?.height ?? 0) - 2);
    await expect(page.locator('#board-section-cold .board-band__count')).toHaveText('4 heists');
    await capture(page, 'tablet-768-light-cold-jump');
  });

  test('phone 390 and 360: usable strip, no body overflow, disclosures still reachable', async ({ browser }) => {
    for (const width of [390, 360]) {
      // A fresh page per width: route seeding must not stack across
      // iterations.
      const page = await browser.newPage();
      await page.setViewportSize({ width, height: 844 });
      const seed = await seedBoard(page, proofSnapshot());
      await pairAndOpenBoard(page);
      expect(seed.pageErrors).toEqual([]);
      expect(await sectionOrder(page)).toEqual(['for-you', 'in-flight', 'pipeline', 'for-gru', 'settled', 'cold']);
      await expect.poll(() => bodyOverflow(page)).toBeLessThanOrEqual(0);

      // Every strip item is inside the viewport box (wrapped, not clipped).
      const navLinks = page.locator('#board-nav .board-nav__link');
      await expect(navLinks).toHaveCount(6);
      for (let index = 0; index < 6; index += 1) {
        const box = await navLinks.nth(index).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
      }
      // Long titles wrap instead of forcing overflow.
      await expect(page.locator('.board-band--in-flight .board-job')).toHaveCount(5);
      const more = page.locator('.board-band--in-flight .board-band__more');
      await more.scrollIntoViewIfNeeded();
      await more.click();
      await expect(page.locator('.board-band--in-flight .board-job')).toHaveCount(7);
      await expect.poll(() => bodyOverflow(page)).toBeLessThanOrEqual(0);
      await capture(page, `phone-${width}-light-expanded`);
      await page.locator('.board-band--in-flight .board-band__more').click();
      await expect(page.locator('.board-band--in-flight .board-job')).toHaveCount(5);
      await capture(page, `phone-${width}-light-collapsed`);
      await page.close();
    }
  });

  test('keyboard: strip links are reachable and toggle aria state without any operational request', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const seed = await seedBoard(page, proofSnapshot());
    await pairAndOpenBoard(page);
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.method() !== 'GET') requests.push(`${request.method()} ${request.url()}`);
    });
    await page.locator('#board-nav .board-nav__link[data-nav="pipeline"]').focus();
    await expect(page.locator('#board-nav .board-nav__link[data-nav="pipeline"]')).toBeFocused();
    await page.keyboard.press('Enter');
    const pipelineHead = await page.locator('#board-section-pipeline .board-band__head').boundingBox();
    expect(pipelineHead).not.toBeNull();
    // Reveal + navigation only: nothing was acked, approved or executed.
    expect(requests.filter((entry) => entry.includes('/api/pipeline'))).toEqual([]);
    expect(requests.filter((entry) => entry.includes('/api/board/notifications'))).toEqual([]);
    expect(seed.pageErrors).toEqual([]);
  });

  test('viewport visibility + hit targets: desktop 1440 (light)', async ({ browser }) => {
    await viewportProof(browser, { name: 'desktop-1440', width: 1440, height: 900 }, 'light');
  });

  test('viewport visibility + hit targets: tablet 768 (light)', async ({ browser }) => {
    await viewportProof(browser, { name: 'tablet-768', width: 768, height: 1024 }, 'light');
  });

  test('viewport visibility + hit targets: phone 390 (light, overlay controls recorded)', async ({ browser }) => {
    await viewportProof(browser, { name: 'phone-390', width: 390, height: 844 }, 'light');
  });

  test('viewport visibility + hit targets: phone 360 (light, overlay controls recorded)', async ({ browser }) => {
    await viewportProof(browser, { name: 'phone-360', width: 360, height: 800 }, 'light');
  });

  test('viewport visibility + hit targets: tablet 768 (dark)', async ({ browser }) => {
    await viewportProof(browser, { name: 'tablet-768', width: 768, height: 1024 }, 'dark');
  });

  test('viewport visibility + hit targets: phone 390 (dark, overlay controls recorded)', async ({ browser }) => {
    await viewportProof(browser, { name: 'phone-390', width: 390, height: 844 }, 'dark');
  });

  test('large counts + long labels: desktop 1440 (full counts, bounded previews, reversible disclosures)', async ({ browser }) => {
    await largeCountsProof(browser, { name: 'desktop-1440', width: 1440, height: 900 });
  });

  test('large counts + long labels: tablet 768 (full counts, bounded previews, reversible disclosures)', async ({ browser }) => {
    await largeCountsProof(browser, { name: 'tablet-768', width: 768, height: 1024 });
  });

  test('large counts + long labels: phone 390 (full counts, bounded previews, reversible disclosures)', async ({ browser }) => {
    await largeCountsProof(browser, { name: 'phone-390', width: 390, height: 844 });
  });

  test('zoom emulation 200% (disclosed): large counts reflow with full counts, bounded previews and reachable controls', async ({ browser }) => {
    // Disclosed method: browser-chrome zoom has no direct Playwright API;
    // the web-content equivalent is a halved CSS viewport at 2x device
    // pixel ratio (1440x900 physical at 200% zoom => 720x450 CSS pixels)
    // — a genuine reflow test, not a claim about the zoom UI itself.
    const context = await browser.newContext({ viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    try {
      const seed = await seedBoard(page, largeSnapshot());
      await pairAndOpenBoard(page);
      expect(seed.pageErrors).toEqual([]);
      expect(await sectionOrder(page)).toEqual([...NAV_IDS]);
      await expect(page.locator('.board-band--in-flight .board-band__count')).toHaveText('26 heists');
      await expect(page.locator('.board-band--in-flight .board-job')).toHaveCount(5);
      await expect(page.locator('.board-band--pipeline .board-pipeline')).toHaveCount(5);
      await expect(page.locator('.board-band--settled .board-job')).toHaveCount(3);
      await expect.poll(() => bodyOverflow(page)).toBeLessThanOrEqual(0);
      for (const nav of NAV_IDS) await expectReachable(page, `#board-nav .board-nav__link[data-nav="${nav}"]`);
      await captureViewport(page, 'zoom200-720x450-dpr2-light-defaults', 'disclosed 200% zoom emulation (halved CSS viewport, 2x DPR)');
    } finally {
      await context.close();
    }
  });
});
