import { describe, expect, it } from 'vitest';
import { aggregatePropertyMetrics, PropertyMetricsError } from '../src/property/metrics.js';
import type {
  PropertyQualificationAttemptMetric,
  PropertyRunMetricRecord,
} from '../src/property/metrics.js';

/**
 * GH350 lane C metric split (issue §9, contract v3, Root correction 5):
 * `invalidOracles` counts ONLY observed vacuous/contradictory verdicts;
 * inconclusive/infrastructure/timeout/missing-evidence outcomes have
 * UNKNOWN validity, count as `unknownValidity`, and are never a result.
 * `totalQualificationAttempts` is the denominator. No generated-case
 * counts exist anywhere in the inputs.
 */

function attempt(
  verdict: PropertyQualificationAttemptMetric['verdict'],
  terminatingOutcomeKind: PropertyQualificationAttemptMetric['terminatingOutcomeKind'] = null,
): PropertyQualificationAttemptMetric {
  return { verdict, terminatingOutcomeKind };
}

function run(overrides: Partial<PropertyRunMetricRecord> & Pick<PropertyRunMetricRecord, 'outcomeKind'>): PropertyRunMetricRecord {
  return {
    durationMs: 1_000,
    tokenCost: null,
    attribution: null,
    replay: null,
    ...overrides,
  };
}

describe('GH350 metrics invalid-oracle vs unknown-validity split', () => {
  it('counts observed vacuous+contradictory oracles as invalidOracles and infrastructure failures as unknownValidity — never the reverse', () => {
    const snapshot = aggregatePropertyMetrics({
      attempts: [
        attempt('rejected-vacuous'),
        attempt('rejected-contradictory'),
        attempt('rejected-inconclusive', 'infrastructure-error'),
      ],
      runs: [],
      escapedRegressions: 0,
    });
    expect(snapshot.invalidOracles).toBe(2);
    expect(snapshot.unknownValidity).toBe(1);
    expect(snapshot.totalQualificationAttempts).toBe(3);
  });

  it('counts timeout-terminated attempts as unknownValidity, not invalidOracles (the control says nothing about the oracle)', () => {
    const snapshot = aggregatePropertyMetrics({
      attempts: [attempt('rejected-inconclusive', 'timeout')],
      runs: [],
      escapedRegressions: 0,
    });
    expect(snapshot.invalidOracles).toBe(0);
    expect(snapshot.unknownValidity).toBe(1);
  });

  it('counts missing-evidence and inconclusive terminations as unknownValidity', () => {
    const snapshot = aggregatePropertyMetrics({
      attempts: [
        attempt('rejected-inconclusive', 'inconclusive'),
        attempt('rejected-inconclusive', 'selection-failure'),
        attempt('escalated', 'not-run'),
      ],
      runs: [],
      escapedRegressions: 0,
    });
    expect(snapshot.invalidOracles).toBe(0);
    expect(snapshot.unknownValidity).toBe(3);
    expect(snapshot.totalQualificationAttempts).toBe(3);
  });

  it('counts qualified attempts as neither invalid nor unknown', () => {
    const snapshot = aggregatePropertyMetrics({
      attempts: [attempt('qualified'), attempt('qualified')],
      runs: [],
      escapedRegressions: 0,
    });
    expect(snapshot.invalidOracles).toBe(0);
    expect(snapshot.unknownValidity).toBe(0);
    expect(snapshot.totalQualificationAttempts).toBe(2);
  });

  it('refuses a decided verdict backed by a terminating outcome (contradictory evidence is never a metric)', () => {
    expect(() =>
      aggregatePropertyMetrics({ attempts: [attempt('qualified', 'timeout')], runs: [], escapedRegressions: 0 }),
    ).toThrowError(PropertyMetricsError);
  });

  it('refuses a validity-unknown verdict that does not name its terminating outcome', () => {
    expect(() =>
      aggregatePropertyMetrics({ attempts: [attempt('rejected-inconclusive', null)], runs: [], escapedRegressions: 0 }),
    ).toThrowError(PropertyMetricsError);
  });

  it('refuses a decisive outcome kind as a validity-unknown termination', () => {
    expect(() =>
      aggregatePropertyMetrics({ attempts: [attempt('rejected-inconclusive', 'pass')], runs: [], escapedRegressions: 0 }),
    ).toThrowError(PropertyMetricsError);
    expect(() =>
      aggregatePropertyMetrics({
        attempts: [attempt('escalated', 'property-failure')],
        runs: [],
        escapedRegressions: 0,
      }),
    ).toThrowError(PropertyMetricsError);
  });
});

describe('GH350 metrics defect attribution and cost', () => {
  it('counts only candidate-only qualified property failures as actionable defects — baseline-also-fails is never a new candidate defect', () => {
    const snapshot = aggregatePropertyMetrics({
      attempts: [attempt('qualified')],
      runs: [
        run({ outcomeKind: 'property-failure', attribution: 'candidate-only' }),
        run({ outcomeKind: 'property-failure', attribution: 'baseline-also-fails' }),
        run({ outcomeKind: 'property-failure', attribution: 'unattributed' }),
        run({ outcomeKind: 'pass', attribution: 'candidate-only' }),
      ],
      escapedRegressions: 0,
    });
    expect(snapshot.actionableDefects).toBe(1);
    expect(snapshot.executedRuns).toBe(4);
  });

  it('treats replayed counterexamples as reliability accounting, not new defects', () => {
    const snapshot = aggregatePropertyMetrics({
      attempts: [attempt('qualified')],
      runs: [
        run({ outcomeKind: 'property-failure', attribution: 'candidate-only' }),
        run({ outcomeKind: 'property-failure', attribution: 'candidate-only', replay: { attempted: true, reproduced: true } }),
      ],
      escapedRegressions: 0,
    });
    expect(snapshot.actionableDefects).toBe(1);
    expect(snapshot.replayReliability).toEqual({ replayed: 1, reproduced: 1 });
  });

  it('counts attempted-but-not-reproduced replays honestly in reliability', () => {
    const snapshot = aggregatePropertyMetrics({
      attempts: [],
      runs: [
        run({ outcomeKind: 'property-failure', replay: { attempted: true, reproduced: false } }),
        run({ outcomeKind: 'property-failure', replay: { attempted: true, reproduced: true } }),
      ],
      escapedRegressions: 0,
    });
    expect(snapshot.replayReliability).toEqual({ replayed: 2, reproduced: 1 });
  });

  it('excludes not-run records from executedRuns and refuses a replay claim on a run that never executed', () => {
    const snapshot = aggregatePropertyMetrics({
      attempts: [],
      runs: [run({ outcomeKind: 'not-run', durationMs: 0 }), run({ outcomeKind: 'pass' })],
      escapedRegressions: 0,
    });
    expect(snapshot.executedRuns).toBe(1);
    expect(() =>
      aggregatePropertyMetrics({
        attempts: [],
        runs: [run({ outcomeKind: 'not-run', replay: { attempted: true, reproduced: false } })],
        escapedRegressions: 0,
      }),
    ).toThrowError(PropertyMetricsError);
  });

  it('keeps totalTokenCost null while any component cost is unknown, and sums when all are known', () => {
    const unknown = aggregatePropertyMetrics({
      attempts: [],
      runs: [run({ outcomeKind: 'pass', tokenCost: 100 }), run({ outcomeKind: 'pass', tokenCost: null })],
      escapedRegressions: 0,
    });
    expect(unknown.totalTokenCost).toBeNull();
    const known = aggregatePropertyMetrics({
      attempts: [],
      runs: [run({ outcomeKind: 'pass', tokenCost: 100 }), run({ outcomeKind: 'pass', tokenCost: 250 })],
      escapedRegressions: 0,
    });
    expect(known.totalTokenCost).toBe(350);
  });

  it('sums execution time across all records', () => {
    const snapshot = aggregatePropertyMetrics({
      attempts: [],
      runs: [run({ outcomeKind: 'pass', durationMs: 1_500 }), run({ outcomeKind: 'timeout', durationMs: 120_000 })],
      escapedRegressions: 0,
    });
    expect(snapshot.totalExecutionMs).toBe(121_500);
  });

  it('refuses negative or fractional escapedRegressions and invalid run records', () => {
    expect(() =>
      aggregatePropertyMetrics({ attempts: [], runs: [], escapedRegressions: -1 }),
    ).toThrowError(PropertyMetricsError);
    expect(() =>
      aggregatePropertyMetrics({ attempts: [], runs: [run({ outcomeKind: 'pass', durationMs: Number.NaN })], escapedRegressions: 0 }),
    ).toThrowError(PropertyMetricsError);
    expect(() =>
      aggregatePropertyMetrics({
        attempts: [],
        runs: [run({ outcomeKind: 'pass', replay: { attempted: false, reproduced: true } })],
        escapedRegressions: 0,
      }),
    ).toThrowError(PropertyMetricsError);
  });

  it('passes escaped regressions through as an observed input counter', () => {
    const snapshot = aggregatePropertyMetrics({ attempts: [], runs: [], escapedRegressions: 2 });
    expect(snapshot.escapedRegressions).toBe(2);
  });
});
