import { execFile } from 'node:child_process';
import { statfs as fsStatfs, lstat, readdir, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { hashToken, tokenConfigured, tokenMatches } from '../auth.js';
import type { ReclaimMode, WorktreesConfig } from '../config.js';
import { laneIsBusy } from '../dispatch/branch-idle.js';
import type { EventBus } from '../events/bus.js';
import { NotificationDecisionRefusal, type EventRecord, type JobRecord, type LedgerApi, type NotificationRecord, type WorktreeRecord } from '../ledger/api.js';
import { parseNotificationDecision, type NotificationDecision } from '../ledger/notification-decision.js';
import { isJobTerminal } from '../ledger/states.js';
import type { LogLevel } from '../logger.js';
import type { NotificationCenter } from '../notifications/center.js';
import { onboardingProbesDir } from '../onboarding/proof.js';
import { oneLineErrorText } from '../property/error-text.js';
import type { JobWorkerTurns } from '../runtime/pacing.js';
import { normalizedManifestPath, processListingAsync, type TreeProcess, type WorktreeManager } from '../worktrees/manager.js';
import { MANIFEST_PATH, parseWorktreeManifest } from '../worktrees/manifest.js';
import { reclaimState, treeUsage } from '../worktrees/reclaim.js';
import { ANSWER_KINDS, LAST_ACTIVITY_KINDS, SLIM_MIN_IDLE_MS } from '../worktrees/slimming.js';
import type { ExpirableReviews, ExpiryService } from './expiry.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * The disk view, budget and floor (#427 PR 3).
 *
 * - **The view** (`GET /api/disk`, and the board's disk row next to the
 *   verify queue): GC's usage under `data_dir` by category (lanes, each
 *   with slim or not; review artifacts; preserve copies; onboarding
 *   probes; the ledger database; logs; everything else under `data_dir`),
 *   the free space and total (`fs.statfs`) of each disk the floor watches,
 *   the budget and the floor. Usage is allocated blocks, each inode counted
 *   once within a walk (the 2a walker, {@link treeUsage}); a file also
 *   hard-linked from outside its walk is shown apart, as shared bytes, and
 *   blocks an APFS clone shares cannot be detected ({@link CLONE_NOTE}).
 *   The walk is async (never one blocking call), runs at most once per
 *   {@link DISK_VIEW_MAX_AGE_MS} and is cached; a reclaim that freed space
 *   drops the cache, so the next numbers are walked afresh.
 * - **The budget** (`[worktrees] disk_budget_gb`) is checked at start,
 *   every {@link DISK_RECONCILE_INTERVAL_MS} and after each lane is
 *   created. Over it, in `automatic` mode, GC frees space losslessly, in
 *   order, until its usage is at most {@link BUDGET_LOW_WATER} of the
 *   budget and the disks are at or above the floor: it releases the lanes
 *   of jobs that ended at least {@link RELEASE_MIN_TERMINAL_MS} ago and
 *   have settled (the existing release, as `diskBudget`: it snapshots
 *   their work, asks origin only before the removal and off the event loop,
 *   within the normal fetch bound, removes off the event loop, keeps the
 *   lane's branch for a later release, and refuses rather than pause on a
 *   live process, wait past the bound or trust a process listing that could
 *   not read working directories; at most {@link MAX_RELEASES_PER_PASS} a
 *   pass), deletes the review folders of
 *   finished jobs no Perkins review owns (no round pending or live, no
 *   fallback gate or setup running, no superseded round not proven stopped;
 *   keeping what 2b's expiry keeps), then slims idle lanes, oldest idle
 *   first (2a's `slim()` with its checks). Each step is recorded
 *   (`disk.reclaim-step`; a skip once per kind of reason). The budget never
 *   stops or refuses a heist.
 * - **`proposed` mode** does none of that: one typed FOR YOU card
 *   ({@link DISK_RECLAIM_KIND}) lists each step and the space it frees,
 *   recorded first (`disk.reclaim-proposed`). Accept runs exactly those
 *   steps (a slim deletes only the entries its step listed); Decline holds
 *   until GC's usage grows by a further {@link DECLINE_REGROWTH} of the
 *   budget past its usage at the Decline. A card posted for the budget
 *   alone does not cover the floor: lanes that start to wait at the floor
 *   while it is open are never held silently (Gru is told, and the queue
 *   note says the card waits for the owner).
 * - **The floor** (`[worktrees] min_free_disk_gb`): a job or writer-child
 *   lane waits in the {@link DiskFloorGate} FIFO while a disk it watches
 *   (where lanes are created, and data_dir's) has less free space, and GC
 *   runs the reclaim (or posts the card) at once, without waiting for a
 *   usage walk. A floor at or above a disk's size is treated as off, and
 *   Gru is told ({@link DISK_FLOOR_OFF_KIND}).
 * - **Nothing left to free**: over budget or under the floor with nothing
 *   reclaimable, Gru gets one action-required row ({@link DISK_FULL_KIND})
 *   naming GC's usage by category, the largest live lanes and how much of
 *   each disk is not GC's; it closes itself once the condition clears.
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
/** A lane admitted from the floor queue holds the next one back until its
 * creation finished, or this long, so the next admission reads the free
 * space the new lane left. */
export const DISK_FLOOR_SETTLE_MS = 30_000;
/** A pass that left releases for later checks again this soon. */
export const DISK_FOLLOW_UP_MS = 15_000;
/** A declined card holds until GC's usage grows by this share of the budget
 * (of the floor when the budget is off). */
export const DECLINE_REGROWTH = 0.1;
/** Over the budget, GC frees space until its usage is at most this share of
 * it (a low-water mark); the next reclaim starts only over the budget. */
export const BUDGET_LOW_WATER = 0.9;
/** A finished job's lane is released only once the job ended this long ago. */
export const RELEASE_MIN_TERMINAL_MS = 10 * 60_000;
/** Lane releases one pass runs at most: each makes synchronous git calls. */
export const MAX_RELEASES_PER_PASS = 3;
/** A lane whose release refused is asked again once its job has news, or this long after. */
export const RELEASE_RETRY_MS = 60 * 60_000;
/** The owner's Accept/Decline on freeing space (`reclaim_mode = "proposed"`). */
export const DISK_RECLAIM_KIND = 'disk.reclaim-proposal';
/** Gru's row when nothing reclaimable remains (producer-resolved). */
export const DISK_FULL_KIND = 'disk.nothing-to-free';
/** Gru's row when the floor is at or above a disk's size (producer-resolved). */
export const DISK_FLOOR_OFF_KIND = 'disk.floor-impossible';

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

export const CLONE_NOTE = 'Usage counts the allocated blocks of each file, each inode once within a walk (each lane, each category). ' +
  'A file also hard-linked from outside its walk (a package store\'s links) is shown apart, as shared bytes, and not counted in the usage: deleting the walk frees none of it. ' +
  'Blocks an APFS clone (copy-on-write) shares with another file cannot be detected and are counted in full, ' +
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

/** A disk's free space and total, as `fs.statfs` reads them. */
export interface DiskSpace {
  readonly freeBytes: number;
  readonly totalBytes: number;
}

/** What a walk of one tree found: the bytes deleting it frees, and those
 * of files also hard-linked from outside it. */
export interface WalkUsage {
  readonly bytes: number;
  readonly sharedBytes: number;
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
  readonly sharedBytes: number;
  readonly slim: boolean;
}

/** One usage walk. */
export interface DiskUsage {
  readonly computedAt: string;
  /** What deleting all of it would free (shared bytes left out). */
  readonly totalBytes: number;
  /** Bytes of files also hard-linked from outside their walk, summed over
   * the walks (a file shared by two lanes counts in each). */
  readonly sharedBytes: number;
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

/** A folder whose disk the floor watches. */
export interface FloorVolume {
  /** What lives there: `lanes` ([worktrees] root) or `data_dir`. */
  readonly name: string;
  readonly path: string;
}

/** One disk the floor watches, as read now. Folders on one disk are read
 * as one. */
export interface VolumeRead {
  /** What lives on it, in the order configured. */
  readonly names: readonly string[];
  /** The first folder configured on it. */
  readonly path: string;
  /** Null when `statfs` failed (`error` says why). */
  readonly space: DiskSpace | null;
  readonly error: string | null;
}

/** One watched disk in the view. */
export interface DiskVolumeView extends DiskSpace {
  readonly names: readonly string[];
  readonly path: string;
  /** What is used on the disk by things that are not GC's (null before
   * the first walk). */
  readonly notGcBytes: number | null;
  readonly belowFloor: boolean;
}

/** `GET /api/disk`. */
export interface DiskView {
  readonly dataDir: string;
  /** Null until the first walk finished (or when it failed). */
  readonly usage: DiskUsage | null;
  /** Each disk the floor watches whose free space could be read: where
   * lanes are created, and data_dir's (one entry when they share a disk). */
  readonly volumes: readonly DiskVolumeView[];
  /** The watched folders whose disk could not be read. */
  readonly unreadable: readonly { readonly names: readonly string[]; readonly path: string; readonly error: string }[];
  readonly budgetBytes: number;
  readonly floorBytes: number;
  /** Why the configured floor is treated as off (it is at or above a
   * disk's size), or null. */
  readonly floorOff: string | null;
  readonly reclaimMode: ReclaimMode;
  readonly overBudget: boolean;
  readonly belowFloor: boolean;
  readonly floorQueue: readonly FloorQueueEntry[];
  readonly note: string;
}

/** The board's disk row (compact: no per-lane list). */
export interface DiskBoardView {
  readonly usedBytes: number | null;
  readonly sharedBytes: number | null;
  readonly categories: Readonly<Record<DiskCategory, number>> | null;
  /** The watched disk with the least free space. */
  readonly freeBytes: number | null;
  readonly totalBytes: number | null;
  readonly volumes: readonly { readonly names: readonly string[]; readonly path: string; readonly freeBytes: number; readonly totalBytes: number; readonly belowFloor: boolean }[];
  readonly budgetBytes: number;
  readonly floorBytes: number;
  readonly reclaimMode: ReclaimMode;
  readonly overBudget: boolean;
  readonly belowFloor: boolean;
  readonly queuedLanes: number;
  /** The lanes waiting at the floor, in order. */
  readonly floorQueue: readonly { readonly id: string; readonly label: string; readonly queuedAt: string; readonly reason: string }[];
  readonly computedAt: string | null;
}

/** A size as people read it (2^10 steps). */
export function diskSize(bytes: number): string {
  return sized(bytes, (value) => value.toFixed(1));
}

/** {@link diskSize} rounded down, for a free space read against the floor:
 * 9.96 GB free reads "9.9 GB", never "10.0 GB" below a 10 GB floor. */
export function diskSizeDown(bytes: number): string {
  return sized(bytes, (value) => (Math.floor(value * 10 + 1e-9) / 10).toFixed(1));
}

function sized(bytes: number, format: (value: number) => string): string {
  if (bytes < 1024) return `${String(Math.max(0, Math.floor(bytes)))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${format(value)} ${units[unit]!}`;
}

/** GB, one decimal, rounded down (a free space against the floor). */
const gbDown = (bytes: number): string => (Math.floor((bytes / GIB) * 10 + 1e-9) / 10).toFixed(1);
const oneLine = (error: unknown): string => oneLineErrorText(error instanceof Error ? error.message : error, 400);
/** A byte count as the board's validator takes it: a safe non-negative integer. */
const byteCount = (bytes: number): number => Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(bytes)));

/** The nearest folder at or above `path` that exists (a lane root may not
 * exist before the first lane). */
async function nearestExisting(path: string): Promise<string> {
  let current = resolve(path);
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return current;
      current = parent;
    }
  }
}

/** `fs.statfs` of the folder's filesystem: blocks available to an
 * unprivileged user, and the total. */
export async function statfsSpace(path: string): Promise<DiskSpace> {
  const stats = await fsStatfs(await nearestExisting(path));
  return { freeBytes: Number(stats.bavail) * Number(stats.bsize), totalBytes: Number(stats.blocks) * Number(stats.bsize) };
}

/** Which disk a folder is on: its `stat` device. */
async function deviceOf(path: string): Promise<string> {
  return String((await stat(await nearestExisting(path))).dev);
}

/** What GC is doing about a floor wait, as the queue note says it. */
export type FloorReclaimState = 'checking' | 'freeing' | 'proposed' | 'nothing';

const FLOOR_STATE_TEXT: Readonly<Record<FloorReclaimState, string>> = {
  checking: 'GC is checking what it can free',
  freeing: 'GC is freeing space',
  proposed: 'the reclaim card is waiting for the owner\'s decision',
  nothing: 'nothing more can be freed without losing work; Gru has been told',
};

/** The floor queue's note for a lane that waits: the free space rounded
 * down, the floor, where (when more than one disk is watched) and what GC
 * is doing about it. */
export function floorQueueNote(freeBytes: number, floorGb: number, state: FloorReclaimState, where = ''): string {
  return `queued: ${gbDown(freeBytes)} GB free is below the ${String(floorGb)} GB floor ([worktrees] min_free_disk_gb)${where}; ${FLOOR_STATE_TEXT[state]}`;
}

/** "the disk", or which one when more than one is watched. */
function diskName(read: Pick<VolumeRead, 'names' | 'path'>, watched: number): string {
  return watched > 1 ? `the ${read.names.join(' and ')} disk (${read.path})` : 'the disk';
}

const capitalized = (text: string): string => `${text.slice(0, 1).toUpperCase()}${text.slice(1)}`;

// ------------------------------------------------------------------
// The floor
// ------------------------------------------------------------------

export interface FloorAdmissionInput {
  /** The lane's id (a job id, or a child worker id). */
  readonly id: string;
  readonly label: string;
  readonly jobId: string | null;
  /** Ends the wait: the service's stop, and the job's bin or park (a job
   * lane) or the child's cancel (a writer child's). A string reason is
   * named in the error. */
  readonly signal?: AbortSignal;
  /** Called when this lane starts to wait, and again whenever what GC is
   * doing about it changes, with the honest reason. A throw fails this
   * lane's admission loudly. */
  readonly queued?: (info: { readonly reason: string; readonly position: number }) => void;
}

/** A lane the floor let through. */
export interface FloorAdmission {
  readonly waitedMs: number;
  /** Call once the lane's creation finished or failed (more calls are
   * no-ops): a lane admitted from the queue holds the next one back until
   * then, or for at most {@link DISK_FLOOR_SETTLE_MS}. */
  done(): void;
}

export interface DiskFloorGateOptions {
  /** `[worktrees] min_free_disk_gb`; 0 disables the floor. */
  readonly floorGb: number;
  /** The folders whose disks the floor watches, where lanes are created
   * first ([worktrees] root, then data_dir); see {@link floorVolumes}. */
  readonly volumes: readonly FloorVolume[];
  /** Seam (default {@link statfsSpace}). */
  readonly statfs?: (path: string) => Promise<DiskSpace>;
  /** Seam: which disk a folder is on (default its `stat` device). */
  readonly device?: (path: string) => Promise<string>;
  /** Durable record of a wait and its admission (the ledger in production). */
  readonly record?: (event: { readonly kind: string; readonly jobId: string | null; readonly payload: unknown }) => void;
  readonly now?: () => number;
  readonly pollMs?: number;
  readonly settleMs?: number;
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
  readonly log?: Log;
}

interface FloorWaiter {
  readonly input: FloorAdmissionInput;
  readonly enqueuedAt: number;
  notified: boolean;
  /** The reclaim state and the disk its note last named. */
  state: FloorReclaimState | null;
  where: string | null;
  reason: string;
  readonly resolve: (admitted: FloorAdmission) => void;
  readonly reject: (error: Error) => void;
  onAbort: (() => void) | null;
}

/**
 * The floor (#427 PR 3): a FIFO awaited before a job lane or a writer-child
 * lane is created. While a watched disk (where lanes are created, and
 * data_dir's) has less free space than the floor, each lane waits, in
 * order, with the queue note ({@link floorQueueNote}), and the disk service
 * is told at once to free space. Once every watched disk is at or above the
 * floor (read every {@link DISK_FLOOR_POLL_MS}, and after each reclaim
 * step), the head of the queue is admitted, and the next one only after
 * that lane's creation finished (or {@link DISK_FLOOR_SETTLE_MS}) and the
 * free space was read again. A lane that arrives with nobody queued and the
 * floor met goes straight through. Review lanes never wait here: they help
 * work finish.
 *
 * A free space that cannot be read cannot be judged: the lane is created,
 * with one error log per failure streak, rather than every heist waiting on
 * a broken `statfs`. A floor at or above a watched disk's total size could
 * never be met: it is treated as off (an error log, and the disk service
 * tells Gru) until the config changes.
 */
export class DiskFloorGate {
  readonly floorGb: number;
  readonly floorBytes: number;
  readonly volumes: readonly FloorVolume[];
  private readonly statfs: (path: string) => Promise<DiskSpace>;
  private readonly device: (path: string) => Promise<string>;
  private readonly now: () => number;
  private readonly log: Log;
  private readonly waiters: FloorWaiter[] = [];
  private checking: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The lane admitted from the queue whose creation the next one waits for. */
  private holding: { readonly waiter: FloorWaiter; readonly timer: ReturnType<typeof setTimeout> } | null = null;
  private failing = false;
  private state: FloorReclaimState = 'checking';
  /** The disk last read below the floor (null once the floor was met). */
  private lastBelow: { readonly freeBytes: number; readonly path: string; readonly where: string } | null = null;
  /** The watched disks the floor does not fit, as last read (null: not read yet). */
  private tooSmall: string | null = null;
  private belowFloorListener: (() => void) | null = null;
  private floorOffListener: ((reads: readonly VolumeRead[]) => void) | null = null;
  private stopped = false;

  constructor(private readonly opts: DiskFloorGateOptions) {
    if (!Number.isFinite(opts.floorGb) || opts.floorGb < 0) throw new Error(`DiskFloorGate: floorGb must be a non-negative number, got ${String(opts.floorGb)}`);
    if (opts.volumes.length === 0) throw new Error('DiskFloorGate: volumes must name at least one folder whose disk the floor watches');
    this.floorGb = opts.floorGb;
    this.floorBytes = Math.round(opts.floorGb * GIB);
    this.volumes = opts.volumes;
    this.statfs = opts.statfs ?? statfsSpace;
    this.device = opts.device ?? deviceOf;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /** The disk service's reclaim, told when a lane starts to wait. */
  onBelowFloor(listener: () => void): void {
    this.belowFloorListener = listener;
  }

  /** The disk service, told when the floor stops or starts fitting the
   * watched disks (the disks it does not fit; empty once it fits). */
  onFloorOff(listener: (tooSmall: readonly VolumeRead[]) => void): void {
    this.floorOffListener = listener;
    // The next read tells the new listener where the floor stands.
    this.tooSmall = null;
  }

  /** What GC is doing about the floor: the queue notes say it. */
  setReclaimState(state: FloorReclaimState): void {
    if (this.state === state) return;
    this.state = state;
    // At once, with the free space last read: the note says what GC does now.
    this.renote(false);
  }

  /** Each watched disk's free space and total, read now (folders on one
   * disk read once). */
  async space(): Promise<readonly VolumeRead[]> {
    const reads: { names: string[]; path: string; device: string; space: DiskSpace | null; error: string | null }[] = [];
    for (const { name, path } of this.volumes) {
      let device: string;
      try {
        device = await this.device(path);
      } catch {
        device = `path:${resolve(path)}`;
      }
      const same = reads.find((read) => read.device === device);
      if (same !== undefined) {
        same.names.push(name);
        continue;
      }
      try {
        reads.push({ names: [name], path, device, space: await this.statfs(path), error: null });
      } catch (error) {
        reads.push({ names: [name], path, device, space: null, error: oneLine(error) });
      }
    }
    const result = reads.map(({ names, path, space, error }) => ({ names, path, space, error }));
    this.noteFit(result);
    return result;
  }

  /** The disks below the floor; none while the floor is off or does not
   * fit a disk. */
  belowFloor(reads: readonly VolumeRead[]): readonly VolumeRead[] {
    if (this.floorBytes === 0 || this.misfits(reads).length > 0) return [];
    return reads.filter((read) => read.space !== null && read.space.freeBytes < this.floorBytes);
  }

  /** The disks whose whole size is at or below the floor. */
  misfits(reads: readonly VolumeRead[]): readonly VolumeRead[] {
    if (this.floorBytes === 0) return [];
    return reads.filter((read) => read.space !== null && this.floorBytes >= read.space.totalBytes);
  }

  /** Wait until a lane may be created. Resolves at once when the floor is
   * off, or nobody waits and the free space is at or above it. */
  admitLane(input: FloorAdmissionInput): Promise<FloorAdmission> {
    if (this.floorBytes === 0) return Promise.resolve({ waitedMs: 0, done: () => {} });
    if (input.signal?.aborted === true) return Promise.reject(abortError(input.signal));
    return new Promise((resolveWait, rejectWait) => {
      const waiter: FloorWaiter = {
        input,
        enqueuedAt: this.now(),
        notified: false,
        state: null,
        where: null,
        reason: '',
        resolve: (admitted) => { this.detach(waiter); resolveWait(admitted); },
        reject: (error) => { this.detach(waiter); rejectWait(error); },
        onAbort: null,
      };
      this.waiters.push(waiter);
      if (input.signal !== undefined) {
        const signal = input.signal;
        waiter.onAbort = () => {
          if (!this.remove(waiter)) return;
          waiter.reject(abortError(signal));
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
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
    this.clearPoll();
    if (this.holding !== null) (this.opts.clearTimeout ?? clearTimeout)(this.holding.timer);
    this.holding = null;
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

  private clearPoll(): void {
    if (this.timer !== null) (this.opts.clearTimeout ?? clearTimeout)(this.timer);
    this.timer = null;
  }

  /** Log, and tell the disk service, when the floor stops or starts fitting
   * the watched disks. */
  private noteFit(reads: readonly VolumeRead[]): void {
    const misfits = this.misfits(reads);
    const key = misfits.map((read) => read.path).join('\n');
    if (key === this.tooSmall) return;
    this.tooSmall = key;
    if (misfits.length > 0) {
      this.log('error', 'the disk floor is at or above the size of a disk it watches, so it could never be met: it is treated as off until the config changes', {
        floor_bytes: this.floorBytes,
        disks: misfits.map((read) => ({ path: read.path, names: read.names, total_bytes: read.space?.totalBytes ?? null })),
      });
    }
    try {
      this.floorOffListener?.(misfits);
    } catch (error) {
      this.log('error', 'the disk floor\'s fit could not be reported', { error: oneLine(error) });
    }
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

  /** Give each waiting lane the note for the free space last read below
   * the floor and what GC is doing now (only lanes already waiting, unless
   * `fresh`: then lanes just judged below it start to wait). A note changes
   * only when what GC does, or the disk below the floor, changes. True when
   * a lane started to wait. */
  private renote(fresh: boolean): boolean {
    const below = this.lastBelow;
    if (below === null) return false;
    let started = false;
    for (const waiter of [...this.waiters]) {
      if (waiter.notified ? waiter.state === this.state && waiter.where === below.where : !fresh) continue;
      const reason = floorQueueNote(below.freeBytes, this.floorGb, this.state, below.where);
      try {
        if (!waiter.notified) {
          this.opts.record?.({ kind: DISK_EVENTS.floorQueued, jobId: waiter.input.jobId, payload: { id: waiter.input.id, label: waiter.input.label, free_bytes: below.freeBytes, floor_bytes: this.floorBytes, disk: below.path } });
        }
        waiter.input.queued?.({ reason, position: this.waiters.indexOf(waiter) + 1 });
        if (!waiter.notified) started = true;
        waiter.notified = true;
        waiter.state = this.state;
        waiter.where = below.where;
        waiter.reason = reason;
      } catch (error) {
        this.remove(waiter);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return started;
  }

  private admit(waiter: FloorWaiter, free: number | null): void {
    const waitedMs = Math.max(0, this.now() - waiter.enqueuedAt);
    if (waiter.notified) {
      try {
        this.opts.record?.({ kind: DISK_EVENTS.floorAdmitted, jobId: waiter.input.jobId, payload: { id: waiter.input.id, label: waiter.input.label, waited_ms: waitedMs, free_bytes: free } });
      } catch (error) {
        this.log('warn', 'a floor admission could not be recorded; the lane is created', { id: waiter.input.id, error: oneLine(error) });
      }
    }
    let settled = false;
    waiter.resolve({
      waitedMs,
      done: () => {
        if (settled) return;
        settled = true;
        this.settled(waiter);
      },
    });
  }

  /** The admitted lane's creation finished (or the bound passed): the next
   * waiter may be judged. */
  private settled(waiter: FloorWaiter): void {
    if (this.holding?.waiter !== waiter) return;
    (this.opts.clearTimeout ?? clearTimeout)(this.holding.timer);
    this.holding = null;
    if (!this.stopped) void this.check();
  }

  private hold(waiter: FloorWaiter): void {
    const timer = (this.opts.setTimeout ?? setTimeout)(() => { this.settled(waiter); }, this.opts.settleMs ?? DISK_FLOOR_SETTLE_MS);
    timer.unref?.();
    this.holding = { waiter, timer };
  }

  private async checkOnce(): Promise<void> {
    if (this.waiters.length === 0) {
      this.clearPoll();
      return;
    }
    if (this.holding !== null) return;
    const reads = await this.space();
    if (this.waiters.length === 0 || this.holding !== null) return;
    const unread = reads.filter((read) => read.space === null);
    if (unread.length > 0) {
      if (!this.failing) {
        this.log('error', 'a disk\'s free space cannot be read, so the floor cannot be judged on it; lanes are created without it', {
          disks: unread.map((read) => ({ path: read.path, names: read.names, error: read.error })),
        });
      }
      this.failing = true;
    } else {
      this.failing = false;
    }
    const below = this.belowFloor(reads);
    if (below.length === 0) {
      this.lastBelow = null;
      const readable = reads.filter((read) => read.space !== null);
      if (readable.length === 0 || this.misfits(reads).length > 0) {
        // Nothing to judge by, or a floor that could never be met: every lane goes.
        for (const waiter of this.waiters.splice(0)) this.admit(waiter, null);
        this.clearPoll();
        return;
      }
      const free = Math.min(...readable.map((read) => read.space!.freeBytes));
      const head = this.waiters.shift()!;
      this.admit(head, free);
      // A lane admitted from the queue holds the next back until it is made;
      // a lane that never queued lets the next be judged at once.
      if (head.notified) this.hold(head);
      else if (this.waiters.length > 0) this.again = true;
      if (this.waiters.length === 0) this.clearPoll();
      return;
    }
    const lowest = below.reduce((low, read) => (read.space!.freeBytes < low.space!.freeBytes ? read : low));
    this.lastBelow = { freeBytes: lowest.space!.freeBytes, path: lowest.path, where: reads.length > 1 ? ` on ${diskName(lowest, reads.length)}` : '' };
    if (this.renote(true)) {
      try {
        this.belowFloorListener?.();
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

function abortError(signal: AbortSignal): Error {
  return new Error(`disk floor wait aborted${typeof signal.reason === 'string' ? `: ${signal.reason}` : ''}`);
}

// ------------------------------------------------------------------
// The service
// ------------------------------------------------------------------

/** The folders the view sorts GC's usage into. */
export interface DiskPaths {
  readonly dataDir: string;
  /** Where lanes are created ([worktrees] root). */
  readonly lanes: string;
  readonly reviews: string;
  readonly preserves: string;
  readonly probes: string;
  readonly ledger: string;
  readonly logs: string;
}

/** One lossless step, as a plan or a card lists it. `bytes`: what it is
 * expected to free (null when not estimated). An expire-reviews step names
 * exactly the folders it deletes; a card's slim step the reclaim entries it
 * deletes (`entries`; null in automatic mode: whatever `slim()` finds). */
export type ReclaimStep =
  | { readonly step: 'release'; readonly lane: string; readonly jobId: string; readonly bytes: number | null; readonly detail: string }
  | { readonly step: 'expire-reviews'; readonly jobId: string; readonly rounds: readonly string[]; readonly fallbackGates: readonly string[]; readonly bytes: number | null; readonly detail: string }
  | { readonly step: 'slim'; readonly lane: string; readonly jobId: string; readonly entries: readonly string[] | null; readonly bytes: number | null; readonly detail: string };

/** What a step did. */
export interface StepOutcome {
  readonly step: ReclaimStep;
  readonly outcome: 'done' | 'skipped';
  readonly freedBytes: number;
  readonly reason: string | null;
}

export interface DiskServiceOptions {
  readonly ledger: Pick<LedgerApi,
    'getJob' | 'getRound' | 'getWorktree' | 'listJobEventsByKinds' | 'openProviderWaitForJob' | 'appendCustomEvent' | 'listOpenNotificationsByKinds' |
    'resolveNotificationById' | 'resolveOwnerDecision' | 'withdrawOwnerProposal' | 'latestEventByPayloadField' | 'listEventsAfter' |
    'listChildWorkers' | 'coveringDecision' | 'listRounds' | 'hasUnsettledVerificationRun'> & Parameters<typeof laneIsBusy>[0];
  readonly bus: EventBus;
  readonly notifications: Pick<NotificationCenter, 'post'>;
  readonly worktrees: Pick<WorktreeManager, 'listWorktrees' | 'isSlim' | 'release' | 'slim' | 'slimRecordRefusal'>;
  readonly expiry: Pick<ExpiryService, 'expirableReviews' | 'expireJobReviews' | 'reviewsInUse'>;
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
  /** Seam: what a walk of a path finds (default {@link treeUsage}). */
  readonly usage?: (path: string) => Promise<WalkUsage>;
  /** Seam: one process listing, answering for any lane (default `ps` and
   * the working directories, off the event loop); read once per pass. */
  readonly listProcesses?: () => Promise<(path: string) => readonly TreeProcess[]>;
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

/** What one pass reads once and shares across its steps. */
interface PassContext {
  /** The live lanes (active and paused), listed once. */
  readonly lanes: readonly WorktreeRecord[];
  /** The process listing, read at its first use. */
  listing: Promise<{ readonly rootedIn: ((path: string) => readonly TreeProcess[]) | null; readonly error: string | null }> | null;
  /** The finished jobs' review folders, listed at their first use. */
  reviews: readonly ExpirableReviews[] | null;
  /** Releases this pass ran (calls to `release`). */
  releases: number;
  /** Releasable lanes this pass left for the next ({@link MAX_RELEASES_PER_PASS}). */
  deferred: number;
}

/** Why a row says nothing is left to free (or, `proposed-open`, that the
 * open card does not cover the floor lanes wait at). */
type NothingCause = 'exhausted' | 'accepted' | 'declined' | 'proposed-open';

/** A skip's reason with its volatile details (pids, counts, sizes) left
 * out: a skip is recorded again only when this changes. */
export function skipReasonKind(reason: string): string {
  return reason.replace(/\d+(?:\.\d+)?/gu, '#');
}

export class DiskService {
  readonly budgetBytes: number;
  private readonly log: Log;
  private readonly now: () => number;
  private readonly usage: (path: string) => Promise<WalkUsage>;
  private cache: { readonly usage: DiskUsage; readonly at: number } | null = null;
  private measuring: Promise<DiskUsage> | null = null;
  private walkFailedAt: number | null = null;
  private lastReads: readonly VolumeRead[] | null = null;
  private unsubscribe: (() => void) | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private soon: ReturnType<typeof setTimeout> | null = null;
  private followUp: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private again: string | null = null;
  /** Ends a pass's wait for a usage walk when a lane starts to wait at the floor. */
  private wake: (() => void) | null = null;
  private stopped = false;
  private readonly stopping = new AbortController();
  /** When the last Accept was carried out: no new card for one interval. */
  private acceptedAt: number | null = null;
  /** Events whose time could not be read, warned about once. */
  private readonly unreadable = new Set<number>();
  /** Lanes whose slim can never happen (what their base manifest or the
   * ledger says). */
  private readonly unslimmable = new Set<string>();
  /** Lanes whose release refused, with the job's activity mark and the time. */
  private readonly refused = new Map<string, { readonly mark: number; readonly at: number }>();
  /** The kind of the last skip recorded per step, so a lane that keeps
   * refusing is recorded once per kind of reason, not at every check. */
  private readonly skips = new Map<string, string>();

  constructor(private readonly opts: DiskServiceOptions) {
    if (!Number.isFinite(opts.budgetGb) || opts.budgetGb < 0) throw new Error(`DiskService: budgetGb must be a non-negative number, got ${String(opts.budgetGb)}`);
    this.budgetBytes = Math.round(opts.budgetGb * GIB);
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.usage = opts.usage ?? ((path) => treeUsage(path));
    opts.floor.onBelowFloor(() => { void this.check('floor'); });
    opts.floor.onFloorOff((misfits) => { this.floorFit(misfits); });
  }

  private get floorBytes(): number {
    return this.opts.floor.floorBytes;
  }

  private get enabled(): boolean {
    return this.budgetBytes > 0 || this.floorBytes > 0;
  }

  /** The budget's low-water mark: a reclaim for the budget stops at it. */
  private get lowWaterBytes(): number {
    return Math.floor(this.budgetBytes * BUDGET_LOW_WATER);
  }

  /** Check now, after each lane is created, on the owner's answers, and
   * every five minutes. With the budget and the floor both off, nothing is
   * checked; the view still is. Cards and rows a changed config leaves
   * without a producer are closed first. */
  start(): void {
    if (this.unsubscribe !== null || this.stopped) return;
    this.settleConfigChange();
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

  /** Stop checking, and wait for the pass that is running: it stops before
   * its next step (a slim at its next path). The service's shutdown bounds
   * the wait. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopping.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.interval !== null) (this.opts.clearInterval ?? clearInterval)(this.interval);
    this.interval = null;
    for (const timer of [this.soon, this.followUp]) if (timer !== null) (this.opts.clearTimeout ?? clearTimeout)(timer);
    this.soon = null;
    this.followUp = null;
    this.wake?.();
    this.opts.floor.stop();
    await this.idle();
  }

  /** Settles once the pass running now (and any it asked for) is done. */
  async idle(): Promise<void> {
    while (this.running !== null) await this.running;
  }

  /** One pass (a pass already running takes this request after it; a lane
   * starting to wait at the floor ends that pass's wait for a usage walk).
   * Never rejects. */
  check(trigger: string): Promise<void> {
    if (this.stopped || !this.enabled) return Promise.resolve();
    if (this.running !== null) {
      this.again = trigger;
      if (trigger === 'floor') this.wake?.();
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

  /** Close what a changed config left without a producer (#427 PR 3):
   * with `automatic` mode, or the budget and floor both off, an open
   * reclaim card is withdrawn (answered ones closed, not carried out); with
   * both off, Gru's nothing-to-free row closes; with the floor off, so does
   * the row saying it does not fit the disk. */
  private settleConfigChange(): void {
    try {
      const why = !this.enabled
        ? 'the disk budget and floor are off now ([worktrees] disk_budget_gb = 0, min_free_disk_gb = 0)'
        : this.opts.mode === 'automatic' ? '[worktrees] reclaim_mode is "automatic" now: GC frees space on its own' : null;
      if (why !== null) {
        for (const card of this.opts.ledger.listOpenNotificationsByKinds([DISK_RECLAIM_KIND])) {
          if (card.decidedOption === null) this.opts.ledger.withdrawOwnerProposal(card.id, `${why}; nothing from this card is run`);
          else this.closeCard(card, `${why}; this card's answer is not carried out`);
        }
      }
      if (!this.enabled) {
        for (const row of this.opts.ledger.listOpenNotificationsByKinds([DISK_FULL_KIND])) this.opts.ledger.resolveNotificationById(row.id, 'disk-checks-off');
      }
      if (this.floorBytes === 0) {
        for (const row of this.opts.ledger.listOpenNotificationsByKinds([DISK_FLOOR_OFF_KIND])) this.opts.ledger.resolveNotificationById(row.id, 'disk-floor-off');
      }
    } catch (error) {
      this.log('error', 'the disk rows a config change left could not be closed', { error: oneLine(error) });
    }
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
   * minute old, and not again within a minute of a walk that failed; the
   * walk lands in a later snapshot). */
  boardView(): DiskBoardView {
    const stale = this.cache === null || this.now() - this.cache.at >= DISK_VIEW_MAX_AGE_MS;
    const failedLately = this.walkFailedAt !== null && this.now() - this.walkFailedAt < DISK_VIEW_MAX_AGE_MS;
    if (this.measuring === null && stale && !failedLately) void this.refreshView().catch(() => {});
    const view = this.view(this.cachedUsage());
    const lowest = view.volumes.reduce<DiskVolumeView | null>((low, volume) => (low === null || volume.freeBytes < low.freeBytes ? volume : low), null);
    return {
      usedBytes: view.usage === null ? null : byteCount(view.usage.totalBytes),
      sharedBytes: view.usage === null ? null : byteCount(view.usage.sharedBytes),
      categories: view.usage === null ? null : Object.fromEntries(DISK_CATEGORIES.map((category) => [category, byteCount(view.usage!.categories[category])])) as Record<DiskCategory, number>,
      freeBytes: lowest === null ? null : byteCount(lowest.freeBytes),
      totalBytes: lowest === null ? null : byteCount(lowest.totalBytes),
      volumes: view.volumes.map((volume) => ({ names: volume.names, path: volume.path, freeBytes: byteCount(volume.freeBytes), totalBytes: byteCount(volume.totalBytes), belowFloor: volume.belowFloor })),
      budgetBytes: byteCount(view.budgetBytes),
      floorBytes: byteCount(view.floorBytes),
      reclaimMode: view.reclaimMode,
      overBudget: view.overBudget,
      belowFloor: view.belowFloor,
      queuedLanes: view.floorQueue.length,
      floorQueue: view.floorQueue.map(({ id, label, queuedAt, reason }) => ({ id, label, queuedAt, reason })),
      computedAt: view.usage?.computedAt ?? null,
    };
  }

  private view(usage: DiskUsage | null): DiskView {
    const reads = this.lastReads ?? [];
    const below = new Set(this.opts.floor.belowFloor(reads));
    const misfits = this.opts.floor.misfits(reads);
    return {
      dataDir: this.opts.paths.dataDir,
      usage,
      volumes: reads.flatMap((read) => (read.space === null ? [] : [{
        names: read.names,
        path: read.path,
        ...read.space,
        notGcBytes: usage === null ? null : Math.max(0, read.space.totalBytes - read.space.freeBytes - this.gcBytesOn(read, reads, usage)),
        belowFloor: below.has(read),
      }])),
      unreadable: reads.flatMap((read) => (read.space === null ? [{ names: read.names, path: read.path, error: read.error ?? 'unknown' }] : [])),
      budgetBytes: this.budgetBytes,
      floorBytes: this.floorBytes,
      floorOff: misfits.length === 0 ? null : this.floorOffText(misfits, this.opts.floor.volumes.length),
      reclaimMode: this.opts.mode,
      overBudget: usage !== null && this.budgetBytes > 0 && usage.totalBytes > this.budgetBytes,
      belowFloor: below.size > 0,
      floorQueue: this.opts.floor.view(),
      note: CLONE_NOTE,
    };
  }

  /** GC's usage on one watched disk: each category on the disk of the
   * watched folder it lies in (lanes under the lane root, the rest under
   * data_dir; a preserve root outside both is on neither). */
  private gcBytesOn(read: VolumeRead, reads: readonly VolumeRead[], usage: DiskUsage): number {
    const { paths } = this.opts;
    const on = (path: string): boolean => this.readOf(path, reads) === read;
    let bytes = usage.lanes.reduce((sum, lane) => sum + (on(lane.path) ? lane.bytes : 0), 0);
    const homes: readonly [DiskCategory, string][] = [['reviews', paths.reviews], ['preserves', paths.preserves], ['probes', paths.probes], ['ledger', paths.ledger], ['logs', paths.logs], ['other', paths.dataDir]];
    for (const [category, path] of homes) if (on(path)) bytes += usage.categories[category];
    return bytes;
  }

  /** The watched disk a path lies on: that of the watched folder holding
   * it most closely; null when none holds it. */
  private readOf(path: string, reads: readonly VolumeRead[]): VolumeRead | null {
    let best: VolumeRead | null = null;
    let depth = -1;
    for (const { name, path: root } of this.opts.floor.volumes) {
      const at = resolve(root);
      const target = resolve(path);
      if (target !== at && !inside(at, target)) continue;
      if (at.length <= depth) continue;
      const read = reads.find((entry) => entry.names.includes(name));
      if (read === undefined) continue;
      best = read;
      depth = at.length;
    }
    return best;
  }

  private cachedUsage(): DiskUsage | null {
    return this.cache?.usage ?? null;
  }

  /** The usage, walked at most once a minute. */
  private async measure(): Promise<DiskUsage> {
    if (this.cache !== null && this.now() - this.cache.at < DISK_VIEW_MAX_AGE_MS) return this.cache.usage;
    this.measuring ??= this.walk().then((usage) => {
      this.cache = { usage, at: this.now() };
      this.walkFailedAt = null;
      return usage;
    }, (error: unknown) => {
      this.walkFailedAt = this.now();
      throw error;
    }).finally(() => { this.measuring = null; });
    return this.measuring;
  }

  /** {@link measure}, unless a lane starts to wait at the floor meanwhile:
   * then `'floor'` at once (the walk goes on, and lands in the cache). */
  private async measureUnlessFloor(): Promise<DiskUsage | 'floor'> {
    if (this.cache !== null && this.now() - this.cache.at < DISK_VIEW_MAX_AGE_MS) return this.cache.usage;
    const woken = new Promise<'floor'>((resolveWake) => { this.wake = () => resolveWake('floor'); });
    try {
      return await Promise.race([this.measure(), woken]);
    } finally {
      this.wake = null;
    }
  }

  /** A walk in the background (its failure logged), for a pass that does
   * not wait for one. */
  private walkSoon(): void {
    if (this.measuring !== null || (this.cache !== null && this.now() - this.cache.at < DISK_VIEW_MAX_AGE_MS)) return;
    void this.measure().catch((error: unknown) => { this.log('error', 'the disk usage walk failed', { error: oneLine(error) }); });
  }

  /** The watched disks' free space now. */
  private async space(): Promise<readonly VolumeRead[]> {
    const reads = await this.opts.floor.space();
    for (const read of reads) {
      if (read.space === null) this.log('warn', 'a disk\'s free space cannot be read', { path: read.path, error: read.error });
    }
    this.lastReads = reads;
    return reads;
  }

  private async walk(): Promise<DiskUsage> {
    const { paths } = this.opts;
    const lanes: LaneUsage[] = [];
    for (const lane of this.liveLanes()) {
      const walked = await this.usage(lane.path);
      lanes.push({
        id: lane.id,
        kind: lane.kind,
        jobId: this.jobOf(lane),
        repo: lane.repoName,
        path: lane.path,
        status: lane.status,
        bytes: walked.bytes,
        sharedBytes: walked.sharedBytes,
        slim: this.opts.worktrees.isSlim(lane.id),
      });
    }
    lanes.sort((a, b) => b.bytes - a.bytes || a.id.localeCompare(b.id));
    let sharedBytes = lanes.reduce((sum, lane) => sum + lane.sharedBytes, 0);
    const walkOf = async (path: string): Promise<number> => {
      const walked = await this.usage(path);
      sharedBytes += walked.sharedBytes;
      return walked.bytes;
    };
    const roots = [paths.reviews, paths.preserves, paths.probes, paths.ledger, paths.logs];
    const categories: Record<DiskCategory, number> = {
      lanes: lanes.reduce((sum, lane) => sum + lane.bytes, 0),
      reviews: await walkOf(paths.reviews),
      preserves: await walkOf(paths.preserves),
      probes: await walkOf(paths.probes),
      ledger: await walkOf(paths.ledger),
      logs: await walkOf(paths.logs),
      other: 0,
    };
    const other = await this.usageOutside(resolve(paths.dataDir), [...roots, ...lanes.map((lane) => lane.path)].map((path) => resolve(path)));
    categories.other = other.bytes;
    sharedBytes += other.sharedBytes;
    const totalBytes = DISK_CATEGORIES.reduce((sum, category) => sum + categories[category], 0);
    return { computedAt: new Date(this.now()).toISOString(), totalBytes, sharedBytes, categories, lanes };
  }

  /** What lies under `path` outside every `excluded` path: each child that
   * holds none of them is walked whole, and a child that does is entered.
   * Links are walked as themselves, never followed. */
  private async usageOutside(path: string, excluded: readonly string[]): Promise<WalkUsage> {
    if (excluded.includes(path)) return { bytes: 0, sharedBytes: 0 };
    if (!excluded.some((inner) => inside(path, inner))) return this.usage(path);
    let names: string[];
    try {
      if (!(await lstat(path)).isDirectory()) return this.usage(path);
      names = await readdir(path);
    } catch {
      return { bytes: 0, sharedBytes: 0 };
    }
    let bytes = 0;
    let sharedBytes = 0;
    for (const name of names) {
      const walked = await this.usageOutside(join(path, name), excluded);
      bytes += walked.bytes;
      sharedBytes += walked.sharedBytes;
    }
    return { bytes, sharedBytes };
  }

  // ------------------------------------------------------------------
  // The check
  // ------------------------------------------------------------------

  private passContext(): PassContext {
    return { lanes: this.liveLanes(), listing: null, reviews: null, releases: 0, deferred: 0 };
  }

  /** The live lanes: active and paused (never the swept history). */
  private liveLanes(): readonly WorktreeRecord[] {
    return [...this.opts.worktrees.listWorktrees({ status: 'active' }), ...this.opts.worktrees.listWorktrees({ status: 'paused' })];
  }

  /** Forget what is remembered of lanes that are gone. */
  private prune(ctx: PassContext): void {
    const live = new Set(ctx.lanes.map((lane) => lane.id));
    for (const id of [...this.unslimmable]) if (!live.has(id)) this.unslimmable.delete(id);
    for (const id of [...this.refused.keys()]) if (!live.has(id)) this.refused.delete(id);
    for (const key of [...this.skips.keys()]) {
      const [step, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      if (step !== 'expire-reviews' && !live.has(id)) this.skips.delete(key);
    }
  }

  private async pass(trigger: string): Promise<void> {
    const ctx = this.passContext();
    this.prune(ctx);
    // An Accept carried out is this pass's work: no new card until one
    // interval has passed (P2).
    if (this.opts.mode === 'proposed' && await this.followCards(ctx)) return;
    if (this.stopped) return;
    let reads = await this.space();
    let under = this.opts.floor.belowFloor(reads).length > 0;
    // The floor never waits for a walk: under it, the cached usage (if
    // any) serves, and a walk runs in the background.
    let usage: DiskUsage | null;
    if (under) {
      usage = this.cachedUsage();
    } else {
      const measured = await this.measureUnlessFloor();
      if (measured === 'floor') {
        reads = await this.space();
        under = this.opts.floor.belowFloor(reads).length > 0;
        usage = this.cachedUsage();
      } else {
        usage = measured;
      }
    }
    if (this.stopped) return;
    if (under) this.walkSoon();
    const over = usage !== null && this.budgetBytes > 0 && usage.totalBytes > this.budgetBytes;
    if (!over && !under) {
      this.conditionCleared();
      return;
    }
    if (this.opts.mode === 'proposed') {
      await this.propose(usage, reads, ctx);
      return;
    }
    const steps = await this.plan(usage, reads, { estimate: false }, ctx);
    if (steps.length > 0) this.opts.floor.setReclaimState('freeing');
    const result = await this.execute(steps, usage?.totalBytes ?? null, over ? this.lowWaterBytes : null, trigger, ctx);
    if (this.stopped) return;
    if (result.satisfied) {
      this.opts.floor.setReclaimState('checking');
      return;
    }
    if (ctx.deferred > 0) {
      // Releases are left for the next pass: it comes soon, and something
      // can still be freed.
      this.followUpSoon();
      return;
    }
    await this.nothingToFree(result.skipped, 'exhausted');
  }

  private followUpSoon(): void {
    if (this.followUp !== null || this.stopped) return;
    this.followUp = (this.opts.setTimeout ?? setTimeout)(() => {
      this.followUp = null;
      void this.check('more-releases');
    }, DISK_FOLLOW_UP_MS);
    this.followUp.unref?.();
  }

  /** Whether usage is at or under `budgetTarget` (null: the budget is not
   * a reason) and every watched disk at or above the floor (a free space
   * that cannot be read is not waited for). */
  private async satisfied(usageBytes: number | null, budgetTarget: number | null): Promise<boolean> {
    if (budgetTarget !== null && usageBytes !== null && usageBytes > budgetTarget) return false;
    if (this.floorBytes === 0) return true;
    return this.opts.floor.belowFloor(await this.space()).length === 0;
  }

  /** How much the steps must free: down to the low-water mark when over
   * the budget, and up to the floor on the lowest disk. */
  private need(usage: DiskUsage | null, reads: readonly VolumeRead[]): number {
    const budget = usage !== null && this.budgetBytes > 0 && usage.totalBytes > this.budgetBytes ? usage.totalBytes - this.lowWaterBytes : 0;
    const floor = Math.max(0, ...this.opts.floor.belowFloor(reads).map((read) => this.floorBytes - read.space!.freeBytes));
    return Math.max(budget, floor);
  }

  /**
   * The lossless steps, in order: release the lanes of finished jobs
   * (largest first; one whose release refused lately is not asked again),
   * delete the review folders of finished jobs, slim idle lanes (oldest
   * idle first). With `estimate`, each step carries what it would free, a
   * lane GC knows it cannot release or slim is left out, at most
   * {@link MAX_RELEASES_PER_PASS} releases are listed, and the plan stops
   * once the estimates reach the low-water mark and the floor (a card lists
   * that much); without, every candidate is listed, and the run stops on
   * what was really freed.
   */
  private async plan(usage: DiskUsage | null, reads: readonly VolumeRead[], opts: { readonly estimate: boolean }, ctx: PassContext): Promise<readonly ReclaimStep[]> {
    const need = this.need(usage, reads);
    let estimated = 0;
    const enough = (): boolean => opts.estimate && estimated >= need;
    const steps: ReclaimStep[] = [];
    let releases = 0;
    for (const lane of this.terminalLanes(ctx)) {
      if (enough()) break;
      if (this.refusedLately(lane) !== null) continue;
      if (opts.estimate) {
        if ((this.whyNotReleasable(lane) ?? await this.whyProcesses(lane, ctx)) !== null) continue;
        if (releases >= MAX_RELEASES_PER_PASS) {
          ctx.deferred += 1;
          continue;
        }
      }
      const jobId = this.jobOf(lane)!;
      const bytes = await this.laneBytes(lane);
      estimated += bytes;
      releases += 1;
      steps.push({ step: 'release', lane: lane.id, jobId, bytes: opts.estimate ? bytes : null, detail: `Release lane ${lane.id} (${lane.kind} lane of job ${jobId}, ${this.jobStatus(jobId)}, in ${lane.repoName})` });
    }
    for (const found of this.reviewsOf(ctx)) {
      if (enough()) break;
      if (this.whyReviewsBusy(found.jobId) !== null) continue;
      let bytes: number | null = null;
      if (opts.estimate) {
        bytes = 0;
        for (const path of found.paths) bytes += (await this.usage(path)).bytes;
        estimated += bytes;
      }
      const count = found.rounds.length + found.fallbackGates.length;
      steps.push({
        step: 'expire-reviews',
        jobId: found.jobId,
        rounds: found.rounds,
        fallbackGates: found.fallbackGates,
        bytes,
        detail: `Delete the ${String(count)} review folder${count === 1 ? '' : 's'} of job ${found.jobId} (${this.jobStatus(found.jobId)}): ${[...found.rounds, ...found.fallbackGates].join(', ')}`,
      });
    }
    // A lane listed for release is not slimmed as well.
    const released = new Set(steps.flatMap((step) => (step.step === 'release' ? [step.lane] : [])));
    for (const { lane, idleSince } of this.idleLanes(ctx)) {
      if (enough()) break;
      if (released.has(lane.id)) continue;
      const jobId = lane.jobId!;
      const since = idleSince === null ? 'no recorded activity' : `idle since ${new Date(idleSince).toISOString()}`;
      let bytes: number | null = null;
      let entries: readonly string[] | null = null;
      if (opts.estimate) {
        const estimate = await this.slimEstimate(lane);
        if (estimate === null || (await this.whyProcesses(lane, ctx)) !== null) continue;
        bytes = estimate.bytes;
        entries = estimate.entries;
        estimated += bytes;
      }
      const listed = entries === null ? '' : ` (${entries.join(', ')})`;
      steps.push({ step: 'slim', lane: lane.id, jobId, entries, bytes, detail: `Slim lane ${lane.id}${listed} (job ${jobId}, ${this.jobStatus(jobId)}, ${since})` });
    }
    return steps;
  }

  /** Run steps in order until satisfied, recording each (releases past
   * {@link MAX_RELEASES_PER_PASS} are left for the next pass). A reclaim
   * that freed space drops the cached walk. */
  private async execute(steps: readonly ReclaimStep[], usageBytes: number | null, budgetTarget: number | null, trigger: string, ctx: PassContext): Promise<{ readonly freedBytes: number; readonly satisfied: boolean; readonly skipped: readonly StepOutcome[] }> {
    let freed = 0;
    const skipped: StepOutcome[] = [];
    let ran = 0;
    let recorded = 0;
    for (const step of steps) {
      if (this.stopped) break;
      if (await this.satisfied(usageBytes === null ? null : usageBytes - freed, budgetTarget)) break;
      if (step.step === 'release' && ctx.releases >= MAX_RELEASES_PER_PASS) {
        ctx.deferred += 1;
        continue;
      }
      const outcome = await this.runStep(step, ctx);
      // A step the stop cut short is not a skip worth recording.
      if (this.stopped && outcome.outcome === 'skipped') break;
      ran += 1;
      freed += outcome.freedBytes;
      if (outcome.outcome === 'skipped') skipped.push(outcome);
      if (this.recordStep(outcome, trigger)) recorded += 1;
      this.opts.floor.recheck();
    }
    const satisfied = await this.satisfied(usageBytes === null ? null : usageBytes - freed, budgetTarget);
    if (freed > 0) this.cache = null;
    if (recorded > 0) {
      const free = (this.lastReads ?? []).flatMap((read) => (read.space === null ? [] : [read.space.freeBytes]));
      this.appendEvent(DISK_EVENTS.pass, null, {
        trigger,
        mode: this.opts.mode,
        usage_bytes: usageBytes,
        freed_bytes: freed,
        budget_bytes: this.budgetBytes,
        floor_bytes: this.floorBytes,
        free_bytes: free.length === 0 ? null : Math.min(...free),
        satisfied,
        steps: ran,
        skipped: skipped.length,
        deferred: ctx.deferred,
      });
      this.log('info', 'disk reclaim pass', { trigger, freed_bytes: freed, steps: ran, skipped: skipped.length, deferred: ctx.deferred, satisfied });
    }
    return { freedBytes: freed, satisfied, skipped };
  }

  /** Record a step: every one done, and a skip once per kind of reason
   * ({@link skipReasonKind}: a respawning watcher's new pid is not news). */
  private recordStep(outcome: StepOutcome, trigger: string): boolean {
    const { step } = outcome;
    const key = `${step.step}:${step.step === 'expire-reviews' ? step.jobId : step.lane}`;
    if (outcome.outcome === 'skipped') {
      const kind = skipReasonKind(outcome.reason ?? '');
      if (this.skips.get(key) === kind) return false;
      this.skips.set(key, kind);
    } else {
      this.skips.delete(key);
    }
    this.appendEvent(DISK_EVENTS.step, step.jobId, {
      step: step.step,
      ...(step.step === 'expire-reviews' ? { rounds: step.rounds, fallback_gates: step.fallbackGates } : { lane: step.lane }),
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

  private async runStep(step: ReclaimStep, ctx: PassContext): Promise<StepOutcome> {
    const skip = (reason: string): StepOutcome => ({ step, outcome: 'skipped', freedBytes: 0, reason });
    const done = (freedBytes: number): StepOutcome => ({ step, outcome: 'done', freedBytes, reason: null });
    try {
      if (step.step === 'release') {
        const lane = this.opts.ledger.getWorktree(step.lane);
        if (lane === null || lane.status === 'swept') return skip('the lane is gone');
        const refused = this.refusedLately(lane);
        if (refused !== null) return skip(refused);
        const why = this.whyNotReleasable(lane) ?? await this.whyProcesses(lane, ctx);
        if (why !== null) return skip(why);
        const before = await this.laneBytes(lane);
        if (this.stopped) return skip('the service is stopping');
        ctx.releases += 1;
        // Unattended, as the autopilot's release: fresh containment proven
        // first, off the event loop (origin not answering within the fetch
        // bound refuses it), the lane's work snapshotted before its removal,
        // which runs off the event loop, nothing asked of origin after it
        // (the branch is kept), and a process that appeared since the
        // listing, or a listing that could not read working directories,
        // refuses it (no pause, no card, nothing killed).
        let result: Awaited<ReturnType<WorktreeManager['release']>>;
        try {
          result = await this.opts.worktrees.release({ worktreeId: lane.id, requireReleaseProofs: true, onLiveProcess: 'refuse', diskBudget: true });
        } catch (error) {
          this.rememberRefusal(lane);
          return skip(`the release refused: ${oneLine(error)}`);
        }
        if (result.status !== 'swept') {
          this.rememberRefusal(lane);
          return skip(`the release paused: ${result.note}`);
        }
        this.refused.delete(lane.id);
        const copied = result.preserved === null ? 0 : (await this.usage(result.preserved.destination)).bytes;
        return done(Math.max(0, before - copied));
      }
      if (step.step === 'expire-reviews') {
        const busy = this.whyReviewsBusy(step.jobId);
        if (busy !== null) return skip(busy);
        const listed = [
          ...step.rounds.map((name) => ({ name, path: join(this.opts.paths.reviews, name), gate: false })),
          ...step.fallbackGates.map((name) => ({ name, path: join(this.opts.paths.reviews, 'fallback-gate', name), gate: true })),
        ];
        if (listed.length === 0) return skip('the step lists no review folders');
        const sizes = new Map<string, number>();
        for (const { path } of listed) sizes.set(path, (await this.usage(path)).bytes);
        // Exactly the listed folders, each checked again (P1).
        const expired = await this.opts.expiry.expireJobReviews({ jobId: step.jobId, rounds: step.rounds, fallbackGates: step.fallbackGates }, { olderThanMs: 0 });
        if (expired === null) return skip('none of the listed review folders could be deleted (gone, no longer the job\'s, or the job is not finished)');
        // Before less after: a round keeps its consolidated.json (#427 PR 2b).
        let freed = 0;
        for (const { name, path, gate } of listed) {
          if (!(gate ? expired.fallbackGates : expired.rounds).includes(name)) continue;
          freed += Math.max(0, (sizes.get(path) ?? 0) - (await this.usage(path)).bytes);
        }
        return done(freed);
      }
      const lane = this.opts.ledger.getWorktree(step.lane);
      if (lane === null || lane.status !== 'active') return skip('the lane is gone or not active');
      const before = await this.laneBytes(lane);
      if (this.stopped) return skip('the service is stopping');
      // A card's step slims only the entries it listed (an entry built since is kept).
      const result = await this.opts.worktrees.slim({ worktreeId: lane.id, idle: () => this.whyNotIdle(step.jobId), signal: this.stopping.signal, ...(step.entries === null ? {} : { only: step.entries }) });
      if (result.status === 'not-slimmed') {
        if (result.permanent) this.unslimmable.add(lane.id);
        return skip(result.reason);
      }
      const after = (await this.usage(lane.path)).bytes;
      return done(Math.max(0, before - after));
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
    return cached?.bytes ?? (await this.usage(lane.path)).bytes;
  }

  /** Live lanes of finished jobs, largest first. */
  private terminalLanes(ctx: PassContext): readonly WorktreeRecord[] {
    const sizes = new Map(this.cache?.usage.lanes.map((lane) => [lane.id, lane.bytes]) ?? []);
    return ctx.lanes
      .filter((lane) => {
        const jobId = this.jobOf(lane);
        const job = jobId === null ? null : this.opts.ledger.getJob(jobId);
        return job !== null && isJobTerminal(job.status);
      })
      .sort((a, b) => (sizes.get(b.id) ?? 0) - (sizes.get(a.id) ?? 0) || a.id.localeCompare(b.id));
  }

  /** When the job's newest status change made it terminal, or null when
   * it is open or the time cannot be read. */
  private terminalSince(job: JobRecord): number | null {
    if (!isJobTerminal(job.status)) return null;
    const event = this.opts.ledger.listJobEventsByKinds(job.id, ['job.status'], { limit: 1 })[0];
    if (event === undefined || (event.payload as { readonly to?: unknown } | null)?.to !== job.status) return null;
    const at = Date.parse(event.ts);
    return Number.isNaN(at) ? null : at;
  }

  /** Why GC will not release a finished job's lane now, or null: it is
   * released only once it has settled (R1). */
  private whyNotReleasable(lane: WorktreeRecord): string | null {
    if (lane.status === 'paused') return 'its release is paused on live processes, waiting for an answer';
    const jobId = this.jobOf(lane);
    const job = jobId === null ? null : this.opts.ledger.getJob(jobId);
    if (jobId === null || job === null) return 'the lane\'s job is not in the ledger';
    if (!isJobTerminal(job.status)) return `the job is ${job.status}, not finished`;
    const since = this.terminalSince(job);
    if (since === null) return 'when the job ended cannot be read';
    if (this.now() - since < RELEASE_MIN_TERMINAL_MS) return `the job ended less than ${String(RELEASE_MIN_TERMINAL_MS / 60_000)} minutes ago`;
    const outstanding = this.opts.ledger.listChildWorkers({ jobId }).filter((child) => child.resultState === null).length;
    if (outstanding > 0) return `the job has ${String(outstanding)} child worker(s) that have not finished`;
    const rounds = this.opts.ledger.listRounds(jobId).filter((round) => round.status === 'pending' || round.status === 'live');
    if (rounds.length > 0) return `the job has ${String(rounds.length)} review round(s) pending or live`;
    if (this.opts.ledger.hasUnsettledVerificationRun(jobId)) return 'a verification run of the job has not settled';
    const covering = this.opts.ledger.coveringDecision({ subject: `job:${jobId}`, signal: 'sweep-ack', basis: `status:${job.status}` });
    if (covering !== null) return `an active decision (${covering.id}) holds the job's lane release`;
    return null;
  }

  /** A lane whose release refused, not asked again until its job has news
   * or {@link RELEASE_RETRY_MS} has passed: why, or null. */
  private refusedLately(lane: WorktreeRecord): string | null {
    const refused = this.refused.get(lane.id);
    if (refused === undefined) return null;
    const jobId = this.jobOf(lane);
    if ((jobId === null ? 0 : this.activityMark(jobId)) !== refused.mark || this.now() - refused.at >= RELEASE_RETRY_MS) {
      this.refused.delete(lane.id);
      return null;
    }
    return `its release refused at ${new Date(refused.at).toISOString()}; GC asks again once the job has news, or after an hour`;
  }

  private rememberRefusal(lane: WorktreeRecord): void {
    const jobId = this.jobOf(lane);
    this.refused.set(lane.id, { mark: jobId === null ? 0 : this.activityMark(jobId), at: this.now() });
  }

  /** The seq of the job's newest event that could change a refused answer. */
  private activityMark(jobId: string): number {
    return this.opts.ledger.listJobEventsByKinds(jobId, ANSWER_KINDS, { limit: 1 })[0]?.seq ?? 0;
  }

  /** The finished jobs' review folders, listed once per pass. */
  private reviewsOf(ctx: PassContext): readonly ExpirableReviews[] {
    ctx.reviews ??= this.opts.expiry.expirableReviews({ olderThanMs: 0 });
    return ctx.reviews;
  }

  /** Why a finished job's review folders are not deleted now, or null: a
   * review round of it still pending or live (R2), or a Perkins review that
   * owns the job (a fallback gate running, a setup in progress, a superseded
   * round not proven stopped). */
  private whyReviewsBusy(jobId: string): string | null {
    const rounds = this.opts.ledger.listRounds(jobId).filter((round) => round.status === 'pending' || round.status === 'live');
    if (rounds.length > 0) return `the job has ${String(rounds.length)} review round(s) pending or live`;
    return this.opts.expiry.reviewsInUse(jobId);
  }

  /** Processes rooted in the lane, by the pass's one listing (nothing is
   * ever killed), or null. */
  private async whyProcesses(lane: WorktreeRecord, ctx: PassContext): Promise<string | null> {
    ctx.listing ??= (this.opts.listProcesses ?? (() => processListingAsync({
      onCwdError: (error) => this.log('warn', 'process working directories could not be listed; argv matches still count', { error: oneLine(error) }),
    })))().then(
      (rootedIn) => ({ rootedIn, error: null }),
      (error: unknown) => ({ rootedIn: null, error: oneLine(error) }),
    );
    const listing = await ctx.listing;
    if (listing.rootedIn === null) return `the processes rooted in the lane could not be listed: ${listing.error ?? 'unknown'}`;
    const rooted = listing.rootedIn(lane.path);
    return rooted.length === 0 ? null : `${String(rooted.length)} process(es) rooted in the lane (pids ${rooted.map((proc) => proc.pid).join(', ')})`;
  }

  /** Active job and writer-child lanes, not slim, whose job is idle, oldest
   * idle first. */
  private idleLanes(ctx: PassContext): readonly { readonly lane: WorktreeRecord; readonly idleSince: number | null }[] {
    const idle: { lane: WorktreeRecord; idleSince: number | null }[] = [];
    for (const lane of ctx.lanes) {
      if (lane.status !== 'active' || lane.jobId === null || !(lane.kind === 'job' || (lane.kind === 'child' && lane.branch !== null))) continue;
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
   * status is not working, with no turn, verification, provider wait, live
   * directive or unfinished child worker, its last activity (a turn's end,
   * a delivery, a restore of its lanes, a verification's end) at least
   * {@link SLIM_MIN_IDLE_MS} old. */
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
    const children = this.opts.ledger.listChildWorkers({ jobId }).filter((child) => child.resultState === null).length;
    if (children > 0) return `the job has ${String(children)} child worker(s) that have not finished`;
    const at = this.lastActivity(jobId);
    if (at === null) return null;
    if (Number.isNaN(at)) return 'the job\'s last activity has a timestamp that cannot be read';
    if (this.now() - at < SLIM_MIN_IDLE_MS) return `the job's last activity was less than ${String(SLIM_MIN_IDLE_MS / 60_000)} minutes ago`;
    return null;
  }

  /** What a slim of the lane would delete: the existing reclaim entries of
   * the manifest committed at its base, sized, less those a `[[link]]` or
   * `[[copy]]` destination lies at or under; null when `slim()` would
   * refuse the lane for good (no manifest, no reclaim or setup, no
   * bootstrap record, an incomplete restore) or nothing would be freed. */
  private async slimEstimate(lane: WorktreeRecord): Promise<{ readonly bytes: number; readonly entries: readonly string[] } | null> {
    if (this.opts.worktrees.slimRecordRefusal(lane.id) !== null) {
      this.unslimmable.add(lane.id);
      return null;
    }
    let manifest;
    try {
      manifest = parseWorktreeManifest(await gitShow(lane.path, `${lane.sha}:${MANIFEST_PATH.split('\\').join('/')}`));
    } catch {
      return null;
    }
    if (manifest.reclaim === undefined || manifest.reclaim.length === 0 || manifest.setup.length === 0) return null;
    const placed = [...manifest.links.map((link) => link.at), ...manifest.copies.map((copy) => copy.to)].map(normalizedManifestPath);
    let bytes = 0;
    const entries: string[] = [];
    for (const entry of manifest.reclaim) {
      if (placed.some((path) => path === entry || path.startsWith(`${entry}/`))) continue;
      if ((await reclaimState(lane.path, entry).catch(() => 'absent' as const)) !== 'present') continue;
      bytes += (await this.usage(join(lane.path, entry))).bytes;
      entries.push(entry);
    }
    return bytes > 0 ? { bytes, entries } : null;
  }

  // ------------------------------------------------------------------
  // Proposed mode
  // ------------------------------------------------------------------

  /** One card at a time; none within one interval of an Accept carried
   * out; none while a Decline holds (but Gru is told when lanes wait at the
   * floor meanwhile, and when they wait while the open card was posted for
   * the budget alone). */
  private async propose(usage: DiskUsage | null, reads: readonly VolumeRead[], ctx: PassContext): Promise<void> {
    const open = this.opts.ledger.listOpenNotificationsByKinds([DISK_RECLAIM_KIND]);
    if (open.length > 0) {
      this.opts.floor.setReclaimState('proposed');
      // A card posted before the disk fell below the floor says nothing of
      // it: lanes waiting there are never held silently.
      if (this.opts.floor.belowFloor(reads).length > 0 && this.opts.floor.view().length > 0 && !open.some((card) => this.coversFloor(card.id))) {
        await this.nothingToFree([], 'proposed-open');
      }
      return;
    }
    if (this.acceptedAt !== null && this.now() - this.acceptedAt < DISK_RECONCILE_INTERVAL_MS) return;
    if (this.declineHolds(usage)) {
      if (this.opts.floor.view().length > 0) await this.nothingToFree([], 'declined');
      return;
    }
    const steps = await this.plan(usage, reads, { estimate: true }, ctx);
    if (this.stopped) return;
    if (steps.length === 0) {
      await this.nothingToFree([], 'exhausted');
      return;
    }
    const last = this.latest(DISK_EVENTS.proposed);
    const proposal = Number((last?.payload as { readonly proposal?: unknown } | undefined)?.proposal ?? 0) + 1;
    const id = `disk-reclaim:${String(proposal)}`;
    this.appendEventStrict(DISK_EVENTS.proposed, {
      notification_id: id,
      proposal,
      usage_bytes: usage?.totalBytes ?? null,
      budget_bytes: this.budgetBytes,
      free_bytes: reads.some((read) => read.space !== null) ? Math.min(...reads.flatMap((read) => (read.space === null ? [] : [read.space.freeBytes]))) : null,
      floor_bytes: this.floorBytes,
      below_floor: this.opts.floor.belowFloor(reads).length > 0,
      steps,
    });
    this.opts.notifications.post(this.card(id, usage, reads, steps));
    this.opts.floor.setReclaimState('proposed');
    // Something can be freed again: Gru's row saying nothing could is done.
    for (const row of this.opts.ledger.listOpenNotificationsByKinds([DISK_FULL_KIND])) this.opts.ledger.resolveNotificationById(row.id, 'disk-reclaim-proposed');
  }

  private appendEventStrict(kind: string, payload: Record<string, unknown>): void {
    this.opts.ledger.appendCustomEvent({ kind, payload });
  }

  /** Whether the owner's last Decline still holds: GC's usage has not grown
   * by {@link DECLINE_REGROWTH} of the budget past its usage at the
   * Decline, and the condition has not cleared in between. An unknown
   * usage holds. */
  private declineHolds(usage: DiskUsage | null): boolean {
    const declined = this.latest(DISK_EVENTS.declined);
    if (declined === null) return false;
    const ended = this.latest(DISK_EVENTS.holdEnded);
    if (ended !== null && ended.seq > declined.seq) return false;
    const at = Number((declined.payload as { readonly usage_bytes?: unknown } | null)?.usage_bytes);
    if (!Number.isFinite(at)) return false;
    return usage === null || usage.totalBytes < at + this.regrowth();
  }

  private regrowth(): number {
    return Math.round(DECLINE_REGROWTH * (this.budgetBytes > 0 ? this.budgetBytes : this.floorBytes));
  }

  private latest(kind: string): EventRecord | null {
    return this.opts.ledger.listEventsAfter(0, { kinds: [kind], order: 'desc', limit: 1 })[0] ?? null;
  }

  /** Carry out the answered cards: Accept runs exactly the listed steps
   * (stopping once satisfied), and an Accept that leaves GC over its
   * budget or under the floor tells Gru; Decline is recorded from GC's
   * usage now, and holds. True when an Accept was carried out. */
  private async followCards(ctx: PassContext): Promise<boolean> {
    let accepted = false;
    for (const card of this.opts.ledger.listOpenNotificationsByKinds([DISK_RECLAIM_KIND])) {
      if (this.stopped) return accepted;
      if (card.decidedOption === null) continue;
      // Gru's row posted while this card was open spoke of it waiting; what
      // the answer leaves is told afresh.
      for (const row of this.opts.ledger.listOpenNotificationsByKinds([DISK_FULL_KIND])) this.opts.ledger.resolveNotificationById(row.id, 'disk-reclaim-answered');
      const proposal = this.proposal(card.id);
      if (proposal === null) {
        this.closeCard(card, 'nothing done: GC has no record of what this card listed');
        continue;
      }
      if (card.decidedOption !== 'accept') {
        const now = await this.measure().catch(() => null);
        this.appendEventStrict(DISK_EVENTS.declined, { notification_id: card.id, usage_bytes: now?.totalBytes ?? proposal.usageBytes, by: card.decidedBy ?? 'the owner', decided_at: card.decidedAt });
        this.closeCard(card, `nothing freed; GC asks again once its usage grows by another ${diskSize(this.regrowth())}`);
        continue;
      }
      const usage = this.cachedUsage() ?? await this.measure().catch(() => null);
      this.opts.floor.setReclaimState('freeing');
      const result = await this.execute(proposal.steps, usage?.totalBytes ?? null, this.budgetBytes > 0 ? this.lowWaterBytes : null, 'accepted', ctx);
      if (this.stopped) return true;
      this.closeCard(card, `ran the listed steps until GC was at most ${String(BUDGET_LOW_WATER * 100)}% of its budget and the disk at or above the floor, or the list ended: freed about ${diskSize(result.freedBytes)}` +
        (result.skipped.length === 0 ? '' : `; skipped ${result.skipped.map((outcome) => `${outcome.step.detail} (${outcome.reason ?? 'skipped'})`).join('; ')}`));
      this.acceptedAt = this.now();
      accepted = true;
      if (result.satisfied) this.opts.floor.setReclaimState('checking');
      else await this.nothingToFree(result.skipped, 'accepted');
    }
    return accepted;
  }

  private proposal(notificationId: string): Proposal | null {
    const event = this.opts.ledger.latestEventByPayloadField(DISK_EVENTS.proposed, 'notification_id', notificationId);
    const payload = (event?.payload ?? null) as Record<string, unknown> | null;
    if (payload === null || !Array.isArray(payload['steps'])) return null;
    // What a recorded step does not list is not run: no review folder, no
    // reclaim entry.
    const steps = (payload['steps'] as ReclaimStep[]).map((step): ReclaimStep => {
      if (step.step === 'expire-reviews') return { ...step, rounds: Array.isArray(step.rounds) ? step.rounds : [], fallbackGates: Array.isArray(step.fallbackGates) ? step.fallbackGates : [] };
      if (step.step === 'slim') return { ...step, entries: Array.isArray(step.entries) ? step.entries : [] };
      return step;
    });
    return { usageBytes: typeof payload['usage_bytes'] === 'number' ? payload['usage_bytes'] : Number.NaN, steps };
  }

  /** Whether the card was posted while a disk was below the floor, so its
   * steps were planned for the floor too. */
  private coversFloor(notificationId: string): boolean {
    const event = this.opts.ledger.latestEventByPayloadField(DISK_EVENTS.proposed, 'notification_id', notificationId);
    return (event?.payload as { readonly below_floor?: unknown } | null | undefined)?.below_floor === true;
  }

  private closeCard(card: NotificationRecord, detail: string): void {
    try {
      this.opts.ledger.resolveOwnerDecision(card.id, detail, OWNER_PROVENANCE);
    } catch (error) {
      if (!(error instanceof NotificationDecisionRefusal)) throw error;
      this.log('warn', 'a disk reclaim card could not be closed', { notification: card.id, error: error.message });
    }
  }

  private card(id: string, usage: DiskUsage | null, reads: readonly VolumeRead[], steps: readonly ReclaimStep[]): {
    readonly id: string;
    readonly kind: typeof DISK_RECLAIM_KIND;
    readonly routing: 'needs-owner';
    readonly severity: 'info';
    readonly title: string;
    readonly detail: string;
    readonly decision: NotificationDecision;
  } {
    const total = steps.reduce((sum, step) => sum + (step.bytes ?? 0), 0);
    const condition = this.conditionText(usage, reads);
    const lines = [
      condition,
      '',
      `[worktrees] reclaim_mode = "proposed": GC frees nothing until you Accept. Every step is lossless (about ${diskSize(total)} in all):`,
      ...steps.map((step, index) => `${String(index + 1)}. ${step.detail}: about ${diskSize(step.bytes ?? 0)}. ${STEP_PROMISE[step.step]}`),
      '',
      `Accept runs exactly these steps, in this order, and stops once GC is at most ${String(BUDGET_LOW_WATER * 100)}% of its budget and the disk at or above the floor; a step whose lane is in use by then is skipped, and a review folder no longer the finished job's is kept.`,
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

  /** Over budget, under the floor, or both, in numbers (a free space
   * rounded down). */
  private conditionText(usage: DiskUsage | null, reads: readonly VolumeRead[]): string {
    const parts: string[] = [];
    if (usage !== null && this.budgetBytes > 0 && usage.totalBytes > this.budgetBytes) {
      parts.push(`GC uses ${diskSize(usage.totalBytes)} under ${this.opts.paths.dataDir}, over its ${diskSize(this.budgetBytes)} budget ([worktrees] disk_budget_gb).`);
    }
    for (const read of this.opts.floor.belowFloor(reads)) {
      parts.push(`${capitalized(diskName(read, reads.length))} has ${diskSizeDown(read.space!.freeBytes)} free, below the ${diskSize(this.floorBytes)} floor ([worktrees] min_free_disk_gb); new job and writer-child lanes wait.`);
    }
    return parts.join(' ');
  }

  // ------------------------------------------------------------------
  // Nothing to free, the floor's fit, and the condition clearing
  // ------------------------------------------------------------------

  /** One action-required row for Gru, naming the cause with numbers; the
   * floor queue's notes say Gru has been told (or, while the open card
   * waits, that it waits for the owner). */
  private async nothingToFree(skipped: readonly StepOutcome[], cause: NothingCause): Promise<void> {
    this.opts.floor.setReclaimState(cause === 'proposed-open' ? 'proposed' : 'nothing');
    if (this.opts.ledger.listOpenNotificationsByKinds([DISK_FULL_KIND]).length > 0) return;
    // Fresh numbers: a reclaim this pass dropped the cached walk.
    const usage = this.cachedUsage() ?? await this.measure().catch(() => null);
    if (this.stopped) return;
    const reads = this.lastReads ?? [];
    const condition = this.conditionText(usage, reads);
    if (condition === '') return;
    const lanes = usage?.lanes.slice(0, 5) ?? [];
    const watched = reads.filter((read) => read.space !== null);
    const lines = [
      condition,
      usage === null
        ? 'GC\'s usage could not be walked, so its categories are unknown.'
        : `GC's usage by category: ${DISK_CATEGORIES.map((category) => `${CATEGORY_NAMES[category]} ${diskSize(usage.categories[category])}`).join(', ')}` +
          `${usage.sharedBytes > 0 ? `; files also hard-linked from outside their walk, not counted: ${diskSize(usage.sharedBytes)}` : ''}.`,
      usage === null ? '' : lanes.length === 0
        ? 'GC has no live lanes.'
        : `Largest live lanes: ${lanes.map((lane) => `${lane.id} (${lane.kind}, job ${lane.jobId ?? 'none'}, ${lane.repo}${lane.slim ? ', slim' : ''}) ${diskSize(lane.bytes)}`).join('; ')}.`,
      watched.length === 0
        ? 'The disk\'s free space cannot be read, so how much of it is not GC\'s is unknown.'
        : watched.map((read) => `${capitalized(watched.length > 1 ? `on ${diskName(read, watched.length)}` : 'on the disk')}, things that are not GC's use ${usage === null ? 'an unknown amount' : diskSize(Math.max(0, read.space!.totalBytes - read.space!.freeBytes - this.gcBytesOn(read, reads, usage)))} (${diskSize(read.space!.totalBytes)} in all, ${diskSizeDown(read.space!.freeBytes)} free).`).join(' '),
      NOTHING_CAUSE[cause],
      ...(skipped.length === 0 ? [] : [`Skipped this time: ${skipped.slice(0, 5).map((outcome) => `${outcome.step.detail} (${outcome.reason ?? 'skipped'})`).join('; ')}.`]),
      'The budget never stops a heist. This row closes itself once GC is under its budget and the disk at or above the floor.',
    ].filter((line) => line !== '');
    const below = this.opts.floor.belowFloor(reads).length > 0;
    this.opts.notifications.post({
      kind: DISK_FULL_KIND,
      routing: 'action-required',
      severity: 'error',
      title: cause === 'proposed-open'
        ? 'Disk below the floor, and the open reclaim card does not cover it'
        : below ? 'Disk below the floor, and nothing GC can free' : 'GC over its disk budget, and nothing it can free',
      detail: lines.join('\n'),
    });
    this.log('warn', 'over the disk budget or below the floor with nothing to free; Gru is told', { usage_bytes: usage?.totalBytes ?? null, cause });
  }

  /** The floor stopped or started fitting the watched disks: one row for
   * Gru while it does not (the floor is treated as off), closed once it
   * does. */
  private floorFit(misfits: readonly VolumeRead[]): void {
    try {
      const open = this.opts.ledger.listOpenNotificationsByKinds([DISK_FLOOR_OFF_KIND]);
      if (misfits.length === 0) {
        for (const row of open) this.opts.ledger.resolveNotificationById(row.id, 'disk-floor-fits');
        return;
      }
      if (open.length > 0) return;
      this.opts.notifications.post({
        kind: DISK_FLOOR_OFF_KIND,
        routing: 'action-required',
        severity: 'error',
        title: 'The disk floor is larger than the disk, so it is off',
        detail: [
          this.floorOffText(misfits, this.opts.floor.volumes.length),
          'GC treats the floor as off: no lane waits for it, and nothing is freed for it (the budget still applies).',
          'Set [worktrees] min_free_disk_gb below the disk\'s size (or 0 to turn the floor off) and restart GC; this row closes itself then.',
        ].join('\n'),
      });
    } catch (error) {
      this.log('error', 'the disk floor\'s row could not be posted or closed', { error: oneLine(error) });
    }
  }

  private floorOffText(misfits: readonly VolumeRead[], watched: number): string {
    return `[worktrees] min_free_disk_gb = ${String(this.opts.floor.floorGb)} is at or above the total size of ${misfits.map((read) => `${diskName(read, Math.max(watched, misfits.length))}, ${diskSize(read.space?.totalBytes ?? 0)} in all,`).join(' and ')} so the floor could never be met.`;
  }

  /** Under the budget and at or above the floor: Gru's row closes, an
   * unanswered card is withdrawn, and a decline's hold ends. */
  private conditionCleared(): void {
    this.opts.floor.setReclaimState('checking');
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
  'expire-reviews': 'The ledger keeps the verdicts and findings, the PR the published review, and each round folder its consolidated.json.',
  slim: 'Only the folders its manifest says setup recreates; setup restores them before its next turn.',
};

const NOTHING_CAUSE: Readonly<Record<NothingCause, string>> = {
  exhausted: 'Nothing GC can free losslessly remains: no lane of a finished, settled job it can release, no review folder of a finished job, and no idle lane it can slim (a lane in use, one with a process rooted in it, or one whose manifest declares no reclaim and setup is never slimmed).',
  accepted: 'The reclaim the owner accepted ran, and GC is still over its budget or the disk below the floor. GC proposes again after its next check if more can be freed.',
  declined: 'The owner declined GC\'s reclaim card, and lanes wait at the floor meanwhile: GC frees nothing until its usage grows by another tenth of the budget, or the owner frees space.',
  'proposed-open': 'GC\'s open reclaim card was posted for the budget alone, before the disk fell below the floor, and lanes wait at the floor meanwhile: GC frees nothing until the owner answers it in FOR YOU (Accept runs exactly its steps, which may free enough), or frees space.',
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
// The composition main.ts uses
// ------------------------------------------------------------------

/** The config the disk floor and service read. */
export interface DiskConfig {
  readonly dataDir: string;
  readonly worktrees: Pick<WorktreesConfig, 'root' | 'preserveRoot' | 'diskBudgetGb' | 'minFreeDiskGb' | 'reclaimMode'>;
}

/** The folders whose disks the floor watches: where lanes are created
 * ([worktrees] root), then data_dir. */
export function floorVolumes(config: Pick<DiskConfig, 'dataDir'> & { readonly worktrees: Pick<WorktreesConfig, 'root'> }): readonly FloorVolume[] {
  return [{ name: 'lanes', path: config.worktrees.root }, { name: 'data_dir', path: config.dataDir }];
}

/** The folders the view sorts GC's usage into, from config. */
export function diskPaths(config: Pick<DiskConfig, 'dataDir'> & { readonly worktrees: Pick<WorktreesConfig, 'root' | 'preserveRoot'> }): DiskPaths {
  return {
    dataDir: config.dataDir,
    lanes: config.worktrees.root,
    reviews: join(config.dataDir, 'reviews'),
    preserves: config.worktrees.preserveRoot,
    probes: onboardingProbesDir(config.dataDir),
    ledger: join(config.dataDir, 'ledger'),
    logs: join(config.dataDir, 'logs'),
  };
}

/** The floor main.ts builds (its tests build the same): `[worktrees]
 * min_free_disk_gb` over the {@link floorVolumes}, each wait and admission
 * recorded in the ledger. */
export function diskFloorFor(
  config: DiskConfig,
  deps: { readonly ledger: Pick<LedgerApi, 'appendCustomEvent'>; readonly log: Log } & Pick<DiskFloorGateOptions, 'statfs' | 'device' | 'now' | 'pollMs' | 'settleMs' | 'setTimeout' | 'clearTimeout'>,
): DiskFloorGate {
  const { ledger, ...rest } = deps;
  return new DiskFloorGate({
    ...rest,
    floorGb: config.worktrees.minFreeDiskGb,
    volumes: floorVolumes(config),
    record: (event) => {
      ledger.appendCustomEvent({ kind: event.kind, jobId: event.jobId, payload: event.payload });
    },
  });
}

/** The disk service main.ts builds (its tests build the same): the budget,
 * the mode and the folders from config. */
export function diskServiceFor(config: DiskConfig, deps: Omit<DiskServiceOptions, 'budgetGb' | 'mode' | 'paths'>): DiskService {
  return new DiskService({
    ...deps,
    budgetGb: config.worktrees.diskBudgetGb,
    mode: config.worktrees.reclaimMode,
    paths: diskPaths(config),
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
