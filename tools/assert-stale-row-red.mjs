#!/usr/bin/env node
/**
 * Fail-before classifier for the gc-lane-fence stale registry-row baseline.
 *
 * The pre-change base (ccd6337f) has no liveness predicate in the lane-process
 * fence, so the A1 regression must fail there BY ASSERTION: retirement is
 * refused (409) where the test expects 200. A nonzero vitest exit from an
 * import, collection, setup or fixture failure is not fail-before evidence,
 * and a green A1 case breaks the claim. This tool exits 0 only when the named
 * case was collected, failed as an AssertionError, and its message carries the
 * expected 409-vs-200 assertion; it exits 2 otherwise.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const EXPECTED_TEST_TITLE =
  'retires past a live registry row whose spawned pid is gone and leaves that row live';
export const EXPECTED_ASSERTION = 'expected 409 to be 200';

function nameOf(result) {
  return typeof result.fullName === 'string' && result.fullName !== '' ? result.fullName : result.title;
}

/** Classify a Vitest JSON report from the stale-row baseline. Returns the
 * proof line when the named A1 case failed as the expected assertion; throws
 * (never a silent pass) otherwise. */
export function assertStaleRowRed(report) {
  if (report === null || typeof report !== 'object' || typeof report.numFailedTests !== 'number' || !Array.isArray(report.testResults)) {
    throw new Error('no parseable Vitest report; import/collection/setup failure is not behavioral RED');
  }
  for (const file of report.testResults) {
    if (file?.status === 'failed' &&
      ((typeof file.message === 'string' && file.message.trim() !== '') ||
        !Array.isArray(file.assertionResults) || file.assertionResults.length === 0)) {
      throw new Error(`collection/setup/import failure in ${String(file.name ?? 'test file')} — not behavioral RED`);
    }
  }
  const results = report.testResults.flatMap((file) => file.assertionResults ?? []);
  const assertion = results.find((result) => nameOf(result) === EXPECTED_TEST_TITLE);
  if (assertion === undefined) {
    throw new Error(`the A1 case "${EXPECTED_TEST_TITLE}" was not collected at the pre-change base`);
  }
  if (assertion.status !== 'failed') {
    throw new Error(`the A1 case was ${String(assertion.status)} at the pre-change base; fail-before claim broken`);
  }
  const messages = Array.isArray(assertion.failureMessages) ? assertion.failureMessages : [];
  if (messages.length === 0 || messages.some((message) => typeof message !== 'string' || !message.startsWith('AssertionError:')) ||
    !messages.some((message) => message.includes(EXPECTED_ASSERTION))) {
    throw new Error(`the A1 case failed without the expected "${EXPECTED_ASSERTION}" AssertionError — not behavioral RED`);
  }
  return `stale-row red proven — "${EXPECTED_TEST_TITLE}" failed by assertion at the pre-change base (${EXPECTED_ASSERTION})`;
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const path = process.argv[2];
    if (path === undefined) throw new Error('usage: assert-stale-row-red.mjs RESULTS_JSON');
    const report = JSON.parse(readFileSync(path, 'utf-8'));
    process.stdout.write(`${assertStaleRowRed(report)}\n`);
  } catch (error) {
    process.stderr.write(`FAILS-BEFORE CLAIM BROKEN: ${String(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 2;
  }
}
