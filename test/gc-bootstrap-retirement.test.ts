import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { assertWorktreeBootstrapSupported, loadWorktreeManifest, resolveVerifyCommand } from '../src/worktrees/manifest.js';

const root = join(import.meta.dirname, '..');
const doc = readFileSync(join(root, 'docs/BMAD-RUNTIME.md'), 'utf-8');
const blocks = [...doc.matchAll(/```sh\n([\s\S]*?)```/gu)].map((match) => match[1]!);
const commands = blocks.filter((block) => block.startsWith('# gc-bootstrap-retire:run\n'));
if (commands.length !== 1) throw new Error('exactly one documented gc-bootstrap-retire:run block is required');
const cleanup: string[] = [];
afterAll(() => { for (const path of cleanup) rmSync(path, { recursive: true, force: true }); });
function temp(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'gc-bootstrap-295-')));
  cleanup.push(path);
  return path;
}
function write(path: string, text: string): void { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); }
function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' }).trim();
}
const BEGIN = '# BEGIN GRU COMMAND BMAD BOOTSTRAP';
const END = '# END GRU COMMAND BMAD BOOTSTRAP';
const SIMPLE = [BEGIN, '[[setup]]', 'command = "node .gru-command/bmad-bootstrap.mjs"', END].join('\n');
const GUARDED = [BEGIN, '[[setup]]',
  '# Fresh clones have no git-local BMAD source. Only onboarded repositories',
  '# run the generated copier; a configured but invalid source still fails loud.',
  'command = "if git config --local --get gru-command.bmad-source >/dev/null 2>&1; then node .gru-command/bmad-bootstrap.mjs; fi"', END,
].join('\n');
const USER = '# foreign setup, including BMAD names\r\n[[setup]]\r\ncommand = "printf user-BMAD > proof"\r\n[verify]\r\nfull = "npm test"\r\n';
function fixture(block = GUARDED) {
  const workspace = temp();
  const repo = join(workspace, 'app');
  const manifest = join(repo, '.gru-command/worktree.toml');
  write(manifest, `${block.replaceAll('\n', '\r\n')}\r\n${USER}`);
  write(join(repo, '.gru-command/bmad-bootstrap.mjs'), '// edited by user; never infer ownership from marker\n');
  write(join(repo, '.gru-command/bmad-install.json'), '{"managed_by":"foreign","keep":true}\n');
  write(join(repo, '_bmad/custom/config.toml'), '[broken user settings\n');
  write(join(repo, '_bmad-output/spec.md'), '# old knowledge\n');
  write(join(repo, 'gru-output/architecture.md'), '# approved knowledge\n');
  write(join(repo, '.agents/skills/mine/SKILL.md'), '# user skill\n');
  git(repo, 'init', '-q');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'legacy');
  git(repo, 'config', '--local', 'gru-command.bmad-source', repo);
  return { workspace, repo, manifest, backup: join(workspace, 'backup') };
}
function tree(root: string): Readonly<Record<string, string>> {
  const entries: Record<string, string> = {};
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = relative(root, path);
      if (rel === '.git') continue;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) entries[rel] = `link:${readlinkSync(path)}`;
      else if (info.isDirectory()) visit(path);
      else entries[rel] = readFileSync(path).toString('base64');
    }
  };
  visit(root);
  return entries;
}
function run(f: ReturnType<typeof fixture>, mode: string, shell = '/bin/sh') {
  const result = spawnSync(shell, ['-c', commands[0]!], { cwd: f.workspace, encoding: 'utf-8', timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: f.workspace, REPO: f.repo, BACKUP: f.backup, MODE: mode },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('owner-run, GC-bootstrap-only retirement (#295)', () => {
  it('documented preview/backup/retire/restore preserves user BMAD, records and active lanes in sh/bash/zsh', () => {
    for (const shell of ['/bin/sh', '/bin/bash', '/bin/zsh'].filter(existsSync)) {
      for (const block of [SIMPLE, GUARDED]) {
        const f = fixture(block);
        const lane = join(f.workspace, 'active');
        git(f.repo, 'worktree', 'add', '-q', '--detach', lane, 'HEAD');
        const before = tree(f.repo);
        const laneBefore = tree(lane);
        const preview = run(f, 'preview', shell);
        expect(preview.status, preview.out).toBe(0);
        expect(preview.out).toContain(`worktree ${lane}`);
        expect(tree(f.repo)).toEqual(before);
        expect(readFileSync(join(f.backup, 'original-worktree.toml'), 'utf-8')).toBe(readFileSync(f.manifest, 'utf-8'));
        const retired = run(f, 'retire', shell);
        expect(retired.status, retired.out).toBe(0);
        expect(readFileSync(f.manifest, 'utf-8')).toBe(USER);
        expect(tree(f.repo)).toEqual({ ...before, '.gru-command/worktree.toml': Buffer.from(USER).toString('base64') });
        expect(tree(lane)).toEqual(laneBefore);
        expect(git(f.repo, 'config', '--local', '--get', 'gru-command.bmad-source')).toBe(f.repo);
        // Historical verification stays addressable; only new bootstrap refuses it.
        const old = loadWorktreeManifest(lane)!;
        expect(resolveVerifyCommand(old, 'full')).toBe('npm test');
        expect(() => assertWorktreeBootstrapSupported(old)).toThrow(/retired GC-managed BMAD bootstrap/u);
        expect(() => assertWorktreeBootstrapSupported(loadWorktreeManifest(f.repo)!)).not.toThrow();
        git(f.repo, 'add', '.gru-command/worktree.toml');
        git(f.repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'retire bootstrap');
        const fresh = join(f.workspace, 'fresh');
        git(f.repo, 'worktree', 'add', '-q', '--detach', fresh, 'HEAD');
        expect(() => assertWorktreeBootstrapSupported(loadWorktreeManifest(fresh)!)).not.toThrow();
        expect(tree(lane)).toEqual(laneBefore);
        expect(run(f, 'restore', shell).status).toBe(0);
        expect(tree(f.repo)).toEqual(before);
        git(f.repo, 'worktree', 'remove', '--force', fresh);
        git(f.repo, 'worktree', 'remove', '--force', lane);
      }
    }
  });

  it('edited, foreign, duplicate and incomplete marked blocks stop before repository writes or backup creation', () => {
    for (const block of [
      GUARDED.replace('then node', 'then echo user-command; node'),
      SIMPLE.replace('node .gru-command/bmad-bootstrap.mjs', 'echo foreign BMAD'),
      `${SIMPLE}\n${SIMPLE}`, SIMPLE.replace(END, ''), SIMPLE.replace(BEGIN, ''),
      SIMPLE.replaceAll('# BEGIN', '#  BEGIN').replaceAll('# END', '#END'),
    ]) {
      const f = fixture(block);
      const before = tree(f.repo);
      const result = run(f, 'preview');
      expect(result.status).not.toBe(0);
      expect(result.out).toContain('STOP:');
      expect(tree(f.repo)).toEqual(before);
      expect(existsSync(f.backup)).toBe(false);
    }
  });

  it('changed-since-preview and edited-after-retirement manifests are never overwritten', () => {
    const f = fixture();
    expect(run(f, 'preview').status).toBe(0);
    const original = readFileSync(f.manifest, 'utf-8');
    writeFileSync(f.manifest, `${original}# owner added after preview\n`);
    const changed = readFileSync(f.manifest, 'utf-8');
    expect(run(f, 'retire').out).toContain('STOP: manifest changed since preview/retirement');
    expect(readFileSync(f.manifest, 'utf-8')).toBe(changed);
    writeFileSync(f.manifest, original);
    expect(run(f, 'retire').status).toBe(0);
    writeFileSync(f.manifest, `${USER}# owner added after retirement\n`);
    expect(run(f, 'restore').status).not.toBe(0);
    expect(readFileSync(f.manifest, 'utf-8')).toBe(`${USER}# owner added after retirement\n`);
  });

  it('altered preview backups cannot overwrite the manifest during retirement or restoration', () => {
    for (const mode of ['retire', 'restore']) {
      for (const name of ['original-worktree.toml', 'retired-worktree.toml']) {
        const f = fixture();
        expect(run(f, 'preview').status).toBe(0);
        if (mode === 'restore') expect(run(f, 'retire').status).toBe(0);
        const file = join(f.backup, name);
        writeFileSync(file, `${readFileSync(file, 'utf-8')}# altered backup\n`);
        const before = tree(f.repo);
        const result = run(f, mode);
        expect(result.status).not.toBe(0);
        expect(result.out).toContain('STOP: backup bytes changed');
        expect(tree(f.repo)).toEqual(before);
      }
    }
  });

  it('a backup inside the repository and linked GC manifests are refused without touching their targets', () => {
    const inside = fixture();
    expect(run({ ...inside, backup: join(inside.repo, 'backup') }, 'preview').out).toContain('BACKUP must be outside the repository');
    const linked = fixture();
    const external = join(linked.workspace, 'foreign.toml');
    writeFileSync(external, readFileSync(linked.manifest));
    rmSync(linked.manifest);
    symlinkSync(external, linked.manifest);
    const before = readFileSync(external, 'utf-8');
    expect(run(linked, 'preview').status).not.toBe(0);
    expect(readFileSync(external, 'utf-8')).toBe(before);
    expect(existsSync(linked.backup)).toBe(false);
  });

  it('marker-looking lines inside foreign multiline setup strings do not establish GC ownership', () => {
    const f = fixture();
    writeFileSync(f.manifest, `[[setup]]\ncommand = '''\n${SIMPLE}\n'''\n`);
    const before = tree(f.repo);
    expect(loadWorktreeManifest(f.repo)!.retiredGcBmadBootstrap).toBeUndefined();
    const result = run(f, 'preview');
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('markers are user string data');
    expect(tree(f.repo)).toEqual(before);
    expect(existsSync(f.backup)).toBe(false);
  });
});
