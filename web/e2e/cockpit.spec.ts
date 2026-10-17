import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { isValidSnapshot, type BoardSnapshot } from '../src/lib/board-protocol.js';
import { settleTransitions } from './settle-transitions.js';

/**
 * Cockpit — synthetic geometry + truth suite (owner-approved rework
 * 2026-10-17): the command bar's health pill and the KPI cards at the top
 * of the board column, which replaced the slim status strip. Isolated
 * fixtures only: no real owner data, no real project names, never real
 * owner controls.
 *
 * Harness contract (unchanged from the strip suite it replaces):
 *   - BOTH snapshot paths are controlled: initial/reconnect `GET /api/board`
 *     serves the LATEST staged state; `/board/ws` is scripted. The client's
 *     real handshake is honored (page sends {type:'auth',token}; the route
 *     answers {type:'auth_ok'} before any board frame) — production
 *     transport untouched.
 *   - EVERY served state (initial, send, stage) must pass the app's own
 *     `isValidSnapshot` at the harness boundary.
 *   - Time is controlled with the documented page.clock API (a frozen
 *     clock), so live ages render deterministic unit boundaries and Gru and
 *     Silas vary independently.
 *   - Geometry requires its targeted elements (absent targets fail the
 *     test — missing elements never compare as two equal "-1" boxes).
 *
 * Number slots (owner pick 2026-10-17): a card's headline number stands
 * alone on its line and grows freely; fact counts and the wake chip's
 * numbers reserve two digits, so 0–99 never moves a label beside them, and
 * larger counts grow honestly — visible, wrapped, never clipped.
 */

const MOCK_TOKEN = process.env.GRU_MOCK_TOKEN ?? 'dev-token';
/** Controlled frozen clock (documented page.clock API), ISO anchor. */
const FROZEN_NOW = Date.parse('2026-10-02T00:00:00.000Z');
/** A real past local day — never "today" under the frozen clock. */
const PAST_DAY = '2026-09-01T00:00:00.000Z';

/** Every approved mutable numeric slot, explicitly controlled. */
interface Slots {
  working: number;
  open: number;
  inReview: number;
  merged: number;
  mergedToday: number;
  done: number;
  parked: number;
  conflicting: number;
  total: number;
  liveMinions: number;
  midTurn: number;
  disposed: number;
  failedToday: number;
  active: number;
  queued: number;
  orphaned: number;
  behind: number;
  unacked: number;
  wakes: number;
  pending: number;
  /** Age of the GRU wake stamp in ms before the frozen clock (null = no stamp). */
  gruWakeAgeMs: number | null;
  /** Age of the SILAS wake stamp in ms before the frozen clock (null = no stamp). */
  silasWakeAgeMs: number | null;
  /** Issue #219 deferred-wake counter (0 = no deferred block emitted). */
  deferredCount: number;
  deferredTruncated: boolean;
  /** Issue #161 tracker-wide child counters; null = absent (unknown, so
   * the CHILDREN group must be omitted — never a claimed zero). */
  children: { active: number; queued: number; finished: number; lifetimeCreations: number } | null;
  /** #351 raids block; null = absent (an older server: no raids card). */
  vector: Record<string, unknown> | null;
  long: boolean;
}

const DEFAULT_SLOTS: Slots = {
  working: 1, open: 0, inReview: 0, merged: 0, mergedToday: 0, done: 0, parked: 1,
  conflicting: 0, total: 1, liveMinions: 1, midTurn: 0, disposed: 1, failedToday: 0,
  active: 0, queued: 0, orphaned: 0, behind: 0, unacked: 0, wakes: 0, pending: 1,
  gruWakeAgeMs: null, silasWakeAgeMs: 7_200_000, deferredCount: 0, deferredTruncated: false,
  children: null, vector: null, long: false,
};

function slotSpec(overrides: Partial<Slots>): Slots {
  return { ...DEFAULT_SLOTS, ...overrides };
}

/** Independent co-varying family: every listed derivation renders exactly n. */
function familyA(n: number): Slots {
  return slotSpec({
    working: n, open: n, inReview: n, merged: n, mergedToday: n,
    midTurn: n, disposed: n, failedToday: n, queued: n, orphaned: n,
    behind: n, active: n, unacked: n, wakes: n, conflicting: 0, pending: 1,
    gruWakeAgeMs: 300_000, silasWakeAgeMs: 7_200_000,
  });
}

/** Derived-count family: conflicting/in-review/merged/done/parked/disposed/
 * live-minions render exactly n; total derives 4n+1 (accounted below). */
function familyB(n: number): Slots {
  return slotSpec({
    conflicting: n, open: 0, inReview: n, merged: n, mergedToday: 1,
    done: n, parked: n, midTurn: 1, liveMinions: n, disposed: n, pending: 1,
    gruWakeAgeMs: 300_000,
  });
}

/** The total: pure filler against a minimal board renders exactly n. */
function familyC(n: number): Slots {
  return slotSpec({ total: n, working: 1, midTurn: 0, gruWakeAgeMs: 300_000 });
}

function iso(msBeforeFrozen: number): string {
  return new Date(FROZEN_NOW - msBeforeFrozen).toISOString();
}

const ROUND_FIELDS = (id: string, seq: number, status: string, today: boolean): Record<string, unknown> => ({
  id,
  seq,
  status,
  verdict: null,
  targetRef: null,
  createdAt: today ? new Date(FROZEN_NOW).toISOString() : PAST_DAY,
  updatedAt: today ? new Date(FROZEN_NOW).toISOString() : PAST_DAY,
  lenses: [],
  lensAttempts: [],
  blockers: 0,
});

function job(
  id: string,
  status: string,
  prState: string | null,
  prUrl: string | null,
  liveRounds: number,
  abortedToday: number,
  updatedAtToday: boolean,
  title: string,
): Record<string, unknown> {
  const rounds: Record<string, unknown>[] = [];
  for (let i = 0; i < liveRounds; i += 1) rounds.push(ROUND_FIELDS(`${id}-live-${i}`, i + 1, 'live', true));
  for (let i = 0; i < abortedToday; i += 1) rounds.push(ROUND_FIELDS(`${id}-abort-${i}`, 100 + i, 'aborted', true));
  return {
    id,
    repo: 'demo',
    title,
    status,
    updatedAt: updatedAtToday ? new Date(FROZEN_NOW).toISOString() : PAST_DAY,
    prUrl,
    prState,
    baseBranch: 'main',
    note: null,
    rounds,
    lane: null,
    lastAgentActivity: null,
  };
}

function agent(id: string, state: string): Record<string, unknown> {
  return {
    id,
    role: 'minion',
    label: id,
    state,
    lastActivity: state === 'streaming' ? new Date(FROZEN_NOW - 30_000).toISOString() : null,
    sessionFile: null,
    jobId: null,
    roundId: null,
    supervision: null,
  };
}

/** The exact synthetic ack strings the band must render verbatim —
 * asserted in full (never a suffix) by the reveal tests. */
const ACK_DETAIL = (id: string): string => `synthetic detail ${id} — the complete original notice body`;

function ackRow(id: string): Record<string, unknown> {
  return {
    id,
    ts: new Date(FROZEN_NOW).toISOString(),
    kind: 'supervision.breaker',
    routing: 'needs-owner',
    severity: 'info',
    title: spec.long ? `long owner stop title ${id} ${'deliberately wordy notice heading '.repeat(6).trim()}` : `Synthetic owner stop ${id}`,
    detail: ACK_DETAIL(id),
    agentId: null,
    shownAt: null,
    ackedAt: null,
    resolvedAt: null,
    resolvedBy: null,
  };
}

/** Snapshot under construction — the long-label switch is file-scoped. */
let spec: Slots = { ...DEFAULT_SLOTS };

function makeSnapshot(slots: Slots): BoardSnapshot {
  spec = slots;
  const long = slots.long;
  const titleFor = (id: string): string =>
    long ? `${'extraordinarily long heist title '.repeat(8).trim()} ${id}` : `Heist ${id}`;
  // Round holders are REAL counted members: live rounds ride work-0 and
  // aborted-today rounds ride parked-0, so `working`/`parked` render their
  // spec values exactly (no phantom extra jobs).
  const jobs: Record<string, unknown>[] = [];
  for (let i = 0; i < spec.open; i += 1) jobs.push(job(`open-${i}`, 'in-review', 'open', `https://example.invalid/pull/open-${i}`, 0, 0, true, titleFor(`open-${i}`)));
  for (let i = 0; i < spec.conflicting; i += 1) jobs.push(job(`conf-${i}`, 'in-review', 'conflicting', `https://example.invalid/pull/conf-${i}`, 0, 0, true, titleFor(`conf-${i}`)));
  const inReviewPlain = Math.max(0, spec.inReview - spec.open - spec.conflicting);
  for (let i = 0; i < inReviewPlain; i += 1) jobs.push(job(`inrev-${i}`, 'in-review', null, null, 0, 0, true, titleFor(`inrev-${i}`)));
  for (let i = 0; i < spec.mergedToday; i += 1) jobs.push(job(`mtoday-${i}`, 'merged', 'merged', `https://example.invalid/pull/m-${i}`, 0, 0, true, titleFor(`mtoday-${i}`)));
  const mergedPlain = Math.max(0, spec.merged - spec.mergedToday);
  // mergedPlain is dated on a PAST local day: it counts toward `merged`
  // but NEVER toward merged-today (today's count stays exactly spec'd).
  for (let i = 0; i < mergedPlain; i += 1) jobs.push(job(`merged-${i}`, 'merged', 'merged', `https://example.invalid/pull/mp-${i}`, 0, 0, false, titleFor(`merged-${i}`)));
  for (let i = 0; i < spec.working; i += 1) {
    jobs.push(
      job(
        `work-${i}`,
        'working',
        null,
        null,
        i === 0 ? spec.active : 0,
        0,
        true,
        titleFor(`work-${i}`),
      ),
    );
  }
  for (let i = 0; i < spec.done; i += 1) jobs.push(job(`done-${i}`, 'done', null, null, 0, 0, false, titleFor(`done-${i}`)));
  for (let i = 0; i < spec.parked; i += 1) {
    jobs.push(
      job(
        `parked-${i}`,
        'parked',
        null,
        null,
        0,
        i === 0 ? spec.failedToday : 0,
        true,
        titleFor(`parked-${i}`),
      ),
    );
  }
  const accounted = jobs.length;
  const filler = Math.max(0, spec.total - accounted);
  for (let i = 0; i < filler; i += 1) jobs.push(job(`filler-${i}`, 'parked', null, null, 0, 0, false, titleFor(`filler-${i}`)));

  const agents: Record<string, unknown>[] = [];
  for (let i = 0; i < spec.midTurn; i += 1) agents.push(agent(`crew-turn-${i}`, 'streaming'));
  for (let i = 0; i < Math.max(0, spec.liveMinions - spec.midTurn); i += 1) agents.push(agent(`crew-idle-${i}`, 'idle'));
  for (let i = 0; i < spec.disposed; i += 1) agents.push(agent(`crew-gone-${i}`, 'disposed'));

  const acks = Array.from({ length: Math.max(0, spec.pending - 1) }, (_, i) => ackRow(`pend-${String(i).padStart(4, '0')}`));

  return {
    repos: [{ name: 'demo', jobs }],
    agents,
    notifications: acks,
    decisions: {
      enabled: true,
      status: 'ready',
      reason: null,
      model: 'typesafe/jev',
      endpoint: 'https://example.invalid',
      credentialPresent: true,
      credentialSource: 'file',
      checkedAt: null,
      incarnation: 'e2e',
      generation: 1,
    },
    unackedActionRequired: spec.unacked,
    unackedNeedsOwner: acks.length,
    wakes: {
      count: spec.wakes,
      lastAt: spec.gruWakeAgeMs === null ? null : iso(spec.gruWakeAgeMs),
      // Issue #219: emitted only when the server has a deferred tally.
      ...(spec.deferredCount > 0
        ? {
            deferred: {
              count: spec.deferredCount,
              reasons: { 'quiet-hours': spec.deferredCount },
              ...(spec.deferredTruncated ? { truncated: true } : {}),
            },
          }
        : {}),
    },
    build: {
      buildRev: 'a'.repeat(40),
      buildCommittedAt: PAST_DAY,
      originMainRev: 'b'.repeat(40),
      originMainCommittedAt: PAST_DAY,
      commitsBehind: spec.behind,
      checkedAt: PAST_DAY,
      checkError: null,
    },
    silas: {
      lastWakeAt: spec.silasWakeAgeMs === null ? null : iso(spec.silasWakeAgeMs),
      // Current-main protocol (post-#163): the full SilasView is required —
      // an absent/null reconcile branch keeps the wake headline.
      lastTickAt: null,
      lastReconcileAt: null,
      lastReconcileFailedAt: null,
      reconcileFailedNewer: false,
      lastUsefulActionAt: null,
      nextAction: null,
      openTurnSince: null,
      reconciliationsToday: 1,
      checkedAt: PAST_DAY,
    },
    verify: { lockInUse: true, activeRuns: 1, queuedRuns: spec.queued, workerBudget: 8, workersPerRun: 4 },
    // Current protocol: SelfHealView requires since (string | null).
    selfHeal: { sessionsResumed: 1, sessionsOrphaned: spec.orphaned, since: PAST_DAY },
    // Issue #161: present-but-zero is a real report; absent is unknown and
    // omits the group (never a claimed zero).
    ...(spec.children !== null ? { children: spec.children } : {}),
    ...(spec.vector !== null ? { vector: spec.vector } : {}),
    ownerPrs: [
      {
        id: 'owner-pr:synthetic',
        jobId: 'synthetic',
        jobTitle: long ? `long ready heist ${'deliberately wordy pr heading '.repeat(6).trim()}` : 'Synthetic ready heist',
        repo: 'demo',
        prUrl: 'https://example.invalid/pull/7',
        sha: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
        checkedAt: PAST_DAY,
      },
    ],
  } as unknown as BoardSnapshot;
}

function assertValid(snapshot: BoardSnapshot, where: string): void {
  expect(isValidSnapshot(snapshot), `synthetic snapshot must satisfy isValidSnapshot (${where})`).toBe(true);
}

async function pair(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#pairing-view')).toBeVisible();
  await page.locator('#pair-token').fill(MOCK_TOKEN);
  await page.locator('#pair-submit').click();
  await expect(page.locator('#board-view')).toBeVisible();
}

type Send = ((snapshot: BoardSnapshot) => Promise<void>) & {
  stage(s: BoardSnapshot): void;
  socketCount(): number;
};
const sockets: WebSocketRoute[] = [];

/** Wire BOTH fixture paths (real auth handshake + board frames) and pair. */
async function harness(page: Page, initial: BoardSnapshot): Promise<Send> {
  assertValid(initial, 'initial HTTP state');
  sockets.length = 0;
  let current: BoardSnapshot = initial;
  await page.context().routeWebSocket(/\/board\/ws/, (ws) => {
    sockets.push(ws);
    // The client sends {type:'auth',token} on open and proceeds only after
    // the real {type:'auth_ok'} — script that actual contract.
    ws.onMessage((data) => {
      if (String(data).includes('"type":"auth"')) ws.send(JSON.stringify({ type: 'auth_ok' }));
    });
  });
  await page.route(/\/api\/board/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(current) }),
  );
  await page.clock.install({ time: new Date(FROZEN_NOW) });
  // install() alone lets `Date.now` keep advancing with real time (the
  // installed Playwright types say so explicitly) — a 9s age would already
  // be 10/11s by the time it is measured. setFixedTime() makes Date.now
  // and new Date() return the anchor AT ALL TIMES while KEEPING all timers
  // running, so reconnect/backoff stays genuinely exercisable and no case
  // needs sleeps, tolerance, or inflated timeouts.
  await page.clock.setFixedTime(new Date(FROZEN_NOW));
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  await pair(page);
  // Prove the board rendered before asking for cockpit surfaces.
  await expect(page.locator('#board-section-in-flight')).toBeVisible();
  try {
    await expect(page.locator('#board-kpis .cockpit-card').first()).toBeVisible();
    await expect(page.locator('#command-health')).toBeVisible();
  } catch (error) {
    // A runtime/render failure after the shell is visible is setup failure,
    // not evidence that the feature is absent.
    if (pageErrors.length > 0) {
      throw new Error(`browser setup/runtime failure before cockpit assertion (${pageErrors.length} unhandled page error(s))`);
    }
    throw error;
  }
  if (pageErrors.length > 0) {
    throw new Error(`browser setup/runtime failure before cockpit assertion (${pageErrors.length} unhandled page error(s))`);
  }
  const sendFn = async (snapshot: BoardSnapshot): Promise<void> => {
    assertValid(snapshot, 'ws frame state');
    current = snapshot; // reconnect HTTP refetch serves the LATEST state
    const socket = sockets[sockets.length - 1];
    expect(socket, 'a scripted ws socket exists').toBeTruthy();
    await socket!.send(JSON.stringify({ type: 'board', snapshot }));
  };
  return Object.assign(sendFn, {
    stage: (s: BoardSnapshot): void => {
      assertValid(s, 'staged HTTP state');
      current = s;
    },
    socketCount: (): number => sockets.length,
  });
}

interface Geometry {
  bodyOverflow: boolean;
  /** The label and unit boxes beside every reserved slot, as JSON. */
  labelsJson: string;
}

/** Measure the boxes a reserved slot must hold still: every fact label in
 * the KPI cards, every card's label, and the wake chip and its parts (an aside is
 * text — `round 9 live` — and changes with its value, so it is not one).
 * Targeted elements are REQUIRED (an absent one throws) and every box must
 * be positive. Headline numbers and their units are deliberately left out:
 * they stand alone on their line and grow by design. */
async function geometry(page: Page, opts: { expectAgeSplit?: boolean } = {}): Promise<Geometry> {
  return page.evaluate(
    ({ expectAgeSplit }) => {
      const kpis = document.getElementById('board-kpis');
      const wakes = document.getElementById('board-wakes');
      if (!kpis || !wakes) throw new Error('missing #board-kpis or #board-wakes');
      const positive = (el: Element, what: string): { x: number; y: number; w: number; h: number } => {
        const b = el.getBoundingClientRect();
        if (!(b.width > 0) || !(b.height > 0)) throw new Error(`non-positive box for ${what}`);
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      };
      const all = (scope: ParentNode, sel: string): { x: number; y: number; w: number; h: number }[] => {
        const found = [...scope.querySelectorAll(sel)];
        if (found.length === 0) throw new Error(`missing ${sel}`);
        return found.map((el, i) => positive(el, `${sel}[${i}]`));
      };
      const age = expectAgeSplit
        ? [positive(wakes.querySelector('.board-age-split__unit') ?? (() => { throw new Error('missing age unit'); })(), 'age unit')]
        : (() => {
            if (wakes.querySelector('.board-age-split__num') !== null) throw new Error('unexpected age split in the honest-unknown wakes state');
            return [];
          })();
      return {
        bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        labelsJson: JSON.stringify({
          factLabels: all(kpis, '.cockpit-fact__label'),
          cardLabels: all(kpis, '.cockpit-card__label'),
          wakeCount: positive(wakes.querySelector('.board-wakes__count') ?? (() => { throw new Error('missing wake count'); })(), 'wake count'),
          // The whole chip: its count, deferred and age slots sit inside, so
          // a slot that grows moves the chip's edge.
          wakeChip: positive(wakes, '#board-wakes'),
          age,
          decisions: positive(document.getElementById('board-decisions')!, '#board-decisions'),
        }),
      };
    },
    { expectAgeSplit: opts.expectAgeSplit ?? true },
  );
}

/** Every box equal within 0.1px: a reflow moves a label by a glyph (~6px);
 * layout's 1/64px rounding is not a move. */
function compareLabels(before: Geometry, after: Geometry): void {
  expect(after.bodyOverflow, 'no horizontal body overflow').toBe(false);
  const near = (a: unknown, b: unknown): boolean =>
    typeof a === 'number' && typeof b === 'number'
      ? Math.abs(a - b) <= 0.1
      : Array.isArray(a) && Array.isArray(b)
        ? a.length === b.length && a.every((value, index) => near(value, b[index]))
        : typeof a === 'object' && a !== null && typeof b === 'object' && b !== null
          ? Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => near((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
          : a === b;
  expect(near(JSON.parse(after.labelsJson), JSON.parse(before.labelsJson)), `no label beside a reserved slot moved:\n${before.labelsJson}\n${after.labelsJson}`).toBe(true);
}

async function waitForCount(page: Page, kpi: string, value: number, timeout = 5_000): Promise<void> {
  await expect
    .poll(() => page.evaluate((key) => document.querySelector<HTMLElement>(`#board-kpis [data-kpi="${key}"]`)?.textContent ?? '', kpi), { timeout })
    .toBe(String(value));
}

/** Assert every intended fact's actual rendered value BEFORE measuring. */
async function expectSlots(page: Page, kpis: readonly string[], value: number): Promise<void> {
  for (const kpi of kpis) {
    await expect(page.locator(`#board-kpis [data-kpi="${kpi}"]`)).toHaveText(String(value));
  }
}

/** familyA's fact counts (the headline numbers ride their own line). */
const FAMILY_A_FACTS: readonly string[] = [
  'jobs.working', 'jobs.inReview', 'jobs.merged', 'prs.mergedToday', 'lanes.midTurn', 'lanes.disposed', 'reviews.failedToday',
];
/** familyB's fact counts: derived PR conflict, heist merged/done/parked,
 * crew disposed. */
const FAMILY_B_FACTS: readonly string[] = [
  'prs.conflicting', 'jobs.inReview', 'jobs.merged', 'jobs.done', 'jobs.parked', 'lanes.disposed',
];

const VIEWPORTS: ReadonlyArray<[number, number]> = [
  [1440, 900],
  [1200, 900],
  [768, 1024],
  [360, 740],
];

const RAIDS_OFF: Record<string, unknown> = { enabled: false, raidMode: 'proposed', maxRaidsPerDay: 2 };

const RAIDS_ON: Record<string, unknown> = {
  enabled: true,
  raidMode: 'proposed',
  proposed: 1,
  queued: 0,
  running: [{ repo: 'demo', packageDir: 'src/refunds', roundsDone: 1, maxRounds: 4, startedAt: new Date(FROZEN_NOW - 600_000).toISOString() }],
  capUse: [{ repo: 'demo', used: 1 }],
  maxRaidsPerDay: 2,
  breakIns: 1,
  fixesAwaitingOwner: 1,
};

for (const [width, height] of VIEWPORTS) {
  test(`familyA fact counts cross 9→10 inside their two-digit slots at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const send = await harness(page, makeSnapshot(familyA(9)));
    // EVERY intended fact asserts its actual value BEFORE before-geometry.
    await expectSlots(page, FAMILY_A_FACTS, 9);
    await expect(page.locator('#board-kpis [data-kpi="jobs.total"]')).toHaveText('28');
    await expect(page.locator('.board-wakes__count')).toHaveText('9');
    // The pill's checks carry the same n: deploy behind, verify queued and
    // cure orphaned all need a look.
    await expect(page.locator('#command-health-summary')).toHaveText('3 need a look');
    await expect(page.locator('.command-health__part[data-check="deploy"]')).toContainText('deploy 9 behind');
    const before = await geometry(page);
    expect(before.bodyOverflow).toBe(false);
    await send(makeSnapshot(familyA(10)));
    await expectSlots(page, FAMILY_A_FACTS, 10);
    await expect(page.locator('#board-kpis [data-kpi="jobs.total"]')).toHaveText('31');
    await expect(page.locator('.board-wakes__count')).toHaveText('10');
    await expect(page.locator('.command-health__part[data-check="deploy"]')).toContainText('deploy 10 behind');
    compareLabels(before, await geometry(page));
  });

  test(`familyB derived counts cross 9→10 inside their two-digit slots at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const send = await harness(page, makeSnapshot(familyB(9)));
    await expectSlots(page, FAMILY_B_FACTS, 9);
    await expect(page.locator('#board-kpis [data-kpi="jobs.total"]')).toHaveText('37');
    await expect(page.locator('#board-kpis [data-kpi="prs.mergedToday"]')).toHaveText('1');
    const before = await geometry(page);
    expect(before.bodyOverflow).toBe(false);
    await send(makeSnapshot(familyB(10)));
    await expectSlots(page, FAMILY_B_FACTS, 10);
    await expect(page.locator('#board-kpis [data-kpi="jobs.total"]')).toHaveText('41');
    compareLabels(before, await geometry(page));
  });

  test(`counts past the slot grow honestly — visible, wrapped, never clipped at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await harness(page, makeSnapshot({ ...familyC(1000), working: 100, wakes: 10000, behind: 10000, unacked: 10000, deferredCount: 10000, vector: RAIDS_ON }));
    await waitForCount(page, 'jobs.total', 1000);
    await expect(page.locator('#board-kpis [data-kpi="jobs.working"]')).toHaveText('100');
    await expect(page.locator('.board-wakes__count')).toHaveText('10000');
    await expect(page.locator('.board-wakes__deferred')).toHaveText('10000');
    await expect(page.locator('.command-health__part[data-check="deploy"]')).toContainText('10000 behind');
    await expect(page.locator('.board-owner__gru')).toHaveText('10000 live alerts wait for Gru');
    const audit = await page.evaluate(() => {
      const visible = (el: Element | null): boolean => {
        if (el === null) return false;
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      };
      const cards = [...document.querySelectorAll<HTMLElement>('#board-kpis .cockpit-card, #board-kpis .cockpit-card__facts, #board-kpis .cockpit-card__headline')];
      return {
        body: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        // >1px of scroll area beyond a box means clipped content; sub-pixel
        // rounding is not a hidden digit.
        maxInner: Math.max(0, ...cards.map((el) => el.scrollWidth - el.clientWidth)),
        // A card's big number is never cut by its own box.
        bigsFit: [...document.querySelectorAll<HTMLElement>('#board-kpis .cockpit-card__big')].every((big) => {
          const card = big.closest('.cockpit-card')!.getBoundingClientRect();
          const box = big.getBoundingClientRect();
          return box.left >= card.left - 0.5 && box.right <= card.right + 0.5;
        }),
        slots: ['#board-kpis [data-kpi="jobs.total"]', '#board-kpis [data-kpi="jobs.working"]', '.board-wakes__count', '.board-wakes__deferred'].map((sel) => visible(document.querySelector(sel))),
        // The health pill stays on screen, and its summary and chips sit
        // whole inside it (only the checks' text may ellipsize, by design).
        pill: (() => {
          const pill = document.getElementById('command-health')!.getBoundingClientRect();
          const inside = ['#command-health-summary', '#board-decisions', '#board-wakes'].every((sel) => {
            const box = document.querySelector(sel)!.getBoundingClientRect();
            return box.width > 0 && box.left >= pill.left - 0.5 && box.right <= pill.right + 0.5 && box.bottom <= pill.bottom + 0.5;
          });
          const chipsWhole = ['#command-health-summary', '#board-decisions', '#board-wakes'].every((sel) => {
            const el = document.querySelector<HTMLElement>(sel)!;
            return el.scrollWidth - el.clientWidth <= 1;
          });
          return { onScreen: pill.left >= -0.5 && pill.right <= document.documentElement.clientWidth + 0.5, inside, chipsWhole };
        })(),
      };
    });
    expect(audit.body, `no body overflow at ${width}×${height}`).toBe(false);
    expect(audit.maxInner, `no clipped card content at ${width}×${height}`).toBeLessThanOrEqual(1);
    expect(audit.bigsFit, `every headline number fits its card at ${width}×${height}`).toBe(true);
    expect(audit.slots.every(Boolean), `every grown count visible at ${width}×${height}`).toBe(true);
    expect(audit.pill, `the health pill and its chips whole at ${width}×${height}`).toEqual({ onScreen: true, inside: true, chipsWhole: true });
  });
}

test('GRU and SILAS wake ages vary independently; the Gru age crosses 9→10 inside its slot', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const send = await harness(page, makeSnapshot({ ...familyA(4), gruWakeAgeMs: 300_000, silasWakeAgeMs: 7_200_000 }));
  // Independent facts: Gru reads its 5m age, Silas its own 2h — never shared.
  const gruNum = page.locator('#board-wakes .board-age-split__num');
  const gruUnit = page.locator('#board-wakes .board-age-split__unit');
  const silas = page.locator('.command-health__part[data-check="silas"]');
  await expect(gruNum).toHaveText('5');
  await expect(gruUnit).toHaveText('m ago');
  await expect(silas).toHaveText('silas wake 2h ago');
  // GRU moves, SILAS pinned. The clock is FIXED (setFixedTime holds
  // Date.now at the anchor), so 9s renders 9s — no race against real time.
  await send(makeSnapshot({ ...familyA(4), gruWakeAgeMs: 9_000, silasWakeAgeMs: 7_200_000 }));
  await expect(gruNum).toHaveText('9');
  await expect(gruUnit).toHaveText('s ago');
  await expect(silas).toHaveText('silas wake 2h ago'); // Silas genuinely untouched
  const nine = await geometry(page);
  await send(makeSnapshot({ ...familyA(4), gruWakeAgeMs: 10_000, silasWakeAgeMs: 7_200_000 }));
  await expect(gruNum).toHaveText('10');
  compareLabels(nine, await geometry(page));
  // SILAS moves, GRU pinned — independence in the other direction.
  await send(makeSnapshot({ ...familyA(4), gruWakeAgeMs: 300_000, silasWakeAgeMs: 9_000 }));
  await expect(silas).toHaveText('silas wake 9s ago');
  await expect(gruNum).toHaveText('5'); // Gru genuinely untouched
});

test('KPI cards: two columns on a phone, three in the cockpit board column, a row of their own on a wide board', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const send = await harness(page, makeSnapshot({ ...familyA(9), vector: RAIDS_ON }));
  await waitForCount(page, 'prs.open', 9);
  const columns = (): Promise<{ perRow: number; count: number; overflow: boolean }> => page.evaluate(() => {
    const cards = [...document.querySelectorAll<HTMLElement>('#board-kpis .cockpit-card')].map((card) => card.getBoundingClientRect());
    const firstRow = cards.filter((box) => Math.abs(box.y - cards[0]!.y) <= 0.5).length;
    return { perRow: firstRow, count: cards.length, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth };
  });
  for (const [width, perRow] of [[1440, 3], [1200, 2], [768, 3], [360, 2], [2400, 6]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await settleTransitions(page);
    expect(await columns(), `${width}px`).toEqual({ perRow, count: 6, overflow: false });
  }
  // No raids block (an older server): five cards fill five columns — never
  // six with a hole at the end.
  await send(makeSnapshot(familyA(9)));
  await expect(page.locator('#board-kpis .cockpit-card')).toHaveCount(5);
  expect(await columns()).toEqual({ perRow: 5, count: 5, overflow: false });
});

test('essential text and numbers hold >=4.5:1 contrast in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Every measured target must actually be RENDERED (an absent target fails
  // loud): conflicting > 0 for the alert ink, a zero fact for the faint ink,
  // deferred > 0 for the wakes deferred slot, a raids block for its card,
  // and no pipeline block so PIPELINE folds into the Empty row.
  const send = await harness(page, makeSnapshot(slotSpec({ ...familyA(4), conflicting: 3, done: 0, deferredCount: 12, pending: 9, vector: RAIDS_ON })));
  await waitForCount(page, 'prs.conflicting', 3);
  const measure = (): Promise<Record<string, number>> =>
    page.evaluate(() => {
      const lum = (rgb: string): number => {
        const m = rgb.match(/\d+/g)!.map(Number);
        const [r, g, b] = m.slice(0, 3).map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      // The page background in the CURRENT theme, for an element whose
      // ancestors are all transparent (resolved through a probe so the
      // token's value, not a hard-coded light colour, is measured).
      const pageBg = (): string => {
        const probe = document.createElement('div');
        probe.style.background = 'var(--bg)';
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      };
      const bgOf = (el: Element): string => {
        let n: Element | null = el;
        while (n) {
          const c = getComputedStyle(n).backgroundColor;
          if (c && c !== 'transparent' && !/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)/.test(c)) return c;
          n = n.parentElement;
        }
        return pageBg();
      };
      const ratioOf = (selector: string): number => {
        const el = document.querySelector<HTMLElement>(selector);
        if (!el) return -1;
        const l1 = lum(getComputedStyle(el).color);
        const l2 = lum(bgOf(el));
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      const targets: Record<string, string> = {
        radar: '#command-radar-label',
        round: '#command-round',
        healthSummary: '#command-health-summary',
        healthProblem: '.command-health__part--alert',
        healthWarn: '.command-health__part--warn',
        healthCalm: '.command-health__part--muted, .command-health__part--ok',
        healthFlag: '.command-health__flag',
        wakeCount: '.board-wakes__count',
        wakeDeferred: '.board-wakes__deferred',
        ageSplitUnit: '.board-age-split__unit',
        cardLabel: '.cockpit-card__label',
        cardAside: '.cockpit-card__aside',
        cardBig: '.cockpit-card__big',
        cardUnit: '.cockpit-card__unit',
        factLabel: '.cockpit-fact:not(.cockpit-fact--zero):not(.cockpit-fact--alert) .cockpit-fact__label',
        factNum: '.cockpit-fact:not(.cockpit-fact--zero):not(.cockpit-fact--alert) .cockpit-fact__num',
        zeroFact: '.cockpit-fact--zero .cockpit-fact__num',
        alertFact: '.cockpit-fact--alert .cockpit-fact__num',
        note: '.cockpit-fact--note',
        gruLine: '.board-owner__gru',
        ownerTitle: '.board-owner__title',
        bandCount: '.board-band__count',
        foldedLabel: '.board-folded__label',
        foldedCount: '.board-folded__count',
        offLabel: '.cockpit-card--off .cockpit-card__label',
        offBig: '.cockpit-card--off .cockpit-card__big',
        offUnit: '.cockpit-card--off .cockpit-card__unit',
        offNote: '.cockpit-card--off .cockpit-fact--note',
      };
      return Object.fromEntries(Object.entries(targets).map(([k, s]) => [k, Math.round(ratioOf(s) * 100) / 100]));
    });
  // The raids card is on in the first frame and off in the second, so both
  // faces are measured in each theme (an absent target reads -1 and fails).
  const fixture = (vector: Record<string, unknown>): BoardSnapshot =>
    makeSnapshot(slotSpec({ ...familyA(4), conflicting: 3, done: 0, deferredCount: 12, pending: 9, vector }));
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') {
      await page.locator('#theme-toggle').click();
      await expect(page.locator('html')).toHaveClass(/dark/);
      // Measure the THEME, never a mid-animation blend: body color and the
      // surface backgrounds transition on different elements (#402).
      await settleTransitions(page);
    }
    await send(fixture(RAIDS_ON));
    await expect(page.locator('.cockpit-card--raids')).not.toHaveClass(/cockpit-card--off/u);
    const on = await measure();
    await send(fixture(RAIDS_OFF));
    await expect(page.locator('.cockpit-card--raids')).toHaveClass(/cockpit-card--off/u);
    const off = await measure();
    const ratios = { ...on, offLabel: off.offLabel!, offBig: off.offBig!, offUnit: off.offUnit!, offNote: off.offNote! };
    for (const [name, ratio] of Object.entries(ratios)) {
      expect(ratio, `${name} contrast (${theme})`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test('CREW folds in sub-minions only when the server reported counters (absent is not zero)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const send = await harness(page, makeSnapshot(slotSpec({})));
  const crew = page.locator('.cockpit-card--crew');
  await expect(crew.locator('[data-kpi="children.active"]')).toHaveCount(0);
  // A present zero report is still a report: the fact appears with a zero.
  await send(makeSnapshot(slotSpec({ children: { active: 0, queued: 0, finished: 0, lifetimeCreations: 0 } })));
  await expect(crew.locator('[data-kpi="children.active"]')).toHaveText('0');
  await expect(crew.locator('[data-kpi="children.active"] + .cockpit-fact__label')).toHaveText('sub-minions');
  // Present non-zero counts render truthfully; the queue is a count of its
  // own and the lifetime count rides the title.
  await send(makeSnapshot(slotSpec({ gruWakeAgeMs: 300_000, children: { active: 2, queued: 3, finished: 5, lifetimeCreations: 10 } })));
  await expect(crew.locator('[data-kpi="children.active"]')).toHaveText('2');
  await expect(crew.locator('[data-kpi="children.queued"]')).toHaveText('3');
  await expect(crew.locator('[data-kpi="children.queued"] + .cockpit-fact__label')).toHaveText('queued');
  await expect(crew.locator('[data-kpi="children.active"]')).toHaveAttribute('title', /10 created/u);
  // The extra facts wrap honestly: no body overflow and nothing clipped at
  // phone width, measured after the resize settles.
  await page.setViewportSize({ width: 360, height: 800 });
  await settleTransitions(page);
  const fit = await page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('.cockpit-card--crew')!;
    const box = card.getBoundingClientRect();
    return {
      body: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      card: card.scrollWidth - card.clientWidth <= 1,
      facts: [...card.querySelectorAll('.cockpit-fact')].every((fact) => {
        const f = fact.getBoundingClientRect();
        return f.width > 0 && f.left >= box.left - 0.5 && f.right <= box.right + 0.5;
      }),
    };
  });
  expect(fit).toEqual({ body: true, card: true, facts: true });
});

test('deferred Gru wakes stay visible beside count and age (issue #219)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const send = await harness(page, makeSnapshot(slotSpec({ wakes: 4, gruWakeAgeMs: 300_000, deferredCount: 2 })));
  const wakes = page.locator('#command-health #board-wakes');
  await expect(wakes).toContainText('4 wakes');
  await expect(wakes).toContainText('2 deferred');
  await expect(wakes).toHaveAttribute('title', /deferred \(avoided\): 2 quiet-hours/);
  // The windowed count keeps its digits; deferred and age stay separate slots.
  await expect(wakes.locator('.board-wakes__count')).toHaveText('4');
  await expect(wakes.locator('.board-age-split__num')).toHaveText('5');
  // A truncated tally is marked as a lower bound (never silently exact).
  await send(makeSnapshot(slotSpec({ wakes: 4, gruWakeAgeMs: 300_000, deferredCount: 3, deferredTruncated: true })));
  await expect(wakes).toContainText('3 deferred+');
  await expect(wakes).toHaveAttribute('title', /tally truncated at the scan cap/);
  // The deferred number rides its two-digit slot: nothing moves at 9→10.
  await send(makeSnapshot(slotSpec({ wakes: 4, gruWakeAgeMs: 300_000, deferredCount: 9 })));
  await expect(wakes.locator('.board-wakes__deferred')).toHaveText('9');
  const deferred9 = await geometry(page);
  await send(makeSnapshot(slotSpec({ wakes: 4, gruWakeAgeMs: 300_000, deferredCount: 10 })));
  await expect(wakes.locator('.board-wakes__deferred')).toHaveText('10');
  compareLabels(deferred9, await geometry(page));
  // Deferred-only (zero fired wakes, no stamp): the honest no-wakes state
  // still shows the deferred demand — never a fabricated "unknown" time.
  await send(makeSnapshot(slotSpec({ wakes: 0, gruWakeAgeMs: null, deferredCount: 9 })));
  await expect(wakes).toContainText('no wakes yet');
  await expect(wakes).toContainText('9 deferred');
  await expect(wakes).not.toContainText('last wake unknown');
  const quiet9 = await geometry(page, { expectAgeSplit: false });
  await send(makeSnapshot(slotSpec({ wakes: 0, gruWakeAgeMs: null, deferredCount: 10 })));
  await expect(wakes.locator('.board-wakes__deferred')).toHaveText('10');
  compareLabels(quiet9, await geometry(page, { expectAgeSplit: false }));
  // A count with NO valid stamp is the honest "last wake unknown" state,
  // and its count crosses 9→10 in its slot as well.
  await send(makeSnapshot(slotSpec({ wakes: 9, gruWakeAgeMs: null, deferredCount: 0 })));
  await expect(wakes).toContainText('last wake unknown');
  await expect(wakes.locator('.board-wakes__count')).toHaveText('9');
  const unknown9 = await geometry(page, { expectAgeSplit: false });
  await send(makeSnapshot(slotSpec({ wakes: 10, gruWakeAgeMs: null, deferredCount: 0 })));
  await expect(wakes.locator('.board-wakes__count')).toHaveText('10');
  compareLabels(unknown9, await geometry(page, { expectAgeSplit: false }));
});

test('the health pill is a named group; on a phone it keeps the checks that need a look and folds the calm ones', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const send = await harness(page, makeSnapshot(familyA(2)));
  const pill = page.locator('#command-health');
  await expect(pill).toHaveAttribute('role', 'group');
  await expect(pill).toHaveAttribute('aria-label', 'System health');
  await expect(page.locator('#command-health-summary')).toHaveText('3 need a look');
  // The problems stay readable on the phone; the calm Silas check folds.
  for (const check of ['deploy', 'verify', 'cure']) {
    await expect(page.locator(`.command-health__part[data-check="${check}"]`)).toBeVisible();
  }
  await expect(page.locator('.command-health__part[data-check="silas"]')).toBeHidden();
  // Nothing needs a look: the summary alone carries the state on a phone.
  await send(makeSnapshot(slotSpec({ gruWakeAgeMs: 300_000 })));
  await expect(page.locator('#command-health-summary')).toHaveText('All healthy');
  await expect(page.locator('#command-health-parts')).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('on a phone the command bar and the KPI cards scroll away; the shortcut strip keeps the top', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await harness(page, makeSnapshot({ ...familyA(4), pending: 30, vector: RAIDS_ON }));
  const read = () => page.evaluate(() => {
    const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    return {
      bar: getComputedStyle(document.getElementById('command-bar')!).position,
      kpis: getComputedStyle(document.getElementById('board-kpis')!).position,
      barBottom: box('command-bar').bottom,
      kpisTop: box('board-kpis').top,
      navTop: box('board-nav').top,
      barHeight: document.getElementById('command-bar')!.offsetHeight,
      chromeH: getComputedStyle(document.documentElement).getPropertyValue('--chrome-h').trim(),
    };
  });
  const top = await read();
  // The bar is three rows tall here; sticky, it would hold a quarter of the
  // screen. It is not sticky, so the sticky offsets do not count it.
  expect(top.barBottom).toBeGreaterThan(150);
  expect([top.bar, top.kpis, top.chromeH]).toEqual(['relative', 'static', '0px']);
  // Far enough that the strip, under the bar and the cards, reaches the top.
  await page.evaluate(() => window.scrollBy(0, 1400));
  const scrolled = await read();
  expect(scrolled.barBottom, 'the bar scrolled away').toBeLessThanOrEqual(0);
  expect(scrolled.kpisTop, 'the cards scrolled away').toBeLessThan(top.kpisTop - 500);
  expect(scrolled.navTop, 'the shortcut strip holds the top').toBeCloseTo(0, 0);
  // The notification panel still clears the bar's full height at the top.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('#notification-bell').click();
  const panelTop = await page.evaluate(() => document.getElementById('notification-panel')!.getBoundingClientRect().top);
  expect(panelTop).toBeGreaterThanOrEqual(top.barBottom);
  // A tablet keeps the sticky bar (the offsets count it again).
  await page.locator('#notification-bell').click();
  await page.setViewportSize({ width: 768, height: 1024 });
  await settleTransitions(page);
  // The re-measure runs on the resize's frame, so poll for it.
  await expect.poll(async () => {
    const tablet = await read();
    return [tablet.bar, tablet.chromeH === `${tablet.barHeight}px`];
  }).toEqual(['sticky', true]);
});

/** Visual evidence: real captures of the synthetic fixture at all four
 * viewports in both themes, for operator/vision inspection. Artifacts land
 * in the ignored web/e2e-artifacts/ directory. */
test('visual captures for inspection — 1440/1200/768/360 in both themes', async ({ page }) => {
  await harness(page, makeSnapshot({ ...familyA(9), pending: 2, vector: RAIDS_ON, children: { active: 2, queued: 1, finished: 4, lifetimeCreations: 7 } }));
  await waitForCount(page, 'prs.open', 9);
  for (const [width, height] of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await settleTransitions(page); // a resize re-renders; never capture a blend
    await page.screenshot({ path: `e2e-artifacts/cockpit-${width}-light.png`, fullPage: false });
  }
  await page.locator('#theme-toggle').click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  for (const [width, height] of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await settleTransitions(page); // the theme flip transitions body color/background
    await page.screenshot({ path: `e2e-artifacts/cockpit-${width}-dark.png`, fullPage: false });
  }
});

/** A1: the reserved numeric utility is scoped to the cockpit surfaces and
 * the For-you band. An unrelated surface must keep the app default — on an
 * unscoped global rule this probe would reserve a slot and become
 * inline-block, so this test fails on such a rule. */
test('A1: the reserved numeric slot is scoped — an unrelated surface keeps the app default', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await harness(page, makeSnapshot(familyA(4)));
  const styles = await page.evaluate(() => {
    const read = (el: Element): { minWidth: string; display: string } => {
      const s = getComputedStyle(el);
      return { minWidth: s.minWidth, display: s.display };
    };
    const factNum = document.querySelector('#board-kpis .cockpit-fact__num');
    const wakeNum = document.querySelector('#command-health .board-wakes__count');
    const ownerNum = document.querySelector('#board-owner .board-band__count-num');
    if (!factNum || !wakeNum || !ownerNum) throw new Error('missing cockpit or owner numeric slot');
    // The probe goes on the app frame (body, a plain block container) — an
    // unrelated surface that is neither the cockpit nor the owner band.
    const probe = document.createElement('span');
    probe.className = 'num';
    probe.textContent = '7';
    document.body.append(probe);
    const probeStyle = read(probe);
    probe.remove();
    return { fact: read(factNum), wake: read(wakeNum), owner: read(ownerNum), probe: probeStyle };
  });
  // The approved surfaces DO reserve the numeric slot (a flex item computes
  // its display as block; the reserved floor is the contract).
  for (const slot of [styles.fact, styles.wake, styles.owner]) {
    expect(['inline-block', 'block']).toContain(slot.display);
    expect(parseFloat(slot.minWidth)).toBeGreaterThan(0);
  }
  // The unrelated surface keeps its natural inline display AND its default
  // min-width (Chromium resolves the unset value to 0px).
  expect(styles.probe.display).toBe('inline');
  expect(parseFloat(styles.probe.minWidth) || 0).toBe(0);
});
