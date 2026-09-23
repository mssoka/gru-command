/**
 * Board KPIs (board UX v4): the top-of-board strip — jobs by status, PRs,
 * lanes. Pure derivations over the live snapshot so counts can never
 * disagree with the cards below them, and so the math is unit-testable
 * without a DOM.
 */

import type { AgentView, BoardSnapshot, JobPrState, JobView } from './board-protocol.js';
import { isSameLocalDay } from './board-time.js';

export interface JobStatusCounts {
  readonly working: number;
  readonly inReview: number;
  readonly merged: number;
  readonly done: number;
  readonly parked: number;
  readonly total: number;
}

export interface PrCounts {
  readonly open: number;
  readonly conflicting: number;
  readonly mergedToday: number;
}

export interface LaneCounts {
  /** Live (non-disposed) agents of the minion role. */
  readonly liveMinions: number;
  /** Agents mid-turn right now (streaming). */
  readonly midTurn: number;
  /** Oldest quiet stamp among mid-turn agents (null = none). */
  readonly midTurnOldestAt: string | null;
  readonly disposed: number;
}

export interface BoardKpis {
  readonly jobs: JobStatusCounts;
  readonly prs: PrCounts;
  readonly lanes: LaneCounts;
}

/** Every job on the board, repo grouping flattened. */
export function collectJobs(snapshot: BoardSnapshot): readonly JobView[] {
  return snapshot.repos.flatMap((repo) => repo.jobs);
}

/** The PR state the board acts on: the wire field when a producer set it,
 * else derived (`merged` status ⇒ merged, a registered URL ⇒ open). */
export function derivedPrState(job: JobView): JobPrState | null {
  if (job.prState !== null && job.prState !== undefined) return job.prState;
  if (job.status === 'merged') return 'merged';
  if (job.prUrl !== null) return 'open';
  return null;
}

export function jobStatusCounts(jobs: readonly JobView[]): JobStatusCounts {
  const counts = { working: 0, inReview: 0, merged: 0, done: 0, parked: 0 };
  for (const job of jobs) {
    switch (job.status) {
      case 'working':
        counts.working += 1;
        break;
      case 'in-review':
        counts.inReview += 1;
        break;
      case 'merged':
        counts.merged += 1;
        break;
      case 'done':
        counts.done += 1;
        break;
      case 'parked':
        counts.parked += 1;
        break;
      default:
        break; // dispatched/delivered/blocked are real but not on this card
    }
  }
  return { ...counts, total: jobs.length };
}

export function prCounts(jobs: readonly JobView[], now = new Date()): PrCounts {
  let open = 0;
  let conflicting = 0;
  let mergedToday = 0;
  for (const job of jobs) {
    const state = derivedPrState(job);
    if (state === 'conflicting') conflicting += 1;
    else if (state === 'open') open += 1;
    else if (state === 'merged') {
      if (isSameLocalDay(job.updatedAt, now)) mergedToday += 1;
    }
  }
  return { open, conflicting, mergedToday };
}

export function laneCounts(agents: readonly AgentView[]): LaneCounts {
  const midTurn = agents.filter((agent) => agent.state === 'streaming');
  let oldest: string | null = null;
  for (const agent of midTurn) {
    const stamp = agent.lastActivity;
    if (stamp === null) continue;
    if (oldest === null || stamp < oldest) oldest = stamp;
  }
  return {
    liveMinions: agents.filter((agent) => agent.role === 'minion' && agent.state !== 'disposed').length,
    midTurn: midTurn.length,
    midTurnOldestAt: oldest,
    disposed: agents.filter((agent) => agent.state === 'disposed').length,
  };
}

export function boardKpis(snapshot: BoardSnapshot, now = new Date()): BoardKpis {
  return {
    jobs: jobStatusCounts(collectJobs(snapshot)),
    prs: prCounts(collectJobs(snapshot), now),
    lanes: laneCounts(snapshot.agents),
  };
}
