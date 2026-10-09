import { readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freezeReviewInputs, reviewArtifactDirectory, type FrozenReview } from '../src/dispatch/perkins-review/artifacts.js';
import {
  classifyPriorFindings,
  convergedVerdict,
  deltaSince,
  findingIntersectsDelta,
  integrationSince,
  planReviewScope,
  planPerkinsReviewScope,
  probeIntegrationLineage,
  parseDeltaHunks,
  parseFindingLocation,
  parseDeltaStructure,
  applyConvergenceDeferral,
  readPriorConvergenceMeta,
} from '../src/dispatch/perkins-review/convergence.js';
import { loadPerkinsPolicy } from '../src/dispatch/perkins-review/policy.js';
import { PerkinsWholeReview, type PerkinsWholeResult } from '../src/dispatch/perkins-review/whole.js';
import type { VerifiedFinding } from '../src/dispatch/perkins-review/types.js';
import { fakeWholeSpawner, groundedFinding, type WholeLeadOptions } from './helpers/perkins-whole-double.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

const repos: FixtureRepo[] = [];
const temporaryDirectories: string[] = [];
function temp(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => {
  while (repos.length > 0) repos.pop()!.cleanup();
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

describe('finding location parsing (Stage-5 convergence)', () => {
  it('parses path:line, path:start-end and path:hunk shapes', () => {
    expect(parseFindingLocation('src/main.ts:12')).toEqual({ path: 'src/main.ts', startLine: 12, endLine: 12 });
    expect(parseFindingLocation('src/main.ts:12-40')).toEqual({ path: 'src/main.ts', startLine: 12, endLine: 40 });
    expect(parseFindingLocation('src/main.ts:hunk')).toEqual({ path: 'src/main.ts', startLine: null, endLine: null });
    expect(parseFindingLocation('src/main.ts')).toEqual({ path: 'src/main.ts', startLine: null, endLine: null });
  });

  it('refuses locations that name no reviewable file path', () => {
    expect(parseFindingLocation('N/A')).toBeNull();
    expect(parseFindingLocation('N/A: the invariant is absent')).toBeNull();
    expect(parseFindingLocation('/absolute/path.ts:1')).toBeNull();
    expect(parseFindingLocation('a/../b.ts:1')).toBeNull();
  });
});

describe('delta hunk parsing and intersection', () => {
  const diff = [
    'diff --git a/src/kept.ts b/src/kept.ts',
    'index 1111111..2222222 100644',
    '--- a/src/kept.ts',
    '+++ b/src/kept.ts',
    '@@ -1,3 +1,4 @@',
    ' const one = 1;',
    '+const two = 2;',
    ' const three = 3;',
    'diff --git a/src/deleted.ts b/src/deleted.ts',
    'index 3333333..0000000 100644',
    '--- a/src/deleted.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-const gone = true;',
    '-const alsoGone = true;',
    'diff --git a/src/mode-only.ts b/src/mode-only.ts',
    'old mode 100644',
    'new mode 100755',
  ].join('\n');

  it('parses EXACT added lines (context excluded) and deletion seams', () => {
    const { hunks, paths } = parseDeltaStructure(diff);
    expect(hunks).toEqual([
      { path: 'src/kept.ts', kind: 'added', startLine: 2, endLine: 2 },
      { path: 'src/deleted.ts', kind: 'seam', startLine: 1, endLine: 1 },
      { path: 'src/deleted.ts', kind: 'seam', startLine: 1, endLine: 1 },
      { path: 'src/mode-only.ts', kind: 'metadata', startLine: 0, endLine: Number.MAX_SAFE_INTEGER },
    ]);
    // Every named path is touched, including a mode-only change with no hunk.
    expect(paths).toEqual(new Set(['src/kept.ts', 'src/deleted.ts', 'src/mode-only.ts']));
  });

  it('intersects changed lines and deletion seams, never untouched context', () => {
    const hunks = parseDeltaHunks(diff);
    expect(findingIntersectsDelta('src/kept.ts:2', hunks)).toBe(true);
    expect(findingIntersectsDelta('src/kept.ts:2-3', hunks)).toBe(true);
    // A context line inside the hunk is NOT a changed line.
    expect(findingIntersectsDelta('src/kept.ts:1', hunks)).toBe(false);
    // Untouched line of a touched file: outside every changed range.
    expect(findingIntersectsDelta('src/kept.ts:900', hunks)).toBe(false);
    // A file with no hunks at all is untouched code by construction.
    expect(findingIntersectsDelta('src/untouched.ts:1', hunks)).toBe(false);
    // A grounded finding about DELETED code anchors at the removal seam.
    expect(findingIntersectsDelta('src/deleted.ts:1', hunks)).toBe(true);
  });

  it('parses Git-quoted paths (spaces and escapes) instead of losing their hunks', () => {
    const quoted = [
      'diff --git "a/src/weird name.ts" "b/src/weird name.ts"',
      '--- "a/src/weird name.ts"',
      '+++ "b/src/weird name.ts"',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    const { hunks, paths } = parseDeltaStructure(quoted);
    expect(paths.has('src/weird name.ts')).toBe(true);
    // The modification carries both the removal seam and the added line.
    expect(hunks).toEqual([
      { path: 'src/weird name.ts', kind: 'seam', startLine: 1, endLine: 1 },
      { path: 'src/weird name.ts', kind: 'added', startLine: 1, endLine: 1 },
    ]);
    expect(findingIntersectsDelta('src/weird name.ts:1', hunks)).toBe(true);
  });

  it('never mistakes hunk BODY content for file headers', () => {
    const tricky = [
      'diff --git a/src/real.ts b/src/real.ts',
      '--- a/src/real.ts',
      '+++ b/src/real.ts',
      '@@ -1,2 +1,3 @@',
      ' keep',
      '++ ++foo;',
      '+-- --bar;',
      '--- --baz;',
      '+++ ++qux;',
    ].join('\n');
    const { hunks, paths } = parseDeltaStructure(tricky);
    // Every body line above is CONTENT: added lines start with '+'.
    expect(paths).toEqual(new Set(['src/real.ts']));
    expect(hunks).toEqual([
      { path: 'src/real.ts', kind: 'added', startLine: 2, endLine: 3 },
      { path: 'src/real.ts', kind: 'seam', startLine: 3, endLine: 4 },
      { path: 'src/real.ts', kind: 'added', startLine: 4, endLine: 4 },
    ]);
  });

  it('decodes octal UTF-8 escapes and bare paths with spaces', () => {
    const quoted = [
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      '--- "a/caf\\303\\251.ts"',
      '+++ "b/caf\\303\\251.ts"',
      '@@ -1 +1 @@',
      '-old',
      '+new',
    ].join('\n');
    expect(parseDeltaStructure(quoted).paths.has('caf\u00e9.ts')).toBe(true);

    // Mode-only changes print BARE headers even when the path has spaces.
    const bare = [
      'diff --git a/src/weird name.ts b/src/weird name.ts',
      'old mode 100644',
      'new mode 100755',
    ].join('\n');
    const parsedBare = parseDeltaStructure(bare);
    expect(parsedBare.paths.has('src/weird name.ts')).toBe(true);
    expect(findingIntersectsDelta('src/weird name.ts:1', parsedBare.hunks)).toBe(true);
  });

  it('parses paths containing " b/" and non-BMP quoted names', () => {
    // A mode-only change prints the BARE header even when the path itself
    // contains a ` b/` segment: the same-path candidate wins the split.
    const bare = [
      'diff --git a/src/a b/thing.ts b/src/a b/thing.ts',
      'old mode 100644',
      'new mode 100755',
    ].join('\n');
    const parsedBare = parseDeltaStructure(bare);
    expect(parsedBare.paths).toEqual(new Set(['src/a b/thing.ts']));
    expect(findingIntersectsDelta('src/a b/thing.ts:1', parsedBare.hunks)).toBe(true);

    // A quoted path with an emoji (non-BMP) and a tab escape decodes
    // byte-accurately: surrogate halves are never encoded separately.
    const quoted = [
      'diff --git "a/src/\u{1F600}\\tfile.ts" "b/src/\u{1F600}\\tfile.ts"',
      'old mode 100644',
      'new mode 100755',
    ].join('\n');
    const parsedQuoted = parseDeltaStructure(quoted);
    expect(parsedQuoted.paths).toEqual(new Set(['src/\u{1F600}\tfile.ts']));
    expect(findingIntersectsDelta('src/\u{1F600}\tfile.ts:1', parsedQuoted.hunks)).toBe(true);

    // A pure rename carries its destination in metadata (no ---/+++ pair).
    const renamed = [
      'diff --git a/old.ts b/new name.ts',
      'similarity index 100%',
      'rename from old.ts',
      'rename to new name.ts',
    ].join('\n');
    const parsedRenamed = parseDeltaStructure(renamed);
    expect(parsedRenamed.paths.has('new name.ts')).toBe(true);
    expect(findingIntersectsDelta('new name.ts:1', parsedRenamed.hunks)).toBe(true);
  });

  it('lets rename metadata override an ambiguous bare header (no bogus touched path)', () => {
    // The reviewer's exact real-Git repro: rename `x b/y b/x` -> `y` while
    // an UNRELATED `x b/y` exists. The bare header `a/x b/y b/x b/y` has a
    // WRONG equal-pair split at `x b/y`; without rename metadata that split
    // wins and records the untouched file as changed, so an unrelated
    // blocker there could hold the PR.
    const renamed = [
      'diff --git a/x b/y b/x b/y',
      'similarity index 100%',
      'rename from x b/y b/x',
      'rename to y',
    ].join('\n');
    const parsed = parseDeltaStructure(renamed);
    expect(parsed.paths.has('y')).toBe(true);
    // The true source is touched (the file was removed there) but carries
    // no intersection span.
    expect(parsed.paths.has('x b/y b/x')).toBe(true);
    expect(findingIntersectsDelta('y:1', parsed.hunks)).toBe(true);
    // The unrelated file whose name matches the wrong equal split stays
    // untouched.
    expect(findingIntersectsDelta('x b/y:1', parsed.hunks)).toBe(false);
  });

  it('fails closed toward blocking for unanchored findings and unusable line numbers', () => {
    const hunks = parseDeltaHunks(diff);
    expect(findingIntersectsDelta('N/A', hunks)).toBe(true);
    expect(findingIntersectsDelta('no path at all', hunks)).toBe(true);
    expect(findingIntersectsDelta('src/kept.ts:hunk', hunks)).toBe(true);
    // An oversized line number can never silently defer a blocker.
    expect(findingIntersectsDelta('src/kept.ts:99999999999999999999', hunks)).toBe(true);
  });
});

describe('deltaSince (bounded git delta)', () => {
  it('reads the prior-target delta with touched paths and hunks', () => {
    const repo = makeFixtureRepo('perkins-convergence-delta');
    repos.push(repo);
    const base = repo.head();
    repo.git(['checkout', '-b', 'feature/delta']);
    const first = repo.commitFile('src/first.ts', 'export const first = 1;\n');
    const second = repo.commitFile('src/second.ts', 'export const second = 2;\nexport const also = 3;\n');
    const delta = deltaSince(repo.path, first, second);
    expect(delta.fromSha).toBe(first);
    expect(delta.toSha).toBe(second);
    expect(delta.touchedPaths).toEqual(new Set(['src/second.ts']));
    expect(delta.hunks).toEqual([{ path: 'src/second.ts', kind: 'added', startLine: 1, endLine: 2 }]);
    expect(delta.diff).toContain('+++ b/src/second.ts');
    expect(Buffer.byteLength(`x${base}`)).toBeGreaterThan(0);
  });

  it('touches mode-only changed paths that emit no hunks', () => {
    const repo = makeFixtureRepo('perkins-convergence-mode-only');
    repos.push(repo);
    repo.git(['checkout', '-b', 'feature/mode']);
    const first = repo.commitFile('src/script.sh', '#!/bin/sh\necho hi\n');
    repo.git(['update-index', '--chmod=+x', 'src/script.sh']);
    // A CI runner has no global git identity: commit with an explicit one.
    repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'make executable']);
    const second = repo.head();
    const delta = deltaSince(repo.path, first, second);
    expect(delta.touchedPaths.has('src/script.sh')).toBe(true);
    // No line hunks exist, but the file DID change: the parser emits a
    // metadata span so a finding on it can never be proven outside the
    // delta (fail-closed toward blocking) and car-ried priors re-verify.
    expect(delta.hunks).toEqual([
      { path: 'src/script.sh', kind: 'metadata', startLine: 0, endLine: Number.MAX_SAFE_INTEGER },
    ]);
    expect(findingIntersectsDelta('src/script.sh:1', delta.hunks)).toBe(true);
  });

  it('refuses non-SHA endpoints and unreadable revisions', () => {
    const repo = makeFixtureRepo('perkins-convergence-delta-bad');
    repos.push(repo);
    expect(() => deltaSince(repo.path, 'main', 'HEAD')).toThrow();
    expect(() => deltaSince(repo.path, '0'.repeat(40), '1'.repeat(40))).toThrow();
  });
});

describe('integration unit (retained coverage across an advanced base)', () => {
  it('reads the new integration/conflict-resolution work, never incoming base or unchanged feature files', () => {
    const repo = makeFixtureRepo('perkins-integration-unit');
    repos.push(repo);
    repo.git(['config', 'user.name', 'Fixture Tests']);
    repo.git(['config', 'user.email', 'tests@example.invalid']);
    const b0 = repo.head();
    repo.git(['checkout', '-b', 'feature/integration']);
    repo.commitFile('src/feature.ts', 'export const feature = 1;\n');
    const h0 = repo.commitFile('src/shared.ts', 'export const shared = "feature";\n');
    repo.git(['checkout', 'main']);
    repo.commitFile('src/mainonly.ts', 'export const mainonly = 1;\n');
    const b1 = repo.commitFile('src/shared.ts', 'export const shared = "main";\n');
    repo.git(['checkout', 'feature/integration']);
    expect(() => repo.git(['merge', 'main'])).toThrow(); // conflict on src/shared.ts
    writeFileSync(join(repo.path, 'src', 'shared.ts'), 'export const shared = "resolved";\n');
    repo.git(['add', 'src/shared.ts']);
    repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'resolve shared']);
    const h1 = repo.head();

    const unit = integrationSince(repo.path, h0, b0, b1, h1);
    expect(unit.priorTargetSha).toBe(h0);
    expect(unit.priorDiffBaseSha).toBe(b0);
    expect(unit.incomingBaseSha).toBe(b1);
    // Only the manual resolution: the feature-only file is unchanged and the
    // main-only file is baseline context, never new PR work.
    expect(unit.integrationPaths).toEqual(['src/shared.ts']);
    expect(unit.touchedPaths).toEqual(new Set(['src/shared.ts']));
    expect(unit.diff).toContain('src/shared.ts');
    expect(unit.diff).not.toContain('mainonly');
    expect(unit.diff).not.toContain('feature.ts');
    // Carry scope is every path changed H0..H1, so a base-only change still
    // re-verifies (it need not be in the focused unit).
    expect(unit.carryPaths).toEqual(new Set(['src/mainonly.ts', 'src/shared.ts']));
  });

  it('is empty for a clean integration of unchanged feature work', () => {
    const repo = makeFixtureRepo('perkins-integration-clean');
    repos.push(repo);
    repo.git(['config', 'user.name', 'Fixture Tests']);
    repo.git(['config', 'user.email', 'tests@example.invalid']);
    const b0 = repo.head();
    repo.git(['checkout', '-b', 'feature/clean']);
    const h0 = repo.commitFile('src/feature.ts', 'export const feature = 1;\n');
    repo.git(['checkout', 'main']);
    repo.commitFile('src/mainonly.ts', 'export const mainonly = 1;\n');
    const b1 = repo.head();
    repo.git(['checkout', 'feature/clean']);
    repo.git(['merge', '--no-ff', '-m', 'merge main', 'main']);
    const h1 = repo.head();

    const unit = integrationSince(repo.path, h0, b0, b1, h1);
    expect(unit.touchedPaths).toEqual(new Set());
    expect(unit.diff).toBe('');
    expect(unit.carryPaths).toEqual(new Set(['src/mainonly.ts']));
    // A base-only advance with unchanged feature work is a clean integration.
    expect(probeIntegrationLineage(repo.path, {
      priorDiffBaseSha: b0, priorTargetSha: h0, currentDiffBaseSha: b1, currentTargetSha: h1,
    })).toEqual({ baseAdvanced: true, featureIntegrated: true, commonBasePinned: true, sameHeadAdoptedBase: false });
  });

  it('keeps a clean both-sides file (disjoint hunks) in the unit, and a new feature edit too', () => {
    const repo = makeFixtureRepo('perkins-integration-both');
    repos.push(repo);
    repo.git(['config', 'user.name', 'Fixture Tests']);
    repo.git(['config', 'user.email', 'tests@example.invalid']);
    const b0 = repo.head();
    repo.git(['checkout', '-b', 'feature/both']);
    // The feature edits the return value (a prior-covered change).
    const h0 = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    repo.git(['checkout', 'main']);
    // Main adds an unrelated function below (disjoint) and its own file.
    repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 42;\n}\nexport const extra = 1;\n');
    const b1 = repo.commitFile('src/mainonly.ts', 'export const mainonly = 1;\n');
    repo.git(['checkout', 'feature/both']);
    // A genuinely NEW feature edit after the covered head, then a CLEAN merge.
    const h0b = repo.commitFile('src/newfeature.ts', 'export const newfeature = 1;\n');
    repo.git(['merge', '--no-ff', '-m', 'merge main', 'main']);
    const h1 = repo.head();

    const unit = integrationSince(repo.path, h0, b0, b1, h1);
    // The both-sides file is a real interaction site; the new feature edit is
    // new work; the main-only file is not.
    expect(unit.integrationPaths).toEqual(['src/main.ts', 'src/newfeature.ts']);
    expect(unit.integrationPaths).not.toContain('src/mainonly.ts');
    expect(unit.diff).not.toContain('mainonly');
    expect(h0b).toMatch(/^[0-9a-f]{40}$/u);
  });

  it('flags a resolution that discarded prior feature work', () => {
    const repo = makeFixtureRepo('perkins-integration-dropped');
    repos.push(repo);
    repo.git(['config', 'user.name', 'Fixture Tests']);
    repo.git(['config', 'user.email', 'tests@example.invalid']);
    const b0 = repo.head();
    repo.git(['checkout', '-b', 'feature/dropped']);
    const h0 = repo.commitFile('src/shared.ts', 'export const shared = "feature";\n');
    repo.git(['checkout', 'main']);
    const b1 = repo.commitFile('src/shared.ts', 'export const shared = "main";\n');
    repo.git(['checkout', 'feature/dropped']);
    expect(() => repo.git(['merge', 'main'])).toThrow();
    // Resolution takes the incoming base verbatim: the feature change is dropped.
    writeFileSync(join(repo.path, 'src', 'shared.ts'), 'export const shared = "main";\n');
    repo.git(['add', 'src/shared.ts']);
    repo.git(['commit', '-m', 'resolve shared (take main)']);
    const h1 = repo.head();

    const unit = integrationSince(repo.path, h0, b0, b1, h1);
    expect(unit.integrationPaths).toEqual([]);
    expect(unit.diff).toBe('');
    expect(unit.droppedFeaturePaths).toEqual(['src/shared.ts']);
    expect(unit.carryPaths.has('src/shared.ts')).toBe(true);
  });

  it('refuses non-SHA endpoints and an unreadable revision', () => {
    const repo = makeFixtureRepo('perkins-integration-bad');
    repos.push(repo);
    const head = repo.head();
    expect(() => integrationSince(repo.path, 'main', head, head, head)).toThrow();
    expect(() => integrationSince(repo.path, '0'.repeat(40), '0'.repeat(40), '1'.repeat(40), '2'.repeat(40))).toThrow();
  });

  it('proves the forward-integration lineage and fails closed on a rewrite or rebase', () => {
    const repo = makeFixtureRepo('perkins-integration-lineage');
    repos.push(repo);
    repo.git(['config', 'user.name', 'Fixture Tests']);
    repo.git(['config', 'user.email', 'tests@example.invalid']);
    const b0 = repo.head();
    repo.git(['checkout', '-b', 'feature/lineage']);
    const h0 = repo.commitFile('src/feature.ts', 'export const feature = 1;\n');
    repo.git(['checkout', 'main']);
    const b1 = repo.commitFile('src/mainonly.ts', 'export const mainonly = 1;\n');
    repo.git(['checkout', '-b', 'sibling', b0]);
    const sibling = repo.commitFile('src/sibling.ts', 'export const sibling = 1;\n');
    repo.git(['checkout', 'feature/lineage']);
    repo.git(['merge', '--no-ff', '-m', 'merge main', 'main']);
    const h1 = repo.head();

    expect(probeIntegrationLineage(repo.path, {
      priorDiffBaseSha: b0, priorTargetSha: h0, currentDiffBaseSha: b1, currentTargetSha: h1,
    })).toEqual({ baseAdvanced: true, featureIntegrated: true, commonBasePinned: true, sameHeadAdoptedBase: false });
    // A prior head that was NOT integrated forward cannot retain coverage.
    expect(probeIntegrationLineage(repo.path, {
      priorDiffBaseSha: b0, priorTargetSha: sibling, currentDiffBaseSha: b1, currentTargetSha: h1,
    })).toEqual({ baseAdvanced: true, featureIntegrated: false, commonBasePinned: false, sameHeadAdoptedBase: false });
    // A malformed SHA can never establish lineage.
    expect(probeIntegrationLineage(repo.path, {
      priorDiffBaseSha: 'main', priorTargetSha: h0, currentDiffBaseSha: b1, currentTargetSha: h1,
    })).toBeNull();
  });

  it('keeps a mode-only change inside the unit and the carry scope', () => {
    const repo = makeFixtureRepo('perkins-integration-mode');
    repos.push(repo);
    repo.git(['config', 'user.name', 'Fixture Tests']);
    repo.git(['config', 'user.email', 'tests@example.invalid']);
    const b0 = repo.head();
    repo.git(['checkout', '-b', 'feature/mode']);
    const h0 = repo.commitFile('src/script.sh', '#!/bin/sh\necho hi\n');
    repo.git(['checkout', 'main']);
    const b1 = repo.commitFile('src/mainonly.ts', 'export const mainonly = 1;\n');
    repo.git(['checkout', 'feature/mode']);
    repo.git(['merge', '--no-ff', '-m', 'merge main', 'main']);
    // A mode-only change after the merge, committed as the new integration head.
    repo.git(['update-index', '--chmod=+x', 'src/script.sh']);
    repo.git(['commit', '-m', 'make script executable']);
    const h1 = repo.head();

    const unit = integrationSince(repo.path, h0, b0, b1, h1);
    expect(unit.integrationPaths).toContain('src/script.sh');
    expect(unit.carryPaths.has('src/script.sh')).toBe(true);
  });
});

describe('integration scope: same-head adopted base and identical base adoption', () => {
  it('retains coverage (no whole reset) when an unchanged candidate adopts a descendant base', () => {
    const repo = makeFixtureRepo('perkins-same-head-adopted');
    repos.push(repo);
    repo.git(['config', 'user.name', 'Fixture Tests']);
    repo.git(['config', 'user.email', 'tests@example.invalid']);
    const b0 = repo.head();
    repo.git(['checkout', '-b', 'feature/adopted']);
    repo.commitFile('src/shared.ts', 'export const shared = 1;\n'); // commit C
    repo.git(['checkout', 'main']);
    repo.git(['merge', '--ff-only', 'feature/adopted']); // main advances to C
    const currentBase = repo.head();
    repo.git(['checkout', 'feature/adopted']);
    const h0 = repo.commitFile('src/feature.ts', 'export const feature = 1;\n'); // H0 = C + a feature edit

    const lineage = probeIntegrationLineage(repo.path, {
      priorDiffBaseSha: b0, priorTargetSha: h0, currentDiffBaseSha: currentBase, currentTargetSha: h0,
    });
    expect(lineage).toEqual({
      baseAdvanced: true, featureIntegrated: true, commonBasePinned: false, sameHeadAdoptedBase: true,
    });
    // Nothing new to review: the adopted change is inside the reviewed history
    // and the candidate is unchanged.
    const unit = integrationSince(repo.path, h0, b0, currentBase, h0);
    expect(unit.integrationPaths).toEqual([]);
    expect(unit.droppedFeaturePaths).toEqual([]);

    const plan = planReviewScope({
      prior: {
        seq: 1, reviewScope: 'whole', canonicalVerdict: 'READY TO MERGE', targetSha: h0, diffBaseSha: b0,
        acceptance: null, coverageComplete: true, legacyWhole: false, findings: null,
      },
      currentTargetSha: h0, currentDiffBaseSha: currentBase,
      deltaRoundsFrom: 2, finalWholePassAtReady: true, integrationCoverage: true,
      integrationLineage: lineage, acceptanceCompatible: true,
    });
    expect(plan.scope).toBe('integration');
    expect(plan.priorCoverageComplete).toBe(true);
    expect(plan.reason).toContain('candidate is unchanged');

    // A base that advanced BEYOND the reviewed head is not adoption: the
    // candidate unchanged but the new base is not an ancestor of it.
    const beyond = repo.commitFile('src/feature.ts', 'export const feature = 2;\n'); // move the feature head
    expect(probeIntegrationLineage(repo.path, {
      priorDiffBaseSha: b0, priorTargetSha: h0, currentDiffBaseSha: beyond, currentTargetSha: h0,
    })!.sameHeadAdoptedBase).toBe(false);
  });

  it('does not mistake a base-adopted identical change for discarded feature work', () => {
    const repo = makeFixtureRepo('perkins-identical-adoption');
    repos.push(repo);
    repo.git(['config', 'user.name', 'Fixture Tests']);
    repo.git(['config', 'user.email', 'tests@example.invalid']);
    repo.commitFile('src/p.ts', 'export const p = "orig";\n');
    repo.commitFile('src/q.ts', 'export const q = "orig";\n');
    const b0 = repo.head();
    repo.git(['checkout', '-b', 'feature/adopt']);
    repo.commitFile('src/p.ts', 'export const p = "feat";\n');
    const h0 = repo.commitFile('src/q.ts', 'export const q = "feat";\n');
    repo.git(['checkout', 'main']);
    // The base independently adopts the IDENTICAL p change.
    const b1 = repo.commitFile('src/p.ts', 'export const p = "feat";\n');
    repo.git(['checkout', 'feature/adopt']);
    repo.git(['merge', '--no-ff', '-m', 'merge main', 'main']);
    const h1 = repo.head();

    const unit = integrationSince(repo.path, h0, b0, b1, h1);
    // p did not change H0..H1: the base adopted it, so it is NOT discarded
    // feature work and does not force a whole reset. H0 and H1 content are
    // identical here, so there is no changed-since-prior path at all.
    expect(unit.droppedFeaturePaths).toEqual([]);
    expect(unit.carryPaths.size).toBe(0);
    expect(unit.integrationPaths).toEqual([]);

    // Contrast: a take-main conflict resolution DOES change H0..H1 and is
    // retained as genuine discarded feature work.
    const repo2 = makeFixtureRepo('perkins-take-main');
    repos.push(repo2);
    repo2.git(['config', 'user.name', 'Fixture Tests']);
    repo2.git(['config', 'user.email', 'tests@example.invalid']);
    repo2.commitFile('src/p.ts', 'export const p = "orig";\n');
    const c0 = repo2.head();
    repo2.git(['checkout', '-b', 'feature/take']);
    const d0 = repo2.commitFile('src/p.ts', 'export const p = "feat";\n');
    repo2.git(['checkout', 'main']);
    const c1 = repo2.commitFile('src/p.ts', 'export const p = "main";\n');
    repo2.git(['checkout', 'feature/take']);
    expect(() => repo2.git(['merge', 'main'])).toThrow();
    writeFileSync(join(repo2.path, 'src', 'p.ts'), 'export const p = "main";\n');
    repo2.git(['add', 'src/p.ts']);
    repo2.git(['commit', '-m', 'resolve p (take main)']);
    const d1 = repo2.head();
    const taken = integrationSince(repo2.path, d0, c0, c1, d1);
    expect(taken.droppedFeaturePaths).toEqual(['src/p.ts']);
  });
});

describe('production scope planning wiring (planPerkinsReviewScope)', () => {
  it('authenticates retained coverage against native receipts, failing closed on mismatches', () => {
    const repo = makeFixtureRepo('perkins-scope-wiring');
    repos.push(repo);
    repo.git(['config', 'user.name', 'Fixture Tests']);
    repo.git(['config', 'user.email', 'tests@example.invalid']);
    const root = temp('perkins-scope-wiring-artifacts-');
    const b0 = repo.head();
    repo.git(['checkout', '-b', 'feature/wiring']);
    const h0 = repo.commitFile('src/feature.ts', 'export const feature = 1;\n');
    repo.git(['checkout', 'main']);
    const b1 = repo.commitFile('src/mainonly.ts', 'export const mainonly = 1;\n');
    repo.git(['checkout', 'feature/wiring']);
    repo.git(['merge', '--no-ff', '-m', 'merge main', 'main']);
    const h1 = repo.head();
    const rules = { deltaRoundsFrom: 2, finalWholePassAtReady: true, integrationCoverage: true };
    const writePrior = (name: string, record: unknown): string => {
      const file = join(root, name);
      writeFileSync(file, JSON.stringify(record));
      return file;
    };
    const wholePrior = {
      schemaVersion: 3, architecture: 'perkins-whole-pr', canonicalVerdict: 'READY TO MERGE',
      complete: true, headMoved: false, frozen: { targetSha: h0, diffBaseSha: b0 },
      convergence: { reviewScope: 'whole', coverageComplete: true },
    };
    const call = (priorConsolidatedFile: string, extra: Partial<Parameters<typeof planPerkinsReviewScope>[0]> = {}) =>
      planPerkinsReviewScope({
        priorConsolidatedFile, priorSeq: 1, repoPath: repo.path,
        currentTargetSha: h1, currentDiffBaseSha: b1, currentAcceptance: undefined, rules, ...extra,
      });
    const nativeWholeReceipt = { targetSha: h0, diffBaseSha: b0, reviewScope: 'whole', coverageComplete: true };

    // (happy) An authenticated whole-complete prior retains coverage.
    const valid = writePrior('prior.json', wholePrior);
    const plan = call(valid, { nativeReceipt: nativeWholeReceipt });
    expect(plan.scope).toBe('integration');
    expect(plan.priorCoverageComplete).toBe(true);

    // (unauthenticated) No native receipt can never manufacture coverage.
    const unauthenticated = call(valid);
    expect(unauthenticated.scope).toBe('whole');
    expect(unauthenticated.reason).toContain('could not be authenticated');
    expect(unauthenticated.priorCoverageComplete).toBe(false);

    // (stripped convergence on a partial record) The file loses its
    // convergence block, but the native receipt still records a delta scope.
    const stripped = writePrior('prior-stripped.json', { ...wholePrior, convergence: undefined });
    const strippedPlan = call(stripped, { nativeReceipt: { targetSha: h0, diffBaseSha: b0, reviewScope: 'delta' } });
    expect(strippedPlan.scope).toBe('whole');
    expect(strippedPlan.priorCoverageComplete).toBe(false);

    // (contradictory complete + debt) The file claims complete coverage while
    // the native receipt records the round still owed the final pass.
    const contradictory = call(valid, {
      nativeReceipt: { ...nativeWholeReceipt, coverageComplete: false, finalPassRequired: true },
    });
    expect(contradictory.scope).toBe('whole');
    expect(contradictory.priorCoverageComplete).toBe(false);

    // (altered acceptance) The record's acceptance no longer matches its own
    // round's ledger-native freeze binding.
    const acceptanceReceipt = { version: 2, baseSha256: '', contractSha256: 'a'.repeat(64), amendmentIds: [] };
    const altered = writePrior('prior-altered-acceptance.json', {
      ...wholePrior,
      frozen: { targetSha: h0, diffBaseSha: b0, acceptance: { ...acceptanceReceipt, contractSha256: 'b'.repeat(64) } },
    });
    const alteredPlan = call(altered, { nativeReceipt: nativeWholeReceipt, acceptanceReceipt });
    expect(alteredPlan.scope).toBe('whole');
    expect(alteredPlan.priorCoverageComplete).toBe(false);

    // (genuine legacy) No convergence block AND a receipt with no Stage-5
    // evidence: a real pre-Stage-5 whole review is whole-complete.
    const legacy = writePrior('prior-legacy.json', { ...wholePrior, convergence: undefined });
    const legacyPlan = call(legacy, { nativeReceipt: { targetSha: h0, diffBaseSha: b0 } });
    expect(legacyPlan.scope).toBe('integration');
    expect(legacyPlan.priorCoverageComplete).toBe(true);

    // (acceptance changed since the retained round) Still whole.
    const mismatched = call(valid, {
      nativeReceipt: nativeWholeReceipt,
      currentAcceptance: { version: 1, baseSha256: '', contractSha256: 'a'.repeat(64), amendmentIds: [] },
    });
    expect(mismatched.scope).toBe('whole');
    expect(mismatched.reason).toContain('acceptance');

    // (not a conclusive whole-PR record) disclosed, never mistaken for a
    // first review.
    const rejected = writePrior('prior-v2.json', { schemaVersion: 2, architecture: 'perkins-hybrid', complete: true, findings: [] });
    const refused = call(rejected);
    expect(refused.scope).toBe('whole');
    expect(refused.reason).toContain('not a conclusive whole-PR record');

    // (baseline Stage-5 whole receipt) A whole round whose receipt predates the
    // coverageComplete field is still whole-complete: no whole replay just to
    // mint metadata.
    const baseline = writePrior('prior-baseline-whole.json', {
      ...wholePrior,
      convergence: { reviewScope: 'whole' },
    });
    const baselinePlan = call(baseline, { nativeReceipt: { targetSha: h0, diffBaseSha: b0, reviewScope: 'whole' } });
    expect(baselinePlan.scope).toBe('integration');
    expect(baselinePlan.priorCoverageComplete).toBe(true);

    // (tampered retained findings) Swapping a genuine whole NEEDS CHANGES
    // record's findings to [] must NOT be credited whole-complete coverage.
    const genuineFindings = [{
      source: 'lead', severity: 'blocker', category: 'correctness', title: 'unresolved blocker',
      location: 'src/feature.ts:1', evidence: 'export const feature = 1;', detail: 'the defect remains',
      recommended_fix: 'fix it', verification: { disposition: 'confirmed', evidence: 'e', reason: 'round 1' },
      sources: ['lead'], roundOrigin: 1,
    }];
    const needsChanges = writePrior('prior-needs-changes.json', {
      ...wholePrior,
      canonicalVerdict: 'NEEDS CHANGES',
      findings: genuineFindings,
      convergence: { reviewScope: 'whole', coverageComplete: true },
    });
    const nativeNeedsChanges = {
      targetSha: h0, diffBaseSha: b0, reviewScope: 'whole', coverageComplete: true,
      blockers: 1, retainedFindings: 1,
      retainedFindingsSha256: createHash('sha256').update(JSON.stringify(genuineFindings)).digest('hex'),
    };
    expect(call(needsChanges, { nativeReceipt: nativeNeedsChanges }).scope).toBe('integration');
    const tampered = writePrior('prior-tampered-findings.json', {
      ...wholePrior, canonicalVerdict: 'NEEDS CHANGES', findings: [],
      convergence: { reviewScope: 'whole', coverageComplete: true },
    });
    const tamperedPlan = call(tampered, { nativeReceipt: nativeNeedsChanges });
    expect(tamperedPlan.scope).toBe('whole');
    expect(tamperedPlan.priorCoverageComplete).toBe(false);
  });
});

describe('prior carry-forward classification', () => {
  const priorFinding: VerifiedFinding = {
    source: 'lead',
    severity: 'blocker',
    category: 'correctness',
    title: 'carried defect',
    location: 'src/kept.ts:1',
    evidence: 'const stable = true;',
    detail: 'still wrong',
    recommended_fix: 'fix it',
    verification: { disposition: 'confirmed', evidence: 'const stable = true;', reason: 'round 1' },
    sources: ['lead'],
    roundOrigin: 1,
  };

  it('carries an untouched prior whose quoted evidence is unchanged', () => {
    const classifications = classifyPriorFindings({
      prior: [priorFinding],
      touchedPaths: new Set(['src/other.ts']),
      frozenBlobContains: (path, evidence) => path === 'src/kept.ts' && evidence === 'const stable = true;',
    });
    expect(classifications).toEqual([
      { priorIndex: 0, status: 'carried', reason: 'quoted evidence unchanged in the frozen tree and the cited file unchanged since the prior reviewed head' },
    ]);
  });

  it('re-verifies priors on a file the delta touched', () => {
    const classifications = classifyPriorFindings({
      prior: [priorFinding],
      touchedPaths: new Set(['src/kept.ts']),
      frozenBlobContains: () => true,
    });
    expect(classifications[0]!.status).toBe('reverify');
    expect(classifications[0]!.reason).toContain('changed since the prior reviewed head');
  });

  it('re-verifies priors the minion claimed fixed, before any other rule', () => {
    const classifications = classifyPriorFindings({
      prior: [priorFinding],
      touchedPaths: new Set(['src/other.ts']),
      claimedFixedPriors: [0],
      frozenBlobContains: () => true,
    });
    expect(classifications[0]).toEqual({ priorIndex: 0, status: 'reverify', reason: 'claimed fixed by the implementing minion' });
  });

  it('re-verifies a prior whose evidence cannot be confirmed unchanged', () => {
    const classifications = classifyPriorFindings({
      prior: [{ ...priorFinding, evidence: 'N/A' }],
      touchedPaths: new Set(['src/other.ts']),
      frozenBlobContains: () => true,
    });
    expect(classifications[0]!.status).toBe('reverify');
    expect(classifications[0]!.reason).toContain('could not be confirmed unchanged');
  });
});

describe('convergence partition and verdict mapping', () => {
  const finding = (overrides: Partial<{ location: string; severity: 'blocker' | 'warning' | 'note'; title: string }> = {}) => ({
    source: 'lead' as const,
    severity: 'blocker' as const,
    category: 'correctness',
    title: 'new defect',
    location: 'src/kept.ts:2',
    evidence: 'e',
    detail: 'd',
    recommended_fix: 'f',
    ...overrides,
  });

  const verified = (entry: ReturnType<typeof finding>) => ({
    ...entry,
    verification: { disposition: 'confirmed' as const, evidence: entry.evidence, reason: 'test' },
    sources: [entry.source],
    roundOrigin: 3,
  });

  it('defers findings outside the delta from the policy round and never before', () => {
    const hunks = parseDeltaHunks(['diff --git a/src/kept.ts b/src/kept.ts', '--- a/src/kept.ts', '+++ b/src/kept.ts', '@@ -1,3 +1,4 @@', ' const one = 1;', '+const two = 2;', ' const three = 3;', ''].join('\n'));
    const inside = verified(finding({ location: 'src/kept.ts:2' }));
    const outside = verified(finding({ location: 'src/untouched.ts:1', title: 'outside defect' }));
    const early = applyConvergenceDeferral({ roundNumber: 2, fromRound: 3, findings: [inside, outside], hunks });
    expect(early.deferred).toEqual([]);
    expect(early.findings.every((entry) => entry.deferredFollowup !== true)).toBe(true);
    const late = applyConvergenceDeferral({ roundNumber: 3, fromRound: 3, findings: [inside, outside], hunks });
    expect(late.deferred).toHaveLength(1);
    expect(late.deferred[0]!.finding.title).toBe('outside defect');
    expect(late.deferred[0]!.reason).toContain('cannot hold the PR');
    // The deferred finding is retained with the explicit flag; the
    // intersecting one keeps full blocking power.
    expect(late.findings.find((entry) => entry.title === 'outside defect')?.deferredFollowup).toBe(true);
    expect(late.findings.find((entry) => entry.title === 'new defect')?.deferredFollowup).toBeUndefined();
  });

  it('maps the converged blocker count with the standing policy mapping', () => {
    expect(convergedVerdict(0)).toBe('READY TO MERGE');
    expect(convergedVerdict(1)).toBe('NEEDS CHANGES');
    expect(convergedVerdict(3)).toBe('NEEDS CHANGES');
    expect(convergedVerdict(4)).toBe('MAJOR REWORK NEEDED');
  });
});

describe('review scope planning (final whole pass at a READY candidate)', () => {
  const TARGET = 'a'.repeat(40);
  const BASE = 'd'.repeat(40);
  const meta = (overrides: Partial<{ seq: number; reviewScope: 'whole' | 'delta' | 'integration' | 'unknown'; canonicalVerdict: string; targetSha: string; diffBaseSha: string }> = {}) => ({
    seq: 1,
    reviewScope: 'delta' as const,
    canonicalVerdict: 'NEEDS CHANGES',
    targetSha: TARGET,
    diffBaseSha: BASE,
    acceptance: null,
    coverageComplete: false,
    legacyWhole: false,
    findings: null,
    ...overrides,
  });
  const scope = (prior: ReturnType<typeof meta> | null, overrides: Partial<{ currentTargetSha: string; currentDiffBaseSha: string; finalWholePassAtReady: boolean; integrationLineage: { baseAdvanced: boolean; featureIntegrated: boolean; commonBasePinned: boolean; sameHeadAdoptedBase: boolean } | null; integrationCoverage: boolean; acceptanceCompatible: boolean }> = {}) => planReviewScope({
    prior,
    currentTargetSha: TARGET,
    currentDiffBaseSha: BASE,
    deltaRoundsFrom: 2,
    finalWholePassAtReady: true,
    acceptanceCompatible: true,
    ...overrides,
  });

  it('plans whole for a job with no prior and delta for a moved-target round after a prior', () => {
    expect(scope(null).scope).toBe('whole');
    // The normal fix-then-review case: target advanced, base unchanged.
    expect(scope(meta(), { currentTargetSha: 'c'.repeat(40) }).scope).toBe('delta');
    expect(scope(meta({ reviewScope: 'whole', canonicalVerdict: 'READY TO MERGE' }), { currentTargetSha: 'c'.repeat(40) }).scope).toBe('delta');
  });

  it('plans whole when nothing changed (same candidate) or the base moved without proven integration lineage', () => {
    // Same head + same base: there is no delta to review; a re-request is
    // a whole-change re-review.
    expect(scope(meta()).scope).toBe('whole');
    // A moved merge base with an advanced target but no integration lineage
    // stays whole and says why.
    const fallback = scope(meta(), { currentTargetSha: 'c'.repeat(40), currentDiffBaseSha: 'e'.repeat(40), integrationCoverage: true });
    expect(fallback.scope).toBe('whole');
    expect(fallback.reason).toContain('integration lineage could not be established');
  });

  it('retains coverage for a forward-integrated candidate and reviews the integration unit', () => {
    const integrated = scope(meta({ reviewScope: 'whole', canonicalVerdict: 'READY TO MERGE' }), {
      currentTargetSha: 'c'.repeat(40),
      currentDiffBaseSha: 'e'.repeat(40),
      integrationCoverage: true,
      integrationLineage: { baseAdvanced: true, featureIntegrated: true, commonBasePinned: true, sameHeadAdoptedBase: false },
    });
    expect(integrated.scope).toBe('integration');
    expect(integrated.reason).toContain('prior coverage retained');
  });

  it('falls back to whole when integration coverage is unsafe', () => {
    const baseMoved = { currentDiffBaseSha: 'e'.repeat(40), currentTargetSha: 'c'.repeat(40) } as const;
    // Rebased/rewritten feature head: the prior target is not an ancestor.
    expect(scope(meta(), { ...baseMoved, integrationCoverage: true,
      integrationLineage: { baseAdvanced: true, featureIntegrated: false, commonBasePinned: true, sameHeadAdoptedBase: false } }).scope).toBe('whole');
    // Rewritten base: B0 no longer descends into B1.
    expect(scope(meta(), { ...baseMoved, integrationCoverage: true,
      integrationLineage: { baseAdvanced: false, featureIntegrated: true, commonBasePinned: true, sameHeadAdoptedBase: false } }).scope).toBe('whole');
    // One side already contains the other: the pinned prior base is not shared.
    expect(scope(meta(), { ...baseMoved, integrationCoverage: true,
      integrationLineage: { baseAdvanced: true, featureIntegrated: true, commonBasePinned: false, sameHeadAdoptedBase: false } }).scope).toBe('whole');
    // Policy off.
    expect(scope(meta(), { ...baseMoved, integrationCoverage: false }).scope).toBe('whole');
    // The effective acceptance changed since the retained round.
    const acceptance = scope(meta(), { ...baseMoved, integrationCoverage: true, acceptanceCompatible: false,
      integrationLineage: { baseAdvanced: true, featureIntegrated: true, commonBasePinned: true, sameHeadAdoptedBase: false } });
    expect(acceptance.scope).toBe('whole');
    expect(acceptance.reason).toContain('effective acceptance changed');
    // An omitted/absent acceptance-compatibility never retains coverage.
    const omitted = planReviewScope({
      prior: meta(), currentTargetSha: 'c'.repeat(40), currentDiffBaseSha: 'e'.repeat(40),
      deltaRoundsFrom: 2, finalWholePassAtReady: true, integrationCoverage: true,
      integrationLineage: { baseAdvanced: true, featureIntegrated: true, commonBasePinned: true, sameHeadAdoptedBase: false },
    } as unknown as Parameters<typeof planReviewScope>[0]);
    expect(omitted.scope).toBe('whole');
    // A moved base with an UNCHANGED feature head is never an integration.
    expect(scope(meta(), { ...baseMoved, integrationCoverage: true, currentTargetSha: TARGET,
      integrationLineage: { baseAdvanced: true, featureIntegrated: true, commonBasePinned: true, sameHeadAdoptedBase: false } }).scope).toBe('whole');
  });

  it('plans the final whole pass exactly when a delta round posted READY', () => {
    expect(scope(meta({ canonicalVerdict: 'READY TO MERGE' }), { currentTargetSha: 'c'.repeat(40) }).scope).toBe('whole');
    expect(planReviewScope({
      prior: meta({ canonicalVerdict: 'READY TO MERGE' }),
      currentTargetSha: TARGET,
      currentDiffBaseSha: BASE,
      deltaRoundsFrom: 2,
      finalWholePassAtReady: false,
      acceptanceCompatible: true,
    }).scope).toBe('whole'); // same candidate still re-reviews whole; the flag only governs the moved-target case
    // A legacy (pre-Stage-5) prior record never triggers the final pass.
    expect(planReviewScope({
      prior: meta({ reviewScope: 'unknown', canonicalVerdict: 'READY TO MERGE' }),
      currentTargetSha: 'c'.repeat(40),
      currentDiffBaseSha: BASE,
      deltaRoundsFrom: 2,
      finalWholePassAtReady: true,
      acceptanceCompatible: true,
    }).scope).toBe('delta');
  });
});

describe('prior convergence meta read (tolerant)', () => {
  it('reads a complete v3 record and marks pre-Stage-5 records unknown', () => {
    const root = temp('perkins-meta-');
    const file = join(root, 'consolidated.json');
    const modern = {
      schemaVersion: 3,
      architecture: 'perkins-whole-pr',
      canonicalVerdict: 'READY TO MERGE',
      complete: true,
      headMoved: false,
      frozen: { targetSha: 'b'.repeat(40), diffBaseSha: 'd'.repeat(40) },
      convergence: { reviewScope: 'delta' },
    };
    writeFileSync(file, JSON.stringify(modern));
    expect(readPriorConvergenceMeta(file, 4)).toEqual({
      seq: 4, reviewScope: 'delta', canonicalVerdict: 'READY TO MERGE', targetSha: 'b'.repeat(40), diffBaseSha: 'd'.repeat(40), acceptance: null, coverageComplete: false, legacyWhole: false, findings: null,
    });
    writeFileSync(file, JSON.stringify({ ...modern, convergence: undefined }));
    expect(readPriorConvergenceMeta(file, 4)?.reviewScope).toBe('unknown');
    // A genuine pre-Stage-5 record WAS a whole review: whole-complete.
    expect(readPriorConvergenceMeta(file, 4)?.coverageComplete).toBe(true);
  });

  it('reads an integration record only when its immutable linkage is intact', () => {
    const root = temp('perkins-meta-integration-');
    const file = join(root, 'consolidated.json');
    const integrated = {
      schemaVersion: 3,
      architecture: 'perkins-whole-pr',
      canonicalVerdict: 'READY TO MERGE',
      complete: true,
      headMoved: false,
      frozen: { targetSha: 'b'.repeat(40), diffBaseSha: 'd'.repeat(40) },
      convergence: {
        reviewScope: 'integration', integrationFromSha: 'a'.repeat(40),
        integrationBaseSha: 'd'.repeat(40), integrationPriorDiffBase: 'a'.repeat(40),
      },
    };
    writeFileSync(file, JSON.stringify(integrated));
    expect(readPriorConvergenceMeta(file, 4)?.reviewScope).toBe('integration');
    // A damaged linkage is not inherited coverage: it reads as no record.
    writeFileSync(file, JSON.stringify({ ...integrated, convergence: { reviewScope: 'integration', integrationFromSha: 'a'.repeat(40) } }));
    expect(readPriorConvergenceMeta(file, 4)).toBeNull();
    // A non-hex linkage field is damaged.
    writeFileSync(file, JSON.stringify({ ...integrated, convergence: { ...integrated.convergence, integrationPriorDiffBase: 'nope' } }));
    expect(readPriorConvergenceMeta(file, 4)).toBeNull();
    // A valid same-head adoption linkage (the round integrated from the very
    // head it reviewed) is NOT damaged: the frozen target and the integration
    // source legitimately coincide, and the engine persists exactly that.
    writeFileSync(file, JSON.stringify({ ...integrated, convergence: { ...integrated.convergence, integrationFromSha: 'b'.repeat(40) } }));
    expect(readPriorConvergenceMeta(file, 4)?.reviewScope).toBe('integration');
  });

  it('fails closed on a present-but-malformed acceptance binding', () => {
    const root = temp('perkins-meta-acceptance-');
    const file = join(root, 'consolidated.json');
    const base = {
      schemaVersion: 3,
      architecture: 'perkins-whole-pr',
      canonicalVerdict: 'READY TO MERGE',
      complete: true,
      headMoved: false,
      frozen: { targetSha: 'b'.repeat(40), diffBaseSha: 'd'.repeat(40), acceptance: { version: 'nope', contractSha256: 'xyz' } },
      convergence: { reviewScope: 'whole', coverageComplete: true },
    };
    writeFileSync(file, JSON.stringify(base));
    expect(readPriorConvergenceMeta(file, 4)).toBeNull();
    // A PARTIAL binding (missing amendmentIds/baseSha256) is also damaged.
    writeFileSync(file, JSON.stringify({
      ...base, frozen: { ...base.frozen, acceptance: { version: 2, contractSha256: 'a'.repeat(64) } },
    }));
    expect(readPriorConvergenceMeta(file, 4)).toBeNull();
    // Each distinct malformed clause fails closed: non-hex baseSha256, a
    // non-string amendmentIds member, and a non-integer version.
    for (const acceptance of [
      { version: 2, baseSha256: 'xyz', contractSha256: 'a'.repeat(64), amendmentIds: [] },
      { version: 2, baseSha256: '', contractSha256: 'a'.repeat(64), amendmentIds: [1] },
      { version: 1.5, baseSha256: '', contractSha256: 'a'.repeat(64), amendmentIds: [] },
    ]) {
      writeFileSync(file, JSON.stringify({ ...base, frozen: { ...base.frozen, acceptance } }));
      expect(readPriorConvergenceMeta(file, 4)).toBeNull();
    }
    // A present, FULLY VALID binding parses and preserves the coverage bit.
    writeFileSync(file, JSON.stringify({
      ...base, frozen: { ...base.frozen, acceptance: { version: 2, baseSha256: '', contractSha256: 'a'.repeat(64), amendmentIds: [] } },
    }));
    const meta = readPriorConvergenceMeta(file, 4);
    expect(meta?.acceptance).toEqual({ version: 2, baseSha256: '', contractSha256: 'a'.repeat(64), amendmentIds: [] });
    expect(meta?.coverageComplete).toBe(true);
  });

  it('returns null for INCOMPLETE, incomplete, or damaged records', () => {
    const root = temp('perkins-meta-bad-');
    const file = join(root, 'consolidated.json');
    const modern = {
      schemaVersion: 3,
      architecture: 'perkins-whole-pr',
      canonicalVerdict: 'INCOMPLETE',
      complete: true,
      headMoved: false,
      frozen: { targetSha: 'c'.repeat(40), diffBaseSha: 'd'.repeat(40) },
    };
    writeFileSync(file, JSON.stringify(modern));
    expect(readPriorConvergenceMeta(file, 2)).toBeNull();
    writeFileSync(file, '{"broken":');
    expect(readPriorConvergenceMeta(file, 2)).toBeNull();
    expect(readPriorConvergenceMeta(join(root, 'missing.json'), 2)).toBeNull();
  });
});

describe('bundled policy carries the Stage-5 convergence rules with unchanged budgets', () => {
  it('pins the convergence thresholds and leaves every review budget untouched', () => {
    const policy = loadPerkinsPolicy();
    expect(policy.portableContract.rules.convergence).toEqual({
      deltaRoundsFrom: 2,
      convergenceRuleFromRound: 3,
      finalWholePassAtReady: true,
      carryForwardUntouchedPriors: true,
      integrationCoverage: true,
    });
    // Budgets unchanged: the convergence policy adds no attempts, lenses,
    // terminal submissions or specialist runs.
    expect(policy.portableContract.rules.maxLensAttempts).toBe(2);
    expect(policy.portableContract.rules.incompleteNeverApproves).toBe(true);
    expect(policy.portableContract.rules.fullLenses).toHaveLength(9);
    expect(policy.portableContract.leadWorkflow).toContain('DELTA ROUND');
    expect(policy.portableContract.leadWorkflow).toContain('CARRIED FORWARD');
    expect(policy.portableContract.leadWorkflow).toContain('CONVERGENCE RULE');
    expect(policy.portableContract.leadWorkflow).toContain('FINAL WHOLE PASS');
    expect(policy.portableContract.leadWorkflow).toContain('INTEGRATION ROUND');
  });
});

// ---------------------------------------------------------------------------
// Whole-review integration: delta rounds with carry-forward, the round-3
// convergence rule, and the final whole-change pass — through the REAL host
// validator with the scripted-lead double.
// ---------------------------------------------------------------------------

interface RoundHarness {
  readonly repo: FixtureRepo;
  readonly root: string;
  readonly engine: PerkinsWholeReview;
  readonly brain: WholeLeadOptions;
  readonly calls: ReturnType<typeof fakeWholeSpawner>['calls'];
  readonly leadCalls: ReturnType<typeof fakeWholeSpawner>['leadCalls'];
}

function makeEngine(brain: WholeLeadOptions): RoundHarness {
  const repo = makeFixtureRepo('perkins-convergence-round');
  repos.push(repo);
  repo.git(['checkout', '-b', 'feature/convergence']);
  const root = temp('perkins-convergence-artifacts-');
  const fake = fakeWholeSpawner(temp('perkins-convergence-sessions-'), brain);
  const engine = new PerkinsWholeReview({
    spawner: fake.spawner,
    policy: loadPerkinsPolicy(),
  });
  return { repo, root, engine, brain, calls: fake.calls, leadCalls: fake.leadCalls };
}

function freeze(
  harness: RoundHarness,
  input: { roundId: string; spec: string },
): FrozenReview {
  return freezeReviewInputs({
    roundId: input.roundId,
    repoPath: harness.repo.path,
    artifactRoot: harness.root,
    baseRef: harness.repo.git(['rev-parse', 'main']),
    targetRef: harness.repo.head(),
    movementRef: 'feature/convergence',
    spec: input.spec,
  });
}

function runRound(
  harness: RoundHarness,
  input: {
    roundId: string;
    roundNumber: number;
    frozen: FrozenReview;
    reviewScope?: 'whole' | 'delta';
    priorConsolidatedFile?: string;
    claimedFixedPriors?: readonly number[];
  },
): Promise<PerkinsWholeResult> {
  return harness.engine.run({
    roundId: input.roundId,
    roundNumber: input.roundNumber,
    frozenReview: input.frozen,
    movementRef: 'feature/convergence',
    noSpec: false,
    ...(input.reviewScope !== undefined ? { reviewScope: input.reviewScope } : {}),
    ...(input.priorConsolidatedFile !== undefined ? { priorConsolidatedFile: input.priorConsolidatedFile } : {}),
    ...(input.claimedFixedPriors !== undefined ? { claimedFixedPriors: input.claimedFixedPriors } : {}),
  });
}

describe('Stage-5 convergence over whole rounds', () => {
  it('carries an untouched prior forward without a lead disposition and reports the delta scope', async () => {
    const harness = makeEngine({
      childAnswer: () => '[]',
      specialists: [],
      leadFinding: groundedFinding('lead', 'warning', { location: 'src/main.ts:1', evidence: 'export function answer(): number {' }),
    });
    const target1 = harness.repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const frozen1 = freeze(harness, { roundId: 'conv-round-1', spec: 'return 43' });
    const round1 = await runRound(harness, { roundId: 'conv-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    expect(round1.canonicalVerdict).toBe('READY TO MERGE');
    const consolidated1 = join(reviewArtifactDirectory(harness.root, 'conv-round-1'), 'consolidated.json');

    // Round 2 changes a DIFFERENT file: the round-1 prior is untouched.
    harness.repo.commitFile('src/other.ts', 'export const other = 2;\nexport const more = 3;\n');
    const frozen2 = freeze(harness, { roundId: 'conv-round-2', spec: 'return 43' });
    const brain = harness.brain as { leadFinding?: unknown };
    delete brain.leadFinding;
    const round2 = await runRound(harness, {
      roundId: 'conv-round-2', roundNumber: 2, frozen: frozen2,
      reviewScope: 'delta', priorConsolidatedFile: consolidated1,
    });

    // The scripted lead saw the delta section, the carried list, and an
    // EMPTY revisit list — it dispositioned nothing.
    const prompt = harness.leadCalls.at(-1)!.prompt ?? '';
    expect(prompt).toContain('REVIEW SCOPE: DELTA ROUND');
    expect(prompt).toContain('DELTA SINCE LAST REVIEWED SHA');
    expect(prompt).toContain('From: ' + target1);
    expect(prompt).toContain('PRIOR FINDINGS CARRIED FORWARD');
    expect(prompt).toContain('--- PRIOR FINDINGS TO REVISIT ---\n[]');

    expect(round2.canonicalVerdict).toBe('READY TO MERGE');
    expect(round2.convergence).toMatchObject({ reviewScope: 'delta', carriedPriors: [0], reverifyPriors: [], deltaFromSha: target1 });
    expect(round2.convergence?.deferredFollowups).toBeUndefined();
    // A delta READY still owes the final whole-change pass: approval can
    // never be credited before a whole-scope round closes.
    expect(round2.convergence?.finalPassRequired).toBe(true);

    const consolidated2 = JSON.parse(readFileSync(join(round2.artifactDirectory, 'consolidated.json'), 'utf8')) as {
      canonicalVerdict: string;
      findings: Array<{ title: string; roundOrigin: number; deferredFollowup?: true }>;
      priorDispositions: Array<{ prior_index: number; status: string; note: string }>;
      convergence: { carriedPriors?: number[] };
    };
    // The carried finding is retained still-present with its ORIGINAL round
    // marker, never re-verified by the lead.
    const carried = consolidated2.findings.find((finding) => finding.title === 'lead grounded defect');
    expect(carried).toBeDefined();
    expect(carried!.roundOrigin).toBe(1);
    expect(carried!.deferredFollowup).toBeUndefined();
    expect(consolidated2.priorDispositions).toEqual([
      expect.objectContaining({
        prior_index: 0,
        status: 'still-present',
      }),
    ]);
    expect(consolidated2.priorDispositions[0]!.note).toContain('carried forward by the host');
    expect(consolidated2.convergence.carriedPriors).toEqual([0]);
  });

  it('re-verifies a prior whose file the delta touched or that the minion claimed fixed', async () => {
    const harness = makeEngine({
      childAnswer: () => '[]',
      specialists: [],
      leadFinding: groundedFinding('lead', 'warning', { location: 'src/main.ts:1', evidence: 'export function answer(): number {' }),
    });
    harness.repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const frozen1 = freeze(harness, { roundId: 'rv-round-1', spec: 'return 43' });
    await runRound(harness, { roundId: 'rv-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    const consolidated1 = join(reviewArtifactDirectory(harness.root, 'rv-round-1'), 'consolidated.json');

    // The delta touches the CITED file: the prior must be re-verified.
    harness.repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 44;\n}\n');
    const frozen2 = freeze(harness, { roundId: 'rv-round-2', spec: 'return 43' });
    const brain = harness.brain as { leadFinding?: unknown };
    delete brain.leadFinding;
    const round2 = await runRound(harness, {
      roundId: 'rv-round-2', roundNumber: 2, frozen: frozen2,
      reviewScope: 'delta', priorConsolidatedFile: consolidated1,
    });
    expect(round2.convergence).toMatchObject({ reviewScope: 'delta', reverifyPriors: [0] });
    expect(round2.convergence?.carriedPriors).toBeUndefined();
    // The scripted lead dispositioned the revisiting prior (its default).
    expect(round2.priorDispositions).toHaveLength(1);
    expect(round2.priorDispositions[0]).toMatchObject({ prior_index: 0, status: 'still-present' });
    const prompt = harness.leadCalls.at(-1)!.prompt ?? '';
    expect(prompt).not.toContain('PRIOR FINDINGS CARRIED FORWARD');
    expect(prompt).toContain('"prior_index": 0');

    // A claimed-fixed prior is re-verified even when its file is untouched.
    harness.repo.commitFile('src/untouched.ts', 'export const untouched = 1;\n');
    const frozen3 = freeze(harness, { roundId: 'rv-round-3', spec: 'return 43' });
    const round3 = await runRound(harness, {
      roundId: 'rv-round-3', roundNumber: 3, frozen: frozen3,
      reviewScope: 'delta', priorConsolidatedFile: join(round2.artifactDirectory, 'consolidated.json'),
      claimedFixedPriors: [0],
    });
    expect(round3.convergence).toMatchObject({ reviewScope: 'delta', reverifyPriors: [0] });
    expect(round3.convergence?.carriedPriors).toBeUndefined();
  });

  it('defers a round-3 blocker outside the delta and recomputes the verdict to READY', async () => {
    const harness = makeEngine({
      childAnswer: () => '[]',
      specialists: [],
      leadFinding: groundedFinding('lead', 'warning', { location: 'src/main.ts:1', evidence: 'export function answer(): number {' }),
    });
    harness.repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const frozen1 = freeze(harness, { roundId: 'df-round-1', spec: 'return 43' });
    await runRound(harness, { roundId: 'df-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    const consolidated1 = join(reviewArtifactDirectory(harness.root, 'df-round-1'), 'consolidated.json');

    harness.repo.commitFile('src/other.ts', 'export const other = 2;\n');
    const frozen2 = freeze(harness, { roundId: 'df-round-2', spec: 'return 43' });
    const brain = harness.brain as { leadFinding?: unknown; verdictOverride?: string };
    delete brain.leadFinding;
    const round2 = await runRound(harness, {
      roundId: 'df-round-2', roundNumber: 2, frozen: frozen2,
      reviewScope: 'delta', priorConsolidatedFile: consolidated1,
    });
    expect(round2.canonicalVerdict).toBe('READY TO MERGE');

    // Round 3: the lead raises ONE new blocker on untouched code and —
    // counting it — submits NEEDS CHANGES. The host defers it as a
    // follow-up and recomputes the canonical verdict to READY.
    harness.repo.commitFile('src/third.ts', 'export const third = 3;\n');
    const frozen3 = freeze(harness, { roundId: 'df-round-3', spec: 'return 43' });
    brain.verdictOverride = 'NEEDS CHANGES';
    brain.leadFinding = groundedFinding('lead', 'blocker', { location: 'src/main.ts:1', title: 'untouched new defect' });
    const round3 = await runRound(harness, {
      roundId: 'df-round-3', roundNumber: 3, frozen: frozen3,
      reviewScope: 'delta', priorConsolidatedFile: join(round2.artifactDirectory, 'consolidated.json'),
    });
    expect(round3.canonicalVerdict).toBe('READY TO MERGE');
    expect(round3.convergence).toMatchObject({
      reviewScope: 'delta',
      verdictRecomputed: { from: 'NEEDS CHANGES', to: 'READY TO MERGE' },
    });
    expect(round3.convergence?.deferredFollowups).toHaveLength(2);
    expect(round3.convergence?.deferredFollowups?.find((entry) => entry.title === 'untouched new defect'))
      .toMatchObject({ severity: 'blocker' });

    const consolidated3 = JSON.parse(readFileSync(join(round3.artifactDirectory, 'consolidated.json'), 'utf8')) as {
      canonicalVerdict: string;
      submittedVerdict: string;
      findings: Array<{ title: string; deferredFollowup?: true; verification: { reason: string } }>;
    };
    expect(consolidated3.submittedVerdict).toBe('NEEDS CHANGES');
    expect(consolidated3.canonicalVerdict).toBe('READY TO MERGE');
    const deferred = consolidated3.findings.find((finding) => finding.title === 'untouched new defect');
    expect(deferred!.deferredFollowup).toBe(true);
    // The lead's original verification reason stays untouched: the deferral
    // is carried by the flag and the convergence record below (a later pass
    // that re-activates the finding carries no stale "cannot hold" note).
    expect(deferred!.verification.reason).toBe('retained by the lead after whole-change verification');
    // The published report headline matches the recorded canonical verdict
    // and discloses the host recomputation; the lead's submitted bytes stay
    // preserved in the submission artifact.
    const published = readFileSync(join(round3.artifactDirectory, 'perkins-report.md'), 'utf8');
    expect(published).toContain('**Verdict: READY TO MERGE**');
    expect(published).not.toContain('**Verdict: NEEDS CHANGES**');
    expect(published).toContain('Host convergence');
    const submitted = JSON.parse(readFileSync(
      join(round3.artifactDirectory, 'lead', 'submission-attempt-1.json'), 'utf8',
    )) as { verdict: string; report_markdown: string };
    expect(submitted.verdict).toBe('NEEDS CHANGES');
    expect(submitted.report_markdown).toContain('**Verdict: NEEDS CHANGES**');
  });

  it('never carries a valid-but-undelivered lens result into the next round', async () => {
    const harness = makeEngine({ childAnswer: () => '[]', specialists: ['blind', 'edge'] });
    harness.repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const frozen1 = freeze(harness, { roundId: 'ud-round-1', spec: 'return 43' });
    const round1 = await runRound(harness, { roundId: 'ud-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    // Mark the blind run undelivered in a copied prior record: its result
    // never reached a lead, so it cannot be credited as coverage.
    const consolidated1 = join(reviewArtifactDirectory(harness.root, 'ud-round-1'), 'consolidated.json');
    const record = JSON.parse(readFileSync(consolidated1, 'utf8')) as Record<string, unknown>;
    const runs = (record['specialistRuns'] as Array<Record<string, unknown>>).map((run) =>
      run['lens'] === 'blind' ? { ...run, findingsDelivered: false } : run);
    const rewritten = join(harness.root, 'ud-prior-undelivered.json');
    writeFileSync(rewritten, JSON.stringify({ ...record, specialistRuns: runs }));

    harness.repo.commitFile('src/other.ts', 'export const other = 2;\n');
    const frozen2 = freeze(harness, { roundId: 'ud-round-2', spec: 'return 43' });
    (harness.brain as { specialists?: readonly string[] }).specialists = [];
    const round2 = await runRound(harness, {
      roundId: 'ud-round-2', roundNumber: 2, frozen: frozen2,
      reviewScope: 'delta', priorConsolidatedFile: rewritten,
    });
    expect(round2.convergence?.carriedLenses).toEqual(['edge']);
    expect(harness.leadCalls.at(-1)!.prompt ?? '').toContain('PRIOR LENS RESULTS CARRIED (edge)');
    expect(harness.leadCalls.at(-1)!.prompt ?? '').not.toContain('PRIOR LENS RESULTS CARRIED (blind');
    expect(round1.convergence).toMatchObject({ reviewScope: 'whole' });
  });

  it('strips a stale deferral when a later whole-change pass re-retains the blocker', async () => {
    const harness = makeEngine({
      childAnswer: () => '[]',
      specialists: [],
      leadFinding: groundedFinding('lead', 'warning', { location: 'src/main.ts:1', evidence: 'export function answer(): number {' }),
    });
    harness.repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const frozen1 = freeze(harness, { roundId: 'sd-round-1', spec: 'return 43' });
    await runRound(harness, { roundId: 'sd-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    const consolidated1 = join(reviewArtifactDirectory(harness.root, 'sd-round-1'), 'consolidated.json');

    harness.repo.commitFile('src/other.ts', 'export const other = 2;\n');
    const frozen2 = freeze(harness, { roundId: 'sd-round-2', spec: 'return 43' });
    const brain = harness.brain as { leadFinding?: unknown; verdictOverride?: string };
    delete brain.leadFinding;
    await runRound(harness, {
      roundId: 'sd-round-2', roundNumber: 2, frozen: frozen2,
      reviewScope: 'delta', priorConsolidatedFile: consolidated1,
    });

    // Round 3 defers a new blocker on untouched code.
    harness.repo.commitFile('src/third.ts', 'export const third = 3;\n');
    const frozen3 = freeze(harness, { roundId: 'sd-round-3', spec: 'return 43' });
    brain.verdictOverride = 'NEEDS CHANGES';
    brain.leadFinding = groundedFinding('lead', 'blocker', { location: 'src/main.ts:1', title: 'deferred then re-retained' });
    const round3 = await runRound(harness, {
      roundId: 'sd-round-3', roundNumber: 3, frozen: frozen3,
      reviewScope: 'delta', priorConsolidatedFile: join(reviewArtifactDirectory(harness.root, 'sd-round-2'), 'consolidated.json'),
    });
    expect(round3.canonicalVerdict).toBe('READY TO MERGE');
    expect(round3.convergence?.finalPassRequired).toBe(true);
    // Both the new blocker and the carried warning sit outside this delta.
    expect(round3.convergence?.deferredFollowups).toHaveLength(2);

    // The final whole-change pass re-retains the deferred blocker: the old
    // deferral flag must NOT keep it out of the counts.
    delete brain.leadFinding;
    delete brain.verdictOverride;
    const frozen4 = freeze(harness, { roundId: 'sd-round-4', spec: 'return 43' });
    const round4 = await runRound(harness, {
      roundId: 'sd-round-4', roundNumber: 4, frozen: frozen4,
      reviewScope: 'whole', priorConsolidatedFile: join(round3.artifactDirectory, 'consolidated.json'),
    });
    expect(round4.canonicalVerdict).toBe('NEEDS CHANGES');
    expect(round4.convergence).toMatchObject({ reviewScope: 'whole' });
    expect(round4.convergence?.deferredFollowups).toBeUndefined();
    const consolidated4 = JSON.parse(readFileSync(join(round4.artifactDirectory, 'consolidated.json'), 'utf8')) as {
      findings: Array<{ title: string; deferredFollowup?: true; severity: string; sources: string[] }>;
    };
    const retained = consolidated4.findings.find((finding) => finding.title === 'deferred then re-retained');
    expect(retained).toBeDefined();
    expect(retained!.deferredFollowup).toBeUndefined();
    expect(round4.convergence?.finalPassRequired).toBeUndefined();
  });

  it('carries prior lens results with no open finding and offers them to the lead', async () => {
    const harness = makeEngine({ childAnswer: () => '[]', specialists: ['blind', 'edge'] });
    harness.repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const frozen1 = freeze(harness, { roundId: 'cl-round-1', spec: 'return 43' });
    await runRound(harness, { roundId: 'cl-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    const consolidated1 = join(reviewArtifactDirectory(harness.root, 'cl-round-1'), 'consolidated.json');

    harness.repo.commitFile('src/other.ts', 'export const other = 2;\n');
    const frozen2 = freeze(harness, { roundId: 'cl-round-2', spec: 'return 43' });
    (harness.brain as { specialists?: readonly string[] }).specialists = [];
    const round2 = await runRound(harness, {
      roundId: 'cl-round-2', roundNumber: 2, frozen: frozen2,
      reviewScope: 'delta', priorConsolidatedFile: consolidated1,
    });
    const prompt = harness.leadCalls.at(-1)!.prompt ?? '';
    expect(prompt).toContain('PRIOR LENS RESULTS CARRIED (blind, edge)');
    expect(round2.convergence?.carriedLenses).toEqual(['blind', 'edge']);
    const consolidated2 = JSON.parse(readFileSync(join(round2.artifactDirectory, 'consolidated.json'), 'utf8')) as {
      convergence: { carriedLenses?: string[] };
    };
    expect(consolidated2.convergence.carriedLenses).toEqual(['blind', 'edge']);

    // A second skipped round keeps the credit: the carry is re-derived from
    // the prior convergence record even though the lens has no fresh run.
    harness.repo.commitFile('src/third.ts', 'export const third = 3;\n');
    const frozen3 = freeze(harness, { roundId: 'cl-round-3', spec: 'return 43' });
    const round3 = await runRound(harness, {
      roundId: 'cl-round-3', roundNumber: 3, frozen: frozen3,
      reviewScope: 'delta', priorConsolidatedFile: join(round2.artifactDirectory, 'consolidated.json'),
    });
    expect(harness.leadCalls.at(-1)!.prompt ?? '').toContain('PRIOR LENS RESULTS CARRIED (blind, edge)');
    expect(round3.convergence?.carriedLenses).toEqual(['blind', 'edge']);
  });

  it('keeps an intersecting round-3 blocker holding the PR', async () => {
    const harness = makeEngine({
      childAnswer: () => '[]',
      specialists: [],
      leadFinding: groundedFinding('lead', 'warning', { location: 'src/main.ts:1', evidence: 'export function answer(): number {' }),
    });
    harness.repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const frozen1 = freeze(harness, { roundId: 'in-round-1', spec: 'return 43' });
    await runRound(harness, { roundId: 'in-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    const consolidated1 = join(reviewArtifactDirectory(harness.root, 'in-round-1'), 'consolidated.json');

    harness.repo.commitFile('src/other.ts', 'export const other = 2;\nexport const more = 3;\n');
    const frozen2 = freeze(harness, { roundId: 'in-round-2', spec: 'return 43' });
    const brain = harness.brain as { leadFinding?: unknown; verdictOverride?: string };
    delete brain.leadFinding;
    await runRound(harness, {
      roundId: 'in-round-2', roundNumber: 2, frozen: frozen2,
      reviewScope: 'delta', priorConsolidatedFile: consolidated1,
    });

    // A new blocker INSIDE this round's delta hunks still blocks.
    harness.repo.commitFile('src/untouched-second.ts', 'export const untouched = 1;\n');
    const frozen3 = freeze(harness, { roundId: 'in-round-3', spec: 'return 43' });
    brain.verdictOverride = 'NEEDS CHANGES';
    brain.leadFinding = groundedFinding('lead', 'blocker', { location: 'src/untouched-second.ts:1', title: 'delta new defect' });
    const round3 = await runRound(harness, {
      roundId: 'in-round-3', roundNumber: 3, frozen: frozen3,
      reviewScope: 'delta', priorConsolidatedFile: join(reviewArtifactDirectory(harness.root, 'in-round-2'), 'consolidated.json'),
    });
    expect(round3.canonicalVerdict).toBe('NEEDS CHANGES');
    // The carried warning on untouched code is itself deferred, but the
    // intersecting blocker keeps its hold.
    expect(round3.convergence?.deferredFollowups).toHaveLength(1);
    expect(round3.convergence?.deferredFollowups?.[0]).toMatchObject({ severity: 'warning' });
    expect(round3.convergence?.verdictRecomputed).toBeUndefined();
    const consolidated3 = JSON.parse(readFileSync(join(round3.artifactDirectory, 'consolidated.json'), 'utf8')) as {
      findings: Array<{ title: string; deferredFollowup?: true }>;
    };
    const retained = consolidated3.findings.find((finding) => finding.title === 'delta new defect');
    expect(retained!.deferredFollowup).toBeUndefined();
  });

  it('runs the final whole-change pass without delta scoping or convergence deferral', async () => {
    const harness = makeEngine({
      childAnswer: () => '[]',
      specialists: [],
      leadFinding: groundedFinding('lead', 'warning', { location: 'src/main.ts:1', evidence: 'export function answer(): number {' }),
    });
    harness.repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const frozen1 = freeze(harness, { roundId: 'fp-round-1', spec: 'return 43' });
    await runRound(harness, { roundId: 'fp-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    const consolidated1 = join(reviewArtifactDirectory(harness.root, 'fp-round-1'), 'consolidated.json');

    harness.repo.commitFile('src/other.ts', 'export const other = 2;\n');
    const frozen2 = freeze(harness, { roundId: 'fp-round-2', spec: 'return 43' });
    const brain = harness.brain as { leadFinding?: unknown };
    delete brain.leadFinding;
    const round2 = await runRound(harness, {
      roundId: 'fp-round-2', roundNumber: 2, frozen: frozen2,
      reviewScope: 'delta', priorConsolidatedFile: consolidated1,
    });
    expect(round2.canonicalVerdict).toBe('READY TO MERGE');

    // The final whole pass: whole scope with a prior — every prior is
    // revisited, no delta section, and a new blocker anywhere holds the PR.
    const frozen3 = freeze(harness, { roundId: 'fp-round-3', spec: 'return 43' });
    brain.leadFinding = groundedFinding('lead', 'blocker', { location: 'src/main.ts:2', title: 'whole-pass defect' });
    const round3 = await runRound(harness, {
      roundId: 'fp-round-3', roundNumber: 3, frozen: frozen3,
      reviewScope: 'whole', priorConsolidatedFile: join(round2.artifactDirectory, 'consolidated.json'),
    });
    const prompt = harness.leadCalls.at(-1)!.prompt ?? '';
    expect(prompt).toContain('REVIEW SCOPE: WHOLE CHANGE');
    expect(prompt).toContain('standing whole-change authority');
    expect(prompt).not.toContain('DELTA SINCE LAST REVIEWED SHA');
    expect(prompt).not.toContain('CARRIED FORWARD');
    expect(round3.canonicalVerdict).toBe('NEEDS CHANGES');
    expect(round3.convergence).toMatchObject({ reviewScope: 'whole' });
    expect(round3.convergence?.reverifyPriors).toBeUndefined();
    expect(round3.convergence?.deferredFollowups).toBeUndefined();
    const consolidated3 = JSON.parse(readFileSync(join(round3.artifactDirectory, 'consolidated.json'), 'utf8')) as {
      findings: Array<{ title: string; deferredFollowup?: true }>;
    };
    expect(consolidated3.findings.find((finding) => finding.title === 'whole-pass defect')?.deferredFollowup).toBeUndefined();
  });

  it('rejects a lead disposition on a host-carried prior (coverage stays honest)', async () => {
    const harness = makeEngine({
      childAnswer: () => '[]',
      specialists: [],
      leadFinding: groundedFinding('lead', 'warning', { location: 'src/main.ts:1', evidence: 'export function answer(): number {' }),
    });
    harness.repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const frozen1 = freeze(harness, { roundId: 'cj-round-1', spec: 'return 43' });
    await runRound(harness, { roundId: 'cj-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    const consolidated1 = join(reviewArtifactDirectory(harness.root, 'cj-round-1'), 'consolidated.json');

    harness.repo.commitFile('src/other.ts', 'export const other = 2;\n');
    const frozen2 = freeze(harness, { roundId: 'cj-round-2', spec: 'return 43' });
    const brain = harness.brain as { leadFinding?: unknown; priorDisposition?: unknown };
    delete brain.leadFinding;
    // The scripted lead wrongly dispositions the carried prior: the host
    // must refuse the submission (the carried judgment is the host's).
    brain.priorDisposition = () => [{ prior_index: 0, status: 'still-present' as const, note: 'lead insists' }];
    await expect(runRound(harness, {
      roundId: 'cj-round-2', roundNumber: 2, frozen: frozen2,
      reviewScope: 'delta', priorConsolidatedFile: consolidated1,
    })).rejects.toThrow(/prior finding 0 is carried forward by the host/u);
    // The lead was shown the carried list it must not disposition.
    expect(harness.leadCalls.at(-1)!.prompt ?? '').toContain('PRIOR FINDINGS CARRIED FORWARD');
  });

});
