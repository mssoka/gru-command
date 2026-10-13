import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig, type Role, type RuntimeId } from '../src/config.js';
import { RuntimeRegistry } from '../src/runtime/registry.js';
import { disposeAll, type DisposableTarget } from '../src/runtime/disposal.js';
import { CessationIdleTimeoutError } from '../src/runtime/pi-adapter.js';
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
 * tests pin the aggregate behavior: run EVERY disposal, then fail loud once.
 */

describe('disposeAll (issue #341 shutdown containment)', () => {
  it('runs every disposal and fails loud once with the per-target causes', async () => {
    const order: string[] = [];
    const cause = new CessationIdleTimeoutError('agent-0', 5_000);
    const targets: DisposableTarget[] = [
      { id: 'agent-0', dispose: async () => { order.push('agent-0'); throw cause; } },
      { id: 'agent-1', dispose: async () => { order.push('agent-1'); } },
      { id: 'adapter:pi', dispose: async () => { order.push('adapter:pi'); } },
    ];
    const thrown = await disposeAll(targets).then(
      () => null,
      (error: unknown) => error,
    );
    // Never aborts the traversal: the failed target does not skip the rest.
    expect(order).toEqual(['agent-0', 'agent-1', 'adapter:pi']);
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
});

interface Activity { disposed: boolean; }

/** Minimal registry over a fake 'pi' adapter whose per-handle dispose can be
 * made to reject, so the real `RuntimeRegistry.dispose()` traversal is hit. */
function registryHarness(disposeFailsFor: (index: number) => boolean) {
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
          if (activity.disposed) return;
          activity.disposed = true;
          emit({ type: 'state', state: 'disposed' });
          if (disposeFailsFor(index)) throw new CessationIdleTimeoutError(`agent-${index}`, 5_000);
        },
      };
    },
  };
  class TestRegistry extends RuntimeRegistry {
    constructor(opts: ConstructorParameters<typeof RuntimeRegistry>[0]) {
      super(opts);
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
    const { registry, activities, adapterDisposals } = registryHarness((index) => index === 0);
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
});
