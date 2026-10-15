import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { configPathFor, loadConfig, type RuntimeId } from '../src/config.js';
import { RuntimeRegistry } from '../src/runtime/registry.js';
import { PI_CAPABILITIES } from '../src/runtime/capabilities.js';
import {
  CESSATION_IDLE_TIMEOUT_MS,
  CessationIdleTimeoutError,
  PiAgentHandle,
  PiRuntime,
} from '../src/runtime/pi-adapter.js';
import { makeStubModelRuntime, StubScript } from './helpers/stub-model.js';
import { SessionStore } from '../src/sessions/store.js';
import {
  adapterCessationEvidence,
  type AgentHandle,
  type AgentRuntime,
  type RuntimeEvent,
} from '../src/runtime/types.js';

/**
 * F60-P1 / F60-P3 / F60-P4: ownership release is ADAPTER-EVIDENCE-ONLY.
 *
 * A real PiAgentHandle (the production adapter class) with a controlled
 * session is driven THROUGH the registry consumer: its positive idle proof
 * releases the resident permit, while an unproven timeout keeps disposed
 * health + UNKNOWN evidence and the permit counted as visible debt. Missing
 * and throwing evidence are negative controls; terminal health, dispose
 * settlement, lock/native retirement are never proof.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

type PiSession = ConstructorParameters<typeof PiAgentHandle>[1];

/** Deterministic PiAgentHandle over a controllable session (same builder the
 * cessation suite uses): `waitForIdleMode` selects the idle proof. */
function piHandle(opts: {
  waitForIdleMode?: 'idle' | 'never' | 'reject' | 'absent';
} = {}): { handle: PiAgentHandle; sessionFile: string; session: { disposed: boolean } } {
  const mode = opts.waitForIdleMode ?? 'idle';
  const state = { disposed: false };
  const session: PiSession = {
    sessionId: 'pi-ownership-session',
    sessionFile: undefined,
    isStreaming: false,
    isIdle: true,
    isCompacting: false,
    get isBashRunning() { return false; },
    get hasPendingBashMessages() { return false; },
    prompt: async () => {},
    steer: async () => {},
    followUp: async () => {},
    subscribe: () => () => {},
    dispose: () => { state.disposed = true; },
    compact: async () => ({}),
    getContextUsage: () => undefined,
    ...(mode === 'absent' ? {} : {
      waitForIdle: async () => {
        if (mode === 'never') return new Promise<void>(() => {});
        if (mode === 'reject') throw new Error('idle wait rejected');
      },
    }),
  };
  const store = new SessionStore(mkdtempSync(join(tmpdir(), 'gru-pos-cessation-pi-')));
  cleanupDirs.push(store.dataDir);
  const sessionFile = join(store.dataDir, 'ownership.jsonl');
  const handle = new PiAgentHandle('perkins', session, sessionFile, PI_CAPABILITIES, false, [], store, () => {});
  const events: RuntimeEvent[] = [];
  handle.subscribe((event) => events.push(event));
  return { handle, sessionFile, session: state };
}

/** The REAL RuntimeRegistry over one injected adapter. */
function registryOver(adapter: AgentRuntime, capacity = 2): RuntimeRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'gru-pos-cessation-'));
  cleanupDirs.push(dir);
  const config = { ...loadConfig({ GRU_COMMAND_HOME: dir }), concurrency: { maxWorkers: capacity } };
  class TestRegistry extends RuntimeRegistry {
    override runtimeIdFor(): RuntimeId { return adapter.id as RuntimeId; }
    override runtimeFor(): AgentRuntime { return adapter; }
  }
  return new TestRegistry({ config, store: {} as SessionStore, canReclaim: () => false });
}

function opaqueAdapter(handles: readonly AgentHandle[]): AgentRuntime {
  let index = 0;
  return {
    id: 'pi',
    capabilities: PI_CAPABILITIES,
    health: () => ({ state: 'ok' }),
    dispose: async () => {},
    spawn: async (): Promise<AgentHandle> => handles[index++]!,
  };
}

describe('adapterCessationEvidence (Option A: adapter-owned proof only)', () => {
  it('is ceased ONLY for an explicit adapter attestation; missing/throwing/garbage are unknown', () => {
    expect(adapterCessationEvidence({ cessationEvidence: () => 'ceased' })).toBe('ceased');
    expect(adapterCessationEvidence({ cessationEvidence: () => 'unknown' })).toBe('unknown');
    expect(adapterCessationEvidence({})).toBe('unknown'); // missing method
    expect(
      adapterCessationEvidence({ cessationEvidence: () => { throw new Error('evidence probe blew up'); } }),
    ).toBe('unknown'); // throwing adapter
    expect(adapterCessationEvidence({ cessationEvidence: () => 'CEASED' as never })).toBe('unknown'); // garbage
  });
});

describe('real spawned Pi timeout retirement (F60-P6)', () => {
  it('a REAL spawned Pi timeout retires native/active-file membership, releases the lock, and attributes ONE cause (no adapter duplicate)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gru-p6-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-p6-ws-'));
    const agentDir = mkdtempSync(join(tmpdir(), 'gru-p6-agent-'));
    cleanupDirs.push(home, workspace, agentDir);
    writeFileSync(
      configPathFor(home),
      `workspace_root = "${workspace}"\n[models]\ndefault = "gru-stub/stub-model"\n`,
      'utf-8',
    );
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const store = new SessionStore(config.dataDir);
    // A held turn whose transport IGNORES abort: the real SDK session never
    // reaches idle after dispose, so the bounded post-dispose proof times out.
    const hold = new Promise<void>(() => {});
    const script = new StubScript([{ deltas: ['held turn'], hold, honorAbort: false }]);
    const modelRuntime = await makeStubModelRuntime(script);
    const runtime = new PiRuntime({ config, store, agentDir, modelRuntime });

    const registry = registryOver(runtime, 2);
    try {
      const resident = await registry.spawn('minion');
      const native = runtime as unknown as { handles: Set<PiAgentHandle>; activeFiles: Set<string> };
      const raw = [...native.handles][0]!;
      const sessionFile = raw.sessionFile!;
      // Deterministic ACTUAL model/turn-start barrier (replaces the previous
      // 50ms inference): the stub provider records the turn the moment the
      // SDK requests it, and the session lock is genuinely held.
      void resident.prompt('hold the turn').catch(() => {});
      await vi.waitFor(() => {
        expect(script.calls).toHaveLength(1);
        expect(store.isHeld(sessionFile)).toBe(true);
      }, { timeout: 2_000 });

      // EXACT original cause identity: the adapter's single-flight disposal
      // promise is shared, so the resident proxy must rethrow the SAME object
      // (not a class-equivalent copy).
      const originalFailure = raw.dispose().then(() => null, (reason: unknown) => reason);
      const error = await resident.dispose().then(() => null, (reason: unknown) => reason);
      const original = await originalFailure;
      expect(error).toBeInstanceOf(CessationIdleTimeoutError);
      expect(error).toBe(original);
      expect(adapterCessationEvidence(raw)).toBe('unknown');
      // GH286 ownership contract (main): a disposal without native
      // quiescence RETAINS writer ownership — native + active-file membership
      // and the session lock stay held until a retry proves cessation.
      expect(native.handles.size).toBe(1);
      expect(native.activeFiles.has(sessionFile)).toBe(true);
      expect(store.isHeld(sessionFile)).toBe(true);
      // UNKNOWN evidence keeps the resident permit as debt.
      expect(registry.residents.occupied).toBe(1);
      // A second registry disposal RETRIES the retained handle (still hung, so
      // it fails again with a fresh named failure) and attributes it to the
      // resident id; the adapter phase must not add an adapter-only duplicate
      // for the same handle.
      const second = await registry.dispose().then(() => null, (reason: unknown) => reason);
      expect(second).toBeInstanceOf(AggregateError);
      const aggregate = second as AggregateError;
      expect(aggregate.errors.length).toBe(1);
      expect((aggregate.errors[0] as Error).cause).toBeInstanceOf(CessationIdleTimeoutError);
      expect((aggregate.errors[0] as Error).message.startsWith(`${resident.id}:`)).toBe(true);
    } finally {
      await runtime.dispose().then(() => null, () => null);
    }
  }, 30_000);
});

describe('registry resident ownership is adapter-evidence gated (F60-P1/P4)', () => {
  it('a real Pi handle that proves idle releases the permit exactly once (positive control)', async () => {
    const { handle } = piHandle({ waitForIdleMode: 'idle' });
    const registry = registryOver({
      id: 'pi', capabilities: PI_CAPABILITIES, health: () => ({ state: 'ok' }),
      dispose: async () => {}, spawn: async () => handle,
    });
    const resident = await registry.spawn('minion');
    expect(registry.residents.occupied).toBe(1);
    await resident.dispose();
    // Positive adapter evidence -> release ONCE, membership dropped.
    expect(adapterCessationEvidence(handle)).toBe('ceased');
    expect(registry.getHandle(resident.id)).toBeNull();
    expect(registry.residents.occupied).toBe(0);
    await registry.dispose();
  });

  it('a real Pi timeout keeps disposed health + UNKNOWN evidence AND the permit as debt (negative control)', async () => {
    vi.useFakeTimers();
    try {
      const { handle } = piHandle({ waitForIdleMode: 'never' });
      const registry = registryOver({
        id: 'pi', capabilities: PI_CAPABILITIES, health: () => ({ state: 'ok' }),
        dispose: async () => {}, spawn: async () => handle,
      });
      const resident = await registry.spawn('minion');
      const settled = resident.dispose().then(() => null, (error: unknown) => error);
      await vi.advanceTimersByTimeAsync(CESSATION_IDLE_TIMEOUT_MS);
      const error = await settled;
      expect(error).toBeInstanceOf(CessationIdleTimeoutError);
      // Writer ownership is retained (health is not 'disposed') and the
      // evidence is explicitly UNKNOWN.
      expect(handle.health().state).not.toBe('disposed');
      expect(adapterCessationEvidence(handle)).toBe('unknown');
      // Ownership is retained as VISIBLE debt — no replacement is licensed.
      expect(registry.getHandle(resident.id)).toBe(resident);
      expect(registry.residents.occupied).toBe(1);
      // Shutdown retries the debt handle (still hung -> fails again; never a
      // capacity release).
      const again = registry.dispose().then(() => null, () => null);
      await vi.advanceTimersByTimeAsync(CESSATION_IDLE_TIMEOUT_MS);
      await again;
    } finally {
      vi.useRealTimers();
    }
  });

  it('missing and throwing evidence keep the permit after a FULFILLED disposal (negative controls)', async () => {
    for (const variant of ['missing', 'throwing'] as const) {
      const id = `opaque-${variant}`;
      const handle: AgentHandle = {
        id, role: 'minion', sessionFile: null, capabilities: PI_CAPABILITIES,
        health: () => ({ state: 'disposed', lastActivity: null, sessionFile: null }),
        prompt: async () => {}, steer: async () => {}, followUp: async () => {},
        subscribe: () => () => {}, dispose: async () => {},
        ...(variant === 'throwing'
          ? { cessationEvidence: () => { throw new Error('adapter cannot attest cessation'); } }
          : {}),
      };
      const registry = registryOver(opaqueAdapter([handle]));
      const resident = await registry.spawn('minion');
      await resident.dispose(); // fulfilled disposal, disposed health
      expect(registry.getHandle(resident.id)).toBe(resident); // NOT released
      expect(registry.residents.occupied).toBe(1);
    }
  });

  it('a late adapter cessation event reconciles the retained resident debt exactly once', async () => {
    let evidence: 'ceased' | 'unknown' = 'unknown';
    const listeners = new Set<(event: RuntimeEvent) => void>();
    const handle: AgentHandle = {
      id: 'late-positive', role: 'minion', sessionFile: null, capabilities: PI_CAPABILITIES,
      health: () => ({ state: 'disposed', lastActivity: null, sessionFile: null }),
      cessationEvidence: () => evidence,
      prompt: async () => {}, steer: async () => {}, followUp: async () => {},
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      dispose: async () => {},
    };
    const registry = registryOver(opaqueAdapter([handle]));
    const resident = await registry.spawn('minion');
    await resident.dispose();           // fulfilled disposal, UNKNOWN -> debt
    expect(registry.residents.occupied).toBe(1);
    evidence = 'ceased';                // the adapter later attests cessation
    for (const listener of listeners) listener({ type: 'cessation_evidence', evidence: 'ceased' });
    expect(registry.getHandle(resident.id)).toBeNull(); // released ONCE
    expect(registry.residents.occupied).toBe(0);
    // Idempotent: a repeated late positive never double-releases.
    for (const listener of listeners) listener({ type: 'cessation_evidence', evidence: 'ceased' });
    expect(registry.residents.occupied).toBe(0);
  });
});
