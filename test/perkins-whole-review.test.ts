import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertFrozenPromptBounds,
  freezeReviewInputs,
  FROZEN_DIFF_MAX_BYTES,
  FROZEN_SPEC_MAX_BYTES,
  resolveReviewBaseRef,
  reviewArtifactDirectory,
  writeReviewArtifact,
  type FrozenReview,
} from '../src/dispatch/perkins-review/artifacts.js';
import { loadPerkinsPolicy, PERKINS_LENSES, PERKINS_POLICY_SHA256 } from '../src/dispatch/perkins-review/policy.js';
import { DEFAULT_REVIEW_CHILDREN } from '../src/config.js';
import { PerkinsWholeReview, STANDALONE_SPECIALIST_CONCURRENCY, type PerkinsWholeResult, type PerkinsWholeReviewOptions } from '../src/dispatch/perkins-review/whole.js';
import { ReviewMcpBridge } from '../src/runtime/review-mcp-bridge.js';
import { finalAssistantText } from '../src/dispatch/perkins-review/session-output.js';
import { attachBareOrigin, makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { PacingGate, type PacingAcquireInput, type PacingLease } from '../src/runtime/pacing.js';
import { fakeWholeSpawner, groundedFinding, type WholeLeadOptions, type WholeSpawnCall } from './helpers/perkins-whole-double.js';
import type { NativeAgentTool } from '../src/runtime/types.js';

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

function makeReviewRepo(name = 'perkins-whole'): { repo: FixtureRepo; base: string; target: string } {
  const repo = makeFixtureRepo(name);
  const base = repo.head();
  repo.git(['checkout', '-b', 'feature/review']);
  const target = repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 43;\n}\n');
  return { repo, base, target };
}

interface WholeHarness {
  readonly repo: FixtureRepo;
  readonly base: string;
  readonly target: string;
  readonly root: string;
  readonly frozen: FrozenReview;
  readonly calls: ReturnType<typeof fakeWholeSpawner>['calls'];
  readonly leadCalls: ReturnType<typeof fakeWholeSpawner>['leadCalls'];
  readonly childCalls: ReturnType<typeof fakeWholeSpawner>['childCalls'];
  readonly toolErrors: ReturnType<typeof fakeWholeSpawner>['toolErrors'];
  readonly preflightResults: ReturnType<typeof fakeWholeSpawner>['preflightResults'];
  readonly attemptedBatches: ReturnType<typeof fakeWholeSpawner>['attemptedBatches'];
  readonly runBatches: ReturnType<typeof fakeWholeSpawner>['runBatches'];
  readonly probeOutcomes: ReturnType<typeof fakeWholeSpawner>['probeOutcomes'];
  run(input?: { noSpec?: boolean; priorConsolidatedFile?: string }): Promise<PerkinsWholeResult>;
}

function wholeHarness(
  brain: WholeLeadOptions,
  options?: {
    noSpec?: boolean;
    spec?: string;
    priorConsolidatedFile?: string;
    beforeFreeze?: (repo: FixtureRepo) => void;
    /** Named base ref to freeze (`main`, `origin/main`); default pins the
     * base by SHA, which can never advance. */
    baseRef?: string;
    reviewGate?: PacingGate;
    pacing?: Pick<PerkinsWholeReviewOptions, 'rateLimitBackoff' | 'recordPacing' | 'pacingSleep' | 'pacingJitter' | 'pacingNow'>;
  },
): WholeHarness {
  const fixture = makeReviewRepo();
  repos.push(fixture.repo);
  options?.beforeFreeze?.(fixture.repo);
  const base = fixture.repo.git(['rev-parse', options?.baseRef ?? 'main']);
  const target = fixture.repo.head();
  const root = temp('perkins-whole-test-');
  const frozen = freezeReviewInputs({
    roundId: 'whole-round',
    repoPath: fixture.repo.path,
    artifactRoot: root,
    baseRef: options?.baseRef ?? base,
    targetRef: target,
    movementRef: 'feature/review',
    ...(options?.noSpec === true
      ? { noSpec: true }
      : { spec: options?.spec ?? 'return 43' }),
  });
  const fake = fakeWholeSpawner(temp('perkins-whole-sessions-'), brain);
  const engine = new PerkinsWholeReview({
    spawner: fake.spawner,
    policy: loadPerkinsPolicy(),
    ...(options?.reviewGate !== undefined ? { reviewGate: options.reviewGate } : {}),
    ...(options?.pacing ?? {}),
  });
  return {
    ...fixture,
    base,
    target,
    root,
    frozen,
    calls: fake.calls,
    leadCalls: fake.leadCalls,
    childCalls: fake.childCalls,
    toolErrors: fake.toolErrors,
    preflightResults: fake.preflightResults,
    attemptedBatches: fake.attemptedBatches,
    runBatches: fake.runBatches,
    probeOutcomes: fake.probeOutcomes,
    run: (input = {}) => engine.run({
      roundId: 'whole-round',
      roundNumber: 1,
      frozenReview: frozen,
      movementRef: 'feature/review',
      noSpec: input.noSpec ?? options?.noSpec ?? false,
      ...(input.priorConsolidatedFile !== undefined || options?.priorConsolidatedFile !== undefined
        ? { priorConsolidatedFile: input.priorConsolidatedFile ?? options?.priorConsolidatedFile }
        : {}),
    }),
  };
}

const ALL_CLEAN: WholeLeadOptions = { childAnswer: () => '[]', specialists: [] };

/** Advance `branch` by one commit without touching any checkout (a merge
 * landing on the base mid-review). `cwd` targets another repository, e.g.
 * the bare origin, so only its advertised tip moves. */
function advanceBranch(repo: FixtureRepo, branch: string, cwd?: string): string {
  const next = repo.git([
    '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid',
    'commit-tree', `${branch}^{tree}`, '-p', branch, '-m', `${branch} advances during review`,
  ], cwd);
  repo.git(['update-ref', `refs/heads/${branch}`, next], cwd);
  return next;
}

/** Attempt 1 submits the conclusive verdict; attempt 2 falls back to INCOMPLETE. */
function incompleteOnRetry(attempt: number, submission: { verdict: string; report_markdown: string }): unknown {
  return attempt === 1
    ? submission
    : { ...submission, verdict: 'INCOMPLETE', report_markdown: submission.report_markdown.replace(/\*\*Verdict: [^*]+\*\*/, '**Verdict: INCOMPLETE**') };
}

/** A base-only advance leaves the frozen target valid: preflight ok, the
 * conclusive verdict accepted first time, and the frozen base kept as
 * provenance (never rewritten to the live tip). */
function expectBaseAdvanceAccepted(h: WholeHarness, result: PerkinsWholeResult): void {
  expect(h.preflightResults).toHaveLength(1);
  expect(JSON.parse(h.preflightResults[0]!.text)).toMatchObject({ ok: true, errorCount: 0 });
  expect(h.toolErrors.filter((entry) => entry.tool === 'perkins_submit_review')).toEqual([]);
  expect(result.canonicalVerdict).toBe('READY TO MERGE');
  expect(result.headMoved).toBe(false);
  const consolidated = JSON.parse(readFileSync(join(result.artifactDirectory, 'consolidated.json'), 'utf8')) as {
    complete: boolean; headMoved: boolean; frozen: Record<string, unknown>;
  };
  expect(consolidated.complete).toBe(true);
  expect(consolidated.headMoved).toBe(false);
  const frozenProvenance = { baseRefSha: h.base, diffBaseSha: h.base, targetSha: h.target, diffSha256: h.frozen.manifest.diffSha256 };
  expect(consolidated.frozen).toMatchObject(frozenProvenance);
  expect(JSON.parse(readFileSync(join(h.frozen.directory, 'manifest.json'), 'utf8'))).toMatchObject(frozenProvenance);
}

describe('bundled Perkins policy (whole-PR contract)', () => {
  it('loads the integrity-pinned whole-PR policy with the lead workflow and no chunk rule', () => {
    const policy = loadPerkinsPolicy();
    expect(policy.portableContract.rules.fullLenses).toEqual([...PERKINS_LENSES]);
    expect(policy.portableContract.leadWorkflow).toContain('perkins_submit_review');
    expect(policy.portableContract.leadWorkflow).toContain('WHOLE change');
    expect('chunkLineThreshold' in policy.portableContract.rules).toBe(false);
    expect(policy.portableContract.blindPrompt).toContain('{{CHANGED_FILES}}');
    expect(policy.portableContract.blindPrompt).toContain('COMPLETE change');
    expect(policy.portableContract.outputContracts.blindText).toContain('FILES IN THIS CHANGE');
    expect(policy.portableContract.rules.incompleteNeverApproves).toBe(true);
  });

  it('keeps the policy pin, the compiler pin, and the verifier pin consistent', () => {
    const verifier = readFileSync(join(process.cwd(), 'tools/verify-perkins-resource.mjs'), 'utf8');
    expect(verifier).toContain(PERKINS_POLICY_SHA256);
    const policyModule = readFileSync(join(process.cwd(), 'src/dispatch/perkins-review/policy.ts'), 'utf8');
    expect(policyModule).toContain(PERKINS_POLICY_SHA256);
    const actual = createHash('sha256')
      .update(readFileSync(join(process.cwd(), 'resources/perkins-code-review/policy.json')))
      .digest('hex');
    expect(actual).toBe(PERKINS_POLICY_SHA256);
  });

  it('fails loud for a tampered policy resource', () => {
    const copy = temp('perkins-policy-tamper-');
    const file = join(copy, 'policy.json');
    const parsed = JSON.parse(readFileSync(join(process.cwd(), 'resources/perkins-code-review/policy.json'), 'utf8')) as Record<string, unknown>;
    parsed.identity = 'not-perkins';
    writeFileSync(file, JSON.stringify(parsed));
    expect(() => loadPerkinsPolicy(file)).toThrow(/integrity mismatch/);
    const truncated = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    truncated.portableContract = undefined;
    writeFileSync(file, JSON.stringify(truncated));
    expect(() => loadPerkinsPolicy(file)).toThrow(/integrity mismatch/);
  });

  it('carries no chunk-threshold rule in the shipped policy resource', () => {
    const policyJson = readFileSync(join(process.cwd(), 'resources/perkins-code-review/policy.json'), 'utf8');
    expect(policyJson).not.toContain('chunkLineThreshold');
    expect(policyJson).not.toContain('CHUNK_FILES');
    // The loader keeps an explicit guard against its return.
    const policyModule = readFileSync(join(process.cwd(), 'src/dispatch/perkins-review/policy.ts'), 'utf8');
    expect(policyModule).toContain('retired chunk-threshold rule');
  });
});

describe('whole-PR freeze (no chunk partitioning)', () => {
  it('freezes a formerly oversized multi-directory diff as ONE whole review with no chunk artifacts', () => {
    const repo = makeFixtureRepo('whole-oversize');
    repos.push(repo);
    const base = repo.head();
    repo.git(['checkout', '-b', 'feature/oversize']);
    // Two directories, each over the retired 3000-line threshold.
    for (const directory of ['src/deep', 'web/deep']) {
      const lines = Array.from({ length: 3_200 }, (_unused, index) => `export const value${index} = ${index};`);
      repo.commitFile(`${directory}/big.ts`, `${lines.join('\n')}\n`);
    }
    const target = repo.head();
    const root = temp('perkins-freeze-oversize-');
    const frozen = freezeReviewInputs({
      roundId: 'oversize-round', repoPath: repo.path, artifactRoot: root,
      baseRef: base, targetRef: target, movementRef: 'feature/oversize', spec: 'big change',
    });
    expect(frozen.manifest).not.toHaveProperty('chunks');
    expect([...frozen.changedFiles].sort()).toEqual(['src/deep/big.ts', 'web/deep/big.ts']);
    expect(existsSync(join(frozen.directory, 'diff.patch'))).toBe(true);
    expect(existsSync(join(frozen.directory, 'chunks'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(frozen.directory, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).not.toHaveProperty('chunks');
    expect(manifest['changedFiles']).toEqual(['src/deep/big.ts', 'web/deep/big.ts']);
    // The complete diff is the review unit: nothing was partitioned away.
    expect(frozen.diff).toContain('src/deep/big.ts');
    expect(frozen.diff).toContain('web/deep/big.ts');
    assertFrozenPromptBounds(frozen);
  });

  it('fails closed on UTF-8 byte bounds for frozen diff and spec', () => {
    const repo = makeFixtureRepo('whole-bounds');
    repos.push(repo);
    const base = repo.head();
    repo.git(['checkout', '-b', 'feature/bounds']);
    repo.commitFile('src/huge.txt', `${'x'.repeat(FROZEN_DIFF_MAX_BYTES + 1)}\n`);
    const root = temp('perkins-freeze-bounds-');
    expect(() => freezeReviewInputs({
      roundId: 'bounds-round', repoPath: repo.path, artifactRoot: root,
      baseRef: base, targetRef: repo.head(), movementRef: 'feature/bounds', spec: 'too big',
    })).toThrow(/frozen diff exceeds/);
    const specRepo = makeFixtureRepo('whole-spec-bounds');
    repos.push(repo);
    repos.push(specRepo);
    const specBase = specRepo.head();
    specRepo.git(['checkout', '-b', 'feature/spec']);
    specRepo.commitFile('src/tiny.ts', 'export const one = 1;\n');
    const specRoot = temp('perkins-freeze-spec-');
    expect(() => freezeReviewInputs({
      roundId: 'spec-round', repoPath: specRepo.path, artifactRoot: specRoot,
      baseRef: specBase, targetRef: specRepo.head(), movementRef: 'feature/spec',
      spec: 'y'.repeat(FROZEN_SPEC_MAX_BYTES + 1),
    })).toThrow(/frozen spec context exceeds/);
  });

  it('rejects writeReviewArtifact traversal and unsafe round ids, and refuses a symlinked frozen tree', () => {
    const repo = makeFixtureRepo('whole-guards');
    repos.push(repo);
    const base = repo.head();
    repo.git(['checkout', '-b', 'feature/guards']);
    const target = repo.commitFile('src/main.ts', 'export const guarded = true;\n');
    const root = temp('perkins-guards-');
    const frozen = freezeReviewInputs({
      roundId: 'guards-round', repoPath: repo.path, artifactRoot: root,
      baseRef: base, targetRef: target, movementRef: 'feature/guards', spec: 'guards',
    });
    expect(() => writeReviewArtifact(frozen, '../escape.json', 'x')).toThrow(/escapes round directory/);
    expect(() => writeReviewArtifact(frozen, 'a/../../escape.json', 'x')).toThrow(/escapes round directory/);
    expect(() => reviewArtifactDirectory(root, '../outside')).toThrow(/safe artifact path component/);

    const symlinkRepo = makeFixtureRepo('whole-symlink');
    repos.push(repo);
    const symlinkBase = symlinkRepo.head();
    symlinkRepo.git(['checkout', '-b', 'feature/symlink']);
    symlinkSync('/etc/hosts', join(symlinkRepo.path, 'link'));
    symlinkRepo.git(['add', 'link']);
    symlinkRepo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'add symlink']);
    expect(() => freezeReviewInputs({
      roundId: 'symlink-round', repoPath: symlinkRepo.path, artifactRoot: temp('perkins-symlink-'),
      baseRef: symlinkBase, targetRef: symlinkRepo.head(), movementRef: 'feature/symlink', spec: 'no symlinks',
    })).toThrow(/symlink/);
  });

  it('rejects freezeReviewInputs ingress conflicts (spec+noSpec, neither) and an empty diff', () => {
    const repo = makeFixtureRepo('whole-ingress');
    repos.push(repo);
    const base = repo.head();
    repo.git(['checkout', '-b', 'feature/ingress']);
    const target = repo.commitFile('src/main.ts', 'export const ingress = true;\n');
    const root = temp('perkins-ingress-');
    const freeze = (input: Partial<Parameters<typeof freezeReviewInputs>[0]>): FrozenReview | void =>
      freezeReviewInputs({
        roundId: 'ingress-round', repoPath: repo.path, artifactRoot: root,
        baseRef: base, targetRef: target, movementRef: 'feature/ingress', ...input,
      } as Parameters<typeof freezeReviewInputs>[0]);
    expect(() => freeze({ spec: 's', noSpec: true })).toThrow(/cannot supply both/);
    expect(() => freeze({})).toThrow(/requires frozen spec\/context or explicit noSpec/);
    // Empty diff: target equals the merge base.
    repo.git(['checkout', 'main']);
    repo.git(['checkout', '-b', 'feature/empty']);
    expect(() => freezeReviewInputs({
      roundId: 'empty-round', repoPath: repo.path, artifactRoot: root,
      baseRef: base, targetRef: base, movementRef: 'feature/empty', spec: 'nothing changed',
    })).toThrow(/frozen review diff is empty/);
  });
});

describe('review base resolution', () => {
  it('resolves explicit base, origin/HEAD, main fallback, and fails closed with no base', () => {
    const repo = makeFixtureRepo('whole-base');
    repos.push(repo);
    expect(resolveReviewBaseRef(repo.path, 'main')).toBe('main');
    expect(resolveReviewBaseRef(repo.path, 'refs/heads/main')).toBe('refs/heads/main');
    expect(resolveReviewBaseRef(repo.path, null)).toBe('main');
    expect(resolveReviewBaseRef(repo.path, '')).toBe('main');
    // Fail closed when no conventional default exists: a repo whose only
    // branch is neither main nor master and which has no origin/HEAD.
    const lone = makeFixtureRepo('whole-base-lone');
    repos.push(lone);
    lone.git(['checkout', '-q', '-b', 'only-branch']);
    lone.git(['branch', '-D', 'main']);
    expect(() => resolveReviewBaseRef(lone.path, null)).toThrow(/requires job.baseBranch/);
  });
});

describe('Perkins whole-PR lead engine', () => {
  it('one lead reviews the whole diff inline, uses no specialists, and completes READY TO MERGE', async () => {
    const h = wholeHarness(ALL_CLEAN, { spec: 'return 43' });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(result.findings).toHaveLength(0);
    expect(result.specialistRuns).toHaveLength(0);
    // Exactly one isolated lead session; its prompt carries the COMPLETE diff.
    expect(h.leadCalls).toHaveLength(1);
    const prompt = h.leadCalls[0]!.prompt!;
    expect(prompt).toContain('COMPLETE FROZEN DIFF');
    expect(prompt).toContain(h.frozen.diff);
    expect(prompt).toContain('--- FROZEN SPECIFICATION / CONTEXT ---');
    expect(prompt).toContain('return 43');
    expect(prompt).toContain(`Frozen target SHA: ${h.target}`);
    expect(prompt).toContain(`Frozen diff base SHA: ${h.base}`);
    expect(prompt).toContain('Changed files (1): src/main.ts');
    // Durable artifacts: the published report and the v3 consolidated record.
    const report = readFileSync(result.reportFile, 'utf8');
    expect(report).toContain('**Verdict: READY TO MERGE**');
    const consolidated = JSON.parse(readFileSync(join(result.artifactDirectory, 'consolidated.json'), 'utf8')) as Record<string, unknown>;
    expect(consolidated['schemaVersion']).toBe(3);
    expect(consolidated['architecture']).toBe('perkins-whole-pr');
    expect(consolidated['complete']).toBe(true);
    expect(consolidated['canonicalVerdict']).toBe('READY TO MERGE');
    expect(consolidated['findings']).toEqual([]);
    const receipt = JSON.parse(readFileSync(join(result.artifactDirectory, 'lead/receipt.json'), 'utf8')) as Record<string, unknown>;
    expect(receipt['nativeTools']).toEqual([
      'perkins_run_specialists', 'perkins_store_artifact', 'perkins_preflight_submission', 'perkins_submit_review',
    ]);
  });

  it('specialists see the WHOLE change from their lens and stay isolated children', async () => {
    const seen: string[] = [];
    const h = wholeHarness({
      childAnswer: (prompt) => {
        seen.push(prompt);
        return '[]';
      },
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(h.childCalls).toHaveLength(9);
    for (const call of h.childCalls) {
      expect(call.options.isolatedReview).toBeDefined();
      expect(call.options.reviewLead).toBeUndefined();
      // Every specialist prompt embeds the complete frozen diff.
      expect(call.prompt).toContain(h.frozen.diff);
      expect(call.prompt).toContain('--- FROZEN DIFF');
    }
    const blindPrompt = h.childCalls.find((call) => call.prompt!.includes('FILES IN THIS CHANGE'))?.prompt;
    expect(blindPrompt).toBeDefined();
    expect(blindPrompt).toContain('- src/main.ts');
    // Non-blind specialists are rooted in the frozen tree; blind is outside it.
    const blindCall = h.childCalls.find((call) => call.prompt!.includes('FILES IN THIS CHANGE'));
    expect(blindCall?.options.cwd).toBe(h.frozen.directory);
    for (const call of h.childCalls) {
      if (call === blindCall) continue;
      expect(call.options.cwd).toBe(h.repo.path);
    }
  });

  it('uses exactly eight specialists in explicit no-spec mode, omitting only acceptance', async () => {
    const h = wholeHarness({ childAnswer: () => '[]' }, { noSpec: true });
    await h.run();
    expect(h.childCalls).toHaveLength(8);
    expect(h.childCalls.some((call) => call.prompt!.includes('EXPLICIT NO-SPEC REVIEW'))).toBe(true);
    // The spec-dependent lens is the ONLY omission: the two spec-independent
    // newcomers (performance, operations) are available and run.
    expect(h.childCalls.some((call) => call.prompt!.includes('"source": "acceptance"'))).toBe(false);
    expect(h.childCalls.some((call) => call.prompt!.includes('"source": "performance"'))).toBe(true);
    expect(h.childCalls.some((call) => call.prompt!.includes('"source": "operations"'))).toBe(true);
  });

  it('a performance and an operations finding survive child validation, lead submission and attribution', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => {
        const source = /"source": "(performance|operations)"/u.exec(prompt)?.[1];
        return source === undefined ? '[]' : JSON.stringify([groundedFinding(source, 'warning')]);
      },
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    // Attribution is by the NEW source ids and nothing else: each finding
    // crossed child validation, lead consolidation and the submission schema.
    expect(result.findings.map((finding) => finding.source).sort()).toEqual(['operations', 'performance']);
    expect(result.specialistRuns
      .filter((run) => run.lens === 'performance' || run.lens === 'operations')
      .every((run) => run.status === 'valid' && run.attempt === 1)).toBe(true);
  });

  it('a REQUEST_CHANGES review is successful completion, not an orchestration failure', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => (prompt.includes('"source": "security"')
        ? JSON.stringify([groundedFinding('security', 'blocker')])
        : '[]'),
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('NEEDS CHANGES');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.severity).toBe('blocker');
    expect(result.findings[0]?.roundOrigin).toBe(1);
    expect(readFileSync(result.reportFile, 'utf8')).toContain('**Verdict: NEEDS CHANGES**');
  });

  it('the verdict is the reviewer\'s judgment — the host runs no blocker arithmetic', async () => {
    const h = wholeHarness({
      ...ALL_CLEAN,
      verdictOverride: 'NEEDS CHANGES',
      leadFinding: groundedFinding('lead', 'note'),
    });
    const result = await h.run();
    // Zero blockers, yet the lead judged NEEDS CHANGES: accepted as authored.
    expect(result.canonicalVerdict).toBe('NEEDS CHANGES');
  });

  it('a coherent report publishes without verbatim per-finding field duplication', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => (prompt.includes('"source": "codebase"')
        ? JSON.stringify([groundedFinding('codebase', 'warning', { evidence: '  return 43;' })])
        : '[]'),
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    const report = readFileSync(result.reportFile, 'utf8');
    // Source references remain (title + location), structured evidence is
    // NOT required to be transcribed verbatim.
    expect(report).toContain('codebase grounded defect');
    expect(report).toContain('src/main.ts:1');
    expect(report).not.toContain('"evidence"');
  });

  it('revisits prior findings by judgment alone: a cross-file fix needs no fix_location proof shape', async () => {
    const h = priorHarness({
      audit: { prior_index: 0, status: 'fixed', note: 'The caller stopped passing the token through the helper (src/caller.ts changed to select the native setting directly).' },
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(result.priorDispositions).toEqual([
      { prior_index: 0, status: 'fixed', note: expect.stringContaining('src/caller.ts') },
    ]);
    // A fixed prior finding is not carried into the new consolidated record.
    const consolidated = JSON.parse(readFileSync(join(result.artifactDirectory, 'consolidated.json'), 'utf8')) as { findings: unknown[] };
    expect(consolidated.findings).toHaveLength(0);
  });

  it('accepts a same-file additive fix guarded by a helper that is INVOKED, not merely read (N10/R20)', async () => {
    // The fixture body is valid TypeScript without annotations so the test
    // can import and EXECUTE the actual guard (the .ts extension is
    // irrelevant to the frozen diff; the behavior is what the note claims).
    const guardedHelper = 'export function helper(ref) {\n  if (!ref.includes("/")) throw new Error("malformed ref");\n  return ref.slice(ref.indexOf("/") + 1);\n}\n';
    const h = priorHarness({
      audit: {
        prior_index: 0,
        status: 'fixed',
        note: 'src/helper.ts now rejects refs without a separator before slicing, so the unvalidated prefix strip is unreachable.',
      },
      afterPrior: (repo) => {
        repo.commitFile('src/helper.ts', guardedHelper);
      },
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(result.priorDispositions[0]?.status).toBe('fixed');
    // The fixture keeps the old line behind a guard: the honest note names
    // the GUARD (the actual change), not a false removal claim.
    expect(readFileSync(join(h.repo.path, 'src/helper.ts'), 'utf8')).toContain('return ref.slice(ref.indexOf("/") + 1);');
    expect(readFileSync(join(h.repo.path, 'src/helper.ts'), 'utf8')).toContain('throw new Error("malformed ref")');
    expect(result.priorDispositions[0]?.note).toContain('unreachable');
    // R20: the guard is invoked with malformed and valid input — reading
    // its text or the note proves nothing about behavior.
    const moduleRoot = temp('perkins-guard-invoke-');
    const moduleFile = join(moduleRoot, 'guarded-helper.mjs');
    writeFileSync(moduleFile, guardedHelper, 'utf8');
    const { helper } = await import(pathToFileURL(moduleFile).href);
    expect(() => helper('noslash')).toThrow(/malformed ref/);
    expect(helper('prefix/value')).toBe('value');
  });

  it('still-present priors carry their original round marker and are not double-counted', async () => {
    const h = priorHarness({
      audit: { prior_index: 0, status: 'still-present', note: 'The helper still strips without validation.' },
      leadFinding: groundedFinding('lead', 'warning', {
        title: 'Native settings token reaches the prefix stripper',
        location: 'src/helper.ts:1',
        evidence: 'return ref.slice(ref.indexOf("/") + 1);',
      }),
    });
    const result = await h.run();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.roundOrigin).toBe(1);
  });

  it('demands exactly one disposition per prior finding and reports every gap at once', async () => {
    const h = priorHarness({
      audit: { prior_index: 0, status: 'fixed', note: 'fixed honestly' },
      submitPayload: (_attempt, submission) => ({ ...submission, prior_dispositions: [] }),
      preflight: { calls: 1, mutate: (submission) => ({ ...submission, prior_dispositions: [] }) },
    });
    await expect(h.run()).rejects.toThrow(/prior finding 0 has no disposition/);
    const preflight = JSON.parse(h.preflightResults[0]!.text) as { ok: boolean; errors: Array<{ rule: string }> };
    expect(preflight.ok).toBe(false);
    expect(preflight.errors.map((error) => error.rule)).toContain('prior-coverage');
  });

  it('rejects schema violations exhaustively: bad verdict, bad source, missing keys, bad severity', async () => {
    const h = wholeHarness({
      ...ALL_CLEAN,
      submitPayload: (_attempt, submission) => ({
        ...submission,
        verdict: ['READY TO MERGE'],
        findings: [{ severity: 'fatal', category: 'x', title: 't', location: 'N/A', evidence: 'N/A', recommended_fix: 'f', source: 'mystery' }],
      }),
      submitRetries: 0,
      preflight: { calls: 1, mutate: (submission) => ({ ...submission, verdict: 'SHIP IT' }) },
    });
    // One rejection names every violation at once.
    const rejection = await h.run().then(() => { throw new Error('expected rejection'); }, (error: Error) => error.message);
    for (const rule of ['submission-verdict', 'finding-source', 'finding-severity', 'finding-schema']) {
      expect(rejection).toContain(rule);
    }
    const preflight = JSON.parse(h.preflightResults[0]!.text) as { ok: boolean; errorCount: number; errors: Array<{ rule: string }> };
    expect(preflight.ok).toBe(false);
    expect(preflight.errors.map((error) => error.rule)).toContain('submission-verdict');
  });

  it('report rejection: a missing verdict is refused', async () => {
    const h = wholeHarness({
      ...ALL_CLEAN,
      submitPayload: (_attempt, submission) => ({ ...submission, verdict: undefined }) as never,
      submitRetries: 0,
    });
    await expect(h.run()).rejects.toThrow(/submission-verdict/);
  });

  it('report rejection: an empty report is refused', async () => {
    const h = wholeHarness({
      ...ALL_CLEAN,
      submitPayload: (_attempt, submission) => ({ ...submission, report_markdown: '' }) as never,
      submitRetries: 0,
    });
    await expect(h.run()).rejects.toThrow(/report-shape/);
  });

  it('report rejection: a report omitting the verdict line is refused', async () => {
    const h = wholeHarness({
      ...ALL_CLEAN,
      submitPayload: (_attempt, submission) => ({
        ...submission,
        report_markdown: submission.report_markdown.replace(/\*\*Verdict: READY TO MERGE\*\*/, '**Verdict: UNKNOWN**'),
      }) as never,
      submitRetries: 0,
    });
    await expect(h.run()).rejects.toThrow(/report-verdict/);
  });

  it('report rejection: a report omitting the frozen identity is refused', async () => {
    const h = wholeHarness({
      ...ALL_CLEAN,
      submitPayload: (_attempt, submission) => ({
        ...submission,
        report_markdown: submission.report_markdown.replace(/^Frozen target: .+$/m, 'Frozen target: redacted'),
      }) as never,
      submitRetries: 0,
    });
    await expect(h.run()).rejects.toThrow(/report-identity/);
  });

  it('preflight is free and exhaustive; a rejected submission is corrected and accepted within the real attempt bound', async () => {
    const h = wholeHarness({
      ...ALL_CLEAN,
      preflight: {
        calls: 2,
        mutate: (submission) => ({ ...submission, verdict: 'SHIP IT' }),
      },
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(h.preflightResults).toHaveLength(2);
    for (const preflight of h.preflightResults) {
      expect(preflight.terminate).toBeUndefined();
      const parsed = JSON.parse(preflight.text) as { ok: boolean; errorCount: number };
      expect(parsed.ok).toBe(false);
      expect(parsed.errorCount).toBeGreaterThan(0);
    }
    expect(existsSync(join(h.frozen.directory, 'lead/preflight-attempt-1.json'))).toBe(true);
    expect(existsSync(join(h.frozen.directory, 'lead/preflight-attempt-2.json'))).toBe(true);
  });

  it('the third real terminal submission is refused even when preflights were free', async () => {
    const h = wholeHarness({
      ...ALL_CLEAN,
      preflight: { calls: 3 },
      submitPayload: () => ({ verdict: 'SHIP IT', findings: [], prior_dispositions: [], report_markdown: 'nope' }),
      submitRetries: 2,
    });
    await expect(h.run()).rejects.toThrow(/terminal submission attempts exhausted/);
    const submitErrors = h.toolErrors.filter((entry) => entry.tool === 'perkins_submit_review');
    expect(submitErrors).toHaveLength(3);
    // The first two are schema rejections; only the third trips the bound.
    expect(submitErrors.slice(0, 2).every((entry) => /submission-verdict/.test(entry.error))).toBe(true);
    expect(submitErrors[2]?.error).toMatch(/terminal submission attempts exhausted/);
  });

  it('a lead that never submits fails the review without approval', async () => {
    const h = wholeHarness({ ...ALL_CLEAN, neverSubmit: true });
    await expect(h.run()).rejects.toThrow(/exited without an accepted terminal submission/);
  });

  it('cancellation is always INCOMPLETE, never approval', async () => {
    const h = wholeHarness(ALL_CLEAN);
    const controller = new AbortController();
    controller.abort(new Error('service shutdown'));
    await expect(h.frozen && new PerkinsWholeReview({
      spawner: fakeWholeSpawner(temp('perkins-whole-sessions-cancel-'), ALL_CLEAN).spawner,
      policy: loadPerkinsPolicy(),
    }).run({
      roundId: 'whole-round', roundNumber: 1, frozenReview: h.frozen,
      movementRef: 'feature/review', noSpec: false, signal: controller.signal,
    })).rejects.toThrow(/service shutdown/);
  });

  it('a moved source ref rejects a conclusive verdict and accepts only INCOMPLETE', async () => {
    const h = wholeHarness({
      ...ALL_CLEAN,
      beforeSubmit: () => {
        h.repo.git(['checkout', 'feature/review']);
        h.repo.commitFile('src/main.ts', 'export function answer(): number {\n  return 44;\n}\n');
      },
      submitRetries: 1,
      // Attempt 1 conclusive (rejected for head-move); attempt 2 fail-closed.
      submitPayload: (attempt, submission) => (attempt === 1
        ? submission
        : { ...submission, verdict: 'INCOMPLETE', report_markdown: submission.report_markdown.replace(/\*\*Verdict: [^*]+\*\*/, '**Verdict: INCOMPLETE**') }),
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('INCOMPLETE');
    expect(result.headMoved).toBe(true);
    const first = h.toolErrors.find((entry) => entry.tool === 'perkins_submit_review');
    expect(first?.error).toMatch(/head-moved/);
  });

  it('a local base advance alone keeps the frozen target valid: preflight ok, READY accepted, base provenance kept', async () => {
    const h = wholeHarness({
      ...ALL_CLEAN,
      preflight: { calls: 1 },
      // `main` advances (a merge lands) before preflight and submit; the
      // reviewed branch and the checkout are untouched.
      beforeSubmit: () => { advanceBranch(h.repo, 'main'); },
    }, { baseRef: 'main' });
    const result = await h.run();
    expect(h.repo.git(['rev-parse', 'main'])).not.toBe(h.base);
    expect(h.frozen.manifest.baseRef).toBe('main');
    expectBaseAdvanceAccepted(h, result);
  });

  it('an advertised remote base advance alone keeps the frozen target valid', async () => {
    let origin = '';
    const h = wholeHarness({
      ...ALL_CLEAN,
      preflight: { calls: 1 },
      // origin's main advances on the host only: the local tracking ref
      // stays at the frozen base, so the advertised tip alone moved.
      beforeSubmit: () => { advanceBranch(h.repo, 'main', origin); },
    }, {
      baseRef: 'origin/main',
      beforeFreeze: (repo) => {
        origin = attachBareOrigin(repo);
        repo.git(['push', '--quiet', 'origin', 'refs/heads/main']);
      },
    });
    const result = await h.run();
    expect(h.repo.git(['rev-parse', 'refs/remotes/origin/main'])).toBe(h.base);
    expect(h.repo.git(['ls-remote', 'origin', 'refs/heads/main']).split(/\s+/u)[0]).not.toBe(h.base);
    expect(h.frozen.manifest.baseRef).toBe('origin/main');
    expectBaseAdvanceAccepted(h, result);
  });

  it('a target move alongside a base advance still rejects a conclusive verdict', async () => {
    const h = wholeHarness({
      ...ALL_CLEAN,
      beforeSubmit: () => {
        advanceBranch(h.repo, 'main');
        advanceBranch(h.repo, 'feature/review');
      },
      submitRetries: 1,
      submitPayload: incompleteOnRetry,
    }, { baseRef: 'main' });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('INCOMPLETE');
    expect(result.headMoved).toBe(true);
    const first = h.toolErrors.find((entry) => entry.tool === 'perkins_submit_review');
    expect(first?.error).toMatch(/head-moved.*target-moved/);
  });

  it('an untracked file in the review checkout rejects a conclusive verdict as head-moved', async () => {
    const h = wholeHarness({
      ...ALL_CLEAN,
      beforeSubmit: () => { writeFileSync(join(h.repo.path, 'stray.txt'), 'outside the target commit\n'); },
      submitRetries: 1,
      submitPayload: incompleteOnRetry,
    }, { baseRef: 'main' });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('INCOMPLETE');
    expect(result.headMoved).toBe(true);
    const first = h.toolErrors.find((entry) => entry.tool === 'perkins_submit_review');
    expect(first?.error).toMatch(/head-moved.*checkout-changed/);
  });

  it('a rewritten base (main replaced by an orphan commit) still rejects a conclusive verdict', async () => {
    let orphan = '';
    const h = wholeHarness({
      ...ALL_CLEAN,
      // A force-push that drops the frozen merge-base: the new `main` does
      // not descend from diffBaseSha, so the PR delta can exceed the frozen
      // diff even though the reviewed branch is untouched.
      beforeSubmit: () => {
        orphan = h.repo.git([
          '-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid',
          'commit-tree', 'main^{tree}', '-m', 'main rewritten during review',
        ]);
        h.repo.git(['update-ref', 'refs/heads/main', orphan]);
      },
      submitRetries: 1,
      submitPayload: incompleteOnRetry,
    }, { baseRef: 'main' });
    const result = await h.run();
    expect(h.repo.git(['rev-parse', 'main'])).toBe(orphan);
    expect(h.repo.git(['rev-list', '--max-parents=0', 'main'])).toBe(orphan);
    expect(result.canonicalVerdict).toBe('INCOMPLETE');
    expect(result.headMoved).toBe(true);
    const first = h.toolErrors.find((entry) => entry.tool === 'perkins_submit_review');
    expect(first?.error).toMatch(/head-moved.*base-rewritten/);
  });

  it('a deleted base ref still rejects a conclusive verdict', async () => {
    const h = wholeHarness({
      ...ALL_CLEAN,
      // The frozen base no longer resolves (deleted or retargeted away):
      // reviewed-target validity cannot be shown, so it fails closed.
      beforeSubmit: () => { h.repo.git(['update-ref', '-d', 'refs/heads/main']); },
      submitRetries: 1,
      submitPayload: incompleteOnRetry,
    }, { baseRef: 'main' });
    const result = await h.run();
    expect(() => h.repo.git(['rev-parse', '--verify', '--quiet', 'refs/heads/main'])).toThrow();
    expect(result.canonicalVerdict).toBe('INCOMPLETE');
    expect(result.headMoved).toBe(true);
    const first = h.toolErrors.find((entry) => entry.tool === 'perkins_submit_review');
    expect(first?.error).toMatch(/head-moved.*base-unresolvable/);
  });

  it('a git remote lookup failure rejects a conclusive verdict with its error', async () => {
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const shimDir = temp('perkins-git-shim-');
    const shim = join(shimDir, 'git');
    const credentialUrl = 'https://user:secret-token@code.example.invalid/acme/fixture?access_token=another-secret';
    writeFileSync(shim, `#!/bin/sh\ncase " $* " in *" remote "*) printf '%s\\n' "fatal: unable to access '${credentialUrl}': simulated remote listing failure" >&2; exit 2;; esac\nexec "${realGit}" "$@"\n`);
    chmodSync(shim, 0o755);
    const h = wholeHarness({ ...ALL_CLEAN, submitRetries: 1, submitPayload: incompleteOnRetry });
    const oldPath = process.env.PATH;
    try {
      process.env.PATH = `${shimDir}:${oldPath ?? ''}`;
      const result = await h.run();
      expect(result.canonicalVerdict).toBe('INCOMPLETE');
      expect(result.headMoved).toBe(true);
      const first = h.toolErrors.find((entry) => entry.tool === 'perkins_submit_review');
      expect(first?.error).toMatch(/head-moved.*check-failed.*simulated remote listing failure/);
      expect(first?.error).not.toContain('secret-token');
      expect(first?.error).not.toContain('another-secret');
      expect(result.sourceMovement).toEqual({
        cause: 'check-failed',
        detail: "fatal: unable to access '[REDACTED URL]': simulated remote listing failure",
      });
    } finally {
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
    }
  });

  it('a base rewound to the frozen merge-base still contains it and keeps the frozen target valid', async () => {
    let mergeBase = '';
    const h = wholeHarness({
      ...ALL_CLEAN,
      preflight: { calls: 1 },
      // `main` is rewound below the frozen base tip but still contains the
      // frozen merge-base: the ancestry anchor is diffBaseSha, not baseRefSha.
      beforeSubmit: () => { h.repo.git(['update-ref', 'refs/heads/main', h.frozen.manifest.diffBaseSha]); },
    }, {
      baseRef: 'main',
      // `main` is already ahead of the branch point at freeze time, so the
      // frozen base tip and the frozen merge-base differ.
      beforeFreeze: (repo) => {
        mergeBase = repo.git(['rev-parse', 'main']);
        advanceBranch(repo, 'main');
      },
    });
    expect(h.frozen.manifest.baseRefSha).toBe(h.base);
    expect(h.frozen.manifest.diffBaseSha).toBe(mergeBase);
    expect(h.frozen.manifest.baseRefSha).not.toBe(h.frozen.manifest.diffBaseSha);
    const result = await h.run();
    expect(h.repo.git(['rev-parse', 'main'])).toBe(mergeBase);
    expect(h.preflightResults).toHaveLength(1);
    expect(JSON.parse(h.preflightResults[0]!.text)).toMatchObject({ ok: true, errorCount: 0 });
    expect(h.toolErrors.filter((entry) => entry.tool === 'perkins_submit_review')).toEqual([]);
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(result.headMoved).toBe(false);
    const consolidated = JSON.parse(readFileSync(join(result.artifactDirectory, 'consolidated.json'), 'utf8')) as {
      complete: boolean; headMoved: boolean; frozen: Record<string, unknown>;
    };
    expect(consolidated.complete).toBe(true);
    expect(consolidated.headMoved).toBe(false);
    const frozenProvenance = { baseRefSha: h.base, diffBaseSha: mergeBase, targetSha: h.target, diffSha256: h.frozen.manifest.diffSha256 };
    expect(consolidated.frozen).toMatchObject(frozenProvenance);
    expect(JSON.parse(readFileSync(join(h.frozen.directory, 'manifest.json'), 'utf8'))).toMatchObject(frozenProvenance);
  });

  it('a failed specialist run is an honest execution fact — never a missing reviewer and never a block', async () => {
    let testsAnswers = 0;
    const h = wholeHarness({
      childAnswer: (prompt) => {
        if (prompt.includes('"source": "tests"')) {
          testsAnswers += 1;
          return 'not json at all';
        }
        return '[]';
      },
    });
    const result = await h.run();
    // Both attempts on the tests lens failed; the review still completed on
    // the lead's own whole-change verification.
    expect(testsAnswers).toBe(2);
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    const failedRuns = result.specialistRuns.filter((run) => run.lens === 'tests');
    expect(failedRuns).toHaveLength(2);
    expect(failedRuns.every((run) => run.status === 'invalid' && run.failureKind === 'output')).toBe(true);
    const consolidated = JSON.parse(readFileSync(join(result.artifactDirectory, 'consolidated.json'), 'utf8')) as {
      complete: boolean; specialistRuns: Array<{ lens: string; status: string }> ;
    };
    expect(consolidated.complete).toBe(true);
    expect(consolidated.specialistRuns.filter((run) => run.lens === 'tests')).toHaveLength(2);
    // Failed test-quality findings are findings about the change, not proof
    // the reviewer is missing: the round still reaches a conclusive verdict.
    expect(result.findings).toHaveLength(0);
  });

  it('bounds specialist attempts per lens: a third run after two failures is refused', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => (prompt.includes('"source": "tests"') ? 'not json' : '[]'),
      specialists: ['tests'],
      probeExhausted: 'tests',
    });
    // Both attempts on the tests lens fail; the lead's further run on the
    // exhausted lens is refused while the review itself still completes.
    const result = await h.run();
    expect(h.childCalls).toHaveLength(2);
    expect(h.toolErrors.some((entry) =>
      entry.tool === 'perkins_run_specialists' && /specialist tests exhausted its attempts/.test(entry.error),
    )).toBe(true);
    expect(result.specialistRuns).toHaveLength(2);
    expect(result.specialistRuns.every((run) => run.status === 'invalid')).toBe(true);
  });

  it('refuses duplicate lenses inside one run call and the lead proceeds with one real run', async () => {
    const h = wholeHarness({
      childAnswer: () => '[]',
      specialists: ['blind', 'edge'],
      duplicateRun: 'blind',
    });
    const result = await h.run();
    expect(h.toolErrors.some((entry) =>
      entry.tool === 'perkins_run_specialists' && /cannot duplicate a lens/.test(entry.error),
    )).toBe(true);
    expect(result.specialistRuns.map((run) => run.lens).sort()).toEqual(['blind', 'edge']);
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
  });

  it('refuses a specialist rerun of a lens that already has a valid result', async () => {
    const h = wholeHarness({
      childAnswer: () => '[]',
      specialists: ['blind'],
      rerunValid: 'blind',
    });
    const result = await h.run();
    expect(result.specialistRuns).toHaveLength(1);
    expect(h.toolErrors.some((entry) =>
      entry.tool === 'perkins_run_specialists' && /specialist blind already has a valid result/.test(entry.error),
    )).toBe(true);
    // The refused rerun spawned nothing new.
    expect(h.childCalls).toHaveLength(1);
  });

  it('refuses an unknown lens before any spawn or attempt charge, and a later valid call still runs', async () => {
    const h = wholeHarness({
      childAnswer: () => '[]',
      specialists: ['blind', 'mystery'],
      probes: [['blind']],
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(h.toolErrors.some((entry) =>
      entry.tool === 'perkins_run_specialists' && /not in this review's specialist catalog/.test(entry.error),
    )).toBe(true);
    // The refused call spawned nothing and charged nothing: the only real
    // child is the post-refusal valid call, on attempt 1.
    expect(h.childCalls).toHaveLength(1);
    expect(result.specialistRuns).toMatchObject([{ lens: 'blind', attempt: 1, status: 'valid' }]);
    expect(h.probeOutcomes).toEqual([{ lenses: ['blind'], ok: true }]);
  });

  it('a child citing evidence from another file fails its attempt and a corrected retry is accepted', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => {
        if (!prompt.includes('"source": "security"')) return '[]';
        if (prompt.includes('RETRY CORRECTION')) {
          return JSON.stringify([groundedFinding('security', 'warning', {
            location: 'src/main.ts:1',
            evidence: 'export function answer(): number {',
          })]);
        }
        // First attempt: location cites src/main.ts but the evidence is
        // quoted from README.md — not locatable at the cited file.
        return JSON.stringify([groundedFinding('security', 'warning', {
          location: 'src/main.ts:1',
          evidence: 'Fixture repository for dispatch-flow tests.',
        })]);
      },
      specialists: ['security'],
    });
    const result = await h.run();
    // First security attempt invalid (evidence pairing), retry valid.
    const securityRuns = result.specialistRuns.filter((run) => run.lens === 'security');
    expect(securityRuns.map((run) => run.status)).toEqual(['invalid', 'valid']);
    expect(result.findings).toHaveLength(1);
  });

  it('serves the exact host rejection as a corrective instruction on the specialist retry', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => {
        if (!prompt.includes('"source": "edge"')) return '[]';
        if (prompt.includes('RETRY CORRECTION')) return '[]';
        return JSON.stringify([groundedFinding('edge', 'warning', { evidence: 'not in the tree anywhere' })]);
      },
      specialists: ['edge'],
    });
    await h.run();
    const edgePrompts = h.childCalls.filter((call) => call.prompt!.includes('"source": "edge"')).map((call) => call.prompt!);
    expect(edgePrompts).toHaveLength(2);
    expect(edgePrompts[1]).toContain('RETRY CORRECTION (attempt 2)');
    expect(edgePrompts[1]).toContain('Previous output rejected (output)');
  });

  it('native-tool specialists submit only through perkins_submit_findings; text is never parsed back', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => (prompt.includes('Your lens id is "security"') ? JSON.stringify([{
        severity: 'note', category: 'note', title: 'native tool note', location: 'src/main.ts:2',
        evidence: '  return 43;', detail: 'A grounded note through the tool path.', recommended_fix: 'None needed.',
      }]) : '[]'),
      childNativeTools: 'tool',
      specialists: ['security'],
    });
    const result = await h.run();
    const security = result.specialistRuns.find((run) => run.lens === 'security');
    expect(security?.status).toBe('valid');
    expect(result.findings).toHaveLength(1);
    const envelopeFiles = readdirSync(join(result.artifactDirectory, 'specialists'))
      .filter((name) => name.startsWith('security.') && name.endsWith('.envelope.json'));
    expect(envelopeFiles).toHaveLength(1);
    const envelope = JSON.parse(readFileSync(join(result.artifactDirectory, 'specialists', envelopeFiles[0]!), 'utf8')) as { status: string; findings: unknown[] };
    expect(envelope.status).toBe('valid');
    expect(envelope.findings).toHaveLength(1);
  });

  it('recovers fenced and preamble-wrapped output for text-path specialists', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => {
        if (!prompt.includes('"source": "architecture"')) return '[]';
        return 'Here is my review:\n```json\n[]\n```\nthanks';
      },
      specialists: ['architecture'],
    });
    const result = await h.run();
    const architecture = result.specialistRuns.find((run) => run.lens === 'architecture');
    expect(architecture?.status).toBe('valid');
    const envelopeFiles = readdirSync(join(result.artifactDirectory, 'specialists'))
      .filter((name) => name.startsWith('architecture.') && name.endsWith('.envelope.json'));
    const envelope = JSON.parse(readFileSync(join(result.artifactDirectory, 'specialists', envelopeFiles[0]!), 'utf8')) as { recovery?: string };
    expect(envelope.recovery).toBe('parsed-from-fence');
  });

  it('exposes a bounded prior-revision reader only on re-review and reads real frozen deltas', async () => {
    let list: { changes: Array<{ newPath: string | null; status: string }> } | null = null;
    let selected: { diff: string; path: string } | null = null;
    const h = priorHarness({
      audit: { prior_index: 0, status: 'fixed', note: 'caller changed' },
      onPriorRevision: (listRaw, selectedRaw) => {
        list = listRaw as typeof list;
        selected = selectedRaw as typeof selected;
      },
      priorRevisionPath: 'src/caller.ts',
    });
    await h.run();
    const leadTools = h.leadCalls[0]!.options.reviewLead!.nativeTools.map((tool) => tool.name);
    expect(leadTools).toContain('perkins_read_prior_revision');
    expect(list).not.toBeNull();
    expect(list!.changes.map((change) => change.newPath)).toContain('src/caller.ts');
    expect(selected).not.toBeNull();
    expect(selected!.path).toBe('src/caller.ts');
    expect(selected!.diff).toContain('+const selected = nativeSetting;');
    // A first review (no prior) gets no reader at all.
    const fresh = wholeHarness(ALL_CLEAN);
    await fresh.run();
    const freshTools = fresh.leadCalls[0]!.options.reviewLead!.nativeTools.map((tool) => tool.name);
    expect(freshTools).not.toContain('perkins_read_prior_revision');
  });

  it('exposes bounded store-artifact and refuses duplicates', async () => {
    const h = wholeHarness({
      ...ALL_CLEAN,
      storeArtifact: { name: 'note.md', content: 'lead note' },
      duplicateArtifact: true,
    });
    await h.run();
    expect(existsSync(join(h.frozen.directory, 'lead/notes/note.md'))).toBe(true);
    expect(h.toolErrors.some((entry) => entry.tool === 'perkins_store_artifact' && /limit or duplicate/.test(entry.error))).toBe(true);
  });

  it('loads a legacy schemaVersion-2 hybrid prior record read-only and requires honest dispositions', async () => {
    const h = priorHarness({
      audit: { prior_index: 0, status: 'still-present', note: 'still broken' },
      legacyPrior: true,
    });
    const result = await h.run();
    expect(result.priorDispositions[0]?.status).toBe('still-present');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.roundOrigin).toBe(1);
    // The legacy prior file itself is untouched.
    const priorFile = h.priorFile;
    expect(readFileSync(priorFile, 'utf8')).toContain('"chunks"');
  });
});

interface PriorHarness {
  readonly repo: FixtureRepo;
  readonly priorFile: string;
  readonly leadCalls: ReturnType<typeof fakeWholeSpawner>['leadCalls'];
  readonly toolErrors: ReturnType<typeof fakeWholeSpawner>['toolErrors'];
  readonly preflightResults: ReturnType<typeof fakeWholeSpawner>['preflightResults'];
  run(): Promise<PerkinsWholeResult>;
}

/** A re-review harness: a prior round cited src/helper.ts, then the caller
 * changed (cross-file) or the helper itself changed (same-file). */
function priorHarness(options: {
  readonly audit?: { prior_index: number; status: 'fixed' | 'still-present'; note: string; refresh?: { location?: string; evidence?: string; severity?: 'blocker' | 'warning' | 'note' } };
  readonly afterPrior?: (repo: FixtureRepo) => void;
  readonly legacyPrior?: boolean;
  readonly leadFinding?: ReturnType<typeof groundedFinding>;
  readonly submitPayload?: WholeLeadOptions['submitPayload'];
  readonly preflight?: WholeLeadOptions['preflight'];
  readonly onPriorRevision?: WholeLeadOptions['onPriorRevision'];
  readonly priorRevisionPath?: string;
}): PriorHarness & { run: () => Promise<PerkinsWholeResult> } {
  const repo = makeFixtureRepo('whole-prior');
  repos.push(repo);
  const base = repo.head();
  repo.git(['checkout', '-b', 'feature/review']);
  repo.commitFile('src/helper.ts', 'export function helper(ref: string): string { return ref.slice(ref.indexOf("/") + 1); }\n');
  const priorTarget = repo.commitFile('src/caller.ts', 'const unchanged = true;\nconst selected = nativeRef;\n');
  const afterPrior = options.afterPrior ?? ((repository: FixtureRepo) => {
    repository.commitFile('src/caller.ts', 'const unchanged = true;\nconst selected = nativeSetting;\n');
  });
  afterPrior(repo);
  const root = temp('perkins-whole-prior-');
  const priorFile = join(root, 'prior.json');
  const priorFinding = groundedFinding('security', 'warning', {
    title: 'Native settings token reaches the prefix stripper', location: 'src/helper.ts:1',
    evidence: 'return ref.slice(ref.indexOf("/") + 1);',
  });
  writeFileSync(priorFile, JSON.stringify(options.legacyPrior === true ? {
    schemaVersion: 2,
    frozen: { targetSha: priorTarget, diffBaseSha: base },
    findings: [{
      ...priorFinding,
      sources: ['security'], chunks: ['001'], roundOrigin: 1,
      verification: { disposition: 'confirmed', evidence: 'return ref.slice(ref.indexOf("/") + 1);', reason: 'verified in prior round' },
    }],
  } : {
    schemaVersion: 3,
    architecture: 'perkins-whole-pr',
    canonicalVerdict: 'NEEDS CHANGES',
    complete: true,
    headMoved: false,
    findings: [{
      ...priorFinding,
      sources: ['security'], roundOrigin: 1,
      verification: { disposition: 'confirmed', evidence: 'return ref.slice(ref.indexOf("/") + 1);', reason: 'verified in prior round' },
    }],
    frozen: { targetSha: priorTarget, diffBaseSha: base },
  }));
  const frozen = freezeReviewInputs({
    roundId: 'whole-prior-round', repoPath: repo.path, artifactRoot: root,
    baseRef: base, targetRef: repo.head(), movementRef: 'feature/review', spec: 'preserve native settings selection',
  });
  const fake = fakeWholeSpawner(temp('perkins-whole-prior-sessions-'), {
    childAnswer: () => '[]',
    specialists: [],
    preflight: options.preflight ?? { calls: 1 },
    submitRetries: options.submitPayload === undefined ? 0 : 1,
    ...(options.submitPayload === undefined ? {} : { submitPayload: options.submitPayload }),
    ...(options.leadFinding === undefined ? {} : { leadFinding: options.leadFinding }),
    ...(options.onPriorRevision === undefined ? {} : { onPriorRevision: options.onPriorRevision }),
    ...(options.priorRevisionPath === undefined ? {} : { priorRevisionPath: options.priorRevisionPath }),
    priorDisposition: () => [options.audit ?? { prior_index: 0, status: 'still-present', note: 'still present by judgment' }],
  });
  const engine = new PerkinsWholeReview({ spawner: fake.spawner, policy: loadPerkinsPolicy() });
  return {
    repo, priorFile,
    leadCalls: fake.leadCalls,
    toolErrors: fake.toolErrors,
    preflightResults: fake.preflightResults,
    run: () => engine.run({
      roundId: 'whole-prior-round', roundNumber: 2, frozenReview: frozen,
      movementRef: 'feature/review', noSpec: false, priorConsolidatedFile: priorFile,
    }),
  };
}

describe('whole-PR engine: independent-review repairs', () => {
  it('an over-bound specialist batch commits its real runs and never hides them as unused (B7)', async () => {
    // 200 schema-valid findings per lens, each quoting a real ~3.8 KiB
    // substring of the (padded) frozen file: one lens fits the transport,
    // two in one batch exceed the wire frame.
    const bulk = (lens: string): string => JSON.stringify(
      Array.from({ length: 200 }, (_unused, index) => ({
        source: lens, severity: 'note', category: 'bulk', title: `${lens} bulk finding ${index}`,
        location: 'src/main.ts:2', evidence: `  return 43; /*${'x'.repeat(3_800)}`,
        detail: 'Bulk finding to exceed the response bound.', recommended_fix: 'None needed.',
      })),
    );
    const h = wholeHarness({
      childAnswer: (prompt) => {
        const lens = /"source": "(security|codebase)"/u.exec(prompt)?.[1];
        return lens === undefined ? '[]' : bulk(lens);
      },
      specialists: ['security', 'codebase'],
    }, {
      beforeFreeze: (repo) => {
        repo.git(['checkout', 'feature/review']);
        repo.commitFile('src/main.ts', `export function answer(): number {\n  return 43; /*${'x'.repeat(3_950)}*/\n}\n`);
      },
    });
    const result = await h.run();
    // Both specialists really ran and produced valid envelopes...
    const validRuns = result.specialistRuns.filter((run) => run.status === 'valid');
    expect(validRuns.map((run) => run.lens).sort()).toEqual(['codebase', 'security']);
    const envelopeFiles = readdirSync(join(result.artifactDirectory, 'specialists')).filter((name) => name.endsWith('.envelope.json'));
    expect(envelopeFiles).toHaveLength(2);
    // ...but their oversized batch could not be delivered: the honest
    // transport error is reported, the runs are NOT "not used".
    expect(h.toolErrors.some((entry) =>
      entry.tool === 'perkins_run_specialists' &&
      /exceeds the bounded (serialized )?tool response.*recorded but their findings were not delivered/.test(entry.error),
    )).toBe(true);
    // The lead still completes its own whole-change review honestly.
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    const receipt = JSON.parse(readFileSync(join(result.artifactDirectory, 'lead/receipt.json'), 'utf8')) as { specialistRuns: number };
    expect(receipt.specialistRuns).toBe(2);
  }, 120_000);

  it('refusals that a child would satisfy are checked before any spawn (B7)', async () => {
    const h = wholeHarness({
      childAnswer: () => 'not json',
      neverSubmit: true,
      specialists: ['tests'],
      probeExhausted: 'tests',
    });
    await h.run().catch(() => undefined); // the lead never submits in this scenario
    // Both tests attempts failed; the further run is refused BEFORE
    // spawning — a refusal must never strand a started child.
    expect(h.childCalls).toHaveLength(2);
    expect(h.toolErrors.some((entry) =>
      entry.tool === 'perkins_run_specialists' && /specialist tests exhausted its attempts/.test(entry.error),
    )).toBe(true);
  });

  it('a terminal submission is serialized behind an in-flight specialist batch and seals the complete run record (B8)', async () => {
    let releaseChild: (() => void) | null = null;
    const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
    const h = wholeHarness({
      childAnswer: async (prompt) => {
        if (prompt.includes('"source": "blind"')) await childGate;
        return '[]';
      },
      neverSubmit: true,
      specialists: [],
    });
    const runPromise = h.run().then(() => undefined, () => undefined);
    // Wait for the lead session to spawn, then race submit against the
    // still-running blind specialist through the very tool instances the
    // engine handed the lead.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const leadTools = h.leadCalls[0]!.options.reviewLead!.nativeTools;
    const runTool = leadTools.find((tool) => tool.name === 'perkins_run_specialists') as NativeAgentTool;
    const submitTool = leadTools.find((tool) => tool.name === 'perkins_submit_review') as NativeAgentTool;
    const targetSha = h.frozen.manifest.targetSha;
    const baseSha = h.frozen.manifest.diffBaseSha;
    const batch = runTool.execute({ runs: [{ lens: 'blind' }] }).then(() => 'batch', (error: Error) => `batch-error:${error.message}`);
    const submission = submitTool.execute({
      verdict: 'READY TO MERGE',
      findings: [],
      prior_dispositions: [],
      report_markdown: `# Perkins Code Review\n\n**Verdict: READY TO MERGE**\n\nFrozen target: ${targetSha}\nFrozen base: ${baseSha}\n`,
    }).then(() => 'submitted', (error: Error) => `submit-error:${error.message}`);
    // While the specialist is gated, neither call may complete.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    let settled = false;
    await Promise.race([Promise.all([batch, submission]).then(() => { settled = true; }), new Promise((resolve) => setTimeout(resolve, 200))]);
    expect(settled).toBe(false);
    releaseChild!();
    const [batchOutcome, submitOutcome] = await Promise.all([batch, submission]);
    expect(batchOutcome).toBe('batch');
    expect(submitOutcome).toBe('submitted');
    await runPromise;
    // The accepted review sealed AFTER the batch committed: the blind run
    // is in the durable record, not discarded.
    const envelopes = readdirSync(join(h.frozen.directory, 'specialists')).filter((name) => name.startsWith('blind.'));
    expect(envelopes.length).toBeGreaterThan(0);
  });

  it('rejects a lead finding attributed to a lens that never ran (N1)', async () => {
    const h = wholeHarness({
      ...ALL_CLEAN,
      leadFinding: groundedFinding('security', 'warning'),
      submitRetries: 0,
    });
    const rejection = await h.run().then(() => { throw new Error('expected rejection'); }, (error: Error) => error.message);
    expect(rejection).toContain('names a lens with no valid specialist result');
  });

  it('accepts a provenance-clean lead finding and rejects an unknown source', async () => {
    const clean = wholeHarness({
      ...ALL_CLEAN,
      leadFinding: groundedFinding('lead', 'warning'),
    });
    const cleanResult = await clean.run();
    expect(cleanResult.findings[0]?.source).toBe('lead');

    const h = wholeHarness({
      ...ALL_CLEAN,
      leadFinding: groundedFinding('mystery' as never, 'warning'),
      submitRetries: 0,
    });
    await expect(h.run()).rejects.toThrow(/finding-source/);
  });

  it('allows a still-present prior to refresh its citation and severity while keeping its origin (N2)', async () => {
    const h = priorHarness({
      audit: {
        prior_index: 0,
        status: 'still-present',
        note: 'The helper moved but still strips without validation.',
        refresh: { location: 'src/helper.ts:2', severity: 'note' },
      },
    });
    const result = await h.run();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.location).toBe('src/helper.ts:2');
    expect(result.findings[0]?.severity).toBe('note');
    expect(result.findings[0]?.roundOrigin).toBe(1);
  });

  it('strips legacy v2 chunk fields from newly written v3 records (N9)', async () => {
    const h = priorHarness({
      audit: { prior_index: 0, status: 'still-present', note: 'still present' },
      legacyPrior: true,
    });
    const result = await h.run();
    const consolidated = readFileSync(join(result.artifactDirectory, 'consolidated.json'), 'utf8');
    expect(consolidated).not.toContain('"chunks"');
    // The legacy prior file itself stays untouched.
    expect(readFileSync(h.priorFile, 'utf8')).toContain('"chunks"');
  });

  it('rejects a report that reads issue-free beside retained findings (B10 coherence)', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => (prompt.includes('"source": "security"')
        ? JSON.stringify([groundedFinding('security', 'blocker')])
        : '[]'),
      submitRetries: 0,
      transformReport: (report) => report
        .replace(/### blocker — security grounded defect\nSource: security · Location: src\/main\.ts:1\nThe exact changed function demonstrates the defect\.\nFix: Correct the function and retain a regression test\.\n/, '')
        .replace(/\[\d+\] still-present: .+/g, ''),
    });
    await expect(h.run()).rejects.toThrow(/report-coherence/);
  });

  it('bounds the report by exact UTF-8 bytes including multibyte overflow (C123)', async () => {
    // Near-limit pass: pad a valid report to exactly ten bytes under the cap.
    const fit = wholeHarness({
      ...ALL_CLEAN,
      transformReport: (report) => {
        const budget = 128 * 1024 - 10 - Buffer.byteLength(report, 'utf8');
        return `${report}${'y'.repeat(Math.max(budget, 0))}`;
      },
    });
    await expect(fit.run()).resolves.toMatchObject({ canonicalVerdict: 'READY TO MERGE' });
    // Overflow: multibyte stars push the byte count past the cap even though
    // the character count stays far below it.
    const overflow = wholeHarness({
      ...ALL_CLEAN,
      submitRetries: 0,
      transformReport: (report) => {
        const budget = 128 * 1024 - 10 - Buffer.byteLength(report, 'utf8');
        return `${report}${'y'.repeat(Math.max(budget, 0))}${'★'.repeat(16)}`;
      },
    });
    await expect(overflow.run()).rejects.toThrow(/report_markdown exceeds 131072 UTF-8 bytes/);
  });

  it('marks a native-tool child that never calls the tool invalid even with finding-shaped text (C079)', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => (prompt.includes('Your lens id is "edge"')
        ? JSON.stringify([groundedFinding('edge', 'note')])
        : '[]'),
      childNativeTools: 'text-only',
      specialists: ['edge'],
    });
    const result = await h.run();
    const edgeRuns = result.specialistRuns.filter((run) => run.lens === 'edge');
    expect(edgeRuns.every((run) => run.status === 'invalid')).toBe(true);
    expect(result.findings).toHaveLength(0);
    const envelopeFiles = readdirSync(join(result.artifactDirectory, 'specialists'))
      .filter((name) => name.startsWith('edge.') && name.endsWith('.envelope.json'));
    for (const name of envelopeFiles) {
      const envelope = JSON.parse(readFileSync(join(result.artifactDirectory, 'specialists', name), 'utf8')) as { status: string; error?: string };
      expect(envelope.status).toBe('invalid');
      expect(envelope.error).toMatch(/did not submit findings via perkins_submit_findings/);
    }
  });

  it('prior-revision listing is truthful for added and deleted files (N3/E1)', async () => {
    const h = priorHarness({
      audit: { prior_index: 0, status: 'fixed', note: 'caller changed' },
      onPriorRevision: () => {},
      afterPrior: (repo) => {
        repo.commitFile('src/caller.ts', 'const unchanged = true;\nconst selected = nativeSetting;\n');
        repo.commitFile('src/brand-new.ts', 'export const fresh = true;\n');
      },
    });
    await h.run();
    // Drive the reader directly for the truthful listing shape.
    const tool = h.leadCalls[0]!.options.reviewLead!.nativeTools
      .find((entry) => entry.name === 'perkins_read_prior_revision') as NativeAgentTool;
    const listing = JSON.parse((await tool.execute({})).text) as { changes: Array<{ status: string; oldPath: string | null; newPath: string | null }> };
    const caller = listing.changes.find((change) => change.newPath === 'src/caller.ts' || change.oldPath === 'src/caller.ts');
    expect(caller?.status).toBe('M');
    expect(caller?.oldPath).toBe('src/caller.ts');
    expect(caller?.newPath).toBe('src/caller.ts');
    // An added file (present only at the current target) has NO old path.
    const added = listing.changes.find((change) => change.newPath !== null && change.oldPath === null);
    expect(added).toBeDefined();
    expect(added!.status).toBe('A');
  });

  it('prior-revision path reads defeat -diff attributes and refuse ambiguous selections (N3/H7/H8)', async () => {
    const repo = makeFixtureRepo('whole-reader-attrs');
    repos.push(repo);
    const base = repo.head();
    repo.git(['checkout', '-b', 'feature/reader']);
    repo.commitFile('src/old-caller.ts', 'export const oldSetting = nativeRef;\n');
    const priorTarget = repo.head();
    // The current target hides the old file's diff text via -diff and
    // replaces a deleted file with a directory of the same name.
    repo.commitFile('src/old-caller.ts', 'export const oldSetting = nativeSetting;\n');
    repo.commitFile('.gitattributes', 'src/old-caller.ts -diff\n');
    // A file deleted and replaced by a directory of the same name.
    repo.commitFile('src/replaced.txt', 'original single file\n');
    repo.git(['rm', '-q', 'src/replaced.txt']);
    repo.commitFile('src/replaced.txt/child.txt', 'inside the replacement directory\n');
    const root = temp('perkins-reader-');
    const priorFile = join(root, 'prior.json');
    writeFileSync(priorFile, JSON.stringify({
      schemaVersion: 3,
      architecture: 'perkins-whole-pr',
      canonicalVerdict: 'NEEDS CHANGES', complete: true, headMoved: false,
      findings: [],
      frozen: { targetSha: priorTarget, diffBaseSha: base },
    }));
    const frozen = freezeReviewInputs({
      roundId: 'reader-round', repoPath: repo.path, artifactRoot: root,
      baseRef: base, targetRef: repo.head(), movementRef: 'feature/reader', spec: 'reader',
    });
    const fake = fakeWholeSpawner(temp('perkins-reader-sessions-'), {
      childAnswer: () => '[]',
      specialists: [],
      onPriorRevision: () => {},
    });
    const engine = new PerkinsWholeReview({ spawner: fake.spawner, policy: loadPerkinsPolicy() });
    await engine.run({
      roundId: 'reader-round', roundNumber: 2, frozenReview: frozen,
      movementRef: 'feature/reader', noSpec: false, priorConsolidatedFile: priorFile,
    });
    const tool = fake.leadCalls[0]!.options.reviewLead!.nativeTools
      .find((entry) => entry.name === 'perkins_read_prior_revision') as NativeAgentTool;
    // -diff attributes must not suppress the earlier text.
    const readable = JSON.parse((await tool.execute({ path: 'src/old-caller.ts' })).text) as { diff: string };
    expect(readable.diff).toContain('-export const oldSetting = nativeRef;');
    expect(readable.diff).toContain('+export const oldSetting = nativeSetting;');
    // A file replaced by a directory is ambiguous: refuse, never silently
    // return descendant hunks.
    await expect(tool.execute({ path: 'src/replaced.txt' })).rejects.toThrow(/ambiguous/);
  });
});

describe('whole-PR engine: six-blocker specialist-cleanup repairs (T13)', () => {
  const childOnly = (call: WholeSpawnCall): boolean => call.options.reviewLead === undefined;
  const securityOnly = (call: WholeSpawnCall): boolean =>
    call.options.reviewLead === undefined && (call.prompt ?? '').includes('"source": "security"');

  it('keeps a settled valid result when its dispose rejects, recording the cleanup failure distinctly', async () => {
    const h = wholeHarness({
      ...ALL_CLEAN,
      specialists: ['security'],
      disposeRejects: childOnly,
    });
    const result = await h.run();
    const run = result.specialistRuns.find((entry) => entry.lens === 'security');
    expect(run?.status).toBe('valid');
    expect(h.childCalls.every((call) => call.disposeRejected === true)).toBe(true);
    const disposeErrors = readdirSync(join(result.artifactDirectory, 'specialists'))
      .filter((name) => name.endsWith('.dispose-error.json'));
    expect(disposeErrors).toHaveLength(1);
    const recorded = JSON.parse(readFileSync(join(result.artifactDirectory, 'specialists', disposeErrors[0]!), 'utf8')) as { error?: string; agentId?: string };
    expect(recorded.error).toContain('simulated session dispose failure');
    expect(recorded.agentId).toBe(h.childCalls[0]?.agentId);
    // The run's real work stands: clean completion, no "not used" erasure.
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
  });

  it('records a failed child alongside its cleanup error without faking success', async () => {
    const h = wholeHarness({
      childAnswer: () => 'not json',
      specialists: ['tests'],
      disposeRejects: childOnly,
    });
    const result = await h.run();
    const runs = result.specialistRuns.filter((entry) => entry.lens === 'tests');
    expect(runs.length).toBe(2);
    expect(runs.every((entry) => entry.status === 'invalid')).toBe(true);
    expect(result.findings).toHaveLength(0);
    const specialists = readdirSync(join(result.artifactDirectory, 'specialists'));
    expect(specialists.filter((name) => name.endsWith('.dispose-error.json'))).toHaveLength(runs.length);
    for (const name of specialists.filter((entry) => entry.startsWith('tests.') && entry.endsWith('.envelope.json'))) {
      const envelope = JSON.parse(readFileSync(join(result.artifactDirectory, 'specialists', name), 'utf8')) as { status?: string; failureKind?: string };
      expect(envelope.status).toBe('invalid');
      expect(envelope.failureKind).toBe('output');
    }
    // Both failed attempts are honest evidence, never restored as unused.
    const receipt = JSON.parse(readFileSync(join(result.artifactDirectory, 'lead/receipt.json'), 'utf8')) as { specialistRuns?: number };
    expect(receipt.specialistRuns).toBe(runs.length);
  });

  it('commits successful siblings when another sibling dispose rejects', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => (prompt.includes('"source": "security"')
        ? JSON.stringify([groundedFinding('security', 'blocker')])
        : '[]'),
      specialists: ['security', 'codebase', 'edge'],
      disposeRejects: securityOnly,
    });
    const result = await h.run();
    const statuses = Object.fromEntries(result.specialistRuns.map((run) => [run.lens, run.status]));
    expect(statuses).toEqual({ security: 'valid', codebase: 'valid', edge: 'valid' });
    const disposeErrors = readdirSync(join(result.artifactDirectory, 'specialists'))
      .filter((name) => name.startsWith('security.') && name.endsWith('.dispose-error.json'));
    expect(disposeErrors).toHaveLength(1);
    // The security blocker survives its cleanup failure: the verdict counts it.
    expect(result.canonicalVerdict).toBe('NEEDS CHANGES');
    expect(result.findings.some((finding) => finding.source === 'security' && finding.severity === 'blocker')).toBe(true);
  });

  it('seals a terminal submission only after a gated sibling batch with a dispose rejection commits', async () => {
    let releaseChild: (() => void) | null = null;
    const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
    const h = wholeHarness({
      childAnswer: async (_prompt, call) => {
        if (call.options.reviewLead === undefined) await childGate;
        return '[]';
      },
      neverSubmit: true,
      specialists: [],
      disposeRejects: childOnly,
    });
    const runPromise = h.run().then(() => undefined, () => undefined);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const leadTools = h.leadCalls[0]!.options.reviewLead!.nativeTools;
    const runTool = leadTools.find((tool) => tool.name === 'perkins_run_specialists') as NativeAgentTool;
    const submitTool = leadTools.find((tool) => tool.name === 'perkins_submit_review') as NativeAgentTool;
    const targetSha = h.frozen.manifest.targetSha;
    const baseSha = h.frozen.manifest.diffBaseSha;
    const batch = runTool.execute({ runs: [{ lens: 'blind' }] }).then(() => 'batch', (error: Error) => `batch-error:${error.message}`);
    const submission = submitTool.execute({
      verdict: 'READY TO MERGE',
      findings: [],
      prior_dispositions: [],
      report_markdown: `# Perkins Code Review\n\n**Verdict: READY TO MERGE**\n\nFrozen target: ${targetSha}\nFrozen base: ${baseSha}\n`,
    }).then(() => 'submitted', (error: Error) => `submit-error:${error.message}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    let settled = false;
    await Promise.race([Promise.all([batch, submission]).then(() => { settled = true; }), new Promise((resolve) => setTimeout(resolve, 200))]);
    expect(settled).toBe(false);
    releaseChild!();
    const [batchOutcome, submitOutcome] = await Promise.all([batch, submission]);
    expect(batchOutcome).toBe('batch');
    expect(submitOutcome).toBe('submitted');
    await runPromise;
    const specialists = readdirSync(join(h.frozen.directory, 'specialists'));
    expect(specialists.some((name) => name.startsWith('blind.') && name.endsWith('.envelope.json'))).toBe(true);
    expect(specialists.filter((name) => name.startsWith('blind.') && name.endsWith('.dispose-error.json'))).toHaveLength(1);
  });
});

describe('packaged product and terminal-frame coverage (N6)', () => {
  it('packs, extracts, verifies, and MCP-smokes the rebuilt source-free product under an empty home', async () => {
    const productRoot = join(import.meta.dirname, '..');
    const packRoot = temp('perkins-pack-source-');
    const tarRoot = temp('perkins-pack-tar-');
    const extractRoot = temp('perkins-pack-extract-');
    const emptyHome = temp('perkins-source-free-home-');
    mkdirSync(join(emptyHome, '.pi', 'agent', 'skills'), { recursive: true });
    for (const entry of [
      'package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'LICENSE', 'install.sh',
      'src', 'resources', 'roles', 'tools', 'install',
    ]) cpSync(join(productRoot, entry), join(packRoot, entry), { recursive: true });
    // web's tsc typechecks its e2e specs, which import the shared real-service
    // helper from the parent tree — the pack staging needs it for build:web.
    mkdirSync(join(packRoot, 'test', 'helpers'), { recursive: true });
    for (const entry of ['real-service.mjs', 'real-service.d.mts']) {
      cpSync(join(productRoot, 'test', 'helpers', entry), join(packRoot, 'test', 'helpers', entry));
    }
    mkdirSync(join(packRoot, 'web'), { recursive: true });
    for (const entry of [
      'package.json', 'tsconfig.json', 'vite.config.ts', 'vitest.config.ts', 'playwright.config.ts',
      'index.html', 'src', 'mock', 'e2e',
    ]) {
      cpSync(join(productRoot, 'web', entry), join(packRoot, 'web', entry), { recursive: true });
    }
    symlinkSync(join(productRoot, 'node_modules'), join(packRoot, 'node_modules'), 'dir');
    mkdirSync(join(packRoot, 'dist'), { recursive: true });
    mkdirSync(join(packRoot, 'web', 'dist'), { recursive: true });
    writeFileSync(join(packRoot, 'dist', 'stale-before-prepack.txt'), 'must be cleaned', 'utf8');
    writeFileSync(join(packRoot, 'web', 'dist', 'stale-before-prepack.txt'), 'must be cleaned', 'utf8');

    const packOutput = execFileSync('npm', ['pack', '--json', '--pack-destination', tarRoot], {
      cwd: packRoot,
      encoding: 'utf8',
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, HOME: emptyHome, PI_CODING_AGENT_DIR: join(emptyHome, '.pi', 'agent') },
    });
    const jsonStart = packOutput.lastIndexOf('\n[\n  {');
    const packed = JSON.parse(packOutput.slice(jsonStart === -1 ? packOutput.indexOf('[') : jsonStart + 1)) as
      Array<{ filename: string; files: Array<{ path: string }> }>;
    const packedFiles = packed[0]?.files.map((entry) => entry.path).sort() ?? [];
    expect(packedFiles).toEqual(expect.arrayContaining([
      'dist/dispatch/perkins-review/policy.js',
      'dist/dispatch/perkins-review/whole.js',
      'dist/runtime/review-mcp-bridge.js',
      'dist/runtime/review-mcp-server.mjs',
      'resources/perkins-code-review/policy.json',
      'resources/silas-skills/ops-dispatch/SKILL.md',
      'tools/verify-perkins-resource.mjs',
      'install.sh',
      'install/launchd/com.gru-command.service.plist.template',
      'install/systemd/gru-command.service.template',
      'roles/perkins.md',
      'roles/minion.md',
      'roles/silas.md',
      'roles/gru.md',
      'roles/bob.md',
      'web/dist/index.html',
    ]));
    const excludedMarker = ['j', 'ev'].join('');
    expect(packedFiles.some((file) =>
      file.startsWith('src/') || file.startsWith('_bmad/') || file.toLowerCase().includes(excludedMarker),
    )).toBe(false);
    expect(packedFiles).not.toContain('dist/stale-before-prepack.txt');
    expect(packedFiles).not.toContain('web/dist/stale-before-prepack.txt');

    execFileSync('tar', ['-xzf', join(tarRoot, packed[0]!.filename), '-C', extractRoot]);
    const stage = join(extractRoot, 'package');
    expect(existsSync(join(stage, 'src'))).toBe(false);
    // A real install resolves the shipped dist's bare imports through the
    // dependency tree npm puts beside the package (the tarball itself never
    // carries node_modules) — mirror that here so the smoke's
    // `import('./dist/roles.js')` leg exercises the installed loading path.
    symlinkSync(join(productRoot, 'node_modules'), join(stage, 'node_modules'), 'dir');
    // The shipped artifact carries the minion-owned BMAD workflow playbook
    // in the packaged personas (owner ruling 2026-10-02; clarification
    // j-761): the STAGED minion prompt — read from the tarball extract, not
    // the developer checkout — must select the task-relevant installed BMAD
    // skills from the project's actual catalog and its fresh-reviewer
    // cycle, and the staged ops skill must not commission a duplicate
    // review.
    const stagedMinion = readFileSync(join(stage, 'roles', 'minion.md'), 'utf-8').replace(/\s+/gu, ' ');
    expect(stagedMinion).toContain("the PROJECT's actual installed skill catalog and metadata");
    expect(stagedMinion).toContain('select by capability from what the project really has installed');
    expect(stagedMinion).toContain('You own the selected workflow end to end');
    expect(stagedMinion).toContain('fresh, context-free tracked review jobs');
    expect(stagedMinion).not.toContain('pi -p');
    expect(stagedMinion).not.toContain('claude -p');
    expect(stagedMinion).not.toContain('headless print mode');
    expect(stagedMinion).toContain('an inline self-review is not a substitute');
    expect(stagedMinion).toContain('Project-local BMAD setup');
    expect(stagedMinion).toContain('Approved work runs to its end without a new go-ahead');
    expect(stagedMinion).toContain('A failed attempt is not a destroyed undertaking');
    expect(stagedMinion).toContain('binding playbook obligations, not runtime guarantees');
    expect(stagedMinion).toContain('the review is the gate, and the owner holds every merge');
    expect(stagedMinion).toContain('reconcile it by job identity');
    expect(stagedMinion).toContain('Report outcomes truthfully');
    expect(stagedMinion).toContain('an older delivery is history');
    expect(stagedMinion).not.toMatch(/bmad-[a-z][a-z-]*/u);
    const stagedOps = readFileSync(join(stage, 'resources', 'silas-skills', 'ops-dispatch', 'SKILL.md'), 'utf-8').replace(/\s+/gu, ' ');
    expect(stagedOps).toContain("own their workflows' built-in review on fresh independent reviewer contexts");
    expect(stagedOps).toContain('separately tracked review jobs');
    expect(stagedOps).toContain('nested-admission capability gap');
    expect(stagedOps).toContain('do not advance the lane past its recorded review commission');
    expect(stagedOps).toContain('a blocked row');
    expect(stagedOps).toContain('never one to wait on');
    expect(stagedOps).toContain('dispatch the reviewer yourself');
    expect(stagedOps).toContain('escalation_id');
    expect(stagedOps).toContain('retires the standing obligation by');
    expect(stagedOps).toContain('Mark non-PR dispatches by kind');
    expect(stagedOps).toContain('The owner holds ALL merges');
    expect(stagedOps).not.toContain('The chief holds merge authority');
    expect(stagedOps).toContain('never demand a fixed skill name');
    expect(stagedOps).toContain('do not commission a supplementary review duplicating');
    expect(stagedOps).toContain('native Perkins round on the exact final settled PR head');
    expect(stagedOps).toContain('it is the gate, never a duplicate review');
    expect(stagedOps).toContain('Continuous completion (owner contract 2026-10-02)');
    expect(stagedOps).toContain('Active owned work');
    expect(stagedOps).toContain('never hold the fleet behind one long');
    expect(stagedOps).toContain('queue timeout is not a test result');
    expect(stagedOps).toContain('binding playbook obligations, not implemented guarantees');
    expect(stagedOps).toContain('its PASS is not Perkins READY');
    expect(stagedOps).toContain('escalate the missing Perkins gate');
    expect(stagedOps).toContain('Outcome truth (owner clarification 2026-10-02)');
    expect(stagedOps).toContain('never emit a success-delivery fact because control returned');
    expect(stagedOps).toContain('never compensate by reopening delivered jobs or building');
    // The shipped worker prompt points at this README section: prove the
    // heading travels in the installed package.
    // README phrases may wrap across markdown lines — flatten first (same
    // rule as the staged persona/ops checks above).
    const stagedReadme = readFileSync(join(stage, 'README.md'), 'utf-8').replace(/\s+/gu, ' ');
    expect(stagedReadme).toContain('### Project-local BMAD setup');
    // The shipped README carries the corrected fallback-gate semantics too.
    expect(stagedReadme).toContain('its PASS is not a Perkins READY');
    expect(stagedReadme).not.toContain('0 blockers means clear to merge');
    const stagedOpsTokens = [...stagedOps.matchAll(/bmad-[a-z][a-z-]*/gu)].map((match) => match[0]);
    expect(stagedOpsTokens.every((token) => token === 'bmad-review' || token === 'bmad-review-fallback')).toBe(true);
    expect(() => execFileSync(process.execPath, [join(stage, 'tools', 'verify-perkins-resource.mjs'), stage], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: emptyHome, PI_CODING_AGENT_DIR: join(emptyHome, '.pi', 'agent') },
    })).not.toThrow();

    const smokeFile = join(stage, 'source-free-smoke.mjs');
    writeFileSync(smokeFile, `
      import { readFileSync, realpathSync } from 'node:fs';
      import { spawn } from 'node:child_process';
      import { loadPerkinsPolicy } from './dist/dispatch/perkins-review/policy.js';
      import { ReviewMcpBridge } from './dist/runtime/review-mcp-bridge.js';
      const { ROLE_DEFINITIONS } = await import('./dist/roles.js');
      // The shipped prompts are markdown: phrases may wrap across lines,
      // so flatten before substring checks (the vitest pins do the same).
      const flatten = (text) => text.replace(/\\s+/g, ' ');
      const minionPrompt = flatten(ROLE_DEFINITIONS.minion.systemPrompt);
      const silasPrompt = flatten(ROLE_DEFINITIONS.silas.systemPrompt);
      const gruPrompt = flatten(ROLE_DEFINITIONS.gru.systemPrompt);
      if (!minionPrompt.includes("the PROJECT's actual installed skill catalog and metadata") ||
          !minionPrompt.includes('fresh, context-free tracked review jobs') ||
          minionPrompt.includes('claude -p') ||
          !minionPrompt.includes('Approved work runs to its end without a new go-ahead') ||
          /bmad-[a-z][a-z-]*/.test(minionPrompt)) {
        throw new Error('staged minion prompt lacks the BMAD workflow playbook');
      }
      if (!silasPrompt.includes("selects the task-relevant BMAD skills from the project's actual installed catalog") ||
          !silasPrompt.includes('never ask the owner to say continue') ||
          silasPrompt.includes('bmad-build')) {
        throw new Error('staged silas prompt lacks the minion-owned build cycle');
      }
      if (!gruPrompt.includes('Hand workers the whole build')) {
        throw new Error('staged gru prompt lacks the whole-build handoff');
      }
      // Staged compiled ops-skill loader probe (bmad-review deferral row 36):
      // the ops skill must load through its own module-relative loader from
      // the tarball extract, not only be present as text or loaded from the
      // checkout.
      const { loadSilasSkills } = await import('./dist/dispatch/silas-driver.js');
      const opsSkills = loadSilasSkills();
      if (opsSkills.length !== 2 ||
          opsSkills.some((skill) => skill.body.length === 0) ||
          !opsSkills[0].body.includes('Continuous completion (owner contract 2026-10-02)')) {
        throw new Error('staged ops skills did not load through the compiled loader');
      }
      // The second staged skill's BODY is the shipped ledger-closeout
      // instruction, not merely a nonempty file (bmad-review 795b0b6).
      if (opsSkills[1].name !== 'ledger-closeout' ||
          !opsSkills[1].body.includes('If it is not in the ledger, it did not happen')) {
        throw new Error('staged ledger-closeout skill body is not the shipped skill');
      }
      const bridge = await ReviewMcpBridge.start([{
        name: 'perkins_probe', description: 'staged probe', inputSchema: { type: 'object' },
        execute: async () => ({ text: 'stage-ok' }),
      }]);
      const config = JSON.parse(readFileSync(bridge.configFile, 'utf8'));
      const server = config.mcpServers.gru_perkins;
      if (realpathSync(server.args[0]) !== realpathSync('./dist/runtime/review-mcp-server.mjs')) {
        throw new Error('MCP server escaped the staged product');
      }
      const child = spawn(server.command, server.args, {
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...server.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let buffered = '';
      const waiters = new Map();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffered += chunk;
        for (;;) {
          const newline = buffered.indexOf('\\n');
          if (newline === -1) break;
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          if (line.trim() === '') continue;
          const message = JSON.parse(line);
          if (message.id !== undefined && waiters.has(message.id)) {
            waiters.get(message.id)(message);
            waiters.delete(message.id);
          }
        }
      });
      const call = (id, method, params) => {
        const response = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('staged MCP timeout: ' + method)), 5000);
          waiters.set(id, (message) => { clearTimeout(timer); resolve(message); });
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\\n');
        return response;
      };
      try {
        const initialized = await call(1, 'initialize', { protocolVersion: '2099-arbitrary', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
        const listed = await call(2, 'tools/list', {});
        const called = await call(3, 'tools/call', { name: 'perkins_probe', arguments: {} });
        process.stdout.write(JSON.stringify({
          identity: loadPerkinsPolicy().identity,
          protocolVersion: initialized.result.protocolVersion,
          listed: JSON.stringify(listed).includes('perkins_probe'),
          called: JSON.stringify(called).includes('stage-ok'),
        }));
      } finally {
        child.kill('SIGTERM');
        await bridge.close();
      }
    `, 'utf8');
    const smoke = JSON.parse(execFileSync(process.execPath, [smokeFile], {
      cwd: stage,
      encoding: 'utf8',
      timeout: 10_000,
      env: { PATH: process.env.PATH ?? '', HOME: emptyHome, PI_CODING_AGENT_DIR: join(emptyHome, '.pi', 'agent') },
    })) as { identity: string; protocolVersion: string; listed: boolean; called: boolean };
    expect(smoke).toEqual({
      identity: 'perkins-code-review', protocolVersion: '2024-11-05', listed: true, called: true,
    });
  }, 360_000);

  it('finalAssistantText rejects a failed Claude terminal frame and non-assistant JSON (C116)', () => {
    const root = temp('perkins-terminal-frame-');
    const failed = join(root, 'failed.jsonl');
    writeFileSync(failed, [
      `${JSON.stringify({ role: 'assistant', text: 'partial answer', stopReason: 'stop' })}`,
      `${JSON.stringify({ type: 'result', is_error: true, result: 'exceeds max tokens' })}`,
      '',
    ].join('\n'), 'utf8');
    expect(() => finalAssistantText(failed)).toThrow(/did not complete successfully/);

    const nonAssistant = join(root, 'non-assistant.jsonl');
    writeFileSync(nonAssistant, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'run' } })}\n`, 'utf8');
    expect(() => finalAssistantText(nonAssistant)).toThrow(/no assistant JSON output/);
  });
});

describe('review MCP bridge smoke (declared lead tools)', () => {
  it('exposes exactly the declared whole-PR lead tools over a scoped bridge', async () => {
    const tools: NativeAgentTool[] = [
      { name: 'perkins_run_specialists', description: 'run', inputSchema: { type: 'object' }, execute: async () => ({ text: 'ok' }) },
      { name: 'perkins_submit_review', description: 'submit', inputSchema: { type: 'object' }, execute: async () => ({ text: 'ok' }) },
    ];
    const bridge = await ReviewMcpBridge.start(tools);
    const directory = dirname(bridge.configFile);
    try {
      const listed = await new Promise<unknown>((resolve, reject) => {
        const connection = createConnection(bridge.socketPath);
        let body = '';
        connection.setEncoding('utf8');
        connection.once('connect', () => connection.write(`${JSON.stringify({ id: 'probe', name: '__list__', input: {} })}\n`));
        connection.on('data', (chunk: string) => { body += chunk; });
        connection.once('error', reject);
        connection.once('end', () => {
          try {
            const parsed = JSON.parse(body) as { ok: boolean; result?: unknown };
            if (!parsed.ok) reject(new Error('bridge refused'));
            else resolve(parsed.result);
          } catch (error) {
            reject(error as Error);
          }
        });
      });
      expect((listed as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
        'perkins_run_specialists', 'perkins_submit_review',
      ]);
    } finally {
      await bridge.close();
      expect(existsSync(directory)).toBe(false);
    }
  });

});



describe('whole-PR engine: repair pass 3', () => {
  it('keeps a settled valid result when recording its dispose failure ALSO fails, disclosing the recording gap (R10)', async () => {
    let frozenDir = '';
    let edgeDisposes = 0;
    const h = wholeHarness({
      childAnswer: (prompt) => (prompt.includes('"source": "edge"')
        ? JSON.stringify([groundedFinding('edge', 'blocker')])
        : '[]'),
      specialists: ['edge'],
      disposeRejects: (call) => {
        if (call.options.reviewLead === undefined && call.options.isolatedReview !== undefined && edgeDisposes === 0) {
          edgeDisposes += 1;
          // The dispose rejects AND the specialists artifact store becomes
          // unwritable, so writing the dispose-error artifact fails too.
          chmodSync(join(frozenDir, 'specialists'), 0o500);
          return true;
        }
        return false;
      },
      beforeSubmit: () => {
        try { chmodSync(join(frozenDir, 'specialists'), 0o700); } catch { /* already writable */ }
      },
    });
    frozenDir = h.frozen.directory;
    const result = await h.run();
    // The settled edge finding survived: its blocker forces NEEDS CHANGES.
    expect(result.canonicalVerdict).toBe('NEEDS CHANGES');
    const consolidated = JSON.parse(readFileSync(join(result.artifactDirectory, 'consolidated.json'), 'utf8')) as {
      specialistRuns: Array<{ lens: string; status: string; cleanupRecordingError?: string }>;
    };
    const edgeRuns = consolidated.specialistRuns.filter((run) => run.lens === 'edge' && run.status === 'valid');
    expect(edgeRuns.length).toBe(1);
    // The un-recordable cleanup failure is still disclosed durably.
    expect(typeof consolidated.specialistRuns.find((run) => run.lens === 'edge')?.cleanupRecordingError).toBe('string');
  });

  it('durably marks over-bound specialist batches as findings never delivered to the lead (R17)', async () => {
    const bulk = (lens: string): string => JSON.stringify(
      Array.from({ length: 200 }, (_unused, index) => ({
        source: lens, severity: 'note', category: 'bulk', title: `${lens} bulk finding ${index}`,
        location: 'src/main.ts:2', evidence: `  return 43; /*${'x'.repeat(3_800)}`,
        detail: 'Bulk finding to exceed the response bound.', recommended_fix: 'None needed.',
      })),
    );
    const h = wholeHarness({
      childAnswer: (prompt) => {
        const lens = /"source": "(security|codebase)"/u.exec(prompt)?.[1];
        return lens === undefined ? '[]' : bulk(lens);
      },
      specialists: ['security', 'codebase'],
    }, {
      beforeFreeze: (repo) => {
        repo.git(['checkout', 'feature/review']);
        repo.commitFile('src/main.ts', `export function answer(): number {\n  return 43; /*${'x'.repeat(3_950)}*/\n}\n`);
      },
    });
    const result = await h.run();
    const consolidated = JSON.parse(readFileSync(join(result.artifactDirectory, 'consolidated.json'), 'utf8')) as {
      specialistRuns: Array<{ lens: string; status: string; findingsDelivered?: boolean }>;
    };
    const valid = consolidated.specialistRuns.filter((run) => run.status === 'valid');
    expect(valid.map((run) => run.lens).sort()).toEqual(['codebase', 'security']);
    expect(valid.every((run) => run.findingsDelivered === false)).toBe(true);
  }, 120_000);

  it('refuses to credit a valid-but-empty lens for a lead-invented finding (R12)', async () => {
    const h = wholeHarness({
      childAnswer: () => '[]',
      specialists: ['edge'],
      leadFinding: groundedFinding('edge', 'blocker'),
    });
    await expect(h.run()).rejects.toThrow(/finding-source/);
  });

  it('rejects a clean-claiming report that names only one of several retained findings (T11)', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => (prompt.includes('"source": "codebase"')
        ? JSON.stringify([
          groundedFinding('codebase', 'warning', { title: 'first retained problem' }),
          groundedFinding('codebase', 'warning', { title: 'second retained problem' }),
        ])
        : '[]'),
      specialists: ['codebase'],
      transformReport: (report) => report
        // Drop the SECOND finding's whole section (header + its 3 lines)...
        .replace(/### warning \u2014 second retained problem\n(?:[^\n]*\n){0,3}/u, '')
        .replace(/- #\d+ [^\n]*second retained problem[^\n]*\n?/gu, '')
        // ...then assert cleanliness beside the still-retained finding.
        .concat('\nIn summary, no issues remain in this change; the report above is complete.\n'),
    });
    await expect(h.run()).rejects.toThrow(/report-coherence/);
  });

  it('accepts nuanced prose that still accounts for every retained finding (T11)', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => (prompt.includes('"source": "codebase"')
        ? JSON.stringify([
          groundedFinding('codebase', 'warning', { title: 'first retained problem' }),
          groundedFinding('codebase', 'warning', { title: 'second retained problem' }),
        ])
        : '[]'),
      specialists: ['codebase'],
      transformReport: (report) => report
        .concat('\nNote: the blind and edge lenses reported no issues of their own; both retained findings above were verified by the lead and stand.\n'),
    });
    const result = await h.run();
    // Warnings do not force changes; the point is the report's honesty.
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(result.findings).toHaveLength(2);
  });

  it('rejects an all-titles report that explicitly concludes the change is issue-free (R37)', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => (prompt.includes('"source": "edge"')
        ? JSON.stringify([groundedFinding('edge', 'blocker', { title: 'broken guard' })])
        : '[]'),
      specialists: ['edge'],
      submitRetries: 0,
      transformReport: (report) => report
        .concat('\n**In summary, no issues remain in this change; no changes needed; the change is clean.**\n'),
    });
    const rejection = await h.run().then(
      () => { throw new Error('expected rejection'); },
      (error: Error) => error.message,
    );
    expect(rejection).toContain('report-coherence');
    // The rejection names the contradiction, not just the prose.
    expect(rejection).toMatch(/issue-free|clean-slate/u);
    expect(rejection).toMatch(/contradict/u);
  });

  it('accepts a lens-scoped clean statement beside retained findings (R37)', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => (prompt.includes('"source": "edge"')
        ? JSON.stringify([groundedFinding('edge', 'warning')])
        : '[]'),
      specialists: ['edge'],
      transformReport: (report) => report
        .concat('\nNote: the security and codebase lenses found no issues of their own.\n'),
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(result.findings).toHaveLength(1);
  });

  it('accepts a clean statement scoped by an explicit exception (R37)', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => (prompt.includes('"source": "edge"')
        ? JSON.stringify([groundedFinding('edge', 'warning')])
        : '[]'),
      specialists: ['edge'],
      transformReport: (report) => report
        .concat('\nNo issues remain in this change except the retained finding listed above.\n'),
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(result.findings).toHaveLength(1);
  });

  it('classifies clean-slate prose against retained findings (R37 table)', async () => {
    const terminal = [
      '\nNo issues remain.\n',
      '\nNo changes needed.\n',
      '\nThe change is clean.\n',
      '\nNothing needs fixing.\n',
      '\nEverything looks good.\n',
      '\nThe PR requires no further changes.\n',
      '\nThe blind lens found no issues of its own, and the change is clean.\n',
      '\nsrc/main.ts contains the retained defect, but no issues remain in the change.\n',
      '\nNo remaining issues in this change.\n',
      '\nNo issues in this change.\n',
      '\nNo issues remain in src/main.ts.\n',
      '\nThe change is clean, and security review still lists a blocker.\n',
      '\nIt is not true that the change is clean, and no issues remain.\n',
      '\n## Prior review\nThe change is clean.\n',
      '\n## Summary — The change is clean\n',
      '\nNo\nissues remain.\n',
      '\nThe change is\nclean.\n',
      '\nNo issues remain in any files.\n',
      '\nNo issues remain in this PR for src/other.ts.\n',
      '\nNo issues remain in this change, including in src/other.ts.\n',
      '\nSecurity review found a blocker, the change is clean.\n',
      '\nThe change is clean on its own merits.\n',
      '\nThe change is clean because the blind lens found no issues of its own.\n',
      '\n## Prior review\nNo issues remain in PR.\n',
      '\nNo issues remain in this change, though the security specialist found a warning.\n',
    ];
    const scoped = [
      '\nThe blind lens found no issues of its own.\n',
      '\nNo issues remain in src/other.ts.\n',
      '\nNo issues remain except the retained finding above.\n',
      '\nNo new issues were found; the retained finding stands.\n',
      '\n> An earlier report said no issues remain. That conclusion was wrong.\n',
      '\nThe prior reviewer wrote “No issues remain”, but broken guard remains an issue.\n',
      '\nDo not say “The change is clean”; broken guard remains.\n',
      '\nIt is not true that the change is clean; broken guard remains.\n',
      '\nNo issues remain in app.vue.\n',
      '\nNo issues remain in .gitignore.\n',
      '\nNo issues remain from the previous round.\n',
      '\nNo issues remain EXCEPT the retained finding above.\n',
      '\nNo issues remain in scripts/build.\n',
      '\nNo issues remain in src/other file.ts.\n',
      '\nThe security lens found no issues.\n',
      '\nThe performance review reported no issues.\n',
      '\nThe operations review reported no issues.\n',
      '\nThe previous reviewer said the change is clean, but broken guard remains.\n',
      '\nThe prior reviewer incorrectly said the change is clean, but broken guard remains.\n',
      '\n````\n```\nNo issues remain.\n````\n',
      '\nNo blockers remain; the retained finding is only a warning.\n',
      '\nLGTM.\n',
      '\nLGTM; the retained finding is only a warning.\n',
    ];
    const variants = [...terminal, ...scoped];
    let call = 0;
    const h = wholeHarness({
      childAnswer: (prompt) => (prompt.includes('"source": "edge"')
        ? JSON.stringify([groundedFinding('edge', 'warning', { title: 'broken guard' })])
        : '[]'),
      specialists: ['edge'],
      submitRetries: 0,
      preflight: {
        calls: variants.length,
        mutate: (submission) => ({ ...submission, report_markdown: submission.report_markdown + variants[call++]! }),
      },
    });
    const result = await h.run();
    const verdicts = h.preflightResults.map((entry) => (JSON.parse(entry.text) as { ok: boolean }).ok);
    expect(verdicts.slice(0, terminal.length)).toEqual(terminal.map(() => false));
    expect(verdicts.slice(terminal.length).map((ok, index) => [scoped[index], ok])).toEqual(scoped.map((text) => [text, true]));
    // The unmutated submission itself stays accepted.
    expect(result.findings).toHaveLength(1);
  });

  it('applies no clean-conclusion rule when nothing is retained (R37)', async () => {
    const h = wholeHarness({
      ...ALL_CLEAN,
      transformReport: (report) => report.concat('\nNo issues remain; nothing needs changing; the change is clean.\n'),
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(result.findings).toHaveLength(0);
  });

  it('credits a specialist finding at the location it delivered (R38)', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => (prompt.includes('"source": "edge"')
        ? JSON.stringify([groundedFinding('edge', 'blocker', { title: 'broken guard' })])
        : '[]'),
      specialists: ['edge'],
    });
    const result = await h.run();
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ source: 'edge', title: 'broken guard', location: 'src/main.ts:1' });
  });

  it('refuses to credit a lens for a same-title finding the lead relocated (R38)', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => (prompt.includes('"source": "edge"')
        ? JSON.stringify([groundedFinding('edge', 'blocker', { title: 'broken guard' })])
        : '[]'),
      specialists: ['edge'],
      submitRetries: 0,
      findings: (findings) => findings.map((finding) => ({
        ...finding,
        location: 'src/other.ts:7',
        evidence: 'const unrelated = true;',
      })),
    });
    const rejection = await h.run().then(
      () => { throw new Error('expected rejection'); },
      (error: Error) => error.message,
    );
    expect(rejection).toContain('finding-source');
    expect(rejection).toMatch(/broken guard/u);
    expect(rejection).toMatch(/delivered/u);
  });

  it('ignores harmless padding around an otherwise identical specialist location (R38)', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => (prompt.includes('"source": "edge"')
        ? JSON.stringify([groundedFinding('edge', 'warning', { location: ' src/main.ts:1 ' })])
        : '[]'),
      specialists: ['edge'],
      findings: (findings) => findings.map((finding) => ({ ...finding, location: 'src/main.ts:1' })),
    });
    expect((await h.run()).findings[0]?.source).toBe('edge');
  });

  it('rejects a prior-only retained finding plus a contradictory clean conclusion (R37)', async () => {
    const h = priorHarness({ submitPayload: (_attempt, submission) => ({
      ...submission, findings: [],
      report_markdown: `${submission.report_markdown}\nNo issues remain.\n`,
    }) });
    await expect(h.run()).rejects.toThrow(/report-coherence/u);
  });

  it('accepts a historical clean claim in a prior section when every prior was fixed', async () => {
    const h = priorHarness({
      audit: { prior_index: 0, status: 'fixed', note: 'fixed by current changes' },
      leadFinding: groundedFinding('lead', 'warning', {
        title: 'current issue', location: 'src/caller.ts:2', evidence: 'const selected = nativeSetting;',
      }),
      submitPayload: (_attempt, submission) => ({
        ...submission, report_markdown: `${submission.report_markdown}\nNo issues remain from the prior review.\n`,
      }),
    });
    expect((await h.run()).findings).toHaveLength(1);
  });

  it('refuses no-blockers claims while a blocker remains', async () => {
    for (const claim of ['No blockers remain.', 'No blockers in this PR.']) {
      const h = wholeHarness({
        childAnswer: (prompt) => (prompt.includes('"source": "edge"')
          ? JSON.stringify([groundedFinding('edge', 'blocker')]) : '[]'),
        specialists: ['edge'], submitRetries: 0,
        transformReport: (report) => `${report}\n${claim}\n`,
      });
      await expect(h.run()).rejects.toThrow(/report-coherence/u);
    }
  });

  it('does not collapse internal whitespace in a specialist-provenance filename (R38)', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => (prompt.includes('"source": "edge"')
        ? JSON.stringify([groundedFinding('edge', 'warning', { title: 'broken guard', location: 'src/two  spaces.ts:1', evidence: 'export const guard = 43;' })])
        : '[]'),
      specialists: ['edge'],
      submitRetries: 0,
      findings: (findings) => findings.map((finding) => ({ ...finding, location: 'src/two spaces.ts:1', evidence: 'export const guard = 43;' })),
    }, { beforeFreeze: (repo) => {
      repo.commitFile('src/two  spaces.ts', 'export const guard = 43;\n');
      repo.commitFile('src/two spaces.ts', 'export const guard = 43;\n');
    } });
    await expect(h.run()).rejects.toThrow(/finding-source/u);
  });

  it('keeps specialist path case significant (R38)', async () => {
    const h = wholeHarness({
      childAnswer: (prompt) => (prompt.includes('"source": "edge"')
        ? JSON.stringify([groundedFinding('edge', 'warning', {
          title: 'case-sensitive path', location: 'src/main.ts:1', evidence: 'export function answer(): number {',
        })]) : '[]'),
      specialists: ['edge'], submitRetries: 0,
      findings: (findings) => findings.map((finding) => ({ ...finding, location: 'src/Main.ts:1' })),
    });
    await expect(h.run()).rejects.toThrow(/finding-source/u);
  });

  it('handles Git-quoted prior paths and refuses nonexistent or directory-masquerading selections (R11)', async () => {
    const repo = makeFixtureRepo('whole-reader-quoted');
    repos.push(repo);
    const base = repo.head();
    repo.git(['checkout', '-b', 'feature/quoted']);
    repo.commitFile('src/plain.ts', 'export const before = 1;\n');
    const priorTarget = repo.head();
    repo.commitFile('src/plain.ts', 'export const after = 2;\n');
    // A file whose name forces Git header quoting stays as an exact read,
    // and another quoted name is replaced by a directory.
    repo.commitFile('src/we"ird.ts', 'export const quoted = true;\n');
    repo.commitFile('src/re"placed.ts', 'export const original = true;\n');
    repo.git(['rm', '-q', 'src/re"placed.ts']);
    repo.commitFile('src/re"placed.ts/child.ts', 'export const descendant = true;\n');
    const root = temp('perkins-quoted-');
    const priorFile = join(root, 'prior.json');
    writeFileSync(priorFile, JSON.stringify({
      schemaVersion: 3,
      architecture: 'perkins-whole-pr',
      canonicalVerdict: 'NEEDS CHANGES', complete: true, headMoved: false,
      findings: [],
      frozen: { targetSha: priorTarget, diffBaseSha: base },
    }));
    const frozen = freezeReviewInputs({
      roundId: 'quoted-round', repoPath: repo.path, artifactRoot: root,
      baseRef: base, targetRef: repo.head(), movementRef: 'feature/quoted', spec: 'quoted reader',
    });
    const fake = fakeWholeSpawner(temp('perkins-quoted-sessions-'), {
      childAnswer: () => '[]',
      specialists: [],
      onPriorRevision: () => {},
    });
    const engine = new PerkinsWholeReview({ spawner: fake.spawner, policy: loadPerkinsPolicy() });
    await engine.run({
      roundId: 'quoted-round', roundNumber: 2, frozenReview: frozen,
      movementRef: 'feature/quoted', noSpec: false, priorConsolidatedFile: priorFile,
    });
    const tool = fake.leadCalls[0]!.options.reviewLead!.nativeTools
      .find((entry) => entry.name === 'perkins_read_prior_revision') as NativeAgentTool;
    // An ordinary exact-file read still works.
    const plain = JSON.parse((await tool.execute({ path: 'src/plain.ts' })).text) as { diff: string };
    expect(plain.diff).toContain('-export const before = 1;');
    expect(plain.diff).toContain('+export const after = 2;');
    // A Git-quoted name is read exactly (no header-regex bypass).
    const quoted = JSON.parse((await tool.execute({ path: 'src/we"ird.ts' })).text) as { diff: string };
    expect(quoted.diff).toContain('+export const quoted = true;');
    // ...and ANOTHER quoted name replaced by a directory is refused as
    // ambiguous — the descendant hunks are not "one exact file".
    await expect(tool.execute({ path: 'src/re"placed.ts' })).rejects.toThrow(/ambiguous/);
    // A path that is a file in NEITHER revision is not a valid selection.
    await expect(tool.execute({ path: 'src/never-existed.ts' })).rejects.toThrow(/not a file in either revision/);
  });

  it('lists a deleted prior file truthfully as {status:"D"} with newPath null (T15)', async () => {
    const repo = makeFixtureRepo('whole-reader-deleted');
    repos.push(repo);
    const base = repo.head();
    repo.git(['checkout', '-b', 'feature/deleted']);
    repo.commitFile('src/gone.ts', 'export const gone = true;\n');
    const priorTarget = repo.head();
    repo.git(['rm', '-q', 'src/gone.ts']);
    repo.commitFile('src/kept.ts', 'export const kept = true;\n');
    const root = temp('perkins-deleted-');
    const priorFile = join(root, 'prior.json');
    writeFileSync(priorFile, JSON.stringify({
      schemaVersion: 3,
      architecture: 'perkins-whole-pr',
      canonicalVerdict: 'NEEDS CHANGES', complete: true, headMoved: false,
      findings: [],
      frozen: { targetSha: priorTarget, diffBaseSha: base },
    }));
    const frozen = freezeReviewInputs({
      roundId: 'deleted-round', repoPath: repo.path, artifactRoot: root,
      baseRef: base, targetRef: repo.head(), movementRef: 'feature/deleted', spec: 'deleted reader',
    });
    const fake = fakeWholeSpawner(temp('perkins-deleted-sessions-'), {
      childAnswer: () => '[]',
      specialists: [],
      onPriorRevision: () => {},
    });
    const engine = new PerkinsWholeReview({ spawner: fake.spawner, policy: loadPerkinsPolicy() });
    await engine.run({
      roundId: 'deleted-round', roundNumber: 2, frozenReview: frozen,
      movementRef: 'feature/deleted', noSpec: false, priorConsolidatedFile: priorFile,
    });
    const tool = fake.leadCalls[0]!.options.reviewLead!.nativeTools
      .find((entry) => entry.name === 'perkins_read_prior_revision') as NativeAgentTool;
    const listing = JSON.parse((await tool.execute({})).text) as { changes: Array<{ status: string; oldPath: string | null; newPath: string | null }> };
    const deleted = listing.changes.find((change) => change.oldPath === 'src/gone.ts');
    expect(deleted).toEqual({ status: 'D', oldPath: 'src/gone.ts', newPath: null });
  });

  it('lists a type-change prior entry truthfully as {status:"T"} at the same path (R33)', async () => {
    const repo = makeFixtureRepo('whole-reader-typechange');
    repos.push(repo);
    const base = repo.head();
    repo.git(['checkout', '-b', 'feature/typechange']);
    repo.commitFile('src/typed.ts', 'export const typed = 1;\n');
    // PRIOR revision: a gitlink (mode 160000) at src/typed.ts. A gitlink
    // is invisible to the freeze symlink guard, and the target revision
    // restored below is a regular file, so the frozen tree stays clean.
    repo.git(['rm', '-q', 'src/typed.ts']);
    repo.git(['update-index', '--add', '--cacheinfo', `160000,${repo.head()},src/typed.ts`]);
    repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'fixture: gitlink state']);
    const priorTarget = repo.head();
    // TARGET revision: the same path is a regular file again.
    repo.git(['rm', '--cached', '-q', 'src/typed.ts']);
    writeFileSync(join(repo.path, 'src/typed.ts'), 'export const typed = 2;\n', 'utf8');
    repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'add', 'src/typed.ts']);
    repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'fixture: regular file again']);
    const root = temp('perkins-typechange-');
    const priorFile = join(root, 'prior.json');
    writeFileSync(priorFile, JSON.stringify({
      schemaVersion: 3,
      architecture: 'perkins-whole-pr',
      canonicalVerdict: 'NEEDS CHANGES', complete: true, headMoved: false,
      findings: [],
      frozen: { targetSha: priorTarget, diffBaseSha: base },
    }));
    const frozen = freezeReviewInputs({
      roundId: 'typechange-round', repoPath: repo.path, artifactRoot: root,
      baseRef: base, targetRef: repo.head(), movementRef: 'feature/typechange', spec: 'type change reader',
    });
    const fake = fakeWholeSpawner(temp('perkins-typechange-sessions-'), {
      childAnswer: () => '[]',
      specialists: [],
      onPriorRevision: () => {},
    });
    const engine = new PerkinsWholeReview({ spawner: fake.spawner, policy: loadPerkinsPolicy() });
    await engine.run({
      roundId: 'typechange-round', roundNumber: 2, frozenReview: frozen,
      movementRef: 'feature/typechange', noSpec: false, priorConsolidatedFile: priorFile,
    });
    const tool = fake.leadCalls[0]!.options.reviewLead!.nativeTools
      .find((entry) => entry.name === 'perkins_read_prior_revision') as NativeAgentTool;
    const listing = JSON.parse((await tool.execute({})).text) as { changes: Array<{ status: string; oldPath: string | null; newPath: string | null }> };
    // Before the fix the `T` entry fell into the silent-skip branch and the
    // re-reviewer saw an incomplete changed-path list.
    expect(listing.changes).toContainEqual({ status: 'T', oldPath: 'src/typed.ts', newPath: 'src/typed.ts' });
  });

  it('delivers the LAST-file sentinel of a >3000-line multi-file diff to BOTH the lead and specialist prompts (R18)', async () => {
    const sentinel = 'P3-SENTINEL-LAST-FILE-4902';
    const h = wholeHarness({
      childAnswer: () => '[]',
      specialists: ['edge'],
    }, {
      beforeFreeze: (repo) => {
        repo.git(['checkout', 'feature/review']);
        for (const directory of ['src/deep', 'web/deep']) {
          const lines = Array.from({ length: 1_600 }, (_unused, index) => `export const value${index} = ${index};`);
          repo.commitFile(`${directory}/big-a.ts`, `${lines.join('\n')}\n`);
        }
        repo.commitFile('src/deep/big-b.ts', `${Array.from({ length: 20 }, (_unused, index) => `export const tail${index} = ${index};`).join('\n')}\nexport const ${sentinel} = true;\n`);
      },
    });
    await h.run();
    const leadPrompt = h.leadCalls[0]?.prompt ?? '';
    expect(leadPrompt).toContain('--- COMPLETE FROZEN DIFF (the whole change under review) ---');
    expect(leadPrompt).toContain(sentinel);
    const childPrompts = h.childCalls.map((call) => call.prompt ?? '');
    expect(childPrompts.length).toBeGreaterThanOrEqual(1);
    expect(childPrompts.every((prompt) => prompt.includes(sentinel))).toBe(true);
  }, 120_000);
});

describe('standalone default parity (phase 3)', () => {
  it('pins the standalone engine default vs the production-configured default as a deliberate, documented pair', () => {
    expect(STANDALONE_SPECIALIST_CONCURRENCY).toBe(4); // unconfigured/direct-use engine default
    expect(DEFAULT_REVIEW_CHILDREN).toBe(2); // production config default (config.ts)
  });
});

describe('wave refusals never consume lens or round budget (H1)', () => {
  function waveHarness(brain: WholeLeadOptions, wave: number) {
    const fixture = makeReviewRepo('perkins-wave-refusal');
    repos.push(fixture.repo);
    const base = fixture.repo.git(['rev-parse', 'main']);
    const target = fixture.repo.head();
    const root = temp('perkins-wave-refusal-');
    const frozen = freezeReviewInputs({
      roundId: 'wave-refusal-round', repoPath: fixture.repo.path, artifactRoot: root,
      baseRef: base, targetRef: target, movementRef: 'feature/review', spec: 'return 43',
    });
    const fake = fakeWholeSpawner(temp('perkins-wave-sessions-'), brain);
    const engine = new PerkinsWholeReview({
      spawner: fake.spawner,
      policy: loadPerkinsPolicy(),
      maxConcurrentChildren: wave,
      beginChildren: () => ({ concurrency: wave, finish: () => {} }),
    });
    return { fake, engine, frozen };
  }

  it('a refused batch keeps its full attempt budget: re-batched invalid run still gets its policy retry', async () => {
    // The double's first call is the oversized badRuns batch (4 lenses at
    // admitted wave 1 -> refused and RESTORED), then each lens re-batches
    // one at a time; security's first REAL answer is invalid and must still
    // receive its second policy attempt. Under the old bug the refusal had
    // already burned attempt 1, so the invalid real run (attempt 2) left
    // security exhausted with zero valid coverage.
    const h = waveHarness({
      childAnswer: (prompt) => {
        if (!prompt.includes('"source": "security"')) return '[]';
        if (prompt.includes('RETRY CORRECTION')) return '[]';
        // First real attempt: evidence cannot be located at the cited spot.
        return JSON.stringify([groundedFinding('security', 'warning', { evidence: 'not anywhere in the frozen tree' })]);
      },
      badRuns: ['blind', 'edge', 'security', 'architecture'],
    }, 1);
    const result = await h.engine.run({
      roundId: 'wave-refusal-round', roundNumber: 1, frozenReview: h.frozen,
      movementRef: 'feature/review', noSpec: false,
    });
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(h.fake.childCalls).toHaveLength(10); // 9 lenses + security's invalid attempt
    const valid = result.specialistRuns.filter((run) => run.status === 'valid');
    expect(valid).toHaveLength(9); // every catalog lens still ran
    const securityValid = valid.find((run) => run.lens === 'security');
    expect(securityValid?.attempt).toBe(2); // retry survived the refusal
  }, 120_000);

  it('repeated refusals from a stubborn lead exhaust nothing: every lens still runs', async () => {
    const h = waveHarness({ childAnswer: () => '[]', stubbornBatches: 3 }, 1);
    const result = await h.engine.run({
      roundId: 'wave-refusal-round', roundNumber: 1, frozenReview: h.frozen,
      movementRef: 'feature/review', noSpec: false,
    });
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(result.specialistRuns).toHaveLength(9);
    expect(h.fake.childCalls).toHaveLength(9);
    const refusals = h.fake.toolErrors.filter((entry) => entry.error.includes('admitted wave'));
    expect(refusals.length).toBeGreaterThanOrEqual(3); // the stubborn re-issues happened
  }, 120_000);

  it('schedules seven selected lenses as 3+3+1 and nine as 3+3+3 at admitted width 3 inside one lead and frozen target', async () => {
    const catalog = [...PERKINS_LENSES];
    const cases: ReadonlyArray<{ selected: readonly string[]; expected: ReadonlyArray<readonly string[]> }> = [
      { selected: catalog.slice(0, 7), expected: [catalog.slice(0, 3), catalog.slice(3, 6), catalog.slice(6, 7)] },
      { selected: catalog, expected: [catalog.slice(0, 3), catalog.slice(3, 6), catalog.slice(6, 9)] },
    ];
    for (const { selected, expected } of cases) {
      const h = waveHarness({
        childAnswer: (prompt) => {
          const source = /"source": "(blind|tests)"/u.exec(prompt)?.[1];
          return source === undefined ? '[]' : JSON.stringify([groundedFinding(source, 'warning')]);
        },
        specialists: selected,
      }, 3);
      const result = await h.engine.run({
        roundId: 'wave-refusal-round', roundNumber: 1, frozenReview: h.frozen,
        movementRef: 'feature/review', noSpec: false,
      });
      expect(result.canonicalVerdict).toBe('READY TO MERGE');
      // One lead, one frozen target: batches and retries never mint another.
      expect(h.fake.leadCalls).toHaveLength(1);
      expect(result.targetSha).toBe(h.frozen.manifest.targetSha);
      expect(h.fake.childCalls).toHaveLength(selected.length);
      expect(result.specialistRuns).toHaveLength(selected.length);
      expect(result.specialistRuns.every((run) => run.status === 'valid' && run.attempt === 1)).toBe(true);
      // Findings delivered by the FIRST and LAST batch survive together: a
      // batch split is a transport detail, never a dropped or duplicated review.
      expect(result.findings.map((finding) => finding.source).sort()).toEqual(['blind', 'tests']);
      // Every batch is accounted in the SAME single lead receipt: no later
      // batch or retry creates a second round or lead.
      const receipt = JSON.parse(readFileSync(join(result.artifactDirectory, 'lead/receipt.json'), 'utf8')) as { specialistRuns: number };
      expect(receipt.specialistRuns).toBe(selected.length);
      expect(result.artifactDirectory).toContain('wave-refusal-round');
      // The scripted lead opens with the schema-maximum 4-run call at an
      // admitted wave of 3: refused before any child starts and fully
      // restored (each lens still lands on attempt 1), then re-batched.
      expect(h.fake.attemptedBatches[0]).toHaveLength(4);
      expect(h.fake.toolErrors.filter((entry) => entry.error.includes('admitted wave of 3'))).toHaveLength(1);
      expect(h.fake.runBatches).toEqual(expected.map((batch) => [...batch]));
    }
  }, 120_000);

  it('accounts sixteen real runs and refuses an otherwise eligible seventeenth by the round cap, distinct from per-lens exhaustion', async () => {
    const h = wholeHarness({
      childAnswer: () => 'not json',
      specialists: [...PERKINS_LENSES],
      probeExhausted: 'acceptance',
    });
    const result = await h.run();
    // Nine initial attempts fail, then retries interleave with the remaining
    // first attempts; the round stops at exactly 16 accounted runs.
    expect(h.childCalls).toHaveLength(16);
    expect(result.specialistRuns).toHaveLength(16);
    expect(result.specialistRuns.every((run) => run.status !== 'valid')).toBe(true);
    expect(result.specialistRuns.every((run) => run.attempt === 1 || run.attempt === 2)).toBe(true);
    const receipt = JSON.parse(readFileSync(join(result.artifactDirectory, 'lead/receipt.json'), 'utf8')) as { specialistRuns: number };
    expect(receipt.specialistRuns).toBe(16);
    // The refusal is durable coverage truth, not only a transient tool error:
    // the result carries the refused call, the cap, and the runs accounted at
    // refusal time so a report can disclose budget-limited coverage.
    expect(result.budgetRefusals).toMatchObject([{ lenses: ['performance', 'operations'], cap: 16, accountedRuns: 16 }]);
    // The refused call was otherwise per-lens eligible — performance and
    // operations still had one attempt each — and the ROUND budget refuses
    // it before any spawn: both keep their single recorded attempt.
    expect(h.attemptedBatches.at(-1)).toEqual(['performance', 'operations']);
    for (const lens of ['performance', 'operations']) {
      expect(result.specialistRuns.filter((run) => run.lens === lens)).toHaveLength(1);
    }
    const roundRefusals = h.toolErrors.filter((entry) => /exceeds 16 specialist runs/.test(entry.error));
    expect(roundRefusals).toHaveLength(1);
    expect(roundRefusals[0]).toMatchObject({ tool: 'perkins_run_specialists' });
    expect(roundRefusals.every((entry) => !/exhausted its attempts/.test(entry.error))).toBe(true);
    // The per-lens cause stays distinct: an exhausted lens names itself, not
    // the round budget, and its completed attempts remain recorded.
    const lensRefusal = h.toolErrors.find((entry) => /specialist acceptance exhausted its attempts/.test(entry.error));
    expect(lensRefusal).toBeDefined();
    expect(lensRefusal?.error).not.toMatch(/exceeds 16 specialist runs/);
    expect(result.specialistRuns.filter((run) => run.lens === 'acceptance')).toHaveLength(2);
  }, 120_000);
});

describe('provider pacing: combined review-turn gate (owner heist 2026-09-29)', () => {
  it('a lead waiting on its lens wave yields its slot: the round cannot wedge and the cap still holds (r5 liveness)', async () => {
    const events: string[] = [];
    const gate = new PacingGate({
      enabled: true,
      maxConcurrentMinions: 0,
      maxConcurrentReviewTurns: 2,
      record: (event) => events.push(event.kind),
    });
    // A concurrent round's lead holds one of the two combined slots for the
    // whole window — the shape that wedged every concurrent round before the
    // lead-yield fix (holders: concurrent lead + this lead = 2/2, and the
    // wave's child could never be admitted).
    const concurrentLead = await gate.acquireReviewTurn({ id: 'other-round', label: 'other lead' });
    let peak = 0;
    try {
      const h = wholeHarness(
        {
          childAnswer: () => {
            peak = Math.max(peak, gate.view().review.running);
            return '[]';
          },
          specialists: ['blind', 'edge'],
        },
        { reviewGate: gate },
      );
      const running = h.run();
      // Liveness probe, scoped to the one thing under test: with the lead
      // yielding, the wave's first child spawns as soon as the pool runs.
      // Without the yield it can NEVER spawn (both slots held), so this
      // waits out and fails — no wall-clock bound on the rest of the round.
      await vi.waitFor(() => expect(h.childCalls.length).toBeGreaterThan(0), { timeout: 20_000 });
      const result = await running;
      expect(result.canonicalVerdict).toBe('READY TO MERGE');
      expect(h.childCalls).toHaveLength(2);
      // The wave's second lens waited FIFO for the first to release —
      // throttled, never failed, never wedged; the combined cap never broke.
      expect(events).toContain('pacing.queued');
      expect(events).toContain('pacing.admitted');
      expect(peak).toBe(2);
      // Only the concurrent lead's slot remains: the round's own lead
      // re-acquired after the wave and released on disposal.
      expect(gate.view().review.running).toBe(1);
      expect(gate.view().review.queued).toHaveLength(0);
    } finally {
      concurrentLead.release();
    }
    expect(gate.view().review.running).toBe(0);
  });

  it('runs an unlimited review gate without any queue events (behavior-preserving default)', async () => {
    const events: string[] = [];
    const gate = new PacingGate({
      enabled: true,
      maxConcurrentMinions: 0,
      maxConcurrentReviewTurns: 0,
      record: (event) => events.push(event.kind),
    });
    const h = wholeHarness(
      { childAnswer: () => '[]', specialists: ['blind', 'edge'] },
      { reviewGate: gate },
    );
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(events).toEqual([]);
  });

  it('a failed lead-slot re-acquire keeps the settled lens runs committed (T13/R17)', async () => {
    const gate = new PacingGate({
      enabled: true,
      maxConcurrentMinions: 0,
      maxConcurrentReviewTurns: 2,
      record: (event) => {
        if (event.kind === 'pacing.queued' && (event.payload as { id?: string } | undefined)?.id === 'lead') {
          throw new Error('pacing recorder unavailable');
        }
      },
    });
    // One slot is held for the whole round, so when the wave ends the freed
    // slot goes to the external FIFO waiter below and the lead's re-acquire
    // has to queue — where the recorder then fails it.
    const holder = await gate.acquireReviewTurn({ id: 'holder', label: 'holder' });
    let releaseChild!: () => void;
    const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
    try {
      const h = wholeHarness(
        {
          childAnswer: async () => {
            await childGate;
            return '[]';
          },
          specialists: ['blind', 'edge'],
        },
        { reviewGate: gate },
      );
      const running = h.run();
      await vi.waitFor(() => expect(gate.view().review.queued).toHaveLength(1), { timeout: 20_000 });
      const external = gate.acquireReviewTurn({ id: 'external', label: 'external' });
      await vi.waitFor(() => expect(gate.view().review.queued).toHaveLength(2), { timeout: 20_000 });
      releaseChild();
      // The failed re-acquire ends the round (the lead is disposed), so the
      // host rejects instead of returning a result — but the settled lens
      // wave stays committed: both children really ran once each and their
      // complete run records survive under the round's artifact directory
      // (never erased or re-executed by the failed re-acquire).
      await expect(running).rejects.toThrow(/lead session disposed/);
      expect(h.toolErrors.some((entry) =>
        entry.tool === 'perkins_run_specialists' && /pacing recorder unavailable/.test(entry.error),
      )).toBe(true);
      expect(h.leadCalls).toHaveLength(1);
      expect(h.leadCalls[0]?.disposed).toBe(true);
      expect(h.childCalls).toHaveLength(2);
      const childRecords = readdirSync(join(h.frozen.directory, 'children'))
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(join(h.frozen.directory, 'children', name), 'utf8')) as { lens: string; status: string });
      expect(childRecords.map((record) => record.lens).sort()).toEqual(['blind', 'edge']);
      expect(childRecords.every((record) => record.status === 'valid')).toBe(true);
      (await external).release();
    } finally {
      holder.release();
    }
  });
});



describe('provider pacing: workflow rate-limit retry and cleanup', () => {
  it('lead and lens in-band rate limits retry automatically, release slots during backoff, and record evidence', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 0, maxConcurrentReviewTurns: 1 });
    const failures = new Set<string>();
    const events: string[] = [];
    const delays: number[] = [];
    const h = wholeHarness({ childAnswer: () => '[]', specialists: ['edge'],
      promptError: (call) => {
        if (failures.has(call.agentId)) return null;
        failures.add(call.agentId);
        return '429 too many requests';
      },
    }, { reviewGate: gate, pacing: {
      rateLimitBackoff: { baseMs: 100, maxMs: 300, maxRetries: 2, patterns: [] },
      recordPacing: (event) => events.push(event.kind), pacingJitter: () => 0,
      pacingSleep: async (ms) => { delays.push(ms); expect(gate.view().review.running).toBe(0); },
    } });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(delays).toEqual([100, 100]);
    // The lead's retry prompt runs the lens wave, so the lens retry and its
    // recovery land inside the lead's turn: retry(lead), retry(lens),
    // recovered(lens), recovered(lead).
    expect(events).toEqual([
      'pacing.auto-retry', 'pacing.auto-retry',
      'pacing.auto-retry-recovered', 'pacing.auto-retry-recovered',
    ]);
    expect(h.leadCalls).toHaveLength(1);
    expect(h.childCalls).toHaveLength(1); // transport retries do not burn policy lens attempts
    expect(result.specialistRuns).toMatchObject([{ attempt: 1, status: 'valid' }]);
    expect(gate.view().review).toMatchObject({ running: 0, queued: [] });
    expect(readdirSync(join(result.artifactDirectory, 'pacing'))).toHaveLength(4);
  });

  it('lead rate-limit retries exhaust at the configured bound and retain the original failure', async () => {
    let calls = 0;
    const events: string[] = [];
    const delays: number[] = [];
    const h = wholeHarness({ childAnswer: () => '[]', specialists: [], onLeadStart: () => { calls += 1; throw new Error('429 rate limit'); } }, {
      pacing: { rateLimitBackoff: { baseMs: 100, maxMs: 150, maxRetries: 2, patterns: [] },
        recordPacing: (event) => events.push(event.kind), pacingJitter: () => 0,
        pacingSleep: async (ms) => { delays.push(ms); } },
    });
    await expect(h.run()).rejects.toThrow('429 rate limit');
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 150]);
    expect(events).toEqual(['pacing.auto-retry', 'pacing.auto-retry', 'pacing.auto-retry-exhausted']);
    expect(h.leadCalls[0]?.disposed).toBe(true);
  });

  it('non-rate-limit lead errors are not retried', async () => {
    const sleep = vi.fn();
    const h = wholeHarness({ childAnswer: () => '[]', specialists: [], onLeadStart: () => { throw new Error('401 unauthorized'); } }, {
      pacing: { rateLimitBackoff: { baseMs: 100, maxMs: 150, maxRetries: 2, patterns: [] }, pacingSleep: sleep },
    });
    await expect(h.run()).rejects.toThrow('401 unauthorized');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('rejecting lead disposal still returns every pacing lease', async () => {
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 0, maxConcurrentReviewTurns: 1 });
    const h = wholeHarness({ childAnswer: () => '[]', specialists: [], disposeRejects: (call) => call.options.reviewLead !== undefined }, { reviewGate: gate });
    await expect(h.run()).rejects.toThrow('simulated session dispose failure');
    expect(gate.view().review).toMatchObject({ running: 0, queued: [] });
  });

  it('disabled pacing keeps the normal lens fan-out even with configured caps', async () => {
    const gate = new PacingGate({ enabled: false, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 1 });
    let firstWave = 0;
    let starts = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const h = wholeHarness({ specialists: ['blind', 'edge'], childAnswer: async () => {
      if (++starts === 2) { firstWave = gate.view().review.running; release(); }
      await barrier;
      return '[]';
    } }, { reviewGate: gate });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(firstWave).toBe(2);
    expect(gate.view().review).toMatchObject({ limit: 0, running: 0, queued: [] });
  });
  it('a failed lead re-acquire ends the round instead of running later turns ungated (r5 edge#0)', async () => {
    class FailingReacquireGate extends PacingGate {
      calls = 0;
      override acquireReviewTurn(input: PacingAcquireInput): Promise<PacingLease> {
        this.calls += 1;
        if (this.calls === 3) return Promise.reject(new Error('review slot re-acquire unavailable'));
        return super.acquireReviewTurn(input);
      }
    }
    const gate = new FailingReacquireGate({ enabled: true, maxConcurrentMinions: 0, maxConcurrentReviewTurns: 2 });
    const h = wholeHarness({ childAnswer: () => '[]', specialists: ['blind'] }, { reviewGate: gate });
    // The wave completed, but the lead could not re-acquire its slot: the
    // tool call fails AND the round ends (the lead is disposed), so no later
    // lead turn can run outside the combined cap.
    await expect(h.run()).rejects.toThrow(/lead session disposed/);
    expect(h.toolErrors.some((entry) => entry.error.includes('re-acquire unavailable'))).toBe(true);
    expect(gate.calls).toBeGreaterThanOrEqual(3);
    expect(h.leadCalls).toHaveLength(1);
    expect(h.leadCalls[0]?.disposed).toBe(true);
    expect(h.childCalls).toHaveLength(1);
    expect(gate.view().review).toMatchObject({ running: 0, queued: [] });
  });

  it('specialist retries are count-bounded, never stopped by elapsed wall clock (j-1065)', async () => {
    let clock = 1_000_000_000;
    let firstChild: string | null = null;
    const promptsByChild = new Map<string, number>();
    const h = wholeHarness(
      {
        specialists: ['blind'],
        childAnswer: (_prompt, call) => {
          if (firstChild === null) firstChild = call.agentId;
          promptsByChild.set(call.agentId, (promptsByChild.get(call.agentId) ?? 0) + 1);
          if (call.agentId === firstChild) {
            // Each model call burns 400000 ms of wall clock and stays in the
            // rate-limit class. The retired 600000 ms turn budget would have
            // stopped the third call; the retry policy's COUNT bound (1 + 3)
            // must be what governs now.
            clock += 400_000;
            throw new Error('429 too many requests');
          }
          return '[]';
        },
      },
      {
        pacing: {
          rateLimitBackoff: { baseMs: 100, maxMs: 1_000, maxRetries: 3, patterns: [] },
          pacingNow: () => clock,
          pacingSleep: async (ms) => {
            clock += ms;
          },
          pacingJitter: () => 0,
        },
      },
    );
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    // First attempt: exactly FOUR model invocations (initial + three bounded
    // retries). Elapsed clock never stops a retry — the attempt fails on the
    // retry-count bound with the provider error, not a fabricated timeout.
    const firstChildId = [...promptsByChild.keys()][0]!;
    expect(promptsByChild.get(firstChildId)).toBe(4);
    expect([...promptsByChild.values()].reduce((sum, count) => sum + count, 0)).toBe(5);
    const envelope = result.lensEnvelopes.find((entry) => entry.lens === 'blind' && entry.attempt === 1);
    expect(envelope?.failureKind).toBe('error');
    expect(envelope?.error).toContain('429');
  });

  it('a healthy specialist crossing the retired 600000 ms deadline completes valid and exactly once (j-1065 acceptance 1)', async () => {
    const h = wholeHarness({
      specialists: ['blind'],
      // The child turn settles at 700 s of DETERMINISTIC fake time — past the
      // retired 10-minute lifetime — with a perfectly ordinary empty result.
      childAnswer: () => new Promise<string>((resolve) => {
        setTimeout(() => resolve('[]'), 700_000);
      }),
    });
    vi.useFakeTimers();
    try {
      const run = h.run();
      await vi.advanceTimersByTimeAsync(1_500_000);
      const result = await run;
      expect(result.canonicalVerdict).toBe('READY TO MERGE');
      const envelopes = result.lensEnvelopes.filter((entry) => entry.lens === 'blind');
      // Exactly one attempt, valid, no timeout classification: the run was
      // neither killed at 600 s nor duplicated into a retry.
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]).toMatchObject({ lens: 'blind', attempt: 1, status: 'valid' });
      expect(envelopes[0]?.failureKind).toBeUndefined();
      expect(h.childCalls).toHaveLength(1);
      expect(h.childCalls[0]?.disposed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
