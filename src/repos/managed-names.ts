import { lstatSync, realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep, win32 } from 'node:path';

export type ManagedRepoPath =
  | { readonly kind: 'available'; readonly path: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

const UNAVAILABLE_REASON = 'selected repository is unavailable under workspace_root';

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
    if (gitMarker.isSymbolicLink() || (!gitMarker.isDirectory() && !gitMarker.isFile())) {
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
    if (gitMarker.isSymbolicLink() || (!gitMarker.isDirectory() && !gitMarker.isFile())) {
      return { kind: 'unavailable', reason: UNAVAILABLE_REASON };
    }
    return { kind: 'available', path: project };
  } catch {
    return { kind: 'unavailable', reason: UNAVAILABLE_REASON };
  }
}

/** Canonical, currently available roots for the intake registry. Unavailable,
 * escaped and symlinked configured names never expand intake membership. */
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
