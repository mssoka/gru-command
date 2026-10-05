import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const observed = vi.hoisted(() => ({ attemptsEnumerated: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readdirSync: ((...args: Parameters<typeof fs.readdirSync>) => {
      if (String(args[0]).endsWith('/attempts')) {
        observed.attemptsEnumerated += 1;
        throw new Error('attempts pathname must never be enumerated');
      }
      return fs.readdirSync(...args);
    }) as typeof fs.readdirSync,
  };
});

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('uses finite ledger starts and never enumerates a symlinked predecessor attempts pathname', async () => {
  const { verifiedSpecialistCheckpointResults } = await import('../src/dispatch/perkins-review/whole.js');
  const root = mkdtempSync(join(tmpdir(), 'gru-attempt-ancestor-'));
  roots.push(root);
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'blind-1.start.json'), JSON.stringify({ schemaVersion: 1, lens: 'blind', attempt: 1 }));
  mkdirSync(join(root, 'predecessor'));
  symlinkSync(outside, join(root, 'predecessor', 'attempts'));
  observed.attemptsEnumerated = 0;
  expect(verifiedSpecialistCheckpointResults(join(root, 'predecessor'), ['blind'], new Map(), ['blind-1'])).toEqual([]);
  expect(observed.attemptsEnumerated).toBe(0);
});
