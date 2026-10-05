import { describe, expect, it } from 'vitest';
import {
  appendRecordedVerification,
  renderRecordedVerification,
  VERIFICATION_COMPLETED_EVENT,
  VERIFICATION_EVIDENCE_MAX_BYTES,
} from '../src/verify/evidence.js';
import { FROZEN_SPEC_MAX_BYTES } from '../src/dispatch/perkins-review/artifacts.js';
import type { EventRecord } from '../src/ledger/api.js';

/**
 * Recorded verification evidence: only a completed run whose SHA matches
 * the frozen review target and whose tracked tree was clean binds; the
 * tests lens weighs this ledger-backed block instead of pasted reports.
 */

const TARGET = 'a'.repeat(40);

function event(payload: Record<string, unknown>, ts = '2026-09-22T12:00:00.000Z'): EventRecord {
  return {
    seq: 1,
    ts,
    kind: VERIFICATION_COMPLETED_EVENT,
    agentId: null,
    jobId: 'job-verify',
    roundId: null,
    lens: null,
    payload,
  };
}

function passingPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: 'run-1',
    scope: 'full',
    command: 'npm test',
    sha: TARGET,
    tracked_dirty: false,
    ok: true,
    exit_code: 0,
    signal: null,
    timed_out: false,
    duration_ms: 12_345,
    workers: 6,
    output_bytes: 4096,
    output_sha256: 'b'.repeat(64),
    ...overrides,
  };
}

describe('recorded verification evidence', () => {
  it('renders a matching clean run as a delimited, ledger-backed block', () => {
    const block = renderRecordedVerification(event(passingPayload()), TARGET);
    expect(block).not.toBeNull();
    expect(block).toContain('HOST-RECORDED VERIFICATION');
    expect(block).toContain('scope: full');
    expect(block).toContain('command: npm test');
    expect(block).toContain('result: PASS (exit 0)');
    expect(block).toContain(`sha: ${TARGET} (matches the frozen review target)`);
    expect(block).toContain('duration_ms: 12345');
    expect(block).toContain(`output_sha256: ${'b'.repeat(64)}`);
    expect(block).toContain('END HOST-RECORDED VERIFICATION');
    expect(Buffer.byteLength(block!, 'utf8')).toBeLessThan(VERIFICATION_EVIDENCE_MAX_BYTES);
  });

  it('does not bind a run recorded against a different sha', () => {
    expect(renderRecordedVerification(event(passingPayload({ sha: 'c'.repeat(40) })), TARGET)).toBeNull();
    expect(renderRecordedVerification(event(passingPayload({ sha: null })), TARGET)).toBeNull();
    expect(renderRecordedVerification(null, TARGET)).toBeNull();
    expect(renderRecordedVerification(event(passingPayload({ tracked_dirty: true })), TARGET)).toBeNull();
  });

  it('renders failures and timeouts as recorded FAIL evidence', () => {
    const failed = renderRecordedVerification(
      event(passingPayload({ ok: false, exit_code: 3, timed_out: false })),
      TARGET,
    );
    expect(failed).toContain('result: FAIL (exit 3)');
    const timedOut = renderRecordedVerification(
      event(passingPayload({ ok: false, exit_code: null, signal: 'SIGTERM', timed_out: true })),
      TARGET,
    );
    expect(timedOut).toContain('result: FAIL (timed out)');
    const signaled = renderRecordedVerification(
      event(passingPayload({ ok: false, exit_code: null, signal: 'SIGKILL', timed_out: false })),
      TARGET,
    );
    expect(signaled).toContain('result: FAIL (signal SIGKILL)');
  });

  it('requires a well-formed payload (no half-evidence ever renders)', () => {
    expect(renderRecordedVerification(event({}), TARGET)).toBeNull();
    expect(renderRecordedVerification(event({ ...passingPayload(), scope: undefined }), TARGET)).toBeNull();
    expect(renderRecordedVerification({ ts: 'x', payload: 'not-an-object' }, TARGET)).toBeNull();
  });

  it('requires the complete receipt bindings — run id + output length/hash (issue #159)', () => {
    expect(renderRecordedVerification(event(passingPayload({ run_id: undefined })), TARGET)).toBeNull();
    expect(renderRecordedVerification(event(passingPayload({ output_bytes: undefined })), TARGET)).toBeNull();
    expect(renderRecordedVerification(event(passingPayload({ output_sha256: undefined })), TARGET)).toBeNull();
    expect(renderRecordedVerification(event(passingPayload({ output_sha256: '' })), TARGET)).toBeNull();
    // The complete receipt still renders with all bindings present.
    const complete = renderRecordedVerification(event(passingPayload()), TARGET);
    expect(complete).toContain('run_id: run-1');
    expect(complete).toContain('output_bytes: 4096');
  });

  it('appends the block to the spec and skips it when the frozen bound would be exceeded', () => {
    const evidence = renderRecordedVerification(event(passingPayload()), TARGET);
    expect(evidence).not.toBeNull();
    const spec = 'Acceptance: answer returns 43.';
    const combined = appendRecordedVerification({ spec, evidence });
    expect(combined).toBe(`${spec}\n\n${evidence}`);
    expect(combined.startsWith(spec)).toBe(true);
    // gh-169: no binding run is EXPLICIT — the UNAVAILABLE disclosure
    // freezes beside the spec instead of silence, still prefixed by the
    // original spec bytes (the acceptance hash binds that prefix).
    const absence = appendRecordedVerification({ spec, evidence: null });
    expect(absence.startsWith(spec)).toBe(true);
    expect(absence).toContain('--- HOST-RECORDED VERIFICATION');
    expect(absence).toContain('state: UNAVAILABLE — NO BOUND VERIFICATION RUN');
    expect(absence).toContain('not a pass and not a measured failure');
    // A spec at the frozen bound swallows a REAL block (loud log, never a
    // throw) — but the absence disclosure itself cannot be swallowed: a
    // spec with no room for it refuses the freeze (no silent packet).
    const logs: string[] = [];
    const huge = 'x'.repeat(FROZEN_SPEC_MAX_BYTES - 10);
    const skipped = appendRecordedVerification({
      spec: huge,
      evidence,
      log: (level, msg) => logs.push(`${level}:${msg}`),
    });
    expect(skipped).toBe(huge);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('frozen spec bound exceeded');
    expect(() => appendRecordedVerification({ spec: huge, evidence: null })).toThrow(
      /no room for the verification-absence disclosure/u,
    );
  });
});
