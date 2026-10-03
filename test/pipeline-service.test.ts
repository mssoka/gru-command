import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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

function boot(capacity: PipelineCapacityView = { capacity: 4, occupied: 0, queued: 0, available: 4 }): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gru-pipeline-service-'));
  cleanupDirs.push(dir);
  const db = new LedgerDb(dir);
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
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
      return { settled: Promise.resolve() };
    },
  };
  const service = new PipelineService({
    ledger,
    dispatch: port,
    capacity: () => ({ ...harness.capacity }),
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

  it('requeues a failure with no job, bounded, then lands failed with one machine card', async () => {
    const h = boot();
    h.mode = 'throw-before-job';
    h.service.enqueue({ id: 'pipe-a', repoPath: '/tmp/demo', title: 'A', briefing: 'A' });
    await h.service.whenIdle();
    const entry = h.service.entry('pipe-a');
    expect(entry?.state).toBe('failed');
    expect(entry?.failureCount).toBe(3);
    expect(h.calls).toHaveLength(3);
    const cards = h.ledger.listNotifications().filter((row) => row.kind === 'pipeline.admission-failed');
    expect(cards).toHaveLength(1);
    expect(cards[0]?.routing).toBe('action-required');
    h.db.close();
  });

  it('adopts an interrupted claim whose job exists and requeues one whose job does not', async () => {
    const h = boot();
    h.service.enqueue({ id: 'pipe-a', repoPath: '/tmp/demo', title: 'A', briefing: 'A' });
    h.service.enqueue({ id: 'pipe-b', repoPath: '/tmp/demo', title: 'B', briefing: 'B' });
    await h.service.whenIdle();
    expect(h.calls).toHaveLength(2);
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
    await h.service.whenIdle();
    expect(h.calls.map((call) => call.jobId)).toEqual(['pipe-a', 'pipe-b', 'pipe-d']);
    expect(h.service.entry('pipe-d')?.state).toBe('admitted');
    h.db.close();
  });
});
