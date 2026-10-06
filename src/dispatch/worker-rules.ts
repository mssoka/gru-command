import { PR_CREATION_RULE } from './pr-creation.js';
import { TOOL_CALL_POLICY } from './tool-call-policy.js';

/**
 * Stage-5 review convergence (issue #225) for review loops run inside
 * minion lanes (the bmad-review gate and any self-run review/fix cycle):
 * the same rule the Perkins host enforces, as playbook text. From the
 * third round of one review loop, a NEW finding holds the loop only when
 * its location intersects the hunks this round actually changed; new
 * findings on untouched code are filed as follow-ups (reported in the
 * loop's output, never dropped) and cannot trigger another round. Findings
 * already raised in earlier rounds whose quoted evidence is unchanged are
 * carried forward, not re-litigated from scratch. One final whole-review
 * pass at the READY candidate is the standing whole-change authority.
 */
export const REVIEW_CONVERGENCE_RULE = [
  'REVIEW CONVERGENCE RULE (review loops in minion lanes):',
  '- From round 3 of one review/fix loop, only a new finding whose location intersects the hunks changed in this round can block; new findings on untouched code are follow-ups — report them as such, never drop them, and do not run another round for them.',
  '- Prior findings whose quoted evidence is unchanged carry forward as still-present without re-verification; findings whose code changed, or that you claimed fixed, are re-verified explicitly.',
  '- A loop whose rounds review only the latest changes (delta-scoped) must run one final whole-review pass of the complete change at a READY/PASS candidate before it may report convergence. A loop that already reviews the complete change in every round (such as a working-diff gate) holds that whole-change coverage in the concluding round itself.',
].join('\n');

/**
 * The complete set of current rule blocks an assembled worker instruction
 * carries. Rendering and appending live here (one ordered list, one append
 * helper DERIVED from it) so briefings, re-briefs and follow-up directives
 * cannot drift apart block by block.
 */
export const WORKER_RULE_BLOCKS: readonly string[] = [PR_CREATION_RULE, TOOL_CALL_POLICY, REVIEW_CONVERGENCE_RULE];

/** Append every current worker rule block to an authored instruction text
 * (one blank line between blocks, always). Derived from the ordered list so
 * adding or reordering a block cannot leave one instruction path behind. */
export function appendWorkerRules(text: string): string {
  return `${text}\n\n${WORKER_RULE_BLOCKS.join('\n\n')}`;
}
