#!/usr/bin/env node
/**
 * Stamp the running build's git revision into dist/build-rev.json.
 *
 * The deploy-drift card needs to know which revision the RUNNING service
 * was built from. Reading git HEAD at boot would lie after a `git pull`
 * without a rebuild, so the revision is captured HERE, at build time, and
 * read back by the service at boot (src/build-info.ts).
 *
 * Best-effort by design: a build from a tarball / non-git tree writes
 * nulls and still succeeds — the card renders "unknown" rather than
 * inventing a revision.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Git output or null — a missing git/checkout must never fail the build. */
function git(args) {
  try {
    const output = execFileSync('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    }).trim();
    return output === '' ? null : output;
  } catch {
    return null;
  }
}

const rev = git(['rev-parse', 'HEAD']);
const payload = {
  rev,
  committedAt: rev === null ? null : git(['log', '-1', '--format=%cI', rev]),
  builtAt: new Date().toISOString(),
};

const outFile = join(repoRoot, 'dist', 'build-rev.json');
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`);
process.stdout.write(`build rev ${rev ?? 'unknown'} → ${outFile}\n`);
