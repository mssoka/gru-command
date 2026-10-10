#!/usr/bin/env node
/**
 * Fail-before classifier for the formal GitHub verdicts baseline (job
 * perkins-github-formal-verdicts-20261010; owner ruling j-1615).
 *
 * The pre-change base d0e6389 is a COMMENT-only publisher: it sends
 * `event: "COMMENT"`, enforces `COMMENTED`, records no wanted formal event,
 * and cannot refuse a wrong-state receipt. Every named formal-event
 * regression below must therefore fail AS A BEHAVIORAL ASSERTION against
 * that base — a leg that passes, a collection/setup/import failure, or a
 * named regression that failed for a non-assertion reason breaks the
 * fails-before claim instead of proving it. The exact named titles are
 * pinned here so the claim cannot drift to unrelated failures; missing
 * titles and every observed failed title are printed on failure.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const EXPECTED_FORMAL_EVENT_ASSERTIONS = Object.freeze({
  app: Object.freeze([
    'formal GitHub verdict publication > delivers a formal APPROVE bound to the frozen head and proves the APPROVED state (formal GitHub)',
    'formal GitHub verdict publication > delivers a formal REQUEST_CHANGES bound to the frozen head and proves the CHANGES_REQUESTED state (formal GitHub)',
    'formal GitHub verdict publication > never credits a COMMENTED review beside an approval intent and never re-posts (formal GitHub)',
    'formal GitHub verdict publication > reconciles an approval against provider proof of the APPROVED state only (formal GitHub)',
    'formal GitHub verdict publication > keeps the GitLab note contract and refuses a formal intent a note cannot enact (formal GitHub)',
  ]),
  wave: Object.freeze([
    'GitHub SHA-bound Perkins delivery > never certifies absence when the frozen head carries a body-identical review in the wrong state (formal GitHub)',
    'formal GitHub verdict publication from native judgments > publishes a real approval, a real change request, keeps a final-pass-debt READY a comment, and clears the change request with a later eligible READY (formal GitHub)',
    'formal GitHub verdict publication from native judgments > refuses a publisher receipt that did not enact the intended formal state, and never retries it (formal GitHub)',
  ]),
});

/** Verify one leg: parseable report, no collection/setup failures, and every
 * required formal-event assertion failed AS an assertion. Returns the proof
 * line; throws with the observed failed titles when the claim is broken. */
export function assertFormalVerdictsBaselineLeg(label, report, requiredTitles) {
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
      missing.push(`${title} (did not fail against the base)`);
      continue;
    }
    if (!Array.isArray(assertion.failureMessages) || assertion.failureMessages.length === 0 ||
      assertion.failureMessages.some((message) => typeof message !== 'string' || !message.startsWith('AssertionError:'))) {
      missing.push(`${title} (did not fail as an AssertionError)`);
    }
  }
  if (missing.length > 0) {
    const observed = results
      .filter((result) => result.status === 'failed')
      .map((result) => `    - ${nameOf(result)}`)
      .join('\n');
    throw new Error(
      `${label}: formal-event absence not proven — missing failed assertions:\n  - ${missing.join('\n  - ')}\n` +
      `  observed failed titles:\n${observed === '' ? '    (none)' : observed}`,
    );
  }
  const required = new Set(requiredTitles);
  const excluded = results.filter(
    (result) => result.status === 'failed' && !required.has(nameOf(result)),
  ).length;
  return `${label}: formal-event absence proven — ${requiredTitles.length} named assertion(s) RED; ${excluded} unrelated failure(s) excluded from the claim`;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [appPath, wavePath] = process.argv.slice(2);
    if (!appPath || !wavePath) {
      throw new Error('usage: assert-formal-verdicts-baseline.mjs APP_JSON WAVE_JSON');
    }
    for (const [label, path] of [['app', appPath], ['wave', wavePath]]) {
      const report = JSON.parse(readFileSync(path, 'utf8'));
      process.stdout.write(`${assertFormalVerdictsBaselineLeg(label, report, EXPECTED_FORMAL_EVENT_ASSERTIONS[label])}\n`);
    }
  } catch (error) {
    process.stderr.write(`FAILS-BEFORE CLAIM BROKEN: ${String(error)}\n`);
    process.exitCode = 2;
  }
}
