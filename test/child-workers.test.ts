import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/** Append one assistant message to a parseable session transcript. */
function appendAssistant(path: string, text: string): void {
  appendFileSync(
    path,
    `${JSON.stringify({
      type: 'message',
      id: `a-${Date.now()}-${Math.random()}`,
      parentId: null,
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        api: 'demo',
        provider: 'demo',
        model: 'demo',
        stopReason: 'stop',
        timestamp: Date.now(),
      },
    })}\n`,
    'utf-8',
  );
}

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
  /** The report text the next child writes (null = a turn with no report). */
  reportText: string | null;
  setTurnGate(): () => void;
  setSpawnGate(): () => void;
  request(input?: Partial<{ authority: string; task: string; purpose: string; idempotencyKey: string; label: string }>): ReturnType<ChildWorkerService['request']>;
  close(): void;
}

function appendToolResult(path: string): void {
  appendFileSync(
    path,
    `${JSON.stringify({
      type: 'message',
      id: `t-${Date.now()}`,
      parentId: null,
      timestamp: '2026-01-01T00:00:02.000Z',
      message: { role: 'toolResult', content: 'tool output', toolName: 'bash', timestamp: Date.now() },
    })}\n`,
    'utf-8',
  );
}

function makeHarness(
  opts: {
    workerGate?: PacingGate;
    residentProbe?: () => { readonly available: number; readonly reclaimable: number };
    retrySettlement?: (agentId: string) => Promise<'none' | 'recovered' | 'exhausted' | 'superseded'>;
    /** dispose() rejects and health stays non-disposed (unproven stop). */
    failDispose?: boolean;
    /** The turn writes an interim message followed by a tool result. */
    interimOnly?: boolean;
    /** The session file path never exists (unreadable baseline). */
    unreadableSession?: boolean;
  } = {},
): Harness {
  const repo = makeFixtureRepo('fixture-child');
  cleanupRepos.push(repo);
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-child-'));
  cleanupDirs.push(dir);
  const ledgerDb = new LedgerDb(dir);
  const bus = new EventBus({});
  const ledger = new LedgerApi(ledgerDb.handle, { bus });
  const engine = new BoardEngine({
    ledger,
    bus,
    // A wired ownership probe makes absence-of-ownership authoritative: a
    // queued child must classify unverified (pending), never historical.
    runtimeOwnership: () => ({
      ownedAgentIds: new Set(handles.filter((handle) => !handle.disposed).map((handle) => handle.id)),
    }),
  });
  const worktrees = new InMemoryWorktreePort(join(dir, 'wtroot'));
  const sessionDir = join(dir, 'sessions');
  mkdirSync(sessionDir, { recursive: true });

  const spawns: Harness['spawns'] = [];
  const handles: FakeHandle[] = [];
  let n = 0;
  let turnGate: Promise<void> | null = null;
  const failDispose = opts.failDispose === true;
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
    reportText: 'child report from the fake session',
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
    ...(opts.residentProbe !== undefined ? { residentProbe: opts.residentProbe } : {}),
    ...(opts.retrySettlement !== undefined ? { retrySettlement: opts.retrySettlement } : {}),
    spawner: async (role, spawnOptions) => {
      const options = spawnOptions ?? {};
      spawns.push({ role, options });
      if (spawnGate !== null) await spawnGate;
      if (options.signal?.aborted) throw new Error('resident admission cancelled before spawn');
      // Issue #161: the product-owned identity is bound BEFORE the session.
      const id = options.agentId ?? `agent-${++n}`;
      const sessionFile = opts.unreadableSession === true
        ? join(sessionDir, `${id}-missing.jsonl`)
        : join(sessionDir, `${id}.jsonl`);
      if (opts.unreadableSession !== true) writeSession(sessionFile, []);
      const prompts: string[] = [];
      let state: AgentState = 'idle';
      const writeReport = (): void => {
        if (opts.interimOnly === true) {
          appendAssistant(sessionFile, 'interim planning note — still working');
          appendToolResult(sessionFile);
          return;
        }
        if (harness.reportText !== null) appendAssistant(sessionFile, harness.reportText);
      };
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
          writeReport();
        },
        async promptWithVerdict(text: string) {
          prompts.push(text);
          if (turnGate !== null) await turnGate;
          writeReport();
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
          // A real adapter settles the open turn on disposal; the fake
          // releases its gate so the run can observe the cancellation.
          releaseGate?.();
          if (failDispose) throw new Error('dispose rejected (unproven cessation)');
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
    // An ERRORED parent has no live authority either (it may be dead or
    // awaiting supervision; neither can own a new child honestly).
    h.ledger.registerAgent({ id: 'parent-3', role: 'minion', jobId: 'job-1', parentage: 'top-level' });
    h.ledger.setAgentState('parent-3', 'error');
    expect(
      refusalOf(() =>
        h.service.request({
          parentAgentId: 'parent-3',
          jobId: 'job-1',
          purpose: 'p',
          authority: 'read-only',
          task: 't',
          idempotencyKey: 'k-error-parent',
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
    // A binned (discarded) lane is an expired parent too.
    const discarded = makeHarness();
    discarded.ledger.setAgentState('parent-1', 'idle');
    discarded.ledger.setJobStatus('job-1', 'binned');
    expect(refusalOf(() => discarded.request({ idempotencyKey: 'k-expired-binned' })).code).toBe('parent_expired');
    discarded.close();
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

  it('sweeps the lane of a writer child cancelled before it spawned (no orphan lane)', async () => {
    const h = makeHarness();
    const release = h.setSpawnGate();
    const admission = h.request({ authority: 'writer' });
    await waitForChild(h, admission.record.id, (state) => state === 'admitted');
    const cancelling = h.service.cancel(admission.record.id, 'cancelled before spawn');
    release();
    await cancelling;
    await waitFor(
      () => h.worktrees.getWorktree(admission.record.id)?.status === 'swept',
      'the unspawned writer lane to be swept',
    );
    expect(h.ledger.getChildWorker(admission.record.id)!.state).toBe('cancelled');
    expect(h.spawns).toHaveLength(1);
    h.close();
  });

  it('refuses admission with a named budget precondition when resident capacity is exhausted and unreclaimable', () => {
    const h = makeHarness({ residentProbe: () => ({ available: 0, reclaimable: 0 }) });
    const refusalOf = (): ChildWorkerRefusal => {
      try {
        h.request();
      } catch (error) {
        if (error instanceof ChildWorkerRefusal) return error;
        throw error;
      }
      throw new Error('expected a refusal');
    };
    const refusal = refusalOf();
    expect(refusal.code).toBe('budget');
    expect(refusal.status).toBe(429);
    expect(refusal.message).toContain('max_workers');
    expect(h.ledger.listChildWorkers()).toHaveLength(0);
    h.close();
  });

  it('fences a queued child when its job expires while it waits for spawn', async () => {
    const h = makeHarness();
    const release = h.setSpawnGate();
    const admission = h.request({ authority: 'writer' });
    await waitForChild(h, admission.record.id, (state) => state === 'admitted');
    h.ledger.setJobStatus('job-1', 'done');
    release();
    await waitForChild(h, admission.record.id, (state) => state === 'error');
    const record = h.ledger.getChildWorker(admission.record.id)!;
    expect(record.resultSummary).toContain('done');
    expect(record.resultSummary).toContain('expired');
    // The never-delivered lane is swept — no orphan writer.
    await waitFor(
      () => h.worktrees.getWorktree(admission.record.id)?.status === 'swept',
      'the fenced writer lane to be swept',
    );

    // A queued child owns this lane: binning must refuse rather than hide
    // it. Once that producer has actually settled, the chief can discard.
    const discarded = makeHarness();
    const releaseDiscarded = discarded.setSpawnGate();
    const discardedAdmission = discarded.request({ authority: 'writer', idempotencyKey: 'key-binned' });
    await waitForChild(discarded, discardedAdmission.record.id, (state) => state === 'admitted');
    const beforeDiscard = discarded.ledger.listJobEvents('job-1');
    expect(() => discarded.ledger.setJobStatus('job-1', 'binned')).toThrow(/live work/u);
    expect(discarded.ledger.listJobEvents('job-1')).toEqual(beforeDiscard);
    releaseDiscarded();
    await waitForChild(discarded, discardedAdmission.record.id, (state) => state === 'done');
    discarded.ledger.setAgentState(discardedAdmission.record.id, 'disposed');
    discarded.ledger.setAgentState('parent-1', 'idle');
    discarded.ledger.setJobStatus('job-1', 'binned');
    expect(discarded.ledger.getJob('job-1')?.status).toBe('binned');
    discarded.close();
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

  it('waits for the automatic retry settlement before recording the child result', async () => {
    let settleCalls = 0;
    const h = makeHarness({
      retrySettlement: async () => {
        settleCalls += 1;
        return 'exhausted';
      },
    });
    const admission = h.request();
    await waitForChild(h, admission.record.id, (state) => state === 'error');
    expect(settleCalls).toBe(1);
    const record = h.ledger.getChildWorker(admission.record.id)!;
    expect(record.resultSummary).toContain('automatic rate-limit retry exhausted');
    h.close();
  });

  it('records a named error when a successful turn carries no collectable final report', async () => {
    const h = makeHarness();
    h.reportText = null;
    const admission = h.request();
    await waitForChild(h, admission.record.id, (state) => state === 'error');
    const record = h.ledger.getChildWorker(admission.record.id)!;
    expect(record.resultState).toBe('error');
    expect(record.resultSummary).toContain('no final report');
    expect(record.resultRef).not.toBeNull();
    h.close();
  });

  it('does not publish an interim message as the final report', async () => {
    const h = makeHarness({ interimOnly: true });
    const admission = h.request();
    await waitForChild(h, admission.record.id, (state) => state === 'error');
    const record = h.ledger.getChildWorker(admission.record.id)!;
    expect(record.resultState).toBe('error');
    expect(record.resultSummary).toContain('no final report');
    expect(record.resultSummary).not.toContain('interim planning note');
    h.close();
  });

  it('refuses to anchor a report when the transcript baseline is unreadable', async () => {
    const h = makeHarness({ unreadableSession: true });
    const admission = h.request();
    await waitForChild(h, admission.record.id, (state) => state === 'error');
    const record = h.ledger.getChildWorker(admission.record.id)!;
    expect(record.resultSummary).toContain('baseline is unreadable');
    expect(h.spawns).toHaveLength(1);
    h.close();
  });

  it('refuses supervision restart for a tracked child without faking a terminal result', async () => {
    const h = makeHarness();
    h.setTurnGate();
    const admission = h.request();
    await waitForChild(h, admission.record.id, (state) => state === 'active');
    const policy = h.service.restartPolicy(admission.record.id, 'minion');
    expect(policy).toBeDefined();
    expect(policy !== undefined && 'refuse' in policy).toBe(true);
    expect((policy as { refuse: string }).refuse).toContain('single-run');
    // The refusal is DURABLE evidence, not a terminal result: the old
    // handle may still be live, so the child's own finalizer owns
    // terminalization (proof-aware).
    expect(h.ledger.latestEventOfKind('child.restart-refused')).not.toBeNull();
    expect(h.ledger.getChildWorker(admission.record.id)!.resultState).toBeNull();
    // A non-child agent is not specialized (undefined = default restart).
    expect(h.service.restartPolicy('parent-1', 'minion')).toBeUndefined();
    await h.service.cancel(admission.record.id, 'restart-policy test cleanup');
    h.close();
  });

  it('records done but keeps the lane and durable cleanup debt when cessation is unproven', async () => {
    const h = makeHarness({ failDispose: true });
    const admission = h.request();
    await waitForChild(h, admission.record.id, (state) => state === 'done');
    // The successful turn's work outcome is truthful and recorded...
    expect(h.ledger.getChildWorker(admission.record.id)!.resultSummary).toContain('child report');
    // ...but ownership is NOT claimed clean: debt is durable and the
    // read-only lane is not released underneath a possibly-live session.
    expect(h.ledger.latestEventOfKind('child.cleanup-debt')).not.toBeNull();
    expect(h.worktrees.getWorktree(admission.record.id)?.status).not.toBe('swept');
    h.close();
  });

  it('keeps an uncancelled failed run non-terminal when cessation is unproven', async () => {
    const h = makeHarness({ failDispose: true });
    h.nextVerdict = { ok: false, error: 'model refused the task' };
    const admission = h.request();
    await waitFor(
      () => h.ledger.latestEventOfKind('child.stop-unproven') !== null,
      'the durable stop-unproven debt',
    );
    const record = h.ledger.getChildWorker(admission.record.id)!;
    expect(record.resultState).toBeNull();
    expect(record.state).not.toBe('error');
    // No lane may be released while the session's cessation is unproven.
    expect(h.worktrees.getWorktree(admission.record.id)?.status).not.toBe('swept');
    h.close();
  });

  it('records an unproven stop as non-terminal debt instead of a false terminal', async () => {
    const h = makeHarness({ failDispose: true });
    h.setTurnGate();
    const admission = h.request();
    await waitForChild(h, admission.record.id, (state) => state === 'active');
    // A cancel whose disposal cannot prove cessation must NOT terminalize.
    const afterCancel = await h.service.cancel(admission.record.id, 'owner stop with rejected dispose');
    expect(afterCancel.resultState).toBeNull();
    expect(afterCancel.state).not.toBe('cancelled');
    expect(h.ledger.latestEventOfKind('child.stop-unproven')).not.toBeNull();
    h.close();
  });

  it('serves the parent through GC-mediated tools bound to its identity', async () => {
    const h = makeHarness();
    const tools = h.service.parentTools('parent-1');
    expect(tools.map((tool) => tool.name)).toEqual([
      'request_child_worker',
      'list_child_workers',
      'cancel_child_worker',
    ]);
    const requestTool = tools.find((tool) => tool.name === 'request_child_worker')!;
    const created = JSON.parse(
      (await requestTool.execute({
        purpose: 'tool-driven admission',
        authority: 'read-only',
        task: 'audit via the tool',
        idempotency_key: 'k-tool',
      })).text,
    ) as { child_id: string; state: string };
    expect(created.state).toBe('queued');
    // The SAME call replays (idempotent) rather than admitting a second child.
    const replay = JSON.parse(
      (await requestTool.execute({
        purpose: 'tool-driven admission',
        authority: 'read-only',
        task: 'audit via the tool',
        idempotency_key: 'k-tool',
      })).text,
    ) as { child_id: string; idempotent: boolean };
    expect(replay.child_id).toBe(created.child_id);
    expect(replay.idempotent).toBe(true);
    await waitForChild(h, created.child_id, (state) => state === 'done');
    const listTool = tools.find((tool) => tool.name === 'list_child_workers')!;
    const listed = JSON.parse((await listTool.execute({})).text) as {
      children: { child_id: string; result_state: string | null; result_summary: string | null }[];
    };
    expect(listed.children).toHaveLength(1);
    expect(listed.children[0]!.result_state).toBe('done');
    expect(listed.children[0]!.result_summary).toContain('child report');
    // ANOTHER parent's tools cannot cancel this child.
    h.ledger.registerAgent({ id: 'parent-2', role: 'minion', jobId: 'job-1', parentage: 'top-level' });
    const foreignCancel = h.service
      .parentTools('parent-2')
      .find((tool) => tool.name === 'cancel_child_worker')!;
    const denied = JSON.parse((await foreignCancel.execute({ child_id: created.child_id })).text) as {
      error: string;
    };
    expect(denied.error).toBe('unknown_parent');
    // The owning parent still sees the terminal (immutable) result.
    const ownCancel = tools.find((tool) => tool.name === 'cancel_child_worker')!;
    const cancelled = JSON.parse((await ownCancel.execute({ child_id: created.child_id })).text) as {
      result_state: string;
    };
    expect(cancelled.result_state).toBe('done');
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

  it('cancel fences a live child: the record lands cancelled only after the handle proves cessation', async () => {
    const h = makeHarness();
    h.setTurnGate();
    const admission = h.request();
    await waitForChild(h, admission.record.id, (state) => state === 'active');
    const cancelled = await h.service.cancel(admission.record.id, 'owner stopped the child');
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.resultSummary).toContain('owner stopped the child');
    expect(cancelled.resultRef).not.toBeNull(); // the transcript reference survives
    expect(h.handles[0]!.disposed).toBe(true);
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
    const bound = h.ledger.admitChildWorker({
      id: 'child_bound',
      parentAgentId: 'parent-1',
      jobId: 'job-1',
      purpose: 'recovery check',
      authority: 'read-only',
      task: 'verify the bound lane',
      idempotencyKey: 'k-bound',
    });
    const parentLane = h.worktrees.listWorktrees({ jobId: 'job-1' }).find((lane) => lane.kind === 'job')!;
    const boundLane = await h.worktrees.createChildWorktree({
      repoPath: h.repo.path,
      jobId: 'job-1',
      childId: bound.record.id,
      parentPath: parentLane.path,
      authority: 'read-only',
    });
    h.ledger.markChildAdmitted(bound.record.id, { worktreeId: boundLane.id, branch: null });
    h.ledger.markChildStarted(bound.record.id, { sessionFile: join(h.sessionDir, 'bound.jsonl') });
    const outcome = h.service.reconcileOnBoot();
    expect(outcome).toEqual({ resumed: 1, failed: 1 });
    const failed = h.ledger.getChildWorker('child_bound')!;
    expect(failed.resultState).toBe('error');
    expect(failed.resultSummary).toContain('service restarted');
    // The interrupted read-only lane is swept on boot — no leaked checkout.
    await waitFor(
      () => h.worktrees.getWorktree(bound.record.id)?.status === 'swept',
      'the interrupted read-only lane to be swept',
    );
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
    // Seed through the FIXTURE's own schema: the merged build's addJob also
    // writes jobs.display_name (migration 17), which a pre-#161 fixture
    // (migrations <= 14 / <= 15) does not carry. The raw insert matches the
    // legacy columns exactly, preserving the upgrade-shape under test.
    const seededAt = new Date().toISOString();
legacy.handle
      .prepare(
        `INSERT INTO jobs (id, repo, title, status, base_branch, pr_url, note, briefing, created_at, updated_at)
         VALUES ('job-1', 'r', 'legacy', 'dispatched', NULL, NULL, NULL, 'b', ?, ?)`,
      )
      .run(seededAt, seededAt);
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

  it('migration 16 backfills unbound child rows and guarantees the agent lookup index', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-child-bind-'));
    cleanupDirs.push(dir);
    // A ledger shaped through migration 15 (the intermediate branch shape),
    // carrying an unspawned child whose agent binding was still NULL.
    const v15 = new LedgerDb(dir, { migrations: MIGRATIONS.filter((migration) => migration.id <= 15) });
    const before = new LedgerApi(v15.handle, {});
    // Seed through the FIXTURE's own schema: the merged build's addJob also
    // writes jobs.display_name (migration 17), which a pre-#161 fixture
    // (migrations <= 14 / <= 15) does not carry. The raw insert matches the
    // legacy columns exactly, preserving the upgrade-shape under test.
    const seededAt = new Date().toISOString();
v15.handle
      .prepare(
        `INSERT INTO jobs (id, repo, title, status, base_branch, pr_url, note, briefing, created_at, updated_at)
         VALUES ('job-1', 'r', 'legacy', 'dispatched', NULL, NULL, NULL, 'b', ?, ?)`,
      )
      .run(seededAt, seededAt);
    before.registerAgent({ id: 'parent-1', role: 'minion', jobId: 'job-1', parentage: 'top-level' });
    const admission = before.admitChildWorker({
      id: 'child_old',
      parentAgentId: 'parent-1',
      jobId: 'job-1',
      purpose: 'intermediate shape',
      authority: 'read-only',
      task: 't',
      idempotencyKey: 'k-old',
    });
    // Simulate the true intermediate shape: the unspawned child had NO
    // agent row and a NULL binding (the FK would reject a bare rebind).
    v15.handle.prepare('UPDATE child_workers SET agent_id = NULL WHERE id = ?').run(admission.record.id);
    v15.handle.prepare('DELETE FROM agents WHERE id = ?').run(admission.record.id);
    v15.close();
    // The shipped build applies 16: the admission agent row is
    // reconstructed (parentage child), the binding converges, and the
    // agent lookup is answerable.
    const full = new LedgerDb(dir);
    const after = new LedgerApi(full.handle, {});
    expect(after.getChildWorker('child_old')?.agentId).toBe('child_old');
    expect(after.childWorkerByAgent('child_old')?.id).toBe('child_old');
    expect(after.getAgent('child_old')?.parentage).toBe('child');
    expect(after.getAgent('child_old')?.parentAgentId).toBe('parent-1');
    full.close();
  });
});

describe('tracked child workers: board and API surfaces', () => {
  it('shows an admitted-but-unspawned child as unverified-pending (never historical)', async () => {
    const h = makeHarness();
    const release = h.setSpawnGate();
    const admission = h.request({ idempotencyKey: 'k-pending' });
    await waitForChild(h, admission.record.id, (state) => state === 'admitted');
    const snapshot = h.engine.snapshot();
    const pending = snapshot.agents.find((agent) => agent.id === admission.record.id)!;
    expect(pending.state).toBe('spawning');
    expect(pending.parentage).toBe('child');
    expect(pending.parentAgentId).toBe('parent-1');
    expect(pending.runtime).toBe('unverified');
    expect(pending.child?.state).toBe('admitted');
    expect(snapshot.children).toEqual({
      queued: 1,
      active: 0,
      finished: 0,
      lifetimeCreations: 1,
    });
    release();
    await waitForChild(h, admission.record.id, (state) => state === 'done');
    h.close();
  });

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
      pendingProducerBlockers: () => [],
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
    // The parent can obtain the durable report from the SAME API surface.
    expect((byId.json!['child'] as Record<string, unknown>)['result_summary']).toContain('child report');
    expect((byId.json!['child'] as Record<string, unknown>)['result_ref']).not.toBeNull();
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

    // Issue #161: the minion-facing path is GC-mediated — the HTTP surface
    // is the operator pairing token only, and parent sessions get the
    // in-process tools instead (asserted separately below).
    const cancel = await call(`/api/dispatch/children/${childId}/cancel`, { reason: 'operator stop' });
    expect(cancel.status).toBe(200);
    expect((cancel.json!['child'] as Record<string, unknown>)['result_state']).toBe('done'); // terminal is immutable
    await new Promise<void>((resolve) => http.close(() => resolve()));
    h.close();
  });
});
