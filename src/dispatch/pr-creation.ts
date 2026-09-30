/**
 * The new-PR creation rule (owner instruction 2026-09-30: "fix the minions
 * gh command. remove the draft."): an authorized new minion PR is created
 * ordinary and non-draft from the outset — there is no draft-then-ready
 * conversion. The rule corrects HOW an already-authorized PR is created
 * and grants no publication permission of its own, so read-only,
 * artifact-only and evidence-only contracts keep publishing nothing.
 *
 * The block lives here (one string, one append helper) so the initial
 * briefing, follow-up directives and re-brief prompts cannot drift apart.
 * It is an instruction contract for generated `gh` commands — it is NOT a
 * sandbox over arbitrary shell commands a model might still construct.
 */

/** The rule block carried by every assembled worker instruction. */
export const PR_CREATION_RULE = [
  'New pull request rule (current — supersedes any older draft-mode wording;',
  'this rule grants no new publication permission): when, and only when, the',
  'contract already authorizes opening a pull request, create it as an',
  'ordinary, non-draft PR from the outset — gh pr create without --draft/-d,',
  'never a draft first and never a later draft-to-ready conversion.',
  'Contracts that do not authorize publication (read-only, artifact-only,',
  'evidence-only work) still publish nothing.',
].join('\n');

/** Append the new-PR rule to an assembled worker prompt or directive
 * (its own paragraph; the separator is always exactly one blank line). */
export function appendPrCreationRule(text: string): string {
  return `${text}\n\n${PR_CREATION_RULE}`;
}
