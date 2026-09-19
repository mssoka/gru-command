import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { loadConfig } from '../src/config.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { DispatchService } from '../src/dispatch/service.js';
import { WaveRunner, type LensDriver } from '../src/dispatch/perkins.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import type { AgentCapabilities, AgentHandle, SpawnOptions } from '../src/runtime/types.js';

const FAKE_CAPABILITIES: AgentCapabilities = {
  streaming: true,
  steer: 'native',
  resume: 'file',
  images: false,
  thinking: false,
  thinkingLevelControl: false,
  followUp: false,
};
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
  const worktrees = new InMemoryWorktreePort(join(dir, 'wtroot'));
  const spawns: { role: Role; options: SpawnOptions }[] = [];
  const spawner = async (role: Role, options?: SpawnOptions): Promise<AgentHandle> => {
    spawns.push({ role, options: options ?? {} });
    return {
      role,
      id: `agent-${spawns.length}`,
      sessionFile: null,
      capabilities: FAKE_CAPABILITIES,
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
  const dispatch = new DispatchService({ ledger, worktrees, spawner });
  const wave = new WaveRunner({
    ledger,
    worktrees,
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
