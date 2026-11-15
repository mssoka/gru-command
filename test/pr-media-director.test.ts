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
  CAMERA_DIRTY_BACKOFF_MS,
  CAMERA_MAX_ATTEMPTS,
  CAMERA_RETRY_MS,
  CAMERA_SETTLE_MS,
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
function world(manifest = CAPTURE): World {
  const dataDir = tmp('gru-camera-director-data-');
  const lane = tmp('gru-camera-director-lane-');
  git(lane, 'init', '-q', '-b', 'main');
  writeFileSync(join(lane, 'README.md'), 'widget shop\n');
  git(lane, 'add', '.');
  git(lane, 'commit', '-q', '-m', 'base');
  git(lane, 'checkout', '-q', '-b', 'gru/j-ui');
  mkdirSync(join(lane, '.gru-command'));
  writeFileSync(join(lane, '.gru-command', 'worktree.toml'), manifest);
  mkdirSync(join(lane, 'web'));
  writeFileSync(join(lane, 'web', 'card.ts'), 'export const card = 1;\n');
  git(lane, 'add', '.');
  git(lane, 'commit', '-q', '-m', 'card');
  const db = new LedgerDb(dataDir);
  dbs.push(db);
  const api = new LedgerApi(db.handle, { bus: new EventBus() });
  api.addJob({ id: 'j-ui', repo: 'widget-shop', title: 'Plain-language cards', baseBranch: 'main' });
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
    // The ledger stamps events with the real clock; the director's clock
    // runs a minute ahead of it and moves forward from there.
    now: Date.now() + 60_000,
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
  await w.director.inFlight();
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
    for (let run = 0; run < CAMERA_MAX_ATTEMPTS + 1; run += 1) await tick(moved);
    expect(moved.films).toHaveLength(CAMERA_MAX_ATTEMPTS + 1);
    expect(coverageAtHead(moved.api, 'j-ui', head(moved))?.camera).toBe('pending');
  });

  it('backs off a lane found mid-edit, and never records a run the service stopped', async () => {
    const w = world();
    writeShotList(w, SHOTS);
    w.delivered.set('j-ui', head(w));
    w.next = () => ({ kind: 'failed', code: 'dirty_tree', detail: 'uncommitted tracked changes' });
    await tick(w);
    await tick(w);
    expect(w.films).toHaveLength(1);
    w.now += CAMERA_DIRTY_BACKOFF_MS;
    w.next = () => ({ kind: 'failed', code: 'stopped', detail: 'the service is stopping' });
    await tick(w);
    expect(w.films).toHaveLength(2);
    expect(events(w, MEDIA_CAPTURE_FAILED_EVENT).map((event) => event['code'])).toEqual(['dirty_tree']);
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

  it('films nothing for a parked or closed job or with [pr_media] off, holds the lane busy while filming, and stops a run on dispose', async () => {
    const w = world();
    writeShotList(w, SHOTS);
    w.delivered.set('j-ui', head(w));
    w.config = { enabled: false, publish: 'autonomous' };
    await tick(w);
    w.config = ON;
    w.api.setJobStatus('j-ui', 'parked');
    await tick(w);
    expect(w.films).toHaveLength(0);
    expect(events(w, MEDIA_COVERAGE_EVENT)).toEqual([]);
    w.api.setJobStatus('j-ui', 'in-review');
    let release: (result: CameraRunResult) => void = () => {};
    let seen: AbortSignal | null = null;
    w.next = (input) => {
      seen = input.signal;
      return new Promise<CameraRunResult>((resolveFilm) => {
        release = resolveFilm;
      });
    };
    await w.director.tick();
    expect(w.director.jobBusy('j-ui')).toBe(true);
    // Another tick while the run is in flight starts no second run.
    await w.director.tick();
    expect(w.films).toHaveLength(1);
    const disposed = w.director.dispose();
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
    release({ kind: 'failed', code: 'stopped', detail: 'the service is stopping' });
    await disposed;
    expect(w.director.jobBusy('j-ui')).toBe(false);
    expect(events(w, MEDIA_CAPTURE_FAILED_EVENT)).toEqual([]);
  });
});

describe('the director\'s lifecycle', () => {
  it('a boot removes the folders runs of an earlier process left, then ticks; stop ends the timer', async () => {
    const w = world();
    const leftover = join(mediaRoot(w.dataDir), '.camera', 'cr-44444444-4444-4444-8444-444444444444', 'base');
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, 'version.txt'), 'base\n');
    w.director.start();
    await vi.waitFor(() => {
      expect(existsSync(join(mediaRoot(w.dataDir), '.camera'))).toBe(false);
      expect(events(w, MEDIA_COVERAGE_EVENT)).toHaveLength(1);
    });
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
      if (args[0] === 'pr' && args[1] === 'view') return { code: 0, stdout: JSON.stringify({ body: pr.body, headRefOid: pr.head, state: 'OPEN' }), stderr: '' };
      if (args[0] === 'pr' && args[1] === 'edit') {
        const { readFileSync } = await import('node:fs');
        pr.body = readFileSync(args[args.indexOf('--body-file') + 1]!, 'utf-8');
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
  });

  it('the PR section says media is owed, then shows the captures once they land, and says when an owed note goes stale', async () => {
    const w = world();
    const first = head(w);
    await tick(w);
    observe(w, first);
    const pr = { body: 'Fixes the card wording.', head: first };
    const { gh, edits } = ghFake(pr);
    const publisher = new PrMediaPublisher({ ledger: w.api, dataDir: w.dataDir, config: () => ON, gh, now: () => w.now });
    // A fresh coverage settles first, as fresh captures do.
    await publisher.pollOnce();
    expect(edits).toHaveLength(0);
    w.now = Date.now() + MEDIA_PUBLISH_SETTLE_MS + 1_000;
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
    // The head moves; nothing is known about the new head yet.
    const second = commit(w, 'README.md', 'widget shop, renamed\n');
    pr.head = second;
    observe(w, second);
    await publisher.pollOnce();
    expect(edits.at(-1)).toMatch(/The note shown here earlier was written for `[0-9a-f]{12}`; this PR is now at `[0-9a-f]{12}`/u);
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
