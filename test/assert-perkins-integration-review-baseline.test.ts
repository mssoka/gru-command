import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BASELINE_TITLES,
  assertPerkinsIntegrationBaseline,
  behavioralRefusal,
  frameLocation,
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

/** A verify scope's classifier leg, read as the tool reads it: the FIRST
 * argument after the script path (the tool takes no flags), quotes removed,
 * a plain word — a shell expansion or operator is no leg. */
const legOf = (command: string): string | undefined =>
  /assert-perkins-integration-review-baseline\.mjs["']?\s+(["']?)([A-Za-z0-9._-]+)\1(?=[\s;&|()<>`]|$)/u.exec(command)?.[2];

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

  it('locates frames by their full path, whatever spaces, parentheses or colons the path holds (#394)', () => {
    for (const [line, location] of [
      ['    at fn (/repo/test/a.test.ts:3:4)', '/repo/test/a.test.ts'],
      ['    at /repo/test/helpers/a (copy).test.ts:3:4', '/repo/test/helpers/a (copy).test.ts'],
      ['    at fn (/repo/a (copy)/x.ts:1:2)', '/repo/a (copy)/x.ts'],
      ['    at C:\\repo\\test\\..\\test\\a (copy).test.ts:3:4', 'C:/repo/test/a (copy).test.ts'],
      ['    at Object.<anonymous> (file:///repo/test/a.test.ts:9:1)', '/repo/test/a.test.ts'],
      // V8 token frames name no location (null): passed over, never refused.
      ['    at async Promise.all (index 0)', null],
      ['    at <anonymous>', null],
      ['    at Reflect.get (<anonymous>)', null],
      ['    at Array.map (native)', null],
      ['    at Module._compile (node:internal/modules/cjs/loader:1554:14)', 'node:internal/modules/cjs/loader'],
      ['    at eval (eval at load (file:///repo/test/helpers/h.ts:4:5), <anonymous>:1:1)', '/repo/test/helpers/h.ts'],
      ['    at eval (eval at load (file:///repo/test/helpers/a (copy).ts:4:5), <anonymous>:1:1)', '/repo/test/helpers/a (copy).ts'],
      ['    at eval (eval at a (eval at b (file:///x/test/helpers/n.ts:1:1), <anonymous>:2:2), <anonymous>:3:3)', '/x/test/helpers/n.ts'],
      ['    at file:///repo/test%2Fhelpers/encoded.ts:1:2', '/repo/test/helpers/encoded.ts'],
      ['    at file:///repo/test/%2e%2e/helpers/x.ts:1:2', '/repo/helpers/x.ts'],
      ['    at file:///repo/test/a.test.ts?t=1700000000:1:2', '/repo/test/a.test.ts'],
      ['    at file:///C:/repo/test/a.test.ts:1:2', 'C:/repo/test/a.test.ts'],
      ['    at async /repo/test/helpers/h.ts:4:5', '/repo/test/helpers/h.ts'],
      // A plain path keeps `?` and `#` (legal file-name characters) and is normalised.
      ['    at fn (/repo/test/../test/helpers/h?#.ts:1:2)', '/repo/test/helpers/h?#.ts'],
      // An eval origin is found whatever its function is called.
      ['    at eval (eval at Object.load [as x] (file:///repo/test/helpers/h.ts:4:5), <anonymous>:1:1)', '/repo/test/helpers/h.ts'],
      ['    at eval (eval at new Loader (/repo/test/helpers/h.ts:4:5), <anonymous>:1:1)', '/repo/test/helpers/h.ts'],
      // A spaced function name (`new X`, `async x`) on the eval frame itself.
      ['    at new Foo (eval at x (file:///repo/test/a.test.ts:1:2), <anonymous>:1:1)', '/repo/test/a.test.ts'],
      ['    at async run (eval at load (/repo/test/helpers/h.ts:4:5), <anonymous>:1:1)', '/repo/test/helpers/h.ts'],
      // A frame that names a location which cannot be judged is undefined.
      ['    at file:///repo/test/%E0%A4%A.ts:1:2', undefined],
      ['    at fn (test/helpers/h.ts:1:2)', undefined],
      ['    at fn (webpack-internal:///./test/helpers/h.ts:1:2)', undefined],
      ['    at eval (eval at load (somewhere), <anonymous>:1:1)', undefined],
    ] as const) expect(frameLocation(line), line).toBe(location);
    // An unlocatable frame BEFORE the deciding test frame refuses: it could
    // be the helper that raised the assertion.
    for (const frame of ['    at fn (test/helpers/h.ts:1:2)', '    at fn (webpack-internal:///./test/helpers/h.ts:1:2)', '    at file:///repo/test/%E0%A4%A.ts:1:2']) {
      expect(isBehavioralAssertion(`AssertionError: x\n${frame}\n    at /repo/test/a.test.ts:1:2`), frame).toBe(false);
    }
    // A frame-opening line too long to judge is never matched — and refuses.
    expect(isBehavioralAssertion(`AssertionError: x\n    at ${'a ('.repeat(5000)}/repo/test/helpers/h.ts:1:2)\n    at /repo/test/a.test.ts:1:2`)).toBe(false);
    // The bound is 2048 characters: a real frame at it is judged, one just
    // over it refuses by name.
    const frameOf = (length: number): string => { const head = '    at /repo/test/'; const tail = '.test.ts:1:2'; return `${head}${'d'.repeat(length - head.length - tail.length)}${tail}`; };
    expect(frameOf(2048)).toHaveLength(2048);
    expect(behavioralRefusal(`AssertionError: x\n${frameOf(2048)}`)).toBeNull();
    expect(behavioralRefusal(`AssertionError: x\n${frameOf(2049)}`)).toMatch(/^a frame-opening line is longer than 2048 characters: " {4}at \/repo\/test\/d+"…$/u);
    expect(behavioralRefusal(`AssertionError: x\n${frameOf(3000)}`)).toMatch(/^a frame-opening line is longer than 2048 characters: /u);
    // A spaced relative or upper-case-scheme helper location is a frame that
    // cannot be judged: it refuses rather than slipping by as prose.
    for (const frame of ['    at fn (test/my helpers/h.ts:1:2)', '    at FILE:///repo/test/helpers/h.ts:1:2', '    at fn (FILE:///repo/test/helpers/h.ts:1:2)']) {
      expect(isBehavioralAssertion(`AssertionError: x\n${frame}\n    at /repo/test/a.test.ts:1:2`), frame).toBe(false);
    }
    // ...and so is a bare relative helper location; a bare clock time stays prose.
    expect(isBehavioralAssertion('AssertionError: x\n    at test/helpers/h.ts:1:2\n    at /repo/test/a.test.ts:1:2')).toBe(false);
    expect(isBehavioralAssertion('AssertionError: x\n    at 12:30:15\n    at /repo/test/a.test.ts:1:2')).toBe(true);
    // An upper-case file scheme is decoded like a lower-case one.
    for (const frame of ['    at FILE:///repo/test/a.test.ts:1:2', '    at fn (FILE:///repo/test/a.test.ts:1:2)']) {
      expect(isBehavioralAssertion(`AssertionError: x\n${frame}`), frame).toBe(true);
    }
    // Any line terminator separates frames: a helper frame cannot hide behind one.
    for (const separator of ['\r', '\u2028', '\u2029', '\v', '\f', '\u0085']) {
      expect(isBehavioralAssertion(`AssertionError: x${separator}    at /repo/test/helpers/h.ts:1:2${separator}    at /repo/test/a.test.ts:1:2`), JSON.stringify(separator)).toBe(false);
    }
    // A stack of only generated frames, bare or parenthesised, decides nothing: refused.
    expect(isBehavioralAssertion('AssertionError: x\n    at <anonymous>:1:1\n    at evalmachine.<anonymous>:2:3')).toBe(false);
    // A path holding "(eval at …)" is no eval frame.
    expect(isBehavioralAssertion('AssertionError: x\n    at /repo/test/(eval at x)/a.test.ts:1:2')).toBe(true);
    // Generated code (new Function, vm scripts) names no file: passed over.
    expect(isBehavioralAssertion('AssertionError: x\n    at fn (<anonymous>:1:1)\n    at run (evalmachine.<anonymous>:2:3)\n    at /repo/test/a.test.ts:1:2')).toBe(true);
    // A path that merely contains "eval at " is not an eval frame.
    expect(isBehavioralAssertion('AssertionError: x\n    at /repo/test/eval at x/a.test.ts:1:2')).toBe(true);
    // An async helper frame is still a helper; a vite-stamped test URL is a test.
    expect(isBehavioralAssertion('AssertionError: x\n    at async /repo/test/helpers/h.ts:4:5')).toBe(false);
    expect(isBehavioralAssertion('AssertionError: x\n    at file:///repo/test/a.test.ts?t=1:1:2')).toBe(true);
    // Real V8 shapes stay frames: node: internals, <anonymous> and native calls.
    expect(isBehavioralAssertion('AssertionError: x\n    at new Foo (<anonymous>)\n    at Module._compile (node:internal/modules/cjs/loader:1554:14)\n    at Array.map (native)\n    at /repo/test/a.test.ts:1:2')).toBe(true);
    // An eval called from a helper, or an encoded helper URL, is still a helper.
    expect(isBehavioralAssertion('AssertionError: x\n    at eval (eval at load (file:///repo/test/helpers/h.ts:4:5), <anonymous>:1:1)')).toBe(false);
    expect(isBehavioralAssertion('AssertionError: x\n    at file:///repo/test%2Fhelpers/encoded.ts:1:2')).toBe(false);
    // Indented prose with parentheses or a clock time is no frame — but prose
    // shaped exactly like a frame location is judged as one and refuses
    // (fail closed: rephrase such an assertion message).
    expect(isBehavioralAssertion('AssertionError: expected list\n    at least 3 items (see docs)\n    at 12:30:15 the job ran')).toBe(true);
    expect(isBehavioralAssertion('AssertionError: expected list\n    at least 3 items (see notes.md:1:2)')).toBe(false);
    expect(isBehavioralAssertion('AssertionError: expected list\n    at least 3 items (see docs)\n    at /repo/test/a.test.ts:1:2')).toBe(true);
    // A helper path holding parentheses is still a helper.
    expect(isBehavioralAssertion('AssertionError: x\n    at /repo/test/helpers/a (copy).test.ts:3:4')).toBe(false);
    // Indented prose in a matcher message is not a stack.
    expect(isBehavioralAssertion('AssertionError: expected list\n    at least one item was required\n    at /repo/test/a.test.ts:1:2')).toBe(true);
    expect(isBehavioralAssertion('AssertionError: expected list\n    at least one item was required')).toBe(true);
    // pnpm layouts of the assertion machinery are machinery too.
    expect(isBehavioralAssertion([
      'AssertionError: x',
      '    at check (file:///repo/node_modules/.pnpm/vitest@3.2.7/node_modules/@vitest/expect/dist/index.js:1:2)',
      '    at file:///repo/test/a.test.ts:5:6',
    ].join('\n'))).toBe(true);
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
    const manifest = loadWorktreeManifest(join(import.meta.dirname, '..'));
    if (manifest === null) throw new Error('the repository has no .gru-command/worktree.toml manifest');
    const scopes = Object.entries(manifest.verify).filter(([, command]) => command.includes('assert-perkins-integration-review-baseline.mjs'));
    for (const [name, command] of scopes) expect(legOf(command), `${name} names its classifier leg`).toBeDefined();
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

  it('names why a failure is no behavioral RED, line and all', () => {
    expect(behavioralRefusal('AssertionError: expected list\n    at least 3 items (see notes.md:1:2)'))
      .toBe('a frame names a location that cannot be judged (rephrase prose shaped like a frame): "at least 3 items (see notes.md:1:2)"');
    expect(behavioralRefusal('AssertionError: x\n    at stage (/repo/test/helpers/h.ts:1:2)')).toBe('the assertion was raised outside a test file, in "/repo/test/helpers/h.ts"');
    expect(behavioralRefusal('TypeError: nope')).toBe('its first line is no assertion or rejects/resolves report: "TypeError: nope"');
    expect(behavioralRefusal('AssertionError: x\n    at <anonymous>')).toBe('its stack names only runtime, machinery or generated frames');
    expect(behavioralRefusal('AssertionError: x\n    at /repo/test/a.test.ts:1:2')).toBeNull();
    expect(behavioralRefusal(undefined)).toBe('the failure message is not text');
    expect(isBehavioralAssertion(42)).toBe(false);
    // A located `at …` line the grammar cannot read refuses by name; a bare clock time is prose.
    expect(behavioralRefusal('AssertionError: x\n    at stage:1:2\n    at /repo/test/a.test.ts:1:2'))
      .toBe('a frame names a location that cannot be judged (rephrase prose shaped like a frame): "at stage:1:2"');
    expect(behavioralRefusal('AssertionError: x\n    at test/my helpers/h.ts:1:2\n    at /repo/test/a.test.ts:1:2'))
      .toBe('a frame names a location that cannot be judged (rephrase prose shaped like a frame): "at test/my helpers/h.ts:1:2"');
    expect(behavioralRefusal('AssertionError: x\n    at 12:30:15\n    at /repo/test/a.test.ts:1:2')).toBeNull();
    // Layout never hides a frame: trailing blanks, or a tab after `at`.
    for (const helper of ['    at /repo/test/helpers/h.ts:1:2 ', '    at\t/repo/test/helpers/h.ts:1:2', '    at  fn (/repo/test/helpers/h.ts:1:2)']) {
      expect(behavioralRefusal(`AssertionError: x\n${helper}\n    at /repo/test/a.test.ts:1:2`), JSON.stringify(helper)).toBe('the assertion was raised outside a test file, in "/repo/test/helpers/h.ts"');
    }
    // A location without a column, or with text after it, is located and unreadable: refused.
    for (const frame of ['    at fn (test/x.ts:12)', '    at fn (/repo/test/helpers/h.ts:1:2) extra']) {
      expect(behavioralRefusal(`AssertionError: x\n${frame}\n    at /repo/test/a.test.ts:1:2`), frame).toMatch(/^a frame names a location that cannot be judged/u);
    }
    // Frames after the deciding test-file frame are its callers: not judged —
    // an unreadable one, or one too long to judge.
    expect(behavioralRefusal('AssertionError: x\n    at /repo/test/a.test.ts:1:2\n    at stage:1:2')).toBeNull();
    expect(behavioralRefusal(`AssertionError: x\n    at /repo/test/a.test.ts:1:2\n    at ${'a'.repeat(3000)}:1:2`)).toBeNull();
    // ...but one BEFORE the deciding frame still refuses, as too long to judge.
    expect(behavioralRefusal(`AssertionError: x\n    at ${'a'.repeat(3000)}:1:2\n    at /repo/test/a.test.ts:1:2`)).toMatch(/^a frame-opening line is longer than 2048 characters: /u);
    // Any dotted, slashed or backslashed token before a :line is a location (fail closed).
    for (const frame of ['    at helper.ts:12 extra', '    at notes.v2-final:3 x', '    at a.7z:3 x', '    at test\\helpers\\h:12 x']) {
      expect(behavioralRefusal(`AssertionError: x\n${frame}\n    at /repo/test/a.test.ts:1:2`), frame).toMatch(/^a frame names a location that cannot be judged/u);
    }
    // Prose whose numbers are not attached to a path is no location.
    for (const prose of ['    at version 1.2:3 failed', '    at least 1.5:1 ratio', '    at v2.0:3 sites']) {
      expect(behavioralRefusal(`AssertionError: x\n${prose}\n    at /repo/test/a.test.ts:1:2`), prose).toBeNull();
    }
    // A long dotted line is judged in linear time (no backtracking blow-up).
    const started = performance.now();
    expect(behavioralRefusal(`AssertionError: x\n    at ${'a.'.repeat(1000)}\n    at /repo/test/a.test.ts:1:2`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(500);
    // A huge line is quoted cut and marked (the prefix bound itself is not observable here).
    expect(behavioralRefusal(`TypeError: ${'z'.repeat(5_000_000)}`)).toBe(`its first line is no assertion or rejects/resolves report: ${JSON.stringify(`TypeError: ${'z'.repeat(149)}`)}…`);
    // A quoted line is cut on a code point, never inside a surrogate pair.
    const emoji = behavioralRefusal(`TypeError: ${'😀'.repeat(200)}`)!;
    expect(emoji).toBe(`its first line is no assertion or rejects/resolves report: ${JSON.stringify(`TypeError: ${'😀'.repeat(149)}`)}…`);
    expect(() => assertPerkinsIntegrationBaseline('fast', report(red(FAST_TITLE, ['AssertionError: x\n    at stage (/repo/test/helpers/h.ts:1:2)']))))
      .toThrow(/failed before its assertion; setup\/import failure is not RED evidence \(the assertion was raised outside a test file, in "\/repo\/test\/helpers\/h\.ts"\)/u);
  });

  it('reads a scope\'s classifier leg as the tool does: its first argument, a plain word', () => {
    expect(['x.mjs fast r.json', 'assert-perkins-integration-review-baseline.mjs "r8" "$d/r.json"', "assert-perkins-integration-review-baseline.mjs' heavy;",
      'assert-perkins-integration-review-baseline.mjs r9&&true', 'assert-perkins-integration-review-baseline.mjs r10)', 'assert-perkins-integration-review-baseline.mjs $LEG r.json',
      'assert-perkins-integration-review-baseline.mjs "r8\' r.json', "assert-perkins-integration-review-baseline.mjs 'r8' r.json"]
      .map(legOf)).toEqual([undefined, 'r8', 'heavy', 'r9', 'r10', undefined, undefined, 'r8']);
  });

  it('refuses an unparseable report, a missing named regression and an unknown leg', () => {
    expect(() => assertPerkinsIntegrationBaseline('fast', null)).toThrow(/not behavioral RED/u);
    expect(() => assertPerkinsIntegrationBaseline('heavy', report())).toThrow(/not collected/u);
    expect(() => assertPerkinsIntegrationBaseline('other', report())).toThrow(/unknown baseline leg/u);
  });
});
