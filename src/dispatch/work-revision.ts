import type { JobAmendmentRecord } from '../review-inputs/amendments.js';

/**
 * Work-revision continuation text (owner rule 4, 2026-10-08): the approved
 * material amendments a lane has not yet delivered travel to its minion
 * ONCE, combined in version order, with their canonical bytes — never one
 * continuation per amendment, never a paraphrase. The delivery that settles
 * the carrying request is the service-bound acknowledgement of the
 * revision (the request row/marker records it; `job.delivered` carries it).
 */
export function renderRevisionContinuation(input: {
  readonly jobId: string;
  /** The required work revision the request was composed with. */
  readonly revision: number;
  /** The revision the lane's newest delivery carried. */
  readonly deliveredRevision: number;
  /** Material amendments in (deliveredRevision, revision], version order. */
  readonly pending: readonly JobAmendmentRecord[];
  /** Amendment id → the version that superseded it: a superseded pending
   * amendment is named NOT EFFECTIVE and its body is withheld, so the
   * minion never receives contradictory instructions. */
  readonly supersededBy?: ReadonlyMap<string, number>;
  /** false = the carrying turn records no delivery of its own (a provider
   * continuation resuming an interrupted turn): the block must not claim a
   * revision receipt. Default true. */
  readonly receipt?: boolean;
}): string {
  if (input.pending.length === 0) return '';
  const lines: string[] = [
    `===== CONTRACT REVISION ${input.revision} — APPROVED MATERIAL AMENDMENTS (attached once by the service) =====`,
    `Job ${input.jobId}: your lane's last delivery carried contract revision ${input.deliveredRevision}.`,
    'The approved amendments below change what the candidate must contain. Implement every one of them',
    'together with the request above, in this single continuation; the lane cannot be reviewed again until',
    'a delivery carries this revision.',
  ];
  for (const amendment of input.pending) {
    const superseder = input.supersededBy?.get(amendment.id);
    lines.push(
      '',
      `## Amendment #${amendment.version} (material) — accepted ${amendment.createdAt}`,
      `approval: ${amendment.approval.by} — ${amendment.approval.reference}`,
      `supersedes: ${amendment.supersedes.length === 0 ? 'none' : amendment.supersedes.join(', ')}`,
      `body_sha256: ${amendment.bodySha256}`,
    );
    if (superseder === undefined) {
      lines.push('', amendment.body);
    } else {
      lines.push(`status: NOT EFFECTIVE — superseded by amendment #${superseder}; do not implement it (body withheld)`);
    }
  }
  lines.push(
    '',
    ...(input.receipt === false
      ? [
        'This turn resumes interrupted work: apply the amendments above to it. The lane is reviewed only after a',
        `delivery carries contract revision ${input.revision}.`,
      ]
      : [
        `The service records the delivery of this turn as contract revision ${input.revision}.`,
        `Name "contract revision ${input.revision}" in your completion report.`,
      ]),
    `===== END CONTRACT REVISION ${input.revision} =====`,
  );
  return lines.join('\n');
}

/** The revision line a FRESH session gets instead of the continuation
 * block: its effective contract already carries every amendment's text, so
 * repeating the bodies would break the once-only continuation. */
export function renderFreshRevisionNote(revision: number): string {
  return [
    `===== CONTRACT REVISION ${revision} =====`,
    `The effective contract above is contract revision ${revision}: implement every effective material amendment in it.`,
    `The service records the delivery of this turn as contract revision ${revision}.`,
    `Name "contract revision ${revision}" in your completion report.`,
  ].join('\n');
}

/** Append the continuation block (when any material amendment is pending)
 * to a directive, separated by a blank line. */
export function withRevisionContinuation(directive: string, block: string): string {
  return block === '' ? directive : `${directive}\n\n${block}`;
}
