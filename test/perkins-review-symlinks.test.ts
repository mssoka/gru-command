import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  freezeReviewInputs, frozenTreeSymlinks, materializeReviewView, withReviewTree,
} from '../src/dispatch/perkins-review/artifacts.js';
import { loadPerkinsPolicy } from '../src/dispatch/perkins-review/policy.js';
import { PerkinsWholeReview } from '../src/dispatch/perkins-review/whole.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { fakeWholeSpawner } from './helpers/perkins-whole-double.js';

const cleanup: string[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
  repos.length = 0;
});
const temp = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(path);
  return path;
};

const IDENTITY = ['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid'];

/** A head that tracks `links` (path -> link text) next to real files, with the
 * diff touching only src/main.ts — the links are outside the diff. */
function repoWithLinks(links: Readonly<Record<string, string>>): { repo: FixtureRepo; base: string; target: string } {
  const repo = makeFixtureRepo('perkins-symlinks');
  repos.push(repo);
  mkdirSync(join(repo.path, '.agents/skills/arize'), { recursive: true });
  writeFileSync(join(repo.path, '.agents/skills/arize/SKILL.md'), 'TARGET-CONTENT-MARKER\n');
  writeFileSync(join(repo.path, 'CLAUDE.md'), 'Conventions body TARGET-CONTENT-MARKER\n');
  for (const [path, text] of Object.entries(links)) {
    mkdirSync(join(repo.path, path, '..'), { recursive: true });
    symlinkSync(text, join(repo.path, path));
  }
  repo.git(['add', '-A']);
  repo.git([...IDENTITY, 'commit', '-m', 'tree with links']);
  const base = repo.head();
  repo.git(['checkout', '-b', 'feature/review']);
  const target = repo.commitFile('src/main.ts', 'export const answer = 43;\n');
  return { repo, base, target };
}

const IN_REPO_LINKS = {
  '.claude/skills/arize': '../../.agents/skills/arize',
  'skills/arize': '../.agents/skills/arize',
  'AGENTS.md': 'CLAUDE.md',
} as const;

describe('Perkins review of a tree that tracks symlinks', () => {
  it('reports each in-repo symlink as path plus link text', () => {
    const { repo, target } = repoWithLinks(IN_REPO_LINKS);
    expect(frozenTreeSymlinks(repo.path, target)).toEqual([
      { path: '.claude/skills/arize', linkText: '../../.agents/skills/arize' },
      { path: 'AGENTS.md', linkText: 'CLAUDE.md' },
      { path: 'skills/arize', linkText: '../.agents/skills/arize' },
    ]);
  });

  it('arms a head whose untouched symlinks stay inside the repository', () => {
    const { repo, base, target } = repoWithLinks(IN_REPO_LINKS);
    const frozen = freezeReviewInputs({
      roundId: 'links-round', repoPath: repo.path, artifactRoot: temp('perkins-links-'),
      baseRef: base, targetRef: target, movementRef: 'feature/review', spec: 'return 43',
    });
    expect(frozen.changedFiles).toEqual(['src/main.ts']);
  });

  const expectEscapeRefused = (links: Record<string, string>, named: string): void => {
    const { repo, base, target } = repoWithLinks(links);
    const artifactRoot = temp('perkins-escape-');
    expect(() => freezeReviewInputs({
      roundId: 'escape-round', repoPath: repo.path, artifactRoot,
      baseRef: base, targetRef: target, movementRef: 'feature/review', spec: 'return 43',
    })).toThrow(`symlink that escapes the repository, which review will not follow: ${named}`);
    expect(lstatSyncOrNull(join(artifactRoot, 'escape-round'))).toBeNull();
  };

  it('refuses an absolute link by name before any artifact is written', () => {
    expectEscapeRefused({ 'outside-abs': '/etc/hosts' }, 'outside-abs -> /etc/hosts');
  });

  it('refuses a nested link that climbs past the root by name', () => {
    expectEscapeRefused({ 'a/b/up': '../../../secret' }, 'a/b/up -> ../../../secret');
  });

  it('refuses a root-level link past the root by name', () => {
    expectEscapeRefused({ up: '../sibling' }, 'up -> ../sibling');
  });

  it('allows a link that climbs and re-enters the repository', () => {
    const { repo, target } = repoWithLinks({ 'a/b/ok': '../../CLAUDE.md' });
    expect(frozenTreeSymlinks(repo.path, target)).toContainEqual({ path: 'a/b/ok', linkText: '../../CLAUDE.md' });
  });

  it('shows a symlinked convention file as link text, never its target content', () => {
    const { repo, base, target } = repoWithLinks(IN_REPO_LINKS);
    const frozen = freezeReviewInputs({
      roundId: 'conv-round', repoPath: repo.path, artifactRoot: temp('perkins-conv-'),
      baseRef: base, targetRef: target, movementRef: 'feature/review', spec: 'return 43',
    });
    expect(frozen.projectConventions).toContain('--- AGENTS.md (symlink to CLAUDE.md; not followed) ---\nCLAUDE.md');
    expect(frozen.projectConventions).not.toContain('TARGET-CONTENT-MARKER');
  });

  it('materializes links as regular files holding link text, so no read path can follow them', async () => {
    const { repo, target } = repoWithLinks(IN_REPO_LINKS);
    const view = await materializeReviewView(repo.path, target);
    try {
      for (const [path, text] of Object.entries(IN_REPO_LINKS)) {
        const info = lstatSync(join(view.directory, path));
        expect(info.isSymbolicLink()).toBe(false);
        expect(info.isFile()).toBe(true);
        expect(readFileSync(join(view.directory, path), 'utf8')).toBe(text);
      }
      // The target is still reviewed at its own path.
      expect(readFileSync(join(view.directory, 'CLAUDE.md'), 'utf8')).toContain('TARGET-CONTENT-MARKER');
      expect(lstatSyncOrNull(join(view.directory, '.git'))).toBeNull();
      // No entry anywhere in the view is a symlink, so Read, Grep and Glob can
      // reach a target's content only at the target's own path.
      expect(walk(view.directory).filter((path) => lstatSync(path).isSymbolicLink())).toEqual([]);
      const holders = walk(view.directory).filter((path) =>
        lstatSync(path).isFile() && readFileSync(path, 'utf8').includes('TARGET-CONTENT-MARKER'));
      expect(holders.map((path) => path.slice(view.directory.length + 1)).sort())
        .toEqual(['.agents/skills/arize/SKILL.md', 'CLAUDE.md']);
    } finally {
      view.dispose();
    }
    expect(lstatSyncOrNull(view.directory)).toBeNull();
  });

  it('names the failure and leaves no view behind when the view cannot be materialized', async () => {
    const { repo } = repoWithLinks(IN_REPO_LINKS);
    const before = reviewViews();
    await expect(materializeReviewView(repo.path, '0'.repeat(40))).rejects.toThrow(/could not materialize the review view of 0{40}/);
    expect(reviewViews()).toEqual(before);
  });

  it('sweeps a stale view left by a dead round and keeps a fresh one', async () => {
    const { repo, target } = repoWithLinks(IN_REPO_LINKS);
    const stale = mkdtempSync(join(tmpdir(), 'gru-review-view-'));
    const fresh = mkdtempSync(join(tmpdir(), 'gru-review-view-'));
    cleanup.push(stale, fresh);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    (await materializeReviewView(repo.path, target)).dispose();
    expect(lstatSyncOrNull(stale)).toBeNull();
    expect(lstatSyncOrNull(fresh)).not.toBeNull();
  });

  it('handles links at spaced and unicode paths beside a submodule gitlink', async () => {
    const { repo } = repoWithLinks({ 'docs/my notes/lïnk.md': '../../CLAUDE.md' });
    repo.git(['update-index', '--add', '--cacheinfo', `160000,${repo.head()},vendor/sub`]);
    repo.git([...IDENTITY, 'commit', '-m', 'gitlink']);
    const target = repo.head();
    expect(frozenTreeSymlinks(repo.path, target)).toEqual([{ path: 'docs/my notes/lïnk.md', linkText: '../../CLAUDE.md' }]);
    const view = await materializeReviewView(repo.path, target);
    try {
      expect(readFileSync(join(view.directory, 'docs/my notes/lïnk.md'), 'utf8')).toBe('../../CLAUDE.md');
      expect(lstatSync(join(view.directory, 'docs/my notes/lïnk.md')).isFile()).toBe(true);
    } finally {
      view.dispose();
    }
  });

  it('refuses a link whose text exceeds the bound, naming the link', () => {
    const { repo } = repoWithLinks(IN_REPO_LINKS);
    // The OS caps symlink length, so the oversized link is written as a git object.
    const textFile = join(temp('perkins-long-link-'), 'text');
    writeFileSync(textFile, `${'a/'.repeat(2100)}x`);
    const oid = repo.git(['hash-object', '-w', textFile]).trim();
    repo.git(['update-index', '--add', '--cacheinfo', `120000,${oid},long-link`]);
    repo.git([...IDENTITY, 'commit', '-m', 'oversized link']);
    expect(() => frozenTreeSymlinks(repo.path, repo.head())).toThrow(/oversized link text \(limit 4096 bytes\): long-link/);
  });

  it('roots the lead and every lens in the link-text view and removes it afterwards', async () => {
    const { repo, base, target } = repoWithLinks({ ...IN_REPO_LINKS });
    const frozen = freezeReviewInputs({
      roundId: 'view-round', repoPath: repo.path, artifactRoot: temp('perkins-view-'),
      baseRef: base, targetRef: target, movementRef: 'feature/review', spec: 'return 43',
    });
    const fake = fakeWholeSpawner(temp('perkins-view-sessions-'), { childAnswer: () => '[]' });
    const seen: { cwd: string; kind: 'lead' | 'lens'; linkIsFile: boolean; linkText: string }[] = [];
    const engine = new PerkinsWholeReview({
      spawner: (role, options) => {
        if (options?.cwd !== frozen.directory) {
          const link = join(options!.cwd!, 'AGENTS.md');
          seen.push({
            cwd: options!.cwd!, kind: options?.reviewLead !== undefined ? 'lead' : 'lens',
            linkIsFile: lstatSync(link).isFile(), linkText: readFileSync(link, 'utf8'),
          });
        }
        return fake.spawner(role, options);
      },
      policy: loadPerkinsPolicy(),
    });
    await engine.run({ roundId: 'view-round', roundNumber: 1, frozenReview: frozen, movementRef: 'feature/review', noSpec: false });
    expect(seen.filter((entry) => entry.kind === 'lead')).toHaveLength(1);
    expect(seen.filter((entry) => entry.kind === 'lens').length).toBeGreaterThan(0);
    expect(new Set(seen.map((entry) => entry.cwd)).size).toBe(1);
    expect(seen[0]!.cwd).not.toBe(repo.path);
    for (const entry of seen) expect(entry).toMatchObject({ linkIsFile: true, linkText: 'CLAUDE.md' });
    expect(lstatSyncOrNull(seen[0]!.cwd)).toBeNull();
  });

  it('removes the view when the round fails', async () => {
    const { repo, base, target } = repoWithLinks({ ...IN_REPO_LINKS });
    const frozen = freezeReviewInputs({
      roundId: 'fail-round', repoPath: repo.path, artifactRoot: temp('perkins-fail-'),
      baseRef: base, targetRef: target, movementRef: 'feature/review', spec: 'return 43',
    });
    const before = reviewViews();
    await expect(withReviewTree(frozen, async (readable) => {
      expect(readable.readTreeRoot).toBeDefined();
      throw new Error('round failed');
    })).rejects.toThrow('round failed');
    expect(reviewViews()).toEqual(before);
  });

  it('refuses a recovered round whose target tracks an escaping link before any reviewer starts', async () => {
    const clean = repoWithLinks(IN_REPO_LINKS);
    const frozen = freezeReviewInputs({
      roundId: 'recover-round', repoPath: clean.repo.path, artifactRoot: temp('perkins-recover-'),
      baseRef: clean.base, targetRef: clean.target, movementRef: 'feature/review', spec: 'return 43',
    });
    symlinkSync('/etc/hosts', join(clean.repo.path, 'escape'));
    clean.repo.git(['add', 'escape']);
    clean.repo.git([...IDENTITY, 'commit', '-m', 'escaping link']);
    const escaping = clean.repo.head();
    const spawned: string[] = [];
    const engine = new PerkinsWholeReview({
      spawner: (role) => { spawned.push(role); throw new Error('no reviewer may start'); },
      policy: loadPerkinsPolicy(),
    });
    await expect(engine.run({
      roundId: 'recover-round', roundNumber: 1, frozenReview: { ...frozen, manifest: { ...frozen.manifest, targetSha: escaping } },
      movementRef: 'feature/review', noSpec: false,
    })).rejects.toThrow(/symlink that escapes the repository.*: escape -> \/etc\/hosts/);
    expect(spawned).toEqual([]);
  });

  it('keeps reading the checkout itself when the target tracks no symlink', async () => {
    const repo = makeFixtureRepo('perkins-nolinks');
    repos.push(repo);
    const base = repo.head();
    repo.git(['checkout', '-b', 'feature/review']);
    const target = repo.commitFile('src/main.ts', 'export const answer = 43;\n');
    const frozen = freezeReviewInputs({
      roundId: 'plain-round', repoPath: repo.path, artifactRoot: temp('perkins-plain-'),
      baseRef: base, targetRef: target, movementRef: 'feature/review', spec: 'return 43',
    });
    const fake = fakeWholeSpawner(temp('perkins-plain-sessions-'), { childAnswer: () => '[]' });
    const cwds = new Set<string>();
    const engine = new PerkinsWholeReview({
      spawner: (role, options) => { cwds.add(options!.cwd!); return fake.spawner(role, options); },
      policy: loadPerkinsPolicy(),
    });
    await engine.run({ roundId: 'plain-round', roundNumber: 1, frozenReview: frozen, movementRef: 'feature/review', noSpec: false });
    expect([...cwds].sort()).toEqual([frozen.directory, repo.path].sort());
  });
});

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? [path, ...walk(path)] : [path];
  });
}

function reviewViews(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith('gru-review-view-')).sort();
}

function lstatSyncOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}
