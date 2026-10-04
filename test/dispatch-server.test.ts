import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { fakeWholeSpawner } from './helpers/perkins-whole-double.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import { PacingGate, type RetrySettlement } from '../src/runtime/pacing.js';
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
import { makeFixtureRepo, attachBareOrigin, type FixtureRepo } from './helpers/fixture-repo.js';
import { originHeadProbe } from './helpers/pr-head-probe.js';

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
  /** Gate selected minion turns before they settle (in-flight assertions). */
  minionPromptGate?: (text: string) => Promise<void> | undefined;
  /** Capture service log lines (with their fields) for operator-surface assertions. */
  log?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
  /** Test-only seam: wrap the ledger the server and dispatch see, so
   * defensive ledger dispositions can be forced deterministically. */
  wrapLedger?: (ledger: LedgerApi) => LedgerApi;
  /** The health a minion handle reports AFTER its prompt settles — the
   * fulfilled-but-error outcome both real adapters can produce. */
  minionTurnHealth?: (text: string) => 'idle' | 'error';
  /** Provider pacing: the bounded retry settlement to report for a
   * delivered directive/re-brief turn. Absent = no interlock. */
  retrySettlement?: (agentId: string) => Promise<RetrySettlement>;
  /** Provider pacing: worker gate forwarded to the silas routes. */
  workerGate?: PacingGate;
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
  const rawLedger = new LedgerApi(db.handle, { bus });
  const ledger = opts.wrapLedger === undefined ? rawLedger : opts.wrapLedger(rawLedger);
  const notifications = new NotificationCenter({ ledger, bus });
  const worktrees = new InMemoryWorktreePort(join(dir, 'wtroot'));
  const spawns: { role: Role; options: SpawnOptions }[] = [];
  const reviewSessions = join(dir, 'review-sessions');
  mkdirSync(reviewSessions, { recursive: true });
  const hybrid = fakeWholeSpawner(reviewSessions, { childAnswer: () => '[]' });
  const spawner = async (role: Role, options?: SpawnOptions): Promise<AgentHandle> => {
    spawns.push({ role, options: options ?? {} });
    if (role === 'perkins') return hybrid.spawner(role, options);
    const id = `agent-${spawns.length}`;
    let turnHealth: 'idle' | 'error' = 'idle';
    return {
      role,
      id,
      sessionFile: null,
      capabilities: FAKE_CAPABILITIES,
      async prompt(text: string) {
        if (role !== 'minion' || options?.cwd === undefined) return;
        minionPrompts.push(`cwd=${options.cwd}`);
        minionTurnTexts.push(text);
        const gate = opts.minionPromptGate?.(text);
        if (gate !== undefined) await gate;
        // idempotent per prompt: a fresh file per turn, so a second minion
        // turn on the same lane (silas re-brief) always has a commit to make.
        const file = join(options.cwd, `http-deliverable-${id}.txt`);
        writeFileSync(file, 'review me\n');
        execFileSync('git', ['-C', options.cwd, 'add', file]);
        execFileSync('git', ['-C', options.cwd, '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'test: http deliverable'], { stdio: 'ignore' });
        // Lanes with an origin publish each turn: the review freeze reads
        // the pushed tip, never the recorded lane pointer.
        const remotes = execFileSync('git', ['-C', options.cwd, 'remote'], { encoding: 'utf-8' }).trim().split('\n');
        if (remotes.includes('origin')) {
          const branch = execFileSync('git', ['-C', options.cwd, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf-8' }).trim();
          execFileSync('git', ['-C', options.cwd, 'push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], { stdio: 'ignore' });
        }
        turnHealth = opts.minionTurnHealth?.(text) ?? 'idle';
      },
      async steer() {},
      async followUp() {},
      subscribe() {
        return () => {};
      },
      health() {
        return turnHealth === 'error'
          ? { state: 'error' as const, lastActivity: null, sessionFile: null, error: 'runtime settled the turn with an in-band error' }
          : { state: 'idle' as const, lastActivity: null, sessionFile: null };
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
    bus,
    poster: { async post(input: { readonly targetSha: string; readonly body: string }) { return { reviewId: '9001', actor: 'gru-bot', event: 'COMMENTED', commitId: input.targetSha, headSha: input.targetSha, baseSha: 'stub-base', bodySha256: createHash('sha256').update(input.body, 'utf8').digest('hex') }; } },
    reviewArtifactRoot: join(dir, 'reviews'),
    prHeadProbe: originHeadProbe(),
    ...(opts.reviewPreflight !== undefined ? { reviewPreflight: opts.reviewPreflight } : {}),
    ...(opts.fallbackGate !== undefined ? { fallbackGate: opts.fallbackGate } : {}),
  });
  const server = createDispatchServer({
    config: cfg,
    dispatch,
    wave,
    ledger,
    ...(opts.log !== undefined ? { log: opts.log } : {}),
    ...(opts.retrySettlement !== undefined ? { retrySettlement: opts.retrySettlement } : {}),
    ...(opts.workerGate !== undefined ? { workerGate: opts.workerGate } : {}),
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

/** Wait for the dispatched minion's briefing turn to settle on the record
 * before a PR/review request reads the lane: the review freeze reads the
 * pushed origin tip, which only exists after the turn. Deadline keeps the
 * failure honest (no unbounded wait), matching the file's other cases. */
async function waitForDelivery(h: ServerHarness, jobId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (h.ledger.latestJobEvent(jobId, 'job.delivered') === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).not.toBeNull();
}

/** The directive endpoint now records durable intent first and answers 202:
 * the async turn settles on the request record — poll it deterministically
 * (no wall-clock sleeps in the assertions themselves). */
async function awaitDirectiveTerminal(
  h: { ledger: LedgerApi },
  requestId: string,
  timeoutMs = 10_000,
): Promise<{ state: string; failReason: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = h.ledger.getDirective(requestId);
    if (row !== null && (row.state === 'settled' || row.state === 'failed')) {
      return { state: row.state, failReason: row.failReason };
    }
    if (Date.now() > deadline) throw new Error(`directive ${requestId} did not reach a terminal state`);
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
  }
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

  it('dispatches a marked completion phase: the intent is durable before the turn, the response still 202s', async () => {
    const h = await boot();
    const repo = makeFixtureRepo('fixture-http-handoff');
    cleanupRepos.push(repo);
    try {
      const res = await call(
        h.port,
        'POST',
        '/api/dispatch',
        {
          job_id: 'http-marked',
          repo_path: repo.path,
          title: 'marked artifact phase',
          briefing: 'audit only; no commit expected',
          completion_handoff: { kind: 'gru-decision', decision: 'rule on the audit' },
        },
        TOKEN,
      );
      expect(res.status).toBe(202);
      // The guard row exists BEFORE the minion turn completes, bound to the
      // spawned worker: the completion observer matches on this identity.
      const phases = h.ledger.listPhaseHandoffs({ jobId: 'http-marked' });
      expect(phases).toHaveLength(1);
      expect(phases[0]).toMatchObject({
        source: 'dispatch',
        state: 'awaiting',
        decision: 'rule on the audit',
      });
      expect(phases[0]?.minionId).not.toBeNull();
    } finally {
      await h.close();
    }
  });

  it('refuses a malformed completion_handoff before any job or phase exists', async () => {
    const h = await boot();
    try {
      const badDispatch = await call(
        h.port,
        'POST',
        '/api/dispatch',
        {
          job_id: 'http-bad-handoff',
          repo_path: '/tmp/not-a-repo',
          title: 't',
          briefing: 'b',
          completion_handoff: { kind: 'owner-decision', decision: 'no' },
        },
        TOKEN,
      );
      expect(badDispatch.status).toBe(400);
      expect(h.ledger.getJob('http-bad-handoff')).toBeNull();

      h.ledger.addJob({ id: 'http-bad-directive', repo: 'r', title: 't' });
      h.ledger.setJobStatus('http-bad-directive', 'working');
      const badDirective = await call(
        h.port,
        'POST',
        '/api/silas/directive',
        { job_id: 'http-bad-directive', directive: 'x', completion_handoff: { kind: 'gru-decision' } },
        TOKEN,
      );
      expect(badDirective.status).toBe(400);
      expect(h.ledger.listPhaseHandoffs({ jobId: 'http-bad-directive' })).toHaveLength(0);

      const badRebrief = await call(
        h.port,
        'POST',
        '/api/silas/rebrief',
        { job_id: 'http-bad-directive', note: 'n', completion_handoff: 'gru' },
        TOKEN,
      );
      expect(badRebrief.status).toBe(400);
      expect(h.ledger.listPendingRebriefs({ jobId: 'http-bad-directive' })).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('returns a durable 202 review receipt to an implementing minion without waiting on its open turn', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const skillDir = mkdtempSync(join(tmpdir(), 'bmad-review-handoff-'));
    cleanupDirs.push(skillDir);
    const skillFile = join(skillDir, 'SKILL.md');
    writeFileSync(skillFile, '---\nname: bmad-review\n---\ninstalled', 'utf8');
    const h = await boot({
      minionPromptGate: () => gate,
      reviewPreflight: async () => ({ ok: false, failures: [{ leg: 'review-policy', detail: 'disabled', remediation: 'enable review' }] }),
      fallbackGate: { skillPath: skillFile, runFallbackReview: async () => [],
        fixDirectiveSink: async () => ({ delivered: true }),
      },
    });
    const repo = makeFixtureRepo('fixture-http-handoff');
    cleanupRepos.push(repo);
    try {
      const dispatch = await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'http-handoff', repo_path: repo.path, title: 'reviewable', briefing: 'ship it',
      }, TOKEN);
      expect(dispatch.status).toBe(202);
      const review = await call(h.port, 'POST', '/api/dispatch/review', {
        job_id: 'http-handoff', by: 'minion',
      }, TOKEN);
      expect(review.status).toBe(202);
      expect(review.json).toMatchObject({ route: 'queued', job_id: 'http-handoff' });
      expect(h.ledger.listRounds('http-handoff')).toHaveLength(0);
      expect(h.ledger.latestJobEvent('http-handoff', 'job.delivered')).toBeNull();
      release();
      for (let tick = 0; tick < 40 && h.ledger.latestJobEvent('http-handoff', 'job.review-handoff-started') === null; tick += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      expect(h.ledger.latestJobEvent('http-handoff', 'job.review-handoff-started')?.payload).toMatchObject({
        route: 'bmad-review-fallback',
      });
      for (let tick = 0; tick < 40 &&
        (h.ledger.latestJobEvent('http-handoff', 'job.fallback-review')?.payload as { phase?: string } | undefined)?.phase !== 'pass'; tick += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      expect(h.ledger.latestJobEvent('http-handoff', 'job.fallback-review')?.payload).toMatchObject({ phase: 'pass' });
    } finally {
      release();
      await h.close();
    }
  });

  it('records the PR link and kicks a review wave', async () => {
    const h = await boot();
    const repo = makeFixtureRepo('fixture-http-review');
    cleanupRepos.push(repo);
    attachBareOrigin(repo);
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

  it('by=silas on the pr/review endpoints records silas attribution events', async () => {
    const h = await boot();
    const repo = makeFixtureRepo('fixture-silas-by');
    cleanupRepos.push(repo);
    attachBareOrigin(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'by-silas-job', repo_path: repo.path, title: 'attribution', briefing: 'b',
      }, TOKEN);
      await waitForDelivery(h, 'by-silas-job');
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
    } finally {
      await h.close();
    }
  });

  it('without by, the pr/review endpoints record no silas attribution events', async () => {
    // One scenario per case: the combined form ran two complete review
    // setups under one inherited 30s default and overran it under
    // co-tenant load. This arm proves the absence on a fully processed
    // request (PR 200, review 202), never on a silently failed call.
    const h = await boot();
    const repo = makeFixtureRepo('fixture-silas-none');
    cleanupRepos.push(repo);
    attachBareOrigin(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'by-none-job', repo_path: repo.path, title: 'plain', briefing: 'b',
      }, TOKEN);
      await waitForDelivery(h, 'by-none-job');
      const pr = await call(h.port, 'POST', '/api/dispatch/pr', { job_id: 'by-none-job', url: PR_URL }, TOKEN);
      expect(pr.status).toBe(200);
      const review = await call(h.port, 'POST', '/api/dispatch/review', { job_id: 'by-none-job' }, TOKEN);
      expect(review.status).toBe(202);
      const plainKinds = h.ledger.listJobEvents('by-none-job').map((event) => event.kind);
      expect(plainKinds).not.toContain('silas.pr-registered');
      expect(plainKinds).not.toContain('silas.review-triggered');
    } finally {
      await h.close();
    }
  });

  it('re-arms one proven same-head service-restart abort through the guarded Silas review API', async () => {
    const h = await boot();
    const repo = makeFixtureRepo('fixture-clean-abort');
    cleanupRepos.push(repo);
    attachBareOrigin(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', { job_id: 'clean-abort', repo_path: repo.path, title: 'clean', briefing: 'b' }, TOKEN);
      const deadline = Date.now() + 10_000;
      while (h.ledger.latestJobEvent('clean-abort', 'job.delivered') === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(h.ledger.latestJobEvent('clean-abort', 'job.delivered')).not.toBeNull();
      expect((await call(h.port, 'POST', '/api/dispatch/pr', { job_id: 'clean-abort', url: PR_URL }, TOKEN)).status).toBe(200);
      const lane = h.worktrees.listWorktrees({ jobId: 'clean-abort' }).find((row) => row.kind === 'job')!;
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: lane.path, encoding: 'utf8' }).trim();
      expect(h.ledger.latestJobEvent('clean-abort', 'job.delivered')?.payload).toMatchObject({ sha, source: 'dispatch' });
      const round = h.ledger.addRound({ jobId: 'clean-abort', targetRef: sha, lenses: ['blind'] });
      h.ledger.setRoundStatus(round.id, 'aborted');
      const body = { job_id: 'clean-abort', by: 'silas', rule_id: 'clean-abort-service-restart', source_round_id: round.id };
      expect((await call(h.port, 'POST', '/api/dispatch/review', body, TOKEN)).status).toBe(400);
      h.ledger.appendCustomEvent({ kind: 'round.perkins-incomplete', jobId: 'clean-abort', roundId: round.id, payload: { reason: 'cancelled' } });
      expect((await call(h.port, 'POST', '/api/dispatch/review', body, TOKEN)).status).toBe(400);
      h.ledger.appendCustomEvent({ kind: 'round.perkins-incomplete', jobId: 'clean-abort', roundId: round.id, payload: { reason: 'service_restart' } });
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'clean-abort', payload: { sha: 'new-unreviewed-head' } });
      expect((await call(h.port, 'POST', '/api/dispatch/review', body, TOKEN)).status).toBe(400);
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'clean-abort', payload: { sha } });
      expect((await call(h.port, 'POST', '/api/dispatch/review', { ...body, force: true }, TOKEN)).status).toBe(400);
      expect((await call(h.port, 'POST', '/api/dispatch/review', { ...body, by: 'gru' }, TOKEN)).status).toBe(400);
      const digest = await computeSilasDigest({ ledger: h.ledger, blockersForRound: async () => ({ blockers: [], note: null }),
        config: DEFAULT_SILAS_CONFIG, trigger: 'sweep' });
      expect(digest.prWithoutReview).toMatchObject([{ jobId: 'clean-abort', cleanAbort: { roundId: round.id } }]);
      const review = await call(h.port, 'POST', '/api/dispatch/review', body, TOKEN);
      expect(review).toMatchObject({ status: 202, json: { route: 'perkins', round_id: 'clean-abort-r2',
        rule_id: 'clean-abort-service-restart', source_round_id: round.id } });
      expect(h.ledger.latestJobEvent('clean-abort', 'silas.review-triggered')?.payload).toMatchObject({
        rule_id: 'clean-abort-service-restart', source_round_id: round.id, round_id: 'clean-abort-r2',
      });
      expect((await call(h.port, 'POST', '/api/dispatch/review', body, TOKEN)).status).toBe(400);
    } finally { await h.close(); }
  }, 90_000);

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
      // Accepted ≠ admitted: 202 reports the durable intent; the turn settles
      // on the request record (readback) instead of the HTTP response.
      expect(res.status).toBe(202);
      const requestId = field<string>(res.json, 'request_id');
      expect(field<string>(res.json, 'state')).toBe('dispatching');
      expect((await awaitDirectiveTerminal(h, requestId)).state).toBe('settled');
      const job = h.ledger.getJob('dir-job');
      expect(job?.status).toBe('working');
      expect(job?.note ?? '').toContain('working');
      const event = h.ledger.listJobEvents('dir-job').find((candidate) => candidate.kind === 'silas.directive-sent');
      expect(event).not.toBeNull();
      expect((event?.payload as { blocker_fingerprint?: string }).blocker_fingerprint).toBe('correctness::src/a.ts::null deref');
      // The follow-up delivery signal: the settled directive turn is recorded
      // as a delivery carrying the lane's head (no-op minion → unchanged head),
      // correlated to THIS request so it can only settle this one.
      const lane = h.worktrees.listWorktrees({ jobId: 'dir-job' }).find((candidate) => candidate.kind === 'job');
      const head = execFileSync('git', ['-C', lane!.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      const delivered = h.ledger.listJobEvents('dir-job').find((candidate) => candidate.kind === 'job.delivered');
      expect(delivered).not.toBeNull();
      expect(delivered?.payload).toMatchObject({ agentId: minionId, source: 'silas-directive', sha: head, request_id: requestId });
      const readback = h.ledger.getDirective(requestId);
      expect(readback?.deliverySeq).toBe(delivered?.seq);
      expect(readback?.admissionMinion).toBe(minionId);
    } finally {
      await h.close();
    }
  });

  it('/api/silas/directive records admission but NO delivery or phase completion when the turn settles with an in-band error', async () => {
    const h = await boot();
    const repo = makeFixtureRepo('fixture-silas-inband-directive');
    cleanupRepos.push(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'inband-dir', repo_path: repo.path, title: 'error lane', briefing: 'b',
      }, TOKEN);
      const minionId = `agent-${h.spawns.length}`;
      h.ledger.registerAgent({ id: minionId, role: 'minion', jobId: 'inband-dir' });
      h.liveHandles.set(minionId, {
        role: 'minion',
        id: minionId,
        sessionFile: null,
        capabilities: FAKE_CAPABILITIES,
        prompt: async () => {}, // resolves — the failure is in-band health
        async steer() {},
        async followUp() {},
        subscribe: () => () => {},
        health: () => ({ state: 'error' as const, lastActivity: null, sessionFile: null, error: 'assistant stopReason error' }),
        async dispose() {},
      });
      h.ledger.setJobStatus('inband-dir', 'in-review');
      const res = await call(h.port, 'POST', '/api/silas/directive', {
        job_id: 'inband-dir',
        directive: 'fix it',
        completion_handoff: { kind: 'gru-decision', decision: 'never owed by a failed turn' },
      }, TOKEN);
      expect(res.status).toBe(202);
      const requestId = field<string>(res.json, 'request_id');
      // The turn settled with an error: the request is admitted with a
      // durable reconcile note and NEVER records a delivery.
      const deadline = Date.now() + 10_000;
      while ((h.ledger.getDirective(requestId)?.failReason ?? '').indexOf('in-band runtime error') === -1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const readback = h.ledger.getDirective(requestId);
      expect(readback?.state).toBe('admitted');
      expect(readback?.deliverySeq).toBeNull();
      expect(readback?.failReason).toContain('in-band runtime error');
      // The creation dispatch legitimately recorded its own delivery; the
      // failed directive turn must not add a REQUEST-sourced delivery.
      expect(h.ledger.listJobEvents('inband-dir').some((event) =>
        event.kind === 'job.delivered' && (event.payload as { source?: string }).source === 'silas-directive',
      )).toBe(false);
      expect(h.ledger.latestJobEvent('inband-dir', 'job.minion-error')).not.toBeNull();
      // The marked phase stays awaiting — never completed, never published.
      const phase = h.ledger.listPhaseHandoffs({ jobId: 'inband-dir' })[0];
      expect(phase?.state).toBe('awaiting');
      expect(phase?.completionSeq).toBeNull();
      expect(h.ledger.getJob('inband-dir')?.status).toBe('in-review'); // no false working flip
      expect(
        h.ledger.listNotifications({ limit: 200 }).filter((row) => row.kind.includes('phase-handback')),
      ).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('/api/silas/directive keeps a superseded post-prompt turn LIVE for reconciliation (never a no-effect failure)', async () => {
    // The pre-prompt interlock is clean; the retry is superseded AFTER the
    // prompt call — admission is UNKNOWN, not a no-effect failure (r5
    // blocker 2).
    let settleCalls = 0;
    const h = await boot({ retrySettlement: async () => (++settleCalls === 1 ? 'none' : 'superseded') });
    const repo = makeFixtureRepo('fixture-silas-directive-settle');
    cleanupRepos.push(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'dir-settle', repo_path: repo.path, title: 'settle lane', briefing: 'b',
      }, TOKEN);
      const minionId = `agent-${h.spawns.length}`;
      h.ledger.registerAgent({ id: minionId, role: 'minion', jobId: 'dir-settle' });
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
      h.ledger.setJobStatus('dir-settle', 'in-review');
      const res = await call(h.port, 'POST', '/api/silas/directive', {
        job_id: 'dir-settle',
        directive: 'Fix the retry settlement path.',
      }, TOKEN);
      expect(res.status).toBe(202);
      const requestId = field<string>(res.json, 'request_id');
      // The reconcile note lands; the request stays dispatching (live).
      const deadline = Date.now() + 10_000;
      while (!(h.ledger.getDirective(requestId)?.failReason ?? '').includes('unknown admission') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const readback = h.ledger.getDirective(requestId);
      expect(readback?.state).toBe('dispatching');
      expect(readback?.failReason).toContain('unknown admission');
      expect(readback?.failReason).toContain('superseded');
      // The single-writer guard holds: a different request id is refused.
      const blocked = await call(h.port, 'POST', '/api/silas/directive', {
        job_id: 'dir-settle', directive: 'different work', request_id: 'req-other',
      }, TOKEN);
      expect(blocked.status).toBe(409);
      expect(h.ledger.listJobEvents('dir-settle').some((event) => event.kind === 'silas.directive-sent')).toBe(false);
      // The creation dispatch legitimately recorded its own delivery; the
      // request must not add a REQUEST-sourced delivery on top of it.
      expect(h.ledger.listJobEvents('dir-settle').some((event) =>
        event.kind === 'job.delivered' && (event.payload as { source?: string }).source === 'silas-directive',
      )).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('/api/silas/directive keeps a FRESH-minion post-prompt supersession LIVE too', async () => {
    // No live handle is registered: the route spawns a fresh minion, prompts
    // it, and only then learns the retry was superseded. Admission is
    // UNKNOWN — the request stays live on the fresh path as well.
    const h = await boot({ retrySettlement: async () => 'superseded' });
    const repo = makeFixtureRepo('fixture-silas-directive-fresh-settle');
    cleanupRepos.push(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'dir-fresh', repo_path: repo.path, title: 'fresh settle lane', briefing: 'b',
      }, TOKEN);
      // Let the initial dispatch turn settle before the directive starts.
      const firstTurnDeadline = Date.now() + 10_000;
      while (h.ledger.latestJobEvent('dir-fresh', 'job.delivered') === null && Date.now() < firstTurnDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      h.ledger.setJobStatus('dir-fresh', 'in-review');
      const res = await call(h.port, 'POST', '/api/silas/directive', {
        job_id: 'dir-fresh',
        directive: 'Fix under fresh supersession.',
      }, TOKEN);
      expect(res.status).toBe(202);
      const requestId = field<string>(res.json, 'request_id');
      const deadline = Date.now() + 10_000;
      while (!(h.ledger.getDirective(requestId)?.failReason ?? '').includes('unknown admission') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const readback = h.ledger.getDirective(requestId);
      expect(readback?.state).toBe('dispatching');
      expect(readback?.failReason).toContain('superseded');
      const blocked = await call(h.port, 'POST', '/api/silas/directive', {
        job_id: 'dir-fresh', directive: 'different work', request_id: 'req-other',
      }, TOKEN);
      expect(blocked.status).toBe(409);
      expect(h.ledger.listJobEvents('dir-fresh').some((event) =>
        event.kind === 'job.delivered' && (event.payload as { source?: string }).source === 'silas-directive',
      )).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('/api/silas/rebrief keeps its durable markers pending when the bounded retry exhausts', async () => {
    const h = await boot({ retrySettlement: async () => 'exhausted' });
    const repo = makeFixtureRepo('fixture-silas-rebrief-settle');
    cleanupRepos.push(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'reb-settle', repo_path: repo.path, title: 'settle lane', briefing: 'b',
      }, TOKEN);
      const res = await call(h.port, 'POST', '/api/silas/rebrief', {
        job_id: 'reb-settle', note: 'try again',
      }, TOKEN);
      expect(res.status).toBe(400);
      expect(field<string>(res.json, 'detail')).toContain('automatic rate-limit retry exhausted');
      expect(h.ledger.listJobEvents('reb-settle').some((event) => event.kind === 'silas.rebrief')).toBe(false);
      // The creation dispatch legitimately recorded its own delivery; the
      // re-brief request must not add a REQUEST-sourced delivery.
      expect(h.ledger.listJobEvents('reb-settle').some((event) =>
        event.kind === 'job.delivered' && (event.payload as { source?: string }).source === 'silas-rebrief',
      )).toBe(false);
      expect(h.ledger.listPendingRebriefs({ jobId: 'reb-settle' })).toHaveLength(2);
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

  it('/api/silas/rebrief keeps the markers and records NO delivery or phase completion when the turn settles with an in-band error', async () => {
    const h = await boot({ minionTurnHealth: (text) => (text.startsWith('Re-brief —') ? 'error' : 'idle') });
    const repo = makeFixtureRepo('fixture-silas-inband-rebrief');
    cleanupRepos.push(repo);
    try {
      const dispatch = await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'inband-rebrief', repo_path: repo.path, title: 'stuck lane', briefing: 'the original contract',
      }, TOKEN);
      expect(dispatch.status).toBe(202);
      // Let the initial (healthy) briefing turn settle first.
      const firstTurnDeadline = Date.now() + 10_000;
      while (h.ledger.latestJobEvent('inband-rebrief', 'job.delivered') === null && Date.now() < firstTurnDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const res = await call(h.port, 'POST', '/api/silas/rebrief', {
        job_id: 'inband-rebrief',
        note: 'same blocker; try differently',
        completion_handoff: { kind: 'gru-decision', decision: 'never owed by a failed turn' },
      }, TOKEN);
      expect(res.status, JSON.stringify(res.json)).toBe(202);
      expect(field<string>(res.json, 'state')).toBe('turn-error');
      // No guarded events landed: the marker pair stays pending for the
      // boot recovery ladder, and the marked phase stays awaiting.
      expect(h.ledger.listPendingRebriefs({ jobId: 'inband-rebrief' })).toHaveLength(2);
      expect(h.ledger.latestJobEvent('inband-rebrief', 'silas.rebrief')).toBeNull();
      expect(
        h.ledger.listJobEvents('inband-rebrief').filter((event) => event.kind === 'job.delivered'),
      ).toHaveLength(1); // the initial dispatch delivery only — no failed-turn delivery
      expect(h.ledger.latestJobEvent('inband-rebrief', 'job.minion-error')).not.toBeNull();
      const phase = h.ledger.listPhaseHandoffs({ jobId: 'inband-rebrief' })[0];
      expect(phase?.state).toBe('awaiting');
      expect(phase?.completionSeq).toBeNull();
      expect(
        h.ledger.listNotifications({ limit: 200 }).filter((row) => row.kind.includes('phase-handback')),
      ).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('/api/silas/rebrief persists request markers before the worker and clears them only when the events land', async () => {
    let releasePrompt!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releasePrompt = resolveGate;
    });
    const h = await boot({ minionPromptGate: (text) => (text.startsWith('Re-brief —') ? gate : undefined) });
    const repo = makeFixtureRepo('fixture-silas-rebrief-markers');
    cleanupRepos.push(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'marker-job', repo_path: repo.path, title: 'stuck lane', briefing: 'the original contract',
      }, TOKEN);
      // Let the initial briefing turn settle before the re-brief: the fresh
      // worker must not race the first minion's git commit on the lane.
      const firstTurnDeadline = Date.now() + 10_000;
      while (h.ledger.latestJobEvent('marker-job', 'job.delivered') === null && Date.now() < firstTurnDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const pending = call(h.port, 'POST', '/api/silas/rebrief', {
        job_id: 'marker-job', note: 're-open with the marker cure',
      }, TOKEN);
      // While the turn is in flight the durable marker pair exists and is
      // bound to the spawned worker — before its prompt can settle.
      const deadline = Date.now() + 10_000;
      while (h.ledger.listPendingRebriefs({ jobId: 'marker-job' }).length !== 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const markers = h.ledger.listPendingRebriefs({ jobId: 'marker-job' });
      expect(markers).toHaveLength(2);
      const rebriefMarker = markers.find((marker) => marker.kind === 'silas.rebrief');
      expect(rebriefMarker?.note).toBe('re-open with the marker cure');
      expect(rebriefMarker?.agentId).not.toBeNull();
      // No event has answered the request yet (the initial dispatch delivery
      // predates the marker's watermark and cannot count as the re-brief's).
      const baseline = rebriefMarker?.baselineSeq ?? Number.NaN;
      expect(h.ledger.latestJobEvent('marker-job', 'silas.rebrief')).toBeNull();
      const inFlightDelivery = h.ledger.latestJobEvent('marker-job', 'job.delivered');
      expect(inFlightDelivery === null || inFlightDelivery.seq <= baseline).toBe(true);

      releasePrompt();
      const res = await pending;
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      // Markers clear ONLY once both guarded events landed.
      expect(h.ledger.listPendingRebriefs({ jobId: 'marker-job' })).toHaveLength(0);
      expect(h.ledger.latestJobEvent('marker-job', 'silas.rebrief')?.seq).toBeGreaterThan(baseline);
      expect(h.ledger.latestJobEvent('marker-job', 'job.delivered')?.seq).toBeGreaterThan(baseline);
    } finally {
      releasePrompt();
      await h.close();
    }
  });

  it('/api/silas/rebrief reports a superseded ordinary turn without consuming newer markers', async () => {
    let releasePrompt!: () => void;
    const gate = new Promise<void>((resolve) => { releasePrompt = resolve; });
    const h = await boot({ minionPromptGate: (text) => text.startsWith('Re-brief —') ? gate : undefined });
    const repo = makeFixtureRepo('fixture-rebrief-superseded-http');
    cleanupRepos.push(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'superseded-http', repo_path: repo.path, title: 'lane', briefing: 'contract',
      }, TOKEN);
      const initialDeadline = Date.now() + 10_000;
      while (h.ledger.latestJobEvent('superseded-http', 'job.delivered') === null && Date.now() < initialDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const pending = call(h.port, 'POST', '/api/silas/rebrief', { job_id: 'superseded-http', note: 'older' }, TOKEN);
      const deadline = Date.now() + 10_000;
      while (!h.minionTurnTexts.some((text) => text.startsWith('Re-brief —')) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(h.minionTurnTexts.some((text) => text.startsWith('Re-brief —'))).toBe(true);
      const newer = h.ledger.beginPendingRebrief({ jobId: 'superseded-http', note: 'newer', briefing: 'contract' });
      h.ledger.setJobStatus('superseded-http', 'in-review');
      releasePrompt();
      const response = await pending;
      expect(response.status).toBe(200);
      expect(field<boolean>(response.json, 'superseded')).toBe(true);
      expect(h.ledger.listPendingRebriefs({ jobId: 'superseded-http' })).toEqual(newer);
      expect(h.ledger.getJob('superseded-http')?.status).toBe('in-review');
      expect(h.ledger.latestJobEvent('superseded-http', 'silas.rebrief')).toBeNull();
    } finally {
      releasePrompt();
      await h.close();
    }
  });

  it('/api/silas/rebrief cancels a queued terminal request before disposing or spawning', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const h = await boot({ workerGate: gate });
    const repo = makeFixtureRepo('fixture-queued-terminal-http');
    cleanupRepos.push(repo);
    let holder: Awaited<ReturnType<PacingGate['acquireWorkerTurn']>> | null = null;
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'queued-terminal-http', repo_path: repo.path, title: 'lane', briefing: 'contract',
      }, TOKEN);
      const deadline = Date.now() + 10_000;
      while (h.ledger.latestJobEvent('queued-terminal-http', 'job.delivered') === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      holder = await gate.acquireWorkerTurn({ id: 'holder', label: 'holder' });
      const beforeSpawns = h.spawns.length;
      const pending = call(h.port, 'POST', '/api/silas/rebrief', { job_id: 'queued-terminal-http', note: 'queued' }, TOKEN);
      while (h.ledger.listPendingRebriefs({ jobId: 'queued-terminal-http' }).length !== 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(h.ledger.listPendingRebriefs({ jobId: 'queued-terminal-http' })).toHaveLength(2);
      h.ledger.setJobStatus('queued-terminal-http', 'in-review');
      h.ledger.setJobStatus('queued-terminal-http', 'merged');
      holder.release();
      holder = null;
      const response = await pending;
      expect(response.status).toBe(200);
      expect(field<boolean>(response.json, 'retired')).toBe(true);
      expect(h.spawns).toHaveLength(beforeSpawns);
      expect(h.disposedHandles).toHaveLength(0);
      expect(h.ledger.listPendingRebriefs({ jobId: 'queued-terminal-http' })).toHaveLength(0);
      expect(h.ledger.listJobEvents('queued-terminal-http').filter((event) => event.kind === 'silas.rebrief-retired')).toHaveLength(1);
    } finally {
      holder?.release();
      await h.close();
    }
  });

  it('/api/silas/rebrief cancels a queued superseded unmarked request before disposal or spawn', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const h = await boot({ workerGate: gate });
    const repo = makeFixtureRepo('fixture-queued-superseded-http');
    cleanupRepos.push(repo);
    let holder: Awaited<ReturnType<PacingGate['acquireWorkerTurn']>> | null = null;
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'queued-superseded-http', repo_path: repo.path, title: 'lane', briefing: 'contract',
      }, TOKEN);
      const deadline = Date.now() + 10_000;
      while (h.ledger.latestJobEvent('queued-superseded-http', 'job.delivered') === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const resident = h.ledger.listAgents().find((agent) => agent.jobId === 'queued-superseded-http' && agent.role === 'minion');
      expect(resident).toBeDefined();
      h.liveHandles.set(resident!.id, {
        id: resident!.id, role: 'minion', sessionFile: null, capabilities: FAKE_CAPABILITIES,
        async prompt() {}, async steer() {}, async followUp() {},
        subscribe: () => () => {},
        health: () => ({ state: 'idle', lastActivity: null, sessionFile: null }),
        async dispose() {},
      });
      holder = await gate.acquireWorkerTurn({ id: 'holder', label: 'holder' });
      const beforeSpawns = h.spawns.length;
      const beforePrompts = h.minionTurnTexts.length;
      const pending = call(h.port, 'POST', '/api/silas/rebrief', { job_id: 'queued-superseded-http', note: 'older' }, TOKEN);
      while (h.ledger.listPendingRebriefs({ jobId: 'queued-superseded-http' }).length !== 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(h.ledger.listPendingRebriefs({ jobId: 'queued-superseded-http' })).toHaveLength(2);
      const newer = h.ledger.beginPendingRebrief({ jobId: 'queued-superseded-http', note: 'newer', briefing: 'contract' });
      h.ledger.setJobStatus('queued-superseded-http', 'in-review');
      holder.release();
      holder = null;
      const response = await pending;
      expect(response.status).toBe(200);
      expect(field<boolean>(response.json, 'superseded')).toBe(true);
      expect(h.ledger.listPendingRebriefs({ jobId: 'queued-superseded-http' })).toEqual(newer);
      expect(h.ledger.getJob('queued-superseded-http')?.status).toBe('in-review');
      expect(h.spawns).toHaveLength(beforeSpawns);
      expect(h.disposedHandles).toHaveLength(0);
      expect(h.minionTurnTexts).toHaveLength(beforePrompts);
      expect(h.ledger.latestJobEvent('queued-superseded-http', 'silas.rebrief')).toBeNull();
    } finally {
      holder?.release();
      await h.close();
    }
  });

  it('/api/silas/rebrief retires failed turns that settle after their job goes terminal', async () => {
    for (const mode of ['in-band', 'rejected'] as const) {
      let releasePrompt!: () => void;
      const gate = new Promise<void>((resolve) => { releasePrompt = resolve; });
      const jobId = `terminal-failed-http-${mode}`;
      const h = await boot({
        minionPromptGate: (text) => text.startsWith('Re-brief —')
          ? mode === 'rejected' ? gate.then(() => { throw new Error('synthetic prompt rejection'); }) : gate
          : undefined,
        minionTurnHealth: (text) => mode === 'in-band' && text.startsWith('Re-brief —') ? 'error' : 'idle',
      });
      const repo = makeFixtureRepo(`fixture-terminal-failed-http-${mode}`);
      cleanupRepos.push(repo);
      try {
        await call(h.port, 'POST', '/api/dispatch', {
          job_id: jobId, repo_path: repo.path, title: 'lane', briefing: 'contract',
        }, TOKEN);
        const initialDeadline = Date.now() + 10_000;
        while (h.ledger.latestJobEvent(jobId, 'job.delivered') === null && Date.now() < initialDeadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const pending = call(h.port, 'POST', '/api/silas/rebrief', { job_id: jobId, note: 'retry' }, TOKEN);
        const deadline = Date.now() + 10_000;
        while (!h.minionTurnTexts.some((text) => text.startsWith(`Re-brief — job ${jobId}`)) && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(h.minionTurnTexts.some((text) => text.startsWith(`Re-brief — job ${jobId}`))).toBe(true);
        const markers = h.ledger.listPendingRebriefs({ jobId });
        expect(markers).toHaveLength(2);
        const baseline = markers[0]!.baselineSeq;
        h.ledger.setJobStatus(jobId, 'in-review');
        h.ledger.setJobStatus(jobId, 'merged');
        releasePrompt();
        const response = await pending;
        if (mode === 'in-band') {
          expect(response.status).toBe(202);
          expect(field<string>(response.json, 'state')).toBe('turn-error');
          expect(field<boolean>(response.json, 'retired')).toBe(true);
          expect(h.ledger.latestJobEvent(jobId, 'job.minion-error')).not.toBeNull();
        } else {
          expect(response.status).toBe(400);
          expect(field<string>(response.json, 'detail')).toContain('synthetic prompt rejection');
          expect(field<boolean>(response.json, 'retired')).toBe(true);
        }
        expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
        expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired')).not.toBeNull();
        expect(h.ledger.listJobEvents(jobId).filter((event) =>
          (event.kind === 'silas.rebrief' || event.kind === 'job.delivered') && event.seq > baseline)).toHaveLength(0);
      } finally {
        releasePrompt();
        await h.close();
      }
    }
  });

  it('/api/silas/rebrief reports an administrative retirement when the job goes terminal mid-turn', async () => {
    let releasePrompt!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releasePrompt = resolveGate;
    });
    const logs: string[] = [];
    const h = await boot({
      minionPromptGate: (text) => (text.startsWith('Re-brief —') ? gate : undefined),
      log: (level, msg) => {
        logs.push(`${level}:${msg}`);
      },
    });
    const repo = makeFixtureRepo('fixture-silas-rebrief-terminal');
    cleanupRepos.push(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'terminal-rebrief-job', repo_path: repo.path, title: 'stuck lane', briefing: 'the original contract',
      }, TOKEN);
      // Let the initial briefing turn settle before the re-brief (same shape
      // as the marker test above).
      const firstTurnDeadline = Date.now() + 10_000;
      while (h.ledger.latestJobEvent('terminal-rebrief-job', 'job.delivered') === null && Date.now() < firstTurnDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const pending = call(h.port, 'POST', '/api/silas/rebrief', {
        job_id: 'terminal-rebrief-job', note: 'fold the rebase',
      }, TOKEN);
      // Wait until the re-brief turn is in flight (its markers bound), and
      // capture the request watermark: a guarded event after this baseline
      // would answer the retired request.
      const deadline = Date.now() + 10_000;
      while (h.ledger.listPendingRebriefs({ jobId: 'terminal-rebrief-job' }).length !== 2 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const markers = h.ledger.listPendingRebriefs({ jobId: 'terminal-rebrief-job' });
      expect(markers).toHaveLength(2);
      const rebriefMarker = markers.find((marker) => marker.kind === 'silas.rebrief');
      expect(rebriefMarker).toBeDefined();
      const baseline = rebriefMarker?.baselineSeq ?? Number.NaN;
      // The job reaches terminal while the turn is gated (owner merged it).
      h.ledger.setJobStatus('terminal-rebrief-job', 'in-review');
      h.ledger.setJobStatus('terminal-rebrief-job', 'merged');
      releasePrompt();
      const res = await pending;
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      // The disposition is in-band: retired, no fabricated delivery.
      expect(field<boolean>(res.json, 'retired')).toBe(true);
      expect(field<string | null>(res.json, 'delivered_sha')).toBeNull();
      // No POST-BOUNDARY delivery/re-brief was fabricated for the retired
      // request. The initial briefing turn's own `job.delivered` (source
      // `dispatch`) legitimately predates the request watermark and is
      // retained — history is preserved, never erased to satisfy a test.
      const delivered = h.ledger.latestJobEvent('terminal-rebrief-job', 'job.delivered');
      expect(delivered === null || delivered.seq <= baseline).toBe(true);
      if (delivered !== null) expect(delivered.payload).toMatchObject({ source: 'dispatch' });
      const rebrief = h.ledger.latestJobEvent('terminal-rebrief-job', 'silas.rebrief');
      expect(rebrief === null || rebrief.seq <= baseline).toBe(true);
      expect(h.ledger.latestJobEvent('terminal-rebrief-job', 'silas.rebrief-recovered')).toBeNull();
      // The audit is durable and the obsolete markers are gone; the lane stays terminal.
      expect(h.ledger.latestJobEvent('terminal-rebrief-job', 'silas.rebrief-retired')).not.toBeNull();
      expect(h.ledger.listPendingRebriefs({ jobId: 'terminal-rebrief-job' })).toHaveLength(0);
      expect(h.ledger.getJob('terminal-rebrief-job')?.status).toBe('merged');
      // The operator surface carries the disposition, not just the response.
      expect(logs).toContain('info:silas re-brief retired: job went terminal before the turn settled');
    } finally {
      releasePrompt();
      await h.close();
    }
  });

  it('/api/silas/rebrief surfaces a retirement that retired nothing, keeping the markers', async () => {
    let releasePrompt!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releasePrompt = resolveGate;
    });
    const logs: string[] = [];
    const h = await boot({
      minionPromptGate: (text) => (text.startsWith('Re-brief —') ? gate : undefined),
      wrapLedger: (ledger) => {
        const view = Object.create(ledger) as LedgerApi;
        Object.defineProperty(view, 'retirePendingRebriefs', {
          value: () => ({ retired: [], skippedIds: ['stale-generation'], refused: null }),
        });
        return view;
      },
      log: (level, msg) => {
        logs.push(`${level}:${msg}`);
      },
    });
    const repo = makeFixtureRepo('fixture-silas-rebrief-incomplete');
    cleanupRepos.push(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'incomplete-rebrief-job', repo_path: repo.path, title: 'stuck lane', briefing: 'the original contract',
      }, TOKEN);
      // Let the initial briefing turn settle before the re-brief (same shape
      // as the retirement test above).
      const firstTurnDeadline = Date.now() + 10_000;
      while (h.ledger.latestJobEvent('incomplete-rebrief-job', 'job.delivered') === null && Date.now() < firstTurnDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const pending = call(h.port, 'POST', '/api/silas/rebrief', {
        job_id: 'incomplete-rebrief-job', note: 'fold the rebase',
      }, TOKEN);
      const markerDeadline = Date.now() + 10_000;
      while (h.ledger.listPendingRebriefs({ jobId: 'incomplete-rebrief-job' }).length !== 2 && Date.now() < markerDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(h.ledger.listPendingRebriefs({ jobId: 'incomplete-rebrief-job' })).toHaveLength(2);
      // The job reaches terminal while the turn is gated (owner merged it).
      h.ledger.setJobStatus('incomplete-rebrief-job', 'in-review');
      h.ledger.setJobStatus('incomplete-rebrief-job', 'merged');
      releasePrompt();
      const res = await pending;
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      // The incomplete disposition is in-band and the markers survive for
      // the next pass; nothing claims a recovery or a retirement.
      expect(res.json).toMatchObject({ retirement: { refused: null, skipped_ids: ['stale-generation'] } });
      // The wire must not conflate the disposition with a retirement: on
      // the all-skip path `retired` is absent (examined-vs-retired truth).
      expect(field(res.json, 'retired')).toBeUndefined();
      expect(h.ledger.latestJobEvent('incomplete-rebrief-job', 'silas.rebrief-retired')).toBeNull();
      expect(h.ledger.latestJobEvent('incomplete-rebrief-job', 'silas.rebrief-recovered')).toBeNull();
      expect(h.ledger.listPendingRebriefs({ jobId: 'incomplete-rebrief-job' })).toHaveLength(2);
      // The operator-facing warn line is part of this contract: an all-skip
      // disposition must be visible in the log, not only in the 200 body.
      expect(logs).toContain('warn:silas re-brief retirement incomplete: markers kept for the next pass');
    } finally {
      releasePrompt();
      await h.close();
    }
  });

  it('/api/silas/rebrief surfaces a PARTIAL retirement: retired plus the kept-marker ids', async () => {
    let releasePrompt!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releasePrompt = resolveGate;
    });
    const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
    const h = await boot({
      minionPromptGate: (text) => (text.startsWith('Re-brief —') ? gate : undefined),
      wrapLedger: (ledger) => {
        const view = Object.create(ledger) as LedgerApi;
        Object.defineProperty(view, 'retirePendingRebriefs', {
          value: (input: { jobId: string }) => {
            const rows = ledger.listPendingRebriefs({ jobId: input.jobId });
            // One marker retires; the other's identity drifted (kept).
            return { retired: [rows[0]!], skippedIds: [rows[1]!.id], refused: null };
          },
        });
        return view;
      },
      log: (level, msg, fields) => {
        logs.push({ level, msg, fields });
      },
    });
    const repo = makeFixtureRepo('fixture-silas-rebrief-partial');
    cleanupRepos.push(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'partial-rebrief-job', repo_path: repo.path, title: 'stuck lane', briefing: 'the original contract',
      }, TOKEN);
      const firstTurnDeadline = Date.now() + 10_000;
      while (h.ledger.latestJobEvent('partial-rebrief-job', 'job.delivered') === null && Date.now() < firstTurnDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const pending = call(h.port, 'POST', '/api/silas/rebrief', {
        job_id: 'partial-rebrief-job', note: 'fold the rebase',
      }, TOKEN);
      const markerDeadline = Date.now() + 10_000;
      while (h.ledger.listPendingRebriefs({ jobId: 'partial-rebrief-job' }).length !== 2 && Date.now() < markerDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const markers = h.ledger.listPendingRebriefs({ jobId: 'partial-rebrief-job' });
      expect(markers).toHaveLength(2);
      h.ledger.setJobStatus('partial-rebrief-job', 'in-review');
      h.ledger.setJobStatus('partial-rebrief-job', 'merged');
      releasePrompt();
      const res = await pending;
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      // Partial means BOTH facts on the wire: retired true AND the kept
      // marker ids named — a consumer keying on either alone reads it right.
      expect((res.json as { retired?: unknown }).retired).toBe(true);
      expect((res.json as { retirement?: unknown }).retirement)
        .toEqual({ refused: null, skipped_ids: [markers[1]!.id] });
      const retiredLog = logs.find((line) => line.msg === 'silas re-brief retired: job went terminal before the turn settled');
      expect(retiredLog?.level).toBe('info');
      expect(retiredLog?.fields?.['skipped']).toEqual([markers[1]!.id]);
    } finally {
      releasePrompt();
      await h.close();
    }
  });

  it('/api/silas/rebrief refuses at the admission boundary when the job merges before the marker write', async () => {
    const h = await boot({
      wrapLedger: (ledger) => {
        const view = Object.create(ledger) as LedgerApi;
        Object.defineProperty(view, 'beginPendingRebrief', {
          value: (input: Parameters<LedgerApi['beginPendingRebrief']>[0]) => {
            // The owner merges the lane between the HTTP guard and the
            // marker write: the in-transaction admission boundary must
            // refuse — never write a marker for a terminal lane.
            ledger.setJobStatus(input.jobId, 'in-review');
            ledger.setJobStatus(input.jobId, 'merged');
            return ledger.beginPendingRebrief(input);
          },
        });
        return view;
      },
    });
    try {
      h.ledger.addJob({ id: 'admission-race-job', repo: 'nowhere', title: 't', briefing: 'b' });
      h.ledger.setJobStatus('admission-race-job', 'working');
      const res = await call(h.port, 'POST', '/api/silas/rebrief', {
        job_id: 'admission-race-job', note: 'n',
      }, TOKEN);
      // The named in-transaction refusal maps to the caller-visible 400 the
      // spec's admission-race edge row promises.
      expect(res.status, JSON.stringify(res.json)).toBe(400);
      expect(field<string>(res.json, 'error')).toBe('bad_request');
      expect(field<string>(res.json, 'detail')).toMatch(/terminal lanes are never re-briefed/u);
      // No marker row was written and no worker was spawned.
      expect(h.ledger.listPendingRebriefs({ jobId: 'admission-race-job' })).toHaveLength(0);
      expect(h.spawns.filter((spawn) => spawn.role === 'minion')).toHaveLength(0);
      expect(h.ledger.getJob('admission-race-job')?.status).toBe('merged');
    } finally {
      await h.close();
    }
  });

  it('overlapping ordinary re-brief HTTP turns settle only the newest marker generation', async () => {
    let releaseOld!: () => void;
    let releaseNew!: () => void;
    let enteredOld!: () => void;
    let enteredNew!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    const newGate = new Promise<void>((resolve) => { releaseNew = resolve; });
    const oldStarted = new Promise<void>((resolve) => { enteredOld = resolve; });
    const newStarted = new Promise<void>((resolve) => { enteredNew = resolve; });
    let turns = 0;
    const h = await boot({ minionPromptGate: (text) => {
      if (!text.startsWith('Re-brief —')) return undefined;
      turns += 1;
      if (turns === 1) { enteredOld(); return oldGate; }
      enteredNew();
      return newGate;
    } });
    const repo = makeFixtureRepo('fixture-ordinary-rebrief-overlap');
    cleanupRepos.push(repo);
    const jobId = 'ordinary-overlap';
    try {
      await call(h.port, 'POST', '/api/dispatch', { job_id: jobId, repo_path: repo.path,
        title: 'overlapping turns', briefing: 'the original contract' }, TOKEN);
      const initialDeadline = Date.now() + 10_000;
      while (h.ledger.latestJobEvent(jobId, 'job.delivered') === null && Date.now() < initialDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).not.toBeNull();
      const oldTurn = call(h.port, 'POST', '/api/silas/rebrief', { job_id: jobId, note: 'same note' }, TOKEN);
      await oldStarted;
      const oldIds = h.ledger.listPendingRebriefs({ jobId }).map((marker) => marker.id);
      expect(oldIds).toHaveLength(2);
      const newTurn = call(h.port, 'POST', '/api/silas/rebrief', { job_id: jobId, note: 'same note' }, TOKEN);
      await newStarted;
      const newIds = h.ledger.listPendingRebriefs({ jobId }).map((marker) => marker.id);
      expect(newIds).toHaveLength(2);
      expect(newIds).not.toEqual(oldIds);
      releaseOld();
      const stale = await oldTurn;
      expect(stale.status).toBe(200);
      expect(field<string | null>(stale.json, 'delivered_sha')).toBeNull();
      expect(h.ledger.listPendingRebriefs({ jobId }).map((marker) => marker.id)).toEqual(newIds);
      expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).toBeNull();
      expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-settled')).toBeNull();
      releaseNew();
      expect((await newTurn).status).toBe(200);
      expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
      expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-settled')).not.toBeNull();
    } finally { releaseOld(); releaseNew(); await h.close(); }
  });

  it('/api/silas/directive on a lane with no reachable minion records a durable no-effect FAILURE; terminal jobs refuse', async () => {
    const h = await boot();
    const repo = makeFixtureRepo('fixture-silas-undelivered');
    cleanupRepos.push(repo);
    try {
      // a job row with no lane at all: accepted durably, then the turn has a
      // POSITIVE no-effect proof (no live minion, no lane) → failed, honestly.
      h.ledger.addJob({ id: 'ghost-job', repo: 'nowhere', title: 't', briefing: 'b' });
      const res = await call(h.port, 'POST', '/api/silas/directive', {
        job_id: 'ghost-job', directive: 'fix it',
      }, TOKEN);
      expect(res.status).toBe(202);
      const requestId = field<string>(res.json, 'request_id');
      const terminal = await awaitDirectiveTerminal(h, requestId);
      expect(terminal.state).toBe('failed');
      expect(terminal.failReason).toContain('no implementing minion session and no job lane');
      expect(h.ledger.latestJobEvent('ghost-job', 'silas.directive-failed')).not.toBeNull();
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
      expect(noop.status).toBe(202);
      const noopRequest = field<string>(noop.json, 'request_id');
      expect((await awaitDirectiveTerminal(h, noopRequest)).state).toBe('settled');
      const noopDelivered = h.ledger
        .listJobEvents('fresh-noop')
        .find((candidate) => candidate.kind === 'job.delivered');
      expect((noopDelivered?.payload as { sha?: string }).sha).toBe(noopHead);
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
      expect(moved.status).toBe(202);
      const movedRequest = field<string>(moved.json, 'request_id');
      expect((await awaitDirectiveTerminal(h, movedRequest)).state).toBe('settled');
      const movedDelivered = h.ledger
        .listJobEvents('fresh-moved')
        .find((candidate) => candidate.kind === 'job.delivered');
      const movedSha = (movedDelivered?.payload as { sha?: string }).sha as string;
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
      expect(res.status).toBe(202);
      const requestId = field<string>(res.json, 'request_id');
      expect((await awaitDirectiveTerminal(h, requestId)).state).toBe('settled');
      const fresh = h.spawns[spawnsBefore];
      expect(fresh?.role).toBe('minion');
      expect(fresh?.options.cwd).toBe(lane?.path);
      expect(h.ledger.getDirective(requestId)?.admissionMinion).toBe(`agent-${h.spawns.length}`);
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
      // The lane's bound minion is the existing agentId binding the row
      // carries (tracked-review A4): validated job + actual identity.
      h.ledger.registerAgent({ id: 'esc-minion', role: 'minion', jobId: 'esc-job' });
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
      expect(notification?.agentId).toBe('esc-minion');
      // A job-less escalation stays unbound (never guessed).
      const noJob = await call(h.port, 'POST', '/api/silas/escalate', { title: 'no lane' }, TOKEN);
      expect(noJob.status).toBe(200);
      const noJobNotification = h.ledger
        .listNotifications()
        .find((row) => row.id === field<string>(noJob.json, 'notification_id'));
      expect(noJobNotification?.agentId).toBeNull();
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

describe('provider pacing worker-gate pass-through on the silas routes (r4 verification#2)', () => {
  it('/api/silas/directive queues at the cap and is admitted on release', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const h = await boot({ workerGate: gate });
    const repo = makeFixtureRepo('fixture-silas-gate-directive');
    cleanupRepos.push(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'gate-dir', repo_path: repo.path, title: 'gate lane', briefing: 'b',
      }, TOKEN);
      // The dispatch turn released its own slot once it settled.
      await vi.waitFor(() => expect(gate.view().worker.running).toBe(0));
      const minionId = `agent-${h.spawns.length}`;
      h.ledger.registerAgent({ id: minionId, role: 'minion', jobId: 'gate-dir' });
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
      h.ledger.setJobStatus('gate-dir', 'in-review');

      const holder = await gate.acquireWorkerTurn({ id: 'holder', label: 'other lane' });
      const pending = call(h.port, 'POST', '/api/silas/directive', {
        job_id: 'gate-dir', directive: 'Fix under the cap.',
      }, TOKEN);
      await vi.waitFor(() => expect(gate.view().worker.queued).toHaveLength(1));
      expect(gate.view().worker.queued[0]?.id).toBe('gate-dir');
      // Queued means NOT delivered: no directive event while the slot is held.
      expect(h.ledger.listJobEvents('gate-dir').some((event) => event.kind === 'silas.directive-sent')).toBe(false);
      holder.release();
      const res = await pending;
      // Accepted ≠ admitted (PR136 durable-intent contract): the 202 is the
      // durable acceptance; the queued turn is admitted on release and its
      // correlated events land on the request record / lane.
      expect(res.status).toBe(202);
      expect(field<string>(res.json, 'job_id')).toBe('gate-dir');
      const gateRequestId = field<string>(res.json, 'request_id');
      const admitDeadline = Date.now() + 10_000;
      while (h.ledger.getDirective(gateRequestId)?.state !== 'settled' && Date.now() < admitDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(h.ledger.getDirective(gateRequestId)?.state).toBe('settled');
      expect(h.ledger.listJobEvents('gate-dir').some((event) => event.kind === 'silas.directive-sent')).toBe(true);
      expect(gate.view().worker).toMatchObject({ running: 0, queued: [] });
    } finally {
      await h.close();
    }
  });

  it('/api/silas/rebrief queues at the cap and is admitted on release', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const h = await boot({ workerGate: gate });
    const repo = makeFixtureRepo('fixture-silas-gate-rebrief');
    cleanupRepos.push(repo);
    try {
      await call(h.port, 'POST', '/api/dispatch', {
        job_id: 'gate-reb', repo_path: repo.path, title: 'gate lane', briefing: 'b',
      }, TOKEN);
      await vi.waitFor(() => expect(gate.view().worker.running).toBe(0));

      const holder = await gate.acquireWorkerTurn({ id: 'holder', label: 'other lane' });
      const pending = call(h.port, 'POST', '/api/silas/rebrief', {
        job_id: 'gate-reb', note: 'try again under the cap',
      }, TOKEN);
      await vi.waitFor(() => expect(gate.view().worker.queued).toHaveLength(1));
      expect(gate.view().worker.queued[0]?.id).toBe('gate-reb');
      holder.release();
      const res = await pending;
      expect(res.status).toBe(200);
      expect(field<string>(res.json, 'job_id')).toBe('gate-reb');
      expect(h.ledger.listJobEvents('gate-reb').some((event) => event.kind === 'silas.rebrief')).toBe(true);
      expect(gate.view().worker).toMatchObject({ running: 0, queued: [] });
    } finally {
      await h.close();
    }
  });
});
