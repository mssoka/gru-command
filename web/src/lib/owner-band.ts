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
 * Ordering is deterministic (what still needs the owner first, then
 * answers awaiting follow-through; newest first and action id tiebreak
 * within each) and row
 * ids are stable across renders so focus, aria and tests address the same
 * control before and after a snapshot push. No text-based dedupe, no
 * grouping, no bulk actions, and never an action derived from prose.
 */

import { OWNER_NO_RECOMMENDATION_PREFIX, ownerNoticeGuidance, type OwnerNoticeGuidance } from '../../../src/notifications/owner-language.js';
import { LESSONS_PROPOSAL_KIND, type BoardSnapshot, type NotificationDecisionView, type NotificationView, type OwnerPrView } from './board-protocol.js';

/** What the owner must actually do for a notice-only kind — structured copy,
 * never parsed out of notification prose (prose is display data, not
 * execution authority). The table lives beside the server-side write
 * boundary (src/notifications/owner-language.ts) so the same words the card
 * renders are the words the boundary requires; a notice carries no in-app
 * control. */
export { ownerNoticeGuidance };
export type { OwnerNoticeGuidance };

/** True for the explicit no-preference form, which the card renders without
 * the "Gru recommends:" prefix (a producer with no preference says so — it
 * never dresses that up as a recommendation). */
export function isNoRecommendation(recommendation: string): boolean {
  return recommendation.startsWith(OWNER_NO_RECOMMENDATION_PREFIX);
}

export interface KindOfAsk {
  readonly icon: string;
  readonly label: string;
}

/** Plain words for the reserved owner boundary a decision falls under
 * (`reservedClass`, validated at the server write boundary): the badge on
 * an owner card says what KIND of ask it is before the owner reads it. */
const KIND_OF_ASK: Readonly<Record<string, KindOfAsk>> = {
  merge: { icon: '🔀', label: 'Merge' },
  'authority-cost': { icon: '🔑', label: 'Access or cost' },
  destructive: { icon: '⚠️', label: 'Can’t be undone' },
  'scope-design': { icon: '🧭', label: 'Scope or design' },
  lessons: { icon: '📖', label: 'Lesson' },
};

/** The badge for a decision's reserved class; a class this build does not
 * know gets NO badge (never a guessed label). */
export function kindOfAsk(reservedClass: string): KindOfAsk | null {
  return Object.hasOwn(KIND_OF_ASK, reservedClass) ? (KIND_OF_ASK[reservedClass] ?? null) : null;
}

/** A destructive or irreversible ask: the one kind whose card carries the
 * red edge as well as the badge. */
export function isDestructiveAsk(reservedClass: string): boolean {
  return reservedClass === 'destructive';
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
  readonly guidance: OwnerNoticeGuidance | null;
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
    // action is outside the app) — it never grows an invented control. A row
    // whose kind predates its guidance entry renders no guidance at all
    // rather than a generic sentence (the write boundary refuses new ones).
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
  // What still needs the owner comes first, newest first; answers Gru is
  // carrying out follow, newest first. The band shows a window of the first
  // rows, so an open question can never sit behind answered cards while the
  // header says it is waiting.
  const answeredLast = (row: OwnerRow): number => (isAnsweredRow(row) ? 1 : 0);
  return rows.sort(
    (left, right) =>
      answeredLast(left) - answeredLast(right) || right.ts.localeCompare(left.ts) || left.actionId.localeCompare(right.actionId),
  );
}

/** True for a decision the owner has ANSWERED: its row stays on the band
 * until the producer resolves it (follow-through stays distinct from the
 * choice), but the ball is with Gru — it no longer needs the owner. */
export function isAnsweredRow(row: OwnerRow): boolean {
  return row.kind === 'decision' && isAnsweredNotification(row.notification);
}

/** The same rule on a bare notification, for the surfaces that never build
 * rows (the bell badge, toasts): a typed decision with a recorded choice.
 * A row with no decision cannot be answered, whatever else it carries. */
export function isAnsweredNotification(notification: {
  readonly decision?: unknown;
  readonly decidedAt?: string | null;
}): boolean {
  return (
    notification.decision !== null &&
    notification.decision !== undefined &&
    notification.decidedAt !== null &&
    notification.decidedAt !== undefined
  );
}

/** The expander's words for the rows behind the window: what is still owed
 * and what is already answered are never lumped together as "pending". */
export function ownerHiddenLabel(hidden: readonly OwnerRow[]): string {
  const answered = hidden.filter(isAnsweredRow).length;
  const owed = hidden.length - answered;
  if (owed > 0 && answered > 0) return `+${owed} older pending · +${answered} answered`;
  return owed > 0 ? `+${owed} older pending` : `+${answered} answered`;
}

export interface OwnerCounts {
  /** Rows that still need the owner: open decisions, notices, proposals
   * and ready PRs/MRs. */
  readonly needsYou: number;
  /** Answered decisions Gru is carrying out. */
  readonly answered: number;
}

/** What the band header counts (owner pick 2026-11-20): an answered
 * decision keeps its row visible until its follow-through resolves, but it
 * is counted as Gru's work, never as something the owner still owes. */
export function ownerCounts(rows: readonly OwnerRow[]): OwnerCounts {
  const answered = rows.filter(isAnsweredRow).length;
  return { needsYou: rows.length - answered, answered };
}

/** The pending count shown in the band header and the section strip —
 * owed actions, not unseen rows, and not answers awaiting follow-through.
 * Opening the board or the bell never changes it. */
export function ownerPendingCount(snapshot: BoardSnapshot): number {
  return ownerCounts(ownerRows(snapshot)).needsYou;
}

/** What the FOR YOU pill says is waiting (owner look 2026-11-20):
 *   - `question`: something only the owner can answer or do — an open
 *     decision, an owner notice, or a lesson proposal;
 *   - `ready`: only good news is waiting — ready PRs/MRs (and, at most,
 *     answers Gru is already carrying out);
 *   - `answered`: only answers awaiting Gru's follow-through;
 *   - `clear`: nothing. */
export type OwnerAttention = 'question' | 'ready' | 'answered' | 'clear';

export function ownerAttention(rows: readonly OwnerRow[]): OwnerAttention {
  if (rows.length === 0) return 'clear';
  if (rows.some((row) => row.kind !== 'pr' && !isAnsweredRow(row))) return 'question';
  return rows.some((row) => row.kind === 'pr') ? 'ready' : 'answered';
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
