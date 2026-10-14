import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PropertyDetectionContext, PropertyExecutionPlan, RawExecutionReceipt } from '../src/property/types.js';
import {
  buildVitestExecutionPlan,
  interpretVitestJsonReceipt,
  planVitestPlacement,
  resolveVitestBinary,
} from '../src/property/adapters/vitest-fast-check.js';

/**
 * GH350 pilot adapter: interpretation precedence (positive evidence only),
 * placement determinism, contained binary resolution, no-install refusal.
 */

const roots: string[] = [];
const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'gh350-adapter-'));
  roots.push(root);
  return root;
};
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const FILTER = 'test/property/ratio.test.ts';

function plan(overrides: Partial<PropertyExecutionPlan> = {}): PropertyExecutionPlan {
  return {
    adapterId: 'vitest-fast-check',
    command: '/repo/node_modules/.bin/vitest',
    args: ['run', '--reporter=json', FILTER],
    cwd: '/repo',
    envAllowlist: ['PATH'],
    budget: { maxIterations: 100, maxShrinkSteps: 500, runTimeoutMs: 120_000, maxOutputBytes: 1024 },
    executable: true,
    refusalReason: null,
    ...overrides,
  };
}

function receipt(overrides: Partial<RawExecutionReceipt> = {}): RawExecutionReceipt {
  return { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 1_000, ...overrides };
}

function vitestJson(payload: unknown): string {
  return JSON.stringify(payload);
}

const selectedPass = vitestJson({
  numTotalTestSuites: 1, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true,
  testResults: [{ name: `/repo/${FILTER}`, status: 'passed', message: '', assertionResults: [
    { status: 'passed', fullName: 'ratio holds', failureMessages: [] },
    { status: 'passed', fullName: 'ratio bounded', failureMessages: [] },
  ] }],
});

const selectedFailure = vitestJson({
  numTotalTestSuites: 1, numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, numPendingTests: 0, numTodoTests: 0, success: false,
  testResults: [{ name: `/repo/${FILTER}`, status: 'failed', message: '', assertionResults: [
    { status: 'failed', fullName: 'ratio holds', failureMessages: ['Property failed after 34 tests\nseed: -1731691812\ncounterexample: [2, 3]'] },
  ] }],
});

const unselectedFailureOnly = vitestJson({
  numTotalTestSuites: 2, numTotalTests: 3, numPassedTests: 2, numFailedTests: 1, numPendingTests: 0, numTodoTests: 0, success: false,
  testResults: [
    { name: `/repo/${FILTER}`, status: 'passed', message: '', assertionResults: [{ status: 'passed', fullName: 'ratio holds', failureMessages: [] }] },
    { name: '/repo/test/unrelated.test.ts', status: 'failed', message: '', assertionResults: [{ status: 'failed', fullName: 'legacy test', failureMessages: ['boom'] }] },
  ],
});

const allSkipped = vitestJson({
  numTotalTestSuites: 1, numTotalTests: 1, numPassedTests: 0, numFailedTests: 0, numPendingTests: 1, numTodoTests: 0, success: true,
  testResults: [{ name: `/repo/${FILTER}`, status: 'passed', message: '', assertionResults: [{ status: 'skipped', fullName: 'ratio holds', failureMessages: [] }] }],
});

const zeroTests = vitestJson({
  numTotalTestSuites: 0, numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: false,
  testResults: [],
});

const collectionFailure = vitestJson({
  numTotalTestSuites: 1, numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: false,
  testResults: [{ name: `/repo/${FILTER}`, status: 'failed', message: 'Transform failed with 1 error', assertionResults: [] }],
});

describe('GH350 vitest adapter interpretation precedence', () => {
  it('classifies a fully consistent selected passing run as pass', () => {
    const outcome = interpretVitestJsonReceipt(receipt({ stdout: selectedPass }), plan());
    expect(outcome.kind).toBe('pass');
    expect(outcome.executed).toBe(2);
    expect(outcome.selected).toBe(2);
    expect(outcome.evidenceClass).toBe('runner-report-classification');
  });

  it('classifies a selected assertion failure as property-failure with seed extraction and proof disclaimer', () => {
    const outcome = interpretVitestJsonReceipt(receipt({ exitCode: 1, stdout: selectedFailure }), plan());
    expect(outcome.kind).toBe('property-failure');
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.failures[0]!.seed).toBe('-1731691812');
    expect(outcome.reasons.join(' ')).toContain('not qualified contract/product proof');
    expect(outcome.receipt.exitCode).toBe(1);
  });

  it('discloses unselected failures and bars pass while they stand', () => {
    const outcome = interpretVitestJsonReceipt(receipt({ exitCode: 1, stdout: unselectedFailureOnly }), plan());
    expect(outcome.unselectedFailures).toHaveLength(1);
    expect(outcome.unselectedFailures[0]!.testIdentity).toBe('legacy test');
    expect(outcome.kind).toBe('inconclusive');
    expect(outcome.reasons.join(' ')).toContain('unselected failure');
  });

  it('treats an all-skipped run as inconclusive, not pass', () => {
    const outcome = interpretVitestJsonReceipt(receipt({ stdout: allSkipped }), plan());
    expect(outcome.kind).toBe('inconclusive');
    expect(outcome.skipped).toBe(1);
    expect(outcome.executed).toBe(0);
    expect(outcome.reasons.join(' ')).toContain('not executed controls');
  });

  it('classifies zero test results as selection-failure, never pass', () => {
    const outcome = interpretVitestJsonReceipt(receipt({ exitCode: 1, stdout: zeroTests }), plan());
    expect(outcome.kind).toBe('selection-failure');
  });

  it('classifies a suite that failed to collect as collection-failure', () => {
    const outcome = interpretVitestJsonReceipt(receipt({ exitCode: 1, stdout: collectionFailure }), plan());
    expect(outcome.kind).toBe('collection-failure');
    expect(outcome.reasons.join(' ')).toContain('failed to collect');
  });

  it('classifies a signalled runner as infrastructure-error', () => {
    const outcome = interpretVitestJsonReceipt(receipt({ exitCode: null, signal: 'SIGKILL' }), plan());
    expect(outcome.kind).toBe('infrastructure-error');
    expect(outcome.receipt.signal).toBe('SIGKILL');
  });

  it('classifies wall-clock expiry as timeout', () => {
    const outcome = interpretVitestJsonReceipt(receipt({ exitCode: null, signal: 'SIGKILL', timedOut: true }), plan());
    expect(outcome.kind).toBe('timeout');
  });

  it('treats a nonzero exit without a report or diagnostic as inconclusive, never build-failure', () => {
    const outcome = interpretVitestJsonReceipt(receipt({ exitCode: 1, stderr: 'something odd happened' }), plan());
    expect(outcome.kind).toBe('inconclusive');
    expect(outcome.matchedDiagnostic).toBeNull();
    expect(outcome.reasons.join(' ')).toContain('not asserted as a build failure');
  });

  it('classifies a recognized pre-report diagnostic as build-failure with the signature id', () => {
    const outcome = interpretVitestJsonReceipt(
      receipt({ exitCode: 1, stderr: 'Error: Failed to load config from file "vitest.config.ts"' }),
      plan(),
    );
    expect(outcome.kind).toBe('build-failure');
    expect(outcome.matchedDiagnostic).toBe('vitest-failed-config-load');
  });

  it('treats a zero exit without a report as inconclusive (missing evidence is never a pass)', () => {
    const outcome = interpretVitestJsonReceipt(receipt({ stdout: '' }), plan());
    expect(outcome.kind).toBe('inconclusive');
    expect(outcome.reasons.join(' ')).toContain('missing evidence is never a pass');
  });

  it('refuses pass on a contradictory report (success flag disagrees with exit code)', () => {
    const outcome = interpretVitestJsonReceipt(receipt({ exitCode: 1, stdout: selectedPass }), plan());
    expect(outcome.kind).toBe('inconclusive');
    expect(outcome.reasons.join(' ')).toContain('disagrees with exit code');
  });

  it('refuses pass on contradictory totals versus per-assertion accounting', () => {
    const contradictory = vitestJson({
      numTotalTests: 5, numPassedTests: 5, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true,
      testResults: [{ name: `/repo/${FILTER}`, status: 'passed', message: '', assertionResults: [
        { status: 'passed', fullName: 'ratio holds', failureMessages: [] },
      ] }],
    });
    const outcome = interpretVitestJsonReceipt(receipt({ stdout: contradictory }), plan());
    expect(outcome.kind).toBe('inconclusive');
    expect(outcome.reasons.join(' ')).toContain('contradictory report');
  });

  it('never treats unknown assertion statuses as executed passing tests', () => {
    const stdout = vitestJson({ numTotalTests: 1, numPassedTests: 0, numFailedTests: 0, success: true, testResults: [{ name: `/repo/${FILTER}`, status: 'passed', assertionResults: [{ status: 'running', fullName: 'not completed', failureMessages: [] }] }] });
    expect(interpretVitestJsonReceipt(receipt({ stdout }), plan()).kind).toBe('inconclusive');
  });

  it('returns inconclusive for malformed nested report rows rather than throwing', () => {
    for (const row of [null, { name: FILTER, status: 'passed', assertionResults: null }, { name: FILTER, status: 'passed', assertionResults: [null] }, { name: FILTER, status: 'failed', assertionResults: [{ status: 'failed', fullName: 'bad', failureMessages: null }] }]) {
      const stdout = vitestJson({ numTotalTests: 1, numPassedTests: 1, numFailedTests: 0, success: true, testResults: [row] });
      expect(interpretVitestJsonReceipt(receipt({ stdout }), plan()).kind).toBe('inconclusive');
    }
  });

  it('rejects contradictory failure reports instead of qualifying fabricated control failures', () => {
    for (const raw of [receipt({ exitCode: 0, stdout: selectedFailure }), receipt({ exitCode: 1, stdout: selectedFailure.replace('"numFailedTests":1', '"numFailedTests":0') })]) {
      expect(interpretVitestJsonReceipt(raw, plan()).kind).toBe('inconclusive');
    }
  });

  it('requires a path-segment boundary rather than matching a sibling filename suffix', () => {
    const stdout = selectedFailure.replace(`/repo/${FILTER}`, `/repo/other${FILTER}`);
    const outcome = interpretVitestJsonReceipt(receipt({ exitCode: 1, stdout }), plan());
    expect(outcome.kind).toBe('inconclusive'); expect(outcome.selected).toBe(0); expect(outcome.failures).toHaveLength(0); expect(outcome.unselectedFailures).toHaveLength(1);
  });

  it('returns not-run with the refusal reason for a non-executable plan', () => {
    const outcome = interpretVitestJsonReceipt(
      receipt(),
      plan({ executable: false, refusalReason: 'no installed vitest binary under the package or repository node_modules' }),
    );
    expect(outcome.kind).toBe('not-run');
    expect(outcome.reasons[0]).toContain('no installed vitest binary');
  });
});

describe('GH350 vitest adapter planning', () => {
  const contextFor = (root: string): PropertyDetectionContext => ({
    repoRoot: root,
    packageDir: root,
    manifest: {},
    lockfiles: [],
    approvedCommands: {},
  });

  it('places property contracts under test/property when test/ exists', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'test'), { recursive: true });
    const placement = planVitestPlacement(contextFor(root), 'ratio-contract');
    expect(placement.filePath.endsWith(join('test', 'property', 'ratio-contract.test.ts'))).toBe(true);
    expect(placement.selectionFilter).toBe('test/property/ratio-contract.test.ts');
  });

  it('places property contracts under src/property when only src/ exists', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    const placement = planVitestPlacement(contextFor(root), 'ratio-contract');
    expect(placement.filePath.endsWith(join('src', 'property', 'ratio-contract.test.ts'))).toBe(true);
  });

  it('refuses (never installs) when no runner binary is installed', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    const placement = planVitestPlacement(contextFor(root), 'ratio-contract');
    const planBuilt = buildVitestExecutionPlan(contextFor(root), placement);
    expect(planBuilt.executable).toBe(false);
    expect(planBuilt.refusalReason).toContain('dependency installation is never automatic');
  });

  it('refuses a regular runner hidden behind an escaping node_modules parent symlink', () => {
    const root = makeRoot(); const outside = makeRoot();
    mkdirSync(join(outside, '.bin')); writeFileSync(join(outside, '.bin/vitest'), 'outside runner');
    symlinkSync(outside, join(root, 'node_modules'));
    expect(resolveVitestBinary(root, root)).toMatchObject({ path: null, reason: expect.stringContaining('outside the repository') });
  });

  it('resolves a contained .bin symlink to the real runner target', () => {
    const root = makeRoot();
    mkdirSync(join(root, 'node_modules', 'vitest', 'dist'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'vitest', 'dist', 'cli.mjs'), '#!/usr/bin/env node\n');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    symlinkSync('../vitest/dist/cli.mjs', join(root, 'node_modules', '.bin', 'vitest'));
    const resolved = resolveVitestBinary(root, root);
    expect(resolved.path).not.toBeNull();
    expect(resolved.path!.endsWith('cli.mjs')).toBe(true);
    expect(resolved.reason).toBeNull();
  });

  it('refuses a .bin symlink that escapes the repository', () => {
    const outside = makeRoot();
    const root = makeRoot();
    writeFileSync(join(outside, 'impostor.mjs'), '#!/usr/bin/env node\n');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    symlinkSync(join(outside, 'impostor.mjs'), join(root, 'node_modules', '.bin', 'vitest'));
    const resolved = resolveVitestBinary(root, root);
    expect(resolved.path).toBeNull();
    expect(resolved.reason).toContain('resolves outside the repository');
  });
});
