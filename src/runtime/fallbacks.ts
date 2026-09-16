import type { Role } from '../config.js';
import type {
  AgentHandle,
  AgentRuntime,
  AgentState,
  PromptOptions,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeHealth,
  SpawnOptions,
} from './types.js';

/**
 * Interface-layer capability fallbacks (EPICS E2 story 4).
 *
 * steer-unable runtimes (capabilities.steer === 'queued') get the uniform
 * never-interleave contract: while a turn is live, prompt() AND steer()
 * are held (event `queued`, reason 'steer-unable') and delivered in
 * arrival order once the agent reports a non-busy state (idle OR error —
 * an error-ended turn must never strand the queue). Callers observe the
 * queue event and their call resolves only after delivery — the same
 * no-interleaving guarantee every runtime offers its users.
 */
export function withFallbacks(runtime: AgentRuntime): AgentRuntime {
  if (runtime.capabilities.steer === 'native') return runtime;
  return new FallbackRuntime(runtime);
}

class FallbackRuntime implements AgentRuntime {
  readonly id: string;
  readonly capabilities: AgentRuntime['capabilities'];

  constructor(private readonly inner: AgentRuntime) {
    this.id = inner.id;
    this.capabilities = { ...inner.capabilities, steer: 'queued' as const };
  }

  async spawn(role: Role, options?: SpawnOptions): Promise<AgentHandle> {
    return new FallbackHandle(await this.inner.spawn(role, options));
  }

  health(): RuntimeHealth {
    return this.inner.health();
  }

  async dispose(): Promise<void> {
    await this.inner.dispose();
  }
}

class FallbackHandle implements AgentHandle {
  readonly role: Role;
  readonly id: string;
  readonly sessionFile: string | null;

  private busy = false;
  private pumping = false;
  private disposed = false;
  private readonly steerQueue: {
    text: string;
    options: PromptOptions;
    resolve: () => void;
    reject: (error: Error) => void;
  }[] = [];
  private readonly listeners = new Set<RuntimeEventListener>();

  constructor(private readonly inner: AgentHandle) {
    this.role = inner.role;
    this.id = inner.id;
    this.sessionFile = inner.sessionFile;
    inner.subscribe((event) => this.onInnerEvent(event));
  }

  private onInnerEvent(event: RuntimeEvent): void {
    if (event.type === 'state') {
      this.busy = isStreamingState(event.state);
      // Any non-busy state drains: an idle turn is the normal case; an
      // error-ended turn must not strand queued callers either.
      if (!this.busy && this.steerQueue.length > 0) void this.pump();
      if (event.state === 'disposed') this.rejectQueue('agent session disposed');
    }
    this.emit(event);
  }

  async prompt(text: string, options: PromptOptions = {}): Promise<void> {
    this.assertLive();
    if (this.busy) {
      return this.enqueue(text, options);
    }
    this.busy = true; // synchronous: state events arrive later (E3)
    return this.deliverPrompt(text, options);
  }

  steer(text: string, options: PromptOptions = {}): Promise<void> {
    this.assertLive();
    if (this.busy) {
      return this.enqueue(text, options);
    }
    this.busy = true; // synchronous: state events arrive later (E3)
    // Nothing live to steer — a steering message against an idle agent is
    // just a prompt on every runtime.
    return this.deliverPrompt(text, options);
  }

  private async deliverPrompt(text: string, options: PromptOptions): Promise<void> {
    try {
      await this.inner.prompt(text, options);
    } catch (error) {
      this.busy = false;
      void this.pump();
      throw error;
    }
    // prompt() resolves only after the turn completes — clear busy even
    // if the inner runtime never emits state events (they are not
    // guaranteed by the fallback contract alone).
    this.busy = false;
    void this.pump();
  }

  private enqueue(text: string, options: PromptOptions): Promise<void> {
    const owner = options.owner ?? 'default';
    this.emit({ type: 'queued', reason: 'steer-unable', owner });
    return new Promise<void>((resolve, reject) => {
      this.steerQueue.push({ text, options, resolve, reject });
    });
  }

  async followUp(text: string, options?: PromptOptions): Promise<void> {
    this.assertLive();
    return this.inner.followUp(text, options);
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  health() {
    return this.inner.health();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.rejectQueue('agent session disposed before queued steer was delivered');
    await this.inner.dispose();
  }

  private rejectQueue(message: string): void {
    const drained = this.steerQueue.splice(0);
    for (const item of drained) {
      item.reject(new Error(message));
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('agent session disposed');
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.disposed && this.steerQueue.length > 0 && !this.busy) {
        const next = this.steerQueue.shift()!;
        try {
          await this.inner.prompt(next.text, next.options);
          next.resolve();
        } catch (error) {
          next.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.pumping = false;
      // A turn that went idle-then-streaming mid-pump leaves residue.
      if (!this.busy && this.steerQueue.length > 0 && !this.disposed) void this.pump();
    }
  }

  private emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener faults never break the event surface.
      }
    }
  }
}

/** Narrowing helper for /health aggregation. */
export function isStreamingState(state: AgentState): boolean {
  return state === 'streaming' || state === 'spawning';
}
