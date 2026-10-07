import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * tools/prune-stale-dist.mjs contract. `tsc` never deletes outputs of a
 * removed source, and `gru-service roll` rebuilds the deploy clone in place
 * (no clean), so a deleted module's dist/*.js survived every roll until the
 * Perkins runtime fingerprint refused it as "an unproven executable path"
 * (owner incident 2026-10-07: dist/dispatch/perkins-review/hybrid.js). The
 * build must prune exactly those orphans — never a live output, never a
 * build-written extra, never through a symlink — and fail loud without dist/.
 */

const repoRoot = resolve(import.meta.dirname, '..');
const TOOL = join(repoRoot, 'tools', 'prune-stale-dist.mjs');

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-prune-stale-dist-'));
  created.push(dir);
  return dir;
}

function touch(root: string, path: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, `// ${path}\n`);
}

function runTool(root: string) {
  return spawnSync(process.execPath, [TOOL, root], { encoding: 'utf-8' });
}

describe('prune-stale-dist', () => {
  it('removes every tsc output whose source is gone, and the directories it empties', () => {
    const root = fixtureRoot();
    touch(root, 'src/main.ts');
    for (const output of ['main.js', 'main.js.map', 'main.d.ts']) touch(root, `dist/${output}`);
    for (const output of ['hybrid.js', 'hybrid.js.map', 'hybrid.d.ts']) {
      touch(root, `dist/dispatch/perkins-review/${output}`);
    }
    touch(root, 'dist/retired/old.js');

    const result = runTool(root);

    expect(result.status, result.stderr).toBe(0);
    for (const output of ['hybrid.js', 'hybrid.js.map', 'hybrid.d.ts']) {
      expect(existsSync(join(root, 'dist/dispatch/perkins-review', output))).toBe(false);
      expect(result.stdout).toContain(
        `removed dist/dispatch/perkins-review/${output} (src/dispatch/perkins-review/hybrid.ts no longer exists)`,
      );
    }
    expect(existsSync(join(root, 'dist/dispatch'))).toBe(false);
    expect(existsSync(join(root, 'dist/retired'))).toBe(false);
    expect(result.stdout).toContain('removed 4 stale output(s)');
  });

  it('keeps live outputs and the files the build writes itself', () => {
    const root = fixtureRoot();
    touch(root, 'src/runtime/review-build-identity.ts');
    touch(root, 'src/runtime/review-mcp-server.mjs');
    const kept = [
      'dist/runtime/review-build-identity.js',
      'dist/runtime/review-build-identity.js.map',
      'dist/runtime/review-build-identity.d.ts',
      'dist/runtime/review-mcp-server.mjs',
      'dist/build-rev.json',
      'dist/review-dependency-identity.json',
    ];
    for (const path of kept) touch(root, path);

    const result = runTool(root);

    expect(result.status, result.stderr).toBe(0);
    for (const path of kept) expect(existsSync(join(root, path)), path).toBe(true);
    expect(result.stdout).toBe('');
  });

  it('never follows or removes a symlink inside dist', () => {
    const root = fixtureRoot();
    const outside = fixtureRoot();
    touch(outside, 'victim.js');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    symlinkSync(outside, join(root, 'dist', 'linked-dir'), 'dir');
    symlinkSync(join(outside, 'victim.js'), join(root, 'dist', 'linked.js'));

    const result = runTool(root);

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(outside, 'victim.js'))).toBe(true);
    expect(existsSync(join(root, 'dist', 'linked-dir'))).toBe(true);
    expect(existsSync(join(root, 'dist', 'linked.js'))).toBe(true);
  });

  it('fails loud when dist or src is missing', () => {
    const noDist = fixtureRoot();
    mkdirSync(join(noDist, 'src'));
    const distResult = runTool(noDist);
    expect(distResult.status).toBe(1);
    expect(distResult.stderr).toContain('is not a directory — run tsc before pruning');

    const noSrc = fixtureRoot();
    touch(noSrc, 'dist/main.js');
    const srcResult = runTool(noSrc);
    expect(srcResult.status).toBe(1);
    expect(srcResult.stderr).toContain('refusing to prune without sources');
    expect(existsSync(join(noSrc, 'dist/main.js'))).toBe(true);
  });

  it('runs in the build right after tsc, before any step that reads dist', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    const steps = pkg.scripts.build!.split(' && ');
    expect(steps[0]).toBe('tsc');
    expect(steps[1]).toBe('node tools/prune-stale-dist.mjs .');
  });
});
