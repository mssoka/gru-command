import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { isValidSnapshot, parseBoardServerFrame, type BoardSnapshot, type JobView } from '../src/lib/board-protocol.js';

/**
 * Megaminion nesting proof: a heist's specialist reviewers (jobs carrying
 * `parentJobId`) render under their parent row and never count as
 * heists. A synthetic, validator-gated snapshot is served on BOTH board
 * channels (the `/board/ws` push and the `GET /api/board` refetch), the
 * same harness the lens-pill and pipeline-board proofs use.
 */

const MOCK_TOKEN = process.env.GRU_MOCK_TOKEN ?? 'dev-token';

function ago(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function jobOf(id: string, title: string, overrides: Partial<JobView> = {}): JobView {
  return {
    id,
    repo: 'family-proof',
    title,
    status: 'working',
    updatedAt: ago(30_000),
    prUrl: null,
    prState: null,
    baseBranch: 'main',
    note: null,
    rounds: [],
    lane: { branch: `gru/${id}`, sha: 'c3f3b35deadbeef', status: 'active', createdAt: ago(600_000) },
    lastAgentActivity: ago(30_000),
    ...overrides,
  };
}

const PARENT = jobOf('family-impl', 'Managed repositories overview');
const OTHER = jobOf('family-other', 'Dashboard slim strip');
const reviewer = (id: string, title: string, status: string, laneAgeMs: number): JobView =>
  jobOf(id, title, {
    status,
    parentJobId: PARENT.id,
    lane: { branch: `gru/${id}`, sha: 'c3f3b35deadbeef', status: 'active', createdAt: ago(laneAgeMs) },
  });

function snapshotOf(jobs: JobView[]): BoardSnapshot {
  return {
    repos: [{ name: 'family-proof', jobs }],
    agents: [],
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
      incarnation: 'family-proof-incarnation',
      generation: 0,
    },
    unackedActionRequired: 0,
    unackedNeedsOwner: 0,
    wakes: { count: 0, lastAt: null },
  };
}

async function seedBoard(page: Page, snapshot: BoardSnapshot): Promise<Error[]> {
  if (!isValidSnapshot(snapshot)) throw new Error('fixture snapshot fails the production isValidSnapshot validator');
  const frame = parseBoardServerFrame({ type: 'board', snapshot });
  if (frame === null || frame.type !== 'board') throw new Error('fixture board frame fails the production parser');
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await page.route('**/api/board', (route) => route.fulfill({ json: snapshot }));
  await page.routeWebSocket(/\/board\/ws$/, (ws: WebSocketRoute) => {
    let seeded = false;
    ws.onMessage(() => {
      if (seeded) return;
      seeded = true;
      ws.send(JSON.stringify({ type: 'auth_ok' }));
      ws.send(JSON.stringify({ type: 'board', snapshot }));
    });
  });
  return pageErrors;
}

async function pairAndOpenBoard(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#pairing-view')).toBeVisible();
  await page.locator('#pair-token').fill(MOCK_TOKEN);
  await page.locator('#pair-submit').click();
  await expect(page.locator('#board-view')).toBeVisible();
}

test.describe('megaminions nest under their heist (synthetic fixture)', () => {
  test('two heists in flight; live reviewers hang under the parent, the delivered one folds into its body', async ({ page }) => {
    const pageErrors = await seedBoard(
      page,
      snapshotOf([
        PARENT,
        OTHER,
        reviewer('family-rev-blind', 'Review (blind)', 'working', 300_000),
        reviewer('family-rev-edge', 'Review (edge)', 'working', 290_000),
        reviewer('family-rev-verify', 'Review (verify)', 'delivered', 280_000),
      ]),
    );
    await pairAndOpenBoard(page);

    const inFlight = page.locator('#board-section-in-flight');
    await expect(inFlight.locator('.board-band__count')).toHaveText('2 heists');
    await expect(inFlight.locator('.board-band__rows > .board-job')).toHaveCount(2);
    await expect(page.locator('#board-section-settled .board-band__count')).toHaveText('0 heists');

    const parent = page.locator(`.board-job[data-job-id="${PARENT.id}"]`);
    await expect(parent.locator('.board-job__family-chip')).toHaveText('↳ 3 megaminions · 2 working · 1 delivered');
    const live = parent.locator('.board-job__family--live > .board-job--child');
    await expect(live).toHaveCount(2);
    await expect(live.first()).toBeVisible();
    await expect(live.first().locator('.board-job__agent-age')).toHaveText(/^megaminion \d+[smhd]$/);
    await expect(page.locator('.board-job[data-job-id="family-rev-verify"]')).toHaveCount(0);

    // A nested row's summary click expands the reviewer, not the heist.
    await live.first().locator('.board-job__meta').click();
    await expect(live.first()).toHaveAttribute('data-expanded', 'true');
    await expect(parent).toHaveAttribute('data-expanded', 'false');

    await parent.locator('> .board-job__head .board-job__toggle').click();
    await expect(parent).toHaveAttribute('data-expanded', 'true');
    const concluded = parent.locator('.board-job__body .board-job__family--concluded');
    await expect(concluded.locator('.board-job--child')).toHaveCount(1);
    await expect(concluded.locator('.board-job--child')).toContainText('Review (verify)');

    // Nesting never pushes the board wider than its column.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const host = document.querySelector('#board-jobs');
          return host === null ? Number.NaN : host.scrollWidth - host.clientWidth;
        }),
      )
      .toBeLessThanOrEqual(0);
    expect(pageErrors).toEqual([]);
  });
});
