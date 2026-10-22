import { repoFullName, type RepoRef } from '../dispatch/github-poll.js';
import { isGitLabRemote } from '../dispatch/review-path.js';
import {
  RepoProviderError,
  gitLabPipelineOf,
  gitLabProjectMetaOf,
  type GitLabPipelineRaw,
  type GitLabProjectMeta,
  type GitLabRepoOverviewApiPort,
  type RepoFetchErrorKind,
} from './overview.js';

/**
 * GitLab REST transport for the managed repository overview (#480). The
 * tracker owns budgets, freshness and abort scopes; this adapter only
 * reads one project through `/api/v4/projects/:path` and classifies each
 * failure by HTTP status (401 auth, 403 permission — auth when the token
 * lacks `read_api` — 404 not-found, 429 rate-limit; network, timeout, 5xx
 * and shape faults are other).
 *
 * The token (`GITLAB_TOKEN`, falling back to `GL_TOKEN` — the resolver
 * Perkins delivery uses) rides only the `PRIVATE-TOKEN` header, only over
 * https, and only to a host `isGitLabRemote` accepts. Redirects are
 * refused so the header can never follow one to another origin, and the
 * token never appears in a URL, a message or a log.
 */

/** Per-request bound, the GitLab precedent's timeout. */
export const GITLAB_OVERVIEW_TIMEOUT_MS = 15_000;

/** GitLab's own `message` text is appended to a failure up to this length. */
const GITLAB_MESSAGE_MAX_CHARS = 160;

export interface GitLabFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type GitLabFetch = (
  url: string,
  init: {
    readonly headers: Record<string, string>;
    readonly redirect: 'error';
    readonly signal: AbortSignal;
  },
) => Promise<GitLabFetchResponse>;

export interface GitLabRepoOverviewApiOptions {
  readonly fetchImpl?: GitLabFetch;
  readonly tokenResolver?: () => string | undefined;
  readonly timeoutMs?: number;
}

/** The failure kind for an HTTP status. A 403 whose OAuth `error` is
 * `insufficient_scope` is the token itself (no `read_api`), so every
 * repository on the host would fail the same way: it reads as auth. */
function kindOfStatus(status: number, oauthError: string | null): RepoFetchErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return oauthError === 'insufficient_scope' ? 'auth' : 'permission';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limit';
  return 'other';
}

/** GitLab's short error text — `{"message": "404 Project Not Found"}`, or
 * an OAuth-style `{"error": "insufficient_scope", "error_description": …}`
 * — and that OAuth `error` code; null where the body carries none. */
function gitLabErrorOf(text: string): { readonly detail: string | null; readonly oauthError: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { detail: null, oauthError: null };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { detail: null, oauthError: null };
  const body = parsed as Record<string, unknown>;
  const flat = (value: unknown): string | null => {
    if (typeof value !== 'string') return null;
    const squashed = value.replace(/\s+/gu, ' ').trim();
    return squashed === '' ? null : squashed.slice(0, GITLAB_MESSAGE_MAX_CHARS);
  };
  const oauthError = flat(body['error']);
  return { detail: flat(body['message']) ?? flat(body['error_description']) ?? oauthError, oauthError };
}

/** The project API URL, or null when the host cannot form a plain https
 * origin (a port, credentials or a host the URL parser rewrites). */
function projectApiUrl(repo: RepoRef, suffix: string): string | null {
  let url: URL;
  try {
    url = new URL(`https://${repo.host}/api/v4/projects/${encodeURIComponent(repoFullName(repo))}${suffix}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname.toLowerCase() !== repo.host.toLowerCase()) return null;
  if (url.username !== '' || url.password !== '' || url.port !== '') return null;
  return url.toString();
}

function redact(text: string, token: string): string {
  return text.split(token).join('[redacted]');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A transport failure's detail. Node's fetch throws a bare
 * `TypeError('fetch failed')` and keeps the real reason (DNS, TLS, a
 * refused connection or redirect) in `cause`, with its `code`. */
function transportDetailOf(error: unknown): string {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  if (cause === undefined || cause === null) return messageOf(error);
  const code = (cause as { code?: unknown }).code;
  return `${messageOf(error)}: ${messageOf(cause)}${typeof code === 'string' && code !== '' ? ` [${code}]` : ''}`;
}

export class GitLabRepoOverviewApi implements GitLabRepoOverviewApiPort {
  private readonly fetchImpl: GitLabFetch;
  private readonly tokenResolver: () => string | undefined;
  private readonly timeoutMs: number;

  constructor(options: GitLabRepoOverviewApiOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? (fetch as unknown as GitLabFetch);
    this.tokenResolver = options.tokenResolver ?? (() => process.env['GITLAB_TOKEN'] ?? process.env['GL_TOKEN']);
    this.timeoutMs = options.timeoutMs ?? GITLAB_OVERVIEW_TIMEOUT_MS;
  }

  async fetchProject(input: { readonly repo: RepoRef }): Promise<GitLabProjectMeta> {
    const label = `project ${repoFullName(input.repo)} on ${input.repo.host}`;
    const { body } = await this.get(input.repo, label, '');
    return gitLabProjectMetaOf(label, body);
  }

  async countOpenMergeRequests(input: { readonly repo: RepoRef }): Promise<number> {
    return this.countList(input.repo, `open merge requests ${repoFullName(input.repo)} on ${input.repo.host}`, '/merge_requests');
  }

  async countOpenIssues(input: { readonly repo: RepoRef }): Promise<number> {
    return this.countList(input.repo, `open issues ${repoFullName(input.repo)} on ${input.repo.host}`, '/issues');
  }

  async latestPipelines(input: {
    readonly repo: RepoRef;
    readonly branch: string;
    readonly limit: number;
  }): Promise<readonly GitLabPipelineRaw[]> {
    const label = `pipelines ${repoFullName(input.repo)}@${input.branch} on ${input.repo.host}`;
    const query = new URLSearchParams({
      ref: input.branch,
      order_by: 'id',
      sort: 'desc',
      per_page: String(input.limit),
    });
    const { body } = await this.get(input.repo, label, `/pipelines?${query.toString()}`);
    if (!Array.isArray(body)) {
      throw new RepoProviderError('other', `${label}: response is not a JSON array`);
    }
    const mapped = body.map((entry) => gitLabPipelineOf(entry));
    // An unreadable entry fails the observation, never silently shrinking
    // the page into a manufactured "no pipeline" claim.
    if (mapped.includes(null)) {
      throw new RepoProviderError('other', `${label}: response carries a malformed pipeline entry`);
    }
    return mapped as GitLabPipelineRaw[];
  }

  /** An exact open count from the list endpoint's `X-Total` header. GitLab
   * omits that header above 10,000 results, so a missing or malformed one
   * fails loud instead of reading as a count. */
  private async countList(repo: RepoRef, label: string, path: string): Promise<number> {
    const query = new URLSearchParams({ state: 'opened', scope: 'all', per_page: '1' });
    const { body, total } = await this.get(repo, label, `${path}?${query.toString()}`);
    if (!Array.isArray(body)) {
      throw new RepoProviderError('other', `${label}: response is not a JSON array`);
    }
    const count = total !== null && /^\d+$/u.test(total.trim()) ? Number(total.trim()) : Number.NaN;
    if (!Number.isSafeInteger(count)) {
      throw new RepoProviderError('other', `${label}: response carries no valid X-Total header (count not exact)`);
    }
    return count;
  }

  private async get(
    repo: RepoRef,
    label: string,
    suffix: string,
  ): Promise<{ readonly body: unknown; readonly total: string | null }> {
    const host = repo.host;
    // The credential guard comes first: an unaccepted host never receives
    // the token, whatever the caller classified.
    if (!isGitLabRemote(host)) {
      throw new RepoProviderError('other', `${label}: not a GitLab host — the GitLab token is never sent to it`);
    }
    const token = this.tokenResolver();
    if (token === undefined || token.trim() === '') {
      throw new RepoProviderError(
        'auth',
        `no GitLab token configured for ${host} — set GITLAB_TOKEN (or GL_TOKEN) in the service environment to a token with the read_api scope that can read ${repoFullName(repo)}`,
      );
    }
    const url = projectApiUrl(repo, suffix);
    if (url === null) {
      throw new RepoProviderError('other', `${label}: the host does not form a plain https API URL`);
    }
    let response: GitLabFetchResponse;
    let text: string;
    try {
      response = await this.fetchImpl(url, {
        headers: { 'PRIVATE-TOKEN': token, Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      throw new RepoProviderError('other', redact(`${label}: request failed (${transportDetailOf(error)})`, token));
    }
    if (!response.ok) {
      // Redact before GitLab's message is cut, so no token prefix survives.
      const { detail, oauthError } = gitLabErrorOf(redact(text, token));
      throw new RepoProviderError(
        kindOfStatus(response.status, oauthError),
        redact(`${label}: HTTP ${response.status}${detail !== null ? ` (${detail})` : ''}`, token),
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new RepoProviderError('other', `${label}: response is not valid JSON`);
    }
    return { body, total: response.headers.get('x-total') };
  }
}
