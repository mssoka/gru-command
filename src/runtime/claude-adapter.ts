import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { execFile, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import {
  closeSync,
  createWriteStream,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { WriteStream } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';
import { finished } from 'node:stream/promises';
import type { GruCommandConfig, Role } from '../config.js';
import { resolveSpawnPolicy } from '../config.js';
import type { LogLevel } from '../logger.js';
import { ROLE_DEFINITIONS } from '../roles.js';
import { LockBusyError, type SessionStore } from '../sessions/store.js';
import { resolveSpawnCwd } from './cwd.js';
import { buildClaudeCodeAuthArgs, claudeCliModel } from './claude-model.js';
import { ReviewMcpBridge } from './review-mcp-bridge.js';
import {
  normalizeSessionPath,
  SessionAlreadyActiveError,
} from './session-paths.js';
import {
  ClaudeControlTranslator,
  ClaudeTurnTranslator,
  extractSessionId,
  NdjsonParser,
  type StreamFrame,
} from './stream-json.js';
import { capabilitiesForModelInput } from './types.js';
import type {
  AgentCapabilities,
  AgentHandle,
  AgentRuntime,
  AgentState,
  PendingTurn,
  PromptOptions,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeHealth,
  SpawnOptions,
} from './types.js';
import { ToolHeartbeat, toolHeartbeatIntervalMs } from './tool-heartbeat.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/** claude-code adapter capabilities, hoisted for the runtime probe (E3 story 3). */
export const CLAUDE_CODE_CAPABILITIES: AgentCapabilities = {
  streaming: true,
  // The -p surface has no mid-turn channel (that lives in the SDK control
  // protocol, out of scope per SPEC ruling 4) — the interface layer queues.
  steer: 'queued',
  resume: 'file',
  images: true,
  thinking: true,
  thinkingLevelControl: true, // via --effort
  followUp: false,
};

/** Thinking levels the claude CLI accepts via --effort (fail-loud on others). */
const CLAUDE_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const;

/**
 * Role tool ids (pi-flavored, src/roles.ts) → claude built-in tool names
 * for --tools (a hard restriction of the tool set, enforced in any
 * permission mode). An unmapped id fails loud at spawn — silently dropping
 * a restriction is never acceptable.
 */
const CLAUDE_TOOL_MAP: Readonly<Record<string, string>> = {
  read: 'Read',
  bash: 'Bash',
  edit: 'Edit',
  write: 'Write',
  grep: 'Grep',
  find: 'Glob',
  ls: 'LS',
};

/** Map role tool ids to claude built-in tool names (fail-loud on unknown). */
export function mapRoleTools(role: Role, tools: readonly string[]): string[] {
  return tools.map((tool) => {
    const mapped = CLAUDE_TOOL_MAP[tool];
    if (mapped === undefined) {
      throw new Error(`role "${role}" tool "${tool}" has no claude-code tool mapping`);
    }
    return mapped;
  });
}

/** Default grace between SIGTERM and SIGKILL when disposing a live turn. */
const DEFAULT_KILL_GRACE_MS = 2_000;
/** Cap on the stderr tail kept for turn-failure error messages. */
const STDERR_TAIL_BYTES = 8_192;
/** Timeout for the one-shot binary availability probe at spawn. */
const BINARY_PROBE_TIMEOUT_MS = 5_000;
/** Resume reads at most this much of the transcript head — the session id
 * lives in the FIRST frame, so a full read would just tax big files. */
const RESUME_SCAN_PREFIX_BYTES = 256 * 1024;

const execFileAsync = promisify(execFile);

/** Caller-facing resume problems (bad/stale transcript path or content) —
 * never adapter health (same exclusion class as LockBusyError). */
export class ResumeFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumeFileError';
  }
}

/** Read only the first `maxBytes` of a file (bounded resume scan). */
function readFilePrefix(file: string, maxBytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytesRead = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

export interface ClaudeCodeRuntimeOptions {
  readonly config: GruCommandConfig;
  readonly store: SessionStore;
  /** The claude binary (name on PATH or absolute path). Default: 'claude'. */
  readonly binary?: string;
  /** Test seam: grace before SIGKILL on dispose. Default 2000ms. */
  readonly killGraceMs?: number;
  /** Test seam: override the long-tool heartbeat cadence. */
  readonly toolHeartbeatMs?: number;
  /** Tests may inject an offline catalog; production restores pi's cached model metadata. */
  readonly modelRuntime?: ModelRuntime;
  readonly log?: Log;
}

/**
 * claude-code AgentRuntime over the headless CLI (EPICS E3 story 1; SPEC
 * ruling 4: `claude -p` with stream-json, NOT the SDK).
 *
 * Shape: PROCESS-PER-TURN. Every delivered prompt spawns
 *   claude -p --output-format stream-json --input-format stream-json
 *           --verbose --include-partial-messages
 *           (--session-id <uuid> | --resume <uuid>) [--model M] [--effort E]
 *           --permission-mode bypassPermissions --tools <role tools>
 *           --append-system-prompt <role prompt>
 * fed with ONE stdin user frame followed by EOF; the turn ends with the
 * `result` frame and the process exits. Session continuity chains through
 * the CLI's own resume substrate keyed by the product-minted session UUID;
 * the product transcript (raw NDJSON frames, append-only) lives in the
 * session store under the standard pi-flavored layout.
 *
 * The raw handle hosts ONE turn at a time and rejects a concurrent prompt
 * loudly — in the product the registry wraps the RUNTIME in withFallbacks,
 * whose wrapper handles serialize every turn (steer-unable →
 * queue-until-idle).
 */
export class ClaudeCodeRuntime implements AgentRuntime {
  readonly id = 'claude-code';
  readonly capabilities: AgentCapabilities = CLAUDE_CODE_CAPABILITIES;

  private readonly config: GruCommandConfig;
  private readonly store: SessionStore;
  private readonly binary: string;
  private readonly killGraceMs: number;
  private readonly log: Log;
  /** Long-tool heartbeat cadence override; derived from the supervision
   * window at spawn when unset (construction must not touch config). */
  private readonly toolHeartbeatMs: number | null;
  private readonly handles = new Set<ClaudeCodeHandle>();
  private modelRuntime: ModelRuntime | undefined;
  /** Normalized session paths currently hosted by this process. */
  private readonly activeFiles = new Set<string>();
  /** Cached binary availability (probed once; re-probed after a failure). */
  private binaryOk = false;
  private down: string | undefined;

  constructor(opts: ClaudeCodeRuntimeOptions) {
    this.config = opts.config;
    this.store = opts.store;
    this.binary = opts.binary ?? 'claude';
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.log = opts.log ?? (() => {});
    this.modelRuntime = opts.modelRuntime;
    this.toolHeartbeatMs = opts.toolHeartbeatMs ?? null;
  }

  /** Long-tool heartbeat cadence for a new handle (config-derived). */
  private heartbeatMs(): number {
    return this.toolHeartbeatMs ?? toolHeartbeatIntervalMs(this.config.supervision.turnSilenceMs);
  }

  private async runtime(): Promise<ModelRuntime> {
    if (this.modelRuntime === undefined) {
      this.modelRuntime = await ModelRuntime.create({ refreshOnCreate: false });
    }
    return this.modelRuntime;
  }

  /**
   * One-shot binary availability probe (cached). A missing/failing binary
   * marks the adapter down and fails spawn naming the binary; a later
   * successful probe clears it. Async — the event loop is never blocked,
   * and the probe runs at most once per spawn attempt (never per turn).
   */
  private async ensureBinary(): Promise<void> {
    if (this.binaryOk) return;
    let detail: string | null = null;
    try {
      await execFileAsync(this.binary, ['--version'], {
        timeout: BINARY_PROBE_TIMEOUT_MS,
        killSignal: 'SIGTERM',
        windowsHide: true,
      });
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        killed?: boolean;
        signal?: string;
        stderr?: string | Buffer;
      };
      detail =
        err.code === 'ENOENT'
          ? 'ENOENT (not found on PATH)'
          : err.killed === true || err.signal != null
            ? `killed by ${err.signal ?? 'timeout'} (probe timeout ${BINARY_PROBE_TIMEOUT_MS}ms)`
            : `exited ${String(err.code)}: ${String(err.stderr ?? '').trim().slice(0, 200)}`;
    }
    if (detail !== null) {
      this.down = `binary "${this.binary}" unavailable: ${detail}`;
      throw new Error(`claude-code runtime cannot spawn: ${this.down}`);
    }
    this.binaryOk = true;
    this.down = undefined;
  }

  /** Turn-spawn ENOENT after a previously-ok probe: the binary vanished. */
  private onInfraError(error: unknown): void {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      this.binaryOk = false;
      this.down = `binary "${this.binary}" vanished mid-run (ENOENT)`;
    }
  }

  /** The CLI, not pi's catalog, is authoritative for model names.
   * Metadata is advisory for conservative vision capability reporting. */
  private async resolveModel(
    role: Role,
    override?: string,
  ): Promise<{ readonly cliModel?: string; readonly input?: readonly ('text' | 'image')[] }> {
    const ref =
      override !== undefined
        ? override
        : resolveSpawnPolicy(this.config, 'claude-code', role).model;
    const cliModel = claudeCliModel(ref);
    if (cliModel === undefined) return {};
    const slash = ref.indexOf('/');
    const provider = slash < 0 ? undefined : ref.slice(0, slash);
    const modelId = cliModel;
    let declared: ReturnType<ModelRuntime['getModel']> = undefined;
    let metadataError: unknown;
    try {
      if (provider !== undefined) declared = (await this.runtime()).getModel(provider, modelId);
    } catch (error) {
      // Metadata enriches the CLI spawn but is not its transport. A torn
      // cache must decline vision conservatively, not take Claude offline.
      metadataError = error;
    }
    if (declared === undefined) {
      this.log('warn', 'claude-code model has no declared input metadata; vision declines conservatively', {
        model: ref,
        ...(metadataError !== undefined ? { error: String(metadataError) } : {}),
      });
    }
    return {
      cliModel,
      ...(declared !== undefined ? { input: declared.input } : {}),
    };
  }

  /** Probe the same native CLI model token spawn will send. Successful
   * authenticated invocation, not pi metadata, proves availability. */
  async checkReviewModel(role: Role): Promise<void> {
    const model = resolveSpawnPolicy(this.config, 'claude-code', role).model;
    // Validate with the same normalizer used by spawn before invoking CLI.
    claudeCliModel(model);
    const probe = spawnSync(this.binary, buildClaudeCodeAuthArgs(model), {
      encoding: 'utf8', timeout: 30_000, input: '', windowsHide: true,
    });
    if (probe.error !== undefined || probe.status !== 0) {
      throw new Error(`claude-code is not configured/authed for the review model: ${String(probe.error ?? probe.stderr ?? `exit ${probe.status}`).trim().slice(0, 300)}`);
    }
  }

  /** Thinking level → --effort value (fail-loud: claude CAN set the level). */
  private resolveThinkingLevel(role: Role, override?: string): string | undefined {
    const ref =
      override !== undefined
        ? override
        : resolveSpawnPolicy(this.config, 'claude-code', role).thinkingLevel;
    if (ref === '' || ref === 'default') return undefined;
    if (!(CLAUDE_EFFORT_LEVELS as readonly string[]).includes(ref)) {
      throw new Error(
        `unknown thinking level "${ref}" for claude-code (valid: default, ${CLAUDE_EFFORT_LEVELS.join(', ')})`,
      );
    }
    return ref;
  }

  async spawn(role: Role, options: SpawnOptions = {}): Promise<AgentHandle> {
    const roleDef = ROLE_DEFINITIONS[role];
    // SPEC ruling 17: an explicit cwd roots the session in the project it
    // serves (the dispatch flow's worktree); absent = workspace root.
    const cwd = resolveSpawnCwd(this.config.workspaceRoot, options.cwd);
    // Validation failures are caller-facing, never adapter health.
    const resolvedModel = await this.resolveModel(role, options.model);
    const model = resolvedModel.cliModel;
    const handleCapabilities = capabilitiesForModelInput(
      CLAUDE_CODE_CAPABILITIES,
      resolvedModel.input,
    );
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
    const fileTools = mapRoleTools(role, reviewMode?.tools ?? roleDef.tools);
    await this.ensureBinary();

    const resumeFile =
      options.resumeFile !== undefined ? normalizeSessionPath(options.resumeFile) : undefined;
    if (resumeFile !== undefined && this.activeFiles.has(resumeFile)) {
      throw new SessionAlreadyActiveError(resumeFile);
    }
    // Same-process single-writer, shared-store flavor: the STORE holding the
    // lock while THIS runtime does not host the file means another runtime
    // instance in this process hosts it (the cross-process case is caught by
    // the lock itself below).
    if (
      resumeFile !== undefined &&
      this.store.isHeld(resumeFile) &&
      !this.activeFiles.has(resumeFile)
    ) {
      throw new SessionAlreadyActiveError(resumeFile);
    }
    // Confinement: resume only files that live in the session store. The
    // isAbsolute branch covers Windows cross-drive escapes (relative() then
    // returns an absolute, backslashed path).
    if (resumeFile !== undefined) {
      const rel = relative(this.store.sessionsDir, resumeFile);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        throw new ResumeFileError(
          `resumeFile must live under the session store (${this.store.sessionsDir}), got: ${resumeFile}`,
        );
      }
    }

    // Resume: lock BEFORE reading the file (single-writer, ruling 1); only
    // release on failure when THIS call acquired it and nobody hosts it.
    let lockAcquired = false;
    if (resumeFile !== undefined && !this.store.isHeld(resumeFile)) {
      this.store.acquireLock(resumeFile);
      lockAcquired = true;
    }
    let createdNewFile: string | null = null;
    let reviewBridge: ReviewMcpBridge | undefined;
    try {
      // ANY isolated-review session that declares native tools gets its own
      // scoped bridge exposing exactly the declared set — leads and lens
      // children ride the same seam (SPEC ruling 4: no harness split).
      if (reviewMode !== undefined && reviewMode.nativeTools !== undefined) {
        reviewBridge = await ReviewMcpBridge.start(reviewMode.nativeTools);
      }
      const nativeTools = reviewBridge?.toolNames.map((name) => `mcp__gru_perkins__${name}`) ?? [];
      const tools = [...fileTools, ...nativeTools];
      let sessionId: string;
      let sessionFile: string;
      // A resume of an empty transcript adopts the minted uuid from the
      // FILENAME and re-mints it on the first turn (the session never
      // registered CLI-side, so --resume would have nothing to resume).
      let established = false;
      if (resumeFile !== undefined) {
        let head: string;
        try {
          head = readFilePrefix(resumeFile, RESUME_SCAN_PREFIX_BYTES);
        } catch (error) {
          throw new ResumeFileError(
            `cannot read transcript ${resumeFile}: ${(error as Error).message}`,
          );
        }
        const extracted = extractSessionId(head);
        if (extracted !== null) {
          sessionId = extracted;
          established = true;
        } else if (statSync(resumeFile).size === 0) {
          const fromName =
            /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(
              basename(resumeFile),
            );
          if (fromName === null) {
            throw new ResumeFileError(
              `transcript ${resumeFile} is empty and its name carries no session uuid — ` +
                'cannot resume (was it written by the claude-code adapter?)',
            );
          }
          sessionId = fromName[1]!;
          this.log('info', 'resume adopts filename session uuid (empty transcript — re-minting)', {
            file: resumeFile,
          });
        } else {
          throw new ResumeFileError(
            `transcript ${resumeFile} has no session id in its first ` +
              `${RESUME_SCAN_PREFIX_BYTES} bytes — cannot resume ` +
              '(was it written by the claude-code adapter?)',
          );
        }
        sessionFile = resumeFile;
      } else {
        sessionId = randomUUID();
        const dir = this.store.sessionDirFor(role, cwd);
        mkdirSync(dir, { recursive: true });
        // pi-standard naming: <ISO-ts-with-dashes>_<uuid>.jsonl
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        sessionFile = join(dir, `${stamp}_${sessionId}.jsonl`);
        writeFileSync(sessionFile, '', { encoding: 'utf-8', flag: 'wx' });
        createdNewFile = sessionFile;
        if (!this.store.isHeld(sessionFile)) {
          this.store.acquireLock(sessionFile);
        }
      }
      this.activeFiles.add(sessionFile);
      const handle = new ClaudeCodeHandle(
        role,
        {
          sessionId,
          sessionFile,
          cwd,
          binary: this.binary,
          tools,
          systemPrompt: reviewMode?.systemPrompt ?? roleDef.systemPrompt,
          isolatedReview: reviewMode !== undefined,
          fileTools,
          nativeTools,
          ...(reviewBridge !== undefined ? {
              mcpConfigFile: reviewBridge.configFile,
              reviewBridge,
              reviewTools: reviewBridge.toolNames,
            } : {}),
          killGraceMs: this.killGraceMs,
          resume: established,
          ...(model !== undefined ? { model } : {}),
          ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
        },
        handleCapabilities,
        this.store,
        this.log,
        () => {
          this.handles.delete(handle);
          this.activeFiles.delete(sessionFile);
        },
        (error) => this.onInfraError(error),
        this.heartbeatMs(),
      );
      this.handles.add(handle);
      this.down = undefined;
      return handle;
    } catch (error) {
      if (lockAcquired && resumeFile !== undefined && !this.activeFiles.has(resumeFile)) {
        this.store.releaseLock(resumeFile);
      }
      await reviewBridge?.close();
      // Never leave an orphan empty transcript behind a failed fresh spawn
      // (it would pollute growth detection and hourly backups forever).
      if (createdNewFile !== null && !this.activeFiles.has(createdNewFile)) {
        try {
          this.store.releaseLock(createdNewFile);
        } catch {
          /* not ours (anymore) */
        }
        try {
          unlinkSync(createdNewFile);
        } catch {
          /* already gone */
        }
      }
      // Caller-facing errors never touch adapter health: state conflicts
      // (SessionAlreadyActiveError, LockBusyError) and bad resume input
      // (ResumeFileError) are the caller's problem; genuine infrastructure
      // failure (fs, binary) latches the adapter down.
      if (
        !(error instanceof SessionAlreadyActiveError) &&
        !(error instanceof LockBusyError) &&
        !(error instanceof ResumeFileError)
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

interface HandleParams {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly cwd: string;
  readonly binary: string;
  readonly tools: readonly string[];
  readonly systemPrompt: string;
  readonly isolatedReview?: boolean;
  readonly fileTools?: readonly string[];
  readonly nativeTools?: readonly string[];
  /** Raw perkins_* names wired through the bridge (capability declaration). */
  readonly reviewTools?: readonly string[];
  readonly mcpConfigFile?: string;
  readonly reviewBridge?: ReviewMcpBridge;
  readonly killGraceMs: number;
  readonly resume: boolean;
  readonly model?: string;
  readonly thinkingLevel?: string;
}

/**
 * The CLI invocation for one turn (pinned verbatim by tests). `resume`
 * selects --resume vs --session-id: the session id may only be MINTED on
 * the first turn; once claude has registered the session, later turns
 * resume it.
 */
export function claudeTurnArgs(params: HandleParams, resume: boolean): string[] {
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    resume ? '--resume' : '--session-id',
    params.sessionId,
    '--permission-mode',
    params.isolatedReview ? 'dontAsk' : 'bypassPermissions',
    '--tools',
    params.tools.join(','),
    params.isolatedReview ? '--system-prompt' : '--append-system-prompt',
    params.systemPrompt,
  ];
  if (params.isolatedReview) {
    args.push(
      '--safe-mode',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--setting-sources',
      '',
      '--no-chrome',
    );
    const absoluteRoot = params.cwd.replaceAll('\\', '/').replace(/\/+$/, '');
    // A literal backslash in a POSIX path is rewritten above and would point
    // the confinement glob somewhere else — reject it off-Windows.
    if (
      /[*?[\]{}(),!\r\n]/u.test(absoluteRoot) ||
      (process.platform !== 'win32' && params.cwd.includes('\\'))
    ) {
      throw new Error('isolated review cwd contains pattern metacharacters unsafe for Claude allowedTools confinement');
    }
    const allowed = [
      ...(params.fileTools ?? params.tools).map((tool) => `${tool}(${absoluteRoot}/**)`),
      ...(params.nativeTools ?? []),
    ];
    if (allowed.length > 0) args.push('--allowedTools', allowed.join(','));
    if (params.mcpConfigFile !== undefined) args.push('--mcp-config', params.mcpConfigFile);
  }
  if (params.model !== undefined) args.push('--model', params.model);
  if (params.thinkingLevel !== undefined) args.push('--effort', params.thinkingLevel);
  return args;
}

/** The stdin user frame for one prompt (image blocks first, then text). */
export function claudePromptFrame(text: string, images?: PromptOptions['images']): StreamFrame {
  let content: string | StreamFrame[] = text;
  if (images !== undefined && images.length > 0) {
    content = [
      ...images.map((image) => ({
        type: 'image',
        source: { type: 'base64', media_type: image.mediaType, data: image.data },
      })),
      ...(text !== '' ? [{ type: 'text', text }] : []),
    ];
  }
  return { type: 'user', message: { role: 'user', content } };
}

/**
 * One live claude-code session. Holds the session lock for its lifetime;
 * spawns one CLI process per turn; appends raw NDJSON frames to the
 * transcript. steer()/followUp() alias prompt() on the raw handle — the
 * real single-writer/queue semantics live in the interface fallback
 * wrapper (the registry applies it for this steer-unable runtime).
 */
export class ClaudeCodeHandle implements AgentHandle {
  readonly role: Role;
  readonly id: string;
  readonly sessionFile: string;
  readonly reviewIsolation?: true;
  readonly reviewTools?: readonly string[];
  readonly capabilities: AgentCapabilities;

  private readonly params: HandleParams;
  private readonly store: SessionStore;
  private readonly log: Log;
  private readonly onDispose: () => void;
  private readonly onInfraError: (error: unknown) => void;
  /** True once claude has registered the session (validated init frame) —
   * later turns chain with --resume instead of re-minting --session-id. */
  private sessionEstablished: boolean;
  private state: AgentState = 'idle';
  private lastActivity: string | null = null;
  private stateError: string | undefined;
  private live: ChildProcess | null = null;
  private liveTranscript: WriteStream | null = null;
  private settleLiveOnDispose: (() => void) | null = null;
  /** The prompt behind the live CLI turn — supervision's resume snapshot. */
  private livePrompt: PendingTurn | null = null;
  /** Long-tool heartbeats: an open tool call keeps the event surface alive. */
  private readonly toolHeartbeat: ToolHeartbeat;
  private compacting = false;
  private readonly listeners = new Set<RuntimeEventListener>();
  private disposed = false;
  private disposalPromise: Promise<void> | null = null;

  constructor(
    role: Role,
    params: HandleParams,
    capabilities: AgentCapabilities,
    store: SessionStore,
    log: Log = () => {},
    onDispose: () => void = () => {},
    onInfraError: (error: unknown) => void = () => {},
    toolHeartbeatMs = 60_000,
  ) {
    this.role = role;
    this.params = params;
    this.capabilities = capabilities;
    this.id = params.sessionId;
    this.sessionFile = params.sessionFile;
    if (params.isolatedReview) this.reviewIsolation = true;
    if (params.reviewTools !== undefined && params.reviewTools.length > 0) {
      this.reviewTools = [...params.reviewTools];
    }
    this.sessionEstablished = params.resume;
    this.store = store;
    this.log = log;
    this.onDispose = onDispose;
    this.onInfraError = onInfraError;
    this.toolHeartbeat = new ToolHeartbeat((event) => this.emit(event), toolHeartbeatMs);
  }

  /**
   * Live-process probe (E7): the CLI child hosting the turn is running
   * and at least one tool call is still open — activity, not a hang.
   */
  hasLiveProcess = (): boolean =>
    !this.disposed && this.live !== null && this.toolHeartbeat.openCalls > 0;

  /** The live turn's prompt — snapshotted by supervision before a restart. */
  pendingTurn = (): PendingTurn | null => this.livePrompt;

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
    if (text === '' && (options.images === undefined || options.images.length === 0)) {
      throw new Error('empty prompt: nothing to send (no text, no images)');
    }
    if (this.live !== null || this.compacting) {
      throw new Error(
        'claude-code turn in flight or control active — one operation at a time per session ' +
          '(the interface fallback serializes product callers; direct callers must wait)',
      );
    }
    return this.runTurn(text, options.owner ?? null, options.images);
  }

  /** Raw-handle alias: an idle steer is just a prompt (no mid-turn channel exists). */
  async steer(text: string, options: PromptOptions = {}): Promise<void> {
    return this.prompt(text, options);
  }

  /** Raw-handle alias: same reasoning — the wrapper owns the real queue. */
  async followUp(text: string, options: PromptOptions = {}): Promise<void> {
    return this.prompt(text, options);
  }

  canCompact = (): boolean =>
    !this.disposed && this.sessionEstablished && this.live === null && !this.compacting;

  isCompacting = (): boolean => this.compacting;

  /** Claude's print transport exposes no trustworthy whole-context usage.
   * Deliberately omit getContextUsage rather than deriving a percentage from
   * per-turn token counts or transcript bytes. */

  compact = async (): Promise<void> => {
    this.assertLive();
    if (!this.sessionEstablished) {
      throw new Error('claude-code session is not established; nothing can be compacted');
    }
    if (this.live !== null || this.compacting) {
      throw new Error('agent session is busy; compaction requires an idle session');
    }
    this.compacting = true;
    this.emit({ type: 'compaction_start' });
    try {
      await this.runCompactionControl();
      this.emit({ type: 'compaction_end', success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: 'compaction_end', success: false, error: message });
      throw error;
    } finally {
      this.compacting = false;
    }
  };

  dispose(): Promise<void> {
    // Every caller observes the same terminal cleanup. Returning early merely
    // because disposed was marked would expose a still-running child and a
    // still-held session lock to concurrent supervisor/chat recovery.
    this.disposalPromise ??= this.disposeOnce();
    return this.disposalPromise;
  }

  private async disposeOnce(): Promise<void> {
    this.disposed = true;
    this.toolHeartbeat.dispose();
    const live = this.live;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let exitDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
    if (live !== null) {
      const childExited =
        live.exitCode !== null || live.signalCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              live.once('close', () => resolve());
              live.once('error', () => resolve());
            });
      // SIGTERM is the documented abort (the CLI exits 143); escalate to
      // SIGKILL if the process ignores it. A second bounded grace after the
      // forced kill prevents a broken ChildProcess implementation from
      // retaining the transcript and session lock forever.
      try {
        live.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        if (this.live !== null) {
          try {
            this.live.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }, this.params.killGraceMs);
      killTimer.unref();
      const exitDeadline = new Promise<void>((resolve) => {
        exitDeadlineTimer = setTimeout(resolve, this.params.killGraceMs * 2);
        exitDeadlineTimer.unref();
      });
      await Promise.race([childExited, exitDeadline]);
      clearTimeout(killTimer);
      if (exitDeadlineTimer !== null) clearTimeout(exitDeadlineTimer);

      const flushDeadline = Date.now() + this.params.killGraceMs;
      while (this.live !== null && Date.now() < flushDeadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      if (this.live !== null) {
        // A dead or non-reporting child can leave a wedged filesystem stream.
        // Cancel buffered writes and settle the operation before releasing
        // ownership so disposal remains deterministic.
        const transcript = this.liveTranscript;
        if (transcript !== null) {
          const closed = finished(transcript).catch(() => {});
          transcript.destroy(new Error('session transcript flush timed out'));
          await closed;
        }
        this.settleLiveOnDispose?.();
      }
    }
    try {
      this.store.releaseLock(this.sessionFile);
    } finally {
      try {
        await this.params.reviewBridge?.close();
      } finally {
        this.setState('disposed');
        this.onDispose();
      }
    }
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('agent session disposed');
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

  /** A dedicated, resumed native slash-command process. Its machine frames
   * remain in the native transcript for forensics, but content events are
   * intentionally discarded so `/compact` output can never become chat text. */
  private runCompactionControl(): Promise<void> {
    const params = this.params;
    const translator = new ClaudeControlTranslator();

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let failed = false;
      let failure = '';
      let child: ChildProcess | null = null;
      let stderrTail = '';
      let sawInit = false;

      const settle = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        this.live = null;
        this.liveTranscript = null;
        this.settleLiveOnDispose = null;
        if (error === null) resolve();
        else reject(error);
      };
      this.settleLiveOnDispose = () => settle(new Error('agent session disposed'));
      const fail = (detail: string): void => {
        if (failed) return;
        failed = true;
        failure = detail;
      };

      let transcript: WriteStream;
      try {
        transcript = createWriteStream(params.sessionFile, { flags: 'a' });
        this.liveTranscript = transcript;
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      transcript.on('error', (error: Error) => {
        this.log('error', 'session transcript write failed during compaction', {
          file: params.sessionFile,
          error: String(error),
        });
        fail(`session transcript write failed during compaction: ${String(error)}`);
        try {
          child?.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      });

      const handleFrame = (frame: StreamFrame): void => {
        if (!transcript.write(`${JSON.stringify(frame)}\n`)) {
          child?.stdout?.pause();
          transcript.once('drain', () => child?.stdout?.resume());
        }
        const reportedSession = frame['session_id'];
        const terminal = frame['type'] === 'result';
        if (
          (typeof reportedSession === 'string' && reportedSession !== params.sessionId) ||
          (terminal && (typeof reportedSession !== 'string' || reportedSession === ''))
        ) {
          fail(
            `session id mismatch: requested ${params.sessionId}, claude reported ` +
              `${typeof reportedSession === 'string' && reportedSession !== '' ? reportedSession : '(empty)'} ` +
              'during compaction',
          );
          try {
            child?.kill('SIGTERM');
          } catch {
            /* already gone */
          }
        }
        if (
          terminal &&
          (typeof frame['is_error'] !== 'boolean' ||
            typeof frame['subtype'] !== 'string' ||
            frame['subtype'] === '')
        ) {
          fail('claude compaction returned a malformed result frame');
          try {
            child?.kill('SIGTERM');
          } catch {
            /* already gone */
          }
        }
        // Parse the same machine protocol as turns, but deliberately do not
        // emit any translated text/thinking/tool events.
        translator.ingest(frame);
        if (frame['type'] === 'system' && frame['subtype'] === 'init') {
          sawInit = true;
          const init = translator.init;
          if (init === null || init.sessionId !== params.sessionId) {
            fail(
              `session id mismatch: requested ${params.sessionId}, claude init reported ` +
                `${init?.sessionId || '(empty)'} during compaction`,
            );
            try {
              child?.kill('SIGTERM');
            } catch {
              /* already gone */
            }
          }
        }
      };
      const parser = new NdjsonParser({
        onFrame: handleFrame,
        onGarbage: (line) =>
          this.log('warn', 'skipping non-JSON line on claude compaction stdout', {
            line: line.slice(0, 200),
          }),
      });

      try {
        // Compaction is meaningful only for an established conversation, so
        // this path ALWAYS resumes; it never mints or forks a session.
        child = spawn(params.binary, claudeTurnArgs(params, true), {
          cwd: params.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        this.onInfraError(error);
        transcript.end(() =>
          settle(new Error(`claude compaction process failed to spawn: ${String(error)}`)),
        );
        return;
      }
      this.live = child;
      child.stdout?.on('data', (chunk: Buffer) => parser.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
      });
      child.on('error', (error: Error) => {
        this.onInfraError(error);
        fail(`claude compaction process failed to spawn: ${String(error)}`);
        parser.end();
        transcript.end(() => settle(new Error(failure)));
      });
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        parser.end();
        transcript.end(() => {
          if (this.disposed) {
            settle(new Error('agent session disposed'));
            return;
          }
          const result = translator.result;
          if (!failed && !sawInit) {
            fail('claude compaction completed without an init frame');
          }
          if (!failed && result === null) {
            const via = signal !== null ? `signal ${signal}` : `exit ${code}`;
            fail(
              `claude compaction ended via ${via} without a result frame` +
                (stderrTail.trim() !== '' ? `: ${stderrTail.trim()}` : ''),
            );
          }
          if (!failed && result?.isError === true) {
            fail(result.text ?? `claude compaction failed (${result.subtype})`);
          }
          if (!failed && (signal !== null || code !== 0)) {
            const via = signal !== null ? `signal ${signal}` : `exit ${code}`;
            fail(
              `claude compaction ended via ${via}` +
                (stderrTail.trim() !== '' ? `: ${stderrTail.trim()}` : ''),
            );
          }
          const compactFailure = translator.compactFailure;
          if (!failed && compactFailure !== null) fail(compactFailure);
          if (!failed && !translator.compactSucceeded) {
            fail(
              'claude compact command completed without a native compact success status or boundary',
            );
          }
          settle(failed ? new Error(failure) : null);
        });
      });

      child.stdin?.write(`${JSON.stringify(claudePromptFrame('/compact'))}\n`, (error) => {
        if (error != null) fail(`failed to write claude compaction command: ${String(error)}`);
        child?.stdin?.end();
      });
    });
  }

  private runTurn(text: string, owner: string | null, images?: PromptOptions['images']): Promise<void> {
    this.setState('spawning');
    const params = this.params;
    const translator = new ClaudeTurnTranslator();
    let turnStarted = false;
    this.livePrompt = {
      text,
      owner,
      ...(images !== undefined && images.length > 0 ? { images } : {}),
    };

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let failed = false;
      let failure = '';
      let child: ChildProcess;
      let stderrTail = '';

      const settle = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        this.live = null;
        this.liveTranscript = null;
        this.settleLiveOnDispose = null;
        this.livePrompt = null;
        // The process is gone; a tool whose terminal frame never arrived
        // must not keep heartbeating a dead turn.
        this.toolHeartbeat.clear();
        if (error === null) resolve();
        else reject(error);
      };
      this.settleLiveOnDispose = () => settle(new Error('agent session disposed'));

      // Mark the turn failed (loud, once). Settling happens in the close
      // handler so the transcript stream is always flushed first.
      const failTurn = (detail: string): void => {
        if (failed) return;
        failed = true;
        failure = detail;
        if (!this.disposed) {
          this.emit({ type: 'error', error: detail, fatal: false });
          this.setState('error', detail);
        }
      };

      // Raw-line forensics: frames append to the transcript BEFORE
      // translation, so a translator fault can never cost the record.
      let transcript: WriteStream;
      try {
        transcript = createWriteStream(params.sessionFile, { flags: 'a' });
        this.liveTranscript = transcript;
      } catch (error) {
        failTurn(String(error));
        settle(new Error(failure));
        return;
      }
      transcript.on('error', (error: Error) => {
        // The transcript is the forensic record: a write failure is loud in
        // the log but never kills the user's turn mid-flight.
        this.log('error', 'session transcript write failed', {
          file: params.sessionFile,
          error: String(error),
        });
      });

      const handleFrame = (frame: StreamFrame): void => {
        transcript.write(`${JSON.stringify(frame)}\n`);
        for (const event of translator.ingest(frame)) {
          if (event.type === 'tool_start') this.toolHeartbeat.started(event.callId, event.tool);
          else if (event.type === 'tool_end') this.toolHeartbeat.ended(event.callId);
          this.emit(event);
        }
        if (
          !turnStarted &&
          frame['type'] === 'system' &&
          frame['subtype'] === 'init'
        ) {
          turnStarted = true;
          const init = translator.init;
          if (init !== null && init.sessionId !== params.sessionId) {
            failTurn(
              `session id mismatch: requested ${params.sessionId}, claude reported ` +
                `${init.sessionId || '(empty)'} — refusing to continue a foreign session`,
            );
            try {
              child.kill('SIGTERM');
            } catch {
              /* already gone */
            }
            return;
          }
          this.setState('streaming');
          this.emit({ type: 'turn_start' });
          this.sessionEstablished = true;
        }
      };

      const parser = new NdjsonParser({
        onFrame: handleFrame,
        onGarbage: (line) =>
          this.log('warn', 'skipping non-JSON line on claude stdout', {
            line: line.slice(0, 200),
          }),
      });

      try {
        child = spawn(params.binary, claudeTurnArgs(params, this.sessionEstablished), {
          cwd: params.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        // Synchronous spawn faults (async ENOENT arrives via 'error').
        this.onInfraError(error);
        failTurn(`claude process failed to spawn: ${String(error)}`);
        transcript.end(() => settle(new Error(failure)));
        return;
      }
      this.live = child;

      child.stdout?.on('data', (chunk: Buffer) => parser.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
      });
      child.on('error', (error: Error) => {
        // Async spawn failure (ENOENT when the binary is missing, ...).
        // 'close' may never follow — settle here too (guarded).
        this.onInfraError(error);
        failTurn(`claude process failed to spawn: ${String(error)}`);
        parser.end();
        transcript.end(() => settle(new Error(failure)));
      });
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        parser.end();
        transcript.end(() => {
          if (this.disposed) {
            settle(new Error('agent session disposed'));
            return;
          }
          const result = translator.result;
          if (!failed && result !== null && !turnStarted) {
            // Frames flowed but no init ever arrived: the session identity
            // was never verified — a protocol violation, not a success.
            failTurn('claude completed without an init frame — session identity never verified');
          }
          if (!failed && result !== null) {
            this.emit({ type: 'turn_end' });
            if (result.isError) {
              // In-band error (pi W7 parity): the turn COMPLETED with an
              // error — resolve, sticky error state, next turn recovers.
              const detail = result.text ?? `turn ended with result subtype "${result.subtype}"`;
              this.emit({ type: 'error', error: detail, fatal: false });
              this.setState('error', detail);
            } else {
              this.setState('idle');
            }
            settle(null);
            return;
          }
          if (!failed) {
            const via = signal !== null ? `signal ${signal}` : `exit ${code}`;
            failTurn(
              `claude ended via ${via} without a result frame` +
                (stderrTail.trim() !== '' ? `: ${stderrTail.trim()}` : ''),
            );
          }
          settle(new Error(failure));
        });
      });

      // One user frame, then EOF — the CLI completes the turn and exits.
      const frame = `${JSON.stringify(claudePromptFrame(text, images))}\n`;
      child.stdin?.write(frame, (error?: Error | null) => {
        if (error != null) {
          this.log('error', 'failed to write prompt frame to claude stdin', {
            error: String(error),
          });
        }
        child.stdin?.end();
      });
    });
  }
}
