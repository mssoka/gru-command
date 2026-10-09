import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The owner-run retirement commands in docs/BMAD-RUNTIME.md (issue #283),
 * executed VERBATIM from the doc against a disposable repository that has
 * the supported legacy layout: a repo-local install, proven and unproven
 * skill bindings, unrelated skills, custom settings, `_bmad-output` work,
 * the GC bootstrap record/copier/manifest block, and user setup commands.
 * Protected bytes must survive, the old framework must move aside
 * recoverably, a fresh worktree must render with the bundled runtime, and
 * the undo block must restore the original state.
 */

const repoRoot = join(import.meta.dirname, '..');
const doc = readFileSync(join(repoRoot, 'docs', 'BMAD-RUNTIME.md'), 'utf-8');

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanupDirs.push(dir);
  return dir;
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }).trim();
}

/** The fenced `sh` block whose first line is `# bmad-retire:<step>`. */
function docBlock(step: string): string {
  const blocks = [...doc.matchAll(/```sh\n([\s\S]*?)```/gu)].map((match) => match[1]!);
  const found = blocks.filter((block) => block.startsWith(`# bmad-retire:${step}\n`));
  if (found.length !== 1) throw new Error(`docs/BMAD-RUNTIME.md must hold exactly one bmad-retire:${step} block`);
  return found[0]!;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Every file and link under `root` (relative path → bytes / link target), .git excluded. */
function tree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (relative(root, path) === '.git') continue;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) out.set(relative(root, path), `link:${readlinkSync(path)}`);
      else if (info.isDirectory()) {
        if (readdirSync(path).length === 0) out.set(`${relative(root, path)}/`, 'empty-dir');
        visit(path);
      } else out.set(relative(root, path), readFileSync(path).toString('base64'));
    }
  };
  visit(root);
  return out;
}

const BLOCK = [
  '# BEGIN GRU COMMAND BMAD BOOTSTRAP',
  '[[setup]]',
  '# Fresh clones have no git-local BMAD source. Only onboarded repositories',
  '# run the generated copier; a configured but invalid source still fails loud.',
  'command = "if git config --local --get gru-command.bmad-source >/dev/null 2>&1; then node .gru-command/bmad-bootstrap.mjs; fi"',
  '# END GRU COMMAND BMAD BOOTSTRAP',
].join('\n');
// CRLF on purpose: the commands must handle Windows-edited manifests.
const USER_MANIFEST = '# User-owned setup survives retirement.\r\n[[setup]]\r\ncommand = "npm ci"\r\n\r\n[verify]\r\nfull = "npm test"\r\n';
const USER_EXCLUDE = '# local scratch\n/scratch/\n';

/** A repo-local install the way the retired onboarding left one. */
function legacyRepo(workspace: string): string {
  const repo = join(workspace, 'legacy-app');
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  write(join(repo, 'README.md'), '# legacy app\n');
  write(join(repo, '.gru-command', 'worktree.toml'), `${BLOCK.replaceAll('\n', '\r\n')}\r\n\r\n${USER_MANIFEST}`);
  write(join(repo, '.gru-command', 'bmad-bootstrap.mjs'), '#!/usr/bin/env node\n// Managed by Gru Command BMAD bootstrap v1\n');
  write(join(repo, '.gru-command', 'bmad-install.json'), `${JSON.stringify({
    managed_by: 'gru-command',
    installer: 'bmad-method@6.12.0',
    compatibility_patches: ['qualify-bmm-gds-short-config-tokens-v1'],
  }, null, 2)}\n`);
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'onboarded']);

  // Installer-generated framework (untracked, locally excluded).
  write(join(repo, '_bmad', '_config', 'manifest.yaml'), [
    'installation:', '  version: 6.12.0', 'modules:',
    ...['core', 'bmm', 'cis', 'tea', 'gds'].flatMap((name) => [`  - name: ${name}`, '    version: 6.12.0']),
    'ides:', '  - pi', '  - claude-code', '',
  ].join('\n'));
  for (const module of ['core', 'bmm', 'cis', 'tea', 'gds']) write(join(repo, '_bmad', module, 'config.yaml'), `${module}: installed\n`);
  write(join(repo, '_bmad', 'scripts', 'render_skill.py'), '# legacy renderer\n');
  write(join(repo, '_bmad', 'render', 'bmad-build', 'old', 'workflow.md'), '# old render\n');
  write(join(repo, '_bmad', 'config.toml'), [
    '[core]', 'project_name = "legacy-app"', 'document_output_language = "English"',
    'output_folder = "{project-root}/_bmad-output"', '',
    '[modules.bmm]', 'implementation_artifacts = "{project-root}/_bmad-output/implementation-artifacts"', '',
    '[modules.gds]', 'implementation_artifacts = "{project-root}/_bmad-output/game"', '',
  ].join('\n'));
  write(join(repo, '_bmad', 'config.user.toml'), '[core]\nuser_name = "Owner"\ncommunication_language = "Français"\n');
  write(join(repo, '_bmad', 'custom', '.gitignore'), '*.user.toml\n');
  write(join(repo, '_bmad', 'custom', 'config.toml'), '# Team / enterprise overrides for _bmad/config.toml.\n# [agents.bmad-agent-pm]\n');
  write(join(repo, '_bmad', 'custom', 'bmad-build.toml'), '# team customization stays\n');
  write(join(repo, '_bmad', '_memory', 'notes.md'), 'not part of the supported layout\n');

  // Skill bindings with the installer's own hash record.
  const bindings: Record<string, string> = {
    'bmad-build/SKILL.md': '---\nname: bmad-build\n---\nlegacy launcher\n',
    'bmad-build/review-prompts/edge-case-hunter.md': '# edge\n',
    'bmad-help/SKILL.md': '---\nname: bmad-help\n---\nhelp\n',
    'gds-quick-dev/SKILL.md': '---\nname: gds-quick-dev\n---\nquick dev\n',
    'gds-quick-dev/workflow.md': 'write to {{.implementation_artifacts}}\n',
  };
  const rows = ['type,name,module,path,hash'];
  for (const [rel, text] of Object.entries(bindings)) {
    const module = rel.startsWith('gds-') ? 'gds' : 'bmm';
    rows.push(`"md","x","${module}","${module}/skills/${rel}","${sha256(text)}"`);
  }
  // Module and script files are installer-recorded too; a user note and a
  // post-install edit inside module directories are not.
  for (const rel of ['core/config.yaml', 'bmm/config.yaml', 'cis/config.yaml', 'tea/config.yaml', 'gds/config.yaml', 'scripts/render_skill.py']) {
    rows.push(`"yaml","x","x","${rel}","${sha256(readFileSync(join(repo, '_bmad', rel), 'utf-8'))}"`);
  }
  write(join(repo, '_bmad', '_config', 'files-manifest.csv'), `${rows.join('\n')}\n`);
  write(join(repo, '_bmad', 'bmm', 'project-notes.md'), '# notes the team kept here\n');
  appendFileSync(join(repo, '_bmad', 'cis', 'config.yaml'), 'edited: after install\n');
  write(join(repo, '_bmad', '_config', 'skill-manifest.csv'), [
    'canonicalId,name,description,module,path',
    '"bmad-build","bmad-build","d","bmm","x"', '"bmad-help","bmad-help","d","core","x"', '"gds-quick-dev","gds-quick-dev","d","gds","x"',
    '"bmad-extra","bmad-extra","d","bmm","x"', '"gds-empty","gds-empty","d","gds","x"', '',
  ].join('\n'));
  for (const root of ['.agents/skills', '.claude/skills']) {
    for (const [rel, text] of Object.entries(bindings)) write(join(repo, root, rel), text);
  }
  // The retired onboarding's gds compatibility patch (still provably owned).
  write(join(repo, '.agents', 'skills', 'gds-quick-dev', 'workflow.md'), 'write to {{config.modules.gds.implementation_artifacts}}\n');
  // A user edit makes a BMAD-named binding unproven: it must stay.
  write(join(repo, '.claude', 'skills', 'bmad-help', 'SKILL.md'), '---\nname: bmad-help\n---\nmy local edit\n');
  // Installer-named bindings that are NOT provably installer-owned: one
  // carries a user-added symlinked directory, one is empty.
  const extraSkill = '---\nname: bmad-extra\n---\nextra\n';
  write(join(repo, '.agents', 'skills', 'bmad-extra', 'SKILL.md'), extraSkill);
  appendFileSync(join(repo, '_bmad', '_config', 'files-manifest.csv'), `"md","x","bmm","bmm/skills/bmad-extra/SKILL.md","${sha256(extraSkill)}"\n`);
  mkdirSync(join(workspace, 'user-assets'), { recursive: true });
  symlinkSync(join(workspace, 'user-assets'), join(repo, '.agents', 'skills', 'bmad-extra', 'assets'));
  mkdirSync(join(repo, '.claude', 'skills', 'gds-empty'), { recursive: true });
  // Unrelated skills.
  write(join(repo, '.agents', 'skills', 'my-skill', 'SKILL.md'), '# mine\n');
  write(join(repo, '.claude', 'skills', 'other-tool', 'SKILL.md'), '# other\n');
  // Generated work.
  write(join(repo, '_bmad-output', 'implementation-artifacts', 'spec-gh-1.md'), '# spec\n');
  write(join(repo, '_bmad-output', 'planning-artifacts', 'prd.md'), '# prd\n');

  git(repo, ['config', '--local', 'gru-command.bmad-source', repo]);
  const exclude = join(repo, '.git', 'info', 'exclude');
  write(exclude, `${USER_EXCLUDE}\n# BEGIN GRU COMMAND BMAD GENERATED\n/_bmad/_config/\n/.agents/skills/bmad-build/\n# END GRU COMMAND BMAD GENERATED\n`);
  return repo;
}

/**
 * The whole documented flow under one shell: preview, backup, move and
 * verify keep protected bytes, re-home settings, and a fresh worktree
 * renders with the bundled runtime; the undo block restores the original.
 */
function retirementFlow(shell: string): void {
  if (!existsSync(join(repoRoot, 'dist', 'cli', 'bmad-runtime.js'))) {
    throw new Error('dist/cli/bmad-runtime.js is missing: run `npm run build` first (the verify block calls the built CLI)');
  }
  const workspace = tempDir('gru-command-retire-ws-');
  const home = tempDir('gru-command-retire-home-');
  const repo = legacyRepo(workspace);
  const backup = join(home, '.gru-command', 'bmad-legacy-backups', 'legacy-app-test');
  const env = { PATH: process.env.PATH ?? '', HOME: home, REPO: repo, GC: repoRoot, BACKUP: backup };
  const run = (step: string) => {
    const result = spawnSync(shell, ['-c', docBlock(step)], { cwd: workspace, env, encoding: 'utf-8', timeout: 110_000 });
    return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };
  const lane = join(workspace, 'old-lane');
  git(repo, ['worktree', 'add', '-q', '--detach', lane]);

  const original = tree(repo);
  const originalExclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8');

  // Before retirement the bundled runtime refuses to drop the legacy answer.
  const halted = spawnSync('node', [join(repoRoot, 'dist', 'cli', 'bmad-runtime.js'), 'check', repo, '--store', join(home, 'store')], { env, encoding: 'utf-8' });
  expect(halted.status).toBe(1);
  expect(halted.stdout).toContain('legacy BMAD installer answer `core.communication_language`');

  const preview = run('preview');
  expect(preview.status, preview.out).toBe(0);
  expect(preview.out).toContain('move aside (framework): _bmad/_config, _bmad/render, _bmad/config.toml, _bmad/config.user.toml + 5 installer-recorded files under _bmad/{scripts,core,bmm,cis,tea,gds}');
  expect(preview.out).toContain("LEFT IN PLACE (not in the installer's hash record): _bmad/bmm/project-notes.md");
  expect(preview.out).toContain("LEFT IN PLACE (not in the installer's hash record): _bmad/cis/config.yaml");
  expect(preview.out).toContain('move aside (proven BMAD skill bindings): 5');
  expect(preview.out).toContain('LEFT IN PLACE (not provably installer-owned): .claude/skills/bmad-help');
  expect(preview.out).toContain('LEFT IN PLACE (not provably installer-owned): .agents/skills/bmad-extra');
  expect(preview.out).toContain('LEFT IN PLACE (not provably installer-owned): .claude/skills/gds-empty');
  expect(preview.out).toContain('keep installer answers for reference in _bmad/custom/legacy-install/');
  expect(preview.out).toContain('LEFT IN PLACE (not part of the supported layout): _bmad/_memory');
  expect(preview.out).toContain(`LANE: ${lane}`);
  expect(preview.out).toContain('.gru-command/bmad-install.json, .gru-command/bmad-bootstrap.mjs, worktree.toml block, local exclude block, git config gru-command.bmad-source');
  // The preview changed nothing in the repository.
  expect(tree(repo)).toEqual(original);
  git(repo, ['worktree', 'remove', '--force', lane]);

  const backedUp = run('backup');
  expect(backedUp.status, backedUp.out).toBe(0);
  const moved = run('move');
  expect(moved.status, moved.out).toBe(0);

  // The retired framework and proven bindings moved aside, recoverably.
  expect(readdirSync(join(repo, '_bmad')).sort()).toEqual(['_memory', 'bmm', 'cis', 'custom']);
  expect(readdirSync(join(repo, '_bmad', 'bmm'))).toEqual(['project-notes.md']);
  expect(readdirSync(join(repo, '_bmad', 'cis'))).toEqual(['config.yaml']);
  expect(readdirSync(join(repo, '_bmad', 'custom')).sort()).toEqual(['.gitignore', 'bmad-build.toml', 'config.toml', 'config.user.toml', 'legacy-install']);
  expect(readdirSync(join(repo, '.agents', 'skills')).sort()).toEqual(['bmad-extra', 'my-skill']);
  expect(readdirSync(join(repo, '.claude', 'skills')).sort()).toEqual(['bmad-help', 'gds-empty', 'other-tool']);
  expect(readlinkSync(join(repo, '.agents', 'skills', 'bmad-extra', 'assets'))).toBe(join(workspace, 'user-assets'));
  for (const rel of ['_bmad/_config/manifest.yaml', '_bmad/gds/config.yaml', '_bmad/scripts/render_skill.py', '_bmad/config.toml', '.agents/skills/bmad-build/SKILL.md',
    '.agents/skills/gds-quick-dev/workflow.md', '.claude/skills/bmad-build/SKILL.md', '.gru-command/bmad-install.json', '.gru-command/bmad-bootstrap.mjs']) {
    expect(readFileSync(join(backup, 'moved', rel)).toString('base64'), rel).toBe(original.get(rel));
  }
  // GC-owned bootstrap references are gone; user-owned content is byte-identical.
  expect(readFileSync(join(repo, '.gru-command', 'worktree.toml'), 'utf-8')).toBe(USER_MANIFEST);
  expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8')).toBe(USER_EXCLUDE);
  expect(spawnSync('git', ['-C', repo, 'config', '--local', '--get', 'gru-command.bmad-source']).status).toBe(1);
  // Protected bytes: generated work, customization, unrelated and unproven skills.
  for (const rel of ['_bmad-output/implementation-artifacts/spec-gh-1.md', '_bmad-output/planning-artifacts/prd.md',
    '_bmad/bmm/project-notes.md', '_bmad/cis/config.yaml',
    '_bmad/custom/bmad-build.toml', '_bmad/custom/.gitignore', '_bmad/_memory/notes.md', '.agents/skills/my-skill/SKILL.md',
    '.claude/skills/other-tool/SKILL.md', '.claude/skills/bmad-help/SKILL.md', 'README.md']) {
    expect(readFileSync(join(repo, rel)).toString('base64'), rel).toBe(original.get(rel));
  }
  // Legacy answers that differ from GC defaults were re-homed into _bmad/custom/.
  const team = readFileSync(join(repo, '_bmad', 'custom', 'config.toml'), 'utf-8');
  expect(team.startsWith(Buffer.from(original.get('_bmad/custom/config.toml')!, 'base64').toString('utf-8'))).toBe(true);
  expect(team).toContain('[core]\nproject_name = "legacy-app"\n');
  expect(team).not.toContain('document_output_language');
  expect(team).not.toContain('modules.gds');
  expect(readFileSync(join(repo, '_bmad', 'custom', 'config.user.toml'), 'utf-8'))
    .toContain('[core]\ncommunication_language = "Français"\nuser_name = "Owner"\n');
  // Every legacy answer, including modules GC does not bundle, stays in the
  // project verbatim for reference.
  for (const name of ['config.toml', 'config.user.toml']) {
    expect(readFileSync(join(repo, '_bmad', 'custom', 'legacy-install', name)).toString('base64'), name)
      .toBe(original.get(`_bmad/${name}`));
  }

  const verified = run('verify');
  expect(verified.status, verified.out).toBe(0);
  expect(verified.out).toMatch(/ok: \d+ protected files unchanged/u);
  expect(verified.out).toContain(`ok bmad-build: read and follow ${repo}/_bmad/render/bmad-build/`);
  // Step 6: commit the tracked changes, then a fresh worktree of HEAD renders.
  git(repo, ['add', '-u']);
  git(repo, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'retire repo-local BMAD']);
  expect(git(repo, ['show', 'HEAD:.gru-command/worktree.toml'])).toBe(USER_MANIFEST.trimEnd());
  const fresh = run('fresh-worktree');
  expect(fresh.status, fresh.out).toBe(0);
  expect(fresh.out).toMatch(/^ok bmad-build: read and follow \/.+\/verify-worktree\/_bmad\/render\/bmad-build\/.+\/workflow\.md$/mu);
  expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain('verify-worktree');
  // The re-homed personal setting now reaches the rendered workflow.
  const check = spawnSync('node', [join(repoRoot, 'dist', 'cli', 'bmad-runtime.js'), 'check', repo, '--store', join(home, 'store')], { env, encoding: 'utf-8' });
  expect(check.status, check.stdout).toBe(0);
  const generation = /read and follow (\/\S+)\/workflow\.md/u.exec(check.stdout)![1]!;
  expect(readFileSync(join(generation, 'step-04-review.md'), 'utf-8')).toContain('Speak in `Français`');

  const restored = run('restore');
  expect(restored.status, restored.out).toBe(0);
  const after = tree(repo);
  // Everything returns byte-for-byte (the new render cache aside).
  for (const [rel, bytes] of original) expect(after.get(rel), rel).toBe(bytes);
  expect([...after.keys()].filter((rel) => !original.has(rel) && !rel.startsWith('_bmad/render/'))).toEqual([]);
  expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf-8')).toBe(originalExclude);
  expect(git(repo, ['config', '--local', '--get', 'gru-command.bmad-source'])).toBe(repo);
}

describe('retiring a repo-local BMAD install with the documented commands', () => {
  it('sh: the documented flow retires the install, keeps protected bytes, and undo restores it', () => {
    retirementFlow('/bin/sh');
  });

  it.skipIf(!existsSync('/bin/bash'))('bash: the same documented flow passes', () => {
    retirementFlow('/bin/bash');
  });

  it.skipIf(!existsSync('/bin/zsh'))('zsh (the owner shell): the same documented flow passes', () => {
    retirementFlow('/bin/zsh');
  });

  it('undo removes a _bmad/custom the retirement created; a hand merge unblocks a blocked preview', () => {
    const run = (step: string, env: NodeJS.ProcessEnv) => {
      const result = spawnSync('/bin/sh', ['-c', docBlock(step)], { env, encoding: 'utf-8', timeout: 110_000 });
      return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
    };
    const base = (home: string, repo: string, backup: string) =>
      ({ PATH: process.env.PATH ?? '', HOME: home, REPO: repo, GC: repoRoot, BACKUP: backup });

    // No _bmad/custom before retirement: undo must not leave the created one.
    const absentWs = tempDir('gru-command-retire-absent-');
    const absent = legacyRepo(absentWs);
    rmSync(join(absent, '_bmad', 'custom'), { recursive: true });
    const original = tree(absent);
    const absentEnv = base(absentWs, absent, join(absentWs, 'backup'));
    for (const step of ['preview', 'backup', 'move']) expect(run(step, absentEnv).status, step).toBe(0);
    expect(existsSync(join(absent, '_bmad', 'custom', 'config.toml'))).toBe(true);
    expect(run('restore', absentEnv).status).toBe(0);
    expect(existsSync(join(absent, '_bmad', 'custom'))).toBe(false);
    expect(tree(absent)).toEqual(original);

    // A custom file that already holds settings blocks re-homing until the
    // owner merges the pending answers by hand; then the preview passes.
    const mergeWs = tempDir('gru-command-retire-merge-');
    const merge = legacyRepo(mergeWs);
    writeFileSync(join(merge, '_bmad', 'custom', 'config.toml'), '[core]\nuser_name = "Team"\n');
    const blocked = run('preview', base(mergeWs, merge, join(mergeWs, 'backup-1')));
    expect(blocked.status).toBe(0);
    expect(blocked.out).toContain('STOP before step 3: _bmad/custom/config.toml: add {"core.project_name": "legacy-app"} by hand');
    expect(run('backup', base(mergeWs, merge, join(mergeWs, 'backup-1'))).out).toContain('STOP: merge these settings by hand first');
    writeFileSync(join(merge, '_bmad', 'custom', 'config.toml'), '[core]\nuser_name = "Team"\nproject_name = "legacy-app"\n');
    const unblocked = run('preview', base(mergeWs, merge, join(mergeWs, 'backup-2')));
    expect(unblocked.status, unblocked.out).toBe(0);
    expect(unblocked.out).not.toContain('STOP');
    expect(run('backup', base(mergeWs, merge, join(mergeWs, 'backup-2'))).status).toBe(0);
    expect(readFileSync(join(merge, '_bmad', 'custom', 'config.toml'), 'utf-8')).toBe('[core]\nuser_name = "Team"\nproject_name = "legacy-app"\n');

    // Answers transfer layered like the installer read them: a team value a
    // personal answer set back to the default keeps that personal override.
    const layeredWs = tempDir('gru-command-retire-layered-');
    const layered = legacyRepo(layeredWs);
    writeFileSync(join(layered, '_bmad', 'config.toml'), '[core]\ndocument_output_language = "Deutsch"\n');
    writeFileSync(join(layered, '_bmad', 'config.user.toml'), '[core]\ndocument_output_language = "English"\n');
    const layeredEnv = base(layeredWs, layered, join(layeredWs, 'backup'));
    for (const step of ['preview', 'backup']) expect(run(step, layeredEnv).status, step).toBe(0);
    expect(readFileSync(join(layered, '_bmad', 'custom', 'config.toml'), 'utf-8')).toContain('[core]\ndocument_output_language = "Deutsch"\n');
    expect(readFileSync(join(layered, '_bmad', 'custom', 'config.user.toml'), 'utf-8')).toContain('[core]\ndocument_output_language = "English"\n');
    // A proven binding edited after the preview stops the move before anything moves.
    writeFileSync(join(layered, '.agents', 'skills', 'bmad-build', 'SKILL.md'), '---\nname: bmad-build\n---\nedited after preview\n');
    const stale = run('move', layeredEnv);
    expect(stale.status).not.toBe(0);
    expect(stale.out).toContain('STOP: changed since the preview, re-run it: .agents/skills/bmad-build/SKILL.md');
    expect(existsSync(join(layered, '_bmad', '_config', 'manifest.yaml'))).toBe(true);
  });

  it('the preview refuses a repository without a repo-local install and a backup inside the repository', () => {
    const workspace = tempDir('gru-command-retire-refuse-');
    const repo = join(workspace, 'plain');
    mkdirSync(repo);
    git(repo, ['init', '-q']);
    const preview = (backup: string) => spawnSync('/bin/sh', ['-c', docBlock('preview')], {
      env: { PATH: process.env.PATH ?? '', HOME: workspace, REPO: repo, GC: repoRoot, BACKUP: backup },
      encoding: 'utf-8',
    });
    const none = preview(join(workspace, 'backup'));
    expect(none.status).not.toBe(0);
    expect(none.stderr).toContain('STOP: no repo-local BMAD install');
    const inside = preview(join(repo, 'backup'));
    expect(inside.status).not.toBe(0);
    expect(inside.stderr).toContain('STOP: BACKUP must be outside the repository');
    // Settings are never re-homed through a link out of the repository.
    const linkedWs = tempDir('gru-command-retire-linked-');
    const linked = legacyRepo(linkedWs);
    rmSync(join(linked, '_bmad', 'custom'), { recursive: true });
    mkdirSync(join(linkedWs, 'elsewhere'));
    symlinkSync(join(linkedWs, 'elsewhere'), join(linked, '_bmad', 'custom'));
    const linkedPreview = spawnSync('/bin/sh', ['-c', docBlock('preview')], {
      env: { PATH: process.env.PATH ?? '', HOME: linkedWs, REPO: linked, GC: repoRoot, BACKUP: join(linkedWs, 'backup') },
      encoding: 'utf-8',
    });
    expect(linkedPreview.status).not.toBe(0);
    expect(linkedPreview.stderr).toContain('STOP: _bmad/custom is a symlink');
    const previewOf = (repoPath: string, home: string) => spawnSync('/bin/sh', ['-c', docBlock('preview')], {
      env: { PATH: process.env.PATH ?? '', HOME: home, REPO: repoPath, GC: repoRoot, BACKUP: join(home, 'backup') },
      encoding: 'utf-8',
    });
    const linkedManifestWs = tempDir('gru-command-retire-linked-manifest-');
    const linkedManifest = legacyRepo(linkedManifestWs);
    rmSync(join(linkedManifest, '.gru-command', 'worktree.toml'));
    writeFileSync(join(linkedManifestWs, 'elsewhere.toml'), '');
    symlinkSync(join(linkedManifestWs, 'elsewhere.toml'), join(linkedManifest, '.gru-command', 'worktree.toml'));
    expect(previewOf(linkedManifest, linkedManifestWs).stderr).toContain('STOP: .gru-command/worktree.toml is a symlink');
    const unrecordedWs = tempDir('gru-command-retire-unrecorded-');
    const unrecorded = legacyRepo(unrecordedWs);
    rmSync(join(unrecorded, '_bmad', '_config', 'files-manifest.csv'));
    expect(previewOf(unrecorded, unrecordedWs).stderr).toContain('STOP: _bmad/_config/files-manifest.csv is missing');
  });
});
