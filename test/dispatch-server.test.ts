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
import { loadConfig, DEFAULT_SILAS_CONFIG } from '../src/config.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { DispatchService } from '../src/dispatch/service.js';
import { WaveRunner } from '../src/dispatch/perkins.js';
import { fakeHybridSpawner } from './helpers/perkins-hybrid-double.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import { computeSilasDigest } from '../src/dispatch/silas-driver.js';
import { NotificationCenter } from '../src/notifications/center.js';
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
  minionPrompts: string[];
  minionTurnTexts: string[];
  liveHandles: Map<string, AgentHandle>;
  disposedHandles: string[];
  notifications: NotificationCenter;
  worktrees: InMemoryWorktreePort;
  close: () => Promise<void>;
}
async function boot(opts: {
  token?: string;
  reviewPreflight?: ConstructorParameters<typeof WaveRunner>[0]['reviewPreflight'];
  fallbackGate?: ConstructorParameters<typeof WaveRunner>[0]['fallbackGate'];
  /** false = boot without the silas ops surface (endpoints answer 503). */
  silasOps?: boolean;
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
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  const worktrees = new InMemoryWorktreePort(join(dir, 'wtroot'));
  const spawns: { role: Role; options: SpawnOptions }[] = [];
  const reviewSessions = join(dir, 'review-sessions');
  mkdirSync(reviewSessions, { recursive: true });
  const hybrid = fakeHybridSpawner(reviewSessions, { childAnswer: () => '[]' });
  const spawner = async (role: Role, options?: SpawnOptions): Promise<AgentHandle> => {
    spawns.push({ role, options: options ?? {} });
    if (role === 'perkins') return hybrid.spawner(role, options);
    const id = `agent-${spawns.length}`;
    return {
      role,
      id,
      sessionFile: null,
      capabilities: FAKE_CAPABILITIES,
      async prompt(text: string) {
        if (role !== 'minion' || options?.cwd === undefined) return;
        minionPrompts.push(`cwd=${options.cwd}`);
        minionTurnTexts.push(text);
        // idempotent per prompt: a fresh file per turn, so a second minion
        // turn on the same lane (silas re-brief) always has a commit to make.
        const file = join(options.cwd, `http-deliverable-${spawns.length}.txt`);
        writeFileSync(file, 'review me\n');
        execFileSync('git', ['-C', options.cwd, 'add', file]);
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
      async dispose() {
        // The directive route disposes a freshly spawned fallback minion
        // itself; record it so tests can assert the cleanup ran.
        if (role === 'minion') disposedHandles.push(id);
      },
    };
  };
  const dispatch = new DispatchService({ ledger, worktrees, spawner });
  const minionPrompts: string[] = [];
  const minionTurnTexts: string[] = [];
  const liveHandles = new Map<string, AgentHandle>();
  const disposedHandles: string[] = [];
  const wave = new WaveRunner({
    ledger,
    worktrees,
    spawner,
    poster: { async post() {} },
    reviewArtifactRoot: join(dir, 'reviews'),
    ...(opts.reviewPreflight !== undefined ? { reviewPreflight: opts.reviewPreflight } : {}),
    ...(opts.fallbackGate !== undefined ? { fallbackGate: opts.fallbackGate } : {}),
  });
  const server = createDispatchServer({
    config: cfg,
    dispatch,
    wave,
    ledger,
    ...(opts.silasOps === false
      ? {}
      : {
          silasOps: {
            registry: {
              getHandle: (id: string) => liveHandles.get(id) ?? null,
              spawn: (role: Role, spawnOptions?: SpawnOptions) => spawner(role, spawnOptions),
              disposeHandle: async (handle: AgentHandle) => {
                disposedHandles.push(handle.id);
                liveHandles.delete(handle.id);
              },
            },
            worktrees,
            notifications,
          },
        }),
  });
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
    minionPrompts,
    minionTurnTexts,
    liveHandles,
    disposedHandles,
    notifications,
    worktrees,
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
      // Let the minion's briefing turn settle, then register the PR: the
      // digest's review-overdue state is PR-registered + no round.
      const deliverDeadline = Date.now() + 5_000;
      while (h.ledger.latestJobEvent('http-fallback', 'job.delivered') === null && Date.now() < deliverDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(h.ledger.latestJobEvent('http-fallback', 'job.delivered')).not.toBeNull();
      await call(h.port, 'POST', '/api/dispatch/pr', { job_id: 'http-fallback', url: PR_URL }, TOKEN);
      const digestOf = () =>
        computeSilasDigest({
          ledger: h.ledger,
          blockersForRound: async () => ({ blockers: [], note: null }),
          config: DEFAULT_SILAS_CONFIG,
          trigger: 'sweep',
        });
      expect((await digestOf()).prWithoutReview.map((row) => row.jobId)).toEqual(['http-fallback']);

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
      // With the gate engaged (no round, job still working), the digest
      // retires the review-overdue row instead of re-triggering every sweep.
      expect((await digestOf()).prWithoutReview).toEqual([]);
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

  it('silas ops surface: 401 unauthenticated, 503 when not hosted', async () => {
    const unhosted = await boot({ silasOps: false });
    try {
      const res = await call(unhosted.port, 'POST', '/api/silas/escalate', { title: 'x' }, TOKEN);
      expect(res.status).toBe(503);
      expect(field<string>(res.json, 'error')).toBe('silas_ops_not_hosted');
      const rebrief = await call(unhosted.port, 'POST', '/api/silas/rebrief', { job_id: 'x', note: 'y' }, TOKEN);
      expect(rebrief.status).toBe(503);
    } finally {
      await unhosted.close();
    }
    const h = await boot();
    try {
      const anon = await call(h.port, 'POST', '/api/silas/escalate', { title: 'x' });
      expect(anon.status).toBe(401);
      const wrong = await call(h.port, 'POST', '/api/silas/directive', { job_id: 'x', directive: 'y' }, 'nope');
      expect(wrong.status).toBe(401);
      const rebriefAnon = await call(h.port, 'POST', '/api/silas/rebrief', { job_id: 'x', note: 'y' });
      expect(rebriefAnon.status).toBe(401);
    } finally {
      await h.close();
    }
  });

  it('by=silas on the pr/review endpoints records silas attribution events; without by it does not', async () => {
    const h = await boot();
    const repo = makeFixtureRepo('fixture-silas-by');
    cleanupRepos.push(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'by-silas-job', repo_path: repo.path, title: 'attribution', briefing: 'b',
      }, TOKEN);
      const pr = await call(h.port, 'POST', '/api/dispatch/pr', {
        job_id: 'by-silas-job', url: PR_URL, by: 'silas',
      }, TOKEN);
      expect(pr.status).toBe(200);
      const review = await call(h.port, 'POST', '/api/dispatch/review', {
        job_id: 'by-silas-job', by: 'silas',
      }, TOKEN);
      expect(review.status).toBe(202);
      const kinds = h.ledger.listJobEvents('by-silas-job').map((event) => event.kind);
      expect(kinds).toContain('silas.pr-registered');
      expect(kinds).toContain('silas.review-triggered');
      const reviewEvent = h.ledger.listJobEvents('by-silas-job').find((event) => event.kind === 'silas.review-triggered');
      expect((reviewEvent?.payload as { route?: string }).route).toBe('perkins');
      // and an unattributed job stays clean of silas events
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'by-none-job', repo_path: repo.path, title: 'plain', briefing: 'b',
      }, TOKEN);
      await call(h.port, 'POST', '/api/dispatch/pr', { job_id: 'by-none-job', url: PR_URL }, TOKEN);
      await call(h.port, 'POST', '/api/dispatch/review', { job_id: 'by-none-job' }, TOKEN);
      const plainKinds = h.ledger.listJobEvents('by-none-job').map((event) => event.kind);
      expect(plainKinds).not.toContain('silas.pr-registered');
      expect(plainKinds).not.toContain('silas.review-triggered');
    } finally {
      await h.close();
    }
  });

  it('/api/silas/directive routes to the live minion, flips the lane back to working, records the event', async () => {
    const h = await boot();
    const repo = makeFixtureRepo('fixture-silas-directive');
    cleanupRepos.push(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'dir-job', repo_path: repo.path, title: 'directive lane', briefing: 'b',
      }, TOKEN);
      // The dispatched minion was the last spawn; simulate its LIVE handle
      // in the registry (the same surface the real RuntimeRegistry provides).
      const minionId = `agent-${h.spawns.length}`;
      h.ledger.registerAgent({ id: minionId, role: 'minion', jobId: 'dir-job' });
      h.liveHandles.set(minionId, {
        role: 'minion',
        id: minionId,
        sessionFile: null,
        capabilities: FAKE_CAPABILITIES,
        prompt: async () => {},
        async steer() {},
        async followUp() {},
        subscribe: () => () => {},
        health: () => ({ state: 'idle' as const, lastActivity: null, sessionFile: null }),
        async dispose() {},
      });
      h.ledger.setJobStatus('dir-job', 'in-review');
      const res = await call(h.port, 'POST', '/api/silas/directive', {
        job_id: 'dir-job',
        directive: 'Fix the null deref at src/a.ts and re-run the suite.',
        blocker_fingerprint: 'correctness::src/a.ts::null deref',
      }, TOKEN);
      expect(res.status).toBe(200);
      expect(field<string>(res.json, 'minion_id')).toBe(minionId);
      const job = h.ledger.getJob('dir-job');
      expect(job?.status).toBe('working');
      expect(job?.note ?? '').toContain('working');
      const event = h.ledger.listJobEvents('dir-job').find((candidate) => candidate.kind === 'silas.directive-sent');
      expect(event).not.toBeNull();
      expect((event?.payload as { blocker_fingerprint?: string }).blocker_fingerprint).toBe('correctness::src/a.ts::null deref');
      // The follow-up delivery signal: the settled directive turn is recorded
      // as a delivery carrying the lane's head (no-op minion → unchanged head).
      const lane = h.worktrees.listWorktrees({ jobId: 'dir-job' }).find((candidate) => candidate.kind === 'job');
      const head = execFileSync('git', ['-C', lane!.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const delivered = h.ledger.listJobEvents('dir-job').find((candidate) => candidate.kind === 'job.delivered');
      expect(delivered).not.toBeNull();
      expect(delivered?.payload).toMatchObject({ agentId: minionId, source: 'silas-directive', sha: head });
      expect(field<string>(res.json, 'delivered_sha')).toBe(head);
    } finally {
      await h.close();
    }
  });

  it('/api/silas/rebrief retires the live minion and re-briefs a FRESH one on the same lane', async () => {
    const h = await boot();
    const repo = makeFixtureRepo('fixture-silas-rebrief');
    cleanupRepos.push(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'rebrief-job', repo_path: repo.path, title: 'stuck lane', briefing: 'the original contract',
      }, TOKEN);
      // The prior minion is LIVE: the retirement path must actually run.
      const priorMinion = `agent-${h.spawns.length}`;
      h.liveHandles.set(priorMinion, {
        role: 'minion',
        id: priorMinion,
        sessionFile: null,
        capabilities: FAKE_CAPABILITIES,
        prompt: async () => {},
        async steer() {},
        async followUp() {},
        subscribe: () => () => {},
        health: () => ({ state: 'idle' as const, lastActivity: null, sessionFile: null }),
        async dispose() {},
      });
      const freshBefore = h.spawns.filter((spawn) => spawn.role === 'minion').length;
      const res = await call(h.port, 'POST', '/api/silas/rebrief', {
        job_id: 'rebrief-job',
        note: 'same blocker three rounds; try a different approach',
      }, TOKEN);
      expect(res.status).toBe(200);
      const freshMinion = h.spawns.filter((spawn) => spawn.role === 'minion')[freshBefore];
      expect(freshMinion).toBeDefined();
      expect(field<string>(res.json, 'minion_id')).toBe(`agent-${h.spawns.length}`);
      const job = h.ledger.getJob('rebrief-job');
      expect(job?.status).toBe('working');
      const event = h.ledger.listJobEvents('rebrief-job').find((candidate) => candidate.kind === 'silas.rebrief');
      expect(event).not.toBeNull();
      expect((event?.payload as { note?: string }).note).toContain('same blocker');
      // The prior live session was retired, not leaked.
      expect(h.disposedHandles).toContain(priorMinion);
      // The re-brief prompt carries the original briefing (still the
      // contract) AND the note — a cwd-only check proved neither.
      const rebriefText = h.minionTurnTexts.find((text) => text.startsWith('Re-brief — job rebrief-job'));
      expect(rebriefText).toBeDefined();
      expect(rebriefText).toContain('the original contract');
      expect(rebriefText).toContain('same blocker three rounds; try a different approach');
      expect(h.ledger.listAgents().some((agent) => agent.jobId === 'rebrief-job' && agent.role === 'minion')).toBe(true);
      // the fresh minion's turn committed, and the follow-up delivery signal
      // recorded the moved head the re-review freshness predicate reads
      const lane = h.worktrees.listWorktrees({ jobId: 'rebrief-job' }).find((candidate) => candidate.kind === 'job');
      const head = execFileSync('git', ['-C', lane!.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const delivered = h.ledger.listJobEvents('rebrief-job').find((candidate) => candidate.kind === 'job.delivered');
      expect(delivered).not.toBeNull();
      expect(delivered?.payload).toMatchObject({
        agentId: `agent-${h.spawns.length}`,
        source: 'silas-rebrief',
        sha: head,
      });
      expect(head).not.toBe(lane?.sha);
      expect(field<string>(res.json, 'delivered_sha')).toBe(head);
    } finally {
      await h.close();
    }
  });

  it('/api/silas/directive on a lane with no reachable minion answers 502 undelivered; terminal jobs refuse', async () => {
    const h = await boot();
    const repo = makeFixtureRepo('fixture-silas-undelivered');
    cleanupRepos.push(repo);
    try {
      // a job row with no lane at all
      h.ledger.addJob({ id: 'ghost-job', repo: 'nowhere', title: 't', briefing: 'b' });
      const res = await call(h.port, 'POST', '/api/silas/directive', {
        job_id: 'ghost-job', directive: 'fix it',
      }, TOKEN);
      expect(res.status).toBe(502);
      expect(field<string>(res.json, 'error')).toBe('undelivered');
      // terminal jobs take no directives
      h.ledger.addJob({ id: 'done-job', repo: 'nowhere', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('done-job', 'working');
      h.ledger.setJobStatus('done-job', 'done');
      const done = await call(h.port, 'POST', '/api/silas/directive', {
        job_id: 'done-job', directive: 'fix it',
      }, TOKEN);
      expect(done.status).toBe(400);
      // unknown job id fails loud
      const unknown = await call(h.port, 'POST', '/api/silas/directive', {
        job_id: 'no-such-job', directive: 'fix it',
      }, TOKEN);
      expect(unknown.status).toBe(400);
    } finally {
      await h.close();
    }
  });

  it('the follow-up delivery signal arms the re-review only when the lane head moved past the reviewed target', async () => {
    const h = await boot();
    const repo = makeFixtureRepo('fixture-silas-freshness');
    cleanupRepos.push(repo);
    const laneOf = (jobId: string) =>
      h.worktrees.listWorktrees({ jobId }).find((candidate) => candidate.kind === 'job');
    const headOf = (path: string) =>
      execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const digestOf = () =>
      computeSilasDigest({
        ledger: h.ledger,
        blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG,
        trigger: 'sweep',
      });
    try {
      // (A) a directive whose turn produced NO new commit: the delivery
      // records the reviewed head, so no re-review round is manufactured.
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'fresh-noop', repo_path: repo.path, title: 'noop fix', briefing: 'b',
      }, TOKEN);
      h.ledger.setJobPr('fresh-noop', PR_URL);
      const noopLane = laneOf('fresh-noop')!;
      const noopHead = headOf(noopLane.path);
      h.ledger.addRound({ jobId: 'fresh-noop', lenses: ['blind'], targetRef: noopHead });
      h.ledger.setJobStatus('fresh-noop', 'in-review');
      const noopMinion = `agent-${h.spawns.length}`;
      h.ledger.registerAgent({ id: noopMinion, role: 'minion', jobId: 'fresh-noop' });
      h.liveHandles.set(noopMinion, {
        role: 'minion',
        id: noopMinion,
        sessionFile: null,
        capabilities: FAKE_CAPABILITIES,
        prompt: async () => {},
        async steer() {},
        async followUp() {},
        subscribe: () => () => {},
        health: () => ({ state: 'idle' as const, lastActivity: null, sessionFile: null }),
        async dispose() {},
      });
      const noop = await call(h.port, 'POST', '/api/silas/directive', {
        job_id: 'fresh-noop', directive: 'fix it',
      }, TOKEN);
      expect(noop.status).toBe(200);
      expect(field<string>(noop.json, 'delivered_sha')).toBe(noopHead);
      expect((await digestOf()).prWithoutReview).toEqual([]);

      // (B) a directive whose fallback minion committed: the delivery head
      // moves past the reviewed target → the re-review is due again.
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'fresh-moved', repo_path: repo.path, title: 'real fix', briefing: 'b',
      }, TOKEN);
      h.ledger.setJobPr('fresh-moved', PR_URL);
      const movedLane = laneOf('fresh-moved')!;
      const reviewedHead = headOf(movedLane.path);
      h.ledger.addRound({ jobId: 'fresh-moved', lenses: ['blind'], targetRef: reviewedHead });
      h.ledger.setJobStatus('fresh-moved', 'in-review');
      const moved = await call(h.port, 'POST', '/api/silas/directive', {
        job_id: 'fresh-moved', directive: 'fix the real thing',
      }, TOKEN);
      expect(moved.status).toBe(200);
      const movedSha = field<string>(moved.json, 'delivered_sha');
      expect(movedSha).not.toBe(reviewedHead);
      expect(movedSha).toBe(headOf(movedLane.path));
      const digest = await digestOf();
      expect(digest.prWithoutReview.map((row) => row.jobId)).toEqual(['fresh-moved']);
      expect(digest.prWithoutReview[0]?.priorRounds).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('/api/silas/directive on a lane with no live minion spawns a fresh one, delivers, and disposes it', async () => {
    const h = await boot();
    const repo = makeFixtureRepo('fixture-silas-directive-fresh');
    cleanupRepos.push(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'dir-fresh', repo_path: repo.path, title: 'dead minion', briefing: 'b',
      }, TOKEN);
      const lane = h.worktrees.listWorktrees({ jobId: 'dir-fresh' }).find((candidate) => candidate.kind === 'job');
      expect(lane).toBeDefined();
      const spawnsBefore = h.spawns.length;
      // No live handle registered: the route must fall back to a fresh minion.
      const res = await call(h.port, 'POST', '/api/silas/directive', {
        job_id: 'dir-fresh', directive: 'Fix the dead lane and re-run the suite.',
      }, TOKEN);
      expect(res.status).toBe(200);
      const fresh = h.spawns[spawnsBefore];
      expect(fresh?.role).toBe('minion');
      expect(fresh?.options.cwd).toBe(lane?.path);
      expect(field<string>(res.json, 'minion_id')).toBe(`agent-${h.spawns.length}`);
      expect(h.disposedHandles).toContain(`agent-${h.spawns.length}`);
    } finally {
      await h.close();
    }
  });

  it('/api/silas/rebrief refuses unknown and terminal jobs, and a lane-less job fails loud', async () => {
    const h = await boot();
    try {
      const unknown = await call(h.port, 'POST', '/api/silas/rebrief', { job_id: 'no-such-job', note: 'x' }, TOKEN);
      expect(unknown.status).toBe(400);
      expect(field<string>(unknown.json, 'detail')).toContain('not found');

      h.ledger.addJob({ id: 'done-rebrief', repo: 'nowhere', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('done-rebrief', 'working');
      h.ledger.setJobStatus('done-rebrief', 'done');
      const terminal = await call(h.port, 'POST', '/api/silas/rebrief', { job_id: 'done-rebrief', note: 'x' }, TOKEN);
      expect(terminal.status).toBe(400);
      expect(field<string>(terminal.json, 'detail')).toContain('terminal lanes are never re-briefed');

      // No job lane in the registry: the re-brief must fail loud instead of
      // spawning a fresh worker with nowhere to work.
      h.ledger.addJob({ id: 'laneless-rebrief', repo: 'nowhere', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('laneless-rebrief', 'working');
      const laneLess = await call(h.port, 'POST', '/api/silas/rebrief', { job_id: 'laneless-rebrief', note: 'x' }, TOKEN);
      expect(laneLess.status).toBe(400);
      expect(field<string>(laneLess.json, 'detail')).toContain('no active job lane');
    } finally {
      await h.close();
    }
  });

  it('/api/silas/escalate posts an action-required notification and lands a silas.escalated event', async () => {
    const h = await boot();
    try {
      h.ledger.addJob({ id: 'esc-job', repo: 'r', title: 't', briefing: 'b' });
      const res = await call(h.port, 'POST', '/api/silas/escalate', {
        title: 'Same blocker recurred past the ladder',
        detail: 'job esc-job: fingerprint correctness::src/a.ts::null deref, 4 consecutive rounds',
        job_id: 'esc-job',
      }, TOKEN);
      expect(res.status).toBe(200);
      const notificationId = field<string>(res.json, 'notification_id');
      const event = h.ledger.listJobEvents('esc-job').find((candidate) => candidate.kind === 'silas.escalated');
      expect(event).not.toBeNull();
      expect((event?.payload as { notification_id?: string }).notification_id).toBe(notificationId);
      const notification = h.ledger.listNotifications().find((row) => row.id === notificationId);
      expect(notification?.routing).toBe('action-required');
      expect(notification?.severity).toBe('error');
      // unknown job id fails loud; empty title fails loud
      const unknown = await call(h.port, 'POST', '/api/silas/escalate', { title: 'x', job_id: 'nope' }, TOKEN);
      expect(unknown.status).toBe(400);
      const empty = await call(h.port, 'POST', '/api/silas/escalate', { title: '' }, TOKEN);
      expect(empty.status).toBe(400);
    } finally {
      await h.close();
    }
  });
});
