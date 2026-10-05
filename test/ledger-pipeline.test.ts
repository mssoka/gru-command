import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, PipelineConflictError } from '../src/ledger/api.js';
import { LedgerDb, MIGRATIONS } from '../src/ledger/db.js';
import {
  evaluatePipelineEntry,
  pipelineBlockingReason,
  type PipelineCapacityView,
  type PipelineEntryRecord,
} from '../src/ledger/pipeline.js';

/**
 * Durable pipeline queue — ledger boundary: idempotent enqueue with
 * immutable briefs, atomic claims, prerequisite milestones/reasons,
 * holds/cancel, and the evaluated board projection.
 */

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length > 0) rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
});

function boot(): { db: LedgerDb; ledger: LedgerApi } {
  const dir = mkdtempSync(join(tmpdir(), 'gru-pipeline-ledger-'));
  cleanupDirs.push(dir);
  const db = new LedgerDb(dir);
  const ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
  return { db, ledger };
}

const FULL_CAPACITY: PipelineCapacityView = { capacity: 4, occupied: 0, queued: 0, available: 4 };

function enqueue(ledger: LedgerApi, id: string, overrides: Record<string, unknown> = {}): PipelineEntryRecord {
  return ledger.enqueuePipelineEntry({
    id,
    repoPath: '/tmp/demo',
    title: `Entry ${id}`,
    briefing: `Briefing for ${id}`,
    ...overrides,
  }).record;
}

function entryOf(ledger: LedgerApi, id: string): PipelineEntryRecord {
  const record = ledger.getPipelineEntry(id);
  if (record === null) throw new Error(`missing entry ${id}`);
  return record;
}

describe('pipeline ledger — enqueue identity and immutability', () => {
  it('persists a durable waiting entry with order, priority and hold, emitting one event', () => {
    const { db, ledger } = boot();
    const record = enqueue(ledger, 'pipe-a', { priority: 2 });
    expect(record.state).toBe('waiting');
    expect(record.priority).toBe(2);
    expect(record.enqueueSeq).toBe(1);
    expect(record.holdReason).toBeNull();
    expect(record.repo).toBe('demo');
    const second = enqueue(ledger, 'pipe-b');
    expect(second.enqueueSeq).toBe(2);
    expect(second.priority).toBe(5);
    const held = enqueue(ledger, 'pipe-c', { holdReason: 'owner is deciding' });
    expect(held.holdReason).toBe('owner is deciding');
    const events = ledger.listEvents({ limit: 10 }).filter((event) => event.kind === 'pipeline.enqueued');
    expect(events).toHaveLength(3);
    expect(ledger.listPipelineEntries().map((entry) => entry.id)).toEqual(['pipe-a', 'pipe-b', 'pipe-c']);
    db.close();
  });

  it('replays an identical request to the SAME durable row without a second entry or event', () => {
    const { db, ledger } = boot();
    const first = enqueue(ledger, 'pipe-a', { requestId: 'req-1' });
    const replay = ledger.enqueuePipelineEntry({
      id: 'pipe-a',
      requestId: 'req-1',
      repoPath: '/tmp/demo',
      title: 'Entry pipe-a',
      briefing: 'Briefing for pipe-a',
    });
    expect(replay.created).toBe(false);
    expect(replay.record.id).toBe(first.id);
    expect(ledger.listPipelineEntries()).toHaveLength(1);
    expect(ledger.listEvents({ limit: 10 }).filter((event) => event.kind === 'pipeline.enqueued')).toHaveLength(1);
    db.close();
  });

  it('refuses a changed replay, an occupied id/request pair and a job-id collision', () => {
    const { db, ledger } = boot();
    enqueue(ledger, 'pipe-a', { requestId: 'req-1' });
    expect(() =>
      ledger.enqueuePipelineEntry({
        id: 'pipe-a',
        requestId: 'req-1',
        repoPath: '/tmp/demo',
        title: 'Entry pipe-a',
        briefing: 'CHANGED BRIEFING',
      }),
    ).toThrow(PipelineConflictError);
    expect(() => enqueue(ledger, 'pipe-a', { requestId: 'req-2' })).toThrow(PipelineConflictError);
    ledger.addJob({ id: 'pipe-job', repo: 'demo', title: 'Existing job' });
    expect(() => enqueue(ledger, 'pipe-job')).toThrow(PipelineConflictError);
    expect(entryOf(ledger, 'pipe-a').briefing).toBe('Briefing for pipe-a');
    db.close();
  });

  it('allows a forward prerequisite but refuses a cycle and self-dependency', () => {
    const { db, ledger } = boot();
    // Forward references are allowed: a dependency may be enqueued later.
    enqueue(ledger, 'pipe-a', { prerequisites: [{ id: 'pipe-c', milestone: 'admitted' }] });
    enqueue(ledger, 'pipe-b', { prerequisites: [{ id: 'pipe-a', milestone: 'admitted' }] });
    // pipe-c waiting for pipe-b would close a cycle (a → c, b → a, c → b).
    expect(() =>
      ledger.enqueuePipelineEntry({
        id: 'pipe-c',
        repoPath: '/tmp/demo',
        title: 'Cycle',
        briefing: 'Cycle',
        prerequisites: [{ id: 'pipe-b', milestone: 'admitted' }],
      }),
    ).toThrow(PipelineConflictError);
    expect(() =>
      ledger.enqueuePipelineEntry({
        id: 'pipe-self',
        repoPath: '/tmp/demo',
        title: 'Self',
        briefing: 'Self',
        prerequisites: [{ id: 'pipe-self', milestone: 'admitted' }],
      }),
    ).toThrow(/cannot depend on itself/);
    db.close();
  });
});

describe('pipeline ledger — claims and admission', () => {
  it('claims atomically: one admitting claim, replays return null, holds refuse', () => {
    const { db, ledger } = boot();
    enqueue(ledger, 'pipe-a', { holdReason: 'hold first' });
    expect(ledger.claimPipelineEntry({ id: 'pipe-a', holder: 'silas' })).toBeNull();
    ledger.clearPipelineHold({ id: 'pipe-a' });
    const claimed = ledger.claimPipelineEntry({ id: 'pipe-a', holder: 'silas' });
    expect(claimed?.state).toBe('admitting');
    expect(claimed?.claim?.holder).toBe('silas');
    expect(ledger.claimPipelineEntry({ id: 'pipe-a', holder: 'silas' })).toBeNull();
    expect(() => ledger.cancelPipelineEntry({ id: 'pipe-a', reason: 'nope' })).toThrow(/live admission claim/);
    expect(() => ledger.holdPipelineEntry({ id: 'pipe-a', reason: 'nope' })).toThrow(/live admission claim/);
    db.close();
  });

  it('admits only against a job that carries the exact accepted briefing', () => {
    const { db, ledger } = boot();
    const entry = enqueue(ledger, 'pipe-a');
    ledger.claimPipelineEntry({ id: 'pipe-a', holder: 'silas' });
    expect(() => ledger.markPipelineAdmitted({ id: 'pipe-a', jobId: 'pipe-a' })).toThrow(/requires job/);
    ledger.addJob({ id: 'pipe-a', repo: 'demo', title: 'Entry pipe-a', briefing: 'different' });
    expect(() => ledger.markPipelineAdmitted({ id: 'pipe-a', jobId: 'pipe-a' })).toThrow(/different briefing/);
    ledger.setJobBriefing('pipe-a', entry.briefing);
    const admitted = ledger.markPipelineAdmitted({ id: 'pipe-a', jobId: 'pipe-a' });
    expect(admitted.state).toBe('admitted');
    expect(admitted.jobId).toBe('pipe-a');
    // Idempotent replay.
    expect(ledger.markPipelineAdmitted({ id: 'pipe-a', jobId: 'pipe-a' }).state).toBe('admitted');
    db.close();
  });

  it('release outcomes: requeue counts a failure, reconciled does not, failed is terminal', () => {
    const { db, ledger } = boot();
    enqueue(ledger, 'pipe-a');
    ledger.claimPipelineEntry({ id: 'pipe-a', holder: 'silas' });
    const requeued = ledger.releasePipelineClaim({
      id: 'pipe-a',
      reason: 'admission failed: boom',
      outcome: 'requeue',
      note: 'attempt 1/3',
    });
    expect(requeued.state).toBe('waiting');
    expect(requeued.failureCount).toBe(1);
    expect(requeued.failureReason).toContain('boom');
    expect(ledger.releasePipelineClaim({ id: 'pipe-a', reason: 'same', outcome: 'requeue' }).failureCount).toBe(1);
    ledger.claimPipelineEntry({ id: 'pipe-a', holder: 'silas' });
    const reconciled = ledger.releasePipelineClaim({
      id: 'pipe-a',
      reason: 'service restart during admission',
      outcome: 'reconciled',
      note: 'no evidence',
    });
    expect(reconciled.failureCount).toBe(1);
    expect(reconciled.reconcileNote).toBe('no evidence');
    ledger.claimPipelineEntry({ id: 'pipe-a', holder: 'silas' });
    const failed = ledger.releasePipelineClaim({ id: 'pipe-a', reason: 'admission failed: nope', outcome: 'failed' });
    expect(failed.state).toBe('failed');
    expect(failed.failureCount).toBe(2);
    expect(() => ledger.claimPipelineEntry({ id: 'pipe-a', holder: 'silas' })).not.toThrow();
    expect(ledger.claimPipelineEntry({ id: 'pipe-a', holder: 'silas' })).toBeNull();
    db.close();
  });

  it('cancels waiting work with a durable reason and refuses to resurrect it', () => {
    const { db, ledger } = boot();
    enqueue(ledger, 'pipe-a');
    const cancelled = ledger.cancelPipelineEntry({ id: 'pipe-a', reason: 'owner withdrew it', by: 'owner' });
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.failureReason).toBe('owner withdrew it');
    expect(cancelled.claim).toBeNull();
    expect(ledger.cancelPipelineEntry({ id: 'pipe-a', reason: 'again' }).state).toBe('cancelled');
    // Admitted work is owned by its job lifecycle — no queue cancellation.
    enqueue(ledger, 'pipe-b');
    ledger.claimPipelineEntry({ id: 'pipe-b', holder: 'silas' });
    ledger.addJob({ id: 'pipe-b', repo: 'demo', title: 'Entry pipe-b', briefing: 'Briefing for pipe-b' });
    ledger.markPipelineAdmitted({ id: 'pipe-b', jobId: 'pipe-b' });
    expect(() => ledger.cancelPipelineEntry({ id: 'pipe-b', reason: 'too late' })).toThrow(/admitted/);
    db.close();
  });
});

describe('pipeline ledger — evaluation, order and projection', () => {
  it('orders the projection by priority, durable sequence, then stable id', () => {
    const { db, ledger } = boot();
    enqueue(ledger, 'pipe-b', { priority: 3 });
    enqueue(ledger, 'pipe-a', { priority: 3 });
    enqueue(ledger, 'pipe-c', { priority: 1 });
    const view = ledger.pipelineBoardView(FULL_CAPACITY);
    expect(view.entries.map((entry) => entry.id)).toEqual(['pipe-c', 'pipe-b', 'pipe-a']);
    expect(view.pending).toBe(3);
    expect(view.entries[0]?.state).toBe('ready');
    expect(view.entries[0]?.reason).toBeNull();
    db.close();
  });

  it('explains holds, missing/failed prerequisites, unmet milestones and cycles', () => {
    const { db, ledger } = boot();
    enqueue(ledger, 'pipe-hold', { holdReason: 'owner deciding' });
    enqueue(ledger, 'pipe-missing', { prerequisites: [{ id: 'pipe-ghost', milestone: 'merged' }] });
    enqueue(ledger, 'pipe-dep', { prerequisites: [{ id: 'pipe-dead', milestone: 'admitted' }] });
    enqueue(ledger, 'pipe-dead');
    ledger.cancelPipelineEntry({ id: 'pipe-dead', reason: 'withdrawn' });
    enqueue(ledger, 'pipe-unmet', { prerequisites: [{ id: 'pipe-dep', milestone: 'delivered' }] });
    // Hand-crafted cycle (the API refuses to create one; a pre-existing
    // ledger row must still be explained and never executed).
    db.handle
      .prepare(
        `INSERT INTO pipeline_entries
           (id, repo_path, repo, title, briefing, briefing_hash, priority, enqueue_seq, state,
            prerequisites, exclusive_scopes, request_id, payload_hash, failure_count, queued_at, updated_at)
         VALUES (?, '/tmp/demo', 'demo', 'Cyclic A', 'a', 'h', 5, 100, 'waiting', ?, '[]', 'req-cyc-a', 'p', 0, ?, ?)`,
      )
      .run('pipe-cyc-a', JSON.stringify([{ id: 'pipe-cyc-b', milestone: 'admitted' }]), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    db.handle
      .prepare(
        `INSERT INTO pipeline_entries
           (id, repo_path, repo, title, briefing, briefing_hash, priority, enqueue_seq, state,
            prerequisites, exclusive_scopes, request_id, payload_hash, failure_count, queued_at, updated_at)
         VALUES (?, '/tmp/demo', 'demo', 'Cyclic B', 'b', 'h', 5, 101, 'waiting', ?, '[]', 'req-cyc-b', 'p', 0, ?, ?)`,
      )
      .run('pipe-cyc-b', JSON.stringify([{ id: 'pipe-cyc-a', milestone: 'admitted' }]), '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    const view = ledger.pipelineBoardView(FULL_CAPACITY);
    const reasonOf = (id: string): string | null => view.entries.find((entry) => entry.id === id)?.reason ?? null;
    expect(reasonOf('pipe-hold')).toBe('owner hold: owner deciding');
    expect(reasonOf('pipe-missing')).toBe('waiting for pipe-ghost — not enqueued');
    expect(reasonOf('pipe-dep')).toBe('prerequisite pipe-dead cancelled');
    expect(reasonOf('pipe-unmet')).toBe('waiting for pipe-dep to be delivered (now waiting)');
    expect(reasonOf('pipe-cyc-a')).toContain('dependency cycle');
    expect(reasonOf('pipe-cyc-a')).toContain('pipe-cyc-a');
    db.close();
  });

  it('resolves milestones admitted/delivered/merged/done and never invents one', () => {
    const { db, ledger } = boot();
    enqueue(ledger, 'pipe-a');
    enqueue(ledger, 'pipe-b', { prerequisites: [{ id: 'pipe-a', milestone: 'delivered' }] });
    enqueue(ledger, 'pipe-c', { prerequisites: [{ id: 'pipe-a', milestone: 'done' }] });
    const ready = (id: string): boolean =>
      ledger.pipelineBoardView(FULL_CAPACITY).entries.find((entry) => entry.id === id)?.reason === null;
    expect(ready('pipe-b')).toBe(false);
    // The milestone is read from the ADMITTED prerequisite's job — not
    // from a same-id row that no admission ever bound.
    ledger.claimPipelineEntry({ id: 'pipe-a', holder: 'silas' });
    ledger.addJob({ id: 'pipe-a', repo: 'demo', title: 'Entry pipe-a', briefing: 'Briefing for pipe-a' });
    ledger.markPipelineAdmitted({ id: 'pipe-a', jobId: 'pipe-a' });
    ledger.setJobStatus('pipe-a', 'working');
    ledger.setJobStatus('pipe-a', 'delivered');
    // The delivered milestone needs DURABLE delivery proof, not status
    // alone: without a recorded job.delivered event the dependent stays
    // waiting (status-only transitions never release dependents).
    expect(ready('pipe-b')).toBe(false);
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'pipe-a', payload: {} });
    expect(ready('pipe-b')).toBe(true); // delivered milestone satisfied
    expect(ready('pipe-c')).toBe(false); // done is NOT merged/other
    ledger.setJobStatus('pipe-a', 'in-review');
    expect(ready('pipe-b')).toBe(true);
    ledger.setJobStatus('pipe-a', 'merged');
    expect(ready('pipe-b')).toBe(true);
    expect(ready('pipe-c')).toBe(false);
    db.close();
  });

  it('never releases an admitted milestone without durable worker-start evidence', () => {
    const { db, ledger } = boot();
    enqueue(ledger, 'pipe-a');
    enqueue(ledger, 'pipe-b', { prerequisites: [{ id: 'pipe-a', milestone: 'admitted' }] });
    const blocked = (): string | null =>
      ledger.pipelineBoardView(FULL_CAPACITY).entries.find((entry) => entry.id === 'pipe-b')?.reason ?? null;
    // A dispatch that committed the job row but never started a worker
    // (no agent row, no minion-spawned event) is adopted per the approved
    // matrix — but its admitted milestone cannot release a dependent
    // until worker evidence exists.
    ledger.claimPipelineEntry({ id: 'pipe-a', holder: 'silas' });
    ledger.addJob({ id: 'pipe-a', repo: 'demo', title: 'Entry pipe-a', briefing: 'Briefing for pipe-a' });
    ledger.markPipelineAdmitted({ id: 'pipe-a', jobId: 'pipe-a' });
    expect(blocked()).toContain('waiting for pipe-a to be admitted');
    // The failed-spawn trap (Perkins r1 blocker 1): real dispatch creates
    // the worktree BEFORE spawning and retains it as swept when the spawn
    // fails — a worktree row is NOT worker-start evidence.
    ledger.registerWorktree({
      id: 'lane-pipe-a',
      kind: 'job',
      repoPath: '/tmp/demo',
      repoName: 'demo',
      path: '/tmp/demo-lane',
      sha: '0'.repeat(40),
      jobId: 'pipe-a',
    });
    ledger.setWorktreeStatus('lane-pipe-a', 'swept', 'spawn failed');
    expect(blocked()).toContain('waiting for pipe-a to be admitted');
    // A registered worker agent (dispatch registers it only after a
    // successful spawn) is real evidence and releases the dependent.
    ledger.registerAgent({ id: 'minion_pipe_a', role: 'minion', sessionFile: null, jobId: 'pipe-a', parentage: 'top-level' });
    expect(blocked()).toBeNull();
    db.close();
  });

  it('serializes shared exclusive scopes while a claim or live job holds one', () => {
    const { db, ledger } = boot();
    enqueue(ledger, 'pipe-a', { exclusiveScopes: ['repo:demo'] });
    enqueue(ledger, 'pipe-b', { exclusiveScopes: ['repo:demo'] });
    enqueue(ledger, 'pipe-c');
    const view = (): ReturnType<LedgerApi['pipelineBoardView']> => ledger.pipelineBoardView(FULL_CAPACITY);
    // Waiting entries hold nothing; the CLAIM (and the live job after it)
    // is what serializes the shared scope.
    ledger.claimPipelineEntry({ id: 'pipe-a', holder: 'silas' });
    expect(view().entries.find((entry) => entry.id === 'pipe-b')?.reason).toContain(
      'exclusive scope "repo:demo" held by pipe-a',
    );
    expect(view().entries.find((entry) => entry.id === 'pipe-c')?.reason).toBeNull();
    ledger.addJob({ id: 'pipe-a', repo: 'demo', title: 'Entry pipe-a', briefing: 'Briefing for pipe-a' });
    ledger.markPipelineAdmitted({ id: 'pipe-a', jobId: 'pipe-a' });
    expect(view().entries.find((entry) => entry.id === 'pipe-b')?.reason).toContain('held by pipe-a');
    ledger.setJobStatus('pipe-a', 'working');
    ledger.setJobStatus('pipe-a', 'delivered');
    ledger.setJobStatus('pipe-a', 'in-review');
    ledger.setJobStatus('pipe-a', 'merged');
    expect(view().entries.find((entry) => entry.id === 'pipe-b')?.reason).toBeNull();
    db.close();
  });

  it('excludes admitted and cancelled entries from the projection (no double count)', () => {
    const { db, ledger } = boot();
    enqueue(ledger, 'pipe-a');
    enqueue(ledger, 'pipe-b');
    enqueue(ledger, 'pipe-c');
    ledger.claimPipelineEntry({ id: 'pipe-a', holder: 'silas' });
    ledger.addJob({ id: 'pipe-a', repo: 'demo', title: 'Entry pipe-a', briefing: 'Briefing for pipe-a' });
    ledger.markPipelineAdmitted({ id: 'pipe-a', jobId: 'pipe-a' });
    ledger.cancelPipelineEntry({ id: 'pipe-c', reason: 'withdrawn' });
    const view = ledger.pipelineBoardView(FULL_CAPACITY);
    expect(view.entries.map((entry) => entry.id)).toEqual(['pipe-b']);
    expect(view.pending).toBe(1);
    db.close();
  });

  it('shows the honest capacity wait through the shared-budget numbers', () => {
    const { db, ledger } = boot();
    enqueue(ledger, 'pipe-a');
    const blocked = ledger.pipelineBoardView({ capacity: 4, occupied: 4, queued: 0, available: 0 });
    expect(blocked.entries[0]?.state).toBe('ready');
    expect(blocked.entries[0]?.reason).toBe('waiting for a resident worker slot (4/4 busy)');
    // Queued-ahead is NOT capacity exhaustion: slots are free, an older
    // resident admission simply owns the turn — the reason says so.
    const queuedAhead = ledger.pipelineBoardView({ capacity: 4, occupied: 1, queued: 1, available: 3 });
    expect(queuedAhead.entries[0]?.reason).toBe('waiting behind 1 older resident admission in the shared queue');
    const queuedAheadMany = ledger.pipelineBoardView({ capacity: 4, occupied: 1, queued: 2, available: 3 });
    expect(queuedAheadMany.entries[0]?.reason).toBe('waiting behind 2 older resident admissions in the shared queue');
    expect(ledger.pipelineBoardView(FULL_CAPACITY).entries[0]?.reason).toBeNull();
    db.close();
  });

  it('keeps durable order and idempotency across a reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-pipeline-reopen-'));
    cleanupDirs.push(dir);
    const db = new LedgerDb(dir);
    const ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
    enqueue(ledger, 'pipe-a', { priority: 4 });
    enqueue(ledger, 'pipe-b', { priority: 4, prerequisites: [{ id: 'pipe-a', milestone: 'admitted' }] });
    db.close();
    const db2 = new LedgerDb(dir);
    const ledger2 = new LedgerApi(db2.handle, { bus: new EventBus({}) });
    expect(ledger2.listPipelineEntries().map((entry) => [entry.id, entry.enqueueSeq])).toEqual([
      ['pipe-a', 1],
      ['pipe-b', 2],
    ]);
    const replay = ledger2.enqueuePipelineEntry({
      id: 'pipe-a',
      repoPath: '/tmp/demo',
      title: 'Entry pipe-a',
      briefing: 'Briefing for pipe-a',
      priority: 4,
    });
    expect(replay.created).toBe(false);
    enqueue(ledger2, 'pipe-c');
    expect(entryOf(ledger2, 'pipe-c').enqueueSeq).toBe(3);
    db2.close();
  });

  it('evaluates pure blocking reasons without a capacity context (service use)', () => {
    const { db, ledger } = boot();
    const entry = enqueue(ledger, 'pipe-a', { prerequisites: [{ id: 'pipe-b', milestone: 'merged' }] });
    const reason = pipelineBlockingReason(entry, {
      entries: [entry],
      jobStatusOf: () => null,
      jobDeliveredOf: () => false,
      jobStartedOf: () => false,
      capacity: FULL_CAPACITY,
    });
    expect(reason).toBe('waiting for pipe-b — not enqueued');
    const evaluation = evaluatePipelineEntry(entry, {
      entries: [entry],
      jobStatusOf: () => null,
      jobDeliveredOf: () => false,
      jobStartedOf: () => false,
      capacity: { capacity: 1, occupied: 1, queued: 0, available: 0 },
    });
    expect(evaluation.state).toBe('waiting');
    db.close();
  });

  it('applies the pipeline migration over an existing v13 ledger without touching old rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-pipeline-upgrade-'));
    cleanupDirs.push(dir);
    // A ledger frozen at the pre-pipeline schema (the shape an existing
    // installation boots with).
    const db13 = new LedgerDb(dir, { migrations: MIGRATIONS.slice(0, 13) });
    const ledger13 = new LedgerApi(db13.handle, { bus: new EventBus({}) });
    ledger13.addJob({ id: 'legacy-job', repo: 'demo', title: 'Legacy', briefing: 'old brief' });
    db13.close();

    // Reboot with the full migration set: 14–16 (main's landed
    // job-amendments/child-workers migrations) and the renumbered 17
    // pipeline migration apply, old rows survive, and the queue is
    // immediately usable.
    const dbFull = new LedgerDb(dir);
    const ledgerFull = new LedgerApi(dbFull.handle, { bus: new EventBus({}) });
    expect(ledgerFull.getJob('legacy-job')?.briefing).toBe('old brief');
    enqueue(ledgerFull, 'pipe-new');
    expect(ledgerFull.listPipelineEntries().map((entry) => entry.id)).toEqual(['pipe-new']);
    const applied = dbFull.handle.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: number }[];
    expect(applied.map((row) => row.id)).toEqual(Array.from({ length: MIGRATIONS.length }, (_, index) => index + 1));
    dbFull.close();
  });
});
