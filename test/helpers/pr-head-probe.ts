import { execFileSync } from 'node:child_process';
import type { PrHeadProbe } from '../../src/dispatch/perkins-review/fresh-head.js';

/**
 * Probe double for PR rounds driven by a real fixture repo with a bare
 * `origin`: report the caller's candidate branch and its fetched
 * remote-tracking tip — the identity the fixtures push for the lane branch.
 * The candidate is a hint only (the production probe reads the PR itself);
 * tests that want a PR head distinct from the lane ref pass their own probe.
 */
export function originHeadProbe(): PrHeadProbe {
  return async ({ repoPath, branchRef }) => ({
    headRefName: branchRef,
    headSha: execFileSync('git', ['-C', repoPath, 'rev-parse', `refs/remotes/origin/${branchRef}`], {
      encoding: 'utf-8',
    }).trim(),
  });
}
