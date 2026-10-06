import { choiceProbabilities } from '../questions.js';
import type { QuestionSet } from '../types.js';
import type { SurfaceCaseSpec } from './registry.js';

/**
 * Report-conclusion case vocabulary (issues #223/#224).
 *
 * #224's report-conclusion surface over report-type handbacks. The
 * DETERMINISTIC BASELINE is today's behavior: every delivered report
 * still owes the commissioner a review (`findings_need_action`) —
 * #220's disposition records do not exist yet, so nothing may be
 * auto-cleared without evidence to the contrary.
 */

export const REPORT_CONCLUSION_LABELS = ['clean_pass', 'findings_need_action', 'inconclusive'] as const;

export const REPORT_CONCLUSION_QUESTIONS = {
  conclusion: {
    type: 'choice',
    instructions: 'Conclude this report-type handback for the commissioner.',
    options: ['clean_pass', 'findings_need_action', 'inconclusive'] as const,
    criteria: {
      clean_pass: 'The report supports closing the obligation with no further work.',
      findings_need_action: 'The report contains findings someone must act on.',
      inconclusive: 'The report does not contain enough evidence to conclude either way.',
    },
  },
} as const satisfies QuestionSet;

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
  labelAction: (label) => (label === 'findings_need_action' ? 'act' : 'defer'),
  calibrationQuestion: 'conclusion',
};
