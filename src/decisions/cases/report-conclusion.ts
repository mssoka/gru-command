import { REPORT_CONCLUSION_QUESTIONS, choiceProbabilities } from '../questions.js';
import type { SurfaceCaseSpec } from './registry.js';

/**
 * Report-conclusion case vocabulary (issues #223/#224).
 *
 * The canonical question set lives in `../questions.ts` (issue #224's
 * builder asks exactly these questions; its production ask wires at
 * #220's report handback path). This spec owns the DETERMINISTIC
 * BASELINE: every delivered report still owes the commissioner a review
 * (`findings_need_action`) — nothing may be auto-cleared without
 * evidence to the contrary.
 */

export const REPORT_CONCLUSION_LABELS = ['clean_pass', 'findings_need_action', 'inconclusive'] as const;

/** Map a Perkins canonical verdict (the report's verdict line, durable in
 * consolidated.json) to the labelled case's ground truth. */
export function reportLabelFromCanonicalVerdict(verdict: string): 'clean_pass' | 'findings_need_action' | 'inconclusive' | null {
  if (verdict === 'READY TO MERGE') return 'clean_pass';
  if (verdict === 'NEEDS CHANGES' || verdict === 'MAJOR REWORK NEEDED') return 'findings_need_action';
  if (verdict === 'INCOMPLETE') return 'inconclusive';
  return null;
}

export const REPORT_CONCLUSION_SPEC: SurfaceCaseSpec<typeof REPORT_CONCLUSION_QUESTIONS> = {
  surface: 'report_conclusion',
  questions: REPORT_CONCLUSION_QUESTIONS,
  risks: { conclusion: 'operational' },
  fallback: {
    conclusion: {
      type: 'choice',
      choice: 'findings_need_action',
      probabilities: choiceProbabilities(REPORT_CONCLUSION_QUESTIONS.conclusion.options, 'findings_need_action'),
      confidence: 1,
    },
  },
  labels: REPORT_CONCLUSION_LABELS,
  actionableLabel: 'findings_need_action',
  answerAction: (answers) => answers.conclusion.choice === 'findings_need_action' ? 'act' : 'defer',
  labelAction: (label) => (label === 'findings_need_action' ? 'act' : 'defer'),
  calibrationQuestion: 'conclusion',
};
