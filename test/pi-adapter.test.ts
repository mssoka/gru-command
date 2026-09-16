import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configPathFor, loadConfig } from '../src/config.js';
import { PiRuntime, normalizeSessionPath } from '../src/runtime/pi-adapter.js';
import { RuntimeRegistry, applyThinkingFallback } from '../src/runtime/registry.js';
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

    // "New process": same instance data dir, fresh store + adapter.
    const config = loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester');
    const secondStore = new SessionStore(config.dataDir);
    const second = new PiRuntime({
      config,
      store: secondStore,
      agentDir: fx.agentDir,
      modelRuntime: await makeStubModelRuntime(new StubScript([{ deltas: ['second'] }])),
    });
    const resumed = await second.spawn('gru', { resumeFile: file });
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

  it('forwards image attachments to the model (capability kept honest)', async () => {
    const fx = await fixture([{ deltas: ['seen'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      await handle.prompt('look at this', {
        owner: 'alice',
        images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }],
      });
      expect(fx.script.calls.length).toBe(1);
      expect(fx.script.calls[0]!.imageCount).toBe(1);
    } finally {
      await handle.dispose();
    }
  });

  it('unnamed steer queues behind a NAMED owner (handle principal is not an alias)', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture([{ deltas: ['a'], hold }, { deltas: ['b'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const alice = handle.prompt('mine', { owner: 'alice' });
      await new Promise((resolve) => setTimeout(resolve, 10));
      // An UNNAMED steer while alice's turn is live: not alice's channel.
      const anon = handle.steer('anonymous nudge');
      release();
      await Promise.all([alice, anon]);
      expect(fx.script.calls.map((c) => c.prompt)).toEqual(['mine', 'anonymous nudge']);
    } finally {
      release();
      await handle.dispose();
    }
  });

  it('unnamed steer during the handle OWN turn passes natively (one brain per session)', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fx = await fixture([{ deltas: ['a'], hold }, { deltas: ['steered'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const first = handle.prompt('mine');
      await new Promise((resolve) => setTimeout(resolve, 10));
      await handle.steer('course correct');
      release();
      await first;
      // steered natively — the follow-up arrives as its own model turn
      expect(fx.script.calls.map((c) => c.prompt)).toContain('course correct');
    } finally {
      release();
      await handle.dispose();
    }
  });
});

describe('RuntimeRegistry', () => {
  it('boots with growth detection, resolves roles to the configured runtime, and reports status', async () => {
    const fx = await fixture();
    const registry = new RuntimeRegistry({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store,
      pi: {
        agentDir: fx.agentDir,
        modelRuntime: await makeStubModelRuntime(new StubScript([{ deltas: ['ok'] }])),
      },
    });
    const growth = registry.boot();
    expect(growth.findings).toEqual([]);
    expect(growth.snapshotState).toBe('missing'); // first boot ever
    expect(registry.runtimeIdFor('gru')).toBe('pi');
    expect(registry.runtimeIdFor('minion')).toBe('pi');

    const before = registry.status();
    expect(before.agentSession.state).toBe('no-session');
    expect(before.activeSessions).toBe(0);
    expect(before.adapters).toEqual([]); // adapters are created lazily

    const handle = await registry.spawn('gru');
    try {
      await handle.prompt('status check', { owner: 'alice' });
      const after = registry.status();
      expect(after.agentSession.state).toBe('idle');
      expect(after.agentSession.lastActivity).not.toBeNull();
      expect(after.activeSessions).toBe(1);
      expect(after.adapters).toEqual([{ id: 'pi', state: 'ok' }]);
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

  it('self-heals: a handle disposed directly leaves the registry set', async () => {
    const fx = await fixture();
    const registry = new RuntimeRegistry({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store,
      pi: {
        agentDir: fx.agentDir,
        modelRuntime: await makeStubModelRuntime(new StubScript([{ deltas: ['ok'] }])),
      },
    });
    registry.boot();
    const handle = await registry.spawn('gru');
    expect(registry.status().activeSessions).toBe(1);
    await handle.dispose(); // direct dispose, NOT registry.disposeHandle
    expect(registry.status().activeSessions).toBe(0);
    expect(registry.status().agentSession.state).toBe('no-session');
    await registry.dispose();
  });

  it('thinking fallback: a control-less adapter gets warn + default (ruling 16)', () => {
    const warns: string[] = [];
    const fakeAdapter = {
      id: 'fake',
      capabilities: {
        streaming: true,
        steer: 'queued' as const,
        resume: 'none' as const,
        images: false,
        thinking: false,
        thinkingLevelControl: false,
        followUp: false,
      },
    };
    const log = (level: string, msg: string) => {
      if (level === 'warn') warns.push(msg);
    };
    expect(applyThinkingFallback(fakeAdapter as never, 'high', log)).toBe('default');
    expect(warns.length).toBe(1);
    expect(warns[0]!).toContain('cannot set thinking level');
    // The sentinel and capable adapters pass through untouched:
    expect(applyThinkingFallback(fakeAdapter as never, 'default', log)).toBe('default');
    const capable = {
      id: 'capable',
      capabilities: { ...fakeAdapter.capabilities, thinkingLevelControl: true },
    };
    expect(applyThinkingFallback(capable as never, 'max', log)).toBe('max');
  });
});

describe('Perkins r1 regressions', () => {
  it('B3: images round-trip in the EXACT SDK shape (data + mimeType)', async () => {
    const fx = await fixture([{ deltas: ['seen'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      await handle.prompt('look', {
        owner: 'alice',
        images: [{ mediaType: 'image/png', data: 'aGVsbG8=' }],
      });
      expect(fx.script.calls[0]!.images).toEqual([
        { data: 'aGVsbG8=', mimeType: 'image/png' },
      ]);
    } finally {
      await handle.dispose();
    }
  });

  it('W6: tool lifecycle events map through (tool_start/tool_end with callId)', async () => {
    const fx = await fixture([
      { deltas: [], toolCall: { id: 'call-1', name: 'ls', args: {} } },
      { deltas: ['listed'] },
    ]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      await handle.prompt('list my files', { owner: 'alice' });
      const starts = events.filter((e) => e.type === 'tool_start') as {
        callId: string;
        tool: string;
      }[];
      expect(starts).toEqual([{ type: 'tool_start', callId: 'call-1', tool: 'ls' }] as never);
      const ends = events.filter((e) => e.type === 'tool_end') as {
        callId: string;
        isError: boolean;
      }[];
      expect(ends.length).toBe(1);
      expect(ends[0]!.callId).toBe('call-1');
      expect(typeof ends[0]!.isError).toBe('boolean');
      // The second model call (post-tool) delivered the text:
      expect(fx.script.calls.length).toBe(2);
    } finally {
      await handle.dispose();
    }
  });

  it('W7: error turn — in-band completion: error event + state error, then recovers', async () => {
    const fx = await fixture([{ deltas: [], error: 'model exploded' }, { deltas: ['recovered'] }]);
    const handle = await fx.runtime.spawn('gru');
    try {
      const events = collect(handle);
      // The SDK contract: failures AFTER acceptance surface through the
      // event/message stream, not a rejection — prompt() resolves, the
      // error is in-band, and the session stays usable (robustness, R3).
      await handle.prompt('boom', { owner: 'alice' });
      const errorEvents = events.filter((e) => e.type === 'error');
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);
      expect((errorEvents[0] as { error: string }).error).toContain('model exploded');
      expect(handle.health().state).toBe('error');
      expect(handle.health().error).toBeTruthy();
      // The handle recovers: next prompt works and ends idle.
      await handle.prompt('again', { owner: 'alice' });
      expect(handle.health().state).toBe('idle');
      const states = events.filter((e) => e.type === 'state').map((e) => (e as { state: string }).state);
      expect(states).toContain('error');
      expect(states[states.length - 1]).toBe('idle');
    } finally {
      await handle.dispose();
    }
  });

  it('W10: registry status aggregates streaming while a turn is live', async () => {
    let release!: () => void;
    const fx = await fixture();
    const registry = new RuntimeRegistry({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store,
      pi: {
        agentDir: fx.agentDir,
        modelRuntime: await makeStubModelRuntime(
          new StubScript([{ deltas: ['held'], hold: new Promise<void>((r) => (release = r)) }]),
        ),
      },
    });
    registry.boot();
    const handle = await registry.spawn('gru');
    const p = handle.prompt('hold it', { owner: 'alice' });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(registry.status().agentSession.state).toBe('streaming');
    expect(registry.status().agentSession.lastActivity).not.toBeNull();
    release();
    await p;
    expect(registry.status().agentSession.state).toBe('idle');
    await registry.dispose();
  });

  it('B4: double-resume of one session file in one process is rejected loudly', async () => {
    const fx = await fixture([{ deltas: ['one'] }]);
    const first = await fx.runtime.spawn('gru');
    await first.prompt('write something', { owner: 'alice' });
    const file = first.sessionFile!;
    await expect(fx.runtime.spawn('gru', { resumeFile: file })).rejects.toThrow(
      /already hosted by this process/,
    );
    // After the first handle disposes, the file can be re-hosted.
    await first.dispose();
    const resumed = await fx.runtime.spawn('gru', { resumeFile: file });
    await resumed.dispose();
  });

  it('N16: resume of a file locked by another process rejects without touching the file', async () => {
    const fx = await fixture([{ deltas: ['one'] }]);
    const first = await fx.runtime.spawn('gru');
    await first.prompt('write', { owner: 'alice' });
    const file = first.sessionFile!;
    await first.dispose();
    // Another "process" (fresh store instance, own bootId) holds the lock:
    const other = new SessionStore(fx.store.dataDir);
    other.acquireLock(file);
    const linesBefore = readFileSync(file, 'utf-8').split('\n').length;
    try {
      await expect(fx.runtime.spawn('gru', { resumeFile: file })).rejects.toThrow(/locked by pid/);
      expect(readFileSync(file, 'utf-8').split('\n').length).toBe(linesBefore);
      expect(existsSync(`${file}.lock`)).toBe(true); // theirs, intact
    } finally {
      other.releaseLock(file);
      other.dispose();
    }
  });

  it('N24: resumeFile outside the session store is refused', async () => {
    const fx = await fixture([]);
    await expect(
      fx.runtime.spawn('gru', { resumeFile: join(fx.home, 'elsewhere.jsonl') }),
    ).rejects.toThrow(/must live under the session store/);
  });

  it('N17: adapter health goes down on infrastructure failure and recovers', async () => {
    const fx = await fixture([{ deltas: ['ok'] }]);
    // Poison the sessions dir for the gru role: a FILE where the dir must be.
    const roleDir = fx.store.sessionDirFor('gru', fx.workspace);
    mkdirSync(join(roleDir, '..'), { recursive: true });
    writeFileSync(roleDir, 'not a dir', 'utf-8');
    await expect(fx.runtime.spawn('gru')).rejects.toThrow();
    expect(fx.runtime.health().state).toBe('down');
    // Next attempt clears it:
    rmSync(roleDir);
    const handle = await fx.runtime.spawn('gru');
    expect(fx.runtime.health().state).toBe('ok');
    await handle.dispose();
    // And validation errors (bad model refs) never latch 'down':
    await expect(fx.runtime.spawn('gru', { model: 'nope/nope' })).rejects.toThrow(/unknown model/);
    expect(fx.runtime.health().state).toBe('ok');
  });
});

describe('Perkins r1 boot-surface pins', () => {
  it('N12/N13: boot backs up tracked sessions and logs grown files with kind + byte delta', async () => {
    const fx = await fixture();
    // Seed a session file, snapshot it, then grow it "while down":
    const dir = fx.store.sessionDirFor('gru', fx.workspace);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, '2026-09-15T00-00-00-000Z_11111111-1111-1111-1111-111111111111.jsonl');
    writeFileSync(file, '{"type":"session","version":3}\n', 'utf-8');
    fx.store.persistSnapshot();
    writeFileSync(file, '{"type":"session","version":3}\n{"type":"message"}\n', 'utf-8');

    const logs: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
    const registry = new RuntimeRegistry({
      config: loadConfig({ GRU_COMMAND_HOME: fx.home }, '/home/tester'),
      store: fx.store,
      log: (level, msg, fields) => logs.push({ level, msg, fields }),
      pi: { agentDir: fx.agentDir, modelRuntime: await makeStubModelRuntime(new StubScript([])) },
    });
    const growth = registry.boot();
    expect(growth.findings.length).toBe(1);
    expect(growth.findings[0]!.kind).toBe('grew');
    // N13: the warn log names file + kind + byte delta:
    const warn = logs.find((l) => l.level === 'warn' && l.msg.includes('changed while service was down'));
    expect(warn).toBeDefined();
    expect(warn!.fields).toMatchObject({ file, kind: 'grew', byte_delta: 19 });
    // N12: the boot backup pass left a copy in the backups dir:
    const backupsDir = join(fx.store.sessionsDir, 'backups');
    const backups = readdirSync(backupsDir).filter((n) => n.endsWith('.bak'));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(backupsDir, backups[0]!), 'utf-8')).toContain('"type":"message"');
    // And the snapshot now covers the grown file (clean next boot):
    expect(new SessionStore(fx.store.dataDir).detectGrowth().findings).toEqual([]);
    registry.dispose();
  });
});

describe('path normalization', () => {
  it('W3: resume paths normalize like the SDK (tilde, file://, resolve)', () => {
    const home = process.env['HOME'] ?? '';
    expect(normalizeSessionPath('~/x/s.jsonl')).toBe(join(home, 'x', 's.jsonl'));
    expect(normalizeSessionPath('file:///tmp/a%20b/s.jsonl')).toBe(resolve('/tmp/a b/s.jsonl'));
    expect(normalizeSessionPath('./rel/s.jsonl')).toBe(resolve('./rel/s.jsonl'));
  });
});
