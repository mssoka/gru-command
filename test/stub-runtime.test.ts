import { describe, expect, it } from 'vitest';
import { withFallbacks } from '../src/runtime/fallbacks.js';
import type {
  AgentCapabilities,
  AgentHandle,
  AgentRuntime,
  AgentState,
  PromptOptions,
  RuntimeEvent,
} from '../src/runtime/types.js';

/**
 * A minimal controllable AgentRuntime used to exercise the INTERFACE
 * contract and the interface-layer fallback semantics (steer-unable →
 * queue-until-idle) without any SDK involvement.
 */
class ScriptRuntime implements AgentRuntime {
  readonly id = 'script';
  readonly steerMode: 'native' | 'queued';
  /** When true, the first turn's streaming state event fires a macrotask
   * LATE (simulates an adapter whose first event is async — the E3 hole). */
  deferStateEvents = false;
  /** Optional hold applied to the NEXT prompt-driven turn. */
  nextHold?: Promise<void>;
  /** When set, the NEXT prompt-driven turn rejects with this error. */
  nextError?: string;
  readonly capabilities: AgentCapabilities = {
    streaming: true,
    steer: 'queued',
    resume: 'file',
    images: false,
    thinking: true,
    thinkingLevelControl: false,
    followUp: false,
  };
  readonly calls: { op: 'prompt' | 'steer' | 'followUp'; text: string; owner: string }[] = [];
  handle: ScriptHandle | null = null;

  constructor(steerMode: 'native' | 'queued' = 'queued') {
    this.steerMode = steerMode;
    this.capabilities = { ...this.capabilities, steer: steerMode };
  }

  async spawn(): Promise<AgentHandle> {
    this.handle = new ScriptHandle(this);
    return this.handle;
  }
  health() {
    return { state: 'ok' as const };
  }
  async dispose(): Promise<void> {}
}

class ScriptHandle implements AgentHandle {
  readonly role = 'gru' as const;
  readonly id = 'script-1';
  readonly sessionFile = '/tmp/does-not-matter/script-1.jsonl';
  private state: AgentState = 'idle';
  private last: string | null = null;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();

  constructor(private readonly runtime: ScriptRuntime) {}

  /** Test hook: simulate a turn; stays streaming until `hold` resolves. */
  async simulateTurn(text: string, owner: string, hold?: Promise<void>): Promise<void> {
    this.runtime.calls.push({ op: 'prompt', text, owner });
    if (this.runtime.deferStateEvents) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    this.setState('streaming');
    if (hold !== undefined) await hold;
    else await new Promise((resolve) => setTimeout(resolve, 5));
    this.setState('idle');
  }

  /** Test hook: the turn dies in state 'error' (never reports 'idle'). */
  simulateError(): void {
    this.setState('error');
  }

  private setState(state: AgentState): void {
    this.state = state;
    this.last = new Date().toISOString();
    this.emit({ type: 'state', state });
  }
  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async prompt(text: string, options?: PromptOptions): Promise<void> {
    const owner = options?.owner ?? 'default';
    const hold = this.runtime.nextHold;
    this.runtime.nextHold = undefined;
    const error = this.runtime.nextError;
    this.runtime.nextError = undefined;
    if (error !== undefined) {
      this.setState('error');
      throw new Error(error);
    }
    await this.simulateTurn(text, owner, hold);
  }
  async steer(text: string, options?: PromptOptions): Promise<void> {
    const owner = options?.owner ?? 'default';
    this.runtime.calls.push({ op: 'steer', text, owner });
  }
  async followUp(text: string, options?: PromptOptions): Promise<void> {
    const owner = options?.owner ?? 'default';
    this.runtime.calls.push({ op: 'followUp', text, owner });
  }
  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  health() {
    return { state: this.state, lastActivity: this.last, sessionFile: this.sessionFile };
  }
  async dispose(): Promise<void> {
    this.setState('disposed');
  }
}

describe('interface-layer fallbacks (steer-unable → queue-until-idle)', () => {
  it('steer on a steer-unable runtime while idle delivers as a prompt', async () => {
    const inner = new ScriptRuntime('queued');
    const runtime = withFallbacks(inner);
    expect(runtime.capabilities.steer).toBe('queued');
    const handle = await runtime.spawn('gru');
    await handle.steer('hello', { owner: 'alice' });
    expect(inner.calls).toEqual([{ op: 'prompt', text: 'hello', owner: 'alice' }]);
  });

  it('steer while a turn is live is queued, then delivered after idle', async () => {
    const inner = new ScriptRuntime('queued');
    const runtime = withFallbacks(inner);
    const handle = await runtime.spawn('gru');

    // Hold a turn open (the inner handle simulates its own liveness).
    let release!: () => void;
    const hold = new Promise<void>((resolveHold) => {
      release = resolveHold;
    });
    const innerHandle = inner.handle!;
    const events: RuntimeEvent[] = [];
    handle.subscribe((event) => events.push(event));
    const inFlight = innerHandle.simulateTurn('first', 'alice', hold);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const steered = handle.steer('redirect!', { owner: 'bob' });
    await new Promise((resolve) => setTimeout(resolve, 1));
    // Not delivered while the turn is live:
    expect(inner.calls.filter((c) => c.text === 'redirect!')).toEqual([]);
    expect(events.some((e) => e.type === 'queued' && e.reason === 'steer-unable')).toBe(true);
    release();
    await inFlight;
    await steered; // resolves only after delivery
    expect(inner.calls).toContainEqual({ op: 'prompt', text: 'redirect!', owner: 'bob' });
    const steerIndex = inner.calls.findIndex((c) => c.text === 'redirect!');
    const firstIndex = inner.calls.findIndex((c) => c.text === 'first');
    expect(steerIndex).toBeGreaterThan(firstIndex);
  });

  it('native-steer runtimes pass through the wrapper unchanged', async () => {
    const inner = new ScriptRuntime('native');
    const runtime = withFallbacks(inner);
    expect(runtime).toBe(inner as unknown as AgentRuntime);
  });

  it('queued steers deliver in arrival order after the turn ends', async () => {
    const inner = new ScriptRuntime('queued');
    const runtime = withFallbacks(inner);
    const handle = await runtime.spawn('gru');
    let release!: () => void;
    const hold = new Promise<void>((resolveHold) => {
      release = resolveHold;
    });
    const innerHandle = inner.handle!;
    const inFlight = innerHandle.simulateTurn('turn-one', 'alice', hold);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const s1 = handle.steer('first-queued', { owner: 'bob' });
    const s2 = handle.steer('second-queued', { owner: 'carol' });
    release();
    await inFlight;
    await Promise.all([s1, s2]);
    const order = inner.calls.filter((c) => c.text.endsWith('-queued')).map((c) => c.text);
    expect(order).toEqual(['first-queued', 'second-queued']);
  });

  it('dispose rejects queued steers instead of dropping them silently', async () => {
    const inner = new ScriptRuntime('queued');
    const runtime = withFallbacks(inner);
    const handle = await runtime.spawn('gru');
    let release!: () => void;
    const hold = new Promise<void>((resolveHold) => {
      release = resolveHold;
    });
    const innerHandle = inner.handle!;
    const inFlight = innerHandle.simulateTurn('turn', 'alice', hold);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const steered = handle.steer('never-lands', { owner: 'bob' });
    await handle.dispose();
    await expect(steered).rejects.toThrow(/disposed/);
    release();
    await inFlight;
    expect(inner.calls.some((c) => c.text === 'never-lands')).toBe(false);
  });

  it('prompt while a turn is live also queues (uniform never-interleave, ruling 1)', async () => {
    const inner = new ScriptRuntime('queued');
    const runtime = withFallbacks(inner);
    const handle = await runtime.spawn('gru');
    let release!: () => void;
    const hold = new Promise<void>((resolveHold) => {
      release = resolveHold;
    });
    const innerHandle = inner.handle!;
    const events: RuntimeEvent[] = [];
    handle.subscribe((event) => events.push(event));
    const inFlight = innerHandle.simulateTurn('first', 'alice', hold);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const second = handle.prompt('second', { owner: 'bob' });
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(inner.calls.filter((c) => c.text === 'second')).toEqual([]);
    expect(events.some((e) => e.type === 'queued')).toBe(true);
    release();
    await inFlight;
    await second;
    expect(inner.calls.findIndex((c) => c.text === 'second')).toBeGreaterThan(
      inner.calls.findIndex((c) => c.text === 'first'),
    );
  });

  it('a turn ending in ERROR still drains the queue (no stranded callers)', async () => {
    const inner = new ScriptRuntime('queued');
    const runtime = withFallbacks(inner);
    const handle = await runtime.spawn('gru');
    const innerHandle = inner.handle!;
    let release!: () => void;
    const hold = new Promise<void>((resolveHold) => {
      release = resolveHold;
    });
    const inFlight = innerHandle.simulateTurn('turn', 'alice', hold);
    await new Promise((resolve) => setTimeout(resolve, 1));
    const steered = handle.steer('queued-during-error', { owner: 'bob' });
    innerHandle.simulateError(); // turn dies in state 'error', never 'idle'
    release();
    await inFlight;
    await steered; // must settle, not hang forever
    expect(inner.calls).toContainEqual({
      op: 'prompt',
      text: 'queued-during-error',
      owner: 'bob',
    });
  });

  it('steer issued synchronously after prompt cannot interleave (busy before first event)', async () => {
    const inner = new ScriptRuntime('queued');
    inner.deferStateEvents = true; // first streaming event arrives ~10ms late
    const runtime = withFallbacks(inner);
    const handle = await runtime.spawn('gru');
    let release!: () => void;
    inner.nextHold = new Promise<void>((resolveHold) => {
      release = resolveHold;
    });
    // First turn delegated; the inner's streaming event arrives LATE. A
    // synchronous follow-up must still queue (busy is set synchronously).
    const first = handle.prompt('turn', { owner: 'alice' });
    const steered = handle.steer('sync-steer', { owner: 'bob' });
    // Immediately: not delivered mid-turn even though no event has fired.
    expect(inner.calls.filter((c) => c.text === 'sync-steer')).toEqual([]);
    release();
    await first;
    await steered;
    expect(inner.calls).toContainEqual({ op: 'prompt', text: 'sync-steer', owner: 'bob' });
  });
});

describe('Perkins r1 regressions (fallback)', () => {
  it('B2: a prompt during a PUMPED turn queues too (pump holds busy)', async () => {
    const inner = new ScriptRuntime('queued');
    const runtime = withFallbacks(inner);
    const handle = await runtime.spawn('gru');
    let release1!: () => void;
    let release2!: () => void;
    const hold1 = new Promise<void>((r) => (release1 = r));
    const hold2 = new Promise<void>((r) => (release2 = r));
    inner.nextHold = hold1;
    const first = handle.prompt('turn-one', { owner: 'alice' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const steered = handle.steer('steer-queued', { owner: 'bob' });
    // The pumped turn gets its own hold so a fresh prompt lands mid-pump:
    inner.nextHold = hold2;
    release1();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 1));
    // 'steer-queued' is now being delivered by the pump (busy held):
    const third = handle.prompt('third', { owner: 'carol' });
    expect(inner.calls.filter((c) => c.text === 'third')).toEqual([]);
    release2();
    await steered;
    await third;
    expect(inner.calls.map((c) => c.text)).toEqual(['turn-one', 'steer-queued', 'third']);
  });

  it('N15: followUp passes through to the inner runtime when idle', async () => {
    const inner = new ScriptRuntime('queued');
    const runtime = withFallbacks(inner);
    const handle = await runtime.spawn('gru');
    await handle.followUp('ping', { owner: 'alice' });
    expect(inner.calls).toContainEqual({ op: 'prompt', text: 'ping', owner: 'alice' });
  });

  it('N15b: a rejecting delivery resets busy and does not strand the queue', async () => {
    const inner = new ScriptRuntime('queued');
    const runtime = withFallbacks(inner);
    const handle = await runtime.spawn('gru');
    inner.nextError = 'delivery exploded';
    await expect(handle.steer('fails', { owner: 'alice' })).rejects.toThrow(/delivery exploded/);
    // busy was reset: the next call delivers normally.
    await handle.steer('works', { owner: 'alice' });
    expect(inner.calls).toContainEqual({ op: 'prompt', text: 'works', owner: 'alice' });
  });
});
