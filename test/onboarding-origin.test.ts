import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { probeOriginManifest } from '../src/onboarding/origin-manifest.js';

/**
 * The origin manifest probe (#427): origin's live default branch, fetched
 * fresh, read for `.gru-command/worktree.toml`. Real repositories and real
 * bare origins; anything short of a verified answer is `unverified`.
 */

const cleanups: (() => void)[] = [];
afterAll(() => { for (const cleanup of cleanups.reverse()) cleanup(); });

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A checkout on `main` with a bare origin whose HEAD names `branch`. */
function checkout(opts: { readonly manifestOnOrigin: boolean; readonly branch?: string }): { readonly path: string; readonly origin: string } {
  const root = tempDir('gru-onboarding-origin-');
  const path = join(root, 'app');
  mkdirSync(path);
  git(path, 'init', '-q', '-b', 'main');
  writeFileSync(join(path, 'README.md'), '# app\n');
  git(path, 'add', '-A');
  git(path, 'commit', '-qm', 'seed');
  if (opts.manifestOnOrigin) {
    mkdirSync(join(path, '.gru-command'));
    writeFileSync(join(path, '.gru-command', 'worktree.toml'), '[verify]\nfull = "./check"\n');
    git(path, 'add', '-A');
    git(path, 'commit', '-qm', 'manifest');
  }
  const origin = join(root, 'app-origin.git');
  git(root, 'init', '-q', '--bare', '-b', opts.branch ?? 'main', origin);
  git(path, 'remote', 'add', 'origin', origin);
  git(path, 'push', '-q', 'origin', 'main');
  return { path, origin };
}

describe('origin manifest probe (#427)', () => {
  it('reads origin\'s live default branch: missing when its tree has no manifest, present when it does', async () => {
    const missing = checkout({ manifestOnOrigin: false });
    const probe = await probeOriginManifest(missing.path);
    expect(probe).toEqual({ state: 'missing', defaultBranch: 'main', headSha: git(missing.origin, 'rev-parse', 'refs/heads/main') });

    const present = checkout({ manifestOnOrigin: true });
    expect(await probeOriginManifest(present.path)).toMatchObject({ state: 'present', defaultBranch: 'main' });
  });

  it('answers about origin, not the checkout: a merged manifest the checkout never pulled is present, a local-only one is missing', async () => {
    const merged = checkout({ manifestOnOrigin: true });
    git(merged.path, 'reset', '-q', '--hard', 'HEAD~1');
    expect(await probeOriginManifest(merged.path)).toMatchObject({ state: 'present' });

    const local = checkout({ manifestOnOrigin: false });
    mkdirSync(join(local.path, '.gru-command'));
    writeFileSync(join(local.path, '.gru-command', 'worktree.toml'), '[verify]\nfull = "./check"\n');
    git(local.path, 'add', '-A');
    git(local.path, 'commit', '-qm', 'local only, never pushed');
    expect(await probeOriginManifest(local.path)).toMatchObject({ state: 'missing' });
  });

  it('touches only origin\'s remote-tracking ref: the working tree, index and local branches stay as they were', async () => {
    const repo = checkout({ manifestOnOrigin: true });
    git(repo.path, 'reset', '-q', '--hard', 'HEAD~1');
    git(repo.path, 'update-ref', '-d', 'refs/remotes/origin/main');
    writeFileSync(join(repo.path, 'README.md'), '# app, edited\n');
    const before = { head: git(repo.path, 'rev-parse', 'HEAD'), status: git(repo.path, 'status', '--porcelain'), branches: git(repo.path, 'branch', '--list') };
    await probeOriginManifest(repo.path);
    expect({ head: git(repo.path, 'rev-parse', 'HEAD'), status: git(repo.path, 'status', '--porcelain'), branches: git(repo.path, 'branch', '--list') }).toEqual(before);
    expect(readFileSync(join(repo.path, 'README.md'), 'utf8')).toBe('# app, edited\n');
    expect(git(repo.path, 'rev-parse', 'refs/remotes/origin/main')).toBe(git(repo.origin, 'rev-parse', 'refs/heads/main'));
  });

  it('an unreachable origin is unverified, never missing, and its reason is redacted', async () => {
    const repo = checkout({ manifestOnOrigin: false });
    const secretPath = join(tempDir('gru-onboarding-gone-'), 'ghp_abcdefghijklmnopqrstuvwx', 'app.git');
    git(repo.path, 'remote', 'set-url', 'origin', secretPath);
    const probe = await probeOriginManifest(repo.path);
    expect(probe.state).toBe('unverified');
    if (probe.state !== 'unverified') throw new Error('expected unverified');
    expect(probe.reason).toMatch(/^origin could not be read: /u);
    expect(probe.reason).toContain('[redacted]');
    expect(probe.reason).not.toContain('ghp_abcdefghijklmnopqrstuvwx');
  });

  it('a repository with no origin remote, or an origin naming no default branch, is unverified; a cached origin/HEAD is never the answer', async () => {
    const root = tempDir('gru-onboarding-none-');
    git(root, 'init', '-q', '-b', 'main');
    expect((await probeOriginManifest(root)).state).toBe('unverified');

    // Origin HEAD names a branch that does not exist, while the clone still
    // caches origin/HEAD → origin/main from before.
    const repo = checkout({ manifestOnOrigin: false, branch: 'trunk' });
    git(repo.path, 'fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main');
    git(repo.path, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    expect(await probeOriginManifest(repo.path)).toEqual({ state: 'unverified', reason: 'origin names no default branch (its HEAD carries no branch symref)' });
  });

  it('a hung origin is cut off at the deadline as unverified, and the abort signal ends it early', async () => {
    const repo = checkout({ manifestOnOrigin: false });
    git(repo.path, 'config', 'remote.origin.uploadpack', 'sleep 30; git-upload-pack');
    const started = Date.now();
    const timed = await probeOriginManifest(repo.path, { timeoutMs: 400 });
    expect(timed).toMatchObject({ state: 'unverified' });
    if (timed.state === 'unverified') expect(timed.reason).toContain('did not answer within the probe deadline');
    const stop = new AbortController();
    const aborted = probeOriginManifest(repo.path, { signal: stop.signal });
    setTimeout(() => stop.abort(), 100);
    expect((await aborted).state).toBe('unverified');
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('settles after the deadline even when a descendant that left git\'s process group still holds its pipes', async () => {
    const repo = checkout({ manifestOnOrigin: false });
    const marker = `gru-probe-escapee-${String(process.pid)}`;
    // A helper that leaves the group (so neither signal reaches it) and keeps
    // git's inherited stderr open for 20 s: 'close' cannot come before that.
    git(repo.path, 'config', 'remote.origin.uploadpack', `perl -e '$0="${marker}"; setpgrp(0,0); sleep 20' & sleep 30; git-upload-pack`);
    try {
      const started = Date.now();
      const probe = await probeOriginManifest(repo.path, { timeoutMs: 300 });
      expect(probe).toMatchObject({ state: 'unverified' });
      if (probe.state === 'unverified') expect(probe.reason).toContain('did not answer within the probe deadline');
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      try { execFileSync('pkill', ['-f', marker], { stdio: 'ignore' }); } catch { /* already gone */ }
    }
  });
});
