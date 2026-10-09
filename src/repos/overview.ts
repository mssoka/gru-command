import { execFile } from 'node:child_process';
import { join } from 'node:path';
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
import { isGitHubRemote, parseRepoRemote } from '../dispatch/review-path.js';
import { discoverManagedReposAsync } from './discovery.js';

/**
 * Managed repository overview (owner-approved compact rows A): a
 * read-only projection of the configured managed-repo registry — each
 * repository's identity/link, repo-wide open PR and open-issue counts
 * (issues excluding PRs) and the newest Actions run on its discovered
 * default branch, with honest freshness.
 *
 * The registry is the configured workspace root plus the SAME depth-1
 * `.git` discovery rule the setup wizard uses (`src/repos/discovery.ts`)
 * — no hard-coded names, no arbitrary scans. Every row is derived from a
 * repository that actually exists there; a missing/non-GitHub/malformed
 * origin remote stays honestly not-linked and spends no GitHub call.
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
 * The newest default-branch run is selected by (createdAt, id), so a
 * newer queued/running run supersedes an older passed one. `no-workflow`
 * requires the workflows endpoint to prove the repo has none — an empty
 * run page alone never infers it; with workflows present but no run on
 * the branch the state is `never-run`.
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
  /** The GitHub host the identity was read from (null when not linked) —
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
  /** Last failed attempt detail (provider text, bounded); null when clean. */
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
/** `gh` calls allowed per refresh (≈20 repos at ≤5 calls). */
export const REPO_OVERVIEW_MAX_CALLS_PER_REFRESH = 100;
/** Runs read per repository so the newest is selectable robustly. */
export const REPO_OVERVIEW_RUNS_PER_FETCH = 3;
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

/** Newest run wins: max by the ACTUAL CREATION time (createdAt), then id.
 * A run without a parseable creation time only wins over another
 * unparseable one with a larger id — provider list order is never trusted
 * alone, and a delayed `run_started_at` can never promote an older run
 * over a newer queued one. */
export function selectLatestRun(
  runs: readonly RepoOverviewRunRaw[],
): RepoOverviewRunRaw | null {
  let best: RepoOverviewRunRaw | null = null;
  for (const run of runs) {
    if (best === null) {
      best = run;
      continue;
    }
    const runMs = Date.parse(run.createdAt ?? '');
    const bestMs = Date.parse(best.createdAt ?? '');
    const runTime = Number.isFinite(runMs) ? runMs : null;
    const bestTime = Number.isFinite(bestMs) ? bestMs : null;
    if (runTime !== null && bestTime !== null) {
      if (runTime > bestTime || (runTime === bestTime && (run.id ?? 0) > (best.id ?? 0))) best = run;
    } else if (runTime !== null && bestTime === null) {
      best = run;
    } else if (runTime === null && bestTime === null && (run.id ?? 0) > (best.id ?? 0)) {
      best = run;
    }
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
 * included) are escaped even beside visible text, so a name can never
 * spoof its display; combining marks are escaped only when nothing else
 * is visible (they are legitimate in many scripts). */
const VISIBLE_CHARACTER = /[^\p{Cf}\p{Cc}\p{M}\s]/u;
const CONTROL_OR_FORMAT = /[\p{Cf}\p{Cc}]/u;

export function safeDisplayName(name: string): string {
  const escape = (char: string): string => `\\u{${char.codePointAt(0)?.toString(16) ?? '?'}}`;
  if (VISIBLE_CHARACTER.test(name)) {
    return [...name].map((char) => (CONTROL_OR_FORMAT.test(char) ? escape(char) : char)).join('');
  }
  const escaped = [...name]
    .map((char) => (VISIBLE_CHARACTER.test(char) ? char : escape(char)))
    .join('');
  return escaped === '' ? 'unnamed repository' : escaped;
}

/** Build the https repository link from a parsed remote, or null when the
 * host/segments cannot form a safe link (not-linked, never guessed). */
export function githubRepoLink(ref: RepoRef): string | null {
  if (!isGitHubRemote(ref.host)) return null;
  if (!SAFE_HOST.test(ref.host) || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(ref.host)) return null;
  // No empty label, anywhere: `foo..github` must stay unlinked.
  if (ref.host.includes('..')) return null;
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

/** Classify a failed observation. `rate-limit` and `auth` are global
 * conditions: the refresh aborts instead of hammering every repository. A
 * structured `GhApiError` without a cause is an adapter/shape failure —
 * per-repository, never global. */
export function classifyGhError(error: unknown): RepoFetchErrorKind {
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

function runUnavailableView(branch: string | null): RepoOverviewRunView {
  return {
    state: 'unavailable',
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
// Remote classification
// ------------------------------------------------------------------

export type RemoteClassification =
  | { readonly kind: 'linked'; readonly ref: RepoRef }
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
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 },
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
  if (!isGitHubRemote(ref.host)) return { kind: 'unlinked', reason: 'non-GitHub remote' };
  if (githubRepoLink(ref) === null) return { kind: 'unlinked', reason: 'unrecognized remote' };
  return { kind: 'linked', ref };
}

export function classifyRemote(repoPath: string, resolveRemote: (path: string) => RepoRef | null): RemoteClassification {
  return classifyRemoteValue(resolveRemote(repoPath));
}

// ------------------------------------------------------------------
// Tracker
// ------------------------------------------------------------------

interface RepoSourceState {
  ref: RepoRef | null;
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
    linkReason: null,
    counts: null,
    run: null,
    checkedAt: null,
    lastAttemptAt: null,
    error: null,
  };
}

export interface ManagedRepoOverviewOptions {
  /** Configured workspace root holding the managed repositories. */
  readonly workspaceRoot: string;
  readonly api: RepoOverviewApiPort;
  /** Test seams; default: canonical discovery + origin-remote resolver.
   * Both may be async; the tracker awaits them. */
  readonly scanRepos?: (workspaceRoot: string) => readonly string[] | Promise<readonly string[]>;
  readonly resolveRemote?: RemoteResolver;
  /** Refresh cadence; default {@link REPO_OVERVIEW_REFRESH_MS}. */
  readonly intervalMs?: number;
  /** Freshness window; default {@link REPO_OVERVIEW_STALE_AFTER_MS}. */
  readonly staleAfterMs?: number;
  /** `gh` calls per refresh; default {@link REPO_OVERVIEW_MAX_CALLS_PER_REFRESH}. */
  readonly maxCallsPerRefresh?: number;
  /** Sleep seam for search pacing; default a real timer (tests advance a
   * fake clock instead of waiting). */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly log?: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;
}

interface ObserveOutcome {
  /** Fatal global condition (rate limit/auth) — stop the refresh. */
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

export class ManagedRepoOverviewTracker {
  private readonly opts: ManagedRepoOverviewOptions;
  private readonly scanRepos: (workspaceRoot: string) => readonly string[] | Promise<readonly string[]>;
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
  private classifyCursor = 0;
  private lastSearchAtMs: number | null = null;
  private refreshedOnce = false;
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<RepoOverviewView | null> | null = null;

  constructor(opts: ManagedRepoOverviewOptions) {
    this.opts = opts;
    this.scanRepos = opts.scanRepos ?? (() => discoverManagedReposAsync(opts.workspaceRoot));
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
        host: state.ref !== null ? state.ref.host : null,
        link: state.ref !== null ? githubRepoLink(state.ref) : null,
        linkReason: state.ref !== null ? null : state.linkReason,
        fullName: state.ref !== null ? repoFullName(state.ref) : null,
        openPrs: state.counts?.openPrs ?? null,
        openIssues: state.counts?.openIssues ?? null,
        run: state.run,
        freshness,
        checkedAt: state.checkedAt,
        lastAttemptAt: state.lastAttemptAt,
        error: state.error,
      } satisfies RepoOverviewRowView;
    });
    return { rows };
  }

  /** Re-scan the registry and observe GitHub state (coalesced). */
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
    // Classification is built into a LOCAL map and published only once
    // every remote has been resolved: `view()` (called by board pushes and
    // heartbeats DURING this refresh) must never observe a half-classified
    // entry as `linked:false` without a reason. A changed identity (or a
    // remote that stopped being a safe GitHub link) drops the old
    // repository's cached observation — stale data must never attach to a
    // different identity. A resolver ERROR keeps the previous
    // classification and cached observation (a transient git failure is
    // not evidence the remote changed).
    const nextStates = new Map<string, RepoSourceState>();
    const resolveDeadline = this.now() + REPO_OVERVIEW_RESOLVE_BUDGET_MS;
    let resolveBudgetSpent = false;
    // Classification rotates with its own cursor: when the budget cuts a
    // pass short, the NEXT pass starts where this one stopped, so a slow
    // mount can never starve the tail of the registry forever.
    const classifyStart = repos.length === 0 ? 0 : this.classifyCursor % repos.length;
    const classifyOrder = [...repos.slice(classifyStart), ...repos.slice(0, classifyStart)];
    // Advances by ATTEMPTED resolutions (successes AND failures), so a
    // prefix of slow-failing origins also rotates away and can never pin
    // the cursor to the same index every pass.
    let attemptedResolutions = 0;
    for (const name of classifyOrder) {
      const previous = this.states.get(name);
      const base = previous ?? emptySourceState();
      const unreadable = (): void => {
        // A read failure (or the resolution budget) is not evidence the
        // remote changed: keep the previous classification and cached
        // observation when one exists. A never-classified entry is still
        // PUBLISHED with the explicit read-failure reason — every managed
        // repo appears, and the row never claims a guessed identity.
        if (previous !== undefined) {
          nextStates.set(name, previous);
          return;
        }
        const row = emptySourceState();
        row.linkReason = ORIGIN_READ_FAILED_REASON;
        nextStates.set(name, row);
      };
      if (this.now() > resolveDeadline) {
        if (!resolveBudgetSpent) {
          this.log('warn', 'repo overview: origin-resolution budget spent — remaining repositories keep their prior state', {
            budgetMs: REPO_OVERVIEW_RESOLVE_BUDGET_MS,
            repos: repos.length,
          });
          resolveBudgetSpent = true;
        }
        unreadable();
        continue;
      }
      let resolved: RepoRef | null;
      try {
        resolved = await this.resolveRemote(join(this.opts.workspaceRoot, name));
        attemptedResolutions += 1;
      } catch (error) {
        attemptedResolutions += 1;
        this.log('warn', 'repo overview: origin resolution failed — keeping the previous classification', {
          repo: name,
          error: messageOf(error).slice(0, 300),
        });
        unreadable();
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
          base.ref.host === classification.ref.host &&
          repoFullName(base.ref) === repoFullName(classification.ref);
        if (sameIdentity) {
          base.linkReason = null;
          nextStates.set(name, base);
        } else {
          const reset = emptySourceState();
          reset.ref = classification.ref;
          nextStates.set(name, reset);
        }
      }
    }
    this.classifyCursor = repos.length === 0 ? 0 : (classifyStart + attemptedResolutions) % repos.length;
    this.registry = repos.filter((name) => nextStates.has(name));
    this.states.clear();
    for (const [name, state] of nextStates) this.states.set(name, state);
    // Resume at the discarded repository when one is pending (and still
    // linked); otherwise use the rotation cursor.
    const priorityIndex = this.priorityName !== null ? repos.indexOf(this.priorityName) : -1;
    const priorityLinked =
      priorityIndex >= 0 && this.states.get(this.priorityName as string)?.ref != null;
    const start =
      repos.length === 0 ? 0 : priorityLinked ? priorityIndex : this.cursor % repos.length;
    const order = [...repos.slice(start), ...repos.slice(0, start)];
    const fetchable = order.filter((name) => {
      const state = this.states.get(name);
      return state !== undefined && state.ref !== null;
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
    let discarded: string | null = null;
    let failures = 0;
    let aborted: string | null = null;
    let abortDetail: string | null = null;
    for (let index = 0; index < fetchable.length; index += 1) {
      if (budget.used >= budget.limit) {
        aborted = 'budget';
        nextIndex = index;
        break;
      }
      if (this.now() > budget.deadlineMs) {
        aborted = 'deadline';
        nextIndex = index;
        break;
      }
      const outcome = await this.observe(fetchable[index] as string, budget);
      if (outcome.retry) {
        // The partial observation is discarded, and its repository is
        // prioritized on the next pass (never silently skipped past): a
        // budget or wall-clock truncation must not starve the tail behind
        // a repeated prefix.
        aborted = outcome.detail !== null && outcome.detail.includes('wall-clock') ? 'deadline' : 'budget';
        discarded = fetchable[index] as string;
        nextIndex = index;
        break;
      }
      nextIndex = index + 1;
      if (outcome.aborted) {
        aborted = 'fatal';
        abortDetail = outcome.detail;
        break;
      }
      if (this.states.get(fetchable[index] as string)?.error !== null) failures += 1;
    }
    if (aborted === 'fatal' && abortDetail !== null) {
      // A global outage (auth/rate limit) aborted the pass: every
      // unattempted linked repository is disclosed as unchecked-for-this-
      // pass rather than silently keeping a fresh-looking age.
      const rest = fetchable.slice(nextIndex);
      for (const name of rest) {
        const state = this.states.get(name);
        if (state === undefined || state.ref === null) continue;
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
      this.cursor = resumeName === null ? 0 : Math.max(0, repos.indexOf(resumeName));
    }
    if (aborted === 'budget') {
      this.log('warn', 'repo overview refresh: call budget exhausted — remaining repositories defer', {
        budget: this.maxCallsPerRefresh,
        calls: budget.used,
        repos: repos.length,
      });
    } else if (aborted === 'deadline') {
      this.log('warn', 'repo overview refresh: fetch wall-clock budget spent — remaining repositories defer', {
        budgetMs: REPO_OVERVIEW_FETCH_BUDGET_MS,
        calls: budget.used,
        repos: repos.length,
      });
    } else if (aborted === 'fatal') {
      this.log('warn', 'repo overview refresh aborted (provider/rate-limit condition) — next cadence re-observes', {});
    } else if (failures > 0) {
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
      const meta = await this.spend(budget, () => this.opts.api.fetchRepo({ repo: ref }));
      const openPrs = await this.spendSearch(budget, () => this.opts.api.countOpenPulls({ repo: ref }));
      const openIssues = await this.spendSearch(budget, () => this.opts.api.countOpenIssues({ repo: ref }));
      let run: RepoOverviewRunView;
      if (meta.defaultBranch === null) {
        // An empty repository has no default branch: the exact counts are
        // still real observations and the run context is honestly absent
        // instead of degrading the whole row into a fetch failure.
        run = {
          state: 'no-branch',
          status: null,
          conclusion: null,
          workflow: null,
          branch: null,
          runNumber: null,
          url: null,
          runCreatedAt: null,
          runStartedAt: null,
          runUpdatedAt: null,
        };
      } else {
        const branch = meta.defaultBranch;
        const workflows = await this.spend(budget, () => this.opts.api.countWorkflows({ repo: ref }));
        if (workflows.kind === 'actions-unavailable') {
          run = runUnavailableView(branch);
        } else if (workflows.value === 0) {
          run = {
            state: 'no-workflow',
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
        } else {
          const runs = await this.spend(budget, () =>
            this.opts.api.latestRuns({ repo: ref, branch, limit: REPO_OVERVIEW_RUNS_PER_FETCH }),
          );
          if (runs.kind === 'actions-unavailable') {
            run = runUnavailableView(branch);
          } else {
            const latest = selectLatestRun(runs.value);
            run =
              latest === null
                ? {
                    state: 'never-run',
                    status: null,
                    conclusion: null,
                    workflow: null,
                    branch,
                    runNumber: null,
                    url: null,
                    runCreatedAt: null,
                    runStartedAt: null,
                    runUpdatedAt: null,
                  }
                : runViewOf(latest, ref.host, branch);
          }
        }
      }
      state.counts = { openPrs, openIssues };
      state.run = run;
      const completedAt = new Date(this.now()).toISOString();
      state.checkedAt = completedAt;
      state.lastAttemptAt = completedAt;
      state.error = null;
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
