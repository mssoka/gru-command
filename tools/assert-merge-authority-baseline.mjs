#!/usr/bin/env node
/**
 * Fail-before classifier for the merge-authority boundary baseline (job
 * merge-authority-boundary-20261010; journal j-1671/j-1667).
 *
 * The pre-change base (dffa10af) carries the contradictory merge wording:
 * "the owner holds every merge" blanket text beside a worker instruction
 * to merge main into its branch, plus an ops-skill chief-merge exception
 * and a rebase-default conflict path. The FINAL behavioral test bytes are
 * overlaid onto an isolated snapshot of that base; the boundary assertions
 * must RED there BY ASSERTION. A nonzero exit from import, collection or
 * setup is not fail-before evidence, and a named assertion that passes at
 * the base breaks the claim. Unlisted failures (e.g. a later-main test that
 * legitimately cannot pass at the old base) are reported as excluded
 * context, never as part of the claim.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** Every named assertion the pre-change base must fail by AssertionError.
 *  Each one discriminates at least one side of the boundary: permitted
 *  worker branch integration, forbidden agent final-PR merging, the
 *  removed chief-merge exception, or the removed rebase-default path. */
export const EXPECTED_BASELINE_ASSERTIONS = Object.freeze([
  'merge authority boundary (owner ruling 2026-10-10) Gru: branch integration is worker execution; the owner holds every final PR merge',
  'merge authority boundary (owner ruling 2026-10-10) Silas: integration is coordinated mechanical work; final PR merges stay owner-only in every repository',
  'merge authority boundary (owner ruling 2026-10-10) the minion: same-branch integration needs no owner checkpoint; the final PR merge is not theirs',
  'merge authority boundary (owner ruling 2026-10-10) the shipped ops skill drops the chief-merge exception and the rebase-default conflict path',
  'role definitions (E8) pins the minion owning main-conflict resolution in its own worktree',
  'gru role definition the persona carries the CEO-interface + plan-before-heist standing orders',
  'gru role definition the chief hands workers the whole build and presents merges only on exact-final-head Perkins READY',
  'silas skills and wake prompt assembles shipped skills with the worker/owner merge boundary and the exact clean-abort rule',
  'github signal poll tick one tick applies the merged and conflict mappings against a real ledger, with one cursor event per change',
]);

function nameOf(result) {
  return typeof result.fullName === 'string' && result.fullName !== '' ? result.fullName : result.title;
}

/**
 * Classify a Vitest JSON report from the merge-authority baseline. Returns
 * the proof line when every named boundary assertion failed as an
 * assertion and no file failed by collection/setup/import; throws (never a
 * silent pass) otherwise.
 */
export function assertMergeAuthorityBaseline(report) {
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
      `merge-authority boundary absence not proven — missing failed assertions:\n  - ${missing.join('\n  - ')}`,
    );
  }
  const excluded = failed.filter((result) => !required.has(nameOf(result))).length;
  return `merge-authority boundary proven — ${EXPECTED_BASELINE_ASSERTIONS.length} named assertion(s) RED by assertion against the pre-change base; ${excluded} unrelated failure(s) excluded from the claim`;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [path] = process.argv.slice(2);
    if (!path) throw new Error('usage: assert-merge-authority-baseline.mjs REPORT_JSON');
    const proof = assertMergeAuthorityBaseline(JSON.parse(readFileSync(path, 'utf8')));
    process.stdout.write(`EXPECTED RED: ${proof}\n`);
  } catch (error) {
    process.stderr.write(
      `FAILS-BEFORE CLAIM BROKEN: ${String(error instanceof Error ? error.message : error)}\n`,
    );
    process.exitCode = 2;
  }
}
