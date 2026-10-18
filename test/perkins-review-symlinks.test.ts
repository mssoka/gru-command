import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  freezeReviewInputs, frozenTreeSymlinks, materializeReviewView,
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

  it('materializes links as regular files holding link text, so no read path can follow them', () => {
    const { repo, target } = repoWithLinks(IN_REPO_LINKS);
    const view = materializeReviewView(repo.path, target);
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
    } finally {
      view.dispose();
    }
    expect(lstatSyncOrNull(view.directory)).toBeNull();
  });

  it('roots the lead and lenses in the link-text view and removes it afterwards', async () => {
    const { repo, base, target } = repoWithLinks({ ...IN_REPO_LINKS });
    const frozen = freezeReviewInputs({
      roundId: 'view-round', repoPath: repo.path, artifactRoot: temp('perkins-view-'),
      baseRef: base, targetRef: target, movementRef: 'feature/review', spec: 'return 43',
    });
    const fake = fakeWholeSpawner(temp('perkins-view-sessions-'), { childAnswer: () => '[]' });
    const seen: { cwd: string; linkIsFile: boolean; linkText: string }[] = [];
    const engine = new PerkinsWholeReview({
      spawner: (role, options) => {
        if (options?.cwd !== frozen.directory) {
          const link = join(options!.cwd!, 'AGENTS.md');
          seen.push({ cwd: options!.cwd!, linkIsFile: lstatSync(link).isFile(), linkText: readFileSync(link, 'utf8') });
        }
        return fake.spawner(role, options);
      },
      policy: loadPerkinsPolicy(),
    });
    await engine.run({ roundId: 'view-round', roundNumber: 1, frozenReview: frozen, movementRef: 'feature/review', noSpec: false });
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen.map((entry) => entry.cwd)).size).toBe(1);
    expect(seen[0]!.cwd).not.toBe(repo.path);
    for (const entry of seen) expect(entry).toMatchObject({ linkIsFile: true, linkText: 'CLAUDE.md' });
    expect(lstatSyncOrNull(seen[0]!.cwd)).toBeNull();
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

function lstatSyncOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}
