import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
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

const AUTH_ENV = /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|CUSTOM_HEADERS|VERTEX_PROJECT_ID|FOUNDRY_RESOURCE|FOUNDRY_BASE_URL|MODEL|DEFAULT_(?:OPUS|SONNET|HAIKU)_MODEL)|CLAUDE_CODE_USE_(?:BEDROCK|VERTEX|FOUNDRY)|AWS_[A-Z0-9_]+|GOOGLE_[A-Z0-9_]+|CLOUD_ML_REGION)$/u;

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
