import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { ROLE_DEFINITIONS, requireSpawnCwd } from '../src/roles.js';
import { ROLES } from '../src/config.js';

/**
 * EPICS E8 story 1: all five product-native roles ship prompt files with
 * cwd + skill + permission mappings (SPEC ruling 15/17), fail-loud
 * loaded at module import.
 */

describe('role definitions (E8)', () => {
  it('ships one non-empty, file-backed persona per role', () => {
    expect([...ROLES].sort()).toEqual(['bob', 'gru', 'minion', 'perkins', 'silas']);
    for (const role of ROLES) {
      const def = ROLE_DEFINITIONS[role];
      expect(def.role).toBe(role);
      expect(def.systemPrompt.length).toBeGreaterThan(200);
      // The persona is the FILE, verbatim (not a synthesized fallback).
      expect(def.systemPrompt.startsWith('# ')).toBe(true);
      expect(def.systemPrompt).toMatch(new RegExp(`^# .*${role}`, 'i'));
    }
  });

  it('keeps the Gru gate canon: plan-before-heist lives in the Gru prompt', () => {
    const gru = ROLE_DEFINITIONS['gru'].systemPrompt.toLowerCase();
    expect(gru).toContain('plan before the heist');
    expect(gru).toContain('briefing');
  });

  it('pins the Perkins hybrid persona contract phrases', () => {
    const perkins = ROLE_DEFINITIONS['perkins'].systemPrompt;
    for (const phrase of [
      'perkins_run_lenses',
      'perkins_submit_review',
      'perkins_preflight_submission',
      'READY TO MERGE',
      'NEEDS CHANGES',
      'MAJOR REWORK NEEDED',
      'INCOMPLETE',
      'Exact evidence is mandatory',
      'The blind child has no tools',
    ]) expect(perkins).toContain(phrase);
  });

  it('pins the Silas installed-review runtime guard', () => {
    const silas = ROLE_DEFINITIONS['silas'].systemPrompt.toLowerCase();
    for (const clause of [
      'integrity-pinned perkins policy',
      'scoped pi/claude bridges',
      'never fall back to source files',
      'ambient skills',
      'general shell/task tools',
      'tampered assets fail closed',
      'bmad-review',
      'never a silent downgrade',
    ]) expect(silas).toContain(clause);
  });

  it('maps cwd policy per ruling 17: chat/ops/memory at workspace root, workers rooted in projects', () => {
    expect(ROLE_DEFINITIONS['gru'].cwd).toBe('workspace_root');
    expect(ROLE_DEFINITIONS['silas'].cwd).toBe('workspace_root');
    expect(ROLE_DEFINITIONS['bob'].cwd).toBe('workspace_root');
    expect(ROLE_DEFINITIONS['minion'].cwd).toBe('spawn_provided');
    expect(ROLE_DEFINITIONS['perkins'].cwd).toBe('spawn_provided');
  });

  it('maps permissions: reviewers never write, workers do', () => {
    const perkinsTools = ROLE_DEFINITIONS['perkins'].tools;
    for (const writeTool of ['edit', 'write', 'bash']) {
      expect(perkinsTools).not.toContain(writeTool);
    }
    for (const writeTool of ['edit', 'write']) {
      expect(ROLE_DEFINITIONS['minion'].tools).toContain(writeTool);
      expect(ROLE_DEFINITIONS['bob'].tools).toContain(writeTool);
    }
  });

  it('maps runtime-agnostic skills per role (declared, not injected)', () => {
    // Hybrid review sessions override skills to empty; the lens-* fleet is retired.
    expect(ROLE_DEFINITIONS['perkins'].skills).toEqual([]);
    expect(ROLE_DEFINITIONS['minion'].skills.length).toBeGreaterThan(0);
    expect(ROLE_DEFINITIONS['bob'].skills).toContain('memory-consolidation');
  });

  it('requireSpawnCwd fails loud when a project-rooted role gets no cwd', () => {
    expect(() => requireSpawnCwd('minion', undefined)).toThrowError(/SPEC ruling 17/);
    expect(() => requireSpawnCwd('perkins', '')).toThrowError(/explicit spawn cwd/);
    expect(requireSpawnCwd('minion', '/tmp/some-worktree')).toBe('/tmp/some-worktree');
    // workspace-root roles never require one
    expect(requireSpawnCwd('gru', undefined)).toBe('');
  });
});

describe('role prompt files ship in the package', () => {
  it('all five markdown files exist next to the definitions', () => {
    // Loaded at import time (fail-loud); reaching here already proves it.
    expect(existsSync(new URL('../roles/gru.md', import.meta.url))).toBe(true);
    const bob = readFileSync(new URL('../roles/bob.md', import.meta.url), 'utf-8');
    expect(bob).toMatch(/provenance/i);
  });
});
