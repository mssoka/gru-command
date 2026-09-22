import type { Role } from '../config.js';
import type {
  AgentHandle,
  AgentRuntime,
  AgentState,
  ContextUsage,
  PendingTurn,
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
  readonly reviewIsolation?: true;
  /** The wrapped handle's declared gaps surface unchanged (SPEC ruling 4). */
  readonly capabilities: AgentRuntime['capabilities'];
  readonly getContextUsage?: () => ContextUsage | null;
  readonly compact?: () => Promise<void>;
  readonly canCompact?: () => boolean;
  readonly isCompacting?: () => boolean;
  readonly hasLiveProcess?: () => boolean;
  readonly pendingTurn?: () => PendingTurn | null;

  /** A turn is being delivered by THIS pipeline (set+clear per-path only). */
  private inFlight = false;
  /** A native control owns the same single-operation lane as turns. */
  private controlInFlight = false;
  /** The inner runtime reported a live turn via state events. */
  private stateBusy = false;
  /** Automatic/provider-initiated compaction may bypass compact(). */
  private nativeCompacting = false;
  private explicitCompactionTerminal: Extract<RuntimeEvent, { type: 'compaction_end' }> | null = null;
  private explicitCompactionActive = false;
  private pumping = false;
  private disposed = false;
  private readonly queue: QueuedTurn[] = [];
  private readonly listeners = new Set<RuntimeEventListener>();

  constructor(private readonly inner: AgentHandle) {
    this.role = inner.role;
    this.id = inner.id;
    this.sessionFile = inner.sessionFile;
    if (inner.reviewIsolation === true) this.reviewIsolation = true;
    this.capabilities = inner.capabilities;
    // E7 pass-throughs: supervision's live-process probe and resume snapshot
    // must survive the queueing wrapper unchanged.
    if (inner.hasLiveProcess !== undefined) {
      this.hasLiveProcess = () => inner.hasLiveProcess!();
    }
    if (inner.pendingTurn !== undefined) {
      this.pendingTurn = () => inner.pendingTurn!();
    }
    if (inner.getContextUsage !== undefined) {
      this.getContextUsage = () => inner.getContextUsage!();
    }
    if (inner.canCompact !== undefined) {
      this.canCompact = () => !this.busy && this.queue.length === 0 && inner.canCompact!();
    }
    this.isCompacting = () =>
      this.controlInFlight || this.nativeCompacting || inner.isCompacting?.() === true;
    if (inner.compact !== undefined) {
      this.compact = async () => {
        this.assertLive();
        if (this.busy || this.queue.length > 0 || inner.isCompacting?.() === true) {
          throw new Error('agent session is busy; compaction requires an idle session');
        }
        this.controlInFlight = true;
        this.explicitCompactionActive = true;
        this.explicitCompactionTerminal = null;
        let failed = false;
        let failure: unknown;
        try {
          await inner.compact!();
        } catch (error) {
          failed = true;
          failure = error;
        } finally {
          this.controlInFlight = false;
          // A broken inner adapter may settle without a terminal event. Close
          // both this queue gate and the lifecycle seen by supervision, and
          // make the public compact promise reject from the same outcome.
          if (this.explicitCompactionTerminal === null) {
            this.explicitCompactionTerminal = {
              type: 'compaction_end',
              success: false,
              error: failed
                ? failure instanceof Error
                  ? failure.message
                  : String(failure)
                : 'native compaction ended without a terminal event',
            };
            this.nativeCompacting = false;
            this.emit(this.explicitCompactionTerminal);
          }
          this.explicitCompactionActive = false;
          void this.pump();
        }
        const outcome = this.explicitCompactionTerminal;
        this.explicitCompactionTerminal = null;
        if (failed) throw failure;
        if (outcome === null || !outcome.success) {
          throw new Error(outcome?.error ?? 'native compaction failed');
        }
      };
    }
    inner.subscribe((event) => this.onInnerEvent(event));
  }

  private get busy(): boolean {
    return this.inFlight || this.controlInFlight || this.stateBusy || this.nativeCompacting;
  }

  private onInnerEvent(event: RuntimeEvent): void {
    if (event.type === 'state') {
      this.stateBusy = isStreamingState(event.state);
      if (event.state === 'disposed') {
        this.nativeCompacting = false;
        this.rejectQueue('agent session disposed');
      }
    } else if (event.type === 'compaction_start') {
      this.nativeCompacting = true;
    } else if (event.type === 'compaction_end') {
      this.nativeCompacting = false;
      if (this.explicitCompactionActive) this.explicitCompactionTerminal = event;
    }
    // Observers must see the native terminal event before a synchronously
    // started queued prompt can emit the next turn's lifecycle.
    this.emit(event);
    if (!this.busy) void this.pump();
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
        // Opt-in queued-wait cap (E7): reject THIS caller only — and
        // ONLY while it is still held (a caller whose delivery already
        // started must never be told it timed out while the message is
        // in fact delivering).
        if (options.timeoutMs !== undefined) {
          item.timer = setTimeout(() => {
            const at = this.queue.indexOf(item);
            if (at === -1) return; // already delivering — let it settle
            this.queue.splice(at, 1);
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
