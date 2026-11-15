import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAMERA_SCOPE, CAMERA_SERVE_ENV, endOrphanedCameraApps, filmShotList, type CameraRunInput } from '../src/media/camera.js';
import { parseShotList, planCaptures, type PlannedCapture } from '../src/media/shot-list.js';
import {
  AgentBrowserDriver,
  CaptureToolError,
  ShotStepError,
  stepArgs,
  type CliRunner,
  type WebCaptureDriver,
  type WebShotRequest,
} from '../src/media/web-adapter.js';
import type { VerificationLease, VerificationRunSpec } from '../src/verify/scheduler.js';
import type { VerificationBudget } from '../src/verify/server.js';
import { parseWorktreeManifest, type ManifestCapture } from '../src/worktrees/manifest.js';
import { minimalPng } from './helpers/images.js';

/**
 * GC's camera (PR media PR 2): one run films a shot list at the lane's exact
 * committed head under one slot of the verification budget. The app is a
 * real process started by `[capture] serve` on the run's port; the browser is
 * a fake driver (the agent-browser adapter's argv is pinned separately), so
 * every outcome is deterministic.
 */

const dirs: string[] = [];
const pids: number[] = [];

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
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

/** A one-file app: answers every path with the cwd's version.txt (plus the
 * setup marker when setup ran), prints its port when it listens. */
function appScript(): string {
  const dir = tmp('gru-camera-app-');
  const file = join(dir, 'app.mjs');
  writeFileSync(file, [
    "import http from 'node:http';",
    "import { existsSync, readFileSync } from 'node:fs';",
    'const port = Number(process.argv[2]);',
    "if (process.argv[3] === 'crash') { console.error('boom: missing dependency'); process.exit(3); }",
    'const server = http.createServer((req, res) => {',
    "  if (process.argv[3] === 'slow') { res.writeHead(503); res.end('starting'); return; }",
    "  const body = readFileSync('version.txt', 'utf8').trim() + (existsSync('setup-marker.txt') ? '+setup' : '');",
    "  res.writeHead(200, { 'content-type': 'text/plain' });",
    '  res.end(body);',
    '});',
    "server.listen(port, '127.0.0.1', () => console.log('\\u001b[32mapp ready\\u001b[0m on ' + port));",
  ].join('\n'));
  return file;
}

interface Lane {
  readonly path: string;
  readonly head: string;
  readonly base: string;
}

/** A repository whose main holds the base and whose lane branch the head. */
function lane(): Lane {
  const path = tmp('gru-camera-lane-');
  git(path, 'init', '-q', '-b', 'main');
  writeFileSync(join(path, 'version.txt'), 'base\n');
  mkdirSync(join(path, '.gru-command'));
  writeFileSync(join(path, '.gru-command', 'worktree.toml'), '[[setup]]\ncommand = "echo ran > setup-marker.txt"\n');
  writeFileSync(join(path, '.gitignore'), 'setup-marker.txt\n');
  git(path, 'add', '.');
  git(path, 'commit', '-q', '-m', 'base');
  const base = git(path, 'rev-parse', 'HEAD');
  git(path, 'checkout', '-q', '-b', 'gru/j-ui');
  writeFileSync(join(path, 'version.txt'), 'head\n');
  git(path, 'commit', '-q', '-am', 'head');
  return { path, head: git(path, 'rev-parse', 'HEAD'), base };
}

interface FakeBudget extends VerificationBudget {
  readonly specs: VerificationRunSpec[];
  readonly released: VerificationLease[];
  readonly bound: { pid: number; command: string; leadsGroup: boolean }[];
}

function budget(opts: { never?: boolean; restored?: ReturnType<VerificationBudget['restored']> } = {}): FakeBudget {
  const specs: VerificationRunSpec[] = [];
  const released: VerificationLease[] = [];
  const bound: { pid: number; command: string; leadsGroup: boolean }[] = [];
  return {
    specs,
    released,
    bound,
    acquire: (spec) => {
      specs.push(spec);
      if (opts.never === true) return new Promise(() => {});
      return Promise.resolve({ runId: `run-${specs.length}`, jobId: spec.jobId, scope: spec.scope, command: spec.command, cwd: spec.cwd, head: spec.head ?? null, queuedAt: 0, grantedAt: 0 });
    },
    bindPid: (_lease, pid, command, bind) => {
      pids.push(pid);
      bound.push({ pid, command, leadsGroup: bind?.leadsGroup === true });
    },
    restored: (scope) => (scope === CAMERA_SCOPE ? opts.restored ?? [] : []),
    reconcileStale: () => {},
    release: (lease) => released.push(lease),
    workersPerRun: 2,
    ageLimitMs: 60_000,
  };
}

interface Shot {
  readonly request: WebShotRequest;
  readonly page: string;
}

/** A browser stand-in: reads the page the app serves and writes a PNG. */
function driver(opts: { probe?: string; fail?: unknown; bytes?: Buffer; during?: () => void } = {}): WebCaptureDriver & { readonly shots: Shot[] } {
  const shots: Shot[] = [];
  return {
    shots,
    probe: async () => opts.probe ?? null,
    shoot: async (request) => {
      const page = await (await fetch(`${request.baseUrl}${request.plan.steps[0]!.action === 'open' ? (request.plan.steps[0] as { path: string }).path : '/'}`)).text();
      shots.push({ request, page });
      opts.during?.();
      if (opts.fail !== undefined) throw opts.fail;
      writeFileSync(request.outFile, opts.bytes ?? minimalPng());
    },
  };
}

function captureTable(serve: string, ready: string, extra = ''): ManifestCapture {
  const parsed = parseWorktreeManifest(`[capture]\npaths = ["**"]\nserve = ${JSON.stringify(serve)}\nready = ${JSON.stringify(ready)}\n${extra}`).capture;
  if (parsed === undefined) throw new Error('no capture table');
  return parsed;
}

function plans(compare = false): readonly PlannedCapture[] {
  return planCaptures(parseShotList(JSON.stringify({
    version: 1,
    shots: [{ id: 'home', proves: 'AC1: the home page', kind: 'screenshot', viewports: ['desktop', 'mobile'], steps: [{ open: '/' }], ...(compare ? { compare: 'base' } : {}) }],
  })));
}

function input(laneInfo: Lane, overrides: Partial<CameraRunInput> = {}): CameraRunInput & { readonly budgetFake: FakeBudget } {
  const app = appScript();
  const budgetFake = (overrides.budget?.() as FakeBudget | undefined) ?? budget();
  const workRoot = tmp('gru-camera-work-');
  return {
    jobId: 'j-ui',
    runId: 'cr-11111111-1111-4111-8111-111111111111',
    lanePath: laneInfo.path,
    repoPath: laneInfo.path,
    headSha: laneInfo.head,
    baseSha: laneInfo.base,
    capture: captureTable(`node ${app} {port}`, 'http://127.0.0.1:{port}/'),
    headManifest: parseWorktreeManifest(''),
    plans: plans(),
    workDir: join(workRoot, 'run'),
    driver: driver(),
    setupTimeoutMs: 30_000,
    signal: new AbortController().signal,
    ...overrides,
    budget: () => budgetFake,
    budgetFake,
  };
}

async function answers(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return true;
  } catch {
    return false;
  }
}

describe('filmShotList', () => {
  it('films every after plan against the app it serves on the run\'s port, under one budget slot, then stops the app', async () => {
    const at = lane();
    const camera = driver();
    let readied = 0;
    const run = input(at, { driver: camera, ensureReady: async () => { readied += 1; } });
    const result = await filmShotList(run);
    expect(result.kind).toBe('filmed');
    if (result.kind !== 'filmed') return;
    expect(result.files.map((file) => [file.plan.shotId, file.plan.viewport.name])).toEqual([['home', 'desktop'], ['home', 'mobile']]);
    expect(result.files.every((file) => file.bytes.equals(minimalPng()))).toBe(true);
    expect(readied).toBe(1);
    // The app served the HEAD's bytes, on a loopback port the run picked.
    expect(camera.shots.map((shot) => shot.page)).toEqual(['head', 'head']);
    const baseUrl = camera.shots[0]!.request.baseUrl;
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    expect(camera.shots[0]!.request.outFile.startsWith(run.workDir)).toBe(true);
    // One slot of the global budget, under the reserved scope, at the head.
    expect(run.budgetFake.specs).toEqual([expect.objectContaining({ jobId: 'j-ui', scope: 'pr-media-capture', cwd: at.path, head: at.head })]);
    expect(run.budgetFake.released).toHaveLength(1);
    expect(run.budgetFake.bound).toEqual([expect.objectContaining({ leadsGroup: true, command: `/bin/sh -c eval "$${CAMERA_SERVE_ENV}" # pr media camera ${run.runId}` })]);
    // The app is gone and the run's folder removed.
    expect(await answers(baseUrl)).toBe(false);
    expect(existsSync(run.workDir)).toBe(false);
  });

  it('waits for an output condition, ANSI colors ignored', async () => {
    const at = lane();
    const app = appScript();
    const result = await filmShotList(input(at, { capture: captureTable(`node ${app} {port}`, 'output:app ready on') }));
    expect(result.kind).toBe('filmed');
  });

  it('names an app that exits before it is ready, and one that never gets ready', async () => {
    const at = lane();
    const app = appScript();
    const crashed = await filmShotList(input(at, { capture: captureTable(`node ${app} {port} crash`, 'http://127.0.0.1:{port}/') }));
    expect(crashed).toMatchObject({ kind: 'failed', code: 'serve_failed' });
    expect(crashed.kind === 'failed' && crashed.detail).toMatch(/exited \(code 3\) before it was ready: boom: missing dependency/u);
    const slow = await filmShotList(input(at, { capture: captureTable(`node ${app} {port} slow`, 'http://127.0.0.1:{port}/', 'ready_timeout_ms = 1000') }));
    expect(slow).toMatchObject({ kind: 'failed', code: 'ready_timeout' });
    expect(slow.kind === 'failed' && slow.detail).toMatch(/not ready after 1000 ms \(no answer below 400 from http:\/\/127\.0\.0\.1:\d+\/\)/u);
  });

  it('names a failed step, a missing tool and an unusable file, and still releases the slot', async () => {
    const at = lane();
    const step = input(at, { driver: driver({ fail: new ShotStepError('home', 1, 'shot "home" step 2 (click "#nope") failed at desktop: Element not found') }) });
    expect(await filmShotList(step)).toMatchObject({ kind: 'failed', code: 'step_failed', detail: expect.stringContaining('click "#nope"') });
    expect(step.budgetFake.released).toHaveLength(1);
    expect(await filmShotList(input(at, { driver: driver({ probe: 'agent-browser is not installed on the Gru Command host' }) })))
      .toMatchObject({ kind: 'failed', code: 'tool_missing', detail: expect.stringContaining('not installed') });
    expect(await filmShotList(input(at, { driver: driver({ fail: new CaptureToolError('agent-browser set viewport failed: daemon crashed') }) })))
      .toMatchObject({ kind: 'failed', code: 'tool_missing' });
    expect(await filmShotList(input(at, { driver: driver({ bytes: Buffer.from('not an image') }) })))
      .toMatchObject({ kind: 'failed', code: 'capture_invalid', detail: expect.stringContaining('unsupported capture') });
  });

  it('films only a committed head: a dirty or moved lane yields nothing', async () => {
    const at = lane();
    writeFileSync(join(at.path, 'version.txt'), 'edited\n');
    const dirty = input(at);
    expect(await filmShotList(dirty)).toMatchObject({ kind: 'failed', code: 'dirty_tree', detail: expect.stringContaining('before filming') });
    // Nothing was served for a dirty lane.
    expect(dirty.budgetFake.bound).toEqual([]);
    git(at.path, 'checkout', '--', 'version.txt');
    // The minion commits while the camera films: the head moved, nothing binds.
    let committed = false;
    const moved = input(at, {
      driver: driver({
        during: () => {
          if (committed) return;
          committed = true;
          writeFileSync(join(at.path, 'version.txt'), 'newer\n');
          git(at.path, 'commit', '-q', '-am', 'newer');
        },
      }),
    });
    const result = await filmShotList(moved);
    expect(result).toMatchObject({ kind: 'failed', code: 'head_moved', detail: expect.stringContaining('while it was filmed') });
    expect(moved.budgetFake.released).toHaveLength(1);
  });

  it('films a compare shot\'s before plans in a throwaway checkout of the merge base, set up by its own manifest', async () => {
    const at = lane();
    const camera = driver();
    const run = input(at, { driver: camera, plans: plans(true) });
    const result = await filmShotList(run);
    expect(result.kind).toBe('filmed');
    if (result.kind !== 'filmed') return;
    // The plans' order: before (base) captures first, then after.
    expect(result.files.map((file) => `${file.plan.role}:${file.plan.viewport.name}`)).toEqual(['before:desktop', 'before:mobile', 'after:desktop', 'after:mobile']);
    // After shots saw the lane's head; before shots the base, after its setup ran.
    expect(camera.shots.map((shot) => shot.page)).toEqual(['head', 'head', 'base+setup', 'base+setup']);
    // The lane gained no setup marker, no worktree, no ref; the checkout is gone.
    expect(existsSync(join(at.path, 'setup-marker.txt'))).toBe(false);
    expect(git(at.path, 'worktree', 'list').split('\n')).toHaveLength(1);
    expect(existsSync(run.workDir)).toBe(false);
    // Without a merge base there is no before to film.
    expect(await filmShotList(input(at, { plans: plans(true), baseSha: null }))).toMatchObject({ kind: 'failed', code: 'base_unavailable' });
  });

  it('stops when the service stops: a budget wait or a run in flight ends as stopped, its slot released', async () => {
    const at = lane();
    const abort = new AbortController();
    const waiting = input(at, { budget: () => budget({ never: true }), signal: abort.signal });
    const pending = filmShotList(waiting);
    abort.abort();
    expect(await pending).toMatchObject({ kind: 'failed', code: 'stopped' });
    const midRun = new AbortController();
    const run = input(at, { signal: midRun.signal, driver: driver({ during: () => midRun.abort(), fail: new CaptureToolError('the capture run was stopped') }) });
    expect(await filmShotList(run)).toMatchObject({ kind: 'failed', code: 'stopped' });
    expect(run.budgetFake.released).toHaveLength(1);
  });
});

describe('endOrphanedCameraApps', () => {
  it('ends an app an earlier process left running, releases a slot whose app is gone, and never signals a reused pid', async () => {
    const runId = 'cr-33333333-3333-4333-8333-333333333333';
    const orphan = spawn('/bin/sh', ['-c', `eval "$${CAMERA_SERVE_ENV}" # pr media camera ${runId}`], {
      env: { ...process.env, [CAMERA_SERVE_ENV]: 'sleep 30' },
      detached: true,
      stdio: 'ignore',
    });
    const stranger = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    pids.push(orphan.pid!, stranger.pid!);
    const lease = (id: string): VerificationLease => ({ runId: id, jobId: 'j-ui', scope: CAMERA_SCOPE, command: 'x', cwd: '/lane', head: null, queuedAt: 0, grantedAt: 0 });
    // Give ps a moment to see the shell's argv.
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    const slots = budget({
      restored: [
        { lease: lease('orphan'), pid: orphan.pid!, processCommand: orphan.spawnargs.join(' ') },
        { lease: lease('stranger'), pid: stranger.pid!, processCommand: orphan.spawnargs.join(' ') },
        { lease: lease('gone'), pid: 999_999, processCommand: 'whatever' },
      ],
    });
    const exited = new Promise((resolveExit) => orphan.once('exit', resolveExit));
    expect(await endOrphanedCameraApps(() => slots)).toBe(1);
    await exited;
    expect(slots.released.map((released) => released.runId).sort()).toEqual(['gone', 'orphan']);
    // The stranger (a pid that runs something else) is alive and untouched.
    expect(() => process.kill(stranger.pid!, 0)).not.toThrow();
  });
});

describe('the agent-browser adapter', () => {
  function recorder(answer: (argv: readonly string[]) => { code: number | null; stdout?: string; error?: string | null } = () => ({ code: 0 })) {
    const calls: { argv: readonly string[]; cwd: string; env: NodeJS.ProcessEnv; aborted: boolean }[] = [];
    const run: CliRunner = async (argv, options) => {
      calls.push({ argv, cwd: options.cwd, env: options.env, aborted: options.signal.aborted });
      const result = answer(argv);
      return { code: result.code, stdout: result.stdout ?? '', stderr: '', error: result.error ?? null };
    };
    return { run, calls };
  }

  function plan(kind: 'screenshot' | 'clip'): PlannedCapture {
    return planCaptures(parseShotList(JSON.stringify({
      version: 1,
      shots: [{
        id: 'flow', proves: 'AC1', kind, viewports: [{ width: 640, height: 480 }],
        steps: [{ open: '/board?tab=1' }, { click: '#go' }, { type: '#q', text: 'mock text' }, { wait_for_text: 'Done' }],
      }],
    })))[0]!;
  }

  it('films a still in an isolated session: its own empty config, loopback-only domains, no inherited AGENT_BROWSER_ settings', async () => {
    const workDir = tmp('gru-camera-adapter-');
    const { run, calls } = recorder();
    const adapter = new AgentBrowserDriver(run, () => ({ PATH: '/usr/bin', AGENT_BROWSER_PROFILE: 'Default', AGENT_BROWSER_HEADED: '1' }));
    await adapter.shoot({ baseUrl: 'http://127.0.0.1:4321', plan: plan('screenshot'), outFile: join(workDir, 'a.png'), workDir, signal: new AbortController().signal });
    const tails = calls.map((call) => call.argv.slice(7));
    expect(tails).toEqual([
      ['set', 'viewport', '640', '480'],
      ['open', 'http://127.0.0.1:4321/board?tab=1'],
      ['click', '#go'],
      ['fill', '#q', 'mock text'],
      ['wait', '--text', 'Done'],
      ['screenshot', join(workDir, 'a.png')],
      ['close'],
    ]);
    const head = calls[0]!.argv;
    expect(head[0]).toBe('agent-browser');
    expect(head[1]).toBe('--config');
    expect(head[2]!.startsWith(workDir)).toBe(true);
    expect(readdirSync(workDir).some((name) => name.startsWith('agent-browser-') && name.endsWith('.json'))).toBe(true);
    expect(head.slice(3, 7)).toEqual(['--session', expect.stringMatching(/^gc-capture-[0-9a-f]{8}$/u), '--allowed-domains', '127.0.0.1']);
    expect(new Set(calls.map((call) => call.argv.slice(0, 7).join(' '))).size).toBe(1);
    for (const call of calls) {
      expect(call.cwd).toBe(workDir);
      expect(call.env['AGENT_BROWSER_PROFILE']).toBeUndefined();
      expect(call.env['AGENT_BROWSER_HEADED']).toBeUndefined();
      expect(call.env['AGENT_BROWSER_DEFAULT_TIMEOUT']).toBe('15000');
      expect(call.env['PATH']).toBe('/usr/bin');
    }
    expect(stepArgs({ action: 'open', path: '/x' }, 'http://[::1]:9')).toEqual(['open', 'http://[::1]:9/x']);
  });

  it('records a clip from the first page, rolls a moment past the last step, and stops the recording', async () => {
    const workDir = tmp('gru-camera-adapter-');
    const { run, calls } = recorder();
    await new AgentBrowserDriver(run, () => ({})).shoot({ baseUrl: 'http://localhost:4321', plan: plan('clip'), outFile: join(workDir, 'c.webm'), workDir, signal: new AbortController().signal });
    expect(calls.map((call) => call.argv.slice(7))).toEqual([
      ['set', 'viewport', '640', '480'],
      ['record', 'start', join(workDir, 'c.webm'), 'http://localhost:4321/board?tab=1'],
      ['click', '#go'],
      ['fill', '#q', 'mock text'],
      ['wait', '--text', 'Done'],
      ['wait', '1000'],
      ['record', 'stop'],
      ['close'],
    ]);
    expect(calls[0]!.argv.slice(5, 7)).toEqual(['--allowed-domains', 'localhost']);
  });

  it('names the failing step, tells a missing tool from a failed step, and closes the session under a live signal', async () => {
    const workDir = tmp('gru-camera-adapter-');
    const failing = recorder((argv) => (argv.includes('click') ? { code: 1, stdout: '\u001b[31m✗ Element not found.\u001b[0m Verify the selector' } : { code: 0 }));
    const abort = new AbortController();
    const shot = new AgentBrowserDriver(failing.run, () => ({})).shoot({ baseUrl: 'http://127.0.0.1:1', plan: plan('screenshot'), outFile: join(workDir, 'a.png'), workDir, signal: abort.signal });
    await expect(shot).rejects.toThrow(ShotStepError);
    await expect(shot).rejects.toThrow('shot "flow" step 2 (click "#go") failed at 640x480: ✗ Element not found. Verify the selector');
    expect(failing.calls.at(-1)!.argv.slice(7)).toEqual(['close']);
    const missing = recorder(() => ({ code: null, error: 'ENOENT' }));
    await expect(new AgentBrowserDriver(missing.run, () => ({})).shoot({ baseUrl: 'http://127.0.0.1:1', plan: plan('screenshot'), outFile: join(workDir, 'b.png'), workDir, signal: abort.signal }))
      .rejects.toThrow(CaptureToolError);
    expect(await new AgentBrowserDriver(missing.run, () => ({})).probe(abort.signal)).toMatch(/agent-browser is not installed on the Gru Command host: run `npm install -g agent-browser/u);
    expect(await new AgentBrowserDriver(recorder(() => ({ code: 0, stdout: 'agent-browser 0.25.3' })).run, () => ({})).probe(abort.signal)).toBeNull();
    // A stopped run still closes its browser: the close runs under its own signal.
    abort.abort();
    const stopped = recorder();
    await new AgentBrowserDriver(stopped.run, () => ({})).shoot({ baseUrl: 'http://127.0.0.1:1', plan: plan('screenshot'), outFile: join(workDir, 'c.png'), workDir, signal: abort.signal }).catch(() => undefined);
    expect(stopped.calls.at(-1)).toMatchObject({ aborted: false });
  });
});
