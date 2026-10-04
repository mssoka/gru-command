import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, type GruCommandConfig } from '../src/config.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { EventBus } from '../src/events/bus.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { createVerificationServer, type VerificationServer } from '../src/verify/server.js';
import {
  captureReceiptPath,
  captureReceiptSucceeded,
  readCaptureReceipt,
} from '../src/verify/capture.js';
import { runCaptureCli, type CaptureCliDeps } from '../src/verify/capture-cli.js';
import { loadWorktreeManifest, resolveVerifyCommand } from '../src/worktrees/manifest.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * POST /api/verify (contention fix, 2026-09-22): the lane-facing surface —
 * runs the project's declared verify command inside the lane worktree
 * under the global budget, streams NDJSON progress, records the outcome to
 * the ledger, and fails lock waits loud.
 */

const TOKEN = 'verify-test-token';
const VERIFY_SCRIPT = [
  'const mode = process.argv[2] ?? "pass";',
  'console.log(`mode=${mode} workers=${process.env.VITEST_MAX_THREADS}`);',
  'if (mode === "fail") process.exit(7);',
  'if (mode === "slow") setTimeout(() => process.exit(0), 700);',
].join('\n');
const VERIFY_MANIFEST = [
  '[verify]',
  'full = "node verify.mjs pass"',
  'failing = "node verify.mjs fail"',
  'slow = "node verify.mjs slow"',
  '',
].join('\n');

const dirs: string[] = [];
const repos: FixtureRepo[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  while (harnesses.length > 0) {
    try {
      await harnesses.pop()!.close();
    } catch {
      /* best effort */
    }
  }
  while (repos.length > 0) repos.pop()!.cleanup();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface Harness {
  readonly port: number;
  readonly config: GruCommandConfig;
  readonly ledger: LedgerApi;
  readonly worktrees: InMemoryWorktreePort;
  readonly repo: FixtureRepo;
  readonly lanePath: string;
  readonly jobId: string;
  readonly server: VerificationServer;
  readonly close: () => Promise<void>;
}

async function boot(opts: {
  manifest?: string | null;
  lockWaitTimeoutMs?: number;
  maxConcurrent?: number;
  workerBudget?: number;
  files?: Readonly<Record<string, string>>;
} = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gru-verify-server-'));
  dirs.push(dir);
  const configLines = [
    '[auth]',
    `token = "${TOKEN}"`,
    '[server]',
    'host = "127.0.0.1"',
    'port = 0',
    '[verify]',
    `max_concurrent = ${opts.maxConcurrent ?? 1}`,
    `worker_budget = ${opts.workerBudget ?? 4}`,
    `lock_wait_timeout_ms = ${opts.lockWaitTimeoutMs ?? 5_000}`,
    'run_timeout_ms = 20000',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'config.toml'), configLines, 'utf-8');
  mkdirSync(join(dir, 'wtroot'));
  const config = loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
  const db = new LedgerDb(dir);
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const worktrees = new InMemoryWorktreePort(join(dir, 'wtroot'));
  const repo = makeFixtureRepo('verify-app');
  repos.push(repo);
  if (opts.manifest !== null) {
    repo.commitFile('.gru-command/worktree.toml', opts.manifest ?? VERIFY_MANIFEST);
    repo.commitFile('verify.mjs', VERIFY_SCRIPT);
    for (const [file, content] of Object.entries(opts.files ?? {})) repo.commitFile(file, content);
  }
  const jobId = 'job-verify';
  ledger.addJob({ id: jobId, repo: 'verify-app', title: 'verify the lane', baseBranch: 'main', briefing: 'verify' });
  ledger.setJobStatus(jobId, 'working');
  const lane = await worktrees.createJobWorktree({ repoPath: repo.path, jobId });
  const server = createVerificationServer({ config, ledger, worktrees });
  const http: HttpServer = createServer((req, res) => {
    if (server.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolveListen) => http.listen(0, '127.0.0.1', resolveListen));
  const port = (http.address() as AddressInfo).port;
  let closed = false;
  const harness: Harness = {
    port,
    config,
    ledger,
    worktrees,
    repo,
    lanePath: lane.path,
    jobId,
    server,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
      await server.dispose();
      db.close();
    },
  };
  harnesses.push(harness);
  return harness;
}

interface Frame {
  readonly type: string;
  readonly [key: string]: unknown;
}

async function call(
  port: number,
  body: unknown,
  opts: { method?: string; token?: string | null } = {},
): Promise<{ status: number; frames: Frame[]; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/verify`, {
    method: opts.method ?? 'POST',
    headers: {
      ...(opts.token === null ? {} : { authorization: `Bearer ${opts.token ?? TOKEN}` }),
      'content-type': 'application/json',
    },
    ...(opts.method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('ndjson')) {
    const frames = text
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Frame);
    return { status: res.status, frames, json: null };
  }
  return { status: res.status, frames: [], json: text === '' ? null : JSON.parse(text) };
}

function completedFrame(frames: Frame[]): Frame {
  const frame = frames.find((candidate) => candidate.type === 'completed');
  expect(frame, `no completed frame in ${JSON.stringify(frames)}`).toBeDefined();
  return frame!;
}

/** The completed frame nests the full outcome under `outcome`. */
function outcomeOf(frame: Frame): Record<string, unknown> {
  const outcome = frame['outcome'];
  expect(outcome, `no outcome in ${JSON.stringify(frame)}`).toBeDefined();
  return outcome as Record<string, unknown>;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('POST /api/verify', () => {
  it('resolves the checked-in full gate through the same manifest resolver as the endpoint', () => {
    const manifest = loadWorktreeManifest(join(import.meta.dirname, '..'));
    expect(manifest).not.toBeNull();
    expect(resolveVerifyCommand(manifest!, 'full')).toBe('npm test');
    expect(() => resolveVerifyCommand(manifest!, 'typo')).toThrow(/not declared/);
  });

  it('runs the declared command in the lane worktree and records the outcome + duration', async () => {
    const harness = await boot();
    const { status, frames } = await call(harness.port, { job_id: harness.jobId, scope: 'full' });
    expect(status).toBe(200);
    expect(frames.map((frame) => frame.type)).toEqual(['queued', 'started', 'output', 'completed']);
    const completed = completedFrame(frames);
    expect(outcomeOf(completed)['ok']).toBe(true);
    expect(outcomeOf(completed)['exitCode']).toBe(0);
    expect(outcomeOf(completed)['sha']).toBe(harness.repo.head());
    const output = frames
      .filter((frame) => frame.type === 'output')
      .map((frame) => frame['text'])
      .join('');
    expect(output).toContain('mode=pass');
    const recorded = harness.ledger.latestJobEvent(harness.jobId, 'verification.completed');
    expect(recorded?.payload).toMatchObject({
      ok: true,
      exit_code: 0,
      scope: 'full',
      command: 'node verify.mjs pass',
      sha: harness.repo.head(),
    });
    expect((recorded?.payload as { duration_ms: number }).duration_ms).toBeGreaterThanOrEqual(0);
    expect(harness.ledger.latestJobEvent(harness.jobId, 'verification.started')).not.toBeNull();
    await harness.close();
  });

  it('enforces the global worker budget in the run environment', async () => {
    const harness = await boot({ maxConcurrent: 2, workerBudget: 4 });
    const { frames } = await call(harness.port, { job_id: harness.jobId });
    const completed = completedFrame(frames);
    expect(outcomeOf(completed)['workers']).toBe(2);
    const output = frames
      .filter((frame) => frame.type === 'output')
      .map((frame) => frame['text'])
      .join('');
    expect(output).toContain('workers=2');
    await harness.close();
  });

  it('records a failed run as an outcome and leaves the job status alone', async () => {
    const harness = await boot();
    const { status, frames } = await call(harness.port, { job_id: harness.jobId, scope: 'failing' });
    expect(status).toBe(200);
    const completed = completedFrame(frames);
    expect(outcomeOf(completed)['ok']).toBe(false);
    expect(outcomeOf(completed)['exitCode']).toBe(7);
    expect(harness.ledger.getJob(harness.jobId)?.status).toBe('working');
    const recorded = harness.ledger.latestJobEvent(harness.jobId, 'verification.completed');
    expect(recorded?.payload).toMatchObject({ ok: false, exit_code: 7 });
    await harness.close();
  });

  it('surfaces a lock-wait timeout as a loud error frame plus a ledger record', async () => {
    const harness = await boot({ lockWaitTimeoutMs: 150, maxConcurrent: 1 });
    const first = call(harness.port, { job_id: harness.jobId, scope: 'slow' });
    await waitFor(() => harness.ledger.latestJobEvent(harness.jobId, 'verification.started') !== null);
    const second = await call(harness.port, { job_id: harness.jobId, scope: 'full' });
    expect(second.status).toBe(200);
    const error = second.frames.find((frame) => frame.type === 'error');
    expect(error).toBeDefined();
    expect(error?.['code']).toBe('lock_wait_timeout');
    expect(harness.ledger.latestJobEvent(harness.jobId, 'verification.lock-timeout')).not.toBeNull();
    const firstResult = await first;
    expect(outcomeOf(completedFrame(firstResult.frames))['ok']).toBe(true);
    await harness.close();
  });

  it('serializes runs across different jobs/lanes: the second queues until the first releases', async () => {
    const gate = [
      "import { existsSync, writeFileSync } from 'node:fs';",
      'const release = process.argv[2];',
      "writeFileSync('gate-started.txt', 'started');",
      'const deadline = Date.now() + 20000;',
      'while (!existsSync(release) && Date.now() < deadline) {',
      '  await new Promise((resolve) => setTimeout(resolve, 25));',
      '}',
      'process.exit(existsSync(release) ? 0 : 3);',
    ].join('\n');
    const harness = await boot({
      manifest: ['[verify]', 'full = "node gate.mjs held.txt"', ''].join('\n'),
      files: { 'gate.mjs': gate },
      maxConcurrent: 1,
    });
    const other = harness.ledger.addJob({
      id: 'job-second-lane',
      repo: 'verify-app',
      title: 'second lane',
      baseBranch: 'main',
      briefing: 'second',
    });
    harness.ledger.setJobStatus(other.id, 'working');
    const otherLane = await harness.worktrees.createJobWorktree({
      repoPath: harness.repo.path,
      jobId: other.id,
    });

    const first = call(harness.port, { job_id: harness.jobId });
    await waitFor(() => existsSync(join(harness.lanePath, 'gate-started.txt')));
    const second = call(harness.port, { job_id: other.id });
    // While the first lane HOLDS the gate, the second lane must not start:
    // the lock is cross-worktree, not per-job. (Deterministic — the first
    // cannot finish until held.txt appears below.)
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(join(otherLane.path, 'gate-started.txt'))).toBe(false);
    expect(harness.ledger.latestJobEvent(other.id, 'verification.started')).toBeNull();

    // Release the first lane; its completion must precede the second's start.
    writeFileSync(join(harness.lanePath, 'held.txt'), 'go');
    const firstResult = await first;
    expect(outcomeOf(completedFrame(firstResult.frames))['ok']).toBe(true);
    await waitFor(() => existsSync(join(otherLane.path, 'gate-started.txt')));
    writeFileSync(join(otherLane.path, 'held.txt'), 'go');
    const secondResult = await second;
    expect(secondResult.frames[0]?.['type']).toBe('queued');
    expect(outcomeOf(completedFrame(secondResult.frames))['ok']).toBe(true);
    const firstCompleted = harness.ledger.latestJobEvent(harness.jobId, 'verification.completed');
    const secondStarted = harness.ledger.latestJobEvent(other.id, 'verification.started');
    expect(firstCompleted).not.toBeNull();
    expect(secondStarted?.seq).toBeGreaterThan(firstCompleted?.seq ?? Number.MAX_SAFE_INTEGER);
    await harness.close();
  });

  it('answers 404 for an unknown job', async () => {
    const harness = await boot();
    const { status, json } = await call(harness.port, { job_id: 'job-nope' });
    expect(status).toBe(404);
    expect(json).toMatchObject({ error: 'job_not_found' });
    await harness.close();
  });

  it('answers 400 naming the declared scopes for an unknown scope', async () => {
    const harness = await boot();
    const { status, json } = await call(harness.port, { job_id: harness.jobId, scope: 'nope' });
    expect(status).toBe(400);
    expect(json).toMatchObject({ error: 'unknown_scope', declared_scopes: ['failing', 'full', 'slow'] });
    await harness.close();
  });

  it('answers 409 when the job has no active lane', async () => {
    const harness = await boot();
    const other = harness.ledger.addJob({ id: 'job-laneless', repo: 'verify-app', title: 'no lane', briefing: 'x' });
    const { status, json } = await call(harness.port, { job_id: other.id });
    expect(status).toBe(409);
    expect(json).toMatchObject({ error: 'no_active_lane' });
    await harness.close();
  });

  it('answers 409 when the repository declares no verify command', async () => {
    const harness = await boot({ manifest: null });
    const { status, json } = await call(harness.port, { job_id: harness.jobId });
    expect(status).toBe(409);
    expect(json).toMatchObject({ error: 'no_verify_command' });
    await harness.close();
  });

  it('requires the pairing token', async () => {
    const harness = await boot();
    const { status, json } = await call(harness.port, { job_id: harness.jobId }, { token: null });
    expect(status).toBe(401);
    expect(json).toMatchObject({ error: 'unauthorized' });
    await harness.close();
  });

  it('rejects non-POST methods', async () => {
    const harness = await boot();
    const { status, json } = await call(harness.port, undefined, { method: 'GET' });
    expect(status).toBe(405);
    expect(json).toMatchObject({ error: 'method_not_allowed' });
    await harness.close();
  });
});

async function statusCall(
  port: number,
  query: string,
  opts: { method?: string; token?: string | null } = {},
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/verify/status?${query}`, {
    method: opts.method ?? 'GET',
    headers: opts.token === null ? {} : { authorization: `Bearer ${opts.token ?? TOKEN}` },
  });
  const text = await res.text();
  return { status: res.status, json: text === '' ? null : JSON.parse(text) };
}

describe('verification single-flight + reconcile (issue #159)', () => {
  it('simultaneous POSTs for the same job/head/scope share ONE producer; the duplicate attaches', async () => {
    const harness = await boot({ maxConcurrent: 2 });
    const first = call(harness.port, { job_id: harness.jobId, scope: 'slow' });
    const second = call(harness.port, { job_id: harness.jobId, scope: 'slow' });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    const firstOutcome = outcomeOf(completedFrame(firstResult.frames));
    const secondOutcome = outcomeOf(completedFrame(secondResult.frames));
    expect(secondResult.frames[0]?.['type']).toBe('attached');
    expect(secondOutcome['runId']).toBe(firstOutcome['runId']);
    const started = harness.ledger
      .listJobEvents(harness.jobId)
      .filter((event) => event.kind === 'verification.started');
    const completed = harness.ledger
      .listJobEvents(harness.jobId)
      .filter((event) => event.kind === 'verification.completed');
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    await harness.close();
  });

  it('replays a completed request_id instead of rerunning, and reconciles unknown → running → completed', async () => {
    const harness = await boot({ maxConcurrent: 2 });
    const requestId = 'req-server-replay';
    const unknown = await statusCall(harness.port, `request_id=${requestId}`);
    expect(unknown.status).toBe(200);
    expect(unknown.json).toMatchObject({ state: 'unknown', requestId });

    const first = await call(harness.port, { job_id: harness.jobId, scope: 'slow', request_id: requestId });
    const firstOutcome = outcomeOf(completedFrame(first.frames));
    expect(firstOutcome['ok']).toBe(true);

    const done = await statusCall(harness.port, `request_id=${requestId}`);
    expect(done.json).toMatchObject({
      state: 'completed',
      runId: firstOutcome['runId'],
      started: true,
    });

    const replay = await call(harness.port, { job_id: harness.jobId, scope: 'slow', request_id: requestId });
    expect(replay.frames).toHaveLength(1);
    expect(replay.frames[0]).toMatchObject({ type: 'completed', reconciled: true });
    expect(outcomeOf(replay.frames[0]!)['runId']).toBe(firstOutcome['runId']);

    const started = harness.ledger
      .listJobEvents(harness.jobId)
      .filter((event) => event.kind === 'verification.started');
    expect(started).toHaveLength(1);
    await harness.close();
  });

  it('treats a lost response as unknown and reconciles by request identity before resubmission', async () => {
    const harness = await boot({ maxConcurrent: 2 });
    const requestId = 'req-server-lost';
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${harness.port}/api/verify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ job_id: harness.jobId, scope: 'slow', request_id: requestId }),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    // Read until the run has genuinely started, then drop the connection:
    // the client's outcome is now UNKNOWN, not replay authority.
    while (!seen.includes('"type":"started"')) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
    }
    expect(seen).toContain('started');
    controller.abort();

    const running = await statusCall(harness.port, `request_id=${requestId}`);
    expect(running.json).toMatchObject({ state: 'running', started: true });

    // Reconnecting with the SAME identity attaches to the one producer.
    const resumed = await call(harness.port, { job_id: harness.jobId, scope: 'slow', request_id: requestId });
    expect(resumed.frames[0]?.['type']).toBe('attached');
    expect(outcomeOf(completedFrame(resumed.frames))['ok']).toBe(true);
    const started = harness.ledger
      .listJobEvents(harness.jobId)
      .filter((event) => event.kind === 'verification.started');
    expect(started).toHaveLength(1);
    await harness.close();
  });

  it('refuses a submission whose named head no longer matches the lane (409, before any producer)', async () => {
    const harness = await boot();
    const stale = await call(harness.port, {
      job_id: harness.jobId,
      scope: 'full',
      expected_head: '0'.repeat(40),
    });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ error: 'head_changed', current_head: harness.repo.head() });
    expect(
      harness.ledger.listJobEvents(harness.jobId).filter((event) => event.kind === 'verification.started'),
    ).toHaveLength(0);
    const exact = await call(harness.port, {
      job_id: harness.jobId,
      scope: 'full',
      expected_head: harness.repo.head(),
    });
    expect(outcomeOf(completedFrame(exact.frames))['sha']).toBe(harness.repo.head());
    await harness.close();
  });

  it('status requires auth, a valid identity, and GET', async () => {
    const harness = await boot();
    expect((await statusCall(harness.port, 'request_id=req-x', { token: null })).status).toBe(401);
    expect((await statusCall(harness.port, 'job_id=')).status).toBe(400);
    expect((await statusCall(harness.port, 'request_id=bad%20id')).status).toBe(400);
    const wrongMethod = await statusCall(harness.port, 'request_id=req-x', { method: 'POST' });
    expect(wrongMethod.status).toBe(405);
    await harness.close();
  });

  it('capture CLI writes a unique exclusive sink + receipt bound to the recorded run, never truncating', async () => {
    const harness = await boot();
    const sinkPath = join(harness.lanePath, 'verify-capture.ndjson');
    const cliDeps: CaptureCliDeps = {
      probe: () => ({
        alive: true,
        startTime: 'Mon Oct  6 12:00:00 2026',
        cwd: harness.lanePath,
        command: 'node capture-cli run',
      }),
      argv: ['capture-cli', 'run'],
      stdout: () => {},
      stderr: () => {},
    };
    const args = [
      'run',
      '--job',
      harness.jobId,
      '--scope',
      'full',
      '--sink',
      sinkPath,
      '--request-id',
      'req-e2e-capture',
      '--url',
      `http://127.0.0.1:${harness.port}`,
      '--token',
      TOKEN,
    ];
    expect(await runCaptureCli(args, cliDeps)).toBe(0);
    const receipt = readCaptureReceipt(captureReceiptPath(sinkPath));
    expect(receipt).not.toBeNull();
    expect(captureReceiptSucceeded(receipt!)).toBe(true);
    const recorded = harness.ledger.latestJobEvent(harness.jobId, 'verification.completed');
    expect(receipt!.run_id).toBe((recorded?.payload as Record<string, unknown> | undefined)?.['run_id']);
    expect(receipt!.head).toBe(harness.repo.head());
    expect(receipt!.capture_sha256).toMatch(/^[0-9a-f]{64}$/);
    const captured = readFileSync(sinkPath, 'utf-8');
    expect(captured).toContain('"type":"completed"');

    // A second capture for the same sink is refused without truncation.
    const secondArgs = [...args];
    secondArgs[secondArgs.indexOf('req-e2e-capture')] = 'req-e2e-second';
    const second = await runCaptureCli(secondArgs, cliDeps);
    expect(second).toBe(2);
    expect(readFileSync(sinkPath, 'utf-8')).toBe(captured);

    // Reconnecting with the SAME request identity replays the recorded run
    // into a fresh sink: no second execution, and the replay is honestly
    // marked as an unpromotable partial capture (the run's outcome is
    // known; the original full logs are NOT reconstructable).
    const replaySink = join(harness.lanePath, 'verify-capture-replay.ndjson');
    const replayArgs = [...args];
    replayArgs[replayArgs.indexOf(sinkPath)] = replaySink;
    expect(await runCaptureCli(replayArgs, cliDeps)).toBe(1);
    const replayReceipt = readCaptureReceipt(captureReceiptPath(replaySink));
    expect(replayReceipt!.run_id).toBe(receipt!.run_id);
    expect(replayReceipt!.reconciled).toBe(true);
    expect(captureReceiptSucceeded(replayReceipt!)).toBe(false);
    const started = harness.ledger
      .listJobEvents(harness.jobId)
      .filter((event) => event.kind === 'verification.started');
    expect(started).toHaveLength(1);

    // The helper's --expected-head travels to the server: a stale named head
    // is refused BEFORE any producer exists (exit 2, no started event).
    const staleSink = join(harness.lanePath, 'verify-capture-stale.ndjson');
    const staleArgs = [...args];
    staleArgs[staleArgs.indexOf(sinkPath)] = staleSink;
    staleArgs[staleArgs.indexOf('req-e2e-capture')] = 'req-e2e-stale';
    staleArgs.push('--expected-head', '0'.repeat(40));
    expect(await runCaptureCli(staleArgs, cliDeps)).toBe(2);
    const staleReceipt = readCaptureReceipt(captureReceiptPath(staleSink));
    expect(staleReceipt!.error).toContain('head_changed');
    expect(
      harness.ledger.listJobEvents(harness.jobId).filter((event) => event.kind === 'verification.started'),
    ).toHaveLength(1);
    await harness.close();
  });
});
