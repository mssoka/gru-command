import { readFileSync, rmSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freezeReviewInputs, reviewArtifactDirectory, type FrozenReview } from '../src/dispatch/perkins-review/artifacts.js';
import {
  classifyPriorFindings,
  convergedVerdict,
  deltaSince,
  findingIntersectsDelta,
  nextReviewScope,
  parseDeltaHunks,
  parseFindingLocation,
  partitionConvergedFindings,
  readPriorConvergenceMeta,
} from '../src/dispatch/perkins-review/convergence.js';
import { loadPerkinsPolicy } from '../src/dispatch/perkins-review/policy.js';
import { PerkinsWholeReview, type PerkinsWholeResult } from '../src/dispatch/perkins-review/whole.js';
import type { VerifiedFinding } from '../src/dispatch/perkins-review/types.js';
import { fakeWholeSpawner, groundedFinding, type WholeLeadOptions, type WholeSpawnCall } from './helpers/perkins-whole-double.js';
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
  ].join('\n');

  it('parses new-file hunk ranges including pure deletions', () => {
    const hunks = parseDeltaHunks(diff);
    expect(hunks).toEqual([
      { path: 'src/kept.ts', startLine: 1, endLine: 4 },
      { path: 'src/deleted.ts', startLine: 0, endLine: -1 },
    ]);
  });

  it('intersects findings inside the delta and skips untouched code', () => {
    const hunks = parseDeltaHunks(diff);
    expect(findingIntersectsDelta('src/kept.ts:2', hunks)).toBe(true);
    expect(findingIntersectsDelta('src/kept.ts:2-3', hunks)).toBe(true);
    // Untouched line of a touched file: outside every hunk.
    expect(findingIntersectsDelta('src/kept.ts:900', hunks)).toBe(false);
    // A file with no hunks at all is untouched code by construction.
    expect(findingIntersectsDelta('src/untouched.ts:1', hunks)).toBe(false);
    // A pure deletion hunk adds no new lines to intersect.
    expect(findingIntersectsDelta('src/deleted.ts:1', hunks)).toBe(false);
  });

  it('fails closed toward blocking for unanchored findings', () => {
    const hunks = parseDeltaHunks(diff);
    expect(findingIntersectsDelta('N/A', hunks)).toBe(true);
    expect(findingIntersectsDelta('no path at all', hunks)).toBe(true);
    expect(findingIntersectsDelta('src/kept.ts:hunk', hunks)).toBe(true);
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
    expect(delta.hunks).toEqual([{ path: 'src/second.ts', startLine: 1, endLine: 2 }]);
    expect(delta.diff).toContain('+++ b/src/second.ts');
    expect(Buffer.byteLength(`x${base}`)).toBeGreaterThan(0);
  });

  it('refuses non-SHA endpoints and unreadable revisions', () => {
    const repo = makeFixtureRepo('perkins-convergence-delta-bad');
    repos.push(repo);
    expect(() => deltaSince(repo.path, 'main', 'HEAD')).toThrow();
    expect(() => deltaSince(repo.path, '0'.repeat(40), '1'.repeat(40))).toThrow();
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
      { priorIndex: 0, status: 'carried', reason: 'quoted evidence unchanged in the frozen tree and the cited file untouched' },
    ]);
  });

  it('re-verifies priors on a file the delta touched', () => {
    const classifications = classifyPriorFindings({
      prior: [priorFinding],
      touchedPaths: new Set(['src/kept.ts']),
      frozenBlobContains: () => true,
    });
    expect(classifications[0]!.status).toBe('reverify');
    expect(classifications[0]!.reason).toContain('changed in this round\'s delta');
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

  it('defers new findings outside the delta from the policy round and never before', () => {
    const hunks = parseDeltaHunks(['diff --git a/src/kept.ts b/src/kept.ts', '--- a/src/kept.ts', '+++ b/src/kept.ts', '@@ -1,3 +1,4 @@', '+const two = 2;', ''].join('\n'));
    const inside = finding({ location: 'src/kept.ts:2' });
    const outside = finding({ location: 'src/untouched.ts:1', title: 'outside defect' });
    const early = partitionConvergedFindings({ roundNumber: 2, fromRound: 3, findings: [inside, outside], hunks });
    expect(early.deferred).toEqual([]);
    const late = partitionConvergedFindings({ roundNumber: 3, fromRound: 3, findings: [inside, outside], hunks });
    expect(late.converged).toEqual([inside]);
    expect(late.deferred).toHaveLength(1);
    expect(late.deferred[0]!.finding.title).toBe('outside defect');
    expect(late.deferred[0]!.reason).toContain('cannot hold the PR');
  });

  it('maps the converged blocker count with the standing policy mapping', () => {
    expect(convergedVerdict(0)).toBe('READY TO MERGE');
    expect(convergedVerdict(1)).toBe('NEEDS CHANGES');
    expect(convergedVerdict(3)).toBe('NEEDS CHANGES');
    expect(convergedVerdict(4)).toBe('MAJOR REWORK NEEDED');
  });
});

describe('review scope planning (final whole pass at a READY candidate)', () => {
  const meta = (overrides: Partial<{ seq: number; reviewScope: 'whole' | 'delta' | 'unknown'; canonicalVerdict: string }> = {}) => ({
    seq: 1,
    reviewScope: 'delta' as const,
    canonicalVerdict: 'NEEDS CHANGES',
    targetSha: 'a'.repeat(40),
    ...overrides,
  });

  it('plans whole for a job with no prior and delta for every round after a prior', () => {
    expect(nextReviewScope({ prior: null, deltaRoundsFrom: 2, finalWholePassAtReady: true })).toBe('whole');
    expect(nextReviewScope({ prior: meta(), deltaRoundsFrom: 2, finalWholePassAtReady: true })).toBe('delta');
    expect(nextReviewScope({ prior: meta({ reviewScope: 'whole', canonicalVerdict: 'READY TO MERGE' }), deltaRoundsFrom: 2, finalWholePassAtReady: true })).toBe('delta');
  });

  it('plans the final whole pass exactly when a delta round posted READY', () => {
    expect(nextReviewScope({ prior: meta({ canonicalVerdict: 'READY TO MERGE' }), deltaRoundsFrom: 2, finalWholePassAtReady: true })).toBe('whole');
    expect(nextReviewScope({ prior: meta({ canonicalVerdict: 'READY TO MERGE' }), deltaRoundsFrom: 2, finalWholePassAtReady: false })).toBe('delta');
    // A legacy (pre-Stage-5) prior record never triggers the final pass.
    expect(nextReviewScope({ prior: meta({ reviewScope: 'unknown', canonicalVerdict: 'READY TO MERGE' }), deltaRoundsFrom: 2, finalWholePassAtReady: true })).toBe('delta');
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
      frozen: { targetSha: 'b'.repeat(40) },
      convergence: { reviewScope: 'delta' },
    };
    writeFileSync(file, JSON.stringify(modern));
    expect(readPriorConvergenceMeta(file, 4)).toEqual({
      seq: 4, reviewScope: 'delta', canonicalVerdict: 'READY TO MERGE', targetSha: 'b'.repeat(40),
    });
    writeFileSync(file, JSON.stringify({ ...modern, convergence: undefined }));
    expect(readPriorConvergenceMeta(file, 4)?.reviewScope).toBe('unknown');
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
      frozen: { targetSha: 'c'.repeat(40) },
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
    const round1 = await runRound(harness, { roundId: 'rv-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
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
    const round1 = await runRound(harness, { roundId: 'df-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
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
    expect(round3.convergence?.deferredFollowups).toHaveLength(1);
    expect(round3.convergence?.deferredFollowups?.[0]).toMatchObject({ title: 'untouched new defect', severity: 'blocker' });

    const consolidated3 = JSON.parse(readFileSync(join(round3.artifactDirectory, 'consolidated.json'), 'utf8')) as {
      canonicalVerdict: string;
      submittedVerdict: string;
      findings: Array<{ title: string; deferredFollowup?: true; verification: { reason: string } }>;
    };
    expect(consolidated3.submittedVerdict).toBe('NEEDS CHANGES');
    expect(consolidated3.canonicalVerdict).toBe('READY TO MERGE');
    const deferred = consolidated3.findings.find((finding) => finding.title === 'untouched new defect');
    expect(deferred!.deferredFollowup).toBe(true);
    expect(deferred!.verification.reason).toContain('cannot hold the PR');
  });

  it('keeps an intersecting round-3 blocker holding the PR', async () => {
    const harness = makeEngine({
      childAnswer: () => '[]',
      specialists: [],
      leadFinding: groundedFinding('lead', 'warning', { location: 'src/main.ts:1', evidence: 'export function answer(): number {' }),
    });
    harness.repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
    const frozen1 = freeze(harness, { roundId: 'in-round-1', spec: 'return 43' });
    const round1 = await runRound(harness, { roundId: 'in-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
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
    expect(round3.convergence?.deferredFollowups).toBeUndefined();
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
    const round1 = await runRound(harness, { roundId: 'fp-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
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
    const round1 = await runRound(harness, { roundId: 'cj-round-1', roundNumber: 1, frozen: frozen1, reviewScope: 'whole' });
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
