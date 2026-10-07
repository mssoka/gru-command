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
import { discoverManagedRepos } from './discovery.js';

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
 * refreshes share one run. Rate-limit/auth failures abort the refresh;
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

export type RepoOverviewRunState =
  | 'passed'
  | 'failed'
  | 'timed-out'
  | 'startup-failure'
  | 'action-required'
  | 'cancelled'
  | 'skipped'
  | 'neutral'
  | 'stale-run'
  | 'running'
  | 'queued'
  | 'no-workflow'
  | 'never-run'
  | 'unavailable'
  | 'unknown';

/** Row freshness: `unchecked` (never attempted), `fresh` (last successful
 * fetch inside the freshness window and no failed re-attempt after it),
 * `stale` (cached data kept past a failed re-attempt or beyond the
 * window), `unavailable` (attempted, no successful data yet). */
export type RepoOverviewFreshness = 'unchecked' | 'fresh' | 'stale' | 'unavailable';

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
  readonly runStartedAt: string | null;
  readonly runUpdatedAt: string | null;
}

export interface RepoOverviewRowView {
  /** Stable identity: the registry directory name. */
  readonly key: string;
  readonly displayName: string;
  readonly linked: boolean;
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
  /** Start of the last GitHub observation attempt (ISO). */
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

// ------------------------------------------------------------------
// Outbound port + raw shapes
// ------------------------------------------------------------------

export interface RepoOverviewMeta {
  /** The repository's actual default branch (discovered, never assumed). */
  readonly defaultBranch: string;
}

export interface RepoOverviewRunRaw {
  readonly id: number | null;
  readonly name: string | null;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly url: string | null;
  readonly runNumber: number | null;
  readonly createdAt: string | null;
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

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

/** Newest run wins: max by (createdAt, id). A run without a parseable
 * createdAt only wins over another unparseable one with a larger id — the
 * provider list order is never trusted alone. */
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

/** Build the https repository link from a parsed remote, or null when the
 * host/segments cannot form a safe link (not-linked, never guessed). */
export function githubRepoLink(ref: RepoRef): string | null {
  if (!isGitHubRemote(ref.host)) return null;
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
    runStartedAt: raw.createdAt,
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
    id: numOrNull(raw['id']),
    name: strOrNull(raw['name']),
    status: strOrNull(raw['status']),
    conclusion: strOrNull(raw['conclusion']),
    url: strOrNull(raw['html_url']),
    runNumber: countOrNull(raw['run_number']),
    createdAt: isoOrNull(raw['run_started_at']) ?? isoOrNull(raw['created_at']),
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
    const defaultBranch = raw !== null ? strOrNull(raw['default_branch']) : null;
    if (defaultBranch === null) {
      throw new GhApiError(`${label}: response carries no default_branch`);
    }
    return { defaultBranch };
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
    if (raw?.['incomplete_results'] === true) {
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
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', repoPath, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          resolve(null);
          return;
        }
        const url = stdout.trim();
        resolve(url === '' ? null : url);
      },
    );
  });
}

/** Default resolver: the repo's origin remote parsed by the same seam the
 * tracked-lane poll uses. Missing/unparseable → null. */
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
  /** Test seams; default: canonical discovery + origin-remote resolver. */
  readonly scanRepos?: (workspaceRoot: string) => readonly string[];
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
  /** Budget ran out before a complete observation — nothing was recorded
   * and rotation advances past this repository so no single entry can
   * starve the rest of the registry. */
  readonly retry: boolean;
}

export class ManagedRepoOverviewTracker {
  private readonly opts: ManagedRepoOverviewOptions;
  private readonly scanRepos: (workspaceRoot: string) => readonly string[];
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
  private lastSearchAtMs = 0;
  private refreshedOnce = false;
  private started = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<RepoOverviewView | null> | null = null;

  constructor(opts: ManagedRepoOverviewOptions) {
    this.opts = opts;
    this.scanRepos = opts.scanRepos ?? (() => discoverManagedRepos(opts.workspaceRoot));
    this.resolveRemote = opts.resolveRemote ?? defaultRemoteResolver;
    this.intervalMs = opts.intervalMs ?? REPO_OVERVIEW_REFRESH_MS;
    this.staleAfterMs = opts.staleAfterMs ?? Math.max(1, this.intervalMs * 3);
    this.maxCallsPerRefresh = opts.maxCallsPerRefresh ?? REPO_OVERVIEW_MAX_CALLS_PER_REFRESH;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.registry = [...this.scanRepos(this.opts.workspaceRoot)];
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

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
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
        displayName: name,
        linked,
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
    const repos = [...new Set(this.scanRepos(this.opts.workspaceRoot))].sort();
    this.registry = repos;
    const present = new Set(repos);
    for (const name of [...this.states.keys()]) {
      if (!present.has(name)) this.states.delete(name);
    }
    for (const name of repos) {
      if (!this.states.has(name)) this.states.set(name, emptySourceState());
    }
    // Classify every repository's remote locally BEFORE any GitHub call:
    // a row is never mislabeled not-linked just because its fetch has not
    // been reached yet this cycle. A changed identity (or a remote that
    // stopped being a safe GitHub link) drops the old repository's cached
    // observation — stale data must never attach to a different identity.
    for (const name of repos) {
      const state = this.states.get(name) as RepoSourceState;
      const resolved = await this.resolveRemote(join(this.opts.workspaceRoot, name));
      const classification = classifyRemoteValue(resolved);
      if (classification.kind === 'unlinked') {
        if (state.ref !== null || state.linkReason !== classification.reason) {
          const reset = emptySourceState();
          reset.linkReason = classification.reason;
          this.states.set(name, reset);
        }
      } else {
        const sameIdentity =
          state.ref !== null &&
          state.ref.host === classification.ref.host &&
          repoFullName(state.ref) === repoFullName(classification.ref);
        if (!sameIdentity) {
          const reset = emptySourceState();
          reset.ref = classification.ref;
          this.states.set(name, reset);
        } else {
          state.linkReason = null;
        }
      }
    }
    const start = repos.length === 0 ? 0 : this.cursor % repos.length;
    const order = [...repos.slice(start), ...repos.slice(0, start)];
    const fetchable = order.filter((name) => this.states.get(name)?.ref !== null);
    // Every registry row now has a classified identity (linked or an
    // explicit reason), so rows are renderable from here on — even if the
    // fetch phase below fails or is aborted. A refresh that never reached
    // classification keeps the section hidden (null), never a half-built
    // view.
    this.refreshedOnce = true;
    const budget = { used: 0, limit: this.maxCallsPerRefresh };
    let nextIndex = 0;
    let failures = 0;
    let aborted: string | null = null;
    for (let index = 0; index < fetchable.length; index += 1) {
      if (budget.used >= budget.limit) {
        aborted = 'budget';
        nextIndex = index;
        break;
      }
      const outcome = await this.observe(fetchable[index] as string, budget);
      if (outcome.retry) {
        // A partial observation is discarded and rotation moves on: a
        // budget smaller than one observation must degrade fairly across
        // the registry, never re-spend every cycle on the same entry.
        nextIndex = index + 1;
        break;
      }
      nextIndex = index + 1;
      if (outcome.aborted) {
        aborted = 'fatal';
        break;
      }
      if (this.states.get(fetchable[index] as string)?.error !== null) failures += 1;
    }
    const resumeName = fetchable[nextIndex] ?? null;
    this.cursor = resumeName === null ? 0 : Math.max(0, repos.indexOf(resumeName));
    if (aborted === 'budget') {
      this.log('warn', 'repo overview refresh: call budget exhausted — remaining repositories defer', {
        budget: this.maxCallsPerRefresh,
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
   * while a fetch is in flight never claims the row failed or aged.
   */
  private async observe(name: string, budget: { used: number; limit: number }): Promise<ObserveOutcome> {
    const state = this.states.get(name) as RepoSourceState;
    const ref = state.ref as RepoRef;
    try {
      const meta = await this.spend(budget, () => this.opts.api.fetchRepo({ repo: ref }));
      const openPrs = await this.spendSearch(budget, () => this.opts.api.countOpenPulls({ repo: ref }));
      const openIssues = await this.spendSearch(budget, () => this.opts.api.countOpenIssues({ repo: ref }));
      const workflows = await this.spend(budget, () => this.opts.api.countWorkflows({ repo: ref }));
      let run: RepoOverviewRunView;
      if (workflows.kind === 'actions-unavailable') {
        run = runUnavailableView(meta.defaultBranch);
      } else if (workflows.value === 0) {
        run = {
          state: 'no-workflow',
          status: null,
          conclusion: null,
          workflow: null,
          branch: meta.defaultBranch,
          runNumber: null,
          url: null,
          runStartedAt: null,
          runUpdatedAt: null,
        };
      } else {
        const runs = await this.spend(budget, () =>
          this.opts.api.latestRuns({ repo: ref, branch: meta.defaultBranch, limit: REPO_OVERVIEW_RUNS_PER_FETCH }),
        );
        if (runs.kind === 'actions-unavailable') {
          run = runUnavailableView(meta.defaultBranch);
        } else {
          const latest = selectLatestRun(runs.value);
          run =
            latest === null
              ? {
                  state: 'never-run',
                  status: null,
                  conclusion: null,
                  workflow: null,
                  branch: meta.defaultBranch,
                  runNumber: null,
                  url: null,
                  runStartedAt: null,
                  runUpdatedAt: null,
                }
              : runViewOf(latest, ref.host, meta.defaultBranch);
        }
      }
      state.counts = { openPrs, openIssues };
      state.run = run;
      const completedAt = new Date(this.now()).toISOString();
      state.checkedAt = completedAt;
      state.lastAttemptAt = completedAt;
      state.error = null;
      return { aborted: false, retry: false };
    } catch (error) {
      if (error instanceof GhBudgetExceededError) {
        // Not a failure: nothing was observed and nothing is recorded.
        return { aborted: true, retry: true };
      }
      const kind = classifyGhError(error);
      state.lastAttemptAt = new Date(this.now()).toISOString();
      state.error = messageOf(error).slice(0, 300);
      this.log('warn', 'repo overview: repository observation failed', {
        repo: name,
        kind,
        error: state.error,
      });
      return { aborted: kind === 'rate-limit' || kind === 'auth', retry: false };
    }
  }

  /** Spend one Search call, paced to GitHub's sustained search quota (a
   * self-inflicted 403 would abort the pass mid-registry). */
  private async spendSearch<T>(
    budget: { used: number; limit: number },
    work: () => Promise<T>,
  ): Promise<T> {
    return this.spend(budget, async () => {
      const nowMs = this.now();
      if (this.lastSearchAtMs > 0 && nowMs - this.lastSearchAtMs < REPO_OVERVIEW_SEARCH_MIN_INTERVAL_MS) {
        await this.sleep(REPO_OVERVIEW_SEARCH_MIN_INTERVAL_MS - (nowMs - this.lastSearchAtMs));
      }
      this.lastSearchAtMs = this.now();
      return work();
    });
  }

  private async spend<T>(
    budget: { used: number; limit: number },
    work: () => Promise<T>,
  ): Promise<T> {
    if (budget.used >= budget.limit) {
      throw new GhBudgetExceededError('repo overview call budget exceeded');
    }
    budget.used += 1;
    return work();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
