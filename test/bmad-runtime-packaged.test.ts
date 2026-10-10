import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readBuildInfo } from '../src/build-info.js';

/**
 * Packaged-layout smoke (issue #283): the GC-managed BMAD runtime must work
 * from exactly the files the npm package ships — never from this source
 * checkout's unshipped files, a developer's BMAD install, or global skills.
 * The test stages the `npm pack` file list in an empty directory (plus the
 * dependency tree every install carries) and drives the compiled product
 * from there under an empty HOME: validate GC setup without provisioning,
 * then explicitly exercise the retained historical binder and renderer.
 */

const repoRoot = join(import.meta.dirname, '..');
const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanupDirs.push(dir);
  return dir;
}

/** The staged dist/ must be this checkout's current build (see roles-installed-playbook). */
function assertDistCurrent(): void {
  if (!existsSync(join(repoRoot, 'dist', 'bmad', 'runtime.js'))) {
    throw new Error('dist/bmad/runtime.js is missing — run `npm run build` first; this smoke runs the SHIPPED compiled artifact');
  }
  if (!existsSync(join(repoRoot, '.git'))) return;
  const head = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  const dirty = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--', 'src/bmad', 'src/cli/bmad-runtime.ts',
    'src/wizard', 'src/worktrees/manifest.ts', 'resources/bmad-runtime', 'docs/BMAD-RUNTIME.md', 'package.json'], { encoding: 'utf-8' }).trim();
  if (dirty !== '') {
    throw new Error(`the packaged-runtime inputs are dirty: ${dirty.split('\n').join('; ')} — commit before running this scope`);
  }
  const built = readBuildInfo(repoRoot).rev;
  if (built !== head) {
    throw new Error(`dist/ is stale for this smoke: built rev ${built ?? 'unknown'}, HEAD ${head}. Run the full gate (it rebuilds) first.`);
  }
}

/** Exactly the files `npm pack` would publish, copied into an empty root. */
function stagePackedLayout(): string {
  assertDistCurrent();
  const listed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })) as Array<{ files: Array<{ path: string }> }>;
  const stage = temp('gru-command-packed-');
  for (const { path } of listed[0]!.files) {
    mkdirSync(dirname(join(stage, path)), { recursive: true });
    cpSync(join(repoRoot, path), join(stage, path));
  }
  symlinkSync(join(repoRoot, 'node_modules'), join(stage, 'node_modules'), 'dir');
  return stage;
}

describe('retained BMAD runtime and independent GC setup from the packaged layout', () => {
  it('validates fresh GC setup without BMAD, then explicitly binds and renders the retained historical runtime', () => {
    const stage = stagePackedLayout();
    expect(existsSync(join(stage, 'src'))).toBe(false);
    expect(existsSync(join(stage, 'resources', 'bmad-runtime', 'runtime.json'))).toBe(true);
    const home = temp('gru-command-packed-home-');
    const workspace = temp('gru-command-packed-ws-');
    const repo = join(workspace, 'fresh-app');
    mkdirSync(repo);
    const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim();
    git(repo, ['init', '-q']);
    writeFileSync(join(repo, 'README.md'), '# fresh\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']);
    const store = join(home, '.gru-command', 'bmad-runtime');
    writeFileSync(join(stage, 'smoke.mjs'), `
      import { execFileSync } from 'node:child_process';
      import { join } from 'node:path';
      import { existsSync } from 'node:fs';
      import { validateRepositorySetup } from './dist/wizard/repository-setup.js';
      import { createBmadRuntimeBinder } from './dist/bmad/runtime.js';
      import { parseAnswers } from './dist/wizard/answers.js';
      const [workspace, store] = process.argv.slice(2);
      const answers = parseAnswers(JSON.stringify({ workspace_root: workspace, repos: ['fresh-app'], runtime: 'pi', smoke: false }));
      const setupRepository = validateRepositorySetup(workspace, 'fresh-app');
      const noBmadState = ['_bmad', '_bmad-output', '.agents', '.claude'].every(name => !existsSync(join(setupRepository, name)));
      const noBmadAnswers = !Object.hasOwn(answers, 'bmad');
      // This is deliberate historical-runtime maintenance, not GC setup.
      const lane = join(workspace, 'job-lane');
      execFileSync('git', ['-C', join(workspace, 'fresh-app'), 'worktree', 'add', '-q', '-b', 'gru/job', lane]);
      const bound = createBmadRuntimeBinder(store)(lane);
      const again = createBmadRuntimeBinder(store)(lane);
      process.stdout.write(JSON.stringify({ setupRepository, noBmadState, noBmadAnswers, bound, again, lane }));
    `);
    const env = { PATH: process.env.PATH ?? '', HOME: home };
    const verify = execFileSync(process.execPath, [join(stage, 'dist', 'cli', 'bmad-runtime.js'), 'verify', stage], { cwd: stage, env, encoding: 'utf-8' });
    expect(verify).toMatch(/^BMAD runtime bmad-method@6\.12\.0\+gru-command-bmad\.1 verified/u);
    const result = JSON.parse(execFileSync(process.execPath, [join(stage, 'smoke.mjs'), workspace, store], { cwd: stage, env, encoding: 'utf-8' })) as {
      setupRepository: string;
      noBmadState: boolean;
      noBmadAnswers: boolean;
      bound: { runtimeId: string; root: string; skills: string[]; laneBound: boolean };
      again: { root: string };
      lane: string;
    };
    expect(result.setupRepository).toBe(repo);
    expect(result.noBmadState).toBe(true);
    expect(result.noBmadAnswers).toBe(true);
    expect(result.bound).toMatchObject({ runtimeId: 'bmad-method@6.12.0+gru-command-bmad.1', skills: ['bmad-build'], laneBound: true });
    expect(result.bound.root.startsWith(store)).toBe(true);
    expect(result.again.root).toBe(result.bound.root);

    // The lane renders the build workflow through the shipped launcher.
    const check = execFileSync(process.execPath, [join(stage, 'dist', 'cli', 'bmad-runtime.js'), 'check', result.lane, '--store', store], {
      cwd: stage,
      env,
      encoding: 'utf-8',
    });
    const generation = /^ok bmad-build: read and follow (\/\S+)\/workflow\.md$/mu.exec(check)?.[1];
    expect(generation, check).toBeDefined();
    expect(generation!.startsWith(join(result.lane, '_bmad', 'render'))).toBe(true);
    for (const step of ['step-04-review.md', 'step-oneshot.md']) {
      const text = readFileSync(join(generation!, step), 'utf-8');
      expect(text).toContain('There is no minimum and no quota');
      expect(text).not.toMatch(/find at least|finding floor/iu);
    }
    // Nothing reached back into the source checkout or a home BMAD install.
    const mentionsSource = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((file) => readFileSync(file, 'utf-8').includes(repoRoot));
    expect(mentionsSource(result.bound.root)).toEqual([]);
    expect(mentionsSource(generation!)).toEqual([]);
    expect(existsSync(join(home, '.agents'))).toBe(false);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });
});
