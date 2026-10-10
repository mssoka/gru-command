import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseAnswers } from '../src/wizard/answers.js';
import { applyWorktreeManifest, loadWorktreeManifest } from '../src/worktrees/manifest.js';

// Historical filename; GH-295 replaces BMAD provisioning with read-only GC setup.
const packageRoot = join(import.meta.dirname, '..');
const cleanup: string[] = [];
afterAll(() => { for (const path of cleanup) rmSync(path, { recursive: true, force: true }); });
function temp(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'gc-setup-295-')));
  cleanup.push(path);
  return path;
}
function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }).trim();
}
function fixture() {
  const workspace = temp();
  const repo = join(workspace, 'app');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  write(join(repo, 'README.md'), '# app\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
  return { workspace, repo, home: temp() };
}
function tree(root: string): Readonly<Record<string, string>> {
  const entries: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path);
      if (rel === '.git') continue;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) entries[rel] = `link:${readlinkSync(path)}`;
      else if (info.isDirectory()) { entries[`${rel}/`] = 'directory'; visit(path); }
      else entries[rel] = readFileSync(path).toString('base64');
    }
  };
  visit(root);
  return entries;
}
function run(f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [join(packageRoot, 'dist/wizard/main.js'), '--force', '--answers', JSON.stringify({
    workspace_root: f.workspace, repos: ['app'], runtime: 'pi', port: 0, smoke: false, ...extra,
  })], { encoding: 'utf-8', timeout: 30_000, env: { ...process.env, HOME: f.home, GRU_COMMAND_HOME: f.home, ...env } });
}
const BOOTSTRAP = [
  '# BEGIN GRU COMMAND BMAD BOOTSTRAP', '[[setup]]',
  '# Fresh clones have no git-local BMAD source. Only onboarded repositories',
  '# run the generated copier; a configured but invalid source still fails loud.',
  'command = "if git config --local --get gru-command.bmad-source >/dev/null 2>&1; then node .gru-command/bmad-bootstrap.mjs; fi"',
  '# END GRU COMMAND BMAD BOOTSTRAP', '',
].join('\n');

function ready(f: ReturnType<typeof fixture>, env: NodeJS.ProcessEnv = {}): void {
  const before = tree(f.repo);
  const result = run(f, {}, env);
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.stdout).toContain('Repository ready in app');
  expect(result.stdout).not.toContain('BMAD ready');
  expect(tree(f.repo)).toEqual(before);
  expect(existsSync(join(f.home, 'config.toml'))).toBe(true);
}

describe('BMAD-agnostic GC repository setup (#295)', () => {
  it('fresh headless setup has no BMAD keys, state, renderer or global skill prerequisite', () => {
    const f = fixture();
    const bin = temp();
    const marker = join(bin, 'unexpected-renderer');
    for (const tool of ['uv', 'python3']) {
      writeFileSync(join(bin, tool), `#!/bin/sh\nprintf invoked >> '${marker}'\nexit 99\n`, { mode: 0o755 });
    }
    ready(f, { PATH: `${bin}:${process.env.PATH ?? ''}` });
    expect(existsSync(marker)).toBe(false);
    for (const name of ['_bmad', '_bmad-output', '.agents', '.claude', 'gru-output']) {
      expect(existsSync(join(f.repo, name)), name).toBe(false);
    }
  });

  it('repeated setup preserves healthy BMAD bytes, unrelated skills, custom settings and project knowledge', () => {
    const f = fixture();
    for (const [rel, text] of Object.entries({
      '_bmad/_config/manifest.yaml': 'installation:\n  version: 6.12.0\n',
      '_bmad/custom/config.toml': '[core]\ncommunication_language = "Deutsch"\n',
      '_bmad/scripts/render_skill.py': '# independently installed\n',
      '_bmad-output/brief.md': '# historical spec\n',
      'gru-output/design.md': '# approved design\n',
      '.agents/skills/mine/SKILL.md': '# unrelated skill\n',
      '.claude/skills/bmad-build/SKILL.md': '# user launcher\n',
      '.gru-command/worktree.toml': '[[setup]]\ncommand = "echo custom setup"\n',
    })) write(join(f.repo, rel), text);
    ready(f);
    ready(f);
  });

  it('incomplete, conflicting, malformed and wrong-kind BMAD installations are not GC configuration', () => {
    for (const files of [
      { '_bmad': 'not a directory\n' },
      { '_bmad/custom/config.toml': '[core\nbroken = \n', '_bmad/config.toml': 'conflicting???\n' },
      { '_bmad/_config/manifest.yaml': 'incomplete\n', '_bmad/custom/bmad-build.toml': '[[wrong\n' },
      { '_bmad/config.toml': '[core]\ncommunication_language = "Français"\n', '_bmad/custom/config.toml': '[core]\ncommunication_language = 7\n' },
    ]) {
      const f = fixture();
      for (const [rel, text] of Object.entries(files)) write(join(f.repo, rel), text!);
      ready(f);
    }
  });

  it('linked and dangling user BMAD paths are left untouched, including their external targets', () => {
    for (const dangling of [false, true]) {
      const f = fixture();
      const external = temp();
      write(join(external, 'keep.toml'), 'user bytes\n');
      symlinkSync(dangling ? join(external, 'missing') : external, join(f.repo, '_bmad'));
      symlinkSync(external, join(f.repo, '_bmad-output'));
      const before = tree(external);
      ready(f);
      expect(tree(external)).toEqual(before);
    }
  });

  it('obsolete headless BMAD answers require explicit removal before any config or repo writes', () => {
    const f = fixture();
    for (const bmad of [{}, null, { app: 'provision' }, { app: 'skip' }, { app: 'install' }, { app: 'reuse' }]) {
      const before = tree(f.repo);
      const result = run(f, { bmad });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('answers.bmad is retired');
      expect(result.stderr).toContain('Remove the bmad key');
      expect(result.stderr).not.toContain('Install BMAD');
      expect(tree(f.repo)).toEqual(before);
      expect(existsSync(join(f.home, 'config.toml'))).toBe(false);
    }
  });

  it('unknown general answer fields remain fail-loud, never silently discarded', () => {
    expect(() => parseAnswers('{"frobnicate":1}')).toThrow(/unknown answers key `frobnicate`/u);
  });

  it('a ghost .git directory is not a usable repository and config remains unwritten', () => {
    const f = fixture();
    rmSync(join(f.repo, '.git'), { recursive: true });
    mkdirSync(join(f.repo, '.git'));
    const other = fixture();
    for (const env of [{}, { GIT_DIR: join(other.repo, '.git'), GIT_WORK_TREE: other.repo }]) {
      const result = run(f, {}, env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('GC repository setup');
      expect(result.stderr).toContain('not a usable Git repo');
      expect(existsSync(join(f.home, 'config.toml'))).toBe(false);
    }
  });

  it('GC repository-root validation refuses selected symlinks, not user BMAD links', () => {
    const f = fixture();
    const original = join(f.workspace, 'original');
    execFileSync('mv', [f.repo, original]);
    symlinkSync(original, f.repo);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('selected repo is a symlink');
    expect(result.stderr).not.toContain('BMAD writes');
    expect(existsSync(join(f.home, 'config.toml'))).toBe(false);
  });

  it('malformed GC manifests still fail with GC setup guidance before config writes', () => {
    const f = fixture();
    write(join(f.repo, '.gru-command/worktree.toml'), '[broken\n');
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('worktree manifest');
    expect(existsSync(join(f.home, 'config.toml'))).toBe(false);
  });

  it('obsolete GC-owned bootstrap references require deliberate owner-run retirement, not reinstallation', () => {
    const f = fixture();
    write(join(f.repo, '.gru-command/worktree.toml'), BOOTSTRAP);
    const before = tree(f.repo);
    const result = run(f);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('retired GC-managed BMAD bootstrap');
    expect(result.stderr).toContain('docs/BMAD-RUNTIME.md');
    expect(tree(f.repo)).toEqual(before);
    expect(existsSync(join(f.home, 'config.toml'))).toBe(false);
  });

  it('fresh job worktrees have no GC-created BMAD; explicit foreign BMAD setup commands stay authoritative', async () => {
    const f = fixture();
    write(join(f.repo, '.gru-command/worktree.toml'), '[[setup]]\ncommand = "printf user-owned-BMAD > setup-proof"\n');
    ready(f);
    git(f.repo, 'add', '.');
    git(f.repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'user setup');
    const lane = join(f.workspace, 'job');
    git(f.repo, 'worktree', 'add', '-q', '--detach', lane, 'HEAD');
    await applyWorktreeManifest(loadWorktreeManifest(f.repo)!, { sourceRoot: f.repo, worktreePath: lane, setupTimeoutMs: 10_000 });
    expect(readFileSync(join(lane, 'setup-proof'), 'utf-8')).toBe('user-owned-BMAD');
    for (const name of ['_bmad', '_bmad-output', '.agents', '.claude']) expect(existsSync(join(lane, name)), name).toBe(false);
    git(f.repo, 'worktree', 'remove', '--force', lane);
  });

  it('already-running lanes retain original historical paths, private records and bindings', () => {
    const f = fixture();
    const lane = join(f.workspace, 'active');
    git(f.repo, 'worktree', 'add', '-q', '--detach', lane, 'HEAD');
    write(join(lane, '_bmad-output/active-spec.md'), '# historical job\n');
    write(join(lane, '.agents/skills/bmad-build/SKILL.md'), '# original bound launcher\n');
    const privateDir = git(lane, 'rev-parse', '--path-format=absolute', '--git-dir');
    const record = join(privateDir, 'gru-command/bmad-runtime.json');
    write(record, '{"runtime":"original"}\n');
    const before = tree(lane);
    ready(f);
    expect(tree(lane)).toEqual(before);
    expect(readFileSync(record, 'utf-8')).toBe('{"runtime":"original"}\n');
    git(f.repo, 'worktree', 'remove', '--force', lane);
  });
});
