#!/usr/bin/env node
/**
 * #523 fail-before record for the DEFECT findings (F1, F2, F3, F4, F14).
 *
 * The stranded pass ended at 3f3f2d3382cef11967dcc8806be4f0a4c1a8b42f. This
 * extracts exactly that commit, copies the candidate's tests over it and runs
 * the defect tests by name: each must fail there, by an assertion on what the
 * owner or Gru would observe. A test of a function that does not exist at that
 * commit (F3's unhosted withdrawal, F2's transient classification) fails with
 * "<name> is not a function", which names the missing guard; that is the one
 * extra marker the shared classifier is given. An import or collection
 * failure is never accepted.
 *
 * Exit codes: 1 = every defect test failed at the stranded head (the expected,
 * RED outcome of this scope); 2 = a claim is broken; 3 = the runner failed.
 *
 * usage: node gru-output/gc-523-owner-approval/red-defects.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { assertNamedRedBaselineLeg } from '../../tools/assert-formal-verdicts-baseline.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const STRANDED = '3f3f2d3382cef11967dcc8806be4f0a4c1a8b42f';
const MISSING_GUARD = [/withdrawUnhostedOwnerApprovals\)? is not a function/u, /isTransientCardPostFailure\)? is not a function/u];

const A = 'owner approval of abandonment';
const FENCES = 'owner approval — the Approve is bound to the fences read when Gru asked';
const CRASH = 'owner approval — crash windows finish on reconcile, never twice';
const WITHDRAW = 'owner approval — reconcile, withdrawal and shutdown';
const ANSWERS = 'owner approval — proposal answers and readback';
const TEXT = 'owner approval - the text that sends Gru and the owner to the new route';

const LEGS = [
  {
    label: 'backend',
    cwd: '.',
    files: ['test/owner-approvals.test.ts', 'test/owner-approval-text.test.ts', 'test/notification-decisions.test.ts', 'test/ledger-db.test.ts'],
    titles: [
      // F1: the result on the card the board renders
      `${A} abandons an unknown-custody request as outcome-unknown and closes the card with what happened`,
      `${A} a Deny runs nothing and closes the card with the denied text`,
      `${A} refuses retirement_available and names ordinary retirement on the card`,
      `${FENCES} refuses a changed state`,
      `${FENCES} refuses live_work when a producer appears after the proposal, and reconcile never asks twice`,
      `${FENCES} refuses every decider that is not exactly owner, with Approve and with Deny`,
      `${CRASH} terminal written, card open: reconcile (f) closes the card with the succeeded text`,
      `${WITHDRAW} withdraws a proposed card once its request is retired, leaving no non-terminal record`,
      'the result a follow-through closes an owner card with is kept on the card (#523) stores the resolution detail of a follow-through and of a producer withdrawal on the row itself',
      'ledger db + migration runner adds the nullable notification resolution detail and leaves a row resolved before it null (#523)',
      // F2: a card the reconcile cannot post
      `${CRASH} a card the reconcile cannot post ends the record refused card-post-failed, so the request can be proposed again`,
      // (the busy-store reconcile test pins what the stranded head already did - retry - and is not a defect test)
      `${CRASH} keeps retrying a card the store could not take yet: a busy store is not a card that can never exist`,
      // F3: nothing carries out a decision on an unhosted boot
      `${WITHDRAW} withdraws each open undecided card when the service is not hosted, and leaves decided and executing records for a hosting boot`,
      `${WITHDRAW} leaves an approval that was already being carried out for the boot that hosts the service again`,
      // F4: the reason rule
      `${ANSWERS} rejects malformed input and any producer other than gru`,
      // F14 and the docs that state F3 and F4
      `${TEXT} docs/OPERATIONS.md points the unknown-custody sentence at the owner-approval section`,
      `${TEXT} docs/DIRECTIVE-RECOVERY.md states the reason rule and that approval cards need the service hosted`,
    ],
  },
  {
    label: 'web',
    cwd: 'web',
    files: ['web/src/ui/board.test.ts', 'web/src/lib/board-protocol.test.ts'],
    titles: [
      'FOR YOU owner band (permanent, top of board) shows the result a follow-through closed an owner card with, on the card itself (#523)',
    ],
  },
];

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

function main() {
  const dir = mkdtempSync(join(tmpdir(), 'gru-523-red-defects.'));
  try {
    execFileSync('tar', ['-x', '-C', dir], { input: execFileSync('git', ['archive', STRANDED], { cwd: ROOT, maxBuffer: 512 * 1024 * 1024 }) });
    for (const leg of LEGS) for (const file of leg.files) copyFileSync(join(ROOT, file), join(dir, file));
    symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
    try { symlinkSync(join(ROOT, 'web', 'node_modules'), join(dir, 'web', 'node_modules')); } catch { /* web has no own node_modules */ }
    const lines = [];
    for (const leg of LEGS) {
      const results = join(dir, `results-${leg.label}.json`);
      const cwd = join(dir, leg.cwd);
      const bin = leg.cwd === 'web' ? join(ROOT, 'node_modules', 'vitest', 'vitest.mjs') : 'node_modules/vitest/vitest.mjs';
      const files = leg.files.map((file) => (leg.cwd === 'web' ? file.replace(/^web\//u, '') : file));
      const pattern = leg.titles.map(escapeRegExp).join('|');
      const vitest = spawnSync('node', [bin, 'run', '--reporter=json', `--outputFile=${results}`, ...files, '-t', pattern], { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
      process.stdout.write(`[red-defects ${leg.label}] vitest exit=${String(vitest.status)} (EXPECTED-NONZERO)\n`);
      if (vitest.status === 0) {
        process.stdout.write(`FAILS-BEFORE CLAIM BROKEN: the ${leg.label} defect tests pass at ${STRANDED}\n`);
        return 2;
      }
      try {
        lines.push(assertNamedRedBaselineLeg(`red-defects ${leg.label}`, JSON.parse(readFileSync(results, 'utf8')), leg.titles, MISSING_GUARD));
      } catch (error) {
        process.stdout.write(`FAILS-BEFORE CLAIM BROKEN: ${String(error)}\n`);
        return 2;
      }
    }
    for (const line of lines) process.stdout.write(`${line}\n`);
    process.stdout.write(`EXPECTED-NONZERO: the defect tests fail at the stranded head ${STRANDED.slice(0, 8)}\n`);
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

try {
  process.exitCode = main();
} catch (error) {
  process.stderr.write(`RED-DEFECTS RUNNER FAILED: ${String(error instanceof Error ? error.message : error)}\n`);
  process.exitCode = 3;
}
