import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import type { Api, Model, ThinkingLevel } from '@earendil-works/pi-ai';
import { dirname, isAbsolute, relative } from 'node:path';
import type { GruCommandConfig, Role } from '../config.js';
import { resolveSpawnPolicy } from '../config.js';
import type { LogLevel } from '../logger.js';
import { ROLE_DEFINITIONS } from '../roles.js';
import { LockBusyError, type SessionStore } from '../sessions/store.js';
import { resolveSpawnCwd } from './cwd.js';
import { normalizeSessionPath, SessionAlreadyActiveError } from './session-paths.js';

// E3 extracted the shared session-path helpers; re-export so existing
// consumers of the pi adapter's surface keep working.
export { normalizeSessionPath, SessionAlreadyActiveError };
import { capabilitiesForModelInput } from './types.js';
import type {
  AgentCapabilities,
  AgentHandle,
  AgentRuntime,
  AgentState,
  ContextUsage,
  PromptOptions,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeHealth,
  SpawnOptions,
} from './types.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

const COMPACTION_END_RECONCILE_MS = 5_000;

/** pi adapter capabilities, hoisted so the runtime probe can report them
 * without constructing the adapter (E3 story 3). */
export const PI_CAPABILITIES: AgentCapabilities = {
  streaming: true,
  steer: 'native',
  resume: 'file',
  // Adapter transport support. A spawned handle overrides this from the
  // resolved model's declared input modalities (B1).
  images: true,
  thinking: true,
  thinkingLevelControl: true,
  followUp: true,
};

export interface PiRuntimeOptions {
  readonly config: GruCommandConfig;
  readonly store: SessionStore;
  /** pi agent dir (settings/models/auth/skills discovery). Defaults to the user's. */
  readonly agentDir?: string;
  /** Tests inject a runtime pre-loaded with a stub provider. */
  readonly modelRuntime?: ModelRuntime;
  readonly log?: Log;
}

interface QueuedMessage {
  readonly text: string;
  readonly owner: string;
  readonly images?: PromptOptions['images'];
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  /** Opt-in queued-wait cap (E7): rejects THIS caller when it fires. */
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Reference AgentRuntime over the pi SDK (EPICS E2 story 2; SPEC ruling 4).
 *
 * One PiRuntime hosts any number of AgentHandles; each handle wraps one
 * SDK AgentSession persisted as append-only jsonl under the instance data
 * dir (via SessionStore's dirs) and enforces the single-writer rule
 * (SPEC ruling 1): while a turn is live, prompt/steer/followUp from
 * anyone but the turn's owner are queued-until-idle.
 */
export class PiRuntime implements AgentRuntime {
  readonly id = 'pi';
  readonly capabilities: AgentCapabilities = PI_CAPABILITIES;

  private readonly config: GruCommandConfig;
  private readonly store: SessionStore;
  private readonly agentDir: string;
  private readonly log: Log;
  private readonly handles = new Set<PiAgentHandle>();
  /** Normalized session paths currently hosted by this process (B4). */
  private readonly activeFiles = new Set<string>();
  private modelRuntime: ModelRuntime | undefined;
  private down: string | undefined;

  constructor(opts: PiRuntimeOptions) {
    this.config = opts.config;
    this.store = opts.store;
    this.agentDir = opts.agentDir ?? getAgentDir();
    this.log = opts.log ?? (() => {});
    this.modelRuntime = opts.modelRuntime;
  }

  private async runtime(): Promise<ModelRuntime> {
    if (this.modelRuntime === undefined) {
      // Offline create: built-in catalogs restored from local cache only.
      this.modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    }
    return this.modelRuntime;
  }

  /**
   * Fail-loud model resolution (SPEC ruling 16): "default" (or "") passes
   * through to pi's own resolution (session restore → settings → first
   * available); an explicit "provider/model" must resolve or spawn fails
   * naming the reference.
   */
  private async resolveModel(role: Role, override?: string): Promise<Model<Api> | undefined> {
    const ref =
      override !== undefined
        ? override
        : resolveSpawnPolicy(this.config, 'pi', role).model;
    if (ref === '' || ref === 'default') return undefined;
    const slash = ref.indexOf('/');
    if (slash <= 0 || slash >= ref.length - 1) {
      throw new Error(`model reference must be "provider/model" or "default", got: ${ref}`);
    }
    const provider = ref.slice(0, slash);
    const modelId = ref.slice(slash + 1);
    const model = (await this.runtime()).getModel(provider, modelId);
    if (model === undefined) {
      throw new Error(`unknown model "${ref}" — no such provider/model is registered`);
    }
    return model;
  }

  /** Thinking levels pi's session API accepts (fail-loud on typos: pi CAN set it). */
  private static readonly PI_THINKING_LEVELS: readonly ThinkingLevel[] = [
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ];

  private resolveThinkingLevel(role: Role, override?: string): ThinkingLevel | undefined {
    const ref =
      override !== undefined
        ? override
        : resolveSpawnPolicy(this.config, 'pi', role).thinkingLevel;
    if (ref === '' || ref === 'default') return undefined;
    if (!PiRuntime.PI_THINKING_LEVELS.includes(ref as ThinkingLevel)) {
      throw new Error(
        `unknown thinking level "${ref}" for pi (valid: default, ${PiRuntime.PI_THINKING_LEVELS.join(', ')})`,
      );
    }
    return ref as ThinkingLevel;
  }

  async spawn(role: Role, options: SpawnOptions = {}): Promise<AgentHandle> {
    const roleDef = ROLE_DEFINITIONS[role];
    // SPEC ruling 17: an explicit cwd roots the session in the project it
    // serves (the dispatch flow's worktree); absent = workspace root.
    const cwd = resolveSpawnCwd(this.config.workspaceRoot, options.cwd);
    const model = await this.resolveModel(role, options.model);
    const thinkingLevel = this.resolveThinkingLevel(role, options.thinkingLevel);
    // Normalize like the SDK (tilde + file://) so the lock key, the
    // active-file key, and the session's own path are one and the same.
    const resumeFile =
      options.resumeFile !== undefined ? normalizeSessionPath(options.resumeFile) : undefined;
    if (resumeFile !== undefined && this.activeFiles.has(resumeFile)) {
      throw new SessionAlreadyActiveError(resumeFile);
    }
    // Confinement: resume only files that live in the session store —
    // never open (or lock) arbitrary paths handed to the spawn options.
    // The isAbsolute branch covers Windows cross-drive escapes (relative()
    // then returns an absolute, backslashed path).
    if (resumeFile !== undefined) {
      const rel = relative(this.store.sessionsDir, resumeFile);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(
          `resumeFile must live under the session store (${this.store.sessionsDir}), got: ${resumeFile}`,
        );
      }
    }
    // Resume: lock BEFORE touching the file — a second writer must never
    // even open a session another process holds (single-writer, ruling 1).
    // A concurrent twin spawn may already hold it for THIS process (its
    // registration is still in flight) — track whether THIS call acquired:
    // lock removal is bound to acquisition ownership, never mere existence
    // (Perkins r2 B4-race: the loser must never delete the winner's lock).
    let lockAcquired = false;
    if (resumeFile !== undefined && !this.store.isHeld(resumeFile)) {
      this.store.acquireLock(resumeFile);
      lockAcquired = true;
    }
    try {
      const sessionManager =
        resumeFile !== undefined
          ? SessionManager.open(resumeFile, dirname(resumeFile), cwd)
          : SessionManager.create(cwd, this.store.sessionDirFor(role, cwd));
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: this.agentDir,
        systemPromptOverride: () => roleDef.systemPrompt,
      });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd,
        agentDir: this.agentDir,
        model,
        ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
        tools: [...roleDef.tools],
        resourceLoader: loader,
        sessionManager,
        modelRuntime: await this.runtime(),
      });
      const sessionFile = session.sessionFile ?? null;
      if (sessionFile === null) {
        session.dispose();
        throw new Error('pi session is not persisted to a file — refusing untracked session');
      }
      if (this.activeFiles.has(sessionFile)) {
        session.dispose();
        throw new SessionAlreadyActiveError(sessionFile);
      }
      // Winner ensures the lock is held: a losing twin that pre-acquired
      // may have released between our pre-check and here.
      try {
        if (!this.store.isHeld(sessionFile)) {
          this.store.acquireLock(sessionFile);
        }
      } catch (error) {
        session.dispose();
        throw error;
      }
      this.activeFiles.add(sessionFile);
      const handle = new PiAgentHandle(
        role,
        session,
        sessionFile,
        capabilitiesForModelInput(PI_CAPABILITIES, session.model?.input),
        this.store,
        this.log,
        () => {
          this.handles.delete(handle);
          this.activeFiles.delete(sessionFile);
        },
      );
      this.handles.add(handle);
      this.down = undefined;
      return handle;
    } catch (error) {
      // Release ONLY a lock THIS call acquired, and ONLY when no winner
      // hosts the file (a registered twin owns the lock's lifetime now).
      if (lockAcquired && resumeFile !== undefined && !this.activeFiles.has(resumeFile)) {
        this.store.releaseLock(resumeFile);
      }
      // Infrastructure failure (store, loader, session create) marks the
      // adapter down; the NEXT spawn attempt re-clears it. Caller-facing
      // errors — bad model/thinking references (rejected above), a foreign
      // lock holder (LockBusyError), or losing a double-resume race
      // (SessionAlreadyActiveError) — are state conflicts, never health.
      if (
        !(error instanceof SessionAlreadyActiveError) &&
        !(error instanceof LockBusyError)
      ) {
        this.down = String(error);
      }
      throw error;
    }
  }

  health(): RuntimeHealth {
    if (this.down !== undefined) {
      return { state: 'down', note: this.down };
    }
    return { state: 'ok' };
  }

  async dispose(): Promise<void> {
    for (const handle of [...this.handles]) await handle.dispose();
  }
}

/**
 * Single-writer queue semantics (SPEC ruling 1/3):
 * - `prompt()` ALWAYS resolves after its own turn completes; if a turn is
 *   live (any owner), the prompt is queued and delivered when idle.
 * - `steer()`/`followUp()` from the LIVE TURN'S OWNER pass through to the
 *   SDK's native mid-turn channels; from anyone else they queue.
 * - Queued messages deliver in arrival order, one turn each, and emit a
 *   `queued` event so the surface layer can show honest state.
 */
/**
 * Map our PromptOptions images to the pi SDK's ImageContent shape
 * ({type:'image', data, mimeType}) — declared in agent-session.d.ts and
 * accepted by prompt/steer/followUp alike.
 */
function mapImages(images: PromptOptions['images']): unknown[] | undefined {
  if (images === undefined || images.length === 0) return undefined;
  return images.map((image) => ({
    type: 'image',
    data: image.data,
    mimeType: image.mediaType,
  }));
}

export class PiAgentHandle implements AgentHandle {
  readonly role: Role;
  readonly id: string;
  readonly sessionFile: string;
  readonly capabilities: AgentCapabilities;

  /** The principal unnamed callers are attributed to (single-writer). */
  private readonly principal: string;
  private state: AgentState = 'idle';
  private lastActivity: string | null = null;
  private stateError: string | undefined;
  private liveOwner: string | null = null;
  private liveTurn: Promise<void> | null = null;
  private readonly queue: QueuedMessage[] = [];
  private readonly listeners = new Set<RuntimeEventListener>();
  /** Covers the await gap before Pi exposes session.isCompacting. */
  private compacting = false;
  private pendingCompactionEnd: RuntimeEvent | null = null;
  private nativeCompactionOpen = false;
  private compactionEndDeadline = 0;
  private compactionEndTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitCompactionTerminal: {
    readonly resolve: (event: Extract<RuntimeEvent, { type: 'compaction_end' }>) => void;
  } | null = null;
  private disposed = false;

  constructor(
    role: Role,
    private readonly session: {
      prompt(text: string, options?: unknown): Promise<void>;
      steer(text: string, images?: unknown): Promise<void>;
      followUp(text: string, images?: unknown): Promise<void>;
      subscribe(listener: (event: unknown) => void): () => void;
      dispose(): void;
      compact(customInstructions?: string): Promise<unknown>;
      getContextUsage(): {
        readonly tokens: number | null;
        readonly contextWindow: number;
        readonly percent: number | null;
      } | undefined;
      isStreaming: boolean;
      isIdle: boolean;
      isCompacting: boolean;
      readonly sessionId: string;
      readonly sessionFile: string | undefined;
    },
    sessionFile: string,
    capabilities: AgentCapabilities,
    private readonly store: SessionStore,
    private readonly log: Log,
    private readonly onDispose: () => void = () => {},
  ) {
    this.role = role;
    this.id = session.sessionId;
    this.sessionFile = sessionFile;
    this.capabilities = capabilities;
    // Unnamed callers share one principal PER HANDLE — one chat brain per
    // session (SPEC ruling 1). Two distinct sessions always differ, so a
    // stranger's steer/followUp queues instead of passing natively.
    this.principal = `handle:${this.id}`;
    session.subscribe((event) => this.onPiEvent(event));
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  health() {
    return {
      state: this.state,
      lastActivity: this.lastActivity,
      error: this.stateError,
      sessionFile: this.sessionFile as string | null,
    };
  }

  async prompt(text: string, options: PromptOptions = {}): Promise<void> {
    this.assertLive();
    if (this.compacting || this.session.isCompacting) {
      throw new Error('agent session is compacting; prompt requires an idle session');
    }
    const owner = options.owner ?? this.principal;
    if (this.liveTurn !== null) {
      return this.enqueue(text, owner, 'single-writer', options.images, options.timeoutMs);
    }
    return this.runTurn(text, owner, options.images);
  }

  async steer(text: string, options: PromptOptions = {}): Promise<void> {
    this.assertLive();
    if (this.compacting || this.session.isCompacting) {
      throw new Error('agent session is compacting; steer requires an idle session');
    }
    const owner = options.owner ?? this.principal;
    if (this.liveTurn !== null && owner === this.liveOwner) {
      await this.session.steer(text, mapImages(options.images));
      return;
    }
    if (this.liveTurn !== null) {
      return this.enqueue(text, owner, 'single-writer', options.images, options.timeoutMs);
    }
    return this.runTurn(text, owner, options.images);
  }

  async followUp(text: string, options: PromptOptions = {}): Promise<void> {
    this.assertLive();
    if (this.compacting || this.session.isCompacting) {
      throw new Error('agent session is compacting; follow-up requires an idle session');
    }
    const owner = options.owner ?? this.principal;
    if (this.liveTurn !== null && owner === this.liveOwner) {
      await this.session.followUp(text, mapImages(options.images));
      return;
    }
    if (this.liveTurn !== null) {
      return this.enqueue(text, owner, 'single-writer', options.images, options.timeoutMs);
    }
    return this.runTurn(text, owner, options.images);
  }

  getContextUsage = (): ContextUsage | null => {
    if (this.disposed || this.compacting || this.session.isStreaming || this.session.isCompacting) {
      return null;
    }
    const usage = this.session.getContextUsage();
    if (
      usage === undefined ||
      usage.tokens === null ||
      usage.percent === null ||
      !Number.isFinite(usage.tokens) ||
      !Number.isFinite(usage.contextWindow) ||
      !Number.isFinite(usage.percent) ||
      usage.tokens < 0 ||
      usage.contextWindow <= 0
    ) {
      return null;
    }
    return {
      tokens: usage.tokens,
      contextWindow: usage.contextWindow,
      percent: Math.max(0, Math.min(100, usage.percent)),
    };
  };

  canCompact = (): boolean =>
    !this.disposed &&
    !this.compacting &&
    this.liveTurn === null &&
    this.queue.length === 0 &&
    this.session.isIdle &&
    !this.session.isCompacting;

  isCompacting = (): boolean => this.compacting || this.session.isCompacting;

  compact = async (): Promise<void> => {
    this.assertLive();
    if (
      this.compacting ||
      this.liveTurn !== null ||
      this.queue.length > 0 ||
      !this.session.isIdle ||
      this.session.isCompacting
    ) {
      throw new Error('agent session is busy; compaction requires an idle session');
    }
    const id = this.id;
    const file = this.sessionFile;
    let resolveTerminal!: (
      event: Extract<RuntimeEvent, { type: 'compaction_end' }>,
    ) => void;
    const terminal = new Promise<Extract<RuntimeEvent, { type: 'compaction_end' }>>(
      (resolveTerminalPromise) => {
        resolveTerminal = resolveTerminalPromise;
      },
    );
    const waiter = { resolve: resolveTerminal };
    this.explicitCompactionTerminal = waiter;
    this.compacting = true;
    let failed = false;
    let failure: unknown;
    try {
      await this.session.compact();
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      this.compacting = false;
      if (failed || this.pendingCompactionEnd === null) {
        this.pendingCompactionEnd = {
          type: 'compaction_end',
          success: false,
          error:
            failed
              ? failure instanceof Error
                ? failure.message
                : String(failure)
              : 'native compaction settled without a terminal event',
        };
        this.nativeCompactionOpen = true;
        this.compactionEndDeadline = Date.now() + COMPACTION_END_RECONCILE_MS;
      }
      this.flushCompactionEndWhenSettled();
    }
    try {
      if (this.disposed) {
        throw new Error('agent session disposed during native compaction');
      }
      if (this.session.sessionId !== id || this.session.sessionFile !== file) {
        // Identity drift compromises the durable pointer regardless of whether
        // the native compaction also threw. Retire the handle; it must never
        // accept another prompt under the old advertised session identity.
        await this.dispose();
        throw new Error('native compaction changed session identity');
      }
      const outcome = await terminal;
      if (!outcome.success) throw new Error(outcome.error ?? 'native compaction failed');
    } finally {
      if (this.explicitCompactionTerminal === waiter) this.explicitCompactionTerminal = null;
    }
  };

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.compactionEndTimer !== null) clearTimeout(this.compactionEndTimer);
    this.compactionEndTimer = null;
    this.pendingCompactionEnd = null;
    this.nativeCompactionOpen = false;
    this.compactionEndDeadline = 0;
    const drained = this.queue.splice(0);
    for (const item of drained) {
      if (item.timer !== null) clearTimeout(item.timer);
      item.reject(new Error('agent session disposed before queued message was delivered'));
    }
    try {
      this.session.dispose();
    } finally {
      this.store.releaseLock(this.sessionFile);
      this.setState('disposed');
      this.onDispose();
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('agent session disposed');
  }

  private enqueue(
    text: string,
    owner: string,
    reason: 'single-writer' | 'steer-unable',
    images?: PromptOptions['images'],
    timeoutMs?: number,
  ): Promise<void> {
    this.emit({ type: 'queued', reason, owner });
    this.log('info', 'message queued (single-writer)', {
      role: this.role,
      session: this.id,
      owner,
    });
    return new Promise<void>((resolve, reject) => {
      const item: QueuedMessage = {
        text,
        owner,
        ...(images !== undefined ? { images } : {}),
        resolve,
        reject,
        timer: null,
      };
      // Opt-in queued-wait cap (E7): reject THIS caller only — and ONLY
      // while it is still held (never after delivery has started).
      if (timeoutMs !== undefined) {
        item.timer = setTimeout(() => {
          const at = this.queue.indexOf(item);
          if (at === -1) return; // already delivering — let it settle
          this.queue.splice(at, 1);
          reject(
            new Error(`queued wait timed out after ${timeoutMs}ms (turn never went idle)`),
          );
        }, timeoutMs);
        item.timer.unref?.();
      }
      this.queue.push(item);
    });
  }

  private runTurn(text: string, owner: string, images?: PromptOptions['images']): Promise<void> {
    this.liveOwner = owner;
    const promptOptions: Record<string, unknown> = {};
    const mapped = mapImages(images);
    if (mapped !== undefined) promptOptions['images'] = mapped;
    const turn = this.session
      .prompt(text, promptOptions)
      .catch((error: unknown) => {
        // A turn rejected by dispose() must not overwrite the terminal
        // 'disposed' state with 'error'.
        if (!this.disposed) {
          this.setState('error', String(error));
          this.emit({ type: 'error', error: String(error), fatal: false });
        }
        throw error;
      })
      .finally(() => {
        if (this.liveTurn === turn) {
          this.liveTurn = null;
          this.liveOwner = null;
          if (!this.disposed && this.state !== 'error') this.setState('idle');
          void this.drain();
        }
      });
    this.liveTurn = turn;
    return turn;
  }

  private async drain(): Promise<void> {
    while (!this.disposed && this.queue.length > 0 && this.liveTurn === null) {
      const next = this.queue.shift()!;
      if (next.timer !== null) clearTimeout(next.timer);
      try {
        await this.runTurn(next.text, next.owner, next.images);
        next.resolve();
      } catch (error) {
        next.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private setState(state: AgentState, error?: string): void {
    this.state = state;
    this.stateError = error;
    this.lastActivity = new Date().toISOString();
    this.emit({ type: 'state', state, error });
  }

  private emit(event: RuntimeEvent): void {
    this.lastActivity = new Date().toISOString();
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.log('warn', 'runtime event listener threw', { error: String(error) });
      }
    }
  }

  private flushCompactionEndWhenSettled(): void {
    if (this.disposed || this.pendingCompactionEnd === null) return;
    if (this.compacting || this.session.isCompacting) {
      if (this.compactionEndDeadline > 0 && Date.now() >= this.compactionEndDeadline) {
        this.pendingCompactionEnd = null;
        this.nativeCompactionOpen = false;
        this.compactionEndDeadline = 0;
        this.publishCompactionEnd({
          type: 'compaction_end',
          success: false,
          error: 'native compaction state did not settle after its terminal event',
        });
        void this.dispose().catch(() => {});
        return;
      }
      if (this.compactionEndTimer === null) {
        this.compactionEndTimer = setTimeout(() => {
          this.compactionEndTimer = null;
          this.flushCompactionEndWhenSettled();
        }, 10);
        this.compactionEndTimer.unref();
      }
      return;
    }
    const terminal = this.pendingCompactionEnd;
    this.pendingCompactionEnd = null;
    this.nativeCompactionOpen = false;
    this.compactionEndDeadline = 0;
    this.publishCompactionEnd(terminal as Extract<RuntimeEvent, { type: 'compaction_end' }>);
  }

  private publishCompactionEnd(
    terminal: Extract<RuntimeEvent, { type: 'compaction_end' }>,
  ): void {
    this.emit(terminal);
    this.explicitCompactionTerminal?.resolve(terminal);
  }

  /** Map pi SDK events onto the runtime-agnostic event surface. */
  private onPiEvent(event: unknown): void {
    const e = event as Record<string, unknown>;
    switch (e['type']) {
      case 'agent_start':
        this.setState('streaming');
        return;
      case 'agent_end':
        if (e['willRetry'] === true) return; // retry keeps the turn live
        // An errored turn stays 'error' (sticky until the next turn starts);
        // a clean turn settles to idle (or keeps streaming between turns).
        if (this.state !== 'error') {
          this.setState(this.session.isStreaming ? 'streaming' : 'idle');
        }
        return;
      case 'message_end': {
        // pi reports in-band model errors as an assistant message with
        // stopReason 'error' — surface it as a runtime error event.
        const msg = e['message'] as Record<string, unknown> | undefined;
        if (msg !== undefined && msg['role'] === 'assistant' && msg['stopReason'] === 'error') {
          const detail = String(msg['errorMessage'] ?? 'model error');
          this.emit({ type: 'error', error: detail, fatal: false });
          this.setState('error', detail);
        }
        return;
      }
      case 'turn_start':
        this.emit({ type: 'turn_start' });
        return;
      case 'turn_end':
        this.emit({ type: 'turn_end' });
        return;
      case 'compaction_start':
        this.nativeCompactionOpen = true;
        this.emit({ type: 'compaction_start' });
        return;
      case 'compaction_end': {
        const success = e['aborted'] !== true && typeof e['errorMessage'] !== 'string';
        this.pendingCompactionEnd = {
          type: 'compaction_end',
          success,
          ...(success
            ? {}
            : {
                error:
                  typeof e['errorMessage'] === 'string'
                    ? e['errorMessage']
                    : 'compaction aborted',
              }),
        };
        this.compactionEndDeadline = Date.now() + COMPACTION_END_RECONCILE_MS;
        // Pi dispatches this event before AgentSession clears isCompacting.
        // Publish only after the native gate is really open, or queued prompts
        // can race the SDK and fail as "still compacting".
        this.flushCompactionEndWhenSettled();
        return;
      }
      case 'message_update': {
        const inner = e['assistantMessageEvent'] as Record<string, unknown> | undefined;
        if (inner === undefined) return;
        if (inner['type'] === 'text_delta' && typeof inner['delta'] === 'string') {
          this.emit({ type: 'text_delta', delta: inner['delta'] });
        } else if (inner['type'] === 'thinking_delta' && typeof inner['delta'] === 'string') {
          this.emit({ type: 'thinking_delta', delta: inner['delta'] });
        }
        return;
      }
      case 'tool_execution_start':
        this.emit({
          type: 'tool_start',
          callId: String(e['toolCallId']),
          tool: String(e['toolName']),
        });
        return;
      case 'tool_execution_update':
        this.emit({ type: 'tool_update', callId: String(e['toolCallId']) });
        return;
      case 'tool_execution_end':
        this.emit({
          type: 'tool_end',
          callId: String(e['toolCallId']),
          isError: e['isError'] === true,
        });
        return;
      default:
        return;
    }
  }
}
