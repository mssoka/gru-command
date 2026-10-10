import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { ROLE_DEFINITIONS, requireSpawnCwd } from '../src/roles.js';
import { loadSilasSkills } from '../src/dispatch/silas-driver.js';
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
      'gc-owned fallback review',
      'never a silent downgrade',
    ]) expect(silas).toContain(clause);
    expect(silas).toContain('service-restart clean abort');
    // Silas-dispatched reports on a lane nest under it as megaminions.
    expect(silas.replace(/\s+/gu, ' ')).toContain('names that lane\'s job id as `"parent_job_id"`');
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

  it('pins the minion owning main-conflict resolution in its own worktree', () => {
    const minion = ROLE_DEFINITIONS['minion'].systemPrompt.replace(/\s+/gu, ' ');
    expect(minion).toContain('Main moves; your lane stays');
    expect(minion).toContain('never a reason to restart, replace or re-branch your work');
    expect(minion).toContain('resolve the conflict in your own worktree');
    expect(minion).toContain('do not revert what main already has');
    expect(minion).toContain("Main's newer features are not part of your scope");
    // Merge boundary (owner ruling 2026-10-10): same-branch integration is
    // ordinary worker execution without an owner checkpoint; the final PR
    // merge is never the worker's.
    expect(minion).toContain('merge main into your task branch');
    expect(minion).toContain('record the actual input SHAs');
    expect(minion).toContain('needs no separate owner permission');
    expect(minion).toContain('never moves a branch under an active review freeze');
    expect(minion).toContain('the owner performs every final PR merge');
    expect(minion).not.toContain('merging belongs to the review verdict');
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

describe('merge authority boundary (owner ruling 2026-10-10)', () => {
  const flat = (role: 'gru' | 'silas' | 'minion'): string =>
    ROLE_DEFINITIONS[role].systemPrompt.replace(/\s+/gu, ' ');
  const opsSkill = (): string => {
    const skill = loadSilasSkills().find((candidate) => candidate.name === 'ops-dispatch');
    if (skill === undefined) throw new Error('the shipped ops-dispatch skill is missing');
    return skill.body.replace(/\s+/gu, ' ');
  };

  it('Gru: branch integration is worker execution; the owner holds every final PR merge', () => {
    const gru = flat('gru');
    // Permitted: the conflict is resolved in the worker's own lane.
    expect(gru).toContain('merging main into the task branch');
    expect(gru).toContain('not a merge-authority');
    expect(gru).toContain('Main advancing never by itself justifies replacing a worktree, branch or PR');
    // Forbidden: no agent merges the PR; the owner does, after final CI and
    // exact-final-head review clearance.
    expect(gru).toContain('The owner holds every final PR merge, everywhere');
    expect(gru).toContain('no agent merges a PR');
    expect(gru).toContain('required final CI');
    expect(gru).toContain('exact-final-head native Perkins READY');
    // The blanket wording that read as covering both operations is gone.
    expect(gru).not.toContain('The owner holds every merge, everywhere');
  });

  it('Silas: integration is coordinated mechanical work; final PR merges stay owner-only in every repository', () => {
    const silas = flat('silas');
    expect(silas).toContain('integrates main into the existing task branch');
    expect(silas).toContain('needs no owner permission question');
    expect(silas).toContain('The owner performs every final PR merge, in every repository');
    expect(silas).toContain('No agent merges a PR');
    expect(silas).toContain('never moves a head under an active review freeze');
    expect(silas).not.toContain('owner holds ALL merges');
    expect(silas).not.toContain('Gru no longer merges anything');
  });

  it('the minion: same-branch integration needs no owner checkpoint; the final PR merge is not theirs', () => {
    const minion = flat('minion');
    expect(minion).toContain('merge main into your task branch');
    expect(minion).toContain('record the actual input SHAs');
    expect(minion).toContain('needs no separate owner permission');
    expect(minion).toContain('the owner performs every final PR merge');
    expect(minion).not.toContain('merging belongs to the review verdict');
  });

  it('the shipped ops skill drops the chief-merge exception and the rebase-default conflict path', () => {
    const ops = opsSkill();
    expect(ops).toContain('The owner performs every final PR merge, in every repository');
    expect(ops).toContain('gru-command included');
    expect(ops).toContain('merge the PR base into your task branch');
    expect(ops).toContain('never rebase, reset or force-push');
    expect(ops).toContain('`pr-conflict-rebase`');
    expect(ops).not.toContain('The chief holds merge authority');
    expect(ops).not.toContain('"directive":"rebase');
  });
});

describe('build-workflow playbook (owner ruling 2026-10-02; j-761 capability amendment)', () => {
  const minion = ROLE_DEFINITIONS.minion.systemPrompt.replace(/\s+/gu, ' ');
  const silas = ROLE_DEFINITIONS.silas.systemPrompt.replace(/\s+/gu, ' ');

  it('the worker follows the bound GC-owned workflow and owns the cycle end to end', () => {
    expect(minion).toContain('GC-owned build workflow bound to your registered lane');
    expect(minion).toContain('explicit project/job artifact context');
    expect(minion).toContain('takes precedence over same-named copies');
    expect(minion).toContain('approved portable specs/decisions/docs');
    expect(minion).toContain('`gru-output/`');
    expect(minion).toContain('Honor project AGENTS.md');
    expect(minion).toContain('You own the');
    expect(minion).toContain('no per-phase hand-back and no source-only hand-back');
    // The literal fixed-name requirement is retired (j-761): no bmad-* token
    // may appear as a required skill name in the worker prompt.
    expect(minion).not.toMatch(/bmad-build/);
  });

  it('the built-in review runs on fresh tracked review jobs with read-only briefs', () => {
    expect(minion).toContain('fresh, context-free tracked review jobs');
    expect(minion).toContain('`POST');
    expect(minion).toContain('/api/dispatch');
    expect(minion).toContain('a separate tracked job with its own session and worktree');
    expect(minion).toContain('read-only brief');
    expect(minion).toContain('"deliverable": "review"');
    // Each reviewer names the commissioning job so the board nests it
    // under that heist as a megaminion instead of a peer heist.
    expect(minion.replace(/\s+/gu, ' ')).toContain('name your own job id (the one in your briefing header) as `"parent_job_id"`');
    expect(minion).toContain('megaminion');
    // The commissioning minion owes each reviewer's disposition.
    const flatMinion = minion.replace(/\s+/gu, ' ');
    expect(flatMinion).toContain("makes your job each reviewer's commissioner");
    expect(flatMinion).toContain('POST /api/jobs/<review job id>/disposition');
    expect(minion).toContain('an inline self-review is not a substitute');
    expect(minion).toContain('Restore the retained package for the same worker/lane');
    expect(minion).toContain('not BMAD onboarding');
    expect(minion).not.toContain("setup wizard's BMAD provisioning step");
    expect(minion).not.toContain('pi -p');
    expect(minion).not.toContain('claude -p');
  });

  it('the ops persona carries the minion-owned GC build cycle', () => {
    expect(silas).toContain('Minion-owned build cycle');
    expect(silas).toContain('GC-owned build workflow and explicit project/job artifact context');
    expect(silas).toContain('Do not pull that work back between phases');
    expect(silas).toContain('"deliverable": "review"');
    expect(silas).toContain('exact-final-head READY');
    expect(silas).not.toContain('bmad-build');
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
