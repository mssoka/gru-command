import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
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

/**
 * Byte-level snapshot of the fixture's owned install surface (manifest,
 * module markers, skills, symlink targets, sentinel): any onboarding
 * mutation of a failed/skipped repo shows up as an inequality (gh-32
 * non-mutation oracle).
 */
function bmadSnapshot(repo: string): string {
  const parts: string[] = [];
  const visit = (path: string): void => {
    const info = lstatSync(path);
    const rel = relative(repo, path);
    if (info.isSymbolicLink()) {
      parts.push(`l\0${rel}\0${readlinkSync(path)}`);
    } else if (info.isDirectory()) {
      parts.push(`d\0${rel}`);
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else {
      parts.push(`f\0${rel}\0${readFileSync(path, 'utf-8')}`);
    }
  };
  visit(join(repo, '_bmad'));
  if (existsSync(join(repo, '_bmad-custom-byte'))) {
    parts.push(`s\0${readFileSync(join(repo, '_bmad-custom-byte'), 'utf-8')}`);
  }
  return parts.join('\n');
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

  it('onboarding and reuse keep fresh clones usable without Git-local BMAD source', async () => {
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
    await applyWorktreeManifest(manifest!, {
      sourceRoot: clone,
      worktreePath: clone,
      setupTimeoutMs: 60_000,
    });
    expect(existsSync(join(clone, '_bmad'))).toBe(false);
  });

  it('explicit reuse upgrades only a verified legacy fingerprint, not changed tooling or legacy caches', async () => {
    const fixture = fixtureRepo('legacy-proof');
    const installed = onboardBmadRepo(fixture.name, 'install', {
      workspaceRoot: fixture.workspace,
      answers: answers(fixture.workspace, fixture.name, 'install'),
      run: successfulInstaller(fixture.repo, []),
    });
    expect(installed.ready, installed.message).toBe(true);
    const recordPath = join(fixture.repo, '.gru-command', 'bmad-install.json');
    const record = JSON.parse(readFileSync(recordPath, 'utf-8')) as Record<string, unknown>;
    const renderCache = join(fixture.repo, '_bmad', 'render');
    const pythonCache = join(fixture.repo, '_bmad', 'gds', '__pycache__');
    mkdirSync(renderCache, { recursive: true });
    mkdirSync(pythonCache, { recursive: true });
    writeFileSync(join(renderCache, 'snapshot.md'), 'derived\n');
    writeFileSync(join(pythonCache, 'cache.pyc'), 'derived bytecode\n');
    // Independently construct the old full-payload digest including caches.
    const legacyHash = createHash('sha256');
    const legacyVisit = (path: string): void => {
      const rel = relative(fixture.repo, path);
      const info = lstatSync(path);
      if (info.isDirectory()) {
        legacyHash.update(`d\0${rel}\0`);
        for (const name of readdirSync(path).sort()) legacyVisit(join(path, name));
      } else {
        legacyHash.update(`f\0${rel}\0`);
        legacyHash.update(readFileSync(path));
        legacyHash.update('\0');
      }
    };
    legacyVisit(join(fixture.repo, '_bmad'));
    const bindings = record.runtime_skills as Record<string, string[]>;
    for (const skill of [...bindings.pi!].sort()) legacyVisit(join(fixture.repo, '.agents', 'skills', skill));
    const oldDigest = legacyHash.digest('hex');
    expect(oldDigest).not.toBe(record.source_payload_sha256);
    delete record.source_payload_format;
    record.source_payload_sha256 = oldDigest;
    writeFileSync(recordPath, `${JSON.stringify(record)}\n`);
    const reused = onboardBmadRepo(fixture.name, 'reuse', {
      workspaceRoot: fixture.workspace,
      answers: answers(fixture.workspace, fixture.name, 'reuse'),
    });
    expect(reused.ready, reused.message).toBe(true);
    const migrated = JSON.parse(readFileSync(recordPath, 'utf-8')) as Record<string, unknown>;
    expect(migrated.source_payload_format).toBe('without-derived-caches-v1');
    expect(migrated.source_payload_sha256).not.toBe(oldDigest);
    git(fixture.repo, ['add', '.gru-command']);
    git(fixture.repo, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'tracked legacy controls']);
    const manifest = loadWorktreeManifest(fixture.repo);
    expect(manifest).not.toBeNull();
    writeFileSync(join(renderCache, 'snapshot.md'), 'new generated render\n');
    writeFileSync(join(pythonCache, 'cache.pyc'), 'new generated bytecode\n');
    const worktree = join(fixture.workspace, 'migrated-worktree');
    git(fixture.repo, ['worktree', 'add', worktree, 'HEAD']);
    await applyWorktreeManifest(manifest!, { sourceRoot: fixture.repo, worktreePath: worktree, setupTimeoutMs: 60_000 });
    expect(existsSync(join(worktree, '_bmad', 'gds', 'marker.txt'))).toBe(true);
    git(fixture.repo, ['worktree', 'remove', '--force', worktree]);
    const source = join(fixture.repo, '_bmad', 'gds', 'marker.txt');
    writeFileSync(source, 'changed source\n');
    const fingerprint = readFileSync(recordPath, 'utf-8');
    const refused = onboardBmadRepo(fixture.name, 'reuse', {
      workspaceRoot: fixture.workspace,
      answers: answers(fixture.workspace, fixture.name, 'reuse'),
    });
    expect(refused.ready).toBe(false);
    expect(refused.deterministic).toBe(true);
    expect(refused.message).toContain('source payload changed');
    expect(readFileSync(recordPath, 'utf-8')).toBe(fingerprint);
    // For an old record, even a cache-only mismatch cannot establish which
    // bytes changed. Refuse to silently adopt a new executable baseline.
    writeFileSync(source, 'gds\n');
    writeFileSync(recordPath, `${JSON.stringify(record)}\n`);
    const stale = onboardBmadRepo(fixture.name, 'reuse', {
      workspaceRoot: fixture.workspace,
      answers: answers(fixture.workspace, fixture.name, 'reuse'),
    });
    expect(stale.ready).toBe(false);
    expect(stale.deterministic).toBe(true);
    expect(stale.message).toContain('legacy render caches');
    expect(readFileSync(recordPath, 'utf-8')).toBe(`${JSON.stringify(record)}\n`);
  });

  it('refuses traversal and symlinked skill paths before hashing a recorded binding', () => {
    const fixture = fixtureRepo('unsafe-record');
    const installed = onboardBmadRepo(fixture.name, 'install', {
      workspaceRoot: fixture.workspace,
      answers: answers(fixture.workspace, fixture.name, 'install'),
      run: successfulInstaller(fixture.repo, []),
    });
    expect(installed.ready, installed.message).toBe(true);
    const recordPath = join(fixture.repo, '.gru-command', 'bmad-install.json');
    const original = readFileSync(recordPath, 'utf-8');
    const record = JSON.parse(original) as { runtime_skills: { pi: string[] } };
    const outside = join(fixture.workspace, 'outside.txt');
    writeFileSync(outside, 'private outside bytes\n');
    record.runtime_skills.pi = ['../../../outside.txt'];
    writeFileSync(recordPath, `${JSON.stringify(record)}\n`);
    const reuse = () => onboardBmadRepo(fixture.name, 'reuse', {
      workspaceRoot: fixture.workspace,
      answers: answers(fixture.workspace, fixture.name, 'reuse'),
    });
    const traversal = reuse();
    expect(traversal.ready).toBe(false);
    expect(traversal.deterministic).toBe(true);
    expect(traversal.message).toContain('unsafe BMAD recorded skill name');
    expect(readFileSync(outside, 'utf-8')).toBe('private outside bytes\n');

    writeFileSync(recordPath, original);
    const skill = join(fixture.repo, '.agents', 'skills', 'bmad-build');
    rmSync(skill, { recursive: true, force: true });
    symlinkSync(fixture.workspace, skill);
    const symlinked = reuse();
    expect(symlinked.ready).toBe(false);
    expect(symlinked.deterministic).toBe(true);
    expect(symlinked.message).toMatch(/symlink/);
    rmSync(join(fixture.repo, '.agents'), { recursive: true, force: true });
    symlinkSync(fixture.workspace, join(fixture.repo, '.agents'));
    const ancestor = reuse();
    expect(ancestor.ready).toBe(false);
    expect(ancestor.deterministic).toBe(true);
    expect(ancestor.message).toMatch(/symlink/);
    expect(readFileSync(recordPath, 'utf-8')).toBe(original);
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
    expect(result.deterministic).toBeUndefined();
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
      // A real EACCES inside the fresh-install flow is an IO failure, not
      // unchanged-state validation: retry stays available.
      expect(result.deterministic).toBeUndefined();
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
      expect(result.deterministic).toBe(true);
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
    expect(bad.deterministic).toBe(true);
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
    expect(refused.deterministic).toBe(true);
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
    expect(unsafe.deterministic).toBe(true);
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
    // Fresh-output collision is recoverable by moving the user's skill:
    // retry/error ownership stays with the installer flow.
    expect(collided.deterministic).toBeUndefined();
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
    expect(linked.deterministic).toBe(true);
    expect(linked.message).toContain('symlink');
    expect(existsSync(join(outside.repo, '.gru-command'))).toBe(false);
  });

  it('classifies deterministic state failures as retry-futile and keeps transient failures retryable (gh-32)', () => {
    // Missing declared module directory: the exact field report — retry
    // re-checks unchanged bytes, so it must be skip-only, never retry.
    const missing = fixtureRepo('missing-module-dir');
    materializeOfficialInstall(missing.repo);
    rmSync(join(missing.repo, '_bmad', 'tea'), { recursive: true, force: true });
    const missingBefore = bmadSnapshot(missing.repo);
    const missingResult = onboardBmadRepo(missing.name, 'reuse', {
      workspaceRoot: missing.workspace,
      answers: answers(missing.workspace, missing.name, 'reuse'),
    });
    expect(missingResult.ready).toBe(false);
    expect(missingResult.deterministic).toBe(true);
    expect(missingResult.message).toContain('BMAD manifest declares missing or unsafe module directory');
    // Install-repair classes carry the official-installer escape hatch,
    // and the failed check does not mutate the install it refused.
    expect(missingResult.repairHint).toContain('npx bmad-method install');
    expect(bmadSnapshot(missing.repo)).toBe(missingBefore);

    // Unsafe (symlinked) declared module directory: same skip-only class.
    const symlinked = fixtureRepo('symlinked-module-dir');
    materializeOfficialInstall(symlinked.repo);
    const outsideModule = tempDir('gru-command-bmad-outside-module-');
    rmSync(join(symlinked.repo, '_bmad', 'gds'), { recursive: true, force: true });
    symlinkSync(outsideModule, join(symlinked.repo, '_bmad', 'gds'));
    const symlinkedBefore = bmadSnapshot(symlinked.repo);
    const symlinkedResult = onboardBmadRepo(symlinked.name, 'reuse', {
      workspaceRoot: symlinked.workspace,
      answers: answers(symlinked.workspace, symlinked.name, 'reuse'),
    });
    expect(symlinkedResult.ready).toBe(false);
    expect(symlinkedResult.deterministic).toBe(true);
    expect(symlinkedResult.message).toContain('missing or unsafe module directory');
    expect(bmadSnapshot(symlinked.repo)).toBe(symlinkedBefore);

    // Escaping declared module directory: same skip-only class. The
    // declared name carries enough ../ traversal that the resolved module
    // directory lands OUTSIDE the repo (join normalizes the path).
    const escape = fixtureRepo('escaping-module-dir');
    materializeOfficialInstall(escape.repo, '  - name: x/../../../outside-module\n    version: v1.0.0');
    mkdirSync(join(escape.workspace, 'outside-module'), { recursive: true });
    const escapeBefore = bmadSnapshot(escape.repo);
    const escapeResult = onboardBmadRepo(escape.name, 'reuse', {
      workspaceRoot: escape.workspace,
      answers: answers(escape.workspace, escape.name, 'reuse'),
    });
    expect(escapeResult.ready).toBe(false);
    expect(escapeResult.deterministic).toBe(true);
    expect(escapeResult.message).toContain('BMAD module directory escapes selected repo');
    expect(bmadSnapshot(escape.repo)).toBe(escapeBefore);

    // Selected-runtime binding mismatch (the issue's sibling class):
    // same skip-only class. Short config tokens are pre-qualified the way
    // a customized install may carry them, so verification reaches the
    // binding check rather than refusing the ambiguous token first.
    const mismatch = fixtureRepo('binding-mismatch');
    materializeOfficialInstall(mismatch.repo);
    writeFileSync(
      join(mismatch.repo, '.agents', 'skills', 'bmad-build', 'workflow.md'),
      'write to {{config.modules.bmm.implementation_artifacts}}\n',
    );
    writeFileSync(
      join(mismatch.repo, '.agents', 'skills', 'gds-quick-dev', 'workflow.md'),
      'write to {{config.modules.gds.implementation_artifacts}}\n',
    );
    const mismatchBefore = bmadSnapshot(mismatch.repo);
    const mismatchResult = onboardBmadRepo(mismatch.name, 'reuse', {
      workspaceRoot: mismatch.workspace,
      answers: parseAnswers(
        JSON.stringify({
          workspace_root: mismatch.workspace,
          repos: [mismatch.name],
          bmad: { [mismatch.name]: 'reuse' },
          runtime: 'claude-code',
          smoke: false,
        }),
      ),
    });
    expect(mismatchResult.ready).toBe(false);
    expect(mismatchResult.deterministic).toBe(true);
    expect(mismatchResult.message).toContain(
      'existing BMAD install lacks selected runtime binding(s): claude-code',
    );
    expect(mismatchResult.repairHint).toContain('npx bmad-method install');
    expect(bmadSnapshot(mismatch.repo)).toBe(mismatchBefore);

    // A malformed existing manifest is unchanged bytes: deterministic too.
    const malformed = fixtureRepo('malformed-classification');
    mkdirSync(join(malformed.repo, '_bmad', '_config'), { recursive: true });
    writeFileSync(join(malformed.repo, '_bmad', '_config', 'manifest.yaml'), 'not-a-manifest\n');
    const malformedBefore = bmadSnapshot(malformed.repo);
    const malformedResult = onboardBmadRepo(malformed.name, 'reuse', {
      workspaceRoot: malformed.workspace,
      answers: answers(malformed.workspace, malformed.name, 'reuse'),
    });
    expect(malformedResult.ready).toBe(false);
    expect(malformedResult.deterministic).toBe(true);
    expect(malformedResult.message).toContain('existing BMAD manifest is malformed');
    expect(bmadSnapshot(malformed.repo)).toBe(malformedBefore);

    // Transient installer failure keeps the retry offer — no flag.
    const transient = fixtureRepo('transient-classification');
    const transientResult = onboardBmadRepo(transient.name, 'install', {
      workspaceRoot: transient.workspace,
      answers: answers(transient.workspace, transient.name, 'install'),
      run: ((_command: string, _args: string[]) => ({
        status: 1,
        signal: null,
        stdout: '',
        stderr: 'fixture network unavailable',
        pid: 1,
        output: [],
      })) as unknown as typeof spawnSync,
    });
    expect(transientResult.ready).toBe(false);
    expect(transientResult.deterministic).toBeUndefined();
    expect(transientResult.message).toContain('retry this repo or skip it');

    // Missing prerequisites stay transient (install them, then retry).
    const prereq = fixtureRepo('prereq-classification');
    const prereqResult = onboardBmadRepoImpl(prereq.name, 'install', {
      workspaceRoot: prereq.workspace,
      answers: answers(prereq.workspace, prereq.name, 'install'),
      run: successfulInstaller(prereq.repo, []),
      prerequisiteCheck: (command) => command !== 'uv',
    });
    expect(prereqResult.ready).toBe(false);
    expect(prereqResult.deterministic).toBeUndefined();
    expect(prereqResult.message).toContain('missing BMAD prerequisite(s): uv');

    // "BMAD already exists" is deterministic with reuse guidance, not the
    // installer hint: installer overwrite is exactly what the guard refuses.
    const existing = fixtureRepo('already-exists');
    materializeOfficialInstall(existing.repo);
    const existingResult = onboardBmadRepo(existing.name, 'install', {
      workspaceRoot: existing.workspace,
      answers: answers(existing.workspace, existing.name, 'install'),
    });
    expect(existingResult.ready).toBe(false);
    expect(existingResult.deterministic).toBe(true);
    expect(existingResult.message).toContain('BMAD already exists; choose reuse');
    expect(existingResult.repairHint).toContain('choose reuse');
    expect(existingResult.repairHint).not.toContain('bmad-method install');

    // Reuse without a manifest and a plain non-Git directory: deterministic
    // repo/control state with neutral guidance (no installer hint).
    const absent = fixtureRepo('reuse-without-manifest');
    const absentResult = onboardBmadRepo(absent.name, 'reuse', {
      workspaceRoot: absent.workspace,
      answers: answers(absent.workspace, absent.name, 'reuse'),
    });
    expect(absentResult.ready).toBe(false);
    expect(absentResult.deterministic).toBe(true);
    expect(absentResult.message).toContain('reuse requested but no existing BMAD manifest');
    expect(absentResult.repairHint).toBeUndefined();

    // A plain non-Git directory: production answers validation requires a
    // `.git` entry, so the fixture validates answers while the directory is
    // still a Git repo, then removes `.git` (the race validateRepo guards).
    // parseAnswers still refuses the now-invalid name; the direct onboarding
    // seam classifies the unchanged on-disk state deterministically and
    // writes nothing.
    const plain = fixtureRepo('plain-dir');
    const parsedPlain = answers(plain.workspace, plain.name, 'reuse');
    rmSync(join(plain.repo, '.git'), { recursive: true, force: true });
    expect(() => answers(plain.workspace, plain.name, 'reuse')).toThrow(
      /not a git repo under the workspace root/,
    );
    const plainBefore = readdirSync(plain.repo).sort();
    const plainResult = onboardBmadRepo(plain.name, 'reuse', {
      workspaceRoot: plain.workspace,
      answers: parsedPlain,
    });
    expect(plainResult.ready).toBe(false);
    expect(plainResult.deterministic).toBe(true);
    expect(plainResult.message).toContain('selected directory is not a Git repo');
    expect(plainResult.repairHint).toBeUndefined();
    expect(readdirSync(plain.repo).sort()).toEqual(plainBefore);

    // A .git that is not a real repository: a clean non-zero exit from the
    // probe, unchanged bytes — deterministic (unlike a spawn failure).
    const brokenGit = tempDir('gru-command-bmad-broken-git-');
    mkdirSync(join(brokenGit, 'broken-dir', '.git'), { recursive: true });
    const brokenGitResult = onboardBmadRepo('broken-dir', 'reuse', {
      workspaceRoot: brokenGit,
      answers: answers(brokenGit, 'broken-dir', 'reuse'),
    });
    expect(brokenGitResult.ready).toBe(false);
    expect(brokenGitResult.deterministic).toBe(true);
    expect(brokenGitResult.message).toContain('selected directory is not a usable Git repo');

    // An unsafe control path (.gru-command symlink) is deterministic too.
    const controlLink = fixtureRepo('control-symlink');
    symlinkSync(tempDir('gru-command-bmad-control-target-'), join(controlLink.repo, '.gru-command'));
    const controlLinkResult = onboardBmadRepo(controlLink.name, 'reuse', {
      workspaceRoot: controlLink.workspace,
      answers: answers(controlLink.workspace, controlLink.name, 'reuse'),
    });
    expect(controlLinkResult.ready).toBe(false);
    expect(controlLinkResult.deterministic).toBe(true);
    expect(controlLinkResult.message).toContain('refusing BMAD control writes through unsafe path');

    // A git spawn/tool failure is recoverable tool availability, not repo
    // state: it keeps the retry/skip offer even though bytes are unchanged.
    const noGit = fixtureRepo('git-probe-failure');
    const noGitResult = onboardBmadRepo(noGit.name, 'reuse', {
      workspaceRoot: noGit.workspace,
      answers: answers(noGit.workspace, noGit.name, 'reuse'),
      env: { PATH: '/nonexistent-gru-command-test-bin' },
    });
    expect(noGitResult.ready).toBe(false);
    expect(noGitResult.deterministic).toBeUndefined();
    expect(noGitResult.message).toContain('git probe failed');
    expect(noGitResult.message).toContain('retry or skip this repo');

    // Record-state refusals are deterministic too (unchanged bytes).
    const recordCases: Array<[Record<string, unknown>, string]> = [
      [{ managed_by: 'gru-command' }, 'lacks a source payload fingerprint'],
      [
        { managed_by: 'gru-command', source_payload_sha256: 'x', runtime_skills: { pi: 'nope' } },
        'invalid runtime_skills',
      ],
      [
        { managed_by: 'gru-command', source_payload_sha256: 'x', source_payload_format: 'v2' },
        'unsupported source payload format',
      ],
    ];
    for (const [record, expected] of recordCases) {
      const fixture = fixtureRepo('record-state');
      materializeOfficialInstall(fixture.repo);
      mkdirSync(join(fixture.repo, '.gru-command'), { recursive: true });
      writeFileSync(
        join(fixture.repo, '.gru-command', 'bmad-install.json'),
        `${JSON.stringify(record)}\n`,
      );
      const result = onboardBmadRepo(fixture.name, 'reuse', {
        workspaceRoot: fixture.workspace,
        answers: answers(fixture.workspace, fixture.name, 'reuse'),
      });
      expect(result.ready, result.message).toBe(false);
      expect(result.deterministic).toBe(true);
      expect(result.message).toContain(expected);
    }

    // Fresh-installer output drift is not user state: retry/error ownership
    // stays with the installer flow (no deterministic flag).
    const drift = fixtureRepo('drift-classification');
    const driftResult = onboardBmadRepo(drift.name, 'install', {
      workspaceRoot: drift.workspace,
      answers: answers(drift.workspace, drift.name, 'install'),
      run: ((_command: string, args: string[]) => {
        const directoryAt = args.indexOf('--directory');
        const directory = args[directoryAt + 1]!;
        materializeOfficialInstall(directory, '', ['pi']);
        const manifestPath = join(directory, '_bmad', '_config', 'manifest.yaml');
        writeFileSync(
          manifestPath,
          readFileSync(manifestPath, 'utf-8').replace(
            `version: ${BMAD_MODULE_PINS.tea}`,
            'version: v9.9.9',
          ),
        );
        return { status: 0, signal: null, stdout: '', stderr: '', pid: 1, output: [] };
      }) as unknown as typeof spawnSync,
    });
    expect(driftResult.ready).toBe(false);
    expect(driftResult.deterministic).toBeUndefined();
    expect(driftResult.message).toContain('version drift for tea');
  });

  it('already-onboarded missing declared module directory keeps the installer hint before any fingerprint refusal (gh-32 r1)', () => {
    // Successful onboarding FIRST, then a DECLARED MODULE directory goes
    // missing: the module-directory check must classify BEFORE the
    // fingerprint refusal (which would also fire) so the official-installer
    // repair hint is retained. Fingerprint validation itself is not
    // weakened — it runs unchanged, after the directory check.
    const missingModule = fixtureRepo('onboarded-missing-module');
    const installedMissing = onboardBmadRepo(missingModule.name, 'install', {
      workspaceRoot: missingModule.workspace,
      answers: answers(missingModule.workspace, missingModule.name, 'install'),
      run: successfulInstaller(missingModule.repo, []),
    });
    expect(installedMissing.ready, installedMissing.message).toBe(true);
    rmSync(join(missingModule.repo, '_bmad', 'tea'), { recursive: true, force: true });
    const missingBefore = bmadSnapshot(missingModule.repo);
    const missingAfter = onboardBmadRepo(missingModule.name, 'reuse', {
      workspaceRoot: missingModule.workspace,
      answers: answers(missingModule.workspace, missingModule.name, 'reuse'),
    });
    expect(missingAfter.ready).toBe(false);
    expect(missingAfter.deterministic).toBe(true);
    expect(missingAfter.message).toContain('missing or unsafe module directory');
    expect(missingAfter.message).not.toContain('source payload changed');
    expect(missingAfter.repairHint).toContain('npx bmad-method install');
    expect(bmadSnapshot(missingModule.repo)).toBe(missingBefore);
  });

  it('already-onboarded symlinked declared module directory keeps the installer hint (gh-32 r1)', () => {
    // Same shape with a SYMLINKED declared module (the payload fingerprint
    // changes too): still the deterministic module-directory class with the
    // installer hint, not a symlink-payload refusal.
    const linkedModule = fixtureRepo('onboarded-symlinked-module');
    const installedLinked = onboardBmadRepo(linkedModule.name, 'install', {
      workspaceRoot: linkedModule.workspace,
      answers: answers(linkedModule.workspace, linkedModule.name, 'install'),
      run: successfulInstaller(linkedModule.repo, []),
    });
    expect(installedLinked.ready, installedLinked.message).toBe(true);
    const outsideModule = tempDir('gru-command-bmad-outside-module-');
    rmSync(join(linkedModule.repo, '_bmad', 'gds'), { recursive: true, force: true });
    symlinkSync(outsideModule, join(linkedModule.repo, '_bmad', 'gds'));
    const linkedAfter = onboardBmadRepo(linkedModule.name, 'reuse', {
      workspaceRoot: linkedModule.workspace,
      answers: answers(linkedModule.workspace, linkedModule.name, 'reuse'),
    });
    expect(linkedAfter.ready).toBe(false);
    expect(linkedAfter.deterministic).toBe(true);
    expect(linkedAfter.message).toContain('missing or unsafe module directory');
    expect(linkedAfter.repairHint).toContain('npx bmad-method install');
  });

  it('already-onboarded deleted recorded runtime binding is deterministic with installer guidance, never a futile retry (gh-32 r1)', () => {
    // Successful onboarding, then a RECORDED runtime binding is deleted:
    // the native ENOENT must become the deterministic class with installer
    // guidance — never a futile retry offer.
    const deletedBinding = fixtureRepo('onboarded-deleted-binding');
    const installedBinding = onboardBmadRepo(deletedBinding.name, 'install', {
      workspaceRoot: deletedBinding.workspace,
      answers: answers(deletedBinding.workspace, deletedBinding.name, 'install'),
      run: successfulInstaller(deletedBinding.repo, []),
    });
    expect(installedBinding.ready, installedBinding.message).toBe(true);
    rmSync(join(deletedBinding.repo, '.agents', 'skills', 'bmad-help'), { recursive: true, force: true });
    const deletedAfter = onboardBmadRepo(deletedBinding.name, 'reuse', {
      workspaceRoot: deletedBinding.workspace,
      answers: answers(deletedBinding.workspace, deletedBinding.name, 'reuse'),
    });
    expect(deletedAfter.ready).toBe(false);
    expect(deletedAfter.deterministic).toBe(true);
    expect(deletedAfter.message).toContain('BMAD recorded skill binding is missing');
    expect(deletedAfter.repairHint).toContain('npx bmad-method install');
  });

  it('valid-but-unreadable BMAD control files stay transient and recover on the SAME collected answers (gh-32 r1)', () => {
    // A VALID but UNREADABLE control file is not "malformed": the read
    // failure stays transient, and the identical call succeeds once access
    // recovers — retry preserves the collected answers (ONE captured
    // answers object drives EVERY attempt below). Permission restoration
    // lives in finally so a RED run still leaves the fixture writable.
    const unreadable = fixtureRepo('control-read-recovery');
    const installedRead = onboardBmadRepo(unreadable.name, 'install', {
      workspaceRoot: unreadable.workspace,
      answers: answers(unreadable.workspace, unreadable.name, 'install'),
      run: successfulInstaller(unreadable.repo, []),
    });
    expect(installedRead.ready, installedRead.message).toBe(true);
    const recordFile = join(unreadable.repo, '.gru-command', 'bmad-install.json');
    const manifestFile = join(unreadable.repo, '.gru-command', 'worktree.toml');
    const sharedAnswers = answers(unreadable.workspace, unreadable.name, 'reuse');
    const reuseUnreadable = () => onboardBmadRepo(unreadable.name, 'reuse', {
      workspaceRoot: unreadable.workspace,
      answers: sharedAnswers,
    });
    chmodSync(recordFile, 0o000);
    try {
      const recordDenied = reuseUnreadable();
      expect(recordDenied.ready).toBe(false);
      expect(recordDenied.deterministic).toBeUndefined();
      expect(recordDenied.message).not.toContain('malformed');
      expect(recordDenied.message).toMatch(/EACCES|permission denied/i);
    } finally {
      chmodSync(recordFile, 0o644);
    }
    const recordRecovered = reuseUnreadable();
    expect(recordRecovered.ready, recordRecovered.message).toBe(true);

    chmodSync(manifestFile, 0o000);
    try {
      const manifestDenied = reuseUnreadable();
      expect(manifestDenied.ready).toBe(false);
      expect(manifestDenied.deterministic).toBeUndefined();
      expect(manifestDenied.message).not.toContain('malformed');
      expect(manifestDenied.message).toMatch(/EACCES|permission denied/i);
    } finally {
      chmodSync(manifestFile, 0o644);
    }
    const manifestRecovered = reuseUnreadable();
    expect(manifestRecovered.ready, manifestRecovered.message).toBe(true);
  });

  it('disposable BMAD preflight output failing safety validation stays transient and the next attempt completes (gh-32 r1)', () => {
    // Disposable PREFLIGHT output that fails safety validation is still
    // refused, but stays TRANSIENT: the stage is deleted and the repo is
    // untouched, so the next attempt can complete (stateful synthetic
    // installer — no real installer execution). Existing-repo unsafe
    // bindings keep their deterministic classification elsewhere in this
    // suite (unsafe-runtime-root, control-symlink).
    const preflight = fixtureRepo('preflight-transient');
    mkdirSync(join(preflight.workspace, 'outside-preflight'), { recursive: true });
    let installerCalls = 0;
    const flaky = ((_command: string, args: string[]) => {
      installerCalls += 1;
      const directoryAt = args.indexOf('--directory');
      const directory = args[directoryAt + 1] ?? preflight.repo;
      materializeOfficialInstall(directory, '', ['pi']);
      if (installerCalls === 1) {
        symlinkSync(
          join(preflight.workspace, 'outside-preflight'),
          join(directory, '.agents', 'skills', 'evil-binding'),
        );
      }
      return { status: 0, signal: null, stdout: '', stderr: '', pid: 1, output: [] };
    }) as unknown as typeof spawnSync;
    const refused = onboardBmadRepo(preflight.name, 'install', {
      workspaceRoot: preflight.workspace,
      answers: answers(preflight.workspace, preflight.name, 'install'),
      run: flaky,
    });
    expect(refused.ready).toBe(false);
    expect(refused.deterministic).toBeUndefined();
    expect(refused.message).toContain('skill binding is a symlink');
    // The disposable staging path is deleted in finally and must not leak
    // into user-facing text (final-review finding): the message names the
    // class, not the vanished temp directory.
    expect(refused.message).not.toContain('gru-command-bmad-preflight-');
    expect(existsSync(join(preflight.repo, '_bmad'))).toBe(false);
    const retried = onboardBmadRepo(preflight.name, 'install', {
      workspaceRoot: preflight.workspace,
      answers: answers(preflight.workspace, preflight.name, 'install'),
      run: flaky,
    });
    expect(retried.ready, retried.message).toBe(true);
    // Refused attempt: preflight stage only. Retried attempt: stage + repo.
    expect(installerCalls).toBe(3);
  });

  it('bootstraps isolated copies into a real fresh worktree and fails when a required source module disappears', async () => {
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
    // Explicit modes keep the fixture independent of the runner's umask.
    chmodSync(join(fixture.repo, '_bmad'), 0o755);
    chmodSync(join(fixture.repo, '_bmad', '_config'), 0o755);
    chmodSync(join(fixture.repo, '_bmad', 'bmm'), 0o755);
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
    await applyWorktreeManifest(manifest!, {
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

    // The copied source root is public, but a pre-existing lane directory
    // with extra private contents must never inherit that source mode.
    const privateWorktree = join(fixture.workspace, 'private-worktree');
    git(fixture.repo, ['worktree', 'add', privateWorktree, 'HEAD']);
    const privateDir = join(privateWorktree, '_bmad');
    mkdirSync(privateDir, { mode: 0o700 });
    writeFileSync(join(privateDir, 'private.txt'), 'unrelated secret\n', { mode: 0o600 });
    chmodSync(privateDir, 0o700);
    const privateConfig = join(privateDir, '_config');
    mkdirSync(privateConfig, { mode: 0o700 });
    writeFileSync(join(privateConfig, 'extra.txt'), 'private config\n', { mode: 0o600 });
    chmodSync(privateConfig, 0o700);
    expect(lstatSync(join(fixture.repo, '_bmad')).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(fixture.repo, '_bmad', '_config')).mode & 0o777).toBe(0o755);
    await applyWorktreeManifest(manifest!, {
      sourceRoot: fixture.repo,
      worktreePath: privateWorktree,
      setupTimeoutMs: 60_000,
    });
    expect(lstatSync(privateDir).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(privateDir, 'private.txt'), 'utf-8')).toBe('unrelated secret\n');
    expect(lstatSync(privateConfig).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(privateConfig, 'extra.txt'), 'utf-8')).toBe('private config\n');
    expect(lstatSync(join(privateDir, 'bmm')).mode & 0o777).toBe(
      lstatSync(join(fixture.repo, '_bmad', 'bmm')).mode & 0o777,
    );
    git(fixture.repo, ['worktree', 'remove', '--force', privateWorktree]);

    const renderCache = join(fixture.repo, '_bmad', 'render');
    const pythonCache = join(fixture.repo, '_bmad', 'gds', '__pycache__');
    mkdirSync(renderCache, { recursive: true });
    mkdirSync(pythonCache, { recursive: true });
    writeFileSync(join(renderCache, 'generated.md'), 'mutable render\n');
    writeFileSync(join(pythonCache, 'render.pyc'), 'mutable bytecode\n');
    const cacheWorktree = join(fixture.workspace, 'cache-worktree');
    git(fixture.repo, ['worktree', 'add', cacheWorktree, 'HEAD']);
    await applyWorktreeManifest(manifest!, {
      sourceRoot: fixture.repo,
      worktreePath: cacheWorktree,
      setupTimeoutMs: 60_000,
    });
    expect(existsSync(join(cacheWorktree, '_bmad', 'render'))).toBe(false);
    expect(existsSync(join(cacheWorktree, '_bmad', 'gds', '__pycache__'))).toBe(false);
    git(fixture.repo, ['worktree', 'remove', '--force', cacheWorktree]);

    rmSync(renderCache, { recursive: true, force: true });
    rmSync(pythonCache, { recursive: true, force: true });
    const externalCache = tempDir('gru-command-derived-cache-');
    symlinkSync(externalCache, renderCache);
    symlinkSync(externalCache, pythonCache);
    const symlinkCacheWorktree = join(fixture.workspace, 'symlink-cache-worktree');
    git(fixture.repo, ['worktree', 'add', symlinkCacheWorktree, 'HEAD']);
    await applyWorktreeManifest(manifest!, {
      sourceRoot: fixture.repo,
      worktreePath: symlinkCacheWorktree,
      setupTimeoutMs: 60_000,
    });
    expect(existsSync(join(symlinkCacheWorktree, '_bmad', 'render'))).toBe(false);
    expect(existsSync(join(symlinkCacheWorktree, '_bmad', 'gds', '__pycache__'))).toBe(false);
    git(fixture.repo, ['worktree', 'remove', '--force', symlinkCacheWorktree]);

    const unsafeWorktree = join(fixture.workspace, 'unsafe-skill-worktree');
    git(fixture.repo, ['worktree', 'add', unsafeWorktree, 'HEAD']);
    const unsafeRecordPath = join(unsafeWorktree, '.gru-command', 'bmad-install.json');
    const unsafeRecord = JSON.parse(readFileSync(unsafeRecordPath, 'utf-8')) as {
      runtime_skills: { pi: string[] };
    };
    unsafeRecord.runtime_skills.pi = ['../../../outside.txt'];
    writeFileSync(unsafeRecordPath, JSON.stringify(unsafeRecord));
    await expect(applyWorktreeManifest(manifest!, {
      sourceRoot: fixture.repo, worktreePath: unsafeWorktree, setupTimeoutMs: 60_000,
    })).rejects.toThrow(/unsafe skill name/);
    git(fixture.repo, ['worktree', 'remove', '--force', unsafeWorktree]);

    // Executable source changes remain integrity failures despite cache exclusions.
    writeFileSync(join(fixture.repo, '_bmad', 'gds', 'marker.txt'), 'changed source\n');
    const changedWorktree = join(fixture.workspace, 'changed-worktree');
    git(fixture.repo, ['worktree', 'add', changedWorktree, 'HEAD']);
    await expect(applyWorktreeManifest(manifest!, {
      sourceRoot: fixture.repo,
      worktreePath: changedWorktree,
      setupTimeoutMs: 60_000,
    })).rejects.toThrow(/source payload changed/);
    git(fixture.repo, ['worktree', 'remove', '--force', changedWorktree]);
    writeFileSync(join(fixture.repo, '_bmad', 'gds', 'marker.txt'), 'gds\n');

    const escapedWorktree = join(fixture.workspace, 'escaped-worktree');
    const outsideDestination = tempDir('gru-command-bmad-bootstrap-outside-');
    git(fixture.repo, ['worktree', 'add', escapedWorktree, 'HEAD']);
    symlinkSync(outsideDestination, join(escapedWorktree, '_bmad'));
    await expect(applyWorktreeManifest(manifest!, {
      sourceRoot: fixture.repo,
      worktreePath: escapedWorktree,
      setupTimeoutMs: 60_000,
    })).rejects.toThrow(/destination symlink/);
    expect(existsSync(join(outsideDestination, '_config'))).toBe(false);
    git(fixture.repo, ['worktree', 'remove', '--force', escapedWorktree]);

    for (const destination of ['_bmad', join('.agents', 'skills', 'bmad-build')]) {
      const danglingWorktree = join(fixture.workspace, `dangling-${destination.replaceAll('/', '-')}`);
      git(fixture.repo, ['worktree', 'add', danglingWorktree, 'HEAD']);
      const link = join(danglingWorktree, destination);
      mkdirSync(join(link, '..'), { recursive: true });
      symlinkSync(join(outsideDestination, 'missing-target'), link);
      await expect(applyWorktreeManifest(manifest!, {
        sourceRoot: fixture.repo,
        worktreePath: danglingWorktree,
        setupTimeoutMs: 60_000,
      })).rejects.toThrow(/destination symlink/);
      expect(existsSync(join(outsideDestination, 'missing-target'))).toBe(false);
      git(fixture.repo, ['worktree', 'remove', '--force', danglingWorktree]);
    }

    rmSync(join(fixture.repo, '_bmad', 'bmm'), { recursive: true, force: true });
    const brokenWorktree = join(fixture.workspace, 'broken-worktree');
    git(fixture.repo, ['worktree', 'add', brokenWorktree, 'HEAD']);
    await expect(applyWorktreeManifest(manifest!, {
      sourceRoot: fixture.repo,
      worktreePath: brokenWorktree,
      setupTimeoutMs: 60_000,
    })).rejects.toThrow(/source payload changed|missing required module bmm/);
    git(fixture.repo, ['worktree', 'remove', '--force', brokenWorktree]);
  }, 120_000);

  describe('gh-32 final-review repairs (independent tracked review)', () => {
    it('unpaired managed-block markers in worktree.toml are deterministic skip-only, never a futile retry', () => {
      const fixture = fixtureRepo('malformed-managed-block');
      const installed = onboardBmadRepo(fixture.name, 'install', {
        workspaceRoot: fixture.workspace,
        answers: answers(fixture.workspace, fixture.name, 'install'),
        run: successfulInstaller(fixture.repo, []),
      });
      expect(installed.ready, installed.message).toBe(true);
      const manifestPath = join(fixture.repo, '.gru-command', 'worktree.toml');
      const broken = readFileSync(manifestPath, 'utf-8').replace('# END GRU COMMAND BMAD BOOTSTRAP', '');
      expect(broken).not.toContain('# END GRU COMMAND BMAD BOOTSTRAP');
      writeFileSync(manifestPath, broken);
      const before = bmadSnapshot(fixture.repo);
      const result = onboardBmadRepo(fixture.name, 'reuse', {
        workspaceRoot: fixture.workspace,
        answers: answers(fixture.workspace, fixture.name, 'reuse'),
      });
      expect(result.ready).toBe(false);
      expect(result.deterministic).toBe(true);
      expect(result.message).toContain('malformed managed block: expected paired');
      expect(readFileSync(manifestPath, 'utf-8')).toBe(broken);
      expect(bmadSnapshot(fixture.repo)).toBe(before);
    });

    it('fresh-installer output failing post-install validation stays transient (never skip-only)', () => {
      const fixture = fixtureRepo('fresh-output-flake');
      let calls = 0;
      const flaky = ((_command: string, args: string[]) => {
        calls += 1;
        const directoryAt = args.indexOf('--directory');
        const directory = args[directoryAt + 1] ?? fixture.repo;
        materializeOfficialInstall(directory, '', ['pi']);
        // The REPO install (second call of the first attempt) omits a
        // declared module: the installer produced invalid output.
        if (calls === 2) rmSync(join(directory, '_bmad', 'tea'), { recursive: true, force: true });
        return { status: 0, signal: null, stdout: '', stderr: '', pid: 1, output: [] };
      }) as unknown as typeof spawnSync;
      const first = onboardBmadRepo(fixture.name, 'install', {
        workspaceRoot: fixture.workspace,
        answers: answers(fixture.workspace, fixture.name, 'install'),
        run: flaky,
      });
      expect(first.ready).toBe(false);
      expect(first.deterministic).toBeUndefined();
      expect(first.message).toContain('official BMAD installer output failed validation');
      expect(first.message).toContain('missing or unsafe module directory');
      expect(first.message).toContain('retry this repo or skip');
      // The failed attempt left a partial install; the operator clears the
      // wizard's own failed output, then the next attempt can complete.
      rmSync(join(fixture.repo, '_bmad'), { recursive: true, force: true });
      rmSync(join(fixture.repo, '.agents'), { recursive: true, force: true });
      const second = onboardBmadRepo(fixture.name, 'install', {
        workspaceRoot: fixture.workspace,
        answers: answers(fixture.workspace, fixture.name, 'install'),
        run: flaky,
      });
      expect(second.ready, second.message).toBe(true);
    });

    it('missing skills root and ENOTDIR root report the root; EACCES stays transient', () => {
      const missingRoot = fixtureRepo('missing-skills-root');
      expect(
        onboardBmadRepo(missingRoot.name, 'install', {
          workspaceRoot: missingRoot.workspace,
          answers: answers(missingRoot.workspace, missingRoot.name, 'install'),
          run: successfulInstaller(missingRoot.repo, []),
        }).ready,
      ).toBe(true);
      rmSync(join(missingRoot.repo, '.agents', 'skills'), { recursive: true, force: true });
      const rootGone = onboardBmadRepo(missingRoot.name, 'reuse', {
        workspaceRoot: missingRoot.workspace,
        answers: answers(missingRoot.workspace, missingRoot.name, 'reuse'),
      });
      expect(rootGone.ready).toBe(false);
      expect(rootGone.deterministic).toBe(true);
      expect(rootGone.message).toContain('BMAD pi skills root is missing');
      expect(rootGone.message).not.toContain('recorded skill binding is missing');

      const notDir = fixtureRepo('enotdir-skills-root');
      expect(
        onboardBmadRepo(notDir.name, 'install', {
          workspaceRoot: notDir.workspace,
          answers: answers(notDir.workspace, notDir.name, 'install'),
          run: successfulInstaller(notDir.repo, []),
        }).ready,
      ).toBe(true);
      const agentsDir = join(notDir.repo, '.agents');
      rmSync(agentsDir, { recursive: true, force: true });
      writeFileSync(agentsDir, 'not a directory\n');
      const enotdir = onboardBmadRepo(notDir.name, 'reuse', {
        workspaceRoot: notDir.workspace,
        answers: answers(notDir.workspace, notDir.name, 'reuse'),
      });
      expect(enotdir.ready).toBe(false);
      expect(enotdir.deterministic).toBe(true);
      expect(enotdir.message).toContain('BMAD pi skills root is missing');

      const denied = fixtureRepo('denied-skills-root');
      expect(
        onboardBmadRepo(denied.name, 'install', {
          workspaceRoot: denied.workspace,
          answers: answers(denied.workspace, denied.name, 'install'),
          run: successfulInstaller(denied.repo, []),
        }).ready,
      ).toBe(true);
      chmodSync(join(denied.repo, '.agents'), 0o000);
      try {
        const deniedResult = onboardBmadRepo(denied.name, 'reuse', {
          workspaceRoot: denied.workspace,
          answers: answers(denied.workspace, denied.name, 'reuse'),
        });
        expect(deniedResult.ready).toBe(false);
        expect(deniedResult.deterministic).toBeUndefined();
      } finally {
        chmodSync(join(denied.repo, '.agents'), 0o755);
      }
      const recovered = onboardBmadRepo(denied.name, 'reuse', {
        workspaceRoot: denied.workspace,
        answers: answers(denied.workspace, denied.name, 'reuse'),
      });
      expect(recovered.ready, recovered.message).toBe(true);
    });

    it('control-file refusals are deterministic skip-only without mutation', () => {
      const fixture = fixtureRepo('control-refusals');
      const installed = onboardBmadRepo(fixture.name, 'install', {
        workspaceRoot: fixture.workspace,
        answers: answers(fixture.workspace, fixture.name, 'install'),
        run: successfulInstaller(fixture.repo, []),
      });
      expect(installed.ready, installed.message).toBe(true);
      const recordPath = join(fixture.repo, '.gru-command', 'bmad-install.json');
      const originalRecord = readFileSync(recordPath, 'utf-8');
      const manifestPath = join(fixture.repo, '.gru-command', 'worktree.toml');
      const originalManifest = readFileSync(manifestPath, 'utf-8');
      const reuse = () => onboardBmadRepo(fixture.name, 'reuse', {
        workspaceRoot: fixture.workspace,
        answers: answers(fixture.workspace, fixture.name, 'reuse'),
      });

      rmSync(recordPath);
      writeFileSync(join(fixture.workspace, 'outside-record.json'), '{"managed_by":"outside"}\n');
      symlinkSync(join(fixture.workspace, 'outside-record.json'), recordPath);
      const linked = reuse();
      expect(linked.deterministic).toBe(true);
      expect(linked.message).toContain('refusing BMAD control write through unsafe path');
      rmSync(recordPath);

      writeFileSync(recordPath, 'not json at all\n');
      const malformed = reuse();
      expect(malformed.deterministic).toBe(true);
      expect(malformed.message).toContain('existing BMAD record is malformed');

      writeFileSync(recordPath, '{"managed_by":"someone-else"}\n');
      const foreign = reuse();
      expect(foreign.deterministic).toBe(true);
      expect(foreign.message).toContain('refusing to overwrite non-Gru BMAD record');
      writeFileSync(recordPath, originalRecord);

      writeFileSync(manifestPath, 'not = = toml\n');
      const malformedManifest = reuse();
      expect(malformedManifest.deterministic).toBe(true);
      expect(malformedManifest.message).toContain('existing worktree manifest is malformed');
      writeFileSync(manifestPath, originalManifest);
      expect(reuse().ready).toBe(true);
    });

    it('validateRepo refusals outside the covered pair are deterministic, and EACCES stays transient', () => {
      const raced = fixtureRepo('deleted-repo-race');
      const parsed = answers(raced.workspace, raced.name, 'reuse');
      rmSync(raced.repo, { recursive: true, force: true });
      const deleted = onboardBmadRepo(raced.name, 'reuse', {
        workspaceRoot: raced.workspace,
        answers: parsed,
      });
      expect(deleted.ready).toBe(false);
      expect(deleted.deterministic).toBe(true);
      expect(deleted.message).toContain('selected repo no longer exists');

      const fakeBin = tempDir('gru-command-fake-git-');
      writeFileSync(
        join(fakeBin, 'git'),
        '#!/usr/bin/env bash\nif [[ "$*" == *"--show-toplevel"* ]]; then echo "$FAKE_GIT_TOPLEVEL"; exit 0; fi\nexit 1\n',
        { mode: 0o755 },
      );
      const ghost = fixtureRepo('ghost-toplevel');
      const ghostProbe = onboardBmadRepo(ghost.name, 'reuse', {
        workspaceRoot: ghost.workspace,
        answers: answers(ghost.workspace, ghost.name, 'reuse'),
        env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, FAKE_GIT_TOPLEVEL: join(ghost.workspace, 'no-such-toplevel') },
      });
      expect(ghostProbe.ready).toBe(false);
      expect(ghostProbe.deterministic).toBe(true);
      expect(ghostProbe.message).toContain('invalid top-level path');

      const blockedParent = join(ghost.workspace, 'blocked-parent');
      mkdirSync(blockedParent);
      chmodSync(blockedParent, 0o000);
      try {
        const deniedProbe = onboardBmadRepo(ghost.name, 'reuse', {
          workspaceRoot: ghost.workspace,
          answers: answers(ghost.workspace, ghost.name, 'reuse'),
          env: { PATH: `${fakeBin}:${process.env.PATH ?? ''}`, FAKE_GIT_TOPLEVEL: join(blockedParent, 'toplevel') },
        });
        expect(deniedProbe.ready).toBe(false);
        expect(deniedProbe.deterministic).toBeUndefined();
      } finally {
        chmodSync(blockedParent, 0o755);
      }
    });

    it('reuse-path content validator classifications are pinned (final review)', () => {
      const ambiguous = fixtureRepo('raw-config-tokens');
      materializeOfficialInstall(ambiguous.repo, '', ['pi']);
      const ambiguousResult = onboardBmadRepo(ambiguous.name, 'reuse', {
        workspaceRoot: ambiguous.workspace,
        answers: answers(ambiguous.workspace, ambiguous.name, 'reuse'),
      });
      expect(ambiguousResult.deterministic).toBe(true);
      expect(ambiguousResult.message).toContain('ambiguous BMM/GDS config token');
      expect(ambiguousResult.repairHint).toContain('npx bmad-method install');

      const missingSkill = fixtureRepo('missing-build-skill');
      materializeOfficialInstall(missingSkill.repo, '', ['pi']);
      rmSync(join(missingSkill.repo, '.agents', 'skills', 'bmad-build', 'SKILL.md'));
      const missingResult = onboardBmadRepo(missingSkill.name, 'reuse', {
        workspaceRoot: missingSkill.workspace,
        answers: answers(missingSkill.workspace, missingSkill.name, 'reuse'),
      });
      expect(missingResult.deterministic).toBe(true);
      expect(missingResult.message).toContain('binding is missing required bmad-build skill');
      expect(missingResult.repairHint).toContain('npx bmad-method install');

      const symlinkedEntry = fixtureRepo('symlinked-skill-entry');
      materializeOfficialInstall(symlinkedEntry.repo, '', ['pi']);
      symlinkSync(tempDir('gru-command-bmad-se-outside-'), join(symlinkedEntry.repo, '.agents', 'skills', 'evil'));
      const symlinkedResult = onboardBmadRepo(symlinkedEntry.name, 'reuse', {
        workspaceRoot: symlinkedEntry.workspace,
        answers: answers(symlinkedEntry.workspace, symlinkedEntry.name, 'reuse'),
      });
      expect(symlinkedResult.deterministic).toBe(true);
      expect(symlinkedResult.message).toContain('BMAD skill binding is a symlink');

      const payloadLink = fixtureRepo('owned-payload-symlink');
      const payloadInstalled = onboardBmadRepo(payloadLink.name, 'install', {
        workspaceRoot: payloadLink.workspace,
        answers: answers(payloadLink.workspace, payloadLink.name, 'install'),
        run: successfulInstaller(payloadLink.repo, []),
      });
      expect(payloadInstalled.ready, payloadInstalled.message).toBe(true);
      symlinkSync(tempDir('gru-command-bmad-payload-outside-'), join(payloadLink.repo, '_bmad', 'evil-link'));
      const payloadResult = onboardBmadRepo(payloadLink.name, 'reuse', {
        workspaceRoot: payloadLink.workspace,
        answers: answers(payloadLink.workspace, payloadLink.name, 'reuse'),
      });
      expect(payloadResult.deterministic).toBe(true);
      expect(payloadResult.message).toContain('owned payload contains symlink');

      const fileBinding = fixtureRepo('recorded-skill-file');
      const fileInstalled = onboardBmadRepo(fileBinding.name, 'install', {
        workspaceRoot: fileBinding.workspace,
        answers: answers(fileBinding.workspace, fileBinding.name, 'install'),
        run: successfulInstaller(fileBinding.repo, []),
      });
      expect(fileInstalled.ready, fileInstalled.message).toBe(true);
      const buildSkill = join(fileBinding.repo, '.agents', 'skills', 'bmad-build');
      rmSync(buildSkill, { recursive: true, force: true });
      writeFileSync(buildSkill, 'not a directory\n');
      const fileResult = onboardBmadRepo(fileBinding.name, 'reuse', {
        workspaceRoot: fileBinding.workspace,
        answers: answers(fileBinding.workspace, fileBinding.name, 'reuse'),
      });
      expect(fileResult.deterministic).toBe(true);
      expect(fileResult.message).toContain('unsafe BMAD recorded skill path');
    });

    it('a denied manifest read stays transient and recovers on the SAME collected answers', () => {
      const fixture = fixtureRepo('denied-manifest-read');
      const installed = onboardBmadRepo(fixture.name, 'install', {
        workspaceRoot: fixture.workspace,
        answers: answers(fixture.workspace, fixture.name, 'install'),
        run: successfulInstaller(fixture.repo, []),
      });
      expect(installed.ready, installed.message).toBe(true);
      const answersObject = answers(fixture.workspace, fixture.name, 'reuse');
      const manifestPath = join(fixture.repo, '_bmad', '_config', 'manifest.yaml');
      chmodSync(manifestPath, 0o000);
      try {
        const denied = onboardBmadRepo(fixture.name, 'reuse', {
          workspaceRoot: fixture.workspace,
          answers: answersObject,
        });
        expect(denied.ready).toBe(false);
        expect(denied.deterministic).toBeUndefined();
        expect(denied.message).not.toContain('malformed');
      } finally {
        chmodSync(manifestPath, 0o644);
      }
      const recovered = onboardBmadRepo(fixture.name, 'reuse', {
        workspaceRoot: fixture.workspace,
        answers: answersObject,
      });
      expect(recovered.ready, recovered.message).toBe(true);
    });

    it('ancestor symlink refusals carry the official-installer repair hint for existing installs', () => {
      const fixture = fixtureRepo('ancestor-symlink-hint');
      const installed = onboardBmadRepo(fixture.name, 'install', {
        workspaceRoot: fixture.workspace,
        answers: answers(fixture.workspace, fixture.name, 'install'),
        run: successfulInstaller(fixture.repo, []),
      });
      expect(installed.ready, installed.message).toBe(true);
      const bmadDir = join(fixture.repo, '_bmad');
      const bmadReal = join(fixture.repo, '_bmad-real');
      renameSync(bmadDir, bmadReal);
      // Symlink to the REAL content so the manifest still reads; the
      // ancestor-refusal classification (with the installer hint) is what
      // this case pins.
      symlinkSync(bmadReal, bmadDir);
      const result = onboardBmadRepo(fixture.name, 'reuse', {
        workspaceRoot: fixture.workspace,
        answers: answers(fixture.workspace, fixture.name, 'reuse'),
      });
      expect(result.ready).toBe(false);
      expect(result.deterministic).toBe(true);
      expect(result.message).toContain('refusing BMAD path through symlink');
      expect(result.repairHint).toContain('npx bmad-method install');
    });
  });
});
