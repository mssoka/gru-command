#!/usr/bin/env node
/** The native verification-history fail-before receipt is only evidence when
 * the NAMED 208-run host case fails as a BEHAVIORAL assertion against the
 * pre-fix base, for the recorded window reason — a nonzero exit from import,
 * collection or setup is not RED. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** The single discriminating case the baseline overlay must RED. */
export const EXPECTED_BASELINE_TITLE =
  'reviews a job with 208 completed verification runs: the newest binding run freezes without a lifetime-window exception (j-1594)';
/** The recorded reason the pre-fix base refuses the history for. The Vitest
 * JSON top-level message truncates the throw with an ellipsis, so the
 * discriminator is the stable prefix, not the full sentence. */
export const EXPECTED_BASELINE_REASON = 'verification history window exceed';

/** A promise-resolution assertion (the wave case) or a plain assertion. */
function isBehavioralAssertion(message) {
  return message.includes('AssertionError:') || message.includes('instead of resolving');
}

/**
 * Classify a Vitest JSON report from the pre-fix verification-history
 * baseline. Returns the failing title when the ONE named regression failed
 * with the recorded window reason and nothing else failed; throws (never a
 * silent pass) on a missing/named-green test, an unlisted failure, a
 * collection/setup/import failure, or a failure that lost the reason.
 */
export function assertVerificationHistoryBaseline(report) {
  if (
    report === null ||
    typeof report !== 'object' ||
    !Array.isArray(report.testResults) ||
    typeof report.numFailedTests !== 'number'
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
  const assertions = report.testResults.flatMap((file) => file.assertionResults ?? []);
  const failed = assertions.filter((result) => result?.status === 'failed');
  if (failed.length !== report.numFailedTests) {
    throw new Error(
      `report counts ${String(report.numFailedTests)} failed test(s) but lists ${String(failed.length)} — unreadable report`,
    );
  }
  const unlisted = failed.filter((result) => result?.title !== EXPECTED_BASELINE_TITLE);
  if (unlisted.length > 0) {
    throw new Error(
      `unlisted failure(s) outside the named claim: ${unlisted.map((result) => String(result?.title)).join(', ')}`,
    );
  }
  const matches = assertions.filter((result) => result?.title === EXPECTED_BASELINE_TITLE);
  if (matches.length === 0) throw new Error('the named 208-run regression was not collected');
  if (matches.length > 1) throw new Error(`the named regression is ambiguous (${String(matches.length)} matches)`);
  const match = matches[0];
  if (match.status !== 'failed') {
    throw new Error(`the named regression did not fail (status ${String(match.status)})`);
  }
  const messages = Array.isArray(match.failureMessages) ? match.failureMessages : [];
  // Exactly ONE failure message: the expected window assertion. Validating
  // each message individually (never a joined blob) keeps a separate
  // cleanup TypeError or unhandled rejection from hiding behind the claim —
  // a report carrying the window assertion PLUS another error is not a
  // clean before-proof.
  if (messages.length !== 1) {
    throw new Error(
      `the named regression carries ${String(messages.length)} failure message(s); exactly one assertion failure is before-proof evidence`,
    );
  }
  const message = messages[0];
  if (typeof message !== 'string' || !isBehavioralAssertion(message)) {
    throw new Error('the named regression failed before its assertion; setup/import failure is not RED evidence');
  }
  if (!message.includes(EXPECTED_BASELINE_REASON)) {
    throw new Error(
      `the named regression failed without the recorded window reason ("${EXPECTED_BASELINE_REASON}") — not the discriminating failure`,
    );
  }
  return match.title;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [path] = process.argv.slice(2);
    if (!path) throw new Error('usage: assert-verification-history-baseline.mjs REPORT_JSON');
    const title = assertVerificationHistoryBaseline(JSON.parse(readFileSync(path, 'utf8')));
    process.stdout.write(`EXPECTED RED: the named regression failed by assertion against the pre-fix base — ${title}\n`);
  } catch (error) {
    process.stderr.write(
      `FAILS-BEFORE CLAIM BROKEN: ${String(error instanceof Error ? error.message : error)}\n`,
    );
    process.exitCode = 2;
  }
}
