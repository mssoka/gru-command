import { execFile, execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep, win32 } from 'node:path';

export type ManagedRepoPath =
  | { readonly kind: 'available'; readonly path: string }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'error'; readonly error: string };

const UNAVAILABLE_REASON = 'selected repository is unavailable under workspace_root';
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
  };
}

function confirmedNonRepository(error: unknown, stderr: string): boolean {
  if (error === null || typeof error !== 'object') return false;
  const detail = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
  return typeof detail.code === 'number' && detail.killed !== true &&
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

async function isGitWorktreeRoot(project: string): Promise<boolean> {
  const stdout = await new Promise<string>((resolveOutput, reject) => {
    execFile(
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
  });
  if (stdout === '') return false;
  return (await realpath(stdout.trim())) === project;
}

function isGitWorktreeRootSync(project: string): boolean {
  try {
    const reportedRoot = execFileSync('git', ['-C', project, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      env: gitProbeEnvironment(),
      maxBuffer: 16_384,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 2_000,
    }).trim();
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
 * ordinary names already accepted by installer discovery (including
 * spaces and Unicode); reject ambiguous/path-forming values, terminal-control
 * characters and names that filesystems may normalize (trailing dot/space).
 */
export function managedRepoNameError(name: string): string | null {
  if (name.trim() === '') return 'must not be empty';
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) {
    return 'must not contain control, format, or line-separator characters';
  }
  if (name.endsWith('.') || name.endsWith(' ')) return 'must not end with a dot or space';
  if (name === '.' || name === '..' || name.startsWith('.')) {
    return 'must be a plain directory name under workspace_root';
  }
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) {
    return 'must be a plain directory name under workspace_root';
  }
  if (['*', '?', '[', ']', '{', '}'].some((character) => name.includes(character))) {
    return 'must not contain wildcard characters';
  }
  if (isAbsolute(name) || win32.isAbsolute(name) || win32.parse(name).root !== '') {
    return 'must be a relative directory name under workspace_root';
  }
  return null;
}

/**
 * Resolve one configured name to its exact direct project root. Missing,
 * symlinked, non-directory, escaped and confirmed non-Git entries stay
 * selected but truthfully unavailable; transient filesystem/Git probe faults
 * are errors so callers can retain stale observations without polling an
 * unvalidated root. A `.git` directory and a Git worktree-pointer file are
 * both supported.
 */
export async function resolveManagedRepoPath(
  workspaceRoot: string,
  name: string,
): Promise<ManagedRepoPath> {
  if (managedRepoNameError(name) !== null) {
    return { kind: 'unavailable', reason: UNAVAILABLE_REASON };
  }

  try {
    const workspace = await realpath(workspaceRoot).catch((error: unknown) => {
      throw new ManagedRepoProbeError(`workspace root could not be read: ${errorText(error)}`, error);
    });
    const candidate = join(workspace, name);
    const candidateInfo = await lstat(candidate);
    if (!candidateInfo.isDirectory() || candidateInfo.isSymbolicLink()) {
      return { kind: 'unavailable', reason: UNAVAILABLE_REASON };
    }

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

    const gitMarker = await lstat(join(project, '.git'));
    if (
      gitMarker.isSymbolicLink() ||
      (!gitMarker.isDirectory() && !gitMarker.isFile()) ||
      !(await isGitWorktreeRoot(project))
    ) {
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

    const gitMarker = lstatSync(join(project, '.git'));
    if (
      gitMarker.isSymbolicLink() ||
      (!gitMarker.isDirectory() && !gitMarker.isFile()) ||
      !isGitWorktreeRootSync(project)
    ) {
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
