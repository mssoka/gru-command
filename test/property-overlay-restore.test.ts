import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * #380: the overlay rollback's restore step under faults only a filesystem
 * can cause — a link swapped in at the target, a failing rename — driven
 * through a mocked `node:fs` whose real calls pass through.
 */
const { hooks } = vi.hoisted(() => ({ hooks: {
  beforeRestoreRename: null as ((from: string, to: string) => void) | null,
  beforeRm: null as ((path: string) => void) | null,
  beforeReadFile: null as ((path: string) => void) | null,
  beforeLstat: null as ((path: string) => void) | null,
} }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
      if (String(from).includes('.gru-restore-')) hooks.beforeRestoreRename?.(String(from), String(to));
      return actual.renameSync(from, to);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => { hooks.beforeRm?.(String(args[0])); return actual.rmSync(...args); },
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => { hooks.beforeReadFile?.(String(args[0])); return actual.readFileSync(...args); }) as typeof actual.readFileSync,
    lstatSync: ((...args: Parameters<typeof actual.lstatSync>) => { hooks.beforeLstat?.(String(args[0])); return actual.lstatSync(...args); }) as typeof actual.lstatSync,
  };
});
const fs = await import('node:fs');
const { applyOverlayFilesAllOrNothing } = await import('../src/property/overlay.js');

const dirs: string[] = [];
afterEach(() => {
  hooks.beforeRestoreRename = null; hooks.beforeRm = null; hooks.beforeReadFile = null; hooks.beforeLstat = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function workspace(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'property-overlay-restore-')));
  dirs.push(root);
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test/existing.test.mjs'), 'original\n');
  mkdirSync(join(root, 'test/occupied.replay.json'));
  execFileSync('git', ['-C', root, 'init', '-q']);
  return root;
}
/** The existing file is overwritten, then the directory in the way refuses the set. */
const failingSet = [
  { path: 'test/existing.test.mjs', content: 'overlay\n' },
  { path: 'test/occupied.replay.json', content: '{}\n' },
];
const leftovers = (root: string) => readdirSync(join(root, 'test')).filter((name) => name.startsWith('.gru-restore-'));

describe('overlay rollback restore (#380)', () => {
  it('replaces a link swapped in at the target, never writing through it', () => {
    const root = workspace();
    const outside = join(realpathSync(mkdtempSync(join(tmpdir(), 'property-overlay-outside-'))), 'victim.txt');
    dirs.push(join(outside, '..'));
    writeFileSync(outside, 'outside bytes\n');
    let swapped = false;
    hooks.beforeRestoreRename = (_from, to) => {
      rmSync(to, { force: true });
      fs.symlinkSync(outside, to);
      swapped = true;
    };
    expect(() => applyOverlayFilesAllOrNothing({ workspaceRoot: root, files: failingSet })).toThrow(/non-file entry/u);
    expect(fs.lstatSync(join(root, 'test/existing.test.mjs')).isFile()).toBe(true);
    expect(readFileSync(join(root, 'test/existing.test.mjs'), 'utf8')).toBe('original\n');
    expect(readFileSync(outside, 'utf8')).toBe('outside bytes\n');
    expect(swapped, 'the link was swapped in before the restore').toBe(true);
    expect(leftovers(root)).toEqual([]);
  });

  it('a failing restore removes its own copy and fails loud with the original error and the cause', () => {
    const root = workspace();
    hooks.beforeRestoreRename = () => { throw Object.assign(new Error('rename refused'), { code: 'EPERM' }); };
    let error: unknown = null;
    try { applyOverlayFilesAllOrNothing({ workspaceRoot: root, files: failingSet }); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(AggregateError);
    const aggregate = error as AggregateError;
    expect(aggregate.message).toMatch(/^overlay write failed and its rollback was incomplete: .*non-file entry/u);
    expect(aggregate.errors.slice(1).map((cause) => (cause as NodeJS.ErrnoException).code)).toEqual(['EPERM']);
    // No stray copy is left in the live tree.
    expect(leftovers(root)).toEqual([]);
    expect(statSync(join(root, 'test/occupied.replay.json')).isDirectory()).toBe(true);
  });

  it('a copy that cannot be removed after a failed restore step is named, with both causes', () => {
    const root = workspace();
    hooks.beforeRestoreRename = () => { throw Object.assign(new Error('rename refused'), { code: 'EPERM' }); };
    hooks.beforeRm = (path) => { if (path.includes('.gru-restore-')) throw Object.assign(new Error('copy busy'), { code: 'EBUSY' }); };
    let error: unknown = null;
    try { applyOverlayFilesAllOrNothing({ workspaceRoot: root, files: failingSet }); } catch (caught) { error = caught; }
    hooks.beforeRm = null;
    expect(error).toBeInstanceOf(AggregateError);
    const restore = (error as AggregateError).errors[1] as AggregateError;
    const [copy] = leftovers(root);
    expect(restore.message).toBe(`restoring ${join(root, 'test/existing.test.mjs')} failed and its copy ${join(root, 'test', copy!)} could not be removed`);
    expect(restore.errors.map((cause) => (cause as NodeJS.ErrnoException).code)).toEqual(['EPERM', 'EBUSY']);
  });

  it('one failed restore never stops the rest: every other overwritten file is restored', () => {
    const root = workspace();
    writeFileSync(join(root, 'test/second.test.mjs'), 'second original\n');
    let renames = 0;
    hooks.beforeRestoreRename = () => { renames += 1; if (renames === 1) throw Object.assign(new Error('rename refused'), { code: 'EPERM' }); };
    const files = [
      { path: 'test/existing.test.mjs', content: 'overlay\n' },
      { path: 'test/second.test.mjs', content: 'overlay two\n' },
      { path: 'test/occupied.replay.json', content: '{}\n' },
    ];
    let error: unknown = null;
    try { applyOverlayFilesAllOrNothing({ workspaceRoot: root, files }); } catch (caught) { error = caught; }
    expect(renames).toBe(2);
    expect((error as AggregateError).errors.slice(1).map((cause) => (cause as NodeJS.ErrnoException).code)).toEqual(['EPERM']);
    // The first file's restore failed; the second was still restored.
    expect(readFileSync(join(root, 'test/existing.test.mjs'), 'utf8')).toBe('overlay\n');
    expect(readFileSync(join(root, 'test/second.test.mjs'), 'utf8')).toBe('second original\n');
    expect(leftovers(root)).toEqual([]);
  });

  it('a file the apply never reached is skipped only on its own inode: a same-bytes replacement is restored', () => {
    const root = workspace();
    const later = join(root, 'test/later.test.mjs');
    writeFileSync(later, 'later original\n');
    const files = [
      { path: 'test/existing.test.mjs', content: 'overlay\n' },
      { path: 'test/occupied.replay.json', content: '{}\n' },
      { path: 'test/later.test.mjs', content: 'never written\n' },
    ];
    // Untouched and on its own inode: skipped (the inode is unchanged).
    const before = statSync(later).ino;
    expect(() => applyOverlayFilesAllOrNothing({ workspaceRoot: root, files })).toThrow(/non-file entry/u);
    expect(statSync(later).ino).toBe(before);
    // Swapped for a same-bytes copy once the rollback has begun (the first
    // restore is under way): restored.
    let swapped: number | null = null;
    let rollingBack = false;
    hooks.beforeRestoreRename = () => { rollingBack = true; };
    hooks.beforeLstat = (path) => {
      if (path !== later || swapped !== null || !rollingBack) return;
      writeFileSync(`${later}.copy`, 'later original\n');
      fs.renameSync(`${later}.copy`, later);
      swapped = statSync(later).ino;
    };
    expect(() => applyOverlayFilesAllOrNothing({ workspaceRoot: root, files })).toThrow(/non-file entry/u);
    expect(swapped).not.toBeNull();
    expect(statSync(later).ino).not.toBe(swapped);
    expect(readFileSync(later, 'utf8')).toBe('later original\n');
    expect(leftovers(root)).toEqual([]);
  });

  it('a target the untouched-check cannot read is restored, never skipped', () => {
    const root = workspace();
    const target = join(root, 'test/existing.test.mjs');
    let reads = 0;
    // The first read captures the prior bytes; the second is the rollback's untouched-check.
    hooks.beforeReadFile = (path) => { if (path === target && ++reads === 2) throw Object.assign(new Error('read refused'), { code: 'EACCES' }); };
    expect(() => applyOverlayFilesAllOrNothing({ workspaceRoot: root, files: failingSet })).toThrow(/non-file entry/u);
    hooks.beforeReadFile = null;
    expect(reads).toBe(2);
    expect(readFileSync(target, 'utf8')).toBe('original\n');
    expect(leftovers(root)).toEqual([]);
  });
});
