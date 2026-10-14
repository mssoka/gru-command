import type { AgentHandle, SpawnOptions } from './types.js';

/** In-process owner handshake, never an adapter option or wire field. Spread
 * preserves the private symbol when a slot adds its normal spawn options. */
const REGISTRATION_STAGE = Symbol('runtime-registration-stage');
type RegistrationStage = (handle: AgentHandle, publish: () => void) => void;
type StagedOptions = SpawnOptions & { readonly [REGISTRATION_STAGE]?: RegistrationStage };

export function stageSpawnRegistration(options: SpawnOptions, stage: RegistrationStage): SpawnOptions {
  const staged: StagedOptions = { ...options, [REGISTRATION_STAGE]: stage };
  return staged;
}

/** Ordinary producers publish normally; supervised recovery holds publication
 * until its awaiting owner validates the captured native authority. */
export function publishSpawnRegistration(options: SpawnOptions, handle: AgentHandle, publish: () => void): void {
  const stage = (options as StagedOptions)[REGISTRATION_STAGE];
  if (stage === undefined) publish();
  else stage(handle, publish);
}
