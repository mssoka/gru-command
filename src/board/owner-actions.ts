/**
 * Owner-action projection (FOR YOU board band, owner approval 2026-09-28):
 * the ONE evidence-bound derivation of "this PR/MR is genuinely ready for
 * the owner to review/merge" — computed server-side from durable ledger
 * state so every surface (board band, bell, future consumers) shares one
 * authoritative answer instead of a browser heuristic.
 *
 * Readiness is a CONJUNCTION of exact-head facts, each already durable:
 *   - the job is `in-review` with a recorded PR/MR URL (https only), and
 *     that URL parses as a change on a host this service supports;
 *   - an observation recorded for that same provider exists — for GitHub a
 *     `github.branch-state` whose `pr_url` is exactly the recorded PR, for
 *     GitLab the `gitlab.mr-observed` read a review round recorded (see
 *     below) — and its identity names the link's host/project/change;
 *   - that observation says the change is explicitly OPEN, NOT merged, and
 *     proved mergeable `clean` (conflicts, required gates, and an
 *     unproven/absent mergeability fail closed);
 *   - CI was observed GREEN at exactly the observed head sha (a carried
 *     forward conclusion for a moved head never qualifies);
 *   - the job's NEWEST review round is `verdict-posted` with verdict
 *     `approved` and its frozen `targetRef` equals that same sha — an
 *     approved round for an older head, an aborted or pending newer round,
 *     or `changes-requested` never qualifies.
 *
 * Anything missing, stale, moved, or failing renders NO row (fail closed).
 * Nothing here infers authority from PR titles, check names, or
 * notification prose: display data is never execution authority.
 *
 * Provider attribution comes from the job's own link, never from which
 * event happens to exist: a GitLab MR link is certified only by a GitLab
 * observation, a GitHub PR link only by a GitHub observation.
 *
 * GitLab freshness: a merge request is read once per review round and
 * nothing polls it (`docs/REVIEW-INPUTS.md` §2), so the newest `gitlab.*`
 * record for the job must be younger than `GITLAB_EVIDENCE_MAX_AGE_MS`.
 * That bound is evidence freshness, not owner escalation: the row simply
 * stops rendering, and the next round's read (or the bound) retires it.
 * A newer `gitlab.mr-read-failed` supersedes an older observation, exactly
 * as the freeze-time binding refuses to fall back to an older success.
 */

import {
  BRANCH_STATE_EVENT,
  parseGitHubPrUrl,
  readBranchState,
  type GitHubPollLedger,
  type NormalizedBranchState,
} from '../dispatch/github-poll.js';
import { parseGitLabMrLink } from '../dispatch/review-path.js';
import {
  GITLAB_MR_OBSERVED_EVENT,
  GITLAB_MR_READ_FAILED_EVENT,
  gitlabPipelineCiState,
  readGitLabMrObservation,
  type ChangeMergeability,
} from '../review-inputs/ci-evidence.js';

/** How old a GitLab observation may be and still certify readiness. A
 * merge request is read once per review round and never polled, so a read
 * older than this can no longer speak for a merge, close, or re-run that
 * happened since. Duration, never escalation: the row stops rendering. */
export const GITLAB_EVIDENCE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** The ledger slice the evidence reader needs (the engine's LedgerApi
 * satisfies it; tests inject a stub). */
export type BranchEvidenceLedger = Pick<GitHubPollLedger, 'latestJobEvent'>;

/** One durable branch-state observation plus WHEN it was recorded — the
 * projection surfaces the stamp so the row can age honestly. */
export interface BranchEvidence {
  readonly state: NormalizedBranchState;
  readonly checkedAt: string;
  readonly seq: number;
}

/** Read the job's newest branch-state evidence; null when none is
 * recorded (no PR observation ever landed for this job). */
export function readBranchEvidence(ledger: BranchEvidenceLedger, jobId: string): BranchEvidence | null {
  const event = ledger.latestJobEvent(jobId, BRANCH_STATE_EVENT);
  if (event === null) return null;
  const state = readBranchState(ledger, jobId);
  // An event whose payload cannot parse back is not evidence — fail
  // closed (the poll re-observes on its next tick anyway).
  if (state === null) return null;
  return { state, checkedAt: event.ts, seq: event.seq };
}

export type OwnerProvider = 'github' | 'gitlab';

/** Where the normalized evidence came from (honest attribution, not
 * inference: the row names the observation it rests on). */
export type OwnerEvidenceSourceKind = 'github.branch-state' | 'gitlab.mr-observed';

/** One change's durable observation, provider-agnostic: the only shape the
 * readiness gate reads. */
export interface OwnerEvidence {
  readonly provider: OwnerProvider;
  /** Canonical https URL of the observed change. */
  readonly changeUrl: string;
  readonly sha: string;
  readonly open: boolean;
  readonly merged: boolean;
  readonly mergeable: ChangeMergeability;
  readonly ci: { readonly sha: string; readonly status: 'green' | 'pending' | 'failed' } | null;
  /** ISO stamp of the observation the row rests on. */
  readonly observedAt: string;
  readonly sourceKind: OwnerEvidenceSourceKind;
  /** The recording event's ledger seq. Absent only from evidence built
   * without its event (`githubEvidence`, the parity constructor). */
  readonly sourceSeq?: number;
}

/** The job slice the readiness rule consumes (JobView satisfies it; the
 * shape is structural so tests build plain objects). */
export interface OwnerPrJob {
  readonly id: string;
  readonly repo: string;
  readonly title: string;
  readonly status: string;
  readonly prUrl: string | null;
  readonly rounds: readonly {
    readonly status: string;
    readonly verdict: string | null;
    readonly targetRef: string | null;
  }[];
}

/** One owner-ready PR row (the snapshot's `ownerPrs` entry). */
export interface OwnerPrView {
  /** Stable row/action id: `owner-pr:{jobId}`. */
  readonly id: string;
  readonly jobId: string;
  readonly jobTitle: string;
  readonly repo: string;
  /** https PR/MR URL — the OPEN target, never an in-app merge. */
  readonly prUrl: string;
  /** The exact head sha every piece of evidence is bound to. */
  readonly sha: string;
  /** ISO stamp of the observation the row rests on. */
  readonly checkedAt: string;
  /** The code host the evidence came from. */
  readonly provider: OwnerProvider;
}

/** Only https URLs may become an OPEN link (fail closed otherwise). */
export function isSafeHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** A recorded PR/MR link read as the change it names: the provider that
 * must have observed it, the identity its observation must repeat, and the
 * canonical URL an observation must describe. */
interface OwnerLink {
  readonly provider: OwnerProvider;
  readonly host: string;
  readonly project: string;
  readonly number: number;
  readonly url: string;
}

/** Parse the job's link with the shared provider parsers. A GitLab-shaped
 * link on an unsupported host (or any link neither parser accepts) names
 * no change this service can certify — no row, and no token anywhere. */
function ownerLink(prUrl: string): OwnerLink | null {
  const gitlab = parseGitLabMrLink(prUrl);
  if (gitlab !== null) {
    if (gitlab.kind !== 'supported') return null;
    return {
      provider: 'gitlab',
      host: gitlab.host,
      project: gitlab.project,
      number: gitlab.iid,
      url: `https://${gitlab.host}/${gitlab.project}/-/merge_requests/${gitlab.iid}`,
    };
  }
  const github = parseGitHubPrUrl(prUrl);
  if (github === null) return null;
  return {
    provider: 'github',
    host: github.host,
    project: `${github.owner}/${github.repo}`,
    number: github.number,
    url: `https://${github.host}/${github.owner}/${github.repo}/pull/${github.number}`,
  };
}

/** The GitHub observation normalized to the gate's shape. `clean` is the
 * poll's own `mergeable_state === 'clean'`; a null state (never observed
 * for this head) is `unknown`, anything else is `not-clean`. */
export function githubEvidence(state: NormalizedBranchState, checkedAt: string): OwnerEvidence {
  return {
    provider: 'github',
    changeUrl: state.prUrl ?? '',
    sha: state.sha ?? '',
    open: state.prOpen === true,
    merged: state.merged,
    mergeable: state.mergeableState === 'clean' ? 'clean' : state.mergeableState === null ? 'unknown' : 'not-clean',
    ci: state.ci === null ? null : { sha: state.ci.sha, status: state.ci.status },
    observedAt: checkedAt,
    sourceKind: 'github.branch-state',
  };
}

/** A GitLab MR's newest observation, normalized — but only while it is
 * fresh: the newest `mr-observed` or `mr-read-failed` by seq decides, and
 * a newer failure withholds rather than falling back to an older success. */
function readGitLabEvidence(
  ledger: BranchEvidenceLedger,
  jobId: string,
  link: OwnerLink,
  now: number,
): OwnerEvidence | null {
  const observed = ledger.latestJobEvent(jobId, GITLAB_MR_OBSERVED_EVENT);
  const failed = ledger.latestJobEvent(jobId, GITLAB_MR_READ_FAILED_EVENT);
  const newest = observed === null
    ? failed
    : failed === null || observed.seq > failed.seq ? observed : failed;
  if (newest === null) return null;
  const recordedAt = Date.parse(newest.ts);
  if (!Number.isFinite(recordedAt) || now - recordedAt > GITLAB_EVIDENCE_MAX_AGE_MS) return null;
  if (newest.kind !== GITLAB_MR_OBSERVED_EVENT) return null; // a newer failed read withholds
  const observation = readGitLabMrObservation(newest.payload);
  if (observation === null) return null;
  // Hosts compare case-insensitively (port included); project paths,
  // subgroups included, exactly; the MR iid exactly.
  if (
    observation.host.toLowerCase() !== link.host.toLowerCase() ||
    observation.project !== link.project ||
    observation.iid !== link.number
  ) {
    return null;
  }
  const pipeline = observation.headPipeline;
  const ciStatus = pipeline === null ? null : gitlabPipelineCiState(pipeline.status);
  return {
    provider: 'gitlab',
    changeUrl: link.url,
    sha: observation.headSha,
    open: observation.state === 'opened',
    merged: observation.state === 'merged',
    mergeable: observation.mergeable,
    ci: pipeline === null || ciStatus === null ? null : { sha: pipeline.sha, status: ciStatus },
    observedAt: newest.ts,
    sourceKind: 'gitlab.mr-observed',
    sourceSeq: newest.seq,
  };
}

/** Read the job's newest observation for the provider its link names.
 * Synchronous and ledger-only: a board snapshot never touches the network.
 * Null means no observation of that provider exists (fail closed). */
export function readOwnerEvidence(
  ledger: BranchEvidenceLedger,
  job: { readonly id: string; readonly prUrl: string | null },
  now: number,
): OwnerEvidence | null {
  if (job.prUrl === null) return null;
  const link = ownerLink(job.prUrl);
  if (link === null) return null;
  if (link.provider === 'gitlab') return readGitLabEvidence(ledger, job.id, link, now);
  const branch = readBranchEvidence(ledger, job.id);
  return branch === null ? null : { ...githubEvidence(branch.state, branch.checkedAt), sourceSeq: branch.seq };
}

/** CI counts as green-at-head only when observed at exactly that sha. */
function greenAtHead(ci: { readonly sha: string; readonly status: 'green' | 'pending' | 'failed' } | null, sha: string): boolean {
  return ci !== null && ci.sha === sha && ci.status === 'green';
}

/**
 * The one readiness gate. Returns the row when EVERY condition holds,
 * else null — a missing row is a fail-closed "not ready", never an
 * error. Callers render nothing rather than guessing.
 */
export function ownerReadyPr(job: OwnerPrJob, evidence: OwnerEvidence | null): OwnerPrView | null {
  if (job.status !== 'in-review') return null; // blocked/parked/working = holds or not staged
  const prUrl = job.prUrl;
  if (prUrl === null || !isSafeHttpsUrl(prUrl)) return null;
  const link = ownerLink(prUrl);
  if (link === null) return null; // no supported change behind the link
  if (evidence === null) return null; // no durable observation — fail closed
  if (evidence.provider !== link.provider) return null; // attribution must match the link
  if (evidence.changeUrl !== link.url) return null; // evidence describes another change
  if (evidence.merged) return null; // settled: only confirmed state clears
  if (!evidence.open) return null; // closed or status never observed — only an explicitly OPEN change qualifies
  const sha = evidence.sha;
  if (sha === '') return null;
  if (evidence.mergeable !== 'clean') return null; // conflicts/blocked/unproven
  if (!greenAtHead(evidence.ci, sha)) return null; // CI pending/failed/unobserved/moved head
  const round = job.rounds.at(-1) ?? null;
  if (round === null) return null;
  if (round.status !== 'verdict-posted' || round.verdict !== 'approved' || round.targetRef !== sha) {
    return null; // no head-bound approval as the newest verdict
  }
  return {
    id: `owner-pr:${job.id}`,
    jobId: job.id,
    jobTitle: job.title,
    repo: job.repo,
    prUrl,
    sha,
    checkedAt: evidence.observedAt,
    provider: evidence.provider,
  };
}
