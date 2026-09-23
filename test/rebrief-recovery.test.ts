import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import type { AgentCapabilities, AgentHandle, SpawnOptions } from '../src/runtime/types.js';
import type { Role } from '../src/config.js';
import { finalizeRebriefRequest, reconcilePendingRebriefs } from '../src/dispatch/rebrief-recovery.js';
import type { DirectiveRegistry } from '../src/dispatch/fix-directive.js';

/**
 * Re-brief restart safety (Silas finding 2026-09-23): the durable marker
 * pair written before a re-brief worker spawns, and the boot reconciler
 * that consumes markers whose guarded events never landed.
 */

const FAKE_CAPABILITIES: AgentCapabilities = {
  streaming: true,
  steer: 'native',
  resume: 'file',
  images: false,
  thinking: false,
  thinkingLevelControl: false,
  followUp: false,
};

const cleanupDirs: string[] = [];
let sharedRepo: FixtureRepo | null = null;

/** One fixture repo for the whole file: job lanes are cheap worktrees. */
function fixtureRepo(): FixtureRepo {
  sharedRepo ??= makeFixtureRepo('fixture-rebrief');
  return sharedRepo;
}

afterEach(() => {
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

afterAll(() => {
  sharedRepo?.cleanup();
  sharedRepo = null;
});

/** Controllable fake registry: workers, prompts, gates, and failures. */
class FakeAgents implements DirectiveRegistry {
  readonly workers: { id: string; role: Role; options: SpawnOptions; prompts: string[] }[] = [];
  readonly disposed: string[] = [];
  failSpawn: Error | null = null;
  failPrompt: Error | null = null;
  /** When set, every minion prompt waits on this gate before settling. */
  gate: Promise<void> | null = null;
  private readonly expectedSessionFile: string | null;

  constructor(expectedSessionFile: string | null = null) {
    this.expectedSessionFile = expectedSessionFile;
  }

  getHandle(id: string): AgentHandle | null {
    const record = this.workers.find((worker) => worker.id === id);
    return record === undefined ? null : this.handleFor(record);
  }

  async spawn(role: Role, options: SpawnOptions = {}): Promise<AgentHandle> {
    if (this.failSpawn !== null) throw this.failSpawn;
    const id = `worker-${this.workers.length + 1}`;
    const record = { id, role, options, prompts: [] as string[] };
    this.workers.push(record);
    return this.handleFor(record);
  }

  async disposeHandle(handle: AgentHandle): Promise<void> {
    this.disposed.push(handle.id);
  }

  private handleFor(record: { id: string; role: Role; options: SpawnOptions; prompts: string[] }): AgentHandle {
    const gate = (): Promise<void> | null => this.gate;
    const failPrompt = (): Error | null => this.failPrompt;
    return {
      role: record.role,
      id: record.id,
      sessionFile: record.options.resumeFile ?? this.expectedSessionFile,
      capabilities: FAKE_CAPABILITIES,
      async prompt(text: string): Promise<void> {
        record.prompts.push(text);
        const pending = gate();
        if (pending !== null) await pending;
        const failure = failPrompt();
        if (failure !== null) throw failure;
      },
      async steer(): Promise<void> {},
      async followUp(): Promise<void> {},
      subscribe(): () => void {
        return () => {};
      },
      health(): { state: 'idle'; lastActivity: null; sessionFile: null } {
        return { state: 'idle', lastActivity: null, sessionFile: null };
      },
      async dispose(): Promise<void> {},
    };
  }
}

interface Harness {
  dir: string;
  db: LedgerDb;
  ledger: LedgerApi;
  notifications: NotificationCenter;
  worktrees: InMemoryWorktreePort;
  registry: FakeAgents;
  lanePath: string | null;
  close: () => void;
}

function makeHarness(opts: { repo?: FixtureRepo | null; sessionFile?: string | null } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-rebrief-'));
  cleanupDirs.push(dir);
  const db = new LedgerDb(dir);
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  const worktrees = new InMemoryWorktreePort(join(dir, 'wtroot'));
  mkdirSync(worktrees.root, { recursive: true });
  const registry = new FakeAgents(opts.sessionFile ?? null);
  const harness: Harness = {
    dir,
    db,
    ledger,
    notifications,
    worktrees,
    registry,
    lanePath: null,
    close: () => db.close(),
  };
  return harness;
}

/** A job with a real git-backed job lane, and a pending re-brief request
 * marker pair (as a crash between marker write and turn completion leaves). */
async function seedPendingRebrief(input: {
  h: Harness;
  jobId: string;
  note?: string;
  briefing?: string;
  bindWorker?: { agentId: string; sessionFile: string | null };
}): Promise<{ path: string; markers: readonly { id: string; kind: string }[] }> {
  const repo = fixtureRepo();
  input.h.ledger.addJob({ id: input.jobId, repo: 'fixture', title: 'stuck lane', briefing: input.briefing ?? 'the original contract' });
  input.h.ledger.setJobStatus(input.jobId, 'working');
  const lane = await input.h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: input.jobId });
  input.h.lanePath = lane.path;
  const markers = input.h.ledger.beginPendingRebrief({
    jobId: input.jobId,
    note: input.note ?? 'same blocker three rounds; try differently',
    briefing: input.briefing ?? 'the original contract',
  });
  if (input.bindWorker !== undefined) {
    input.h.ledger.bindPendingRebriefWorker({
      ids: markers.map((marker) => marker.id),
      agentId: input.bindWorker.agentId,
      sessionFile: input.bindWorker.sessionFile,
    });
  }
  return { path: lane.path, markers };
}

describe('re-brief restart safety (durable markers)', () => {
  it('a pending re-brief marker survives a simulated restart', () => {
    const h = makeHarness();
    h.ledger.addJob({ id: 'restart-job', repo: 'r', title: 't', briefing: 'the contract' });
    const markers = h.ledger.beginPendingRebrief({
      jobId: 'restart-job',
      note: 'stuck on the same blocker',
      briefing: 'the contract',
    });
    expect(markers.map((marker) => marker.kind).sort()).toEqual(['job.delivered', 'silas.rebrief']);
    const rebrief = markers.find((marker) => marker.kind === 'silas.rebrief');
    expect(rebrief?.note).toBe('stuck on the same blocker');
    expect(rebrief?.briefing).toBe('the contract');
    expect(rebrief?.payloadHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(rebrief?.requestedAt).toBeTruthy();

    // Simulated restart: the same data dir reopens; markers are still there.
    h.db.close();
    const db2 = new LedgerDb(h.dir);
    const ledger2 = new LedgerApi(db2.handle);
    const after = ledger2.listPendingRebriefs({ jobId: 'restart-job' });
    expect(after).toHaveLength(2);
    expect(after.find((marker) => marker.kind === 'silas.rebrief')?.note).toBe('stuck on the same blocker');
    expect(after.find((marker) => marker.kind === 'job.delivered')?.payloadHash).toBe(
      after.find((marker) => marker.kind === 'silas.rebrief')?.payloadHash,
    );
    db2.close();
  });

  it('boot reconciles a fresh marker pair to the recorded events and clears the markers', async () => {
    const h = makeHarness();
    const jobId = 'boot-job';
    const { path } = await seedPendingRebrief({ h, jobId });
    const report = await reconcilePendingRebriefs(
      {
        registry: h.registry,
        ledger: h.ledger,
        worktrees: h.worktrees,
        notifications: h.notifications,
      },
      { bootAt: new Date(Date.now() + 60_000) },
    );
    expect(report.examined).toBe(2);
    expect(report.redispatched).toBe(1);
    await report.settled;

    // The re-brief turn was re-dispatched on the SAME lane, fresh worker.
    expect(h.registry.workers).toHaveLength(1);
    expect(h.registry.workers[0]?.options.cwd).toBe(path);
    expect(h.registry.workers[0]?.options.resumeFile).toBeUndefined();
    const prompt = h.registry.workers[0]?.prompts[0] ?? '';
    expect(prompt).toContain('Re-brief — job boot-job');
    expect(prompt).toContain('same blocker three rounds; try differently');
    expect(prompt).toContain('the original contract');

    // Both guarded events landed; the delivery carries the lane head.
    const rebrief = h.ledger.latestJobEvent(jobId, 'silas.rebrief');
    expect(rebrief).not.toBeNull();
    expect(rebrief?.payload).toMatchObject({ minion_id: 'worker-1', note: 'same blocker three rounds; try differently' });
    const delivered = h.ledger.latestJobEvent(jobId, 'job.delivered');
    expect(delivered).not.toBeNull();
    const sha = (delivered?.payload as { sha?: string }).sha;
    expect(sha).toMatch(/^[0-9a-f]{40}$/u);
    expect(h.ledger.listPendingRebriefs()).toHaveLength(0);

    // The recovery itself is on the record.
    const recovered = h.ledger.latestJobEvent(jobId, 'silas.rebrief-recovered');
    expect(recovered?.payload).toMatchObject({ path: 'redispatched', minion_id: 'worker-1' });
  });

  it('boot resumes the interrupted worker session when one exists on disk', async () => {
    const h = makeHarness();
    const jobId = 'resume-job';
    const sessionFile = join(h.dir, 'sessions', 'worker-crashed.jsonl');
    mkdirSync(join(h.dir, 'sessions'), { recursive: true });
    writeFileSync(sessionFile, '{"type":"turn"}\n');
    await seedPendingRebrief({ h, jobId, bindWorker: { agentId: 'worker-crashed', sessionFile } });
    const report = await reconcilePendingRebriefs(
      {
        registry: h.registry,
        ledger: h.ledger,
        worktrees: h.worktrees,
        notifications: h.notifications,
      },
      { bootAt: new Date(Date.now() + 60_000) },
    );
    await report.settled;
    expect(h.registry.workers[0]?.options.resumeFile).toBe(sessionFile);
    expect(h.registry.workers[0]?.options.cwd).toBe(h.lanePath);
    const recovered = h.ledger.latestJobEvent(jobId, 'silas.rebrief-recovered');
    expect(recovered?.payload).toMatchObject({ path: 'resumed' });
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).not.toBeNull();
    expect(h.ledger.listPendingRebriefs()).toHaveLength(0);
  });

  it('double-boot does not double-dispatch: in-flight claims and consumed markers are idempotent', async () => {
    const h = makeHarness();
    const jobId = 'double-boot-job';
    await seedPendingRebrief({ h, jobId });
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      releaseGate = resolveGate;
    });
    h.registry.gate = gate;
    const deps = {
      registry: h.registry,
      ledger: h.ledger,
      worktrees: h.worktrees,
      notifications: h.notifications,
    };
    // Boot #1 dispatches and holds the turn open; boot #2 (same process,
    // overlapping) must not dispatch again.
    const first = await reconcilePendingRebriefs(deps, { bootAt: new Date(Date.now() + 60_000) });
    const second = await reconcilePendingRebriefs(deps, { bootAt: new Date(Date.now() + 60_000) });
    expect(first.redispatched).toBe(1);
    expect(second.examined).toBe(0);
    expect(h.registry.workers).toHaveLength(1);
    releaseGate();
    await first.settled;
    expect(h.ledger.listPendingRebriefs()).toHaveLength(0);

    // Boot #3 after the events landed: the markers are already consumed.
    const third = await reconcilePendingRebriefs(deps, { bootAt: new Date(Date.now() + 120_000) });
    expect(third.examined).toBe(0);
    expect(h.registry.workers).toHaveLength(1);
  });

  it('a failed re-dispatch escalates action-required and keeps the markers for the next boot', async () => {
    const h = makeHarness();
    const jobId = 'failed-job';
    await seedPendingRebrief({ h, jobId });
    h.registry.failSpawn = new Error('provider unavailable');
    const report = await reconcilePendingRebriefs(
      {
        registry: h.registry,
        ledger: h.ledger,
        worktrees: h.worktrees,
        notifications: h.notifications,
      },
      { bootAt: new Date(Date.now() + 60_000) },
    );
    await report.settled;
    const notification = h.ledger.listNotifications().find((row) => row.kind === `silas.rebrief-unreconciled.${jobId}`);
    expect(notification).toBeDefined();
    expect(notification?.routing).toBe('action-required');
    expect(notification?.severity).toBe('error');
    expect(notification?.detail).toContain('provider unavailable');
    // The invariant: markers clear ONLY when the events land — still pending.
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(2);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
  });

  it('records only the lost delivery when silas.rebrief already landed', async () => {
    const h = makeHarness();
    const jobId = 'delivery-only-job';
    await seedPendingRebrief({ h, jobId });
    // The turn settled and `silas.rebrief` posted; the crash hit before the
    // delivery record.
    h.ledger.appendCustomEvent({ kind: 'silas.rebrief', jobId, payload: { minion_id: 'worker-1', note: 'n' } });
    const report = await reconcilePendingRebriefs(
      {
        registry: h.registry,
        ledger: h.ledger,
        worktrees: h.worktrees,
        notifications: h.notifications,
      },
      { bootAt: new Date(Date.now() + 60_000) },
    );
    expect(report.completed).toBe(1);
    await report.settled;
    // No worker re-run: the settled turn is not repeated.
    expect(h.registry.workers).toHaveLength(0);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')?.payload).toMatchObject({ minion_id: 'worker-1' });
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).not.toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-recovered')?.payload).toMatchObject({ path: 'delivery-only' });
    expect(h.ledger.listPendingRebriefs()).toHaveLength(0);
  });

  it('does not reconcile markers younger than the boot', async () => {
    const h = makeHarness();
    const jobId = 'young-job';
    await seedPendingRebrief({ h, jobId });
    const report = await reconcilePendingRebriefs(
      {
        registry: h.registry,
        ledger: h.ledger,
        worktrees: h.worktrees,
        notifications: h.notifications,
      },
      { bootAt: new Date(Date.now() - 60_000) },
    );
    expect(report.examined).toBe(0);
    await report.settled;
    expect(h.registry.workers).toHaveLength(0);
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(2);
  });

  it('finalize is idempotent: a replayed finalize appends no duplicate events', async () => {
    const h = makeHarness();
    const jobId = 'replay-job';
    await seedPendingRebrief({ h, jobId });
    const input = {
      ledger: h.ledger,
      worktrees: h.worktrees,
      jobId,
      minionId: 'worker-9',
      lanePath: h.lanePath,
      note: 'n',
    };
    const first = finalizeRebriefRequest(input);
    expect(first.rebriefRecorded).toBe(true);
    expect(first.deliveryRecorded).toBe(true);
    expect(h.ledger.listPendingRebriefs()).toHaveLength(0);
    const second = finalizeRebriefRequest(input);
    expect(second.rebriefRecorded).toBe(false);
    expect(second.deliveryRecorded).toBe(false);
    const events = h.ledger.listJobEvents(jobId).filter((event) => event.kind === 'silas.rebrief' || event.kind === 'job.delivered');
    expect(events).toHaveLength(2);
  });
});
