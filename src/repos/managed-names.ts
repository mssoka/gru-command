import { execFile, execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep, win32 } from 'node:path';

export type ManagedRepoPath =
  | { readonly kind: 'available'; readonly path: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

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
]);

function isGitProbeEnvironmentVariable(name: string): boolean {
  return !GIT_ROUTING_ENV.has(name) && !/^GIT_CONFIG_(?:COUNT|(?:KEY|VALUE)_\d+)$/u.test(name);
}

/** Keep owner Git config files authoritative, but prevent inherited routing or
 * command-scope overrides from replacing the selected project's Git identity. */
export function gitProbeEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => isGitProbeEnvironmentVariable(name)),
  );
}

async function isGitWorktreeRoot(project: string): Promise<boolean> {
  try {
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
        (error, output) => {
          if (error !== null) reject(error);
          else resolveOutput(output);
        },
      );
    });
    return (await realpath(stdout.trim())) === project;
  } catch {
    return false;
  }
}

function isGitWorktreeRootSync(project: string): boolean {
  try {
    const reportedRoot = execFileSync('git', ['-C', project, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      env: gitProbeEnvironment(),
      maxBuffer: 16_384,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    }).trim();
    return realpathSync(reportedRoot) === project;
  } catch {
    return false;
  }
}

/**
 * A managed repository is one exact direct-child directory name, never a
 * path, traversal, glob or alternate-platform absolute path. Keep the
 * ordinary names already accepted by installer discovery (including
 * spaces and Unicode); reject only ambiguous/path-forming values.
 */
export function managedRepoNameError(name: string): string | null {
  if (name.trim() === '') return 'must not be empty';
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
 * symlinked, non-directory, escaped and non-Git entries stay selected but
 * truthfully unavailable; callers must not substitute a discovered sibling.
 * A `.git` directory and a Git worktree-pointer file are both supported.
 */
export async function resolveManagedRepoPath(
  workspaceRoot: string,
  name: string,
): Promise<ManagedRepoPath> {
  if (managedRepoNameError(name) !== null) {
    return { kind: 'unavailable', reason: UNAVAILABLE_REASON };
  }

  try {
    const workspace = await realpath(workspaceRoot);
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
      dirname(project) !== workspace
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
  } catch {
    return { kind: 'unavailable', reason: UNAVAILABLE_REASON };
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
    const workspace = realpathSync(workspaceRoot);
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
      dirname(project) !== workspace
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
  } catch {
    return { kind: 'unavailable', reason: UNAVAILABLE_REASON };
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
