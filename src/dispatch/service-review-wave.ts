import { defaultPackageRoot } from '../build-info.js';
import { reviewServiceRuntimeIdentity } from '../runtime/review-build-identity.js';
import { WaveRunner, type WaveRunnerOptions } from './perkins.js';
import { openPullRequestsForBranch, type GhApiPort, type RepoRef } from './github-poll.js';
import type { DispatchService } from './service.js';

/** Perkins publication's lookup of a PR its lane opened but never
 * registered, as the service wires it: the lane origin's open GitHub pulls
 * on the lane branch, linked through the dispatcher's `recordPr` (the
 * function POST /api/dispatch/pr calls). */
export function publicationPrLookup(deps: {
  readonly gh: Pick<GhApiPort, 'listPullsForHead'>;
  readonly resolveRemote: (repoPath: string) => RepoRef | null;
  readonly dispatch: Pick<DispatchService, 'recordPr'>;
}): Required<Pick<WaveRunnerOptions, 'findOpenPullRequests' | 'recordPr'>> {
  return {
    findOpenPullRequests: ({ repoPath, branch }) =>
      openPullRequestsForBranch(deps.gh, { repoPath, remote: deps.resolveRemote(repoPath), branch }),
    recordPr: (jobId, url) => { deps.dispatch.recordPr(jobId, url); },
  };
}

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
  /** The runtime's owner-cessation proofs are required (#464): a service
   * wave without them blocks every replacement after a restart. */
  readonly options: Omit<WaveRunnerOptions, 'reviewRuntimeIdentity' | 'reviewThinkingLevel'> &
    Required<Pick<WaveRunnerOptions, 'reconcileReviewAgent' | 'proveReviewHostExit'>>;
}): WaveRunner {
  const { registry, options } = input;
  return new WaveRunner({
    ...options,
    reviewRuntimeIdentity: () => reviewServiceRuntimeIdentity(registry, defaultPackageRoot()),
    reviewThinkingLevel: () => registry.reviewThinkingLevel('perkins'),
  });
}
