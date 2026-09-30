import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * tools/patch-vitest-rpc-timeout.mjs contract (Perkins r4 warning): the
 * pretest hook must apply the upstream birpc-timeout fix, be idempotent,
 * skip cleanly when vitest is not installed (production installs), and — the
 * guarantee that matters — fail LOUD when vitest IS installed but its dist
 * shape no longer matches the pinned patch, so a harness change can never
 * silently disable the fix and bring back the flaky exit-1 class.
 */

const TOOL = resolve(import.meta.dirname, '..', 'tools', 'patch-vitest-rpc-timeout.mjs');

const OPEN = [
  '\tconst rpc = createSafeRpc(createBirpc({ onCancel: setCancel }, {',
  '\t\teventNames: [',
  '\t\t\t"onUserConsoleLog",',
  '\t\t\t"onCollected",',
  '\t\t\t"onCancel"',
  '\t\t],',
].join('\n');

const created: string[] = [];

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-vitest-rpc-patch-'));
  created.push(dir);
  return dir;
}

function runTool(cwd: string) {
  return spawnSync(process.execPath, [TOOL], { cwd, encoding: 'utf-8' });
}

function writeRpcChunk(cwd: string, content: string): string {
  const dir = join(cwd, 'node_modules', 'vitest', 'dist', 'chunks');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'rpc.testchunk.js');
  writeFileSync(file, content);
  return file;
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('vitest rpc-timeout patch tool', () => {
  it('skips cleanly when vitest is not installed (production install)', () => {
    const cwd = fixtureDir();
    const result = runTool(cwd);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('skipped (production install?)');
  });

  it('applies the upstream fix and is idempotent on a second run', () => {
    const cwd = fixtureDir();
    const file = writeRpcChunk(cwd, `${OPEN}\n}));\n`);

    const first = runTool(cwd);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('applied upstream fix');
    const patched = readFileSync(file, 'utf-8');
    expect(patched).toContain('timeout: -1,');
    const before = statSync(file).mtimeMs;

    const second = runTool(cwd);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain('already patched');
    expect(readFileSync(file, 'utf-8')).toBe(patched);
    expect(statSync(file).mtimeMs).toBe(before);
  });

  it('fails LOUD when the vitest dist exists but no rpc chunk matches', () => {
    const cwd = fixtureDir();
    const dir = join(cwd, 'node_modules', 'vitest', 'dist', 'chunks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.other.js'), '// rearranged layout\n');

    const result = runTool(cwd);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no rpc chunk found');
    expect(result.stderr).toContain('update tools/patch-vitest-rpc-timeout.mjs');
  });

  it('fails LOUD when the rpc chunk shape no longer contains the pinned site', () => {
    const cwd = fixtureDir();
    writeRpcChunk(cwd, '// a rearranged chunk with no createBirpc site\n');

    const result = runTool(cwd);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unexpected');
    expect(result.stderr).toContain('update tools/patch-vitest-rpc-timeout.mjs');
  });

  it('fails LOUD on an ambiguous chunk with more than one createBirpc site', () => {
    const cwd = fixtureDir();
    writeRpcChunk(cwd, `${OPEN}\n}));\n${OPEN}\n}));\n`);

    const result = runTool(cwd);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('2 createBirpc sites');
  });

  it('applies cleanly against the repository’s real installed vitest dist', () => {
    const cwd = resolve(import.meta.dirname, '..');
    const result = runTool(cwd);
    expect(result.status, result.stderr).toBe(0);
    // The hook is idempotent: either it patched now (first run) or reported
    // the already-patched state. After this run the dist carries the fix.
    expect(result.stdout).toMatch(/applied upstream fix|already patched/);
    const dir = join(cwd, 'node_modules', 'vitest', 'dist', 'chunks');
    const rpcFiles = readdirSync(dir).filter((entry) => /^rpc\..+\.js$/.test(entry));
    expect(rpcFiles.length).toBeGreaterThan(0);
    const chunks = rpcFiles.map((entry) => readFileSync(join(dir, entry), 'utf-8')).join('\n');
    expect(chunks).toContain('timeout: -1,');
  });
});
