import { execFile, execFileSync } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { access, lstat, open, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

export type ManagedRepoPath =
  | { readonly kind: 'available'; readonly path: string }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'error'; readonly error: string };

/** One step of {@link resolveManagedRepoPath}, announced just before it is
 * awaited — so when a resolution never returns, the last step announced is
 * the one that hung. The git probe announces its child's life too: an exit
 * with no close means something still holds the child's output open. */
export type ManagedRepoResolveStep =
  | 'workspace realpath'
  | 'candidate lstat'
  | 'candidate realpath'
  | 'git marker lstat'
  | 'git marker access'
  | 'git pointer read'
  | 'git directory access'
  | 'git HEAD access'
  | 'git rev-parse spawn'
  | 'git rev-parse running'
  | 'git rev-parse exited, output still open'
  | 'reported root realpath';

/** Receives each step as it starts. `detail` is a pid, exit code or signal,
 * never a path. Must not throw. */
export type ManagedRepoResolveObserver = (step: ManagedRepoResolveStep, detail?: string) => void;

const UNAVAILABLE_REASON = 'selected repository is unavailable under workspace_root';
const MANAGED_REPO_DISPLAY_CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const MANAGED_REPO_DISPLAY_MARK = /\p{M}/u;
const MANAGED_REPO_DISPLAY_SEPARATOR_SPACE = /\p{Zs}/u;
const MANAGED_REPO_DISPLAY_BASE = /[^\p{Cc}\p{Cf}\p{M}\p{Zl}\p{Zp}\s]/u;
const GIT_ROUTING_ENV = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'LC_ALL',
  'XDG_CONFIG_HOME',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
]);

function isGitProbeEnvironmentVariable(name: string): boolean {
  const normalizedName = name.toUpperCase();
  return !GIT_ROUTING_ENV.has(normalizedName) && !/^GIT_CONFIG_(?:COUNT|(?:KEY|VALUE)_\d+)$/u.test(normalizedName);
}

function trustedAccountHome(): string {
  const home = userInfo().homedir;
  if (home === '' || !isAbsolute(home)) {
    throw new Error('cannot determine an absolute OS-account home for Git probes');
  }
  return home;
}

/** Keep the OS account's normal Git config authoritative, but ignore
 * inherited routing, config-path and command-scope overrides for probes.
 * `trustedHome` is a deterministic seam for hermetic tests; production calls
 * use the home reported by OS account metadata, never inherited HOME. */
export function gitProbeEnvironment(trustedHome = trustedAccountHome()): NodeJS.ProcessEnv {
  if (trustedHome === '' || !isAbsolute(trustedHome)) {
    throw new Error('Git probe home must be an absolute OS-account home');
  }
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([name]) => isGitProbeEnvironmentVariable(name)),
    ),
    HOME: trustedHome,
    // Root error classification recognizes English Git diagnostics.
    LC_ALL: 'C',
  };
}

function confirmedNonRepository(error: unknown, stderr: string): boolean {
  if (error === null || typeof error !== 'object') return false;
  const detail = error as NodeJS.ErrnoException & {
    killed?: boolean;
    signal?: string | null;
    status?: number | null;
  };
  const exitCode = typeof detail.code === 'number' ? detail.code : detail.status;
  return typeof exitCode === 'number' && exitCode !== 0 && detail.killed !== true &&
    (detail.signal === null || detail.signal === undefined) &&
    /(?:not a git repository|invalid gitfile format|invalid gitdir format)/iu.test(stderr);
}

class ManagedRepoProbeError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'ManagedRepoProbeError';
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rootProbeError(error: unknown): ManagedRepoPath {
  const code = typeof error === 'object' && error !== null
    ? (error as NodeJS.ErrnoException).code
    : undefined;
  if (!(error instanceof ManagedRepoProbeError) && (code === 'ENOENT' || code === 'ENOTDIR')) {
    return { kind: 'unavailable', reason: UNAVAILABLE_REASON };
  }
  const message = errorText(error);
  return {
    kind: 'error',
    error: (message.trim() || 'Git root validation failed without a message').slice(0, 300),
  };
}

const GIT_POINTER_LINE_MAX_BYTES = 4_096;

async function readGitPointerLine(markerPath: string): Promise<string | null> {
  const file = await open(markerPath, 'r');
  try {
    const buffer = Buffer.alloc(GIT_POINTER_LINE_MAX_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    const newline = bytes.indexOf(0x0a);
    if (newline < 0 && bytesRead > GIT_POINTER_LINE_MAX_BYTES) return null;
    const lineEnd = newline < 0 ? bytesRead : newline;
    if (lineEnd > GIT_POINTER_LINE_MAX_BYTES) return null;
    const line = bytes.toString('utf8', 0, lineEnd);
    return line.endsWith('\r') ? line.slice(0, -1) : line;
  } finally {
    await file.close();
  }
}

function readGitPointerLineSync(markerPath: string): string | null {
  const fd = openSync(markerPath, 'r');
  try {
    const buffer = Buffer.alloc(GIT_POINTER_LINE_MAX_BYTES + 1);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    const newline = bytes.indexOf(0x0a);
    if (newline < 0 && bytesRead > GIT_POINTER_LINE_MAX_BYTES) return null;
    const lineEnd = newline < 0 ? bytesRead : newline;
    if (lineEnd > GIT_POINTER_LINE_MAX_BYTES) return null;
    const line = bytes.toString('utf8', 0, lineEnd);
    return line.endsWith('\r') ? line.slice(0, -1) : line;
  } finally {
    closeSync(fd);
  }
}

function gitDirectoryFromPointer(markerPath: string, line: string | null): string | null {
  const prefix = 'gitdir: ';
  if (line === null || !line.startsWith(prefix)) return null;
  const target = line.slice(prefix.length);
  if (target === '') return null;
  return isAbsolute(target) ? target : resolve(dirname(markerPath), target);
}

async function assertGitDirectoryAccessible(
  gitDirectory: string,
  observe: ManagedRepoResolveObserver | undefined,
): Promise<void> {
  observe?.('git directory access');
  await access(gitDirectory, constants.R_OK | constants.X_OK);
  observe?.('git HEAD access');
  await access(join(gitDirectory, 'HEAD'), constants.R_OK);
}

function assertGitDirectoryAccessibleSync(gitDirectory: string): void {
  accessSync(gitDirectory, constants.R_OK | constants.X_OK);
  accessSync(join(gitDirectory, 'HEAD'), constants.R_OK);
}

/** Check marker and referenced gitdir access before Git can collapse permission
 * failures into a generic non-repository diagnostic. */
async function assertGitMarkerAccessible(
  markerPath: string,
  isDirectory: boolean,
  observe: ManagedRepoResolveObserver | undefined,
): Promise<void> {
  if (isDirectory) {
    await assertGitDirectoryAccessible(markerPath, observe);
    return;
  }
  observe?.('git marker access');
  await access(markerPath, constants.R_OK);
  observe?.('git pointer read');
  const gitDirectory = gitDirectoryFromPointer(markerPath, await readGitPointerLine(markerPath));
  if (gitDirectory !== null) await assertGitDirectoryAccessible(gitDirectory, observe);
}

function assertGitMarkerAccessibleSync(markerPath: string, isDirectory: boolean): void {
  if (isDirectory) {
    assertGitDirectoryAccessibleSync(markerPath);
    return;
  }
  accessSync(markerPath, constants.R_OK);
  const gitDirectory = gitDirectoryFromPointer(markerPath, readGitPointerLineSync(markerPath));
  if (gitDirectory !== null) assertGitDirectoryAccessibleSync(gitDirectory);
}

/** Remove only Git's final record separator; paths may end in Unicode whitespace. */
export function stripGitLineEnding(output: string): string {
  if (output.endsWith('\r\n')) return output.slice(0, -2);
  return output.endsWith('\n') ? output.slice(0, -1) : output;
}

async function isGitWorktreeRoot(
  project: string,
  observe: ManagedRepoResolveObserver | undefined,
): Promise<boolean> {
  observe?.('git rev-parse spawn');
  const stdout = await new Promise<string>((resolveOutput, reject) => {
    const child = execFile(
      'git',
      ['-C', project, 'rev-parse', '--show-toplevel'],
      {
        encoding: 'utf8',
        env: gitProbeEnvironment(),
        maxBuffer: 16_384,
        timeout: 2_000,
      },
      (error, output, stderr) => {
        if (error !== null) {
          if (confirmedNonRepository(error, String(stderr))) resolveOutput('');
          else reject(new ManagedRepoProbeError(errorText(error), error));
        } else resolveOutput(output);
      },
    );
    if (observe !== undefined) {
      const pid = child.pid === undefined ? 'no pid' : `pid ${child.pid}`;
      observe('git rev-parse running', pid);
      // `execFile` answers on close, not on exit: a descendant that keeps
      // the child's output open holds the answer back after git is gone.
      child.once('exit', (code, signal) => {
        observe(
          'git rev-parse exited, output still open',
          `${pid}, ${signal !== null ? `signal ${signal}` : `exit code ${code}`}`,
        );
      });
    }
  });
  const reportedRoot = stripGitLineEnding(stdout);
  if (reportedRoot === '') return false;
  observe?.('reported root realpath');
  return (await realpath(reportedRoot)) === project;
}

function isGitWorktreeRootSync(project: string): boolean {
  try {
    const stdout = execFileSync('git', ['-C', project, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      env: gitProbeEnvironment(),
      maxBuffer: 16_384,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2_000,
    });
    const reportedRoot = stripGitLineEnding(stdout);
    if (reportedRoot === '') return false;
    return realpathSync(reportedRoot) === project;
  } catch (error) {
    const stderr = String((error as NodeJS.ErrnoException & { stderr?: Buffer | string }).stderr ?? '');
    if (confirmedNonRepository(error, stderr)) return false;
    throw new ManagedRepoProbeError(errorText(error), error);
  }
}

/**
 * A managed repository is one exact direct-child directory name, never a
 * path, traversal, glob or alternate-platform absolute path. Keep the
 * ordinary visible names accepted for management (including spaces and
 * Unicode); reject ambiguous/path-forming values, terminal-control characters
 * and names that filesystems may normalize (trailing dot/space).
 */
export function managedRepoNameError(name: string): string | null {
  if (name.trim() === '') return 'must not be empty';
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) {
    return 'must not contain control, format, or line-separator characters';
  }
  if (name.endsWith('.') || name.endsWith(' ')) return 'must not end with a dot or space';
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    return 'must be a plain directory name under workspace_root';
  }
  if (name.startsWith('.')) {
    return 'must not start with a dot; choose a visible directory name under workspace_root';
  }
  if (['*', '?', '[', ']', '{', '}'].some((character) => name.includes(character))) {
    return 'must not contain wildcard characters';
  }
  if (isAbsolute(name) || win32.isAbsolute(name) || win32.parse(name).root !== '') {
    return 'must be a relative directory name under workspace_root';
  }
  return null;
}

/** Render untrusted repository names without terminal effects. Escape combining
 * marks until a visible base has appeared; whitespace and controls reset it. */
export function displayManagedRepoName(name: string): string {
  let hasVisibleBase = false;
  return [...name]
    .map((character) => {
      if (MANAGED_REPO_DISPLAY_CONTROL.test(character)) {
        hasVisibleBase = false;
        return `\\u{${character.codePointAt(0)?.toString(16) ?? '?'}}`;
      }
      if (MANAGED_REPO_DISPLAY_MARK.test(character)) {
        return hasVisibleBase
          ? character
          : `\\u{${character.codePointAt(0)?.toString(16) ?? '?'}}`;
      }
      if (MANAGED_REPO_DISPLAY_SEPARATOR_SPACE.test(character) && character !== ' ') {
        hasVisibleBase = false;
        return `\\u{${character.codePointAt(0)?.toString(16) ?? '?'}}`;
      }
      if (MANAGED_REPO_DISPLAY_BASE.test(character)) {
        hasVisibleBase = true;
        return character;
      }
      hasVisibleBase = false;
      return character;
    })
    .join('');
}

/**
 * Resolve one configured name to its exact direct project root. Missing,
 * symlinked, non-directory, escaped and confirmed non-Git entries stay
 * selected but truthfully unavailable; transient filesystem/Git probe faults
 * are errors so callers can retain stale observations without polling an
 * unvalidated root. A `.git` directory and a Git worktree-pointer file are
 * both supported. `observe` hears each step as it starts, so a caller whose
 * deadline passes can name the step that was still pending.
 */
export async function resolveManagedRepoPath(
  workspaceRoot: string,
  name: string,
  observe?: ManagedRepoResolveObserver,
): Promise<ManagedRepoPath> {
  if (managedRepoNameError(name) !== null) {
    return { kind: 'unavailable', reason: UNAVAILABLE_REASON };
  }

  try {
    observe?.('workspace realpath');
    const workspace = await realpath(workspaceRoot).catch((error: unknown) => {
      throw new ManagedRepoProbeError(`workspace root could not be read: ${errorText(error)}`, error);
    });
    const candidate = join(workspace, name);
    observe?.('candidate lstat');
    const candidateInfo = await lstat(candidate);
    if (!candidateInfo.isDirectory() || candidateInfo.isSymbolicLink()) {
      return { kind: 'unavailable', reason: UNAVAILABLE_REASON };
    }

    observe?.('candidate realpath');
    const project = await realpath(candidate);
    const rel = relative(workspace, project);
    if (
      rel === '' ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel) ||
      dirname(project) !== workspace ||
      basename(project) !== name
    ) {
      return { kind: 'unavailable', reason: UNAVAILABLE_REASON };
    }

    const gitMarkerPath = join(project, '.git');
    observe?.('git marker lstat');
    const gitMarker = await lstat(gitMarkerPath);
    if (
      gitMarker.isSymbolicLink() ||
      (!gitMarker.isDirectory() && !gitMarker.isFile())
    ) {
      return { kind: 'unavailable', reason: UNAVAILABLE_REASON };
    }
    await assertGitMarkerAccessible(gitMarkerPath, gitMarker.isDirectory(), observe);
    if (!(await isGitWorktreeRoot(project, observe))) {
      return { kind: 'unavailable', reason: UNAVAILABLE_REASON };
    }
    return { kind: 'available', path: project };
  } catch (error) {
    return rootProbeError(error);
  }
}

/** Synchronous counterpart for intake's synchronous request-identity boundary. */
export function resolveManagedRepoPathSync(
  workspaceRoot: string,
  name: string,
): ManagedRepoPath {
  if (managedRepoNameError(name) !== null) {
    return { kind: 'unavailable', reason: UNAVAILABLE_REASON };
  }

  try {
    let workspace: string;
    try {
      workspace = realpathSync(workspaceRoot);
    } catch (error) {
      throw new ManagedRepoProbeError(`workspace root could not be read: ${errorText(error)}`, error);
    }
    const candidate = join(workspace, name);
    const candidateInfo = lstatSync(candidate);
    if (!candidateInfo.isDirectory() || candidateInfo.isSymbolicLink()) {
      return { kind: 'unavailable', reason: UNAVAILABLE_REASON };
    }

    const project = realpathSync(candidate);
    const rel = relative(workspace, project);
    if (
      rel === '' ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel) ||
      dirname(project) !== workspace ||
      basename(project) !== name
    ) {
      return { kind: 'unavailable', reason: UNAVAILABLE_REASON };
    }

    const gitMarkerPath = join(project, '.git');
    const gitMarker = lstatSync(gitMarkerPath);
    if (
      gitMarker.isSymbolicLink() ||
      (!gitMarker.isDirectory() && !gitMarker.isFile())
    ) {
      return { kind: 'unavailable', reason: UNAVAILABLE_REASON };
    }
    assertGitMarkerAccessibleSync(gitMarkerPath, gitMarker.isDirectory());
    if (!isGitWorktreeRootSync(project)) {
      return { kind: 'unavailable', reason: UNAVAILABLE_REASON };
    }
    return { kind: 'available', path: project };
  } catch (error) {
    return rootProbeError(error);
  }
}

/** Canonical, currently available roots for offline registry consumers.
 * Runtime intake should use createManagedRepoIntakeResolver to validate only
 * the single requested configured repository. */
export function managedRepoPathsForIntake(
  workspaceRoot: string,
  names: readonly string[],
): readonly string[] {
  const paths: string[] = [];
  for (const name of names) {
    const resolved = resolveManagedRepoPathSync(workspaceRoot, name);
    if (resolved.kind === 'available' && !paths.includes(resolved.path)) {
      paths.push(resolved.path);
    }
  }
  return paths;
}

/** Build a bounded per-request intake guard once. It does an O(1) configured
 * name lookup and at most one bounded Git probe, rather than blocking the
 * event loop once per configured repository on every intake request. */
export function createManagedRepoIntakeResolver(
  workspaceRoot: string,
  names: readonly string[],
): (requestedPath: string) => readonly string[] {
  const managedNames = new Set(names);
  return (requestedPath: string): readonly string[] => {
    try {
      const workspace = realpathSync(workspaceRoot);
      if (!isAbsolute(requestedPath)) return [];
      const name = relative(workspace, requestedPath);
      if (
        name === '' ||
        name === '..' ||
        name.startsWith(`..${sep}`) ||
        name.includes(sep) ||
        join(workspace, name) !== requestedPath ||
        !managedNames.has(name)
      ) {
        return [];
      }
      const resolved = resolveManagedRepoPathSync(workspace, name);
      return resolved.kind === 'available' && resolved.path === requestedPath ? [resolved.path] : [];
    } catch {
      return [];
    }
  };
}
