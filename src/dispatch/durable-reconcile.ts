import type { LedgerApi } from '../ledger/api.js';
import type { LogLevel } from '../logger.js';
import type { DeterministicPassHook } from './silas-driver.js';
import {
  reconcilePhaseHandoffs,
  reconcileUnmarkedHandbacks,
  type FollowThroughDeps,
  type FollowThroughNotifications,
  type PhaseReconcileReport,
  type UnmarkedReconcileReport,
} from './obligations.js';
import { settleDirectivesFromEvidence, type DirectiveEvidenceReport } from './rebrief-recovery.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Durable round-robin cursor scopes for the unmarked hand-back windows
 * (issue #163 review): a persistently failing prefix must not starve the
 * later eligible deliveries/cards. Both windows page independently.
 */
const UNMARKED_DELIVERIES_SCOPE = 'unmarked-handback-deliveries';
const UNMARKED_CARDS_SCOPE = 'unmarked-handback-cards';

/**
 * The bounded, non-LLM durable reconciliation pass (issue #163).
 *
 * A Silas model turn can run for a long time; the fleet's routine
 * follow-through must not wait behind it. This pass is deliberately
 * mechanical and read-mostly: it re-reads the durable record and finishes
 * only the transitions whose evidence already exists —
 *
 *  1. directive requests whose correlated admission/terminal delivery
 *     landed (settlement, never re-dispatch);
 *  2. explicitly marked phase handoffs whose validated completion landed
 *     (the owed decision is recorded durably and published machine-side);
 *  3. unmarked blocked-lane hand-backs whose obligation/card write was
 *     lost to a crash window;
 *  4. report-type jobs whose review target provably merged or moved past
 *     the reviewed head (issue #220 auto-supersede — the commissioner's
 *     owed disposition retires with its target).
 *
 * It never dispatches a worker, never awaits a worker's terminal result,
 * never rings the owner, never creates a second Silas session and never
 * reopens delivered/parked/terminal work. Every step is idempotent, so a
 * duplicate trigger or an overlapping process coalesces onto at most one
 * accepted next action per phase. Bounded page budgets with durable
 * round-robin cursors keep old/failing/dispositioned rows from starving
 * later eligible work.
 *
 * The boot-time reconcilers keep their richer judgment (escalation notes
 * and cards for admission-unknown requests); this pass only advances on
 * positive evidence and leaves unknown outcomes visible and untouched.
 */
export interface DurableReconcileDeps {
  readonly ledger: LedgerApi;
  readonly notifications: FollowThroughNotifications;
  readonly log?: Log;
}

export interface DurableReconcileBudget {
  /** Directive evidence pages (each ≤1000 rows). Default 200 × 5. */
  readonly directivePageSize?: number;
  readonly directiveMaxPages?: number;
  /** Phase-handoff pages. Default 100 × 4 per tick. */
  readonly phasePageSize?: number;
  readonly phaseMaxPages?: number;
  /** Unmarked hand-back candidates per pass and window. Default 100. */
  readonly handbackLimit?: number;
  /** Report-closure candidates per pass. Default 100. */
  readonly reportLimit?: number;
}

export interface DurableReconcileReport extends Record<string, unknown> {
  /** false when at least one row/transition failed — the driver records a
   * failed pass, never a completed-reconciliation success. */
  readonly ok: boolean;
  readonly directives: DirectiveEvidenceReport;
  readonly phases: PhaseReconcileReport;
  readonly handbacks: UnmarkedReconcileReport;
  /** Issue #220: report-job auto-supersede (merged target / moved head). */
  readonly reports: ReportClosureReport;
  /** Rows examined across all passes and windows. */
  readonly examined: number;
  /** Durable transitions this pass completed (settlements, hand-backs,
   * publications, stale-intent closes). */
  readonly advanced: number;
  /** Per-row failures this pass could not finish (retried next pass). */
  readonly failures: number;
}

/** Issue #220 auto-supersede scan result. `examined` counts delivered
 * report-type jobs carrying a target; `superseded` the durable retires;
 * `opened` the handbacks whose obligation open the crash backstop
 * recovered; `failed` rows that threw (retried next pass — a partial pass
 * is never reported as fully reconciled). */
export interface ReportClosureReport extends Record<string, unknown> {
  readonly examined: number;
  readonly superseded: number;
  readonly opened: number;
  readonly failed: number;
}

export function reconcileDurableWork(
  deps: DurableReconcileDeps,
  budget: DurableReconcileBudget = {},
): DurableReconcileReport {
  const followThrough: FollowThroughDeps = {
    ledger: deps.ledger,
    notifications: deps.notifications,
    ...(deps.log !== undefined ? { log: deps.log } : {}),
  };
  const directives = settleDirectivesFromEvidence(deps, {
    pageSize: budget.directivePageSize ?? 200,
    maxPages: budget.directiveMaxPages ?? 5,
  });
  const phases = reconcilePhaseHandoffs(followThrough, {
    pageSize: budget.phasePageSize ?? 100,
    maxPages: budget.phaseMaxPages ?? 4,
  });
  const handbacks = reconcileUnmarkedHandbacks(followThrough, {
    limit: budget.handbackLimit ?? 100,
    deliveriesCursor: deps.ledger.readReconcileCursor(UNMARKED_DELIVERIES_SCOPE) ?? 0,
    cardsCursor: deps.ledger.readReconcileCursor(UNMARKED_CARDS_SCOPE) ?? 0,
  });
  deps.ledger.writeReconcileCursor({
    scope: UNMARKED_DELIVERIES_SCOPE,
    cursor: handbacks.deliveriesCursor ?? 0,
  });
  deps.ledger.writeReconcileCursor({
    scope: UNMARKED_CARDS_SCOPE,
    cursor: handbacks.cardsCursor ?? 0,
  });
  const reports = reconcileReportClosures(deps, { limit: budget.reportLimit ?? 100 });
  const failures = directives.failed + phases.failed + handbacks.failed + reports.failed;
  return {
    ok: failures === 0,
    directives,
    phases,
    handbacks,
    reports,
    examined: directives.examined + phases.examined + handbacks.deliveries + handbacks.cards + reports.examined,
    advanced:
      directives.completed +
      phases.completed +
      phases.published +
      phases.closed +
      handbacks.recovered +
      handbacks.published +
      reports.superseded +
      reports.opened,
    failures,
  };
}

/**
 * Report-job auto-supersede (issue #220): a delivered report-type job's
 * findings die with their target. When the ledger proves the target PR
 * merged, or its head moved past the reviewed sha, the commissioner's
 * owed disposition is retired mechanically — obligation settled as
 * superseded, `report.superseded` recorded, job delivered → done — before
 * any LLM wake. Ledger-only, no filesystem probing: merge reads the
 * source job's terminal status or its `github.pr-merged` receipt; a moved
 * head reads the source job's `github.branch-state` observations (the
 * reviewed sha must be an OBSERVED predecessor of a different latest sha
 * — an unobserved target retires nothing and stays with the commissioner).
 */
export function reconcileReportClosures(
  deps: DurableReconcileDeps,
  budget: { limit?: number } = {},
): ReportClosureReport {
  let superseded = 0;
  let failed = 0;
  let examined = 0;
  let opened = 0;
  // Crash-window backstop FIRST: a delivered report-type job whose handback
  // lost its obligation open (crash between the delivery event and the
  // obligation insert) has NO owner of its settlement. Re-open it from the
  // delivery event — idempotent, so a live debt coalesces. Legacy rows
  // (deliverable NULL) are deliberately excluded: the backfill CLI owns
  // those and the owner reviews its dry-run list before anything writes.
  for (const job of deps.ledger.listDeliveredReportJobs(budget.limit ?? 100)) {
    examined += 1;
    try {
      const active = deps.ledger.findReportObligation(job.id);
      if (active !== null && (active.state === 'open' || active.state === 'waiting' || active.state === 'suspended')) continue;
      const delivered = deps.ledger.latestJobEvent(job.id, 'job.delivered');
      if (delivered === null) {
        failed += 1;
        deps.log?.('error', 'delivered report job has no delivery event — cannot open its obligation', { job: job.id });
        continue;
      }
      const result = deps.ledger.openReportObligation({ jobId: job.id, observedAtSeq: delivered.seq });
      if (result.created) opened += 1;
    } catch (error) {
      failed += 1;
      deps.log?.('error', 'report obligation backstop failed', {
        job: job.id,
        error: String(error).slice(0, 300),
      });
    }
  }
  for (const job of deps.ledger.listReportClosureCandidates(budget.limit ?? 100)) {
    try {
      const target = job.targetRef ?? '';
      const source = deps.ledger.findJobByPrUrl(target);
      if (source === null || source.id === job.id) continue; // unobservable target — the commissioner keeps the debt
      const reason = reportSupersedeReason(deps, job.targetSha ?? '', source);
      if (reason === null) continue;
      deps.ledger.supersedeReportObligation({ jobId: job.id, reason });
      superseded += 1;
    } catch (error) {
      failed += 1;
      deps.log?.('error', 'report auto-supersede failed', {
        job: job.id,
        error: String(error).slice(0, 300),
      });
    }
  }
  return { examined, superseded, opened, failed };
}

/** The durable supersede reason for a report's target, or null when the
 * ledger proves nothing: the target neither merged nor observably moved
 * past the reviewed sha. */
function reportSupersedeReason(
  deps: Pick<DurableReconcileDeps, 'ledger'>,
  targetSha: string,
  source: { readonly id: string; readonly status: string },
): string | null {
  if (source.status === 'merged' || deps.ledger.latestJobEvent(source.id, 'github.pr-merged') !== null) {
    return `target PR merged (${source.id}) — the findings can no longer apply`;
  }
  if (targetSha === '') return null;
  const states = deps.ledger.listJobEventsByKinds(source.id, ['github.branch-state'], { limit: 200 });
  const latest = states[0];
  if (latest === undefined) return null;
  const latestSha = eventSha(latest);
  if (latestSha === null || latestSha === targetSha) return null;
  // Ancestry from observations only: the reviewed sha must appear in an
  // earlier recorded state, so the move is proof of progress past it —
  // never a guess about unobserved history.
  const reviewedObserved = states.some((event, index) => index > 0 && eventSha(event) === targetSha);
  if (!reviewedObserved) return null;
  return `target head moved past the reviewed sha ${targetSha} → ${latestSha} (${source.id})`;
}

function eventSha(event: { readonly payload: unknown }): string | null {
  const payload = typeof event.payload === 'object' && event.payload !== null ? event.payload : {};
  const sha = (payload as { sha?: unknown }).sha;
  return typeof sha === 'string' && sha !== '' ? sha : null;
}

export interface DurableReconcileHookDeps extends DurableReconcileDeps {
  /** The in-memory review-intake reconsideration (wave) run alongside. The
   * wave handoff owns its own durable lifecycle (`job.review-handoff-*`
   * markers + boot `resumeQueuedHandoffs`); its asynchronous outcomes are
   * NOT claimed by this pass's health, which reports the durable
   * reconciliation only. */
  readonly wave?: { reconcilePendingHandoffs(): void };
  readonly budget?: DurableReconcileBudget;
}

/**
 * The production deterministic-pass hook (issue #163): the wave review
 * reconsideration plus the bounded durable reconciliation. Extracted as a
 * factory so the exact startup composition is exercised behaviorally by
 * tests with a real LedgerApi and driver — never by a source-text-only
 * alarm.
 */
/** Late-bound wave reconciliation binding (production composition seam):
 * the callback reads the live wave handle at every pass, so a
 * construction-order change (or a not-yet-assigned wave) can never freeze
 * a null. Extracted so the exact production binding is behaviorally
 * exercised by tests with a real queued WaveRunner. */
export function waveReconcileBinding(
  getWave: () => { reconcilePendingHandoffs(): void } | undefined,
): { reconcilePendingHandoffs(): void } {
  return { reconcilePendingHandoffs: () => getWave()?.reconcilePendingHandoffs() };
}

export interface ProductionDeterministicPassDeps {
  readonly ledger: LedgerApi;
  readonly notifications: FollowThroughNotifications;
  readonly log?: Log;
  /** Reads the live wave handle at each pass (late-bound). */
  readonly getWave: () => { reconcilePendingHandoffs(): void } | undefined;
  readonly budget?: DurableReconcileBudget;
}

/**
 * The EXACT production Silas option assembly (issue #163 review): startup
 * builds the deterministic hook through this function, and the
 * deterministic-seam test drives it with a real queued WaveRunner — so a
 * disconnected wave getter fails behaviorally, never only a source regex.
 */
export function createProductionDeterministicPass(
  deps: ProductionDeterministicPassDeps,
): DeterministicPassHook {
  return createDurableReconcileHook({
    ledger: deps.ledger,
    notifications: deps.notifications,
    ...(deps.log !== undefined ? { log: deps.log } : {}),
    wave: waveReconcileBinding(deps.getWave),
    ...(deps.budget !== undefined ? { budget: deps.budget } : {}),
  });
}

export function createDurableReconcileHook(deps: DurableReconcileHookDeps): DeterministicPassHook {
  return () => {
    deps.wave?.reconcilePendingHandoffs();
    return reconcileDurableWork(deps, deps.budget ?? {});
  };
}
