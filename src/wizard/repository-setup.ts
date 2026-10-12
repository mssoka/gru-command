import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { assertWorktreeBootstrapSupported, loadWorktreeManifest } from '../worktrees/manifest.js';
import { gitProbeEnvironment } from '../repos/managed-names.js';

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
  const gitMarkerPath = join(repoPath, '.git');
  let gitMarker: ReturnType<typeof lstatSync>;
  try {
    gitMarker = lstatSync(gitMarkerPath);
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new RepositorySetupError(`selected directory is not a Git repo: ${repoPath}`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new RepositorySetupError(
      `could not inspect the selected repository's Git marker: ${detail}`,
    );
  }
  if (gitMarker.isSymbolicLink() || (!gitMarker.isDirectory() && !gitMarker.isFile())) {
    throw new RepositorySetupError(
      `selected directory has an unsupported .git marker at ${gitMarkerPath}; ` +
        '.git must be a real directory or a worktree-pointer file',
    );
  }

  // A caller's Git routing/config scope must not turn a ghost .git into another repo.
  // Owner Git config files (including safe.directory) remain authoritative.
  const result = spawnSync('git', ['-C', repoPath, 'rev-parse', '--show-toplevel'], {
    env: gitProbeEnvironment(), encoding: 'utf-8', timeout: 10_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
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
