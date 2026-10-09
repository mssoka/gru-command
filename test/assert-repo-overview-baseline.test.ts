import { describe, expect, it } from 'vitest';
import {
  assertRepoOverviewBaselineLeg,
  EXPECTED_ABSENCE_ASSERTIONS,
} from '../tools/assert-repo-overview-baseline.mjs';

const assertion = (title: string, status: string, failureMessages: readonly string[] = []) => ({
  title,
  status,
  failureMessages,
});
const report = (...assertions: ReturnType<typeof assertion>[]) => ({
  numFailedTests: assertions.filter((entry) => entry.status === 'failed').length,
  testResults: [{ assertionResults: assertions }],
});

describe('managed repo overview fail-before classifier', () => {
  it('accepts a leg only when every named Option A absence assertion fails as an assertion', () => {
    for (const [label, titles] of Object.entries(EXPECTED_ABSENCE_ASSERTIONS)) {
      const line = assertRepoOverviewBaselineLeg(
        label,
        report(...titles.map((title) => assertion(title, 'failed', ['AssertionError: expected undefined to be null']))),
        titles,
      );
      expect(line).toContain('Option A absence proven');
      expect(line).toContain(`${titles.length} named assertion(s) RED`);
    }
  });

  it('rejects unrelated failures and partial absence even when the leg is nonzero', () => {
    const titles = EXPECTED_ABSENCE_ASSERTIONS.backend;
    // Unrelated failures only: the generic any-failure check would have
    // self-confirmed here; the feature-specific classifier must not.
    expect(() =>
      assertRepoOverviewBaselineLeg('backend', report(assertion('unrelated later-main test', 'failed', ['AssertionError: nope'])), titles),
    ).toThrow(/Option A absence not proven/u);
    // One missing named check out of four is still not proof.
    expect(() =>
      assertRepoOverviewBaselineLeg(
        'backend',
        report(...titles.slice(0, 3).map((title) => assertion(title, 'failed', ['AssertionError: x']))),
        titles,
      ),
    ).toThrow(/Option A absence not proven/u);
  });

  it('rejects collection/setup failures, green named tests and non-assertion errors', () => {
    const titles = EXPECTED_ABSENCE_ASSERTIONS.web;
    expect(() =>
      assertRepoOverviewBaselineLeg('web', {
        numFailedTests: 1,
        testResults: [
          { status: 'failed', message: 'Failed to import missing module', assertionResults: [] },
        ],
      }, titles),
    ).toThrow(/collection|setup|import/u);
    expect(() =>
      assertRepoOverviewBaselineLeg('web', report(assertion(titles[0] as string, 'passed')), titles),
    ).toThrow(/not behavioral RED|Option A absence not proven/u);
    expect(() =>
      assertRepoOverviewBaselineLeg(
        'web',
        report(...titles.map((title) => assertion(title, 'failed', ['TypeError: missingExport is not a function']))),
        titles,
      ),
    ).toThrow(/AssertionError/u);
  });

  it('reports unrelated failures as excluded context, never as the claim', () => {
    const titles = EXPECTED_ABSENCE_ASSERTIONS.backend;
    const line = assertRepoOverviewBaselineLeg(
      'backend',
      report(
        ...titles.map((title) => assertion(title, 'failed', ['AssertionError: x'])),
        assertion('unrelated later-main test', 'failed', ['AssertionError: y']),
      ),
      titles,
    );
    expect(line).toContain('1 unrelated failure(s) excluded');
  });
});
