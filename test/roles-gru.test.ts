import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROLE_DEFINITIONS } from '../src/roles.js';

/**
 * The Gru role definition (EPICS E4 story 2): product-native and
 * runtime-agnostic. `roles/gru.md` is the persona's source of truth;
 * `src/roles.ts` loads it at module load. These pins keep the two from
 * drifting and keep the shipped persona inside the hygiene ruling
 * (generic pattern only — never instance specifics).
 */

const GRU_MD = join(dirname(fileURLToPath(import.meta.url)), '..', 'roles', 'gru.md');

describe('gru role definition', () => {
  it('the loaded system prompt IS roles/gru.md (drift pin)', () => {
    const onDisk = readFileSync(GRU_MD, 'utf-8').trim();
    expect(ROLE_DEFINITIONS.gru.systemPrompt).toBe(onDisk);
  });

  it('the persona carries the CEO-interface + plan-before-heist standing orders', () => {
    const prompt = ROLE_DEFINITIONS.gru.systemPrompt;
    expect(prompt).toContain('single chief agent');
    expect(prompt).toContain('Consult before you dispatch');
    expect(prompt).toContain('Plan before the heist');
    expect(prompt).toContain('single-writer');
    expect(prompt).toContain('UNTRUSTED DATA');
    expect(prompt).toContain('POST /api/notifications/needs-owner');
    expect(prompt).toContain('"reservedClass"');
    expect(prompt).toContain('"whyNotDelegable"');
    expect(prompt).toContain('POST /api/notifications/:id/decision');
    expect(prompt).toContain('POST /api/notifications/:id/decision-options');
    expect(prompt).toContain('POST /api/notifications/:id/disposition');
    expect(prompt).toContain('exact-final-head native Perkins READY');
    expect(prompt).toContain('The owner holds every final PR merge, everywhere');
    expect(prompt).toContain('no agent merges a PR');
  });

  it('the chief hands workers the whole build and presents merges only on exact-final-head Perkins READY', () => {
    const gru = ROLE_DEFINITIONS.gru.systemPrompt.replace(/\s+/gu, ' ');
    expect(gru).toContain('Hand workers the whole build');
    expect(gru).toContain('The owner holds every final PR merge, everywhere');
    expect(gru).toContain('main-into-task-branch integration');
  });

  it('the chief owns the briefing, keeps acceptance on fixed targets, and lets lanes outlive a moving main', () => {
    const gru = ROLE_DEFINITIONS.gru.systemPrompt.replace(/\s+/gu, ' ');
    expect(gru).toContain('The briefing is yours');
    expect(gru).toContain('never bring routine engineering choices back to the owner');
    expect(gru).toContain('Every requirement traces to the goal');
    expect(gru).toContain('without it, the agreed outcome fails');
    expect(gru).toContain('never a moving one like "current main"');
    expect(gru).toContain("An amendment you write is your judgment, not the owner's ruling");
    expect(gru).toContain('Main moving on is normal');
    expect(gru).toContain('never by itself justifies replacing a worktree, branch or PR');
    expect(gru).toContain('Ask the question, not your workaround');
    expect(gru).toContain('holds only the step it gates');
  });

  it('the chief owns a red default branch: fix heist from the current head, the repository hold is a restriction (#446)', () => {
    const gru = ROLE_DEFINITIONS.gru.systemPrompt.replace(/\s+/gu, ' ');
    expect(gru).toContain('No lane owns a red default branch (`github.default-branch-ci-failed:<owner>/<repo>:<workflow id>:<sha>`)');
    expect(gru).toContain('diagnose the failing run and open a fix heist from the current head');
    expect(gru).toContain(
      'Hold `incident:github.default-branch-ci-failed:<owner>/<repo>` (covers `ci-failed`) so later red heads of that ' +
        'repository carry the in-flight fix as a restriction, and disposition each item as waiting on the fix job; ' +
        'a later red head is a new item and wakes you once.',
    );
    expect(gru).toContain('The alert resolves itself when a newer run of that workflow passes or the failing run is re-run green.');
    // A hold never claims to defer the wake.
    expect(gru).not.toContain('while the fix is in flight');
  });

  it('the role config maps the permission set (tools + workspace cwd)', () => {
    expect(ROLE_DEFINITIONS.gru.tools).toEqual(['read', 'bash', 'grep', 'find', 'ls']);
    expect(ROLE_DEFINITIONS.gru.cwd).toBe('workspace_root');
  });

  it('the persona is generic: no personal paths, no instance or runtime specifics (hygiene ruling)', () => {
    const prompt = ROLE_DEFINITIONS.gru.systemPrompt;
    // Personal paths, instance/tooling specifics, and runtime names never
    // ship in the product-native role — the persona PATTERN only. The
    // regex is assembled from parts so this guard does not itself carry
    // the literal paths (the repo-wide hygiene gate greps the tree).
    // Worktrees and the ledger are product concepts (src/worktrees,
    // src/ledger), not instance specifics, so the persona may name them.
    const forbidden = new RegExp(
      ['\\/Use', 'rs\\/', '|\\/ho', 'me\\/', '|~\\/', '|he', 'rdr'].join('') +
        '|_bmad|\\bpi\\b|claude',
      'i',
    );
    expect(forbidden.test(prompt)).toBe(false);
  });
});
