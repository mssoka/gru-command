import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LedgerDb, MIGRATIONS } from '../src/ledger/db.js';
import { LedgerApi } from '../src/ledger/api.js';
import { EventBus } from '../src/events/bus.js';
import { BoardEngine } from '../src/board/engine.js';
import { loadConfig } from '../src/config.js';
import type { Role } from '../src/config.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import {
  CHILD_TASK_MAX_CHARS,
  ChildWorkerRefusal,
  ChildWorkerService,
  MAX_CHILDREN_PER_PARENT,
  READ_ONLY_CHILD_TOOLS,
} from '../src/dispatch/child-workers.js';
import type { DispatchService } from '../src/dispatch/service.js';
import type { WaveRunner } from '../src/dispatch/perkins.js';
import { createDispatchServer } from '../src/dispatch/server.js';
import { PacingGate } from '../src/runtime/pacing.js';
import type { AgentCapabilities, AgentHandle, AgentState, PromptOptions } from '../src/runtime/types.js';

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
const cleanupRepos: FixtureRepo[] = [];
afterEach(() => {
  while (cleanupRepos.length > 0) cleanupRepos.pop()!.cleanup();
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

/** Write a parseable session transcript with one final assistant report. */
function writeSession(path: string, assistantTexts: readonly string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session', id: 'sess-1', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp/demo' }),
    JSON.stringify({
      type: 'message',
      id: 'u1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'child task', timestamp: 1000 },
    }),
  ];
  for (const [index, text] of assistantTexts.entries()) {
    lines.push(
      JSON.stringify({
        type: 'message',
        id: `a${index}`,
        parentId: index === 0 ? 'u1' : `a${index - 1}`,
        timestamp: '2026-01-01T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text }],
          api: 'demo',
          provider: 'demo',
          model: 'demo',
          stopReason: 'stop',
          timestamp: 2000 + index,
        },
      }),
    );
  }
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf-8');
}

interface FakeHandle extends AgentHandle {
  readonly prompts: string[];
  disposed: boolean;
}

interface Harness {
  readonly repo: FixtureRepo;
  readonly dir: string;
  readonly ledger: LedgerApi;
  readonly ledgerDb: LedgerDb;
  readonly worktrees: InMemoryWorktreePort;
  readonly engine: BoardEngine;
  service: ChildWorkerService;
  readonly spawns: { role: Role; options: import('../src/runtime/types.js').SpawnOptions }[];
  readonly handles: FakeHandle[];
  readonly sessionDir: string;
  /** Released by the next spawned child's prompt settle. */
  releaseSettle: (() => void) | null;
  /** Forces the next child's terminal verdict. */
  nextVerdict: { ok: boolean; error: string | null } | null;
  setTurnGate(): () => void;
  setSpawnGate(): () => void;
  request(input?: Partial<{ authority: string; task: string; purpose: string; idempotencyKey: string; label: string }>): ReturnType<ChildWorkerService['request']>;
  close(): void;
}

function makeHarness(opts: { workerGate?: PacingGate } = {}): Harness {
  const repo = makeFixtureRepo('fixture-child');
  cleanupRepos.push(repo);
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-child-'));
  cleanupDirs.push(dir);
  const ledgerDb = new LedgerDb(dir);
  const bus = new EventBus({});
  const ledger = new LedgerApi(ledgerDb.handle, { bus });
  const engine = new BoardEngine({ ledger, bus });
  const worktrees = new InMemoryWorktreePort(join(dir, 'wtroot'));
  const sessionDir = join(dir, 'sessions');
  mkdirSync(sessionDir, { recursive: true });

  const spawns: Harness['spawns'] = [];
  const handles: FakeHandle[] = [];
  let n = 0;
  let turnGate: Promise<void> | null = null;
  let releaseGate: (() => void) | null = null;
  let spawnGate: Promise<void> | null = null;

  const harness: Harness = {
    repo,
    dir,
    ledger,
    ledgerDb,
    worktrees,
    engine,
    service: undefined as unknown as ChildWorkerService,
    spawns,
    handles,
    sessionDir,
    releaseSettle: null,
    nextVerdict: null,
    setTurnGate(): () => void {
      releaseGate = null;
      turnGate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      return () => releaseGate?.();
    },
    setSpawnGate(): () => void {
      let release: (() => void) | null = null;
      spawnGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release?.();
    },
    request(input = {}) {
      return harness.service.request({
        parentAgentId: 'parent-1',
        jobId: 'job-1',
        purpose: input.purpose ?? 'independent verification of the lane diff',
        authority: input.authority ?? 'read-only',
        task: input.task ?? 'Review the lane diff and report findings.',
        idempotencyKey: input.idempotencyKey ?? 'key-1',
        ...(input.label !== undefined ? { label: input.label } : {}),
      });
    },
    close(): void {
      ledgerDb.close();
    },
  };
  harness.service = new ChildWorkerService({
    ledger,
    worktrees,
    ...(opts.workerGate !== undefined ? { workerGate: opts.workerGate } : {}),
    spawner: async (role, options) => {
      spawns.push({ role, options: options ?? {} });
      if (spawnGate !== null) await spawnGate;
      const id = `agent-${++n}`;
      const sessionFile = join(sessionDir, `${id}.jsonl`);
      writeSession(sessionFile, [`child report from ${id}`]);
      const prompts: string[] = [];
      let state: AgentState = 'idle';
      const handle: FakeHandle = {
        role,
        id,
        sessionFile,
        capabilities: FAKE_CAPABILITIES,
        prompts,
        disposed: false,
        async prompt(text: string, _options?: PromptOptions) {
          prompts.push(text);
          if (turnGate !== null) await turnGate;
        },
        async promptWithVerdict(text: string) {
          prompts.push(text);
          if (turnGate !== null) await turnGate;
          if (harness.nextVerdict !== null) {
            const verdict = harness.nextVerdict;
            harness.nextVerdict = null;
            return verdict;
          }
          return { ok: true, error: null };
        },
        async steer() {},
        async followUp() {},
        subscribe() {
          return () => {};
        },
        health() {
          return { state, lastActivity: new Date().toISOString(), sessionFile };
        },
        async dispose() {
          state = 'disposed';
          handle.disposed = true;
        },
      };
      handles.push(handle);
      engine.onRuntimeEvent({ agentId: id, role, sessionFile, phase: 'spawned' });
      return handle;
    },
    log: () => {},
  });
  // Seed the parent lane + parent minion row (admission requires both).
  ledger.addJob({ id: 'job-1', repo: basename(repo.path), title: 'child fixture', briefing: 'b' });
  ledger.setJobStatus('job-1', 'working');
  ledger.registerAgent({ id: 'parent-1', role: 'minion', jobId: 'job-1', parentage: 'top-level' });
  void worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'job-1' });
  return harness;
}

/** Poll the durable record until it reaches a terminal state. */
async function waitForChild(
  h: Harness,
  childId: string,
  match: (state: string) => boolean,
  deadlineMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const record = h.ledger.getChildWorker(childId);
    if (record !== null && match(record.state)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const record = h.ledger.getChildWorker(childId);
  throw new Error(`child ${childId} did not reach the expected state (now: ${record?.state ?? 'missing'})`);
}

async function waitFor(
  predicate: () => boolean,
  what: string,
  deadlineMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('tracked child workers: admission (issue #161)', () => {
  it('admits one logical child and replays the same idempotency key without a second worker', async () => {
    const h = makeHarness();
    const first = h.request();
    const replay = h.request();
    expect(first.idempotent).toBe(false);
    expect(replay.idempotent).toBe(true);
    expect(replay.record.id).toBe(first.record.id);
    expect(h.ledger.listChildWorkers({ parentAgentId: 'parent-1' })).toHaveLength(1);
    await waitForChild(h, first.record.id, (state) => state === 'done');
    expect(h.spawns).toHaveLength(1);
    expect(h.ledger.countChildWorkers()).toEqual({
      queued: 0,
      active: 0,
      finished: 1,
      lifetimeCreations: 1,
    });
    h.close();
  });

  it('conflicts when the same key arrives with a different payload, never replacing the admitted child', async () => {
    const h = makeHarness();
    const first = h.request();
    expect(() => h.request({ task: 'a different task' })).toThrowError(/immutable/);
    expect(h.ledger.listChildWorkers({ parentAgentId: 'parent-1' })[0]!.id).toBe(first.record.id);
    await waitForChild(h, first.record.id, (state) => state === 'done');
    expect(h.spawns).toHaveLength(1);
    h.close();
  });

  it('names unknown, non-minion and nested parents as refusal preconditions', async () => {
    const h = makeHarness();
    const refusalOf = (fn: () => unknown): ChildWorkerRefusal => {
      try {
        fn();
      } catch (error) {
        if (error instanceof ChildWorkerRefusal) return error;
        throw error;
      }
      throw new Error('expected a refusal');
    };
    expect(
      refusalOf(() =>
        h.service.request({
          parentAgentId: 'ghost',
          jobId: 'job-1',
          purpose: 'p',
          authority: 'read-only',
          task: 't',
          idempotencyKey: 'k-ghost',
        }),
      ).code,
    ).toBe('unknown_parent');
    h.ledger.registerAgent({ id: 'gru-1', role: 'gru', parentage: 'top-level' });
    expect(
      refusalOf(() =>
        h.service.request({
          parentAgentId: 'gru-1',
          jobId: 'job-1',
          purpose: 'p',
          authority: 'read-only',
          task: 't',
          idempotencyKey: 'k-gru',
        }),
      ).code,
    ).toBe('parent_not_permitted');
    h.ledger.registerAgent({ id: 'child-agent-1', role: 'minion', jobId: 'job-1', parentAgentId: 'parent-1' });
    expect(
      refusalOf(() =>
        h.service.request({
          parentAgentId: 'child-agent-1',
          jobId: 'job-1',
          purpose: 'p',
          authority: 'read-only',
          task: 't',
          idempotencyKey: 'k-nested',
        }),
      ).code,
    ).toBe('nested_delegation');
    h.close();
  });

  it('refuses expired jobs, disposed parents, invalid shapes, and unbounded fanout', async () => {
    const h = makeHarness();
    const refusalOf = (fn: () => unknown): ChildWorkerRefusal => {
      try {
        fn();
      } catch (error) {
        if (error instanceof ChildWorkerRefusal) return error;
        throw error;
      }
      throw new Error('expected a refusal');
    };
    // Invalid authority and oversized task are named invalid_request refusals.
    expect(refusalOf(() => h.request({ authority: 'admin' })).code).toBe('invalid_request');
    expect(refusalOf(() => h.request({ task: 'x'.repeat(CHILD_TASK_MAX_CHARS + 1) })).code).toBe(
      'invalid_request',
    );
    // A disposed session cannot commission workers (second parent keeps
    // job-1 usable for the fanout check below).
    h.ledger.registerAgent({ id: 'parent-2', role: 'minion', jobId: 'job-1', parentage: 'top-level' });
    h.ledger.setAgentState('parent-2', 'disposed');
    expect(
      refusalOf(() =>
        h.service.request({
          parentAgentId: 'parent-2',
          jobId: 'job-1',
          purpose: 'p',
          authority: 'read-only',
          task: 't',
          idempotencyKey: 'k-disposed',
        }),
      ).code,
    ).toBe('parent_expired');
    // Bounded fanout: the cap names itself, and children never spawn children.
    for (let index = 0; index < MAX_CHILDREN_PER_PARENT; index += 1) {
      h.request({ idempotencyKey: `k-cap-${index}` });
    }
    expect(refusalOf(() => h.request({ idempotencyKey: 'k-cap-over' })).code).toBe('fanout_cap');
    expect(h.ledger.listChildWorkers({ parentAgentId: 'parent-1' })).toHaveLength(
      MAX_CHILDREN_PER_PARENT,
    );
    await waitFor(
      () => h.ledger.countChildWorkers().finished === MAX_CHILDREN_PER_PARENT,
      'all capped children to finish',
    );
    // A terminal lane is an expired parent (checked before the fanout cap).
    h.ledger.setJobStatus('job-1', 'done');
    expect(refusalOf(() => h.request({ idempotencyKey: 'k-expired' })).code).toBe('parent_expired');
    h.close();
  });

  it('stays honestly queued/in-flight while the run is unsettled, then records done', async () => {
    const h = makeHarness();
    const release = h.setTurnGate();
    const admission = h.request();
    await waitForChild(h, admission.record.id, (state) => state === 'active');
    expect(h.ledger.countChildWorkers()).toEqual({
      queued: 0,
      active: 1,
      finished: 0,
      lifetimeCreations: 1,
    });
    release();
    await waitForChild(h, admission.record.id, (state) => state === 'done');
    const record = h.ledger.getChildWorker(admission.record.id)!;
    expect(record.resultState).toBe('done');
    expect(record.resultSummary).toContain('child report');
    expect(record.resultRef).not.toBeNull();
    expect(h.handles[0]!.disposed).toBe(true); // a bounded worker releases the budget
    h.close();
  });

  it('counts a child waiting for resident admission as queued, not active', async () => {
    const h = makeHarness();
    const release = h.setSpawnGate();
    const admission = h.request();
    await waitForChild(h, admission.record.id, (state) => state === 'admitted');
    expect(h.ledger.countChildWorkers()).toEqual({
      queued: 1,
      active: 0,
      finished: 0,
      lifetimeCreations: 1,
    });
    release();
    await waitForChild(h, admission.record.id, (state) => state === 'done');
    expect(h.ledger.countChildWorkers()).toEqual({
      queued: 0,
      active: 0,
      finished: 1,
      lifetimeCreations: 1,
    });
    h.close();
  });

  it('consumes the shared worker gate and releases it on settle', async () => {
    const release = vi.fn();
    const acquireWorkerTurn = vi.fn(async (_input: { id: string; jobId?: string | null }) => ({
      release,
      waitedMs: 0,
    }));
    const h = makeHarness({ workerGate: { acquireWorkerTurn } as unknown as PacingGate });
    const admission = h.request();
    await waitForChild(h, admission.record.id, (state) => state === 'done');
    expect(acquireWorkerTurn).toHaveBeenCalledTimes(1);
    expect(acquireWorkerTurn.mock.calls[0]![0]).toMatchObject({
      id: admission.record.id,
      jobId: 'job-1',
    });
    expect(release).toHaveBeenCalledTimes(1);
    h.close();
  });
});

describe('tracked child workers: lifecycle, results and recovery', () => {
  it('runs a read-only child with the read-only tool set and a detached lane', async () => {
    const h = makeHarness();
    const admission = h.request();
    await waitForChild(h, admission.record.id, (state) => state === 'done');
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]!.role).toBe('minion');
    expect(h.spawns[0]!.options.roleTools).toEqual(READ_ONLY_CHILD_TOOLS);
    const lane = h.worktrees.getWorktree(admission.record.id)!;
    expect(lane.kind).toBe('child');
    expect(lane.branch).toBeNull();
    // Read-only lanes carry no deliverables: the run sweeps them after
    // settle (the result is the durable artifact).
    expect(lane.status).toBe('swept');
    const agent = h.ledger.getAgent(h.handles[0]!.id)!;
    expect(agent.parentage).toBe('child');
    expect(agent.parentAgentId).toBe('parent-1');
    h.close();
  });

  it('gives a writer child its own branch and the full minion tool set', async () => {
    const h = makeHarness();
    const admission = h.request({ authority: 'writer' });
    await waitForChild(h, admission.record.id, (state) => state === 'done');
    expect(h.spawns[0]!.options.roleTools).toBeUndefined();
    const lane = h.worktrees.getWorktree(admission.record.id)!;
    expect(lane.kind).toBe('child');
    expect(lane.branch).toBe(`gru/job-1-child-${admission.record.id}`);
    // Writer lanes keep their branch deliverables: no auto-sweep.
    expect(lane.status).toBe('active');
    h.close();
  });

  it('records an error result when the turn has no positive completion evidence', async () => {
    const h = makeHarness();
    h.nextVerdict = { ok: false, error: 'model refused the task' };
    const admission = h.request();
    await waitForChild(h, admission.record.id, (state) => state === 'error');
    const record = h.ledger.getChildWorker(admission.record.id)!;
    expect(record.resultState).toBe('error');
    expect(record.resultSummary).toContain('model refused the task');
    expect(record.finishedAt).not.toBeNull();
    h.close();
  });

  it('cancel fences a live child: the record lands cancelled and the handle is disposed', async () => {
    const h = makeHarness();
    const release = h.setTurnGate();
    const admission = h.request();
    await waitForChild(h, admission.record.id, (state) => state === 'active');
    const cancelled = h.service.cancel(admission.record.id, 'owner stopped the child');
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.resultSummary).toContain('owner stopped the child');
    await waitFor(() => h.handles[0]!.disposed, 'the cancelled handle to be disposed');
    release();
    // The run's own settle is idempotent over the terminal record.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.ledger.getChildWorker(admission.record.id)!.state).toBe('cancelled');
    h.close();
  });

  it('boot reconciliation re-runs an unbound child and fails a session-bound one honestly', async () => {
    const h = makeHarness();
    // A queued child that crashed before any session bound: re-run.
    const unbound = h.ledger.admitChildWorker({
      id: 'child_unbound',
      parentAgentId: 'parent-1',
      jobId: 'job-1',
      purpose: 'recovery check',
      authority: 'read-only',
      task: 'verify the recovered lane',
      idempotencyKey: 'k-unbound',
    });
    // A child with a bound session when the service died: honest error.
    h.ledger.registerAgent({ id: 'bound-agent', role: 'minion', jobId: 'job-1', parentAgentId: 'parent-1' });
    const bound = h.ledger.admitChildWorker({
      id: 'child_bound',
      parentAgentId: 'parent-1',
      jobId: 'job-1',
      purpose: 'recovery check',
      authority: 'read-only',
      task: 'verify the bound lane',
      idempotencyKey: 'k-bound',
    });
    h.ledger.bindChildAgent(bound.record.id, 'bound-agent');
    const outcome = h.service.reconcileOnBoot();
    expect(outcome).toEqual({ resumed: 1, failed: 1 });
    const failed = h.ledger.getChildWorker('child_bound')!;
    expect(failed.resultState).toBe('error');
    expect(failed.resultSummary).toContain('service restarted');
    await waitForChild(h, unbound.record.id, (state) => state === 'done');
    h.close();
  });

  it('counters survive restart and idempotent retries never double-count', async () => {
    const h = makeHarness();
    const admission = h.request();
    h.request({ idempotencyKey: 'key-1' }); // replay of the same logical child
    await waitForChild(h, admission.record.id, (state) => state === 'done');
    const before = h.ledger.countChildWorkers();
    // A real restart: close the ledger file and reopen it under a fresh
    // LedgerApi — the counters are SQL aggregates over durable rows.
    h.ledgerDb.close();
    const reopened = new LedgerDb(h.dir);
    const ledger2 = new LedgerApi(reopened.handle, {});
    expect(ledger2.countChildWorkers()).toEqual(before);
    expect(ledger2.countChildWorkers().lifetimeCreations).toBe(1);
    expect(ledger2.getChildWorker(admission.record.id)!.resultState).toBe('done');
    reopened.close();
  });
});

describe('tracked child workers: migration and storage', () => {
  it('upgrades a pre-child-workers ledger in place with live worktree rows intact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-child-upgrade-'));
    cleanupDirs.push(dir);
    // A database shaped by migrations 1-14 (the pre-#161 schema), with a
    // registered lane AND its process evidence (the FK child table the
    // worktrees rebuild must keep satisfying at commit).
    const legacy = new LedgerDb(dir, { migrations: MIGRATIONS.filter((migration) => migration.id <= 14) });
    const before = new LedgerApi(legacy.handle, {});
    before.addJob({ id: 'job-1', repo: 'r', title: 'legacy', briefing: 'b' });
    before.registerWorktree({
      id: 'job-1',
      kind: 'job',
      repoPath: '/tmp/r',
      repoName: 'r',
      path: '/tmp/r/wt',
      sha: 'abc',
      jobId: 'job-1',
    });
    before.recordWorktreeProcesses({
      worktreeId: 'job-1',
      processes: [{ pid: 123, command: 'sleep 1', evidence: 'argv' }],
      state: 'live',
    });
    legacy.close();
    // The shipped build runs every migration: the worktrees table is
    // rebuilt for kind 'child' and the FK evidence survives.
    const upgraded = new LedgerDb(dir);
    const after = new LedgerApi(upgraded.handle, {});
    expect(after.getWorktree('job-1')?.kind).toBe('job');
    expect(after.listWorktreeProcesses('job-1')).toHaveLength(1);
    after.registerWorktree({
      id: 'child-x',
      kind: 'child',
      repoPath: '/tmp/r',
      repoName: 'r',
      path: '/tmp/r/child-x',
      sha: 'abc',
      jobId: 'job-1',
    });
    expect(after.getWorktree('child-x')?.kind).toBe('child');
    // Legacy agents stay honestly unknown (never reparented by the upgrade).
    after.registerAgent({ id: 'legacy-minion', role: 'minion', jobId: 'job-1' });
    expect(after.getAgent('legacy-minion')?.parentage).toBeNull();
    upgraded.close();
  });
});

describe('tracked child workers: board and API surfaces', () => {
  it('the board distinguishes parentage, exposes parent navigation and family counters', async () => {
    const h = makeHarness();
    const admission = h.request();
    await waitForChild(h, admission.record.id, (state) => state === 'done');
    const snapshot = h.engine.snapshot();
    const parent = snapshot.agents.find((agent) => agent.id === 'parent-1')!;
    expect(parent.parentage).toBe('top-level');
    expect(parent.childCounts).toEqual({
      queued: 0,
      active: 0,
      finished: 1,
      lifetimeCreations: 1,
    });
    const childAgent = snapshot.agents.find((agent) => agent.id === h.handles[0]!.id)!;
    expect(childAgent.parentage).toBe('child');
    expect(childAgent.parentAgentId).toBe('parent-1');
    expect(childAgent.child).not.toBeNull();
    expect(childAgent.child!.state).toBe('done');
    expect(childAgent.child!.resultSummary).toContain('child report');
    expect(snapshot.children).toEqual({
      queued: 0,
      active: 0,
      finished: 1,
      lifetimeCreations: 1,
    });
    // A legacy row (registered with no parentage declaration) stays unknown.
    h.ledger.registerAgent({ id: 'legacy-agent', role: 'minion', jobId: 'job-1' });
    const legacy = h.engine.snapshot().agents.find((agent) => agent.id === 'legacy-agent')!;
    expect(legacy.parentage).toBeNull();
    h.close();
  });

  it('POST /api/dispatch/child is authenticated, idempotent and names refusals', async () => {
    const h = makeHarness();
    writeFileSync(
      join(h.dir, 'config.toml'),
      '[auth]\ntoken = "child-token"\n[server]\nhost = "127.0.0.1"\nport = 0\n',
      'utf-8',
    );
    const config = loadConfig({ GRU_COMMAND_HOME: h.dir }, '/home/tester');
    const server = createDispatchServer({
      config,
      dispatch: {} as DispatchService,
      wave: {} as WaveRunner,
      ledger: h.ledger,
      childWorkers: h.service,
    });
    const http = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (!server.requestHook(req, res, path)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const port = (http.address() as AddressInfo).port;
    const call = async (path: string, body?: unknown, token = 'child-token') => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
    };
    const body = {
      parent_agent_id: 'parent-1',
      job_id: 'job-1',
      purpose: 'HTTP admission',
      authority: 'read-only',
      task: 'audit the recorded evidence',
      idempotency_key: 'k-http',
    };
    expect((await call('/api/dispatch/child', body, 'wrong-token')).status).toBe(401);
    const first = await call('/api/dispatch/child', body);
    expect(first.status).toBe(202);
    const replay = await call('/api/dispatch/child', body);
    expect(replay.status).toBe(200);
    expect((replay.json!['child'] as Record<string, unknown>)['id']).toBe(
      (first.json!['child'] as Record<string, unknown>)['id'],
    );
    const childId = (first.json!['child'] as Record<string, unknown>)['id'] as string;
    await waitForChild(h, childId, (state) => state === 'done');
    const byId = await call(`/api/dispatch/children/${childId}`);
    expect(byId.status).toBe(200);
    expect((byId.json!['child'] as Record<string, unknown>)['result_state']).toBe('done');
    const byJob = await call('/api/dispatch/jobs/job-1/children');
    expect((byJob.json!['children'] as unknown[]).length).toBe(1);
    const byParent = await call('/api/dispatch/agents/parent-1/children');
    expect((byParent.json!['children'] as unknown[]).length).toBe(1);
    const unknown = await call('/api/dispatch/child', { ...body, parent_agent_id: 'ghost', idempotency_key: 'k-http-2' });
    expect(unknown.status).toBe(404);
    expect(unknown.json!['error']).toBe('unknown_parent');
    const malformed = await call('/api/dispatch/child', {});
    expect(malformed.status).toBe(400);
    expect(malformed.json!['error']).toBe('invalid_request');
    const cancel = await call(`/api/dispatch/children/${childId}/cancel`, { reason: 'operator stop' });
    expect(cancel.status).toBe(200);
    expect((cancel.json!['child'] as Record<string, unknown>)['result_state']).toBe('done'); // terminal is immutable
    await new Promise<void>((resolve) => http.close(() => resolve()));
    h.close();
  });
});
