import type { AnswersFor, DecisionRequest, QuestionSet, RiskClass } from '../types.js';
import { ESCALATION_TRIAGE_LABELS, ESCALATION_TRIAGE_SPEC, ESCALATION_TRIAGE_QUESTIONS } from './escalation-triage.js';
import { REPORT_CONCLUSION_LABELS, REPORT_CONCLUSION_SPEC, REPORT_CONCLUSION_QUESTIONS } from './report-conclusion.js';
import { SAME_BLOCKER_LABELS, SAME_BLOCKER_SPEC, SAME_BLOCKER_QUESTIONS } from './same-blocker.js';

/** One labelled history case (issue #223): the filtered request state as
 * production would have built it, plus the outcome label ground truth. */
export interface LabelledCase {
  readonly id: string;
  readonly state: string;
  readonly label: string;
}

/** The two actions a decision route can take under enforce: any band at
 * or above `confirm` acts on the provider answer; the `fallback` band
 * defers to the deterministic behavior. */
export type CaseAction = 'act' | 'defer';

/**
 * Per-surface backtest vocabulary (issue #223). Each spec owns the
 * surface's canonical question set, the CONSTANT deterministic baseline
 * (what today's rules do — the thing Jev must beat), the label
 * vocabulary of its labelled history, and how labels map to actions so
 * precision/recall are computed on the action that would be taken.
 *
 * The production wiring of these surfaces into `decide()` arrives with
 * issue #224; #223 fixes their measurement contract so backtests match
 * production exactly.
 */
export interface SurfaceCaseSpec<Q extends QuestionSet = QuestionSet> {
  readonly surface: string;
  readonly questions: Q;
  readonly risks: Readonly<{ [K in keyof Q]: RiskClass }>;
  /** The constant deterministic baseline answers for this surface. */
  readonly fallback: AnswersFor<Q>;
  readonly labels: readonly string[];
  /** The label whose correct handling is "take the action" — the class
   * precision/recall are headline-reported on. */
  readonly actionableLabel: string;
  /** Map the answer actually served (provider or per-question fallback) to
   * the operational action; route bands alone cannot identify that action. */
  answerAction(answers: AnswersFor<Q>): CaseAction;
  readonly labelAction: (label: string) => CaseAction;
  /** The question whose routed metric feeds calibration buckets. */
  readonly calibrationQuestion: keyof Q & string;
}

/** Rebuild a full decision request from a labelled case's filtered state
 * (the questions, risks and baseline are per-surface constants, so the
 * state is the only per-case input). Pure. */
export function requestFromCase<Q extends QuestionSet>(
  spec: SurfaceCaseSpec<Q>,
  state: string,
): DecisionRequest<Q> {
  return { state, questions: spec.questions, risks: spec.risks, fallback: spec.fallback };
}

const REGISTRY: Readonly<Record<string, SurfaceCaseSpec>> = {
  escalation_triage: ESCALATION_TRIAGE_SPEC,
  same_blocker: SAME_BLOCKER_SPEC,
  report_conclusion: REPORT_CONCLUSION_SPEC,
};

/** The registered backtest surface names, in stable order. */
export const BACKTEST_SURFACES: readonly string[] = Object.keys(REGISTRY);

export function surfaceCaseSpec(surface: string): SurfaceCaseSpec {
  const spec = REGISTRY[surface];
  if (spec === undefined) {
    throw new Error(
      `unknown backtest surface "${surface}" (registered: ${BACKTEST_SURFACES.join(', ')})`,
    );
  }
  return spec;
}

export {
  ESCALATION_TRIAGE_LABELS,
  ESCALATION_TRIAGE_QUESTIONS,
  REPORT_CONCLUSION_LABELS,
  REPORT_CONCLUSION_QUESTIONS,
  SAME_BLOCKER_LABELS,
  SAME_BLOCKER_QUESTIONS,
};
