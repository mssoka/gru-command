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

export interface GruCommandConfig {
  readonly workspaceRoot: string;
  readonly dataDir: string;
  readonly server: ServerConfig;
  readonly auth: AuthConfig;
  readonly runtimes: RuntimesConfig;
  readonly models: ModelsConfig;
  readonly thinking: ThinkingConfig;
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
