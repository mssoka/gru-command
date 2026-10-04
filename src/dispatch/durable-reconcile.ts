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
 *     lost to a crash window.
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
}

export interface DurableReconcileReport extends Record<string, unknown> {
  /** false when at least one row/transition failed — the driver records a
   * failed pass, never a completed-reconciliation success. */
  readonly ok: boolean;
  readonly directives: DirectiveEvidenceReport;
  readonly phases: PhaseReconcileReport;
  readonly handbacks: UnmarkedReconcileReport;
  /** Rows examined across all passes and windows. */
  readonly examined: number;
  /** Durable transitions this pass completed (settlements, hand-backs,
   * publications, stale-intent closes). */
  readonly advanced: number;
  /** Per-row failures this pass could not finish (retried next pass). */
  readonly failures: number;
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
  const failures = directives.failed + phases.failed + handbacks.failed;
  return {
    ok: failures === 0,
    directives,
    phases,
    handbacks,
    examined: directives.examined + phases.examined + handbacks.deliveries + handbacks.cards,
    advanced:
      directives.completed +
      phases.completed +
      phases.published +
      phases.closed +
      handbacks.recovered +
      handbacks.published,
    failures,
  };
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

export function createDurableReconcileHook(deps: DurableReconcileHookDeps): DeterministicPassHook {
  return () => {
    deps.wave?.reconcilePendingHandoffs();
    return reconcileDurableWork(deps, deps.budget ?? {});
  };
}
