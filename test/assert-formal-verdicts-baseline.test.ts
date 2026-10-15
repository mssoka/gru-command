import { describe, expect, it } from 'vitest';
import {
  assertFormalVerdictsBaselineLeg,
  assertNamedRedBaselineLeg,
  EXPECTED_FORMAL_EVENT_ASSERTIONS,
  EXPECTED_FORMAL_EVENT_FAILURE_MARKERS,
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
  it('accepts a leg only when every named formal-event assertion fails at its designated contract assertion', () => {
    for (const [label, titles] of Object.entries(EXPECTED_FORMAL_EVENT_ASSERTIONS)) {
      const markers = EXPECTED_FORMAL_EVENT_FAILURE_MARKERS[label as keyof typeof EXPECTED_FORMAL_EVENT_FAILURE_MARKERS];
      const line = assertFormalVerdictsBaselineLeg(
        label,
        report(...titles.map((title, index) => assertion(
          title, 'failed', [`Error: ${markers[index]} expected the provider to enact the formal state`],
        ))),
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

  it('rejects generic assertions and setup failures that do not identify the contract assertion', () => {
    const titles = EXPECTED_FORMAL_EVENT_ASSERTIONS.wave;
    const generic = titles.map((title) => assertion(title, 'failed', ['AssertionError: unrelated expectation failed']));
    expect(() => assertFormalVerdictsBaselineLeg('wave', report(...generic), titles))
      .toThrow(/without its intended formal-event assertion marker/);
    const wrongMarker = titles.map((title, index) => assertion(
      title, 'failed', [`Error: ${EXPECTED_FORMAL_EVENT_FAILURE_MARKERS.wave[(index + 1) % titles.length]} unrelated`],
    ));
    expect(() => assertFormalVerdictsBaselineLeg('wave', report(...wrongMarker), titles))
      .toThrow(/without its intended formal-event assertion marker/);
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

  it('preserves the generic named-red classifier for R2-R6 while formal baselines use assertion markers', () => {
    expect(assertNamedRedBaselineLeg('r6', report(assertion('existing named regression', 'failed', ['AssertionError: expected false to be true'])), ['existing named regression']))
      .toContain('1 named assertion(s) RED behaviorally');
    expect(() => assertNamedRedBaselineLeg(
      'r6', report(assertion('legacy regression', 'failed', ['Error: FORMAL_EVENT_ASSERTION:app-approve-receipt unrelated'])), ['legacy regression'],
    )).toThrow(/failure carries no formal-event behavioral marker/u);
    const titles = EXPECTED_FORMAL_EVENT_ASSERTIONS.app;
    const failures = titles.map((title, index) => assertion(
      title, 'failed', [`Error: ${EXPECTED_FORMAL_EVENT_FAILURE_MARKERS.app[index]} expected a formal state`],
    ));
    const line = assertFormalVerdictsBaselineLeg('app', report(
      ...failures,
      assertion('some unrelated later-main regression', 'failed', ['AssertionError: unrelated']),
    ), titles);
    expect(line).toContain('1 unrelated failure(s) excluded from the claim');
  });
});
