import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { homedir } from 'node:os';
import { expandTilde, ROLES } from '../config.js';
import type { WizardAnswers } from './answers.js';

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

/** Escape a string for a TOML basic string literal. */
export function tomlString(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '\\': out += '\\\\'; break;
      case '"': out += '\\"'; break;
      case '\b': out += '\\b'; break;
      case '\t': out += '\\t'; break;
      case '\n': out += '\\n'; break;
      case '\f': out += '\\f'; break;
      case '\r': out += '\\r'; break;
      default:
        if (ch < ' ' || ch === '\u007f') {
          out += `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
        } else {
          out += ch;
        }
    }
  }
  return `"${out}"`;
}

/**
 * Generate the instance `config.toml` — EXACTLY the documented schema
 * (docs/CONFIG.md); no invented keys, no omitted required semantics. The
 * model/thinking defaults ride the "default" sentinel (SPEC ruling 16:
 * the product never hardcodes a model).
 */
export function generateConfigToml(answers: WizardAnswers, instanceDir: string): string {
  const lines: string[] = [
    '# Gru Command configuration — written by the setup wizard.',
    '# Schema reference: docs/CONFIG.md (validation is fail-loud at boot).',
    '',
    `workspace_root = ${tomlString(answers.workspaceRoot)}`,
    `data_dir = ${tomlString(instanceDir)}`,
    '',
    '[server]',
    `host = ${tomlString(answers.host)}`,
    `port = ${answers.port}`,
    '',
    '[auth]',
    `token = ${tomlString(answers.token)}`,
    '',
    '[runtimes]',
    `default = ${tomlString(answers.runtime)}`,
  ];
  if (Object.keys(answers.roles).length > 0) {
    lines.push('', '[runtimes.roles]');
    for (const role of ROLES) {
      const runtime = answers.roles[role];
      if (runtime !== undefined) lines.push(`${role} = ${tomlString(runtime)}`);
    }
  }
  lines.push(
    '',
    '[models]',
    `default = ${tomlString(answers.model)}`,
    '',
    '[thinking]',
    `default = ${tomlString(answers.thinkingLevel)}`,
    '',
  );
  return lines.join('\n');
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
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export interface ConfigWriteResult {
  readonly configPath: string;
  /** Path of the timestamped backup when a previous config existed. */
  readonly backupPath: string | null;
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
export function writeInstanceConfig(
  instanceDir: string,
  answers: WizardAnswers,
  home: string = homedir(),
): ConfigWriteResult {
  // Cross-check the answers one more time against the workspace-root rule
  // (a relative path must never reach a generated file).
  const workspaceAbs = expandTilde(answers.workspaceRoot, home);
  if (!workspaceAbs.startsWith('/') ) {
    throw new Error(`workspace_root must resolve to an absolute path, got: ${answers.workspaceRoot}`);
  }

  const text = generateConfigToml(answers, instanceDir);
  try {
    parse(text); // self-check: escaping bugs fail here, not at first boot
  } catch (error) {
    throw new Error(`generated config failed its TOML self-check: ${(error as Error).message}`);
  }

  mkdirSync(instanceDir, { recursive: true });
  const configPath = join(instanceDir, 'config.toml');
  let backupPath: string | null = null;
  if (existsSync(configPath)) {
    backupPath = `${configPath}.backup-${backupTimestamp()}`;
    copyFileSync(configPath, backupPath); // throws → abort BEFORE the write
  }
  const tmpPath = `${configPath}.tmp`;
  try {
    writeFileSync(tmpPath, text, 'utf-8');
    renameSync(tmpPath, configPath); // atomic: never a half-written config
  } catch (error) {
    rmSync(tmpPath, { force: true });
    throw new Error(
      `failed to write ${configPath} atomically: ${(error as Error).message}` +
        (backupPath !== null ? ` — the previous config is intact and backed up at ${backupPath}` : ''),
    );
  }
  return { configPath, backupPath };
}
