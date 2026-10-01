import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * tools/patch-vitest-rpc-timeout.mjs contract. The pretest hook must apply
 * the upstream birpc-timeout fix (restored under explicit owner
 * authorization, journal j-463), be idempotent, skip cleanly when vitest is
 * not installed (production installs), and — the guarantee that matters —
 * fail LOUD when vitest IS installed but its dist shape no longer matches
 * the pinned patch, so a harness change can never silently disable the fix
 * and bring back the flaky exit-1 class. The patch must stay narrow (one
 * inserted line on the RPC options), and a real test failure must still
 * fail the run under the patched runner.
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
const PATCHED = `${OPEN}\n\t\ttimeout: -1,`;

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

const repoRoot = resolve(import.meta.dirname, '..');
const VITEST_BIN = join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs');

/** A minimal configless vitest project that resolves the repository's own
 * installed vitest (symlinked node_modules) — the same dist the pretest
 * hook patches. */
function writeFixtureProject(cwd: string): void {
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify({ name: 'vitest-rpc-fixture', private: true, type: 'module' }),
  );
  const link = join(cwd, 'node_modules');
  if (!existsSync(link)) symlinkSync(join(repoRoot, 'node_modules'), link, 'dir');
}

function writeFixtureTest(cwd: string, expected: number): void {
  writeFileSync(
    join(cwd, 'fixture.test.ts'),
    [
      "import { expect, test } from 'vitest';",
      '',
      "test('deliberate failure still propagates', () => {",
      `  expect(1 + 1).toBe(${expected});`,
      '});',
      '',
    ].join('\n'),
  );
}

/** Run a real (tiny) vitest child against the patched runner. The outer
 * worker's VITEST_* environment is scrubbed so the child boots clean. */
function runVitestChild(cwd: string) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')),
  );
  return spawnSync(process.execPath, [VITEST_BIN, 'run', 'fixture.test.ts'], {
    cwd,
    encoding: 'utf-8',
    timeout: 120_000,
    env: { ...env, CI: 'true' },
  });
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

  it('fails loud when vitest is installed but dist/chunks was relocated', () => {
    const cwd = fixtureDir();
    mkdirSync(join(cwd, 'node_modules', 'vitest'), { recursive: true });
    writeFileSync(join(cwd, 'node_modules', 'vitest', 'package.json'), '{}');
    const result = runTool(cwd);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('installed vitest has no dist/chunks');
  });

  it('applies the upstream fix and is idempotent on a second run', () => {
    const cwd = fixtureDir();
    const file = writeRpcChunk(cwd, `${OPEN}\n}));\n`);

    const first = runTool(cwd);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('applied upstream fix');
    const patched = readFileSync(file, 'utf-8');
    expect(patched).toContain('timeout: -1,');
    // Narrowness: removing the ONE inserted line restores the pristine
    // fixture bytes exactly — no other byte of the dist is touched.
    expect(patched.replace('\n\t\ttimeout: -1,', '')).toBe(`${OPEN}\n}));\n`);
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

  it('fails LOUD when the patch marker is present but a second site is still unpatched (r4 adversarial#10)', () => {
    const cwd = fixtureDir();
    writeRpcChunk(cwd, `${PATCHED}\n}));\n${OPEN}\n}));\n`);

    const result = runTool(cwd);
    expect(result.status).not.toBe(0);
    // The marker alone must never read as "already patched": the shape guard
    // still runs and names both sides.
    expect(result.stderr).toMatch(/1 patched \+ 2 createBirpc sites/);
    expect(result.stderr).toContain('update tools/patch-vitest-rpc-timeout.mjs');
  });

  it('patches every chunk in a multi-chunk dist and keeps each single-site invariant', () => {
    const cwd = fixtureDir();
    const dir = join(cwd, 'node_modules', 'vitest', 'dist', 'chunks');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rpc.one.js'), `${OPEN}\n}));\n`);
    writeFileSync(join(dir, 'rpc.two.js'), `${OPEN}\n}));\n`);

    const result = runTool(cwd);
    expect(result.status, result.stderr).toBe(0);
    for (const entry of ['rpc.one.js', 'rpc.two.js']) {
      const chunk = readFileSync(join(dir, entry), 'utf-8');
      expect(chunk.split(PATCHED).length - 1, entry).toBe(1);
      expect(chunk.split(OPEN).length - 1, entry).toBe(1);
    }
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
    // EVERY chunk must carry exactly one patched site and no unpatched site:
    // a partially patched dist can no longer pass on a joined contains.
    for (const entry of rpcFiles) {
      const chunk = readFileSync(join(dir, entry), 'utf-8');
      expect(chunk.split(PATCHED).length - 1, entry).toBe(1);
      expect(chunk.split(OPEN).length - 1, entry).toBe(1);
    }
  });

  it('still propagates real test failures under the patched runner', () => {
    // Ensure the installed dist carries the fix (idempotent no-op when the
    // pretest hook or the real-dist test above already patched it).
    const patch = runTool(repoRoot);
    expect(patch.status, patch.stderr).toBe(0);

    const cwd = fixtureDir();
    writeFixtureProject(cwd);
    writeFixtureTest(cwd, 3);
    const failing = runVitestChild(cwd);
    const failingOutput = `${failing.stdout}\n${failing.stderr}`;
    expect(failing.error, failingOutput).toBeUndefined();
    expect(failing.status, failingOutput).not.toBe(0);
    expect(failingOutput).toContain('deliberate failure still propagates');
    expect(failingOutput).toMatch(/AssertionError|expected 2 to be 3/);
    // The non-zero exit is the real assertion, never the runner class the
    // patch addresses masking or inventing one.
    expect(failingOutput).not.toContain('Timeout calling "onTaskUpdate"');

    // Green stays green under the patched runner.
    writeFixtureTest(cwd, 2);
    const passing = runVitestChild(cwd);
    expect(passing.error, `${passing.stdout}\n${passing.stderr}`).toBeUndefined();
    expect(passing.status, `${passing.stdout}\n${passing.stderr}`).toBe(0);
  }, 180_000);
});
