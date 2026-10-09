#!/usr/bin/env node
/**
 * Feature-specific fail-before classifier for the managed repository
 * overview baseline (native round-1 verification-debt repair).
 *
 * The pre-change base legitimately fails for OTHER reasons too (later-main
 * tests merged into the same files at the old base). A generic "any named
 * failed test" check would therefore self-confirm from unrelated failures
 * while the approved Option A checks could silently stop failing. This
 * classifier instead requires the NAMED Option A absence assertions to fail
 * as behavioral assertions on their own legs, and reports every other
 * failure as excluded context — never as part of the feature claim.
 *
 * Unrelated failures are reported, not accepted: the feature proof is
 * exactly the named absence checks below.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const EXPECTED_ABSENCE_ASSERTIONS = Object.freeze({
  backend: Object.freeze([
    'board engine — managed repository overview wiring carries the late-bound repository overview view additively and defaults to null when unwired',
    'board engine — managed repository overview wiring the main assembly binds, starts and stops the managed repository overview tracker (assembly alarm)',
    'board server — HTTP API GET /api/board: 401 without token, 401 with a bad token, snapshot with a valid one',
    'board server — HTTP API GET /api/board carries the additive repoOverview projection when wired',
  ]),
  web: Object.freeze([
    'board server-frame validator managed repo overview: absent/null tolerated, well-formed accepted, malformed rejected',
    'managed repository overview in the crew rail renders the read-only overview below the crew list without disturbing the crew',
    'managed repository overview in the crew rail renders the explicit empty-registry note when the registry is empty',
    'managed repository overview in the crew rail replaces the previous overview on a live push instead of stacking rows',
  ]),
});

/** Verify one leg: parseable report, no collection/setup failures, and every
 * required Option A absence assertion failed AS an assertion. Returns the
 * proof line (including the excluded unrelated-failure count). */
export function assertRepoOverviewBaselineLeg(label, report, requiredTitles) {
  if (report === null || typeof report !== 'object' || report.numFailedTests < 1 || !Array.isArray(report.testResults)) {
    throw new Error(`${label}: no failed tests in a parseable Vitest report; import/setup failure is not behavioral RED`);
  }
  for (const file of report.testResults) {
    if (file?.status === 'failed' &&
      ((typeof file.message === 'string' && file.message.trim() !== '') ||
        !Array.isArray(file.assertionResults) || file.assertionResults.length === 0)) {
      throw new Error(`${label}: collection/setup/import failure in ${String(file.name ?? 'test file')} — not behavioral RED`);
    }
  }
  const results = report.testResults.flatMap((file) => file.assertionResults ?? []);
  const nameOf = (result) =>
    typeof result.fullName === 'string' && result.fullName !== '' ? result.fullName : result.title;
  const missing = [];
  for (const title of requiredTitles) {
    const assertion = results.find((result) => nameOf(result) === title && result.status === 'failed');
    if (assertion === undefined) {
      missing.push(title);
      continue;
    }
    if (!Array.isArray(assertion.failureMessages) || assertion.failureMessages.length === 0 ||
      assertion.failureMessages.some((message) => typeof message !== 'string' || !message.startsWith('AssertionError:'))) {
      missing.push(`${title} (did not fail as an AssertionError)`);
    }
  }
  if (missing.length > 0) {
    throw new Error(`${label}: Option A absence not proven — missing failed assertions:\n  - ${missing.join('\n  - ')}`);
  }
  const required = new Set(requiredTitles);
  const excluded = results.filter(
    (result) => result.status === 'failed' && !required.has(nameOf(result)),
  ).length;
  return `${label}: Option A absence proven — ${requiredTitles.length} named assertion(s) RED; ${excluded} unrelated failure(s) excluded from the claim`;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [backendPath, webPath] = process.argv.slice(2);
    if (!backendPath || !webPath) {
      throw new Error('usage: assert-repo-overview-baseline.mjs BACKEND_JSON WEB_JSON');
    }
    for (const [label, path] of [['backend', backendPath], ['web', webPath]]) {
      const report = JSON.parse(readFileSync(path, 'utf8'));
      process.stdout.write(`${assertRepoOverviewBaselineLeg(label, report, EXPECTED_ABSENCE_ASSERTIONS[label])}\n`);
    }
  } catch (error) {
    process.stderr.write(`FAILS-BEFORE CLAIM BROKEN: ${String(error)}\n`);
    process.exitCode = 2;
  }
}
