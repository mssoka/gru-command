import { createHash } from 'node:crypto';
import { shadowEffectDisagreement } from './effects.js';
import type {
  DecisionOutcome,
  DecisionRequest,
  QuestionSet,
  ShadowDecisionRecord,
} from './types.js';

/** sha256 over the filtered request state plus the question ids (issue
 * #223). This hash — never the state itself — is the only request
 * identifier that ever reaches the ledger. */
export function requestHashOf(request: DecisionRequest<QuestionSet>): string {
  return createHash('sha256')
    .update(request.state)
    .update('\n')
    .update(Object.keys(request.questions).sort().join(','))
    .digest('hex');
}

export type ShadowRecorder = (record: ShadowDecisionRecord) => void;

/** Assemble one `decisions.shadow` ledger payload (issue #223): what the
 * provider WOULD have done (`answers`/`routes`) next to the deterministic
 * baseline (`deterministic_answers`/`deterministic_routes`), with the
 * filtered request state reduced to its hash — the state text is NEVER
 * recorded. Pure. */
export function buildShadowRecord<Q extends QuestionSet>(input: {
  readonly surface: string;
  readonly provider: string;
  readonly request: DecisionRequest<Q>;
  readonly providerOutcome: DecisionOutcome<Q>;
  readonly deterministicOutcome: DecisionOutcome<Q>;
}): ShadowDecisionRecord {
  // Null (unmeasured) rather than a throw: a dropped record would lose
  // the provider's answers, and the report counts null rows as skipped.
  const disagrees = shadowEffectDisagreement({
    surface: input.surface,
    baselineAnswers: input.deterministicOutcome.answers,
    baselineRoutes: input.deterministicOutcome.routes,
    providerAnswers: input.providerOutcome.answers,
    providerRoutes: input.providerOutcome.routes,
    providerSource: input.providerOutcome.provenance.source,
  });
  return {
    surface: input.surface,
    request_hash: requestHashOf(input.request),
    provider: input.provider,
    model: input.providerOutcome.provenance.model,
    answers: input.providerOutcome.answers,
    routes: input.providerOutcome.routes,
    deterministic_answers: input.deterministicOutcome.answers,
    deterministic_routes: input.deterministicOutcome.routes,
    latency_ms: input.providerOutcome.provenance.latencyMs,
    cost: input.providerOutcome.provenance.usage?.costUsd ?? null,
    provenance_source: input.providerOutcome.provenance.source,
    fallback_reason: input.providerOutcome.provenance.fallbackReason,
    request_diagnostics: input.providerOutcome.provenance.diagnostics ?? null,
    disagrees,
  };
}
