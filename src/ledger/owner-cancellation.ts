/**
 * Owner cancellation allowlist (owner amendment j-1117,
 * `owner-close-seventeen-parked-20261006`): the EXACT named parked legacy
 * lanes the owner authorized for administrative cancellation.
 *
 * This is an exact action allowlist, never a scan set: the closeout
 * operation accepts one named id at a time and refuses anything not
 * listed here. The named jobs have no registered PR and NULL legacy
 * report metadata — the cancellation form must never invent a provider
 * receipt, PR, deliverable, commissioner or target for them, and no
 * automatic batch apply exists.
 */

/** The owner ruling this allowlist was staged under. The operation
 * stamps it into the cancellation audit next to the caller's authority
 * reference, which is recorded verbatim — the reference is evidence
 * text, not the thing that grants authority; allowlist membership plus
 * the authenticated endpoint is the executable guard. */
export const OWNER_CANCELLATION_RULING = 'j-1117';

/** The exact owner-authorized cancellation list, verbatim from the
 * owner-close-seventeen-parked-20261006 amendment. */
export const OWNER_CANCELLATION_JOB_IDS: readonly string[] = Object.freeze([
  'gc-freeze-heat-evidence',
  'silas-context-rotation',
  'pr135-r12-review-blind-hunter-7465b69',
  'repo-status-mockups',
  'abort-evidence-verification',
  'abort-evidence-edge',
  'pr142-verification-bounded-20260930',
  'dashboard-header-mockups',
  'pr151-independent-blind-90ab1b4-20261001',
  'pr142-whole-adversarial-09ed-20261002-admission2',
  'pr142-whole-adversarial-09ed-fresh-after-length-20261002',
  'continuous-followthrough-gap-audit-20261002',
  'perkins-abort-census-20261002',
  'pr148-whole-adversarial-900-20261003',
  'pr148-whole-edge-900-20261003',
  'pr148-whole-verification-900-20261003',
  'pr144-review-packet-recovery-743b57e-20261003',
]);

/** Membership in the exact owner-authorized list. */
export function isOwnerCancellationListed(jobId: string): boolean {
  return OWNER_CANCELLATION_JOB_IDS.includes(jobId);
}
