import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { assertRestartRecoveryBaseline, BaselineRecoveryGateError } from '../tools/assert-restart-recovery-baseline.mjs';
import { run } from '../tools/verify-restart-recovery-baseline.mjs';

const testName = 'restart recovery records actual admission while the native prompt remains pending';
const message = 'AssertionError: expected [] to have a length of 1 but got +0\n at /fixture/test/pi-adapter.test.ts:3287:24';
const input = { testName, testFile: 'test/pi-adapter.test.ts', assertionLine: 3287, output: `FAIL ${testName}\n${message}` };
function report() {
  return { numFailedTests: 1, numPassedTests: 0, testResults: [{ message: '', assertionResults: [
    { title: testName, status: 'failed', failureMessages: [message] },
    { title: 'an unrelated filtered test', status: 'skipped', failureMessages: [] },
  ] }] };
}

describe('restart recovery baseline assertion classifier', () => {
  it('accepts a genuine admission assertion when Vitest omits its optional runtime-error counter', () => {
    expect(assertRestartRecoveryBaseline(report(), input)).toBe(message);
  });
  it('accepts a genuine assertion with an explicit zero runtime-error counter', () => {
    expect(assertRestartRecoveryBaseline({ ...report(), numRuntimeErrorTestSuites: 0 }, input)).toBe(message);
  });
  it('rejects runtime errors in either the JSON counter or the complete output', () => {
    expect(() => assertRestartRecoveryBaseline({ ...report(), numRuntimeErrorTestSuites: 1 }, input)).toThrow(BaselineRecoveryGateError);
    expect(() => assertRestartRecoveryBaseline(report(), { ...input, output: `${input.output}\nUnhandled Errors` })).toThrow('runtime errors');
  });
  it('rejects collection failure and a missing complete capture', () => {
    const fixture = report();
    expect(() => assertRestartRecoveryBaseline({ ...fixture, testResults: [{ ...fixture.testResults[0], message: 'Cannot find module' }] }, input)).toThrow('collection/result');
    expect(() => assertRestartRecoveryBaseline(report(), { ...input, output: '' })).toThrow('missing complete output');
  });
  it('rejects unrelated, multiple, and setup failures', () => {
    const fixture = report();
    const failed = fixture.testResults[0]!.assertionResults[0]!;
    const make = (failures: readonly unknown[]) => ({ ...fixture, testResults: [{ ...fixture.testResults[0], assertionResults: failures }] });
    expect(() => assertRestartRecoveryBaseline(make([{ ...failed, title: 'different regression' }]), input)).toThrow('not uniquely');
    expect(() => assertRestartRecoveryBaseline(make([failed, failed]), input)).toThrow('not uniquely');
    expect(() => assertRestartRecoveryBaseline(make([{ ...failed, failureMessages: ['ReferenceError: fixture is not defined'] }]), input)).toThrow('admission-length');
  });
  it('requires the exact admission assertion source line', () => {
    expect(() => assertRestartRecoveryBaseline(report(), { ...input, assertionLine: 3288 })).toThrow('extracted assertion');
  });
  it('rejects passing, malformed, and empty reports', () => {
    expect(() => assertRestartRecoveryBaseline({ ...report(), numFailedTests: 0, numPassedTests: 1 }, input)).toThrow(BaselineRecoveryGateError);
    expect(() => assertRestartRecoveryBaseline(null, input)).toThrow(BaselineRecoveryGateError);
    expect(() => assertRestartRecoveryBaseline({ ...report(), testResults: [] }, input)).toThrow(BaselineRecoveryGateError);
  });
});

describe('restart recovery baseline driver capture (#363 S09-0-02)', () => {
  it('a capture write that fails stops the child and rejects the run by name — never an escaped throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-baseline-capture-'));
    try {
      // The log's parent is a file: every append fails with ENOTDIR.
      writeFileSync(join(dir, 'not-a-directory'), '');
      const log = join(dir, 'not-a-directory', 'complete-output.txt');
      const quiet = (): Writable => new Writable({ write(_chunk, _encoding, done) { done(); } });
      const started = Date.now();
      // The child would run for a minute after its first output.
      const outcome = await run(process.execPath, ['-e', "process.stdout.write('baseline output\\n'); setTimeout(() => {}, 60000);"], dir, log, [quiet(), quiet()])
        .then((result: unknown) => ({ result }), (error: unknown) => ({ error }));
      expect(outcome).toMatchObject({ error: expect.any(BaselineRecoveryGateError) });
      expect(String((outcome as { error: unknown }).error)).toMatch(/complete output capture failed \(Error: ENOTDIR[^)]*\); the child was stopped — not behavioral RED/u);
      expect(Date.now() - started).toBeLessThan(30_000);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a run that captures cleanly resolves its exit status, with each stream teed to its own sink and both in the log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-baseline-capture-ok-'));
    try {
      const log = join(dir, 'complete-output.txt');
      const seen: string[][] = [[], []];
      const sink = (index: number): Writable => new Writable({ write(chunk, _encoding, done) { seen[index]!.push(String(chunk)); done(); } });
      const result = await run(process.execPath, ['-e', "process.stdout.write('to stdout'); process.stderr.write('to stderr'); process.exitCode = 3;"], dir, log, [sink(0), sink(1)]);
      expect(result).toEqual({ exitCode: 3, signal: null });
      expect(seen.map((chunks) => chunks.join(''))).toEqual(['to stdout', 'to stderr']);
      // Each stream's bytes land whole; only the order between the two streams may vary.
      expect(['to stdoutto stderr', 'to stderrto stdout']).toContain(readFileSync(log, 'utf8'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('run as a command — directly or through a symlink — the driver enters its probe and refuses outside a git checkout (exit 2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-baseline-cli-'));
    try {
      const script = join(import.meta.dirname, '..', 'tools', 'verify-restart-recovery-baseline.mjs');
      const linked = join(dir, 'linked-driver.mjs');
      symlinkSync(script, linked);
      for (const entry of [script, linked]) {
        const result = spawnSync(process.execPath, [entry], { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_DIR: join(dir, 'no-such-git'), GIT_CEILING_DIRECTORIES: dir } });
        expect([result.status, result.stderr], entry).toEqual([2, expect.stringMatching(/^baseline proof refused: /mu)]);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
