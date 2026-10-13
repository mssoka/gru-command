import { describe, expect, it } from 'vitest';
import { classifyReviewedRed } from '../tools/classify-scheduled-verification-red.mjs';

const title = 'review-2 root-relative web bin paths refuse independently';
function report(message = 'AssertionError: expected true to be false') {
  return { numFailedTests: 1, numFailedTestSuites: 1, testResults: [{ assertionResults: [{ title, status: 'failed', failureMessages: [message] }] }] };
}
describe('reviewed-candidate behavioral RED custody', () => {
  it('accepts named behavioral assertions for both fast and heavy phases', () => {
    for (const phase of ['fast', 'heavy']) expect(classifyReviewedRed(report(), 2, phase)).toEqual([title]);
  });
  it('accepts the named authenticated status rejection matcher but not arbitrary command failures', () => {
    const r = report('Error: promise rejected "Error: Command failed" instead of resolving');
    r.testResults[0]!.assertionResults[0]!.title = 'review-2 advertised shell-safe status action authenticates literal dollar/backtick host config paths';
    expect(classifyReviewedRed(r, 2, 'fast')).toHaveLength(1);
    expect(() => classifyReviewedRed(report('Error: Command failed: missing fixture'), 2, 'fast')).toThrow(/non-behavioral/);
  });
  it('rejects missing reports and missing collected suites', () => {
    for (const value of [null, {}, { testResults: [] }]) expect(() => classifyReviewedRed(value, 2, 'fast')).toThrow(/missing collected/);
  });
  it('rejects malformed reporter data', () => {
    expect(() => classifyReviewedRed({ testResults: [null] }, 2, 'fast')).toThrow();
    expect(() => classifyReviewedRed({ testResults: [{}] }, 2, 'heavy')).toThrow(/setup/);
  });
  it('rejects setup-only or import-only suite failures in either candidate phase', () => {
    for (const generation of [1, 2]) for (const phase of ['fast', 'heavy']) {
      expect(() => classifyReviewedRed({ numFailedTests: 0, numFailedTestSuites: 1, testResults: [{ assertionResults: [], message: 'Cannot find module' }] }, generation, phase)).toThrow(/setup/);
    }
  });
  it('rejects a named test that failed only by fixture or transport error', () => {
    expect(() => classifyReviewedRed(report('Error: Reviewed archive seam is absent'), 2, 'heavy')).toThrow(/non-behavioral/);
  });
  it('rejects unlisted assertion failures and unexpected passing legs', () => {
    const r = report(); r.testResults[0]!.assertionResults[0]!.title = 'unrelated assertion';
    expect(() => classifyReviewedRed(r, 2, 'fast')).toThrow(/unlisted/);
    expect(() => classifyReviewedRed({ numFailedTests: 0, testResults: [{ assertionResults: [{ title, status: 'passed' }] }] }, 2, 'heavy')).toThrow(/missing behavioral/);
  });
  it('rejects inconsistent runner counts and preserves review-1 named assertions', () => {
    const r = report(); r.numFailedTests = 2;
    expect(() => classifyReviewedRed(r, 2, 'fast')).toThrow(/inconsistent/);
    r.numFailedTests = 1; r.testResults[0]!.assertionResults[0]!.title = 'review-1 adjacent redirects refuse before any producer';
    expect(classifyReviewedRed(r, 1, 'heavy')).toHaveLength(1);
  });
});
