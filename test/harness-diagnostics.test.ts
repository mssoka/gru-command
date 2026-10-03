import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FixtureStepTimeoutError,
  activateTestScope,
  currentTestScope,
  deactivateTestScope,
  disposeScopeProcesses,
  isTimeoutError,
  markFixtureStep,
  redactDiagnosticText,
  renderFailureDiagnostics,
  runBoundedFixtureStep,
  runOwnedCommand,
  trackChildProcess,
} from './helpers/harness-diagnostics.mjs';

/**
 * Diagnostics regression coverage: bounded, non-zero timeout evidence
 * (identity, elapsed, last completed fixture step, owned child pid/state
 * and captured output tail), secret redaction, and cleanup restricted to
 * demonstrably owned children. Uses short synthetic deadlines so no case
 * ever waits for the real 30s/120s budgets.
 */

function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await waitForExit(child);
}

const REPO_ROOT = resolve(import.meta.dirname, '..');
const VITEST_BIN = join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');
const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stand-in child object for render/teardown unit cases (no real process). */
function fakeChild(overrides: Record<string, unknown> = {}): ChildProcess {
  return {
    pid: 424_242,
    exitCode: null,
    signalCode: null,
    once: () => undefined,
    kill: () => {
      throw new Error('no real process');
    },
    stdout: null,
    stderr: null,
    ...overrides,
  } as unknown as ChildProcess;
}

/** A fake readable stream that synchronously emits each chunk in order. */
function fakeStream(...chunks: string[]): { on: (event: string, cb: (chunk: string) => void) => void } {
  return {
    on: (_event, cb) => {
      for (const chunk of chunks) cb(chunk);
    },
  };
}

/**
 * Deterministic e2e fixture: a real Vitest child runs a temp project whose
 * setup file is this repo's timeout-diagnostics wiring. It stalls one test
 * with an owned child and fails another whose own afterEach throws; both
 * must emit the diagnostics block (the afterEach-abort case is red with the
 * old setup-afterEach wiring).
 */
function writeDiagnosticsFixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-diagnostics-fixture-'));
  created.push(dir);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'gru-diagnostics-fixture', private: true, type: 'module' }),
  );
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  const setupFile = join(REPO_ROOT, 'test', 'helpers', 'timeout-diagnostics.ts');
  writeFileSync(
    join(dir, 'vitest.config.ts'),
    [
      "import { defineConfig } from 'vitest/config';",
      'export default defineConfig({',
      '  test: {',
      "    include: ['fixture.test.ts'],",
      `    setupFiles: [${JSON.stringify(setupFile)}],`,
      '    testTimeout: 600,',
      '    hookTimeout: 600,',
      '  },',
      '});',
      '',
    ].join('\n'),
  );
  const helpers = join(REPO_ROOT, 'test', 'helpers', 'harness-diagnostics.mjs');
  const ownedScript = 'process.stderr.write("owned-ready\\n");setInterval(() => {}, 1000);';
  writeFileSync(
    join(dir, 'fixture.test.ts'),
    [
      "import { spawn } from 'node:child_process';",
      "import { afterEach, expect, test } from 'vitest';",
      `import { markFixtureStep, trackChildProcess } from ${JSON.stringify(helpers)};`,
      '',
      'afterEach(() => {',
      "  throw new Error('teardown boom');",
      '});',
      '',
      "test('stalled with an owned child', async () => {",
      `  const child = spawn(process.execPath, ['-e', ${JSON.stringify(ownedScript)}]);`,
      "  trackChildProcess(child, { label: 'fixture owned child' });",
      "  markFixtureStep('stalled fixture step');",
      '  await new Promise(() => {});',
      '});',
      '',
      "test('fails after its own afterEach throws', () => {",
      "  markFixtureStep('failing fixture step');",
      "  expect('actual').toBe('expected');",
      '});',
      '',
    ].join('\n'),
  );
  return dir;
}

describe('harness diagnostics', () => {
  it('activates a diagnostics scope carrying file and test identity', () => {
    const scope = currentTestScope();
    expect(scope).not.toBeNull();
    expect(scope!.file).toContain('harness-diagnostics.test.ts');
    expect(scope!.name).toContain('activates a diagnostics scope');
    markFixtureStep('synthetic step alpha');
    expect(scope!.steps.at(-1)?.label).toBe('synthetic step alpha');
  });

  it('renders a timeout block with identity, elapsed, and the last completed step', () => {
    markFixtureStep('fixture step one');
    markFixtureStep('fixture step two');
    const error = new Error(
      'Test timed out in 30000ms.\nIf this is a long-running test, pass a timeout value as the last argument.',
    );
    expect(isTimeoutError(error)).toBe(true);
    const rendered = renderFailureDiagnostics(currentTestScope(), error);
    expect(rendered).toContain('[harness-diagnostics] TIMEOUT');
    expect(rendered).toContain('harness-diagnostics.test.ts');
    expect(rendered).toContain('renders a timeout block');
    expect(rendered).toMatch(/elapsed: \d/);
    expect(rendered).toContain('last completed fixture step: "fixture step two"');
    expect(rendered).not.toContain('"fixture step one"');
  });

  it('reports hook/setup failures distinctly from plain test failures', () => {
    const hook = renderFailureDiagnostics(currentTestScope(), new Error('Hook timed out in 30000ms.'));
    expect(hook).toContain('[harness-diagnostics] TIMEOUT');
    expect(hook).toContain('hook/setup phase');
    const plain = renderFailureDiagnostics(currentTestScope(), new Error('fixture exploded'));
    expect(plain).toContain('[harness-diagnostics] FAILURE');
    expect(plain).not.toContain('hook/setup phase');
    expect(isTimeoutError(new Error('fixture exploded'))).toBe(false);
  });

  it('fails a deliberately stalled synthetic fixture non-zero with pid and output tail, and reaps only owned children', async () => {
    const scope = currentTestScope()!;
    const owned = spawn(
      process.execPath,
      ['-e', 'console.error("owned-ready");setInterval(() => {}, 1000);'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      stdio: 'ignore',
    });
    trackChildProcess(owned, { label: 'stalled synthetic child', scope });
    try {
      await new Promise<void>((resolve) => owned.stderr!.once('data', () => resolve()));
      let failure: unknown = null;
      try {
        await runBoundedFixtureStep('stalled synthetic fixture', () => new Promise(() => {}), {
          deadlineMs: 200,
          scope,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(FixtureStepTimeoutError);
      const message = (failure as Error).message;
      expect(message).toContain('stalled synthetic fixture');
      expect(message).toMatch(/pid \d+ "stalled synthetic child": running/);
      expect(message).toContain('stderr tail');
      expect(message).toContain('owned-ready');

      const results = await disposeScopeProcesses(scope, { graceMs: 1_500, killGraceMs: 1_000 });
      expect(results).toContainEqual(
        expect.objectContaining({ label: 'stalled synthetic child', disposition: 'reaped' }),
      );
      expect(owned.exitCode !== null || owned.signalCode !== null).toBe(true);
      // Foreign processes are never inspected or signalled.
      expect(foreign.exitCode === null && foreign.signalCode === null).toBe(true);
    } finally {
      await killAndWait(foreign);
      await killAndWait(owned);
    }
  });

  it('marks successful bounded steps and bounds captured output with a truncation marker', async () => {
    const scope = currentTestScope()!;
    const value = await runBoundedFixtureStep('fast step', async () => 42, {
      deadlineMs: 1_000,
      scope,
    });
    expect(value).toBe(42);
    expect(scope.steps.at(-1)?.label).toBe('fast step');

    const noisy = spawn(process.execPath, ['-e', 'process.stderr.write("noise-".repeat(1000))'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    trackChildProcess(noisy, { label: 'noisy child', scope });
    await waitForExit(noisy);
    const rendered = renderFailureDiagnostics(scope, new Error('noisy failure'));
    expect(rendered).toContain('noisy child');
    expect(rendered).toContain('[truncated to last bytes]');
    expect(rendered.length).toBeLessThanOrEqual(8_300);
  });

  it('redacts credential-shaped output and never renders environment contents', async () => {
    expect(redactDiagnosticText('token="planted-secret-value"')).not.toContain('planted-secret-value');
    expect(redactDiagnosticText('API_KEY=sk-live-abcdef123456')).not.toContain('sk-live-abcdef123456');
    expect(redactDiagnosticText('authorization: ghp_abcdefghijklmnop')).not.toContain('ghp_abcdefghijklmnop');

    const canaryKey = 'GRU_TEST_DIAGNOSTIC_CANARY';
    process.env[canaryKey] = 'canary-value-123';
    try {
      const scope = currentTestScope()!;
      const leaky = spawn(
        process.execPath,
        ['-e', 'console.error("token=\\"child-secret-12345\\"")'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      trackChildProcess(leaky, { label: 'leaky child', scope });
      await waitForExit(leaky);
      const rendered = renderFailureDiagnostics(scope, new Error('leak check'));
      expect(rendered).not.toContain('child-secret-12345');
      // The environment is never dumped into diagnostics.
      expect(rendered).not.toContain('canary-value-123');
      expect(rendered).toContain('[REDACTED]');
    } finally {
      delete process.env[canaryKey];
    }
  });

  it('redacts bearer, JWT, underscore-prefixed and quoted credential shapes (review r1)', () => {
    expect(redactDiagnosticText('authorization: Bearer abcdef123456')).not.toContain('abcdef123456');
    expect(redactDiagnosticText('proxy said: bearer opaque-token-value-12345')).not.toContain(
      'opaque-token-value-12345',
    );
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5NXgL0n3I9PlFUP0THsR8U';
    expect(redactDiagnosticText(`bearer ${jwt}`)).not.toContain(jwt);
    expect(redactDiagnosticText('ghp_abcdefghijklmnop')).not.toContain('ghp_abcdefghijklmnop');
    expect(redactDiagnosticText('github_pat_11ABCDEFG0123456789')).not.toContain(
      'github_pat_11ABCDEFG0123456789',
    );
    expect(redactDiagnosticText('xoxb-1234567890-abcdefghijkl')).not.toContain('xoxb-1234567890-abcdefghijkl');
    expect(redactDiagnosticText('password: "correct horse battery staple"')).not.toContain('battery');
  });

  it('classifies serialized fixture-deadline clones as timeouts (review r1)', () => {
    const serialized = Object.assign(Object.create(null), {
      name: 'FixtureStepTimeoutError',
      message: 'Fixture step "probe" exceeded its 200ms deadline.',
    });
    expect(isTimeoutError(serialized)).toBe(true);
    expect(isTimeoutError({ message: 'Fixture step "probe" exceeded its 200ms deadline.' })).toBe(true);
    expect(renderFailureDiagnostics(currentTestScope(), serialized)).toContain('[harness-diagnostics] TIMEOUT');
    expect(isTimeoutError(new Error('fixture exploded'))).toBe(false);
  });

  it('marks only the truncated stream and keeps the freshest child evidence (review r1)', () => {
    const scope = currentTestScope()!;
    const twoStreamChild = fakeChild({
      pid: 733_001,
      exitCode: 0,
      stdout: fakeStream('short-stdout'),
      stderr: fakeStream('e'.repeat(2_500)),
    });
    trackChildProcess(twoStreamChild, { label: 'two-stream child', scope });
    const render = renderFailureDiagnostics(scope, new Error('stream check'));
    expect(render).toMatch(/stdout tail: short-stdout/);
    expect(render).toMatch(/stderr tail \[truncated to last bytes\]/);
    expect(render.match(/\[truncated to last bytes\]/g)?.length).toBe(1);

    // Overflow: the identity head and the newest child section both survive.
    for (let i = 0; i < 12; i++) {
      trackChildProcess(
        fakeChild({
          pid: 733_100 + i,
          exitCode: 0,
          stdout: fakeStream('o'.repeat(2_500)),
          stderr: fakeStream('e'.repeat(2_500)),
        }),
        { label: `overflow child ${i}`, scope },
      );
    }
    const overflow = renderFailureDiagnostics(scope, new Error('overflow failure'));
    expect(overflow).toContain('[harness-diagnostics] FAILURE');
    expect(overflow).toContain('[diagnostics truncated]');
    expect(overflow).toContain('overflow child 11');
    expect(overflow).toContain('eeeee');
    expect(overflow.length).toBeLessThanOrEqual(8_192);
  });

  it('bounds the whole teardown with one shared deadline (review r1)', async () => {
    const scope = currentTestScope()!;
    const stuck = Array.from({ length: 5 }, (_, i) =>
      fakeChild({ pid: 744_100 + i, exitCode: null, signalCode: null }),
    );
    for (const child of stuck) trackChildProcess(child, { label: 'stuck child', scope });
    const started = Date.now();
    const results = await disposeScopeProcesses(scope, { graceMs: 100, killGraceMs: 100, totalMs: 250 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1_000);
    expect(results.filter((entry) => entry.disposition === 'unreaped').length).toBeGreaterThan(0);
    // No real processes exist; release the fakes so this scope's teardown is cheap.
    for (const child of stuck) {
      (child as { exitCode: number | null }).exitCode = 0;
    }
  });

  it('nests per-test scopes under the file scope: parents render, only own children dispose (review r1)', async () => {
    const testScope = currentTestScope()!;
    const fileScope = testScope.parent;
    expect(fileScope, 'the setup file opens a file scope').not.toBeNull();
    trackChildProcess(fakeChild({ pid: 755_001, exitCode: 0 }), { label: 'file-scope child', scope: fileScope });
    trackChildProcess(fakeChild({ pid: 755_002, exitCode: 0 }), { label: 'test-scope child', scope: testScope });
    const rendered = renderFailureDiagnostics(testScope, new Error('nested check'));
    expect(rendered).toContain('file-scope child');
    expect(rendered).toContain('test-scope child');
    const results = await disposeScopeProcesses(testScope, { graceMs: 100, killGraceMs: 100 });
    expect(results.map((entry) => entry.label)).toEqual(['test-scope child']);

    deactivateTestScope(testScope);
    expect(currentTestScope()).toBe(fileScope);
    activateTestScope(testScope);
    expect(currentTestScope()).toBe(testScope);
  });

  it('emits the diagnostics block through real Vitest for a timeout and for an afterEach abort (review r1)', () => {
    const dir = writeDiagnosticsFixtureProject();
    const childEnv = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')),
    );
    const result = spawnSync(process.execPath, [VITEST_BIN, 'run', '--config', 'vitest.config.ts'], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 120_000,
      env: { ...childEnv, CI: 'true' },
    });
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status, output).not.toBe(0);
    // The stalled test's block: identity, last step, owned child, output tail.
    expect(output).toContain('[harness-diagnostics] TIMEOUT');
    expect(output).toContain('stalled fixture step');
    expect(output).toMatch(/pid \d+ "fixture owned child"/);
    expect(output).toContain('owned-ready');
    expect(output).toContain('owned children tracked: 1');
    // The afterEach-abort test still reports (the old hook wiring skipped it).
    expect(output).toContain('[harness-diagnostics] FAILURE');
    expect(output).toContain('failing fixture step');
    expect(output).toContain('teardown boom');
  });

  it('redacts credentials across truncation, chunk-split and JSON-escaped boundaries (Perkins r1/r2)', () => {
    const scope = currentTestScope()!;
    const opaque = 'A'.repeat(32);
    // The label sits 477 characters before the excerpt cut: redaction must
    // happen before excerpting, never after.
    trackChildProcess(
      fakeChild({ pid: 766_001, exitCode: 0, stderr: fakeStream(`token=${opaque} ${'x'.repeat(444)}`) }),
      { label: 'boundary child', scope },
    );
    const rendered = renderFailureDiagnostics(scope, new Error('boundary check'));
    expect(rendered).not.toContain(opaque);
    expect(rendered).toContain('[REDACTED]');

    // Split INSIDE the value: neither fragment may survive.
    const splitValue = 'B'.repeat(32);
    trackChildProcess(
      fakeChild({ pid: 766_002, exitCode: 0, stderr: fakeStream('token=BBBB', `${splitValue.slice(4)} ${'y'.repeat(400)}`) }),
      { label: 'split-value child', scope },
    );
    const splitValueRendered = renderFailureDiagnostics(scope, new Error('split value check'));
    expect(splitValueRendered).not.toContain(splitValue);
    expect(splitValueRendered).not.toContain('BBBB');

    // Split AFTER the Bearer scheme word: the whole pair still redacts.
    const bearerValue = 'opaque-token-value-12345';
    trackChildProcess(
      fakeChild({ pid: 766_003, exitCode: 0, stderr: fakeStream('authorization: Bearer ', bearerValue) }),
      { label: 'bearer-split child', scope },
    );
    const bearerRendered = renderFailureDiagnostics(scope, new Error('bearer split check'));
    expect(bearerRendered).not.toContain(bearerValue);
    expect(bearerRendered).not.toContain('opaque-token');

    // A long quoted credential in an error: sanitized before the 240-char
    // line bound can strip its closing quote.
    const longSecret = 'Z'.repeat(300);
    const longQuoted = renderFailureDiagnostics(scope, new Error(`token="${longSecret}"`));
    expect(longQuoted).not.toContain('Z'.repeat(50));
    expect(longQuoted).toContain('[REDACTED]');

    // A long quoted credential in a spawn error follows the same path.
    const spawnSecret = 'S'.repeat(300);
    trackChildProcess(
      fakeChild({
        pid: 766_004,
        exitCode: 0,
        once: (event: string, callback: (argument: unknown) => void) => {
          if (event === 'error') callback(new Error(`token="${spawnSecret}"`));
        },
      }),
      { label: 'spawn-error child', scope },
    );
    const spawnRendered = renderFailureDiagnostics(scope, new Error('spawn check'));
    expect(spawnRendered).not.toContain('S'.repeat(50));

    // JSON-escaped credentials in log records.
    const jsonEscaped = String.raw`{\"token\":\"JSON-secret-123456\"}`;
    expect(redactDiagnosticText(jsonEscaped)).not.toContain('JSON-secret-123456');

    // Multi-chunk continuation (Perkins r3): a value split across three
    // chunks keeps the fail-closed state until a terminator arrives.
    trackChildProcess(
      fakeChild({ pid: 766_006, exitCode: 0, stderr: fakeStream('token=BBBB', 'CCCCDDDD', ` ${'w'.repeat(300)}`) }),
      { label: 'continuation child', scope },
    );
    const continuationRendered = renderFailureDiagnostics(scope, new Error('continuation check'));
    expect(continuationRendered).not.toContain('BBBB');
    expect(continuationRendered).not.toContain('CCCCDDDD');
    expect(continuationRendered).not.toContain('CCCC');
    expect(continuationRendered).not.toContain('DDDD');

    // Retention-boundary counterexamples (Perkins r3): a value whose label
    // sits exactly at the trim point (or far before it) is redacted before
    // any trim, so no suffix can survive.
    const boundaryCases = [
      `token=${'E'.repeat(32)}${' '.repeat(20_000)}`,
      `${'x'.repeat(16_384 - 6)}token=${'F'.repeat(32)} ${' '.repeat(200)}`,
      `${'x'.repeat(4_000)}token=${'G'.repeat(32)} ${' '.repeat(200)}`,
    ];
    for (const [index, boundaryText] of boundaryCases.entries()) {
      trackChildProcess(
        fakeChild({ pid: 766_100 + index, exitCode: 0, stderr: fakeStream(boundaryText) }),
        { label: `retention child ${index}`, scope },
      );
    }
    const retentionRendered = renderFailureDiagnostics(scope, new Error('retention check'));
    expect(retentionRendered).not.toContain('E'.repeat(32));
    expect(retentionRendered).not.toContain('F'.repeat(32));
    expect(retentionRendered).not.toContain('G'.repeat(32));

    // Escaped characters inside quoted values (JSON log records).
    const escaped = String.raw`{"password":"abcd\\efgh"}`;
    expect(redactDiagnosticText(escaped)).not.toContain('abcd');
    expect(redactDiagnosticText(escaped)).not.toContain('efgh');
    const escapedQuote = String.raw`{"password":"abc\\\"def"}`;
    expect(redactDiagnosticText(escapedQuote)).not.toContain('def');
    // An unterminated quoted value fails closed rather than exposing the rest.
    expect(redactDiagnosticText('token="unterminated-secret')).not.toContain('unterminated-secret');
  });

  it('bounds an owned command past its deadline and reaps it (Perkins r1)', async () => {
    const scope = currentTestScope()!;
    const started = Date.now();
    await expect(
      runOwnedCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        label: 'stalled synthetic command',
        deadlineMs: 300,
        scope,
      }),
    ).rejects.toThrow(/stalled synthetic command exceeded its 300ms deadline/);
    expect(Date.now() - started).toBeLessThan(5_000);
    const tracked = scope.processes.at(-1);
    expect(tracked, 'the stalled command stays tracked').toBeDefined();
    expect(tracked!.exitCode !== null || tracked!.signal !== null, 'reaped by the deadline').toBe(true);
  });
});
