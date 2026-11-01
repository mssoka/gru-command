#!/usr/bin/env node
// Fail-before classifier for #520's red scopes.
//
// A red run only proves something when the named cases fail BY ASSERTION on
// the older head, never by a collection, setup or import error (an import
// failure would "fail" for a reason that says nothing about behaviour). This
// reads a Vitest JSON report and requires, for the named suite:
//   - every expected case is present and failed;
//   - every failure is an assertion (the message names an AssertionError);
//   - no other case failed, so nothing unrelated is propping the claim up.
// It prints case names and counts only — never failure text, which can quote a
// fixture — and exits non-zero when the red claim does not hold.
//
//   node gru-output/gc-520/red-classify.mjs <results.json> <a1a6|4a269d13>
import { readFileSync } from 'node:fs';
import process from 'node:process';

const EXPECTED = {
  // The original contract's fail-before cases, against the base they were
  // written for.
  a1a6: [
    'A1: a hit prefixed by a 40-hex revision is a read of the excluded repository path',
    'A2: any revision spelling, as a match line or a context line, is stripped from the recorded path',
    'A3: a hit against `<rev>:<dir>` joins its directory and file with a slash',
    'A4: a spaced excluded path behind a revision is judged whole',
    'A5: a worktree context line names its path up to the line number, not a date inside it',
    'A6: a revision-prefixed grep hit from an excluded path invalidates coverage, and resubmitting the same result stays one prohibited read (#520)',
  ],
  // The cases the contract revision names, against the earlier lane's head.
  '4a269d13': [
    'A2: any revision spelling, as a match line or a context line, is stripped from the recorded path',
    'R1: a worktree context line records the path itself, never the text that follows the line number',
    "R1: a clean file's worktree context line that quotes an excluded name is no hit under a non-prefix rule",
    'R1: an extensionless name with date-like segments is read whole, whatever glob excludes it',
    'R1×R2: a dated revision and a quoted path in the text keep the file as the record, never the text',
    'R3: a parent-relative path behind a revision is outside the package, as `path:N:` is',
  ],
};

const [reportPath, suite] = process.argv.slice(2);
const expected = EXPECTED[suite];
if (reportPath === undefined || expected === undefined) {
  process.stdout.write(`usage: red-classify.mjs <results.json> <${Object.keys(EXPECTED).join('|')}>\n`);
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const cases = (report.testResults ?? []).flatMap((file) =>
  (file.assertionResults ?? []).map((entry) => ({
    name: entry.title,
    status: entry.status,
    messages: (entry.failureMessages ?? []).join('\n'),
  })));
const text = (value) => (typeof value === 'string' ? value : '');
const unreadable = (report.testResults ?? []).filter((file) => file.status === 'failed' && (file.assertionResults ?? []).length === 0);

const problems = [];
if (cases.length === 0) problems.push('the report holds no cases at all (a collection or import failure is not red evidence)');
for (const file of unreadable) problems.push(`a test file failed without cases: ${text(file.name).split('/').pop() ?? '?'}`);
for (const name of expected) {
  const found = cases.filter((entry) => entry.name === name);
  if (found.length === 0) problems.push(`missing case: ${name}`);
  else if (found.length > 1) problems.push(`case matched ${found.length} times: ${name}`);
  else if (found[0].status !== 'failed') problems.push(`case did not fail (${found[0].status}): ${name}`);
  else if (!/AssertionError/u.test(found[0].messages)) problems.push(`failure is not an assertion: ${name}`);
}
const failed = cases.filter((entry) => entry.status === 'failed');
const unexpected = failed.filter((entry) => !expected.includes(entry.name));
for (const entry of unexpected) problems.push(`unrelated failure: ${entry.name}`);

const passed = cases.filter((entry) => entry.status === 'passed').length;
const skipped = cases.filter((entry) => entry.status === 'skipped' || entry.status === 'pending').length;
process.stdout.write(`red-classify suite=${suite} cases=${cases.length} failed=${failed.length} passed=${passed} skipped=${skipped} expected=${expected.length}\n`);
if (problems.length > 0) {
  for (const problem of problems) process.stdout.write(`PROBLEM: ${problem}\n`);
  process.stdout.write('FAILED: the fail-before claim does not hold\n');
  process.exit(2);
}
for (const entry of failed) process.stdout.write(`RED by assertion: ${entry.name}\n`);
process.stdout.write('RED PROVEN: every named case failed by assertion\n');
