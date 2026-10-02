import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';

/**
 * Lens-pill proof (ops-readiness-repair 2026-10-02, original scope only).
 *
 * Synthetic board snapshots are pushed into the page over an intercepted
 * `/board/ws` socket — the same `{ type: 'board', snapshot }` frame the
 * dev-only mock sends. No product, mock, style, or fixture code is
 * changed; the pairing flow still runs against the real dev mock. All
 * scenario data is generic (no real project names), mirroring the committed
 * DOM regression contract in src/ui/board.test.ts.
 *
 * Captures land in the ignored evidence root
 * `_bmad-output/ops-readiness-repair-20261002/captures/` for a genuine
 * vision reviewer. This spec is authored, never run, by the source worker:
 * scheduling belongs to operations via the `lens-unused-neutral-browser`
 * [verify] scope. Declared UNRUN — not a PASS.
 */

const MOCK_TOKEN = process.env.GRU_MOCK_TOKEN ?? 'dev-token';

const CAPTURE_DIR = path.join(
  import.meta.dirname,
  '..',
  '..',
  '_bmad-output',
  'ops-readiness-repair-20261002',
  'captures',
);

const NOT_USED_NOTE = 'not used — lead-owned whole-PR review';

interface LensRecord {
  lens: string;
  state: string;
  agentId: string | null;
  note: string | null;
  verdict: string | null;
}
interface LensAttempt {
  lens: string;
  attempts: number;
}
interface RoundRecord {
  id: string;
  seq: number;
  status: string;
  verdict: string | null;
  targetRef: string;
  createdAt: string;
  updatedAt: string;
  lensAttempts: LensAttempt[];
  blockers: number;
  lenses: LensRecord[];
}
interface JobRecord {
  id: string;
  repo: string;
  title: string;
  status: string;
  updatedAt: string;
  prUrl: null;
  prState: null;
  baseBranch: string;
  note: string | null;
  rounds: RoundRecord[];
  lane: {
    branch: string;
    sha: string;
    status: string;
    createdAt: string;
  };
  lastAgentActivity: string | null;
}

const T0 = '2026-10-02T00:00:00.000Z';

const notUsed = (lens: string): LensRecord => ({
  lens,
  state: 'done',
  agentId: null,
  note: NOT_USED_NOTE,
  verdict: 'clean',
});
const cleanDone = (lens: string): LensRecord => ({
  lens,
  state: 'done',
  agentId: null,
  note: 'clean — nothing found',
  verdict: 'clean',
});
const errored = (lens: string, note: string): LensRecord => ({
  lens,
  state: 'error',
  agentId: null,
  note,
  verdict: null,
});

function roundOf(
  id: string,
  seq: number,
  status: string,
  verdict: string | null,
  lenses: LensRecord[],
  lensAttempts: LensAttempt[],
  blockers: number,
): RoundRecord {
  return {
    id,
    seq,
    status,
    verdict,
    targetRef: 'abc1234',
    createdAt: T0,
    updatedAt: T0,
    lensAttempts,
    blockers,
    lenses,
  };
}

function jobOf(id: string, title: string, rounds: RoundRecord[]): JobRecord {
  return {
    id,
    repo: 'lens-proof',
    title,
    status: 'in-review',
    updatedAt: T0,
    prUrl: null,
    prState: null,
    baseBranch: 'main',
    note: null,
    rounds,
    lane: { branch: `gru/${id}`, sha: 'abc1234def5678', status: 'active', createdAt: T0 },
    lastAgentActivity: T0,
  };
}

function snapshotOf(jobs: JobRecord[]): unknown {
  return { repos: [{ name: 'lens-proof', jobs }] };
}

/** Screenshot round: three executed clean + four canonical unused. */
const FOUR_UNUSED = jobOf('lens-proof-neutral', 'Neutral pill proof — three specialists ran', [
  roundOf('lens-proof-neutral-r1', 1, 'verdict-posted', 'changes-requested', [
    cleanDone('blind'),
    cleanDone('edge'),
    cleanDone('tests'),
    notUsed('acceptance'),
    notUsed('security'),
    notUsed('architecture'),
    notUsed('codebase'),
  ], [], 0),
]);

/** Distinct honesty: four unused AND three genuine timeout failures. */
const FOUR_UNUSED_THREE_ERRORS = jobOf(
  'lens-proof-timeouts',
  'Timeout honesty proof — four unused, three failed',
  [
    roundOf('lens-proof-timeouts-r1', 1, 'verdict-posted', 'changes-requested', [
      notUsed('blind'),
      notUsed('acceptance'),
      notUsed('security'),
      notUsed('architecture'),
      errored('edge', 'specialist attempts failed: a1 timeout; a2 timeout'),
      errored('codebase', 'specialist attempts failed: a1 timeout'),
      errored('tests', 'specialist attempts failed: a1 timeout'),
    ], [
      { lens: 'edge', attempts: 2 },
      { lens: 'codebase', attempts: 1 },
      { lens: 'tests', attempts: 1 },
    ], 0),
  ],
);

/** Every honest state in one round: blocker, clean, legacy null note,
 * canonical unused, live, pending, error. */
const MIXED = jobOf('lens-proof-mixed', 'Mixed state proof — every honest state at once', [
  roundOf('lens-proof-mixed-r1', 1, 'live', null, [
    { lens: 'blind', state: 'done', agentId: null, note: 'blocker — unsafe retry path', verdict: 'blocker' },
    cleanDone('edge'),
    { lens: 'tests', state: 'done', agentId: null, note: null, verdict: null },
    notUsed('acceptance'),
    { lens: 'security', state: 'live', agentId: null, note: null, verdict: null },
    { lens: 'codebase', state: 'pending', agentId: null, note: null, verdict: null },
    errored('architecture', 'provider cap hit'),
  ], [], 1),
]);

async function seedBoardSocket(page: Page, snapshot: unknown): Promise<void> {
  let seeded = false;
  await page.routeWebSocket(/\/board\/ws$/, (ws: WebSocketRoute) => {
    ws.onMessage(() => {
      if (seeded) return;
      seeded = true;
      ws.send(JSON.stringify({ type: 'auth_ok' }));
      ws.send(JSON.stringify({ type: 'board', snapshot }));
    });
  });
}

async function pairAndOpenBoard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#pairing-view')).toBeVisible();
  await page.locator('#pair-token').fill(MOCK_TOKEN);
  await page.locator('#pair-submit').click();
  await expect(page.locator('#board-view')).toBeVisible();
}

async function expandProofRound(page: Page, title: string): Promise<void> {
  const job = page.locator('.board-job', { hasText: title });
  await expect(job).toBeVisible();
  await job.locator('.board-job__toggle').click();
  await expect(job).toHaveAttribute('data-expanded', 'true');
  const round = job.locator('.board-round__toggle');
  await round.click();
  await expect(job.locator('.board-lens')).toHaveCount(7);
}

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const host = document.querySelector('#board-jobs');
        if (host === null) return Number.NaN;
        return host.scrollWidth - host.clientWidth;
      }),
    )
    .toBeLessThanOrEqual(0);
}

async function capture(page: Page, name: string): Promise<void> {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  await page.screenshot({ path: path.join(CAPTURE_DIR, `${name}.png`), fullPage: true });
}

test.describe('lens pills — unused is neutral, never a pass (synthetic fixture)', () => {
  test('seven pills: four unused gray without a tick, three clean green; light/dark, phone/desktop', async ({ page }) => {
    test.setTimeout(60_000);
    await seedBoardSocket(page, snapshotOf([FOUR_UNUSED]));
    await pairAndOpenBoard(page);
    await expandProofRound(page, FOUR_UNUSED.title);

    const job = page.locator('.board-job', { hasText: FOUR_UNUSED.title });
    await expect(job.locator('.board-lens.pp-chip--unused')).toHaveCount(4);
    await expect(job.locator('.board-lens.pp-chip--done')).toHaveCount(3);
    await expect(job.locator('.board-round__toggle')).toContainText('3/7 lenses ran · 4 not used');
    for (const lens of ['acceptance', 'security', 'architecture', 'codebase']) {
      const chip = job.locator('.board-lens', { hasText: lens });
      await expect(chip).toContainText('· not used');
      await expect(chip).not.toContainText('✓');
      await expect(chip).toHaveAttribute('title', NOT_USED_NOTE);
    }
    for (const lens of ['blind', 'edge', 'tests']) {
      const chip = job.locator('.board-lens', { hasText: lens });
      await expect(chip).toContainText('✓');
      await expect(chip).not.toContainText('not used');
    }
    await assertNoHorizontalOverflow(page);

    // Desktop light, desktop dark.
    await capture(page, 'four-unused-desktop-light');
    await page.locator('#theme-toggle').click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(job.locator('.board-lens.pp-chip--unused')).toHaveCount(4);
    await expect(job.locator('.board-lens.pp-chip--done')).toHaveCount(3);
    await assertNoHorizontalOverflow(page);
    await capture(page, 'four-unused-desktop-dark');

    // Phone viewport, both themes: honest wrap, still seven pills.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(job.locator('.board-lens')).toHaveCount(7);
    await assertNoHorizontalOverflow(page);
    for (const lens of ['acceptance', 'security', 'architecture', 'codebase']) {
      const box = await job.locator('.board-lens', { hasText: lens }).boundingBox();
      expect(box).not.toBeNull();
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
    }
    await capture(page, 'four-unused-phone-dark');
    await page.locator('#theme-toggle').click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);
    await expect(job.locator('.board-lens.pp-chip--unused')).toHaveCount(4);
    await capture(page, 'four-unused-phone-light');
  });

  test('four unused + three genuine timeout errors: neutral stays neutral, failures stay alert with attempts', async ({ page }) => {
    await seedBoardSocket(page, snapshotOf([FOUR_UNUSED_THREE_ERRORS]));
    await pairAndOpenBoard(page);
    await expandProofRound(page, FOUR_UNUSED_THREE_ERRORS.title);

    const job = page.locator('.board-job', { hasText: FOUR_UNUSED_THREE_ERRORS.title });
    await expect(job.locator('.board-lens.pp-chip--unused')).toHaveCount(4);
    await expect(job.locator('.board-lens.pp-chip--alert')).toHaveCount(3);
    await expect(job.locator('.board-round__toggle')).toContainText(
      '3/7 lenses ran · 3 failed · 4 not used',
    );
    for (const lens of ['blind', 'acceptance', 'security', 'architecture']) {
      const chip = job.locator('.board-lens', { hasText: lens });
      await expect(chip).toContainText('· not used');
      await expect(chip).not.toContainText('✓');
      await expect(chip).not.toContainText('✕');
    }
    for (const lens of ['edge', 'codebase', 'tests']) {
      const chip = job.locator('.board-lens', { hasText: lens });
      await expect(chip).toContainText('✕');
      await expect(chip).toHaveAttribute('title', /specialist attempts failed/);
    }
    await expect(job.locator('.board-lens', { hasText: 'edge' })).toContainText('×2');
    await assertNoHorizontalOverflow(page);

    await capture(page, 'four-unused-three-errors-desktop-light');
    await page.locator('#theme-toggle').click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(job.locator('.board-lens.pp-chip--alert')).toHaveCount(3);
    await capture(page, 'four-unused-three-errors-desktop-dark');
  });

  test('mixed round: unused, clean, legacy null-note, live, pending, blocker, error all distinct', async ({ page }) => {
    await seedBoardSocket(page, snapshotOf([MIXED]));
    await pairAndOpenBoard(page);
    await expandProofRound(page, MIXED.title);

    const job = page.locator('.board-job', { hasText: MIXED.title });
    const blocker = job.locator('.board-lens', { hasText: 'blind' });
    await expect(blocker).toHaveClass(/board-lens--blocker/);
    await expect(blocker).toContainText('✓');
    const clean = job.locator('.board-lens', { hasText: 'edge' });
    await expect(clean).toContainText('✓');
    // Legacy null-note done keeps the normal pass face.
    const legacy = job.locator('.board-lens', { hasText: 'tests' });
    await expect(legacy).toContainText('✓');
    const unused = job.locator('.board-lens', { hasText: 'acceptance' });
    await expect(unused).toContainText('· not used');
    await expect(unused).not.toContainText('✓');
    const live = job.locator('.board-lens', { hasText: 'security' });
    await expect(live).toContainText('◉');
    const pending = job.locator('.board-lens', { hasText: 'codebase' });
    await expect(pending).toContainText('○');
    await expect(pending).not.toContainText('not used');
    const failed = job.locator('.board-lens', { hasText: 'architecture' });
    await expect(failed).toContainText('✕');
    await assertNoHorizontalOverflow(page);

    await capture(page, 'mixed-desktop-light');
    await page.locator('#theme-toggle').click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await expect(job.locator('.board-lens')).toHaveCount(7);
    await capture(page, 'mixed-desktop-dark');
  });
});
