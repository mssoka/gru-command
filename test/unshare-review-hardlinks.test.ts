import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * tools/unshare-review-hardlinks.mjs contract. esbuild's postinstall
 * hard-links its platform binary over `esbuild/bin/esbuild`, every `npm ci`
 * re-creates that link, and the Perkins runtime fingerprint refuses any
 * multiply-linked file — so a real install could never start a native
 * review (owner incident 2026-10-07). The root postinstall must leave every
 * node_modules file single-linked with identical bytes and mode, never touch
 * anything through a symlink, and fail loud without node_modules. Fixtures
 * use REAL hard links: the copy-built fixtures elsewhere hid this class.
 */

const repoRoot = resolve(import.meta.dirname, '..');
const TOOL = join(repoRoot, 'tools', 'unshare-review-hardlinks.mjs');
const PLATFORM = `${process.platform}-${process.arch}`;

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-unshare-hardlinks-'));
  created.push(dir);
  return dir;
}

function write(path: string, content: string, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode });
}

/** esbuild's postinstall optimization, reproduced exactly: the platform
 * binary is hard-linked over the package's bin/esbuild. */
function esbuildPair(modules: string): { readonly bin: string; readonly platform: string } {
  const platform = join(modules, '@esbuild', PLATFORM, 'bin', 'esbuild');
  const bin = join(modules, 'esbuild', 'bin', 'esbuild');
  write(platform, 'native esbuild bytes', 0o755);
  mkdirSync(dirname(bin), { recursive: true });
  linkSync(platform, bin);
  expect(statSync(bin).nlink).toBe(2);
  return { bin, platform };
}

function runTool(root: string) {
  return spawnSync(process.execPath, [TOOL, root], { encoding: 'utf-8' });
}

describe('unshare-review-hardlinks', () => {
  it('unshares esbuild-style hard links, top-level and nested, keeping bytes and mode', () => {
    const root = fixtureRoot();
    const top = esbuildPair(join(root, 'node_modules'));
    const nested = esbuildPair(
      join(root, 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules'),
    );

    const result = runTool(root);

    expect(result.status, result.stderr).toBe(0);
    for (const { bin, platform } of [top, nested]) {
      expect(statSync(bin).nlink).toBe(1);
      expect(statSync(platform).nlink).toBe(1);
      expect(statSync(bin).ino).not.toBe(statSync(platform).ino);
      expect(readFileSync(bin, 'utf-8')).toBe('native esbuild bytes');
      expect(readFileSync(platform, 'utf-8')).toBe('native esbuild bytes');
      expect(statSync(bin).mode & 0o777).toBe(0o755);
      expect(statSync(platform).mode & 0o777).toBe(0o755);
    }
    expect(result.stdout).toContain('(was 2 links)');
    expect(result.stdout).toContain('unshared 2 file(s)');
  });

  it('leaves single-linked files untouched and silent', () => {
    const root = fixtureRoot();
    const file = join(root, 'node_modules', 'plain', 'index.js');
    write(file, 'export {};\n');
    const before = statSync(file);

    const result = runTool(root);

    expect(result.status, result.stderr).toBe(0);
    expect(statSync(file).ino).toBe(before.ino);
    expect(result.stdout).toBe('');
  });

  it('never follows or replaces a symlink inside node_modules', () => {
    const root = fixtureRoot();
    const outside = fixtureRoot();
    const pair = esbuildPair(join(outside, 'node_modules'));
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    symlinkSync(join(outside, 'node_modules'), join(root, 'node_modules', 'linked-dir'), 'dir');
    symlinkSync(pair.bin, join(root, 'node_modules', 'linked-file'));

    const result = runTool(root);

    expect(result.status, result.stderr).toBe(0);
    expect(statSync(pair.bin).nlink).toBe(2);
    expect(statSync(pair.bin).ino).toBe(statSync(pair.platform).ino);
    expect(result.stdout).toBe('');
  });

  it('fails loud when node_modules is missing', () => {
    const root = fixtureRoot();
    const result = runTool(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('is not a directory — install dependencies first');
    expect(existsSync(join(root, 'node_modules'))).toBe(false);
  });

  it('runs as the root postinstall and ships in the package', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
      files: string[];
    };
    expect(pkg.scripts.postinstall).toBe('node tools/unshare-review-hardlinks.mjs');
    expect(pkg.files).toContain('tools/unshare-review-hardlinks.mjs');
  });
});
