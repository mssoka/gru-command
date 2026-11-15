import { existsSync, readFileSync, symlinkSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { parse } from 'smol-toml';
import type { LogLevel } from '../logger.js';
import { repositoryGitEnv } from '../dispatch/perkins-review/artifacts.js';
import { CaptureGlobError, compileCaptureGlob } from '../media/capture-paths.js';

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
 *   [capture]                # PR media (docs/PR-MEDIA.md): what owes media and
 *   paths = ["web/src/**"]   #   how GC's camera starts the app; serve/ready
 *   serve = "npm run dev -- --port {port}"   # come together, paths may stand
 *   ready = "http://127.0.0.1:{port}/"      # alone
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
/** The verify scope GC's PR media camera holds its budget slot under
 * (docs/PR-MEDIA.md): reserved for the same reason. */
export const RESERVED_CAPTURE_SCOPE = 'pr-media-capture';
const RESERVED_SCOPE_OWNERS: Readonly<Record<string, string>> = {
  [RESERVED_VERIFY_SCOPE]: "GC's onboarding proof",
  [RESERVED_CAPTURE_SCOPE]: "GC's PR media camera",
};

/** True for a verify scope GC holds budget slots under itself. */
export function isReservedVerifyScope(scope: string): boolean {
  return Object.hasOwn(RESERVED_SCOPE_OWNERS, scope);
}

/** A manifest declares a verify scope GC reserves for itself. */
export class ReservedVerifyScopeError extends Error {
  constructor(readonly source: string, readonly scope: string) {
    super(`worktree manifest ${source} [verify] scope "${scope}" is reserved for ${RESERVED_SCOPE_OWNERS[scope] ?? 'GC'}; name the scope differently`);
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

/** How the capture readiness is judged: a loopback URL answering below 400,
 * or a line of the serve command's output containing the text. */
export type CaptureReady =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'output'; readonly text: string };

/**
 * `[capture]` (PR media, docs/PR-MEDIA.md): `paths` decides when a diff owes
 * media (owner ruling Q4); `serve` + `ready` let GC's camera start the app on
 * a port it picks for the run and film the minion's shot list. Templates hold
 * the `{port}` placeholder; `url` is the base the shots' `open` paths resolve
 * against.
 */
export interface ManifestCapture {
  readonly paths: readonly string[];
  readonly serve: string | null;
  readonly ready: CaptureReady | null;
  readonly url: string | null;
  readonly readyTimeoutMs: number;
}

export const CAPTURE_READY_TIMEOUT_DEFAULT_MS = 120_000;
export const CAPTURE_READY_TIMEOUT_MIN_MS = 1_000;
export const CAPTURE_READY_TIMEOUT_MAX_MS = 600_000;
export const CAPTURE_PATHS_MAX = 64;
const CAPTURE_KEYS = ['paths', 'serve', 'ready', 'url', 'ready_timeout_ms'] as const;
/** A loopback http URL template whose port is exactly the run's `{port}`
 * (plain http: a dev server's self-signed certificate would fail readiness). */
const CAPTURE_URL_RE = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\{port\}(?:\/[^\s{}]*)?$/u;

/** A `[capture]` table that cannot be used, named by its key. */
export class CaptureManifestError extends Error {
  constructor(readonly source: string, readonly key: string, reason: string) {
    super(`worktree manifest ${source} [capture] ${key} ${reason}`);
    this.name = 'CaptureManifestError';
  }
}

function captureUrl(source: string, key: string, value: string): string {
  if (!CAPTURE_URL_RE.test(value)) {
    throw new CaptureManifestError(source, key,
      `must be a loopback URL whose port is the run's {port}, such as "http://127.0.0.1:{port}/" (got ${JSON.stringify(value)}): ` +
      'GC picks a free port for each capture run and its browser opens only loopback addresses');
  }
  return value;
}

function parseCapture(raw: unknown, source: string): ManifestCapture {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`worktree manifest ${source}: [capture] must be a table`);
  }
  const table = raw as Record<string, unknown>;
  for (const key of Object.keys(table)) {
    if (!(CAPTURE_KEYS as readonly string[]).includes(key)) {
      throw new CaptureManifestError(source, `key "${key}"`, `is unknown (valid: ${CAPTURE_KEYS.join(', ')})`);
    }
  }
  if (Object.keys(table).length === 0) {
    throw new CaptureManifestError(source, 'table', 'is empty: declare paths, or serve and ready, or remove it');
  }
  const paths: string[] = [];
  const rawPaths = table['paths'];
  if (rawPaths !== undefined) {
    if (!Array.isArray(rawPaths)) throw new CaptureManifestError(source, 'paths', 'must be an array of repository-relative globs');
    if (rawPaths.length > CAPTURE_PATHS_MAX) throw new CaptureManifestError(source, 'paths', `may list at most ${CAPTURE_PATHS_MAX} globs`);
    for (const [index, entry] of rawPaths.entries()) {
      if (typeof entry !== 'string') throw new CaptureManifestError(source, `paths[${index}]`, `must be a string, got: ${JSON.stringify(entry)}`);
      let pattern: string;
      try {
        pattern = compileCaptureGlob(entry).pattern;
      } catch (error) {
        if (error instanceof CaptureGlobError) throw new CaptureManifestError(source, `paths[${index}]`, error.message);
        throw error;
      }
      const earlier = paths.indexOf(pattern);
      if (earlier !== -1) throw new CaptureManifestError(source, `paths[${index}]`, `duplicates paths[${earlier}] (${JSON.stringify(pattern)})`);
      paths.push(pattern);
    }
    if (paths.length > 0 && paths.every((pattern) => pattern.startsWith('!'))) {
      throw new CaptureManifestError(source, 'paths', 'lists only exclusions (! entries), so nothing could owe media: add the globs that do');
    }
  }
  const rawServe = table['serve'];
  const rawReady = table['ready'];
  if ((rawServe === undefined) !== (rawReady === undefined)) {
    throw new CaptureManifestError(source, rawServe === undefined ? 'ready' : 'serve',
      'needs its partner: serve starts the app and ready says when it is up, so declare both or neither');
  }
  let serve: string | null = null;
  let ready: CaptureReady | null = null;
  if (rawServe !== undefined) {
    if (typeof rawServe !== 'string' || rawServe.trim() === '') throw new CaptureManifestError(source, 'serve', 'must be a non-empty command string');
    serve = rawServe.trim();
    if (!serve.includes('{port}')) {
      throw new CaptureManifestError(source, 'serve',
        `must start the app on the run's {port} (for example "npm run dev -- --port {port}"): lanes capture side by side, so a fixed port would collide`);
    }
    if (typeof rawReady !== 'string' || rawReady.trim() === '') {
      throw new CaptureManifestError(source, 'ready', 'must be a loopback URL with {port}, or "output:<text>" the serve command prints when it is up');
    }
    const value = rawReady.trim();
    if (value.startsWith('output:')) {
      const text = value.slice('output:'.length).trim();
      if (text === '' || [...text].length > 200 || /\p{Cc}/u.test(text)) {
        throw new CaptureManifestError(source, 'ready', 'output text must be 1–200 characters on one line');
      }
      ready = { kind: 'output', text };
    } else {
      ready = { kind: 'url', url: captureUrl(source, 'ready', value) };
    }
  }
  let url: string | null = null;
  const rawUrl = table['url'];
  if (rawUrl !== undefined) {
    if (serve === null) throw new CaptureManifestError(source, 'url', 'needs serve and ready: it is the base the camera opens');
    if (typeof rawUrl !== 'string') throw new CaptureManifestError(source, 'url', 'must be a string');
    url = captureUrl(source, 'url', rawUrl.trim());
  }
  let readyTimeoutMs = CAPTURE_READY_TIMEOUT_DEFAULT_MS;
  const rawTimeout = table['ready_timeout_ms'];
  if (rawTimeout !== undefined) {
    if (serve === null) throw new CaptureManifestError(source, 'ready_timeout_ms', 'needs serve and ready');
    if (typeof rawTimeout !== 'number' || !Number.isInteger(rawTimeout) ||
      rawTimeout < CAPTURE_READY_TIMEOUT_MIN_MS || rawTimeout > CAPTURE_READY_TIMEOUT_MAX_MS) {
      throw new CaptureManifestError(source, 'ready_timeout_ms',
        `must be an integer from ${CAPTURE_READY_TIMEOUT_MIN_MS} to ${CAPTURE_READY_TIMEOUT_MAX_MS}, got: ${JSON.stringify(rawTimeout)}`);
    }
    readyTimeoutMs = rawTimeout;
  }
  return { paths, serve, ready, url, readyTimeoutMs };
}

/** The base URL template the camera opens: `url`, else the ready URL's
 * origin, else the loopback address on the run's port. */
export function captureBaseUrl(capture: ManifestCapture): string {
  if (capture.url !== null) return capture.url.replace(/\/+$/u, '');
  if (capture.ready?.kind === 'url') {
    const match = /^(http:\/\/[^/]+)/u.exec(capture.ready.url);
    if (match !== null) return match[1]!;
  }
  return 'http://127.0.0.1:{port}';
}

export interface WorktreeManifest {
  readonly links: readonly ManifestLink[];
  readonly copies: readonly ManifestCopy[];
  readonly setup: readonly ManifestSetup[];
  readonly verify: ManifestVerify;
  /** Per-repository raid opt-out (#351); absent means the instance setting decides. */
  readonly vector?: { readonly enabled: boolean };
  /** PR media capture (docs/PR-MEDIA.md); absent = nothing owes media and GC films nothing. */
  readonly capture?: ManifestCapture;
  /** Regenerable folders (#427): repo-relative, normalized ("a/b"), unique.
   * Lane slimming deletes them from an idle lane; the lane's setup restores them. */
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
    if (!['link', 'copy', 'setup', 'verify', 'vector', 'reclaim', 'capture'].includes(key)) {
      throw new Error(`worktree manifest ${source} has unknown key "${key}" (valid: link, copy, setup, verify, vector, reclaim, capture)`);
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
      if (isReservedVerifyScope(scope)) throw new ReservedVerifyScopeError(source, scope);
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

  const capture = raw['capture'] === undefined ? undefined : parseCapture(raw['capture'], source);

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
    ...(capture === undefined ? {} : { capture }),
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
  readonly onSpawn?: (pid: number, index: number, command: string) => void;
  /** Durable setup-owner receipt before a configured command can run. */
  readonly onCommandStart?: (index: number, command: string) => void;
  /** The shell child's exit (code, signal, timeout, stop) once it closed;
   * not proof that its process group ended. */
  readonly onCommandOutcome?: (index: number, command: string, result: { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly timedOut: boolean; readonly stopped: boolean }) => void;
}

/**
 * Apply a bootstrap manifest to a fresh worktree. Order: links, copies,
 * setup commands. Any failure rejects — the caller applies its custody
 * policy; a half-bootstrapped tree is never handed to an agent. Async by
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

  // Every step's process group: a failure names any member still running
  // in the worktree, an earlier step's included.
  const groups: number[] = [];
  for (const [index, entry] of manifest.setup.entries()) {
    const started = Date.now();
    opts.onCommandStart?.(index, entry.command);
    try {
      await execSetupCommand(entry.command, opts.worktreePath, opts.setupTimeoutMs, {
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.env !== undefined ? { env: opts.env } : {}),
        onSpawn: (pid) => {
          groups.push(pid);
          opts.onSpawn?.(pid, index, entry.command);
        },
        ...(opts.onCommandOutcome !== undefined ? { onOutcome: (result) => opts.onCommandOutcome?.(index, entry.command, result) } : {}),
      });
    } catch (error) {
      if (!groups.some(processGroupAlive)) throw error;
      const noOutput = { text: '', truncated: false, startsAtLine: true };
      throw new WorktreeSetupError(error instanceof Error ? error.message : String(error),
        error instanceof WorktreeSetupError ? error.output : { stdout: noOutput, stderr: noOutput }, true,
        { cause: error });
    }
    log('info', 'worktree manifest: setup command ran', {
      command: entry.command,
      index,
      ms: Date.now() - started,
    });
  }
}

/** A member of this process group still lives. */
function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
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
 * for a caller that redacts before it records (#427 onboarding proof). A
 * caller that converts an earlier failure into this one to report a
 * surviving process group passes that failure as `cause`, so the refusal it
 * wraps stays observable on the thrown value. */
export class WorktreeSetupError extends Error {
  constructor(
    message: string,
    readonly output: { readonly stdout: SetupStreamTail; readonly stderr: SetupStreamTail },
    /** A setup step's process group still had a member when it failed. */
    readonly processesRemain = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
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
  readonly onOutcome?: (result: { readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly timedOut: boolean; readonly stopped: boolean }) => void;
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
  const groupAlive = (): boolean => child.pid !== undefined && processGroupAlive(child.pid);
  let timedOut = false;
  let stopped = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  const end = (): void => {
    signalTree('SIGTERM');
    // A command that ignores SIGTERM must not hold the dispatch forever.
    forceKillTimer ??= setTimeout(() => signalTree('SIGKILL'), SETUP_KILL_GRACE_MS);
  };
  if (child.pid !== undefined) {
    try {
      opts.onSpawn?.(child.pid);
    } catch (error) {
      end();
      try { await closed; } catch { /* the durable start receipt remains incomplete */ }
      if (forceKillTimer !== undefined && !groupAlive()) clearTimeout(forceKillTimer);
      throw new Error(`worktree setup process ownership receipt failed for ${command}`, { cause: error });
    }
  }
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

  opts.onOutcome?.({ code: outcome.code, signal: outcome.signal, timedOut, stopped });
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
