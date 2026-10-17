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
  let authed = false;
  await page.context().routeWebSocket(/\/board\/ws/, (ws) => {
    sockets.push(ws);
    // The client sends {type:'auth',token} on open and proceeds only after
    // the real {type:'auth_ok'} — script that actual contract.
    ws.onMessage((data) => {
      if (String(data).includes('"type":"auth"')) {
        ws.send(JSON.stringify({ type: 'auth_ok' }));
        authed = true;
      }
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
  // The board socket goes live with the initial state, so RADAR reads LIVE
  // before any test measures (on a phone RADAR steps aside only then).
  await expect.poll(() => authed, { message: 'the board socket authenticated' }).toBe(true);
  await sendFn(initial);
  await expect(page.locator('#command-radar-label')).toHaveText('RADAR LIVE');
  return Object.assign(sendFn, {
    stage: (s: BoardSnapshot): void => {
      assertValid(s, 'staged HTTP state');
      current = s;
    },
    socketCount: (): number => sockets.length,
  });
}

/** Drop the board socket for good: reconnects are refused and the HTTP
 * catch-up never answers, so nothing can make the board current again. */
async function dropBoardSocket(page: Page): Promise<void> {
  await page.route(/\/api\/board/, () => { /* never answers */ });
  await page.context().routeWebSocket(/\/board\/ws/, (ws) => { void ws.close(); });
  for (const socket of sockets) await socket.close();
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
          // The RADAR and ROUND pills hold their slots (absent on a phone,
          // where they step aside).
          pills: ['command-radar', 'command-round'].map((id) => {
            const b = document.getElementById(id)!.getBoundingClientRect();
            return { x: b.x, y: b.y, w: b.width, h: b.height };
          }),
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
    await expect(page.locator('.board-owner__gru')).toHaveText('Gru is handling 10000 live alerts');
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
  const columns = (): Promise<{ perRow: number; count: number; overflow: boolean; rowFills: boolean }> => page.evaluate(() => {
    const grid = document.querySelector('.cockpit-kpis__grid')!.getBoundingClientRect();
    const cards = [...document.querySelectorAll<HTMLElement>('#board-kpis .cockpit-card')].map((card) => card.getBoundingClientRect());
    const row = cards.filter((box) => Math.abs(box.y - cards[0]!.y) <= 0.5);
    return {
      perRow: row.length,
      count: cards.length,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      // The first row spans the grid: no empty column at its end.
      rowFills: Math.abs(row[row.length - 1]!.right - grid.right) <= 1,
    };
  });
  for (const [width, perRow] of [[1440, 3], [1200, 2], [768, 3], [360, 2], [2400, 6]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await settleTransitions(page);
    expect(await columns(), `${width}px`).toEqual({ perRow, count: 6, overflow: false, rowFills: true });
  }
  // No raids block (an older server): five cards fill five columns — never
  // six with a hole at the end.
  await send(makeSnapshot(familyA(9)));
  await expect(page.locator('#board-kpis .cockpit-card')).toHaveCount(5);
  expect(await columns()).toEqual({ perRow: 5, count: 5, overflow: false, rowFills: true });
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
  await expect(crew.locator('[data-kpi="children.active"] + .cockpit-fact__label')).toHaveText('sub-minions active');
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

test('on a phone the bar stays one sticky row of brand and buttons above the health pill; the pills step aside while the board is live', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const send = await harness(page, makeSnapshot({ ...familyA(4), pending: 30, vector: RAIDS_ON }));
  await send(makeSnapshot({ ...familyA(4), pending: 30, vector: RAIDS_ON }));
  await expect(page.locator('#command-radar-label')).toHaveText('RADAR LIVE');
  const read = () => page.evaluate(() => {
    const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
    const brand = document.querySelector('.command-bar__brand')!.getBoundingClientRect();
    return {
      position: getComputedStyle(document.getElementById('command-bar')!).position,
      barTop: box('command-bar').top,
      barHeight: document.getElementById('command-bar')!.offsetHeight,
      chromeH: getComputedStyle(document.documentElement).getPropertyValue('--chrome-h').trim(),
      ticker: box('command-ticker').width,
      // Row 1: every button shares the brand's row.
      buttonsOnRow1: ['sound-toggle', 'notification-bell', 'theme-toggle', 'settings-toggle']
        .every((id) => { const b = box(id); return b.width > 0 && Math.abs(b.top + b.height / 2 - (brand.top + brand.height / 2)) <= 2; }),
      kpis: getComputedStyle(document.getElementById('board-kpis')!).position,
    };
  });
  const top = await read();
  expect(top).toMatchObject({ position: 'sticky', ticker: 0, buttonsOnRow1: true, kpis: 'static' });
  // The re-measure runs on the bar's resize frame, so poll for it.
  await expect.poll(async () => { const now = await read(); return now.chromeH === `${now.barHeight}px`; }).toBe(true);
  // Three checks need a look, each with its flag, plus the Jev and wake
  // chips: the sticky bar still leaves most of the screen for the board.
  expect(top.barHeight).toBeLessThanOrEqual(740 * 0.25);
  // The card asides wrap under their label rather than vanish into "1…".
  const asides = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#board-kpis .cockpit-card__aside')]
    .map((aside) => ({ text: aside.textContent, whole: aside.scrollWidth <= aside.clientWidth + 1 })));
  expect(asides).toEqual([{ text: 'round 4 live', whole: true }, { text: '1/2 in 24h', whole: true }]);
  await page.evaluate(() => window.scrollBy(0, 1400));
  const scrolled = await read();
  expect(scrolled.barTop, 'the bar stays at the top').toBeCloseTo(0, 0);
  // The board socket drops (reconnects refused): RADAR returns on the phone
  // in its warning colour — nothing else there would say so. ROUND stays
  // aside.
  const liveHeights = new Map<number, number>();
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 740 });
    await settleTransitions(page);
    liveHeights.set(width, await page.evaluate(() => document.getElementById('command-bar')!.offsetHeight));
  }
  await page.setViewportSize({ width: 360, height: 740 });
  await settleTransitions(page);
  await dropBoardSocket(page);
  await expect(page.locator('#command-radar')).toBeVisible();
  await expect(page.locator('#command-radar')).toHaveClass(/command-pill--(warn|alert)/u);
  await expect(page.locator('#command-round')).toBeHidden();
  await expect(page.locator('#command-health-summary')).toHaveText(/^last-known · /u);
  // RADAR returns after the buttons, on a row of its own above the health
  // pill: the buttons keep the brand's row.
  for (const width of [360, 390, 430]) {
    await page.setViewportSize({ width, height: 740 });
    await settleTransitions(page);
    const lost = await page.evaluate(() => {
      const box = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      const brand = document.querySelector('.command-bar__brand')!.getBoundingClientRect();
      const mid = (b: DOMRect): number => b.top + b.height / 2;
      return {
        buttonsOnRow1: ['sound-toggle', 'notification-bell', 'theme-toggle', 'settings-toggle'].every((id) => Math.abs(mid(box(id)) - mid(brand)) <= 2),
        radarBetween: box('command-radar').top >= brand.bottom && box('command-radar').bottom <= box('command-health').top,
        barHeight: document.getElementById('command-bar')!.offsetHeight,
        radarRow: box('command-radar').height + parseFloat(getComputedStyle(document.getElementById('command-bar')!).rowGap),
      };
    });
    expect([lost.buttonsOnRow1, lost.radarBetween], `${width}px`).toEqual([true, true]);
    // The outage costs exactly RADAR's own row — the signal — and nothing else.
    expect(lost.barHeight - liveHeights.get(width)!, `${width}px bar growth`).toBeLessThanOrEqual(lost.radarRow + 1);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test('the health pill dot and ink say the state: muted when nothing reads ok or the board is last-known, ▲ only when something needs a look', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const send = await harness(page, makeSnapshot(familyA(0)));
  const read = () => page.evaluate(() => {
    const color = (value: string): string => {
      const probe = document.createElement('div');
      probe.style.background = value;
      document.body.append(probe);
      const c = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return c;
    };
    const dot = getComputedStyle(document.querySelector('.command-health__dot')!).backgroundColor;
    const mark = getComputedStyle(document.getElementById('command-health-summary')!, '::before').content;
    return {
      summary: document.getElementById('command-health-summary')!.textContent,
      dot: dot === color('var(--park)') ? 'muted' : dot === color('var(--done)') ? 'ok' : dot === color('var(--alert)') ? 'alert' : dot,
      mark,
    };
  });
  // Calm: every wired check reads ok or neutral, and one reads ok.
  await expect(page.locator('#command-health-summary')).toHaveText('All healthy');
  expect(await read()).toEqual({ summary: 'All healthy', dot: 'ok', mark: 'none' });
  // Something needs a look: the alert dot and the ▲ beside the colour.
  await send(makeSnapshot(familyA(2)));
  await expect(page.locator('#command-health-summary')).toHaveText('3 need a look');
  expect(await read()).toEqual({ summary: '3 need a look', dot: 'alert', mark: '"▲ "' });
  // Only a neutral fact (Silas, no wakes yet) is wired: quiet, muted.
  const quiet = { ...makeSnapshot(familyA(0)), build: null, verify: null, selfHeal: null, silas: { ...makeSnapshot(familyA(0)).silas!, lastWakeAt: null } };
  await send(quiet as BoardSnapshot);
  await expect(page.locator('#command-health-summary')).toHaveText('No problems reported');
  expect(await read()).toEqual({ summary: 'No problems reported', dot: 'muted', mark: 'none' });
  // Nothing wired: never the healthy green.
  await send({ ...quiet, silas: null } as BoardSnapshot);
  await expect(page.locator('#command-health-summary')).toHaveText('Checks not wired');
  expect(await read()).toEqual({ summary: 'Checks not wired', dot: 'muted', mark: 'none' });
  // A problem on screen, then the socket drops (every reconnect refused):
  // the alert dot and ▲ stay — last-known never hides what needs a look.
  await send(makeSnapshot(familyA(2)));
  await expect(page.locator('#command-health-summary')).toHaveText('3 need a look');
  await dropBoardSocket(page);
  await expect.poll(read).toEqual({ summary: 'last-known · 3 need a look', dot: 'alert', mark: '"▲ "' });
});

test('a dropped board socket on a calm board reads last-known with a muted dot, even after the HTTP catch-up lands', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const send = await harness(page, makeSnapshot(familyA(0)));
  await expect(page.locator('#command-health-summary')).toHaveText('All healthy');
  // Reconnects open a socket that never authenticates (the client waits in
  // `authenticating`), while the HTTP catch-up answers with a visibly newer
  // state: proof the catch-up rendered before the summary is read.
  await page.context().routeWebSocket(/\/board\/ws/, () => { /* never answers */ });
  send.stage(makeSnapshot(slotSpec({ ...familyA(0), wakes: 7, gruWakeAgeMs: 300_000 })));
  for (const socket of sockets) await socket.close();
  await expect(page.locator('#command-health')).toHaveAttribute('data-last-known', 'true');
  await page.clock.runFor(1_000); // the first reconnect: HTTP catch-up, then the hanging socket
  await expect(page.locator('#board-wakes .board-wakes__count')).toHaveText('7');
  await expect(page.locator('#command-health-summary')).toHaveText('last-known · All healthy');
  await expect(page.locator('#command-radar-label')).toHaveText('RADAR SYNCING');
  const dot = await page.evaluate(() => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--park)';
    document.body.append(probe);
    const muted = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return getComputedStyle(document.querySelector('.command-health__dot')!).backgroundColor === muted;
  });
  expect(dot, 'the dot is muted while last-known').toBe(true);
});

test('RADAR follows the board socket only: the chat socket dropping leaves its dot and word alone', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const chats: WebSocketRoute[] = [];
  let chatUp = true;
  await page.context().routeWebSocket((url) => url.pathname === '/ws', (ws) => {
    chats.push(ws);
    if (!chatUp) { void ws.close(); return; }
    ws.onMessage((data) => {
      if (String(data).includes('"type":"auth"')) ws.send(JSON.stringify({ type: 'auth_ok', seq: 0 }));
    });
  });
  const send = await harness(page, makeSnapshot(familyA(1)));
  await send(makeSnapshot(familyA(1)));
  await expect(page.locator('#chat-online')).toHaveAttribute('data-state', 'online');
  await expect(page.locator('#command-radar-label')).toHaveText('RADAR LIVE');
  await expect(page.locator('#conn-dot')).toHaveClass(/conn-dot--open/u);
  // The chat socket drops and keeps failing; the board socket is fine.
  chatUp = false;
  for (const chat of chats) await chat.close();
  await expect(page.locator('#chat-online')).not.toHaveAttribute('data-state', 'online');
  await expect(page.locator('#command-radar-label')).toHaveText('RADAR LIVE');
  await expect(page.locator('#conn-dot')).toHaveClass(/conn-dot--open/u);
  await expect(page.locator('#conn-dot')).toHaveAttribute('title', 'socket: open');
});

test('the RADAR and ROUND pills keep one width through every word, every round state and round 9→10', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await harness(page, makeSnapshot(familyA(1)));
  const widths = await page.evaluate(() => {
    const radar = document.getElementById('command-radar')!;
    const label = document.getElementById('command-radar-label')!;
    const radarWidths = ['IDLE', 'LIVE', 'STALE', 'DOWN', 'SYNCING'].map((word) => {
      label.textContent = `RADAR ${word}`;
      return radar.getBoundingClientRect().width;
    });
    const round = document.getElementById('command-round')!;
    const roundLabel = document.getElementById('command-round-label')!;
    const roundWidths = ['NO ROUND', 'ROUND <span class="command-pill__num">9</span> LIVE', 'ROUND <span class="command-pill__num">10</span> LIVE', 'ROUND <span class="command-pill__num">99</span> PENDING'].map((html) => {
      roundLabel.innerHTML = html;
      return round.getBoundingClientRect().width;
    });
    return { radarWidths, roundWidths };
  });
  expect(new Set(widths.radarWidths).size, `RADAR widths ${widths.radarWidths.join(', ')}`).toBe(1);
  expect(new Set(widths.roundWidths).size, `ROUND widths ${widths.roundWidths.join(', ')}`).toBe(1);
  // On any font the widest reading sits inside its slot with room to spare
  // (the slot, not the text, sets the width).
  const slack = await page.evaluate(() => {
    const room = (box: HTMLElement): number => {
      const range = document.createRange();
      range.selectNodeContents(box);
      return box.getBoundingClientRect().width - range.getBoundingClientRect().width;
    };
    const label = document.getElementById('command-radar-label')!;
    label.textContent = 'RADAR SYNCING';
    const roundLabel = document.getElementById('command-round-label')!;
    roundLabel.innerHTML = 'ROUND <span class="command-pill__num">99</span> PENDING';
    const widest = room(roundLabel);
    return { radar: room(label), round: widest, num: room(roundLabel.querySelector<HTMLElement>('.command-pill__num')!) };
  });
  expect(slack.radar, 'RADAR SYNCING inside its slot').toBeGreaterThanOrEqual(0.5);
  expect(slack.round, 'ROUND 99 PENDING inside its slot').toBeGreaterThanOrEqual(0.5);
  expect(slack.num, 'a two-digit round inside its slot').toBeGreaterThanOrEqual(0.5);
});

test('the command bar keeps the brand, the pills and the buttons on one row from 800px, two rows on a small tablet in every round state, buttons at the edge before the first snapshot', async ({ page }) => {
  // Before pairing the health pill is hidden: the buttons still sit at the
  // bar's right edge.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.locator('#pairing-view')).toBeVisible();
  await expect(page.locator('#command-health')).toBeHidden();
  const edge = await page.evaluate(() => {
    const bar = document.getElementById('command-bar')!;
    const pad = parseFloat(getComputedStyle(bar).paddingRight);
    return bar.getBoundingClientRect().right - pad - document.getElementById('settings-toggle')!.getBoundingClientRect().right;
  });
  expect(Math.abs(edge)).toBeLessThanOrEqual(1);
  const send = await harness(page, makeSnapshot(familyA(9)));
  for (const width of [800, 1000, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await settleTransitions(page);
    const rows = await page.evaluate(() => {
      const mid = (el: Element): number => { const b = el.getBoundingClientRect(); return b.top + b.height / 2; };
      const brand = mid(document.querySelector('.command-bar__brand')!);
      return ['command-ticker', 'sound-toggle', 'settings-toggle'].map((id) => Math.abs(mid(document.getElementById(id)!) - brand) <= 2);
    });
    expect(rows, `${width}px`).toEqual([true, true, true]);
  }
  // A small tablet (641–799px): ROUND steps aside (the REVIEWS card names
  // the round), so the brand, RADAR and the buttons share row 1 in every
  // round state, and the health pill keeps its own row.
  const roundsAs = (status: 'pending' | null): BoardSnapshot => {
    const value = makeSnapshot(familyA(9));
    return {
      ...value,
      repos: value.repos.map((repo) => ({
        ...repo,
        jobs: repo.jobs.map((job) => ({ ...job, rounds: status === null ? [] : job.rounds.map((round) => ({ ...round, status })) })),
      })),
    };
  };
  for (const [state, snapshot] of [['live', makeSnapshot(familyA(9))], ['pending', roundsAs('pending')], ['none', roundsAs(null)]] as const) {
    await send(snapshot);
    await expect(page.locator('#command-round-label')).toHaveText(state === 'none' ? 'NO ROUND' : state === 'live' ? /LIVE$/u : /PENDING$/u);
    for (const width of [641, 700, 744, 767, 799]) {
      await page.setViewportSize({ width, height: 900 });
      await settleTransitions(page);
      const small = await page.evaluate(() => {
        const mid = (el: Element): number => { const b = el.getBoundingClientRect(); return b.top + b.height / 2; };
        const brand = mid(document.querySelector('.command-bar__brand')!);
        const pill = document.getElementById('command-health')!.getBoundingClientRect();
        const radar = document.getElementById('command-radar')!.getBoundingClientRect();
        return {
          buttons: ['sound-toggle', 'notification-bell', 'theme-toggle', 'settings-toggle'].every((id) => Math.abs(mid(document.getElementById(id)!) - brand) <= 2),
          radarOnRow1: radar.width > 0 && Math.abs(radar.top + radar.height / 2 - brand) <= 2,
          roundHidden: document.getElementById('command-round')!.getBoundingClientRect().width === 0,
          pillBelow: pill.top >= radar.bottom,
        };
      });
      expect(small, `${width}px, round ${state}`).toEqual({ buttons: true, radarOnRow1: true, roundHidden: true, pillBelow: true });
    }
  }
});

test('the crew rail sets each sub-minion indented under the minion that created it', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const base = makeSnapshot(familyA(1));
  // Server order puts the sub-minion first; the rail moves it under its creator.
  const crew = {
    ...base,
    agents: [
      { ...agent('sub-worker', 'streaming'), parentage: 'child', parentAgentId: 'lead-minion' },
      { ...agent('lead-minion', 'streaming'), parentage: 'top-level' },
      { ...agent('other-minion', 'idle'), parentage: 'top-level' },
    ],
  } as unknown as BoardSnapshot;
  const send = await harness(page, base);
  await send(crew);
  const rows = page.locator('#board-agents .board-agent');
  await expect(rows).toHaveCount(3);
  const layout = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('#board-agents .board-agent')].map((row) => ({
    id: row.dataset.agentId,
    left: row.getBoundingClientRect().left,
    right: row.getBoundingClientRect().right,
  })));
  expect(layout.map((row) => row.id)).toEqual(['lead-minion', 'sub-worker', 'other-minion']);
  const [lead, sub, other] = layout;
  expect(sub!.left - lead!.left, 'one indent step').toBeCloseTo(16, 0);
  expect(other!.left).toBeCloseTo(lead!.left, 0);
  // The indented row still ends at the rail's edge (never overflows it).
  expect(sub!.right).toBeCloseTo(lead!.right, 0);
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
