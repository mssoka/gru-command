import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { join, relative } from 'node:path';
import type { GruCommandConfig, Role } from '../config.js';
import { resolveSpawnPolicy } from '../config.js';
import type { LogLevel } from '../logger.js';
import { ROLE_DEFINITIONS } from '../roles.js';
import { LockBusyError, type SessionStore } from '../sessions/store.js';
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

export interface ClaudeCodeRuntimeOptions {
  readonly config: GruCommandConfig;
  readonly store: SessionStore;
  /** The claude binary (name on PATH or absolute path). Default: 'claude'. */
  readonly binary?: string;
  /** Test seam: grace before SIGKILL on dispose. Default 2000ms. */
  readonly killGraceMs?: number;
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
 * loudly — in the product the registry wraps every handle in
 * withFallbacks, which is the serializer (steer-unable → queue-until-idle).
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
  }

  /**
   * One-shot binary availability probe (cached). A missing/failing binary
   * marks the adapter down and fails spawn naming the binary; a later
   * successful probe clears it.
   */
  private ensureBinary(): void {
    if (this.binaryOk) return;
    const probe = spawnSync(this.binary, ['--version'], {
      timeout: BINARY_PROBE_TIMEOUT_MS,
      killSignal: 'SIGTERM',
      encoding: 'utf8',
    });
    const detail =
      probe.error !== undefined
        ? String((probe.error as NodeJS.ErrnoException).code ?? probe.error)
        : probe.signal !== null
          ? `killed by ${probe.signal} (probe timeout ${BINARY_PROBE_TIMEOUT_MS}ms)`
          : probe.status !== 0
            ? `exited ${probe.status}: ${String(probe.stderr ?? '').trim().slice(0, 200)}`
            : null;
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
  private resolveModel(role: Role, override?: string): string | undefined {
    const ref =
      override !== undefined
        ? override
        : resolveSpawnPolicy(this.config, 'claude-code', role).model;
    if (ref === '' || ref === 'default') return undefined;
    const slash = ref.indexOf('/');
    if (slash <= 0 || slash >= ref.length - 1) {
      throw new Error(`model reference must be "provider/model" or "default", got: ${ref}`);
    }
    return ref.slice(slash + 1);
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
    const cwd = this.config.workspaceRoot;
    // Validation failures are caller-facing, never adapter health.
    const model = this.resolveModel(role, options.model);
    const thinkingLevel = this.resolveThinkingLevel(role, options.thinkingLevel);
    const tools = mapRoleTools(role, roleDef.tools);
    this.ensureBinary();

    const resumeFile =
      options.resumeFile !== undefined ? normalizeSessionPath(options.resumeFile) : undefined;
    if (resumeFile !== undefined && this.activeFiles.has(resumeFile)) {
      throw new SessionAlreadyActiveError(resumeFile);
    }
    // Confinement: resume only files that live in the session store.
    if (resumeFile !== undefined) {
      const rel = relative(this.store.sessionsDir, resumeFile);
      if (rel === '' || rel.startsWith('..') || rel.includes(':/')) {
        throw new Error(
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
    try {
      let sessionId: string;
      let sessionFile: string;
      if (resumeFile !== undefined) {
        const extracted = extractSessionId(readFileSync(resumeFile, 'utf-8'));
        if (extracted === null) {
          throw new Error(
            `transcript ${resumeFile} has no session id — cannot resume ` +
              '(was it written by the claude-code adapter?)',
          );
        }
        sessionId = extracted;
        sessionFile = resumeFile;
      } else {
        sessionId = randomUUID();
        const dir = this.store.sessionDirFor(role, cwd);
        mkdirSync(dir, { recursive: true });
        // pi-standard naming: <ISO-ts-with-dashes>_<uuid>.jsonl
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        sessionFile = join(dir, `${stamp}_${sessionId}.jsonl`);
        writeFileSync(sessionFile, '', { encoding: 'utf-8', flag: 'wx' });
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
          resume: resumeFile !== undefined,
          ...(model !== undefined ? { model } : {}),
          ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
        },
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
    store: SessionStore,
    log: Log = () => {},
    onDispose: () => void = () => {},
    onInfraError: (error: unknown) => void = () => {},
  ) {
    this.role = role;
    this.params = params;
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
