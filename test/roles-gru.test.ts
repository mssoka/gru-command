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
    // The section sits after Nefario's stress-test and before onboarding; every
    // assertion below reads the section alone, so words the rest of the role
    // already uses (`merged`, `done`) cannot satisfy it.
    const nefario = prompt.indexOf("## Nefario's briefing stress-test");
    const pipeline = prompt.indexOf('## The pipeline (pending work)');
    const onboarding = prompt.indexOf('## Onboarding heists');
    expect(nefario).toBeGreaterThan(-1);
    expect(pipeline).toBeGreaterThan(nefario);
    expect(onboarding).toBeGreaterThan(pipeline);
    const section = prompt.slice(pipeline, onboarding).replace(/\s+/gu, ' ');
    // What it is for: pending work is enqueued at once, never kept in conversation or notes.
    expect(section).toContain('The pipeline is the durable queue of approved heists that are not dispatched yet');
    expect(section).toContain('Pending work lives there, never only in this conversation or in your notes');
    expect(section).toContain('enqueued the moment you decide it, with its full briefing, through authenticated `POST /api/pipeline/enqueue`');
    expect(section).toContain('a follow-up issue, a continuation waiting on a release, and work blocked on another heist');
    expect(section).toContain('read `GET /api/pipeline` to see what is owed');
    expect(section).toContain('no other `POST /api/dispatch` field rides in it');
    expect(section).toContain('docs/PIPELINE.md');
    // The enqueue body the route reads (the route-contract test posts exactly these fields).
    expect(section).toContain('`{ "id", "repo_path", "title", "briefing" }`');
    for (const optional of ['`priority`', '`prerequisites`', '`exclusive_scopes`', '`hold_reason`', '`request_id`', '`"by": "gru"`']) {
      expect(section, `role section missing ${optional}`).toContain(optional);
    }
    expect(section).toContain('a lower number is admitted first');
    expect(section).toContain('The `id` becomes the job id, so make it lowercase');
    // Dependencies: pipeline entries with the closed milestone set; outside heists are holds.
    const milestones = PIPELINE_MILESTONES.map((milestone) => `\`${milestone}\``);
    expect(section).toContain(`the milestone is ${milestones.slice(0, -1).join(', ')} or ${milestones.at(-1)}`);
    expect(section).toContain('A prerequisite names another pipeline entry');
    expect(section).toContain('`merged` and `done` are separate endings of a job and neither satisfies the other; `delivered` is satisfied by either');
    expect(section).toContain('A dependency on a heist dispatched outside the pipeline is a `hold_reason` that names that heist');
    expect(section).toContain('`POST /api/pipeline/entries/<id>/clear-hold`');
    expect(section).toContain('`POST /api/pipeline/entries/<id>/cancel`');
    expect(section).toContain('An entry has one hold reason, so when it also owes its review (below), name both and clear the hold only when each is met');
    expect(section).toContain('A failed entry cannot be cancelled: supersede it under a new `id`');
    // Immutability, review before release, pacing.
    expect(section).toContain('Briefings are immutable once enqueued');
    expect(section).toContain('A correction before admission is a cancel and re-enqueue under a new `id` (and a new `request_id` if you set one)');
    expect(section).toContain('After admission it is an ordinary dispatch amendment');
    expect(section).toContain('Pipeline admission does not run the briefing-review gate');
    expect(section).toContain('enqueue each entry held');
    expect(section).toContain('run one briefing review of the exact briefing before you clear the hold');
    expect(section).toContain('correct it with one amendment after admission, not a cancel for another round');
    expect(section).toContain("the round-cap rule's spirit: one review, fix, dispatch");
    expect(section).toContain('is still escalated as `scope-design`, never released');
    expect(section).toContain('The pipeline admits as resident worker capacity allows');
    expect(section).toContain('release holds gradually');
  });

  it('docs/PIPELINE.md documents the routes, states, milestones, bounds and gate gap the code defines, and is linked from the role, FLOW and BRIEFING-REVIEW', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'PIPELINE.md'), 'utf-8').replace(/\s+/gu, ' ');
    // Each assertion reads the section or table that must hold the copy: a state
    // and a milestone share the name `admitted`, and a page-wide match would let
    // either table lose its row.
    const between = (from: string, to: string): string => {
      const start = doc.indexOf(from);
      const stop = doc.indexOf(to, start + from.length);
      expect(start, `docs/PIPELINE.md missing "${from}"`).toBeGreaterThan(-1);
      expect(stop, `docs/PIPELINE.md missing "${to}" after "${from}"`).toBeGreaterThan(start);
      return doc.slice(start, stop);
    };
    const endpoints = between('## Endpoints', '### Enqueue');
    const enqueue = between('### Enqueue', '### Reading');
    const states = between('## States', '## Prerequisites and milestones');
    const milestones = between('## Prerequisites and milestones', '## Priority');
    const priority = between('## Priority', '## Exclusive scopes');
    const scopes = between('## Exclusive scopes', '## Admission');
    // Routes the dispatch server mounts.
    for (const route of [
      'POST /api/pipeline/enqueue',
      'GET /api/pipeline',
      'GET /api/pipeline/entries/<id>',
      'POST /api/pipeline/entries/<id>/hold',
      'POST /api/pipeline/entries/<id>/clear-hold',
      'POST /api/pipeline/entries/<id>/cancel',
    ]) {
      expect(endpoints, `docs/PIPELINE.md missing ${route}`).toContain(`| \`${route}\` |`);
    }
    // Every enqueue body field the route handler reads (the route-contract test
    // in pipeline-server.test.ts posts exactly this documented set).
    for (const field of ['id', 'repo_path', 'title', 'briefing', 'request_id', 'priority', 'prerequisites', 'exclusive_scopes', 'hold_reason', 'by']) {
      expect(enqueue, `docs/PIPELINE.md missing enqueue field ${field}`).toContain(`| \`${field}\` |`);
    }
    // The closed state and milestone vocabularies, straight from the code.
    for (const state of PIPELINE_STATES) {
      expect(states, `docs/PIPELINE.md missing state ${state}`).toContain(`| \`${state}\` |`);
    }
    for (const milestone of PIPELINE_MILESTONES) {
      expect(milestones, `docs/PIPELINE.md missing milestone ${milestone}`).toContain(`| \`${milestone}\` |`);
    }
    // merged and done are separate endings; the role relies on that.
    expect(milestones).toContain('| `merged` | has a job whose status is exactly `merged`. |');
    expect(milestones).toContain('| `done` | has a job whose status is exactly `done`. |');
    expect(milestones).toContain('`delivered` is the milestone both endings satisfy');
    expect(milestones).toContain('A binned dependency does not release a `delivered` dependent');
    // Priority bounds, default and direction, at every site that states them.
    const bounds = `${PIPELINE_PRIORITY_MIN} to ${PIPELINE_PRIORITY_MAX}`;
    expect(enqueue).toContain(`| \`priority\` | no | A JSON number, an integer from ${bounds}. Default ${PIPELINE_PRIORITY_DEFAULT}.`);
    expect(priority).toContain(`an integer from ${bounds}, default ${PIPELINE_PRIORITY_DEFAULT}`);
    expect(priority).toContain(`${PIPELINE_PRIORITY_MIN} is the highest priority and ${PIPELINE_PRIORITY_MAX} the lowest`);
    expect(priority).toContain(`A value outside ${bounds}`);
    expect(priority).toContain('A **lower number is admitted first**');
    expect(scopes).toContain('`exclusive_scopes`');
    // The gate gap and the sharp edges the role depends on.
    expect(doc).toContain('## The briefing-review gate is not run on admission');
    expect(doc).toContain('Making admission honour the gate is a separate change');
    expect(enqueue).toContain('admission refuses them');
    // Linked from the role section and from the dispatch flow, where dispatch is described.
    expect(readFileSync(GRU_MD, 'utf-8')).toContain('docs/PIPELINE.md');
    const flow = readFileSync(join(REPO_ROOT, 'docs', 'FLOW.md'), 'utf-8');
    const dispatchSection = flow.slice(flow.indexOf('## 2. Ops handoff (dispatch)'), flow.indexOf('## 3. Lifecycle on the board'));
    expect(dispatchSection).toContain('(./PIPELINE.md)');
    expect(readFileSync(join(REPO_ROOT, 'docs', 'BRIEFING-REVIEW.md'), 'utf-8')).toContain(
      '(./PIPELINE.md#the-briefing-review-gate-is-not-run-on-admission)',
    );
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
