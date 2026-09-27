import { RUNTIME_IDS, resolveSpawnPolicy, type Role, type RuntimeId } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { GrowthReport, SessionStore } from '../sessions/store.js';
import { PiRuntime } from './pi-adapter.js';
import { ClaudeCodeRuntime } from './claude-adapter.js';
import type { ClaudeReviewSnapshot } from './claude-review-settings.js';
import { isStreamingState, withFallbacks } from './fallbacks.js';
import type { AgentHandle, AgentRuntime, RuntimeEvent, SpawnOptions } from './types.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/** What /health reports about the runtime layer (SPEC rulings 5 and 12). */
export interface RuntimeStatus {
  /** Aggregate agent-session state: streaming wins, then idle, else none. */
  readonly agentSession: {
    readonly state: 'streaming' | 'idle' | 'no-session';
    readonly lastActivity: string | null;
  };
  /** Boot-time growth report (null before the store has scanned). */
  readonly sessionGrowth: GrowthReport | null;
  readonly activeSessions: number;
  /** Per-adapter health — a 'down' adapter flips liveness.healthy false. */
  readonly adapters: readonly { readonly id: string; readonly state: string }[];
}

/** pi-adapter-only knobs (test seams) — kept out of the agnostic surface. */
export interface PiKnobs {
  readonly agentDir?: string;
  readonly modelRuntime?: PiRuntimeOptionsModelRuntime;
}

type PiRuntimeOptionsModelRuntime = ConstructorParameters<typeof PiRuntime>[0]['modelRuntime'];

/** claude-code-adapter-only knobs (test seams). */
export interface ClaudeKnobs {
  readonly binary?: string;
  readonly killGraceMs?: number;
  readonly reviewSettingsFile?: string;
}

export interface RuntimeRegistryOptions {
  readonly config: Parameters<typeof resolveSpawnPolicy>[0];
  readonly store: SessionStore;
  readonly log?: Log;
  /** pi adapter overrides (agentDir / model runtime — test seams). */
  readonly pi?: PiKnobs;
  /** claude-code adapter overrides (binary path / kill grace — test seams). */
  readonly claude?: ClaudeKnobs;
}

/**
 * A runtime event forwarded through the registry tap (E6): `event` is the
 * adapter event verbatim; `phase` wraps spawn/dispose boundaries the raw
 * event stream does not carry. sessionFile is the handle's declared path
 * at tap time (null before the file exists).
 */
export interface AgentEventEnvelope {
  readonly agentId: string;
  readonly role: Role;
  readonly sessionFile: string | null;
  readonly phase: 'spawned' | 'event' | 'disposed';
  readonly event?: RuntimeEvent;
}

export type AgentEventListener = (envelope: AgentEventEnvelope) => void;

/**
 * Runtime registry (EPICS E2 story 4/5; lands E1-deferred N4): resolves
 * which adapter hosts a role from config (default + per-role overrides),
 * creates adapters lazily, applies interface-layer fallbacks, and tracks
 * live handles for /health liveness.
 */
export class RuntimeRegistry {
  private readonly adapters = new Map<RuntimeId, AgentRuntime>();
  private readonly nativeAdapters = new Map<RuntimeId, PiRuntime | ClaudeCodeRuntime>();
  private readonly handles = new Set<AgentHandle>();
  private readonly agentListeners = new Set<AgentEventListener>();
  private readonly opts: RuntimeRegistryOptions;
  private readonly log: Log;
  private growth: GrowthReport | null = null;

  constructor(opts: RuntimeRegistryOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  /** Boot sequence: growth detection first (SPEC ruling 12), then backups. */
  boot(): GrowthReport {
    this.growth = this.opts.store.detectGrowth();
    for (const finding of this.growth.findings) {
      this.log('warn', 'session jsonl changed while service was down', {
        file: finding.file,
        kind: finding.kind,
        byte_delta: finding.grewByBytes,
        previous_bytes: finding.previousBytes,
        current_bytes: finding.currentBytes,
      });
    }
    this.opts.store.runBackup();
    this.opts.store.startHourlyBackup();
    return this.growth;
  }

  runtimeIdFor(role: Role): RuntimeId {
    return this.opts.config.runtimes.roles[role] ?? this.opts.config.runtimes.default;
  }

  /** Subscribe to every spawned handle's events (E6 board feed). Additive. */
  onAgentEvent(listener: AgentEventListener): () => void {
    this.agentListeners.add(listener);
    return () => {
      this.agentListeners.delete(listener);
    };
  }

  private emitAgentEvent(envelope: AgentEventEnvelope): void {
    for (const listener of this.agentListeners) {
      try {
        listener(envelope);
      } catch (error) {
        this.log('error', 'agent event listener failed', { error: String(error) });
      }
    }
  }

  /** A request-owned review model proof; no adapter stores it by role. */
  async prepareReviewModel(role: Role): Promise<ClaudeReviewSnapshot | undefined> {
    const id = this.runtimeIdFor(role);
    this.runtimeFor(id);
    const native = this.nativeAdapters.get(id)!;
    if (native instanceof ClaudeCodeRuntime) return native.prepareReviewModel(role);
    await native.checkReviewModel(role);
    return undefined;
  }

  async checkReviewModel(role: Role): Promise<void> {
    await this.prepareReviewModel(role);
  }

  /** The fallback-wrapped adapter for a runtime id (created on first use). */
  runtimeFor(id: RuntimeId): AgentRuntime {
    if (!(RUNTIME_IDS as readonly string[]).includes(id)) {
      throw new Error(`unknown runtime "${id}" (valid runtimes: ${RUNTIME_IDS.join(', ')})`);
    }
    let adapter = this.adapters.get(id);
    if (adapter === undefined) {
      if (id === 'pi') {
        const native = new PiRuntime({
          config: this.opts.config,
          store: this.opts.store,
          ...(this.opts.pi?.agentDir !== undefined ? { agentDir: this.opts.pi.agentDir } : {}),
          ...(this.opts.pi?.modelRuntime !== undefined ? { modelRuntime: this.opts.pi.modelRuntime } : {}),
          ...(this.opts.log !== undefined ? { log: this.opts.log } : {}),
        });
        this.nativeAdapters.set(id, native);
        adapter = withFallbacks(native);
      } else {
        // E3: the claude-code adapter hosts sessions on the headless CLI;
        // steer-unable, so the interface fallback wrapper serializes it.
        const native = new ClaudeCodeRuntime({
          config: this.opts.config,
          store: this.opts.store,
          ...(this.opts.claude?.binary !== undefined ? { binary: this.opts.claude.binary } : {}),
          ...(this.opts.claude?.killGraceMs !== undefined ? { killGraceMs: this.opts.claude.killGraceMs } : {}),
          ...(this.opts.claude?.reviewSettingsFile !== undefined ? { reviewSettingsFile: this.opts.claude.reviewSettingsFile } : {}),
          ...(this.opts.log !== undefined ? { log: this.opts.log } : {}),
        });
        this.nativeAdapters.set(id, native);
        adapter = withFallbacks(native);
      }
      this.adapters.set(id, adapter);
    }
    return adapter;
  }

  async spawn(role: Role, options: SpawnOptions = {}): Promise<AgentHandle> {
    if (options.reviewModel !== undefined && this.runtimeIdFor(role) !== 'claude-code') {
      throw new Error('Claude review model snapshot cannot be used with a different runtime');
    }
    const adapter = this.runtimeFor(this.runtimeIdFor(role));
    // SPEC ruling 16: resolve the model & thinking policy from config
    // (most specific wins) with spawn options overriding, "default"
    // passing straight through to the runtime harness.
    const policy = resolveSpawnPolicy(
      this.opts.config,
      this.runtimeIdFor(role),
      role,
      options.model !== undefined || options.thinkingLevel !== undefined
        ? {
            ...(options.model !== undefined ? { model: options.model } : {}),
            ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
          }
        : {},
    );
    const thinkingLevel = applyThinkingFallback(adapter, policy.thinkingLevel, this.log);
    const handle = await adapter.spawn(role, {
      ...(options.resumeFile !== undefined ? { resumeFile: options.resumeFile } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.isolatedReview !== undefined ? { isolatedReview: options.isolatedReview } : {}),
      ...(options.reviewLead !== undefined ? { reviewLead: options.reviewLead } : {}),
      ...(options.reviewModel !== undefined ? { reviewModel: options.reviewModel } : {}),
      model: policy.model,
      thinkingLevel,
    });
    this.handles.add(handle);
    // E6 event tap: surface spawn/dispose + forward every runtime event to
    // registry-level subscribers (the board engine's feed).
    this.emitAgentEvent({ agentId: handle.id, role, sessionFile: handle.sessionFile, phase: 'spawned' });
    handle.subscribe((event) => {
      this.emitAgentEvent({
        agentId: handle.id,
        role,
        sessionFile: handle.sessionFile,
        phase: 'event',
        event,
      });
      if (event.type === 'state' && event.state === 'disposed') {
        this.emitAgentEvent({ agentId: handle.id, role, sessionFile: handle.sessionFile, phase: 'disposed' });
      }
    });
    // Self-healing membership: a handle disposed by ANY caller leaves the
    // registry set — the status surface must never contradict itself.
    handle.subscribe((event) => {
      if (event.type === 'state' && event.state === 'disposed') {
        this.handles.delete(handle);
      }
    });
    return handle;
  }

  async disposeHandle(handle: AgentHandle): Promise<void> {
    this.handles.delete(handle);
    await handle.dispose();
  }

  /** Live handle by agent id (E7 supervision feed), or null. */
  getHandle(agentId: string): AgentHandle | null {
    for (const handle of this.handles) {
      if (handle.id === agentId) return handle;
    }
    return null;
  }

  /** Snapshot of every live handle (roll drain probe: mid-turn sessions). */
  listHandles(): readonly AgentHandle[] {
    return [...this.handles];
  }


  status(): RuntimeStatus {
    let anySession = false;
    let streaming = false;
    let lastActivity: string | null = null;
    for (const handle of this.handles) {
      const health = handle.health();
      if (health.state === 'disposed') continue;
      anySession = true;
      if (isStreamingState(health.state)) streaming = true;
      if (
        health.lastActivity !== null &&
        (lastActivity === null || health.lastActivity > lastActivity)
      ) {
        lastActivity = health.lastActivity;
      }
    }
    return {
      agentSession: {
        state: streaming ? 'streaming' : anySession ? 'idle' : 'no-session',
        lastActivity,
      },
      sessionGrowth: this.growth,
      activeSessions: this.handles.size,
      adapters: [...this.adapters.values()].map((adapter) => ({
        id: adapter.id,
        state: adapter.health().state,
      })),
    };
  }

  async dispose(): Promise<void> {
    for (const handle of [...this.handles]) await this.disposeHandle(handle);
    for (const adapter of this.adapters.values()) await adapter.dispose();
    this.adapters.clear();
  }
}

/**
 * Ruling-16 degrade: an adapter declaring thinkingLevelControl: false
 * cannot set the level — a non-default request degrades to warn +
 * proceed (the level is omitted, never silently ignored).
 */
export function applyThinkingFallback(
  adapter: AgentRuntime,
  thinkingLevel: string,
  log: Log = () => {},
): string {
  if (thinkingLevel !== 'default' && !adapter.capabilities.thinkingLevelControl) {
    log('warn', 'runtime cannot set thinking level — proceeding without it', {
      runtime: adapter.id,
      requested_thinking_level: thinkingLevel,
    });
    return 'default';
  }
  return thinkingLevel;
}
