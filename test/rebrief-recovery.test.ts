import { bindOriginalRebriefSdkOwner } from './helpers/directive-native-fixture.js';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
import { resolveGitCommit } from '../src/dispatch/perkins-review/artifacts.js';

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
  /** Firing-rule provenance (issue #117) stored on the durable markers. */
  ruleId?: string;
  sourceRoundId?: string;
  bindWorker?: { agentId: string; sessionFile: string | null };
  deliverable?: 'review' | 'artifact' | 'investigation';
}): Promise<{ path: string; markers: readonly { id: string; kind: string }[] }> {
  const repo = fixtureRepo();
  input.h.ledger.addJob({ id: input.jobId, repo: 'fixture', title: 'stuck lane', briefing: input.briefing ?? 'the original contract',
    ...(input.deliverable === undefined ? {} : { deliverable: input.deliverable }) });
  input.h.ledger.setJobStatus(input.jobId, 'working');
  const lane = await input.h.worktrees.createJobWorktree({ repoPath: repo.path, jobId: input.jobId });
  input.h.lanePath = lane.path;
  const markers = input.h.ledger.beginPendingRebrief({
    jobId: input.jobId,
    note: input.note ?? 'same blocker three rounds; try differently',
    briefing: input.briefing ?? 'the original contract',
    ...(input.ruleId !== undefined ? { ruleId: input.ruleId } : {}),
    ...(input.sourceRoundId !== undefined ? { sourceRoundId: input.sourceRoundId } : {}),
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

/** Deterministic fault injection for the committed-clear/missing-settlement
 * window (issue #189): fail exactly the `silas.rebrief-settled` append at
 * the ledger's event seam — the publication point INSIDE the completion
 * transaction, so a failure here must roll the marker clear back with it.
 * Returns the restore function. */
function failSettlementPublication(ledger: LedgerApi, fault: Error): () => void {
  const seam = ledger as unknown as { appendEvent: (fields: { kind: string }) => unknown };
  const original = seam.appendEvent;
  const spy = vi.spyOn(seam, 'appendEvent').mockImplementation(function (this: unknown, fields: { kind: string }) {
    if (fields.kind === 'silas.rebrief-settled') throw fault;
    return original.apply(this, [fields]);
  });
  return () => { spy.mockRestore(); };
}


async function assertHistoricalRefusal(h: Harness, jobId: string, workerGate?: PacingGate): Promise<void> {
  const before = h.ledger.listPendingRebriefs({ jobId }); const status = h.ledger.getJob(jobId)?.status;
  const deps = { ledger: h.ledger, worktrees: h.worktrees, registry: h.registry, notifications: h.notifications, ...(workerGate === undefined ? {} : { workerGate }) };
  const first = await reconcilePendingRebriefs(deps); await first.settled;
  const incidentKey = `rebrief-recovery:${before.find((row) => row.kind === 'silas.rebrief')!.id}`;
  const firstDebt = h.ledger.listObligations({ jobId }).find((row) => row.incidentKey === incidentKey);
  const second = await reconcilePendingRebriefs(deps); await second.settled;
  expect(first.examined).toBe(before.length); expect(second.examined).toBe(before.length);
  expect(first.redispatched + second.redispatched).toBe(0); expect(h.registry.workers).toEqual([]);
  expect(h.registry.disposed).toEqual([]); expect(h.ledger.listPendingRebriefs({ jobId })).toEqual(before);
  expect(h.ledger.getJob(jobId)?.status).toBe(status);
  expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).toBeNull(); expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
  const debts = h.ledger.listObligations({ jobId }).filter((row) => row.category.kind === 'known' && row.category.category === 'restart-recovery');
  expect(debts).toHaveLength(1); expect(debts[0]?.nextAction.kind).toBe('gru-decision');
  expect(debts[0]?.incidentKey).toBe(incidentKey);
  expect(debts[0]?.id).toBe(firstDebt?.id); expect(debts[0]?.generation).toBe(firstDebt?.generation);
  expect(debts[0]?.state).toBe(status === 'parked' ? 'suspended' : 'open');
  expect(h.ledger.listNotifications({ limit: 100 }).some((row) => row.kind === `silas.rebrief-unreconciled.${jobId}` && (row.detail ?? '').includes('/api/silas/rebriefs/'))).toBe(true);
}

/** The seed leaves the job working; terminal is in-review → merged. */
function merge(h: Harness, jobId: string): void {
  h.ledger.setJobStatus(jobId, 'in-review');
  h.ledger.setJobStatus(jobId, 'merged');
}

function seedCorrelatedReceipt(h: Harness, jobId: string, kind: 'silas.rebrief' | 'job.delivered',
  minionId = 'worker-1', extra: Readonly<Record<string, unknown>> = {}) {
  const markers = h.ledger.listPendingRebriefs({ jobId });
  h.ledger.bindPendingRebriefWorker({ ids: markers.map((row) => row.id), agentId: minionId, sessionFile: markers.find((row) => row.kind === 'silas.rebrief')?.sessionFile ?? null });
  const marker = h.ledger.listPendingRebriefs({ jobId }).find((row) => row.kind === kind)!;
  return h.ledger.appendCustomEvent({ kind, jobId, agentId: minionId, payload: {
    ...(kind === 'silas.rebrief' ? { minion_id: minionId, note: 'n', sha: h.lanePath === null ? undefined : resolveGitCommit(h.lanePath, 'HEAD') } : { agentId: minionId, source: 'silas-rebrief', sha: 'settled-head' }),
    work_revision: marker.workRevision,
    ...(marker.phaseId === null ? { marker_id: marker.id, payload_hash: marker.payloadHash } : { phase_id: marker.phaseId }), ...extra } });
}

function seedHistoricalCompletion(h: Harness, jobId: string): void {
  seedCorrelatedReceipt(h, jobId, 'silas.rebrief');
  seedCorrelatedReceipt(h, jobId, 'job.delivered');
}

describe('re-brief restart safety (durable markers)', () => {
  it('production-shaped original marked completion without duplicated revision settles only its exact generation', async () => {
    const h = makeHarness(); const jobId = 'marked-original-no-duplicate-revision';
    await seedPendingRebrief({ h, jobId });
    h.ledger.beginPendingRebrief({ jobId, note: 'original', briefing: 'contract', handoff: { kind: 'gru-decision', decision: 'actual original phase' } });
    const original = seedCorrelatedReceipt(h, jobId, 'silas.rebrief', 'original-minion', { work_revision: undefined });
    seedCorrelatedReceipt(h, jobId, 'job.delivered', 'original-minion');
    const marker = h.ledger.listPendingRebriefs({ jobId }).find((row) => row.kind === 'silas.rebrief')!;
    expect(h.ledger.pendingRebriefReceipt(marker)?.seq).toBe(original.seq);
    expect((original.payload as Record<string, unknown>)['work_revision']).toBeUndefined();
    const pass = await reconcilePendingRebriefs({ ledger: h.ledger, worktrees: h.worktrees, registry: h.registry, notifications: h.notifications }, { limit: 100 }); await pass.settled;
    expect(pass).toMatchObject({ completed: 1, retired: 0, redispatched: 0 });
    expect(h.ledger.listJobEvents(jobId).filter((event) => event.kind === 'job.delivered')).toHaveLength(1);
    const again = await reconcilePendingRebriefs({ ledger: h.ledger, worktrees: h.worktrees, registry: h.registry, notifications: h.notifications }, { limit: 100 }); await again.settled;
    expect(again.completed).toBe(0); expect(h.registry.workers).toHaveLength(0);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired')).toBeNull();
  });

  it('R16 original marked completion without duplicated revision reconstructs only its genuinely lost delivery', async () => {
    const h = makeHarness(); const jobId = 'r16-original-marked-lost-delivery';
    try {
      await seedPendingRebrief({ h, jobId });
      const markers = h.ledger.beginPendingRebrief({ jobId, note: 'original', briefing: 'contract',
        handoff: { kind: 'gru-decision', decision: 'actual original phase before execution' } });
      await bindOriginalRebriefSdkOwner(h.ledger, markers, { cwd: h.lanePath!, dataDir: h.dir, agentId: 'original-minion' });
      const original = seedCorrelatedReceipt(h, jobId, 'silas.rebrief', 'original-minion', { work_revision: undefined });
      const marker = h.ledger.listPendingRebriefs({ jobId }).find((row) => row.kind === 'silas.rebrief')!;
      expect(h.ledger.pendingRebriefReceipt(marker)?.seq).toBe(original.seq);
      expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
      const before = h.ledger.listJobEventsByKinds(jobId, ['silas.rebrief']);
      const report = await reconcilePendingRebriefs({ ledger: h.ledger, worktrees: h.worktrees, registry: h.registry, notifications: h.notifications });
      await report.settled;
      expect(h.ledger.latestJobEvent(jobId, 'job.delivered')?.payload).toMatchObject({
        work_revision: marker.workRevision, sha: (original.payload as { sha: string }).sha,
        historical_bookkeeping_only: true, provenance: { kind: 'original-correlated-completion', event_seq: original.seq },
      });
      expect(h.ledger.listJobEventsByKinds(jobId, ['silas.rebrief'])).toEqual(before);
      expect(h.ledger.listPendingRebriefs({ jobId })).toEqual([]);
      expect(report.completed).toBe(1); expect(h.registry.workers).toEqual([]);
      const again = await reconcilePendingRebriefs({ ledger: h.ledger, worktrees: h.worktrees, registry: h.registry, notifications: h.notifications });
      await again.settled;
      expect(h.ledger.listJobEventsByKinds(jobId, ['job.delivered'])).toHaveLength(1);
    } finally { h.close(); }
  });

  async function assertStrictReceiptRefusal(fault: 'missing-binding' | 'foreign-phase' | 'reused-phase' | 'foreign-minion' | 'conflicting-delivery-revision' | 'conflicting-stored-revision' | 'unmarked-missing-revision'): Promise<void> {
      const h = makeHarness(); const jobId = `receipt-refusal-${fault}`; await seedPendingRebrief({ h, jobId });
      h.ledger.beginPendingRebrief({ jobId, note: 'original', briefing: 'contract',
        ...(fault === 'unmarked-missing-revision' ? {} : { handoff: { kind: 'gru-decision' as const, decision: 'original phase' } }) });
      const receipt = seedCorrelatedReceipt(h, jobId, 'silas.rebrief', 'original-minion', {
        work_revision: undefined, ...(fault === 'foreign-phase' ? { phase_id: 'foreign' } : {}),
        ...(fault === 'foreign-minion' ? { minion_id: 'not-original' } : {}) });
      const marker = h.ledger.listPendingRebriefs({ jobId }).find((row) => row.kind === 'silas.rebrief')!;
      if (fault === 'missing-binding') h.db.handle.prepare('UPDATE pending_rebriefs SET agent_id = NULL WHERE job_id = ?').run(jobId);
      if (fault === 'reused-phase') h.db.handle.prepare('UPDATE phase_handoffs SET intent_seq = intent_seq + 1 WHERE phase_id = ?').run(marker.phaseId);
      if (fault === 'conflicting-delivery-revision') seedCorrelatedReceipt(h, jobId, 'job.delivered', 'original-minion', { work_revision: (marker.workRevision ?? 0) + 1 });
      if (fault === 'conflicting-stored-revision') {
        const payload = JSON.parse(h.db.handle.prepare('SELECT payload FROM pending_rebriefs WHERE id = ?').get(marker.id)!.payload as string) as Record<string, unknown>;
        h.db.handle.prepare('UPDATE pending_rebriefs SET payload = ? WHERE id = ?').run(JSON.stringify({ ...payload, work_revision: (marker.workRevision ?? 0) + 1 }), marker.id);
      }
      const current = h.ledger.listPendingRebriefs({ jobId }).find((row) => row.kind === 'silas.rebrief')!;
      expect(h.ledger.pendingRebriefReceipt(current)).toBeNull();
      expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(2);
      expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')?.seq).toBe(receipt.seq);
      expect(h.registry.workers).toHaveLength(0); expect(h.registry.disposed).toHaveLength(0);
  }

  it('strict original receipt correlation refuses missing-binding without rewriting immutable history', async () => {
    await assertStrictReceiptRefusal('missing-binding');
  });

  it('strict original receipt correlation refuses foreign-phase without rewriting immutable history', async () => {
    await assertStrictReceiptRefusal('foreign-phase');
  });

  it('strict original receipt correlation refuses reused-phase without rewriting immutable history', async () => {
    await assertStrictReceiptRefusal('reused-phase');
  });

  it('strict original receipt correlation refuses foreign-minion without rewriting immutable history', async () => {
    await assertStrictReceiptRefusal('foreign-minion');
  });

  it('strict original receipt correlation refuses conflicting-delivery-revision without rewriting immutable history', async () => {
    await assertStrictReceiptRefusal('conflicting-delivery-revision');
  });

  it('strict original receipt correlation refuses conflicting-stored-revision without rewriting immutable history', async () => {
    await assertStrictReceiptRefusal('conflicting-stored-revision');
  });

  it('strict original receipt correlation refuses unmarked-missing-revision without rewriting immutable history', async () => {
    await assertStrictReceiptRefusal('unmarked-missing-revision');
  });


  it('bounded historical pages are fair whole generations and cancellation never consumes the next page', async () => {
    const h = makeHarness(); const ids = ['unknown-first', 'spent-second', 'parked-third'];
    for (const jobId of ids) await seedPendingRebrief({ h, jobId });
    seedHistoricalCompletion(h, ids[1]!); h.ledger.setJobStatus(ids[2]!, 'parked');
    const before = h.ledger.listPendingRebriefs(); const stop = new AbortController(); stop.abort();
    const deps = { ledger: h.ledger, registry: h.registry, worktrees: h.worktrees, notifications: h.notifications };
    expect((await reconcilePendingRebriefs({ ...deps, stopSignal: stop.signal }, { limit: 1 })).examined).toBe(0);
    expect(h.ledger.listPendingRebriefs()).toEqual(before);
    const first = await reconcilePendingRebriefs(deps, { limit: 1 }); await first.settled;
    expect(first.examined).toBe(2); expect(h.ledger.listPendingRebriefs({ jobId: ids[1] })).toHaveLength(2);
    const second = await reconcilePendingRebriefs(deps, { limit: 1 }); await second.settled;
    expect(second).toMatchObject({ examined: 2, completed: 1 });
    const third = await reconcilePendingRebriefs(deps, { limit: 1 }); await third.settled;
    expect(third.examined).toBe(2);
    expect(h.ledger.listObligations({ jobId: ids[2] }).find((row) => row.category.kind === 'known' && row.category.category === 'restart-recovery')?.state).toBe('suspended');
    const originalDebt = h.ledger.listObligations({ jobId: ids[0] }).find((row) => row.category.kind === 'known' && row.category.category === 'restart-recovery')!;
    const wrap = await reconcilePendingRebriefs(deps, { limit: 1 }); await wrap.settled;
    expect(wrap.examined).toBe(0); // bounded empty end page resets cursor, never scans an unbounded wrap
    const restarted = await reconcilePendingRebriefs(deps, { limit: 1 }); await restarted.settled;
    expect(restarted.examined).toBe(2);
    expect(h.ledger.getObligation(originalDebt.id)?.generation).toBe(originalDebt.generation);
    expect(h.registry.workers).toEqual([]); expect(h.registry.disposed).toEqual([]);
  });

  it('cancellation between historical groups preserves their markers and later independent completion', async () => {
    const h = makeHarness(); await seedPendingRebrief({ h, jobId: 'cancel-first' }); await seedPendingRebrief({ h, jobId: 'cancel-second' });
    seedHistoricalCompletion(h, 'cancel-second'); const stop = new AbortController();
    const notifications = { postIncident: (input: Parameters<NotificationCenter['postIncident']>[0]) => {
      const note = h.notifications.postIncident(input); stop.abort(); return note;
    } };
    const deps = { ledger: h.ledger, registry: h.registry, worktrees: h.worktrees, notifications };
    const first = await reconcilePendingRebriefs({ ...deps, stopSignal: stop.signal }, { limit: 100 }); await first.settled;
    expect(first.examined).toBe(2); expect(h.ledger.listPendingRebriefs({ jobId: 'cancel-second' })).toHaveLength(2);
    const later = await reconcilePendingRebriefs({ ...deps, notifications: h.notifications }, { limit: 100 }); await later.settled;
    expect(later.completed).toBe(1); expect(h.ledger.listPendingRebriefs({ jobId: 'cancel-first' })).toHaveLength(2);
    expect(h.registry.workers).toEqual([]);
  });

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

  it("historical reconciles a fresh marker pair to the recorded events and clears the markers: zero replay and concrete Gru judgment", async () => {
    const h = makeHarness(); const jobId = 'historical-237';
    try {
      await seedPendingRebrief({ h, jobId });



      h.registry.failSpawn = new Error('must never spawn'); h.registry.failPrompt = new Error('must never prompt');
      await assertHistoricalRefusal(h, jobId);



    } finally { h.close(); }
  });

  it("historical rule provenance survives the restart: the silas.rebrief receipt carries the firing rule (issue #117): zero replay and concrete Gru judgment", async () => {
    const h = makeHarness(); const jobId = 'historical-280';
    try {
      await seedPendingRebrief({ h, jobId, ruleId: 'historical-rule', sourceRoundId: 'historical-round' });



      h.registry.failSpawn = new Error('must never spawn'); h.registry.failPrompt = new Error('must never prompt');
      await assertHistoricalRefusal(h, jobId);


      expect(h.ledger.listPendingRebriefs({ jobId })[0]).toMatchObject({ ruleId: 'historical-rule', sourceRoundId: 'historical-round' });
    } finally { h.close(); }
  });

  it("historical the re-brief waits for a worker pacing slot before spawning: zero replay and concrete Gru judgment", async () => {
    const h = makeHarness(); const jobId = 'historical-322';
    try {
      await seedPendingRebrief({ h, jobId });

      const workerGate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 }); const holder = await workerGate.acquireWorkerTurn({ id: 'other-job', label: 'fixture hold' }); const release = () => holder.release();

      h.registry.failSpawn = new Error('must never spawn'); h.registry.failPrompt = new Error('must never prompt');
      await assertHistoricalRefusal(h, jobId, workerGate);
      expect(workerGate.view().worker.queued.length).toBe(0); release();


    } finally { h.close(); }
  });

  it("historical resumes the interrupted worker session when one exists on disk: zero replay and concrete Gru judgment", async () => {
    const h = makeHarness(); const jobId = 'historical-357';
    try {
      await seedPendingRebrief({ h, jobId });
      const file = join(h.dir, 'old-native.jsonl'); writeFileSync(file, 'historical native transcript\n');
      h.ledger.registerAgent({ id: 'historical-worker', role: 'minion', jobId, sessionFile: file });


      h.registry.failSpawn = new Error('must never spawn'); h.registry.failPrompt = new Error('must never prompt');
      await assertHistoricalRefusal(h, jobId);

      expect(readFileSync(file, 'utf8')).toBe('historical native transcript\n');

    } finally { h.close(); }
  });

  it("historical never resumes a review-only session, however new its row is (Gru ruling 2026-09-29): zero replay and concrete Gru judgment", async () => {
    const h = makeHarness();
    const jobId = 'reviewer-safe-job';
    const sessions = join(h.dir, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const implementerFile = join(sessions, 'implementer.jsonl');
    const reviewerFile = join(sessions, 'review-only.jsonl');
    writeFileSync(implementerFile, '{"type":"turn"}\n');
    writeFileSync(reviewerFile, '{"type":"turn"}\n');
    await seedPendingRebrief({ h, jobId });
    // The implementer registered first; the review-only rows registered
    // after it are the NEWEST minion-looking rows of the job — exactly the
    // shape that made the old latest-minion fallback resume a reviewer.
    h.ledger.registerAgent({ id: 'impl-worker', role: 'minion', jobId, sessionFile: implementerFile });
    const round = h.ledger.addRound({ jobId, lenses: ['blind'] });
    h.ledger.registerAgent({ id: 'zz-fallback-reviewer', role: 'perkins', jobId, sessionFile: reviewerFile });
    h.ledger.registerAgent({ id: 'zz-round-reviewer', role: 'minion', roundId: round.id, jobId, sessionFile: reviewerFile });
    h.ledger.registerAgent({ id: 'zz-lens-reviewer', role: 'minion', jobId, sessionFile: reviewerFile });
    h.ledger.bindLens(round.id, 'blind', 'zz-lens-reviewer');
    // Deterministic recency: every reviewer row strictly newer than the
    // implementer row, regardless of clock granularity.
    const bump = h.db.handle.prepare('UPDATE agents SET updated_at = ? WHERE id = ?');
    bump.run('2026-09-29T12:00:02.000Z', 'zz-lens-reviewer');
    bump.run('2026-09-29T12:00:03.000Z', 'zz-round-reviewer');
    bump.run('2026-09-29T12:00:04.000Z', 'zz-fallback-reviewer');
    bump.run('2026-09-29T12:00:01.000Z', 'impl-worker');


    await assertHistoricalRefusal(h, jobId);
  });

  it("historical a stale marker bound to a review-only session never resumes the reviewer (2026-10-05 edge review): zero replay and concrete Gru judgment", async () => {
    const h = makeHarness();
    const jobId = 'stale-marker-job';
    const sessions = join(h.dir, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const implementerFile = join(sessions, 'stale-marker-implementer.jsonl');
    const reviewerFile = join(sessions, 'stale-marker-reviewer.jsonl');
    writeFileSync(implementerFile, '{"type":"turn"}\n');
    writeFileSync(reviewerFile, '{"type":"turn"}\n');
    // The marker predates the implementer-only ruling and carries a
    // reviewer's session — exactly the legacy shape the guard rejects.
    await seedPendingRebrief({ h, jobId, bindWorker: { agentId: 'legacy-reviewer', sessionFile: reviewerFile } });
    h.ledger.registerAgent({ id: 'stale-impl', role: 'minion', jobId, sessionFile: implementerFile });
    h.ledger.registerAgent({ id: 'legacy-reviewer', role: 'perkins', jobId, sessionFile: reviewerFile });
    const bump = h.db.handle.prepare('UPDATE agents SET updated_at = ? WHERE id = ?');
    bump.run('2026-09-29T12:00:02.000Z', 'legacy-reviewer');
    bump.run('2026-09-29T12:00:01.000Z', 'stale-impl');

    await assertHistoricalRefusal(h, jobId);
  });

  it("historical a job whose only minion-side rows are review-only gets a FRESH worker, never a resumed reviewer: zero replay and concrete Gru judgment", async () => {
    const h = makeHarness();
    const jobId = 'only-reviewers-job';
    const sessions = join(h.dir, 'sessions');
    mkdirSync(sessions, { recursive: true });
    const reviewerFile = join(sessions, 'review-only.jsonl');
    writeFileSync(reviewerFile, '{"type":"turn"}\n');
    await seedPendingRebrief({ h, jobId });
    h.ledger.registerAgent({ id: 'zz-fallback-reviewer', role: 'perkins', jobId, sessionFile: reviewerFile });

    await assertHistoricalRefusal(h, jobId);
  });

  it("historical double-does not double-dispatch: in-flight claims and consumed markers are idempotent: zero replay and concrete Gru judgment", async () => {
    const h = makeHarness(); const jobId = 'historical-463';
    try {
      await seedPendingRebrief({ h, jobId });



      h.registry.failSpawn = new Error('must never spawn'); h.registry.failPrompt = new Error('must never prompt');
      await assertHistoricalRefusal(h, jobId);



    } finally { h.close(); }
  });

  it("historical a held boot-redispatched ordinary turn cannot finalize a replacement request: zero replay and concrete Gru judgment", async () => {
    const h = makeHarness(); const jobId = 'historical-495';
    try {
      await seedPendingRebrief({ h, jobId });



      h.registry.failSpawn = new Error('must never spawn'); h.registry.failPrompt = new Error('must never prompt');
      await assertHistoricalRefusal(h, jobId);



    } finally { h.close(); }
  });

  it("historical a failed re-dispatch escalates action-required and keeps the markers for the next boot: zero replay and concrete Gru judgment", async () => {
    const h = makeHarness(); const jobId = 'historical-525';
    try {
      await seedPendingRebrief({ h, jobId });



      h.registry.failSpawn = new Error('must never spawn'); h.registry.failPrompt = new Error('must never prompt');
      await assertHistoricalRefusal(h, jobId);



    } finally { h.close(); }
  });

  it("historical a terminal lane settles its stale markers and posts the bound escalation once: unknown work is never replayed before terminal retirement", async () => {
    const h = makeHarness(); const jobId = 'terminal-historical-558';
    try {
      await seedPendingRebrief({ h, jobId }); await assertHistoricalRefusal(h, jobId);
      merge(h, jobId);
      const pass = await reconcilePendingRebriefs({ ledger: h.ledger, worktrees: h.worktrees, registry: h.registry, notifications: h.notifications });
      await pass.settled; expect(pass.retired).toBe(1);
      expect(h.ledger.getJob(jobId)?.status).toBe('merged');
      expect(h.registry.workers).toEqual([]); expect(h.ledger.listPendingRebriefs({ jobId })).toEqual([]);
      expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    } finally { h.close(); }
  });

  it("an already-cancelled restart schedules no producer and preserves historical markers", async () => {
    const h = makeHarness(); const jobId = 'shutdown-cancelled';
    try {
      await seedPendingRebrief({ h, jobId }); const before = h.ledger.listPendingRebriefs({ jobId });
      const stop = new AbortController(); stop.abort();
      const pass = await reconcilePendingRebriefs({ ledger: h.ledger, worktrees: h.worktrees, registry: h.registry, notifications: h.notifications, stopSignal: stop.signal });
      await pass.settled; expect(pass.examined).toBe(0); expect(h.registry.workers).toEqual([]);
      expect(h.ledger.listPendingRebriefs({ jobId })).toEqual(before); expect(h.ledger.listNotifications({ limit: 100 })).toEqual([]);
    } finally { h.close(); }
  });

  it('boot completes already-proven markers and signals settlement only after clearing', async () => {
    const h = makeHarness();
    const jobId = 'already-proven-job';
    await seedPendingRebrief({ h, jobId });
    seedCorrelatedReceipt(h, jobId, 'silas.rebrief');
    const delivered = seedCorrelatedReceipt(h, jobId, 'job.delivered');
    const report = await reconcilePendingRebriefs({
      registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications,
    }, { limit: 100 });
    await report.settled;
    expect(report.completed).toBe(1);
    expect(h.registry.workers).toHaveLength(0);
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
    const settlement = h.ledger.latestJobEvent(jobId, 'silas.rebrief-settled');
    expect(settlement?.seq).toBeGreaterThan(delivered.seq);
    const again = await reconcilePendingRebriefs({
      registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications,
    }, { limit: 100 });
    expect(again.examined).toBe(0);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-settled')?.seq).toBe(settlement?.seq);
  });

  it('a settlement publication failure commits no clear; a replay settles exactly once (issue #189)', async () => {
    const h = makeHarness();
    const jobId = 'settlement-fault-job';
    await seedPendingRebrief({ h, jobId });
    seedCorrelatedReceipt(h, jobId, 'silas.rebrief');
    seedCorrelatedReceipt(h, jobId, 'job.delivered');
    let busSettlements = 0;
    h.bus.subscribe((event) => { if (event.jobId === jobId && event.kind === 'silas.rebrief-settled') busSettlements += 1; });
    const fault = new Error('settlement publication failed');
    const markers = h.ledger.listPendingRebriefs({ jobId });
    const restore = failSettlementPublication(h.ledger, fault);
    try {
      expect(() => finalizeRebriefRequest({
        ledger: h.ledger, worktrees: h.worktrees, jobId,
        minionId: 'worker', lanePath: h.lanePath, note: 'n', expectedMarkers: markers,
      })).toThrow(/settlement publication failed/u);
    } finally { restore(); }
    // Atomicity: the failure rolled the clear back, so the markers and
    // both guarded events survive and no stranded settlement exists.
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(2);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).not.toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).not.toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-settled')).toBeNull();
    expect(busSettlements).toBe(0);

    // The next pass repairs the exact window: the admitted generation
    // clears and the queued review handoff's release signal publishes
    // exactly once.
    const result = finalizeRebriefRequest({
      ledger: h.ledger, worktrees: h.worktrees, jobId,
      minionId: 'worker', lanePath: h.lanePath, note: 'n', expectedMarkers: markers,
    });
    expect(result.superseded).toBe(false);
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
    expect(h.ledger.listJobEvents(jobId).filter((event) => event.kind === 'silas.rebrief-settled')).toHaveLength(1);
    expect(busSettlements).toBe(1);
  });

  it('a newer request admitted after a settlement failure is never settled by the old turn (issue #189)', async () => {
    const h = makeHarness();
    const jobId = 'settlement-fault-supersede-job';
    await seedPendingRebrief({ h, jobId });
    seedCorrelatedReceipt(h, jobId, 'silas.rebrief');
    seedCorrelatedReceipt(h, jobId, 'job.delivered');
    const oldMarkers = h.ledger.listPendingRebriefs({ jobId });
    const restore = failSettlementPublication(h.ledger, new Error('settlement publication failed'));
    try {
      expect(() => finalizeRebriefRequest({
        ledger: h.ledger, worktrees: h.worktrees, jobId,
        minionId: 'worker', lanePath: h.lanePath, note: 'n', expectedMarkers: oldMarkers,
      })).toThrow(/settlement publication failed/u);
    } finally { restore(); }
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(2);

    // A newer request owns the lane now: the old turn's replay must not
    // settle or erase it — the older receipt stays evidence only.
    const newer = h.ledger.beginPendingRebrief({ jobId, note: 'new request', briefing: 'new contract' });
    const replay = finalizeRebriefRequest({
      ledger: h.ledger, worktrees: h.worktrees, jobId,
      minionId: 'worker', lanePath: h.lanePath, note: 'old', expectedMarkers: oldMarkers,
    });
    expect(replay.superseded).toBe(true);
    expect(h.ledger.listPendingRebriefs({ jobId }).map((marker) => marker.id)).toEqual(newer.map((marker) => marker.id));
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-settled')).toBeNull();
  });

  it('boot completion of spent markers survives a settlement failure and settles on the next pass (issue #189)', async () => {
    const h = makeHarness();
    const jobId = 'boot-settlement-fault-job';
    await seedPendingRebrief({ h, jobId });
    seedCorrelatedReceipt(h, jobId, 'silas.rebrief');
    seedCorrelatedReceipt(h, jobId, 'job.delivered');
    let busSettlements = 0;
    h.bus.subscribe((event) => { if (event.jobId === jobId && event.kind === 'silas.rebrief-settled') busSettlements += 1; });
    const restore = failSettlementPublication(h.ledger, new Error('boot settlement publication failed'));
    try {
      await expect(reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 }))
        .resolves.toMatchObject({ completed: 0, redispatched: 0, failed: 1 });
      expect(h.ledger.findNotificationByKind(`silas.rebrief-unreconciled.${jobId}`, 'active')?.detail).toContain('boot settlement publication failed');
    } finally { restore(); }
    // No clear committed: the spent markers stay for the next pass.
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(2);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-settled')).toBeNull();
    expect(busSettlements).toBe(0);

    const report = await reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 });
    await report.settled;
    expect(report.completed).toBe(1);
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
    expect(h.ledger.listJobEvents(jobId).filter((event) => event.kind === 'silas.rebrief-settled')).toHaveLength(1);
    expect(busSettlements).toBe(1);
  });

  it('the delivery-only shortcut survives a settlement failure and releases the signal on the next pass (issue #189)', async () => {
    const h = makeHarness();
    const jobId = 'delivery-only-settlement-fault-job';
    await seedPendingRebrief({ h, jobId });
    await bindOriginalRebriefSdkOwner(h.ledger, h.ledger.listPendingRebriefs({ jobId }), { cwd: h.lanePath!, dataDir: h.dir, agentId: 'worker-1' });
    seedCorrelatedReceipt(h, jobId, 'silas.rebrief');
    let busSettlements = 0;
    h.bus.subscribe((event) => { if (event.jobId === jobId && event.kind === 'silas.rebrief-settled') busSettlements += 1; });
    const restore = failSettlementPublication(h.ledger, new Error('shortcut settlement publication failed'));
    try {
      await expect(reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 }))
        .resolves.toMatchObject({ completed: 0, redispatched: 0, failed: 1 });
      expect(h.ledger.findNotificationByKind(`silas.rebrief-unreconciled.${jobId}`, 'active')?.detail).toContain('shortcut settlement publication failed');
    } finally { restore(); }
    // The recorded delivery committed in its own transaction and stays;
    // the clear rolled back with the settlement, so nothing is stranded.
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).not.toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(2);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-settled')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-recovered')).toBeNull();
    expect(busSettlements).toBe(0);

    const report = await reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 });
    await report.settled;
    expect(report.completed).toBe(1);
    expect(h.registry.workers).toHaveLength(0);
    // The shortcut's recorded delivery was never duplicated by the repair:
    // the second pass only settles what the fault rolled back.
    expect(h.ledger.listJobEvents(jobId).filter((event) => event.kind === 'job.delivered')).toHaveLength(1);
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
    expect(h.ledger.listJobEvents(jobId).filter((event) => event.kind === 'silas.rebrief-settled')).toHaveLength(1);
    expect(busSettlements).toBe(1);
  });

  it('reconstructed report delivery opens its handback obligation atomically', async () => {
    const h = makeHarness(); const jobId = 'reconstructed-report-handback';
    try {
      await seedPendingRebrief({ h, jobId, deliverable: 'review' });
      await bindOriginalRebriefSdkOwner(h.ledger, h.ledger.listPendingRebriefs({ jobId }),
        { cwd: h.lanePath!, dataDir: h.dir, agentId: 'worker-1' });
      seedCorrelatedReceipt(h, jobId, 'silas.rebrief');
      const report = await reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 });
      await report.settled;
      expect(report.completed).toBe(1);
      const delivery = h.ledger.latestJobEvent(jobId, 'job.delivered');
      expect(delivery).not.toBeNull();
      expect(h.ledger.findReportObligation(jobId)).toMatchObject({ state: 'open', firstOriginSeq: delivery!.seq });
      expect(h.ledger.listJobEventsByKinds(jobId, ['job.report-handback'])).toHaveLength(1);
    } finally { h.close(); }
  });

  it('records only the lost delivery when silas.rebrief already landed', async () => {
    const h = makeHarness();
    const jobId = 'delivery-only-job';
    await seedPendingRebrief({ h, jobId });
    await bindOriginalRebriefSdkOwner(h.ledger, h.ledger.listPendingRebriefs({ jobId }), { cwd: h.lanePath!, dataDir: h.dir, agentId: 'worker-1' });
    // The turn settled and `silas.rebrief` posted; the crash hit before the
    // delivery record.
    seedCorrelatedReceipt(h, jobId, 'silas.rebrief');
    const report = await reconcilePendingRebriefs(
      {
        registry: h.registry,
        ledger: h.ledger,
        worktrees: h.worktrees,
        notifications: h.notifications,
      },
      { limit: 100 },
    );
    expect(report.completed).toBe(1);
    await report.settled;
    // No worker re-run: the settled turn is not repeated.
    expect(h.registry.workers).toHaveLength(0);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')?.payload).toMatchObject({ minion_id: 'worker-1' });
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).not.toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-recovered')?.payload).toMatchObject({ path: 'delivery-only' });
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-settled')?.seq).toBeGreaterThan(
      h.ledger.latestJobEvent(jobId, 'job.delivered')?.seq ?? 0,
    );
    expect(h.ledger.listPendingRebriefs()).toHaveLength(0);
  });

  it('legacy reconstructed delivery preserves original SHA/revision without proving a current candidate', async () => {
    const h = makeHarness(); const jobId = 'legacy-reconstructed-stale-candidate';
    try {
      await seedPendingRebrief({ h, jobId });
      const contract = h.ledger.effectiveContract(jobId)!;
      expect(h.ledger.addJobAmendment({ jobId, body: 'accepted material requirement', supersedes: [],
        approval: { by: 'owner', reference: 'GH-286 stale candidate fixture' }, effect: 'material',
        expectedContractSha256: contract.contractSha256 }).status).toBe('accepted');
      const markers = h.ledger.beginPendingRebrief({ jobId, note: 'recover original settled work', briefing: 'original contract' });
      const oldHead = resolveGitCommit(h.lanePath!, 'HEAD');
      await bindOriginalRebriefSdkOwner(h.ledger, markers, { cwd: h.lanePath!, dataDir: h.dir, agentId: 'worker-1' });
      seedCorrelatedReceipt(h, jobId, 'silas.rebrief', 'worker-1', { sha: oldHead });
      writeFileSync(join(h.lanePath!, 'after-original-delivery.txt'), 'new current candidate\n');
      const git = (args: readonly string[]): void => { execFileSync('git', ['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', ...args], { cwd: h.lanePath!, stdio: 'ignore' }); };
      git(['add', 'after-original-delivery.txt']); git(['commit', '-m', 'fixture: advance current candidate']);
      expect(resolveGitCommit(h.lanePath!, 'HEAD')).not.toBe(oldHead);

      const report = await reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 });
      await report.settled;
      expect(report.completed).toBe(1);
      const delivery = h.ledger.latestJobEvent(jobId, 'job.delivered')!;
      expect(delivery.payload).toMatchObject({ sha: oldHead, work_revision: 1, historical_bookkeeping_only: true, candidate_delivery_proven: false });
      expect(h.ledger.latestCandidateDelivery(jobId)).toBeNull();
      expect(h.ledger.workRevisionState(jobId)).toEqual({ required: 1, delivered: 0 });
      expect(h.ledger.correctiveVerificationDebt(jobId)).toEqual({ revision: 1, head: null });
    } finally { h.close(); }
  });

  async function originalCurrentCandidate(jobId: string, report = false) {
    const h = makeHarness();
    await seedPendingRebrief({ h, jobId, ...(report ? { deliverable: 'review' as const } : {}) });
    const contract = h.ledger.effectiveContract(jobId)!;
    expect(h.ledger.addJobAmendment({ jobId, body: 'approved corrective scope', supersedes: [],
      approval: { by: 'owner', reference: 'GH-286 current candidate fixture' }, effect: 'material',
      expectedContractSha256: contract.contractSha256 }).status).toBe('accepted');
    const markers = h.ledger.beginPendingRebrief({ jobId, note: 'original correction', briefing: 'approved scope' });
    await bindOriginalRebriefSdkOwner(h.ledger, markers, { cwd: h.lanePath!, dataDir: h.dir, agentId: 'worker-1' });
    const head = resolveGitCommit(h.lanePath!, 'HEAD');
    seedCorrelatedReceipt(h, jobId, 'silas.rebrief', 'worker-1', { sha: head });
    return { h, head, markers: h.ledger.listPendingRebriefs({ jobId }),
      lane: h.worktrees.listWorktrees({ jobId }).find((row) => row.kind === 'job')! };
  }

  it('reconstructed delivery establishes current eligibility only with exact native identity and clean original-lane HEAD', async () => {
    const jobId = 'legacy-current-candidate-proven'; const { h, head, markers, lane } = await originalCurrentCandidate(jobId);
    try {
      const delivery = h.ledger.reconstructCompletedRebriefDelivery(markers, lane)!;
      expect(delivery.payload).toMatchObject({ sha: head, work_revision: 1, historical_bookkeeping_only: true,
        candidate_delivery_proven: true, current_candidate_proof: { lane_id: lane.id, lane_path: lane.path, sha: head,
          identity: { jobId, workRevision: 1, requestId: markers.find((row) => row.kind === 'silas.rebrief')!.id } } });
      expect(h.ledger.workRevisionState(jobId)).toEqual({ required: 1, delivered: 1 });
      expect(h.ledger.correctiveVerificationDebt(jobId)).toEqual({ revision: 1, head });
    } finally { h.close(); }
  });

  async function assertHistoricalCandidateRefusal(mode: 'branch' | 'untracked') {
    const jobId = `r13-historical-${mode}`; const { h, head, markers, lane } = await originalCurrentCandidate(jobId);
    try {
      if (mode === 'branch') fixtureRepo().git(['checkout', '-b', 'unapproved-historical-branch'], lane.path);
      else writeFileSync(join(lane.path, 'untracked-material-input.ts'), 'export const changedInput = true;\n');
      expect(resolveGitCommit(lane.path, 'HEAD')).toBe(head);
      const nativeBytes = readFileSync(markers[0]!.sessionFile!, 'utf8');
      const completion = h.ledger.latestJobEvent(jobId, 'silas.rebrief');
      const delivery = h.ledger.reconstructCompletedRebriefDelivery(markers, lane)!;
      expect(delivery.payload).toMatchObject({ sha: head, work_revision: 1, historical_bookkeeping_only: true, candidate_delivery_proven: false });
      expect((delivery.payload as { current_candidate_proof?: unknown }).current_candidate_proof ?? null).toBeNull();
      expect(h.ledger.latestCandidateDelivery(jobId)).toBeNull();
      expect(h.ledger.correctiveVerificationDebt(jobId)).toEqual({ revision: 1, head: null });
      expect(h.ledger.clearPendingRebriefsIfCurrentAndSettle(markers)).toBe(true);
      expect(h.ledger.getEvent(completion!.seq)).toEqual(completion);
      expect(readFileSync(markers[0]!.sessionFile!, 'utf8')).toBe(nativeBytes);
      expect(h.registry.workers).toEqual([]);
    } finally { h.close(); }
  }
  it('R14 reconstructed noncandidate historical report never opens direct commissioner handback', async () => {
    const jobId = 'r14-historical-report'; const { h, head, markers, lane } = await originalCurrentCandidate(jobId, true);
    try {
      writeFileSync(join(lane.path, 'new-material-input.ts'), 'export const newInput = true;\n');
      const bytes = readFileSync(markers[0]!.sessionFile!, 'utf8'); const original = h.ledger.latestJobEvent(jobId, 'silas.rebrief');
      const delivery = h.ledger.reconstructCompletedRebriefDelivery(markers, lane)!;
      expect(delivery.payload).toMatchObject({ sha: head, work_revision: 1, historical_bookkeeping_only: true, candidate_delivery_proven: false });
      expect(h.ledger.latestCandidateDelivery(jobId)).toBeNull();
      expect(h.ledger.findReportObligation(jobId)).toBeNull();
      expect(h.ledger.listJobEventsByKinds(jobId, ['job.report-handback'])).toEqual([]);
      expect(h.ledger.clearPendingRebriefsIfCurrentAndSettle(markers)).toBe(true);
      expect(h.ledger.getEvent(original!.seq)).toEqual(original); expect(readFileSync(markers[0]!.sessionFile!, 'utf8')).toBe(bytes);
      expect(h.registry.workers).toEqual([]);
    } finally { h.close(); }
  });
  it('R13 historical same-HEAD reconstruction refuses an unapproved branch without erasing original completion', () => assertHistoricalCandidateRefusal('branch'));
  it('R13 historical reconstruction refuses material untracked inputs absent from its original HEAD', () => assertHistoricalCandidateRefusal('untracked'));

  it('reconstructed delivery never proves a same-HEAD candidate whose tracked tree is dirty', async () => {
    const jobId = 'legacy-dirty-current-candidate'; const { h, head, markers, lane } = await originalCurrentCandidate(jobId);
    try {
      writeFileSync(join(lane.path, 'README.md'), 'uncommitted current changes\n');
      const delivery = h.ledger.reconstructCompletedRebriefDelivery(markers, lane)!;
      expect(delivery.payload).toMatchObject({ sha: head, work_revision: 1, candidate_delivery_proven: false });
      expect((delivery.payload as { current_candidate_proof?: unknown }).current_candidate_proof ?? null).toBeNull();
      expect(h.ledger.workRevisionState(jobId)).toEqual({ required: 1, delivered: 0 });
      expect(h.ledger.correctiveVerificationDebt(jobId)).toEqual({ revision: 1, head: null });
    } finally { h.close(); }
  });

  it('reconstructed delivery never proves a same-HEAD candidate under a later changed approved contract', async () => {
    const jobId = 'legacy-changed-current-contract'; const { h, head, markers, lane } = await originalCurrentCandidate(jobId);
    try {
      const contract = h.ledger.effectiveContract(jobId)!;
      expect(h.ledger.addJobAmendment({ jobId, body: 'updated approved administrative context', supersedes: [],
        approval: { by: 'owner', reference: 'GH-286 later authority fixture' }, effect: 'administrative',
        expectedContractSha256: contract.contractSha256 }).status).toBe('accepted');
      const delivery = h.ledger.reconstructCompletedRebriefDelivery(markers, lane)!;
      expect(delivery.payload).toMatchObject({ sha: head, work_revision: 1, candidate_delivery_proven: false });
      expect((delivery.payload as { current_candidate_proof?: unknown }).current_candidate_proof ?? null).toBeNull();
      expect(h.ledger.workRevisionState(jobId)).toEqual({ required: 1, delivered: 0 });
      expect(h.ledger.correctiveVerificationDebt(jobId)).toEqual({ revision: 1, head: null });
    } finally { h.close(); }
  });

  it('R12 bounded boot observation retains a failed historical group actionably while independent generations settle', async () => {
    const h = makeHarness(); const failedJob = 'r12-failed-observation';
    try {
      for (const jobId of [failedJob, 'r12-healthy-observation']) { await seedPendingRebrief({ h, jobId }); seedHistoricalCompletion(h, jobId); }
      const original = h.ledger.listPendingRebriefs({ jobId: failedJob });
      const clear = h.ledger.clearPendingRebriefsIfCurrentAndSettle.bind(h.ledger);
      const fault = vi.spyOn(h.ledger, 'clearPendingRebriefsIfCurrentAndSettle').mockImplementation((markers) => {
        if (markers[0]?.jobId === failedJob) throw new Error('persistent original scoped observation failure');
        return clear(markers);
      });
      const deps = { registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications };
      try {
        await expect(reconcilePendingRebriefs(deps)).resolves.toMatchObject({ completed: 1, redispatched: 0, failed: 1 });
        await expect(reconcilePendingRebriefs(deps)).resolves.toMatchObject({ completed: 0, redispatched: 0, failed: 1 });
        expect(h.ledger.listPendingRebriefs({ jobId: failedJob })).toEqual(original);
        expect(h.ledger.listPendingRebriefs({ jobId: 'r12-healthy-observation' })).toEqual([]);
        const debt = h.ledger.listObligations({ jobId: failedJob }).find((row) => row.incidentKey === `rebrief-recovery:${original.find((row) => row.kind === 'silas.rebrief')!.id}`);
        expect(debt).toMatchObject({ state: 'open', nextAction: { kind: 'gru-decision' } });
        const card = h.ledger.findNotificationByKind(`silas.rebrief-unreconciled.${failedJob}`, 'active');
        expect(card).toMatchObject({ routing: 'action-required' }); expect(card?.detail).toContain('persistent original scoped observation failure');
        expect(h.registry.workers).toEqual([]); expect(h.registry.disposed).toEqual([]);
      } finally { fault.mockRestore(); }
      const recovered = await reconcilePendingRebriefs(deps);
      expect(recovered.completed).toBe(1); expect(h.ledger.listPendingRebriefs()).toEqual([]);
    } finally { h.close(); }
  });

  it('R12 failed old observation never attributes its error or opens recovery debt against a replacement generation', async () => {
    const h = makeHarness(); const jobId = 'r12-replaced-failed-observation';
    try {
      await seedPendingRebrief({ h, jobId }); seedHistoricalCompletion(h, jobId);
      const old = h.ledger.listPendingRebriefs({ jobId });
      const fault = vi.spyOn(h.ledger, 'clearPendingRebriefsIfCurrentAndSettle').mockImplementationOnce(() => {
        h.ledger.clearPendingRebriefs(old.map((row) => row.id));
        h.ledger.beginPendingRebrief({ jobId, note: 'new original intent', briefing: 'separately accepted replacement context' });
        throw new Error('old observation failed after replacement');
      });
      try {
        await expect(reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }))
          .resolves.toMatchObject({ completed: 0, failed: 1 });
        const newer = h.ledger.listPendingRebriefs({ jobId }); expect(newer).toHaveLength(2);
        expect(newer.some((row) => old.some((prior) => prior.id === row.id))).toBe(false);
        expect(h.ledger.listObligations({ jobId }).some((row) => row.incidentKey?.startsWith('rebrief-recovery:'))).toBe(false);
        expect(h.ledger.findNotificationByKind(`silas.rebrief-unreconciled.${jobId}`, 'active')).toBeNull();
        expect(h.registry.workers).toEqual([]);
      } finally { fault.mockRestore(); }
    } finally { h.close(); }
  });

  it('R12 shared historical cursor storage failure remains a loud refusal, not successful isolated recovery', async () => {
    const h = makeHarness(); const fault = vi.spyOn(h.ledger, 'readReconcileCursor').mockImplementationOnce(() => { throw new Error('shared historical storage unavailable'); });
    try {
      await expect(reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }))
        .rejects.toThrow(/shared historical storage unavailable/);
      expect(h.registry.workers).toEqual([]);
    } finally { fault.mockRestore(); h.close(); }
  });

  it('retries a failed historical group on the next bounded pass instead of waiting for cursor wraparound', async () => {
    const h = makeHarness();
    try {
      await seedPendingRebrief({ h, jobId: 'retry-cursor-first' }); seedHistoricalCompletion(h, 'retry-cursor-first');
      await seedPendingRebrief({ h, jobId: 'retry-cursor-second' }); seedHistoricalCompletion(h, 'retry-cursor-second');
      const restore = failSettlementPublication(h.ledger, new Error('first historical settlement fails'));
      try {
        await expect(reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 1 }))
          .resolves.toMatchObject({ completed: 0, redispatched: 0, failed: 1 });
        expect(h.ledger.findNotificationByKind('silas.rebrief-unreconciled.retry-cursor-first', 'active')?.detail).toContain('first historical settlement fails');
      } finally { restore(); }

      h.db.close();
      const restartedDb = new LedgerDb(h.dir);
      h.db = restartedDb;
      h.ledger = new LedgerApi(restartedDb.handle, { bus: h.bus });
      h.notifications = new NotificationCenter({ ledger: h.ledger, bus: h.bus });
      h.close = () => restartedDb.close();
      const retry = await reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 1 });
      await retry.settled;
      expect(retry.completed).toBe(2);
      expect(h.ledger.listPendingRebriefs({ jobId: 'retry-cursor-first' })).toHaveLength(0);
      expect(h.ledger.listPendingRebriefs({ jobId: 'retry-cursor-second' })).toHaveLength(0);
    } finally { h.close(); }
  });

  it('refuses oversized per-job receipt history instead of producing a truncated evidence digest', async () => {
    const h = makeHarness(); const jobId = 'bounded-rebrief-receipt-evidence';
    try {
      await seedPendingRebrief({ h, jobId });
      for (let index = 0; index < 4_097; index += 1) {
        h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { unmarked_receipt_fixture: index } });
      }
      const marker = h.ledger.listPendingRebriefs({ jobId })[0]!;
      expect(() => h.ledger.rebriefReceiptEvidence(marker.id)).toThrow(/rebrief receipt evidence exceeds the 4096-event inspection limit/);
    } finally { h.close(); }
  });

  it('accepts the complete receipt evidence at the event inspection limit', async () => {
    const h = makeHarness(); const jobId = 'rebrief-receipt-evidence-at-limit';
    try {
      await seedPendingRebrief({ h, jobId });
      for (let index = 0; index < 4_096; index += 1) {
        h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { unmarked_receipt_fixture: index } });
      }
      const marker = h.ledger.listPendingRebriefs({ jobId })[0]!;
      const evidence = h.ledger.rebriefReceiptEvidence(marker.id);
      expect(evidence.receipts).toHaveLength(4_096);
      expect(evidence.receipts[0]?.payload).toEqual({ unmarked_receipt_fixture: 0 });
      expect(evidence.receipts.at(-1)?.payload).toEqual({ unmarked_receipt_fixture: 4_095 });
      expect(h.ledger.rebriefReceiptEvidence(marker.id).sha256).toBe(evidence.sha256);
    } finally { h.close(); }
  });

  it('refuses oversized receipt payloads and cumulative bytes instead of hashing partial evidence', async () => {
    const h = makeHarness(); const jobId = 'rebrief-receipt-evidence-byte-limit';
    try {
      await seedPendingRebrief({ h, jobId });
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId, payload: { detail: '界'.repeat(3 * 1024 * 1024) } });
      const marker = h.ledger.listPendingRebriefs({ jobId })[0]!;
      expect(() => h.ledger.rebriefReceiptEvidence(marker.id)).toThrow(/rebrief receipt evidence exceeds the 8388608-byte inspection limit/);

      const otherJob = 'rebrief-receipt-evidence-cumulative-byte-limit';
      await seedPendingRebrief({ h, jobId: otherJob });
      const otherMarker = h.ledger.listPendingRebriefs({ jobId: otherJob })[0]!;
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: otherJob, payload: { detail: 'a'.repeat(5 * 1024 * 1024) } });
      expect(h.ledger.rebriefReceiptEvidence(otherMarker.id).receipts).toHaveLength(1);
      h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: otherJob, payload: { detail: 'b'.repeat(5 * 1024 * 1024) } });
      expect(() => h.ledger.rebriefReceiptEvidence(otherMarker.id)).toThrow(/rebrief receipt evidence exceeds the 8388608-byte inspection limit/);
    } finally { h.close(); }
  });

  it('a repeatedly failed historical retry does not starve the bounded main page', async () => {
    const h = makeHarness();
    try {
      for (const jobId of ['failed-retry-first', 'successful-main-second', 'successful-main-third']) {
        await seedPendingRebrief({ h, jobId }); seedHistoricalCompletion(h, jobId);
      }
      const clear = h.ledger.clearPendingRebriefsIfCurrentAndSettle.bind(h.ledger);
      const fault = vi.spyOn(h.ledger, 'clearPendingRebriefsIfCurrentAndSettle').mockImplementation((markers) => {
        if (markers[0]?.jobId === 'failed-retry-first') throw new Error('persistent historical settlement failure');
        return clear(markers);
      });
      const deps = { registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications };
      try {
        await expect(reconcilePendingRebriefs(deps, { limit: 1 })).resolves.toMatchObject({ completed: 0, redispatched: 0, failed: 1 });
        await expect(reconcilePendingRebriefs(deps, { limit: 1 })).resolves.toMatchObject({ completed: 1, redispatched: 0, failed: 1 });
        expect(h.ledger.listPendingRebriefs({ jobId: 'successful-main-second' })).toHaveLength(0);
        await expect(reconcilePendingRebriefs(deps, { limit: 1 })).resolves.toMatchObject({ completed: 1, redispatched: 0, failed: 1 });
        expect(h.ledger.findNotificationByKind('silas.rebrief-unreconciled.failed-retry-first', 'active')?.detail).toContain('persistent historical settlement failure');
        expect(h.ledger.listPendingRebriefs({ jobId: 'successful-main-third' })).toHaveLength(0);
        expect(h.ledger.listPendingRebriefs({ jobId: 'failed-retry-first' })).toHaveLength(2);
      } finally { fault.mockRestore(); }
      const recovered = await reconcilePendingRebriefs(deps, { limit: 1 });
      expect(recovered.completed).toBe(1);
      expect(h.ledger.listPendingRebriefs()).toHaveLength(0);
    } finally { h.close(); }
  });

  it("historical a recovery turn that resolves with an in-band error records no guarded events and keeps the markers (r4 blocker 1): zero replay and concrete Gru judgment", async () => {
    const h = makeHarness(); const jobId = 'historical-812';
    try {
      await seedPendingRebrief({ h, jobId });



      h.registry.failSpawn = new Error('must never spawn'); h.registry.failPrompt = new Error('must never prompt');
      await assertHistoricalRefusal(h, jobId);



    } finally { h.close(); }
  });

  it('future-clock historical markers remain exact and owe concrete judgment on repeated scans', async () => {
    const h = makeHarness(); const jobId = 'future-clock-job';
    try {
      await seedPendingRebrief({ h, jobId });
      const future = new Date(Date.now() + 86_400_000).toISOString();
      h.db.handle.prepare('UPDATE pending_rebriefs SET requested_at = ? WHERE job_id = ?').run(future, jobId);
      await assertHistoricalRefusal(h, jobId);
      expect(h.ledger.listPendingRebriefs({ jobId }).every((marker) => marker.requestedAt === future)).toBe(true);
    } finally { h.close(); }
  });

  it('same-millisecond historical markers owe exact judgment without waiting for clock age', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-01T00:00:00.000Z'));
    const h = makeHarness(); const jobId = 'same-millisecond-job';
    try {
      await seedPendingRebrief({ h, jobId });
      expect(h.ledger.listPendingRebriefs({ jobId }).every((marker) => marker.requestedAt === new Date().toISOString())).toBe(true);
      await assertHistoricalRefusal(h, jobId);
    } finally { h.close(); vi.useRealTimers(); }
  });

  it("historical an older ordinary turn cannot consume newer markers with the same null phase and payload: an unproven callback cannot mint completion", async () => {
    const h = makeHarness();
    const jobId = 'ordinary-superseded';
    await seedPendingRebrief({ h, jobId, note: 'same note' });
    const first = h.ledger.listPendingRebriefs({ jobId });
    const second = h.ledger.beginPendingRebrief({ jobId, note: 'same note', briefing: 'the original contract' });
    expect(second.map((marker) => marker.id)).not.toEqual(first.map((marker) => marker.id));
    expect(second.every((marker) => marker.phaseId === null)).toBe(true);
    const input = {
      ledger: h.ledger, worktrees: h.worktrees, jobId,
      minionId: 'older-minion', lanePath: h.lanePath, note: 'same note',
    };
    expect(finalizeRebriefRequest({ ...input, expectedPhaseId: null,
      expectedMarkers: first })).toMatchObject({
      superseded: true, rebriefRecorded: false, deliveryRecorded: false,
    });
    expect(h.ledger.listPendingRebriefs({ jobId }).map((marker) => marker.id)).toEqual(second.map((marker) => marker.id));
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-settled')).toBeNull();
    expect(() => finalizeRebriefRequest({ ...input, expectedMarkers: second })).toThrow('completion is unproven');
    expect(h.ledger.listPendingRebriefs({ jobId })).toEqual(second);
  });

  it("historical finalize is idempotent: a replayed finalize appends no duplicate events: an unproven callback cannot mint completion", async () => {
    const h = makeHarness();
    const jobId = 'replay-job';
    await seedPendingRebrief({ h, jobId });
    seedHistoricalCompletion(h, jobId);
    const input = {
      ledger: h.ledger,
      worktrees: h.worktrees,
      jobId,
      minionId: 'worker-9',
      lanePath: h.lanePath,
      note: 'n',
    };
    const first = finalizeRebriefRequest(input);
    expect(first.rebriefRecorded).toBe(false);
    expect(first.deliveryRecorded).toBe(false);
    expect(h.ledger.listPendingRebriefs()).toHaveLength(0);
    const second = finalizeRebriefRequest(input);
    expect(second.rebriefRecorded).toBe(false);
    expect(second.deliveryRecorded).toBe(false);
    const events = h.ledger.listJobEvents(jobId).filter((event) => event.kind === 'silas.rebrief' || event.kind === 'job.delivered');
    expect(events).toHaveLength(2);
  });
});

describe('terminal re-brief retirement', () => {
  it("historical an older unmarked turn cannot complete or consume a newer ordinary request: an unproven callback cannot mint completion", async () => {
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

  it("historical terminality while queued for a worker slot cancels before disposal or spawn and audits once: zero replay and concrete Gru judgment", async () => {
    const h = makeHarness(); const jobId = 'historical-955';
    try {
      await seedPendingRebrief({ h, jobId });

      const workerGate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 }); const holder = await workerGate.acquireWorkerTurn({ id: 'other-job', label: 'fixture hold' }); const release = () => holder.release();

      h.registry.failSpawn = new Error('must never spawn'); h.registry.failPrompt = new Error('must never prompt');
      await assertHistoricalRefusal(h, jobId, workerGate);
      expect(workerGate.view().worker.queued.length).toBe(0); release();


    } finally { h.close(); }
  });

  it("historical an agent.spawned subscriber terminalizing the job cancels before prompt and disposes the handle: zero replay and concrete Gru judgment", async () => {
    const h = makeHarness(); const jobId = 'historical-983';
    try {
      await seedPendingRebrief({ h, jobId });



      h.registry.failSpawn = new Error('must never spawn'); h.registry.failPrompt = new Error('must never prompt');
      await assertHistoricalRefusal(h, jobId);



    } finally { h.close(); }
  });

  it("historical an agent.spawned subscriber replacing the request cannot prompt the stale turn: zero replay and concrete Gru judgment", async () => {
    const h = makeHarness(); const jobId = 'historical-997';
    try {
      await seedPendingRebrief({ h, jobId });



      h.registry.failSpawn = new Error('must never spawn'); h.registry.failPrompt = new Error('must never prompt');
      await assertHistoricalRefusal(h, jobId);



    } finally { h.close(); }
  });

  it("historical terminality during asynchronous spawn prevents binding and prompting the spawned worker: zero replay and concrete Gru judgment", async () => {
    const h = makeHarness(); const jobId = 'historical-1015';
    try {
      await seedPendingRebrief({ h, jobId });



      h.registry.failSpawn = new Error('must never spawn'); h.registry.failPrompt = new Error('must never prompt');
      await assertHistoricalRefusal(h, jobId);



    } finally { h.close(); }
  });

  it('an incomplete marker pair stays visible and escalates without claiming recovery', async () => {
    const h = makeHarness();
    const jobId = 'incomplete-rebrief-pair';
    await seedPendingRebrief({ h, jobId });
    const pair = h.ledger.listPendingRebriefs({ jobId });
    h.ledger.clearPendingRebriefs(pair.filter((row) => row.kind === 'job.delivered').map((row) => row.id));
    const report = await reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 });
    await report.settled;
    expect(report.completed).toBe(0);
    expect(h.registry.workers).toHaveLength(0);
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(1);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-recovered')).toBeNull();
    expect(h.ledger.listNotifications().some((row) => row.kind === `silas.rebrief-unreconciled.${jobId}`)).toBe(true);
    expect(() => finalizeRebriefRequest({
      ledger: h.ledger, worktrees: h.worktrees, jobId, minionId: 'worker', lanePath: h.lanePath, note: 'n',
    })).toThrow(/incomplete marker pair/u);
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
  });

  async function assertMixedPairStaysVisible(column: 'phase_id' | 'payload_hash' | 'baseline_seq'): Promise<void> {
    const h = makeHarness();
    const jobId = `mixed-${column}`;
    await seedPendingRebrief({ h, jobId });
    const pair = h.ledger.listPendingRebriefs({ jobId });
    h.db.handle.prepare(`UPDATE pending_rebriefs SET ${column} = ? WHERE id = ?`)
      .run(column === 'phase_id' ? 'foreign-phase' : column === 'payload_hash' ? 'foreign-hash' : pair[0]!.baselineSeq + 1, pair[0]!.id);
    merge(h, jobId);
    const report = await reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 });
    await report.settled;
    expect(report).toMatchObject({ completed: 0, redispatched: 0, retired: 0 });
    expect(h.registry.workers).toHaveLength(0);
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(2);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired')).toBeNull();
    expect(h.ledger.listNotifications().some((row) => row.kind === `silas.rebrief-unreconciled.${jobId}` && (row.detail ?? '').includes('incoherent marker pair'))).toBe(true);
    expect(() => finalizeRebriefRequest({ ledger: h.ledger, worktrees: h.worktrees, jobId, minionId: 'worker', lanePath: h.lanePath, note: 'n' }))
      .toThrow(/incoherent marker pair/u);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
  }

  it('a mixed phase pair stays visible at boot and finalization', async () => {
    await assertMixedPairStaysVisible('phase_id');
  });
  it('a mixed hash pair stays visible at boot and finalization', async () => {
    await assertMixedPairStaysVisible('payload_hash');
  });
  it('a mixed watermark pair stays visible at boot and finalization', async () => {
    await assertMixedPairStaysVisible('baseline_seq');
  });

  it('a fully landed terminal pair signals settlement once after clearing, never retirement', async () => {
    const h = makeHarness();
    const jobId = 'terminal-spent-settlement';
    await seedPendingRebrief({ h, jobId });
    seedCorrelatedReceipt(h, jobId, 'silas.rebrief');
    const delivered = seedCorrelatedReceipt(h, jobId, 'job.delivered');
    merge(h, jobId);
    const report = await reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 });
    await report.settled;
    expect(report).toMatchObject({ completed: 1, retired: 0 });
    const settled = h.ledger.latestJobEvent(jobId, 'silas.rebrief-settled');
    expect(settled?.seq).toBeGreaterThan(delivered.seq);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired')).toBeNull();
    await (await reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 })).settled;
    expect(h.ledger.listJobEvents(jobId).filter((event) => event.kind === 'silas.rebrief-settled')).toHaveLength(1);
  });

  it('terminal retirement and malformed-pair escalation never publish settlement', async () => {
    const h = makeHarness();
    const retiredJob = 'obsolete-no-settlement';
    const malformedJob = 'malformed-no-settlement';
    await seedPendingRebrief({ h, jobId: retiredJob });
    await seedPendingRebrief({ h, jobId: malformedJob });
    const mixed = h.ledger.listPendingRebriefs({ jobId: malformedJob });
    h.db.handle.prepare('UPDATE pending_rebriefs SET phase_id = ? WHERE id = ?').run('foreign', mixed[0]!.id);
    merge(h, retiredJob);
    merge(h, malformedJob);
    const report = await reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 });
    await report.settled;
    expect(report.retired).toBe(1);
    expect(h.ledger.latestJobEvent(retiredJob, 'silas.rebrief-settled')).toBeNull();
    expect(h.ledger.latestJobEvent(malformedJob, 'silas.rebrief-settled')).toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId: malformedJob })).toHaveLength(2);
  });

  it("historical a rebrief publication subscriber superseding the pair prevents delivery and reopen: an unproven callback cannot mint completion", async () => {
    const h = makeHarness(); const jobId = 'unproven-1118';
    try {
      const seed = await seedPendingRebrief({ h, jobId });
      const before = h.ledger.listPendingRebriefs({ jobId });
      expect(() => finalizeRebriefRequest({ ledger: h.ledger, worktrees: h.worktrees, jobId, minionId: 'old-worker', lanePath: seed.path, note: 'unproven callback' })).toThrow('completion is unproven');
      expect(h.ledger.listPendingRebriefs({ jobId })).toEqual(before);
      expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).toBeNull();
      expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    } finally { h.close(); }
  });

  it("historical same-generation nonterminal finalization records both guarded events once: an unproven callback cannot mint completion", async () => {
    const h = makeHarness(); const jobId = 'unproven-1139';
    try {
      const seed = await seedPendingRebrief({ h, jobId });
      const before = h.ledger.listPendingRebriefs({ jobId });
      expect(() => finalizeRebriefRequest({ ledger: h.ledger, worktrees: h.worktrees, jobId, minionId: 'old-worker', lanePath: seed.path, note: 'unproven callback' })).toThrow('completion is unproven');
      expect(h.ledger.listPendingRebriefs({ jobId })).toEqual(before);
      expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).toBeNull();
      expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    } finally { h.close(); }
  });
  it('finalization retires the admitted request when the original-facts transaction boundary turns terminal before delivery', async () => {
    const h = makeHarness();
    const jobId = 'terminal-during-finalize-delivery';
    await seedPendingRebrief({ h, jobId });
    seedCorrelatedReceipt(h, jobId, 'silas.rebrief', 'worker');
    const markers = h.ledger.listPendingRebriefs({ jobId });
    const original = h.ledger.reconstructCompletedRebriefDelivery.bind(h.ledger);
    vi.spyOn(h.ledger, 'reconstructCompletedRebriefDelivery').mockImplementationOnce((expected) => {
      merge(h, jobId); // actual ledger reconstruction boundary, not today's HEAD heuristic
      return original(expected);
    });
    const worktrees = h.worktrees;
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

  it('finalization does not deliver the old turn after a new request replaces its markers at the original-facts transaction boundary', async () => {
    const h = makeHarness();
    const jobId = 'superseded-during-finalize-delivery';
    await seedPendingRebrief({ h, jobId });
    seedCorrelatedReceipt(h, jobId, 'silas.rebrief', 'worker');
    const markers = h.ledger.listPendingRebriefs({ jobId });
    const original = h.ledger.reconstructCompletedRebriefDelivery.bind(h.ledger);
    vi.spyOn(h.ledger, 'reconstructCompletedRebriefDelivery').mockImplementationOnce((expected) => {
      h.ledger.beginPendingRebrief({ jobId, note: 'new request', briefing: 'new contract' });
      return original(expected);
    });
    const worktrees = h.worktrees;
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
    await bindOriginalRebriefSdkOwner(h.ledger, h.ledger.listPendingRebriefs({ jobId }), { cwd: h.lanePath!, dataDir: h.dir, agentId: 'worker' });
    seedCorrelatedReceipt(h, jobId, 'silas.rebrief', 'worker');
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
      { limit: 100 },
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
    seedCorrelatedReceipt(h, jobId, 'silas.rebrief');
    merge(h, jobId);
    const report = await reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 });
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

  it('a delivery-only crash window that turns terminal at the original-facts transaction boundary retires instead of fabricating delivery', async () => {
    const h = makeHarness();
    const jobId = 'terminal-during-delivery-lookup';
    await seedPendingRebrief({ h, jobId });
    seedCorrelatedReceipt(h, jobId, 'silas.rebrief');
    const original = h.ledger.reconstructCompletedRebriefDelivery.bind(h.ledger);
    vi.spyOn(h.ledger, 'reconstructCompletedRebriefDelivery').mockImplementationOnce((expected) => {
      merge(h, jobId); // actual ledger reconstruction boundary, not today's HEAD heuristic
      return original(expected);
    });
    const worktrees = h.worktrees;
    const report = await reconcilePendingRebriefs({ ...deps(h), worktrees }, { limit: 100 });
    await report.settled;
    expect(report.completed).toBe(0);
    expect(report.retired).toBe(1);
    expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-recovered')).toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
    expect(retiredAudit(h, jobId)).toHaveLength(2);
  });

  it('a delivery-only shortcut cannot record a replaced request at the original-facts transaction boundary', async () => {
    const h = makeHarness();
    const jobId = 'superseded-during-delivery-lookup';
    await seedPendingRebrief({ h, jobId });
    seedCorrelatedReceipt(h, jobId, 'silas.rebrief');
    const original = h.ledger.reconstructCompletedRebriefDelivery.bind(h.ledger);
    vi.spyOn(h.ledger, 'reconstructCompletedRebriefDelivery').mockImplementationOnce((expected) => {
      h.ledger.beginPendingRebrief({ jobId, note: 'new request', briefing: 'new contract' });
      return original(expected);
    });
    const worktrees = h.worktrees;
    const report = await reconcilePendingRebriefs({ ...deps(h), worktrees }, { limit: 100 });
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
    const first = reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 });
    const second = reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 });
    const firstReport = await first;
    const secondReport = await second;
    expect(firstReport.retired).toBe(1);
    expect(secondReport.examined).toBe(0);
    await firstReport.settled;
    await secondReport.settled;
    const audits = h.ledger.listJobEvents(jobId).filter((event) => event.kind === 'silas.rebrief-retired');
    expect(audits).toHaveLength(1);
  });

  it("historical a terminal flip during a re-dispatch turn retires the request instead of recording a stale completion: unknown work is never replayed before terminal retirement", async () => {
    const h = makeHarness(); const jobId = 'terminal-historical-1406';
    try {
      await seedPendingRebrief({ h, jobId }); await assertHistoricalRefusal(h, jobId);
      merge(h, jobId);
      const pass = await reconcilePendingRebriefs({ ledger: h.ledger, worktrees: h.worktrees, registry: h.registry, notifications: h.notifications });
      await pass.settled; expect(pass.retired).toBe(1);
      expect(h.ledger.getJob(jobId)?.status).toBe('merged');
      expect(h.registry.workers).toEqual([]); expect(h.ledger.listPendingRebriefs({ jobId })).toEqual([]);
      expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    } finally { h.close(); }
  });

  it("historical a recovered turn that errors after terminality retires instead of escalating an obsolete request: unknown work is never replayed before terminal retirement", async () => {
    const h = makeHarness(); const jobId = 'terminal-historical-1437';
    try {
      await seedPendingRebrief({ h, jobId }); await assertHistoricalRefusal(h, jobId);
      merge(h, jobId);
      const pass = await reconcilePendingRebriefs({ ledger: h.ledger, worktrees: h.worktrees, registry: h.registry, notifications: h.notifications });
      await pass.settled; expect(pass.retired).toBe(1);
      expect(h.ledger.getJob(jobId)?.status).toBe('merged');
      expect(h.registry.workers).toEqual([]); expect(h.ledger.listPendingRebriefs({ jobId })).toEqual([]);
      expect(h.ledger.latestJobEvent(jobId, 'job.delivered')).toBeNull();
    } finally { h.close(); }
  });

  it('retires only the terminal job’s obsolete markers; an unrelated unfinished request recovers unchanged', async () => {
    const h = makeHarness();
    const terminalJob = 'terminal-neighbour-job';
    const workingJob = 'working-neighbour-job';
    await seedPendingRebrief({ h, jobId: terminalJob });
    await seedPendingRebrief({ h, jobId: workingJob });
    const unfinished = h.ledger.listPendingRebriefs({ jobId: workingJob });
    merge(h, terminalJob);
    const report = await reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 });
    expect(report.retired).toBe(1);
    expect(report.redispatched).toBe(0);
    await report.settled;

    expect(h.ledger.listPendingRebriefs({ jobId: terminalJob })).toHaveLength(0);
    expect(h.ledger.latestJobEvent(terminalJob, 'silas.rebrief')).toBeNull();
    // Genuine terminal evidence advances independently; uncertainty is
    // preserved exactly and owes its own executable generation-fenced debt.
    expect(h.registry.workers).toHaveLength(0);
    expect(h.ledger.listPendingRebriefs({ jobId: workingJob })).toEqual(unfinished);
    expect(h.ledger.listPendingRebriefs({ jobId: workingJob })).toHaveLength(2);
    expect(h.ledger.latestJobEvent(workingJob, 'silas.rebrief')).toBeNull();
    expect(h.ledger.latestJobEvent(workingJob, 'job.delivered')).toBeNull();
    const marker = unfinished.find((row) => row.kind === 'silas.rebrief')!;
    expect(h.ledger.listObligations({ jobId: workingJob }).filter((row) => row.incidentKey === `rebrief-recovery:${marker.id}`))
      .toEqual([expect.objectContaining({ state: 'open', nextAction: expect.objectContaining({ kind: 'gru-decision' }) })]);
  });

  it('retires a terminal request on a done job exactly as on a merged one', async () => {
    const h = makeHarness();
    const jobId = 'terminal-done-job';
    await seedPendingRebrief({ h, jobId });
    h.ledger.setJobStatus(jobId, 'done');
    const report = await reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 });
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
    seedCorrelatedReceipt(h, jobId, 'silas.rebrief');
    seedCorrelatedReceipt(h, jobId, 'job.delivered', 'worker-1', { sha: null });
    merge(h, jobId);
    const report = await reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 });
    expect(report.completed).toBe(1);
    expect(report.retired).toBe(0);
    await report.settled;
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired')).toBeNull();
    expect(h.ledger.listNotifications()).toHaveLength(0);
  });

  it('a spent but incomplete terminal pair is escalated, never audited as cancelled', async () => {
    const h = makeHarness();
    const jobId = 'terminal-spent-incomplete';
    await seedPendingRebrief({ h, jobId });
    const pair = h.ledger.listPendingRebriefs({ jobId });
    seedCorrelatedReceipt(h, jobId, 'silas.rebrief');
    seedCorrelatedReceipt(h, jobId, 'job.delivered');
    h.ledger.clearPendingRebriefs(pair.filter((row) => row.kind === 'job.delivered').map((row) => row.id));
    merge(h, jobId);
    const report = await reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 });
    await report.settled;
    expect(report.completed).toBe(0);
    expect(report.retired).toBe(0);
    expect(h.registry.workers).toHaveLength(0);
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(1);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired')).toBeNull();
    expect(h.ledger.listNotifications().some((row) => row.kind === `silas.rebrief-unreconciled.${jobId}` && (row.detail ?? '').includes('incomplete marker pair'))).toBe(true);
    expect(() => finalizeRebriefRequest({
      ledger: h.ledger, worktrees: h.worktrees, jobId, minionId: 'worker', lanePath: h.lanePath, note: 'n',
    })).toThrow(/incomplete marker pair/u);
  });

  it('spent marked events beyond the newest thousand stay completed at terminal boot and finalization', async () => {
    const h = makeHarness();
    for (const jobId of ['phase-spent-boot', 'phase-spent-finalize']) {
      await seedPendingRebrief({ h, jobId });
      const markers = h.ledger.beginPendingRebrief({
        jobId, note: 'marked', briefing: 'contract',
        handoff: { kind: 'gru-decision', decision: 'decide' },
      });
      seedCorrelatedReceipt(h, jobId, 'silas.rebrief', 'worker');
      seedCorrelatedReceipt(h, jobId, 'job.delivered', 'worker');
      for (let i = 0; i < 1001; i += 1) h.ledger.appendCustomEvent({ kind: 'job.note', jobId, payload: { i } });
      merge(h, jobId);
      if (jobId === 'phase-spent-boot') {
        const report = await reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 });
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
    seedCorrelatedReceipt(h, jobId, 'silas.rebrief');
    seedCorrelatedReceipt(h, jobId, 'job.delivered');
    const view = Object.create(h.ledger) as LedgerApi;
    Object.defineProperty(view, 'clearPendingRebriefsIfCurrentAndSettle', {
      value: (expected: Parameters<LedgerApi['clearPendingRebriefsIfCurrentAndSettle']>[0]) => {
        h.ledger.beginPendingRebrief({ jobId, note: 'new request', briefing: 'new contract' });
        return h.ledger.clearPendingRebriefsIfCurrentAndSettle(expected);
      },
    });
    const report = await reconcilePendingRebriefs({ ...deps(h), ledger: view }, { limit: 100 });
    await report.settled;
    expect(report.completed).toBe(0);
    expect(report.retired).toBe(0);
    expect(h.ledger.listPendingRebriefs({ jobId }).map((row) => row.note)).toEqual(['new request', 'new request']);
  });

  it("historical a parked job keeps the existing recovery path — not terminal cleanup: zero replay and concrete Gru judgment", async () => {
    const h = makeHarness(); const jobId = 'historical-1586';
    try {
      await seedPendingRebrief({ h, jobId });


      h.ledger.setJobStatus(jobId, 'parked');
      h.registry.failSpawn = new Error('must never spawn'); h.registry.failPrompt = new Error('must never prompt');
      await assertHistoricalRefusal(h, jobId);



    } finally { h.close(); }
  });

  it('a missing job never takes the delivery-only shortcut: escalation, no fabricated delivery', async () => {
    const h = makeHarness();
    const jobId = 'missing-rebrief-job';
    await seedPendingRebrief({ h, jobId });
    // The turn settled and `silas.rebrief` posted; the delivery record never
    // did — the exact shape the delivery-only crash shortcut exists for.
    seedCorrelatedReceipt(h, jobId, 'silas.rebrief');
    const report = await reconcilePendingRebriefs(
      {
        registry: h.registry,
        ledger: ledgerWith(h, { getJob: () => null }),
        worktrees: h.worktrees,
        notifications: h.notifications,
      },
      { limit: 100 },
    );
    await report.settled;
    // No delivery is minted for a job row that does not exist; the markers
    // stay and the honest re-dispatch boundary escalates instead.
    expect(report.completed).toBe(0);
    expect(report.redispatched).toBe(0);
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
      { limit: 100 },
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
    const logs: string[] = [];
    const stale: PendingRebriefRetirement = {
      retired: [],
      skippedIds: ['stale-generation'],
      refused: null,
    };
    merge(h, jobId);
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
      { limit: 100 },
    );
    expect(report.redispatched).toBe(0);
    // The job reaches terminal while the re-dispatch turn is still in flight.

    await report.settled;
    // The boundary kept the markers and said so; it did NOT claim recovery.
    expect(h.registry.workers).toHaveLength(0);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired')).toBeNull();
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-recovered')).toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(2);
    expect(logs).toContain('warn:re-brief retirement retired nothing');
  });

  it('a mid-turn partial retirement keeps its skipped ids visible at the caller surface', async () => {
    const h = makeHarness();
    const jobId = 'partial-retirement-mid-turn';
    await seedPendingRebrief({ h, jobId });
    const driftedId = h.ledger.listPendingRebriefs({ jobId })[0]!.id;
    const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
    merge(h, jobId);
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
      { limit: 100 },
    );
    expect(report.redispatched).toBe(0);
    // The job reaches terminal while the recovered turn is still in flight.

    await report.settled;
    // The turn is preserved; one marker retired with its audit; the kept
    // marker and its identity are named at this surface, not dropped.
    expect(h.registry.workers).toHaveLength(0);
    expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(1);
    expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief-retired')).not.toBeNull();
    const closed = logs.find((line) => line.msg === 're-brief request retired: job is terminal');
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
    const report = await reconcilePendingRebriefs({ registry: h.registry, ledger: h.ledger, worktrees: h.worktrees, notifications: h.notifications }, { limit: 100 });
    expect(report.examined).toBe(6);
    expect(report.retired).toBe(2);
    expect(report.completed).toBe(0);
    expect(report.redispatched).toBe(0);
    await report.settled;
    // The loop carried BOTH terminal groups: one audit per job, each with
    // its own terminal status, and no terminal lane spawned a worker.
    expect(h.registry.workers).toHaveLength(0);
    for (const [jobId, status] of [[mergedJobId, 'merged'], [doneJobId, 'done']] as const) {
      const audits = h.ledger.listJobEvents(jobId).filter((event) => event.kind === 'silas.rebrief-retired');
      expect(audits).toHaveLength(1);
      expect((audits[0]!.payload as { job_status?: string }).job_status).toBe(status);
      expect(h.ledger.listPendingRebriefs({ jobId })).toHaveLength(0);
      expect(h.ledger.latestJobEvent(jobId, 'silas.rebrief')).toBeNull();
    }
    // The working lane walked the honest recovery path.
    expect(h.ledger.latestJobEvent(workingJobId, 'silas.rebrief')).toBeNull();
    expect(h.ledger.listPendingRebriefs({ jobId: workingJobId })).toHaveLength(2);
    expect(h.ledger.listObligations({ jobId: workingJobId }).some((row) => row.category.kind === 'known' && row.category.category === 'restart-recovery')).toBe(true);
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
      { limit: 100 },
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
