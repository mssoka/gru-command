import { spawnSync } from 'node:child_process';
import { isGitHubRemote, isGitLabRemote } from '../review-path.js';

/**
 * Fresh-head freeze resolution (hotfix): a round that reviews a PR branch
 * must freeze the LIVE branch tip, never a recorded pointer.
 *
 * Regression this closes: the freeze resolved the job lane's local branch
 * ref, recorded a target the pull request had already moved past, and the
 * round reviewed stale code — delivery then (correctly) refused the report
 * and the whole round was wasted. From here on the recorded identity is
 * only a hint: the freeze source is `git fetch origin <branch>` cross-
 * checked against the code host's live pull/merge-request head, and any
 * disagreement aborts before a review worktree or lens exists.
 *
 * Regression the second round closes (job `rebase-60`): the branch to
 * fetch was derived from the caller's candidate ref, which for a default
 * arm is the job lane branch `gru/<jobId>`. A lane that never pushed its
 * own name — a rebase lane pushing the PR branch instead — made the round
 * fail on `fatal: couldn't find remote ref refs/heads/<jobId>`, even
 * though the pull request's real head branch existed. A PR round now reads
 * the source branch from the PR identity (`headRefName`) itself: the
 * candidate ref is a hint for the probe double only and is never used as
 * the freeze target.
 */

const GIT_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const COMMIT_SHA = /^[0-9a-f]{40}$/iu;

export interface PrHeadIdentity {
  /** The pull/merge-request source branch name (no `refs/heads/` prefix). */
  readonly headRefName: string;
  /** The live head commit of that source branch. */
  readonly headSha: string;
}

/** Reads the live head identity of the pull/merge request a round is about
 * to review. Production probes the code host; tests inject a double. */
export type PrHeadProbe = (input: {
  readonly prUrl: string;
  readonly repoPath: string;
  /** The candidate branch the caller had in hand (the lane ref or an
   * explicit `target_ref`). A hint for probe doubles only: production reads
   * the branch from the PR itself, and the result is never the freeze
   * source. */
  readonly branchRef: string;
}) => Promise<PrHeadIdentity>;

export type PrHeadFailure = 'fetch-failed' | 'probe-failed' | 'head-mismatch';

/** A PR round could not prove the head it was about to freeze. The round
 * must not start; the message names the concrete next action. */
export class PrHeadVerificationError extends Error {
  constructor(readonly code: PrHeadFailure, message: string) {
    super(message);
    this.name = 'PrHeadVerificationError';
  }
}

interface GitOutcome {
  readonly ok: boolean;
  readonly stdout: string;
  readonly detail: string;
}

function gitOutput(repoPath: string, args: readonly string[], gitBinary: string, timeoutMs = GIT_TIMEOUT_MS): GitOutcome {
  const result = spawnSync(gitBinary, ['-C', repoPath, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined) return { ok: false, stdout: '', detail: String(result.error) };
  const stdout = result.stdout ?? '';
  if (result.status !== 0) {
    return { ok: false, stdout, detail: `${(result.stderr ?? '').trim().slice(0, 500) || 'git exited non-zero'} (exit ${result.status ?? 'unknown'})` };
  }
  return { ok: true, stdout, detail: '' };
}

/**
 * The PR source branch a candidate ref names, or null when the candidate
 * is not a branch this repository tracks (a commit SHA, a tag, a revision
 * expression like `HEAD~1`, or a tracking ref of a remote other than
 * origin). A branch candidate is the trigger for fresh-head resolution;
 * everything else keeps the caller's explicit pin.
 */
export function prBranchCandidate(repoPath: string, candidateRef: string, gitBinary = 'git'): string | null {
  if (candidateRef.trim() === '') return null;
  const resolved = gitOutput(repoPath, ['rev-parse', '--symbolic-full-name', '--verify', candidateRef], gitBinary);
  if (!resolved.ok) return null;
  const symbolic = resolved.stdout.trim();
  if (symbolic.startsWith('refs/heads/')) return symbolic.slice('refs/heads/'.length);
  if (symbolic.startsWith('refs/remotes/origin/')) return symbolic.slice('refs/remotes/origin/'.length);
  return null;
}

/** Fetch `origin <branch>` fresh and return the fetched tip (the refspec
 * updates the remote-tracking ref deterministically even when the remote's
 * configured refspec differs). */
function fetchOriginBranchTip(input: { repoPath: string; branch: string; gitBinary: string }): string {
  const refspec = `+refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`;
  const fetched = gitOutput(input.repoPath, ['fetch', '--no-tags', 'origin', refspec], input.gitBinary, FETCH_TIMEOUT_MS);
  if (!fetched.ok) {
    throw new PrHeadVerificationError(
      'fetch-failed',
      `cannot fetch origin/${input.branch} fresh for the review freeze: ${fetched.detail}. ` +
        'The round was not started; verify the remote/credentials and that the branch exists on origin, then request the review again.',
    );
  }
  const tip = gitOutput(input.repoPath, ['rev-parse', '--verify', `refs/remotes/origin/${input.branch}^{commit}`], input.gitBinary);
  if (!tip.ok || tip.stdout.trim() === '') {
    throw new PrHeadVerificationError(
      'fetch-failed',
      `origin/${input.branch} did not resolve after the fetch: ${tip.detail || 'empty revision'}. ` +
        'The round was not started; request the review again once the branch is fetchable.',
    );
  }
  return tip.stdout.trim().toLowerCase();
}

function checkedPrHead(headRefName: string, headSha: string, url: string): PrHeadIdentity {
  if (!COMMIT_SHA.test(headSha.trim())) {
    throw new PrHeadVerificationError('probe-failed', `the code host did not report a commit head for ${url}`);
  }
  if (headRefName.trim() === '') {
    throw new PrHeadVerificationError('probe-failed', `the code host did not report the head branch for ${url}`);
  }
  return { headRefName: headRefName.trim(), headSha: headSha.trim().toLowerCase() };
}

/** GitHub head probe: the same `gh api` identity read the SHA-bound poster
 * performs at delivery (`--hostname` keeps GitHub Enterprise honest). */
function githubPrHead(url: URL): PrHeadIdentity {
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/u.exec(url.pathname);
  if (match === null) {
    throw new PrHeadVerificationError('probe-failed', `not a GitHub pull request URL: ${url.href}`);
  }
  const owner = match[1]!;
  const repo = match[2]!;
  const number = match[3]!;
  const result = spawnSync(
    'gh',
    ['api', '--hostname', url.host, `repos/${owner}/${repo}/pulls/${number}`, '--jq', '[.head.ref,.head.sha] | @tsv'],
    { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.error !== undefined) {
    throw new PrHeadVerificationError('probe-failed', `gh is unavailable (${String(result.error)}) — cannot verify the pull request head`);
  }
  if (result.status !== 0) {
    throw new PrHeadVerificationError(
      'probe-failed',
      `gh api pull identity exited ${result.status}: ${(result.stderr ?? '').trim().slice(0, 300)}`,
    );
  }
  const [headRefName = '', headSha = ''] = (result.stdout ?? '').trim().split('\t');
  return checkedPrHead(headRefName, headSha, url.href);
}

/** GitLab merge-request head probe: the same REST identity the GitLab
 * poster reads, with the same token fallbacks. */
async function gitlabPrHead(url: URL): Promise<PrHeadIdentity> {
  const match = /^\/(.+)\/-\/merge_requests\/(\d+)\/?$/u.exec(url.pathname);
  if (match === null) {
    throw new PrHeadVerificationError('probe-failed', `not a GitLab merge request URL: ${url.href}`);
  }
  const projectPath = match[1]!;
  const iid = match[2]!;
  const token = process.env['GITLAB_TOKEN'] ?? process.env['GL_TOKEN'];
  if (token === undefined || token.trim() === '') {
    throw new PrHeadVerificationError('probe-failed', 'GitLab review-target verification requires GITLAB_TOKEN or GL_TOKEN');
  }
  let response: Awaited<ReturnType<typeof fetch>>;
  try {
    response = await fetch(`https://${url.host}/api/v4/projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}`, {
      headers: { 'PRIVATE-TOKEN': token },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new PrHeadVerificationError(
      'probe-failed',
      `GitLab merge request head probe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new PrHeadVerificationError('probe-failed', `GitLab merge request head probe exited HTTP ${response.status}`);
  }
  let payload: { source_branch?: unknown; sha?: unknown };
  try {
    payload = JSON.parse((await response.text()).slice(0, 4 * 1024 * 1024)) as typeof payload;
  } catch {
    throw new PrHeadVerificationError('probe-failed', 'GitLab merge request head response was not valid JSON');
  }
  return checkedPrHead(
    typeof payload.source_branch === 'string' ? payload.source_branch : '',
    typeof payload.sha === 'string' ? payload.sha : '',
    url.href,
  );
}

/** Production probe: dispatch by code host, fail closed on anything else. */
export async function defaultPrHeadProbe(input: {
  readonly prUrl: string;
  readonly repoPath: string;
  readonly branchRef: string;
}): Promise<PrHeadIdentity> {
  let url: URL;
  try {
    url = new URL(input.prUrl.trim());
  } catch {
    throw new PrHeadVerificationError('probe-failed', `cannot parse pull request URL: ${input.prUrl}`);
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new PrHeadVerificationError('probe-failed', `pull request URL is not an https URL without credentials: ${input.prUrl}`);
  }
  if (isGitHubRemote(url.host)) return githubPrHead(url);
  if (isGitLabRemote(url.host)) return gitlabPrHead(url);
  throw new PrHeadVerificationError(
    'probe-failed',
    `unsupported code host for review-target verification: ${url.host} (GitHub needs gh; GitLab needs GITLAB_TOKEN)`,
  );
}

export interface FreshPrHead {
  /** The fetched branch tip — the only valid freeze source. */
  readonly targetSha: string;
  /** The remote-tracking ref the round must track for movement proof. */
  readonly movementRef: string;
  /** The live code-host head the fetched tip was validated against. */
  readonly prHeadSha: string;
  readonly prHeadRefName: string;
}

export interface FreshPrHeadInput {
  readonly repoPath: string;
  readonly prUrl: string;
  /** The candidate branch the caller had in hand (the lane ref or an
   * explicit `target_ref`) — a probe hint only. The PR's own `headRefName`
   * is the freeze source, never a name synthesized from the job id. */
  readonly branchRef: string;
  readonly gitBinary?: string;
  /** Test seam; production probes the code host. */
  readonly probe?: PrHeadProbe;
}

/**
 * Resolve the exact SHA a PR round may freeze. The code host's live head
 * identity decides WHICH branch is sourced (its `headRefName`); the fetch
 * of that branch is the source of truth for the SHA, and the PR's live
 * head cross-checks it. `targetSha == fetched tip == PR head` or this
 * throws — no caller may run a round on a mystery SHA, and no caller may
 * freeze a lane ref the PR was never opened from.
 */
export async function resolveFreshPrHead(input: FreshPrHeadInput): Promise<FreshPrHead> {
  const candidate = input.branchRef.trim();
  const gitBinary = input.gitBinary ?? 'git';
  const probe = input.probe ?? defaultPrHeadProbe;
  let identity: PrHeadIdentity;
  try {
    identity = await probe({ prUrl: input.prUrl, repoPath: input.repoPath, branchRef: candidate });
  } catch (error) {
    if (error instanceof PrHeadVerificationError) throw error;
    throw new PrHeadVerificationError(
      'probe-failed',
      `pull request head probe failed for ${input.prUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const prHeadRefName = identity.headRefName.trim().replace(/^refs\/heads\//u, '');
  const prHeadSha = identity.headSha.trim().toLowerCase();
  if (!COMMIT_SHA.test(prHeadSha) || prHeadRefName === '') {
    throw new PrHeadVerificationError('probe-failed', `the pull request head probe returned an incomplete identity for ${input.prUrl}`);
  }
  // The PR's own head branch is the freeze source. The caller's candidate
  // (a lane ref like `gru/<jobId>`, or an explicit target) is a hint only:
  // a lane that was never pushed must not fail the round, and a lane that
  // trails origin must never be frozen.
  const targetSha = fetchOriginBranchTip({ repoPath: input.repoPath, branch: prHeadRefName, gitBinary });
  if (prHeadSha !== targetSha) {
    throw new PrHeadVerificationError(
      'head-mismatch',
      `origin/${prHeadRefName} fetched at ${targetSha}, but the pull request (${input.prUrl}) reports head ${prHeadSha} — the branch moved under the freeze. ` +
        'The round was not started; request the review again to freeze the current head.',
    );
  }
  return { targetSha, movementRef: `origin/${prHeadRefName}`, prHeadSha, prHeadRefName };
}
