import {
  AgentSession,
  createAgentSession,
  createBashToolDefinition,
  createReadOnlyTools,
  defineTool,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { InlineExtension, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { getCurrentSystemPrompt, type Api, type Model, type ThinkingLevel } from '@earendil-works/pi-ai';
import { realpathSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { GruCommandConfig, Role } from '../config.js';
import type { ClaudeReviewSnapshot } from './claude-review-settings.js';
import { PI_THINKING_LEVELS, resolveModelRefreshPolicy, resolveSpawnPolicy } from '../config.js';
import type { LogLevel } from '../logger.js';
import { ROLE_DEFINITIONS } from '../roles.js';
import { LockBusyError, type SessionStore } from '../sessions/store.js';
import { resolveSpawnCwd } from './cwd.js';
import { carriesLaneEnv, laneProvenanceEnv, withoutLaneEnv } from '../worktrees/lane-provenance.js';
import { resolveGitCommit } from '../dispatch/perkins-review/artifacts.js';
import { normalizeSessionPath, SessionAlreadyActiveError } from './session-paths.js';

// E3 extracted the shared session-path helpers; re-export so existing
// consumers of the pi adapter's surface keep working.
export { normalizeSessionPath, SessionAlreadyActiveError };
import { capabilitiesForModelInput } from './types.js';
import { PI_CAPABILITIES } from './capabilities.js';
import { managedSkillsPromptNote, preferManagedSkills } from './managed-skills.js';
import { isVerificationProducer, workerVerificationRefusal, type WorkerVerificationPolicy } from './worker-verification-policy.js';
import { extractProviderRejectionEvidence } from '../provider-recovery/classify.js';
import type {
  AgentCapabilities,
  AgentHandle,
  AgentRuntime,
  AgentState,
  ContextUsage,
  NativeAgentTool,
  PendingTurn,
  PromptOptions,
  PromptTurnVerdict,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeHealth,
  SpawnOptions,
} from './types.js';
import { ToolHeartbeat, toolHeartbeatIntervalMs } from './tool-heartbeat.js';
import { disposeAll } from './disposal.js';
import { isPublicModelToken } from './review-model-identity.js';
import { DirectiveBookkeepingError, DirectiveCheckpointError, isNativeDirectiveRefusal, thrownDetail, thrownText, withOwnIo, inspectDirectiveCheckpoint, inspectDirectiveProducers, flushDirectiveToolIntent, recordDirectiveRetryStart, recordDirectiveIndependentController, prepareDirectiveBinding, prepareDirectiveProducer, recordDirectiveProducerCessation, recordDirectiveCompletion, recordDirectiveToolRefusal, recordDirectiveAuthorityRefusal, inspectDirectiveAdmission, readDirectiveBinding, type DirectiveProducer, type DirectiveTurnIdentity } from './directive-checkpoint.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;
type IsolatedToolName = NonNullable<SpawnOptions['isolatedReview']>['tools'][number];
type SdkTool = AgentSession['agent']['state']['tools'][number];

/** The prompt a session runs with. Pi 1.x derives `agent.state.systemPrompt`
 * from the transcript's system messages, which a session only has once its
 * first prompt ran; before that the SDK's own effective prompt is the
 * session's, and both name the same text afterwards. */
function effectiveSystemPrompt(session: AgentSession): string {
  return session.agent.state.messages.some((message) => message.role === 'system')
    ? session.agent.state.systemPrompt : session.systemPrompt;
}

/**
 * In-process SDK extension that blocks a known unscheduled verification
 * producer in the bash tool before it executes (issue #315). It intercepts
 * the runtime's own `tool_call` boundary, so the refusal happens before any
 * child process starts and the normal Bash behavior is otherwise unchanged.
 */
export function workerVerificationExtension(policy: WorkerVerificationPolicy): InlineExtension {
  return (pi) => {
    pi.on('tool_call', (event) => {
      const command = (event.input as { readonly command?: unknown }).command;
      if (event.toolName === 'bash' && typeof command === 'string' && isVerificationProducer(command, policy)) {
        return { block: true, reason: workerVerificationRefusal(policy) };
      }
      return undefined;
    });
  };
}

/**
 * #486: the bash tool of a session in a registered lane. Built as Pi builds
 * its own (the session's shell command prefix and shell path), with a spawn
 * hook that puts the lane's provenance in every command's environment, so a
 * daemon a command leaves behind is still known as the lane's. Lane
 * variables the service inherited are dropped first; `laneEnv` null drops
 * them only (a session outside a lane, in a service started inside one).
 * It replaces Pi's built-in bash by name.
 */
export function laneBashTool(cwd: string, agentDir: string, laneEnv: Readonly<Record<string, string>> | null): ToolDefinition {
  const settings = SettingsManager.create(cwd, agentDir);
  const commandPrefix = settings.getShellCommandPrefix();
  const shellPath = settings.getShellPath();
  return defineTool(createBashToolDefinition(cwd, {
    ...(commandPrefix !== undefined ? { commandPrefix } : {}),
    ...(shellPath !== undefined ? { shellPath } : {}),
    spawnHook: (context) => ({ ...context, env: { ...withoutLaneEnv(context.env), ...(laneEnv ?? {}) } }),
  }));
}

function confinedReviewTools(cwd: string, requested: readonly IsolatedToolName[]): {
  readonly names: string[];
  readonly tools: ToolDefinition[];
} {
  const root = realpathSync(cwd);
  const wanted = new Set(requested);
  if (wanted.size !== requested.length) throw new Error('isolated review tool names must be unique');
  const tools = createReadOnlyTools(cwd)
    .filter((tool) => wanted.has(tool.name as IsolatedToolName))
    .map((tool) => {
      const original = tool.execute.bind(tool);
      const name = `review_${tool.name}`;
      return {
        ...tool,
        name,
        label: name,
        description: `${tool.description} Paths are confined to the immutable review working directory.`,
        async execute(toolCallId, rawParams, signal, onUpdate, _context) {
          const params = rawParams as Record<string, unknown>;
          const requestedPath = params['path'] === undefined ? '.' : params['path'];
          if (typeof requestedPath !== 'string' || requestedPath.includes('\0') || requestedPath.startsWith('file:')) {
            throw new Error('isolated review tool path is invalid');
          }
          const actual = realpathSync(resolve(root, requestedPath));
          const rel = relative(root, actual);
          if (rel.startsWith('..') || isAbsolute(rel)) {
            throw new Error('isolated review tool path escapes the review working directory');
          }
          return original(toolCallId, { ...params, path: actual } as never, signal, onUpdate);
        },
      } satisfies ToolDefinition;
    });
  if (tools.length !== wanted.size) throw new Error('isolated review requested an unavailable read-only tool');
  return { names: tools.map((tool) => tool.name), tools };
}

function nativeReviewTools(definitions: readonly NativeAgentTool[]): ToolDefinition[] {
  const names = new Set<string>();
  return definitions.map((definition) => {
    // Product-native tool names (review leads and, since issue #161,
    // non-review parent sessions): a lowercase snake-ish identifier.
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(definition.name) || names.has(definition.name)) {
      throw new Error(`invalid or duplicate native tool name: ${definition.name}`);
    }
    names.add(definition.name);
    return {
      name: definition.name,
      label: definition.name,
      description: definition.description,
      parameters: definition.inputSchema as ToolDefinition['parameters'],
      async execute(_toolCallId, params, signal) {
        const result = await definition.execute(params, signal);
        return {
          content: [{ type: 'text', text: result.text }],
          details: result.details ?? {},
          ...(result.terminate === true ? { terminate: true } : {}),
        };
      },
    } satisfies ToolDefinition;
  });
}

export const COMPACTION_END_RECONCILE_MS = 5_000;

/**
 * Bound on the pi adapter's native-settlement proof (abort + waitForIdle) before
 * it may attest 'ceased' through the runtime-neutral `adapterCessationEvidence`
 * contract (issue #341, Option A; claude-code proves cessation by observed child close). SDK 1.4 `AgentSession.dispose()` is synchronous
 * and never awaits `waitForIdle`, so the adapter follows disposal with a
 * bounded session `waitForIdle` before it may report 'ceased'. Mirrors the 5s
 * bridge-teardown cap in `review-mcp-bridge.ts` (`BRIDGE_CLOSE_TIMEOUT_MS`):
 * the same Promise.race against a REFERENCED timer (the bridge does not unref
 * it either), so an otherwise-drained event loop cannot exit mid-disposal
 * before the bound fires and disposal settles, and a stuck session can never
 * hang disposal past this window. Exported for the deterministic bound test.
 */
export const CESSATION_IDLE_TIMEOUT_MS = 5_000;

/** Named failure for a session that was disposed but did not confirm idle
 * inside {@link CESSATION_IDLE_TIMEOUT_MS}. Disposal tore the session down,
 * but 'ceased' asserts that ALL work stopped; a still-running turn must never
 * be reported as ceased, and dispose-only semantics must never be a silent
 * fallback (issue #341, Option A). */
export class CessationIdleTimeoutError extends Error {
  constructor(
    readonly sessionId: string,
    readonly timeoutMs: number,
  ) {
    super(
      `session ${sessionId} was disposed but did not reach idle within ${timeoutMs}ms; ` +
        "refusing to report 'ceased' — the turn may still be running, investigate " +
        'the hung session before treating this worker as stopped',
    );
    this.name = 'CessationIdleTimeoutError';
  }
}

/** Typed provenance from an SDK provider error object ONLY (numeric status
 * on the error, retry-after from its Headers). Anything else → null.
 * Exported for the deterministic adapter-provenance tests. */
export function typedFromSdkError(error: unknown): { origin: 'sdk-error'; status?: number; bodyCode?: string; retryAfterMs?: number } | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { status?: unknown; statusCode?: unknown; headers?: unknown };
  const status =
    typeof candidate.status === 'number' ? candidate.status :
    typeof candidate.statusCode === 'number' ? candidate.statusCode :
    undefined;
  if (status === undefined) return null;
  let bodyCode: string | undefined;
  try {
    const body = (error as { error?: unknown }).error;
    if (typeof body === 'object' && body !== null) {
      const code = (body as { error?: { code?: unknown } }).error?.code ?? (body as { code?: unknown }).code;
      if (typeof code === 'string' && code !== '') bodyCode = code;
      else if (typeof code === 'number' && Number.isInteger(code)) bodyCode = String(code);
    }
  } catch {
    bodyCode = undefined;
  }
  let retryAfterMs: number | undefined;
  try {
    const headers = candidate.headers;
    if (headers !== undefined && typeof headers === 'object' && typeof (headers as { get?: unknown }).get === 'function') {
      const get = (headers as { get(name: string): string | null }).get.bind(headers);
      const ms = get('retry-after-ms');
      const seconds = get('retry-after');
      const parsed = ms !== null ? Number.parseFloat(ms) : seconds !== null ? Number.parseFloat(seconds) * 1000 : Number.NaN;
      if (Number.isFinite(parsed) && parsed >= 0) retryAfterMs = parsed;
    }
  } catch {
    retryAfterMs = undefined;
  }
  return { origin: 'sdk-error', status, ...(bodyCode !== undefined ? { bodyCode } : {}), ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
}

/** Typed provenance from a provider TERMINAL message line only (the strict
 * machine-composed "<status>: <json-body>" transport shape). Arbitrary turn
 * exceptions and prose yield null — never provider evidence. Exported for
 * the deterministic adapter-provenance tests. */
export function typedFromProviderMessageLine(
  detail: string,
  provider: string,
  model: string,
): { origin: 'provider-message'; status?: number; bodyCode?: string } | null {
  const parsed = extractProviderRejectionEvidence({ provider, model, errorMessage: detail });
  if (parsed.status === undefined && parsed.bodyCode === undefined) return null;
  return {
    origin: 'provider-message',
    ...(parsed.status !== undefined ? { status: parsed.status } : {}),
    ...(parsed.bodyCode !== undefined ? { bodyCode: parsed.bodyCode } : {}),
  };
}
// The declaration now lives in the dependency-light `capabilities.js` so the
// runtime probe can report it without loading this adapter's SDK graph; the
// re-export keeps every existing import surface (and object identity) intact.
export { PI_CAPABILITIES };

export interface PiRuntimeOptions {
  readonly config: GruCommandConfig;
  readonly store: SessionStore;
  /** pi agent dir (settings/models/auth/skills discovery). Defaults to the user's. */
  readonly agentDir?: string;
  /** Tests inject a runtime pre-loaded with a stub provider. */
  readonly modelRuntime?: ModelRuntime;
  /** Test seam: override the long-tool heartbeat cadence. */
  readonly toolHeartbeatMs?: number;
  /** Tests inject a bounded "catalog became live" refresh. Production
   * defaults to one ModelRuntime.refresh({ allowNetwork: true }) bounded by
   * [runtimes.pi] model_refresh_timeout_ms. */
  readonly modelCatalogRefresh?: ModelCatalogRefresher;
  readonly log?: Log;
}

/** Outcome of one bounded model-catalog refresh attempt, shaped for error text. */
export interface ModelCatalogRefreshOutcome {
  readonly attempted: boolean;
  /** One-line result: completed / timed out / failed / skipped. */
  readonly detail: string;
}

export interface ModelCatalogRefreshRequest {
  readonly provider: string;
  readonly timeoutMs: number;
}

export type ModelCatalogRefresher = (
  runtime: ModelRuntime,
  request: ModelCatalogRefreshRequest,
) => Promise<ModelCatalogRefreshOutcome>;

/** Levenshtein distance — deterministic, allocation-light at these sizes. */
function editDistance(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, substitution);
    }
    previous = current;
  }
  return previous[b.length]!;
}

/** Up to `limit` closest candidate ids, ordered by edit distance then name. */
export function nearestMatches(
  target: string,
  candidates: readonly string[],
  limit = 3,
): string[] {
  return [...candidates]
    .map((candidate) => ({ candidate, distance: editDistance(target, candidate) }))
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        left.candidate.length - right.candidate.length ||
        left.candidate.localeCompare(right.candidate),
    )
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

/**
 * Actionable near-match hint for an unknown model reference: models of the
 * provider when it is registered, otherwise the nearest registered provider
 * ids (a typo'd provider is just as common as a typo'd model).
 */
function describeNearestModels(
  runtime: ModelRuntime,
  provider: string,
  modelId: string,
): string {
  if (runtime.getProvider(provider) === undefined) {
    const providers = runtime.getProviders().map((entry) => entry.id);
    if (providers.length === 0) {
      return `provider "${provider}" is not registered and no providers are registered`;
    }
    return `provider "${provider}" is not registered; nearest registered providers: ${nearestMatches(
      provider,
      providers,
    ).join(', ')}`;
  }
  const models = runtime.getModels(provider).map((entry) => entry.id);
  if (models.length === 0) {
    return `provider "${provider}" is registered but has no models in the catalog`;
  }
  return `nearest registered models for "${provider}": ${nearestMatches(modelId, models).join(', ')}`;
}

interface QueuedMessage {
  readonly text: string;
  readonly owner: string;
  readonly images?: PromptOptions['images'];
  readonly directive?: PromptOptions['directive'];
  readonly resolve: (verdict: PromptTurnVerdict) => void;
  readonly reject: (error: Error) => void;
  /** Opt-in queued-wait cap (E7): rejects THIS caller when it fires. */
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Read the effective defaultProvider/defaultModel through the SDK's own
 * SettingsManager — the same loader (BOM tolerance, global+project merge,
 * error capture) pi's session creation uses, so the eager path and pi's
 * fallthrough can never disagree on where a default is defined.
 *
 * - absent file(s) or a partial default (only one key) name nothing;
 * - empty / whitespace-only / null values name nothing (pi's own falsy
 *   semantics);
 * - a file that exists but cannot be read or parsed THROWS naming the
 *   file: swallowing it resurrects the cryptic "No API key found" the
 *   eager path exists to prevent;
 * - a non-string, non-null value for either key THROWS naming the file.
 */
function readSettingsDefault(
  cwd: string,
  agentDir: string,
): { provider: string; model: string } | undefined {
  const manager = SettingsManager.create(cwd, agentDir);
  const [firstError] = manager.drainErrors();
  if (firstError !== undefined) {
    const where = firstError.path ?? join(agentDir, 'settings.json');
    throw new Error(
      `pi ${firstError.scope} settings are unreadable or corrupt (${where}): ${firstError.error.message}. ` +
        `Fix or remove that file — pi cannot resolve the default model from it`,
    );
  }
  const read = (key: 'defaultProvider' | 'defaultModel', value: unknown): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      throw new Error(
        `pi settings ${key} must be a string, got ${typeof value} (check ${join(agentDir, 'settings.json')} ` +
          `and ${join(cwd, '.pi', 'settings.json')})`,
      );
    }
    return value.trim() === '' ? undefined : value;
  };
  const provider = read('defaultProvider', manager.getDefaultProvider());
  const model = read('defaultModel', manager.getDefaultModel());
  return provider !== undefined && model !== undefined ? { provider, model } : undefined;
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
  /** Long-tool heartbeat cadence override; derived from the supervision
   * window at spawn when unset (construction must not touch config). */
  private readonly toolHeartbeatMs: number | null;
  private readonly modelCatalogRefresh: ModelCatalogRefresher | undefined;
  private readonly handles = new Set<PiAgentHandle>();
  /** Normalized session paths currently hosted by this process (B4). */
  private readonly activeFiles = new Set<string>();
  private modelRuntime: ModelRuntime | undefined;
  private modelRuntimePending: Promise<ModelRuntime> | undefined;
  /** Only matching provider refreshes (or a full-catalog refresh) can share
   * their result. Different providers queue behind one another for the SDK. */
  private readonly catalogRefreshes = new Map<string, Promise<ModelCatalogRefreshOutcome>>();
  /** Opaque endpoints are checked only within this request; never hash or persist them. */
  private readonly reviewModels = new WeakMap<ClaudeReviewSnapshot, Model<Api>>();
  private catalogRefreshTail: Promise<void> = Promise.resolve();
  private down: string | undefined;

  constructor(opts: PiRuntimeOptions) {
    this.config = opts.config;
    this.store = opts.store;
    this.agentDir = opts.agentDir ?? getAgentDir();
    this.log = opts.log ?? (() => {});
    this.modelRuntime = opts.modelRuntime;
    this.toolHeartbeatMs = opts.toolHeartbeatMs ?? null;
    this.modelCatalogRefresh = opts.modelCatalogRefresh;
  }

  /** Long-tool heartbeat cadence for a new handle (config-derived). */
  private heartbeatMs(): number {
    return this.toolHeartbeatMs ?? toolHeartbeatIntervalMs(this.config.supervision.turnSilenceMs);
  }

  private async runtime(): Promise<ModelRuntime> {
    if (this.modelRuntime !== undefined) return this.modelRuntime;
    // Share initial offline creation as well as refresh: concurrent probe
    // and spawn must never resolve against different catalogue instances.
    this.modelRuntimePending ??= ModelRuntime.create({ refreshOnCreate: false });
    try {
      this.modelRuntime = await this.modelRuntimePending;
      return this.modelRuntime;
    } finally {
      this.modelRuntimePending = undefined;
    }
  }

  /** The shared offline model runtime (the same instance spawns resolve
   * through): read-only consumers — the provider-recovery probe — reuse
   * it instead of building a second catalog/auth snapshot. */
  runtimeHandle(): Promise<ModelRuntime> {
    return this.runtime();
  }

  /**
   * One bounded catalog refresh per unknown-model failure (concurrent
   * failures share the in-flight attempt). Healthy resolutions never call
   * this, so no network latency is added to the spawn hot path.
   */
  private async performCatalogRefresh(provider: string): Promise<ModelCatalogRefreshOutcome> {
    const policy = resolveModelRefreshPolicy(this.config, 'pi');
    if (!policy.enabled) {
      return {
        attempted: false,
        detail: 'skipped ([runtimes.pi] model_refresh = false)',
      };
    }
    try {
      const runtime = await this.runtime();
      if (this.modelCatalogRefresh !== undefined) {
        return await this.modelCatalogRefresh(runtime, {
          provider,
          timeoutMs: policy.timeoutMs,
        });
      }
      // Provider known → fetch only that provider's live catalog; unknown
      // provider → full refresh (reloads models.json too, so a provider
      // configured after boot can become visible).
      const targeted = runtime.getProvider(provider) !== undefined;
      const signal = AbortSignal.timeout(policy.timeoutMs);
      const result = await runtime.refresh({
        allowNetwork: true,
        ...(targeted ? { providers: [provider] } : {}),
        signal,
      });
      if (signal.aborted || result.aborted) {
        return { attempted: true, detail: `timed out after ${policy.timeoutMs} ms` };
      }
      const errors = [...result.errors].map(([id, error]) => `${id}: ${error.message}`);
      if (errors.length > 0) {
        return { attempted: true, detail: `failed (${errors.join('; ')})` };
      }
      return {
        attempted: true,
        detail: `completed within the ${policy.timeoutMs} ms budget`,
      };
    } catch (error) {
      return {
        attempted: true,
        detail: `failed (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }

  private async refreshCatalogOnce(provider: string): Promise<ModelCatalogRefreshOutcome> {
    const runtime = await this.runtime();
    const scope = runtime.getProvider(provider) === undefined ? '*' : provider;
    const inFlight = this.catalogRefreshes.get('*') ?? this.catalogRefreshes.get(scope);
    if (inFlight !== undefined) return inFlight;
    const refresh = this.catalogRefreshTail.then(() => this.performCatalogRefresh(provider));
    this.catalogRefreshTail = refresh.then(() => {}, () => {});
    this.catalogRefreshes.set(scope, refresh);
    try {
      return await refresh;
    } finally {
      if (this.catalogRefreshes.get(scope) === refresh) this.catalogRefreshes.delete(scope);
    }
  }

  /**
   * Resolve one concrete provider/model: offline catalog first, then —
   * only on a miss — one bounded live-catalog refresh and a re-resolve.
   * Returns the miss details alongside `undefined` so the caller's error
   * can name the refresh outcome and the nearest registered alternatives.
   */
  private async resolveWithCatalogFallback(
    provider: string,
    modelId: string,
    role: Role,
  ): Promise<{
    readonly model: Model<Api> | undefined;
    readonly refresh: ModelCatalogRefreshOutcome;
    readonly nearest: string;
  }> {
    const runtime = await this.runtime();
    const direct = runtime.getModel(provider, modelId);
    if (direct !== undefined) {
      return {
        model: direct,
        refresh: { attempted: false, detail: 'not needed' },
        nearest: '',
      };
    }
    const refresh = await this.refreshCatalogOnce(provider);
    const model = runtime.getModel(provider, modelId);
    if (model !== undefined) {
      this.log('info', 'model resolved after catalog refresh', {
        role,
        model: `${provider}/${modelId}`,
        refresh: refresh.detail,
      });
    }
    return { model, refresh, nearest: describeNearestModels(runtime, provider, modelId) };
  }

  /**
   * Fail-loud model resolution (SPEC ruling 16): "default" (or "") resolves
   * the USER's settings default eagerly (see resolveSettingsDefault) and
   * only falls through to pi's own resolution when settings name nothing;
   * an explicit "provider/model" must resolve or spawn fails naming the
   * reference, the catalog-refresh outcome, and the nearest registered
   * models for the provider.
   */
  private modelRef(role: Role, override?: string): string {
    return override !== undefined ? override : resolveSpawnPolicy(this.config, 'pi', role).model;
  }

  private async resolveModel(
    role: Role,
    override?: string,
    cwd: string = this.config.workspaceRoot,
    restored?: { readonly provider: string; readonly modelId: string },
  ): Promise<Model<Api> | undefined> {
    const ref = this.modelRef(role, override);
    if (ref === '' || ref === 'default') {
      // Precedence (documented, matches pi): a resumed session's persisted
      // model wins over the settings default; settings win over pi's own
      // "first available". Only the sentinel defers — an explicit
      // provider/model always wins over the session.
      if (restored !== undefined) {
        const persisted = (await this.runtime()).getModel(restored.provider, restored.modelId);
        if (persisted !== undefined) return persisted;
        this.log('warn', 'persisted session model is not registered; using the settings default', {
          role,
          model: `${restored.provider}/${restored.modelId}`,
        });
      }
      return this.resolveSettingsDefault(role, cwd);
    }
    const slash = ref.indexOf('/');
    if (slash <= 0 || slash >= ref.length - 1) {
      throw new Error(`model reference must be "provider/model" or "default", got: ${ref}`);
    }
    const provider = ref.slice(0, slash);
    const modelId = ref.slice(slash + 1);
    const { model, refresh, nearest } = await this.resolveWithCatalogFallback(
      provider,
      modelId,
      role,
    );
    if (model === undefined) {
      this.log('warn', 'model reference did not resolve after catalog fallback', {
        role,
        model: ref,
        refresh: refresh.detail,
      });
      throw new Error(
        `unknown model "${ref}" — not in the registered catalog; ` +
          `catalog refresh ${refresh.attempted ? 'attempted — ' : ''}${refresh.detail}; ` +
          `${nearest}. Fix the [models]/[runtimes.pi] reference or the provider's model catalog`,
      );
    }
    return model;
  }

  /**
   * The "default" sentinel means the user's configured default
   * (defaultProvider/defaultModel in <agentDir>/settings.json). Resolve it
   * EAGERLY and hand pi the explicit model: the shared offline ModelRuntime
   * (refreshOnCreate: false) never builds its auth snapshot, so pi's own
   * settings-default path — gated on hasConfiguredAuth() — rejects the
   * user's valid default and falls through to "first available"/nothing
   * (2026-09-20 report: chat + Bob consolidation died with "No API key
   * found for the selected model" while fully authed). Prompting an
   * explicitly-passed model bypasses the stale gate. When settings name
   * nothing, undefined preserves pi's own resolution (fresh installs).
   * Settings are read through the SDK SettingsManager for the session cwd
   * (global agentDir + project .pi/settings.json, exactly pi's merge).
   */
  private async resolveSettingsDefault(role: Role, cwd: string): Promise<Model<Api> | undefined> {
    const settingsDefault = readSettingsDefault(cwd, this.agentDir);
    if (settingsDefault === undefined) return undefined;
    const { provider, model: modelId } = settingsDefault;
    const { model, refresh, nearest } = await this.resolveWithCatalogFallback(
      provider,
      modelId,
      role,
    );
    if (model === undefined) {
      this.log('warn', 'settings default did not resolve after catalog fallback', {
        role,
        model: `${provider}/${modelId}`,
        refresh: refresh.detail,
      });
      throw new Error(
        `settings default "${provider}/${modelId}" is not a registered model; ` +
          `catalog refresh ${refresh.attempted ? 'attempted — ' : ''}${refresh.detail}; ` +
          `${nearest}. Update ${join(this.agentDir, 'settings.json')} or set [models] default ` +
          `to an explicit "provider/model"`,
      );
    }
    return model;
  }

  private safeReviewCompat(compat: unknown, api: string): boolean {
    if (compat === undefined) return true;
    if (api !== 'anthropic-messages' || compat === null || typeof compat !== 'object' || Array.isArray(compat)) return false;
    const flags = new Set(['supportsEagerToolInputStreaming', 'supportsLongCacheRetention',
      'sendSessionAffinityHeaders', 'supportsCacheControlOnTools', 'supportsTemperature',
      'forceAdaptiveThinking', 'allowEmptySignature', 'supportsStrictTools', 'supportsMidConvoEffort']);
    return Object.entries(compat).every(([key, value]) => {
      if (flags.has(key)) return typeof value === 'boolean';
      if (key !== 'allowedFallbackModels' || !Array.isArray(value)) return false;
      return value.every((item: unknown) => {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) return false;
        const fallback = item as Record<string, unknown>;
        const cost = fallback.cost;
        return Object.keys(fallback).every((field) => ['provider', 'model', 'cost'].includes(field)) &&
          fallback.provider === 'anthropic' && typeof fallback.model === 'string' &&
          isPublicModelToken(fallback.model) &&
          cost !== null && typeof cost === 'object' && !Array.isArray(cost) &&
          Object.keys(cost).every((field) => ['input', 'output', 'cacheRead', 'cacheWrite'].includes(field)) &&
          ['input', 'output', 'cacheRead', 'cacheWrite'].every((field) =>
            typeof (cost as Record<string, unknown>)[field] === 'number' &&
            Number.isFinite((cost as Record<string, number>)[field]));
      });
    });
  }

  /** Bind endpoint/API selection without recording (or hashing) credentials.
   * Ambiguous/custom routing is deliberately not eligible for reuse. */
  private reviewRouting(model: Model<Api>): string | undefined {
    if (model.headers !== undefined || model.samplingParams !== undefined ||
      !this.safeReviewCompat(model.compat, model.api) ||
      Object.keys(model).some((key) => !['id', 'name', 'api', 'provider', 'baseUrl', 'reasoning',
        'thinkingLevelMap', 'input', 'cost', 'contextWindow', 'maxTokens', 'compat'].includes(key))) return undefined;
    let url: URL;
    try { url = new URL(model.baseUrl); } catch { return undefined; }
    // An arbitrary hostname or path may itself be an API credential. Do not
    // even hash custom routes: only these literal, credential-free endpoints
    // can produce a reusable proof. Other models can still undergo a fresh
    // review, but their results cannot be inherited across rounds.
    const publicRoutes = new Set([
      'https://api.anthropic.com', 'https://api.anthropic.com/',
      'https://api.openai.com/v1', 'https://api.openai.com/v1/',
      'https://generativelanguage.googleapis.com', 'https://generativelanguage.googleapis.com/',
      'stub://local',
    ]);
    if (!publicRoutes.has(model.baseUrl) || url.username !== '' || url.password !== '' ||
      url.search !== '' || url.hash !== '') return undefined;
    const isAnthropic = model.provider === 'anthropic' && model.api === 'anthropic-messages' &&
      isPublicModelToken(model.id) && url.origin === 'https://api.anthropic.com';
    const isStub = model.provider === 'gru-stub' && model.id === 'stub-model' &&
      ((model.api === 'gru-stub' && model.baseUrl === 'stub://local') ||
        (model.api === 'anthropic-messages' && url.origin === 'https://api.anthropic.com'));
    if (!isAnthropic && !isStub) return undefined;
    const levels = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
    if (model.thinkingLevelMap !== undefined &&
      (typeof model.thinkingLevelMap !== 'object' || model.thinkingLevelMap === null ||
        Object.entries(model.thinkingLevelMap).some(([key, value]) =>
          !levels.has(key) || (value !== null && (typeof value !== 'string' || !levels.has(value)))))) return undefined;
    if (typeof model.reasoning !== 'boolean' || !Array.isArray(model.input) ||
      model.input.length === 0 || Array.from(model.input).some((value) => value !== 'text' && value !== 'image') ||
      !Number.isSafeInteger(model.contextWindow) || !Number.isSafeInteger(model.maxTokens) ||
      model.cost === null || typeof model.cost !== 'object' ||
      Object.keys(model.cost).some((key) => !['input', 'output', 'cacheRead', 'cacheWrite'].includes(key)) ||
      ['input', 'output', 'cacheRead', 'cacheWrite'].some((key) => {
        const value = (model.cost as unknown as Record<string, unknown>)[key];
        return typeof value !== 'number' || !Number.isFinite(value);
      })) return undefined;
    return createHash('sha256').update(JSON.stringify({
      api: model.api, baseUrl: url.href, provider: model.provider, id: model.id,
      reasoning: model.reasoning, thinkingLevelMap: model.thinkingLevelMap ?? null,
      input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      compat: model.compat ?? null,
    })).digest('hex');
  }

  /** Capture the actual Pi provider/model selected by the same resolver as
   * spawn, not the mutable "default" setting or a credential-bearing value. */
  async prepareReviewModel(role: Role): Promise<ClaudeReviewSnapshot> {
    const model = await this.resolveModel(role);
    if (model === undefined) {
      // With no settings default the offline SDK snapshot cannot choose a
      // model. Do not treat an arbitrary authenticated provider as success.
      throw new Error('no selected pi default model; configure a settings default or [models] default for review');
    }
    if (await (await this.runtime()).checkAuth(model.provider) === undefined) {
      throw new Error(`review model provider is not authenticated: ${model.provider} (model ${model.provider}/${model.id})`);
    }
    const routingSha256 = this.reviewRouting(model);
    const snapshot: ClaudeReviewSnapshot = { role, modelRef: `${model.provider}/${model.id}`, settings: {}, authEnv: {},
      ...(routingSha256 !== undefined ? { routingSha256 } : {}) };
    this.reviewModels.set(snapshot, structuredClone(model));
    return snapshot;
  }

  async checkReviewModel(role: Role): Promise<void> {
    await this.prepareReviewModel(role);
  }


  private resolveThinkingLevel(role: Role, override?: string): ThinkingLevel | undefined {
    const ref =
      override !== undefined
        ? override
        : resolveSpawnPolicy(this.config, 'pi', role).thinkingLevel;
    if (ref === '' || ref === 'default') return undefined;
    // Thinking levels pi's session API accepts (fail-loud on typos: pi CAN set it).
    if (!PI_THINKING_LEVELS.includes(ref as ThinkingLevel)) {
      throw new Error(
        `unknown thinking level "${ref}" for pi (valid: default, ${PI_THINKING_LEVELS.join(', ')})`,
      );
    }
    return ref as ThinkingLevel;
  }

  async spawn(role: Role, options: SpawnOptions = {}): Promise<AgentHandle> {
    const roleDef = ROLE_DEFINITIONS[role];
    // SPEC ruling 17: an explicit cwd roots the session in the project it
    // serves (the dispatch flow's worktree); absent = workspace root.
    const cwd = resolveSpawnCwd(this.config.workspaceRoot, options.cwd);
    if (options.reviewModel !== undefined) {
      if ((options.reviewLead ?? options.isolatedReview) === undefined || options.reviewModel.role !== role ||
        Object.keys(options.reviewModel.authEnv).length > 0 || Object.keys(options.reviewModel.settings).length > 0) {
        throw new Error('Pi review model proof requires a matching isolated role and no Claude settings or credentials');
      }
      const current = await this.resolveModel(role);
      if (current === undefined || `${current.provider}/${current.id}` !== options.reviewModel.modelRef ||
        options.model !== options.reviewModel.modelRef ||
        !isDeepStrictEqual(current, this.reviewModels.get(options.reviewModel)) ||
        (options.reviewModel.routingSha256 !== undefined && this.reviewRouting(current) !== options.reviewModel.routingSha256)) {
        throw new Error('Pi review model changed since preflight (including routing) — do not spawn a lead or lens against a different endpoint');
      }
    }
    // A resumed session's persisted model outranks the "default" sentinel,
    // but the session file may only be opened after the lock below — defer
    // sentinel resolution on resume until the session is open.
    const modelRef = this.modelRef(role, options.model);
    const deferToSession = options.resumeFile !== undefined && options.reviewLead === undefined &&
      options.isolatedReview === undefined && (modelRef === '' || modelRef === 'default');
    let model = deferToSession ? undefined : await this.resolveModel(role, options.model, cwd);
    if (options.reviewModel !== undefined &&
      (model === undefined || !isDeepStrictEqual(model, this.reviewModels.get(options.reviewModel)) ||
        (options.reviewModel.routingSha256 !== undefined && this.reviewRouting(model) !== options.reviewModel.routingSha256))) {
      throw new Error('Pi review endpoint changed before session creation');
    }
    const thinkingLevel = this.resolveThinkingLevel(role, options.thinkingLevel);
    const isolatedReview = options.isolatedReview;
    const reviewLead = options.reviewLead;
    if (isolatedReview !== undefined && reviewLead !== undefined) {
      throw new Error('a review session cannot be both a lead and a lens child');
    }
    const reviewMode = reviewLead ?? isolatedReview;
    if (reviewMode !== undefined && options.resumeFile !== undefined) {
      throw new Error('isolated review sessions must be fresh and cannot resume ambient context');
    }
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
    let modelRejected = false;
    if (resumeFile !== undefined && (options.directiveRecoveryProducer !== undefined || !this.store.isHeld(resumeFile))) {
      const predecessor = options.directiveRecoveryProducer;
      if (predecessor === undefined) this.store.acquireLock(resumeFile);
      else {
        const proof = inspectDirectiveCheckpoint(resumeFile, predecessor.identity);
        const ownership = inspectDirectiveProducers(resumeFile, predecessor.identity).find(({ producer }) => isDeepStrictEqual(producer, predecessor));
        if (predecessor.sessionFile !== resumeFile || ownership === undefined || ownership.evidence === 'unknown' || proof.state !== 'resumable') {
          throw new DirectiveCheckpointError('exact absent predecessor/safe checkpoint required before native lock reclaim');
        }
        this.store.acquireLockAfterHostExit(resumeFile, predecessor.pid, predecessor.lockOwner);
      }
      lockAcquired = true;
    }
    try {
      let sessionManager =
        resumeFile !== undefined
          ? SessionManager.open(resumeFile, dirname(resumeFile), cwd)
          : SessionManager.create(cwd, this.store.sessionDirFor(role, cwd));
      if (resumeFile === undefined) {
        // The SDK delays fresh-file flushing until an assistant arrives.
        // Initialize only its real header, then reopen through its public
        // API so the first actual user acceptance is persisted immediately.
        const file = sessionManager.getSessionFile();
        const header = sessionManager.getHeader();
        if (file === undefined || header === null) throw new DirectiveCheckpointError('Pi fresh session has no durable native identity');
        writeFileSync(file, `${JSON.stringify(header)}\n`, { flag: 'wx', mode: 0o600 });
        sessionManager = SessionManager.open(file, dirname(file), cwd);
      }
      if (deferToSession) {
        const context = sessionManager.buildSessionContext();
        try {
          model = await this.resolveModel(
            role,
            options.model,
            cwd,
            context.messages.length > 0 ? context.model ?? undefined : undefined,
          );
        } catch (error) {
          modelRejected = true;
          throw error;
        }
      }
      // Name the RESOLVED model: future "No API key"-style complaints must
      // name the actual model, not the sentinel that requested it.
      this.log('info', 'spawn: model resolved', {
        role,
        model: model ? `${model.provider}/${model.id}` : 'pi default resolution (no settings default named)',
        thinkingLevel: thinkingLevel ?? 'default',
      });
      const isolatedSettings = reviewMode === undefined
        ? undefined
        : SettingsManager.inMemory({}, { projectTrusted: false });
      // Issue #283: the lane-bound GC-managed BMAD runtime rides beside the
      // project's own skills and wins a name collision. Review sessions
      // never carry it (they load no skills at all).
      const managed = reviewMode === undefined ? options.managedSkills : undefined;
      // Verification admission applies to ordinary worker sessions only;
      // isolated review sessions keep their ambient-free resource set.
      const workerVerification = reviewMode === undefined ? options.workerVerification : undefined;
      const systemPrompt = managed === undefined
        ? roleDef.systemPrompt
        : `${roleDef.systemPrompt}\n\n${managedSkillsPromptNote(managed, 'pi')}`;
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: this.agentDir,
        ...(workerVerification !== undefined ? { extensionFactories: [workerVerificationExtension(workerVerification)] } : {}),
        ...(isolatedSettings !== undefined ? { settingsManager: isolatedSettings } : {}),
        ...(reviewMode !== undefined
          ? {
              noExtensions: true,
              noSkills: true,
              noPromptTemplates: true,
              noThemes: true,
              noContextFiles: true,
            }
          : {}),
        systemPromptOverride: () => reviewMode?.systemPrompt ?? systemPrompt,
        ...(managed !== undefined ? { skillsOverride: (base) => preferManagedSkills(base, managed) } : {}),
        ...(reviewMode !== undefined
          ? {
              skillsOverride: () => ({ skills: [], diagnostics: [] }),
              promptsOverride: () => ({ prompts: [], diagnostics: [] }),
              agentsFilesOverride: () => ({ agentsFiles: [] }),
              appendSystemPromptOverride: () => [],
            }
          : {}),
      });
      await loader.reload();
      const isolatedTools = reviewMode === undefined ? null : confinedReviewTools(cwd, reviewMode.tools);
      // Declared native tools ride the SAME helper for leads and lens
      // children: the ADAPTER translates the declaration to in-process
      // tools, so callers never branch on harness (SPEC ruling 4).
      // Product-native tools ride the SAME helper for review leads and
      // (issue #161) ordinary parent sessions: the adapter translates the
      // declaration to in-process tools, so callers never branch on
      // harness and no secret ever leaves the host process.
      const declaredNativeTools =
        reviewMode !== undefined ? (reviewMode.nativeTools ?? []) : (options.nativeTools ?? []);
      const nativeTools = nativeReviewTools(declaredNativeTools);
      // Issue #161: a declared role-tool override narrows (never widens)
      // the role's own set — an unknown name fails loud here instead of
      // silently spawning with the wrong authority.
      const declaredRoleTools = options.roleTools ?? roleDef.tools;
      if (options.roleTools !== undefined) {
        const allowed = new Set(roleDef.tools);
        for (const tool of options.roleTools) {
          if (!allowed.has(tool)) {
            throw new Error(
              `role tool override names "${tool}", which role "${role}" does not declare — an override can only narrow authority`,
            );
          }
        }
      }
      const tools = isolatedTools === null
        ? [...declaredRoleTools, ...nativeTools.map((tool) => tool.name)]
        : [...isolatedTools.names, ...nativeTools.map((tool) => tool.name)];
      // #486: a lane session's commands carry the lane's provenance, and no
      // session's carry lane variables the service inherited. An isolated
      // review session has no bash: it starts no process to carry them.
      const laneBash = isolatedTools === null && tools.includes('bash') && (options.laneProvenance !== undefined || carriesLaneEnv(process.env))
        ? laneBashTool(cwd, this.agentDir, options.laneProvenance === undefined ? null : laneProvenanceEnv(options.laneProvenance)) : null;
      const { session } = await createAgentSession({
        cwd,
        agentDir: this.agentDir,
        model,
        ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
        ...(reviewMode !== undefined ? { noTools: 'all' as const } : {}),
        tools: [...tools],
        ...(isolatedTools !== null
          ? { customTools: [...isolatedTools.tools, ...nativeTools] }
          : nativeTools.length > 0 || laneBash !== null
            ? { customTools: [...(laneBash !== null ? [laneBash] : []), ...nativeTools] }
            : {}),
        resourceLoader: loader,
        ...(isolatedSettings !== undefined ? { settingsManager: isolatedSettings } : {}),
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
      const directiveExecutorOrigins = new Map<SdkTool['execute'], SdkTool['execute']>();
      const executableIds = new WeakMap<object, number>();
      let nextExecutableId = 0;
      const executableId = (execute: object): number => {
        let id = executableIds.get(execute);
        if (id === undefined) { id = ++nextExecutableId; executableIds.set(execute, id); }
        return id;
      };
      const handle = new PiAgentHandle(
        role,
        session,
        sessionFile,
        capabilitiesForModelInput(PI_CAPABILITIES, session.model?.input),
        reviewMode !== undefined,
        nativeTools.map((tool) => tool.name),
        this.store,
        this.log,
        () => {
          this.handles.delete(handle);
          this.activeFiles.delete(sessionFile);
        },
        this.heartbeatMs(),
        options.agentId,
        () => {
          const unboundNativeTools = declaredNativeTools.filter((tool) => typeof tool.authorityManifest !== 'string' || tool.authorityManifest.length === 0);
          if (unboundNativeTools.length > 0) {
            throw new Error(`native directive tools lack stable authority manifests: ${unboundNativeTools.map((tool) => tool.name).join(', ')}`);
          }
          return createHash('sha256').update(JSON.stringify({ role, cwd, systemPrompt: effectiveSystemPrompt(session),
            toolExecution: session.agent.toolExecution,
            tools: session.agent.state.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters,
              executionMode: tool.executionMode ?? null, guarded: directiveExecutorOrigins.has(tool.execute),
              implementation: (directiveExecutorOrigins.get(tool.execute) ?? tool.execute).toString(),
              implementationRef: executableId(directiveExecutorOrigins.get(tool.execute) ?? tool.execute) })).sort((a, b) => a.name.localeCompare(b.name)),
            nativeTools: declaredNativeTools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema,
              authorityManifest: tool.authorityManifest, implementation: tool.execute.toString(), implementationRef: executableId(tool.execute) })).sort((a, b) => a.name.localeCompare(b.name)),
            model: session.model ?? null })).digest('hex');
        },
        () => resolveGitCommit(cwd, 'HEAD'),
        directiveExecutorOrigins,
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
        !(error instanceof LockBusyError) &&
        !modelRejected
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
    // Contain every handle: one hung session must not abandon the remaining
    // handles' lock releases (issue #341). disposeAll runs them all and
    // fails loud once with the per-handle causes.
    await disposeAll([...this.handles]);
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
  /** The SDK session id at construction (== `id` for ordinary handles). */
  private readonly nativeSessionId: string;
  readonly sessionFile: string;
  readonly reviewIsolation?: true;
  readonly reviewTools?: readonly string[];
  readonly capabilities: AgentCapabilities;

  /** The principal unnamed callers are attributed to (single-writer). */
  private readonly principal: string;
  private state: AgentState = 'idle';
  private lastActivity: string | null = null;
  private stateError: string | undefined;
  private liveOwner: string | null = null;
  private liveTurn: Promise<void> | null = null;
  /** The text/images behind the live turn — supervision's resume snapshot. */
  private livePromptText: string | null = null;
  private livePromptImages: PromptOptions['images'] | undefined;
  private liveDirective: PromptOptions['directive'] | undefined;
  /** The live directive's first admission/guard failure, boxed: a thrown
   * null or undefined still fails it, so every later fence refuses. */
  private directiveAdmissionFailure: { readonly error: unknown } | null = null;
  /** Every native directive refusal this turn threw (#485), as the exact
   * object thrown: a `DirectiveCheckpointError` GC raised for the live
   * directive, GC's wrapper whose cause is one, or the `AggregateError` that
   * replaced one whose receipt could not be journaled. Reset per turn. See
   * RuntimeEvent `nativeControl`. */
  private readonly nativeDirectiveRefusals = new Set<Error>();
  /** Bookkeeping faults already logged (the fault itself, or its refusal when the
   * fault is no object): each is logged once, first failure or not. */
  private readonly loggedBookkeepingFaults = new WeakSet<object>();
  private publishedDirectiveAdmission: PromptOptions['directive'] | undefined;
  /** Terminal evidence of the live turn's LAST assistant message: the only
   * positive completion proof (`stopReason: 'stop'` holding no tool calls).
   * Reset per turn; the settle capture reads it before `drain()` starts a
   * successor. */
  private liveTurnStop: { stopReason: string | null; error: string | null; holdsCalls: boolean } | null = null;
  /** Long-tool heartbeats: an open tool call keeps the event surface alive. */
  private readonly toolHeartbeat: ToolHeartbeat;
  private readonly queue: QueuedMessage[] = [];
  private readonly listeners = new Set<RuntimeEventListener>();
  /** Covers the await gap before Pi exposes session.isCompacting. */
  private compacting = false;
  /** Adapter-owned cessation evidence state (once-only transition). */
  private cessationState: 'live' | 'ceased' | 'unknown' = 'live';
  /** The withheld terminal; `aborted` is Pi's own flag for a cancelled cycle. */
  private pendingCompactionEnd: { readonly event: Extract<RuntimeEvent, { type: 'compaction_end' }>; readonly aborted: boolean } | null = null;
  private nativeCompactionOpen = false;
  private readonly compactionTerminalWaiters = new Set<() => void>();
  private compactionEndDeadline = 0;
  private compactionEndTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitCompactionTerminal: {
    readonly resolve: (event: Extract<RuntimeEvent, { type: 'compaction_end' }>) => void;
    settled: boolean;
  } | null = null;
  private readonly directiveProducers = new Map<string, DirectiveProducer>();
  private readonly pendingGuardRefusals = new Map<string, { readonly producer: DirectiveProducer; readonly toolCallId?: string; readonly reason: string }>();
  private readonly preparedDirectiveEffects = new Map<string, (toolName: string, args: unknown, signal?: AbortSignal) => unknown>();
  private disposed = false;
  private disposalPending: Promise<void> | null = null;
  private cleanupSucceeded = false;
  private nativeQuiescent = false;
  private ownershipReleased = false;
  /** A settlement is running: a listener that re-queries reads the current
   * evidence instead of re-entering the release (#497). */
  private settlingCessation = false;
  private compactionWork: Promise<unknown> | null = null;

  constructor(
    role: Role,
    private readonly session: {
      prompt(text: string, options?: unknown): Promise<void>;
      // SDK 1.x resolves steer/followUp with a "queued" | "handled" disposition
      // (a handled input is consumed by an extension input handler); the
      // adapter only awaits acceptance, as it did when these resolved void.
      steer(text: string, images?: unknown): Promise<unknown>;
      followUp(text: string, images?: unknown): Promise<unknown>;
      subscribe(listener: (event: unknown) => void): () => void;
      /** SDK 1.4 dispose is synchronous cleanup, NOT native idle proof.
       * GH286 independently awaits owned native/adapter quiescence below. */
      dispose(): Promise<void> | void;
      abort?(): Promise<void>;
      waitForIdle?(): Promise<void>;
      /** Real controller-set queries (executeBash controllers, removed in
       * executeBash's finally) — truthful, unlike the metadata heartbeat. */
      readonly isBashRunning?: boolean;
      readonly hasPendingBashMessages?: boolean;
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
      /** The session's resolved model (provider identity for error events). */
      readonly model?: { readonly id: string; readonly provider: string } | undefined;
      readonly agent?: { continue(): Promise<void> };
    },
    sessionFile: string,
    capabilities: AgentCapabilities,
    isolatedReview: boolean,
    reviewToolNames: readonly string[],
    private readonly store: SessionStore,
    private readonly log: Log,
    private readonly onDispose: () => void = () => {},
    toolHeartbeatMs = 60_000,
    /** Product-owned identity (issue #161): the handle id is the ledger
     * identity, which must exist before the session for a tracked child.
     * The session file and its lock stay SDK-minted. */
    agentId?: string,
    private readonly directiveAuthorityManifest?: () => string,
    private readonly directiveCompletionHead?: () => string,
    directiveExecutorOrigins = new Map<SdkTool['execute'], SdkTool['execute']>(),
  ) {
    this.role = role;
    // The SDK-minted session identity, retained separately from the
    // product-owned handle id (issue #161): identity drift checks compare
    // NATIVE ids, never the product id.
    this.nativeSessionId = session.sessionId;
    this.id = agentId ?? session.sessionId;
    this.sessionFile = sessionFile;
    this.capabilities = capabilities;
    if (isolatedReview) this.reviewIsolation = true;
    if (reviewToolNames.length > 0) this.reviewTools = [...reviewToolNames];
    // Unnamed callers share one principal PER HANDLE — one chat brain per
    // session (SPEC ruling 1). Two distinct sessions always differ, so a
    // stranger's steer/followUp queues instead of passing natively.
    this.principal = `handle:${this.id}`;
    this.toolHeartbeat = new ToolHeartbeat((event) => this.emit(event), toolHeartbeatMs);
    session.subscribe((event) => this.onPiEvent(event));
    if (session instanceof AgentSession) {
      // Use the SDK's ordinary active tool setup, retaining each real executor
      // in the authority fingerprint. Preparation is not an effect boundary:
      // parallel batches prepare every call before any executor is invoked.
      const guardedTools = new WeakMap<SdkTool, SdkTool>();
      const guardTool = (tool: SdkTool): SdkTool => {
        if (directiveExecutorOrigins.has(tool.execute)) return tool;
        const known = guardedTools.get(tool);
        if (known !== undefined) return known;
        const originalExecute = tool.execute;
        const execute: SdkTool['execute'] = (toolCallId, args, signal, onUpdate) => {
          const guard = this.preparedDirectiveEffects.get(toolCallId);
          const effectiveArgs = guard !== undefined ? guard(tool.name, args, signal) : args;
          if (guard === undefined && this.liveDirective !== undefined) {
            this.refuseDirectiveGuard(this.liveDirective, toolCallId, new DirectiveCheckpointError('native executor lacks its exact prepared directive intent'));
          }
          return originalExecute.call(tool, toolCallId, effectiveArgs, signal, onUpdate);
        };
        directiveExecutorOrigins.set(execute, originalExecute);
        const guarded = { ...tool, execute };
        guardedTools.set(tool, guarded);
        return guarded;
      };
      // SDK 1.x re-applies the active tool loadout (`agent.state.tools = ` the
      // registry's own tools) before every prompt and next turn, which would
      // drop a one-time wrap after the first prompt. Guard every assignment.
      const agentState = session.agent.state;
      const toolsAccessor = Object.getOwnPropertyDescriptor(agentState, 'tools');
      if (toolsAccessor?.get === undefined || toolsAccessor.set === undefined || toolsAccessor.configurable !== true) {
        throw new Error('the pi SDK agent state no longer exposes an assignable tools accessor; refusing to run without the directive executor fence');
      }
      const { get: readTools, set: writeTools } = toolsAccessor;
      Object.defineProperty(agentState, 'tools', { ...toolsAccessor, set: (tools: SdkTool[]) => writeTools.call(agentState, tools.map(guardTool)) });
      agentState.tools = readTools.call(agentState);
      const beforeNextTurn = session.agent.prepareNextTurnWithContext;
      session.agent.prepareNextTurnWithContext = async (turn, signal) => {
        const directive = this.liveDirective;
        try {
          if (directive !== undefined) this.assertDirectiveExecutionAuthority(directive, signal);
          const update = await beforeNextTurn?.(turn, signal);
          if (directive !== undefined) {
            // Automatic compaction may begin and finish inside the SDK's
            // preparation await. Its terminal is deliberately withheld until
            // the native gate clears; publish every open episode before the
            // after-preparation authority check so supervision sees closure.
            await this.waitForCompactionTerminal(signal);
            this.assertDirectiveExecutionAuthority(directive, signal);
            const context = update?.context ?? turn.context;
            if ((update?.model !== undefined && !isDeepStrictEqual(update.model, session.model)) ||
                getCurrentSystemPrompt(context.messages) !== session.agent.state.systemPrompt ||
                !isDeepStrictEqual(context.tools ?? [], session.agent.state.tools)) {
              throw new DirectiveCheckpointError('effective native model/role/tools authority changed during next-turn preparation');
            }
          }
          return update;
        } catch (error) { this.refuseDirectiveGuard(directive, undefined, error); }
      };
      const before = session.agent.beforeToolCall;
      session.agent.beforeToolCall = async (input, signal) => {
        const directive = this.liveDirective;
        const batchMode = (): 'sequential' | 'parallel' => session.agent.toolExecution === 'sequential' || input.assistantMessage.content.some((block) =>
          block.type === 'toolCall' && session.agent.state.tools.find((tool) => tool.name === block.name)?.executionMode === 'sequential') ? 'sequential' : 'parallel';
        const executionMode = batchMode();
        const args = directive === undefined ? input.args : structuredClone(input.args);
        const invocation = directive === undefined ? input.toolCall : structuredClone(input.toolCall);
        const assistantMessage = directive === undefined ? input.assistantMessage : structuredClone(input.assistantMessage);
        const check = (effectiveArgs: unknown = input.args, effectSignal = signal): void => {
          if (directive === undefined) return;
          this.assertDirectiveExecutionAuthority(directive, effectSignal);
          if (!isDeepStrictEqual(input.args, args) || !isDeepStrictEqual(effectiveArgs, args) || !isDeepStrictEqual(args, invocation.arguments) ||
              !isDeepStrictEqual(input.toolCall, invocation) || !isDeepStrictEqual(input.assistantMessage, assistantMessage)) {
            throw new DirectiveCheckpointError('effective native tool arguments differ from the exact persisted intent');
          }
          if (!isDeepStrictEqual(input.context.tools, session.agent.state.tools)) throw new DirectiveCheckpointError('effective native executor authority differs from its accepted tool setup');
          if (batchMode() !== executionMode) throw new DirectiveCheckpointError('native directive batch execution mode changed before tool effect');
          withOwnIo('tool intent journal', () => flushDirectiveToolIntent(this.sessionFile, assistantMessage, invocation, directive.identity, executionMode));
        };
        try {
          check();
          const result = await before?.(input, signal);
          check(); // prior extensions may await or change permission/native intent
          if (directive !== undefined && !result?.block) {
            this.preparedDirectiveEffects.set(invocation.id, (name, effectiveArgs, effectSignal) => {
              try {
                if (name !== invocation.name) throw new DirectiveCheckpointError('native executor differs from its exact prepared tool');
                check(effectiveArgs, effectSignal);
                return structuredClone(args); // no shared extension-mutable argument object reaches the executor
              } catch (error) { this.refuseDirectiveGuard(directive, invocation.id, error); }
            });
          }
          return result;
        } catch (error) { this.refuseDirectiveGuard(directive, invocation.id, error); }
      };
      const executeBash = session.executeBash.bind(session);
      session.executeBash = (...args) => {
        for (const producer of this.directiveProducers.values()) recordDirectiveIndependentController(producer);
        return executeBash(...args);
      };
    }
  }

  private assertDirectiveExecutionAuthority(directive: NonNullable<PromptOptions['directive']>, signal?: AbortSignal, recheckCurrentAdmission = true): void {
    if (this.disposed || signal?.aborted || this.liveDirective !== directive) throw new DirectiveCheckpointError('native directive tool ownership cancelled or changed');
    // GC's wrapper names its cause: it is a refusal only when that cause is one.
    const failure = this.directiveAdmissionFailure;
    if (failure !== null) {
      throw new DirectiveCheckpointError(`native directive admission/guard failed; further tool effects refused: ${thrownText(failure.error, 'string')}`, { cause: failure.error });
    }
    if (this.publishedDirectiveAdmission !== directive) throw new DirectiveCheckpointError('native directive actual admission has not been successfully published; tool effects refused');
    // Each GC bookkeeping call runs by itself: a fault there is GC's refusal.
    if (recheckCurrentAdmission) withOwnIo('authority check', () => directive.beforeAdmission());
    if (withOwnIo('binding read', () => readDirectiveBinding(this.sessionFile, directive.identity.requestId))?.authorityManifest !== this.directiveAuthorityManifest?.()) {
      throw new DirectiveCheckpointError('live native directive role/tools/model authority changed before effect or completion');
    }
  }

  private refuseDirectiveGuard(directive: PromptOptions['directive'], toolCallId: string | undefined, error: unknown): never {
    if (directive !== undefined) {
      this.failDirectiveAdmission(error);
      this.recordDirectiveRefusal(error);
      const producer = this.directiveProducers.get(directive.identity.requestId);
      if (producer !== undefined) {
        const key = `${producer.incarnation}:${toolCallId === undefined ? 'authority' : `tool:${toolCallId}`}`;
        const refusal = { producer, ...(toolCallId === undefined ? {} : { toolCallId }), reason: thrownText(error, 'string') };
        this.pendingGuardRefusals.set(key, refusal);
        try {
          if (toolCallId === undefined) recordDirectiveAuthorityRefusal(producer, refusal.reason);
          else recordDirectiveToolRefusal(producer, toolCallId, refusal.reason);
          this.pendingGuardRefusals.delete(key);
        } catch (journalError) {
          // Still the refusal: the turn now fails with this object instead. A
          // foreign error keeps its own words, so it is still classified by them.
          const refusalError = isNativeDirectiveRefusal(error);
          const unrecorded = new AggregateError([error, journalError], 'native guard refusal could not be durably recorded; physical ownership retained' +
            (refusalError ? '' : `: ${thrownText(error, 'string')}`));
          if (refusalError) this.nativeDirectiveRefusals.add(unrecorded);
          throw unrecorded;
        }
      }
    }
    throw error;
  }

  /** Fails the live directive's admission/guard once: the first failure stays
   * the turn's, and a bookkeeping fault is logged with the fault it replaced. */
  private failDirectiveAdmission(error: unknown): void {
    this.directiveAdmissionFailure ??= { error };
    this.logBookkeepingFault(error);
  }

  /** Every bookkeeping fault is logged, first failure or not, and once. */
  private logBookkeepingFault(error: unknown): void {
    if (!(error instanceof DirectiveBookkeepingError)) return;
    const fault = typeof error.fault === 'object' && error.fault !== null ? error.fault : error;
    if (this.loggedBookkeepingFaults.has(fault)) return;
    this.loggedBookkeepingFaults.add(fault);
    this.log('error', 'native directive bookkeeping failed; the directive is refused', { error: error.message, fault: thrownDetail(error.fault) });
  }

  /** Keeps a refusal GC raised for the live directive; a plain error, or GC's
   * wrapper around one, is routed as the failure it is. */
  private recordDirectiveRefusal(error: unknown): void {
    if (isNativeDirectiveRefusal(error)) this.nativeDirectiveRefusals.add(error);
  }

  /** Pi's SDK reduces a thrown refusal to its message in the failed turn's
   * assistant message: only exact equality with a recorded one counts (a
   * refusal always states a reason, so an empty text never matches). */
  private isNativeDirectiveRefusalText(detail: string): boolean {
    return [...this.nativeDirectiveRefusals].some((refusal) => refusal.message === detail);
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Live-process probe (E7): supervision consults this before killing a
   * silent turn. A tool call that has started and not returned is the
   * runtime's evidence that work is genuinely in flight — for the bash
   * tool that is a live child process; for in-process tools the loop is
   * occupied. Either way: activity, never a hang.
   */
  hasLiveProcess = (): boolean => !this.disposed && this.toolHeartbeat.openCalls > 0;

  /** The live turn's prompt — snapshotted by supervision before a restart. */
  pendingTurn = (): PendingTurn | null => {
    if (this.liveTurn === null || this.livePromptText === null) return null;
    return {
      text: this.livePromptText,
      owner: this.liveOwner,
      ...(this.livePromptImages !== undefined ? { images: this.livePromptImages } : {}),
      ...(this.liveDirective !== undefined ? { directive: this.liveDirective } : {}),
    };
  };

  health() {
    return {
      state: this.state,
      lastActivity: this.lastActivity,
      error: this.stateError,
      sessionFile: this.sessionFile as string | null,
    };
  }

  async prompt(text: string, options: PromptOptions = {}): Promise<void> {
    await this.promptWithVerdict(text, options);
  }

  async promptWithVerdict(text: string, options: PromptOptions = {}): Promise<PromptTurnVerdict> {
    this.assertLive();
    if (this.compacting || this.nativeCompactionOpen || this.session.isCompacting) {
      throw new Error('agent session is compacting; prompt requires an idle session');
    }
    const owner = options.owner ?? this.principal;
    if (this.liveTurn !== null) {
      return this.enqueue(text, owner, 'single-writer', options.images, options.timeoutMs, options.directive);
    }
    const turn = this.runTurn(text, owner, options.images, options.directive);
    await turn.done;
    return turn.verdict();
  }

  prepareDirectiveProducer = (identity: DirectiveTurnIdentity): DirectiveProducer => {
    this.assertLive();
    const prior = this.directiveProducers.get(identity.requestId);
    if (prior !== undefined) return prior;
    if (this.liveTurn !== null || !this.session.isIdle || this.isCompacting() || this.session.isBashRunning === true || this.session.hasPendingBashMessages === true) {
      throw new DirectiveCheckpointError('native producer preparation requires genuine idle without independent controllers');
    }
    const producer = prepareDirectiveProducer({ identity, agentId: this.id, sessionId: this.nativeSessionId, sessionFile: this.sessionFile,
      ...(this.session instanceof AgentSession ? { lockOwner: this.store.ownedLockIdentity(this.sessionFile) } :
        this.store.isHeld(this.sessionFile) ? { lockOwner: this.store.ownedLockIdentity(this.sessionFile) } : {}) });
    this.directiveProducers.set(identity.requestId, producer);
    return producer;
  };

  inspectDirective = (identity: DirectiveTurnIdentity) => inspectDirectiveCheckpoint(this.sessionFile, identity);

  resumeDirective = async (identity: DirectiveTurnIdentity, checkpointId: string, beforeContinuation: () => void, claimContinuation?: () => void): Promise<PromptTurnVerdict> => {
    this.assertLive();
    if (this.liveTurn !== null || this.queue.length > 0 || this.isCompacting() || !this.session.isIdle || this.session.agent === undefined) {
      throw new DirectiveCheckpointError('native directive continuation requires an idle, unqueued, supported Pi session');
    }
    const proof = this.inspectDirective(identity);
    if (proof.state !== 'resumable' || proof.checkpointId !== checkpointId || proof.binding.agentId !== this.id || proof.binding.sessionId !== this.nativeSessionId || proof.binding.authorityManifest !== this.directiveAuthorityManifest?.()) {
      throw new DirectiveCheckpointError('native directive checkpoint changed or is not safely resumable');
    }
    beforeContinuation();
    this.prepareDirectiveProducer(identity);
    const directive = { identity, beforeAdmission: beforeContinuation, onAdmitted: () => {} };
    const turn = this.runTurn('', `directive-recovery:${identity.requestId}`, undefined, directive, () => {
      beforeContinuation(); claimContinuation?.();
      // Exact original admission was inspected above and its continuation
      // claim just committed; no new user entry or admission is synthesized.
      this.publishedDirectiveAdmission = directive;
      return this.session.agent!.continue();
    });
    await turn.done;
    return turn.verdict();
  };

  async steer(text: string, options: PromptOptions = {}): Promise<void> {
    this.assertLive();
    if (this.compacting || this.nativeCompactionOpen || this.session.isCompacting) {
      throw new Error('agent session is compacting; steer requires an idle session');
    }
    const owner = options.owner ?? this.principal;
    if (this.liveTurn !== null && owner === this.liveOwner && options.directive === undefined) {
      if (this.liveDirective !== undefined) throw new DirectiveCheckpointError('ordinary steering must wait for the live exact directive to settle; submit a separate turn afterward');
      await this.session.steer(text, mapImages(options.images));
      return;
    }
    if (this.liveTurn !== null) {
      await this.enqueue(text, owner, 'single-writer', options.images, options.timeoutMs, options.directive);
      return;
    }
    await this.runTurn(text, owner, options.images, options.directive).done;
  }

  async followUp(text: string, options: PromptOptions = {}): Promise<void> {
    this.assertLive();
    if (this.compacting || this.nativeCompactionOpen || this.session.isCompacting) {
      throw new Error('agent session is compacting; follow-up requires an idle session');
    }
    const owner = options.owner ?? this.principal;
    if (this.liveTurn !== null && owner === this.liveOwner && options.directive === undefined) {
      if (this.liveDirective !== undefined) throw new DirectiveCheckpointError('ordinary follow-up must wait for the live exact directive to settle; submit a separate turn afterward');
      await this.session.followUp(text, mapImages(options.images));
      return;
    }
    if (this.liveTurn !== null) {
      await this.enqueue(text, owner, 'single-writer', options.images, options.timeoutMs, options.directive);
      return;
    }
    await this.runTurn(text, owner, options.images, options.directive).done;
  }

  getContextUsage = (): ContextUsage | null => {
    if (
      this.disposed ||
      this.compacting ||
      this.nativeCompactionOpen ||
      this.session.isStreaming ||
      this.session.isCompacting
    ) {
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
    !this.nativeCompactionOpen &&
    this.liveTurn === null &&
    this.queue.length === 0 &&
    this.session.isIdle &&
    !this.session.isCompacting;

  isCompacting = (): boolean =>
    this.compacting || this.nativeCompactionOpen || this.session.isCompacting;

  compact = async (): Promise<void> => {
    this.assertLive();
    if (
      this.compacting ||
      this.nativeCompactionOpen ||
      this.liveTurn !== null ||
      this.queue.length > 0 ||
      !this.session.isIdle ||
      this.session.isCompacting
    ) {
      throw new Error('agent session is busy; compaction requires an idle session');
    }
    // The NATIVE session identity captured at construction, never the
    // product-owned handle id (issue #161) and never a fresh read that a
    // swapped/foreign session could satisfy.
    const id = this.nativeSessionId;
    const file = this.sessionFile;
    let resolveTerminal!: (
      event: Extract<RuntimeEvent, { type: 'compaction_end' }>,
    ) => void;
    const terminal = new Promise<Extract<RuntimeEvent, { type: 'compaction_end' }>>(
      (resolveTerminalPromise) => {
        resolveTerminal = resolveTerminalPromise;
      },
    );
    const waiter = { resolve: resolveTerminal, settled: false };
    this.explicitCompactionTerminal = waiter;
    this.compacting = true;
    let failed = false;
    let failure: unknown;
    const work = Promise.resolve().then(() => this.session.compact());
    this.compactionWork = work;
    try {
      await work;
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      if (this.compactionWork === work) this.compactionWork = null;
      this.compacting = false;
      if (!this.disposed) {
        // Pi's own terminal, a cancel's included, stands when it emitted one
        // before the call threw; a failure is synthesized only without one.
        if (this.pendingCompactionEnd === null) {
          this.pendingCompactionEnd = { aborted: false, event: {
            type: 'compaction_end',
            success: false,
            error:
              failed
                ? failure instanceof Error
                  ? failure.message
                  : String(failure)
                : 'native compaction settled without a terminal event',
          } };
          this.nativeCompactionOpen = true;
          this.compactionEndDeadline = Date.now() + COMPACTION_END_RECONCILE_MS;
        }
        this.flushCompactionEndWhenSettled();
      }
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
    if (this.ownershipReleased) return;
    if (this.disposalPending !== null) return this.disposalPending;
    this.disposed = true; // revoke new turns immediately; failed cleanup still owns the writer
    this.disposalPending = Promise.resolve().then(() => this.disposeOwned()).finally(() => { this.disposalPending = null; });
    this.invalidateOwned(); // synchronous logical cancellation; reentrant callers join pending cleanup
    return this.disposalPending;
  }

  private invalidateOwned(): void {
    this.toolHeartbeat.dispose();
    if (this.compactionEndTimer !== null) clearTimeout(this.compactionEndTimer);
    this.compactionEndTimer = null;
    const abortCompaction =
      (this.explicitCompactionTerminal !== null &&
        !this.explicitCompactionTerminal.settled) ||
      this.compacting ||
      this.nativeCompactionOpen ||
      this.pendingCompactionEnd !== null;
    this.pendingCompactionEnd = null;
    this.nativeCompactionOpen = false;
    this.compactionEndDeadline = 0;
    this.wakeCompactionTerminalWaiters(); // each sees disposal and refuses
    if (abortCompaction) {
      // Resolve the explicit waiter before clearing lifecycle state. compact()
      // may still be awaiting the SDK call, but once it settles it observes
      // this one authoritative failed terminal instead of waiting forever.
      this.publishCompactionEnd({
        type: 'compaction_end',
        success: false,
        error: 'agent session disposed during native compaction',
      });
    }
    const drained = this.queue.splice(0);
    for (const item of drained) {
      if (item.timer !== null) clearTimeout(item.timer);
      item.reject(new Error('agent session disposed before queued message was delivered'));
    }
  }

  private async disposeOwned(): Promise<void> {
    const turn = this.liveTurn;
    const compaction = this.compactionWork;
    const failures: unknown[] = [];
    try {
      const sdk = this.session instanceof AgentSession;
      if (sdk && (typeof this.session.abort !== 'function' || typeof this.session.waitForIdle !== 'function')) {
        throw new Error('Pi SDK lacks abort/waitForIdle — native producer quiescence cannot be proven');
      }
      if (sdk && (typeof this.session.isBashRunning !== 'boolean' || typeof this.session.hasPendingBashMessages !== 'boolean')) {
        throw new Error('Pi SDK lacks independent-controller probes — producer cessation cannot be proven');
      }
      if (typeof this.session.abort === 'function' && typeof this.session.waitForIdle === 'function') {
        // Keep SDK listeners connected until genuine native settlement.
        await this.withinIdleBound(this.session.abort());
        await this.withinIdleBound(this.session.waitForIdle());
        await this.withinIdleBound(turn?.catch(() => {})); // original verdict/error remains with its caller
        await this.withinIdleBound(compaction?.catch(() => {}));
      }
      if (!this.cleanupSucceeded) {
        await this.session.dispose();
        this.cleanupSucceeded = true;
      }
      // Controlled doubles dispose their deferred operations; still await
      // every adapter owner and require their explicit truthful idle state.
      await this.withinIdleBound(turn?.catch(() => {}));
      await this.withinIdleBound(compaction?.catch(() => {}));
      if (typeof this.session.waitForIdle === 'function') await this.withinIdleBound(this.session.waitForIdle());
      this.nativeQuiescent = this.session.isIdle === true && !this.session.isStreaming && !this.session.isCompacting &&
        this.liveTurn === null && this.compactionWork === null && !this.compacting && !this.nativeCompactionOpen &&
        this.pendingCompactionEnd === null && this.explicitCompactionTerminal?.settled !== false && this.queue.length === 0;
      if (!this.nativeQuiescent) throw new Error('Pi disposal lacks genuine native/adapter quiescence — writer ownership retained');
    } catch (error) { failures.push(error); }
    try {
      // A kept owner fails this disposal (retryable); a re-query only logs it.
      const kept = this.settleCessationEvidence();
      if (kept !== null) failures.push(kept.error);
    } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, `Pi native disposal/ownership cleanup failed: ${failures.map(String).join('; ')}`);
  }

  /** Race one native settlement step against {@link CESSATION_IDLE_TIMEOUT_MS}
   * (issue #341). A hung session surfaces as the named
   * {@link CessationIdleTimeoutError} instead of hanging disposal; the failed
   * disposal retains ownership (never 'ceased') and a later dispose() retries.
   * The timer is deliberately referenced (like the bridge-close bound) so a
   * drained loop cannot exit mid-disposal silently. */
  private async withinIdleBound(step: Promise<unknown> | void): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const bound = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CessationIdleTimeoutError(this.id, CESSATION_IDLE_TIMEOUT_MS)), CESSATION_IDLE_TIMEOUT_MS);
      });
      // The step's own late rejection must not become unhandled after the bound wins.
      await Promise.race([Promise.resolve(step), bound]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /** Compute + emit the once-only cessation evidence transition. Called
   * after disposal settles; re-queryable
   * (UNKNOWN can later flip to 'ceased' when an independently owned bash
   * controller finishes — the evidence event fires on that late transition
   * too). 'ceased' requires BOTH the post-dispose idle proof and an
   * idle-free controller set. Returns the receipt or lock failure that kept
   * ownership (#497), or null. */
  private settleCessationEvidence(): { readonly error: unknown } | null {
    if (this.cessationState === 'ceased') return null; // once-only positive
    if (this.settlingCessation) return null;
    this.settlingCessation = true;
    try { return this.settleCessationEvidenceOnce(); } finally { this.settlingCessation = false; }
  }

  private settleCessationEvidenceOnce(): { readonly error: unknown } | null {
    let evidence: 'ceased' | 'unknown';
    try {
      const bashActive = this.session.isBashRunning === true || this.session.hasPendingBashMessages === true;
      const controllersProven = !(this.session instanceof AgentSession) ||
        (typeof this.session.isBashRunning === 'boolean' && typeof this.session.hasPendingBashMessages === 'boolean');
      // Independent executeBash is outside native idle. Both proof domains
      // AND successful required cleanup must hold before releasing ownership.
      evidence = this.cleanupSucceeded && this.nativeQuiescent && this.liveTurn === null && this.compactionWork === null &&
        this.session.isIdle === true && !this.session.isStreaming && !this.session.isCompacting && !this.compacting &&
        !this.nativeCompactionOpen && this.pendingCompactionEnd === null && this.explicitCompactionTerminal?.settled !== false &&
        this.queue.length === 0 && controllersProven && !bashActive ? 'ceased' : 'unknown';
    } catch {
      evidence = 'unknown'; // throwing probes are unknown, never false
    }
    let kept: { readonly error: unknown } | null = null;
    if (evidence === 'ceased' && !this.ownershipReleased) {
      // Fallible physical receipts and the lock release precede release of
      // the runtime owner. A failed (or committed-then-thrown) write keeps the
      // evidence UNKNOWN; the next query or dispose() retries it (#497).
      kept = this.releaseNativeOwnership();
      if (kept === null) {
        // Commit the release before publishing it: a listener of the disposed
        // state that re-queries (the review pair's) must read 'ceased'.
        this.ownershipReleased = true;
        this.cessationState = 'ceased';
        this.setState('disposed');
        this.onDispose();
        this.emit({ type: 'cessation_evidence', evidence: 'ceased' });
        return null;
      }
      evidence = 'unknown';
    }
    if (this.cessationState !== evidence) {
      this.cessationState = evidence;
      this.emit({ type: 'cessation_evidence', evidence });
    }
    return kept;
  }

  /** The directive producers' physical receipts (#424): guard refusals still
   * owed, then cessation, then the native writer lock. A failed write is
   * logged and returned: ownership stays UNKNOWN, disposal fails (retryable)
   * and a later query retries it too (#497). Each step is idempotent, so a
   * retry never duplicates a receipt. */
  private releaseNativeOwnership(): { readonly error: unknown } | null {
    try {
      for (const [key, refusal] of this.pendingGuardRefusals) {
        if (refusal.toolCallId === undefined) recordDirectiveAuthorityRefusal(refusal.producer, refusal.reason);
        else recordDirectiveToolRefusal(refusal.producer, refusal.toolCallId, refusal.reason);
        this.pendingGuardRefusals.delete(key);
      }
      for (const producer of this.directiveProducers.values()) recordDirectiveProducerCessation(producer);
    } catch (error) {
      this.log('error', 'directive producer cessation receipt failed; ownership stays UNKNOWN until it is written', { role: this.role, session: this.id, error: String(error) });
      return { error };
    }
    try {
      this.store.releaseLock(this.sessionFile);
    } catch (error) {
      this.log('error', 'session lock release failed; ownership stays UNKNOWN until it is released', { role: this.role, session: this.id, error: String(error) });
      return { error };
    }
    return null;
  }

  cessationEvidence(): 'ceased' | 'unknown' {
    if (this.cessationState === 'live') return 'unknown';
    if (this.cessationState === 'ceased') return 'ceased';
    // A failed SDK cleanup requires a real retry, not absent-bash inference.
    // Completed cleanup may be re-probed for late independent controllers.
    // A receipt or lock release that fails here is logged, keeps UNKNOWN and
    // never throws to the caller (#497).
    this.settleCessationEvidence();
    return this.readCessationEvidence();
  }

  private readCessationEvidence(): 'ceased' | 'unknown' {
    return this.cessationState === 'ceased' ? 'ceased' : 'unknown';
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
    directive?: PromptOptions['directive'],
  ): Promise<PromptTurnVerdict> {
    this.emit({ type: 'queued', reason, owner });
    this.log('info', 'message queued (single-writer)', {
      role: this.role,
      session: this.id,
      owner,
    });
    return new Promise<PromptTurnVerdict>((resolve, reject) => {
      const item: QueuedMessage = {
        text,
        owner,
        ...(images !== undefined ? { images } : {}),
        ...(directive !== undefined ? { directive } : {}),
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

  private runTurn(
    text: string,
    owner: string,
    images?: PromptOptions['images'],
    directive?: PromptOptions['directive'],
    continuation?: () => Promise<void>,
  ): { readonly done: Promise<void>; readonly verdict: () => PromptTurnVerdict } {
    if (directive !== undefined && continuation === undefined) {
      directive.beforeAdmission();
      this.prepareDirectiveProducer(directive.identity);
      prepareDirectiveBinding({ identity: directive.identity, runtime: 'pi', agentId: this.id, sessionId: this.nativeSessionId,
        sessionFile: this.sessionFile, text, authorityManifest: this.directiveAuthorityManifest?.(), nativeTools: this.reviewTools ?? [],
        ...(images !== undefined ? { images } : {}) });
    }
    this.liveOwner = owner;
    this.livePromptText = text;
    this.livePromptImages = images;
    this.liveTurnStop = { stopReason: null, error: null, holdsCalls: false };
    this.liveDirective = directive;
    this.preparedDirectiveEffects.clear();
    this.directiveAdmissionFailure = null;
    this.nativeDirectiveRefusals.clear();
    this.publishedDirectiveAdmission = undefined;
    const promptOptions: Record<string, unknown> = {};
    const mapped = mapImages(images);
    if (mapped !== undefined) promptOptions['images'] = mapped;
    if (directive !== undefined) promptOptions['preflightResult'] = (accepted: boolean) => {
      if (!accepted) return;
      // Pi calls this synchronously before it runs the prompt and writes the
      // receipt; a throw here rejects the prompt with no receipt. A withheld
      // compaction terminal is published if Pi's gate has cleared. If one is
      // still withheld, or the handle was disposed (the reconcile bound
      // disposes), the directive is not admitted.
      try {
        if (this.pendingCompactionEnd !== null) this.flushCompactionEndWhenSettled();
        if (this.disposed) throw new DirectiveCheckpointError('native directive owner disposed during prompt preparation');
        if (this.pendingCompactionEnd !== null) throw new DirectiveCheckpointError('native compaction terminal still withheld at directive admission');
        if (this.nativeCompactionOpen) throw new DirectiveCheckpointError('native compaction still running at directive admission');
        withOwnIo('authority check', () => directive.beforeAdmission());
        if (withOwnIo('binding read', () => readDirectiveBinding(this.sessionFile, directive.identity.requestId))?.authorityManifest !== this.directiveAuthorityManifest?.()) {
          throw new DirectiveCheckpointError('native directive authority changed during prompt preparation');
        }
      } catch (error) {
        // Pi calls this outside its own try: the prompt rejects with this very
        // object. GC's authority or compaction refusal here keeps a durable
        // authority receipt, as a fence refusal does (an unrecorded one rejects
        // as its AggregateError). A bookkeeping fault before acceptance keeps
        // none, so it never blocks the resume of a checkpoint the SDK writes.
        if (error instanceof DirectiveCheckpointError && !(error instanceof DirectiveBookkeepingError)) this.refuseDirectiveGuard(directive, undefined, error);
        this.recordDirectiveRefusal(error);
        this.logBookkeepingFault(error);
        throw error;
      }
    };
    let captured: PromptTurnVerdict = { ok: true, error: null };
    const turn = (continuation === undefined ? this.session.prompt(text, promptOptions) : continuation())
      .catch((error: unknown) => {
        // A turn rejected by dispose() must not overwrite the terminal
        // 'disposed' state with 'error'.
        if (!this.disposed) {
          this.setState('error', thrownText(error, 'string'));
          // Typed provenance (r1 #13): ONLY a real SDK provider error
          // (numeric status) carries provider identity + typed fields.
          // Arbitrary exceptions stay anonymous — the sensor can never
          // mistake them for provider rejections.
          const typed = typedFromSdkError(error);
          this.emit({
            type: 'error',
            error: thrownText(error, 'string'),
            fatal: false,
            // A refusal rejects the prompt as the very object recorded.
            ...(typed === null && error instanceof Error && this.nativeDirectiveRefusals.has(error) ? { nativeControl: 'directive-refusal' as const } : {}),
            ...(typed !== null && this.session.model !== undefined
              ? { provider: this.session.model.provider, model: this.session.model.id }
              : {}),
            ...(typed !== null ? { typed } : {}),
          });
        }
        throw error;
      })
      .finally(() => {
        if (this.liveTurn === turn) {
          // Capture THIS turn's terminal evidence BEFORE `drain()` can start
          // a queued successor: the successor's state must never be read as
          // this turn's outcome (r5 blocker 1). A resolved prompt is not a
          // successful turn: only the turn's own LAST assistant message with
          // `stopReason: 'stop'` is positive completion proof. An in-band
          // error, an abort/disposal, or any other stop reason (#160) is a
          // failed/unknown terminal outcome and must never mint delivery.
          const terminal = this.liveTurnStop;
          this.liveTurnStop = null;
          captured =
            this.state === 'error'
              ? { ok: false, error: this.stateError ?? terminal?.error ?? 'runtime settled the turn with an in-band error' }
              : terminal?.stopReason === 'stop' && !terminal.holdsCalls
                ? { ok: true, error: null }
                : {
                    ok: false,
                    error:
                      `turn settled without a successful completion (` +
                      (terminal?.stopReason == null
                        ? this.disposed
                          ? 'session disposed before a terminal assistant message'
                          : 'no terminal assistant message'
                        : `stopReason: ${terminal.stopReason}${terminal.stopReason === 'stop' && terminal.holdsCalls ? ' holding tool calls' : ''}`) +
                      (terminal?.error == null ? ')' : `: ${terminal.error})`),
                  };
          if (directive !== undefined) {
            try {
              const proof = inspectDirectiveCheckpoint(this.sessionFile, directive.identity);
              captured = proof.state === 'terminal' ? { ok: proof.ok, error: proof.error } : { ok: false, error: 'native correlated terminal proof unavailable' };
            } catch (error) {
              captured = { ok: false, error: `native correlated terminal proof unavailable: ${thrownText(error, 'string')}` };
            }
            if (this.directiveAdmissionFailure !== null) captured = { ok: false, error: thrownText(this.directiveAdmissionFailure.error, 'string') };
          }
          this.preparedDirectiveEffects.clear();
          this.liveDirective = undefined;
          this.liveTurn = null;
          this.liveOwner = null;
          this.livePromptText = null;
          this.livePromptImages = undefined;
          if (!this.disposed && this.state !== 'error') this.setState('idle');
          void this.drain();
        }
      });
    this.liveTurn = turn;
    return { done: turn, verdict: () => captured };
  }

  private async drain(): Promise<void> {
    while (!this.disposed && this.queue.length > 0 && this.liveTurn === null) {
      const next = this.queue.shift()!;
      if (next.timer !== null) clearTimeout(next.timer);
      try {
        const turn = this.runTurn(next.text, next.owner, next.images, next.directive);
        await turn.done;
        next.resolve(turn.verdict());
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
        this.log('warn', 'runtime event listener threw', { error: thrownText(error, 'string') });
      }
    }
  }

  /** Resolves once no native compaction is open and no terminal is pending
   * (an SDK start that arrives while one is open joins that episode).
   * Disposal or the run's abort ends the wait with a refusal: the terminal
   * may never be published. */
  private async waitForCompactionTerminal(signal?: AbortSignal): Promise<void> {
    const cancelled = (): boolean => this.disposed || signal?.aborted === true;
    while (this.nativeCompactionOpen || this.pendingCompactionEnd !== null) {
      if (!cancelled()) {
        await new Promise<void>((resolve) => {
          const wake = (): void => { this.compactionTerminalWaiters.delete(wake); signal?.removeEventListener('abort', wake); resolve(); };
          this.compactionTerminalWaiters.add(wake);
          signal?.addEventListener('abort', wake, { once: true });
        });
      }
      if (cancelled()) throw new DirectiveCheckpointError('native directive ownership cancelled while its compaction terminal was pending');
    }
  }

  private wakeCompactionTerminalWaiters(): void {
    for (const wake of [...this.compactionTerminalWaiters]) wake();
  }

  private flushCompactionEndWhenSettled(): void {
    if (this.disposed || this.pendingCompactionEnd === null) return;
    if (this.compacting || this.session.isCompacting) {
      // Only Pi's own flag can stall past the bound. The adapter's `compacting`
      // defers publication to compact()'s finally, however long Pi awaits its
      // failure handlers first.
      if (this.session.isCompacting && this.compactionEndDeadline > 0 && Date.now() >= this.compactionEndDeadline) {
        this.pendingCompactionEnd = null;
        this.nativeCompactionOpen = false;
        this.compactionEndDeadline = 0;
        // Revoked before any waiter wakes: each one refuses on disposal.
        this.disposed = true;
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
        // After a successful compaction Pi clears its gate synchronously, before
        // any caller awaiting it resumes: a microtask re-check publishes the
        // terminal ahead of the next turn or the continued reply. A failed one
        // awaits its failure hook first; admission then publishes it (see
        // preflightResult). The timer polls a gate that stays closed.
        queueMicrotask(() => this.flushCompactionEndWhenSettled());
      }
      return;
    }
    if (this.compactionEndTimer !== null) clearTimeout(this.compactionEndTimer);
    this.compactionEndTimer = null;
    const terminal = this.pendingCompactionEnd.event;
    this.pendingCompactionEnd = null;
    this.nativeCompactionOpen = false;
    this.compactionEndDeadline = 0;
    this.publishCompactionEnd(terminal);
  }

  private publishCompactionEnd(
    terminal: Extract<RuntimeEvent, { type: 'compaction_end' }>,
  ): void {
    // Every open episode has ended, even when an explicit compaction already
    // settled and this terminal is not published again.
    this.wakeCompactionTerminalWaiters();
    const waiter = this.explicitCompactionTerminal;
    if (waiter?.settled === true) return;
    this.emit(terminal);
    if (waiter !== null) {
      waiter.settled = true;
      waiter.resolve(terminal);
    }
  }

  /** Map pi SDK events onto the runtime-agnostic event surface. */
  private onPiEvent(event: unknown): void {
    if (this.disposed) return;
    const e = event as Record<string, unknown>;
    switch (e['type']) {
      case 'agent_start':
        this.setState('streaming');
        return;
      case 'auto_retry_start': {
        const directive = this.liveDirective;
        if (directive === undefined) return;
        // Missing retry evidence is fail-closed at the native tool guard and
        // checkpoint, so every way it goes unrecorded is logged by name.
        const unrecorded = 'native SDK retry evidence not recorded; retry-history tool effects remain refused';
        const requestId = directive.identity.requestId;
        if (!(this.session instanceof AgentSession)) {
          this.log('warn', unrecorded, { requestId, reason: 'session is not an SDK AgentSession' });
          return;
        }
        const producer = this.directiveProducers.get(requestId);
        try {
          const reason = producer === undefined ? 'live directive has no physical producer'
            : recordDirectiveRetryStart(producer, e, this.session.sessionManager.getBranch().at(-1));
          if (reason !== null) this.log('warn', unrecorded, { requestId, reason });
        } catch (error) {
          this.log('warn', unrecorded, { requestId, error: thrownText(error, 'string') });
        }
        return;
      }
      case 'agent_end':
        if (e['willRetry'] === true) return; // retry keeps the turn live
        // All tool executions are done by now; forget any call whose
        // terminal event never arrived (error paths) so stale heartbeats
        // cannot keep a dead turn looking alive.
        this.toolHeartbeat.clear();
        // An errored turn stays 'error' (sticky until the next turn starts);
        // a clean turn settles to idle (or keeps streaming between turns).
        if (this.state !== 'error') {
          this.setState(this.session.isStreaming ? 'streaming' : 'idle');
        }
        return;
      case 'message_end': {
        const msg = e['message'] as Record<string, unknown> | undefined;
        if (msg?.['role'] === 'user' && this.liveDirective !== undefined) {
          const directive = this.liveDirective;
          // Pi emits before its synchronous append. The microtask reads the
          // real persisted native user entry, fsyncs it, then calls the host.
          queueMicrotask(() => {
            try {
              // The readback with its binding write, and the ledger's publication, are GC's own bookkeeping.
              const binding = withOwnIo('admission receipt', () => inspectDirectiveAdmission(this.sessionFile, directive.identity));
              withOwnIo('admission publication', () => directive.onAdmitted(binding));
              if (this.liveDirective === directive) this.publishedDirectiveAdmission = directive;
            } catch (error) {
              if (this.liveDirective === directive) this.failDirectiveAdmission(error);
            }
          });
        }
        if (msg !== undefined && msg['role'] === 'assistant') {
          // A stop row holding tool calls (providers that report `stop` with
          // tool calls, e.g. OpenAI-compatible chat completions) is not
          // completion: the SDK runs those calls next.
          const holdsCalls = Array.isArray(msg['content']) && msg['content'].some((block) => (block as { type?: unknown } | null)?.type === 'toolCall');
          if (msg['stopReason'] === 'stop' && !holdsCalls && this.liveDirective !== undefined) {
            const directive = this.liveDirective;
            // Completed original work may be historical after a park/hold or
            // material revision. Verify native authority, not today's candidacy.
            try { this.assertDirectiveExecutionAuthority(directive, undefined, false); }
            catch (error) { this.refuseDirectiveGuard(directive, undefined, error); }
            const producer = this.directiveProducers.get(directive.identity.requestId);
            let head: string | null = null;
            try { head = this.directiveCompletionHead?.() ?? null; }
            catch (error) { this.log('warn', 'native completion HEAD unavailable; current candidate gates remain owed', { error: String(error) }); }
            // Capture HEAD NOW, before other callbacks/awaits can move the lane;
            // only its persisted terminal checkpoint is associated afterward.
            queueMicrotask(() => {
              try {
                const proof = withOwnIo('checkpoint read', () => inspectDirectiveCheckpoint(this.sessionFile, directive.identity));
                if (producer === undefined || proof.state !== 'terminal' || !proof.ok) throw new DirectiveCheckpointError('native completion checkpoint/producer unavailable');
                withOwnIo('completion receipt', () => recordDirectiveCompletion(producer, proof.checkpointId, head));
              } catch (error) {
                if (this.liveDirective === directive) this.failDirectiveAdmission(error);
              }
            });
          }
          // Per-turn terminal evidence for the live prompt: every assistant
          // message updates it; the LAST one decides success vs failure.
          if (this.liveTurnStop !== null) {
            this.liveTurnStop = {
              stopReason: typeof msg['stopReason'] === 'string' ? msg['stopReason'] : null,
              error: typeof msg['errorMessage'] === 'string' ? msg['errorMessage'] : null,
              holdsCalls,
            };
          }
          // pi reports in-band model errors as an assistant message with
          // stopReason 'error' — surface it as a runtime error event.
          if (msg['stopReason'] === 'error') {
            const detail = String(msg['errorMessage'] ?? 'model error');
            // The provider terminal message IS the typed origin: its
            // machine-composed line was built by the transport from the real
            // response (pi-ai formatProviderError). Strict parse only.
            const typed = typedFromProviderMessageLine(
              detail,
              typeof msg['provider'] === 'string' ? msg['provider'] : this.session.model?.provider ?? '',
              typeof msg['model'] === 'string' ? msg['model'] : this.session.model?.id ?? '',
            );
            // Pi stamps its own failure message with the model: a refusal
            // names no provider all the same.
            const refusal = typed === null && this.liveDirective !== undefined && this.isNativeDirectiveRefusalText(detail);
            this.emit({
              type: 'error',
              error: detail,
              fatal: false,
              ...(refusal ? { nativeControl: 'directive-refusal' as const } : {
                ...(typeof msg['provider'] === 'string'
                  ? { provider: msg['provider'] }
                  : this.session.model !== undefined
                    ? { provider: this.session.model.provider }
                    : {}),
                ...(typeof msg['model'] === 'string'
                  ? { model: msg['model'] }
                  : this.session.model !== undefined
                    ? { model: this.session.model.id }
                    : {}),
                ...(typed !== null ? { typed } : {}),
              }),
            });
            this.setState('error', detail);
          }
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
        if (this.nativeCompactionOpen) {
          // Joins the open episode; its own compaction_end re-arms the deadline.
          this.compactionEndDeadline = 0;
          return;
        }
        this.nativeCompactionOpen = true;
        this.emit({ type: 'compaction_start' });
        return;
      case 'compaction_end': {
        if (
          !this.nativeCompactionOpen &&
          !this.compacting &&
          (this.explicitCompactionTerminal === null ||
            this.explicitCompactionTerminal.settled)
        ) return;
        const aborted = e['aborted'] === true;
        const success = !aborted && typeof e['errorMessage'] !== 'string';
        const terminal = { aborted, event: {
          type: 'compaction_end' as const,
          success,
          ...(success
            ? {}
            : {
                error:
                  typeof e['errorMessage'] === 'string'
                    ? e['errorMessage']
                    : 'compaction aborted',
              }),
        } };
        // A joined episode publishes one terminal: success when any compaction
        // in it wrote its summary, else the first failure's own error (the root
        // cause); a cancelled cycle stands only when nothing else ended it.
        const rank = ({ event, aborted: cancelled }: typeof terminal): number => event.success ? 2 : cancelled ? 0 : 1;
        const prior = this.pendingCompactionEnd;
        const replaces = prior === null || rank(terminal) > rank(prior);
        const unpublished = replaces ? prior : terminal;
        if (replaces) this.pendingCompactionEnd = terminal;
        // A failure the join does not publish, replaced or held back, is still logged.
        if (unpublished !== null && rank(unpublished) === 1) {
          this.log('warn', 'joined native compaction failure not published', { role: this.role, session: this.id, error: unpublished.event.error });
        }
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
        this.toolHeartbeat.started(String(e['toolCallId']), String(e['toolName']));
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
        this.toolHeartbeat.ended(String(e['toolCallId']));
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
