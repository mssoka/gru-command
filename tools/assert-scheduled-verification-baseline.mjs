import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import process from 'node:process';

const names = [
  'scheduled verification guard refuses the exact web incident before any producer',
  'scheduled verification guard refuses the exact npm test incident before any producer',
  'scheduled verification guard refuses the entire exact build compound before its first producer',
];
for (const file of process.argv.slice(2)) {
  const report = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(report.numFailedTests, 3, `${file}: require exactly three behavioral assertion REDs`);
  assert.equal(report.testResults.length, 1, `${file}: require one collected adapter suite`);
  assert.ok(report.testResults.every((suite) => suite.assertionResults.length > 0), `${file}: setup/import failure is not assertion RED`);
  const results = report.testResults.flatMap((suite) => suite.assertionResults);
  for (const name of names) {
    const result = results.find((entry) => entry.title === name);
    assert.equal(result?.status, 'failed', `${file}: missing original incident assertion RED ${name}`);
    assert.ok(result.failureMessages.some((message) => message.includes('AssertionError: expected true to be false')), `${file}: require actual fake producer start assertion, not incidental failure`);
  }
  process.stdout.write(`${file}: three original fake-producer-start AssertionError REDs; no import/setup failure\n`);
}
