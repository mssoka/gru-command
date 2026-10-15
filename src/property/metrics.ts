import type { PropertyMetricsSnapshot, PropertyOutcomeKind, QualificationVerdict } from './types.js';
import type { BaselineAttribution } from './qualification.js';

/**
 * Effectiveness/cost aggregation for property contracts (issue §9,
 * contract v3 metric split).
 *
 * The split that matters (Root correction: never count unknown execution as
 * an invalid oracle):
 * - `invalidOracles` counts ONLY observed vacuous/contradictory verdicts —
 *   oracles we actually watched misbehave.
 * - `unknownValidity` counts attempts whose validity could NOT be observed
 *   (inconclusive, infrastructure, timeout, missing evidence): validity
 *   unknown, never a result and never an invalid-oracle count.
 * - `totalQualificationAttempts` is the shared denominator.
 *
 * The inputs deliberately carry NO generated-case counts: a snapshot can
 * never be improved by generating more cases. Defects count only qualified
 * property-failures attributed candidate-only (baseline-also-fails is
 * never a new candidate defect); replays are reliability accounting, not
 * new defects; total token cost is null while any component is unknown
 * rather than silently undercounted.
 */

/** One qualification attempt's metric record. */
export interface PropertyQualificationAttemptMetric {
  readonly verdict: QualificationVerdict;
  /**
   * The outcome kind that terminated the attempt when validity could not
   * be observed (inconclusive/infrastructure/timeout/missing evidence).
   * Required — and only valid — for `rejected-inconclusive`/`escalated`
   * verdicts; a decided verdict is an observed result and must carry null.
   */
  readonly terminatingOutcomeKind: PropertyOutcomeKind | null;
}

/** One executed property run with its qualification context. */
export interface PropertyRunMetricRecord {
  /** Outcome kind of the executed run (from the host receipt). */
  readonly outcomeKind: PropertyOutcomeKind;
  readonly durationMs: number;
  readonly tokenCost: number | null;
  /** Baseline attribution recorded at qualification/freeze time, if any. */
  readonly attribution: BaselineAttribution | null;
  /** Replay accounting when this run replayed a retained counterexample. */
  readonly replay: { readonly attempted: boolean; readonly reproduced: boolean } | null;
}

export interface PropertyMetricsInputs {
  readonly attempts: readonly PropertyQualificationAttemptMetric[];
  readonly runs: readonly PropertyRunMetricRecord[];
  /** Escaped regressions observed in production — an input counter, not
   * something this module can derive. */
  readonly escapedRegressions: number;
}

export class PropertyMetricsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertyMetricsError';
  }
}

const OBSERVED_INVALID_ORACLE_VERDICTS: ReadonlySet<string> = new Set(['rejected-vacuous', 'rejected-contradictory']);
const UNKNOWN_VALIDITY_VERDICTS: ReadonlySet<string> = new Set(['rejected-inconclusive', 'escalated']);
/** Outcome kinds that are observed results; everything else leaves the
 * attempt's validity unknown. */
const DECISIVE_OUTCOME_KINDS: ReadonlySet<string> = new Set(['pass', 'property-failure']);

function validateAttempt(attempt: PropertyQualificationAttemptMetric, index: number): void {
  const unknown = UNKNOWN_VALIDITY_VERDICTS.has(attempt.verdict);
  if (unknown && attempt.terminatingOutcomeKind === null) {
    throw new PropertyMetricsError(
      `attempts[${index}] verdict ${attempt.verdict} has validity UNKNOWN and must name the terminating ` +
        'outcome kind that prevented observation',
    );
  }
  if (!unknown && attempt.terminatingOutcomeKind !== null) {
    throw new PropertyMetricsError(
      `attempts[${index}] verdict ${attempt.verdict} is a decided (observed) verdict and cannot carry a ` +
        `terminating outcome (${attempt.terminatingOutcomeKind}) — a terminated run never produced that result`,
    );
  }
  if (attempt.terminatingOutcomeKind !== null && DECISIVE_OUTCOME_KINDS.has(attempt.terminatingOutcomeKind)) {
    throw new PropertyMetricsError(
      `attempts[${index}] terminating outcome ${attempt.terminatingOutcomeKind} is a decisive result, not a ` +
        'validity-unknown termination — contradictory evidence is never turned into a metric',
    );
  }
}

function validateRecord(record: PropertyRunMetricRecord, index: number): void {
  if (typeof record.durationMs !== 'number' || !Number.isFinite(record.durationMs) || record.durationMs < 0) {
    throw new PropertyMetricsError(`runs[${index}].durationMs must be a finite non-negative number`);
  }
  if (record.tokenCost !== null && (typeof record.tokenCost !== 'number' || !Number.isFinite(record.tokenCost) || record.tokenCost < 0)) {
    throw new PropertyMetricsError(`runs[${index}].tokenCost must be null or a finite non-negative number`);
  }
  if (record.replay !== null && record.replay.attempted === false && record.replay.reproduced) {
    throw new PropertyMetricsError(`runs[${index}].replay.reproduced is true while attempted is false`);
  }
  if (record.outcomeKind === 'not-run' && record.replay !== null && record.replay.attempted) {
    throw new PropertyMetricsError(
      `runs[${index}] has outcomeKind not-run but claims an attempted replay — nothing executed, nothing replayed`,
    );
  }
}

/** Aggregate attempt and run records into a metrics snapshot. Pure; no
 * case counts in, no case counts out, no absence turned into a result. */
export function aggregatePropertyMetrics(inputs: PropertyMetricsInputs): PropertyMetricsSnapshot {
  if (
    typeof inputs.escapedRegressions !== 'number' ||
    !Number.isInteger(inputs.escapedRegressions) ||
    inputs.escapedRegressions < 0
  ) {
    throw new PropertyMetricsError('escapedRegressions must be a non-negative integer');
  }
  inputs.attempts.forEach(validateAttempt);
  inputs.runs.forEach(validateRecord);

  let invalidOracles = 0;
  let unknownValidity = 0;
  for (const attempt of inputs.attempts) {
    if (OBSERVED_INVALID_ORACLE_VERDICTS.has(attempt.verdict)) invalidOracles += 1;
    else if (UNKNOWN_VALIDITY_VERDICTS.has(attempt.verdict)) unknownValidity += 1;
  }

  let actionableDefects = 0;
  let replayed = 0;
  let reproduced = 0;
  let executedRuns = 0;
  let totalExecutionMs = 0;
  let tokenCostKnown = true;
  let totalTokenCost = 0;

  for (const run of inputs.runs) {
    totalExecutionMs += run.durationMs;
    if (run.tokenCost === null) {
      tokenCostKnown = false;
    } else {
      totalTokenCost += run.tokenCost;
    }
    if (run.outcomeKind !== 'not-run') executedRuns += 1;
    if (run.replay !== null && run.replay.attempted) {
      replayed += 1;
      if (run.replay.reproduced) reproduced += 1;
      // A replay is reliability accounting for an already-counted defect —
      // reproducing a known counterexample is not a NEW actionable defect.
      continue;
    }
    if (
      run.outcomeKind === 'property-failure' &&
      run.attribution === 'candidate-only'
    ) {
      actionableDefects += 1;
    }
  }

  return {
    actionableDefects,
    invalidOracles,
    unknownValidity,
    totalQualificationAttempts: inputs.attempts.length,
    replayReliability: { replayed, reproduced },
    escapedRegressions: inputs.escapedRegressions,
    executedRuns,
    totalExecutionMs,
    totalTokenCost: tokenCostKnown ? totalTokenCost : null,
  };
}
