import { describe, expect, it } from 'vitest';
import { assertBinnedBaselineLeg, EXPECTED_BASELINE_ASSERTIONS } from '../tools/assert-binned-baseline.mjs';

const assertion = (title: string, status: string, failureMessages: readonly string[] = []) => ({
  title, status, failureMessages,
});
const report = (...assertions: ReturnType<typeof assertion>[]) => ({
  numFailedTests: assertions.filter((entry) => entry.status === 'failed').length,
  testResults: [{ assertionResults: assertions }],
});

describe('binned fail-before receipt classifier', () => {
  it('accepts both named behavioral assertions only when they actually fail', () => {
    for (const [label, title] of Object.entries(EXPECTED_BASELINE_ASSERTIONS)) {
      expect(assertBinnedBaselineLeg(label, report(assertion(title, 'failed', ['AssertionError: expected binned behavior'])), title))
        .toContain('assertion RED');
    }
  });

  it('rejects mixed collection failures and a named test that fails before its assertion', () => {
    const title = EXPECTED_BASELINE_ASSERTIONS.backend;
    const named = assertion(title, 'failed', ['AssertionError: expected 400 to be 200']);
    expect(() => assertBinnedBaselineLeg('backend', {
      numFailedTests: 1,
      testResults: [
        { status: 'failed', message: '', assertionResults: [named] },
        { status: 'failed', message: 'Failed to import missing module', assertionResults: [] },
      ],
    }, title)).toThrow(/collection|setup|import/u);
    expect(() => assertBinnedBaselineLeg('backend', report(
      assertion(title, 'failed', ['Error: missing fixture from test setup']),
    ), title)).toThrow(/assertion|setup/u);
  });

  it('rejects setup/collection errors, green tests, and unrelated failures', () => {
    const title = EXPECTED_BASELINE_ASSERTIONS.backend;
    for (const bad of [
      { numFailedTests: 0, testResults: [{ status: 'failed', message: 'import failed', assertionResults: [] }] },
      report(assertion(title, 'passed')),
      report(assertion('unrelated test', 'failed', ['expected something else'])),
      report(assertion(title, 'failed')),
    ]) {
      expect(() => assertBinnedBaselineLeg('backend', bad, title)).toThrow(/not behavioral RED|not fail|no failed tests/u);
    }
  });
});
