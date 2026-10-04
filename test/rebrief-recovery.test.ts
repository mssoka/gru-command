import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, type PendingRebriefRetirement } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import type { AgentCapabilities, AgentHandle, SpawnOptions } from '../src/runtime/types.js';
import type { Role } from '../src/config.js';
import { finalizeRebriefRequest, reconcilePendingRebriefs } from '../src/dispatch/rebrief-recovery.js';
import type { DirectiveRegistry } from '../src/dispatch/fix-directive.js';
import { PacingGate } from '../src/runtime/pacing.js';

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
  readonly disposedSpawned: string[] = [];
  failSpawn: Error | null = null;
  afterSpawn: (() => void) | null = null;
  failPrompt: Error | null = null;
  /** When set, every handle's health() reports an in-band runtime error —
   * the fulfilled-but-failed outcome both real adapters can produce. */
  healthState: 'idle' | 'error' = 'idle';
  healthError: string | null = null;
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
    this.afterSpawn?.();
    return this.handleFor(record);
  }

  async disposeHandle(handle: AgentHandle): Promise<void> {
    this.disposed.push(handle.id);
  }

  private handleFor(record: { id: string; role: Role; options: SpawnOptions; prompts: string[] }): AgentHandle {
    const gate = (): Promise<void> | null => this.gate;
    const failPrompt = (): Error | null => this.failPrompt;
    const healthState = (): 'idle' | 'error' => this.healthState;
    const healthError = (): string | null => this.healthError;
    const disposedSpawned = this.disposedSpawned;
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
      health() {
        const error = healthError();
        return healthState() === 'error'
          ? { state: 'error' as const, lastActivity: null, sessionFile: null, ...(error === null ? {} : { error }) }
          : { state: 'idle' as const, lastActivity: null, sessionFile: null };
      },
      async dispose(): Promise<void> { disposedSpawned.push(record.id); },
    };
  }
}

interface Harness {
  dir: string;
  db: LedgerDb;
  bus: EventBus;
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
    bus,
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

  it('the re-dispatched re-brief waits for a worker pacing slot before spawning', async () => {
    const h = makeHarness();
    const jobId = 'gated-rebrief-job';
    await seedPendingRebrief({ h, jobId });
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const holder = await gate.acquireWorkerTurn({ id: 'holder', label: 'holder' });
    let holderReleased = false;
    const releaseHolder = (): void => { if (!holderReleased) { holderReleased = true; holder.release(); } };
    try {
      const report = await reconcilePendingRebriefs(
        {
          registry: h.registry,
          ledger: h.ledger,
          worktrees: h.worktrees,
          notifications: h.notifications,
          workerGate: gate,
        },
        { bootAt: new Date(Date.now() + 60_000) },
      );
      // The admission queues before any worker exists; the cap is honest.
      await vi.waitFor(() => expect(gate.view().worker.queued).toHaveLength(1), { timeout: 5_000 });
      expect(h.registry.workers).toHaveLength(0);
      releaseHolder();
      await report.settled;
      expect(h.registry.workers).toHaveLength(1);
      expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
      expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).not.toBeNull();
      expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).not.toBeNull();
      expect(gate.view().worker).toMatchObject({ running: 0, queued: [] });
    } finally {
      releaseHolder();
      h.close();
    }
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

  it('a shutdown-cancelled settlement keeps the markers pending for the next boot', async () => {
    const h = makeHarness();
    const jobId = 'shutdown-settlement-job';
    await seedPendingRebrief({ h, jobId });
    const controller = new AbortController();
    let hookEntered!: () => void;
    const entered = new Promise<void>((resolve) => { hookEntered = resolve; });
    const report = await reconcilePendingRebriefs(
      {
        registry: h.registry,
        ledger: h.ledger,
        worktrees: h.worktrees,
        notifications: h.notifications,
        stopSignal: controller.signal,
        retrySettlement: () => { hookEntered(); return new Promise<'recovered'>(() => {}); },
        stopping: () => true,
      },
      { bootAt: new Date(Date.now() + 60_000) },
    );
    await entered;
    controller.abort();
    await report.settled;
    // Markers clear ONLY when the events land: a shutdown-cancelled
    // settlement leaves both for the next boot and posts no incident.
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(2);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    expect(h.ledger.listNotifications().some((row) => row.kind === `silas.rebrief-unreconciled.${jobId}`)).toBe(false);
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

  it('a recovery turn that resolves with an in-band error records no guarded events and keeps the markers (r4 blocker 1)', async () => {
    const h = makeHarness();
    const jobId = 'inband-job';
    await seedPendingRebrief({ h, jobId });
    h.registry.healthState = 'error';
    h.registry.healthError = 'assistant stopReason error';
    const report = await reconcilePendingRebriefs(
      {
        registry: h.registry,
        ledger: h.ledger,
        worktrees: h.worktrees,
        notifications: h.notifications,
      },
      { bootAt: new Date(Date.now() + 60_000) },
    );
    expect(report.redispatched).toBe(1);
    await report.settled;
    // A fulfilled-but-error turn is NOT a delivery: no request event, no
    // delivery event, no phase completion — and the markers stay for the
    // next boot's ladder (never a fabricated success).
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(2);
    // The failure is visible, action-required — never silence.
    const notification = h.ledger.listNotifications().find((row) => row.kind === `silas.rebrief-unreconciled.${jobId}`);
    expect(notification).toBeDefined();
    expect(notification?.routing).toBe('action-required');
    expect(notification?.detail).toContain('in-band runtime error');
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

describe('terminal re-brief retirement', () => {
  it('an older unmarked turn cannot complete or consume a newer ordinary request', async () => {
    const h = makeHarness();
    const jobId = 'unmarked-generation-job';
    await seedPendingRebrief({ h, jobId });
    const older = h.ledger.listPendingRebriefs({ jobId });
    const newer = h.ledger.beginPendingRebrief({ jobId, note: 'new request', briefing: 'the original contract' });
    h.ledger.setJobStatus(jobId, 'in-review');
    const result = finalizeRebriefRequest({
      ledger: h.ledger, worktrees: h.worktrees, jobId, minionId: 'old-worker',
      lanePath: h.lanePath, note: 'old request', expectedMarkers: older,
    });
    expect(result.superseded).toBe(true);
    expect(h.ledger.listPendingRebriefs({ jobId })).toEqual(newer);
    expect(h.ledger.getJob(jobId)?.status).toBe('in-review');
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
  });

  it('terminal finalization ignores foreign-phase events and retires its own markers', async () => {
    const h = makeHarness();
    const jobId = 'foreign-phase-finalize';
    await seedPendingRebrief({ h, jobId });
    const markers = h.ledger.beginPendingRebrief({
      jobId, note: 'phase request', briefing: 'the original contract',
      handoff: { kind: 'gru-decision', decision: 'keep going' },
    });
    h.ledger.appendCustomEvent({ kind: 'silas.rebrief', jobId, payload: { phase_id: 'foreign' } });
    h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { phase_id: 'foreign' } });
    merge(h, jobId);
    const result = finalizeRebriefRequest({
      ledger: h.ledger, worktrees: h.worktrees, jobId, minionId: 'worker',
      lanePath: h.lanePath, note: 'phase request', expectedMarkers: markers,
    });
    expect(result.retired).toBe(true);
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
    expect(retiredAudit(h, jobId)).toHaveLength(2);
    expect(retiredAudit(h, jobId).every((row) => row.guarded_event_landed === false)).toBe(true);
    expect(h.ledger.listJobEvents(jobId).filter((event) =>
      event.kind === 'silas.rebrief' || event.kind === 'job.delivered')).toHaveLength(2);
    expect(h.ledger.getJob(jobId)?.status).toBe('merged');
  });

  it('terminality while queued for a worker slot cancels before disposal or spawn and audits once', async () => {
    const h = makeHarness();
    const jobId = 'queued-terminal-job';
    await seedPendingRebrief({ h, jobId });
    h.ledger.registerAgent({ id: 'resident', role: 'minion', jobId });
    await h.registry.spawn('minion');
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const holder = await gate.acquireWorkerTurn({ id: 'holder', label: 'holder' });
    let released = false;
    try {
      const report = await reconcilePendingRebriefs({ ...deps(h), workerGate: gate }, { bootAt: new Date(Date.now() + 60_000) });
      expect(report.redispatched).toBe(1);
      merge(h, jobId);
      holder.release();
      released = true;
      await report.settled;
      expect(h.registry.workers).toHaveLength(1);
      expect(h.registry.disposed).toHaveLength(0);
      expect(h.registry.workers[0]?.prompts).toHaveLength(0);
      expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
      expect(h.ledger.listJobEvents(jobId).filter((event) => event.kind === 'silas.rebrief-retired')).toHaveLength(1);
      expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-recovered')).toBeNull();
      expect(h.ledger.listNotifications().filter((row) => row.kind === `silas.rebrief-unreconciled.${jobId}`)).toHaveLength(0);
    } finally {
      if (!released) holder.release();
    }
  });

  it('terminality during asynchronous spawn prevents binding and prompting the spawned worker', async () => {
    const h = makeHarness();
    const jobId = 'spawn-terminal-job';
    await seedPendingRebrief({ h, jobId });
    h.registry.afterSpawn = () => merge(h, jobId);
    const report = await reconcilePendingRebriefs(deps(h), { bootAt: new Date(Date.now() + 60_000) });
    await report.settled;
    expect(h.registry.workers).toHaveLength(1);
    expect(h.registry.workers[0]?.prompts).toHaveLength(0);
    expect(h.registry.disposedSpawned).toEqual(['worker-1']);
    expect(h.ledger.listAgents().find((agent) => agent.id === 'worker-1')).toBeUndefined();
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired')).not.toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    expect(h.ledger.listNotifications().filter((row) => row.kind === `silas.rebrief-unreconciled.${jobId}`)).toHaveLength(0);
  });

  it('same-generation nonterminal finalization records both guarded events once', async () => {
    const h = makeHarness();
    const jobId = 'same-generation-job';
    await seedPendingRebrief({ h, jobId });
    const markers = h.ledger.listPendingRebriefs({ jobId });
    const input = { ledger: h.ledger, worktrees: h.worktrees, jobId, minionId: 'worker', lanePath: h.lanePath, note: 'n', expectedMarkers: markers };
    expect(finalizeRebriefRequest(input)).toMatchObject({ rebriefRecorded: true, deliveryRecorded: true, superseded: false });
    expect(finalizeRebriefRequest(input)).toMatchObject({ rebriefRecorded: false, deliveryRecorded: false });
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
    expect(h.ledger.listJobEvents(jobId).filter((event) => event.kind === 'silas.rebrief' || event.kind === 'job.delivered')).toHaveLength(2);
  });
  it('finalization retires the admitted request when the lane lookup turns terminal before delivery', async () => {
    const h = makeHarness();
    const jobId = 'terminal-during-finalize-delivery';
    await seedPendingRebrief({ h, jobId });
    const markers = h.ledger.listPendingRebriefs({ jobId });
    const original = h.worktrees.listWorktrees.bind(h.worktrees);
    const worktrees = Object.create(h.worktrees) as InMemoryWorktreePort;
    worktrees.listWorktrees = (opts) => {
      merge(h, jobId);
      return original(opts);
    };
    const result = finalizeRebriefRequest({
      ledger: h.ledger, worktrees, jobId, minionId: 'worker', lanePath: h.lanePath,
      note: 'n', expectedMarkers: markers,
    });
    expect(result.retired).toBe(true);
    expect(result.deliveryRecorded).toBe(false);
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
    expect(retiredAudit(h, jobId).find((row) => row.kind === 'job.delivered')?.guarded_event_landed).toBe(false);
  });

  it('finalization does not deliver the old turn after a new request replaces its markers during lane lookup', async () => {
    const h = makeHarness();
    const jobId = 'superseded-during-finalize-delivery';
    await seedPendingRebrief({ h, jobId });
    const markers = h.ledger.listPendingRebriefs({ jobId });
    const original = h.worktrees.listWorktrees.bind(h.worktrees);
    const worktrees = Object.create(h.worktrees) as InMemoryWorktreePort;
    worktrees.listWorktrees = (opts) => {
      h.ledger.beginPendingRebrief({ jobId, note: 'new request', briefing: 'new contract' });
      return original(opts);
    };
    const result = finalizeRebriefRequest({
      ledger: h.ledger, worktrees, jobId, minionId: 'worker', lanePath: h.lanePath,
      note: 'n', expectedMarkers: markers,
    });
    expect(result.superseded).toBe(true);
    expect(result.deliveryRecorded).toBe(false);
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId }).map((row) => row.note)).toEqual(['new request', 'new request']);
  });

  it('a delivery subscriber replacing the request cannot clear or claim its heir', async () => {
    const h = makeHarness();
    const jobId = 'superseded-on-delivery-publication';
    await seedPendingRebrief({ h, jobId });
    const markers = h.ledger.listPendingRebriefs({ jobId });
    h.bus.subscribe((event) => {
      if (event.jobId === jobId && event.kind === 'job.delivered') {
        h.ledger.beginPendingRebrief({ jobId, note: 'new request', briefing: 'new contract' });
      }
    });
    const result = finalizeRebriefRequest({
      ledger: h.ledger, worktrees: h.worktrees, jobId, minionId: 'worker', lanePath: h.lanePath,
      note: 'n', expectedMarkers: markers,
    });
    expect(result.superseded).toBe(true);
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).not.toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId }).map((row) => row.note)).toEqual(['new request', 'new request']);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-recovered')).toBeNull();
  });

  function deps(h: Harness): {
    registry: FakeAgents;
    ledger: LedgerApi;
    worktrees: InMemoryWorktreePort;
    notifications: NotificationCenter;
  } {
    return { registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications };
  }

  /** The seed leaves the job working; terminal is in-review → merged. */
  function merge(h: Harness, jobId: string): void {
    h.ledger.setJobStatus(jobId, 'in-review');
    h.ledger.setJobStatus(jobId, 'merged');
  }

  interface RetiredMarkerAudit {
    readonly id: string;
    readonly kind: string;
    readonly payload_hash: string;
    readonly baseline_seq: number;
    readonly note: string | null;
    readonly agent_id: string | null;
    readonly session_file: string | null;
    readonly requested_at: string;
    readonly guarded_event_landed: boolean;
  }

  function retiredAudit(h: Harness, jobId: string): readonly RetiredMarkerAudit[] {
    const event = h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired');
    expect(event).not.toBeNull();
    return ((event?.payload as { retired?: readonly RetiredMarkerAudit[] }).retired ?? []);
  }

  /** A delegating ledger view with single methods overridden: forces the
   * defensive retirement boundaries deterministically without a second
   * writer or a genuinely missing row. */
  function ledgerWith(
    h: Harness,
    overrides: {
      readonly getJob?: LedgerApi['getJob'];
      readonly retirePendingRebriefs?: LedgerApi['retirePendingRebriefs'];
    },
  ): LedgerApi {
    const view = Object.create(h.ledger) as LedgerApi;
    if (overrides.getJob !== undefined) Object.defineProperty(view, 'getJob', { value: overrides.getJob });
    if (overrides.retirePendingRebriefs !== undefined) {
      Object.defineProperty(view, 'retirePendingRebriefs', { value: overrides.retirePendingRebriefs });
    }
    return view;
  }

  it('boot retires an admitted re-brief on a merged job: audited, no spawn, no fabricated delivery, no alert', async () => {
    const h = makeHarness();
    const jobId = 'terminal-pair-job';
    const boundAgent = 'worker-bound-1';
    const boundSession = '/sessions/bound-worker.jsonl';
    await seedPendingRebrief({ h, jobId, bindWorker: { agentId: boundAgent, sessionFile: boundSession } });
    merge(h, jobId);
    const markers = h.ledger.listPendingRebriefs({ jobId });
    const logs: string[] = [];
    const report = await reconcilePendingRebriefs(
      { ...deps(h), log: (level, msg) => { logs.push(`${level}:${msg}`); } },
      { bootAt: new Date(Date.now() + 60_000) },
    );
    expect(report.examined).toBe(2);
    expect(report.retired).toBe(1);
    expect(report.redispatched).toBe(0);
    expect(report.completed).toBe(0);
    await report.settled;

    // The boot summary's retirement surface is emitted for operators.
    expect(logs).toContain('info:re-brief request retired: job is terminal');

    // No worker ever ran, no guarded event was fabricated, the lane stayed terminal.
    expect(h.registry.workers).toHaveLength(0);
    expect(h.ledger.getJob(jobId)?.status).toBe('merged');
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);

    // The audit carries the full request identity for cold reads.
    const audit = h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired');
    expect(audit).not.toBeNull();
    const payload = audit?.payload as { job_status?: string; reason?: string };
    expect(payload.job_status).toBe('merged');
    expect(payload.reason).toContain('terminal');
    const retired = retiredAudit(h, jobId);
    expect(retired.map((marker) => marker.kind).sort()).toEqual(['job.delivered', 'silas.rebrief']);
    expect(retired.map((marker) => marker.id).sort()).toEqual(markers.map((marker) => marker.id).sort());
    const source = new Map(markers.map((marker) => [marker.id, marker] as const));
    for (const marker of retired) {
      const origin = source.get(marker.id);
      expect(origin).toBeDefined();
      // The audit is the only surviving copy once the rows are deleted:
      // every identity scalar must EQUAL the request it retired, not merely
      // look well-formed.
      expect(marker.kind).toBe(origin?.kind);
      expect(marker.payload_hash).toBe(origin?.payloadHash);
      expect(marker.baseline_seq).toBe(origin?.baselineSeq);
      expect(marker.requested_at).toBe(origin?.requestedAt);
      expect(marker.guarded_event_landed).toBe(false);
      // Worker/session attribution survives into the audit when the request
      // had a bound worker at retirement time.
      expect(marker.agent_id).toBe(boundAgent);
      expect(marker.session_file).toBe(boundSession);
      expect(marker.note).toBe('same blocker three rounds; try differently');
    }

    // Retirement posts NO notification at all — not merely no unreconciled alert.
    expect(h.ledger.listNotifications()).toHaveLength(0);
  });

  it('retires a lone delivery marker on a terminal job instead of fabricating a delivery', async () => {
    const h = makeHarness();
    const jobId = 'terminal-delivery-only-job';
    await seedPendingRebrief({ h, jobId });
    // The turn settled and `silas.rebrief` posted; the crash hit before the
    // delivery record — and the job merged before the next boot.
    h.ledger.appendCustomEvent({ kind: 'silas.rebrief', jobId, payload: { minion_id: 'worker-1', note: 'n' } });
    merge(h, jobId);
    const report = await reconcilePendingRebriefs(deps(h), { bootAt: new Date(Date.now() + 60_000) });
    expect(report.retired).toBe(1);
    expect(report.completed).toBe(0); // NOT the delivery-only crash shortcut
    await report.settled;
    expect(h.registry.workers).toHaveLength(0);
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-recovered')).toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
    const retired = retiredAudit(h, jobId);
    expect(retired.find((marker) => marker.kind === 'silas.rebrief')?.guarded_event_landed).toBe(true);
    expect(retired.find((marker) => marker.kind === 'job.delivered')?.guarded_event_landed).toBe(false);
  });

  it('a delivery-only crash window that turns terminal during lane lookup retires instead of fabricating delivery', async () => {
    const h = makeHarness();
    const jobId = 'terminal-during-delivery-lookup';
    await seedPendingRebrief({ h, jobId });
    h.ledger.appendCustomEvent({ kind: 'silas.rebrief', jobId, payload: { minion_id: 'worker-1' } });
    const original = h.worktrees.listWorktrees.bind(h.worktrees);
    const worktrees = Object.create(h.worktrees) as InMemoryWorktreePort;
    worktrees.listWorktrees = (opts) => {
      merge(h, jobId);
      return original(opts);
    };
    const report = await reconcilePendingRebriefs({ ...deps(h), worktrees }, { bootAt: new Date(Date.now() + 60_000) });
    await report.settled;
    expect(report.completed).toBe(0);
    expect(report.retired).toBe(1);
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-recovered')).toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
    expect(retiredAudit(h, jobId)).toHaveLength(2);
  });

  it('a delivery-only shortcut cannot record a replaced request after lane lookup', async () => {
    const h = makeHarness();
    const jobId = 'superseded-during-delivery-lookup';
    await seedPendingRebrief({ h, jobId });
    h.ledger.appendCustomEvent({ kind: 'silas.rebrief', jobId, payload: { minion_id: 'worker-1' } });
    const original = h.worktrees.listWorktrees.bind(h.worktrees);
    const worktrees = Object.create(h.worktrees) as InMemoryWorktreePort;
    worktrees.listWorktrees = (opts) => {
      h.ledger.beginPendingRebrief({ jobId, note: 'new request', briefing: 'new contract' });
      return original(opts);
    };
    const report = await reconcilePendingRebriefs({ ...deps(h), worktrees }, { bootAt: new Date(Date.now() + 60_000) });
    await report.settled;
    expect(report.completed).toBe(0);
    expect(report.retired).toBe(0);
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-recovered')).toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId }).map((row) => row.note)).toEqual(['new request', 'new request']);
  });

  it('repeated and overlapping boot passes retire exactly once (idempotent by request identity)', async () => {
    const h = makeHarness();
    const jobId = 'terminal-replay-job';
    await seedPendingRebrief({ h, jobId });
    merge(h, jobId);
    // Both passes start in the same tick: the first scan retires
    // synchronously, so the second must find nothing left to retire.
    const first = reconcilePendingRebriefs(deps(h), { bootAt: new Date(Date.now() + 60_000) });
    const second = reconcilePendingRebriefs(deps(h), { bootAt: new Date(Date.now() + 60_000) });
    const firstReport = await first;
    const secondReport = await second;
    expect(firstReport.retired).toBe(1);
    expect(secondReport.examined).toBe(0);
    await firstReport.settled;
    await secondReport.settled;
    const audits = h.ledger.listJobEvents(jobId).filter((event) => event.kind === 'silas.rebrief-retired');
    expect(audits).toHaveLength(1);
  });

  it('a terminal flip during a re-dispatch turn retires the request instead of recording a stale completion', async () => {
    const h = makeHarness();
    const jobId = 'terminal-midturn-job';
    await seedPendingRebrief({ h, jobId });
    let release!: () => void;
    h.registry.gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const logs: string[] = [];
    const report = await reconcilePendingRebriefs(
      { ...deps(h), log: (level, msg) => { logs.push(`${level}:${msg}`); } },
      { bootAt: new Date(Date.now() + 60_000) },
    );
    expect(report.redispatched).toBe(1);
    // The job reaches terminal while the re-dispatch turn is still in flight.
    merge(h, jobId);
    release();
    await report.settled;

    // The live turn is preserved (not killed), but no stale completion is recorded.
    expect(h.registry.workers).toHaveLength(1);
    expect(logs).toContain('info:re-brief recovery closed: job went terminal mid-turn');
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-recovered')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired')).not.toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
    expect(h.ledger.getJob(jobId)?.status).toBe('merged');
    expect(h.ledger.listNotifications().filter((row) => row.kind === `silas.rebrief-unreconciled.${jobId}`)).toHaveLength(0);
  });

  it('a recovered turn that errors after terminality retires instead of escalating an obsolete request', async () => {
    const h = makeHarness();
    const jobId = 'terminal-midturn-error';
    await seedPendingRebrief({ h, jobId });
    let release!: () => void;
    h.registry.gate = new Promise<void>((resolve) => { release = resolve; });
    const report = await reconcilePendingRebriefs(deps(h), { bootAt: new Date(Date.now() + 60_000) });
    expect(report.redispatched).toBe(1);
    merge(h, jobId);
    h.registry.healthState = 'error';
    h.registry.healthError = 'turn rejected';
    release();
    await report.settled;
    expect(h.registry.workers).toHaveLength(1);
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
    expect(retiredAudit(h, jobId)).toHaveLength(2);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-recovered')).toBeNull();
    expect(h.ledger.listNotifications().filter((row) => row.kind === `silas.rebrief-unreconciled.${jobId}`)).toHaveLength(0);
  });

  it('retires only the terminal job’s obsolete markers; an unrelated unfinished request recovers unchanged', async () => {
    const h = makeHarness();
    const terminalJob = 'terminal-neighbour-job';
    const workingJob = 'working-neighbour-job';
    await seedPendingRebrief({ h, jobId: terminalJob });
    await seedPendingRebrief({ h, jobId: workingJob });
    merge(h, terminalJob);
    const report = await reconcilePendingRebriefs(deps(h), { bootAt: new Date(Date.now() + 60_000) });
    expect(report.retired).toBe(1);
    expect(report.redispatched).toBe(1);
    await report.settled;

    expect(h.ledger.listPendingRebriefs({ jobId: terminalJob })).toHaveLength(0);
    expect(h.ledger.latestJobEvent(terminalJob, 'silas.rebrief')).toBeNull();
    // The unrelated request walked the honest recovery path untouched.
    expect(h.ledger.listPendingRebriefs({ jobId: workingJob })).toHaveLength(0);
    expect(h.registry.workers).toHaveLength(1);
    expect(h.registry.workers[0]?.prompts[0] ?? '').toContain(`Re-brief — job ${workingJob}`);
    expect(h.ledger.latestJobEvent(workingJob, 'silas.rebrief')).not.toBeNull();
  });

  it('retires a terminal request on a done job exactly as on a merged one', async () => {
    const h = makeHarness();
    const jobId = 'terminal-done-job';
    await seedPendingRebrief({ h, jobId });
    h.ledger.setJobStatus(jobId, 'done');
    const report = await reconcilePendingRebriefs(deps(h), { bootAt: new Date(Date.now() + 60_000) });
    expect(report.retired).toBe(1);
    expect(report.redispatched).toBe(0);
    await report.settled;
    expect(h.registry.workers).toHaveLength(0);
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
    const audit = h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired');
    expect((audit?.payload as { job_status?: string }).job_status).toBe('done');
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).toBeNull();
  });

  it('spent markers on a terminal job keep the completed clear path (no retirement audit)', async () => {
    const h = makeHarness();
    const jobId = 'terminal-spent-job';
    await seedPendingRebrief({ h, jobId });
    // Both guarded events landed before the job went terminal: the request
    // was honored, so the clear is a completion — not a cancellation.
    h.ledger.appendCustomEvent({ kind: 'silas.rebrief', jobId, payload: { minion_id: 'worker-1', note: 'n' } });
    h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { agentId: 'worker-1', source: 'silas-rebrief', sha: null } });
    merge(h, jobId);
    const report = await reconcilePendingRebriefs(deps(h), { bootAt: new Date(Date.now() + 60_000) });
    expect(report.completed).toBe(1);
    expect(report.retired).toBe(0);
    await report.settled;
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired')).toBeNull();
    expect(h.ledger.listNotifications()).toHaveLength(0);
  });

  it('spent marked events beyond the newest thousand stay completed at terminal boot and finalization', async () => {
    const h = makeHarness();
    for (const jobId of ['phase-spent-boot', 'phase-spent-finalize']) {
      await seedPendingRebrief({ h, jobId });
      const markers = h.ledger.beginPendingRebrief({
        jobId, note: 'marked', briefing: 'contract',
        handoff: { kind: 'gru-decision', decision: 'decide' },
      });
      const phaseId = markers[0]!.phaseId;
      h.ledger.appendCustomEvent({ kind: 'silas.rebrief', jobId, payload: { phase_id: phaseId } });
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { phase_id: phaseId } });
      for (let i = 0; i < 1001; i += 1) h.ledger.appendCustomEvent({ kind: 'job.note', jobId, payload: { i } });
      merge(h, jobId);
      if (jobId === 'phase-spent-boot') {
        const report = await reconcilePendingRebriefs(deps(h), { bootAt: new Date(Date.now() + 60_000) });
        await report.settled;
        expect(report.completed).toBe(1);
        expect(report.retired).toBe(0);
      } else {
        const result = finalizeRebriefRequest({
          ledger: h.ledger, worktrees: h.worktrees, jobId,
          minionId: 'worker', lanePath: h.lanePath, note: 'marked', expectedMarkers: markers,
        });
        expect(result.retired).toBe(false);
        expect(result.rebriefRecorded).toBe(false);
        expect(result.deliveryRecorded).toBe(false);
      }
      expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
      expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired')).toBeNull();
    }
  });

  it('boot does not report a spent generation completed after another request replaces it at clear', async () => {
    const h = makeHarness();
    const jobId = 'spent-superseded-at-clear';
    await seedPendingRebrief({ h, jobId });
    h.ledger.appendCustomEvent({ kind: 'silas.rebrief', jobId });
    h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId });
    const view = Object.create(h.ledger) as LedgerApi;
    Object.defineProperty(view, 'clearPendingRebriefsIfCurrent', {
      value: (expected: Parameters<LedgerApi['clearPendingRebriefsIfCurrent']>[0]) => {
        h.ledger.beginPendingRebrief({ jobId, note: 'new request', briefing: 'new contract' });
        return h.ledger.clearPendingRebriefsIfCurrent(expected);
      },
    });
    const report = await reconcilePendingRebriefs({ ...deps(h), ledger: view }, { bootAt: new Date(Date.now() + 60_000) });
    await report.settled;
    expect(report.completed).toBe(0);
    expect(report.retired).toBe(0);
    expect(h.ledger.listPendingRebriefs({ jobId }).map((row) => row.note)).toEqual(['new request', 'new request']);
  });

  it('a parked job keeps the existing recovery path — not terminal cleanup', async () => {
    const h = makeHarness();
    const jobId = 'parked-rebrief-job';
    await seedPendingRebrief({ h, jobId });
    h.ledger.setJobStatus(jobId, 'parked');
    const report = await reconcilePendingRebriefs(deps(h), { bootAt: new Date(Date.now() + 60_000) });
    expect(report.retired).toBe(0);
    expect(report.redispatched).toBe(1);
    await report.settled;
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).not.toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
  });

  it('a missing job never takes the delivery-only shortcut: escalation, no fabricated delivery', async () => {
    const h = makeHarness();
    const jobId = 'missing-rebrief-job';
    await seedPendingRebrief({ h, jobId });
    // The turn settled and `silas.rebrief` posted; the delivery record never
    // did — the exact shape the delivery-only crash shortcut exists for.
    h.ledger.appendCustomEvent({ kind: 'silas.rebrief', jobId, payload: { minion_id: 'worker-1', note: 'n' } });
    const report = await reconcilePendingRebriefs(
      {
        registry: h.registry,
        ledger: ledgerWith(h, { getJob: () => null }),
        worktrees: h.worktrees,
        notifications: h.notifications,
      },
      { bootAt: new Date(Date.now() + 60_000) },
    );
    await report.settled;
    // No delivery is minted for a job row that does not exist; the markers
    // stay and the honest re-dispatch boundary escalates instead.
    expect(report.completed).toBe(0);
    expect(report.redispatched).toBe(1);
    expect(h.registry.workers).toHaveLength(0);
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-recovered')).toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(2);
    const notification = h.ledger
      .listNotifications()
      .find((row) => row.kind === `silas.rebrief-unreconciled.${jobId}`);
    expect(notification).toBeDefined();
    expect(notification?.detail).toContain('no longer exists');
  });

  it('finalize fails closed for a missing job: no guarded event, markers kept', async () => {
    const h = makeHarness();
    const jobId = 'finalize-missing-job';
    await seedPendingRebrief({ h, jobId });
    const view = ledgerWith(h, { getJob: () => null });
    expect(() =>
      finalizeRebriefRequest({
        ledger: view,
        worktrees: h.worktrees,
        jobId,
        minionId: 'worker-9',
        lanePath: h.lanePath,
        note: 'n',
      }),
    ).toThrow(/no longer exists/u);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(2);
  });

  it('finalize reports an incomplete terminal retirement instead of a silent no-op', async () => {
    const h = makeHarness();
    const jobId = 'finalize-incomplete-retirement';
    await seedPendingRebrief({ h, jobId });
    merge(h, jobId);
    const stale: PendingRebriefRetirement = {
      retired: [],
      skippedIds: ['stale-generation'],
      refused: null,
    };
    const view = ledgerWith(h, { retirePendingRebriefs: () => stale });
    const result = finalizeRebriefRequest({
      ledger: view,
      worktrees: h.worktrees,
      jobId,
      minionId: 'worker-9',
      lanePath: h.lanePath,
      note: 'n',
    });
    expect(result.retired).toBe(false);
    expect(result.retirement).toEqual({ refused: null, skippedIds: ['stale-generation'] });
    expect(result.rebriefRecorded).toBe(false);
    expect(result.deliveryRecorded).toBe(false);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(2);
  });

  it('a boot retirement that retires nothing keeps the markers, records no audit, and is logged', async () => {
    const h = makeHarness();
    const jobId = 'boot-incomplete-retirement';
    await seedPendingRebrief({ h, jobId });
    merge(h, jobId);
    const logs: string[] = [];
    const stale: PendingRebriefRetirement = {
      retired: [],
      skippedIds: ['stale-generation'],
      refused: null,
    };
    const report = await reconcilePendingRebriefs(
      {
        registry: h.registry,
        ledger: ledgerWith(h, { retirePendingRebriefs: () => stale }),
        worktrees: h.worktrees,
        notifications: h.notifications,
        log: (level, msg) => {
          logs.push(`${level}:${msg}`);
        },
      },
      { bootAt: new Date(Date.now() + 60_000) },
    );
    expect(report.retired).toBe(0);
    expect(report.redispatched).toBe(0);
    await report.settled;
    // The boundary retired nothing: no spawn, no audit, markers kept — and
    // the disposition is surfaced instead of disappearing.
    expect(h.registry.workers).toHaveLength(0);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired')).toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(2);
    expect(logs).toContain('warn:re-brief retirement retired nothing');
  });

  it('a mid-turn retirement that retires nothing keeps the markers and is never reported as recovered', async () => {
    const h = makeHarness();
    const jobId = 'incomplete-retirement-job';
    await seedPendingRebrief({ h, jobId });
    let release!: () => void;
    h.registry.gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const logs: string[] = [];
    const stale: PendingRebriefRetirement = {
      retired: [],
      skippedIds: ['stale-generation'],
      refused: null,
    };
    const report = await reconcilePendingRebriefs(
      {
        registry: h.registry,
        ledger: ledgerWith(h, { retirePendingRebriefs: () => stale }),
        worktrees: h.worktrees,
        notifications: h.notifications,
        log: (level, msg) => {
          logs.push(`${level}:${msg}`);
        },
      },
      { bootAt: new Date(Date.now() + 60_000) },
    );
    expect(report.redispatched).toBe(1);
    // The job reaches terminal while the re-dispatch turn is still in flight.
    merge(h, jobId);
    release();
    await report.settled;
    // The boundary kept the markers and said so; it did NOT claim recovery.
    expect(h.registry.workers).toHaveLength(1);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-recovered')).toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(2);
    expect(logs).toContain('warn:re-brief recovery closed without retirement: markers kept');
  });

  it('a mid-turn partial retirement keeps its skipped ids visible at the caller surface', async () => {
    const h = makeHarness();
    const jobId = 'partial-retirement-mid-turn';
    await seedPendingRebrief({ h, jobId });
    let release!: () => void;
    h.registry.gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    // Drift ONE candidate's identity: the finalize-time retirement deletes
    // the matching marker and keeps the drifted one — the partial shape
    // that must stay visible at the mid-turn log surface too.
    const driftedId = h.ledger.listPendingRebriefs({ jobId })[0]!.id;
    const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
    const report = await reconcilePendingRebriefs(
      {
        registry: h.registry,
        ledger: ledgerWith(h, {
          retirePendingRebriefs: (input) => h.ledger.retirePendingRebriefs({
            ...input,
            candidates: input.candidates.map((candidate) =>
              candidate.id === driftedId ? { ...candidate, payloadHash: 'drifted-hash' } : candidate),
          }),
        }),
        worktrees: h.worktrees,
        notifications: h.notifications,
        log: (level, msg, fields) => { logs.push({ level, msg, fields }); },
      },
      { bootAt: new Date(Date.now() + 60_000) },
    );
    expect(report.redispatched).toBe(1);
    // The job reaches terminal while the recovered turn is still in flight.
    merge(h, jobId);
    release();
    await report.settled;
    // The turn is preserved; one marker retired with its audit; the kept
    // marker and its identity are named at this surface, not dropped.
    expect(h.registry.workers).toHaveLength(1);
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(1);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired')).not.toBeNull();
    const closed = logs.find((line) => line.msg === 're-brief recovery closed: job went terminal mid-turn');
    expect(closed?.level).toBe('info');
    expect(closed?.fields?.['skipped']).toEqual([driftedId]);
  });

  it('one pass retires multiple terminal jobs: per-job audits, statuses, and an untouched working lane', async () => {
    const h = makeHarness();
    const mergedJobId = 'multi-terminal-merged';
    const doneJobId = 'multi-terminal-done';
    const workingJobId = 'multi-terminal-working';
    await seedPendingRebrief({ h, jobId: mergedJobId });
    await seedPendingRebrief({ h, jobId: doneJobId });
    await seedPendingRebrief({ h, jobId: workingJobId });
    merge(h, mergedJobId);
    h.ledger.setJobStatus(doneJobId, 'done');
    const report = await reconcilePendingRebriefs(deps(h), { bootAt: new Date(Date.now() + 60_000) });
    expect(report.examined).toBe(6);
    expect(report.retired).toBe(2);
    expect(report.completed).toBe(0);
    expect(report.redispatched).toBe(1);
    await report.settled;
    // The loop carried BOTH terminal groups: one audit per job, each with
    // its own terminal status, and no terminal lane spawned a worker.
    expect(h.registry.workers).toHaveLength(1);
    expect(h.registry.workers[0]?.prompts[0] ?? '').toContain(`Re-brief — job ${workingJobId}`);
    for (const [jobId, status] of [[mergedJobId, 'merged'], [doneJobId, 'done']] as const) {
      const audits = h.ledger.listJobEvents(jobId).filter((event) => event.kind === 'silas.rebrief-retired');
      expect(audits).toHaveLength(1);
      expect((audits[0]!.payload as { job_status?: string }).job_status).toBe(status);
      expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
      expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).toBeNull();
    }
    // The working lane walked the honest recovery path.
    expect(h.ledger.latestJobEvent(workingJobId, 'silas.rebrief')).not.toBeNull();
  });

  it('a partial retirement traces its skipped ids through every caller surface', async () => {
    const h = makeHarness();
    const jobId = 'partial-retirement-boot';
    await seedPendingRebrief({ h, jobId });
    merge(h, jobId);
    // Drift ONE candidate's identity after the pass examined the rows: the
    // real transaction retires the matching marker and skips the drifted
    // one — the partial composition, deterministically.
    const driftedId = h.ledger.listPendingRebriefs({ jobId })[0]!.id;
    const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
    const report = await reconcilePendingRebriefs(
      {
        registry: h.registry,
        ledger: ledgerWith(h, {
          retirePendingRebriefs: (input) => h.ledger.retirePendingRebriefs({
            ...input,
            candidates: input.candidates.map((candidate) =>
              candidate.id === driftedId ? { ...candidate, payloadHash: 'drifted-hash' } : candidate),
          }),
        }),
        worktrees: h.worktrees,
        notifications: h.notifications,
        log: (level, msg, fields) => { logs.push({ level, msg, fields }); },
      },
      { bootAt: new Date(Date.now() + 60_000) },
    );
    expect(report.retired).toBe(1);
    await report.settled;
    // The boot log carries the drifted ids beside the retired markers.
    const retired = logs.find((line) => line.msg === 're-brief request retired: job is terminal');
    expect(retired?.fields?.['skipped']).toEqual([driftedId]);
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(1);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired')).not.toBeNull();

    // The same partial composition on the finalize path: retired:true plus
    // the disposition — never a bare success over a kept marker.
    const finalizeJobId = 'partial-retirement-finalize';
    await seedPendingRebrief({ h, jobId: finalizeJobId });
    merge(h, finalizeJobId);
    const driftedFinalizeId = h.ledger.listPendingRebriefs({ jobId: finalizeJobId })[0]!.id;
    const result = finalizeRebriefRequest({
      ledger: ledgerWith(h, {
        retirePendingRebriefs: (input) => h.ledger.retirePendingRebriefs({
          ...input,
          candidates: input.candidates.map((candidate) =>
            candidate.id === driftedFinalizeId ? { ...candidate, payloadHash: 'drifted-hash' } : candidate),
        }),
      }),
      worktrees: h.worktrees,
      jobId: finalizeJobId,
      minionId: 'worker-9',
      lanePath: h.lanePath,
      note: 'n',
    });
    expect(result.retired).toBe(true);
    expect(result.retirement).toEqual({ refused: null, skippedIds: [driftedFinalizeId] });
    expect(h.ledger.listPendingRebriefs({ jobId: finalizeJobId })).toHaveLength(1);
  });
});
