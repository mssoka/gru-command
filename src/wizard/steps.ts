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
import { expandTilde } from '../config.js';
import { renderCompleteConfig, tomlString } from '../config-template.js';
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

/** Render the same complete configuration used by config-generate. */
export function generateConfigToml(options: {
  readonly answers: WizardAnswers;
  readonly instanceDir: string;
  readonly repoRoot: string;
  readonly decisionsCliPath?: string;
}): string {
  const { answers } = options;
  return renderCompleteConfig(
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
      jevEnabled: answers.jevEnabled,
    },
    { repoRoot: options.repoRoot, cliPath: options.decisionsCliPath },
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
    if (options.force === true) {
      if (originalIdentity === null || identity() !== originalIdentity) {
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

export function writeInstanceConfig(options: {
  readonly instanceDir: string;
  readonly answers: WizardAnswers;
  readonly repoRoot: string;
  readonly home?: string;
  readonly force?: boolean;
  readonly decisionsCliPath?: string;
}): ConfigWriteResult {
  const home = options.home ?? homedir();
  const workspaceAbs = expandTilde(options.answers.workspaceRoot, home);
  if (!workspaceAbs.startsWith('/')) {
    throw new Error(
      `workspace_root must resolve to an absolute path, got: ${options.answers.workspaceRoot}`,
    );
  }
  const text = generateConfigToml(options);
  return writeConfigText(options.instanceDir, text, { force: options.force });
}
