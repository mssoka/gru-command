import { existsSync, readFileSync, symlinkSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { parse } from 'smol-toml';
import type { LogLevel } from '../logger.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Bootstrap manifest (SPEC ruling 18a): each project repo declares its
 * fresh-worktree needs in-repo at `<repo>/.gru-command/worktree.toml` —
 * what to link, what to copy, which one-time setup commands to run. The
 * file travels with the repo (extends ruling 17: project knowledge lives
 * in the project), auto-applied by the worktree manager at creation.
 *
 * Schema (all arrays optional, all entries validated fail-loud):
 *
 *   [[link]]                 # symlink created IN the worktree
 *   at   = "_bmad"           #   path inside the fresh worktree (relative, no ..)
 *   to   = "_bmad"           #   target: repo-root-relative (.. allowed) or absolute
 *
 *   [[copy]]                 # file copied FROM the source checkout
 *   from = ".env.local"      #   repo-root-relative (no ..)
 *   to   = ".env.local"      #   worktree-relative (no ..)
 *
 *   [[setup]]                # one-time command, run with cwd = the worktree
 *   command = "npm install"
 *
 *   [verify]                 # the project's verification commands, by scope;
 *   full = "npm test"        #   POST /api/verify runs these under the global
 *   quick = "npm run lint"   #   test budget (see docs/FLOW.md)
 */

export const MANIFEST_DIR = '.gru-command';
export const MANIFEST_FILE = 'worktree.toml';
export const MANIFEST_PATH = join(MANIFEST_DIR, MANIFEST_FILE);

export interface ManifestLink {
  readonly at: string;
  readonly to: string;
}

export interface ManifestCopy {
  readonly from: string;
  readonly to: string;
}

export interface ManifestSetup {
  readonly command: string;
}

/**
 * Declared verification commands, keyed by scope. The scope `full` is the
 * default a verify request resolves to; any other names are project-chosen.
 * These commands are NOT run at worktree bootstrap — the verification
 * scheduler runs them on request, under the global machine budget.
 */
export type ManifestVerify = Readonly<Record<string, string>>;

export interface WorktreeManifest {
  readonly links: readonly ManifestLink[];
  readonly copies: readonly ManifestCopy[];
  readonly setup: readonly ManifestSetup[];
  readonly verify: ManifestVerify;
}

/** A path that must stay inside the given root — resolve + containment. */
function insidePath(root: string, value: string, label: string): string {
  const resolved = resolve(root, value);
  const rel = relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`manifest ${label} escapes its root: "${value}" (resolved: ${resolved})`);
  }
  return resolved;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`manifest ${label} must be a non-empty string, got: ${String(value)}`);
  }
  return value.trim();
}

/** Segments that would climb out of the tree they are resolved against. */
function escapesTree(value: string): boolean {
  return value.split(/[\\/]/).includes('..');
}

/** Parse + validate manifest TOML text. Any deviation fails loud. */
export function parseWorktreeManifest(text: string, source = MANIFEST_PATH): WorktreeManifest {
  let raw: Record<string, unknown>;
  try {
    raw = parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`worktree manifest ${source} is not valid TOML: ${String(error)}`);
  }
  for (const key of Object.keys(raw)) {
    if (!['link', 'copy', 'setup', 'verify'].includes(key)) {
      throw new Error(`worktree manifest ${source} has unknown key "${key}" (valid: link, copy, setup, verify)`);
    }
  }

  const links: ManifestLink[] = [];
  const rawLinks = raw['link'] ?? [];
  if (!Array.isArray(rawLinks)) throw new Error(`worktree manifest ${source}: [[link]] must be an array of tables`);
  for (const [index, entry] of rawLinks.entries()) {
    const table = entry as Record<string, unknown>;
    const at = nonEmptyString(table['at'], `${source} link[${index}].at`);
    const to = nonEmptyString(table['to'], `${source} link[${index}].to`);
    if (isAbsolute(at)) throw new Error(`worktree manifest ${source} link[${index}].at must be relative (inside the worktree)`);
    if (escapesTree(at)) throw new Error(`worktree manifest ${source} link[${index}].at must stay inside the worktree (no ..): ${at}`);
    links.push({ at, to });
  }

  const copies: ManifestCopy[] = [];
  const rawCopies = raw['copy'] ?? [];
  if (!Array.isArray(rawCopies)) throw new Error(`worktree manifest ${source}: [[copy]] must be an array of tables`);
  for (const [index, entry] of rawCopies.entries()) {
    const table = entry as Record<string, unknown>;
    const from = nonEmptyString(table['from'], `${source} copy[${index}].from`);
    const to = nonEmptyString(table['to'], `${source} copy[${index}].to`);
    if (isAbsolute(from) || isAbsolute(to)) {
      throw new Error(`worktree manifest ${source} copy[${index}] paths must be relative (copies stay inside the repo)`);
    }
    if (escapesTree(from) || escapesTree(to)) {
      throw new Error(`worktree manifest ${source} copy[${index}] paths must stay inside the repo (no ..)`);
    }
    copies.push({ from, to });
  }

  const setup: ManifestSetup[] = [];
  const rawSetup = raw['setup'] ?? [];
  if (!Array.isArray(rawSetup)) throw new Error(`worktree manifest ${source}: [[setup]] must be an array of tables`);
  for (const [index, entry] of rawSetup.entries()) {
    const table = entry as Record<string, unknown>;
    const command = nonEmptyString(table['command'], `${source} setup[${index}].command`);
    setup.push({ command });
  }

  const verifyEntries: Record<string, string> = {};
  const rawVerify = raw['verify'];
  if (rawVerify !== undefined) {
    if (typeof rawVerify !== 'object' || rawVerify === null || Array.isArray(rawVerify)) {
      throw new Error(`worktree manifest ${source}: [verify] must be a table of scope = command strings`);
    }
    for (const [scope, command] of Object.entries(rawVerify as Record<string, unknown>)) {
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(scope)) {
        throw new Error(
          `worktree manifest ${source} [verify] scope "${scope}" must be a lowercase identifier (a-z, 0-9, _, -, ≤32 chars)`,
        );
      }
      verifyEntries[scope] = nonEmptyString(command, `${source} verify.${scope}`);
    }
  }

  return { links, copies, setup, verify: verifyEntries };
}

/**
 * Resolve one declared verify command by scope. Fail-loud: an undeclared
 * scope names every scope the project DID declare, so the caller can fix
 * its request without guessing.
 */
export function resolveVerifyCommand(manifest: WorktreeManifest, scope: string): string {
  const command = manifest.verify[scope];
  if (command === undefined) {
    const declared = Object.keys(manifest.verify).sort();
    throw new Error(
      `verify scope "${scope}" is not declared in ${MANIFEST_PATH} ` +
        `(declared scopes: ${declared.length === 0 ? 'none' : declared.join(', ')})`,
    );
  }
  return command;
}

/**
 * Load the manifest for a repo checkout. A missing manifest is a no-op
 * (repos opt out silently — the tree just gets no bootstrap); a present
 * but malformed manifest fails loud (a broken bootstrap must never be
 * half-applied silently).
 */
export function loadWorktreeManifest(
  repoPath: string,
  log: Log = () => {},
): WorktreeManifest | null {
  const file = join(repoPath, MANIFEST_PATH);
  if (!existsSync(file)) {
    log('info', 'no worktree bootstrap manifest — proceeding without one', { repo: repoPath });
    return null;
  }
  let text: string;
  try {
    text = readFileSync(file, 'utf-8');
  } catch (error) {
    throw new Error(`worktree manifest ${file} is unreadable: ${String(error)}`);
  }
  const manifest = parseWorktreeManifest(text, file);
  log('info', 'worktree bootstrap manifest loaded', {
    repo: repoPath,
    links: manifest.links.length,
    copies: manifest.copies.length,
    setup: manifest.setup.length,
  });
  return manifest;
}

export interface ApplyManifestOptions {
  /** The source checkout the manifest travels with (link/copy origin). */
  readonly sourceRoot: string;
  /** The freshly created worktree (link/copy destination, setup cwd). */
  readonly worktreePath: string;
  readonly setupTimeoutMs: number;
  readonly log?: Log;
}

/**
 * Apply a bootstrap manifest to a fresh worktree. Order: links, copies,
 * setup commands. Any failure throws — the caller rolls the worktree
 * back; a half-bootstrapped tree is never handed to an agent.
 */
export function applyWorktreeManifest(manifest: WorktreeManifest, opts: ApplyManifestOptions): void {
  const log = opts.log ?? (() => {});

  for (const link of manifest.links) {
    const dest = insidePath(opts.worktreePath, link.at, `link.at "${link.at}"`);
    if (existsSync(dest)) {
      throw new Error(`manifest link destination already exists in the fresh worktree: ${dest}`);
    }
    const target = isAbsolute(link.to)
      ? resolve(link.to)
      : resolve(opts.sourceRoot, link.to);
    if (!existsSync(target)) {
      throw new Error(`manifest link target does not exist in the source checkout: ${target}`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    symlinkSync(target, dest);
    log('info', 'worktree manifest: link applied', { dest, target });
  }

  for (const copy of manifest.copies) {
    const source = insidePath(opts.sourceRoot, copy.from, `copy.from "${copy.from}"`);
    const dest = insidePath(opts.worktreePath, copy.to, `copy.to "${copy.to}"`);
    if (!existsSync(source) || !statSync(source).isFile()) {
      throw new Error(`manifest copy source is not a file in the source checkout: ${source}`);
    }
    if (existsSync(dest)) {
      throw new Error(`manifest copy destination already exists in the fresh worktree: ${dest}`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
    log('info', 'worktree manifest: copy applied', { source, dest });
  }

  for (const [index, entry] of manifest.setup.entries()) {
    const started = Date.now();
    execSetupCommand(entry.command, opts.worktreePath, opts.setupTimeoutMs);
    log('info', 'worktree manifest: setup command ran', {
      command: entry.command,
      index,
      ms: Date.now() - started,
    });
  }
}

/** Run one setup command in the worktree (shell, captured, bounded);
 * non-zero exit or timeout fails loud with the output tail. */
function execSetupCommand(command: string, cwd: string, timeoutMs: number): void {
  const result = spawnSync('/bin/sh', ['-c', command], { cwd, timeout: timeoutMs, encoding: 'utf-8' });
  if (result.error !== undefined) {
    throw new Error(`worktree setup command failed to spawn (${command}): ${String(result.error)}`);
  }
  if (result.signal === 'SIGTERM') {
    throw new Error(
      `worktree setup command timed out after ${timeoutMs}ms: ${command}\noutput tail:\n${tail(result.stdout ?? '')}${tail(result.stderr ?? '')}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `worktree setup command exited ${result.status}: ${command}\noutput tail:\n${tail(result.stdout ?? '')}${tail(result.stderr ?? '')}`,
    );
  }
}

function tail(text: string, max = 2_000): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}
