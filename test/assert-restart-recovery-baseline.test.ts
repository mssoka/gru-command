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
