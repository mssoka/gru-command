#!/usr/bin/env node
/**
 * #527 fail-before record (gc-527-red).
 *
 * Extracts base 64d645c2 into a scratch tree, overlays ONLY the candidate's
 * final `test/board-engine.test.ts`, and runs the one named A1 case. On base
 * the engine reads `github.branch-state` only, so a ready GitLab merge
 * request projects no row and the case dies on `toHaveLength(1)` — a
 * behavioral assertion on what the owner would see, never an import or
 * collection failure. The shared classifier refuses anything else.
 *
 * Exit codes (all distinct on purpose):
 *   1  the A1 case failed at the base commit (the expected, RED outcome)
 *   2  a claim is broken: the case passed, or failed for a non-behavioral reason
 *   3  the runner itself failed
 *
 * usage: node gru-output/gc-527/red.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BASE = '64d645c2';
const TEST = 'test/board-engine.test.ts';
const A1 = 'A1: ships one provider-tagged ownerPrs row for an exact-head ready GitLab merge request';
/** The classifier matches a test's FULL name, so the literal carries the
 * describe prefix of the final board-engine.test.ts. */
const A1_FULL = 'board engine — FOR YOU owner-PR projection on the snapshot A1: ships one provider-tagged ownerPrs row for an exact-head ready GitLab merge request';

const scratch = mkdtempSync(join(tmpdir(), 'gc-527-red-'));
try {
  execFileSync('sh', ['-c', `git -C '${ROOT}' archive ${BASE} | tar -x -C '${scratch}'`], { stdio: 'inherit' });
  copyFileSync(join(ROOT, TEST), join(scratch, TEST));
  symlinkSync(join(ROOT, 'node_modules'), join(scratch, 'node_modules'), 'dir');
  const results = join(scratch, 'results.json');
  const run = spawnSync(
    join(ROOT, 'node_modules', '.bin', 'vitest'),
    ['run', TEST, '-t', A1, '--reporter=json', `--outputFile=${results}`],
    { cwd: scratch, encoding: 'utf-8' },
  );
  if (run.status === null) throw new Error(`vitest did not run: ${String(run.error)}`);
  const classified = spawnSync(
    process.execPath,
    [join(ROOT, 'tools', 'assert-named-red-baseline.mjs'), 'gc-527-red', results, A1_FULL],
    { encoding: 'utf-8' },
  );
  if (classified.status === 0) {
    process.stdout.write(classified.stdout);
    process.exitCode = 1;
  } else {
    process.stderr.write(classified.stderr);
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`runner failed: ${String(error)}\n`);
  process.exitCode = 3;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
