import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderMinionBriefing } from '../src/dispatch/service.js';
import { renderRebriefPrompt } from '../src/dispatch/fix-directive.js';
import { PR_CREATION_RULE } from '../src/dispatch/pr-creation.js';
import { TOOL_CALL_POLICY } from '../src/dispatch/tool-call-policy.js';
import { appendWorkerRules, WORKER_RULE_BLOCKS } from '../src/dispatch/worker-rules.js';
import { loadSilasSkills, SILAS_SKILL_NAMES } from '../src/dispatch/silas-driver.js';
import { claudeTurnArgs } from '../src/runtime/claude-adapter.js';
import { buildClaudeCodeAuthArgs } from '../src/runtime/claude-model.js';

/**
 * Issue #158 — remove arbitrary tool-call caps from minion execution and
 * completion policy.
 *
 * The incident: a repair phase was briefed with "28 tool calls" and ops
 * enforced the count as a compliance gate, quarantining productive work
 * over bookkeeping. No shipped enforcement ever counted calls; the cap
 * lived in briefing-generation and operations practice. These regressions
 * pin the shipped contract instead: every assembled worker instruction
 * carries the no-call-budget rule, the shipped/installed instruction
 * assets (roles/, resources/silas-skills/, the package `files` set) never
 * demand or permit inventing a numeric ceiling, and task turns ask the
 * provider for no turn cap at all. Everything is read package-relative —
 * no local home, config, or journal state is consulted.
 */

const PACKAGE_ROOT = join(import.meta.dirname, '..');

/** Prompt blocks are hard-wrapped; phrase checks read the flattened text. */
function flat(text: string): string {
  return text.replace(/\s+/gu, ' ');
}

function briefingFor(contract: string): string {
  return renderMinionBriefing({
    jobId: 'job-158',
    repoName: 'repo',
    branch: 'gru/job-158',
    worktreePath: '/tmp/wt',
    sha: 'abc123',
    briefing: contract,
  });
}

// ------------------------------------------------------------------
// Prompt contract: the rule travels with every worker instruction
// ------------------------------------------------------------------

describe('no-call-budget prompt contract (issue #158)', () => {
  it('the initial dispatch briefing carries both current worker rule blocks, in order', () => {
    const prompt = briefingFor('Implement the fix; verify the suite.');
    const flatPrompt = flat(prompt);
    for (const block of WORKER_RULE_BLOCKS) expect(flatPrompt).toContain(flat(block));
    expect(flatPrompt.indexOf(flat(PR_CREATION_RULE))).toBeLessThan(
      flatPrompt.indexOf(flat(TOOL_CALL_POLICY)),
    );
    expect(flatPrompt).toContain('no total or per-phase tool-call budget binds');
    expect(flatPrompt).toContain('never a gate');
  });

  it('a legacy numeric call ceiling in the authored briefing is superseded, not obeyed', () => {
    const prompt = flat(
      briefingFor(
        'Use at most 28 tool calls for this phase; reserve the final 2 for the handoff write.',
      ),
    );
    // The briefing arrives verbatim (records are not rewritten)…
    expect(prompt).toContain('at most 28 tool calls');
    // …but the current rule follows it and names the ceiling as non-binding.
    const legacyAt = prompt.indexOf('at most 28 tool calls');
    const ruleAt = prompt.indexOf('no total or per-phase tool-call budget binds');
    expect(ruleAt).toBeGreaterThan(legacyAt);
    expect(prompt).toContain('it does not bind');
    expect(prompt).toContain('keep working until the task is genuinely done and verified');
    expect(prompt).toContain('instead of stopping for the number');
  });

  it('a fresh re-brief contract carries the same rule block', () => {
    const prompt = flat(
      renderRebriefPrompt({
        jobId: 'job-158',
        briefing: 'legacy wording: stop after 36 calls',
        note: 'resume the lane from the current rules',
      }),
    );
    expect(prompt).toContain(flat(TOOL_CALL_POLICY));
    expect(prompt).toContain('stop after 36 calls'); // verbatim record
    expect(prompt).toContain('it does not bind');
  });

  it('follow-up directives carry both rule blocks, composed in the shared order', () => {
    expect(appendWorkerRules('fix the lane')).toBe(
      `fix the lane\n\n${WORKER_RULE_BLOCKS.join('\n\n')}`,
    );
    expect(appendWorkerRules('fix the lane')).toContain(PR_CREATION_RULE);
    expect(appendWorkerRules('fix the lane')).toContain(TOOL_CALL_POLICY);
  });

  it('the rule grants no extra spend/time/safety permission and keeps the real gates', () => {
    const policy = flat(TOOL_CALL_POLICY);
    expect(policy).toContain('grants no extra spend, time, or safety');
    for (const gate of [
      'owner cancellation and explicitly authorized spend limits',
      'provider rate limits',
      'permission/tool confinement',
      'concurrency and resource limits',
      'genuine non-progress stalls (silence with no live process)',
      'verification budgets owned by the verify scheduler',
      'required review/test gates',
    ]) {
      expect(policy).toContain(gate);
    }
    // It forbids replacing the count with an invented quota.
    expect(policy).toContain('Do not substitute a turn or elapsed-time cap');
    expect(policy).not.toMatch(/at most \d+ (?:tool[- ])?calls?/iu);
    expect(policy).not.toMatch(/maximum of \d+ turns?/iu);
  });
});

// ------------------------------------------------------------------
// Shipped/installed instruction assets
// ------------------------------------------------------------------

/**
 * Numeric tool/turn ceilings a shipped instruction must never contain:
 * a number bound to calls/turns inside one sentence. Read-only discovery
 * over the package's shipped asset directories — no home or journal state.
 */
const CALL_TOKEN = /\b(?:tool[- ]?calls?|calls?|turns?)\b/iu;
const BOUND_TOKEN =
  /\b(?:at most|no more than|maximum|max|limiting|limit(?:ed)?|cap(?:ped)?|ceil(?:ing)?|budget(?:ed)?|reserve(?:d)?|within|under|only|up to)\b/iu;

function numericCallCeilings(text: string): string[] {
  const hits: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n{2,}/u)) {
    if (!/\d/u.test(sentence)) continue;
    if (!CALL_TOKEN.test(sentence)) continue;
    if (!BOUND_TOKEN.test(sentence)) continue;
    hits.push(flat(sentence).trim());
  }
  return hits;
}

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
  }
  return out;
}

describe('shipped instruction assets (issue #158)', () => {
  it('the package allowlist ships roles/ and resources/silas-skills/', () => {
    const packageJson = JSON.parse(
      readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8'),
    ) as { files?: string[] };
    expect(packageJson.files).toEqual(
      expect.arrayContaining(['roles/', 'resources/silas-skills/']),
    );
  });

  it('the scanner detects a numeric cap and ignores no-cap wording', () => {
    expect(
      numericCallCeilings('Brief the phase with at most 28 tool calls, reserving the final 2.'),
    ).toHaveLength(1);
    expect(numericCallCeilings('The hard ceiling of 36 calls applies to the phase.')).toHaveLength(1);
    expect(numericCallCeilings('Cap the phase at 28 calls.')).toHaveLength(1);
    expect(numericCallCeilings('There is no round cap for evolving blockers.')).toEqual([]);
    expect(numericCallCeilings('No total or per-phase tool-call budget binds this task.')).toEqual(
      [],
    );
    expect(numericCallCeilings('At most one factual FYI attempt per episode.')).toEqual([]);
    expect(numericCallCeilings('Escalate after three genuine repair attempts.')).toEqual([]);
  });

  it('no shipped role or ops skill demands or permits a numeric call ceiling', () => {
    const files = [
      ...markdownFiles(join(PACKAGE_ROOT, 'roles')),
      ...markdownFiles(join(PACKAGE_ROOT, 'resources', 'silas-skills')),
    ];
    expect(files.length).toBeGreaterThanOrEqual(7);
    const offenders: string[] = [];
    for (const file of files) {
      for (const hit of numericCallCeilings(readFileSync(file, 'utf-8'))) {
        offenders.push(`${file}: ${hit}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every shipped instruction that governs briefings carries an explicit no-cap clause', () => {
    const clauses: ReadonlyArray<readonly [string, readonly string[]]> = [
      ['roles/minion.md', ['no tool-call budget', 'informational, not a gate', 'noncompliance', 'elapsed-time or turn cap']],
      ['roles/silas.md', ["never cap a worker's calls", 'noncompliance', 'numeric call ceiling']],
      ['roles/gru.md', ['never carries a total or per-phase tool-call ceiling', 'telemetry']],
      [
        'resources/silas-skills/ops-dispatch/SKILL.md',
        ['no tool-call ceilings', 'does not bind', 'noncompliance'],
      ],
      [
        'resources/silas-skills/ledger-closeout/SKILL.md',
        ['telemetry, never a close-out condition', 'no numeric total or per-phase call ceiling'],
      ],
    ];
    for (const [relative, required] of clauses) {
      const text = flat(readFileSync(join(PACKAGE_ROOT, relative), 'utf-8')).toLowerCase();
      for (const clause of required) expect(text, `${relative} missing "${clause}"`).toContain(clause);
    }
  });

  it('silas receives the shipped no-cap contract through the real skill-injection path', () => {
    const skills = loadSilasSkills();
    expect(skills.map((skill) => skill.name).sort()).toEqual([...SILAS_SKILL_NAMES].sort());
    const opsDispatch = skills.find((skill) => skill.name === 'ops-dispatch');
    expect(flat(opsDispatch?.body ?? '').toLowerCase()).toContain('no tool-call ceilings');
    const ledgerCloseout = skills.find((skill) => skill.name === 'ledger-closeout');
    expect(flat(ledgerCloseout?.body ?? '').toLowerCase()).toContain('telemetry, never a close-out condition');
  });
});

// ------------------------------------------------------------------
// Adapter contract: GC never asks the provider for a task turn cap
// ------------------------------------------------------------------

describe('provider turn caps are never a task budget (issue #158)', () => {
  const params = {
    binary: 'claude',
    sessionId: 'sess-158',
    cwd: '/tmp/wt',
    systemPrompt: '# Minion',
    tools: ['read', 'bash', 'edit', 'write'],
    killGraceMs: 1_000,
    resume: false,
  } as unknown as Parameters<typeof claudeTurnArgs>[0];

  it('a normal task turn passes no --max-turns (or any provider turn cap)', () => {
    for (const resume of [false, true]) {
      const args = claudeTurnArgs(params, resume);
      expect(args).not.toContain('--max-turns');
      expect(args.join(' ')).not.toContain('max-turns');
      expect(args.join(' ')).not.toContain('max-budget-usd');
    }
  });

  it('only the internal auth probe pins one explicit one-shot turn — it is not a task budget', () => {
    const probe = buildClaudeCodeAuthArgs('default');
    const index = probe.indexOf('--max-turns');
    expect(index).toBeGreaterThan(-1);
    expect(probe[index + 1]).toBe('1');
    expect(probe).toContain('--no-session-persistence');
  });
});
