/**
 * Status derivation rail (board UX v7): the v4 health row + folded counts
 * rendered as the slim strip's status pairs and count groups (see
 * `board.ts` for the DOM). Seven chips in a fixed order: deploy, reviews,
 * silas, alerts, verify, cure, trackers.
 *
 * The heist/PR/minion counts folded into the TRACKERS chip come from the
 * SAME `boardKpis` derivation the v4 KPI strip used, so the strip can
 * never disagree with the numbers it replaced. Each number carries its
 * v4 KPI key (`data-kpi`) — the strip's contract with the rest of the
 * board — and v6.1's rule survives: every number has its own visible
 * field label (no bare slash counters; owner ruling 5). The presentation
 * splits (`valueSplit`/`flagSplit`) are reserved-slot hints only; `value`
 * keeps the exact derived string.
 */

import { healthCards, type FlagSplit, type HealthTone, type ValueSplit } from './board-health.js';
import { boardKpis } from './board-kpi.js';
import type { BoardSnapshot } from './board-protocol.js';
import { BOARD_WORDS, heistCount } from './board-vocabulary.js';

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
  /** Numeric-part split of `value` for the slim strip's reserved slot. */
  readonly valueSplit: ValueSplit;
  /** Numeric-part split of `flag`; null when there is no flag. */
  readonly flagSplit: FlagSplit | null;
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
        valueSplit: card.valueSplit,
        flagSplit: card.flagSplit,
      }),
    )
    .concat(trackersChip(snapshot, kpis));
}

function trackersChip(snapshot: BoardSnapshot, kpis: ReturnType<typeof boardKpis>): RailChip {
  const decisions = snapshot.decisions;
  // Issue #161: the CHILDREN group renders only when the server actually
  // reported counters — an absent field is unknown, never a verified zero.
  const childrenGroup: RailKpiGroup[] =
    kpis.children === null
      ? []
      : [
          {
            // Issue #161: children at a glance — present state plus the
            // LIFETIME count of logical child creations (restart-safe).
            label: 'CHILDREN',
            values: [
              kpi('children.active', kpis.children.active, 'active', `${kpis.children.active} child worker${kpis.children.active === 1 ? '' : 's'} active`),
              kpi('children.queued', kpis.children.queued, 'queued', `${kpis.children.queued} child worker${kpis.children.queued === 1 ? '' : 's'} queued`),
              kpi('children.finished', kpis.children.finished, 'finished', `${kpis.children.finished} child worker${kpis.children.finished === 1 ? '' : 's'} finished`),
              kpi('children.lifetimeCreations', kpis.children.lifetimeCreations, 'created', `${kpis.children.lifetimeCreations} logical child creation${kpis.children.lifetimeCreations === 1 ? '' : 's'} (lifetime)`),
            ],
            title: 'child workers active / queued / finished / created (lifetime logical creations)',
          },
        ];
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
    detail: `${snapshot.unackedActionRequired} needs Gru · Jev ${decisions.status}`,
    tone,
    flag: null,
    titleAttr: `Heists, PRs, and minions across the board · Jev decision routing: ${decisions.status}`,
    // Contract-complete RailChip: the trackers chip renders through the
    // groups (RailKpi numbers), so its value/flag carry no split.
    valueSplit: { lead: '', num: null, unit: '' },
    flagSplit: null,
    kpis: [
      {
        label: BOARD_WORDS.heists.toUpperCase(),
        total: kpi('jobs.total', kpis.jobs.total, 'total', `${heistCount(kpis.jobs.total)} on the board`),
        values: [
          kpi('jobs.working', kpis.jobs.working, 'working', `${kpis.jobs.working} working`),
          kpi('jobs.inReview', kpis.jobs.inReview, 'in review', `${kpis.jobs.inReview} in review`),
          kpi('jobs.merged', kpis.jobs.merged, 'merged', `${kpis.jobs.merged} merged`),
          kpi('jobs.done', kpis.jobs.done, 'done', `${kpis.jobs.done} done`),
          kpi('jobs.parked', kpis.jobs.parked, 'parked', `${kpis.jobs.parked} parked`),
          kpi('jobs.binned', kpis.jobs.binned, 'binned', `${kpis.jobs.binned} binned`),
        ],
        title: 'working / in-review / merged / done / parked / binned',
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
        label: BOARD_WORDS.crew.toUpperCase(),
        values: [
          kpi('lanes.liveMinions', kpis.lanes.liveMinions, 'minions', `${kpis.lanes.liveMinions} live minion${kpis.lanes.liveMinions === 1 ? '' : 's'}`),
          kpi('lanes.midTurn', kpis.lanes.midTurn, 'mid-turn', `${kpis.lanes.midTurn} mid-turn`),
          kpi('lanes.disposed', kpis.lanes.disposed, 'disposed', `${kpis.lanes.disposed} disposed`),
        ],
        title: 'live minions / crew mid-turn / crew disposed',
      },
      ...childrenGroup,
    ],
  };
}
