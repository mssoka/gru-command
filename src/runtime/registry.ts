import { RUNTIME_IDS, resolveSpawnPolicy, type Role, type RuntimeId } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { GrowthReport, SessionStore } from '../sessions/store.js';
import type { PiRuntimeOptions } from './pi-adapter.js';
import { PiRuntime } from './pi-adapter.js';
import { isStreamingState, withFallbacks } from './fallbacks.js';
import type { AgentHandle, AgentRuntime } from './types.js';

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
}

export interface RuntimeRegistryOptions extends PiRuntimeOptions {
  readonly store: SessionStore;
}

/**
 * Runtime registry (EPICS E2 story 4/5; lands E1-deferred N4): resolves
 * which adapter hosts a role from config (default + per-role overrides),
 * creates adapters lazily, applies interface-layer fallbacks, and tracks
 * live handles for /health liveness.
 */
export class RuntimeRegistry {
  private readonly adapters = new Map<RuntimeId, AgentRuntime>();
  private readonly handles = new Set<AgentHandle>();
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

  /** The fallback-wrapped adapter for a runtime id (created on first use). */
  runtimeFor(id: RuntimeId): AgentRuntime {
    if (!(RUNTIME_IDS as readonly string[]).includes(id)) {
      throw new Error(`unknown runtime "${id}" (valid runtimes: ${RUNTIME_IDS.join(', ')})`);
    }
    let adapter = this.adapters.get(id);
    if (adapter === undefined) {
      if (id === 'pi') {
        adapter = withFallbacks(new PiRuntime(this.opts));
      } else {
        // E3 lands the claude-code adapter; resolving it before then is a
        // configuration referencing something that cannot host yet.
        throw new Error(`runtime "${id}" has no adapter implementation yet (arrives with the next epic)`);
      }
      this.adapters.set(id, adapter);
    }
    return adapter;
  }

  async spawn(role: Role, options: { resumeFile?: string; model?: string; thinkingLevel?: string } = {}): Promise<AgentHandle> {
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
      model: policy.model,
      thinkingLevel,
    });
    this.handles.add(handle);
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
