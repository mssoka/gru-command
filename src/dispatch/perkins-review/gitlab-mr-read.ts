import type { EventRecord, LedgerApi } from '../../ledger/api.js';
import { redactCredentials } from '../../redaction.js';
import {
  GITLAB_MR_OBSERVED_EVENT,
  GITLAB_MR_READ_FAILED_EVENT,
  type GitLabMrReadErrorKind,
} from '../../review-inputs/ci-evidence.js';
import { isGitLabRemote, parseGitLabMrLink, parseGitLabMrPath } from '../review-path.js';
import { PROBE_TIMEOUT_MS } from './fresh-head.js';

/**
 * Exact-head CI evidence for a GitLab merge request (#519).
 *
 * Right before a native round freezes its inputs the host reads the job's
 * merge request ONCE (`GET /api/v4/projects/<path>/merge_requests/<iid>`, the
 * request the freeze head probe already makes) and records what GitLab said as
 * one durable job event: `gitlab.mr-observed` or `gitlab.mr-read-failed`.
 * `ci-evidence.ts` binds that event, and only that event, to the frozen
 * target. Nothing here polls, and nothing is read for a job whose link is not
 * a GitLab merge request on a host `isGitLabRemote` accepts.
 *
 * The token goes in a `PRIVATE-TOKEN` header to that one host. A recorded
 * detail is credential-redacted and has the token value itself replaced, so a
 * hostile or chatty endpoint cannot put the credential into the ledger.
 */

const MAX_RESPONSE_CHARS = 4 * 1024 * 1024;
const MAX_DETAIL_CHARS = 300;
const TOKEN_PLACEHOLDER = '[redacted]';

export type GitLabMrFetch = typeof fetch;

/** The merge request the job's link names, as a read request. */
export interface GitLabMrReadRequest {
  readonly host: string;
  readonly project: string;
  readonly iid: number;
}

export interface GitLabMrHeadPipeline {
  readonly id: number;
  readonly sha: string;
  readonly status: string;
  readonly source: string | null;
  readonly web_url: string | null;
}

/** What GitLab said, identity taken from the response's own `web_url` (never
 * from the request): the `gitlab.mr-observed` payload before its round id. */
export interface GitLabMrObservedFacts {
  readonly host: string;
  readonly project: string;
  readonly mr_iid: number;
  readonly state: string;
  readonly head_sha: string;
  readonly head_pipeline: GitLabMrHeadPipeline | null;
}

export interface GitLabMrReadFailure {
  readonly host: string;
  readonly project: string;
  readonly mr_iid: number;
  readonly error_kind: GitLabMrReadErrorKind;
  readonly detail: string;
}

export type GitLabMrReadOutcome =
  | { readonly ok: true; readonly observed: GitLabMrObservedFacts }
  | { readonly ok: false; readonly failure: GitLabMrReadFailure };

export interface GitLabMrReadDeps {
  /** Test seam; production uses the global `fetch`. */
  readonly fetch?: GitLabMrFetch;
  /** Test seam; production reads the process environment. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Every spelling of the token a response or an error message could echo. */
function tokenForms(token: string): readonly string[] {
  return [...new Set([token, token.trim()])].filter((form) => form !== '');
}

/** A bounded, single-line, credential-free rendering of an untrusted string. */
function safeDetail(raw: string, token: string | null): string {
  let text = raw;
  for (const form of token === null ? [] : tokenForms(token)) text = text.split(form).join(TOKEN_PLACEHOLDER);
  return redactCredentials(text).replace(/[\r\n]+/gu, ' ').trim().slice(0, MAX_DETAIL_CHARS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error && cause.message !== '' ? `${error.message} (${cause.message})` : error.message;
}

function statusKind(status: number): GitLabMrReadErrorKind {
  switch (status) {
    case 401: return 'auth';
    case 403: return 'permission';
    case 404: return 'not-found';
    case 429: return 'rate-limit';
    default: return 'other';
  }
}

/** The response body as an observation, or the reason it is not one. */
function parseMergeRequest(body: string): { readonly observed: GitLabMrObservedFacts } | { readonly problem: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(0, MAX_RESPONSE_CHARS));
  } catch {
    return { problem: 'the merge request response was not valid JSON' };
  }
  if (!isRecord(parsed)) return { problem: 'the merge request response was not a JSON object' };
  const iid = safeInteger(parsed['iid']);
  const state = nonEmpty(parsed['state']);
  const headSha = nonEmpty(parsed['sha']);
  const webUrl = nonEmpty(parsed['web_url']);
  if (iid === null || state === null || headSha === null || webUrl === null) {
    return { problem: 'the merge request response lacks web_url, iid, state or sha' };
  }
  let identity: { readonly host: string; readonly project: string } | null = null;
  try {
    const url = new URL(webUrl);
    const path = parseGitLabMrPath(url.pathname);
    if (path !== null) identity = { host: url.host, project: path.project };
  } catch {
    // Not a URL: reported below as an unusable web_url.
  }
  if (identity === null) return { problem: 'the merge request response web_url is not a merge request URL' };
  const rawPipeline = parsed['head_pipeline'];
  let headPipeline: GitLabMrHeadPipeline | null = null;
  if (rawPipeline !== null && rawPipeline !== undefined) {
    const id = isRecord(rawPipeline) ? safeInteger(rawPipeline['id']) : null;
    const sha = isRecord(rawPipeline) ? nonEmpty(rawPipeline['sha']) : null;
    const status = isRecord(rawPipeline) ? nonEmpty(rawPipeline['status']) : null;
    if (!isRecord(rawPipeline) || id === null || sha === null || status === null) {
      return { problem: 'the merge request response head_pipeline lacks id, sha or status' };
    }
    headPipeline = { id, sha, status, source: nonEmpty(rawPipeline['source']), web_url: nonEmpty(rawPipeline['web_url']) };
  }
  return {
    observed: { ...identity, mr_iid: iid, state, head_sha: headSha, head_pipeline: headPipeline },
  };
}

/**
 * Read one merge request. Never throws for anything the network or GitLab
 * does: every outcome is an `ok` observation or a classified failure.
 * Callers pass only a link `parseGitLabMrLink` called `supported`; the host
 * is checked again here, where the token is attached.
 */
export async function readGitLabMr(request: GitLabMrReadRequest, deps: GitLabMrReadDeps = {}): Promise<GitLabMrReadOutcome> {
  if (!isGitLabRemote(request.host)) {
    throw new Error(`refusing to send a GitLab token to ${request.host}: not a GitLab host this service supports`);
  }
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetch ?? fetch;
  const failure = (error_kind: GitLabMrReadErrorKind, detail: string, token: string | null): GitLabMrReadOutcome => ({
    ok: false,
    failure: {
      host: request.host, project: request.project, mr_iid: request.iid, error_kind, detail: safeDetail(detail, token),
    },
  });
  const token = env['GITLAB_TOKEN'] ?? env['GL_TOKEN'];
  if (token === undefined || token.trim() === '') {
    return failure('token-missing', 'GITLAB_TOKEN or GL_TOKEN is required to read the merge request', null);
  }
  let status: number;
  let ok: boolean;
  let body: string;
  try {
    // `redirect: 'manual'`: the credential is never forwarded to a redirect target.
    const response = await fetchImpl(
      `https://${request.host}/api/v4/projects/${encodeURIComponent(request.project)}/merge_requests/${request.iid}`,
      { headers: { 'PRIVATE-TOKEN': token }, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), redirect: 'manual' },
    );
    status = response.status;
    ok = response.ok;
    body = await response.text();
  } catch (error) {
    const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
    return failure(name === 'TimeoutError' ? 'timeout' : 'other', describeError(error), token);
  }
  if (!ok) return failure(statusKind(status), `GitLab answered HTTP ${status}: ${body.slice(0, 1024)}`, token);
  const parsed = parseMergeRequest(body);
  if ('problem' in parsed) return failure('other', parsed.problem, token);
  return { ok: true, observed: parsed.observed };
}

type Log = (level: 'info' | 'warn', msg: string, fields?: Record<string, unknown>) => void;

/**
 * The one read a round makes. Returns null — no request, no event — unless
 * the job's PR link is a GitLab merge request on an accepted host. Otherwise
 * appends exactly one `gitlab.mr-observed` / `gitlab.mr-read-failed` event
 * to the job (tagged with the round) and returns it with the link identity
 * the binding compares the response against.
 */
export async function recordGitLabMrRead(input: {
  readonly ledger: Pick<LedgerApi, 'appendCustomEvent'>;
  readonly jobId: string;
  readonly roundId: string;
  readonly prUrl: string | null;
  readonly deps?: GitLabMrReadDeps;
  readonly log?: Log;
}): Promise<{ readonly event: EventRecord; readonly link: GitLabMrReadRequest } | null> {
  const parsed = input.prUrl === null ? null : parseGitLabMrLink(input.prUrl);
  if (parsed === null || parsed.kind !== 'supported') return null;
  const link: GitLabMrReadRequest = { host: parsed.host, project: parsed.project, iid: parsed.iid };
  const outcome = await readGitLabMr(link, input.deps);
  const event = outcome.ok
    ? input.ledger.appendCustomEvent({
        kind: GITLAB_MR_OBSERVED_EVENT,
        jobId: input.jobId,
        roundId: input.roundId,
        payload: { ...outcome.observed, round_id: input.roundId },
      })
    : input.ledger.appendCustomEvent({
        kind: GITLAB_MR_READ_FAILED_EVENT,
        jobId: input.jobId,
        roundId: input.roundId,
        payload: { ...outcome.failure, round_id: input.roundId },
      });
  input.log?.(outcome.ok ? 'info' : 'warn', outcome.ok ? 'GitLab merge request read for the CI evidence' : 'GitLab merge request read failed', {
    job: input.jobId,
    round: input.roundId,
    host: link.host,
    project: link.project,
    mr_iid: link.iid,
    event: event.kind,
    seq: event.seq,
    ...(outcome.ok ? { state: outcome.observed.state } : { error_kind: outcome.failure.error_kind, detail: outcome.failure.detail }),
  });
  return { event, link };
}
