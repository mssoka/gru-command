#!/usr/bin/env node
/** A fail-before receipt needs a failing behavioral assertion on BOTH legs.
 * Nonzero exits from import, collection, or setup are not evidence. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const EXPECTED_BASELINE_ASSERTIONS = Object.freeze({
  backend: 'binned is legal from EVERY non-terminal status',
  web: 'hides binned rows behind an explicit disclosure',
});

export function assertBinnedBaselineLeg(label, report, expectedTitle) {
  if (report === null || typeof report !== 'object' || report.numFailedTests < 1 || !Array.isArray(report.testResults)) {
    throw new Error(`${label}: no failed tests in a parseable Vitest report; import/setup failure is not behavioral RED`);
  }
  const assertion = report.testResults.flatMap((file) => file.assertionResults ?? [])
    .find((result) => result.title?.includes(expectedTitle) && result.status === 'failed');
  if (!assertion || !Array.isArray(assertion.failureMessages) || assertion.failureMessages.length === 0) {
    throw new Error(`${label}: expected behavioral assertion "${expectedTitle}" did not fail; import/setup failure is not RED evidence`);
  }
  return `${label}: assertion RED — ${assertion.title}`;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [backendPath, webPath] = process.argv.slice(2);
    if (!backendPath || !webPath) throw new Error('usage: assert-binned-baseline.mjs BACKEND_JSON WEB_JSON');
    for (const [label, path] of [['backend', backendPath], ['web', webPath]]) {
      const report = JSON.parse(readFileSync(path, 'utf8'));
      process.stdout.write(`${assertBinnedBaselineLeg(label, report, EXPECTED_BASELINE_ASSERTIONS[label])}\n`);
    }
  } catch (error) {
    process.stderr.write(`FAILS-BEFORE CLAIM BROKEN: ${String(error)}\n`);
    process.exitCode = 2;
  }
}
