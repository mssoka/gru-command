import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readBuildInfo } from '../src/build-info.js';

const repoRoot = join(import.meta.dirname, '..');
const cleanup: string[] = [];
afterAll(() => { for (const dir of cleanup) rmSync(dir, { recursive: true, force: true }); });
function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gc-workflows-packed-')));
  cleanup.push(dir);
  return dir;
}
function stagePackage(): string {
  const head = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();
  const dirty = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain', '--', 'src/workflows', 'src/bmad/runtime.ts',
    'src/cli/workflow-runtime.ts', 'resources/gc-workflows', 'package.json'], { encoding: 'utf-8' }).trim();
  if (dirty !== '' || readBuildInfo(repoRoot).rev !== head) throw new Error('Commit workflow package inputs and run npm run build before the packaged test; stale/dirty dist is not evidence.');
  const output = temp();
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', output], {
    cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  })) as Array<{ filename: string }>;
  execFileSync('tar', ['-xzf', join(output, packed[0]!.filename), '-C', output]);
  return join(output, 'package');
}

describe('GC-owned workflows in the actual distributable layout', () => {
  it('binds a lane and resolves complete normal and small-change flows with no source/ancestor/global BMAD or dependency tree', () => {
    const stage = stagePackage();
    for (const path of ['src', '_bmad', '_bmad-output', '.agents', 'node_modules']) expect(existsSync(join(stage, path)), path).toBe(false);
    expect(existsSync(join(stage, 'resources/gc-workflows/scripts/render.mjs'))).toBe(true);
    expect(existsSync(join(stage, 'docs/GC-WORKFLOWS.md'))).toBe(true);
    const retirementGuide = readFileSync(join(stage, 'docs/BMAD-RUNTIME.md'), 'utf-8');
    expect(retirementGuide).toContain('Retire only the GC bootstrap');
    expect(retirementGuide).toContain('# gc-bootstrap-retire:run');
    const home = temp();
    const workspace = temp();
    const repo = join(workspace, 'registered-app');
    mkdirSync(repo);
    const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim();
    git(repo, ['init', '-q']);
    writeFileSync(join(repo, 'README.md'), '# fixture\n');
    git(repo, ['add', 'README.md']);
    git(repo, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    const lane = join(workspace, 'assigned-lane');
    git(repo, ['worktree', 'add', '-qb', 'job', lane]);
    const store = join(home, 'gc-data', 'bmad-runtime'); // retained store/record protocol from #283
    const context = { projectId: 'registered-project-7', projectRoot: repo, worktreeRoot: lane,
      jobId: 'j-292-fixture', artifactRoot: join(home, 'gc-data', 'projects', 'registered-project-7', 'jobs', 'j-292-fixture'),
      knowledgeRoot: join(lane, 'gru-output') };
    const contextFile = join(home, 'context.json');
    writeFileSync(contextFile, JSON.stringify(context));
    const env = { HOME: home, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` };
    const verify = execFileSync(process.execPath, [join(stage, 'dist/cli/workflow-runtime.js'), 'verify', stage], { cwd: stage, env, encoding: 'utf-8' });
    expect(verify).toContain('GC workflow gru-command-workflows@1 verified');
    const snapshots = new Set<string>();
    for (const route of ['normal', 'small-change']) {
      const result = JSON.parse(execFileSync(process.execPath, [join(stage, 'dist/cli/workflow-runtime.js'), 'render',
        '--context', contextFile, '--store', store, '--package-root', stage, '--route', route], { cwd: stage, env, encoding: 'utf-8' })) as {
        runtimeId: string; entrypoint: string; snapshotDir: string; contextFile: string;
      };
      snapshots.add(result.snapshotDir);
      expect(result.runtimeId).toBe('gru-command-workflows@1');
      expect(result.snapshotDir.startsWith(context.artifactRoot)).toBe(true);
      const source = readFileSync(result.entrypoint, 'utf-8');
      expect(source).toContain(context.jobId);
      expect(source).not.toContain(repoRoot);
      for (const name of ['plan.md', 'implement.md', 'review.md', 'present.md', 'small-change.md', 'spec-template.md',
        'review-prompts/adversarial.md', 'review-prompts/edge-cases.md', 'review-prompts/verification.md',
        'references/claims-check.md', 'references/deletion-check.md']) {
        const text = readFileSync(join(result.snapshotDir, 'skills/gc-build', name), 'utf-8');
        expect(text, name).not.toMatch(/\[\[gc-resource:|\{\{context\.|_bmad|bmad-build|bmad-review/u);
        expect(text, name).not.toContain(repoRoot);
      }
      expect(readFileSync(join(result.snapshotDir, 'skills/gc-build/review.md'), 'utf-8')).toContain('actual run/session/pane identity');
    }
    expect(snapshots.size).toBe(1);
    expect(git(lane, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    const record = JSON.parse(readFileSync(join(git(lane, ['rev-parse', '--path-format=absolute', '--git-dir']), 'gru-command/bmad-runtime.json'), 'utf-8')) as { runtime_id: string; runtime_dir: string };
    expect(record.runtime_id).toBe('gru-command-workflows@1');
    expect(record.runtime_dir.startsWith(store)).toBe(true);
    for (const root of [home, workspace, repo, lane]) {
      for (const path of ['_bmad', '.agents/skills/bmad-build', '.claude/skills/bmad-build']) expect(existsSync(join(root, path))).toBe(false);
    }
    expect(existsSync(context.knowledgeRoot)).toBe(false);
  });
});
