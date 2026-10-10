import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { bindBmadRuntime, inspectMaterializedBmadRuntime, loadBundledBmadRuntime, materializeBmadRuntime } from '../src/bmad/runtime.js';
import { runWorkflowRuntimeCli } from '../src/cli/workflow-runtime.js';
import { parseWorkflowManifest, WORKFLOW_ENTRYPOINTS, WORKFLOW_RESOURCE_DIR, WORKFLOW_SOURCE } from '../src/workflows/manifest.js';
import { bindWorkflowRuntime, createWorkflowRuntimeBinder, loadBundledWorkflowRuntime, renderWorkflow, workflowLauncherCommand, WorkflowResourceError, writeWorkflowManifest, type WorkflowContext } from '../src/workflows/runtime.js';

const repoRoot = join(import.meta.dirname, '..');
const cleanup: string[] = [];
afterAll(() => { for (const dir of cleanup) rmSync(dir, { recursive: true, force: true }); });
function temp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gc-workflows-')));
  cleanup.push(dir);
  return dir;
}
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim();
}
function fixture(name = 'app'): WorkflowContext {
  const root = temp();
  const projectRoot = join(root, name);
  mkdirSync(projectRoot);
  git(projectRoot, ['init', '-q']);
  writeFileSync(join(projectRoot, 'README.md'), '# fixture\n');
  git(projectRoot, ['add', 'README.md']);
  git(projectRoot, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'fixture']);
  return { projectId: 'registered-17', jobId: 'j-42', projectRoot, worktreeRoot: projectRoot,
    artifactRoot: join(root, 'private', 'j-42'), knowledgeRoot: join(projectRoot, 'gru-output') };
}
function packageCopy(): string {
  const root = temp();
  cpSync(join(repoRoot, WORKFLOW_RESOURCE_DIR), join(root, WORKFLOW_RESOURCE_DIR), { recursive: true });
  return root;
}
function runtime() { return materializeBmadRuntime(loadBundledWorkflowRuntime(repoRoot), temp()); }
function textAt(snapshot: string, name: string): string { return readFileSync(join(snapshot, 'skills/gc-build', name), 'utf-8'); }

// Do not load at module scope: a missing package must fail the actual test, not silently collect zero.
describe('GC-owned workflow resources', () => {
  it('has a GC identity, ordinary local integrity, license/attribution and its own build verifier', () => {
    const bundle = loadBundledWorkflowRuntime(repoRoot);
    expect(bundle.id).toBe('gru-command-workflows@1');
    expect(bundle.manifest).not.toHaveProperty('upstream');
    expect(bundle.manifest).not.toHaveProperty('customization');
    expect(bundle.files.get('LICENSE')!.toString()).toContain('MIT License');
    expect(bundle.files.get('NOTICE.md')!.toString()).toContain('BMad Code, LLC');
    expect(bundle.manifest.entrypoints).toEqual(WORKFLOW_ENTRYPOINTS);
    const output: string[] = [];
    expect(runWorkflowRuntimeCli(['verify', repoRoot], (line) => output.push(line))).toBe(0);
    expect(output[0]).toContain(bundle.contentSha256);
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as { scripts: { build: string }; files: string[] };
    expect(pkg.scripts.build).toContain('node dist/cli/workflow-runtime.js verify .');
    expect(pkg.files).toContain(`${WORKFLOW_RESOURCE_DIR}/`);
  });

  it('edits templates and helpers with only a local manifest refresh, not an upstream install/archive', () => {
    const root = packageCopy();
    const before = loadBundledWorkflowRuntime(root);
    appendFileSync(join(root, WORKFLOW_RESOURCE_DIR, 'skills/gc-build/plan.md'), '\nGC-maintained planning rule.\n');
    appendFileSync(join(root, WORKFLOW_RESOURCE_DIR, 'scripts/render.mjs'), '\n// GC-maintained helper change.\n');
    expect(() => loadBundledWorkflowRuntime(root)).toThrow(/does not match its sha256/u);
    const lines: string[] = [];
    runWorkflowRuntimeCli(['manifest', root, '--version', '2'], (line) => lines.push(line));
    const after = loadBundledWorkflowRuntime(root);
    expect(after.id).toBe('gru-command-workflows@2');
    expect(after.contentSha256).not.toBe(before.contentSha256);
    expect(lines[0]).toContain('owned local resources');
    const invocation = renderWorkflow(materializeBmadRuntime(after, temp()), fixture());
    expect(textAt(invocation.snapshotDir, 'plan.md')).toContain('GC-maintained planning rule.');
    expect(existsSync(join(root, 'resources/bmad-runtime'))).toBe(false);
    expect(existsSync(join(root, '_bmad'))).toBe(false);
  });

  it('rejects missing, corrupt, undeclared and symlinked resources by name without ambient fallback', () => {
    const cases: Array<[string, (dir: string) => void, RegExp]> = [
      ['missing helper', (dir) => rmSync(join(dir, 'scripts/render.mjs')), /scripts\/render\.mjs/u],
      ['missing validator', (dir) => rmSync(join(dir, 'scripts/context.mjs')), /scripts\/context\.mjs/u],
      ['corrupt template', (dir) => appendFileSync(join(dir, 'skills/gc-build/small-change.md'), 'changed'), /small-change\.md.*sha256/u],
      ['undeclared', (dir) => writeFileSync(join(dir, 'extra.txt'), 'x'), /undeclared.*extra\.txt/u],
      ['prototype-named undeclared file', (dir) => writeFileSync(join(dir, 'toString'), 'x'), /undeclared.*toString/u],
      ['another prototype-named undeclared file', (dir) => writeFileSync(join(dir, 'constructor'), 'x'), /undeclared.*constructor/u],
      ['missing manifest', (dir) => rmSync(join(dir, 'runtime.json')), /missing runtime\.json/u],
      ['symlink', (dir) => { rmSync(join(dir, 'scripts/render.mjs')); symlinkSync(join(repoRoot, WORKFLOW_RESOURCE_DIR, 'scripts/render.mjs'), join(dir, 'scripts/render.mjs')); }, /symlink.*render\.mjs/u],
    ];
    for (const [label, mutate, message] of cases) {
      const root = packageCopy();
      mutate(join(root, WORKFLOW_RESOURCE_DIR));
      expect(() => loadBundledWorkflowRuntime(root), label).toThrow(WorkflowResourceError);
      expect(() => loadBundledWorkflowRuntime(root), label).toThrow(message);
      expect(() => loadBundledWorkflowRuntime(root), label).toThrow(/no ambient workflow fallback/u);
    }
    const root = packageCopy();
    rmSync(join(root, WORKFLOW_RESOURCE_DIR, 'skills/gc-build/review-prompts/verification.md'));
    expect(() => writeWorkflowManifest(root)).toThrow(/lacks required resource.*verification\.md/u);
  });

  it('rejects malformed identities, path declarations, omitted required helpers and broken reference closure', () => {
    const bundle = loadBundledWorkflowRuntime(repoRoot);
    for (const patch of [{ schema_version: 9 }, { id: 'bmad@latest' }, { version: 0 }, { name: 'external' }, { skills: [] }, { entrypoints: {} }, { files: { '../outside': '0'.repeat(64) } }]) {
      expect(() => parseWorkflowManifest(JSON.stringify({ ...bundle.manifest, ...patch }), 'fixture')).toThrow(WorkflowResourceError);
    }
    expect(() => parseWorkflowManifest('not-json', 'fixture')).toThrow(/not valid JSON/u);
    const root = packageCopy();
    appendFileSync(join(root, WORKFLOW_RESOURCE_DIR, 'skills/gc-build/plan.md'), '\n[[gc-resource:skills/gc-build/omitted-helper.md]]\n');
    expect(() => writeWorkflowManifest(root)).toThrow(/references missing.*omitted-helper\.md/u);
    const badContext = packageCopy();
    appendFileSync(join(badContext, WORKFLOW_RESOURCE_DIR, 'skills/gc-build/plan.md'), '\n{{context.unknown}}\n');
    expect(() => writeWorkflowManifest(badContext)).toThrow(/unknown context field unknown/u);
    const badPlugin = packageCopy();
    writeFileSync(join(badPlugin, WORKFLOW_RESOURCE_DIR, '.claude-plugin/plugin.json'), 'not JSON');
    expect(() => writeWorkflowManifest(badPlugin)).toThrow(/\.claude-plugin\/plugin\.json is not valid JSON/u);
  });

  it('resolves complete normal/small/review/planning routes from only packaged bytes and explicit context', () => {
    const context = fixture();
    const retained = runtime();
    for (const [route, entry] of Object.entries(WORKFLOW_ENTRYPOINTS)) {
      const invocation = renderWorkflow(retained, context, route as keyof typeof WORKFLOW_ENTRYPOINTS);
      expect(invocation.entrypoint).toBe(join(invocation.snapshotDir, entry));
      expect(invocation.snapshotDir.startsWith(context.artifactRoot)).toBe(true);
      expect(JSON.parse(readFileSync(invocation.contextFile, 'utf-8'))).toEqual({ ...context, runtimeId: retained.id, contentSha256: retained.contentSha256 });
      const sources = readdirSync(join(invocation.snapshotDir, 'skills'), { recursive: true, withFileTypes: true }).filter((file) => file.isFile());
      for (const file of sources) {
        const text = readFileSync(join(file.parentPath, file.name), 'utf-8');
        expect(text).not.toMatch(/\[\[gc-resource:|\{\{context\.|_bmad|bmad-build|bmad-review/u);
        for (const line of text.split('\n')) {
          for (const target of line.matchAll(new RegExp(`${invocation.snapshotDir}/skills/[A-Za-z0-9./-]+\\.md`, 'gu'))) {
            expect(existsSync(target[0]), target[0]).toBe(true);
          }
        }
      }
      expect(readFileSync(invocation.entrypoint, 'utf-8')).toContain(context.jobId);
    }
    expect(git(context.worktreeRoot, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    const snapshot = renderWorkflow(retained, context).snapshotDir;
    expect(existsSync(join(snapshot, 'skills/gc-build/SKILL.md'))).toBe(false);
    expect(existsSync(join(retained.skillsDir, 'gc-build/SKILL.md'))).toBe(true);
    expect(existsSync(join(context.worktreeRoot, '_bmad'))).toBe(false);
    expect(existsSync(context.knowledgeRoot)).toBe(false); // no premature repository writes
  });

  it('both routes preserve independent tracked review, reasoned fixes, verification and ordinary PR handoff without quotas', () => {
    const invocation = renderWorkflow(runtime(), fixture());
    const review = textAt(invocation.snapshotDir, 'review.md');
    const small = textAt(invocation.snapshotDir, 'small-change.md');
    expect(review).toContain('fresh, context-free reviewers');
    expect(review).toContain('actual run/session/pane identity');
    expect(review).toContain('reasoned disposition');
    expect(review).toContain('Re-engage independent reviewers');
    expect(small).toContain('genuinely independent adversarial reviewer');
    for (const text of [review, small]) {
      expect(text).toContain('No actionable findings.');
      expect(text).toContain('no total/per-phase tool-call ceiling');
      expect(text).not.toMatch(/find at least|finding floor|at most \d+ tool|minimum \d+ finding/iu);
    }
    expect(textAt(invocation.snapshotDir, 'present.md')).toContain('ordinary non-draft PR');
    expect(textAt(invocation.snapshotDir, 'present.md')).toContain('fallback or development PASS must never be presented as native READY');
    expect(textAt(invocation.snapshotDir, 'workflow.md')).toContain('small-change.md');
  });

  it('ignores absent, broken or symlinked ambient BMAD and does not modify its files', () => {
    const context = fixture();
    const elsewhere = temp();
    writeFileSync(join(elsewhere, 'config.toml'), 'broken; do not read\n');
    symlinkSync(elsewhere, join(context.worktreeRoot, '_bmad'));
    const ancestor = join(dirname(context.worktreeRoot), '_bmad');
    mkdirSync(ancestor);
    writeFileSync(join(ancestor, 'renderer.py'), 'raise RuntimeError("ambient")\n');
    const retained = runtime();
    const home = temp();
    mkdirSync(join(home, '.agents/skills/bmad-build'), { recursive: true });
    writeFileSync(join(home, '.agents/skills/bmad-build/SKILL.md'), 'HALT ambient\n');
    const contextFile = join(temp(), 'context.json');
    writeFileSync(contextFile, JSON.stringify(context));
    const launcher = workflowLauncherCommand(retained, contextFile);
    const result = spawnSync('/bin/sh', ['-c', launcher.command], { cwd: context.worktreeRoot, env: { HOME: home, PATH: process.env.PATH, ...launcher.env }, encoding: 'utf-8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('read and follow ');
    expect(readFileSync(join(elsewhere, 'config.toml'), 'utf-8')).toBe('broken; do not read\n');
    expect(readFileSync(join(ancestor, 'renderer.py'), 'utf-8')).toContain('ambient');
    expect(lstatSync(join(context.worktreeRoot, '_bmad')).isSymbolicLink()).toBe(true);
  });

  it('handles quoted shell-special paths inertly through its own launcher and explicit stdin API', () => {
    const context = fixture('app quotes \' " $(not-executed)');
    const retained = runtime();
    const contextFile = join(temp(), 'context quotes \' " $(not-executed).json');
    writeFileSync(contextFile, JSON.stringify(context));
    const launcher = workflowLauncherCommand(retained, contextFile, 'small-change');
    const result = spawnSync('/bin/sh', ['-c', launcher.command], { env: { PATH: process.env.PATH, HOME: temp(), ...launcher.env }, encoding: 'utf-8' });
    expect(result.status, result.stderr).toBe(0);
    const entry = result.stdout.trim().slice('read and follow '.length);
    expect(readFileSync(entry, 'utf-8')).toContain(context.worktreeRoot);
    expect(renderWorkflow(retained, context, 'small-change').entrypoint).toBe(entry);
    expect(result.stderr).toBe('');
  });

  it('rejects missing explicit identity, unsafe output roots, symlinks and unsupported routes before writing', () => {
    const retained = runtime();
    for (const patch of [{ projectId: '' }, { jobId: '../other' }, { projectRoot: 'relative' }, { artifactRoot: 'relative' }, { knowledgeRoot: '/outside' }]) {
      const context = { ...fixture(), ...patch };
      expect(() => renderWorkflow(retained, context)).toThrow(WorkflowResourceError);
      expect(existsSync(context.artifactRoot)).toBe(false);
    }
    const context = fixture();
    expect(() => renderWorkflow(retained, { ...context, artifactRoot: join(context.worktreeRoot, 'private') })).toThrow(/outside project/u);
    expect(() => renderWorkflow(retained, { ...context, artifactRoot: retained.dir })).toThrow(/outside project/u);
    expect(() => renderWorkflow(retained, { ...context, knowledgeRoot: context.worktreeRoot })).toThrow(/beneath the assigned/u);
    const external = temp();
    symlinkSync(external, join(context.worktreeRoot, 'gru-output'));
    expect(() => renderWorkflow(retained, context)).toThrow(/symlink/u);
    expect(readdirSync(external)).toEqual([]);
    expect(() => renderWorkflow(retained, fixture(), 'unknown' as 'normal')).toThrow(/unsupported/u);
  });

  it('separates two projects/jobs and keeps snapshots and retained resources immutable', () => {
    const retained = runtime();
    const first = fixture('alpha');
    const second = fixture('beta');
    const a = renderWorkflow(retained, first);
    const b = renderWorkflow(retained, { ...second, jobId: 'j-43' });
    const c = renderWorkflow(retained, { ...first, jobId: 'j-44', artifactRoot: join(dirname(first.artifactRoot), 'j-44') });
    expect(new Set([a.snapshotDir, b.snapshotDir, c.snapshotDir]).size).toBe(3);
    expect(readFileSync(b.entrypoint, 'utf-8')).not.toContain(first.worktreeRoot);
    expect(renderWorkflow(retained, first)).toEqual(a);
    expect(inspectMaterializedBmadRuntime(retained.dir).contentSha256).toBe(retained.contentSha256);
    chmodSync(a.entrypoint, 0o600);
    appendFileSync(a.entrypoint, 'tampered');
    expect(() => renderWorkflow(retained, first)).toThrow(/snapshot is missing\/modified/u);
    expect(readFileSync(a.entrypoint, 'utf-8')).toContain('tampered');
  });

  it('a lane bound to A retains A when B ships while a new lane can use B', () => {
    const context = fixture();
    const one = join(dirname(context.projectRoot), 'lane-one');
    const two = join(dirname(context.projectRoot), 'lane-two');
    git(context.projectRoot, ['worktree', 'add', '-qb', 'one', one]);
    git(context.projectRoot, ['worktree', 'add', '-qb', 'two', two]);
    const store = temp();
    const rootB = packageCopy();
    writeWorkflowManifest(rootB, 2);
    const bindA = createWorkflowRuntimeBinder(store, repoRoot);
    const bindB = createWorkflowRuntimeBinder(store, rootB);
    const a = bindA(one);
    expect(bindB(one)).toEqual(a);
    expect(bindB(two).runtimeId).toBe('gru-command-workflows@2');
    expect(a).toMatchObject({ source: WORKFLOW_SOURCE, runtimeId: 'gru-command-workflows@1', laneBound: true });
    const originalRecord = readFileSync(join(git(one, ['rev-parse', '--path-format=absolute', '--git-dir']), 'gru-command/bmad-runtime.json'), 'utf-8');
    rmSync(a.root, { recursive: true });
    expect(() => bindB(one)).toThrow(/never switches runtimes/u);
    expect(readFileSync(join(git(one, ['rev-parse', '--path-format=absolute', '--git-dir']), 'gru-command/bmad-runtime.json'), 'utf-8')).toBe(originalRecord);
  });

  it('reads retained #283 lane bindings without loading the new package or replacing identity/skills', () => {
    const context = fixture();
    const lane = join(dirname(context.projectRoot), 'historical');
    git(context.projectRoot, ['worktree', 'add', '-qb', 'historical', lane]);
    const store = temp();
    const original = bindBmadRuntime(lane, { storeRoot: store, bundled: () => loadBundledBmadRuntime(repoRoot) });
    const oldRecord = readFileSync(original.bindingFile!, 'utf-8');
    const preserved = createWorkflowRuntimeBinder(store, temp())(lane); // no current package exists at all
    expect(preserved).toMatchObject({ source: 'gru-command-bmad', runtimeId: original.id, root: original.dir, skills: ['bmad-build'] });
    expect(readFileSync(original.bindingFile!, 'utf-8')).toBe(oldRecord);
    expect(inspectMaterializedBmadRuntime(original.dir).contentSha256).toBe(original.contentSha256);
  });

  it('keeps the first binding during a publication race even when the losing writer has another package', () => {
    const context = fixture();
    const lane = join(dirname(context.projectRoot), 'race');
    git(context.projectRoot, ['worktree', 'add', '-qb', 'race', lane]);
    const store = temp();
    const a = loadBundledWorkflowRuntime(repoRoot);
    const rootB = packageCopy();
    writeWorkflowManifest(rootB, 2);
    const b = loadBundledWorkflowRuntime(rootB);
    const result = bindWorkflowRuntime(lane, { storeRoot: store, bundled: () => b,
      beforePublish: () => { bindWorkflowRuntime(lane, { storeRoot: store, bundled: () => a }); } });
    expect(result.id).toBe(a.id);
    expect(readdirSync(dirname(result.bindingFile!))).toEqual(['bmad-runtime.json']);
  });

  it('refuses corrupted retained bytes by name and restores a missing runtime only from identical shipped bytes', () => {
    const context = fixture();
    const lane = join(dirname(context.projectRoot), 'restore');
    git(context.projectRoot, ['worktree', 'add', '-qb', 'restore', lane]);
    const store = temp();
    const bind = createWorkflowRuntimeBinder(store, repoRoot);
    const a = bind(lane);
    rmSync(a.root, { recursive: true });
    expect(bind(lane)).toEqual(a);
    const target = join(a.root, 'skills/gc-build/review.md');
    chmodSync(target, 0o600);
    appendFileSync(target, 'corrupt');
    expect(() => bind(lane)).toThrow(/review\.md.*sha256/u);
    expect(readFileSync(target, 'utf-8')).toContain('corrupt');
  });

  it('rejects full CLI context before creating a runtime store or publishing a lane binding', () => {
    const context = fixture();
    const lane = join(dirname(context.projectRoot), 'invalid-context-lane');
    git(context.projectRoot, ['worktree', 'add', '-qb', 'invalid-context', lane]);
    const valid = { ...context, worktreeRoot: lane, knowledgeRoot: join(lane, 'gru-output') };
    const store = join(temp(), 'store-must-remain-absent');
    const bindingFile = join(git(lane, ['rev-parse', '--path-format=absolute', '--git-dir']), 'gru-command/bmad-runtime.json');
    const file = join(temp(), 'context.json');
    const external = temp();
    const publicArtifacts = join(temp(), 'public-artifacts');
    mkdirSync(publicArtifacts);
    chmodSync(publicArtifacts, 0o755);
    const linkedKnowledge = join(lane, 'linked-knowledge');
    symlinkSync(external, linkedKnowledge);
    for (const patch of [{ projectId: '' }, { jobId: '' }, { artifactRoot: join(lane, 'private') },
      { knowledgeRoot: external }, { knowledgeRoot: linkedKnowledge }, { artifactRoot: publicArtifacts }, { artifactRoot: join(store, 'wrong-place') }]) {
      writeFileSync(file, JSON.stringify({ ...valid, ...patch }));
      expect(() => runWorkflowRuntimeCli(['render', '--context', file, '--store', store, '--package-root', repoRoot], () => {})).toThrow(WorkflowResourceError);
      expect(existsSync(bindingFile), JSON.stringify(patch)).toBe(false);
      expect(existsSync(store), JSON.stringify(patch)).toBe(false);
      expect(existsSync(valid.artifactRoot)).toBe(false);
    }
    const packageB = packageCopy();
    writeWorkflowManifest(packageB, 2);
    writeFileSync(file, JSON.stringify(valid));
    const output: string[] = [];
    runWorkflowRuntimeCli(['render', '--context', file, '--store', store, '--package-root', packageB], (line) => output.push(line));
    expect(JSON.parse(output[0]!)).toMatchObject({ runtimeId: 'gru-command-workflows@2' });
    expect(JSON.parse(readFileSync(bindingFile, 'utf-8'))).toMatchObject({ runtime_id: 'gru-command-workflows@2' });
  });

  it('the explicit render CLI records the bound workflow and rejects incomplete/unknown arguments', () => {
    const context = fixture();
    const file = join(temp(), 'context.json');
    writeFileSync(file, JSON.stringify(context));
    const lines: string[] = [];
    runWorkflowRuntimeCli(['render', '--context', file, '--store', temp(), '--package-root', repoRoot, '--route', 'small-change'], (line) => lines.push(line));
    expect(JSON.parse(lines[0]!)).toMatchObject({ runtimeId: 'gru-command-workflows@1' });
    for (const args of [[], ['verify', '--bogus'], ['manifest', repoRoot, '--version', '0'], ['render', '--context', file], ['render', '--unknown', 'x']]) {
      expect(() => runWorkflowRuntimeCli(args, () => {})).toThrow(/usage:/u);
    }
  });
});
