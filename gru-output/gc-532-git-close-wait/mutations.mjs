#!/usr/bin/env node
// Mutation record for the committed-ref close wait (#532).
//
// For each mutation this extracts the committed HEAD into a scratch directory
// (node_modules linked), changes ONE bound in `updateDirectCreationRef`, runs
// the tests that cover it and requires every named test to fail. The unmutated
// baseline must pass first. Nothing in the working tree is touched.
//
//   node gru-output/gc-532-git-close-wait/mutations.mjs [--check]
//
// `--check` only verifies that every edit matches its file exactly once at
// HEAD (review-round edits make anchors rot). Exit 0 only when the baseline
// passes and every mutation is killed. Run through the `gc-532-mutants`
// verify scope.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const print = (text) => process.stdout.write(`${text}\n`);
const root = process.cwd();
const MANAGER = 'src/worktrees/manager.ts';
const BOUND = 'const closeBoundMs = committed ? this.opts.committedRefCloseMs ?? 30_000 : stopTimeoutMs;';

const CUSTODY = { file: 'test/creation-continuation-custody.test.ts', name: 'custody suite' };
const GIT_ENV = { file: 'test/review-git-environment.test.ts', name: 'Git environment suite' };
const SLOW = 'creates the job when a committed Git child closes after the old one-second bound';
const NAMED = 'names the committed close bound it used';
const PRE_COMMIT = 'keeps the one-second close wait of a failure before commit';
const DEFAULT_BOUND = 'waits 30 s by default for a committed close';

/** id, what is changed, the edits, and per suite the tests that must fail. */
const MUTATIONS = [
  { id: 'M1', what: 'a failure before commit waits the committed bound', edits: [{ file: MANAGER, find: BOUND, replace: 'const closeBoundMs = this.opts.committedRefCloseMs ?? 30_000;' }],
    runs: [{ suite: GIT_ENV, fails: [PRE_COMMIT] }] },
  { id: 'M2', what: 'the SIGTERM wait uses the committed bound', edits: [{ file: MANAGER, find: 'if (!await waitForStop(stopTimeoutMs) && !exited', replace: 'if (!await waitForStop(closeBoundMs) && !exited' }],
    runs: [{ suite: GIT_ENV, fails: [DEFAULT_BOUND] }] },
  { id: 'M3', what: 'the SIGKILL wait uses the committed bound',
    edits: [{ file: MANAGER, find: "catch (error) { fail(transactionError(String(error))); }\n          await waitForStop(stopTimeoutMs);", replace: "catch (error) { fail(transactionError(String(error))); }\n          await waitForStop(closeBoundMs);" }],
    runs: [{ suite: GIT_ENV, fails: [DEFAULT_BOUND] }] },
  { id: 'M4', what: 'the default committed bound is 2 s', edits: [{ file: MANAGER, find: BOUND, replace: BOUND.replace('30_000', '2_000') }],
    runs: [{ suite: GIT_ENV, fails: [DEFAULT_BOUND] }] },
  { id: 'M5', what: 'the option is ignored: a committed child waits one second', edits: [{ file: MANAGER, find: BOUND, replace: 'const closeBoundMs = stopTimeoutMs;' }],
    runs: [{ suite: CUSTODY, fails: [SLOW, NAMED] }, { suite: GIT_ENV, fails: [DEFAULT_BOUND] }] },
  { id: 'M6', what: 'the failure message hard-codes 1000ms', edits: [{ file: MANAGER, find: 'did not close within ${closeBoundMs}ms`', replace: 'did not close within 1000ms`' }],
    runs: [{ suite: CUSTODY, fails: [NAMED] }, { suite: GIT_ENV, fails: [DEFAULT_BOUND] }] },
];

/** Run the (#532) tests of one suite in the scratch tree. */
function runSuite(dir, suite) {
  const out = join(dir, `.mutation-${Math.random().toString(36).slice(2)}.json`);
  const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.heavy.config.ts', '--reporter=json', '--outputFile', out, suite.file, '-t', '#532'];
  const result = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', timeout: 900_000, env: { ...process.env, CI: '1' } });
  let report;
  try { report = JSON.parse(readFileSync(out, 'utf8')); } catch { return { failed: [], passed: 0, crashed: true, stderr: (result.stderr ?? '').slice(-600) }; }
  const all = report.testResults.flatMap((file) => file.assertionResults);
  return { failed: all.filter((test) => test.status === 'failed').map((test) => test.fullName), passed: all.filter((test) => test.status === 'passed').length, crashed: false };
}

const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();

if (process.argv.includes('--check')) {
  let stale = 0;
  for (const mutation of MUTATIONS) {
    for (const edit of mutation.edits) {
      const text = execFileSync('git', ['show', `${head}:${edit.file}`], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      const count = text.split(edit.find).length - 1;
      if (count !== 1) { stale += 1; print(`${mutation.id}: ${edit.file} matches ${count} times`); }
    }
  }
  print(`${MUTATIONS.length} mutations checked at ${head}: ${stale === 0 ? 'every edit matches exactly once' : `${stale} stale`}`);
  process.exit(stale === 0 ? 0 : 1);
}

const dir = mkdtempSync(join(tmpdir(), 'gru-532-mutations.'));
let exitCode = 0;
const rows = [];
try {
  execFileSync('sh', ['-c', `git archive ${head} | tar -x -C "${dir}"`], { cwd: root });
  symlinkSync(join(root, 'node_modules'), join(dir, 'node_modules'));
  execFileSync(process.execPath, ['tools/patch-vitest-rpc-timeout.mjs'], { cwd: dir, stdio: 'ignore' });
  print(`mutation record at ${head}`);

  for (const suite of [CUSTODY, GIT_ENV]) {
    const baseline = runSuite(dir, suite);
    print(`baseline ${suite.name}: ${baseline.passed} passed, ${baseline.failed.length} failed`);
    if (baseline.crashed || baseline.failed.length > 0 || baseline.passed === 0) { exitCode = 1; print('  BASELINE FAILED', baseline.failed, baseline.stderr ?? ''); }
  }

  for (const mutation of MUTATIONS) {
    const originals = new Map();
    let applied = true;
    for (const edit of mutation.edits) {
      const path = join(dir, edit.file);
      if (!originals.has(path)) originals.set(path, readFileSync(path, 'utf8'));
      const text = readFileSync(path, 'utf8');
      const count = text.split(edit.find).length - 1;
      if (count !== 1) { applied = false; print(`${mutation.id}: edit does not match exactly once in ${edit.file} (${count})`); break; }
      writeFileSync(path, text.replace(edit.find, () => edit.replace));
    }
    const killed = [];
    const missed = [];
    if (applied) {
      for (const run of mutation.runs) {
        const result = runSuite(dir, run.suite);
        for (const fragment of run.fails) {
          (result.failed.some((name) => name.includes(fragment)) ? killed : missed).push(`${run.suite.name}: ${fragment}`);
        }
        if (result.crashed) missed.push(`${run.suite.name}: run crashed ${result.stderr}`);
      }
    }
    for (const [path, text] of originals) writeFileSync(path, text); // restore
    const verdict = !applied ? 'NOT APPLIED' : missed.length === 0 ? 'killed' : 'SURVIVED';
    if (verdict !== 'killed') exitCode = 1;
    rows.push({ ...mutation, killed, missed, verdict });
    print(`${mutation.id}: ${verdict} — ${mutation.what}`);
    for (const line of killed) print(`  failed as required: ${line}`);
    for (const line of missed) print(`  DID NOT FAIL: ${line}`);
  }

  // Restored: the covering tests pass again.
  for (const suite of [CUSTODY, GIT_ENV]) {
    const again = runSuite(dir, suite);
    const ok = !again.crashed && again.failed.length === 0 && again.passed > 0;
    print(`restored ${suite.name}: ${ok ? 'pass' : 'FAIL'}`);
    if (!ok) exitCode = 1;
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

print(`\n${rows.filter((row) => row.verdict === 'killed').length}/${rows.length} mutations killed`);
process.exit(exitCode);
