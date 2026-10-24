import { describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyWorktreeManifest,
  loadWorktreeManifest,
  MANIFEST_PATH,
  OutputTail,
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

  it('retired GC bootstrap refuses before links/copies/setup, while historical verification remains readable', async () => {
    const repo = makeFixtureRepo('fixture-retired-bootstrap');
    try {
      writeFileSync(join(repo.path, '.env.local'), 'private fixture\n');
      const manifest = parseWorktreeManifest([
        '[[copy]]', 'from = ".env.local"', 'to = ".env.local"',
        '# BEGIN GRU COMMAND BMAD BOOTSTRAP', '[[setup]]',
        'command = "node .gru-command/bmad-bootstrap.mjs"',
        '# END GRU COMMAND BMAD BOOTSTRAP', '[verify]', 'full = "npm test"',
      ].join('\n'));
      expect(resolveVerifyCommand(manifest, 'full')).toBe('npm test');
      const worktreePath = join(repo.path, '..', 'fixture-retired-bootstrap-wt');
      repo.git(['worktree', 'add', '--detach', worktreePath, 'HEAD']);
      await expect(applyWorktreeManifest(manifest, { sourceRoot: repo.path, worktreePath, setupTimeoutMs: 10_000 }))
        .rejects.toThrow(/retired GC-managed BMAD bootstrap.*docs\/BMAD-RUNTIME.md/u);
      expect(existsSync(join(worktreePath, '.env.local'))).toBe(false);
      expect(existsSync(join(worktreePath, '_bmad'))).toBe(false);
      repo.git(['worktree', 'remove', '--force', worktreePath]);
    } finally { repo.cleanup(); }
  });

  it('incomplete and edited GC marker blocks remain creation guards, not silently skipped commands', () => {
    for (const text of [
      '# BEGIN GRU COMMAND BMAD BOOTSTRAP\n[[setup]]\ncommand = "echo edited"',
      '# END GRU COMMAND BMAD BOOTSTRAP\n[[setup]]\ncommand = "echo user"',
      '#  BEGIN GRU COMMAND BMAD BOOTSTRAP\n[[setup]]\ncommand = "echo edited"\n#  END GRU COMMAND BMAD BOOTSTRAP',
      '#BEGIN\tGRU COMMAND BMAD BOOTSTRAP\n[[setup]]\ncommand = "echo edited"',
    ]) expect(parseWorktreeManifest(text).retiredGcBmadBootstrap).toBe(true);
  });

  it('foreign multiline setup strings may mention BMAD markers without becoming GC-owned blocks', () => {
    const foreign = "[[setup]]\ncommand = '''\n# BEGIN GRU COMMAND BMAD BOOTSTRAP\necho independent-BMAD\n# END GRU COMMAND BMAD BOOTSTRAP\n'''\n";
    expect(parseWorktreeManifest(foreign).retiredGcBmadBootstrap).toBeUndefined();
    expect(parseWorktreeManifest(foreign.replaceAll('# BEGIN', '#  BEGIN').replaceAll('# END', '#END')).retiredGcBmadBootstrap).toBeUndefined();
    expect(parseWorktreeManifest(`${foreign}# BEGIN GRU COMMAND BMAD BOOTSTRAP\n`).retiredGcBmadBootstrap).toBe(true);
  });

  it('rejects malformed manifests loudly', () => {
    expect(() => parseWorktreeManifest('not toml [')).toThrowError(/valid TOML/);
    expect(() => parseWorktreeManifest('[[link]]\nat = ""\nto = "x"')).toThrowError(/non-empty/);
    expect(() => parseWorktreeManifest('[[copy]]\nfrom = "../escape"\nto = "x"')).toThrowError(/no \.\./);
    expect(() => parseWorktreeManifest('[[copy]]\nfrom = "a"\nto = "/abs"')).toThrowError(/relative/);
    expect(() => parseWorktreeManifest('[[link]]\nat = "../up"\nto = "x"')).toThrowError(/no \.\./);
    expect(() => parseWorktreeManifest('unknown_key = 1')).toThrowError(/unknown key/);
  });

  it('parses reclaim as normalized repo-relative folders; absent means no reclaim key (#427)', () => {
    const manifest = parseWorktreeManifest('reclaim = ["build", "./target/", "web\\\\dist", "out//cache"]\n[[setup]]\ncommand = "x"');
    expect(manifest.reclaim).toEqual(['build', 'target', 'web/dist', 'out/cache']);
    expect(manifest.setup).toHaveLength(1);
    expect(parseWorktreeManifest('reclaim = []').reclaim).toEqual([]);
    expect('reclaim' in parseWorktreeManifest('[[setup]]\ncommand = "x"')).toBe(false);
  });

  it('rejects every unsafe or repeated reclaim entry with an error naming it (#427)', () => {
    const rejected: readonly (readonly [string, RegExp])[] = [
      ['["../x"]', /reclaim\[0\] must stay inside the repository \(no \.\.\): "\.\.\/x"/],
      ['["a/../../x"]', /reclaim\[0\] must stay inside the repository \(no \.\.\): "a\/\.\.\/\.\.\/x"/],
      ['["/abs/build"]', /reclaim\[0\] must be relative to the repository root: "\/abs\/build"/],
      ['["C:\\\\build"]', /reclaim\[0\] must be relative to the repository root: "C:\\\\build"/],
      ['[""]', /reclaim\[0\] must be a non-empty folder path, got: ""/],
      ['["."]', /reclaim\[0\] must name a folder below the repository root, not the root itself: "\."/],
      ['["./"]', /reclaim\[0\] must name a folder below the repository root, not the root itself: "\.\/"/],
      ['["a\\u0000b"]', /reclaim\[0\] must not contain NUL: "a\\u0000b"/],
      ['[".git"]', /reclaim\[0\] must not be or be inside \.git: "\.git"/],
      ['[".git/hooks"]', /reclaim\[0\] must not be or be inside \.git: "\.git\/hooks"/],
      ['["vendor/.git"]', /reclaim\[0\] must not be or be inside \.git: "vendor\/\.git"/],
      ['[".gru-command"]', /reclaim\[0\] must not be or be inside \.gru-command: "\.gru-command"/],
      ['[".gru-command/cache"]', /reclaim\[0\] must not be or be inside \.gru-command: "\.gru-command\/cache"/],
      ['["build", "./build/"]', /reclaim\[1\] "\.\/build\/" duplicates reclaim\[0\] \(both name "build"\)/],
      ['[3]', /reclaim\[0\] must be a non-empty folder path, got: 3/],
      ['"build"', /reclaim must be an array of repo-relative folder paths/],
    ];
    for (const [value, error] of rejected) {
      expect(() => parseWorktreeManifest(`reclaim = ${value}`), value).toThrowError(error);
    }
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

  it('a lane setup that times out ends a member of its group that ignores SIGTERM and holds no pipe: the SIGKILL escalation stays armed while any member lives (#427)', async () => {
    const repo = makeFixtureRepo('fixture-termdaemon');
    try {
      mkdirSync(join(repo.path, '.gru-command'), { recursive: true });
      writeFileSync(
        manifestFile(repo.path),
        `[[setup]]\ncommand = '''sh -c 'trap "" TERM; echo ready > .daemon-ready; sleep 30' >/dev/null 2>&1 & echo $! > .daemon-pid; sleep 30'''\n`,
      );
      const manifest = loadWorktreeManifest(repo.path);
      const worktreePath = join(repo.path, '..', 'fixture-termdaemon-wt');
      repo.git(['worktree', 'add', worktreePath, 'HEAD']);
      const applied = applyWorktreeManifest(manifest!, { sourceRoot: repo.path, worktreePath, setupTimeoutMs: 1_000 });
      await expect(applied).rejects.toThrowError(/timed out after 1000ms/);
      // The daemon set its trap before the timeout: SIGTERM alone never ends it.
      expect(existsSync(join(worktreePath, '.daemon-ready'))).toBe(true);
      const pid = Number(readFileSync(join(worktreePath, '.daemon-pid'), 'utf-8').trim());
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      await vi.waitFor(() => {
        expect(() => process.kill(pid, 0)).toThrow();
      }, { timeout: 5_000 });
      repo.git(['worktree', 'remove', '--force', worktreePath]);
    } finally {
      repo.cleanup();
    }
  });

  it('ends the setup process group and rejects when the spawn receipt cannot be recorded', async () => {
    const repo = makeFixtureRepo('fixture-spawn-receipt');
    try {
      mkdirSync(join(repo.path, '.gru-command'), { recursive: true });
      // Outlives the test's budget unless the failed receipt ends the group.
      writeFileSync(manifestFile(repo.path), `[[setup]]\ncommand = '''sh -c 'sleep 60' & wait'''\n`);
      const manifest = loadWorktreeManifest(repo.path);
      const worktreePath = join(repo.path, '..', 'fixture-spawn-receipt-wt');
      repo.git(['worktree', 'add', worktreePath, 'HEAD']);
      let groupId = 0;
      const applied = applyWorktreeManifest(manifest!, { sourceRoot: repo.path, worktreePath, setupTimeoutMs: 60_000,
        onSpawn: (pid) => {
          groupId = pid;
          throw new Error('synthetic spawn receipt failure');
        } });
      await expect(applied).rejects.toThrow(expect.objectContaining({
        message: expect.stringContaining('process ownership receipt failed'),
        cause: expect.objectContaining({ message: 'synthetic spawn receipt failure' }),
      }));
      expect(groupId).toBeGreaterThan(0);
      await vi.waitFor(() => {
        expect(() => process.kill(-groupId, 0)).toThrow();
      }, { timeout: 5_000 });
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

  it('the setup output keeper records whether the output it dropped ended at a line break, so a kept short line counts as whole only then (#427)', () => {
    const fresh = new OutputTail();
    expect(fresh.stream()).toEqual({ text: '', truncated: false, startsAtLine: true });
    const tail = new OutputTail();
    tail.push(Buffer.from(`${'a'.repeat(40 * 1024)}\n`));
    tail.push(Buffer.from('b'.repeat(30 * 1024)));
    // Past 64 KiB: the first chunk, which ended at a line break, is dropped.
    expect(tail.stream()).toMatchObject({ truncated: true, startsAtLine: true });
    expect(tail.stream().text).toBe('b'.repeat(30 * 1024));
    tail.push(Buffer.from(`${'c'.repeat(40 * 1024)}\n`));
    // Now the dropped chunk ended mid-line: the kept text's first line is not whole.
    expect(tail.stream()).toMatchObject({ truncated: true, startsAtLine: false });
  });
});
