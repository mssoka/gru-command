import { SAME_BLOCKER_QUESTIONS } from '../questions.js';
import type { SurfaceCaseSpec } from './registry.js';

/**
 * Same-blocker case vocabulary (issues #223/#224).
 *
 * The canonical question set lives in `../questions.ts` (issue #224's
 * wiring asks exactly these questions). This spec owns the DETERMINISTIC
 * BASELINE: differing fingerprints are DIFFERENT blockers (noul 0) —
 * treating same as different is the conservative default the provider
 * must earn the right to overturn.
 */

export const SAME_BLOCKER_LABELS = ['same', 'different'] as const;

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
  answerAction: (answers) => answers.same_defect.noul >= 0.5 ? 'defer' : 'act',
  labelAction: (label) => (label === 'different' ? 'act' : 'defer'),
  calibrationQuestion: 'same_defect',
};
