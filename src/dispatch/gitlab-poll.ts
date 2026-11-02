import type { EventRecord, JobRecord, WorktreeRecord } from '../ledger/api.js';
import type { LogLevel } from '../logger.js';
import {
  GITLAB_MR_OBSERVED_EVENT,
  GITLAB_MR_READ_FAILED_EVENT,
  readGitLabMrObservation,
} from '../review-inputs/ci-evidence.js';
import { applyMergedLane, type MergeMapOutcome } from './github-poll.js';
import { parseGitLabMrLink, type RepoRemote } from './review-path.js';
import {
  normalizedHost,
  originMismatch,
  recordGitLabMrRead,
  type GitLabMrObservedFacts,
  type GitLabMrReadDeps,
  type GitLabMrReadFailure,
  type GitLabMrReadRequest,
} from './perkins-review/gitlab-mr-read.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * GitLab merge-request observation for the Silas watchtower (#568).
 *
 * The GitHub poll has no GitLab equivalent: it reads GitHub branches through
 * `gh api`, and a GitLab merge request has no branch-state endpoint this
 * service reads. So this poll makes the ONE read the review round already
 * makes (`readGitLabMr`, one `GET` per tracked merge request per tick) on the
 * driver's existing `[silas] poll_interval_ms` timer, and applies the merge
 * mapping through the SAME shared merge map the GitHub poll uses:
 *
 *   MR merged -> live job in-review -> merged + `gitlab.mr-merged`;
 *                a binned lane gets only a no-effect receipt
 *
 * OBSERVATION IS RECORDED ON CHANGE, NEVER PER TICK: the read is appended as
 * `gitlab.mr-observed` only when its record tuple (host, project, iid, state,
 * head sha, head pipeline id and status, merge commit sha, mergeability)
 * differs from the newest recorded observation, when that observation is older
 * than `GITLAB_EVIDENCE_MAX_AGE_MS` (so an idle lane does not stay aged out of
 * the board's owner readiness while the poll is succeeding), or when the newest
 * `gitlab.*` event is a read failure (a success always supersedes one). A run
 * of the same failure records one event, never one per tick. THE MERGE IS NOT
 * RECORD-GATED: the merge decision is taken from the facts the read returned,
 * so a lane whose newest observation already reports `merged` (a review
 * round's read, or an append a restart left unapplied) still closes.
 *
 * The token never leaves the lane's own host: a job's link is read only when
 * it is a supported GitLab merge request AND names the origin remote of the
 * job's lane (`originMismatch`). A link on an unsupported host, or one naming
 * another project or host, is never read and records nothing; each skip logs
 * one line per job per process.
 *
 * Every observation this poll records carries `round_id: null`: no review round
 * may ever bind it (the freeze binding receives its own round's event object,
 * never a ledger query). It is visible to the board's owner-readiness reader,
 * which is the point of the poll.
 *
 * Cost is bounded by wall clock, not by call count: a tick stops starting
 * reads once `GITLAB_POLL_TICK_DEADLINE_MS` has passed, and a `rate-limit`
 * answer ends the tick's remaining reads. A closed or merged merge request
 * keeps being re-read every tick (there is no cursor to stop on); that is the
 * named, accepted cost of having no list endpoint.
 */

/** A tick stops starting reads once this much wall clock has passed, so one
 * slow host cannot stretch a poll across several intervals: with the read's
 * own 30 s timeout the worst case stays around the default 60 s interval. */
export const GITLAB_POLL_TICK_DEADLINE_MS = 30_000;

/** How old a recorded GitLab observation may be and still certify the board's
 * owner readiness. The poll re-records an unchanged observation once it is
 * older than this, so a lane that is simply idle does not stay aged out while
 * the poll is succeeding — the refresh lands at the next tick, so up to one
 * poll interval past the bound the row is withheld. Duration, never
 * escalation: the row stops rendering. */
export const GITLAB_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Job statuses whose merge request is still worth observing. Terminal lanes
 * are never tracked: a lane binned before the tick makes no request. */
const TRACKABLE_STATUSES: ReadonlySet<string> = new Set([
  'working',
  'delivered',
  'in-review',
  'blocked',
  'parked',
]);

/** The merge event a GitLab merge records (the GitHub arm's analogue is
 * `github.pr-merged`). */
export const GITLAB_MR_MERGED_EVENT = 'gitlab.mr-merged';

export interface GitLabPollLedger {
  listJobs(): readonly JobRecord[];
  getJob(id: string): JobRecord | null;
  listWorktrees(opts?: { jobId?: string }): readonly WorktreeRecord[];
  latestJobEvent(jobId: string, kind: string): EventRecord | null;
  setJobStatus(id: string, status: string): JobRecord;
  /** Wider than the merge map's: an observation is appended with an explicit
   * `round_id` (null for every poll record). */
  appendCustomEvent(fields: {
    kind: string;
    jobId?: string | null;
    roundId?: string | null;
    payload?: unknown;
  }): EventRecord;
}

export interface GitLabPollOptions {
  readonly ledger: GitLabPollLedger;
  /** The lane's git origin remote, resolved from its live worktree row. */
  readonly resolveRemote: (repoPath: string) => RepoRemote | null;
  /** Test seams for the read; production uses the global `fetch` and
   * `process.env`. */
  readonly deps?: GitLabMrReadDeps;
  /** Per-tick wall clock budget; default {@link GITLAB_POLL_TICK_DEADLINE_MS}. */
  readonly deadlineMs?: number;
  readonly now?: () => number;
  readonly log?: Log;
}

/** One tick's outcome: what was tracked, how many reads were made and how many
 * observations were freshly recorded, plus the two ways a tick ends early. */
export interface GitLabPollTickResult {
  readonly tracked: number;
  readonly reads: number;
  readonly observed: number;
  readonly merged: number;
  readonly deadlineExceeded: boolean;
  readonly rateLimited: boolean;
}

/** One tracked merge request: the identity its link names, the origin that
 * link was checked against, and the canonical MR URL the merge payload
 * carries. */
interface GitLabTrackedLane {
  readonly jobId: string;
  readonly link: GitLabMrReadRequest;
  readonly origin: RepoRemote;
  readonly url: string;
}

/** Why a job's link is tracked or not — the two skips that deserve one log
 * line each (never one per tick). */
type GitLabLaneSkip = 'unsupported-host' | 'origin-mismatch';

/** Whether the answer describes the merge request the lane's link names: host
 * case-insensitively with its port, project path case-insensitively (the
 * verdict poster's comparison), iid exactly. A disagreement never merges a
 * lane. */
function sameIdentity(
  link: GitLabMrReadRequest,
  facts: Pick<GitLabMrObservedFacts, 'host' | 'project' | 'mr_iid'>,
): boolean {
  return normalizedHost(link.host) === normalizedHost(facts.host)
    && link.project.toLowerCase() === facts.project.toLowerCase()
    && link.iid === facts.mr_iid;
}

/** The merge-map payload of a GitLab merge: the merge request's identity, the
 * canonical URL and the head/merge commits. */
function mergePayload(facts: GitLabMrObservedFacts, url: string): Record<string, unknown> {
  return {
    host: facts.host,
    project: facts.project,
    mr_iid: facts.mr_iid,
    url,
    sha: facts.head_sha,
    merge_commit_sha: facts.merge_commit_sha,
  };
}

/** The record-on-change tuple: everything the merge map and the board's owner
 * gate can act on. Recorded once per change, never once per tick. */
function observationTuple(observation: {
  readonly host: string;
  readonly project: string;
  readonly iid: number;
  readonly state: string;
  readonly headSha: string;
  readonly pipeline: { readonly id: number; readonly status: string } | null;
  readonly mergeCommitSha: string | null;
  readonly mergeable: string;
}): readonly unknown[] {
  return [
    normalizedHost(observation.host),
    observation.project.toLowerCase(),
    observation.iid,
    observation.state,
    observation.headSha,
    observation.pipeline?.id ?? null,
    observation.pipeline?.status ?? null,
    observation.mergeCommitSha,
    observation.mergeable,
  ];
}

function recordedTuple(event: EventRecord): readonly unknown[] | null {
  const observation = readGitLabMrObservation(event.payload);
  if (observation === null) return null;
  return observationTuple({
    host: observation.host,
    project: observation.project,
    iid: observation.iid,
    state: observation.state,
    headSha: observation.headSha,
    pipeline: observation.headPipeline === null
      ? null
      : { id: observation.headPipeline.id, status: observation.headPipeline.status },
    mergeCommitSha: observation.mergeCommitSha,
    mergeable: observation.mergeable,
  });
}

function readTuple(observed: GitLabMrObservedFacts): readonly unknown[] {
  return observationTuple({
    host: observed.host,
    project: observed.project,
    iid: observed.mr_iid,
    state: observed.state,
    headSha: observed.head_sha,
    pipeline: observed.head_pipeline === null
      ? null
      : { id: observed.head_pipeline.id, status: observed.head_pipeline.status },
    mergeCommitSha: observed.merge_commit_sha,
    mergeable: observed.mergeable,
  });
}

function sameTuple(next: readonly unknown[], previous: readonly unknown[]): boolean {
  return next.length === previous.length && next.every((value, index) => value === previous[index]);
}

/** The `error_kind` a recorded read failure names, or null. */
function recordedErrorKind(event: EventRecord | null): string | null {
  if (event === null || event.kind !== GITLAB_MR_READ_FAILED_EVENT) return null;
  const payload = event.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const kind = (payload as { error_kind?: unknown }).error_kind;
  return typeof kind === 'string' ? kind : null;
}

export class GitLabSignalPoll {
  private readonly ledger: GitLabPollLedger;
  private readonly resolveRemote: (repoPath: string) => RepoRemote | null;
  private readonly deps: GitLabMrReadDeps | undefined;
  private readonly deadlineMs: number;
  private readonly now: () => number;
  private readonly log: Log;
  /** Skip lines already logged, so an unreadable lane logs once per process
   * instead of once per tick. A log guard only; nothing depends on it. */
  private readonly loggedSkips = new Set<string>();

  constructor(opts: GitLabPollOptions) {
    this.ledger = opts.ledger;
    this.resolveRemote = opts.resolveRemote;
    this.deps = opts.deps;
    this.deadlineMs = opts.deadlineMs ?? GITLAB_POLL_TICK_DEADLINE_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
  }

  /**
   * One poll tick: read every tracked merge request once and record what
   * changed. The deadline and a rate limit end the tick early (loudly);
   * already-applied merges stay applied and the next tick re-reads.
   */
  async pollOnce(): Promise<GitLabPollTickResult> {
    const lanes = this.trackedLanes();
    const deadline = this.now() + this.deadlineMs;
    let reads = 0;
    let observed = 0;
    let merged = 0;
    let deadlineExceeded = false;
    let rateLimited = false;
    for (const lane of lanes) {
      if (this.now() >= deadline) {
        deadlineExceeded = true;
        this.log('warn', 'gitlab poll: per-tick deadline exceeded — remaining lanes defer to the next tick', {
          deadlineMs: this.deadlineMs,
          remaining: lanes.length - reads,
        });
        break;
      }
      const newest = this.newestGitLabEvent(lane.jobId);
      const previousObservation = newest !== null && newest.kind === GITLAB_MR_OBSERVED_EVENT ? newest : null;
      const previousTuple = previousObservation === null ? null : recordedTuple(previousObservation);
      const recordedAt = previousObservation === null ? null : Date.parse(previousObservation.ts);
      // Held in an object: the gates are consulted inside the reader, and the
      // poll reads the failure back for its rate-limit backoff and the facts
      // back for the merge decision (recorded or not).
      const read: { failure: GitLabMrReadFailure | null; facts: GitLabMrObservedFacts | null } = {
        failure: null,
        facts: null,
      };
      reads += 1;
      const recorded = await recordGitLabMrRead({
        ledger: this.ledger,
        jobId: lane.jobId,
        roundId: null,
        prUrl: lane.url,
        ...(this.deps !== undefined ? { deps: this.deps } : {}),
        origin: () => lane.origin,
        recordObservation: (facts) => {
          read.facts = facts;
          // A live success supersedes a recorded failure: otherwise one
          // transient error would keep the board's row withheld until the
          // observation aged out.
          if (newest !== null && newest.kind === GITLAB_MR_READ_FAILED_EVENT) return true;
          if (previousTuple === null || recordedAt === null) return true;
          if (!sameTuple(readTuple(facts), previousTuple)) return true;
          // An unchanged observation is re-recorded once it would otherwise
          // stop certifying owner readiness (the poll is proving it is live).
          return !Number.isFinite(recordedAt) || this.now() - recordedAt > GITLAB_EVIDENCE_MAX_AGE_MS;
        },
        recordFailure: (candidate) => {
          read.failure = candidate;
          return recordedErrorKind(newest) !== candidate.error_kind;
        },
        log: this.log,
      });
      if (read.failure !== null && read.failure.error_kind === 'rate-limit') {
        rateLimited = true;
        this.log('warn', 'gitlab poll: GitLab rate limit hit — remaining lanes defer to the next tick', {
          remaining: lanes.length - reads,
        });
        break;
      }
      if (recorded !== null && recorded.event.kind === GITLAB_MR_OBSERVED_EVENT) observed += 1;
      // The merge is decided from THIS read's facts, never from whether this
      // tick recorded them: a review round may have recorded the same merged
      // observation already, and the merge map's terminal no-op and binned
      // one-receipt guard make re-deciding it idempotent. A failed read has no
      // facts. An answer naming another project, iid or host never merges this
      // lane (the next tick re-reads).
      const facts = read.facts;
      if (facts === null || facts.state !== 'merged' || !sameIdentity(lane.link, facts)) continue;
      const outcome: MergeMapOutcome = applyMergedLane({
        ledger: this.ledger,
        log: this.log,
        eventKind: GITLAB_MR_MERGED_EVENT,
        jobId: lane.jobId,
        payload: mergePayload(facts, lane.url),
        logFields: {
          unknown: { job: lane.jobId },
          applied: { job: lane.jobId, host: facts.host, project: facts.project, mr_iid: facts.mr_iid },
          refused: { job: lane.jobId, host: facts.host, project: facts.project, mr_iid: facts.mr_iid },
        },
        logText: {
          unknown: 'gitlab poll: merged MR for an unknown job',
          applied: 'gitlab poll: MR merged, lane closed',
          refused: 'gitlab poll: merged MR could not close the lane',
        },
      });
      if (outcome === 'applied') merged += 1;
    }
    return { tracked: lanes.length, reads, observed, merged, deadlineExceeded, rateLimited };
  }

  /** The newest `gitlab.*` event for the job (observation or failure). */
  private newestGitLabEvent(jobId: string): EventRecord | null {
    const observed = this.ledger.latestJobEvent(jobId, GITLAB_MR_OBSERVED_EVENT);
    const failed = this.ledger.latestJobEvent(jobId, GITLAB_MR_READ_FAILED_EVENT);
    if (observed === null) return failed;
    if (failed === null) return observed;
    return failed.seq > observed.seq ? failed : observed;
  }

  /**
   * Every tracked merge request. A job is tracked when its status is live and
   * its recorded link is a supported GitLab merge request naming the origin
   * remote of the job's own lane — the only links a token is ever read for.
   */
  private trackedLanes(): readonly GitLabTrackedLane[] {
    const lanes: GitLabTrackedLane[] = [];
    const jobs = [...this.ledger.listJobs()].sort((a, b) => a.id.localeCompare(b.id));
    for (const job of jobs) {
      if (!TRACKABLE_STATUSES.has(job.status) || job.prUrl === null) continue;
      const parsed = parseGitLabMrLink(job.prUrl);
      // Not a GitLab MR link at all: the GitHub arm's business, not a skip.
      if (parsed === null) continue;
      if (parsed.kind !== 'supported') {
        this.noteSkip(job.id, 'unsupported-host', 'gitlab poll: merge request link is on a host no token goes to; not read', {
          job: job.id,
          url: job.prUrl,
        });
        continue;
      }
      const link: GitLabMrReadRequest = { host: parsed.host, project: parsed.project, iid: parsed.iid };
      const laneRecord = this.ledger
        .listWorktrees({ jobId: job.id })
        .find((candidate) => candidate.kind === 'job' && candidate.status !== 'swept');
      const origin = laneRecord === undefined ? null : this.resolveRemote(laneRecord.repoPath);
      const mismatch = originMismatch(link, origin);
      if (origin === null || mismatch !== null) {
        this.noteSkip(job.id, 'origin-mismatch', 'gitlab poll: merge request link is not the lane origin; not read', {
          job: job.id,
          host: link.host,
          project: link.project,
          mr_iid: link.iid,
          reason: mismatch,
        });
        continue;
      }
      lanes.push({
        jobId: job.id,
        link,
        origin,
        url: `https://${link.host}/${link.project}/-/merge_requests/${link.iid}`,
      });
    }
    return lanes;
  }

  private noteSkip(jobId: string, skip: GitLabLaneSkip, msg: string, fields: Record<string, unknown>): void {
    const key = `${skip}\u0000${jobId}`;
    if (this.loggedSkips.has(key)) return;
    this.loggedSkips.add(key);
    this.log('warn', msg, fields);
  }
}
