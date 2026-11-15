import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { PrMediaConfig } from '../config.js';
import { resolveReviewBaseRef } from '../dispatch/perkins-review/artifacts.js';
import { repositoryGitEnv } from '../git-env.js';
import type { EventRecord } from '../ledger/api.js';
import { isTerminalJobStatus } from '../ledger/states.js';
import type { LogLevel } from '../logger.js';
import type { VerificationBudget } from '../verify/server.js';
import { MANIFEST_PATH, parseWorktreeManifest, type ManifestCapture, type WorktreeManifest } from '../worktrees/manifest.js';
import { CAMERA_SHUTDOWN, CAMERA_WORK_DIR, endOrphanedCameraApps, filmShotList, type CameraFailureCode, type CameraRunResult } from './camera.js';
import { compileCaptureGlob, touchedCapturePaths, type TouchedCapturePath } from './capture-paths.js';
import { planCaptures, readShotList, shotListPath, shotListSkipReason, ShotListError, type ShotList } from './shot-list.js';
import { listMedia, MEDIA_MAX_PER_HEAD, mediaAtHead, mediaRoot, storeMedia, type MediaItem, type MediaLedger } from './store.js';
import type { WebCaptureDriver } from './web-adapter.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * The camera director (PR media, docs/PR-MEDIA.md "GC's camera" and "When
 * media is owed"). Each tick, for every live job with one live lane at a
 * committed, clean head, it:
 *
 * 1. decides whether the head owes media (owner ruling Q4: code decides): the
 *    diff from the merge base touches a `[capture] paths` glob of the head's
 *    committed manifest OR of the merge base's (a diff cannot narrow the
 *    paths it is judged by). Touched with no current capture and no skip
 *    reason is **owed**; a shot-list skip reason makes it **skipped**; a
 *    capture at the head makes it **covered**; a head whose owing cannot be
 *    decided (a manifest that does not parse, a merge base or diff git could
 *    not read) is **unknown**, with the reason, never silently "not owed".
 *    The result is journaled as one `media.coverage` event whenever it
 *    changes, so the FOR YOU card and the PR section read it without git;
 * 2. films the minion's shot list at that head (owner ruling Q1, option C):
 *    as soon as the head is the minion's delivered head (a delivery asks for
 *    a tick at once), or once it has stood still for {@link CAMERA_SETTLE_MS}
 *    while no attempt is open. A head that moves is filmed again; a shot list
 *    changed at the same head is a new script and is filmed again too. One
 *    run at a time, under the verification budget. A parked job keeps its
 *    coverage current and is not filmed; a run whose job is parked or closed
 *    is stopped.
 *
 * Runs are journaled (`media.capture-started`, then `media.capture-filmed`
 * or `media.capture-failed`). A failure the shot list or the app must fix
 * (a step that fails, an unusable capture) is final for that head and
 * script; one infrastructure may cure is retried {@link CAMERA_MAX_ATTEMPTS}
 * times, {@link CAMERA_RETRY_MS} apart (a run cut short by a crash counts as
 * one). A head that moved during the run is not a failure of the script: the
 * new head is filmed instead.
 *
 * The lanes are read with `GIT_OPTIONAL_LOCKS=0`, so a tick never takes the
 * index lock a minion's own `git add` or `commit` needs.
 */

export const MEDIA_COVERAGE_EVENT = 'media.coverage';
export const MEDIA_CAPTURE_STARTED_EVENT = 'media.capture-started';
export const MEDIA_CAPTURE_FILMED_EVENT = 'media.capture-filmed';
export const MEDIA_CAPTURE_FAILED_EVENT = 'media.capture-failed';

export const CAMERA_TICK_MS = 30_000;
/** The boot cleanup's bound: past it, ticks start anyway (and say so). */
export const CAMERA_BOOT_CLEANUP_MS = 120_000;
/** A head that is not the delivered one is filmed once it stood this long. */
export const CAMERA_SETTLE_MS = 60_000;
export const CAMERA_MAX_ATTEMPTS = 3;
export const CAMERA_RETRY_MS = 10 * 60_000;
/** Touched paths listed in a coverage record (the count is always kept). */
export const COVERAGE_PATHS_LISTED = 10;
const DETAIL_MAX_CHARS = 600;
const GIT_TIMEOUT_MS = 30_000;
/** Statuses in which the minion's attempt is still open. */
const OPEN_ATTEMPT_STATUSES: ReadonlySet<string> = new Set(['dispatched', 'working']);

/** Outcome codes of a run as journaled: the camera's own, and the
 * director's (a run that would pass the cap, a store that failed, a run cut
 * short by a crash). */
export type CameraOutcomeCode = CameraFailureCode | 'media_limit' | 'store_failed' | 'interrupted';
/** Failures the shot list or the app must fix: retrying the same script at
 * the same head would fail the same way. */
const SCRIPT_FAULTS: ReadonlySet<CameraOutcomeCode> = new Set(['step_failed', 'capture_invalid', 'media_limit']);
/** Outcomes that are not attempts at all: the next tick tries again. */
const NOT_ATTEMPTS: ReadonlySet<CameraOutcomeCode> = new Set(['head_moved', 'stopped']);

export type CoverageState = 'owed' | 'skipped' | 'covered' | 'not-owed' | 'unknown';
export type CameraState = 'pending' | 'filming' | 'filmed' | 'failed' | 'unconfigured';

/** One head's media coverage, as journaled and read back. */
export interface MediaCoverage {
  readonly headSha: string;
  readonly state: CoverageState;
  /** Changed paths that match `[capture] paths`. */
  readonly touched: number;
  /** The first {@link COVERAGE_PATHS_LISTED} of them. */
  readonly paths: readonly string[];
  /** The globs they matched. */
  readonly globs: readonly string[];
  /** The shot list's skip reason, when it gives one. */
  readonly skip: string | null;
  readonly shotList: 'absent' | 'valid' | 'refused';
  /** Null when there is no valid shot list with something to film. */
  readonly camera: CameraState | null;
  /** Why owing is unknown, the shot-list refusal, or the camera's latest
   * failure. */
  readonly detail: string | null;
  readonly recordedAt: string;
}

export interface CameraLedger extends MediaLedger {
  listJobs(): readonly { readonly id: string; readonly status: string; readonly baseBranch: string | null }[];
  listWorktrees(opts: { jobId: string }): readonly {
    readonly kind: string;
    readonly path: string;
    readonly repoPath: string;
    readonly status: string;
  }[];
  latestCandidateDelivery(jobId: string): EventRecord | null;
}

export type GitRunner = (cwd: string, args: readonly string[]) => Promise<{ readonly code: number; readonly stdout: string }>;

export interface CameraDirectorOptions {
  readonly ledger: CameraLedger;
  readonly dataDir: string;
  readonly config: () => PrMediaConfig;
  readonly budget: () => VerificationBudget;
  readonly driver: WebCaptureDriver;
  readonly setupTimeoutMs: number;
  /** Test seams. `git` answers code -1 when git could not run or finish. */
  readonly git?: GitRunner;
  readonly film?: typeof filmShotList;
  readonly now?: () => number;
  readonly log?: Log;
}

function payloadOf(event: EventRecord): Record<string, unknown> {
  return typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
}

function bounded(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= DETAIL_MAX_CHARS ? flat : `${flat.slice(0, DETAIL_MAX_CHARS)}…`;
}

/** When a run event happened on the director's clock (its own `at`), so
 * waits never mix two clocks; the ledger's stamp for older rows. */
function eventAt(event: EventRecord): number {
  const at = payloadOf(event)['at'];
  return typeof at === 'number' && Number.isFinite(at) ? at : Date.parse(event.ts);
}

function message(error: unknown): string {
  return bounded(String(error instanceof Error ? error.message : error));
}

const COVERAGE_STATES: readonly string[] = ['owed', 'skipped', 'covered', 'not-owed', 'unknown'];
const CAMERA_STATES: readonly string[] = ['pending', 'filming', 'filmed', 'failed', 'unconfigured'];

function strings(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? value as string[] : null;
}

/** A coverage record read back; null when the payload does not parse. */
export function readCoverage(event: EventRecord): MediaCoverage | null {
  if (event.kind !== MEDIA_COVERAGE_EVENT) return null;
  const payload = payloadOf(event);
  const head = payload['head_sha'];
  const state = payload['state'];
  const touched = payload['touched'];
  const paths = strings(payload['paths']);
  const globs = strings(payload['globs']);
  const skip = payload['skip'];
  const shotList = payload['shot_list'];
  const camera = payload['camera'];
  const detail = payload['detail'];
  if (
    typeof head !== 'string' || !/^[0-9a-f]{40}$/u.test(head) ||
    typeof state !== 'string' || !COVERAGE_STATES.includes(state) ||
    typeof touched !== 'number' || !Number.isSafeInteger(touched) || touched < 0 ||
    paths === null || globs === null || paths.length > touched ||
    !(skip === null || typeof skip === 'string') ||
    !(shotList === 'absent' || shotList === 'valid' || shotList === 'refused') ||
    !(camera === null || (typeof camera === 'string' && CAMERA_STATES.includes(camera))) ||
    !(detail === null || typeof detail === 'string')
  ) {
    return null;
  }
  return {
    headSha: head,
    state: state as CoverageState,
    touched,
    paths,
    globs,
    skip,
    shotList,
    camera: camera as CameraState | null,
    detail,
    recordedAt: event.ts,
  };
}

/** The newest coverage journaled for exactly `headSha`, or null. */
export function coverageAtHead(ledger: Pick<MediaLedger, 'listJobEvents'>, jobId: string, headSha: string): MediaCoverage | null {
  for (const event of ledger.listJobEvents(jobId, { kinds: [MEDIA_COVERAGE_EVENT], order: 'desc', limit: 50 })) {
    const coverage = readCoverage(event);
    if (coverage !== null && coverage.headSha === headSha) return coverage;
  }
  return null;
}

/** The newest camera run event of the job (started, filmed or failed). */
export function latestCameraEvent(ledger: Pick<MediaLedger, 'listJobEvents'>, jobId: string): EventRecord | null {
  return ledger.listJobEvents(jobId, {
    kinds: [MEDIA_CAPTURE_STARTED_EVENT, MEDIA_CAPTURE_FILMED_EVENT, MEDIA_CAPTURE_FAILED_EVENT],
    order: 'desc',
    limit: 1,
  })[0] ?? null;
}

/** What a job's head looks like to the director. */
interface HeadFacts {
  readonly head: string;
  /** The head's committed `[capture]`; null when it commits none. */
  readonly capture: ManifestCapture | null;
  readonly manifest: WorktreeManifest | null;
  readonly mergeBase: string | null;
  /** Changed paths under the head's or the base's `[capture] paths`. */
  readonly touched: readonly TouchedCapturePath[];
  /** The head or its base declares `[capture]` (or a manifest that does not
   * parse mentions it): media coverage applies. */
  readonly relevant: boolean;
  /** Why owing could not be decided; null when it was. */
  readonly undecided: string | null;
  /** Whether these facts hold for the head (cached), or came from a git
   * read that may succeed next time. */
  readonly cacheable: boolean;
}

/** One side's manifest at a commit: absent, parsed, refused, or unreadable
 * just now. */
type ManifestRead =
  | { readonly kind: 'absent' }
  | { readonly kind: 'parsed'; readonly manifest: WorktreeManifest }
  | { readonly kind: 'refused'; readonly error: string; readonly mentionsCapture: boolean }
  | { readonly kind: 'unreadable'; readonly error: string };

/** A run's identity and whether its outcome is journaled (a stop at
 * shutdown writes it before the run has finished cleaning up). */
interface RunRecord {
  readonly runId: string;
  readonly base: Record<string, unknown>;
  settled: boolean;
}

interface Running {
  readonly jobId: string;
  readonly runId: string;
  readonly head: string;
  readonly shotList: string;
  readonly record: RunRecord;
  readonly abort: AbortController;
  readonly done: Promise<void>;
}

/** git, off the event loop, never taking an optional lock. */
function defaultGit(cwd: string, args: readonly string[]): Promise<{ readonly code: number; readonly stdout: string }> {
  return new Promise((resolveGit) => {
    execFile('git', ['-C', cwd, ...args], {
      env: { ...repositoryGitEnv(true), GIT_OPTIONAL_LOCKS: '0' },
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      encoding: 'utf-8',
    }, (error, stdout) => {
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1;
      resolveGit({ code, stdout });
    });
  });
}

export class CameraDirector {
  private readonly now: () => number;
  private readonly log: Log;
  private readonly git: GitRunner;
  private readonly facts = new Map<string, HeadFacts>();
  /** When each job's current head was first seen (the settle clock). */
  private readonly firstSeen = new Map<string, { readonly head: string; readonly at: number }>();
  /** `<job> <head> <reason>` warnings already logged. */
  private readonly warned = new Set<string>();
  /** Jobs the last tick found filmable (live and not parked). */
  private filmable = new Set<string>();
  private running: Running | null = null;
  /** The tick in progress. */
  private current: Promise<void> | null = null;
  private again = false;
  private disposed = false;
  /** False while the boot cleanup runs: a tick then would start a run the
   * cleanup could end. */
  private booted = true;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: CameraDirectorOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.git = options.git ?? defaultGit;
  }

  /** The run in flight, for tests and the shutdown path. */
  inFlight(): Promise<void> | null {
    return this.running?.done ?? null;
  }

  /** Resolves once no tick and no run is in progress (the ticks a settled
   * run asks for included). */
  async idle(): Promise<void> {
    for (;;) {
      const waits = [this.current, this.running?.done ?? null].filter((wait): wait is Promise<void> => wait !== null);
      if (waits.length === 0) return;
      await Promise.all(waits);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.stopRun();
    // A pass in progress ends before the ledger is closed under it; one that
    // started a run meanwhile has that run stopped too.
    if (this.current !== null) await this.current;
    await this.stopRun();
  }

  /** Stop the run in flight for shutdown: abort it first, then journal the
   * stop at once (before the run cleans up, so a shutdown that ends before
   * the cleanup never leaves a run without an outcome, which counts as a
   * crash), then wait for it. */
  private async stopRun(): Promise<void> {
    const running = this.running;
    if (running === null) return;
    running.abort.abort(CAMERA_SHUTDOWN);
    try {
      this.journalOutcome(running.jobId, running.record, 'stopped', 'the service is stopping');
    } catch (error) {
      this.log('warn', 'pr media camera: the stop could not be journaled', { job: running.jobId, run: running.runId, error: message(error) });
    }
    await running.done;
  }

  /** Boot: end what an earlier process's runs left running and remove
   * their folders, then tick every {@link CAMERA_TICK_MS}. No tick runs
   * before the cleanup has finished (one asked for meanwhile runs after). */
  start(): void {
    if (this.timer !== null || this.disposed) return;
    this.booted = false;
    let bound: ReturnType<typeof setTimeout> | undefined;
    void Promise.race([
      endOrphanedCameraApps(this.options.budget, this.options.dataDir, this.log),
      new Promise<void>((resolveBound) => {
        bound = setTimeout(() => {
          this.log('warn', 'pr media camera: the boot cleanup did not finish in time; filming starts anyway', { waited_ms: CAMERA_BOOT_CLEANUP_MS });
          resolveBound();
        }, CAMERA_BOOT_CLEANUP_MS);
        bound.unref?.();
      }),
    ])
      .catch((error: unknown) => {
        this.log('warn', 'pr media camera: the boot cleanup failed', { error: message(error) });
      })
      .then(() => {
        clearTimeout(bound);
        this.booted = true;
        this.again = false;
        return this.tick();
      });
    // The timer never queues a pass behind a running one (a slow pass would
    // otherwise run back to back forever).
    this.timer = setInterval(() => {
      if (this.current === null) void this.tick();
    }, CAMERA_TICK_MS);
    this.timer.unref?.();
  }

  stop(): Promise<void> {
    return this.dispose();
  }

  /** A tick now (a delivery landed, a run settled); one already running
   * runs again when it ends. */
  requestTick(): void {
    if (this.disposed) return;
    if (this.current !== null || !this.booted) {
      this.again = true;
      return;
    }
    void this.tick();
  }

  /** One pass over the live jobs (or the pass already in progress). Never
   * rejects; a job that fails is logged and the rest still run. */
  tick(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (!this.booted) {
      this.again = true;
      return Promise.resolve();
    }
    if (this.current !== null) {
      // A pass already running may have read the state before the caller
      // changed it: one more runs after it.
      this.again = true;
      return this.current;
    }
    this.current = this.pass().finally(() => {
      this.current = null;
      if (this.again && !this.disposed) {
        this.again = false;
        void this.tick();
      }
    });
    return this.current;
  }

  private async pass(): Promise<void> {
    try {
      if (!this.options.config().enabled) return;
      const live = new Set<string>();
      const filmable = new Set<string>();
      for (const job of this.options.ledger.listJobs()) {
        if (this.disposed) return;
        if (isTerminalJobStatus(job.status)) continue;
        live.add(job.id);
        // A parked job (an owner hold) keeps its coverage current and is
        // never filmed. A job is filmable from the moment it is seen so, so
        // a run that settles before the pass ends keeps its film.
        if (job.status !== 'parked') {
          filmable.add(job.id);
          this.filmable.add(job.id);
        }
        try {
          await this.consider(job, job.status !== 'parked');
        } catch (error) {
          this.log('warn', 'pr media camera: a job could not be considered', { job: job.id, error: message(error) });
        }
      }
      this.filmable = filmable;
      const running = this.running;
      if (running !== null && !filmable.has(running.jobId)) {
        this.log('info', 'pr media camera: the job was parked or closed; its run is stopped', { job: running.jobId, run: running.runId });
        running.abort.abort();
      }
      for (const jobId of [...this.facts.keys()]) if (!live.has(jobId)) this.facts.delete(jobId);
      for (const jobId of [...this.firstSeen.keys()]) if (!live.has(jobId)) this.firstSeen.delete(jobId);
      for (const key of [...this.warned]) if (!live.has(key.slice(0, key.indexOf(' ')))) this.warned.delete(key);
    } catch (error) {
      this.log('warn', 'pr media camera: the tick failed', { error: message(error) });
    }
  }

  private warnOnce(jobId: string, head: string, reason: string, fields: Record<string, unknown>): void {
    const key = `${jobId} ${head} ${reason}`;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log('warn', `pr media camera: ${reason}`, { job: jobId, head, ...fields });
  }

  /** The committed manifest at `commit`, telling "none" from "cannot read". */
  private async manifestAt(lanePath: string, commit: string): Promise<ManifestRead> {
    const listed = await this.git(lanePath, ['ls-tree', '--name-only', commit, '--', MANIFEST_PATH]);
    if (listed.code !== 0) return { kind: 'unreadable', error: `git ls-tree exited ${listed.code}` };
    if (listed.stdout.trim() === '') return { kind: 'absent' };
    const shown = await this.git(lanePath, ['show', `${commit}:${MANIFEST_PATH}`]);
    if (shown.code !== 0) return { kind: 'unreadable', error: `git show exited ${shown.code}` };
    try {
      return { kind: 'parsed', manifest: parseWorktreeManifest(shown.stdout, `${commit.slice(0, 12)}:${MANIFEST_PATH}`) };
    } catch (error) {
      // `[capture]`, `[ capture ]` or an inline `capture = {…}`.
      return { kind: 'refused', error: message(error), mentionsCapture: /^\s*(?:\[\s*capture\s*\]|capture\s*=)/mu.test(shown.stdout) };
    }
  }

  private async headFacts(jobId: string, lanePath: string, baseBranch: string | null, head: string): Promise<HeadFacts> {
    const cached = this.facts.get(jobId);
    if (cached !== undefined && cached.head === head) return cached;
    const facts = await this.readFacts(lanePath, baseBranch, head);
    if (facts.cacheable) this.facts.set(jobId, facts);
    else this.facts.delete(jobId);
    if (facts.undecided !== null) this.warnOnce(jobId, head, 'media owing could not be decided', { detail: facts.undecided });
    return facts;
  }

  private async readFacts(lanePath: string, baseBranch: string | null, head: string): Promise<HeadFacts> {
    const none = { head, capture: null, manifest: null, mergeBase: null, touched: [] };
    const atHead = await this.manifestAt(lanePath, head);
    if (atHead.kind === 'unreadable') {
      return { ...none, relevant: true, undecided: `the head's ${MANIFEST_PATH} could not be read (${atHead.error})`, cacheable: false };
    }
    const manifest = atHead.kind === 'parsed' ? atHead.manifest : null;
    const capture = manifest?.capture ?? null;
    let mergeBase: string | null = null;
    let baseError: string | null = null;
    try {
      const baseRef = resolveReviewBaseRef(lanePath, baseBranch);
      const base = await this.git(lanePath, ['merge-base', `${baseRef}^{commit}`, head]);
      if (base.code === 0 && /^[0-9a-f]{40}$/u.test(base.stdout.trim())) mergeBase = base.stdout.trim();
      else baseError = `git merge-base with ${baseRef} exited ${base.code}`;
    } catch (error) {
      baseError = message(error);
    }
    const atBase = mergeBase === null ? null : await this.manifestAt(lanePath, mergeBase);
    const baseCapture = atBase?.kind === 'parsed' ? atBase.manifest.capture ?? null : null;
    const relevant = capture !== null || baseCapture !== null ||
      (atHead.kind === 'refused' && atHead.mentionsCapture) || (atBase?.kind === 'refused' && atBase.mentionsCapture);
    const facts = { head, capture, manifest, mergeBase, touched: [] as readonly TouchedCapturePath[], relevant };
    if (!relevant) {
      // Nothing declares capture paths here: decided, unless the base could
      // not be read (it may declare them).
      return { ...facts, undecided: null, cacheable: mergeBase !== null && atBase?.kind !== 'unreadable' };
    }
    if (atHead.kind === 'refused') return { ...facts, undecided: `manifest_invalid: ${atHead.error}`, cacheable: true };
    if (mergeBase === null) return { ...facts, undecided: `the merge base could not be found: ${baseError ?? 'unknown'}`, cacheable: false };
    if (atBase?.kind === 'unreadable') return { ...facts, undecided: `the merge base's ${MANIFEST_PATH} could not be read (${atBase.error})`, cacheable: false };
    const patterns = [...(capture?.paths ?? []), ...(baseCapture?.paths ?? [])];
    if (patterns.length === 0) return { ...facts, undecided: null, cacheable: true };
    const diff = await this.git(lanePath, ['diff', '--name-only', '--no-renames', '-z', mergeBase, head]);
    if (diff.code !== 0) return { ...facts, undecided: `the diff from the merge base could not be read (git diff exited ${diff.code})`, cacheable: false };
    const changed = diff.stdout.split('\0').filter((path) => path !== '');
    // Each side judged by its own globs (its exclusions included); a path
    // either side says owes media owes it.
    const sides = [capture?.paths ?? [], baseCapture?.paths ?? []]
      .filter((paths) => paths.length > 0)
      .map((paths) => new Map(touchedCapturePaths(paths.map((pattern) => compileCaptureGlob(pattern)), changed).map((entry) => [entry.path, entry])));
    const seen = new Set<string>();
    const touched: TouchedCapturePath[] = [];
    for (const path of changed) {
      if (seen.has(path)) continue;
      const hit = sides.map((side) => side.get(path)).find((entry) => entry !== undefined);
      if (hit === undefined) continue;
      seen.add(path);
      touched.push(hit);
    }
    return { ...facts, touched, undecided: null, cacheable: true };
  }

  private filmingKey(head: string, shotList: string): (event: EventRecord) => boolean {
    return (event) => payloadOf(event)['head_sha'] === head && payloadOf(event)['shot_list_sha256'] === shotList;
  }

  /** The camera's standing for this head and script. */
  private cameraStanding(jobId: string, head: string, shotList: ShotList): { readonly state: CameraState; readonly detail: string | null; readonly due: boolean } {
    if (this.running !== null && this.running.jobId === jobId && this.running.head === head && this.running.shotList === shotList.sha256) {
      return { state: 'filming', detail: null, due: false };
    }
    const events = this.options.ledger.listJobEvents(jobId, {
      kinds: [MEDIA_CAPTURE_STARTED_EVENT, MEDIA_CAPTURE_FILMED_EVENT, MEDIA_CAPTURE_FAILED_EVENT],
      order: 'desc',
      limit: 100,
    }).filter(this.filmingKey(head, shotList.sha256));
    if (events.some((event) => event.kind === MEDIA_CAPTURE_FILMED_EVENT)) return { state: 'filmed', detail: null, due: false };
    const settled = new Set(events.filter((event) => event.kind !== MEDIA_CAPTURE_STARTED_EVENT).map((event) => payloadOf(event)['run_id']));
    // A run that started and never settled was cut short (the service
    // stopped or crashed): it counts as an attempt, so a crash can never
    // loop forever.
    const attempts = events
      .filter((event) => (event.kind === MEDIA_CAPTURE_FAILED_EVENT && !NOT_ATTEMPTS.has(payloadOf(event)['code'] as CameraOutcomeCode)) ||
        (event.kind === MEDIA_CAPTURE_STARTED_EVENT && !settled.has(payloadOf(event)['run_id'])));
    const latest = attempts[0];
    const latestCode = latest === undefined ? null : latest.kind === MEDIA_CAPTURE_STARTED_EVENT ? 'interrupted' : payloadOf(latest)['code'] as CameraOutcomeCode;
    const detail = latest === undefined
      ? null
      : latest.kind === MEDIA_CAPTURE_STARTED_EVENT
        ? 'an earlier run was cut short before it finished'
        : typeof payloadOf(latest)['detail'] === 'string' ? payloadOf(latest)['detail'] as string : null;
    if (latestCode !== null && (SCRIPT_FAULTS.has(latestCode) || attempts.length >= CAMERA_MAX_ATTEMPTS)) {
      return { state: 'failed', detail, due: false };
    }
    // A run that was no attempt (the head moved, the service stopped) is not
    // repeated at once either: it waits as a head waits to settle.
    const lastTry = events.find((event) => event.kind === MEDIA_CAPTURE_FAILED_EVENT);
    const rested = lastTry === undefined || !NOT_ATTEMPTS.has(payloadOf(lastTry)['code'] as CameraOutcomeCode) ||
      this.now() - eventAt(lastTry) >= CAMERA_SETTLE_MS;
    const waited = latest === undefined || this.now() - eventAt(latest) >= CAMERA_RETRY_MS;
    return { state: 'pending', detail, due: waited && rested };
  }

  private async consider(job: { readonly id: string; readonly status: string; readonly baseBranch: string | null }, mayFilm: boolean): Promise<void> {
    const lanes = this.options.ledger.listWorktrees({ jobId: job.id }).filter((lane) => lane.kind === 'job' && lane.status !== 'swept');
    if (lanes.length === 0) return;
    if (lanes.length > 1) {
      this.warnOnce(job.id, '-', 'the job has more than one live job lane, so its media is not judged', { lanes: lanes.length });
      return;
    }
    const lane = lanes[0]!;
    const rev = await this.git(lane.path, ['rev-parse', 'HEAD']);
    const head = rev.stdout.trim();
    if (rev.code !== 0 || !/^[0-9a-f]{40}$/u.test(head)) return;
    const seen = this.firstSeen.get(job.id);
    if (seen === undefined || seen.head !== head) this.firstSeen.set(job.id, { head, at: this.now() });
    const facts = await this.headFacts(job.id, lane.path, job.baseBranch, head);
    if (!facts.relevant) {
      this.clearUnknown(job.id, head);
      return;
    }

    let shotList: ShotList | null = null;
    let refusal: string | null = null;
    try {
      shotList = readShotList(shotListPath(this.options.dataDir, lane.repoPath, job.id));
    } catch (error) {
      if (!(error instanceof ShotListError)) throw error;
      refusal = `${error.code}: ${error.message}`;
    }
    const items = mediaAtHead(listMedia(this.options.ledger, job.id), head);
    const plans = shotList === null ? [] : planCaptures(shotList);
    let camera: { readonly state: CameraState; readonly detail: string | null; readonly due: boolean } | null = null;
    if (shotList !== null && plans.length > 0) {
      camera = facts.capture?.serve === null || facts.capture === null
        ? { state: 'unconfigured', detail: 'the head\'s [capture] declares no serve and ready, so GC cannot film this shot list: submit captures with POST /api/media instead', due: false }
        : this.cameraStanding(job.id, head, shotList);
    }
    this.recordCoverage(job.id, head, facts, shotList, refusal, items, camera);

    if (!mayFilm || camera === null || !camera.due || shotList === null || this.running !== null || this.disposed) return;
    // A lane mid-edit is filmed once it commits: its head is about to move.
    const status = await this.git(lane.path, ['status', '--porcelain', '--untracked-files=no']);
    if (status.code !== 0 || status.stdout.trim() !== '') return;
    // Checked again after the await: the service may have begun stopping, or
    // another run started, meanwhile.
    if (this.disposed || this.running !== null) return;
    const delivered = this.options.ledger.latestCandidateDelivery(job.id);
    const deliveredSha = delivered === null ? null : payloadOf(delivered)['sha'];
    const settled = deliveredSha === head ||
      (!OPEN_ATTEMPT_STATUSES.has(job.status) && this.now() - (this.firstSeen.get(job.id)?.at ?? this.now()) >= CAMERA_SETTLE_MS);
    if (!settled) return;
    this.beginRun(job.id, lane, head, facts, shotList, plans);
  }

  private recordCoverage(
    jobId: string,
    head: string,
    facts: HeadFacts,
    shotList: ShotList | null,
    refusal: string | null,
    items: readonly MediaItem[],
    camera: { readonly state: CameraState; readonly detail: string | null } | null,
  ): void {
    const touched = facts.touched;
    // Nothing to say: owing is decided, no path owes media and the minion
    // directed nothing (an earlier "unknown" at this head is set straight).
    if (facts.undecided === null && touched.length === 0 && shotList === null && refusal === null) {
      this.clearUnknown(jobId, head);
      return;
    }
    const skip = shotList === null ? null : shotListSkipReason(shotList);
    const state: CoverageState = facts.undecided !== null
      ? 'unknown'
      : touched.length === 0 ? 'not-owed' : items.length > 0 ? 'covered' : skip !== null ? 'skipped' : 'owed';
    const payload = {
      head_sha: head,
      state,
      touched: touched.length,
      paths: touched.slice(0, COVERAGE_PATHS_LISTED).map((entry) => entry.path),
      globs: [...new Set(touched.map((entry) => entry.glob))],
      skip,
      shot_list: refusal !== null ? 'refused' : shotList === null ? 'absent' : 'valid',
      ...(shotList === null ? {} : { shot_list_sha256: shotList.sha256 }),
      camera: camera?.state ?? null,
      detail: facts.undecided ?? refusal ?? camera?.detail ?? null,
    };
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const latest = this.options.ledger.listJobEvents(jobId, { kinds: [MEDIA_COVERAGE_EVENT], order: 'desc', limit: 1 })[0];
    if (latest !== undefined && payloadOf(latest)['digest'] === digest) return;
    this.options.ledger.appendCustomEvent({ kind: MEDIA_COVERAGE_EVENT, jobId, payload: { ...payload, digest } });
  }

  /** Owing at `head` was unknown and is now decided with nothing owed: the
   * record says so, so the card and the minion stop reading "unknown". */
  private clearUnknown(jobId: string, head: string): void {
    const latest = this.options.ledger.listJobEvents(jobId, { kinds: [MEDIA_COVERAGE_EVENT], order: 'desc', limit: 1 })[0];
    const coverage = latest === undefined ? null : readCoverage(latest);
    if (coverage === null || coverage.headSha !== head || coverage.state !== 'unknown') return;
    const payload = { head_sha: head, state: 'not-owed', touched: 0, paths: [], globs: [], skip: null, shot_list: 'absent', camera: null, detail: null };
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    this.options.ledger.appendCustomEvent({ kind: MEDIA_COVERAGE_EVENT, jobId, payload: { ...payload, digest } });
  }

  /** Journal a run's failed outcome once (a stop at shutdown may come
   * before the run's own). */
  private journalOutcome(jobId: string, run: RunRecord, code: CameraOutcomeCode, detail: string): void {
    if (run.settled) return;
    run.settled = true;
    this.options.ledger.appendCustomEvent({ kind: MEDIA_CAPTURE_FAILED_EVENT, jobId, payload: { ...run.base, code, detail: bounded(detail), at: this.now() } });
    this.log(NOT_ATTEMPTS.has(code) ? 'info' : 'warn', 'pr media camera: the shot list was not filmed', { job: jobId, run: run.runId, code, detail });
  }

  private beginRun(
    jobId: string,
    lane: { readonly path: string; readonly repoPath: string },
    head: string,
    facts: HeadFacts,
    shotList: ShotList,
    plans: ReturnType<typeof planCaptures>,
  ): void {
    const capture = facts.capture;
    const manifest = facts.manifest;
    if (capture === null || manifest === null) return;
    const runId = `cr-${randomUUID()}`;
    const abort = new AbortController();
    const base = { run_id: runId, head_sha: head, shot_list_sha256: shotList.sha256 };
    const record: RunRecord = { runId, base, settled: false };
    this.options.ledger.appendCustomEvent({ kind: MEDIA_CAPTURE_STARTED_EVENT, jobId, payload: { ...base, files: plans.length, at: this.now() } });
    this.log('info', 'pr media camera: filming the shot list', { job: jobId, run: runId, head, files: plans.length });
    const film = this.options.film ?? filmShotList;
    const done = (async () => {
      let result: CameraRunResult;
      try {
        result = await film({
          jobId,
          runId,
          lanePath: lane.path,
          repoPath: lane.repoPath,
          headSha: head,
          baseSha: facts.mergeBase,
          capture,
          headManifest: manifest,
          plans,
          workDir: join(mediaRoot(this.options.dataDir), CAMERA_WORK_DIR, runId),
          budget: this.options.budget,
          driver: this.options.driver,
          setupTimeoutMs: this.options.setupTimeoutMs,
          signal: abort.signal,
          log: this.log,
        });
      } catch (error) {
        result = { kind: 'failed', code: 'serve_failed', detail: `the camera run failed unexpectedly: ${message(error)}` };
      }
      this.settle(jobId, head, record, result);
    })()
      .catch((error: unknown) => {
        // Never an unhandled rejection: the run's start stays journaled
        // without an outcome, which counts as an interrupted attempt.
        this.log('error', 'pr media camera: a run could not be settled', { job: jobId, run: runId, error: message(error) });
      })
      .finally(() => {
        if (this.running?.runId === runId) this.running = null;
        // Coverage reflects the outcome at once, not a tick later.
        this.requestTick();
      });
    this.running = { jobId, runId, head, shotList: shotList.sha256, record, abort, done };
  }

  private settle(jobId: string, head: string, record: RunRecord, result: CameraRunResult): void {
    const ledger = this.options.ledger;
    const { runId, base } = record;
    // Every run gets its outcome, a stopped one included (not an attempt):
    // only a run with none was cut short by a crash. A run whose stop was
    // already journaled (at shutdown) gets nothing more.
    if (record.settled) return;
    const fail = (code: CameraOutcomeCode, detail: string): void => this.journalOutcome(jobId, record, code, detail);
    if (result.kind === 'failed') {
      fail(result.code, result.detail);
      return;
    }
    if (!this.filmable.has(jobId)) {
      fail('stopped', 'the job was parked or closed during the run; nothing is stored');
      return;
    }
    // A camera run replaces the head's older runs, so the minion's own
    // captures are what it joins (the per-head cap).
    const minion = mediaAtHead(listMedia(ledger, jobId), head).filter((item) => item.shot === null).length;
    if (minion + result.files.length > MEDIA_MAX_PER_HEAD) {
      fail('media_limit', `the head already has ${minion} captures submitted directly; with ${result.files.length} filmed it would pass the ${MEDIA_MAX_PER_HEAD} a head holds`);
      return;
    }
    const ids: string[] = [];
    try {
      for (const file of result.files) {
        const item = storeMedia({
          dataDir: this.options.dataDir,
          ledger,
          jobId,
          headSha: head,
          caption: file.plan.caption,
          role: file.plan.role,
          bytes: file.bytes,
          capturedBy: 'gc',
          shot: { runId, shotId: file.plan.shotId, viewport: file.plan.viewport.name, files: result.files.length },
        });
        ids.push(item.id);
      }
    } catch (error) {
      // Infrastructure (a full disk, a ledger write): retried. A run cut
      // short here never shows (a run counts only once complete).
      fail('store_failed', `the filmed captures could not be stored: ${message(error)}`);
      return;
    }
    record.settled = true;
    ledger.appendCustomEvent({ kind: MEDIA_CAPTURE_FILMED_EVENT, jobId, payload: { ...base, media_ids: ids, at: this.now() } });
  }
}
