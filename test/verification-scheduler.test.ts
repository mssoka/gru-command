import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  VerificationDisposedError,
  VerificationLockTimeoutError,
  VerificationScheduler,
  pidAlive,
  verificationEnvironment,
  type VerificationProgress,
  type VerificationRecord,
} from '../src/verify/scheduler.js';

/**
 * The verification scheduler (contention fix, 2026-09-22): one global test
 * budget across lanes. These tests drive the lease primitives directly
 * (deterministic exclusivity/FIFO) and `run()` end-to-end (real child
 * processes, real env enforcement) against tiny budgets.
 */

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

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

  it('starts idempotently and keeps the holder file inside the instance storage dir', async () => {
    const { scheduler, storageDir } = makeScheduler();
    scheduler.start();
    scheduler.start();
    const lease = await scheduler.acquire(spec('job-a'));
    scheduler.release(lease);
    expect(existsSync(join(storageDir, 'scheduler.json'))).toBe(true);
  });
});
