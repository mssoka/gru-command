export class BaselineRecoveryGateError extends Error {
  constructor(message) { super(message); this.name = 'BaselineRecoveryGateError'; }
}
function requireEvidence(condition, message) {
  if (!condition) throw new BaselineRecoveryGateError(message);
}

/** Vitest's JSON reporter may omit numRuntimeErrorTestSuites. The complete
 * default-reporter capture must also be clean of runtime-error diagnostics. */
export function assertRestartRecoveryBaseline(report, { testName, testFile, assertionLine, output }) {
  requireEvidence(report !== null && typeof report === 'object' && Array.isArray(report.testResults) &&
    report.testResults.length === 1 && report.numFailedTests === 1 && report.numPassedTests === 0 &&
    (report.numRuntimeErrorTestSuites === undefined || report.numRuntimeErrorTestSuites === 0) &&
    report.testResults[0]?.message === '' && Array.isArray(report.testResults[0]?.assertionResults),
  'collection/result counts do not prove one named assertion RED');
  requireEvidence(typeof output === 'string' && output.trim() !== '' &&
    !/Unhandled Errors|Unhandled Rejection|Uncaught Exception|Errors occurred during test run/u.test(output),
  'runtime errors or missing complete output are not behavioral RED');
  const failures = report.testResults[0].assertionResults.filter((entry) => entry.status === 'failed');
  requireEvidence(failures.length === 1 && failures[0].title === testName &&
    Array.isArray(failures[0].failureMessages) && failures[0].failureMessages.length === 1 &&
    typeof failures[0].failureMessages[0] === 'string',
  'failure is not uniquely the named admission regression');
  const message = failures[0].failureMessages[0].replaceAll('\\', '/');
  requireEvidence(/AssertionError: expected \[\] to have a length of 1 but got \+?0/u.test(message) &&
    message.includes(`${testFile}:${assertionLine}:`),
  'failure must be admission-length AssertionError at the extracted assertion, not setup/import/collection');
  return message;
}
