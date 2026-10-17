import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  startServiceShutdown,
  type ServiceShutdownLogger,
  type ServiceShutdownState,
} from '../src/service-shutdown.js';
import { LANE_SLIMMER_STOP_WAIT_MS, SHUTDOWN_FORCE_EXIT_MS } from '../src/shutdown-budget.js';
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
  readonly level: 'info' | 'warn' | 'error';
  readonly msg: string;
  readonly fields?: Record<string, unknown>;
}

function recordingLogger(): ServiceShutdownLogger & { readonly lines: LogLine[] } {
  const lines: LogLine[] = [];
  return {
    lines,
    info: (msg, fields) => { lines.push({ level: 'info', msg, ...(fields !== undefined ? { fields } : {}) }); },
    warn: (msg, fields) => { lines.push({ level: 'warn', msg, ...(fields !== undefined ? { fields } : {}) }); },
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
    expect(run.lines.some((line) => line.msg === 'directive progress/registry dispose failed')).toBe(true);
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

  it('a never-settling registry still reaches forced exit exactly once at the REFRESHED deadline (F60-P5)', async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const state: ServiceShutdownState = {
        // An earlier stage completes well inside the first window.
        wave: {
          shutdown: async () => { order.push('wave'); await delay(5_000); },
        } as unknown as WaveRunner,
        // The runtime teardown never settles: the guard was re-armed at t=5s.
        registry: { dispose: () => new Promise<void>(() => {}) } as unknown as RuntimeRegistry,
        store: fakeStore(order),
        handle: fakeHandle(order),
      };
      const run = runShutdown(state);
      const priorStageMs = 5_000;
      await vi.advanceTimersByTimeAsync(priorStageMs);
      expect(order).toEqual(['wave']); // earlier stage done; re-arm landed here
      expect(run.exits).toEqual([]);
      // Refreshed deadline = prior-stage duration + the ORIGINAL
      // SHUTDOWN_FORCE_EXIT_MS. Minus 1ms: no early exit (a stale original
      // window would already have fired at t=15s).
      await vi.advanceTimersByTimeAsync(priorStageMs + SHUTDOWN_FORCE_EXIT_MS - 1 - priorStageMs);
      expect(run.exits).toEqual([]);
      expect(run.forced()).toBe(false);
      // ...plus 1ms: exactly ONE forced exit at the refreshed deadline.
      await vi.advanceTimersByTimeAsync(1);
      expect(run.exits).toEqual([1]);
      expect(run.forced()).toBe(true);
      // Controlled post-deadline observation: no further exit and no later
      // store/snapshot/persistence side effects.
      await vi.advanceTimersByTimeAsync(SHUTDOWN_FORCE_EXIT_MS);
      expect(run.exits).toEqual([1]);
      expect(order).toEqual(['wave']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('checkpoints pending autopilot producers before the first await and drains them only after registry disposal (#368)', async () => {
    const order: string[] = [];
    const warnings: string[] = [];
    let releaseChat!: () => void;
    const chatGate = new Promise<void>((resolve) => { releaseChat = resolve; });
    const pending = [{ operation: 'directive', jobId: 'job-1', ruleId: 'verdict-rung-fix', requestRefs: ['req-1'], agentId: null }];
    const state: ServiceShutdownState = {
      chat: { dispose: async () => { order.push('chat.dispose'); await chatGate; } } as unknown as NonNullable<ServiceShutdownState['chat']>,
      autopilot: {
        pendingSnapshot: () => { order.push('autopilot.snapshot'); return pending; },
        drain: async () => { order.push('autopilot.drain'); return { settled: false, pending: 1 }; },
      } as unknown as NonNullable<ServiceShutdownState['autopilot']>,
      ledger: { appendCustomEvent: (event: { kind: string; payload: unknown }) => { order.push(`ledger.${event.kind}`); return event; } } as unknown as NonNullable<ServiceShutdownState['ledger']>,
      registry: { dispose: async () => { order.push('registry.dispose'); } } as unknown as RuntimeRegistry,
      store: {
        writeShutdownCheckpoint: (input: { pending: readonly unknown[] }) => { order.push(`store.checkpoint:${String(input.pending.length)}`); },
        dispose: (): void => { order.push('store.dispose'); },
        persistSnapshot: (): void => { order.push('store.snapshot'); },
      } as unknown as SessionStore,
      handle: fakeHandle(order),
    };
    const logger = recordingLogger();
    const exits: number[] = [];
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    startServiceShutdown({
      signal: 'SIGTERM',
      exitCode: 0,
      logger: { ...logger, warn: (msg) => { warnings.push(msg); } },
      state,
      serviceStop: new AbortController(),
      exit: (code) => { exits.push(code); resolveExit(code); },
    });
    // Synchronously, before any stage awaited: the durable checkpoint landed.
    expect(order).toEqual(['autopilot.snapshot', 'store.checkpoint:1', 'ledger.silas.shutdown-checkpoint']);
    await delay(0);
    expect(order.at(-1)).toBe('chat.dispose');
    releaseChat();
    await exited;
    expect(exits).toEqual([0]);
    expect(order.slice(3)).toEqual(['chat.dispose', 'registry.dispose', 'autopilot.drain', 'store.dispose', 'store.snapshot', 'handle.stop']);
    expect(warnings).toEqual(['silas autopilot producers unsettled after disposal — ownership retained for boot reconciliation']);
  });

  it('a failed checkpoint is logged and never blocks the shutdown (#368)', async () => {
    const order: string[] = [];
    const state: ServiceShutdownState = {
      autopilot: {
        pendingSnapshot: () => { throw new Error('snapshot unavailable'); },
        drain: async () => { order.push('autopilot.drain'); return { settled: true, pending: 0 }; },
      } as unknown as NonNullable<ServiceShutdownState['autopilot']>,
      handle: fakeHandle(order),
    };
    const run = runShutdown(state);
    await run.exited;
    expect(run.exits).toEqual([0]);
    expect(order).toEqual(['autopilot.drain', 'handle.stop']);
    expect(run.lines.some((line) => line.msg === 'shutdown checkpoint failed — pending ownership retained')).toBe(true);
  });

  it('stops Vector\'s raid planning and raid queue; one failing to stop never skips the other (#351)', async () => {
    const order: string[] = [];
    const state: ServiceShutdownState = {
      vector: { stop: () => { order.push('vector.stop'); throw new Error('planning timer gone'); } },
      vectorRaids: { stop: () => { order.push('vectorRaids.stop'); } },
      handle: fakeHandle(order),
    };
    const run = runShutdown(state);
    await run.exited;
    expect(run.exits).toEqual([0]);
    expect(order).toEqual(['vector.stop', 'vectorRaids.stop', 'handle.stop']);
    expect(run.lines.filter((line) => line.level === 'error').map((line) => line.msg)).toEqual(['vector raid planning stop failed']);
  });

  it('stops onboarding after the raid halves, so a stop mid-scan aborts its origin probes; a failing stop never skips what follows (#427)', async () => {
    const order: string[] = [];
    const state: ServiceShutdownState = {
      vectorRaids: { stop: () => { order.push('vectorRaids.stop'); } },
      onboarding: { stop: () => { order.push('onboarding.stop'); throw new Error('probe already gone'); } },
      handle: fakeHandle(order),
    };
    const run = runShutdown(state);
    await run.exited;
    expect(run.exits).toEqual([0]);
    expect(order).toEqual(['vectorRaids.stop', 'onboarding.stop', 'handle.stop']);
    expect(run.lines.filter((line) => line.level === 'error').map((line) => line.msg)).toEqual(['onboarding stop failed']);
  });

  it('stops lane slimming after onboarding and waits for the slim pass that is running; a failing stop never skips what follows (#427)', async () => {
    const order: string[] = [];
    let finishPass!: () => void;
    const state: ServiceShutdownState = {
      onboarding: { stop: () => { order.push('onboarding.stop'); } },
      laneSlimmer: {
        stop: async () => {
          order.push('laneSlimmer.stop');
          await new Promise<void>((resolvePass) => { finishPass = resolvePass; });
          order.push('laneSlimmer.pass-finished');
          throw new Error('the pass ended in error');
        },
      },
      handle: fakeHandle(order),
    };
    const run = runShutdown(state);
    await vi.waitFor(() => expect(order).toContain('laneSlimmer.stop'));
    for (let i = 0; i < 10; i += 1) await new Promise((resolveTick) => setTimeout(resolveTick, 0));
    expect(order).toEqual(['onboarding.stop', 'laneSlimmer.stop']);
    finishPass();
    await run.exited;
    expect(run.exits).toEqual([0]);
    expect(order).toEqual(['onboarding.stop', 'laneSlimmer.stop', 'laneSlimmer.pass-finished', 'handle.stop']);
    expect(run.lines.filter((line) => line.level === 'error').map((line) => line.msg)).toEqual(['lane slimming stop failed']);
  });

  it('waits for a slow lane-slimming pass at most its bound, well inside the force-exit budget, then goes on (#427)', async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      const state: ServiceShutdownState = {
        // A pass deleting a huge folder that never finishes in time.
        laneSlimmer: { stop: async () => { order.push('laneSlimmer.stop'); await new Promise<void>(() => {}); } },
        handle: fakeHandle(order),
      };
      expect(LANE_SLIMMER_STOP_WAIT_MS).toBeLessThan(SHUTDOWN_FORCE_EXIT_MS / 2);
      const run = runShutdown(state);
      await vi.advanceTimersByTimeAsync(LANE_SLIMMER_STOP_WAIT_MS - 1);
      expect(order).toEqual(['laneSlimmer.stop']);
      await vi.advanceTimersByTimeAsync(1);
      await run.exited;
      expect(run.exits).toEqual([0]);
      expect(run.forced()).toBe(false);
      expect(order).toEqual(['laneSlimmer.stop', 'handle.stop']);
      expect(run.lines.filter((line) => line.level === 'warn').map((line) => line.msg)).toEqual([
        'lane slimming did not stop in time; shutdown goes on (a lane slimmed part way is restored by its next turn)',
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is the orchestration main.ts actually invokes (wiring alarm)', () => {
    const mainSource = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8');
    expect(mainSource).toContain("from './service-shutdown.js'");
    expect(mainSource).toMatch(/startServiceShutdown\(\{\s*signal,\s*exitCode/);
    // #368: the autopilot handle and the checkpoint ledger reach the state bag.
    expect(mainSource).toMatch(/\bstate\.autopilot = autopilotOps;/);
    expect(mainSource).toMatch(/\bstate\.ledger = ledger;/);
    // #351: both raid halves reach the state bag before either starts, so a failed start still stops.
    const registered = Math.max(mainSource.indexOf('state.vector = vector;'), mainSource.indexOf('state.vectorRaids = vectorRaids;'));
    expect(mainSource.indexOf('state.vector = vector;')).toBeGreaterThan(-1);
    expect(mainSource.indexOf('state.vectorRaids = vectorRaids;')).toBeGreaterThan(-1);
    expect(mainSource.indexOf('startVectorHalves({ planning: vector, runner: vectorRaids }')).toBeGreaterThan(registered);
    // #427: onboarding reaches the state bag before it starts scanning.
    expect(mainSource.indexOf('state.onboarding = onboarding;')).toBeGreaterThan(-1);
    expect(mainSource.indexOf('startOnboarding(onboarding,')).toBeGreaterThan(mainSource.indexOf('state.onboarding = onboarding;'));
    // #427: lane slimming reaches the state bag before it starts.
    expect(mainSource.indexOf('state.laneSlimmer = laneSlimmer;')).toBeGreaterThan(-1);
    expect(mainSource.indexOf('startLaneSlimmer(laneSlimmer,')).toBeGreaterThan(mainSource.indexOf('state.laneSlimmer = laneSlimmer;'));
  });
});
