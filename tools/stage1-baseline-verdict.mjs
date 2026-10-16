#!/usr/bin/env node
/**
 * Verdict for the `perkins-stage1-baseline` scope (GH-175). Reads the Vitest
 * JSON report of the pre-change baseline run and classifies it, so an
 * expected assertion RED, a broken run and a missing selection never share
 * one exit code.
 *
 * usage: node stage1-baseline-verdict.mjs <report.json> <title-fragment>...
 *
 * Exit codes:
 *   0  EXPECTED RED: every fragment selected at least one executed test and
 *      at least one executed test failed an assertion — and every failed
 *      test failed one (#360 R4-V3: a `beforeAll` setup error Vitest stamps
 *      onto each test of its suite is no assertion RED).
 *   5  the baseline run produced no usable report (collection/infra failure),
 *      failed without any failing test, or failed a test some other way
 *      than a behavioral assertion (setup, hook, import or helper failure).
 *   6  the selection is incomplete: a fragment matched no executed test (a
 *      vacuous baseline), or nothing ran.
 */
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { behavioralRefusal } from './assert-perkins-integration-review-baseline.mjs';

const out = (message) => process.stdout.write(`${message}\n`);
const err = (message) => process.stderr.write(`${message}\n`);

const [reportPath, ...fragments] = process.argv.slice(2);
if (reportPath === undefined || fragments.length === 0) {
  err('usage: stage1-baseline-verdict.mjs <report.json> <title-fragment>...');
  process.exit(5);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, 'utf8'));
} catch (error) {
  err(`BASELINE RUN BROKEN (exit 5): no readable Vitest JSON report at ${reportPath}: ${error.message}`);
  process.exit(5);
}

const executed = (report.testResults ?? [])
  .flatMap((file) => file.assertionResults ?? [])
  .filter((test) => test.status === 'passed' || test.status === 'failed');
const failed = executed.filter((test) => test.status === 'failed');

const missing = fragments.filter((fragment) => !executed.some((test) => test.fullName.includes(fragment)));
if (executed.length === 0 || missing.length > 0) {
  err(
    `BASELINE SELECTION INCOMPLETE (exit 6): executed=${executed.length}; ` +
      `no executed test matched: ${missing.length > 0 ? missing.join(' | ') : '(nothing ran)'}`,
  );
  process.exit(6);
}
// Every failed test must have failed a behavioral assertion: its first
// failure message is a matcher failure or a rejects/resolves report raised in
// a test file. One that failed any other way makes the run no fail-before
// evidence at all.
const notAssertions = failed.flatMap((test) => {
  const reason = behavioralRefusal((test.failureMessages ?? [])[0]);
  return reason === null ? [] : [`${test.fullName}: ${reason}`];
});
if (notAssertions.length > 0) {
  err(
    `BASELINE RUN BROKEN (exit 5): ${notAssertions.length} failed test${notAssertions.length === 1 ? '' : 's'} failed some other way than an assertion ` +
      `(setup, hook, import or helper failure); not accepted as fail-before evidence`,
  );
  for (const line of notAssertions) err(`  NOT RED: ${line}`);
  process.exit(5);
}
if (failed.length === 0) {
  err(
    `BASELINE RUN BROKEN (exit 5): vitest failed but no selected test failed an assertion ` +
      `(failed suites=${report.numFailedTestSuites ?? 'unknown'}); not accepted as fail-before evidence`,
  );
  process.exit(5);
}
out(`EXPECTED RED: ${failed.length} of ${executed.length} selected tests failed an assertion`);
for (const test of failed) out(`  RED: ${test.fullName}`);
