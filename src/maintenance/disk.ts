import { execFile } from 'node:child_process';
import { statfs as fsStatfs, lstat, readdir } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { hashToken, tokenConfigured, tokenMatches } from '../auth.js';
import type { ReclaimMode } from '../config.js';
import { laneIsBusy } from '../dispatch/branch-idle.js';
import type { EventBus } from '../events/bus.js';
import { NotificationDecisionRefusal, type EventRecord, type LedgerApi, type NotificationRecord, type WorktreeRecord } from '../ledger/api.js';
import { parseNotificationDecision, type NotificationDecision } from '../ledger/notification-decision.js';
import { isJobTerminal } from '../ledger/states.js';
import type { LogLevel } from '../logger.js';
import type { NotificationCenter } from '../notifications/center.js';
import { oneLineErrorText } from '../property/error-text.js';
import type { JobWorkerTurns } from '../runtime/pacing.js';
import { psEnumeratorAsync, type TreeProcess, type WorktreeManager } from '../worktrees/manager.js';
import { MANIFEST_PATH, parseWorktreeManifest } from '../worktrees/manifest.js';
import { reclaimState, treeBytes } from '../worktrees/reclaim.js';
import { LAST_ACTIVITY_KINDS, SLIM_MIN_IDLE_MS } from '../worktrees/slimming.js';
import type { ExpiryService } from './expiry.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * The disk view, budget and floor (#427 PR 3).
 *
 * - **The view** (`GET /api/disk`, and the board's disk row next to the
 *   verify queue): GC's usage under `data_dir` by category (lanes, each
 *   with slim or not; review artifacts; preserve copies; onboarding
 *   probes; the ledger database; logs; everything else under `data_dir`),
 *   the disk's free space and total (`fs.statfs`), the budget and the
 *   floor. Usage is allocated blocks, each inode counted once within a
 *   walk (the 2a walker, {@link treeBytes}); blocks an APFS clone shares
 *   cannot be seen and are counted in full ({@link CLONE_NOTE}). The walk
 *   is async (never one blocking call), runs at most once per
 *   {@link DISK_VIEW_MAX_AGE_MS} and is cached.
 * - **The budget** (`[worktrees] disk_budget_gb`) is checked at start,
 *   every {@link DISK_RECONCILE_INTERVAL_MS} and after each lane is
 *   created. Over it, in `automatic` mode, GC frees space losslessly, in
 *   order, stopping once under budget and at or above the floor: it
 *   releases the lanes of terminal jobs (the existing release, which
 *   snapshots their work; a refusal skips the lane), deletes the review
 *   folders of terminal jobs without the 14-day wait (keeping what 2b's
 *   expiry keeps), then slims idle lanes, oldest idle first (2a's `slim()`
 *   with its checks). Each step is recorded (`disk.reclaim-step`). The
 *   budget never stops or refuses a heist.
 * - **`proposed` mode** does none of that: one typed FOR YOU card
 *   ({@link DISK_RECLAIM_KIND}) lists each step and the space it frees,
 *   recorded first (`disk.reclaim-proposed`). Accept runs exactly those
 *   steps; Decline holds until GC's usage grows by a further
 *   {@link DECLINE_REGROWTH} of the budget.
 * - **The floor** (`[worktrees] min_free_disk_gb`): a job or writer-child
 *   lane waits in the {@link DiskFloorGate} FIFO while the disk's free
 *   space is below it, and GC runs the reclaim (or posts the card) at once.
 * - **Nothing left to free**: over budget or under the floor with nothing
 *   reclaimable, Gru gets one action-required row ({@link DISK_FULL_KIND})
 *   naming GC's usage by category, the largest live lanes and how much of
 *   the disk is not GC's; it closes itself once the condition clears.
 *
 * No step is lossy: no lane holding work is discarded and no process is
 * killed (a lane with a process rooted in it is skipped). No migration:
 * ledger events and notification rows only.
 */

/** GB in config and on screen: 2^30 bytes, as `df -h` counts. */
export const GIB = 1024 ** 3;
/** The usage walk runs at most once a minute; the view is cached between. */
export const DISK_VIEW_MAX_AGE_MS = 60_000;
/** The budget is checked every five minutes (and at start, and after each lane is created). */
export const DISK_RECONCILE_INTERVAL_MS = 300_000;
/** How often the floor queue reads the free space again while lanes wait. */
export const DISK_FLOOR_POLL_MS = 15_000;
/** A declined card holds until GC's usage grows by this share of the budget
 * (of the floor when the budget is off). */
export const DECLINE_REGROWTH = 0.1;
/** The owner's Accept/Decline on freeing space (`reclaim_mode = "proposed"`). */
export const DISK_RECLAIM_KIND = 'disk.reclaim-proposal';
/** Gru's row when nothing reclaimable remains (producer-resolved). */
export const DISK_FULL_KIND = 'disk.nothing-to-free';

/** The disk budget's ledger events. */
export const DISK_EVENTS = {
  step: 'disk.reclaim-step',
  pass: 'disk.reclaim-pass',
  proposed: 'disk.reclaim-proposed',
  declined: 'disk.reclaim-declined',
  holdEnded: 'disk.reclaim-hold-ended',
  floorQueued: 'disk.floor-queued',
  floorAdmitted: 'disk.floor-admitted',
} as const;

export const CLONE_NOTE = 'Usage counts the allocated blocks of each file, each inode once within a walk. ' +
  'Blocks an APFS clone (copy-on-write) shares with another file cannot be seen by the walk and are counted in full, ' +
  'so on such a disk the usage can be more than deleting it would free.';

const OWNER_PROVENANCE = { credential: 'internal', declaredActor: null } as const;

export type DiskCategory = 'lanes' | 'reviews' | 'preserves' | 'probes' | 'ledger' | 'logs' | 'other';
export const DISK_CATEGORIES: readonly DiskCategory[] = ['lanes', 'reviews', 'preserves', 'probes', 'ledger', 'logs', 'other'];
const CATEGORY_NAMES: Readonly<Record<DiskCategory, string>> = {
  lanes: 'lanes',
  reviews: 'review artifacts',
  preserves: 'preserve copies',
  probes: 'onboarding probes',
  ledger: 'the ledger database',
  logs: 'logs',
  other: 'other files under data_dir',
};

/** The disk's free space and total, as `fs.statfs` reads them. */
export interface DiskSpace {
  readonly freeBytes: number;
  readonly totalBytes: number;
}

/** One live lane's usage. */
export interface LaneUsage {
  readonly id: string;
  readonly kind: WorktreeRecord['kind'];
  readonly jobId: string | null;
  readonly repo: string;
  readonly path: string;
  readonly status: WorktreeRecord['status'];
  readonly bytes: number;
  readonly slim: boolean;
}

/** One usage walk. */
export interface DiskUsage {
  readonly computedAt: string;
  readonly totalBytes: number;
  readonly categories: Readonly<Record<DiskCategory, number>>;
  /** Largest first. */
  readonly lanes: readonly LaneUsage[];
}

/** One lane waiting at the floor. */
export interface FloorQueueEntry {
  readonly id: string;
  readonly jobId: string | null;
  readonly label: string;
  readonly queuedAt: string;
  readonly reason: string;
}

/** `GET /api/disk`. */
export interface DiskView {
  readonly dataDir: string;
  /** Null until the first walk finished (or when it failed). */
  readonly usage: DiskUsage | null;
  /** Null when `statfs` failed. */
  readonly disk: (DiskSpace & { readonly notGcBytes: number | null }) | null;
  readonly budgetBytes: number;
  readonly floorBytes: number;
  readonly reclaimMode: ReclaimMode;
  readonly overBudget: boolean;
  readonly belowFloor: boolean;
  readonly floorQueue: readonly FloorQueueEntry[];
  readonly note: string;
}

/** The board's disk row (compact: no per-lane list). */
export interface DiskBoardView {
  readonly usedBytes: number | null;
  readonly categories: Readonly<Record<DiskCategory, number>> | null;
  readonly freeBytes: number | null;
  readonly totalBytes: number | null;
  readonly budgetBytes: number;
  readonly floorBytes: number;
  readonly reclaimMode: ReclaimMode;
  readonly overBudget: boolean;
  readonly belowFloor: boolean;
  readonly queuedLanes: number;
  readonly computedAt: string | null;
}

/** A size as people read it (2^10 steps). */
export function diskSize(bytes: number): string {
  if (bytes < 1024) return `${String(Math.max(0, Math.round(bytes)))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]!}`;
}

const gb = (bytes: number): string => (bytes / GIB).toFixed(1);
const oneLine = (error: unknown): string => oneLineErrorText(error instanceof Error ? error.message : error, 400);

/** `fs.statfs` of the folder's filesystem: blocks available to an
 * unprivileged user, and the total. */
export async function statfsSpace(path: string): Promise<DiskSpace> {
  const stats = await fsStatfs(path);
  return { freeBytes: Number(stats.bavail) * Number(stats.bsize), totalBytes: Number(stats.blocks) * Number(stats.bsize) };
}

/** The floor queue's note for a lane that waits. */
export function floorQueueNote(freeBytes: number, floorGb: number): string {
  return `queued: ${gb(freeBytes)} GB free is below the ${String(floorGb)} GB floor ([worktrees] min_free_disk_gb); GC is freeing space`;
}

// ------------------------------------------------------------------
// The floor
// ------------------------------------------------------------------

export interface FloorAdmissionInput {
  /** The lane's id (a job id, or a child worker id). */
  readonly id: string;
  readonly label: string;
  readonly jobId: string | null;
  /** Cancels the wait (the service's stop, a child's cancel). */
  readonly signal?: AbortSignal;
  /** Called once, when this lane has to wait, with the honest reason. A
   * throw fails this lane's admission loudly. */
  readonly queued?: (info: { readonly reason: string; readonly position: number }) => void;
}

export interface DiskFloorGateOptions {
  /** `[worktrees] min_free_disk_gb`; 0 disables the floor. */
  readonly floorGb: number;
  /** A folder on the disk the floor watches (`data_dir`). */
  readonly path: string;
  /** Seam (default {@link statfsSpace}). */
  readonly statfs?: (path: string) => Promise<DiskSpace>;
  /** Durable record of a wait and its admission (the ledger in production). */
  readonly record?: (event: { readonly kind: string; readonly jobId: string | null; readonly payload: unknown }) => void;
  readonly now?: () => number;
  readonly pollMs?: number;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly log?: Log;
}

interface FloorWaiter {
  readonly input: FloorAdmissionInput;
  readonly enqueuedAt: number;
  notified: boolean;
  reason: string;
  readonly resolve: (admitted: { readonly waitedMs: number }) => void;
  readonly reject: (error: Error) => void;
  onAbort: (() => void) | null;
}

/**
 * The floor (#427 PR 3): a FIFO awaited before a job lane or a writer-child
 * lane is created. While the disk's free space is below the floor, each
 * lane waits, in order, with the queue note ({@link floorQueueNote}), and
 * the disk service is told at once to free space. Every waiting lane is
 * admitted, in order, as soon as the free space is at or above the floor
 * (read again every {@link DISK_FLOOR_POLL_MS}, and after each reclaim
 * step). Review lanes never wait here: they help work finish.
 *
 * A free space that cannot be read cannot be judged: the lane is created,
 * with one error log per failure streak, rather than every heist waiting
 * on a broken `statfs`.
 */
export class DiskFloorGate {
  readonly floorGb: number;
  readonly floorBytes: number;
  private readonly statfs: (path: string) => Promise<DiskSpace>;
  private readonly now: () => number;
  private readonly log: Log;
  private readonly waiters: FloorWaiter[] = [];
  private checking: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private failing = false;
  private belowFloor: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly opts: DiskFloorGateOptions) {
    if (!Number.isFinite(opts.floorGb) || opts.floorGb < 0) throw new Error(`DiskFloorGate: floorGb must be a non-negative number, got ${String(opts.floorGb)}`);
    this.floorGb = opts.floorGb;
    this.floorBytes = Math.round(opts.floorGb * GIB);
    this.statfs = opts.statfs ?? statfsSpace;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** The disk service's reclaim, told when a lane starts to wait. */
  onBelowFloor(listener: () => void): void {
    this.belowFloor = listener;
  }

  /** The disk's free space and total, read now. */
  space(): Promise<DiskSpace> {
    return this.statfs(this.opts.path);
  }

  /** Wait until a lane may be created. Resolves at once when the floor is
   * off or the free space is at or above it. */
  admitLane(input: FloorAdmissionInput): Promise<{ readonly waitedMs: number }> {
    if (this.floorBytes === 0) return Promise.resolve({ waitedMs: 0 });
    if (input.signal?.aborted === true) return Promise.reject(new Error('disk floor wait aborted'));
    return new Promise((resolveWait, rejectWait) => {
      const waiter: FloorWaiter = {
        input,
        enqueuedAt: this.now(),
        notified: false,
        reason: '',
        resolve: (admitted) => { this.detach(waiter); resolveWait(admitted); },
        reject: (error) => { this.detach(waiter); rejectWait(error); },
        onAbort: null,
      };
      this.waiters.push(waiter);
      if (input.signal !== undefined) {
        waiter.onAbort = () => {
          if (!this.remove(waiter)) return;
          waiter.reject(new Error('disk floor wait aborted'));
        };
        input.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      void this.check();
    });
  }

  /** Read the free space again now (after a reclaim step). */
  recheck(): void {
    if (this.waiters.length > 0) void this.check();
  }

  /** The lanes waiting, in order. */
  view(): readonly FloorQueueEntry[] {
    return this.waiters.filter((waiter) => waiter.notified).map((waiter) => ({
      id: waiter.input.id,
      jobId: waiter.input.jobId,
      label: waiter.input.label,
      queuedAt: new Date(waiter.enqueuedAt).toISOString(),
      reason: waiter.reason,
    }));
  }

  /** Stop polling (waiting lanes end with their own signals). */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) (this.opts.clearTimeout ?? clearTimeout)(this.timer);
    this.timer = null;
  }

  /** Settles once the check running now (and any it asked for) is done. */
  async idle(): Promise<void> {
    while (this.checking !== null) await this.checking;
  }

  private detach(waiter: FloorWaiter): void {
    if (waiter.onAbort !== null) waiter.input.signal?.removeEventListener('abort', waiter.onAbort);
    waiter.onAbort = null;
  }

  private remove(waiter: FloorWaiter): boolean {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return false;
    this.waiters.splice(index, 1);
    return true;
  }

  private check(): Promise<void> {
    if (this.checking !== null) {
      this.again = true;
      return this.checking;
    }
    this.checking = (async () => {
      do {
        this.again = false;
        await this.checkOnce();
      } while (this.again);
    })().finally(() => { this.checking = null; });
    return this.checking;
  }

  private async checkOnce(): Promise<void> {
    if (this.waiters.length === 0) return;
    let free: number | null;
    try {
      free = (await this.space()).freeBytes;
      this.failing = false;
    } catch (error) {
      if (!this.failing) this.log('error', 'the disk\'s free space cannot be read, so the floor cannot be judged; lanes are created without it', { path: this.opts.path, error: oneLine(error) });
      this.failing = true;
      free = null;
    }
    if (free === null || free >= this.floorBytes) {
      for (const waiter of this.waiters.splice(0)) {
        const waitedMs = Math.max(0, this.now() - waiter.enqueuedAt);
        if (waiter.notified) {
          try {
            this.opts.record?.({ kind: DISK_EVENTS.floorAdmitted, jobId: waiter.input.jobId, payload: { id: waiter.input.id, label: waiter.input.label, waited_ms: waitedMs, free_bytes: free } });
          } catch (error) {
            this.log('warn', 'a floor admission could not be recorded; the lane is created', { id: waiter.input.id, error: oneLine(error) });
          }
        }
        waiter.resolve({ waitedMs });
      }
      if (this.timer !== null) (this.opts.clearTimeout ?? clearTimeout)(this.timer);
      this.timer = null;
      return;
    }
    let started = false;
    for (const waiter of [...this.waiters]) {
      if (waiter.notified) continue;
      const reason = floorQueueNote(free, this.floorGb);
      try {
        this.opts.record?.({ kind: DISK_EVENTS.floorQueued, jobId: waiter.input.jobId, payload: { id: waiter.input.id, label: waiter.input.label, free_bytes: free, floor_bytes: this.floorBytes } });
        waiter.input.queued?.({ reason, position: this.waiters.indexOf(waiter) + 1 });
        waiter.notified = true;
        waiter.reason = reason;
        started = true;
      } catch (error) {
        this.remove(waiter);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (started) {
      try {
        this.belowFloor?.();
      } catch (error) {
        this.log('error', 'the reclaim the floor asked for failed to start; the next reconcile runs it', { error: oneLine(error) });
      }
    }
    if (this.timer === null && !this.stopped && this.waiters.length > 0) {
      this.timer = (this.opts.setTimeout ?? setTimeout)(() => {
        this.timer = null;
        void this.check();
      }, this.opts.pollMs ?? DISK_FLOOR_POLL_MS);
      this.timer.unref?.();
    }
  }
}

// ------------------------------------------------------------------
// The service
// ------------------------------------------------------------------

/** The folders the view sorts GC's usage into. */
export interface DiskPaths {
  readonly dataDir: string;
  readonly reviews: string;
  readonly preserves: string;
  readonly probes: string;
  readonly ledger: string;
  readonly logs: string;
}

/** One lossless step, as a plan or a card lists it. `bytes`: what it is
 * expected to free (null when not estimated). */
export type ReclaimStep =
  | { readonly step: 'release'; readonly lane: string; readonly jobId: string; readonly bytes: number | null; readonly detail: string }
  | { readonly step: 'expire-reviews'; readonly jobId: string; readonly bytes: number | null; readonly detail: string }
  | { readonly step: 'slim'; readonly lane: string; readonly jobId: string; readonly bytes: number | null; readonly detail: string };

/** What a step did. */
export interface StepOutcome {
  readonly step: ReclaimStep;
  readonly outcome: 'done' | 'skipped';
  readonly freedBytes: number;
  readonly reason: string | null;
}

export interface DiskServiceOptions {
  readonly ledger: Pick<LedgerApi,
    'getJob' | 'getRound' | 'listJobEventsByKinds' | 'openProviderWaitForJob' | 'appendCustomEvent' | 'listOpenNotificationsByKinds' |
    'resolveNotificationById' | 'resolveOwnerDecision' | 'withdrawOwnerProposal' | 'latestEventByPayloadField' | 'listEventsAfter' |
    'listChildWorkers' | 'coveringDecision'> & Parameters<typeof laneIsBusy>[0];
  readonly bus: EventBus;
  readonly notifications: Pick<NotificationCenter, 'post'>;
  readonly worktrees: Pick<WorktreeManager, 'listWorktrees' | 'isSlim' | 'release' | 'slim'>;
  readonly expiry: Pick<ExpiryService, 'expirableReviews' | 'expireReviews'>;
  /** The floor queue; the service frees space when a lane starts to wait. */
  readonly floor: DiskFloorGate;
  /** The job's minion turns at the pacing gate. */
  readonly workerTurns: (jobId: string) => JobWorkerTurns;
  /** True while a verification of the job is being readied, queued or running. */
  readonly verificationBusy: (jobId: string) => boolean;
  /** `[worktrees] disk_budget_gb`; 0 disables the budget. */
  readonly budgetGb: number;
  readonly mode: ReclaimMode;
  readonly paths: DiskPaths;
  /** Seam: bytes on disk under a path (default {@link treeBytes}). */
  readonly usage?: (path: string) => Promise<number>;
  /** Seam: processes rooted in a lane (default the sweep's enumeration, off the event loop). */
  readonly processesIn?: (path: string) => Promise<readonly TreeProcess[]>;
  readonly now?: () => number;
  readonly log?: Log;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

/** A recorded proposal, as its card's Accept reads it. */
interface Proposal {
  readonly usageBytes: number;
  readonly steps: readonly ReclaimStep[];
}

export class DiskService {
  readonly budgetBytes: number;
  private readonly log: Log;
  private readonly now: () => number;
  private readonly usage: (path: string) => Promise<number>;
  private cache: { readonly usage: DiskUsage; readonly at: number; freed: number } | null = null;
  private measuring: Promise<DiskUsage> | null = null;
  private lastSpace: DiskSpace | null = null;
  private unsubscribe: (() => void) | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again: string | null = null;
  private stopped = false;
  private readonly stopping = new AbortController();
  /** Events whose time could not be read, warned about once. */
  private readonly unreadable = new Set<number>();
  /** Lanes whose slim can never happen (what their base manifest says). */
  private readonly unslimmable = new Set<string>();
  /** The last skip recorded per step, so a lane that keeps refusing is
   * recorded once per reason, not at every check. */
  private readonly skips = new Map<string, string>();

  constructor(private readonly opts: DiskServiceOptions) {
    if (!Number.isFinite(opts.budgetGb) || opts.budgetGb < 0) throw new Error(`DiskService: budgetGb must be a non-negative number, got ${String(opts.budgetGb)}`);
    this.budgetBytes = Math.round(opts.budgetGb * GIB);
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.usage = opts.usage ?? ((path) => treeBytes(path));
    opts.floor.onBelowFloor(() => { void this.check('floor'); });
  }

  private get floorBytes(): number {
    return this.opts.floor.floorBytes;
  }

  private get enabled(): boolean {
    return this.budgetBytes > 0 || this.floorBytes > 0;
  }

  /** Check now, after each lane is created, on the owner's answers, and
   * every five minutes. With the budget and the floor both off, nothing is
   * checked; the view still is. */
  start(): void {
    if (this.unsubscribe !== null || this.stopped) return;
    if (!this.enabled) {
      this.log('info', 'the disk budget and floor are off ([worktrees] disk_budget_gb = 0, min_free_disk_gb = 0): nothing is checked; the view is still shown', {});
      return;
    }
    this.unsubscribe = this.opts.bus.subscribe((event) => {
      if (event.kind === 'worktree.created') {
        this.laneCreated();
        return;
      }
      if (event.kind !== 'notification.decision') return;
      const id = (event.payload as { readonly id?: unknown } | null)?.id;
      if (typeof id === 'string' && id.startsWith('disk-reclaim:')) void this.check('decision');
    });
    this.interval = (this.opts.setInterval ?? setInterval)(() => { void this.check('reconcile'); }, DISK_RECONCILE_INTERVAL_MS);
    this.interval.unref?.();
    void this.check('start');
  }

  /** Stop checking: a pass that is running stops before its next step (a
   * slim stops at its next path). */
  stop(): void {
    this.stopped = true;
    this.stopping.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.interval !== null) (this.opts.clearInterval ?? clearInterval)(this.interval);
    this.interval = null;
    if (this.soon !== null) (this.opts.clearTimeout ?? clearTimeout)(this.soon);
    this.soon = null;
    this.opts.floor.stop();
  }

  /** Settles once the pass running now (and any it asked for) is done. */
  async idle(): Promise<void> {
    while (this.running !== null) await this.running;
  }

  /** One pass (a pass already running takes this request after it). Never rejects. */
  check(trigger: string): Promise<void> {
    if (this.stopped || !this.enabled) return Promise.resolve();
    if (this.running !== null) {
      this.again = trigger;
      return this.running;
    }
    this.running = (async () => {
      let next: string | null = trigger;
      while (next !== null && !this.stopped) {
        this.again = null;
        try {
          await this.pass(next);
        } catch (error) {
          this.log('error', 'the disk check failed; the next reconcile retries it', { trigger: next, error: oneLine(error) });
        }
        next = this.again;
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }

  /** A lane was created: check now, and once more when the cached walk
   * (which may not hold the new lane) is old enough to walk again. */
  private laneCreated(): void {
    void this.check('lane-created');
    if (this.soon !== null || this.cache === null) return;
    const wait = Math.max(0, this.cache.at + DISK_VIEW_MAX_AGE_MS - this.now());
    this.soon = (this.opts.setTimeout ?? setTimeout)(() => {
      this.soon = null;
      void this.check('lane-created');
    }, wait);
    this.soon.unref?.();
  }

  // ------------------------------------------------------------------
  // The view
  // ------------------------------------------------------------------

  /** The view, walking again only when the cached walk is a minute old. */
  async refreshView(): Promise<DiskView> {
    let usage: DiskUsage | null = null;
    try {
      usage = await this.measure();
    } catch (error) {
      this.log('error', 'the disk usage walk failed', { error: oneLine(error) });
    }
    await this.space();
    return this.view(usage);
  }

  /** The board's row from the cache (it asks for a walk when the cache is a
   * minute old; the walk lands in a later snapshot). */
  boardView(): DiskBoardView {
    if (this.measuring === null && (this.cache === null || this.now() - this.cache.at >= DISK_VIEW_MAX_AGE_MS)) void this.refreshView().catch(() => {});
    const view = this.view(this.cachedUsage());
    return {
      usedBytes: view.usage?.totalBytes ?? null,
      categories: view.usage?.categories ?? null,
      freeBytes: view.disk?.freeBytes ?? null,
      totalBytes: view.disk?.totalBytes ?? null,
      budgetBytes: view.budgetBytes,
      floorBytes: view.floorBytes,
      reclaimMode: view.reclaimMode,
      overBudget: view.overBudget,
      belowFloor: view.belowFloor,
      queuedLanes: view.floorQueue.length,
      computedAt: view.usage?.computedAt ?? null,
    };
  }

  private view(usage: DiskUsage | null): DiskView {
    const space = this.lastSpace;
    return {
      dataDir: this.opts.paths.dataDir,
      usage,
      disk: space === null ? null : {
        ...space,
        notGcBytes: usage === null ? null : Math.max(0, space.totalBytes - space.freeBytes - usage.totalBytes),
      },
      budgetBytes: this.budgetBytes,
      floorBytes: this.floorBytes,
      reclaimMode: this.opts.mode,
      overBudget: usage !== null && this.budgetBytes > 0 && usage.totalBytes > this.budgetBytes,
      belowFloor: space !== null && this.floorBytes > 0 && space.freeBytes < this.floorBytes,
      floorQueue: this.opts.floor.view(),
      note: CLONE_NOTE,
    };
  }

  /** The cached walk, less what a reclaim freed since it. */
  private cachedUsage(): DiskUsage | null {
    if (this.cache === null) return null;
    const { usage, freed } = this.cache;
    return freed === 0 ? usage : { ...usage, totalBytes: Math.max(0, usage.totalBytes - freed) };
  }

  /** The usage, walked at most once a minute. */
  private async measure(): Promise<DiskUsage> {
    if (this.cache !== null && this.now() - this.cache.at < DISK_VIEW_MAX_AGE_MS) return this.cachedUsage()!;
    this.measuring ??= this.walk().then((usage) => {
      this.cache = { usage, at: this.now(), freed: 0 };
      return usage;
    }).finally(() => { this.measuring = null; });
    return this.measuring;
  }

  /** The free space now; null (logged) when it cannot be read. */
  private async space(): Promise<DiskSpace | null> {
    try {
      this.lastSpace = await this.opts.floor.space();
      return this.lastSpace;
    } catch (error) {
      this.log('warn', 'the disk\'s free space cannot be read', { error: oneLine(error) });
      this.lastSpace = null;
      return null;
    }
  }

  private async walk(): Promise<DiskUsage> {
    const { paths } = this.opts;
    const lanes: LaneUsage[] = [];
    for (const lane of this.opts.worktrees.listWorktrees().filter((row) => row.status !== 'swept')) {
      lanes.push({
        id: lane.id,
        kind: lane.kind,
        jobId: this.jobOf(lane),
        repo: lane.repoName,
        path: lane.path,
        status: lane.status,
        bytes: await this.usage(lane.path),
        slim: this.opts.worktrees.isSlim(lane.id),
      });
    }
    lanes.sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id));
    const roots = [paths.reviews, paths.preserves, paths.probes, paths.ledger, paths.logs];
    const categories: Record<DiskCategory, number> = {
      lanes: lanes.reduce((sum, lane) => sum + lane.bytes, 0),
      reviews: await this.usage(paths.reviews),
      preserves: await this.usage(paths.preserves),
      probes: await this.usage(paths.probes),
      ledger: await this.usage(paths.ledger),
      logs: await this.usage(paths.logs),
      other: await this.usageOutside(resolve(paths.dataDir), [...roots, ...lanes.map((lane) => lane.path)].map((path) => resolve(path))),
    };
    const totalBytes = DISK_CATEGORIES.reduce((sum, category) => sum + categories[category], 0);
    return { computedAt: new Date(this.now()).toISOString(), totalBytes, categories, lanes };
  }

  /** What lies under `path` outside every `excluded` path: each child that
   * holds none of them is walked whole, and a child that does is entered.
   * Links are walked as themselves, never followed. */
  private async usageOutside(path: string, excluded: readonly string[]): Promise<number> {
    if (excluded.includes(path)) return 0;
    if (!excluded.some((inner) => inside(path, inner))) return this.usage(path);
    let names: string[];
    try {
      if (!(await lstat(path)).isDirectory()) return this.usage(path);
      names = await readdir(path);
    } catch {
      return 0;
    }
    let bytes = 0;
    for (const name of names) bytes += await this.usageOutside(join(path, name), excluded);
    return bytes;
  }

  // ------------------------------------------------------------------
  // The check
  // ------------------------------------------------------------------

  private async pass(trigger: string): Promise<void> {
    if (this.opts.mode === 'proposed') await this.followCards();
    if (this.stopped) return;
    const usage = await this.measure();
    const space = await this.space();
    const over = this.budgetBytes > 0 && usage.totalBytes > this.budgetBytes;
    const under = this.floorBytes > 0 && space !== null && space.freeBytes < this.floorBytes;
    if (!over && !under) {
      this.conditionCleared();
      return;
    }
    if (this.opts.mode === 'proposed') {
      await this.propose(usage, space);
      return;
    }
    const steps = await this.plan(usage, space, { estimate: false });
    const result = await this.execute(steps, usage.totalBytes, trigger);
    if (!result.satisfied && !this.stopped) this.nothingToFree(result.skipped);
  }

  /** Whether usage is under the budget and the free space at or above the
   * floor (a free space that cannot be read is not waited for). */
  private async satisfied(usageBytes: number): Promise<boolean> {
    if (this.budgetBytes > 0 && usageBytes > this.budgetBytes) return false;
    if (this.floorBytes === 0) return true;
    const space = await this.space();
    return space === null || space.freeBytes >= this.floorBytes;
  }

  /**
   * The lossless steps, in order: release the lanes of terminal jobs
   * (largest first), delete the review folders of terminal jobs, slim idle
   * lanes (oldest idle first). With `estimate`, each step carries what it
   * would free, a lane GC knows it cannot release or slim is left out, and
   * the plan stops once the estimates get under the budget and above the
   * floor (a card lists that much); without, every candidate is listed and
   * the run stops on what was really freed.
   */
  private async plan(usage: DiskUsage, space: DiskSpace | null, opts: { readonly estimate: boolean }): Promise<readonly ReclaimStep[]> {
    const need = Math.max(
      this.budgetBytes > 0 ? usage.totalBytes - this.budgetBytes : 0,
      this.floorBytes > 0 && space !== null ? this.floorBytes - space.freeBytes : 0,
    );
    let estimated = 0;
    const enough = (): boolean => opts.estimate && estimated >= need;
    const steps: ReclaimStep[] = [];
    for (const lane of this.terminalLanes()) {
      if (enough()) break;
      const jobId = this.jobOf(lane)!;
      if (opts.estimate && (this.whyNotReleasable(lane) ?? await this.whyProcesses(lane)) !== null) continue;
      const bytes = await this.laneBytes(lane);
      estimated += bytes;
      steps.push({ step: 'release', lane: lane.id, jobId, bytes: opts.estimate ? bytes : null, detail: `Release lane ${lane.id} (${lane.kind} lane of job ${jobId}, ${this.jobStatus(jobId)}, in ${lane.repoName})` });
    }
    for (const found of this.opts.expiry.expirableReviews({ olderThanMs: 0 })) {
      if (enough()) break;
      let bytes: number | null = null;
      if (opts.estimate) {
        bytes = 0;
        for (const path of found.paths) bytes += await this.usage(path);
        estimated += bytes;
      }
      const count = found.rounds.length + found.fallbackGates.length;
      steps.push({ step: 'expire-reviews', jobId: found.jobId, bytes, detail: `Delete the ${String(count)} review folder${count === 1 ? '' : 's'} of job ${found.jobId} (${this.jobStatus(found.jobId)})` });
    }
    // A lane listed for release is not slimmed as well.
    const released = new Set(steps.flatMap((step) => (step.step === 'release' ? [step.lane] : [])));
    for (const { lane, idleSince } of this.idleLanes()) {
      if (enough()) break;
      if (released.has(lane.id)) continue;
      const jobId = lane.jobId!;
      const since = idleSince === null ? 'no recorded activity' : `idle since ${new Date(idleSince).toISOString()}`;
      let bytes: number | null = null;
      let entries = '';
      if (opts.estimate) {
        const estimate = await this.slimEstimate(lane);
        if (estimate === null || (await this.whyProcesses(lane)) !== null) continue;
        bytes = estimate.bytes;
        entries = ` (${estimate.entries.join(', ')})`;
        estimated += bytes;
      }
      steps.push({ step: 'slim', lane: lane.id, jobId, bytes, detail: `Slim lane ${lane.id}${entries} (job ${jobId}, ${this.jobStatus(jobId)}, ${since})` });
    }
    return steps;
  }

  /** Run steps in order until satisfied, recording each. */
  private async execute(steps: readonly ReclaimStep[], usageBytes: number, trigger: string): Promise<{ readonly freedBytes: number; readonly satisfied: boolean; readonly skipped: readonly StepOutcome[] }> {
    let freed = 0;
    const skipped: StepOutcome[] = [];
    let ran = 0;
    let recorded = 0;
    for (const step of steps) {
      if (this.stopped) break;
      if (await this.satisfied(usageBytes - freed)) break;
      const outcome = await this.runStep(step);
      ran += 1;
      freed += outcome.freedBytes;
      if (this.cache !== null) this.cache.freed += outcome.freedBytes;
      if (outcome.outcome === 'skipped') skipped.push(outcome);
      if (this.recordStep(outcome, trigger)) recorded += 1;
      this.opts.floor.recheck();
    }
    const satisfied = await this.satisfied(usageBytes - freed);
    if (recorded > 0) {
      this.appendEvent(DISK_EVENTS.pass, null, {
        trigger,
        mode: this.opts.mode,
        usage_bytes: usageBytes,
        freed_bytes: freed,
        budget_bytes: this.budgetBytes,
        floor_bytes: this.floorBytes,
        free_bytes: this.lastSpace?.freeBytes ?? null,
        satisfied,
        steps: ran,
        skipped: skipped.length,
      });
      this.log('info', 'disk reclaim pass', { trigger, freed_bytes: freed, steps: ran, skipped: skipped.length, satisfied });
    }
    return { freedBytes: freed, satisfied, skipped };
  }

  /** Record a step: every one done, and a skip once per reason. */
  private recordStep(outcome: StepOutcome, trigger: string): boolean {
    const { step } = outcome;
    const key = `${step.step}:${step.step === 'expire-reviews' ? step.jobId : step.lane}`;
    if (outcome.outcome === 'skipped') {
      if (this.skips.get(key) === outcome.reason) return false;
      this.skips.set(key, outcome.reason ?? '');
    } else {
      this.skips.delete(key);
    }
    this.appendEvent(DISK_EVENTS.step, step.jobId, {
      step: step.step,
      ...(step.step === 'expire-reviews' ? {} : { lane: step.lane }),
      job_id: step.jobId,
      outcome: outcome.outcome,
      freed_bytes: outcome.freedBytes,
      reason: outcome.reason,
      trigger,
    });
    return true;
  }

  private appendEvent(kind: string, jobId: string | null, payload: Record<string, unknown>): void {
    try {
      this.opts.ledger.appendCustomEvent({ kind, jobId, payload });
    } catch (error) {
      this.log('error', `${kind} could not be recorded`, { error: oneLine(error) });
    }
  }

  private async runStep(step: ReclaimStep): Promise<StepOutcome> {
    const skip = (reason: string): StepOutcome => ({ step, outcome: 'skipped', freedBytes: 0, reason });
    try {
      if (step.step === 'release') {
        const lane = this.opts.worktrees.listWorktrees().find((row) => row.id === step.lane);
        if (lane === undefined || lane.status === 'swept') return skip('the lane is gone');
        const jobId = this.jobOf(lane);
        const job = jobId === null ? null : this.opts.ledger.getJob(jobId);
        if (job === null || !isJobTerminal(job.status)) return skip(`the job is ${job?.status ?? 'not in the ledger'}, not finished`);
        const why = this.whyNotReleasable(lane) ?? await this.whyProcesses(lane);
        if (why !== null) return skip(why);
        const before = await this.laneBytes(lane);
        // Unattended, as the autopilot's release: fresh containment proven
        // first; the release snapshots the lane's work before removing it.
        const result = await this.opts.worktrees.release({ worktreeId: lane.id, requireReleaseProofs: true });
        if (result.status !== 'swept') return skip(`the release paused on live processes in the lane: ${result.note}`);
        const copied = result.preserved === null ? 0 : await this.usage(result.preserved.destination);
        return { step, outcome: 'done', freedBytes: Math.max(0, before - copied), reason: null };
      }
      if (step.step === 'expire-reviews') {
        const found = this.opts.expiry.expirableReviews({ olderThanMs: 0 }).find((entry) => entry.jobId === step.jobId);
        if (found === undefined) return skip('the job has no review folders to delete, or it is not finished');
        const sizes = new Map<string, number>();
        for (const path of found.paths) sizes.set(path, await this.usage(path));
        const [expired] = await this.opts.expiry.expireReviews({ olderThanMs: 0, jobs: [step.jobId] });
        if (expired === undefined) return skip('no review folder could be deleted');
        let freed = 0;
        for (const [index, name] of found.rounds.entries()) if (expired.rounds.includes(name)) freed += sizes.get(found.paths[index]!) ?? 0;
        for (const [index, name] of found.fallbackGates.entries()) if (expired.fallbackGates.includes(name)) freed += sizes.get(found.paths[found.rounds.length + index]!) ?? 0;
        return { step, outcome: 'done', freedBytes: freed, reason: null };
      }
      const lane = this.opts.worktrees.listWorktrees({ jobId: step.jobId }).find((row) => row.id === step.lane);
      if (lane === undefined || lane.status !== 'active') return skip('the lane is gone or not active');
      const before = await this.laneBytes(lane);
      const result = await this.opts.worktrees.slim({ worktreeId: lane.id, idle: () => this.whyNotIdle(step.jobId), signal: this.stopping.signal });
      if (result.status === 'not-slimmed') {
        if (result.permanent) this.unslimmable.add(lane.id);
        return skip(result.reason);
      }
      const after = await this.usage(lane.path);
      return { step, outcome: 'done', freedBytes: Math.max(0, before - after), reason: null };
    } catch (error) {
      return skip(`it failed: ${oneLine(error)}`);
    }
  }

  // ------------------------------------------------------------------
  // Candidates
  // ------------------------------------------------------------------

  private jobOf(lane: WorktreeRecord): string | null {
    return lane.jobId ?? (lane.roundId === null ? null : this.opts.ledger.getRound(lane.roundId)?.jobId ?? null);
  }

  private jobStatus(jobId: string): string {
    return this.opts.ledger.getJob(jobId)?.status ?? 'not in the ledger';
  }

  /** The cached walk's bytes for a lane, or a walk of it now. */
  private async laneBytes(lane: WorktreeRecord): Promise<number> {
    const cached = this.cache?.usage.lanes.find((entry) => entry.id === lane.id && entry.path === lane.path);
    return cached?.bytes ?? this.usage(lane.path);
  }

  /** Live lanes of terminal jobs, largest first. */
  private terminalLanes(): readonly WorktreeRecord[] {
    const sizes = new Map(this.cache?.usage.lanes.map((lane) => [lane.id, lane.bytes]) ?? []);
    return this.opts.worktrees.listWorktrees()
      .filter((lane) => lane.status !== 'swept')
      .filter((lane) => {
        const jobId = this.jobOf(lane);
        const job = jobId === null ? null : this.opts.ledger.getJob(jobId);
        return job !== null && isJobTerminal(job.status);
      })
      .sort((a, b) => (sizes.get(b.id) ?? 0) - (sizes.get(a.id) ?? 0) || a.id.localeCompare(b.id));
  }

  /** Why GC will not release a terminal job's lane now, or null. */
  private whyNotReleasable(lane: WorktreeRecord): string | null {
    if (lane.status === 'paused') return 'its release is paused on live processes, waiting for an answer';
    const jobId = this.jobOf(lane)!;
    if (lane.kind === 'job') {
      const outstanding = this.opts.ledger.listChildWorkers({ jobId }).filter((child) => child.resultState === null).length;
      if (outstanding > 0) return `the job has ${String(outstanding)} child worker(s) that have not finished`;
    }
    const job = this.opts.ledger.getJob(jobId);
    const covering = job === null ? null : this.opts.ledger.coveringDecision({ subject: `job:${jobId}`, signal: 'sweep-ack', basis: `status:${job.status}` });
    if (covering !== null) return `an active decision (${covering.id}) holds the job's lane release`;
    return null;
  }

  /** Processes rooted in the lane (nothing is ever killed), or null. */
  private async whyProcesses(lane: WorktreeRecord): Promise<string | null> {
    try {
      const rooted = await (this.opts.processesIn ?? ((path: string) => psEnumeratorAsync(path, {
        onCwdError: (error) => this.log('warn', 'process working directories could not be listed; argv matches still count', { error: oneLine(error) }),
      })))(lane.path);
      return rooted.length === 0 ? null : `${String(rooted.length)} process(es) rooted in the lane (pids ${rooted.map((proc) => proc.pid).join(', ')})`;
    } catch (error) {
      return `the processes rooted in the lane could not be listed: ${oneLine(error)}`;
    }
  }

  /** Active job and writer-child lanes, not slim, whose job is idle, oldest
   * idle first. */
  private idleLanes(): readonly { readonly lane: WorktreeRecord; readonly idleSince: number | null }[] {
    const idle: { lane: WorktreeRecord; idleSince: number | null }[] = [];
    for (const lane of this.opts.worktrees.listWorktrees({ status: 'active' })) {
      if (lane.jobId === null || !(lane.kind === 'job' || (lane.kind === 'child' && lane.branch !== null))) continue;
      if (this.unslimmable.has(lane.id) || this.opts.worktrees.isSlim(lane.id) || this.whyNotIdle(lane.jobId) !== null) continue;
      idle.push({ lane, idleSince: this.lastActivity(lane.jobId) });
    }
    return idle.sort((a, b) => (a.idleSince ?? 0) - (b.idleSince ?? 0) || a.lane.id.localeCompare(b.lane.id));
  }

  /** When the job was last active (null: it never was, as far as the
   * ledger says); NaN when its newest activity's time cannot be read. */
  private lastActivity(jobId: string): number | null {
    const last = this.opts.ledger.listJobEventsByKinds(jobId, LAST_ACTIVITY_KINDS, { limit: 1 })[0];
    if (last === undefined) return null;
    const at = Date.parse(last.ts);
    if (Number.isNaN(at) && !this.unreadable.has(last.seq)) {
      this.unreadable.add(last.seq);
      this.log('warn', 'a job activity event has a timestamp that cannot be read; its lanes count as not idle', { job: jobId, seq: last.seq, kind: last.kind, ts: last.ts });
    }
    return at;
  }

  /** Why a job's lanes are not idle for a slim, or null: any job whose
   * status is not working, with no turn, verification, provider wait or
   * live directive, its last activity at least {@link SLIM_MIN_IDLE_MS} old. */
  private whyNotIdle(jobId: string): string | null {
    if (this.stopped) return 'the service is stopping';
    const job = this.opts.ledger.getJob(jobId);
    if (job === null) return 'the job is not in the ledger';
    if (job.status === 'working' || job.status === 'dispatched') return `the job is ${job.status}`;
    if (laneIsBusy(this.opts.ledger, job)) return 'the lane is busy (a directive, re-brief, revision or verification is open)';
    const turns = this.opts.workerTurns(jobId);
    if (turns.held > 0 || turns.queued > 0) return `a minion turn holds or waits for a worker slot (${String(turns.held)} held, ${String(turns.queued)} queued)`;
    if (this.opts.ledger.openProviderWaitForJob(jobId) !== null) return 'a provider wait of the job is open (its continuation is a minion turn)';
    if (this.opts.verificationBusy(jobId)) return 'a verification is being readied, queued or running';
    const at = this.lastActivity(jobId);
    if (at === null) return null;
    if (Number.isNaN(at)) return 'the job\'s last activity has a timestamp that cannot be read';
    if (this.now() - at < SLIM_MIN_IDLE_MS) return `the job's last activity was less than ${String(SLIM_MIN_IDLE_MS / 60_000)} minutes ago`;
    return null;
  }

  /** What a slim of the lane would delete: the existing reclaim entries of
   * the manifest committed at its base, sized; null when its base manifest
   * declares no reclaim or no setup (it is never slimmed). */
  private async slimEstimate(lane: WorktreeRecord): Promise<{ readonly bytes: number; readonly entries: readonly string[] } | null> {
    let manifest;
    try {
      manifest = parseWorktreeManifest(await gitShow(lane.path, `${lane.sha}:${MANIFEST_PATH.split('\\').join('/')}`));
    } catch {
      return null;
    }
    if (manifest.reclaim === undefined || manifest.reclaim.length === 0 || manifest.setup.length === 0) return null;
    let bytes = 0;
    const entries: string[] = [];
    for (const entry of manifest.reclaim) {
      if ((await reclaimState(lane.path, entry).catch(() => 'absent' as const)) !== 'present') continue;
      bytes += await this.usage(join(lane.path, entry));
      entries.push(entry);
    }
    return bytes > 0 ? { bytes, entries } : null;
  }

  // ------------------------------------------------------------------
  // Proposed mode
  // ------------------------------------------------------------------

  /** One card at a time, unless a decline holds. */
  private async propose(usage: DiskUsage, space: DiskSpace | null): Promise<void> {
    if (this.opts.ledger.listOpenNotificationsByKinds([DISK_RECLAIM_KIND]).length > 0) return;
    if (this.declineHolds(usage.totalBytes)) return;
    const steps = await this.plan(usage, space, { estimate: true });
    if (this.stopped) return;
    if (steps.length === 0) {
      this.nothingToFree([]);
      return;
    }
    const last = this.latest(DISK_EVENTS.proposed);
    const proposal = Number((last?.payload as { readonly proposal?: unknown } | undefined)?.proposal ?? 0) + 1;
    const id = `disk-reclaim:${String(proposal)}`;
    this.appendEventStrict(DISK_EVENTS.proposed, {
      notification_id: id,
      proposal,
      usage_bytes: usage.totalBytes,
      budget_bytes: this.budgetBytes,
      free_bytes: space?.freeBytes ?? null,
      floor_bytes: this.floorBytes,
      steps,
    });
    this.opts.notifications.post(this.card(id, usage, space, steps));
  }

  private appendEventStrict(kind: string, payload: Record<string, unknown>): void {
    this.opts.ledger.appendCustomEvent({ kind, payload });
  }

  /** Whether the owner's last Decline still holds: GC's usage has not grown
   * by {@link DECLINE_REGROWTH} of the budget since, and the condition has
   * not cleared in between. */
  private declineHolds(usageBytes: number): boolean {
    const declined = this.latest(DISK_EVENTS.declined);
    if (declined === null) return false;
    const ended = this.latest(DISK_EVENTS.holdEnded);
    if (ended !== null && ended.seq > declined.seq) return false;
    const at = Number((declined.payload as { readonly usage_bytes?: unknown } | null)?.usage_bytes);
    return Number.isFinite(at) && usageBytes < at + this.regrowth();
  }

  private regrowth(): number {
    return Math.round(DECLINE_REGROWTH * (this.budgetBytes > 0 ? this.budgetBytes : this.floorBytes));
  }

  private latest(kind: string): EventRecord | null {
    return this.opts.ledger.listEventsAfter(0, { kinds: [kind], order: 'desc', limit: 1 })[0] ?? null;
  }

  /** Carry out the answered cards: Accept runs exactly the listed steps
   * (stopping once satisfied); Decline is recorded and holds. */
  private async followCards(): Promise<void> {
    for (const card of this.opts.ledger.listOpenNotificationsByKinds([DISK_RECLAIM_KIND])) {
      if (this.stopped) return;
      if (card.decidedOption === null) continue;
      const proposal = this.proposal(card.id);
      if (proposal === null) {
        this.closeCard(card, 'nothing done: GC has no record of what this card listed');
        continue;
      }
      if (card.decidedOption !== 'accept') {
        this.appendEventStrict(DISK_EVENTS.declined, { notification_id: card.id, usage_bytes: proposal.usageBytes, by: card.decidedBy ?? 'the owner', decided_at: card.decidedAt });
        this.closeCard(card, `nothing freed; GC asks again once its usage grows by another ${diskSize(this.regrowth())}`);
        continue;
      }
      const usage = await this.measure();
      const result = await this.execute(proposal.steps, usage.totalBytes, 'accepted');
      if (this.stopped) return;
      this.closeCard(card, `ran the listed steps until GC was under its budget and the floor, or the list ended: freed about ${diskSize(result.freedBytes)}` +
        (result.skipped.length === 0 ? '' : `; skipped ${result.skipped.map((outcome) => `${outcome.step.detail} (${outcome.reason ?? 'skipped'})`).join('; ')}`));
      if (!result.satisfied) this.nothingToFree(result.skipped);
    }
  }

  private proposal(notificationId: string): Proposal | null {
    const event = this.opts.ledger.latestEventByPayloadField(DISK_EVENTS.proposed, 'notification_id', notificationId);
    const payload = (event?.payload ?? null) as Record<string, unknown> | null;
    if (payload === null || !Array.isArray(payload['steps']) || typeof payload['usage_bytes'] !== 'number') return null;
    return { usageBytes: payload['usage_bytes'], steps: payload['steps'] as ReclaimStep[] };
  }

  private closeCard(card: NotificationRecord, detail: string): void {
    try {
      this.opts.ledger.resolveOwnerDecision(card.id, detail, OWNER_PROVENANCE);
    } catch (error) {
      if (!(error instanceof NotificationDecisionRefusal)) throw error;
      this.log('warn', 'a disk reclaim card could not be closed', { notification: card.id, error: error.message });
    }
  }

  private card(id: string, usage: DiskUsage, space: DiskSpace | null, steps: readonly ReclaimStep[]): {
    readonly id: string;
    readonly kind: typeof DISK_RECLAIM_KIND;
    readonly routing: 'needs-owner';
    readonly severity: 'info';
    readonly title: string;
    readonly detail: string;
    readonly decision: NotificationDecision;
  } {
    const total = steps.reduce((sum, step) => sum + (step.bytes ?? 0), 0);
    const condition = this.conditionText(usage, space);
    const lines = [
      condition,
      '',
      `[worktrees] reclaim_mode = "proposed": GC frees nothing until you Accept. Every step is lossless (about ${diskSize(total)} in all):`,
      ...steps.map((step, index) => `${String(index + 1)}. ${step.detail}: about ${diskSize(step.bytes ?? 0)}. ${STEP_PROMISE[step.step]}`),
      '',
      'Accept runs exactly these steps, in this order, and stops once GC is under its budget and the disk at or above the floor; a step whose lane is in use by then is skipped.',
      `Decline changes nothing; GC asks again once its usage grows by another ${diskSize(this.regrowth())}.`,
    ];
    return {
      id,
      kind: DISK_RECLAIM_KIND,
      routing: 'needs-owner',
      severity: 'info',
      title: `Free about ${diskSize(total)} of disk space`,
      detail: lines.join('\n'),
      decision: parseNotificationDecision({
        question: `Free about ${diskSize(total)} of disk space in the ${String(steps.length)} lossless step${steps.length === 1 ? '' : 's'} listed?`,
        context: condition,
        recommendation: 'Recommended: each step loses nothing (lane work is saved first, review verdicts stay in the ledger, a slim lane restores before its next turn).',
        reservedClass: 'authority-cost',
        whyNotDelegable: 'reclaim_mode = "proposed": GC frees disk space only with your Accept ([worktrees] reclaim_mode in config.toml).',
        options: [
          { id: 'accept', label: 'Accept: free the space', consequence: 'GC runs the listed steps in order and stops once it is under its budget and the floor.' },
          { id: 'decline', label: 'Decline: change nothing', consequence: `Nothing is freed. GC asks again once its usage grows by another ${diskSize(this.regrowth())}.` },
        ],
        discussion: false,
      }),
    };
  }

  /** Over budget, under the floor, or both, in numbers. */
  private conditionText(usage: DiskUsage, space: DiskSpace | null): string {
    const parts: string[] = [];
    if (this.budgetBytes > 0 && usage.totalBytes > this.budgetBytes) {
      parts.push(`GC uses ${diskSize(usage.totalBytes)} under ${this.opts.paths.dataDir}, over its ${diskSize(this.budgetBytes)} budget ([worktrees] disk_budget_gb).`);
    }
    if (this.floorBytes > 0 && space !== null && space.freeBytes < this.floorBytes) {
      parts.push(`The disk has ${diskSize(space.freeBytes)} free, below the ${diskSize(this.floorBytes)} floor ([worktrees] min_free_disk_gb); new job and writer-child lanes wait.`);
    }
    return parts.join(' ');
  }

  // ------------------------------------------------------------------
  // Nothing to free, and the condition clearing
  // ------------------------------------------------------------------

  /** One action-required row for Gru, naming the cause with numbers. */
  private nothingToFree(skipped: readonly StepOutcome[]): void {
    if (this.opts.ledger.listOpenNotificationsByKinds([DISK_FULL_KIND]).length > 0) return;
    const usage = this.cachedUsage();
    const space = this.lastSpace;
    if (usage === null) return;
    const condition = this.conditionText(usage, space);
    if (condition === '') return;
    const lanes = usage.lanes.slice(0, 5);
    const lines = [
      condition,
      `GC's usage by category: ${DISK_CATEGORIES.map((category) => `${CATEGORY_NAMES[category]} ${diskSize(usage.categories[category])}`).join(', ')}.`,
      lanes.length === 0
        ? 'GC has no live lanes.'
        : `Largest live lanes: ${lanes.map((lane) => `${lane.id} (${lane.kind}, job ${lane.jobId ?? 'none'}, ${lane.repo}${lane.slim ? ', slim' : ''}) ${diskSize(lane.bytes)}`).join('; ')}.`,
      space === null
        ? 'The disk\'s free space cannot be read, so how much of it is not GC\'s is unknown.'
        : `Things that are not GC's use ${diskSize(Math.max(0, space.totalBytes - space.freeBytes - usage.totalBytes))} of the disk (${diskSize(space.totalBytes)} in all, ${diskSize(space.freeBytes)} free).`,
      'Nothing GC can free losslessly remains: no lane of a finished job it can release, no review folder of a finished job, and no idle lane it can slim (a lane in use, one with a process rooted in it, or one whose manifest declares no reclaim and setup is never slimmed).',
      ...(skipped.length === 0 ? [] : [`Skipped this time: ${skipped.slice(0, 5).map((outcome) => `${outcome.step.detail} (${outcome.reason ?? 'skipped'})`).join('; ')}.`]),
      'The budget never stops a heist. This row closes itself once GC is under its budget and the disk at or above the floor.',
    ];
    this.opts.notifications.post({
      kind: DISK_FULL_KIND,
      routing: 'action-required',
      severity: 'error',
      title: this.floorBytes > 0 && space !== null && space.freeBytes < this.floorBytes ? 'Disk below the floor, and nothing GC can free' : 'GC over its disk budget, and nothing it can free',
      detail: lines.join('\n'),
    });
    this.log('warn', 'over the disk budget or below the floor with nothing to free; Gru is told', { usage_bytes: usage.totalBytes, free_bytes: space?.freeBytes ?? null });
  }

  /** Under the budget and at or above the floor: Gru's row closes, an
   * unanswered card is withdrawn, and a decline's hold ends. */
  private conditionCleared(): void {
    for (const row of this.opts.ledger.listOpenNotificationsByKinds([DISK_FULL_KIND])) {
      this.opts.ledger.resolveNotificationById(row.id, 'disk-condition-cleared');
    }
    for (const card of this.opts.ledger.listOpenNotificationsByKinds([DISK_RECLAIM_KIND])) {
      if (card.decidedOption !== null) continue;
      this.opts.ledger.withdrawOwnerProposal(card.id, 'GC is under its disk budget and the disk at or above the floor now; nothing needs freeing');
    }
    const declined = this.latest(DISK_EVENTS.declined);
    const ended = this.latest(DISK_EVENTS.holdEnded);
    if (declined !== null && (ended === null || ended.seq < declined.seq)) {
      this.appendEvent(DISK_EVENTS.holdEnded, null, { notification_id: (declined.payload as { readonly notification_id?: unknown } | null)?.notification_id ?? null, reason: 'under the budget and at or above the floor' });
    }
  }
}

const STEP_PROMISE: Readonly<Record<ReclaimStep['step'], string>> = {
  release: 'Its uncommitted work is saved first (a snapshot ref and a preserve copy).',
  'expire-reviews': 'The ledger keeps the verdicts and findings, and the PR the published review.',
  slim: 'Only the folders its manifest says setup recreates; setup restores them before its next turn.',
};

/** Whether `inner` lies strictly inside `outer`. */
function inside(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** `git show <spec>` with no user or system config, off the event loop. */
function gitShow(cwd: string, spec: string): Promise<string> {
  return new Promise((resolveShow, rejectShow) => {
    execFile('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'show', spec], {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout) => {
      if (error !== null) rejectShow(error);
      else resolveShow(stdout);
    });
  });
}

// ------------------------------------------------------------------
// GET /api/disk
// ------------------------------------------------------------------

export interface DiskServer {
  requestHook(req: IncomingMessage, res: ServerResponse, path: string): boolean;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** `GET /api/disk`: the disk view (authenticated like every product surface). */
export function createDiskServer(options: { readonly token: string; readonly service: Pick<DiskService, 'refreshView'>; readonly log?: Log }): DiskServer {
  const log = options.log ?? (() => {});
  const tokenHash = hashToken(options.token);
  const configured = tokenConfigured(options.token);
  return {
    requestHook(req, res, path): boolean {
      if (path !== '/api/disk') return false;
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method_not_allowed', detail: 'GET /api/disk' });
        return true;
      }
      if (!configured) {
        json(res, 503, { error: 'not_configured', detail: 'no pairing token configured' });
        return true;
      }
      const header = req.headers.authorization;
      const match = typeof header === 'string' ? /^Bearer (.+)$/.exec(header.trim()) : null;
      if (match === null || !tokenMatches(match[1]!, tokenHash)) {
        json(res, 401, { error: 'unauthorized' });
        return true;
      }
      options.service.refreshView().then(
        (view) => json(res, 200, view),
        (error: unknown) => {
          log('error', 'disk view request failed', { detail: oneLine(error) });
          if (!res.headersSent) json(res, 500, { error: 'internal', detail: oneLine(error) });
        },
      );
      return true;
    },
  };
}

/** Start the disk checks after the service listens: off the heist path, so
 * a failure to start is loud, never fatal. */
export function startDisk(disk: Pick<DiskService, 'start'>, log: Log): void {
  try {
    disk.start();
  } catch (error) {
    log('error', 'the disk budget failed to start', { error: String(error) });
  }
}
