/**
 * FOR YOU owner-band row model (owner approval 2026-09-28; decision-inbox
 * release 2026-10-11) — pure derivations so the band's honesty rules are
 * testable without a DOM.
 *
 * The band renders ONE authoritative pending-owner list:
 *   - decision rows: typed owner decisions (question, recommendation,
 *     options with consequences) the owner answers here; recording the
 *     choice never settles the row — follow-through stays distinct;
 *   - notice rows: owner-only notices whose action is outside the app
 *     (stop a process, fix a credential, restart); no fake Ack, no
 *     invented option — the row remains visible until its producer
 *     resolves it on evidence;
 *   - proposal rows: a pending Book of Lessons proposal, decided with
 *     Accept/Reject after reviewing it (never a plain Ack);
 *   - PR rows: the server-computed, evidence-bound `ownerPrs` projection
 *     (the browser never re-derives merge readiness).
 *
 * Ordering is deterministic (newest first, action id tiebreak) and row
 * ids are stable across renders so focus, aria and tests address the same
 * control before and after a snapshot push. No text-based dedupe, no
 * grouping, no bulk actions, and never an action derived from prose.
 */

import { LESSONS_PROPOSAL_KIND, type BoardSnapshot, type NotificationDecisionView, type NotificationView, type OwnerPrView } from './board-protocol.js';

/** What the owner must actually do for a notice-only kind — static copy,
 * never parsed out of notification prose (prose is display data, not
 * execution authority). A notice carries no in-app control. */
export function ownerNoticeGuidance(kind: string): string {
  if (kind === 'port-squat' || kind === 'roll-port-squat') {
    return 'Stop the foreign process yourself, then restart the service. This notice clears on a successful bind.';
  }
  if (kind.startsWith('decisions.degraded.') || kind.startsWith('decisions.enforce-gate.')) {
    return 'Fix the decision-provider credential or configuration, then use Recheck. This notice clears when the decision service recovers.';
  }
  if (kind === 'worktree-sweep-paused') {
    return 'Confirm nothing live is rooted in the listed worktree. The sweep stays paused until an operator deliberately completes it; clearing this notice is not possible here.';
  }
  if (kind.startsWith('gru.wake-blocked.') || kind.startsWith('gru.wake-failed-escalation.')) {
    return 'Restart the service to recover chat safely. The machine alert remains pending for retry.';
  }
  return 'No in-app action is supported for this notice; it stays visible until its producer resolves it.';
}

export interface OwnerDecisionRow {
  readonly kind: 'decision';
  readonly actionId: string;
  readonly ts: string;
  readonly notification: NotificationView;
  readonly decision: NotificationDecisionView;
}

export interface OwnerNoticeRow {
  readonly kind: 'notice';
  readonly actionId: string;
  readonly ts: string;
  readonly notification: NotificationView;
  readonly guidance: string;
}

export interface OwnerPrRow {
  readonly kind: 'pr';
  readonly actionId: string;
  readonly ts: string;
  readonly pr: OwnerPrView;
}

/** What Accept and Reject do for a Book of Lessons proposal — static copy,
 * never parsed out of notification prose. */
export const LESSONS_PROPOSAL_CONSEQUENCE =
  'Accept writes these changes into the Book of Lessons. Reject discards them; those journal entries won’t be proposed again.';

/** A Book of Lessons proposal (owner decision 2026-10-07): reviewed and
 * decided here — it never closes on a plain Ack. */
export interface OwnerProposalRow {
  readonly kind: 'proposal';
  readonly actionId: string;
  readonly ts: string;
  readonly notification: NotificationView;
  readonly consequence: string;
}

export type OwnerRow = OwnerDecisionRow | OwnerNoticeRow | OwnerPrRow | OwnerProposalRow;

/** Pending owner obligations, newest first (id tiebreak). The snapshot's
 * notification list already carries EVERY unacked needs-owner row — the
 * 30-row feed window never truncates the owner queue. */
export function ownerRows(snapshot: BoardSnapshot): readonly OwnerRow[] {
  const rows: OwnerRow[] = [];
  for (const notification of snapshot.notifications) {
    if (notification.routing !== 'needs-owner') continue;
    if (notification.ackedAt !== null || notification.resolvedAt !== null) continue;
    if (notification.kind === LESSONS_PROPOSAL_KIND) {
      rows.push({
        kind: 'proposal',
        actionId: `owner-proposal:${notification.id}`,
        ts: notification.ts,
        notification,
        consequence: LESSONS_PROPOSAL_CONSEQUENCE,
      });
      continue;
    }
    if (notification.decision !== null && notification.decision !== undefined) {
      rows.push({
        kind: 'decision',
        actionId: `owner-decision:${notification.id}`,
        ts: notification.ts,
        notification,
        decision: notification.decision,
      });
      continue;
    }
    // A needs-owner row without a typed decision is an owner notice (the
    // action is outside the app) — it never grows an invented control.
    rows.push({
      kind: 'notice',
      actionId: `owner-notice:${notification.id}`,
      ts: notification.ts,
      notification,
      guidance: ownerNoticeGuidance(notification.kind),
    });
  }
  for (const pr of snapshot.ownerPrs ?? []) {
    rows.push({ kind: 'pr', actionId: pr.id, ts: pr.checkedAt, pr });
  }
  return rows.sort((left, right) => right.ts.localeCompare(left.ts) || left.actionId.localeCompare(right.actionId));
}

/** The pending count shown in the band header — owed actions, not unseen
 * rows. Opening the board or the bell never changes it. A recorded
 * decision keeps its row visible (awaiting follow-through) until the
 * producer resolves it, exactly like an unanswered one. */
export function ownerPendingCount(snapshot: BoardSnapshot): number {
  return ownerRows(snapshot).length;
}

/** How many rows render before the "+N older" expander. Nothing is ever
 * dropped — the older pending tail lives behind the expander. */
export const OWNER_WINDOW_SIZE = 6;

export interface OwnerWindowView {
  readonly rows: readonly OwnerRow[];
  readonly hidden: number;
}

export function ownerWindow(rows: readonly OwnerRow[], expanded: boolean, limit = OWNER_WINDOW_SIZE): OwnerWindowView {
  if (expanded || rows.length <= limit) return { rows, hidden: 0 };
  return { rows: rows.slice(0, limit), hidden: rows.length - limit };
}

/** The recorded option's label for the "decision recorded" line. Unknown
 * ids fall back to the raw id — a decided row NEVER renders as pending. */
export function decidedOptionLabel(decision: NotificationDecisionView, optionId: string | null | undefined): string {
  if (optionId === null || optionId === undefined) return 'decision recorded';
  return decision.options.find((option) => option.id === optionId)?.label ?? optionId;
}

/** OPEN PR targets: https only. A non-https prUrl renders no link (fail
 * closed) — the server already refuses to project them, this is the
 * browser-side guard against a malformed payload. */
export function safePrUrl(url: string): string | null {
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
