// Baseline RED classifier — R3-05 resolution (job dashboard-slim-strip-current-main-20261007).
//
// Usage: node tools/classify-baseline.mjs <report.json> [--require-file <substr>] [--require-failing <n>]
//
// Reads a vitest JSON report produced inside a baseline snapshot (the
// recorded execution base overlaid with the named fail-before specs) and
// CLASSIFIES the outcome. Exit codes:
//   0  — never (a green baseline reaches the caller as exit 2)
//   2  — FAILS-BEFORE CLAIM BROKEN: the baseline suite passed unexpectedly
//   3  — BASELINE SETUP/COLLECTION FAILURE: unparsable report, zero tests
//        collected, or module load errors. This is NEVER behavioral
//        evidence and must never be read as a feature-absence RED.
//   1  — BASELINE RED CLASSIFIED: setup clean (report parsed, tests ran,
//        no load errors), at least one assertion failure, and (with
//        --require-file) every test of the named instrument file failed
//        with AssertionError messages naming the missing feature surfaces.
//
// Playwright shape (--playwright): the report is a Playwright JSON
// (stats + suites). Setup = stats.total > 0 and the run reached test
// execution; RED = at least one unexpected result whose title or error
// message matches a required slim-surface substring (--require-substr
// "a,b,c"), proving the failure is the feature's absence and not a
// navigation/setup break.
//
// The classifier never swallows or rewrites the producer's exit code: the
// caller runs the producer first, keeps its real exit, then classifies.

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const reportPath = args[0];
const requireFileIdx = args.indexOf('--require-file');
const requireFile = requireFileIdx >= 0 ? args[requireFileIdx + 1] : null;
const playwright = args.includes('--playwright');
const substrIdx = args.indexOf('--require-substr');
const substrs = substrIdx >= 0 ? String(args[substrIdx + 1] ?? '').split(',').filter(Boolean) : [];

const LOAD_ERROR = /Cannot find module|does not provide an export|Failed to load url|SyntaxError/i;

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf-8'));
} catch (error) {
  console.error(`BASELINE SETUP FAILURE: report unreadable (${String(error)}) — not behavioral evidence`);
  process.exit(3);
}

if (playwright) {
  const stats = report.stats ?? {};
  const total = stats.total ?? 0;
  const unexpected = stats.unexpected ?? 0;
  if (total === 0) {
    console.error('BASELINE SETUP/COLLECTION FAILURE: zero Playwright tests ran (build/webServer/spec load?) — not behavioral evidence');
    process.exit(3);
  }
  const results = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const bad = (test.results ?? []).find((r) => r.status === 'unexpected');
        if (bad) results.push({ title: spec.title ?? spec.file ?? 'unknown', message: (bad.error?.message ?? '') + '\n' + String(bad.errors?.map((e) => e.message).join('\n') ?? '') });
      }
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  if (unexpected === 0) {
    console.error(`FAILS-BEFORE CLAIM BROKEN: baseline passed unexpectedly (${total} ran, 0 unexpected)`);
    process.exit(2);
  }
  const identified = substrs.length === 0
    ? results
    : results.filter((r) => substrs.some((s) => `${r.title}\n${r.message}`.includes(s)));
  if (identified.length === 0) {
    console.error(`BASELINE SETUP FAILURE: ${results.length} unexpected result(s), none matching the slim-surface substrings (${substrs.join(', ')}) — not identified feature absence`);
    for (const r of results.slice(0, 5)) console.error(`  ${r.title}: ${r.message.slice(0, 140).replace(/\n/g, ' ')}`);
    process.exit(3);
  }
  console.log(
    `BASELINE RED CLASSIFIED: setup clean (Playwright ran ${total} test(s)); ${unexpected} unexpected; ` +
      `${identified.length} failure(s) name the missing slim surfaces (${substrs.join(', ')})`,
  );
  process.exit(1);
}

const suites = Array.isArray(report.testResults) ? report.testResults : [];
const total = report.numTotalTests ?? 0;
const passed = report.numPassedTests ?? 0;
const failed = report.numFailedTests ?? 0;

if (total === 0) {
  console.error('BASELINE SETUP/COLLECTION FAILURE: zero tests collected — not behavioral evidence');
  process.exit(3);
}

const loadErrors = [];
for (const suite of suites) {
  const message = String(suite.message ?? '');
  if (suite.status === 'failed' && LOAD_ERROR.test(message) && (suite.assertionResults ?? []).length === 0) {
    loadErrors.push(suite.name ?? 'unknown suite');
  }
}
if (loadErrors.length > 0) {
  console.error(`BASELINE SETUP/COLLECTION FAILURE: module load errors in ${loadErrors.length} suite(s) — not behavioral evidence`);
  for (const name of loadErrors) console.error(`  load error: ${name}`);
  process.exit(3);
}

if (failed === 0) {
  console.error(`FAILS-BEFORE CLAIM BROKEN: baseline passed unexpectedly (${passed}/${total} passed)`);
  process.exit(2);
}

if (requireFile !== null) {
  const instrument = suites.find((suite) => String(suite.name).includes(requireFile));
  if (instrument === undefined) {
    console.error(`BASELINE SETUP FAILURE: instrument file not in report: ${requireFile}`);
    process.exit(3);
  }
  const assertions = instrument.assertionResults ?? [];
  if (assertions.length === 0 || !assertions.every((a) => a.status === 'failed')) {
    console.error('FAILS-BEFORE CLAIM BROKEN: the instrument file has passing/non-failed tests on the base');
    process.exit(2);
  }
  const nonAssertion = assertions.filter((a) => !(a.failureMessages ?? []).some((m) => /AssertionError/.test(m)));
  if (nonAssertion.length > 0) {
    console.error(`BASELINE SETUP FAILURE: ${nonAssertion.length} instrument failure(s) are not AssertionErrors — not behavioral evidence`);
    for (const a of nonAssertion) console.error(`  ${a.title}: ${(a.failureMessages ?? [''])[0].slice(0, 160)}`);
    process.exit(3);
  }
}

console.log(
  `BASELINE RED CLASSIFIED: setup clean (report parsed, ${total} tests collected, no load errors); ` +
    `${failed} feature-absence assertion failure(s), ${passed} base-behavior pass(es)` +
    (requireFile ? `; instrument ${requireFile}: every test failed by AssertionError` : ''),
);
process.exit(1);
