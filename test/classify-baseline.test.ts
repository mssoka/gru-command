import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
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
  errors: [],
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

const playwrightStatusReport = (statuses: readonly ('expected' | 'unexpected' | 'skipped' | 'flaky')[]) => ({
  errors: [],
  stats: {
    expected: statuses.filter((status) => status === 'expected').length,
    unexpected: statuses.filter((status) => status === 'unexpected').length,
    skipped: statuses.filter((status) => status === 'skipped').length,
    flaky: statuses.filter((status) => status === 'flaky').length,
  },
  suites: [{
    specs: statuses.map((status, index) => ({
      title: `test-${index}`,
      ok: status !== 'unexpected',
      tests: [{ status, results: [] }],
    })),
  }],
});

const classifierCliPath = fileURLToPath(new URL('../tools/classify-baseline.mjs', import.meta.url));
const runClassifierCli = (args: readonly string[], report: unknown) => {
  const directory = mkdtempSync(join(tmpdir(), 'gru-baseline-classifier-'));
  try {
    const reportPath = join(directory, 'report.json');
    writeFileSync(reportPath, JSON.stringify(report));
    return spawnSync(process.execPath, [classifierCliPath, reportPath, ...args], { encoding: 'utf8', timeout: 10_000 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

describe('baseline classifier CLI — required option values fail closed', () => {
  it('rejects --require-file without a value instead of using generic RED classification', () => {
    const report = vitestReport([
      { name: 'board.test.ts', status: 'failed', message: '', assertionResults: [
        assertion('unrelated assertion', 'failed', ['AssertionError: unrelated failure']),
      ] },
    ]);
    const result = runClassifierCli(['--require-file'], report);
    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/--require-file requires a non-empty value/u);
  });

  it('rejects a missing or empty --require-file-substr allowlist instead of disabling cause checks', () => {
    const report = vitestReport([
      { name: 'slim-strip.baseline.test.ts', status: 'failed', message: '', assertionResults: [
        assertion('mount guard', 'failed', ['AssertionError: rail mount guard failed']),
      ] },
    ]);
    for (const optionValue of [undefined, ',,']) {
      const args = ['--require-file', 'slim-strip.baseline.test.ts', '--require-file-substr'];
      if (optionValue !== undefined) args.push(optionValue);
      const result = runClassifierCli(args, report);
      expect(result.status).toBe(3);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/--require-file-substr requires/u);
    }
  });

  it('classifies a malformed nested Vitest report as setup failure instead of a false RED', () => {
    const result = runClassifierCli(
      ['--require-file', 'slim-strip.baseline.test.ts', '--require-file-substr', 'slim strip labelled status pairs'],
      { numTotalTests: 1, numPassedTests: 0, numFailedTests: 1, testResults: [null] },
    );
    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/invalid report shape/u);
  });

  it('requires a cause allowlist when a named instrument is selected', () => {
    const result = runClassifierCli(
      ['--require-file', 'slim-strip.baseline.test.ts'],
      vitestReport([{ name: 'slim-strip.baseline.test.ts', status: 'failed', message: '', assertionResults: [
        assertion('setup guard', 'failed', ['AssertionError: board sections rendered']),
      ] }]),
    );
    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/--require-file requires --require-file-substr/u);
  });

  it('rejects a cause allowlist without its named instrument instead of ignoring it', () => {
    const result = runClassifierCli(
      ['--require-file-substr', 'slim strip labelled status pairs'],
      vitestReport([{ name: 'board.test.ts', status: 'failed', message: '', assertionResults: [
        assertion('unrelated setup assertion', 'failed', ['AssertionError: fixture setup guard failed']),
      ] }]),
    );
    expect(result.status).toBe(3);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/--require-file-substr requires --require-file/u);
  });
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

  it('rejects malformed or inconsistent Vitest counters before accepting feature absence', () => {
    const report = vitestReport(instrument);
    for (const mismatched of [
      { ...report, numTotalTests: report.numTotalTests + 1 },
      { ...report, numPassedTests: report.numPassedTests + 1 },
      { ...report, numFailedTests: report.numFailedTests - 1 },
    ]) {
      const result = classifyBaseline(mismatched, { requireFile: 'slim-strip.baseline.test.ts' });
      expect(result.code).toBe(3);
      expect(result.out).toBe('');
      expect(result.err).toMatch(/Vitest counters disagree with test tree/u);
    }

    for (const malformed of [
      { ...report, numPassedTests: '0' },
      { ...report, numFailedTests: -1 },
      { ...report, numTotalTests: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      const result = classifyBaseline(malformed, { requireFile: 'slim-strip.baseline.test.ts' });
      expect(result.code).toBe(3);
      expect(result.out).toBe('');
      expect(result.err).toMatch(/Vitest counters must be non-negative safe integers/u);
    }
  });

  it('exits 3 for every failed suite with no assertions, regardless of error wording', () => {
    for (const message of [
      'ReferenceError: fixture helper failed during module initialization',
      'Failed to resolve import "../lib/mailbox-fixture.test-support.js"',
    ]) {
      const result = classifyBaseline(
        vitestReport([
          ...instrument,
          { name: 'board.test.ts', status: 'failed', message, assertionResults: [] },
        ]),
        { requireFile: 'slim-strip.baseline.test.ts' },
      );
      expect(result.code).toBe(3);
      expect(result.err).toMatch(/failed suite\(s\) have no assertions/u);
      expect(result.err).toContain('board.test.ts');
    }
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

  it('does not claim companion-suite assertions as feature absence when an instrument is named', () => {
    const result = classifyBaseline(
      vitestReport([
        ...instrument,
        { name: 'board.test.ts', status: 'failed', message: '', assertionResults: [
          assertion('unrelated wake timestamp', 'failed', ['AssertionError: impossible calendar date was shown as a wake age']),
        ] },
      ]),
      { requireFile: 'slim-strip.baseline.test.ts' },
    );
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/1 feature-absence assertion failure\(s\)/u);
    expect(result.out).toMatch(/1 companion-suite assertion failure\(s\) excluded from the claim/u);
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

  it('rejects a setup AssertionError that names no required feature-absence cause (native r4 warning 1)', () => {
    const setupOnly = classifyBaseline(
      vitestReport([{ name: 'slim-strip.baseline.test.ts', status: 'failed', message: '', assertionResults: [
        // The instrument's own mount guard: a real AssertionError, but not a SLIM absence.
        assertion('the rail mounts (setup proof)', 'failed', ['AssertionError: board sections rendered (setup proof): expected 0 to be greater than 0']),
      ] }]),
      { requireFile: 'slim-strip.baseline.test.ts', requireFileSubstrs: ['slim strip labelled status pairs', 'reserved numeric slot for strip KPIs', 'reveal-only compact disclosure'] },
    );
    expect(setupOnly.code).toBe(3);
    expect(setupOnly.err).toMatch(/name no required feature-absence cause/u);
    const named = classifyBaseline(
      vitestReport([{ name: 'slim-strip.baseline.test.ts', status: 'failed', message: '', assertionResults: [
        assertion('rail carries the strip pairs', 'failed', ['AssertionError: slim strip labelled status pairs: expected null to be truthy']),
      ] }]),
      { requireFile: 'slim-strip.baseline.test.ts', requireFileSubstrs: ['slim strip labelled status pairs', 'reserved numeric slot for strip KPIs', 'reveal-only compact disclosure'] },
    );
    expect(named.code).toBe(1);
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

  it('checks every unexpected project in one spec instead of accepting its first feature failure', () => {
    const report = {
      errors: [],
      stats: { expected: 0, unexpected: 2, skipped: 0, flaky: 0 },
      suites: [{ specs: [{
        title: 'strip is visible',
        file: 'dashboard-strip.spec.ts',
        ok: false,
        tests: [
          { projectName: 'chromium', title: 'strip is visible', status: 'unexpected', results: [
            { status: 'failed', error: { message: "locator('.strip-status') expected 1" } },
          ] },
          { projectName: 'webkit', title: 'strip is visible', status: 'unexpected', results: [
            { status: 'failed', error: { message: 'ReferenceError: fixture helper failed' } },
          ] },
        ],
      }] }],
    };
    const result = classifyBaseline(report, { playwright: true, substrs });
    expect(result.code).toBe(3);
    expect(result.err).toMatch(/name NO slim surface/u);
    expect(result.err).toContain('ReferenceError: fixture helper failed');
  });

  it('rejects a Playwright report without its errors array', () => {
    const { errors, ...reportWithoutErrors } = playwrightReport([
      { title: 'strip is visible', message: "locator('.strip-status') expected 1" },
    ]);
    expect(errors).toEqual([]);
    const result = classifyBaseline(reportWithoutErrors, { playwright: true, substrs });
    expect(result.code).toBe(3);
    expect(result.out).toBe('');
    expect(result.err).toMatch(/errors field.*array/u);
  });

  it('rejects non-empty Playwright global errors even beside matching feature-absence failures', () => {
    const report = playwrightReport([
      { title: 'strip is visible', message: "locator('.strip-status') expected 1" },
    ]);
    const withGlobalError = { ...report, errors: [{ message: 'webServer failed to start' }] };
    const result = classifyBaseline(withGlobalError, { playwright: true, substrs });
    expect(result.code).toBe(3);
    expect(result.out).toBe('');
    expect(result.err).toMatch(/reported 1 global error/u);
  });

  it('rejects malformed Playwright stats before accepting a matching feature-absence failure', () => {
    const report = playwrightReport([
      { title: 'strip is visible', message: "locator('.strip-status') expected 1" },
    ]);
    const malformed = { ...report, stats: { ...report.stats, expected: '2' } };
    const result = classifyBaseline(malformed, { playwright: true, substrs });
    expect(result.code).toBe(3);
    expect(result.out).toBe('');
    expect(result.err).toMatch(/stats\.expected.*non-negative safe integer/u);
  });

  it('rejects well-typed Playwright stats that disagree with report-tree test statuses', () => {
    const report = playwrightReport([
      { title: 'strip is visible', message: "locator('.strip-status') expected 1" },
    ]);
    const inconsistent = { ...report, stats: { ...report.stats, expected: 1 } };
    const result = classifyBaseline(inconsistent, { playwright: true, substrs });
    expect(result.code).toBe(3);
    expect(result.err).toMatch(/stats and test tree disagree/u);
    expect(result.err).toContain('expected=1');
    expect(result.err).toContain('expected=0');
  });

  it('treats a failed spec without an unexpected test record as setup failure', () => {
    const report = {
      ...playwrightStatusReport(['expected']),
      suites: [{ specs: [{
        title: 'strip baseline fixture',
        file: 'dashboard-strip.spec.ts',
        ok: false,
        tests: [{ status: 'expected', results: [] }],
      }] }],
    };
    const result = classifyBaseline(report, { playwright: true, substrs });
    expect(result.code).toBe(3);
    expect(result.out).toBe('');
    expect(result.err).toMatch(/failed Playwright spec.*no unexpected test record/u);
    expect(result.err).toContain('strip baseline fixture');
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

  it('does not infer feature absence from a test title when its failure is setup/runtime', () => {
    const result = classifyBaseline(
      playwrightReport([
        { title: 'strip-groups should render', message: 'browser setup/runtime failure before feature assertions' },
      ]),
      { playwright: true, substrs },
    );
    expect(result.code).toBe(3);
    expect(result.err).toMatch(/browser setup\/runtime failure before feature assertions/u);
  });

  it('reads a timedOut/unexpected result message instead of mapping it to an empty string', () => {
    const report = {
      errors: [],
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

  it('exits 3 for an empty substring allowlist and for a skipped-only run', () => {
    const emptyAllow = classifyBaseline(playwrightReport([{ title: 'x', message: 'anything' }]), { playwright: true, substrs: [] });
    expect(emptyAllow.code).toBe(3);
    expect(emptyAllow.err).toMatch(/no slim-surface substrings/u);
    const skippedOnly = classifyBaseline(playwrightStatusReport(Array<'skipped'>(7).fill('skipped')), { playwright: true, substrs: ['strip-groups'] });
    expect(skippedOnly.code).toBe(3);
    expect(skippedOnly.err).toMatch(/no Playwright test actually ran/u);
  });

  it('treats a SKIPPED instrument test as non-evidence (3), a passing one as a broken claim (2)', () => {
    const skipped = classifyBaseline(
      vitestReport([{ name: 'slim-strip.baseline.test.ts', status: 'failed', message: '', assertionResults: [
        assertion('a', 'failed', ['AssertionError: absent']),
        assertion('b', 'skipped', []),
      ] }]),
      { requireFile: 'slim-strip.baseline.test.ts' },
    );
    expect(skipped.code).toBe(3);
    expect(skipped.err).toMatch(/SKIPPED/u);
    const passed = classifyBaseline(
      vitestReport([{ name: 'slim-strip.baseline.test.ts', status: 'failed', message: '', assertionResults: [
        assertion('a', 'failed', ['AssertionError: absent']),
        assertion('b', 'passed'),
      ] }]),
      { requireFile: 'slim-strip.baseline.test.ts' },
    );
    expect(passed.code).toBe(2);
  });

  it('exits 3 when none match, and 2 when nothing failed', () => {
    const none = classifyBaseline(playwrightReport([{ title: 'x', message: 'some unrelated failure' }]), { playwright: true, substrs });
    expect(none.code).toBe(3);
    const green = classifyBaseline(playwrightStatusReport(Array<'expected'>(5).fill('expected')), { playwright: true, substrs });
    expect(green.code).toBe(2);
    const zero = classifyBaseline({ errors: [], stats: { expected: 0, unexpected: 0, skipped: 0, flaky: 0 }, suites: [] }, { playwright: true, substrs });
    expect(zero.code).toBe(3);
  });
});
