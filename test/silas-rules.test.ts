import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseSilasActionRuleId,
  SILAS_ACTION_RULE_IDS,
  SILAS_RULES,
  SILAS_RULE_IDS,
} from '../src/dispatch/silas-rules.js';

/**
 * The named-rule registry (issue #117, review finding g21): the promise
 * set (the shipped ops-dispatch skill) and the executable rule set (this
 * registry + the receipts code writes) must not drift apart. These tests
 * pin the agreement from BOTH directions.
 */

const SKILL_PATH = join(import.meta.dirname, '..', 'resources', 'silas-skills', 'ops-dispatch', 'SKILL.md');

const EXPECTED_RULE_IDS = [
  'clean-abort-service-restart',
  'verdict-rung-directive',
  'verdict-rung-rebrief',
  'verdict-rung-escalate',
  'verification-repair',
  'pr-conflict-rebase',
  'sweep-ack',
  'freeze-r1',
] as const;

/** Every src TypeScript file, concatenated — the receipt-existence probe. */
function allSrcSource(): string {
  const root = join(import.meta.dirname, '..', 'src');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts')) files.push(full);
    }
  };
  walk(root);
  return files.map((file) => readFileSync(file, 'utf-8')).join('\n');
}

describe('the named Silas rule registry (issue #117/g21)', () => {
  it('is exactly the bounded set — a new rule is a deliberate registry edit', () => {
    expect([...SILAS_RULE_IDS].sort()).toEqual([...EXPECTED_RULE_IDS].sort());
    expect(SILAS_RULES).toHaveLength(EXPECTED_RULE_IDS.length);
  });

  it('classifies freeze-r1 as the only gate and the rest as actions', () => {
    const gates = SILAS_RULES.filter((rule) => rule.kind === 'gate').map((rule) => rule.id);
    expect(gates).toEqual(['freeze-r1']);
    expect([...SILAS_ACTION_RULE_IDS].sort()).toEqual(
      EXPECTED_RULE_IDS.filter((id) => id !== 'freeze-r1').sort(),
    );
  });

  it('every rule documents its firing surface and receipt (a stranger can audit both)', () => {
    for (const rule of SILAS_RULES) {
      expect(rule.firesOn.length, `${rule.id} names its firing surface`).toBeGreaterThan(20);
      expect(rule.receipt.length, `${rule.id} names at least one receipt`).toBeGreaterThan(0);
      expect(rule.summary.length, `${rule.id} summarizes the reaction`).toBeGreaterThan(10);
    }
  });

  it('every named receipt kind is actually written somewhere in src — provenance has a writer', () => {
    const src = allSrcSource();
    for (const rule of SILAS_RULES) {
      for (const receipt of rule.receipt) {
        expect(src.includes(`'${receipt}'`), `receipt ${receipt} of ${rule.id} has a writer in src`).toBe(true);
      }
    }
  });

  it('the shipped skill names EVERY registry rule — the executable set is fully promised', () => {
    const skill = readFileSync(SKILL_PATH, 'utf-8');
    for (const id of SILAS_RULE_IDS) {
      expect(skill.includes(id), `skill names rule ${id}`).toBe(true);
    }
  });

  it('the skill names NO rule-shaped id outside the registry — no invented siblings', () => {
    const skill = readFileSync(SKILL_PATH, 'utf-8');
    // Rule-shaped: backticked kebab tokens ending in a registry-ish suffix
    // (rung/repair/rebase/ack/restart/r1). Catches a new `*-rung-*` style
    // promise that never landed in the registry.
    const ruleShaped = /`([a-z][a-z0-9]*(?:-[a-z0-9]+)*-(?:rung-directive|rung-rebrief|rung-escalate|repair|rebase|ack|restart|r1))`/gu;
    const invented = [...skill.matchAll(ruleShaped)]
      .map((match) => match[1] ?? '')
      .filter((id) => !SILAS_RULE_IDS.has(id));
    expect(invented, `skill promises unregistered rules: ${invented.join(', ')}`).toEqual([]);
  });
});

describe('parseSilasActionRuleId (request-boundary validation)', () => {
  it('absent field → null (no rule claimed)', () => {
    expect(parseSilasActionRuleId(undefined)).toBeNull();
  });

  it('each action rule id parses to itself (rule-hit identity)', () => {
    for (const id of SILAS_ACTION_RULE_IDS) {
      expect(parseSilasActionRuleId(id)).toBe(id);
    }
  });

  it('an unknown id refuses loud, naming the registry (rule-miss)', () => {
    expect(() => parseSilasActionRuleId('respin-known-failure')).toThrow(/not a named Silas rule/);
    expect(() => parseSilasActionRuleId('')).toThrow(/not a named Silas rule/);
  });

  it('a gate id is never requestable as an action rule (gates fire as refusals)', () => {
    expect(() => parseSilasActionRuleId('freeze-r1')).toThrow(/gate, not an action rule/);
  });
});
