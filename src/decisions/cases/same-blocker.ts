import type { QuestionSet } from '../types.js';
import type { SurfaceCaseSpec } from './registry.js';

/**
 * Same-blocker case vocabulary (issues #223/#224).
 *
 * #224's same-blocker identity surface: "do these two findings describe
 * the same underlying defect?" — asked when the #216 stable fingerprints
 * differ but file and category overlap. The DETERMINISTIC BASELINE is
 * today's rule: differing fingerprints are DIFFERENT blockers (noul 0) —
 * treating same as different is the conservative default the provider
 * must earn the right to overturn.
 */

export const SAME_BLOCKER_LABELS = ['same', 'different'] as const;

export const SAME_BLOCKER_QUESTIONS = {
  same_defect: {
    type: 'noul',
    instructions: 'Do these two review findings describe the same underlying defect?',
    criteria: {
      true: 'The two findings are the same defect and should share one recurrence ladder entry.',
      false: 'The two findings are distinct defects even if they touch the same file.',
    },
  },
} as const satisfies QuestionSet;

export const SAME_BLOCKER_SPEC: SurfaceCaseSpec<typeof SAME_BLOCKER_QUESTIONS> = {
  surface: 'same_blocker',
  questions: SAME_BLOCKER_QUESTIONS,
  risks: { same_defect: 'operational' },
  fallback: {
    same_defect: { type: 'noul', noul: 0 },
  },
  labels: SAME_BLOCKER_LABELS,
  // A wrongly-merged pair hides a live defect, so "different" (new
  // blocker that must be handled) is the actionable class.
  actionableLabel: 'different',
  labelAction: (label) => (label === 'different' ? 'act' : 'defer'),
  calibrationQuestion: 'same_defect',
};
