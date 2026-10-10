import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createArtifactContext, ArtifactContextError, type ArtifactSource } from '../src/artifacts/context.js';
import type { WorktreeLane } from '../src/dispatch/worktree-port.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const hash = (content: string): string => createHash('sha256').update(content).digest('hex');
const workflow = { id: 'gru-build@1', sha256: hash('workflow bytes') };
const sources: readonly ArtifactSource[] = [{
  kind: 'github-issue', locator: 'https://example.invalid/project/issues/1',
  revision: 'snapshot-1', sha256: hash('source bytes'),
}];

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gru-artifacts-')));
  roots.push(root);
  const repoPath = join(root, 'registered', 'app');
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, ['init', '-qb', 'main']);
  writeFileSync(join(repoPath, 'README.md'), 'fixture\n');
  git(repoPath, ['add', '.']);
  git(repoPath, ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const lane = (id = 'j-1'): WorktreeLane => {
    const path = join(root, 'lanes', id);
    git(repoPath, ['worktree', 'add', '--quiet', '-b', id, path]);
    return {
      id, kind: 'job', repoPath, repoName: 'app', path, branch: id,
      sha: git(path, ['rev-parse', 'HEAD']), jobId: id, roundId: null, status: 'active',
    };
  };
  const dataDir = join(root, 'custom-data-home');
  const worktree = lane();
  const input = { dataDir, worktree, workflow };
  return { root, repoPath, lane, dataDir, worktree, input };
}

function tree(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true }).map(String).sort();
}

function snapshot(root: string): string {
  return tree(root).map((name) => {
    const path = join(root, name);
    const info = lstatSync(path);
    return `${name}:${info.mode}:${info.isFile() ? readFileSync(path).toString('hex') : ''}`;
  }).join('\n');
}

describe('explicit GC artifact context (#293)', () => {
  it('uses configured data home and registered identity, not a checkout basename', () => {
    const f = fixture();
    const context = createArtifactContext(f.input);
    expect(context.projectKey).toBe(hash(realpathSync(f.repoPath)));
    expect(context.jobDirectory).toBe(join(f.dataDir, 'projects', context.projectKey, 'jobs', 'j-1'));
    expect(context.operationalDirectory).toBe(join(context.jobDirectory, 'operational'));
    expect(context.knowledgeDirectory).toBe(join(f.worktree.path, 'gru-output'));
    expect(existsSync(join(f.repoPath, 'gru-output'))).toBe(false);
    expect(tree(f.dataDir)).not.toContain('bmad-runtime');
    expect(tree(f.worktree.path).some((p) => p.startsWith('_bmad'))).toBe(false);
  });

  it('isolates same-basename projects and simultaneous jobs; resumes the same records', () => {
    const a = fixture();
    const b = fixture();
    const first = createArtifactContext(a.input);
    const second = createArtifactContext({ ...b.input, dataDir: a.dataDir });
    const third = createArtifactContext({ ...a.input, worktree: a.lane('j-2') });
    expect(new Set([first.jobDirectory, second.jobDirectory, third.jobDirectory]).size).toBe(3);
    for (const [context, contents] of [[first, 'a'], [second, 'b'], [third, 'c']] as const) {
      context.writeOperational({ path: 'plans/proposal.md', contents, sources });
    }
    expect(readFileSync(join(first.operationalDirectory, 'plans/proposal.md'), 'utf8')).toBe('a');
    expect(readFileSync(join(second.operationalDirectory, 'plans/proposal.md'), 'utf8')).toBe('b');
    expect(readFileSync(join(third.operationalDirectory, 'plans/proposal.md'), 'utf8')).toBe('c');
    const resumed = createArtifactContext(a.input);
    expect(resumed.readReference('operational', 'plans/proposal.md')).toEqual(first.readReference('operational', 'plans/proposal.md'));
    expect(resumed.jobDirectory).toBe(first.jobDirectory);
  });

  it('publishes separate job namespaces concurrently in independent processes', async () => {
    const f = fixture();
    const secondLane = f.lane('j-2');
    const modulePath = join(f.root, 'artifact-context.mjs');
    writeFileSync(modulePath, transpileModule(readFileSync(join(import.meta.dirname, '../src/artifacts/context.ts'), 'utf8'), {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
    }).outputText);
    const script = `
      import { createArtifactContext } from ${JSON.stringify(pathToFileURL(modulePath).href)};
      process.stdout.write('ready\\n');
      let input = '';
      for await (const chunk of process.stdin) input += chunk;
      const { contextInput, sources, contents } = JSON.parse(input);
      const context = createArtifactContext(contextInput);
      context.writeOperational({ path: 'proposal.md', contents, sources });
    `;
    const children = [f.worktree, secondLane].map((worktree) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve());
        child.once('error', reject);
        child.once('exit', (code) => { if (code !== 0) reject(new Error(stderr)); });
      });
      const done = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
      });
      return { child, ready, done, worktree };
    });
    try {
      await Promise.all(children.map(({ ready }) => ready));
      for (const { child, worktree } of children) {
        child.stdin.end(JSON.stringify({ contextInput: { ...f.input, worktree }, sources, contents: worktree.id }));
      }
      await Promise.all(children.map(({ done }) => done));
    } finally {
      for (const { child } of children) child.kill();
      await Promise.allSettled(children.map(({ done }) => done));
    }
    for (const { worktree } of children) {
      const context = createArtifactContext({ ...f.input, worktree });
      expect(context.readReference('operational', 'proposal.md').sha256).toBe(hash(worktree.id));
    }
  });

  it('ignores inherited Git repository routing and global configuration', () => {
    const f = fixture();
    const other = fixture();
    vi.stubEnv('GIT_DIR', join(other.repoPath, '.git'));
    vi.stubEnv('GIT_WORK_TREE', other.repoPath);
    vi.stubEnv('GIT_COMMON_DIR', join(other.repoPath, '.git'));
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.worktree');
    vi.stubEnv('GIT_CONFIG_VALUE_0', other.repoPath);
    const context = createArtifactContext(f.input);
    expect(context.knowledgeDirectory).toBe(join(f.worktree.path, 'gru-output'));
    context.publishDocument({ path: 'spec.md', contents: 'approved', sources, approvalId: 'owner' });
    expect(existsSync(join(other.repoPath, 'gru-output'))).toBe(false);
  });

  it('makes operational material private, records exact provenance and never exports it implicitly', () => {
    const f = fixture();
    const context = createArtifactContext(f.input);
    const reference = context.writeOperational({ path: 'imports/source.txt', contents: 'private raw source', sources });
    expect(reference).toEqual({
      schemaVersion: 1, projectKey: context.projectKey, jobId: 'j-1',
      scope: 'operational', path: 'imports/source.txt', sha256: hash('private raw source'),
      workflow, sources, approvalId: null,
    });
    for (const name of ['', ...tree(context.jobDirectory)]) {
      const info = lstatSync(join(context.jobDirectory, name));
      expect(info.mode & 0o777).toBe(info.isDirectory() ? 0o700 : 0o600);
    }
    expect(tree(context.knowledgeDirectory)).toEqual([]);
    expect(context.readReference('operational', 'imports/source.txt')).toEqual(reference);
  });

  it('publishes only explicitly approved bytes as ordinary documents; initialization preserves existing knowledge', () => {
    const f = fixture();
    const knowledge = join(f.worktree.path, 'gru-output');
    mkdirSync(knowledge);
    writeFileSync(join(knowledge, 'existing.md'), 'keep my document', { mode: 0o640 });
    const before = snapshot(knowledge);
    const context = createArtifactContext(f.input);
    createArtifactContext(f.input);
    expect(snapshot(knowledge)).toBe(before);
    const reference = context.publishDocument({
      path: 'specs/approved.md', contents: '# Approved\n', sources, approvalId: 'owner-action-42',
    });
    expect(reference.scope).toBe('document');
    expect(reference.approvalId).toBe('owner-action-42');
    expect(readFileSync(join(knowledge, reference.path), 'utf8')).toBe('# Approved\n');
    expect(lstatSync(join(knowledge, reference.path)).mode & 0o777).toBe(0o644);
    expect(snapshot(context.operationalDirectory)).toBe('');
    expect(snapshot(context.jobDirectory)).not.toContain(Buffer.from('# Approved\n').toString('hex'));
    expect(git(f.worktree.path, ['status', '--porcelain'])).toContain('gru-output/');
    expect(git(f.repoPath, ['status', '--porcelain'])).toBe('');
  });

  it('refuses replacing an existing foreign document or a knowledge root swapped after initialization', () => {
    const f = fixture();
    const context = createArtifactContext(f.input);
    const existing = join(context.knowledgeDirectory, 'existing.md');
    writeFileSync(existing, 'foreign approved document');
    expect(() => context.publishDocument({ path: 'existing.md', contents: 'replacement', sources, approvalId: 'owner' })).toThrow(/different/u);
    expect(readFileSync(existing, 'utf8')).toBe('foreign approved document');
    const outside = join(f.root, 'outside');
    mkdirSync(outside);
    rmSync(context.knowledgeDirectory, { recursive: true });
    symlinkSync(outside, context.knowledgeDirectory);
    expect(() => context.publishDocument({ path: 'new.md', contents: 'x', sources, approvalId: 'owner' })).toThrow(ArtifactContextError);
    expect(tree(outside)).toEqual([]);
  });

  it('is idempotent for identical publication, refuses replacement bytes or competing provenance', () => {
    const f = fixture();
    const context = createArtifactContext(f.input);
    const artifact = { path: 'draft.md', contents: 'v1', sources };
    const first = context.writeOperational(artifact);
    expect(context.writeOperational(artifact)).toEqual(first);
    expect(() => context.writeOperational({ ...artifact, contents: 'v2' })).toThrow(ArtifactContextError);
    expect(() => context.writeOperational({ ...artifact, sources: [{ ...sources[0]!, revision: 'v2' }] })).toThrow(/different/u);
    expect(readFileSync(join(context.operationalDirectory, artifact.path), 'utf8')).toBe('v1');
    const document = { ...artifact, path: 'spec.md', approvalId: 'owner-1' };
    context.publishDocument(document);
    expect(() => context.publishDocument({ ...document, contents: 'v2' })).toThrow(/different/u);
    expect(readFileSync(join(context.knowledgeDirectory, 'spec.md'), 'utf8')).toBe('v1');
  });

  it('retains the bound workflow and worktree, refusing identity drift or corrupt binding on resume', () => {
    const f = fixture();
    const context = createArtifactContext(f.input);
    const before = snapshot(context.jobDirectory);
    expect(() => createArtifactContext({ ...f.input, workflow: { ...workflow, sha256: hash('upgrade') } })).toThrow(/different/u);
    expect(snapshot(context.jobDirectory)).toBe(before);
    const binding = join(context.jobDirectory, 'context.json');
    writeFileSync(binding, '{broken');
    expect(() => createArtifactContext(f.input)).toThrow(/context|different/u);
    expect(() => context.writeOperational({ path: 'new.txt', contents: 'x', sources })).toThrow(ArtifactContextError);
    expect(existsSync(join(context.operationalDirectory, 'new.txt'))).toBe(false);
  });

  it('refuses unsafe relative paths before writing', () => {
    const f = fixture();
    const context = createArtifactContext(f.input);
    const before = snapshot(context.jobDirectory);
    for (const path of ['../escape', '/absolute', 'a/../escape', './a', 'a//b', 'a\\b', '', 'a\0b', 'C:/escape']) {
      expect(() => context.writeOperational({ path, contents: 'x', sources })).toThrow(ArtifactContextError);
      expect(() => context.publishDocument({ path, contents: 'x', sources, approvalId: 'owner' })).toThrow(ArtifactContextError);
      expect(snapshot(context.jobDirectory)).toBe(before);
      expect(tree(context.knowledgeDirectory)).toEqual([]);
    }
  });

  it('refuses unsafe job identities', () => {
    const f = fixture();
    for (const id of ['../j-1', 'j/1', 'J-1', '', '.', '..']) {
      expect(() => createArtifactContext({ ...f.input, worktree: { ...f.worktree, id, jobId: id } })).toThrow(ArtifactContextError);
      expect(existsSync(f.dataDir)).toBe(false);
    }
  });

  it('refuses missing data home, invalid workflow/source identity and absent approval', () => {
    const f = fixture();
    for (const dataDir of ['', 'relative', '~/data']) {
      expect(() => createArtifactContext({ ...f.input, dataDir })).toThrow(ArtifactContextError);
    }
    expect(() => createArtifactContext({ ...f.input, workflow: { id: '', sha256: 'no' } })).toThrow(ArtifactContextError);
    const context = createArtifactContext(f.input);
    for (const approvalId of ['', ' ']) {
      expect(() => context.publishDocument({ path: 'spec.md', contents: 'x', sources, approvalId })).toThrow(/approval/u);
    }
    expect(() => context.writeOperational({
      path: 'source.txt', contents: 'x', sources: [{ ...sources[0]!, sha256: 'not-a-hash' }],
    })).toThrow(/sha256/u);
    expect(tree(context.knowledgeDirectory)).toEqual([]);
    expect(tree(context.operationalDirectory)).toEqual([]);
  });

  it('refuses main checkout, foreign repositories, non-root, review, unowned and swept lanes', () => {
    const f = fixture();
    const other = fixture();
    mkdirSync(join(f.worktree.path, 'subdir'));
    const cases: WorktreeLane[] = [
      { ...f.worktree, path: f.repoPath },
      { ...f.worktree, path: other.worktree.path },
      { ...f.worktree, path: join(f.worktree.path, 'subdir') },
      { ...f.worktree, kind: 'review' },
      { ...f.worktree, jobId: 'foreign-job' },
      { ...f.worktree, status: 'swept' },
    ];
    for (const worktree of cases) expect(() => createArtifactContext({ ...f.input, worktree })).toThrow(ArtifactContextError);
    expect(existsSync(f.dataDir)).toBe(false);
    expect(existsSync(join(f.repoPath, 'gru-output'))).toBe(false);
  });

  it('refuses wrong-kind knowledge roots without touching foreign targets', () => {
    for (const kind of ['file', 'link', 'dangling-link']) {
      const f = fixture();
      const outside = join(f.root, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'keep.txt'), 'keep');
      const target = join(f.worktree.path, 'gru-output');
      if (kind === 'file') writeFileSync(target, 'keep');
      else symlinkSync(kind === 'link' ? outside : join(outside, 'missing'), target);
      const before = snapshot(outside);
      expect(() => createArtifactContext(f.input)).toThrow(ArtifactContextError);
      expect(snapshot(outside)).toBe(before);
      if (kind === 'file') expect(readFileSync(target, 'utf8')).toBe('keep');
    }
  });

  it('refuses symlinks at data-home ancestors and at namespace components', () => {
    const f = fixture();
    const outside = join(f.root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    symlinkSync(outside, f.dataDir);
    expect(() => createArtifactContext(f.input)).toThrow(/directory|symlink/u);
    expect(() => createArtifactContext({ ...f.input, dataDir: join(f.dataDir, 'nested') })).toThrow(ArtifactContextError);
    expect(tree(outside)).toEqual(['keep.txt']);
    rmSync(f.dataDir);
    mkdirSync(f.dataDir);
    symlinkSync(outside, join(f.dataDir, 'projects'));
    expect(() => createArtifactContext(f.input)).toThrow(ArtifactContextError);
    expect(tree(outside)).toEqual(['keep.txt']);
  });

  it('rechecks paths on every operation and refuses nested links, hardlinks and wrong-kind destinations', () => {
    const f = fixture();
    const context = createArtifactContext(f.input);
    const outside = join(f.root, 'outside');
    mkdirSync(outside);
    const foreign = join(outside, 'keep.txt');
    writeFileSync(foreign, 'keep');
    for (const root of [context.operationalDirectory, context.knowledgeDirectory]) {
      symlinkSync(outside, join(root, 'escape'));
      symlinkSync(foreign, join(root, 'link.txt'));
      symlinkSync(join(outside, 'missing'), join(root, 'dangling.txt'));
      linkSync(foreign, join(root, 'hardlink.txt'));
      mkdirSync(join(root, 'directory.txt'));
    }
    const before = snapshot(outside);
    for (const path of ['escape/new.txt', 'link.txt', 'dangling.txt', 'hardlink.txt', 'directory.txt']) {
      expect(() => context.writeOperational({ path, contents: 'keep', sources })).toThrow(ArtifactContextError);
      expect(() => context.publishDocument({ path, contents: 'keep', sources, approvalId: 'owner' })).toThrow(ArtifactContextError);
    }
    expect(snapshot(outside)).toBe(before);
    rmSync(context.operationalDirectory, { recursive: true });
    symlinkSync(outside, context.operationalDirectory);
    expect(() => context.writeOperational({ path: 'new.txt', contents: 'x', sources })).toThrow(ArtifactContextError);
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
  });

  it('refuses permissive private namespaces and metadata links without changing foreign permissions', () => {
    const f = fixture();
    const context = createArtifactContext(f.input);
    chmodSync(context.operationalDirectory, 0o755);
    expect(() => createArtifactContext(f.input)).toThrow(/private/u);
    expect(lstatSync(context.operationalDirectory).mode & 0o777).toBe(0o755);
    chmodSync(context.operationalDirectory, 0o700);
    const foreign = join(f.root, 'foreign.json');
    writeFileSync(foreign, 'keep');
    const binding = join(context.jobDirectory, 'context.json');
    rmSync(binding);
    symlinkSync(foreign, binding);
    expect(() => createArtifactContext(f.input)).toThrow(ArtifactContextError);
    expect(readFileSync(foreign, 'utf8')).toBe('keep');
  });

  it('verifies reference bytes on resume and can finish an interrupted publication without rewriting payload', () => {
    const f = fixture();
    const context = createArtifactContext(f.input);
    const artifact = { path: 'draft.md', contents: 'v1', sources };
    const reference = context.writeOperational(artifact);
    const references = join(context.jobDirectory, 'references');
    const receipt = join(references, readdirSync(references)[0]!);
    rmSync(receipt);
    expect(() => context.readReference('operational', 'draft.md')).toThrow(ArtifactContextError);
    expect(context.writeOperational(artifact)).toEqual(reference);
    writeFileSync(join(context.operationalDirectory, 'draft.md'), 'tampered');
    expect(() => createArtifactContext(f.input).readReference('operational', 'draft.md')).toThrow(/sha256|content/u);
    expect(() => context.writeOperational(artifact)).toThrow(ArtifactContextError);
  });

  it('refuses corrupt reference identities and unsafe metadata destinations without publishing a payload', () => {
    const f = fixture();
    const context = createArtifactContext(f.input);
    const artifact = { path: 'draft.md', contents: 'v1', sources };
    context.writeOperational(artifact);
    const references = join(context.jobDirectory, 'references');
    const receipt = join(references, readdirSync(references)[0]!);
    const original = readFileSync(receipt, 'utf8');
    for (const field of [{ jobId: 'foreign' }, { workflow: { ...workflow, id: 'new' } }, { path: '../escape' }, { schemaVersion: 2 }]) {
      writeFileSync(receipt, JSON.stringify({ ...JSON.parse(original), ...field }));
      expect(() => context.readReference('operational', 'draft.md')).toThrow(ArtifactContextError);
    }
    writeFileSync(receipt, original);
    rmSync(join(context.operationalDirectory, artifact.path));
    rmSync(receipt);
    const foreign = join(f.root, 'foreign.json');
    writeFileSync(foreign, 'keep');
    symlinkSync(foreign, receipt);
    expect(() => context.writeOperational(artifact)).toThrow(ArtifactContextError);
    expect(existsSync(join(context.operationalDirectory, artifact.path))).toBe(false);
    expect(readFileSync(foreign, 'utf8')).toBe('keep');
  });

  it('does not touch legacy BMAD state, captures or workflow package material', () => {
    const f = fixture();
    for (const path of ['_bmad-output/old.md', '_bmad/custom/config.toml', '.agents/skills/unrelated/SKILL.md']) {
      const target = join(f.worktree.path, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'legacy');
    }
    for (const path of ['captures/old.txt', 'bmad-runtime/package/workflow.md']) {
      const target = join(f.dataDir, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, 'private historical data');
    }
    const protectedPaths = ['_bmad', '_bmad-output', '.agents'].map((p) => join(f.worktree.path, p))
      .concat([join(f.dataDir, 'captures'), join(f.dataDir, 'bmad-runtime')]);
    const before = protectedPaths.map(snapshot);
    const context = createArtifactContext(f.input);
    context.writeOperational({ path: 'render/workflow.md', contents: 'new', sources });
    context.publishDocument({ path: 'spec.md', contents: 'approved', sources, approvalId: 'owner' });
    expect(protectedPaths.map(snapshot)).toEqual(before);
    expect(relative(f.dataDir, context.operationalDirectory)).toMatch(/^projects\//u);
  });
});
