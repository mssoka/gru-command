import { defaultPackageRoot } from '../build-info.js';
import { reviewServiceRuntimeIdentity } from '../runtime/review-build-identity.js';
import { WaveRunner, type WaveRunnerOptions } from './perkins.js';

/** Supersession proof (owner rule 3): which of these review session ids
 * the runtime still holds a live handle for. A ledger row that reads
 * disposed is never proof — only the runtime's own handle state is. */
export function liveReviewSessionIds(
  registry: { getHandle(agentId: string): { health(): { readonly state: string } } | null },
  agentIds: readonly string[],
): readonly string[] {
  return agentIds.filter((agentId) => {
    const handle = registry.getHandle(agentId);
    return handle !== null && handle.health().state !== 'disposed';
  });
}

/** Installed service review construction boundary. Identity cannot silently
 * disappear from a caller that supplies the other review runner options. */
export function createServiceReviewWave(input: {
  readonly registry: {
    runtimeIdFor(role: 'perkins'): string;
    reviewThinkingLevel(role: 'perkins'): string;
  };
  readonly options: Omit<WaveRunnerOptions, 'reviewRuntimeIdentity' | 'reviewThinkingLevel'>;
}): WaveRunner {
  const { registry, options } = input;
  return new WaveRunner({
    ...options,
    reviewRuntimeIdentity: () => reviewServiceRuntimeIdentity(registry, defaultPackageRoot()),
    reviewThinkingLevel: () => registry.reviewThinkingLevel('perkins'),
  });
}
