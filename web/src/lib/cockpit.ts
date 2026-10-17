/**
 * Cockpit (owner-approved rework, 2026-10-17): the command bar's health
 * pill and the six KPI cards at the top of the board column. They replace
 * the slim status strip and read the SAME derivations it did — the health
 * cards, the board KPIs, the review counts and the job families — so a
 * card can never disagree with the rows below it. Every number keeps its
 * `data-kpi` key. Pure, so the math is unit-testable without a DOM.
 */

import { isLiveMegaminion } from './board-family.js';
import { alertsCard, healthCards, reviewCounts, type HealthCardView, type HealthTone } from './board-health.js';
import { boardKpis, collectJobs } from './board-kpi.js';
import type { BoardSnapshot, JobView } from './board-protocol.js';
import { snapshotSections } from './board-sections.js';
import { pluralCount } from './board-signals.js';
import { BOARD_WORDS, heistCount } from './board-vocabulary.js';
import { topReviewRound } from './command-ticker.js';

// ── Health pill ─────────────────────────────────────────────────────

/** The system checks the pill carries, in the strip's old order. REVIEWS
 * moved to its own card and ALERTS (NEEDS GRU) to the attention card. */
const HEALTH_IDS: readonly HealthCardView['id'][] = ['deploy', 'silas', 'verify', 'disk', 'cure'];

export interface HealthPart {
  readonly id: HealthCardView['id'];
  /** `deploy current`, `disk 34.2 GB` — the check's name and its value. */
  readonly text: string;
  readonly flag: string | null;
  readonly tone: HealthTone;
  readonly title: string;
}

export interface HealthPill {
  /** True when at least one check is a warning or an alert. */
  readonly attention: boolean;
  /** `2 need a look`; `All healthy` when every wired check is fine;
   * `Checks not wired` when none is wired — unknown never reads healthy. */
  readonly summary: string;
  /** Checks that need a look first, then the rest; a check whose source is
   * not wired (`n/a`) stays out of the visible text and in the title. */
  readonly parts: readonly HealthPart[];
  /** Every check's long explanation, one per line. */
  readonly title: string;
}

const needsLook = (tone: HealthTone): boolean => tone === 'alert' || tone === 'warn';

export function healthPill(snapshot: BoardSnapshot, now = Date.now()): HealthPill {
  const cards = healthCards(snapshot, now).filter((card) => HEALTH_IDS.includes(card.id));
  const problems = cards.filter((card) => needsLook(card.tone));
  const ordered = [...problems, ...cards.filter((card) => !needsLook(card.tone) && card.value !== 'n/a')];
  return {
    attention: problems.length > 0,
    summary: problems.length > 0
      ? `${problems.length} need${problems.length === 1 ? 's' : ''} a look`
      : ordered.length === 0 ? 'Checks not wired' : 'All healthy',
    parts: ordered.map((card) => ({
      id: card.id,
      text: `${card.title} ${card.value}`,
      flag: card.flag,
      tone: card.tone,
      title: card.titleAttr,
    })),
    title: cards.map((card) => `${card.title}: ${card.value} — ${card.titleAttr}`).join('\n'),
  };
}

// ── KPI cards ───────────────────────────────────────────────────────

export interface CockpitFact {
  /** The strip's KPI key (`jobs.working`), kept as the number's identity. */
  readonly kpi: string;
  readonly value: number;
  readonly label: string;
  readonly title: string;
  /** A non-zero count that needs attention (conflicting PRs, failed rounds). */
  readonly alert: boolean;
}

export interface CockpitCard {
  readonly id: 'heists' | 'megaminions' | 'crew' | 'prs' | 'reviews' | 'raids';
  readonly label: string;
  /** Short context beside the label (`round 3 live`). */
  readonly aside: string | null;
  /** The aside's long form for the tooltip; null = the aside says it all. */
  readonly asideTitle?: string | null;
  /** The headline number with its unit; `off` for raids that are off. */
  readonly headline: { readonly kpi: string | null; readonly value: string; readonly unit: string; readonly title: string };
  readonly facts: readonly CockpitFact[];
  /** Text facts without a count (`across 2 heists`). */
  readonly notes: readonly string[];
  /** HEISTS only: the stages toward done, for the stage bar. */
  readonly flow: readonly { readonly stage: 'working' | 'in-review' | 'merged' | 'done'; readonly value: number }[] | null;
  /** Dashed card: the feature is off. */
  readonly off: boolean;
}

function fact(kpi: string, value: number, label: string, title: string, alert = false): CockpitFact {
  return { kpi, value, label, title, alert: alert && value > 0 };
}

/** Every megaminion on the board: nested under its heist, or surfaced
 * top-level by an exception (it still counts as one). */
function megaminions(sections: ReturnType<typeof snapshotSections>): readonly { readonly job: JobView; readonly parentId: string }[] {
  const nested = [...sections.children].flatMap(([parentId, entries]) => entries.map((entry) => ({ job: entry.job, parentId })));
  const surfaced = [...sections.surfacedParents].flatMap(([id, parent]) => {
    const job = sections.topLevel.find((row) => row.id === id);
    return job === undefined ? [] : [{ job, parentId: parent.id }];
  });
  return [...nested, ...surfaced];
}

export function cockpitCards(snapshot: BoardSnapshot, now = Date.now()): readonly CockpitCard[] {
  const sections = snapshotSections(snapshot, now);
  // HEISTS counts the board's own top-level rows (one derivation with the
  // sections): nested megaminions ride their heist, surfaced ones count.
  const kpis = boardKpis(snapshot, new Date(now), sections.topLevel);
  const jobs = kpis.jobs;
  const reviews = reviewCounts(collectJobs(snapshot), new Date(now));
  const round = topReviewRound(snapshot);
  const family = megaminions(sections);
  const liveMega = family.filter((entry) => isLiveMegaminion(entry.job)).length;
  const parents = new Set(family.map((entry) => entry.parentId)).size;
  const children = kpis.children;
  const cards: CockpitCard[] = [
    {
      id: 'heists',
      label: BOARD_WORDS.heists.toUpperCase(),
      aside: null,
      headline: { kpi: 'jobs.total', value: String(jobs.total), unit: 'on the board', title: `${heistCount(jobs.total)} on the board` },
      facts: [
        fact('jobs.working', jobs.working, 'working', `${jobs.working} working`),
        fact('jobs.inReview', jobs.inReview, 'in review', `${jobs.inReview} in review`),
        fact('jobs.merged', jobs.merged, 'merged', `${jobs.merged} merged`),
        fact('jobs.done', jobs.done, 'done', `${jobs.done} done`),
        fact('jobs.parked', jobs.parked, 'parked', `${jobs.parked} parked`),
        fact('jobs.binned', jobs.binned, 'binned', `${jobs.binned} binned`),
      ],
      notes: [],
      flow: [
        { stage: 'working', value: jobs.working },
        { stage: 'in-review', value: jobs.inReview },
        { stage: 'merged', value: jobs.merged },
        { stage: 'done', value: jobs.done },
      ],
      off: false,
    },
    {
      id: 'megaminions',
      label: BOARD_WORDS.megaminions.toUpperCase(),
      aside: null,
      headline: { kpi: 'megaminions.live', value: String(liveMega), unit: 'live', title: `${liveMega} live ${liveMega === 1 ? BOARD_WORDS.megaminion : BOARD_WORDS.megaminions}` },
      facts: family.length === 0 ? [] : [fact('megaminions.finished', family.length - liveMega, 'finished', `${family.length - liveMega} finished (delivered, done, merged or binned)`)],
      notes: family.length === 0 ? ['none commissioned'] : [`across ${heistCount(parents)}`],
      flow: null,
      off: false,
    },
    {
      id: 'crew',
      label: BOARD_WORDS.crew.toUpperCase(),
      aside: null,
      headline: { kpi: 'lanes.liveMinions', value: String(kpis.lanes.liveMinions), unit: kpis.lanes.liveMinions === 1 ? BOARD_WORDS.minion : `${BOARD_WORDS.minion}s`, title: `${kpis.lanes.liveMinions} live ${kpis.lanes.liveMinions === 1 ? 'minion' : 'minions'}` },
      facts: [
        fact('lanes.midTurn', kpis.lanes.midTurn, 'mid-turn', `${kpis.lanes.midTurn} mid-turn`),
        fact('lanes.disposed', kpis.lanes.disposed, 'disposed', `${kpis.lanes.disposed} disposed`),
        // Issue #161: sub-minions only when the server reported counters —
        // an absent block is unknown, never a verified zero.
        ...(children === null
          ? []
          : [fact('children.active', children.active, children.active === 1 ? 'sub-minion' : 'sub-minions',
            `${pluralCount(children.active, 'sub-minion')} active · ${children.queued} queued · ${children.finished} finished · ${children.lifetimeCreations} created (lifetime logical creations)`)]),
      ],
      notes: children !== null && children.queued > 0 ? [`+${children.queued} queued`] : [],
      flow: null,
      off: false,
    },
    {
      id: 'prs',
      label: 'PRS',
      aside: null,
      headline: { kpi: 'prs.open', value: String(kpis.prs.open), unit: 'open', title: `${kpis.prs.open} open` },
      facts: [
        fact('prs.conflicting', kpis.prs.conflicting, 'conflicting', `${kpis.prs.conflicting} conflicting`, true),
        fact('prs.mergedToday', kpis.prs.mergedToday, 'merged today', `${kpis.prs.mergedToday} merged today`),
      ],
      notes: [],
      flow: null,
      off: false,
    },
    {
      id: 'reviews',
      label: 'REVIEWS',
      aside: round === null ? 'no round live' : `round ${round.seq} ${round.status}`,
      headline: { kpi: 'reviews.active', value: String(reviews.active), unit: reviews.active === 1 ? 'round active' : 'rounds active', title: `${reviews.active} review round(s) live or pending` },
      facts: [
        fact('reviews.verdictsToday', reviews.verdictsToday, reviews.verdictsToday === 1 ? 'verdict today' : 'verdicts today', `${pluralCount(reviews.verdictsToday, 'verdict')} posted today`),
        fact('reviews.failedToday', reviews.failedToday, 'failed today', `${reviews.failedToday} round(s) aborted today`, true),
      ],
      notes: [],
      flow: null,
      off: false,
    },
  ];
  const raids = raidsCard(snapshot);
  if (raids !== null) cards.push(raids);
  return cards;
}

/** #351: the raids card, only when the server sent its block (an older
 * server's board shows no card rather than zeros). */
function raidsCard(snapshot: BoardSnapshot): CockpitCard | null {
  const vector = snapshot.vector ?? null;
  if (vector === null) return null;
  if (!vector.enabled) {
    return {
      id: 'raids',
      label: 'VECTOR RAIDS',
      aside: null,
      headline: { kpi: null, value: 'off', unit: 'spends quota', title: 'Vector raids are off. Raids spend quota, so each install opts in.' },
      facts: [],
      notes: ['opt in: [vector] enabled = true'],
      flow: null,
      off: true,
    };
  }
  const [current, ...others] = vector.running;
  const running = current === undefined
    ? []
    : [`${current.repo} ${current.packageDir} · attack ${Math.min(current.roundsDone + 1, current.maxRounds)}/${current.maxRounds}`];
  // The cap is per repository: the aside shows the busiest one's use.
  const [busiest] = vector.capUse;
  return {
    id: 'raids',
    label: 'VECTOR RAIDS',
    aside: `${busiest?.used ?? 0}/${vector.maxRaidsPerDay} today`,
    headline: { kpi: 'vector.running', value: String(vector.running.length), unit: 'running', title: `${vector.running.length} raid(s) running` },
    facts: [
      fact('vector.proposed', vector.proposed, 'awaiting you', `${pluralCount(vector.proposed, 'raid')} waiting for you in FOR YOU`),
      fact('vector.queued', vector.queued, 'queued', `${pluralCount(vector.queued, 'raid')} in Silas's raid queue`),
      fact('vector.fixesAwaitingOwner', vector.fixesAwaitingOwner, vector.fixesAwaitingOwner === 1 ? 'fix awaiting you' : 'fixes awaiting you', `${pluralCount(vector.fixesAwaitingOwner, 'break-in')} whose fix card waits for you`, true),
      fact('vector.breakIns', vector.breakIns, vector.breakIns === 1 ? 'break-in' : 'break-ins', `${pluralCount(vector.breakIns, 'break-in')} confirmed so far`),
    ],
    notes: [...running, ...(others.length > 0 ? [`+${others.length} more running`] : [])],
    flow: null,
    off: false,
    asideTitle: busiest === undefined
      ? `No repository has used any of its daily cap of ${pluralCount(vector.maxRaidsPerDay, 'raid')}.`
      : vector.capUse.map((entry) => `${entry.repo}: ${entry.used} of ${vector.maxRaidsPerDay} raids in the last 24 hours`).join('\n') + ' (the cap is per repository)',
  };
}

/** The attention card's line about Gru's own queue (NEEDS GRU, the live
 * machine count the strip's ALERTS pair used to carry), with that pair's
 * long explanation as its title. */
export function gruQueueLine(unackedActionRequired: number): { readonly text: string; readonly title: string } {
  return {
    text: unackedActionRequired === 0
      ? 'nothing needs Gru either · the crew is on it'
      : `Gru is handling ${unackedActionRequired} more in FOR GRU`,
    title: alertsCard(unackedActionRequired).titleAttr,
  };
}
