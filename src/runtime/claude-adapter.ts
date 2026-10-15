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
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import { finished } from 'node:stream/promises';
import type { GruCommandConfig, Role } from '../config.js';
import { CLAUDE_CODE_THINKING_LEVELS as CLAUDE_EFFORT_LEVELS, DEFAULT_CLAUDE_MCP_MODE, resolveSpawnPolicy } from '../config.js';
import type { LogLevel } from '../logger.js';
import { ROLE_DEFINITIONS } from '../roles.js';
import { managedSkillsPromptNote } from './managed-skills.js';
import { LockBusyError, type SessionStore } from '../sessions/store.js';
import { resolveSpawnCwd } from './cwd.js';
import { buildClaudeCodeAuthArgs, claudeCliModel, claudeReviewIsolationArgs } from './claude-model.js';
import {
  claudeReviewProcessEnv, materializeClaudeReviewCredentials, privateClaudeReviewSettings,
  resolveClaudeReviewConfiguration, userClaudeSettingsFile,
  type ClaudeReviewSnapshot,
} from './claude-review-settings.js';
import { ReviewMcpBridge } from './review-mcp-bridge.js';
import { ClaudeVerificationPermissionChannel, privateClaudeVerificationSettings } from './claude-verification-settings.js';
import type { WorkerVerificationPolicy } from './worker-verification-policy.js';
import {
  normalizeSessionPath,
  SessionAlreadyActiveError,
} from './session-paths.js';
import {
  ClaudeControlTranslator,
  ClaudeTurnTranslator,
  extractSessionId,
  NdjsonParser,
  type ApiErrorInfo,
  type ResultInfo,
  type StreamFrame,
} from './stream-json.js';
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
import { disposeAll } from './disposal.js';
import { CLAUDE_CODE_CAPABILITIES } from './capabilities.js';
import { DirectiveCheckpointError, type DirectiveCheckpoint, type DirectiveTurnIdentity } from './directive-checkpoint.js';
import { CLAUDE_NATIVE_PROVIDER } from '../provider-recovery/classify.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

// The declaration now lives in the dependency-light `capabilities.js` so the
// runtime probe can report it without loading this adapter's SDK graph; the
// re-export keeps every existing import surface (and object identity) intact.
export { CLAUDE_CODE_CAPABILITIES };

/**
 * Role tool ids (pi-flavored, src/roles.ts) → claude built-in tool names
 * for --tools (a hard restriction of the built-in tool set, enforced in any
 * permission mode). An unmapped id fails loud at spawn — silently dropping
 * a restriction is never acceptable. Every target must be a tool the CLI
 * actually ships: the CLI silently ignores unknown --tools names (it dropped
 * its `LS` tool), so directory listing maps to Glob, its listing tool.
 */
const CLAUDE_TOOL_MAP: Readonly<Record<string, string>> = {
  read: 'Read',
  bash: 'Bash',
  edit: 'Edit',
  write: 'Write',
  grep: 'Grep',
  find: 'Glob',
  ls: 'Glob',
};

/** Map role tool ids to claude built-in tool names (fail-loud on unknown;
 * several role ids may share one claude tool, which is listed once). */
export function mapRoleTools(role: Role, tools: readonly string[]): string[] {
  const mapped = tools.map((tool) => {
    const name = CLAUDE_TOOL_MAP[tool];
    if (name === undefined) {
      throw new Error(`role "${role}" tool "${tool}" has no claude-code tool mapping`);
    }
    return name;
  });
  return [...new Set(mapped)];
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
  /** Owned subprocess fixture seam; production uses Node's spawn unchanged. */
  readonly spawnProcess?: typeof spawn;
  /** Test seam: grace before SIGKILL on dispose. Default 2000ms. */
  readonly killGraceMs?: number;
  /** Test seam: override the long-tool heartbeat cadence. */
  readonly toolHeartbeatMs?: number;
  /** Test seam for the user Claude settings source (never the review repo). */
  readonly reviewSettingsFile?: string;
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
 *           [--strict-mcp-config [--mcp-config <cwd>/.mcp.json]]
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
  private readonly spawnProcess: typeof spawn;
  private readonly killGraceMs: number;
  private readonly log: Log;
  private readonly reviewSettingsFile: string;
  /** Long-tool heartbeat cadence override; derived from the supervision
   * window at spawn when unset (construction must not touch config). */
  private readonly toolHeartbeatMs: number | null;
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
    this.spawnProcess = opts.spawnProcess ?? spawn;
    this.killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.log = opts.log ?? (() => {});
    this.reviewSettingsFile = opts.reviewSettingsFile ?? userClaudeSettingsFile();
    this.toolHeartbeatMs = opts.toolHeartbeatMs ?? null;
  }

  /** Long-tool heartbeat cadence for a new handle (config-derived). */
  private heartbeatMs(): number {
    return this.toolHeartbeatMs ?? toolHeartbeatIntervalMs(this.config.supervision.turnSilenceMs);
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

  /** The CLI, not pi's catalog, is authoritative for model names; Claude
   * Code is always Anthropic, so no provider or catalog lookup is needed. */
  private resolveModel(role: Role, override?: string): string | undefined {
    return claudeCliModel(override ?? resolveSpawnPolicy(this.config, 'claude-code', role).model);
  }

  /** Probe under the request-owned settings given to this review's lead
   * and lenses. Never store the proof on the shared adapter. */
  async prepareReviewModel(role: Role): Promise<ClaudeReviewSnapshot> {
    const configuration = materializeClaudeReviewCredentials(resolveClaudeReviewConfiguration(
      resolveSpawnPolicy(this.config, 'claude-code', role).model, this.reviewSettingsFile,
    ), this.reviewSettingsFile);
    claudeCliModel(configuration.modelRef);
    const settings = privateClaudeReviewSettings(configuration.settings);
    try {
      const probe = spawnSync(this.binary, buildClaudeCodeAuthArgs(configuration.modelRef, settings.file), {
        encoding: 'utf8', timeout: 30_000, input: '', windowsHide: true,
        env: claudeReviewProcessEnv(configuration),
      });
      if (probe.error !== undefined || probe.status !== 0) {
        throw new Error(`claude-code is not configured/authed for the review model: ${String(probe.error ?? probe.stderr ?? `exit ${probe.status}`).trim().slice(0, 300)}`);
      }
      return { role, ...configuration };
    } finally {
      settings.dispose();
    }
  }

  async checkReviewModel(role: Role): Promise<void> {
    await this.prepareReviewModel(role);
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
    const reviewMode = options.reviewLead ?? options.isolatedReview;
    if (options.reviewModel !== undefined && reviewMode === undefined) {
      throw new Error('a review model snapshot requires an isolated review lead or lens');
    }
    // Issue #283: the lane-bound GC-managed BMAD runtime loads as a session
    // plugin (namespaced, so a repo-local copy can never shadow it). Review
    // sessions never carry it.
    const managed = reviewMode === undefined ? options.managedSkills : undefined;
    if (options.reviewModel !== undefined && options.reviewModel.role !== role) {
      throw new Error(`review model snapshot belongs to ${options.reviewModel.role}, not ${role}`);
    }
    // Direct isolated spawns resolve independently; production preflight
    // supplies the request's snapshot to every lead/lens in that round.
    const configuredReviewModel = resolveSpawnPolicy(this.config, 'claude-code', role).model;
    const reviewConfiguration = reviewMode === undefined ? undefined :
      options.reviewModel ?? materializeClaudeReviewCredentials(resolveClaudeReviewConfiguration(
        options.model ?? configuredReviewModel, this.reviewSettingsFile,
      ), this.reviewSettingsFile);
    if (options.reviewModel !== undefined && options.model !== undefined &&
        claudeCliModel(options.model) !== claudeCliModel(options.reviewModel.modelRef)) {
      throw new Error(`review model override "${options.model}" differs from the preflighted model; re-run preflight with the selected model`);
    }
    // Validation failures are caller-facing, never adapter health.
    const model = this.resolveModel(role, reviewConfiguration?.modelRef ?? options.model);
    // Every Claude model accepts images (owner ruling 2026-10-15): the
    // adapter's declared capabilities hold for every handle.
    const handleCapabilities = CLAUDE_CODE_CAPABILITIES;
    const thinkingLevel = this.resolveThinkingLevel(role, options.thinkingLevel);
    const isolatedReview = options.isolatedReview;
    const reviewLead = options.reviewLead;
    if (isolatedReview !== undefined && reviewLead !== undefined) {
      throw new Error('a review session cannot be both a lead and a lens child');
    }
    if (reviewMode !== undefined && options.resumeFile !== undefined) {
      throw new Error('isolated review sessions must be fresh and cannot resume ambient context');
    }
    // Issue #161: a declared role-tool override narrows (never widens) the
    // role's own set — enforced here exactly as the pi adapter does.
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
    const fileTools = mapRoleTools(role, reviewMode?.tools ?? options.roleTools ?? roleDef.tools);
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
    let reviewSettings: ReturnType<typeof privateClaudeReviewSettings> | undefined;
    let verificationSettings: ReturnType<typeof privateClaudeVerificationSettings> | undefined;
    try {
      // Issue #315: an ordinary worker session on a lane that declares
      // verification scopes carries private native ask/hook settings, so the
      // known direct producer commands are refused before they start.
      // Isolated review sessions keep their ambient-free settings.
      if (reviewMode === undefined && options.workerVerification !== undefined && fileTools.includes('Bash')) {
        verificationSettings = privateClaudeVerificationSettings(options.workerVerification);
      }
      if (reviewConfiguration !== undefined) {
        reviewSettings = privateClaudeReviewSettings(reviewConfiguration.settings);
      }
      // Review sessions (leads/lens children) get their scoped bridge
      // exactly as before. Issue #161 DECLARED CAPABILITY GAP: a
      // non-review parent session must NOT be given product-native tools
      // on this runtime — the MCP bridge is a same-UID-discoverable
      // loopback socket, and another worker process under the service uid
      // could invoke the parent's tools (impersonation) and bypass nested-
      // delegation bounds. Parent child-worker tools are hosted in-process
      // on runtimes that can execute them in the service process (pi), and
      // this refusal is loud rather than silently unhosted.
      if (reviewMode === undefined && options.nativeTools !== undefined && options.nativeTools.length > 0) {
        throw new Error(
          'claude-code cannot host product-native non-review tools: its session bridge is a discoverable same-uid socket ' +
            '(use the pi runtime for parent child-worker tools — declared capability gap, issue #161)',
        );
      }
      // Owner decision 2026-10-15: ordinary sessions load no ambient MCP
      // servers unless [runtimes.claude-code] mcp opts in. --tools restricts
      // built-ins only, so without this every server in the operator's own
      // Claude configuration (claude.ai connectors included) would run under
      // bypassPermissions regardless of the role's declared tools.
      // A narrowed tool set (a bounded child worker) never gains ambient MCP:
      // those tools would sidestep its narrowed roleTools. Project servers are
      // lane content: only a role whose own tools include a shell (it could
      // run any such command already) loads them — see
      // checkedInProjectMcpConfig. Project mode is resolved per turn (each
      // turn is a fresh CLI process).
      const mcpMode = this.config.runtimes.policies['claude-code']?.mcp ?? DEFAULT_CLAUDE_MCP_MODE;
      const shellRole = roleDef.tools.includes('bash');
      const ambientMcp: HandleParams['ambientMcp'] =
        reviewMode !== undefined || mcpMode === 'none' || options.roleTools !== undefined ? { mode: 'none' }
          : mcpMode === 'user' ? { mode: 'user' } : shellRole ? { mode: 'project' } : { mode: 'none' };
      if (reviewMode === undefined && mcpMode === 'project' && options.roleTools === undefined && !shellRole) {
        this.log('info', 'mcp = "project": a role without a shell loads no project MCP servers', { role });
      }
      const declaredNativeTools = reviewMode !== undefined ? reviewMode.nativeTools : undefined;
      if (declaredNativeTools !== undefined && declaredNativeTools.length > 0) {
        reviewBridge = await ReviewMcpBridge.start(declaredNativeTools);
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
          spawnProcess: this.spawnProcess,
          tools,
          systemPrompt: reviewMode?.systemPrompt ?? (managed === undefined
            ? roleDef.systemPrompt
            : `${roleDef.systemPrompt}\n\n${managedSkillsPromptNote(managed, 'claude-code')}`),
          isolatedReview: reviewMode !== undefined,
          ...(managed !== undefined ? { managedPluginDir: managed.root } : {}),
          ...(reviewSettings?.file !== undefined ? { reviewSettingsFile: reviewSettings.file } : {}),
          ...(verificationSettings !== undefined ? {
              verificationSettingsFile: verificationSettings.file,
              workerVerification: options.workerVerification,
              onVerificationCeased: () => verificationSettings?.dispose(),
            } : {}),
          ...(reviewConfiguration !== undefined ? { reviewAuthEnv: claudeReviewProcessEnv(reviewConfiguration) } : {}),
          fileTools,
          nativeTools,
          ambientMcp,
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
          reviewSettings?.dispose();
          // The private verification files are NOT deleted here: they survive
          // while an original owned child has no proven close (the handle
          // invokes onVerificationCeased on actual/late close).
        },
        (error) => this.onInfraError(error),
        this.heartbeatMs(),
        ...(options.agentId !== undefined ? [options.agentId] : []),
      );
      this.handles.add(handle);
      this.down = undefined;
      return handle;
    } catch (error) {
      if (lockAcquired && resumeFile !== undefined && !this.activeFiles.has(resumeFile)) {
        this.store.releaseLock(resumeFile);
      }
      await reviewBridge?.close();
      reviewSettings?.dispose();
      verificationSettings?.dispose();
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
    // Contain every handle: one failing child must not abandon the remaining
    // handles' child kills and lock releases (issue #341).
    await disposeAll([...this.handles]);
  }
}

interface HandleParams {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly cwd: string;
  readonly binary: string;
  /** Owned subprocess seam (fixture); production uses Node's spawn unchanged. */
  readonly spawnProcess?: typeof spawn;
  readonly tools: readonly string[];
  readonly systemPrompt: string;
  readonly isolatedReview?: boolean;
  readonly reviewSettingsFile?: string;
  /** Private worker-verification native ask routing + explanation (issue #315). */
  readonly verificationSettingsFile?: string;
  readonly workerVerification?: WorkerVerificationPolicy;
  /** Invoked once when every original policy child has actually closed. */
  readonly onVerificationCeased?: () => void;
  readonly reviewAuthEnv?: NodeJS.ProcessEnv;
  readonly fileTools?: readonly string[];
  readonly nativeTools?: readonly string[];
  /** Raw perkins_* names wired through the bridge (capability declaration). */
  readonly reviewTools?: readonly string[];
  readonly mcpConfigFile?: string;
  /** MCP servers an ordinary (non-review) session loads; absent = none.
   * Review sessions always run strict with only their scoped bridge. A
   * project entry carries the checked-in file resolved for THIS turn (no
   * file = nothing loadable this turn: strict, no --mcp-config). */
  readonly ambientMcp?: { readonly mode: 'none' } | { readonly mode: 'user' } | { readonly mode: 'project'; readonly file?: string };
  readonly reviewBridge?: ReviewMcpBridge;
  readonly killGraceMs: number;
  readonly resume: boolean;
  readonly model?: string;
  readonly thinkingLevel?: string;
  /** Issue #283: the bound GC-managed BMAD runtime, loaded as a plugin dir. */
  readonly managedPluginDir?: string;
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
    args.push(...claudeReviewIsolationArgs(params.reviewSettingsFile));
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
  if (!params.isolatedReview) {
    const mcp = params.ambientMcp ?? { mode: 'none' };
    if (mcp.mode !== 'user') args.push('--strict-mcp-config');
    if (mcp.mode === 'project' && mcp.file !== undefined) args.push('--mcp-config', mcp.file);
  }
  if (params.verificationSettingsFile !== undefined && !params.isolatedReview) {
    // Native ask reaches the original-child-bound host, even in bypass mode.
    args.push('--settings', params.verificationSettingsFile, '--permission-prompt-tool', 'stdio');
  }
  if (params.managedPluginDir !== undefined && !params.isolatedReview) {
    args.push('--plugin-dir', params.managedPluginDir);
  }
  if (params.model !== undefined) args.push('--model', params.model);
  if (params.thinkingLevel !== undefined) args.push('--effort', params.thinkingLevel);
  return args;
}

/**
 * The in-band error for a turn whose result reports `is_error`. When the CLI
 * attached a provider failure (synthetic API-error message / result
 * `api_error_status`), the event carries typed provider-response provenance
 * plus the provider/model identity — so a Claude usage limit reaches the
 * same quota-wall stop, bounded rate-limit retry and provider-recovery wait
 * as a pi lane, instead of an unclassified error that strands the lane. The
 * `(HTTP <status>, <code>)` suffix renders those typed facts in the shape the
 * deterministic classifiers read (the role pi-ai's `429: {…}` lines play).
 */
export function claudeInBandError(
  result: ResultInfo,
  apiError: ApiErrorInfo | null,
  model: string | null,
): Extract<RuntimeEvent, { type: 'error' }> {
  const text = result.text ?? apiError?.text ?? `turn ended with result subtype "${result.subtype}"`;
  const status = apiError?.status ?? result.apiErrorStatus;
  const code = apiError?.code ?? null;
  // A provider failure is typed whenever the CLI attached either fact — a
  // code without an HTTP status still names the provider's failure class.
  if (status === null && code === null) return { type: 'error', error: text, fatal: false };
  const facts = [status !== null ? `HTTP ${status}` : null, code].filter((fact): fact is string => fact !== null);
  return {
    type: 'error',
    error: `${text} (${facts.join(', ')})`,
    fatal: false,
    ...(model !== null && model !== '' ? { provider: CLAUDE_NATIVE_PROVIDER, model } : {}),
    typed: { origin: 'provider-message', ...(status !== null ? { status } : {}), ...(code !== null ? { bodyCode: code } : {}) },
  };
}

/** The first stderr line (or the spawn/timeout failure) of a failed git run. */
function gitFailure(error: unknown): string {
  const failure = error as { readonly stderr?: Buffer | string; readonly signal?: string | null; readonly message?: string };
  const stderr = failure.stderr === undefined ? '' : String(failure.stderr).trim().split('\n')[0] ?? '';
  if (stderr !== '') return stderr;
  if (failure.signal !== undefined && failure.signal !== null) return `git killed by ${failure.signal}`;
  return failure.message ?? String(error);
}

/**
 * `mcp = "project"` loads the cwd's checked-in servers: the `.mcp.json` blob
 * committed at HEAD, and only while the working file is a regular file
 * (never a symlink) byte-identical to it. An untracked, staged-only, edited
 * or symlinked file never loads, and the CLI reads a private copy of the
 * verified bytes — never the lane path, which a later write could swap.
 *
 * Trust boundary: HEAD is lane state, and a session with a shell can commit
 * its own `.mcp.json` (every git ref is writable from a worktree, so no ref
 * is safe from it). That grants such a session nothing it lacks — a project
 * server is a command it could already run — which is why only roles whose
 * own tools include a shell load project servers at all: a read-only role
 * never runs a command another session committed.
 */
export async function checkedInProjectMcpConfig(cwd: string): Promise<{ readonly config: Buffer } | { readonly reason: string }> {
  const file = join(cwd, '.mcp.json');
  try {
    if (!(await lstat(file)).isFile()) return { reason: '.mcp.json is not a regular file (symlink or other)' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { reason: 'no .mcp.json in the session cwd' };
    return { reason: `.mcp.json cannot be inspected: ${String(error)}` };
  }
  const git = async (args: readonly string[]): Promise<Buffer> =>
    (await execFileAsync('git', [...args], { cwd, encoding: 'buffer', timeout: 10_000, maxBuffer: 1 << 20, windowsHide: true })).stdout;
  let entry: string;
  try {
    entry = (await git(['ls-tree', '-z', 'HEAD', '--', '.mcp.json'])).toString('utf8');
  } catch (error) {
    return { reason: `git cannot read HEAD in the session cwd: ${gitFailure(error)}` };
  }
  if (entry === '') return { reason: '.mcp.json is not committed at HEAD' };
  // "<mode> <type> <object>\t<path>\0" — a committed symlink (120000), tree
  // or submodule is never a server list.
  const committedEntry = /^(100644|100755) blob ([0-9a-f]+)\t/u.exec(entry);
  if (committedEntry === null) return { reason: 'the committed .mcp.json is not a regular file' };
  let committed: Buffer;
  try {
    committed = await git(['cat-file', 'blob', committedEntry[2]!]);
  } catch (error) {
    return { reason: `git cannot read the committed .mcp.json: ${gitFailure(error)}` };
  }
  let working: Buffer;
  try {
    working = await readFile(file);
  } catch (error) {
    return { reason: `.mcp.json cannot be read: ${String(error)}` };
  }
  if (!working.equals(committed)) return { reason: '.mcp.json differs from its committed version' };
  return { config: committed };
}

/** The private copy of the verified project servers handed to --mcp-config:
 * beside the session's own transcript (GC-owned; the store lists only
 * `.jsonl`), owner-only, rewritten every turn and removed at disposal. */
export function projectMcpCopyPath(sessionFile: string): string {
  return `${sessionFile}.project-mcp.json`;
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
  /** Per-disposal-generation cessation evidence (identity: the ORIGINAL
 * live child captured when disposal began). */
  private cessationKind: 'live' | 'no-child' | 'close-observed' | 'error' | 'deadline' | 'close-observed-late' = 'live';
  private bridgeCloseSettled = false;
  private bridgeCloseFailed = false;
  /** Last verdict emitted as a cessation_evidence event (null = none yet). */
  private evidenceEmitted: 'ceased' | 'unknown' | null = null;
  private readonly verificationChildren = new Set<ChildProcess>();
  private readonly closedVerificationChildren = new WeakSet<ChildProcess>();
  private verificationCleaned = false;
  private disposalPromise: Promise<void> | null = null;
  /** Last logged reason project MCP loaded nothing (logged once per change). */
  private projectMcpNote: string | null = null;
  /** A turn is resolving its params (the project-MCP git check): the
   * operation slot is held exactly as by a live child. */
  private preparingTurn = false;

  constructor(
    role: Role,
    params: HandleParams,
    capabilities: AgentCapabilities,
    store: SessionStore,
    log: Log = () => {},
    onDispose: () => void = () => {},
    onInfraError: (error: unknown) => void = () => {},
    toolHeartbeatMs = 60_000,
    /** Product-owned identity (issue #161): the ledger identity, bound
     * before the session for a tracked child. */
    agentId?: string,
  ) {
    this.role = role;
    this.params = params;
    this.capabilities = capabilities;
    this.id = agentId ?? params.sessionId;
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

  inspectDirective = (_identity: DirectiveTurnIdentity): DirectiveCheckpoint => ({ state: 'unknown', reason: 'claude-code CLI exposes no exact request acceptance/safe checkpoint continuation proof' });

  async resumeDirective(): Promise<never> {
    throw new DirectiveCheckpointError('claude-code cannot safely continue an interrupted directive without replay — Gru recovery decision required');
  }

  async prompt(text: string, options: PromptOptions = {}): Promise<void> {
    this.assertLive();
    if (options.directive !== undefined) {
      throw new DirectiveCheckpointError('claude-code cannot attest actual request admission; directive checkpoint capability unavailable');
    }
    if (text === '' && (options.images === undefined || options.images.length === 0)) {
      throw new Error('empty prompt: nothing to send (no text, no images)');
    }
    if (this.live !== null || this.preparingTurn || this.compacting) {
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
    !this.disposed && this.sessionEstablished && this.live === null && !this.preparingTurn && !this.compacting;

  isCompacting = (): boolean => this.compacting;

  /** Claude's print transport exposes no trustworthy whole-context usage.
   * Deliberately omit getContextUsage rather than deriving a percentage from
   * per-turn token counts or transcript bytes. */

  compact = async (): Promise<void> => {
    this.assertLive();
    if (!this.sessionEstablished) {
      throw new Error('claude-code session is not established; nothing can be compacted');
    }
    if (this.live !== null || this.preparingTurn || this.compacting) {
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
    if (live !== null) this.trackVerificationChild(live);
    const originals = [...this.verificationChildren];
    // New policy custody reuses the existing grace/escalation strategy for
    // EVERY unresolved original, even while another child occupies live.
    for (const child of originals) {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    }
    if (originals.length > 0) {
      const escalation = setTimeout(() => {
        for (const child of originals) {
          if (!this.verificationChildren.has(child)) continue;
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
      }, this.params.killGraceMs);
      escalation.unref();
    }
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let exitDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
    if (live !== null) {
      this.trackVerificationChild(live);
      this.cessationKind = 'live'; // identity: THIS original child
      // Distinguish observed close from ChildProcess error and from the
      // deadline; keep a LATE latch on the ORIGINAL child so a real close
      // after deadline settlement still upgrades the evidence later.
      let exitKind: 'close-observed' | 'error' | null =
        live.exitCode !== null || live.signalCode !== null || this.closedVerificationChildren.has(live) ? 'close-observed' : null;
      const childExited =
        exitKind !== null
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              live.once('close', () => { exitKind = exitKind ?? 'close-observed'; resolve(); });
              live.once('error', () => { exitKind = exitKind ?? 'error'; resolve(); });
            });
      // Late-observation latch: survives the race; fires even after the
      // deadline already settled bookkeeping (no new kill policy/timer).
      live.once('close', () => {
        if (this.cessationKind === 'deadline') {
          this.cessationKind = 'close-observed-late';
          this.emitEvidence();
        }
      });
      // SIGTERM is the documented abort (the CLI exits 143); escalate to
      // SIGKILL if the process ignores it. A second bounded grace after the
      // forced kill prevents a broken ChildProcess implementation from
      // retaining the transcript and session lock forever.
      try {
        if (!originals.includes(live) && !this.closedVerificationChildren.has(live)) live.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      killTimer = setTimeout(() => {
        if (this.live !== null && !originals.includes(this.live) && !this.closedVerificationChildren.has(this.live)) {
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
      await Promise.race([childExited, exitDeadline]).then(() => {
        if (exitKind === 'close-observed') this.cessationKind = 'close-observed';
        else if (exitKind === 'error') this.cessationKind = 'error';
        else this.cessationKind = 'deadline';
      });
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
    } else {
      // A policy-bearing original can remain unclosed after error settlement
      // cleared the live turn slot: it is still owned, not a never-started child.
      this.cessationKind = this.verificationChildren.size === 0 ? 'no-child' : 'live';

    }
    try {
      this.store.releaseLock(this.sessionFile);
    } finally {
      try {
        const closing = this.params.reviewBridge?.close();
        if (closing === undefined) { this.bridgeCloseSettled = true; }
        else await closing.then(
          () => { this.bridgeCloseSettled = true; },
          () => { this.bridgeCloseSettled = true; this.bridgeCloseFailed = true; },
        );
      } finally {
        this.setState('disposed');
        this.onDispose();
        this.cleanupVerificationSettings();
        this.cleanupProjectMcpCopy();
        this.emitEvidence();
      }
    }
  }

  /** Verification files belong to every original CLI child until its actual
   * close, even if error/deadline settlement has cleared the live slot. */
  private trackVerificationChild(child: ChildProcess): void {
    if (this.params.onVerificationCeased === undefined || this.verificationChildren.has(child) || this.closedVerificationChildren.has(child)) return;
    this.verificationChildren.add(child);
    child.once('close', () => {
      this.closedVerificationChildren.add(child);
      this.verificationChildren.delete(child);
      if (this.disposed && this.verificationChildren.size === 0 && this.cessationKind !== 'close-observed') {
        this.cessationKind = 'close-observed-late';
      }
      this.cleanupVerificationSettings();
      if (this.disposed) this.emitEvidence();
    });
  }

  /** The private project-servers copy lives only as long as the session. */
  private cleanupProjectMcpCopy(): void {
    if (this.params.ambientMcp?.mode !== 'project') return;
    const copy = projectMcpCopyPath(this.params.sessionFile);
    void rm(copy, { force: true }).catch((error: unknown) => {
      this.log('warn', 'project MCP copy cleanup failed', { file: copy, error: String(error) });
    });
  }

  private cleanupVerificationSettings(): void {
    if (!this.disposed || this.verificationChildren.size !== 0 || this.verificationCleaned) return;
    this.verificationCleaned = true;
    this.params.onVerificationCeased?.();
  }

  /** Once-only evidence transition; identity-bound to the original child
   * of THIS disposal generation. Child exit alone is not cessation: the
   * scoped review bridge must have settled too; a failed bridge close
   * reports UNKNOWN without upgrading native state. */
  private emitEvidence(): void {
    const evidence = this.cessationEvidence();
    // Emit each verdict transition once: an 'unknown' emitted at disposal must
    // NOT suppress the later positive (a late identity-bound close), or event
    // consumers (registry ownership reconciliation) never learn of it.
    if (this.evidenceEmitted === evidence) return;
    this.evidenceEmitted = evidence;
    this.emit({ type: 'cessation_evidence', evidence });
  }

  cessationEvidence(): 'ceased' | 'unknown' {
    if (this.disposed !== true) return 'unknown';
    if (this.bridgeCloseSettled !== true || this.bridgeCloseFailed) return 'unknown';
    // Policy-bearing custody remains unclosed even after error settlement has
    // cleared the live turn slot. Non-policy evidence semantics are unchanged.
    if (this.verificationChildren.size !== 0) return 'unknown';
    if (this.cessationKind === 'close-observed' || this.cessationKind === 'close-observed-late' || this.cessationKind === 'no-child') {
      return 'ceased';
    }
    return 'unknown'; // 'live' mid-disposal, 'error', or 'deadline' without a late close
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

  /** `mcp = "project"` servers for this operation: re-resolved every turn
   * and compaction (each is a fresh CLI process, and the lane's file may
   * have changed since). Every other session spawns synchronously from its
   * fixed params and never comes here. */
  private async projectTurnParams(): Promise<HandleParams> {
    const resolved = await checkedInProjectMcpConfig(this.params.cwd);
    const copy = projectMcpCopyPath(this.params.sessionFile);
    if ('reason' in resolved) {
      await rm(copy, { force: true });
      if (this.projectMcpNote !== resolved.reason) {
        this.projectMcpNote = resolved.reason;
        this.log('info', 'mcp = "project": no project MCP servers loaded', { cwd: this.params.cwd, reason: resolved.reason });
      }
      return { ...this.params, ambientMcp: { mode: 'project' } };
    }
    await writeFile(copy, resolved.config, { mode: 0o600 });
    this.projectMcpNote = null;
    return { ...this.params, ambientMcp: { mode: 'project', file: copy } };
  }

  /** Run one CLI process with this operation's params. A project-mode check
   * runs off the event loop while the session's one operation slot stays
   * held; the slot is released, and disposal re-checked, in the same step
   * that spawns — never a window for a second operation or a post-disposal
   * child. A failed check fails the operation loudly. */
  private withTurnParams(
    spawnWith: (params: HandleParams) => Promise<void>,
    onPrepareFailure?: (detail: string) => void,
  ): Promise<void> {
    if (this.params.ambientMcp?.mode !== 'project') return spawnWith(this.params);
    this.preparingTurn = true;
    return this.projectTurnParams().then(
      (params) => {
        this.preparingTurn = false;
        if (this.disposed) {
          // Disposal's own cleanup may have run before this check wrote.
          this.cleanupProjectMcpCopy();
          throw new Error('agent session disposed');
        }
        return spawnWith(params);
      },
      (error: unknown) => {
        this.preparingTurn = false;
        if (this.disposed) throw new Error('agent session disposed');
        const detail = `claude turn could not be prepared: ${error instanceof Error ? error.message : String(error)}`;
        onPrepareFailure?.(detail);
        throw new Error(detail);
      },
    );
  }

  /** A dedicated, resumed native slash-command process. Its machine frames
   * remain in the native transcript for forensics, but content events are
   * intentionally discarded so `/compact` output can never become chat text. */
  private runCompactionControl(): Promise<void> {
    return this.withTurnParams((params) => this.spawnCompaction(params));
  }

  private spawnCompaction(params: HandleParams): Promise<void> {
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

      let permissions: ClaudeVerificationPermissionChannel | undefined;
      const handleFrame = (frame: StreamFrame): void => {
        permissions?.ingest(frame);
        if (permissions !== undefined && frame['type'] === 'result') child?.stdin?.end();
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
        onGarbage: (line) => {
          if (permissions !== undefined) { fail('malformed worker verification permission transport'); child?.stdin?.end(); }
          this.log('warn', 'skipping non-JSON line on claude compaction stdout', { line: line.slice(0, 200) });
        },
      });

      try {
        // Compaction is meaningful only for an established conversation, so
        // this path ALWAYS resumes; it never mints or forks a session.
        child = (params.spawnProcess ?? spawn)(params.binary, claudeTurnArgs(params, true), {
          cwd: params.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          ...(params.reviewAuthEnv !== undefined ? { env: params.reviewAuthEnv } : {}),
        });
      } catch (error) {
        this.onInfraError(error);
        transcript.end(() =>
          settle(new Error(`claude compaction process failed to spawn: ${String(error)}`)),
        );
        return;
      }
      this.trackVerificationChild(child);
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

      const send = (): void => {
        child?.stdin?.write(`${JSON.stringify(claudePromptFrame('/compact'))}\n`, (error) => {
          if (error != null) fail(`failed to write claude compaction command: ${String(error)}`);
          if (permissions === undefined) child?.stdin?.end();
        });
      };
      if (params.workerVerification !== undefined && !params.isolatedReview) {
        permissions = new ClaudeVerificationPermissionChannel(child, params.workerVerification, (message) => {
          fail(message); child?.stdin?.end();
        }, () => undefined);
        // Private ask policy and original-child binding already exist. The
        // qualified native iterator accepts initialize then user on one input
        // stream; acknowledgement gates Bash authority, not prompt delivery.
        permissions.start();
        if (!failed) send();
      } else send();
    });
  }

  private runTurn(text: string, owner: string | null, images?: PromptOptions['images']): Promise<void> {
    this.setState('spawning');
    return this.withTurnParams((params) => this.spawnTurn(params, text, owner, images), (detail) => {
      if (!this.disposed) {
        this.emit({ type: 'error', error: detail, fatal: false });
        this.setState('error', detail);
      }
    });
  }

  private spawnTurn(params: HandleParams, text: string, owner: string | null, images?: PromptOptions['images']): Promise<void> {
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

      let permissions: ClaudeVerificationPermissionChannel | undefined;
      const handleFrame = (frame: StreamFrame): void => {
        permissions?.ingest(frame);
        if (permissions !== undefined && frame['type'] === 'result') child?.stdin?.end();
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
          // Record what this turn was asked right after its verified identity
          // frame: stdout carries only claude's side of the conversation. Not
          // the CLI's --replay-user-messages: it also echoes the permission
          // control_responses the worker-verification channel writes, which
          // that channel rightly fails closed on as foreign frames.
          transcript.write(`${JSON.stringify({
            ...claudePromptFrame(text, images),
            session_id: params.sessionId,
            timestamp: new Date().toISOString(),
            gc_prompt: true,
          })}\n`);
          this.setState('streaming');
          this.emit({ type: 'turn_start' });
          this.sessionEstablished = true;
        }
      };

      const parser = new NdjsonParser({
        onFrame: handleFrame,
        onGarbage: (line) => {
          if (permissions !== undefined) { failTurn('malformed worker verification permission transport'); child?.stdin?.end(); }
          this.log('warn', 'skipping non-JSON line on claude stdout', { line: line.slice(0, 200) });
        },
      });

      try {
        child = (params.spawnProcess ?? spawn)(params.binary, claudeTurnArgs(params, this.sessionEstablished), {
          cwd: params.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          ...(params.reviewAuthEnv !== undefined ? { env: params.reviewAuthEnv } : {}),
        });
      } catch (error) {
        // Synchronous spawn faults (async ENOENT arrives via 'error').
        this.onInfraError(error);
        failTurn(`claude process failed to spawn: ${String(error)}`);
        transcript.end(() => settle(new Error(failure)));
        return;
      }
      this.trackVerificationChild(child);
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
              const event = claudeInBandError(result, translator.apiError, translator.init?.model ?? params.model ?? null);
              this.emit(event);
              this.setState('error', event.error);
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

      // Policy children keep stdin open for native permission responses; other
      // turns retain the existing single-frame/EOF transport.
      const send = (): void => {
        const frame = `${JSON.stringify(claudePromptFrame(text, images))}\n`;
        child.stdin?.write(frame, (error?: Error | null) => {
          if (error != null) this.log('error', 'failed to write prompt frame to claude stdin', { error: String(error) });
          if (permissions === undefined) child.stdin?.end();
        });
      };
      if (params.workerVerification !== undefined && !params.isolatedReview) {
        permissions = new ClaudeVerificationPermissionChannel(child, params.workerVerification, (message) => {
          failTurn(message); child.stdin?.end();
        }, () => undefined);
        // Pipeline only after the child-bound permission channel is installed.
        // Never add an initialization clock or approve Bash before its reply.
        permissions.start();
        if (!failed) send();
      } else send();
    });
  }
}
