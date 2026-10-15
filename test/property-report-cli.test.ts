import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseArgs, runPropertyReport } from '../src/cli/property-report.js';

/**
 * GH350 property-report CLI: in-process tests (yield-report pattern — no
 * compiled-binary spawn). Statuses are honest data: exit 0 whenever the
 * report completed, 2 usage, 1 operational failure.
 */

const roots: string[] = [];
const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'gh350-cli-'));
  roots.push(root);
  return root;
};
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('GH350 property-report CLI', () => {
  it('parses a repository path, scope list and --json', () => {
    expect(parseArgs(['/repo', '--json'])).toEqual({ repo: '/repo', scope: null, json: true });
    expect(parseArgs(['/repo', '--scope', 'a,b'])).toEqual({ repo: '/repo', scope: ['a', 'b'], json: false });
  });

  it('rejects usage errors with exit code 2', async () => {
    await expect(runPropertyReport([])).resolves.toMatchObject({ exitCode: 2 });
    await expect(runPropertyReport(['/repo', '--wat'])).resolves.toMatchObject({ exitCode: 2 });
    await expect(runPropertyReport(['/repo', '--scope'])).resolves.toMatchObject({ exitCode: 2 });
    await expect(runPropertyReport(['/a', '/b'])).resolves.toMatchObject({ exitCode: 2 });
  });

  it('reports an empty repository as an honest no-tooling JSON row (exit 0)', async () => {
    const root = makeRoot();
    writeFileSync(join(root, 'README.md'), 'x');
    const run = await runPropertyReport([root, '--json']);
    expect(run.exitCode).toBe(0);
    const parsed = JSON.parse(run.stdout) as { packages: { status: string }[] };
    expect(parsed.packages[0]!.status).toBe('no-tooling');
  });

  it('renders explicit ambiguity for declared-only tooling', async () => {
    const root = makeRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fixture', devDependencies: { vitest: '^3.2.7', 'fast-check': '^3.23.2' } }),
    );
    const run = await runPropertyReport([root]);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('status: ambiguous');
    expect(run.stdout).toContain('install state unverified');
  });

  it('reports operational failures with exit code 1 and a named error', async () => {
    const run = await runPropertyReport([join(makeRoot(), 'does-not-exist')]);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain('operational failure');
  });

  it('supports scoped resolution through the CLI surface', async () => {
    const root = makeRoot();
    mkdirSync(join(root, 'packages', 'a'), { recursive: true });
    mkdirSync(join(root, 'packages', 'b'), { recursive: true });
    writeFileSync(join(root, 'packages', 'a', 'package.json'), JSON.stringify({ name: 'a', devDependencies: { vitest: '^3.2.7', 'fast-check': '^3.23.2' } }));
    writeFileSync(join(root, 'packages', 'b', 'package.json'), JSON.stringify({ name: 'b', devDependencies: { vitest: '^3.2.7' } }));
    const run = await runPropertyReport([root, '--scope', 'packages/b', '--json']);
    expect(run.exitCode).toBe(0);
    const parsed = JSON.parse(run.stdout) as { scoped: boolean; packages: { packageDir: string; status: string }[] };
    expect(parsed.scoped).toBe(true);
    expect(parsed.packages).toHaveLength(1);
    expect(parsed.packages[0]!.status).toBe('missing-dependency');
  });
});
