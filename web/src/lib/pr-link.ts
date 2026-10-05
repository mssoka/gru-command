/**
 * Per-heist PR link labelling (owner approval j-982): a board row whose
 * canonical PR/MR URL carries a trustworthy request number reads
 * `PR #<number> ↗` instead of the generic `PR ↗`.
 *
 * The number is read from the URL ROUTE only — never from a hostname,
 * query, fragment, or the heist title — and stays a string, so large
 * identifiers are rendered exactly (no Number round-trip). Recognized
 * hosts and route shapes mirror the product's existing publication
 * recognition (`src/dispatch/review-path.ts` isGitHubRemote/isGitLabRemote,
 * `src/dispatch/github-poll.ts` parseGitHubPrUrl, `src/dispatch/perkins.ts`
 * GitLab `/-/merge_requests/N`); web is a separate package, so this is the
 * smallest faithful re-expression. Anything unrecognized or unprovable
 * falls back to the generic label — a number is never invented, and the
 * link href is never rewritten here.
 */

const GENERIC_LABEL = 'PR ↗';

/** GitHub pull route: exactly owner/repo, then `pull/<digits>` (trailing
 * slash tolerated; deeper subviews like `/files` are not the canonical
 * request route and stay generic). */
const GITHUB_PULL_ROUTE = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/u;

/** GitLab merge-request route: any project path (nested groups included),
 * then `/-/merge_requests/<digits>` (trailing slash tolerated). */
const GITLAB_MR_ROUTE = /^\/.+\/-\/merge_requests\/(\d+)\/?$/u;

/** GitHub hosts the product recognizes (mirrors `isGitHubRemote`). */
function isGitHubHost(host: string): boolean {
  return /(^|\.)github\.com$/iu.test(host) || host.toLowerCase().endsWith('.github');
}

/** GitLab hosts the product recognizes (mirrors `isGitLabRemote`): a
 * self-hosted host qualifies only when its FIRST label is exactly
 * `gitlab`, so lookalikes never leave the fallback path. */
function isGitLabHost(host: string): boolean {
  if (host.includes('@') || host.includes('/') || host.includes(' ')) return false;
  const lowered = host.toLowerCase();
  return lowered === 'gitlab.com' || lowered.split('.')[0] === 'gitlab';
}

/**
 * The canonical request identifier carried by a supported https PR/MR
 * URL, or null when the URL is not a recognized request route. Digits
 * are returned exactly as written in the route.
 */
export function prNumberFromUrl(prUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(prUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return null;
  const github = GITHUB_PULL_ROUTE.exec(parsed.pathname);
  if (github !== null && isGitHubHost(parsed.host)) return github[3]!;
  const gitlab = GITLAB_MR_ROUTE.exec(parsed.pathname);
  if (gitlab !== null && isGitLabHost(parsed.host)) return gitlab[1]!;
  return null;
}

/** The visible/accessible board-row link label for a heist's PR URL. */
export function prLinkLabel(prUrl: string): string {
  const number = prNumberFromUrl(prUrl);
  return number === null ? GENERIC_LABEL : `PR #${number} ↗`;
}
