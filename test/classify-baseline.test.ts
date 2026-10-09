import { describe, expect, it } from 'vitest';
import { classifyBaseline } from '../tools/classify-baseline.mjs';

// The baseline classifier is the acceptance evidence for "the feature is
// absent on the recorded base": its exit code is what the two baseline
// scopes return. These tests feed synthetic vitest and Playwright reports
// and pin every classification branch, so a misclassification (setup or
// load failure read as behavioral RED, or an unexpected green read as RED)
// cannot ship undetected. Mirrors test/assert-binned-baseline.test.ts.

interface AssertionResult {
  readonly title: string;
  readonly status: string;
  readonly failureMessages: readonly string[];
}
interface VitestSuite {
  readonly name: string;
  readonly status: string;
  readonly message: string;
  readonly assertionResults: readonly AssertionResult[];
}

const vitestReport = (files: readonly VitestSuite[]) => ({
  numTotalTests: files.reduce((n, f) => n + f.assertionResults.length, 0),
  numPassedTests: files.reduce((n, f) => n + f.assertionResults.filter((a) => a.status === 'passed').length, 0),
  numFailedTests: files.reduce((n, f) => n + f.assertionResults.filter((a) => a.status === 'failed').length, 0),
  testResults: files,
});

const assertion = (title: string, status: string, failureMessages: readonly string[] = []): AssertionResult => ({
  title,
  status,
  failureMessages,
});

const playwrightReport = (results: readonly { title: string; message: string }[]) => ({
  stats: { expected: 0, unexpected: results.length, skipped: 0, flaky: 0 },
  suites: [
    {
      specs: results.map((r) => ({
        title: r.title,
        ok: false,
        tests: [{ status: 'unexpected', results: [{ status: 'failed', error: { message: r.message } }] }],
      })),
    },
  ],
});

describe('baseline classifier — setup/collection failures are never behavioral evidence', () => {
  it('exits 3 for an unreadable/absent report and for zero collected tests', () => {
    expect(classifyBaseline(null).code).toBe(3);
    expect(classifyBaseline(undefined).code).toBe(3);
    const empty = classifyBaseline(vitestReport([]));
    expect(empty.code).toBe(3);
    expect(empty.err).toMatch(/zero tests collected/u);
  });

  it('exits 3 when a suite failed to LOAD (import/collection error, no assertions)', () => {
    const report = classifyBaseline(
      vitestReport([
        { name: 'a.test.ts', status: 'failed', message: 'Failed to load url ../lib/gone.js', assertionResults: [] },
        { name: 'b.test.ts', status: 'passed', message: '', assertionResults: [assertion('ok', 'passed')] },
      ]),
    );
    expect(report.code).toBe(3);
    expect(report.err).toMatch(/module load errors/u);
  });
});

describe('baseline classifier — vitest (unit) branch', () => {
  const instrument = [
    { name: 'slim-strip.baseline.test.ts', status: 'failed', message: '', assertionResults: [
      assertion('strip pairs absent on base', 'failed', ['AssertionError: slim strip labelled status pairs: expected null to be truthy']),
    ] },
  ];

  it('exits 1 when every instrument test fails by AssertionError (per-test cause)', () => {
    const result = classifyBaseline(vitestReport(instrument), { requireFile: 'slim-strip.baseline.test.ts' });
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/BASELINE RED CLASSIFIED/u);
    expect(result.out).toMatch(/every test failed by AssertionError/u);
  });

  it('reports non-assertion overlay failures separately and never claims them as behavioral', () => {
    const result = classifyBaseline(
      vitestReport([
        ...instrument,
        { name: 'board.test.ts', status: 'failed', message: '', assertionResults: [
          assertion('renders the strip', 'failed', ["TypeError: Cannot read properties of null (reading 'click')"]),
        ] },
      ]),
      { requireFile: 'slim-strip.baseline.test.ts' },
    );
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/1 non-assertion failure\(s\) reported but NOT claimed as behavioral assertions/u);
  });

  it('exits 2 (claim broken) when the baseline passes, and when the instrument did not fail', () => {
    expect(classifyBaseline(vitestReport([{ name: 'x.test.ts', status: 'passed', message: '', assertionResults: [assertion('ok', 'passed')] }])).code).toBe(2);
    const instrumentPassed = classifyBaseline(
      vitestReport([{ name: 'slim-strip.baseline.test.ts', status: 'passed', message: '', assertionResults: [assertion('strip present', 'passed')] }]),
      { requireFile: 'slim-strip.baseline.test.ts' },
    );
    expect(instrumentPassed.code).toBe(2);
  });

  it('exits 3 when the instrument failed for a NON-assertion reason (setup, not feature absence)', () => {
    const result = classifyBaseline(
      vitestReport([{ name: 'slim-strip.baseline.test.ts', status: 'failed', message: '', assertionResults: [
        assertion('rail mounts', 'failed', ["TypeError: Cannot read properties of undefined (reading 'status')"]),
      ] }]),
      { requireFile: 'slim-strip.baseline.test.ts' },
    );
    expect(result.code).toBe(3);
    expect(result.err).toMatch(/not AssertionErrors/u);
  });

  it('exits 3 when the named instrument file is absent from the report', () => {
    const result = classifyBaseline(vitestReport(instrument), { requireFile: 'other.baseline.test.ts' });
    expect(result.code).toBe(3);
  });

  it('exits 3 when the instrument suite registered no tests (collection fault, not a broken claim)', () => {
    // Another suite registers a test, so the run is not globally empty — the
    // instrument itself is the empty one.
    const empty = classifyBaseline(
      vitestReport([
        { name: 'board.test.ts', status: 'failed', message: '', assertionResults: [assertion('x', 'failed', ['AssertionError: nope'])] },
        { name: 'slim-strip.baseline.test.ts', status: 'failed', message: '', assertionResults: [] },
      ]),
      { requireFile: 'slim-strip.baseline.test.ts' },
    );
    expect(empty.code).toBe(3);
    expect(empty.err).toMatch(/registered no tests/u);
  });

  it('exits 3 without --require-file when nothing failed by assertion (RED must stay identified)', () => {
    const result = classifyBaseline(
      vitestReport([{ name: 'x.test.ts', status: 'failed', message: '', assertionResults: [
        assertion('renders', 'failed', ["TypeError: Cannot read properties of null (reading 'click')"]),
      ] }]),
    );
    expect(result.code).toBe(3);
    expect(result.err).toMatch(/none is an AssertionError/u);
  });
});

describe('baseline classifier — Playwright (browser) branch', () => {
  const substrs = ['strip-status', 'strip-groups'];

  it('exits 1 only when EVERY unexpected failure names a missing slim surface', () => {
    const result = classifyBaseline(
      playwrightReport([
        { title: 'rail carries the strip pairs', message: "locator('.strip-status') expected 1" },
        { title: 'groups render', message: "toHaveCount failed for '.strip-groups'" },
      ]),
      { playwright: true, substrs },
    );
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/per-test cause established/u);
  });

  it('exits 3 when an unexpected failure names NO slim surface (unclassified cause)', () => {
    const result = classifyBaseline(
      playwrightReport([
        { title: 'rail carries the strip pairs', message: "locator('.strip-status') expected 1" },
        { title: 'navigation', message: 'Timeout 30000ms exceeded waiting for load state' },
      ]),
      { playwright: true, substrs },
    );
    expect(result.code).toBe(3);
    expect(result.err).toMatch(/name NO slim surface/u);
  });

  it('reads a timedOut/unexpected result message instead of mapping it to an empty string', () => {
    const report = {
      stats: { expected: 0, unexpected: 1, skipped: 0, flaky: 0 },
      suites: [
        { specs: [{ title: 'rail', ok: false, tests: [{ status: 'unexpected', results: [
          { status: 'timedOut', error: { message: "locator('.strip-groups') timeout" } },
        ] }] }] },
      ],
    };
    const result = classifyBaseline(report, { playwright: true, substrs: ['strip-groups'] });
    expect(result.code).toBe(1);
  });

  it('exits 3 when none match, and 2 when nothing failed', () => {
    const none = classifyBaseline(playwrightReport([{ title: 'x', message: 'some unrelated failure' }]), { playwright: true, substrs });
    expect(none.code).toBe(3);
    const green = classifyBaseline({ stats: { expected: 5, unexpected: 0, skipped: 0, flaky: 0 }, suites: [] }, { playwright: true, substrs });
    expect(green.code).toBe(2);
    const zero = classifyBaseline({ stats: { expected: 0, unexpected: 0, skipped: 0, flaky: 0 }, suites: [] }, { playwright: true, substrs });
    expect(zero.code).toBe(3);
  });
});
