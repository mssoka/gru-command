import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess, spawn } from 'node:child_process';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { configPathFor, loadConfig, type RuntimeId } from '../src/config.js';
import { ClaudeCodeRuntime } from '../src/runtime/claude-adapter.js';
import { RuntimeRegistry } from '../src/runtime/registry.js';
import { SessionStore } from '../src/sessions/store.js';
import { startServiceShutdown } from '../src/service-shutdown.js';
import { adapterCessationEvidence, type AgentRuntime } from '../src/runtime/types.js';

/**
 * Runtime-neutral cessation contract (issue #341) exercised with the REAL
 * Claude Code adapter (fake CLI child, real ClaudeCodeHandle) through the REAL
 * RuntimeRegistry and the service-shutdown orchestration: a Claude child whose
 * close is observed is 'ceased' and releases ownership; an unconfirmed exit
 * (deadline / error) stays 'unknown' and releases nothing until a late close.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => vi.useRealTimers());

function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null, kill: vi.fn(() => true),
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  }) as unknown as ChildProcess;
}

function claudeRegistry(child: ChildProcess): { registry: RuntimeRegistry; runtime: ClaudeCodeRuntime; spawned: ReturnType<typeof vi.fn> } {
  const spawned = vi.fn(() => child);
  const home = mkdtempSync(join(tmpdir(), 'gru-claude-own-'));
  const workspace = mkdtempSync(join(tmpdir(), 'gru-claude-own-ws-'));
  cleanupDirs.push(home, workspace);
  writeFileSync(configPathFor(home), `workspace_root = "${workspace}"\n`, 'utf-8');
  const base = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
  const config = { ...base, concurrency: { maxWorkers: 2 } };
  const runtime = new ClaudeCodeRuntime({
    config,
    store: new SessionStore(config.dataDir),
    binary: join(import.meta.dirname, 'helpers', 'claude-double.mjs'),
    spawnProcess: spawned as unknown as typeof spawn,
    killGraceMs: 5,
    reviewSettingsFile: join(home, 'absent-review-settings.json'),
    log: () => {},
  });
  class TestRegistry extends RuntimeRegistry {
    override runtimeIdFor(): RuntimeId { return 'claude-code' as RuntimeId; }
    override runtimeFor(): AgentRuntime { return runtime; }
  }
  return { registry: new TestRegistry({ config, store: {} as SessionStore, canReclaim: () => false }), runtime, spawned };
}

/** A real ChildProcess records exitCode/signalCode BEFORE it emits 'close'. */
function closeChild(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
  Object.assign(child, { exitCode: code, signalCode: signal });
  child.emit('close', code, signal);
}

async function spawnBusy(fx: ReturnType<typeof claudeRegistry>) {
  const resident = await fx.registry.spawn('minion');
  void resident.prompt('work').catch(() => {});
  await vi.waitFor(() => expect(fx.spawned).toHaveBeenCalled());
  await new Promise((resolve) => setImmediate(resolve));
  return resident;
}

describe('Claude Code cessation through the registry (runtime-neutral contract)', () => {
  it('a child that never started is ceased and releases the resident permit', async () => {
    const { registry } = claudeRegistry(fakeChild());
    const resident = await registry.spawn('minion');
    expect(registry.residents.occupied).toBe(1);
    await resident.dispose();
    expect(adapterCessationEvidence(resident)).toBe('ceased');
    expect(registry.residents.occupied).toBe(0);
    expect(registry.getHandle(resident.id)).toBeNull();
  });

  it('an observed close is ceased and releases ownership', async () => {
    const child = fakeChild();
    const fx = claudeRegistry(child);
    const { registry } = fx;
    const resident = await spawnBusy(fx);
    const disposing = resident.dispose();
    closeChild(child, null, 'SIGTERM');
    await disposing;
    expect(adapterCessationEvidence(resident)).toBe('ceased');
    expect(registry.residents.occupied).toBe(0);
    expect(registry.getHandle(resident.id)).toBeNull();
  });

  it('a deadline without close stays unknown and holds the permit until a late close releases it once', async () => {
    const child = fakeChild();
    const fx = claudeRegistry(child);
    const { registry } = fx;
    const resident = await spawnBusy(fx);
    vi.useFakeTimers();
    const disposing = resident.dispose();
    await vi.advanceTimersByTimeAsync(60);
    await disposing; // fulfilled, but NOT proof
    expect(adapterCessationEvidence(resident)).toBe('unknown');
    expect(registry.residents.occupied).toBe(1);
    expect(registry.getHandle(resident.id)).toBe(resident);
    closeChild(child, 0, null); // late, identity-bound close
    expect(adapterCessationEvidence(resident)).toBe('ceased');
    expect(registry.residents.occupied).toBe(0);
    expect(registry.getHandle(resident.id)).toBeNull();
  });

  it('a child transport error is unknown and holds the permit', async () => {
    const child = fakeChild();
    const fx = claudeRegistry(child);
    const { registry } = fx;
    const resident = await spawnBusy(fx);
    vi.useFakeTimers();
    const disposing = resident.dispose();
    child.emit('error', new Error('transport error'));
    await vi.advanceTimersByTimeAsync(60);
    await disposing;
    expect(adapterCessationEvidence(resident)).toBe('unknown');
    expect(registry.residents.occupied).toBe(1);
  });

  it('service shutdown disposes an unconfirmed Claude resident without releasing it, then exits cleanly', async () => {
    const child = fakeChild();
    const fx = claudeRegistry(child);
    const { registry } = fx;
    const resident = await spawnBusy(fx);
    vi.useFakeTimers();
    const exits: number[] = [];
    startServiceShutdown({
      signal: 'SIGTERM', exitCode: 0, serviceStop: new AbortController(), exit: (code) => { exits.push(code); },
      logger: { info: () => {}, error: () => {} },
      state: { registry, handle: { stop: async () => {} } as never },
    });
    await vi.advanceTimersByTimeAsync(200);
    // Teardown also awaits real I/O the fake clock cannot advance; poll rather
    // than assume it finished inside a fixed number of microtask turns (flaked
    // under CPU load). Bounded well below the 15s force-exit guard.
    await vi.waitFor(() => expect(exits).toEqual([0]), { timeout: 3_000 });
    expect(adapterCessationEvidence(resident)).toBe('unknown');
    expect(registry.residents.occupied).toBe(1); // unconfirmed exit stays visible debt
  });

  it('service shutdown with an observed Claude exit releases ownership', async () => {
    const child = fakeChild();
    const fx = claudeRegistry(child);
    const { registry } = fx;
    const resident = await spawnBusy(fx);
    const exits: number[] = [];
    startServiceShutdown({
      signal: 'SIGTERM', exitCode: 0, serviceStop: new AbortController(), exit: (code) => { exits.push(code); },
      logger: { info: () => {}, error: () => {} },
      state: { registry, handle: { stop: async () => {} } as never },
    });
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalled());
    closeChild(child, null, 'SIGTERM');
    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(adapterCessationEvidence(resident)).toBe('ceased');
    expect(registry.residents.occupied).toBe(0);
  });
});
