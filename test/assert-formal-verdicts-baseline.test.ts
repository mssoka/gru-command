import { describe, expect, it } from 'vitest';
import {
  assertFormalVerdictsBaselineLeg,
  EXPECTED_FORMAL_EVENT_ASSERTIONS,
} from '../tools/assert-formal-verdicts-baseline.mjs';

const assertion = (title: string, status: string, failureMessages: readonly string[] = []) => ({
  title,
  fullName: title,
  status,
  failureMessages,
});
const report = (...assertions: ReturnType<typeof assertion>[]) => ({
  numFailedTests: assertions.filter((entry) => entry.status === 'failed').length,
  testResults: [{ status: 'passed', assertionResults: assertions }],
});

describe('formal GitHub verdicts fail-before classifier', () => {
  it('accepts a leg only when every named formal-event assertion fails as an assertion', () => {
    for (const [label, titles] of Object.entries(EXPECTED_FORMAL_EVENT_ASSERTIONS)) {
      const line = assertFormalVerdictsBaselineLeg(
        label,
        report(...titles.map((title) => assertion(title, 'failed', ['AssertionError: expected COMMENTED to be APPROVED']))),
        titles,
      );
      expect(line).toContain('formal-event absence proven');
      expect(line).toContain(`${titles.length} named assertion(s) RED`);
    }
  });

  it('rejects a required regression that did not fail against the base', () => {
    const titles = EXPECTED_FORMAL_EVENT_ASSERTIONS.app;
    const partial = titles.slice(0, -1).map((title) => assertion(title, 'failed', ['AssertionError: nope']));
    expect(() => assertFormalVerdictsBaselineLeg('app', report(...partial), titles))
      .toThrow(/did not fail against the base/);
  });

  it('rejects a named regression that failed for a non-behavioral reason', () => {
    const titles = EXPECTED_FORMAL_EVENT_ASSERTIONS.wave;
    const noMarker = titles.map((title, index) =>
      assertion(title, 'failed', [index === 0 ? 'TypeError: cannot read properties of undefined' : 'AssertionError: nope']));
    expect(() => assertFormalVerdictsBaselineLeg('wave', report(...noMarker), titles))
      .toThrow(/no formal-event behavioral marker/);
    const imported = titles.map((title) => assertion(title, 'failed', ['Error: Cannot find module ../src/missing.js']));
    expect(() => assertFormalVerdictsBaselineLeg('wave', report(...imported), titles))
      .toThrow(/import\/setup reason/);
  });

  it('rejects collection/setup/import failures and unparseable reports', () => {
    expect(() => assertFormalVerdictsBaselineLeg('app', {
      numFailedTests: 1,
      testResults: [{ name: 'test/x.test.ts', status: 'failed', message: 'Cannot find module ../src/missing.js', assertionResults: [] }],
    }, EXPECTED_FORMAL_EVENT_ASSERTIONS.app)).toThrow(/collection\/setup\/import failure/);
    expect(() => assertFormalVerdictsBaselineLeg('app', { numFailedTests: 0, testResults: [] }, EXPECTED_FORMAL_EVENT_ASSERTIONS.app))
      .toThrow(/no failed tests in a parseable Vitest report/);
  });

  it('reports unrelated failures as excluded context, never as the claim', () => {
    const titles = EXPECTED_FORMAL_EVENT_ASSERTIONS.app;
    const failures = titles.map((title) => assertion(title, 'failed', ['AssertionError: nope']));
    const line = assertFormalVerdictsBaselineLeg('app', report(
      ...failures,
      assertion('some unrelated later-main regression', 'failed', ['AssertionError: unrelated']),
    ), titles);
    expect(line).toContain('1 unrelated failure(s) excluded from the claim');
  });
});
