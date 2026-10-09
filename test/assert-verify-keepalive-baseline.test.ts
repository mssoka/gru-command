import { describe, expect, it } from 'vitest';
import {
  EXPECTED_KEEPALIVE_BASELINE_ASSERTIONS,
  assertKeepaliveBaseline,
  isBehavioralRed,
} from '../tools/assert-verify-keepalive-baseline.mjs';

const assertion = (title: string, status: string, failureMessages: readonly string[] = []) => ({
  title,
  status,
  failureMessages,
});

function report(...assertions: ReturnType<typeof assertion>[]) {
  return {
    numFailedTests: assertions.filter((entry) => entry.status === 'failed').length,
    testResults: [{ assertionResults: assertions }],
  };
}

describe('keepalive fail-before receipt classifier', () => {
  it('accepts the named regressions of every leg only when each fails behaviorally', () => {
    for (const expected of Object.values(EXPECTED_KEEPALIVE_BASELINE_ASSERTIONS)) {
      const red = assertKeepaliveBaseline(
        report(
          ...expected.map((title) =>
            assertion(title, 'failed', ['AssertionError: expected 0 to be greater than or equal to 3']),
          ),
        ),
        expected,
      );
      expect(red).toHaveLength(expected.length);
      // A Vitest matcher type error on the test's own value is behavioral RED
      // too (assertTypes throws a plain TypeError, not an AssertionError).
      const typed = assertKeepaliveBaseline(
        report(
          assertion(expected[0]!, 'failed', [
            'TypeError: expected value must be number or bigint, received "undefined"',
          ]),
          ...expected
            .slice(1)
            .map((title) => assertion(title, 'failed', ['AssertionError: nope'])),
        ),
        expected,
      );
      expect(typed).toHaveLength(expected.length);
    }
    expect(isBehavioralRed('Error: waitFor timed out')).toBe(false);
  });

  it('rejects a missing or still-green named regression and unrelated failures', () => {
    const [first = '', ...rest] = EXPECTED_KEEPALIVE_BASELINE_ASSERTIONS.server;
    expect(() =>
      assertKeepaliveBaseline(
        report(
          ...rest.map((title) => assertion(title, 'failed', ['AssertionError: nope'])),
        ),
      ),
    ).toThrow(/not collected/u);
    expect(() =>
      assertKeepaliveBaseline(
        report(
          assertion(first, 'passed'),
          ...rest.map((title) => assertion(title, 'failed', ['AssertionError: nope'])),
        ),
      ),
    ).toThrow(/did not fail/u);
    expect(() =>
      assertKeepaliveBaseline(
        report(...EXPECTED_KEEPALIVE_BASELINE_ASSERTIONS.server.map((title) => assertion(title, 'passed'))),
      ),
    ).toThrow(/did not fail/u);
  });

  it('rejects collection/setup/import failures, non-behavioral RED, and unparseable reports', () => {
    const titles = EXPECTED_KEEPALIVE_BASELINE_ASSERTIONS.server;
    expect(() =>
      assertKeepaliveBaseline({
        numFailedTests: 1,
        testResults: [
          { status: 'failed', message: 'Failed to import missing module', assertionResults: [] },
        ],
      }),
    ).toThrow(/collection|setup|import/u);
    expect(() =>
      assertKeepaliveBaseline(
        report(
          assertion(titles[0]!, 'failed', ['Error: waitFor timed out']),
          ...titles.slice(1).map((title) => assertion(title, 'failed', ['AssertionError: nope'])),
        ),
      ),
    ).toThrow(/before its assertion/u);
    expect(() => assertKeepaliveBaseline(null)).toThrow(/no parseable/u);
    expect(() => assertKeepaliveBaseline({ testResults: [] })).toThrow(/no parseable/u);
  });
});
