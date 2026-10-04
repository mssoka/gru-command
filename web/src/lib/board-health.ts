/**
 * Health row (board UX v4): the slim row under the KPI strip. Each card is
 * earned by a real incident — deploy drift (a 43-commit-behind service
 * that cost hours), review throughput, Silas ops, alerts, verify queue,
 * cure efficacy. Cards whose data source is not wired render an honest
 * `n/a`, never a fabricated zero.
 *
 * Pure derivations so the math (behind counts, restart-pending flag,
 * today's terminal rounds) is unit-testable without a DOM.
 */

import type {
  BoardSnapshot,
  BuildView,
  JobView,
  SelfHealView,
  SilasView,
  VerifyQueueView,
} from './board-protocol.js';
import { collectJobs } from './board-kpi.js';
import { pluralCount } from './board-signals.js';
import { formatAge, isSameLocalDay, shortRev } from './board-time.js';

export type HealthTone = 'ok' | 'warn' | 'alert' | 'muted';

export interface HealthCardView {
  readonly id: 'deploy' | 'reviews' | 'silas' | 'alerts' | 'verify' | 'cure';
  readonly title: string;
  readonly value: string;
  readonly detail: string;
  readonly tone: HealthTone;
  /** Loud flag on the card face; null when there is nothing to shout. */
  readonly flag: string | null;
  /** Longer explanation for the title attribute. */
  readonly titleAttr: string;
}

const N_A_DETAIL: Readonly<Record<HealthCardView['id'], string>> = {
  deploy: 'build-drift feed not wired',
  reviews: 'no review rounds yet',
  silas: 'silas health not wired',
  alerts: 'nothing awaiting ack',
  verify: 'verification scheduler not wired yet',
  cure: 'self-heal stats not wired yet',
};

function card(
  id: HealthCardView['id'],
  title: string,
  value: string,
  detail: string,
  tone: HealthTone,
  flag: string | null = null,
  titleAttr = '',
): HealthCardView {
  return { id, title, value, detail, tone, flag, titleAttr: titleAttr === '' ? detail : titleAttr };
}

function notAvailable(id: HealthCardView['id'], title: string, titleAttr?: string): HealthCardView {
  return card(id, title, 'n/a', N_A_DETAIL[id], 'muted', null, titleAttr ?? N_A_DETAIL[id]);
}

/** The restart-pending flag: the running build is behind origin/main, so a
 * restart (after rebuild) is owed. Unknown counts never flag. */
export function restartPending(build: BuildView | null | undefined): boolean {
  return (build?.commitsBehind ?? null) !== null && (build?.commitsBehind ?? 0) > 0;
}

export function deployDriftCard(build: BuildView | null | undefined, now = Date.now()): HealthCardView {
  if (build === null || build === undefined) return notAvailable('deploy', 'deploy');
  if (build.commitsBehind === null) {
    const why = build.checkError ?? 'origin/main not checked yet';
    return card(
      'deploy',
      'deploy',
      'unknown',
      `build ${shortRev(build.buildRev)} · ${why}`,
      'warn',
      null,
      `running build ${shortRev(build.buildRev)}; drift unknown — ${why}`,
    );
  }
  if (build.commitsBehind === 0) {
    return card(
      'deploy',
      'deploy',
      'current',
      `build ${shortRev(build.buildRev)} · checked ${formatAge(build.checkedAt, now)} ago`,
      'ok',
      null,
      `running build ${shortRev(build.buildRev)} matches origin/main ${shortRev(build.originMainRev)}`,
    );
  }
  return card(
    'deploy',
    'deploy',
    `${build.commitsBehind} behind`,
    `build ${shortRev(build.buildRev)} (${formatAge(build.buildCommittedAt, now)} old) · main ${shortRev(build.originMainRev)}`,
    'alert',
    'RESTART PENDING',
    `running build ${shortRev(build.buildRev)} is ${build.commitsBehind} commits behind origin/main ${shortRev(build.originMainRev)} — rebuild + restart`,
  );
}

export interface ReviewCounts {
  /** Rounds running or queued (live/pending). */
  readonly active: number;
  /** Rounds that aborted today. */
  readonly failedToday: number;
  /** Rounds whose verdict posted today. */
  readonly verdictsToday: number;
}

export function reviewCounts(jobs: readonly JobView[], now = new Date()): ReviewCounts {
  let active = 0;
  let failedToday = 0;
  let verdictsToday = 0;
  for (const job of jobs) {
    for (const round of job.rounds) {
      if (round.status === 'live' || round.status === 'pending') {
        active += 1;
      } else if (round.status === 'aborted') {
        if (isSameLocalDay(round.updatedAt, now)) failedToday += 1;
      } else if (round.status === 'verdict-posted') {
        if (isSameLocalDay(round.updatedAt, now)) verdictsToday += 1;
      }
    }
  }
  return { active, failedToday, verdictsToday };
}

export function reviewCard(jobs: readonly JobView[], now = Date.now()): HealthCardView {
  const counts = reviewCounts(jobs, new Date(now));
  const verdicts = pluralCount(counts.verdictsToday, 'verdict');
  const detail = `${counts.failedToday} failed today · ${verdicts} today`;
  return card(
    'reviews',
    'reviews',
    `${counts.active} active`,
    detail,
    counts.failedToday > 0 ? 'alert' : counts.active > 0 ? 'ok' : 'muted',
    counts.failedToday > 0 ? `${counts.failedToday} FAILED` : null,
    `${counts.active} round(s) active · ${counts.failedToday} failed today · ${verdicts} today`,
  );
}

export function silasCard(silas: SilasView | null | undefined, now = Date.now()): HealthCardView {
  if (silas === null || silas === undefined) return notAvailable('silas', 'silas');
  // Issue #163: the headline answers "is the loop alive?" with the
  // reconciliation heartbeat, never the wake-start age alone — a healthy
  // long model turn must not read as a stalled scheduler. A pass that
  // FAILED after the last success is louder than every healthy state; the
  // engine compares durable event ORDER, so same-millisecond passes cannot
  // tie-break wrongly.
  const failedNewer = silas.reconcileFailedNewer;
  const value = failedNewer
    ? `pass failed ${formatAge(silas.lastReconcileFailedAt, now)} ago`
    : silas.openTurnSince !== null
      ? `turn open ${formatAge(silas.openTurnSince, now)}`
      : silas.lastReconcileAt !== null
        ? `reconciled ${formatAge(silas.lastReconcileAt, now)} ago`
        : silas.lastWakeAt === null
          ? 'no wakes yet'
          : `wake ${formatAge(silas.lastWakeAt, now)} ago`;
  // An open turn must not hide whether the deterministic loop is still
  // moving: the detail carries the reconcile freshness beside the count.
  const detail =
    silas.openTurnSince !== null && silas.lastReconcileAt !== null
      ? `reconciled ${formatAge(silas.lastReconcileAt, now)} ago · ${silas.reconciliationsToday} machine actions today`
      : `${silas.reconciliationsToday} machine actions today`;
  const full = [
    `last wake ${formatAge(silas.lastWakeAt, now)} ago (start marker)`,
    `last reconcile ${silas.lastReconcileAt === null ? 'never' : `${formatAge(silas.lastReconcileAt, now)} ago`}`,
    silas.lastReconcileFailedAt === null
      ? 'no failed pass'
      : `last failed pass ${formatAge(silas.lastReconcileFailedAt, now)} ago`,
    silas.lastTickAt === null ? 'no ticks recorded' : `last tick ${formatAge(silas.lastTickAt, now)} ago`,
    silas.openTurnSince === null ? 'no turn open' : `turn open ${formatAge(silas.openTurnSince, now)}`,
    silas.lastUsefulActionAt === null
      ? 'no corrective action yet'
      : `last action ${formatAge(silas.lastUsefulActionAt, now)} ago`,
    silas.nextAction === null ? 'no tracked obligation' : `next owed: ${silas.nextAction}`,
    `${silas.reconciliationsToday} machine actions today`,
  ].join(' · ');
  return card(
    'silas',
    'silas',
    value,
    detail,
    failedNewer ? 'alert' : 'muted',
    failedNewer ? 'FAILED' : null,
    full,
  );
}

export function alertsCard(unacked: number): HealthCardView {
  return card(
    'alerts',
    'alerts',
    String(unacked),
    unacked === 0 ? 'live machine queue clear' : 'live machine attention awaiting Gru',
    unacked > 0 ? 'alert' : 'ok',
    unacked > 0 ? 'NEEDS GRU' : null,
    `${unacked} live machine-attention notification(s) awaiting Gru; closed receipts and the owner bell stay quiet`,
  );
}

export function verifyCard(verify: VerifyQueueView | null | undefined): HealthCardView {
  if (verify === null || verify === undefined) return notAvailable('verify', 'verify');
  const queuedFlag = verify.queuedRuns > 0 ? `${verify.queuedRuns} QUEUED` : null;
  return card(
    'verify',
    'verify',
    `lock ${verify.lockInUse ? 'held' : 'free'}`,
    `${verify.activeRuns} active · ${verify.queuedRuns} queued · ${verify.workersPerRun}/${verify.workerBudget} workers`,
    verify.queuedRuns > 0 ? 'warn' : 'ok',
    queuedFlag,
    `verification scheduler: ${verify.activeRuns} active, ${verify.queuedRuns} queued, ${verify.workersPerRun} of ${verify.workerBudget} workers per run`,
  );
}

export function cureCard(selfHeal: SelfHealView | null | undefined): HealthCardView {
  if (selfHeal === null || selfHeal === undefined) return notAvailable('cure', 'cure');
  return card(
    'cure',
    'cure',
    `${selfHeal.sessionsResumed} resumed`,
    `${selfHeal.sessionsOrphaned} orphaned since boot`,
    selfHeal.sessionsOrphaned > 0 ? 'alert' : 'ok',
    selfHeal.sessionsOrphaned > 0 ? `${selfHeal.sessionsOrphaned} ORPHANED` : null,
    `${selfHeal.sessionsResumed} session(s) resumed, ${selfHeal.sessionsOrphaned} orphaned since boot`,
  );
}

/** The whole row, in fixed order. */
export function healthCards(snapshot: BoardSnapshot, now = Date.now()): readonly HealthCardView[] {
  const jobs = collectJobs(snapshot);
  return [
    deployDriftCard(snapshot.build ?? null, now),
    reviewCard(jobs, now),
    silasCard(snapshot.silas ?? null, now),
    alertsCard(snapshot.unackedActionRequired),
    verifyCard(snapshot.verify ?? null),
    cureCard(snapshot.selfHeal ?? null),
  ];
}
