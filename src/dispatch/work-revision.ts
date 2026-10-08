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
    lines.push(
      '',
      `## Amendment #${amendment.version} (material) — accepted ${amendment.createdAt}`,
      `approval: ${amendment.approval.by} — ${amendment.approval.reference}`,
      `supersedes: ${amendment.supersedes.length === 0 ? 'none' : amendment.supersedes.join(', ')}`,
      `body_sha256: ${amendment.bodySha256}`,
      '',
      amendment.body,
    );
  }
  lines.push(
    '',
    `The service records the delivery of this turn as contract revision ${input.revision}.`,
    `Name "contract revision ${input.revision}" in your completion report.`,
    `===== END CONTRACT REVISION ${input.revision} =====`,
  );
  return lines.join('\n');
}

/** Append the continuation block (when any material amendment is pending)
 * to a directive, separated by a blank line. */
export function withRevisionContinuation(directive: string, block: string): string {
  return block === '' ? directive : `${directive}\n\n${block}`;
}
