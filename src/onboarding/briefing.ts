import { createHash } from 'node:crypto';
import { lineSafeLiteral } from '../dispatch/line-safe.js';
import { MANIFEST_PATH } from '../worktrees/manifest.js';

/**
 * The onboarding heist (#427): an ordinary heist whose minion investigates
 * the repository and opens a PR adding its GC manifest. Code knows no
 * ecosystem: nothing here names a language, tool or lockfile, and only the
 * briefing tells the minion how to investigate. Every repository-derived
 * value is a line-safe JSON literal.
 */

/** Spellings git refuses at the end of the lane branch `gru/onboard-<key>`. */
const refUnsafe = (key: string): boolean => key.includes('..') || key.endsWith('.lock') || key.endsWith('.');

/** A stable, job-id-safe key per repository: the name itself when it is
 * already a safe lowercase id that git accepts in a branch name, otherwise
 * a slug plus a hash of the name. */
export function onboardingRepoKey(repo: string): string {
  if (/^[a-z0-9][a-z0-9._-]{0,79}$/u.test(repo) && !refUnsafe(repo)) return repo;
  let slug = repo.toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/\.{2,}/gu, '-').slice(0, 60);
  for (let previous = ''; previous !== slug;) {
    previous = slug;
    slug = slug.replace(/^[^a-z0-9]+|[^a-z0-9]+$/gu, '').replace(/\.lock$/u, '');
  }
  const hash = createHash('sha256').update(repo, 'utf8').digest('hex').slice(0, 10);
  return slug === '' ? hash : `${slug}-${hash}`;
}

/** The deterministic job id of a repository's n-th onboarding heist: a
 * restarted service or a re-read consent file finds the same id. The first
 * is `onboard-<key>`; later ones `onboard<n>-<key>`, which no first id can
 * spell. */
export function onboardingJobId(repo: string, attempt: number): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error(`onboarding attempt must be a positive integer, got ${String(attempt)}`);
  return `onboard${attempt === 1 ? '' : String(attempt)}-${onboardingRepoKey(repo)}`;
}

/** The repository key a job id names when it is an onboarding heist's id. */
export function onboardingKeyOfJob(jobId: string): string | null {
  return /^onboard(?:[2-9]|[1-9][0-9]+)?-(.+)$/u.exec(jobId)?.[1] ?? null;
}

export const onboardingTitle = (repo: string): string => `Onboard ${repo} to GC`;

export function renderOnboardingBriefing(input: {
  readonly repo: string;
  /** What the dispatching scan saw; null when the owner accepted while origin could not be read. */
  readonly origin: { readonly defaultBranch: string; readonly headSha: string } | null;
}): string {
  return [
    `Onboarding heist (#427): give the repository ${lineSafeLiteral(input.repo)} its GC manifest, ${MANIFEST_PATH}, so GC lanes can set themselves up and verify changes.`,
    input.origin === null
      ? `GC could not read origin when this heist was dispatched. First check whether origin's default branch already has ${MANIFEST_PATH}; if it does, open no PR and say so.`
      : `Origin's default branch ${lineSafeLiteral(input.origin.defaultBranch)} at ${input.origin.headSha} has no ${MANIFEST_PATH}. Your lane starts from that commit.`,
    'Investigate the repository itself before writing anything: its CI configuration, its build and dependency files, and its README and contributing docs. Derive every command from what the project already runs or documents. Never guess a command, and never add one the repository does not already use.',
    `Write ${MANIFEST_PATH} with three things:`,
    '- [[setup]] entries: the commands a fresh clone needs before it can build and test. Each must run without any prompt or input, and must be idempotent: running it again on a tree that is already set up succeeds and changes nothing. Never write a setup command that needs a secret (a token, key or password only CI has); name the secret in the PR body instead.',
    '- [verify]: full = the command the project\'s own CI runs to check a change, tests included. Add quick = a faster subset only when the project has one. When the repository has no CI and no test command, leave [verify] out and say so in the PR body.',
    '- reclaim: the repo-relative folders that setup or builds create and that git already ignores, so GC can delete and recreate them. List only folders the repository\'s ignore rules ignore today; never tracked files, source, configuration or data. When unsure about a folder, leave it out; an empty list is fine.',
    'Shape (reclaim is a top-level key, so it goes before the first table):',
    '  reclaim = ["<git-ignored folder that setup or builds create>"]',
    '  [[setup]]',
    '  command = "<non-interactive, idempotent setup command>"',
    '  [verify]',
    '  full = "<the command the project\'s CI runs>"',
    'Run every setup command and the full verify command (when there is one) in your lane before you open the PR, and run setup twice to show it is idempotent.',
    `Change no other files: the PR adds ${MANIFEST_PATH} and nothing else.`,
    `Before opening a PR, look for an open PR titled ${lineSafeLiteral(onboardingTitle(input.repo))} from an earlier onboarding heist; if there is one, update it instead of opening a duplicate.`,
    `Otherwise open a pull request titled ${lineSafeLiteral(onboardingTitle(input.repo))}. In its body, name the file each command came from and what running it in your lane showed.`,
  ].join('\n');
}
