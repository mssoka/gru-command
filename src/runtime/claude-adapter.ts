import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { execFile, spawn } from 'node:child_process';
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
import type { GruCommandConfig, Role } from '../config.js';
import { resolveSpawnPolicy } from '../config.js';
import type { LogLevel } from '../logger.js';
import { ROLE_DEFINITIONS } from '../roles.js';
import { LockBusyError, type SessionStore } from '../sessions/store.js';
import { resolveSpawnCwd } from './cwd.js';
import {
  normalizeSessionPath,
  SessionAlreadyActiveError,
} from './session-paths.js';
import {
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
  PromptOptions,
  RuntimeEvent,
  RuntimeEventListener,
  RuntimeHealth,
  SpawnOptions,
} from './types.js';

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

  /**
   * Fail-loud model resolution (SPEC ruling 16): "default"/"" omits the
   * flag (the CLI's own configured model); an explicit "provider/model"
   * strips the provider segment — claude's --model takes an alias or a
   * bare model id (Bedrock-style dotted ids survive: provider is the
   * FIRST segment only).
   */
  private async resolveModel(
    role: Role,
    override?: string,
  ): Promise<{ readonly cliModel?: string; readonly input?: readonly ('text' | 'image')[] }> {
    const ref =
      override !== undefined
        ? override
        : resolveSpawnPolicy(this.config, 'claude-code', role).model;
    if (ref === '' || ref === 'default') return {};
    const slash = ref.indexOf('/');
    if (slash <= 0 || slash >= ref.length - 1) {
      throw new Error(`model reference must be "provider/model" or "default", got: ${ref}`);
    }
    const provider = ref.slice(0, slash);
    const modelId = ref.slice(slash + 1);
    let declared: ReturnType<ModelRuntime['getModel']> = undefined;
    let metadataError: unknown;
    try {
      declared = (await this.runtime()).getModel(provider, modelId);
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
      cliModel: modelId,
      ...(declared !== undefined ? { input: declared.input } : {}),
    };
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
    const tools = mapRoleTools(role, roleDef.tools);
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
    try {
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
          systemPrompt: roleDef.systemPrompt,
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
      );
      this.handles.add(handle);
      this.down = undefined;
      return handle;
    } catch (error) {
      if (lockAcquired && resumeFile !== undefined && !this.activeFiles.has(resumeFile)) {
        this.store.releaseLock(resumeFile);
      }
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
    'bypassPermissions',
    '--tools',
    params.tools.join(','),
    '--append-system-prompt',
    params.systemPrompt,
  ];
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
  private readonly listeners = new Set<RuntimeEventListener>();
  private disposed = false;

  constructor(
    role: Role,
    params: HandleParams,
    capabilities: AgentCapabilities,
    store: SessionStore,
    log: Log = () => {},
    onDispose: () => void = () => {},
    onInfraError: (error: unknown) => void = () => {},
  ) {
    this.role = role;
    this.params = params;
    this.capabilities = capabilities;
    this.id = params.sessionId;
    this.sessionFile = params.sessionFile;
    this.sessionEstablished = params.resume;
    this.store = store;
    this.log = log;
    this.onDispose = onDispose;
    this.onInfraError = onInfraError;
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
    if (text === '' && (options.images === undefined || options.images.length === 0)) {
      throw new Error('empty prompt: nothing to send (no text, no images)');
    }
    if (this.live !== null) {
      throw new Error(
        'claude-code turn in flight — one turn at a time per session ' +
          '(the interface fallback serializes product callers; direct callers must wait)',
      );
    }
    return this.runTurn(text, options.images);
  }

  /** Raw-handle alias: an idle steer is just a prompt (no mid-turn channel exists). */
  async steer(text: string, options: PromptOptions = {}): Promise<void> {
    return this.prompt(text, options);
  }

  /** Raw-handle alias: same reasoning — the wrapper owns the real queue. */
  async followUp(text: string, options: PromptOptions = {}): Promise<void> {
    return this.prompt(text, options);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const live = this.live;
    if (live !== null) {
      // SIGTERM is the documented abort (the CLI exits 143); escalate to
      // SIGKILL if the process ignores it.
      try {
        live.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      const killTimer = setTimeout(() => {
        if (this.live !== null) {
          try {
            this.live.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
      }, this.params.killGraceMs);
      killTimer.unref();
    }
    try {
      this.store.releaseLock(this.sessionFile);
    } finally {
      this.setState('disposed');
      this.onDispose();
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

  private runTurn(text: string, images?: PromptOptions['images']): Promise<void> {
    this.setState('spawning');
    const params = this.params;
    const translator = new ClaudeTurnTranslator();
    let turnStarted = false;

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
        if (error === null) resolve();
        else reject(error);
      };

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
        for (const event of translator.ingest(frame)) this.emit(event);
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
