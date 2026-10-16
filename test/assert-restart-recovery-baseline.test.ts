import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertRestartRecoveryBaseline, BaselineRecoveryGateError } from '../tools/assert-restart-recovery-baseline.mjs';

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

// Stands in for the driver's two children (#363 S09-2-02): the RPC
// prerequisite passes; the Vitest probe moves the final authority as the mode
// says, then fails at the exact admission assertion the driver extracted.
const PROBE_PRELOAD = `
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const entry = process.argv[1] ?? '';
if (entry.endsWith('patch-vitest-rpc-timeout.mjs')) process.exit(0);
if (entry.endsWith('vitest.mjs')) {
  const repo = process.env.GRU_BASELINE_FIXTURE_REPO;
  const mode = process.env.GRU_BASELINE_FIXTURE_MODE;
  if (mode === 'head') execFileSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'moved'], { cwd: repo });
  if (mode === 'dirty') writeFileSync(join(repo, 'stray.txt'), 'x\\n');
  const { testName, assertionLine } = JSON.parse(readFileSync(join(process.cwd(), '..', 'manifest.json'), 'utf8'));
  const message = 'AssertionError: expected [] to have a length of 1 but got +0\\n at ' + process.cwd() + '/test/pi-adapter.test.ts:' + assertionLine + ':24';
  const out = process.argv.find((arg) => arg.startsWith('--outputFile.json=')).slice('--outputFile.json='.length);
  writeFileSync(out, JSON.stringify({ numFailedTests: 1, numPassedTests: 0, testResults: [{ message: '', assertionResults: [{ title: testName, status: 'failed', failureMessages: [message] }] }] }));
  process.stdout.write('FAIL ' + testName + '\\n' + message + '\\n');
  process.exit(1);
}
`;

interface DriverRun { readonly exitCode: number | null; readonly manifest: { readonly classification: string; readonly error?: string } }

/** The real driver, run as its scope runs it, in a disposable clone of this checkout's HEAD. */
async function driveBaseline(mode: 'none' | 'head' | 'dirty'): Promise<DriverRun> {
  const root = join(import.meta.dirname, '..');
  const dir = mkdtempSync(join(tmpdir(), `gru-baseline-authority-${mode}-`));
  try {
    const clone = join(dir, 'repo');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', root, clone]);
    execFileSync('git', ['checkout', '-q', '--detach', head], { cwd: clone });
    symlinkSync(join(root, 'node_modules'), join(clone, 'node_modules'), 'dir');
    appendFileSync(join(clone, '.git', 'info', 'exclude'), '/node_modules\n');
    const preload = join(dir, 'probe-preload.mjs');
    writeFileSync(preload, PROBE_PRELOAD);
    const { exitCode, output } = await new Promise<{ readonly exitCode: number | null; readonly output: string }>((resolve) => {
      const child = execFile(process.execPath, [join(root, 'tools', 'verify-restart-recovery-baseline.mjs')], {
        cwd: clone, timeout: 25_000, maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, GRU_BASELINE_FIXTURE_MODE: mode, GRU_BASELINE_FIXTURE_REPO: clone },
      }, (error, stdout, stderr) => resolve({ exitCode: child.exitCode, output: `${error === null ? '' : `${String(error)}\n`}${stdout}${stderr}` }));
    });
    const attempts = join(clone, '_bmad-output', 'verification', 'gh-286-baseline', head);
    const made = existsSync(attempts) ? readdirSync(attempts) : [];
    if (made.length !== 1) throw new Error(`the driver (${mode}) left ${String(made.length)} attempts, exit ${String(exitCode)}:\n${output}`);
    const attempt = made[0]!;
    return { exitCode, manifest: JSON.parse(readFileSync(join(attempts, attempt, 'manifest.json'), 'utf8')) as DriverRun['manifest'] };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('restart recovery baseline driver final authority (#363 S09-2-02)', () => {
  it('a valid probe is attested only while HEAD and a clean tree hold; either changing under the child refuses it (exit 2)', async () => {
    const [held, moved, dirtied] = await Promise.all([driveBaseline('none'), driveBaseline('head'), driveBaseline('dirty')]);
    expect(held).toMatchObject({ exitCode: 1, manifest: { classification: 'baseline-assertion-red' } });
    for (const refused of [moved, dirtied]) {
      expect(refused.exitCode).toBe(2);
      expect(refused.manifest.classification).toBe('invalid-baseline-proof');
      expect(refused.manifest.error).toContain('final authority changed during baseline probe');
    }
  });
});
