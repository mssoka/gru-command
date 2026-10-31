import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  VerificationDisposedError,
  VerificationDuplicateError,
  VerificationLockTimeoutError,
  VerificationRequestConflictError,
  VerificationRequestExpiredError,
  VerificationScheduler,
  pidAlive,
  verificationEnvironment,
  type VerificationProgress,
  type VerificationRecord,
} from '../src/verify/scheduler.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { LedgerDb } from '../src/ledger/db.js';
import { LedgerApi } from '../src/ledger/api.js';
import { EventBus } from '../src/events/bus.js';
import { laneIsBusy } from '../src/dispatch/branch-idle.js';

/**
 * The verification scheduler (contention fix, 2026-09-22): one global test
 * budget across lanes. These tests drive the lease primitives directly
 * (deterministic exclusivity/FIFO) and `run()` end-to-end (real child
 * processes, real env enforcement) against tiny budgets.
 */

const dirs: string[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => {
  while (repos.length > 0) repos.pop()!.cleanup();
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A real fixture repo: the spawn-time exact-head check reads its true HEAD. */
function makeRepo(): FixtureRepo {
  const repo = makeFixtureRepo('verify-scheduler-fixture');
  repos.push(repo);
  return repo;
}

/** A submission against a fixture repo with its real, current head by default. */
function repoSpec(
  repo: FixtureRepo,
  jobId: string,
  overrides: Partial<Parameters<VerificationScheduler['submit']>[0]> = {},
): Parameters<VerificationScheduler['submit']>[0] {
  return {
    jobId,
    scope: 'full',
    command: 'node -e "process.exit(0)"',
    cwd: repo.path,
    head: repo.head(),
    ...overrides,
  };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-verify-scheduler-'));
  dirs.push(dir);
  return dir;
}

interface Harness {
  scheduler: VerificationScheduler;
  records: VerificationRecord[];
  storageDir: string;
}

function makeScheduler(opts: {
  maxConcurrent?: number;
  workerBudget?: number;
  lockWaitTimeoutMs?: number;
  runTimeoutMs?: number;
  staleMaxAgeMs?: number;
} = {}): Harness {
  const storageDir = join(tempDir(), 'verify');
  const records: VerificationRecord[] = [];
  const scheduler = new VerificationScheduler({
    storageDir,
    limits: {
      maxConcurrent: opts.maxConcurrent ?? 1,
      workerBudget: opts.workerBudget ?? 8,
      lockWaitTimeoutMs: opts.lockWaitTimeoutMs ?? 5_000,
      runTimeoutMs: opts.runTimeoutMs ?? 20_000,
    },
    record: (record) => records.push(record),
    sweepIntervalMs: 20,
    killGraceMs: 100,
    disposeGraceMs: 500,
    ...(opts.staleMaxAgeMs === undefined ? {} : { staleMaxAgeMs: opts.staleMaxAgeMs }),
  });
  return { scheduler, records, storageDir };
}

function spec(jobId: string, command = 'node -e "process.exit(0)"'): Parameters<VerificationScheduler['run']>[0] {
  return { jobId, scope: 'full', command, cwd: process.cwd() };
}

/** A spec with an explicit head so single-flight keys are deterministic. */
function headedSpec(
  jobId: string,
  head: string,
  command = 'node -e "process.exit(0)"',
  requestId?: string,
): Parameters<VerificationScheduler['submit']>[0] {
  return {
    jobId,
    scope: 'full',
    command,
    cwd: process.cwd(),
    head,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** A pid that has already exited is dead (spawn+wait removes the guesswork). */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid!;
  await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  return pid;
}

function seedPersistedSlot(storageDir: string, slot: Record<string, unknown>): void {
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(join(storageDir, 'scheduler.json'), `${JSON.stringify({ version: 1, slots: [slot] })}\n`);
}

/** Persist one completed request record (with its outcome payload) verbatim. */
function seedPersistedAttempt(storageDir: string, attempt: Record<string, unknown>): void {
  mkdirSync(storageDir, { recursive: true });
  writeFileSync(
    join(storageDir, 'scheduler.json'),
    `${JSON.stringify({ version: 1, slots: [], attempts: [attempt] })}\n`,
  );
}

/** A completed persisted attempt whose outcome payload the caller supplies. */
function completedAttempt(
  requestId: string,
  cwd: string,
  outcome: Record<string, unknown>,
): Record<string, unknown> {
  return {
    request_id: requestId,
    run_id: `run-${requestId}`,
    job_id: 'job-checks',
    scope: 'docs',
    command: 'npm run build && npm run config:docs',
    cwd,
    head: 'a'.repeat(40),
    tracked_dirty: false,
    started: true,
    state: 'completed',
    completed_at: 1,
    error: null,
    outcome: {
      scope: 'docs',
      command: 'npm run build && npm run config:docs',
      cwd,
      ok: true,
      exitCode: 0,
      timedOut: false,
      queuedMs: 3,
      durationMs: 15,
      workers: 2,
      outputBytes: 7,
      outputSha256: 'b'.repeat(64),
      outputTail: 'step ok',
      error: null,
      ...outcome,
    },
  };
}

function loadedScheduler(storageDir: string): VerificationScheduler {
  const scheduler = new VerificationScheduler({
    storageDir,
    limits: { maxConcurrent: 1, workerBudget: 4, lockWaitTimeoutMs: 5_000, runTimeoutMs: 20_000 },
    sweepIntervalMs: 20,
  });
  scheduler.start();
  return scheduler;
}

describe('verification scheduler — global budget', () => {
  it('grants the budget immediately, queues past it, and releases FIFO', async () => {
    const { scheduler } = makeScheduler({ maxConcurrent: 1 });
    scheduler.start();
    const order: string[] = [];
    const first = await scheduler.acquire(spec('job-a'));
    order.push('a');
    let secondGranted = false;
    const second = scheduler.acquire(spec('job-b')).then((lease) => {
      secondGranted = true;
      order.push('b');
      return lease;
    });
    let thirdGranted = false;
    const third = scheduler.acquire(spec('job-c')).then((lease) => {
      thirdGranted = true;
      order.push('c');
      return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(secondGranted).toBe(false);
    expect(thirdGranted).toBe(false);
    expect(scheduler.queuedCount()).toBe(2);
    scheduler.release(first);
    const secondLease = await second;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(thirdGranted).toBe(false);
    scheduler.release(secondLease);
    const thirdLease = await third;
    expect(order).toEqual(['a', 'b', 'c']);
    scheduler.release(thirdLease);
    expect(scheduler.activeCount()).toBe(0);
  });

  it('view() reports lock/queue/budget counters for the board health row', async () => {
    const { scheduler } = makeScheduler({ maxConcurrent: 1, workerBudget: 8 });
    scheduler.start();
    expect(scheduler.view()).toEqual({
      lockInUse: false,
      activeRuns: 0,
      queuedRuns: 0,
      workerBudget: 8,
      workersPerRun: 8,
    });
    const lease = await scheduler.acquire(spec('job-a'));
    const queued = scheduler.acquire(spec('job-b'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scheduler.view()).toEqual({
      lockInUse: true,
      activeRuns: 1,
      queuedRuns: 1,
      workerBudget: 8,
      workersPerRun: 8,
    });
    scheduler.release(lease);
    scheduler.release(await queued);
    expect(scheduler.view()).toMatchObject({ lockInUse: false, activeRuns: 0, queuedRuns: 0 });
  });

  it('never grants two runs from racing requests (atomic claim under an async sink)', async () => {
    const { scheduler } = makeScheduler({ maxConcurrent: 1 });
    scheduler.start();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const sink = async (): Promise<void> => {
      await gate;
    };
    // Both callers pass the budget check before either queued frame settles.
    const first = scheduler.acquire(spec('job-a'), sink);
    const second = scheduler.acquire(spec('job-b'), sink);
    open();
    const firstLease = await first;
    let secondGranted = false;
    void second.then(() => {
      secondGranted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scheduler.activeCount()).toBe(1);
    expect(secondGranted).toBe(false);
    scheduler.release(firstLease);
    const secondLease = await second;
    scheduler.release(secondLease);
    expect(scheduler.activeCount()).toBe(0);
  });

  it('refuses a grant that raced dispose while the queued frame was in flight', async () => {
    const { scheduler } = makeScheduler();
    scheduler.start();
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = scheduler.acquire(spec('job-race'), async () => {
      entered();
      await gate;
    });
    await enteredGate;
    await scheduler.dispose();
    open();
    await expect(pending).rejects.toBeInstanceOf(VerificationDisposedError);
    expect(scheduler.activeCount()).toBe(0);
  });

  it('reentrant shutdown after native child spawn cannot mislabel a missing started frame as no-start', async () => {
    const repo = makeRepo(); const records: VerificationRecord[] = [];
    let disposal: Promise<void> | null = null;
    const scheduler = new VerificationScheduler({ storageDir: join(tempDir(), 'verify'),
      limits: { maxConcurrent: 1, workerBudget: 1, lockWaitTimeoutMs: 1000, runTimeoutMs: 5000 },
      record: (record) => records.push(record),
      onSpawn: () => { disposal = scheduler.dispose(); }, disposeGraceMs: 1000,
    });
    const outcome = await scheduler.submit(repoSpec(repo, 'spawned-job', { command: 'node -e "setTimeout(() => {}, 3000)"', requestId: 'spawned-before-shutdown' }));
    await disposal;
    expect(outcome.ok).toBe(false); expect(outcome.signal).toBe('SIGTERM');
    expect(records.filter((record) => record.kind === 'verification.no-start')).toEqual([]);
    expect(scheduler.attemptStatus({ requestId: 'spawned-before-shutdown' })).toMatchObject({ state: 'completed', started: true, runId: outcome.runId });
  });

  it('shutdown durably settles a queued original run as no-start across restart, without executing or losing its identity', async () => {
    const { scheduler, records, storageDir } = makeScheduler(); scheduler.start();
    const holder = await scheduler.acquire(spec('independent-holder'));
    const requestId = 'shutdown-never-started-request';
    const input = { ...spec('queued-job', 'node -e "process.exit(99)"'), requestId };
    const frames: VerificationProgress[] = [];
    let queued!: () => void; const queuedBoundary = new Promise<void>((resolve) => { queued = resolve; });
    const pending = scheduler.submit(input, (frame) => { frames.push(frame); if (frame.type === 'queued') queued(); });
    const rejected = expect(pending).rejects.toBeInstanceOf(VerificationDisposedError);
    await queuedBoundary;
    const requested = records.find((record) => record.kind === 'verification.requested')!;
    expect(frames[0]?.type).toBe('queued');
    await scheduler.dispose(); await rejected;
    const noStart = records.filter((record) => record.kind === 'verification.no-start');
    expect(noStart).toHaveLength(1); expect(noStart[0]?.payload).toMatchObject({ run_id: requested.payload['run_id'], request_ids: [requestId], started: false });
    expect(frames.some((frame) => frame.type === 'started' || frame.type === 'completed')).toBe(false);
    scheduler.release(holder);
    const resumed = new VerificationScheduler({ storageDir, limits: { maxConcurrent: 1, workerBudget: 1, lockWaitTimeoutMs: 1000, runTimeoutMs: 1000 } });
    resumed.start();
    try {
      expect(resumed.attemptStatus({ requestId })).toMatchObject({ state: 'admission-failed', runId: requested.payload['run_id'], started: false, error: { code: 'scheduler_disposed' } });
      await expect(resumed.submit(input, (frame) => { frames.push(frame); })).rejects.toBeInstanceOf(VerificationDisposedError);
      expect(resumed.inFlightCount()).toBe(0); expect(frames).toHaveLength(1);
    } finally { await resumed.dispose(); }
  });

  it('two attached queued identities retain original scheduler-disposed no-start settlement through persistent restart and independent replay', async () => {
    const dir = tempDir(); let db = new LedgerDb(dir); let ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
    ledger.addJob({ id: 'queued-job', repo: 'fixture', title: 'attached queued identities' }); ledger.setJobStatus('queued-job', 'working');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'queued-job', payload: { work_revision: 0 } });
    const repo = makeRepo(); let spawns = 0;
    const opts = { storageDir: join(dir, 'verify'), limits: { maxConcurrent: 1, workerBudget: 1, lockWaitTimeoutMs: 1000, runTimeoutMs: 1000 },
      onSpawn: () => { spawns += 1; }, record: (event: VerificationRecord) => {
        if (!ledger.hasJobEventWithPayloadValues(event.jobId, [event.kind], [{ key: 'run_id', value: String(event.payload['run_id']) }], 0)) ledger.appendCustomEvent(event);
      } };
    let scheduler = new VerificationScheduler(opts); scheduler.start();
    try {
      const held = await scheduler.acquire(spec('independent-holder'));
      let queued!: () => void; const boundary = new Promise<void>((resolve) => { queued = resolve; });
      const first = repoSpec(repo, 'queued-job', { requestId: 'attached-shutdown-first' });
      const second = { ...first, requestId: 'attached-shutdown-second' };
      const firstRun = scheduler.submit(first, (frame) => { if (frame.type === 'queued') queued(); });
      const firstRefused = expect(firstRun).rejects.toBeInstanceOf(VerificationDisposedError); await boundary;
      const secondRun = scheduler.submit(second); const secondRefused = expect(secondRun).rejects.toBeInstanceOf(VerificationDisposedError);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const original = ledger.latestJobEvent('queued-job', 'verification.requested')!;
      expect(scheduler.attemptStatus({ requestId: first.requestId })).toMatchObject({ runId: (original.payload as { run_id: string }).run_id, state: 'accepted', started: false });
      expect(scheduler.queuedCount()).toBe(1);
      expect(scheduler.attemptStatus({ requestId: second.requestId })).toMatchObject({ runId: (original.payload as { run_id: string }).run_id, state: 'accepted', started: false });
      await scheduler.dispose(); await Promise.all([firstRefused, secondRefused]); scheduler.release(held);
      const receipt = ledger.latestJobEvent('queued-job', 'verification.no-start')!;
      expect(receipt.payload).toMatchObject({ run_id: (original.payload as { run_id: string }).run_id, request_ids: [first.requestId, second.requestId], started: false });
      db.close(); db = new LedgerDb(dir); ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
      scheduler = new VerificationScheduler(opts); scheduler.start();
      for (const input of [first, second]) {
        expect(scheduler.attemptStatus({ requestId: input.requestId })).toMatchObject({ state: 'admission-failed', runId: (original.payload as { run_id: string }).run_id, started: false, error: { code: 'scheduler_disposed' } });
        await expect(scheduler.submit(input)).rejects.toBeInstanceOf(VerificationDisposedError);
      }
      expect(ledger.hasUnsettledVerificationRun('queued-job')).toBe(false); expect(laneIsBusy(ledger, ledger.getJob('queued-job')!)).toBe(false);
      expect(ledger.listJobEventsByKinds('queued-job', ['verification.no-start'])).toEqual([receipt]);
      expect(ledger.listJobEventsByKinds('queued-job', ['verification.started'])).toEqual([]); expect(spawns).toBe(0);
    } finally { await scheduler.dispose(); db.close(); }
  });

  async function assertNoStartRecovery(fault: 'pre-commit' | 'post-commit' | 'state-storage' | 'identity-storage', spawnFailed = false) {
    const dir = tempDir(); const db = new LedgerDb(dir); const ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
    ledger.addJob({ id: 'queued-job', repo: 'fixture', title: 'queued' }); ledger.setJobStatus('queued-job', 'working');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'queued-job', payload: { work_revision: 0 } });
    const repo = makeRepo(); const storageDir = join(dir, 'verify');
    let fail = true; let spawns = 0; const errors: string[] = [];
    const record = (event: VerificationRecord) => {
      if (event.kind === 'verification.no-start' && fail && fault === 'pre-commit') throw new Error('no-start publication refused');
      if (!ledger.hasJobEventWithPayloadValues(event.jobId, [event.kind], [{ key: 'run_id', value: String(event.payload['run_id']) }], 0)) ledger.appendCustomEvent(event);
      if (event.kind === 'verification.no-start' && fail && fault === 'post-commit') throw new Error('no-start committed then observer failed');
    };
    const opts = { storageDir, limits: { maxConcurrent: 1, workerBudget: 1, lockWaitTimeoutMs: 1000, runTimeoutMs: 1000 }, record, onSpawn: () => { spawns += 1; }, log: (_level: unknown, message: string) => { errors.push(message); } };
    const scheduler = new VerificationScheduler(opts); scheduler.start();
    const held = spawnFailed ? null : await scheduler.acquire(spec('holder'));
    let queued!: () => void; const boundary = new Promise<void>((resolve) => { queued = resolve; });
    const input = repoSpec(repo, 'queued-job', { requestId: 'original-no-start', ...(spawnFailed ? { cwd: join(dir, 'positively-missing-cwd'), head: null } : {}) });
    const pending = scheduler.submit(input, (frame) => { if (frame.type === 'queued') queued(); });
    const rejected = spawnFailed ? expect(pending).rejects.toThrow(/ENOENT/) : expect(pending).rejects.toBeInstanceOf(VerificationDisposedError); await boundary;
    const original = ledger.latestJobEvent('queued-job', 'verification.requested')!;
    expect(ledger.hasUnsettledVerificationRun('queued-job')).toBe(true); expect(laneIsBusy(ledger, ledger.getJob('queued-job')!)).toBe(true);
    if (fault === 'state-storage') { rmSync(join(storageDir, 'scheduler.json')); mkdirSync(join(storageDir, 'scheduler.json')); }
    if (fault === 'identity-storage') mkdirSync(join(storageDir, 'requests.ndjson'));
    if (spawnFailed) await rejected;
    await scheduler.dispose(); await rejected; if (held !== null) scheduler.release(held);
    if (fault === 'pre-commit' || fault === 'identity-storage') expect(ledger.hasUnsettledVerificationRun('queued-job')).toBe(true);
    if (fault === 'state-storage') rmSync(join(storageDir, 'scheduler.json'), { recursive: true });
    if (fault === 'identity-storage') rmSync(join(storageDir, 'requests.ndjson'), { recursive: true });
    fail = false;
    const resumed = new VerificationScheduler(opts); resumed.start();
    try {
      expect(resumed.attemptStatus({ requestId: 'original-no-start' })).toMatchObject({ state: 'admission-failed', runId: (original.payload as { run_id: string }).run_id, started: false, error: { code: spawnFailed ? 'spawn_failed' : 'scheduler_disposed' } });
      expect(ledger.hasUnsettledVerificationRun('queued-job')).toBe(false); expect(laneIsBusy(ledger, ledger.getJob('queued-job')!)).toBe(false);
      if (spawnFailed) await expect(resumed.submit(input)).rejects.toThrow(/ENOENT/);
      else await expect(resumed.submit(input)).rejects.toBeInstanceOf(VerificationDisposedError);
      expect(spawns).toBe(0); expect(ledger.listJobEventsByKinds('queued-job', ['verification.no-start'])).toHaveLength(1);
      ledger.appendCustomEvent({ kind: 'verification.requested', jobId: 'queued-job', payload: { run_id: 'unrelated-open' } });
      expect(ledger.hasUnsettledVerificationRun('queued-job')).toBe(true); expect(laneIsBusy(ledger, ledger.getJob('queued-job')!)).toBe(true);
      expect(errors.length).toBeGreaterThan(0);
    } finally { await resumed.dispose(); db.close(); }
  }
  it('PR334 anonymous (request-id-less) no-start refusal survives a failed publication and restart', async () => {
    const dir = tempDir(); const db = new LedgerDb(dir); const ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
    ledger.addJob({ id: 'queued-job', repo: 'fixture', title: 'queued' }); ledger.setJobStatus('queued-job', 'working');
    ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'queued-job', payload: { work_revision: 0 } });
    const repo = makeRepo(); const storageDir = join(dir, 'verify'); let fail = true;
    const record = (event: VerificationRecord) => {
      if (event.kind === 'verification.no-start' && fail) throw new Error('no-start publication refused');
      if (!ledger.hasJobEventWithPayloadValues(event.jobId, [event.kind], [{ key: 'run_id', value: String(event.payload['run_id']) }], 0)) ledger.appendCustomEvent(event);
    };
    const opts = { storageDir, limits: { maxConcurrent: 1, workerBudget: 1, lockWaitTimeoutMs: 1000, runTimeoutMs: 1000 }, record, log: () => {} };
    const scheduler = new VerificationScheduler(opts); scheduler.start();
    const held = await scheduler.acquire(spec('holder'));
    let queued!: () => void; const boundary = new Promise<void>((resolve) => { queued = resolve; });
    const pending = scheduler.submit(repoSpec(repo, 'queued-job'), (frame) => { if (frame.type === 'queued') queued(); });
    const rejected = expect(pending).rejects.toBeInstanceOf(VerificationDisposedError); await boundary;
    expect(ledger.hasUnsettledVerificationRun('queued-job')).toBe(true);
    await scheduler.dispose(); await rejected; scheduler.release(held);
    expect(ledger.hasUnsettledVerificationRun('queued-job')).toBe(true);
    fail = false;
    const resumed = new VerificationScheduler(opts); resumed.start();
    try {
      expect(ledger.hasUnsettledVerificationRun('queued-job')).toBe(false);
      expect(ledger.listJobEventsByKinds('queued-job', ['verification.no-start'])).toHaveLength(1);
    } finally { await resumed.dispose(); db.close(); }
  });

  it('PR334 shutdown during terminal delivery of a childless head-change outcome keeps that outcome', async () => {
    const { scheduler, records } = makeScheduler();
    scheduler.start();
    const repo = makeRepo();
    let atCompleted!: () => void; const reached = new Promise<void>((resolve) => { atCompleted = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const staleHead = 'a'.repeat(40);
    const running = scheduler.submit(repoSpec(repo, 'job-head', { head: staleHead, requestId: 'pr334-head-change' }), async (frame) => {
      if (frame.type === 'completed') { atCompleted(); await gate; }
    });
    await reached;
    const disposing = scheduler.dispose();
    release();
    const outcome = await running; await disposing;
    expect(outcome.error).toMatch(/head_changed/);
    expect(records.filter((record) => record.kind === 'verification.no-start')).toEqual([]);
    expect(scheduler.attemptStatus({ requestId: 'pr334-head-change' })).toMatchObject({ state: 'completed' });
  });

  it('PR334 startup retry of a refused no-start never persists an emptied live-holder map', async () => {
    const storageDir = join(tempDir(), 'verify'); const repo = makeRepo();
    const limits = { maxConcurrent: 1, workerBudget: 1, lockWaitTimeoutMs: 1000, runTimeoutMs: 1000 };
    const records: VerificationRecord[] = [];
    const first = new VerificationScheduler({ storageDir, limits, record: (event) => { records.push(event); if (event.kind === 'verification.no-start') throw new Error('refused'); }, log: () => {} });
    first.start();
    const held = await first.acquire(spec('holder'));
    const queued = first.submit(repoSpec(repo, 'queued-job', { requestId: 'pr334-startup-holders' }), () => {});
    const refused = expect(queued).rejects.toBeInstanceOf(VerificationDisposedError);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await first.dispose(); await refused; first.release(held);
    // The disposed scheduler's holder is a live orphan on disk; a restarted
    // scheduler whose publication keeps failing must not erase it.
    const persistedPath = join(storageDir, 'scheduler.json');
    const written = JSON.parse(readFileSync(persistedPath, 'utf-8')) as { slots: { run_id: string; pid: number }[] };
    written.slots = [{ run_id: held.runId, job_id: 'holder', scope: 'full', command: 'x', cwd: process.cwd(), head: null, pid: process.pid, granted_at: Date.now(), request_ids: [] } as never];
    writeFileSync(persistedPath, JSON.stringify(written));
    const writes: string[] = [];
    const resumed = new VerificationScheduler({ storageDir, limits, record: () => { writes.push(readFileSync(persistedPath, 'utf-8')); throw new Error('still refused'); }, log: () => {} });
    try {
      resumed.start();
      expect(writes.length).toBeGreaterThan(0);
      for (const snapshot of writes) expect((JSON.parse(snapshot) as { slots: unknown[] }).slots).toHaveLength(1);
    } finally { await resumed.dispose(); }
  });

  it('retries original no-start pre-commit failure on persisted restart and releases only its ledger lane fence', () => assertNoStartRecovery('pre-commit'));
  it('retries original no-start post-commit failure on persisted restart and releases only its ledger lane fence', () => assertNoStartRecovery('post-commit'));
  it('retries original no-start state-storage failure on persisted restart and releases only its ledger lane fence', () => assertNoStartRecovery('state-storage'));
  it('retries original no-start identity-storage failure on persisted restart and releases only its ledger lane fence', () => assertNoStartRecovery('identity-storage'));

  it('P41 childless spawn retries pre-commit failure with original spawn-failed identity', () => assertNoStartRecovery('pre-commit', true));
  it('P41 childless spawn retries post-commit failure with original spawn-failed identity', () => assertNoStartRecovery('post-commit', true));
  it('P41 childless spawn retries state-storage failure with original spawn-failed identity', () => assertNoStartRecovery('state-storage', true));
  it('P41 childless spawn retries identity-storage failure with original spawn-failed identity', () => assertNoStartRecovery('identity-storage', true));

  it('P41 genuine attached childless history-only restart restores exact original IDs and refuses command replay', async () => {
    const storageDir = join(tempDir(), 'verify'); const restoredDir = join(tempDir(), 'history-only'); const cwd = join(tempDir(), 'missing-original-cwd');
    const records: VerificationRecord[] = []; const frames: VerificationProgress[] = []; let spawns = 0; let release!: () => void; let observed!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; }); const queued = new Promise<void>((resolve) => { observed = resolve; });
    const limits = { maxConcurrent: 1, workerBudget: 1, lockWaitTimeoutMs: 5000, runTimeoutMs: 5000 };
    const first = new VerificationScheduler({ storageDir, limits, onSpawn: () => { spawns += 1; }, record: (record) => { records.push(record); if (record.kind === 'verification.no-start') throw new Error('original no-start publication unavailable'); } });
    const input = { jobId: 'P41-history-only', requestId: 'history-first', scope: 'full', cwd, head: null, command: 'printf forbidden-replay > replayed' };
    try {
      const a = first.submit(input, async (frame) => { frames.push(frame); if (frame.type === 'queued') { observed(); await hold; } }); const refusedA = expect(a).rejects.toThrow(/ENOENT/); await queued;
      const b = first.submit({ ...input, requestId: 'history-attached' }, (frame) => { frames.push(frame); }); const refusedB = expect(b).rejects.toThrow(/ENOENT/);
      const accepted = [first.attemptStatus({ requestId: input.requestId }), first.attemptStatus({ requestId: 'history-attached' })];
      expect(accepted[0]!.runId).toBe(accepted[1]!.runId);
      for (const status of accepted) { expect(status).toMatchObject({ started: false }); expect(status!.error).toBeUndefined(); }
      const originalObservations = structuredClone(records); release(); await Promise.all([refusedA, refusedB]); await first.dispose();
      expect(records.slice(0, originalObservations.length)).toEqual(originalObservations); expect(spawns).toBe(0); expect(frames.some((frame) => frame.type === 'started')).toBe(false);
      const original = records.find((record) => record.kind === 'verification.no-start')!;
      expect(original.payload).toMatchObject({ run_id: accepted[0]!.runId, request_ids: ['history-first', 'history-attached'], reason: 'spawn_failed', started: false, command: input.command, cwd, head: null });
      const originalBytes = readFileSync(join(storageDir, 'scheduler.json'), 'utf8');
      // A compatibility snapshot carries only genuine original refusal history.
      // Its original append-only index and accepted observations remain untouched.
      mkdirSync(restoredDir, { recursive: true }); writeFileSync(join(restoredDir, 'scheduler.json'), originalBytes); mkdirSync(cwd, { recursive: true });
      const published: VerificationRecord[] = [];
      const restored = new VerificationScheduler({ storageDir: restoredDir, limits, onSpawn: () => { spawns += 1; }, record: (record) => { published.push(record); } }); restored.start();
      try {
        expect(published.filter((record) => record.kind === 'verification.no-start')).toEqual([original]);
        for (const requestId of ['history-first', 'history-attached']) { expect(restored.attemptStatus({ requestId })).toMatchObject({ state: 'admission-failed', runId: original.payload['run_id'], started: false, error: { code: 'spawn_failed' } }); await expect(restored.submit({ ...input, requestId })).rejects.toThrow(/ENOENT/); }
        expect(spawns).toBe(0); expect(existsSync(join(cwd, 'replayed'))).toBe(false); expect(published).toEqual([original]);
        expect(readFileSync(join(storageDir, 'scheduler.json'), 'utf8')).toBe(originalBytes);
      } finally { await restored.dispose(); }
    } finally { release(); await first.dispose(); }
  });

  it('P41 attached childless identities and reentrant publication shutdown retain no-start without spawned hooks', async () => {
    const storageDir = join(tempDir(), 'verify'); const cwd = join(tempDir(), 'missing');
    let release!: () => void; let queued!: () => void; const hold = new Promise<void>((resolve) => { release = resolve; }); const observed = new Promise<void>((resolve) => { queued = resolve; });
    const records: VerificationRecord[] = []; let shutdown: Promise<void> | undefined; let spawns = 0;
    const scheduler = new VerificationScheduler({ storageDir, limits: { maxConcurrent: 1, workerBudget: 1, lockWaitTimeoutMs: 5000, runTimeoutMs: 5000 },
      onSpawn: () => { spawns += 1; }, record: (record) => { records.push(record); if (record.kind === 'verification.no-start') shutdown = scheduler.dispose(); } });
    const input = { jobId: 'P41-attached', scope: 'full', cwd, head: null, command: 'printf never-started', requestId: 'P41-first' };
    try {
      const first = scheduler.submit(input, async (frame) => { if (frame.type === 'queued') { queued(); await hold; } }); const refusedFirst = expect(first).rejects.toThrow(/ENOENT/); await observed;
      const second = scheduler.submit({ ...input, requestId: 'P41-second' }); const refusedSecond = expect(second).rejects.toThrow(/ENOENT/);
      release(); await Promise.all([refusedFirst, refusedSecond]); await shutdown;
      expect(spawns).toBe(0); expect(records.filter((record) => record.kind === 'verification.started')).toHaveLength(0);
      const receipts = records.filter((record) => record.kind === 'verification.no-start'); expect(receipts).toHaveLength(1);
      expect(receipts[0]!.payload).toMatchObject({ request_ids: ['P41-first', 'P41-second'], started: false, reason: 'spawn_failed' });
      const reopened = new VerificationScheduler({ storageDir, limits: { maxConcurrent: 1, workerBudget: 1, lockWaitTimeoutMs: 5000, runTimeoutMs: 5000 } });
      reopened.start();
      try { for (const requestId of ['P41-first', 'P41-second']) { expect(reopened.attemptStatus({ requestId })).toMatchObject({ started: false, error: { code: 'spawn_failed' } }); await expect(reopened.submit({ ...input, requestId })).rejects.toThrow(/ENOENT/); } }
      finally { await reopened.dispose(); }
    } finally { release(); await scheduler.dispose(); await shutdown; }
  });

  it('childless failures keep the request history within its bound, in memory and persisted; the durable index still answers every one (#363 S09-1-05)', async () => {
    const storageDir = join(tempDir(), 'verify'); const cwd = join(tempDir(), 'missing');
    const scheduler = new VerificationScheduler({ storageDir, limits: { maxConcurrent: 1, workerBudget: 1, lockWaitTimeoutMs: 5000, runTimeoutMs: 5000 } });
    try {
      for (let index = 0; index < 70; index += 1) {
        await expect(scheduler.submit({ jobId: 'bounded-history', requestId: `no-start-${String(index)}`, scope: 'full', cwd, head: null, command: 'true' })).rejects.toThrow(/ENOENT/);
      }
      expect((scheduler as unknown as { requestHistory: Map<string, unknown> }).requestHistory.size).toBeLessThanOrEqual(64);
      const persisted = JSON.parse(readFileSync(join(storageDir, 'scheduler.json'), 'utf8')) as { attempts?: readonly unknown[] };
      expect(persisted.attempts?.length ?? 0).toBeLessThanOrEqual(64);
      // The newest is still in memory; the oldest, evicted, answers from the durable index.
      for (const requestId of ['no-start-69', 'no-start-0']) {
        expect(scheduler.attemptStatus({ requestId }), requestId).toMatchObject({ state: 'admission-failed', started: false });
      }
    } finally { await scheduler.dispose(); }
  });

  it('a no-start whose publication is still pending keeps answering and still publishes once it can, while the history stays bounded (#363 S09-1-05)', async () => {
    const storageDir = join(tempDir(), 'verify'); const cwd = join(tempDir(), 'missing');
    let holdHeld = true;
    const published: string[] = [];
    const scheduler = new VerificationScheduler({ storageDir, limits: { maxConcurrent: 1, workerBudget: 1, lockWaitTimeoutMs: 5000, runTimeoutMs: 5000 },
      record: (record) => {
        const ids = record.kind === 'verification.no-start' ? (record.payload as { request_ids: string[] }).request_ids : [];
        if (holdHeld && ids.includes('held')) throw new Error('publication unavailable');
        published.push(...ids);
      } });
    try {
      await expect(scheduler.submit({ jobId: 'bounded-history', requestId: 'held', scope: 'full', cwd, head: null, command: 'true' })).rejects.toThrow(/ENOENT/);
      const history = (scheduler as unknown as { requestHistory: Map<string, unknown> }).requestHistory;
      for (let index = 0; index < 70; index += 1) {
        await expect(scheduler.submit({ jobId: 'bounded-history', requestId: `later-${String(index)}`, scope: 'full', cwd, head: null, command: 'true' })).rejects.toThrow(/ENOENT/);
        expect(history.size).toBeLessThanOrEqual(64);
        // Still answered while unpublished (memory or the durable index): never unknown, so never replayed.
        expect(scheduler.attemptStatus({ requestId: 'held' }), String(index)).toMatchObject({ state: 'admission-failed', started: false });
      }
      expect(published).not.toContain('held');
      holdHeld = false;
      await expect(scheduler.submit({ jobId: 'bounded-history', requestId: 'final', scope: 'full', cwd, head: null, command: 'true' })).rejects.toThrow(/ENOENT/);
      expect(published).toContain('held');
      expect(history.size).toBeLessThanOrEqual(64);
    } finally { await scheduler.dispose(); }
  });

  it('an indexed no-start still pending publication is evicted like any other, and a retry pass that publishes nothing keeps the bound (#363 S09-1-05)', async () => {
    const storageDir = join(tempDir(), 'verify'); const missing = join(tempDir(), 'missing'); const cwd = tempDir();
    const scheduler = new VerificationScheduler({ storageDir, limits: { maxConcurrent: 1, workerBudget: 1, lockWaitTimeoutMs: 5000, runTimeoutMs: 5000 }, buildReuse: false,
      record: (record) => {
        if (record.kind === 'verification.no-start' && (record.payload as { request_ids: string[] }).request_ids.includes('held')) throw new Error('publication unavailable');
      } });
    try {
      // Durably indexed, but its publication keeps failing: it stays pending.
      await expect(scheduler.submit({ jobId: 'indexed', requestId: 'held', scope: 'full', cwd: missing, head: null, command: 'true' })).rejects.toThrow(/ENOENT/);
      const history = (scheduler as unknown as { requestHistory: Map<string, unknown> }).requestHistory;
      for (let index = 0; index < 64; index += 1) {
        await scheduler.submit({ jobId: 'indexed', requestId: `ordinary-${String(index)}`, scope: 'full', cwd, head: null, command: 'true' });
      }
      // The index answers for it, so the bound evicted it.
      expect(history.size).toBe(64);
      expect(history.has('held')).toBe(false);
      expect(scheduler.attemptStatus({ requestId: 'held' })).toMatchObject({ state: 'admission-failed', started: false, error: { code: 'spawn_failed' } });
      // Its resubmit runs a retry pass that re-derives its entry and publishes nothing; the bound still holds.
      await expect(scheduler.submit({ jobId: 'indexed', requestId: 'held', scope: 'full', cwd: missing, head: null, command: 'true' })).rejects.toThrow(/ENOENT/);
      expect(history.has('held')).toBe(true);
      expect(history.size).toBe(64);
    } finally { await scheduler.dispose(); }
  });

  it('a no-start whose durable append failed is never evicted into unknown: it answers until a retry indexes it, then the bound holds again (#363 S09-1-05)', async () => {
    const storageDir = join(tempDir(), 'verify'); const missing = join(tempDir(), 'missing'); const cwd = tempDir();
    const scheduler = new VerificationScheduler({ storageDir, limits: { maxConcurrent: 1, workerBudget: 1, lockWaitTimeoutMs: 5000, runTimeoutMs: 5000 }, buildReuse: false, record: () => undefined });
    const requestLog = join(storageDir, 'requests.ndjson');
    try {
      scheduler.start();
      // The durable identity log cannot be written: the no-start stays pending, unindexed.
      mkdirSync(requestLog);
      await expect(scheduler.submit({ jobId: 'unindexed', requestId: 'held', scope: 'full', cwd: missing, head: null, command: 'true' })).rejects.toThrow(/ENOENT/);
      const history = (scheduler as unknown as { requestHistory: Map<string, unknown> }).requestHistory;
      // More ordinary settles than the bound holds; each bounds the history.
      for (let index = 0; index < 70; index += 1) {
        const outcome = await scheduler.submit({ jobId: 'unindexed', requestId: `ordinary-${String(index)}`, scope: 'full', cwd, head: null, command: 'true' });
        expect(outcome.exitCode).toBe(0);
        expect(scheduler.attemptStatus({ requestId: 'held' }), String(index)).toMatchObject({ state: 'admission-failed', started: false, error: { code: 'spawn_failed' } });
      }
      expect(history.size).toBe(64);
      expect(history.has('held')).toBe(true);
      // Once the log is writable again, the next retry indexes it and the bound evicts it like any other.
      rmSync(requestLog, { recursive: true });
      await expect(scheduler.submit({ jobId: 'unindexed', requestId: 'held', scope: 'full', cwd: missing, head: null, command: 'true' })).rejects.toThrow(/ENOENT/);
      expect(history.size).toBe(64);
      await scheduler.submit({ jobId: 'unindexed', requestId: 'ordinary-last', scope: 'full', cwd, head: null, command: 'true' });
      expect(history.size).toBe(64);
      expect(history.has('held')).toBe(false);
      expect(scheduler.attemptStatus({ requestId: 'held' })).toMatchObject({ state: 'admission-failed', started: false, error: { code: 'spawn_failed' } });
    } finally { await scheduler.dispose(); }
  });

  it('rejects a queued request parked on its queued frame when dispose runs', async () => {
    const { scheduler } = makeScheduler({ maxConcurrent: 1 });
    scheduler.start();
    await scheduler.acquire(spec('job-holder'));
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let entered!: () => void;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = scheduler.acquire(spec('job-waiter'), async () => {
      entered();
      await gate;
    });
    await enteredGate;
    await scheduler.dispose();
    open();
    await expect(pending).rejects.toBeInstanceOf(VerificationDisposedError);
    expect(scheduler.activeCount()).toBe(0);
  });

  it('fails a queued request LOUD when the lock wait times out, and records it', async () => {
    const { scheduler, records } = makeScheduler({ lockWaitTimeoutMs: 120 });
    scheduler.start();
    const held = await scheduler.acquire(spec('job-holder'));
    const started = Date.now();
    await expect(scheduler.acquire(spec('job-waiter'))).rejects.toBeInstanceOf(VerificationLockTimeoutError);
    expect(Date.now() - started).toBeLessThan(3_000);
    const timeout = records.find((record) => record.kind === 'verification.lock-timeout');
    expect(timeout).toBeDefined();
    expect(timeout?.jobId).toBe('job-waiter');
    expect(timeout?.payload['wait_ms']).toBeGreaterThanOrEqual(100);
    expect(scheduler.queuedCount()).toBe(0);
    scheduler.release(held);
  });

  it('releases a persisted holder whose pid is dead (stale-holder detection)', async () => {
    const { scheduler, records, storageDir } = makeScheduler();
    const dead = await deadPid();
    seedPersistedSlot(storageDir, {
      run_id: 'stale-run',
      pid: dead,
      job_id: 'job-stale',
      scope: 'full',
      command: 'npm test',
      cwd: '/tmp',
      granted_at: Date.now(),
    });
    scheduler.start();
    expect(scheduler.activeCount()).toBe(0);
    const released = records.find((record) => record.kind === 'verification.stale-released');
    expect(released?.payload).toMatchObject({ run_id: 'stale-run', pid: dead, reason: 'holder-dead' });
    // The freed slot is usable immediately.
    const lease = await scheduler.acquire(spec('job-next'));
    scheduler.release(lease);
  });

  it('ages out an alive-but-unowned holder instead of waiting forever', async () => {
    const { scheduler, records, storageDir } = makeScheduler({ staleMaxAgeMs: 100 });
    seedPersistedSlot(storageDir, {
      run_id: 'old-run',
      pid: process.pid, // alive on purpose — age is the only release proof
      job_id: 'job-old',
      scope: 'full',
      command: 'npm test',
      cwd: '/tmp',
      granted_at: Date.now() - 10_000,
    });
    scheduler.start();
    expect(scheduler.activeCount()).toBe(0);
    const released = records.find((record) => record.kind === 'verification.stale-released');
    expect(released?.payload).toMatchObject({ run_id: 'old-run', reason: 'max-age' });
  });

  it('releases a persisted holder that never recorded a runner pid (no-runner)', () => {
    const { scheduler, records, storageDir } = makeScheduler();
    seedPersistedSlot(storageDir, {
      run_id: 'no-runner-run',
      pid: null,
      job_id: 'job-no-runner',
      scope: 'full',
      command: 'npm test',
      cwd: '/tmp',
      granted_at: Date.now(),
    });
    scheduler.start();
    expect(scheduler.activeCount()).toBe(0);
    const released = records.find((record) => record.kind === 'verification.stale-released');
    expect(released?.payload).toMatchObject({ run_id: 'no-runner-run', pid: null, reason: 'no-runner' });
    // The freed slot is usable immediately.
    return scheduler.acquire(spec('job-next')).then((lease) => scheduler.release(lease));
  });

  it('dispose drops a granted-but-unspawned slot so the holder file heals on restart', async () => {
    const { scheduler, storageDir } = makeScheduler();
    scheduler.start();
    const lease = await scheduler.acquire(spec('job-granted'));
    expect(scheduler.activeCount()).toBe(1);
    await scheduler.dispose();
    const state = JSON.parse(readFileSync(join(storageDir, 'scheduler.json'), 'utf-8')) as {
      slots: readonly { run_id: string }[];
    };
    expect(state.slots.map((slot) => slot.run_id)).not.toContain(lease.runId);
    expect(state.slots).toEqual([]);
  });

  it('splits the worker budget across the concurrency limit and never below one', () => {
    expect(makeScheduler({ maxConcurrent: 2, workerBudget: 10 }).scheduler.workersPerRun).toBe(5);
    const clamped = makeScheduler({ maxConcurrent: 4, workerBudget: 2 }).scheduler;
    // The worker budget wins: fewer concurrent runs, never more workers.
    expect(clamped.concurrencyLimit).toBe(2);
    expect(clamped.workersPerRun).toBe(1);
    const auto = makeScheduler({ maxConcurrent: 1, workerBudget: 0 }).scheduler;
    expect(auto.budget).toBeGreaterThanOrEqual(1);
    expect(auto.workersPerRun).toBe(auto.budget);
  });

  it('enforces the worker count in the child environment and records a completed run', async () => {
    const { scheduler, records } = makeScheduler({ maxConcurrent: 2, workerBudget: 4 });
    scheduler.start();
    const frames: VerificationProgress[] = [];
    const outcome = await scheduler.run(
      spec(
        'job-budget',
        'node -e "console.log(process.env.VITEST_MAX_THREADS + \':\' + process.env.GRU_VERIFY_WORKERS + \':\' + process.env.VITEST_MAX_FORKS)"',
      ),
      (frame) => {
        frames.push(frame);
      },
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.workers).toBe(2);
    const output = frames
      .filter((frame): frame is Extract<VerificationProgress, { type: 'output' }> => frame.type === 'output')
      .map((frame) => frame.text)
      .join('');
    expect(output).toContain('2:2:2');
    expect(frames.map((frame) => frame.type)).toEqual(['queued', 'started', 'output', 'completed']);
    const completed = records.find((record) => record.kind === 'verification.completed');
    expect(completed?.payload).toMatchObject({ ok: true, exit_code: 0, workers: 2, scope: 'full' });
    expect(records.some((record) => record.kind === 'verification.started')).toBe(true);
    expect(outcome.outputSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('turns a non-zero exit into a recorded failed outcome, never a thrown error', async () => {
    const { scheduler, records } = makeScheduler();
    scheduler.start();
    const outcome = await scheduler.run(spec('job-fail', 'node -e "process.exit(7)"'));
    expect(outcome.ok).toBe(false);
    expect(outcome.exitCode).toBe(7);
    expect(outcome.timedOut).toBe(false);
    const completed = records.find((record) => record.kind === 'verification.completed');
    expect(completed?.payload).toMatchObject({ ok: false, exit_code: 7 });
    // The lock is free again after a failed run.
    expect(scheduler.activeCount()).toBe(0);
    const lease = await scheduler.acquire(spec('job-after'));
    scheduler.release(lease);
  });

  it('an output pipe a stray descendant still holds at the drain cut-off is closed by the runner, never a failed run (#523 verification repair)', async () => {
    // #523's guards scope went red on an exit-0 vitest step whose pipes were
    // still open 2s after the shell exited: the runner then destroyed its own
    // pipes and recorded the iteration's ERR_STREAM_PREMATURE_CLOSE as the
    // run's error. A background `sleep` inherits the step's stdout/stderr and
    // outlives its exit-0 shell, so this reproduces that window every time.
    const { scheduler, records } = makeScheduler();
    scheduler.start();
    const frames: VerificationProgress[] = [];
    const outcome = await scheduler.run(
      spec('job-stray-pipe', '/bin/sh -c "sleep 3 & exit 0"'),
      (frame) => { frames.push(frame); },
    );
    // The exit verdict stands: no manufactured run error, no failed step.
    expect(outcome.exitCode).toBe(0);
    expect(outcome.error).toBeNull();
    expect(outcome.ok).toBe(true);
    expect(outcome.timedOut).toBe(false);
    // The capture says what the runner did instead of hiding it.
    const output = frames
      .filter((frame): frame is Extract<VerificationProgress, { type: 'output' }> => frame.type === 'output')
      .map((frame) => frame.text)
      .join('');
    expect(output).toContain('output pipes were still open 2s after the step exited; the runner closed them (the exit verdict stands)');
    expect(records.find((record) => record.kind === 'verification.completed')?.payload).toMatchObject({ ok: true, exit_code: 0 });
    expect(scheduler.activeCount()).toBe(0);
  });

  it('kills the process group on run timeout and persists an emptied holder file', async () => {
    const { scheduler, storageDir } = makeScheduler({ runTimeoutMs: 250, lockWaitTimeoutMs: 500 });
    scheduler.start();
    const outcome = await scheduler.run(spec('job-hang', 'node -e "setTimeout(() => {}, 60000)"'));
    expect(outcome.timedOut).toBe(true);
    expect(outcome.ok).toBe(false);
    expect(outcome.durationMs).toBeLessThan(5_000);
    const state = JSON.parse(readFileSync(join(storageDir, 'scheduler.json'), 'utf-8')) as { slots: unknown[] };
    expect(state.slots).toEqual([]);
  });

  it('PR334 timeout escalation still SIGKILLs a TERM-resistant descendant after its shell exited', async () => {
    const { scheduler } = makeScheduler({ runTimeoutMs: 250, lockWaitTimeoutMs: 500 });
    scheduler.start();
    const pidFile = join(tempDir(), 'descendant.pid');
    const command = `trap 'exit 0' TERM; (trap '' TERM; exec /bin/sh -c 'echo $$ > ${pidFile}; exec sleep 600') >/dev/null 2>&1 & wait`;
    const outcome = await scheduler.run(spec('job-descendant', command));
    expect(outcome.timedOut).toBe(true);
    const descendant = Number(readFileSync(pidFile, 'utf-8').trim());
    try {
      await waitFor(() => !pidAlive(descendant), 3_000);
    } finally {
      try { process.kill(descendant, 'SIGKILL'); } catch { /* already gone */ }
    }
  });

  it('dispose terminates active runs and refuses new work', async () => {
    const { scheduler } = makeScheduler({ runTimeoutMs: 60_000 });
    scheduler.start();
    const frames: VerificationProgress[] = [];
    const running = scheduler.run(spec('job-long', 'node -e "setTimeout(() => {}, 60000)"'), (frame) => {
      frames.push(frame);
    });
    await waitFor(() => frames.some((frame) => frame.type === 'started'));
    await scheduler.dispose();
    const outcome = await running;
    expect(outcome.ok).toBe(false);
    await expect(scheduler.acquire(spec('job-after-dispose'))).rejects.toBeInstanceOf(VerificationDisposedError);
  });

  it('pins a valid environment shape and reports dead pids truthfully', async () => {
    const env = verificationEnvironment({ PATH: '/usr/bin' }, { runId: 'r1', jobId: 'j1', scope: 'full', workers: 3 });
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      VITEST_MAX_THREADS: '3',
      VITEST_MIN_THREADS: '3',
      VITEST_MAX_FORKS: '3',
      VITEST_MIN_FORKS: '3',
      GRU_VERIFY_RUN_ID: 'r1',
      GRU_VERIFY_JOB_ID: 'j1',
      GRU_VERIFY_SCOPE: 'full',
      GRU_VERIFY_WORKERS: '3',
    });
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(await deadPid())).toBe(false);
  });

  it('reports the spawned child (pid + argv) to onSpawn/onSettled so lane teardown can reap it', async () => {
    const storageDir = join(tempDir(), 'verify');
    const spawns: { pid: number | null; command: string }[] = [];
    const settled: { pid: number | null; command: string }[] = [];
    const scheduler = new VerificationScheduler({
      storageDir,
      limits: { maxConcurrent: 1, workerBudget: 2, lockWaitTimeoutMs: 5_000, runTimeoutMs: 20_000 },
      onSpawn: (info) => spawns.push({ pid: info.pid, command: info.command }),
      onSettled: (info) => settled.push({ pid: info.pid, command: info.command }),
      sweepIntervalMs: 20,
    });
    scheduler.start();
    const outcome = await scheduler.run(spec('job-track', 'node -e "process.exit(0)"'));
    expect(outcome.ok).toBe(true);
    expect(spawns).toHaveLength(1);
    const spawnedPid = spawns[0]?.pid;
    expect(spawnedPid).toBeTypeOf('number');
    expect(spawns[0]?.command).toContain('/bin/sh -c');
    expect(spawns[0]?.command).toContain('process.exit(0)');
    expect(settled).toHaveLength(1);
    expect(settled[0]?.pid).toBe(spawnedPid);
    expect(pidAlive(spawnedPid as number)).toBe(false); // settled means exited
  });

  it('single-flight: a simultaneous duplicate attaches to ONE producer, never a second execution', async () => {
    const repo = makeRepo();
    const { scheduler, records } = makeScheduler({ maxConcurrent: 2 });
    scheduler.start();
    const command = 'node -e "setTimeout(() => console.log(\'done\'), 250)"';
    const firstFrames: VerificationProgress[] = [];
    const secondFrames: VerificationProgress[] = [];
    const first = scheduler.submit(repoSpec(repo, 'job-dup', { command }), (frame) => {
      firstFrames.push(frame);
    });
    const second = scheduler.submit(repoSpec(repo, 'job-dup', { command }), (frame) => {
      secondFrames.push(frame);
    });
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    expect(secondOutcome.runId).toBe(firstOutcome.runId);
    expect(firstOutcome.ok).toBe(true);
    expect(secondFrames[0]?.type).toBe('attached');
    const attached = secondFrames[0] as Extract<VerificationProgress, { type: 'attached' }>;
    expect(attached.runId).toBe(firstOutcome.runId);
    expect(['queued', 'running']).toContain(attached.state);
    // The acknowledgement is private to the attacher: the existing stream
    // never receives another client's request identity.
    expect(firstFrames.some((frame) => frame.type === 'attached')).toBe(false);
    expect(records.filter((record) => record.kind === 'verification.started')).toHaveLength(1);
    expect(records.filter((record) => record.kind === 'verification.completed')).toHaveLength(1);
    expect(records.filter((record) => record.kind === 'verification.attached')).toHaveLength(1);
    expect(scheduler.inFlightCount()).toBe(0);
    expect(scheduler.activeCount()).toBe(0);
  });

  it('single-flight: an identical duplicate queued behind a held budget still attaches to ONE producer', async () => {
    const repo = makeRepo();
    const { scheduler, records } = makeScheduler({ maxConcurrent: 1 });
    scheduler.start();
    const holder = await scheduler.acquire(spec('job-holder-queue'));
    const command = 'node -e "process.exit(0)"';
    const first = scheduler.submit(repoSpec(repo, 'job-queued', { command }));
    const secondFrames: VerificationProgress[] = [];
    const second = scheduler.submit(repoSpec(repo, 'job-queued', { command }), (frame) => {
      secondFrames.push(frame);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scheduler.queuedCount()).toBe(1); // one queued producer; the duplicate attached
    scheduler.release(holder);
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    expect(secondOutcome.runId).toBe(firstOutcome.runId);
    expect(firstOutcome.ok).toBe(true);
    expect(secondFrames[0]?.type).toBe('attached');
    expect(records.filter((record) => record.kind === 'verification.started')).toHaveLength(1);
  });

  it('delivers a terminal frame to a duplicate that attaches during terminal delivery', async () => {
    const repo = makeRepo();
    const { scheduler } = makeScheduler({ maxConcurrent: 2 });
    scheduler.start();
    let releaseCompleted!: () => void;
    const completedGate = new Promise<void>((resolve) => {
      releaseCompleted = resolve;
    });
    let signalCompleted!: () => void;
    const completedSeen = new Promise<void>((resolve) => {
      signalCompleted = resolve;
    });
    const first = scheduler.submit(repoSpec(repo, 'job-late'), async (frame) => {
      if (frame.type === 'completed') {
        signalCompleted();
        await completedGate; // hold the terminal delivery in flight
      }
    });
    await completedSeen;
    const secondFrames: VerificationProgress[] = [];
    const second = scheduler.submit(repoSpec(repo, 'job-late'), (frame) => {
      secondFrames.push(frame);
    });
    releaseCompleted();
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    expect(secondOutcome.runId).toBe(firstOutcome.runId);
    expect(secondFrames[0]?.type).toBe('attached');
    expect(secondFrames[secondFrames.length - 1]?.type).toBe('completed');
    expect(secondFrames.filter((frame) => frame.type === 'completed')).toHaveLength(1);
  });

  it('single-flight: a request_id replay of a completed run reconciles the recorded outcome without a rerun', async () => {
    const repo = makeRepo();
    const { scheduler, records } = makeScheduler();
    scheduler.start();
    const specWithId = repoSpec(repo, 'job-replay', { requestId: 'req-replay-1' });
    const first = await scheduler.run(specWithId);
    expect(first.ok).toBe(true);
    const replayFrames: VerificationProgress[] = [];
    const replay = await scheduler.submit(specWithId, (frame) => {
      replayFrames.push(frame);
    });
    expect(replay.runId).toBe(first.runId);
    expect(replayFrames).toHaveLength(1);
    expect(replayFrames[0]).toMatchObject({ type: 'completed', reconciled: true, runId: first.runId });
    expect(records.filter((record) => record.kind === 'verification.started')).toHaveLength(1);
    expect(records.filter((record) => record.kind === 'verification.completed')).toHaveLength(1);
    expect(records.filter((record) => record.kind === 'verification.reconciled')).toHaveLength(1);
    // A completed FAILED run is likewise never rerun under the same id.
    const failedSpec = repoSpec(repo, 'job-replay', { command: 'node -e "process.exit(9)"' });
    const failed = await scheduler.run({ ...failedSpec, requestId: 'req-replay-2' });
    expect(failed.ok).toBe(false);
    const failedReplay = await scheduler.submit({ ...failedSpec, requestId: 'req-replay-2' });
    expect(failedReplay.runId).toBe(failed.runId);
    expect(records.filter((record) => record.kind === 'verification.completed')).toHaveLength(2);
  });

  it('binds an attached duplicate\'s request identity so IT can reconcile the shared outcome', async () => {
    const repo = makeRepo();
    const { scheduler } = makeScheduler({ maxConcurrent: 2 });
    scheduler.start();
    const command = 'node -e "setTimeout(() => process.exit(0), 300)"';
    const primary = scheduler.submit(repoSpec(repo, 'job-attach-id', { command }));
    const duplicate = scheduler.submit(
      repoSpec(repo, 'job-attach-id', { command, requestId: 'req-attach-own' }),
      () => {},
    );
    await waitFor(() => scheduler.attemptStatus({ requestId: 'req-attach-own' }).state === 'running');
    const [firstOutcome, secondOutcome] = await Promise.all([primary, duplicate]);
    expect(secondOutcome.runId).toBe(firstOutcome.runId);
    const status = scheduler.attemptStatus({ requestId: 'req-attach-own' });
    expect(status).toMatchObject({ state: 'completed', runId: firstOutcome.runId, started: true });
    expect(status.outcome?.outputSha256).toBe(firstOutcome.outputSha256);
  });

  it('refuses an in-flight request_id bound to a different job, and attaches through head drift', async () => {
    const repo = makeRepo();
    const { scheduler } = makeScheduler({ maxConcurrent: 1 });
    scheduler.start();
    const command = 'node -e "setTimeout(() => process.exit(0), 300)"';
    const first = scheduler.submit(repoSpec(repo, 'job-bound', { command, requestId: 'req-bound' }));
    const conflict = await scheduler
      .submit(repoSpec(repo, 'job-other', { command, requestId: 'req-bound' }))
      .catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(VerificationRequestConflictError);
    // Head drift while the accepted run is live: the same identity attaches
    // to the accepted execution instead of minting a second producer.
    const drifted = scheduler.submit(
      repoSpec(repo, 'job-bound', { command, head: 'f'.repeat(40), requestId: 'req-bound' }),
      () => {},
    );
    const [firstOutcome, secondOutcome] = await Promise.all([first, drifted]);
    expect(secondOutcome.runId).toBe(firstOutcome.runId);
    expect(firstOutcome.ok).toBe(true);
  });

  it('single-flight: a changed head or a fresh request_id is a NEW producer (no permanent suppression)', async () => {
    const repo = makeRepo();
    const { scheduler, records } = makeScheduler();
    scheduler.start();
    const first = await scheduler.run(repoSpec(repo, 'job-change', { requestId: 'req-head-a' }));
    const headB = repo.commitFile('moved.txt', 'moved\n');
    const changedHead = await scheduler.run(
      repoSpec(repo, 'job-change', { head: headB, requestId: 'req-head-a' }),
    ).catch((error: unknown) => error);
    expect(changedHead).toBeInstanceOf(VerificationRequestConflictError);
    const newHeadRun = await scheduler.run(
      repoSpec(repo, 'job-change', { head: headB, requestId: 'req-head-b' }),
    );
    expect(newHeadRun.runId).not.toBe(first.runId);
    expect(records.filter((record) => record.kind === 'verification.started')).toHaveLength(2);
    // A repaired lane mints a NEW request id: it runs, it does not replay.
    const repaired = await scheduler.run(
      repoSpec(repo, 'job-change', { head: headB, requestId: 'req-repair' }),
    );
    expect(repaired.ok).toBe(true);
    expect(records.filter((record) => record.kind === 'verification.started')).toHaveLength(3);
  });

  it('fails a queued run whose lane moved before spawn instead of verifying the new head', async () => {
    const repo = makeRepo();
    const { scheduler, records } = makeScheduler({ maxConcurrent: 1 });
    scheduler.start();
    const holder = await scheduler.acquire(spec('job-holder-drift'));
    const command = 'node -e "require(\'node:fs\').writeFileSync(\'spawned.txt\', \'x\')"';
    const queued = scheduler.submit(repoSpec(repo, 'job-drift', { command }));
    const moved = repo.commitFile('moved.txt', 'moved\n');
    scheduler.release(holder);
    const outcome = await queued;
    expect(outcome.ok).toBe(false);
    expect(String(outcome.error)).toContain('head_changed');
    expect(outcome.sha).toBe(moved);
    expect(existsSync(join(repo.path, 'spawned.txt'))).toBe(false);
    const completed = records.filter((record) => record.kind === 'verification.completed');
    expect(completed[0]?.payload).toMatchObject({ ok: false, sha: moved });
  });

  it('reconciles accepted/running/completed/dirty states by request identity', async () => {
    const repo = makeRepo();
    const head = repo.head();
    const { scheduler } = makeScheduler({ maxConcurrent: 2 });
    scheduler.start();
    expect(scheduler.attemptStatus({ requestId: 'req-unknown' }).state).toBe('unknown');
    const slow = 'node -e "setTimeout(() => {}, 800)"';
    const promise = scheduler.submit(repoSpec(repo, 'job-status', { command: slow, requestId: 'req-status' }));
    await waitFor(() => scheduler.attemptStatus({ requestId: 'req-status' }).state === 'running');
    expect(scheduler.attemptStatus({ requestId: 'req-status' })).toMatchObject({
      state: 'running',
      jobId: 'job-status',
      head,
      started: true,
    });
    // An EXPLICIT unknown identity never borrows another attempt's state
    // through the job fallback.
    expect(
      scheduler.attemptStatus({ requestId: 'req-other-unknown', jobId: 'job-status', head }).state,
    ).toBe('unknown');
    // By job/scope/head lookup, without the request id.
    expect(scheduler.attemptStatus({ jobId: 'job-status', scope: 'full', head }).state).toBe('running');
    const outcome = await promise;
    expect(outcome.ok).toBe(true);
    expect(scheduler.attemptStatus({ requestId: 'req-status' }).state).toBe('completed');
  });

  it('reconciles an accepted run across a fake-clock 15-minute outage without multiplying producers', async () => {
    const repo = makeRepo();
    const storageDir = join(tempDir(), 'verify');
    const records: VerificationRecord[] = [];
    let clock = 1_000_000;
    const scheduler = new VerificationScheduler({
      storageDir,
      now: () => clock,
      limits: { maxConcurrent: 1, workerBudget: 4, lockWaitTimeoutMs: 5_000, runTimeoutMs: 20_000 },
      record: (record) => records.push(record),
      sweepIntervalMs: 20,
    });
    scheduler.start();
    const command = 'node -e "setTimeout(() => process.exit(0), 400)"';
    const first = scheduler.submit(repoSpec(repo, 'job-outage', { command, requestId: 'req-outage' }));
    await waitFor(() => scheduler.attemptStatus({ requestId: 'req-outage' }).state === 'running');
    clock += 15 * 60 * 1000; // the approved outage window
    expect(scheduler.attemptStatus({ requestId: 'req-outage' })).toMatchObject({ state: 'running' });
    const secondFrames: VerificationProgress[] = [];
    const second = scheduler.submit(repoSpec(repo, 'job-outage', { command, requestId: 'req-outage' }), (frame) => {
      secondFrames.push(frame);
    });
    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);
    expect(secondOutcome.runId).toBe(firstOutcome.runId);
    expect(firstOutcome.ok).toBe(true);
    expect(secondFrames[0]?.type).toBe('attached');
    expect(records.filter((record) => record.kind === 'verification.started')).toHaveLength(1);
    await scheduler.dispose();
  });

  it('allows retrying a never-started admission failure under the SAME request_id', async () => {
    const repo = makeRepo();
    const { scheduler, records } = makeScheduler({ maxConcurrent: 1, lockWaitTimeoutMs: 120 });
    scheduler.start();
    const holder = await scheduler.acquire(spec('job-holder-admit'));
    const timedOut = await scheduler
      .submit(repoSpec(repo, 'job-admit', { requestId: 'req-admit' }))
      .catch((error: unknown) => error);
    expect(timedOut).toBeInstanceOf(VerificationLockTimeoutError);
    expect(scheduler.attemptStatus({ requestId: 'req-admit' })).toMatchObject({
      state: 'admission-failed',
      started: false,
    });
    scheduler.release(holder);
    const retried = await scheduler.submit(repoSpec(repo, 'job-admit', { requestId: 'req-admit' }));
    expect(retried.ok).toBe(true);
    expect(scheduler.attemptStatus({ requestId: 'req-admit' }).state).toBe('completed');
    const timeouts = records.filter((record) => record.kind === 'verification.lock-timeout');
    expect(timeouts[0]?.payload['request_id']).toBe('req-admit');
    // The pinned head travels with the timeout so Silas can resubmit at
    // exactly that revision (issue #163 review).
    expect(timeouts[0]?.payload['head']).toBe(repo.head());
  });

  it('never reruns an evicted terminal identity: status reports it and resubmission is refused', async () => {
    const storageDir = join(tempDir(), 'verify');
    mkdirSync(storageDir, { recursive: true });
    appendFileSync(
      join(storageDir, 'requests.ndjson'),
      `${JSON.stringify({
        request_id: 'req-evicted',
        run_id: 'old-run',
        state: 'completed',
        job_id: 'job-expired',
        scope: 'full',
        command: 'node -e "process.exit(0)"',
        cwd: '/tmp/old-lane',
        head: 'a'.repeat(40),
        started: true,
        completed_at: 1,
      })}\n`,
    );
    const scheduler = new VerificationScheduler({
      storageDir,
      limits: { maxConcurrent: 1, workerBudget: 4, lockWaitTimeoutMs: 5_000, runTimeoutMs: 20_000 },
      sweepIntervalMs: 20,
    });
    scheduler.start();
    const status = scheduler.attemptStatus({ requestId: 'req-evicted' });
    expect(status).toMatchObject({ state: 'completed', runId: 'old-run', started: true });
    expect(status.outcome).toBeUndefined();
    const resubmit = await scheduler
      .submit(headedSpec('job-expired', 'a'.repeat(40), undefined, 'req-evicted'))
      .catch((error: unknown) => error);
    expect(resubmit).toBeInstanceOf(VerificationRequestExpiredError);
    // A NEW identity is the sanctioned path for a re-verification.
    const fresh = await scheduler.run(spec('job-expired'));
    expect(fresh.ok).toBe(true);
    await scheduler.dispose();
  });

  it('marks a crash-interrupted orphan identity interrupted and refuses its replay', async () => {
    const storageDir = join(tempDir(), 'verify');
    const dead = await deadPid();
    seedPersistedSlot(storageDir, {
      run_id: 'interrupted-run',
      pid: dead,
      job_id: 'job-interrupted',
      scope: 'full',
      command: 'node -e "process.exit(0)"',
      cwd: process.cwd(),
      head: null,
      request_ids: ['req-interrupted'],
      granted_at: Date.now(),
    });
    const scheduler = new VerificationScheduler({
      storageDir,
      limits: { maxConcurrent: 1, workerBudget: 4, lockWaitTimeoutMs: 5_000, runTimeoutMs: 20_000 },
      sweepIntervalMs: 20,
    });
    scheduler.start();
    expect(scheduler.attemptStatus({ requestId: 'req-interrupted' })).toMatchObject({
      state: 'interrupted',
      runId: 'interrupted-run',
      started: true,
    });
    const resubmit = await scheduler
      .submit(headedSpec('job-interrupted', 'a'.repeat(40), undefined, 'req-interrupted'))
      .catch((error: unknown) => error);
    expect(resubmit).toBeInstanceOf(VerificationRequestExpiredError);
    await scheduler.dispose();
  });

  it('refuses to mint a producer over a restart orphan holder (typed duplicate)', async () => {
    const storageDir = join(tempDir(), 'verify');
    seedPersistedSlot(storageDir, {
      run_id: 'orphan-run',
      pid: process.pid, // alive: the runner may still be executing
      job_id: 'job-orphan',
      scope: 'full',
      command: 'node -e "process.exit(0)"',
      cwd: process.cwd(),
      head: 'a'.repeat(40),
      request_ids: ['req-orphan'],
      granted_at: Date.now(),
    });
    const records: VerificationRecord[] = [];
    const loaded = new VerificationScheduler({
      storageDir,
      limits: { maxConcurrent: 1, workerBudget: 4, lockWaitTimeoutMs: 150, runTimeoutMs: 20_000 },
      record: (record) => records.push(record),
      sweepIntervalMs: 20,
    });
    loaded.start();
    const duplicate = await loaded
      .submit(headedSpec('job-orphan', 'a'.repeat(40)))
      .catch((error: unknown) => error);
    expect(duplicate).toBeInstanceOf(VerificationDuplicateError);
    expect((duplicate as VerificationDuplicateError).runId).toBe('orphan-run');
    expect(records.filter((record) => record.kind === 'verification.started')).toHaveLength(0);
    expect(loaded.attemptStatus({ jobId: 'job-orphan', head: 'a'.repeat(40) })).toMatchObject({
      state: 'running',
      runId: 'orphan-run',
    });
    // Reconnect by request identity after a restart still names the run.
    expect(loaded.attemptStatus({ requestId: 'req-orphan' })).toMatchObject({
      state: 'running',
      runId: 'orphan-run',
    });
    // A DIFFERENT command is not the identical run: the orphan must not
    // masquerade as a duplicate. (It still holds the only slot, so the fresh
    // submission queues to its lock timeout.)
    const changedCommand = await loaded
      .submit(headedSpec('job-orphan', 'a'.repeat(40), 'node -e "process.exit(1)"'))
      .catch((error: unknown) => error);
    expect(changedCommand).toBeInstanceOf(VerificationLockTimeoutError);
    expect(changedCommand).not.toBeInstanceOf(VerificationDuplicateError);
    await loaded.dispose();
  });

  it('persists completed request identities across restart for reconnect reconciliation', async () => {
    const repo = makeRepo();
    const storageDir = join(tempDir(), 'verify');
    const make = (): VerificationScheduler =>
      new VerificationScheduler({
        storageDir,
        limits: { maxConcurrent: 1, workerBudget: 4, lockWaitTimeoutMs: 5_000, runTimeoutMs: 20_000 },
        sweepIntervalMs: 20,
      });
    const first = make();
    first.start();
    const outcome = await first.run(repoSpec(repo, 'job-restart', { requestId: 'req-restart' }));
    await first.dispose();
    const second = make();
    second.start();
    const status = second.attemptStatus({ requestId: 'req-restart' });
    expect(status.state).toBe('completed');
    expect(status.runId).toBe(outcome.runId);
    expect(status.outcome?.outputSha256).toBe(outcome.outputSha256);
    await second.dispose();
  });

  it('round-trips persisted per-step checks through a reload', async () => {
    const storageDir = join(tempDir(), 'verify');
    const cwd = tempDir();
    const checks = [
      {
        command: 'npm run build',
        status: 'reused',
        ran: false,
        exitCode: null,
        signal: null,
        durationMs: 0,
        reusedFromRunId: 'run-prior',
        reuseRefusal: null,
      },
      {
        command: 'npm run config:docs',
        status: 'passed',
        ran: true,
        exitCode: 0,
        signal: null,
        durationMs: 12,
        reusedFromRunId: null,
        reuseRefusal: null,
      },
    ];
    seedPersistedAttempt(storageDir, completedAttempt('req-checks', cwd, { checks }));
    const scheduler = loadedScheduler(storageDir);
    const status = scheduler.attemptStatus({ requestId: 'req-checks' });
    expect(status.state).toBe('completed');
    expect(status.runId).toBe('run-req-checks');
    expect(status.outcome?.checks).toEqual(checks);
    await scheduler.dispose();
  });

  it('drops a checks list with one malformed entry, keeping the outcome', async () => {
    const storageDir = join(tempDir(), 'verify');
    const cwd = tempDir();
    seedPersistedAttempt(
      storageDir,
      completedAttempt('req-bad-checks', cwd, {
        checks: [
          { command: 'npm run build', status: 'reused', ran: false, durationMs: 0 },
          { command: 7, status: 'passed', ran: true, durationMs: 1 },
        ],
      }),
    );
    const scheduler = loadedScheduler(storageDir);
    const status = scheduler.attemptStatus({ requestId: 'req-bad-checks' });
    expect(status.state).toBe('completed');
    expect(status.outcome?.command).toBe('npm run build && npm run config:docs');
    expect(status.outcome?.checks).toBeUndefined();
    await scheduler.dispose();
  });

  it('rejects a malformed request_id loud, before any admission', async () => {
    const { scheduler } = makeScheduler();
    scheduler.start();
    await expect(
      scheduler.submit(headedSpec('job-bad-id', 'a'.repeat(40), undefined, 'bad id!')),
    ).rejects.toThrow(/request_id/);
    expect(scheduler.inFlightCount()).toBe(0);
    expect(scheduler.activeCount()).toBe(0);
  });

  it('P41 positive real childless spawn retains exact no-start identity without start hooks frames or restart replay', async () => {
    const storageDir = join(tempDir(), 'verify'); const cwd = join(tempDir(), 'does-not-exist');
    const records: VerificationRecord[] = []; const frames: VerificationProgress[] = []; let spawns = 0;
    const make = () => new VerificationScheduler({ storageDir,
      limits: { maxConcurrent: 1, workerBudget: 4, lockWaitTimeoutMs: 5000, runTimeoutMs: 20000 },
      record: (record) => { if (!records.some((old) => old.kind === record.kind && old.payload['run_id'] === record.payload['run_id'])) records.push(record); },
      onSpawn: () => { spawns += 1; }, sweepIntervalMs: 20, disposeGraceMs: 500 });
    const spec = { jobId: 'P41-original-job', requestId: 'P41-original-request', scope: 'full', command: 'printf never-replayed', cwd, head: null };
    const first = make(); first.start();
    try {
      await expect(first.submit(spec, (frame) => { frames.push(frame); })).rejects.toThrow(/ENOENT/);
      expect(spawns).toBe(0); expect(frames.some((frame) => frame.type === 'started')).toBe(false);
      expect(records.some((record) => record.kind === 'verification.started')).toBe(false);
      const noStart = records.find((record) => record.kind === 'verification.no-start')!;
      expect(noStart).toBeDefined(); expect(noStart.payload).toMatchObject({ request_ids: ['P41-original-request'], cwd, command: spec.command, head: null, started: false, reason: 'spawn_failed' });
      const status = first.attemptStatus({ requestId: spec.requestId });
      expect(status).toMatchObject({ state: 'admission-failed', started: false, runId: noStart.payload['run_id'], cwd, head: null, error: { code: 'spawn_failed' } });
      await expect(first.submit(spec)).rejects.toThrow(/ENOENT/);
      await first.dispose();
      const second = make(); second.start();
      try {
        expect(second.attemptStatus({ requestId: spec.requestId })).toMatchObject({ started: false, runId: status.runId, error: { code: 'spawn_failed' } });
        await expect(second.submit(spec)).rejects.toThrow(/ENOENT/);
        expect(records.filter((record) => record.kind === 'verification.no-start')).toHaveLength(1); expect(spawns).toBe(0);
      } finally { await second.dispose(); }
    } finally { await first.dispose(); }
  });

  it('starts idempotently and keeps the holder file inside the instance storage dir', async () => {
    const { scheduler, storageDir } = makeScheduler();
    scheduler.start();
    scheduler.start();
    const lease = await scheduler.acquire(spec('job-a'));
    scheduler.release(lease);
    expect(existsSync(join(storageDir, 'scheduler.json'))).toBe(true);
  });
});
