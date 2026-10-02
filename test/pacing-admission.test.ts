import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { DispatchService } from '../src/dispatch/service.js';
import { routeFixDirectiveToMinion, rebriefFreshMinion } from '../src/dispatch/fix-directive.js';
import { PR_CREATION_RULE } from '../src/dispatch/pr-creation.js';
import { WorkerDisposalInProgressError } from '../src/runtime/worker-errors.js';
import { PacingGate } from '../src/runtime/pacing.js';
import { BoardEngine } from '../src/board/engine.js';
import type { AgentHandle } from '../src/runtime/types.js';
import type { WorktreeLane, WorktreePort } from '../src/dispatch/worktree-port.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * Provider pacing admission, end to end through the dispatch and directive
 * seams (owner heist 2026-09-29; r4 blocker 1): at max_concurrent_minions a
 * new minion turn QUEUES FIFO instead of spawning, the lane renders queued
 * on the record, and a release admits the head waiter. Unlimited default is
 * byte-for-byte the old behavior (covered by the untouched dispatch suites).
 */

const repos: FixtureRepo[] = [];
const dirs: string[] = [];
afterEach(() => {
  while (repos.length > 0) repos.pop()!.cleanup();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

interface FakeMinion {
  readonly handle: AgentHandle;
  readonly calls: { text: string; owner: string | null }[];
  settle: () => void;
  fail: (error: unknown) => void;
}

function makeFakeMinion(id: string): FakeMinion {
  const calls: { text: string; owner: string | null }[] = [];
  let pending: { resolve: () => void; reject: (error: unknown) => void } | null = null;
  const handle = {
    id,
    role: 'minion' as const,
    sessionFile: `/tmp/${id}.jsonl`,
    prompt: (text: string, options?: { owner?: string }) => {
      calls.push({ text, owner: options?.owner ?? null });
      return new Promise<void>((resolve, reject) => {
        pending = { resolve, reject };
      });
    },
  } as unknown as AgentHandle;
  return {
    handle,
    calls,
    settle: () => {
      const current = pending;
      pending = null;
      current?.resolve();
    },
    fail: (error: unknown) => {
      const current = pending;
      pending = null;
      current?.reject(error);
    },
  };
}

function ledgerIn(): { api: LedgerApi; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gru-pacing-admission-ledger-'));
  dirs.push(dir);
  const db = new LedgerDb(dir);
  const api = new LedgerApi(db.handle, { bus: new EventBus() });
  return { api, close: () => db.close() };
}

describe('worker admission through dispatch (FIFO queue, honest queue note, release)', () => {
  it('queues the second dispatch at the cap, notes the lane, and admits it on the first turn’s settle', async () => {
    const repo = makeFixtureRepo('pacing-admission-dispatch');
    repos.push(repo);
    const laneRoot = mkdtempSync(join(tmpdir(), 'gru-pacing-admission-lanes-'));
    dirs.push(laneRoot);
    const { api, close } = ledgerIn();
    try {
      const worktrees = new InMemoryWorktreePort(laneRoot);
      const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
      const events: string[] = [];
      const recordingGate = new PacingGate({
        enabled: true,
        maxConcurrentMinions: 1,
        maxConcurrentReviewTurns: 0,
        record: (event) => events.push(event.kind),
      });
      const spawned: FakeMinion[] = [];
      const service = new DispatchService({
        ledger: api,
        worktrees,
        spawner: async () => {
          const minion = makeFakeMinion(`minion-${spawned.length + 1}`);
          spawned.push(minion);
          return minion.handle;
        },
        workerGate: recordingGate,
      });

      const a = await service.dispatch({
        jobId: 'job-a',
        repoPath: repo.path,
        title: 'Job A',
        briefing: 'brief A',
      });
      expect(spawned).toHaveLength(1);
      expect(a.agentId).toBe('minion-1');
      expect(recordingGate.view().worker.running).toBe(1);

      const bPromise = service.dispatch({
        jobId: 'job-b',
        repoPath: repo.path,
        title: 'Job B',
        briefing: 'brief B',
      });
      await flush();
      // B queued: no spawn, no prompt, and the lane note names the honest reason.
      expect(spawned).toHaveLength(1);
      expect(recordingGate.view().worker.queued.map((entry) => entry.id)).toEqual(['job-b']);
      expect(api.getJob('job-b')?.note ?? '').toContain(
        'queued: 1/1 minion turns running (pacing.max_concurrent_minions)',
      );

      spawned[0]!.settle();
      const b = await bPromise;
      expect(b.agentId).toBe('minion-2');
      expect(spawned).toHaveLength(2);
      expect(spawned[1]!.calls.map((call) => call.text).join('\n')).toContain('brief B');
      // The admission rewrite replaces the queue note: a running lane never
      // keeps claiming it is still queued.
      expect(api.getJob('job-b')?.note ?? '').toContain('pacing: admitted after');
      expect(api.getJob('job-b')?.note ?? '').not.toContain('queued:');
      expect(recordingGate.view().worker.queued).toHaveLength(0);
      expect(recordingGate.view().worker.running).toBe(1);
      // Capped immediate admits are recorded too (waiter A), then B's wait.
      expect(events).toEqual(['pacing.admitted', 'pacing.queued', 'pacing.admitted']);

      spawned[1]!.settle();
      await vi.waitFor(() => expect(recordingGate.view().worker.running).toBe(0));
      // The plain gate was never used; construct-clean check only.
      expect(gate.view().worker.running).toBe(0);
    } finally {
      close();
    }
  });
});

describe('worker admission through directive deliveries', () => {
  const lane: WorktreeLane = {
    id: 'job-1',
    kind: 'job',
    repoPath: '/tmp/lane',
    repoName: 'fixture',
    path: '/tmp/lane',
    branch: 'gru/job-1',
    sha: 'sha',
    jobId: 'job-1',
    roundId: null,
    status: 'active',
  };

  it('holds a live-minion directive until a slot frees, then delivers', async () => {
    const events: string[] = [];
    const gate = new PacingGate({
      enabled: true,
      maxConcurrentMinions: 1,
      maxConcurrentReviewTurns: 0,
      record: (event) => events.push(event.kind),
    });
    const delivered: string[] = [];
    const handle = {
      id: 'minion-1',
      prompt: async (text: string) => {
        delivered.push(text);
      },
    } as unknown as AgentHandle;
    const holder = await gate.acquireWorkerTurn({ id: 'holder', label: 'Holder' });

    const routing = routeFixDirectiveToMinion({
      registry: {
        getHandle: () => handle,
        spawn: async () => handle,
        disposeHandle: async () => {},
      },
      ledger: {
        listAgents: () => [
          { id: 'minion-1', jobId: 'job-1', role: 'minion' } as unknown as ReturnType<LedgerApi['listAgents']>[number],
        ],
        registerAgent: (() => undefined) as unknown as LedgerApi['registerAgent'],
        getJob: (() => null) as unknown as LedgerApi['getJob'],
      },
      worktrees: { listWorktrees: () => [lane] } as unknown as WorktreePort,
      jobId: 'job-1',
      directive: 'fix the lane',
      signal: new AbortController().signal,
      workerGate: gate,
    });
    await flush();
    expect(delivered).toHaveLength(0);
    expect(gate.view().worker.queued.map((entry) => entry.id)).toEqual(['job-1']);
    holder.release();
    await expect(routing).resolves.toMatchObject({ delivered: true, minionId: 'minion-1' });
    expect(delivered).toEqual([`fix the lane\n\n${PR_CREATION_RULE}`]);
    expect(events).toEqual(['pacing.admitted', 'pacing.queued', 'pacing.admitted']);
    expect(gate.view().worker.running).toBe(0);
    expect(gate.view().worker.queued).toHaveLength(0);
  });

  it('waits out a pending retry incident before prompting the live minion (r4 edge#1 attribution)', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const delivered: string[] = [];
    const handle = {
      id: 'minion-1',
      prompt: async (text: string) => { delivered.push(text); },
    } as unknown as AgentHandle;
    let settleNow!: (value: 'recovered') => void;
    let settleCalls = 0;
    const routing = routeFixDirectiveToMinion({
      registry: {
        getHandle: () => handle,
        spawn: async () => handle,
        disposeHandle: async () => {},
      },
      ledger: {
        listAgents: () => [
          { id: 'minion-1', jobId: 'job-1', role: 'minion' } as unknown as ReturnType<LedgerApi['listAgents']>[number],
        ],
        registerAgent: (() => undefined) as unknown as LedgerApi['registerAgent'],
        getJob: (() => null) as unknown as LedgerApi['getJob'],
      },
      worktrees: { listWorktrees: () => [lane] } as unknown as WorktreePort,
      jobId: 'job-1',
      directive: 'fix the lane',
      signal: new AbortController().signal,
      workerGate: gate,
      retrySettlement: () => {
        settleCalls += 1;
        if (settleCalls === 1) return new Promise((resolve) => { settleNow = resolve; });
        return Promise.resolve('none');
      },
    });
    await flush();
    // The pending incident is awaited BEFORE the prompt and BEFORE a slot is
    // taken: the other turn's retry still owns the handle and must not race
    // this delivery (nor be blocked by this delivery's slot).
    expect(delivered).toHaveLength(0);
    expect(gate.view().worker.running).toBe(0);
    settleNow('recovered');
    await expect(routing).resolves.toMatchObject({ delivered: true, minionId: 'minion-1' });
    expect(delivered).toEqual([`fix the lane\n\n${PR_CREATION_RULE}`]);
    expect(settleCalls).toBe(2); // pre-prompt interlock + post-prompt settlement
    expect(gate.view().worker.running).toBe(0);
  });

  it('a disposal rejection consults the retry settlement first: recovered means the directive already landed (r4 adversarial#0)', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const spawns: string[] = [];
    const handle = {
      id: 'minion-1',
      sessionFile: '/tmp/minion-1.jsonl',
      prompt: async () => { throw new WorkerDisposalInProgressError(); },
    } as unknown as AgentHandle;
    const routing = routeFixDirectiveToMinion({
      registry: {
        getHandle: () => handle,
        spawn: async () => { spawns.push('fresh'); return handle; },
        disposeHandle: async () => {},
      },
      ledger: {
        listAgents: () => [
          { id: 'minion-1', jobId: 'job-1', role: 'minion', sessionFile: '/tmp/minion-1.jsonl' } as unknown as ReturnType<LedgerApi['listAgents']>[number],
        ],
        registerAgent: (() => undefined) as unknown as LedgerApi['registerAgent'],
        getJob: (() => null) as unknown as LedgerApi['getJob'],
      },
      worktrees: { listWorktrees: () => [lane] } as unknown as WorktreePort,
      jobId: 'job-1',
      directive: 'fix the lane',
      signal: new AbortController().signal,
      workerGate: gate,
      retrySettlement: async () => 'recovered',
    });
    // The retry covering the evicted handle delivered the directive: no
    // resume/fresh spawn may run (two writers on one session).
    await expect(routing).resolves.toMatchObject({ delivered: true, minionId: 'minion-1' });
    expect(spawns).toEqual([]);
  });

  it('a disposal rejection with an exhausted retry resumes the evicted session instead of overlapping it (r4 adversarial#0)', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const spawned: Array<{ id: string; resumeFile?: string }> = [];
    const delivered: string[] = [];
    const live = {
      id: 'minion-1',
      sessionFile: '/tmp/minion-1.jsonl',
      prompt: async () => { throw new WorkerDisposalInProgressError(); },
    } as unknown as AgentHandle;
    const fresh = {
      id: 'minion-2',
      sessionFile: '/tmp/minion-2.jsonl',
      prompt: async (text: string) => { delivered.push(text); },
      dispose: async () => {},
    } as unknown as AgentHandle;
    let settleCalls = 0;
    const routing = routeFixDirectiveToMinion({
      registry: {
        getHandle: () => live,
        spawn: async (_role, options) => {
          spawned.push({ id: 'minion-2', ...(options?.resumeFile !== undefined ? { resumeFile: options.resumeFile } : {}) });
          return fresh;
        },
        disposeHandle: async () => {},
      },
      ledger: {
        listAgents: () => [
          { id: 'minion-1', jobId: 'job-1', role: 'minion', sessionFile: '/tmp/minion-1.jsonl' } as unknown as ReturnType<LedgerApi['listAgents']>[number],
        ],
        registerAgent: (() => undefined) as unknown as LedgerApi['registerAgent'],
        getJob: (() => null) as unknown as LedgerApi['getJob'],
      },
      worktrees: { listWorktrees: () => [lane] } as unknown as WorktreePort,
      jobId: 'job-1',
      directive: 'fix the lane',
      signal: new AbortController().signal,
      workerGate: gate,
      retrySettlement: async () => {
        settleCalls += 1;
        return settleCalls === 1 ? 'exhausted' : 'none';
      },
    });
    await expect(routing).resolves.toMatchObject({ delivered: true, minionId: 'minion-2' });
    // The evicted logical session is resumed — never a second writer on it.
    expect(spawned).toEqual([{ id: 'minion-2', resumeFile: '/tmp/minion-1.jsonl' }]);
    expect(delivered).toEqual([`fix the lane\n\n${PR_CREATION_RULE}`]);
  });

  it('gates the fresh-minion fallback too: the spawn itself waits for a slot', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
    const holder = await gate.acquireWorkerTurn({ id: 'holder', label: 'Holder' });
    const spawned: string[] = [];
    const delivered: string[] = [];
    const controller = new AbortController();
    const routing = routeFixDirectiveToMinion({
      registry: {
        getHandle: () => null, // no live minion: the fresh-spawn path
        spawn: async () => {
          spawned.push('minion-fresh');
          return {
            id: 'minion-fresh',
            prompt: async (text: string) => {
              delivered.push(text);
            },
            dispose: async () => {},
          } as unknown as AgentHandle;
        },
        disposeHandle: async () => {},
      },
      ledger: {
        listAgents: () => [],
        registerAgent: (() => undefined) as unknown as LedgerApi['registerAgent'],
        getJob: (() => null) as unknown as LedgerApi['getJob'],
      },
      worktrees: { listWorktrees: () => [lane] } as unknown as WorktreePort,
      jobId: 'job-1',
      directive: 'fix the lane',
      signal: controller.signal,
      workerGate: gate,
    });
    await flush();
    expect(spawned).toHaveLength(0); // the spawn queues with the turn
    expect(gate.view().worker.queued).toHaveLength(1);

    // Cancelling a QUEUED wait drops it without touching the holder.
    controller.abort();
    await expect(routing).rejects.toThrow(/aborted/);
    expect(gate.view().worker.queued).toHaveLength(0);
    expect(gate.view().worker.running).toBe(1);
    holder.release();
    expect(gate.view().worker.running).toBe(0);
  });
});


describe('pacing plumbing and failure cleanup', () => {
  it('a post-spawn bookkeeping throw releases the worker slot', async () => {
    const repo = makeFixtureRepo('pacing-register-error'); repos.push(repo);
    const root = mkdtempSync(join(tmpdir(), 'pacing-register-error-')); dirs.push(root);
    const { api, close } = ledgerIn();
    try {
      const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
      vi.spyOn(api, 'registerAgent').mockImplementationOnce(() => { throw new Error('register unavailable'); });
      const service = new DispatchService({ ledger: api, worktrees: new InMemoryWorktreePort(root), workerGate: gate,
        spawner: async () => makeFakeMinion('spawned').handle });
      await expect(service.dispatch({ jobId: 'job-bad', repoPath: repo.path, title: 'bad', briefing: 'brief' })).rejects.toThrow('register unavailable');
      expect(gate.view().worker).toMatchObject({ running: 0, queued: [] });
      expect(api.getJob('job-bad')?.status).toBe('blocked');
    } finally { close(); }
  });

  it('a refused spawn releases the worker slot too', async () => {
    const repo = makeFixtureRepo('pacing-spawn-error'); repos.push(repo);
    const root = mkdtempSync(join(tmpdir(), 'pacing-spawn-error-')); dirs.push(root);
    const { api, close } = ledgerIn();
    try {
      const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
      const service = new DispatchService({ ledger: api, worktrees: new InMemoryWorktreePort(root), workerGate: gate,
        spawner: async () => { throw new Error('spawn refused'); } });
      await expect(service.dispatch({ jobId: 'job-bad', repoPath: repo.path, title: 'bad', briefing: 'brief' })).rejects.toThrow('spawn refused');
      expect(gate.view().worker).toMatchObject({ running: 0, queued: [] });
    } finally { close(); }
  });

  it('re-brief spawn queues and the board snapshot exposes its identity and honest reason', async () => {
    const repo = makeFixtureRepo('pacing-rebrief'); repos.push(repo);
    const { api, close } = ledgerIn();
    try {
      api.addJob({ id: 'job-rebrief', repo: 'fixture', title: 'rebrief', briefing: 'brief' });
      const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 0 });
      const holder = await gate.acquireWorkerTurn({ id: 'holder', label: 'holder' });
      const worker = makeFakeMinion('rebrief-minion');
      const spawner = vi.fn(async () => worker.handle);
      const routing = rebriefFreshMinion({ registry: { getHandle: () => null, spawn: spawner, disposeHandle: async () => {} },
        ledger: api, workerGate: gate, worktrees: { listWorktrees: () => [{ kind: 'job', status: 'active', path: repo.path }] } as unknown as WorktreePort,
        jobId: 'job-rebrief', note: 'continue', briefing: 'brief' });
      await flush();
      expect(spawner).not.toHaveBeenCalled();
      const board = new BoardEngine({ ledger: api, bus: new EventBus(), pacing: () => gate.view() });
      expect(board.snapshot().pacing?.worker.queued).toMatchObject([{ id: 'job-rebrief', label: 're-brief → job-rebrief', reason: expect.stringContaining('1/1 minion turns running') }]);
      holder.release();
      await flush();
      expect(spawner).toHaveBeenCalledTimes(1);
      worker.settle();
      await routing;
      expect(board.snapshot().pacing?.worker).toMatchObject({ running: 0, queued: [] });
    } finally { close(); }
  });

  it('a re-brief turn whose bounded retry exhausts fails loud instead of recording a delivery', async () => {
    const repo = makeFixtureRepo('pacing-rebrief-exhausted');
    repos.push(repo);
    const { api, close } = ledgerIn();
    try {
      api.addJob({ id: 'job-rebrief-exhausted', repo: 'fixture', title: 'rebrief', briefing: 'brief' });
      const worker = makeFakeMinion('rebrief-exhausted-minion');
      const routing = rebriefFreshMinion({
        registry: { getHandle: () => null, spawn: async () => worker.handle, disposeHandle: async () => {} },
        ledger: api,
        retrySettlement: async () => 'exhausted',
        worktrees: { listWorktrees: () => [{ kind: 'job', status: 'active', path: repo.path }] } as unknown as WorktreePort,
        jobId: 'job-rebrief-exhausted', note: 'continue', briefing: 'brief',
      });
      await flush();
      worker.settle();
      await expect(routing).rejects.toThrow(/automatic rate-limit retry exhausted/);
    } finally { close(); }
  });
});

describe('worker delivery settlement through the dispatcher', () => {
  it('marks the lane blocked when the bounded retry budget is spent', async () => {
    const repo = makeFixtureRepo('pacing-dispatch-exhausted');
    repos.push(repo);
    const root = mkdtempSync(join(tmpdir(), 'pacing-dispatch-exhausted-lanes-'));
    dirs.push(root);
    const { api, close } = ledgerIn();
    try {
      const minion = makeFakeMinion('minion-exhausted');
      const service = new DispatchService({
        ledger: api,
        worktrees: new InMemoryWorktreePort(root),
        spawner: async () => minion.handle,
        retrySettlement: async () => 'exhausted',
      });
      const outcome = await service.dispatch({
        jobId: 'job-exhausted', repoPath: repo.path, title: 'exhausted', briefing: 'brief',
      });
      minion.settle();
      await expect(outcome.settled).resolves.toMatchObject({ ok: false });
      expect(api.getJob('job-exhausted')?.status).toBe('blocked');
      expect(api.listJobEvents('job-exhausted').some((event) => event.kind === 'job.minion-error')).toBe(true);
      expect(api.listJobEvents('job-exhausted').some((event) => event.kind === 'job.delivered')).toBe(false);
    } finally { close(); }
  });

  it('a rejected briefing turn whose retry recovers is still reported delivered', async () => {
    const repo = makeFixtureRepo('pacing-dispatch-rejected');
    repos.push(repo);
    const root = mkdtempSync(join(tmpdir(), 'pacing-dispatch-rejected-lanes-'));
    dirs.push(root);
    const { api, close } = ledgerIn();
    try {
      const minion = makeFakeMinion('minion-rejected');
      const service = new DispatchService({
        ledger: api,
        worktrees: new InMemoryWorktreePort(root),
        spawner: async () => minion.handle,
        retrySettlement: async () => 'recovered',
      });
      const outcome = await service.dispatch({
        jobId: 'job-rejected', repoPath: repo.path, title: 'rejected', briefing: 'brief',
      });
      minion.fail(new Error('429 too many requests'));
      await expect(outcome.settled).resolves.toEqual({ ok: true });
      expect(api.getJob('job-rejected')?.status).toBe('delivered');
      expect(api.listJobEvents('job-rejected').some((event) => event.kind === 'job.delivered')).toBe(true);
    } finally { close(); }
  });

  it('a settlement cancelled by shutdown blocks the lane and never records delivery', async () => {
    const repo = makeFixtureRepo('pacing-dispatch-cancelled');
    repos.push(repo);
    const root = mkdtempSync(join(tmpdir(), 'pacing-dispatch-cancelled-lanes-'));
    dirs.push(root);
    const { api, close } = ledgerIn();
    const controller = new AbortController();
    try {
      const minion = makeFakeMinion('minion-cancelled');
      let hookEntered!: () => void;
      const entered = new Promise<void>((resolve) => { hookEntered = resolve; });
      const service = new DispatchService({
        ledger: api,
        worktrees: new InMemoryWorktreePort(root),
        spawner: async () => minion.handle,
        stopSignal: controller.signal,
        retrySettlement: () => { hookEntered(); return new Promise<'recovered'>(() => {}); },
      });
      const outcome = await service.dispatch({
        jobId: 'job-cancelled', repoPath: repo.path, title: 'cancelled', briefing: 'brief',
      });
      minion.settle();
      await entered;
      controller.abort();
      await expect(outcome.settled).resolves.toMatchObject({
        ok: false,
        error: 'dispatch stopped before the automatic retries settled',
      });
      expect(api.getJob('job-cancelled')?.status).toBe('blocked');
      expect(api.getJob('job-cancelled')?.note).toContain('pacing: dispatch stopped before the automatic retries settled');
      expect(api.listJobEvents('job-cancelled').some((event) => event.kind === 'job.minion-error')).toBe(true);
      expect(api.listJobEvents('job-cancelled').some((event) => event.kind === 'job.delivered')).toBe(false);
    } finally { close(); }
  });

  it('a settlement-hook fault blocks the lane with the internal error instead of narrating retries', async () => {
    const repo = makeFixtureRepo('pacing-dispatch-fault');
    repos.push(repo);
    const root = mkdtempSync(join(tmpdir(), 'pacing-dispatch-fault-lanes-'));
    dirs.push(root);
    const { api, close } = ledgerIn();
    try {
      const minion = makeFakeMinion('minion-fault');
      const service = new DispatchService({
        ledger: api,
        worktrees: new InMemoryWorktreePort(root),
        spawner: async () => minion.handle,
        retrySettlement: () => { throw new Error('wiring fault'); },
      });
      const outcome = await service.dispatch({
        jobId: 'job-fault', repoPath: repo.path, title: 'fault', briefing: 'brief',
      });
      minion.settle();
      await expect(outcome.settled).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining('retry settlement unavailable'),
      });
      expect(api.getJob('job-fault')?.status).toBe('blocked');
      expect(api.getJob('job-fault')?.note).toContain('pacing settlement unavailable — internal error');
      expect(api.listJobEvents('job-fault').some((event) => event.kind === 'job.minion-error')).toBe(true);
      expect(api.listJobEvents('job-fault').some((event) => event.kind === 'job.delivered')).toBe(false);
    } finally { close(); }
  });
});
