#!/usr/bin/env node
/** Baseline classifier for the R4/R7 repairs of job
 * perkins-integration-review-coverage-20261009.
 *
 * The fail-before evidence is discriminating only when the NAMED regression
 * fails by ASSERTION against the named uncorrected lineage: a nonzero exit
 * from import, collection, setup or an unrelated test is NOT RED. Four legs:
 *
 *   fast  — the consumed-byte mutation refusal at e9772af: the pre-fix base
 *           accepts the replaced record, so `rejects` reports "promise
 *           resolved ... instead of rejecting".
 *   heavy — both verdict-to-annotation crash windows plus the production
 *           pin pass-through at e9772af: the pre-fix base skips the
 *           annotation-less predecessor and consumes the mutated record, so
 *           the covered-head equality and refusal assertions fail.
 *   r7    — the historical-fallback authentication at fd8f2a6: the
 *           uncorrected reader credits the stripped delta record as debt-free
 *           whole, so the restored-debt assertion fails.
 *   r8    — the R8 decoder fixes at 43d5349: the uncorrected decoder's
 *           non-structural heading search credits a body whose dynamic
 *           field embeds the heading as legacy/debt-free, and its
 *           present-convergence branch skips the unusable-disclosure
 *           refusal, so the debt and refusal assertions fail.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** The exact `it()` titles each leg must RED. */
export const BASELINE_TITLES = {
  fast: [
    'refuses a predecessor record mutated between the authenticated scope plan and engine consumption',
  ],
  heavy: [
    'keeps a verdict-committed round as predecessor when the normal annotation write is interrupted',
    'keeps a verdict-committed round as predecessor when the promotion annotation write is interrupted',
    'refuses a WaveRunner predecessor mutated between the authenticated plan and engine consumption',
  ],
  r7: [
    'authenticates the historical fallback before treating absent convergence as whole clearance',
  ],
  r8: [
    'keeps review debt when dynamic appendix fields embed the host heading after the scope lines',
    'refuses an unusable publication disclosure even with present mutable convergence',
  ],
};

/** A behavioral RED: a Vitest matcher failure or a rejects/resolves report —
 * never a timeout, import, collection or setup error text. */
export function isBehavioralAssertion(message) {
  return message.includes('AssertionError:') ||
    message.includes('instead of rejecting') ||
    message.includes('instead of resolving');
}

/**
 * Classify one Vitest JSON report from the pre-fix baseline. Returns the
 * expected titles when EVERY named regression failed with a behavioral
 * assertion and nothing else failed; throws (never a silent pass) on a
 * missing/named-green test, an unlisted failure, or a collection/setup/
 * import failure.
 */
export function assertPerkinsIntegrationBaseline(leg, report) {
  const expected = BASELINE_TITLES[leg];
  if (expected === undefined) throw new Error(`unknown baseline leg "${String(leg)}"`);
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
  const failedTitles = failed.map((result) => String(result?.title));
  for (const title of expected) {
    if (!failedTitles.includes(title)) {
      const result = assertions.find((entry) => entry?.title === title);
      throw new Error(
        result === undefined
          ? `the named regression was not collected: ${title}`
          : `the named regression did not fail (status ${String(result.status)}): ${title}`,
      );
    }
  }
  const unlisted = failedTitles.filter((title) => !expected.includes(title));
  if (unlisted.length > 0) {
    throw new Error(`unlisted failure(s) outside the named claim: ${unlisted.join(', ')}`);
  }
  for (const title of expected) {
    const result = assertions.find((entry) => entry?.title === title);
    const messages = Array.isArray(result?.failureMessages) ? result.failureMessages : [];
    if (messages.length !== 1) {
      throw new Error(
        `"${title}" carries ${String(messages.length)} failure message(s); exactly one assertion failure is before-proof evidence`,
      );
    }
    const message = messages[0];
    if (typeof message !== 'string' || !isBehavioralAssertion(message)) {
      throw new Error(`"${title}" failed before its assertion; setup/import failure is not RED evidence`);
    }
  }
  return expected;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [leg, path] = process.argv.slice(2);
    if (leg === undefined || path === undefined) {
      throw new Error('usage: assert-perkins-integration-review-baseline.mjs <fast|heavy|r7|r8> REPORT_JSON');
    }
    const titles = assertPerkinsIntegrationBaseline(leg, JSON.parse(readFileSync(path, 'utf8')));
    process.stdout.write(
      `EXPECTED RED (${leg}): ${String(titles.length)} named regression(s) failed by assertion against the pre-fix base\n`,
    );
  } catch (error) {
    process.stderr.write(
      `FAILS-BEFORE CLAIM BROKEN: ${String(error instanceof Error ? error.message : error)}\n`,
    );
    process.exitCode = 2;
  }
}
