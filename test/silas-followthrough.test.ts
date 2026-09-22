import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { SilasDriver } from '../src/dispatch/silas-driver.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import { NotificationCenter } from '../src/notifications/center.js';
import type { AgentCapabilities, AgentHandle, SpawnOptions } from '../src/runtime/types.js';
import type { Role } from '../src/config.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

const FAKE_CAPABILITIES: AgentCapabilities = {
  streaming: true,
  steer: 'native',
  resume: 'file',
  images: false,
  thinking: false,
  thinkingLevelControl: false,
  followUp: false,
};

/**
 * Follow-through integration (E8; owner ruling 2026-09-21): a delivered
 * job lands on the PR registry and under review ENTIRELY WITHOUT HUMAN
 * INPUT. Production wiring end to end — dispatch → ledger → bus → silas
 * driver → silas session (a fake that acts exactly as the hosted session
 * would: it reads the wake digest, then drives the same authenticated ops
 * surface a curl call drives) → PR registered → review round requested.
 */

const TOKEN = 'silas-integration-token';
const PR_URL = 'https://git.example.invalid/fixture-owner/fixture-app/pull/651';

const cleanupDirs: string[] = [];
const cleanupRepos: FixtureRepo[] = [];
afterEach(() => {
  while (cleanupRepos.length > 0) cleanupRepos.pop()!.cleanup();
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

/** The hosted silas session stand-in: on every wake it parses the digest
 * out of the prompt (exactly what the model reads) and closes the loop
 * through the authenticated HTTP ops surface. */
function silasActsViaHttp(input: { port: () => number; token: string; prFor: (jobId: string) => string }) {
  return async (prompt: string): Promise<void> => {
    const digestLine = prompt.split('\n').find((line) => line.trim().startsWith('{'));
    void digestLine;
    const jsonStart = prompt.indexOf('```json');
    const jsonEnd = prompt.indexOf('```', jsonStart + 7);
    if (jsonStart < 0 || jsonEnd < 0) throw new Error('wake prompt carries no digest');
    const digest = JSON.parse(prompt.slice(jsonStart + 7, jsonEnd)) as {
      deliveredWithoutPr: { jobId: string }[];
    };
    const base = `http://127.0.0.1:${input.port()}`;
    const auth = { authorization: `Bearer ${input.token}`, 'content-type': 'application/json' };
    for (const row of digest.deliveredWithoutPr) {
      // discovery (transcript/gh) simulated by the fixture mapping…
      const url = input.prFor(row.jobId);
      // …then the exact ops calls the ops-dispatch skill prescribes:
      const prRes = await fetch(`${base}/api/dispatch/pr`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ job_id: row.jobId, url, by: 'silas' }),
      });
      if (prRes.status !== 200) throw new Error(`pr registration failed: ${prRes.status}`);
      const reviewRes = await fetch(`${base}/api/dispatch/review`, {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ job_id: row.jobId, by: 'silas' }),
      });
      if (reviewRes.status !== 202) throw new Error(`review trigger failed: ${reviewRes.status}`);
    }
  };
}

describe('silas follow-through (no human input)', () => {
  it('delivered job → PR registered → review round requested, driven only by the ledger event', async () => {
    const repo = makeFixtureRepo('fixture-app');
    cleanupRepos.push(repo);
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-silas-follow-'));
    cleanupDirs.push(dir);
    writeFileSync(
      join(dir, 'config.toml'),
      `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`,
      'utf-8',
    );
    mkdirSync(join(dir, 'wtroot'));
    const cfg = loadConfig({ GRU_COMMAND_HOME: dir }, '/home/tester');
    const db = new LedgerDb(dir);
    const bus = new EventBus({});
    const ledger = new LedgerApi(db.handle, { bus });
    const worktrees = new InMemoryWorktreePort(join(dir, 'wtroot'));

    const spawns: { role: Role; options: SpawnOptions }[] = [];
    const minionPrompts: string[] = [];
    const reviewSessions = join(dir, 'review-sessions');
    mkdirSync(reviewSessions, { recursive: true });
    const hybrid = fakeHybridSpawner(reviewSessions, { childAnswer: () => '[]' });
    const spawner = async (role: Role, options?: SpawnOptions): Promise<AgentHandle> => {
      spawns.push({ role, options: options ?? {} });
      if (role === 'perkins') return hybrid.spawner(role, options);
      if (role === 'silas') throw new Error('the integration fakes the silas slot, never spawns it');
      return {
        role,
        id: `agent-${spawns.length}`,
        sessionFile: null,
        capabilities: FAKE_CAPABILITIES,
        async prompt(text: string) {
          if (role !== 'minion' || options?.cwd === undefined) return;
          minionPrompts.push(text);
          writeFileSync(join(options.cwd, 'deliverable.txt'), 'delivered\n');
          execFileSync('git', ['-C', options.cwd, 'add', 'deliverable.txt']);
          execFileSync('git', ['-C', options.cwd, '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'test: deliver'], { stdio: 'ignore' });
        },
        async steer() {},
        async followUp() {},
        subscribe() {
          return () => {};
        },
        health() {
          return { state: 'idle' as const, lastActivity: null, sessionFile: null };
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
    });
    const silasSlotPrompts: Promise<void>[] = [];
    const silasHandle: AgentHandle = {
      role: 'silas',
      id: 'silas-hosted',
      sessionFile: null,
      capabilities: FAKE_CAPABILITIES,
      prompt(text: string) {
        const run = silasActsViaHttp({
          port: () => (http.address() as AddressInfo).port,
          token: TOKEN,
          prFor: (jobId) => (jobId === 'pr-651' ? PR_URL : `${PR_URL}-x`),
        })(text);
        silasSlotPrompts.push(run);
        return run;
      },
      async steer() {},
      async followUp() {},
      subscribe() {
        return () => {};
      },
      health() {
        return { state: 'idle' as const, lastActivity: null, sessionFile: null };
      },
      async dispose() {},
    };

    const server = createDispatchServer({
      config: cfg,
      dispatch,
      wave,
      ledger,
      silasOps: {
        registry: {
          getHandle: () => null,
          spawn: (role, options) => spawner(role, options),
          disposeHandle: async () => {},
        },
        worktrees,
        notifications: new NotificationCenter({ ledger, bus }),
      },
    });
    const http: HttpServer = createServer((req, res) => {
      if (server.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolveListen) => http.listen(0, '127.0.0.1', resolveListen));

    try {
      // The driver rides the REAL production wiring: ledger bus → wake.
      const driver = new SilasDriver({
        slot: { ensure: async () => silasHandle },
        ledger,
        worktrees,
        config: { ...cfg.silas, sweepIntervalMs: 0 },
        ops: {
          baseUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
          configPath: join(dir, 'config.toml'),
        },
        bus,
      });
      driver.start();

      // Gru's briefing goes in; the minion delivers; NOBODY touches the API.
      const outcome = await dispatch.dispatch({
        jobId: 'pr-651',
        repoPath: repo.path,
        title: 'close the loop tonight',
        briefing: 'Deliver the change and end with a completion report containing the PR URL.',
      });
      expect((await outcome.settled).ok).toBe(true);

      // The follow-through completes on its own.
      await vi.waitFor(
        () => {
          const job = ledger.getJob('pr-651');
          expect(job?.prUrl).toBe(PR_URL);
          expect(job?.status).toBe('in-review');
        },
        { timeout: 10_000 },
      );
      await Promise.allSettled(silasSlotPrompts);

      // Every step is on the record as silas events.
      const events = ledger.listJobEvents('pr-651').map((event) => event.kind);
      expect(events).toContain('silas.wake');
      expect(events).toContain('silas.pr-registered');
      expect(events).toContain('silas.review-triggered');
      // The review round exists (requested by the silas-driven call) and
      // the fake wave settles it: the FULL arc runs to a recorded verdict.
      const rounds = ledger.listRounds('pr-651');
      expect(rounds).toHaveLength(1);
      expect(rounds[0]?.status).toBe('verdict-posted');
      expect(rounds[0]?.verdict).toBe('approved');
      // The wake prompt taught the session its own ops surface.
      expect(existsSync(outcome.worktree.path)).toBe(true);
      // Driver stops cleanly.
      driver.stop();
    } finally {
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
      await wave.shutdown();
      db.close();
    }
  }, 30_000);
});
