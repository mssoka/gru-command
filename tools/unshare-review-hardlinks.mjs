#!/usr/bin/env node
/**
 * Give every hard-linked file under node_modules its own inode — run as the
 * root `postinstall` (after every dependency's install script) and runnable
 * by hand: `node tools/unshare-review-hardlinks.mjs [packageRoot]`.
 *
 * Why: the Perkins runtime fingerprint (src/runtime/review-build-identity.ts)
 * reads only single-linked files — a hard link is the same bytes under a
 * second name, possibly outside the audited tree, and the check cannot tell
 * a benign link from an alias. esbuild's own postinstall hard-links its
 * platform binary over `esbuild/bin/esbuild` on macOS/Linux, and every
 * `npm ci` (install.sh --update, gru-service roll) re-creates that link, so
 * the strict check never passed on a real install: owner incident
 * 2026-10-07, "review runtime file must be bounded, regular and
 * single-linked". The check stays strict; the install conforms to it.
 *
 * Safety: each shared file is copied beside itself (mode preserved) and the
 * copy is renamed over that one name, atomically — the bytes are identical,
 * only the link is broken. Symlinks are never followed or replaced. Every
 * unshared path is printed; a missing node_modules or any copy/rename
 * failure fails loud, so npm ci (and the roll preflight) stops instead of
 * shipping an install Perkins cannot fingerprint.
 */
import { chmodSync, copyFileSync, existsSync, lstatSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

const root = resolve(process.argv[2] ?? '.');
const modules = join(root, 'node_modules');

if (!existsSync(modules) || !lstatSync(modules).isDirectory()) {
  process.stderr.write(`unshare-review-hardlinks: ${modules} is not a directory — install dependencies first\n`);
  process.exit(1);
}

let unshared = 0;

function unshare(path) {
  const info = lstatSync(path);
  const temporary = `${path}.gru-unshare-${process.pid}`;
  try {
    copyFileSync(path, temporary);
    chmodSync(temporary, info.mode & 0o7777);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new Error(`unshare-review-hardlinks: could not unshare ${relative(root, path)}: ${String(error)}`);
  }
  unshared += 1;
  process.stdout.write(
    `unshare-review-hardlinks: unshared ${relative(root, path)} (was ${info.nlink} links)\n`,
  );
}

function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && lstatSync(path).nlink > 1) unshare(path);
  }
}

walk(modules);
if (unshared > 0) process.stdout.write(`unshare-review-hardlinks: unshared ${unshared} file(s)\n`);
