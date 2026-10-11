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
import { createArtifactContext, createPreviewArtifactContext, ArtifactContextError, type ArtifactSource } from '../src/artifacts/context.js';
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

  it('verifies reference bytes and resumes receipt-before-payload publication without changing provenance', () => {
    const f = fixture();
    const context = createArtifactContext(f.input);
    const artifact = { path: 'draft.md', contents: 'v1', sources };
    const reference = context.writeOperational(artifact);
    const references = join(context.jobDirectory, 'references');
    const receipt = join(references, readdirSync(references)[0]!);
    const receiptBytes = readFileSync(receipt);
    const payload = join(context.operationalDirectory, artifact.path);
    rmSync(payload);
    expect(() => context.readReference('operational', artifact.path)).toThrow(ArtifactContextError);
    expect(() => context.writeOperational({ ...artifact, sources: [{ ...sources[0]!, revision: 'different' }] })).toThrow(/different/u);
    expect(existsSync(payload)).toBe(false);
    expect(context.writeOperational(artifact)).toEqual(reference);
    expect(readFileSync(receipt)).toEqual(receiptBytes);
    rmSync(receipt);
    expect(() => context.writeOperational(artifact)).toThrow(/receipt is missing/u);
    expect(() => context.writeOperational({ ...artifact, sources: [] })).toThrow(/receipt is missing/u);
    writeFileSync(receipt, receiptBytes, { mode: 0o600 });
    writeFileSync(payload, 'tampered');
    expect(() => createArtifactContext(f.input).readReference('operational', artifact.path)).toThrow(/sha256|content/u);
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

  it('fails closed on missing job bindings instead of reassigning prior workflow identity', () => {
    const f = fixture();
    const context = createArtifactContext(f.input);
    context.writeOperational({ path: 'prior.md', contents: 'prior contract', sources });
    rmSync(join(context.jobDirectory, 'context.json'));
    const before = snapshot(context.jobDirectory);
    for (const selected of [workflow, { ...workflow, sha256: hash('new workflow') }]) {
      expect(() => createArtifactContext({ ...f.input, workflow: selected })).toThrow(/binding is missing/u);
      expect(snapshot(context.jobDirectory)).toBe(before);
    }
  });

  it('refuses private data homes inside any other checkout and aliased worktree roots', () => {
    const f = fixture();
    const foreign = fixture();
    expect(() => createArtifactContext({ ...f.input, dataDir: join(foreign.repoPath, 'private-data') })).toThrow(/outside all Git/u);
    expect(existsSync(join(foreign.repoPath, 'private-data'))).toBe(false);
    const aliasRoot = join(dirname(f.worktree.path), f.worktree.id.toUpperCase());
    if (existsSync(aliasRoot)) {
      expect(() => createArtifactContext({ ...f.input, dataDir: join(aliasRoot, 'private-data') })).toThrow(/aliased|outside all Git/u);
      expect(existsSync(join(f.worktree.path, 'private-data'))).toBe(false);
    }
  });

  it('rejects filesystem-equivalent document spellings instead of creating competing approvals', () => {
    const f = fixture();
    const context = createArtifactContext(f.input);
    const document = { path: 'Specs/Report.md', contents: 'approved', sources, approvalId: 'owner-a' };
    const reference = context.publishDocument(document);
    expect(context.readReference('document', document.path)).toEqual(reference);
    if (existsSync(join(context.knowledgeDirectory, 'Specs/report.md'))) {
      expect(() => context.publishDocument({ ...document, path: 'Specs/report.md', approvalId: 'owner-b' })).toThrow(/aliased/u);
      expect(() => context.publishDocument({ ...document, path: 'specs/Report.md', approvalId: 'owner-b' })).toThrow(/aliased/u);
      expect(readdirSync(join(context.jobDirectory, 'references'))).toHaveLength(1);
    } else {
      const other = context.publishDocument({ ...document, path: 'Specs/report.md', approvalId: 'owner-b' });
      expect(context.readReference('document', other.path)).toEqual(other);
    }
  });

  it('verifies approved document hashes, approval receipts and explicit revisions after ordinary edits', () => {
    const f = fixture();
    const context = createArtifactContext(f.input);
    const document = { path: 'spec.md', contents: 'approved v1', sources, approvalId: 'owner-1' };
    const reference = context.publishDocument(document);
    expect(context.readReference('document', reference.path)).toEqual(reference);
    writeFileSync(join(context.knowledgeDirectory, document.path), 'unapproved edit');
    expect(() => context.readReference('document', reference.path)).toThrow(/sha256/u);
    expect(() => context.publishDocument({ ...document, contents: 'unapproved edit', approvalId: 'owner-2' })).toThrow(/different/u);
    const updated = context.publishDocument({ ...document, path: 'spec-v2.md', contents: 'approved v2', approvalId: 'owner-2' });
    expect(context.readReference('document', updated.path)).toEqual(updated);
  });

  it('refuses Git-ignored approved documents without changing ignore rules or publishing references', () => {
    const f = fixture();
    writeFileSync(join(f.worktree.path, '.gitignore'), 'gru-output/\n');
    const context = createArtifactContext(f.input);
    expect(() => context.publishDocument({ path: 'spec.md', contents: 'approved', sources, approvalId: 'owner' })).toThrow(/Git-ignored/u);
    expect(tree(context.knowledgeDirectory)).toEqual([]);
    expect(tree(join(context.jobDirectory, 'references'))).toEqual([]);
    expect(readFileSync(join(f.worktree.path, '.gitignore'), 'utf8')).toBe('gru-output/\n');
  });

  it('honors global and environment-carried Git excludes while pinning visibility to the assigned checkout', () => {
    const f = fixture();
    const excludes = join(f.root, 'global-excludes');
    const config = join(f.root, 'gitconfig');
    writeFileSync(excludes, 'gru-output/\n');
    writeFileSync(config, `[core]\n  excludesFile = ${excludes}\n`);
    vi.stubEnv('GIT_CONFIG_GLOBAL', config);
    const context = createArtifactContext(f.input);
    const document = { path: 'spec.md', contents: 'approved', sources, approvalId: 'owner' };
    expect(() => context.publishDocument(document)).toThrow(/Git-ignored/u);
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(f.root, 'absent-global-config'));
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.excludesFile');
    vi.stubEnv('GIT_CONFIG_VALUE_0', excludes);
    expect(() => context.publishDocument(document)).toThrow(/Git-ignored/u);
    expect(tree(context.knowledgeDirectory)).toEqual([]);
    expect(tree(join(context.jobDirectory, 'references'))).toEqual([]);
  });

  it('refuses private writes when the configured data home becomes a Git checkout after binding', () => {
    const f = fixture();
    const context = createArtifactContext(f.input);
    git(f.dataDir, ['init', '-qb', 'main']);
    const before = snapshot(context.jobDirectory);
    expect(() => context.writeOperational({ path: 'secret.txt', contents: 'secret', sources })).toThrow(/outside all Git/u);
    expect(() => context.publishDocument({ path: 'spec.md', contents: 'approved', sources, approvalId: 'owner' })).toThrow(/outside all Git/u);
    expect(snapshot(context.jobDirectory)).toBe(before);
    expect(tree(context.knowledgeDirectory)).toEqual([]);
  });

  it('never treats a UUID-shaped foreign hardlink as an authenticated GC publication', () => {
    const f = fixture();
    const context = createArtifactContext(f.input);
    const document = { path: 'spec.md', contents: 'approved', sources, approvalId: 'owner' };
    const reference = context.publishDocument(document);
    const payload = join(context.knowledgeDirectory, document.path);
    const foreign = join(context.knowledgeDirectory, '.gc-artifact-123e4567-e89b-42d3-a456-426614174000.tmp');
    linkSync(payload, foreign);
    expect(() => context.readReference('document', document.path)).toThrow(/foreign hardlink/u);
    expect(() => context.publishDocument(document)).toThrow(/foreign hardlink/u);
    expect(readFileSync(foreign, 'utf8')).toBe(document.contents);
    expect(lstatSync(payload).nlink).toBe(2);
    expect(tree(join(context.jobDirectory, 'publication-staging'))).toEqual([]);
    rmSync(foreign); // only the test removes the foreign fixture it created
    expect(context.readReference('document', document.path)).toEqual(reference);
  });

  it('an existing context refuses a legally swept and removed lane, even with its original registry snapshot', () => {
    const f = fixture();
    const context = createArtifactContext(f.input);
    git(f.repoPath, ['worktree', 'remove', '--force', f.worktree.path]);
    expect(() => context.writeOperational({ path: 'after-sweep.md', contents: 'x', sources })).toThrow(ArtifactContextError);
    expect(() => context.publishDocument({ path: 'after-sweep.md', contents: 'x', sources, approvalId: 'owner' })).toThrow(ArtifactContextError);
    expect(existsSync(join(context.operationalDirectory, 'after-sweep.md'))).toBe(false);
    expect(existsSync(f.worktree.path)).toBe(false);
  });

  it('handles identical same-path concurrency and crash recovery at the actual publication hardlink window', async () => {
    const f = fixture();
    const context = createArtifactContext(f.input);
    const modulePath = join(f.root, 'paused-artifacts.mjs');
    const original = readFileSync(join(import.meta.dirname, '../src/artifacts/context.ts'), 'utf8');
    const pauseAt = '    unlinkStaging(temporary);';
    expect(original.split(pauseAt)).toHaveLength(2);
    const instrumented = `import { readSync } from 'node:fs';\n` + original.replace(pauseAt, `
    if (path.endsWith('/draft.md')) {
      process.stdout.write('linked\\n');
      readSync(0, Buffer.alloc(1), 0, 1, null);
    }
    unlinkStaging(temporary);`);
    writeFileSync(modulePath, transpileModule(instrumented, {
      compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
    }).outputText);
    const script = `
      import { createArtifactContext } from ${JSON.stringify(pathToFileURL(modulePath).href)};
      const { input, artifact } = JSON.parse(process.argv[1]);
      createArtifactContext(input).writeOperational(artifact);
    `;
    for (const mode of ['concurrent', 'crash']) {
      const artifact = { path: `${mode}/draft.md`, contents: 'v1', sources };
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify({ input: f.input, artifact })], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve());
        child.once('error', reject);
        child.once('close', () => reject(new Error(stderr || 'publisher stopped before the hardlink gate')));
      });
      const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
      try {
        await ready;
        if (mode === 'crash') {
          child.kill('SIGKILL');
          expect((await done).signal).toBe('SIGKILL');
          const stagingRoot = join(context.jobDirectory, 'publication-staging');
          const proof = join(stagingRoot, readdirSync(stagingRoot)[0]!);
          const proofBytes = readFileSync(proof, 'utf8');
          for (const corruption of [{ target: 'foreign' }, { sha256: hash('corrupt staging') }]) {
            writeFileSync(proof, JSON.stringify({ ...JSON.parse(proofBytes), ...corruption }, null, 2) + '\n');
            expect(() => context.writeOperational(artifact)).toThrow(/staging record/u);
            expect(tree(join(context.operationalDirectory, mode))).toHaveLength(2);
          }
          writeFileSync(proof, proofBytes);
        }
        const resumed = context.writeOperational(artifact);
        expect(context.readReference('operational', artifact.path)).toEqual(resumed);
        expect(tree(join(context.operationalDirectory, mode))).toEqual(['draft.md']);
        expect(tree(join(context.jobDirectory, 'publication-staging'))).toEqual([]);
        if (mode === 'concurrent') {
          child.stdin.end('x');
          expect((await done).code, stderr).toBe(0);
        }
      } finally {
        child.kill();
        await done;
      }
    }
  });

  it('accepts identical concurrent publication when the winner cleans staging after another reader obtains its proof', async () => {
    const f = fixture();
    const context = createArtifactContext(f.input);
    const original = readFileSync(join(import.meta.dirname, '../src/artifacts/context.ts'), 'utf8');
    const cleanupMarker = '    unlinkStaging(temporary);';
    const proofMarker = "    const raw = JSON.parse(bytes.toString('utf8')) as { readonly sha256: string };";
    expect(original.split(cleanupMarker)).toHaveLength(2);
    expect(original.split(proofMarker)).toHaveLength(2);
    const gate = `if (path.endsWith('/race/draft.md')) {
      process.stdout.write('gate\\n'); readSync(0, Buffer.alloc(1), 0, 1, null);
    }\n`;
    const modules = [cleanupMarker, proofMarker].map((marker, index) => {
      const file = join(f.root, `gated-${index}.mjs`);
      const source = "import { readSync } from 'node:fs';\n" + original.replace(marker, gate + marker);
      writeFileSync(file, transpileModule(source, {
        compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
      }).outputText);
      return file;
    });
    const artifact = { path: 'race/draft.md', contents: 'identical', sources };
    const script = `
      const { modulePath, input, artifact } = JSON.parse(process.argv[1]);
      const { createArtifactContext } = await import(modulePath);
      createArtifactContext(input).writeOperational(artifact);
    `;
    const children: Array<ReturnType<typeof launch>> = [];
    function launch(modulePath: string) {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script,
        JSON.stringify({ modulePath: pathToFileURL(modulePath).href, input: f.input, artifact })], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      const ready = new Promise<void>((resolve, reject) => {
        child.stdout.once('data', () => resolve());
        child.once('error', reject);
        child.once('close', () => reject(new Error(stderr || 'publisher closed before gate')));
      });
      const done = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => resolve(code));
      });
      return { child, ready, done, stderr: () => stderr };
    }
    try {
      const winner = launch(modules[0]!);
      children.push(winner);
      await winner.ready;
      const reader = launch(modules[1]!);
      children.push(reader);
      await reader.ready;
      winner.child.stdin.end('x');
      expect(await winner.done, winner.stderr()).toBe(0);
      reader.child.stdin.end('x');
      expect(await reader.done, reader.stderr()).toBe(0);
      expect(context.readReference('operational', artifact.path).sha256).toBe(hash(artifact.contents));
      expect(tree(join(context.jobDirectory, 'publication-staging'))).toEqual([]);
    } finally {
      for (const { child } of children) child.kill();
      await Promise.allSettled(children.map(({ done }) => done));
    }
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

describe('operational-only intake artifact binding (#296)', () => {
  it('needs only a registered repo and logical intake id, never creates a job/lane/document, and retains revision workflow identities', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gru-preview-artifact-')));
    roots.push(root);
    const repoPath = join(root, 'repo');
    mkdirSync(repoPath);
    git(repoPath, ['init', '-q']);
    const dataDir = join(root, 'private-home');
    const input = { dataDir, repoPath, intakeId: 'intake-296', workflow };
    const context = createPreviewArtifactContext(input);
    const reference = context.writeOperational({ path: 'revisions/r1.json', contents: '{"executable":false}', sources });
    expect(reference).toMatchObject({ intakeId: 'intake-296', scope: 'operational', approvalId: null, workflow });
    expect(reference).not.toHaveProperty('jobId');
    expect(context).not.toHaveProperty('publishDocument');
    expect(context).not.toHaveProperty('knowledgeDirectory');
    expect(context.readOperational('revisions/r1.json')).toBe('{"executable":false}');
    expect(existsSync(join(dataDir, 'projects', context.projectKey, 'jobs'))).toBe(false);
    expect(existsSync(join(repoPath, 'gru-output'))).toBe(false);
    expect(git(repoPath, ['worktree', 'list', '--porcelain']).match(/^worktree /gmu)).toHaveLength(1);
    expect(git(repoPath, ['status', '--porcelain', '--untracked-files=all'])).toBe('');
    const refreshedWorkflow = { id: 'gru-build@2', sha256: hash('new owned workflow') };
    const refreshed = createPreviewArtifactContext({ ...input, workflow: refreshedWorkflow });
    expect(refreshed.readOperational('revisions/r1.json')).toBe('{"executable":false}');
    expect(refreshed.writeOperational({ path: 'revisions/r2.json', contents: 'new revision', sources }).workflow).toEqual(refreshedWorkflow);
    expect(() => refreshed.writeOperational({ path: 'revisions/r1.json', contents: '{"executable":false}', sources })).toThrow('different');
    linkSync(join(context.operationalDirectory, 'revisions/r1.json'), join(root, 'foreign-hardlink'));
    expect(() => context.readOperational('revisions/r1.json')).toThrow('foreign hardlinks');
  });
});

describe('existing-only intake artifact opening', () => {
  it('opens no absent/empty namespace and never mutates a healthy existing context on open', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gru-preview-existing-')));
    roots.push(root);
    const repoPath = join(root, 'repo');
    mkdirSync(repoPath);
    git(repoPath, ['init', '-q']);
    const dataDir = join(root, 'private-home');
    const input = { dataDir, repoPath, intakeId: 'intake-296', workflow };
    expect(createPreviewArtifactContext(input, 'existing')).toBe(null);
    expect(existsSync(dataDir)).toBe(false);
    const namespace = join(dataDir, 'projects', hash(repoPath), 'intakes', input.intakeId);
    mkdirSync(namespace, { recursive: true, mode: 0o700 });
    const empty = snapshot(dataDir);
    expect(createPreviewArtifactContext(input, 'existing')).toBe(null);
    expect(snapshot(dataDir)).toBe(empty);
    const created = createPreviewArtifactContext(input);
    created.writeOperational({ path: 'requests/r1/proposal.json', contents: 'exact', sources });
    const before = snapshot(dataDir);
    const opened = createPreviewArtifactContext(input, 'existing');
    expect(opened?.readOperational('requests/r1/proposal.json')).toBe('exact');
    expect(snapshot(dataDir)).toBe(before);
    rmSync(join(namespace, 'context.json'));
    const damaged = snapshot(dataDir);
    expect(() => createPreviewArtifactContext(input, 'existing')).toThrow('binding is missing');
    expect(snapshot(dataDir)).toBe(damaged);
  });

  it('distinguishes genuinely absent artifacts from either orphan side and preserves exact publication recovery', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gru-preview-pair-')));
    roots.push(root);
    const repoPath = join(root, 'repo');
    mkdirSync(repoPath);
    git(repoPath, ['init', '-q']);
    const dataDir = join(root, 'private-home');
    const context = createPreviewArtifactContext({ dataDir, repoPath, intakeId: 'intake-296', workflow });
    const path = 'requests/r1/proposal.json';
    expect(context.hasOperational(path)).toBe(false);
    const write = { path, contents: 'exact', sources };
    context.writeOperational(write);
    const payload = join(context.operationalDirectory, path);
    const receipt = join(dataDir, 'projects', context.projectKey, 'intakes', 'intake-296', 'references', `${hash(path)}.json`);
    const original = readFileSync(receipt);
    expect(context.hasOperational(path)).toBe(true);
    rmSync(receipt);
    expect(() => context.hasOperational(path)).toThrow('payload/receipt pair is incomplete');
    expect(() => context.writeOperational(write)).toThrow('receipt missing');
    writeFileSync(receipt, original, { mode: 0o600 });
    rmSync(payload);
    expect(() => context.hasOperational(path)).toThrow('payload/receipt pair is incomplete');
    context.writeOperational(write);
    expect(context.readOperational(path)).toBe('exact');
    expect(readFileSync(receipt)).toEqual(original);
    writeFileSync(payload, 'damaged');
    expect(() => context.readOperational(path)).toThrow('does not match');
  });
});
