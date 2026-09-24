import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyWorktreeManifest, loadWorktreeManifest } from '../src/worktrees/manifest.js';
import { parseAnswers } from '../src/wizard/answers.js';
import {
  BMAD_DEFAULT_MODULES,
  BMAD_INSTALLER_VERSION,
  BMAD_MODULE_PINS,
  bmadToolsForAnswers,
  commandAvailable,
  onboardBmadRepo as onboardBmadRepoImpl,
} from '../src/wizard/bmad-onboarding.js';

const onboardBmadRepo = (
  ...args: Parameters<typeof onboardBmadRepoImpl>
): ReturnType<typeof onboardBmadRepoImpl> => {
  const [repoName, action, options] = args;
  return onboardBmadRepoImpl(repoName, action, {
    ...options,
    prerequisiteCheck: () => true,
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
  git(repo, [
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'user.name=fixture',
    'commit',
    '-qm',
    'fixture',
  ]);
  return { workspace, repo, name };
}

function officialManifest(extra = '', tools: readonly string[] = ['pi']): string {
  return [
    'installation:',
    `  version: ${BMAD_INSTALLER_VERSION}`,
    'modules:',
    '  - name: core',
    `    version: ${BMAD_INSTALLER_VERSION}`,
    '  - name: bmm',
    `    version: ${BMAD_INSTALLER_VERSION}`,
    '  - name: cis',
    `    version: ${BMAD_MODULE_PINS.cis}`,
    '  - name: tea',
    `    version: ${BMAD_MODULE_PINS.tea}`,
    '  - name: gds',
    `    version: ${BMAD_MODULE_PINS.gds}`,
    extra,
    'ides:',
    ...tools.map((tool) => `  - ${tool}`),
    '',
  ].filter((line) => line !== '').join('\n') + '\n';
}

function materializeOfficialInstall(
  repo: string,
  extra = '',
  tools: readonly string[] = ['pi'],
): void {
  writeFileSync(join(repo, '_bmad-custom-byte'), 'untouched\n');
  for (const module of ['core', 'bmm', 'cis', 'tea', 'gds']) {
    mkdirSync(join(repo, '_bmad', module), { recursive: true });
    writeFileSync(join(repo, '_bmad', module, 'marker.txt'), `${module}\n`);
  }
  mkdirSync(join(repo, '_bmad', '_config'), { recursive: true });
  writeFileSync(join(repo, '_bmad', '_config', 'manifest.yaml'), officialManifest(extra, tools));
  for (const tool of tools) {
    const root = tool === 'claude-code' ? '.claude' : '.agents';
    mkdirSync(join(repo, root, 'skills', 'bmad-build'), { recursive: true });
    writeFileSync(join(repo, root, 'skills', 'bmad-build', 'SKILL.md'), '# Build\n');
    writeFileSync(
      join(repo, root, 'skills', 'bmad-build', 'workflow.md'),
      'write to {{.implementation_artifacts}}\n',
    );
    mkdirSync(join(repo, root, 'skills', 'gds-quick-dev'), { recursive: true });
    writeFileSync(join(repo, root, 'skills', 'gds-quick-dev', 'SKILL.md'), '# GDS\n');
    writeFileSync(
      join(repo, root, 'skills', 'gds-quick-dev', 'workflow.md'),
      'write to {{.implementation_artifacts}}\n',
    );
    mkdirSync(join(repo, root, 'skills', 'bmad-help'), { recursive: true });
    writeFileSync(join(repo, root, 'skills', 'bmad-help', 'SKILL.md'), '# Help\n');
  }
}

function answers(workspace: string, repo: string, action: 'install' | 'reuse' | 'skip') {
  return parseAnswers(
    JSON.stringify({
      workspace_root: workspace,
      repos: [repo],
      bmad: { [repo]: action },
      runtime: 'pi',
      smoke: false,
    }),
  );
}

function successfulInstaller(
  repo: string,
  calls: string[][],
  childEnvs: NodeJS.ProcessEnv[] = [],
): typeof spawnSync {
  return ((command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    calls.push([command, ...args]);
    childEnvs.push({ ...(options?.env ?? {}) });
    const toolsAt = args.indexOf('--tools');
    const tools = toolsAt === -1 ? ['pi'] : (args[toolsAt + 1] ?? 'pi').split(',');
    const directoryAt = args.indexOf('--directory');
    const directory = directoryAt === -1 ? repo : (args[directoryAt + 1] ?? repo);
    materializeOfficialInstall(directory, '', tools);
    return { status: 0, signal: null, stdout: 'installed', stderr: '', pid: 1, output: [] };
  }) as unknown as typeof spawnSync;
}

describe('per-selected-repo BMAD onboarding', () => {
  it('runs the pinned official headless installer with all four defaults and writes narrow idempotent bindings', () => {
    const fixture = fixtureRepo();
    mkdirSync(join(fixture.repo, '.gru-command'), { recursive: true });
    writeFileSync(
      join(fixture.repo, '.gru-command', 'worktree.toml'),
      '[[setup]]\ncommand = "npm install"\n',
    );
    const customSkill = join(fixture.repo, '.agents', 'skills', 'user-custom');
    mkdirSync(customSkill, { recursive: true });
    writeFileSync(join(customSkill, 'SKILL.md'), '# user custom\n');
    writeFileSync(join(customSkill, 'workflow.md'), '{{.implementation_artifacts}}\n');
    const calls: string[][] = [];
    const parsed = answers(fixture.workspace, fixture.name, 'install');
    const result = onboardBmadRepo(fixture.name, 'install', {
      workspaceRoot: fixture.workspace,
      answers: parsed,
      run: successfulInstaller(fixture.repo, calls),
    });

    expect(result.ready, result.message).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(expect.arrayContaining([
      'npx',
      '--yes',
      `bmad-method@${BMAD_INSTALLER_VERSION}`,
      '--modules',
      BMAD_DEFAULT_MODULES.join(','),
      `cis=${BMAD_MODULE_PINS.cis}`,
      `tea=${BMAD_MODULE_PINS.tea}`,
      `gds=${BMAD_MODULE_PINS.gds}`,
      '--tools',
      'pi',
      '--no-shims',
    ]));

    const record = JSON.parse(
      readFileSync(join(fixture.repo, '.gru-command', 'bmad-install.json'), 'utf-8'),
    ) as {
      modules: Array<{ name: string; version: string }>;
      tools: string[];
      runtime_skills: Record<string, string[]>;
      source_payload_sha256: string;
    };
    expect(record.modules.map((module) => module.name)).toEqual(['core', 'bmm', 'cis', 'tea', 'gds']);
    expect(record.tools).toEqual(['pi']);
    expect(record.runtime_skills.pi).toContain('bmad-build');
    expect(record.runtime_skills.pi).not.toContain('user-custom');
    expect(record.source_payload_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      readFileSync(join(fixture.repo, '.agents', 'skills', 'bmad-build', 'workflow.md'), 'utf-8'),
    ).toContain('{{config.modules.bmm.implementation_artifacts}}');
    expect(
      readFileSync(join(fixture.repo, '.agents', 'skills', 'gds-quick-dev', 'workflow.md'), 'utf-8'),
    ).toContain('{{config.modules.gds.implementation_artifacts}}');

    const manifest = readFileSync(join(fixture.repo, '.gru-command', 'worktree.toml'), 'utf-8');
    expect(manifest).toContain('command = "npm install"');
    expect(manifest.match(/BEGIN GRU COMMAND BMAD BOOTSTRAP/g)).toHaveLength(1);
    expect(manifest).toContain('if git config --local --get gru-command.bmad-source');
    expect(manifest).toContain('node .gru-command/bmad-bootstrap.mjs');
    expect(readFileSync(join(fixture.repo, '.gru-command', 'bmad-bootstrap.mjs'), 'utf-8')).toBe(
      readFileSync(join(import.meta.dirname, '..', '.gru-command', 'bmad-bootstrap.mjs'), 'utf-8'),
    );

    const excludePath = git(fixture.repo, ['rev-parse', '--git-path', 'info/exclude']);
    const exclude = readFileSync(
      excludePath.startsWith('/') ? excludePath : join(fixture.repo, excludePath),
      'utf-8',
    );
    expect(exclude).toContain('/.agents/skills/bmad-build/');
    expect(exclude).not.toContain('/.agents/skills/user-custom/');
    expect(readFileSync(join(customSkill, 'workflow.md'), 'utf-8')).toBe(
      '{{.implementation_artifacts}}\n',
    );
    expect(exclude).not.toMatch(/^\.agents\/$/m);
    expect(exclude).not.toMatch(/^\.claude\/$/m);
    expect(exclude).not.toMatch(/^_bmad-output\/$/m);

    const rerun = onboardBmadRepo(fixture.name, 'reuse', {
      workspaceRoot: fixture.workspace,
      answers: answers(fixture.workspace, fixture.name, 'reuse'),
    });
    expect(rerun.ready, rerun.message).toBe(true);
    const rerunManifest = readFileSync(join(fixture.repo, '.gru-command', 'worktree.toml'), 'utf-8');
    expect(rerunManifest.match(/BEGIN GRU COMMAND BMAD BOOTSTRAP/g)).toHaveLength(1);
    expect(rerunManifest).toContain('if git config --local --get gru-command.bmad-source');
  });

  it('onboarding and reuse keep fresh clones usable without Git-local BMAD source', () => {
    const fixture = fixtureRepo('clone-guard');
    const installed = onboardBmadRepo(fixture.name, 'install', {
      workspaceRoot: fixture.workspace,
      answers: answers(fixture.workspace, fixture.name, 'install'),
      run: successfulInstaller(fixture.repo, []),
    });
    expect(installed.ready, installed.message).toBe(true);
    const reused = onboardBmadRepo(fixture.name, 'reuse', {
      workspaceRoot: fixture.workspace,
      answers: answers(fixture.workspace, fixture.name, 'reuse'),
    });
    expect(reused.ready, reused.message).toBe(true);
    git(fixture.repo, ['add', '.gru-command']);
    git(fixture.repo, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'tracked controls']);
    const clone = join(fixture.workspace, 'unonboarded-clone');
    execFileSync('git', ['clone', '-q', fixture.repo, clone]);
    expect(spawnSync('git', ['-C', clone, 'config', '--local', '--get', 'gru-command.bmad-source']).status).toBe(1);
    const manifest = loadWorktreeManifest(clone);
    expect(manifest).not.toBeNull();
    expect(() => applyWorktreeManifest(manifest!, {
      sourceRoot: clone,
      worktreePath: clone,
      setupTimeoutMs: 60_000,
    })).not.toThrow();
    expect(existsSync(join(clone, '_bmad'))).toBe(false);
  });

  it('reuses an existing customized install without changing custom bytes, modules, versions, or local excludes', () => {
    const fixture = fixtureRepo();
    materializeOfficialInstall(fixture.repo, '  - name: custom-extra\n    version: v9.4.1');
    // A usable customized install may already carry its own qualification;
    // reuse must preserve those bytes rather than applying Gru's fresh patch.
    writeFileSync(
      join(fixture.repo, '.agents', 'skills', 'bmad-build', 'workflow.md'),
      'write to {{config.modules.bmm.implementation_artifacts}}\n',
    );
    writeFileSync(
      join(fixture.repo, '.agents', 'skills', 'gds-quick-dev', 'workflow.md'),
      'write to {{config.modules.gds.implementation_artifacts}}\n',
    );
    mkdirSync(join(fixture.repo, '_bmad', 'custom-extra'), { recursive: true });
    writeFileSync(join(fixture.repo, '_bmad', 'custom-extra', 'custom.txt'), 'precious\n');
    const excludePathRaw = git(fixture.repo, ['rev-parse', '--git-path', 'info/exclude']);
    const excludePath = excludePathRaw.startsWith('/')
      ? excludePathRaw
      : join(fixture.repo, excludePathRaw);
    writeFileSync(excludePath, '# user excludes\n/custom-user-path/\n');
    const manifestPath = join(fixture.repo, '_bmad', '_config', 'manifest.yaml');
    const customizedManifest = readFileSync(manifestPath, 'utf-8').replace(
      `installation:\n  version: ${BMAD_INSTALLER_VERSION}`,
      'installation:\n  version: 5.9.7',
    );
    writeFileSync(manifestPath, customizedManifest);
    const manifestBefore = readFileSync(manifestPath, 'utf-8');

    const result = onboardBmadRepo(fixture.name, 'reuse', {
      workspaceRoot: fixture.workspace,
      answers: answers(fixture.workspace, fixture.name, 'reuse'),
      run: (() => {
        throw new Error('official installer must not run for reuse');
      }) as unknown as typeof spawnSync,
    });
    expect(result.ready, result.message).toBe(true);
    expect(readFileSync(join(fixture.repo, '_bmad', 'custom-extra', 'custom.txt'), 'utf-8')).toBe(
      'precious\n',
    );
    expect(readFileSync(join(fixture.repo, '_bmad', '_config', 'manifest.yaml'), 'utf-8')).toBe(
      manifestBefore,
    );
    expect(readFileSync(excludePath, 'utf-8')).toBe('# user excludes\n/custom-user-path/\n');
    const record = JSON.parse(
      readFileSync(join(fixture.repo, '.gru-command', 'bmad-install.json'), 'utf-8'),
    ) as { installer: string; default_modules: string[]; pins: Record<string, string> };
    expect(record).toMatchObject({ installer: 'bmad-method@5.9.7', default_modules: [], pins: {} });
    expect(
      readFileSync(join(fixture.repo, '.gru-command', 'worktree.toml'), 'utf-8'),
    ).toContain('node .gru-command/bmad-bootstrap.mjs');
    expect(existsSync(join(fixture.repo, '.gru-command', 'bmad-bootstrap.mjs'))).toBe(true);
  });

  it('installs both project-local runtime bindings for mixed Pi and Claude role policy', () => {
    const claudeOnly = parseAnswers('{"runtime":"claude-code","smoke":false}');
    expect(bmadToolsForAnswers(claudeOnly)).toEqual(['claude-code']);

    const fixture = fixtureRepo('mixed-tools');
    const parsed = parseAnswers(
      JSON.stringify({
        workspace_root: fixture.workspace,
        repos: [fixture.name],
        runtime: 'claude-code',
        roles: { minion: 'pi' },
        bmad: { [fixture.name]: 'install' },
        smoke: false,
      }),
    );
    const calls: string[][] = [];
    const result = onboardBmadRepo(fixture.name, 'install', {
      workspaceRoot: fixture.workspace,
      answers: parsed,
      run: successfulInstaller(fixture.repo, calls),
    });
    expect(result.ready, result.message).toBe(true);
    expect(calls).toHaveLength(2);
    const toolsAt = calls[1]?.indexOf('--tools') ?? -1;
    expect(calls[1]?.[toolsAt + 1]).toBe('pi,claude-code');
    expect(existsSync(join(fixture.repo, '.agents', 'skills', 'bmad-build', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(fixture.repo, '.claude', 'skills', 'bmad-build', 'SKILL.md'))).toBe(true);
  });

  it('skip touches nothing; partial/network failure remains visible and never writes a ready record', () => {
    const skipped = fixtureRepo('skip-me');
    const skipResult = onboardBmadRepo(skipped.name, 'skip', {
      workspaceRoot: skipped.workspace,
      answers: answers(skipped.workspace, skipped.name, 'skip'),
    });
    expect(skipResult.ready).toBe(false);
    expect(existsSync(join(skipped.repo, '.gru-command'))).toBe(false);

    const failed = fixtureRepo('network-fail');
    const runner = ((_command: string, _args: string[]) => {
      mkdirSync(join(failed.repo, '_bmad', 'partial'), { recursive: true });
      writeFileSync(join(failed.repo, '_bmad', 'partial', 'receipt'), 'preserve me\n');
      return {
        status: 1,
        signal: null,
        stdout: '',
        stderr: 'fixture network unavailable',
        pid: 1,
        output: [],
      };
    }) as unknown as typeof spawnSync;
    const failedResult = onboardBmadRepo(failed.name, 'install', {
      workspaceRoot: failed.workspace,
      answers: answers(failed.workspace, failed.name, 'install'),
      run: runner,
    });
    expect(failedResult.ready).toBe(false);
    expect(failedResult.message).toContain('retry this repo or skip it');
    expect(readFileSync(join(failed.repo, '_bmad', 'partial', 'receipt'), 'utf-8')).toBe(
      'preserve me\n',
    );
    expect(existsSync(join(failed.repo, '.gru-command', 'bmad-install.json'))).toBe(false);
  });

  it('missing-prerequisite failure names the missing tool and never marks ready (failure matrix)', () => {
    const fixture = fixtureRepo('missing-prereq');
    const result = onboardBmadRepoImpl(fixture.name, 'install', {
      workspaceRoot: fixture.workspace,
      answers: answers(fixture.workspace, fixture.name, 'install'),
      run: successfulInstaller(fixture.repo, []),
      // Seam kills the assertPrerequisites guard: any onboarding whose
      // prerequisite list throw is deleted would mark this ready.
      prerequisiteCheck: (command) => command !== 'uv',
    });
    expect(result.ready).toBe(false);
    expect(result.message).toContain('missing BMAD prerequisite(s): uv');
    expect(existsSync(join(fixture.repo, '.gru-command', 'bmad-install.json'))).toBe(false);
  });

  it('the PRODUCTION prerequisite probe executes and detects a missing binary (mutation-kill)', () => {
    // Real spawnSync path — never the test seam. Deleting the probe's
    // status/error check (or its absence detection) flips these asserts.
    expect(commandAvailable('node', process.env, tmpdir())).toBe(true);
    expect(commandAvailable('gru-no-such-binary-4f7c2a', process.env, tmpdir())).toBe(false);
    // Production probes pass on this machine end-to-end: with NO seam
    // injected, onboarding reaches the installer (its fixture failure names
    // the installer), never the missing-prerequisite error.
    const fixture = fixtureRepo('production-probe');
    const runner = (() => ({
      status: 1,
      signal: null,
      stdout: '',
      stderr: 'fixture installer failure',
      pid: 1,
      output: [],
    })) as unknown as typeof spawnSync;
    const result = onboardBmadRepoImpl(fixture.name, 'install', {
      workspaceRoot: fixture.workspace,
      answers: answers(fixture.workspace, fixture.name, 'install'),
      run: runner,
    });
    expect(result.ready).toBe(false);
    expect(result.message).toContain('official BMAD installer exited 1');
    expect(result.message).not.toContain('missing BMAD prerequisite');
  });

  it('read-only repo fails visibly without a ready record (failure matrix)', () => {
    const fixture = fixtureRepo('read-only');
    chmodSync(fixture.repo, 0o555);
    try {
      // successfulInstaller materializes the install INTO the --directory
      // target: the write into the read-only repo throws EACCES for real.
      const result = onboardBmadRepo(fixture.name, 'install', {
        workspaceRoot: fixture.workspace,
        answers: answers(fixture.workspace, fixture.name, 'install'),
        run: successfulInstaller(fixture.repo, []),
      });
      expect(result.ready).toBe(false);
      expect(result.message).toMatch(/EACCES|permission denied/i);
      expect(existsSync(join(fixture.repo, '.gru-command', 'bmad-install.json'))).toBe(false);
    } finally {
      chmodSync(fixture.repo, 0o755);
    }
  });

  it('interrupted/partial install is refused until repaired, never overwritten (failure matrix)', () => {
    for (const action of ['install', 'reuse'] as const) {
      const fixture = fixtureRepo(`partial-${action}`);
      mkdirSync(join(fixture.repo, '_bmad', 'bmm'), { recursive: true });
      writeFileSync(join(fixture.repo, '_bmad', 'bmm', 'half-written'), 'interrupted\n');
      const result = onboardBmadRepoImpl(fixture.name, action, {
        workspaceRoot: fixture.workspace,
        answers: answers(fixture.workspace, fixture.name, action),
        run: successfulInstaller(fixture.repo, []),
      });
      expect(result.ready, `${action}: ${result.message}`).toBe(false);
      expect(result.message).toContain('partial BMAD installation detected');
      expect(result.message).toContain('preserve it and repair or choose skip');
      expect(existsSync(join(fixture.repo, '_bmad', 'bmm', 'half-written'))).toBe(true);
      expect(existsSync(join(fixture.repo, '.gru-command', 'bmad-install.json'))).toBe(false);
    }
  });

  it('rejects malformed existing manifests and symlinked selected repos without mutation', () => {
    const malformed = fixtureRepo('malformed');
    mkdirSync(join(malformed.repo, '_bmad', '_config'), { recursive: true });
    writeFileSync(join(malformed.repo, '_bmad', '_config', 'manifest.yaml'), 'not-a-manifest\n');
    const bad = onboardBmadRepo(malformed.name, 'reuse', {
      workspaceRoot: malformed.workspace,
      answers: answers(malformed.workspace, malformed.name, 'reuse'),
    });
    expect(bad.ready).toBe(false);
    expect(bad.message).toContain('malformed');
    expect(existsSync(join(malformed.repo, '.gru-command'))).toBe(false);

    const foreign = fixtureRepo('foreign-control');
    mkdirSync(join(foreign.repo, '.gru-command'), { recursive: true });
    const foreignBootstrap = join(foreign.repo, '.gru-command', 'bmad-bootstrap.mjs');
    writeFileSync(foreignBootstrap, '// user-owned\n');
    let installerRan = false;
    const refused = onboardBmadRepo(foreign.name, 'install', {
      workspaceRoot: foreign.workspace,
      answers: answers(foreign.workspace, foreign.name, 'install'),
      run: (() => {
        installerRan = true;
        throw new Error('must not run');
      }) as unknown as typeof spawnSync,
    });
    expect(refused.ready).toBe(false);
    expect(refused.message).toContain('non-Gru BMAD bootstrap');
    expect(installerRan).toBe(false);
    expect(readFileSync(foreignBootstrap, 'utf-8')).toBe('// user-owned\n');

    const unsafeRuntime = fixtureRepo('unsafe-runtime-root');
    const outsideRuntime = tempDir('gru-command-bmad-outside-runtime-');
    symlinkSync(outsideRuntime, join(unsafeRuntime.repo, '.agents'));
    let unsafeInstallerRan = false;
    const unsafe = onboardBmadRepo(unsafeRuntime.name, 'install', {
      workspaceRoot: unsafeRuntime.workspace,
      answers: answers(unsafeRuntime.workspace, unsafeRuntime.name, 'install'),
      run: (() => {
        unsafeInstallerRan = true;
        throw new Error('must not run');
      }) as unknown as typeof spawnSync,
    });
    expect(unsafe.ready).toBe(false);
    expect(unsafe.message).toContain('symlink');
    expect(unsafeInstallerRan).toBe(false);
    expect(existsSync(join(outsideRuntime, 'skills'))).toBe(false);

    const collision = fixtureRepo('skill-collision');
    const customBmadHelp = join(collision.repo, '.agents', 'skills', 'bmad-help');
    mkdirSync(customBmadHelp, { recursive: true });
    writeFileSync(join(customBmadHelp, 'SKILL.md'), '# precious custom bmad-help\n');
    const collisionCalls: string[][] = [];
    const collided = onboardBmadRepo(collision.name, 'install', {
      workspaceRoot: collision.workspace,
      answers: answers(collision.workspace, collision.name, 'install'),
      run: successfulInstaller(collision.repo, collisionCalls),
    });
    expect(collided.ready).toBe(false);
    expect(collided.message).toContain('would overwrite existing pi skill(s): bmad-help');
    expect(collisionCalls).toHaveLength(1);
    expect(readFileSync(join(customBmadHelp, 'SKILL.md'), 'utf-8')).toBe(
      '# precious custom bmad-help\n',
    );
    expect(existsSync(join(collision.repo, '_bmad'))).toBe(false);

    const workspace = tempDir('gru-command-bmad-symlink-');
    const outside = fixtureRepo('outside');
    symlinkSync(outside.repo, join(workspace, 'linked'));
    const linkedAnswers = parseAnswers(
      JSON.stringify({ workspace_root: workspace, repos: ['linked'], bmad: { linked: 'reuse' } }),
    );
    const linked = onboardBmadRepo('linked', 'reuse', {
      workspaceRoot: workspace,
      answers: linkedAnswers,
    });
    expect(linked.ready).toBe(false);
    expect(linked.message).toContain('symlink');
    expect(existsSync(join(outside.repo, '.gru-command'))).toBe(false);
  });

  it('bootstraps isolated copies into a real fresh worktree and fails when a required source module disappears', () => {
    const fixture = fixtureRepo('worktree-proof');
    const customSkill = join(fixture.repo, '.agents', 'skills', 'user-custom');
    mkdirSync(customSkill, { recursive: true });
    writeFileSync(join(customSkill, 'SKILL.md'), '# user custom\n');
    const result = onboardBmadRepo(fixture.name, 'install', {
      workspaceRoot: fixture.workspace,
      answers: answers(fixture.workspace, fixture.name, 'install'),
      run: successfulInstaller(fixture.repo, []),
    });
    expect(result.ready, result.message).toBe(true);
    // A private customization directory must remain private in the worktree
    // even when its files would be readable through a widened directory.
    chmodSync(join(fixture.repo, '_bmad', 'gds'), 0o700);
    git(fixture.repo, ['add', '.gru-command']);
    git(fixture.repo, [
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'user.name=fixture',
      'commit',
      '-qm',
      'track Gru BMAD bootstrap',
    ]);

    const worktree = join(fixture.workspace, 'fresh-worktree');
    git(fixture.repo, ['worktree', 'add', worktree, 'HEAD']);
    const manifest = loadWorktreeManifest(fixture.repo);
    expect(manifest).not.toBeNull();
    applyWorktreeManifest(manifest!, {
      sourceRoot: fixture.repo,
      worktreePath: worktree,
      setupTimeoutMs: 60_000,
    });
    expect(existsSync(join(worktree, '.agents', 'skills', 'bmad-build', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(worktree, '.agents', 'skills', 'user-custom'))).toBe(false);
    expect(existsSync(join(worktree, '_bmad', 'gds', 'marker.txt'))).toBe(true);
    expect(lstatSync(join(worktree, '_bmad')).isSymbolicLink()).toBe(false);
    expect(lstatSync(join(worktree, '_bmad', 'gds')).mode & 0o777).toBe(0o700);
    writeFileSync(join(worktree, '_bmad', 'gds', 'marker.txt'), 'worktree-only\n');
    expect(readFileSync(join(fixture.repo, '_bmad', 'gds', 'marker.txt'), 'utf-8')).toBe('gds\n');
    git(fixture.repo, ['worktree', 'remove', '--force', worktree]);

    const escapedWorktree = join(fixture.workspace, 'escaped-worktree');
    const outsideDestination = tempDir('gru-command-bmad-bootstrap-outside-');
    git(fixture.repo, ['worktree', 'add', escapedWorktree, 'HEAD']);
    symlinkSync(outsideDestination, join(escapedWorktree, '_bmad'));
    expect(() =>
      applyWorktreeManifest(manifest!, {
        sourceRoot: fixture.repo,
        worktreePath: escapedWorktree,
        setupTimeoutMs: 60_000,
      }),
    ).toThrow(/destination symlink/);
    expect(existsSync(join(outsideDestination, '_config'))).toBe(false);
    git(fixture.repo, ['worktree', 'remove', '--force', escapedWorktree]);

    for (const destination of ['_bmad', join('.agents', 'skills', 'bmad-build')]) {
      const danglingWorktree = join(fixture.workspace, `dangling-${destination.replaceAll('/', '-')}`);
      git(fixture.repo, ['worktree', 'add', danglingWorktree, 'HEAD']);
      const link = join(danglingWorktree, destination);
      mkdirSync(join(link, '..'), { recursive: true });
      symlinkSync(join(outsideDestination, 'missing-target'), link);
      expect(() => applyWorktreeManifest(manifest!, {
        sourceRoot: fixture.repo,
        worktreePath: danglingWorktree,
        setupTimeoutMs: 60_000,
      })).toThrow(/destination symlink/);
      expect(existsSync(join(outsideDestination, 'missing-target'))).toBe(false);
      git(fixture.repo, ['worktree', 'remove', '--force', danglingWorktree]);
    }

    rmSync(join(fixture.repo, '_bmad', 'bmm'), { recursive: true, force: true });
    const brokenWorktree = join(fixture.workspace, 'broken-worktree');
    git(fixture.repo, ['worktree', 'add', brokenWorktree, 'HEAD']);
    expect(() =>
      applyWorktreeManifest(manifest!, {
        sourceRoot: fixture.repo,
        worktreePath: brokenWorktree,
        setupTimeoutMs: 60_000,
      }),
    ).toThrow(/source payload changed|missing required module bmm/);
    git(fixture.repo, ['worktree', 'remove', '--force', brokenWorktree]);
  }, 120_000);
});
