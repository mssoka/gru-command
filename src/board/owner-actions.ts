/**
 * Owner-action projection (FOR YOU board band, owner approval 2026-09-28):
 * the ONE evidence-bound derivation of "this PR is genuinely ready for
 * the owner to review/merge" — computed server-side from durable ledger
 * state so every surface (board band, bell, future consumers) shares one
 * authoritative answer instead of a browser heuristic.
 *
 * Readiness is a CONJUNCTION of exact-head facts, each already durable:
 *   - the job is `in-review` with a recorded PR URL (https only);
 *   - a `github.branch-state` observation exists for the job whose
 *     `pr_url` is EXACTLY the recorded PR (no ambiguity about which pull
 *     the evidence describes);
 *   - that observation says the PR is explicitly OPEN (`pr_open` true),
 *     NOT merged, and mergeable_state is
 *     `clean` (not dirty/blocked/unknown/unstable — conflicts and
 *     required-gate blocks fail closed; a closed-without-merge pull is
 *     not an open obligation no matter what older evidence said);
 *   - CI was observed GREEN at exactly the branch-state sha (a carried
 *     forward conclusion for a moved head never qualifies);
 *   - the job's NEWEST review round is `verdict-posted` with verdict
 *     `approved` and its frozen `targetRef` equals that same sha — an
 *     approved round for an older head, an aborted or pending newer
 *     round, or `changes-requested` never qualifies.
 *
 * Anything missing, stale, moved, or failing renders NO row (fail
 * closed). Nothing here infers authority from PR titles, check names, or
 * notification prose: display data is never execution authority.
 */

import {
  BRANCH_STATE_EVENT,
  readBranchState,
  type CiState,
  type GitHubPollLedger,
  type NormalizedBranchState,
} from '../dispatch/github-poll.js';

/** The ledger slice the evidence reader needs (the engine's LedgerApi
 * satisfies it; tests inject a stub). */
export type BranchEvidenceLedger = Pick<GitHubPollLedger, 'latestJobEvent'>;

/** One durable branch-state observation plus WHEN it was recorded — the
 * projection surfaces the stamp so the row can age honestly. */
export interface BranchEvidence {
  readonly state: NormalizedBranchState;
  readonly checkedAt: string;
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
  return { state, checkedAt: event.ts };
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
  /** https PR URL — the OPEN PR target, never an in-app merge. */
  readonly prUrl: string;
  /** The exact head sha every piece of evidence is bound to. */
  readonly sha: string;
  /** ISO stamp of the branch-state observation the row rests on. */
  readonly checkedAt: string;
}

/** Only https URLs may become an OPEN PR link (fail closed otherwise). */
export function isSafeHttpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** CI counts as green-at-head only when observed at exactly that sha. */
function greenAtHead(ci: CiState | null, sha: string): boolean {
  return ci !== null && ci.sha === sha && ci.status === 'green';
}

/**
 * The one readiness gate. Returns the row when EVERY condition holds,
 * else null — a missing row is a fail-closed "not ready", never an
 * error. Callers render nothing rather than guessing.
 */
export function ownerReadyPr(job: OwnerPrJob, evidence: BranchEvidence | null): OwnerPrView | null {
  if (job.status !== 'in-review') return null; // blocked/parked/working = holds or not staged
  const prUrl = job.prUrl;
  if (prUrl === null || !isSafeHttpsUrl(prUrl)) return null;
  if (evidence === null) return null; // no durable PR observation — fail closed
  const { state, checkedAt } = evidence;
  if (state.prUrl === null || state.prUrl !== prUrl) return null; // evidence describes another PR
  if (state.merged) return null; // settled: only confirmed state clears
  if (state.prOpen !== true) return null; // closed (unmerged) or status never observed — only an explicitly OPEN pull may be OPEN-PR'd (fail closed)
  const sha = state.sha;
  if (sha === null || sha === '') return null;
  if (state.mergeableState !== 'clean') return null; // dirty/blocked/unknown/unstable
  if (!greenAtHead(state.ci, sha)) return null; // CI pending/failed/unobserved/moved head
  const round = job.rounds.at(-1) ?? null;
  if (round === null) return null;
  if (round.status !== 'verdict-posted' || round.verdict !== 'approved' || round.targetRef !== sha) {
    return null; // no head-bound approval as the newest verdict
  }
  return { id: `owner-pr:${job.id}`, jobId: job.id, jobTitle: job.title, repo: job.repo, prUrl, sha, checkedAt };
}
