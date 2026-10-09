import { readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freezeReviewInputs, reviewArtifactDirectory, type FrozenReview } from '../src/dispatch/perkins-review/artifacts.js';
import { loadPerkinsPolicy } from '../src/dispatch/perkins-review/policy.js';
import { PerkinsWholeReview, type PerkinsWholeResult } from '../src/dispatch/perkins-review/whole.js';
import { fakeWholeSpawner, groundedFinding, type WholeLeadOptions } from './helpers/perkins-whole-double.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';

/**
 * Native integration review with retained prior coverage — exercised through
 * the REAL host validator with the scripted-lead double and local Git
 * fixtures. These tests use only the public engine surface that exists before
 * the feature, so they fail on baseline 32fc2f6 as ASSERTIONS (a round
 * planned 'integration' that actually ran 'whole'), never as import/setup
 * errors.
 */

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

interface IntegrationHarness {
  readonly repo: FixtureRepo;
  readonly root: string;
  readonly engine: PerkinsWholeReview;
  readonly brain: WholeLeadOptions;
  readonly leadCalls: ReturnType<typeof fakeWholeSpawner>['leadCalls'];
}

function makeEngine(brain: WholeLeadOptions): IntegrationHarness {
  const repo = makeFixtureRepo('perkins-integration-round');
  repos.push(repo);
  repo.git(['config', 'user.name', 'Fixture Tests']);
  repo.git(['config', 'user.email', 'tests@example.invalid']);
  const root = temp('perkins-integration-artifacts-');
  const fake = fakeWholeSpawner(temp('perkins-integration-sessions-'), brain);
  const engine = new PerkinsWholeReview({ spawner: fake.spawner, policy: loadPerkinsPolicy() });
  return { repo, root, engine, brain, leadCalls: fake.leadCalls };
}

function freeze(harness: IntegrationHarness, roundId: string, target: string): FrozenReview {
  return freezeReviewInputs({
    roundId,
    repoPath: harness.repo.path,
    artifactRoot: harness.root,
    baseRef: harness.repo.git(['rev-parse', 'main']),
    targetRef: target,
    movementRef: 'feature/integration',
    spec: 'integration fixture',
  });
}

function runRound(
  harness: IntegrationHarness,
  input: { roundId: string; roundNumber: number; frozen: FrozenReview; reviewScope?: 'whole' | 'delta' | 'integration'; priorConsolidatedFile?: string },
): Promise<PerkinsWholeResult> {
  return harness.engine.run({
    roundId: input.roundId,
    roundNumber: input.roundNumber,
    frozenReview: input.frozen,
    movementRef: 'feature/integration',
    noSpec: false,
    ...(input.reviewScope !== undefined ? { reviewScope: input.reviewScope } : {}),
    ...(input.priorConsolidatedFile !== undefined ? { priorConsolidatedFile: input.priorConsolidatedFile } : {}),
  });
}

/** Round 1's world: the feature head H0 on the pinned base B0, BEFORE main
 * advances (so the movement ref still points at H0). */
function featureHead(repo: FixtureRepo, file: string, content: string): { readonly b0: string; readonly h0: string } {
  const b0 = repo.head();
  repo.git(['checkout', '-b', 'feature/integration']);
  const h0 = repo.commitFile(file, content);
  return { b0, h0 };
}

/** Main advances to B1 (touching only its own file) and the feature merges it
 * cleanly into H1: no conflict resolution. */
function integrateClean(repo: FixtureRepo): { readonly b1: string; readonly h1: string } {
  repo.git(['checkout', 'main']);
  const b1 = repo.commitFile('src/mainonly.ts', 'export const mainonly = 1;\n');
  repo.git(['checkout', 'feature/integration']);
  repo.git(['merge', '--no-ff', '-m', 'merge main', 'main']);
  return { b1, h1: repo.head() };
}

/** Main advances to B1 changing the SAME shared file; the merge conflicts and
 * the resolution is committed into H1. */
function integrateConflict(repo: FixtureRepo): { readonly b1: string; readonly h1: string } {
  repo.git(['checkout', 'main']);
  repo.commitFile('src/mainonly.ts', 'export const mainonly = 1;\n');
  const b1 = repo.commitFile('src/shared.ts', 'export const shared = "main";\n');
  repo.git(['checkout', 'feature/integration']);
  expect(() => repo.git(['merge', 'main'])).toThrow();
  writeFileSync(join(repo.path, 'src', 'shared.ts'), 'export const shared = "resolved";\n');
  repo.git(['add', 'src/shared.ts']);
  repo.git(['commit', '-m', 'resolve shared']);
  return { b1, h1: repo.head() };
}

describe('native integration review retains prior coverage', () => {
  it('reviews the integration work, retains the feature coverage, and does not restart a whole review', async () => {
    const harness = makeEngine({
      childAnswer: () => '[]',
      specialists: [],
      leadFinding: groundedFinding('lead', 'warning', { title: 'round1 feature warning', location: 'src/feature.ts:1', evidence: 'export const feature = 1;' }),
    });
    const { h0 } = featureHead(harness.repo, 'src/feature.ts', 'export const feature = 1;\n');

    // Round 1: the ordinary whole review of the feature head H0 on B0.
    const frozen1 = freeze(harness, 'int-round-1', h0);
    const round1 = await runRound(harness, { roundId: 'int-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    expect(round1.canonicalVerdict).toBe('READY TO MERGE');
    const consolidated1 = join(reviewArtifactDirectory(harness.root, 'int-round-1'), 'consolidated.json');

    // Main advances and the feature integrates it cleanly into H1.
    const { b1, h1 } = integrateClean(harness.repo);
    const brain = harness.brain as { leadFinding?: unknown };
    delete brain.leadFinding;
    const frozen2 = freeze(harness, 'int-round-2', h1);
    const round2 = await runRound(harness, {
      roundId: 'int-round-2', roundNumber: 2, frozen: frozen2,
      reviewScope: 'integration', priorConsolidatedFile: consolidated1,
    });

    const prompt = harness.leadCalls.at(-1)!.prompt ?? '';
    expect(prompt).toContain('REVIEW SCOPE: INTEGRATION ROUND');
    expect(prompt).toContain('--- INTEGRATION UNIT (new integration/conflict-resolution work) ---');
    expect(prompt).not.toContain('REVIEW SCOPE: WHOLE CHANGE');

    expect(round2.convergence).toMatchObject({
      reviewScope: 'integration',
      integrationFromSha: h0,
      integrationBaseSha: b1,
    });
    expect(round2.convergence?.integrationAutoMergeTree).toMatch(/^[0-9a-f]{40}$/u);
    // The unchanged feature finding is retained (host-carried), not re-litigated.
    expect(round2.convergence?.carriedPriors).toEqual([0]);
    // A clean integration has no conflict-resolution unit: incoming base-only
    // file src/mainonly.ts is NOT presented as new PR work.
    const unit = readFileSync(join(round2.artifactDirectory, 'integration-delta.patch'), 'utf8');
    expect(unit).toBe('');
    expect(unit).not.toContain('mainonly');
    // Whole-complete retained coverage: the integration READY binds H1 with
    // NO chained whole-PR pass over the same covered work.
    expect(round2.convergence?.finalPassRequired).toBeUndefined();
    expect(round2.canonicalVerdict).toBe('READY TO MERGE');
  });

  it('reviews an actual conflict resolution and keeps a boundary defect blocking across the resolution hunk', async () => {
    const harness = makeEngine({
      childAnswer: () => '[]',
      specialists: [],
      leadFinding: groundedFinding('lead', 'warning', { title: 'round1 shared warning', location: 'src/shared.ts:1', evidence: 'export const shared = "feature";' }),
    });
    const { h0 } = featureHead(harness.repo, 'src/shared.ts', 'export const shared = "feature";\n');

    const frozen1 = freeze(harness, 'ci-round-1', h0);
    const round1 = await runRound(harness, { roundId: 'ci-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    expect(round1.canonicalVerdict).toBe('READY TO MERGE');
    const consolidated1 = join(reviewArtifactDirectory(harness.root, 'ci-round-1'), 'consolidated.json');

    const { h1 } = integrateConflict(harness.repo);
    // The integration round raises a blocker whose evidence is on the
    // resolution: the old delta-convergence deferral must not silently
    // exempt it, and the resolution is inside the integration unit.
    const brain = harness.brain as { leadFinding?: unknown };
    brain.leadFinding = groundedFinding('lead', 'blocker', {
      title: 'integration boundary defect', location: 'src/shared.ts:1', evidence: 'export const shared = "resolved";',
    });
    const frozen2 = freeze(harness, 'ci-round-2', h1);
    const round2 = await runRound(harness, {
      roundId: 'ci-round-2', roundNumber: 2, frozen: frozen2,
      reviewScope: 'integration', priorConsolidatedFile: consolidated1,
    });

    expect(round2.convergence?.reviewScope).toBe('integration');
    // The resolution is the review unit; the main-only incoming file is not.
    const unit = readFileSync(join(round2.artifactDirectory, 'integration-delta.patch'), 'utf8');
    expect(unit).toContain('src/shared.ts');
    expect(unit).not.toContain('mainonly');
    expect(round2.convergence?.deferredFollowups).toBeUndefined();
    expect(round2.canonicalVerdict).toBe('NEEDS CHANGES');
  });

  it('still owes the final whole pass when the retained prior coverage is only partial', async () => {
    const harness = makeEngine({ childAnswer: () => '[]', specialists: [] });
    const { h0 } = featureHead(harness.repo, 'src/feature.ts', 'export const feature = 1;\n');

    const frozen1 = freeze(harness, 'pc-round-1', h0);
    const round1 = await runRound(harness, { roundId: 'pc-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    expect(round1.canonicalVerdict).toBe('READY TO MERGE');
    const consolidated1 = join(reviewArtifactDirectory(harness.root, 'pc-round-1'), 'consolidated.json');
    // Simulate a prior round whose own coverage was PARTIAL (a delta round):
    // the retained coverage cannot certify the whole candidate, so the
    // integration READY must still chain the final whole pass.
    const record = JSON.parse(readFileSync(consolidated1, 'utf8')) as { convergence: { reviewScope: string } };
    record.convergence.reviewScope = 'delta';
    const partial = join(harness.root, 'pc-partial.json');
    writeFileSync(partial, JSON.stringify(record));

    const { h1 } = integrateClean(harness.repo);
    const frozen2 = freeze(harness, 'pc-round-2', h1);
    const round2 = await runRound(harness, {
      roundId: 'pc-round-2', roundNumber: 2, frozen: frozen2,
      reviewScope: 'integration', priorConsolidatedFile: partial,
    });
    expect(round2.convergence).toMatchObject({ reviewScope: 'integration', finalPassRequired: true });
  });
});
