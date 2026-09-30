#!/usr/bin/env node
/**
 * Vitest 3.2.7 worker-RPC timeout fix — applied to the installed vitest
 * dist by the `pretest` hook (and runnable by hand: `node
 * tools/patch-vitest-rpc-timeout.mjs`).
 *
 * Why: the pinned vitest (3.2.7, the final 3.x release) hardcodes a 60 s
 * timeout on the worker→host birpc channel (`DEFAULT_TIMEOUT = 6e4` in
 * `createBirpc`, with no configuration surface). On a shared, loaded
 * host a worker can block in long synchronous test operations past 60 s
 * while every test still passes; the timer then surfaces as an unhandled
 * `[vitest-worker]: Timeout calling "onTaskUpdate"` error and the run
 * exits 1 with zero test failures. Upstream removed the timer on main
 * (vitest-dev/vitest#11082 — "green runs exit 1 on loaded runners";
 * fixed by #8297 by passing `timeout: -1` in `createRuntimeRpc`). No
 * fixed 3.x release exists and vitest 4/5 is a major upgrade, so this
 * applies exactly the upstream change to the installed dist.
 *
 * Safety: idempotent; only the two lines upstream removed are changed;
 * a real test failure still fails the run (test outcomes, assertions,
 * and every test timeout are untouched); the file is re-read and
 * verified after writing; and an unknown dist shape (e.g. after a
 * vitest upgrade) fails LOUD so the patch is never silently stale.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const note = (message) => process.stdout.write(`${message}\n`);

const DIST_ROOTS = ['node_modules', 'web/node_modules'];

// The exact 3.2.7 opening of createRuntimeRpc's createBirpc options.
const OPEN = [
  '\tconst rpc = createSafeRpc(createBirpc({ onCancel: setCancel }, {',
  '\t\teventNames: [',
  '\t\t\t"onUserConsoleLog",',
  '\t\t\t"onCollected",',
  '\t\t\t"onCancel"',
  '\t\t],',
].join('\n');
// Upstream's change: disable the worker-side timer (the run stays bounded
// by each test's timeout and by the verification scheduler's run budget).
const PATCHED = `${OPEN}\n\t\ttimeout: -1,`;

function rpcChunks() {
  const files = [];
  for (const root of DIST_ROOTS) {
    const dir = join(root, 'vitest', 'dist', 'chunks');
    if (!existsSync(dir)) continue;
    distDirs.push(dir);
    for (const entry of readdirSync(dir)) {
      if (/^rpc\..+\.js$/.test(entry)) files.push(join(dir, entry));
    }
  }
  return files;
}

/** vitest/dist/chunks directories that exist — distinguishes "vitest is not
 * installed" (skip cleanly) from "vitest is installed but its shape no longer
 * matches the pinned patch" (fail LOUD, never silently disable the fix). */
const distDirs = [];
const chunks = rpcChunks();
if (chunks.length === 0) {
  if (distDirs.length > 0) {
    throw new Error(
      `vitest-rpc-timeout: vitest dist present but no rpc chunk found (${distDirs.join(', ')}) — ` +
        'the installed vitest layout changed; update tools/patch-vitest-rpc-timeout.mjs before testing',
    );
  }
  note('vitest-rpc-timeout: no installed vitest dist found — skipped (production install?)');
  process.exit(0);
}

let patchedCount = 0;
for (const file of chunks) {
  const text = readFileSync(file, 'utf-8');
  if (text.includes(PATCHED)) {
    note(`vitest-rpc-timeout: already patched ${file}`);
    continue;
  }
  const occurrences = text.split(OPEN).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `vitest-rpc-timeout: unexpected ${file} shape (${occurrences} createBirpc sites) — ` +
        'the pinned vitest dist changed; update tools/patch-vitest-rpc-timeout.mjs before testing',
    );
  }
  writeFileSync(file, text.replace(OPEN, PATCHED));
  const verified = readFileSync(file, 'utf-8').includes(PATCHED);
  if (!verified) {
    throw new Error(`vitest-rpc-timeout: write verification failed for ${file}`);
  }
  patchedCount += 1;
  note(`vitest-rpc-timeout: applied upstream fix to ${file}`);
}

note(`vitest-rpc-timeout: ${patchedCount} file(s) patched this run, ${chunks.length} checked`);
