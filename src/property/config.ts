import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import type { ExecutionBudget, PropertyMode } from './types.js';

/**
 * Strict parse of the repo-level property-contract configuration
 * (`.gru-command/property.toml`): staged-rollout mode, approved execution
 * budget ceilings, and optional adapter-profile overrides (issue §9).
 *
 * Fail-loud discipline: unknown keys, bad types and out-of-range values
 * throw `PropertyConfigValidationError` naming the file and key. A missing
 * file is NOT an error — `loadPropertyConfig` returns null and the caller
 * owns mode/budget defaults (this module never invents them).
 */

export const PROPERTY_CONFIG_RELATIVE_PATH = '.gru-command/property.toml';

/** Upper bounds budgets may not exceed (policy-approved ceilings — budgets
 * are never silently raised, and a config cannot exceed these). */
export const PROPERTY_CONFIG_CEILINGS = {
  maxIterations: 1_000_000,
  maxShrinkSteps: 100_000,
  runTimeoutMs: 3_600_000,
  maxOutputBytes: 64 * 1_024 * 1_024,
} as const;

const MODES: readonly PropertyMode[] = ['disabled', 'observation', 'enforced'];
const TOP_LEVEL_KEYS = ['mode', 'budgets', 'adapters'] as const;
const BUDGET_KEYS = ['max_iterations', 'max_shrink_steps', 'run_timeout_ms', 'max_output_bytes'] as const;

export class PropertyConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PropertyConfigValidationError';
  }
}

export interface PropertyRepoConfig {
  readonly mode: PropertyMode;
  /** Null when the file declares no [budgets] table: the caller applies the
   * approved defaults — this module never invents budget values. */
  readonly budgets: ExecutionBudget | null;
  /** Adapter-profile overrides keyed by adapter id. */
  readonly adapters: Readonly<Record<string, string>>;
}

function table(value: unknown, name: string, source: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PropertyConfigValidationError(`${source}: ${name} must be a TOML table`);
  }
  return value as Record<string, unknown>;
}

function boundedInteger(
  value: unknown,
  key: string,
  source: string,
  ceiling: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new PropertyConfigValidationError(
      `${source}: ${key} must be an integer, got: ${String(value)}`,
    );
  }
  if (value <= 0 || !Number.isSafeInteger(value)) {
    throw new PropertyConfigValidationError(
      `${source}: ${key} must be a positive safe integer, got: ${String(value)}`,
    );
  }
  if (value > ceiling) {
    throw new PropertyConfigValidationError(
      `${source}: ${key} exceeds the approved ceiling of ${ceiling} (got: ${String(value)})`,
    );
  }
  return value;
}

/**
 * Parse and validate property-config TOML text. The `source` label names
 * the file in every error message.
 */
export function parsePropertyConfig(
  text: string,
  source: string = PROPERTY_CONFIG_RELATIVE_PATH,
): PropertyRepoConfig {
  let raw: Record<string, unknown>;
  try {
    raw = table(parse(text), 'property config document', source);
  } catch (error) {
    if (error instanceof PropertyConfigValidationError) throw error;
    throw new PropertyConfigValidationError(`${source} is not valid TOML: ${String(error)}`);
  }

  for (const key of Object.keys(raw)) {
    if (!(TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      throw new PropertyConfigValidationError(
        `${source}: unknown key "${key}" (valid top-level keys: ${TOP_LEVEL_KEYS.join(', ')})`,
      );
    }
  }

  const rawMode = raw['mode'];
  if (typeof rawMode !== 'string' || !(MODES as readonly string[]).includes(rawMode)) {
    throw new PropertyConfigValidationError(
      `${source}: mode must be one of ${MODES.join(', ')} (got: ${String(rawMode)})`,
    );
  }

  let budgets: ExecutionBudget | null = null;
  if ('budgets' in raw) {
    const rawBudgets = table(raw['budgets'], 'budgets', source);
    for (const key of Object.keys(rawBudgets)) {
      if (!(BUDGET_KEYS as readonly string[]).includes(key)) {
        throw new PropertyConfigValidationError(
          `${source}: budgets has unknown key "${key}" (valid: ${BUDGET_KEYS.join(', ')})`,
        );
      }
    }
    for (const key of BUDGET_KEYS) {
      if (!(key in rawBudgets)) {
        throw new PropertyConfigValidationError(`${source}: budgets is missing required key "${key}"`);
      }
    }
    budgets = {
      maxIterations: boundedInteger(rawBudgets['max_iterations'], 'budgets.max_iterations', source, PROPERTY_CONFIG_CEILINGS.maxIterations),
      maxShrinkSteps: boundedInteger(rawBudgets['max_shrink_steps'], 'budgets.max_shrink_steps', source, PROPERTY_CONFIG_CEILINGS.maxShrinkSteps),
      runTimeoutMs: boundedInteger(rawBudgets['run_timeout_ms'], 'budgets.run_timeout_ms', source, PROPERTY_CONFIG_CEILINGS.runTimeoutMs),
      maxOutputBytes: boundedInteger(rawBudgets['max_output_bytes'], 'budgets.max_output_bytes', source, PROPERTY_CONFIG_CEILINGS.maxOutputBytes),
    };
  }

  let adapters: Readonly<Record<string, string>> = {};
  if ('adapters' in raw) {
    const rawAdapters = table(raw['adapters'], 'adapters', source);
    const validated: Record<string, string> = {};
    for (const [key, value] of Object.entries(rawAdapters)) {
      if (key.trim() === '' || Buffer.byteLength(key, 'utf8') > 200) {
        throw new PropertyConfigValidationError(
          `${source}: adapters has an invalid adapter id key (empty or over 200 UTF-8 bytes): "${key}"`,
        );
      }
      if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > 500) {
        throw new PropertyConfigValidationError(
          `${source}: adapters."${key}" must be a non-empty string of at most 500 UTF-8 bytes, got: ${String(value)}`,
        );
      }
      validated[key] = value;
    }
    adapters = validated;
  }

  return { mode: rawMode as PropertyMode, budgets, adapters };
}

/** Load `.gru-command/property.toml` under `repoRoot`. Returns null when
 * the file is absent (defaults are the caller's); every other deviation
 * fails loud naming the file and key. */
export function loadPropertyConfig(repoRoot: string): PropertyRepoConfig | null {
  const path = join(repoRoot, PROPERTY_CONFIG_RELATIVE_PATH);
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (error) {
    throw new PropertyConfigValidationError(`${path} could not be read: ${String(error)}`);
  }
  return parsePropertyConfig(text, path);
}
