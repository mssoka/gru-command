#!/usr/bin/env node
/**
 * Remove compiled outputs whose TypeScript source no longer exists — run by
 * `npm run build` right after `tsc` (and runnable by hand:
 * `node tools/prune-stale-dist.mjs [packageRoot]`).
 *
 * Why: `tsc` never deletes outputs of a removed source. `prepack` empties
 * dist/ first, but `gru-service roll` rebuilds the deploy clone in place
 * (`npm run build`) while the old build keeps serving, so emptying dist/
 * there is not an option. A deleted module's dist/*.js then survived every
 * roll, and the Perkins runtime fingerprint (src/runtime/review-build-
 * identity.ts) correctly refused it as "an unproven executable path" —
 * owner incident 2026-10-07: dist/dispatch/perkins-review/hybrid.js,
 * orphaned since its source was deleted on 2026-09-26 (eac368d).
 *
 * Scope: only tsc-shaped outputs for this tsconfig (`.js`, `.js.map`,
 * `.d.ts`; no declarationMap) whose `src/<same path>.ts` is gone. Files the
 * build writes itself (`.mjs`, `.json`) are never touched. Symlinks are
 * never followed or removed. Directories emptied by the prune are removed.
 * Every removal is printed; a missing dist/ fails loud (run `tsc` first).
 */
import { existsSync, lstatSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

const OUTPUT_SUFFIXES = ['.js.map', '.d.ts', '.js'];

const root = resolve(process.argv[2] ?? '.');
const dist = join(root, 'dist');
const src = join(root, 'src');

if (!existsSync(dist) || !lstatSync(dist).isDirectory()) {
  process.stderr.write(`prune-stale-dist: ${dist} is not a directory — run tsc before pruning\n`);
  process.exit(1);
}
if (!existsSync(src) || !lstatSync(src).isDirectory()) {
  process.stderr.write(`prune-stale-dist: ${src} is not a directory — refusing to prune without sources\n`);
  process.exit(1);
}

/** The `src/<path>.ts` a tsc output came from, or null for non-tsc files. */
function sourceFor(relativePath) {
  const suffix = OUTPUT_SUFFIXES.find((candidate) => relativePath.endsWith(candidate));
  if (suffix === undefined) return null;
  return join(src, `${relativePath.slice(0, -suffix.length)}.ts`);
}

let removed = 0;

/** Returns true when the directory is empty after pruning. */
function prune(directory) {
  let remaining = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (prune(path)) {
        rmdirSync(path);
      } else {
        remaining += 1;
      }
      continue;
    }
    const relativePath = relative(dist, path);
    const source = entry.isFile() ? sourceFor(relativePath) : null;
    if (source !== null && !existsSync(source)) {
      unlinkSync(path);
      removed += 1;
      process.stdout.write(
        `prune-stale-dist: removed dist/${relativePath} (src/${relative(src, source)} no longer exists)\n`,
      );
      continue;
    }
    remaining += 1;
  }
  return remaining === 0;
}

prune(dist);
if (removed > 0) process.stdout.write(`prune-stale-dist: removed ${removed} stale output(s)\n`);
