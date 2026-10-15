/**
 * Legacy owner-attention reconciliation (owner release 2026-10-11).
 *
 * Before the responsibility chain was enforced server-side, unacked
 * `needs-owner` rows could carry operational coordination (the screenshot
 * PR256 escalation) or an unrecognized kind. An old, repetitive or
 * unresolved incident must not become an owner decision by age, and an
 * unknown stop must not be silently dropped or executed.
 *
 * This bounded, idempotent pass re-triages such rows to Gru's machine
 * queue (`action-required`) with a recorded note that preserves the full
 * original detail. Registered owner kinds keep their place:
 *
 *   - owner-required kinds (lessons proposals, typed escalations, the
 *     owner-only notices) stay;
 *   - owner-allowed kinds (`decisions.degraded.*`) stay;
 *   - a `gru.owner-escalation` WITHOUT typed decision metadata is a legacy
 *     coordination note, not a reserved decision — Gru re-escalates it
 *     properly when an owner decision is actually owed.
 *
 * Nothing is acked, resolved, deleted or executed; only the attention
 * channel moves, and the move itself is auditable (`notification.triaged`).
 */

import type { LogLevel } from '../logger.js';
import type { LedgerApi, NotificationRecord } from '../ledger/api.js';
import { ownerAttentionFor, requiresTypedDecision } from './attention.js';

export interface LegacyOwnerReconcileDeps {
  readonly ledger: LedgerApi;
  readonly log?: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;
}

export interface LegacyOwnerReconcileReport {
  /** Unacked owner rows examined. */
  readonly examined: number;
  /** Rows moved to Gru's machine queue by this pass. */
  readonly retriaged: number;
  /** Rows left on the owner surface (registered owner attention). */
  readonly kept: number;
  /** Rows the pass could not move (vanished/closed mid-pass) — retried next boot. */
  readonly failed: number;
}

const PAGE_SIZE = 50;

export function reconcileLegacyOwnerAttention(deps: LegacyOwnerReconcileDeps): LegacyOwnerReconcileReport {
  const rows: NotificationRecord[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const page = deps.ledger.listNotifications({
      unackedOnly: true,
      routing: 'needs-owner',
      limit: PAGE_SIZE,
      offset,
    });
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  let retriaged = 0;
  let kept = 0;
  let failed = 0;
  for (const row of rows) {
    const attention = ownerAttentionFor(row.kind);
    const decisionMissing = requiresTypedDecision(row.kind) && row.decision === null;
    // Pre-registry sweep pauses carry no worktree attribution (the scoped
    // `worktree-sweep-paused:<id>:<pause>` form resolves on its worktree's
    // completed sweep); an unattributable row cannot be resolved by any
    // producer, so Gru verifies the tree state and closes it.
    const unattributableSweepPause = row.kind === 'worktree-sweep-paused';
    if (((attention === 'owner-required' && !decisionMissing) || attention === 'owner-allowed') && !unattributableSweepPause) {
      kept += 1;
      continue;
    }
    const reason =
      unattributableSweepPause
        ? 'legacy sweep pause without a worktree attribution — routed to Gru to verify the tree state'
        : attention === 'owner-forbidden'
          ? 'not an owner-reserved matter — routed to Gru for triage'
          : 'legacy owner escalation without a typed reserved decision — routed to Gru to re-escalate if an owner decision is owed';
    const note = [row.detail, `[owner-attention migration 2026-10-11] ${reason}`]
      .filter((part): part is string => part !== null && part !== '')
      .join('\n\n');
    const updated = deps.ledger.updateNotificationTriage(row.id, 'action-required', note);
    if (updated === null) {
      failed += 1;
      continue;
    }
    retriaged += 1;
    deps.log?.('info', 'legacy owner attention re-triaged to Gru', {
      id: row.id,
      kind: row.kind,
      reason,
    });
  }
  return { examined: rows.length, retriaged, kept, failed };
}
