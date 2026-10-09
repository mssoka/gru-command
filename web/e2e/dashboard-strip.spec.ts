import { expect, test, type Locator, type Page, type WebSocketRoute } from '@playwright/test';
import { isValidSnapshot, type BoardSnapshot } from '../src/lib/board-protocol.js';

/**
 * Slim status strip — synthetic geometry + truth suite (approved sample
 * #spec2; proof-harness repair phase dashboard-slim-strip-proof-repair-20261002;
 * ported onto current main by job dashboard-slim-strip-current-main-20261007).
 * Isolated fixtures only: no real owner data, no real project names, never
 * real owner controls.
 *
 * Harness contract:
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
 * Real page zoom (not DPR, not CSS transform) stays explicitly PENDING
 * operations/manual proof — no invented API.
 */

const MOCK_TOKEN = process.env.GRU_MOCK_TOKEN ?? 'dev-token';
/** Controlled frozen clock (documented page.clock API), ISO anchor. */
const FROZEN_NOW = Date.parse('2026-10-02T00:00:00.000Z');
/** A real past local day — never "today" under the frozen clock. */
const PAST_DAY = '2026-09-01T00:00:00.000Z';
/** One day in ms — day-unit wake-age fixtures (formatAge switches h→d at
 * 48h, so day boundaries are expressed in days, never nonexistent "99h"). */
const DAY = 86_400_000;

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
  long: boolean;
}

const DEFAULT_SLOTS: Slots = {
  working: 1, open: 0, inReview: 0, merged: 0, mergedToday: 0, done: 0, parked: 1,
  conflicting: 0, total: 1, liveMinions: 1, midTurn: 0, disposed: 1, failedToday: 0,
  active: 0, queued: 0, orphaned: 0, behind: 0, unacked: 0, wakes: 0, pending: 1,
  gruWakeAgeMs: null, silasWakeAgeMs: 7_200_000, deferredCount: 0, deferredTruncated: false,
  children: null, long: false,
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
const ACK_CONSEQUENCE =
  'Ack re-arms this worker and resumes supervision — it does NOT clear code/test/review holds.';

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
  await pair(page);
  await expect(page.locator('#chip-rail .strip-groups .strip-group')).toHaveCount(3);
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

interface Box { x: number; y: number; w: number; h: number }

interface Geometry {
  bodyOverflow: boolean;
  railOverflow: boolean;
  stripJson: string;
  statusH: number;
  moreNum: Box | null;
  moreBtn: Box | null;
  moreTail: Box | null;
  bandHead: { label: Box; countNum: Box; countText: Box };
}

/** Measure EVERY approved slot's rendered box. Targeted elements are
 * REQUIRED: an absent element throws (never two equal "-1" boxes); every
 * captured box must be POSITIVE; required identities/cardinalities (6
 * pairs, 6 keys, 3 groups, 13 data-kpi slots) are validated per
 * measurement; genuinely optional elements (the older-pending expander)
 * are represented as explicit nulls; and the TEXT of each label
 * neighboring a measured numeric slot is captured beside its geometry.
 * The mutable numbers themselves are asserted by the tests BEFORE each
 * measurement — never folded into this comparison. */
async function geometry(page: Page, opts: { expectOlder?: boolean; expectedKpis?: number; expectedGroups?: number; expectAgeSplit?: boolean } = {}): Promise<Geometry> {
  return page.evaluate(
    ({ expectOlder, expectedKpis, expectedGroups, expectAgeSplit }) => {
      const rail = document.getElementById('chip-rail');
      if (!rail) throw new Error('missing #chip-rail');
      const box = (el: Element): { x: number; y: number; w: number; h: number } => {
        const b = el.getBoundingClientRect();
        return { x: b.x, y: b.y, w: b.width, h: b.height };
      };
      const positive = (el: Element, what: string): { x: number; y: number; w: number; h: number } => {
        const b = box(el);
        if (!(b.w > 0) || !(b.h > 0)) throw new Error(`non-positive box for ${what}`);
        return b;
      };
      const need = (scope: ParentNode, sel: string): Element => {
        const el = scope.querySelector(sel);
        if (!el) throw new Error(`missing ${sel}`);
        return el;
      };
      // The honest no-wakes / last-wake-unknown states must NOT emit an
      // age-split node: assert its absence rather than skipping the state.
      const absent = (scope: ParentNode, sel: string, what: string): null => {
        if (scope.querySelector(sel) !== null) throw new Error(`unexpected ${what} in the honest-unknown wakes state`);
        return null;
      };
      const texts = (sel: string): string[] =>
        [...rail.querySelectorAll(sel)].map((el) => el.textContent ?? '');
      const pick = (sel: string): string =>
        JSON.stringify([...rail.querySelectorAll(sel)].map((el, i) => positive(el, `${sel}[${i}]`)));
      if (rail.querySelectorAll('.strip-pair').length !== 6) throw new Error('expected 6 status pairs');
      if (rail.querySelectorAll('.strip-group').length !== expectedGroups) throw new Error(`expected ${expectedGroups} count groups`);
      if (rail.querySelectorAll('.strip-key').length !== 6) throw new Error('expected 6 status keys');
      if (rail.querySelectorAll('[data-kpi]').length !== expectedKpis) throw new Error(`expected ${expectedKpis} data-kpi slots`);
      const strip = need(rail, '.strip-status');
      positive(strip, '.strip-status');
      const band = document.getElementById('board-owner');
      if (!band) throw new Error('missing #board-owner');
      const more = band.querySelector('.board-band__more-num');
      if (expectOlder && !more) throw new Error('missing older-pending numeric subpart');
      const moreBtn = more !== null ? more.closest('.board-band__more') : null;
      // The '+N older pending' adjacent text, measured as a real range box.
      let moreTail: { x: number; y: number; w: number; h: number } | null = null;
      if (moreBtn !== null) {
        const nodes = moreBtn.childNodes;
        const last = nodes[nodes.length - 1];
        if (!last || last.nodeType !== Node.TEXT_NODE) throw new Error('older-pending tail text missing');
        const range = document.createRange();
        range.selectNodeContents(last);
        const r = range.getBoundingClientRect();
        if (!(r.width > 0) || !(r.height > 0)) throw new Error('non-positive older-pending tail box');
        moreTail = { x: r.x, y: r.y, w: r.width, h: r.height };
      }
      const head = need(band, '.board-band__head');
      return {
        bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        railOverflow: rail.scrollWidth > rail.clientWidth,
        stripJson: JSON.stringify({
          boxes: [
            pick('.strip-key'),
            pick('.strip-value__num'),
            pick('.strip-value__txt'),
            pick('.strip-flag__num'),
            pick('.strip-flag__txt'),
            positive(need(rail, '.board-wakes__count'), '.board-wakes__count'),
            pick('.board-wakes__deferred'),
            // The age slots exist only when a wake fired with a valid stamp;
            // the honest-unknown mode asserts their ABSENCE instead.
            expectAgeSplit
              ? positive(need(rail, '.board-age-split__num'), '.board-age-split__num')
              : absent(rail, '.board-age-split__num', '.board-age-split__num'),
            expectAgeSplit
              ? positive(need(rail, '.board-age-split__lead'), '.board-age-split__lead')
              : absent(rail, '.board-age-split__lead', '.board-age-split__lead'),
            expectAgeSplit
              ? positive(need(rail, '.board-age-split__unit'), '.board-age-split__unit')
              : absent(rail, '.board-age-split__unit', '.board-age-split__unit'),
            positive(need(rail, '.board-decisions'), '.board-decisions'),
            pick('.strip-group'),
            pick('.strip-group__name'),
            pick('.strip-group__total-num'),
            pick('.strip-group__unit'),
            pick('.strip-kpi__k'),
            pick('[data-kpi]'),
          ],
          // Neighboring label text for every measured numeric slot.
          keys: texts('.strip-key'),
          valueTxt: texts('.strip-value__txt'),
          flagTxt: texts('.strip-flag__txt'),
          groupNames: texts('.strip-group__name'),
          groupUnits: texts('.strip-group__unit'),
          kpiKeys: texts('.strip-kpi__k'),
          ageLead: texts('.board-age-split__lead'),
          decisions: rail.querySelector('.board-decisions')?.textContent ?? '',
        }),
        statusH: strip.getBoundingClientRect().height,
        moreNum: more ? positive(more, '.board-band__more-num') : null,
        moreBtn: moreBtn ? positive(moreBtn, '.board-band__more') : null,
        moreTail,
        bandHead: {
          label: positive(need(head, '.board-band__label'), '.board-band__label'),
          countNum: positive(need(head, '.board-band__count-num'), '.board-band__count-num'),
          countText: positive(need(head, '.board-band__count'), '.board-band__count'),
        },
      };
    },
    { expectOlder: opts.expectOlder ?? false, expectedKpis: opts.expectedKpis ?? 13, expectedGroups: opts.expectedGroups ?? 3, expectAgeSplit: opts.expectAgeSplit ?? true },
  );
}

function comparePairwise(before: Geometry, after: Geometry): void {
  expect(after.bodyOverflow, 'no horizontal body overflow').toBe(false);
  expect(after.railOverflow, 'no horizontal rail overflow (honest wrap)').toBe(false);
  expect(after.stripJson).toBe(before.stripJson);
  expect(Math.abs(after.statusH - before.statusH)).toBeLessThanOrEqual(0.5);
  expect(after.moreNum).toEqual(before.moreNum);
  expect(after.moreBtn).toEqual(before.moreBtn);
  expect(after.moreTail).toEqual(before.moreTail);
  expect(after.bandHead).toEqual(before.bandHead);
}

async function waitForCount(page: Page, kpi: string, value: number, timeout = 5_000): Promise<void> {
  await expect
    .poll(() => page.evaluate((key) => document.querySelector<HTMLElement>(`[data-kpi="${key}"]`)?.textContent ?? '', kpi), { timeout })
    .toBe(String(value));
}

async function waitForPending(page: Page, value: number): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => document.querySelector<HTMLElement>('.board-band__count-num')?.textContent ?? ''))
    .toBe(String(value));
}

/** Assert EVERY intended slot's actual rendered value — the family sentries
 * stand before geometry so a measurement can never outrun its evidence. */
async function expectSlots(page: Page, kpis: readonly string[], value: number): Promise<void> {
  for (const kpi of kpis) {
    await expect(page.locator(`[data-kpi="${kpi}"]`)).toHaveText(String(value));
  }
}

/** Fixture-independent label families (asserted, never only compared). */
const STATUS_KEYS = ['DEPLOY', 'REVIEWS', 'SILAS', 'ALERTS', 'VERIFY', 'CURE'] as const;
const GROUP_NAMES = ['HEISTS', 'PRS', 'CREW'] as const;
const GROUP_UNITS = ['total'] as const;
const KPI_KEYS = [
  'working', 'in review', 'merged', 'done', 'parked', 'binned',
  'open', 'conflicting', 'merged today',
  'minions', 'mid-turn', 'disposed',
] as const;

interface FamilyTexts {
  readonly valueNum: readonly string[];
  readonly valueTxt: readonly string[];
  readonly flagNum: readonly string[];
  readonly flagTxt: readonly string[];
}

/** familyA's co-rendered value/flag families: the n-bearing facts render
 * exactly n, the SILAS wake age is its own controlled 2h and the cure
 * resume is the fixture default 1. */
function familyAFamilies(n: number): FamilyTexts {
  return {
    valueNum: [String(n), String(n), '2', String(n), '1'],
    valueTxt: [' behind', ' active', 'wake ', 'h ago', 'lock held', ' resumed'],
    flagNum: [String(n), String(n), String(n)],
    flagTxt: ['RESTART PENDING', ' FAILED', 'NEEDS GRU', ' QUEUED', ' ORPHANED'],
  };
}

/** familyB/familyC render NO flags — none of the flag conditions holds —
 * and the same fixed label/value text set. Pinned as the fixture's truth
 * so a legitimately empty family never compares vacuously []==[]. */
function familyBCFamilies(): FamilyTexts {
  return {
    valueNum: ['0', '2', '0', '1'],
    valueTxt: ['current', ' active', 'wake ', 'h ago', 'lock held', ' resumed'],
    flagNum: [],
    flagTxt: [],
  };
}

/** The 10000-valued familyA variant: the three >4-digit facts render
 * 10000 while the other facts keep their fixture values. */
function familyA10000Families(): FamilyTexts {
  return {
    valueNum: ['10000', '4', '2', '10000', '1'],
    valueTxt: [' behind', ' active', 'wake ', 'h ago', 'lock held', ' resumed'],
    flagNum: ['4', '4', '4'],
    flagTxt: ['RESTART PENDING', ' FAILED', 'NEEDS GRU', ' QUEUED', ' ORPHANED'],
  };
}

/** Assert EVERY measured family's exact rendered text — count AND identity,
 * in document order — so a dropped flag/label/numeric part fails here even
 * when the family is legitimately empty for the fixture. */
async function expectStripFamilies(page: Page, expected: FamilyTexts): Promise<void> {
  const seen = await page.evaluate(() => {
    const rail = document.getElementById('chip-rail');
    if (!rail) throw new Error('missing #chip-rail');
    const texts = (sel: string): string[] =>
      [...rail.querySelectorAll<HTMLElement>(sel)].map((el) => el.textContent ?? '');
    return {
      keys: texts('.strip-key'),
      valueNum: texts('.strip-value__num'),
      valueTxt: texts('.strip-value__txt'),
      flagNum: texts('.strip-flag__num'),
      flagTxt: texts('.strip-flag__txt'),
      groupNames: texts('.strip-group__name'),
      groupUnits: texts('.strip-group__unit'),
      kpiKeys: texts('.strip-kpi__k'),
    };
  });
  expect(seen.keys).toEqual([...STATUS_KEYS]);
  expect(seen.groupNames).toEqual([...GROUP_NAMES]);
  expect(seen.groupUnits).toEqual([...GROUP_UNITS]);
  expect(seen.kpiKeys).toEqual([...KPI_KEYS]);
  expect(seen.valueNum).toEqual([...expected.valueNum]);
  expect(seen.valueTxt).toEqual([...expected.valueTxt]);
  expect(seen.flagNum).toEqual([...expected.flagNum]);
  expect(seen.flagTxt).toEqual([...expected.flagTxt]);
}

/** The co-rendered group total must agree on BOTH views: its data-kpi
 * identity and its reserved numeric slot. */
async function expectTotal(page: Page, value: number): Promise<void> {
  await expect(page.locator('[data-kpi="jobs.total"]')).toHaveText(String(value));
  await expect(page.locator('.strip-group__total-num')).toHaveText(String(value));
}

/** The focused element must be EXACTLY this control — element identity
 * (never a lookalike sharing a control kind), with its stable action id
 * and control kind. */
async function expectFocusedControl(page: Page, locator: Locator, actionId: string, control: string): Promise<void> {
  await expect
    .poll(() =>
      locator.evaluate(
        (el, expected) =>
          el === document.activeElement &&
          el.dataset.actionId === expected.actionId &&
          el.dataset.control === expected.control,
        { actionId, control },
      ),
    )
    .toBe(true);
  const focused = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return { actionId: active?.dataset.actionId ?? '', control: active?.dataset.control ?? '' };
  });
  expect(focused).toEqual({ actionId, control });
}

/** familyA's REAL data-kpi identities (board-rail.ts): heists working/
 * in-review/merged, PRs open/merged-today, crew mid-turn/disposed/live. */
const FAMILY_A_KPIS: readonly string[] = [
  'jobs.working', 'jobs.inReview', 'jobs.merged', 'prs.open', 'prs.mergedToday',
  'lanes.midTurn', 'lanes.disposed', 'lanes.liveMinions',
];
/** familyB's REAL data-kpi identities: derived PR conflict, heist review/
 * merged/done/parked, crew live/disposed (total is the derived 4n+1). */
const FAMILY_B_KPIS: readonly string[] = [
  'prs.conflicting', 'jobs.inReview', 'jobs.merged', 'jobs.done', 'jobs.parked',
  'lanes.liveMinions', 'lanes.disposed',
];

const VIEWPORTS: ReadonlyArray<[number, number]> = [
  [1440, 900],
  [1200, 900],
  [768, 1024],
  [360, 740],
];

const BOUNDARIES: ReadonlyArray<readonly [number, number]> = [
  [9, 10],
  [99, 100],
  [999, 1000],
];

/** familyA's per-chip numeric slots AND the adjacent label parts that
 * must stay put while the numbers cross each boundary. */
async function expectFamilyAChips(page: Page, value: number): Promise<void> {
  await expect(page.locator('.strip-pair[data-chip="deploy"] .strip-value__num')).toHaveText(String(value));
  await expect(page.locator('.strip-pair[data-chip="deploy"] .strip-value__txt')).toHaveText(' behind');
  await expect(page.locator('.board-wakes__count')).toHaveText(String(value));
  // The active-review numeric value rides the reviews value slot.
  await expect(page.locator('.strip-pair[data-chip="reviews"] .strip-value__num')).toHaveText(String(value));
  await expect(page.locator('.strip-pair[data-chip="reviews"] .strip-flag__num')).toHaveText(String(value));
  await expect(page.locator('.strip-pair[data-chip="reviews"] .strip-flag__txt')).toHaveText(' FAILED');
  await expect(page.locator('.strip-pair[data-chip="verify"] .strip-flag__num')).toHaveText(String(value));
  await expect(page.locator('.strip-pair[data-chip="verify"] .strip-flag__txt')).toHaveText(' QUEUED');
  await expect(page.locator('.strip-pair[data-chip="cure"] .strip-flag__num')).toHaveText(String(value));
  await expect(page.locator('.strip-pair[data-chip="cure"] .strip-flag__txt')).toHaveText(' ORPHANED');
  await expect(page.locator('.strip-pair[data-chip="alerts"] .strip-value__num')).toHaveText(String(value));
}

for (const [width, height] of VIEWPORTS) {
  for (const [n, m] of BOUNDARIES) {
    test(`familyA slots render exactly ${n} then ${m} at ${width}×${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const send = await harness(page, makeSnapshot(familyA(n)));
      // EVERY intended slot asserts its actual n value BEFORE before-geometry
      // (the real PR merged-today identity is prs.mergedToday — there is no
      // jobs.mergedToday data-kpi in board-rail.ts).
      await expectSlots(page, FAMILY_A_KPIS, n);
      await expectFamilyAChips(page, n);
      await expectStripFamilies(page, familyAFamilies(n));
      await expectTotal(page, 3 * n + 1);
      const before = await geometry(page);
      expect(before.bodyOverflow).toBe(false);
      expect(before.railOverflow).toBe(false);
      await send(makeSnapshot(familyA(m)));
      // EVERY intended slot asserts its actual m value BEFORE after-geometry.
      await expectSlots(page, FAMILY_A_KPIS, m);
      await expectFamilyAChips(page, m);
      await expectStripFamilies(page, familyAFamilies(m));
      await expectTotal(page, 3 * m + 1);
      const after = await geometry(page);
      comparePairwise(before, after);
    });

    test(`familyB derived counts render exactly ${n} then ${m} at ${width}×${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const send = await harness(page, makeSnapshot(familyB(n)));
      // Every intended slot (and the two derived facts) rendered n FIRST.
      await expectSlots(page, FAMILY_B_KPIS, n);
      await expect(page.locator('[data-kpi="jobs.total"]')).toHaveText(String(4 * n + 1));
      await expect(page.locator('[data-kpi="prs.mergedToday"]')).toHaveText('1');
      await expectStripFamilies(page, familyBCFamilies());
      await expectTotal(page, 4 * n + 1);
      const before = await geometry(page);
      expect(before.bodyOverflow).toBe(false);
      expect(before.railOverflow).toBe(false);
      await send(makeSnapshot(familyB(m)));
      await expectSlots(page, FAMILY_B_KPIS, m);
      // The derived total is 4n+1 — merged-today stays exactly 1 because
      // mergedPlain is dated on a past local day. Both asserted BEFORE the
      // after-geometry, not after it.
      await expect(page.locator('[data-kpi="jobs.total"]')).toHaveText(String(4 * m + 1));
      await expect(page.locator('[data-kpi="prs.mergedToday"]')).toHaveText('1');
      await expectStripFamilies(page, familyBCFamilies());
      await expectTotal(page, 4 * m + 1);
      const after = await geometry(page);
      comparePairwise(before, after);
    });

    test(`familyC total renders exactly ${n} then ${m} at ${width}×${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const send = await harness(page, makeSnapshot(familyC(n)));
      await waitForCount(page, 'jobs.total', n);
      await expectStripFamilies(page, familyBCFamilies());
      await expectTotal(page, n);
      const before = await geometry(page);
      expect(before.bodyOverflow).toBe(false);
      expect(before.railOverflow).toBe(false);
      await send(makeSnapshot(familyC(m)));
      await waitForCount(page, 'jobs.total', m);
      await expectStripFamilies(page, familyBCFamilies());
      await expectTotal(page, m);
      const after = await geometry(page);
      comparePairwise(before, after);
      await expect(page.locator('[data-kpi="jobs.total"]')).toHaveText(String(m));
    });

    test(`pending count header renders exactly ${n} then ${m} at ${width}×${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const send = await harness(page, makeSnapshot({ ...familyC(4), pending: n }));
      await waitForPending(page, n);
      await expectStripFamilies(page, familyBCFamilies());
      await expectTotal(page, 4);
      // The hidden tail renders its ACTUAL value (n − 6 visible) — asserted
      // BEFORE before-geometry, never inferred.
      if (n > 6) await expect(page.locator('.board-band__more-num')).toHaveText(String(n - 6));
      const before = await geometry(page, { expectOlder: n > 6 });
      expect(before.bodyOverflow).toBe(false);
      expect(before.railOverflow).toBe(false);
      await send(makeSnapshot({ ...familyC(4), pending: m }));
      await waitForPending(page, m);
      await expectStripFamilies(page, familyBCFamilies());
      await expectTotal(page, 4);
      if (m > 6) await expect(page.locator('.board-band__more-num')).toHaveText(String(m - 6));
      const after = await geometry(page, { expectOlder: m > 6 });
      // Rows legitimately change with membership; the header slot, the
      // older-pending number, its button and adjacent '+N older pending'
      // text, the strip, and the status row must not move.
      expect(after.stripJson).toBe(before.stripJson);
      expect(Math.abs(after.statusH - before.statusH)).toBeLessThanOrEqual(0.5);
      expect(after.bandHead).toEqual(before.bandHead);
      expect(after.moreNum).toEqual(before.moreNum);
      expect(after.moreBtn).toEqual(before.moreBtn);
      expect(after.moreTail).toEqual(before.moreTail);
      if (m > 6) expect(after.moreNum).not.toBeNull();
      expect(after.bodyOverflow).toBe(false);
      expect(after.railOverflow).toBe(false);
    });
  }
}

test('GRU and SILAS wake ages vary independently; frozen clock lands 9→10, 99→100 and 999→1000 inside reserved slots', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const send = await harness(
    page,
    makeSnapshot({ ...familyA(4), gruWakeAgeMs: 300_000, silasWakeAgeMs: 7_200_000 }),
  );
  // Independent facts: Gru reads its 5m age, Silas its own 2h — never shared.
  const gruNum = page.locator('#board-wakes .board-age-split__num');
  const gruUnit = page.locator('#board-wakes .board-age-split__unit');
  const silasNum = page.locator('.strip-pair[data-chip="silas"] .strip-value__num');
  const silasUnit = page.locator('.strip-pair[data-chip="silas"] .strip-value__txt').last();
  await expect(gruNum).toHaveText('5');
  await expect(gruUnit).toHaveText('m ago');
  await expect(silasNum).toHaveText('2');
  await expect(silasUnit).toHaveText('h ago');
  await expectStripFamilies(page, familyAFamilies(4));
  const before = await geometry(page);
  // GRU moves, SILAS pinned. The clock is FIXED (setFixedTime holds
  // Date.now at the anchor), so 9s renders 9s — no race against real time.
  await send(makeSnapshot({ ...familyA(4), gruWakeAgeMs: 9_000, silasWakeAgeMs: 7_200_000 }));
  await expect(gruNum).toHaveText('9');
  await expect(gruUnit).toHaveText('s ago');
  await expect(silasNum).toHaveText('2'); // Silas genuinely untouched
  const mid = await geometry(page);
  await send(makeSnapshot({ ...familyA(4), gruWakeAgeMs: 10_000, silasWakeAgeMs: 7_200_000 }));
  await expect(gruNum).toHaveText('10');
  await expect(gruUnit).toHaveText('s ago');
  const after = await geometry(page);
  comparePairwise(mid, after);
  // Day units are representable only as days (formatAge switches h→d at
  // 48h — a "99h" age does not exist): 99d/100d and 999d/1000d cross in-slot.
  await send(makeSnapshot({ ...familyA(4), gruWakeAgeMs: 99 * DAY, silasWakeAgeMs: 7_200_000 }));
  await expect(gruNum).toHaveText('99');
  await expect(gruUnit).toHaveText('d ago');
  const gru99 = await geometry(page);
  await send(makeSnapshot({ ...familyA(4), gruWakeAgeMs: 100 * DAY, silasWakeAgeMs: 7_200_000 }));
  await expect(gruNum).toHaveText('100');
  const gru100 = await geometry(page);
  comparePairwise(gru99, gru100);
  await send(makeSnapshot({ ...familyA(4), gruWakeAgeMs: 999 * DAY, silasWakeAgeMs: 7_200_000 }));
  await expect(gruNum).toHaveText('999');
  const gru999 = await geometry(page);
  await send(makeSnapshot({ ...familyA(4), gruWakeAgeMs: 1000 * DAY, silasWakeAgeMs: 7_200_000 }));
  await expect(gruNum).toHaveText('1000');
  const gru1000 = await geometry(page);
  comparePairwise(gru999, gru1000);
  expect(before.stripJson).not.toBe(gru1000.stripJson); // the age genuinely changed
  // SILAS moves, GRU pinned — independence in the other direction.
  await send(makeSnapshot({ ...familyA(4), gruWakeAgeMs: 300_000, silasWakeAgeMs: 9_000 }));
  await expect(silasNum).toHaveText('9');
  await expect(silasUnit).toHaveText('s ago');
  await expect(gruNum).toHaveText('5'); // Gru genuinely untouched
  const silas9 = await geometry(page);
  await send(makeSnapshot({ ...familyA(4), gruWakeAgeMs: 300_000, silasWakeAgeMs: 10_000 }));
  await expect(silasNum).toHaveText('10');
  const silas10 = await geometry(page);
  comparePairwise(silas9, silas10);
  await send(makeSnapshot({ ...familyA(4), gruWakeAgeMs: 300_000, silasWakeAgeMs: 99 * DAY }));
  await expect(silasNum).toHaveText('99');
  await expect(silasUnit).toHaveText('d ago');
  const silas99 = await geometry(page);
  await send(makeSnapshot({ ...familyA(4), gruWakeAgeMs: 300_000, silasWakeAgeMs: 100 * DAY }));
  await expect(silasNum).toHaveText('100');
  const silas100 = await geometry(page);
  comparePairwise(silas99, silas100);
  // G3e: SILAS also crosses the 999d→1000d digit boundary in its own slot
  // (previously exercised on GRU only) while GRU stays pinned.
  await send(makeSnapshot({ ...familyA(4), gruWakeAgeMs: 300_000, silasWakeAgeMs: 999 * DAY }));
  await expect(silasNum).toHaveText('999');
  await expect(silasUnit).toHaveText('d ago');
  await expect(gruNum).toHaveText('5'); // Gru genuinely untouched
  const silas999 = await geometry(page);
  await send(makeSnapshot({ ...familyA(4), gruWakeAgeMs: 300_000, silasWakeAgeMs: 1000 * DAY }));
  await expect(silasNum).toHaveText('1000');
  await expect(silasUnit).toHaveText('d ago');
  const silas1000 = await geometry(page);
  comparePairwise(silas999, silas1000);
});

/** F4: the pending loop's hidden tail (n−6 → 3/4, 93/94, 993/994) never
 * crosses a DIGIT boundary itself. These dedicated fixtures do: exactly 6
 * visible rows with the HIDDEN count crossing 9→10, 99→100, 999→1000. */
const HIDDEN_BOUNDARIES: ReadonlyArray<readonly [number, number]> = [
  [9, 10],
  [99, 100],
  [999, 1000],
];

for (const [width, height] of [[1440, 900], [360, 740]] as const) {
  for (const [h1, h2] of HIDDEN_BOUNDARIES) {
    test(`older-pending hidden count crosses ${h1}→${h2} inside its reserved slot at ${width}×${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      const send = await harness(page, makeSnapshot({ ...familyC(4), pending: 6 + h1 }));
      await waitForPending(page, 6 + h1);
      // Exactly 6 visible rows; the expander carries the ACTUAL hidden value.
      await expect(page.locator('#board-owner .board-owner__row')).toHaveCount(6);
      await expect(page.locator('.board-band__more-num')).toHaveText(String(h1));
      await expectStripFamilies(page, familyBCFamilies());
      await expectTotal(page, 4);
      const before = await geometry(page, { expectOlder: true });
      await send(makeSnapshot({ ...familyC(4), pending: 6 + h2 }));
      await waitForPending(page, 6 + h2);
      await expect(page.locator('.board-band__more-num')).toHaveText(String(h2)); // BEFORE geometry
      await expectStripFamilies(page, familyBCFamilies());
      await expectTotal(page, 4);
      const after = await geometry(page, { expectOlder: true });
      // The hidden numeric slot, its button, AND the adjacent ' older
      // pending' text hold their geometry across the hidden digit boundary.
      expect(after.moreNum).not.toBeNull();
      expect(after.moreNum).toEqual(before.moreNum);
      expect(after.moreBtn).toEqual(before.moreBtn);
      expect(after.moreTail).toEqual(before.moreTail);
      expect(after.stripJson).toBe(before.stripJson);
      expect(Math.abs(after.statusH - before.statusH)).toBeLessThanOrEqual(0.5);
      expect(after.bandHead).toEqual(before.bandHead);
      expect(after.bodyOverflow).toBe(false);
      expect(after.railOverflow).toBe(false);
    });
  }
}

// G1: one test per viewport — a fresh page fixture per cadence means ONE
// harness install (routes, frozen clock, pairing) each; the old single test
// called harness four times on one page, stacking ws/HTTP handlers and
// re-installing an already-installed clock. All four viewport checks and
// the growing-count checks are preserved.
for (const [width, height] of VIEWPORTS) {
  test(`10000-valued slots grow honestly — visible, unclipped, unmasked at ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await harness(page, makeSnapshot({ ...familyA(4), wakes: 10000, behind: 10000, unacked: 10000 }));
    await waitForCount(page, 'prs.open', 4);
    // The co-rendered flags/values and the group total stay truthful at the
    // >4-digit state (G2/A2): flags exact, total 13, merged-today 4.
    await expectStripFamilies(page, familyA10000Families());
    await expectTotal(page, 13);
    await expect(page.locator('[data-kpi="prs.mergedToday"]')).toHaveText('4');
    // The three >4-digit facts render their full honest values.
    await expect(page.locator('.board-wakes__count')).toHaveText('10000');
    await expect(page.locator('.strip-pair[data-chip="deploy"] .strip-value__num')).toHaveText('10000');
    await expect(page.locator('.strip-pair[data-chip="alerts"] .strip-value__num')).toHaveText('10000');
    const audit = await page.evaluate(() => {
      const rail = document.getElementById('chip-rail')!;
      const inner = [
        ...rail.querySelectorAll<HTMLElement>(
          '.strip-status, .strip-groups, .strip-group, .strip-group__head, .strip-group__pairs, .strip-value, .strip-flag, .strip-kpi',
        ),
      ];
      const visible = (sel: string): boolean => {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) return false;
        const b = el.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      };
      return {
        body: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        rail: rail.scrollWidth > rail.clientWidth,
        maxInner: Math.max(0, ...inner.map((el) => el.scrollWidth - el.clientWidth)),
        slotsVisible: [
          '.board-wakes__count',
          '.strip-pair[data-chip="deploy"] .strip-value__num',
          '.strip-pair[data-chip="alerts"] .strip-value__num',
        ].map(visible),
      };
    });
    expect(audit.body, `no body overflow at ${width}×${height}`).toBe(false);
    expect(audit.rail, `no rail overflow at ${width}×${height}`).toBe(false);
    // >1px of scroll area beyond the box would mean real clipped/masked
    // content; sub-pixel rounding is not a hidden digit.
    expect(audit.maxInner, `no clipped/masked strip content at ${width}×${height}`).toBeLessThanOrEqual(1);
    expect(audit.slotsVisible.every(Boolean), `all 10000 slots visible at ${width}×${height}`).toBe(true);
  });
}

test('768px keeps the selected tablet density; 620px stacks at the 640px container transition', async ({ page }) => {
  // Layout reflow evidence at the container transition. Real browser-zoom
  // (page zoom, not DPR, not CSS transform) has no supported Playwright
  // API — that proof is explicitly PENDING operations/manual capture.
  await page.setViewportSize({ width: 768, height: 1024 });
  await harness(page, makeSnapshot(familyA(9)));
  await waitForCount(page, 'prs.open', 9);
  const tablet = await page.evaluate(() => {
    const groups = [...document.querySelectorAll<HTMLElement>('.strip-group')].map((g) => g.getBoundingClientRect());
    return { row: Math.abs(groups[0]!.y - groups[1]!.y) <= 0.5 && Math.abs(groups[1]!.y - groups[2]!.y) <= 0.5 };
  });
  expect(tablet.row, 'three columns share one row at 768 (tablet density)').toBe(true);
  await page.setViewportSize({ width: 620, height: 900 });
  const stacked = await page.evaluate(() => {
    const rail = document.getElementById('chip-rail')!;
    const groups = [...rail.querySelectorAll<HTMLElement>('.strip-group')].map((g) => g.getBoundingClientRect());
    return {
      stacked: groups[1]!.y > groups[0]!.y && groups[2]!.y > groups[1]!.y,
      overflow: rail.scrollWidth > rail.clientWidth,
    };
  });
  expect(stacked.stacked, 'below the 640px transition groups stack honestly').toBe(true);
  expect(stacked.overflow).toBe(false);
});

test('long labels wrap as text; the long notification reveals its COMPLETE original detail and consequence; reveal sends nothing', async ({ page }) => {
  const ackCalls: string[] = [];
  await page.route(/\/ack/, async (route) => {
    ackCalls.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.setViewportSize({ width: 1200, height: 900 });
  // pending: 2 — a long NOTIFICATION row AND the long PR row both exist
  // (pending 1 would have left only the PR row and proved nothing here).
  const long: Partial<Slots> = { long: true, pending: 2 };
  const send = await harness(page, makeSnapshot(slotSpec({ ...familyA(9), ...long })));
  await waitForCount(page, 'prs.open', 9);
  await expectStripFamilies(page, familyAFamilies(9));
  await expectTotal(page, 3 * 9 + 1);
  const overflow = await page.evaluate(() => {
    const rail = document.getElementById('chip-rail')!;
    const band = document.getElementById('board-owner')!;
    return {
      body: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      rail: rail.scrollWidth > rail.clientWidth,
      band: band.scrollWidth > band.clientWidth,
    };
  });
  expect(overflow.body).toBe(false);
  expect(overflow.rail).toBe(false);
  expect(overflow.band).toBe(false);
  const band = page.locator('#board-owner');
  const ackDisclose = band.locator('[data-action-id="owner-ack:pend-0000"][data-control="disclose"]');
  await expect(ackDisclose).toBeVisible();
  // Row anchored by the disclosure's OWN aria-controls region — a
  // `has:`-nested locator double-roots (#board-owner inside the row can
  // never match), so the region id is the honest identity here.
  const ackRegion = (await ackDisclose.getAttribute('aria-controls')) ?? '';
  const ackRow = page.locator(`.board-owner__row:has(> #${ackRegion})`);
  // The long SUPPLIED title is the Problem face — exact, never truncated.
  await expect(ackRow.locator('.board-owner__title')).toHaveText(
    `long owner stop title pend-0000 ${'deliberately wordy notice heading '.repeat(6).trim()}`,
  );
  // G3d: the LONG notification's exact full detail + consequence are
  // revealed via KEYBOARD (Enter), not only by click; the click path stays
  // covered on the PR row below.
  await ackDisclose.focus();
  await page.keyboard.press('Enter');
  await expect(ackDisclose).toHaveAttribute('aria-expanded', 'true');
  // The COMPLETE original detail and the FULL consequence, exact — a suffix
  // match would not prove the original text survived intact.
  await expect(ackRow.locator('.board-owner__detail-text')).toHaveText([
    ACK_DETAIL('pend-0000'),
    ACK_CONSEQUENCE,
  ]);
  const prDisclose = band.locator('[data-action-id="owner-pr:synthetic"][data-control="disclose"]');
  const prRegion = (await prDisclose.getAttribute('aria-controls')) ?? '';
  const prRow = page.locator(`.board-owner__row:has(> #${prRegion})`);
  await expect(prRow.locator('.board-owner__title')).toHaveText(
    `long ready heist ${'deliberately wordy pr heading '.repeat(6).trim()}`,
  );
  await prDisclose.click();
  await expect(prDisclose).toHaveAttribute('aria-expanded', 'true');
  await send(makeSnapshot(slotSpec({ ...familyA(10), ...long })));
  await waitForCount(page, 'prs.open', 10);
  await expectStripFamilies(page, familyAFamilies(10));
  await expectTotal(page, 3 * 10 + 1);
  // Both expansions (and the exact revealed text) survive the push.
  await expect(ackDisclose).toHaveAttribute('aria-expanded', 'true');
  await expect(prDisclose).toHaveAttribute('aria-expanded', 'true');
  await expect(ackRow.locator('.board-owner__detail-text')).toHaveText([
    ACK_DETAIL('pend-0000'),
    ACK_CONSEQUENCE,
  ]);
  expect(ackCalls).toEqual([]);
  // Phone leg: the same long labels must wrap honestly in the ≤560px
  // stacked band without horizontal overflow (body, band, or detail box),
  // and BOTH long rows must still be revealed there (never vacuous).
  await page.setViewportSize({ width: 360, height: 740 });
  await expect(band.locator('.board-owner__detail:visible')).toHaveCount(2);
  await expect(ackDisclose).toHaveAttribute('aria-expanded', 'true');
  const phoneOverflow = await page.evaluate(() => {
    const bandEl = document.getElementById('board-owner')!;
    const details = [...bandEl.querySelectorAll<HTMLElement>('.board-owner__detail')];
    return {
      body: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      band: bandEl.scrollWidth > bandEl.clientWidth,
      detail: details.length === 2 && details.every((node) => node.scrollWidth <= node.clientWidth + 1),
    };
  });
  expect(phoneOverflow.body).toBe(false);
  expect(phoneOverflow.band).toBe(false);
  expect(phoneOverflow.detail).toBe(true);
});

test('keyboard reveal on independent Ack and PR rows sends nothing; Ack, OPEN PR, and disclosure focus survive refresh and full reconnect', async ({ page }) => {
  const ackCalls: string[] = [];
  await page.route(/\/ack/, async (route) => {
    ackCalls.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  const send = await harness(page, makeSnapshot({ ...familyA(4), pending: 2 }));
  await expectStripFamilies(page, familyAFamilies(4));
  const band = page.locator('#board-owner');
  const ackDisclose = band.locator('[data-action-id="owner-ack:pend-0000"][data-control="disclose"]');
  const prDisclose = band.locator('[data-action-id="owner-pr:synthetic"][data-control="disclose"]');
  const ackButton = band.locator('[data-action-id="owner-ack:pend-0000"][data-control="ack"]');
  const prOpen = band.locator('[data-action-id="owner-pr:synthetic"][data-control="open"]');
  // Stable region identity is captured up front and re-asserted after every
  // refresh/reconnect leg below (the aria-controls target never moves).
  const ackRegion = (await ackDisclose.getAttribute('aria-controls')) ?? '';
  const prRegion = (await prDisclose.getAttribute('aria-controls')) ?? '';
  expect(ackRegion).toMatch(/^fy-detail-\d+$/);
  expect(prRegion).toMatch(/^fy-detail-\d+$/);
  expect(ackRegion).not.toBe(prRegion);
  // Keyboard Enter on the Ack row; Space on the PR row — independent.
  await ackDisclose.focus();
  await page.keyboard.press('Enter');
  await expect(ackDisclose).toHaveAttribute('aria-expanded', 'true');
  // Unique accessible name per disclosure (row identity in the AT list).
  await expect(ackDisclose).toHaveAttribute('aria-label', /^Review decision: .+\(owner-ack:pend-0000\)$/);
  // Themed keyboard focus ring on the new control (:focus-visible after a
  // keyboard interaction) — width, style, token colour and offset pinned.
  const ringOf = (locator: Locator) =>
    locator.evaluate((el) => {
      const s = getComputedStyle(el);
      return { width: s.outlineWidth, style: s.outlineStyle, color: s.outlineColor, offset: s.outlineOffset };
    });
  // The ring colour is the theme's focus token, read from the document
  // rather than duplicated here: a legitimate token change keeps the test
  // meaningful, and a ring that ignores the token still fails (the ring
  // must EQUAL the token, not merely be a colour).
  const focusRingColor = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--work)';
    document.body.append(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    return computed;
  });
  expect(await ringOf(ackDisclose)).toEqual({
    width: '3px',
    style: 'solid',
    color: focusRingColor,
    offset: '2px',
  });
  // The button is literally labeled Ack; the FULL consequence and the
  // complete original detail sit in the same row's visible region,
  // beside the control, BEFORE any activation.
  await expect(ackButton).toHaveText('Ack');
  await expect(ackButton).toBeVisible();
  const ackRow = page.locator(`.board-owner__row:has(> #${ackRegion})`);
  await expect(ackRow.locator('.board-owner__detail-text')).toHaveText([
    ACK_DETAIL('pend-0000'),
    ACK_CONSEQUENCE,
  ]);
  await prDisclose.focus();
  await page.keyboard.press('Space');
  await expect(prDisclose).toHaveAttribute('aria-expanded', 'true');
  await expect(ackDisclose).toHaveAttribute('aria-expanded', 'true'); // rows disclose independently
  expect(ackCalls).toEqual([]);
  // Focused Ack survives a genuinely changed scripted push (4→10) — proved
  // by the rendered number AND by exact focused-element identity.
  await ackButton.focus();
  await send(makeSnapshot({ ...familyA(10), pending: 2 }));
  await waitForCount(page, 'prs.open', 10);
  await expectStripFamilies(page, familyAFamilies(10));
  await expectFocusedControl(page, ackButton, 'owner-ack:pend-0000', 'ack');
  // Themed keyboard focus ring survives the restore on the explicit Ack
  // control too (not only on the disclosure).
  expect(await ringOf(ackButton)).toEqual({ width: '3px', style: 'solid', color: focusRingColor, offset: '2px' });
  // Focused OPEN PR survives the same way (10→99) — focused, never activated.
  await prOpen.focus();
  await send(makeSnapshot({ ...familyA(99), pending: 2 }));
  await waitForCount(page, 'prs.open', 99);
  await expectFocusedControl(page, prOpen, 'owner-pr:synthetic', 'open');
  expect(await ringOf(prOpen)).toEqual({ width: '3px', style: 'solid', color: focusRingColor, offset: '2px' });
  // Full reconnect (socket close → re-auth → HTTP refetch) with the OPEN PR
  // control focused: the refetched state is genuinely CHANGED (100).
  send.stage(makeSnapshot({ ...familyA(100), pending: 2 }));
  sockets[sockets.length - 1]!.close();
  await waitForCount(page, 'prs.open', 100, 15_000);
  await expect.poll(() => send.socketCount(), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await expectFocusedControl(page, prOpen, 'owner-pr:synthetic', 'open');
  // F5/G3a-b-c: DISCLOSURE focus + expanded region survive a genuinely
  // changed push (the rendered 100→5 proves the re-render), asserted by
  // EXACT element identity — a restore to the other row's disclosure fails.
  await ackDisclose.focus();
  await send(makeSnapshot({ ...familyA(5), pending: 2 }));
  await waitForCount(page, 'prs.open', 5);
  await expectFocusedControl(page, ackDisclose, 'owner-ack:pend-0000', 'disclose');
  await expect(ackDisclose).toHaveAttribute('aria-expanded', 'true');
  await expect(ackDisclose).toHaveAttribute('aria-controls', ackRegion);
  await prDisclose.focus();
  await send(makeSnapshot({ ...familyA(6), pending: 2 }));
  await waitForCount(page, 'prs.open', 6);
  await expectFocusedControl(page, prDisclose, 'owner-pr:synthetic', 'disclose');
  await expect(prDisclose).toHaveAttribute('aria-expanded', 'true');
  await expect(prDisclose).toHaveAttribute('aria-controls', prRegion);
  // G3a: DISCLOSURE focus and region survive a FULL reconnect too — stage a
  // genuinely changed refetch state (200), close the socket, prove the
  // refetched number rendered, then prove the SAME disclosure element holds
  // focus; the other row's disclosure must NOT hold it.
  await ackDisclose.focus();
  send.stage(makeSnapshot({ ...familyA(200), pending: 2 }));
  sockets[sockets.length - 1]!.close();
  await waitForCount(page, 'prs.open', 200, 15_000);
  await expect.poll(() => send.socketCount(), { timeout: 15_000 }).toBeGreaterThanOrEqual(3);
  await expectFocusedControl(page, ackDisclose, 'owner-ack:pend-0000', 'disclose');
  await expect(ackDisclose).toHaveAttribute('aria-expanded', 'true');
  await expect(ackDisclose).toHaveAttribute('aria-controls', ackRegion);
  expect(await prDisclose.evaluate((el) => el === document.activeElement)).toBe(false);
  // The focused ACK control also survives a full reconnect (201 refetch).
  await ackButton.focus();
  send.stage(makeSnapshot({ ...familyA(201), pending: 2 }));
  sockets[sockets.length - 1]!.close();
  await waitForCount(page, 'prs.open', 201, 15_000);
  await expect.poll(() => send.socketCount(), { timeout: 15_000 }).toBeGreaterThanOrEqual(4);
  await expectFocusedControl(page, ackButton, 'owner-ack:pend-0000', 'ack');
  await expect(ackDisclose).toHaveAttribute('aria-controls', ackRegion); // region identity survived reconnect
  // No unexpected mutation, no PR navigation: pending unchanged, nothing
  // acked, still on the board (controls were focused, never activated).
  await waitForPending(page, 2);
  expect(new URL(page.url()).pathname).toBe('/');
  expect(ackCalls).toEqual([]);
});

test('essential text and numbers hold >=4.5:1 contrast in both themes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  // Every measured target must actually be RENDERED (an absent target fails
  // loud): conflicting > 0 for the loudest KPI ink, deferred > 0 for the
  // wakes deferred slot, and more pending rows than the band window so the
  // older-pending expander (and its reserved number) exists.
  await harness(page, makeSnapshot(slotSpec({ ...familyA(4), conflicting: 3, deferredCount: 12, pending: 9 })));
  await expectStripFamilies(page, familyAFamilies(4));
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
      const bgOf = (el: Element): string => {
        let n: Element | null = el;
        while (n) {
          const c = getComputedStyle(n).backgroundColor;
          if (c && c !== 'transparent' && !/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)/.test(c)) return c;
          n = n.parentElement;
        }
        return 'rgb(250, 246, 239)';
      };
      const ratioOf = (selector: string): number => {
        const el = document.querySelector<HTMLElement>(selector);
        if (!el) return -1;
        const l1 = lum(getComputedStyle(el).color);
        const l2 = lum(bgOf(el));
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      const targets: Record<string, string> = {
        statusKey: '.strip-pair[data-chip="deploy"] .strip-key',
        statusValue: '.strip-pair[data-chip="deploy"] .strip-value__num',
        flagText: '.strip-flag__txt',
        kpiKey: '.strip-kpi__k',
        kpiNum: '.strip-kpi__num',
        groupName: '.strip-group__name',
        groupUnit: '.strip-group__unit',
        groupTotalNum: '.strip-group__total-num',
        alertKpi: '.strip-kpi__num--alert',
        wakeCount: '.board-wakes__count',
        wakeDeferred: '.board-wakes__deferred',
        ageSplitUnit: '.board-age-split__unit',
        // Every non-deploy status VALUE, not just DEPLOY's (each pair's
        // number is the element a reader actually scans).
        reviewsValue: '.strip-pair[data-chip="reviews"] .strip-value__num',
        silasValue: '.strip-pair[data-chip="silas"] .strip-value__num',
        cureValue: '.strip-pair[data-chip="cure"] .strip-value__num',
        ownerTitle: '.board-owner__title',
        ownerNext: '.board-owner__next',
        // The bold "Next step:" label is measured in BOTH themes: the dark
        // capture shows it as the row's least legible text.
        ownerNextLabel: '.board-owner__next-label',
        ownerConsequence: '.board-owner__detail-text',
        detailMeta: '.board-owner__detail-meta',
        detailNotice: '.board-owner__detail-notice',
        bandCount: '.board-band__count',
        bandMoreNum: '.board-band__more-num',
      };
      return Object.fromEntries(Object.entries(targets).map(([k, s]) => [k, Math.round(ratioOf(s) * 100) / 100]));
    });
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') {
      await page.locator('#theme-toggle').click();
      await expect(page.locator('html')).toHaveClass(/dark/);
      // Measure the THEME, never a mid-animation blend: body color and the
      // surface backgrounds transition on different elements, so wait until
      // no CSS transition is still RUNNING before reading computed colors.
      // A transition cancelled mid-flip resolves as finished (its
      // replacement is re-checked on the next pass), so a cancellation
      // can never reject this wait or race the measurement.
      await page.evaluate(async () => {
        for (let pass = 0; pass < 60; pass += 1) {
          const running = document
            .getAnimations()
            .filter((a) => a instanceof CSSTransition && a.playState === 'running');
          if (running.length === 0) return;
          await Promise.all(running.map((a) => a.finished.catch(() => undefined)));
        }
      });
    }
    const ratios = await measure();
    for (const [name, ratio] of Object.entries(ratios)) {
      expect(ratio, `${name} contrast (${theme})`).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test('CHILDREN group appears only when the server reported counters (absent is not zero)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const send = await harness(page, makeSnapshot(slotSpec({})));
  // Absent children block: exactly the three stable groups.
  await expect(page.locator('#chip-rail .strip-group')).toHaveCount(3);
  // A present zero report is still a report: the group appears with zeros.
  await send(makeSnapshot(slotSpec({ children: { active: 0, queued: 0, finished: 0, lifetimeCreations: 0 } })));
  await expect(page.locator('#chip-rail .strip-group')).toHaveCount(4);
  const children = page.locator('#chip-rail .strip-group').nth(3);
  await expect(children.locator('.strip-group__name')).toHaveText('CHILDREN');
  // The 4th group's own identity contract: every KPI key label in document
  // order, and a reserved numeric slot behind every value (expectStripFamilies
  // covers the base three groups only).
  await expect(children.locator('.strip-kpi__k')).toHaveText(['active', 'queued', 'finished', 'created']);
  await expect(children.locator('.strip-kpi')).toHaveCount(4);
  expect(await children.locator('.strip-kpi__num.num').count(), 'every CHILDREN value rides a reserved .num slot').toBe(4);
  await expect(children.locator('[data-kpi="children.active"]')).toHaveText('0');
  await expect(children.locator('[data-kpi="children.queued"]')).toHaveText('0');
  await expect(children.locator('[data-kpi="children.finished"]')).toHaveText('0');
  await expect(children.locator('[data-kpi="children.lifetimeCreations"]')).toHaveText('0');
  // Present non-zero counts render truthfully.
  await send(makeSnapshot(slotSpec({ gruWakeAgeMs: 300_000, children: { active: 2, queued: 3, finished: 5, lifetimeCreations: 10 } })));
  await expect(children.locator('[data-kpi="children.active"]')).toHaveText('2');
  await expect(children.locator('[data-kpi="children.queued"]')).toHaveText('3');
  await expect(children.locator('[data-kpi="children.finished"]')).toHaveText('5');
  await expect(children.locator('[data-kpi="children.lifetimeCreations"]')).toHaveText('10');
  // The wrapped 4th group gets a row separator, no stray left border, and
  // row-edge alignment (left flush with the first column; the row's last
  // item flush right) — matching the 1-row layout's edges.
  const separators = await page.evaluate(() => {
    const groups = [...document.querySelectorAll<HTMLElement>('#chip-rail .strip-group')];
    const read = (el: Element | undefined): { left: string; top: string; padLeft: string; padRight: string } => {
      if (!el) throw new Error('missing group');
      const s = getComputedStyle(el);
      return { left: s.borderLeftWidth, top: s.borderTopWidth, padLeft: s.paddingLeft, padRight: s.paddingRight };
    };
    return { first: read(groups[0]), second: read(groups[1]), third: read(groups[2]), wrapped: read(groups[3]) };
  });
  expect(separators.first.left).toBe('0px');
  expect(separators.second.left).toBe('2px');
  expect(separators.wrapped.left).toBe('0px');
  expect(separators.wrapped.top).toBe('2px');
  expect(separators.first.padLeft).toBe('0px');
  expect(separators.second.padLeft).toBe('18px');
  expect(separators.wrapped.padLeft).toBe('0px');
  expect(separators.third.padRight).toBe('0px');
  expect(separators.wrapped.padRight).toBe('0px');
  // The wrapped layout is auditable too: same reserved-slot geometry across
  // two 4-group states (the second push changes all four values).
  const childrenFirst = await geometry(page, { expectedKpis: 17, expectedGroups: 4 });
  await send(makeSnapshot(slotSpec({ gruWakeAgeMs: 300_000, children: { active: 4, queued: 0, finished: 6, lifetimeCreations: 20 } })));
  await expect(children.locator('[data-kpi="children.active"]')).toHaveText('4');
  await expect(children.locator('[data-kpi="children.queued"]')).toHaveText('0');
  await expect(children.locator('[data-kpi="children.finished"]')).toHaveText('6');
  await expect(children.locator('[data-kpi="children.lifetimeCreations"]')).toHaveText('20');
  const childrenNext = await geometry(page, { expectedKpis: 17, expectedGroups: 4 });
  comparePairwise(childrenFirst, childrenNext);
  // The container-transition band (640–900px) where the 4-group wrap edge
  // rules engage: measure it at 768 and compare across a value change.
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(page.locator('#chip-rail .strip-group')).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  const tabletFirst = await geometry(page, { expectedKpis: 17, expectedGroups: 4 });
  await send(makeSnapshot(slotSpec({ gruWakeAgeMs: 300_000, children: { active: 7, queued: 1, finished: 9, lifetimeCreations: 30 } })));
  await expect(children.locator('[data-kpi="children.active"]')).toHaveText('7');
  const tabletNext = await geometry(page, { expectedKpis: 17, expectedGroups: 4 });
  comparePairwise(tabletFirst, tabletNext);

  // The extra group wraps honestly: no body or rail overflow at phone width.
  await page.setViewportSize({ width: 360, height: 800 });
  const overflow = await page.evaluate(
    () => ({
      body: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      rail: (() => {
        const rail = document.getElementById('chip-rail');
        return rail === null || rail.scrollWidth <= rail.clientWidth + 1;
      })(),
    }),
  );
  expect(overflow.body).toBe(true);
  expect(overflow.rail).toBe(true);
});

test('deferred Gru wakes stay visible beside count and age (issue #219)', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const send = await harness(
    page,
    makeSnapshot(slotSpec({ wakes: 4, gruWakeAgeMs: 300_000, deferredCount: 2 })),
  );
  const wakes = page.locator('#board-wakes');
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
  // The deferred number rides the same reserved slot across its own
  // digit boundaries: nothing in the chip moves at 999→1000.
  await send(makeSnapshot(slotSpec({ wakes: 4, gruWakeAgeMs: 300_000, deferredCount: 999 })));
  await expect(wakes.locator('.board-wakes__deferred')).toHaveText('999');
  const deferred999 = await geometry(page);
  await send(makeSnapshot(slotSpec({ wakes: 4, gruWakeAgeMs: 300_000, deferredCount: 1000 })));
  await expect(wakes.locator('.board-wakes__deferred')).toHaveText('1000');
  const deferred1000 = await geometry(page);
  comparePairwise(deferred999, deferred1000);
  // Deferred-only (zero fired wakes, no stamp): the honest no-wakes state
  // still shows the deferred demand — never a fabricated "unknown" time.
  await send(makeSnapshot(slotSpec({ wakes: 0, gruWakeAgeMs: null, deferredCount: 1 })));
  await expect(wakes).toContainText('no wakes yet');
  await expect(wakes).toContainText('1 deferred');
  await expect(wakes).not.toContainText('last wake unknown');
  // The honest no-wakes state carries no age-split node: measure its OWN
  // stability across a count change (1 -> 999 deferred) so the reserved-slot
  // / no-reflow contract covers this state too, not just the numeric one.
  const unknown1 = await geometry(page, { expectAgeSplit: false });
  await send(makeSnapshot(slotSpec({ wakes: 0, gruWakeAgeMs: null, deferredCount: 999 })));
  await expect(wakes.locator('.board-wakes__deferred')).toHaveText('999');
  const unknown999 = await geometry(page, { expectAgeSplit: false });
  comparePairwise(unknown1, unknown999);

  // A count with NO valid stamp is the honest "last wake unknown" state:
  // same contract — the count slot stays put, the phrase never fabricates a
  // numeric age.
  await send(makeSnapshot(slotSpec({ wakes: 12, gruWakeAgeMs: null, deferredCount: 0 })));
  await expect(wakes).toContainText('last wake unknown');
  await expect(wakes.locator('.board-wakes__count')).toHaveText('12');
  const unknownWakes = await geometry(page, { expectAgeSplit: false });
  await send(makeSnapshot(slotSpec({ wakes: 999, gruWakeAgeMs: null, deferredCount: 0 })));
  await expect(wakes.locator('.board-wakes__count')).toHaveText('999');
  const unknownWakes999 = await geometry(page, { expectAgeSplit: false });
  comparePairwise(unknownWakes, unknownWakes999);
});

/** Gate F visual evidence: real captures of the synthetic fixture at all
 * four approved viewports in both themes, for operator/vision inspection.
 * Artifacts land in the ignored web/e2e-artifacts/ directory. */
test('visual captures for inspection — 1440/1200/768/360 in both themes', async ({ page }) => {
  await harness(page, makeSnapshot({ ...familyA(9), pending: 2 }));
  await waitForCount(page, 'prs.open', 9);
  for (const [width, height] of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await settle(page); // a resize re-renders; never capture a blend
    await page.screenshot({ path: `e2e-artifacts/slim-strip-${width}-light.png`, fullPage: false });
  }
  await page.locator('#theme-toggle').click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  for (const [width, height] of VIEWPORTS) {
    await page.setViewportSize({ width, height });
    await settle(page); // the theme flip transitions body color/background
    await page.screenshot({ path: `e2e-artifacts/slim-strip-${width}-dark.png`, fullPage: false });
  }
});

/** The 1200x900 dark ambiguity, resolved by measurement: the essential FOR
 * YOU labels hold >=4.5:1 once transitions settle, and the dim frame is
 * reproduced as a genuine pre-settlement state (running transition, low
 * ratio) — a capture-timing artifact, not a retained contrast defect. */
test('1200x900 dark: the FOR YOU essentials hold >=4.5:1 settled; the dim frame is a transition state', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  await harness(page, makeSnapshot({ ...familyA(9), pending: 2 }));
  await waitForCount(page, 'prs.open', 9);
  await expectStripFamilies(page, familyAFamilies(9));

  const target = '.board-owner__title';
  await page.locator('#theme-toggle').click();
  await expect(page.locator('html')).toHaveClass(/dark/);

  // Transient state (no settlement): the body colour transition is running,
  // so the label measures mid-flight. Reproduce the artifact honestly.
  const runningTransitions = await page.evaluate(() =>
    document.getAnimations().filter((a) => a instanceof CSSTransition && a.playState === 'running').length);
  const transientRatio = await contrastRatio(page, target);
  expect(runningTransitions, 'a real transition was running (not a sleep)').toBeGreaterThan(0);
  console.log(`1200x900 dark transient probe: ${transientRatio.toFixed(2)} with ${runningTransitions} transition(s) running`);

  // Settled state: every animation finished, then the SAME label measures
  // the approved essential-text floor against its effective background.
  await settle(page);
  const stillRunning = await page.evaluate(() =>
    document.getAnimations().filter((a) => a instanceof CSSTransition && a.playState === 'running').length);
  expect(stillRunning, 'settlement is real: no transition still running').toBe(0);
  const settledRatio = await contrastRatio(page, target);
  // The numbers belong in the record: a passing inequality is not a datum.
  console.log(`1200x900 dark ${target}: pre-settlement ratio ${transientRatio.toFixed(2)} (${runningTransitions} transition(s) running) -> settled ratio ${settledRatio.toFixed(2)} (${stillRunning} running)`);
  expect(settledRatio, `settled ${target} contrast (dark, 1200x900)`).toBeGreaterThanOrEqual(4.5);
  // The artifact and the steady state are different states, and the dim one
  // is the unsettled one (this is the causal claim, measured not assumed).
  expect(transientRatio, 'the pre-settlement frame is the low-contrast one').toBeLessThan(settledRatio);
  await page.screenshot({ path: 'e2e-artifacts/slim-strip-1200-dark-settled.png', fullPage: false });
  await expect(page.locator('html')).toHaveClass(/dark/);
});

/**
 * Await real rendering settlement: every running CSS animation/transition on
 * the page finishes, then two frames pass, and no animation is running. A
 * fixed sleep proves nothing; this waits on the actual animation objects the
 * engine reports (the same discipline the contrast test uses).
 */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (let pass = 0; pass < 60; pass += 1) {
      // Only FINITE transitions (the same discipline the contrast test uses):
      // the page also runs infinite keyframe animations (conn-pulse,
      // caret-blink) whose `finished` never resolves.
      const running = document
        .getAnimations()
        .filter((a): a is CSSTransition => a instanceof CSSTransition && a.playState === 'running');
      if (running.length === 0) break;
      await Promise.all(running.map((a) => a.finished.catch(() => undefined)));
    }
  });
  await page.evaluate(() => new Promise<void>((resolve) => {
    let frames = 0;
    const tick = (): void => {
      frames += 1;
      if (frames >= 2) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    // rAF is faked under page.clock; a timer fallback keeps this bounded.
    setTimeout(tick, 50);
  }));
}

/** True contrast ratio of a selector's text against its effective
 * background (foreground/background computed colours, not peak luminance). */
async function contrastRatio(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const lum = (rgb: string): number => {
      const m = rgb.match(/\d+/g)!.map(Number);
      const [r, g, b] = m.slice(0, 3).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const el = document.querySelector<HTMLElement>(sel);
    if (!el) throw new Error(`missing contrast target ${sel}`);
    let bgEl: Element | null = el;
    let bg = 'rgb(250, 246, 239)';
    while (bgEl) {
      const c = getComputedStyle(bgEl).backgroundColor;
      if (c && c !== 'transparent' && !/rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)/.test(c)) { bg = c; break; }
      bgEl = bgEl.parentElement;
    }
    const l1 = lum(getComputedStyle(el).color);
    const l2 = lum(bg);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }, selector);
}

/** A1: the reserved numeric utility is scoped to the two approved slim
 * surfaces. An unrelated surface (the heist band host) must keep the app
 * default — on the unscoped global rule this probe would reserve 4ch and
 * become inline-block, so this test fails before the scoping and passes
 * after it. */
test('A1: the reserved numeric slot is scoped — an unrelated surface keeps the app default', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await harness(page, makeSnapshot(familyA(4)));
  const styles = await page.evaluate(() => {
    const read = (el: Element): { minWidth: string; display: string } => {
      const s = getComputedStyle(el);
      return { minWidth: s.minWidth, display: s.display };
    };
    const stripNum = document.querySelector('#chip-rail .strip-value__num');
    if (!stripNum) throw new Error('missing strip numeric slot');
    // The probe goes on the app frame (body, a plain block container) — an
    // unrelated surface that is neither the strip nor the owner band.
    const probe = document.createElement('span');
    probe.className = 'num';
    probe.textContent = '7';
    document.body.append(probe);
    const probeStyle = read(probe);
    probe.remove();
    return { strip: read(stripNum), probe: probeStyle };
  });
  // The approved surface DOES reserve the numeric slot.
  expect(styles.strip.display).toBe('inline-block');
  expect(parseFloat(styles.strip.minWidth)).toBeGreaterThan(0);
  // The unrelated surface keeps its natural inline display AND its
  // default min-width (Chromium resolves the unset value to 0px) — on the
  // unscoped baseline the global rule would have made it inline-block and
  // reserved ~4ch.
  expect(styles.probe.display).toBe('inline');
  expect(parseFloat(styles.probe.minWidth) || 0).toBe(0);
});
