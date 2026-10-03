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

  it('pins the Perkins whole-PR persona contract phrases', () => {
    const perkins = ROLE_DEFINITIONS['perkins'].systemPrompt;
    for (const phrase of [
      'perkins_run_specialists',
      'perkins_submit_review',
      'perkins_preflight_submission',
      'perkins_read_prior_revision',
      'perkins_submit_findings',
      'READY TO MERGE',
      'NEEDS CHANGES',
      'MAJOR REWORK NEEDED',
      'INCOMPLETE',
      'Exact evidence is mandatory',
      'The blind specialist has no tools',
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
    expect(silas).toContain('never\nmerge');
    expect(silas).toContain('service-restart clean abort');
    expect(silas).toContain('owner-held');
  });

  it('pins the ordinary non-draft PR creation order on minion and silas', () => {
    const minion = ROLE_DEFINITIONS['minion'].systemPrompt.replace(/\s+/gu, ' ');
    expect(minion).toContain('create it ordinary and non-draft from the outset');
    expect(minion).toContain('`gh pr create` without `--draft`/`-d`');
    const silas = ROLE_DEFINITIONS['silas'].systemPrompt.replace(/\s+/gu, ' ');
    expect(silas).toContain('New pull requests are ordinary');
    expect(silas).toContain('existing drafts are left untouched');
  });

  it('pins the task-relevant BMAD workflow playbook on the worker prompt', () => {
    const minion = ROLE_DEFINITIONS['minion'].systemPrompt.replace(/\s+/gu, ' ');
    expect(minion).toContain("explicitly select the project's installed build-workflow skill");
    expect(minion).toContain("the PROJECT's actual installed skill catalog and metadata");
    expect(minion).toContain('select by capability from what the project really has installed');
    expect(minion).toContain('never by a fixed skill name, a remembered file path, or a hand-maintained rename table');
    expect(minion).toContain('You own the selected workflow end to end');
    expect(minion).toContain('no self-imposed call, turn, or time ceiling');
    expect(minion).toContain("fresh, context-free tracked review jobs you commission through the service's job-dispatch surface");
    expect(minion).toContain('`POST /api/dispatch` — the same path that created your lane');
    expect(minion).toContain('each reviewer is a separate tracked job with its own session and worktree');
    // Native round 1 (admission-cycle blocker): a nested reviewer dispatch
    // that cannot be admitted must stop loud, never deadlock or bypass caps.
    expect(minion).toContain('nested-admission capability gap');
    expect(minion).toContain('do not block waiting');
    expect(minion).toContain('never raise or bypass the configured worker limits');
    // j-810/j-811: the retired untracked headless-launcher wording must never return.
    expect(minion).not.toContain('pi -p');
    expect(minion).not.toContain('claude -p');
    expect(minion).not.toContain('headless print mode');
    // The verification scheduler is the one global budget; the worker
    // prompt must not read as licence for competing full runs.
    expect(minion).toContain("coordinate through the service's verification scheduler");
    expect(minion).toContain('never a second Gru');
    expect(minion).toContain('an inline self-review is not a substitute');
    expect(minion).toContain('report that exact capability gap loudly');
    expect(minion).toContain('supported official BMAD onboarding/discovery path');
    // Native round 2 warning: name the concrete onboarding surface.
    expect(minion).toContain('Project-local BMAD setup');
    expect(minion).toContain('no guessed rename');
    // Continuous completion contract (owner 2026-10-02): approved work runs
    // to the end without a continue prompt; artifact jobs owe no PR; the
    // obligations are policy, not implemented runtime guarantees.
    expect(minion).toContain('Approved work runs to its end without a new go-ahead');
    expect(minion).toContain('A failed attempt is not a destroyed undertaking');
    expect(minion).toContain('no product PR is owed');
    expect(minion).toContain('binding playbook obligations, not runtime guarantees');
    // Owner-held merge adoption on the worker surface + accepted-action
    // reconciliation for dispatched reviewer jobs.
    expect(minion).toContain('the review is the gate, and the owner holds every merge');
    expect(minion).toContain('read-only brief that names the exact immutable head');
    expect(minion).toContain('never echo it');
    expect(minion).toContain('reconcile it by job identity');
    // Outcome truth (owner clarification 2026-10-02).
    expect(minion).toContain('Report outcomes truthfully');
    expect(minion).toContain('a fulfilled call, HTTP 200, tool return, turn ending, or receipt is not delivery');
    expect(minion).toContain('never reopen a genuinely delivered or parked job to compensate');
    expect(minion).toContain('an older delivery is history');
    // Owner clarification j-761: the shipped policy selects by capability
    // from the project's actual catalog; a fixed skill name is never the
    // normative entry point — not just the retired `bmad-build` literal.
    expect(minion).not.toMatch(/bmad-[a-z][a-z-]*/u);
  });

  it('pins the minion-owned build cycle on the ops prompt', () => {
    const silas = ROLE_DEFINITIONS['silas'].systemPrompt.replace(/\s+/gu, ' ');
    expect(silas).toContain('Minion-owned build cycle');
    expect(silas).toContain('goal, boundaries, acceptance, verification');
    expect(silas).toContain("selects the task-relevant BMAD skills from the project's actual installed catalog");
    expect(silas).toContain('never demand a fixed skill name in a briefing');
    expect(silas).toContain('verification scheduler');
    expect(silas).toContain('do not commission a supplementary review duplicating');
    expect(silas).toContain('activate the native Perkins gate on that exact final head');
    expect(silas).toContain('NEEDS CHANGES returns to the same implementing minion');
    // Continuous completion + reconciliation contract (owner 2026-10-02).
    expect(silas).toContain('Continuous completion and reconciliation');
    expect(silas).toContain('never ask the owner to say continue');
    expect(silas).toContain('awaiting-review status is not a stop reason');
    expect(silas).toContain('never hold the fleet behind one long worker turn');
    expect(silas).toContain('Reconcile accepted actions and requests before resuming');
    expect(silas).toContain('restart, recording each durably before its effects can be lost');
    expect(silas).toContain('a queue timeout is not a test result');
    expect(silas).toContain('Artifact-only and investigation jobs complete at their verified artifact handback');
    expect(silas).toContain('binding playbook obligations, not implemented guarantees');
    // Outcome truth (owner clarification 2026-10-02).
    expect(silas).toContain('Outcome truth: a fulfilled call');
    expect(silas).toContain('never record a success delivery because control returned');
    expect(silas).toContain('not a reopen trigger');
    expect(silas).toContain('an older delivery event is history');
    expect(silas).toContain('a failed attempt does not destroy the undertaking');
    // Owner-held merge on the reviews-are-gates standing order.
    expect(silas).toContain('an approved verdict clears the review');
    expect(silas).not.toContain('approved merges, changes-requested goes back');
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
    // Review sessions override skills to empty; the lens-* fleet is retired.
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
