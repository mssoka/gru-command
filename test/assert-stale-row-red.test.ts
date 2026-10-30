import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EXPECTED_ASSERTION,
  EXPECTED_TEST_TITLE,
  assertStaleRowRed,
} from '../tools/assert-stale-row-red.mjs';

/**
 * The stale-row fail-before classifier's accept/refuse contract: the
 * `stale-row-red` scope is only evidence when the named A1 case failed BY
 * ASSERTION on the pinned pre-change base. A classifier that accepts a setup
 * failure, a green case, a missing case or a different assertion would mint
 * fake fail-before evidence for A1/A7.
 */

type AssertionResult = {
  readonly fullName?: string;
  readonly title: string;
  readonly status: string;
  readonly failureMessages?: readonly string[];
};

const assertion = (status: string, messages: readonly string[] = [], title = EXPECTED_TEST_TITLE): AssertionResult => ({
  fullName: `directive retirement — live ownership fails closed ${title}`,
  title,
  status,
  failureMessages: messages,
});

const RED = assertion('failed', [`AssertionError: ${EXPECTED_ASSERTION} // Object.is equality`]);

function report(...assertions: readonly AssertionResult[]): unknown {
  return {
    numFailedTests: assertions.filter((entry) => entry.status === 'failed').length,
    testResults: [{ assertionResults: assertions }],
  };
}

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

describe('stale-row fail-before classifier', () => {
  it('accepts the named A1 case only when it failed with the expected AssertionError', () => {
    const proof = assertStaleRowRed(report(RED));
    expect(proof).toContain(EXPECTED_TEST_TITLE);
    expect(proof).toContain(EXPECTED_ASSERTION);
  });

  it('rejects a missing A1 case', () => {
    expect(() => assertStaleRowRed(report())).toThrow(/was not collected/u);
  });

  it('rejects an A1 case that stayed green at the base', () => {
    expect(() => assertStaleRowRed(report(assertion('passed')))).toThrow(/was passed at the pre-change base/u);
  });

  it('rejects a failure that is not an AssertionError', () => {
    expect(() => assertStaleRowRed(report(assertion('failed', ['TypeError: cannot read properties of undefined']))))
      .toThrow(/did not fail as an AssertionError/u);
  });

  it('rejects a different AssertionError as the claim', () => {
    expect(() => assertStaleRowRed(report(assertion('failed', ['AssertionError: expected 500 to be 200']))))
      .toThrow(new RegExp(EXPECTED_ASSERTION, 'u'));
  });

  it('rejects a collection/setup/import failure before any claim of behavioral RED', () => {
    expect(() => assertStaleRowRed({
      numFailedTests: 1,
      testResults: [{ status: 'failed', message: 'Cannot find module "../src/ledger/api.js"', assertionResults: [] }],
    })).toThrow(/collection\/setup\/import failure/u);
  });

  it('rejects an unparseable report', () => {
    expect(() => assertStaleRowRed(null)).toThrow(/no parseable Vitest report/u);
    expect(() => assertStaleRowRed({})).toThrow(/no parseable Vitest report/u);
  });

  it('the CLI entry classifies through a symlinked path instead of silently exiting 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-stale-row-classifier-'));
    cleanupDirs.push(dir);
    const tool = join(import.meta.dirname, '..', 'tools', 'assert-stale-row-red.mjs');
    const link = join(dir, 'classifier.mjs');
    symlinkSync(tool, link);
    const acceptPath = join(dir, 'accept.json');
    const refusePath = join(dir, 'refuse.json');
    writeFileSync(acceptPath, JSON.stringify(report(RED)));
    writeFileSync(refusePath, JSON.stringify(report(assertion('passed'))));
    const accept = execFileSync(process.execPath, [link, acceptPath], { encoding: 'utf-8' });
    expect(accept).toContain('stale-row red proven');
    let status = -1;
    let stderr = '';
    try {
      execFileSync(process.execPath, [link, refusePath], { encoding: 'utf-8' });
    } catch (error) {
      const failure = error as { readonly status?: number; readonly stderr?: string };
      status = failure.status ?? -1;
      stderr = failure.stderr ?? '';
    }
    expect(status).toBe(2);
    expect(stderr).toContain('FAILS-BEFORE CLAIM BROKEN');
    // A missing report is a refusal too, never a silent exit 0.
    let missingStatus = -1;
    try {
      execFileSync(process.execPath, [link, join(dir, 'absent.json')], { encoding: 'utf-8' });
    } catch (error) {
      missingStatus = (error as { readonly status?: number }).status ?? -1;
    }
    expect(missingStatus).toBe(2);
  });
});
