import type { LedgerApi } from '../ledger/api.js';
import type { LogLevel } from '../logger.js';
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
 * round-robin cursors keep old/dispositioned rows from starving later
 * eligible work.
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
  /** Unmarked hand-back candidates per pass. Default 100. */
  readonly handbackLimit?: number;
}

export interface DurableReconcileReport extends Record<string, unknown> {
  readonly directives: DirectiveEvidenceReport;
  readonly phases: PhaseReconcileReport;
  readonly handbacks: UnmarkedReconcileReport;
  /** Rows examined across all three passes. */
  readonly examined: number;
  /** Durable transitions this pass completed (settlements, hand-backs,
   * publications, stale-intent closes). */
  readonly advanced: number;
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
  });
  return {
    directives,
    phases,
    handbacks,
    examined: directives.examined + phases.examined + handbacks.deliveries,
    advanced:
      directives.completed +
      phases.completed +
      phases.published +
      phases.closed +
      handbacks.recovered +
      handbacks.published,
  };
}
