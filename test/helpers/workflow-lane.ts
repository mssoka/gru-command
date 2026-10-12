import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreeLane } from '../../src/dispatch/worktree-port.js';

/** Real linked assignment, no origin, model, ambient BMAD or production state. */
export function makeWorkflowLane(jobId = 'j-owned'): { readonly root: string; readonly lane: WorktreeLane; readonly dataDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gc-workflow-session-')));
  const repoPath = join(root, 'app');
  mkdirSync(repoPath);
  const git = (args: readonly string[]) => execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-q', '-b', 'main']);
  writeFileSync(join(repoPath, 'AGENTS.md'), '# PROJECT-CONVENTIONS-CANARY\nUse deterministic tests.\n');
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const path = join(root, 'lane');
  const branch = `gru/${jobId}`;
  git(['worktree', 'add', '-q', '-b', branch, path]);
  const dataDir = join(root, 'private-data');
  mkdirSync(dataDir, { mode: 0o700 });
  return { root, dataDir, lane: { id: jobId, jobId, kind: 'job', repoPath, repoName: 'app', path,
    branch, sha: git(['rev-parse', 'HEAD']), roundId: null, status: 'active' } };
}
