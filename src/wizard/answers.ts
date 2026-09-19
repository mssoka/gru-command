import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { expandTilde, ROLES, RUNTIME_IDS, type Role, type RuntimeId } from '../config.js';

/**
 * Setup wizard answers (E9): the non-interactive contract. Every field is
 * optional in the JSON — unspecified means the documented default, so
 * `--answers '{}'` completes a fully headless run. Validation is
 * FAIL-LOUD and happens entirely BEFORE any file is written: an invalid
 * answer (relative path, unknown runtime/role, bad port) aborts with
 * nothing written.
 */

export interface WizardAnswers {
  /** Raw workspace-root string as answered (`~`-form preserved in output). */
  readonly workspaceRoot: string;
  /** Managed-repo names picked under the workspace root (informational —
   * the config schema has no repos key; the board discovers repos live). */
  readonly repos: readonly string[];
  readonly runtime: RuntimeId;
  /** Model reference; "default" = the runtime's own (SPEC ruling 16). */
  readonly model: string;
  /** Thinking level; "default" = the runtime's own. */
  readonly thinkingLevel: string;
  /** Optional per-role runtime overrides (runtimes.roles). */
  readonly roles: Readonly<Partial<Record<Role, RuntimeId>>>;
  readonly host: string;
  readonly port: number;
  readonly token: string;
  readonly registerService: boolean;
  readonly smoke: boolean;
}

/** Error class for answers validation — message is the whole UX. */
export class AnswersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnswersError';
  }
}

const ANSWER_KEYS = [
  'workspace_root',
  'repos',
  'runtime',
  'model',
  'thinking_level',
  'roles',
  'host',
  'port',
  'token',
  'register_service',
  'smoke',
] as const;

export const DEFAULT_WORKSPACE_ROOT = '~/code';
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 7665;

/** Random pairing token (URL-safe, no ambiguous padding). */
export function generateToken(): string {
  return randomBytes(24).toString('base64url');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string, opts: { allowEmpty?: boolean } = {}): string {
  if (typeof value !== 'string') {
    throw new AnswersError(`answers.${field} must be a string, got ${typeof value}`);
  }
  if (!opts.allowEmpty && value.trim() === '') {
    throw new AnswersError(`answers.${field} must not be empty`);
  }
  return value;
}

/**
 * Validate a workspace-root answer: `~`-prefixed or absolute (after `~`
 * expansion it must resolve absolute — SPEC rulings 6/7; a relative path
 * is always a mistake, never a default).
 */
export function validateWorkspaceRoot(value: string): string {
  const expanded = expandTilde(value);
  if (!isAbsolute(expanded)) {
    throw new AnswersError(
      `workspace_root must be an absolute path (or start with ~) — got: ${value}`,
    );
  }
  return value;
}

/**
 * Parse and validate the `--answers` JSON against the wizard contract.
 * Throws {@link AnswersError} with a field-naming message on any
 * violation; performs no writes and no prompts.
 */
export function parseAnswers(json: string, home: string = homedir()): WizardAnswers {
  let raw: unknown;
  try {
    raw = JSON.parse(json) as unknown;
  } catch (error) {
    throw new AnswersError(`--answers is not valid JSON: ${(error as Error).message}`);
  }
  if (!isPlainObject(raw)) {
    throw new AnswersError('--answers must be a JSON object');
  }
  for (const key of Object.keys(raw)) {
    if (!(ANSWER_KEYS as readonly string[]).includes(key)) {
      throw new AnswersError(
        `unknown answers key \`${key}\` (valid keys: ${ANSWER_KEYS.join(', ')})`,
      );
    }
  }

  const workspaceRoot =
    raw['workspace_root'] !== undefined
      ? validateWorkspaceRoot(requireString(raw['workspace_root'], 'workspace_root'))
      : DEFAULT_WORKSPACE_ROOT;

  let repos: string[] = [];
  if (raw['repos'] !== undefined) {
    if (!Array.isArray(raw['repos'])) {
      throw new AnswersError('answers.repos must be an array of repo names');
    }
    repos = raw['repos'].map((name) => {
      if (typeof name !== 'string' || name.trim() === '') {
        throw new AnswersError('answers.repos entries must be non-empty strings');
      }
      if (name.includes('/') || name === '.' || name === '..' || name.startsWith('.')) {
        throw new AnswersError(
          `answers.repos entries must be plain directory names under the workspace root — got: ${name}`,
        );
      }
      return name;
    });
    const workspaceAbs = expandTilde(workspaceRoot, home);
    for (const name of repos) {
      const repoDir = join(workspaceAbs, name);
      if (!existsSync(join(repoDir, '.git'))) {
        throw new AnswersError(
          `answers.repos names a directory that is not a git repo under the workspace root: ${repoDir} (missing .git)`,
        );
      }
    }
  }

  let runtime: RuntimeId = 'pi';
  if (raw['runtime'] !== undefined) {
    const id = requireString(raw['runtime'], 'runtime');
    if (!(RUNTIME_IDS as readonly string[]).includes(id)) {
      throw new AnswersError(
        `unknown runtime \`${id}\` in answers.runtime (valid runtimes: ${RUNTIME_IDS.join(', ')})`,
      );
    }
    runtime = id as RuntimeId;
  }

  const model =
    raw['model'] !== undefined ? requireString(raw['model'], 'model') : 'default';
  const thinkingLevel =
    raw['thinking_level'] !== undefined
      ? requireString(raw['thinking_level'], 'thinking_level')
      : 'default';

  let roles: Partial<Record<Role, RuntimeId>> = {};
  if (raw['roles'] !== undefined) {
    if (!isPlainObject(raw['roles'])) {
      throw new AnswersError('answers.roles must be an object of role → runtime id');
    }
    for (const [role, value] of Object.entries(raw['roles'])) {
      if (!(ROLES as readonly string[]).includes(role)) {
        throw new AnswersError(
          `unknown role \`${role}\` in answers.roles (valid roles: ${ROLES.join(', ')})`,
        );
      }
      const id = requireString(value, `roles.${role}`);
      if (!(RUNTIME_IDS as readonly string[]).includes(id)) {
        throw new AnswersError(
          `unknown runtime \`${id}\` in answers.roles.${role} (valid runtimes: ${RUNTIME_IDS.join(', ')})`,
        );
      }
      roles = { ...roles, [role]: id as RuntimeId };
    }
  }

  const host = raw['host'] !== undefined ? requireString(raw['host'], 'host') : DEFAULT_HOST;

  let port = DEFAULT_PORT;
  if (raw['port'] !== undefined) {
    const p = raw['port'];
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > 65535) {
      throw new AnswersError(
        `answers.port must be an integer between 0 and 65535, got: ${JSON.stringify(p)}`,
      );
    }
    port = p;
  }

  const token =
    raw['token'] !== undefined ? requireString(raw['token'], 'token') : generateToken();

  for (const [field, value] of [
    ['register_service', raw['register_service']],
    ['smoke', raw['smoke']],
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new AnswersError(`answers.${field} must be a boolean, got ${typeof value}`);
    }
  }

  return {
    workspaceRoot,
    repos,
    runtime,
    model,
    thinkingLevel,
    roles,
    host,
    port,
    token,
    registerService: raw['register_service'] === true,
    smoke: raw['smoke'] !== false,
  };
}
