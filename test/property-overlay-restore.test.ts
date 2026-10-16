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
const { hooks } = vi.hoisted(() => ({ hooks: { beforeRestoreRename: null as ((from: string, to: string) => void) | null } }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (from: Parameters<typeof actual.renameSync>[0], to: Parameters<typeof actual.renameSync>[1]) => {
      if (String(from).includes('.gru-restore-')) hooks.beforeRestoreRename?.(String(from), String(to));
      return actual.renameSync(from, to);
    },
  };
});
const fs = await import('node:fs');
const { applyOverlayFilesAllOrNothing } = await import('../src/property/overlay.js');

const dirs: string[] = [];
afterEach(() => {
  hooks.beforeRestoreRename = null;
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
    hooks.beforeRestoreRename = (_from, to) => {
      rmSync(to, { force: true });
      fs.symlinkSync(outside, to);
    };
    expect(() => applyOverlayFilesAllOrNothing({ workspaceRoot: root, files: failingSet })).toThrow(/non-file entry/u);
    expect(fs.lstatSync(join(root, 'test/existing.test.mjs')).isFile()).toBe(true);
    expect(readFileSync(join(root, 'test/existing.test.mjs'), 'utf8')).toBe('original\n');
    expect(readFileSync(outside, 'utf8')).toBe('outside bytes\n');
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
});
