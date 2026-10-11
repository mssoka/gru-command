import type { GruCommandConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import {
  ManagedRepoOverviewTracker,
  type RemoteResolver,
  type RepoOverviewApiPort,
} from './overview.js';

export interface ManagedRepoOverviewRuntimeOptions {
  readonly api: RepoOverviewApiPort;
  readonly log?: (level: LogLevel, message: string, fields?: Record<string, unknown>) => void;
  readonly resolveRemote?: RemoteResolver;
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
    ...(options.log !== undefined ? { log: options.log } : {}),
    ...(options.resolveRemote !== undefined ? { resolveRemote: options.resolveRemote } : {}),
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
}

