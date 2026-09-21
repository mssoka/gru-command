#!/usr/bin/env node
/**
 * Opt-in real official BMAD onboarding proof. Runs only in a scratch Git repo,
 * installs the pinned four-module set, bootstraps a detached fresh worktree,
 * and invokes the project-local bmad-build renderer without global skill paths.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { join } from 'node:path';
import { parseAnswers } from '../dist/wizard/answers.js';
import { onboardBmadRepo } from '../dist/wizard/bmad-onboarding.js';
import { applyWorktreeManifest, loadWorktreeManifest } from '../dist/worktrees/manifest.js';

if (process.env.GRU_TEST_REAL_BMAD !== '1') {
  process.stderr.write('Set GRU_TEST_REAL_BMAD=1 to run the isolated official-network rehearsal.\n');
  process.exit(2);
}

const stage = mkdtempSync(join(tmpdir(), 'gru-command-real-bmad-'));
const workspace = join(stage, 'workspace');
const repo = join(workspace, 'selected-repo');
const worktree = join(workspace, 'fresh-worktree');
const git = (cwd, args, options = {}) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8', ...options }).trim();
try {
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, 'README.md'), '# isolated BMAD proof\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);

  const answers = parseAnswers(JSON.stringify({
    workspace_root: workspace,
    repos: ['selected-repo'],
    bmad: { 'selected-repo': 'install' },
    runtime: 'pi',
    smoke: false,
  }));
  const installed = onboardBmadRepo('selected-repo', 'install', { workspaceRoot: workspace, answers });
  if (!installed.ready) throw new Error(installed.message);

  git(repo, ['add', '.gru-command']);
  git(repo, [
    '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-qm', 'track Gru BMAD bootstrap',
  ]);
  git(repo, ['worktree', 'add', worktree, 'HEAD']);
  const manifest = loadWorktreeManifest(repo);
  if (manifest === null) throw new Error('worktree manifest missing after onboarding');
  applyWorktreeManifest(manifest, { sourceRoot: repo, worktreePath: worktree, setupTimeoutMs: 120_000 });

  const skill = join(worktree, '.agents', 'skills', 'bmad-build');
  const renderer = join(worktree, '_bmad', 'scripts', 'render_skill.py');
  if (!existsSync(join(skill, 'SKILL.md')) || !existsSync(renderer)) {
    throw new Error('fresh worktree did not discover project-local bmad-build/renderer');
  }
  if (!realpathSync(skill).startsWith(realpathSync(worktree))) {
    throw new Error('fresh worktree skill resolved outside the isolated worktree');
  }
  // bmad-review gate ruling (fork-3 extension): the default pinned module set
  // must carry the project-local bmad-review skill so a default-onboarded user
  // can gate on it — 0 blockers = clear to merge; blockers route back to the
  // implementing minion as fix directives, never inform-only. Perkins stays the
  // stronger exact-head gate with autonomous-merge authority.
  const reviewSkill = join(worktree, '.agents', 'skills', 'bmad-review', 'SKILL.md');
  if (!existsSync(reviewSkill) || lstatSync(reviewSkill).isSymbolicLink() || !statSync(reviewSkill).isFile()) {
    throw new Error('fresh worktree lacks the project-local bmad-review gate skill');
  }
  if (!realpathSync(reviewSkill).startsWith(realpathSync(worktree))) {
    throw new Error('fresh worktree bmad-review resolved outside the isolated worktree');
  }
  const rendered = execFileSync(
    'uv',
    ['run', '--no-cache', renderer, '--project-root', worktree, '--skill', skill],
    { cwd: worktree, encoding: 'utf-8', timeout: 120_000 },
  ).trim();
  const workflowPath = rendered.match(/(?:read and follow|follow)\s+(.+\/workflow\.md)$/m)?.[1];
  if (workflowPath === undefined || !existsSync(workflowPath)) {
    throw new Error(`project-local bmad-build renderer did not emit a workflow path: ${rendered}`);
  }
  const record = JSON.parse(readFileSync(join(repo, '.gru-command', 'bmad-install.json'), 'utf-8'));
  if (!(record.runtime_skills?.pi ?? []).includes('bmad-review')) {
    throw new Error('BMAD record does not carry bmad-review in runtime_skills');
  }
  process.stdout.write(
    `PASS official BMAD onboarding modules=${record.modules.map((m) => `${m.name}@${m.version}`).join(',')} ` +
      `tools=${record.tools.join(',')} review=bmad-review fresh_worktree=${worktree} renderer=${workflowPath}\n`,
  );
  git(repo, ['worktree', 'remove', '--force', worktree]);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
