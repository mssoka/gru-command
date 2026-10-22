import { execFile } from 'node:child_process';
import type { LogLevel } from '../logger.js';
import {
  GhApiError,
  GhBudgetExceededError,
  GhRateLimitedError,
  ghApiJson,
  defaultGhRunner,
  repoFullName,
  type GhCommandRunner,
  type RepoRef,
} from '../dispatch/github-poll.js';
import { isGitHubRemote, isGitLabRemote, parseRepoRemote } from '../dispatch/review-path.js';
import { gitProbeEnvironment, resolveManagedRepoPath, type ManagedRepoPath } from './managed-names.js';

/**
 * Managed repository overview (owner-approved compact rows A): a
 * read-only projection of the configured managed-repo registry — each
 * repository's identity/link, repo-wide open PR and open-issue counts
 * (issues excluding PRs) and the newest Actions run on its discovered
 * default branch, with honest freshness.
 *
 * The registry is the exact root-level `managed_repos` list loaded from
 * config — never workspace discovery. Each name resolves to its direct
 * project root; unavailable selections remain honestly visible and spend
 * no GitHub call. Unselected siblings are never resolved or polled.
 *
 * GitHub reads are server-side through the authenticated `gh` seam,
 * bounded by a per-refresh call budget and a rotating cursor so a large
 * registry cannot starve earlier entries, and coalesced so overlapping
 * refreshes share one run. A truncated (discarded) observation is
 * PRIORITIZED on the next pass — resumed at that repository — while a
 * budget too small to complete any observation still rotates fairly. Rate-limit/auth failures abort the refresh;
 * the next cadence re-observes from scratch. A failed repo keeps its
 * last COMPLETE observation (counts and run share one checkedAt), which
 * the board renders as stale with age and the failure — an old green
 * result never reads as current health.
 *
 * Counts come from GitHub's exact aggregate search (`total_count` for
 * `is:open is:pr` / `is:open is:issue`) — `open_issues_count` is
 * deliberately unused because it folds PRs into issues. An
 * `incomplete_results` search is NOT presented as an exact count.
 *
 * The newest default-branch run (never a `pull_request*` or fork run that
 * merely shares the branch name) is selected by (createdAt, id), so a
 * newer queued/running run supersedes an older passed one. `no-workflow`
 * requires the workflows endpoint to prove the repo has none — an empty
 * run page alone never infers it; with workflows present but no
 * default-branch run among the newest runs read (none at all, or only
 * pull-request/fork runs) the state is `never-run`.
 *
 * The same run page feeds the default-branch CI alert (#446) through the
 * optional `onDefaultBranchRuns` hook, called once per complete
 * observation after the row is committed — no extra GitHub call, and a
 * hook failure is logged without touching the row or the pass.
 *
 * GitLab origins (`isGitLabRemote` hosts, nested groups kept) are linked
 * `gitlab` rows observed through the GitLab REST port under the same
 * freshness, atomic-observation, budget and rotation rules: the project
 * gives the default branch, the list endpoints' `X-Total` the exact open
 * merge-request and issue counts, and the newest default-branch pipeline
 * the run. GitLab pipelines never feed the #446 alert. A fatal
 * auth/rate-limit condition aborts only its provider scope (`github`, or
 * `gitlab:<host>`): the other provider's rows are still observed.
 */

// ------------------------------------------------------------------
// Public view model (mirrored by web/src/lib/board-protocol.ts)
// ------------------------------------------------------------------

export const REPO_OVERVIEW_RUN_STATES = [
  'passed',
  'failed',
  'timed-out',
  'startup-failure',
  'action-required',
  'cancelled',
  'skipped',
  'neutral',
  'stale-run',
  'running',
  'queued',
  'no-workflow',
  'never-run',
  'no-branch',
  'unavailable',
  'unknown',
] as const;

export type RepoOverviewRunState = (typeof REPO_OVERVIEW_RUN_STATES)[number];

/** Row freshness: `unchecked` (never attempted), `fresh` (last successful
 * fetch inside the freshness window and no failed re-attempt after it),
 * `stale` (cached data kept past a failed re-attempt or beyond the
 * window), `unavailable` (attempted, no successful data yet). */
export const REPO_OVERVIEW_FRESHNESS = ['unchecked', 'fresh', 'stale', 'unavailable'] as const;

export type RepoOverviewFreshness = (typeof REPO_OVERVIEW_FRESHNESS)[number];

/** The code host a linked row is observed through; its wording follows it. */
export const REPO_PROVIDERS = ['github', 'gitlab'] as const;

export type RepoProvider = (typeof REPO_PROVIDERS)[number];

export interface RepoOverviewRunView {
  readonly state: RepoOverviewRunState;
  /** Raw provider status/conclusion strings — untrusted text, display only. */
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly workflow: string | null;
  readonly branch: string | null;
  readonly runNumber: number | null;
  /** Validated https run URL on the repository host, or null. */
  readonly url: string | null;
  /** Actual provider creation time (the newest-run selection key). */
  readonly runCreatedAt: string | null;
  /** Actual attempt start (`run_started_at`); null while queued/never
   * started. Distinct from creation — never conflated with it. */
  readonly runStartedAt: string | null;
  readonly runUpdatedAt: string | null;
}

export interface RepoOverviewRowView {
  /** Stable identity: the registry directory name. */
  readonly key: string;
  readonly displayName: string;
  readonly linked: boolean;
  /** The code host the row is observed through (null when not linked). */
  readonly provider: RepoProvider | null;
  /** The code host the identity was read from (null when not linked) —
   * lets the web validator pin the link and run URLs to that host. */
  readonly host: string | null;
  /** Validated https repository URL (null when not linked). */
  readonly link: string | null;
  /** Why the repository is not linked (null when linked). */
  readonly linkReason: string | null;
  readonly fullName: string | null;
  readonly openPrs: number | null;
  /** Open issues EXCLUDING pull requests. */
  readonly openIssues: number | null;
  readonly run: RepoOverviewRunView | null;
  readonly freshness: RepoOverviewFreshness;
  /** Completion time of the last successful complete observation (ISO). */
  readonly checkedAt: string | null;
  /** Completion time of the last observation attempt (success or failure,
   * ISO) — null when no attempt has completed. */
  readonly lastAttemptAt: string | null;
  /** Last failed attempt detail (root validation or provider text, bounded); null when clean. */
  readonly error: string | null;
}

export interface RepoOverviewView {
  readonly rows: readonly RepoOverviewRowView[];
}

// ------------------------------------------------------------------
// Policy constants (documented cadence-based freshness rule)
// ------------------------------------------------------------------

/** Refresh cadence; the tracker's timer (0 disables only the timer). */
export const REPO_OVERVIEW_REFRESH_MS = 300_000;
/** Freshness window: data older than this (3 cadences) reads stale even
 * without a recorded failure, so an old green never looks current. */
export const REPO_OVERVIEW_STALE_AFTER_MS = REPO_OVERVIEW_REFRESH_MS * 3;
/** Provider calls allowed per refresh (≈20 repos at ≤5 calls). */
export const REPO_OVERVIEW_MAX_CALLS_PER_REFRESH = 100;
/** Runs read per repository (one call): enough that the newest is
 * selectable robustly and each workflow's latest finished run is usually
 * on the page for the default-branch CI alert (#446). */
export const REPO_OVERVIEW_RUNS_PER_FETCH = 20;
/** Sustained search-API pacing: GitHub allows 30 Search requests/minute,
 * and every repository costs two. One search call every 2 s keeps the
 * pass inside the sustained quota instead of self-inflicting a 403 that
 * aborts the refresh mid-registry. */
export const REPO_OVERVIEW_SEARCH_MIN_INTERVAL_MS = 2_000;
/** Wall-clock bound for one pass's remote-resolution phase: a slow mount
 * or a huge registry must not make classification exceed the cadence. */
export const REPO_OVERVIEW_RESOLVE_BUDGET_MS = 60_000;
/** Wall-clock bound for one pass's provider-fetch phase: even with every
 * `gh` call stalling to its own timeout, a pass defers under the cadence
 * instead of stretching it to tens of minutes. */
export const REPO_OVERVIEW_FETCH_BUDGET_MS = 240_000;

/** The unlinked reason used when a repo's origin remote could not be READ
 * (git failure, timeout, resolution budget) — distinct from a missing
 * remote, and never a discarded row. */
const ORIGIN_READ_FAILED_REASON = 'origin remote could not be read yet';

// ------------------------------------------------------------------
// Outbound port + raw shapes
// ------------------------------------------------------------------

export interface RepoOverviewMeta {
  /** The repository's actual default branch (discovered, never assumed);
   * null when the provider reports none (an empty repository). */
  readonly defaultBranch: string | null;
}

export interface RepoOverviewRunRaw {
  readonly id: number | null;
  readonly name: string | null;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly url: string | null;
  readonly runNumber: number | null;
  /** Actual provider creation time (`created_at`) — the selection key. */
  readonly createdAt: string | null;
  /** Actual attempt start (`run_started_at`), kept DISTINCT from creation:
   * a queued run has no start yet, and a delayed older run can start after
   * a newer run was created. Never substituted for the creation key. */
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
  /** The run's workflow (`workflow_id`) — the default-branch alert's
   * per-workflow verdict key; null when the provider omits it. */
  readonly workflowId: number | null;
  /** The commit the run tested (`head_sha`), lowercased; null unless it is hex. */
  readonly headSha: string | null;
  /** What triggered the run (`event`): a `pull_request*` run can share the
   * default branch's name without testing it. */
  readonly event: string | null;
  /** Whether the head repository differs from the run's own repository,
   * read from the same payload (ids, else full names); null when unknown.
   * Never compared with the configured name: a renamed or transferred
   * repository keeps its old name in the origin remote. */
  readonly fromFork: boolean | null;
}

/** A run that tested the default branch itself: neither a fork's run nor a
 * `pull_request*` run whose head branch merely shares the name (a gitflow
 * release PR, a fork's `develop`). Unknown fork state counts as not a fork. */
export function isDefaultBranchRun(run: Pick<RepoOverviewRunRaw, 'event' | 'fromFork'>): boolean {
  return run.fromFork !== true && !(run.event ?? '').startsWith('pull_request');
}

/** The complete default-branch run page one observation read, handed to
 * the default-branch CI alert (#446). */
export interface DefaultBranchRunsObservation {
  readonly repo: RepoRef;
  readonly branch: string;
  readonly runs: readonly RepoOverviewRunRaw[];
}

/** Actions endpoints can be permanently unavailable (Actions disabled):
 * that is an observable state, not a fetch failure. */
export type ActionsAvailability<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'actions-unavailable' };

export interface RepoOverviewApiPort {
  fetchRepo(input: { readonly repo: RepoRef }): Promise<RepoOverviewMeta>;
  /** Exact repo-wide count of open pull requests. */
  countOpenPulls(input: { readonly repo: RepoRef }): Promise<number>;
  /** Exact repo-wide count of open issues, EXCLUDING pull requests. */
  countOpenIssues(input: { readonly repo: RepoRef }): Promise<number>;
  countWorkflows(input: { readonly repo: RepoRef }): Promise<ActionsAvailability<number>>;
  latestRuns(input: {
    readonly repo: RepoRef;
    readonly branch: string;
    readonly limit: number;
  }): Promise<ActionsAvailability<readonly RepoOverviewRunRaw[]>>;
}

export interface GitLabProjectMeta {
  /** The project's default branch; null for an empty repository
   * (`empty_repo`, whose reported branch is only the instance default) or
   * a project that reports none. */
  readonly defaultBranch: string | null;
  /** False only on an explicit `builds_access_level: 'disabled'` or
   * `jobs_enabled: false`; anything else reads as CI available. */
  readonly ciEnabled: boolean;
}

/** One pipeline from the project pipelines list. */
export interface GitLabPipelineRaw {
  readonly id: number | null;
  /** The project-scoped pipeline number shown as `pipeline #iid`. */
  readonly iid: number | null;
  /** The pipeline's `workflow:name`, when the project sets one. */
  readonly name: string | null;
  readonly status: string | null;
  /** What triggered the pipeline: a `merge_request_event` or child
   * (`parent_pipeline`) pipeline does not test the branch itself. */
  readonly source: string | null;
  readonly ref: string | null;
  readonly url: string | null;
  /** Actual creation time — the selection key, as for GitHub runs. */
  readonly createdAt: string | null;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
}

export interface GitLabRepoOverviewApiPort {
  fetchProject(input: { readonly repo: RepoRef }): Promise<GitLabProjectMeta>;
  /** Exact count of open merge requests (`X-Total`). */
  countOpenMergeRequests(input: { readonly repo: RepoRef }): Promise<number>;
  /** Exact count of open issues (`X-Total`); merge requests are never issues on GitLab. */
  countOpenIssues(input: { readonly repo: RepoRef }): Promise<number>;
  latestPipelines(input: {
    readonly repo: RepoRef;
    readonly branch: string;
    readonly limit: number;
  }): Promise<readonly GitLabPipelineRaw[]>;
}

// ------------------------------------------------------------------
// Pure projections
// ------------------------------------------------------------------

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** A provider timestamp is usable only when it is a parseable ISO string;
 * anything else becomes null so the snapshot can never fail the web
 * validator's date check and freeze the whole board. */
function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value === '' || !Number.isFinite(Date.parse(value))) return null;
  return value;
}

/** The fork flag from one run payload: head and base repository ids when
 * both are numbers, else their full names (case-insensitive), else null. */
function fromForkOf(raw: Record<string, unknown>): boolean | null {
  const head = record(raw['head_repository']);
  const base = record(raw['repository']);
  if (head === null || base === null) return null;
  const headId = countOrNull(head['id']);
  const baseId = countOrNull(base['id']);
  if (headId !== null && baseId !== null) return headId !== baseId;
  const headName = strOrNull(head['full_name']);
  const baseName = strOrNull(base['full_name']);
  if (headName !== null && baseName !== null) return headName.toLowerCase() !== baseName.toLowerCase();
  return null;
}

/** A commit id is usable only as plain hex, lowercased: it is embedded in
 * alert kinds and decision bases, where a separator or a case change would
 * change the identity. */
function shaOrNull(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{7,64}$/iu.test(value) ? value.toLowerCase() : null;
}

/** Map a completed/incomplete run's raw status+conclusion to the fixed
 * display state list; anything unrecognized is `unknown` (never a guess). */
export function runStateOf(status: string | null, conclusion: string | null): RepoOverviewRunState {
  const normalizedStatus = (status ?? '').toLowerCase();
  if (normalizedStatus !== 'completed') {
    if (normalizedStatus === 'in_progress') return 'running';
    if (
      normalizedStatus === 'queued' ||
      normalizedStatus === 'waiting' ||
      normalizedStatus === 'requested' ||
      normalizedStatus === 'pending'
    ) {
      return 'queued';
    }
    return 'unknown';
  }
  switch ((conclusion ?? '').toLowerCase()) {
    case 'success':
      return 'passed';
    case 'failure':
      return 'failed';
    case 'timed_out':
      return 'timed-out';
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    case 'neutral':
      return 'neutral';
    case 'action_required':
      return 'action-required';
    case 'stale':
      return 'stale-run';
    case 'startup_failure':
      return 'startup-failure';
    default:
      return 'unknown';
  }
}

/** Map a GitLab pipeline status to the fixed display state list; anything
 * unrecognized is `unknown`. GitLab carries no separate conclusion. */
export function gitLabPipelineStateOf(status: string | null): RepoOverviewRunState {
  switch ((status ?? '').toLowerCase()) {
    case 'success':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'canceled':
    case 'canceling':
      return 'cancelled';
    case 'skipped':
      return 'skipped';
    case 'running':
      return 'running';
    case 'created':
    case 'waiting_for_resource':
    case 'preparing':
    case 'pending':
    case 'scheduled':
      return 'queued';
    case 'manual':
      return 'action-required';
    default:
      return 'unknown';
  }
}

/** Pipeline sources that can share the default branch's ref without
 * testing the branch itself. */
const GITLAB_NON_BRANCH_SOURCES: ReadonlySet<string> = new Set(['merge_request_event', 'parent_pipeline']);

/** A pipeline that tested the default branch itself. */
export function isDefaultBranchPipeline(pipeline: Pick<GitLabPipelineRaw, 'ref' | 'source'>, branch: string): boolean {
  return pipeline.ref === branch && !GITLAB_NON_BRANCH_SOURCES.has(pipeline.source ?? '');
}

/** The newest-run order: true when `run` is newer than `than` by the
 * ACTUAL CREATION time (createdAt), then id. A run without a parseable
 * creation time is newer only than another unparseable one with a
 * smaller id. */
export function isNewerRun(
  run: Pick<RepoOverviewRunRaw, 'createdAt' | 'id'>,
  than: Pick<RepoOverviewRunRaw, 'createdAt' | 'id'>,
): boolean {
  const runMs = Date.parse(run.createdAt ?? '');
  const thanMs = Date.parse(than.createdAt ?? '');
  const runTime = Number.isFinite(runMs) ? runMs : null;
  const thanTime = Number.isFinite(thanMs) ? thanMs : null;
  if (runTime !== null && thanTime !== null) {
    return runTime > thanTime || (runTime === thanTime && (run.id ?? 0) > (than.id ?? 0));
  }
  if (runTime !== null) return true;
  return thanTime === null && (run.id ?? 0) > (than.id ?? 0);
}

/** Newest run wins by {@link isNewerRun} — provider list order is never
 * trusted alone, and a delayed `run_started_at` can never promote an older
 * run over a newer queued one. */
export function selectLatestRun<T extends Pick<RepoOverviewRunRaw, 'createdAt' | 'id'>>(
  runs: readonly T[],
): T | null {
  let best: T | null = null;
  for (const run of runs) {
    if (best === null || isNewerRun(run, best)) best = run;
  }
  return best;
}

/** The freshness policy, pure: success inside the window and no later
 * failed attempt is fresh; a recorded failure, a later attempt, or an
 * aged success is stale; no success yet is unchecked (never attempted)
 * or unavailable. `failed` makes the failure authoritative even when the
 * attempt shares the success's millisecond. */
export function freshnessOf(input: {
  readonly checkedAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly failed?: boolean;
  readonly nowMs: number;
  readonly staleAfterMs: number;
}): RepoOverviewFreshness {
  const { checkedAt, lastAttemptAt, nowMs, staleAfterMs } = input;
  if (checkedAt === null) return lastAttemptAt === null ? 'unchecked' : 'unavailable';
  if (input.failed === true) return 'stale';
  const checkedMs = Date.parse(checkedAt);
  if (!Number.isFinite(checkedMs)) return 'stale';
  const attemptMs = lastAttemptAt === null ? Number.NaN : Date.parse(lastAttemptAt);
  if (Number.isFinite(attemptMs) && attemptMs > checkedMs) return 'stale';
  return nowMs - checkedMs > staleAfterMs ? 'stale' : 'fresh';
}

const SAFE_REMOTE_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/** The GitHub host charset the web validator accepts. A host outside it
 * (e.g. an underscore) must stay unlinked: emitting it would make every
 * board snapshot fail validation and freeze the whole board. */
const SAFE_HOST = /^[A-Za-z0-9.-]+$/;

/** A registry directory name is legal on disk but may be invisible-only
 * (zero-width/format/combining characters). Emitting it verbatim would
 * fail the mirrored web validator and freeze every snapshot, so an
 * invisible-only name is disclosed as visible escapes — never dropped,
 * never used as an identity. Control/format characters (bidi overrides
 * included), non-ASCII separator spaces and leading combining marks are
 * escaped even beside visible text; combining marks after a visible base
 * remain legitimate in many scripts. */
const VISIBLE_CHARACTER = /[^\p{Cf}\p{Cc}\p{M}\s]/u;
const COMBINING_MARK = /\p{M}/u;
const CONTROL_OR_FORMAT = /[\p{Cf}\p{Cc}]/u;
const SEPARATOR_SPACE = /\p{Zs}/u;

export function safeDisplayName(name: string): string {
  const escape = (char: string): string => `\\u{${char.codePointAt(0)?.toString(16) ?? '?'}}`;
  if (VISIBLE_CHARACTER.test(name)) {
    let hasVisibleBase = false;
    return [...name]
      .map((char) => {
        if (CONTROL_OR_FORMAT.test(char)) {
          hasVisibleBase = false;
          return escape(char);
        }
        if (COMBINING_MARK.test(char)) return hasVisibleBase ? char : escape(char);
        if (SEPARATOR_SPACE.test(char) && char !== ' ') {
          hasVisibleBase = false;
          return escape(char);
        }
        if (VISIBLE_CHARACTER.test(char)) {
          hasVisibleBase = true;
          return char;
        }
        hasVisibleBase = false;
        return char;
      })
      .join('');
  }
  const escaped = [...name]
    .map((char) => (VISIBLE_CHARACTER.test(char) ? char : escape(char)))
    .join('');
  return escaped === '' ? 'unnamed repository' : escaped;
}

function isSafeLinkHost(host: string): boolean {
  if (!SAFE_HOST.test(host) || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) return false;
  // No empty label, anywhere: `foo..github` must stay unlinked.
  return !host.includes('..');
}

/** Build the https repository link from a parsed remote, or null when the
 * host/segments cannot form a safe link (not-linked, never guessed). */
export function githubRepoLink(ref: RepoRef): string | null {
  if (!isGitHubRemote(ref.host)) return null;
  if (!isSafeLinkHost(ref.host)) return null;
  if (!SAFE_REMOTE_SEGMENT.test(ref.owner) || !SAFE_REMOTE_SEGMENT.test(ref.repo)) return null;
  if (ref.owner === '.' || ref.owner === '..' || ref.repo === '.' || ref.repo === '..') return null;
  let url: URL;
  try {
    url = new URL(`https://${ref.host}/${ref.owner}/${ref.repo}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname.toLowerCase() !== ref.host.toLowerCase()) return null;
  if (url.pathname !== `/${ref.owner}/${ref.repo}`) return null;
  return url.toString();
}

/** Build the https project link from a parsed GitLab remote — nested
 * groups kept, every segment safe — or null (not-linked, never guessed).
 * The host rule is `isGitLabRemote`, the same guard that decides where
 * the GitLab token may be sent. */
export function gitlabRepoLink(ref: RepoRef): string | null {
  if (!isGitLabRemote(ref.host)) return null;
  if (!isSafeLinkHost(ref.host)) return null;
  const segments = [...ref.owner.split('/'), ref.repo];
  if (segments.some((segment) => !SAFE_REMOTE_SEGMENT.test(segment) || segment === '.' || segment === '..')) {
    return null;
  }
  const path = `/${segments.join('/')}`;
  let url: URL;
  try {
    url = new URL(`https://${ref.host}${path}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname.toLowerCase() !== ref.host.toLowerCase()) return null;
  if (url.pathname !== path) return null;
  return url.toString();
}

function repoLinkOf(ref: RepoRef, provider: RepoProvider | null): string | null {
  return provider === 'gitlab' ? gitlabRepoLink(ref) : githubRepoLink(ref);
}

/** A provider run URL is linkable only when it is https on the SAME host
 * the repository was read from; anything else is dropped, never rewritten. */
export function safeRunUrl(raw: string | null, host: string): string | null {
  if (raw === null || raw === '') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.hostname.toLowerCase() !== host.toLowerCase()) return null;
  // Credentials must never ride a rendered link, and a non-default port is
  // a different origin than the repository host.
  if (url.username !== '' || url.password !== '' || url.port !== '') return null;
  return url.toString();
}

export type RepoFetchErrorKind = 'rate-limit' | 'auth' | 'permission' | 'not-found' | 'other';

/** A provider failure whose kind the adapter already knows (an HTTP
 * status, a missing credential): classification reads the kind, never the
 * message, so a project or host name can never read as a provider
 * condition. */
export class RepoProviderError extends Error {
  readonly kind: RepoFetchErrorKind;

  constructor(kind: RepoFetchErrorKind, message: string) {
    super(message);
    this.name = 'RepoProviderError';
    this.kind = kind;
  }
}

/** The structured failure detail when the error carries one. Classifying
 * against the annotated label instead would read repository/owner names
 * (e.g. `authentication-service`) as provider semantics. */
function failureText(error: unknown): string {
  if (error instanceof GhApiError && error.causeText !== null) return error.causeText;
  return error instanceof Error ? error.message : String(error);
}

function classifyFailureText(text: string): RepoFetchErrorKind {
  // A timed-out or capped call is ONE repository's slow/fat response, not
  // a global provider condition: it must not abort the rest of the pass.
  if (/timed out|output exceeds/i.test(text)) return 'other';
  if (/rate limit/i.test(text)) return 'rate-limit';
  if (/HTTP 401|not logged in|authentication|bad credentials/i.test(text)) return 'auth';
  if (/HTTP 403|forbidden|permission/i.test(text)) return 'permission';
  if (/HTTP 404|not found/i.test(text)) return 'not-found';
  if (/spawn|ENOENT|EACCES|gh is unavailable/i.test(text)) return 'auth';
  return 'other';
}

/** Classify a failed observation. `rate-limit` and `auth` are scope-wide
 * conditions: the refresh stops observing that provider scope instead of
 * hammering every repository in it. A structured `GhApiError` without a
 * cause is an adapter/shape failure — per-repository, never scope-wide. */
export function classifyGhError(error: unknown): RepoFetchErrorKind {
  if (error instanceof RepoProviderError) return error.kind;
  if (error instanceof GhRateLimitedError) return 'rate-limit';
  if (error instanceof GhApiError && error.causeText === null) return 'other';
  return classifyFailureText(failureText(error));
}

/** Actions endpoints permanently unavailable (404/409/actions-disabled):
 * a state to disclose, not a retry-worthy failure. Classification reads
 * the structured cause only; a label that merely contains the word
 * "actions" can never convert a real failure into a state. */
export function isActionsUnavailableError(error: unknown): boolean {
  if (error instanceof GhApiError && error.causeText === null) return false;
  const text = failureText(error);
  return /HTTP 404|HTTP 409|actions.*disabled|disabled.*actions/i.test(text);
}

function runViewOf(raw: RepoOverviewRunRaw, host: string, branch: string): RepoOverviewRunView {
  return {
    state: runStateOf(raw.status, raw.conclusion),
    status: raw.status,
    conclusion: raw.conclusion,
    workflow: raw.name,
    branch,
    runNumber: raw.runNumber,
    url: safeRunUrl(raw.url, host),
    runCreatedAt: raw.createdAt,
    runStartedAt: raw.startedAt,
    runUpdatedAt: raw.updatedAt,
  };
}

function gitLabRunViewOf(raw: GitLabPipelineRaw, host: string, branch: string): RepoOverviewRunView {
  return {
    state: gitLabPipelineStateOf(raw.status),
    status: raw.status,
    conclusion: null,
    workflow: raw.name,
    branch,
    runNumber: raw.iid,
    url: safeRunUrl(raw.url, host),
    runCreatedAt: raw.createdAt,
    runStartedAt: raw.startedAt,
    runUpdatedAt: raw.updatedAt,
  };
}

/** A run state with no provider run behind it (no branch, no workflow,
 * never run, CI unavailable): no provider strings at all. */
function absentRunView(state: RepoOverviewRunState, branch: string | null): RepoOverviewRunView {
  return {
    state,
    status: null,
    conclusion: null,
    workflow: null,
    branch,
    runNumber: null,
    url: null,
    runCreatedAt: null,
    runStartedAt: null,
    runUpdatedAt: null,
  };
}

// ------------------------------------------------------------------
// gh CLI adapter
// ------------------------------------------------------------------

function repoPathOf(repo: RepoRef): string {
  return `repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
}

function mapRun(value: unknown): RepoOverviewRunRaw | null {
  const raw = record(value);
  if (raw === null) return null;
  return {
    id: countOrNull(raw['id']),
    name: strOrNull(raw['name']),
    status: strOrNull(raw['status']),
    conclusion: strOrNull(raw['conclusion']),
    url: strOrNull(raw['html_url']),
    runNumber: countOrNull(raw['run_number']),
    // Distinct semantics: creation is the selection key; the attempt start
    // is display context and is never substituted for it.
    createdAt: isoOrNull(raw['created_at']),
    startedAt: isoOrNull(raw['run_started_at']),
    updatedAt: isoOrNull(raw['updated_at']),
    workflowId: countOrNull(raw['workflow_id']),
    headSha: shaOrNull(raw['head_sha']),
    event: strOrNull(raw['event']),
    fromFork: fromForkOf(raw),
  };
}

export class GhRepoOverviewApi implements RepoOverviewApiPort {
  constructor(
    private readonly run: GhCommandRunner = defaultGhRunner(),
    private readonly binary = 'gh',
  ) {}

  async fetchRepo(input: { readonly repo: RepoRef }): Promise<RepoOverviewMeta> {
    const label = `repo ${repoFullName(input.repo)}`;
    const parsed = await ghApiJson(this.run, this.binary, label, input.repo.host, repoPathOf(input.repo));
    const raw = record(parsed);
    if (raw === null) {
      throw new GhApiError(`${label}: response is not a JSON object`);
    }
    // A provider-reported null/absent default branch is a legitimate empty
    // repository; any OTHER type is a malformed response and fails loud
    // instead of manufacturing the empty state.
    const branch = raw['default_branch'];
    if (branch === undefined || branch === null) return { defaultBranch: null };
    if (typeof branch !== 'string' || branch === '') {
      throw new GhApiError(`${label}: default_branch must be a non-empty string (got ${JSON.stringify(branch)})`);
    }
    return { defaultBranch: branch };
  }

  async countOpenPulls(input: { readonly repo: RepoRef }): Promise<number> {
    return this.countSearch(input.repo, `repo:${repoFullName(input.repo)} is:open is:pr`);
  }

  async countOpenIssues(input: { readonly repo: RepoRef }): Promise<number> {
    return this.countSearch(input.repo, `repo:${repoFullName(input.repo)} is:open is:issue`);
  }

  private async countSearch(repo: RepoRef, query: string): Promise<number> {
    const label = `search issue counts ${repoFullName(repo)}`;
    const path = `search/issues?${new URLSearchParams({ q: query, per_page: '1' }).toString()}`;
    const parsed = await ghApiJson(this.run, this.binary, label, repo.host, path);
    const raw = record(parsed);
    const total = raw !== null ? countOrNull(raw['total_count']) : null;
    if (total === null) {
      throw new GhApiError(`${label}: response carries no valid total_count`);
    }
    // Fail closed: only an EXPLICIT boolean false proves the aggregate is
    // complete. A missing or non-boolean flag cannot be read as exactness.
    if (raw?.['incomplete_results'] !== false) {
      throw new GhApiError(`${label}: search results are incomplete (count not exact)`);
    }
    return total;
  }

  async countWorkflows(input: { readonly repo: RepoRef }): Promise<ActionsAvailability<number>> {
    const label = `workflows ${repoFullName(input.repo)}`;
    let parsed: unknown;
    try {
      parsed = await ghApiJson(
        this.run,
        this.binary,
        label,
        input.repo.host,
        `${repoPathOf(input.repo)}/actions/workflows?per_page=1`,
      );
    } catch (error) {
      if (isActionsUnavailableError(error)) return { kind: 'actions-unavailable' };
      throw error;
    }
    const raw = record(parsed);
    const total = raw !== null ? countOrNull(raw['total_count']) : null;
    if (total === null) {
      throw new GhApiError(`${label}: response carries no valid total_count`);
    }
    return { kind: 'ok', value: total };
  }

  async latestRuns(input: {
    readonly repo: RepoRef;
    readonly branch: string;
    readonly limit: number;
  }): Promise<ActionsAvailability<readonly RepoOverviewRunRaw[]>> {
    const label = `runs ${repoFullName(input.repo)}@${input.branch}`;
    let parsed: unknown;
    try {
      parsed = await ghApiJson(
        this.run,
        this.binary,
        label,
        input.repo.host,
        `${repoPathOf(input.repo)}/actions/runs?branch=${encodeURIComponent(input.branch)}&per_page=${input.limit}`,
      );
    } catch (error) {
      if (isActionsUnavailableError(error)) return { kind: 'actions-unavailable' };
      throw error;
    }
    const raw = record(parsed);
    const runs = raw !== null ? raw['workflow_runs'] : null;
    if (!Array.isArray(runs)) {
      throw new GhApiError(`${label}: response carries no workflow_runs array`);
    }
    const mapped = runs.map((entry) => mapRun(entry));
    // An unreadable entry must fail the observation, never silently shrink
    // the page into a manufactured "no runs" claim.
    if (mapped.includes(null)) {
      throw new GhApiError(`${label}: response carries a malformed workflow_runs entry`);
    }
    return { kind: 'ok', value: mapped as RepoOverviewRunRaw[] };
  }
}

// ------------------------------------------------------------------
// GitLab payload projections (the transport is ./gitlab-overview.ts)
// ------------------------------------------------------------------

/** The project fields the overview reads. An empty repository reads as no
 * branch whatever branch GitLab reports for it; a null/absent branch is
 * the same state, and any other non-string fails loud. */
export function gitLabProjectMetaOf(label: string, value: unknown): GitLabProjectMeta {
  const raw = record(value);
  if (raw === null) {
    throw new RepoProviderError('other', `${label}: response is not a JSON object`);
  }
  const ciEnabled = !(raw['builds_access_level'] === 'disabled' || raw['jobs_enabled'] === false);
  if (raw['empty_repo'] === true) return { defaultBranch: null, ciEnabled };
  const branch = raw['default_branch'];
  if (branch === undefined || branch === null) return { defaultBranch: null, ciEnabled };
  if (typeof branch !== 'string' || branch === '') {
    throw new RepoProviderError(
      'other',
      `${label}: default_branch must be a non-empty string (got ${JSON.stringify(branch).slice(0, 80)})`,
    );
  }
  return { defaultBranch: branch, ciEnabled };
}

/** One pipeline list entry; null when the entry is not an object. */
export function gitLabPipelineOf(value: unknown): GitLabPipelineRaw | null {
  const raw = record(value);
  if (raw === null) return null;
  return {
    id: countOrNull(raw['id']),
    iid: countOrNull(raw['iid']),
    name: strOrNull(raw['name']),
    status: strOrNull(raw['status']),
    source: strOrNull(raw['source']),
    ref: strOrNull(raw['ref']),
    url: strOrNull(raw['web_url']),
    createdAt: isoOrNull(raw['created_at']),
    startedAt: isoOrNull(raw['started_at']),
    updatedAt: isoOrNull(raw['updated_at']),
  };
}

// ------------------------------------------------------------------
// Remote classification
// ------------------------------------------------------------------

export type RemoteClassification =
  | { readonly kind: 'linked'; readonly ref: RepoRef; readonly provider: RepoProvider }
  | { readonly kind: 'unlinked'; readonly reason: string };

export type RemoteResolver = (repoPath: string) => RepoRef | null | Promise<RepoRef | null>;

/** Read one repo's origin URL without blocking the event loop (the
 * deploy-drift precedent): a registry-wide refresh must never stall the
 * board/WS timers on a slow mount or a large repo count. */
async function gitOriginUrl(repoPath: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repoPath, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8', env: gitProbeEnvironment(), timeout: 10_000, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          const code = (error as NodeJS.ErrnoException).code;
          const killed = (error as { killed?: boolean }).killed === true;
          // ONLY git's own "no such remote" verdict is evidence of an
          // unlinked repo. Every other failure (spawn error, timeout, a
          // corrupt/unreadable repository, permission failure) is a read
          // failure and rejects, so the tracker keeps the previous
          // classification and cached observation.
          if (!killed && typeof code !== 'string' && /No such remote/i.test(String(stderr))) {
            resolve(null);
            return;
          }
          reject(error);
          return;
        }
        const url = stdout.trim();
        resolve(url === '' ? null : url);
      },
    );
  });
}

/** Default resolver: the repo's origin remote parsed by the same seam the
 * tracked-lane poll uses. A missing/unparseable remote resolves null; a
 * git failure rejects (the caller keeps the previous classification). */
export async function defaultRemoteResolver(repoPath: string): Promise<RepoRef | null> {
  const url = await gitOriginUrl(repoPath);
  if (url === null) return null;
  const remote = parseRepoRemote(url);
  if (remote === null) return null;
  return { host: remote.host, owner: remote.owner, repo: remote.repo };
}

function classifyRemoteValue(ref: RepoRef | null): RemoteClassification {
  if (ref === null) return { kind: 'unlinked', reason: 'no usable origin remote' };
  if (isGitHubRemote(ref.host)) {
    if (githubRepoLink(ref) === null) return { kind: 'unlinked', reason: 'unrecognized remote' };
    return { kind: 'linked', ref, provider: 'github' };
  }
  if (isGitLabRemote(ref.host)) {
    if (gitlabRepoLink(ref) === null) return { kind: 'unlinked', reason: 'unrecognized remote' };
    return { kind: 'linked', ref, provider: 'gitlab' };
  }
  return { kind: 'unlinked', reason: 'unsupported code host' };
}

export function classifyRemote(repoPath: string, resolveRemote: (path: string) => RepoRef | null): RemoteClassification {
  return classifyRemoteValue(resolveRemote(repoPath));
}

// ------------------------------------------------------------------
// Tracker
// ------------------------------------------------------------------

interface RepoSourceState {
  ref: RepoRef | null;
  /** Set with `ref`: the code host the identity is observed through. */
  provider: RepoProvider | null;
  linkReason: string | null;
  counts: { readonly openPrs: number; readonly openIssues: number } | null;
  run: RepoOverviewRunView | null;
  checkedAt: string | null;
  lastAttemptAt: string | null;
  error: string | null;
}

function emptySourceState(): RepoSourceState {
  return {
    ref: null,
    provider: null,
    linkReason: null,
    counts: null,
    run: null,
    checkedAt: null,
    lastAttemptAt: null,
    error: null,
  };
}

const ROOT_RESOLUTION_TIMEOUT = Symbol('root resolution timeout');

async function resolveBeforeDeadline<T>(
  work: () => T | Promise<T>,
  timeoutMs: number,
): Promise<T | typeof ROOT_RESOLUTION_TIMEOUT> {
  if (timeoutMs <= 0) return ROOT_RESOLUTION_TIMEOUT;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<typeof ROOT_RESOLUTION_TIMEOUT>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(ROOT_RESOLUTION_TIMEOUT), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export interface ManagedRepoOverviewOptions {
  /** Configured workspace root containing selected project directories. */
  readonly workspaceRoot: string;
  /** Explicit config names only; an empty or absent list means no repos. */
  readonly managedRepos: readonly string[];
  readonly api: RepoOverviewApiPort;
  /** The GitLab REST port; production always wires it. A GitLab row
   * observed without it fails by name. */
  readonly gitlabApi?: GitLabRepoOverviewApiPort;
  /** Test seams. Production membership is always `managedRepos`; no
   * directory discovery fallback exists. */
  readonly scanRepos?: (workspaceRoot: string) => readonly string[] | Promise<readonly string[]>;
  readonly resolveRepoPath?: (workspaceRoot: string, name: string) => Promise<ManagedRepoPath> | ManagedRepoPath;
  readonly resolveRemote?: RemoteResolver;
  /** Refresh cadence; default {@link REPO_OVERVIEW_REFRESH_MS}. */
  readonly intervalMs?: number;
  /** Freshness window; default {@link REPO_OVERVIEW_STALE_AFTER_MS}. */
  readonly staleAfterMs?: number;
  /** Provider calls per refresh; default {@link REPO_OVERVIEW_MAX_CALLS_PER_REFRESH}. */
  readonly maxCallsPerRefresh?: number;
  /** Sleep seam for search pacing; default a real timer (tests advance a
   * fake clock instead of waiting). */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;
  /** The default-branch CI alert (#446): receives each complete
   * observation's run page after the row is committed. A throw is logged
   * at error level and never degrades the row or the pass. */
  readonly onDefaultBranchRuns?: (observation: DefaultBranchRunsObservation) => void;
}

interface ObserveOutcome {
  /** Fatal scope condition (rate limit/auth) — stop observing the
   * repository's provider scope for the rest of the refresh. */
  readonly aborted: boolean;
  /** Budget (call count or wall clock) ran out before a complete
   * observation — nothing was recorded and rotation advances past this
   * repository so no single entry can starve the rest of the registry. */
  readonly retry: boolean;
  /** The abort/failure detail: the classified failure when the pass
   * aborts fatally, the exhausted budget's own message on `retry`, and
   * null otherwise. */
  readonly detail: string | null;
}

/** One complete provider observation, committed atomically by `observe`. */
interface ProviderObservation {
  readonly counts: { readonly openPrs: number; readonly openIssues: number };
  readonly run: RepoOverviewRunView;
  /** GitHub only: the run page for the default-branch CI alert (#446). */
  readonly defaultBranchRuns: DefaultBranchRunsObservation | null;
}

/** The fatal-abort scope a linked row belongs to. GitHub keeps today's
 * single scope (one GitHub abort stops every GitHub host's rows, as before
 * #480); each GitLab host is its own scope. */
function providerScopeOf(state: RepoSourceState): string {
  return state.provider === 'gitlab' && state.ref !== null ? `gitlab:${state.ref.host.toLowerCase()}` : 'github';
}

export class ManagedRepoOverviewTracker {
  private readonly opts: ManagedRepoOverviewOptions;
  private readonly scanRepos: (workspaceRoot: string) => readonly string[] | Promise<readonly string[]>;
  private readonly resolveRepoPath: (workspaceRoot: string, name: string) => Promise<ManagedRepoPath> | ManagedRepoPath;
  private readonly resolveRemote: RemoteResolver;
  private readonly intervalMs: number;
  private readonly staleAfterMs: number;
  private readonly maxCallsPerRefresh: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;
  private readonly states = new Map<string, RepoSourceState>();
  private registry: readonly string[] = [];
  private cursor = 0;
  /** The repository whose observation was discarded incomplete (budget or
   * wall-clock truncation): the NEXT refresh resumes at it so a partially
   * observed tail is prioritized instead of starving behind a repeated
   * prefix. Cleared once honored; a re-discard of an already-prioritized
   * repository rotates on so a budget too small to complete any
   * observation still makes fair progress. */
  private priorityName: string | null = null;
  private lastSearchAtMs: number | null = null;
  private refreshedOnce = false;
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<RepoOverviewView | null> | null = null;

  constructor(opts: ManagedRepoOverviewOptions) {
    this.opts = opts;
    this.scanRepos = opts.scanRepos ?? (() => opts.managedRepos);
    this.resolveRepoPath = opts.resolveRepoPath ?? resolveManagedRepoPath;
    this.resolveRemote = opts.resolveRemote ?? defaultRemoteResolver;
    this.intervalMs = opts.intervalMs ?? REPO_OVERVIEW_REFRESH_MS;
    // A disabled timer (intervalMs 0) must not collapse the freshness
    // window to nothing: the documented 3× cadence rule stays in force.
    this.staleAfterMs =
      opts.staleAfterMs ?? (this.intervalMs > 0 ? this.intervalMs * 3 : REPO_OVERVIEW_STALE_AFTER_MS);
    this.maxCallsPerRefresh = opts.maxCallsPerRefresh ?? REPO_OVERVIEW_MAX_CALLS_PER_REFRESH;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    // The registry is scanned on each refresh; the view stays null (the
    // section hidden) until the first pass has classified it.
  }

  /** Start the boot refresh and the re-check cadence; idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.refresh();
    if (this.intervalMs > 0) {
      this.timer = setInterval(() => void this.refresh(), this.intervalMs);
      this.timer.unref?.();
    }
  }

  /** Stop the cadence; a later start() can resume it. An in-flight pass
   * is allowed to finish (its own bounds apply) — stop() owns the timer,
   * not the pass. */
  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.started = false;
  }

  /** The cached view the board snapshot renders; null until the first
   * refresh pass has run (no data is not the same as an empty registry). */
  view(): RepoOverviewView | null {
    if (!this.refreshedOnce) return null;
    const nowMs = this.now();
    const rows = this.registry.map((name) => {
      const state = this.states.get(name) ?? emptySourceState();
      const linked = state.ref !== null;
      const freshness = linked
        ? freshnessOf({
            checkedAt: state.checkedAt,
            lastAttemptAt: state.lastAttemptAt,
            failed: state.error !== null,
            nowMs,
            staleAfterMs: this.staleAfterMs,
          })
        : 'unchecked';
      return {
        key: name,
        displayName: safeDisplayName(name),
        linked,
        provider: state.ref !== null ? state.provider : null,
        host: state.ref !== null ? state.ref.host : null,
        link: state.ref !== null ? repoLinkOf(state.ref, state.provider) : null,
        linkReason: state.ref !== null ? null : state.linkReason,
        fullName: state.ref !== null ? repoFullName(state.ref) : null,
        openPrs: linked ? state.counts?.openPrs ?? null : null,
        openIssues: linked ? state.counts?.openIssues ?? null : null,
        run: linked ? state.run : null,
        freshness,
        checkedAt: linked ? state.checkedAt : null,
        lastAttemptAt: linked ? state.lastAttemptAt : null,
        error: linked ? state.error : null,
      } satisfies RepoOverviewRowView;
    });
    return { rows };
  }

  /** Re-scan the registry and observe provider state (coalesced). */
  refresh(): Promise<RepoOverviewView | null> {
    if (this.inFlight !== null) return this.inFlight;
    this.inFlight = this.runRefresh()
      .catch((error: unknown) => {
        this.log('error', 'repo overview refresh failed', { error: messageOf(error) });
        return this.view();
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async runRefresh(): Promise<RepoOverviewView | null> {
    const repos = [...new Set(await this.scanRepos(this.opts.workspaceRoot))].sort();
    const seenProjectPaths = new Set<string>();
    const duplicateNames = new Set<string>();
    // Classification is built into a LOCAL map and published only once
    // every remote has been resolved: `view()` (called by board pushes and
    // heartbeats DURING this refresh) must never observe a half-classified
    // entry as `linked:false` without a reason. A changed identity or
    // provider (or a remote that stopped being a safe link) drops the old
    // repository's cached observation — stale data must never attach to a
    // different identity. A resolver ERROR keeps the previous
    // classification and cached observation (a transient git failure is
    // not evidence the remote changed).
    const nextStates = new Map<string, RepoSourceState>();
    const resolveDeadline = this.now() + REPO_OVERVIEW_RESOLVE_BUDGET_MS;
    let resolveBudgetSpent = false;
    let rootResolutionTimedOut = false;
    // Root validation and provider refresh share one rotation point. The
    // next pass starts validating where the prior provider work resumes, so
    // a root that was deferred from provider calls cannot land in the other
    // half of a repeatedly truncated validation window forever.
    const pendingIndex = this.priorityName === null ? -1 : repos.indexOf(this.priorityName);
    const classifyStart = repos.length === 0
      ? 0
      : pendingIndex >= 0 ? pendingIndex : this.cursor % repos.length;
    const classifyOrder = [...repos.slice(classifyStart), ...repos.slice(0, classifyStart)];
    // Advances by ATTEMPTED resolutions (successes AND failures), so a
    // prefix of slow-failing origins also rotates away and can never pin
    // the cursor to the same index every pass.
    let attemptedResolutions = 0;
    const unresolvedThisRefresh = new Set<string>();
    for (const name of classifyOrder) {
      const previous = this.states.get(name);
      const base = previous ?? emptySourceState();
      const unreadable = (
        skipProviderPoll = false,
        detail: string | null = null,
        failureKind = 'root validation failed',
      ): void => {
        if (skipProviderPoll) unresolvedThisRefresh.add(name);
        // A read failure (or the resolution budget) is not evidence the
        // remote changed: keep the previous classification and cached
        // observation when one exists. Origin/root-resolution faults disclose
        // an attempt/error and withhold polling until the identity is validated.
        // A budget skip keeps its prior freshness untouched, but also
        // withholds its cached identity from provider polling. A
        // never-classified entry stays visible with an explicit read-failure
        // reason — every managed repo appears without guessing identity.
        if (previous !== undefined) {
          if (detail === null) {
            nextStates.set(name, previous);
            return;
          }
          const failed = {
            ...previous,
            lastAttemptAt: new Date(this.now()).toISOString(),
            error: (`${failureKind}: ${detail.trim() || 'probe failed without a message'}`).slice(0, 300),
          };
          if (previous.ref === null) failed.linkReason = ORIGIN_READ_FAILED_REASON;
          nextStates.set(name, failed);
          return;
        }
        const row = emptySourceState();
        row.linkReason = ORIGIN_READ_FAILED_REASON;
        if (detail !== null) {
          row.lastAttemptAt = new Date(this.now()).toISOString();
          row.error = (`${failureKind}: ${detail.trim() || 'probe failed without a message'}`).slice(0, 300);
        }
        nextStates.set(name, row);
      };
      if (rootResolutionTimedOut || this.now() > resolveDeadline) {
        if (!resolveBudgetSpent) {
          this.log('warn', 'repo overview: origin-resolution budget spent — remaining repositories keep their prior state', {
            budgetMs: REPO_OVERVIEW_RESOLVE_BUDGET_MS,
            repos: repos.length,
          });
          resolveBudgetSpent = true;
        }
        rootResolutionTimedOut = true;
        unreadable(true);
        continue;
      }
      let selectedPath: ManagedRepoPath;
      try {
        const pendingPath = await resolveBeforeDeadline(
          () => this.resolveRepoPath(this.opts.workspaceRoot, name),
          Math.max(0, resolveDeadline - this.now()),
        );
        if (pendingPath === ROOT_RESOLUTION_TIMEOUT || this.now() > resolveDeadline) {
          attemptedResolutions += 1;
          rootResolutionTimedOut = true;
          resolveBudgetSpent = true;
          const detail = 'root validation exceeded the origin-resolution budget';
          this.log('warn', 'repo overview: root validation exceeded its deadline — retaining cached observation without provider polling', {
            repo: name,
            budgetMs: REPO_OVERVIEW_RESOLVE_BUDGET_MS,
          });
          unreadable(true, detail);
          continue;
        }
        selectedPath = pendingPath;
      } catch (error) {
        attemptedResolutions += 1;
        const detail = messageOf(error).slice(0, 300);
        this.log('warn', 'repo overview: root validation failed — retaining cached observation without provider polling', {
          repo: name,
          error: detail,
        });
        unreadable(true, detail);
        continue;
      }
      if (selectedPath.kind === 'error') {
        attemptedResolutions += 1;
        this.log('warn', 'repo overview: root validation failed — retaining cached observation without provider polling', {
          repo: name,
          error: selectedPath.error,
        });
        unreadable(true, selectedPath.error);
        continue;
      }
      if (selectedPath.kind === 'unavailable') {
        const unavailable = emptySourceState();
        unavailable.linkReason = selectedPath.reason;
        unavailable.lastAttemptAt = new Date(this.now()).toISOString();
        nextStates.set(name, unavailable);
        attemptedResolutions += 1;
        continue;
      }
      if (seenProjectPaths.has(selectedPath.path)) {
        duplicateNames.add(name);
        attemptedResolutions += 1;
        continue;
      }
      seenProjectPaths.add(selectedPath.path);
      let resolved: RepoRef | null;
      try {
        resolved = await this.resolveRemote(selectedPath.path);
        attemptedResolutions += 1;
      } catch (error) {
        attemptedResolutions += 1;
        const detail = messageOf(error).slice(0, 300);
        this.log('warn', 'repo overview: origin resolution failed — keeping the previous classification', {
          repo: name,
          error: detail,
        });
        unreadable(true, detail, 'origin resolution failed');
        continue;
      }
      const classification = classifyRemoteValue(resolved);
      if (classification.kind === 'unlinked') {
        if (base.ref !== null || base.linkReason !== classification.reason) {
          const reset = emptySourceState();
          reset.linkReason = classification.reason;
          nextStates.set(name, reset);
        } else {
          nextStates.set(name, base);
        }
      } else {
        const sameIdentity =
          base.ref !== null &&
          base.provider === classification.provider &&
          base.ref.host === classification.ref.host &&
          repoFullName(base.ref) === repoFullName(classification.ref);
        if (sameIdentity) {
          base.linkReason = null;
          nextStates.set(name, base);
        } else {
          const reset = emptySourceState();
          reset.ref = classification.ref;
          reset.provider = classification.provider;
          nextStates.set(name, reset);
        }
      }
    }
    const classificationResumeIndex = repos.length === 0
      ? 0
      : (classifyStart + attemptedResolutions) % repos.length;
    this.registry = repos.filter((name) => nextStates.has(name) && !duplicateNames.has(name));
    this.states.clear();
    for (const [name, state] of nextStates) this.states.set(name, state);
    // Classification and provider polling share the same start point; an
    // incomplete observation stays the highest-priority validated row.
    const order = [...repos.slice(classifyStart), ...repos.slice(0, classifyStart)];
    const fetchable = order.filter((name) => {
      const state = this.states.get(name);
      return state !== undefined && state.ref !== null && !unresolvedThisRefresh.has(name);
    });
    // Every registry row now has a classified identity (linked or an
    // explicit reason), so rows are renderable from here on — even if the
    // fetch phase below fails or is aborted. A refresh that never reached
    // classification keeps the section hidden (null), never a half-built
    // view.
    this.refreshedOnce = true;
    const budget = {
      used: 0,
      limit: this.maxCallsPerRefresh,
      deadlineMs: this.now() + REPO_OVERVIEW_FETCH_BUDGET_MS,
    };
    let nextIndex = 0;
    let stopIndex = fetchable.length;
    let discarded: string | null = null;
    let failures = 0;
    let stopped: 'budget' | 'deadline' | null = null;
    // Fatal auth/rate-limit conditions, per provider scope: an aborted
    // scope spends no further call this pass, and every other scope keeps
    // being observed.
    const abortedScopes = new Map<string, string>();
    const skipped: string[] = [];
    for (let index = 0; index < fetchable.length; index += 1) {
      const name = fetchable[index] as string;
      const scope = providerScopeOf(this.states.get(name) as RepoSourceState);
      if (abortedScopes.has(scope)) {
        skipped.push(name);
        continue;
      }
      if (budget.used >= budget.limit) {
        stopped = 'budget';
        nextIndex = index;
        stopIndex = index;
        break;
      }
      if (this.now() > budget.deadlineMs) {
        stopped = 'deadline';
        nextIndex = index;
        stopIndex = index;
        break;
      }
      const outcome = await this.observe(name, budget);
      if (outcome.retry) {
        // The partial observation is discarded, and its repository is
        // prioritized on the next pass (never silently skipped past): a
        // budget or wall-clock truncation must not starve the tail behind
        // a repeated prefix.
        stopped = outcome.detail !== null && outcome.detail.includes('wall-clock') ? 'deadline' : 'budget';
        discarded = name;
        nextIndex = index;
        stopIndex = index;
        break;
      }
      nextIndex = index + 1;
      if (outcome.aborted) {
        abortedScopes.set(scope, outcome.detail ?? 'provider condition');
        continue;
      }
      if (this.states.get(name)?.error !== null) failures += 1;
    }
    if (abortedScopes.size > 0) {
      // A scope-wide outage (auth/rate limit) aborted that scope: every
      // unattempted linked repository in it is disclosed as unchecked-for-
      // this-pass rather than silently keeping a fresh-looking age.
      for (const name of [...skipped, ...fetchable.slice(stopIndex)]) {
        const state = this.states.get(name);
        if (state === undefined || state.ref === null) continue;
        const abortDetail = abortedScopes.get(providerScopeOf(state));
        if (abortDetail === undefined) continue;
        state.lastAttemptAt = new Date(this.now()).toISOString();
        state.error = `refresh aborted before this repository was checked: ${abortDetail}`.slice(0, 300);
      }
    }
    if (discarded !== null) {
      if (this.priorityName === discarded) {
        // The prioritized retry could not complete either (a budget too
        // small to finish ANY observation): rotate on so every repository
        // still gets its turn instead of pinning the cursor forever.
        const discardedIndex = repos.indexOf(discarded);
        this.priorityName = null;
        this.cursor = repos.length <= 1 ? 0 : (discardedIndex + 1) % repos.length;
      } else {
        this.priorityName = discarded;
        this.cursor = Math.max(0, repos.indexOf(discarded));
      }
    } else {
      this.priorityName = null;
      const resumeName = fetchable[nextIndex] ?? null;
      this.cursor = resumeName === null
        ? classificationResumeIndex
        : Math.max(0, repos.indexOf(resumeName));
    }
    // An aborted scope's first skipped repository resumes the next pass, so
    // what this pass never checked goes first — unless the pass was
    // truncated, whose resume point (or discarded priority) stands.
    if (stopped === null && skipped.length > 0) this.cursor = Math.max(0, repos.indexOf(skipped[0] as string));
    if (abortedScopes.size > 0) {
      this.log('warn', 'repo overview refresh aborted (provider/rate-limit condition) — next cadence re-observes', {
        scopes: [...abortedScopes.keys()],
      });
    }
    if (stopped === 'budget') {
      this.log('warn', 'repo overview refresh: call budget exhausted — remaining repositories defer', {
        budget: this.maxCallsPerRefresh,
        calls: budget.used,
        repos: repos.length,
      });
    } else if (stopped === 'deadline') {
      this.log('warn', 'repo overview refresh: fetch wall-clock budget spent — remaining repositories defer', {
        budgetMs: REPO_OVERVIEW_FETCH_BUDGET_MS,
        calls: budget.used,
        repos: repos.length,
      });
    } else if (abortedScopes.size === 0 && failures > 0) {
      this.log('warn', 'repo overview refresh completed with repository failures', { repos: repos.length, failures });
    }
    return this.view();
  }

  /** Observe one repository atomically: every call must succeed for the
   * observation to count (Actions-permanently-unavailable is a state).
   * Attempt timestamps are written at COMPLETION only, so a view taken
   * while a fetch is in flight never claims the row failed or aged. The
   * fetch wall-clock budget is enforced per CALL, so one stalled
   * observation cannot run far past the pass bound.
   */
  private async observe(
    name: string,
    budget: { used: number; limit: number; deadlineMs: number },
  ): Promise<ObserveOutcome> {
    const state = this.states.get(name) as RepoSourceState;
    const ref = state.ref as RepoRef;
    try {
      const observation =
        state.provider === 'gitlab' ? await this.observeGitLab(ref, budget) : await this.observeGitHub(ref, budget);
      state.counts = observation.counts;
      state.run = observation.run;
      const completedAt = new Date(this.now()).toISOString();
      state.checkedAt = completedAt;
      state.lastAttemptAt = completedAt;
      state.error = null;
      if (observation.defaultBranchRuns !== null) this.reportDefaultBranchRuns(name, observation.defaultBranchRuns);
      return { aborted: false, retry: false, detail: null };
    } catch (error) {
      if (error instanceof GhBudgetExceededError) {
        // Not a failure: nothing was observed and nothing is recorded.
        return { aborted: true, retry: true, detail: error.message };
      }
      const kind = classifyGhError(error);
      state.lastAttemptAt = new Date(this.now()).toISOString();
      // A thrown error with an empty message must never become an empty
      // disclosure string (the web validator rejects it and drops the
      // whole board snapshot).
      state.error = (messageOf(error).trim() || 'observation failed without a message').slice(0, 300);
      this.log('warn', 'repo overview: repository observation failed', {
        repo: name,
        kind,
        error: state.error,
      });
      const fatal = kind === 'rate-limit' || kind === 'auth';
      return { aborted: fatal, retry: false, detail: fatal ? `${kind}: ${state.error}` : null };
    }
  }

  private async observeGitHub(
    ref: RepoRef,
    budget: { used: number; limit: number; deadlineMs: number },
  ): Promise<ProviderObservation> {
    let observed: DefaultBranchRunsObservation | null = null;
    const meta = await this.spend(budget, () => this.opts.api.fetchRepo({ repo: ref }));
    const openPrs = await this.spendSearch(budget, () => this.opts.api.countOpenPulls({ repo: ref }));
    const openIssues = await this.spendSearch(budget, () => this.opts.api.countOpenIssues({ repo: ref }));
    let run: RepoOverviewRunView;
    if (meta.defaultBranch === null) {
      // An empty repository has no default branch: the exact counts are
      // still real observations and the run context is honestly absent
      // instead of degrading the whole row into a fetch failure.
      run = absentRunView('no-branch', null);
    } else {
      const branch = meta.defaultBranch;
      const workflows = await this.spend(budget, () => this.opts.api.countWorkflows({ repo: ref }));
      if (workflows.kind === 'actions-unavailable') {
        run = absentRunView('unavailable', branch);
      } else if (workflows.value === 0) {
        run = absentRunView('no-workflow', branch);
      } else {
        const runs = await this.spend(budget, () =>
          this.opts.api.latestRuns({ repo: ref, branch, limit: REPO_OVERVIEW_RUNS_PER_FETCH }),
        );
        if (runs.kind === 'actions-unavailable') {
          run = absentRunView('unavailable', branch);
        } else {
          observed = { repo: ref, branch, runs: runs.value };
          // The chip shows the branch's own newest run; the hook gets the full page.
          const latest = selectLatestRun(runs.value.filter(isDefaultBranchRun));
          run = latest === null ? absentRunView('never-run', branch) : runViewOf(latest, ref.host, branch);
        }
      }
    }
    return { counts: { openPrs, openIssues }, run, defaultBranchRuns: observed };
  }

  /** The GitLab observation: project, open MR and issue counts, then the
   * newest default-branch pipeline. Pipelines never feed the #446 alert;
   * `no-workflow` is never claimed (a missing CI config is not cheaply
   * provable), so an empty pipeline page reads `never-run`. */
  private async observeGitLab(
    ref: RepoRef,
    budget: { used: number; limit: number; deadlineMs: number },
  ): Promise<ProviderObservation> {
    const api = this.opts.gitlabApi;
    if (api === undefined) {
      throw new RepoProviderError(
        'other',
        `GitLab overview adapter is not wired — ${repoFullName(ref)} on ${ref.host} cannot be observed`,
      );
    }
    const project = await this.spend(budget, () => api.fetchProject({ repo: ref }));
    const openPrs = await this.spend(budget, () => api.countOpenMergeRequests({ repo: ref }));
    const openIssues = await this.spend(budget, () => api.countOpenIssues({ repo: ref }));
    let run: RepoOverviewRunView;
    if (project.defaultBranch === null) {
      run = absentRunView('no-branch', null);
    } else if (!project.ciEnabled) {
      run = absentRunView('unavailable', project.defaultBranch);
    } else {
      const branch = project.defaultBranch;
      const pipelines = await this.spend(budget, () =>
        api.latestPipelines({ repo: ref, branch, limit: REPO_OVERVIEW_RUNS_PER_FETCH }),
      );
      const latest = selectLatestRun(pipelines.filter((pipeline) => isDefaultBranchPipeline(pipeline, branch)));
      run = latest === null ? absentRunView('never-run', branch) : gitLabRunViewOf(latest, ref.host, branch);
    }
    return { counts: { openPrs, openIssues }, run, defaultBranchRuns: null };
  }

  /** Hand a committed observation's run page to the default-branch CI
   * alert. The row is already recorded: a hook failure is logged loud and
   * never reaches the observation's own failure path. */
  private reportDefaultBranchRuns(name: string, observed: DefaultBranchRunsObservation): void {
    if (this.opts.onDefaultBranchRuns === undefined) return;
    try {
      this.opts.onDefaultBranchRuns(observed);
    } catch (error) {
      this.log('error', 'repo overview: default-branch CI watch failed — the row is unaffected', {
        repo: name,
        error: messageOf(error).slice(0, 300),
      });
    }
  }

  /** The ONE pre-call bounds guard shared by search and non-search calls:
   * call-count limit first, then the fetch wall-clock deadline. Throwing
   * before the caller consumes a budget unit keeps `used` an exact record
   * of provider calls issued. */
  private assertSpendable(budget: { used: number; limit: number; deadlineMs?: number }): void {
    if (budget.used >= budget.limit) {
      throw new GhBudgetExceededError('repo overview call budget exceeded');
    }
    if (budget.deadlineMs !== undefined && this.now() > budget.deadlineMs) {
      throw new GhBudgetExceededError('repo overview fetch wall-clock budget exceeded');
    }
  }

  /** Spend one Search call, paced to GitHub's sustained search quota (a
   * self-inflicted 403 would abort the pass mid-registry). The wait is
   * clamped to one interval so a backward clock step can never turn
   * pacing into an unbounded sleep; both bounds are checked BEFORE and
   * AFTER the wait, and the call/unit are only consumed once the call is
   * actually issued. */
  private async spendSearch<T>(
    budget: { used: number; limit: number; deadlineMs?: number },
    work: () => Promise<T>,
  ): Promise<T> {
    this.assertSpendable(budget);
    if (this.lastSearchAtMs !== null) {
      const elapsed = this.now() - this.lastSearchAtMs;
      if (elapsed < REPO_OVERVIEW_SEARCH_MIN_INTERVAL_MS) {
        await this.sleep(
          REPO_OVERVIEW_SEARCH_MIN_INTERVAL_MS - Math.max(0, Math.min(elapsed, REPO_OVERVIEW_SEARCH_MIN_INTERVAL_MS)),
        );
      }
    }
    this.assertSpendable(budget);
    budget.used += 1;
    this.lastSearchAtMs = this.now();
    return work();
  }

  private async spend<T>(
    budget: { used: number; limit: number; deadlineMs?: number },
    work: () => Promise<T>,
  ): Promise<T> {
    this.assertSpendable(budget);
    budget.used += 1;
    return work();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
