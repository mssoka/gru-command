/**
 * Collapsed-card signals (v3): the ONE compact chip a collapsed job card
 * carries about its current review state and unacked action-required
 * notifications. Pure derivations keep the honesty rule testable without
 * a DOM: actionable state must survive the collapse.
 */

import type { BoardSnapshot, JobView, RoundView } from './board-protocol.js';
import { isJobConcluded } from './board-bands.js';

export interface RoundSummary {
  readonly done: number;
  /** Lenses that actually ran (done minus "not used"). */
  readonly used: number;
  /** Lenses done as "not used" this round. */
  readonly unused: number;
  /** Lenses that RAN a specialist attempt, including ones that then failed:
   * used + lenses in error state with recorded attempts (R9/N8). An error
   * lens with no attempts (interrupted before spawn) did not run. */
  readonly ran: number;
  readonly total: number;
  readonly blockers: number;
  readonly failures: number;
}

export interface JobSignal {
  readonly label: string;
  readonly tone: 'alert' | 'work' | 'park';
  readonly title: string;
}

/** Done lenses / total, blocker verdicts, errored lenses for one round. */
export function roundSummary(round: RoundView): RoundSummary {
  // Whole-PR rounds: a lens the lead never used is done as "not used", not
  // as coverage. `used` counts lenses that actually ran; `unused` is shown
  // separately so a lead-only round never reads as 7/7 specialist coverage.
  // `ran` additionally counts lenses that RAN AND FAILED (R9): a specialist
  // that executed and errored is real work and must not vanish from the
  // "lenses ran" count — only error lenses WITHOUT any recorded attempt
  // (interrupted before spawn) stay excluded.
  const done = round.lenses.filter((lens) => lens.state === 'done');
  const unused = done.filter((lens) => lens.note !== null && lens.note.startsWith('not used')).length;
  const attemptsByLens = new Map(round.lensAttempts.map((entry) => [entry.lens, entry.attempts] as const));
  const failedRan = round.lenses.filter(
    (lens) => lens.state === 'error' && (attemptsByLens.get(lens.lens) ?? 0) > 0,
  ).length;
  return {
    done: done.length,
    used: done.length - unused,
    unused,
    ran: done.length - unused + failedRan,
    total: round.lenses.length,
    blockers: round.blockers,
    failures: round.lenses.filter((lens) => lens.state === 'error').length,
  };
}

/**
 * Unacked action-required notifications attributed to jobs through the
 * rail's agent bindings (notifications carry an agent; agents carry the
 * job). A notification with no agent binding stays global — the tracker
 * chip above the board still counts it. Rows bound to a TERMINAL job
 * (merged/done) are closed receipts: they never attribute to the banded
 * view (the bell keeps them; machine-row lifecycle stays with
 * dispositions) so a merged lane can never re-enter NEEDS YOU through a
 * leftover escalation.
 */
export function unackedByJob(snapshot: BoardSnapshot): Map<string, number> {
  const jobByAgent = new Map<string, string>();
  for (const agent of snapshot.agents) {
    if (agent.jobId !== null) jobByAgent.set(agent.id, agent.jobId);
  }
  const terminalJobs = new Set<string>();
  for (const repo of snapshot.repos) {
    for (const job of repo.jobs) {
      if (isJobConcluded(job.status)) terminalJobs.add(job.id);
    }
  }
  const byJob = new Map<string, number>();
  for (const notification of snapshot.notifications) {
    if (notification.routing !== 'action-required') continue;
    if (notification.ackedAt !== null || notification.resolvedAt !== null) continue;
    const agentId = notification.agentId;
    if (agentId === null) continue;
    const jobId = jobByAgent.get(agentId);
    if (jobId === undefined || terminalJobs.has(jobId)) continue;
    byJob.set(jobId, (byJob.get(jobId) ?? 0) + 1);
  }
  return byJob;
}

export function pluralCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The collapsed card's single compact chip, in priority order: unacked
 * notifications → the newest round's failure/attention state → the newest
 * round's liveness. The newest round IS the job's current review state
 * (older rounds are history; their detail survives in the expanded card).
 * A closed, clean job yields null — no chip.
 *
 * Attention is scoped to the round the operator can still act on: a live
 * or pending round's blockers/errored lenses, or an aborted round. A
 * verdict-posted round's verdict already carried its outcome.
 *
 * v5: a merged/done card also suppresses REVIEW LIVENESS pills ("round N
 * live/pending") — a concluded job cannot have a review in flight; the
 * pill is stale data, not a live state.
 *
 * Section-truth ruling (2026-09-29): a CONCLUDED card is a closed
 * receipt — it renders NO pills at all. Attention pills explained why a
 * concluded card landed in NEEDS YOU; terminal jobs can no longer land
 * there (the banding enforces it), so the pills would be false alarms,
 * never live queue entries.
 */
export function jobSignal(job: JobView, unackedActionRequired: number): JobSignal | null {
  if (isJobConcluded(job.status)) return null;
  const parts: string[] = [];
  const details: string[] = [];
  let attention = false;

  if (unackedActionRequired > 0) {
    parts.push(`🛠 ${unackedActionRequired} needs Gru`);
    details.push(`${pluralCount(unackedActionRequired, 'machine-attention notification')} awaiting Gru disposition`);
    attention = true;
  }

  const round = job.rounds.at(-1) ?? null;
  // A concluded job never reaches here (closed receipts render no pill);
  // in-flight cards keep their review liveness pills.
  if (round !== null) {
    const summary = roundSummary(round);
    if (round.status === 'aborted') {
      parts.push(`⛔ round ${round.seq} aborted`);
      details.push(`round ${round.seq} aborted`);
      attention = true;
    } else if (round.status !== 'verdict-posted') {
      if (summary.blockers > 0) {
        parts.push(`⛔ ${pluralCount(summary.blockers, 'blocker')}`);
        details.push(`round ${round.seq}: ${pluralCount(summary.blockers, 'blocker')}`);
        attention = true;
      }
      if (summary.failures > 0) {
        parts.push(`✕ ${pluralCount(summary.failures, 'lens failure')}`);
        details.push(`round ${round.seq}: ${pluralCount(summary.failures, 'lens failure')}`);
        attention = true;
      }
    }
    if (round.status === 'live') {
      // Settled progress: an errored lens will not run again, so it
      // counts toward the terminal progress, never as outstanding work.
      const settled = summary.done + summary.failures;
      parts.push(`◉ round ${round.seq} · live · ${settled}/${summary.total}`);
      details.push(`round ${round.seq} live — ${settled}/${summary.total} lenses settled`);
    } else if (round.status === 'pending') {
      parts.push(`○ round ${round.seq} pending`);
      details.push(`round ${round.seq} pending`);
    }
  }

  if (parts.length === 0) return null;
  const tone: JobSignal['tone'] = attention ? 'alert' : round?.status === 'live' ? 'work' : 'park';
  return { label: parts.join(' · '), tone, title: details.join(' · ') };
}
