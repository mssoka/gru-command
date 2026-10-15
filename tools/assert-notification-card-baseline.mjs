#!/usr/bin/env node
/**
 * Fail-before classifier for the notification readability baseline (owner
 * release 2026-10-11).
 *
 * The pre-change base (f738b9b1) renders the entire diagnostic prose
 * inside the faint uppercase `.lbl` metadata line, exposes no Details
 * disclosure and no typed decision controls, and labels every owner row
 * with a generic Ack. `web/src/ui/notification-card.test.ts` is written
 * against only base-present modules, so the FINAL behavioral test bytes
 * are overlaid onto an isolated base snapshot and must RED there BY
 * ASSERTION. A nonzero exit from import, collection or setup is not
 * fail-before evidence, and a named assertion that passes at the base
 * breaks the claim. Unlisted failures are excluded context, never part of
 * the claim.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** Every named test the pre-change base must fail by AssertionError. */
export const EXPECTED_BASELINE_ASSERTIONS = Object.freeze([
  'readable notification card — fixed long-content contract keeps the long mixed-case prose out of the label line and preserves it verbatim behind Details',
  'readable notification card — fixed long-content contract renders typed owner decision options with consequences and no generic Ack',
  'readable notification card — fixed long-content contract an owner notice explains the manual step instead of inventing a control',
]);

function nameOf(result) {
  return typeof result.fullName === 'string' && result.fullName !== '' ? result.fullName : result.title;
}

/** Classify a Vitest JSON report from the notification-card baseline.
 * Returns the proof line when every named assertion failed as an
 * assertion and no file failed by collection/setup/import; throws (never a
 * silent pass) otherwise. */
export function assertNotificationCardBaseline(report) {
  if (
    report === null ||
    typeof report !== 'object' ||
    typeof report.numFailedTests !== 'number' ||
    !Array.isArray(report.testResults)
  ) {
    throw new Error('no parseable Vitest report; import/collection/setup failure is not behavioral RED');
  }
  for (const file of report.testResults) {
    if (
      file?.status === 'failed' &&
      ((typeof file.message === 'string' && file.message.trim() !== '') ||
        !Array.isArray(file.assertionResults) ||
        file.assertionResults.length === 0)
    ) {
      throw new Error(
        `collection/setup/import failure in ${String(file.name ?? 'test file')} — not behavioral RED`,
      );
    }
  }
  const results = report.testResults.flatMap((file) => file.assertionResults ?? []);
  const failed = results.filter((result) => result?.status === 'failed');
  if (failed.length !== report.numFailedTests) {
    throw new Error(
      `report counts ${String(report.numFailedTests)} failed test(s) but lists ${String(failed.length)} — unreadable report`,
    );
  }
  const required = new Set(EXPECTED_BASELINE_ASSERTIONS);
  const missing = [];
  for (const title of EXPECTED_BASELINE_ASSERTIONS) {
    const assertion = results.find((result) => nameOf(result) === title && result.status === 'failed');
    if (assertion === undefined) {
      const collected = results.some((result) => nameOf(result) === title);
      missing.push(collected ? `${title} (collected but GREEN at the base)` : `${title} (not collected)`);
      continue;
    }
    const messages = Array.isArray(assertion.failureMessages) ? assertion.failureMessages : [];
    if (messages.length === 0 || messages.some((message) => typeof message !== 'string' || !message.startsWith('AssertionError:'))) {
      missing.push(`${title} (did not fail as an AssertionError)`);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `notification-card readability absence not proven — missing failed assertions:\n  - ${missing.join('\n  - ')}`,
    );
  }
  const excluded = failed.filter((result) => !required.has(nameOf(result))).length;
  return `notification-card readability proven — ${EXPECTED_BASELINE_ASSERTIONS.length} named assertion(s) RED by assertion against the pre-change base; ${excluded} unrelated failure(s) excluded from the claim`;
}

/** True only when this module IS the CLI entry point (canonical paths). */
function invokedDirectly() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    const [path] = process.argv.slice(2);
    if (!path) throw new Error('usage: assert-notification-card-baseline.mjs REPORT_JSON');
    const proof = assertNotificationCardBaseline(JSON.parse(readFileSync(path, 'utf8')));
    process.stdout.write(`EXPECTED RED: ${proof}\n`);
  } catch (error) {
    process.stderr.write(
      `FAILS-BEFORE CLAIM BROKEN: ${String(error instanceof Error ? error.message : error)}\n`,
    );
    process.exitCode = 2;
  }
}
