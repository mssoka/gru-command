import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configPathFor, loadConfig } from '../src/config.js';
import { PiRuntime } from '../src/runtime/pi-adapter.js';
import { RuntimeRegistry } from '../src/runtime/registry.js';
import { SessionStore } from '../src/sessions/store.js';
import type { RuntimeEvent } from '../src/runtime/types.js';
import { makeIsolatedModelRuntime, makeStubModelRuntime, StubScript, type StubTurn } from './helpers/stub-model.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  home: string;
  workspace: string;
  agentDir: string;
  store: SessionStore;
  script: StubScript;
}

async function fixture(turns: readonly StubTurn[] = []): Promise<Fixture & { runtime: PiRuntime }> {
  const home = mkdtempSync(join(tmpdir(), 'gru-command-pi-'));
  const workspace = mkdtempSync(join(tmpdir(), 'gru-command-ws-'));
  const agentDir = mkdtempSync(join(tmpdir(), 'gru-command-agentdir-'));
  cleanupDirs.push(home, workspace, agentDir);
  writeFileSync(
    configPathFor(home),
    `workspace_root = "${workspace}"\n[models]\ndefault = "gru-stub/stub-model"\n`,
    'utf-8',
  );
  const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
  const store = new SessionStore(config.dataDir);
  const script = new StubScript(turns);
  const modelRuntime = await makeStubModelRuntime(script);
  const runtime = new PiRuntime({ config, store, agentDir, modelRuntime });
  return { home, workspace, agentDir, store, script, runtime };
}

function collect(handle: { subscribe(listener: (event: RuntimeEvent) => void): () => void }): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  handle.subscribe((event) => events.push(event));
  return events;
}

describe('PiRuntime over the stub model (offline SDK round-trip)', () => {
  it('spawns a session persisted under the instance sessions dir', async () => {
    const fx = await fixture();
    const handle = await fx.runtime.spawn('gru');
    try {
      expect(handle.role).toBe('gru');
      const expectedDir = fx.store.sessionDirFor('gru', fx.workspace);
      expect(handle.sessionFile).toContain(expectedDir);
      expect(handle.sessionFile).toMatch(/\.jsonl$/);
      // pi-standard file naming: <timestamp>_<uuid>.jsonl
      const sessionFile = handle.sessionFile!;
      const name = sessionFile.split('/').pop()!;
      expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T[\dT:.Z-]+_[0-9a-f-]{36}\.jsonl$/);
      // The session file is locked for the handle's lifetime.
      expect(existsSync(`${sessionFile}.lock`)).toBe(true);
    } finally {
      await handle.dispose();
    }
  });

  it('round-trips a prompt with ordered deltas, turn lifecycle, and a durable session file', async () => {
    const fx = await fixture([{ deltas: ['Hello', ' ', 'world'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('say hi', { owner: 'alice' });
      const deltas = events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta);
      expect(deltas).toEqual(['Hello', ' ', 'world']);
      expect(events.filter((e) => e.type === 'turn_start').length).toBe(1);
      expect(events.filter((e) => e.type === 'turn_end').length).toBe(1);
      const states = events.filter((e) => e.type === 'state').map((e) => (e as { state: string }).state);
      expect(states).toContain('streaming');
      expect(states[states.length - 1]).toBe('idle');
      expect(handle.health().lastActivity).not.toBeNull();
      // Durable jsonl: header + user message + assistant message, at least.
      const lines = readFileSync(handle.sessionFile!, 'utf-8').trim().split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(3);
      const header = JSON.parse(lines[0]!) as { type: string; cwd: string };
      expect(header.type).toBe('session');
      expect(header.cwd).toBe(fx.workspace);
    } finally {
      await handle.dispose();
    }
  });

  it('emits thinking deltas before text when the model reasons', async () => {
    const fx = await fixture([{ thinking: ['pondering'], deltas: ['answer'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('think hard');
      const kinds = events
        .filter((e) => e.type === 'thinking_delta' || e.type === 'text_delta')
        .map((e) => e.type);
      expect(kinds).toEqual(['thinking_delta', 'text_delta']);
    } finally {
      await handle.dispose();
    }
  });

  it('single-writer: a second owner while a turn is live queues, then delivers in order', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture([
      { deltas: ['first-turn'], hold },
      { deltas: ['second-turn'] },
    ]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      const alice = handle.prompt('q1', { owner: 'alice' });
      const bob = handle.prompt('q2', { owner: 'bob' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fx.script.calls.map((c) => c.prompt)).toEqual(['q1']);
      expect(events.some((e) => e.type === 'queued' && e.owner === 'bob')).toBe(true);
      release();
      await Promise.all([alice, bob]);
      expect(fx.script.calls.map((c) => c.prompt)).toEqual(['q1', 'q2']);
      // Turns never interleave: bob's turn starts strictly after alice's ends.
      const turnEnds = events.filter((e) => e.type === 'turn_end').length;
      const stateIdleAfterFirst = events.some((e) => e.type === 'state' && (e as { state: string }).state === 'idle');
      expect(turnEnds).toBe(2);
      expect(stateIdleAfterFirst).toBe(true);
    } finally {
      release();
      await handle.dispose();
    }
  });

  it("owner steer and followUp during the owner's live turn pass through natively", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture([{ deltas: ['base'], hold }, { deltas: ['steer'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      const alice = handle.prompt('go', { owner: 'alice' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Owner channels: no queueing, no throw.
      await handle.steer('adjust course', { owner: 'alice' });
      await handle.followUp('then summarize', { owner: 'alice' });
      release();
      await alice;
      // No single-writer queue events: owner channels are native.
      expect(events.some((e) => e.type === 'queued')).toBe(false);
      // The steering/followUp texts reach the model as delivered user turns
      // (pi delivers them after the in-flight tool call window).
      const delivered = fx.script.calls.map((c) => c.prompt);
      expect(delivered[0]).toBe('go');
      expect(delivered).toContain('adjust course');
      expect(delivered).toContain('then summarize');
    } finally {
      release();
      await handle.dispose();
    }
  });

  it('non-owner steer while live queues instead of interleaving', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture([{ deltas: ['a'], hold }, { deltas: ['b'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const alice = handle.prompt('mine', { owner: 'alice' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const bobSteer = handle.steer('bob tries', { owner: 'bob' });
      release();
      await Promise.all([alice, bobSteer]);
      // bob's steer became a queued follow-on prompt, delivered after idle.
      expect(fx.script.calls.map((c) => c.prompt)).toEqual(['mine', 'bob tries']);
    } finally {
      release();
      await handle.dispose();
    }
  });

  it('resumes a previous session file with history intact (process restart)', async () => {
    const fx = await fixture([{ deltas: ['first'] }]);
    const first = await fx.runtime.spawn('gru');
    await first.prompt('remember this', { owner: 'alice' });
    const file = first.sessionFile!;
    await first.dispose();
    const entriesBefore = readFileSync(file, 'utf-8').trim().split('\n').length;

    // "New process": fresh runtime over the same instance data dir.
    const second = await fixture([{ deltas: ['second'] }]);
    const resumed = await second.runtime.spawn('gru', { resumeFile: file });
    try {
      expect(resumed.sessionFile).toBe(file); // same file, no duplicate session
      await resumed.prompt('continue', { owner: 'alice' });
      const entriesAfter = readFileSync(file, 'utf-8').trim().split('\n').length;
      expect(entriesAfter).toBeGreaterThan(entriesBefore);
    } finally {
      await resumed.dispose();
    }
  });

  it('fails loud on an unknown model reference', async () => {
    const fx = await fixture();
    await expect(fx.runtime.spawn('gru', { model: 'nope/no-such-model' })).rejects.toThrow(
      /unknown model "nope\/no-such-model"/,
    );
  });

  it('accepts an explicit thinking level and fails loud on an invalid one (ruling 16)', async () => {
    const fx = await fixture([{ deltas: ['ok'] }]);
    const handle = await fx.runtime.spawn('gru', { thinkingLevel: 'high' });
    await handle.dispose();
    await expect(fx.runtime.spawn('gru', { thinkingLevel: 'banana' })).rejects.toThrow(
      /unknown thinking level "banana" for pi/,
    );
  });

  it('the "default" model sentinel passes through to the runtime harness', async () => {
    // No [models] default configured: policy resolves to "default", which
    // means "whatever pi itself would pick". pi's own resolution reads the
    // settings default — so we point the harness default at the stub
    // provider and prove the full passthrough path end-to-end.
    const fx = await fixture([{ deltas: ['passthrough'] }]);
    writeFileSync(
      join(fx.agentDir, 'settings.json'),
      `${JSON.stringify({ defaultProvider: 'gru-stub', defaultModel: 'stub-model' })}\n`,
      'utf-8',
    );
    const handle = await fx.runtime.spawn('gru', { model: 'default' });
    try {
      const events = collect(handle);
      await handle.prompt('sentinel check', { owner: 'alice' });
      expect(
        events.filter((e) => e.type === 'text_delta').map((e) => (e as { delta: string }).delta),
      ).toEqual(['passthrough']);
    } finally {
      await handle.dispose();
    }
  });

  it('the sentinel path fails LOUD when nothing is configured (no silent fallback)', async () => {
    // Stub-FREE isolated runtime: no provider is configured at all, so the
    // "default" sentinel resolves to nothing and prompt fails loudly
    // instead of silently rerouting to some other model.
    const home = mkdtempSync(join(tmpdir(), 'gru-command-pi-'));
    const workspace = mkdtempSync(join(tmpdir(), 'gru-command-ws-'));
    const agentDir = mkdtempSync(join(tmpdir(), 'gru-command-agentdir-'));
    cleanupDirs.push(home, workspace, agentDir);
    writeFileSync(
      configPathFor(home),
      `workspace_root = "${workspace}"\n`,
      'utf-8',
    );
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const store = new SessionStore(config.dataDir);
    const runtime = new PiRuntime({
      config,
      store,
      agentDir,
      modelRuntime: await makeIsolatedModelRuntime(),
    });
    const handle = await runtime.spawn('gru', { model: 'default' });
    await expect(handle.prompt('anyone there?', { owner: 'alice' })).rejects.toThrow(
      /No API key found for the selected model|no models available/i,
    );
    await handle.dispose();
  });

  it('dispose releases the session lock', async () => {
    const fx = await fixture();
    const handle = await fx.runtime.spawn('gru');
    const file = handle.sessionFile!;
    await handle.dispose();
    const fresh = new SessionStore(fx.store.dataDir);
    expect(() => fresh.acquireLock(file)).not.toThrow();
    fresh.releaseLock(file);
    expect(handle.health().state).toBe('disposed');
  });

  it('declares pi capabilities honestly in the matrix', async () => {
    const fx = await fixture();
    expect(fx.runtime.capabilities).toEqual({
      streaming: true,
      steer: 'native',
      resume: 'file',
      images: true,
      thinking: true,
      thinkingLevelControl: true,
      followUp: true,
    });
    expect(fx.runtime.health()).toEqual({ state: 'ok' });
  });
});

describe('RuntimeRegistry', () => {
  it('boots with growth detection, resolves roles to the configured runtime, and reports status', async () => {
    const fx = await fixture();
    const registry = new RuntimeRegistry({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store,
      agentDir: fx.agentDir,
      modelRuntime: await makeStubModelRuntime(new StubScript([{ deltas: ['ok'] }])),
    });
    const growth = registry.boot();
    expect(growth.findings).toEqual([]);
    expect(registry.runtimeIdFor('gru')).toBe('pi');
    expect(registry.runtimeIdFor('minion')).toBe('pi');

    const before = registry.status();
    expect(before.agentSession.state).toBe('no-session');
    expect(before.activeSessions).toBe(0);

    const handle = await registry.spawn('gru');
    try {
      await handle.prompt('status check', { owner: 'alice' });
      const after = registry.status();
      expect(after.agentSession.state).toBe('idle');
      expect(after.agentSession.lastActivity).not.toBeNull();
      expect(after.activeSessions).toBe(1);
    } finally {
      await registry.disposeHandle(handle);
    }
    expect(registry.status().activeSessions).toBe(0);
    await registry.dispose();
  });

  it('rejects an unknown runtime id loudly', () => {
    const store = new SessionStore(mkdtempSync(join(tmpdir(), 'gru-command-reg-')));
    cleanupDirs.push(store.dataDir);
    // Minimal config stand-in: the registry only reads runtimes for this
    // path and must never construct the pi adapter for a claude-code id.
    const config = { runtimes: { default: 'pi', roles: {} } } as never as Parameters<
      typeof RuntimeRegistry.prototype.runtimeFor
    > extends never
      ? never
      : never;
    void config;
    const registry = new RuntimeRegistry({
      config: { runtimes: { default: 'pi', roles: {} } } as never,
      store,
    });
    expect(() => registry.runtimeFor('claude-code')).toThrow(/no adapter implementation yet/);
  });
});
