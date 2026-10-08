import { createHash } from 'node:crypto';
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

/** True when the provider's routes would have landed a different band
 * (act/confirm/fallback) than the deterministic baseline's on at least
 * one question. Pure; shared by the shadow recorder and the yield
 * telemetry so "disagreement" has exactly one definition. */
export function routeDisagreement(
  providerRoutes: Readonly<Record<string, { readonly path: string }>>,
  deterministicRoutes: Readonly<Record<string, { readonly path: string }>>,
): boolean {
  const ids = new Set([...Object.keys(providerRoutes), ...Object.keys(deterministicRoutes)]);
  for (const id of ids) {
    if (providerRoutes[id]?.path !== deterministicRoutes[id]?.path) return true;
  }
  return false;
}

export type ShadowRecorder = (record: ShadowDecisionRecord) => void;

/** Assemble one `decisions.shadow` ledger payload (issue #223): what the
 * provider WOULD have done (`answers`/`routes`) next to the deterministic
 * baseline (`deterministic_answers`), with the filtered request state
 * reduced to its hash — the state text is NEVER recorded. Pure. */
export function buildShadowRecord<Q extends QuestionSet>(input: {
  readonly surface: string;
  readonly provider: string;
  readonly request: DecisionRequest<Q>;
  readonly providerOutcome: DecisionOutcome<Q>;
  readonly deterministicOutcome: DecisionOutcome<Q>;
}): ShadowDecisionRecord {
  return {
    surface: input.surface,
    request_hash: requestHashOf(input.request),
    provider: input.provider,
    model: input.providerOutcome.provenance.model,
    answers: input.providerOutcome.answers,
    routes: input.providerOutcome.routes,
    deterministic_answers: input.deterministicOutcome.answers,
    latency_ms: input.providerOutcome.provenance.latencyMs,
    cost: input.providerOutcome.provenance.usage?.costUsd ?? null,
    provenance_source: input.providerOutcome.provenance.source,
    disagrees: routeDisagreement(
      input.providerOutcome.routes as unknown as Readonly<Record<string, { readonly path: string }>>,
      input.deterministicOutcome.routes as unknown as Readonly<Record<string, { readonly path: string }>>,
    ),
  };
}
