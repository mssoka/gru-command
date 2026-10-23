import { issueFixtureHandoff, standaloneFixtureLedger } from './fixture-handoff.js';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreeLane } from '../../src/dispatch/worktree-port.js';

export type WorkflowLaneTemplate = Pick<WorktreeLane, 'repoPath' | 'sha'>;
export type WorkflowLaneFixture = { readonly root: string; readonly lane: WorktreeLane; readonly dataDir: string };

/** Real linked assignment, no origin, model, ambient BMAD or production state. */
export function makeWorkflowLane(jobId = 'j-owned', kind: WorktreeLane['kind'] = 'job'): WorkflowLaneFixture {
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
  return { root, dataDir, lane: issueFixtureHandoff({ id: jobId, jobId, kind, repoPath, repoName: 'app', path,
    branch, sha: git(['rev-parse', 'HEAD']), roundId: null, status: 'active' }, standaloneFixtureLedger(jobId)) };
}

/**
 * Make an independent mutable lane from a shared immutable Git seed. The seed's
 * object store is reused, while each caller receives its own worktree, branch,
 * root and private data directory.
 */
export function makeWorkflowLaneFromTemplate(template: WorkflowLaneTemplate, jobId = `j-${randomUUID()}`): WorkflowLaneFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gc-workflow-session-')));
  const path = join(root, 'lane');
  const branch = `gru/${jobId}`;
  execFileSync('git', ['-C', template.repoPath, 'worktree', 'add', '-q', '-b', branch, path, template.sha], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const dataDir = join(root, 'private-data');
  mkdirSync(dataDir, { mode: 0o700 });
  return { root, dataDir, lane: issueFixtureHandoff({ id: jobId, jobId, kind: 'job', repoPath: template.repoPath,
    repoName: 'app', path, branch, sha: template.sha, roundId: null, status: 'active' }, standaloneFixtureLedger(jobId)) };
}
