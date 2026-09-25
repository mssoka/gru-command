import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Role } from '../config.js';

/** Only model selection and credential/provider environment are permitted
 * from the user's Claude settings. Never load repo settings, tools, hooks,
 * plugins, or arbitrary env into an isolated review turn. */
interface ReviewSettings {
  readonly model?: string;
  readonly apiKeyHelper?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface ClaudeReviewConfiguration {
  /** Explicit product model, or the native default sentinel. */
  readonly modelRef: string;
  readonly settings: ReviewSettings;
  /** Provider/model environment captured once at preflight, not re-read per turn. */
  readonly authEnv: Readonly<Record<string, string>>;
}

/** Request-owned proof returned by preflight; no shared per-role cache. */
export interface ClaudeReviewSnapshot extends ClaudeReviewConfiguration {
  readonly role: Role;
}

const AUTH_ENV = /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|CUSTOM_HEADERS|VERTEX_PROJECT_ID|FOUNDRY_RESOURCE|FOUNDRY_BASE_URL|MODEL|DEFAULT_(?:OPUS|SONNET|HAIKU)_MODEL)|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY)|AWS_[A-Z0-9_]+|GOOGLE_[A-Z0-9_]+|CLOUD_ML_REGION)$/u;

export function userClaudeSettingsFile(): string {
  return join(process.env['CLAUDE_CONFIG_DIR'] ?? join(homedir(), '.claude'), 'settings.json');
}

export function resolveClaudeReviewConfiguration(modelRef: string, file: string): ClaudeReviewConfiguration {
  let source: unknown;
  try {
    source = JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { modelRef, settings: {}, authEnv: capturedAuthEnv({}) };
    }
    // JSON syntax errors can quote credential bytes from the malformed file.
    if (error instanceof SyntaxError) throw new Error(`malformed Claude review model/auth settings JSON at ${file}`);
    throw new Error(`cannot read Claude review model/auth settings at ${file}: ${String(error)}`);
  }
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new Error(`Claude review model/auth settings at ${file} must be an object`);
  }
  const data = source as Record<string, unknown>;
  const model = data['model'];
  if (model !== undefined && (typeof model !== 'string' || model.trim() === '')) {
    throw new Error(`Claude review model in ${file} must be a non-empty string`);
  }
  const helper = data['apiKeyHelper'];
  if (helper !== undefined && (typeof helper !== 'string' || helper.trim() === '')) {
    throw new Error(`Claude review apiKeyHelper in ${file} must be a non-empty string`);
  }
  const rawEnv = data['env'];
  if (rawEnv !== undefined && (typeof rawEnv !== 'object' || rawEnv === null || Array.isArray(rawEnv))) {
    throw new Error(`Claude review env in ${file} must be an object`);
  }
  const env = Object.fromEntries(Object.entries((rawEnv ?? {}) as Record<string, unknown>)
    .filter(([name]) => AUTH_ENV.test(name))
    .map(([name, value]) => {
      if (typeof value !== 'string') throw new Error(`Claude review env ${name} in ${file} must be a string`);
      return [name, value];
    }));
  return {
    modelRef,
    settings: {
      // Native CLI precedence is --model > environment > settings model >
      // built-in default. Never manufacture --model from settings: it would
      // override ANTHROPIC_MODEL, and strip a native slash-containing ID.
      ...((modelRef === '' || modelRef === 'default') && typeof model === 'string' ? { model } : {}),
      ...(typeof helper === 'string' ? { apiKeyHelper: helper } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    },
    authEnv: capturedAuthEnv(env),
  };
}

/** Resolve a user-owned helper once, outside the frozen review tree. Only its
 * credential (not an executable setting) crosses the preflight/turn boundary.
 * A request snapshot retains this value even if the user's settings rotate. */
export function materializeClaudeReviewCredentials(
  configuration: ClaudeReviewConfiguration, settingsFile: string,
): ClaudeReviewConfiguration {
  const { apiKeyHelper, ...safeSettings } = configuration.settings;
  if (apiKeyHelper === undefined) return configuration;
  // The settings source is user-controlled, never the review cwd. Resolve
  // symlinks before starting the helper so a relative command cannot pick up
  // a same-named executable checked into the reviewed branch.
  const cwd = realpathSync(dirname(settingsFile));
  const result = spawnSync(apiKeyHelper, {
    shell: true, cwd, encoding: 'utf8', timeout: 30_000, maxBuffer: 8_192,
    env: claudeReviewProcessEnv(configuration), windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0 || result.stdout.trim() === '') {
    // Neither stderr nor error text may include the helper's credential.
    throw new Error(`Claude review apiKeyHelper from ${settingsFile} failed in the user settings directory`);
  }
  const { ANTHROPIC_API_KEY: _settingsKey, ...settingsEnv } = safeSettings.env ?? {};
  return {
    ...configuration,
    settings: {
      ...safeSettings,
      ...(safeSettings.env !== undefined ? { env: settingsEnv } : {}),
    },
    authEnv: { ...configuration.authEnv, ANTHROPIC_API_KEY: result.stdout.trim() },
  };
}

function capturedAuthEnv(settingsEnv: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const inherited = Object.fromEntries(Object.entries(process.env)
    .flatMap(([name, value]): [string, string][] => AUTH_ENV.test(name) && value !== undefined
      ? [[name, value]] : []));
  return { ...inherited, ...settingsEnv };
}

/** Do not let a later process.env edit switch this review's model/provider. */
export function claudeReviewProcessEnv(configuration: ClaudeReviewConfiguration): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (AUTH_ENV.test(name)) delete env[name];
  }
  return { ...env, ...configuration.authEnv };
}

/** Do not put credentials on argv. Claude --settings accepts a path; keep
 * this minimal JSON private and delete it after the probe/handle settles. */
export function privateClaudeReviewSettings(settings: ReviewSettings): { readonly file?: string; readonly dispose: () => void } {
  if (settings.model === undefined && settings.apiKeyHelper === undefined && settings.env === undefined) return { dispose: () => {} };
  const dir = mkdtempSync(join(tmpdir(), 'gru-claude-review-'));
  const file = join(dir, 'settings.json');
  try {
    writeFileSync(file, JSON.stringify(settings), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return { file, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}
