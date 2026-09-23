import { execFileSync } from 'node:child_process';
import type { PrHeadProbe } from '../../src/dispatch/perkins-review/fresh-head.js';

/**
 * Probe double for PR rounds driven by a real fixture repo with a bare
 * `origin`: report the branch name and the fetched remote-tracking tip —
 * the same identity a live code-host probe would confirm after the freeze
 * fetch. Tests that want to simulate a host disagreement pass their own
 * probe instead.
 */
export function originHeadProbe(): PrHeadProbe {
  return async ({ repoPath, branchRef }) => ({
    headRefName: branchRef,
    headSha: execFileSync('git', ['-C', repoPath, 'rev-parse', `refs/remotes/origin/${branchRef}`], {
      encoding: 'utf-8',
    }).trim(),
  });
}
