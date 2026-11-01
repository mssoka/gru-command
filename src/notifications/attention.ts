/**
 * Owner-attention registry (owner release 2026-10-11).
 *
 * The responsibility chain is authoritative: Silas owns routine minion
 * recovery and re-arming within approved direction and policy; decisions
 * beyond Silas go to Gru, who determines a new direction and re-arms
 * through supported operations controls; only decisions genuinely
 * requiring the owner's judgment or authority reach FOR YOU.
 *
 * This registry is the ONE server-side authority for which notification
 * kinds may occupy the owner surface. Producers still declare their
 * intended routing, but the NotificationCenter enforces the registry:
 *
 *   - `owner-required`  — the kind always routes `needs-owner`
 *     (lessons proposals, typed Gru escalations, owner-only notices).
 *   - `owner-allowed`   — the producer's classification decides, because
 *     the same kind legitimately reports both owner-relevant capability
 *     gaps and passive feed context (`decisions.degraded.*`).
 *   - `owner-forbidden` — a `needs-owner` request is routed to Gru
 *     (`action-required`) instead and logged. This is the default for
 *     every unregistered kind: an unknown incident is TRIAGED by Gru, so
 *     no operational item and no unrecognized stop can quietly ring the
 *     owner's bell.
 *
 * Routine recovery (crash-loop breakers, provider-wall stops, re-brief
 * and directive reconciliation, orphaned turns, false recoveries) is
 * deliberately absent from the owner lists — those stay machine-side.
 */

export type OwnerAttention = 'owner-required' | 'owner-allowed' | 'owner-forbidden';

/** Kinds that are always owner-facing, exact match. */
const OWNER_REQUIRED_KINDS: readonly string[] = [
  'lessons.proposal',
  'lessons.proposal-conflict',
  'gru.owner-escalation',
  'port-squat',
  'roll-port-squat',
  // Install prerequisite (issue #444): only the owner can install the
  // Perkins GitHub App, and without its bundle every github.com review
  // verdict dies on a self-author 422. The boot check posts it and resolves
  // it once the bundle (or a disabled review gate) makes it moot.
  'perkins-app-bundle-missing',
  'worktree-sweep-paused',
  // Unconfirmed native cleanup after a refused replacement can need a human
  // when the original owner is lost (issue #280): main's owner-facing notice.
  'supervision.restart-cleanup-unconfirmed',
  // An explicit owner hold could not prove every producer stopped (issue
  // #455): the residue is the owner's to settle — never a silent downgrade
  // to an administrative park.
  'job-stop-unproven',
  // Vector's raids (#351): raid_mode = "proposed" puts each raid Gru picks
  // in FOR YOU for the owner's Accept or Decline; fix_mode = "proposed"
  // does the same for each break-in's fix heist.
  'vector.raid-proposal',
  'vector.fix-proposal',
  // Onboarding heists (#427): onboarding mode = "proposed" puts each managed
  // repository whose origin has no manifest in FOR YOU for Accept or Decline.
  'onboarding.proposal',
  // Intake slicing (#429): a planning minion's sliced plan, with any source
  // conflicts first, is the owner's to review in intake.
  'intake.slicing-result',
  // Cleanup and repair (#427 PR 2b): deleting the saved work of jobs that
  // ended 30 days ago, and discarding a lane whose repository's name now
  // holds a different repository, lose data, so each is the owner's Accept
  // or Decline.
  'worktree.preserve-expiry',
  'worktree.repo-mismatch',
  // The disk budget (#427 PR 3): reclaim_mode = "proposed" puts the lossless
  // steps GC would take to get under its budget or above the floor in FOR
  // YOU for Accept or Decline.
  'disk.reclaim-proposal',
  // Owner approval of abandoning one directive request (#523): Gru proposes,
  // the owner's Approve makes the server carry out the abandonment.
  'owner-approval.directive-abandon',
];

/** Kinds that are always owner-facing, prefix match (dynamic suffixes,
 * including the worktree-scoped `worktree-sweep-paused:<id>:<pause>` form). */
const OWNER_REQUIRED_PREFIXES: readonly string[] = [
  'gru.wake-blocked.',
  // Job-scoped unproven producer stop (issue #455): one owner incident per
  // job, reused across boot re-proofs and resolved when a later pass proves it.
  'job-stop-unproven:',
  'gru.wake-blocked-mailbox.',
  'gru.wake-failed-escalation.',
  'decisions.enforce-gate.',
  'worktree-sweep-paused:',
  // Reserved owner-decision stop for an owner-transferred recovery (issue #280).
  'silas.recovery-owner-transfer.',
];

/** Kinds whose producer decides between owner attention and passive feed. */
const OWNER_ALLOWED_PREFIXES: readonly string[] = ['decisions.degraded.'];

/** Kinds that only ever route `needs-owner` with a typed reserved
 * decision attached (validated at the write boundary). */
const DECISION_REQUIRED_KINDS: readonly string[] = [
  'gru.owner-escalation', 'vector.raid-proposal', 'vector.fix-proposal', 'onboarding.proposal', 'worktree.preserve-expiry', 'worktree.repo-mismatch',
  'disk.reclaim-proposal', 'owner-approval.directive-abandon',
];

/** Typed owner decisions whose PRODUCER service executes the recorded
 * choice on its own `notification.decision` subscription / reconcile pass and
 * then resolves the card (#506). These stay passive for Gru: a wake would
 * invite a duplicate operation, and a Gru resolution before the producer's
 * pass reads the card would hide the accepted work from its owner service.
 * Every other typed decision (Gru escalations and unknown future kinds)
 * creates Gru's follow-through debt. */
const PRODUCER_FOLLOWED_DECISION_KINDS: readonly string[] = [
  'vector.raid-proposal',
  'vector.fix-proposal',
  'onboarding.proposal',
  'worktree.preserve-expiry',
  'worktree.repo-mismatch',
  'disk.reclaim-proposal',
  'owner-approval.directive-abandon',
];
const PRODUCER_FOLLOWED_DECISION_PREFIXES: readonly string[] = ['worktree-sweep-paused:'];

export function producerFollowsDecisionThrough(kind: string): boolean {
  return PRODUCER_FOLLOWED_DECISION_KINDS.includes(kind) ||
    PRODUCER_FOLLOWED_DECISION_PREFIXES.some((prefix) => kind.startsWith(prefix));
}

export function ownerAttentionFor(kind: string): OwnerAttention {
  if (OWNER_REQUIRED_KINDS.includes(kind)) return 'owner-required';
  if (OWNER_REQUIRED_PREFIXES.some((prefix) => kind.startsWith(prefix))) return 'owner-required';
  if (OWNER_ALLOWED_PREFIXES.some((prefix) => kind.startsWith(prefix))) return 'owner-allowed';
  return 'owner-forbidden';
}

/** Owner escalations must state which reserved decision cannot safely be
 * made by Silas/Gru — without typed metadata they are refused loudly. */
export function requiresTypedDecision(kind: string): boolean {
  return DECISION_REQUIRED_KINDS.includes(kind);
}

/** The routing a producer's request resolves to, with the registry
 * enforced. Returns the effective routing plus whether the request was
 * overridden so the caller can leave an audit note. */
export function resolveNotificationRouting(
  kind: string,
  requested: 'fyi' | 'action-required' | 'needs-owner',
): { readonly routing: 'fyi' | 'action-required' | 'needs-owner'; readonly overridden: boolean } {
  const attention = ownerAttentionFor(kind);
  if (attention === 'owner-required') {
    return { routing: 'needs-owner', overridden: requested !== 'needs-owner' };
  }
  if (requested === 'needs-owner' && attention === 'owner-forbidden') {
    return { routing: 'action-required', overridden: true };
  }
  return { routing: requested, overridden: false };
}
