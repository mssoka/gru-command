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
 *
 * Provenance: restored 2026-09-30 under an explicit owner authorization
 * for this harness change (journal j-463; PR #135 — the r6 review
 * required either removal or an owner decision). The implementation is
 * the same change PR #139 landed on main; this copy additionally keeps
 * the two fail-loud layout guards, its only delta, so an installed-but-
 * unrecognized vitest layout fails honestly instead of skipping silently.
 * Bounded by the surrounding test/assertion timeouts and the verification
 * scheduler's run budget; it disables no test deadline.
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

/** vitest/dist/chunks directories that exist — distinguishes "vitest is not
 * installed" (skip cleanly) from "vitest is installed but its shape no longer
 * matches the pinned patch" (fail LOUD, never silently disable the fix).
 * Both roots are gathered BEFORE any failure decision: a package.json-only
 * vitest under one root must not abort the run while the other root still
 * holds a patchable dist. */
const distDirs = [];
const missingDistRoots = [];
const chunks = [];
for (const root of DIST_ROOTS) {
  const dir = join(root, 'vitest', 'dist', 'chunks');
  if (existsSync(dir)) {
    distDirs.push(dir);
    for (const entry of readdirSync(dir)) {
      if (/^rpc\..+\.js$/.test(entry)) chunks.push(join(dir, entry));
    }
    continue;
  }
  if (existsSync(join(root, 'vitest', 'package.json'))) missingDistRoots.push(root);
}
if (chunks.length === 0) {
  if (distDirs.length > 0) {
    const alsoMissing =
      missingDistRoots.length > 0 ? `; also no dist/chunks under ${missingDistRoots.join(', ')}` : '';
    throw new Error(
      `vitest-rpc-timeout: vitest dist present but no rpc chunk found (${distDirs.join(', ')})${alsoMissing} — ` +
        'the installed vitest layout changed; update tools/patch-vitest-rpc-timeout.mjs before testing',
    );
  }
  if (missingDistRoots.length > 0) {
    throw new Error(
      `vitest-rpc-timeout: installed vitest has no dist/chunks (${missingDistRoots.join(', ')}) — ` +
        'update tools/patch-vitest-rpc-timeout.mjs before testing',
    );
  }
  note('vitest-rpc-timeout: no installed vitest dist found — skipped (production install?)');
  process.exit(0);
}

let patchedCount = 0;
const countOf = (text, needle) => text.split(needle).length - 1;
for (const file of chunks) {
  const text = readFileSync(file, 'utf-8');
  // Invariants for the single pinned site: either the site is OPEN-only
  // (exactly one OPEN, zero PATCHED) or it carries the patch (exactly one
  // PATCHED; its OPEN remains as the embedded prefix). Anything else —
  // including a chunk that already carries the patch AND a second unpatched
  // site — is a layout change and fails LOUD. The marker alone is NOT proof
  // of a fully patched chunk.
  const patchedSites = countOf(text, PATCHED);
  const openSites = countOf(text, OPEN);
  if (patchedSites === 1) {
    if (openSites !== 1) {
      throw new Error(
        `vitest-rpc-timeout: unexpected ${file} shape (${patchedSites} patched + ${openSites - patchedSites} unpatched createBirpc sites) — ` +
          'the pinned vitest dist changed; update tools/patch-vitest-rpc-timeout.mjs before testing',
      );
    }
    note(`vitest-rpc-timeout: already patched ${file}`);
    continue;
  }
  if (patchedSites !== 0 || openSites !== 1) {
    throw new Error(
      `vitest-rpc-timeout: unexpected ${file} shape (${patchedSites} patched + ${openSites - patchedSites} unpatched createBirpc sites) — ` +
        'the pinned vitest dist changed; update tools/patch-vitest-rpc-timeout.mjs before testing',
    );
  }
  writeFileSync(file, text.replace(OPEN, PATCHED));
  const verified = readFileSync(file, 'utf-8');
  if (countOf(verified, PATCHED) !== 1 || countOf(verified, OPEN) !== 1) {
    throw new Error(`vitest-rpc-timeout: write verification failed for ${file}`);
  }
  patchedCount += 1;
  note(`vitest-rpc-timeout: applied upstream fix to ${file}`);
}

note(`vitest-rpc-timeout: ${patchedCount} file(s) patched this run, ${chunks.length} checked`);
