import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type BusEvent } from '../src/events/bus.js';
import {
  JobExecutionStop,
  jobStopResidue,
  watchParkedJobs,
  type JobStopDeps,
} from '../src/dispatch/job-stop.js';
import { DispatchService } from '../src/dispatch/service.js';
import { LedgerApi, type ChildWorkerRecord } from '../src/ledger/api.js';
import { ownerAttentionFor } from '../src/notifications/attention.js';
import { LedgerDb } from '../src/ledger/db.js';
import type { AgentHandle } from '../src/runtime/types.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

const JOB = 'job-stop';

interface Fixture {
  readonly ledger: LedgerApi;
  readonly db: LedgerDb;
  readonly stop: JobExecutionStop;
  readonly close: () => void;
}

const dirs: string[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => {
  while (repos.length > 0) repos.pop()!.cleanup();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

interface FakeHandleOptions {
  readonly reject?: boolean;
  readonly gate?: Promise<void>;
  readonly dispose?: () => void;
}

function fakeHandle(id: string, evidence: 'ceased' | 'unknown', opts: FakeHandleOptions = {}): AgentHandle {
  return {
    id,
    role: 'minion',
    sessionFile: null,
    capabilities: {},
    health: () => ({ state: 'streaming', lastActivity: null, sessionFile: null }),
    dispose: async () => {
      opts.dispose?.();
      await opts.gate;
      if (opts.reject === true) throw new Error('dispose rejected');
    },
    cessationEvidence: () => evidence,
  } as unknown as AgentHandle;
}

function fixture(opts: {
  readonly agents?: readonly { readonly id: string; readonly state: 'spawning' | 'idle' | 'streaming' | 'error' }[];
  readonly handles?: ReadonlyMap<string, AgentHandle>;
  readonly reviews?: JobStopDeps['reviews'];
  readonly notifyUnproven?: JobStopDeps['notifyUnproven'];
  readonly notifyResolved?: JobStopDeps['notifyResolved'];
} = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'gru-job-stop-'));
  dirs.push(dir);
  const db = new LedgerDb(dir);
  const ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
  ledger.addJob({ id: JOB, repo: 'gru-command', title: 'stop the producers', briefing: 'b' });
  ledger.setJobStatus(JOB, 'working');
  ledger.setJobStatus(JOB, 'parked');
  for (const agent of opts.agents ?? []) {
    ledger.registerAgent({ id: agent.id, role: 'minion', jobId: JOB, parentage: 'top-level' });
    ledger.setAgentState(agent.id, agent.state);
  }
  const handles = new Map(opts.handles ?? []);
  const stop = new JobExecutionStop({
    ledger,
    handles: { list: () => [...handles.values()] },
    children: null,
    reviews: opts.reviews === undefined ? null : opts.reviews,
    ...(opts.notifyUnproven === undefined ? {} : { notifyUnproven: opts.notifyUnproven }),
    ...(opts.notifyResolved === undefined ? {} : { notifyResolved: opts.notifyResolved }),
    log: () => {},
  });
  return { ledger, db, stop, close: () => db.close() };
}

function eventStates(ledger: LedgerApi): readonly string[] {
  return ledger
    .listJobEventsByKinds(JOB, ['job.execution-stop'])
    .map((event) => (event.payload as { state: string }).state)
    .reverse();
}

describe('job execution stop (issue #455)', () => {
  it('records stopped only on positive adapter cessation evidence', async () => {
    const notifyUnproven = vi.fn();
    const notifyResolved = vi.fn();
    const f = fixture({
      agents: [{ id: 'minion-1', state: 'streaming' }],
      handles: new Map([['minion-1', fakeHandle('minion-1', 'ceased')]]),
      reviews: { supersedeReviews: async () => ({ jobId: JOB, roundIds: [], operations: 0, confirmed: true, detail: null }) },
      notifyUnproven,
      notifyResolved,
    });
    try {
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('stopped');
      expect(outcome.superseded).toBe(false);
      expect(outcome.agents).toEqual([{ agentId: 'minion-1', role: 'minion', state: 'stopped', detail: null }]);
      expect(outcome.reviews.state).toBe('stopped');
      expect(eventStates(f.ledger)).toEqual(['requested', 'stopped']);
      expect(notifyUnproven).not.toHaveBeenCalled();
      expect(notifyResolved).toHaveBeenCalledTimes(1);
    } finally {
      f.close();
    }
  });

  it('disposes a live handle whose ledger row reads idle, and proves it from the adapter', async () => {
    // The durable agent row is a projection: a turn_end leaves it idle while
    // the runtime session still owns the process. The stop must not trust it.
    const dispose = vi.fn();
    const f = fixture({
      agents: [{ id: 'minion-idle', state: 'idle' }],
      handles: new Map([['minion-idle', fakeHandle('minion-idle', 'ceased', { dispose })]]),
      reviews: { supersedeReviews: async () => ({ jobId: JOB, roundIds: [], operations: 0, confirmed: true, detail: null }) },
    });
    try {
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(outcome.agents).toEqual([{ agentId: 'minion-idle', role: 'minion', state: 'stopped', detail: null }]);
      expect(outcome.state).toBe('stopped');
    } finally {
      f.close();
    }
  });

  it('preserves unproven when disposal returns without cessation evidence', async () => {
    const f = fixture({
      agents: [{ id: 'minion-2', state: 'streaming' }],
      handles: new Map([['minion-2', fakeHandle('minion-2', 'unknown')]]),
    });
    try {
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('unproven');
      expect(outcome.agents[0]?.state).toBe('unproven');
      expect(outcome.agents[0]?.detail).toMatch(/without the adapter observing cessation/);
      expect(eventStates(f.ledger).at(-1)).toBe('unproven');
    } finally {
      f.close();
    }
  });

  it('treats a ledger open turn with no runtime handle as unproven, never stopped', async () => {
    const f = fixture({ agents: [{ id: 'minion-3', state: 'streaming' }] });
    try {
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('unproven');
      expect(outcome.agents[0]?.detail).toMatch(/runtime holds no handle/);
    } finally {
      f.close();
    }
  });

  it('names a failed dispose instead of claiming the producer stopped', async () => {
    const f = fixture({
      agents: [{ id: 'minion-4', state: 'streaming' }],
      handles: new Map([['minion-4', fakeHandle('minion-4', 'ceased', { reject: true })]]),
    });
    try {
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('unproven');
      expect(outcome.agents[0]?.detail).toMatch(/dispose failed/);
    } finally {
      f.close();
    }
  });

  it('does not hide an unsettled verification behind a stopped verdict', async () => {
    const f = fixture({
      agents: [{ id: 'minion-5', state: 'streaming' }],
      handles: new Map([['minion-5', fakeHandle('minion-5', 'ceased')]]),
    });
    try {
      f.ledger.appendCustomEvent({ kind: 'verification.requested', jobId: JOB, payload: { run_id: 'run-open' } });
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('unproven');
      expect(outcome.outstanding.join(' ')).toMatch(/unsettled verification run/);
      expect(jobStopResidue(outcome).join(' ')).toMatch(/unsettled verification run/);
    } finally {
      f.close();
    }
  });

  it('records an unconfirmed review stop as unproven', async () => {
    const f = fixture({
      reviews: {
        supersedeReviews: async () => ({ jobId: JOB, roundIds: [], operations: 1, confirmed: false, detail: 'session still live' }),
      },
    });
    try {
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('unproven');
      expect(outcome.reviews).toEqual({ state: 'unproven', roundIds: [], detail: 'session still live' });
    } finally {
      f.close();
    }
  });

  it('without a review service, a recorded live round is unproven — not a skipped pass', async () => {
    const f = fixture();
    try {
      f.ledger.addRound({ jobId: JOB });
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('unproven');
      expect(outcome.reviews.state).toBe('unproven');
      expect(outcome.reviews.roundIds).toHaveLength(1);
    } finally {
      f.close();
    }
  });

  it('cancels tracked child workers and proves a terminal child result', async () => {
    const f = fixture({ agents: [{ id: 'minion-6', state: 'streaming' }] });
    try {
      f.ledger.admitChildWorker({
        id: 'child-1',
        parentAgentId: 'minion-6',
        jobId: JOB,
        purpose: 'research',
        authority: 'read-only',
        task: 'read the lane',
        idempotencyKey: 'k-child',
      });
      const record = f.ledger.getChildWorker('child-1')!;
      const cancel = vi.fn(async (): Promise<ChildWorkerRecord> => ({ ...record, resultState: 'cancelled' }));
      const stop = new JobExecutionStop({
        ledger: f.ledger,
        handles: { list: () => [fakeHandle('minion-6', 'ceased')] },
        children: { cancel },
        reviews: { supersedeReviews: async () => ({ jobId: JOB, roundIds: [], operations: 0, confirmed: true, detail: null }) },
        log: () => {},
      });
      const outcome = await stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(cancel).toHaveBeenCalledWith('child-1', expect.stringContaining('owner cancelled implementation'));
      expect(outcome.children).toEqual([{ childId: 'child-1', state: 'stopped', detail: null }]);
      expect(outcome.state).toBe('stopped');
    } finally {
      f.close();
    }
  });

  it('notifies the owner exactly once when the stop is unproven', async () => {
    const notify = vi.fn();
    const f = fixture({
      agents: [{ id: 'minion-7', state: 'streaming' }],
      handles: new Map([['minion-7', fakeHandle('minion-7', 'unknown')]]),
      notifyUnproven: notify,
    });
    try {
      await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(notify).toHaveBeenCalledTimes(1);
      expect((notify.mock.calls[0]?.[0] as { state: string }).state).toBe('unproven');
    } finally {
      f.close();
    }
  });

  it('escalates a job-scoped owner incident kind', () => {
    expect(ownerAttentionFor('job-stop-unproven:job-1')).toBe('owner-required');
  });

  it('marks a pass superseded when the owner resumes the lane mid-stop', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture({
      agents: [{ id: 'minion-8', state: 'streaming' }],
      handles: new Map([['minion-8', fakeHandle('minion-8', 'ceased', { gate })]]),
      reviews: { supersedeReviews: async () => ({ jobId: JOB, roundIds: [], operations: 0, confirmed: true, detail: null }) },
    });
    try {
      f.ledger.setJobStatus(JOB, 'parked');
      const running = f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      f.ledger.setJobStatus(JOB, 'working');
      release();
      const outcome = await running;
      expect(outcome.superseded).toBe(true);
      expect(eventStates(f.ledger).at(-1)).toBe('superseded');
    } finally {
      f.close();
    }
  });

  it('re-proves an interrupted or unproven stop at boot for parked lanes', async () => {
    let disposed = 0;
    const f = fixture({
      agents: [{ id: 'minion-9', state: 'streaming' }],
      handles: new Map([['minion-9', fakeHandle('minion-9', 'ceased', { dispose: () => { disposed += 1; } })]]),
      reviews: { supersedeReviews: async () => ({ jobId: JOB, roundIds: [], operations: 0, confirmed: true, detail: null }) },
    });
    try {
      f.ledger.setJobStatus(JOB, 'parked');
      f.ledger.appendCustomEvent({ kind: 'job.execution-stop', jobId: JOB, payload: { state: 'requested', by: 'crash', reason: 'interrupted' } });
      const passes = await f.stop.reconcileOnBoot();
      expect(passes).toBe(1);
      expect(disposed).toBe(1);
      expect(eventStates(f.ledger).at(-1)).toBe('stopped');
    } finally {
      f.close();
    }
  });

  it('settles an open producer incident at boot when the owner already resumed', async () => {
    const notifyResolved = vi.fn();
    const f = fixture({ notifyResolved });
    try {
      f.ledger.appendCustomEvent({ kind: 'job.execution-stop', jobId: JOB, payload: { state: 'unproven' } });
      f.ledger.setJobStatus(JOB, 'working');
      const passes = await f.stop.reconcileOnBoot();
      expect(passes).toBe(0);
      expect(notifyResolved).toHaveBeenCalledWith(JOB);
    } finally {
      f.close();
    }
  });

  it('watches park transitions and escalates a failed pass', async () => {
    const bus = new EventBus({});
    const stop = { stop: vi.fn(async () => { throw new Error('ledger unavailable'); }) };
    const notifyFailed = vi.fn();
    const log = vi.fn();
    const unsubscribe = watchParkedJobs({ bus, stop, notifyFailed, log });
    try {
      bus.publish({
        seq: 1,
        ts: '0',
        kind: 'job.status',
        jobId: JOB,
        agentId: null,
        roundId: null,
        lens: null,
        payload: { from: 'working', to: 'parked' },
      } satisfies BusEvent);
      await new Promise((resolve) => setImmediate(resolve));
      expect(stop.stop).toHaveBeenCalledWith(expect.objectContaining({ jobId: JOB, by: 'service:park' }));
      expect(notifyFailed).toHaveBeenCalledWith(JOB, expect.any(Error));
      expect(log).toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  // A disposal makes the producer's briefing turn reject. That rejection is
  // the CONSEQUENCE of the hold and must not rewrite the explicit owner
  // hold into a fresh `blocked` blocker.
  it('keeps the lane parked when a disposed producer settles with an error', async () => {
    const repo = makeFixtureRepo('job-stop-settle');
    repos.push(repo);
    const laneRoot = mkdtempSync(join(tmpdir(), 'gru-job-stop-lanes-'));
    dirs.push(laneRoot);
    const dir = mkdtempSync(join(tmpdir(), 'gru-job-stop-ledger-'));
    dirs.push(dir);
    const db = new LedgerDb(dir);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
    try {
      const worktrees = new InMemoryWorktreePort(laneRoot, ledger);
      let failTurn!: (error: unknown) => void;
      const turn = new Promise<void>((_, reject) => {
        failTurn = reject;
      });
      const handle = {
        id: 'minion-parked',
        role: 'minion',
        sessionFile: null,
        capabilities: {},
        prompt: () => turn,
        health: () => ({ state: 'idle', lastActivity: null, sessionFile: null }),
        dispose: async () => {},
      } as unknown as AgentHandle;
      const service = new DispatchService({ ledger, worktrees, spawner: async () => handle });
      const run = await service.dispatch({
        jobId: 'job-parked-settle',
        repoPath: repo.path,
        title: 'parked settle',
        briefing: 'work',
      });
      expect(ledger.getJob('job-parked-settle')?.status).toBe('working');
      ledger.setJobStatus('job-parked-settle', 'parked');
      failTurn(new Error('turn aborted by the explicit owner hold'));
      await run.settled;
      expect(ledger.getJob('job-parked-settle')?.status).toBe('parked');
      expect(ledger.latestJobEvent('job-parked-settle', 'job.minion-error')).not.toBeNull();
    } finally {
      db.close();
    }
  });
});
