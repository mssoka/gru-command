import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import type { PipelineCapacityView } from '../src/ledger/pipeline.js';
import { PipelineService, type PipelineDispatchPort } from '../src/dispatch/pipeline.js';
import { NotificationCenter } from '../src/notifications/center.js';
import type { AgentEventEnvelope } from '../src/runtime/registry.js';

/**
 * The mechanical pipeline consumer: eligibility order, shared-capacity
 * admission, exclusive-scope serialization, crash/restart reconciliation
 * and the honesty of the projection — all against a real ledger and a
 * fake dispatch port (the real DispatchService owns its own suite).
 */

const cleanupDirs: string[] = [];
const liveServices: PipelineService[] = [];
afterEach(() => {
  while (liveServices.length > 0) liveServices.pop()!.dispose();
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

type DispatchMode = 'ok' | 'throw-after-job' | 'throw-before-job';

interface Harness {
  readonly dir: string;
  readonly ledger: LedgerApi;
  readonly db: LedgerDb;
  readonly service: PipelineService;
  readonly calls: { readonly jobId: string; readonly title: string; readonly briefing: string }[];
  capacity: PipelineCapacityView;
  mode: DispatchMode;
}

function boot(
  capacity: PipelineCapacityView = { capacity: 4, occupied: 0, queued: 0, available: 4 },
  overrides: {
    retryBackoffMs?: number;
    budget?: { acquire: (signal?: AbortSignal) => Promise<() => void> };
    ledger?: LedgerApi;
    bus?: EventBus;
    capacityFn?: () => PipelineCapacityView;
  } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gru-pipeline-service-'));
  cleanupDirs.push(dir);
  const db = new LedgerDb(dir);
  const bus = overrides.bus ?? new EventBus({});
  const ledger = overrides.ledger ?? new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  const calls: Harness['calls'] = [];
  const harness = { capacity, mode: 'ok' as DispatchMode, calls } as {
    capacity: PipelineCapacityView;
    mode: DispatchMode;
    calls: Harness['calls'];
  };
  const port: PipelineDispatchPort = {
    async dispatch(input) {
      calls.push({ jobId: input.jobId, title: input.title, briefing: input.briefing });
      if (harness.mode === 'throw-before-job') throw new Error('spawn failed before any job');
      ledger.addJob({ id: input.jobId, repo: 'demo', title: input.title, briefing: input.briefing });
      if (harness.mode === 'throw-after-job') {
        ledger.setJobStatus(input.jobId, 'working');
        ledger.setJobStatus(input.jobId, 'blocked');
        ledger.noteJob(input.jobId, 'dispatch failed: spawn failed');
        throw new Error('spawn failed after the job row');
      }
      // Realistic evidence, as the real DispatchService records it: the
      // worker started (milestone proof) and the briefing turn delivered.
      ledger.appendCustomEvent({ kind: 'job.minion-spawned', jobId: input.jobId, payload: {} });
      return { settled: Promise.resolve() };
    },
  };
  const service = new PipelineService({
    ledger,
    dispatch: port,
    capacity: overrides.capacityFn ?? (() => ({ ...harness.capacity })),
    ...(overrides.budget === undefined ? {} : { budget: overrides.budget }),
    ...(overrides.retryBackoffMs === undefined ? {} : { retryBackoffMs: overrides.retryBackoffMs }),
    bus,
    notifications,
  });
  liveServices.push(service);
  return Object.assign(harness, { dir, ledger, db, service });
}

describe('pipeline service — admission and ordering', () => {
  it('enqueues durably without a minion while capacity is full, then admits exactly once on release', async () => {
    const h = boot({ capacity: 4, occupied: 4, queued: 0, available: 0 });
    const receipt = h.service.enqueue({ id: 'pipe-a', repoPath: '/tmp/demo', title: 'Alpha', briefing: 'Do alpha' });
    expect(receipt.duplicate).toBe(false);
    await h.service.whenIdle();
    expect(h.calls).toHaveLength(0);
    const waiting = h.service.view().entries[0];
    expect(waiting?.state).toBe('ready');
    expect(waiting?.reason).toContain('resident worker slot');

    h.capacity = { capacity: 4, occupied: 3, queued: 0, available: 1 };
    h.service.schedule();
    await h.service.whenIdle();
    expect(h.calls.map((call) => call.jobId)).toEqual(['pipe-a']);
    expect(h.service.entry('pipe-a')?.state).toBe('admitted');
    expect(h.service.view().entries).toHaveLength(0);
    h.db.close();
  });

  it('never head-of-line blocks: a blocked high-priority entry waits while unrelated work proceeds', async () => {
    const h = boot();
    h.service.enqueue({
      id: 'pipe-blocked',
      repoPath: '/tmp/demo',
      title: 'Blocked urgent',
      briefing: 'Urgent but blocked',
      priority: 0,
      prerequisites: [{ id: 'pipe-ghost', milestone: 'merged' }],
    });
    h.service.enqueue({ id: 'pipe-free', repoPath: '/tmp/demo', title: 'Free', briefing: 'Ready to go', priority: 7 });
    await h.service.whenIdle();
    expect(h.calls.map((call) => call.jobId)).toEqual(['pipe-free']);
    const blocked = h.service.view().entries.find((entry) => entry.id === 'pipe-blocked');
    expect(blocked?.state).toBe('waiting');
    expect(blocked?.reason).toBe('waiting for pipe-ghost — not enqueued');
    h.db.close();
  });

  it('serializes a shared exclusive scope until the holding job terminates, without preempting it', async () => {
    const h = boot();
    h.service.enqueue({
      id: 'pipe-a',
      repoPath: '/tmp/demo',
      title: 'A',
      briefing: 'A',
      exclusiveScopes: ['repo:demo'],
    });
    h.service.enqueue({
      id: 'pipe-b',
      repoPath: '/tmp/demo',
      title: 'B',
      briefing: 'B',
      exclusiveScopes: ['repo:demo'],
    });
    await h.service.whenIdle();
    expect(h.calls.map((call) => call.jobId)).toEqual(['pipe-a']);
    expect(h.service.view().entries.find((entry) => entry.id === 'pipe-b')?.reason).toContain(
      'exclusive scope "repo:demo" held by pipe-a',
    );
    // The active worker is never preempted: only job termination frees it.
    h.ledger.setJobStatus('pipe-a', 'working');
    h.ledger.setJobStatus('pipe-a', 'done');
    await h.service.whenIdle();
    expect(h.calls.map((call) => call.jobId)).toEqual(['pipe-a', 'pipe-b']);
    h.db.close();
  });

  it('preserves durable FIFO order for equal priority across a restart', async () => {
    const first = boot({ capacity: 4, occupied: 4, queued: 0, available: 0 });
    first.service.enqueue({ id: 'pipe-a', repoPath: '/tmp/demo', title: 'A', briefing: 'A' });
    first.service.enqueue({ id: 'pipe-b', repoPath: '/tmp/demo', title: 'B', briefing: 'B' });
    await first.service.whenIdle();
    expect(first.calls).toHaveLength(0);
    first.service.dispose();

    const db2 = new LedgerDb(first.dir);
    const bus = new EventBus({});
    const ledger2 = new LedgerApi(db2.handle, { bus });
    const calls2: string[] = [];
    const service2 = new PipelineService({
      ledger: ledger2,
      dispatch: {
        async dispatch(input) {
          calls2.push(input.jobId);
          ledger2.addJob({ id: input.jobId, repo: 'demo', title: input.title, briefing: input.briefing });
          return { settled: Promise.resolve() };
        },
      },
      capacity: () => ({ capacity: 4, occupied: 2, queued: 0, available: 2 }),
      bus,
    });
    liveServices.push(service2);
    // Boot reconciliation is the production trigger (main.ts) — without it
    // a fresh service is dormant until an event arrives.
    service2.reconcileAtBoot();
    await service2.whenIdle();
    expect(calls2).toEqual(['pipe-a', 'pipe-b']);
    db2.close();
  });

  it('a duplicate enqueue never dispatches twice', async () => {
    const h = boot();
    const input = { id: 'pipe-a', requestId: 'req-1', repoPath: '/tmp/demo', title: 'A', briefing: 'A' };
    expect(h.service.enqueue(input).duplicate).toBe(false);
    await h.service.whenIdle();
    expect(h.service.enqueue(input).duplicate).toBe(true);
    await h.service.whenIdle();
    expect(h.calls).toHaveLength(1);
    h.db.close();
  });

  it('waits for an explicit owner hold and admits only after a deliberate release', async () => {
    const h = boot();
    h.service.enqueue({ id: 'pipe-a', repoPath: '/tmp/demo', title: 'A', briefing: 'A', holdReason: 'owner deciding' });
    await h.service.whenIdle();
    expect(h.calls).toHaveLength(0);
    expect(h.service.view().entries[0]?.reason).toBe('owner hold: owner deciding');
    h.service.clearHold('pipe-a', 'owner approved', { by: 'owner' });
    await h.service.whenIdle();
    expect(h.calls.map((call) => call.jobId)).toEqual(['pipe-a']);
    h.db.close();
  });

  it('does not admit while an older resident admission is queued ahead', async () => {
    const h = boot({ capacity: 4, occupied: 1, queued: 1, available: 3 });
    h.service.enqueue({ id: 'pipe-a', repoPath: '/tmp/demo', title: 'A', briefing: 'A' });
    await h.service.whenIdle();
    expect(h.calls).toHaveLength(0);
    h.capacity = { capacity: 4, occupied: 1, queued: 0, available: 3 };
    h.service.schedule();
    await h.service.whenIdle();
    expect(h.calls).toHaveLength(1);
    h.db.close();
  });

  it('reconsiders on dependency transitions without a user ping', async () => {
    const h = boot();
    h.service.enqueue({ id: 'pipe-dep', repoPath: '/tmp/demo', title: 'Dep', briefing: 'Dep' });
    h.service.enqueue({
      id: 'pipe-follower',
      repoPath: '/tmp/demo',
      title: 'Follower',
      briefing: 'Follower',
      prerequisites: [{ id: 'pipe-dep', milestone: 'delivered' }],
    });
    await h.service.whenIdle();
    expect(h.calls.map((call) => call.jobId)).toEqual(['pipe-dep']);
    expect(h.service.view().entries.find((entry) => entry.id === 'pipe-follower')?.reason).toContain(
      'waiting for pipe-dep to be delivered',
    );
    h.ledger.setJobStatus('pipe-dep', 'working');
    h.ledger.setJobStatus('pipe-dep', 'delivered');
    // Durable delivery proof (a bare status transition never releases a
    // dependent — the milestone needs the recorded delivery event).
    h.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'pipe-dep', payload: {} });
    await h.service.whenIdle();
    expect(h.calls.map((call) => call.jobId)).toEqual(['pipe-dep', 'pipe-follower']);
    h.db.close();
  });

  it('reconsiders on a worker-disposal event (capacity release)', async () => {
    const h = boot({ capacity: 4, occupied: 4, queued: 0, available: 0 });
    h.service.enqueue({ id: 'pipe-a', repoPath: '/tmp/demo', title: 'A', briefing: 'A' });
    await h.service.whenIdle();
    expect(h.calls).toHaveLength(0);
    h.capacity = { capacity: 4, occupied: 3, queued: 0, available: 1 };
    const envelope = { agentId: 'agent-x', role: 'minion', sessionFile: null, phase: 'disposed' } as AgentEventEnvelope;
    h.service.noteRuntimeEvent(envelope);
    await h.service.whenIdle();
    expect(h.calls).toHaveLength(1);
    h.db.close();
  });

  it('coalesces duplicate triggers into a single dispatch', async () => {
    const h = boot();
    h.service.enqueue({ id: 'pipe-a', repoPath: '/tmp/demo', title: 'A', briefing: 'A' });
    h.service.schedule();
    h.service.schedule();
    h.service.schedule();
    await h.service.whenIdle();
    h.service.schedule();
    await h.service.whenIdle();
    expect(h.calls).toHaveLength(1);
    h.db.close();
  });
});

describe('pipeline service — failure and crash reconciliation', () => {
  it('adopts a job that dispatch committed before failing instead of re-dispatching', async () => {
    const h = boot();
    h.mode = 'throw-after-job';
    h.service.enqueue({ id: 'pipe-a', repoPath: '/tmp/demo', title: 'A', briefing: 'A' });
    await h.service.whenIdle();
    expect(h.calls).toHaveLength(1);
    expect(h.service.entry('pipe-a')?.state).toBe('admitted');
    expect(h.ledger.getJob('pipe-a')?.status).toBe('blocked');
    h.service.schedule();
    await h.service.whenIdle();
    expect(h.calls).toHaveLength(1); // never re-dispatched
    h.db.close();
  });

  it('requeues a failure with no job, bounded and SPACED by a one-shot backoff, then lands failed with one machine card', async () => {
    vi.useFakeTimers();
    try {
      const h = boot(undefined, { retryBackoffMs: 5_000 });
      h.mode = 'throw-before-job';
      h.service.enqueue({ id: 'pipe-a', repoPath: '/tmp/demo', title: 'A', briefing: 'A' });
      await h.service.whenIdle();
      // One attempt per pass: the next attempts wait for the bounded
      // backoff (or a natural trigger), never burned inside one outage.
      expect(h.calls).toHaveLength(1);
      expect(h.service.entry('pipe-a')?.state).toBe('waiting');
      expect(h.service.entry('pipe-a')?.failureCount).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.calls).toHaveLength(2);
      expect(h.service.entry('pipe-a')?.failureCount).toBe(2);
      await vi.advanceTimersByTimeAsync(5_000);
      const entry = h.service.entry('pipe-a');
      expect(entry?.state).toBe('failed');
      expect(entry?.failureCount).toBe(3);
      expect(h.calls).toHaveLength(3);
      const cards = h.ledger.listNotifications().filter((row) => row.kind === 'pipeline.admission-failed');
      expect(cards).toHaveLength(1);
      expect(cards[0]?.routing).toBe('action-required');
      h.db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers a failed reconsider pass through the bounded one-shot retry (no stranding)', async () => {
    vi.useFakeTimers();
    try {
      const real = (() => {
        const dir = mkdtempSync(join(tmpdir(), 'gru-pipeline-service-d4-'));
        cleanupDirs.push(dir);
        const db = new LedgerDb(dir);
        const bus = new EventBus({});
        return { dir, db, bus, ledger: new LedgerApi(db.handle, { bus }) };
      })();
      // The ledger reads fine for the enqueue, then the FIRST reconsider
      // pass hits a transient failure (call #2), then reads are healthy.
      let callsToList = 0;
      const flaky: LedgerApi = new Proxy(real.ledger, {
        get(target, property, receiver) {
          if (property === 'listPipelineEntries') {
            const seen = ++callsToList;
            if (seen === 2) {
              return () => {
                throw new Error('transient ledger failure');
              };
            }
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const h = boot(undefined, { retryBackoffMs: 5_000, ledger: flaky, bus: real.bus });
      h.service.enqueue({ id: 'pipe-a', repoPath: '/tmp/demo', title: 'A', briefing: 'A' });
      await h.service.whenIdle();
      // The pass failed loudly; the entry is stranded only until the
      // one-shot backoff (no bus event is coming for it).
      expect(h.calls).toHaveLength(0);
      expect(h.service.entry('pipe-a')?.state).toBe('waiting');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.calls.map((call) => call.jobId)).toEqual(['pipe-a']);
      expect(h.service.entry('pipe-a')?.state).toBe('admitted');
      h.db.close();
      real.db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('registers queue demand with the shared budget while capacity-blocked and admits on the wake grant (D1)', async () => {
    const waiters: Array<(release: () => void) => void> = [];
    const refusals: Array<(error: Error) => void> = [];
    const acquiredSignals: Array<AbortSignal | undefined> = [];
    const budget = {
      acquire: (signal?: AbortSignal) =>
        new Promise<() => void>((resolve, reject) => {
          acquiredSignals.push(signal);
          waiters.push(resolve);
          refusals.push(reject);
        }),
    };
    const h = boot({ capacity: 4, occupied: 4, queued: 0, available: 0 }, { budget });
    h.service.enqueue({ id: 'pipe-a', repoPath: '/tmp/demo', title: 'A', briefing: 'A' });
    await h.service.whenIdle();
    // Eligible work + full pool: exactly ONE demand registration is open.
    expect(h.calls).toHaveLength(0);
    expect(waiters).toHaveLength(1);
    // The permit frees (a worker finished): the wake resolves, releases
    // immediately, and the triggered pass admits through the fresh read.
    h.capacity = { capacity: 4, occupied: 3, queued: 0, available: 1 };
    waiters[0]!(() => {});
    // Let the wake's release → schedule → pass microtasks run before the
    // idle gate is observed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.service.whenIdle();
    expect(h.calls.map((call) => call.jobId)).toEqual(['pipe-a']);
    expect(h.service.entry('pipe-a')?.state).toBe('admitted');
    // The demand registration is gone: no lingering acquire stays queued.
    expect(acquiredSignals.length).toBe(1);
    h.db.close();
  });

  it('adopts an interrupted claim whose job exists and requeues one whose job does not', async () => {
    const h = boot();
    h.service.enqueue({ id: 'pipe-a', repoPath: '/tmp/demo', title: 'A', briefing: 'A' });
    h.service.enqueue({ id: 'pipe-b', repoPath: '/tmp/demo', title: 'B', briefing: 'B' });
    await h.service.whenIdle();
    expect(h.calls).toHaveLength(2);
    // Freeze capacity so the live service cannot race the hand-crafted
    // crash claims below.
    h.capacity = { capacity: 4, occupied: 4, queued: 0, available: 0 };
    // Simulate a crash: an admitting claim for a job that committed.
    h.ledger.enqueuePipelineEntry({ id: 'pipe-c', repoPath: '/tmp/demo', title: 'C', briefing: 'C' });
    h.ledger.claimPipelineEntry({ id: 'pipe-c', holder: 'silas-pipeline' });
    h.ledger.addJob({ id: 'pipe-c', repo: 'demo', title: 'C', briefing: 'C' });
    // ... and an admitting claim with no job evidence at all.
    h.ledger.enqueuePipelineEntry({ id: 'pipe-d', repoPath: '/tmp/demo', title: 'D', briefing: 'D' });
    h.ledger.claimPipelineEntry({ id: 'pipe-d', holder: 'silas-pipeline' });

    const report = h.service.reconcileAtBoot();
    expect(report).toEqual({ examined: 2, adopted: 1, requeued: 1 });
    expect(h.service.entry('pipe-c')?.state).toBe('admitted');
    expect(h.service.entry('pipe-d')?.state).toBe('waiting');
    h.capacity = { capacity: 4, occupied: 2, queued: 0, available: 2 };
    h.service.schedule();
    await h.service.whenIdle();
    expect(h.calls.map((call) => call.jobId)).toEqual(['pipe-a', 'pipe-b', 'pipe-d']);
    expect(h.service.entry('pipe-d')?.state).toBe('admitted');
    h.db.close();
  });
});

describe('pipeline service — live recovery (Perkins r1 blockers 3-5)', () => {
  it('reconciles an admitting claim with no in-flight dispatch in a LIVE pass (no restart needed)', async () => {
    const h = boot();
    h.service.enqueue({ id: 'pipe-a', repoPath: '/tmp/demo', title: 'A', briefing: 'A' });
    await h.service.whenIdle();
    expect(h.calls).toHaveLength(1);
    // Freeze capacity so the live service cannot race the hand-crafted
    // stuck claim (as if a claim-release write failed after dispatch).
    h.capacity = { capacity: 4, occupied: 4, queued: 0, available: 0 };
    h.ledger.enqueuePipelineEntry({ id: 'pipe-b', repoPath: '/tmp/demo', title: 'B', briefing: 'B' });
    expect(h.ledger.claimPipelineEntry({ id: 'pipe-b', holder: 'silas-pipeline' })?.state).toBe('admitting');
    // The next live pass reconciles the stale claim — no restart.
    h.capacity = { capacity: 4, occupied: 0, queued: 0, available: 4 };
    h.service.schedule();
    await h.service.whenIdle();
    expect(h.service.entry('pipe-b')?.state).toBe('admitted');
    expect(h.calls.map((call) => call.jobId)).toEqual(['pipe-a', 'pipe-b']);
    h.db.close();
  });

  it('live recovery ADOPTS a stale claim whose job already exists — never re-dispatches it', async () => {
    const h = boot();
    h.capacity = { capacity: 4, occupied: 4, queued: 0, available: 0 };
    h.ledger.enqueuePipelineEntry({ id: 'pipe-c', repoPath: '/tmp/demo', title: 'C', briefing: 'C' });
    h.ledger.claimPipelineEntry({ id: 'pipe-c', holder: 'silas-pipeline' });
    h.ledger.addJob({ id: 'pipe-c', repo: 'demo', title: 'C', briefing: 'C' });
    h.capacity = { capacity: 4, occupied: 0, queued: 0, available: 4 };
    h.service.schedule();
    await h.service.whenIdle();
    expect(h.service.entry('pipe-c')?.state).toBe('admitted');
    expect(h.calls).toHaveLength(0); // adopted, never dispatched
    h.db.close();
  });

  it('propagates a transient finalization failure through the bounded backoff, then adopts once bookkeeping heals', async () => {
    vi.useFakeTimers();
    try {
      const real = (() => {
        const dir = mkdtempSync(join(tmpdir(), 'gru-pipeline-service-b4a-'));
        cleanupDirs.push(dir);
        const db = new LedgerDb(dir);
        const bus = new EventBus({});
        return { db, bus, ledger: new LedgerApi(db.handle, { bus }) };
      })();
      let markCalls = 0;
      const flaky: LedgerApi = new Proxy(real.ledger, {
        get(target, property, receiver) {
          if (property === 'markPipelineAdmitted') {
            return (input: Parameters<LedgerApi['markPipelineAdmitted']>[0]) => {
              markCalls += 1;
              if (markCalls === 1) throw new Error('transient bookkeeping failure');
              return target.markPipelineAdmitted(input);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const h = boot(undefined, { retryBackoffMs: 5_000, ledger: flaky, bus: real.bus });
      h.service.enqueue({ id: 'pipe-a', repoPath: '/tmp/demo', title: 'A', briefing: 'A' });
      await h.service.whenIdle();
      // The dispatch side effect committed the job; finalization failed.
      // The port's own minion-spawned event is a genuine NATURAL trigger,
      // so the retry runs immediately (superseding the timer): the entry
      // is admitted exactly once, never left admitting, never duplicated.
      expect(h.service.entry('pipe-a')?.state).toBe('admitted');
      expect(markCalls).toBe(2);
      const jobs = h.ledger.listJobs().filter((job) => job.id === 'pipe-a');
      expect(jobs).toHaveLength(1);
      // No further work is owed: advancing time changes nothing.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(markCalls).toBe(2);
      expect(h.calls).toHaveLength(2);
      h.db.close();
      real.db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stands down a persistently failing finalization after the bounded attempts (no tight loop)', async () => {
    vi.useFakeTimers();
    try {
      const real = (() => {
        const dir = mkdtempSync(join(tmpdir(), 'gru-pipeline-service-b4b-'));
        cleanupDirs.push(dir);
        const db = new LedgerDb(dir);
        const bus = new EventBus({});
        return { db, bus, ledger: new LedgerApi(db.handle, { bus }) };
      })();
      let markCalls = 0;
      const broken: LedgerApi = new Proxy(real.ledger, {
        get(target, property, receiver) {
          if (property === 'markPipelineAdmitted') {
            return () => {
              markCalls += 1;
              throw new Error('persistent bookkeeping failure');
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const h = boot(undefined, { retryBackoffMs: 5_000, ledger: broken, bus: real.bus });
      h.service.enqueue({ id: 'pipe-a', repoPath: '/tmp/demo', title: 'A', briefing: 'A' });
      await h.service.whenIdle();
      // One immediate retry via the port's natural job event; the entry is
      // reconciled back to waiting, never left admitting.
      expect(markCalls).toBe(2);
      expect(h.service.entry('pipe-a')?.state).toBe('waiting');
      // Timed retries continue only while the bounded counter allows:
      // attempts stop after the fourth failed finalization (stand-down),
      // and NEVER spin.
      for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(5_000);
      expect(markCalls).toBe(4);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(markCalls).toBe(4);
      expect(h.service.entry('pipe-a')?.state).toBe('waiting');
      h.db.close();
      real.db.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('an intentional wake disarm never opens the refusal window — hold then clear-hold still admits on the real budget', async () => {
    const { ResidentBudget } = await import('../src/runtime/resident-budget.js');
    const budget = new ResidentBudget(1);
    const held = await budget.acquire(1); // the pool is full
    const h = boot(undefined, {
      budget: { acquire: (signal) => budget.acquire(1, signal) },
      capacityFn: () => ({
        capacity: budget.capacity,
        occupied: budget.occupied,
        queued: budget.queued,
        available: budget.capacity - budget.occupied,
      }),
    });
    h.service.enqueue({ id: 'pipe-a', repoPath: '/tmp/demo', title: 'A', briefing: 'A' });
    await h.service.whenIdle();
    expect(h.calls).toHaveLength(0);
    expect(budget.queued).toBe(1); // demand registered with the real budget
    // Hold the ONLY eligible entry: the pass disarms its wake acquire —
    // an intentional cancellation, not capacity feedback.
    h.service.hold('pipe-a', 'owner deciding');
    await h.service.whenIdle();
    expect(budget.queued).toBe(0);
    // Clear the hold while the pool is STILL full: demand must re-register
    // (a refusal-window bug would block this for 60 s).
    h.service.clearHold('pipe-a', 'approved');
    await h.service.whenIdle();
    expect(budget.queued).toBe(1);
    // Freeing the permit grants the queued demand; admission follows.
    held();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.service.whenIdle();
    expect(h.calls.map((call) => call.jobId)).toEqual(['pipe-a']);
    expect(h.service.entry('pipe-a')?.state).toBe('admitted');
    h.db.close();
  });
});
