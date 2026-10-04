import { appendPrCreationRule, PR_CREATION_RULE } from './pr-creation.js';
import { appendToolCallPolicy, TOOL_CALL_POLICY } from './tool-call-policy.js';

/**
 * The complete set of current rule blocks an assembled worker instruction
 * carries. Rendering and appending live here (one ordered list, one append
 * helper) so briefings, re-briefs and follow-up directives cannot drift
 * apart block by block.
 */
export const WORKER_RULE_BLOCKS: readonly string[] = [PR_CREATION_RULE, TOOL_CALL_POLICY];

/** Append every current worker rule block to an authored instruction text
 * (one blank line between blocks, always). */
export function appendWorkerRules(text: string): string {
  return appendToolCallPolicy(appendPrCreationRule(text));
}
