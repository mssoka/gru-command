import { ESCALATION_TRIAGE_QUESTIONS, choiceProbabilities } from '../questions.js';
import type { SurfaceCaseSpec } from './registry.js';

/**
 * Escalation-triage case vocabulary (issues #223/#224).
 *
 * The canonical question set lives in `../questions.ts` (the production
 * home — issue #224's wiring asks exactly these questions); this spec
 * owns the DETERMINISTIC BASELINE (what today's rules do: every
 * Silas-authored escalation reaches Gru, `needs_ruling`) and the labelled
 * vocabulary the backtest scores against.
 */

export const ESCALATION_TRIAGE_LABELS = ['defer_ok', 'needs_ruling'] as const;

/** Label evidence for the extractor: a resolution detail naming the wake
 * duplicate, covered, or nothing actionable proves a defer was right. */
export function escalationLabelFromResolvedDetail(detail: string): 'defer_ok' | null {
  return /duplicate|covered|nothing actionable/i.test(detail) ? 'defer_ok' : null;
}

/** Provider triage choices that still mean "someone must rule". */
export const RULING_CHOICES: readonly string[] = ['needs_ruling', 'needs_owner'];
/** Provider triage choices that mean "deferring was safe". */
export const DEFER_CHOICES: readonly string[] = ['status_report', 'covered_by_open_item'];

export const ESCALATION_TRIAGE_SPEC: SurfaceCaseSpec<typeof ESCALATION_TRIAGE_QUESTIONS> = {
  surface: 'escalation_triage',
  questions: ESCALATION_TRIAGE_QUESTIONS,
  // Keep in lockstep with escalationTriageDecisionRequest (questions.ts):
  // the spec and the production builder must pin identical risks/fallback.
  risks: { triage: 'operational', needs_decision: 'read_only' },
  fallback: {
    triage: {
      type: 'choice',
      choice: 'needs_ruling',
      probabilities: choiceProbabilities(ESCALATION_TRIAGE_QUESTIONS.triage.options, 'needs_ruling'),
      confidence: 1,
    },
    needs_decision: { type: 'noul', noul: 1 },
  },
  labels: ESCALATION_TRIAGE_LABELS,
  actionableLabel: 'needs_ruling',
  answerAction: (answers) => RULING_CHOICES.includes(answers.triage.choice) ? 'act' : 'defer',
  labelAction: (label) => (label === 'needs_ruling' ? 'act' : 'defer'),
  calibrationQuestion: 'triage',
};
