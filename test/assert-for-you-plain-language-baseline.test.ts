import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EXPECTED_BOUNDARY_ASSERTIONS,
  EXPECTED_FACE_ASSERTIONS,
  LEGS,
  assertForYouPlainLanguageBaseline,
} from '../tools/assert-for-you-plain-language-baseline.mjs';

/**
 * The FOR YOU plain-language fail-before classifier's accept/refuse contract
 * (issue #570): the `gc-570-red` scope's proof is only evidence when every
 * named boundary/face assertion failed BY ASSERTION on the pinned pre-change
 * base. A classifier that accepts a setup failure, a green named test or an
 * unrelated failure would mint fake fail-before evidence.
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

const RED = EXPECTED_BOUNDARY_ASSERTIONS.map((title) =>
  assertion(title, 'failed', ['AssertionError: expected the base to store this card']),
);
const FACE_RED = EXPECTED_FACE_ASSERTIONS.map((title) =>
  assertion(title, 'failed', ['AssertionError: the base promoted the detail to the face']),
);

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

describe('for-you-plain-language fail-before classifier', () => {
  it('accepts a boundary report only when every named assertion failed as an AssertionError', () => {
    const proof = assertForYouPlainLanguageBaseline('boundary', report(...RED));
    expect(proof).toContain(`${EXPECTED_BOUNDARY_ASSERTIONS.length} named assertion(s) RED`);
    expect(proof).toContain('0 unrelated failure(s) excluded');
    expect(LEGS.boundary).toEqual(EXPECTED_BOUNDARY_ASSERTIONS);
    expect(LEGS.face).toEqual(EXPECTED_FACE_ASSERTIONS);
  });

  it('accepts the face leg and counts an unrelated failure as excluded context', () => {
    const proof = assertForYouPlainLanguageBaseline(
      'face',
      report(...FACE_RED, assertion('a later-main test at the old base', 'failed', ['AssertionError: unrelated'])),
    );
    expect(proof).toContain(`${EXPECTED_FACE_ASSERTIONS.length} named assertion(s) RED`);
    expect(proof).toContain('1 unrelated failure(s) excluded');
  });

  it('rejects a named assertion that stayed GREEN at the base', () => {
    const [first = ''] = EXPECTED_BOUNDARY_ASSERTIONS;
    expect(() => assertForYouPlainLanguageBaseline('boundary', report(assertion(first, 'passed'), ...RED.slice(1))))
      .toThrow(/did not fail against the base|collected but GREEN/u);
  });

  it('rejects a named assertion that was never collected and exact-title drift', () => {
    expect(() => assertForYouPlainLanguageBaseline('boundary', report(...RED.slice(1))))
      .toThrow(/did not fail against the base/u);
    const [first = ''] = EXPECTED_FACE_ASSERTIONS;
    expect(() => assertForYouPlainLanguageBaseline('face', report(assertion(`prefix ${first}`, 'failed', ['AssertionError: x']))))
      .toThrow(/did not fail against the base/u);
  });

  it('rejects a named failure that is not an assertion failure', () => {
    const [first = ''] = EXPECTED_BOUNDARY_ASSERTIONS;
    expect(() => assertForYouPlainLanguageBaseline(
      'boundary',
      report(assertion(first, 'failed', ['TypeError: actual value must be a string']), ...RED.slice(1)),
    )).toThrow(/did not fail as an AssertionError|import\/setup reason|behavioral marker/u);
  });

  it('rejects an unknown leg and a collection/setup failure before any claim', () => {
    expect(() => assertForYouPlainLanguageBaseline('nope', report(...RED))).toThrow(/unknown leg/u);
    expect(() => assertForYouPlainLanguageBaseline('boundary', {
      numFailedTests: 1,
      testResults: [{ status: 'failed', message: 'Cannot find module "../src/notifications/center.js"', assertionResults: [] }],
    })).toThrow(/collection\/setup\/import failure/u);
  });

  it('the CLI entry really classifies: proof marker on accept, loud refusal on reject', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-plain-language-classifier-'));
    cleanupDirs.push(dir);
    const tool = join(import.meta.dirname, '..', 'tools', 'assert-for-you-plain-language-baseline.mjs');
    const acceptPath = join(dir, 'accept.json');
    const refusePath = join(dir, 'refuse.json');
    writeFileSync(acceptPath, JSON.stringify(report(...RED)));
    writeFileSync(refusePath, JSON.stringify(report(...RED.map((entry) => ({ ...entry, status: 'passed', failureMessages: [] })))));
    const accept = execFileSync(process.execPath, [tool, 'gc-570-red', acceptPath, 'boundary'], { encoding: 'utf-8' });
    expect(accept).toContain('for-you-plain-language (boundary):');
    expect(accept).toContain('named assertion(s) RED');
    let status = -1;
    let stderr = '';
    try {
      execFileSync(process.execPath, [tool, 'gc-570-red', refusePath, 'boundary'], { encoding: 'utf-8' });
    } catch (error) {
      const failure = error as { readonly status?: number; readonly stderr?: string };
      status = failure.status ?? -1;
      stderr = failure.stderr ?? '';
    }
    expect(status).toBe(2);
    expect(stderr).toContain('FAILS-BEFORE CLAIM BROKEN');
  });
});
