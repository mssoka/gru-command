import { describe, expect, it } from 'vitest';
import {
  EXPECTED_BASELINE_REASON,
  EXPECTED_BASELINE_TITLE,
  assertVerificationHistoryBaseline,
} from '../tools/assert-verification-history-baseline.mjs';

const TITLE = EXPECTED_BASELINE_TITLE;

function red(messages: readonly string[] = [`AssertionError: promise rejected "Error: ${EXPECTED_BASELINE_REASON} …"`]) {
  return { title: TITLE, status: 'failed', failureMessages: messages };
}

function report(...assertions: readonly Record<string, unknown>[]) {
  return {
    numFailedTests: assertions.filter((entry) => entry['status'] === 'failed').length,
    testResults: [{ assertionResults: assertions }],
  };
}

describe('verification-history fail-before classifier', () => {
  it('accepts the named 208-run regression failing with the recorded window reason', () => {
    expect(assertVerificationHistoryBaseline(report(red()))).toBe(TITLE);
  });

  it('refuses an unexpected GREEN baseline', () => {
    expect(() => assertVerificationHistoryBaseline(report({ title: TITLE, status: 'passed', failureMessages: [] })))
      .toThrow(/did not fail/u);
  });

  it('refuses a collection/setup failure, an unlisted failure and a lost reason', () => {
    expect(() => assertVerificationHistoryBaseline({
      numFailedTests: 0,
      testResults: [{ status: 'failed', message: 'Failed to load url …', assertionResults: [] }],
    })).toThrow(/not behavioral RED/u);
    expect(() => assertVerificationHistoryBaseline(report(red(), { title: 'unrelated timeout', status: 'failed', failureMessages: ['Error: waitFor timed out'] })))
      .toThrow(/unlisted failure/u);
    expect(() => assertVerificationHistoryBaseline(report(red(['AssertionError: expected 1 to be 1']))))
      .toThrow(/recorded window reason/u);
    expect(() => assertVerificationHistoryBaseline(report(red(['TypeError: Cannot read properties of undefined']))))
      .toThrow(/before its assertion/u);
  });

  it('refuses an unparseable report and a missing named regression', () => {
    expect(() => assertVerificationHistoryBaseline(null)).toThrow(/not behavioral RED/u);
    expect(() => assertVerificationHistoryBaseline(report())).toThrow(/not collected/u);
  });
});
