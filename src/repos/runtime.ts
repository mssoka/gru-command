import type { GruCommandConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import {
  ManagedRepoOverviewTracker,
  type DefaultBranchRunsObservation,
  type GitLabRepoOverviewApiPort,
  type RemoteResolver,
  type RepoOverviewApiPort,
} from './overview.js';

export interface ManagedRepoOverviewRuntimeOptions {
  readonly api: RepoOverviewApiPort;
  /** The GitLab REST port for `gitlab` rows (production always wires it). */
  readonly gitlabApi?: GitLabRepoOverviewApiPort;
  readonly log?: (level: LogLevel, message: string, fields?: Record<string, unknown>) => void;
  readonly resolveRemote?: RemoteResolver;
  /** The default-branch CI alert (#446) fed by each committed observation. */
  readonly onDefaultBranchRuns?: (observation: DefaultBranchRunsObservation) => void;
  /** Deterministic tracker seams used by the runtime integration tests. */
  readonly intervalMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** Construct the production overview consumer from the validated config.
 * This is the only startup adapter: no discovery fallback exists here. */
export function createManagedRepoOverviewTracker(
  config: Pick<GruCommandConfig, 'workspaceRoot' | 'managedRepos'>,
  options: ManagedRepoOverviewRuntimeOptions,
): ManagedRepoOverviewTracker {
  return new ManagedRepoOverviewTracker({
    workspaceRoot: config.workspaceRoot,
    managedRepos: config.managedRepos,
    api: options.api,
    ...(options.gitlabApi !== undefined ? { gitlabApi: options.gitlabApi } : {}),
    ...(options.log !== undefined ? { log: options.log } : {}),
    ...(options.resolveRemote !== undefined ? { resolveRemote: options.resolveRemote } : {}),
    ...(options.onDefaultBranchRuns !== undefined ? { onDefaultBranchRuns: options.onDefaultBranchRuns } : {}),
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}
