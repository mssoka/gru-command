import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { PrMediaConfig } from '../config.js';
import { resolveReviewBaseRef } from '../dispatch/perkins-review/artifacts.js';
import { repositoryGitEnv } from '../git-env.js';
import type { EventRecord } from '../ledger/api.js';
import { isTerminalJobStatus } from '../ledger/states.js';
import type { LogLevel } from '../logger.js';
import { readGitState } from '../verify/scheduler.js';
import type { VerificationBudget } from '../verify/server.js';
import { MANIFEST_PATH, parseWorktreeManifest, type ManifestCapture, type WorktreeManifest } from '../worktrees/manifest.js';
import { endOrphanedCameraApps, filmShotList, type CameraFailureCode, type CameraRunResult } from './camera.js';
import { compileCaptureGlob, touchedCapturePaths } from './capture-paths.js';
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
 *    committed manifest. Touched with no current capture and no skip reason
 *    is **owed**; a shot-list skip reason makes it **skipped**; a capture at
 *    the head makes it **covered**. The result is journaled as one
 *    `media.coverage` event whenever it changes, so the FOR YOU card and the
 *    PR section read it without running git;
 * 2. films the minion's shot list at that head (owner ruling Q1, option C):
 *    once the head is the minion's delivered head, or once it has stood still
 *    for {@link CAMERA_SETTLE_MS} while no attempt is open. A head that moves
 *    is filmed again; a shot list changed at the same head is a new script
 *    and is filmed again too. One run at a time, under the verification
 *    budget.
 *
 * Runs are journaled (`media.capture-started`, then `media.capture-filmed`
 * or `media.capture-failed`). A failure the shot list or the app must fix
 * (a step that fails, an unusable capture) is final for that head and
 * script; one infrastructure may cure is retried {@link CAMERA_MAX_ATTEMPTS}
 * times, {@link CAMERA_RETRY_MS} apart. A head that moved during the run is
 * not a failure of the script: the new head is filmed instead.
 */

export const MEDIA_COVERAGE_EVENT = 'media.coverage';
export const MEDIA_CAPTURE_STARTED_EVENT = 'media.capture-started';
export const MEDIA_CAPTURE_FILMED_EVENT = 'media.capture-filmed';
export const MEDIA_CAPTURE_FAILED_EVENT = 'media.capture-failed';

export const CAMERA_TICK_MS = 30_000;
/** A head that is not the delivered one is filmed once it stood this long. */
export const CAMERA_SETTLE_MS = 60_000;
export const CAMERA_MAX_ATTEMPTS = 3;
export const CAMERA_RETRY_MS = 10 * 60_000;
/** A run that found the lane mid-edit waits this long before trying again. */
export const CAMERA_DIRTY_BACKOFF_MS = 60_000;
/** Touched paths listed in a coverage record (the count is always kept). */
export const COVERAGE_PATHS_LISTED = 10;
const DETAIL_MAX_CHARS = 600;
/** Statuses in which the minion's attempt is still open. */
const OPEN_ATTEMPT_STATUSES: ReadonlySet<string> = new Set(['dispatched', 'working']);
/** Failures the shot list or the app must fix: retrying the same script at
 * the same head would fail the same way. */
const SCRIPT_FAULTS: ReadonlySet<CameraFailureCode | 'media_limit'> = new Set(['step_failed', 'capture_invalid', 'media_limit']);
/** Outcomes that are not attempts at all: the next tick tries again. */
const NOT_ATTEMPTS: ReadonlySet<CameraFailureCode> = new Set(['head_moved', 'dirty_tree', 'stopped']);

export type CoverageState = 'owed' | 'skipped' | 'covered' | 'not-owed';
export type CameraState = 'pending' | 'filming' | 'filmed' | 'failed' | 'unconfigured';

/** One head's media coverage, as journaled and read back. */
export interface MediaCoverage {
  readonly headSha: string;
  readonly state: CoverageState;
  /** Changed paths that match `[capture] paths`. */
  readonly touched: number;
  /** The first {@link COVERAGE_PATHS_LISTED} of them. */
  readonly paths: readonly string[];
  /** The globs they matched, in manifest order. */
  readonly globs: readonly string[];
  /** The shot list's skip reason, when it gives one. */
  readonly skip: string | null;
  readonly shotList: 'absent' | 'valid' | 'refused';
  /** Null when there is no valid shot list with something to film. */
  readonly camera: CameraState | null;
  /** The shot-list refusal, or the camera's latest failure. */
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

export interface CameraDirectorOptions {
  readonly ledger: CameraLedger;
  readonly dataDir: string;
  readonly config: () => PrMediaConfig;
  readonly budget: () => VerificationBudget;
  readonly driver: WebCaptureDriver;
  /** Gives a slim lane its setup back (#427), as before a verification. */
  readonly ensureReady?: (jobId: string, signal: AbortSignal) => Promise<void>;
  readonly setupTimeoutMs: number;
  /** Test seams. `gitState` is the camera run's own check; the tick reads
   * each lane with `git` (off the event loop). */
  readonly gitState?: (cwd: string) => { readonly sha: string | null; readonly trackedDirty: boolean };
  readonly git?: (cwd: string, args: readonly string[]) => Promise<{ readonly code: number; readonly stdout: string }>;
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

const COVERAGE_STATES: readonly string[] = ['owed', 'skipped', 'covered', 'not-owed'];
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
    paths === null || globs === null ||
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

/** What a job's head looks like to the director (git work, cached per head). */
interface HeadFacts {
  readonly head: string;
  /** Null when the head commits no manifest or no `[capture]`. */
  readonly capture: ManifestCapture | null;
  readonly manifest: WorktreeManifest | null;
  /** The manifest could not be parsed: nothing owes media until it can. */
  readonly manifestError: string | null;
  readonly mergeBase: string | null;
  readonly touched: readonly { readonly path: string; readonly glob: string }[];
}

interface Running {
  readonly jobId: string;
  readonly runId: string;
  readonly head: string;
  readonly shotList: string;
  readonly abort: AbortController;
  readonly done: Promise<void>;
}

function defaultGit(cwd: string, args: readonly string[]): Promise<{ readonly code: number; readonly stdout: string }> {
  return new Promise((resolveGit) => {
    execFile('git', ['-C', cwd, ...args], { env: repositoryGitEnv(true), timeout: 30_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf-8' },
      (error, stdout) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1;
        resolveGit({ code, stdout });
      });
  });
}

export class CameraDirector {
  private readonly now: () => number;
  private readonly log: Log;
  private readonly git: (cwd: string, args: readonly string[]) => Promise<{ readonly code: number; readonly stdout: string }>;
  private readonly gitState: (cwd: string) => { readonly sha: string | null; readonly trackedDirty: boolean };
  private readonly facts = new Map<string, HeadFacts>();
  /** When each job's current head was first seen (the settle clock). */
  private readonly firstSeen = new Map<string, { readonly head: string; readonly at: number }>();
  /** `<job> <head> <script>` → no new run before this time (a dirty lane). */
  private readonly backoff = new Map<string, number>();
  private running: Running | null = null;
  private ticking = false;
  private disposed = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: CameraDirectorOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
    this.git = options.git ?? defaultGit;
    this.gitState = options.gitState ?? ((cwd: string) => readGitState(cwd));
  }

  /** True while a camera run holds the job's lane (lane slimming waits). */
  jobBusy(jobId: string): boolean {
    return this.running?.jobId === jobId;
  }

  /** The run in flight, for tests and the shutdown path. */
  inFlight(): Promise<void> | null {
    return this.running?.done ?? null;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    const running = this.running;
    if (running === null) return;
    running.abort.abort();
    await running.done;
  }

  /** Boot: end the apps an earlier process's runs left running and remove
   * the folders (a base checkout among them) those runs left, then tick
   * every {@link CAMERA_TICK_MS}. */
  start(): void {
    if (this.timer !== null || this.disposed) return;
    const leftovers = join(mediaRoot(this.options.dataDir), '.camera');
    void endOrphanedCameraApps(this.options.budget, this.log)
      .then(() => {
        if (this.running === null) rmSync(leftovers, { recursive: true, force: true });
      })
      .catch((error: unknown) => {
        this.log('warn', 'pr media camera: the boot cleanup failed', { error: String(error instanceof Error ? error.message : error) });
      })
      .then(() => this.tick());
    this.timer = setInterval(() => void this.tick(), CAMERA_TICK_MS);
    this.timer.unref?.();
  }

  stop(): Promise<void> {
    return this.dispose();
  }

  /** One pass over the live jobs. Never throws; a job that fails is logged
   * and the rest still run. */
  async tick(): Promise<void> {
    if (this.ticking || this.disposed) return;
    this.ticking = true;
    try {
      const config = this.options.config();
      if (!config.enabled) return;
      const live = new Set<string>();
      for (const job of this.options.ledger.listJobs()) {
        if (isTerminalJobStatus(job.status) || job.status === 'parked') continue;
        live.add(job.id);
        try {
          await this.consider(job);
        } catch (error) {
          this.log('warn', 'pr media camera: a job could not be considered', { job: job.id, error: String(error instanceof Error ? error.message : error) });
        }
      }
      for (const jobId of [...this.facts.keys()]) if (!live.has(jobId)) this.facts.delete(jobId);
      for (const jobId of [...this.firstSeen.keys()]) if (!live.has(jobId)) this.firstSeen.delete(jobId);
    } finally {
      this.ticking = false;
    }
  }

  private async headFacts(jobId: string, lanePath: string, baseBranch: string | null, head: string): Promise<HeadFacts> {
    const cached = this.facts.get(jobId);
    if (cached !== undefined && cached.head === head) return cached;
    let manifest: WorktreeManifest | null = null;
    let manifestError: string | null = null;
    // The head's COMMITTED manifest: the one the head ships, never an edit
    // the lane has not committed.
    const shown = await this.git(lanePath, ['show', `${head}:${MANIFEST_PATH}`]);
    if (shown.code === 0) {
      try {
        manifest = parseWorktreeManifest(shown.stdout, `${head.slice(0, 12)}:${MANIFEST_PATH}`);
      } catch (error) {
        manifestError = bounded(String(error instanceof Error ? error.message : error));
      }
    }
    const capture = manifest?.capture ?? null;
    let mergeBase: string | null = null;
    let touched: { path: string; glob: string }[] = [];
    if (capture !== null) {
      try {
        const baseRef = resolveReviewBaseRef(lanePath, baseBranch);
        const base = await this.git(lanePath, ['merge-base', `${baseRef}^{commit}`, head]);
        if (base.code === 0 && /^[0-9a-f]{40}$/u.test(base.stdout.trim())) mergeBase = base.stdout.trim();
      } catch {
        mergeBase = null;
      }
      if (mergeBase !== null && capture.paths.length > 0) {
        const diff = await this.git(lanePath, ['diff', '--name-only', '--no-renames', '-z', mergeBase, head]);
        if (diff.code === 0) {
          const globs = capture.paths.map((pattern) => compileCaptureGlob(pattern));
          touched = [...touchedCapturePaths(globs, diff.stdout.split('\0').filter((path) => path !== ''))];
        }
      }
    }
    const facts: HeadFacts = { head, capture, manifest, manifestError, mergeBase, touched };
    this.facts.set(jobId, facts);
    return facts;
  }

  private filmingKey(jobId: string, head: string, shotList: string): string {
    return `${jobId} ${head} ${shotList}`;
  }

  /** The camera's standing for this head and script. */
  private cameraStanding(jobId: string, head: string, shotList: ShotList): { readonly state: CameraState; readonly detail: string | null; readonly due: boolean } {
    if (this.running !== null && this.running.jobId === jobId && this.running.head === head && this.running.shotList === shotList.sha256) {
      return { state: 'filming', detail: null, due: false };
    }
    const events = this.options.ledger.listJobEvents(jobId, {
      kinds: [MEDIA_CAPTURE_FILMED_EVENT, MEDIA_CAPTURE_FAILED_EVENT],
      order: 'desc',
      limit: 50,
    }).filter((event) => payloadOf(event)['head_sha'] === head && payloadOf(event)['shot_list_sha256'] === shotList.sha256);
    if (events.some((event) => event.kind === MEDIA_CAPTURE_FILMED_EVENT)) return { state: 'filmed', detail: null, due: false };
    const failures = events.filter((event) => !NOT_ATTEMPTS.has(payloadOf(event)['code'] as CameraFailureCode));
    const latest = failures[0];
    const detail = latest === undefined ? null : typeof payloadOf(latest)['detail'] === 'string' ? payloadOf(latest)['detail'] as string : null;
    if (latest !== undefined && (SCRIPT_FAULTS.has(payloadOf(latest)['code'] as CameraFailureCode) || failures.length >= CAMERA_MAX_ATTEMPTS)) {
      return { state: 'failed', detail, due: false };
    }
    const waited = latest === undefined || this.now() - Date.parse(latest.ts) >= CAMERA_RETRY_MS;
    const until = this.backoff.get(this.filmingKey(jobId, head, shotList.sha256));
    return { state: 'pending', detail, due: waited && (until === undefined || this.now() >= until) };
  }

  private async consider(job: { readonly id: string; readonly status: string; readonly baseBranch: string | null }): Promise<void> {
    const lanes = this.options.ledger.listWorktrees({ jobId: job.id }).filter((lane) => lane.kind === 'job' && lane.status !== 'swept');
    if (lanes.length !== 1) return;
    const lane = lanes[0]!;
    // Off the event loop: a tick reads every live lane.
    const [rev, status] = await Promise.all([
      this.git(lane.path, ['rev-parse', 'HEAD']),
      this.git(lane.path, ['status', '--porcelain', '--untracked-files=no']),
    ]);
    const head = rev.stdout.trim();
    if (rev.code !== 0 || status.code !== 0 || status.stdout.trim() !== '' || !/^[0-9a-f]{40}$/u.test(head)) return;
    const seen = this.firstSeen.get(job.id);
    if (seen === undefined || seen.head !== head) this.firstSeen.set(job.id, { head, at: this.now() });
    const facts = await this.headFacts(job.id, lane.path, job.baseBranch, head);
    if (facts.capture === null) return;

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
      camera = facts.capture.serve === null
        ? { state: 'unconfigured', detail: '[capture] declares no serve and ready, so GC cannot film this shot list: submit captures with POST /api/media instead', due: false }
        : this.cameraStanding(job.id, head, shotList);
    }
    this.recordCoverage(job.id, head, facts, shotList, refusal, items, camera);

    if (camera === null || !camera.due || shotList === null || this.running !== null || this.disposed) return;
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
    // Nothing to say: no path owes media and the minion directed nothing.
    if (touched.length === 0 && shotList === null && refusal === null) return;
    const skip = shotList === null ? null : shotListSkipReason(shotList);
    const state: CoverageState = touched.length === 0 ? 'not-owed' : items.length > 0 ? 'covered' : skip !== null ? 'skipped' : 'owed';
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
      detail: refusal ?? camera?.detail ?? null,
    };
    const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const latest = this.options.ledger.listJobEvents(jobId, { kinds: [MEDIA_COVERAGE_EVENT], order: 'desc', limit: 1 })[0];
    if (latest !== undefined && payloadOf(latest)['digest'] === digest) return;
    this.options.ledger.appendCustomEvent({ kind: MEDIA_COVERAGE_EVENT, jobId, payload: { ...payload, digest } });
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
    this.options.ledger.appendCustomEvent({ kind: MEDIA_CAPTURE_STARTED_EVENT, jobId, payload: { ...base, files: plans.length } });
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
          workDir: join(mediaRoot(this.options.dataDir), '.camera', runId),
          budget: this.options.budget,
          driver: this.options.driver,
          ...(this.options.ensureReady !== undefined ? { ensureReady: (signal: AbortSignal) => this.options.ensureReady!(jobId, signal) } : {}),
          gitState: this.gitState,
          setupTimeoutMs: this.options.setupTimeoutMs,
          signal: abort.signal,
          log: this.log,
        });
      } catch (error) {
        result = { kind: 'failed', code: 'serve_failed', detail: `the camera run failed unexpectedly: ${String(error instanceof Error ? error.message : error)}` };
      }
      this.settle(jobId, head, shotList, runId, base, result);
    })().finally(() => {
      if (this.running?.runId === runId) this.running = null;
    });
    this.running = { jobId, runId, head, shotList: shotList.sha256, abort, done };
  }

  private settle(
    jobId: string,
    head: string,
    shotList: ShotList,
    runId: string,
    base: Record<string, unknown>,
    result: CameraRunResult,
  ): void {
    const ledger = this.options.ledger;
    const fail = (code: CameraFailureCode | 'media_limit', detail: string): void => {
      if (code === 'dirty_tree') this.backoff.set(this.filmingKey(jobId, head, shotList.sha256), this.now() + CAMERA_DIRTY_BACKOFF_MS);
      if (code === 'stopped') return;
      ledger.appendCustomEvent({ kind: MEDIA_CAPTURE_FAILED_EVENT, jobId, payload: { ...base, code, detail: bounded(detail) } });
      this.log(code === 'head_moved' || code === 'dirty_tree' ? 'info' : 'warn', 'pr media camera: the shot list was not filmed', { job: jobId, run: runId, head, code, detail });
    };
    if (result.kind === 'failed') {
      fail(result.code, result.detail);
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
      fail('capture_invalid', `a filmed capture could not be stored: ${String(error instanceof Error ? error.message : error)}`);
      return;
    }
    ledger.appendCustomEvent({ kind: MEDIA_CAPTURE_FILMED_EVENT, jobId, payload: { ...base, media_ids: ids } });
  }
}
