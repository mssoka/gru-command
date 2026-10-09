#!/usr/bin/env node
/** A keepalive fail-before receipt needs the four NAMED regressions to fail
 * as behavioral assertions against the pre-fix base. A nonzero exit from
 * import, collection, or setup is not evidence. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const EXPECTED_KEEPALIVE_BASELINE_ASSERTIONS = Object.freeze([
  'queued verification keeps response alive during slot wait',
  'quiet running verification keeps response alive',
  'verification terminal and disconnect cleanup',
  'capture remains honest with keepalive',
]);

/**
 * Classify a Vitest JSON report from the pre-fix keepalive baseline. Returns
 * the failing named titles when every expected regression RED by assertion;
 * throws (never a silent pass) on a missing/named-green test, a
 * collection/setup/import failure, or a failure that is not an AssertionError.
 */
export function assertKeepaliveBaseline(report, expected = EXPECTED_KEEPALIVE_BASELINE_ASSERTIONS) {
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
  const red = [];
  for (const title of expected) {
    const match = assertions.find(
      (result) => typeof result?.title === 'string' && result.title.includes(title),
    );
    if (match === undefined) throw new Error(`named regression "${title}" was not collected`);
    if (match.status !== 'failed') {
      throw new Error(`named regression "${title}" did not fail (status ${String(match.status)})`);
    }
    const messages = Array.isArray(match.failureMessages) ? match.failureMessages : [];
    if (
      messages.length === 0 ||
      messages.some((message) => typeof message !== 'string' || !message.startsWith('AssertionError:'))
    ) {
      throw new Error(
        `named regression "${title}" failed before its assertion; setup/import failure is not RED evidence`,
      );
    }
    red.push(match.title);
  }
  return red;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [path] = process.argv.slice(2);
    if (!path) throw new Error('usage: assert-verify-keepalive-baseline.mjs REPORT_JSON');
    const red = assertKeepaliveBaseline(JSON.parse(readFileSync(path, 'utf8')));
    process.stdout.write(
      `EXPECTED RED: ${String(red.length)} named regression(s) failed by assertion against the pre-fix base\n`,
    );
  } catch (error) {
    process.stderr.write(
      `FAILS-BEFORE CLAIM BROKEN: ${String(error instanceof Error ? error.message : error)}\n`,
    );
    process.exitCode = 2;
  }
}
