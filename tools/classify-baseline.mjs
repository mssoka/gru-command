// Baseline RED classifier — R3-05 resolution (job dashboard-slim-strip-current-main-20261007).
//
// Classifies a baseline report (the recorded execution base overlaid with
// the named fail-before specs) and maps it to an exit code:
//   1  — BASELINE RED CLASSIFIED: setup/collection clean, and the failures
//        are identified feature-absence AssertionErrors (per-test cause).
//   2  — FAILS-BEFORE CLAIM BROKEN: the baseline passed unexpectedly, or
//        the named instrument file did not fail.
//   3  — BASELINE SETUP/COLLECTION FAILURE: unreadable report, zero tests
//        collected, module load errors, unidentified failure causes. This
//        is NEVER behavioral evidence and must never be read as a
//        feature-absence RED.
//
// The producer's own exit code is never swallowed or rewritten: the scope
// runs the producer first, keeps its real exit, then classifies.
//
// The classification itself is a pure exported function (unit-tested in
// test/classify-baseline.test.ts, the same discipline as
// tools/assert-binned-baseline.mjs); the CLI below owns file and process
// I/O only.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

// Node-process output only (the repo lint config defines no globals):
// findings go to stderr, the classification line to stdout.
const fail = (message) => process.stderr.write(`${message}\n`);
const say = (message) => process.stdout.write(`${message}\n`);

const LOAD_ERROR = /Cannot find module|does not provide an export|Failed to load url|SyntaxError/i;

/**
 * Classify an already-parsed report value. Pure: no process I/O, no exits.
 *
 * @param {unknown} report
 * @param {{ playwright?: boolean, requireFile?: string | null, substrs?: readonly string[] }} [options]
 * @returns {{ code: number, out: string, err: string }}
 */
export function classifyBaseline(report, { playwright = false, requireFile = null, substrs = [] } = {}) {
  return playwright ? classifyPlaywright(report, substrs) : classifyVitest(report, requireFile);
}

function classifyPlaywright(report, substrs) {
  if (substrs.length === 0) {
    // An empty allowlist would identify every failure: the per-test cause
    // check must never be vacuous.
    return { code: 3, out: '', err: 'BASELINE SETUP FAILURE: no slim-surface substrings supplied — cause cannot be identified' };
  }
  if (Array.isArray(report?.errors) && report.errors.length > 0) {
    // A config/webServer/global failure explains the run, not the feature.
    return { code: 3, out: '', err: `BASELINE SETUP FAILURE: Playwright reported ${report.errors.length} global error(s) — not behavioral evidence` };
  }
  const stats = (report && report.stats) || {};
  if (typeof stats !== 'object' || Array.isArray(stats)) {
    return { code: 3, out: '', err: 'BASELINE SETUP FAILURE: Playwright report has no stats object — not behavioral evidence' };
  }
  // Playwright's JSON stats carry expected/unexpected/skipped/flaky — there
  // is no `total` field; the run's size is their sum.
  const total = (stats.expected ?? 0) + (stats.unexpected ?? 0) + (stats.skipped ?? 0) + (stats.flaky ?? 0);
  const unexpected = stats.unexpected ?? 0;
  if (total === 0) {
    return {
      code: 3,
      out: '',
      err: 'BASELINE SETUP/COLLECTION FAILURE: zero Playwright tests ran (build/webServer/spec load?) — not behavioral evidence',
    };
  }
  const results = [];
  const walk = (suite) => {
    for (const spec of Array.isArray(suite?.specs) ? suite.specs : []) {
      if (spec.ok === false || (spec.tests ?? []).some((t) => t.status === 'unexpected')) {
        const bad = (Array.isArray(spec.tests) ? spec.tests : [])
          .flatMap((t) => (Array.isArray(t?.results) ? t.results : []))
          // Playwright result statuses: passed/failed/timedOut/interrupted/
          // skipped. A test-level timeout carries the locator in its message,
          // so it must be read, not silently mapped to an empty string.
          .find((r) => r.status === 'failed' || r.status === 'timedOut' || r.status === 'interrupted' || r.status === 'unexpected');
        const message =
          (bad?.error?.message ?? '') + '\n' + String(bad?.errors?.map((e) => e.message).join('\n') ?? '');
        results.push({ title: spec.title ?? spec.file ?? 'unknown', message });
      }
    }
    for (const child of Array.isArray(suite?.suites) ? suite.suites : []) walk(child);
  };
  for (const suite of Array.isArray(report?.suites) ? report.suites : []) walk(suite);
  if (unexpected === 0) {
    const ran = (stats.expected ?? 0) + (stats.flaky ?? 0);
    if (ran === 0) {
      return { code: 3, out: '', err: 'BASELINE SETUP FAILURE: no Playwright test actually ran (all skipped?) — not behavioral evidence' };
    }
    return { code: 2, out: '', err: `FAILS-BEFORE CLAIM BROKEN: baseline passed unexpectedly (${ran} ran, 0 unexpected)` };
  }
  // Per-test cause: EVERY unexpected failure must name a missing slim
  // surface; an unclassified failure is never folded into the RED.
  const identified = [];
  const unidentified = [];
  for (const r of results) {
    if (substrs.some((s) => `${r.title}\n${r.message}`.includes(s))) identified.push(r);
    else unidentified.push(r);
  }
  if (identified.length === 0) {
    const lines = results
      .slice(0, 5)
      .map((r) => `  ${r.title}: ${r.message.slice(0, 140).replace(/\n/g, ' ')}`)
      .join('\n');
    return {
      code: 3,
      out: '',
      err: `BASELINE SETUP FAILURE: ${results.length} unexpected result(s), none matching the slim-surface substrings (${substrs.join(', ')}) — not identified feature absence\n${lines}`,
    };
  }
  if (unidentified.length > 0) {
    const lines = unidentified
      .slice(0, 5)
      .map((r) => `  UNIDENTIFIED ${r.title}: ${r.message.slice(0, 140).replace(/\n/g, ' ')}`)
      .join('\n');
    return {
      code: 3,
      out: '',
      err: `BASELINE SETUP FAILURE: ${unidentified.length} of ${results.length} unexpected failure(s) name NO slim surface — unclassified causes are not behavioral feature-absence evidence\n${lines}`,
    };
  }
  return {
    code: 1,
    out: `BASELINE RED CLASSIFIED: setup clean (Playwright ran ${total} test(s)); ${unexpected} unexpected; every one of the ${identified.length} failure(s) names a missing slim surface (${substrs.join(', ')}) — per-test cause established`,
    err: '',
  };
}

function classifyVitest(report, requireFile) {
  if (report === null || typeof report !== 'object') {
    return { code: 3, out: '', err: 'BASELINE SETUP FAILURE: report unreadable or not an object — not behavioral evidence' };
  }
  const suites = Array.isArray(report.testResults) ? report.testResults : [];
  const total = report.numTotalTests ?? 0;
  const passed = report.numPassedTests ?? 0;
  const failed = report.numFailedTests ?? 0;
  if (total === 0) {
    return { code: 3, out: '', err: 'BASELINE SETUP/COLLECTION FAILURE: zero tests collected — not behavioral evidence' };
  }
  const loadErrors = [];
  for (const suite of suites) {
    const message = String(suite.message ?? '');
    if (suite.status === 'failed' && LOAD_ERROR.test(message) && (suite.assertionResults ?? []).length === 0) {
      loadErrors.push(suite.name ?? 'unknown suite');
    }
  }
  if (loadErrors.length > 0) {
    return {
      code: 3,
      out: '',
      err: `BASELINE SETUP/COLLECTION FAILURE: module load errors in ${loadErrors.length} suite(s) — not behavioral evidence\n${loadErrors.map((n) => `  load error: ${n}`).join('\n')}`,
    };
  }
  if (failed === 0) {
    return { code: 2, out: '', err: `FAILS-BEFORE CLAIM BROKEN: baseline passed unexpectedly (${passed}/${total} passed)` };
  }
  // Per-test cause accounting across the whole overlay: assertion failures
  // are behavioral; any other failure mode is counted separately and is
  // never claimed as feature-absence evidence.
  let assertions = 0;
  let otherFailures = 0;
  for (const suite of suites) {
    for (const a of suite.assertionResults ?? []) {
      if (a.status !== 'failed') continue;
      if ((a.failureMessages ?? []).some((m) => /AssertionError/.test(m))) assertions += 1;
      else otherFailures += 1;
    }
  }
  if (requireFile !== null) {
    const instrument = suites.find((suite) => String(suite.name).includes(requireFile));
    if (instrument === undefined) {
      return { code: 3, out: '', err: `BASELINE SETUP FAILURE: instrument file not in report: ${requireFile}` };
    }
    const instrumentAssertions = instrument.assertionResults ?? [];
    if (instrumentAssertions.length === 0) {
      // The suite is in the report but registered no tests: a collection
      // fault, never a claim that the baseline passed.
      return { code: 3, out: '', err: `BASELINE SETUP/COLLECTION FAILURE: instrument ${requireFile} registered no tests — not behavioral evidence` };
    }
    const instrumentSkipped = instrumentAssertions.filter((a) => a.status === 'skipped');
    if (instrumentSkipped.length > 0) {
      return { code: 3, out: '', err: `BASELINE SETUP FAILURE: ${instrumentSkipped.length} instrument test(s) were SKIPPED — non-evidence, not a broken or held claim` };
    }
    if (instrumentAssertions.some((a) => a.status === 'passed')) {
      return { code: 2, out: '', err: 'FAILS-BEFORE CLAIM BROKEN: the instrument file has passing tests on the base' };
    }
    if (!instrumentAssertions.every((a) => a.status === 'failed')) {
      return { code: 3, out: '', err: 'BASELINE SETUP FAILURE: the instrument file has tests in a non-evidence state' };
    }
    const nonAssertion = instrumentAssertions.filter(
      (a) => !(a.failureMessages ?? []).some((m) => /AssertionError/.test(m)),
    );
    if (nonAssertion.length > 0) {
      const lines = nonAssertion
        .map((a) => `  ${a.title}: ${(a.failureMessages ?? [''])[0].slice(0, 160)}`)
        .join('\n');
      return {
        code: 3,
        out: '',
        err: `BASELINE SETUP FAILURE: ${nonAssertion.length} instrument failure(s) are not AssertionErrors — not behavioral evidence\n${lines}`,
      };
    }
  }
  if (assertions === 0) {
    // No named instrument and not one assertion failure: whatever failed is
    // unclassified (runtime/setup), never behavioral RED.
    return {
      code: 3,
      out: '',
      err: `BASELINE SETUP FAILURE: ${failed} failure(s) but none is an AssertionError and no --require-file instrument identifies the cause — not behavioral evidence`,
    };
  }
  return {
    code: 1,
    out:
      `BASELINE RED CLASSIFIED: setup clean (report parsed, ${total} tests collected, no load errors); ` +
      `${assertions} feature-absence assertion failure(s), ${passed} base-behavior pass(es)` +
      (otherFailures > 0
        ? `; ${otherFailures} non-assertion failure(s) reported but NOT claimed as behavioral assertions`
        : '') +
      (requireFile ? `; instrument ${requireFile}: every test failed by AssertionError` : ''),
    err: '',
  };
}

// --- CLI -------------------------------------------------------------------

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {

  const args = process.argv.slice(2);
  const knownFlags = new Set(['--require-file', '--require-substr', '--playwright']);
  const unknown = args
    .filter((a) => a.startsWith('--'))
    .find((a) => !knownFlags.has(a));
  if (unknown !== undefined) {
    fail(`BASELINE SETUP FAILURE: unknown flag ${unknown} — refusing to classify a typo'd invocation`);
    process.exit(3);
  }
  const reportPath = args[0];
  const requireFileIdx = args.indexOf('--require-file');
  const requireFile = requireFileIdx >= 0 ? args[requireFileIdx + 1] : null;
  const playwright = args.includes('--playwright');
  const substrIdx = args.indexOf('--require-substr');
  const substrs = substrIdx >= 0 ? String(args[substrIdx + 1] ?? '').split(',').filter(Boolean) : [];

  let report = null;
  try {
    report = JSON.parse(readFileSync(reportPath, 'utf-8'));
  } catch (error) {
    fail(`BASELINE SETUP FAILURE: report unreadable (${String(error)}) — not behavioral evidence`);
    process.exit(3);
  }

  const { code, out, err } = classifyBaseline(report, { playwright, requireFile, substrs });
  if (err !== '') fail(err);
  if (out !== '') say(out);
  process.exit(code);
}
