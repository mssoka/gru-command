import { existsSync, readdirSync, statSync } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The managed-repo registry rule (setup wizard ruling 6, shared with the
 * runtime board): scan the configured workspace root for depth-1 entries
 * carrying a `.git` (directory OR worktree-pointer file). Dot-directories
 * are skipped; symlinked repo directories count (statSync follows the
 * link — a symlink to a repo is a managed repo); the result is sorted
 * for stable display. ONE implementation so the wizard's onboarding set
 * and the board's repository overview can never disagree.
 *
 * A missing/unreadable workspace root is no repos yet, not an error.
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

/**
 * Async twin of {@link discoverManagedRepos} with IDENTICAL semantics
 * (depth-1 `.git` entries, dot-dirs skipped, symlinks followed, sorted);
 * the runtime tracker uses it so a refresh never blocks the shared event
 * loop on a slow mount. Kept beside the sync rule so they cannot drift.
 */
export async function discoverManagedReposAsync(workspaceRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(workspaceRoot, { withFileTypes: true });
  } catch {
    return []; // missing/unreadable workspace root: no repos yet, not an error
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) {
      try {
        if (!(await stat(join(workspaceRoot, entry.name))).isDirectory()) continue;
      } catch {
        continue; // broken symlink — skip
      }
    } else if (!entry.isDirectory()) {
      continue;
    }
    try {
      await access(join(workspaceRoot, entry.name, '.git'));
    } catch {
      continue;
    }
    names.push(entry.name);
  }
  return names.sort();
}
