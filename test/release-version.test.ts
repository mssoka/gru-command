import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { VERSION } from '../src/version.js';

/**
 * A release tag and package.json must agree: `/health` and `gru-service
 * version` report the packaged version, so a tag that names a different
 * version makes every update message lie. The workflow also publishes the
 * release notes that tell operators WHAT changed.
 */

const SCRIPT = join(process.cwd(), 'tools', 'verify-release-version.mjs');
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function packageFile(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-release-version-'));
  dirs.push(dir);
  const file = join(dir, 'package.json');
  writeFileSync(file, JSON.stringify(value), 'utf-8');
  return file;
}

function packageWith(version: string): string {
  return packageFile({ name: 'gru-command', version });
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

  it('rejects a non-semver or missing package version', () => {
    for (const value of [{ version: '1.0.1-rc1' }, { version: '1.0' }, { version: 7 }, {}]) {
      const result = run(['v1.0.1', '--package', packageFile(value)]);
      expect(result.status, JSON.stringify(value)).toBe(1);
      expect(result.stderr).toContain('is not MAJOR.MINOR.PATCH');
    }
  });

  it('rejects leading-zero tags and versions (a v01.0.0 tag is not v1.0.0)', () => {
    const pkg = packageWith('1.0.1');
    expect(run(['v01.0.1', '--package', pkg]).status).toBe(1);
    expect(run(['v1.0.1', '--package', packageWith('01.0.1')]).status).toBe(1);
  });

  it('handles the usage branches without a false green', () => {
    expect(run(['--help']).status).toBe(0);
    expect(run(['--package']).status).toBe(2);
    expect(run(['--package']).stderr).toContain('--package requires a path');
    expect(run(['--nope']).status).toBe(2);
    expect(run(['--nope']).stderr).toContain('unknown option');
    expect(run(['v1.0.1', 'v1.0.2']).status).toBe(2);
  });

  it('accepts the exact tag-only invocation release.yml uses', () => {
    const result = run([`v${VERSION}`]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`release tag v${VERSION} matches package.json ${VERSION}`);
  });

  it('pins the release workflow: stable tags run this guard, then publish notes', () => {
    const workflow = readFileSync(join(process.cwd(), '.github', 'workflows', 'release.yml'), 'utf-8');
    expect(workflow).toContain("tags: ['v*']");
    expect(workflow).toContain('node tools/verify-release-version.mjs "$GITHUB_REF_NAME"');
    expect(workflow).toContain('stable=true');
    expect(workflow).toContain('gh release create "$GITHUB_REF_NAME" --verify-tag --generate-notes');
  });
});
