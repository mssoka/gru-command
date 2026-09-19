import { lstatSync, readFileSync, statSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { parse, type TomlPrimitive } from 'smol-toml';

/** Roles are product-native and runtime-agnostic (SPEC ruling 15). */
export const ROLES = ['gru', 'silas', 'minion', 'perkins', 'bob'] as const;
export type Role = (typeof ROLES)[number];

/** Runtime adapters known to the config schema. Implementations land in E2/E3. */
export const RUNTIME_IDS = ['pi', 'claude-code'] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
}

export interface AuthConfig {
  readonly token: string;
}

export interface RuntimesConfig {
  readonly default: RuntimeId;
  readonly roles: Readonly<Partial<Record<Role, RuntimeId>>>;
  /** Per-runtime model & thinking policy (SPEC ruling 16). */
  readonly policies: Readonly<Partial<Record<RuntimeId, RuntimeModelPolicy>>>;
}

/** Model + thinking overrides scoped to one runtime adapter (SPEC ruling 16). */
export interface RuntimeModelPolicy {
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly roles: Readonly<Partial<Record<Role, RuntimeRolePolicyEntry>>>;
}

/** Per-role overrides inside a runtime policy; at least one field set. */
export interface RuntimeRolePolicyEntry {
  readonly model?: string;
  readonly thinkingLevel?: string;
}

export interface ModelsConfig {
  readonly default: string;
  readonly roles: Readonly<Partial<Record<Role, string>>>;
}

export interface ThinkingConfig {
  readonly default: string;
  readonly roles: Readonly<Partial<Record<Role, string>>>;
}

/** In-process supervision policy (EPICS E7; SPEC ruling 5 — the OS
 * service manager is the out-of-band watcher, this is the agent layer). */
export interface SupervisionConfig {
  readonly enabled: boolean;
  /** A streaming/spawning turn with no runtime event AND no session-file
   * growth for this long is hung (E3's turn-liveness deferral, E7 home). */
  readonly turnSilenceMs: number;
  /** Rolling crash-loop window; ≥ max_restarts inside it trips the breaker. */
  readonly restartWindowMs: number;
  readonly maxRestarts: number;
  /** Backoff base between restart rungs; doubles per consecutive failure,
   * capped at 60 s. */
  readonly restartBackoffMs: number;
}

/** Size-based log rotation (E1 deferral, E7 home). */
export interface LoggingConfig {
  /** Rotate service.log when it exceeds this many bytes. */
  readonly maxBytes: number;
  /** Rotated files retained (oldest pruned first). */
  readonly keep: number;
}

/** Chat frame-log rotation (E4 replay-cost deferral — same ruling). */
export interface ChatConfig {
  /** Rotate gru.frames.jsonl when it exceeds this many bytes. */
  readonly frameLogMaxBytes: number;
  /** Rotated shards retained; replay spans shards oldest→newest. */
  readonly frameLogKeep: number;
}

/** Worktree manager policy (E8; SPEC ruling 18). */
export interface WorktreesConfig {
  /** Root under which job/review worktrees are created. */
  readonly root: string;
  /** Where preserved untracked deliverables land on sweep. */
  readonly preserveRoot: string;
  /** Budget per one-time bootstrap setup command (ms). */
  readonly setupTimeoutMs: number;
}

/** Dispatch flow policy (E8). */
export interface DispatchConfig {
  /** Bob's periodic consolidation interval; 0 disables the trigger. */
  readonly bobIntervalMs: number;
}

export interface GruCommandConfig {
  readonly workspaceRoot: string;
  readonly dataDir: string;
  readonly server: ServerConfig;
  readonly auth: AuthConfig;
  readonly runtimes: RuntimesConfig;
  readonly models: ModelsConfig;
  readonly thinking: ThinkingConfig;
  readonly supervision: SupervisionConfig;
  readonly logging: LoggingConfig;
  readonly chat: ChatConfig;
  readonly worktrees: WorktreesConfig;
  readonly dispatch: DispatchConfig;
  /** Absolute path the config was loaded from; null when running on pure defaults. */
  readonly sourceFile: string | null;
  /** Absolute per-instance directory holding config, identity, logs, sessions. */
  readonly instanceDir: string;
}

/** Fully-resolved model & thinking policy for one spawn (SPEC ruling 16). */
export interface SpawnPolicy {
  /** "default" (runtime's own) or an explicit "provider/model" string. */
  readonly model: string;
  /** "default" (runtime's own) or an explicit level name. */
  readonly thinkingLevel: string;
}

function normalizeSentinel(value: string | undefined): string {
  if (value === undefined || value.trim() === '') return MODEL_DEFAULT_SENTINEL;
  return value;
}

/**
 * Resolve the spawn policy for a role on a runtime: spawn options beat
 * per-runtime-per-role, which beats per-role, which beats per-runtime,
 * which beats the global default (most specific wins). An explicit
 * "default" SENTINEL at a narrower tier PINS — it shadows wider tiers
 * (lets you un-set a global per runtime); "" is treated as "default"
 * (E1 configs with an empty models.default keep booting identically).
 */
export function resolveSpawnPolicy(
  config: GruCommandConfig,
  runtimeId: RuntimeId,
  role: Role,
  overrides: { model?: string; thinkingLevel?: string } = {},
): SpawnPolicy {
  const policy = config.runtimes.policies[runtimeId];
  const runtimeRole = policy?.roles[role];
  const model =
    overrides.model !== undefined
      ? overrides.model
      : runtimeRole?.model ?? config.models.roles[role] ?? policy?.model ?? config.models.default;
  const thinkingLevel =
    overrides.thinkingLevel !== undefined
      ? overrides.thinkingLevel
      : runtimeRole?.thinkingLevel ??
        config.thinking.roles[role] ??
        policy?.thinkingLevel ??
        config.thinking.default;
  return {
    model: normalizeSentinel(model),
    thinkingLevel: normalizeSentinel(thinkingLevel),
  };
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly file: string,
    readonly field?: string,
  ) {
    super(field ? `${message} (file: ${file}, field: ${field})` : `${message} (file: ${file})`);
    this.name = 'ConfigError';
  }
}

const ENV_INSTANCE_DIR = 'GRU_COMMAND_HOME';

export function instanceDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ENV_INSTANCE_DIR];
  if (override !== undefined) {
    if (!isAbsolute(override)) {
      throw new ConfigError(
        `${ENV_INSTANCE_DIR} must be an absolute path, got: ${override}`,
        override,
      );
    }
    return override;
  }
  return join(homedir(), '.gru-command');
}

export function configPathFor(instanceDir: string): string {
  return join(instanceDir, 'config.toml');
}

export function expandTilde(path: string, home: string = homedir()): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return join(home, path.slice(2));
  return path;
}

const TOP_LEVEL_KEYS = [
  'workspace_root',
  'data_dir',
  'server',
  'auth',
  'runtimes',
  'models',
  'thinking',
  'supervision',
  'logging',
  'chat',
  'worktrees',
  'dispatch',
] as const;

/** Sentinel meaning "the runtime harness's own configured default" (SPEC ruling 16). */
export const MODEL_DEFAULT_SENTINEL = 'default';

function isPlainObject(value: unknown): value is Record<string, TomlPrimitive> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  // TOML dates/times parse to Date-like class instances, not tables; without
  // this check they slip through as silently-empty tables.
  return Object.getPrototypeOf(value) === Object.prototype;
}

function requireString(
  value: unknown,
  file: string,
  field: string,
  opts: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== 'string') {
    throw new ConfigError(
      `${field} must be a string, got ${typeof value}`,
      file,
      field,
    );
  }
  if (!opts.allowEmpty && value.trim() === '') {
    throw new ConfigError(`${field} must not be empty`, file, field);
  }
  return value;
}

function requireTable(
  value: unknown,
  file: string,
  field: string,
): Record<string, TomlPrimitive> {
  if (!isPlainObject(value)) {
    throw new ConfigError(`${field} must be a table`, file, field);
  }
  return value;
}

function readRoleTable<T extends string>(
  value: unknown,
  file: string,
  field: string,
  validateValue: (v: unknown, file: string, f: string) => T,
): Partial<Record<Role, T>> {
  const table = requireTable(value, file, field);
  const out: Partial<Record<Role, T>> = {};
  for (const [key, val] of Object.entries(table)) {
    if (!(ROLES as readonly string[]).includes(key)) {
      throw new ConfigError(
        `unknown role \`${key}\` (valid roles: ${ROLES.join(', ')})`,
        file,
        `${field}.${key}`,
      );
    }
    out[key as Role] = validateValue(val, file, `${field}.${key}`);
  }
  return out;
}

function validateRuntimeId(value: unknown, file: string, field: string): RuntimeId {
  const id = requireString(value, file, field);
  if (!(RUNTIME_IDS as readonly string[]).includes(id)) {
    throw new ConfigError(
      `unknown runtime \`${id}\` (valid runtimes: ${RUNTIME_IDS.join(', ')})`,
      file,
      field,
    );
  }
  return id as RuntimeId;
}

function requireBool(value: unknown, file: string, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${field} must be a boolean, got ${typeof value}`, file, field);
  }
  return value;
}

function requirePositiveInt(value: unknown, file: string, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError(
      `${field} must be a positive integer, got: ${String(value)}`,
      file,
      field,
    );
  }
  return value;
}

function requireNonNegativeInt(value: unknown, file: string, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ConfigError(
      `${field} must be a non-negative integer, got: ${String(value)}`,
      file,
      field,
    );
  }
  return value;
}

function isInsideOrEqual(outer: string, inner: string): boolean {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Distinguish "no config file" (boot on defaults) from a broken config
 * path: a dangling symlink must fail loud, not silently vanish.
 */
function configState(file: string): 'present' | 'absent' {
  try {
    statSync(file);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new ConfigError(`cannot stat config file: ${code ?? String(error)}`, file);
    }
    try {
      lstatSync(file);
    } catch {
      return 'absent';
    }
    throw new ConfigError(
      'config path is a dangling symlink — fix or remove it (refusing to silently boot on defaults)',
      file,
    );
  }
}

/**
 * Load and validate the instance configuration.
 *
 * Fail-loud contract: any parse or schema error throws {@link ConfigError}
 * naming the file and the offending field. A missing config file is not an
 * error — the service boots on documented defaults.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): GruCommandConfig {
  const instanceDir = instanceDirFromEnv(env);
  const file = configPathFor(instanceDir);

  const defaultWorkspaceRoot = join(home, 'code');
  let workspaceRoot = defaultWorkspaceRoot;
  let dataDir = instanceDir;
  let server: ServerConfig = { host: '127.0.0.1', port: 7665 };
  let auth: AuthConfig = { token: '' };
  let runtimes: RuntimesConfig = { default: 'pi', roles: {}, policies: {} };
  let models: ModelsConfig = { default: MODEL_DEFAULT_SENTINEL, roles: {} };
  let thinking: ThinkingConfig = { default: MODEL_DEFAULT_SENTINEL, roles: {} };
  let supervision: SupervisionConfig = {
    enabled: true,
    turnSilenceMs: 900_000,
    restartWindowMs: 600_000,
    maxRestarts: 3,
    restartBackoffMs: 2_000,
  };
  let logging: LoggingConfig = { maxBytes: 10_485_760, keep: 5 };
  let chat: ChatConfig = { frameLogMaxBytes: 8_388_608, frameLogKeep: 3 };
  let worktrees: WorktreesConfig | null = null;
  let dispatch: DispatchConfig = { bobIntervalMs: 3_600_000 };
  let sourceFile: string | null = null;

  if (configState(file) === 'present') {
    sourceFile = file;
    let text: string;
    try {
      text = readFileSync(file, 'utf-8');
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code;
      throw new ConfigError(
        errno !== undefined
          ? `cannot read config file: ${errno} — check permissions`
          : `cannot read config file: ${(error as Error).message}`,
        file,
      );
    }
    let raw: Record<string, TomlPrimitive>;
    try {
      raw = parse(text) as Record<string, TomlPrimitive>;
    } catch (error) {
      throw new ConfigError(
        `failed to parse TOML: ${(error as Error).message}`,
        file,
      );
    }
    for (const key of Object.keys(raw)) {
      if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
        throw new ConfigError(
          `unknown top-level key \`${key}\` (valid keys: ${TOP_LEVEL_KEYS.join(', ')})`,
          file,
          key,
        );
      }
    }
    if (raw['workspace_root'] !== undefined) {
      workspaceRoot = expandTilde(
        requireString(raw['workspace_root'], file, 'workspace_root'),
        home,
      );
    }
    if (raw['data_dir'] !== undefined) {
      dataDir = expandTilde(requireString(raw['data_dir'], file, 'data_dir'), home);
    }
    if (raw['server'] !== undefined) {
      const table = requireTable(raw['server'], file, 'server');
      for (const key of Object.keys(table)) {
        if (!['host', 'port'].includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [server] (valid keys: host, port)`,
            file,
            `server.${key}`,
          );
        }
      }
      let host = server.host;
      let port = server.port;
      if (table['host'] !== undefined) {
        host = requireString(table['host'], file, 'server.host');
      }
      if (table['port'] !== undefined) {
        const p = table['port'];
        if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > 65535) {
          throw new ConfigError(
            'server.port must be an integer between 0 and 65535 (0 = ephemeral)',
            file,
            'server.port',
          );
        }
        port = p;
      }
      server = { host, port };
    }
    if (raw['auth'] !== undefined) {
      const table = requireTable(raw['auth'], file, 'auth');
      for (const key of Object.keys(table)) {
        if (key !== 'token') {
          throw new ConfigError(
            `unknown key \`${key}\` in [auth] (valid key: token)`,
            file,
            `auth.${key}`,
          );
        }
      }
      if (table['token'] !== undefined) {
        auth = { token: requireString(table['token'], file, 'auth.token') };
      }
    }
    if (raw['runtimes'] !== undefined) {
      const table = requireTable(raw['runtimes'], file, 'runtimes');
      for (const key of Object.keys(table)) {
        const isMeta = ['default', 'roles'].includes(key);
        const isRuntimeId = (RUNTIME_IDS as readonly string[]).includes(key);
        if (!isMeta && !isRuntimeId) {
          throw new ConfigError(
            `unknown key \`${key}\` in [runtimes] (valid keys: default, roles, or a runtime id: ${RUNTIME_IDS.join(', ')})`,
            file,
            `runtimes.${key}`,
          );
        }
      }
      let def = runtimes.default;
      let roles = runtimes.roles;
      const policies: Partial<Record<RuntimeId, RuntimeModelPolicy>> = { ...runtimes.policies };
      if (table['default'] !== undefined) {
        def = validateRuntimeId(table['default'], file, 'runtimes.default');
      }
      if (table['roles'] !== undefined) {
        roles = readRoleTable(table['roles'], file, 'runtimes.roles', validateRuntimeId);
      }
      for (const runtimeId of RUNTIME_IDS) {
        if (table[runtimeId] !== undefined) {
          policies[runtimeId] = readRuntimePolicy(
            table[runtimeId],
            file,
            `runtimes.${runtimeId}`,
          );
        }
      }
      runtimes = { default: def, roles, policies };
    }
    if (raw['models'] !== undefined) {
      const table = requireTable(raw['models'], file, 'models');
      for (const key of Object.keys(table)) {
        if (!['default', 'roles'].includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [models] (valid keys: default, roles)`,
            file,
            `models.${key}`,
          );
        }
      }
      let def = models.default;
      let roles = models.roles;
      if (table['default'] !== undefined) {
        // Empty allowed: an empty value means the same as the "default"
        // sentinel (runtime's own model) — kept for E1 config compatibility.
        def = requireString(table['default'], file, 'models.default', {
          allowEmpty: true,
        });
      }
      if (table['roles'] !== undefined) {
        roles = readRoleTable(table['roles'], file, 'models.roles', (v, f, field2) =>
          requireString(v, f, field2),
        );
      }
      models = { default: def, roles };
    }
    if (raw['thinking'] !== undefined) {
      const table = requireTable(raw['thinking'], file, 'thinking');
      for (const key of Object.keys(table)) {
        if (!['default', 'roles'].includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [thinking] (valid keys: default, roles)`,
            file,
            `thinking.${key}`,
          );
        }
      }
      let def = thinking.default;
      let roles = thinking.roles;
      if (table['default'] !== undefined) {
        // Empty allowed: same as the "default" sentinel (runtime's own level).
        def = requireString(table['default'], file, 'thinking.default', {
          allowEmpty: true,
        });
      }
      if (table['roles'] !== undefined) {
        roles = readRoleTable(table['roles'], file, 'thinking.roles', (v, f, field2) =>
          requireString(v, f, field2),
        );
      }
      thinking = { default: def, roles };
    }
    if (raw['supervision'] !== undefined) {
      const table = requireTable(raw['supervision'], file, 'supervision');
      const VALID = ['enabled', 'turn_silence_ms', 'restart_window_ms', 'max_restarts', 'restart_backoff_ms'];
      for (const key of Object.keys(table)) {
        if (!VALID.includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [supervision] (valid keys: ${VALID.join(', ')})`,
            file,
            `supervision.${key}`,
          );
        }
      }
      supervision = {
        enabled: table['enabled'] !== undefined ? requireBool(table['enabled'], file, 'supervision.enabled') : supervision.enabled,
        turnSilenceMs: table['turn_silence_ms'] !== undefined ? requirePositiveInt(table['turn_silence_ms'], file, 'supervision.turn_silence_ms') : supervision.turnSilenceMs,
        restartWindowMs: table['restart_window_ms'] !== undefined ? requirePositiveInt(table['restart_window_ms'], file, 'supervision.restart_window_ms') : supervision.restartWindowMs,
        maxRestarts: table['max_restarts'] !== undefined ? requirePositiveInt(table['max_restarts'], file, 'supervision.max_restarts') : supervision.maxRestarts,
        restartBackoffMs: table['restart_backoff_ms'] !== undefined ? requirePositiveInt(table['restart_backoff_ms'], file, 'supervision.restart_backoff_ms') : supervision.restartBackoffMs,
      };
    }
    if (raw['logging'] !== undefined) {
      const table = requireTable(raw['logging'], file, 'logging');
      for (const key of Object.keys(table)) {
        if (!['max_bytes', 'keep'].includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [logging] (valid keys: max_bytes, keep)`,
            file,
            `logging.${key}`,
          );
        }
      }
      logging = {
        maxBytes: table['max_bytes'] !== undefined ? requirePositiveInt(table['max_bytes'], file, 'logging.max_bytes') : logging.maxBytes,
        keep: table['keep'] !== undefined ? requirePositiveInt(table['keep'], file, 'logging.keep') : logging.keep,
      };
    }
    if (raw['chat'] !== undefined) {
      const table = requireTable(raw['chat'], file, 'chat');
      for (const key of Object.keys(table)) {
        if (!['frame_log_max_bytes', 'frame_log_keep'].includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [chat] (valid keys: frame_log_max_bytes, frame_log_keep)`,
            file,
            `chat.${key}`,
          );
        }
      }
      chat = {
        frameLogMaxBytes: table['frame_log_max_bytes'] !== undefined ? requirePositiveInt(table['frame_log_max_bytes'], file, 'chat.frame_log_max_bytes') : chat.frameLogMaxBytes,
        frameLogKeep: table['frame_log_keep'] !== undefined ? requirePositiveInt(table['frame_log_keep'], file, 'chat.frame_log_keep') : chat.frameLogKeep,
      };
    }
    if (raw['worktrees'] !== undefined) {
      const table = requireTable(raw['worktrees'], file, 'worktrees');
      for (const key of Object.keys(table)) {
        if (!['root', 'preserve_root', 'setup_timeout_ms'].includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [worktrees] (valid keys: root, preserve_root, setup_timeout_ms)`,
            file,
            `worktrees.${key}`,
          );
        }
      }
      worktrees = {
        root: table['root'] !== undefined ? expandTilde(requireString(table['root'], file, 'worktrees.root'), home) : '',
        preserveRoot: table['preserve_root'] !== undefined ? expandTilde(requireString(table['preserve_root'], file, 'worktrees.preserve_root'), home) : '',
        setupTimeoutMs: table['setup_timeout_ms'] !== undefined ? requirePositiveInt(table['setup_timeout_ms'], file, 'worktrees.setup_timeout_ms') : 120_000,
      };
    }
    if (raw['dispatch'] !== undefined) {
      const table = requireTable(raw['dispatch'], file, 'dispatch');
      for (const key of Object.keys(table)) {
        if (!['bob_interval_ms'].includes(key)) {
          throw new ConfigError(
            `unknown key \`${key}\` in [dispatch] (valid keys: bob_interval_ms)`,
            file,
            `dispatch.${key}`,
          );
        }
      }
      dispatch = {
        bobIntervalMs:
          table['bob_interval_ms'] !== undefined
            ? requireNonNegativeInt(table['bob_interval_ms'], file, 'dispatch.bob_interval_ms')
            : dispatch.bobIntervalMs,
      };
    }
  }

  for (const [label, dir] of [
    ['workspace_root', workspaceRoot],
    ['data_dir', dataDir],
  ] as const) {
    if (!isAbsolute(dir)) {
      throw new ConfigError(`${label} must resolve to an absolute path, got: ${dir}`, file, label);
    }
  }

  // SPEC ruling 7: instance state NEVER lives inside the workspace root.
  // A purely lexical check is bypassable by symlinks and case-insensitive
  // filesystems — compare the realpath pair too when both paths exist on
  // disk (fresh installs without the directories fall back to lexical).
  const insideLexically = isInsideOrEqual(workspaceRoot, dataDir);
  let insideReally = false;
  try {
    insideReally = isInsideOrEqual(realpathSync(workspaceRoot), realpathSync(dataDir));
  } catch {
    // one or both paths not on disk yet — lexical verdict stands
  }
  if (insideLexically || insideReally) {
    throw new ConfigError(
      `data_dir must not live inside workspace_root (workspace_root: ${workspaceRoot}, data_dir: ${dataDir}) — SPEC ruling 7`,
      file,
      'data_dir',
    );
  }

  return {
    workspaceRoot: resolve(workspaceRoot),
    dataDir: resolve(dataDir),
    server,
    auth,
    runtimes,
    models,
    thinking,
    supervision,
    logging,
    chat,
    worktrees: {
      root: resolve(worktrees !== null && worktrees.root !== '' ? worktrees.root : join(dataDir, 'worktrees')),
      preserveRoot: resolve(
        worktrees !== null && worktrees.preserveRoot !== '' ? worktrees.preserveRoot : join(dataDir, 'worktree-preserves'),
      ),
      setupTimeoutMs: worktrees?.setupTimeoutMs ?? 120_000,
    },
    dispatch,
    sourceFile,
    instanceDir,
  };
}

/**
 * Parse one [runtimes.<id>] policy table: optional model + thinking_level,
 * optional per-role inline tables { model?, thinking_level? } with at
 * least one field set (SPEC ruling 16).
 */
function readRuntimePolicy(
  value: unknown,
  file: string,
  field: string,
): RuntimeModelPolicy {
  const table = requireTable(value, file, field);
  for (const key of Object.keys(table)) {
    if (!['model', 'thinking_level', 'roles'].includes(key)) {
      throw new ConfigError(
        `unknown key \`${key}\` in [${field}] (valid keys: model, thinking_level, roles)`,
        file,
        `${field}.${key}`,
      );
    }
  }
  let model: string | undefined;
  let thinkingLevel: string | undefined;
  const roles: Partial<Record<Role, RuntimeRolePolicyEntry>> = {};
  if (table['model'] !== undefined) {
    model = requireString(table['model'], file, `${field}.model`);
  }
  if (table['thinking_level'] !== undefined) {
    thinkingLevel = requireString(table['thinking_level'], file, `${field}.thinking_level`);
  }
  if (table['roles'] !== undefined) {
    const rolesTable = requireTable(table['roles'], file, `${field}.roles`);
    for (const [roleKey, entry] of Object.entries(rolesTable)) {
      if (!(ROLES as readonly string[]).includes(roleKey)) {
        throw new ConfigError(
          `unknown role \`${roleKey}\` (valid roles: ${ROLES.join(', ')})`,
          file,
          `${field}.roles.${roleKey}`,
        );
      }
      const entryTable = requireTable(entry, file, `${field}.roles.${roleKey}`);
      let entryModel: string | undefined;
      let entryThinking: string | undefined;
      for (const entryKey of Object.keys(entryTable)) {
        if (!['model', 'thinking_level'].includes(entryKey)) {
          throw new ConfigError(
            `unknown key \`${entryKey}\` in [${field}.roles.${roleKey}] (valid keys: model, thinking_level)`,
            file,
            `${field}.roles.${roleKey}.${entryKey}`,
          );
        }
      }
      if (entryTable['model'] !== undefined) {
        entryModel = requireString(entryTable['model'], file, `${field}.roles.${roleKey}.model`);
      }
      if (entryTable['thinking_level'] !== undefined) {
        entryThinking = requireString(
          entryTable['thinking_level'],
          file,
          `${field}.roles.${roleKey}.thinking_level`,
        );
      }
      if (entryModel === undefined && entryThinking === undefined) {
        throw new ConfigError(
          `[${field}.roles.${roleKey}] must set at least one of model, thinking_level`,
          file,
          `${field}.roles.${roleKey}`,
        );
      }
      roles[roleKey as Role] = {
        ...(entryModel !== undefined ? { model: entryModel } : {}),
        ...(entryThinking !== undefined ? { thinkingLevel: entryThinking } : {}),
      };
    }
  }
  return {
    ...(model !== undefined ? { model } : {}),
    ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    roles,
  };
}
