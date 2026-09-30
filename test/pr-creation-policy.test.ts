import { describe, expect, it } from 'vitest';
import { renderMinionBriefing } from '../src/dispatch/service.js';
import { renderRebriefPrompt } from '../src/dispatch/fix-directive.js';
import { PR_CREATION_RULE } from '../src/dispatch/pr-creation.js';

/**
 * New-PR creation policy (owner instruction 2026-09-30: "fix the minions
 * gh command. remove the draft."): every assembled worker instruction that
 * already authorizes a PR requires ordinary, non-draft creation — `gh pr
 * create` without `--draft`/`-d`, never a draft-then-ready conversion.
 * The rule is conditional by construction: read-only, artifact-only and
 * evidence-only contracts gain no publication permission. This is an
 * instruction contract over generated commands, not a sandbox over
 * arbitrary shell.
 */

function briefingFor(contract: string): string {
  return renderMinionBriefing({
    jobId: 'job-1',
    repoName: 'repo',
    branch: 'gru/job-1',
    worktreePath: '/tmp/wt',
    sha: 'abc123',
    briefing: contract,
  });
}

/** Prompt blocks are hard-wrapped; phrase checks read the flattened text. */
function flat(text: string): string {
  return text.replace(/\s+/gu, ' ');
}

describe('new-PR creation rule', () => {
  it('the initial dispatch briefing requires ordinary, non-draft PR creation', () => {
    const prompt = briefingFor('Implement the fix; open a PR when the suite is green.');
    expect(flat(prompt)).toContain('ordinary, non-draft PR');
    expect(flat(prompt)).toContain('gh pr create without --draft/-d');
    expect(prompt).not.toContain('gh pr create --draft');
  });

  it('legacy draft permission in the original briefing is superseded, not obeyed', () => {
    const prompt = flat(
      briefingFor(
        'Deliver the fix and open the PR with gh pr create --draft; a human marks it ready later.',
      ),
    );
    // The contract arrives verbatim (records are not rewritten)…
    expect(prompt).toContain('gh pr create --draft');
    // …but the CURRENT rule follows it and names what supersedes it.
    const legacyAt = prompt.indexOf('gh pr create --draft');
    const ruleAt = prompt.indexOf('supersedes any older draft-mode wording');
    expect(ruleAt).toBeGreaterThan(legacyAt);
    expect(prompt).toContain('never a draft first and never a later draft-to-ready conversion');
  });

  it('a read-only contract gains no publication permission from the rule', () => {
    const prompt = flat(
      briefingFor('Artifact only: inspect the incident and report findings. Do not publish anything.'),
    );
    expect(prompt).toContain('this rule grants no new publication permission');
    expect(prompt).toContain('when, and only when, the contract already authorizes opening a pull request');
    expect(prompt).toContain('still publish nothing');
  });

  it('the fresh re-brief contract carries the same current rule', () => {
    const prompt = flat(
      renderRebriefPrompt({
        jobId: 'job-2',
        briefing: 'old wording: you may open the PR as a draft',
        note: 'stalled three rounds; start from the current rules',
      }),
    );
    expect(prompt).toContain('ordinary, non-draft PR');
    expect(prompt).toContain('gh pr create without --draft/-d');
    expect(prompt).toContain('supersedes any older draft-mode wording');
  });

  it('the shared rule block offers no draft-to-ready workaround', () => {
    expect(PR_CREATION_RULE).not.toContain('gh pr ready');
    expect(PR_CREATION_RULE).not.toContain('mark it ready');
  });
});
