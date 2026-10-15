import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_TITLES,
  assertPerkinsIntegrationBaseline,
  isBehavioralAssertion,
} from '../tools/assert-perkins-integration-review-baseline.mjs';
import { loadWorktreeManifest } from '../src/worktrees/manifest.js';

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
    expect(assertPerkinsIntegrationBaseline('r7', report(red(BASELINE_TITLES.r7[0]!, [
      'AssertionError: expected null not to be null',
    ])))).toEqual(BASELINE_TITLES.r7);
    expect(assertPerkinsIntegrationBaseline('r8', report(
      red(BASELINE_TITLES.r8[0]!, ['AssertionError: expected null not to be null']),
      red(BASELINE_TITLES.r8[1]!, ['AssertionError: expected [ { …(2) } ] to match object { …(1) }']),
    ))).toEqual(BASELINE_TITLES.r8);
    expect(assertPerkinsIntegrationBaseline('r9', report(red(BASELINE_TITLES.r9[0]!, [
      "AssertionError: expected { …(9) } to match object { status: 'aborted', verdict: null }",
    ])))).toEqual(BASELINE_TITLES.r9);
    expect(assertPerkinsIntegrationBaseline('r10', report(red(BASELINE_TITLES.r10[0]!, [
      "AssertionError: expected { …(9) } to match object { status: 'aborted', verdict: null }",
    ])))).toEqual(BASELINE_TITLES.r10);
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
    expect(() => assertPerkinsIntegrationBaseline('r7', report(passed(BASELINE_TITLES.r7[0]!))))
      .toThrow(/did not fail/u);
    expect(() => assertPerkinsIntegrationBaseline('r8', report(
      red(BASELINE_TITLES.r8[0]!),
      passed(BASELINE_TITLES.r8[1]!),
    ))).toThrow(/did not fail/u);
    expect(() => assertPerkinsIntegrationBaseline('r9', report(passed(BASELINE_TITLES.r9[0]!))))
      .toThrow(/did not fail/u);
    expect(() => assertPerkinsIntegrationBaseline('r10', report(passed(BASELINE_TITLES.r10[0]!))))
      .toThrow(/did not fail/u);
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

  it('refuses a setup-stage failure that merely embeds an assertion string, and a helper-raised assertion (#394)', () => {
    // A wrapped setup error carrying an inner AssertionError text.
    for (const wrapped of [
      'Error: fixture setup failed: AssertionError: expected false to be true',
      'TypeError: cannot read properties of undefined (reading \'AssertionError: x\')',
      'Error: beforeEach hook failed\nCaused by: AssertionError: expected 1 to be 2',
    ]) {
      expect(isBehavioralAssertion(wrapped), wrapped).toBe(false);
      expect(() => assertPerkinsIntegrationBaseline('fast', report(red(FAST_TITLE, [wrapped])))).toThrow(/before its assertion/u);
    }
    // An assertion raised inside a shared helper module is setup, not the claim.
    const helperRaised = [
      'AssertionError: expected false to be true // Object.is equality',
      '    at stageFixture (/repo/test/helpers/fixture-repo.ts:41:22)',
      '    at /repo/test/perkins-integration-review.test.ts:120:5',
    ].join('\n');
    expect(isBehavioralAssertion(helperRaised)).toBe(false);
    const dependencyRaised = [
      'AssertionError: expected 1 to be 2',
      '    at Object.check (/repo/node_modules/some-lib/index.js:9:3)',
    ].join('\n');
    expect(isBehavioralAssertion(dependencyRaised)).toBe(false);
    // The named test's own assertion, with its stack, still qualifies.
    const testRaised = [
      "AssertionError: expected 'd19d…' to be '83b5…' // Object.is equality",
      '    at /repo/test/perkins-integration-recovery.test.ts:812:40',
      '    at processTicksAndRejections (node:internal/process/task_queues:105:5)',
    ].join('\n');
    expect(isBehavioralAssertion(testRaised)).toBe(true);
    expect(isBehavioralAssertion(`${RESOLVED_INSTEAD}\n    at /repo/test/perkins-integration-review.test.ts:77:9`)).toBe(true);
  });

  it('judges real Vitest stack shapes: machinery frames skipped, file:// and odd paths located, unlocatable stacks refused (#394)', () => {
    // Real report shape: the assertion machinery's file:// frames come first.
    const machineryFirst = [
      `${RESOLVED_INSTEAD}`,
      '    at _Assertion.__VITEST_RESOLVES__ (file:///repo/node_modules/@vitest/expect/dist/index.js:1577:17)',
      '    at Reflect.get (<anonymous>)',
      '    at Object.proxyGetter [as get] (file:///repo/node_modules/chai/index.js:1645:22)',
      '    at file:///repo/test/perkins-integration-review.test.ts:146:29',
      '    at processTicksAndRejections (node:internal/process/task_queues:105:5)',
    ].join('\n');
    expect(isBehavioralAssertion(machineryFirst)).toBe(true);
    // The same shape with a helper as the first non-machinery frame is setup.
    expect(isBehavioralAssertion(machineryFirst.replace('/repo/test/perkins-integration-review.test.ts', '/repo/test/helpers/fixture-repo.ts'))).toBe(false);
    // Windows drive paths, parentheses in paths and CRLF line endings.
    expect(isBehavioralAssertion('AssertionError: x\r\n    at C:\\repo\\test\\a (copy).test.ts:3:4')).toBe(true);
    expect(isBehavioralAssertion('AssertionError: x\r\n    at fn (file:///repo/test/helpers/h (1).ts:3:4)')).toBe(false);
    // A stack present but nothing in it locatable (or only machinery) is refused.
    expect(isBehavioralAssertion('AssertionError: x\n    at async Promise.all (index 0)\n    at <anonymous>')).toBe(false);
    expect(isBehavioralAssertion('AssertionError: x\n    at processTicksAndRejections (node:internal/process/task_queues:105:5)')).toBe(false);
    // A report with no stack lines at all is judged by its head.
    expect(isBehavioralAssertion('AssertionError: expected 1 to be 2')).toBe(true);
  });

  it('every classifier leg is wired to declared verification scopes that run exactly its named regressions (#394)', () => {
    // The fail-before claim never depends on someone running the classifier
    // by hand: each leg is invoked by declared [verify] scopes, parsed from
    // the manifest (comments never count), and EVERY scope of a leg checks
    // out its uncorrected base, emits a JSON report and selects that leg's
    // named regressions and no other leg's.
    const manifest = loadWorktreeManifest(join(import.meta.dirname, '..'))!;
    const scopes = Object.entries(manifest.verify).filter(([, command]) => command.includes('assert-perkins-integration-review-baseline.mjs'));
    const legOf = (command: string): string | undefined => /assert-perkins-integration-review-baseline\.mjs" (\S+) /u.exec(command)?.[1];
    for (const [leg, titles] of Object.entries(BASELINE_TITLES)) {
      const own = scopes.filter(([, command]) => legOf(command) === leg);
      expect(own.length, `leg ${leg} has a declared verification scope`).toBeGreaterThan(0);
      const others = Object.entries(BASELINE_TITLES).filter(([other]) => other !== leg).flatMap(([, list]) => list).filter((title) => !titles.includes(title));
      for (const [name, command] of own) {
        expect(command, `${name} checks out its uncorrected base`).toMatch(/\bbase=[0-9a-f]{40}\b[\s\S]*git archive "\$base"/u);
        expect(command, `${name} emits a JSON report`).toContain('--reporter=json');
        const filter = /-t "([^"]+)"/u.exec(command)?.[1];
        expect(filter, `${name} selects its regressions by name`).toBeDefined();
        const pattern = new RegExp(filter!, 'u');
        for (const title of titles) expect(pattern.test(title), `${name}: ${title}`).toBe(true);
        for (const title of others) expect(pattern.test(title), `${name} must not select ${title}`).toBe(false);
      }
    }
    // No scope invokes an unknown leg.
    for (const [name, command] of scopes) expect(Object.keys(BASELINE_TITLES), name).toContain(legOf(command));
  });

  it('refuses an unparseable report, a missing named regression and an unknown leg', () => {
    expect(() => assertPerkinsIntegrationBaseline('fast', null)).toThrow(/not behavioral RED/u);
    expect(() => assertPerkinsIntegrationBaseline('heavy', report())).toThrow(/not collected/u);
    expect(() => assertPerkinsIntegrationBaseline('other', report())).toThrow(/unknown baseline leg/u);
  });
});
