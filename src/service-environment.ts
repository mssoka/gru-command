import { loadConfig, type ConfiguredEnvironment, type GruCommandConfig } from './config.js';
import { isolateDecisionEnvironment } from './decisions/credentials.js';
import { CREDENTIAL_ENV_VARS } from './decisions/profile.js';

/**
 * `[env]` at service boot (#494). The environment the service manager (or
 * whoever started the process) hands over wins for every name it sets, an
 * explicitly empty value included; `[env]` fills only the names it leaves
 * unset. Values are read once per boot — an edit applies on the next start.
 */

/** `inherited` plus every `[env]` name it leaves unset, as a new object. */
export function withConfiguredEnvironment(
  configured: ConfiguredEnvironment,
  inherited: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const supplied = configured.entries().filter(([name]) => inherited[name] === undefined);
  return { ...inherited, ...Object.fromEntries(supplied) };
}

export interface ServiceEnvironment {
  readonly config: GruCommandConfig;
  /** The private environment provider keys resolve from (never inherited
   * by a child process). */
  readonly decisionEnvironment: NodeJS.ProcessEnv;
  /** `[env]` names this boot supplied. */
  readonly supplied: readonly string[];
  /** `[env]` names the inherited environment already set; its values stand. */
  readonly inherited: readonly string[];
}

/**
 * The service's environment step, run before anything can spawn: move the
 * provider keys out of `ambient` into a private snapshot, select and load
 * the instance config from what was inherited (so `[env]` can never
 * relocate it), then supply `[env]`. A provider key supplied by `[env]`
 * joins the private snapshot only; every other name joins `ambient`, which
 * the processes the service starts inherit. Throws ConfigError.
 */
export function bootServiceEnvironment(
  ambient: NodeJS.ProcessEnv = process.env,
  home?: string,
): ServiceEnvironment {
  const inheritedEnv = isolateDecisionEnvironment(ambient);
  const config = loadConfig(ambient, home);
  const supplied = config.env.entries().filter(([name]) => inheritedEnv[name] === undefined);
  for (const [name, value] of supplied) {
    if (!CREDENTIAL_ENV_VARS.includes(name)) ambient[name] = value;
  }
  return {
    config,
    decisionEnvironment: withConfiguredEnvironment(config.env, inheritedEnv),
    supplied: supplied.map(([name]) => name),
    inherited: config.env.names.filter((name) => inheritedEnv[name] !== undefined),
  };
}
