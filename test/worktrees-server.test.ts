import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { loadConfig } from '../src/config.js';
import { WorktreeManager } from '../src/worktrees/manager.js';
import { createWorktreeServer } from '../src/worktrees/server.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * Worktree lane endpoints (Perkins r4): the release/answer path over
 * HTTP, with the DEFAULT enumerator and real processes — including the
 * pinned paused payload for the ROUND arm (r4 B2): a human acknowledges
 * against the pid list, so the list and the ask are the contract.
 */

const TOKEN = 'worktree-lane-token';

const cleanupDirs: string[] = [];
const cleanupRepos: FixtureRepo[] = [];
afterEach(() => {
  while (cleanupRepos.length > 0) cleanupRepos.pop()!.cleanup();
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

interface LaneHarness {
  port: number;
  ledger: LedgerApi;
  manager: WorktreeManager;
  close: () => Promise<void>;
}

async function bootLane(): Promise<LaneHarness> {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-wtserver-'));
  cleanupDirs.push(dir);
  writeFileSync(
    join(dir, 'config.toml'),
    `[auth]\ntoken = "${TOKEN}"\n[server]\nhost = "127.0.0.1"\nport = 0\n`,
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
  });
  const server = createWorktreeServer({ config: cfg, manager });
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
    manager,
    close: async () => {
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
      db.close();
    },
  };
}

async function call(
  port: number,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed: unknown = await res.json().catch(() => null);
  return { status: res.status, json: parsed as Record<string, unknown> | null };
}

function field<T>(json: unknown, key: string): T {
  if (typeof json !== 'object' || json === null) throw new Error(`no json for field ${key}`);
  return (json as Record<string, unknown>)[key] as T;
}

describe('worktree lane release endpoint (r4)', () => {
  it('unauthenticated access is rejected like every product surface', async () => {
    const h = await bootLane();
    try {
      expect((await call(h.port, '/api/dispatch/release', { job_id: 'x' })).status).toBe(401);
      expect((await call(h.port, '/api/dispatch/release', { job_id: 'x' }, 'wrong')).status).toBe(401);
    } finally {
      await h.close();
    }
  });

  it('unknown lanes are honest 404s; a swept lane is not re-releasable', async () => {
    const h = await bootLane();
    const repo = makeFixtureRepo('fixture-wt-404');
    cleanupRepos.push(repo);
    try {
      h.ledger.addJob({ id: 'job-404', repo: 'fixture-wt-404', title: 'x' });
      h.ledger.setJobStatus('job-404', 'working');
      await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-404' });
      const missing = await call(h.port, '/api/dispatch/release', { round_id: 'no-such' }, TOKEN);
      expect(missing.status).toBe(404);
      const gone = await call(h.port, '/api/dispatch/release', { job_id: 'no-such-job' }, TOKEN);
      expect(gone.status).toBe(404);
      const done = await call(h.port, '/api/dispatch/release', { job_id: 'job-404' }, TOKEN);
      expect(done.status).toBe(200);
      expect(field<string>(done.json, 'status')).toBe('swept');
      const again = await call(h.port, '/api/dispatch/release', { job_id: 'job-404' }, TOKEN);
      expect(again.status).toBe(404);
    } finally {
      await h.close();
    }
  });

  it('ROUND ARM: the paused payload carries the pid list and the ask — pinned', async () => {
    const h = await bootLane();
    const repo = makeFixtureRepo('fixture-round-arm');
    cleanupRepos.push(repo);
    try {
      // A round lane: job + round row + detached review worktree.
      h.ledger.addJob({ id: 'job-rarm', repo: 'fixture-round-arm', title: 'x' });
      h.ledger.setJobStatus('job-rarm', 'working');
      await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-rarm' });
      h.ledger.addRound({ jobId: 'job-rarm', targetRef: 'gru/job-rarm' });
      const review = await h.manager.createReviewWorktree({
        repoPath: repo.path,
        roundId: 'job-rarm-r1',
        ref: 'gru/job-rarm',
        jobId: 'job-rarm',
      });

      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
        cwd: review.path,
        stdio: 'ignore',
      });
      try {
        await vi.waitFor(
          () => {
            expect(h.manager.release === h.manager.release).toBe(true); // warm
            const lane = h.ledger.getWorktree('job-rarm-r1');
            expect(lane?.status).toBe('active');
          },
          { timeout: 2_000 },
        );
        // The ask (no confirm_kill): the payload IS the acknowledgment surface.
        const paused = await call(
          h.port,
          '/api/dispatch/release',
          { round_id: 'job-rarm-r1' },
          TOKEN,
        );
        expect(paused.status).toBe(200);
        expect(field<string>(paused.json, 'status')).toBe('paused');
        const processes = field<{ pid: number; command: string; evidence: string }[]>(
          paused.json,
          'processes',
        );
        expect(processes.length).toBe(1);
        expect(processes[0]?.pid).toBe(child.pid);
        expect(processes[0]?.command).toMatch(/node/);
        expect(processes[0]?.evidence).toBe('cwd');
        expect(field<string>(paused.json, 'note')).toMatch(/acknowledge to proceed/);
        expect(existsSync(review.path)).toBe(true); // pause touches nothing

        // The answer (confirm_kill) completes the round lane.
        const answered = await call(
          h.port,
          '/api/dispatch/release',
          { round_id: 'job-rarm-r1', confirm_kill: true },
          TOKEN,
        );
        expect(answered.status).toBe(200);
        expect(field<string>(answered.json, 'status')).toBe('swept');
        expect(existsSync(review.path)).toBe(false);
        expect(child.kill(0)).toBe(false);
      } finally {
        try {
          child.kill('SIGKILL');
        } catch {
          /* reaped */
        }
      }
    } finally {
      await h.close();
    }
  });
});
