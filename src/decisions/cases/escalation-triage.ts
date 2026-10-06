import { choiceProbabilities } from '../questions.js';
import type { QuestionSet } from '../types.js';
import type { SurfaceCaseSpec } from './registry.js';

/**
 * Escalation-triage case vocabulary (issues #223/#224).
 *
 * Question set per #224's escalation-triage surface: a choice over the
 * triage class and a noul over "does this ask the chief for a decision
 * not already recorded". The DETERMINISTIC BASELINE is today's behavior:
 * every Silas-authored escalation reaches Gru (`needs_ruling`) — that is
 * the thing Jev must beat, so the baseline never defers.
 */

export const ESCALATION_TRIAGE_LABELS = ['defer_ok', 'needs_ruling'] as const;

export const ESCALATION_TRIAGE_QUESTIONS = {
  triage: {
    type: 'choice',
    instructions: 'Classify this machine-authored escalation by the attention it needs.',
    options: ['needs_ruling', 'needs_owner', 'status_report', 'covered_by_open_item'] as const,
    criteria: {
      needs_ruling: 'The escalation asks for a decision a human or the chief must make now.',
      needs_owner: 'Only the repository owner can decide this (credentials, spend, policy).',
      status_report: 'The escalation only reports progress or status; no response is needed.',
      covered_by_open_item: 'The ask is already covered by an open item, hold or disposition.',
    },
  },
  needs_decision: {
    type: 'noul',
    instructions: 'Does this escalation ask the chief for a decision not already recorded in the listed holds/dispositions?',
    criteria: {
      true: 'A new decision is being asked for.',
      false: 'No new decision is asked for; the escalation is informational or already covered.',
    },
  },
} as const satisfies QuestionSet;

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
  labelAction: (label) => (label === 'needs_ruling' ? 'act' : 'defer'),
  calibrationQuestion: 'triage',
};
