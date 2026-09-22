/**
 * Collapsed-card signals (v3): the ONE compact chip a collapsed job card
 * carries about its current review state and unacked action-required
 * notifications. Pure derivations keep the honesty rule testable without
 * a DOM: actionable state must survive the collapse.
 */

import type { BoardSnapshot, JobView, RoundView } from './board-protocol.js';

export interface RoundSummary {
  readonly done: number;
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
  return {
    done: round.lenses.filter((lens) => lens.state === 'done').length,
    total: round.lenses.length,
    blockers: round.blockers,
    failures: round.lenses.filter((lens) => lens.state === 'error').length,
  };
}

/**
 * Unacked action-required notifications attributed to jobs through the
 * rail's agent bindings (notifications carry an agent; agents carry the
 * job). A notification with no agent binding stays global — the tracker
 * chip above the board still counts it.
 */
export function unackedByJob(snapshot: BoardSnapshot): Map<string, number> {
  const jobByAgent = new Map<string, string>();
  for (const agent of snapshot.agents) {
    if (agent.jobId !== null) jobByAgent.set(agent.id, agent.jobId);
  }
  const byJob = new Map<string, number>();
  for (const notification of snapshot.notifications) {
    if (notification.routing !== 'action-required') continue;
    if (notification.ackedAt !== null || notification.resolvedAt !== null) continue;
    const agentId = notification.agentId;
    if (agentId === null) continue;
    const jobId = jobByAgent.get(agentId);
    if (jobId === undefined) continue;
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
 * verdict-posted round's verdict already carried its outcome; a merged or
 * finished job must not keep alarming from review history.
 */
export function jobSignal(job: JobView, unackedActionRequired: number): JobSignal | null {
  const parts: string[] = [];
  const details: string[] = [];
  let attention = false;

  if (unackedActionRequired > 0) {
    parts.push(`🔔 ${unackedActionRequired} action-required`);
    details.push(`${pluralCount(unackedActionRequired, 'notification')} awaiting ack`);
    attention = true;
  }

  const round = job.rounds.at(-1) ?? null;
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
      parts.push(`◉ round ${round.seq} · live · ${summary.done}/${summary.total}`);
      details.push(`round ${round.seq} live — ${summary.done}/${summary.total} lenses done`);
    } else if (round.status === 'pending') {
      parts.push(`○ round ${round.seq} pending`);
      details.push(`round ${round.seq} pending`);
    }
  }

  if (parts.length === 0) return null;
  const tone: JobSignal['tone'] = attention ? 'alert' : round?.status === 'live' ? 'work' : 'park';
  return { label: parts.join(' · '), tone, title: details.join(' · ') };
}
