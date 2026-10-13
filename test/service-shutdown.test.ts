import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  startServiceShutdown,
  type ServiceShutdownLogger,
  type ServiceShutdownState,
} from '../src/service-shutdown.js';
import { SHUTDOWN_FORCE_EXIT_MS } from '../src/shutdown-budget.js';
import { CESSATION_IDLE_TIMEOUT_MS } from '../src/runtime/pi-adapter.js';
import type { RuntimeRegistry } from '../src/runtime/registry.js';
import type { SessionStore } from '../src/sessions/store.js';
import type { LedgerDb } from '../src/ledger/db.js';
import type { ServiceHandle } from '../src/server.js';
import type { WaveRunner } from '../src/dispatch/perkins.js';

/**
 * Issue #341 / R3-2: the shutdown deadline and its re-arm must be EXECUTED, not
 * asserted from source text. These tests drive the actual production
 * orchestration (`startServiceShutdown`, the function `main.ts` invokes) with a
 * recording exit and a controlled clock, so moving the re-arm after the awaited
 * runtime teardown — or shrinking the guard below a single idle bound — fails
 * here instead of passing a string check.
 */

interface LogLine {
  readonly level: 'info' | 'error';
  readonly msg: string;
  readonly fields?: Record<string, unknown>;
}

function recordingLogger(): ServiceShutdownLogger & { readonly lines: LogLine[] } {
  const lines: LogLine[] = [];
  return {
    lines,
    info: (msg, fields) => { lines.push({ level: 'info', msg, ...(fields !== undefined ? { fields } : {}) }); },
    error: (msg, fields) => { lines.push({ level: 'error', msg, ...(fields !== undefined ? { fields } : {}) }); },
  };
}

interface RunResult {
  readonly lines: readonly LogLine[];
  readonly exits: readonly number[];
  readonly exited: Promise<number>;
  readonly forced: () => boolean;
}

/** Invoke the REAL shutdown orchestration with a recording exit seam. */
function runShutdown(state: ServiceShutdownState, opts: { signal?: string; exitCode?: number } = {}): RunResult {
  const logger = recordingLogger();
  const exits: number[] = [];
  let resolveExit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
  startServiceShutdown({
    signal: opts.signal ?? 'SIGTERM',
    exitCode: opts.exitCode ?? 0,
    logger,
    state,
    serviceStop: new AbortController(),
    exit: (code) => { exits.push(code); resolveExit(code); },
  });
  return {
    lines: logger.lines,
    exits,
    exited,
    forced: () => logger.lines.some((line) => line.msg === 'shutdown timeout — forcing exit'),
  };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function fakeStore(order: string[]): SessionStore {
  return {
    dispose: (): void => { order.push('store.dispose'); },
    persistSnapshot: (): void => { order.push('store.snapshot'); },
  } as unknown as SessionStore;
}

function fakeHandle(order: string[]): ServiceHandle {
  return { stop: async (): Promise<void> => { order.push('handle.stop'); } } as unknown as ServiceHandle;
}

describe('service shutdown orchestration (issue #341, R3-2 executable)', () => {
  it('does not preempt a handle that consumes its full five-second idle bound', async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const state: ServiceShutdownState = {
        registry: {
          dispose: async () => { order.push('registry.start'); await delay(CESSATION_IDLE_TIMEOUT_MS); order.push('registry.end'); },
        } as unknown as RuntimeRegistry,
        store: fakeStore(order),
        handle: fakeHandle(order),
      };
      const run = runShutdown(state);
      // The reconciled guard must outlast a single idle-proof bound, or the
      // guard's process.exit(1) fires while the (healthy, bounded) teardown is
      // still running.
      expect(SHUTDOWN_FORCE_EXIT_MS).toBeGreaterThan(CESSATION_IDLE_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(CESSATION_IDLE_TIMEOUT_MS - 1);
      expect(run.exits).toEqual([]); // a moment before the proof, still running
      await vi.advanceTimersByTimeAsync(1);
      await run.exited;
      expect(run.exits).toEqual([0]);
      expect(run.forced()).toBe(false);
      expect(order).toEqual(['registry.start', 'registry.end', 'store.dispose', 'store.snapshot', 'handle.stop']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes the runtime window so twelve seconds of earlier stages cannot consume the teardown budget', async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const state: ServiceShutdownState = {
        wave: {
          shutdown: async () => { order.push('wave.start'); await delay(12_000); order.push('wave.end'); },
        } as unknown as WaveRunner,
        registry: {
          dispose: async () => { order.push('registry.start'); await delay(CESSATION_IDLE_TIMEOUT_MS); order.push('registry.end'); },
        } as unknown as RuntimeRegistry,
        store: fakeStore(order),
        handle: fakeHandle(order),
      };
      const run = runShutdown(state);
      await vi.advanceTimersByTimeAsync(12_000);
      expect(order).toContain('wave.end');
      expect(order).not.toContain('registry.end');
      expect(run.exits).toEqual([]); // the initial guard has not fired
      // Teardown runs 12s..17s; only the re-armed (refreshed) window covers it.
      await vi.advanceTimersByTimeAsync(CESSATION_IDLE_TIMEOUT_MS);
      await run.exited;
      expect(run.exits).toEqual([0]);
      expect(run.forced()).toBe(false);
      expect(order.slice(-2)).toEqual(['store.snapshot', 'handle.stop']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still releases store resources and persists the snapshot after a disposal rejection', async () => {
    const order: string[] = [];
    const state: ServiceShutdownState = {
      registry: {
        dispose: async () => {
          order.push('registry.dispose');
          throw new AggregateError([new Error('agent-0: idle proof timed out')], 'disposal failed for 1 of 1 target(s)');
        },
      } as unknown as RuntimeRegistry,
      store: fakeStore(order),
      ledgerDb: { close: (): void => { order.push('ledger.close'); } } as unknown as LedgerDb,
      handle: fakeHandle(order),
    };
    const run = runShutdown(state);
    await run.exited;
    expect(run.exits).toEqual([0]);
    expect(run.forced()).toBe(false);
    // The registry failure must never skip lock/store release or the snapshot.
    expect(order).toEqual(['registry.dispose', 'store.dispose', 'store.snapshot', 'ledger.close', 'handle.stop']);
    expect(run.lines.some((line) => line.msg === 'registry dispose failed')).toBe(true);
  });

  it('a genuinely stuck stage still reaches forced exit at the guard budget', async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const state: ServiceShutdownState = {
        wave: { shutdown: () => new Promise<void>(() => {}) } as unknown as WaveRunner, // never settles
        registry: { dispose: async () => { order.push('registry.dispose'); } } as unknown as RuntimeRegistry,
        store: fakeStore(order),
        handle: fakeHandle(order),
      };
      const run = runShutdown(state);
      await vi.advanceTimersByTimeAsync(SHUTDOWN_FORCE_EXIT_MS - 1);
      expect(run.exits).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(run.exits).toEqual([1]);
      expect(run.forced()).toBe(true);
      expect(order).toEqual([]); // the later cleanup stages never ran
    } finally {
      vi.useRealTimers();
    }
  });

  it('is the orchestration main.ts actually invokes (wiring alarm)', () => {
    const mainSource = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
    expect(mainSource).toContain("from './service-shutdown.js'");
    expect(mainSource).toMatch(/startServiceShutdown\(\{\s*signal,\s*exitCode/);
  });
});
