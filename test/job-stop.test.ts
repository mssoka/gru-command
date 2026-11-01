import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus, type BusEvent } from '../src/events/bus.js';
import {
  JobExecutionStop,
  jobStopResidue,
  jobStopUnprovenNotice,
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
  /** Runs after the lane is working and BEFORE the park that opens the
   * hold, so a test can seed events that genuinely predate the hold. */
  readonly beforePark?: (ledger: LedgerApi) => void;
} = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'gru-job-stop-'));
  dirs.push(dir);
  const db = new LedgerDb(dir);
  const ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
  ledger.addJob({ id: JOB, repo: 'gru-command', title: 'stop the producers', briefing: 'b' });
  ledger.setJobStatus(JOB, 'working');
  opts.beforePark?.(ledger);
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

  // #562: an empty registry proves nothing — `Array#every` over empty lists
  // used to yield `stopped`. A lane with no stop event at all is the legacy
  // case, and its residue names that exact fact.
  it('records unproven for an empty registry instead of stopped: registry absence is not evidence', async () => {
    const notifyUnproven = vi.fn();
    const f = fixture({ notifyUnproven });
    try {
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('unproven');
      expect(outcome.agents).toEqual([]);
      expect(outcome.children).toEqual([]);
      expect(outcome.outstanding).toContain('parked before stop events existed; registry absence is not evidence');
      expect(eventStates(f.ledger)).toEqual(['requested', 'unproven']);
      expect(f.ledger.latestJobEvent(JOB, 'job.execution-stop')?.payload).toMatchObject({
        state: 'unproven',
        physical_state: 'unproven',
        agents: [],
        children: [],
        outstanding: ['parked before stop events existed; registry absence is not evidence'],
      });
      expect(notifyUnproven).toHaveBeenCalledTimes(1);
    } finally {
      f.close();
    }
  });

  // The owner notice is user-visible (AGENTS.md): the residue an owner reads
  // and the way out of the hold are pinned here, not only in `main.ts`.
  it('tells the owner what an unproven stop means and how the hold lifts', async () => {
    const f = fixture();
    try {
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(jobStopUnprovenNotice(outcome)).toEqual({
        title: `Parked job ${JOB}: producer stop is unproven`,
        detail:
          'The explicit owner hold is recorded, but the service cannot prove every producer stopped: parked before stop events existed; registry absence is not evidence. ' +
          'The job stays parked and new verifications, child workers and initial dispatches are refused until the residue settles. ' +
          'Where nothing is running for the lane, resuming or closing the job lifts the hold; this notice settles on the next stop reconcile at boot.',
      });
    } finally {
      f.close();
    }
  });

  it('names a non-legacy empty target set as unproven with the stop-target residue', async () => {
    const f = fixture();
    try {
      f.ledger.appendCustomEvent({ kind: 'job.execution-stop', jobId: JOB, payload: { state: 'unproven', by: 'crash', reason: 'interrupted' } });
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('unproven');
      expect(outcome.outstanding).toContain('no stop target exists — registry absence is not evidence of cessation');
      expect(eventStates(f.ledger).at(-1)).toBe('unproven');
    } finally {
      f.close();
    }
  });

  it('re-proves a legacy parked lane at boot: idle rows without handles are unproven, not stopped', async () => {
    const notifyUnproven = vi.fn();
    const f = fixture({ agents: [{ id: 'minion-legacy', state: 'idle' }], notifyUnproven });
    try {
      expect(f.ledger.latestJobEvent(JOB, 'job.execution-stop')).toBeNull();
      expect(await f.stop.reconcileOnBoot()).toBe(1);
      expect(f.ledger.getJob(JOB)?.status).toBe('parked');
      expect(eventStates(f.ledger)).toEqual(['requested', 'unproven']);
      expect(f.ledger.latestJobEvent(JOB, 'job.execution-stop')?.payload).toMatchObject({
        physical_state: 'unproven',
        outstanding: ['parked before stop events existed; registry absence is not evidence'],
      });
      expect(notifyUnproven).toHaveBeenCalledTimes(1);
      // No producer effect: the idle row is not an open turn and no handle exists.
      expect(f.ledger.listAgents().find((agent) => agent.id === 'minion-legacy')?.state).toBe('idle');
      // The next boot visits the now-unproven lane and still refuses to claim stop.
      expect(await f.stop.reconcileOnBoot()).toBe(1);
      expect(eventStates(f.ledger)).toEqual(['requested', 'unproven', 'requested', 'unproven']);
      expect(f.ledger.getJob(JOB)?.status).toBe('parked');
    } finally {
      f.close();
    }
  });

  it('re-proves a legacy parked lane whose only row settled to error: unproven, never stopped', async () => {
    const f = fixture({ agents: [{ id: 'minion-ghost', state: 'error' }] });
    try {
      expect(await f.stop.reconcileOnBoot()).toBe(1);
      expect(eventStates(f.ledger)).toEqual(['requested', 'unproven']);
      expect(f.ledger.latestJobEvent(JOB, 'job.execution-stop')?.payload).toMatchObject({
        physical_state: 'unproven',
        agents: [],
        outstanding: ['parked before stop events existed; registry absence is not evidence'],
      });
      expect(f.ledger.getJob(JOB)?.status).toBe('parked');
    } finally {
      f.close();
    }
  });

  // BLOCKER from the plan review: perkins.ts returns the vacuous
  // `{ confirmed: true, roundIds: [] }` when the lane owns no review
  // operation. It must not prove a stop on its own.
  it('does not count a vacuous review confirmation as a stop target', async () => {
    const f = fixture({
      reviews: { supersedeReviews: async () => ({ jobId: JOB, roundIds: [], operations: 0, confirmed: true, detail: null }) },
    });
    try {
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('unproven');
      expect(outcome.reviews.state).toBe('stopped');
      expect(outcome.reviews.roundIds).toEqual([]);
      expect(outcome.outstanding).toContain('parked before stop events existed; registry absence is not evidence');
    } finally {
      f.close();
    }
  });

  it('counts a job-level review-supersession-confirmed written by this pass as proven review evidence', async () => {
    const f = fixture({
      // The real `WaveRunner.supersedeReviews` writes the job-level receipt
      // itself, i.e. during the pass and after its `requested` fence.
      reviews: {
        supersedeReviews: async () => {
          f.ledger.appendCustomEvent({ kind: 'job.review-supersession-confirmed', jobId: JOB, payload: { by: 'perkins', operations: 1 } });
          return { jobId: JOB, roundIds: [], operations: 0, confirmed: true, detail: null };
        },
      },
    });
    try {
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('stopped');
      expect(outcome.reviews.state).toBe('stopped');
      expect(outcome.outstanding).toEqual([]);
    } finally {
      f.close();
    }
  });

  // A receipt from an earlier supersession (the writer gate, an accepted
  // material amendment) proves nothing about this hold: it predates both the
  // park that opened the hold and this pass's own `requested` write.
  it('ignores a review-supersession-confirmed written before the current hold', async () => {
    const f = fixture({
      // Seeded BEFORE the park, so the receipt genuinely predates the hold.
      beforePark: (ledger) => {
        ledger.appendCustomEvent({ kind: 'job.review-supersession-confirmed', jobId: JOB, payload: { by: 'writer', operations: 1 } });
      },
      reviews: { supersedeReviews: async () => ({ jobId: JOB, roundIds: [], operations: 0, confirmed: true, detail: null }) },
    });
    try {
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('unproven');
      expect(outcome.reviews.state).toBe('stopped');
      expect(outcome.outstanding).toContain('parked before stop events existed; registry absence is not evidence');
    } finally {
      f.close();
    }
  });

  // The crash-mid-pass shape `perkins.ts` names ("A restart that interrupted
  // the pass leaves exactly this shape"): the interrupted pass wrote its
  // `requested`, superseded the fallback review and wrote the job-level
  // receipt, then died before the verdict. The hold did not change, so the
  // boot re-proof must honour that receipt — otherwise every retry writes a
  // newer `requested` and the lane can never be proven while parked.
  it('honours a review-supersession-confirmed the interrupted pass of this hold wrote', async () => {
    const f = fixture({
      reviews: { supersedeReviews: async () => ({ jobId: JOB, roundIds: [], operations: 0, confirmed: true, detail: null }) },
    });
    try {
      f.ledger.appendCustomEvent({ kind: 'job.execution-stop', jobId: JOB, payload: { state: 'requested', by: 'crash', reason: 'interrupted' } });
      f.ledger.appendCustomEvent({ kind: 'job.review-supersession-confirmed', jobId: JOB, payload: { by: 'perkins', operations: 1 } });
      const outcome = await f.stop.stop({
        jobId: JOB,
        by: 'service:boot',
        reason: 're-proving an interrupted producer stop for a parked lane',
      });
      expect(outcome.state).toBe('stopped');
      expect(outcome.reviews.state).toBe('stopped');
      expect(outcome.outstanding).toEqual([]);
      expect(eventStates(f.ledger)).toEqual(['requested', 'requested', 'stopped']);
    } finally {
      f.close();
    }
  });

  // The amendment that keeps today's behaviour: a proven agent stop still
  // settles with the vacuous review stub because that stub is no review
  // target — it is neither proof nor residue.
  it('keeps a proven agent stop stopped with a vacuous review confirmation', async () => {
    const f = fixture({
      agents: [{ id: 'minion-real', state: 'streaming' }],
      handles: new Map([['minion-real', fakeHandle('minion-real', 'ceased')]]),
      reviews: { supersedeReviews: async () => ({ jobId: JOB, roundIds: [], operations: 0, confirmed: true, detail: null }) },
    });
    try {
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('stopped');
      expect(outcome.reviews.state).toBe('stopped');
      expect(outcome.outstanding).toEqual([]);
    } finally {
      f.close();
    }
  });

  it('proves a stop from a live handle even when the lane already carries a stop event', async () => {
    const f = fixture({
      agents: [{ id: 'minion-reproof', state: 'streaming' }],
      handles: new Map([['minion-reproof', fakeHandle('minion-reproof', 'ceased')]]),
    });
    try {
      f.ledger.appendCustomEvent({ kind: 'job.execution-stop', jobId: JOB, payload: { state: 'unproven', by: 'crash', reason: 'interrupted' } });
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('stopped');
      expect(outcome.agents).toEqual([{ agentId: 'minion-reproof', role: 'minion', state: 'stopped', detail: null }]);
      expect(eventStates(f.ledger)).toEqual(['unproven', 'requested', 'stopped']);
    } finally {
      f.close();
    }
  });

  it('leaves the owner hold untouched when the stop stays unproven', async () => {
    const notifyUnproven = vi.fn();
    const notifyResolved = vi.fn();
    const f = fixture({
      agents: [{ id: 'minion-hold', state: 'streaming' }],
      handles: new Map([['minion-hold', fakeHandle('minion-hold', 'unknown')]]),
      notifyUnproven,
      notifyResolved,
    });
    try {
      const statusEventsBefore = f.ledger.listJobEventsByKinds(JOB, ['job.status']).length;
      const outcome = await f.stop.stop({ jobId: JOB, by: 'tester', reason: 'owner cancelled implementation' });
      expect(outcome.state).toBe('unproven');
      expect(f.ledger.getJob(JOB)?.status).toBe('parked');
      expect(f.ledger.listJobEventsByKinds(JOB, ['job.status'])).toHaveLength(statusEventsBefore);
      expect(notifyUnproven).toHaveBeenCalledTimes(1);
      expect(notifyResolved).not.toHaveBeenCalled();
    } finally {
      f.close();
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
