import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
import { PerkinsWholeReview, type PerkinsWholeResult } from '../src/dispatch/perkins-review/whole.js';
import { ReviewMcpBridge } from '../src/runtime/review-mcp-bridge.js';
import { finalAssistantText } from '../src/dispatch/perkins-review/session-output.js';
import { makeFixtureRepo, type FixtureRepo } from './helpers/fixture-repo.js';
import { fakeWholeSpawner, groundedFinding, type WholeLeadOptions, type WholeSubmission } from './helpers/perkins-whole-double.js';
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
  run(input?: { noSpec?: boolean; priorConsolidatedFile?: string }): Promise<PerkinsWholeResult>;
}

function wholeHarness(
  brain: WholeLeadOptions,
  options?: { noSpec?: boolean; spec?: string; priorConsolidatedFile?: string; beforeFreeze?: (repo: FixtureRepo) => void },
): WholeHarness {
  const fixture = makeReviewRepo();
  repos.push(fixture.repo);
  options?.beforeFreeze?.(fixture.repo);
  const base = fixture.repo.git(['rev-parse', 'main']);
  const target = fixture.repo.head();
  const root = temp('perkins-whole-test-');
  const frozen = freezeReviewInputs({
    roundId: 'whole-round',
    repoPath: fixture.repo.path,
    artifactRoot: root,
    baseRef: base,
    targetRef: target,
    movementRef: 'feature/review',
    ...(options?.noSpec === true
      ? { noSpec: true }
      : { spec: options?.spec ?? 'return 43' }),
  });
  const fake = fakeWholeSpawner(temp('perkins-whole-sessions-'), brain);
  const engine = new PerkinsWholeReview({ spawner: fake.spawner, policy: loadPerkinsPolicy() });
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
    expect(h.childCalls).toHaveLength(7);
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

  it('uses exactly six specialists in explicit no-spec mode', async () => {
    const h = wholeHarness({ childAnswer: () => '[]' }, { noSpec: true });
    await h.run();
    expect(h.childCalls).toHaveLength(6);
    expect(h.childCalls.some((call) => call.prompt!.includes('EXPLICIT NO-SPEC REVIEW'))).toBe(true);
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

  it('accepts a same-file additive fix that the removed-line proof shape used to reject, with a truthful guard note', async () => {
    const guardedHelper = 'export function helper(ref: string): string {\n  if (!ref.includes("/")) throw new Error("malformed ref");\n  return ref.slice(ref.indexOf("/") + 1);\n}\n';
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

  it('rejects an empty/missing verdict, an empty report, and a report omitting the verdict line or frozen identity', async () => {
    const cases: ReadonlyArray<{ name: string; mutate: (submission: WholeSubmission) => Record<string, unknown>; pattern: RegExp }> = [
      { name: 'missing verdict', mutate: (s) => ({ ...s, verdict: undefined }), pattern: /submission-verdict/ },
      { name: 'empty report', mutate: (s) => ({ ...s, report_markdown: '' }), pattern: /report-shape/ },
      { name: 'verdict line missing', mutate: (s) => ({ ...s, report_markdown: s.report_markdown.replace(/\*\*Verdict: READY TO MERGE\*\*/, '**Verdict: UNKNOWN**') }), pattern: /report-verdict/ },
      { name: 'frozen identity missing', mutate: (s) => ({ ...s, report_markdown: s.report_markdown.replace(/^Frozen target: .+$/m, 'Frozen target: redacted') }), pattern: /report-identity/ },
    ];
    for (const testCase of cases) {
      const h = wholeHarness({
        ...ALL_CLEAN,
        submitPayload: (_attempt, submission) => testCase.mutate(submission) as never,
        submitRetries: 0,
      });
      await expect(h.run()).rejects.toThrow(testCase.pattern);
    }
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
      'tools/verify-perkins-resource.mjs',
      'install.sh',
      'install/launchd/com.gru-command.service.plist.template',
      'install/systemd/gru-command.service.template',
      'roles/perkins.md',
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


