/**
 * Status chip rail (board UX v6): the v4 health row RELOCATED to a
 * full-width rail under the command bar — one glance = whole-system
 * state, on every view (chat or board). Seven chips in a fixed order:
 * deploy, reviews, silas, alerts, verify, cure, trackers.
 *
 * The jobs/PRs/lane counts folded in here come from the SAME `boardKpis`
 * derivation the v4 KPI strip used, so the rail can never disagree with
 * the numbers it replaced. Each sub-badge carries its KPI key
 * (`data-kpi`) — the rail's contract with the rest of the board.
 */

import { healthCards, type HealthTone } from './board-health.js';
import { boardKpis } from './board-kpi.js';
import type { BoardSnapshot } from './board-protocol.js';
import { pluralCount } from './board-signals.js';

export interface RailSubBadge {
  /** The v4 KPI value this badge renders (e.g. `jobs.working`). */
  readonly kpi: string;
  readonly label: string;
  readonly tone: 'plain' | 'alert' | 'warn';
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
  readonly subs: readonly RailSubBadge[];
}

function sub(kpi: string, value: number, noun: string, title: string, tone: RailSubBadge['tone'] = 'plain'): RailSubBadge {
  return { kpi, label: `${value} ${noun}`, tone, title };
}

/** The whole rail, in fixed order derived from the health row. */
export function railChips(snapshot: BoardSnapshot, now = Date.now()): readonly RailChip[] {
  const kpis = boardKpis(snapshot, new Date(now));
  const cards = healthCards(snapshot, now);
  return cards.map((card): RailChip => {
    const base = {
      id: card.id,
      label: card.title.toUpperCase(),
      value: card.value,
      detail: card.detail,
      tone: card.tone,
      flag: card.flag,
      titleAttr: card.titleAttr,
    };
    switch (card.id) {
      case 'reviews':
        // The jobs counts live with reviews: work only matters while the
        // review engine is watching it.
        return {
          ...base,
          subs: [
            sub('jobs.total', kpis.jobs.total, 'jobs', `${pluralCount(kpis.jobs.total, 'job')} on the board`),
            sub('jobs.working', kpis.jobs.working, 'working', `${pluralCount(kpis.jobs.working, 'job')} working`),
            sub('jobs.inReview', kpis.jobs.inReview, 'in-review', `${pluralCount(kpis.jobs.inReview, 'job')} in review`),
          ],
        };
      case 'alerts':
        // PR state is incident-adjacent: a conflicting PR is the loud one.
        return {
          ...base,
          subs: [
            sub('prs.open', kpis.prs.open, 'open PRs', `${pluralCount(kpis.prs.open, 'open PR')}`),
            sub(
              'prs.conflicting',
              kpis.prs.conflicting,
              'conflicting',
              `${pluralCount(kpis.prs.conflicting, 'conflicting PR')}`,
              kpis.prs.conflicting > 0 ? 'alert' : 'plain',
            ),
            sub('prs.mergedToday', kpis.prs.mergedToday, 'merged today', `${pluralCount(kpis.prs.mergedToday, 'PR')} merged today`),
          ],
        };
      default:
        return { ...base, subs: [] };
    }
  }).concat(trackersChip(snapshot, kpis));
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
    value: `JOBS ${kpis.jobs.total}`,
    detail: `${pluralCount(snapshot.unackedActionRequired, 'action-required')} · Jev ${decisions.status}`,
    tone,
    flag: snapshot.unackedActionRequired > 0 ? `${snapshot.unackedActionRequired} ACK` : null,
    titleAttr: `Jobs by status, PRs, and lanes across the board · Jev decision routing: ${decisions.status}`,
    subs: [
      sub('jobs.merged', kpis.jobs.merged, 'merged', `${pluralCount(kpis.jobs.merged, 'merged job')}`),
      sub('jobs.done', kpis.jobs.done, 'done', `${pluralCount(kpis.jobs.done, 'done job')}`),
      sub('jobs.parked', kpis.jobs.parked, 'parked', `${pluralCount(kpis.jobs.parked, 'parked job')}`),
      sub('lanes.liveMinions', kpis.lanes.liveMinions, 'live minions', `${pluralCount(kpis.lanes.liveMinions, 'live minion')}`),
      sub('lanes.midTurn', kpis.lanes.midTurn, 'mid-turn', `${pluralCount(kpis.lanes.midTurn, 'agent')} mid-turn`),
      sub('lanes.disposed', kpis.lanes.disposed, 'disposed', `${pluralCount(kpis.lanes.disposed, 'disposed lane')}`),
    ],
  };
}
