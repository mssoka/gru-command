import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { lockfileIdentity, propertyConfigIdentity } from '../src/property/receipts.js';
import {
  loadPropertyConfig,
  parsePropertyConfig,
  PropertyConfigValidationError,
  PROPERTY_CONFIG_CEILINGS,
  PROPERTY_CONFIG_RELATIVE_PATH,
} from '../src/property/config.js';

/**
 * GH350 lane C: strict parse of `.gru-command/property.toml` (issue §9).
 * Fail-loud validation names the file and key; a missing file is null
 * (defaults belong to the caller, never invented here). Plain tmp fixtures.
 */

const roots: string[] = [];
const makeRepo = (toml: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'gh350-property-config-'));
  roots.push(root);
  mkdirSync(join(root, '.gru-command'), { recursive: true });
  writeFileSync(join(root, PROPERTY_CONFIG_RELATIVE_PATH), toml, 'utf-8');
  return root;
};
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const FULL_TOML = [
  'mode = "enforced"',
  '',
  '[budgets]',
  'max_iterations = 500',
  'max_shrink_steps = 2000',
  'run_timeout_ms = 45000',
  'max_output_bytes = 1048576',
  '',
  '[adapters]',
  'vitest-fast-check = "profile-ci"',
].join('\n');

describe('GH350 property config strict parse', () => {
  it('returns null when the config file is absent (defaults are the caller\u2019s)', () => {
    const root = mkdtempSync(join(tmpdir(), 'gh350-property-config-empty-'));
    roots.push(root);
    expect(loadPropertyConfig(root)).toBeNull();
  });

  it('bounds configuration bytes before either parsing or identity hashing', () => {
    const root = makeRepo(`#${'x'.repeat(64 * 1024)}\nmode = "disabled"`);
    expect(() => loadPropertyConfig(root)).toThrow(/exceeds/);
    expect(() => propertyConfigIdentity(root)).toThrow(/exceeds/);
    expect(() => parsePropertyConfig('x'.repeat(64 * 1024 + 1))).toThrow(/exceeds/);
  });

  it('binds every local lockfile and refuses oversized or aliased lock bytes', () => {
    const root = makeRepo('mode = "disabled"');
    writeFileSync(join(root, 'package-lock.json'), '{}'); const initial = lockfileIdentity(root, root);
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
    expect(lockfileIdentity(root, root)).not.toBe(initial);
    writeFileSync(join(root, 'yarn.lock'), '#'.repeat(2 * 1024 * 1024 + 1));
    expect(() => lockfileIdentity(root, root)).toThrow(/exceeds/);
    rmSync(join(root, 'yarn.lock')); const outside = makeRepo('mode = "disabled"');
    symlinkSync(join(outside, PROPERTY_CONFIG_RELATIVE_PATH), join(root, 'yarn.lock'));
    expect(() => lockfileIdentity(root, root)).toThrow(/ordinary/);
  });

  it('refuses configuration file and parent symlinks before reading host bytes', () => {
    const outside = makeRepo('mode = "enforced"');
    for (const parent of [false, true]) {
      const root = makeRepo('mode = "disabled"');
      const target = parent ? '.gru-command' : PROPERTY_CONFIG_RELATIVE_PATH;
      rmSync(join(root, target), { recursive: true }); symlinkSync(join(outside, target), join(root, target));
      expect(() => loadPropertyConfig(root)).toThrow(/ordinary/);
      expect(() => propertyConfigIdentity(root)).toThrow(/ordinary/);
    }
  });

  it('parses mode, budgets and adapter overrides from a full config', () => {
    const config = loadPropertyConfig(makeRepo(FULL_TOML));
    expect(config).not.toBeNull();
    expect(config!.mode).toBe('enforced');
    expect(config!.budgets).toEqual({
      maxIterations: 500,
      maxShrinkSteps: 2000,
      runTimeoutMs: 45_000,
      maxOutputBytes: 1_048_576,
    });
    expect(config!.adapters).toEqual({ 'vitest-fast-check': 'profile-ci' });
  });

  it('accepts every declared mode (disabled, observation, enforced)', () => {
    for (const mode of ['disabled', 'observation', 'enforced'] as const) {
      const config = parsePropertyConfig(`mode = "${mode}"`);
      expect(config.mode).toBe(mode);
    }
  });

  it('leaves budgets null when no [budgets] table is declared', () => {
    const config = loadPropertyConfig(makeRepo('mode = "observation"'));
    expect(config!.budgets).toBeNull();
    expect(config!.adapters).toEqual({});
  });

  it('requires mode and names the file and key when it is missing', () => {
    const root = makeRepo('[budgets]\nmax_iterations = 10\nmax_shrink_steps = 10\nrun_timeout_ms = 10\nmax_output_bytes = 10\n');
    expect(() => loadPropertyConfig(root)).toThrowError(PropertyConfigValidationError);
    try {
      loadPropertyConfig(root);
    } catch (error) {
      expect((error as Error).message).toContain(PROPERTY_CONFIG_RELATIVE_PATH);
      expect((error as Error).message).toContain('mode');
    }
  });

  it('rejects an invalid mode value naming the file', () => {
    expect(() => parsePropertyConfig('mode = "aggressive"')).toThrowError(/mode must be one of/);
  });

  it('rejects unknown top-level keys', () => {
    expect(() => parsePropertyConfig('mode = "disabled"\nextra = true')).toThrowError(/unknown key "extra"/);
  });

  it('rejects unknown keys inside [budgets]', () => {
    const toml = 'mode = "disabled"\n[budgets]\nmax_iterations = 10\nmax_shrink_steps = 10\nrun_timeout_ms = 10\nmax_output_bytes = 10\nmax_repairs = 3\n';
    expect(() => parsePropertyConfig(toml)).toThrowError(/budgets has unknown key "max_repairs"/);
  });

  it('rejects a partial [budgets] table naming the missing key', () => {
    const toml = 'mode = "disabled"\n[budgets]\nmax_iterations = 10\nmax_shrink_steps = 10\nrun_timeout_ms = 10\n';
    expect(() => parsePropertyConfig(toml)).toThrowError(/missing required key "max_output_bytes"/);
  });

  it('rejects non-integer budget values', () => {
    const toml = 'mode = "disabled"\n[budgets]\nmax_iterations = "many"\nmax_shrink_steps = 10\nrun_timeout_ms = 10\nmax_output_bytes = 10\n';
    expect(() => parsePropertyConfig(toml)).toThrowError(/budgets.max_iterations must be an integer/);
  });

  it('rejects non-positive budget values', () => {
    const zero = 'mode = "disabled"\n[budgets]\nmax_iterations = 0\nmax_shrink_steps = 10\nrun_timeout_ms = 10\nmax_output_bytes = 10\n';
    expect(() => parsePropertyConfig(zero)).toThrowError(/positive safe integer/);
    const negative = 'mode = "disabled"\n[budgets]\nmax_iterations = 10\nmax_shrink_steps = -5\nrun_timeout_ms = 10\nmax_output_bytes = 10\n';
    expect(() => parsePropertyConfig(negative)).toThrowError(/positive safe integer/);
  });

  it('rejects budgets above the approved ceilings (never silently raised)', () => {
    const toml = `mode = "disabled"\n[budgets]\nmax_iterations = ${PROPERTY_CONFIG_CEILINGS.maxIterations + 1}\nmax_shrink_steps = 10\nrun_timeout_ms = 10\nmax_output_bytes = 10\n`;
    expect(() => parsePropertyConfig(toml)).toThrowError(
      new RegExp(`exceeds the approved ceiling of ${PROPERTY_CONFIG_CEILINGS.maxIterations}`),
    );
  });

  it('rejects non-string adapter override values', () => {
    const toml = 'mode = "observation"\n[adapters]\nvitest-fast-check = 3\n';
    expect(() => parsePropertyConfig(toml)).toThrowError(/adapters."vitest-fast-check" must be a non-empty string/);
  });

  it('rejects invalid TOML syntax with the config error name', () => {
    expect(() => parsePropertyConfig('mode = ')).toThrowError(PropertyConfigValidationError);
    expect(() => parsePropertyConfig('mode = "disabled"')).not.toThrow();
  });
});
