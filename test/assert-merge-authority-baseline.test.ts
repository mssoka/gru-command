import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EXPECTED_BASELINE_ASSERTIONS,
  assertMergeAuthorityBaseline,
} from '../tools/assert-merge-authority-baseline.mjs';

/**
 * The merge-authority fail-before classifier's accept/refuse contract (job
 * merge-authority-boundary-20261010): the baseline scope's `EXPECTED RED`
 * proof is only evidence when every named boundary assertion failed BY
 * ASSERTION on the pinned pre-change base. A classifier that accepts a
 * setup failure, a green named test, or a non-assertion failure would mint
 * fake fail-before evidence for the acceptance it exists to carry.
 */

type AssertionResult = {
  readonly fullName?: string;
  readonly title: string;
  readonly status: string;
  readonly failureMessages?: readonly string[];
};

const assertion = (
  title: string,
  status: string,
  failureMessages: readonly string[] = [],
): AssertionResult => ({ fullName: title, title, status, failureMessages });

function report(...assertions: readonly AssertionResult[]): unknown {
  return {
    numFailedTests: assertions.filter((entry) => entry.status === 'failed').length,
    testResults: [{ assertionResults: assertions }],
  };
}

const RED: readonly AssertionResult[] = EXPECTED_BASELINE_ASSERTIONS.map((title) =>
  assertion(title, 'failed', ['AssertionError: expected true to be false']),
);

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

describe('merge-authority fail-before classifier', () => {
  it('accepts a report only when every named boundary assertion failed as an AssertionError', () => {
    const proof = assertMergeAuthorityBaseline(report(...RED));
    expect(proof).toContain(`${EXPECTED_BASELINE_ASSERTIONS.length} named assertion(s) RED`);
    expect(proof).toContain('0 unrelated failure(s) excluded');
  });

  it('counts unlisted failures as excluded context, never as the claim', () => {
    const proof = assertMergeAuthorityBaseline(
      report(...RED, assertion('a later-main test at the old base', 'failed', ['AssertionError: unrelated'])),
    );
    expect(proof).toContain('1 unrelated failure(s) excluded');
  });

  it('rejects a named assertion that was collected but stayed GREEN at the base', () => {
    const [first = ''] = EXPECTED_BASELINE_ASSERTIONS;
    expect(() => assertMergeAuthorityBaseline(report(assertion(first, 'passed'), ...RED.slice(1))))
      .toThrow(/collected but GREEN at the base/u);
  });

  it('rejects a named assertion that was never collected', () => {
    expect(() => assertMergeAuthorityBaseline(report(...RED.slice(1))))
      .toThrow(/not collected/u);
  });

  it('rejects a named failure that is not an assertion failure', () => {
    const [first = ''] = EXPECTED_BASELINE_ASSERTIONS;
    expect(() => assertMergeAuthorityBaseline(
      report(assertion(first, 'failed', ['TypeError: actual value must be number or bigint']), ...RED.slice(1)),
    )).toThrow(/did not fail as an AssertionError/u);
  });

  it('rejects a collection/setup/import failure before any claim of behavioral RED', () => {
    expect(() => assertMergeAuthorityBaseline({
      numFailedTests: 1,
      testResults: [{ status: 'failed', message: 'Cannot find module "../src/dispatch/silas-driver.js"', assertionResults: [] }],
    })).toThrow(/collection\/setup\/import failure/u);
  });

  it('rejects an unreadable or count-inconsistent report', () => {
    expect(() => assertMergeAuthorityBaseline(null)).toThrow(/no parseable Vitest report/u);
    // One failing result listed while the report claims three: unreadable.
    expect(() => assertMergeAuthorityBaseline({
      numFailedTests: 3,
      testResults: [{ assertionResults: [assertion(EXPECTED_BASELINE_ASSERTIONS[0] ?? '', 'failed', ['AssertionError: x'])] }],
    })).toThrow(/unreadable report/u);
  });

  it('the CLI entry really classifies: proof marker on accept, loud refusal on reject', () => {
    // The verify scope invokes the tool as a subprocess and reads its exit
    // code/markers. A broken entry guard would exit 0 with no output and
    // let the scope's own `exit 1` masquerade as the fail-before proof.
    const dir = mkdtempSync(join(tmpdir(), 'gru-merge-authority-classifier-'));
    cleanupDirs.push(dir);
    const tool = join(import.meta.dirname, '..', 'tools', 'assert-merge-authority-baseline.mjs');
    const acceptPath = join(dir, 'accept.json');
    const refusePath = join(dir, 'refuse.json');
    writeFileSync(acceptPath, JSON.stringify(report(...RED)));
    writeFileSync(refusePath, JSON.stringify({ numFailedTests: 0, testResults: [] }));
    const accept = execFileSync(process.execPath, [tool, acceptPath], { encoding: 'utf-8' });
    expect(accept).toContain('EXPECTED RED:');
    let status = -1;
    let stderr = '';
    try {
      execFileSync(process.execPath, [tool, refusePath], { encoding: 'utf-8' });
    } catch (error) {
      const failure = error as { readonly status?: number; readonly stderr?: string };
      status = failure.status ?? -1;
      stderr = failure.stderr ?? '';
    }
    expect(status).toBe(2);
    expect(stderr).toContain('FAILS-BEFORE CLAIM BROKEN');
  });
});
