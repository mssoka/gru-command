import { closeSync, constants, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({ swap: undefined as undefined | (() => void), restore: undefined as undefined | (() => void), calls: 0 }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: ((...args: Parameters<typeof actual.spawnSync>) => {
    seam.calls += 1;
    seam.swap?.();
    try { return actual.spawnSync(...args); }
    finally { seam.restore?.(); }
  }) as typeof actual.spawnSync };
});

const roots: string[] = [];
afterEach(() => {
  seam.swap = undefined;
  seam.restore = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it.skipIf(process.platform !== 'darwin')('skips a non-executable earlier PATH python but refuses an explicitly invalid pin', async () => {
  const { reviewPythonExecutable } = await import('../src/runtime/review-directory-entries.js');
  const working = reviewPythonExecutable();
  const root = mkdtempSync(join(tmpdir(), 'gru-python-path-'));
  roots.push(root);
  const first = join(root, 'first');
  mkdirSync(first);
  writeFileSync(join(first, 'python3'), 'not executable', { mode: 0o644 });
  expect(reviewPythonExecutable({ PATH: `${first}:${dirname(working)}` })).toBe(realpathSync(working));
  expect(() => reviewPythonExecutable({ PATH: dirname(working),
    GRU_COMMAND_REVIEW_PYTHON: join(first, 'python3') })).toThrow('usable pinned Python 3 executable');
});

it.skipIf(process.platform !== 'darwin')('refuses executable shims even when they dispatch to a working Python', async () => {
  const { reviewPythonExecutable } = await import('../src/runtime/review-directory-entries.js');
  const python = reviewPythonExecutable();
  const root = mkdtempSync(join(tmpdir(), 'gru-python-shim-'));
  roots.push(root);
  const shim = join(root, 'python3');
  writeFileSync(shim, `#!/bin/sh\nexec "${python}" "$@"\n`, { mode: 0o755 });
  expect(() => reviewPythonExecutable({ GRU_COMMAND_REVIEW_PYTHON: shim }))
    .toThrow('usable pinned Python 3 executable');
  expect(() => reviewPythonExecutable({ PATH: `${root}:${dirname(python)}` }))
    .toThrow('usable pinned Python 3 executable');
});

it.skipIf(process.platform !== 'darwin')('enumerates only the inherited checked directory during a pathname swap-and-restore', async () => {
  const { reviewDirectoryTree, checkedReviewDirectoryEntries } = await import('../src/runtime/review-directory-entries.js');
  const root = mkdtempSync(join(tmpdir(), 'gru-fd-swap-'));
  roots.push(root);
  const original = join(root, 'installed');
  const moved = join(root, 'checked-inode');
  const outside = join(root, 'outside');
  mkdirSync(original);
  mkdirSync(outside);
  writeFileSync(join(original, 'checked.js'), 'public code');
  writeFileSync(join(outside, 'credential-looking-secret.js'), 'never hash');
  const fd = openSync(original, constants.O_RDONLY | constants.O_NOFOLLOW);
  seam.swap = () => { renameSync(original, moved); symlinkSync(outside, original); };
  seam.restore = () => { rmSync(original); renameSync(moved, original); };
  try {
    const before = seam.calls;
    const listing = reviewDirectoryTree(fd);
    expect(seam.calls).toBe(before + 1);
    expect(listing.get('')?.names).toEqual(['checked.js']);
    expect([...listing.values()].flatMap((entry) => entry.names)).not.toContain('credential-looking-secret.js');
    // Rename changes the directory ctime, so even its old checked entries
    // cannot be credited after restoring the pathname.
    expect(() => checkedReviewDirectoryEntries(fd, listing.get(''))).toThrow('directory changed');
  } finally { closeSync(fd); }
});
