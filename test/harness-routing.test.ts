import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runOwnedCommand } from './helpers/harness-diagnostics.mjs';

/**
 * Runtime routing guard (classified process-heavy: it spawns real Vitest
 * collection children as its critical path). Proves the fast/heavy phases
 * actually select disjoint file sets whose union is every on-disk test file
 * — a narrowed include or a dropped phase cannot ship green — and bounds
 * any stalled listing under its own deadline instead of blocking the
 * worker past the classified ceiling.
 */

const repoRoot = join(import.meta.dirname, '..');
const VITEST_BIN = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');

async function listConfig(config: string): Promise<string[]> {
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')),
  );
  const result = await runOwnedCommand(
    process.execPath,
    [VITEST_BIN, 'list', '--config', config, '--filesOnly', '--json'],
    {
      label: `vitest list --config ${config}`,
      deadlineMs: 90_000,
      cwd: repoRoot,
      env: { ...childEnv, CI: 'true' },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  // The phase config prints its budget banner first; take the JSON body.
  const jsonStart = result.stdout.indexOf('\n[');
  expect(jsonStart, result.stdout.slice(0, 400)).toBeGreaterThanOrEqual(0);
  const entries = JSON.parse(result.stdout.slice(jsonStart).trim()) as Array<{ file: string }>;
  return entries
    .map((entry) => {
      const path = entry.file.startsWith('file://') ? fileURLToPath(entry.file) : entry.file;
      return relative(repoRoot, path).split('\\').join('/');
    })
    .sort();
}

describe('phase routing at runtime', () => {
  it('selects every on-disk test file exactly once across the two phases', async () => {
    const fast = await listConfig('vitest.config.ts');
    const heavy = await listConfig('vitest.heavy.config.ts');
    const onDisk = readdirSync(join(repoRoot, 'test'), { recursive: true })
      .map((name) => String(name).split('\\').join('/'))
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => `test/${name}`)
      .sort();
    expect(fast.length).toBeGreaterThan(0);
    expect(heavy.length).toBeGreaterThan(0);
    expect(fast.filter((file) => heavy.includes(file)), 'a file runs in both phases').toEqual([]);
    expect([...fast, ...heavy].sort(), 'the phase union must equal the on-disk test files').toEqual(onDisk);
  });

  it('keeps the full npm chain running both phases and the web suite', () => {
    const scripts = (
      JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    expect(scripts['test']).toContain('test:backend');
    expect(scripts['test']).toContain('test:backend:heavy');
    expect(scripts['test']).toContain('test:web');
  });

  it('bounds a stalled listing under its own deadline and reaps it (Perkins r1)', async () => {
    const started = Date.now();
    await expect(
      runOwnedCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        label: 'stalled listing',
        deadlineMs: 300,
      }),
    ).rejects.toThrow(/stalled listing exceeded its 300ms deadline/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
