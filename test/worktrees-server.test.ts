import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { loadConfig } from '../src/config.js';
import { WorktreeManager, type WorktreeManagerOptions } from '../src/worktrees/manager.js';
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
  /** What the endpoint logged. */
  logs: { level: string; msg: string; fields: Record<string, unknown> }[];
  close: () => Promise<void>;
}

async function bootLane(extra: Partial<WorktreeManagerOptions> = {}): Promise<LaneHarness> {
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
    ...extra,
  });
  const logs: LaneHarness['logs'] = [];
  const server = createWorktreeServer({ config: cfg, manager, ledger, log: (level, msg, fields) => logs.push({ level, msg, fields: fields ?? {} }) });
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
    logs,
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
      // The same receipt path serves a binned (discarded) lane: the
      // digest's new releaseEligible rows are actionable, never refused.
      h.ledger.addJob({ id: 'job-binned-ack', repo: 'fixture-sweep-ack', title: 'x' });
      h.ledger.setJobStatus('job-binned-ack', 'working');
      h.ledger.setJobStatus('job-binned-ack', 'binned');
      await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-binned-ack' });
      const binnedRelease = await call(h.port, '/api/dispatch/release', {
        job_id: 'job-binned-ack', by: 'silas', rule_id: 'sweep-ack',
      }, TOKEN);
      expect(binnedRelease.status).toBe(200);
      expect(h.manager.getWorktree('job-binned-ack')?.status).toBe('swept');
      const binnedReceipts = h.ledger.listJobEvents('job-binned-ack').filter((event) => event.kind === 'silas.lane-released');
      expect(binnedReceipts).toHaveLength(1);
      expect(binnedReceipts[0]?.payload).toMatchObject({ rule_id: 'sweep-ack', by: 'silas' });
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

  it('a silas release enforces the sweep-ack firing condition: terminal job, un-swept lane, no confirm_kill', async () => {
    const h = await bootLane();
    const repo = makeFixtureRepo('fixture-sweep-ack-guard');
    cleanupRepos.push(repo);
    try {
      // A non-terminal job holding a lane: refused, lane untouched.
      h.ledger.addJob({ id: 'job-live', repo: 'fixture-sweep-ack-guard', title: 'x' });
      h.ledger.setJobStatus('job-live', 'working');
      await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-live' });
      const notTerminal = await call(h.port, '/api/dispatch/release', {
        job_id: 'job-live', by: 'silas', rule_id: 'sweep-ack',
      }, TOKEN);
      expect(notTerminal.status).toBe(409);
      expect(field<string>(notTerminal.json, 'error')).toBe('job_not_terminal');
      expect(h.manager.getWorktree('job-live')?.status).toBe('active');
      expect(h.ledger.listJobEvents('job-live').filter((event) => event.kind === 'silas.lane-released')).toHaveLength(0);
      // confirm_kill is a human-only acknowledgment: a silas release
      // carrying it refuses before anything is paused or killed.
      const killed = await call(h.port, '/api/dispatch/release', {
        job_id: 'job-live', by: 'silas', rule_id: 'sweep-ack', confirm_kill: true,
      }, TOKEN);
      expect(killed.status).toBe(400);
      expect(JSON.stringify(killed.json)).toContain('human decision');
      expect(h.manager.getWorktree('job-live')?.status).toBe('active');
      // Terminal, released once: a re-release refuses — no duplicate receipt.
      h.ledger.setJobStatus('job-live', 'in-review');
      h.ledger.setJobStatus('job-live', 'merged');
      const released = await call(h.port, '/api/dispatch/release', {
        job_id: 'job-live', by: 'silas', rule_id: 'sweep-ack',
      }, TOKEN);
      expect(released.status).toBe(200);
      const again = await call(h.port, '/api/dispatch/release', {
        worktree_id: 'job-live', by: 'silas', rule_id: 'sweep-ack',
      }, TOKEN);
      expect(again.status).toBe(409);
      expect(field<string>(again.json, 'error')).toBe('already_swept');
      const receipts = h.ledger.listJobEvents('job-live').filter((event) => event.kind === 'silas.lane-released');
      expect(receipts).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('discard_submodule_work reaches the release (#427): without it a lane whose submodule holds an unpushed commit is refused by name with the digest, a discard without that digest is refused, a silas release cannot carry it, and an operator release with the digest sweeps, audited', async () => {
    const h = await bootLane();
    const repo = makeFixtureRepo('fixture-wt-submodule');
    cleanupRepos.push(repo);
    const sub = mkdtempSync(join(tmpdir(), 'gru-command-wtserver-sub-'));
    cleanupDirs.push(sub);
    const git = (cwd: string, args: readonly string[]): string => execFileSync('git', [
      '-c', 'user.name=Server Tests', '-c', 'user.email=server@example.invalid', '-c', 'protocol.file.allow=always', ...args,
    ], { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    try {
      git(sub, ['init', '-q', '-b', 'main']);
      writeFileSync(join(sub, 'lib.txt'), 'library\n');
      git(sub, ['add', '.']);
      git(sub, ['commit', '-qm', 'library']);
      git(repo.path, ['submodule', 'add', '-q', sub, 'deps/lib']);
      git(repo.path, ['commit', '-qm', 'add the library']);
      h.ledger.addJob({ id: 'job-sub', repo: 'fixture-wt-submodule', title: 'x' });
      h.ledger.setJobStatus('job-sub', 'working');
      const lane = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-sub' });
      git(lane.path, ['submodule', 'update', '--init', '-q']);
      git(join(lane.path, 'deps', 'lib'), ['commit', '-q', '--allow-empty', '-m', 'unpushed work']);

      const refused = await call(h.port, '/api/dispatch/release', { job_id: 'job-sub' }, TOKEN);
      expect(refused.status).toBe(400);
      expect(field<string>(refused.json, 'detail')).toMatch(/deps\/lib: commit [0-9a-f]{40} \(its HEAD\) is on no remote-tracking ref.*discard_submodule_work/u);
      const digest = field<string>(refused.json, 'digest');
      expect(digest).toMatch(/^[0-9a-f]{16}$/u);
      expect(field<string>(refused.json, 'detail')).toContain(`discard_submodule_work: "${digest}"`);
      const blanket = await call(h.port, '/api/dispatch/release', { job_id: 'job-sub', discard_submodule_work: true }, TOKEN);
      expect(blanket.status).toBe(400);
      expect(field<string>(blanket.json, 'detail')).toContain('carries the digest a submodule refusal named');
      const silas = await call(h.port, '/api/dispatch/release', {
        job_id: 'job-sub', by: 'silas', rule_id: 'sweep-ack', discard_submodule_work: digest,
      }, TOKEN);
      expect(silas.status).toBe(400);
      expect(field<string>(silas.json, 'detail')).toContain('operator decision');
      expect(h.manager.getWorktree('job-sub')?.status).toBe('active');

      const swept = await call(h.port, '/api/dispatch/release', { job_id: 'job-sub', discard_submodule_work: digest }, TOKEN);
      expect(swept.status).toBe(200);
      expect(field<string>(swept.json, 'status')).toBe('swept');
      expect(existsSync(lane.path)).toBe(false);
      expect(h.ledger.listJobEvents('job-sub').filter((event) => event.kind === 'worktree.submodule-work-discarded')).toHaveLength(1);
    } finally {
      await h.close();
    }
  }, 90_000);

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

  it('a silas sweep-ack release completes beside sibling lanes and folders that are not the lane itself, and records its receipt', async () => {
    const h = await bootLane();
    const repo = makeFixtureRepo('fixture-sweep-ack-beside');
    cleanupRepos.push(repo);
    try {
      h.ledger.addJob({ id: 'job-ack-beside', repo: 'fixture-sweep-ack-beside', title: 'x' });
      h.ledger.addJob({ id: 'job-ack-sibling', repo: 'fixture-sweep-ack-beside', title: 'y' });
      for (const id of ['job-ack-beside', 'job-ack-sibling']) h.ledger.setJobStatus(id, 'working');
      h.ledger.setJobStatus('job-ack-beside', 'in-review');
      h.ledger.setJobStatus('job-ack-beside', 'merged');
      await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-ack-beside' });
      const sibling = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-ack-sibling' });
      // What the repository holds beside the lane: a desktop tool's worktree folder that never held a gitdir, and a stale one.
      const inventory = join(repo.path, '.git', 'worktrees');
      for (const name of ['desktop-folder', 'stale-folder']) mkdirSync(join(inventory, name), { recursive: true });
      writeFileSync(join(inventory, 'desktop-folder', 'desktop-worktree-marker'), '');
      writeFileSync(join(inventory, 'stale-folder', 'gitdir'), 'not-a-checkout\n');
      const released = await call(h.port, '/api/dispatch/release', { job_id: 'job-ack-beside', by: 'silas', rule_id: 'sweep-ack' }, TOKEN);
      expect(released.status).toBe(200);
      expect(field<string>(released.json, 'status')).toBe('swept');
      expect(h.manager.getWorktree('job-ack-beside')?.status).toBe('swept');
      expect(h.manager.getWorktree(sibling.id)?.status).toBe('active');
      expect(h.ledger.listJobEvents('job-ack-beside').filter((event) => event.kind === 'silas.lane-released')).toHaveLength(1);
      expect(h.ledger.listJobEvents('job-ack-beside').filter((event) => event.kind === 'worktree.swept')).toHaveLength(1);
      expect(existsSync(join(inventory, 'desktop-folder'))).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('a release whose removal left its own resources answers 409 naming them, a custody refusal answers 400, and each logs the lane and the check that fired', async () => {
    let race: string | null = null;
    const h = await bootLane({
      // The release's tail resolves the base once the checkout is gone: the path re-created then is residue.
      log: (_level, message) => {
        if (race !== null && message.startsWith('base resolution degraded') && !existsSync(race)) {
          const path = race;
          race = null;
          mkdirSync(path, { recursive: true });
        }
      },
    });
    const repo = makeFixtureRepo('fixture-release-refusals');
    cleanupRepos.push(repo);
    try {
      h.ledger.addJob({ id: 'job-residue', repo: 'fixture-release-refusals', title: 'residue' });
      h.ledger.addJob({ id: 'job-custody', repo: 'fixture-release-refusals', title: 'custody' });
      const residue = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-residue' });
      const custody = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-custody' });

      race = residue.path;
      const answered = await call(h.port, '/api/dispatch/release', { worktree_id: residue.id }, TOKEN);
      expect(answered.status).toBe(409);
      expect(answered.json).toMatchObject({ error: 'lane_residue', residue: [residue.path] });
      expect(field<string>(answered.json, 'detail')).toContain(residue.path);
      expect(h.ledger.getWorktree(residue.id)?.status).toBe('active');
      const refusedResidue = h.logs.find((entry) => entry.msg === 'worktree release handler failed' && entry.fields['worktree_id'] === residue.id);
      expect(refusedResidue?.fields).toMatchObject({ check: 'LaneResidueError', residue: [residue.path] });

      // A custody conflict before any removal is still the 400 it was, and the lane is untouched.
      const receipt = join(execFileSync('git', ['-C', custody.path, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf-8' }).trim(), 'gru-creation-handoff.json');
      writeFileSync(receipt, JSON.stringify({ ...(JSON.parse(readFileSync(receipt, 'utf-8')) as Record<string, unknown>), state: 'pending', createdAt: null }));
      const refused = await call(h.port, '/api/dispatch/release', { worktree_id: custody.id }, TOKEN);
      expect(refused.status).toBe(400);
      expect(refused.json).toMatchObject({ error: 'bad_request' });
      expect(existsSync(custody.path)).toBe(true);
      const refusedCustody = h.logs.find((entry) => entry.msg === 'worktree release handler failed' && entry.fields['worktree_id'] === custody.id);
      expect(refusedCustody?.fields).toMatchObject({ check: 'WorktreeHandoffUnresolvedError' });
      expect((refusedCustody?.fields['reasons'] as readonly string[]).join(' <- ')).toContain('completed handoff proof is missing or changed');
    } finally {
      await h.close();
    }
  });

  it('a retry while the residue of an earlier release still stands answers the same 409 naming it, and the release finishes once it is cleared', async () => {
    let race: { readonly path: string; readonly admin: string } | null = null;
    const h = await bootLane({
      // The release's tail resolves the base once the checkout is gone: a folder that names the checkout, back then, is residue.
      log: (_level, message) => {
        if (race !== null && message.startsWith('base resolution degraded') && !existsSync(race.path)) {
          const { path, admin } = race;
          race = null;
          mkdirSync(admin, { recursive: true });
          writeFileSync(join(admin, 'gitdir'), `${join(realpathSync(dirname(path)), basename(path), '.git')}\n`);
        }
      },
    });
    const repo = makeFixtureRepo('fixture-release-retry-residue');
    cleanupRepos.push(repo);
    try {
      h.ledger.addJob({ id: 'job-retry-residue', repo: 'fixture-release-retry-residue', title: 'residue retry' });
      const lane = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-retry-residue' });
      const admin = execFileSync('git', ['-C', lane.path, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf-8' }).trim();
      race = { path: lane.path, admin };
      const first = await call(h.port, '/api/dispatch/release', { worktree_id: lane.id }, TOKEN);
      expect(first.status).toBe(409);
      expect(first.json).toMatchObject({ error: 'lane_residue', residue: [admin] });
      // The same request while the residue stands: the same answer, not a bad request without the paths.
      const retry = await call(h.port, '/api/dispatch/release', { worktree_id: lane.id }, TOKEN);
      expect(retry.status).toBe(409);
      expect(retry.json).toMatchObject({ error: 'lane_residue', residue: [admin] });
      expect(field<string>(retry.json, 'detail')).toContain(admin);
      expect(h.ledger.getWorktree(lane.id)?.status).toBe('active');
      expect(existsSync(admin)).toBe(true);
      const refusals = h.logs.filter((entry) => entry.msg === 'worktree release handler failed' && entry.fields['worktree_id'] === lane.id);
      expect(refusals).toHaveLength(2);
      for (const refusal of refusals) expect(refusal.fields).toMatchObject({ check: 'LaneResidueError', residue: [admin] });
      // One record of the refusal: the retry touched nothing and wrote nothing.
      expect(h.ledger.listEvents({ limit: 1000 }).filter((event) => event.kind === 'worktree.sweep-tail-failed')).toHaveLength(1);
      rmSync(admin, { recursive: true, force: true });
      const finished = await call(h.port, '/api/dispatch/release', { worktree_id: lane.id }, TOKEN);
      expect(finished.status).toBe(200);
      expect(field<string>(finished.json, 'status')).toBe('swept');
      expect(h.ledger.getWorktree(lane.id)?.status).toBe('swept');
    } finally {
      await h.close();
    }
  });

  it('a swept lane answers 400 when its own resources stand at the start and 200, still swept, when they turn up after its branch step', async () => {
    let armed: { readonly repo: string; readonly branch: string; readonly path: string } | null = null;
    const warnings: { readonly message: string; readonly fields: unknown }[] = [];
    const branchesOf = (repo: string, branch: string): string => execFileSync('git', ['-C', repo, 'branch', '--list', branch], { encoding: 'utf-8' }).trim();
    const h = await bootLane({
      log: (level, message, fields) => {
        if (level === 'warn') warnings.push({ message, fields });
        // The fresh head is resolved after the branch step; the lane's path comes back then.
        if (armed !== null && message.startsWith('base resolution degraded') && branchesOf(armed.repo, armed.branch) === '' && !existsSync(armed.path)) {
          const { path } = armed;
          armed = null;
          mkdirSync(path, { recursive: true });
        }
      },
    });
    const repo = makeFixtureRepo('fixture-swept-answers');
    cleanupRepos.push(repo);
    try {
      h.ledger.addJob({ id: 'job-swept-answers', repo: 'fixture-swept-answers', title: 'swept' });
      const lane = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-swept-answers' });
      const branch = lane.branch ?? '';
      expect((await call(h.port, '/api/dispatch/release', { worktree_id: lane.id }, TOKEN)).status).toBe(200);
      // A swept row with a surviving branch, and the lane's path back at the start: the refusal before removal. Nothing is deleted.
      execFileSync('git', ['-C', repo.path, 'branch', branch, 'HEAD']);
      mkdirSync(lane.path, { recursive: true });
      const entry = await call(h.port, '/api/dispatch/release', { worktree_id: lane.id }, TOKEN);
      expect(entry.status).toBe(400);
      expect(entry.json).toMatchObject({ error: 'bad_request' });
      expect(branchesOf(repo.path, branch)).not.toBe('');
      rmSync(lane.path, { recursive: true, force: true });
      // The path comes back only after the branch step: the row stays swept and the answer is the swept one, with a warning naming it.
      armed = { repo: repo.path, branch, path: lane.path };
      warnings.length = 0;
      const late = await call(h.port, '/api/dispatch/release', { worktree_id: lane.id }, TOKEN);
      expect(late.status).toBe(200);
      expect(field<string>(late.json, 'status')).toBe('swept');
      expect(existsSync(lane.path)).toBe(true);
      expect(branchesOf(repo.path, branch)).toBe('');
      expect(h.ledger.getWorktree(lane.id)?.status).toBe('swept');
      expect(warnings.some((warning) => warning.message.includes('a swept lane\'s own resources stand after its branch step') && JSON.stringify(warning.fields).includes(lane.path))).toBe(true);
      expect(h.ledger.listEvents({ limit: 1000 }).filter((event) => event.kind === 'worktree.sweep-tail-failed')).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('names the lane in the log of a release that fails before the manager is asked to release it', async () => {
    const h = await bootLane();
    const repo = makeFixtureRepo('fixture-release-log-lane');
    cleanupRepos.push(repo);
    try {
      h.ledger.addJob({ id: 'job-log-lane', repo: 'fixture-release-log-lane', title: 'log lane' });
      const lane = await h.manager.createJobWorktree({ repoPath: repo.path, jobId: 'job-log-lane' });
      const failing = vi.spyOn(h.ledger, 'unfinishedChildWorkersOf').mockImplementationOnce(() => { throw new Error('the ledger is down'); });
      const answered = await call(h.port, '/api/dispatch/release', { worktree_id: lane.id }, TOKEN);
      failing.mockRestore();
      expect(answered.status).toBe(400);
      const logged = h.logs.find((entry) => entry.msg === 'worktree release handler failed');
      expect(logged?.fields).toMatchObject({ worktree_id: lane.id, check: 'Error' });
      expect(h.ledger.getWorktree(lane.id)?.status).toBe('active');
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
