import { execFile, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  createWriteStream,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { WriteStream } from 'node:fs';
import { lstat, open, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { finished } from 'node:stream/promises';
import type { GruCommandConfig, Role } from '../config.js';
import { repositoryGitEnv } from '../git-env.js';
import { CLAUDE_CODE_THINKING_LEVELS as CLAUDE_EFFORT_LEVELS, DEFAULT_CLAUDE_BACKGROUND_WAIT_MS, DEFAULT_CLAUDE_MCP_MODE, resolveSpawnPolicy } from '../config.js';
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
  CLAUDE_NO_CONTENT,
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
  ContextUsage,
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
import {
  assertClaudeDirectiveToolIntent,
  DirectiveCheckpointError,
  inspectDirectiveAdmission,
  inspectDirectiveCheckpoint,
  isClaudeTaskNotification,
  isNativeDirectiveRefusal,
  DirectiveBookkeepingError,
  ownIoRefusal,
  thrownDetail,
  thrownText,
  withOwnIo,
  prepareClaudeDirectiveBinding,
  prepareDirectiveProducer as prepareNativeDirectiveProducer,
  readDirectiveBinding,
  recordDirectiveAuthorityRefusal,
  recordDirectiveCompletion,
  recordDirectiveIndependentController,
  recordDirectiveProducerCessation,
  recordDirectiveToolRefusal,
  type DirectiveCheckpoint,
  type DirectiveNativeBinding,
  type DirectiveProducer,
  type DirectiveTurnIdentity,
  claudeAnswerFrame,
} from './directive-checkpoint.js';
import { ClaudeDirectivePermissionChannel, privateClaudeDirectiveSettings, type ClaudeToolDecision, type ClaudeToolRequest } from './claude-directive.js';
import { resolveGitCommit } from '../dispatch/perkins-review/artifacts.js';
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
/** Grace before SIGKILL for a CLI stopped while it only waits on background
 * tasks: on SIGTERM it stops them itself (probed on Claude Code 2.1.307), but
 * a SIGKILL would leave them running. */
const DEFAULT_BACKGROUND_STOP_GRACE_MS = 10_000;
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
  /** Test seam: grace before SIGKILL for a CLI stopped while it only waits
   * on background tasks. Default 10 000ms. */
  readonly backgroundStopGraceMs?: number;
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
 *           [--strict-mcp-config [--mcp-config <session>.jsonl.<handle>.project-mcp.json]]
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
  private readonly backgroundStopGraceMs: number;
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
    this.backgroundStopGraceMs = opts.backgroundStopGraceMs ?? DEFAULT_BACKGROUND_STOP_GRACE_MS;
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
      /** GC's header on a resumed transcript (#424), read from its bounded head. */
      let resumedHeader: { readonly id: string; readonly cwd: string | null } | null = null;
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
        resumedHeader = claudeHeaderOf(head);
        if (extracted !== null) {
          sessionId = extracted;
          established = true;
        } else if (resumedHeader !== null) {
          // Only GC's header so far: the CLI never registered the session.
          sessionId = resumedHeader.id;
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
        // A GC session header (#424): the exact session id and cwd a
        // directive's admission and lane checks bind (pi's header shape).
        writeFileSync(sessionFile, claudeSessionHeader(sessionId, cwd), { encoding: 'utf-8', flag: 'wx' });
        createdNewFile = sessionFile;
        if (!this.store.isHeld(sessionFile)) {
          this.store.acquireLock(sessionFile);
        }
      }
      this.activeFiles.add(sessionFile);
      // Directive admission (#424) needs the GC session header (written above
      // for a fresh session; read from the bounded head on resume) and a tool
      // set the host can fence: ambient MCP tools would bypass the ask.
      const nativeDirectives = reviewMode === undefined && ambientMcp.mode === 'none' &&
        (resumeFile === undefined || (resumedHeader !== null && resumedHeader.id === sessionId && resumedHeader.cwd === cwd));
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
          backgroundWaitMs: this.config.runtimes.policies['claude-code']?.backgroundWaitMs ?? DEFAULT_CLAUDE_BACKGROUND_WAIT_MS,
          backgroundStopGraceMs: this.backgroundStopGraceMs,
          resume: established,
          nativeDirectives,
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

/** Flush a transcript's written bytes to disk (any descriptor of the file will do). */
function syncTranscript(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** An ordinary turn's wait on the background tasks its CLI still runs after
 * the reply (see DEFAULT_CLAUDE_BACKGROUND_WAIT_MS). */
interface BackgroundWait {
  /** The prompted turn has replied successfully: its prompt is answered. An
   * in-band error result is no answer (the rate-limit retry re-sends it). */
  answered(): boolean;
  /** Replied, and not paused by a follow-up turn of the CLI's own (see
   * `paused` in spawnTurn), until the turn settles: the watchdog counts this,
   * a stop's grace included, as live work. */
  waiting(): boolean;
  /** A message is waiting: stop now if waiting, else skip the next wait. */
  end(): Promise<void>;
}

/** Why GC stopped background work: the idle limit, a waiting message, or a
 * turn that ended in an error (its follow-up would only meet that error). */
type BackgroundStopReason = 'limit' | 'message' | 'error';

/** The longest task description a notice or the board repeats. */
const BACKGROUND_TASK_TEXT_MAX = 200;
/** How a listed task with no description is named. */
const UNNAMED_BACKGROUND_TASK = 'an unnamed background task';

/** Running background tasks as a `background_tasks_changed` frame lists them
 * (Claude Code 2.1.307): `tasks: [{ task_id, description, … }]`, one entry
 * per task. Null when the frame has no such list. */
function backgroundTaskDescriptions(tasks: unknown): string[] | null {
  if (!Array.isArray(tasks)) return null;
  return tasks.map((task): string => {
    const description = (task as Record<string, unknown> | null)?.['description'];
    const line = typeof description === 'string' ? description.replace(/\s+/gu, ' ').trim() : '';
    if (line === '') return UNNAMED_BACKGROUND_TASK;
    return line.length > BACKGROUND_TASK_TEXT_MAX ? `${line.slice(0, BACKGROUND_TASK_TEXT_MAX - 1)}…` : line;
  });
}

/** A wait limit as the minion reads it. */
function waitText(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1_000))} s`;
}

/** What the minion is told at the start of its next ordinary turn. It may
 * come turns later (a directive's text is never changed), so it says
 * "earlier". `forced`: the CLI ignored the stop and was killed, so the work
 * may still be running. */
export function backgroundStopNotice(tasks: readonly string[], reason: BackgroundStopReason, waitMs: number, forced = false): string {
  const limit = waitText(waitMs);
  const list = tasks.map((task) => `\`${task.replaceAll('`', "'")}\``).join(', ');
  const why = reason === 'limit' ? `It was still running ${limit} after that reply.`
    : reason === 'message' ? 'A new message had arrived for you.' : 'That turn had ended in an error.';
  const what = forced
    ? `Earlier, after one of your replies, Gru Command had to force-stop the Claude Code process running background work you had left running: ${list}. ${why} ` +
      'That work may still be running: check before you start it again.'
    : `Earlier, after one of your replies, Gru Command stopped background work you had left running: ${list}. ${why}`;
  return `[Gru Command] ${what} Each of your turns runs in its own Claude Code process, so work still running after ` +
    `you reply is stopped ${limit} later, or as soon as a new message arrives; a server or a watcher cannot outlive ` +
    'your turn. If you need a result, run the command again and wait for it before you reply.';
}

/** A tool fence's refusal after the turn already failed: the earlier failure
 * reports itself; this names no wall word (#485). */
const EARLIER_DIRECTIVE_FAILURE = 'an earlier directive failure refused this turn\'s tool effects';

/** A write to a transcript stream an earlier fault destroyed (#485). */
function isDestroyedStreamWrite(fault: unknown): boolean {
  return typeof fault === 'object' && fault !== null && (fault as NodeJS.ErrnoException).code === 'ERR_STREAM_DESTROYED';
}

/** One directive turn in flight (#424). */
interface DirectiveTurn {
  readonly directive: NonNullable<PromptOptions['directive']>;
  readonly producer: DirectiveProducer;
  readonly content: readonly StreamFrame[];
  readonly settings: { readonly file: string; dispose(): void };
  /** Settles once the CLI's echo was read back and published (or refused). */
  admission: Promise<void> | null;
  admitted: DirectiveNativeBinding | null;
  /** The turn's first failure, boxed: a thrown null or undefined still fails
   * it, so every later fence refuses (#485). GC's own later failures (a lost
   * write, a second prompt, the channel's deny) report it, not themselves; a
   * failure of the CLI process, or of the permission channel's transport or
   * protocol, reports itself, untagged. Its guard receipt stays durable. */
  failure: { readonly error: unknown } | null;
  completion: Promise<void> | null;
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
  /** How long an ordinary turn that has replied waits on its CLI's
   * background tasks ([runtimes.claude-code] background_wait_ms). */
  readonly backgroundWaitMs?: number;
  readonly backgroundStopGraceMs?: number;
  readonly resume: boolean;
  /** The session can host native directives (#424): GC header, no ambient MCP. */
  readonly nativeDirectives?: boolean;
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
  // Shared by the ordinary and the refused path, so both say the same (#485).
  const said = (text: string | null | undefined): string | null => text == null || text.trim() === '' || text.trim() === CLAUDE_NO_CONTENT ? null : text;
  const text = said(result.text) ?? said(apiError?.text) ??
    (apiError !== null || result.apiErrorStatus !== null ? 'the CLI reported an API error' : `turn ended with result subtype "${result.subtype}"`);
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
export function gitFailure(error: unknown): string {
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
export async function checkedInProjectMcpConfig(
  cwd: string,
): Promise<{ readonly config: Buffer } | { readonly reason: string; readonly infrastructure?: true }> {
  const file = join(cwd, '.mcp.json');
  try {
    if (!(await lstat(file)).isFile()) return { reason: '.mcp.json is not a regular file (symlink or other)' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { reason: 'no .mcp.json in the session cwd' };
    return { reason: `.mcp.json cannot be inspected: ${String(error)}`, infrastructure: true };
  }
  // Routing variables inherited by the service never redirect the check to
  // another repository: HEAD is the session cwd's own.
  const git = async (args: readonly string[]): Promise<Buffer> =>
    (await execFileAsync('git', [...args], {
      cwd, env: repositoryGitEnv(true), encoding: 'buffer', timeout: 10_000, maxBuffer: 1 << 20, windowsHide: true,
    })).stdout;
  let entry: string;
  try {
    entry = (await git(['ls-tree', '-z', 'HEAD', '--', '.mcp.json'])).toString('utf8');
  } catch (error) {
    return { reason: `git cannot read HEAD in the session cwd: ${gitFailure(error)}`, infrastructure: true };
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
    return { reason: `git cannot read the committed .mcp.json: ${gitFailure(error)}`, infrastructure: true };
  }
  // The working file is read through ONE no-follow descriptor, bounded by the
  // largest size a line-ending conversion of the committed bytes could have:
  // a file grown or swapped after the first look is never read past it.
  const committedText = committed.toString('utf8');
  const limit = committed.length + (committedText.split('\n').length - 1) - (committedText.split('\r\n').length - 1);
  let working: Buffer;
  try {
    // O_NONBLOCK: a FIFO swapped in after the first look never blocks the
    // open — the fstat below refuses it (harmless for a regular file).
    const handle = await open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    try {
      if (!(await handle.stat()).isFile()) return { reason: '.mcp.json is not a regular file (symlink or other)' };
      const buffer = Buffer.alloc(limit + 1);
      let length = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length > limit) return { reason: '.mcp.json differs from its committed version' };
      }
      working = buffer.subarray(0, length);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') return { reason: '.mcp.json is not a regular file (symlink or other)' };
    return { reason: `.mcp.json cannot be read: ${String(error)}`, infrastructure: true };
  }
  if (!working.equals(committed)) return differsFromCommitted(working, committed);
  // Only what the CLI treats as FATAL is refused here: unparseable JSON, a
  // non-object, or no `mcpServers` object — it would exit on every turn. A
  // server entry it cannot load is skipped by the CLI itself, never fatal,
  // and logged from the init frame (noteMcpServerProblems).
  const bom = committedText.startsWith('\uFEFF') ? 1 : 0;
  let parsed: unknown;
  try {
    // One leading BOM is stripped, exactly as the CLI reads the file.
    parsed = JSON.parse(committedText.slice(bom));
  } catch (error) {
    // Never the parser's message: V8 quotes source text, and .mcp.json files
    // carry tokens. Only the location from V8's own anchored suffix (never
    // digits from its quoted snippet): line and column as an editor shows
    // them (a BOM is invisible there, so stripping it shifts nothing). A
    // message without that suffix (V8 quoted the source instead) gives none.
    const at = / at position \d+ \(line (\d+) column (\d+)\)$/u.exec(error instanceof Error ? error.message : '');
    return { reason: `the committed .mcp.json is not valid JSON${at === null ? '' : ` (at line ${at[1]}, column ${at[2]})`}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { reason: 'the committed .mcp.json is not a JSON object' };
  }
  // The CLI requires an `mcpServers` record and fails every turn without one.
  const servers = (parsed as Record<string, unknown>)['mcpServers'];
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    return { reason: 'the committed .mcp.json has no "mcpServers" object' };
  }
  return { config: committed };
}

/** The refusal for a working file that is not the committed bytes. The
 * comparison is byte-exact (git's eol/smudge conversion is never run — it
 * would execute lane-configured filters), so a line-ending-only difference
 * gets its own reason instead of looking like an edit. */
function differsFromCommitted(working: Buffer, committed: Buffer): { readonly reason: string } {
  // Either direction (LF committed / CRLF checked out, or the reverse),
  // compared as BYTES: invalid UTF-8 never decodes into a false match.
  if (withoutCrBeforeLf(working).equals(withoutCrBeforeLf(committed))) {
    return { reason: '.mcp.json differs from its committed bytes only in line endings (autocrlf/eol conversion); only byte-identical files load' };
  }
  return { reason: '.mcp.json differs from its committed version' };
}

/** The bytes with every CR that precedes an LF removed (CRLF → LF). */
function withoutCrBeforeLf(bytes: Buffer): Buffer {
  const out = Buffer.alloc(bytes.length);
  let length = 0;
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) continue;
    out[length] = bytes[i]!;
    length += 1;
  }
  return out.subarray(0, length);
}

/** Whether a server name the CLI reports may be logged. Names come straight
 * from config — the CLI does not apply its own name rule to config files, so a
 * key can be a credential URL — so only a label is logged: a letter or number
 * of any script, then letters, numbers and combining marks with `_ . -`,
 * parentheses (the CLI's own `claude.ai X (2)`) and spaces, or the CLI's own
 * `plugin:<plugin>:<server>` form, up to 80 characters (code points); never a
 * URL or an address (`/`, `@`, any other `:`), and never a credential-shaped
 * run. */
export function loggableMcpServerName(name: string): boolean {
  // 80 code points are at most 160 UTF-16 units, so a longer name — the CLI
  // echoes a config key of any size — is refused before it is spread.
  if (name.length === 0 || name.length > 160 || [...name].length > 80) return false;
  const label = '[\\p{L}\\p{N}][\\p{L}\\p{M}\\p{N}_. ()-]*';
  if (!new RegExp(`^(?:${label}|plugin:${label}:${label})$`, 'u').test(name)) return false;
  return !credentialShaped(name);
}

/** 24+ ASCII letters and digits in a row, or a UUID — counted with combining
 * marks removed, so marks cannot split a run, and without case folding, so
 * only ASCII letters count. */
function credentialShaped(text: string): boolean {
  return /[A-Za-z0-9]{24}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/u
    .test(text.replace(/\p{M}/gu, ''));
}

/** The private copy of the verified project servers handed to --mcp-config:
 * beside the session's own transcript (GC-owned; the store lists only
 * `.jsonl`), owner-only, rewritten every turn and removed at disposal. Each
 * handle has its own token, so a disposed handle's late check never touches
 * the copy of the handle that resumed the same session. */
export function projectMcpCopyPath(sessionFile: string, handleToken: string): string {
  return `${sessionFile}.${handleToken}.project-mcp.json`;
}

/** One handle's copy token: 8 lowercase hex characters (the single format
 * the sweep recognizes — see isProjectMcpCopyName). */
export function projectMcpCopyToken(): string {
  return randomUUID().slice(0, 8);
}

/** Whether a directory entry is exactly a project-MCP copy of the session
 * whose file is `sessionBase` — never its .lock, never another session. */
export function isProjectMcpCopyName(sessionBase: string, name: string): boolean {
  return name.startsWith(`${sessionBase}.`) && /^[0-9a-f]{8}\.project-mcp\.json$/u.test(name.slice(sessionBase.length + 1));
}

/** The GC session header a claude-code transcript starts with (#424). */
export function claudeSessionHeader(sessionId: string, cwd: string): string {
  return `${JSON.stringify({ type: 'session', version: 1, id: sessionId, timestamp: new Date().toISOString(), cwd, runtime: 'claude-code' })}\n`;
}

/** The session id and cwd of a transcript whose first line is GC's claude-code header. */
function claudeHeaderOf(head: string): { readonly id: string; readonly cwd: string | null } | null {
  const end = head.indexOf('\n');
  if (end < 0) return null;
  try {
    const header = JSON.parse(head.slice(0, end)) as Record<string, unknown>;
    if (header['type'] !== 'session' || header['runtime'] !== 'claude-code' || typeof header['id'] !== 'string' || header['id'] === '') return null;
    return { id: header['id'], cwd: typeof header['cwd'] === 'string' ? header['cwd'] : null };
  } catch {
    return null;
  }
}

/**
 * The opening tags the Claude CLI reserves for its own user frames (#472). Its
 * --replay-user-messages never echoes a user message whose text holds one of
 * the first six, or starts with a teammate message — read from Claude Code
 * 2.1.306's replay filter. A directive quoting one (a re-brief warning against
 * `<task-notification>`) would never be admitted. `<teammate-message ` (a space
 * after the name, as the CLI checks) is matched wherever it stands, through the
 * next `>` on its line unless a `<` comes first. A later CLI that reserves more
 * fails loud at the turn's first answer, never silently.
 */
const CLAUDE_RESERVED_TAG = /<(?:task-notification|tick|bash-stdout|bash-stderr|local-command-stdout|local-command-stderr)>|<teammate-message [^<>\n]*>?/gu;

/** A directive's exact user content (#424): always an array, text only, so
 * the CLI's echo binds it byte for byte. Only the reserved opening tags are
 * written as entities (#472); the CLI echoes those, and the rest of the text
 * reaches the model as written. */
export function claudeDirectiveContent(text: string): readonly StreamFrame[] {
  return [{ type: 'text', text: text.replace(CLAUDE_RESERVED_TAG, (tag) => tag.replaceAll('<', '&lt;').replaceAll('>', '&gt;')) }];
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
  /** The live ordinary turn's background wait (null when no such turn). */
  private backgroundWait: BackgroundWait | null = null;
  /** Background work GC stopped after a reply, told to the minion at the
   * start of its next ordinary turn (null when none). */
  private backgroundNotice: string | null = null;
  /** A message arrived while the next turn was still being prepared. */
  private messageAwaitsTurn = false;
  /** Long-tool heartbeats: an open tool call keeps the event surface alive. */
  private readonly toolHeartbeat: ToolHeartbeat;
  private compacting = false;
  /** The latest turn's provider-reported context usage (#461). Null from the
   * start of a turn or compaction until a turn ends with a measured result. */
  private contextUsage: ContextUsage | null = null;
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
  /** This handle's own project-MCP copy (see projectMcpCopyPath). */
  private readonly projectMcpCopy: string;
  private projectMcpSwept = false;
  /** The last distinct set of MCP load problems logged (see noteMcpServerProblems). */
  private mcpServerProblemsNote: string | null = null;
  /** A turn is resolving its params (the project-MCP git check): the
   * operation slot is held exactly as by a live child. */
  private preparingTurn = false;
  /** Directive producers this handle prepared, by request (#424). */
  private readonly directiveProducers = new Map<string, DirectiveProducer>();
  /** Bookkeeping faults already logged (the fault itself, or its refusal when the
   * fault is no object): each is logged once, first failure or not. */
  private readonly loggedBookkeepingFaults = new WeakSet<object>();
  /** Guard refusals whose receipt could not be written yet (retried at cessation). */
  private readonly pendingGuardRefusals = new Map<string, { readonly producer: DirectiveProducer; readonly toolUseId?: string; readonly reason: string }>();
  /** Every producer's cessation receipt is written (#424). */
  private producersCeased = false;
  /** Native directive capability (#424): absent when the session cannot attest admission. */
  readonly prepareDirectiveProducer?: (identity: DirectiveTurnIdentity) => DirectiveProducer;
  readonly inspectDirective?: (identity: DirectiveTurnIdentity) => DirectiveCheckpoint;

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
    this.projectMcpCopy = projectMcpCopyPath(params.sessionFile, projectMcpCopyToken());
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
    if (params.nativeDirectives === true && params.isolatedReview !== true) {
      this.prepareDirectiveProducer = (identity) => this.prepareProducer(identity);
      this.inspectDirective = (identity) => inspectDirectiveCheckpoint(this.sessionFile, identity);
    }
  }

  /** Everything that decides what a directive turn may do (#424). */
  private directiveAuthorityManifest(): string {
    const p = this.params;
    return createHash('sha256').update(JSON.stringify({
      runtime: 'claude-code', role: this.role, cwd: p.cwd, binary: p.binary, systemPrompt: p.systemPrompt, tools: [...p.tools],
      fileTools: p.fileTools === undefined ? null : [...p.fileTools], model: p.model ?? null, thinkingLevel: p.thinkingLevel ?? null,
      ambientMcp: p.ambientMcp ?? { mode: 'none' }, managedPluginDir: p.managedPluginDir ?? null, workerVerification: p.workerVerification ?? null,
    })).digest('hex');
  }

  private prepareProducer(identity: DirectiveTurnIdentity): DirectiveProducer {
    this.assertLive();
    const prior = this.directiveProducers.get(identity.requestId);
    if (prior !== undefined) return prior;
    if (this.live !== null || this.preparingTurn || this.compacting) {
      throw new DirectiveCheckpointError('native producer preparation requires a genuinely idle claude-code session');
    }
    const producer = prepareNativeDirectiveProducer({ identity, agentId: this.id, sessionId: this.params.sessionId, sessionFile: this.sessionFile,
      ...(this.store.isHeld(this.sessionFile) ? { lockOwner: this.store.ownedLockIdentity(this.sessionFile) } : {}) });
    this.directiveProducers.set(identity.requestId, producer);
    return producer;
  }

  /** A refused tool or authority boundary: durable receipt (or retried at cessation). */
  private recordGuardRefusal(producer: DirectiveProducer, toolUseId: string | undefined, reason: string): void {
    try {
      if (toolUseId === undefined) recordDirectiveAuthorityRefusal(producer, reason);
      else recordDirectiveToolRefusal(producer, toolUseId, reason);
    } catch (error) {
      this.pendingGuardRefusals.set(`${producer.incarnation}:${toolUseId ?? 'authority'}`, { producer, ...(toolUseId === undefined ? {} : { toolUseId }), reason });
      this.log('error', 'directive guard refusal receipt failed; retried at cessation', { error: thrownText(error, 'string') });
    }
  }

  /**
   * Live-process probe (E7): the CLI child hosting the turn is running
   * and at least one tool call is still open — activity, not a hang.
   */
  hasLiveProcess = (): boolean =>
    !this.disposed && this.live !== null && (this.toolHeartbeat.openCalls > 0 || this.backgroundWait?.waiting() === true);

  /** The live turn's prompt — snapshotted by supervision before a restart.
   * Once the minion has replied it is answered: a restart must not send it
   * again. */
  pendingTurn = (): PendingTurn | null => (this.backgroundWait?.answered() === true ? null : this.livePrompt);

  endBackgroundWait = (): Promise<void> => {
    if (this.backgroundWait !== null) return this.backgroundWait.end();
    // A turn still being prepared (the project-MCP check) has no wait yet:
    // it skips the wait when it replies.
    if (this.preparingTurn) this.messageAwaitsTurn = true;
    return Promise.resolve();
  };

  turnAnswered = (): boolean => this.backgroundWait?.answered() === true;

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

  /** Owner ruling 2026-10-16 (#424): a Claude directive is never resumed or
   * replayed; an interrupted one is Gru's recovery decision. */
  async resumeDirective(): Promise<never> {
    throw new DirectiveCheckpointError('claude-code never continues an interrupted directive (no native resume; no replay) — Gru recovery decision required');
  }

  async prompt(text: string, options: PromptOptions = {}): Promise<void> {
    this.assertLive();
    if (options.directive !== undefined) {
      if (this.prepareDirectiveProducer === undefined) {
        throw new DirectiveCheckpointError('this claude-code session cannot attest directive admission (no GC session header, or ambient MCP tools the host cannot fence)');
      }
      if (options.images !== undefined && options.images.length > 0) throw new DirectiveCheckpointError('a claude-code directive carries text only');
      if (text === '') throw new DirectiveCheckpointError('a claude-code directive needs text');
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
    return this.runTurn(text, options.owner ?? null, options.images, options.directive);
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

  /** Measured live from the latest turn's stream-json (#461): the last
   * main-thread API call's usage over the result's window for its model. Never
   * seeded from transcripts, so a fresh or resumed handle reports null until
   * its first measured turn. */
  getContextUsage = (): ContextUsage | null => (this.disposed ? null : this.contextUsage);

  compact = async (): Promise<void> => {
    this.assertLive();
    if (!this.sessionEstablished) {
      throw new Error('claude-code session is not established; nothing can be compacted');
    }
    if (this.live !== null || this.preparingTurn || this.compacting) {
      throw new Error('agent session is busy; compaction requires an idle session');
    }
    // The old measurement no longer describes the context, whatever the outcome.
    this.contextUsage = null;
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
      // deadline or a transport error already settled bookkeeping (no new
      // kill policy/timer). The ORIGINAL child's own close is the proof —
      // after an error exactly as after a deadline (owner ruling 2026-10-16,
      // #359); without it the evidence stays UNKNOWN and the slot held.
      // A close BEFORE settlement (the same tick as an error) is remembered,
      // so the settlement below cannot overwrite it.
      let closedBeforeSettlement = false;
      live.once('close', () => {
        if (this.cessationKind === 'live') closedBeforeSettlement = true;
        if (this.cessationKind === 'deadline' || this.cessationKind === 'error') {
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
        // The original child's own close that already came — in the same
        // tick as the error, before this settlement ran — is still its proof:
        // never overwritten by 'error' or 'deadline'. An exit reported after
        // the disposal began is not: past an error or the deadline only the
        // close is (owner ruling 2026-10-16, #359). An exit already reported
        // when the disposal began is the initial proof above, unchanged here.
        else if (closedBeforeSettlement || this.closedVerificationChildren.has(live)) this.cessationKind = 'close-observed-late';
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

  /** Log the MCP servers the CLI could not load — entries it skipped
   * (mcp_server_errors), servers it kept but could not start (status
   * "failed") and servers from GC's own config that need sign-in (status
   * "needs-auth", source "dynamic") — once per distinct set (a set that
   * clears resets, so a later recurrence is logged again). */
  private noteMcpServerProblems(errors: unknown, servers: unknown): void {
    const record = (value: unknown): Record<string, unknown> =>
      typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
    const named = (entry: Record<string, unknown>): string | null => typeof entry['name'] === 'string' ? entry['name'] : null;
    const problems: { readonly name: string | null; readonly why: string }[] = [];
    // Never the CLI's free text — it pastes rejected values in unescaped, and
    // no redaction of free text is airtight — only its skip-reason code
    // (`invalid_config`, `unknown_type`, …), accepted only when it looks like
    // one and holds no credential-shaped run. The CLI's own --debug log
    // carries the details.
    for (const error of Array.isArray(errors) ? errors : []) {
      const entry = record(error);
      const type = entry['type'];
      const code = typeof type === 'string' && /^[a-z][a-z0-9_-]{0,39}$/u.test(type) && !credentialShaped(type) ? type : 'unknown reason';
      problems.push({ name: named(entry), why: `skipped (${code})` });
    }
    // A server the CLI kept but could not start (a missing env var, a broken
    // command) shows only as status "failed"; one from GC's own config that
    // needs OAuth ("needs-auth", source "dynamic") can never sign in from a
    // headless session. The operator's own connectors (user mode, other
    // sources) are not GC's to report. In user mode an entry the CLI's
    // validation rejects leaves no signal at all, so it cannot be logged.
    for (const entry of (Array.isArray(servers) ? servers : []).map(record)) {
      if (entry['status'] === 'failed') problems.push({ name: named(entry), why: 'failed to start' });
      else if (entry['status'] === 'needs-auth' && entry['source'] === 'dynamic') {
        problems.push({ name: named(entry), why: 'needs authentication (a headless session cannot sign in)' });
      }
    }
    if (problems.length === 0) {
      this.mcpServerProblemsNote = null;
      return;
    }
    // Deduped on a digest of the RAW problems in any order — the raw names
    // are never logged or kept — so two different sets never collapse into
    // one because their names are withheld.
    const note = createHash('sha256').update(JSON.stringify(problems.map((problem) => JSON.stringify(problem)).sort())).digest('hex');
    if (note === this.mcpServerProblemsNote) return;
    this.mcpServerProblemsNote = note;
    // Withheld names are numbered within this entry, one number per name.
    const withheld = new Map<string, number>();
    const shown = (name: string | null): string => {
      if (name === null) return '?';
      if (loggableMcpServerName(name)) return name;
      const ordinal = withheld.get(name) ?? withheld.size + 1;
      withheld.set(name, ordinal);
      return `(name withheld #${ordinal})`;
    };
    const lines = problems.map(({ name, why }) => `${shown(name)}: ${why}`);
    this.log('warn', 'claude could not load some MCP servers', {
      cwd: this.params.cwd, servers: lines.slice(0, 20), total: lines.length,
    });
  }

  /** A predecessor that crashed (never disposed) left its copy beside the
   * transcript: this handle holds the session lock and sweeps before its
   * first write, so every copy of the session is stale and is removed —
   * failures logged, never fatal. */
  private async sweepStaleProjectMcpCopies(): Promise<void> {
    const dir = dirname(this.params.sessionFile);
    const base = basename(this.params.sessionFile);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (error) {
      this.log('warn', 'project MCP copy sweep could not list the session directory', { dir, error: String(error) });
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      // Exactly `<this session>.<token>.project-mcp.json` — never a copy of
      // another session whose file name happens to extend this one.
      if (!isProjectMcpCopyName(base, name)) continue;
      await rm(path, { force: true }).catch((error: unknown) => {
        this.log('warn', 'stale project MCP copy could not be removed', { file: path, error: String(error) });
      });
    }
  }

  /** The private project-servers copy lives only as long as the session. */
  private cleanupProjectMcpCopy(): void {
    if (this.params.ambientMcp?.mode !== 'project') return;
    const copy = this.projectMcpCopy;
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
      return this.recordProducerCessation() ? 'ceased' : 'unknown';
    }
    return 'unknown'; // 'live' mid-disposal, 'error', or 'deadline' without a late close
  }

  /** The directive producers' physical receipts (#424): guard refusals still
   * owed, then cessation, once the original child's close is observed. A
   * receipt that cannot be written keeps the evidence UNKNOWN (retried). */
  private recordProducerCessation(): boolean {
    if (this.producersCeased) return true;
    try {
      for (const [key, refusal] of this.pendingGuardRefusals) {
        if (refusal.toolUseId === undefined) recordDirectiveAuthorityRefusal(refusal.producer, refusal.reason);
        else recordDirectiveToolRefusal(refusal.producer, refusal.toolUseId, refusal.reason);
        this.pendingGuardRefusals.delete(key);
      }
      for (const producer of this.directiveProducers.values()) recordDirectiveProducerCessation(producer);
    } catch (error) {
      this.log('error', 'directive producer cessation receipt failed; ownership stays UNKNOWN until it is written', { error: String(error) });
      return false;
    }
    this.producersCeased = true;
    return true;
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
    if (!this.projectMcpSwept) {
      this.projectMcpSwept = true;
      await this.sweepStaleProjectMcpCopies();
    }
    const resolved = await checkedInProjectMcpConfig(this.params.cwd);
    const copy = this.projectMcpCopy;
    if ('reason' in resolved) {
      await rm(copy, { force: true });
      if (this.projectMcpNote !== resolved.reason) {
        this.projectMcpNote = resolved.reason;
        // Fails closed either way; a git/file failure is the operator's to fix.
        this.log(resolved.infrastructure === true ? 'warn' : 'info', 'mcp = "project": no project MCP servers loaded', {
          cwd: this.params.cwd, reason: resolved.reason,
        });
      }
      return { ...this.params, ambientMcp: { mode: 'project' } };
    }
    if (this.disposed) throw new Error('agent session disposed');
    await writeFile(copy, resolved.config, { mode: 0o600 });
    this.projectMcpNote = null;
    return { ...this.params, ambientMcp: { mode: 'project', file: copy } };
  }

  /** Run one CLI process with this operation's params. A project-mode check
   * runs off the event loop while the session's one operation slot stays
   * held; the slot is released, and disposal re-checked, in the same step
   * that spawns — never a window for a second operation or a post-disposal
   * child. A refused or unreadable `.mcp.json` fails closed (the process runs
   * with no project servers, logged); only a failure to write or remove the
   * private copy fails the operation. `onNotSpawned` hears every path that
   * spawns nothing: disposal (null) or that failure (its detail). */
  private withTurnParams(
    spawnWith: (params: HandleParams) => Promise<void>,
    onNotSpawned?: (failure: string | null) => void,
  ): Promise<void> {
    if (this.params.ambientMcp?.mode !== 'project') return spawnWith(this.params);
    this.preparingTurn = true;
    return this.projectTurnParams().then(
      (params) => {
        this.preparingTurn = false;
        if (this.disposed) {
          // Disposal's own cleanup may have run before this check wrote.
          this.cleanupProjectMcpCopy();
          onNotSpawned?.(null);
          throw new Error('agent session disposed');
        }
        return spawnWith(params);
      },
      (error: unknown) => {
        this.preparingTurn = false;
        this.messageAwaitsTurn = false;
        if (this.disposed) {
          this.cleanupProjectMcpCopy();
          onNotSpawned?.(null);
          throw new Error('agent session disposed');
        }
        const detail = `claude turn could not be prepared: ${error instanceof Error ? error.message : String(error)}`;
        onNotSpawned?.(detail);
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
    // A message held while the compaction was being prepared waits behind
    // the compaction, not behind a turn: no turn skips its wait for it.
    this.messageAwaitsTurn = false;

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
      // A CLI that died before it could read its prompt closes stdin under the
      // frame write (EPIPE). That is the child's failure, reported below by its
      // own 'error'/'close'; an unhandled stream 'error' would instead take the
      // whole service down.
      child.stdin?.on('error', (error: Error) => {
        this.log('warn', 'claude compaction stdin is closed; the prompt frame could not be written', { error: String(error) });
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

  private runTurn(text: string, owner: string | null, images?: PromptOptions['images'], directive?: PromptOptions['directive']): Promise<void> {
    // A directive is prepared before any native I/O and before the turn takes
    // the slot (#424): its authority holds, its producer is prepared, and its
    // exact association is durable. A refusal here leaves no effect.
    const turn = directive === undefined ? null : this.prepareDirectiveTurn(text, directive);
    // Only this turn's own result may measure the context it leaves behind.
    this.contextUsage = null;
    this.setState('spawning');
    // The accepted prompt is the pending turn from this moment — through a
    // project-mode check too — so a supervisor capture never misses it.
    this.livePrompt = {
      text,
      owner,
      ...(images !== undefined && images.length > 0 ? { images } : {}),
      ...(directive !== undefined ? { directive } : {}),
    };
    const accepted = this.livePrompt;
    return this.withTurnParams((params) => this.spawnTurn(params, turn), (failure) => {
      turn?.settings.dispose();
      // Error first, exactly as a failed spawn reports: an error-time capture
      // (the supervisor's restart snapshot) still sees the accepted prompt.
      if (failure !== null) {
        this.emit({ type: 'error', error: failure, fatal: false });
        // A subscriber that re-prompted from the error owns the state now.
        // Nothing else changes livePrompt during the emit: this path exists
        // only in project mode, where a re-prompt stays asynchronous, and
        // disposal never clears it.
        if (this.livePrompt === accepted) this.setState('error', failure);
      }
      // Only this turn's prompt: a subscriber may already have re-prompted.
      if (this.livePrompt === accepted) this.livePrompt = null;
    });
  }

  private prepareDirectiveTurn(text: string, directive: NonNullable<PromptOptions['directive']>): DirectiveTurn {
    directive.beforeAdmission();
    const producer = this.prepareProducer(directive.identity);
    const content = claudeDirectiveContent(text);
    // Everything that can still fail comes before the durable association:
    // once it is written, the request is never sent again.
    const settings = privateClaudeDirectiveSettings(this.params.tools, this.params.workerVerification);
    try {
      prepareClaudeDirectiveBinding({ identity: directive.identity, agentId: this.id, sessionId: this.params.sessionId, sessionFile: this.sessionFile,
        content, authorityManifest: this.directiveAuthorityManifest() });
    } catch (error) {
      settings.dispose();
      throw error;
    }
    return { directive, producer, content, settings, admission: null, admitted: null, failure: null, completion: null };
  }

  /** Records a directive turn's failure once and returns the one the turn
   * reports: the first, which a later failure never supersedes (#485). */
  private recordDirectiveFailure(turn: DirectiveTurn, error: unknown): unknown {
    turn.failure ??= { error };
    // Every bookkeeping fault is logged, first or not, and once per fault: the
    // writes Node buffered behind a failed transcript write share its root
    // error, and a write to the stream it destroyed only restates that root.
    if (error instanceof DirectiveBookkeepingError && !isDestroyedStreamWrite(error.fault)) {
      const fault = typeof error.fault === 'object' && error.fault !== null ? error.fault : error;
      if (!this.loggedBookkeepingFaults.has(fault)) {
        this.loggedBookkeepingFaults.add(fault);
        this.log('error', 'claude directive bookkeeping failed; the directive is refused', { request: turn.directive.identity.requestId,
          error: error.message, fault: thrownDetail(error.fault) });
      }
    }
    return turn.failure.error;
  }

  /** Ends the turn with its failure: an earlier one still owed its report is
   * reported, with its own text and as its own cause. */
  private failDirective(turn: DirectiveTurn, error: unknown, abortTurn: (detail: string, cause?: unknown) => void): void {
    const failure = this.recordDirectiveFailure(turn, error);
    abortTurn(`directive refused: ${thrownText(failure)}`, failure);
  }

  /** Admission at the CLI's own echo; completion at the turn's own result. Each
   * reads back the frame only once it is durable in the transcript. */
  private followDirectiveFrame(turn: DirectiveTurn, frame: StreamFrame, durable: Promise<void>, abortTurn: (detail: string, cause?: unknown) => void): void {
    const { directive, producer } = turn;
    if (frame['type'] === 'user' && frame['isReplay'] === true) {
      // The CLI's own task notification is neither the echo nor a second prompt (#471).
      if (isClaudeTaskNotification(frame, this.params.sessionId)) return;
      if (turn.admission !== null) {
        this.failDirective(turn, new DirectiveCheckpointError('a second prompt entered the directive turn'), abortTurn);
        return;
      }
      turn.admission = durable.then(() => {
        // A directive that already failed admits nothing more.
        if (turn.failure !== null) return;
        // The readback with its binding write, and the ledger's publication, are GC's own bookkeeping.
        const binding = withOwnIo('admission receipt', () => inspectDirectiveAdmission(this.sessionFile, directive.identity));
        withOwnIo('admission publication', () => directive.onAdmitted(binding));
        turn.admitted = binding;
      }).catch((error: unknown) => this.failDirective(turn, error, abortTurn));
      return;
    }
    // Before its echo the turn may only announce itself (the checkpoint's own
    // rule): an answer first can never be admitted, so it ends here (#472).
    if (turn.admission === null && turn.failure === null && claudeAnswerFrame(frame)) {
      this.failDirective(turn, new DirectiveCheckpointError('the Claude CLI began answering without echoing the directive instruction (--replay-user-messages), so its admission cannot be proven; look for markup in it that this CLI reserves for its own frames'), abortTurn);
      return;
    }
    if (frame['type'] === 'result' && frame['subtype'] === 'success' && frame['is_error'] === false) {
      // HEAD now, before anything can move the lane; only its durable
      // terminal checkpoint is associated afterwards.
      let head: string | null = null;
      try { head = resolveGitCommit(this.params.cwd, 'HEAD'); }
      catch (error) { this.log('warn', 'native completion HEAD unavailable; current candidate gates remain owed', { error: String(error) }); }
      turn.completion = durable.then(async () => {
        await turn.admission;
        if (turn.failure !== null || turn.admitted === null) return;
        // Completed original work may be historical: verify native authority, not today's candidacy.
        if (withOwnIo('binding read', () => readDirectiveBinding(this.sessionFile, directive.identity.requestId))?.authorityManifest !== this.directiveAuthorityManifest()) {
          this.recordGuardRefusal(producer, undefined, 'live native directive role/tools/model authority changed before completion');
          throw new DirectiveCheckpointError('live native directive role/tools/model authority changed before completion');
        }
        const proof = withOwnIo('checkpoint read', () => inspectDirectiveCheckpoint(this.sessionFile, directive.identity));
        if (proof.state !== 'terminal' || !proof.ok) {
          throw new DirectiveCheckpointError(`native completion checkpoint unavailable: ${proof.state === 'unknown' ? proof.reason : proof.state === 'terminal' ? proof.error ?? 'failed' : 'not terminal'}`);
        }
        withOwnIo('completion receipt', () => recordDirectiveCompletion(producer, proof.checkpointId, head));
      }).catch((error: unknown) => {
        this.recordDirectiveFailure(turn, error);
        this.log('error', 'claude directive completion was not recorded', { request: directive.identity.requestId, error: thrownText(error, 'string') });
      });
    }
  }

  /** The tool fence's checks, synchronous from the admission on. */
  private fenceDirectiveTool(turn: DirectiveTurn, request: ClaudeToolRequest): ClaudeToolDecision {
    if (turn.failure !== null) throw new DirectiveCheckpointError(EARLIER_DIRECTIVE_FAILURE);
    if (turn.admitted === null) {
      throw new DirectiveCheckpointError('native directive actual admission has not been published; tool effects refused');
    }
    // Background tasks are off in a directive turn (#471); a CLI that offers one anyway is refused by
    // name. The CLI reads the strings "true"/"false" as booleans; anything else that is not plainly
    // a foreground call is refused too.
    const background = request.input['run_in_background'];
    if (background !== undefined && background !== false && background !== 'false') {
      throw new DirectiveCheckpointError('a directive turn cannot start a background task: its completion would outlive the turn');
    }
    // Each GC bookkeeping call runs by itself: a fault there is GC's refusal.
    withOwnIo('authority check', () => turn.directive.beforeAdmission());
    if (withOwnIo('binding read', () => readDirectiveBinding(this.sessionFile, turn.directive.identity.requestId))?.authorityManifest !== this.directiveAuthorityManifest()) {
      throw new DirectiveCheckpointError('live native directive role/tools/model authority changed before effect');
    }
    withOwnIo('tool intent read', () => assertClaudeDirectiveToolIntent(this.sessionFile, turn.directive.identity, request.toolUseId, request.toolName, request.input));
    return { allow: true };
  }

  /** The fence passed, but the turn may have failed since: the allow is
   * re-checked as it is written, and a recorded failure denies it, with the
   * same durable guard receipt as a fence deny (#485). A failure of the CLI
   * process, or of the channel's transport or protocol, records none: GC has
   * ended the CLI's stdin, so the allow is dropped there and no tool runs. */
  private confirmDirectiveTool(turn: DirectiveTurn, request: ClaudeToolRequest): ClaudeToolDecision {
    if (turn.failure === null) return { allow: true };
    this.recordGuardRefusal(turn.producer, request.toolUseId, EARLIER_DIRECTIVE_FAILURE);
    return { allow: false, message: `Refused by the directive's authority fence: ${EARLIER_DIRECTIVE_FAILURE}` };
  }

  /** The tool fence (#424): admission published, authority current, the exact
   * intent durable in the admitted turn. Anything else refuses the tool and
   * ends the turn, with a durable guard receipt. */
  private decideDirectiveTool(turn: DirectiveTurn, request: ClaudeToolRequest, durable: Promise<void>, abortTurn: (detail: string, cause?: unknown) => void): Promise<ClaudeToolDecision> {
    return durable.then(async (): Promise<ClaudeToolDecision> => {
      await turn.admission;
      try {
        return this.fenceDirectiveTool(turn, request);
      } catch (error) {
        // Recorded before this decision yields: a concurrent request's fence,
        // resuming right after it, must see the failure (#485).
        this.recordDirectiveFailure(turn, error);
        throw error;
      }
    }).catch((error: unknown): ClaudeToolDecision => {
      const reason = thrownText(error);
      this.recordGuardRefusal(turn.producer, request.toolUseId, reason);
      this.recordDirectiveFailure(turn, error);
      // The deny is written first (this decision's own continuation); the
      // turn ends right after it.
      setImmediate(() => this.failDirective(turn, error, abortTurn));
      return { allow: false, message: `Refused by the directive's authority fence: ${reason}` };
    });
  }

  private spawnTurn(params: HandleParams, turn: DirectiveTurn | null = null): Promise<void> {
    const translator = new ClaudeTurnTranslator();
    let turnStarted = false;
    const livePrompt = this.livePrompt;
    if (livePrompt === null) throw new Error('claude turn spawned without its accepted prompt');
    const { text } = livePrompt;
    const images = livePrompt.images;
    // Background work stopped after a reply is told to the minion once, ahead
    // of its next ordinary prompt. A directive's text is exact, and a prompt
    // that starts with "/" is a command to the CLI: both leave it for later.
    const notice = turn === null && !text.startsWith('/') ? this.backgroundNotice : null;
    if (notice !== null) this.backgroundNotice = null;
    const sent = notice === null ? text : `${notice}\n\n${text}`;
    const keepNotice = (): void => { if (notice !== null) this.backgroundNotice ??= notice; };

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let failed = false;
      let failure = '';
      /** The turn failed as GC's own directive refusal (#485). */
      let refused = false;
      let child: ChildProcess;
      let stderrTail = '';

      // An ordinary turn's background wait: after the reply the CLI waits on
      // the background tasks it still runs, then answers their completion in
      // a follow-up turn of its own. GC allows that for backgroundWaitMs of
      // idle time after each reply, and no longer once a message is waiting;
      // then it stops the CLI, which stops its tasks.
      const waitMs = params.backgroundWaitMs ?? DEFAULT_CLAUDE_BACKGROUND_WAIT_MS;
      const stopGraceMs = Math.max(params.killGraceMs, params.backgroundStopGraceMs ?? DEFAULT_BACKGROUND_STOP_GRACE_MS);
      let replied = false;
      let answered = false;
      // The prompted turn's own reply (its first result) was an in-band error.
      let errored = false;
      let followUp = false;
      // A message that arrived while this turn was being prepared.
      let messageWaiting = turn === null && this.messageAwaitsTurn;
      this.messageAwaitsTurn = false;
      let stopping = false;
      let tasks: readonly string[] = [];
      let unlistedTasksLogged = false;
      let announced = false;
      // The CLI has closed: its terminal events follow, after the board label.
      let ended = false;
      let waitTimer: ReturnType<typeof setTimeout> | null = null;
      let resolveTurnSettled: () => void = () => {};
      const turnSettled = new Promise<void>((resolveSettled) => { resolveTurnSettled = resolveSettled; });
      // The board shows what a replied turn still waits on.
      const announce = (): void => {
        if (replied && !followUp && !ended && !settled && tasks.length > 0) {
          this.emit({ type: 'background_wait', tasks });
          announced = true;
        } else if (announced) {
          this.emit({ type: 'background_wait', tasks: [] });
          announced = false;
        }
      };
      const stopBackground = (reason: BackgroundStopReason): void => {
        if (stopping || settled || ended) return;
        stopping = true;
        // A CLI that already ended by itself was stopped by nothing.
        if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
        if (tasks.length > 0) this.backgroundNotice = backgroundStopNotice(tasks, reason, waitMs);
        this.log('info', 'stopping a claude turn that has replied and only waits on background work', {
          session_id: params.sessionId, reason, tasks,
        });
        try { child.stdin?.end(); } catch { /* already closed */ }
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        // A CLI that ignores SIGTERM is killed after the grace period. A killed
        // CLI cannot stop its tasks, so the minion is told they may run on.
        const target = child;
        const stoppedTasks = tasks;
        const escalation = setTimeout(() => {
          this.log('warn', 'a claude CLI waiting on background work ignored SIGTERM and was killed; that work may still be running', {
            session_id: params.sessionId, reason, tasks: stoppedTasks,
          });
          if (stoppedTasks.length > 0) this.backgroundNotice = backgroundStopNotice(stoppedTasks, reason, waitMs, true);
          try { target.kill('SIGKILL'); } catch { /* already gone */ }
        }, stopGraceMs);
        escalation.unref();
        target.once('close', () => clearTimeout(escalation));
      };
      // The clock runs only while the replied turn is idle. A waiting message,
      // or a reply that was an in-band error, stops listed tasks at once; with
      // none listed the CLI is ending by itself, and is stopped only if it
      // has not after the grace period.
      // A follow-up turn of the CLI's own pauses the clock, except in a
      // worker-verification lane (the host's permission input is already
      // closed there, so that turn cannot be hosted) and after an error
      // reply (whose stop must not wait for it).
      const paused = (): boolean => followUp && permissions === undefined && !errored;
      let waitDeadline = 0;
      // A reply (`fresh`) restarts the clock; anything else only brings the
      // stop closer, so further messages never push it back.
      const arm = (fresh: boolean): void => {
        if (!replied || paused() || stopping || settled || ended) {
          if (waitTimer !== null) clearTimeout(waitTimer);
          waitTimer = null;
          return;
        }
        const reason: BackgroundStopReason = errored ? 'error' : messageWaiting ? 'message' : 'limit';
        const delay = reason === 'limit' ? waitMs : tasks.length > 0 ? 0 : stopGraceMs;
        // Deadlines compare on the clock Node's timers run on, so a wall-clock
        // change (NTP, a manual reset) cannot reorder a stop and the limit.
        const deadline = performance.now() + delay;
        if (delay > 0 && !fresh && waitTimer !== null && waitDeadline <= deadline) return;
        if (waitTimer !== null) clearTimeout(waitTimer);
        waitTimer = null;
        if (delay === 0) {
          stopBackground(reason);
          return;
        }
        waitDeadline = deadline;
        waitTimer = setTimeout(() => stopBackground(reason), delay);
        waitTimer.unref();
      };
      const wait: BackgroundWait = {
        answered: () => answered,
        waiting: () => replied && !paused() && !settled,
        end: () => {
          if (settled || ended) return Promise.resolve();
          messageWaiting = true;
          if (!replied || paused()) return Promise.resolve();
          arm(false);
          return turnSettled;
        },
      };

      const settle = (error: Error | null): void => {
        if (settled) return;
        settled = true;
        if (waitTimer !== null) clearTimeout(waitTimer);
        announce();
        if (this.backgroundWait === wait) this.backgroundWait = null;
        resolveTurnSettled();
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
      // A directive turn's failure is a native directive refusal (#485) when
      // the caller names its cause and that cause is GC's own refusal: a
      // fence's error, the permission channel's deny, or, at the turn's end,
      // the failure the turn recorded when nothing reported one sooner. An
      // unrelated failure (the process, a foreign session) names no cause.
      const failTurn = (detail: string, cause?: unknown): void => {
        if (failed) return;
        failed = true;
        failure = detail;
        refused = turn !== null && isNativeDirectiveRefusal(cause);
        if (!this.disposed) {
          this.emit({ type: 'error', error: detail, fatal: false, ...(refused ? { nativeControl: 'directive-refusal' as const } : {}) });
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
        keepNotice();
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
      let directivePermissions: ClaudeDirectivePermissionChannel | undefined;
      // A directive refusal ends the turn: no further effect is allowed.
      let escalation: ReturnType<typeof setTimeout> | null = null;
      /** A live directive child already reported an error (handled once). */
      let liveError = false;
      const abortTurn = (detail: string, cause?: unknown): void => {
        failTurn(detail, cause);
        if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
        try { child.stdin?.end(); } catch { /* already closed */ }
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
        // A child that ignores SIGTERM is killed after the grace period (armed once).
        if (escalation === null) {
          const target = child;
          escalation = setTimeout(() => { try { target.kill('SIGKILL'); } catch { /* already gone */ } }, params.killGraceMs);
          escalation.unref();
          target.once('close', () => { if (escalation !== null) clearTimeout(escalation); });
        }
      };
      const handleFrame = (frame: StreamFrame): void => {
        if (turn !== null) {
          // Durable before acted on (#424): a frame that gates a step (the
          // echo, a tool permission request, the result) is written and synced
          // — with every frame before it — before that step reads it back.
          const gates = (frame['type'] === 'user' && frame['isReplay'] === true) || frame['type'] === 'control_request' || frame['type'] === 'result';
          const durable = !gates
            ? new Promise<void>((resolveWritten) => {
              transcript.write(`${JSON.stringify(frame)}\n`, (error?: Error | null) => {
                // A lost frame leaves the directive's record incomplete: no delivery.
                try {
                  if (error != null) this.failDirective(turn, ownIoRefusal('transcript write', error), abortTurn);
                } catch (failure) {
                  // The directive still fails, and its CLI is still ended. An
                  // earlier failure still owed its report stays the turn's.
                  const owed = this.recordDirectiveFailure(turn, failure);
                  this.log('error', 'directive failure handling threw after a lost transcript write', { error: thrownDetail(failure) });
                  // abortTurn cannot throw: its signals are guarded and event
                  // listeners are isolated by emit().
                  abortTurn(owed === failure ? `directive failure handling threw: ${thrownText(failure)}` : `directive refused: ${thrownText(owed)}`, owed);
                } finally {
                  resolveWritten();
                }
              });
            })
            : new Promise<void>((resolveDurable, rejectDurable) => {
              // A lost gating frame is GC's own transcript I/O: its refusal.
              const lost = (error: unknown): void => rejectDurable(ownIoRefusal('transcript write', error));
              transcript.write(`${JSON.stringify(frame)}\n`, (error?: Error | null) => {
                if (error != null) { lost(error); return; }
                try { syncTranscript(params.sessionFile); resolveDurable(); } catch (syncError) { lost(syncError); }
              });
            });
          durable.catch(() => { /* each consumer observes it */ });
          directivePermissions?.ingest(frame, durable);
          if (frame['type'] === 'result') child?.stdin?.end();
          this.followDirectiveFrame(turn, frame, durable, abortTurn);
        } else {
          permissions?.ingest(frame);
          if (permissions !== undefined && frame['type'] === 'result') child?.stdin?.end();
          transcript.write(`${JSON.stringify(frame)}\n`);
          if (frame['type'] === 'system' && frame['subtype'] === 'background_tasks_changed') {
            const listed = backgroundTaskDescriptions(frame['tasks']);
            if (listed !== null) tasks = listed;
            else if (!unlistedTasksLogged) {
              unlistedTasksLogged = true;
              this.log('warn', 'claude background_tasks_changed frame carries no task list; the board and the stop notice cannot name that work', {
                session_id: params.sessionId,
              });
            }
            announce();
            if (messageWaiting) arm(false);
          } else if (frame['type'] === 'system' && frame['subtype'] === 'init' && replied) {
            // The CLI's own follow-up turn: the minion is working again.
            followUp = true;
            arm(false);
            announce();
          } else if (frame['type'] === 'result') {
            // The prompted turn's verdict is its first result, read as the
            // translator reads it; a later result is a follow-up turn's own.
            if (!replied) {
              errored = frame['is_error'] === true;
              answered = !errored;
            }
            replied = true;
            followUp = false;
            arm(true);
            announce();
          }
        }
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
            // A directive refuses everything after this (admission, tools,
            // completion). Ends stdin too (a directive turn keeps it open)
            // and escalates to SIGKILL for a CLI that ignores SIGTERM.
            if (turn !== null) this.recordDirectiveFailure(turn, new DirectiveCheckpointError(`the CLI reported a foreign session (${init.sessionId || '(empty)'}, not ${params.sessionId})`));
            abortTurn(
              `session id mismatch: requested ${params.sessionId}, claude reported ` +
                `${init.sessionId || '(empty)'} — refusing to continue a foreign session`,
            );
            return;
          }
          // Servers the CLI skipped (mcp_server_errors, --mcp-config only),
          // kept but could not start (status "failed"), or that need a
          // sign-in a headless session cannot give are logged once per
          // distinct set. (In user mode an entry the CLI's validation
          // rejects leaves no signal at all.)
          this.noteMcpServerProblems(frame['mcp_server_errors'], frame['mcp_servers']);
          // Record what this turn was asked right after its verified identity
          // frame: stdout carries only claude's side of the conversation. Not
          // the CLI's --replay-user-messages: it also echoes the permission
          // control_responses the worker-verification channel writes, which
          // that channel rightly fails closed on as foreign frames.
          // A directive turn's record is the CLI's own echo (#424).
          if (turn === null) {
            transcript.write(`${JSON.stringify({
              ...claudePromptFrame(sent, images),
              session_id: params.sessionId,
              timestamp: new Date().toISOString(),
              gc_prompt: true,
            })}\n`);
          }
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
        const args = turn === null
          ? claudeTurnArgs(params, this.sessionEstablished)
          : [...claudeTurnArgs({ ...params, verificationSettingsFile: turn.settings.file }, this.sessionEstablished), '--replay-user-messages'];
        // The CLI child is an independent physical controller of the turn:
        // only its observed close (at this handle's cessation) proves it gone.
        if (turn !== null) withOwnIo('controller receipt', () => recordDirectiveIndependentController(turn.producer));
        child = (params.spawnProcess ?? spawn)(params.binary, args, {
          cwd: params.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          ...(params.reviewAuthEnv !== undefined ? { env: params.reviewAuthEnv } : {}),
        });
      } catch (error) {
        if (turn !== null && isNativeDirectiveRefusal(error)) {
          // GC's own controller receipt failed: no CLI was started (#485).
          const failure = this.recordDirectiveFailure(turn, error);
          failTurn(`directive refused: ${thrownText(failure)}`, failure);
        } else {
          // Synchronous spawn faults (async ENOENT arrives via 'error').
          this.onInfraError(error);
          failTurn(`claude process failed to spawn: ${String(error)}`);
        }
        turn?.settings.dispose();
        keepNotice();
        transcript.end(() => settle(new Error(failure)));
        return;
      }
      this.trackVerificationChild(child);
      this.live = child;
      if (turn === null) this.backgroundWait = wait;

      child.stdout?.on('data', (chunk: Buffer) => parser.push(chunk));
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
      });
      // A CLI that died before it could read its prompt closes stdin under the
      // frame write (EPIPE). The turn settles from the child's own 'error'/
      // 'close'; an unhandled stream 'error' would crash the whole service.
      child.stdin?.on('error', (error: Error) => {
        this.log('warn', 'claude stdin is closed; the prompt frame could not be written', { error: String(error) });
      });
      child.on('error', (error: Error) => {
        // Async spawn failure (ENOENT when the binary is missing, ...).
        // 'close' may never follow — settle here too (guarded).
        if (turn !== null && child.pid !== undefined) {
          // A live directive CLI (#424): its turn settles only from its close
          // (one writer per session), so it is ended — once — to make that
          // close come; its settings stay until then.
          if (liveError) {
            this.log('warn', 'a further claude child error was ignored: its first error already began ending the child', { error: String(error) });
            return;
          }
          liveError = true;
          // End the child first: nothing else here may stand between the
          // error and the abort that makes its close come.
          abortTurn(`claude process failed: ${String(error)}`);
          this.onInfraError(error);
          return;
        }
        this.onInfraError(error);
        failTurn(`claude process failed to spawn: ${String(error)}`);
        parser.end();
        // A child that never started can never read its settings.
        turn?.settings.dispose();
        keepNotice();
        transcript.end(() => settle(new Error(failure)));
      });
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        parser.end();
        turn?.settings.dispose();
        transcript.end(() => {
          // A directive's admission and completion steps finish before the turn settles.
          const steps = turn === null ? Promise.resolve() : Promise.allSettled([turn.admission, turn.completion]).then(() => undefined);
          void steps.then(() => finishTurn(code, signal));
        });
      });
      const finishTurn = (code: number | null, signal: NodeJS.Signals | null): void => {
        // The board label clears before the turn's terminal events: an event
        // after them would read as new activity to supervision.
        ended = true;
        announce();
        if (this.disposed) {
          settle(new Error('agent session disposed'));
          return;
        }
        // A directive whose admission, fence or completion failed — or whose
        // admission was never published at all — is no success, whatever the
        // CLI reported.
        if (turn !== null && turn.failure !== null && !failed) {
          failTurn(`directive turn refused: ${thrownText(turn.failure.error)}`, turn.failure.error);
        }
        if (turn !== null && turn.admitted === null && !failed && translator.result !== null) {
          failTurn('directive turn ended without the CLI\'s admission echo; nothing it did counts as delivered');
        }
        const result = translator.result;
        if (!failed && result !== null && !turnStarted) {
          // Frames flowed but no init ever arrived: the session identity
          // was never verified — a protocol violation, not a success.
          failTurn('claude completed without an init frame — session identity never verified');
        }
        if (!failed && result !== null) {
          // Set before turn_end, so an idle snapshot already reads it.
          this.contextUsage = translator.contextUsage;
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
        // The refusal is GC's, but an API error the CLI reported on the main
        // thread of the same turn is the provider's (#485): emitted untagged
        // so supervision classifies it, even when the abort cut off its
        // result. After a refusal GC reports the last main-thread API error it
        // saw, even one the CLI's own result would drop (a wall seen is a
        // wall), unless a later real main-thread call cleared it (the CLI's
        // own `<synthetic>` replies do not), with an error result's text when
        // there is one, through the ordinary path's own text helper. That is a
        // main-thread API-error frame with text, a status or a code, or a
        // result that carries an API status. A subagent's API error, and a
        // result error the abort itself caused, are not the turn's. Any other
        // failed turn reports only its own failure.
        const apiError = translator.apiError;
        if (refused && ((apiError !== null && (apiError.text.trim() !== '' || apiError.status !== null || apiError.code !== null)) || (result?.apiErrorStatus ?? null) !== null)) {
          this.emit(claudeInBandError(result?.isError === true ? result : { subtype: 'error', isError: true, text: null, apiErrorStatus: result?.apiErrorStatus ?? null },
            apiError, translator.init?.model ?? params.model ?? null));
        }
        if (!failed) {
          const via = signal !== null ? `signal ${signal}` : `exit ${code}`;
          failTurn(
            `claude ended via ${via} without a result frame` +
              (stderrTail.trim() !== '' ? `: ${stderrTail.trim()}` : ''),
          );
        }
        // A CLI that failed before it started never showed the minion the notice.
        if (!turnStarted) keepNotice();
        settle(new Error(failure));
      };

      // Policy and directive children keep stdin open for native permission
      // responses; other turns retain the existing single-frame/EOF transport.
      const send = (): void => {
        const prompt = turn === null ? claudePromptFrame(sent, images) : { type: 'user', message: { role: 'user', content: turn.content } };
        child.stdin?.write(`${JSON.stringify(prompt)}\n`, (error?: Error | null) => {
          if (error != null) this.log('error', 'failed to write prompt frame to claude stdin', { error: String(error) });
          if (permissions === undefined && directivePermissions === undefined) child.stdin?.end();
        });
      };
      if (turn !== null) {
        // Every tool asks the host (#424); the lane's verification policy rides along.
        directivePermissions = new ClaudeDirectivePermissionChannel(child, {
          // The failure after the channel's own deny reports the turn's
          // failure: that deny, or an earlier one still owed its report, with
          // its own text and as its own cause (#485).
          fail: (message, refused) => {
            const report = refused as { readonly failure: unknown; readonly owed: boolean } | undefined;
            if (report === undefined) abortTurn(message);
            else abortTurn(report.owed ? `directive refused: ${thrownText(report.failure)}` : message, report.failure);
          },
          // A deny the channel wrote itself is a refusal like the fence's (#424).
          refused: (toolUseId, reason) => {
            const refusal = new DirectiveCheckpointError(reason);
            this.recordGuardRefusal(turn.producer, toolUseId, refusal.message);
            const failure = this.recordDirectiveFailure(turn, refusal);
            return { failure, owed: failure !== refusal };
          },
          decide: (request, durable) => this.decideDirectiveTool(turn, request, durable, abortTurn),
          confirm: (request) => this.confirmDirectiveTool(turn, request),
          ...(params.workerVerification !== undefined ? { verification: params.workerVerification } : {}),
        });
        directivePermissions.start();
        if (!failed) send();
      } else if (params.workerVerification !== undefined && !params.isolatedReview) {
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
