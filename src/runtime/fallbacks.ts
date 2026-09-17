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
 * never-interleave contract: every turn request (prompt, steer, followUp)
 * is serialized through one delivery pipeline — held while a turn is in
 * flight (event `queued`, reason by call site) and delivered in arrival
 * order once the agent reports a non-busy state (idle OR error — an
 * error-ended turn never strands the queue). Callers observe the queue
 * event and their call resolves after their delivered turn completes —
 * the same guarantee a native-steer runtime offers, implemented above
 * the adapter.
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

interface QueuedTurn {
  text: string;
  options: PromptOptions;
  resolve: () => void;
  reject: (error: Error) => void;
  /** Opt-in queued-wait cap (E7): rejects THIS caller when it fires. */
  timer: ReturnType<typeof setTimeout> | null;
}

class FallbackHandle implements AgentHandle {
  readonly role: Role;
  readonly id: string;
  readonly sessionFile: string | null;

  /** A turn is being delivered by THIS pipeline (set+clear per-path only). */
  private inFlight = false;
  /** The inner runtime reported a live turn via state events. */
  private stateBusy = false;
  private pumping = false;
  private disposed = false;
  private readonly queue: QueuedTurn[] = [];
  private readonly listeners = new Set<RuntimeEventListener>();

  constructor(private readonly inner: AgentHandle) {
    this.role = inner.role;
    this.id = inner.id;
    this.sessionFile = inner.sessionFile;
    inner.subscribe((event) => this.onInnerEvent(event));
  }

  private get busy(): boolean {
    return this.inFlight || this.stateBusy;
  }

  private onInnerEvent(event: RuntimeEvent): void {
    if (event.type === 'state') {
      this.stateBusy = isStreamingState(event.state);
      if (!this.busy) void this.pump();
      if (event.state === 'disposed') this.rejectQueue('agent session disposed');
    }
    this.emit(event);
  }

  prompt(text: string, options: PromptOptions = {}): Promise<void> {
    this.assertLive();
    return this.request(text, options, 'single-writer');
  }

  steer(text: string, options: PromptOptions = {}): Promise<void> {
    this.assertLive();
    return this.request(text, options, 'steer-unable');
  }

  followUp(text: string, options: PromptOptions = {}): Promise<void> {
    this.assertLive();
    return this.request(text, options, 'single-writer');
  }

  /**
   * One delivery pipeline: busy (in-flight or inner-reported) OR a
   * non-empty queue → hold; otherwise deliver immediately. A steering
   * message against an idle agent is just a prompt on every runtime.
   */
  private request(
    text: string,
    options: PromptOptions,
    reason: 'single-writer' | 'steer-unable',
  ): Promise<void> {
    if (this.busy || this.queue.length > 0) {
      const owner = options.owner ?? 'default';
      this.emit({ type: 'queued', reason, owner });
      return new Promise<void>((resolve, reject) => {
        const item: QueuedTurn = {
          text,
          options,
          resolve,
          reject,
          timer: null,
        };
        // Opt-in queued-wait cap (E7): reject THIS caller only.
        if (options.timeoutMs !== undefined) {
          item.timer = setTimeout(() => {
            const at = this.queue.indexOf(item);
            if (at !== -1) this.queue.splice(at, 1);
            reject(
              new Error(
                `queued wait timed out after ${options.timeoutMs}ms (turn never went idle)`,
              ),
            );
          }, options.timeoutMs);
          item.timer.unref?.();
        }
        this.queue.push(item);
      });
    }
    return this.deliver(text, options);
  }

  private async deliver(text: string, options: PromptOptions): Promise<void> {
    this.inFlight = true;
    try {
      await this.inner.prompt(text, options);
    } finally {
      this.inFlight = false;
      void this.pump();
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.busy) return;
    this.pumping = true;
    try {
      while (!this.disposed && this.queue.length > 0 && !this.busy) {
        const next = this.queue.shift()!;
        if (next.timer !== null) clearTimeout(next.timer);
        try {
          await this.deliver(next.text, next.options);
          next.resolve();
        } catch (error) {
          next.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.pumping = false;
      if (!this.busy && this.queue.length > 0 && !this.disposed) void this.pump();
    }
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
    this.rejectQueue('agent session disposed before queued message was delivered');
    await this.inner.dispose();
  }

  private rejectQueue(message: string): void {
    const drained = this.queue.splice(0);
    for (const item of drained) {
      if (item.timer !== null) clearTimeout(item.timer);
      item.reject(new Error(message));
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('agent session disposed');
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
