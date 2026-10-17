import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoardEngine } from '../src/board/engine.js';
import { loadConfig } from '../src/config.js';
import { renderConfigDocBlock } from '../src/config-reference.js';
import { DispatchService } from '../src/dispatch/service.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, producerResolvedBy, type EventRecord, type NotificationRecord } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { producerWithdrawable } from '../src/ledger/notification-decision.js';
import type { JobStatus } from '../src/ledger/states.js';
import type { LogLevel } from '../src/logger.js';
import {
  createDiskServer,
  DISK_EVENTS,
  DISK_FULL_KIND,
  DISK_RECLAIM_KIND,
  DISK_RECONCILE_INTERVAL_MS,
  DISK_VIEW_MAX_AGE_MS,
  DiskFloorGate,
  DiskService,
  GIB,
  type DiskSpace,
} from '../src/maintenance/disk.js';
import { ExpiryService } from '../src/maintenance/expiry.js';
import { ownerAttentionFor, requiresTypedDecision } from '../src/notifications/attention.js';
import { NotificationCenter } from '../src/notifications/center.js';
import type { AgentCapabilities, AgentHandle, AgentState } from '../src/runtime/types.js';
import { PRESERVED_REF_PREFIX, WorktreeManager, type TreeProcess } from '../src/worktrees/manager.js';
import { isValidSnapshot } from '../web/src/lib/board-protocol.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * The disk view, budget and floor (#427 PR 3), over real git lanes (real
 * releases and slims) with injected disk numbers (the usage walk and
 * `statfs` seams), one test per row of the spec's I/O matrix:
 *
 * - under budget nothing is reclaimed and the view shows the numbers;
 * - over budget in automatic mode GC releases the lanes of terminal jobs,
 *   deletes their review folders, then slims idle lanes, oldest idle first,
 *   until under budget, recording each step and skipping one that refuses;
 * - in proposed mode one FOR YOU card lists the steps and nothing is done
 *   until Accept; Decline holds until usage grows 10% of the budget;
 * - below the floor a new job lane waits with the queue note, GC frees
 *   space at once, and the lane is created once the floor is met;
 * - with nothing to free Gru gets one row, closed when the condition clears;
 * - with the budget and the floor at 0 nothing is checked, and the view is
 *   still shown.
 */

const IDENTITY = ['-c', 'user.name=Disk Tests', '-c', 'user.email=disk@example.invalid'];
const SETUP = "mkdir -p node_modules/pkg && echo 'module.exports = 1;' > node_modules/pkg/index.js";
const MANIFEST = ['reclaim = ["node_modules"]', '', '[[setup]]', `command = "${SETUP}"`, ''].join('\n');
const HOUR = 60 * 60_000;
const REPO = 'disk-app';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  while (cleanups.length > 0) await cleanups.pop()!();
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type LogCall = { readonly level: LogLevel; readonly msg: string; readonly fields?: Record<string, unknown> };

interface Harness {
  readonly repo: FixtureRepo;
  readonly ledger: LedgerApi;
  readonly bus: EventBus;
  readonly notifications: NotificationCenter;
  readonly manager: WorktreeManager;
  readonly dataDir: string;
  readonly preserveRoot: string;
  readonly logs: LogCall[];
  /** Fixed sizes by path (the ledger, other data_dir folders). */
  readonly fixed: Map<string, number>;
  /** A lane's size without its node_modules, by lane path (default 1 GB);
   * its node_modules add `modules` (default 2 GB) while they exist. */
  readonly laneBase: Map<string, number>;
  readonly laneModules: Map<string, number>;
  /** Processes rooted in a lane, by lane path. */
  readonly processes: Map<string, readonly TreeProcess[]>;
  /** The free space statfs reports. */
  free: () => number;
  /** The disk service's clock. */
  clock: number;
  /** Walks the usage seam ran. */
  walks: number;
  statfsCalls: number;
}

function harness(): Harness {
  const repo = makeFixtureRepo(REPO);
  cleanups.push(() => repo.cleanup());
  repo.commitFile('.gitignore', 'node_modules/\n');
  repo.commitFile('.gru-command/worktree.toml', MANIFEST);
  const dataDir = tempDir('gru-disk-data-');
  const db = new LedgerDb(dataDir);
  cleanups.push(() => db.close());
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  const preserveRoot = tempDir('gru-disk-preserve-');
  const logs: LogCall[] = [];
  const manager = new WorktreeManager({
    ledger,
    root: tempDir('gru-disk-lanes-'),
    preserveRoot,
    setupTimeoutMs: 30_000,
    killGraceMs: 25,
    enumerateProcesses: () => [],
    log: (level, msg, fields) => { logs.push({ level, msg, ...(fields !== undefined ? { fields } : {}) }); },
  });
  return {
    repo, ledger, bus, notifications, manager, dataDir, preserveRoot, logs,
    fixed: new Map(), laneBase: new Map(), laneModules: new Map(), processes: new Map(),
    free: () => 100 * GIB,
    clock: Date.now() + 2 * HOUR,
    walks: 0,
    statfsCalls: 0,
  };
}

/** The usage seam: the harness's sizes, read from what is on disk now. */
function usageOf(h: Harness, lanePaths: () => readonly string[]): (path: string) => Promise<number> {
  return async (path) => {
    h.walks += 1;
    const fixed = h.fixed.get(path);
    if (fixed !== undefined) return fixed;
    if (lanePaths().includes(path)) {
      if (!existsSync(path)) return 0;
      return (h.laneBase.get(path) ?? GIB) + (existsSync(join(path, 'node_modules')) ? h.laneModules.get(path) ?? 2 * GIB : 0);
    }
    if (basename(path) === 'node_modules') return existsSync(path) ? 2 * GIB : 0;
    const reviews = join(h.dataDir, 'reviews');
    if (path === reviews) return existsSync(reviews) ? readdirSync(reviews).filter((name) => name !== 'fallback-gate').length * (GIB / 2) : 0;
    if (path.startsWith(`${reviews}/`)) return existsSync(path) ? GIB / 2 : 0;
    return 0;
  };
}

interface Service {
  readonly disk: DiskService;
  readonly floor: DiskFloorGate;
  readonly timers: { reconcile?: () => void; soon?: { readonly run: () => void; readonly ms: number } };
}

function service(h: Harness, opts: { readonly budgetGb: number; readonly floorGb: number; readonly mode?: 'automatic' | 'proposed' }): Service {
  const timers: Service['timers'] = {};
  const statfs = async (): Promise<DiskSpace> => {
    h.statfsCalls += 1;
    return { freeBytes: h.free(), totalBytes: 500 * GIB };
  };
  const floor = new DiskFloorGate({
    floorGb: opts.floorGb,
    path: h.dataDir,
    statfs,
    record: (event) => { h.ledger.appendCustomEvent({ kind: event.kind, jobId: event.jobId, payload: event.payload }); },
    pollMs: 60_000,
  });
  const expiry = new ExpiryService({ ledger: h.ledger, bus: h.bus, notifications: h.notifications, reviewsRoot: join(h.dataDir, 'reviews'), preserveRoot: h.preserveRoot });
  const lanePaths = (): readonly string[] => h.ledger.listWorktrees().map((lane) => lane.path);
  const disk = new DiskService({
    ledger: h.ledger,
    bus: h.bus,
    notifications: h.notifications,
    worktrees: h.manager,
    expiry,
    floor,
    workerTurns: () => ({ held: 0, queued: 0 }),
    verificationBusy: () => false,
    budgetGb: opts.budgetGb,
    mode: opts.mode ?? 'automatic',
    paths: {
      dataDir: h.dataDir,
      reviews: join(h.dataDir, 'reviews'),
      preserves: h.preserveRoot,
      probes: join(h.dataDir, 'onboarding-probes'),
      ledger: join(h.dataDir, 'ledger'),
      logs: join(h.dataDir, 'logs'),
    },
    usage: usageOf(h, lanePaths),
    processesIn: async (path) => h.processes.get(path) ?? [],
    now: () => h.clock,
    log: (level, msg, fields) => { h.logs.push({ level, msg, ...(fields !== undefined ? { fields } : {}) }); },
    setInterval: ((callback: () => void, ms: number) => {
      expect(ms).toBe(DISK_RECONCILE_INTERVAL_MS);
      timers.reconcile = callback;
      return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval,
    clearInterval: (() => {}) as unknown as typeof clearInterval,
    setTimeout: ((callback: () => void, ms: number) => {
      timers.soon = { run: callback, ms };
      return { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as unknown as typeof clearTimeout,
  });
  cleanups.push(() => disk.stop());
  return { disk, floor, timers };
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Run `run` with the ledger's clock (Date only) at `at`. */
function at<T>(when: number, run: () => T): T {
  vi.useFakeTimers({ toFake: ['Date'], now: when });
  try {
    return run();
  } finally {
    vi.useRealTimers();
  }
}

/** A job with a real lane (setup made its node_modules), moved to `status`
 * at `when` (its last activity). */
async function laneOf(h: Harness, jobId: string, status: JobStatus, when = Date.now()): Promise<string> {
  h.ledger.addJob({ id: jobId, repo: REPO, title: `job ${jobId}` });
  h.ledger.setJobStatus(jobId, 'working');
  const lane = await h.manager.createJobWorktree({ repoPath: h.repo.path, jobId });
  expect(existsSync(join(lane.path, 'node_modules', 'pkg', 'index.js'))).toBe(true);
  if (status !== 'working') at(when, () => h.ledger.setJobStatus(jobId, status));
  return lane.path;
}

function events(h: Harness, kind: string): readonly EventRecord[] {
  return h.ledger.listEvents({ limit: 2000 }).filter((event) => event.kind === kind).reverse();
}

function payloadOf(event: EventRecord | undefined): Record<string, unknown> {
  return (event?.payload ?? {}) as Record<string, unknown>;
}

function steps(h: Harness): readonly Record<string, unknown>[] {
  return events(h, DISK_EVENTS.step).map(payloadOf).map(({ step, lane, job_id, outcome, freed_bytes, reason }) => ({ step, lane, job_id, outcome, freed_bytes, reason }));
}

function open(h: Harness, kind: string): readonly NotificationRecord[] {
  return h.ledger.listOpenNotificationsByKinds([kind]);
}

function fakeMinion(id: string): AgentHandle {
  const capabilities: AgentCapabilities = { streaming: true, steer: 'native', resume: 'file', images: false, thinking: false, thinkingLevelControl: false, followUp: false };
  return {
    role: 'minion',
    id,
    sessionFile: null,
    capabilities,
    async prompt() {},
    async steer() {},
    async followUp() {},
    subscribe: () => () => {},
    health: () => ({ state: 'idle' as AgentState, lastActivity: new Date().toISOString(), sessionFile: null }),
    async dispose() {},
  };
}

describe('disk view (#427 PR 3)', () => {
  it('under budget: 12 GB used of a 30 GB budget reclaims nothing, and the view and GET /api/disk show the numbers, walked at most once a minute', async () => {
    const h = harness();
    const lane = await laneOf(h, 'job-live', 'delivered');
    h.fixed.set(join(h.dataDir, 'ledger'), 8 * GIB);
    mkdirSync(join(h.dataDir, 'sessions'), { recursive: true });
    h.fixed.set(join(h.dataDir, 'sessions'), GIB);
    const { disk } = service(h, { budgetGb: 30, floorGb: 10 });

    await disk.check('reconcile');

    expect(events(h, DISK_EVENTS.step)).toEqual([]);
    expect(open(h, DISK_RECLAIM_KIND)).toEqual([]);
    expect(open(h, DISK_FULL_KIND)).toEqual([]);
    const view = await disk.refreshView();
    expect(view.usage).toMatchObject({
      totalBytes: 12 * GIB,
      categories: { lanes: 3 * GIB, reviews: 0, preserves: 0, probes: 0, ledger: 8 * GIB, logs: 0, other: GIB },
      lanes: [{ id: 'job-live', kind: 'job', jobId: 'job-live', repo: REPO, path: lane, status: 'active', bytes: 3 * GIB, slim: false }],
    });
    expect(view).toMatchObject({
      dataDir: h.dataDir,
      disk: { freeBytes: 100 * GIB, totalBytes: 500 * GIB, notGcBytes: 388 * GIB },
      budgetBytes: 30 * GIB,
      floorBytes: 10 * GIB,
      reclaimMode: 'automatic',
      overBudget: false,
      belowFloor: false,
      floorQueue: [],
    });
    expect(view.note).toContain('APFS clone');
    expect(disk.boardView()).toEqual({
      usedBytes: 12 * GIB,
      categories: view.usage!.categories,
      freeBytes: 100 * GIB,
      totalBytes: 500 * GIB,
      budgetBytes: 30 * GIB,
      floorBytes: 10 * GIB,
      reclaimMode: 'automatic',
      overBudget: false,
      belowFloor: false,
      queuedLanes: 0,
      computedAt: view.usage!.computedAt,
    });

    // Cached: no second walk inside a minute; one after it.
    const walks = h.walks;
    await disk.refreshView();
    expect(h.walks).toBe(walks);
    h.clock += DISK_VIEW_MAX_AGE_MS;
    await disk.refreshView();
    expect(h.walks).toBeGreaterThan(walks);

    // GET /api/disk, authenticated like every product surface.
    const route = createDiskServer({ token: 'disk-token', service: disk });
    const server: HttpServer = createServer((req, res) => {
      if (!route.requestHook(req, res, new URL(req.url ?? '/', 'http://x').pathname)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    cleanups.push(() => new Promise<void>((resolveClose) => server.close(() => resolveClose())));
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/api/disk`;
    expect((await fetch(url)).status).toBe(401);
    const answer = await fetch(url, { headers: { authorization: 'Bearer disk-token' } });
    expect(answer.status).toBe(200);
    const body = await answer.json() as { usage: { totalBytes: number }; budgetBytes: number; disk: { freeBytes: number } };
    expect(body.usage.totalBytes).toBe(12 * GIB);
    expect(body.budgetBytes).toBe(30 * GIB);
    expect(body.disk.freeBytes).toBe(100 * GIB);

    // The board snapshot carries the disk row, and the web validator takes it.
    const engine = new BoardEngine({ ledger: h.ledger, bus: h.bus, disk: () => disk.boardView() });
    const snapshot = JSON.parse(JSON.stringify(engine.snapshot())) as Record<string, unknown>;
    expect(snapshot['disk']).toMatchObject({ usedBytes: 12 * GIB, budgetBytes: 30 * GIB, floorBytes: 10 * GIB, queuedLanes: 0 });
    expect(isValidSnapshot(snapshot)).toBe(true);
    expect(isValidSnapshot({ ...snapshot, disk: { ...(snapshot['disk'] as object), queuedLanes: -1 } })).toBe(false);
    expect(isValidSnapshot({ ...snapshot, disk: { ...(snapshot['disk'] as object), reclaimMode: 'sometimes' } })).toBe(false);
  });
});

describe('disk budget, automatic (#427 PR 3)', () => {
  it('over budget (34 GB of 30, 3 terminal lanes, 5 idle lanes): releases terminal lanes, then expires their reviews, then slims the oldest idle lane, stopping under budget; each step is recorded, a refusing step is skipped, and no work is lost', async () => {
    const h = harness();
    const t0 = Date.now();
    const doneA = await laneOf(h, 'job-done-a', 'done');
    const doneB = await laneOf(h, 'job-done-b', 'working');
    const doneC = await laneOf(h, 'job-done-c', 'done');
    for (const path of [doneA, doneB, doneC]) h.laneModules.set(path, 0);
    // job-done-b holds work: a tracked edit and an untracked file.
    writeFileSync(join(doneB, '.gitignore'), 'node_modules/\nan-edit\n');
    writeFileSync(join(doneB, 'notes.txt'), 'minion notes\n');
    const round = h.ledger.addRound({ jobId: 'job-done-b' }).id;
    mkdirSync(join(h.dataDir, 'reviews', round), { recursive: true });
    writeFileSync(join(h.dataDir, 'reviews', round, 'consolidated.json'), '{}\n');
    h.ledger.setJobStatus('job-done-b', 'done');
    // A process rooted in job-done-a: its release is refused, nothing is killed.
    h.processes.set(doneA, [{ pid: 4242, command: 'node server.js', evidence: 'cwd' }]);
    // Five idle lanes; job-idle-d's last activity is the oldest.
    const idle: Record<string, string> = {};
    for (const [id, hoursAgo] of [['job-idle-a', 4], ['job-idle-b', 3], ['job-idle-c', 2], ['job-idle-d', 6], ['job-idle-e', 5]] as const) {
      idle[id] = await laneOf(h, id, 'delivered', t0 - hoursAgo * HOUR);
    }
    // 3 + 0.5 + 15 lanes and reviews, with the ledger: 34 GB.
    h.fixed.set(join(h.dataDir, 'ledger'), 15.5 * GIB);
    const { disk, timers } = service(h, { budgetGb: 30, floorGb: 0 });

    disk.start();
    await disk.idle();

    expect(timers.reconcile).toBeDefined();
    expect(steps(h)).toEqual([
      { step: 'release', lane: 'job-done-a', job_id: 'job-done-a', outcome: 'skipped', freed_bytes: 0, reason: '1 process(es) rooted in the lane (pids 4242)' },
      { step: 'release', lane: 'job-done-b', job_id: 'job-done-b', outcome: 'done', freed_bytes: GIB, reason: null },
      { step: 'release', lane: 'job-done-c', job_id: 'job-done-c', outcome: 'done', freed_bytes: GIB, reason: null },
      { step: 'expire-reviews', lane: undefined, job_id: 'job-done-b', outcome: 'done', freed_bytes: GIB / 2, reason: null },
      { step: 'slim', lane: 'job-idle-d', job_id: 'job-idle-d', outcome: 'done', freed_bytes: 2 * GIB, reason: null },
    ]);
    expect(payloadOf(events(h, DISK_EVENTS.pass)[0])).toMatchObject({ trigger: 'start', mode: 'automatic', usage_bytes: 34 * GIB, freed_bytes: 4.5 * GIB, satisfied: true, steps: 5, skipped: 1 });
    // The refused lane is untouched; the released ones are gone, their work saved.
    expect(existsSync(doneA)).toBe(true);
    expect(h.ledger.getWorktree('job-done-a')?.status).toBe('active');
    expect(existsSync(doneB)).toBe(false);
    expect(existsSync(doneC)).toBe(false);
    expect(h.ledger.getWorktree('job-done-b')?.status).toBe('swept');
    const ref = git(h.repo.path, ['for-each-ref', '--format=%(refname)', `${PRESERVED_REF_PREFIX}/job-done-b/`]);
    expect(ref).not.toBe('');
    expect(git(h.repo.path, ['show', `${ref}:.gitignore`])).toContain('an-edit');
    const [stamp] = readdirSync(join(h.preserveRoot, 'job-done-b'));
    expect(readdirSync(join(h.preserveRoot, 'job-done-b', stamp!))).toContain('notes.txt');
    expect(existsSync(join(h.dataDir, 'reviews', round))).toBe(false);
    expect(events(h, 'reviews.expired').map((event) => event.jobId)).toEqual(['job-done-b']);
    // Only the oldest idle lane was slimmed: the budget was met.
    expect(existsSync(join(idle['job-idle-d']!, 'node_modules'))).toBe(false);
    expect(h.manager.isSlim('job-idle-d')).toBe(true);
    for (const id of ['job-idle-a', 'job-idle-b', 'job-idle-c', 'job-idle-e']) expect(existsSync(join(idle[id]!, 'node_modules')), id).toBe(true);
    expect((await disk.refreshView()).usage?.totalBytes).toBe(29.5 * GIB);
    expect(open(h, DISK_FULL_KIND)).toEqual([]);

    // Over again at the next reconcile: the lane that still refuses for the
    // same reason is not recorded again; the next oldest idle lane is slimmed.
    h.fixed.set(join(h.dataDir, 'ledger'), 18 * GIB);
    h.clock += DISK_VIEW_MAX_AGE_MS;
    timers.reconcile!();
    await disk.idle();
    expect(steps(h).slice(5)).toEqual([
      { step: 'slim', lane: 'job-idle-e', job_id: 'job-idle-e', outcome: 'done', freed_bytes: 2 * GIB, reason: null },
    ]);
    expect(existsSync(join(idle['job-idle-e']!, 'node_modules'))).toBe(false);
    expect(existsSync(doneA)).toBe(true);
  });

  it('checks again after each lane is created, once the cached walk can see the new lane', async () => {
    const h = harness();
    const old = await laneOf(h, 'job-old', 'done');
    h.fixed.set(join(h.dataDir, 'ledger'), 20 * GIB);
    const { disk, timers } = service(h, { budgetGb: 30, floorGb: 0 });
    disk.start();
    await disk.idle();
    expect(events(h, DISK_EVENTS.step)).toEqual([]);

    // The new lane pushes GC over its budget; the cached walk cannot see it yet.
    h.fixed.set(join(h.dataDir, 'ledger'), 26 * GIB);
    h.clock += 10_000;
    await laneOf(h, 'job-new', 'working');
    await disk.idle();
    expect(events(h, DISK_EVENTS.step)).toEqual([]);
    expect(timers.soon?.ms).toBe(DISK_VIEW_MAX_AGE_MS - 10_000);

    h.clock += DISK_VIEW_MAX_AGE_MS;
    timers.soon!.run();
    await disk.idle();

    expect(events(h, DISK_EVENTS.step).map(payloadOf)).toMatchObject([{ step: 'release', lane: 'job-old', outcome: 'done', trigger: 'lane-created' }]);
    expect(existsSync(old)).toBe(false);
    expect(h.ledger.getWorktree('job-new')?.status).toBe('active');
  });
});

describe('disk budget, proposed (#427 PR 3)', () => {
  async function overBudget(h: Harness): Promise<{ readonly done: string; readonly round: string; readonly older: string; readonly newer: string }> {
    const t0 = Date.now();
    const done = await laneOf(h, 'job-done', 'working');
    h.laneModules.set(done, 0);
    const round = h.ledger.addRound({ jobId: 'job-done' }).id;
    mkdirSync(join(h.dataDir, 'reviews', round), { recursive: true });
    writeFileSync(join(h.dataDir, 'reviews', round, 'consolidated.json'), '{}\n');
    h.ledger.setJobStatus('job-done', 'done');
    const newer = await laneOf(h, 'job-idle-new', 'delivered', t0 - 2 * HOUR);
    const older = await laneOf(h, 'job-idle-old', 'delivered', t0 - 3 * HOUR);
    // 1 + 0.5 + 6, with the ledger: 34 GB.
    h.fixed.set(join(h.dataDir, 'ledger'), 26.5 * GIB);
    return { done, round, older, newer };
  }

  it('posts one typed FOR YOU card listing each step and the space it frees, does nothing until Accept, and Accept runs exactly those steps', async () => {
    const h = harness();
    const { done, round, older, newer } = await overBudget(h);
    const { disk } = service(h, { budgetGb: 30, floorGb: 10, mode: 'proposed' });
    disk.start();
    await disk.idle();

    const cards = open(h, DISK_RECLAIM_KIND);
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(ownerAttentionFor(DISK_RECLAIM_KIND)).toBe('owner-required');
    expect(requiresTypedDecision(DISK_RECLAIM_KIND)).toBe(true);
    expect(producerWithdrawable(DISK_RECLAIM_KIND)).toBe(true);
    expect(card.routing).toBe('needs-owner');
    expect(card.decision?.reservedClass).toBe('authority-cost');
    expect(card.decision?.options.map((option) => option.id)).toEqual(['accept', 'decline']);
    expect(card.detail).toContain(`GC uses 34.0 GB under ${h.dataDir}, over its 30.0 GB budget`);
    expect(card.detail).toContain('1. Release lane job-done (job lane of job job-done, done, in disk-app): about 1.0 GB.');
    expect(card.detail).toContain('2. Delete the 1 review folder of job job-done (done): about 512.0 MB.');
    expect(card.detail).toContain('3. Slim lane job-idle-old (node_modules) (job job-idle-old, delivered,');
    expect(card.detail).toContain('4. Slim lane job-idle-new (node_modules) (job job-idle-new, delivered,');
    expect(card.detail).toContain('GC asks again once its usage grows by another 3.0 GB');
    const proposed = payloadOf(events(h, DISK_EVENTS.proposed)[0]);
    expect(proposed).toMatchObject({ notification_id: card.id, proposal: 1, usage_bytes: 34 * GIB, budget_bytes: 30 * GIB });
    expect((proposed['steps'] as { step: string; bytes: number }[]).map(({ step, bytes }) => [step, bytes])).toEqual([
      ['release', GIB], ['expire-reviews', GIB / 2], ['slim', 2 * GIB], ['slim', 2 * GIB],
    ]);
    // Nothing is done before an answer, and the next check posts no second card.
    h.clock += DISK_VIEW_MAX_AGE_MS;
    await disk.check('reconcile');
    expect(open(h, DISK_RECLAIM_KIND)).toHaveLength(1);
    expect(events(h, DISK_EVENTS.step)).toEqual([]);
    expect(existsSync(done)).toBe(true);
    expect(existsSync(join(h.dataDir, 'reviews', round))).toBe(true);

    h.notifications.decide(card.id, 'accept', 'owner');
    await disk.idle();

    expect(steps(h).map(({ step, lane, job_id, outcome }) => [step, lane ?? job_id, outcome])).toEqual([
      ['release', 'job-done', 'done'], ['expire-reviews', 'job-done', 'done'], ['slim', 'job-idle-old', 'done'], ['slim', 'job-idle-new', 'done'],
    ]);
    expect(existsSync(done)).toBe(false);
    expect(existsSync(join(h.dataDir, 'reviews', round))).toBe(false);
    expect(existsSync(join(older, 'node_modules'))).toBe(false);
    expect(existsSync(join(newer, 'node_modules'))).toBe(false);
    expect(h.ledger.getNotification(card.id)?.resolvedAt).not.toBeNull();
    expect(open(h, DISK_RECLAIM_KIND)).toEqual([]);
  });

  it('Decline changes nothing and holds until usage grows by 10% of the budget; a card nobody answered is withdrawn once the condition clears', async () => {
    const h = harness();
    const { done } = await overBudget(h);
    const { disk } = service(h, { budgetGb: 30, floorGb: 0, mode: 'proposed' });
    disk.start();
    await disk.idle();
    const [first] = open(h, DISK_RECLAIM_KIND);

    h.notifications.decide(first!.id, 'decline', 'owner');
    await disk.idle();

    expect(payloadOf(events(h, DISK_EVENTS.declined)[0])).toMatchObject({ notification_id: first!.id, usage_bytes: 34 * GIB, by: 'owner' });
    expect(open(h, DISK_RECLAIM_KIND)).toEqual([]);
    expect(events(h, DISK_EVENTS.step)).toEqual([]);
    expect(existsSync(done)).toBe(true);
    // Grown by less than 3 GB: still held.
    h.fixed.set(join(h.dataDir, 'ledger'), 29 * GIB);
    h.clock += DISK_VIEW_MAX_AGE_MS;
    await disk.check('reconcile');
    expect(open(h, DISK_RECLAIM_KIND)).toEqual([]);
    // Grown by 3 GB (10% of 30): proposed again.
    h.fixed.set(join(h.dataDir, 'ledger'), 29.5 * GIB);
    h.clock += DISK_VIEW_MAX_AGE_MS;
    await disk.check('reconcile');
    const [second] = open(h, DISK_RECLAIM_KIND);
    expect(second?.id).toBe('disk-reclaim:2');
    expect(second?.detail).toContain('GC uses 37.0 GB');

    // Under budget before anyone answered: the card is withdrawn and the hold ends.
    h.fixed.set(join(h.dataDir, 'ledger'), GIB);
    h.clock += DISK_VIEW_MAX_AGE_MS;
    await disk.check('reconcile');
    expect(open(h, DISK_RECLAIM_KIND)).toEqual([]);
    expect(h.ledger.getNotification(second!.id)?.resolvedBy).toBe('producer-withdrawn');
    expect(events(h, DISK_EVENTS.holdEnded)).toHaveLength(1);
    expect(existsSync(done)).toBe(true);
  });
});

describe('disk floor (#427 PR 3)', () => {
  function dispatcher(h: Harness, floor: DiskFloorGate, stopSignal?: AbortSignal): DispatchService {
    let n = 0;
    return new DispatchService({
      ledger: h.ledger,
      worktrees: h.manager,
      spawner: async () => fakeMinion(`minion-${String(++n)}`),
      diskFloor: floor,
      ...(stopSignal !== undefined ? { stopSignal } : {}),
    });
  }

  it('6 GB free under a 10 GB floor: a new job lane waits with the queue note, GC frees space at once, and the lane is created once 10 GB are free', async () => {
    const h = harness();
    const old = await laneOf(h, 'job-old', 'done');
    // Releasing job-old's lane frees 5 GB of the disk.
    h.free = () => (existsSync(old) ? 6 : 11) * GIB;
    const { disk, floor } = service(h, { budgetGb: 0, floorGb: 10 });
    disk.start();
    await disk.idle();
    // At start: under the floor, so GC already frees space; put it back to wait.
    expect(existsSync(old)).toBe(false);
    const older = await laneOf(h, 'job-older', 'done');
    await disk.idle();
    h.free = () => (existsSync(older) ? 6 : 11) * GIB;

    const outcome = await dispatcher(h, floor).dispatch({ jobId: 'job-new', repoPath: h.repo.path, title: 'a new heist', briefing: 'do the work' });
    await outcome.settled;
    await disk.idle();

    const log = h.ledger.listEvents({ limit: 2000 }).slice().reverse();
    const index = (match: (event: EventRecord) => boolean): number => log.findIndex(match);
    const queuedNote = index((event) => event.kind === 'job.note' && event.jobId === 'job-new' &&
      payloadOf(event)['note'] === 'queued: 6.0 GB free is below the 10 GB floor ([worktrees] min_free_disk_gb); GC is freeing space');
    const released = index((event) => event.kind === DISK_EVENTS.step && payloadOf(event)['lane'] === 'job-older' && payloadOf(event)['outcome'] === 'done');
    const created = index((event) => event.kind === 'worktree.created' && event.jobId === 'job-new');
    const admittedNote = index((event) => event.kind === 'job.note' && event.jobId === 'job-new' && /^disk floor: admitted after \d+ ms queue wait$/u.test(String(payloadOf(event)['note'])));
    expect(queuedNote).toBeGreaterThanOrEqual(0);
    expect(released).toBeGreaterThan(queuedNote);
    expect(admittedNote).toBeGreaterThan(released);
    expect(created).toBeGreaterThan(admittedNote);
    expect(payloadOf(events(h, DISK_EVENTS.step).find((event) => payloadOf(event)['lane'] === 'job-older'))['trigger']).toBe('floor');
    expect(events(h, DISK_EVENTS.floorQueued).map((event) => event.jobId)).toEqual(['job-new']);
    expect(events(h, DISK_EVENTS.floorAdmitted).map((event) => event.jobId)).toEqual(['job-new']);
    expect(existsSync(outcome.worktree.path)).toBe(true);
    expect(floor.view()).toEqual([]);
  });

  it('in proposed mode the card is posted at once and the lane keeps waiting, visible in the view, until free space is back at the floor', async () => {
    const h = harness();
    await laneOf(h, 'job-old', 'done');
    let free = 6 * GIB;
    h.free = () => free;
    const { disk, floor } = service(h, { budgetGb: 30, floorGb: 10, mode: 'proposed' });
    disk.start();
    await disk.idle();
    // Nothing to answer yet beyond the start card: the floor posts no second one.
    expect(open(h, DISK_RECLAIM_KIND)).toHaveLength(1);
    const card = open(h, DISK_RECLAIM_KIND)[0]!;
    expect(card.detail).toContain('The disk has 6.0 GB free, below the 10.0 GB floor ([worktrees] min_free_disk_gb); new job and writer-child lanes wait.');

    let created = false;
    const dispatched = dispatcher(h, floor).dispatch({ jobId: 'job-new', repoPath: h.repo.path, title: 'a new heist', briefing: 'do the work' })
      .then((outcome) => { created = true; return outcome; });
    for (let i = 0; i < 50 && floor.view().length === 0; i += 1) await new Promise((resolveTick) => setTimeout(resolveTick, 10));
    await disk.idle();

    expect(created).toBe(false);
    expect(h.ledger.getWorktree('job-new')).toBeNull();
    expect(h.ledger.getJob('job-new')?.note).toBe('queued: 6.0 GB free is below the 10 GB floor ([worktrees] min_free_disk_gb); GC is freeing space');
    expect(floor.view()).toMatchObject([{ id: 'job-new', jobId: 'job-new', label: 'a new heist', reason: h.ledger.getJob('job-new')?.note }]);
    expect((await disk.refreshView()).floorQueue).toHaveLength(1);
    expect(disk.boardView()).toMatchObject({ belowFloor: true, queuedLanes: 1 });
    expect(open(h, DISK_RECLAIM_KIND)).toHaveLength(1);
    expect(events(h, DISK_EVENTS.step)).toEqual([]);

    free = 10 * GIB;
    floor.recheck();
    const outcome = await dispatched;
    await outcome.settled;

    expect(created).toBe(true);
    expect(existsSync(outcome.worktree.path)).toBe(true);
    expect(floor.view()).toEqual([]);
  });

  it('a lane waiting at the floor ends with its signal, and creates nothing', async () => {
    const h = harness();
    h.free = () => 6 * GIB;
    const { floor } = service(h, { budgetGb: 0, floorGb: 10 });
    const stop = new AbortController();
    const dispatched = dispatcher(h, floor, stop.signal).dispatch({ jobId: 'job-stopped', repoPath: h.repo.path, title: 'a stopped heist', briefing: 'b' });
    for (let i = 0; i < 50 && floor.view().length === 0; i += 1) await new Promise((resolveTick) => setTimeout(resolveTick, 10));
    stop.abort();
    await expect(dispatched).rejects.toThrow('disk floor wait aborted');
    expect(h.ledger.getWorktree('job-stopped')).toBeNull();
    expect(h.ledger.getJob('job-stopped')?.status).toBe('blocked');
    expect(floor.view()).toEqual([]);
  });
});

describe('nothing to free, and the budget off (#427 PR 3)', () => {
  it('over budget with every lane working: one action-required row for Gru names GC\'s usage by category, the largest lanes and what is not GC\'s, and closes itself once under budget', async () => {
    const h = harness();
    await laneOf(h, 'job-busy-a', 'working');
    const b = await laneOf(h, 'job-busy-b', 'working');
    h.laneBase.set(b, 2 * GIB);
    h.fixed.set(join(h.dataDir, 'ledger'), 29 * GIB);
    const { disk } = service(h, { budgetGb: 30, floorGb: 0 });

    await disk.check('reconcile');
    await disk.check('reconcile');

    const rows = open(h, DISK_FULL_KIND);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.routing).toBe('action-required');
    expect(producerResolvedBy(DISK_FULL_KIND)).not.toBeNull();
    expect(ownerAttentionFor(DISK_FULL_KIND)).toBe('owner-forbidden');
    expect(row.detail).toContain(`GC uses 36.0 GB under ${h.dataDir}, over its 30.0 GB budget ([worktrees] disk_budget_gb).`);
    expect(row.detail).toContain('GC\'s usage by category: lanes 7.0 GB, review artifacts 0 B, preserve copies 0 B, onboarding probes 0 B, the ledger database 29.0 GB, logs 0 B, other files under data_dir 0 B.');
    expect(row.detail).toContain('Largest live lanes: job-busy-b (job, job job-busy-b, disk-app) 4.0 GB; job-busy-a (job, job job-busy-a, disk-app) 3.0 GB.');
    expect(row.detail).toContain('Things that are not GC\'s use 364.0 GB of the disk (500.0 GB in all, 100.0 GB free).');
    expect(events(h, DISK_EVENTS.step)).toEqual([]);

    h.fixed.set(join(h.dataDir, 'ledger'), 10 * GIB);
    h.clock += DISK_VIEW_MAX_AGE_MS;
    await disk.check('reconcile');

    expect(open(h, DISK_FULL_KIND)).toEqual([]);
    expect(h.ledger.getNotification(row.id)?.resolvedBy).toBe('disk-condition-cleared');
  });

  it('disk_budget_gb = 0 and min_free_disk_gb = 0: nothing is checked and no lane waits, and the view is still shown', async () => {
    const h = harness();
    const old = await laneOf(h, 'job-old', 'done');
    h.fixed.set(join(h.dataDir, 'ledger'), 60 * GIB);
    h.free = () => GIB;
    const { disk, floor, timers } = service(h, { budgetGb: 0, floorGb: 0 });

    disk.start();
    await disk.check('reconcile');
    expect(timers.reconcile).toBeUndefined();
    expect(h.walks).toBe(0);
    expect(await floor.admitLane({ id: 'job-x', label: 'x', jobId: null })).toEqual({ waitedMs: 0 });
    expect(h.statfsCalls).toBe(0);

    const view = await disk.refreshView();
    expect(view).toMatchObject({ budgetBytes: 0, floorBytes: 0, overBudget: false, belowFloor: false, usage: { totalBytes: 63 * GIB }, disk: { freeBytes: GIB } });
    expect(events(h, DISK_EVENTS.step)).toEqual([]);
    expect(open(h, DISK_FULL_KIND)).toEqual([]);
    expect(existsSync(old)).toBe(true);
  });

  it('config: [worktrees] disk_budget_gb, min_free_disk_gb and reclaim_mode default to 30, 10 and automatic, take 0, refuse a bad value by name, and the generated config carries them', () => {
    const home = tempDir('gru-disk-config-');
    const write = (toml: string): void => writeFileSync(join(home, 'config.toml'), toml);
    write('');
    expect(loadConfig({ GRU_COMMAND_HOME: home }, home).worktrees).toMatchObject({ diskBudgetGb: 30, minFreeDiskGb: 10, reclaimMode: 'automatic' });
    write('[worktrees]\ndisk_budget_gb = 0\nmin_free_disk_gb = 2.5\nreclaim_mode = "proposed"\n');
    expect(loadConfig({ GRU_COMMAND_HOME: home }, home).worktrees).toMatchObject({ diskBudgetGb: 0, minFreeDiskGb: 2.5, reclaimMode: 'proposed' });
    write('[worktrees]\ndisk_budget_gb = -1\n');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home }, home)).toThrow(/worktrees\.disk_budget_gb must be a non-negative finite number/u);
    write('[worktrees]\nreclaim_mode = "sometimes"\n');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home }, home)).toThrow(/worktrees\.reclaim_mode must be one of "automatic", "proposed", got: "sometimes"/u);
    const block = renderConfigDocBlock();
    expect(block).toContain('disk_budget_gb = 30');
    expect(block).toContain('min_free_disk_gb = 10');
    expect(block).toContain('reclaim_mode = "automatic"');
  });
});
