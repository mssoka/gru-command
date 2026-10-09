import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, type GruCommandConfig } from '../src/config.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { EventBus } from '../src/events/bus.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import type { VerificationScheduler } from '../src/verify/scheduler.js';
import {
  createVerificationServer,
  type VerificationServer,
} from '../src/verify/server.js';
import {
  captureReceiptPath,
  captureReceiptSucceeded,
  parseCapturedNdjson,
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
  heartbeatMs?: number;
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
  const server = createVerificationServer({
    config,
    ledger,
    worktrees,
    ...(opts.heartbeatMs === undefined ? {} : { heartbeatMs: opts.heartbeatMs }),
  });
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

/**
 * Idle-stream keepalive (incident 2026-10-09): a queued slot wait (up to
 * `lock_wait_timeout_ms`) or a quiet producer used to leave the NDJSON body
 * silent past a streaming client's 300 s default body-idle timeout, so the
 * client aborted the body and lost a valid capture while the producer kept
 * running. These tests drive a real isolated server with a short heartbeat
 * cadence (the injectable test seam) and prove periodic real body bytes,
 * unchanged producer output, terminal/disconnect cleanup, and that the
 * shipped capture reader/helper accepts the keepalive stream.
 */
const GATE_SCRIPT = [
  "import { existsSync, writeFileSync } from 'node:fs';",
  'const release = process.argv[2];',
  "writeFileSync('gate-started.txt', 'started');",
  'const deadline = Date.now() + 20000;',
  'while (!existsSync(release) && Date.now() < deadline) {',
  '  await new Promise((resolve) => setTimeout(resolve, 25));',
  '}',
  'process.exit(existsSync(release) ? 0 : 3);',
].join('\n');

const QUIET_SCRIPT = [
  'const delay = Number(process.argv[2] ?? 400);',
  "setTimeout(() => { console.log('quiet=done'); }, delay);",
].join('\n');

const HOLD_MANIFEST = [
  '[verify]',
  'full = "node verify.mjs pass"',
  'hold = "node gate.mjs held.txt"',
  '',
].join('\n');

interface TimedFrame {
  readonly at: number;
  readonly frame: Frame;
}

/** Read an NDJSON response to EOF, timestamping each body line as it lands. */
function collectNdjson(response: Response): { readonly frames: TimedFrame[]; readonly done: Promise<void> } {
  const frames: TimedFrame[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const done = (async () => {
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      buffer += decoder.decode(value, { stream: true });
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() === '') continue;
        frames.push({ at: Date.now(), frame: JSON.parse(line) as Frame });
      }
    }
    if (buffer.trim() !== '') frames.push({ at: Date.now(), frame: JSON.parse(buffer) as Frame });
  })();
  return { frames, done };
}

/** POST /api/verify and hand back the streaming response (no body buffering). */
async function streamCall(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/verify`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function frameTypes(frames: readonly TimedFrame[]): string[] {
  return frames.map((entry) => entry.frame.type);
}

function plainFrames(frames: readonly TimedFrame[]): Frame[] {
  return frames.map((entry) => entry.frame);
}

/**
 * Poll until at least `target` frames of `type` have landed (or the deadline
 * passes) and return the count reached. Never throws: a base that never pings
 * fails the caller's assertion instead of a timeout, so the fail-before
 * baseline is an assertion RED, not a harness timeout.
 */
async function frameCountUntil(
  frames: readonly TimedFrame[],
  type: string,
  target: number,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = frameTypes(frames).filter((candidate) => candidate === type).length;
    if (count >= target || Date.now() > deadline) return count;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The largest gap between consecutive body-line arrivals, in ms. */
function maxArrivalGap(frames: readonly TimedFrame[]): number {
  let worst = 0;
  for (let index = 1; index < frames.length; index += 1) {
    worst = Math.max(worst, frames[index]!.at - frames[index - 1]!.at);
  }
  return worst;
}

describe('verification stream keepalive (incident 2026-10-09)', () => {
  it('queued verification keeps response alive during slot wait', async () => {
    const harness = await boot({
      manifest: HOLD_MANIFEST,
      files: { 'gate.mjs': GATE_SCRIPT },
      maxConcurrent: 1,
      heartbeatMs: 25,
    });
    const queuedJob = harness.ledger.addJob({
      id: 'job-queued-lane',
      repo: 'verify-app',
      title: 'queued lane',
      baseBranch: 'main',
      briefing: 'queued',
    });
    harness.ledger.setJobStatus(queuedJob.id, 'working');
    const queuedLane = await harness.worktrees.createJobWorktree({
      repoPath: harness.repo.path,
      jobId: queuedJob.id,
    });

    // The first request owns the single scheduler slot until its gate file
    // appears; the second request must then WAIT (not attach, not spawn).
    const holder = collectNdjson(await streamCall(harness.port, { job_id: harness.jobId, scope: 'hold' }));
    await waitFor(() => existsSync(join(harness.lanePath, 'gate-started.txt')));
    const waiting = collectNdjson(
      await streamCall(harness.port, { job_id: queuedJob.id, scope: 'hold', request_id: 'req-queued-keepalive' }),
    );

    // While the slot is held the waiting body keeps receiving real bytes.
    const pingsWhileHeld = await frameCountUntil(waiting.frames, 'ping', 3, 2_000);
    expect(pingsWhileHeld).toBeGreaterThanOrEqual(3);
    const heldTypes = frameTypes(waiting.frames);
    expect(heldTypes[0]).toBe('queued');
    // Only the queued admission and transport pings so far: the waiting
    // request has not started, and the single slot is not bypassed.
    expect(heldTypes.every((type) => type === 'queued' || type === 'ping')).toBe(true);
    expect(existsSync(join(queuedLane.path, 'gate-started.txt'))).toBe(false);
    // The idle gap stays strictly under the client's 300 s body limit, and
    // proves repeated pings (`>= 3` above) rather than one late frame. (The
    // 300 s literal is the incident requirement; the 2 s bound is a generous,
    // load-tolerant sanity bound, not a cadence measurement.)
    expect(maxArrivalGap(waiting.frames)).toBeLessThan(300_000);
    expect(maxArrivalGap(waiting.frames)).toBeLessThan(2_000);

    // Release the holder; the queued request is admitted, then released.
    writeFileSync(join(harness.lanePath, 'held.txt'), 'go');
    await holder.done;
    await waitFor(() => existsSync(join(queuedLane.path, 'gate-started.txt')));
    writeFileSync(join(queuedLane.path, 'held.txt'), 'go');
    await waiting.done;

    const waitingTypes = frameTypes(waiting.frames);
    expect(waitingTypes.filter((type) => type === 'completed')).toHaveLength(1);
    expect(waitingTypes[waitingTypes.length - 1]).toBe('completed');
    expect(waitingTypes.lastIndexOf('ping')).toBeLessThan(waitingTypes.indexOf('completed'));
    const waitingOutcome = outcomeOf(completedFrame(plainFrames(waiting.frames)));
    expect(waitingOutcome['ok']).toBe(true);
    expect(waitingOutcome['sha']).toBe(harness.repo.head());
    expect(waitingOutcome['queuedMs']).toBeGreaterThan(0);
    // One producer for the waiting lane: the stream never minted a second
    // run and never bypassed the FIFO lock wait.
    expect(
      harness.ledger.listJobEvents(queuedJob.id).filter((event) => event.kind === 'verification.started'),
    ).toHaveLength(1);
    // The holder's stream stayed clean to EOF too: it pings while its silent
    // gate holds, and nothing follows its terminal frame.
    const holderTypes = frameTypes(holder.frames);
    expect(holderTypes.filter((type) => type === 'ping').length).toBeGreaterThanOrEqual(1);
    expect(holderTypes.filter((type) => type === 'completed')).toHaveLength(1);
    expect(holderTypes[holderTypes.length - 1]).toBe('completed');
    expect(holderTypes.lastIndexOf('ping')).toBeLessThan(holderTypes.indexOf('completed'));
    await harness.close();
  });

  it('quiet running verification keeps response alive', async () => {
    const harness = await boot({
      manifest: ['[verify]', 'full = "node quiet.mjs 400"', ''].join('\n'),
      files: { 'quiet.mjs': QUIET_SCRIPT },
      maxConcurrent: 1,
      heartbeatMs: 25,
    });
    const reading = collectNdjson(await streamCall(harness.port, { job_id: harness.jobId, scope: 'full' }));
    await reading.done;

    const types = frameTypes(reading.frames);
    const startedAt = types.indexOf('started');
    const firstOutput = types.indexOf('output');
    const completedAt = types.indexOf('completed');
    expect(startedAt).toBeGreaterThanOrEqual(0);
    expect(firstOutput).toBeGreaterThan(startedAt);
    expect(completedAt).toBeGreaterThan(firstOutput);
    expect(types.filter((type) => type === 'ping').length).toBeGreaterThanOrEqual(3);
    // The silent window between `started` and the first output is bridged by
    // pings: assert on ARRIVAL TIMES, not frame order (the scheduler emits
    // `started` after sync git reads and a spawn, so with a short test cadence
    // a ping may legitimately precede `started`).
    const startedReading = reading.frames[startedAt]!;
    const firstOutputReading = reading.frames[firstOutput]!;
    const bridging = reading.frames.filter(
      (entry) =>
        entry.frame.type === 'ping' && entry.at >= startedReading.at && entry.at <= firstOutputReading.at,
    );
    expect(bridging.length).toBeGreaterThanOrEqual(2);
    // Pings bridge the silent window (>=2 by arrival time), all strictly
    // under the 300 s client limit; the 2 s bound is a load-tolerant sanity
    // bound, not a cadence measurement.
    expect(maxArrivalGap(reading.frames.slice(startedAt, firstOutput + 1))).toBeLessThan(300_000);
    expect(maxArrivalGap(reading.frames.slice(startedAt, firstOutput + 1))).toBeLessThan(2_000);
    expect(types[types.length - 1]).toBe('completed');

    // The keepalive is transport-only: the producer's output byte/hash
    // record is exactly its own stdout, with no ping text folded in.
    const output = reading.frames
      .filter((entry) => entry.frame.type === 'output')
      .map((entry) => String(entry.frame['text']))
      .join('');
    expect(output).toBe('quiet=done\n');
    const outcome = outcomeOf(completedFrame(plainFrames(reading.frames)));
    expect(outcome['outputBytes']).toBe(Buffer.byteLength('quiet=done\n'));
    expect(outcome['outputSha256']).toBe(createHash('sha256').update('quiet=done\n').digest('hex'));
    await harness.close();
  });

  it('verification terminal and disconnect cleanup', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const harness = await boot({
      manifest: HOLD_MANIFEST,
      files: { 'gate.mjs': GATE_SCRIPT },
      maxConcurrent: 1,
      heartbeatMs: 25,
    });
    try {
      // Terminal: exactly one terminal frame, and nothing after it (the last
      // frame IS the terminal, so no transport frame can follow it).
      const terminal = collectNdjson(await streamCall(harness.port, { job_id: harness.jobId, scope: 'full' }));
      await terminal.done;
      const terminalTypes = frameTypes(terminal.frames);
      expect(terminalTypes.filter((type) => type === 'completed')).toHaveLength(1);
      expect(terminalTypes[terminalTypes.length - 1]).toBe('completed');

      // Disconnect: dropping the client neither cancels the producer nor
      // crashes the stream, and the response's heartbeat timer is cleared.
      const disconnectJob = harness.ledger.addJob({
        id: 'job-disconnect-lane',
        repo: 'verify-app',
        title: 'disconnect lane',
        baseBranch: 'main',
        briefing: 'disconnect',
      });
      harness.ledger.setJobStatus(disconnectJob.id, 'working');
      const disconnectLane = await harness.worktrees.createJobWorktree({
        repoPath: harness.repo.path,
        jobId: disconnectJob.id,
      });
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${harness.port}/api/verify`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ job_id: disconnectJob.id, scope: 'hold', request_id: 'req-disconnect-keepalive' }),
        signal: controller.signal,
      });
      const disconnected = collectNdjson(response);
      await waitFor(() => existsSync(join(disconnectLane.path, 'gate-started.txt')));
      controller.abort();
      await disconnected.done.catch(() => {});

      // Producer outcome/cancellation semantics are unchanged: the run is
      // still running, then reaches its own terminal outcome.
      expect(harness.ledger.latestJobEvent(disconnectJob.id, 'verification.completed')).toBeNull();
      writeFileSync(join(disconnectLane.path, 'held.txt'), 'go');
      await waitFor(
        () => harness.ledger.latestJobEvent(disconnectJob.id, 'verification.completed') !== null,
        10_000,
      );
      expect(harness.ledger.getJob(disconnectJob.id)?.status).toBe('working');
      const status = await statusCall(harness.port, 'request_id=req-disconnect-keepalive');
      expect(status.json).toMatchObject({ state: 'completed', started: true });
      // A fresh run after the disconnect race still succeeds (no crash).
      const after = await call(harness.port, { job_id: harness.jobId, scope: 'full' });
      expect(outcomeOf(completedFrame(after.frames))['ok']).toBe(true);

      // Every response's heartbeat interval is armed at the injected cadence
      // — scoped to our own intervals (a bare global count would count
      // unrelated runner/harness timers). Each must be unref'd, and each must
      // be cleared by the time its response has settled.
      const ourIntervals = setIntervalSpy.mock.calls
        .map((call, index) => ({ delay: call[1], result: setIntervalSpy.mock.results[index] }))
        .filter((entry) => entry.delay === 25);
      expect(ourIntervals.length).toBeGreaterThanOrEqual(3);
      for (const entry of ourIntervals) {
        const handle = entry.result?.value as NodeJS.Timeout;
        expect(handle.hasRef?.()).toBe(false);
        expect(clearIntervalSpy.mock.calls.some((call) => call[0] === handle)).toBe(true);
      }
    } finally {
      await harness.close();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('pins the heartbeat cadence and refuses an unusable one', async () => {
    const harness = await boot();
    // The default path (no injected cadence) arms exactly ONE heartbeat
    // interval, at the shipped 15,000 ms default whose worst-case idle gap
    // (2 × interval) stays strictly under the client's 300 s body-idle limit
    // — a regression to a longer default cannot stay green.
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      const reading = collectNdjson(await streamCall(harness.port, { job_id: harness.jobId, scope: 'full' }));
      await reading.done;
      const delays = setIntervalSpy.mock.calls
        .map((call) => call[1])
        .filter((delay): delay is number => typeof delay === 'number');
      const heartbeatDelays = delays.filter((delay) => delay === 15_000);
      expect(heartbeatDelays).toHaveLength(1);
      expect(2 * heartbeatDelays[0]!).toBeLessThan(300_000);
    } finally {
      setIntervalSpy.mockRestore();
    }
    // A disabled or oversized cadence is refused before any scheduler or
    // producer exists: it would reintroduce the truncation the fix removes.
    for (const unusable of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 150_000, 300_000]) {
      expect(() =>
        createVerificationServer({
          config: harness.config,
          ledger: harness.ledger,
          worktrees: harness.worktrees,
          heartbeatMs: unusable,
        }),
      ).toThrow(/heartbeat/u);
    }
    await harness.close();
  });

  it('keeps the body alive before the first producer frame', async () => {
    const harness = await boot({ heartbeatMs: 25 });
    const outcome = {
      runId: 'run-stub-leading-ping',
      jobId: harness.jobId,
      scope: 'full',
      command: 'node verify.mjs pass',
      cwd: harness.lanePath,
      ok: true,
      exitCode: 0,
      signal: null,
      timedOut: false,
      queuedMs: 0,
      durationMs: 1,
      sha: harness.repo.head(),
      trackedDirty: false,
      workers: 1,
      outputBytes: 0,
      outputSha256: createHash('sha256').digest('hex'),
      outputTail: '',
      error: null,
    };
    // A scheduler whose FIRST frame lands after several heartbeat intervals:
    // the writeHead-anchored idle clock must emit leading pings, never a
    // silent pre-frame body.
    const stubScheduler = {
      start: () => {},
      dispose: async () => {},
      view: () => ({ lockInUse: false, activeRuns: 0, queuedRuns: 0, workerBudget: 1, workersPerRun: 1 }),
      run: async (_spec: unknown, sink: (frame: unknown) => void | Promise<void>) => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        await sink({ type: 'queued', runId: outcome.runId, position: 0, active: 0, limit: 1 });
        await sink({ type: 'started', runId: outcome.runId, workers: 1, sha: outcome.sha, queuedMs: 0 });
        await sink({ type: 'completed', runId: outcome.runId, outcome });
        return outcome;
      },
    };
    const server = createVerificationServer({
      config: harness.config,
      ledger: harness.ledger,
      worktrees: harness.worktrees,
      scheduler: stubScheduler as unknown as VerificationScheduler,
      heartbeatMs: 25,
    });
    const http: HttpServer = createServer((req, res) => {
      if (server.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolveListen) => http.listen(0, '127.0.0.1', resolveListen));
    const port = (http.address() as AddressInfo).port;
    try {
      const reading = collectNdjson(await streamCall(port, { job_id: harness.jobId, scope: 'full' }));
      await reading.done;
      const types = frameTypes(reading.frames);
      const firstPing = types.indexOf('ping');
      const firstFrame = types.findIndex((type) => type !== 'ping');
      expect(firstPing).toBeGreaterThanOrEqual(0);
      // A ping precedes the first producer frame: the body is never silent,
      // even before admission.
      expect(firstPing).toBeLessThan(firstFrame);
      expect(types[types.length - 1]).toBe('completed');
    } finally {
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
      await server.dispose();
      await harness.close();
    }
  });

  it('keeps an attached duplicate stream alive and stops at its terminal', async () => {
    const harness = await boot({
      manifest: ['[verify]', 'full = "node quiet.mjs 400"', ''].join('\n'),
      files: { 'quiet.mjs': QUIET_SCRIPT },
      maxConcurrent: 2,
      heartbeatMs: 25,
    });
    const first = collectNdjson(
      await streamCall(harness.port, { job_id: harness.jobId, scope: 'full', request_id: 'req-attach-keepalive-1' }),
    );
    await waitFor(() => first.frames.length >= 1);
    // The duplicate submission attaches to the SAME in-flight producer.
    const second = collectNdjson(
      await streamCall(harness.port, { job_id: harness.jobId, scope: 'full', request_id: 'req-attach-keepalive-2' }),
    );
    await Promise.all([first.done, second.done]);

    const attachedTypes = frameTypes(second.frames);
    expect(attachedTypes[0]).toBe('attached');
    expect(attachedTypes.filter((type) => type === 'ping').length).toBeGreaterThanOrEqual(3);
    expect(attachedTypes.filter((type) => type === 'completed')).toHaveLength(1);
    expect(attachedTypes[attachedTypes.length - 1]).toBe('completed');
    expect(attachedTypes.lastIndexOf('ping')).toBeLessThan(attachedTypes.indexOf('completed'));
    // One producer only: the duplicate attached, it never spawned a second.
    expect(
      harness.ledger.listJobEvents(harness.jobId).filter((event) => event.kind === 'verification.started'),
    ).toHaveLength(1);
    expect(outcomeOf(completedFrame(plainFrames(second.frames)))['runId']).toBe(
      outcomeOf(completedFrame(plainFrames(first.frames)))['runId'],
    );
    await harness.close();
  });

  it('capture remains honest with keepalive', async () => {
    const harness = await boot({
      manifest: ['[verify]', 'full = "node verify.mjs pass"', 'quiet = "node quiet.mjs 400"', ''].join('\n'),
      files: { 'quiet.mjs': QUIET_SCRIPT },
      heartbeatMs: 25,
    });
    const sinkPath = join(harness.lanePath, 'verify-capture-pings.ndjson');
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
    const exitCode = await runCaptureCli(
      [
        'run',
        '--job',
        harness.jobId,
        '--scope',
        'quiet',
        '--sink',
        sinkPath,
        '--request-id',
        'req-capture-keepalive',
        '--url',
        `http://127.0.0.1:${harness.port}`,
        '--token',
        TOKEN,
      ],
      cliDeps,
    );
    // The quiet run's silent window carried keepalives; the shipped helper
    // still received one terminal plus real EOF and wrote a truthful,
    // promotable receipt bound to the real head and run.
    expect(exitCode).toBe(0);
    const receipt = readCaptureReceipt(captureReceiptPath(sinkPath));
    expect(receipt).not.toBeNull();
    expect(receipt!.outcome).toBe('completed');
    expect(captureReceiptSucceeded(receipt!)).toBe(true);
    expect(receipt!.head).toBe(harness.repo.head());
    const recorded = harness.ledger.latestJobEvent(harness.jobId, 'verification.completed');
    expect(receipt!.run_id).toBe((recorded?.payload as Record<string, unknown> | undefined)?.['run_id']);
    const captured = readFileSync(sinkPath, 'utf-8');
    expect(captured).toContain('"type":"ping"');
    expect(captured).toContain('"type":"completed"');
    const parsed = parseCapturedNdjson(captured);
    expect(parsed.malformed).toBe(0);
    // Producer frames and transport pings are recorded separately, and the
    // receipt's count still matches the honest capture reader's.
    expect(parsed.frames).toBe(receipt!.frames);
    expect(parsed.pings).toBe(receipt!.pings);
    expect(receipt!.pings).toBeGreaterThan(0);
    expect((captured.match(/"type":"completed"/gu) ?? [])).toHaveLength(1);
    // Exactly one producer ran: the keepalive never minted a second run.
    expect(
      harness.ledger.listJobEvents(harness.jobId).filter((event) => event.kind === 'verification.started'),
    ).toHaveLength(1);
    await harness.close();
  });
});
