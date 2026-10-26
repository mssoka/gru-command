/**
 * Cockpit (owner-approved rework, 2026-10-17): the command bar's health
 * pill and the six KPI cards at the top of the board column. They replace
 * the slim status strip and read the SAME derivations it did — the health
 * cards, the board KPIs, the review counts and the board's own sections —
 * so a card can never disagree with the rows below it. Every count keeps a
 * `data-kpi` key; context notes (`across 2 heists`, a raid's attack) are
 * text. Pure, so the math is unit-testable without a DOM.
 */

import { isLiveMegaminion } from './board-family.js';
import { alertsCard, healthCards, reviewCounts, type HealthCardView, type HealthTone } from './board-health.js';
import { boardKpis, collectJobs } from './board-kpi.js';
import type { BoardSnapshot } from './board-protocol.js';
import { snapshotSections, type BoardSections } from './board-sections.js';
import { pluralCount } from './board-signals.js';
import { BOARD_WORDS, heistCount } from './board-vocabulary.js';
import { topReviewRound } from './command-ticker.js';

// ── Health pill ─────────────────────────────────────────────────────

/** Where every health card lands. Exhaustive, so a new check is a compile
 * error until someone decides its place: REVIEWS has its own card and
 * ALERTS (NEEDS GRU) rides the attention card's Gru line. */
const HEALTH_PLACEMENT: Readonly<Record<HealthCardView['id'], 'pill' | 'elsewhere'>> = {
  deploy: 'pill',
  reviews: 'elsewhere',
  silas: 'pill',
  alerts: 'elsewhere',
  verify: 'pill',
  disk: 'pill',
  cure: 'pill',
};

export interface HealthPart {
  readonly id: HealthCardView['id'];
  /** `deploy current`, `disk 34.2 GB` — the check's name and its value. */
  readonly text: string;
  readonly flag: string | null;
  readonly tone: HealthTone;
  /** A warning, an alert, or any check carrying a flag (`1 QUEUED`). */
  readonly problem: boolean;
  readonly title: string;
}

export interface HealthPill {
  /** attention: something needs a look; healthy: at least one wired check
   * reads ok and none needs a look; quiet: wired checks only report
   * neutral facts (no wakes yet, disk still walking); unwired: no check is
   * wired. Unknown never reads healthy. */
  readonly state: 'attention' | 'healthy' | 'quiet' | 'unwired';
  /** The snapshot is last-known (the board socket is stale or down, or the
   * board is unavailable): the summary says so and never claims calm. */
  readonly lastKnown: boolean;
  /** `2 need a look`, `All healthy`, `No problems reported`, `Checks not
   * wired` — prefixed `last-known · ` on a last-known snapshot. */
  readonly summary: string;
  /** Checks that need a look first, then the rest; a check whose source is
   * not wired (`n/a`) stays out of the visible text and in the title. */
  readonly parts: readonly HealthPart[];
  /** Every check's long explanation, one per line. */
  readonly title: string;
}

const needsLook = (card: HealthCardView): boolean => card.tone === 'alert' || card.tone === 'warn' || card.flag !== null;

export function healthPill(snapshot: BoardSnapshot, now = Date.now(), lastKnown = false): HealthPill {
  const cards = healthCards(snapshot, now).filter((card) => HEALTH_PLACEMENT[card.id] === 'pill');
  const problems = cards.filter(needsLook);
  const calm = cards.filter((card) => !needsLook(card) && card.value !== 'n/a');
  const state = problems.length > 0 ? 'attention' : calm.some((card) => card.tone === 'ok') ? 'healthy' : calm.length > 0 ? 'quiet' : 'unwired';
  const summary = {
    attention: `${problems.length} need${problems.length === 1 ? 's' : ''} a look`,
    healthy: 'All healthy',
    quiet: 'No problems reported',
    unwired: 'Checks not wired',
  }[state];
  return {
    state,
    lastKnown,
    summary: lastKnown ? `last-known · ${summary}` : summary,
    parts: [...problems, ...calm].map((card) => ({
      id: card.id,
      text: `${card.title} ${card.value}`,
      flag: card.flag,
      tone: card.tone,
      problem: needsLook(card),
      title: card.titleAttr,
    })),
    title: cards.map((card) => `${card.title}: ${card.value} — ${card.titleAttr}`).join('\n'),
  };
}

// ── KPI cards ───────────────────────────────────────────────────────

export interface CockpitFact {
  /** The count's KPI key (`jobs.working`), kept as the number's identity. */
  readonly kpi: string;
  readonly value: number;
  readonly label: string;
  readonly title: string;
  /** A non-zero count that needs attention (conflicting PRs, failed rounds). */
  readonly alert: boolean;
  /** HEISTS only: the stage this count fills in the stage bar. */
  readonly stage?: CockpitStage;
}

export type CockpitStage = 'working' | 'in-review' | 'merged' | 'done';

export interface CockpitCard {
  readonly id: 'heists' | 'megaminions' | 'crew' | 'prs' | 'reviews' | 'raids' | 'nefario';
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
  readonly flow: readonly { readonly stage: CockpitStage; readonly value: number }[] | null;
  /** Dashed card: the feature is off. */
  readonly off: boolean;
}

function fact(kpi: string, value: number, label: string, title: string, alert = false, stage?: CockpitStage): CockpitFact {
  return { kpi, value, label, title, alert: alert && value > 0, ...(stage === undefined ? {} : { stage }) };
}

/** Pass the board's own sections derivation (one per render) so the cards
 * and the rows below them read the same classification at the same instant. */
export function cockpitCards(snapshot: BoardSnapshot, now = Date.now(), sections: BoardSections = snapshotSections(snapshot, now)): readonly CockpitCard[] {
  // HEISTS counts the board's own top-level rows (one derivation with the
  // sections): nested megaminions ride their heist, surfaced ones count.
  const kpis = boardKpis(snapshot, new Date(now), sections.topLevel);
  const jobs = kpis.jobs;
  const all = collectJobs(snapshot);
  const reviews = reviewCounts(all, new Date(now));
  const round = topReviewRound(snapshot);
  // Every job a minion commissioned is a megaminion, wherever it renders
  // (nested, surfaced, or top-level because its parent left the board) —
  // the same rule the crew rail's role word follows.
  const family = all.filter((job) => (job.parentJobId ?? null) !== null && job.parentJobId !== job.id);
  const liveMega = family.filter(isLiveMegaminion).length;
  // "across N heists" names heists the owner can find on the board; a
  // megaminion whose heist left the board says so instead.
  const onBoard = new Set(all.map((job) => job.id));
  const parents = new Set(family.map((job) => job.parentJobId).filter((id) => onBoard.has(id ?? ''))).size;
  const orphaned = family.filter((job) => !onBoard.has(job.parentJobId ?? ''));
  const orphans = orphaned.length;
  const departed = new Set(orphaned.map((job) => job.parentJobId)).size;
  const children = kpis.children;
  const cards: CockpitCard[] = [
    {
      id: 'heists',
      label: BOARD_WORDS.heists.toUpperCase(),
      aside: null,
      headline: { kpi: 'jobs.total', value: String(jobs.total), unit: 'on the board', title: `${heistCount(jobs.total)} on the board` },
      facts: [
        fact('jobs.working', jobs.working, 'working', `${jobs.working} working`, false, 'working'),
        fact('jobs.inReview', jobs.inReview, 'in review', `${jobs.inReview} in review`, false, 'in-review'),
        fact('jobs.merged', jobs.merged, 'merged', `${jobs.merged} merged`, false, 'merged'),
        fact('jobs.done', jobs.done, 'done', `${jobs.done} done`, false, 'done'),
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
      notes: family.length === 0
        ? ['none commissioned']
        : [
            ...(parents > 0 ? [`across ${heistCount(parents)}`] : []),
            ...(orphans > 0 ? [`${orphans} whose ${departed === 1 ? BOARD_WORDS.heist : BOARD_WORDS.heists} left the board`] : []),
          ],
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
          // With some queued, the pair reads "2 sub-minions active · 1
          // queued" — never "0 sub-minions" beside a queue of them.
          : [
              fact('children.active', children.active,
                `${children.active === 1 ? 'sub-minion' : 'sub-minions'}${children.queued > 0 ? ' active' : ''}`,
                `${pluralCount(children.active, 'sub-minion')} active · ${children.queued} queued · ${children.finished} finished · ${children.lifetimeCreations} created (lifetime logical creations)`),
              ...(children.queued > 0
                ? [fact('children.queued', children.queued, 'queued', `${pluralCount(children.queued, 'sub-minion')} queued`)]
                : []),
            ]),
      ],
      notes: [],
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
  const nefario = nefarioCard(snapshot);
  if (nefario !== null) cards.push(nefario);
  return cards;
}

/** GH-505: Nefario's card, only when the server sent its block (an older
 * server's board shows no card rather than zeros). A block the server could
 * not read (`null`) is unknown: a dashed card says so. The card shows the
 * round's aggregate verdict only — never per-lens chips. */
function nefarioCard(snapshot: BoardSnapshot): CockpitCard | null {
  const review = snapshot.briefingReview;
  if (review === undefined) return null;
  if (review === null) {
    return {
      id: 'nefario',
      label: 'NEFARIO',
      aside: null,
      headline: { kpi: null, value: '—', unit: 'unavailable', title: 'The server could not read the briefing reviews; the card returns with the next board update that can.' },
      facts: [],
      notes: ['the server could not read the briefing reviews'],
      flow: null,
      off: true,
    };
  }
  const live = review.round !== null && review.tier !== null;
  const stageSuffix = review.stage === 'advisory' ? ' · advisory' : '';
  return {
    id: 'nefario',
    label: 'NEFARIO',
    aside: live ? `round ${review.round} · ${review.tier}${stageSuffix}` : `no pass live${stageSuffix}`,
    asideTitle: live
      ? `The newest live briefing review is round ${review.round} at ${review.tier} tier; ${review.stage === 'advisory' ? 'stage 1 records provenance and refuses only a false claim' : 'stage 2 holds a high-tier dispatch until its exact briefing is READY or pushed back'}.`
      : `No briefing review is live; ${review.stage === 'advisory' ? 'stage 1 records provenance and refuses only a false claim' : 'stage 2 holds a high-tier dispatch until its exact briefing is READY or pushed back'}.`,
    headline: { kpi: 'briefingReview.armed', value: String(review.armed), unit: 'under test', title: `${pluralCount(review.armed, 'briefing')} under review` },
    facts: [
      fact('briefingReview.verdictsToday', review.verdictsToday, review.verdictsToday === 1 ? 'verdict today' : 'verdicts today', `${pluralCount(review.verdictsToday, 'briefing verdict')} posted today`),
      fact('briefingReview.caught', review.caught, 'caught', `${pluralCount(review.caught, 'blocking finding')} caught before dispatch today`),
      ...(review.stage === 'high'
        ? [fact('briefingReview.refusalsToday', review.refusalsToday, review.refusalsToday === 1 ? 'refusal today' : 'refusals today', `${pluralCount(review.refusalsToday, 'high-tier dispatch')} held back today`, true)]
        : []),
    ],
    notes: [],
    flow: null,
    off: false,
  };
}

/** #351: the raids card, only when the server sent its block (an older
 * server's board shows no card rather than zeros). A block the server
 * could not read (`null`) is unknown: a dashed card says so. */
function raidsCard(snapshot: BoardSnapshot): CockpitCard | null {
  const vector = snapshot.vector;
  if (vector === undefined) return null;
  if (vector === null) {
    return {
      id: 'raids',
      label: 'VECTOR RAIDS',
      aside: null,
      headline: { kpi: null, value: '—', unit: 'unavailable', title: 'The server could not read the raids; the card returns with the next board update that can.' },
      facts: [],
      notes: ['the server could not read the raids'],
      flow: null,
      off: true,
    };
  }
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
  const where = current === undefined ? '' : current.packageDir === '.' ? current.repo : `${current.repo} ${current.packageDir}`;
  const running = current === undefined
    ? []
    : [`${where} · attack ${Math.min(current.roundsDone + 1, current.maxRounds)}/${current.maxRounds}`];
  // The cap is per repository, counted over a rolling 24 hours; the server
  // lists capUse busiest first, so the aside shows the busiest one's use.
  const [busiest] = vector.capUse;
  return {
    id: 'raids',
    label: 'VECTOR RAIDS',
    aside: `${busiest?.used ?? 0}/${vector.maxRaidsPerDay} in 24h`,
    asideTitle: busiest === undefined
      ? `No repository has used any of its cap of ${pluralCount(vector.maxRaidsPerDay, 'raid')} per 24 hours.`
      : `${vector.capUse.map((entry) => `${entry.repo}: ${entry.used} of ${vector.maxRaidsPerDay} raids in the last 24 hours`).join('\n')} (the cap is per repository)`,
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
  };
}

/** The attention card's line about Gru's own queue: the live machine rows
 * awaiting a Gru disposition (NEEDS GRU, the count the strip's ALERTS pair
 * used to carry), with that pair's long explanation as its title. It is
 * Gru's work, never the owner's, so it stays a muted sub-line. A
 * last-known board says so rather than claiming calm. */
export function gruQueueLine(unackedActionRequired: number, lastKnown = false): { readonly text: string; readonly title: string } {
  const text = unackedActionRequired === 0
    ? 'nothing needs Gru either · the crew is on it'
    : `Gru is handling ${pluralCount(unackedActionRequired, 'live alert')}`;
  return {
    text: lastKnown ? `last-known · ${text}` : text,
    title: alertsCard(unackedActionRequired).titleAttr,
  };
}
