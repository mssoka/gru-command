export type MailboxState = 'needs-gru' | 'delegated' | 'waiting' | 'resolved';
export interface MailboxReference {
  readonly kind: 'decision' | 'directive' | 'obligation' | 'agent' | 'event';
  readonly id: string;
}
export interface MailboxDisposition {
  /** Server-owned read-model provenance; never accepted as a caller ruling. */
  readonly sourceObligationId?: string;
  readonly basis: string;
  readonly state: MailboxState;
  readonly owner: string;
  readonly detail: string;
  readonly dependency: string | null;
  readonly recheckAt: string | null;
  readonly references: readonly MailboxReference[];
  readonly recordedAt: string;
}
export interface MailboxReceipt {
  readonly basis: string;
  readonly source: 'chat' | 'wake';
  readonly deliveryId: string;
  readonly receivedAt: string;
  readonly attentionKey: string;
}
export interface MailboxReason {
  readonly signal: string;
  readonly label: string;
  readonly basis: string;
}
export interface MailboxItem {
  readonly id: string;
  readonly subject: string;
  readonly kind: 'job' | 'incident';
  readonly jobId: string | null;
  readonly title: string;
  readonly severity?: 'info' | 'error';
  readonly reasons: readonly MailboxReason[];
  readonly basis: string;
  readonly notificationIds: readonly string[];
  readonly producerOwned: boolean;
  readonly state: MailboxState;
  readonly owner: string;
  readonly disposition: MailboxDisposition | null;
  readonly receipt: MailboxReceipt | null;
  readonly references: readonly MailboxReference[];
  readonly restrictions: readonly string[];
  /** Producer/obligation/decision follow-up clocks reopen attention, never operational authority. */
  readonly followUpAt?: readonly string[];
  /** Stable admission identity for this exact basis and follow-up incarnation. */
  readonly attentionKey: string;
}
/** Serializable evidence captured from the exact rendered row, before transport acceptance. */
export interface MailboxDelivery {
  readonly deliveryKey: string;
  readonly id: string;
  readonly jobId: string | null;
  readonly basis: string;
  readonly attentionKey: string;
  readonly reasons: readonly MailboxReason[];
  readonly notificationIds: readonly string[];
}
export interface MailboxSnapshot {
  readonly items: readonly MailboxItem[];
  readonly counts: {
    readonly threads: number;
    readonly incidents: number;
    readonly notifications: number;
    readonly needsGru: number;
  };
}
