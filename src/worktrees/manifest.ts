import { existsSync, readFileSync, symlinkSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { parse } from 'smol-toml';
import type { LogLevel } from '../logger.js';
import { repositoryGitEnv } from '../dispatch/perkins-review/artifacts.js';

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
 *   at   = "fixtures/large"  #   path inside the fresh worktree (relative, no ..)
 *   to   = "fixtures/large"  #   target: repo-root-relative (.. allowed) or absolute
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
 *
 *   [vector]                 # Vector's raids (#351, docs/VECTOR.md)
 *   enabled = false          #   false removes this repository from raid candidates
 *
 *   reclaim = ["build"]      # top-level, before any table (#427): repo-relative
 *                            #   folders setup or builds create and git ignores,
 *                            #   which GC may delete and recreate; never .., an
 *                            #   absolute path, ".", .git or .gru-command
 */

export const MANIFEST_DIR = '.gru-command';
/** The verify scope GC's onboarding proof (#427) holds its budget slot
 * under. A manifest may not declare it: the verification server records
 * nothing for this scope, so a run of it would leave no evidence. */
export const RESERVED_VERIFY_SCOPE = 'onboarding-proof';

/** A manifest declares a verify scope GC reserves for itself. */
export class ReservedVerifyScopeError extends Error {
  constructor(readonly source: string, readonly scope: string) {
    super(`worktree manifest ${source} [verify] scope "${scope}" is reserved for GC's onboarding proof; name the scope differently`);
    this.name = 'ReservedVerifyScopeError';
  }
}
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
  /** Per-repository raid opt-out (#351); absent means the instance setting decides. */
  readonly vector?: { readonly enabled: boolean };
  /** Regenerable folders (#427): repo-relative, normalized ("a/b"), unique. Nothing consumes them yet. */
  readonly reclaim?: readonly string[];
  /** Historical manifests remain readable for already-running jobs; creation refuses this obsolete GC bootstrap. */
  readonly retiredGcBmadBootstrap?: true;
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
    if (!['link', 'copy', 'setup', 'verify', 'vector', 'reclaim'].includes(key)) {
      throw new Error(`worktree manifest ${source} has unknown key "${key}" (valid: link, copy, setup, verify, vector, reclaim)`);
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
      if (scope === RESERVED_VERIFY_SCOPE) throw new ReservedVerifyScopeError(source, scope);
      verifyEntries[scope] = nonEmptyString(command, `${source} verify.${scope}`);
    }
  }

  let vector: { readonly enabled: boolean } | undefined;
  const rawVector = raw['vector'];
  if (rawVector !== undefined) {
    if (typeof rawVector !== 'object' || rawVector === null || Array.isArray(rawVector)) {
      throw new Error(`worktree manifest ${source}: [vector] must be a table`);
    }
    for (const key of Object.keys(rawVector)) {
      if (key !== 'enabled') throw new Error(`worktree manifest ${source} [vector] has unknown key "${key}" (valid: enabled)`);
    }
    const enabled = (rawVector as Record<string, unknown>)['enabled'];
    if (typeof enabled !== 'boolean') throw new Error(`worktree manifest ${source} [vector].enabled must be a boolean, got: ${String(enabled)}`);
    vector = { enabled };
  }

  let reclaim: string[] | undefined;
  const rawReclaim = raw['reclaim'];
  if (rawReclaim !== undefined) {
    if (!Array.isArray(rawReclaim)) throw new Error(`worktree manifest ${source}: reclaim must be an array of repo-relative folder paths`);
    reclaim = [];
    for (const [index, entry] of rawReclaim.entries()) {
      const at = `worktree manifest ${source} reclaim[${index}]`;
      if (typeof entry !== 'string' || entry.trim() === '') throw new Error(`${at} must be a non-empty folder path, got: ${JSON.stringify(entry)}`);
      if (entry.includes('\u0000')) throw new Error(`${at} must not contain NUL: ${JSON.stringify(entry)}`);
      const value = entry.trim();
      if (isAbsolute(value) || win32.isAbsolute(value)) throw new Error(`${at} must be relative to the repository root: ${JSON.stringify(entry)}`);
      if (escapesTree(value)) throw new Error(`${at} must stay inside the repository (no ..): ${JSON.stringify(entry)}`);
      const segments = value.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.');
      if (segments.length === 0) throw new Error(`${at} must name a folder below the repository root, not the root itself: ${JSON.stringify(entry)}`);
      const reserved = segments.find((segment) => segment === '.git' || segment === MANIFEST_DIR);
      if (reserved !== undefined) throw new Error(`${at} must not be or be inside ${reserved}: ${JSON.stringify(entry)}`);
      const normalized = segments.join('/');
      const earlier = reclaim.indexOf(normalized);
      if (earlier !== -1) throw new Error(`${at} ${JSON.stringify(entry)} duplicates reclaim[${earlier}] (both name "${normalized}")`);
      reclaim.push(normalized);
    }
  }

  // Distinguish actual comment markers from the same text inside a user's
  // multiline setup string. Removing a comment cannot alter parsed TOML.
  const retired = [...text.matchAll(/^[\t ]*#[\t ]*(?:BEGIN|END)[\t ]+GRU[\t ]+COMMAND[\t ]+BMAD[\t ]+BOOTSTRAP\b[^\r\n]*/gmu)].some((match) => {
    const withoutLine = text.slice(0, match.index) + text.slice(match.index + match[0].length);
    try { return JSON.stringify(parse(withoutLine)) === JSON.stringify(raw); } catch { return false; }
  });
  return {
    links,
    copies,
    setup,
    verify: verifyEntries,
    ...(vector === undefined ? {} : { vector }),
    ...(reclaim === undefined ? {} : { reclaim }),
    ...(retired ? { retiredGcBmadBootstrap: true as const } : {}),
  };
}

/** Creation-only guard: historical jobs can still resolve their original verification commands. */
export function assertWorktreeBootstrapSupported(manifest: WorktreeManifest, source = MANIFEST_PATH): void {
  if (manifest.retiredGcBmadBootstrap) {
    throw new Error(
      `worktree manifest ${source} contains a retired GC-managed BMAD bootstrap; ` +
        'use the owner-run preview/backup/retirement steps in docs/BMAD-RUNTIME.md ' +
        '("Retire only the GC bootstrap"). Preserve edited/foreign blocks for deliberate repair; no files were changed',
    );
  }
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
  /** Stops a running setup command (its whole process group: SIGTERM,
   * then SIGKILL after the grace) and rejects. Lanes pass none. */
  readonly signal?: AbortSignal;
  /** Added to each setup command's environment (#427 onboarding proof: the
   * marker its cleanup finds every process by). Lanes pass none. */
  readonly env?: Readonly<Record<string, string>>;
  /** Told each setup command's pid, which leads its own process group, so
   * a caller can end the group later (#427 onboarding proof). */
  readonly onSpawn?: (pid: number) => void;
}

/**
 * Apply a bootstrap manifest to a fresh worktree. Order: links, copies,
 * setup commands. Any failure rejects — the caller rolls the worktree
 * back; a half-bootstrapped tree is never handed to an agent. Async by
 * contract: setup commands run as child processes OFF the event loop, so
 * a slow `npm ci` never freezes chat/supervision while dispatch awaits
 * the lane (the 2026-09-29 wall-clock-gap incident).
 */
export async function applyWorktreeManifest(
  manifest: WorktreeManifest,
  opts: ApplyManifestOptions,
): Promise<void> {
  const log = opts.log ?? (() => {});
  assertWorktreeBootstrapSupported(manifest);

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
    await execSetupCommand(entry.command, opts.worktreePath, opts.setupTimeoutMs, {
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.onSpawn !== undefined ? { onSpawn: opts.onSpawn } : {}),
    });
    log('info', 'worktree manifest: setup command ran', {
      command: entry.command,
      index,
      ms: Date.now() - started,
    });
  }
}

/** Per-stream cap on captured setup output; failures surface the tail. */
const SETUP_OUTPUT_TAIL_BYTES = 64 * 1024;

/** Grace for a timed-out setup command to honor SIGTERM before SIGKILL. */
const SETUP_KILL_GRACE_MS = 1_000;

/** Bounded tail buffer for captured setup output (a chatty command must
 * never grow the service's memory unboundedly). Exported for its tests. */
export class OutputTail {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  /** Earlier output was dropped: the text starts mid-stream. */
  private dropped = false;
  /** The last chunk dropped ended at a line break (or none was). */
  private startsAtLine = true;

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > SETUP_OUTPUT_TAIL_BYTES && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (dropped === undefined) return;
      this.bytes -= dropped.length;
      this.dropped = true;
      this.startsAtLine = dropped.at(-1) === 0x0a;
    }
  }

  text(): string {
    return Buffer.concat(this.chunks).toString('utf-8');
  }

  stream(): SetupStreamTail {
    return { text: this.text(), truncated: this.dropped, startsAtLine: this.startsAtLine };
  }
}

/** One stream of a setup command's latest output (up to 64 KiB). */
export interface SetupStreamTail {
  readonly text: string;
  /** Earlier output was dropped: the text starts mid-stream. */
  readonly truncated: boolean;
  /** The text starts at a whole line: nothing was dropped, or what was
   * dropped ended at a line break. */
  readonly startsAtLine: boolean;
}

/** A setup command failed, timed out or was stopped. The message names it
 * with a short output tail; `output` keeps each stream's bounded raw tail
 * for a caller that redacts before it records (#427 onboarding proof). */
export class WorktreeSetupError extends Error {
  constructor(message: string, readonly output: { readonly stdout: SetupStreamTail; readonly stderr: SetupStreamTail }) {
    super(message);
    this.name = 'WorktreeSetupError';
  }
}

/** Run one setup command in the worktree (shell, captured, bounded);
 * non-zero exit, timeout or an abort fails loud with the output tail. The
 * command runs as its own process group so a timeout or abort kill reaches
 * the children a shell command spawns (npm ci), and awaiting it never
 * blocks the event loop. */
async function execSetupCommand(command: string, cwd: string, timeoutMs: number, opts: {
  readonly signal?: AbortSignal;
  readonly env?: Readonly<Record<string, string>>;
  readonly onSpawn?: (pid: number) => void;
}): Promise<void> {
  const { signal } = opts;
  if (signal?.aborted === true) throw new Error(`worktree setup command was stopped before it started: ${command}`);
  let child: ChildProcess;
  try {
    child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env: { ...repositoryGitEnv(false), ...opts.env },
      detached: true, // own process group: the timeout kill reaps children too
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(`worktree setup command failed to spawn (${command}): ${String(error)}`);
  }
  if (child.pid !== undefined) opts.onSpawn?.(child.pid);
  const stdout = new OutputTail();
  const stderr = new OutputTail();
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    },
  );
  const signalTree = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal); // the detached setup group
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  };
  /** A member of the setup group still lives (the shell may be gone). */
  const groupAlive = (): boolean => {
    if (child.pid === undefined) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let timedOut = false;
  let stopped = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  const end = (): void => {
    signalTree('SIGTERM');
    // A command that ignores SIGTERM must not hold the dispatch forever.
    forceKillTimer ??= setTimeout(() => signalTree('SIGKILL'), SETUP_KILL_GRACE_MS);
  };
  const killTimer = setTimeout(() => {
    timedOut = true;
    end();
  }, timeoutMs);
  const onAbort = (): void => {
    stopped = true;
    end();
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  let outcome: { code: number | null; signal: NodeJS.Signals | null };
  try {
    outcome = await closed;
  } catch (error) {
    throw new Error(`worktree setup command failed to spawn (${command}): ${String(error)}`);
  } finally {
    clearTimeout(killTimer);
    signal?.removeEventListener('abort', onAbort);
    // A stop or a timeout keeps its SIGKILL escalation armed while any
    // member lives: one that ignored SIGTERM must not outlive it.
    if (forceKillTimer !== undefined && !((stopped || timedOut) && groupAlive())) clearTimeout(forceKillTimer);
  }

  const output = { stdout: stdout.stream(), stderr: stderr.stream() };
  const outputTail = tail(output.stdout.text) + tail(output.stderr.text);
  const failed = (what: string): WorktreeSetupError => new WorktreeSetupError(`${what}: ${command}\noutput tail:\n${outputTail}`, output);
  if (stopped) throw failed('worktree setup command was stopped (its caller aborted)');
  if (timedOut) throw failed(`worktree setup command timed out after ${timeoutMs}ms`);
  if (outcome.code === null) throw failed(`worktree setup command was killed by ${String(outcome.signal)}`);
  if (outcome.code !== 0) throw failed(`worktree setup command exited ${outcome.code}`);
}

function tail(text: string, max = 2_000): string {
  return text.length <= max ? text : `…${text.slice(-max)}`;
}
