import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PUBLIC_REVIEW_EXECUTABLE_PATHS } from '../src/runtime/review-executable-paths.js';

/**
 * GH350 compiled-output closure accounting: every new property/cli source
 * module must be an exact entry in the finite executable-path catalog
 * (reviewRuntimeVersion refuses unknown dist outputs — 'unproven
 * executable path'; precedent fb636196), and no catalog entry may outlive
 * its source (stale-entry guard complementing tools/prune-stale-dist.mjs).
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function sourceFilesUnder(relativeDir: string): string[] {
  const absolute = join(root, relativeDir);
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(relative(root, path));
    }
  };
  walk(absolute);
  return found;
}

const PROPERTY_SOURCE_DIR = 'src/property';

describe('GH350 dist catalog closure', () => {
  it('registers every property/cli source module as an exact dist catalog entry', () => {
    const sources = sourceFilesUnder(PROPERTY_SOURCE_DIR);
    sources.push('src/cli/property-report.ts');
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) {
      const output = `dist/${source.replace(/^src\//u, '').replace(/\.ts$/u, '')}.js`;
      expect(PUBLIC_REVIEW_EXECUTABLE_PATHS.has(output), `${output} must be registered (unproven executable path refusal otherwise)`).toBe(true);
    }
  });

  it('keeps no property/cli catalog entry without a corresponding source', () => {
    const stale = [...PUBLIC_REVIEW_EXECUTABLE_PATHS].filter((entry) => {
      if (!entry.startsWith('dist/property/') && entry !== 'dist/cli/property-report.js') return false;
      const sourcePath = entry.replace(/^dist\//u, 'src/').replace(/\.js$/u, '.ts');
      try {
        statSync(join(root, sourcePath));
        return false;
      } catch {
        return true;
      }
    });
    expect(stale, `stale catalog entries without sources: ${stale.join(', ')}`).toEqual([]);
  });

  it('covers the shared contract and the pilot adapter modules explicitly', () => {
    for (const output of [
      'dist/property/types.js',
      'dist/property/resolve.js',
      'dist/property/adapters/matrix.js',
      'dist/property/adapters/vitest-fast-check.js',
      'dist/cli/property-report.js',
    ]) {
      expect(PUBLIC_REVIEW_EXECUTABLE_PATHS.has(output)).toBe(true);
    }
  });
});
