import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { readBuildInfo, UNKNOWN_BUILD } from '../src/build-info.js';

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function rootWith(artifact: string | null): string {
  const root = mkdtempSync(join(tmpdir(), 'gru-command-build-info-'));
  cleanupDirs.push(root);
  if (artifact !== null) {
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'dist', 'build-rev.json'), artifact);
  }
  return root;
}

describe('build info — the running build stamp', () => {
  it('reads the build-time git stamp written by tools/write-build-rev.mjs', () => {
    const art = {
      rev: 'abc123'.repeat(7),
      committedAt: '2026-09-20T10:00:00.000Z',
      builtAt: '2026-09-20T10:05:00.000Z',
    };
    expect(readBuildInfo(rootWith(JSON.stringify(art)))).toEqual(art);
  });

  it('is all-null when the artifact is missing (build outside a checkout)', () => {
    expect(readBuildInfo(rootWith(null))).toEqual(UNKNOWN_BUILD);
  });

  it('is all-null on malformed JSON rather than guessing', () => {
    expect(readBuildInfo(rootWith('{ not json'))).toEqual(UNKNOWN_BUILD);
  });

  it('nulls wrong-typed fields instead of leaking junk into the board', () => {
    expect(
      readBuildInfo(rootWith(JSON.stringify({ rev: 42, committedAt: null, builtAt: '' }))),
    ).toEqual(UNKNOWN_BUILD);
  });

  it('a null rev with timestamps still parses (artifact from a non-git build)', () => {
    const parsed = readBuildInfo(rootWith(JSON.stringify({ rev: null, committedAt: null, builtAt: '2026-09-20T10:05:00.000Z' })));
    expect(parsed).toEqual({ rev: null, committedAt: null, builtAt: '2026-09-20T10:05:00.000Z' });
  });
});
