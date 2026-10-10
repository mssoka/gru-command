import { describe, expect, it } from 'vitest';
import {
  BASELINE_TITLES,
  assertPerkinsIntegrationBaseline,
  isBehavioralAssertion,
} from '../tools/assert-perkins-integration-review-baseline.mjs';

const FAST_TITLE = BASELINE_TITLES.fast[0]!;
const [HEAVY_CRASH_TITLE, HEAVY_CRASH_PROMOTION_TITLE, HEAVY_PIN_TITLE] = BASELINE_TITLES.heavy;

function red(title: string, messages: readonly string[] = [`AssertionError: expected 'a' to be 'b'`]) {
  return { title, status: 'failed', failureMessages: messages };
}

function passed(title: string) {
  return { title, status: 'passed', failureMessages: [] };
}

function report(...assertions: readonly Record<string, unknown>[]) {
  return {
    numFailedTests: assertions.filter((entry) => entry['status'] === 'failed').length,
    testResults: [{ assertionResults: assertions }],
  };
}

/** The REAL Vitest message for a rejected `rejects.toThrow` assertion that
 * resolved instead — the pre-fix mutation-refusal failure shape. */
const RESOLVED_INSTEAD = 'Error: promise resolved "{ …(11) }" instead of rejecting';

describe('perkins integration R4 fail-before classifier', () => {
  it('accepts the named fast mutation refusal and all three named heavy assertions', () => {
    expect(assertPerkinsIntegrationBaseline('fast', report(red(FAST_TITLE, [RESOLVED_INSTEAD])))).toEqual(BASELINE_TITLES.fast);
    expect(assertPerkinsIntegrationBaseline('heavy', report(
      red(HEAVY_CRASH_TITLE!),
      red(HEAVY_CRASH_PROMOTION_TITLE!),
      red(HEAVY_PIN_TITLE!, ['AssertionError: expected \'d19d…\' to be \'83b5…\' // Object.is equality']),
    ))).toEqual(BASELINE_TITLES.heavy);
    // A plain matcher failure (and the promise-resolution variant) both count;
    // a timeout or setup error text does not.
    expect(isBehavioralAssertion('AssertionError: nope')).toBe(true);
    expect(isBehavioralAssertion(RESOLVED_INSTEAD)).toBe(true);
    expect(isBehavioralAssertion('Error: Test timed out in 120000ms')).toBe(false);
  });

  it('refuses an unexpected GREEN baseline', () => {
    expect(() => assertPerkinsIntegrationBaseline('fast', report(passed(FAST_TITLE))))
      .toThrow(/did not fail/u);
    expect(() => assertPerkinsIntegrationBaseline('heavy', report(
      red(HEAVY_CRASH_TITLE!),
      passed(HEAVY_CRASH_PROMOTION_TITLE!),
      red(HEAVY_PIN_TITLE!),
    ))).toThrow(/did not fail/u);
  });

  it('refuses a collection/setup failure, an unlisted failure and a non-behavioral message', () => {
    expect(() => assertPerkinsIntegrationBaseline('fast', {
      numFailedTests: 0,
      testResults: [{ status: 'failed', message: 'Failed to load url …', assertionResults: [] }],
    })).toThrow(/not behavioral RED/u);
    expect(() => assertPerkinsIntegrationBaseline('fast', report(
      red(FAST_TITLE),
      red('unrelated timeout', ['Error: waitFor timed out']),
    ))).toThrow(/unlisted failure/u);
    expect(() => assertPerkinsIntegrationBaseline('fast', report(
      red(FAST_TITLE, ['Error: Test timed out in 30000ms']),
    ))).toThrow(/before its assertion/u);
  });

  it('refuses a second error hiding behind the expected assertion, and zero messages', () => {
    // Each named failure is validated individually: a teardown error beside
    // the expected assertion is not a clean before-proof.
    expect(() => assertPerkinsIntegrationBaseline('heavy', report(
      red(HEAVY_CRASH_TITLE!, [`AssertionError: expected 'a' to be 'b'`, 'TypeError: cleanup failed after the assertion']),
      red(HEAVY_CRASH_PROMOTION_TITLE!),
      red(HEAVY_PIN_TITLE!),
    ))).toThrow(/2 failure message\(s\); exactly one assertion failure/u);
    expect(() => assertPerkinsIntegrationBaseline('fast', report(red(FAST_TITLE, []))))
      .toThrow(/0 failure message\(s\)/u);
  });

  it('refuses an unparseable report, a missing named regression and an unknown leg', () => {
    expect(() => assertPerkinsIntegrationBaseline('fast', null)).toThrow(/not behavioral RED/u);
    expect(() => assertPerkinsIntegrationBaseline('heavy', report())).toThrow(/not collected/u);
    expect(() => assertPerkinsIntegrationBaseline('other', report())).toThrow(/unknown baseline leg/u);
  });
});
