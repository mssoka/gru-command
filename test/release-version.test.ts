import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * A release tag and package.json must agree: `/health`, `gru-service
 * version`, and the board's deploy chip all read package.json, so a tag
 * that names a different version makes every update message lie.
 */

const SCRIPT = join(process.cwd(), 'tools', 'verify-release-version.mjs');
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function packageWith(version: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-release-version-'));
  dirs.push(dir);
  const file = join(dir, 'package.json');
  writeFileSync(file, JSON.stringify({ name: 'gru-command', version }), 'utf-8');
  return file;
}

function run(args: readonly string[], env: NodeJS.ProcessEnv = {}): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, GITHUB_REF_NAME: '', ...env },
  });
}

describe('release tag ↔ package.json', () => {
  it('passes when the tag names the packaged version', () => {
    const pkg = packageWith('1.0.1');
    const result = run(['v1.0.1', '--package', pkg]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('release tag v1.0.1 matches package.json 1.0.1');
  });

  it('fails loudly on a mismatch and says how to fix it', () => {
    const pkg = packageWith('1.0.0');
    const result = run(['v1.0.1', '--package', pkg]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('release tag v1.0.1 does not match package.json 1.0.0');
    expect(result.stderr).toContain('bump package.json');
  });

  it('refuses a tag that is not a stable release (prerelease, backup tag)', () => {
    const pkg = packageWith('1.0.1');
    for (const tag of ['v1.0.1-rc1', 'backup-pre-rebase', 'release-1']) {
      const result = run([tag, '--package', pkg]);
      expect(result.status, tag).toBe(1);
      expect(result.stderr).toContain('not a stable release tag');
    }
  });

  it('reads GITHUB_REF_NAME when no tag is passed, and fails usage without one', () => {
    const pkg = packageWith('1.0.1');
    const fromEnv = run(['--package', pkg], { GITHUB_REF_NAME: 'v1.0.1' });
    expect(fromEnv.status).toBe(0);
    const missing = run(['--package', pkg]);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('missing tag');
  });

  it('rejects an unreadable or malformed package instead of assuming a match', () => {
    const result = run(['v1.0.1', '--package', '/definitely/not/here/package.json']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('cannot read package metadata');
  });
});
