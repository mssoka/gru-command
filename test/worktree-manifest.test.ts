import { describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyWorktreeManifest,
  loadWorktreeManifest,
  MANIFEST_PATH,
  parseWorktreeManifest,
  resolveVerifyCommand,
} from '../src/worktrees/manifest.js';
import { makeFixtureRepo } from './helpers/fixture-repo.js';

/**
 * Bootstrap manifest (SPEC ruling 18a): `<repo>/.gru-command/worktree.toml`
 * — parse fail-loud, apply links/copies/setup to a fresh worktree.
 */

function manifestFile(repoPath: string): string {
  return join(repoPath, MANIFEST_PATH);
}

describe('worktree bootstrap manifest (E8, ruling 18a)', () => {
  it('parses links, copies, and setup commands', () => {
    const manifest = parseWorktreeManifest(
      [
        '[[link]]',
        'at = "_bmad"',
        'to = "_bmad"',
        '[[link]]',
        'at = ".agents/skills"',
        'to = ".agents/skills"',
        '[[copy]]',
        'from = ".env.local"',
        'to = ".env.local"',
        '[[setup]]',
        'command = "npm install"',
      ].join('\n'),
    );
    expect(manifest.links).toHaveLength(2);
    expect(manifest.copies).toHaveLength(1);
    expect(manifest.setup[0]?.command).toBe('npm install');
  });

  it('rejects malformed manifests loudly', () => {
    expect(() => parseWorktreeManifest('not toml [')).toThrowError(/valid TOML/);
    expect(() => parseWorktreeManifest('[[link]]\nat = ""\nto = "x"')).toThrowError(/non-empty/);
    expect(() => parseWorktreeManifest('[[copy]]\nfrom = "../escape"\nto = "x"')).toThrowError(/no \.\./);
    expect(() => parseWorktreeManifest('[[copy]]\nfrom = "a"\nto = "/abs"')).toThrowError(/relative/);
    expect(() => parseWorktreeManifest('[[link]]\nat = "../up"\nto = "x"')).toThrowError(/no \.\./);
    expect(() => parseWorktreeManifest('unknown_key = 1')).toThrowError(/unknown key/);
  });

  it('parses [verify] scopes and resolves them fail-loud', () => {
    const manifest = parseWorktreeManifest(
      ['[verify]', 'full = "npm test"', 'quick = "npm run lint"'].join('\n'),
    );
    expect(manifest.verify).toEqual({ full: 'npm test', quick: 'npm run lint' });
    expect(parseWorktreeManifest('').verify).toEqual({});
    expect(resolveVerifyCommand(manifest, 'quick')).toBe('npm run lint');
    expect(() => resolveVerifyCommand(manifest, 'nope')).toThrowError(/declared scopes: full, quick/);
    expect(() => parseWorktreeManifest('[verify]\nFull = "x"')).toThrowError(/lowercase identifier/);
    expect(() => parseWorktreeManifest('[verify]\nfull = ""')).toThrowError(/non-empty/);
    expect(() => parseWorktreeManifest('[verify]\nfull = 3')).toThrowError(/non-empty/);
    expect(() => parseWorktreeManifest('[verify]\nfull = ["x"]')).toThrowError(/non-empty/);
  });

  it('is a no-op warn when the repo ships no manifest', () => {
    const repo = makeFixtureRepo('fixture-bare');
    try {
      expect(loadWorktreeManifest(repo.path)).toBeNull();
    } finally {
      repo.cleanup();
    }
  });

  it('applies links, copies, and setup commands to a fresh worktree', async () => {
    const repo = makeFixtureRepo('fixture-manifest');
    try {
      // Source-checkout state the fresh worktree will need.
      mkdirSync(join(repo.path, '_bmad'), { recursive: true });
      writeFileSync(join(repo.path, '_bmad', 'marker.txt'), 'shared knowledge');
      writeFileSync(join(repo.path, '.env.local'), 'TOKEN=fixture\n');
      mkdirSync(join(repo.path, '.gru-command'), { recursive: true });
      writeFileSync(
        manifestFile(repo.path),
        [
          '[[link]]',
          'at = "_bmad"',
          'to = "_bmad"',
          '[[copy]]',
          'from = ".env.local"',
          'to = ".env.local"',
          '[[setup]]',
          'command = "echo bootstrapped > .gru-bootstrap-marker"',
        ].join('\n'),
      );

      const worktreePath = join(repo.path, '..', 'fixture-manifest-wt');
      repo.git(['worktree', 'add', worktreePath, 'HEAD']);

      const manifest = loadWorktreeManifest(repo.path);
      expect(manifest).not.toBeNull();
      await applyWorktreeManifest(manifest!, {
        sourceRoot: repo.path,
        worktreePath,
        setupTimeoutMs: 30_000,
      });

      // Link: symlink into the source checkout (shared knowledge, one copy).
      const linkInfo = lstatSync(join(worktreePath, '_bmad'));
      expect(linkInfo.isSymbolicLink()).toBe(true);
      expect(readFileSync(join(worktreePath, '_bmad', 'marker.txt'), 'utf-8')).toBe('shared knowledge');

      // Copy: file materialized in the worktree.
      expect(readFileSync(join(worktreePath, '.env.local'), 'utf-8')).toBe('TOKEN=fixture\n');

      // Setup: one-time command ran with cwd = the worktree.
      expect(existsSync(join(worktreePath, '.gru-bootstrap-marker'))).toBe(true);

      repo.git(['worktree', 'remove', '--force', worktreePath]);
    } finally {
      repo.cleanup();
    }
  });

  it('fails loud when a setup command exits non-zero (never half-bootstrapped)', async () => {
    const repo = makeFixtureRepo('fixture-setupfail');
    try {
      mkdirSync(join(repo.path, '.gru-command'), { recursive: true });
      writeFileSync(manifestFile(repo.path), '[[setup]]\ncommand = "exit 3"');
      const manifest = loadWorktreeManifest(repo.path);
      expect(manifest).not.toBeNull();
      const worktreePath = join(repo.path, '..', 'fixture-setupfail-wt');
      repo.git(['worktree', 'add', worktreePath, 'HEAD']);
      await expect(
        applyWorktreeManifest(manifest!, {
          sourceRoot: repo.path,
          worktreePath,
          setupTimeoutMs: 30_000,
        }),
      ).rejects.toThrowError(/exited 3/);
      repo.git(['worktree', 'remove', '--force', worktreePath]);
    } finally {
      repo.cleanup();
    }
  });

  it('keeps the event loop responsive while a setup command sleeps past its timeout', async () => {
    const repo = makeFixtureRepo('fixture-slowsetup');
    try {
      mkdirSync(join(repo.path, '.gru-command'), { recursive: true });
      writeFileSync(
        manifestFile(repo.path),
        '[[setup]]\ncommand = "echo $$ > .setup-pid; sleep 30"',
      );
      const manifest = loadWorktreeManifest(repo.path);
      expect(manifest).not.toBeNull();
      const worktreePath = join(repo.path, '..', 'fixture-slowsetup-wt');
      repo.git(['worktree', 'add', worktreePath, 'HEAD']);

      // The command sleeps far past the 1s timeout. If setup blocked the
      // event loop (spawnSync), this 50ms timer could not land until the
      // timeout completed; it must fire while setup is still running.
      const started = Date.now();
      const applied = applyWorktreeManifest(manifest!, {
        sourceRoot: repo.path,
        worktreePath,
        setupTimeoutMs: 1_000,
      });
      const timerFiredAfterMs = await new Promise<number>((resolve) => {
        setTimeout(() => resolve(Date.now() - started), 50);
      });
      expect(timerFiredAfterMs).toBeLessThan(500);

      await expect(applied).rejects.toThrowError(/timed out after 1000ms/);

      // The timeout killed the whole setup tree — the sleeping pid is gone.
      const pid = Number(readFileSync(join(worktreePath, '.setup-pid'), 'utf-8').trim());
      expect(Number.isInteger(pid)).toBe(true);
      await vi.waitFor(() => {
        expect(() => process.kill(pid, 0)).toThrow();
      });
      repo.git(['worktree', 'remove', '--force', worktreePath]);
    } finally {
      repo.cleanup();
    }
  });

  it('refuses to overwrite anything already present in the worktree', async () => {
    const repo = makeFixtureRepo('fixture-clash');
    try {
      writeFileSync(join(repo.path, '.env.local'), 'TOKEN=fixture\n');
      mkdirSync(join(repo.path, '.gru-command'), { recursive: true });
      writeFileSync(manifestFile(repo.path), '[[copy]]\nfrom = ".env.local"\nto = ".env.local"');
      const worktreePath = join(repo.path, '..', 'fixture-clash-wt');
      repo.git(['worktree', 'add', worktreePath, 'HEAD']);
      // The tracked checkout already has a committed .env.local? It does not —
      // create a collision via a second copy target that exists.
      writeFileSync(join(worktreePath, 'README.md'), 'present');
      const manifest = parseWorktreeManifest(
        '[[copy]]\nfrom = ".env.local"\nto = "README.md"',
      );
      await expect(
        applyWorktreeManifest(manifest, { sourceRoot: repo.path, worktreePath, setupTimeoutMs: 30_000 }),
      ).rejects.toThrowError(/already exists/);
      repo.git(['worktree', 'remove', '--force', worktreePath]);
    } finally {
      repo.cleanup();
    }
  });
});
