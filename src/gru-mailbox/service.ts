import { mailboxBasis } from './projection.js';
import type { LedgerApi, NotificationRecord } from '../ledger/api.js';
import type { MailboxDelivery, MailboxItem, MailboxSnapshot } from '../ledger/mailbox.js';

/** Shared board/chat read model; reconciliation executes metadata writes only. */
export class GruMailbox {
  private readonly renderedDeliveries = new WeakMap<NotificationRecord, MailboxDelivery>();
  constructor(private readonly ledger: LedgerApi, private readonly now: () => number = Date.now) {}

  snapshot(): MailboxSnapshot {
    const items = this.ledger.reconcileMailbox(new Date(this.now()).toISOString());
    const live = items.filter((item) => item.state !== 'resolved');
    return { items, counts: {
      threads: live.filter((item) => item.kind === 'job').length,
      incidents: live.filter((item) => item.kind === 'incident').length,
      notifications: new Set(live.flatMap((item) => item.notificationIds)).size,
      needsGru: live.filter((item) => item.state === 'needs-gru').length,
    } };
  }

  page(cursor = '', limit = 50): { readonly items: readonly MailboxItem[]; readonly nextCursor: string | null; readonly counts: MailboxSnapshot['counts'] } {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('mailbox limit must be an integer from 1 to 200');
    const snapshot = this.snapshot();
    const remaining = snapshot.items.filter((item) => item.id.localeCompare(cursor) > 0);
    const items = remaining.slice(0, limit);
    return { items, nextCursor: remaining.length > limit ? items.at(-1)!.id : null, counts: snapshot.counts };
  }

  /** Delivery deduplicates within its grace window; unhandled debt rechecks after five minutes. Fair order survives restart. */
  attentionPage(limit: number): readonly MailboxItem[] {
    return this.snapshot().items.filter((item) => item.state === 'needs-gru' && item.receipt?.attentionKey !== item.attentionKey)
      .sort((a, b) => (a.receipt?.receivedAt ?? '').localeCompare(b.receipt?.receivedAt ?? '') || a.id.localeCompare(b.id)).slice(0, limit);
  }

  disposition(id: string, input: unknown): MailboxItem {
    return this.ledger.recordMailboxDisposition(id, input, new Date(this.now()).toISOString());
  }

  received(id: string, basis: string, source: 'chat' | 'wake', deliveryId: string): void {
    this.ledger.recordMailboxReceipt(id, basis, source, deliveryId, new Date(this.now()).toISOString());
  }

  /** Transport adapter, never a notification write. The existing awareness admission gates and chat conversation own all wakes. */
  attentionRows(limit = 200, offset = 0, passive = false): readonly NotificationRecord[] {
    const items = passive ? this.snapshot().items.filter((item) => item.state !== 'resolved') : this.attentionPage(Number.MAX_SAFE_INTEGER);
    return items.slice(offset, offset + limit).map((item) => this.row(item));
  }

  /** Durable fair admission pages include policy-deferrable items, so a held prefix cannot hide the tail. */
  admissionRows(limit: number): readonly NotificationRecord[] {
    const items = this.attentionPage(Number.MAX_SAFE_INTEGER);
    if (items.length === 0) return [];
    const offset = (this.ledger.readReconcileCursor('gru-mailbox-admission') ?? 0) % items.length;
    const page = [...items.slice(offset), ...items.slice(0, offset)].slice(0, limit);
    this.ledger.writeReconcileCursor({ scope: 'gru-mailbox-admission', cursor: (offset + page.length) % items.length });
    return page.map((item) => this.row(item));
  }

  getAttentionRow(key: string): NotificationRecord | null {
    const item = this.snapshot().items.find((candidate) => this.deliveryKey(candidate) === key && candidate.state !== 'resolved');
    return item === undefined ? null : this.row(item);
  }

  /** Only server-minted rows carry the private brand; genuine ledger rows can never forge it. */
  captureRow(row: NotificationRecord): MailboxDelivery | null {
    const delivery = this.renderedDeliveries.get(row);
    return delivery === undefined ? null : structuredClone(delivery);
  }

  /** Capture the rows actually rendered, before acceptance. Persist deliveries, never adapter rows, for recovery. */
  captureDelivery(rows: readonly NotificationRecord[]): readonly MailboxDelivery[] {
    return rows.flatMap((row) => {
      const delivery = this.captureRow(row);
      return delivery === null ? [] : [delivery];
    });
  }

  receiptCaptured(deliveries: readonly MailboxDelivery[], source: 'chat' | 'wake', deliveryId: string, receivedAt: string): void {
    const now = new Date(this.now()).toISOString();
    for (const delivery of deliveries) this.ledger.recordCapturedMailboxReceipt(delivery, source, deliveryId, receivedAt, now);
  }

  /** Compatible current-key adapter. Recovery must persist captureDelivery's result instead. */
  receiptForKeys(keys: readonly string[], source: 'chat' | 'wake', deliveryId: string): void {
    const items = this.snapshot().items;
    const rows = keys.flatMap((key): NotificationRecord[] => {
      // A bare compatibility key cannot prove the synthetic domain in a real-ID collision.
      if (this.ledger.getNotification(key) !== null) return [];
      const item = items.find((candidate) => this.deliveryKey(candidate) === key);
      if (item === undefined) {
        if (!key.startsWith('mailbox:') || this.ledger.getNotification(key) !== null) return [];
        throw new Error(`mailbox delivery ${key} changed; recovery requires captured evidence`);
      }
      return item.receipt?.deliveryId === deliveryId && item.receipt.source === source ? [] : [this.row(item)];
    });
    this.receiptCaptured(this.captureDelivery(rows), source, deliveryId, new Date(this.now()).toISOString());
  }

  private deliveryKey(item: MailboxItem): string { return `mailbox:${mailboxBasis(item.attentionKey)}`; }
  private row(item: MailboxItem): NotificationRecord {
    const row: NotificationRecord = { id: this.deliveryKey(item), ts: item.receipt?.receivedAt ?? new Date(this.now()).toISOString(),
      kind: this.deliveryKey(item), routing: 'action-required', severity: item.severity ?? 'error', title: item.title,
      detail: JSON.stringify(item),
      agentId: null, shownAt: null, shownBy: null, ackedAt: null, ackedBy: null, resolvedAt: null, resolvedBy: null, resolutionDetail: null,
      decision: null, decidedAt: null, decidedBy: null, decidedOption: null };
    this.renderedDeliveries.set(row, structuredClone({ deliveryKey: row.id, id: item.id, jobId: item.jobId, basis: item.basis,
      attentionKey: item.attentionKey, reasons: item.reasons, notificationIds: item.notificationIds }));
    return row;
  }
}
