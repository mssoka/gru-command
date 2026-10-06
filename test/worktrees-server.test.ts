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
  const server = createWorktreeServer({ config: cfg, manager, ledger });
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

  it('job release refuses while a child is live and never sweeps a child lane in the job’s place', async () => {
    const h = await bootLane();
    const repo = makeFixtureRepo('fixture-child-release');
    cleanupRepos.push(repo);
    try {
      h.ledger.addJob({ id: 'job-c', repo: 'fixture-child-release', title: 'x' });
      h.ledger.setJobStatus('job-c', 'working');
      h.ledger.registerAgent({ id: 'parent-c', role: 'minion', jobId: 'job-c', parentage: 'top-level' });
      const jobLane = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-c' });
      h.ledger.admitChildWorker({
        id: 'child-c1',
        parentAgentId: 'parent-c',
        jobId: 'job-c',
        purpose: 'release guard',
        authority: 'read-only',
        task: 't',
        idempotencyKey: 'k-release',
      });
      const childLane = await h.manager.createChildWorktree({
        repoPath: repo.path,
        jobId: 'job-c',
        childId: 'child-c1',
        parentPath: jobLane.path,
        authority: 'read-only',
      });
      expect(childLane.kind).toBe('child');
      // A live child keeps the job release refused with a named reason.
      const refused = await call(h.port, '/api/dispatch/release', { job_id: 'job-c' }, TOKEN);
      expect(refused.status).toBe(409);
      expect(field<string>(refused.json, 'error')).toBe('active_child_workers');
      expect(field<readonly string[]>(refused.json, 'child_ids')).toEqual(['child-c1']);
      // Once terminal, the job release sweeps the JOB lane only.
      h.ledger.recordChildResult('child-c1', { state: 'done', summary: 'ok', ref: null });
      const released = await call(h.port, '/api/dispatch/release', { job_id: 'job-c' }, TOKEN);
      expect(released.status).toBe(200);
      expect(field<string>(released.json, 'status')).toBe('swept');
      expect(h.manager.getWorktree('job-c')?.status).toBe('swept');
      expect(h.manager.getWorktree('child-c1')?.status).toBe('active'); // untouched
    } finally {
      await h.close();
    }
  });

  it('a silas sweep-ack release records silas.lane-released with the rule on the job (issue #117)', async () => {
    const h = await bootLane();
    const repo = makeFixtureRepo('fixture-sweep-ack');
    cleanupRepos.push(repo);
    try {
      h.ledger.addJob({ id: 'job-ack', repo: 'fixture-sweep-ack', title: 'x' });
      h.ledger.setJobStatus('job-ack', 'working');
      h.ledger.setJobStatus('job-ack', 'in-review');
      h.ledger.setJobStatus('job-ack', 'merged');
      await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-ack' });
      const released = await call(h.port, '/api/dispatch/release', {
        job_id: 'job-ack', by: 'silas', rule_id: 'sweep-ack',
      }, TOKEN);
      expect(released.status).toBe(200);
      expect(field<string>(released.json, 'status')).toBe('swept');
      const receipts = h.ledger.listJobEvents('job-ack').filter((event) => event.kind === 'silas.lane-released');
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.payload).toMatchObject({
        worktree_id: 'job-ack',
        rule_id: 'sweep-ack',
        by: 'silas',
        branch_disposition: 'deleted',
      });
    } finally {
      await h.close();
    }
  });

  it('a plain release records NO silas receipt; a silas release naming any other rule refuses before acting', async () => {
    const h = await bootLane();
    const repo = makeFixtureRepo('fixture-sweep-ack-miss');
    cleanupRepos.push(repo);
    try {
      h.ledger.addJob({ id: 'job-plain', repo: 'fixture-sweep-ack-miss', title: 'x' });
      h.ledger.setJobStatus('job-plain', 'working');
      h.ledger.setJobStatus('job-plain', 'in-review');
      h.ledger.setJobStatus('job-plain', 'done');
      await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-plain' });
      // No by/rule_id: the release is exactly as before — no receipt.
      const plain = await call(h.port, '/api/dispatch/release', { job_id: 'job-plain' }, TOKEN);
      expect(plain.status).toBe(200);
      expect(h.ledger.listJobEvents('job-plain').filter((event) => event.kind === 'silas.lane-released')).toHaveLength(0);

      // silas provenance with a different action rule: refused pre-release.
      h.ledger.addJob({ id: 'job-wrong', repo: 'fixture-sweep-ack-miss', title: 'x' });
      h.ledger.setJobStatus('job-wrong', 'working');
      h.ledger.setJobStatus('job-wrong', 'in-review');
      h.ledger.setJobStatus('job-wrong', 'merged');
      await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-wrong' });
      const wrongRule = await call(h.port, '/api/dispatch/release', {
        job_id: 'job-wrong', by: 'silas', rule_id: 'clean-abort-service-restart',
      }, TOKEN);
      expect(wrongRule.status).toBe(400);
      expect(h.manager.getWorktree('job-wrong')?.status).toBe('active');
      // silas provenance with NO rule: refused too.
      const noRule = await call(h.port, '/api/dispatch/release', { job_id: 'job-wrong', by: 'silas' }, TOKEN);
      expect(noRule.status).toBe(400);
      expect(h.manager.getWorktree('job-wrong')?.status).toBe('active');
      expect(h.ledger.listJobEvents('job-wrong').filter((event) => event.kind === 'silas.lane-released')).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('a silas release of a non-job lane refuses before releasing — no job, no receipt, no sweep', async () => {
    const h = await bootLane();
    const repo = makeFixtureRepo('fixture-sweep-ack-raw');
    cleanupRepos.push(repo);
    try {
      const job = h.ledger.addJob({ id: 'job-raw', repo: 'fixture-sweep-ack-raw', title: 'x' });
      h.ledger.setJobStatus('job-raw', 'working');
      const round = h.ledger.addRound({ jobId: job.id, lenses: ['blind'] });
      const roundLane = await h.manager.createReviewWorktree({ repoPath: repo.path, roundId: round.id, ref: 'HEAD', jobId: job.id });
      const refused = await call(h.port, '/api/dispatch/release', {
        worktree_id: roundLane.id, by: 'silas', rule_id: 'sweep-ack',
      }, TOKEN);
      expect(refused.status).toBe(400);
      expect(field<string>(refused.json, 'detail')).toContain('job lane');
      // The lane was NOT released: the rule-hit must be recordable first.
      expect(h.manager.getWorktree(roundLane.id)?.status).toBe('active');
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
    // Co-tenant load headroom: this case boots a lane harness, a fixture
    // repo, a job worktree AND a detached review worktree — real git work
    // that can exceed the 30 s default on the shared host (same class as
    // the real-service boot budget in helpers/real-service.mjs).
  }, 90_000);
});
