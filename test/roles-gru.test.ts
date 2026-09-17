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
  });

  it('the role config maps the permission set (tools + workspace cwd)', () => {
    expect(ROLE_DEFINITIONS.gru.tools).toEqual(['read', 'bash', 'grep', 'find', 'ls']);
    expect(ROLE_DEFINITIONS.gru.cwd).toBe('workspace_root');
  });

  it('the persona is generic: no personal paths, no instance or runtime specifics (hygiene ruling)', () => {
    const prompt = ROLE_DEFINITIONS.gru.systemPrompt;
    // Personal paths, instance/tooling specifics, and runtime names never
    // ship in the product-native role — the persona PATTERN only.
    const forbidden = /\/Users\/|\/home\/|~\/|herdr|_bmad|ledger|worktree|\bpi\b|claude/i;
    expect(forbidden.test(prompt)).toBe(false);
  });
});
