import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { homedir } from 'node:os';
import { configPathFor, expandTilde, type GruCommandConfig, loadConfig } from '../config.js';
import {
  renderReferenceConfig,
  tomlString,
} from '../config-reference.js';
import type { WizardAnswers } from './answers.js';

export { tomlString };

/**
 * Wizard steps (E9): the pure, testable half of the setup wizard —
 * managed-repo discovery, schema-exact config generation, the pairing
 * QR payload, and backup-first config writing. `main.ts` owns prompts,
 * service registration, and the first-boot smoke.
 */

/**
 * Scan the workspace root (ruling 6) for managed repos: depth-1 entries
 * carrying a `.git` (directory OR worktree-pointer file). Dot-directories
 * are skipped; symlinked repo directories count (statSync follows the
 * link — a symlink to a repo is a managed repo); the result is sorted
 * for stable display.
 */
export function discoverManagedRepos(workspaceRoot: string): string[] {
  let entries;
  try {
    entries = readdirSync(workspaceRoot, { withFileTypes: true });
  } catch {
    return []; // missing/unreadable workspace root: no repos yet, not an error
  }
  return entries
    .filter((entry) => {
      if (entry.name.startsWith('.')) return false;
      if (entry.isDirectory()) return true;
      if (!entry.isSymbolicLink()) return false;
      try {
        return statSync(join(workspaceRoot, entry.name)).isDirectory();
      } catch {
        return false; // broken symlink — skip
      }
    })
    .filter((entry) => existsSync(join(workspaceRoot, entry.name, '.git')))
    .map((entry) => entry.name)
    .sort();
}

/** Render the same complete configuration used by config-generate. When
 * `prior` (the previously loaded config) is given, user-set values outside
 * the wizard's prompts are preserved into the rendered text. */
export function generateConfigToml(options: {
  readonly answers: WizardAnswers;
  readonly instanceDir: string;
  readonly prior?: GruCommandConfig | null;
}): string {
  const { answers } = options;
  return renderReferenceConfig(
    {
      instanceDir: options.instanceDir,
      workspaceRoot: answers.workspaceRoot,
      host: answers.host,
      port: answers.port,
      token: answers.token,
      runtime: answers.runtime,
      model: answers.model,
      thinkingLevel: answers.thinkingLevel,
      roles: answers.roles,
    },
    options.prior ?? null,
  );
}

/**
 * Pairing QR payload — byte-identical in shape to the web pairing screen
 * (`web/src/ui/pairing.ts`): `{"gru-command":1,"url":…,"token":…}`. Key
 * order is load-bearing (JSON.stringify preserves insertion order); keep
 * the two constructions in lockstep.
 */
export function buildQrPayload(url: string, token: string): string {
  return JSON.stringify({ 'gru-command': 1, url, token });
}

/** Filesystem-safe ISO timestamp for backup names (no colons, compact). */
export function backupTimestamp(now: Date = new Date()): string {
  // Millisecond precision: second-resolution names clobber on same-second
  // reruns (Perkins r2 note) — two backups within one second must both live.
  return now.toISOString().replace(/[-:]/g, '').replace('.', '');
}

export interface ConfigWriteResult {
  readonly configPath: string;
  /** Path of the timestamped backup when a previous config existed. */
  readonly backupPath: string | null;
}

export interface ConfigWriteOptions {
  readonly force?: boolean;
  readonly now?: Date;
}

/**
 * Write the instance config with the backup-first contract: an existing
 * `config.toml` is copied to `config.toml.backup-<timestamp>` BEFORE the
 * rewrite, and a backup failure aborts with the original untouched —
 * never a silent clobber. The new content lands via write-tmp + ATOMIC
 * rename, so a mid-write failure (ENOSPC) can never truncate a valid
 * config: either the old file stands or the new one is complete. The
 * generated TOML is parse-self-checked before anything touches disk.
 */
export function writeConfigText(
  instanceDir: string,
  text: string,
  options: ConfigWriteOptions = {},
): ConfigWriteResult {
  try {
    parse(text); // self-check: escaping/schema-fragment syntax fails before disk mutation
  } catch (error) {
    throw new Error(`generated config failed its TOML self-check: ${(error as Error).message}`);
  }

  mkdirSync(instanceDir, { recursive: true, mode: 0o700 });
  const configPath = join(instanceDir, 'config.toml');
  let backupPath: string | null = null;
  /** Identity of the PREVIOUS config — null when none existed (fresh dir),
   * in which case there is nothing to anti-clobber. */
  let originalIdentity: string | null = null;
  const identity = (): string => {
    const info = statSync(configPath);
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  };
  if (existsSync(configPath)) {
    if (options.force !== true) {
      throw new Error(`refusing to overwrite existing ${configPath} without --force`);
    }
    const stem = `${configPath}.backup-${backupTimestamp(options.now)}`;
    originalIdentity = identity();
    const previous = readFileSync(configPath);
    if (identity() !== originalIdentity) {
      throw new Error(`config changed while preparing backup: ${configPath}; no replacement was attempted`);
    }
    for (let suffix = 0; ; suffix += 1) {
      const candidate = suffix === 0 ? stem : `${stem}-${suffix}`;
      try {
        writeFileSync(candidate, previous, { mode: 0o600, flag: 'wx' });
        chmodSync(candidate, 0o600);
        backupPath = candidate;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        rmSync(candidate, { force: true });
        throw error;
      }
    }
  }
  const tmpPath = `${configPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmpPath, text, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    if (originalIdentity !== null) {
      // Anti-clobber applies only when a previous config actually existed:
      // --force on a FRESH instance dir has nothing to protect and must
      // simply publish (it used to throw "config changed after backup"
      // deterministically because the identity was never captured).
      if (identity() !== originalIdentity) {
        throw new Error(
          `config changed after backup: ${configPath}; refusing to overwrite the newer file`,
        );
      }
      renameSync(tmpPath, configPath);
    } else {
      // A hard link publishes the completed same-directory temp file only
      // if config.toml is still absent. Concurrent no-force writers cannot
      // replace one another between the earlier check and this operation.
      linkSync(tmpPath, configPath);
      unlinkSync(tmpPath);
    }
    chmodSync(configPath, 0o600);
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw new Error(
      `failed to write ${configPath} atomically: ${(error as Error).message}` +
        (backupPath !== null ? ` — the previous config is intact and backed up at ${backupPath}` : ''),
    );
  }
  return { configPath, backupPath };
}

/**
 * Load the existing instance config for a re-run. Returns null when no
 * config file exists; a present-but-invalid config throws (ConfigError)
 * so a re-run can never silently drop or misread user configuration.
 */
export function loadExistingInstanceConfig(instanceDir: string): GruCommandConfig | null {
  if (!existsSync(configPathFor(instanceDir))) return null;
  return loadConfig({ GRU_COMMAND_HOME: instanceDir });
}

/** Documented prompt defaults — a field still at these values on a re-run
 * adopts the existing config's value instead (existing values are the
 * prompt defaults; explicit answers and non-default picks always win). */
const PROMPT_DEFAULTS = {
  workspaceRoot: '~/code',
  runtime: 'pi' as const,
  model: 'default',
  thinkingLevel: 'default',
  host: '127.0.0.1',
  port: 7665,
  token: '',
};

/**
 * Round-trip seeding: unspecified/at-default prompted fields adopt the
 * existing config's value, so a re-run keeps the operator's workspace,
 * bind host/port, runtime, model/thinking, and pairing token unless they
 * explicitly choose otherwise. `explicit` carries the raw --answers JSON
 * key names the operator actually provided — an explicit value ALWAYS
 * wins over the prior config ("token" is checked by name because the
 * unspecified default is a fresh random generation, not a sentinel).
 * Sections the wizard never prompts for are preserved separately
 * (renderReferenceConfig `preserved`).
 */
export function seedAnswersFromConfig(
  answers: WizardAnswers,
  prior: GruCommandConfig | null,
  explicit: ReadonlySet<string> = new Set(),
): WizardAnswers {
  if (prior === null) return answers;
  const priorModel = prior.models.default === '' ? 'default' : prior.models.default;
  const priorThinking = prior.thinking.default === '' ? 'default' : prior.thinking.default;
  return {
    ...answers,
    workspaceRoot:
      !explicit.has('workspace_root') && answers.workspaceRoot === PROMPT_DEFAULTS.workspaceRoot
        ? prior.workspaceRoot
        : answers.workspaceRoot,
    runtime:
      !explicit.has('runtime') && answers.runtime === PROMPT_DEFAULTS.runtime
        ? prior.runtimes.default
        : answers.runtime,
    model: !explicit.has('model') && answers.model === PROMPT_DEFAULTS.model ? priorModel : answers.model,
    thinkingLevel:
      !explicit.has('thinking_level') && answers.thinkingLevel === PROMPT_DEFAULTS.thinkingLevel
        ? priorThinking
        : answers.thinkingLevel,
    host: !explicit.has('host') && answers.host === PROMPT_DEFAULTS.host ? prior.server.host : answers.host,
    port: !explicit.has('port') && answers.port === PROMPT_DEFAULTS.port ? prior.server.port : answers.port,
    token:
      !explicit.has('token') && prior.auth.token !== '' ? prior.auth.token : answers.token,
  };
}

/**
 * Write the instance config with the backup-first contract. The existing
 * config (when any) is loaded and schema-validated FIRST — a malformed
 * config fails loud before anything is written — and its values seed the
 * answers and ride along as `preserved` so a re-run never silently drops
 * user-set values or hand-tuned sections.
 */
export function writeInstanceConfig(options: {
  readonly instanceDir: string;
  readonly answers: WizardAnswers;
  readonly home?: string;
  readonly force?: boolean;
  readonly prior?: GruCommandConfig | null;
  /** Raw --answers JSON keys the caller explicitly provided. */
  readonly explicitKeys?: ReadonlySet<string>;
}): ConfigWriteResult {
  const prior = options.prior !== undefined ? options.prior : loadExistingInstanceConfig(options.instanceDir);
  const seeded = seedAnswersFromConfig(options.answers, prior, options.explicitKeys);
  const home = options.home ?? homedir();
  const workspaceAbs = expandTilde(seeded.workspaceRoot, home);
  if (!workspaceAbs.startsWith('/')) {
    throw new Error(
      `workspace_root must resolve to an absolute path, got: ${seeded.workspaceRoot}`,
    );
  }
  const text = generateConfigToml({ answers: seeded, instanceDir: options.instanceDir, prior });
  return writeConfigText(options.instanceDir, text, { force: options.force });
}
