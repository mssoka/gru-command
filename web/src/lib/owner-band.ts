/**
 * FOR YOU owner-band row model (owner approval 2026-09-28) — pure
 * derivations so the band's honesty rules are testable without a DOM.
 *
 * The band renders ONE authoritative pending-owner list:
 *   - ack rows: `needs-owner` notifications still unacked AND unresolved
 *     (pending = action still owed; seen/opened never completes one);
 *   - proposal rows: a pending Book of Lessons proposal, decided with
 *     Accept/Reject after reviewing it (never a plain Ack);
 *   - PR rows: the server-computed, evidence-bound `ownerPrs` projection
 *     (the browser never re-derives merge readiness).
 *
 * Ordering is deterministic (newest first, action id tiebreak) and row
 * ids are stable across renders (`owner-ack:{id}` / `owner-pr:{jobId}`)
 * so focus, aria and tests address the same control before and after a
 * snapshot push. No text-based dedupe, no grouping, no bulk actions.
 */

import { LESSONS_PROPOSAL_KIND, type BoardSnapshot, type NotificationView, type OwnerPrView } from './board-protocol.js';

/** The single kind-family map for every ack surface: the family key is
 * derived ONCE here, so the collapsed Next step and the expanded
 * consequence can never disagree about which kinds are special. Static per
 * family — never parsed out of notification prose (prose is display data,
 * not execution authority). */
type AckFamily = 'rearm' | 'sighting' | 'sweep' | 'squat' | 'generic';

function ackFamily(kind: string): AckFamily {
  if (kind.startsWith('supervision.provider-wall.') || kind === 'supervision.breaker') return 'rearm';
  if (kind.startsWith('decisions.degraded.')) return 'sighting';
  if (kind === 'worktree-sweep-paused') return 'sweep';
  if (kind === 'port-squat' || kind === 'roll-port-squat') return 'squat';
  return 'generic';
}

/** What an ack does and does NOT do — the expanded region's full copy. */
const ACK_CONSEQUENCE: Readonly<Record<AckFamily, string>> = {
  rearm: 'Ack re-arms this worker and resumes supervision — it does NOT clear code/test/review holds.',
  sighting: 'Ack records that you saw this; the system stays degraded until the credential or provider is fixed.',
  sweep: 'Ack confirms removal of the listed worktree — check nothing live is rooted there first.',
  squat: 'Stop the foreign process yourself; ack only clears the notice.',
  generic: 'Ack clears this notice from your queue; it does not by itself prove the underlying operation ran.',
};

/** SHORT typed next step for the collapsed For-you face (approved
 * clarification: the face stays concise — the supplied title is the
 * Problem and this is the whole Next step; the full consequence still
 * travels with the Ack control in the expanded region). */
const ACK_NEXT_STEP: Readonly<Record<AckFamily, string>> = {
  rearm: 'Ack re-arms this worker.',
  sighting: 'Ack records that you saw this.',
  sweep: 'Check the worktree, then ack.',
  squat: 'Stop the foreign process, then ack.',
  generic: 'Ack clears this notice.',
};

export function ackConsequence(kind: string): string {
  return ACK_CONSEQUENCE[ackFamily(kind)];
}

export function ackNextStep(kind: string): string {
  return ACK_NEXT_STEP[ackFamily(kind)];
}

export interface OwnerAckRow {
  readonly kind: 'ack';
  readonly actionId: string;
  readonly ts: string;
  readonly notification: NotificationView;
  readonly consequence: string;
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

export type OwnerRow = OwnerAckRow | OwnerPrRow | OwnerProposalRow;

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
    rows.push({
      kind: 'ack',
      actionId: `owner-ack:${notification.id}`,
      ts: notification.ts,
      notification,
      consequence: ackConsequence(notification.kind),
    });
  }
  for (const pr of snapshot.ownerPrs ?? []) {
    rows.push({ kind: 'pr', actionId: pr.id, ts: pr.checkedAt, pr });
  }
  return rows.sort((left, right) => right.ts.localeCompare(left.ts) || left.actionId.localeCompare(right.actionId));
}

/** The pending count shown in the band header — owed actions, not unseen
 * rows. Opening the board or the bell never changes it. */
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
