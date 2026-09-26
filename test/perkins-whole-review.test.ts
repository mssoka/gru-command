import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    const base = repo.head();
    repo.git(['checkout', '-b', 'feature/bounds']);
    repo.commitFile('src/huge.txt', `${'x'.repeat(FROZEN_DIFF_MAX_BYTES + 1)}\n`);
    const root = temp('perkins-freeze-bounds-');
    expect(() => freezeReviewInputs({
      roundId: 'bounds-round', repoPath: repo.path, artifactRoot: root,
      baseRef: base, targetRef: repo.head(), movementRef: 'feature/bounds', spec: 'too big',
    })).toThrow(/frozen diff exceeds/);
    const specRepo = makeFixtureRepo('whole-spec-bounds');
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
    expect(resolveReviewBaseRef(repo.path, 'main')).toBe('main');
    expect(resolveReviewBaseRef(repo.path, 'refs/heads/main')).toBe('refs/heads/main');
    expect(resolveReviewBaseRef(repo.path, null)).toBe('main');
    expect(resolveReviewBaseRef(repo.path, '')).toBe('main');
    // Fail closed when no conventional default exists: a repo whose only
    // branch is neither main nor master and which has no origin/HEAD.
    const lone = makeFixtureRepo('whole-base-lone');
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

  it('accepts a same-file additive fix that the removed-line proof shape used to reject', async () => {
    const h = priorHarness({
      audit: { prior_index: 0, status: 'fixed', note: 'src/helper.ts now validates the ref before slicing; the vulnerable line is gone from the file.' },
      afterPrior: (repo) => {
        repo.commitFile('src/helper.ts', 'export function helper(ref: string): string {\n  if (!ref.includes("/")) throw new Error("malformed ref");\n  return ref.slice(ref.indexOf("/") + 1);\n}\n');
      },
    });
    const result = await h.run();
    expect(result.canonicalVerdict).toBe('READY TO MERGE');
    expect(result.priorDispositions[0]?.status).toBe('fixed');
  });

  it('still-present priors carry their original round marker and are not double-counted', async () => {
    const h = priorHarness({
      audit: { prior_index: 0, status: 'still-present', note: 'The helper still strips without validation.' },
      leadFinding: groundedFinding('security', 'warning', {
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

  it('refuses duplicate lenses inside one run call', async () => {
    const h = wholeHarness({
      ...ALL_CLEAN,
      specialists: ['blind', 'edge'],
      duplicateRun: 'blind',
    });
    await expect(h.run()).rejects.toThrow(/cannot duplicate a lens/);
    expect(h.childCalls).toHaveLength(0);
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
  readonly audit?: { prior_index: number; status: 'fixed' | 'still-present'; note: string };
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


