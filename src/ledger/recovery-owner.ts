import type { ObligationRecord } from './api.js';

export type RecoverySubjectKind = 'directive' | 'rebrief';

export interface RecoverySubject {
  readonly kind: RecoverySubjectKind;
  readonly id: string;
  readonly jobId: string;
  readonly snapshotSha256: string;
  readonly snapshot: unknown;
}

/** A non-executing transfer binds a real job-wide owner stop to the exact
 * unresolved subject. It is never completion or permission to resume. */
export interface RecoveryOwnerTransfer {
  readonly subject: RecoverySubject;
  readonly debtId: string;
  readonly generation: number;
  readonly target: Pick<ObligationRecord, 'id' | 'jobId' | 'logicalStep' | 'generation' | 'planRevision' | 'category' | 'authority' | 'nextAction' | 'firstOriginSeq' | 'lastOriginSeq'>;
  readonly epoch: number;
}

export interface RecoveryDecisionHistory {
  readonly eventSeq: number;
  readonly fingerprint: string;
  readonly generation: number;
  readonly successorId: string | null;
  readonly ownerTransfer: RecoveryOwnerTransfer | null;
  readonly currentInspectionObligationId: string | null;
}

export interface RecoveryOwnerActionInput {
  readonly kind: RecoverySubjectKind;
  readonly subjectId: string;
  readonly resolutionId: string;
  readonly transferEventSeq: number;
  readonly expectedTransferFingerprint: string;
  readonly expectedSubjectSha256: string;
  readonly expectedTargetGeneration: number;
  readonly expectedTargetPlanRevision: number;
  readonly expectedLineageSha256: string;
  readonly expectedEpoch: number;
  readonly expectedHead: string;
  readonly expectedWorkRevision: number;
  readonly expectedContractSha256: string;
  readonly reason: string;
}
