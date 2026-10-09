import { describe, expect, it } from 'vitest';
import {
  EXPECTED_KEEPALIVE_BASELINE_ASSERTIONS,
  assertKeepaliveBaseline,
  isBehavioralRed,
  resolveBaselineLeg,
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

function behavioralRed(titles: readonly string[]) {
  return titles.map((title) =>
    assertion(title, 'failed', ['AssertionError: expected 0 to be greater than or equal to 3']),
  );
}

describe('keepalive fail-before receipt classifier', () => {
  it('accepts every leg only when each named regression fails behaviorally', () => {
    for (const expected of Object.values(EXPECTED_KEEPALIVE_BASELINE_ASSERTIONS)) {
      const red = assertKeepaliveBaseline(report(...behavioralRed(expected)), expected);
      expect(red).toHaveLength(expected.length);
      // A matcher type error is behavioral RED too (Vitest assertTypes throws
      // a plain TypeError).
      const typed = assertKeepaliveBaseline(
        report(
          assertion(expected[0]!, 'failed', [
            'TypeError: expected value must be number or bigint, received "undefined"',
          ]),
          ...behavioralRed(expected.slice(1)),
        ),
        expected,
      );
      expect(typed).toHaveLength(expected.length);
    }
  });

  it('resolves the server and capture legs and refuses an unknown one', () => {
    expect(resolveBaselineLeg('server')).toHaveLength(8);
    expect(resolveBaselineLeg('capture')).toHaveLength(3);
    expect(() => resolveBaselineLeg('nope')).toThrow(/unknown baseline leg/u);
  });

  it('accepts only behavioral failure shapes', () => {
    expect(isBehavioralRed('AssertionError: nope')).toBe(true);
    expect(isBehavioralRed('TypeError: expected value must be number or bigint, received "undefined"')).toBe(true);
    // A test-code type error, a harness timeout and a setup error are not RED.
    expect(isBehavioralRed('TypeError: Cannot read properties of undefined (reading "x")')).toBe(false);
    expect(isBehavioralRed('Error: waitFor timed out')).toBe(false);
    expect(isBehavioralRed(undefined)).toBe(false);
  });

  it('rejects a missing or still-green named regression', () => {
    const [first = '', ...rest] = EXPECTED_KEEPALIVE_BASELINE_ASSERTIONS.server;
    expect(() => assertKeepaliveBaseline(report(...behavioralRed(rest)))).toThrow(/not collected/u);
    expect(() =>
      assertKeepaliveBaseline(
        report(assertion(first, 'passed'), ...behavioralRed(rest)),
      ),
    ).toThrow(/did not fail/u);
  });

  it('rejects unlisted failures, count mismatches, setup failures, and unparseable reports', () => {
    const titles = EXPECTED_KEEPALIVE_BASELINE_ASSERTIONS.server;
    // An unlisted failing test (e.g. a harness timeout) is outside the claim.
    expect(() =>
      assertKeepaliveBaseline(
        report(...behavioralRed(titles), assertion('something unrelated', 'failed', ['Error: boom'])),
      ),
    ).toThrow(/unlisted failure/u);
    // A title that merely CONTAINS a named title must not smuggle a failure
    // in: the match is exact.
    expect(() =>
      assertKeepaliveBaseline(
        report(
          ...behavioralRed(titles),
          assertion(`${titles[0]} (extra unrelated stray)`, 'failed', ['Error: harness timeout']),
        ),
      ),
    ).toThrow(/unlisted failure/u);
    // A non-behavioral failure on a listed test is not RED evidence.
    expect(() =>
      assertKeepaliveBaseline(
        report(
          assertion(titles[0]!, 'failed', ['Error: waitFor timed out']),
          ...behavioralRed(titles.slice(1)),
        ),
      ),
    ).toThrow(/before its assertion/u);
    // The reported failed count must match the listed failures.
    expect(() =>
      assertKeepaliveBaseline({
        numFailedTests: 3,
        testResults: [{ assertionResults: behavioralRed(titles) }],
      }),
    ).toThrow(/unreadable report/u);
    expect(() =>
      assertKeepaliveBaseline({
        numFailedTests: 1,
        testResults: [
          { status: 'failed', message: 'Failed to import missing module', assertionResults: [] },
        ],
      }),
    ).toThrow(/collection|setup|import/u);
    expect(() => assertKeepaliveBaseline(null)).toThrow(/no parseable/u);
    expect(() => assertKeepaliveBaseline({ testResults: [] })).toThrow(/no parseable/u);
  });
});
