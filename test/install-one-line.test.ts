import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * install.sh setup mode (E9): the one-line-install pipeline exercised
 * for real against a local file:// clone FIXTURE — a minimal
 * product-shaped repo (real install.sh + a build that produces stub
 * dist/main.js + dist/wizard/main.js). Proves: clone-when-absent,
 * deps+build, wizard exec, no-reclone inside a checkout, no-reclone
 * when the target already holds the checkout — plus the E7 flag
 * contracts re-pinned (--print / --uninstall / unknown flag).
 */

const repoRoot = join(import.meta.dirname, '..');
const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

let lastStderr = '';

function run(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { stdout: string; stderr: string; status: number } {
  try {
    const stdout = execFileSync('bash', [script, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      timeout: 120_000,
    });
    lastStderr = '';
    return { stdout, stderr: '', status: 0 };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; status?: number };
    lastStderr = err.stderr ?? '';
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.status ?? 1 };
  }
}

/** A minimal product-shaped repo the one-liner can clone and build. */
function buildFixtureRepo(): { fixture: string; home: string } {
  const fixture = tempDir('gru-command-fixture-src-');
  const home = tempDir('gru-command-fixture-home-');
  copyFileSync(join(repoRoot, 'install.sh'), join(fixture, 'install.sh'));
  // A product checkout is package.json + src/ + install.sh — the src
  // marker is what tells install.sh it is INSIDE a checkout (no clone).
  mkdirSync(join(fixture, 'src'), { recursive: true });
  writeFileSync(join(fixture, 'src', 'marker.ts'), 'export {};\n', 'utf-8');
  writeFileSync(
    join(fixture, 'package.json'),
    JSON.stringify(
      {
        name: 'gru-command-fixture',
        version: '0.0.0',
        private: true,
        type: 'module',
        scripts: { build: 'node make-dist.mjs' },
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  // The fixture "build" produces the two artifacts install.sh checks for.
  writeFileSync(
    join(fixture, 'make-dist.mjs'),
    [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      'mkdirSync("dist/wizard", { recursive: true });',
      'writeFileSync("dist/main.js", "// fixture service stub\\n");',
      // The fixture wizard stub: records that it ran + the answers it got,
      // into the instance dir — the real wizard is covered by the
      // rehearsal + wizard tests.
      'writeFileSync("dist/wizard/main.js", `#!/usr/bin/env node',
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      'const home = process.env.GRU_COMMAND_HOME ?? "";',
      "const answers = process.argv.slice(2).join(' ');",
      "if (home) { mkdirSync(home, { recursive: true });",
      '  writeFileSync(home + "/config.toml", "wizard-ran: " + answers); }',
      'console.log("WIZARD-RAN " + answers);',
      '`);',
      '',
    ].join('\n'),
    'utf-8',
  );
  // gitInitCommit(fixture) is the CALLER's first step (kept separate so
  // each test controls its fixture's git state).
  return { fixture, home };
}

function gitInitCommit(dir: string): void {
  execFileSync('git', ['-C', dir, 'init', '-q']);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', [
    '-C', dir, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture',
    'commit', '-qm', 'fixture product',
  ]);
}

describe('install.sh setup mode (one-line path)', () => {
  it('piped install: clones when absent → deps → build → wizard (marker written)', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    // The one-liner case: a bare directory holding ONLY install.sh
    // (what curl|bash actually runs) — no checkout around it.
    const bare = tempDir('gru-command-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const target = join(home, 'gru-command');

    const { stdout, status } = run(
      join(bare, 'install.sh'),
      ['--answers', '{"token":"fixture-token"}'],
      {
        HOME: home,
        GRU_COMMAND_HOME: join(home, '.gru-command'),
        GRU_COMMAND_ORIGIN: `file://${fixture}`,
        GRU_COMMAND_TARGET: target,
      },
    );
    expect(status, stdout).toBe(0);
    // Clone landed and was built.
    expect(existsSync(join(target, 'package.json'))).toBe(true);
    expect(existsSync(join(target, 'dist/main.js'))).toBe(true);
    // The wizard ran non-interactively with the forwarded answers.
    const config = join(home, '.gru-command', 'config.toml');
    expect(existsSync(config)).toBe(true);
    expect(stdout).toContain('WIZARD-RAN');
  });

  it('second run reuses the existing checkout (no re-clone)', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const bare = tempDir('gru-command-bare2-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const target = join(home, 'gru-command');
    const env = {
      HOME: home,
      GRU_COMMAND_HOME: join(home, '.gru-command'),
      GRU_COMMAND_ORIGIN: `file://${fixture}`,
      GRU_COMMAND_TARGET: target,
    };
    expect(run(join(bare, 'install.sh'), ['--answers', '{}'], env).status).toBe(0);
    // Marker INSIDE the clone: a re-clone (rm + clone) would destroy it.
    const marker = join(target, 'no-reclone-marker');
    writeFileSync(marker, 'kept', 'utf-8');
    const second = run(join(bare, 'install.sh'), ['--answers', '{}'], env);
    expect(second.status, second.stdout).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(second.stdout).toContain('reusing existing checkout');
  });

  it('inside a clone: no flags clone the product — deps+build+wizard only', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const elsewhere = join(home, 'should-not-exist');
    const { stdout, status } = run(join(fixture, 'install.sh'), ['--answers', '{}'], {
      HOME: home,
      GRU_COMMAND_HOME: join(home, '.gru-command'),
      GRU_COMMAND_TARGET: elsewhere,
      GRU_COMMAND_ORIGIN: `file://${fixture}`,
    });
    expect(status, stdout).toBe(0);
    // No re-clone happened: the target dir was never created.
    expect(existsSync(elsewhere)).toBe(false);
    expect(existsSync(join(home, '.gru-command', 'config.toml'))).toBe(true);
  });

  it('--answers=<json> equals-form parses identically (wizard marker written)', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const { stdout, status } = run(join(fixture, 'install.sh'), ['--answers={}'], {
      HOME: home,
      GRU_COMMAND_HOME: join(home, '.gru-command'),
    });
    expect(status, stdout).toBe(0);
    expect(stdout).toContain('WIZARD-RAN');
    expect(existsSync(join(home, '.gru-command', 'config.toml'))).toBe(true);
  });

  it('--answers combined with --print exits 2 with a named mode-conflict error', () => {
    for (const args of [['--answers', '{}', '--print'], ['--print', '--answers', '{}']]) {
      const { status, stderr } = run(join(repoRoot, 'install.sh'), args, {});
      expect(status, String(args)).toBe(2);
      expect(stderr).toContain('--answers is only valid with setup mode');
      expect(stderr).toContain('--print');
    }
  });

  it('clone failure (bad GRU_COMMAND_ORIGIN) exits non-zero with a named error', () => {
    const home = tempDir('gru-command-clonefail-home-');
    const bare = tempDir('gru-command-clonefail-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const { stdout, status } = run(
      join(bare, 'install.sh'),
      ['--answers', '{}'],
      {
        HOME: home,
        GRU_COMMAND_HOME: join(home, '.gru-command'),
        GRU_COMMAND_ORIGIN: `file://${join(home, 'no-such-origin-repo')}`,
        GRU_COMMAND_TARGET: join(home, 'gru-command'),
      },
    );
    expect(status, stdout).not.toBe(0);
    expect(stdout).toMatch(/cloning/);
    // git names the failure (fatal: repository … does not exist) — loud,
    // never a silent no-op.
    expect(lastStderr).toMatch(/fatal|repository|clone/i);
    expect(existsSync(join(home, 'gru-command'))).toBe(false);
  });

  it('re-exec guard: GRU_COMMAND_REEXEC=1 outside a checkout exits 1, named', () => {
    const home = tempDir('gru-command-reexec-home-');
    const bare = tempDir('gru-command-reexec-bare-');
    copyFileSync(join(repoRoot, 'install.sh'), join(bare, 'install.sh'));
    const { stderr, status } = run(join(bare, 'install.sh'), ['--answers', '{}'], {
      HOME: home,
      GRU_COMMAND_HOME: join(home, '.gru-command'),
      GRU_COMMAND_REEXEC: '1',
    });
    expect(status).toBe(1);
    expect(stderr).toContain('re-exec landed outside a product checkout');
    expect(existsSync(join(home, '.gru-command', 'config.toml'))).toBe(false);
  });
});

describe('install.sh E7 flag contracts (re-pinned)', () => {
  it('unknown flags exit 2 with usage', () => {
    const { status, stderr } = run(join(repoRoot, 'install.sh'), ['--bogus'], {});
    expect(status).toBe(2);
    expect(stderr).toContain('unknown flag');
  });

  it('--print renders the platform unit absolutely; changes nothing', () => {
    const { stdout, status } = run(join(repoRoot, 'install.sh'), ['--print'], {});
    expect(status).toBe(0);
    expect(stdout).not.toContain('{{NODE}}');
    expect(stdout).not.toContain('{{REPO_ROOT}}');
    expect(stdout).not.toContain('{{GRU_COMMAND_HOME}}');
    expect(stdout).not.toContain('{{PATH}}');
  });

  it('--uninstall on a clean machine reports not-installed, exit 0', () => {
    const home = tempDir('gru-command-uninstall-');
    const { stdout, status } = run(join(repoRoot, 'install.sh'), ['--uninstall'], { HOME: home });
    expect(status, stdout).toBe(0);
    expect(stdout).toMatch(/not installed/);
  });

  it('--service refuses loudly when dist/main.js is missing', () => {
    const { fixture, home } = buildFixtureRepo();
    gitInitCommit(fixture);
    const { stderr, status } = run(join(fixture, 'install.sh'), ['--service'], { HOME: home });
    expect(status).toBe(1);
    expect(stderr).toContain('dist/main.js not found');
  });

  it('--answers= (empty) exits 2 — never a silent flip to interactive (Perkins r2 note)', () => {
    const { status, stderr } = run(join(repoRoot, 'install.sh'), ['--answers='], {});
    expect(status).toBe(2);
    expect(stderr).toContain("--answers was given an empty value");
    expect(stderr).toContain("--answers '{}'");
  });
});

describe('node version gate (>= 22.19) — Perkins r1 W11', () => {
  /** A PATH shim that claims v18 and fails every -e probe: node_ok must
   * trip in BOTH --service and setup modes, before any registration or
   * install runs. */
  function oldNodeShim(): string {
    const dir = tempDir('gru-command-oldnode-bin-');
    writeFileSync(
      join(dir, 'node'),
      '#!/usr/bin/env bash\nif [[ "${1:-}" == "--version" ]]; then echo "v18.20.0"; fi\nexit 1\n',
      { encoding: 'utf-8', mode: 0o755 },
    );
    return dir;
  }

  it('--service mode gates before unit registration', () => {
    const shim = oldNodeShim();
    const { stderr, status } = run(join(repoRoot, 'install.sh'), ['--service'], {
      PATH: `${shim}:${process.env.PATH ?? ''}`,
    });
    expect(status).toBe(1);
    expect(stderr).toContain('node >= 22.19 required');
    expect(stderr).toContain('v18.20.0');
  });

  it('setup mode (inside a checkout) gates before deps/build', () => {
    const shim = oldNodeShim();
    const { stderr, status } = run(join(repoRoot, 'install.sh'), [], {
      PATH: `${shim}:${process.env.PATH ?? ''}`,
      // A answers-free run would exec the wizard after the gate — the
      // gate must stop it long before that.
      GRU_COMMAND_HOME: join(shim, '..', 'never-created'),
    });
    expect(status).toBe(1);
    expect(stderr).toContain('node >= 22.19 required');
    expect(existsSync(join(shim, '..', 'never-created'))).toBe(false);
  });
});
