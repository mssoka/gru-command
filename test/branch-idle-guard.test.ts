import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, type DirectiveRequestRecord, type EventRecord, type JobRecord, type JobStatus, type PendingRebriefRecord } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { DEFAULT_SILAS_CONFIG, loadConfig, type Role } from '../src/config.js';
import type { AgentHandle, SpawnOptions } from '../src/runtime/types.js';
import type { PacingGate } from '../src/runtime/pacing.js';
import type { FallbackFinding } from '../src/dispatch/review-path.js';
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
import { finalizeRebriefRequest, reconcilePendingRebriefs } from '../src/dispatch/rebrief-recovery.js';
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

  createChildWorktree(input: {
    repoPath: string;
    jobId: string;
    childId: string;
    parentPath: string;
    authority: 'read-only' | 'writer';
  }): Promise<WorktreeLane> {
    return this.delegate.createChildWorktree(input);
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
  readonly notifications: NotificationCenter;
  readonly artifactRoot: string;
  /** Fallback-gate passes that actually started a fallback reviewer. */
  readonly fallbackRuns: number[];
  /** Escalation lines raised by the wave (held-handoff and gate audits). */
  readonly escalations: string[];
  /** Every spawner invocation (role + cwd) the wave attempted. */
  readonly spawnCalls: { readonly role: string; readonly cwd: string | undefined }[];
  close(): Promise<void>;
}

async function boot(opts: {
  onReviewLane?: () => void;
  onPreflight?: () => void | Promise<void>;
  /** The pre-flight resolves as FAILED (routes to the fallback gate). */
  preflightFails?: boolean;
  /** Per-iteration findings for the custom fallback double (default []). */
  onFallbackReview?: (iteration: number) => readonly FallbackFinding[] | Promise<readonly FallbackFinding[]>;
  /** Called when the gate routes a fix directive (between rounds). */
  onFixDirective?: () => void;
  /** Use the production default fallback reviewer (no custom runFallbackReview). */
  fallbackDefault?: boolean;
  /** Optional deferred reviewer allocation; no provider is spawned. */
  onSpawner?: () => Promise<AgentHandle>;
  /** Worker-turn admission gate forwarded to the wave (default reviewer path). */
  workerGate?: PacingGate;
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
  const spawnCalls: { role: Role; cwd: string | undefined }[] = [];
  const spawner = async (role: Role, options?: SpawnOptions): Promise<AgentHandle> => {
    spawnCalls.push({ role, cwd: options?.cwd });
    if (opts.onSpawner !== undefined) return opts.onSpawner();
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
      ...(opts.fallbackDefault === true
        ? {}
        : {
            runFallbackReview: async (input) => {
              fallbackRuns.push(1);
              return opts.onFallbackReview?.(input.iteration) ?? [];
            },
          }),
      fixDirectiveSink: async () => {
        opts.onFixDirective?.();
        return { delivered: true as const };
      },
    },
    ...(opts.workerGate !== undefined ? { workerGate: opts.workerGate } : {}),
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
    notifications,
    artifactRoot,
    fallbackRuns,
    escalations,
    spawnCalls,
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

/** One release-safety blocker finding for the custom fallback double. */
function fallbackBlocker(title = 'Release-safety blocker'): FallbackFinding {
  return {
    title,
    category: 'correctness',
    location: 'src/a.ts',
    evidence: 'return 1;',
    detail: 'The change breaks the contract.',
  };
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
    // Ordinary re-brief (no explicit completion intent): PR136's
    // phase-handoff identity is optional and null here.
    phaseId: null,
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
      // Real-time tick: review setup awaits real async subprocess work
      // (the admission remote probe), which bare setImmediate drains past.
      setTimeout(() => {
        if (settled) return;
        if (sweeps >= 400) {
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
    displayName: null,
    deliverable: null,
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
    const midTurnLink = eventRecord(2, 'job.status', { from: 'working', to: 'in-review' });
    const settledLink = eventRecord(3, 'job.status', { from: 'delivered', to: 'in-review' });
    // A prior attempt delivered, a fix loop reopened the lane, and a PR
    // link moved that still-open attempt to in-review.
    const firstLink = eventRecord(3, 'job.status', { from: 'working', to: 'in-review' });
    const reopened = eventRecord(4, 'job.status', { from: 'in-review', to: 'working' });
    const reopenedLink = eventRecord(5, 'job.status', { from: 'working', to: 'in-review' });
    // Issue #162: an explicit repair start without a status hop.
    const repairStart = eventRecord(3, 'silas.directive-sent', { request_id: 'r1' });
    const events = new Map<string, EventRecord[]>([
      ['never-started', []],
      ['settled', [start, delivery]],
      ['reopened', [start, delivery, reopen]],
      ['open', [start]],
      ['linked-mid-turn', [start, midTurnLink]],
      ['linked-mid-turn-late-delivery', [start, midTurnLink, eventRecord(4, 'job.delivered', { sha: 'sha-2' })]],
      ['linked-after-delivery', [start, delivery, settledLink]],
      ['reopened-mid-turn', [start, delivery, firstLink, reopened, reopenedLink]],
      ['repair-start', [start, delivery, repairStart]],
      ['repair-delivered', [start, delivery, repairStart, eventRecord(4, 'job.delivered', { sha: 'sha-2' })]],
      ['recovery-claim', [start, delivery, eventRecord(3, 'provider.recovery-claimed', { wait_id: 'w' })]],
      ['dispatch-live', [start, delivery]],
    ]);
    const ledger = {
      listJobs: () => [
        jobRecord('never-started', 'dispatched'),
        jobRecord('settled', 'working'),
        jobRecord('reopened', 'working'),
        jobRecord('open', 'working'),
        jobRecord('delivered', 'delivered'),
        jobRecord('linked-mid-turn', 'in-review'),
        jobRecord('linked-mid-turn-late-delivery', 'in-review'),
        jobRecord('linked-after-delivery', 'in-review'),
        jobRecord('reopened-mid-turn', 'in-review'),
        jobRecord('repair-start', 'working'),
        jobRecord('repair-delivered', 'working'),
        jobRecord('recovery-claim', 'working'),
        jobRecord('dispatch-live', 'working'),
      ],
      latestJobEvent: (jobId: string, kind: string): EventRecord | null =>
        (events.get(jobId) ?? []).filter((event) => event.kind === kind).at(-1) ?? null,
      listJobEvents: (jobId: string): readonly EventRecord[] =>
        [...(events.get(jobId) ?? [])].reverse(),
      listPendingRebriefs: (): readonly PendingRebriefRecord[] => [],
      listPendingDirectives: (opts: { readonly jobId?: string } = {}): readonly DirectiveRequestRecord[] =>
        opts.jobId === 'dispatch-live'
          ? ([{ requestId: 'r-live', jobId: opts.jobId, state: 'dispatching' }] as unknown as readonly DirectiveRequestRecord[])
          : [],
      hasUnsettledVerificationRun: (): boolean => false,
    };
    const busy = (id: string): boolean => laneIsBusy(ledger, ledger.listJobs().find((job) => job.id === id)!);
    expect(busy('never-started')).toBe(true);
    expect(busy('settled')).toBe(false);
    expect(busy('reopened')).toBe(true);
    expect(busy('open')).toBe(true);
    expect(busy('delivered')).toBe(false);
    // A PR link moves an OPEN attempt to in-review before it settles: the
    // lane is still a writer until its delivery lands.
    expect(busy('linked-mid-turn')).toBe(true);
    expect(busy('linked-mid-turn-late-delivery')).toBe(false);
    // A delivered → in-review flip starts no attempt at all.
    expect(busy('linked-after-delivery')).toBe(false);
    // The prior delivery settled attempt 1; the reopened attempt (working)
    // is still open after the PR link flipped it to in-review.
    expect(busy('reopened-mid-turn')).toBe(true);
    // A directive admission or provider-recovery claim after the delivery
    // is a repair phase even without a status hop — review must wait for it.
    expect(busy('repair-start')).toBe(true);
    expect(busy('recovery-claim')).toBe(true);
    // A delivery newer than the repair start settles that phase.
    expect(busy('repair-delivered')).toBe(false);
    // An accepted but not-yet-admitted directive already owns the lane.
    expect(busy('dispatch-live')).toBe(true);

    const lanes = [
      laneRecord('reopened', 'reopened', 'gru/reopened'),
      laneRecord('settled', 'settled', 'gru/settled'),
      laneRecord('repair-start', 'repair-start', 'gru/repair-start'),
    ];
    expect(findBusyLanes({ ledger, lanes, targetBranch: 'gru/reopened' }).map((blocker) => blocker.jobId)).toEqual([
      'reopened',
    ]);
    expect(findBusyLanes({ ledger, lanes, targetBranch: 'gru/repair-start' }).map((blocker) => blocker.jobId)).toEqual([
      'repair-start',
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

  it('resolves the attempt hop beyond the first page and clears an unreachable history on delivery', () => {
    // 255 events newer than the flip push the working hop past the first
    // 200-event page; the paged lookup must keep walking.
    const pagedHistory = [
      eventRecord(1, 'job.status', { from: 'dispatched', to: 'working' }),
      ...Array.from({ length: 255 }, (_, i) => eventRecord(i + 2, 'job.note', {})),
      eventRecord(257, 'job.status', { from: 'working', to: 'in-review' }),
      eventRecord(400, 'job.delivered', { sha: 'sha-paged' }),
    ];
    const paged = {
      listJobs: () => [jobRecord('paged', 'in-review')],
      latestJobEvent: (_jobId: string, kind: string): EventRecord | null =>
        pagedHistory.filter((event) => event.kind === kind).at(-1) ?? null,
      listJobEvents: (_jobId: string, opts?: { readonly limit?: number }): readonly EventRecord[] =>
        [...pagedHistory].reverse().slice(0, opts?.limit ?? 200),
      listPendingRebriefs: (): readonly PendingRebriefRecord[] => [],
      listPendingDirectives: (): readonly DirectiveRequestRecord[] => [],
      hasUnsettledVerificationRun: (): boolean => false,
    };
    expect(laneIsBusy(paged, paged.listJobs()[0]!)).toBe(false);

    // A history whose hop is unreachable within the page cap: a delivery
    // newer than the flip still clears the attempt (never permanent busy).
    const fillerCount = 12_900;
    const cappedHistory = [
      eventRecord(1, 'job.status', { from: 'dispatched', to: 'working' }),
      eventRecord(2, 'job.status', { from: 'working', to: 'in-review' }),
      ...Array.from({ length: fillerCount }, (_, i) => eventRecord(i + 3, 'job.note', {})),
      eventRecord(fillerCount + 3, 'job.delivered', { sha: 'sha-late' }),
    ];
    const capped = {
      listJobs: () => [jobRecord('capped', 'in-review')],
      latestJobEvent: (_jobId: string, kind: string): EventRecord | null =>
        cappedHistory.filter((event) => event.kind === kind).at(-1) ?? null,
      listJobEvents: (_jobId: string, opts?: { readonly limit?: number }): readonly EventRecord[] =>
        [...cappedHistory].reverse().slice(0, opts?.limit ?? 200),
      listPendingRebriefs: (): readonly PendingRebriefRecord[] => [],
      listPendingDirectives: (): readonly DirectiveRequestRecord[] => [],
      hasUnsettledVerificationRun: (): boolean => false,
    };
    expect(laneIsBusy(capped, capped.listJobs()[0]!)).toBe(false);
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

  it('refuses the arm while a PR link moved the lane to in-review before its delivery, then passes on the settled head', async () => {
    const repo = makeFixtureRepo('branch-idle-in-review');
    cleanupRepos.push(repo);
    const h = await boot();
    try {
      const lane = await createLaneJob(h, repo, { jobId: 'mid-turn-link', status: 'in-review' });
      const refused = await postReview(h, { job_id: 'mid-turn-link' });
      expect(refused.status).toBe(409);
      expect(refused.json).toEqual({
        error: 'branch_busy',
        blockers: [{ job_id: 'mid-turn-link', status: 'in-review', branch: 'gru/mid-turn-link' }],
        hint: BRANCH_BUSY_HINT,
      });
      expect(h.ledger.listRounds('mid-turn-link')).toHaveLength(0);
      expect(h.worktrees.listWorktrees({ jobId: 'mid-turn-link' }).filter((row) => row.kind === 'review')).toHaveLength(0);

      // The open attempt settles: the same arm now passes on that head.
      const sha = execFileSync('git', ['-C', lane.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'mid-turn-link', payload: { sha } });
      const passed = await postReview(h, { job_id: 'mid-turn-link' });
      expect(passed.status).toBe(202);
      expect(passed.json['round_id']).toBe('mid-turn-link-r1');
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
      ['blocked-pending', [start]],
      ['parked-pending', [start]],
      ['done-pending', [start, delivery, toInReview]],
      ['settled', [start, delivery]],
    ]);
    const pending = new Map<string, PendingRebriefRecord[]>([
      ['working-pending', [pendingMarker('working-pending')]],
      ['delivered-pending', [pendingMarker('delivered-pending')]],
      // Only one of the two guarded markers remains — still unresolved.
      ['in-review-pending', [pendingMarker('in-review-pending', 'job.delivered')]],
      ['merged-pending', [pendingMarker('merged-pending')]],
      // Recoverable side-states were never busy without a marker; the
      // resolved request is what fences them now.
      ['blocked-pending', [pendingMarker('blocked-pending')]],
      ['parked-pending', [pendingMarker('parked-pending')]],
      ['done-pending', [pendingMarker('done-pending')]],
    ]);
    const ledger = {
      listJobs: () => [
        jobRecord('working-pending', 'working'),
        jobRecord('delivered-pending', 'delivered'),
        jobRecord('in-review-pending', 'in-review'),
        jobRecord('merged-pending', 'merged'),
        jobRecord('blocked-pending', 'blocked'),
        jobRecord('parked-pending', 'parked'),
        jobRecord('done-pending', 'done'),
        jobRecord('settled', 'delivered'),
      ],
      latestJobEvent: (jobId: string, kind: string): EventRecord | null =>
        (events.get(jobId) ?? []).filter((event) => event.kind === kind).at(-1) ?? null,
      listJobEvents: (jobId: string): readonly EventRecord[] =>
        [...(events.get(jobId) ?? [])].reverse(),
      listPendingRebriefs: (opts: { readonly jobId?: string } = {}): readonly PendingRebriefRecord[] =>
        opts.jobId === undefined ? [...pending.values()].flat() : (pending.get(opts.jobId) ?? []),
      listPendingDirectives: (): readonly DirectiveRequestRecord[] => [],
      hasUnsettledVerificationRun: (): boolean => false,
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
    // Recoverable side-states are marker-fenced (they carry no attempt);
    // terminal `done` keeps the terminal short-circuit even with a marker.
    expect(busy('blocked-pending')).toBe(true);
    expect(busy('parked-pending')).toBe(true);
    expect(busy('done-pending')).toBe(false);
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

  it('a live directive intent refuses the arm before its admission lands', async () => {
    const repo = makeFixtureRepo('branch-idle-directive-arm');
    cleanupRepos.push(repo);
    let preflights = 0;
    const h = await boot({ onPreflight: () => { preflights += 1; } });
    try {
      await createLaneJob(h, repo, { jobId: 'directive-arm', status: 'delivered' });
      // dispatching: side effects are possible, admission is not recorded yet.
      h.ledger.beginDirectiveIntent({ jobId: 'directive-arm', directive: 'fix it', holder: 'silas-ops' });
      const refused = await postReview(h, { job_id: 'directive-arm' });
      expect(refused.status).toBe(409);
      expect(refused.json).toMatchObject({ error: 'branch_busy', blockers: [{ job_id: 'directive-arm' }] });
      expect(preflights).toBe(0);
      expect(h.ledger.listRounds('directive-arm')).toHaveLength(0);
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

  it('a terminal transition during review worktree creation cannot become branch_busy or roll back to working', async () => {
    const repo = makeFixtureRepo('branch-idle-terminal-freeze');
    cleanupRepos.push(repo);
    let complete: (() => void) | null = null;
    const h = await boot({ onReviewLane: () => complete?.() });
    try {
      await createLaneJob(h, repo, { jobId: 'terminal-freeze', status: 'working' });
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'terminal-freeze', payload: { sha: 'old-head' } });
      complete = () => { h.ledger.setJobStatus('terminal-freeze', 'done'); };
      const result = await postReview(h, { job_id: 'terminal-freeze' });
      expect(result.status).not.toBe(202);
      expect(h.ledger.getJob('terminal-freeze')?.status).toBe('done');
      expect(h.ledger.listRounds('terminal-freeze')).toMatchObject([{ status: 'aborted' }]);
      expect(h.ledger.listJobEvents('terminal-freeze').some((event) => event.kind === 'branch-idle.refused')).toBe(false);
      expect(findBusyLanes({ ledger: h.ledger, lanes: h.worktrees.listWorktrees(),
        targetBranch: 'gru/terminal-freeze', reviewedStatus: { jobId: 'terminal-freeze', status: 'working' } })).toEqual([]);
    } finally { await h.close(); }
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

      // A manual marker-clear isolates the replay guard; the next case
      // exercises the real finalizer's delivery-before-clear ordering.
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

  it('a real re-brief finalizer wakes a queued handoff after clearing its markers, without a sweep', async () => {
    const repo = makeFixtureRepo('branch-idle-rebrief-finalizer-replay');
    cleanupRepos.push(repo);
    const h = await boot();
    try {
      const lane = await createLaneJob(h, repo, { jobId: 'finalizer-replay', status: 'working' });
      const queued = await postReview(h, { job_id: 'finalizer-replay', by: 'minion' });
      expect(queued.json).toMatchObject({ route: 'queued' });
      h.ledger.beginPendingRebrief({ jobId: 'finalizer-replay', note: 'n', briefing: 'b' });
      const startedPromise = joinJobEvent(h, 'finalizer-replay', 'job.review-handoff-started');
      const finalized = finalizeRebriefRequest({
        ledger: h.ledger, worktrees: h.worktrees, jobId: 'finalizer-replay',
        minionId: 'minion-fresh', lanePath: lane.path, note: 'n',
      });
      expect(finalized).toMatchObject({ rebriefRecorded: true, deliveryRecorded: true });
      const started = await startedPromise;
      expect(started.payload).toMatchObject({ requestSeq: queued.json['request_seq'], route: 'perkins' });
      expect(h.ledger.listPendingRebriefs({ jobId: 'finalizer-replay' })).toHaveLength(0);
      expect(h.ledger.listRounds('finalizer-replay')).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('a replaced checkout during failing preflight is refused instead of reviewing the stale path', async () => {
    const oldRepo = makeFixtureRepo('branch-idle-fallback-old-path');
    const newRepo = makeFixtureRepo('branch-idle-fallback-new-path');
    cleanupRepos.push(oldRepo, newRepo);
    const entered = deferred();
    const release = deferred();
    const h = await boot({ preflightFails: true,
      onPreflight: async () => { entered.release(); await release.promise; } });
    try {
      const old = await createLaneJob(h, oldRepo, { jobId: 'fallback-new-path', status: 'delivered' });
      const pending = postReview(h, { job_id: 'fallback-new-path' });
      await entered.promise;
      const originalList = h.worktrees.listWorktrees.bind(h.worktrees);
      vi.spyOn(h.worktrees, 'listWorktrees').mockImplementation((opts = {}) =>
        originalList(opts).map((lane) => lane.id === old.id ? { ...lane, path: newRepo.path } : lane));
      release.release();
      const refused = await pending;
      expect(refused.status).not.toBe(202);
      expect(h.fallbackRuns).toHaveLength(0);
      expect(newRepo.path).not.toBe(old.path);
      expect(h.ledger.listJobEvents('fallback-new-path').some((event) =>
        event.kind === 'job.fallback-review' && (event.payload as { phase?: string }).phase === 'pass')).toBe(false);
    } finally { release.release(); await h.close(); }
  });

  it('a running fallback for a foreign target aborts if its reviewed checkout is replaced', async () => {
    const repo = makeFixtureRepo('branch-idle-fallback-review-path');
    const replacement = makeFixtureRepo('branch-idle-fallback-review-replacement');
    cleanupRepos.push(repo, replacement);
    const entered = deferred();
    const release = deferred();
    const h = await boot({ preflightFails: true,
      onFallbackReview: async () => { entered.release(); await release.promise; return []; } });
    try {
      const old = await createLaneJob(h, repo, { jobId: 'fallback-review-path', status: 'delivered' });
      await createLaneJob(h, repo, { jobId: 'fallback-review-target', status: 'delivered' });
      const abortedPromise = joinJobEvent(h, 'fallback-review-path', 'job.fallback-review',
        (event) => (event.payload as { phase?: string }).phase === 'aborted');
      expect((await postReview(h, { job_id: 'fallback-review-path', target_ref: 'gru/fallback-review-target' })).status).toBe(202);
      await entered.promise;
      const originalList = h.worktrees.listWorktrees.bind(h.worktrees);
      vi.spyOn(h.worktrees, 'listWorktrees').mockImplementation((opts = {}) =>
        originalList(opts).map((lane) => lane.id === old.id ? { ...lane, path: replacement.path } : lane));
      release.release();
      expect((await abortedPromise).payload).toMatchObject({ clearToMerge: false });
      expect(h.ledger.listJobEvents('fallback-review-path').some((event) =>
        event.kind === 'job.fallback-review' && (event.payload as { phase?: string }).phase === 'pass')).toBe(false);
    } finally { release.release(); await h.close(); }
  });

  it('a re-brief admitted during a forced preflight is not covered by the earlier audited override', async () => {
    const repo = makeFixtureRepo('branch-idle-fallback-force-preflight');
    cleanupRepos.push(repo);
    const entered = deferred();
    const release = deferred();
    const h = await boot({ preflightFails: true,
      onPreflight: async () => { entered.release(); await release.promise; } });
    try {
      await createLaneJob(h, repo, { jobId: 'fallback-force-preflight', status: 'delivered' });
      const pending = postReview(h, { job_id: 'fallback-force-preflight', force: true });
      await entered.promise;
      h.ledger.beginPendingRebrief({ jobId: 'fallback-force-preflight', note: 'new request', briefing: 'b' });
      release.release();
      expect((await pending).status).not.toBe(202);
      expect(h.fallbackRuns).toHaveLength(0);
      // Only the original arm was authorized. A second forced audit row
      // would falsely claim the owner waived the newer request.
      const forced = h.ledger.listJobEvents('fallback-force-preflight')
        .filter((event) => event.kind === 'branch-idle.forced');
      expect(forced).toHaveLength(1);
      expect(forced[0]?.payload).toMatchObject({ phase: 'arm', blockers: [] });
    } finally { release.release(); await h.close(); }
  });

  async function assertBootRecoveryReplay(path: 'already-landed' | 'delivery-only'): Promise<void> {
    const repo = makeFixtureRepo(`branch-idle-boot-replay-${path}`);
    cleanupRepos.push(repo);
    const h = await boot();
    const jobId = `boot-replay-${path}`;
    try {
      const lane = await createLaneJob(h, repo, { jobId, status: 'working' });
      expect((await postReview(h, { job_id: jobId, by: 'minion' })).json).toMatchObject({ route: 'queued' });
      h.ledger.setJobStatus(jobId, 'delivered');
      h.ledger.beginPendingRebrief({ jobId, note: 'recover', briefing: 'b' });
      h.ledger.appendCustomEvent({ kind: 'silas.rebrief', jobId, payload: { minion_id: 'restored' } });
      if (path === 'already-landed') {
        const sha = execFileSync('git', ['-C', lane.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
        h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { sha, source: 'silas-rebrief' } });
      }
      const startedPromise = joinJobEvent(h, jobId, 'job.review-handoff-started');
      const report = await reconcilePendingRebriefs({
        ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications,
        registry: { getHandle: () => null,
          spawn: async () => { throw new Error('boot recovery must not spawn a minion on this path'); },
          disposeHandle: async () => {} },
      }, { bootAt: new Date(Date.now() + 60_000) });
      await report.settled;
      expect(report.completed).toBe(1);
      expect((await startedPromise).jobId).toBe(jobId);
      expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
      expect(h.ledger.listRounds(jobId)).toHaveLength(1);
    } finally { await h.close(); }
  }

  it('already-landed boot recovery starts a queued handoff without a manual sweep', async () => {
    await assertBootRecoveryReplay('already-landed');
  });

  it('delivery-only boot recovery starts a queued handoff without a manual sweep', async () => {
    await assertBootRecoveryReplay('delivery-only');
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
    // Both lanes are genuinely settled (delivered, no open attempt): the
    // only busy fact in play is the pending marker, so branch isolation is
    // exercised without attempt-busyness noise.
    const events = new Map<string, EventRecord[]>([
      ['marker-owner', [start, delivery]],
      ['plain-lane', [start, delivery]],
    ]);
    const pending = new Map<string, PendingRebriefRecord[]>([
      ['marker-owner', [pendingMarker('marker-owner')]],
    ]);
    const ledger = {
      listJobs: () => [jobRecord('marker-owner', 'delivered'), jobRecord('plain-lane', 'delivered')],
      latestJobEvent: (jobId: string, kind: string): EventRecord | null =>
        (events.get(jobId) ?? []).filter((event) => event.kind === kind).at(-1) ?? null,
      listJobEvents: (jobId: string): readonly EventRecord[] =>
        [...(events.get(jobId) ?? [])].reverse(),
      listPendingRebriefs: (opts: { readonly jobId?: string } = {}): readonly PendingRebriefRecord[] =>
        opts.jobId === undefined ? [...pending.values()].flat() : (pending.get(opts.jobId) ?? []),
      listPendingDirectives: (): readonly DirectiveRequestRecord[] => [],
      hasUnsettledVerificationRun: (): boolean => false,
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
      // Exact audit shape: the fallback route re-enters the arm-phase guard
      // (intake + post-pre-flight) — two `arm` override records, where the
      // native route records `arm` + `freeze` (pinned in the sibling case).
      const forcedEvents = h.ledger
        .listJobEvents('fallback-force')
        .filter((event) => event.kind === 'branch-idle.forced');
      expect(
        forcedEvents.map((event) => (event.payload as { phase?: string }).phase),
      ).toEqual(['arm', 'arm']);
      for (const event of forcedEvents) {
        expect((event.payload as { blockers?: readonly unknown[] }).blockers).toHaveLength(1);
        expect((event.payload as { forced?: boolean }).forced).toBe(true);
      }
      expect(h.ledger.listJobEvents('fallback-force').some((event) => event.kind === 'branch-idle.refused')).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('a pending re-brief that lands during a fallback reviewer prevents a stale PASS', async () => {
    const repo = makeFixtureRepo('branch-idle-fallback-stale-pass');
    cleanupRepos.push(repo);
    const entered = deferred();
    const release = deferred();
    const h = await boot({
      preflightFails: true,
      onFallbackReview: async () => {
        entered.release();
        await release.promise;
        return [];
      },
    });
    try {
      await createLaneJob(h, repo, { jobId: 'fallback-stale-pass', status: 'delivered' });
      const abortedPromise = joinJobEvent(h, 'fallback-stale-pass', 'job.fallback-review',
        (event) => (event.payload as { phase?: string }).phase === 'aborted');
      const review = await postReview(h, { job_id: 'fallback-stale-pass' });
      expect(review.status).toBe(202);
      await entered.promise;
      h.ledger.beginPendingRebrief({ jobId: 'fallback-stale-pass', note: 'n', briefing: 'b' });
      release.release();
      const aborted = await abortedPromise;
      expect(aborted.payload).toMatchObject({ phase: 'aborted', clearToMerge: false });
      expect(h.ledger.listJobEvents('fallback-stale-pass').some((event) =>
        event.kind === 'job.fallback-review' && (event.payload as { phase?: string }).phase === 'pass')).toBe(false);
    } finally {
      release.release();
      await h.close();
    }
  });

  it('a new undelivered working attempt during a fallback reviewer invalidates the old diff', async () => {
    const repo = makeFixtureRepo('branch-idle-fallback-reopened');
    cleanupRepos.push(repo);
    const entered = deferred();
    const release = deferred();
    const h = await boot({ preflightFails: true,
      onFallbackReview: async () => { entered.release(); await release.promise; return []; } });
    try {
      await createLaneJob(h, repo, { jobId: 'fallback-reopened', status: 'delivered' });
      const abortedPromise = joinJobEvent(h, 'fallback-reopened', 'job.fallback-review',
        (event) => (event.payload as { phase?: string }).phase === 'aborted');
      expect((await postReview(h, { job_id: 'fallback-reopened' })).status).toBe(202);
      await entered.promise;
      h.ledger.setJobStatus('fallback-reopened', 'working');
      release.release();
      expect((await abortedPromise).payload).toMatchObject({ clearToMerge: false });
      expect(h.ledger.listJobEvents('fallback-reopened').some((event) =>
        event.kind === 'job.fallback-review' && (event.payload as { phase?: string }).phase === 'pass')).toBe(false);
    } finally { release.release(); await h.close(); }
  });

  it('a reopened attempt hidden by a later in-review status cannot approve the old fallback diff', async () => {
    const repo = makeFixtureRepo('branch-idle-fallback-hidden-attempt');
    cleanupRepos.push(repo);
    const entered = deferred();
    const release = deferred();
    const h = await boot({ preflightFails: true,
      onFallbackReview: async () => { entered.release(); await release.promise; return []; } });
    try {
      await createLaneJob(h, repo, { jobId: 'fallback-hidden-attempt', status: 'delivered' });
      const abortedPromise = joinJobEvent(h, 'fallback-hidden-attempt', 'job.fallback-review',
        (event) => (event.payload as { phase?: string }).phase === 'aborted');
      expect((await postReview(h, { job_id: 'fallback-hidden-attempt' })).status).toBe(202);
      await entered.promise;
      h.ledger.setJobStatus('fallback-hidden-attempt', 'working');
      h.ledger.setJobStatus('fallback-hidden-attempt', 'in-review');
      release.release();
      expect((await abortedPromise).payload).toMatchObject({ clearToMerge: false });
      expect(h.ledger.listJobEvents('fallback-hidden-attempt').some((event) =>
        event.kind === 'job.fallback-review' && (event.payload as { phase?: string }).phase === 'pass')).toBe(false);
    } finally { release.release(); await h.close(); }
  });

  it('a new re-brief admitted during a forced fallback is not included in the earlier override', async () => {
    const repo = makeFixtureRepo('branch-idle-fallback-force-new');
    cleanupRepos.push(repo);
    const entered = deferred();
    const release = deferred();
    const h = await boot({ preflightFails: true,
      onFallbackReview: async () => { entered.release(); await release.promise; return []; } });
    try {
      await createLaneJob(h, repo, { jobId: 'fallback-force-new', status: 'delivered' });
      const abortedPromise = joinJobEvent(h, 'fallback-force-new', 'job.fallback-review',
        (event) => (event.payload as { phase?: string }).phase === 'aborted');
      expect((await postReview(h, { job_id: 'fallback-force-new', force: true })).status).toBe(202);
      await entered.promise;
      h.ledger.beginPendingRebrief({ jobId: 'fallback-force-new', note: 'new request', briefing: 'b' });
      release.release();
      expect((await abortedPromise).payload).toMatchObject({ clearToMerge: false });
    } finally { release.release(); await h.close(); }
  });

  it('force cannot waive a foreign branch owner admitted while the fallback reviewer waits', async () => {
    const repo = makeFixtureRepo('branch-idle-fallback-force-foreign');
    cleanupRepos.push(repo);
    const entered = deferred();
    const release = deferred();
    const h = await boot({ preflightFails: true,
      onFallbackReview: async () => { entered.release(); await release.promise; return []; } });
    try {
      await createLaneJob(h, repo, { jobId: 'fallback-force-foreign', status: 'delivered' });
      const abortedPromise = joinJobEvent(h, 'fallback-force-foreign', 'job.fallback-review',
        (event) => (event.payload as { phase?: string }).phase === 'aborted');
      expect((await postReview(h, { job_id: 'fallback-force-foreign', force: true })).status).toBe(202);
      await entered.promise;
      const foreign = await createLaneJob(h, repo, { jobId: 'new-foreign-owner', status: 'working' });
      const originalList = h.worktrees.listWorktrees.bind(h.worktrees);
      vi.spyOn(h.worktrees, 'listWorktrees').mockImplementation((opts = {}) =>
        originalList(opts).map((lane) => lane.id === foreign.id ? { ...lane, branch: 'gru/fallback-force-foreign' } : lane));
      release.release();
      expect((await abortedPromise).payload).toMatchObject({ clearToMerge: false });
      expect(h.ledger.listJobEvents('fallback-force-foreign').some((event) =>
        event.kind === 'job.fallback-review' && (event.payload as { phase?: string }).phase === 'pass')).toBe(false);
    } finally { release.release(); await h.close(); }
  });

  it('a re-brief that begins AND settles during a fallback reviewer still invalidates its old diff', async () => {
    const repo = makeFixtureRepo('branch-idle-fallback-settled-race');
    cleanupRepos.push(repo);
    const entered = deferred();
    const release = deferred();
    const h = await boot({
      preflightFails: true,
      onFallbackReview: async () => { entered.release(); await release.promise; return []; },
    });
    try {
      const lane = await createLaneJob(h, repo, { jobId: 'fallback-settled-race', status: 'delivered' });
      const abortedPromise = joinJobEvent(h, 'fallback-settled-race', 'job.fallback-review',
        (event) => (event.payload as { phase?: string }).phase === 'aborted');
      const review = await postReview(h, { job_id: 'fallback-settled-race' });
      expect(review.status).toBe(202);
      await entered.promise;
      h.ledger.beginPendingRebrief({ jobId: 'fallback-settled-race', note: 'n', briefing: 'b' });
      finalizeRebriefRequest({ ledger: h.ledger, worktrees: h.worktrees, jobId: 'fallback-settled-race',
        minionId: 'minion-fresh', lanePath: lane.path, note: 'n' });
      expect(h.ledger.listPendingRebriefs({ jobId: 'fallback-settled-race' })).toHaveLength(0);
      release.release();
      const aborted = await abortedPromise;
      expect(aborted.payload).toMatchObject({ phase: 'aborted', clearToMerge: false });
      expect(String((aborted.payload as { reason?: string }).reason)).toContain('settled');
      expect(h.ledger.listJobEvents('fallback-settled-race').some((event) =>
        event.kind === 'job.fallback-review' && (event.payload as { phase?: string }).phase === 'pass')).toBe(false);
    } finally {
      release.release();
      await h.close();
    }
  });

  it('a re-brief admitted between fallback rounds stops the gate before the next reviewer', async () => {
    const repo = makeFixtureRepo('branch-idle-fallback-interround');
    cleanupRepos.push(repo);
    let admitted = false;
    const h = await boot({
      preflightFails: true,
      onFallbackReview: (iteration) =>
        iteration === 1
          ? [{
              title: 'Release-safety blocker',
              category: 'correctness',
              location: 'src/a.ts',
              evidence: 'return 1;',
              detail: 'The change breaks the contract.',
            }]
          : [],
      onFixDirective: () => {
        if (!admitted) {
          admitted = true;
          h.ledger.beginPendingRebrief({ jobId: 'fallback-interround', note: 'n', briefing: 'b' });
        }
      },
    });
    try {
      await createLaneJob(h, repo, { jobId: 'fallback-interround', status: 'delivered' });
      const abortedPromise = joinJobEvent(
        h,
        'fallback-interround',
        'job.fallback-review',
        (event) => (event.payload as { phase?: string }).phase === 'aborted',
      );
      const review = await postReview(h, { job_id: 'fallback-interround' });
      expect(review.status).toBe(202);
      const aborted = await abortedPromise;
      expect(aborted.payload).toMatchObject({ phase: 'aborted', iteration: 2, clearToMerge: false });
      expect(String((aborted.payload as { reason?: string }).reason)).toContain('re-brief');
      // Round 1 ran; round 2 never reached its diff intake or reviewer.
      expect(h.fallbackRuns).toHaveLength(1);
      expect(h.escalations.some((line) => line.includes('ABORTED'))).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('a re-brief landing in the default reviewer worker-gate wait stops the gate before the spawn', async () => {
    const repo = makeFixtureRepo('branch-idle-fallback-lease');
    cleanupRepos.push(repo);
    const entered = deferred();
    const leaseGate = deferred();
    const workerGate = {
      acquireWorkerTurn: async () => {
        entered.release();
        await leaseGate.promise;
        return { release: () => {}, waitedMs: 0 };
      },
    } as unknown as PacingGate;
    const h = await boot({ preflightFails: true, fallbackDefault: true, workerGate });
    try {
      await createLaneJob(h, repo, { jobId: 'fallback-lease', status: 'delivered' });
      const abortedPromise = joinJobEvent(
        h,
        'fallback-lease',
        'job.fallback-review',
        (event) => (event.payload as { phase?: string }).phase === 'aborted',
      );
      const review = await postReview(h, { job_id: 'fallback-lease' });
      expect(review.status).toBe(202);
      await entered.promise;
      // The gate is queued for a worker turn; a NEW re-brief owns the lane.
      h.ledger.beginPendingRebrief({ jobId: 'fallback-lease', note: 'n', briefing: 'b' });
      leaseGate.release();
      const aborted = await abortedPromise;
      expect(aborted.payload).toMatchObject({ phase: 'aborted', iteration: 1, clearToMerge: false });
      expect(String((aborted.payload as { reason?: string }).reason)).toContain('re-brief');
      // The reviewer never spawned on the revoked lane.
      expect(h.spawnCalls.filter((call) => call.role === 'minion')).toHaveLength(0);
    } finally {
      leaseGate.release();
      await h.close();
    }
  });

  it('a re-brief landing while a fallback reviewer is allocated prevents its obsolete prompt', async () => {
    const repo = makeFixtureRepo('branch-idle-fallback-spawn-race');
    cleanupRepos.push(repo);
    const entered = deferred();
    const release = deferred();
    let prompts = 0;
    let disposed = 0;
    const handle: AgentHandle = {
      role: 'minion', id: 'allocated-reviewer', sessionFile: null,
      capabilities: { streaming: false, steer: 'queued', resume: 'none', images: false,
        thinking: false, thinkingLevelControl: false, followUp: false },
      async prompt() { prompts += 1; },
      async steer() {}, async followUp() {},
      subscribe: () => () => {},
      health: () => ({ state: 'idle', lastActivity: null, sessionFile: null }),
      async dispose() { disposed += 1; },
    };
    const h = await boot({
      preflightFails: true, fallbackDefault: true,
      onSpawner: async () => { entered.release(); await release.promise; return handle; },
    });
    try {
      await createLaneJob(h, repo, { jobId: 'fallback-spawn-race', status: 'delivered' });
      const abortedPromise = joinJobEvent(h, 'fallback-spawn-race', 'job.fallback-review',
        (event) => (event.payload as { phase?: string }).phase === 'aborted');
      const review = await postReview(h, { job_id: 'fallback-spawn-race' });
      expect(review.status).toBe(202);
      await entered.promise;
      h.ledger.beginPendingRebrief({ jobId: 'fallback-spawn-race', note: 'n', briefing: 'b' });
      release.release();
      expect((await abortedPromise).payload).toMatchObject({ phase: 'aborted', clearToMerge: false });
      expect(prompts).toBe(0);
      expect(disposed).toBe(1);
    } finally {
      release.release();
      await h.close();
    }
  });

  it('a lane deregistered during the awaited pre-flight fails the fallback closed instead of reusing the stale path', async () => {
    const repo = makeFixtureRepo('branch-idle-fallback-nolane');
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
      await createLaneJob(h, repo, { jobId: 'fallback-nolane', status: 'delivered' });
      const pending = postReview(h, { job_id: 'fallback-nolane' });
      await entered.promise;
      await h.worktrees.release({ worktreeId: 'fallback-nolane' });
      gate.release();
      const failed = await pending;
      expect(failed.status).toBe(400);
      expect((failed.json as { detail?: string }).detail).toContain('no active job lane');
      // Fail closed: no fallback reviewer, no round, no gate work.
      expect(h.fallbackRuns).toHaveLength(0);
      expect(h.ledger.listRounds('fallback-nolane')).toHaveLength(0);
      expect(h.ledger.listJobEvents('fallback-nolane').some((event) => event.kind === 'job.fallback-review')).toBe(false);
    } finally {
      gate.release();
      await h.close();
    }
  });

  it('a terminal job with a stale marker gets the canonical terminal refusal, never branch_busy', async () => {
    const repo = makeFixtureRepo('branch-idle-terminal-marker');
    cleanupRepos.push(repo);
    const h = await boot({ preflightFails: true });
    try {
      // merged reaches terminal via in-review; done is reachable directly.
      await createLaneJob(h, repo, { jobId: 'terminal-merged', status: 'delivered' });
      h.ledger.beginPendingRebrief({ jobId: 'terminal-merged', note: 'n', briefing: 'b' });
      h.ledger.setJobStatus('terminal-merged', 'in-review');
      h.ledger.setJobStatus('terminal-merged', 'merged');
      await createLaneJob(h, repo, { jobId: 'terminal-done', status: 'delivered' });
      h.ledger.beginPendingRebrief({ jobId: 'terminal-done', note: 'n', briefing: 'b' });
      h.ledger.setJobStatus('terminal-done', 'done');
      for (const [jobId, status] of [['terminal-merged', 'merged'], ['terminal-done', 'done']] as const) {
        const refused = await postReview(h, { job_id: jobId });
        expect(refused.status).toBe(400);
        expect((refused.json as { detail?: string }).detail).toContain(
          `is ${status} — terminal lanes do not go back under review`,
        );
        // No misleading busy audit rows, no gate/reviewer, no resurrection.
        const kinds = h.ledger.listJobEvents(jobId).map((event) => event.kind);
        expect(kinds).not.toContain('branch-idle.refused');
        expect(kinds).not.toContain('branch-idle.forced');
        expect(kinds).not.toContain('job.fallback-review');
        expect(h.ledger.listRounds(jobId)).toHaveLength(0);
        expect(h.ledger.getJob(jobId)?.status).toBe(status);
      }
      expect(h.fallbackRuns).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('an explicit foreign target_ref cannot bypass the reviewed job’s own pending request', async () => {
    const repo = makeFixtureRepo('branch-idle-own-marker-target');
    cleanupRepos.push(repo);
    const h = await boot();
    try {
      await createLaneJob(h, repo, { jobId: 'own-marker', status: 'delivered' });
      await createLaneJob(h, repo, { jobId: 'foreign-target', status: 'delivered' });
      h.ledger.beginPendingRebrief({ jobId: 'own-marker', note: 'n', briefing: 'b' });
      const refused = await postReview(h, { job_id: 'own-marker', target_ref: 'gru/foreign-target' });
      expect(refused.status).toBe(409);
      expect(refused.json).toMatchObject({
        error: 'branch_busy',
        blockers: [{ job_id: 'own-marker', status: 'delivered', branch: 'gru/own-marker' }],
      });
      const refusal = h.ledger
        .listJobEvents('own-marker')
        .find((event) => event.kind === 'branch-idle.refused');
      expect(refusal?.payload).toMatchObject({ phase: 'arm', forced: false });
      // With the request settled, the explicit foreign-target review arms.
      h.ledger.clearPendingRebriefs(
        h.ledger.listPendingRebriefs({ jobId: 'own-marker' }).map((marker) => marker.id),
      );
      expect((await postReview(h, { job_id: 'own-marker', target_ref: 'gru/foreign-target' })).status).toBe(202);
    } finally {
      await h.close();
    }
  });

  it('a fallback admission with an explicit foreign target_ref still fences the reviewed job’s own request', async () => {
    const repo = makeFixtureRepo('branch-idle-own-marker-fallback');
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
      await createLaneJob(h, repo, { jobId: 'own-marker-fallback', status: 'delivered' });
      await createLaneJob(h, repo, { jobId: 'fallback-foreign', status: 'delivered' });
      const pending = postReview(h, { job_id: 'own-marker-fallback', target_ref: 'gru/fallback-foreign' });
      await entered.promise;
      h.ledger.beginPendingRebrief({ jobId: 'own-marker-fallback', note: 'n', briefing: 'b' });
      gate.release();
      const refused = await pending;
      expect(refused.status).toBe(409);
      expect(refused.json).toMatchObject({
        error: 'branch_busy',
        blockers: [{ job_id: 'own-marker-fallback', status: 'delivered', branch: 'gru/own-marker-fallback' }],
      });
      expect(h.fallbackRuns).toHaveLength(0);
      expect(h.ledger.listRounds('own-marker-fallback')).toHaveLength(0);
    } finally {
      gate.release();
      await h.close();
    }
  });

  it('a fallback gate that loses its lane after the first fix aborts with completed-round bookkeeping', async () => {
    const repo = makeFixtureRepo('branch-idle-fallback-lanelost');
    cleanupRepos.push(repo);
    let released = false;
    const h = await boot({
      preflightFails: true,
      onFallbackReview: (iteration) => (iteration === 1 ? [fallbackBlocker()] : []),
      onFixDirective: () => {
        if (!released) {
          released = true;
          void h.worktrees.release({ worktreeId: 'fallback-lanelost' });
        }
      },
    });
    try {
      await createLaneJob(h, repo, { jobId: 'fallback-lanelost', status: 'delivered' });
      const outcome = await h.wave.runRound({ jobId: 'fallback-lanelost' });
      if (!('route' in outcome)) throw new Error('expected the bmad-review fallback route');
      // A3 oracle: one round completed; the event names the round never taken.
      expect(outcome.iterations).toBe(1);
      expect(outcome.note).toContain('aborted');
      expect(h.fallbackRuns).toHaveLength(1);
      const aborted = h.ledger
        .listJobEvents('fallback-lanelost')
        .find(
          (event) => event.kind === 'job.fallback-review' && (event.payload as { phase?: string }).phase === 'aborted',
        );
      expect(aborted).toBeDefined();
      expect(aborted?.payload).toMatchObject({ iteration: 2, clearToMerge: false });
      expect(String((aborted?.payload as { reason?: string }).reason)).toContain('lost its active job lane');
      expect(h.escalations.some((line) => line.includes('ABORTED'))).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('a replay-started fallback gate stops when the job is revoked before the next round', async () => {
    const repo = makeFixtureRepo('branch-idle-replay-revoked-round');
    cleanupRepos.push(repo);
    let revoked = false;
    const h = await boot({
      preflightFails: true,
      onFallbackReview: (iteration) => (iteration === 1 ? [fallbackBlocker()] : []),
      onFixDirective: () => {
        if (!revoked) {
          revoked = true;
          h.ledger.setJobStatus('replay-revoked-round', 'blocked');
        }
      },
    });
    try {
      await createLaneJob(h, repo, { jobId: 'replay-revoked-round', status: 'working' });
      const queued = await postReview(h, { job_id: 'replay-revoked-round', by: 'minion' });
      expect(queued.status).toBe(202);
      expect(queued.json).toMatchObject({ route: 'queued' });
      h.ledger.setJobStatus('replay-revoked-round', 'delivered');
      const abortedPromise = joinJobEvent(
        h,
        'replay-revoked-round',
        'job.fallback-review',
        (event) => (event.payload as { phase?: string }).phase === 'aborted',
      );
      h.wave.reconcilePendingHandoffs();
      const aborted = await abortedPromise;
      expect(aborted.payload).toMatchObject({ phase: 'aborted', iteration: 2, clearToMerge: false });
      expect(String((aborted.payload as { reason?: string }).reason)).toContain('no longer authorized');
      expect(h.fallbackRuns).toHaveLength(1);
      expect(h.escalations.some((line) => line.includes('ABORTED'))).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('a replay-started default reviewer stops when the job is revoked in the worker-gate wait', async () => {
    const repo = makeFixtureRepo('branch-idle-replay-revoked-lease');
    cleanupRepos.push(repo);
    const entered = deferred();
    const leaseGate = deferred();
    const workerGate = {
      acquireWorkerTurn: async () => {
        entered.release();
        await leaseGate.promise;
        return { release: () => {}, waitedMs: 0 };
      },
    } as unknown as PacingGate;
    const h = await boot({ preflightFails: true, fallbackDefault: true, workerGate });
    try {
      await createLaneJob(h, repo, { jobId: 'replay-revoked-lease', status: 'working' });
      const queued = await postReview(h, { job_id: 'replay-revoked-lease', by: 'minion' });
      expect(queued.status).toBe(202);
      h.ledger.setJobStatus('replay-revoked-lease', 'delivered');
      const abortedPromise = joinJobEvent(
        h,
        'replay-revoked-lease',
        'job.fallback-review',
        (event) => (event.payload as { phase?: string }).phase === 'aborted',
      );
      h.wave.reconcilePendingHandoffs();
      await entered.promise;
      h.ledger.setJobStatus('replay-revoked-lease', 'blocked');
      leaseGate.release();
      const aborted = await abortedPromise;
      expect(aborted.payload).toMatchObject({ phase: 'aborted', iteration: 1, clearToMerge: false });
      expect(String((aborted.payload as { reason?: string }).reason)).toContain('no longer authorized');
      expect(h.spawnCalls.filter((call) => call.role === 'minion')).toHaveLength(0);
      expect(h.escalations.some((line) => line.includes('ABORTED'))).toBe(true);
    } finally {
      leaseGate.release();
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
