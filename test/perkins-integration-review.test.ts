import { readFileSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  readonly childCalls: ReturnType<typeof fakeWholeSpawner>['childCalls'];
}

function makeEngine(brain: WholeLeadOptions): IntegrationHarness {
  const repo = makeFixtureRepo('perkins-integration-round');
  repos.push(repo);
  repo.git(['config', 'user.name', 'Fixture Tests']);
  repo.git(['config', 'user.email', 'tests@example.invalid']);
  const root = temp('perkins-integration-artifacts-');
  const fake = fakeWholeSpawner(temp('perkins-integration-sessions-'), brain);
  const engine = new PerkinsWholeReview({ spawner: fake.spawner, policy: loadPerkinsPolicy() });
  return { repo, root, engine, brain, leadCalls: fake.leadCalls, childCalls: fake.childCalls };
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

/** Main advances by one file and the feature merges it cleanly into a new
 * integration head. */
function integrateClean(repo: FixtureRepo, file = 'src/mainonly.ts', content = 'export const mainonly = 1;\n'): { readonly b1: string; readonly h1: string } {
  repo.git(['checkout', 'main']);
  const b1 = repo.commitFile(file, content);
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

/** The conflict resolution takes the incoming base verbatim, discarding the
 * feature's change on the shared path. */
function integrateConflictTakingBase(repo: FixtureRepo): { readonly b1: string; readonly h1: string } {
  repo.git(['checkout', 'main']);
  const b1 = repo.commitFile('src/shared.ts', 'export const shared = "main";\n');
  repo.git(['checkout', 'feature/integration']);
  expect(() => repo.git(['merge', 'main'])).toThrow();
  writeFileSync(join(repo.path, 'src', 'shared.ts'), 'export const shared = "main";\n');
  repo.git(['add', 'src/shared.ts']);
  repo.git(['commit', '-m', 'resolve shared (take main)']);
  return { b1, h1: repo.head() };
}

describe('native integration review retains prior coverage', () => {
  it('reviews the integration work, retains the feature coverage, and does not restart a whole review', async () => {
    const harness = makeEngine({
      childAnswer: () => '[]',
      specialists: [],
      leadFinding: groundedFinding('lead', 'warning', { title: 'round1 feature warning', location: 'src/feature.ts:1', evidence: 'export const feature = 1;' }),
    });
    const { b0, h0 } = featureHead(harness.repo, 'src/feature.ts', 'export const feature = 1;\n');

    // Round 1: the ordinary whole review of the feature head H0 on B0.
    const frozen1 = freeze(harness, 'int-round-1', h0);
    const round1 = await runRound(harness, { roundId: 'int-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    expect(round1.canonicalVerdict).toBe('READY TO MERGE');
    // A whole round records durable whole-candidate coverage.
    expect(round1.convergence?.coverageComplete).toBe(true);
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
    expect(prompt).toContain('The retained coverage is whole-complete');
    expect(prompt).not.toContain('REVIEW SCOPE: WHOLE CHANGE');

    expect(round2.convergence).toMatchObject({
      reviewScope: 'integration',
      integrationFromSha: h0,
      integrationBaseSha: b1,
      integrationPriorDiffBase: b0,
    });
    expect(round2.convergence?.integrationDeltaSha256).toMatch(/^[0-9a-f]{64}$/u);
    // The unchanged feature finding is retained (host-carried), not re-litigated.
    expect(round2.convergence?.carriedPriors).toEqual([0]);
    // A clean integration has no conflict-resolution unit: incoming base-only
    // file src/mainonly.ts is NOT presented as new PR work.
    const unit = readFileSync(join(round2.artifactDirectory, 'integration-delta.patch'), 'utf8');
    expect(unit).toBe('');
    expect(unit).not.toContain('mainonly');
    // The disclosed digest binds the persisted unit bytes, not some other diff.
    expect(createHash('sha256').update(unit).digest('hex')).toBe(round2.convergence?.integrationDeltaSha256);
    // Whole-complete retained coverage: the integration READY binds H1 with
    // NO chained whole-PR pass over the same covered work, and records the
    // durable coverage bit for the next round.
    expect(round2.convergence?.coverageComplete).toBe(true);
    expect(round2.convergence?.finalPassRequired).toBeUndefined();
    expect(round2.canonicalVerdict).toBe('READY TO MERGE');
  });

  it('reviews an actual conflict resolution and keeps a boundary defect blocking across the resolution hunk at round 3', async () => {
    const harness = makeEngine({
      childAnswer: () => '[]',
      specialists: [],
      leadFinding: groundedFinding('lead', 'warning', { title: 'round1 shared warning', location: 'src/shared.ts:1', evidence: 'export const shared = "feature";' }),
    });
    featureHead(harness.repo, 'src/shared.ts', 'export const shared = "feature";\n');
    // A second feature file, UNCHANGED by the integration: it is in the frozen
    // diff but NOT in the integration unit. A boundary defect there must still
    // block (the old delta convergence rule would defer it from round 3).
    harness.repo.commitFile('src/feature2.ts', 'export const feature2 = 1;\n');
    const covered = harness.repo.head();

    const frozen1 = freeze(harness, 'ci-round-1', covered);
    const round1 = await runRound(harness, { roundId: 'ci-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    expect(round1.canonicalVerdict).toBe('READY TO MERGE');
    const consolidated1 = join(reviewArtifactDirectory(harness.root, 'ci-round-1'), 'consolidated.json');

    const { h1 } = integrateConflict(harness.repo);
    const brain = harness.brain as { leadFinding?: unknown };
    brain.leadFinding = groundedFinding('lead', 'blocker', {
      title: 'integration boundary defect', location: 'src/feature2.ts:1', evidence: 'export const feature2 = 1;',
    });
    // Run the integration round at round 3 (the convergence-rule threshold):
    // if integration wrongly inherited the delta deferral, this finding would
    // be filed as a follow-up and the verdict would not hold.
    const frozen2 = freeze(harness, 'ci-round-2', h1);
    const round2 = await runRound(harness, {
      roundId: 'ci-round-2', roundNumber: 3, frozen: frozen2,
      reviewScope: 'integration', priorConsolidatedFile: consolidated1,
    });

    const prompt = harness.leadCalls.at(-1)!.prompt ?? '';
    expect(prompt).toContain('REVIEW SCOPE: INTEGRATION ROUND');
    expect(prompt).not.toContain('CONVERGENCE RULE');
    expect(round2.convergence?.reviewScope).toBe('integration');
    // The resolution is the review unit; the main-only incoming file is not.
    const unit = readFileSync(join(round2.artifactDirectory, 'integration-delta.patch'), 'utf8');
    expect(unit).toContain('src/shared.ts');
    expect(unit).not.toContain('mainonly');
    // src/feature2.ts is retained unchanged and NOT in the unit, yet the
    // finding still holds: integration scope never defers.
    expect(unit).not.toContain('src/feature2.ts');
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
    // Simulate a prior round whose own coverage was PARTIAL (no durable
    // whole-candidate bit): the retained coverage cannot certify the whole
    // candidate, so the integration READY must still chain the final pass.
    const record = JSON.parse(readFileSync(consolidated1, 'utf8')) as { convergence: Record<string, unknown> };
    record.convergence['reviewScope'] = 'delta';
    delete record.convergence['coverageComplete'];
    const partial = join(harness.root, 'pc-partial.json');
    writeFileSync(partial, JSON.stringify(record));

    const { h1 } = integrateClean(harness.repo);
    const frozen2 = freeze(harness, 'pc-round-2', h1);
    const round2 = await runRound(harness, {
      roundId: 'pc-round-2', roundNumber: 2, frozen: frozen2,
      reviewScope: 'integration', priorConsolidatedFile: partial,
    });
    expect(round2.convergence).toMatchObject({ reviewScope: 'integration', finalPassRequired: true });
    expect(round2.convergence?.coverageComplete).toBeUndefined();
    expect(harness.leadCalls.at(-1)!.prompt ?? '').toContain('The retained coverage is only partial');
  });

  it('never launders a partial-coverage integration record into whole-complete coverage', async () => {
    const harness = makeEngine({ childAnswer: () => '[]', specialists: [] });
    const { h0 } = featureHead(harness.repo, 'src/feature.ts', 'export const feature = 1;\n');
    const frozen1 = freeze(harness, 'ch-round-1', h0);
    await runRound(harness, { roundId: 'ch-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    const consolidated1 = join(reviewArtifactDirectory(harness.root, 'ch-round-1'), 'consolidated.json');

    // Round 2: a REAL integration round retaining whole-complete coverage.
    const first = integrateClean(harness.repo, 'src/main1.ts', 'export const main1 = 1;\n');
    const frozen2 = freeze(harness, 'ch-round-2', first.h1);
    const round2 = await runRound(harness, {
      roundId: 'ch-round-2', roundNumber: 2, frozen: frozen2,
      reviewScope: 'integration', priorConsolidatedFile: consolidated1,
    });
    expect(round2.convergence).toMatchObject({ reviewScope: 'integration', coverageComplete: true });

    // Make it a PARTIAL-coverage integration record (its own READY owed the
    // final pass and never got it): the next integration must not read it as
    // whole-complete.
    const record2 = JSON.parse(readFileSync(join(reviewArtifactDirectory(harness.root, 'ch-round-2'), 'consolidated.json'), 'utf8')) as {
      convergence: Record<string, unknown>;
    };
    delete record2.convergence['coverageComplete'];
    record2.convergence['finalPassRequired'] = true;
    const partialIntegration = join(harness.root, 'ch-partial-integration.json');
    writeFileSync(partialIntegration, JSON.stringify(record2));

    const second = integrateClean(harness.repo, 'src/main2.ts', 'export const main2 = 2;\n');
    const frozen3 = freeze(harness, 'ch-round-3', second.h1);
    const round3 = await runRound(harness, {
      roundId: 'ch-round-3', roundNumber: 3, frozen: frozen3,
      reviewScope: 'integration', priorConsolidatedFile: partialIntegration,
    });
    // The prior carries no whole-candidate bit, so this READY still owes the pass.
    expect(round3.canonicalVerdict).toBe('READY TO MERGE');
    expect(round3.convergence).toMatchObject({ reviewScope: 'integration', finalPassRequired: true });
  });

  it('fails closed on a damaged integration coverage link', async () => {
    const harness = makeEngine({ childAnswer: () => '[]', specialists: [] });
    const { h0 } = featureHead(harness.repo, 'src/feature.ts', 'export const feature = 1;\n');
    const frozen1 = freeze(harness, 'dl-round-1', h0);
    await runRound(harness, { roundId: 'dl-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    const consolidated1 = join(reviewArtifactDirectory(harness.root, 'dl-round-1'), 'consolidated.json');
    const first = integrateClean(harness.repo, 'src/main1.ts', 'export const main1 = 1;\n');
    const frozen2 = freeze(harness, 'dl-round-2', first.h1);
    await runRound(harness, {
      roundId: 'dl-round-2', roundNumber: 2, frozen: frozen2,
      reviewScope: 'integration', priorConsolidatedFile: consolidated1,
    });
    // A shape-valid `integration` record whose linkage is missing a field is
    // damaged: it cannot be whole-complete coverage.
    const record2 = JSON.parse(readFileSync(join(reviewArtifactDirectory(harness.root, 'dl-round-2'), 'consolidated.json'), 'utf8')) as {
      convergence: Record<string, unknown>;
    };
    delete record2.convergence['integrationPriorDiffBase'];
    const damaged = join(harness.root, 'dl-damaged.json');
    writeFileSync(damaged, JSON.stringify(record2));

    const second = integrateClean(harness.repo, 'src/main2.ts', 'export const main2 = 2;\n');
    const frozen3 = freeze(harness, 'dl-round-3', second.h1);
    const round3 = await runRound(harness, {
      roundId: 'dl-round-3', roundNumber: 3, frozen: frozen3,
      reviewScope: 'integration', priorConsolidatedFile: damaged,
    });
    expect(round3.canonicalVerdict).toBe('READY TO MERGE');
    expect(round3.convergence).toMatchObject({ reviewScope: 'integration', finalPassRequired: true });
  });

  it('discloses a whole fallback with no stale unit when the integration artifact cannot be written', async () => {
    const harness = makeEngine({ childAnswer: () => '[]', specialists: [] });
    const { b0, h0 } = featureHead(harness.repo, 'src/feature.ts', 'export const feature = 1;\n');
    const frozen1 = freeze(harness, 'aw-round-1', h0);
    await runRound(harness, { roundId: 'aw-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    const consolidated1 = join(reviewArtifactDirectory(harness.root, 'aw-round-1'), 'consolidated.json');
    const { b1, h1 } = integrateClean(harness.repo);
    const frozen2 = freeze(harness, 'aw-round-2', h1);
    // Collide with the unit artifact so its write fails (EEXIST): the round
    // must fall back to whole AND clear every derived unit state.
    const directory = reviewArtifactDirectory(harness.root, 'aw-round-2');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'integration-delta.patch'), 'collision\n');

    const round2 = await runRound(harness, {
      roundId: 'aw-round-2', roundNumber: 2, frozen: frozen2,
      reviewScope: 'integration', priorConsolidatedFile: consolidated1,
    });
    const prompt = harness.leadCalls.at(-1)!.prompt ?? '';
    expect(round2.convergence?.reviewScope).toBe('whole');
    expect(round2.convergence?.deltaUnavailable).toBeDefined();
    expect(round2.convergence?.scopeReason).toContain('could not be prepared');
    expect(round2.convergence?.scopeReason).toContain('whole-change re-verification');
    expect(prompt).toContain('REVIEW SCOPE: WHOLE CHANGE');
    expect(prompt).not.toContain('--- INTEGRATION UNIT');
    expect(prompt).not.toContain('--- DELTA SINCE LAST REVIEWED');
    expect(b0).toMatch(/^[0-9a-f]{40}$/u);
    expect(b1).toMatch(/^[0-9a-f]{40}$/u);
  });

  it('records whole-candidate coverage even when the whole round requests changes', async () => {
    const harness = makeEngine({
      childAnswer: () => '[]',
      specialists: [],
      leadFinding: groundedFinding('lead', 'blocker', { location: 'src/feature.ts:1', evidence: 'export const feature = 1;' }),
    });
    const { h0 } = featureHead(harness.repo, 'src/feature.ts', 'export const feature = 1;\n');
    const frozen = freeze(harness, 'cc-round-1', h0);
    const round = await runRound(harness, { roundId: 'cc-round-1', roundNumber: 1, frozen, reviewScope: 'whole' });
    expect(round.canonicalVerdict).toBe('NEEDS CHANGES');
    expect(round.convergence?.coverageComplete).toBe(true);
  });

  it('re-verifies a prior finding on a base-changed file that is not in the unit', async () => {
    const harness = makeEngine({
      childAnswer: () => '[]',
      specialists: [],
      leadFinding: groundedFinding('lead', 'warning', {
        title: 'readme warning', location: 'README.md:1', evidence: '# perkins-integration-round',
      }),
    });
    const { h0 } = featureHead(harness.repo, 'src/feature.ts', 'export const feature = 1;\n');
    const frozen1 = freeze(harness, 'bc-round-1', h0);
    await runRound(harness, { roundId: 'bc-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    const consolidated1 = join(reviewArtifactDirectory(harness.root, 'bc-round-1'), 'consolidated.json');

    // The incoming base changes README.md; the feature does not. The path is
    // therefore absent from the focused unit but present in the sound carry
    // set, so the prior must be re-verified, not carried.
    const { h1 } = integrateClean(harness.repo, 'README.md', '# perkins-integration-round\n\nmain changed\n');
    const frozen2 = freeze(harness, 'bc-round-2', h1);
    const round2 = await runRound(harness, {
      roundId: 'bc-round-2', roundNumber: 2, frozen: frozen2,
      reviewScope: 'integration', priorConsolidatedFile: consolidated1,
    });
    expect(round2.convergence?.reviewScope).toBe('integration');
    expect(round2.convergence?.reverifyPriors).toEqual([0]);
    expect(round2.convergence?.carriedPriors).toBeUndefined();
  });

  it('gives the specialist lenses the integration unit in their prompt', async () => {
    const harness = makeEngine({ childAnswer: () => '[]', specialists: ['blind'] });
    featureHead(harness.repo, 'src/shared.ts', 'export const shared = "feature";\n');
    const covered = harness.repo.head();
    const frozen1 = freeze(harness, 'sp-round-1', covered);
    await runRound(harness, { roundId: 'sp-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    const consolidated1 = join(reviewArtifactDirectory(harness.root, 'sp-round-1'), 'consolidated.json');
    const { h1 } = integrateConflict(harness.repo);
    const frozen2 = freeze(harness, 'sp-round-2', h1);
    await runRound(harness, {
      roundId: 'sp-round-2', roundNumber: 2, frozen: frozen2,
      reviewScope: 'integration', priorConsolidatedFile: consolidated1,
    });
    const unitPrompts = harness.childCalls.filter((call) => call.prompt?.includes('--- INTEGRATION UNIT'));
    expect(unitPrompts.length).toBeGreaterThan(0);
    expect(unitPrompts.at(-1)!.prompt).toContain('Unchanged incoming base code is baseline context');
  });

  it('still owes the whole pass when a resolution discarded prior feature work', async () => {
    const harness = makeEngine({
      childAnswer: () => '[]',
      specialists: [],
      leadFinding: groundedFinding('lead', 'warning', { title: 'shared warning', location: 'src/shared.ts:1', evidence: 'export const shared = "feature";' }),
    });
    featureHead(harness.repo, 'src/shared.ts', 'export const shared = "feature";\n');
    // A second feature file survives the integration, so the frozen whole diff
    // is non-empty even though the shared path is dropped by the resolution.
    harness.repo.commitFile('src/keep.ts', 'export const keep = 1;\n');
    const covered = harness.repo.head();
    const frozen1 = freeze(harness, 'dp-round-1', covered);
    const round1 = await runRound(harness, { roundId: 'dp-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
    expect(round1.convergence?.coverageComplete).toBe(true);
    const consolidated1 = join(reviewArtifactDirectory(harness.root, 'dp-round-1'), 'consolidated.json');

    // The resolution takes main's version: the reviewed feature change is gone.
    const { h1 } = integrateConflictTakingBase(harness.repo);
    const frozen2 = freeze(harness, 'dp-round-2', h1);
    const round2 = await runRound(harness, {
      roundId: 'dp-round-2', roundNumber: 2, frozen: frozen2,
      reviewScope: 'integration', priorConsolidatedFile: consolidated1,
    });
    expect(round2.convergence?.reviewScope).toBe('integration');
    // Dropping reviewed feature work means the whole candidate is NOT covered:
    // the whole-change authority is still owed, even though the prior bit was set.
    expect(round2.convergence?.coverageComplete).toBeUndefined();
    expect(round2.convergence?.finalPassRequired).toBe(true);
    const prompt = harness.leadCalls.at(-1)!.prompt ?? '';
    expect(prompt).toContain('no longer differ from the incoming base');
    expect(prompt).not.toContain('the integration was clean');
  });
});
