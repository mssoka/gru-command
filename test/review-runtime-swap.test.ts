import { createHash } from 'node:crypto';
import { linkSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const seam = vi.hoisted(() => ({
  target: '', checked: '', saved: '', foreign: '', foreignIno: 0, foreignReads: 0,
  swapCount: 0, matchingOpens: 0, triggerAt: 1, holdSwap: false, swapAfterOpen: false,
  checkedIno: 0, openedUnknownIno: 0, unknownReads: 0, unknownDigestUpdates: 0,
  rewriteIno: 0, rewriteFile: '', rewriteBytes: '', rewriteAtDigest: '', rewrites: 0,
  invalidReadIno: 0, invalidRead: false, updatesAfterInvalid: 0,
  addAtDigest: '', addFile: '', additions: 0,
}));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    openSync: ((...args: Parameters<typeof fs.openSync>) => {
      const path = String(args[0]);
      const heldPackage = seam.target === ':held-package.json'
        ? /^\/proc\/self\/fd\/(\d+)\/package\.json$/u.exec(path) : null;
      const hoistedParent = seam.target === ':hoisted-parent'
        ? /^\/proc\/self\/fd\/(\d+)\/\.\.$/u.exec(path) : null;
      if (seam.target !== '' &&
        (path.endsWith(seam.target) || (heldPackage !== null &&
          fs.fstatSync(Number(heldPackage[1])).ino === seam.checkedIno) ||
          (hoistedParent !== null && fs.fstatSync(Number(hoistedParent[1])).ino === seam.checkedIno)) &&
        ++seam.matchingOpens === seam.triggerAt && seam.swapCount === 0) {
        seam.swapCount += 1;
        const originalFd = seam.swapAfterOpen ? fs.openSync(...args) : undefined;
        fs.renameSync(seam.checked, seam.saved);
        fs.renameSync(seam.foreign, seam.checked);
        try { return originalFd ?? fs.openSync(...args); }
        finally {
          if (!seam.holdSwap) {
            fs.renameSync(seam.checked, seam.foreign);
            fs.renameSync(seam.saved, seam.checked);
          }
        }
      }
      return fs.openSync(...args);
    }) as typeof fs.openSync,
    readSync: ((...args: Parameters<typeof fs.readSync>) => {
      if (seam.foreignIno !== 0 && fs.fstatSync(args[0]).ino === seam.foreignIno) seam.foreignReads += 1;
      if (seam.openedUnknownIno !== 0 && fs.fstatSync(args[0]).ino === seam.openedUnknownIno) seam.unknownReads += 1;
      const size = fs.readSync(...args);
      if (seam.invalidReadIno !== 0 && fs.fstatSync(args[0]).ino === seam.invalidReadIno) seam.invalidRead = true;
      if (seam.rewriteIno !== 0 && fs.fstatSync(args[0]).ino === seam.rewriteIno && seam.rewrites === 0) {
        fs.writeFileSync(seam.rewriteFile, seam.rewriteBytes);
        seam.rewrites += 1;
      }
      return size;
    }) as typeof fs.readSync,
  };
});
vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>();
  const fs = await import('node:fs');
  return {
    ...crypto,
    createHash: ((...args: Parameters<typeof crypto.createHash>) => {
      const hash = crypto.createHash(...args);
      const original = hash.update.bind(hash);
      hash.update = ((value: Parameters<typeof hash.update>[0]) => {
        if (String(value).includes('credential-looking-secret')) seam.unknownDigestUpdates += 1;
        if (seam.invalidRead) seam.updatesAfterInvalid += 1;
        if (seam.addAtDigest !== '' && String(value) === seam.addAtDigest && seam.additions === 0) {
          fs.writeFileSync(seam.addFile, 'credential-looking-secret: public executable filename');
          seam.additions += 1;
        }
        if (seam.rewriteAtDigest !== '' && String(value) === seam.rewriteAtDigest && seam.rewrites === 0) {
          fs.writeFileSync(seam.rewriteFile, seam.rewriteBytes);
          seam.rewrites += 1;
        }
        return original(value);
      }) as typeof hash.update;
      return hash;
    }) as typeof crypto.createHash,
  };
});

const roots: string[] = [];
afterEach(() => {
  Object.assign(seam, { target: '', checked: '', saved: '', foreign: '', foreignIno: 0,
    foreignReads: 0, swapCount: 0, matchingOpens: 0, triggerAt: 1, holdSwap: false,
    swapAfterOpen: false, checkedIno: 0, openedUnknownIno: 0, unknownReads: 0, unknownDigestUpdates: 0,
    rewriteIno: 0, rewriteFile: '', rewriteBytes: '', rewriteAtDigest: '', rewrites: 0,
    invalidReadIno: 0, invalidRead: false, updatesAfterInvalid: 0,
    addAtDigest: '', addFile: '', additions: 0 });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'gru-review-runtime-swap-'));
  roots.push(root);
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'dist', 'review-dependency-identity.json'), JSON.stringify({
    schemaVersion: 1, dependencySha256: 'a'.repeat(64),
  }));
  return root;
}

it.skipIf(process.platform !== 'darwin')('rejects a real-directory swap at file open before reading or hashing foreign bytes', async () => {
  const { reviewRuntimeVersion } = await import('../src/runtime/review-build-identity.js');
  const root = fixture();
  const dist = join(root, 'dist');
  const foreign = join(root, 'outside');
  const saved = join(root, 'held');
  writeFileSync(join(dist, 'main.js'), 'export const checked = true;');
  mkdirSync(foreign);
  const foreignFile = join(foreign, 'main.js');
  writeFileSync(foreignFile, 'credential-looking-secret: do not read or hash');
  seam.target = '/dist/main.js';
  seam.checked = dist;
  seam.saved = saved;
  seam.foreign = foreign;
  seam.foreignIno = statSync(foreignFile).ino;
  expect(() => reviewRuntimeVersion(root)).toThrow(/directory changed|file changed/);
  expect(seam.swapCount).toBe(1);
  expect(seam.foreignReads).toBe(0);
});

it.skipIf(process.platform !== 'darwin')('rejects a real-directory swap of installed package metadata before reading foreign bytes', async () => {
  const { reviewRuntimeVersion } = await import('../src/runtime/review-build-identity.js');
  const root = fixture();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { tslib: '1.0.0' } }));
  const checked = join(root, 'node_modules', 'tslib');
  const foreign = join(root, 'outside');
  mkdirSync(checked, { recursive: true });
  mkdirSync(foreign);
  writeFileSync(join(checked, 'package.json'), JSON.stringify({ name: 'tslib', version: '1.0.0' }));
  writeFileSync(join(checked, 'tslib.js'), 'export const checked = true;');
  const foreignFile = join(foreign, 'package.json');
  writeFileSync(foreignFile, 'credential-looking-secret: do not read or hash');
  seam.target = '/node_modules/tslib/package.json';
  seam.checked = checked;
  seam.saved = join(root, 'node_modules', 'held');
  seam.foreign = foreign;
  seam.foreignIno = statSync(foreignFile).ino;
  expect(() => reviewRuntimeVersion(root)).toThrow(/directory changed|file changed/);
  expect(seam.swapCount).toBe(1);
  expect(seam.foreignReads).toBe(0);
});

it.skipIf(process.platform !== 'darwin')('rejects a swapped project package manifest before reading foreign bytes', async () => {
  const { reviewRuntimeVersion } = await import('../src/runtime/review-build-identity.js');
  const root = fixture();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: {} }));
  const foreign = mkdtempSync(join(tmpdir(), 'gru-review-foreign-project-'));
  roots.push(foreign);
  const foreignFile = join(foreign, 'package.json');
  writeFileSync(foreignFile, 'credential-looking-secret: do not read or hash');
  seam.target = '/package.json';
  seam.checked = root;
  seam.saved = `${root}-held`;
  seam.foreign = foreign;
  seam.foreignIno = statSync(foreignFile).ino;
  expect(() => reviewRuntimeVersion(root)).toThrow(/directory changed|file changed/);
  expect(seam.swapCount).toBe(1);
  expect(seam.foreignReads).toBe(0);
});

it.skipIf(process.platform !== 'linux')('reads installed and project package metadata through held directory FDs during real-directory swaps', async () => {
  const { reviewRuntimeVersion } = await import('../src/runtime/review-build-identity.js');
  const root = fixture();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { tslib: '1.0.0' } }));
  const installed = join(root, 'node_modules', 'tslib');
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'tslib', version: '1.0.0' }));
  writeFileSync(join(installed, 'tslib.js'), 'export const checked = true;');
  expect(reviewRuntimeVersion(root)).toMatch(/^[0-9a-f]{64}$/u);
  for (const [checked, saved] of [
    [installed, join(root, 'node_modules', 'held')],
    [root, `${root}-held`],
  ] as const) {
    const foreign = mkdtempSync(join(tmpdir(), 'gru-review-foreign-metadata-'));
    roots.push(foreign);
    const foreignFile = join(foreign, 'package.json');
    writeFileSync(foreignFile, 'credential-looking-secret: do not read or hash');
    Object.assign(seam, { target: ':held-package.json', checked, saved, foreign,
      checkedIno: statSync(checked).ino, foreignIno: statSync(foreignFile).ino,
      matchingOpens: 0, triggerAt: 1, swapCount: 0, foreignReads: 0, unknownDigestUpdates: 0 });
    expect(() => reviewRuntimeVersion(root)).toThrow(/directory changed|installed dependency changed|installed root changed/);
    expect(seam.swapCount).toBe(1);
    expect(seam.foreignReads).toBe(0);
    expect(seam.unknownDigestUpdates).toBe(0);
  }
});

it('retains the original package descriptor across a package-directory replacement', async () => {
  const { reviewRuntimeVersion } = await import('../src/runtime/review-build-identity.js');
  const root = fixture();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { tslib: '1.0.0' } }));
  const installed = join(root, 'node_modules', 'tslib');
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'tslib', version: '1.0.0' }));
  writeFileSync(join(installed, 'tslib.js'), 'export const checked = true;');
  expect(reviewRuntimeVersion(root)).toMatch(/^[a-f0-9]{64}$/u);
  const foreign = mkdtempSync(join(tmpdir(), 'gru-review-foreign-dependency-'));
  roots.push(foreign);
  writeFileSync(join(foreign, 'package.json'), JSON.stringify({ name: 'tslib', version: '1.0.0' }));
  const foreignFile = join(foreign, 'tslib.js');
  writeFileSync(foreignFile, 'credential-looking-secret: do not hash');
  Object.assign(seam, { target: '/tslib', checked: installed, saved: join(root, 'node_modules', 'held'),
    foreign, foreignIno: statSync(foreignFile).ino, swapCount: 0, foreignReads: 0, holdSwap: true,
    swapAfterOpen: true });
  try {
    expect(() => reviewRuntimeVersion(root)).toThrow(process.platform === 'darwin'
      ? /directory enumeration failed|directory changed|file changed/
      : 'installed dependency changed during fingerprint');
    expect(seam.swapCount).toBe(1);
    expect(seam.foreignReads).toBe(0);
  } finally {
    if (seam.swapCount !== 0) {
      const { renameSync } = await import('node:fs');
      renameSync(installed, foreign);
      renameSync(seam.saved, installed);
    }
  }
});

it('binds dependencies to the original root after dist scanning during a root replacement', async () => {
  const { reviewRuntimeVersion } = await import('../src/runtime/review-build-identity.js');
  const root = fixture();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { tslib: '1.0.0' } }));
  const installed = join(root, 'node_modules', 'tslib');
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'tslib', version: '1.0.0' }));
  writeFileSync(join(installed, 'tslib.js'), 'export const checked = true;');
  expect(reviewRuntimeVersion(root)).toMatch(/^[0-9a-f]{64}$/u);
  const foreign = mkdtempSync(join(tmpdir(), 'gru-review-foreign-root-'));
  roots.push(foreign);
  const foreignInstalled = join(foreign, 'node_modules', 'tslib');
  mkdirSync(foreignInstalled, { recursive: true });
  writeFileSync(join(foreign, 'package.json'), JSON.stringify({ dependencies: { tslib: '1.0.0' } }));
  writeFileSync(join(foreignInstalled, 'package.json'), JSON.stringify({ name: 'tslib', version: '1.0.0' }));
  const foreignFile = join(foreignInstalled, 'tslib.js');
  writeFileSync(foreignFile, 'credential-looking-secret: do not hash');
  Object.assign(seam, { target: '/tslib', checked: root, saved: `${root}-held`, foreign,
    foreignIno: statSync(foreignFile).ino, swapCount: 0, foreignReads: 0, holdSwap: true });
  try {
    expect(() => reviewRuntimeVersion(root)).toThrow(process.platform === 'darwin'
      ? 'directory changed' : /installed root changed|directory changed/);
    expect(seam.swapCount).toBe(1);
    expect(seam.foreignReads).toBe(0);
  } finally {
    if (seam.swapCount !== 0) {
      const { renameSync } = await import('node:fs');
      renameSync(root, foreign);
      renameSync(seam.saved, root);
    }
  }
});

it.skipIf(process.platform !== 'linux')('refuses a permanent installed-root swap at the final pathname check', async () => {
  const { reviewRuntimeVersion } = await import('../src/runtime/review-build-identity.js');
  const root = fixture();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: {} }));
  const original = reviewRuntimeVersion(root);
  expect(original).toMatch(/^[0-9a-f]{64}$/u);
  const foreign = mkdtempSync(join(tmpdir(), 'gru-review-foreign-final-root-'));
  roots.push(foreign);
  mkdirSync(join(foreign, 'dist'));
  const foreignFile = join(foreign, 'dist', 'main.js');
  writeFileSync(foreignFile, 'credential-looking-secret: do not hash');
  Object.assign(seam, { target: `/${basename(root)}`, triggerAt: 2, checked: root, saved: `${root}-held`, foreign,
    foreignIno: statSync(foreignFile).ino, swapCount: 0, matchingOpens: 0, foreignReads: 0, holdSwap: true });
  try {
    expect(() => reviewRuntimeVersion(root)).toThrow('installed root changed during fingerprint');
    expect(seam.swapCount).toBe(1);
    expect(seam.foreignReads).toBe(0);
  } finally {
    if (seam.swapCount !== 0) {
      const { renameSync } = await import('node:fs');
      renameSync(root, foreign);
      renameSync(seam.saved, root);
    }
  }
});

it('binds an installed package to the held root even when an ancestor of its pathname is replaced', async () => {
  const { reviewRuntimeVersion } = await import('../src/runtime/review-build-identity.js');
  const parent = fixture();
  const root = join(parent, 'installed');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'review-dependency-identity.json'), JSON.stringify({
    schemaVersion: 1, dependencySha256: 'a'.repeat(64),
  }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { tslib: '1.0.0' } }));
  const installed = join(root, 'node_modules', 'tslib');
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'tslib', version: '1.0.0' }));
  writeFileSync(join(installed, 'tslib.js'), 'export const checked = true;');
  expect(reviewRuntimeVersion(root)).toMatch(/^[0-9a-f]{64}$/u);
  const foreign = mkdtempSync(join(tmpdir(), 'gru-review-foreign-ancestor-'));
  roots.push(foreign);
  const foreignInstalled = join(foreign, 'installed', 'node_modules', 'tslib');
  mkdirSync(foreignInstalled, { recursive: true });
  writeFileSync(join(foreign, 'installed', 'package.json'), JSON.stringify({ dependencies: { tslib: '1.0.0' } }));
  writeFileSync(join(foreignInstalled, 'package.json'), JSON.stringify({ name: 'tslib', version: '1.0.0' }));
  const foreignFile = join(foreignInstalled, 'tslib.js');
  writeFileSync(foreignFile, 'credential-looking-secret: do not hash');
  Object.assign(seam, { target: '/tslib', checked: parent, saved: `${parent}-held`, foreign,
    foreignIno: statSync(foreignFile).ino, swapCount: 0, foreignReads: 0, holdSwap: true });
  try {
    expect(() => reviewRuntimeVersion(root)).toThrow(process.platform === 'darwin'
      ? 'directory enumeration failed' : /installed root changed|directory changed/);
    expect(seam.swapCount).toBe(1);
    expect(seam.foreignReads).toBe(0);
    expect(seam.unknownDigestUpdates).toBe(0);
  } finally {
    if (seam.swapCount !== 0) {
      const { renameSync } = await import('node:fs');
      renameSync(parent, foreign);
      renameSync(seam.saved, parent);
    }
  }
});

it.skipIf(process.platform !== 'linux')('refuses moved-root hoisted lookup before reading the new parent dependency', async () => {
  const { reviewRuntimeVersion } = await import('../src/runtime/review-build-identity.js');
  const originalParent = fixture();
  const root = join(originalParent, 'installed');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist', 'review-dependency-identity.json'), JSON.stringify({
    schemaVersion: 1, dependencySha256: 'a'.repeat(64),
  }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { tslib: '1.0.0' } }));
  const originalPackage = join(originalParent, 'node_modules', 'tslib');
  mkdirSync(originalPackage, { recursive: true });
  writeFileSync(join(originalPackage, 'package.json'), JSON.stringify({ name: 'tslib', version: '1.0.0' }));
  writeFileSync(join(originalPackage, 'tslib.js'), 'export const checked = true;');
  expect(reviewRuntimeVersion(root)).toMatch(/^[a-f0-9]{64}$/u);
  const newParent = mkdtempSync(join(tmpdir(), 'gru-review-new-hoist-parent-'));
  roots.push(newParent);
  const foreignPackage = join(newParent, 'node_modules', 'tslib');
  mkdirSync(foreignPackage, { recursive: true });
  writeFileSync(join(foreignPackage, 'package.json'), JSON.stringify({ name: 'tslib', version: '1.0.0' }));
  const foreignFile = join(foreignPackage, 'tslib.js');
  writeFileSync(foreignFile, 'credential-looking-secret: never read or hash');
  const foreignRoot = join(originalParent, 'replacement');
  mkdirSync(foreignRoot);
  Object.assign(seam, { target: ':hoisted-parent', checked: root, saved: join(newParent, 'installed'),
    foreign: foreignRoot, checkedIno: statSync(root).ino, foreignIno: statSync(foreignFile).ino,
    triggerAt: 2, matchingOpens: 0, swapCount: 0, foreignReads: 0, holdSwap: true });
  try {
    expect(() => reviewRuntimeVersion(root)).toThrow(/installed root changed|directory changed/);
    expect(seam.swapCount).toBe(1);
    expect(seam.foreignReads).toBe(0);
    expect(seam.unknownDigestUpdates).toBe(0);
  } finally {
    if (seam.swapCount !== 0) {
      const { renameSync } = await import('node:fs');
      renameSync(root, foreignRoot);
      renameSync(seam.saved, root);
    }
  }
});

it.skipIf(process.platform !== 'linux')('refuses a nested child replacement after its held parent was enumerated', async () => {
  const { reviewRuntimeVersion } = await import('../src/runtime/review-build-identity.js');
  const root = fixture();
  const checked = join(root, 'dist', 'runtime');
  mkdirSync(checked);
  writeFileSync(join(checked, 'review-model-identity.js'), 'export const checked = true;');
  const foreign = mkdtempSync(join(tmpdir(), 'gru-review-foreign-nested-'));
  roots.push(foreign);
  const foreignFile = join(foreign, 'review-model-identity.js');
  writeFileSync(foreignFile, 'credential-looking-secret: never hash');
  Object.assign(seam, { target: '/runtime', checked, saved: join(root, 'dist', 'held'), foreign,
    foreignIno: statSync(foreignFile).ino, swapCount: 0, foreignReads: 0 });
  expect(() => reviewRuntimeVersion(root)).toThrow('directory changed during child selection');
  expect(seam.swapCount).toBe(1);
  expect(seam.foreignReads).toBe(0);
  expect(seam.unknownDigestUpdates).toBe(0);
});

it('rejects credential-valued unknown installed identity fields before any subsequent digest update', async () => {
  const { reviewRuntimeVersion } = await import('../src/runtime/review-build-identity.js');
  for (const kind of ['review-dependency-identity', 'build-rev'] as const) {
    const root = fixture();
    const file = join(root, 'dist', `${kind}.json`);
    const metadata = kind === 'build-rev'
      ? { rev: 'a'.repeat(40), committedAt: '2026-10-03T12:00:00+00:00', builtAt: '2026-10-04T12:00:00.000Z' }
      : { schemaVersion: 1, dependencySha256: 'a'.repeat(64) };
    writeFileSync(file, JSON.stringify({ ...metadata, credential: 'credential-looking-secret' }));
    seam.invalidReadIno = statSync(file).ino;
    expect(() => reviewRuntimeVersion(root)).toThrow('unsafe schema');
    expect(seam.invalidRead).toBe(true);
    expect(seam.updatesAfterInvalid).toBe(0);
    expect(seam.unknownDigestUpdates).toBe(0);
    Object.assign(seam, { invalidRead: false, invalidReadIno: 0, updatesAfterInvalid: 0 });
  }
});

it('ignores valid volatile build times but changes identity for a new public revision', async () => {
  const { reviewRuntimeVersion } = await import('../src/runtime/review-build-identity.js');
  const root = fixture();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: {} }));
  const file = join(root, 'dist', 'build-rev.json');
  const stamp = { rev: 'a'.repeat(40), committedAt: '2026-10-03T12:00:00+00:00', builtAt: '2026-10-04T12:00:00.000Z' };
  writeFileSync(file, JSON.stringify(stamp));
  const original = reviewRuntimeVersion(root);
  writeFileSync(file, JSON.stringify({ ...stamp, builtAt: '2026-10-05T12:00:00.000Z' }));
  expect(reviewRuntimeVersion(root)).toBe(original);
  writeFileSync(file, JSON.stringify({ ...stamp, rev: 'b'.repeat(40) }));
  expect(reviewRuntimeVersion(root)).not.toBe(original);
  writeFileSync(file, JSON.stringify({ ...stamp, committedAt: '2026-10-04T12:00:00+00:00' }));
  expect(reviewRuntimeVersion(root)).not.toBe(original);
  writeFileSync(file, JSON.stringify({ ...stamp, builtAt: 'credential-looking-secret' }));
  expect(() => reviewRuntimeVersion(root)).toThrow('unsafe schema');
  expect(seam.unknownDigestUpdates).toBe(0);
});

it('frames adjacent public files so appended next-path bytes cannot collide with a removed file', async () => {
  const { reviewRuntimeVersion } = await import('../src/runtime/review-build-identity.js');
  const root = fixture();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: {} }));
  const nested = join(root, 'dist', 'runtime');
  mkdirSync(nested);
  const first = 'dist/runtime/review-directory-entries.js';
  const next = 'dist/runtime/review-model-identity.js';
  const body = 'export const first = true;';
  const nextBody = 'export const second = true;';
  writeFileSync(join(root, first), body);
  writeFileSync(join(root, next), nextBody);
  const original = reviewRuntimeVersion(root);
  const unframed = (chunks: string[]) => createHash('sha256').update(chunks.join('')).digest('hex');
  expect(unframed([first, '\0', body, next, '\0', nextBody]))
    .toBe(unframed([first, '\0', body + next + '\0' + nextBody]));
  const { unlinkSync } = await import('node:fs');
  writeFileSync(join(root, first), `${body}${next}\0${nextBody}`);
  unlinkSync(join(root, next));
  expect(reviewRuntimeVersion(root)).not.toBe(original);
});

it('refuses a public executable added to an already scanned nested directory without hashing its bytes', async () => {
  const { reviewRuntimeVersion } = await import('../src/runtime/review-build-identity.js');
  const root = fixture();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: {} }));
  const nested = join(root, 'dist', 'runtime');
  mkdirSync(nested);
  writeFileSync(join(nested, 'review-directory-entries.js'), 'export const checked = true;');
  const added = join(nested, 'review-model-identity.js');
  Object.assign(seam, { addAtDigest: 'dist/runtime/review-directory-entries.js', addFile: added });
  expect(() => reviewRuntimeVersion(root)).toThrow('directory changed during child selection');
  expect(seam.additions).toBe(1);
  expect(seam.unknownDigestUpdates).toBe(0);
  expect(seam.unknownReads).toBe(0);
});

it('rejects same-inode same-size executable rewrites during and after their reads', async () => {
  const { reviewRuntimeVersion } = await import('../src/runtime/review-build-identity.js');
  for (const when of ['during', 'after'] as const) {
    const root = fixture();
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: {} }));
    const file = join(root, 'dist', 'main.js');
    const checked = 'export const checked = true;';
    writeFileSync(file, checked);
    const changed = 'credential-looking-secret'.padEnd(checked.length, '!');
    Object.assign(seam, { rewriteIno: when === 'during' ? statSync(file).ino : 0,
      rewriteAtDigest: when === 'after' ? 'dist/review-dependency-identity.json' : '',
      rewriteFile: file, rewriteBytes: changed, rewrites: 0 });
    expect(() => reviewRuntimeVersion(root)).toThrow(/file changed during (read|fingerprint)/);
    expect(seam.rewrites).toBe(1);
    expect(seam.unknownDigestUpdates).toBe(0);
    Object.assign(seam, { rewriteIno: 0, rewriteAtDigest: '', rewriteFile: '', rewriteBytes: '', rewrites: 0 });
  }
});

it('rejects same-size installed package metadata rewritten after its validated read', async () => {
  const { reviewRuntimeVersion } = await import('../src/runtime/review-build-identity.js');
  const root = fixture();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { tslib: '1.0.0' } }));
  const installed = join(root, 'node_modules', 'tslib');
  mkdirSync(installed, { recursive: true });
  const metadata = join(installed, 'package.json');
  writeFileSync(metadata, JSON.stringify({ name: 'tslib', version: '1.0.0' }));
  writeFileSync(join(installed, 'tslib.js'), 'export const checked = true;');
  Object.assign(seam, { rewriteAtDigest: 'node_modules/tslib', rewriteFile: metadata,
    rewriteBytes: JSON.stringify({ name: 'tslib', version: '1.0.1' }), rewrites: 0 });
  expect(() => reviewRuntimeVersion(root)).toThrow('file changed during fingerprint');
  expect(seam.rewrites).toBe(1);
  expect(seam.unknownDigestUpdates).toBe(0);
});

it('refuses a hard-linked public executable before reading or hashing credential bytes', async () => {
  const { reviewRuntimeVersion } = await import('../src/runtime/review-build-identity.js');
  const root = fixture();
  const secret = join(root, 'credential-looking-secret.txt');
  writeFileSync(secret, 'credential-looking-secret: private bytes');
  linkSync(secret, join(root, 'dist', 'main.js'));
  seam.openedUnknownIno = statSync(secret).ino;
  expect(() => reviewRuntimeVersion(root)).toThrow('single-linked');
  expect(seam.unknownReads).toBe(0);
  expect(seam.unknownDigestUpdates).toBe(0);
});

it('rejects unproven executable and imported JSON names before reading or hashing them', async () => {
  const { reviewRuntimeVersion } = await import('../src/runtime/review-build-identity.js');
  for (const relative of ['credential-looking-secret.js', 'providers/data/credential-looking-secret.json']) {
    const root = fixture();
    const file = join(root, 'dist', relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, 'credential-looking-secret: private bytes');
    seam.openedUnknownIno = statSync(file).ino;
    expect(() => reviewRuntimeVersion(root)).toThrow('unproven executable path');
    expect(seam.unknownReads).toBe(0);
    expect(seam.unknownDigestUpdates).toBe(0);
    seam.openedUnknownIno = 0;
  }
  const root = fixture();
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { tslib: '1.0.0' } }));
  const installed = join(root, 'node_modules', 'tslib');
  mkdirSync(installed, { recursive: true });
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'tslib', version: '1.0.0' }));
  const unknown = join(installed, 'credential-looking-secret.js');
  writeFileSync(unknown, 'credential-looking-secret: private bytes');
  seam.openedUnknownIno = statSync(unknown).ino;
  expect(() => reviewRuntimeVersion(root)).toThrow('unproven executable path');
  expect(seam.unknownReads).toBe(0);
  expect(seam.unknownDigestUpdates).toBe(0);
});
