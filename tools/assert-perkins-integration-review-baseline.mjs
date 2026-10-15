#!/usr/bin/env node
/** Baseline classifier for the R4/R7 repairs of job
 * perkins-integration-review-coverage-20261009.
 *
 * The fail-before evidence is discriminating only when the NAMED regression
 * fails by ASSERTION against the named uncorrected lineage: a nonzero exit
 * from import, collection, setup or an unrelated test is NOT RED. Five legs:
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
 *   r9    — the redaction-erasure fix at b930417: the uncorrected decoder
 *           credits a body whose heading/scope evidence was erased by a real
 *           publication redaction span as legacy whole clearance, so the
 *           refusal and owner-readiness assertions fail.
 *   r10   — the reversed-ordering fix at 0a20101: the uncorrected decoder
 *           credits a historical raw deferred title that survives AFTER the
 *           redaction span with a forged line-anchored heading/scope line
 *           (the placeholder precedes the selected region), so the refusal
 *           and owner-readiness assertions fail.
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
  r9: [
    'redaction-erased disclosure cannot grant historical whole clearance',
  ],
  r10: [
    'a historical deferred-title heading after the redaction span cannot grant whole clearance',
  ],
};

const ASSERTION_HEAD = /^AssertionError: /u;
const PROMISE_REPORT_HEAD = /^(?:AssertionError|Error): promise (?:resolved|rejected) .* instead of (?:rejecting|resolving)$/u;
/** A V8 stack frame line: `at <fn> (<location>)` whose parenthesised part
 * ends in `:line:col` or is a V8 token (`<anonymous>`, `index N`, `native`),
 * a bare `at <absolute path or file:// URL>:line:col`, or `at <anonymous>`.
 * Indented prose in an assertion message — `at least 3 (see docs)`,
 * `at 12:30:15` — is not a frame. */
const STACK_LINE = /^\s+at (?:\S.* \((?:.*:\d+:\d+|<anonymous>|index \d+|native)\)|(?:file:\/\/|[A-Za-z]:[\\/]|[\\/]).*:\d+:\d+|<anonymous>)$/u;
const LOCATION = /^(file:\/\/)?(.+):\d+:\d+$/u;
/** A location: a file:// URL is decoded (so an encoded `test%2Fhelpers`
 * segment is judged as the path it names); a plain path is kept as is. */
function located(match) {
  if (match === null) return undefined;
  if (match[1] === undefined) return match[2];
  try { return decodeURIComponent(match[2]); } catch { return match[2]; }
}
/** The source location a frame names, or undefined (`<anonymous>`, `index 0`,
 * `native`). Paths may contain spaces, parentheses and colons: a framed
 * location is the remainder after the FIRST " (" that yields one, so
 * `fn (/repo/a (copy)/x.ts:1:2)` and `/repo/a (copy).test.ts:1:2` both
 * resolve to their full path. An `eval` frame names the location of the
 * code that called eval. */
export function frameLocation(line) {
  const body = line.replace(/^\s+at /u, '');
  const evalOrigin = /\beval at .*? \(((?:file:\/\/)?[^()]+?:\d+:\d+)\)/u.exec(body);
  if (evalOrigin !== null) return located(LOCATION.exec(evalOrigin[1]));
  if (body.endsWith(')')) {
    for (let index = body.indexOf(' ('); index !== -1; index = body.indexOf(' (', index + 1)) {
      const location = located(LOCATION.exec(body.slice(index + 2, -1)));
      if (location !== undefined) return location;
    }
  }
  return located(LOCATION.exec(body));
}
/** Runtime and assertion-machinery frames sit between a matcher and its
 * caller; they never decide who raised the assertion. */
const MACHINERY_FRAME = /^node:|\/node_modules\/(?:@vitest\/|vitest\/|chai\/|tinyspy\/|@jest\/expect)/u;

/** A behavioral RED: the failure's OWN first line is a Vitest matcher
 * failure or a rejects/resolves report — never a timeout, import,
 * collection or setup error that merely embeds that text (#394). When the
 * message carries a stack, its first non-machinery frame must be a test
 * file: an assertion inside a shared helper module (test/helpers/…) or a
 * dependency is setup, not the named regression's claim, and a stack nothing
 * in which can be located is refused. */
export function isBehavioralAssertion(message) {
  if (typeof message !== 'string') return false;
  const [head = '', ...rest] = message.split(/\r?\n/u);
  if (!ASSERTION_HEAD.test(head) && !PROMISE_REPORT_HEAD.test(head)) return false;
  const stack = rest.filter((line) => STACK_LINE.test(line));
  // A report without any stack frames is judged by its head alone.
  if (stack.length === 0) return true;
  // The first frame outside the runtime and assertion machinery decides. A
  // stack whose frames are all unlocatable or all machinery is refused —
  // never an open door for a helper-raised assertion (#394).
  const file = stack
    .map((line) => frameLocation(line)?.replaceAll('\\', '/'))
    .find((location) => location !== undefined && !MACHINERY_FRAME.test(location));
  if (file === undefined) return false;
  return /\.test\.[cm]?[jt]s$/u.test(file) && !file.includes('/node_modules/') && !file.includes('/test/helpers/');
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
      throw new Error('usage: assert-perkins-integration-review-baseline.mjs <fast|heavy|r7|r8|r9|r10> REPORT_JSON');
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
