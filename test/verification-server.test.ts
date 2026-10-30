import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { loadConfig, type GruCommandConfig } from '../src/config.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { EventBus } from '../src/events/bus.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { VerificationLockTimeoutError, type VerificationScheduler } from '../src/verify/scheduler.js';
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
  readonly db: LedgerDb;
  readonly close: () => Promise<void>;
  readonly restart: () => Promise<Harness>;
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
  let db = new LedgerDb(dir);
  let ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
  const worktrees = new InMemoryWorktreePort(join(dir, 'wtroot'), ledger);
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
  let server = createVerificationServer({
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
    get server() { return server; },
    get db() { return db; },
    restart: async () => {
      await server.dispose(); db.close();
      db = new LedgerDb(dir); ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
      server = createVerificationServer({ config, ledger, worktrees });
      return { ...harness, ledger, server };
    },
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
  it('PR334 receipt aggregate verification bounds are enforced without eager payload materialization', async () => {
    const h = await boot(); const requestId = 'pr334-bounded-receipts';
    const result = await call(h.port, { job_id: h.jobId, scope: 'full', request_id: requestId });
    const outcome = outcomeOf(completedFrame(result.frames)); expect(outcome['ok']).toBe(true);
    const started = h.ledger.latestJobEvent(h.jobId, 'verification.started')!;
    const facts = started.payload as { pid: number; command: string; cwd: string };
    const lane = h.worktrees.listWorktrees({ jobId: h.jobId })[0]!;
    if (h.ledger.getWorktree(lane.id) === null) h.ledger.registerWorktree({ id: lane.id, repoName: 'fixture', repoPath: h.repo.path, path: lane.path, branch: lane.branch,
      sha: h.repo.head(), kind: 'job', jobId: h.jobId });
    h.ledger.recordWorktreeProcesses({ worktreeId: lane.id, state: 'live', processes: [{ pid: facts.pid, command: `/bin/sh -c ${facts.command}`, evidence: 'registry' }] });
    for (let i = 0; i < 2; i += 1) h.ledger.appendCustomEvent({ kind: 'verification.process-started', jobId: h.jobId,
      payload: { ...(started.payload as Record<string, unknown>), untrusted_padding: 'x'.repeat(4 * 1024 * 1024) } });
    const before = h.ledger.listWorktreeProcesses(lane.id);
    const prepare = h.db.handle.prepare.bind(h.db.handle); let eagerMaterializations = 0;
    const spy = vi.spyOn(h.db.handle, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes('payload_bytes FROM events') && sql.includes('verification.process-started')) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, 'all').mockImplementation((...parameters) => { eagerMaterializations += 1; return all(...parameters); });
      }
      return statement;
    });
    try {
      expect(() => h.ledger.reconcileVerificationProcesses({ jobId: h.jobId, runId: String(outcome['runId']), requestId,
        command: facts.command, cwd: facts.cwd, worktreeId: lane.id })).toThrow(/complete-evidence bounds/);
      expect(eagerMaterializations).toBe(0);
      expect(h.ledger.listWorktreeProcesses(lane.id)).toEqual(before);
      expect(h.ledger.latestJobEvent(h.jobId, 'verification.process-reconciled')).toBeNull();
    } finally { spy.mockRestore(); }
    await h.close();
  });

  it('records a credential-bearing scope command masked in the lane process row, and the terminal readback still closes that row (#534)', async () => {
    const secret = 'Kq7ZmW3xP9tR2vLd8Nc4'; const requestId = 'argv-redaction-readback';
    const command = `node verify.mjs pass --token ${secret}`;
    const h = await boot({ manifest: `[verify]\nfull = "${command}"\n` });
    try {
      const lane = h.worktrees.listWorktrees({ jobId: h.jobId })[0]!;
      // The port may be ledger-backed (the row exists) or a test double (it does not).
      if (h.ledger.getWorktree(lane.id) === null) h.ledger.registerWorktree({ id: lane.id, repoName: 'fixture', repoPath: h.repo.path, path: lane.path, branch: lane.branch, sha: h.repo.head(), kind: 'job', jobId: h.jobId });
      const result = await call(h.port, { job_id: h.jobId, scope: 'full', request_id: requestId });
      const outcome = outcomeOf(completedFrame(result.frames)); expect(outcome['ok']).toBe(true);
      // What the server recorded at the run's spawn and settlement.
      const recorded = h.ledger.listWorktreeProcesses(lane.id);
      expect(recorded.length).toBeGreaterThan(0);
      for (const row of recorded) { expect(row.command).not.toContain(secret); expect(row.command).toContain('[REDACTED]'); }
      // R2: the whole event stream the run left holds the scope's command masked, in every field that carries it.
      const lifecycle = h.ledger.listJobEventsByKinds(h.jobId, ['verification.requested', 'verification.started', 'verification.process-started', 'verification.completed']);
      expect(new Set(lifecycle.map((event) => event.kind))).toEqual(new Set(['verification.requested', 'verification.started', 'verification.process-started', 'verification.completed']));
      for (const event of lifecycle) {
        const fields = event.payload as Record<string, unknown>;
        for (const field of ['command', 'process_command', 'step_command', 'dedupe_key']) {
          if (fields[field] === undefined) continue;
          expect(String(fields[field]), `${event.kind}.${field}`).not.toContain(secret);
          expect(String(fields[field]), `${event.kind}.${field}`).toContain('[REDACTED]');
        }
      }
      expect(lifecycle.find((event) => event.kind === 'verification.started')?.payload).toMatchObject({ command: 'node verify.mjs pass --token [REDACTED]' });
      expect(lifecycle.find((event) => event.kind === 'verification.process-started')?.payload)
        .toMatchObject({ command: 'node verify.mjs pass --token [REDACTED]', process_command: '/bin/sh -c node verify.mjs pass --token [REDACTED]', step_command: 'node verify.mjs pass --token [REDACTED]' });
      expect(JSON.stringify(h.ledger.listEvents({ limit: 5_000 }))).not.toContain(secret);
      // The run's process is gone; its row, live again, is closed by the readback of the original receipts. The
      // readback's command is the raw one the scheduler kept: the events hold it masked.
      const facts = h.ledger.latestJobEvent(h.jobId, 'verification.started')!.payload as { pid: number; cwd: string };
      const liveRow = () => h.ledger.listWorktreeProcesses(lane.id).find((row) => row.pid === facts.pid);
      const reconcile = () => h.ledger.reconcileVerificationProcesses({ jobId: h.jobId, runId: String(outcome['runId']), requestId, command, cwd: facts.cwd, worktreeId: lane.id });
      h.ledger.recordWorktreeProcesses({ worktreeId: lane.id, state: 'live', processes: [{ pid: facts.pid, command: `/bin/sh -c ${command}`, evidence: 'registry' }] });
      expect(liveRow()).toMatchObject({ state: 'live' });
      reconcile();
      expect(liveRow()).toMatchObject({ state: 'killed' });
      const audit = h.ledger.latestJobEvent(h.jobId, 'verification.process-reconciled');
      expect(audit?.payload).toMatchObject({ pid: facts.pid, request_id: requestId });
      expect(String((audit?.payload as { command: string }).command)).not.toContain(secret);
      expect(JSON.stringify(h.ledger.listEvents({ limit: 5_000 }))).not.toContain(secret);
    } finally { await h.close(); }
  });

  it('closes a registry row at the terminal readback only by the digest of its raw command: another credential under the same masked text, and a row without a digest, stay live (#534 R1)', async () => {
    const secret = 'Kq7ZmW3xP9tR2vLd8Nc4'; const other = 'Zx5Hn2Bv8Qd4Wm7Lt3Pc'; const requestId = 'argv-redaction-identity';
    const command = `node verify.mjs pass --token ${secret}`;
    const h = await boot({ manifest: `[verify]\nfull = "${command}"\n` });
    try {
      const lane = h.worktrees.listWorktrees({ jobId: h.jobId })[0]!;
      if (h.ledger.getWorktree(lane.id) === null) h.ledger.registerWorktree({ id: lane.id, repoName: 'fixture', repoPath: h.repo.path, path: lane.path, branch: lane.branch, sha: h.repo.head(), kind: 'job', jobId: h.jobId });
      const result = await call(h.port, { job_id: h.jobId, scope: 'full', request_id: requestId });
      const outcome = outcomeOf(completedFrame(result.frames)); expect(outcome['ok']).toBe(true);
      const facts = h.ledger.latestJobEvent(h.jobId, 'verification.started')!.payload as { pid: number; cwd: string };
      const liveRow = () => h.ledger.listWorktreeProcesses(lane.id).find((row) => row.pid === facts.pid);
      const reconcile = () => h.ledger.reconcileVerificationProcesses({ jobId: h.jobId, runId: String(outcome['runId']), requestId, command, cwd: facts.cwd, worktreeId: lane.id });
      const reconciled = () => h.ledger.listJobEventsByKinds(h.jobId, ['verification.process-reconciled']).length;
      const seed = (rowCommand: string) => h.ledger.recordWorktreeProcesses({ worktreeId: lane.id, state: 'live', processes: [{ pid: facts.pid, command: rowCommand, evidence: 'registry' }] });
      const masked = `/bin/sh -c node verify.mjs pass --token [REDACTED]`;

      // The same masked text under another credential is another command: the row stays live.
      seed(`/bin/sh -c ${command.replace(secret, other)}`);
      expect(liveRow()).toMatchObject({ state: 'live', command: masked });
      reconcile();
      expect(liveRow()).toMatchObject({ state: 'live' });
      expect(reconciled()).toBe(0);

      // A row recorded without a digest (before the digest existed) has no identity, whatever its text says.
      h.db.handle.prepare('DELETE FROM worktree_processes WHERE worktree_id = ? AND pid = ?').run(lane.id, facts.pid);
      h.db.handle.prepare(`INSERT INTO worktree_processes (worktree_id, pid, command, evidence, state, first_seen, last_seen)
        VALUES (?, ?, ?, 'registry', 'live', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`).run(lane.id, facts.pid, masked);
      expect(liveRow()).toMatchObject({ state: 'live', commandSha256: null });
      reconcile();
      expect(liveRow()).toMatchObject({ state: 'live' });
      expect(reconciled()).toBe(0);
      h.db.handle.prepare('UPDATE worktree_processes SET command = ? WHERE worktree_id = ? AND pid = ?').run(`/bin/sh -c ${command}`, lane.id, facts.pid);
      reconcile();
      expect(liveRow()).toMatchObject({ state: 'live' });
      expect(reconciled()).toBe(0);

      // The identical raw command, recorded by the registry write, still closes the row.
      seed(`/bin/sh -c ${command}`);
      expect(liveRow()).toMatchObject({ state: 'live', command: masked });
      reconcile();
      expect(liveRow()).toMatchObject({ state: 'killed' });
      expect(reconciled()).toBe(1);
      expect(JSON.stringify(h.ledger.listEvents({ limit: 5_000 }))).not.toContain(secret);
      expect(JSON.stringify(h.ledger.listEvents({ limit: 5_000 }))).not.toContain(other);
    } finally { await h.close(); }
  });

  it('resolves the checked-in full gate through the same manifest resolver as the endpoint', () => {
    const manifest = loadWorktreeManifest(join(import.meta.dirname, '..'));
    expect(manifest).not.toBeNull();
    expect(resolveVerifyCommand(manifest!, 'full')).toBe('npm test');
    expect(() => resolveVerifyCommand(manifest!, 'typo')).toThrow(/not declared/);
  });

  it('replays a recorded request_id on a parked lane instead of refusing it as new (#455)', async () => {
    const harness = await boot();
    try {
      const first = await call(harness.port, { job_id: harness.jobId, scope: 'full', request_id: 'parked-replay' });
      expect(first.status).toBe(200);
      expect(outcomeOf(completedFrame(first.frames))['ok']).toBe(true);
      harness.ledger.setJobStatus(harness.jobId, 'parked');
      const replay = await call(harness.port, { job_id: harness.jobId, scope: 'full', request_id: 'parked-replay' });
      expect(replay.status).toBe(200);
      expect(completedFrame(replay.frames)).toMatchObject({ reconciled: true });
      expect(harness.ledger.latestJobEvent(harness.jobId, 'verification.refused')).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it('validates the scope before recording a parked refusal (#455)', async () => {
    const harness = await boot();
    harness.ledger.setJobStatus(harness.jobId, 'parked');
    try {
      const result = await call(harness.port, { job_id: harness.jobId, scope: 'typo' });
      expect(result.status).toBe(400);
      expect(result.json).toMatchObject({ error: 'unknown_scope' });
      expect(harness.ledger.latestJobEvent(harness.jobId, 'verification.refused')).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it('refuses a new verification on a parked job and records the durable refusal (#455)', async () => {
    const harness = await boot();
    harness.ledger.setJobStatus(harness.jobId, 'parked');
    try {
      const result = await call(harness.port, { job_id: harness.jobId, scope: 'full' });
      expect(result.status).toBe(409);
      expect(result.json).toEqual({
        error: 'job_held',
        detail: expect.stringContaining('resume the lane first'),
      });
      expect(harness.ledger.latestJobEvent(harness.jobId, 'verification.refused')?.payload).toMatchObject({
        scope: 'full',
        code: 'job_held',
        status: 'parked',
      });
      expect(harness.ledger.latestJobEvent(harness.jobId, 'verification.started')).toBeNull();
    } finally {
      await harness.close();
    }
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

  it('same-ID terminal reconciliation closes only absent exact lane processes while retaining failure and partial capture truth', async () => {
    let harness = await boot(); const requestId = 'terminal-process-restart';
    const pending = call(harness.port, { job_id: harness.jobId, scope: 'slow', request_id: requestId });
    let originalStarted = harness.ledger.latestJobEvent(harness.jobId, 'verification.started');
    while (originalStarted === null) { await new Promise<void>((resolve) => setImmediate(resolve)); originalStarted = harness.ledger.latestJobEvent(harness.jobId, 'verification.started'); }
    process.kill(-((originalStarted.payload as { pid: number }).pid), 'SIGTERM');
    const first = await pending;
    const outcome = outcomeOf(completedFrame(first.frames)); expect(outcome['ok']).toBe(false); expect(outcome['signal']).toBe('SIGTERM');
    const lane = harness.worktrees.listWorktrees({ jobId: harness.jobId })[0]!;
    if (harness.ledger.getWorktree(lane.id) === null) harness.ledger.registerWorktree({ id: lane.id, repoName: 'fixture', repoPath: harness.repo.path, path: lane.path, branch: lane.branch, sha: harness.repo.head(), kind: 'job', jobId: harness.jobId });
    const started = harness.ledger.latestJobEvent(harness.jobId, 'verification.started')!;
    const payload = started.payload as { pid: number; command: string };
    const live = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const foreign = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' }); const foreignPid = foreign.pid!; await once(foreign, 'exit');
    const capture = join(harness.config.dataDir, 'original-partial-capture.ndjson'); writeFileSync(capture, JSON.stringify({ type: 'started', runId: outcome['runId'] }) + '\n');
    const bytes = readFileSync(capture, 'utf8'); const completed = harness.ledger.latestJobEvent(harness.jobId, 'verification.completed');
    harness.ledger.recordWorktreeProcesses({ worktreeId: lane.id, state: 'live', processes: [
      { pid: payload.pid, command: `/bin/sh -c ${payload.command}`, evidence: 'registry' },
      { pid: live.pid!, command: `/bin/sh -c ${payload.command}`, evidence: 'registry' },
      { pid: foreignPid, command: `/bin/sh -c ${payload.command}`, evidence: 'registry' },
    ] });
    harness = await harness.restart();
    try {
      const replay = await call(harness.port, { job_id: harness.jobId, scope: 'slow', request_id: requestId });
      expect(replay.frames[0]).toMatchObject({ type: 'completed', reconciled: true }); expect(outcomeOf(replay.frames[0]!)).toEqual(outcome);
      expect(harness.ledger.listWorktreeProcesses(lane.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ pid: payload.pid, state: 'killed' }), expect.objectContaining({ pid: live.pid, state: 'live' }),
        expect.objectContaining({ pid: foreignPid, state: 'live' }),
      ]));
      expect(harness.ledger.latestJobEvent(harness.jobId, 'verification.completed')).toEqual(completed);
      const audit = harness.ledger.latestJobEvent(harness.jobId, 'verification.process-reconciled');
      expect(audit?.payload).toMatchObject({ request_id: requestId, run_id: outcome['runId'], pid: payload.pid });
      harness = await harness.restart();
      await call(harness.port, { job_id: harness.jobId, scope: 'slow', request_id: requestId });
      expect(harness.ledger.listJobEventsByKinds(harness.jobId, ['verification.process-reconciled'])).toEqual([audit]);
      expect(harness.ledger.listJobEventsByKinds(harness.jobId, ['verification.started'])).toEqual([started]);
      expect(readFileSync(capture, 'utf8')).toBe(bytes); expect(harness.ledger.hasUnsettledVerificationRun(harness.jobId)).toBe(false);
    } finally { const exit = once(live, 'exit'); live.kill('SIGKILL'); await exit; await harness.close(); }
  });

  async function assertOriginalStepReadback(mode: 'decomposed' | 'reused-build', receiptFault?: 'missing-first' | 'wrong-step' | 'event-overflow' | 'byte-overflow'): Promise<void> {
    const h = await boot({ manifest: '[verify]\nprime = "npm run lint && npm run typecheck && npm run build"\ndocs = "npm run build && npm run config:docs"\n', files: {
      '.gitignore': 'dist/\n',
      'package.json': JSON.stringify({ type: 'module', scripts: {
        lint: 'node step.mjs lint', typecheck: 'node step.mjs typecheck', build: 'node step.mjs build', 'config:docs': 'node step.mjs docs',
      } }),
      'step.mjs': 'import { mkdirSync, writeFileSync } from "node:fs"; if (process.argv[2] === "build") { mkdirSync("dist", { recursive: true }); writeFileSync("dist/output.js", "// original isolated fixture build\\n"); } console.log(process.argv[2]);\n',
    } });
    const lane = h.worktrees.listWorktrees({ jobId: h.jobId })[0]!;
    // Original lane facts precede any acceptance or native process registration.
    if (h.ledger.getWorktree(lane.id) === null) h.ledger.registerWorktree({ id: lane.id, repoName: 'fixture', repoPath: h.repo.path, path: lane.path, branch: lane.branch,
      sha: h.repo.head(), kind: 'job', jobId: h.jobId });
    if (mode === 'reused-build') {
      const prime = await call(h.port, { job_id: h.jobId, scope: 'prime', request_id: 'r15-original-prime' });
      expect(outcomeOf(completedFrame(prime.frames))['ok']).toBe(true);
    }
    const originalRecord = h.ledger.recordWorktreeProcesses.bind(h.ledger);
    const publication = vi.spyOn(h.ledger, 'recordWorktreeProcesses').mockImplementation((input) => {
      if (input.state === 'killed') throw new Error('R15 original callback interrupted before its killed-row publication');
      return originalRecord(input);
    });
    const append = h.ledger.appendCustomEvent.bind(h.ledger);
    const nativeReceipt = receiptFault === undefined ? null : vi.spyOn(h.ledger, 'appendCustomEvent').mockImplementation((input) => {
      if (input.kind !== 'verification.process-started' || (input.payload as { step_index?: unknown }).step_index !== 0) return append(input);
      if (receiptFault === 'missing-first') throw new Error('R15 original native-step publisher failed before its first receipt');
      if (receiptFault === 'byte-overflow') return append({ ...input, payload: { ...(input.payload as Record<string, unknown>), untrusted_padding: 'x'.repeat(8 * 1024 * 1024) } });
      if (receiptFault === 'event-overflow') {
        const original = append(input);
        for (let duplicate = 0; duplicate < 4096; duplicate += 1) append({ ...input, payload: { ...(input.payload as Record<string, unknown>), duplicate_claim: duplicate } });
        return original;
      }
      return append({ ...input, payload: { ...(input.payload as Record<string, unknown>), step_command: 'npm run foreign-step' } });
    });
    const requestId = `r15-original-${mode}`;
    let first: Awaited<ReturnType<typeof call>>;
    try { first = await call(h.port, { job_id: h.jobId, scope: 'docs', request_id: requestId }); }
    finally { publication.mockRestore(); nativeReceipt?.mockRestore(); }
    const outcome = outcomeOf(completedFrame(first.frames));
    expect(outcome['ok']).toBe(true);
    const runId = String(outcome['runId']);
    if (mode === 'reused-build') expect(outcome['checks']).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'reused', ran: false })]));
    const originalRows = h.ledger.listWorktreeProcesses(lane.id).filter((row) => row.state === 'live');
    expect(originalRows).toHaveLength(mode === 'decomposed' ? 2 : 1);
    const originalStarts = h.ledger.listJobEventsByKinds(h.jobId, ['verification.started', 'verification.process-started'], { limit: 4100 });
    const logical = originalStarts.filter((event) => event.kind === 'verification.started' && (event.payload as { run_id?: unknown }).run_id === runId);
    expect(logical).toHaveLength(1);
    expect(logical[0]?.payload).toMatchObject({ pid: originalRows[0]?.pid, command: 'npm run build && npm run config:docs', cwd: lane.path });
    if (receiptFault === undefined) {
      const native = originalStarts.filter((event) => event.kind === 'verification.process-started' && (event.payload as { run_id?: unknown }).run_id === runId);
      expect(native).toHaveLength(originalRows.length);
      for (const row of originalRows) expect(native).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ pid: row.pid, process_command: row.command, cwd: lane.path }) })]));
    }
    const completed = h.ledger.latestJobEvent(h.jobId, 'verification.completed');
    // These rows were published by actual onSpawn. Reconciliation never adds a
    // PID, cwd, command, admission or completion fact to make them qualify.
    if (receiptFault === 'event-overflow' || receiptFault === 'byte-overflow') {
      expect(() => h.ledger.reconcileVerificationProcesses({ jobId: h.jobId, runId, requestId, command: 'npm run build && npm run config:docs', cwd: lane.path, worktreeId: lane.id }))
        .toThrow('inspection exceeds the original complete-evidence bounds; physical ownership remains UNKNOWN');
    }
    const replay = await call(h.port, { job_id: h.jobId, scope: 'docs', request_id: requestId });
    expect(replay.frames[0]).toMatchObject({ type: 'completed', reconciled: true });
    expect(outcomeOf(replay.frames[0]!)).toEqual(outcome);
    for (const row of originalRows) expect(h.ledger.listWorktreeProcesses(lane.id)).toEqual(expect.arrayContaining([expect.objectContaining({ pid: row.pid, command: row.command, state: receiptFault === undefined ? 'killed' : 'live' })]));
    expect(h.ledger.latestJobEvent(h.jobId, 'verification.completed')).toEqual(completed);
    expect(h.ledger.listJobEventsByKinds(h.jobId, ['verification.started', 'verification.process-started'], { limit: 4100 })).toEqual(originalStarts);
    expect(h.ledger.listJobEventsByKinds(h.jobId, ['verification.process-reconciled']).filter((event) => (event.payload as { run_id?: unknown }).run_id === runId)).toHaveLength(receiptFault === undefined ? originalRows.length : 0);
    await h.close();
  }

  it('R15 received terminal readback qualifies only the original actually spawned decomposed verification steps', () => assertOriginalStepReadback('decomposed'));
  it('R15 received first-build reuse preserves exact later spawned verification-step reconciliation', () => assertOriginalStepReadback('reused-build'));
  it('R15 post-source coverage retains original ownership when first native-step publication failed', () => assertOriginalStepReadback('decomposed', 'missing-first'));
  it('R15 post-source coverage refuses an original native receipt whose step command does not bind the declared plan', () => assertOriginalStepReadback('decomposed', 'wrong-step'));
  it('R15 post-source coverage retains complete overflowing native-step event history and UNKNOWN ownership', () => assertOriginalStepReadback('decomposed', 'event-overflow'));
  it('R15 post-source coverage retains an oversized original native-step receipt and UNKNOWN ownership', () => assertOriginalStepReadback('decomposed', 'byte-overflow'));

  async function assertProcessIdentityRefusal(fault: 'unbound' | 'conflicting-start' | 'unbound-reused-pid' | 'reused-pid' | 'foreign-command' | 'foreign-terminal' | 'EPERM' | 'live-original' | 'live-group' | 'EPERM-group') {
    const h = await boot(); const requestId = `process-negative-${fault}`;
    const result = await call(h.port, { job_id: h.jobId, scope: 'full', request_id: requestId });
    const outcome = outcomeOf(completedFrame(result.frames)); const runId = String(outcome['runId']);
    const started = h.ledger.latestJobEvent(h.jobId, 'verification.started')!;
    const facts = started.payload as { pid: number; command: string; cwd: string };
    const lane = h.worktrees.listWorktrees({ jobId: h.jobId })[0]!;
    if (h.ledger.getWorktree(lane.id) === null) h.ledger.registerWorktree({ id: lane.id, repoName: 'fixture', repoPath: h.repo.path, path: lane.path, branch: lane.branch, sha: h.repo.head(), kind: 'job', jobId: h.jobId });
    h.ledger.recordWorktreeProcesses({ worktreeId: lane.id, state: 'live', processes: [{ pid: facts.pid, command: `/bin/sh -c ${facts.command}`, evidence: 'registry' }] });
    if (fault === 'unbound') h.db.handle.prepare('DELETE FROM events WHERE seq = ?').run(started.seq);
    if (fault === 'conflicting-start') h.ledger.appendCustomEvent({ jobId: h.jobId, kind: 'verification.started', payload: { ...facts, run_id: runId, pid: facts.pid + 1 } });
    if (fault === 'reused-pid') h.ledger.appendCustomEvent({ jobId: h.jobId, kind: 'verification.started', payload: { ...facts, run_id: 'different-run' } });
    if (fault === 'unbound-reused-pid') h.ledger.appendCustomEvent({ jobId: h.jobId, kind: 'verification.started', payload: facts });
    if (fault === 'foreign-terminal') h.ledger.appendCustomEvent({ jobId: h.jobId, kind: 'verification.completed', payload: { run_id: runId, command: 'foreign command', cwd: facts.cwd } });
    const before = h.ledger.listWorktreeProcesses(lane.id); const kill = process.kill.bind(process);
    const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === facts.pid && signal === 0 && (fault === 'EPERM' || fault === 'live-original')) {
        if (fault === 'live-original') return true;
        throw Object.assign(new Error('ambiguous permission'), { code: 'EPERM' });
      }
      // An absent leader whose original process group still answers (#363 S01-2-01).
      if (signal === 0 && (fault === 'live-group' || fault === 'EPERM-group')) {
        if (pid === facts.pid) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
        if (pid === -facts.pid) {
          if (fault === 'live-group') return true;
          throw Object.assign(new Error('ambiguous permission'), { code: 'EPERM' });
        }
      }
      return kill(pid, signal);
    });
    try {
      h.ledger.reconcileVerificationProcesses({ jobId: h.jobId, runId, requestId, command: fault === 'foreign-command' ? 'other command' : facts.command, cwd: facts.cwd, worktreeId: lane.id });
      expect(h.ledger.listWorktreeProcesses(lane.id)).toEqual(before); expect(h.ledger.latestJobEvent(h.jobId, 'verification.process-reconciled')).toBeNull();
    } finally { probe.mockRestore(); }
  }
  it('process reconciliation refuses unbound original identity evidence', () => assertProcessIdentityRefusal('unbound'));
  it('process reconciliation refuses conflicting-start original identity evidence', () => assertProcessIdentityRefusal('conflicting-start'));
  it('process reconciliation refuses reused-pid original identity evidence', () => assertProcessIdentityRefusal('reused-pid'));
  it('process reconciliation refuses unbound-reused-pid original identity evidence', () => assertProcessIdentityRefusal('unbound-reused-pid'));
  it('process reconciliation refuses foreign-command original identity evidence', () => assertProcessIdentityRefusal('foreign-command'));
  it('process reconciliation refuses foreign-terminal original identity evidence', () => assertProcessIdentityRefusal('foreign-terminal'));
  it('process reconciliation refuses EPERM original identity evidence', () => assertProcessIdentityRefusal('EPERM'));
  it('process reconciliation refuses live-original original identity evidence', () => assertProcessIdentityRefusal('live-original'));
  it('process reconciliation keeps an absent leader live while its original process group still answers (#363 S01-2-01)', () => assertProcessIdentityRefusal('live-group'));
  it('process reconciliation keeps an absent leader live while its original process group probe is EPERM (#363 S01-2-01)', () => assertProcessIdentityRefusal('EPERM-group'));

  it('original no-start deduplication survives more than 1000 newer receipts and a real server restart', async () => {
    let h = await boot();
    const holder = call(h.port, { job_id: h.jobId, scope: 'slow', request_id: 'dedup-holder' });
    while (h.ledger.latestJobEvent(h.jobId, 'verification.started') === null) await new Promise<void>((resolve) => setImmediate(resolve));
    const queued = call(h.port, { job_id: h.jobId, scope: 'full', request_id: 'old-no-start' });
    while (h.ledger.listJobEventsByKinds(h.jobId, ['verification.requested']).length < 2) await new Promise<void>((resolve) => setImmediate(resolve));
    await h.server.dispose(); await Promise.all([holder, queued]);
    const original = h.ledger.latestJobEvent(h.jobId, 'verification.no-start')!; expect(original).not.toBeNull();
    for (let n = 0; n < 1001; n += 1) h.ledger.appendCustomEvent({ jobId: h.jobId, kind: 'verification.no-start', payload: { run_id: `other-run-${n}` } });
    h = await h.restart();
    await call(h.port, { job_id: h.jobId, scope: 'full', request_id: 'old-no-start' });
    const rows = h.ledger.listJobEventsByKinds(h.jobId, ['verification.no-start'], { limit: 2000 }).filter((row) => (row.payload as { run_id?: unknown }).run_id === (original.payload as { run_id: string }).run_id);
    expect(rows).toEqual([original]);
    expect(h.ledger.listJobEventsByKinds(h.jobId, ['verification.started'])).toHaveLength(1);
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

/** Read an NDJSON response to EOF, timestamping each parsed body line when
 * it is observed (a coalesced read shares one timestamp — the counts, not the
 * gap bound, are the cadence evidence). */
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

/**
 * Poll a synchronous predicate until it holds (or the deadline passes) and
 * return whether it held. Never throws, so a base that never arms a heartbeat
 * fails the caller's assertion rather than a harness timeout.
 */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A back-pressured response: every write reports false and never drains. */
function stalledResponse(): { readonly res: ServerResponse; readonly writes: string[] } {
  const emitter = new EventEmitter();
  const writes: string[] = [];
  const res = Object.assign(emitter, {
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    writeHead() {
      (this as unknown as { headersSent: boolean }).headersSent = true;
      return this;
    },
    write(chunk: unknown) {
      writes.push(String(chunk));
      return false;
    },
    end() {
      (this as unknown as { writableEnded: boolean }).writableEnded = true;
      return this;
    },
  });
  return { res: res as unknown as ServerResponse, writes };
}

/** A minimal POST /api/verify request for the fake response. */
function fakeVerifyRequest(body: unknown): IncomingMessage {
  const emitter = new EventEmitter();
  const req = Object.assign(emitter, {
    method: 'POST',
    url: '/api/verify',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
  queueMicrotask(() => {
    emitter.emit('data', Buffer.from(JSON.stringify(body)));
    emitter.emit('end');
  });
  return req;
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
    // A leading ping is legal, so assert presence, never index 0.
    expect(heldTypes).toContain('queued');
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

  it('does not add keepalive noise to a chatty producer', async () => {
    const harness = await boot({ heartbeatMs: 50 });
    const outcome = {
      runId: 'run-stub-chatty',
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
    // A controlled producer: a synchronous burst of 20 output frames (no
    // macrotask can interleave mid-burst), then a controlled silent gap
    // longer than the cadence. The idle gate must suppress pings inside the
    // burst and allow them in the gap — no assumption about subprocess
    // scheduling latency.
    const stubScheduler = {
      start: () => {},
      dispose: async () => {},
      view: () => ({ lockInUse: false, activeRuns: 0, queuedRuns: 0, workerBudget: 1, workersPerRun: 1 }),
      run: async (_spec: unknown, sink: (frame: unknown) => void | Promise<void>) => {
        await sink({ type: 'queued', runId: outcome.runId, position: 0, active: 0, limit: 1 });
        await sink({ type: 'started', runId: outcome.runId, workers: 1, sha: outcome.sha, queuedMs: 0 });
        for (let index = 0; index < 20; index += 1) {
          await sink({ type: 'output', runId: outcome.runId, stream: 'stdout', text: `chatty=${index}\n` });
        }
        await new Promise((resolve) => setTimeout(resolve, 180));
        await sink({ type: 'completed', runId: outcome.runId, outcome });
        return outcome;
      },
    };
    const server = createVerificationServer({
      config: harness.config,
      ledger: harness.ledger,
      worktrees: harness.worktrees,
      scheduler: stubScheduler as unknown as VerificationScheduler,
      heartbeatMs: 50,
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
      const firstOutput = types.indexOf('output');
      const lastOutput = types.lastIndexOf('output');
      expect(types.filter((type) => type === 'output')).toHaveLength(20);
      // No ping inside the synchronous burst: the idle gate suppressed them.
      expect(types.slice(firstOutput, lastOutput + 1).filter((type) => type === 'ping')).toHaveLength(0);
      // The controlled silent gap DID receive pings (liveness works).
      expect(types.slice(lastOutput + 1).filter((type) => type === 'ping').length).toBeGreaterThanOrEqual(1);
      expect(types[types.length - 1]).toBe('completed');
    } finally {
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
      await server.dispose();
      await harness.close();
    }
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
      const heartbeatHandles = (): NodeJS.Timeout[] =>
        setIntervalSpy.mock.calls
          .map((call, index) => ({ delay: call[1], result: setIntervalSpy.mock.results[index] }))
          .filter((entry) => entry.delay === 25)
          .map((entry) => entry.result?.value as NodeJS.Timeout);
      const isCleared = (handle: NodeJS.Timeout): boolean =>
        clearIntervalSpy.mock.calls.some((call) => call[0] === handle);
      const beforeAbort = heartbeatHandles().length;
      controller.abort();
      await disconnected.done.catch(() => {});

      // The disconnected response's OWN heartbeat is cleared on close, while
      // the producer gate is STILL held (so terminal/finally cleanup cannot
      // be what cleared it).
      expect(harness.ledger.latestJobEvent(disconnectJob.id, 'verification.completed')).toBeNull();
      const disconnectHeartbeat = heartbeatHandles()[beforeAbort - 1];
      expect(disconnectHeartbeat).toBeDefined();
      // The server-side close may land just after the client observes the
      // abort; poll briefly, then assert the timer is gone while the gate is
      // still held.
      expect(await until(() => isCleared(disconnectHeartbeat!))).toBe(true);

      // Producer outcome/cancellation semantics are unchanged: the run is
      // still running, then reaches its own terminal outcome.
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
      const ourIntervals = heartbeatHandles();
      expect(ourIntervals.length).toBeGreaterThanOrEqual(3);
      for (const handle of ourIntervals) {
        expect(handle.hasRef?.()).toBe(false);
        expect(isCleared(handle)).toBe(true);
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
    for (const unusable of [0, -1, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 150_000, 300_000]) {
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
      // The wire shape is exactly the documented liveness frame.
      expect(reading.frames[firstPing]!.frame).toEqual({ type: 'ping' });
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

  it('verification error terminal clears its heartbeat', async () => {
    const harness = await boot({ heartbeatMs: 25 });
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    // A queued admission that ends in the typed lock-wait error: the body
    // must stay alive while waiting, then carry the error as its LAST frame
    // and leave no heartbeat timer behind.
    const stubScheduler = {
      start: () => {},
      dispose: async () => {},
      view: () => ({ lockInUse: false, activeRuns: 0, queuedRuns: 1, workerBudget: 1, workersPerRun: 1 }),
      run: async (_spec: unknown, sink: (frame: unknown) => void | Promise<void>) => {
        await sink({ type: 'queued', runId: 'run-stub-error', position: 1, active: 1, limit: 1 });
        await new Promise((resolve) => setTimeout(resolve, 150));
        throw new VerificationLockTimeoutError(150, 1, 1);
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
      expect(types.filter((type) => type === 'ping').length).toBeGreaterThanOrEqual(2);
      const errorFrame = reading.frames.find((entry) => entry.frame.type === 'error');
      expect(errorFrame?.frame['code']).toBe('lock_wait_timeout');
      // The error is the terminal frame: no transport frame follows it.
      expect(types[types.length - 1]).toBe('error');
      expect(types.lastIndexOf('ping')).toBeLessThan(types.indexOf('error'));
      // ... and the error terminal cleared the heartbeat.
      const ourIntervals = setIntervalSpy.mock.calls
        .map((call, index) => ({ delay: call[1], result: setIntervalSpy.mock.results[index] }))
        .filter((entry) => entry.delay === 25);
      expect(ourIntervals.length).toBeGreaterThanOrEqual(1);
      for (const entry of ourIntervals) {
        const handle = entry.result?.value as NodeJS.Timeout;
        expect(clearIntervalSpy.mock.calls.some((call) => call[0] === handle)).toBe(true);
      }
    } finally {
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
      await server.dispose();
      await harness.close();
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('server disposal clears response heartbeats behind a stalled sink', async () => {
    const harness = await boot({ heartbeatMs: 25 });
    const stubScheduler = {
      start: () => {},
      dispose: async () => {},
      view: () => ({ lockInUse: false, activeRuns: 0, queuedRuns: 1, workerBudget: 1, workersPerRun: 1 }),
      run: async (_spec: unknown, sink: (frame: unknown) => void | Promise<void>) => {
        await sink({ type: 'queued', runId: 'run-stub-stall', position: 0, active: 0, limit: 1 });
        await new Promise<never>(() => {}); // a run that never settles
      },
    };
    const server = createVerificationServer({
      config: harness.config,
      ledger: harness.ledger,
      worktrees: harness.worktrees,
      scheduler: stubScheduler as unknown as VerificationScheduler,
      heartbeatMs: 25,
    });
    const { res } = stalledResponse();
    // Controlled clock for the interval class only: a back-pressured sink
    // keeps scheduler fan-out (and so scheduler.run) open forever.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const baseline = vi.getTimerCount();
      server.requestHook(fakeVerifyRequest({ job_id: harness.jobId, scope: 'full' }), res, '/api/verify');
      // The response heartbeat is armed even though no frame can be written.
      expect(await until(() => vi.getTimerCount() > baseline)).toBe(true);
      const disposePromise = server.dispose();
      // Cleared BEFORE disposal resolves (dispose clears synchronously, then
      // awaits the scheduler).
      expect(vi.getTimerCount()).toBe(baseline);
      await disposePromise;
      expect(vi.getTimerCount()).toBe(baseline);
    } finally {
      vi.useRealTimers();
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
    expect(attachedTypes).toContain('attached');
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
    expect(parsed.frames).toBe(4); // queued, started, output, completed
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
