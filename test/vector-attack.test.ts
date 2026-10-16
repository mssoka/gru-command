import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ATTACK_LIMITS, AttackRefusal, parseAttack, vectorAttackTool } from '../src/vector/attack.js';
import { breakInContract, FIX_COUNTEREXAMPLE_MAX_CHARS, FixBriefingError, fixHeistTitle, renderFixBriefing } from '../src/vector/fix.js';
import type { BreakInRecord } from '../src/vector/ledger.js';
import { heistWorkWaiting } from '../src/vector/runner.js';

/**
 * Vector's one output is a model-controlled tool call; these pin every rule
 * that keeps it inside the target package and inside one round (#351 §3),
 * and the bounds on the fix heist's briefing (#351 §4).
 */

const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const valid = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  description: 'negative refunds',
  requirement_ref: 'README#refunds',
  invariant: 'a refund never exceeds the charged amount',
  input_domain: 'integer cents',
  invalid_input_behavior: 'negative amounts are rejected',
  establishes: 'refund bounds',
  does_not_establish: 'currency conversion',
  test: "import {it} from 'vitest';\n",
  known_bad: [{ path: 'src/refunds/refund.js', content: 'export const refund = () => -1;\n' }],
  ...overrides,
});

describe('attack validation (#351 §3)', () => {
  it('accepts a well-formed attack on the target package', () => {
    expect(parseAttack(valid(), 'src/refunds')).toMatchObject({ description: 'negative refunds', knownBad: [{ path: 'src/refunds/refund.js' }], reference: [] });
  });

  it('refuses every way a control could leave the package or the round\'s rules, by name', () => {
    const refusals: [string, Record<string, unknown>, RegExp][] = [
      ['outside the package', { known_bad: [{ path: 'src/payouts/pay.js', content: 'x' }] }, /must be a safe repository-relative path inside src\/refunds/u],
      ['traversal', { known_bad: [{ path: 'src/refunds/../../etc/x', content: 'x' }] }, /safe repository-relative path/u],
      ['dependencies', { known_bad: [{ path: 'src/refunds/node_modules/x.js', content: 'x' }] }, /may not touch dependencies, git or Gru Command configuration/u],
      ['git, case-insensitively', { known_bad: [{ path: 'src/refunds/.Git/config', content: 'x' }] }, /may not touch dependencies, git or Gru Command configuration/u],
      ['Gru Command configuration', { reference: [{ path: 'src/refunds/.GRU-COMMAND/x', content: 'x' }] }, /may not touch dependencies, git or Gru Command configuration/u],
      ['a repeated path', { known_bad: [{ path: 'src/refunds/a.js', content: 'x' }, { path: 'src/refunds/a.js', content: 'y' }] }, /known_bad repeats src\/refunds\/a\.js/u],
      ['oversized content', { known_bad: [{ path: 'src/refunds/a.js', content: 'x'.repeat(ATTACK_LIMITS.fileBytes + 1) }] }, /content must be text of at most/u],
      ['binary content', { known_bad: [{ path: 'src/refunds/a.js', content: 'a\u0000b' }] }, /content must be text of at most/u],
      ['no known-bad control', { known_bad: [] }, /known_bad must hold 1 to 8 files/u],
      ['a binary test', { test: 'a\u0000b' }, /test must be the property test module's source/u],
      ['an unknown field', { verdict: 'pass' }, /unknown attack field "verdict"/u],
      ['a two-line description', { description: 'a\nb' }, /description must be one line/u],
    ];
    for (const [what, overrides, message] of refusals) {
      expect(() => parseAttack(valid(overrides), 'src/refunds'), what).toThrow(AttackRefusal);
      expect(() => parseAttack(valid(overrides), 'src/refunds'), what).toThrow(message);
    }
  });

  it('takes exactly one valid attack per round; an invalid one is answered and can be corrected', async () => {
    const captured: unknown[] = [];
    const tool = vectorAttackTool('src/refunds', (attack) => captured.push(attack));
    await expect(tool.execute(valid({ known_bad: [] }))).rejects.toThrow(AttackRefusal);
    expect(captured).toEqual([]);
    expect(await tool.execute(valid())).toMatchObject({ terminate: true });
    await expect(tool.execute(valid({ description: 'a second one' }))).rejects.toThrow(/this round already holds a valid attack/u);
    expect(captured).toHaveLength(1);
  });
});

function breakIn(evidenceDir: string, overrides: Partial<BreakInRecord> = {}): BreakInRecord {
  return {
    id: 'breakin-1234-r1', raidId: 'raid-1234', target: { repo: 'billing', packageDir: 'src/refunds' }, headSha: 'a'.repeat(40), sourceIdentity: 'b'.repeat(40),
    description: 'negative refunds', requirementRef: 'README#refunds', invariant: 'a refund never exceeds the charged amount', frozenSha256: 'f'.repeat(64),
    counterexample: '[-1]', seed: '42', shrinkPath: ['0:1'], evidenceDir, testPath: 'src/refunds/test/vector/r1.test.mjs', testSha256: 'c'.repeat(64),
    receipts: ['r.json'], foundAt: '2026-10-16T00:00:00Z', fix: null, ...overrides,
  };
}

describe('the fix heist briefing (#351 §4)', () => {
  it('bounds the sandbox-controlled counterexample and names how much it kept', () => {
    const huge = 'x'.repeat(FIX_COUNTEREXAMPLE_MAX_CHARS + 10);
    const text = renderFixBriefing(breakIn('/e', { counterexample: huge }), { path: 'src/refunds/test/vector/r1.test.mjs', content: 'test' });
    expect(text).toContain(`(first ${String(FIX_COUNTEREXAMPLE_MAX_CHARS)} of ${String(FIX_COUNTEREXAMPLE_MAX_CHARS + 10)} code points)`);
    expect(text.split('\n').every((line) => !line.includes('\u0000'))).toBe(true);
  });

  it('reads the contract from the evidence, and refuses evidence that is no record, by name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gru-vector-fix-'));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'break-in.json'), JSON.stringify({ test: { path: 'src/refunds/test/vector/r1.test.mjs', content: 'the test' } }));
    expect(breakInContract(breakIn(dir))).toEqual({ path: 'src/refunds/test/vector/r1.test.mjs', content: 'the test' });
    writeFileSync(join(dir, 'break-in.json'), 'null');
    expect(() => breakInContract(breakIn(dir))).toThrow(FixBriefingError);
  });

  it('titles a long invariant by code points, with an ellipsis only when cut', () => {
    expect(fixHeistTitle(breakIn('/e', { invariant: '😀'.repeat(80) }))).toBe(`Fix Vector break-in: ${'😀'.repeat(80)}`);
    expect(fixHeistTitle(breakIn('/e', { invariant: '😀'.repeat(81) }))).toBe(`Fix Vector break-in: ${'😀'.repeat(80)}…`);
  });
});

describe('heist priority (#351 §3)', () => {
  const pool = (queued: readonly string[]) => ({ limit: 1, running: 1, queued: queued.map((id) => ({ id, kind: 'review' as const, label: id, queuedAt: 'now', reason: 'full' })) });
  it('queued worker or review turns are heist work; Vector\'s own queued turn is not', () => {
    expect(heistWorkWaiting({ enabled: true, worker: pool([]), review: pool(['vector:raid-1']) })).toBe(false);
    expect(heistWorkWaiting({ enabled: true, worker: pool(['job-1']), review: pool([]) })).toBe(true);
    expect(heistWorkWaiting({ enabled: true, worker: pool([]), review: pool(['round-7']) })).toBe(true);
  });
});
