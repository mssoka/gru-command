import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  FixtureStepTimeoutError,
  currentTestScope,
  disposeScopeProcesses,
  isTimeoutError,
  markFixtureStep,
  redactDiagnosticText,
  renderFailureDiagnostics,
  runBoundedFixtureStep,
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
});
