import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, type EventRecord } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import type { PrMediaConfig } from '../src/config.js';
import type { CameraRunInput, CameraRunResult } from '../src/media/camera.js';
import {
  CAMERA_MAX_ATTEMPTS,
  CAMERA_RETRY_MS,
  CAMERA_SETTLE_MS,
  CAMERA_TICK_MS,
  CameraDirector,
  coverageAtHead,
  MEDIA_CAPTURE_FAILED_EVENT,
  MEDIA_CAPTURE_FILMED_EVENT,
  MEDIA_CAPTURE_STARTED_EVENT,
  MEDIA_COVERAGE_EVENT,
  type CameraLedger,
} from '../src/media/director.js';
import {
  coverageDigest,
  MEDIA_PUBLISH_SETTLE_MS,
  MEDIA_SECTION_BEGIN,
  ownerPrMediaView,
  PrMediaPublisher,
  type GhRunner,
} from '../src/media/publisher.js';
import { cameraView } from '../src/media/server.js';
import { SHOT_LIST_FILE, shotListPath } from '../src/media/shot-list.js';
import { listMedia, mediaAtHead, mediaRoot, storeMedia } from '../src/media/store.js';
import type { VerificationBudget } from '../src/verify/server.js';
import { minimalPng } from './helpers/images.js';

/**
 * The camera director (PR media PR 2): each tick decides whether the lane's
 * committed head owes media (owner ruling Q4: `[capture] paths` globs plus
 * skip reasons, journaled as `media.coverage`) and films the minion's shot
 * list at that head (Q1 option C), re-shooting when the head or the list
 * changes. The real camera is replaced by a recorded `film` seam; git, the
 * ledger and the store are real.
 */

const ON: PrMediaConfig = { enabled: true, publish: 'autonomous' };
const PR = 'https://github.com/widget-co/widget-shop/pull/42';
const dirs: string[] = [];
const dbs: LedgerDb[] = [];

afterEach(() => {
  while (dbs.length > 0) dbs.pop()!.close();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=GC Test', '-c', 'user.email=gc-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf-8',
  }).trim();
}

const CAPTURE = '[capture]\npaths = ["web/**"]\nserve = "node app.mjs {port}"\nready = "http://127.0.0.1:{port}/"\n';

interface World {
  readonly api: LedgerApi;
  readonly dataDir: string;
  readonly lane: string;
  readonly director: CameraDirector;
  readonly films: CameraRunInput[];
  readonly delivered: Map<string, string>;
  now: number;
  next: (input: CameraRunInput) => CameraRunResult | Promise<CameraRunResult>;
  config: PrMediaConfig;
}

/** A job lane whose head commits `web/card.ts` over a `main` base. */
function world(manifest = CAPTURE, opts: { readonly baseManifest?: string; readonly baseBranch?: string } = {}): World {
  const dataDir = tmp('gru-camera-director-data-');
  const lane = tmp('gru-camera-director-lane-');
  git(lane, 'init', '-q', '-b', 'main');
  writeFileSync(join(lane, 'README.md'), 'widget shop\n');
  if (opts.baseManifest !== undefined) {
    mkdirSync(join(lane, '.gru-command'));
    writeFileSync(join(lane, '.gru-command', 'worktree.toml'), opts.baseManifest);
  }
  git(lane, 'add', '.');
  git(lane, 'commit', '-q', '-m', 'base');
  git(lane, 'checkout', '-q', '-b', 'gru/j-ui');
  mkdirSync(join(lane, '.gru-command'), { recursive: true });
  writeFileSync(join(lane, '.gru-command', 'worktree.toml'), manifest);
  mkdirSync(join(lane, 'web'));
  writeFileSync(join(lane, 'web', 'card.ts'), 'export const card = 1;\n');
  git(lane, 'add', '.');
  git(lane, 'commit', '-q', '-m', 'card');
  const db = new LedgerDb(dataDir);
  dbs.push(db);
  const api = new LedgerApi(db.handle, { bus: new EventBus() });
  api.addJob({ id: 'j-ui', repo: 'widget-shop', title: 'Plain-language cards', baseBranch: opts.baseBranch ?? 'main' });
  api.setJobPr('j-ui', PR);
  const delivered = new Map<string, string>();
  const port: CameraLedger = {
    appendCustomEvent: (fields) => api.appendCustomEvent(fields),
    listJobEvents: (jobId, opts) => api.listJobEvents(jobId, opts),
    latestEventByPayloadField: (kind, field, value) => api.latestEventByPayloadField(kind, field, value),
    listJobs: () => api.listJobs(),
    listWorktrees: ({ jobId }) => (jobId === 'j-ui' ? [{ kind: 'job', path: lane, repoPath: lane, status: 'active' }] : []),
    latestCandidateDelivery: (jobId) => {
      const sha = delivered.get(jobId);
      return sha === undefined ? null : ({ seq: 1, ts: new Date().toISOString(), kind: 'job.delivered', agentId: null, jobId, roundId: null, lens: null, payload: { sha } } satisfies EventRecord);
    },
  };
  const films: CameraRunInput[] = [];
  const w: World = {
    api, dataDir, lane, films, delivered,
    // The director's own clock: its waits are measured on it alone.
    now: 1_800_000_000_000,
    next: (input) => ({ kind: 'filmed', files: input.plans.map((plan) => ({ plan, bytes: minimalPng() })) }),
    config: ON,
    director: undefined as unknown as CameraDirector,
  };
  (w as { director: CameraDirector }).director = new CameraDirector({
    ledger: port,
    dataDir,
    config: () => w.config,
    budget: () => ({ restored: () => [] }) as unknown as VerificationBudget,
    driver: { probe: async () => null, shoot: async () => {} },
    setupTimeoutMs: 1_000,
    now: () => w.now,
    film: async (input) => {
      films.push(input);
      return await w.next(input);
    },
  });
  return w;
}

function head(w: World): string {
  return git(w.lane, 'rev-parse', 'HEAD');
}

function writeShotList(w: World, value: unknown): void {
  const path = shotListPath(w.dataDir, w.lane, 'j-ui');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}

const SHOTS = {
  version: 1,
  shots: [{ id: 'card', proves: 'AC1: the card reads plainly', kind: 'screenshot', viewports: ['desktop', 'mobile'], steps: [{ open: '/' }] }],
};

async function tick(w: World): Promise<void> {
  await w.director.tick();
  await w.director.idle();
}

function events(w: World, kind: string): readonly Record<string, unknown>[] {
  return w.api.listJobEvents('j-ui', { kinds: [kind], order: 'asc' }).map((event) => event.payload as Record<string, unknown>);
}

function commit(w: World, file: string, text: string): string {
  mkdirSync(join(w.lane, file, '..'), { recursive: true });
  writeFileSync(join(w.lane, file), text);
  git(w.lane, 'add', '.');
  git(w.lane, 'commit', '-q', '-m', `edit ${file}`);
  return head(w);
}

describe('media coverage (owner ruling Q4)', () => {
  it('journals a head that touches [capture] paths with no media and no skip reason as owed, once per change', async () => {
    const w = world();
    await tick(w);
    await tick(w);
    const coverage = events(w, MEDIA_COVERAGE_EVENT);
    expect(coverage).toHaveLength(1);
    expect(coverage[0]).toMatchObject({
      head_sha: head(w), state: 'owed', touched: 1, paths: ['web/card.ts'], globs: ['web/**'], skip: null, shot_list: 'absent', camera: null, detail: null,
    });
    expect(coverageAtHead(w.api, 'j-ui', head(w))).toMatchObject({ state: 'owed', touched: 1 });
    // A minion's own capture at the head covers it.
    storeMedia({ dataDir: w.dataDir, ledger: w.api, jobId: 'j-ui', headSha: head(w), caption: 'The card', role: 'after', bytes: minimalPng() });
    await tick(w);
    expect(coverageAtHead(w.api, 'j-ui', head(w))?.state).toBe('covered');
    expect(w.films).toHaveLength(0);
  });

  it('records nothing for a head that touches no capture path, and nothing at all without a [capture] table', async () => {
    const w = world('[capture]\npaths = ["docs/**"]\n');
    await tick(w);
    expect(events(w, MEDIA_COVERAGE_EVENT)).toEqual([]);
    const bare = world('[verify]\nfull = "true"\n');
    writeShotList(bare, SHOTS);
    await tick(bare);
    expect(events(bare, MEDIA_COVERAGE_EVENT)).toEqual([]);
    expect(bare.films).toHaveLength(0);
  });

  it('takes the shot list\'s skip reason, and names a refused shot list', async () => {
    const w = world();
    writeShotList(w, { version: 1, skip: 'only renames an internal helper' });
    await tick(w);
    expect(coverageAtHead(w.api, 'j-ui', head(w))).toMatchObject({ state: 'skipped', skip: 'only renames an internal helper', shotList: 'valid', camera: null });
    writeShotList(w, { version: 1, shots: [{ id: 'Bad' }] });
    await tick(w);
    const refused = coverageAtHead(w.api, 'j-ui', head(w));
    expect(refused).toMatchObject({ state: 'owed', shotList: 'refused' });
    expect(refused?.detail).toMatch(/^shot_list_invalid: shot-list\.json shots\[0\]\.id must be/u);
  });

  it('judges a diff by the base\'s capture paths as well as the head\'s, so a diff cannot narrow them away', async () => {
    const narrowed = world('[capture]\npaths = ["docs/**"]\n', { baseManifest: '[capture]\npaths = ["web/**"]\n' });
    await tick(narrowed);
    expect(coverageAtHead(narrowed.api, 'j-ui', head(narrowed))).toMatchObject({ state: 'owed', paths: ['web/card.ts'], globs: ['web/**'] });
    const excluded = world('[capture]\npaths = ["web/**", "!web/card.ts"]\n', { baseManifest: '[capture]\npaths = ["web/**"]\n' });
    await tick(excluded);
    expect(coverageAtHead(excluded.api, 'j-ui', head(excluded))).toMatchObject({ state: 'owed', paths: ['web/card.ts'] });
    const removed = world('[verify]\nfull = "true"\n', { baseManifest: '[capture]\npaths = ["web/**"]\n' });
    await tick(removed);
    expect(coverageAtHead(removed.api, 'j-ui', head(removed))).toMatchObject({ state: 'owed' });
  });

  it('says owing is unknown, with the reason, when it cannot be decided, and decides once it can', async () => {
    const broken = world('[capture]\npaths = ["!web/**"]\n');
    await tick(broken);
    expect(coverageAtHead(broken.api, 'j-ui', head(broken))).toMatchObject({ state: 'unknown', detail: expect.stringMatching(/^manifest_invalid: worktree manifest [0-9a-f]{12}:\.gru-command\/worktree\.toml \[capture\] paths lists only exclusions/u) });
    const baseless = world(CAPTURE, { baseBranch: 'release' });
    await tick(baseless);
    expect(coverageAtHead(baseless.api, 'j-ui', head(baseless))).toMatchObject({ state: 'unknown', detail: expect.stringContaining('the merge base could not be found') });
    // Not remembered as "nothing owed": the base appears, and the head is decided.
    git(baseless.lane, 'branch', 'release', 'main');
    await tick(baseless);
    expect(coverageAtHead(baseless.api, 'j-ui', head(baseless))).toMatchObject({ state: 'owed', touched: 1 });
    // Decided with nothing owed: the unknown record is set straight.
    const quiet = world('[capture]\npaths = ["docs/**"]\n', { baseBranch: 'release' });
    await tick(quiet);
    expect(coverageAtHead(quiet.api, 'j-ui', head(quiet))?.state).toBe('unknown');
    git(quiet.lane, 'branch', 'release', 'main');
    await tick(quiet);
    expect(coverageAtHead(quiet.api, 'j-ui', head(quiet))).toMatchObject({ state: 'not-owed', touched: 0, detail: null });
  });

  it('records not-owed for a shot list on a head that touches no capture path', async () => {
    const w = world('[capture]\npaths = ["docs/**"]\nserve = "node app.mjs {port}"\nready = "output:up"\n');
    writeShotList(w, SHOTS);
    w.delivered.set('j-ui', head(w));
    await tick(w);
    expect(coverageAtHead(w.api, 'j-ui', head(w))).toMatchObject({ state: 'not-owed', touched: 0, camera: 'filmed' });
    expect(w.films).toHaveLength(1);
  });

  it('pins the documented timings: 30 s ticks, 60 s settle, 3 attempts 10 minutes apart', () => {
    expect([CAMERA_TICK_MS, CAMERA_SETTLE_MS, CAMERA_MAX_ATTEMPTS, CAMERA_RETRY_MS]).toEqual([30_000, 60_000, 3, 600_000]);
  });

  it('says the camera cannot film a shot list when [capture] has no serve', async () => {
    const w = world('[capture]\npaths = ["web/**"]\n');
    writeShotList(w, SHOTS);
    w.delivered.set('j-ui', head(w));
    await tick(w);
    expect(w.films).toHaveLength(0);
    expect(coverageAtHead(w.api, 'j-ui', head(w))).toMatchObject({ state: 'owed', camera: 'unconfigured', detail: expect.stringContaining('submit captures with POST /api/media') });
  });
});

describe('filming the shot list (owner ruling Q1, option C)', () => {
  it('films the delivered head once, stores every file as a GC capture of one run, and covers the head', async () => {
    const w = world();
    writeShotList(w, SHOTS);
    w.api.setJobStatus('j-ui', 'working');
    await tick(w);
    // The minion is still working and has not delivered: nothing is filmed.
    expect(w.films).toHaveLength(0);
    expect(coverageAtHead(w.api, 'j-ui', head(w))).toMatchObject({ state: 'owed', camera: 'pending' });
    w.delivered.set('j-ui', head(w));
    await tick(w);
    expect(w.films).toHaveLength(1);
    const film = w.films[0]!;
    expect(film).toMatchObject({ jobId: 'j-ui', lanePath: w.lane, repoPath: w.lane, headSha: head(w), baseSha: git(w.lane, 'rev-parse', 'main') });
    expect(film.runId).toMatch(/^cr-[0-9a-f-]{36}$/u);
    expect(film.capture.serve).toBe('node app.mjs {port}');
    expect(film.plans.map((plan) => plan.viewport.name)).toEqual(['desktop', 'mobile']);
    const items = mediaAtHead(listMedia(w.api, 'j-ui'), head(w));
    expect(items.map((item) => [item.capturedBy, item.shot?.runId, item.shot?.shotId, item.shot?.viewport, item.caption])).toEqual([
      ['gc', film.runId, 'card', 'desktop', 'AC1: the card reads plainly · desktop'],
      ['gc', film.runId, 'card', 'mobile', 'AC1: the card reads plainly · mobile'],
    ]);
    expect(events(w, MEDIA_CAPTURE_STARTED_EVENT)).toEqual([expect.objectContaining({ run_id: film.runId, head_sha: head(w), files: 2 })]);
    expect(events(w, MEDIA_CAPTURE_FILMED_EVENT)).toEqual([expect.objectContaining({ run_id: film.runId, media_ids: items.map((item) => item.id) })]);
    await tick(w);
    expect(coverageAtHead(w.api, 'j-ui', head(w))).toMatchObject({ state: 'covered', camera: 'filmed' });
    // Filmed once: the same head and script are not filmed again.
    await tick(w);
    expect(w.films).toHaveLength(1);
  });

  it('films a head that has stood still once the attempt is closed, and not before the settle window', async () => {
    const w = world();
    writeShotList(w, SHOTS);
    w.api.setJobStatus('j-ui', 'working');
    w.api.setJobStatus('j-ui', 'delivered');
    await tick(w);
    expect(w.films).toHaveLength(0);
    w.now += CAMERA_SETTLE_MS;
    await tick(w);
    expect(w.films).toHaveLength(1);
  });

  it('re-shoots when the head moves and when the shot list changes at the same head, showing only the newest run', async () => {
    const w = world();
    writeShotList(w, SHOTS);
    const first = head(w);
    w.delivered.set('j-ui', first);
    await tick(w);
    const second = commit(w, 'web/card.ts', 'export const card = 2;\n');
    w.delivered.set('j-ui', second);
    await tick(w);
    expect(w.films.map((film) => film.headSha)).toEqual([first, second]);
    writeShotList(w, { version: 1, shots: [{ ...SHOTS.shots[0], viewports: ['tablet'] }] });
    await tick(w);
    expect(w.films).toHaveLength(3);
    expect(w.films[2]!.headSha).toBe(second);
    const current = mediaAtHead(listMedia(w.api, 'j-ui'), second);
    expect(current.map((item) => item.shot?.viewport)).toEqual(['tablet']);
    expect(current[0]!.shot?.runId).toBe(w.films[2]!.runId);
  });

  it('treats a script fault as final, retries an infrastructure fault three times ten minutes apart, and never counts a moved head', async () => {
    const step = world();
    writeShotList(step, SHOTS);
    step.delivered.set('j-ui', head(step));
    step.next = () => ({ kind: 'failed', code: 'step_failed', detail: 'shot "card" step 1 (open "/") failed at desktop: net::ERR_CONNECTION_REFUSED' });
    await tick(step);
    step.now += CAMERA_RETRY_MS * 2;
    await tick(step);
    expect(step.films).toHaveLength(1);
    expect(coverageAtHead(step.api, 'j-ui', head(step))).toMatchObject({ camera: 'failed', detail: expect.stringContaining('ERR_CONNECTION_REFUSED') });
    // A fixed shot list is a new script: filmed again at the same head.
    writeShotList(step, { version: 1, shots: [{ ...SHOTS.shots[0], steps: [{ open: '/home' }] }] });
    step.next = (input) => ({ kind: 'filmed', files: input.plans.map((plan) => ({ plan, bytes: minimalPng() })) });
    await tick(step);
    expect(step.films).toHaveLength(2);

    const infra = world();
    writeShotList(infra, SHOTS);
    infra.delivered.set('j-ui', head(infra));
    infra.next = () => ({ kind: 'failed', code: 'serve_failed', detail: '[capture] serve exited (code 1) before it was ready: EADDRINUSE' });
    await tick(infra);
    await tick(infra);
    expect(infra.films).toHaveLength(1);
    for (let attempt = 2; attempt <= CAMERA_MAX_ATTEMPTS + 1; attempt += 1) {
      infra.now += CAMERA_RETRY_MS;
      await tick(infra);
    }
    expect(infra.films).toHaveLength(CAMERA_MAX_ATTEMPTS);
    expect(events(infra, MEDIA_CAPTURE_FAILED_EVENT).map((event) => event['code'])).toEqual(['serve_failed', 'serve_failed', 'serve_failed']);
    expect(coverageAtHead(infra.api, 'j-ui', head(infra))).toMatchObject({ camera: 'failed' });

    const moved = world();
    writeShotList(moved, SHOTS);
    moved.delivered.set('j-ui', head(moved));
    moved.next = () => ({ kind: 'failed', code: 'head_moved', detail: 'the lane moved' });
    await tick(moved);
    // Not an attempt, but not repeated at once either: it rests like a head settling.
    await tick(moved);
    expect(moved.films).toHaveLength(1);
    for (let run = 1; run < CAMERA_MAX_ATTEMPTS + 1; run += 1) {
      moved.now += CAMERA_SETTLE_MS;
      await tick(moved);
    }
    expect(moved.films).toHaveLength(CAMERA_MAX_ATTEMPTS + 1);
    expect(coverageAtHead(moved.api, 'j-ui', head(moved))?.camera).toBe('pending');
  });

  it('counts a run cut short by a crash as an attempt, so a crash can never loop, and retries a store that failed', async () => {
    const crashed = world();
    writeShotList(crashed, SHOTS);
    crashed.delivered.set('j-ui', head(crashed));
    const sha = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(SHOTS)).digest('hex');
    for (let run = 0; run < CAMERA_MAX_ATTEMPTS; run += 1) {
      crashed.api.appendCustomEvent({ kind: MEDIA_CAPTURE_STARTED_EVENT, jobId: 'j-ui', payload: { run_id: `cr-0000000${run}-0000-4000-8000-000000000000`, head_sha: head(crashed), shot_list_sha256: sha, files: 2 } });
    }
    await tick(crashed);
    expect(crashed.films).toHaveLength(0);
    expect(coverageAtHead(crashed.api, 'j-ui', head(crashed))).toMatchObject({ camera: 'failed', detail: 'an earlier run was cut short before it finished' });

    const full = world();
    writeShotList(full, SHOTS);
    full.delivered.set('j-ui', head(full));
    const append = full.api.appendCustomEvent.bind(full.api);
    let diskFull = true;
    full.api.appendCustomEvent = ((fields: Parameters<LedgerApi['appendCustomEvent']>[0]) => {
      if (diskFull && fields.kind === 'media.captured') throw new Error('SQLITE_FULL: database or disk is full');
      return append(fields);
    }) as LedgerApi['appendCustomEvent'];
    await tick(full);
    expect(events(full, MEDIA_CAPTURE_FAILED_EVENT)).toEqual([expect.objectContaining({ code: 'store_failed', detail: expect.stringContaining('SQLITE_FULL') })]);
    diskFull = false;
    full.now += CAMERA_RETRY_MS;
    await tick(full);
    expect(full.films).toHaveLength(2);
    expect(events(full, MEDIA_CAPTURE_FILMED_EVENT)).toHaveLength(1);
  });

  it('never leaves an unhandled rejection: a settle or a tick that cannot write is logged', async () => {
    const w = world();
    writeShotList(w, SHOTS);
    w.delivered.set('j-ui', head(w));
    const logged: string[] = [];
    const append = w.api.appendCustomEvent.bind(w.api);
    w.api.appendCustomEvent = ((fields: Parameters<LedgerApi['appendCustomEvent']>[0]) => {
      if (fields.kind === MEDIA_CAPTURE_FAILED_EVENT) throw new Error('SQLITE_BUSY');
      return append(fields);
    }) as LedgerApi['appendCustomEvent'];
    (w.director as unknown as { log: (level: string, msg: string) => void }).log = (_level, msg) => logged.push(msg);
    w.next = () => ({ kind: 'failed', code: 'serve_failed', detail: 'boom' });
    await tick(w);
    expect(logged).toContain('pr media camera: a run could not be settled');
    w.api.listJobs = () => { throw new Error('the ledger is closed'); };
    await expect(w.director.tick()).resolves.toBeUndefined();
    expect(logged).toContain('pr media camera: the tick failed');
  });

  it('judges a lane mid-edit by its committed head but films it once it commits, and records a run the service stopped as no attempt', async () => {
    const w = world();
    writeShotList(w, SHOTS);
    w.delivered.set('j-ui', head(w));
    writeFileSync(join(w.lane, 'web', 'card.ts'), 'export const card = 3;\n');
    await tick(w);
    expect(w.films).toHaveLength(0);
    expect(coverageAtHead(w.api, 'j-ui', head(w))).toMatchObject({ state: 'owed', camera: 'pending' });
    git(w.lane, 'checkout', '--', 'web/card.ts');
    w.next = () => ({ kind: 'failed', code: 'stopped', detail: 'the service is stopping' });
    await tick(w);
    expect(w.films).toHaveLength(1);
    expect(events(w, MEDIA_CAPTURE_FAILED_EVENT)).toEqual([expect.objectContaining({ code: 'stopped' })]);
    expect(coverageAtHead(w.api, 'j-ui', head(w))).toMatchObject({ state: 'owed', camera: 'pending', detail: null });
  });

  it('refuses to store a run that would pass the per-head cap with the minion\'s captures, as final', async () => {
    const w = world();
    writeShotList(w, SHOTS);
    w.delivered.set('j-ui', head(w));
    for (let index = 0; index < 7; index += 1) {
      storeMedia({ dataDir: w.dataDir, ledger: w.api, jobId: 'j-ui', headSha: head(w), caption: `direct ${index}`, role: 'after', bytes: minimalPng() });
    }
    await tick(w);
    expect(events(w, MEDIA_CAPTURE_FAILED_EVENT)).toEqual([expect.objectContaining({ code: 'media_limit' })]);
    expect(listMedia(w.api, 'j-ui').filter((item) => item.capturedBy === 'gc')).toEqual([]);
    w.now += CAMERA_RETRY_MS;
    await tick(w);
    expect(w.films).toHaveLength(1);
  });

  it('films nothing with [pr_media] off or for a parked or closed job (a parked one keeps its coverage), stops a run whose job is parked, and on dispose', async () => {
    const w = world();
    writeShotList(w, SHOTS);
    w.delivered.set('j-ui', head(w));
    w.config = { enabled: false, publish: 'autonomous' };
    await tick(w);
    expect(events(w, MEDIA_COVERAGE_EVENT)).toEqual([]);
    w.config = ON;
    w.api.setJobStatus('j-ui', 'parked');
    await tick(w);
    expect(w.films).toHaveLength(0);
    expect(coverageAtHead(w.api, 'j-ui', head(w))).toMatchObject({ state: 'owed', camera: 'pending' });
    w.api.setJobStatus('j-ui', 'in-review');
    // Parking the job mid-run stops the run; nothing is recorded or stored.
    let parkedSignal: AbortSignal | null = null;
    let finish: (result: CameraRunResult) => void = () => {};
    w.next = (input) => {
      parkedSignal = input.signal;
      input.signal.addEventListener('abort', () => finish({ kind: 'failed', code: 'stopped', detail: 'the service is stopping' }), { once: true });
      return new Promise<CameraRunResult>((resolveFilm) => {
        finish = resolveFilm;
      });
    };
    await w.director.tick();
    expect(w.films).toHaveLength(1);
    w.api.setJobStatus('j-ui', 'parked');
    await w.director.tick();
    await w.director.idle();
    expect((parkedSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(events(w, MEDIA_CAPTURE_FAILED_EVENT)).toEqual([expect.objectContaining({ code: 'stopped' })]);
    w.api.setJobStatus('j-ui', 'in-review');
    w.now += CAMERA_SETTLE_MS;
    let release: (result: CameraRunResult) => void = () => {};
    let seen: AbortSignal | null = null;
    w.next = (input) => {
      seen = input.signal;
      return new Promise<CameraRunResult>((resolveFilm) => {
        release = resolveFilm;
      });
    };
    await w.director.tick();
    expect(w.director.inFlight()).not.toBeNull();
    // Another tick while the run is in flight starts no second run.
    await w.director.tick();
    expect(w.films).toHaveLength(2);
    const disposed = w.director.dispose();
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
    release({ kind: 'failed', code: 'stopped', detail: 'the service is stopping' });
    await disposed;
    expect(w.director.inFlight()).toBeNull();
    expect(events(w, MEDIA_CAPTURE_FAILED_EVENT).map((event) => event['code'])).toEqual(['stopped', 'stopped']);
    // A closed job is not considered at all.
    const closed = world();
    closed.api.setJobStatus('j-ui', 'binned');
    await tick(closed);
    expect(events(closed, MEDIA_COVERAGE_EVENT)).toEqual([]);
  });
});

describe('the director\'s lifecycle', () => {
  it('a boot removes the folders runs of an earlier process left before any tick runs, then ticks; stop ends the timer', async () => {
    const w = world();
    const leftover = join(mediaRoot(w.dataDir), '.camera', 'cr-44444444-4444-4444-8444-444444444444', 'base');
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, 'version.txt'), 'base\n');
    w.director.start();
    // A tick asked for during the cleanup (a delivery) waits for it.
    w.director.requestTick();
    await w.director.tick();
    expect(events(w, MEDIA_COVERAGE_EVENT)).toEqual([]);
    // The boot lists the host's processes (ps and lsof) first: slow on a
    // loaded host.
    await vi.waitFor(() => {
      expect(existsSync(join(mediaRoot(w.dataDir), '.camera'))).toBe(false);
      expect(events(w, MEDIA_COVERAGE_EVENT)).toHaveLength(1);
    }, { timeout: 20_000, interval: 50 });
    await w.director.stop();
    // A stopped director ticks no more.
    await w.director.tick();
    expect(events(w, MEDIA_COVERAGE_EVENT)).toHaveLength(1);
  });
});

describe('where coverage shows', () => {
  function ghFake(pr: { body: string; head: string }): { gh: GhRunner; edits: string[] } {
    const edits: string[] = [];
    const gh: GhRunner = async (args) => {
      if (args[0] === '--version') return { code: 0, stdout: 'gh version 2.101.0 (2026-09-15)\n', stderr: '' };
      if (args[0] === 'pr' && args[1] === 'view') return { code: 0, stdout: JSON.stringify({ body: pr.body, headRefOid: pr.head, state: 'OPEN' }), stderr: '' };
      if (args[0] === 'pr' && args[1] === 'edit') {
        const { readFileSync } = await import('node:fs');
        let body = readFileSync(args[args.indexOf('--body-file') + 1]!, 'utf-8');
        // gh uploads each attachment and rewrites its reference.
        args.forEach((arg, index) => {
          if (args[index - 1] === '--attach') body = body.split(`](${arg})`).join(`](https://github.com/user-attachments/assets/a-${index})`);
        });
        pr.body = body;
        edits.push(pr.body);
        return { code: 0, stdout: PR, stderr: '' };
      }
      throw new Error(`unexpected gh call ${args.join(' ')}`);
    };
    return { gh, edits };
  }

  function observe(w: World, sha: string): void {
    w.api.appendCustomEvent({
      kind: 'github.branch-state',
      jobId: 'j-ui',
      payload: { repo: 'widget-co/widget-shop', branch: 'gru/j-ui', sha, merged: false, pr_open: true, mergeable_state: 'clean', pr_number: 42, pr_url: PR, merge_commit_sha: null, ci: null },
    });
  }

  it('the FOR YOU block carries the head\'s coverage, with captures or without', async () => {
    const w = world();
    await tick(w);
    const row = { jobId: 'j-ui', prUrl: PR, sha: head(w) };
    expect(ownerPrMediaView(w.api, row, ON, true)).toEqual({
      headSha: head(w),
      items: [],
      superseded: 0,
      publication: null,
      coverage: { state: 'owed', touched: 1, paths: ['web/card.ts'], skip: null, camera: null, detail: null },
    });
    // Another head's coverage is never shown against this one.
    expect(ownerPrMediaView(w.api, { ...row, sha: 'd'.repeat(40) }, ON, true)).toBeNull();
    // With a capture: the item and the coverage that now says covered.
    const item = storeMedia({ dataDir: w.dataDir, ledger: w.api, jobId: 'j-ui', headSha: head(w), caption: 'The card', role: 'after', bytes: minimalPng() });
    await tick(w);
    expect(ownerPrMediaView(w.api, row, ON, true)).toMatchObject({
      items: [{ id: item.id, capturedBy: 'minion', caption: 'The card' }],
      superseded: 0,
      coverage: { state: 'covered', touched: 1 },
    });
  });

  it('the PR section says media is owed, then shows the captures once they land, and says when an owed note goes stale', async () => {
    const w = world();
    const first = head(w);
    await tick(w);
    observe(w, first);
    const pr = { body: 'Fixes the card wording.', head: first };
    const { gh, edits } = ghFake(pr);
    // The publisher's clock runs against the ledger's real stamps.
    let clock = Date.now();
    const publisher = new PrMediaPublisher({ ledger: w.api, dataDir: w.dataDir, config: () => ON, gh, now: () => clock });
    // A fresh coverage settles first, as fresh captures do.
    await publisher.pollOnce();
    expect(edits).toHaveLength(0);
    clock = Date.now() + MEDIA_PUBLISH_SETTLE_MS + 1_000;
    await publisher.pollOnce();
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain(MEDIA_SECTION_BEGIN);
    expect(edits[0]).toMatch(/Media owed: this PR changes 1 file under the repository's capture paths \(web\/card\\\.ts\) but has no captures and no skip reason at `[0-9a-f]{12}`/u);
    expect(edits[0]!.startsWith('Fixes the card wording.')).toBe(true);
    const coverage = coverageAtHead(w.api, 'j-ui', first)!;
    expect(w.api.latestJobEvent('j-ui', 'media.published')?.payload).toMatchObject({ kind: 'owed', digest: coverageDigest(PR, first, coverage), captures_head: null });
    // Unchanged: not written again.
    await publisher.pollOnce();
    expect(edits).toHaveLength(1);
    // A capture lands at the head: the captures replace the note.
    storeMedia({ dataDir: w.dataDir, ledger: w.api, jobId: 'j-ui', headSha: first, caption: 'The plain card', role: 'after', bytes: minimalPng() });
    await tick(w);
    clock = Date.now() + MEDIA_PUBLISH_SETTLE_MS + 1_000;
    await publisher.pollOnce();
    expect(edits).toHaveLength(2);
    expect(edits[1]).toContain('**After:** The plain card');
    expect(edits[1]).not.toContain('Media owed');
    // The head moves to one that owes nothing (its diff no longer touches
    // the paths) while the owed note of another job state stood: say so.
    const w2 = world();
    const owedHead = head(w2);
    await tick(w2);
    observe(w2, owedHead);
    const pr2 = { body: '', head: owedHead };
    const second = ghFake(pr2);
    let clock2 = Date.now() + MEDIA_PUBLISH_SETTLE_MS + 1_000;
    const publisher2 = new PrMediaPublisher({ ledger: w2.api, dataDir: w2.dataDir, config: () => ON, gh: second.gh, now: () => clock2 });
    await publisher2.pollOnce();
    expect(second.edits.at(-1)).toContain('Media owed');
    git(w2.lane, 'rm', '-q', 'web/card.ts');
    const reverted = commit(w2, 'README.md', 'widget shop, renamed\n');
    writeShotList(w2, { version: 1, skip: 'nothing to see' });
    await tick(w2);
    pr2.head = reverted;
    observe(w2, reverted);
    clock2 += 1_000;
    await publisher2.pollOnce();
    expect(second.edits.at(-1)).toMatch(/The note shown here earlier was written for `[0-9a-f]{12}`; this PR is now at `[0-9a-f]{12}`\._/u);
  });

  it('starts no run once the service has begun stopping, even from a pass already under way', async () => {
    const w = world();
    writeShotList(w, SHOTS);
    w.delivered.set('j-ui', head(w));
    let disposing: Promise<void> | null = null;
    const films: CameraRunInput[] = [];
    // The pass is reading the lane's status when shutdown begins.
    const director = new CameraDirector({
      ledger: {
        appendCustomEvent: (fields) => w.api.appendCustomEvent(fields),
        listJobEvents: (jobId, opts) => w.api.listJobEvents(jobId, opts),
        latestEventByPayloadField: (kind, field, value) => w.api.latestEventByPayloadField(kind, field, value),
        listJobs: () => w.api.listJobs(),
        listWorktrees: () => [{ kind: 'job', path: w.lane, repoPath: w.lane, status: 'active' }],
        latestCandidateDelivery: () => ({ seq: 1, ts: new Date().toISOString(), kind: 'job.delivered', agentId: null, jobId: 'j-ui', roundId: null, lens: null, payload: { sha: head(w) } }),
      },
      dataDir: w.dataDir,
      config: () => ON,
      budget: () => ({ restored: () => [] }) as unknown as VerificationBudget,
      driver: { probe: async () => null, shoot: async () => {} },
      setupTimeoutMs: 1_000,
      git: async (cwd, args) => {
        if (args[0] === 'status' && disposing === null) disposing = director.dispose();
        try {
          return { code: 0, stdout: execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }) };
        } catch (error) {
          return { code: (error as { status?: number }).status ?? -1, stdout: '' };
        }
      },
      film: async (input) => {
        films.push(input);
        return { kind: 'filmed', files: [] };
      },
    });
    await director.tick();
    expect(disposing).not.toBeNull();
    await disposing;
    expect(films).toEqual([]);
    expect(events(w, MEDIA_CAPTURE_STARTED_EVENT)).toEqual([]);
  });

  it('journals a stop at shutdown at once, so a run still cleaning up when the service exits is no crash', async () => {
    const w = world();
    writeShotList(w, SHOTS);
    w.delivered.set('j-ui', head(w));
    let finish: (result: CameraRunResult) => void = () => {};
    w.next = () => new Promise<CameraRunResult>((resolveFilm) => {
      finish = resolveFilm;
    });
    await w.director.tick();
    const disposing = w.director.dispose();
    // Before the run itself has finished: the stop is on record.
    expect(events(w, MEDIA_CAPTURE_FAILED_EVENT)).toEqual([expect.objectContaining({ code: 'stopped' })]);
    finish({ kind: 'failed', code: 'stopped', detail: 'the service is stopping' });
    await disposing;
    expect(events(w, MEDIA_CAPTURE_FAILED_EVENT)).toHaveLength(1);
  });

  it('the PR section holds an owed note while GC is still to film the head', async () => {
    const w = world();
    writeShotList(w, SHOTS);
    w.api.setJobStatus('j-ui', 'working');
    await tick(w);
    expect(coverageAtHead(w.api, 'j-ui', head(w))).toMatchObject({ state: 'owed', camera: 'pending' });
    observe(w, head(w));
    const pr = { body: 'Fixes the card wording.', head: head(w) };
    const { gh, edits } = ghFake(pr);
    const publisher = new PrMediaPublisher({ ledger: w.api, dataDir: w.dataDir, config: () => ON, gh, now: () => Date.now() + MEDIA_PUBLISH_SETTLE_MS + 1_000 });
    await publisher.pollOnce();
    expect(edits).toEqual([]);
    // A parked job is never filmed: the owed note is written.
    w.api.setJobStatus('j-ui', 'parked');
    await publisher.pollOnce();
    expect(edits).toEqual([expect.stringContaining('Media owed')]);
  });

  it('the PR section carries a shot list\'s skip reason, markdown-inert', async () => {
    const w = world();
    writeShotList(w, { version: 1, skip: 'renames [an](https://evil.example) internal @helper' });
    await tick(w);
    observe(w, head(w));
    const pr = { body: '', head: head(w) };
    const { gh, edits } = ghFake(pr);
    w.now = Date.now() + MEDIA_PUBLISH_SETTLE_MS + 1_000;
    await new PrMediaPublisher({ ledger: w.api, dataDir: w.dataDir, config: () => ON, gh, now: () => w.now }).pollOnce();
    expect(edits).toHaveLength(1);
    expect(edits[0]).toContain('the shot list says renames \\[an\\]\\(https\\:');
    expect(edits[0]).toContain('\\@helper');
    expect(edits[0]).not.toContain('](https://evil.example)');
  });

  it('the minion reads the camera\'s latest run back', async () => {
    const w = world();
    writeShotList(w, SHOTS);
    w.delivered.set('j-ui', head(w));
    w.next = () => ({ kind: 'failed', code: 'step_failed', detail: 'shot "card" step 2 (click "#go") failed at desktop: Element not found' });
    await tick(w);
    const event = w.api.listJobEvents('j-ui', { kinds: [MEDIA_CAPTURE_FAILED_EVENT], order: 'desc', limit: 1 })[0]!;
    expect(cameraView(event)).toMatchObject({
      state: 'failed', head_sha: head(w), code: 'step_failed', detail: expect.stringContaining('click "#go"'),
      shot_list_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(cameraView(null)).toBeNull();
    expect(SHOT_LIST_FILE).toBe('shot-list.json');
  });
});
