import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
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
import { WaveRunner } from '../src/dispatch/perkins.js';
import { fakeHybridSpawner } from './helpers/perkins-hybrid-double.js';
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
async function boot(opts: {
  token?: string;
  reviewPreflight?: ConstructorParameters<typeof WaveRunner>[0]['reviewPreflight'];
  fallbackGate?: ConstructorParameters<typeof WaveRunner>[0]['fallbackGate'];
} = {}): Promise<ServerHarness & { wave: WaveRunner }> {
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
  const reviewSessions = join(dir, 'review-sessions');
  mkdirSync(reviewSessions, { recursive: true });
  const hybrid = fakeHybridSpawner(reviewSessions, { childAnswer: () => '[]' });
  const spawner = async (role: Role, options?: SpawnOptions): Promise<AgentHandle> => {
    spawns.push({ role, options: options ?? {} });
    if (role === 'perkins') return hybrid.spawner(role, options);
    return {
      role,
      id: `agent-${spawns.length}`,
      sessionFile: null,
      capabilities: FAKE_CAPABILITIES,
      async prompt() {
        if (role !== 'minion' || options?.cwd === undefined) return;
        writeFileSync(join(options.cwd, 'http-deliverable.txt'), 'review me\n');
        execFileSync('git', ['-C', options.cwd, 'add', 'http-deliverable.txt']);
        execFileSync('git', ['-C', options.cwd, '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'test: http deliverable'], { stdio: 'ignore' });
      },
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
    poster: { async post() {} },
    reviewArtifactRoot: join(dir, 'reviews'),
    ...(opts.reviewPreflight !== undefined ? { reviewPreflight: opts.reviewPreflight } : {}),
    ...(opts.fallbackGate !== undefined ? { fallbackGate: opts.fallbackGate } : {}),
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
    wave,
    close: async () => {
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
      await wave.shutdown();
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
      if (review.status !== 202) throw new Error(`review failed: ${JSON.stringify(review)}`);
      expect(review.status).toBe(202);
      expect(field<string>(review.json, 'round_id')).toBe('http-review-r1');
      expect(field<string[]>(review.json, 'lenses')).toHaveLength(7);
      const deadline = Date.now() + 5_000;
      while (h.ledger.getRound('http-review-r1')?.verdict !== 'approved' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(h.ledger.getRound('http-review-r1')?.verdict).toBe('approved');
    } finally {
      await h.close();
    }
  });


  it('accepts explicit no_spec=true as six lenses and rejects non-boolean no_spec', async () => {
    const h = await boot();
    const repo = makeFixtureRepo('fixture-http-no-spec');
    cleanupRepos.push(repo);
    try {
      const dispatched = await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'http-no-spec', repo_path: repo.path, title: 'no spec', briefing: 'ordinary briefing',
      }, TOKEN);
      expect(dispatched.status).toBe(202);
      const invalid = await call(h.port, 'POST', '/api/dispatch/review', {
        job_id: 'http-no-spec', no_spec: 'true',
      }, TOKEN);
      expect(invalid.status).toBe(400);
      expect(field<string>(invalid.json, 'detail')).toContain('no_spec must be a boolean');
      expect(h.ledger.listRounds('http-no-spec')).toHaveLength(0);

      const review = await call(h.port, 'POST', '/api/dispatch/review', {
        job_id: 'http-no-spec', no_spec: true,
      }, TOKEN);
      expect(review.status).toBe(202);
      expect(field<string[]>(review.json, 'lenses')).toEqual([
        'blind', 'edge', 'security', 'architecture', 'codebase', 'tests',
      ]);
    } finally {
      await h.close();
    }
  });

  it('rejects traversal and overlong job ids while accepting the 128-character boundary', async () => {
    const h = await boot();
    const repo = makeFixtureRepo('fixture-http-safe-job-id');
    cleanupRepos.push(repo);
    try {
      for (const jobId of ['../escape', 'a'.repeat(129)]) {
        const response = await call(h.port, 'POST', '/api/dispatch', {
          job_id: jobId, repo_path: repo.path, title: 'unsafe id', briefing: 'must reject before lane creation',
        }, TOKEN);
        expect(response.status).toBe(400);
        expect(field<string>(response.json, 'detail')).toContain('safe 128-character record identifier');
        expect(h.ledger.getJob(jobId)).toBeNull();
      }
      const boundary = 'a'.repeat(128);
      const accepted = await call(h.port, 'POST', '/api/dispatch', {
        job_id: boundary, repo_path: repo.path, title: 'boundary id', briefing: 'accepted exact limit',
      }, TOKEN);
      expect(accepted.status).toBe(202);
      expect(field<string>(accepted.json, 'job_id')).toBe(boundary);
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

  it('routes a failed pre-flight to the bmad-review fallback gate over HTTP', async () => {
    const skillDir = mkdtempSync(join(tmpdir(), 'bmad-review-skill-'));
    cleanupDirs.push(skillDir);
    const skillFile = join(skillDir, 'SKILL.md');
    writeFileSync(skillFile, '---\nname: bmad-review\n---\ninstalled', 'utf8');
    const h = await boot({
      reviewPreflight: async () => ({
        ok: false,
        failures: [{
          leg: 'review-policy',
          detail: 'the Perkins review gate is disabled in config',
          remediation: 'Enable the Perkins review gate in config: set [review] enabled = true in the instance config.',
        }],
      }),
      fallbackGate: {
        skillPath: skillFile,
        runFallbackReview: async () => [],
        fixDirectiveSink: async () => ({ delivered: true }),
      },
    });
    const repo = makeFixtureRepo('fixture-http-fallback');
    cleanupRepos.push(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'http-fallback', repo_path: repo.path, title: 'fallback', briefing: 'gate me',
      }, TOKEN);
      const review = await call(h.port, 'POST', '/api/dispatch/review', { job_id: 'http-fallback' }, TOKEN);
      expect(review.status).toBe(202);
      expect(field<string>(review.json, 'route')).toBe('bmad-review-fallback');
      const legs = (review.json as { failed_legs: Array<{ leg: string; remediation: string }> }).failed_legs;
      expect(legs).toHaveLength(1);
      expect(legs[0]?.leg).toBe('review-policy');
      expect(legs[0]?.remediation).toContain('[review] enabled = true');
      expect(field<boolean>(review.json, 'skill_installed')).toBe(true);
      const deadline = Date.now() + 5_000;
      while (
        !h.ledger.listEvents({ limit: 50 }).some((event) =>
          event.kind === 'job.fallback-review' &&
          event.jobId === 'http-fallback' &&
          (event.payload as { phase?: string }).phase === 'pass')
        && Date.now() < deadline
      ) await new Promise((resolve) => setTimeout(resolve, 20));
      const passEvent = h.ledger.listEvents({ limit: 50 }).find((event) =>
        event.kind === 'job.fallback-review' &&
        (event.payload as { phase?: string }).phase === 'pass');
      expect(passEvent).not.toBeNull();
      expect((passEvent!.payload as { clearToMerge?: boolean }).clearToMerge).toBe(true);
      expect(h.ledger.listRounds('http-fallback')).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('keeps the Perkins route annotated when the pre-flight passes', async () => {
    const h = await boot();
    const repo = makeFixtureRepo('fixture-http-perkins-route');
    cleanupRepos.push(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'http-route-perkins', repo_path: repo.path, title: 'perkins route', briefing: 'gate me',
      }, TOKEN);
      const review = await call(h.port, 'POST', '/api/dispatch/review', { job_id: 'http-route-perkins' }, TOKEN);
      expect(review.status).toBe(202);
      expect(field<string>(review.json, 'route')).toBe('perkins');
      expect(field<string>(review.json, 'round_id')).toBe('http-route-perkins-r1');
    } finally {
      await h.close();
    }
  });
});
