import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PIPELINE_MILESTONES,
  PIPELINE_PRIORITY_DEFAULT,
  PIPELINE_PRIORITY_MAX,
  PIPELINE_PRIORITY_MIN,
  PIPELINE_STATES,
} from '../src/ledger/pipeline.js';
import { ROLE_DEFINITIONS } from '../src/roles.js';

/**
 * The Gru role definition (EPICS E4 story 2): product-native and
 * runtime-agnostic. `roles/gru.md` is the persona's source of truth;
 * `src/roles.ts` loads it at module load. These pins keep the two from
 * drifting and keep the shipped persona inside the hygiene ruling
 * (generic pattern only — never instance specifics).
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GRU_MD = join(REPO_ROOT, 'roles', 'gru.md');

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
      'Hold `incident:github.default-branch-ci-failed:<owner>/<repo>` (covers `ci-failed`) with no `basis_fingerprint`, ' +
        'so the hold reaches every later head and later red heads of that repository carry the in-flight fix as a ' +
        'restriction, and disposition each item as waiting on the fix job; a later red head is a new item that resolves ' +
        "the earlier head's item and wakes you once.",
    );
    expect(gru).toContain('The alert resolves itself when a newer run of that workflow passes or the failing run is re-run green.');
    // A hold never claims to defer the wake.
    expect(gru).not.toContain('while the fix is in flight');
  });

  it('the chief keeps pending work in the pipeline: enqueue now, dependencies, immutable briefings, review before release, pacing', () => {
    const prompt = ROLE_DEFINITIONS.gru.systemPrompt;
    const gru = prompt.replace(/\s+/gu, ' ');
    // The section sits after Nefario's stress-test and before onboarding.
    const nefario = prompt.indexOf("## Nefario's briefing stress-test");
    const pipeline = prompt.indexOf('## The pipeline (pending work)');
    const onboarding = prompt.indexOf('## Onboarding heists');
    expect(nefario).toBeGreaterThan(-1);
    expect(pipeline).toBeGreaterThan(nefario);
    expect(onboarding).toBeGreaterThan(pipeline);
    // What it is for: pending work is enqueued at once, never kept in conversation or notes.
    expect(gru).toContain('The pipeline is the durable queue of approved heists that are not dispatched yet');
    expect(gru).toContain('Pending work lives there, never only in this conversation or in your notes');
    expect(gru).toContain('enqueued the moment you decide it, with its full briefing, through authenticated `POST /api/pipeline/enqueue`');
    expect(gru).toContain('a follow-up issue, a continuation waiting on a release, and work blocked on another heist');
    expect(gru).toContain('docs/PIPELINE.md');
    // Dependencies: pipeline entries with a closed milestone set; outside heists are holds.
    for (const milestone of PIPELINE_MILESTONES) expect(gru).toContain(`\`${milestone}\``);
    expect(gru).toContain('A prerequisite names another pipeline entry');
    expect(gru).toContain('A dependency on a heist dispatched outside the pipeline is a `hold_reason` that names that heist');
    expect(gru).toContain('`POST /api/pipeline/entries/<id>/clear-hold`');
    expect(gru).toContain('`POST /api/pipeline/entries/<id>/cancel`');
    // Immutability, review before release, pacing.
    expect(gru).toContain('Briefings are immutable once enqueued');
    expect(gru).toContain('A correction before admission is a cancel and re-enqueue');
    expect(gru).toContain('After admission it is an ordinary dispatch amendment');
    expect(gru).toContain('Pipeline admission does not run the briefing-review gate');
    expect(gru).toContain('enqueue each entry held');
    expect(gru).toContain('run one briefing review of the exact briefing before you clear the hold');
    expect(gru).toContain('correct it with one amendment after admission');
    expect(gru).toContain("the round-cap rule's spirit: one review, fix, dispatch");
    expect(gru).toContain('The pipeline admits as resident worker capacity allows');
    expect(gru).toContain('release holds gradually');
  });

  it('docs/PIPELINE.md documents the routes, states, milestones, bounds and gate gap the code defines, and is linked from the role and FLOW', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'PIPELINE.md'), 'utf-8').replace(/\s+/gu, ' ');
    // Routes the dispatch server mounts.
    for (const route of [
      'POST /api/pipeline/enqueue',
      'GET /api/pipeline',
      'GET /api/pipeline/entries/<id>',
      'POST /api/pipeline/entries/<id>/hold',
      'POST /api/pipeline/entries/<id>/clear-hold',
      'POST /api/pipeline/entries/<id>/cancel',
    ]) {
      expect(doc, `docs/PIPELINE.md missing ${route}`).toContain(route);
    }
    // Every enqueue body field the route handler reads.
    for (const field of ['id', 'repo_path', 'title', 'briefing', 'request_id', 'priority', 'prerequisites', 'exclusive_scopes', 'hold_reason', 'by']) {
      expect(doc, `docs/PIPELINE.md missing enqueue field ${field}`).toContain(`| \`${field}\` |`);
    }
    // The closed state and milestone vocabularies, straight from the code.
    for (const state of PIPELINE_STATES) {
      expect(doc, `docs/PIPELINE.md missing state ${state}`).toContain(`| \`${state}\` |`);
    }
    for (const milestone of PIPELINE_MILESTONES) {
      expect(doc, `docs/PIPELINE.md missing milestone ${milestone}`).toContain(`| \`${milestone}\` |`);
    }
    // Priority bounds, default and direction.
    expect(doc).toContain(`an integer from ${PIPELINE_PRIORITY_MIN} to ${PIPELINE_PRIORITY_MAX}, default ${PIPELINE_PRIORITY_DEFAULT}`);
    expect(doc).toContain('A **lower number is admitted first**');
    // The sharp edges the role depends on.
    expect(doc).toContain('A binned dependency does not release a `delivered` dependent');
    expect(doc).toContain('## The briefing-review gate is not run on admission');
    expect(doc).toContain('Making admission honour the gate is a separate change');
    expect(doc).toContain('`exclusive_scopes`');
    // Linked from the role section and from the dispatch flow.
    expect(readFileSync(GRU_MD, 'utf-8')).toContain('docs/PIPELINE.md');
    expect(readFileSync(join(REPO_ROOT, 'docs', 'FLOW.md'), 'utf-8')).toContain('(./PIPELINE.md)');
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
