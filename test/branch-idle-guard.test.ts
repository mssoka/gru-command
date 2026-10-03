import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, type EventRecord, type JobRecord, type JobStatus, type PendingRebriefRecord } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { DEFAULT_SILAS_CONFIG, loadConfig } from '../src/config.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { DispatchService } from '../src/dispatch/service.js';
import { WaveRunner } from '../src/dispatch/perkins.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { makeFixtureRepo, attachBareOrigin, type FixtureRepo } from './helpers/fixture-repo.js';
import { originHeadProbe } from './helpers/pr-head-probe.js';
import type { WorktreeLane, WorktreePort, WorktreeSweepResult } from '../src/dispatch/worktree-port.js';
import type { WorktreeBaseSource } from '../src/ledger/api.js';
import { BRANCH_BUSY_HINT, findBusyLanes, laneIsBusy, normalizeBranch } from '../src/dispatch/branch-idle.js';
import { finalizeRebriefRequest } from '../src/dispatch/rebrief-recovery.js';
import { computeSilasDigest } from '../src/dispatch/silas-driver.js';

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

  async resolveReviewTarget(input: { repoPath: string; ref: string }): Promise<{
    readonly sha: string;
    readonly baseSource: WorktreeBaseSource | null;
  }> {
    return this.delegate.resolveReviewTarget(input);
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
  readonly bus: EventBus;
  readonly artifactRoot: string;
  /** Fallback-gate passes that actually started a fallback reviewer. */
  readonly fallbackRuns: number[];
  /** Escalation lines raised by the wave (held-handoff and gate audits). */
  readonly escalations: string[];
  close(): Promise<void>;
}

async function boot(opts: {
  onReviewLane?: () => void;
  onPreflight?: () => void | Promise<void>;
  /** The pre-flight resolves as FAILED (routes to the fallback gate). */
  preflightFails?: boolean;
} = {}): Promise<Harness> {
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
  const fallbackRuns: number[] = [];
  const escalations: string[] = [];
  const fallbackSkill = join(dir, 'skills', 'bmad-review', 'SKILL.md');
  mkdirSync(dirname(fallbackSkill), { recursive: true });
  writeFileSync(fallbackSkill, '---\nname: bmad-review\n---\ninstalled skill bytes\n', 'utf8');
  const wave = new WaveRunner({
    ledger,
    worktrees,
    spawner,
    reviewArtifactRoot: artifactRoot,
    bus,
    escalate: (title, detail) => escalations.push(`${title}: ${detail}`),
    // PR-linked rounds verify the live head through the fixture's own bare
    // origin (the same double the dispatch-server suite uses); rounds
    // without a registered PR never consult it.
    prHeadProbe: originHeadProbe(),
    fallbackGate: {
      skillPath: fallbackSkill,
      runFallbackReview: async () => {
        fallbackRuns.push(1);
        return [];
      },
      fixDirectiveSink: async () => ({ delivered: true as const }),
    },
    ...(opts.onPreflight !== undefined || opts.preflightFails === true
      ? {
          reviewPreflight: async () => {
            await opts.onPreflight?.();
            return opts.preflightFails === true
              ? {
                  ok: false as const,
                  failures: [{
                    leg: 'review-policy' as const,
                    detail: 'the Perkins review gate is disabled in config',
                    remediation: 'Enable the Perkins review gate in config: set [review] enabled = true in the instance config.',
                  }],
                }
              : { ok: true as const, failures: [] as const };
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
    bus,
    artifactRoot,
    fallbackRuns,
    escalations,
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

/** The Silas review-eligibility projection over the harness's real ledger. */
function digestOf(h: Harness): ReturnType<typeof computeSilasDigest> {
  return computeSilasDigest({
    ledger: h.ledger,
    blockersForRound: async () => ({ blockers: [], note: null }),
    config: DEFAULT_SILAS_CONFIG,
    trigger: 'sweep',
  });
}

/** A manually released gate the test controls (no sleeps, deterministic). */
function deferred(): { readonly promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
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

/** Fixture-local completion join on the harness's EXISTING EventBus (the
 * same bus the LedgerApi and WaveRunner already share): a promise armed
 * BEFORE the replay runs that resolves on THIS job's expected event. A
 * fresh subscription only sees emissions made after it attaches, so stale
 * history can never satisfy the join, and the jobId+kind filter
 * distinguishes the expected request from any other traffic. Bounded by
 * the SAME deterministic 100-sweep drain the former fixed flush used —
 * no larger iteration count, no sleep, no wall-clock timeout. The
 * listener is released on resolution and on bound exhaustion; the bus is
 * fixture-local, so nothing outlives the test either way. An event that
 * never lands rejects with a named error — absence is never success. */
function joinJobEvent(h: Harness, jobId: string, kind: string, where?: (event: EventRecord) => boolean): Promise<EventRecord> {
  return new Promise<EventRecord>((resolve, reject) => {
    let settled = false;
    const unsubscribe = h.bus.subscribe((event) => {
      if (settled || event.kind !== kind || event.jobId !== jobId) return;
      if (where !== undefined && !where(event)) return;
      settled = true;
      unsubscribe();
      resolve(event);
    });
    let sweeps = 0;
    const drain = (): void => {
      setImmediate(() => {
        if (settled) return;
        if (sweeps >= 100) {
          settled = true;
          unsubscribe();
          reject(
            new Error(`expected a ${kind} event on ${jobId} — the replay emitted none within the original 100-sweep bound`),
          );
          return;
        }
        sweeps += 1;
        drain();
      });
    };
    drain();
  });
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
      expect(refusal).toBeDefined();
      expect(refusal?.roundId).toBe(rounds[0]?.id);
      expect(refusal?.payload).toMatchObject({ phase: 'freeze' });
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

  it('a pending re-brief refuses the arm before preflight; a late delivery and a partial marker set cannot clear it', async () => {
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
      // No release is asserted here: direct marker deletion is not
      // settlement proof, and on THIS late-delivery fixture the real
      // finalizer's reused delivery still leaves the attempt busy
      // (rebrief-recovery owns that lifecycle seam). The genuine
      // finalizer-driven release is covered in its own case below.
      expect(h.ledger.listPendingRebriefs({ jobId: 'rebrief-arm' })).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('genuine finalization with a fresh settled delivery releases the target for digest and admission', async () => {
    const repo = makeFixtureRepo('branch-idle-rebrief-finalize');
    cleanupRepos.push(repo);
    let preflights = 0;
    const h = await boot({ onPreflight: () => { preflights += 1; } });
    try {
      const lane = await createLaneJob(h, repo, { jobId: 'rebrief-finalize', status: 'delivered' });
      // A registered PR routes the freeze through the live PR head; the
      // fixture's bare origin carries the pushed lane branch for that check.
      attachBareOrigin(repo);
      repo.git(['push', '--quiet', 'origin', 'gru/rebrief-finalize:refs/heads/gru/rebrief-finalize']);
      h.ledger.setJobPr('rebrief-finalize', 'https://git.example.invalid/acme/fixture/pull/9');
      h.ledger.beginPendingRebrief({ jobId: 'rebrief-finalize', note: 'same blocker', briefing: 'b' });

      // While the request is unresolved: no digest offer and no admission.
      expect((await digestOf(h)).prWithoutReview.map((row) => row.jobId)).toEqual([]);
      expect((await postReview(h, { job_id: 'rebrief-finalize' })).status).toBe(409);
      expect(preflights).toBe(0);

      // The REAL finalizer (the same one the /api/silas/rebrief endpoint
      // and boot recovery call) records both guarded events — including the
      // settled turn's OWN fresh delivery — and clears the markers only then.
      const finalized = finalizeRebriefRequest({
        ledger: h.ledger,
        worktrees: h.worktrees,
        jobId: 'rebrief-finalize',
        minionId: 'minion-fresh',
        lanePath: lane.path,
        note: 'same blocker',
      });
      expect(finalized).toMatchObject({ rebriefRecorded: true, deliveryRecorded: true });
      expect(h.ledger.listPendingRebriefs({ jobId: 'rebrief-finalize' })).toHaveLength(0);
      const delivered = h.ledger.latestJobEvent('rebrief-finalize', 'job.delivered');
      expect(delivered).not.toBeNull();
      expect((delivered?.payload as { sha?: string }).sha).toBeTruthy();

      // Digest eligibility returns for exactly this target...
      expect((await digestOf(h)).prWithoutReview.map((row) => row.jobId)).toEqual(['rebrief-finalize']);
      // ...and normal admission passes every current gate with one preflight.
      const passed = await postReview(h, { job_id: 'rebrief-finalize' });
      expect(passed.status).toBe(202);
      expect(preflights).toBe(1);
      expect(h.ledger.listRounds('rebrief-finalize')).toHaveLength(1);
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
      expect(refusal).toBeDefined();
      expect(refusal?.roundId).toBe(rounds[0]?.id);
      expect(refusal?.payload).toMatchObject({ phase: 'freeze' });
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
      // Arm the join BEFORE the replay: the subscription sees only events
      // emitted by THIS reconciliation, never stale history.
      const requeuedPromise = joinJobEvent(h, 'rebrief-handoff', 'job.review-handoff-requeued');
      h.wave.reconcilePendingHandoffs();
      const requeued = await requeuedPromise;
      expect(requeued.jobId).toBe('rebrief-handoff');
      expect(h.ledger.listRounds('rebrief-handoff')).toHaveLength(0);
      expect(preflights).toBe(0);

      // Genuine settlement releases the target; the queued replay arms.
      h.ledger.clearPendingRebriefs(markers.map((marker) => marker.id));
      const startedPromise = joinJobEvent(h, 'rebrief-handoff', 'job.review-handoff-started');
      h.wave.reconcilePendingHandoffs();
      const started = await startedPromise;
      expect(started.jobId).toBe('rebrief-handoff');
      expect(h.ledger.listRounds('rebrief-handoff')).toHaveLength(1);
      expect(preflights).toBe(1);
    } finally {
      await h.close();
    }
  });

  it('a re-brief admitted during a failing pre-flight refuses the fallback arm (normal request)', async () => {
    const repo = makeFixtureRepo('branch-idle-fallback-normal');
    cleanupRepos.push(repo);
    const entered = deferred();
    const gate = deferred();
    const h = await boot({
      preflightFails: true,
      onPreflight: async () => {
        entered.release();
        await gate.promise;
      },
    });
    try {
      await createLaneJob(h, repo, { jobId: 'fallback-normal', status: 'delivered' });
      const pending = postReview(h, { job_id: 'fallback-normal' });
      await entered.promise;
      // The re-brief lands while the failing pre-flight is awaited: the
      // fallback admission re-checks the SAME shared guard before any
      // fallback reviewer starts.
      h.ledger.beginPendingRebrief({ jobId: 'fallback-normal', note: 'n', briefing: 'b' });
      gate.release();
      const refused = await pending;
      expect(refused.status).toBe(409);
      expect(refused.json).toEqual({
        error: 'branch_busy',
        blockers: [{ job_id: 'fallback-normal', status: 'delivered', branch: 'gru/fallback-normal' }],
        hint: BRANCH_BUSY_HINT,
      });
      // No fallback reviewer started and no fallback outcome was recorded.
      expect(h.fallbackRuns).toHaveLength(0);
      expect(h.ledger.listJobEvents('fallback-normal').some((event) => event.kind === 'job.fallback-review')).toBe(false);
      expect(h.ledger.listRounds('fallback-normal')).toHaveLength(0);
      const refusal = h.ledger
        .listJobEvents('fallback-normal')
        .find((event) => event.kind === 'branch-idle.refused' && (event.payload as { phase?: string }).phase === 'arm');
      expect(refusal).toBeDefined();
      expect(refusal?.payload).toMatchObject({ phase: 'arm', targetBranch: 'gru/fallback-normal' });
    } finally {
      gate.release();
      await h.close();
    }
  });

  it('a queued review replay refuses the fallback arm when the re-brief lands during its failing pre-flight', async () => {
    const repo = makeFixtureRepo('branch-idle-fallback-replay');
    cleanupRepos.push(repo);
    const entered = deferred();
    const gate = deferred();
    const h = await boot({
      preflightFails: true,
      onPreflight: async () => {
        entered.release();
        await gate.promise;
      },
    });
    try {
      await createLaneJob(h, repo, { jobId: 'fallback-replay', status: 'working' });
      const queued = await postReview(h, { job_id: 'fallback-replay', by: 'minion' });
      expect(queued.status).toBe(202);
      expect(queued.json).toMatchObject({ route: 'queued', job_id: 'fallback-replay' });

      // The old attempt settles; the replay's failing pre-flight is awaited
      // while a NEW re-brief is admitted — the replay must re-queue instead
      // of routing the lane to a fallback reviewer.
      h.ledger.setJobStatus('fallback-replay', 'delivered');
      const requeuedPromise = joinJobEvent(h, 'fallback-replay', 'job.review-handoff-requeued');
      h.wave.reconcilePendingHandoffs();
      await entered.promise;
      h.ledger.beginPendingRebrief({ jobId: 'fallback-replay', note: 'n', briefing: 'b' });
      gate.release();
      const requeued = await requeuedPromise;
      expect(requeued.jobId).toBe('fallback-replay');

      // No fallback reviewer started; nothing was admitted as a round.
      expect(h.fallbackRuns).toHaveLength(0);
      expect(h.ledger.listRounds('fallback-replay')).toHaveLength(0);
      expect(h.ledger.listJobEvents('fallback-replay').some((event) => event.kind === 'job.fallback-review')).toBe(false);
    } finally {
      gate.release();
      await h.close();
    }
  });

  it('a queued replay whose job flips to blocked during a failing pre-flight is HELD, not fallback-reviewed', async () => {
    const repo = makeFixtureRepo('branch-idle-held-blocked');
    cleanupRepos.push(repo);
    const entered = deferred();
    const gate = deferred();
    const h = await boot({
      preflightFails: true,
      onPreflight: async () => {
        entered.release();
        await gate.promise;
      },
    });
    try {
      await createLaneJob(h, repo, { jobId: 'held-blocked', status: 'working' });
      const queued = await postReview(h, { job_id: 'held-blocked', by: 'minion' });
      expect(queued.status).toBe(202);
      expect(queued.json).toMatchObject({ route: 'queued', job_id: 'held-blocked' });

      // The old attempt settles; the replay's failing pre-flight is awaited
      // while the job's execution authorization is revoked (blocked) — the
      // post-await handoff fence must HELD it instead of admitting fallback.
      h.ledger.setJobStatus('held-blocked', 'delivered');
      const heldPromise = joinJobEvent(h, 'held-blocked', 'job.review-handoff-held');
      h.wave.reconcilePendingHandoffs();
      await entered.promise;
      h.ledger.setJobStatus('held-blocked', 'blocked');
      gate.release();
      const held = await heldPromise;
      expect(held.jobId).toBe('held-blocked');
      expect(held.payload).toMatchObject({ reason: 'job-status-blocked' });

      // No fallback reviewer started and nothing was admitted.
      expect(h.fallbackRuns).toHaveLength(0);
      expect(h.ledger.listRounds('held-blocked')).toHaveLength(0);
      expect(h.ledger.listJobEvents('held-blocked').some((event) => event.kind === 'job.fallback-review')).toBe(false);
      expect(h.ledger.listJobEvents('held-blocked').some((event) => event.kind === 'job.review-handoff-started')).toBe(false);
      expect(h.escalations.some((line) => line.includes('held'))).toBe(true);
      // Held stays visible but is not sweep-rearmable without a new request.
      h.wave.reconcilePendingHandoffs();
      expect(h.fallbackRuns).toHaveLength(0);
      expect(h.ledger.listRounds('held-blocked')).toHaveLength(0);
    } finally {
      gate.release();
      await h.close();
    }
  });

  it('a queued replay whose job flips to parked during a failing pre-flight is HELD, not fallback-reviewed', async () => {
    const repo = makeFixtureRepo('branch-idle-held-parked');
    cleanupRepos.push(repo);
    const entered = deferred();
    const gate = deferred();
    const h = await boot({
      preflightFails: true,
      onPreflight: async () => {
        entered.release();
        await gate.promise;
      },
    });
    try {
      await createLaneJob(h, repo, { jobId: 'held-parked', status: 'working' });
      const queued = await postReview(h, { job_id: 'held-parked', by: 'minion' });
      expect(queued.status).toBe(202);
      expect(queued.json).toMatchObject({ route: 'queued', job_id: 'held-parked' });

      h.ledger.setJobStatus('held-parked', 'delivered');
      const heldPromise = joinJobEvent(h, 'held-parked', 'job.review-handoff-held');
      h.wave.reconcilePendingHandoffs();
      await entered.promise;
      h.ledger.setJobStatus('held-parked', 'parked');
      gate.release();
      const held = await heldPromise;
      expect(held.jobId).toBe('held-parked');
      expect(held.payload).toMatchObject({ reason: 'job-status-parked' });

      expect(h.fallbackRuns).toHaveLength(0);
      expect(h.ledger.listRounds('held-parked')).toHaveLength(0);
      expect(h.ledger.listJobEvents('held-parked').some((event) => event.kind === 'job.fallback-review')).toBe(false);
      expect(h.ledger.listJobEvents('held-parked').some((event) => event.kind === 'job.review-handoff-started')).toBe(false);
      expect(h.escalations.some((line) => line.includes('held'))).toBe(true);
    } finally {
      gate.release();
      await h.close();
    }
  });

  it('pending markers on one job never block an unrelated target branch', () => {
    const start = eventRecord(1, 'job.status', { from: 'dispatched', to: 'working' });
    const delivery = eventRecord(2, 'job.delivered', { sha: 'sha-1' });
    const events = new Map<string, EventRecord[]>([
      ['marker-owner', [start]],
      ['plain-lane', [start, delivery]],
    ]);
    const pending = new Map<string, PendingRebriefRecord[]>([
      ['marker-owner', [pendingMarker('marker-owner')]],
    ]);
    const ledger = {
      listJobs: () => [jobRecord('marker-owner', 'working'), jobRecord('plain-lane', 'delivered')],
      latestJobEvent: (jobId: string, kind: string): EventRecord | null =>
        (events.get(jobId) ?? []).filter((event) => event.kind === kind).at(-1) ?? null,
      listPendingRebriefs: (opts: { readonly jobId?: string } = {}): readonly PendingRebriefRecord[] =>
        opts.jobId === undefined ? [...pending.values()].flat() : (pending.get(opts.jobId) ?? []),
    };
    const lanes = [
      laneRecord('marker-owner', 'marker-owner', 'gru/marker-owner'),
      laneRecord('plain-lane', 'plain-lane', 'gru/plain-lane'),
    ];
    // The marker fences exactly its own branch...
    expect(
      findBusyLanes({ ledger, lanes, targetBranch: 'gru/marker-owner' }).map((blocker) => blocker.jobId),
    ).toEqual(['marker-owner']);
    // ...and never an unrelated target on another live branch.
    expect(findBusyLanes({ ledger, lanes, targetBranch: 'gru/plain-lane' })).toEqual([]);
    // The reverse direction: a marker on the other job must not leak either.
    pending.clear();
    pending.set('plain-lane', [pendingMarker('plain-lane')]);
    expect(
      findBusyLanes({ ledger, lanes, targetBranch: 'gru/plain-lane' }).map((blocker) => blocker.jobId),
    ).toEqual(['plain-lane']);
    expect(findBusyLanes({ ledger, lanes, targetBranch: 'gru/marker-owner' })).toEqual([]);
  });

  it('force=true still admits the fallback gate on a failing pre-flight with a pending-marker fence', async () => {
    const repo = makeFixtureRepo('branch-idle-fallback-force');
    cleanupRepos.push(repo);
    const h = await boot({ preflightFails: true });
    try {
      await createLaneJob(h, repo, { jobId: 'fallback-force', status: 'delivered' });
      h.ledger.beginPendingRebrief({ jobId: 'fallback-force', note: 'n', briefing: 'b' });
      // The fenced request refuses before any fallback work...
      expect((await postReview(h, { job_id: 'fallback-force' })).status).toBe(409);
      expect(h.fallbackRuns).toHaveLength(0);
      // ...while the explicit owner override still admits the fallback gate,
      // and a fallback reviewer actually starts (audited force tag).
      const passed = joinJobEvent(
        h,
        'fallback-force',
        'job.fallback-review',
        (event) => (event.payload as { phase?: string }).phase === 'pass',
      );
      const forced = await postReview(h, { job_id: 'fallback-force', force: true });
      expect(forced.status).toBe(202);
      expect(forced.json).toMatchObject({ route: 'bmad-review-fallback', skill_installed: true });
      await passed;
      expect(h.fallbackRuns).toHaveLength(1);
      const forcedEvents = h.ledger
        .listJobEvents('fallback-force')
        .filter((event) => event.kind === 'branch-idle.forced');
      expect(forcedEvents.length).toBeGreaterThan(0);
      expect((forcedEvents[0]?.payload as { phase?: string }).phase).toBe('arm');
      expect((forcedEvents[0]?.payload as { blockers?: unknown[] }).blockers).toHaveLength(1);
      expect(h.ledger.listJobEvents('fallback-force').some((event) => event.kind === 'branch-idle.refused')).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('force=true remains the audited human escape hatch for a pending-marker fence (never an operations default)', async () => {
    const repo = makeFixtureRepo('branch-idle-rebrief-force');
    cleanupRepos.push(repo);
    const h = await boot();
    try {
      await createLaneJob(h, repo, { jobId: 'rebrief-force', status: 'delivered' });
      h.ledger.beginPendingRebrief({ jobId: 'rebrief-force', note: 'n', briefing: 'b' });
      // The lane is delivered, yet the unresolved request fences it: the
      // marker fence — not a status — is what a human override must clear.
      expect((await postReview(h, { job_id: 'rebrief-force' })).status).toBe(409);
      const forced = await postReview(h, { job_id: 'rebrief-force', force: true });
      expect(forced.status).toBe(202);
      const roundId = forced.json['round_id'] as string;
      const manifest = JSON.parse(readFileSync(join(h.artifactRoot, roundId, 'manifest.json'), 'utf8')) as {
        branchIdle?: { forced: boolean; targetBranch: string; blockers: readonly unknown[] };
      };
      expect(manifest.branchIdle).toEqual({
        forced: true,
        targetBranch: 'gru/rebrief-force',
        blockers: [{ jobId: 'rebrief-force', status: 'delivered', branch: 'gru/rebrief-force' }],
      });
      const forcedEvents = h.ledger
        .listJobEvents('rebrief-force')
        .filter((event) => event.kind === 'branch-idle.forced');
      expect(forcedEvents.map((event) => (event.payload as { phase?: string }).phase).sort()).toEqual([
        'arm',
        'freeze',
      ]);
      expect((forcedEvents[0]?.payload as { forced?: boolean }).forced).toBe(true);
      expect(h.ledger.listJobEvents('rebrief-force').some((event) => event.kind === 'branch-idle.refused')).toBe(true);
    } finally {
      await h.close();
    }
  });
});
