import type { LedgerApi } from '../ledger/api.js';
import type { RecoverySubjectKind } from '../ledger/recovery-owner.js';
import type { RecoveryNotifications } from './rebrief-recovery.js';

/** Only a consumed transfer to a real reserved owner stop rings the owner.
 * Routine uncertainty remains Gru's executable decision, never this card. */
export function surfaceRecoveryOwnerTransfer(
  deps: { readonly ledger: LedgerApi; readonly notifications: RecoveryNotifications },
  kind: RecoverySubjectKind,
  subjectId: string,
): void {
  const view = deps.ledger.recoveryOwnerReadback(kind, subjectId);
  const transfer = view.transfer?.ownerTransfer;
  if (transfer == null) return;
  const route = kind === 'directive' ? 'directives' : 'rebriefs';
  deps.notifications.postIncident({ kind: `silas.recovery-owner-transfer.${kind}.${subjectId}.${transfer.generation}`,
    routing: 'needs-owner', severity: 'error', dedupe: 'active',
    title: `Reserved owner decision: recovery ${subjectId} (job ${transfer.subject.jobId})`,
    detail: `Exact recovery generation ${transfer.generation}, subject ${transfer.subject.snapshotSha256}, transfer event ${view.transfer!.eventSeq} ` +
      `is assigned to real job-wide owner obligation ${transfer.target.id}, generation ${transfer.target.generation}, plan ${transfer.target.planRevision}: ` +
      `${transfer.target.nextAction.kind === 'owner-decision' ? transfer.target.nextAction.decision : ''}. ` +
      `Read authenticated GET /api/silas/${route}/${subjectId} for immutable context, target state, stop lineage and explicit owner recipe. ` +
      `Only explicit owner-attributed POST /api/silas/${route}/${subjectId}/owner-resolution records fresh-successor permission; ` +
      'a separate confirm-stop action resolves only this exact target. Job unpark and notification Ack remain separately explicit. ' +
      'Neither action executes work or proves original effects, completion, cessation or READY. Shared-bearer attribution is not independently verified identity.' });
}
