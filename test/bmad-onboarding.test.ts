import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadBundledBmadRuntime } from '../src/bmad/runtime.js';
import { AnswersError, parseAnswers } from '../src/wizard/answers.js';
import {
  BMAD_CUSTOM_GITIGNORE,
  BMAD_RENDER_GITIGNORE,
  bmadToolsForAnswers,
  commandAvailable,
  onboardBmadRepo as onboardBmadRepoImpl,
} from '../src/wizard/bmad-onboarding.js';

/**
 * Per-selected-repo BMAD provisioning (issue #283). GC ships the BMAD
 * framework; onboarding only creates the missing project-local state and
 * never modifies anything that exists — a legacy repo-local install,
 * seeded `_bmad-output` work, project settings and unrelated skills keep
 * their exact bytes.
 */

const repoRoot = join(import.meta.dirname, '..');
const runtime = loadBundledBmadRuntime(repoRoot);

const onboardBmadRepo = (
  ...args: Parameters<typeof onboardBmadRepoImpl>
): ReturnType<typeof onboardBmadRepoImpl> => {
  const [repoName, action, options] = args;
  return onboardBmadRepoImpl(repoName, action, {
    prerequisiteCheck: () => true,
    runtime: () => runtime,
    ...options,
  });
};

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function git(repo: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }).trim();
}

function fixtureRepo(name = 'repo-a'): { workspace: string; repo: string; name: string } {
  const workspace = tempDir('gru-command-bmad-workspace-');
  const repo = join(workspace, name);
  mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q']);
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']);
  return { workspace, repo, name };
}

function answers(workspace: string, repo: string, action: 'provision' | 'skip' = 'provision') {
  return parseAnswers(JSON.stringify({
    workspace_root: workspace,
    repos: [repo],
    bmad: { [repo]: action },
    runtime: 'pi',
    smoke: false,
  }));
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Byte-level snapshot of a repo tree (minus .git): any mutation shows up. */
function snapshot(repo: string): string {
  const parts: string[] = [];
  const visit = (path: string): void => {
    const info = lstatSync(path);
    const rel = relative(repo, path);
    if (rel === '.git') return;
    if (info.isSymbolicLink()) parts.push(`l\0${rel}\0${readlinkSync(path)}`);
    else if (info.isDirectory()) {
      parts.push(`d\0${rel}`);
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else parts.push(`f\0${rel}\0${readFileSync(path).toString('base64')}`);
  };
  if (present(repo)) visit(repo);
  return parts.join('\n');
}

/** A repo-local install as the retired onboarding left it (abridged). */
function seedLegacyInstall(repo: string): void {
  for (const module of ['core', 'bmm', 'cis', 'tea', 'gds']) {
    mkdirSync(join(repo, '_bmad', module), { recursive: true });
    writeFileSync(join(repo, '_bmad', module, 'config.yaml'), `${module}: legacy\n`);
  }
  mkdirSync(join(repo, '_bmad', '_config'), { recursive: true });
  writeFileSync(join(repo, '_bmad', '_config', 'manifest.yaml'), 'installation:\n  version: 6.12.0\n');
  mkdirSync(join(repo, '_bmad', 'scripts'), { recursive: true });
  writeFileSync(join(repo, '_bmad', 'scripts', 'render_skill.py'), '# legacy renderer\n');
  writeFileSync(join(repo, '_bmad', 'config.toml'), '[core]\nproject_name = "legacy"\n');
  mkdirSync(join(repo, '_bmad', 'custom'), { recursive: true });
  writeFileSync(join(repo, '_bmad', 'custom', '.gitignore'), '*.user.toml\n');
  writeFileSync(join(repo, '_bmad', 'custom', 'bmad-build.toml'), '# team customization\n');
  for (const root of ['.agents', '.claude']) {
    mkdirSync(join(repo, root, 'skills', 'bmad-build'), { recursive: true });
    writeFileSync(join(repo, root, 'skills', 'bmad-build', 'SKILL.md'), '# legacy build\n');
  }
  mkdirSync(join(repo, '.gru-command'), { recursive: true });
  writeFileSync(join(repo, '.gru-command', 'bmad-install.json'), '{"managed_by":"gru-command"}\n');
}

describe('per-selected-repo BMAD provisioning (GC-managed runtime)', () => {
  it('a fresh repo gets exactly the missing project state and stays git-clean but for the custom ignore', () => {
    const fixture = fixtureRepo('fresh');
    const result = onboardBmadRepo(fixture.name, 'provision', {
      workspaceRoot: fixture.workspace,
      answers: answers(fixture.workspace, fixture.name),
    });
    expect(result.ready, result.message).toBe(true);
    expect(result.runtimeId).toBe(runtime.id);
    expect(result.message).toContain(`GC-managed BMAD runtime ${runtime.id}`);
    expect(readFileSync(join(fixture.repo, '_bmad', 'custom', '.gitignore'), 'utf-8')).toBe(BMAD_CUSTOM_GITIGNORE);
    expect(readFileSync(join(fixture.repo, '_bmad', 'render', '.gitignore'), 'utf-8')).toBe(BMAD_RENDER_GITIGNORE);
    for (const dir of ['_bmad-output', '_bmad-output/planning-artifacts', '_bmad-output/implementation-artifacts']) {
      expect(lstatSync(join(fixture.repo, dir)).isDirectory(), dir).toBe(true);
    }
    // No repo-local framework, no bindings, no GC bootstrap/record files.
    for (const absent of ['_bmad/_config', '_bmad/scripts', '_bmad/config.toml', '.agents', '.claude', '.gru-command']) {
      expect(existsSync(join(fixture.repo, absent)), absent).toBe(false);
    }
    expect(git(fixture.repo, ['status', '--porcelain', '--untracked-files=all'])).toBe('?? _bmad/custom/.gitignore');
  });

  it('re-provisioning preserves seeded _bmad-output work, project settings and unrelated skills byte-for-byte', () => {
    const fixture = fixtureRepo('repeat');
    const options = { workspaceRoot: fixture.workspace, answers: answers(fixture.workspace, fixture.name) };
    expect(onboardBmadRepo(fixture.name, 'provision', options).ready).toBe(true);
    mkdirSync(join(fixture.repo, '_bmad-output', 'implementation-artifacts'), { recursive: true });
    writeFileSync(join(fixture.repo, '_bmad-output', 'implementation-artifacts', 'spec-gh-1.md'), '# spec\n');
    mkdirSync(join(fixture.repo, '_bmad-output', 'evidence'), { recursive: true });
    writeFileSync(join(fixture.repo, '_bmad-output', 'evidence', 'run.log'), 'evidence\n');
    writeFileSync(join(fixture.repo, '_bmad', 'custom', 'config.toml'), '[core]\nproject_name = "kept"\n');
    writeFileSync(join(fixture.repo, '_bmad', 'custom', 'bmad-build.user.toml'), '# personal\n');
    writeFileSync(join(fixture.repo, '_bmad', 'custom', '.gitignore'), '# edited by the team\n*.user.toml\n');
    for (const root of ['.agents', '.claude']) {
      mkdirSync(join(fixture.repo, root, 'skills', 'my-skill'), { recursive: true });
      writeFileSync(join(fixture.repo, root, 'skills', 'my-skill', 'SKILL.md'), `# ${root} skill\n`);
    }
    const before = snapshot(fixture.repo);
    const again = onboardBmadRepo(fixture.name, 'provision', options);
    expect(again.ready, again.message).toBe(true);
    expect(again.message).toContain('created nothing');
    expect(snapshot(fixture.repo)).toBe(before);
  });

  it('a pre-existing repo-local install is preserved untouched and reported as legacy', () => {
    const fixture = fixtureRepo('legacy');
    seedLegacyInstall(fixture.repo);
    mkdirSync(join(fixture.repo, '_bmad-output', 'specs'), { recursive: true });
    writeFileSync(join(fixture.repo, '_bmad-output', 'specs', 'brief.md'), '# brief\n');
    const before = snapshot(fixture.repo).split('\n');
    const result = onboardBmadRepo(fixture.name, 'provision', {
      workspaceRoot: fixture.workspace,
      answers: answers(fixture.workspace, fixture.name),
    });
    expect(result.ready, result.message).toBe(true);
    expect(result.message).toContain('legacy repo-local BMAD install left unchanged');
    expect(result.message).toContain('docs/BMAD-RUNTIME.md');
    // Only missing entries were added; every pre-existing byte survives.
    const after = snapshot(fixture.repo).split('\n');
    for (const line of before) expect(after).toContain(line);
    expect(after.filter((line) => !before.includes(line)).map((line) => line.split('\0')[1]).sort()).toEqual([
      '_bmad-output/implementation-artifacts',
      '_bmad-output/planning-artifacts',
      '_bmad/render',
      '_bmad/render/.gitignore',
    ]);
  });

  it('creates the output folders the project configures inside the repo, never outside it', () => {
    const fixture = fixtureRepo('configured');
    mkdirSync(join(fixture.repo, '_bmad', 'custom'), { recursive: true });
    writeFileSync(join(fixture.repo, '_bmad', 'custom', 'config.toml'), [
      '[core]',
      'output_folder = "{project-root}/work"',
      '[modules.bmm]',
      'planning_artifacts = "{project-root}/work/plans"',
      'implementation_artifacts = "{project-root}/../outside-the-repo"',
      '',
    ].join('\n'));
    writeFileSync(
      join(fixture.repo, '_bmad', 'custom', 'config.user.toml'),
      `[modules.bmm]\nplanning_artifacts = "{project-root}/mine/plans"\nimplementation_artifacts = ${JSON.stringify(join(realpathSync(fixture.repo), 'absolute', 'work'))}\n`,
    );
    const result = onboardBmadRepo(fixture.name, 'provision', {
      workspaceRoot: fixture.workspace,
      answers: answers(fixture.workspace, fixture.name),
    });
    expect(result.ready, result.message).toBe(true);
    expect(lstatSync(join(fixture.repo, 'work')).isDirectory()).toBe(true);
    // The personal layer wins over the team layer, as in the renderer.
    expect(lstatSync(join(fixture.repo, 'mine', 'plans')).isDirectory()).toBe(true);
    // An absolute path inside the repo needs no placeholder.
    expect(lstatSync(join(fixture.repo, 'absolute', 'work')).isDirectory()).toBe(true);
    expect(existsSync(join(fixture.repo, 'work', 'plans'))).toBe(false);
    expect(existsSync(join(fixture.workspace, 'outside-the-repo'))).toBe(false);
    expect(existsSync(join(fixture.repo, '_bmad-output'))).toBe(false);
  });

  it('symlinked or wrongly typed project paths are deterministic refusals with nothing written', () => {
    const outside = tempDir('gru-command-bmad-outside-');
    const cases: Array<[string, (repo: string) => void, RegExp]> = [
      ['linked-bmad', (repo) => symlinkSync(outside, join(repo, '_bmad')), /refusing BMAD project path through symlink/u],
      ['linked-custom', (repo) => {
        mkdirSync(join(repo, '_bmad'));
        symlinkSync(outside, join(repo, '_bmad', 'custom'));
      }, /through symlink/u],
      ['dangling-render', (repo) => {
        mkdirSync(join(repo, '_bmad'));
        symlinkSync(join(outside, 'missing'), join(repo, '_bmad', 'render'));
      }, /through symlink/u],
      ['linked-output', (repo) => symlinkSync(outside, join(repo, '_bmad-output')), /through symlink/u],
      ['file-bmad', (repo) => writeFileSync(join(repo, '_bmad'), 'not a directory\n'), /exists but is not a directory/u],
      // Later targets are validated before the FIRST write, too.
      ['file-render', (repo) => {
        mkdirSync(join(repo, '_bmad'));
        writeFileSync(join(repo, '_bmad', 'render'), 'not a directory\n');
      }, /_bmad\/render$/u],
      ['dir-ignore', (repo) => mkdirSync(join(repo, '_bmad', 'custom', '.gitignore'), { recursive: true }), /exists but is not a file/u],
      ['file-output-parent', (repo) => writeFileSync(join(repo, '_bmad-output'), 'not a directory\n'), /_bmad-output$/u],
      ['linked-settings-file', (repo) => {
        mkdirSync(join(repo, '_bmad', 'custom'), { recursive: true });
        writeFileSync(join(outside, 'config.toml'), '[core]\noutput_folder = "{project-root}/x"\n');
        symlinkSync(join(outside, 'config.toml'), join(repo, '_bmad', 'custom', 'config.toml'));
      }, /through symlink/u],
    ];
    for (const [name, arrange, message] of cases) {
      const fixture = fixtureRepo(name);
      arrange(fixture.repo);
      const before = snapshot(fixture.repo);
      const result = onboardBmadRepo(fixture.name, 'provision', {
        workspaceRoot: fixture.workspace,
        answers: answers(fixture.workspace, fixture.name),
      });
      expect(result.ready, name).toBe(false);
      expect(result.deterministic, name).toBe(true);
      expect(result.message, name).toMatch(message);
      expect(snapshot(fixture.repo), name).toBe(before);
    }
    expect(readdirSync(outside)).toEqual(['config.toml']);
  });

  it('settings the first render would refuse are deterministic refusals, never a false ready', () => {
    const cases: Array<[string, Record<string, string>, RegExp, RegExp]> = [
      ['malformed-central', { '_bmad/custom/config.toml': '[core\nbroken = \n' },
        /project BMAD settings file is malformed: .*_bmad\/custom\/config\.toml/u, /settings file/u],
      ['malformed-customization', { '_bmad/custom/bmad-build.toml': '[[workflow.review_layers]]\ninstruction = \n' },
        /project BMAD settings file is malformed: .*_bmad\/custom\/bmad-build\.toml/u, /settings file/u],
      ['non-string-setting', { '_bmad/custom/config.user.toml': '[core]\ncommunication_language = 7\n' },
        /setting `core\.communication_language` must be a string, got 7/u, /settings file/u],
      ['legacy-answer', { '_bmad/config.user.toml': '[core]\ncommunication_language = "Français"\n' },
        /legacy BMAD installer answer `core\.communication_language` = "Français" differs from the effective value "English"/u,
        /Retiring a repo-local install/u],
      ['render-not-ignored', { '_bmad/render/.gitignore': '# kept, but ignores nothing\n' },
        /does not ignore rendered workflow snapshots/u, /single `\*` line/u],
    ];
    for (const [name, files, message, hint] of cases) {
      const fixture = fixtureRepo(name);
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(dirname(join(fixture.repo, rel)), { recursive: true });
        writeFileSync(join(fixture.repo, rel), text);
      }
      const before = snapshot(fixture.repo);
      const result = onboardBmadRepo(fixture.name, 'provision', {
        workspaceRoot: fixture.workspace,
        answers: answers(fixture.workspace, fixture.name),
      });
      expect(result.ready, name).toBe(false);
      expect(result.deterministic, name).toBe(true);
      expect(result.message, name).toMatch(message);
      expect(result.repairHint, name).toMatch(hint);
      expect(snapshot(fixture.repo), name).toBe(before);
    }
    // Legacy answers equal to the effective values (and layered like the
    // installer's) do not block.
    const equal = fixtureRepo('legacy-equal');
    mkdirSync(join(equal.repo, '_bmad'), { recursive: true });
    writeFileSync(join(equal.repo, '_bmad', 'config.toml'), '[core]\nproject_name = "x"\ncommunication_language = "Deutsch"\n');
    writeFileSync(join(equal.repo, '_bmad', 'config.user.toml'), '[core]\ncommunication_language = "English"\n');
    const ok = onboardBmadRepo(equal.name, 'provision', { workspaceRoot: equal.workspace, answers: answers(equal.workspace, equal.name) });
    expect(ok.ready, ok.message).toBe(true);
  });

  it('skip touches nothing; a broken product bundle and a read-only repo stay retryable', () => {
    const skipped = fixtureRepo('skipped');
    const before = snapshot(skipped.repo);
    const skip = onboardBmadRepo(skipped.name, 'skip', {
      workspaceRoot: skipped.workspace,
      answers: answers(skipped.workspace, skipped.name, 'skip'),
    });
    expect(skip).toMatchObject({ ready: false, message: 'skipped by explicit per-repo choice' });
    expect(snapshot(skipped.repo)).toBe(before);

    const broken = fixtureRepo('broken-bundle');
    const brokenBefore = snapshot(broken.repo);
    const failed = onboardBmadRepo(broken.name, 'provision', {
      workspaceRoot: broken.workspace,
      answers: answers(broken.workspace, broken.name),
      runtime: () => loadBundledBmadRuntime(tempDir('gru-command-no-bundle-')),
    });
    expect(failed.ready).toBe(false);
    expect(failed.deterministic).toBeUndefined();
    expect(failed.message).toContain('bundled BMAD runtime');
    expect(failed.message).toContain('never falls back to another BMAD installation');
    expect(snapshot(broken.repo)).toBe(brokenBefore);

    const readOnly = fixtureRepo('read-only');
    chmodSync(readOnly.repo, 0o555);
    try {
      const denied = onboardBmadRepo(readOnly.name, 'provision', {
        workspaceRoot: readOnly.workspace,
        answers: answers(readOnly.workspace, readOnly.name),
      });
      expect(denied.ready).toBe(false);
      expect(denied.deterministic).toBeUndefined();
      expect(denied.message).toMatch(/EACCES|permission denied/iu);
    } finally {
      chmodSync(readOnly.repo, 0o755);
    }
  });

  it('missing prerequisites name the tool; the PRODUCTION probe detects a missing binary', () => {
    const fixture = fixtureRepo('missing-prereq');
    const result = onboardBmadRepo(fixture.name, 'provision', {
      workspaceRoot: fixture.workspace,
      answers: answers(fixture.workspace, fixture.name),
      prerequisiteCheck: (command) => command !== 'uv',
    });
    expect(result.ready).toBe(false);
    expect(result.deterministic).toBeUndefined();
    expect(result.message).toContain('missing BMAD prerequisite(s): uv');
    expect(existsSync(join(fixture.repo, '_bmad'))).toBe(false);

    expect(commandAvailable('node', process.env, tmpdir())).toBe(true);
    expect(commandAvailable('gru-no-such-binary-4f7c2a', process.env, tmpdir())).toBe(false);
  });

  it('runtime CLIs follow the role policy: pi, claude-code, or both', () => {
    const fixture = fixtureRepo('tools');
    const parse = (extra: Record<string, unknown>) => parseAnswers(JSON.stringify({
      workspace_root: fixture.workspace,
      repos: [fixture.name],
      smoke: false,
      ...extra,
    }));
    expect(bmadToolsForAnswers(parse({ runtime: 'pi' }))).toEqual(['pi']);
    expect(bmadToolsForAnswers(parse({ runtime: 'claude-code' }))).toEqual(['claude-code']);
    expect(bmadToolsForAnswers(parse({ runtime: 'pi', roles: { minion: 'claude-code' } }))).toEqual(['pi', 'claude-code']);
    const checked: string[] = [];
    const result = onboardBmadRepo(fixture.name, 'provision', {
      workspaceRoot: fixture.workspace,
      answers: parse({ runtime: 'pi', roles: { minion: 'claude-code' } }),
      prerequisiteCheck: (command) => {
        checked.push(command);
        return true;
      },
    });
    expect(result.ready, result.message).toBe(true);
    expect(checked).toEqual(['git', 'uv', 'pi', 'claude']);
  });

  it('answers default to provision and reject the retired install/reuse values loudly', () => {
    const fixture = fixtureRepo('answers');
    const defaults = parseAnswers(JSON.stringify({ workspace_root: fixture.workspace, repos: [fixture.name] }));
    expect(defaults.bmad).toEqual({ [fixture.name]: 'provision' });
    const withAction = (action: string) => () => parseAnswers(JSON.stringify({
      workspace_root: fixture.workspace,
      repos: [fixture.name],
      bmad: { [fixture.name]: action },
    }));
    for (const retired of ['install', 'reuse']) {
      expect(withAction(retired)).toThrow(AnswersError);
      expect(withAction(retired)).toThrow(/retired with the repo-local BMAD installer.*"provision"/u);
    }
    expect(withAction('maybe')).toThrow(/must be "provision" or "skip"/u);
  });

  it('repo-selection refusals are deterministic, and tooling failures stay transient', () => {
    const raced = fixtureRepo('deleted-repo-race');
    const parsed = answers(raced.workspace, raced.name);
    rmSync(raced.repo, { recursive: true, force: true });
    const deleted = onboardBmadRepo(raced.name, 'provision', { workspaceRoot: raced.workspace, answers: parsed });
    expect(deleted).toMatchObject({ ready: false, deterministic: true });
    expect(deleted.message).toContain('selected repo no longer exists');

    const linked = fixtureRepo('linked-target');
    symlinkSync(linked.repo, join(linked.workspace, 'linked-repo'));
    const viaLink = onboardBmadRepo('linked-repo', 'provision', {
      workspaceRoot: linked.workspace,
      answers: parseAnswers(JSON.stringify({ workspace_root: linked.workspace, repos: ['linked-repo'] })),
    });
    expect(viaLink).toMatchObject({ ready: false, deterministic: true });
    expect(viaLink.message).toContain('selected repo is a symlink');

    const notGit = fixtureRepo('plain-dir');
    const notGitAnswers = answers(notGit.workspace, notGit.name);
    rmSync(join(notGit.repo, '.git'), { recursive: true, force: true });
    const plain = onboardBmadRepo(notGit.name, 'provision', { workspaceRoot: notGit.workspace, answers: notGitAnswers });
    expect(plain).toMatchObject({ ready: false, deterministic: true });
    expect(plain.message).toContain('not a Git repo');

    const fakeBin = tempDir('gru-command-fake-git-');
    writeFileSync(
      join(fakeBin, 'git'),
      '#!/usr/bin/env bash\nif [[ "$*" == *"--show-toplevel"* ]]; then\n  if [[ -n "${FAKE_GIT_STDERR:-}" ]]; then echo "$FAKE_GIT_STDERR" >&2; fi\n  if [[ -n "${FAKE_GIT_EXIT:-}" ]]; then exit "$FAKE_GIT_EXIT"; fi\n  echo "$FAKE_GIT_TOPLEVEL"; exit 0\nfi\nexit 1\n',
      { mode: 0o755 },
    );
    const ghost = fixtureRepo('ghost-toplevel');
    const ghostAnswers = answers(ghost.workspace, ghost.name);
    const run = (env: NodeJS.ProcessEnv) => onboardBmadRepo(ghost.name, 'provision', {
      workspaceRoot: ghost.workspace,
      answers: ghostAnswers,
      env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, ...env },
    });
    const invalidTop = run({ FAKE_GIT_TOPLEVEL: join(ghost.workspace, 'no-such-toplevel') });
    expect(invalidTop).toMatchObject({ ready: false, deterministic: true });
    expect(invalidTop.message).toContain('invalid top-level path');
    const emptyTop = run({ FAKE_GIT_TOPLEVEL: '' });
    expect(emptyTop.ready).toBe(false);
    expect(emptyTop.deterministic).toBeUndefined();
    expect(emptyTop.message).toContain('git reported no repository root');
    const ownership = run({ FAKE_GIT_STDERR: "fatal: detected dubious ownership in repository at '/somewhere'", FAKE_GIT_EXIT: '128' });
    expect(ownership).toMatchObject({ ready: false, deterministic: true });
    expect(ownership.message).toContain('Git ownership/config condition');
    expect(ownership.message).not.toContain('not a usable Git repo');
    const notRoot = run({ FAKE_GIT_TOPLEVEL: ghost.workspace });
    expect(notRoot).toMatchObject({ ready: false, deterministic: true });
    expect(notRoot.message).toContain('not the Git repository root');
    expect(existsSync(join(ghost.repo, '_bmad'))).toBe(false);
  });
});
