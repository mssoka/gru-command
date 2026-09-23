import { spawn } from 'node:child_process';
import type { LogLevel } from '../logger.js';
import type {
  EventRecord,
  JobRecord,
  NotificationRouting,
  NotificationSeverity,
  WorktreeRecord,
} from '../ledger/api.js';
import { isGitHubRemote } from './review-path.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * GitHub signal ingestion, POLL-ONLY (owner ruling 2026-09-23; the
 * webhook route is descoped — no tunnel, see README).
 *
 * The Silas watchtower gains a fast `gh`-based poll beside the slow sweep:
 * once per tick it reads the state of every tracked branch through
 * authenticated `gh api` — merged state and mergeable_state from
 * `repos/{owner}/{repo}/pulls`, latest check-run conclusions from
 * `repos/{owner}/{repo}/commits/{sha}/check-runs` — and mechanically applies
 * the state-change mappings:
 *
 *   PR merged            -> job in-review -> merged transition + `github.pr-merged`
 *   PR conflicting       -> `github.pr-conflict` + action-required cascade
 *                           notification (mechanical tier: Silas may arm a
 *                           rebase lane within his existing mandate)
 *   CI failed (tracked)  -> `github.ci-failed` + notification with the run URL,
 *                           routed by check kind (mechanical -> fyi, Silas may
 *                           act; judgment -> action-required, wake-eligible)
 *   CI green             -> `github.ci-green` review-gate signal event
 *
 * DEDUPE IS BY OBSERVED STATE-CHANGE, NEVER BY RE-APPLICATION: every tick
 * normalizes the observation into a `NormalizedBranchState`, diffs it against
 * the last `github.branch-state` event recorded for the job, and applies only
 * the transitions. A tick whose observation equals the recorded state writes
 * nothing — no event, no notification, no second transition. A restart
 * re-reads the same ledger events, so dedupe survives process restarts.
 *
 * The tier ladder is UNCHANGED (no new autonomy): mechanical bookkeeping and
 * notifications are tier 0/1 acts inside the existing mandate; judgment
 * observations surface as wake-eligible action-required notifications and
 * never auto-act.
 *
 * Rate-limit headroom: every API call goes through a per-tick budget
 * (`GITHUB_POLL_MAX_CALLS_PER_TICK`, default 50). At the default 60 s poll
 * that is at most 3 000 REST calls/hour against the authenticated 5 000/hour
 * GitHub budget — 40 % headroom for reviews, PR registration, and branch
 * operations. A rate-limit response from `gh` aborts the rest of the tick
 * instead of hammering the API; the next tick retries.
 */

/** Default `gh` calls allowed per poll tick (see module headroom note). */
export const GITHUB_POLL_MAX_CALLS_PER_TICK = 50;

/** PRs read per repo per tick — the merge-detection window. A merged tracked
 * PR is always among the most recently UPDATED PRs when it merges; a PR
 * carried in the registry by number is additionally fetched directly if the
 * window misses it. */
export const GITHUB_POLL_MAX_PULLS_PER_REPO = 100;

// ------------------------------------------------------------------
// Repo + raw GitHub shapes
// ------------------------------------------------------------------

export interface RepoRef {
  readonly host: string;
  readonly owner: string;
  readonly repo: string;
}

export function repoFullName(repo: RepoRef): string {
  return `${repo.owner}/${repo.repo}`;
}

/** Parse an https GitHub pull-request URL into its coordinates. */
export function parseGitHubPrUrl(url: string): { host: string; owner: string; repo: string; number: number } | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    return null;
  }
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/u.exec(parsed.pathname);
  if (match === null || !isGitHubRemote(parsed.host)) return null;
  return { host: parsed.host, owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

/** One pull request as the poll consumes it (list or detail endpoint). */
export interface GhPull {
  readonly number: number;
  readonly headRef: string;
  readonly headSha: string | null;
  readonly state: string;
  readonly merged: boolean;
  readonly mergeableState: string | null;
  readonly mergeCommitSha: string | null;
  readonly url: string | null;
}

/** One check run as the poll consumes it. */
export interface GhCheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string | null;
}

/** The outbound GitHub port (real implementation: {@link GhCliApi}). */
export interface GhApiPort {
  listPulls(input: { readonly repo: RepoRef; readonly limit: number }): Promise<readonly GhPull[]>;
  getPull(input: { readonly repo: RepoRef; readonly number: number }): Promise<GhPull>;
  listCheckRuns(input: { readonly repo: RepoRef; readonly sha: string }): Promise<readonly GhCheckRun[]>;
}

// ------------------------------------------------------------------
// Normalized branch state (the dedupe cursor) + pure mapping
// ------------------------------------------------------------------

export type CiStatus = 'pending' | 'failed' | 'green';
/** Mechanical failures are tier 0/1 (fixable within the lane mandate);
 * judgment failures are tier 2 and surface wake-eligible. */
export type CiFailureTier = 'mechanical' | 'judgment';

export interface CiFailure {
  readonly name: string;
  readonly conclusion: string;
  readonly url: string | null;
}

export interface CiState {
  readonly sha: string;
  readonly status: CiStatus;
  /** Stable identity of the FAILING set (sorted names) — extending the set
   * is a state change; a flaky re-run of the same checks is not. */
  readonly signature: string;
  readonly failures: readonly CiFailure[];
  readonly checks: readonly string[];
}

export interface NormalizedBranchState {
  readonly sha: string | null;
  readonly merged: boolean;
  readonly mergeableState: string | null;
  readonly ci: CiState | null;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly mergeCommitSha: string | null;
}

/** One tick's observation of a tracked branch (PR + CI may be partial). */
export interface BranchObservation {
  readonly pull: GhPull | null;
  /** null = CI not observed this tick (no sha, merged, or a fetch failure) —
   * carry-forward rules keep the previous state rather than inventing one. */
  readonly ci: CiState | null;
}

const FAILURE_CONCLUSIONS: ReadonlySet<string> = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'stale',
]);

/** Summarize latest check runs into the CI state (null = no runs observed). */
export function summarizeCheckRuns(sha: string, runs: readonly GhCheckRun[]): CiState | null {
  if (runs.length === 0) return null;
  const failures: CiFailure[] = runs
    .filter((run) => run.conclusion !== null && FAILURE_CONCLUSIONS.has(run.conclusion))
    .map((run) => ({ name: run.name, conclusion: run.conclusion as string, url: run.url }));
  const pending = runs.some((run) => run.status !== 'completed');
  const checks = runs.filter((run) => run.status === 'completed').map((run) => run.name).sort();
  const signature = failures.map((failure) => failure.name).sort().join('|');
  if (failures.length > 0) return { sha, status: 'failed', signature, failures, checks };
  if (pending) return { sha, status: 'pending', signature: '', failures: [], checks };
  return { sha, status: 'green', signature: '', failures: [], checks };
}

/** Mechanical checks are build/test/lint-style kinds a lane can fix; every
 * other kind (review gates, scans, deploys) is judgment — fail toward
 * attention, per the notification center's routing doctrine. */
const MECHANICAL_CHECK_PATTERN = /(build|test|lint|type|compile|check|ci|suite|format|unit|integration|e2e)/iu;

export function classifyCheck(name: string): CiFailureTier {
  return MECHANICAL_CHECK_PATTERN.test(name) ? 'mechanical' : 'judgment';
}

/** The tier of a failing set: one judgment failure makes the whole incident
 * judgment (never quietly mechanical). */
export function ciFailureTier(failures: readonly CiFailure[]): CiFailureTier {
  return failures.some((failure) => classifyCheck(failure.name) === 'judgment') ? 'judgment' : 'mechanical';
}

/**
 * Carry-forward normalization. Rules, each pinned by tests:
 * - merged is monotonic once observed;
 * - sha/prNumber/prUrl/mergeCommitSha carry past observations forward when
 *   this tick did not see the PR (window miss or fetch failure);
 * - mergeableState 'unknown'/absent is NOT a state change (GitHub computes
 *   it asynchronously) — the previous value persists;
 * - CI carries only for the same sha: a moved head resets CI to "unobserved"
 *   rather than mislabeling the old conclusion.
 */
export function nextBranchState(
  prev: NormalizedBranchState | null,
  obs: BranchObservation,
): NormalizedBranchState {
  const pull = obs.pull;
  const sha = pull?.headSha ?? prev?.sha ?? null;
  const merged = pull?.merged === true || prev?.merged === true;
  const rawMergeable = pull?.mergeableState ?? null;
  const mergeableState =
    rawMergeable !== null && rawMergeable !== 'unknown'
      ? rawMergeable
      : prev?.mergeableState ?? null;
  const ci = obs.ci ?? (prev?.ci != null && prev.ci.sha === sha ? prev.ci : null);
  return {
    sha,
    merged,
    mergeableState,
    ci,
    prNumber: pull?.number ?? prev?.prNumber ?? null,
    prUrl: pull?.url ?? prev?.prUrl ?? null,
    mergeCommitSha: pull?.mergeCommitSha ?? prev?.mergeCommitSha ?? null,
  };
}

export function sameBranchState(left: NormalizedBranchState | null, right: NormalizedBranchState): boolean {
  if (left === null) return false;
  return (
    left.sha === right.sha &&
    left.merged === right.merged &&
    left.mergeableState === right.mergeableState &&
    left.prNumber === right.prNumber &&
    left.prUrl === right.prUrl &&
    left.mergeCommitSha === right.mergeCommitSha &&
    sameCiState(left.ci, right.ci)
  );
}

function sameCiState(left: CiState | null, right: CiState | null): boolean {
  if (left === null || right === null) return left === right;
  return left.sha === right.sha && left.status === right.status && left.signature === right.signature;
}

// ------------------------------------------------------------------
// Signals (the applied transitions)
// ------------------------------------------------------------------

export interface GitHubSignalContext {
  readonly jobId: string;
  readonly repo: RepoRef;
  readonly branch: string;
}

interface GitHubSignalBase extends GitHubSignalContext {
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly sha: string | null;
}

export interface PrMergedSignal extends GitHubSignalBase {
  readonly kind: 'pr-merged';
  readonly mergeCommitSha: string | null;
}

export interface PrConflictSignal extends GitHubSignalBase {
  readonly kind: 'pr-conflict';
  readonly mergeableState: 'dirty';
}

export interface CiFailedSignal extends GitHubSignalBase {
  readonly kind: 'ci-failed';
  readonly sha: string;
  readonly tier: CiFailureTier;
  readonly failures: readonly CiFailure[];
}

export interface CiGreenSignal extends GitHubSignalBase {
  readonly kind: 'ci-green';
  readonly sha: string;
  readonly checks: readonly string[];
}

export type GitHubSignal = PrMergedSignal | PrConflictSignal | CiFailedSignal | CiGreenSignal;

/**
 * The state-change mappings, pure: every signal is a transition of the
 * normalized state, and every transition fires exactly once per change —
 * merged (first merge observed), conflict (state becomes dirty), CI failed
 * (sha moved OR the failing set changed), CI green (green on a sha/status
 * not already green).
 */
export function diffBranchState(
  context: GitHubSignalContext,
  prev: NormalizedBranchState | null,
  next: NormalizedBranchState,
): readonly GitHubSignal[] {
  const base = {
    jobId: context.jobId,
    repo: context.repo,
    branch: context.branch,
    prNumber: next.prNumber,
    prUrl: next.prUrl,
    sha: next.sha,
  };
  const signals: GitHubSignal[] = [];
  if (next.merged && prev?.merged !== true) {
    signals.push({ kind: 'pr-merged', ...base, mergeCommitSha: next.mergeCommitSha });
  }
  if (next.mergeableState === 'dirty' && prev?.mergeableState !== 'dirty') {
    signals.push({ kind: 'pr-conflict', ...base, mergeableState: 'dirty' });
  }
  const ci = next.ci;
  if (ci !== null && ci.status === 'failed') {
    const alreadyApplied =
      prev?.ci != null && prev.ci.sha === ci.sha && prev.ci.status === 'failed' && prev.ci.signature === ci.signature;
    if (!alreadyApplied) {
      signals.push({
        kind: 'ci-failed',
        ...base,
        sha: ci.sha,
        tier: ciFailureTier(ci.failures),
        failures: ci.failures,
      });
    }
  }
  if (ci !== null && ci.status === 'green') {
    const alreadyApplied = prev?.ci != null && prev.ci.sha === ci.sha && prev.ci.status === 'green';
    if (!alreadyApplied) {
      signals.push({ kind: 'ci-green', ...base, sha: ci.sha, checks: ci.checks });
    }
  }
  return signals;
}

// ------------------------------------------------------------------
// Tracked lanes (from the ledger + the lane's git remote)
// ------------------------------------------------------------------

export interface TrackedLane {
  readonly jobId: string;
  readonly repo: RepoRef;
  readonly branch: string;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
}

export type LaneRemoteResolver = (repoPath: string) => { host: string; owner: string; repo: string } | null;

export interface TrackedLaneLedger {
  listJobs(): readonly JobRecord[];
  listWorktrees(opts?: { jobId?: string }): readonly WorktreeRecord[];
}

const TRACKABLE_STATUSES: ReadonlySet<string> = new Set([
  'working',
  'delivered',
  'in-review',
  'blocked',
  'parked',
]);

/**
 * Every open job lane on a GitHub repo. The repo comes from the recorded PR
 * URL when one exists, else from the lane's git origin remote. Lanes without
 * either, or on non-GitHub hosts, are not trackable and are skipped.
 */
export function trackedLanes(input: {
  readonly ledger: TrackedLaneLedger;
  readonly resolveRemote: LaneRemoteResolver;
}): readonly TrackedLane[] {
  const lanes: TrackedLane[] = [];
  const seen = new Set<string>();
  const jobs = [...input.ledger.listJobs()].sort((a, b) => a.id.localeCompare(b.id));
  for (const job of jobs) {
    if (!TRACKABLE_STATUSES.has(job.status)) continue;
    const laneRecord = input.ledger
      .listWorktrees({ jobId: job.id })
      .find((candidate) => candidate.kind === 'job' && candidate.status !== 'swept');
    const prFromUrl = job.prUrl !== null ? parseGitHubPrUrl(job.prUrl) : null;
    let repo: RepoRef | null = prFromUrl !== null ? { host: prFromUrl.host, owner: prFromUrl.owner, repo: prFromUrl.repo } : null;
    if (repo === null && laneRecord !== undefined) {
      const remote = input.resolveRemote(laneRecord.repoPath);
      if (remote !== null && isGitHubRemote(remote.host)) repo = { host: remote.host, owner: remote.owner, repo: remote.repo };
    }
    if (repo === null) continue;
    const branch = laneRecord?.branch ?? `gru/${job.id}`;
    const key = `${repo.host}/${repoFullName(repo)}#${branch}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lanes.push({
      jobId: job.id,
      repo,
      branch,
      prNumber: prFromUrl?.number ?? null,
      prUrl: job.prUrl,
    });
  }
  return lanes;
}

// ------------------------------------------------------------------
// gh CLI adapter
// ------------------------------------------------------------------

export class GhApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GhApiError';
  }
}

/** A rate-limit response — the tick must stop calling, never hammer. */
export class GhRateLimitedError extends GhApiError {
  constructor(message: string) {
    super(message);
    this.name = 'GhRateLimitedError';
  }
}

/** Per-tick call budget exhausted — the rest of the tick defers. */
export class GhBudgetExceededError extends GhApiError {
  constructor(message: string) {
    super(message);
    this.name = 'GhBudgetExceededError';
  }
}

export interface GhCommandResult {
  /** Exit code; -1 when the process could not run (spawn error/timeout). */
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export type GhCommandRunner = (args: readonly string[]) => Promise<GhCommandResult>;

const GH_COMMAND_TIMEOUT_MS = 30_000;
const GH_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Spawn the real `gh` binary; output bounded, timeout kills loud. */
export function defaultGhRunner(binary = 'gh'): GhCommandRunner {
  return (args) =>
    new Promise<GhCommandResult>((resolve) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      const child = spawn(binary, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      const finish = (result: GhCommandResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish({ status: -1, stdout, stderr, error: `gh api timed out after ${GH_COMMAND_TIMEOUT_MS} ms` });
      }, GH_COMMAND_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length >= GH_MAX_OUTPUT_BYTES) {
          child.kill('SIGKILL');
          finish({ status: -1, stdout, stderr, error: `gh api output exceeds ${GH_MAX_OUTPUT_BYTES} bytes` });
          return;
        }
        stdout += chunk.toString('utf-8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < GH_MAX_OUTPUT_BYTES) stderr += chunk.toString('utf-8');
      });
      child.on('error', (error) => {
        finish({ status: -1, stdout: '', stderr: '', error: String(error) });
      });
      child.on('close', (code) => {
        finish({ status: code ?? -1, stdout, stderr });
      });
    });
}

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

/** Map a raw pulls JSON object; null when the entry carries no usable head
 * (e.g. a deleted fork head) — the entry is then simply not observable. */
function mapPull(value: unknown): GhPull | null {
  const raw = record(value);
  if (raw === null) return null;
  const number = numOrNull(raw['number']);
  const head = record(raw['head']);
  const headRef = head !== null ? strOrNull(head['ref']) : null;
  if (number === null || headRef === null) return null;
  return {
    number,
    headRef,
    headSha: head !== null ? strOrNull(head['sha']) : null,
    state: strOrNull(raw['state']) ?? 'unknown',
    merged: raw['merged_at'] !== null && raw['merged_at'] !== undefined,
    mergeableState: strOrNull(raw['mergeable_state']),
    mergeCommitSha: strOrNull(raw['merge_commit_sha']),
    url: strOrNull(raw['html_url']),
  };
}

function mapCheckRun(value: unknown): GhCheckRun | null {
  const raw = record(value);
  if (raw === null) return null;
  const name = strOrNull(raw['name']);
  if (name === null) return null;
  return {
    name,
    status: strOrNull(raw['status']) ?? 'unknown',
    conclusion: strOrNull(raw['conclusion']),
    url: strOrNull(raw['details_url']) ?? strOrNull(raw['html_url']),
  };
}

/**
 * The real port: `gh api` with `--hostname` (GitHub Enterprise-safe, the
 * same discipline as the Perkins verdict poster). Query parameters ride the
 * URL; responses are parsed as JSON with a fail-loud shape check.
 */
export class GhCliApi implements GhApiPort {
  constructor(
    private readonly run: GhCommandRunner = defaultGhRunner(),
    private readonly binary = 'gh',
  ) {}

  private async apiJson(label: string, repo: RepoRef, path: string): Promise<unknown> {
    const result = await this.run(['api', '--hostname', repo.host, path]);
    if (result.status !== 0) {
      const stderr = result.stderr.trim().slice(0, 300);
      if (result.error !== undefined && result.error !== '') {
        throw new GhApiError(`${label}: gh is unavailable (${result.error})`);
      }
      if (/rate limit/i.test(stderr)) {
        throw new GhRateLimitedError(`${label}: GitHub rate limit (${stderr})`);
      }
      throw new GhApiError(`${label}: ${this.binary} exited ${result.status}: ${stderr}`);
    }
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch (error) {
      throw new GhApiError(`${label}: gh returned invalid JSON (${String(error)})`);
    }
  }

  async listPulls(input: { readonly repo: RepoRef; readonly limit: number }): Promise<readonly GhPull[]> {
    const path =
      `repos/${input.repo.owner}/${input.repo.repo}/pulls` +
      `?state=all&sort=updated&direction=desc&per_page=${input.limit}`;
    const parsed = await this.apiJson(`list pulls ${repoFullName(input.repo)}`, input.repo, path);
    if (!Array.isArray(parsed)) {
      throw new GhApiError(`list pulls ${repoFullName(input.repo)}: expected a JSON array`);
    }
    return parsed.map(mapPull).filter((pull): pull is GhPull => pull !== null);
  }

  async getPull(input: { readonly repo: RepoRef; readonly number: number }): Promise<GhPull> {
    const path = `repos/${input.repo.owner}/${input.repo.repo}/pulls/${input.number}`;
    const parsed = await this.apiJson(`get pull ${repoFullName(input.repo)}#${input.number}`, input.repo, path);
    const pull = mapPull(parsed);
    if (pull === null) {
      throw new GhApiError(`get pull ${repoFullName(input.repo)}#${input.number}: malformed pull object`);
    }
    return pull;
  }

  async listCheckRuns(input: { readonly repo: RepoRef; readonly sha: string }): Promise<readonly GhCheckRun[]> {
    const path =
      `repos/${input.repo.owner}/${input.repo.repo}/commits/${input.sha}/check-runs` +
      `?per_page=100&filter=latest`;
    const parsed = await this.apiJson(`check runs ${repoFullName(input.repo)}@${input.sha.slice(0, 12)}`, input.repo, path);
    const wrapper = record(parsed);
    const runs = wrapper !== null ? wrapper['check_runs'] : null;
    if (!Array.isArray(runs)) {
      throw new GhApiError(`check runs ${repoFullName(input.repo)}: response carries no check_runs array`);
    }
    return runs.map(mapCheckRun).filter((run): run is GhCheckRun => run !== null);
  }
}

// ------------------------------------------------------------------
// The poll engine
// ------------------------------------------------------------------

export interface GitHubPollLedger {
  listJobs(): readonly JobRecord[];
  getJob(id: string): JobRecord | null;
  listWorktrees(opts?: { jobId?: string }): readonly WorktreeRecord[];
  latestJobEvent(jobId: string, kind: string): EventRecord | null;
  appendCustomEvent(fields: {
    kind: string;
    jobId?: string | null;
    payload?: unknown;
  }): unknown;
  setJobStatus(id: string, status: string): JobRecord;
}

export interface GitHubPollNotifications {
  postIncident(input: {
    kind: string;
    routing: NotificationRouting;
    severity: NotificationSeverity;
    title: string;
    detail?: string | null;
    dedupe: 'unacked' | 'active' | 'all';
  }): unknown;
}

export interface GitHubPollOptions {
  readonly ledger: GitHubPollLedger;
  readonly notifications: GitHubPollNotifications;
  readonly api: GhApiPort;
  readonly resolveRemote: LaneRemoteResolver;
  /** Per-tick `gh api` call budget; default {@link GITHUB_POLL_MAX_CALLS_PER_TICK}. */
  readonly maxCallsPerTick?: number;
  /** PRs read per repo per tick; default {@link GITHUB_POLL_MAX_PULLS_PER_REPO}. */
  readonly maxPullsPerRepo?: number;
  readonly log?: Log;
}

/** The dedupe cursor event: one per observed state CHANGE, never per tick. */
export const BRANCH_STATE_EVENT = 'github.branch-state';

export function branchStatePayload(lane: TrackedLane, state: NormalizedBranchState): Record<string, unknown> {
  return {
    repo: repoFullName(lane.repo),
    branch: lane.branch,
    sha: state.sha,
    merged: state.merged,
    mergeable_state: state.mergeableState,
    pr_number: state.prNumber,
    pr_url: state.prUrl,
    merge_commit_sha: state.mergeCommitSha,
    ci:
      state.ci === null
        ? null
        : {
            sha: state.ci.sha,
            status: state.ci.status,
            signature: state.ci.signature,
            failures: state.ci.failures,
            checks: state.ci.checks,
          },
  };
}

/** Read the recorded dedupe cursor for a job; malformed payloads re-observe. */
export function readBranchState(ledger: Pick<GitHubPollLedger, 'latestJobEvent'>, jobId: string, log?: Log): NormalizedBranchState | null {
  const event = ledger.latestJobEvent(jobId, BRANCH_STATE_EVENT);
  if (event === null) return null;
  const payload = record(event.payload);
  if (payload === null) {
    log?.('warn', 'github poll: branch-state event has a non-object payload — re-observing', { jobId });
    return null;
  }
  const ciRaw = record(payload['ci']);
  const ci: CiState | null =
    ciRaw === null
      ? null
      : {
          sha: strOrNull(ciRaw['sha']) ?? '',
          status:
            ciRaw['status'] === 'failed' || ciRaw['status'] === 'green' || ciRaw['status'] === 'pending'
              ? (ciRaw['status'] as CiStatus)
              : 'pending',
          signature: strOrNull(ciRaw['signature']) ?? '',
          failures: Array.isArray(ciRaw['failures'])
            ? (ciRaw['failures'] as unknown[]).flatMap((entry): CiFailure[] => {
                const failure = record(entry);
                const name = failure !== null ? strOrNull(failure['name']) : null;
                if (failure === null || name === null) return [];
                return [
                  {
                    name,
                    conclusion: strOrNull(failure['conclusion']) ?? 'failure',
                    url: strOrNull(failure['url']),
                  },
                ];
              })
            : [],
          checks: Array.isArray(ciRaw['checks'])
            ? (ciRaw['checks'] as unknown[]).filter((entry): entry is string => typeof entry === 'string')
            : [],
        };
  return {
    sha: strOrNull(payload['sha']),
    merged: payload['merged'] === true,
    mergeableState: strOrNull(payload['mergeable_state']),
    ci,
    prNumber: numOrNull(payload['pr_number']),
    prUrl: strOrNull(payload['pr_url']),
    mergeCommitSha: strOrNull(payload['merge_commit_sha']),
  };
}

export interface GitHubPollTickResult {
  readonly tracked: number;
  readonly observed: number;
  readonly calls: number;
  readonly budgetExhausted: boolean;
  readonly rateLimited: boolean;
  readonly signals: readonly GitHubSignal[];
}

interface RepoGroup {
  readonly repo: RepoRef;
  readonly lanes: TrackedLane[];
}

export class GitHubSignalPoll {
  private readonly ledger: GitHubPollLedger;
  private readonly notifications: GitHubPollNotifications;
  private readonly api: GhApiPort;
  private readonly resolveRemote: LaneRemoteResolver;
  private readonly maxCallsPerTick: number;
  private readonly maxPullsPerRepo: number;
  private readonly log: Log;

  constructor(opts: GitHubPollOptions) {
    this.ledger = opts.ledger;
    this.notifications = opts.notifications;
    this.api = opts.api;
    this.resolveRemote = opts.resolveRemote;
    this.maxCallsPerTick = opts.maxCallsPerTick ?? GITHUB_POLL_MAX_CALLS_PER_TICK;
    this.maxPullsPerRepo = opts.maxPullsPerRepo ?? GITHUB_POLL_MAX_PULLS_PER_REPO;
    this.log = opts.log ?? (() => {});
  }

  /**
   * One poll tick: observe every tracked branch and apply the state-change
   * mappings. Budget exhaustion or a GitHub rate limit ends the tick early
   * (loudly); already-applied signals stay applied and the next tick
   * re-observes from the ledger.
   */
  async pollOnce(): Promise<GitHubPollTickResult> {
    const lanes = trackedLanes({ ledger: this.ledger, resolveRemote: this.resolveRemote });
    const groups = new Map<string, RepoGroup>();
    for (const lane of lanes) {
      const key = `${lane.repo.host}/${repoFullName(lane.repo)}`;
      const existing = groups.get(key);
      if (existing !== undefined) existing.lanes.push(lane);
      else groups.set(key, { repo: lane.repo, lanes: [lane] });
    }
    const budget = { used: 0, limit: this.maxCallsPerTick };
    const checkRunCache = new Map<string, CiState | null>();
    const applied: GitHubSignal[] = [];
    let observed = 0;
    let budgetExhausted = false;
    let rateLimited = false;
    try {
      for (const group of groups.values()) {
        let pulls: readonly GhPull[];
        try {
          pulls = await this.call(budget, `list pulls ${repoFullName(group.repo)}`, () =>
            this.api.listPulls({ repo: group.repo, limit: this.maxPullsPerRepo }),
          );
        } catch (error) {
          if (this.abortTick(error, group.repo, 'list pulls')) throw error;
          continue;
        }
        const byBranch = new Map<string, GhPull>();
        for (const pull of pulls) {
          if (!byBranch.has(pull.headRef)) byBranch.set(pull.headRef, pull);
        }
        for (const lane of group.lanes) {
          try {
            const observation = await this.observeLane(budget, lane, byBranch, checkRunCache);
            if (observation === null) continue;
            observed += 1;
            const prev = readBranchState(this.ledger, lane.jobId, this.log);
            const next = nextBranchState(prev, observation);
            const signals = diffBranchState(
              { jobId: lane.jobId, repo: lane.repo, branch: lane.branch },
              prev,
              next,
            );
            for (const signal of signals) this.applySignal(signal);
            applied.push(...signals);
            if (!sameBranchState(prev, next)) {
              this.ledger.appendCustomEvent({
                kind: BRANCH_STATE_EVENT,
                jobId: lane.jobId,
                payload: branchStatePayload(lane, next),
              });
            }
          } catch (error) {
            if (this.abortTick(error, group.repo, `lane ${lane.jobId}`)) throw error;
          }
        }
      }
    } catch (error) {
      if (!(error instanceof GhBudgetExceededError) && !(error instanceof GhRateLimitedError)) throw error;
      if (error instanceof GhBudgetExceededError) {
        budgetExhausted = true;
        this.log('warn', 'github poll: per-tick gh budget exhausted — remaining lanes defer to the next tick', {
          budget: this.maxCallsPerTick,
        });
      } else {
        rateLimited = true;
        this.log('warn', 'github poll: GitHub rate limit hit — tick aborted, retrying next interval', {
          error: String(error).slice(0, 300),
        });
      }
    }
    return {
      tracked: lanes.length,
      observed,
      calls: budget.used,
      budgetExhausted,
      rateLimited,
      signals: applied,
    };
  }

  /** Observe one lane: match the PR, fetch mergeability for open PRs, fetch
   * latest check runs for the head (cached per repo+sha within the tick). */
  private async observeLane(
    budget: { used: number; limit: number },
    lane: TrackedLane,
    byBranch: Map<string, GhPull>,
    checkRunCache: Map<string, CiState | null>,
  ): Promise<BranchObservation | null> {
    let pull = byBranch.get(lane.branch) ?? null;
    let detailed = false;
    if (pull === null && lane.prNumber !== null) {
      // The batched window (100 most recently updated PRs) missed the
      // registry-known PR — fetch it directly so merge detection stays exact.
      const number = lane.prNumber;
      pull = await this.call(budget, `get pull ${repoFullName(lane.repo)}#${number}`, () =>
        this.api.getPull({ repo: lane.repo, number }),
      );
      detailed = true;
    }
    // The list endpoint returns mergeable_state as null; the single-PR
    // endpoint is the only place GitHub computes it. One detail call per
    // OPEN tracked PR per tick — the unavoidable share of the budget.
    if (pull !== null && !pull.merged && pull.state === 'open' && !detailed) {
      const number = pull.number;
      pull = await this.call(budget, `get pull ${repoFullName(lane.repo)}#${number}`, () =>
        this.api.getPull({ repo: lane.repo, number }),
      );
    }
    let ci: CiState | null = null;
    const sha = pull?.headSha ?? null;
    if (pull !== null && !pull.merged && sha !== null) {
      const cacheKey = `${repoFullName(lane.repo)}@${sha}`;
      if (checkRunCache.has(cacheKey)) {
        ci = checkRunCache.get(cacheKey) ?? null;
      } else {
        const runs = await this.call(budget, `check runs ${repoFullName(lane.repo)}@${sha.slice(0, 12)}`, () =>
          this.api.listCheckRuns({ repo: lane.repo, sha }),
        );
        ci = summarizeCheckRuns(sha, runs);
        checkRunCache.set(cacheKey, ci);
      }
    }
    return { pull, ci };
  }

  /** Returns true when the error ends the tick; otherwise logs and returns false. */
  private abortTick(error: unknown, repo: RepoRef, scope: string): boolean {
    if (error instanceof GhBudgetExceededError || error instanceof GhRateLimitedError) return true;
    this.log('warn', 'github poll: gh call failed — lane/repo skipped this tick', {
      repo: repoFullName(repo),
      scope,
      error: String(error).slice(0, 300),
    });
    return false;
  }

  private async call<T>(
    budget: { used: number; limit: number },
    label: string,
    work: () => Promise<T>,
  ): Promise<T> {
    if (budget.used >= budget.limit) throw new GhBudgetExceededError(`gh call budget exceeded at ${label}`);
    budget.used += 1;
    return work();
  }

  // ------------------------------------------------------------------
  // Mechanical applications (tier 0/1 — the existing Silas mandate)
  // ------------------------------------------------------------------

  private applySignal(signal: GitHubSignal): void {
    switch (signal.kind) {
      case 'pr-merged':
        this.applyMerged(signal);
        return;
      case 'pr-conflict':
        this.applyConflict(signal);
        return;
      case 'ci-failed':
        this.applyCiFailed(signal);
        return;
      case 'ci-green':
        this.applyCiGreen(signal);
        return;
    }
  }

  /**
   * The merge map: bring the lane to `in-review` when the hop is legal
   * (merged is terminal truth — a lane whose PR landed while it sat blocked
   * or delivered must not stay open), then `in-review -> merged`, then the
   * `github.pr-merged` event. An unappliable transition is recorded loud,
   * never coerced.
   */
  private applyMerged(signal: PrMergedSignal): void {
    const job = this.ledger.getJob(signal.jobId);
    if (job === null) {
      this.log('warn', 'github poll: merged PR for an unknown job', { job: signal.jobId });
      return;
    }
    if (job.status === 'merged' || job.status === 'done') return;
    const payload = {
      repo: repoFullName(signal.repo),
      branch: signal.branch,
      pr: signal.prNumber,
      url: signal.prUrl,
      sha: signal.sha,
      merge_commit_sha: signal.mergeCommitSha,
    };
    try {
      if (job.status !== 'in-review') this.ledger.setJobStatus(signal.jobId, 'in-review');
      this.ledger.setJobStatus(signal.jobId, 'merged');
      this.ledger.appendCustomEvent({ kind: 'github.pr-merged', jobId: signal.jobId, payload: { ...payload, applied: true } });
      this.log('info', 'github poll: PR merged, lane closed', {
        job: signal.jobId,
        repo: repoFullName(signal.repo),
        pr: signal.prNumber,
      });
    } catch (error) {
      this.ledger.appendCustomEvent({
        kind: 'github.pr-merged',
        jobId: signal.jobId,
        payload: { ...payload, applied: false, reason: String(error).slice(0, 300) },
      });
      this.log('error', 'github poll: merged PR could not close the lane', {
        job: signal.jobId,
        status: job.status,
        error: String(error).slice(0, 300),
      });
    }
  }

  /** Conflict cascade: the event is the record; the action-required
   * notification is the cascade (mechanical tier — Silas may arm a rebase
   * lane within his existing mandate, no human ack required to act). */
  private applyConflict(signal: PrConflictSignal): void {
    const prLabel = signal.prNumber !== null ? `#${signal.prNumber}` : '(unknown PR)';
    const detail = [
      `Branch ${signal.branch} of ${repoFullName(signal.repo)} is conflicting with its base.`,
      `Mechanical tier: within mandate Silas may arm a rebase lane for ${prLabel}.`,
      ...(signal.prUrl !== null ? [signal.prUrl] : []),
    ].join(' ');
    this.ledger.appendCustomEvent({
      kind: 'github.pr-conflict',
      jobId: signal.jobId,
      payload: {
        repo: repoFullName(signal.repo),
        branch: signal.branch,
        pr: signal.prNumber,
        url: signal.prUrl,
        mergeable_state: signal.mergeableState,
      },
    });
    this.notifications.postIncident({
      kind: `github.pr-conflict:${signal.jobId}`,
      routing: 'action-required',
      severity: 'error',
      title: `PR ${prLabel} conflicts with its base (${repoFullName(signal.repo)})`,
      detail,
      dedupe: 'unacked',
    });
    this.log('info', 'github poll: PR conflict observed', {
      job: signal.jobId,
      repo: repoFullName(signal.repo),
      pr: signal.prNumber,
    });
  }

  /** CI failure: notification with the run URL(s); routing follows the
   * failing check kind (mechanical -> fyi, judgment -> action-required). */
  private applyCiFailed(signal: CiFailedSignal): void {
    const tierLabel = signal.tier === 'mechanical' ? 'tier 1 (mechanical)' : 'tier 2 (judgment)';
    const detail = [
      ...signal.failures.map((failure) => `${failure.name}: ${failure.conclusion}${failure.url !== null ? ` ${failure.url}` : ''}`),
      `${tierLabel} — ${signal.tier === 'mechanical' ? 'Silas may direct the fix within mandate' : 'wake-eligible action-required'}.`,
      ...(signal.prUrl !== null ? [signal.prUrl] : []),
    ].join('\n');
    this.ledger.appendCustomEvent({
      kind: 'github.ci-failed',
      jobId: signal.jobId,
      payload: {
        repo: repoFullName(signal.repo),
        branch: signal.branch,
        pr: signal.prNumber,
        sha: signal.sha,
        tier: signal.tier,
        failures: signal.failures,
      },
    });
    this.notifications.postIncident({
      kind: `github.ci-failed:${signal.jobId}:${signal.sha}`,
      routing: signal.tier === 'judgment' ? 'action-required' : 'fyi',
      severity: 'error',
      title: `CI failed on ${signal.branch} (${repoFullName(signal.repo)})`,
      detail,
      dedupe: 'unacked',
    });
    this.log('info', 'github poll: CI failure observed', {
      job: signal.jobId,
      sha: signal.sha,
      tier: signal.tier,
    });
  }

  /** CI green: the review-gate signal event (no notification — green is a
   * go-signal, the review-due digest row owns the actual request). */
  private applyCiGreen(signal: CiGreenSignal): void {
    this.ledger.appendCustomEvent({
      kind: 'github.ci-green',
      jobId: signal.jobId,
      payload: {
        repo: repoFullName(signal.repo),
        branch: signal.branch,
        pr: signal.prNumber,
        sha: signal.sha,
        checks: signal.checks,
      },
    });
    this.log('info', 'github poll: CI green signal recorded', {
      job: signal.jobId,
      sha: signal.sha,
    });
  }
}
