import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadConfig, type Role, type RuntimeId } from '../src/config.js';
import { RuntimeRegistry } from '../src/runtime/registry.js';
import { disposeAll, disposePhases, type DisposableTarget } from '../src/runtime/disposal.js';
import {
  CESSATION_IDLE_TIMEOUT_MS,
  CessationIdleTimeoutError,
  PiRuntime,
} from '../src/runtime/pi-adapter.js';
import { ClaudeCodeRuntime } from '../src/runtime/claude-adapter.js';
import { BRIDGE_CLOSE_TIMEOUT_MS } from '../src/runtime/review-mcp-bridge.js';
import { SHUTDOWN_FORCE_EXIT_MS } from '../src/shutdown-budget.js';
import type { AgentHandle, AgentRuntime, RuntimeEvent, RuntimeEventListener } from '../src/runtime/types.js';
import type { SessionStore } from '../src/sessions/store.js';

const caps = { streaming: false, steer: 'queued' as const, resume: 'file' as const, images: false, thinking: false, thinkingLevelControl: false, followUp: false };

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * Issue #341 (HIGH): a plain sequential `await dispose()` loop aborts on the
 * first rejection, so one hung session that fails to prove idle abandons every
 * remaining handle's lock release and every adapter's bridge teardown. These
 * tests pin the aggregate AND the concurrency: disposal runs every target and
 * a hung handle costs one bound, not one bound per handle, or the service
 * shutdown force-exit guard outruns the teardown and abandons cleanup anyway.
 */

describe('disposeAll (issue #341 shutdown containment)', () => {
  it('runs every disposal concurrently and fails loud once with the per-target causes', async () => {
    const cause = new CessationIdleTimeoutError('agent-0', 5_000);
    const starts: string[] = [];
    const settledOrder: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const target = (id: string, fail: boolean): DisposableTarget => ({
      id,
      dispose: async () => {
        starts.push(id);
        await gate;
        settledOrder.push(id);
        if (fail) throw cause;
      },
    });
    const disposal = disposeAll([target('agent-0', true), target('agent-1', false), target('adapter:pi', false)]);
    // CONCURRENT: every target is in flight before the first settles — a serial
    // traversal would have started only agent-0 here.
    expect(starts).toEqual(['agent-0', 'agent-1', 'adapter:pi']);
    expect(settledOrder).toEqual([]);
    release();
    const thrown = await disposal.then(
      () => null,
      (error: unknown) => error,
    );
    // Never aborts the traversal: the failed target does not skip the rest.
    expect(settledOrder).toEqual(['agent-0', 'agent-1', 'adapter:pi']);
    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.errors.length).toBe(1);
    expect(aggregate.errors[0]).toBeInstanceOf(Error);
    expect((aggregate.errors[0] as Error).message).toContain('agent-0');
    expect((aggregate.errors[0] as Error).cause).toBe(cause);
    expect(aggregate.message).toContain('1 of 3');
    expect(aggregate.message).toContain('agent-0');
  });

  it('resolves cleanly when every target disposes', async () => {
    const order: string[] = [];
    await disposeAll([
      { id: 'a', dispose: async () => { order.push('a'); } },
      { id: 'b', dispose: async () => { order.push('b'); } },
    ]);
    expect(order).toEqual(['a', 'b']);
  });

  it('a pathological rejection whose String() throws is attributed, never escapes the aggregate', async () => {
    // Object.create(null) has no toString; the old message builder would throw
    // INSIDE the catch and abort the whole traversal.
    const pathological = Object.create(null) as unknown;
    const thrown = await disposeAll([
      { id: 'agent-bad', dispose: async () => { throw pathological; } },
      { id: 'agent-ok', dispose: async () => {} },
    ]).then(
      () => null,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.errors.length).toBe(1);
    expect(aggregate.errors[0]).toBeInstanceOf(Error);
    expect((aggregate.errors[0] as Error).cause).toBe(pathological);
    expect(aggregate.message).toContain('agent-bad');
  });
});

interface Activity { disposed: boolean; }

describe('disposeAll / disposePhases attribution (issue #341 R3-3)', () => {
  it('reports EVERY failing target in INPUT order with its original cause, even when they settle in reverse order (incl. a synchronous throw)', async () => {
    const syncCause = new Error('sync target exploded');
    const slowCause = new CessationIdleTimeoutError('agent-slow', CESSATION_IDLE_TIMEOUT_MS);
    const fastCause = new Error('fast target exploded');
    const adapterCause = new Error('adapter target exploded');
    const started: string[] = [];
    const settled: string[] = [];
    const gate = (): { promise: Promise<void>; resolve: () => void } => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => { resolve = r; });
      return { promise, resolve };
    };
    const slow = gate();
    const fast = gate();
    const adapter = gate();
    const targets: DisposableTarget[] = [
      // A SYNCHRONOUS throw: dispose() itself throws, not a rejected promise.
      { id: 'agent-sync', dispose: () => { started.push('agent-sync'); settled.push('agent-sync'); throw syncCause; } },
      { id: 'agent-slow', dispose: async () => { started.push('agent-slow'); await slow.promise; settled.push('agent-slow'); throw slowCause; } },
      { id: 'agent-fast', dispose: async () => { started.push('agent-fast'); await fast.promise; settled.push('agent-fast'); throw fastCause; } },
      { id: 'adapter:pi', dispose: async () => { started.push('adapter:pi'); await adapter.promise; settled.push('adapter:pi'); throw adapterCause; } },
    ];
    const disposal = disposeAll(targets);
    // ALL siblings attempted before any settlement: the synchronous throw
    // happens during the synchronous start pass and skips nobody.
    expect(started).toEqual(['agent-sync', 'agent-slow', 'agent-fast', 'adapter:pi']);
    // Settle in REVERSE order: adapter, then fast, then slow.
    adapter.resolve();
    await Promise.resolve();
    await Promise.resolve();
    fast.resolve();
    await Promise.resolve();
    await Promise.resolve();
    slow.resolve();
    const thrown = await disposal.then(
      () => null,
      (error: unknown) => error,
    );
    expect(settled).toEqual(['agent-sync', 'adapter:pi', 'agent-fast', 'agent-slow']);

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    // First-failure-only collection would report 1; settlement-order or
    // attribution loss would misorder or mispad the causes.
    expect(aggregate.errors.length).toBe(4);
    const errors = aggregate.errors as Error[];
    expect(errors.map((error, index) => error.message.startsWith(`${targets[index]!.id}:`))).toEqual([true, true, true, true]);
    expect(errors[0]!.cause).toBe(syncCause);
    expect(errors[1]!.cause).toBe(slowCause);
    expect(errors[2]!.cause).toBe(fastCause);
    expect(errors[3]!.cause).toBe(adapterCause);
    expect(aggregate.message).toContain('4 of 4');
    for (const target of targets) expect(aggregate.message).toContain(target.id);
  });

  it('disposePhases keeps phase order, never starts phase 2 while phase 1 is pending, and combines causes after a phase-1 failure', async () => {
    const residentCause = new CessationIdleTimeoutError('agent-0', CESSATION_IDLE_TIMEOUT_MS);
    const adapterCause = new Error('adapter teardown failed');
    const started: string[] = [];
    let releaseResident!: () => void;
    const gate = new Promise<void>((resolve) => { releaseResident = resolve; });
    const phases: DisposableTarget[][] = [
      [
        { id: 'agent-0', dispose: async () => { started.push('agent-0'); await gate; throw residentCause; } },
        { id: 'agent-1', dispose: async () => { started.push('agent-1'); await gate; } },
      ],
      [
        { id: 'adapter:pi', dispose: async () => { started.push('adapter:pi'); throw adapterCause; } },
        { id: 'adapter:claude', dispose: async () => { started.push('adapter:claude'); } },
      ],
    ];
    const disposal = disposePhases(phases);
    expect(started).toEqual(['agent-0', 'agent-1']); // concurrent WITHIN phase 1
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(['agent-0', 'agent-1']); // phase 2 NOT started while phase 1 is pending
    releaseResident();
    const thrown = await disposal.then(
      () => null,
      (error: unknown) => error,
    );
    // Phase 2 ran even though phase 1 failed, with no skipped siblings.
    expect(started).toEqual(['agent-0', 'agent-1', 'adapter:pi', 'adapter:claude']);
    const aggregate = thrown as AggregateError;
    expect(aggregate.errors.length).toBe(2);
    const errors = aggregate.errors as Error[];
    expect(errors[0]!.message.startsWith('agent-0:')).toBe(true);
    expect(errors[0]!.cause).toBe(residentCause);
    expect(errors[1]!.message.startsWith('adapter:pi:')).toBe(true);
    expect(errors[1]!.cause).toBe(adapterCause);
    // Total counts BOTH phases, not just the failing one.
    expect(aggregate.message).toContain('2 of 4');
  });
});

/** Minimal registry over a fake 'pi' adapter whose per-handle dispose can be
 * made to reject, so the real `RuntimeRegistry.dispose()` traversal is hit.
 * `hungBoundMs` models a handle whose idle proof burns the full shutdown bound
 * before it fails — the shape that must not multiply across handles. */
function registryHarness(opts: {
  disposeFailsFor: (index: number) => boolean;
  hungBoundMs?: number;
}) {
  const dir = mkdtempSync(join(tmpdir(), 'gru-disposal-'));
  cleanupDirs.push(dir);
  const config = { ...loadConfig({ GRU_COMMAND_HOME: dir }), concurrency: { maxWorkers: 2 } };
  const activities: Activity[] = [];
  const adapterDisposals: RuntimeId[] = [];
  const adapter: AgentRuntime = {
    id: 'pi', capabilities: caps, health: () => ({ state: 'ok' }),
    dispose: async () => { adapterDisposals.push('pi'); },
    spawn: async (role: Role): Promise<AgentHandle> => {
      const index = activities.length;
      const activity: Activity = { disposed: false };
      activities.push(activity);
      const listeners = new Set<RuntimeEventListener>();
      const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
      return {
        id: `agent-${index}`, role, sessionFile: null, capabilities: caps,
        health: () => ({ state: activity.disposed ? 'disposed' : 'idle', lastActivity: null, sessionFile: null }),
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        prompt: async () => {}, steer: async () => {}, followUp: async () => {},
        hasLiveProcess: () => false, isCompacting: () => false,
        dispose: async () => {
          if (opts.hungBoundMs !== undefined) {
            await new Promise<void>((resolve) => setTimeout(resolve, opts.hungBoundMs));
          }
          if (activity.disposed) return;
          activity.disposed = true;
          emit({ type: 'state', state: 'disposed' });
          if (opts.disposeFailsFor(index)) throw new CessationIdleTimeoutError(`agent-${index}`, 5_000);
        },
      };
    },
  };
  class TestRegistry extends RuntimeRegistry {
    constructor(options: ConstructorParameters<typeof RuntimeRegistry>[0]) {
      super(options);
      // The base `runtimeFor` is the only writer of the private adapter map;
      // inject the fake there so `dispose()` actually traverses it.
      (this as unknown as { adapters: Map<RuntimeId, AgentRuntime> }).adapters.set('pi', adapter);
    }
    override runtimeIdFor(_role: Role): RuntimeId { return 'pi'; }
    override runtimeFor(): AgentRuntime { return adapter; }
  }
  const registry = new TestRegistry({ config, store: {} as SessionStore, canReclaim: () => false });
  return { registry, activities, adapterDisposals };
}

describe('registry.dispose (issue #341 shutdown containment)', () => {
  it('still disposes every remaining handle and the adapter after the first handle fails', async () => {
    const { registry, activities, adapterDisposals } = registryHarness({ disposeFailsFor: (index) => index === 0 });
    const first = await registry.spawn('minion');
    const second = await registry.spawn('minion');
    expect(first.id).toBe('agent-0');
    expect(second.id).toBe('agent-1');

    const thrown = await registry.dispose().then(
      () => null,
      (error: unknown) => error,
    );

    // The first handle's named failure surfaces ONCE, carrying its cause...
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).message).toContain('agent-0');
    // ...but the second handle's lock release and the adapter teardown ran.
    expect(activities[1]?.disposed).toBe(true);
    expect(adapterDisposals).toEqual(['pi']);
  });

  it('a hung handle burns ONE bound, not one bound per handle (the teardown the force-exit guard supervises)', async () => {
    const { registry, activities, adapterDisposals } = registryHarness({
      disposeFailsFor: () => true, // every handle is hung
      hungBoundMs: CESSATION_IDLE_TIMEOUT_MS,
    });
    await registry.spawn('minion');
    await registry.spawn('minion');

    vi.useFakeTimers();
    try {
      let settled = false;
      const disposal = registry.dispose().then(
        () => { settled = true; },
        () => { settled = true; },
      );
      // Serial disposal would still be inside the FIRST handle's bound here...
      await vi.advanceTimersByTimeAsync(CESSATION_IDLE_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      // ...but at the single bound ALL hung handles settle together.
      await vi.advanceTimersByTimeAsync(1);
      await disposal;
      expect(settled).toBe(true);
      expect(activities.map((activity) => activity.disposed)).toEqual([true, true]);
      expect(adapterDisposals).toEqual(['pi']);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Registry whose resident disposals are held by a gate, so the test can
 * observe whether the adapter phase starts before the resident phase settles. */
function phaseHarness(opts: { rejectResident?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gru-disposal-phase-'));
  cleanupDirs.push(dir);
  const config = { ...loadConfig({ GRU_COMMAND_HOME: dir }), concurrency: { maxWorkers: 2 } };
  const adapterCalls: string[] = [];
  const residentStarts: string[] = [];
  let spawnIndex = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const adapter: AgentRuntime = {
    id: 'pi', capabilities: caps, health: () => ({ state: 'ok' }),
    dispose: async () => { adapterCalls.push('pi'); },
    spawn: async (role: Role): Promise<AgentHandle> => {
      const id = `agent-${spawnIndex}`;
      spawnIndex += 1;
      return {
        id, role, sessionFile: null, capabilities: caps,
        health: () => ({ state: 'idle', lastActivity: null, sessionFile: null }),
        subscribe: () => () => {},
        prompt: async () => {}, steer: async () => {}, followUp: async () => {},
        hasLiveProcess: () => false, isCompacting: () => false,
        dispose: async () => {
          residentStarts.push(id);
          await gate;
          if (opts.rejectResident === true) throw new CessationIdleTimeoutError(id, CESSATION_IDLE_TIMEOUT_MS);
        },
      };
    },
  };
  class TestRegistry extends RuntimeRegistry {
    constructor(options: ConstructorParameters<typeof RuntimeRegistry>[0]) {
      super(options);
      (this as unknown as { adapters: Map<RuntimeId, AgentRuntime> }).adapters.set('pi', adapter);
    }
    override runtimeIdFor(_role: Role): RuntimeId { return 'pi'; }
    override runtimeFor(): AgentRuntime { return adapter; }
  }
  const registry = new TestRegistry({ config, store: {} as SessionStore, canReclaim: () => false });
  return { registry, adapterCalls, residentStarts, release };
}

describe('registry disposal phases (issue #341 R3-1)', () => {
  it('settles the WHOLE resident phase before starting ANY adapter, and still runs the adapter phase after resident failures', async () => {
    const { registry, adapterCalls, residentStarts, release } = phaseHarness({ rejectResident: true });
    await registry.spawn('minion');
    await registry.spawn('minion');
    let thrown: unknown = null;
    const disposal = registry.dispose().then(
      () => null,
      (error: unknown) => { thrown = error; return error; },
    );
    // Let the concurrent resident phase reach its held await.
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(residentStarts).toEqual(['agent-0', 'agent-1']); // concurrent starts
    expect(adapterCalls).toEqual([]); // adapters NOT started while residents are pending
    release();
    await disposal;
    expect(adapterCalls).toEqual(['pi']); // adapter phase still ran after the resident rejection
    expect(thrown).toBeInstanceOf(AggregateError);
    const errors = (thrown as AggregateError).errors as Error[];
    expect(errors.length).toBe(2);
    expect(errors[0]!.message.startsWith('agent-0:')).toBe(true);
    expect(errors[1]!.message.startsWith('agent-1:')).toBe(true);
  });

  it('a timed-out shared native handle is reported ONCE (resident-attributed), never duplicated as an adapter-only failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-disposal-shared-'));
    cleanupDirs.push(dir);
    const config = loadConfig({ GRU_COMMAND_HOME: dir });
    // The ACTUAL native runtime method under test.
    const runtime = new PiRuntime({ config, store: {} as SessionStore });
    const nativeHandles = (runtime as unknown as { handles: Set<unknown> }).handles;
    const timeout = new CessationIdleTimeoutError('pi-0', CESSATION_IDLE_TIMEOUT_MS);
    // Single-flight, mirroring PiAgentHandle.dispose(); retires from the
    // adapter's own set on settlement, mirroring PiRuntime's onDispose hook.
    let nativeDisposal: Promise<void> | null = null;
    const native = {
      id: 'pi-0',
      dispose: (): Promise<void> => (nativeDisposal ??= (async () => {
        await Promise.resolve(); // the awaited session disposal + idle proof
        nativeHandles.delete(native);
        throw timeout;
      })()),
    };
    nativeHandles.add(native);
    // The resident whose disposal forwards to the SAME native handle.
    const resident = { id: 'pi-0', dispose: (): Promise<void> => native.dispose() } as unknown as AgentHandle;
    const registry = new RuntimeRegistry({ config, store: {} as SessionStore, canReclaim: () => false });
    (registry as unknown as { adapters: Map<RuntimeId, AgentRuntime> }).adapters.set('pi', runtime);
    (registry as unknown as { handles: Set<AgentHandle> }).handles.add(resident);

    const thrown = await registry.dispose().then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    const errors = aggregate.errors as Error[];
    // ONE timeout, ONE attributed cause — not repeated through the adapter.
    expect(errors.length).toBe(1);
    expect(errors[0]!.message.startsWith('pi-0:')).toBe(true);
    expect(errors[0]!.cause).toBe(timeout);
    expect(aggregate.message).not.toContain('pi: ');
    // The native handle retired from the adapter's set before the adapter phase.
    expect(nativeHandles.size).toBe(0);
  });
});

describe('native runtime disposal containment (issue #341)', () => {
  /** A stub handle whose dispose rejects for the FIRST one only; the runtime
   * loop must still reach the second. */
  function stubHandle(id: string, disposed: string[], fail: boolean): { id: string; dispose: () => Promise<void> } {
    return {
      id,
      dispose: async () => {
        disposed.push(id);
        if (fail) throw new CessationIdleTimeoutError(id, CESSATION_IDLE_TIMEOUT_MS);
      },
    };
  }

  function inject(runtime: object, handles: readonly unknown[]): void {
    const set = (runtime as unknown as { handles: Set<unknown> }).handles;
    for (const handle of handles) set.add(handle);
  }

  it('PiRuntime.dispose disposes the second handle after the first rejects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-disposal-pi-'));
    cleanupDirs.push(dir);
    const config = loadConfig({ GRU_COMMAND_HOME: dir });
    const runtime = new PiRuntime({ config, store: {} as SessionStore });
    const disposed: string[] = [];
    inject(runtime, [stubHandle('pi-0', disposed, true), stubHandle('pi-1', disposed, false)]);

    const thrown = await runtime.dispose().then(
      () => null,
      (error: unknown) => error,
    );

    expect(disposed).toEqual(['pi-0', 'pi-1']);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).message).toContain('pi-0');
  });

  it('ClaudeCodeRuntime.dispose disposes the second handle after the first rejects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-disposal-claude-'));
    cleanupDirs.push(dir);
    const config = loadConfig({ GRU_COMMAND_HOME: dir });
    const runtime = new ClaudeCodeRuntime({ config, store: {} as SessionStore, binary: 'claude' });
    const disposed: string[] = [];
    inject(runtime, [stubHandle('claude-0', disposed, true), stubHandle('claude-1', disposed, false)]);

    const thrown = await runtime.dispose().then(
      () => null,
      (error: unknown) => error,
    );

    expect(disposed).toEqual(['claude-0', 'claude-1']);
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).message).toContain('claude-0');
  });
});

describe('service shutdown force-exit budget (issue #341)', () => {
  it('outlasts the bounded runtime teardown', () => {
    // The EXECUTABLE orchestration proof (guard vs. a full idle bound, the
    // 12s earlier-stage + re-arm interaction, cleanup-after-rejection, and a
    // genuinely stuck stage) lives in test/service-shutdown.test.ts; this pins
    // the constant relation the re-arm window depends on.
    expect(SHUTDOWN_FORCE_EXIT_MS).toBeGreaterThan(CESSATION_IDLE_TIMEOUT_MS + BRIDGE_CLOSE_TIMEOUT_MS);
  });
});
