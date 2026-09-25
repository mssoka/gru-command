/**
 * Status chip rail (board UX v6): the v4 health row RELOCATED to a
 * full-width rail under the command bar — one glance = whole-system
 * state, on every view (chat or board). Seven chips in a fixed order:
 * deploy, reviews, silas, alerts, verify, cure, trackers.
 *
 * The heist/PR/minion counts folded into the TRACKERS chip come from the
 * SAME `boardKpis` derivation the v4 KPI strip used, so the rail can
 * never disagree with the numbers it replaced. Each number carries its
 * v4 KPI key (`data-kpi`) — the rail's contract with the rest of the
 * board — and v6.1 gives every number its own visible field label (no
 * bare slash counters; owner ruling 5).
 */

import { healthCards, type HealthTone } from './board-health.js';
import { boardKpis } from './board-kpi.js';
import type { BoardSnapshot } from './board-protocol.js';
import { BOARD_WORDS } from './board-vocabulary.js';

export interface RailKpi {
  /** The v4 KPI key (e.g. `jobs.working`). */
  readonly kpi: string;
  readonly value: number;
  /** Visible field label rendered beside the number (owner ruling 5). */
  readonly label: string;
  readonly title: string;
}

export interface RailKpiGroup {
  readonly label: string;
  /** Optional headline number beside the label (jobs.total). */
  readonly total?: RailKpi;
  readonly values: readonly RailKpi[];
  /** Group tooltip; the visible labels carry the operator's reading. */
  readonly title: string;
}

export interface RailChip {
  readonly id: 'deploy' | 'reviews' | 'silas' | 'alerts' | 'verify' | 'cure' | 'trackers';
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone: HealthTone;
  readonly flag: string | null;
  readonly titleAttr: string;
  /** Folded KPI counts (TRACKERS only). */
  readonly kpis?: readonly RailKpiGroup[];
}

function kpi(key: string, value: number, label: string, title: string): RailKpi {
  return { kpi: key, value, label, title };
}

/** The whole rail, in fixed order derived from the health row. */
export function railChips(snapshot: BoardSnapshot, now = Date.now()): readonly RailChip[] {
  const kpis = boardKpis(snapshot, new Date(now));
  const cards = healthCards(snapshot, now);
  return cards
    .map(
      (card): RailChip => ({
        id: card.id,
        label: card.title.toUpperCase(),
        value: card.value,
        detail: card.detail,
        tone: card.tone,
        flag: card.flag,
        titleAttr: card.titleAttr,
      }),
    )
    .concat(trackersChip(snapshot, kpis));
}

function trackersChip(snapshot: BoardSnapshot, kpis: ReturnType<typeof boardKpis>): RailChip {
  const decisions = snapshot.decisions;
  const tone: HealthTone =
    snapshot.unackedActionRequired > 0
      ? 'alert'
      : decisions.status === 'ready'
        ? 'ok'
        : decisions.status === 'degraded'
          ? 'warn'
          : 'muted';
  return {
    id: 'trackers',
    label: 'TRACKERS',
    value: '',
    detail: `${snapshot.unackedActionRequired} action-required · Jev ${decisions.status}`,
    tone,
    flag: null,
    titleAttr: `Heists, PRs, and minions across the board · Jev decision routing: ${decisions.status}`,
    kpis: [
      {
        label: BOARD_WORDS.heists.toUpperCase(),
        total: kpi('jobs.total', kpis.jobs.total, 'total', `${kpis.jobs.total} heists on the board`),
        values: [
          kpi('jobs.working', kpis.jobs.working, 'working', `${kpis.jobs.working} working`),
          kpi('jobs.inReview', kpis.jobs.inReview, 'in review', `${kpis.jobs.inReview} in review`),
          kpi('jobs.merged', kpis.jobs.merged, 'merged', `${kpis.jobs.merged} merged`),
          kpi('jobs.done', kpis.jobs.done, 'done', `${kpis.jobs.done} done`),
          kpi('jobs.parked', kpis.jobs.parked, 'parked', `${kpis.jobs.parked} parked`),
        ],
        title: 'working / in-review / merged / done / parked',
      },
      {
        label: 'PRS',
        values: [
          kpi('prs.open', kpis.prs.open, 'open', `${kpis.prs.open} open`),
          kpi('prs.conflicting', kpis.prs.conflicting, 'conflicting', `${kpis.prs.conflicting} conflicting`),
          kpi('prs.mergedToday', kpis.prs.mergedToday, 'merged today', `${kpis.prs.mergedToday} merged today`),
        ],
        title: 'open / conflicting / merged today',
      },
      {
        label: 'MINIONS',
        values: [
          kpi('lanes.liveMinions', kpis.lanes.liveMinions, 'live', `${kpis.lanes.liveMinions} live minions`),
          kpi('lanes.midTurn', kpis.lanes.midTurn, 'mid-turn', `${kpis.lanes.midTurn} mid-turn`),
          kpi('lanes.disposed', kpis.lanes.disposed, 'disposed', `${kpis.lanes.disposed} disposed`),
        ],
        title: 'live minions / mid-turn / disposed',
      },
    ],
  };
}
