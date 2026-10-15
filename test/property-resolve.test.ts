import fs, { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { resolvePropertyCapabilities, ResolutionWalkError } from '../src/property/resolve.js';

/**
 * GH350 capability resolution (issue §1): deterministic fixture trees for
 * single-language, multi-package and polyglot repositories, ambiguous and
 * missing tooling, per-package scoping, and invalidation keys.
 */

const roots: string[] = [];
const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'gh350-resolve-'));
  roots.push(root);
  return root;
};
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function nodePackage(dir: string, options: {
  readonly vitest?: string;
  readonly fastCheck?: string;
  readonly scripts?: Record<string, string>;
} = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      ...(options.vitest === undefined ? {} : { devDependencies: { vitest: options.vitest } }),
      ...(options.fastCheck === undefined ? {} : { devDependencies: { ...(options.vitest === undefined ? {} : { vitest: options.vitest }), 'fast-check': options.fastCheck } }),
      ...(options.scripts === undefined ? {} : { scripts: options.scripts }),
    }),
  );
}

function packageLock(dir: string, vitest: string, fastCheck: string): void {
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/vitest': { version: vitest }, 'node_modules/fast-check': { version: fastCheck } } }),
  );
}

function installModules(dir: string, vitestVersion = '3.2.7', fastCheckVersion = '3.23.2'): void {
  mkdirSync(join(dir, 'node_modules', 'vitest'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'vitest', 'package.json'), JSON.stringify({ name: 'vitest', version: vitestVersion }));
  mkdirSync(join(dir, 'node_modules', 'fast-check'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'fast-check', 'package.json'), JSON.stringify({ name: 'fast-check', version: fastCheckVersion }));
  mkdirSync(join(dir, 'node_modules', 'vitest', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'node_modules', 'vitest', 'dist', 'cli.mjs'), '#!/usr/bin/env node\n');
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  symlinkSync('../vitest/dist/cli.mjs', join(dir, 'node_modules', '.bin', 'vitest'));
}

describe('GH350 capability resolution', () => {
  it('resolves a fully proven single package (declared+locked+installed+runnable)', () => {
    const root = makeRoot();
    nodePackage(root, { vitest: '^3.2.7', fastCheck: '^3.23.2' });
    packageLock(root, '3.2.7', '3.23.2');
    installModules(root);
    const report = resolvePropertyCapabilities({ repoRoot: root });
    expect(report.packages).toHaveLength(1);
    const row = report.packages[0]!;
    expect(row.status).toBe('resolved');
    expect(row.adapterId).toBe('vitest-fast-check');
    expect(row.tooling?.runner).toBe('runnable');
    expect(row.tooling?.libraries['fast-check']).toBe('installed');
    expect(row.tooling?.executable).toBe(true);
  });

  it('resolves a locked-but-not-installed package as a NON-executable planning candidate', () => {
    const root = makeRoot();
    nodePackage(root, { vitest: '^3.2.7', fastCheck: '^3.23.2' });
    packageLock(root, '3.2.7', '3.23.2');
    const report = resolvePropertyCapabilities({ repoRoot: root });
    const row = report.packages[0]!;
    expect(row.status).toBe('resolved');
    expect(row.tooling?.executable).toBe(false);
    expect(row.tooling?.runner).toBe('locked');
    expect(row.reasons.join(' ')).toContain('lockfile proves locked dependencies only');
  });

  it('marks declared-only packages ambiguous, naming the unproven dependency', () => {
    const root = makeRoot();
    nodePackage(root, { vitest: '^3.2.7', fastCheck: '^3.23.2' });
    const report = resolvePropertyCapabilities({ repoRoot: root });
    const row = report.packages[0]!;
    expect(row.status).toBe('ambiguous');
    expect(row.reasons.join(' ')).toContain('install state unverified');
  });

  it('resolves monorepo packages independently (missing fast-check reported per package)', () => {
    const root = makeRoot();
    nodePackage(join(root, 'packages', 'a'), { vitest: '^3.2.7', fastCheck: '^3.23.2' });
    nodePackage(join(root, 'packages', 'b'), { vitest: '^3.2.7' });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
    const report = resolvePropertyCapabilities({ repoRoot: root });
    const byDir = new Map(report.packages.map((row) => [row.packageDir, row]));
    expect(byDir.get('packages/b')?.status).toBe('missing-dependency');
    expect(byDir.get('packages/b')?.reasons.join(' ')).toContain('fast-check is not declared');
    expect(byDir.get('packages/a')?.status).toBe('ambiguous');
    expect(byDir.get('.')?.status).toBe('missing-dependency');
  });

  it('resolves polyglot repositories per package without root-manifest bleed', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'go.mod'), 'module example.com/root\n\ngo 1.22\n');
    nodePackage(join(root, 'web'), { vitest: '^3.2.7', fastCheck: '^3.23.2' });
    packageLock(join(root, 'web'), '3.2.7', '3.23.2');
    const report = resolvePropertyCapabilities({ repoRoot: root });
    const byDir = new Map(report.packages.map((row) => [row.packageDir, row]));
    expect(byDir.get('.')?.ecosystem).toBe('go');
    expect(byDir.get('.')?.status).toBe('unsupported-ecosystem');
    expect(byDir.get('.')?.reasons.join(' ')).toContain('go-native-fuzz');
    expect(byDir.get('web')?.ecosystem).toBe('node-typescript');
  });

  it('reports unsupported ecosystems through the matrix row', () => {
    const root = makeRoot();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.1.0"\n');
    const report = resolvePropertyCapabilities({ repoRoot: root });
    const row = report.packages[0]!;
    expect(row.status).toBe('unsupported-ecosystem');
    expect(row.reasons.join(' ')).toContain('proptest-cargo');
  });

  it('reports an explicit no-tooling row for a repository without manifests', () => {
    const root = makeRoot();
    writeFileSync(join(root, 'README.md'), 'no manifests here\n');
    const report = resolvePropertyCapabilities({ repoRoot: root });
    expect(report.packages).toHaveLength(1);
    expect(report.packages[0]!.status).toBe('no-tooling');
    expect(report.packages[0]!.ecosystem).toBeNull();
  });

  it('isolates a malformed manifest to its own invalid-manifest row', () => {
    const root = makeRoot();
    nodePackage(join(root, 'good'), { vitest: '^3.2.7', fastCheck: '^3.23.2' });
    packageLock(join(root, 'good'), '3.2.7', '3.23.2');
    mkdirSync(join(root, 'bad'), { recursive: true });
    writeFileSync(join(root, 'bad', 'package.json'), '{ not json');
    const report = resolvePropertyCapabilities({ repoRoot: root });
    const byDir = new Map(report.packages.map((row) => [row.packageDir, row]));
    expect(byDir.get('bad')?.status).toBe('invalid-manifest');
    expect(byDir.get('bad')?.reasons[0]).toContain('malformed JSON');
    expect(byDir.get('good')?.status).toBe('resolved');
  });

  it('marks out-of-tested-range versions ambiguous with the range reason', () => {
    const root = makeRoot();
    nodePackage(root, { vitest: '^4.0.0', fastCheck: '^3.23.2' });
    packageLock(root, '4.0.0', '3.23.2');
    const report = resolvePropertyCapabilities({ repoRoot: root });
    const row = report.packages[0]!;
    expect(row.status).toBe('ambiguous');
    expect(row.reasons.join(' ')).toContain("outside the adapter's tested range");
  });

  it('scopes resolution to the affected package paths only', () => {
    const root = makeRoot();
    nodePackage(join(root, 'packages', 'a'), { vitest: '^3.2.7', fastCheck: '^3.23.2' });
    nodePackage(join(root, 'packages', 'b'), { vitest: '^3.2.7', fastCheck: '^3.23.2' });
    const report = resolvePropertyCapabilities({ repoRoot: root, scopePaths: ['packages/a/src/index.ts'] });
    expect(report.scoped).toBe(true);
    expect(report.packages.map((row) => row.packageDir)).toEqual(['packages/a']);
  });

  it('changes the resolution key when a contributing file byte changes', () => {
    const root = makeRoot();
    nodePackage(root, { vitest: '^3.2.7', fastCheck: '^3.23.2' });
    packageLock(root, '3.2.7', '3.23.2');
    const before = resolvePropertyCapabilities({ repoRoot: root }).packages[0]!.resolutionKey;
    packageLock(root, '3.2.8', '3.23.2');
    const after = resolvePropertyCapabilities({ repoRoot: root }).packages[0]!.resolutionKey;
    expect(before).not.toEqual(after);
  });

  it('is byte-reproducible across identical runs', () => {
    const root = makeRoot();
    nodePackage(root, { vitest: '^3.2.7', fastCheck: '^3.23.2' });
    packageLock(root, '3.2.7', '3.23.2');
    const first = resolvePropertyCapabilities({ repoRoot: root });
    const second = resolvePropertyCapabilities({ repoRoot: root });
    expect(JSON.stringify(first)).toEqual(JSON.stringify(second));
  });

  it('refuses an uncontained .bin runner symlink with the precise validation failure', () => {
    const outside = makeRoot();
    const root = makeRoot();
    nodePackage(root, { vitest: '^3.2.7', fastCheck: '^3.23.2' });
    packageLock(root, '3.2.7', '3.23.2');
    installModules(root);
    // Redirect the runner link to a target OUTSIDE the repository.
    rmSync(join(root, 'node_modules', '.bin', 'vitest'));
    writeFileSync(join(outside, 'impostor.mjs'), '#!/usr/bin/env node\n');
    symlinkSync(join(outside, 'impostor.mjs'), join(root, 'node_modules', '.bin', 'vitest'));
    const report = resolvePropertyCapabilities({ repoRoot: root });
    const row = report.packages[0]!;
    expect(row.status).toBe('resolved');
    expect(row.tooling?.executable).toBe(false);
    expect(row.tooling?.reasons.join(' ')).toContain('resolves outside the repository');
  });

  it('resolves ordinary root files and selects only the nearest nested package owner', () => {
    const root = makeRoot();
    nodePackage(root, { vitest: '^3.2.7', fastCheck: '^3.23.2' });
    nodePackage(join(root, 'packages/a'), { vitest: '^3.2.7', fastCheck: '^3.23.2' });
    expect(resolvePropertyCapabilities({ repoRoot: root, scopePaths: ['src/index.ts'] }).packages.map((row) => row.packageDir)).toEqual(['.']);
    expect(resolvePropertyCapabilities({ repoRoot: root, scopePaths: ['packages/a/src/index.ts'] }).packages.map((row) => row.packageDir)).toEqual(['packages/a']);
  });

  it('recognizes pnpm v9 importer proof without inventing installed tooling', () => {
    const root = makeRoot(); nodePackage(root, { vitest: '^3.2.7', fastCheck: '^3.23.2' });
    writeFileSync(join(root, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\nimporters:\n  .:\n    devDependencies:\n      vitest:\n        specifier: ^3.2.7\n        version: 3.2.7(@types/node@22.0.0)\n      fast-check:\n        specifier: ^3.23.2\n        version: 3.23.2\npackages:\n  vitest@3.2.7:\n    resolution: {integrity: synthetic}\n`);
    expect(resolvePropertyCapabilities({ repoRoot: root }).packages[0]).toMatchObject({ status: 'resolved', tooling: { runner: 'locked', libraries: { 'fast-check': 'locked' }, executable: false } });
  });

  it('recognizes quoted Yarn Berry selectors and colon version fields', () => {
    const root = makeRoot(); nodePackage(root, { vitest: '^3.2.7', fastCheck: '^3.23.2' });
    writeFileSync(join(root, 'yarn.lock'), `__metadata:\n  version: 8\n\n"vitest@npm:^3.2.7":\n  version: 3.2.7\n  resolution: "vitest@npm:3.2.7"\n\n"fast-check@npm:^3.23.2":\n  version: 3.23.2\n`);
    expect(resolvePropertyCapabilities({ repoRoot: root }).packages[0]).toMatchObject({ status: 'resolved', tooling: { runner: 'locked', executable: false } });
  });

  it('never borrows a Yarn version field from the following unrelated block', () => {
    const root = makeRoot(); nodePackage(root, { vitest: '^3.2.7', fastCheck: '^3.23.2' });
    writeFileSync(join(root, 'yarn.lock'), `vitest@^3.2.7:\n  resolution "incomplete"\n\nunrelated@^3.2.7:\n  version "3.2.7"\n\nfast-check@^3.23.2:\n  version "3.23.2"\n`);
    expect(resolvePropertyCapabilities({ repoRoot: root }).packages[0]?.tooling?.runner).not.toBe('locked');
  });

  it('uses a nested local lock instead of the root lock for unsupported nested versions', () => {
    const root = makeRoot(); nodePackage(root, { vitest: '^3.2.7', fastCheck: '^3.23.2' }); packageLock(root, '3.2.7', '3.23.2');
    const nested = join(root, 'packages/a'); nodePackage(nested, { vitest: '^4.0.0', fastCheck: '^3.23.2' }); packageLock(nested, '4.0.0', '3.23.2');
    const row = resolvePropertyCapabilities({ repoRoot: root, scopePaths: ['packages/a/src/index.ts'] }).packages[0]!;
    expect(row.status).toBe('ambiguous'); expect(row.reasons.join(' ')).toContain('vitest 4.0.0');
  });

  it('does not read installed metadata through an escaping node_modules parent alias', () => {
    const root = makeRoot(); const outside = makeRoot();
    nodePackage(root, { vitest: '^3.2.7', fastCheck: '^3.23.2' }); installModules(outside);
    symlinkSync(join(outside, 'node_modules'), join(root, 'node_modules'));
    const spy = vi.spyOn(fs, 'readFileSync'); syncBuiltinESMExports();
    try {
      resolvePropertyCapabilities({ repoRoot: root });
      expect(spy.mock.calls.some(([path]) => String(path).includes('/node_modules/vitest/package.json'))).toBe(false);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  });

  it('preflights worktree configuration size and file/parent aliases before parsing', () => {
    const outside = makeRoot(); mkdirSync(join(outside, '.gru-command')); writeFileSync(join(outside, '.gru-command/worktree.toml'), '[verify]\nfast="vitest run"\n');
    for (const variant of ['parent', 'file', 'oversized']) {
      const root = makeRoot(); nodePackage(root, { vitest: '^3.2.7', fastCheck: '^3.23.2' });
      if (variant === 'parent') symlinkSync(join(outside, '.gru-command'), join(root, '.gru-command'));
      else {
        mkdirSync(join(root, '.gru-command'));
        if (variant === 'file') symlinkSync(join(outside, '.gru-command/worktree.toml'), join(root, '.gru-command/worktree.toml'));
        else writeFileSync(join(root, '.gru-command/worktree.toml'), `#${'x'.repeat(2 * 1024 * 1024)}\n`);
      }
      expect(() => resolvePropertyCapabilities({ repoRoot: root })).toThrow(/ordinary|regular|exceeds/);
    }
  });

  it('invalidates resolution keys for contributing worktree config, runner bytes, mode and link text', () => {
    const root = makeRoot(); nodePackage(root, { vitest: '^3.2.7', fastCheck: '^3.23.2' }); installModules(root);
    const key = () => resolvePropertyCapabilities({ repoRoot: root }).packages[0]!.resolutionKey;
    const keys = [key()]; mkdirSync(join(root, '.gru-command')); writeFileSync(join(root, '.gru-command/worktree.toml'), '[verify]\nfast="vitest run"\n'); keys.push(key());
    const runner = join(root, 'node_modules/vitest/dist/cli.mjs'); writeFileSync(runner, '#!/usr/bin/env node\n// modified runner\n'); keys.push(key());
    chmodSync(runner, 0o700); keys.push(key());
    rmSync(join(root, 'node_modules/.bin/vitest')); symlinkSync('../vitest/./dist/cli.mjs', join(root, 'node_modules/.bin/vitest')); keys.push(key());
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('fails loud on a non-directory repository root', () => {
    const root = makeRoot();
    const file = join(root, 'not-a-repo.txt');
    writeFileSync(file, 'x');
    expect(() => resolvePropertyCapabilities({ repoRoot: file })).toThrow(ResolutionWalkError);
  });
});
