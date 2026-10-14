import { parsePropertyProposal } from './proposal.js';
import type {
  ExecutionReceiptGuard,
  ExecutionReceiptRef,
  FrozenContract,
  PropertyProposal,
  PropertyRunOutcome,
  QualificationControlResult,
  QualificationRecord,
  QualificationVerdict,
  SealedExecutionReceipt,
} from './types.js';

/**
 * GH350 qualification (issue §4): the ONLY seam that may call a
 * runner-report outcome a qualified contract result — and only when the
 * known-bad control genuinely failed the property AND the healthy control
 * genuinely passed it.
 *
 * Two entry classes, deliberately separate:
 *
 * 1. UNIT (pure injection): `qualifyContract` consumes interpreted
 *    `PropertyRunOutcome` controls handed in by the test. Nothing is
 *    spawned here; this exists so the verdict table is deterministically
 *    testable without execution.
 *
 * 2. PRODUCTION (host evidence only): `qualifyContractWithHostEvidence`
 *    accepts ONLY `ExecutionReceiptRef` references resolved through the
 *    `RunEvidenceSource` seam and verified at RUNTIME by the executor's
 *    `ExecutionReceiptGuard`. A caller-supplied outcome object, an
 *    unresolvable ref or a forged/cloned/mutated receipt is rejected with
 *    a named error — reviewer proposals and arbitrary typed objects can
 *    never impersonate host execution evidence.
 *
 * The executor module (seam B) is not present at this lane's frozen base,
 * so `RunEvidenceSource` is the narrow binding seam defined HERE; the
 * integrator binds it to the executor's issuance registry + guard.
 */

/** How a counterexample attributes between baseline and candidate. */
export type BaselineAttribution = FrozenContract['baselineAttribution'];

/** Injected control runs: host-owned execution, never spawned here. */
export interface QualificationControls {
  readonly runKnownBadControl: () => PropertyRunOutcome;
  readonly runHealthyControl: () => PropertyRunOutcome;
}

/**
 * Narrow seam to the executor's host-issued evidence. `resolve` returns
 * the receipt candidate for a reference (or null/throws when unresolvable);
 * `guard` is the executor's own issuance-registry guard applied AT RUNTIME
 * by this module before any receipt is trusted. The integrator binds both
 * to seam B's exported executor surface.
 */
export interface RunEvidenceSource {
  readonly resolve: (ref: ExecutionReceiptRef) => unknown;
  readonly guard: ExecutionReceiptGuard;
}

export class PropertyQualificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertyQualificationError';
  }
}

/** Missing, unresolvable, forged, cloned or mutated run evidence. */
export class UntrustedRunEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UntrustedRunEvidenceError';
  }
}

/** Outcome kinds that mean the harness itself refused or broke down — the
 * oracle is not to blame, so the record escalates instead of rejecting it. */
const HARNESS_REFUSAL_KINDS: ReadonlySet<string> = new Set(['infrastructure-error', 'not-run', 'unsupported']);

const ESCALATION_NOTE =
  'escalation-required: a contradictory oracle (the property also fails the healthy/reference implementation) ' +
  'is escalated for human review per policy — it is never forced onto production code';

/**
 * Credible pass per the shared contract: selected and executed tests, all
 * passed, no failing or unselected assertions, clean exit, no timeout.
 * Zero selected or zero executed is never a pass.
 */
function isCrediblePass(outcome: PropertyRunOutcome): boolean {
  return outcome.selected > 0 &&
    outcome.executed > 0 &&
    outcome.failed === 0 &&
    outcome.failures.length === 0 &&
    outcome.unselectedFailures.length === 0 &&
    outcome.receipt.exitCode === 0 &&
    !outcome.receipt.timedOut;
}

/** A property-failure is only credible with failing-assertion evidence
 * matched to the selection (an empty failure list is missing evidence). */
function isCrediblePropertyFailure(outcome: PropertyRunOutcome): boolean {
  return outcome.failures.length > 0 && outcome.failed > 0;
}

function outcomeSummary(outcome: PropertyRunOutcome): string {
  return `kind=${outcome.kind}, selected=${outcome.selected}, executed=${outcome.executed}, ` +
    `failed=${outcome.failed}, unselected=${outcome.unselectedFailures.length}, ` +
    `exitCode=${String(outcome.receipt.exitCode)}, signal=${String(outcome.receipt.signal)}, ` +
    `timedOut=${String(outcome.receipt.timedOut)}`;
}

function inconclusive(reasons: readonly string[]): QualificationRecord {
  return { verdict: 'rejected-inconclusive', reasons, frozen: null };
}

function verdictForControlPair(knownBad: PropertyRunOutcome, healthy: PropertyRunOutcome): QualificationRecord {
  if (knownBad.kind === 'pass') {
    if (!isCrediblePass(knownBad)) {
      return inconclusive([
        `known-bad control reports pass but its evidence is not self-consistent ` +
          `(${outcomeSummary(knownBad)}) — zero selected/executed or disclosed failures are never a pass`,
      ]);
    }
    return {
      verdict: 'rejected-vacuous',
      reasons: [
        'known-bad control PASSED: the property holds on an implementation that is known to violate the ' +
          'requirement (e.g. a ratio calculator that always returns 0.0 satisfies "returns a nonnegative ' +
          'finite float" while calculating nothing useful), so the oracle is vacuous',
      ],
      frozen: null,
    };
  }

  if (knownBad.kind === 'property-failure') {
    if (!isCrediblePropertyFailure(knownBad)) {
      return inconclusive([
        'known-bad control reports property-failure without failing-assertion evidence matched to the ' +
          `selection (${outcomeSummary(knownBad)}) — missing evidence, nothing is asserted about the contract`,
      ]);
    }
    switch (healthy.kind) {
      case 'pass': {
        if (!isCrediblePass(healthy)) {
          return inconclusive([
            `known-bad control failed the property (${knownBad.failures.length} failing assertion(s)), but the ` +
              `healthy control reports pass without credible evidence (${outcomeSummary(healthy)}) — ` +
              'zero selected/executed is never a pass',
          ]);
        }
        return {
          verdict: 'qualified',
          reasons: [
            `known-bad control failed the property as required (${knownBad.failures.length} failing ` +
              'assertion(s) matched to the selection — runner-report classification, now qualified)',
            `healthy control passed with executed(selected) = ${healthy.executed}/${healthy.selected}`,
          ],
          frozen: null,
        };
      }
      case 'property-failure': {
        return {
          verdict: 'rejected-contradictory',
          reasons: [
            `known-bad control failed the property (${knownBad.failures.length} failing assertion(s)), but the ` +
              `healthy/reference control ALSO failed (${healthy.failures.length} failing assertion(s)) — the ` +
              'oracle contradicts the healthy implementation',
            ESCALATION_NOTE,
          ],
          frozen: null,
        };
      }
      default: {
        if (HARNESS_REFUSAL_KINDS.has(healthy.kind)) {
          return {
            verdict: 'escalated',
            reasons: [
              `known-bad control failed the property (${knownBad.failures.length} failing assertion(s)), but the ` +
                `healthy control could not be evaluated (${outcomeSummary(healthy)}${healthy.reasons.length > 0 ? `; ${healthy.reasons.join('; ')}` : ''}) — ` +
                'a harness-level refusal is escalated, never blamed on the oracle and never counted as an ' +
                'invalid oracle (validity UNKNOWN)',
            ],
            frozen: null,
          };
        }
        return inconclusive([
          `known-bad control failed the property (${knownBad.failures.length} failing assertion(s)), but the ` +
            `healthy control outcome left validity UNKNOWN (${outcomeSummary(healthy)}) — qualification is ` +
            'inconclusive; an infrastructure/timeout/unselected reason on a control proves nothing about the oracle',
        ]);
      }
    }
  }

  return inconclusive([
    `known-bad control outcome left validity UNKNOWN (${outcomeSummary(knownBad)}) — an ` +
      'unselected/infrastructure/timeout/build/collection/selection/inconclusive outcome on the known-bad ' +
      'control proves nothing about the oracle',
  ]);
}

/**
 * Qualify a proposal against its injected control pair (UNIT path). Both
 * controls are always executed by the caller, so the record reflects the
 * full evidence. Verdict table:
 * - known-bad property-failure + healthy credible pass => `qualified`
 * - known-bad credible pass (property holds on broken code) => `rejected-vacuous`
 * - known-bad property-failure + healthy property-failure => `rejected-contradictory` (escalated)
 * - healthy control refused at the harness level => `escalated`
 * - anything else (unselected/infrastructure/timeout/missing evidence) =>
 *   `rejected-inconclusive` — validity UNKNOWN, never an invalid-oracle count
 */
export function qualifyContract(
  proposal: PropertyProposal,
  controls: QualificationControls,
): QualificationRecord {
  // Proposals are untrusted even here: re-validate before qualification
  // consumes them (fail loud on malformed input, never silently proceed).
  parsePropertyProposal(proposal);
  const knownBad = controls.runKnownBadControl();
  const healthy = controls.runHealthyControl();
  return verdictForControlPair(knownBad, healthy);
}

function requireReceiptId(ref: ExecutionReceiptRef, role: string): string {
  const receiptId = (ref as { readonly receiptId?: unknown }).receiptId;
  if (typeof receiptId !== 'string' || receiptId.trim() === '' || Buffer.byteLength(receiptId, 'utf8') > 200) {
    throw new UntrustedRunEvidenceError(
      `${role}: receipt reference must carry a non-empty receiptId of at most 200 UTF-8 bytes, got: ${String(receiptId)}`,
    );
  }
  return receiptId;
}

/** Resolve one receipt reference through the evidence source and verify it
 * at runtime with the executor's guard before it is trusted. */
function resolveSealedEvidence(source: RunEvidenceSource, ref: ExecutionReceiptRef, role: string): SealedExecutionReceipt {
  const receiptId = requireReceiptId(ref, role);
  let candidate: unknown;
  try {
    candidate = source.resolve(ref);
  } catch (error) {
    throw new UntrustedRunEvidenceError(
      `${role}: the evidence source failed to resolve receipt "${receiptId}" (${String(error)})`,
    );
  }
  if (!source.guard(candidate)) {
    throw new UntrustedRunEvidenceError(
      `${role}: receipt "${receiptId}" is not host-issued evidence — the runtime executor guard rejected it ` +
        '(forged, cloned, serialized-untrusted or mutated receipts are never qualification evidence)',
    );
  }
  return candidate;
}

/** A qualification record plus the host-issued control results it produced. */
export interface HostQualificationResult {
  readonly record: QualificationRecord;
  readonly knownBadControl: QualificationControlResult;
  readonly healthyControl: QualificationControlResult;
}

/**
 * PRODUCTION qualification path: accepts ONLY host-issued evidence. The
 * known-bad and healthy controls are named by receipt reference and
 * resolved through the `RunEvidenceSource` seam with runtime guard
 * verification; the returned control results carry those receipt refs —
 * never a self-supplied hash or a copied outcome object.
 */
export function qualifyContractWithHostEvidence(
  proposal: PropertyProposal,
  knownBadRef: ExecutionReceiptRef,
  healthyRef: ExecutionReceiptRef,
  source: RunEvidenceSource,
): HostQualificationResult {
  parsePropertyProposal(proposal);
  const knownBadReceipt = resolveSealedEvidence(source, knownBadRef, 'known-bad control');
  const healthyReceipt = resolveSealedEvidence(source, healthyRef, 'healthy control');
  const knownBad = knownBadReceipt.outcome;
  const healthy = healthyReceipt.outcome;
  const record = verdictForControlPair(knownBad, healthy);
  return {
    record,
    knownBadControl: {
      receiptRef: knownBadRef,
      satisfied: knownBad.kind === 'property-failure' && isCrediblePropertyFailure(knownBad),
      detail: `known-bad control outcome: ${outcomeSummary(knownBad)}`,
    },
    healthyControl: {
      receiptRef: healthyRef,
      satisfied: healthy.kind === 'pass' && isCrediblePass(healthy),
      detail: `healthy control outcome: ${outcomeSummary(healthy)}`,
    },
  };
}

/**
 * Attribute a counterexample between baseline and candidate (UNIT path): a
 * failure that reproduces on the baseline as well is
 * `baseline-also-fails` and is never asserted as a new candidate defect.
 */
export function attributeCounterexample(
  candidate: PropertyRunOutcome,
  baseline: PropertyRunOutcome | null,
): BaselineAttribution {
  if (candidate.kind !== 'property-failure') {
    throw new PropertyQualificationError(
      `attribution requires a candidate property-failure outcome, got: ${candidate.kind}`,
    );
  }
  if (baseline === null) {
    return 'unattributed';
  }
  if (baseline.kind === 'property-failure') {
    return 'baseline-also-fails';
  }
  if (baseline.kind === 'pass' && isCrediblePass(baseline)) {
    return 'candidate-only';
  }
  return 'unattributed';
}

/** PRODUCTION attribution: candidate and baseline are receipt references
 * resolved through the same runtime-guarded evidence seam. */
export function attributeCounterexampleWithHostEvidence(
  candidateRef: ExecutionReceiptRef,
  baselineRef: ExecutionReceiptRef | null,
  source: RunEvidenceSource,
): BaselineAttribution {
  const candidate = resolveSealedEvidence(source, candidateRef, 'candidate run').outcome;
  const baseline = baselineRef === null ? null : resolveSealedEvidence(source, baselineRef, 'baseline run').outcome;
  return attributeCounterexample(candidate, baseline);
}

/** Verdicts that policy routes to human escalation. */
export function requiresEscalation(verdict: QualificationVerdict): boolean {
  return verdict === 'rejected-contradictory' || verdict === 'escalated';
}
