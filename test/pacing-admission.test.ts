import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { DispatchService } from '../src/dispatch/service.js';
import { routeFixDirectiveToMinion } from '../src/dispatch/fix-directive.js';
import { PacingGate } from '../src/runtime/pacing.js';
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
      expect(recordingGate.view().worker.queued).toHaveLength(0);
      expect(recordingGate.view().worker.running).toBe(1);
      expect(events).toEqual(['pacing.queued', 'pacing.admitted']);

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
    expect(delivered).toEqual(['fix the lane']);
    expect(events).toEqual(['pacing.queued', 'pacing.admitted']);
    expect(gate.view().worker.running).toBe(0);
    expect(gate.view().worker.queued).toHaveLength(0);
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
