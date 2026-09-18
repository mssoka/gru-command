import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { loadConfig } from '../src/config.js';
import { WorktreeManager } from '../src/worktrees/manager.js';
import { DispatchService } from '../src/dispatch/service.js';
import { WaveRunner, type LensDriver } from '../src/dispatch/perkins.js';
import { psEnumerator } from '../src/worktrees/manager.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import type { AgentHandle, SpawnOptions } from '../src/runtime/types.js';
import type { Role } from '../src/config.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * Dispatch HTTP surface (E8 story 2): authenticated flow endpoints —
 * dispatch, PR link, review wave, release — same token discipline as
 * the board.
 */

const TOKEN = 'test-token-éphémeral';
const PR_URL = 'https://git.example.invalid/fixture-owner/fixture-app/pull/5';

const cleanupDirs: string[] = [];
const cleanupRepos: FixtureRepo[] = [];
afterEach(() => {
  while (cleanupRepos.length > 0) cleanupRepos.pop()!.cleanup();
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

interface ServerHarness {
  port: number;
  ledger: LedgerApi;
  spawns: { role: Role; options: SpawnOptions }[];
  close: () => Promise<void>;
}

async function boot(opts: { token?: string; driveLens?: LensDriver } = {}): Promise<ServerHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-dispatch-server-'));
  cleanupDirs.push(dir);
  const token = opts.token ?? TOKEN;
  writeFileSync(
    join(dir, 'config.toml'),
    `[auth]\ntoken = "${token}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`,
    'utf-8',
  );
  mkdirSync(join(dir, 'wtroot'));
  mkdirSync(join(dir, 'wtpreserve'));
  const cfg = loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
  const db = new LedgerDb(dir);
  const ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
  const manager = new WorktreeManager({
    ledger,
    root: join(dir, 'wtroot'),
    preserveRoot: join(dir, 'wtpreserve'),
    setupTimeoutMs: 30_000,
    killGraceMs: 25,
    // DEFAULT enumerator (real ps + cwd resolution): the paused and
    // confirm_kill arms must answer to the production join, not a stub.
  });
  const spawns: { role: Role; options: SpawnOptions }[] = [];
  const spawner = async (role: Role, options?: SpawnOptions): Promise<AgentHandle> => {
    spawns.push({ role, options: options ?? {} });
    return {
      role,
      id: `agent-${spawns.length}`,
      sessionFile: null,
      async prompt() {},
      async steer() {},
      async followUp() {},
      subscribe() {
        return () => {};
      },
      health() {
        return { state: 'idle', lastActivity: null, sessionFile: null };
      },
      async dispose() {},
    };
  };
  const dispatch = new DispatchService({ ledger, manager, spawner });
  const wave = new WaveRunner({
    ledger,
    manager,
    spawner,
    ...(opts.driveLens !== undefined
      ? { driveLens: opts.driveLens }
      : { driveLens: async () => ({ state: 'done' as const, verdict: 'clean' as const }) }),
  });
  const server = createDispatchServer({ config: cfg, dispatch, wave });
  const http: HttpServer = createServer((req, res) => {
    if (server.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolveListen) => http.listen(0, '127.0.0.1', resolveListen));
  const port = (http.address() as AddressInfo).port;
  return {
    port,
    ledger,
    spawns,
    close: async () => {
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
      db.close();
    },
  };
}

async function call(
  port: number,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

function field<T>(json: unknown, key: string): T {
  if (typeof json !== 'object' || json === null) throw new Error(`no json for field ${key}`);
  return (json as Record<string, unknown>)[key] as T;
}

describe('dispatch server (E8)', () => {
  it('rejects unauthenticated and unconfigured access like the board does', async () => {
    const h = await boot();
    try {
      const anon = await call(h.port, 'POST', '/api/dispatch', { job_id: 'x' });
      expect(anon.status).toBe(401);
      const wrong = await call(h.port, 'POST', '/api/dispatch', { job_id: 'x' }, 'nope');
      expect(wrong.status).toBe(401);
      const unknown = await call(h.port, 'GET', '/api/unknown', undefined, TOKEN);
      expect(unknown.status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it('dispatches a job: 202 with the lane, minion spawned in the worktree, board record lives', async () => {
    const h = await boot();
    const repo = makeFixtureRepo('fixture-http');
    cleanupRepos.push(repo);
    try {
      const res = await call(
        h.port,
        'POST',
        '/api/dispatch',
        {
          job_id: 'http-job',
          repo_path: repo.path,
          title: 'http dispatched',
          briefing: 'do the thing via http',
        },
        TOKEN,
      );
      if (res.status !== 202) throw new Error(`dispatch failed: ${JSON.stringify(res.json)}`);
      expect(field<string>(res.json, 'job_id')).toBe('http-job');
      expect(field<string>(res.json, 'branch')).toBe('gru/http-job');
      expect(field<string>(res.json, 'status')).toBe('working');
      // Ruling 17: the minion spawn carried the worktree as cwd.
      expect(h.spawns[0]?.options.cwd).toBe(field<string>(res.json, 'worktree'));
      expect(h.ledger.getJob('http-job')?.briefing).toBe('do the thing via http');
      // Worktree rows are queryable through the flow API.
      const wt = await call(h.port, 'GET', '/api/dispatch/jobs/http-job/worktrees', undefined, TOKEN);
      expect(wt.status).toBe(200);
      const worktreeRows = field<{ branch: string }[]>(wt.json, 'worktrees');
      expect(worktreeRows).toHaveLength(1);
      expect(worktreeRows[0]?.branch).toBe('gru/http-job');
    } finally {
      await h.close();
    }
  });

  it('records the PR link and kicks a review wave', async () => {
    const h = await boot();
    const repo = makeFixtureRepo('fixture-http-review');
    cleanupRepos.push(repo);
    try {
      await call(
        h.port,
        'POST',
        '/api/dispatch',
        {
          job_id: 'http-review',
          repo_path: repo.path,
          title: 'reviewable',
          briefing: 'ship it',
        },
        TOKEN,
      );
      const pr = await call(h.port, 'POST', '/api/dispatch/pr', { job_id: 'http-review', url: PR_URL }, TOKEN);
      expect(pr.status).toBe(200);
      expect(field<string>(pr.json, 'prUrl')).toBe(PR_URL);
      const review = await call(h.port, 'POST', '/api/dispatch/review', { job_id: 'http-review' }, TOKEN);
      expect(review.status).toBe(202);
      expect(field<string>(review.json, 'round_id')).toBe('http-review-r1');
      expect(field<string[]>(review.json, 'lenses')).toHaveLength(7);
      // Give the (fake, instant) fleet a beat to finish.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(h.ledger.getRound('http-review-r1')?.verdict).toBe('approved');
    } finally {
      await h.close();
    }
  });

  it('release endpoint: real PAUSE (200) → confirm_kill (200 swept) → nothing left (404)', async () => {
    const h = await boot();
    const repo = makeFixtureRepo('fixture-http-release');
    cleanupRepos.push(repo);
    try {
      const dispatch = await call(
        h.port,
        'POST',
        '/api/dispatch',
        {
          job_id: 'http-release',
          repo_path: repo.path,
          title: 'releasable',
          briefing: 'finish fast',
        },
        TOKEN,
      );
      expect(dispatch.status).toBe(202);
      const worktreePath = field<string>(dispatch.json, 'worktree');
      // A real process rooted in the lane (cwd, clean argv).
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        cwd: worktreePath,
        stdio: 'ignore',
      });
      try {
        const paused = await call(h.port, 'POST', '/api/dispatch/release', { job_id: 'http-release' }, TOKEN);
        expect(paused.status).toBe(200);
        expect(field<string>(paused.json, 'status')).toBe('paused');
        // The human acknowledges against THIS payload: the pid list (with
        // what each process is and how it was tied to the tree) and the ask.
        const pausedList = field<{ pid: number; command: string; evidence: string }[]>(
          paused.json,
          'processes',
        );
        expect(pausedList.length).toBe(1);
        expect(pausedList[0]?.pid).toBe(child.pid);
        expect(pausedList[0]?.command).toMatch(/node/);
        expect(pausedList[0]?.evidence).toBe('cwd');
        expect(field<string>(paused.json, 'note')).toMatch(/acknowledge to proceed/);
        // The tree survives the pause, deliverable included.
        expect(existsSync(worktreePath)).toBe(true);
        const confirmed = await call(
          h.port,
          'POST',
          '/api/dispatch/release',
          { job_id: 'http-release', confirm_kill: true },
          TOKEN,
        );
        expect(confirmed.status).toBe(200);
        expect(field<string>(confirmed.json, 'status')).toBe('swept');
        expect(field<string>(confirmed.json, 'branch')).toBe('deleted');
        expect(existsSync(worktreePath)).toBe(false);
        const missing = await call(h.port, 'POST', '/api/dispatch/release', { job_id: 'http-release' }, TOKEN);
        expect(missing.status).toBe(404);
      } finally {
        try {
          child.kill('SIGKILL');
        } catch {
          /* reaped by the confirmed kill */
        }
      }
    } finally {
      await h.close();
    }
  });

  it('validates request bodies loudly (400, never a silent lane)', async () => {
    const h = await boot();
    try {
      const bad = await call(h.port, 'POST', '/api/dispatch', { job_id: 'x' }, TOKEN);
      expect(bad.status).toBe(400);
      expect(field<string>(bad.json, 'error')).toBe('bad_request');
    } finally {
      await h.close();
    }
  });
});

describe('Perkins r3 B3: every pause is answerable — the review lane included', () => {
  it('a round whose sweep pauses is answered via round_id (and the review row carries its job)', async () => {
    // Gate the lens fleet: the round stays LIVE until the test has rooted
    // a real process in the review tree — then the completion sweep pauses.
    let releaseFleet: () => void = () => {};
    const fleetGate = new Promise<void>((resolve) => {
      releaseFleet = resolve;
    });
    const h = await boot({
      driveLens: async () => {
        await fleetGate;
        return { state: 'done' as const, verdict: 'clean' as const };
      },
    });
    const repo = makeFixtureRepo('fixture-http-reviewpause');
    cleanupRepos.push(repo);
    try {
      await call(
        h.port,
        'POST',
        '/api/dispatch',
        { job_id: 'http-rp', repo_path: repo.path, title: 'reviewable', briefing: 'ship it' },
        TOKEN,
      );
      await call(h.port, 'POST', '/api/dispatch/pr', { job_id: 'http-rp', url: PR_URL }, TOKEN);
      const review = await call(h.port, 'POST', '/api/dispatch/review', { job_id: 'http-rp' }, TOKEN);
      expect(review.status).toBe(202);
      const roundId = field<string>(review.json, 'round_id');

      // The review lane exists (fleet still gated); linkage is by construction.
      const wts = await call(h.port, 'GET', '/api/dispatch/jobs/http-rp/worktrees', undefined, TOKEN);
      const rows = field<
        { id: string; kind: string; path: string; jobId: string | null; status: string }[]
      >(wts.json, 'worktrees');
      const reviewRow = rows.find((row) => row.kind === 'review');
      expect(reviewRow).toBeDefined();
      expect(reviewRow?.jobId).toBe('http-rp');

      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        cwd: reviewRow!.path,
        stdio: 'ignore',
      });
      try {
        await vi.waitFor(
          () => {
            expect(psEnumerator(reviewRow!.path).some((p) => p.pid === child.pid)).toBe(true);
          },
          { timeout: 5_000 },
        );
        releaseFleet(); // fleet finishes → the round's sweep meets the child
        await vi.waitFor(
          () => {
            expect(h.ledger.getWorktree(roundId)?.status).toBe('paused');
          },
          { timeout: 10_000 },
        );
        // Answer path: the endpoint takes the ROUND id.
        const answered = await call(
          h.port,
          'POST',
          '/api/dispatch/release',
          { round_id: roundId, confirm_kill: true },
          TOKEN,
        );
        expect(answered.status).toBe(200);
        expect(field<string>(answered.json, 'status')).toBe('swept');
        expect(existsSync(reviewRow!.path)).toBe(false);
        expect(child.kill(0)).toBe(false);
      } finally {
        releaseFleet();
        try {
          child.kill('SIGKILL');
        } catch {
          /* reaped by the confirmed kill */
        }
      }
    } finally {
      await h.close();
    }
  });
});
