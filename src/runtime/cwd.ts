import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/**
 * Spawn-cwd resolution (SPEC ruling 17): the dispatch flow roots agents in
 * the PROJECT they serve, so spawn options may carry an explicit working
 * directory. Shared by every runtime adapter — one validation contract,
 * fail-loud on anything that is not an existing absolute directory.
 */

export function resolveSpawnCwd(workspaceRoot: string, requested: string | undefined): string {
  if (requested === undefined || requested === '') return resolve(workspaceRoot);
  if (!isAbsolute(requested)) {
    throw new Error(
      `spawn cwd must be an absolute path (the project root or its worktree), got relative: ${requested}`,
    );
  }
  const resolved = resolve(requested);
  let info;
  try {
    info = statSync(resolved);
  } catch (error) {
    throw new Error(`spawn cwd does not exist: ${resolved} (${String(error)})`);
  }
  if (!info.isDirectory()) {
    throw new Error(`spawn cwd is not a directory: ${resolved}`);
  }
  return resolved;
}
