#!/usr/bin/env node
// Red evidence for the blind coverage release control (#513).
//
// Extracts the committed HEAD into a scratch directory (node_modules linked),
// removes the release check from `blindCoverageOf` (ONE string edit: a released
// report is treated as still qualifying), and runs test A1 only: the corrected
// same-target commission must then be refused `409 blind_coverage_owned`. The
// working tree is never touched.
//
//   node gru-output/gc-513-blind-coverage-release/red.mjs            run A1 under the mutation
//   node gru-output/gc-513-blind-coverage-release/red.mjs --check    verify the edit anchors once at HEAD
//   node gru-output/gc-513-blind-coverage-release/red.mjs --all      run the whole new file under the mutation (informational)
//
// Exit codes: 1 = the expected red (A1, and only A1, failed with
// `blind_coverage_owned`); 0 = the unmutated baseline and --check passed;
// 2 = anything else (the edit did not apply, A1 survived, another test failed,
// the run crashed). Run through the `gc-513-red` verify scope.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const print = (text) => process.stdout.write(`${text}\n`);

const root = process.cwd();
const TEST_FILE = 'test/blind-coverage-release.test.ts';
const EDIT = {
  file: 'src/dispatch/blind-review.ts',
  find: 'qualifying: derived.qualifying && released === null,',
  replace: 'qualifying: derived.qualifying,',
};
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

function anchorCount() {
  const text = execFileSync('git', ['show', `${head}:${EDIT.file}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return text.split(EDIT.find).length - 1;
}

if (process.argv.includes('--check')) {
  const count = anchorCount();
  print(`edit anchor in ${EDIT.file} at ${head}: ${count} match${count === 1 ? '' : 'es'}`);
  process.exit(count === 1 ? 0 : 2);
}

/** Run the new test file in the scratch tree; `only` is a vitest -t pattern. */
function run(dir, only) {
  const out = join(dir, '.red-report.json');
  const args = ['node_modules/vitest/vitest.mjs', 'run', '--reporter=json', '--outputFile', out, TEST_FILE, ...(only === null ? [] : ['-t', only])];
  const result = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', timeout: 600_000, env: { ...process.env, CI: '1' } });
  let report;
  try { report = JSON.parse(readFileSync(out, 'utf8')); } catch { return { crashed: true, stderr: (result.stderr ?? '').slice(-800), tests: [] }; }
  const tests = report.testResults.flatMap((file) => file.assertionResults);
  return { crashed: false, tests };
}

const dir = mkdtempSync(join(tmpdir(), 'gru-513-red.'));

/** The whole record in one function, so the scratch tree is removed on every exit. */
function record() {
  execFileSync('sh', ['-c', `git archive ${head} | tar -x -C "${dir}"`], { cwd: root });
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  execFileSync(process.execPath, ['tools/patch-vitest-rpc-timeout.mjs'], { cwd: dir, stdio: 'ignore' });
  print(`red evidence at ${head}`);

  const all = process.argv.includes('--all');
  const only = all ? null : 'A1:';

  const baseline = run(dir, only);
  const baselineFailed = baseline.tests.filter((test) => test.status === 'failed');
  print(`baseline (unmutated): ${baseline.tests.filter((test) => test.status === 'passed').length} passed, ${baselineFailed.length} failed${baseline.crashed ? ' (crashed)' : ''}`);
  if (baseline.crashed || baselineFailed.length > 0 || baseline.tests.length === 0) {
    print(`BASELINE FAILED: ${baselineFailed.map((test) => test.fullName).join('; ')} ${baseline.stderr ?? ''}`);
    return 2;
  }

  const path = join(dir, EDIT.file);
  const text = readFileSync(path, 'utf8');
  const count = text.split(EDIT.find).length - 1;
  if (count !== 1) {
    print(`the edit does not match exactly once in ${EDIT.file} (${count}); nothing was mutated`);
    return 2;
  }
  writeFileSync(path, text.replace(EDIT.find, () => EDIT.replace));
  print(`mutation: ${EDIT.file}: "${EDIT.find}" -> "${EDIT.replace}"`);

  const mutated = run(dir, only);
  if (mutated.crashed) { print(`mutated run crashed: ${mutated.stderr}`); return 2; }
  const failed = mutated.tests.filter((test) => test.status === 'failed');
  for (const test of mutated.tests.filter((candidate) => candidate.status !== 'skipped' && candidate.status !== 'pending')) print(`  ${test.status} ${test.fullName}`);
  for (const test of failed) print(`failure of "${test.fullName}":\n${test.failureMessages.join('\n').split('\n').slice(0, 6).join('\n')}`);
  const a1 = mutated.tests.find((test) => test.fullName.includes(' A1: '));
  const a1Red = a1 !== undefined && a1.status === 'failed' && a1.failureMessages.join('\n').includes('blind_coverage_owned');
  const others = failed.filter((test) => test !== a1);
  if (a1Red && (all || others.length === 0)) {
    print(`RED as expected: A1 fails with 409 blind_coverage_owned when the release check is removed${all ? ` (${others.length} further test(s) also fail: ${others.map((test) => test.title).join('; ')})` : ' (A1 only)'}`);
    return 1;
  }
  print(`UNEXPECTED: A1 ${a1 === undefined ? 'did not run' : a1.status}${a1Red ? '' : ' without blind_coverage_owned'}; other failures: ${others.map((test) => test.title).join('; ') || 'none'}`);
  return 2;
}

let exitCode = 2;
try {
  exitCode = record();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
