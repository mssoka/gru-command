import { defaultGhRunner, repoFullName, type GhCommandRunner, type RepoRef } from '../dispatch/github-poll.js';
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
 * GitLab transport for the managed repository overview (#480): the user's
 * own `glab` CLI login, the way GitHub rows use `gh`. Each read is one
 * `glab api --hostname <host> --include <path>` run (15 s, byte-bounded
 * output) against `/api/v4/projects/:path`; GC never reads or handles a
 * GitLab token — glab owns the credential. `--include` prints the HTTP
 * status line and headers before the body, so counts come from `X-Total`
 * and failures are classified by status (401 auth, 403 permission — auth
 * when the login lacks `read_api`/`api` — 404 not-found, 429 rate-limit;
 * 5xx, timeouts and shape faults are other). A missing glab, or a host
 * glab has no login for, is auth and names the fix. The tracker owns
 * budgets, freshness and abort scopes; glab is only ever run for a host
 * `isGitLabRemote` accepts.
 */

/** Per-run bound for one `glab api` call. */
export const GITLAB_OVERVIEW_TIMEOUT_MS = 15_000;

/** GitLab's or glab's own text is appended to a failure up to this length. */
const GITLAB_MESSAGE_MAX_CHARS = 160;

/** The failure kind for an HTTP status. A 403 whose OAuth `error` is
 * `insufficient_scope` is the login itself (no `read_api`), so every
 * repository on the host would fail the same way: it reads as auth. */
function kindOfStatus(status: number, oauthError: string | null): RepoFetchErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return oauthError === 'insufficient_scope' ? 'auth' : 'permission';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limit';
  return 'other';
}

/** Whitespace-flattened and bounded display text; null when empty. */
function flatText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const squashed = value.replace(/\s+/gu, ' ').trim();
  return squashed === '' ? null : squashed.slice(0, GITLAB_MESSAGE_MAX_CHARS);
}

/** An ANSI CSI sequence (colour, cursor) as a CLI may print to stderr. */
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`, 'gu');

/** CLI output as display text: escape sequences and control characters
 * removed, whitespace flattened, bounded; null when empty. */
function cliText(value: string): string | null {
  return flatText(value.replace(ANSI_SEQUENCE, '').replace(/\p{Cc}/gu, ' '));
}

/** GitLab's `scope` field is echoed only when it reads as a short list of
 * scope names, never as arbitrary server text inside Gru's advice. */
const SCOPE_NAMES = /^[a-z_]+( [a-z_]+)*$/u;

/** What to do when glab's login lacks the scope the overview reads with. */
function missingScopeRemedy(host: string, accepted: string | null): string {
  return (
    `glab's login for ${host} lacks the read_api or api scope — run \`glab auth login --hostname ${host}\` ` +
    `with a read_api or api token${accepted !== null ? `; GitLab accepts ${accepted}` : ''}`
  );
}

/** GitLab's short error text — `{"message": "404 Project Not Found"}`, or
 * an OAuth-style `{"error": "invalid_token", "error_description": …}` —
 * and that OAuth `error` code; null where the body carries none. For a
 * missing scope (`insufficient_scope`) GitLab's own description never
 * says what to do, so only the scopes it accepts are kept. */
function gitLabErrorOf(text: string): {
  readonly detail: string | null;
  readonly oauthError: string | null;
  readonly accepted: string | null;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { detail: null, oauthError: null, accepted: null };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { detail: null, oauthError: null, accepted: null };
  }
  const body = parsed as Record<string, unknown>;
  const oauthError = flatText(body['error']);
  if (oauthError === 'insufficient_scope') {
    const scope = body['scope'];
    const accepted = typeof scope === 'string' && scope.length <= 40 && SCOPE_NAMES.test(scope) ? scope : null;
    return { detail: null, oauthError, accepted };
  }
  return {
    detail: flatText(body['message']) ?? flatText(body['error_description']) ?? oauthError,
    oauthError,
    accepted: null,
  };
}

interface IncludedResponse {
  readonly status: number;
  /** Header values by lowercased name. */
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
}

/** Split `glab api --include` output — a status line (`HTTP/2.0 200 OK`),
 * `Name: value` header lines, a blank line, then the body — tolerating
 * CRLF and any header case; null when it carries no status line. */
function parseIncluded(stdout: string): IncludedResponse | null {
  const separator = /\r?\n\r?\n/u.exec(stdout);
  const head = separator === null ? stdout : stdout.slice(0, separator.index);
  const body = separator === null ? '' : stdout.slice(separator.index + separator[0].length);
  const [statusLine = '', ...headerLines] = head.split(/\r?\n/u);
  const status = /^HTTP\/\d+(?:\.\d+)? (\d{3})(?: |$)/u.exec(statusLine);
  if (status === null) return null;
  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status: Number(status[1]), headers, body };
}

/** A runner error that is one run's own bound (a slow or oversized
 * response), never evidence that glab is missing. */
const RUN_BOUND = /timed out|output exceeds|UTF-8/iu;

/** glab's verdict for a host it holds no login for. */
const NOT_LOGGED_IN = /unauthenticated|not logged in|no token/iu;

export class GitLabRepoOverviewApi implements GitLabRepoOverviewApiPort {
  constructor(
    private readonly run: GhCommandRunner = defaultGhRunner('glab', { timeoutMs: GITLAB_OVERVIEW_TIMEOUT_MS }),
    private readonly binary = 'glab',
  ) {}

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
    // glab is only ever run for a host isGitLabRemote accepts, named as a
    // plain hostname, whatever the caller classified.
    if (!isGitLabRemote(host) || !/^[A-Za-z0-9.-]+$/u.test(host)) {
      throw new RepoProviderError('other', `${label}: not a GitLab host — glab is never run for it`);
    }
    const login = `\`glab auth login --hostname ${host}\``;
    const path = `projects/${encodeURIComponent(repoFullName(repo))}${suffix}`;
    const result = await this.run(['api', '--hostname', host, '--include', path]);
    if (result.error !== undefined && result.error !== '') {
      const detail = cliText(result.error.replace(/\bgh api\b/gu, `${this.binary} api`)) ?? 'no detail';
      if (RUN_BOUND.test(result.error)) throw new RepoProviderError('other', `${label}: ${detail}`);
      throw new RepoProviderError('auth', `glab is unavailable (${detail}) — install the GitLab CLI and run ${login}`);
    }
    const response = parseIncluded(result.stdout);
    if (response === null) {
      const stderr = cliText(result.stderr);
      if (result.status !== 0 && stderr !== null && NOT_LOGGED_IN.test(stderr)) {
        throw new RepoProviderError('auth', `glab is not logged in to ${host} — run ${login}`);
      }
      throw new RepoProviderError(
        'other',
        result.status === 0
          ? `${label}: ${this.binary} api printed no HTTP status line`
          : `${label}: ${this.binary} exited ${result.status}${stderr !== null ? `: ${stderr}` : ''}`,
      );
    }
    if (response.status >= 400) {
      const { detail, oauthError, accepted } = gitLabErrorOf(response.body);
      const kind = kindOfStatus(response.status, oauthError);
      // The remedy leads the message, so the row bound (and the prefix an
      // aborted row adds) can never cut it off behind a long project path.
      if (oauthError === 'insufficient_scope') {
        throw new RepoProviderError(kind, `${missingScopeRemedy(host, accepted)} (${label}: HTTP ${response.status})`);
      }
      throw new RepoProviderError(kind, `${label}: HTTP ${response.status}${detail !== null ? ` (${detail})` : ''}`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new RepoProviderError('other', `${label}: HTTP ${response.status}`);
    }
    let body: unknown;
    try {
      body = JSON.parse(response.body);
    } catch {
      throw new RepoProviderError('other', `${label}: response is not valid JSON`);
    }
    return { body, total: response.headers.get('x-total') ?? null };
  }
}
