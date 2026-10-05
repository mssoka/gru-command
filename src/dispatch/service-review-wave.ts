import { defaultPackageRoot } from '../build-info.js';
import { reviewServiceRuntimeIdentity } from '../runtime/review-build-identity.js';
import { WaveRunner, type WaveRunnerOptions } from './perkins.js';

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
