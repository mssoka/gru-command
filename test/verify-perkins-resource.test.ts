import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Pins the Perkins-surface residue scan (tools/verify-perkins-resource.mjs):
 * injecting Jev markers into Perkins-owned compiled artifacts — INCLUDING
 * the .d.ts/.js.map siblings, which embed the same source text — must fail
 * the verifier. Dropping the sibling entries from PRODUCT_SCAN_ENTRIES turns
 * these RED; the shipped build gate alone cannot catch that (it only runs
 * whatever list ships).
 */
const repoRoot = join(import.meta.dirname, '..');
const verifier = join(repoRoot, 'tools', 'verify-perkins-resource.mjs');

const cleanups: string[] = [];
afterAll(() => {
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

function sandboxRoot(): string {
  const distPolicy = join(repoRoot, 'dist', 'dispatch', 'perkins-review', 'policy.js');
  expect(
    existsSync(distPolicy),
    'dist build missing — run npm run build first (the verifier pins compiled artifacts)',
  ).toBe(true);
  const root = mkdtempSync(join(tmpdir(), 'gru-verifier-'));
  cleanups.push(root);
  cpSync(join(repoRoot, 'dist'), join(root, 'dist'), { recursive: true });
  cpSync(join(repoRoot, 'resources'), join(root, 'resources'), { recursive: true });
  cpSync(join(repoRoot, 'roles'), join(root, 'roles'), { recursive: true });
  return root;
}

function runVerifier(root: string): { status: number; output: string } {
  const run = spawnSync(process.execPath, [verifier, root], { encoding: 'utf8' });
  return { status: run.status ?? -1, output: `${run.stdout}${run.stderr}` };
}

describe('perkins residue verifier — sibling artifacts are scanned', () => {
  it('a clean product root passes (baseline for the residue injections)', () => {
    expect(runVerifier(sandboxRoot()).status).toBe(0);
  });

  it('jev residue in the perkins .js.map sibling fails closed', () => {
    const root = sandboxRoot();
    appendFileSync(join(root, 'dist', 'dispatch', 'perkins.js.map'), '\n// jev residue canary\n');
    const run = runVerifier(root);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('excluded product residue');
  });

  it('jev residue in the perkins .d.ts sibling fails closed', () => {
    const root = sandboxRoot();
    appendFileSync(join(root, 'dist', 'dispatch', 'perkins.d.ts'), '\n// jev residue canary\n');
    const run = runVerifier(root);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain('excluded product residue');
  });
});
