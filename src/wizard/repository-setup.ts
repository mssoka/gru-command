import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { assertWorktreeBootstrapSupported, loadWorktreeManifest } from '../worktrees/manifest.js';

/** A read-only GC setup boundary. Independent BMAD files are never inspected. */
export class RepositorySetupError extends Error {
  constructor(message: string) {
    super(`GC repository setup: ${message}`);
    this.name = 'RepositorySetupError';
  }
}

/** Validate the selected repository and its declared GC bootstrap, without running it or writing project state. */
export function validateRepositorySetup(workspaceRoot: string, repoName: string): string {
  const workspace = realpathSync(workspaceRoot);
  const candidate = join(workspace, repoName);
  if (!existsSync(candidate)) throw new RepositorySetupError(`selected repo no longer exists: ${candidate}`);
  if (lstatSync(candidate).isSymbolicLink()) {
    throw new RepositorySetupError(`selected repo is a symlink: ${candidate}; select a real repository under the workspace root`);
  }
  const repoPath = realpathSync(candidate);
  const rel = relative(workspace, repoPath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new RepositorySetupError(`selected repo escapes the workspace root: ${candidate}`);
  }
  if (!existsSync(join(repoPath, '.git'))) throw new RepositorySetupError(`selected directory is not a Git repo: ${repoPath}`);

  // A caller's Git routing must not turn a ghost .git into another repo.
  // Keep owner Git configuration (including safe.directory) authoritative.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => ![
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_IMPLICIT_WORK_TREE', 'GIT_PREFIX',
    'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  ].includes(name)));
  const result = spawnSync('git', ['-C', repoPath, 'rev-parse', '--show-toplevel'], {
    env, encoding: 'utf-8', timeout: 10_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined || result.signal !== null || result.status === null) {
    throw new RepositorySetupError(`Git probe failed for ${repoPath}: ${result.error?.message ?? result.signal}; ensure Git runs on this host, then re-run setup`);
  }
  if (result.status !== 0) {
    throw new RepositorySetupError(`selected directory is not a usable Git repo: ${repoPath}; inspect the Git diagnostic below and repair the repository before re-running setup:\n${result.stderr.trim()}`);
  }
  const reportedPath = result.stdout.trim();
  if (reportedPath === '') throw new RepositorySetupError(`Git reported no repository root for ${repoPath}; inspect its Git configuration and re-run setup`);
  let reportedRoot: string;
  try {
    reportedRoot = realpathSync(reportedPath);
  } catch (error) {
    throw new RepositorySetupError(`Git reported an unavailable repository root: ${reportedPath} (${(error as Error).message}); inspect core.worktree/Git configuration and re-run setup`);
  }
  if (reportedRoot !== repoPath) {
    throw new RepositorySetupError(`selected directory is not the Git repository root: ${repoPath}`);
  }
  try {
    const manifest = loadWorktreeManifest(repoPath);
    if (manifest !== null) assertWorktreeBootstrapSupported(manifest, join(repoPath, '.gru-command/worktree.toml'));
  } catch (error) {
    throw new RepositorySetupError(`${(error as Error).message}; repair the GC worktree manifest deliberately, then re-run setup`);
  }
  return repoPath;
}
