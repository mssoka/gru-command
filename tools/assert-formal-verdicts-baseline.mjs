#!/usr/bin/env node
/**
 * Fail-before classifier for the formal GitHub verdicts baseline (job
 * perkins-github-formal-verdicts-20261010; owner ruling j-1615).
 *
 * The pre-change base d0e6389 is a COMMENT-only publisher: it sends
 * `event: "COMMENT"`, enforces `COMMENTED`, records no wanted formal event,
 * and cannot refuse a wrong-state receipt. Every named formal-event
 * regression below must therefore fail BEHAVIORALLY — for a formal-event
 * reason, not because the overlay could not be imported or collected.
 *
 * The strict formal-event classifier requires each pinned test's unique
 * FORMAL_EVENT_ASSERTION marker, emitted only around its intended contract
 * assertion. A generic assertion elsewhere in that test is not proof. The
 * separate named-red classifier retains the historical shared behavior for
 * R2-R6 baselines. Import/collection/setup signatures are rejected by both.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const EXPECTED_FORMAL_EVENT_ASSERTIONS = Object.freeze({
  app: Object.freeze([
    'formal GitHub verdict publication delivers a formal APPROVE bound to the frozen head and proves the APPROVED state (formal GitHub)',
    'formal GitHub verdict publication delivers a formal REQUEST_CHANGES bound to the frozen head and proves the CHANGES_REQUESTED state (formal GitHub)',
    'formal GitHub verdict publication never credits a COMMENTED review beside an approval intent and never re-posts (formal GitHub)',
    'formal GitHub verdict publication reconciles an approval against provider proof of the APPROVED state only (formal GitHub)',
    'formal GitHub verdict publication keeps the GitLab note contract and refuses a formal intent a note cannot enact (formal GitHub)',
  ]),
  wave: Object.freeze([
    'GitHub SHA-bound Perkins delivery never certifies absence when the frozen head carries a body-identical review in the wrong state (formal GitHub)',
    'formal GitHub verdict publication from native judgments publishes a real approval, a real change request, keeps a final-pass-debt READY a comment, and clears the change request with a later eligible READY (formal GitHub)',
    'formal GitHub verdict publication from native judgments refuses a publisher receipt that did not enact the intended formal state, and never retries it (formal GitHub)',
    'WaveRunner delivery receipts, reconciliation, prior selection, and disclosure refuses a GitHub receipt with no commit binding at the host boundary (formal GitHub)',
  ]),
});

/** Unique tags emitted only when the contract assertion in each pinned test
 * fails. A different assertion in the same test cannot prove fail-before. */
export const EXPECTED_FORMAL_EVENT_FAILURE_MARKERS = Object.freeze({
  app: Object.freeze([
    'FORMAL_EVENT_ASSERTION:app-approve-receipt',
    'FORMAL_EVENT_ASSERTION:app-request-changes-receipt',
    'FORMAL_EVENT_ASSERTION:app-wrong-state-refusal',
    'FORMAL_EVENT_ASSERTION:app-approval-reconciliation',
    'FORMAL_EVENT_ASSERTION:app-gitlab-formal-intent-refusal',
  ]),
  wave: Object.freeze([
    'FORMAL_EVENT_ASSERTION:wave-wrong-state-reconciliation',
    'FORMAL_EVENT_ASSERTION:wave-native-event-lifecycle',
    'FORMAL_EVENT_ASSERTION:wave-host-wrong-state-refusal',
    'FORMAL_EVENT_ASSERTION:wave-github-commit-binding',
  ]),
});

/** Import/collection/setup signatures an overlay failure must never carry. */
export const NON_BEHAVIORAL_FAILURE_SIGNATURES = Object.freeze([
  /Cannot find module/u,
  /Cannot find package/u,
  /does not provide an export named/u,
  /Failed to load url/u,
  /\bSyntaxError\b/u,
  /\bReferenceError: .* is not defined/u,
  /No test suite found/u,
  /ERR_MODULE_NOT_FOUND/u,
]);

/** Behavioral markers for the legacy shared named-red classifier. Formal
 * verdict baselines additionally require their per-test assertion marker. */
export const BEHAVIORAL_FAILURE_MARKERS = Object.freeze([
  /AssertionError/u,
  /_Assertion/u,
  /instead of rejecting|instead of resolving/u,
  /state mismatch|enacted (?:APPROVED|CHANGES_REQUESTED|COMMENTED) instead of/u,
  /FORMAL_EVENT_ASSERTION:/u,
]);

/** Verify one leg: parseable report, no collection/setup failures, and every
 * required formal-event assertion failed behaviorally. Returns the proof
 * line; throws with the observed failed titles when the claim is broken. */
export function assertNamedRedBaselineLeg(label, report, requiredTitles) {
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
      assertion.failureMessages.some((message) => typeof message !== 'string')) {
      missing.push(`${title} (no usable failure message)`);
      continue;
    }
    const message = assertion.failureMessages.join('\n');
    if (NON_BEHAVIORAL_FAILURE_SIGNATURES.some((pattern) => pattern.test(message))) {
      missing.push(`${title} (failed for an import/setup reason, not behaviorally)`);
      continue;
    }
    if (!BEHAVIORAL_FAILURE_MARKERS.some((pattern) => pattern.test(message))) {
      missing.push(`${title} (failure carries no formal-event behavioral marker)`);
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
  return `${label}: formal-event absence proven — ${requiredTitles.length} named assertion(s) RED behaviorally; ${excluded} unrelated failure(s) excluded from the claim`;
}

/** Strict classifier for the formal-event baseline only: every pinned test
 * must fail through its designated contract assertion, not merely any
 * assertion somewhere in the same test body. */
export function assertFormalVerdictsBaselineLeg(label, report, requiredTitles) {
  const expectedTitles = EXPECTED_FORMAL_EVENT_ASSERTIONS[label];
  const expectedMarkers = EXPECTED_FORMAL_EVENT_FAILURE_MARKERS[label];
  if (expectedTitles === undefined || expectedMarkers === undefined ||
    requiredTitles.length !== expectedTitles.length || requiredTitles.some((title, index) => title !== expectedTitles[index])) {
    throw new Error(`${label}: formal-event baseline does not match its pinned assertion titles`);
  }
  const proof = assertNamedRedBaselineLeg(label, report, requiredTitles);
  const results = report.testResults.flatMap((file) => file.assertionResults ?? []);
  for (const [index, title] of requiredTitles.entries()) {
    const assertion = results.find((result) =>
      (typeof result.fullName === 'string' && result.fullName !== '' ? result.fullName : result.title) === title &&
      result.status === 'failed');
    const marker = expectedMarkers[index];
    if (assertion === undefined || marker === undefined || !Array.isArray(assertion.failureMessages) ||
      !assertion.failureMessages.some((message) => typeof message === 'string' && message.includes(marker))) {
      throw new Error(`${label}: ${title} failed without its intended formal-event assertion marker ${marker ?? '(missing marker)'}`);
    }
  }
  return proof;
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
