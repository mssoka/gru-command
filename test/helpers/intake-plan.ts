import type { Plan, Proposal } from '../../src/intake/types.js';
/** Authored concrete fixture; default proposals intentionally cannot execute. */
export function resolvedIntakePlan(proposal: Proposal): Plan {
  const statement = (text: string) => ({ text, traces: [], clarification: true });
  return { questions: [], unmapped: [], heists: proposal.plan.heists.map((heist) => ({ ...heist, title: 'Implement captured requirements', goal: statement('Implement the captured feature in the existing application.'), scope: [statement('Implement all mapped acceptance in this repository.')], exclusions: [statement('No deployment or upstream source edits.')], acceptance: proposal.requirements.map(({ id, trace }) => ({ text: trace.quote, traces: [trace], clarification: false, requirementIds: [id] })), verification: [statement('Run npm test and verify all mapped acceptance.')], unresolvedQuestions: [], splitMergeRationale: statement('One cohesive deliverable shares the same implementation boundary.') })) };
}
