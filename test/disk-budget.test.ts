import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
  DISK_FLOOR_OFF_KIND,
  DISK_FLOOR_SETTLE_MS,
  DISK_FOLLOW_UP_MS,
  DISK_FULL_KIND,
  DISK_RECLAIM_KIND,
  DISK_RELEASE_REMOTE_TIMEOUT_MS,
  DISK_RECONCILE_INTERVAL_MS,
  DISK_VIEW_MAX_AGE_MS,
  diskFloorFor,
  DiskFloorGate,
  diskServiceFor,
  type DiskService,
  type DiskSpace,
  GIB,
  MAX_RELEASES_PER_PASS,
  RELEASE_RETRY_MS,
} from '../src/maintenance/disk.js';
import { ExpiryService, REVIEW_KEPT_FILES } from '../src/maintenance/expiry.js';
import { ownerAttentionFor, requiresTypedDecision } from '../src/notifications/attention.js';
import { NotificationCenter } from '../src/notifications/center.js';
import type { JobWorkerTurns } from '../src/runtime/pacing.js';
import type { AgentCapabilities, AgentHandle, AgentState } from '../src/runtime/types.js';
import { PRESERVED_REF_PREFIX, WorktreeManager, type TreeProcess } from '../src/worktrees/manager.js';
import { isValidSnapshot } from '../web/src/lib/board-protocol.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * The disk view, budget and floor (#427 PR 3), over real git lanes (real
 * releases and slims) with injected disk numbers (the usage walk, `statfs`
 * and device seams), built with the factories main.ts uses:
 *
 * - under budget nothing is reclaimed and the view shows each watched disk;
 * - over budget in automatic mode GC releases the lanes of settled finished
 *   jobs, deletes their review folders, then slims idle lanes, oldest idle
 *   first, until at most 90% of the budget, recording each step (a skip
 *   once per kind of reason), at most three releases a pass, one process
 *   listing a pass, a refused release not asked again until news, a remote
 *   that hangs refusing the release without stalling the event loop, and no
 *   review folder of a job a Perkins review owns deleted;
 * - in proposed mode one FOR YOU card lists the steps and nothing is done
 *   until Accept, which runs exactly the listed steps (a slim only the
 *   entries listed); Decline holds from the usage when the owner declined; a
 *   card posted for the budget alone never hides a floor wait;
 * - below the floor (of the lanes disk or data_dir's) a new job lane waits
 *   with an honest queue note, GC frees space at once without waiting for a
 *   walk, and lanes are admitted one at a time once the floor is met; a
 *   floor larger than the disk is off, and Gru is told;
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
  readonly lanesRoot: string;
  readonly preserveRoot: string;
  readonly logs: LogCall[];
  /** Fixed sizes by path (the ledger, other data_dir folders). */
  readonly fixed: Map<string, number>;
  /** Shared (hard-linked from outside) bytes by path. */
  readonly shared: Map<string, number>;
  /** A lane's size without its node_modules, by lane path (default 1 GB);
   * its node_modules add `modules` (default 2 GB) while they exist. */
  readonly laneBase: Map<string, number>;
  readonly laneModules: Map<string, number>;
  /** Processes the disk service's one listing finds, by lane path. */
  readonly processes: Map<string, readonly TreeProcess[]>;
  /** Processes the manager's own enumeration finds at release or slim time
   * (one that appeared after the pass listed), by lane path. */
  readonly managerProcesses: Map<string, readonly TreeProcess[]>;
  /** What one preserve copy walks to. */
  preserveCopyBytes: number;
  /** The free space statfs reports on a 500 GB disk... */
  free: () => number;
  /** ...unless this answers by folder. */
  space: ((path: string) => DiskSpace) | null;
  /** Which disk a folder is on (null: the real device). */
  device: ((path: string) => string) | null;
  statfsError: Error | null;
  /** A walk of one of these paths waits until `openSlow()`. */
  readonly slowPaths: Set<string>;
  openSlow: () => void;
  slowGate: Promise<void>;
  /** A release waits for this, when set. */
  releaseGate: Promise<void> | null;
  /** The disk service's clock. */
  clock: number;
  walks: number;
  statfsCalls: number;
  listings: number;
  releases: number;
  reviewListings: number;
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
  const lanesRoot = tempDir('gru-disk-lanes-');
  const logs: LogCall[] = [];
  const managerProcesses = new Map<string, readonly TreeProcess[]>();
  const manager = new WorktreeManager({
    ledger,
    root: lanesRoot,
    preserveRoot,
    setupTimeoutMs: 30_000,
    killGraceMs: 25,
    enumerateProcesses: (path) => managerProcesses.get(path) ?? [],
    log: (level, msg, fields) => { logs.push({ level, msg, ...(fields !== undefined ? { fields } : {}) }); },
  });
  let openSlow = (): void => {};
  const slowGate = new Promise<void>((resolveSlow) => { openSlow = resolveSlow; });
  const h: Harness = {
    repo, ledger, bus, notifications, manager, dataDir, lanesRoot, preserveRoot, logs,
    fixed: new Map(), shared: new Map(), laneBase: new Map(), laneModules: new Map(), processes: new Map(), managerProcesses,
    preserveCopyBytes: 0,
    free: () => 100 * GIB,
    space: null,
    device: null,
    statfsError: null,
    slowPaths: new Set(),
    openSlow,
    slowGate,
    releaseGate: null,
    clock: Date.now() + 2 * HOUR,
    walks: 0,
    statfsCalls: 0,
    listings: 0,
    releases: 0,
    reviewListings: 0,
  };
  cleanups.push(() => { h.openSlow(); });
  const release = manager.release.bind(manager);
  manager.release = async (input) => {
    h.releases += 1;
    if (h.releaseGate !== null) await h.releaseGate;
    return release(input);
  };
  return h;
}

/** The usage seam: the harness's sizes, read from what is on disk now. */
function usageOf(h: Harness): (path: string) => Promise<{ bytes: number; sharedBytes: number }> {
  const lanePaths = (): readonly string[] => h.ledger.listWorktrees().map((lane) => lane.path);
  const bytesOf = (path: string): number => {
    const fixed = h.fixed.get(path);
    if (fixed !== undefined) return fixed;
    if (lanePaths().includes(path)) {
      if (!existsSync(path)) return 0;
      return (h.laneBase.get(path) ?? GIB) + (existsSync(join(path, 'node_modules')) ? h.laneModules.get(path) ?? 2 * GIB : 0);
    }
    if (basename(path) === 'node_modules') return existsSync(path) ? 2 * GIB : 0;
    const reviews = join(h.dataDir, 'reviews');
    // A round's kept files (its consolidated.json) weigh nothing here, so a
    // round folder expiry has emptied weighs nothing either.
    const kept = (name: string): boolean => REVIEW_KEPT_FILES.includes(name);
    if (path === reviews) return existsSync(reviews) ? readdirSync(reviews).filter((name) => name !== 'fallback-gate' && bytesOf(join(reviews, name)) > 0).length * (GIB / 2) : 0;
    if (path.startsWith(`${reviews}/`)) {
      if (!existsSync(path) || kept(basename(path))) return 0;
      return dirname(path) === reviews && basename(path) !== 'fallback-gate' && readdirSync(path).every(kept) ? 0 : GIB / 2;
    }
    if (path === h.preserveRoot) return readdirSync(h.preserveRoot).length * h.preserveCopyBytes;
    if (path.startsWith(`${h.preserveRoot}/`)) return h.preserveCopyBytes;
    return 0;
  };
  return async (path) => {
    h.walks += 1;
    if (h.slowPaths.has(path)) await h.slowGate;
    return { bytes: bytesOf(path), sharedBytes: h.shared.get(path) ?? 0 };
  };
}

interface Timer {
  readonly run: () => void;
  readonly ms: number;
  cleared: boolean;
}

/** setTimeout/clearTimeout seams that capture the timers. */
function captured(list: Timer[]): { readonly setTimeout: typeof setTimeout; readonly clearTimeout: typeof clearTimeout } {
  return {
    setTimeout: ((callback: () => void, ms: number) => {
      const timer: Timer = { run: callback, ms, cleared: false };
      list.push(timer);
      return Object.assign(timer, { unref: () => {} }) as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout,
    clearTimeout: ((timer: unknown) => {
      if (timer !== undefined && timer !== null) (timer as Timer).cleared = true;
    }) as unknown as typeof clearTimeout,
  };
}

/** The newest live timer of that length. */
function pending(list: readonly Timer[], ms: number): Timer {
  const timer = [...list].reverse().find((entry) => entry.ms === ms && !entry.cleared);
  expect(timer, `a pending ${String(ms)} ms timer`).toBeDefined();
  return timer!;
}

interface ServiceOptions {
  readonly budgetGb: number;
  readonly floorGb: number;
  readonly mode?: 'automatic' | 'proposed';
  readonly workerTurns?: (jobId: string) => JobWorkerTurns;
  readonly verificationBusy?: (jobId: string) => boolean;
  /** The floor's poll and settle timers are captured, not real. */
  readonly fakeFloorTimers?: boolean;
  /** Whether a Perkins review owns the job (main.ts: the review wave's). */
  readonly reviewActive?: (jobId: string) => boolean;
}

interface Service {
  readonly disk: DiskService;
  readonly floor: DiskFloorGate;
  readonly expiry: ExpiryService;
  readonly timers: { reconcile?: () => void; readonly timeouts: Timer[]; readonly floorTimeouts: Timer[] };
}

/** The floor and the disk service, built by the factories main.ts uses. */
function service(h: Harness, opts: ServiceOptions): Service {
  const timers: Service['timers'] = { timeouts: [], floorTimeouts: [] };
  const log = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => { h.logs.push({ level, msg, ...(fields !== undefined ? { fields } : {}) }); };
  const config = {
    dataDir: h.dataDir,
    worktrees: { root: h.lanesRoot, preserveRoot: h.preserveRoot, diskBudgetGb: opts.budgetGb, minFreeDiskGb: opts.floorGb, reclaimMode: opts.mode ?? 'automatic' },
  } as const;
  const floor = diskFloorFor(config, {
    ledger: h.ledger,
    log,
    statfs: async (path) => {
      h.statfsCalls += 1;
      if (h.statfsError !== null) throw h.statfsError;
      return h.space?.(path) ?? { freeBytes: h.free(), totalBytes: 500 * GIB };
    },
    ...(h.device !== null ? { device: async (path: string) => h.device!(path) } : {}),
    now: () => h.clock,
    pollMs: 60_000,
    ...(opts.fakeFloorTimers === true ? captured(timers.floorTimeouts) : {}),
  });
  const expiry = new ExpiryService({ ledger: h.ledger, bus: h.bus, notifications: h.notifications, reviewsRoot: join(h.dataDir, 'reviews'), preserveRoot: h.preserveRoot, reviewActive: opts.reviewActive ?? (() => false) });
  const disk = diskServiceFor(config, {
    ledger: h.ledger,
    bus: h.bus,
    notifications: h.notifications,
    worktrees: h.manager,
    expiry: {
      expirableReviews: (listing) => {
        h.reviewListings += 1;
        return expiry.expirableReviews(listing);
      },
      expireJobReviews: (listed, expiring) => expiry.expireJobReviews(listed, expiring),
      reviewsInUse: (jobId) => expiry.reviewsInUse(jobId),
    },
    floor,
    workerTurns: opts.workerTurns ?? (() => ({ held: 0, queued: 0 })),
    verificationBusy: opts.verificationBusy ?? (() => false),
    usage: usageOf(h),
    listProcesses: async () => {
      h.listings += 1;
      return (path) => h.processes.get(path) ?? [];
    },
    now: () => h.clock,
    log,
    setInterval: ((callback: () => void, ms: number) => {
      expect(ms).toBe(DISK_RECONCILE_INTERVAL_MS);
      timers.reconcile = callback;
      return { unref: () => {} } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval,
    clearInterval: (() => {}) as unknown as typeof clearInterval,
    ...captured(timers.timeouts),
  });
  cleanups.push(() => disk.stop());
  return { disk, floor, expiry, timers };
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
async function laneOf(h: Harness, jobId: string, status: JobStatus, when = Date.now(), repo: FixtureRepo = h.repo): Promise<string> {
  h.ledger.addJob({ id: jobId, repo: basename(repo.path), title: `job ${jobId}` });
  h.ledger.setJobStatus(jobId, 'working');
  const lane = await h.manager.createJobWorktree({ repoPath: repo.path, jobId });
  expect(existsSync(join(lane.path, 'node_modules', 'pkg', 'index.js'))).toBe(true);
  if (status !== 'working') at(when, () => h.ledger.setJobStatus(jobId, status));
  return lane.path;
}

/** A review folder of a settled round of the job (the job not finished yet). */
function reviewFolder(h: Harness, jobId: string, opts: { readonly onDisk?: boolean } = {}): string {
  const round = h.ledger.addRound({ jobId }).id;
  h.ledger.setRoundStatus(round, 'aborted');
  if (opts.onDisk !== false) writeReviewFolder(h, round);
  return round;
}

function writeReviewFolder(h: Harness, round: string): void {
  mkdirSync(join(h.dataDir, 'reviews', round, 'pass-1'), { recursive: true });
  writeFileSync(join(h.dataDir, 'reviews', round, 'pass-1', 'transcript.jsonl'), '{}\n');
  writeFileSync(join(h.dataDir, 'reviews', round, 'consolidated.json'), '{}\n');
}

/** What is left of a round folder on disk. */
function reviewEntries(h: Harness, round: string): readonly string[] {
  const folder = join(h.dataDir, 'reviews', round);
  return existsSync(folder) ? readdirSync(folder).sort() : [];
}

function events(h: Harness, kind: string): readonly EventRecord[] {
  return h.ledger.listEvents({ limit: 5000 }).filter((event) => event.kind === kind).reverse();
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

/** The job's notes, in order. */
function notes(h: Harness, jobId: string): readonly string[] {
  return events(h, 'job.note').filter((event) => event.jobId === jobId).map((event) => String(payloadOf(event)['note']));
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300 && !condition(); i += 1) await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  expect(condition(), what).toBe(true);
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

function dispatcher(h: Harness, floor: DiskFloorGate, stopSignal?: AbortSignal): DispatchService {
  let n = 0;
  return new DispatchService({
    ledger: h.ledger,
    worktrees: h.manager,
    spawner: async () => fakeMinion(`minion-${String(++n)}`),
    diskFloor: floor,
    bus: h.bus,
    ...(stopSignal !== undefined ? { stopSignal } : {}),
  });
}

const FLOOR_NOTE = 'queued: 6.0 GB free is below the 10 GB floor ([worktrees] min_free_disk_gb)';
const CHECKING = `${FLOOR_NOTE}; GC is checking what it can free`;
const FREEING = `${FLOOR_NOTE}; GC is freeing space`;
const PROPOSED = `${FLOOR_NOTE}; the reclaim card is waiting for the owner's decision`;
const NOTHING = `${FLOOR_NOTE}; nothing more can be freed without losing work; Gru has been told`;

describe('disk view (#427 PR 3)', () => {
  it('under budget: 12 GB used of a 30 GB budget reclaims nothing, and the view and GET /api/disk show the numbers, each watched disk and shared bytes apart, walked at most once a minute', async () => {
    const h = harness();
    const lane = await laneOf(h, 'job-live', 'delivered');
    h.fixed.set(join(h.dataDir, 'ledger'), 8 * GIB);
    mkdirSync(join(h.dataDir, 'sessions'), { recursive: true });
    h.fixed.set(join(h.dataDir, 'sessions'), GIB);
    h.shared.set(lane, GIB / 4);
    const { disk } = service(h, { budgetGb: 30, floorGb: 10 });

    await disk.check('reconcile');

    expect(events(h, DISK_EVENTS.step)).toEqual([]);
    expect(open(h, DISK_RECLAIM_KIND)).toEqual([]);
    expect(open(h, DISK_FULL_KIND)).toEqual([]);
    const view = await disk.refreshView();
    expect(view.usage).toMatchObject({
      totalBytes: 12 * GIB,
      sharedBytes: GIB / 4,
      categories: { lanes: 3 * GIB, reviews: 0, preserves: 0, probes: 0, ledger: 8 * GIB, logs: 0, other: GIB },
      lanes: [{ id: 'job-live', kind: 'job', jobId: 'job-live', repo: REPO, path: lane, status: 'active', bytes: 3 * GIB, sharedBytes: GIB / 4, slim: false }],
    });
    // The lane root and data_dir share a disk here: one entry, holding both.
    expect(view).toMatchObject({
      dataDir: h.dataDir,
      volumes: [{ names: ['lanes', 'data_dir'], path: h.lanesRoot, freeBytes: 100 * GIB, totalBytes: 500 * GIB, notGcBytes: 388 * GIB, belowFloor: false }],
      unreadable: [],
      budgetBytes: 30 * GIB,
      floorBytes: 10 * GIB,
      floorOff: null,
      reclaimMode: 'automatic',
      overBudget: false,
      belowFloor: false,
      floorQueue: [],
    });
    expect(view.note).toContain('APFS clone');
    expect(view.note).toContain('shown apart, as shared bytes');
    expect(disk.boardView()).toEqual({
      usedBytes: 12 * GIB,
      sharedBytes: GIB / 4,
      categories: view.usage!.categories,
      freeBytes: 100 * GIB,
      totalBytes: 500 * GIB,
      volumes: [{ names: ['lanes', 'data_dir'], path: h.lanesRoot, freeBytes: 100 * GIB, totalBytes: 500 * GIB, belowFloor: false }],
      budgetBytes: 30 * GIB,
      floorBytes: 10 * GIB,
      reclaimMode: 'automatic',
      overBudget: false,
      belowFloor: false,
      queuedLanes: 0,
      floorQueue: [],
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
    const body = await answer.json() as { usage: { totalBytes: number }; budgetBytes: number; volumes: { freeBytes: number }[] };
    expect(body.usage.totalBytes).toBe(12 * GIB);
    expect(body.budgetBytes).toBe(30 * GIB);
    expect(body.volumes.map((volume) => volume.freeBytes)).toEqual([100 * GIB]);

    // The board snapshot carries the disk row, and the web validator takes it.
    const engine = new BoardEngine({ ledger: h.ledger, bus: h.bus, disk: () => disk.boardView() });
    const snapshot = JSON.parse(JSON.stringify(engine.snapshot())) as Record<string, unknown>;
    expect(snapshot['disk']).toMatchObject({ usedBytes: 12 * GIB, budgetBytes: 30 * GIB, floorBytes: 10 * GIB, queuedLanes: 0 });
    expect(isValidSnapshot(snapshot)).toBe(true);
    expect(isValidSnapshot({ ...snapshot, disk: { ...(snapshot['disk'] as object), queuedLanes: -1 } })).toBe(false);
    expect(isValidSnapshot({ ...snapshot, disk: { ...(snapshot['disk'] as object), reclaimMode: 'sometimes' } })).toBe(false);
    expect(isValidSnapshot({ ...snapshot, disk: { ...(snapshot['disk'] as object), floorQueue: [{ id: 'x' }] } })).toBe(false);
  });

  it('lanes on another disk than data_dir: the floor watches both disks, a lane waits on whichever is below, with the disk named, and the view shows each', async () => {
    const h = harness();
    let lanesFree = 6 * GIB;
    let dataFree = 100 * GIB;
    h.device = (path) => (path.startsWith(h.lanesRoot) ? 'disk-lanes' : 'disk-data');
    h.space = (path) => (path.startsWith(h.lanesRoot) ? { freeBytes: lanesFree, totalBytes: 50 * GIB } : { freeBytes: dataFree, totalBytes: 500 * GIB });
    const { disk, floor } = service(h, { budgetGb: 0, floorGb: 10 });
    expect(floor.volumes).toEqual([{ name: 'lanes', path: h.lanesRoot }, { name: 'data_dir', path: h.dataDir }]);

    let created = false;
    const dispatched = dispatcher(h, floor).dispatch({ jobId: 'job-new', repoPath: h.repo.path, title: 'a new heist', briefing: 'do the work' })
      .then((outcome) => { created = true; return outcome; });
    await until(() => floor.view().length === 1, 'the lane to wait at the floor');
    await disk.idle();

    // Nothing can be freed (no lane): Gru is told, and the note says so.
    expect(h.ledger.getJob('job-new')?.note).toBe(`${FLOOR_NOTE} on the lanes disk (${h.lanesRoot}); nothing more can be freed without losing work; Gru has been told`);
    expect(open(h, DISK_FULL_KIND)).toHaveLength(1);
    expect(open(h, DISK_FULL_KIND)[0]!.detail).toContain(`The lanes disk (${h.lanesRoot}) has 6.0 GB free, below the 10.0 GB floor`);
    const view = await disk.refreshView();
    expect(view.volumes).toMatchObject([
      { names: ['lanes'], path: h.lanesRoot, freeBytes: 6 * GIB, totalBytes: 50 * GIB, notGcBytes: 44 * GIB, belowFloor: true },
      { names: ['data_dir'], path: h.dataDir, freeBytes: 100 * GIB, totalBytes: 500 * GIB, belowFloor: false },
    ]);
    expect(disk.boardView()).toMatchObject({ freeBytes: 6 * GIB, totalBytes: 50 * GIB, belowFloor: true, queuedLanes: 1 });

    // The lanes disk recovers while data_dir's runs low: the lane still waits, on data_dir's disk.
    lanesFree = 12 * GIB;
    dataFree = 6 * GIB;
    floor.recheck();
    await floor.idle();
    expect(created).toBe(false);
    expect(h.ledger.getJob('job-new')?.note).toBe(`${FLOOR_NOTE} on the data_dir disk (${h.dataDir}); nothing more can be freed without losing work; Gru has been told`);

    dataFree = 12 * GIB;
    floor.recheck();
    const outcome = await dispatched;
    await outcome.settled;
    expect(existsSync(outcome.worktree.path)).toBe(true);
    expect(floor.view()).toEqual([]);
  });

  it('a floor at or above the disk\'s size is off: one error log, one Gru row naming it, and no lane waits; once the floor fits (a new config, a restart) the row closes itself', async () => {
    const h = harness();
    h.space = () => ({ freeBytes: 6 * GIB, totalBytes: 8 * GIB });
    const first = service(h, { budgetGb: 0, floorGb: 10 });
    first.disk.start();
    await first.disk.idle();

    const rows = open(h, DISK_FLOOR_OFF_KIND);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.routing).toBe('action-required');
    expect(producerResolvedBy(DISK_FLOOR_OFF_KIND)).not.toBeNull();
    expect(rows[0]!.detail).toContain(`[worktrees] min_free_disk_gb = 10 is at or above the total size of the lanes and data_dir disk (${h.lanesRoot}), 8.0 GB in all, so the floor could never be met.`);
    expect(rows[0]!.detail).toContain('GC treats the floor as off: no lane waits for it');
    // No lane waits, nothing is freed for it, and the log says why once.
    await expect(first.floor.admitLane({ id: 'job-x', label: 'x', jobId: null })).resolves.toMatchObject({ waitedMs: 0 });
    await first.floor.admitLane({ id: 'job-y', label: 'y', jobId: null });
    expect(first.floor.view()).toEqual([]);
    expect(h.logs.filter((line) => line.level === 'error' && line.msg.startsWith('the disk floor is at or above the size of a disk'))).toHaveLength(1);
    expect(open(h, DISK_FULL_KIND)).toEqual([]);
    expect(events(h, DISK_EVENTS.floorQueued)).toEqual([]);
    const view = await first.disk.refreshView();
    expect(view.belowFloor).toBe(false);
    expect(view.floorOff).toContain('could never be met');

    await first.disk.stop();
    const second = service(h, { budgetGb: 0, floorGb: 5 });
    second.disk.start();
    await second.disk.idle();
    expect(open(h, DISK_FLOOR_OFF_KIND)).toEqual([]);
    expect(h.ledger.getNotification(rows[0]!.id)?.resolvedBy).toBe('disk-floor-fits');
  });
});

describe('disk budget, automatic (#427 PR 3)', () => {
  it('over budget (34 GB of 30, 3 finished lanes, 5 idle lanes): releases finished lanes (less their preserve copy), then expires their reviews, then slims the oldest idle lanes until at most 90% of the budget; each step is recorded, a refusing step skipped, and no work is lost; the next reclaim starts only over the budget', async () => {
    const h = harness();
    const t0 = Date.now();
    const doneA = await laneOf(h, 'job-done-a', 'done');
    const doneB = await laneOf(h, 'job-done-b', 'working');
    const doneC = await laneOf(h, 'job-done-c', 'done');
    for (const path of [doneA, doneB, doneC]) h.laneModules.set(path, 0);
    // job-done-b holds work: a tracked edit and an untracked file, whose
    // preserve copy walks to half a GB.
    writeFileSync(join(doneB, '.gitignore'), 'node_modules/\nan-edit\n');
    writeFileSync(join(doneB, 'notes.txt'), 'minion notes\n');
    h.preserveCopyBytes = GIB / 2;
    const round = reviewFolder(h, 'job-done-b');
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
    // 34 → 26 GB: under 27 GB (90% of 30), so three idle lanes are slimmed.
    expect(steps(h)).toEqual([
      { step: 'release', lane: 'job-done-a', job_id: 'job-done-a', outcome: 'skipped', freed_bytes: 0, reason: '1 process(es) rooted in the lane (pids 4242)' },
      { step: 'release', lane: 'job-done-b', job_id: 'job-done-b', outcome: 'done', freed_bytes: GIB / 2, reason: null },
      { step: 'release', lane: 'job-done-c', job_id: 'job-done-c', outcome: 'done', freed_bytes: GIB, reason: null },
      { step: 'expire-reviews', lane: undefined, job_id: 'job-done-b', outcome: 'done', freed_bytes: GIB / 2, reason: null },
      { step: 'slim', lane: 'job-idle-d', job_id: 'job-idle-d', outcome: 'done', freed_bytes: 2 * GIB, reason: null },
      { step: 'slim', lane: 'job-idle-e', job_id: 'job-idle-e', outcome: 'done', freed_bytes: 2 * GIB, reason: null },
      { step: 'slim', lane: 'job-idle-a', job_id: 'job-idle-a', outcome: 'done', freed_bytes: 2 * GIB, reason: null },
    ]);
    expect(payloadOf(events(h, DISK_EVENTS.step)[3])['rounds']).toEqual([round]);
    expect(payloadOf(events(h, DISK_EVENTS.pass)[0])).toMatchObject({ trigger: 'start', mode: 'automatic', usage_bytes: 34 * GIB, freed_bytes: 8 * GIB, satisfied: true, steps: 7, skipped: 1, deferred: 0 });
    // One process listing for the whole pass.
    expect(h.listings).toBe(1);
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
    // The round keeps its consolidated.json, as expiry keeps it (#427 PR 2b).
    expect(reviewEntries(h, round)).toEqual(['consolidated.json']);
    expect(events(h, 'reviews.expired').map((event) => event.jobId)).toEqual(['job-done-b']);
    expect(existsSync(join(idle['job-idle-d']!, 'node_modules'))).toBe(false);
    expect(h.manager.isSlim('job-idle-d')).toBe(true);
    for (const id of ['job-idle-b', 'job-idle-c']) expect(existsSync(join(idle[id]!, 'node_modules')), id).toBe(true);
    // The cached walk was dropped: fresh numbers agree with what was freed.
    expect((await disk.refreshView()).usage?.totalBytes).toBe(26 * GIB);
    expect(open(h, DISK_FULL_KIND)).toEqual([]);

    // Grown to 28.5 GB: under the budget, so no reclaim starts (hysteresis).
    h.fixed.set(join(h.dataDir, 'ledger'), 18 * GIB);
    h.clock += DISK_VIEW_MAX_AGE_MS;
    timers.reconcile!();
    await disk.idle();
    expect(steps(h)).toHaveLength(7);

    // Over again (30.5 GB): the refusing lane's watcher respawned under a new
    // pid, the same kind of reason, so it is not recorded again; the round
    // that holds only its consolidated.json is not listed again; the next
    // oldest idle lanes are slimmed down to 26.5 GB.
    h.processes.set(doneA, [{ pid: 4243, command: 'node server.js', evidence: 'cwd' }]);
    h.fixed.set(join(h.dataDir, 'ledger'), 20 * GIB);
    h.clock += DISK_VIEW_MAX_AGE_MS;
    timers.reconcile!();
    await disk.idle();
    expect(steps(h).slice(7)).toEqual([
      { step: 'slim', lane: 'job-idle-b', job_id: 'job-idle-b', outcome: 'done', freed_bytes: 2 * GIB, reason: null },
      { step: 'slim', lane: 'job-idle-c', job_id: 'job-idle-c', outcome: 'done', freed_bytes: 2 * GIB, reason: null },
    ]);
    expect(existsSync(doneA)).toBe(true);
  });

  it('checks again after each lane is created, once the cached walk can see the new lane', async () => {
    const h = harness();
    const old = await laneOf(h, 'job-old', 'done');
    h.laneBase.set(old, 4 * GIB);
    h.fixed.set(join(h.dataDir, 'ledger'), 20 * GIB);
    const { disk, timers } = service(h, { budgetGb: 30, floorGb: 0 });
    disk.start();
    await disk.idle();
    expect(events(h, DISK_EVENTS.step)).toEqual([]);

    // The new lane pushes GC over its budget; the cached walk cannot see it yet.
    h.fixed.set(join(h.dataDir, 'ledger'), 22 * GIB);
    h.clock += 10_000;
    await laneOf(h, 'job-new', 'working');
    await disk.idle();
    expect(events(h, DISK_EVENTS.step)).toEqual([]);
    const soon = pending(timers.timeouts, DISK_VIEW_MAX_AGE_MS - 10_000);

    h.clock += DISK_VIEW_MAX_AGE_MS;
    soon.run();
    await disk.idle();

    expect(events(h, DISK_EVENTS.step).map(payloadOf)).toMatchObject([{ step: 'release', lane: 'job-old', outcome: 'done', trigger: 'lane-created' }]);
    expect(existsSync(old)).toBe(false);
    expect(h.ledger.getWorktree('job-new')?.status).toBe('active');
    expect(open(h, DISK_FULL_KIND)).toEqual([]);
  });

  it('releases only a settled finished lane: one whose job ended under 10 minutes ago, has a review round in flight, an unsettled verification, an unfinished child (on its job lane and the child\'s own), a paused release or an owner\'s hold is skipped with its reason; review folders of a job with a round in flight stay', async () => {
    const h = harness();
    await laneOf(h, 'job-ok', 'done');
    await laneOf(h, 'job-recent', 'done', h.clock - 5 * 60_000);
    await laneOf(h, 'job-round', 'working');
    const live = h.ledger.addRound({ jobId: 'job-round' }).id;
    writeReviewFolder(h, live);
    h.ledger.setJobStatus('job-round', 'done');
    await laneOf(h, 'job-verify', 'done');
    h.ledger.appendCustomEvent({ kind: 'verification.requested', jobId: 'job-verify', payload: { run_id: 'run-1' } });
    const parentPath = await laneOf(h, 'job-child', 'working');
    h.ledger.registerAgent({ id: 'agent-job-child', role: 'minion', jobId: 'job-child' });
    h.ledger.admitChildWorker({ id: 'child-1', parentAgentId: 'agent-job-child', jobId: 'job-child', purpose: 'help', authority: 'writer', task: 'write', idempotencyKey: 'key-1' });
    await h.manager.createChildWorktree({ repoPath: h.repo.path, jobId: 'job-child', childId: 'child-1', parentPath, authority: 'writer' });
    h.ledger.setJobStatus('job-child', 'done');
    await laneOf(h, 'job-paused', 'done');
    h.ledger.setWorktreeStatus('job-paused', 'paused', 'sweep paused: a live process');
    await laneOf(h, 'job-held', 'done');
    h.ledger.recordDecision({ subject: 'job:job-held', decision: 'hold', covers: ['sweep-ack'], by: 'owner', reason: 'keep the lane' });
    h.fixed.set(join(h.dataDir, 'ledger'), 60 * GIB);
    const { disk } = service(h, { budgetGb: 30, floorGb: 0 });

    await disk.check('reconcile');

    const releases = Object.fromEntries(steps(h).filter((step) => step.step === 'release').map((step) => [step.lane, [step.outcome, step.reason]]));
    expect(releases).toEqual({
      'job-ok': ['done', null],
      'job-recent': ['skipped', 'the job ended less than 10 minutes ago'],
      'job-round': ['skipped', 'the job has 1 review round(s) pending or live'],
      'job-verify': ['skipped', 'a verification run of the job has not settled'],
      'job-child': ['skipped', 'the job has 1 child worker(s) that have not finished'],
      'child-1': ['skipped', 'the job has 1 child worker(s) that have not finished'],
      'job-paused': ['skipped', 'its release is paused on live processes, waiting for an answer'],
      'job-held': ['skipped', expect.stringMatching(/^an active decision \(.+\) holds the job's lane release$/u)],
    });
    expect(h.ledger.getWorktree('job-ok')?.status).toBe('swept');
    for (const id of ['job-recent', 'job-round', 'job-verify', 'job-child', 'child-1', 'job-held']) expect(h.ledger.getWorktree(id)?.status, id).toBe('active');
    expect(h.ledger.getWorktree('job-paused')?.status).toBe('paused');
    // The job with a round in flight keeps its review folder: no step lists it.
    expect(existsSync(join(h.dataDir, 'reviews', live))).toBe(true);
    expect(steps(h).filter((step) => step.step === 'expire-reviews')).toEqual([]);
    // The child's lanes are not slimmed either while it has not finished.
    expect(steps(h).filter((step) => step.step === 'slim' && (step.lane === 'job-child' || step.lane === 'child-1'))).toEqual([]);
  });

  it('a process that appears in a lane after the pass listed none makes the budget\'s release refuse: no pause, no card, nothing killed, no preserve copy left; the lane is not asked again until its job has news or an hour passes', async () => {
    const h = harness();
    const path = await laneOf(h, 'job-done', 'done');
    writeFileSync(join(path, 'notes.txt'), 'minion notes\n');
    h.managerProcesses.set(path, [{ pid: 777, command: 'node watcher.js', evidence: 'cwd' }]);
    h.fixed.set(join(h.dataDir, 'ledger'), 40 * GIB);
    const { disk } = service(h, { budgetGb: 30, floorGb: 0 });

    await disk.check('reconcile');

    const [release] = steps(h).filter((step) => step.step === 'release');
    expect(release).toMatchObject({ lane: 'job-done', outcome: 'skipped' });
    expect(String(release!['reason'])).toMatch(/^the release refused: sweep refused: 1 live process\(es\) rooted in .+ \(pids 777\), and this release does not pause to ask/u);
    expect(h.ledger.getWorktree('job-done')?.status).toBe('active');
    expect(events(h, 'worktree.paused')).toEqual([]);
    expect(h.ledger.listWorktreeProcesses('job-done')).toEqual([]);
    expect(existsSync(join(h.preserveRoot, 'job-done'))).toBe(false);
    expect(existsSync(join(path, 'notes.txt'))).toBe(true);
    expect(h.releases).toBe(1);

    // Remembered: the next pass does not ask again; news of the job does.
    h.clock += DISK_VIEW_MAX_AGE_MS;
    await disk.check('reconcile');
    expect(h.releases).toBe(1);
    h.ledger.appendCustomEvent({ kind: 'worktree.rehydrated', jobId: 'job-done', payload: { id: 'job-done', ms: 1 } });
    h.clock += DISK_VIEW_MAX_AGE_MS;
    await disk.check('reconcile');
    expect(h.releases).toBe(2);
  });

  it('a remote that does not answer never stalls GC: the budget\'s release asks origin off the event loop and refuses once the bound passes, while timers keep firing; the lane is untouched', async () => {
    const h = harness();
    const path = await laneOf(h, 'job-done', 'done');
    // origin accepts the connection and never answers (a blackholed network).
    const sockets = new Set<Socket>();
    const remote = createNetServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
    });
    await new Promise<void>((resolveListen) => remote.listen(0, '127.0.0.1', resolveListen));
    cleanups.push(() => new Promise<void>((resolveClose) => {
      for (const socket of sockets) socket.destroy();
      remote.close(() => resolveClose());
    }));
    git(h.repo.path, ['remote', 'add', 'origin', `git://127.0.0.1:${String((remote.address() as AddressInfo).port)}/${REPO}.git`]);
    h.fixed.set(join(h.dataDir, 'ledger'), 40 * GIB);
    const { disk } = service(h, { budgetGb: 30, floorGb: 0 });
    let last = Date.now();
    let longest = 0;
    const ticker = setInterval(() => {
      const now = Date.now();
      longest = Math.max(longest, now - last);
      last = now;
    }, 20);
    cleanups.push(() => clearInterval(ticker));

    const started = Date.now();
    await disk.check('reconcile');
    const took = Date.now() - started;
    clearInterval(ticker);

    const [release] = steps(h).filter((step) => step.step === 'release');
    expect(release).toMatchObject({ lane: 'job-done', outcome: 'skipped' });
    expect(String(release!['reason'])).toMatch(new RegExp(`^the release refused: sweep refused: origin did not answer git ls-remote --symref origin HEAD within ${String(DISK_RELEASE_REMOTE_TIMEOUT_MS)} ms, so fresh required containment cannot be proven for `, 'u'));
    expect(sockets.size).toBeGreaterThan(0);
    expect(took).toBeGreaterThanOrEqual(DISK_RELEASE_REMOTE_TIMEOUT_MS - 50);
    // The event loop stayed free while origin hung: a 20 ms timer never
    // waited anywhere near the bound.
    expect(longest).toBeLessThan(DISK_RELEASE_REMOTE_TIMEOUT_MS / 2);
    expect(existsSync(join(path, 'node_modules'))).toBe(true);
    expect(h.ledger.getWorktree('job-done')?.status).toBe('active');
    expect(existsSync(join(h.preserveRoot, 'job-done'))).toBe(false);
  });

  it('never expires the review folders of a job a Perkins review owns: a fallback gate running for a merged job keeps its folder, unlisted by the budget and skipped by an accepted card, until the review ends', async () => {
    const h = harness();
    h.ledger.addJob({ id: 'job-merged', repo: REPO, title: 'job job-merged' });
    h.ledger.setJobStatus('job-merged', 'working');
    h.ledger.setJobStatus('job-merged', 'in-review');
    h.ledger.setJobStatus('job-merged', 'merged');
    const gate = join(h.dataDir, 'reviews', 'fallback-gate', 'job-merged-1700000000000-abc123');
    mkdirSync(gate, { recursive: true });
    writeFileSync(join(gate, 'review-1.json'), '{}\n');
    h.fixed.set(join(h.dataDir, 'ledger'), 40 * GIB);
    let gateRunning = true;
    const reviewActive = (jobId: string): boolean => gateRunning && jobId === 'job-merged';

    const automatic = service(h, { budgetGb: 30, floorGb: 0, reviewActive });
    await automatic.disk.check('reconcile');
    expect(steps(h).filter((step) => step.step === 'expire-reviews')).toEqual([]);
    expect(existsSync(join(gate, 'review-1.json'))).toBe(true);
    await automatic.disk.stop();

    // The card lists the folder while no review runs; the gate starts before the Accept.
    gateRunning = false;
    const proposed = service(h, { budgetGb: 30, floorGb: 0, mode: 'proposed', reviewActive });
    proposed.disk.start();
    await proposed.disk.idle();
    const [card] = open(h, DISK_RECLAIM_KIND);
    expect(card?.detail).toContain('1. Delete the 1 review folder of job job-merged (merged): job-merged-1700000000000-abc123: about 512.0 MB.');
    gateRunning = true;
    h.notifications.decide(card!.id, 'accept', 'owner');
    await proposed.disk.idle();
    expect(steps(h)).toEqual([{
      step: 'expire-reviews', lane: undefined, job_id: 'job-merged', outcome: 'skipped', freed_bytes: 0,
      reason: 'a Perkins review owns the job (a fallback gate running, a setup in progress, or a superseded round not proven stopped)',
    }]);
    expect(existsSync(join(gate, 'review-1.json'))).toBe(true);
    expect(events(h, 'reviews.expired')).toEqual([]);

    // Once the review ends, expiry deletes the folder.
    gateRunning = false;
    expect((await proposed.expiry.expireReviews({ olderThanMs: 0 })).map((done) => [done.jobId, done.fallbackGates])).toEqual([['job-merged', [basename(gate)]]]);
    expect(existsSync(gate)).toBe(false);
  });

  it('runs at most three releases a pass (each makes synchronous git calls) and lists processes once a pass; the rest follow soon, a refusing lane is not asked again until an hour passes, and only then is nothing left to free', async () => {
    const h = harness();
    for (const id of ['job-a', 'job-b', 'job-c', 'job-d', 'job-r']) h.laneModules.set(await laneOf(h, id, 'done'), 0);
    h.managerProcesses.set(h.ledger.getWorktree('job-r')!.path, [{ pid: 9, command: 'node watch.js', evidence: 'cwd' }]);
    h.fixed.set(join(h.dataDir, 'ledger'), 40 * GIB);
    const { disk, timers } = service(h, { budgetGb: 30, floorGb: 0 });

    disk.start();
    await disk.idle();
    expect(MAX_RELEASES_PER_PASS).toBe(3);
    expect(h.releases).toBe(3);
    expect(h.listings).toBe(1);
    expect(payloadOf(events(h, DISK_EVENTS.pass)[0])).toMatchObject({ steps: 3, deferred: 2, satisfied: false });
    // Something can still be freed: no row yet, and the next pass comes soon.
    expect(open(h, DISK_FULL_KIND)).toEqual([]);

    h.clock += DISK_VIEW_MAX_AGE_MS;
    pending(timers.timeouts, DISK_FOLLOW_UP_MS).run();
    await disk.idle();
    expect(h.releases).toBe(5);
    expect(h.listings).toBe(2);
    expect(steps(h).filter((step) => step.lane === 'job-r').map((step) => step.outcome)).toEqual(['skipped']);
    expect(open(h, DISK_FULL_KIND)).toHaveLength(1);

    h.clock += DISK_VIEW_MAX_AGE_MS;
    timers.reconcile!();
    await disk.idle();
    expect(h.releases).toBe(5);

    h.clock += RELEASE_RETRY_MS;
    timers.reconcile!();
    await disk.idle();
    expect(h.releases).toBe(6);
    // The same refusal is recorded once.
    expect(steps(h).filter((step) => step.lane === 'job-r' && step.step === 'release')).toHaveLength(1);
  });

  it('slims idle lanes down to 90% of the budget and starts again only over it; a lane restored in the last 30 minutes is never slimmed again (no re-slim loop across three passes)', async () => {
    const h = harness();
    const t0 = Date.now();
    const lanes: Record<string, string> = {};
    for (const [id, hoursAgo] of [['job-a', 6], ['job-b', 5], ['job-c', 4]] as const) lanes[id] = await laneOf(h, id, 'delivered', t0 - hoursAgo * HOUR);
    h.fixed.set(join(h.dataDir, 'ledger'), 22 * GIB);
    const { disk, timers } = service(h, { budgetGb: 30, floorGb: 0 });

    // Pass 1: 31 GB → 27 GB: two lanes slimmed, the third kept.
    disk.start();
    await disk.idle();
    expect(steps(h).map((step) => step.lane)).toEqual(['job-a', 'job-b']);
    expect(existsSync(join(lanes['job-c']!, 'node_modules'))).toBe(true);

    // Pass 2: 29 GB, under the budget: nothing starts.
    h.fixed.set(join(h.dataDir, 'ledger'), 24 * GIB);
    h.clock += DISK_VIEW_MAX_AGE_MS;
    timers.reconcile!();
    await disk.idle();
    expect(steps(h)).toHaveLength(2);

    // job-b's next turn restores its lane, 5 minutes before the disk clock.
    vi.useFakeTimers({ toFake: ['Date'], now: h.clock - 5 * 60_000 });
    try {
      await h.manager.ensureReady('job-b');
    } finally {
      vi.useRealTimers();
    }
    expect(existsSync(join(lanes['job-b']!, 'node_modules'))).toBe(true);

    // Pass 3: 32 GB: job-c is slimmed; job-b, restored 5 minutes ago, is not.
    h.fixed.set(join(h.dataDir, 'ledger'), 25 * GIB);
    h.clock += DISK_VIEW_MAX_AGE_MS;
    timers.reconcile!();
    await disk.idle();
    expect(steps(h).map((step) => step.lane)).toEqual(['job-a', 'job-b', 'job-c']);
    expect(existsSync(join(lanes['job-b']!, 'node_modules'))).toBe(true);
    expect(h.manager.isSlim('job-b')).toBe(false);
  });

  it('never slims a lane whose job has a minion turn held, a verification busy, a live directive, an unfinished child, or activity under 30 minutes old', async () => {
    const h = harness();
    const t0 = Date.now();
    const lanes: Record<string, string> = {};
    for (const id of ['job-turn', 'job-verify', 'job-directive', 'job-child']) lanes[id] = await laneOf(h, id, 'delivered', t0 - 2 * HOUR);
    lanes['job-recent'] = await laneOf(h, 'job-recent', 'delivered', h.clock - 10 * 60_000);
    h.ledger.beginDirectiveIntent({ jobId: 'job-directive', directive: 'fix the report', holder: 'gru' });
    h.ledger.registerAgent({ id: 'agent-job-child', role: 'minion', jobId: 'job-child' });
    h.ledger.admitChildWorker({ id: 'child-2', parentAgentId: 'agent-job-child', jobId: 'job-child', purpose: 'help', authority: 'read-only', task: 'read', idempotencyKey: 'key-2' });
    h.fixed.set(join(h.dataDir, 'ledger'), 40 * GIB);
    const { disk } = service(h, {
      budgetGb: 30,
      floorGb: 0,
      workerTurns: (jobId) => (jobId === 'job-turn' ? { held: 1, queued: 0 } : { held: 0, queued: 0 }),
      verificationBusy: (jobId) => jobId === 'job-verify',
    });

    await disk.check('reconcile');

    expect(steps(h)).toEqual([]);
    for (const [id, path] of Object.entries(lanes)) expect(existsSync(join(path, 'node_modules', 'pkg', 'index.js')), id).toBe(true);
    expect(open(h, DISK_FULL_KIND)).toHaveLength(1);
  });

  it('after a reclaim the numbers are walked afresh: Gru\'s row has categories that add up to its total and never names a lane the pass released', async () => {
    const h = harness();
    await laneOf(h, 'job-old', 'done');
    await laneOf(h, 'job-busy', 'working');
    h.fixed.set(join(h.dataDir, 'ledger'), 35 * GIB);
    const { disk } = service(h, { budgetGb: 30, floorGb: 0 });

    await disk.check('reconcile');

    expect(steps(h).map((step) => [step.step, step.lane, step.outcome])).toEqual([['release', 'job-old', 'done']]);
    const [row] = open(h, DISK_FULL_KIND);
    expect(row?.detail).toContain(`GC uses 38.0 GB under ${h.dataDir}, over its 30.0 GB budget`);
    expect(row?.detail).toContain('GC\'s usage by category: lanes 3.0 GB, review artifacts 0 B, preserve copies 0 B, onboarding probes 0 B, the ledger database 35.0 GB, logs 0 B, other files under data_dir 0 B.');
    expect(row?.detail).toContain('Largest live lanes: job-busy (job, job job-busy, disk-app) 3.0 GB.');
    expect(row?.detail).not.toContain('job-old');
  });

  it('records a skip once per kind of reason: a watcher respawning under new pids is not news, an owner\'s hold is', async () => {
    const h = harness();
    const path = await laneOf(h, 'job-w', 'done');
    h.fixed.set(join(h.dataDir, 'ledger'), 40 * GIB);
    const { disk } = service(h, { budgetGb: 30, floorGb: 0 });
    const releaseSkips = (): readonly unknown[] => steps(h).filter((step) => step.step === 'release').map((step) => step.reason);

    for (const pid of [4242, 4243, 4244]) {
      h.processes.set(path, [{ pid, command: 'node watcher.js', evidence: 'cwd' }]);
      h.clock += DISK_VIEW_MAX_AGE_MS;
      await disk.check('reconcile');
    }
    expect(releaseSkips()).toEqual(['1 process(es) rooted in the lane (pids 4242)']);

    h.processes.delete(path);
    h.ledger.recordDecision({ subject: 'job:job-w', decision: 'hold', covers: ['sweep-ack'], by: 'owner', reason: 'keep it' });
    h.clock += DISK_VIEW_MAX_AGE_MS;
    await disk.check('reconcile');
    expect(releaseSkips()).toEqual(['1 process(es) rooted in the lane (pids 4242)', expect.stringMatching(/^an active decision/u)]);
  });

  it('its stop waits for the reclaim step in flight, and starts no other', async () => {
    const h = harness();
    await laneOf(h, 'job-a', 'done');
    await laneOf(h, 'job-b', 'done');
    h.fixed.set(join(h.dataDir, 'ledger'), 40 * GIB);
    let openRelease!: () => void;
    h.releaseGate = new Promise<void>((resolveRelease) => { openRelease = resolveRelease; });
    const { disk } = service(h, { budgetGb: 30, floorGb: 0 });
    const checked = disk.check('reconcile');
    await until(() => h.releases === 1, 'a release to be in flight');

    let stopped = false;
    const stopping = disk.stop().then(() => { stopped = true; });
    await new Promise((resolveTick) => setTimeout(resolveTick, 50));
    expect(stopped).toBe(false);
    openRelease();
    await stopping;
    await checked;

    expect(h.releases).toBe(1);
    expect(steps(h).map((step) => [step.lane, step.outcome])).toEqual([['job-a', 'done']]);
    expect(h.ledger.getWorktree('job-b')?.status).toBe('active');
  });
});

describe('disk budget, proposed (#427 PR 3)', () => {
  async function overBudget(h: Harness, ledgerGb: number): Promise<{ readonly done: string; readonly round: string; readonly later: string; readonly older: string; readonly newer: string; readonly t0: number }> {
    const t0 = Date.now();
    const done = await laneOf(h, 'job-done', 'working');
    h.laneModules.set(done, 0);
    const round = reviewFolder(h, 'job-done');
    // A second settled round whose folder is not on disk (yet).
    const later = reviewFolder(h, 'job-done', { onDisk: false });
    h.ledger.setJobStatus('job-done', 'done');
    const newer = await laneOf(h, 'job-idle-new', 'delivered', t0 - 2 * HOUR);
    const older = await laneOf(h, 'job-idle-old', 'delivered', t0 - 3 * HOUR);
    // 1 + 0.5 + 6, with the ledger.
    h.fixed.set(join(h.dataDir, 'ledger'), ledgerGb * GIB);
    return { done, round, later, older, newer, t0 };
  }

  it('posts one typed FOR YOU card listing each step and the space it frees, does nothing until Accept, and Accept runs exactly those steps: a review folder that appeared since, of that job or another, is kept', async () => {
    const h = harness();
    // A second settled round of job-done, and a finished job-other, whose
    // folders appear only after the card is posted.
    h.ledger.addJob({ id: 'job-other', repo: REPO, title: 'job job-other' });
    h.ledger.setJobStatus('job-other', 'working');
    const otherRound = reviewFolder(h, 'job-other', { onDisk: false });
    h.ledger.setJobStatus('job-other', 'done');
    const { done, round, later, older, newer } = await overBudget(h, 25);
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
    expect(card.detail).toContain(`GC uses 32.5 GB under ${h.dataDir}, over its 30.0 GB budget`);
    expect(card.detail).toContain('1. Release lane job-done (job lane of job job-done, done, in disk-app): about 1.0 GB.');
    expect(card.detail).toContain(`2. Delete the 1 review folder of job job-done (done): ${round}: about 512.0 MB. The ledger keeps the verdicts and findings, the PR the published review, and each round folder its consolidated.json.`);
    expect(card.detail).toContain('3. Slim lane job-idle-old (node_modules) (job job-idle-old, delivered,');
    expect(card.detail).toContain('4. Slim lane job-idle-new (node_modules) (job job-idle-new, delivered,');
    expect(card.detail).toContain('stops once GC is at most 90% of its budget');
    expect(card.detail).toContain('GC asks again once its usage grows by another 3.0 GB');
    const proposed = payloadOf(events(h, DISK_EVENTS.proposed)[0]);
    expect(proposed).toMatchObject({ notification_id: card.id, proposal: 1, usage_bytes: 32.5 * GIB, budget_bytes: 30 * GIB });
    expect((proposed['steps'] as { step: string; bytes: number }[]).map(({ step, bytes }) => [step, bytes])).toEqual([
      ['release', GIB], ['expire-reviews', GIB / 2], ['slim', 2 * GIB], ['slim', 2 * GIB],
    ]);
    // Nothing is done before an answer, and the next check posts no second card.
    h.clock += DISK_VIEW_MAX_AGE_MS;
    await disk.check('reconcile');
    expect(open(h, DISK_RECLAIM_KIND)).toHaveLength(1);
    expect(events(h, DISK_EVENTS.step)).toEqual([]);
    expect(existsSync(done)).toBe(true);
    expect(reviewEntries(h, round)).toEqual(['consolidated.json', 'pass-1']);

    // Folders the card never listed appear before the Accept: one of
    // job-done's own, and job-other's.
    writeReviewFolder(h, later);
    writeReviewFolder(h, otherRound);

    h.notifications.decide(card.id, 'accept', 'owner');
    await disk.idle();

    expect(steps(h).map(({ step, lane, job_id, outcome }) => [step, lane ?? job_id, outcome])).toEqual([
      ['release', 'job-done', 'done'], ['expire-reviews', 'job-done', 'done'], ['slim', 'job-idle-old', 'done'], ['slim', 'job-idle-new', 'done'],
    ]);
    expect(existsSync(done)).toBe(false);
    expect(reviewEntries(h, round)).toEqual(['consolidated.json']);
    // Only the listed folder was expired: job-done's later one is kept, and so is job-other's.
    expect(reviewEntries(h, later)).toEqual(['consolidated.json', 'pass-1']);
    expect(reviewEntries(h, otherRound)).toEqual(['consolidated.json', 'pass-1']);
    expect(events(h, 'reviews.expired').map((event) => [event.jobId, payloadOf(event)['rounds']])).toEqual([['job-done', [round]]]);
    expect(existsSync(join(older, 'node_modules'))).toBe(false);
    expect(existsSync(join(newer, 'node_modules'))).toBe(false);
    expect(h.ledger.getNotification(card.id)?.resolvedAt).not.toBeNull();
    expect(open(h, DISK_RECLAIM_KIND)).toEqual([]);
    expect(open(h, DISK_FULL_KIND)).toEqual([]);
  });

  it('a card never lists a slim that slim() refuses for good: a lane whose restore came back incomplete, or a reclaim folder a [[copy]] destination lies under', async () => {
    const h = harness();
    const t0 = Date.now();
    const other = makeFixtureRepo('disk-app-placed');
    cleanups.push(() => other.cleanup());
    other.commitFile('.gitignore', 'node_modules/\nvendor/\n');
    other.commitFile('.env.example', 'TOKEN=example\n');
    other.commitFile('.gru-command/worktree.toml', [
      'reclaim = ["node_modules", "vendor"]',
      '',
      '[[copy]]',
      'from = ".env.example"',
      'to = "vendor/.env"',
      '',
      '[[setup]]',
      'command = "mkdir -p node_modules/pkg vendor/pkg && echo 1 > node_modules/pkg/index.js && echo 1 > vendor/pkg/a.js"',
      '',
    ].join('\n'));
    await laneOf(h, 'job-placed', 'delivered', t0 - 3 * HOUR, other);
    await laneOf(h, 'job-restore', 'delivered', t0 - 4 * HOUR);
    h.ledger.appendCustomEvent({ kind: 'worktree.rehydrate-failed', jobId: 'job-restore', payload: { id: 'job-restore', error: 'setup did not recreate node_modules', missing: ['node_modules'], reason: 'setup-incomplete' } });
    await laneOf(h, 'job-plain', 'delivered', t0 - 2 * HOUR);
    h.fixed.set(join(h.dataDir, 'ledger'), 40 * GIB);
    const { disk } = service(h, { budgetGb: 30, floorGb: 0, mode: 'proposed' });

    await disk.check('reconcile');

    const [card] = open(h, DISK_RECLAIM_KIND);
    expect(card?.detail).toContain('1. Slim lane job-placed (node_modules) (job job-placed, delivered,');
    expect(card?.detail).toContain('2. Slim lane job-plain (node_modules) (job job-plain, delivered,');
    expect(card?.detail).not.toContain('vendor');
    expect(card?.detail).not.toContain('job-restore');
  });

  it('Accept slims only the reclaim entries its card listed: a .next built after the card was posted survives the Accept', async () => {
    const h = harness();
    const app = makeFixtureRepo('disk-app-next');
    cleanups.push(() => app.cleanup());
    app.commitFile('.gitignore', 'node_modules/\n.next/\n');
    app.commitFile('.gru-command/worktree.toml', ['reclaim = ["node_modules", ".next"]', '', '[[setup]]', `command = "${SETUP}"`, ''].join('\n'));
    const lane = await laneOf(h, 'job-next', 'delivered', Date.now() - 3 * HOUR, app);
    h.fixed.set(join(h.dataDir, 'ledger'), 40 * GIB);
    const { disk } = service(h, { budgetGb: 30, floorGb: 0, mode: 'proposed' });
    disk.start();
    await disk.idle();
    const [card] = open(h, DISK_RECLAIM_KIND);
    expect(card?.detail).toContain('1. Slim lane job-next (node_modules) (job job-next, delivered,');
    const listed = payloadOf(events(h, DISK_EVENTS.proposed)[0])['steps'] as { step: string; entries: unknown }[];
    expect(listed.map(({ step, entries }) => [step, entries])).toEqual([['slim', ['node_modules']]]);

    // A build makes .next after the card is posted, before the Accept.
    mkdirSync(join(lane, '.next', 'cache'), { recursive: true });
    writeFileSync(join(lane, '.next', 'cache', 'build.bin'), 'built\n');
    h.notifications.decide(card!.id, 'accept', 'owner');
    await disk.idle();

    expect(steps(h).map(({ step, lane: id, outcome }) => [step, id, outcome])).toEqual([['slim', 'job-next', 'done']]);
    expect(existsSync(join(lane, 'node_modules'))).toBe(false);
    expect(existsSync(join(lane, '.next', 'cache', 'build.bin'))).toBe(true);
    const slimmed = payloadOf(events(h, 'worktree.slimmed')[0]);
    expect((slimmed['entries'] as { path: string }[]).map((entry) => entry.path)).toEqual(['node_modules']);
    expect(slimmed['skipped']).toEqual([{ path: '.next', reason: 'the list this slim runs from (the card the owner accepted) does not name it' }]);
  });

  it('Decline changes nothing and holds from GC\'s usage when the owner declined, until it grows by 10% of the budget; a card nobody answered is withdrawn once the condition clears', async () => {
    const h = harness();
    const { done } = await overBudget(h, 26.5);
    const { disk } = service(h, { budgetGb: 30, floorGb: 0, mode: 'proposed' });
    disk.start();
    await disk.idle();
    const [first] = open(h, DISK_RECLAIM_KIND);
    expect(first?.detail).toContain('GC uses 34.0 GB');

    // GC grew to 37 GB before the owner answered.
    h.fixed.set(join(h.dataDir, 'ledger'), 29.5 * GIB);
    h.clock += DISK_VIEW_MAX_AGE_MS;
    h.notifications.decide(first!.id, 'decline', 'owner');
    await disk.idle();

    expect(payloadOf(events(h, DISK_EVENTS.declined)[0])).toMatchObject({ notification_id: first!.id, usage_bytes: 37 * GIB, by: 'owner' });
    expect(open(h, DISK_RECLAIM_KIND)).toEqual([]);
    expect(events(h, DISK_EVENTS.step)).toEqual([]);
    expect(existsSync(done)).toBe(true);
    // 39 GB: past the card's 34 + 3, but under the Decline's 37 + 3: still held.
    h.fixed.set(join(h.dataDir, 'ledger'), 31.5 * GIB);
    h.clock += DISK_VIEW_MAX_AGE_MS;
    await disk.check('reconcile');
    expect(open(h, DISK_RECLAIM_KIND)).toEqual([]);
    // 40 GB: grown by 3 GB (10% of 30) since the Decline: proposed again.
    h.fixed.set(join(h.dataDir, 'ledger'), 32.5 * GIB);
    h.clock += DISK_VIEW_MAX_AGE_MS;
    await disk.check('reconcile');
    const [second] = open(h, DISK_RECLAIM_KIND);
    expect(second?.id).toBe('disk-reclaim:2');
    expect(second?.detail).toContain('GC uses 40.0 GB');

    // Under budget before anyone answered: the card is withdrawn and the hold ends.
    h.fixed.set(join(h.dataDir, 'ledger'), GIB);
    h.clock += DISK_VIEW_MAX_AGE_MS;
    await disk.check('reconcile');
    expect(open(h, DISK_RECLAIM_KIND)).toEqual([]);
    expect(h.ledger.getNotification(second!.id)?.resolvedBy).toBe('producer-withdrawn');
    expect(events(h, DISK_EVENTS.holdEnded)).toHaveLength(1);
    expect(existsSync(done)).toBe(true);
  });

  it('an Accept that leaves GC over its budget tells Gru, and no new card comes before one check interval has passed', async () => {
    const h = harness();
    const { t0 } = await overBudget(h, 29);
    const { disk, timers } = service(h, { budgetGb: 30, floorGb: 0, mode: 'proposed' });
    disk.start();
    await disk.idle();
    const [card] = open(h, DISK_RECLAIM_KIND);

    h.notifications.decide(card!.id, 'accept', 'owner');
    await disk.idle();

    // 36.5 → 31 GB: the listed steps ran, and GC is still over its budget.
    expect(steps(h)).toHaveLength(4);
    expect(open(h, DISK_RECLAIM_KIND)).toEqual([]);
    const [row] = open(h, DISK_FULL_KIND);
    expect(row?.detail).toContain('The reclaim the owner accepted ran, and GC is still over its budget or the disk below the floor.');

    // Something new to free: still no card within the interval...
    await laneOf(h, 'job-later', 'delivered', t0 - 2 * HOUR);
    await disk.idle();
    h.clock += DISK_VIEW_MAX_AGE_MS;
    await disk.check('reconcile');
    expect(open(h, DISK_RECLAIM_KIND)).toEqual([]);

    // ...and once it has passed, a new card, and Gru's row is done.
    h.clock += DISK_RECONCILE_INTERVAL_MS;
    timers.reconcile!();
    await disk.idle();
    const [next] = open(h, DISK_RECLAIM_KIND);
    expect(next?.id).toBe('disk-reclaim:2');
    expect(next?.detail).toContain('Slim lane job-later');
    expect(h.ledger.getNotification(row!.id)?.resolvedBy).toBe('disk-reclaim-proposed');
  });

  it('a changed config closes what it leaves without a producer: a card once the mode is automatic, Gru\'s rows once the budget and floor are off', async () => {
    const h = harness();
    await overBudget(h, 26.5);
    const proposed = service(h, { budgetGb: 30, floorGb: 0, mode: 'proposed' });
    proposed.disk.start();
    await proposed.disk.idle();
    const [card] = open(h, DISK_RECLAIM_KIND);
    await proposed.disk.stop();

    // reclaim_mode = "automatic": the unanswered card is withdrawn by its producer.
    h.fixed.set(join(h.dataDir, 'ledger'), GIB);
    const automatic = service(h, { budgetGb: 30, floorGb: 0 });
    automatic.disk.start();
    await automatic.disk.idle();
    expect(h.ledger.getNotification(card!.id)?.resolvedBy).toBe('producer-withdrawn');
    await automatic.disk.stop();

    // Both off: Gru's rows close.
    const full = h.notifications.post({ kind: DISK_FULL_KIND, routing: 'action-required', severity: 'error', title: 'GC over its disk budget, and nothing it can free', detail: 'x' });
    const fit = h.notifications.post({ kind: DISK_FLOOR_OFF_KIND, routing: 'action-required', severity: 'error', title: 'The disk floor is larger than the disk, so it is off', detail: 'x' });
    const off = service(h, { budgetGb: 0, floorGb: 0 });
    off.disk.start();
    expect(h.ledger.getNotification(full.id)?.resolvedBy).toBe('disk-checks-off');
    expect(h.ledger.getNotification(fit.id)?.resolvedBy).toBe('disk-floor-off');
  });
});

describe('disk floor (#427 PR 3)', () => {
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
    const queuedNote = index((event) => event.kind === 'job.note' && event.jobId === 'job-new' && payloadOf(event)['note'] === FREEING);
    const released = index((event) => event.kind === DISK_EVENTS.step && payloadOf(event)['lane'] === 'job-older' && payloadOf(event)['outcome'] === 'done');
    const created = index((event) => event.kind === 'worktree.created' && event.jobId === 'job-new');
    const admittedNote = index((event) => event.kind === 'job.note' && event.jobId === 'job-new' && /^disk floor: admitted after \d+ ms queue wait$/u.test(String(payloadOf(event)['note'])));
    expect(notes(h, 'job-new').slice(0, 2)).toEqual([CHECKING, FREEING]);
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

  it('in proposed mode the card is posted at once and the lane waits, visibly on the board, saying the card waits for the owner; after a Decline Gru is told and the note says so, until free space is back at the floor', async () => {
    const h = harness();
    await laneOf(h, 'job-old', 'done');
    let free = 6 * GIB;
    h.free = () => free;
    const { disk, floor } = service(h, { budgetGb: 30, floorGb: 10, mode: 'proposed' });
    disk.start();
    await disk.idle();
    expect(open(h, DISK_RECLAIM_KIND)).toHaveLength(1);
    const card = open(h, DISK_RECLAIM_KIND)[0]!;
    expect(card.detail).toContain('The disk has 6.0 GB free, below the 10.0 GB floor ([worktrees] min_free_disk_gb); new job and writer-child lanes wait.');

    let created = false;
    const dispatched = dispatcher(h, floor).dispatch({ jobId: 'job-new', repoPath: h.repo.path, title: 'a new heist', briefing: 'do the work' })
      .then((outcome) => { created = true; return outcome; });
    await until(() => floor.view().length === 1, 'the lane to wait at the floor');
    await disk.idle();

    expect(created).toBe(false);
    expect(h.ledger.getWorktree('job-new')).toBeNull();
    expect(h.ledger.getJob('job-new')?.note).toBe(PROPOSED);
    expect(floor.view()).toMatchObject([{ id: 'job-new', jobId: 'job-new', label: 'a new heist', reason: PROPOSED }]);
    expect((await disk.refreshView()).floorQueue).toHaveLength(1);
    expect(disk.boardView()).toMatchObject({ belowFloor: true, queuedLanes: 1, floorQueue: [{ id: 'job-new', label: 'a new heist', reason: PROPOSED }] });
    expect(open(h, DISK_RECLAIM_KIND)).toHaveLength(1);
    expect(events(h, DISK_EVENTS.step)).toEqual([]);
    expect(open(h, DISK_FULL_KIND)).toEqual([]);

    // Declined while the lane waits: never held silently.
    h.notifications.decide(card.id, 'decline', 'owner');
    await disk.idle();
    expect(h.ledger.getJob('job-new')?.note).toBe(NOTHING);
    const [row] = open(h, DISK_FULL_KIND);
    expect(row?.title).toBe('Disk below the floor, and nothing GC can free');
    expect(row?.detail).toContain('The owner declined GC\'s reclaim card, and lanes wait at the floor meanwhile');
    expect(open(h, DISK_RECLAIM_KIND)).toEqual([]);

    free = 10 * GIB;
    floor.recheck();
    const outcome = await dispatched;
    await outcome.settled;
    expect(created).toBe(true);
    expect(existsSync(outcome.worktree.path)).toBe(true);
    expect(floor.view()).toEqual([]);
  });

  it('a card posted for the budget alone never hides a floor wait: once the disk falls below the floor while it is open, Gru is told and the lane\'s note says the card waits for the owner; the answer closes that row and what it leaves is told afresh', async () => {
    const h = harness();
    await laneOf(h, 'job-old', 'done');
    h.fixed.set(join(h.dataDir, 'ledger'), 40 * GIB);
    let free = 100 * GIB;
    h.free = () => free;
    const { disk, floor } = service(h, { budgetGb: 30, floorGb: 10, mode: 'proposed' });
    disk.start();
    await disk.idle();
    const [card] = open(h, DISK_RECLAIM_KIND);
    expect(card?.detail).not.toContain('floor ([worktrees] min_free_disk_gb)');
    expect(payloadOf(events(h, DISK_EVENTS.proposed)[0])['below_floor']).toBe(false);

    free = 6 * GIB;
    const dispatched = dispatcher(h, floor).dispatch({ jobId: 'job-new', repoPath: h.repo.path, title: 'a new heist', briefing: 'do the work' });
    await until(() => floor.view().length === 1, 'the lane to wait at the floor');
    await disk.idle();

    expect(h.ledger.getJob('job-new')?.note).toBe(PROPOSED);
    expect(floor.view()).toMatchObject([{ id: 'job-new', reason: PROPOSED }]);
    const [row] = open(h, DISK_FULL_KIND);
    expect(row?.title).toBe('Disk below the floor, and the open reclaim card does not cover it');
    expect(row?.detail).toContain('The disk has 6.0 GB free, below the 10.0 GB floor ([worktrees] min_free_disk_gb); new job and writer-child lanes wait.');
    expect(row?.detail).toContain('GC\'s open reclaim card was posted for the budget alone, before the disk fell below the floor');
    expect(open(h, DISK_RECLAIM_KIND).map((still) => still.id)).toEqual([card!.id]);
    expect(events(h, DISK_EVENTS.step)).toEqual([]);

    h.notifications.decide(card!.id, 'decline', 'owner');
    await disk.idle();
    expect(h.ledger.getNotification(row!.id)?.resolvedBy).toBe('disk-reclaim-answered');
    const [after] = open(h, DISK_FULL_KIND);
    expect(after?.detail).toContain('The owner declined GC\'s reclaim card, and lanes wait at the floor meanwhile');
    expect(h.ledger.getJob('job-new')?.note).toBe(NOTHING);

    free = 100 * GIB;
    floor.recheck();
    const outcome = await dispatched;
    await outcome.settled;
    expect(existsSync(outcome.worktree.path)).toBe(true);
  });

  it('a lane waiting at the floor ends with the service\'s stop, and creates nothing', async () => {
    const h = harness();
    h.free = () => 6 * GIB;
    const { floor } = service(h, { budgetGb: 0, floorGb: 10 });
    const stop = new AbortController();
    const dispatched = dispatcher(h, floor, stop.signal).dispatch({ jobId: 'job-stopped', repoPath: h.repo.path, title: 'a stopped heist', briefing: 'b' });
    await until(() => floor.view().length === 1, 'the lane to wait at the floor');
    stop.abort();
    await expect(dispatched).rejects.toThrow('disk floor wait aborted');
    expect(h.ledger.getWorktree('job-stopped')).toBeNull();
    expect(h.ledger.getJob('job-stopped')?.status).toBe('blocked');
    expect(floor.view()).toEqual([]);
  });

  it('the owner can bin a job while its lane waits at the floor: the bin is not refused, the wait ends, and no lane is made', async () => {
    const h = harness();
    h.free = () => 6 * GIB;
    const { disk, floor } = service(h, { budgetGb: 0, floorGb: 10 });
    const dispatched = dispatcher(h, floor).dispatch({ jobId: 'job-binned', repoPath: h.repo.path, title: 'a binned heist', briefing: 'b' });
    await until(() => floor.view().length === 1, 'the lane to wait at the floor');
    await disk.idle();

    expect(() => h.ledger.setJobStatus('job-binned', 'binned')).not.toThrow();

    await expect(dispatched).rejects.toThrow('disk floor wait aborted: job "job-binned" is binned');
    expect(h.ledger.getJob('job-binned')?.status).toBe('binned');
    expect(h.ledger.getWorktree('job-binned')).toBeNull();
    expect(floor.view()).toEqual([]);
  });

  it('the queue note says what GC does: checking, then freeing while a step runs, then nothing more can be freed (Gru told); the floor\'s own poll admits the lane once space is back, with no reclaim step', async () => {
    const h = harness();
    // The release frees nothing on this disk.
    await laneOf(h, 'job-old', 'done');
    let free = 6 * GIB;
    h.free = () => free;
    const { disk, floor, timers } = service(h, { budgetGb: 0, floorGb: 10, fakeFloorTimers: true });

    let created = false;
    const dispatched = dispatcher(h, floor).dispatch({ jobId: 'job-new', repoPath: h.repo.path, title: 'a new heist', briefing: 'do the work' })
      .then((outcome) => { created = true; return outcome; });
    await until(() => floor.view().length === 1, 'the lane to wait at the floor');
    await disk.idle();

    expect(notes(h, 'job-new')).toEqual([CHECKING, FREEING, NOTHING]);
    expect(steps(h).map((step) => [step.step, step.lane, step.outcome])).toEqual([['release', 'job-old', 'done']]);
    expect(open(h, DISK_FULL_KIND)).toHaveLength(1);
    const stepsBefore = steps(h).length;

    // The owner frees space elsewhere; the poll reads it and admits the lane.
    free = 12 * GIB;
    pending(timers.floorTimeouts, 60_000).run();
    const outcome = await dispatched;
    await outcome.settled;
    expect(created).toBe(true);
    expect(steps(h)).toHaveLength(stepsBefore);
    expect(notes(h, 'job-new')[3]).toMatch(/^disk floor: admitted after \d+ ms queue wait$/u);
  });

  it('free space back at the floor admits one waiting lane; the next only once that lane is made (or the bound passes) and the free space is read again; a free space is rounded down in the note', async () => {
    let free = 9.96 * GIB;
    const timeouts: Timer[] = [];
    const floor = new DiskFloorGate({
      floorGb: 10,
      volumes: [{ name: 'lanes', path: tmpdir() }],
      statfs: async () => ({ freeBytes: free, totalBytes: 500 * GIB }),
      device: async () => 'disk',
      now: () => 0,
      pollMs: 60_000,
      ...captured(timeouts),
    });
    const reasons: string[] = [];
    const waiting = (id: string): Promise<{ readonly waitedMs: number; done(): void }> =>
      floor.admitLane({ id, label: id, jobId: null, queued: (info) => { reasons.push(`${id}: ${info.reason}`); } });
    const a = waiting('lane-a');
    const b = waiting('lane-b');
    await floor.idle();
    expect(reasons).toEqual([
      'lane-a: queued: 9.9 GB free is below the 10 GB floor ([worktrees] min_free_disk_gb); GC is checking what it can free',
      'lane-b: queued: 9.9 GB free is below the 10 GB floor ([worktrees] min_free_disk_gb); GC is checking what it can free',
    ]);

    // One crossing: one lane.
    free = 10.5 * GIB;
    floor.recheck();
    await floor.idle();
    const admittedA = await a;
    expect(floor.view().map((entry) => entry.id)).toEqual(['lane-b']);
    floor.recheck();
    await floor.idle();
    expect(floor.view().map((entry) => entry.id)).toEqual(['lane-b']);

    // lane-a's lane took space: read again once it is made, still below.
    free = 9.5 * GIB;
    admittedA.done();
    await floor.idle();
    expect(floor.view().map((entry) => entry.id)).toEqual(['lane-b']);

    free = 11 * GIB;
    floor.recheck();
    await floor.idle();
    await b;
    expect(floor.view()).toEqual([]);

    // lane-b never says it is made: the next waits only for the bound.
    let cAdmitted = false;
    const c = waiting('lane-c').then((admitted) => { cAdmitted = true; return admitted; });
    await floor.idle();
    expect(cAdmitted).toBe(false);
    pending(timeouts, DISK_FLOOR_SETTLE_MS).run();
    await floor.idle();
    await c;
    expect(cAdmitted).toBe(true);
    floor.stop();
  });

  it('a free space that cannot be read admits the lane, with one error log per failure streak and no queue note', async () => {
    const logs: LogCall[] = [];
    const recorded: unknown[] = [];
    const floor = new DiskFloorGate({
      floorGb: 10,
      volumes: [{ name: 'lanes', path: tmpdir() }],
      statfs: async () => { throw new Error('EIO: i/o error'); },
      device: async () => 'disk',
      record: (event) => { recorded.push(event); },
      now: () => 0,
      log: (level, msg, fields) => { logs.push({ level, msg, ...(fields !== undefined ? { fields } : {}) }); },
    });
    const queued: string[] = [];
    await expect(floor.admitLane({ id: 'lane-a', label: 'a', jobId: null, queued: () => { queued.push('a'); } })).resolves.toMatchObject({ waitedMs: 0 });
    await expect(floor.admitLane({ id: 'lane-b', label: 'b', jobId: null, queued: () => { queued.push('b'); } })).resolves.toMatchObject({ waitedMs: 0 });
    expect(queued).toEqual([]);
    expect(recorded).toEqual([]);
    expect(logs.filter((line) => line.level === 'error').map((line) => line.msg)).toEqual([
      'a disk\'s free space cannot be read, so the floor cannot be judged on it; lanes are created without it',
    ]);
    floor.stop();
  });

  it('a floor wait starts the reclaim at once, without waiting for a usage walk that is under way', async () => {
    const h = harness();
    const old = await laneOf(h, 'job-old', 'done');
    let free = 50 * GIB;
    h.free = () => (existsSync(old) ? free : 11 * GIB);
    // The walk of the ledger never finishes until the end of the test.
    h.slowPaths.add(join(h.dataDir, 'ledger'));
    const { disk, floor } = service(h, { budgetGb: 30, floorGb: 10 });
    disk.start();
    await until(() => h.walks > 0, 'the start check to begin its walk');

    free = 6 * GIB;
    const outcome = await dispatcher(h, floor).dispatch({ jobId: 'job-new', repoPath: h.repo.path, title: 'a new heist', briefing: 'do the work' });
    await outcome.settled;

    expect(steps(h).map((step) => [step.step, step.lane, step.outcome])).toEqual([['release', 'job-old', 'done']]);
    expect(existsSync(outcome.worktree.path)).toBe(true);
    h.openSlow();
    await disk.idle();
  });
});

describe('nothing to free, and the budget off (#427 PR 3)', () => {
  for (const mode of ['automatic', 'proposed'] as const) {
    it(`over budget with every lane working (${mode}): one action-required row for Gru, no card, naming GC's usage by category, the largest lanes and what is not GC's; it closes itself once under budget`, async () => {
      const h = harness();
      await laneOf(h, 'job-busy-a', 'working');
      const b = await laneOf(h, 'job-busy-b', 'working');
      h.laneBase.set(b, 2 * GIB);
      h.fixed.set(join(h.dataDir, 'ledger'), 29 * GIB);
      const { disk } = service(h, { budgetGb: 30, floorGb: 0, mode });

      await disk.check('reconcile');
      await disk.check('reconcile');

      expect(open(h, DISK_RECLAIM_KIND)).toEqual([]);
      const rows = open(h, DISK_FULL_KIND);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.routing).toBe('action-required');
      expect(producerResolvedBy(DISK_FULL_KIND)).not.toBeNull();
      expect(ownerAttentionFor(DISK_FULL_KIND)).toBe('owner-forbidden');
      expect(row.detail).toContain(`GC uses 36.0 GB under ${h.dataDir}, over its 30.0 GB budget ([worktrees] disk_budget_gb).`);
      expect(row.detail).toContain('GC\'s usage by category: lanes 7.0 GB, review artifacts 0 B, preserve copies 0 B, onboarding probes 0 B, the ledger database 29.0 GB, logs 0 B, other files under data_dir 0 B.');
      expect(row.detail).toContain('Largest live lanes: job-busy-b (job, job job-busy-b, disk-app) 4.0 GB; job-busy-a (job, job job-busy-a, disk-app) 3.0 GB.');
      expect(row.detail).toContain('On the disk, things that are not GC\'s use 364.0 GB (500.0 GB in all, 100.0 GB free).');
      expect(row.detail).toContain('Nothing GC can free losslessly remains');
      expect(events(h, DISK_EVENTS.step)).toEqual([]);

      h.fixed.set(join(h.dataDir, 'ledger'), 10 * GIB);
      h.clock += DISK_VIEW_MAX_AGE_MS;
      await disk.check('reconcile');

      expect(open(h, DISK_FULL_KIND)).toEqual([]);
      expect(h.ledger.getNotification(row.id)?.resolvedBy).toBe('disk-condition-cleared');
    });
  }

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
    expect(await floor.admitLane({ id: 'job-x', label: 'x', jobId: null })).toMatchObject({ waitedMs: 0 });
    expect(h.statfsCalls).toBe(0);

    const view = await disk.refreshView();
    expect(view).toMatchObject({ budgetBytes: 0, floorBytes: 0, overBudget: false, belowFloor: false, usage: { totalBytes: 63 * GIB }, volumes: [{ freeBytes: GIB }] });
    expect(events(h, DISK_EVENTS.step)).toEqual([]);
    expect(open(h, DISK_FULL_KIND)).toEqual([]);
    expect(existsSync(old)).toBe(true);
  });

  it('config: [worktrees] disk_budget_gb, min_free_disk_gb and reclaim_mode default to 30, 10 and automatic, take 0, refuse a bad or unbounded value by name, the generated config carries them, and the largest budget still makes a valid board snapshot', () => {
    const home = tempDir('gru-disk-config-');
    const write = (toml: string): void => writeFileSync(join(home, 'config.toml'), toml);
    write('');
    expect(loadConfig({ GRU_COMMAND_HOME: home }, home).worktrees).toMatchObject({ diskBudgetGb: 30, minFreeDiskGb: 10, reclaimMode: 'automatic' });
    write('[worktrees]\ndisk_budget_gb = 0\nmin_free_disk_gb = 2.5\nreclaim_mode = "proposed"\n');
    expect(loadConfig({ GRU_COMMAND_HOME: home }, home).worktrees).toMatchObject({ diskBudgetGb: 0, minFreeDiskGb: 2.5, reclaimMode: 'proposed' });
    write('[worktrees]\ndisk_budget_gb = 1000000\nmin_free_disk_gb = 1000000\n');
    expect(loadConfig({ GRU_COMMAND_HOME: home }, home).worktrees).toMatchObject({ diskBudgetGb: 1_000_000, minFreeDiskGb: 1_000_000 });
    for (const [key, value] of [['disk_budget_gb', '-1'], ['disk_budget_gb', '1000001'], ['min_free_disk_gb', 'inf'], ['min_free_disk_gb', 'nan'], ['disk_budget_gb', '"30"']] as const) {
      write(`[worktrees]\n${key} = ${value}\n`);
      expect(() => loadConfig({ GRU_COMMAND_HOME: home }, home), `${key} = ${value}`).toThrow(new RegExp(`worktrees\\.${key} must be a finite number of GB from 0 to 1000000`, 'u'));
    }
    write('[worktrees]\nreclaim_mode = "sometimes"\n');
    expect(() => loadConfig({ GRU_COMMAND_HOME: home }, home)).toThrow(/worktrees\.reclaim_mode must be one of "automatic", "proposed", got: "sometimes"/u);
    const block = renderConfigDocBlock();
    expect(block).toContain('disk_budget_gb = 30');
    expect(block).toContain('min_free_disk_gb = 10');
    expect(block).toContain('reclaim_mode = "automatic"');
  });

  it('the largest budget and floor keep every byte count the board validator takes', async () => {
    const h = harness();
    h.space = () => ({ freeBytes: 2_000_000 * GIB, totalBytes: 4_000_000 * GIB });
    const { disk } = service(h, { budgetGb: 1_000_000, floorGb: 1_000_000 });
    await disk.refreshView();
    const engine = new BoardEngine({ ledger: h.ledger, bus: h.bus, disk: () => disk.boardView() });
    const snapshot = JSON.parse(JSON.stringify(engine.snapshot())) as Record<string, unknown>;
    expect(snapshot['disk']).toMatchObject({ budgetBytes: 1_000_000 * GIB, floorBytes: 1_000_000 * GIB });
    expect(isValidSnapshot(snapshot)).toBe(true);
  });
});
