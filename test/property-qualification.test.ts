import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
  ExecutionReceiptRef,
  PropertyExecutionPlan,
  PropertyExecutionReceipt,
  PropertyProposal,
  PropertyRunOutcome,
  QualificationControlResult,
  RawExecutionReceipt,
  SealedExecutionReceipt,
} from '../src/property/types.js';
import { interpretVitestJsonReceipt } from '../src/property/adapters/vitest-fast-check.js';
import {
  attributeCounterexample,
  attributeCounterexampleWithHostEvidence,
  PropertyQualificationError,
  qualifyContract,
  qualifyContractWithHostEvidence,
  requiresEscalation,
  UntrustedRunEvidenceError,
} from '../src/property/qualification.js';
import type { RunEvidenceSource } from '../src/property/qualification.js';
import { canonicalJson, freeze, verifyFrozen } from '../src/property/freeze.js';
import type { CurrentOverlayState, FreezeOverlayInput } from '../src/property/freeze.js';

/**
 * GH350 lane C unit controls for qualification and frozen contracts.
 *
 * Control outcomes are derived from canned runner reports through the REAL
 * vitest adapter interpretation (seam A, committed at this base), so the
 * verdict table is exercised against runner-report-shaped evidence. The
 * production path is exercised through a fake host-evidence source whose
 * WeakSet registry stands in for seam B's executor issuance registry — the
 * same runtime-guard discipline the integrator will bind.
 */

const FIXTURES = fileURLToPath(new URL('./fixtures/property/qualification', import.meta.url));
const FILTER = 'test/property/ratio.test.ts';
const SOURCE_SHA = '5f2c19a7bd0e4b8f9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e';

function plan(): PropertyExecutionPlan {
  return {
    adapterId: 'vitest-fast-check',
    command: '/repo/node_modules/.bin/vitest',
    args: ['run', '--reporter=json', FILTER],
    cwd: '/repo',
    envAllowlist: ['PATH'],
    budget: { maxIterations: 100, maxShrinkSteps: 500, runTimeoutMs: 120_000, maxOutputBytes: 1_048_576 },
    executable: true,
    refusalReason: null,
  };
}

function rawFromFixture(name: string, exitCode: number): RawExecutionReceipt {
  return {
    exitCode,
    signal: null,
    timedOut: false,
    stdout: readFileSync(`${FIXTURES}/${name}`, 'utf-8'),
    stderr: '',
    durationMs: 900,
  };
}

function outcomeFromFixture(name: string, exitCode: number): PropertyRunOutcome {
  return interpretVitestJsonReceipt(rawFromFixture(name, exitCode), plan());
}

/** A hand-built outcome for shapes the honest adapter never emits (the
 * point: qualification must not trust self-declared kinds). */
function bareOutcome(overrides: Partial<PropertyRunOutcome> & Pick<PropertyRunOutcome, 'kind'>): PropertyRunOutcome {
  return {
    evidenceClass: 'runner-report-classification',
    selected: 2,
    executed: 2,
    skipped: 0,
    failed: 0,
    passed: 2,
    failures: [],
    unselectedFailures: [],
    reasons: [],
    matchedDiagnostic: null,
    receipt: { exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 100 },
    ...overrides,
  };
}

const controls = (knownBad: PropertyRunOutcome, healthy: PropertyRunOutcome) => ({
  runKnownBadControl: () => knownBad,
  runHealthyControl: () => healthy,
});

const proposal: PropertyProposal = {
  requirementRef: 'REQ-ratio-001: bounded, sign-correct ratio computation',
  invariant: 'For all finite (numerator, denominator) with denominator != 0, ratio(n, d) is a finite float with |ratio(n, d)| <= |n| / |d| and sign(ratio(n, d)) == sign(n) * sign(d).',
  inputDomain: 'arbitrary finite IEEE-754 floats with denominator != 0',
  invalidInputBehavior: 'denominator 0 or non-finite inputs throw RatioDomainError; never return a sentinel value',
  targetPackageDir: 'packages/ratio',
  adapterId: 'vitest-fast-check',
  testArtifactRefs: [
    { path: FILTER, sha256: 'aa11bb22cc33dd44ee55ff6677889900aabbccddeeff00112233445566778899' },
  ],
  establishes: 'the ratio function is bounded and sign-correct on the declared domain',
  doesNotEstablish: 'performance, allocation behavior, or anything outside the declared domain',
};

// ---------------------------------------------------------------------------
// Fake host-evidence source: WeakSet issuance registry + runtime guard,
// standing in for seam B's executor until the integrator binds it.
// ---------------------------------------------------------------------------

function receiptFor(outcome: PropertyRunOutcome): PropertyExecutionReceipt {
  return {
    identity: {
      source: { kind: 'clean-sha', sha: 'efd893058693a224a89954d73e39e45e4321b74f' },
      argv: ['/repo/node_modules/.bin/vitest', 'run', '--reporter=json', FILTER],
      selectionFilter: FILTER,
      lockIdentity: null,
      configIdentity: null,
      overlay: null,
      adapterProfile: 'vitest-fast-check',
      toolVersions: { vitest: '3.2.7', 'fast-check': '3.23.2' },
    },
    command: '/repo/node_modules/.bin/vitest',
    cwd: '/repo',
    outcome,
    outputs: [],
    capture: { stdoutTruncated: false, stderrTruncated: false, complete: true },
    counterexample: null,
    sandbox: {
      backend: 'macos-sandbox-exec',
      profileSummary: 'deny network; isolate filesystem to the workspace copy',
      networkDenied: true,
      filesystemIsolated: true,
      credentialsStripped: true,
      refusalReason: null,
    },
    replay: null,
    budget: plan().budget,
  };
}

function fakeEvidenceSource() {
  const issued = new WeakSet<object>();
  const byId = new Map<string, PropertyExecutionReceipt>();
  const source: RunEvidenceSource = {
    resolve: (ref) => byId.get(ref.receiptId) ?? null,
    guard: (candidate): candidate is SealedExecutionReceipt =>
      typeof candidate === 'object' && candidate !== null && issued.has(candidate),
  };
  return {
    source,
    /** Issue a host receipt (registry + guard will accept it). */
    issue: (outcome: PropertyRunOutcome, receiptId: string): ExecutionReceiptRef => {
      const r = receiptFor(outcome);
      issued.add(r);
      byId.set(receiptId, r);
      return { receiptId };
    },
    /** Resolvable but NEVER issued — a forged/cloned object the guard must reject. */
    registerUnissued: (outcome: PropertyRunOutcome, receiptId: string): ExecutionReceiptRef => {
      byId.set(receiptId, receiptFor(outcome));
      return { receiptId };
    },
  };
}

// ---------------------------------------------------------------------------
// Qualification verdict table
// ---------------------------------------------------------------------------

describe('GH350 qualification verdicts (injected unit controls)', () => {
  it('qualifies when a relevant known-bad implementation fails and the healthy reference passes with executed(selected) > 0', () => {
    const knownBad = outcomeFromFixture('known-bad-fails.report.json', 1);
    const healthy = outcomeFromFixture('healthy-passes.report.json', 0);
    expect(knownBad.kind).toBe('property-failure');
    expect(healthy.kind).toBe('pass');
    const record = qualifyContract(proposal, controls(knownBad, healthy));
    expect(record.verdict).toBe('qualified');
    expect(record.frozen).toBeNull();
    expect(requiresEscalation(record.verdict)).toBe(false);
  });

  it('rejects the oracle as vacuous when the known-bad always-0.0 ratio calculator passes the nonnegative-finite-float property (issue example)', () => {
    // Issue §problem: "a ratio calculator that always returns 0.0 satisfies
    // 'returns a nonnegative finite float' while calculating nothing
    // useful." The known-bad control run PASSES, so the property holds on
    // an implementation known to violate the requirement: vacuous oracle.
    const knownBad = outcomeFromFixture('known-bad-always-0.0-passes-vacuous.report.json', 0);
    const healthy = outcomeFromFixture('healthy-passes.report.json', 0);
    expect(knownBad.kind).toBe('pass');
    const record = qualifyContract(proposal, controls(knownBad, healthy));
    expect(record.verdict).toBe('rejected-vacuous');
    expect(record.reasons.join(' ')).toContain('vacuous');
    expect(record.frozen).toBeNull();
  });

  it('rejects as inconclusive with validity UNKNOWN when the known-bad control only hit an infrastructure error', () => {
    const knownBad = interpretVitestJsonReceipt(
      { exitCode: null, signal: 'SIGKILL', timedOut: false, stdout: '', stderr: '', durationMs: 300 },
      plan(),
    );
    const healthy = outcomeFromFixture('healthy-passes.report.json', 0);
    expect(knownBad.kind).toBe('infrastructure-error');
    const record = qualifyContract(proposal, controls(knownBad, healthy));
    expect(record.verdict).toBe('rejected-inconclusive');
    expect(record.reasons.join(' ')).toContain('UNKNOWN');
  });

  it('rejects as inconclusive with validity UNKNOWN when the known-bad control timed out', () => {
    const knownBad = interpretVitestJsonReceipt(
      { exitCode: null, signal: null, timedOut: true, stdout: '', stderr: '', durationMs: 120_000 },
      plan(),
    );
    const healthy = outcomeFromFixture('healthy-passes.report.json', 0);
    expect(knownBad.kind).toBe('timeout');
    const record = qualifyContract(proposal, controls(knownBad, healthy));
    expect(record.verdict).toBe('rejected-inconclusive');
  });

  it('rejects as inconclusive when a known-bad property-failure lacks matched failing-assertion evidence', () => {
    const knownBad = bareOutcome({
      kind: 'property-failure',
      failed: 1,
      passed: 1,
      failures: [],
      receipt: { exitCode: 1, signal: null, timedOut: false, stdout: '', stderr: '', durationMs: 100 },
    });
    const healthy = outcomeFromFixture('healthy-passes.report.json', 0);
    const record = qualifyContract(proposal, controls(knownBad, healthy));
    expect(record.verdict).toBe('rejected-inconclusive');
    expect(record.reasons.join(' ')).toContain('missing evidence');
  });

  it('rejects as contradictory when the healthy reference fails the property identically to the known-bad (escalated)', () => {
    const knownBad = outcomeFromFixture('known-bad-fails.report.json', 1);
    const healthy = outcomeFromFixture('healthy-fails-contradictory.report.json', 1);
    expect(healthy.kind).toBe('property-failure');
    const record = qualifyContract(proposal, controls(knownBad, healthy));
    expect(record.verdict).toBe('rejected-contradictory');
    expect(record.reasons.join(' ')).toContain('escalation-required');
    expect(requiresEscalation(record.verdict)).toBe(true);
    expect(record.frozen).toBeNull();
  });

  it('escalates when the healthy control hit a harness-level refusal (infrastructure-error), never blaming the oracle', () => {
    const knownBad = outcomeFromFixture('known-bad-fails.report.json', 1);
    const healthy = interpretVitestJsonReceipt(
      { exitCode: null, signal: 'SIGKILL', timedOut: false, stdout: '', stderr: '', durationMs: 300 },
      plan(),
    );
    expect(healthy.kind).toBe('infrastructure-error');
    const record = qualifyContract(proposal, controls(knownBad, healthy));
    expect(record.verdict).toBe('escalated');
    expect(record.reasons.join(' ')).toContain('harness-level refusal');
    expect(requiresEscalation(record.verdict)).toBe(true);
  });

  it('rejects as inconclusive when the healthy control reports pass with zero executed tests (never a pass)', () => {
    const knownBad = outcomeFromFixture('known-bad-fails.report.json', 1);
    const healthy = bareOutcome({ kind: 'pass', selected: 2, executed: 0, passed: 0 });
    const record = qualifyContract(proposal, controls(knownBad, healthy));
    expect(record.verdict).toBe('rejected-inconclusive');
    expect(record.reasons.join(' ')).toContain('never a pass');
  });
});

// ---------------------------------------------------------------------------
// Baseline attribution
// ---------------------------------------------------------------------------

describe('GH350 baseline attribution', () => {
  it('attributes a failure that also fails on the baseline as baseline-also-fails — never a new candidate defect', () => {
    const candidate = outcomeFromFixture('known-bad-fails.report.json', 1);
    const baseline = outcomeFromFixture('healthy-fails-contradictory.report.json', 1);
    expect(attributeCounterexample(candidate, baseline)).toBe('baseline-also-fails');
  });

  it('attributes candidate-only when the baseline passes credibly', () => {
    const candidate = outcomeFromFixture('known-bad-fails.report.json', 1);
    const baseline = outcomeFromFixture('healthy-passes.report.json', 0);
    expect(attributeCounterexample(candidate, baseline)).toBe('candidate-only');
  });

  it('attributes unattributed when the baseline is missing or undecided', () => {
    const candidate = outcomeFromFixture('known-bad-fails.report.json', 1);
    expect(attributeCounterexample(candidate, null)).toBe('unattributed');
    const timedOut = interpretVitestJsonReceipt(
      { exitCode: null, signal: null, timedOut: true, stdout: '', stderr: '', durationMs: 120_000 },
      plan(),
    );
    expect(attributeCounterexample(candidate, timedOut)).toBe('unattributed');
  });

  it('refuses attribution for a non-property-failure candidate outcome (named error)', () => {
    const healthy = outcomeFromFixture('healthy-passes.report.json', 0);
    expect(() => attributeCounterexample(healthy, null)).toThrowError(PropertyQualificationError);
  });
});

// ---------------------------------------------------------------------------
// Production path: host-issued evidence only
// ---------------------------------------------------------------------------

describe('GH350 production qualification accepts only host-issued evidence', () => {
  it('qualifies through sealed host receipts and binds control results to their receipt refs (never self-supplied hashes)', () => {
    const fake = fakeEvidenceSource();
    const knownBadRef = fake.issue(outcomeFromFixture('known-bad-fails.report.json', 1), 'rcpt-knownbad-1');
    const healthyRef = fake.issue(outcomeFromFixture('healthy-passes.report.json', 0), 'rcpt-healthy-1');
    const result = qualifyContractWithHostEvidence(proposal, knownBadRef, healthyRef, fake.source);
    expect(result.record.verdict).toBe('qualified');
    expect(result.knownBadControl.receiptRef).toEqual(knownBadRef);
    expect(result.healthyControl.receiptRef).toEqual(healthyRef);
    expect(result.knownBadControl.satisfied).toBe(true);
    expect(result.healthyControl.satisfied).toBe(true);
  });

  it('marks the known-bad control unsatisfied on a vacuous pass, so freeze can never proceed from it', () => {
    const fake = fakeEvidenceSource();
    const knownBadRef = fake.issue(outcomeFromFixture('known-bad-always-0.0-passes-vacuous.report.json', 0), 'rcpt-knownbad-2');
    const healthyRef = fake.issue(outcomeFromFixture('healthy-passes.report.json', 0), 'rcpt-healthy-2');
    const result = qualifyContractWithHostEvidence(proposal, knownBadRef, healthyRef, fake.source);
    expect(result.record.verdict).toBe('rejected-vacuous');
    expect(result.knownBadControl.satisfied).toBe(false);
    expect(result.healthyControl.satisfied).toBe(true);
  });

  it('rejects an unresolvable receipt reference with a named error (missing evidence)', () => {
    const fake = fakeEvidenceSource();
    const healthyRef = fake.issue(outcomeFromFixture('healthy-passes.report.json', 0), 'rcpt-healthy-3');
    expect(() =>
      qualifyContractWithHostEvidence(proposal, { receiptId: 'never-issued' }, healthyRef, fake.source),
    ).toThrowError(UntrustedRunEvidenceError);
  });

  it('rejects a forged (resolvable but never issued) receipt object with a named error — the runtime guard decides', () => {
    const fake = fakeEvidenceSource();
    const forgedRef = fake.registerUnissued(outcomeFromFixture('known-bad-fails.report.json', 1), 'rcpt-forged');
    const healthyRef = fake.issue(outcomeFromFixture('healthy-passes.report.json', 0), 'rcpt-healthy-4');
    expect(() => qualifyContractWithHostEvidence(proposal, forgedRef, healthyRef, fake.source)).toThrowError(
      UntrustedRunEvidenceError,
    );
  });

  it('attributes through sealed host evidence (baseline-also-fails via refs)', () => {
    const fake = fakeEvidenceSource();
    const candidateRef = fake.issue(outcomeFromFixture('known-bad-fails.report.json', 1), 'rcpt-candidate');
    const baselineRef = fake.issue(outcomeFromFixture('healthy-fails-contradictory.report.json', 1), 'rcpt-baseline');
    expect(attributeCounterexampleWithHostEvidence(candidateRef, baselineRef, fake.source)).toBe('baseline-also-fails');
    expect(attributeCounterexampleWithHostEvidence(candidateRef, null, fake.source)).toBe('unattributed');
  });
});

// ---------------------------------------------------------------------------
// Frozen contracts
// ---------------------------------------------------------------------------

const MANDATORY_SEED = '-1731691812';
const OVERLAY_SHA = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';

function overlayInput(overrides: Partial<FreezeOverlayInput> = {}): FreezeOverlayInput {
  return {
    files: [
      {
        path: FILTER,
        sha256: '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d1e0f9a8b',
        bytes: 1_024,
        selectionFilter: FILTER,
      },
    ],
    mandatorySeeds: [MANDATORY_SEED],
    overlaySha256: OVERLAY_SHA,
    sourceSha256: SOURCE_SHA,
    ...overrides,
  };
}

function currentOverlay(state: Partial<CurrentOverlayState> = {}): CurrentOverlayState {
  return { files: overlayInput().files, exercisedSeeds: [MANDATORY_SEED], ...state };
}

function satisfiedControls(): {
  readonly knownBadControl: QualificationControlResult;
  readonly healthyControl: QualificationControlResult;
} {
  return {
    knownBadControl: {
      receiptRef: { receiptId: 'rcpt-knownbad-frozen' },
      satisfied: true,
      detail: 'known-bad control failed the property (2 failing assertion(s) matched to the selection)',
    },
    healthyControl: {
      receiptRef: { receiptId: 'rcpt-healthy-frozen' },
      satisfied: true,
      detail: 'healthy control passed with executed(selected) = 2/2',
    },
  };
}

describe('GH350 frozen contracts', () => {
  it('freezes satisfied controls with a deterministic frozenAtSha256 over canonical JSON and preserves receipt refs', () => {
    const frozen = freeze(proposal, overlayInput(), satisfiedControls(), 'candidate-only');
    expect(frozen.baselineAttribution).toBe('candidate-only');
    expect(frozen.knownBadControl.receiptRef.receiptId).toBe('rcpt-knownbad-frozen');
    expect(frozen.healthyControl.receiptRef.receiptId).toBe('rcpt-healthy-frozen');
    const expected = createHash('sha256')
      .update(
        canonicalJson({
          proposal: frozen.proposal,
          frozenOverlay: frozen.frozenOverlay,
          knownBadControl: frozen.knownBadControl,
          healthyControl: frozen.healthyControl,
          baselineAttribution: frozen.baselineAttribution,
          frozenSourceSha256: frozen.frozenSourceSha256,
        }),
        'utf-8',
      )
      .digest('hex');
    expect(frozen.frozenAtSha256).toBe(expected);
    // Deterministic: the same inputs freeze to the same hash.
    expect(freeze(proposal, overlayInput(), satisfiedControls(), 'candidate-only').frozenAtSha256).toBe(
      frozen.frozenAtSha256,
    );
  });

  it('refuses to freeze when either control is not satisfied (never freezes an unqualified oracle)', () => {
    const unsatisfiedKnownBad = {
      ...satisfiedControls(),
      knownBadControl: { receiptRef: { receiptId: 'rcpt-knownbad-frozen' }, satisfied: false, detail: 'known-bad passed — vacuous' },
    };
    expect(() => freeze(proposal, overlayInput(), unsatisfiedKnownBad, 'candidate-only')).toThrowError(/known-bad control is not satisfied/);
    const unsatisfiedHealthy = {
      ...satisfiedControls(),
      healthyControl: { receiptRef: { receiptId: 'rcpt-healthy-frozen' }, satisfied: false, detail: 'healthy failed' },
    };
    expect(() => freeze(proposal, overlayInput(), unsatisfiedHealthy, 'candidate-only')).toThrowError(/healthy control is not satisfied/);
  });

  it('refuses control results that lack a host receipt reference', () => {
    const noRef = {
      knownBadControl: { satisfied: true, detail: 'known-bad failed' },
      healthyControl: satisfiedControls().healthyControl,
    } as unknown as Parameters<typeof freeze>[2];
    expect(() => freeze(proposal, overlayInput(), noRef, 'candidate-only')).toThrowError(/receiptRef/);
  });

  it('verifyFrozen passes with the identical overlay, seeds and source', () => {
    const frozen = freeze(proposal, overlayInput(), satisfiedControls(), 'candidate-only');
    const result = verifyFrozen(frozen, currentOverlay(), SOURCE_SHA);
    expect(result.requalificationRequired).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('verifyFrozen detects a deleted overlay file and requires requalification — never repairs', () => {
    const frozen = freeze(proposal, overlayInput(), satisfiedControls(), 'candidate-only');
    const result = verifyFrozen(frozen, currentOverlay({ files: [] }), SOURCE_SHA);
    expect(result.requalificationRequired).toBe(true);
    expect(result.reasons.join(' ')).toContain('deleted-file');
  });

  it('verifyFrozen detects an altered file hash and byte count', () => {
    const frozen = freeze(proposal, overlayInput(), satisfiedControls(), 'candidate-only');
    const altered = currentOverlay({
      files: [
        {
          path: FILTER,
          sha256: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
          bytes: 2_048,
          selectionFilter: FILTER,
        },
      ],
    });
    const result = verifyFrozen(frozen, altered, SOURCE_SHA);
    expect(result.requalificationRequired).toBe(true);
    expect(result.reasons.join(' ')).toContain('altered-file');
  });

  it('verifyFrozen detects a narrowed selection filter', () => {
    const frozen = freeze(proposal, overlayInput(), satisfiedControls(), 'candidate-only');
    const narrowed = currentOverlay({
      files: [{ ...overlayInput().files[0]!, selectionFilter: `${FILTER}?name=other` }],
    });
    const result = verifyFrozen(frozen, narrowed, SOURCE_SHA);
    expect(result.requalificationRequired).toBe(true);
    expect(result.reasons.join(' ')).toContain('narrowed-selection-filter');
  });

  it('verifyFrozen detects a frozen-seed exclusion (generator excluded the counterexample)', () => {
    const frozen = freeze(proposal, overlayInput(), satisfiedControls(), 'candidate-only');
    const excluded = currentOverlay({ exercisedSeeds: ['884123765'] });
    const result = verifyFrozen(frozen, excluded, SOURCE_SHA);
    expect(result.requalificationRequired).toBe(true);
    expect(result.reasons.join(' ')).toContain('generator-excluded-counterexample');
  });

  it('verifyFrozen detects source drift as stale evidence', () => {
    const frozen = freeze(proposal, overlayInput(), satisfiedControls(), 'candidate-only');
    const result = verifyFrozen(frozen, currentOverlay(), '1111111111111111111111111111111111111111111111111111111111111111');
    expect(result.requalificationRequired).toBe(true);
    expect(result.reasons.join(' ')).toContain('source-changed');
  });

  it('verifyFrozen detects tampering with the persisted frozen contract itself (frozenAtSha256 mismatch)', () => {
    const frozen = freeze(proposal, overlayInput(), satisfiedControls(), 'candidate-only');
    const tampered = {
      ...frozen,
      proposal: { ...frozen.proposal, invariant: 'tampered: the property now asserts nothing' },
    };
    const result = verifyFrozen(tampered, currentOverlay(), SOURCE_SHA);
    expect(result.requalificationRequired).toBe(true);
    expect(result.reasons.join(' ')).toContain('frozen-at-hash-mismatch');
  });
});
