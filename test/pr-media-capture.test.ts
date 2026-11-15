import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { appendWorkerRules, PR_MEDIA_RULE } from '../src/dispatch/worker-rules.js';
import { CaptureGlobError, compileCaptureGlob, touchedCapturePaths } from '../src/media/capture-paths.js';
import {
  parseShotList,
  planCaptures,
  readShotList,
  SHOT_LIST_FILE,
  SHOT_LIST_MAX_BYTES,
  shotListPath,
  shotListSkipReason,
  ShotListError,
} from '../src/media/shot-list.js';
import { listMedia, mediaAtHead, MediaError, readMediaItem, storeMedia } from '../src/media/store.js';
import { operationalDirectoryFor } from '../src/artifacts/context.js';
import {
  captureBaseUrl,
  CaptureManifestError,
  CAPTURE_READY_TIMEOUT_DEFAULT_MS,
  parseWorktreeManifest,
  ReservedVerifyScopeError,
} from '../src/worktrees/manifest.js';
import { minimalPng } from './helpers/images.js';

/**
 * PR media PR 2: the `[capture]` manifest table (fail-loud like `[verify]`),
 * the `[capture] paths` glob dialect, the minion's shot-list format, and the
 * store's GC captures (owner rulings 2026-11-15, Q1 option C and Q4).
 */

const HEAD = 'c'.repeat(40);
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

function ledger(): { readonly api: LedgerApi; readonly dataDir: string } {
  const dataDir = tmp('gru-pr-media-capture-');
  const db = new LedgerDb(dataDir);
  dbs.push(db);
  const api = new LedgerApi(db.handle, { bus: new EventBus() });
  api.addJob({ id: 'j-ui', repo: 'widget-shop', title: 'Plain-language cards' });
  return { api, dataDir };
}

function capture(body: string): ReturnType<typeof parseWorktreeManifest>['capture'] {
  return parseWorktreeManifest(`[capture]\n${body}`, 'worktree.toml').capture;
}

function refusal(body: string): string {
  try {
    parseWorktreeManifest(`[capture]\n${body}`, 'worktree.toml');
  } catch (error) {
    expect(error).toBeInstanceOf(CaptureManifestError);
    return (error as Error).message;
  }
  throw new Error('the manifest was accepted');
}

const SHOT = {
  id: 'ready-row',
  proves: 'AC2: a ready PR row shows its captures',
  kind: 'screenshot',
  viewports: ['desktop'],
  steps: [{ open: '/board' }, { click: '[data-tab=for-you]' }, { type: '#filter', text: 'media' }, { wait_for_text: 'What it looks like' }],
};

function list(value: unknown): string {
  return JSON.stringify(value);
}

function invalid(value: unknown): ShotListError {
  try {
    parseShotList(typeof value === 'string' ? value : list(value));
  } catch (error) {
    expect(error).toBeInstanceOf(ShotListError);
    return error as ShotListError;
  }
  throw new Error('the shot list was accepted');
}

describe('[capture] manifest table', () => {
  it('parses paths, serve, ready, url and the readiness bound, and derives the base URL', () => {
    const full = capture([
      'paths = ["web/src/**", "web/index.html"]',
      'serve = "npm run dev -- --port {port}"',
      'ready = "http://127.0.0.1:{port}/health"',
      'url = "http://localhost:{port}/app/"',
      'ready_timeout_ms = 30000',
    ].join('\n'));
    expect(full).toEqual({
      paths: ['web/src/**', 'web/index.html'],
      serve: 'npm run dev -- --port {port}',
      ready: { kind: 'url', url: 'http://127.0.0.1:{port}/health' },
      url: 'http://localhost:{port}/app/',
      readyTimeoutMs: 30_000,
    });
    expect(captureBaseUrl(full!)).toBe('http://localhost:{port}/app');
    // Without url: the ready URL's origin; with an output condition: loopback.
    expect(captureBaseUrl(capture('serve = "x {port}"\nready = "http://[::1]:{port}/ok"')!)).toBe('http://[::1]:{port}');
    const output = capture('serve = "x --port={port}"\nready = "output: ready in"');
    expect(output).toMatchObject({ ready: { kind: 'output', text: 'ready in' }, readyTimeoutMs: CAPTURE_READY_TIMEOUT_DEFAULT_MS, paths: [] });
    expect(captureBaseUrl(output!)).toBe('http://127.0.0.1:{port}');
    // paths may stand alone: media is owed, GC films nothing.
    expect(capture('paths = ["**/*.css"]')).toEqual({ paths: ['**/*.css'], serve: null, ready: null, url: null, readyTimeoutMs: CAPTURE_READY_TIMEOUT_DEFAULT_MS });
    expect(parseWorktreeManifest('[verify]\nfull = "npm test"\n').capture).toBeUndefined();
  });

  it('refuses every malformed table by name, like [verify]', () => {
    const cases: readonly [string, RegExp][] = [
      ['', /table is empty/u],
      ['colour = "blue"', /key "colour" is unknown \(valid: paths, serve, ready, url, ready_timeout_ms\)/u],
      ['paths = "web/**"', /paths must be an array/u],
      ['paths = [3]', /paths\[0\] must be a string/u],
      ['paths = ["/abs/x"]', /paths\[0\].*relative to the repository root/u],
      ['paths = ["a/../b"]', /paths\[0\].*\. or \.\. segments/u],
      ['paths = ["!web/**"]', /paths lists only exclusions/u],
      ['paths = ["web/**", "!!web/a.ts"]', /paths\[1\].*one ! only/u],
      ['paths = ["web/**", "!/abs"]', /paths\[1\].*relative to the repository root/u],
      ['paths = ["web/{a,b}.ts"]', /paths\[0\].*sets/u],
      ['paths = ["web/**.css"]', /paths\[0\].*whole segment/u],
      ['paths = ["web/", "x"]', /paths\[0\].*empty segment/u],
      ['paths = ["web/**", "web/**"]', /paths\[1\] duplicates paths\[0\]/u],
      ['serve = "npm run dev"\nready = "http://127.0.0.1:{port}/"', /serve must start the app on the run's \{port\}/u],
      ['serve = "npm run dev -- --port {port}"', /serve needs its partner/u],
      ['ready = "http://127.0.0.1:{port}/"', /ready needs its partner/u],
      ['serve = "x {port}"\nready = "https://127.0.0.1:{port}/"', /ready must be a loopback URL/u],
      ['serve = "x {port}"\nready = "http://example.com:{port}/"', /ready must be a loopback URL/u],
      ['serve = "x {port}"\nready = "http://127.0.0.1:3000/"', /ready must be a loopback URL whose port is the run's \{port\}/u],
      ['serve = "x {port}"\nready = "output:"', /output text must be 1–200 characters/u],
      ['paths = ["a"]\nurl = "http://127.0.0.1:{port}/"', /url needs serve and ready/u],
      ['serve = "x {port}"\nready = "output:up"\nready_timeout_ms = 10', /ready_timeout_ms must be an integer from 1000 to 600000/u],
    ];
    for (const [body, reason] of cases) expect(refusal(body), body).toMatch(reason);
    expect(() => parseWorktreeManifest('capture = 3\n')).toThrow(CaptureManifestError);
    expect(() => parseWorktreeManifest('capture = 3\n')).toThrow(/\[capture\] table must be a table/u);
  });

  it('reserves the camera budget scope from [verify], as the onboarding proof is', () => {
    expect(() => parseWorktreeManifest('[verify]\npr-media-capture = "npm test"\n')).toThrow(ReservedVerifyScopeError);
    expect(() => parseWorktreeManifest('[verify]\npr-media-capture = "npm test"\n')).toThrow(/reserved for GC's PR media camera/u);
    expect(() => parseWorktreeManifest('[verify]\nonboarding-proof = "npm test"\n')).toThrow(/reserved for GC's onboarding proof/u);
  });
});

describe('[capture] paths globs', () => {
  it('matches the ecosystem-neutral subset: *, ** and ? over / separated paths', () => {
    const cases: readonly [string, readonly string[], readonly string[]][] = [
      ['web/src/**', ['web/src/a.ts', 'web/src/ui/b.ts'], ['web/src', 'web/srcx/a.ts', 'web/a.ts']],
      ['**/*.css', ['a.css', 'web/x/a.css'], ['a.cssx', 'a.ts']],
      ['web/**/*.tsx', ['web/a.tsx', 'web/x/y/a.tsx'], ['web/a.ts', 'src/web/a.tsx']],
      ['src/ui/?.ts', ['src/ui/a.ts'], ['src/ui/ab.ts', 'src/ui/a/b.ts']],
      ['index.html', ['index.html'], ['web/index.html', 'index.htm']],
      ['docs/*.md', ['docs/a.md'], ['docs/a/b.md']],
      ['a+b(c).txt', ['a+b(c).txt'], ['aab(c).txt']],
    ];
    for (const [pattern, yes, no] of cases) {
      const glob = compileCaptureGlob(pattern);
      for (const path of yes) expect(glob.matches(path), `${pattern} ~ ${path}`).toBe(true);
      for (const path of no) expect(glob.matches(path), `${pattern} !~ ${path}`).toBe(false);
    }
    expect(() => compileCaptureGlob('web\\src')).toThrow(CaptureGlobError);
    expect(() => compileCaptureGlob('x'.repeat(201))).toThrow(/at most 200/u);
    // `**/**` means one `**`; a trailing one needs a segment.
    expect(compileCaptureGlob('web/**/**/a.ts').matches('web/a.ts')).toBe(true);
    expect(compileCaptureGlob('web/**/**').matches('web')).toBe(false);
  });

  it('matches in linear time: a glob built to backtrack against a deep path answers at once', () => {
    const glob = compileCaptureGlob(`${'**/'.repeat(30)}zz`);
    const starry = compileCaptureGlob(`${'*a'.repeat(40)}b`);
    const deep = Array.from({ length: 40 }, (_, index) => `seg${index}`).join('/');
    const started = performance.now();
    expect(glob.matches(`${deep}/not-it`)).toBe(false);
    expect(glob.matches(`${deep}/zz`)).toBe(true);
    expect(starry.matches('a'.repeat(200))).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('lists each touched path once, with the first glob it matched, in diff order; a ! entry excludes', () => {
    const globs = ['web/**', '**/*.css', '!web/**/*.test.ts'].map((pattern) => compileCaptureGlob(pattern));
    expect(globs.map((glob) => glob.exclude)).toEqual([false, false, true]);
    expect(touchedCapturePaths(globs, ['src/a.ts', 'web/b.css', 'lib/c.css', 'README.md', 'web/ui/board.test.ts', 'web/ui/board.ts'])).toEqual([
      { path: 'web/b.css', glob: 'web/**' },
      { path: 'lib/c.css', glob: '**/*.css' },
      { path: 'web/ui/board.ts', glob: 'web/**' },
    ]);
    expect(touchedCapturePaths(globs, [])).toEqual([]);
    expect(parseWorktreeManifest('[capture]\npaths = ["web/**", "!web/**/*.test.ts"]\n').capture?.paths).toEqual(['web/**', '!web/**/*.test.ts']);
  });
});

describe('shot list', () => {
  it('parses shots into planned captures: before (compare) then after, per viewport, captions from what they prove', () => {
    const parsed = parseShotList(list({
      version: 1,
      shots: [
        { ...SHOT, viewports: ['desktop', { width: 400, height: 900 }], compare: 'base' },
        { id: 'flow', proves: 'AC3: the flow', kind: 'clip', viewports: ['mobile'], steps: [{ open: '/' }] },
        { id: 'sign-in', proves: 'AC4: sign-in', skip: 'needs a real GitHub sign-in' },
      ],
    }));
    expect(parsed.shots.map((shot) => shot.id)).toEqual(['ready-row', 'flow', 'sign-in']);
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/u);
    const plans = planCaptures(parsed);
    expect(plans.map((plan) => [plan.shotId, plan.role, plan.kind, plan.viewport.name, plan.caption])).toEqual([
      ['ready-row', 'before', 'screenshot', 'desktop', 'AC2: a ready PR row shows its captures · desktop · before (merge base)'],
      ['ready-row', 'before', 'screenshot', '400x900', 'AC2: a ready PR row shows its captures · 400x900 · before (merge base)'],
      ['ready-row', 'after', 'screenshot', 'desktop', 'AC2: a ready PR row shows its captures · desktop'],
      ['ready-row', 'after', 'screenshot', '400x900', 'AC2: a ready PR row shows its captures · 400x900'],
      ['flow', 'after', 'clip', 'mobile', 'AC3: the flow'],
    ]);
    expect(plans[0]!.viewport).toEqual({ name: 'desktop', width: 1280, height: 800 });
    expect(plans[0]!.steps).toEqual([
      { action: 'open', path: '/board' },
      { action: 'click', selector: '[data-tab=for-you]' },
      { action: 'type', selector: '#filter', text: 'media' },
      { action: 'wait_for_text', text: 'What it looks like' },
    ]);
    expect(shotListSkipReason(parsed)).toBeNull();
  });

  it('gives the skip reason: a top-level skip, or every shot skipped', () => {
    expect(shotListSkipReason(parseShotList(list({ version: 1, skip: 'only renames an internal helper' })))).toBe('only renames an internal helper');
    expect(planCaptures(parseShotList(list({ version: 1, skip: 'nothing visible' })))).toEqual([]);
    const allSkipped = parseShotList(list({ version: 1, shots: [{ id: 'a', proves: 'AC1', skip: 'login only' }, { id: 'b', proves: 'AC2', skip: 'no UI' }] }));
    expect(shotListSkipReason(allSkipped)).toBe('a: login only; b: no UI');
    expect(planCaptures(allSkipped)).toEqual([]);
  });

  it('refuses every malformed list with a named code and the field at fault', () => {
    const cases: readonly [unknown, RegExp][] = [
      ['not json', /not valid JSON/u],
      [[], /must be a JSON object/u],
      [{ version: 2, shots: [SHOT] }, /version must be 1/u],
      [{ version: 1, shots: [SHOT], extra: 1 }, /unknown key "extra"/u],
      [{ version: 1 }, /at least one shot, or give a top-level "skip"/u],
      [{ version: 1, skip: 'x', shots: [SHOT] }, /shots must be empty/u],
      [{ version: 1, shots: [{ ...SHOT, id: 'Bad Id' }] }, /shots\[0\]\.id must be 1–40 lowercase/u],
      [{ version: 1, shots: [SHOT, SHOT] }, /repeats the shot id "ready-row"/u],
      [{ version: 1, shots: [{ ...SHOT, proves: '' }] }, /shots\[0\]\.proves/u],
      [{ version: 1, shots: [{ ...SHOT, proves: 'a‮b' }] }, /invisible or text-direction/u],
      [{ version: 1, shots: [{ ...SHOT, proves: 'x'.repeat(151) }] }, /at most 150 characters/u],
      [{ version: 1, shots: [{ ...SHOT, kind: 'movie' }] }, /kind must be "screenshot" or "clip"/u],
      [{ version: 1, shots: [{ ...SHOT, viewports: [] }] }, /viewports must list 1–3/u],
      [{ version: 1, shots: [{ ...SHOT, viewports: ['watch'] }] }, /names no preset/u],
      [{ version: 1, shots: [{ ...SHOT, viewports: [{ width: 100, height: 800 }] }] }, /width must be an integer from 320/u],
      [{ version: 1, shots: [{ ...SHOT, viewports: ['desktop', 'desktop'] }] }, /repeats desktop/u],
      [{ version: 1, shots: [{ ...SHOT, steps: [] }] }, /steps must list 1–20/u],
      [{ version: 1, shots: [{ ...SHOT, steps: [{ click: '#a' }] }] }, /steps\[0\] must be an open step/u],
      [{ version: 1, shots: [{ ...SHOT, steps: [{ open: 'https://example.com/' }] }] }, /must be a path on the app/u],
      [{ version: 1, shots: [{ ...SHOT, steps: [{ open: '//example.com/' }] }] }, /must be a path on the app/u],
      [{ version: 1, shots: [{ ...SHOT, steps: [{ open: '/', click: '#a' }] }] }, /exactly one of open, click, type, wait_for_text/u],
      [{ version: 1, shots: [{ ...SHOT, steps: [{ open: '/' }, { type: '#a' }] }] }, /steps\[1\]\.text must be a non-empty string/u],
      [{ version: 1, shots: [{ ...SHOT, steps: [{ open: '/' }, { eval: 'x' }] }] }, /exactly one of/u],
      [{ version: 1, shots: [{ ...SHOT, steps: [{ open: '/' }, { click: 'a\nb' }] }] }, /one line without control characters/u],
      [{ version: 1, shots: [{ ...SHOT, steps: [{ open: '/' }, { click: '--headed' }] }] }, /steps\[1\]\.click must not start with "-"/u],
      [{ version: 1, shots: [{ ...SHOT, steps: [{ open: '/' }, { type: '#q', text: '-20% off' }] }] }, /steps\[1\]\.text must not start with "-"/u],
      [{ version: 1, shots: [{ ...SHOT, steps: [{ open: '/' }, { wait_for_text: '--config=x' }] }] }, /wait_for_text must not start with "-"/u],
      [{ version: 1, shots: [{ ...SHOT, compare: 'main' }] }, /compare must be "base"/u],
      [{ version: 1, shots: [{ id: 'a', proves: 'AC1', skip: 'x', steps: [] }] }, /\(skipped\) has unknown key "steps"/u],
    ];
    for (const [value, reason] of cases) {
      const error = invalid(value);
      expect(error.code, JSON.stringify(value)).toBe('shot_list_invalid');
      expect(error.message, JSON.stringify(value)).toMatch(reason);
    }
  });

  it('refuses a list that plans more files than a head holds', () => {
    const compared = { ...SHOT, id: 'a', viewports: ['desktop', 'tablet', 'mobile'], compare: 'base' };
    // 3 viewports × 2 (compare) + 3 = 9: one past the cap.
    const error = invalid({ version: 1, shots: [compared, { ...SHOT, id: 'b', viewports: ['desktop', 'tablet', 'mobile'] }] });
    expect(error.code).toBe('shot_list_over_limit');
    expect(error.message).toMatch(/plans 9 captures .* a head holds at most 8/u);
    // 6 + 2 = 8 is exactly the cap.
    expect(planCaptures(parseShotList(list({ version: 1, shots: [compared, { ...SHOT, id: 'b', viewports: ['desktop', 'tablet'] }] })))).toHaveLength(8);
  });

  it('reads the file from the job\'s private operational folder: absent is null, a link or an oversized file is refused', () => {
    const repo = tmp('gru-shot-repo-');
    const dataDir = tmp('gru-shot-data-');
    const path = shotListPath(dataDir, repo, 'j-ui');
    expect(path).toBe(join(operationalDirectoryFor(dataDir, repo, 'j-ui'), SHOT_LIST_FILE));
    expect(path).toContain(join('jobs', 'j-ui', 'operational'));
    expect(readShotList(path)).toBeNull();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, list({ version: 1, shots: [SHOT] }));
    expect(readShotList(path)?.shots).toHaveLength(1);
    writeFileSync(path, ' '.repeat(SHOT_LIST_MAX_BYTES + 1));
    expect(() => readShotList(path)).toThrow(/limit is 65536/u);
    rmSync(path);
    // A named pipe is refused without blocking the service on its open.
    execFileSync('mkfifo', [path]);
    expect(() => readShotList(path)).toThrow(/is not a regular file/u);
    rmSync(path);
    mkdirSync(path);
    expect(() => readShotList(path)).toThrow(/is not a regular file/u);
    rmSync(path, { recursive: true });
    const elsewhere = join(dataDir, 'elsewhere.json');
    writeFileSync(elsewhere, list({ version: 1, shots: [SHOT] }));
    symlinkSync(elsewhere, path);
    expect(() => readShotList(path)).toThrow(ShotListError);
    expect(() => readShotList(path)).toThrow(/plain file, not a link/u);
  });
});

describe('GC captures in the store', () => {
  const RUN_A = 'cr-11111111-1111-4111-8111-111111111111';
  const RUN_B = 'cr-22222222-2222-4222-8222-222222222222';

  it('journals captured_by gc with its run and shot, and reads both kinds back', () => {
    const { api, dataDir } = ledger();
    const minion = storeMedia({ dataDir, ledger: api, jobId: 'j-ui', headSha: HEAD, caption: 'Direct', role: 'after', bytes: minimalPng() });
    const gc = storeMedia({
      dataDir, ledger: api, jobId: 'j-ui', headSha: HEAD, caption: 'Filmed', role: 'after', bytes: minimalPng(),
      capturedBy: 'gc', shot: { runId: RUN_A, shotId: 'ready-row', viewport: 'desktop', files: 1 },
    });
    expect(minion).toMatchObject({ capturedBy: 'minion', shot: null });
    expect(gc).toMatchObject({ capturedBy: 'gc', shot: { runId: RUN_A, shotId: 'ready-row', viewport: 'desktop', files: 1 } });
    expect(listMedia(api, 'j-ui').map((item) => [item.capturedBy, item.shot?.runId ?? null])).toEqual([['minion', null], ['gc', RUN_A]]);
    expect(api.latestJobEvent('j-ui', 'media.captured')?.payload).toMatchObject({ captured_by: 'gc', shot: { run_id: RUN_A, shot_id: 'ready-row', viewport: 'desktop', files: 1 } });
    // A row that claims gc without a shot, or a minion row with one, never reads.
    const event = api.latestJobEvent('j-ui', 'media.captured')!;
    const payload = event.payload as Record<string, unknown>;
    expect(readMediaItem({ ...event, payload: { ...payload, shot: undefined } })).toBeNull();
    expect(readMediaItem({ ...event, payload: { ...payload, captured_by: 'minion' } })).toBeNull();
    expect(readMediaItem({ ...event, payload: { ...payload, captured_by: 'robot' } })).toBeNull();
    expect(() => storeMedia({ dataDir, ledger: api, jobId: 'j-ui', headSha: HEAD, caption: 'x', role: 'after', bytes: minimalPng(), capturedBy: 'gc' }))
      .toThrow(/names its camera run and shot/u);
  });

  it('shows the newest complete camera run at a head: a re-filmed list supersedes the older run, a run cut short never shows', () => {
    const { api, dataDir } = ledger();
    const film = (runId: string, shotId: string, files: number) =>
      storeMedia({ dataDir, ledger: api, jobId: 'j-ui', headSha: HEAD, caption: `${runId} ${shotId}`, role: 'after', bytes: minimalPng(), capturedBy: 'gc', shot: { runId, shotId, viewport: 'desktop', files } });
    const minion = storeMedia({ dataDir, ledger: api, jobId: 'j-ui', headSha: HEAD, caption: 'Direct', role: 'after', bytes: minimalPng() });
    film(RUN_A, 'a', 2);
    film(RUN_A, 'b', 2);
    expect(mediaAtHead(listMedia(api, 'j-ui'), HEAD).map((item) => item.caption)).toEqual(['Direct', `${RUN_A} a`, `${RUN_A} b`]);
    // A newer run with only one of its two files stored is not shown.
    film(RUN_B, 'a', 2);
    expect(mediaAtHead(listMedia(api, 'j-ui'), HEAD).map((item) => item.caption)).toEqual(['Direct', `${RUN_A} a`, `${RUN_A} b`]);
    film(RUN_B, 'c', 2);
    expect(mediaAtHead(listMedia(api, 'j-ui'), HEAD).map((item) => item.caption)).toEqual(['Direct', `${RUN_B} a`, `${RUN_B} c`]);
    expect(minion.shot).toBeNull();
  });

  it('caps a head at 8 current captures, a camera run counting the minion\'s and its own', () => {
    const { api, dataDir } = ledger();
    for (let index = 0; index < 6; index += 1) {
      storeMedia({ dataDir, ledger: api, jobId: 'j-ui', headSha: HEAD, caption: `direct ${index}`, role: 'after', bytes: minimalPng() });
    }
    const gc = (shotId: string) => storeMedia({
      dataDir, ledger: api, jobId: 'j-ui', headSha: HEAD, caption: shotId, role: 'after', bytes: minimalPng(),
      capturedBy: 'gc', shot: { runId: RUN_A, shotId, viewport: 'desktop', files: 3 },
    });
    gc('a');
    gc('b');
    expect(() => gc('c')).toThrow(MediaError);
    expect(() => gc('c')).toThrow(/already has 8 captures/u);
  });
});

describe('the minion rule', () => {
  it('points minions at the shot list first and keeps direct submission as the fallback', () => {
    const brief = appendWorkerRules('Fix the FOR YOU wording.');
    expect(brief).toContain(PR_MEDIA_RULE);
    expect(PR_MEDIA_RULE).toContain('`shot-list.json` in your private operational artifacts folder');
    for (const field of ['"version": 1', '"proves"', '"kind"', '"viewports"', '"steps"', '"open"', '"click"', '"type"', '"wait_for_text"', '"compare": "base"', '"skip"']) {
      expect(PR_MEDIA_RULE).toContain(field);
    }
    expect(PR_MEDIA_RULE).toMatch(/GET \/api\/media\?job_id=<your job id>/u);
    expect(PR_MEDIA_RULE).toMatch(/Fallback, when the repository has no \[capture\] serve/u);
    expect(PR_MEDIA_RULE).toMatch(/media owed/u);
    expect(PR_MEDIA_RULE.indexOf('shot-list.json')).toBeLessThan(PR_MEDIA_RULE.indexOf('POST /api/media'));
  });
});
