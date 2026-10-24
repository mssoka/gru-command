import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseSilasActionRuleId,
  parseSilasRouteRuleId,
  SILAS_ACTION_RULE_IDS,
  SILAS_RULES,
  SILAS_RULE_IDS,
} from '../src/dispatch/silas-rules.js';
import { isSafePipelineRecordId } from '../src/ledger/pipeline.js';

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
  'revision-continuation',
  'current-inspection',
  'delivered-pr-register',
  'pr-review-trigger',
  'sweep-ack',
  'freeze-r1',
] as const;

/** Every src TypeScript file EXCEPT the registry itself, concatenated —
 * the receipt-existence probe. The registry's own entries name the receipt
 * kinds too, so searching it would prove nothing: a writer must exist
 * OUTSIDE the registry for every named receipt (issue #117 review). */
function allSrcSource(): string {
  const root = join(import.meta.dirname, '..', 'src');
  const registryPath = join(root, 'dispatch', 'silas-rules.ts');
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.ts') && full !== registryPath) files.push(full);
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

describe('the routes the skill sends each rule on (#361)', () => {
  it('accepts current-inspection on the directive route, and nowhere else', () => {
    expect(parseSilasRouteRuleId('directive', 'current-inspection')).toBe('current-inspection');
    for (const route of ['rebrief', 'escalate', 'pr', 'review'] as const) {
      expect(() => parseSilasRouteRuleId(route, 'current-inspection'), route).toThrow(/does not fire on the/u);
    }
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

describe('prescribed request ids (#503)', () => {
  // Worst-case placeholders: a 128-character job (or chosen) id, the largest event seq.
  const instantiate = (template: string): string =>
    template.replace(/<[^>]+>/gu, (name) => (/seq/iu.test(name) ? String(Number.MAX_SAFE_INTEGER) : `j${'x'.repeat(127)}`));
  const ROLE_PATHS = ['gru.md', 'silas.md'].map((name) => join(import.meta.dirname, '..', 'roles', name));

  it('every request_id the rule registry, the ops skill and the roles prescribe meets the safe request-id rule at its longest', () => {
    const fromRules = SILAS_RULES.flatMap((rule) => [...rule.summary.matchAll(/request_id (\S+)/gu)].map((match) => match[1]!));
    expect(fromRules).toEqual(['current-inspection-<historicalDeliverySeq>']);
    const documents = [SKILL_PATH, ...ROLE_PATHS].map((path) => readFileSync(path, 'utf8'));
    // JSON request bodies, and the prose id examples (backticked, by GC's id prefixes).
    const fromJson = documents.flatMap((text) => [...text.matchAll(/"(?:inspection_)?request_id": ?"([^"]+)"/gu)].map((match) => match[1]!));
    const fromProse = documents.flatMap((text) => [...text.matchAll(/`((?:revision-continuation|rebrief|recover|current-inspection)[-:][^`\s]*)`/gu)].map((match) => match[1]!));
    expect(fromJson.length).toBeGreaterThan(0);
    expect(fromProse.length).toBeGreaterThan(0);
    for (const template of [...fromRules, ...fromJson, ...fromProse]) {
      expect(isSafePipelineRecordId(instantiate(template)), template).toBe(true);
    }
  });
});
