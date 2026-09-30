import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, type EventRecord, type JobRecord, type JobStatus, type PendingRebriefRecord } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { loadConfig } from '../src/config.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { DispatchService } from '../src/dispatch/service.js';
import { WaveRunner } from '../src/dispatch/perkins.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import type { WorktreeLane, WorktreePort, WorktreeSweepResult } from '../src/dispatch/worktree-port.js';
import { BRANCH_BUSY_HINT, findBusyLanes, laneIsBusy, normalizeBranch } from '../src/dispatch/branch-idle.js';

/**
 * Branch-idle guard (proven 2026-09-23; cost: two wasted review rounds): a
 * review round must not freeze while a lane is actively working/pushing the
 * target branch. The API refuses with 409 branch_busy and names the blocking
 * lanes; `force: true` is the human override, tagged in the manifest and the
 * event log; the freeze re-checks to close the race window; Silas defers its
 * auto-arm and retries when the lane delivers.
 */

const TOKEN = 'branch-idle-test-token';

const cleanupDirs: string[] = [];
const cleanupRepos: FixtureRepo[] = [];
afterEach(() => {
  while (cleanupRepos.length > 0) cleanupRepos.pop()!.cleanup();
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

/** Wraps the in-memory port so a test can inject the freeze-time race:
 * whatever `onReviewLane` does happens after the arm-intake check passed
 * and before the round freezes. */
class HookedWorktreePort implements WorktreePort {
  constructor(
    private readonly delegate: InMemoryWorktreePort,
    private readonly onReviewLane: (() => void) | null,
  ) {}

  createJobWorktree(input: { repoPath: string; jobId: string }): Promise<WorktreeLane> {
    return this.delegate.createJobWorktree(input);
  }

  async createReviewWorktree(input: {
    repoPath: string;
    roundId: string;
    ref: string;
    jobId?: string;
  }): Promise<WorktreeLane> {
    const lane = await this.delegate.createReviewWorktree(input);
    this.onReviewLane?.();
    return lane;
  }

  getWorktree(id: string): WorktreeLane | null {
    return this.delegate.getWorktree(id);
  }

  listWorktrees(opts: { jobId?: string } = {}): readonly WorktreeLane[] {
    return this.delegate.listWorktrees(opts);
  }

  release(input: { worktreeId: string }): Promise<WorktreeSweepResult> {
    return this.delegate.release(input);
  }
}

interface Harness {
  readonly port: number;
  readonly ledger: LedgerApi;
  readonly worktrees: InMemoryWorktreePort;
  readonly wave: WaveRunner;
  readonly artifactRoot: string;
  close(): Promise<void>;
}

async function boot(opts: { onReviewLane?: () => void; onPreflight?: () => void } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-branch-idle-'));
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
  const notifications = new NotificationCenter({ ledger, bus });
  const basePort = new InMemoryWorktreePort(join(dir, 'wtroot'));
  const worktrees: WorktreePort =
    opts.onReviewLane !== undefined ? new HookedWorktreePort(basePort, opts.onReviewLane) : basePort;
  const spawner = async (): Promise<never> => {
    throw new Error('the review spawner is not reachable in branch-idle tests');
  };
  const dispatch = new DispatchService({ ledger, worktrees, spawner });
  const artifactRoot = join(dir, 'reviews');
  const wave = new WaveRunner({
    ledger,
    worktrees,
    spawner,
    reviewArtifactRoot: artifactRoot,
    bus,
    ...(opts.onPreflight !== undefined
      ? {
          reviewPreflight: async () => {
            opts.onPreflight?.();
            return { ok: true as const, failures: [] as const };
          },
        }
      : {}),
  });
  const server = createDispatchServer({
    config: cfg,
    dispatch,
    wave,
    ledger,
    silasOps: {
      registry: {
        getHandle: () => null,
        spawn: spawner,
        disposeHandle: async () => {},
      },
      worktrees,
      notifications,
    },
  });
  const http: HttpServer = createServer((req, res) => {
    if (server.requestHook(req, res, new URL(req.url ?? '/', 'http://localhost').pathname)) return;
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolveListen) => http.listen(0, '127.0.0.1', resolveListen));
  return {
    port: (http.address() as AddressInfo).port,
    ledger,
    worktrees: basePort,
    wave,
    artifactRoot,
    close: async () => {
      await new Promise<void>((resolveClose) => http.close(() => resolveClose()));
      await wave.shutdown();
      db.close();
    },
  };
}

/** Create a job lane like dispatch does — branch `gru/<jobId>`, one commit
 * of deliverable content — then park it at the requested status. */
async function createLaneJob(
  h: Harness,
  repo: FixtureRepo,
  input: { jobId: string; status: 'working' | 'delivered' | 'in-review' },
): Promise<WorktreeLane> {
  const lane = await h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: input.jobId });
  h.ledger.addJob({
    id: input.jobId,
    repo: 'fixture',
    title: input.jobId,
    baseBranch: 'main',
    briefing: 'review this lane',
  });
  h.ledger.setJobStatus(input.jobId, 'working');
  if (input.status !== 'working') h.ledger.setJobStatus(input.jobId, input.status);
  writeFileSync(join(lane.path, `deliverable-${input.jobId}.txt`), 'delivered\n');
  execFileSync('git', ['-C', lane.path, 'add', '.']);
  execFileSync(
    'git',
    ['-C', lane.path, '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', `fixture: deliver ${input.jobId}`],
    { stdio: 'ignore' },
  );
  return lane;
}

async function postReview(
  h: Harness,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${h.port}/api/dispatch/review`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** A full pending-re-brief marker fixture (the guard reads only jobId). */
function pendingMarker(
  jobId: string,
  kind: PendingRebriefRecord['kind'] = 'silas.rebrief',
): PendingRebriefRecord {
  return {
    id: `${jobId}-${kind}`,
    jobId,
    kind,
    note: 'same blocker; try differently',
    briefing: 'the original contract',
    payloadHash: 'a'.repeat(64),
    baselineSeq: 40,
    agentId: null,
    sessionFile: null,
    requestedAt: '2026-09-30T00:00:00.000Z',
  };
}

/** Bounded deterministic flush: settle promise chains started by the
 * handoff replay without sleeps or wall-clock waits. */
async function flushAsync(): Promise<void> {
  for (let tick = 0; tick < 100; tick += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function eventRecord(seq: number, kind: string, payload: unknown = {}): EventRecord {
  return {
    seq,
    ts: new Date(seq * 1000).toISOString(),
    kind,
    agentId: null,
    jobId: null,
    roundId: null,
    lens: null,
    payload,
  };
}

function jobRecord(id: string, status: JobStatus): JobRecord {
  return {
    id,
    repo: 'fixture',
    title: id,
    status,
    baseBranch: 'main',
    prUrl: null,
    note: null,
    briefing: 'b',
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
  };
}

function laneRecord(id: string, jobId: string, branch: string | null): WorktreeLane {
  return {
    id,
    kind: 'job',
    repoPath: '/fixture',
    repoName: 'fixture',
    path: `/fixture/${id}`,
    branch,
    sha: 'sha',
    jobId,
    roundId: null,
    status: 'active',
  };
}

describe('branch-idle guard', () => {
  it('busy means an open attempt with no settled delivery; branch refs normalize', () => {
    const start = eventRecord(1, 'job.status', { from: 'dispatched', to: 'working' });
    const delivery = eventRecord(2, 'job.delivered', { sha: 'sha-1' });
    const reopen = eventRecord(3, 'job.status', { from: 'in-review', to: 'working' });
    const events = new Map<string, EventRecord[]>([
      ['never-started', []],
      ['settled', [start, delivery]],
      ['reopened', [start, delivery, reopen]],
      ['open', [start]],
    ]);
    const ledger = {
      listJobs: () => [
        jobRecord('never-started', 'dispatched'),
        jobRecord('settled', 'working'),
        jobRecord('reopened', 'working'),
        jobRecord('open', 'working'),
        jobRecord('delivered', 'delivered'),
      ],
      latestJobEvent: (jobId: string, kind: string): EventRecord | null =>
        (events.get(jobId) ?? []).filter((event) => event.kind === kind).at(-1) ?? null,
      listPendingRebriefs: (): readonly PendingRebriefRecord[] => [],
    };
    const busy = (id: string): boolean => laneIsBusy(ledger, ledger.listJobs().find((job) => job.id === id)!);
    expect(busy('never-started')).toBe(true);
    expect(busy('settled')).toBe(false);
    expect(busy('reopened')).toBe(true);
    expect(busy('open')).toBe(true);
    expect(busy('delivered')).toBe(false);

    const lanes = [laneRecord('reopened', 'reopened', 'gru/reopened'), laneRecord('settled', 'settled', 'gru/settled')];
    expect(findBusyLanes({ ledger, lanes, targetBranch: 'gru/reopened' }).map((blocker) => blocker.jobId)).toEqual([
      'reopened',
    ]);
    expect(findBusyLanes({ ledger, lanes, targetBranch: 'refs/heads/gru/settled' })).toEqual([]);
    // A dispatched job without a registry row compares as the branch it is
    // about to create (gru/<jobId>).
    expect(findBusyLanes({ ledger, lanes, targetBranch: 'gru/never-started' }).map((blocker) => blocker.jobId)).toEqual([
      'never-started',
    ]);
    expect(normalizeBranch('refs/remotes/origin/gru/x')).toBe('gru/x');
    expect(normalizeBranch('refs/heads/gru/x')).toBe('gru/x');
  });

  it('refuses the arm with 409 branch_busy while a working lane owns the branch, then passes once it delivers', async () => {
    const repo = makeFixtureRepo('branch-idle-refusal');
    cleanupRepos.push(repo);
    const h = await boot();
    try {
      await createLaneJob(h, repo, { jobId: 'busy-lane', status: 'working' });
      const refused = await postReview(h, { job_id: 'busy-lane' });
      expect(refused.status).toBe(409);
      expect(refused.json).toEqual({
        error: 'branch_busy',
        blockers: [{ job_id: 'busy-lane', status: 'working', branch: 'gru/busy-lane' }],
        hint: BRANCH_BUSY_HINT,
      });
      // No round, worktree, or review work started.
      expect(h.ledger.listRounds('busy-lane')).toHaveLength(0);
      expect(h.worktrees.listWorktrees({ jobId: 'busy-lane' }).filter((lane) => lane.kind === 'review')).toHaveLength(0);
      const refusal = h.ledger
        .listJobEvents('busy-lane')
        .find((event) => event.kind === 'branch-idle.refused');
      expect(refusal?.payload).toMatchObject({ phase: 'arm', targetBranch: 'gru/busy-lane' });

      // Deferred retry on idle: the lane delivers, the same arm passes.
      h.ledger.setJobStatus('busy-lane', 'delivered');
      const passed = await postReview(h, { job_id: 'busy-lane' });
      expect(passed.status).toBe(202);
      expect(passed.json['round_id']).toBe('busy-lane-r1');
      expect(h.ledger.listRounds('busy-lane')).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('force=true overrides the refusal, tags the frozen manifest, and records the override in the event log', async () => {
    const repo = makeFixtureRepo('branch-idle-force');
    cleanupRepos.push(repo);
    const h = await boot();
    try {
      await createLaneJob(h, repo, { jobId: 'forced-lane', status: 'working' });
      expect((await postReview(h, { job_id: 'forced-lane' })).status).toBe(409);
      const forced = await postReview(h, { job_id: 'forced-lane', force: true });
      expect(forced.status).toBe(202);
      const roundId = forced.json['round_id'] as string;
      const manifest = JSON.parse(readFileSync(join(h.artifactRoot, roundId, 'manifest.json'), 'utf8')) as {
        branchIdle?: { forced: boolean; targetBranch: string; blockers: readonly unknown[] };
      };
      expect(manifest.branchIdle).toEqual({
        forced: true,
        targetBranch: 'gru/forced-lane',
        blockers: [{ jobId: 'forced-lane', status: 'working', branch: 'gru/forced-lane' }],
      });
      const forcedEvents = h.ledger
        .listJobEvents('forced-lane')
        .filter((event) => event.kind === 'branch-idle.forced');
      expect(forcedEvents.map((event) => (event.payload as { phase?: string }).phase).sort()).toEqual([
        'arm',
        'freeze',
      ]);
      expect((forcedEvents[0]?.payload as { forced?: boolean }).forced).toBe(true);
      expect(h.ledger.listJobEvents('forced-lane').some((event) => event.kind === 'branch-idle.refused')).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('refuses at freeze time when a lane re-opens between arm and freeze', async () => {
    const repo = makeFixtureRepo('branch-idle-freeze-race');
    cleanupRepos.push(repo);
    let race: (() => void) | null = null;
    const h = await boot({ onReviewLane: () => race?.() });
    try {
      await createLaneJob(h, repo, { jobId: 'race-lane', status: 'delivered' });
      // The arm intake sees an idle lane; the freeze window re-opens it.
      race = () => h.ledger.setJobStatus('race-lane', 'working');
      const refused = await postReview(h, { job_id: 'race-lane' });
      expect(refused.status).toBe(409);
      expect(refused.json).toEqual({
        error: 'branch_busy',
        blockers: [{ job_id: 'race-lane', status: 'working', branch: 'gru/race-lane' }],
        hint: BRANCH_BUSY_HINT,
      });
      const rounds = h.ledger.listRounds('race-lane');
      expect(rounds).toHaveLength(1);
      expect(rounds[0]?.status).toBe('aborted');
      const refusal = h.ledger
        .listJobEvents('race-lane')
        .find(
          (event) =>
            event.kind === 'branch-idle.refused' && (event.payload as { phase?: string }).phase === 'freeze',
        );
      expect(refusal).not.toBeNull();
      // The aborted round's review lane was swept back out — no half state.
      const reviewLanes = h.worktrees.listWorktrees({ jobId: 'race-lane' }).filter((lane) => lane.kind === 'review');
      expect(reviewLanes).toHaveLength(1);
      expect(reviewLanes.every((lane) => lane.status === 'swept')).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('resolves an explicit target_ref and blocks on a foreign busy lane that owns it', async () => {
    const repo = makeFixtureRepo('branch-idle-target-ref');
    cleanupRepos.push(repo);
    const h = await boot();
    try {
      await createLaneJob(h, repo, { jobId: 'reviewed-lane', status: 'delivered' });
      await createLaneJob(h, repo, { jobId: 'foreign-lane', status: 'working' });
      const refused = await postReview(h, { job_id: 'reviewed-lane', target_ref: 'gru/foreign-lane' });
      expect(refused.status).toBe(409);
      expect(refused.json).toEqual({
        error: 'branch_busy',
        blockers: [{ job_id: 'foreign-lane', status: 'working', branch: 'gru/foreign-lane' }],
        hint: BRANCH_BUSY_HINT,
      });
      h.ledger.setJobStatus('foreign-lane', 'delivered');
      const passed = await postReview(h, { job_id: 'reviewed-lane', target_ref: 'gru/foreign-lane' });
      expect(passed.status).toBe(202);
    } finally {
      await h.close();
    }
  });

  it('records a silas.review-deferred note when the auto-arm answers 409', async () => {
    const repo = makeFixtureRepo('branch-idle-silas');
    cleanupRepos.push(repo);
    const h = await boot();
    try {
      await createLaneJob(h, repo, { jobId: 'silas-lane', status: 'working' });
      const refused = await postReview(h, { job_id: 'silas-lane', by: 'silas' });
      expect(refused.status).toBe(409);
      const deferred = h.ledger.listJobEvents('silas-lane').find((event) => event.kind === 'silas.review-deferred');
      expect(deferred).not.toBeNull();
      expect(deferred?.payload).toMatchObject({ target_branch: 'gru/silas-lane', phase: 'arm' });
      expect(h.ledger.listJobEvents('silas-lane').some((event) => event.kind === 'silas.review-triggered')).toBe(false);
    } finally {
      await h.close();
    }
  });

  it('an unresolved re-brief keeps the lane busy across working/delivered/in-review; terminal stale markers never block', () => {
    const start = eventRecord(1, 'job.status', { from: 'dispatched', to: 'working' });
    const delivery = eventRecord(2, 'job.delivered', { sha: 'sha-1' });
    const toInReview = eventRecord(3, 'job.status', { from: 'delivered', to: 'in-review' });
    const toMerged = eventRecord(4, 'job.status', { from: 'in-review', to: 'merged' });
    const events = new Map<string, EventRecord[]>([
      ['working-pending', [start]],
      ['delivered-pending', [start, delivery]],
      ['in-review-pending', [start, delivery, toInReview]],
      ['merged-pending', [start, delivery, toInReview, toMerged]],
      ['settled', [start, delivery]],
    ]);
    const pending = new Map<string, PendingRebriefRecord[]>([
      ['working-pending', [pendingMarker('working-pending')]],
      ['delivered-pending', [pendingMarker('delivered-pending')]],
      // Only one of the two guarded markers remains — still unresolved.
      ['in-review-pending', [pendingMarker('in-review-pending', 'job.delivered')]],
      ['merged-pending', [pendingMarker('merged-pending')]],
    ]);
    const ledger = {
      listJobs: () => [
        jobRecord('working-pending', 'working'),
        jobRecord('delivered-pending', 'delivered'),
        jobRecord('in-review-pending', 'in-review'),
        jobRecord('merged-pending', 'merged'),
        jobRecord('settled', 'delivered'),
      ],
      latestJobEvent: (jobId: string, kind: string): EventRecord | null =>
        (events.get(jobId) ?? []).filter((event) => event.kind === kind).at(-1) ?? null,
      listPendingRebriefs: (opts: { readonly jobId?: string } = {}): readonly PendingRebriefRecord[] =>
        opts.jobId === undefined ? [...pending.values()].flat() : (pending.get(opts.jobId) ?? []),
    };
    const busy = (id: string): boolean => laneIsBusy(ledger, ledger.listJobs().find((job) => job.id === id)!);
    expect(busy('working-pending')).toBe(true);
    // The old delivery settled the attempt, but the newer request fences it.
    expect(busy('delivered-pending')).toBe(true);
    // A status flip alone cannot release the fence; one guarded marker left is enough.
    expect(busy('in-review-pending')).toBe(true);
    // Genuinely settled (no markers, delivered after the attempt start): eligible.
    expect(busy('settled')).toBe(false);
    // A stale marker on a terminal job must not resurrect it as a blocker.
    expect(busy('merged-pending')).toBe(false);
  });

  it('a pending re-brief refuses the arm before preflight; a late delivery cannot clear it, and settlement releases it', async () => {
    const repo = makeFixtureRepo('branch-idle-rebrief-arm');
    cleanupRepos.push(repo);
    let preflights = 0;
    const h = await boot({ onPreflight: () => { preflights += 1; } });
    try {
      await createLaneJob(h, repo, { jobId: 'rebrief-arm', status: 'delivered' });
      const markers = h.ledger.beginPendingRebrief({ jobId: 'rebrief-arm', note: 'same blocker', briefing: 'b' });
      // The previous worker's late delivery lands after the request watermark
      // — it must not answer the newer request.
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'rebrief-arm', payload: { sha: 'late-old-head' } });
      // A status transition alone cannot release the fence either.
      h.ledger.setJobStatus('rebrief-arm', 'in-review');
      const refused = await postReview(h, { job_id: 'rebrief-arm' });
      expect(refused.status).toBe(409);
      expect(refused.json).toEqual({
        error: 'branch_busy',
        blockers: [{ job_id: 'rebrief-arm', status: 'in-review', branch: 'gru/rebrief-arm' }],
        hint: BRANCH_BUSY_HINT,
      });
      // Refused before any preflight, round, or review work existed.
      expect(preflights).toBe(0);
      expect(h.ledger.listRounds('rebrief-arm')).toHaveLength(0);
      expect(h.worktrees.listWorktrees({ jobId: 'rebrief-arm' }).filter((lane) => lane.kind === 'review')).toHaveLength(0);

      // Only one of the two guarded markers remaining still fences.
      const rebriefMarker = markers.find((marker) => marker.kind === 'silas.rebrief');
      if (rebriefMarker === undefined) throw new Error('expected a silas.rebrief marker');
      h.ledger.clearPendingRebriefs([rebriefMarker.id]);
      expect((await postReview(h, { job_id: 'rebrief-arm' })).status).toBe(409);
      expect(preflights).toBe(0);

      // Genuine settlement (both markers cleared) releases the target.
      h.ledger.clearPendingRebriefs(markers.filter((marker) => marker.kind === 'job.delivered').map((marker) => marker.id));
      const passed = await postReview(h, { job_id: 'rebrief-arm' });
      expect(passed.status).toBe(202);
      expect(preflights).toBe(1);
      expect(h.ledger.listRounds('rebrief-arm')).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('a re-brief admitted between arm and freeze aborts the round and starts no review', async () => {
    const repo = makeFixtureRepo('branch-idle-rebrief-freeze');
    cleanupRepos.push(repo);
    let admit: (() => void) | null = null;
    const h = await boot({ onReviewLane: () => admit?.() });
    try {
      await createLaneJob(h, repo, { jobId: 'rebrief-freeze', status: 'delivered' });
      admit = () => { h.ledger.beginPendingRebrief({ jobId: 'rebrief-freeze', note: 'n', briefing: 'b' }); };
      const refused = await postReview(h, { job_id: 'rebrief-freeze' });
      expect(refused.status).toBe(409);
      expect(refused.json).toMatchObject({
        error: 'branch_busy',
        blockers: [{ job_id: 'rebrief-freeze', status: 'delivered', branch: 'gru/rebrief-freeze' }],
      });
      const rounds = h.ledger.listRounds('rebrief-freeze');
      expect(rounds).toHaveLength(1);
      expect(rounds[0]?.status).toBe('aborted');
      const refusal = h.ledger.listJobEvents('rebrief-freeze').find(
        (event) =>
          event.kind === 'branch-idle.refused' && (event.payload as { phase?: string }).phase === 'freeze',
      );
      expect(refusal).not.toBeNull();
      // The aborted round's review lane was swept back out — no half state.
      const reviewLanes = h.worktrees.listWorktrees({ jobId: 'rebrief-freeze' }).filter((lane) => lane.kind === 'review');
      expect(reviewLanes).toHaveLength(1);
      expect(reviewLanes.every((lane) => lane.status === 'swept')).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('a queued review handoff re-queues while the re-brief is unresolved and arms after settlement', async () => {
    const repo = makeFixtureRepo('branch-idle-rebrief-handoff');
    cleanupRepos.push(repo);
    let preflights = 0;
    const h = await boot({ onPreflight: () => { preflights += 1; } });
    try {
      await createLaneJob(h, repo, { jobId: 'rebrief-handoff', status: 'working' });
      const queued = await postReview(h, { job_id: 'rebrief-handoff', by: 'minion' });
      expect(queued.status).toBe(202);
      expect(queued.json).toMatchObject({ route: 'queued', job_id: 'rebrief-handoff' });
      expect(preflights).toBe(0);

      // The old attempt delivers and a NEW re-brief is admitted: the queued
      // replay must not start an obsolete review.
      h.ledger.setJobStatus('rebrief-handoff', 'delivered');
      const markers = h.ledger.beginPendingRebrief({ jobId: 'rebrief-handoff', note: 'n', briefing: 'b' });
      h.wave.reconcilePendingHandoffs();
      await flushAsync();
      expect(h.ledger.latestJobEvent('rebrief-handoff', 'job.review-handoff-requeued')).not.toBeNull();
      expect(h.ledger.listRounds('rebrief-handoff')).toHaveLength(0);
      expect(preflights).toBe(0);

      // Genuine settlement releases the target; the queued replay arms.
      h.ledger.clearPendingRebriefs(markers.map((marker) => marker.id));
      h.wave.reconcilePendingHandoffs();
      await flushAsync();
      expect(h.ledger.latestJobEvent('rebrief-handoff', 'job.review-handoff-started')).not.toBeNull();
      expect(h.ledger.listRounds('rebrief-handoff')).toHaveLength(1);
      expect(preflights).toBe(1);
    } finally {
      await h.close();
    }
  });
});
