import { randomUUID } from 'node:crypto';
import type { LogLevel } from '../logger.js';
import type { BusEvent, EventBus } from '../events/bus.js';
import {
  LedgerApi,
  type NotificationRecord,
  type NotificationRouting,
  type NotificationSeverity,
} from '../ledger/api.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * NotificationCenter (EPICS E7 story 2; SPEC ruling 13): the single write
 * path for notifications. Everything the operator must see lands here —
 * direct posts (supervisor escalations) and FYI derivation from board
 * events (the E6 notification-center feed, made durable) — and every
 * mutation echoes on the event bus so all surfaces converge: the board
 * snapshot pushes, the chat surfaces action-required items, and the ack
 * columns are the proven-ack contract (nothing is "shown" without a
 * receipt; nothing action-required clears without a human ack).
 *
 * Derivation is event-time only: one bus event → at most one durable row.
 * Snapshots never derive — the standing feed IS the table.
 */

/** Kinds derived from board events (FYI by nature). */
const DERIVED_KINDS: Readonly<Record<string, { severity: NotificationSeverity; title: (e: BusEvent, payload: Record<string, unknown>) => string; detail: (payload: Record<string, unknown>) => string | null }>> = {
  'job.status': {
    severity: 'error',
    title: (e) => `Job ${e.jobId ?? ''} blocked`,
    detail: (p) => `${String(p.from ?? '')} → blocked`,
  },
  'agent.state': {
    severity: 'error',
    title: (e) => `Agent ${e.agentId ?? ''} errored`,
    detail: (p) => (typeof p.error === 'string' && p.error !== '' ? p.error : null),
  },
  'agent.error': {
    severity: 'error',
    title: (e) => `Agent ${e.agentId ?? ''} runtime error`,
    detail: (p) => (typeof p.error === 'string' ? p.error : null),
  },
  'round.verdict': {
    severity: 'info',
    title: (e) => `Round ${e.roundId ?? ''} verdict`,
    detail: (p) => (typeof p.verdict === 'string' ? p.verdict : null),
  },
  'lens.status': {
    severity: 'error',
    title: (e) => `Lens ${e.lens ?? ''} failed`,
    detail: (p) => (typeof p.note === 'string' && p.note !== '' ? p.note : null),
  },
};

export interface NotificationCenterOptions {
  readonly ledger: LedgerApi;
  readonly bus: EventBus;
  /** Fired for action-required rows (the queued item Gru surfaces in chat). */
  readonly onActionRequired?: (notification: NotificationRecord) => void;
  readonly log?: Log;
}

export class NotificationCenter {
  private readonly ledger: LedgerApi;
  private readonly onActionRequired: (notification: NotificationRecord) => void;
  private readonly log: Log;

  constructor(opts: NotificationCenterOptions) {
    this.ledger = opts.ledger;
    this.onActionRequired = opts.onActionRequired ?? (() => {});
    this.log = opts.log ?? (() => {});
    // Derive AFTER the write that published the event: the bus delivers
    // synchronously in write order, so the source row is already durable
    // when the FYI row lands.
    opts.bus.subscribe((event) => this.derive(event));
  }

  /** Direct post — supervisor escalations and product surfaces. */
  post(input: {
    kind: string;
    routing: NotificationRouting;
    severity: NotificationSeverity;
    title: string;
    detail?: string | null;
    agentId?: string | null;
  }): NotificationRecord {
    const record = this.ledger.recordNotification({
      id: randomUUID(),
      ...input,
    });
    this.log(input.severity === 'error' ? 'warn' : 'info', 'notification posted', {
      id: record.id,
      kind: record.kind,
      routing: record.routing,
      severity: record.severity,
      title: record.title,
      agent_id: record.agentId ?? null,
    });
    if (record.routing === 'action-required') this.onActionRequired(record);
    return record;
  }

  /** Display receipt (shown:true doctrine) — idempotent per surface. */
  markShown(id: string, surface: string): NotificationRecord | null {
    return this.ledger.markNotificationShown(id, surface);
  }

  /** Human ack; returns the row (null when unknown). */
  ack(id: string, by: string): NotificationRecord | null {
    return this.ledger.ackNotification(id, by);
  }

  list(opts: { limit?: number; unackedOnly?: boolean } = {}): readonly NotificationRecord[] {
    return this.ledger.listNotifications(opts);
  }

  /** Bus derivation: board-worthy events become durable FYI rows, once. */
  private derive(event: BusEvent): void {
    // Ack/shown echoes must never re-derive (no loops, no dupes).
    if (event.kind.startsWith('notification.')) return;
    if (event.kind === 'supervision.restart') return; // posted directly with richer context
    const rule = DERIVED_KINDS[event.kind];
    if (rule === undefined) return;
    // Conditional severities: only the error-ish transitions derive.
    if (event.kind === 'job.status' && String((event.payload as Record<string, unknown>).to ?? '') !== 'blocked') return;
    if (event.kind === 'agent.state' && String((event.payload as Record<string, unknown>).to ?? '') !== 'error') return;
    if (event.kind === 'lens.status' && String((event.payload as Record<string, unknown>).to ?? '') !== 'error') return;
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    try {
      this.ledger.recordNotification({
        id: randomUUID(),
        kind: event.kind,
        routing: 'fyi',
        severity: rule.severity,
        title: rule.title(event, payload),
        detail: rule.detail(payload),
        agentId: event.agentId,
      });
    } catch (error) {
      // The feed is an observer: a derivation failure must never take the
      // write path (which already committed) down.
      this.log('error', 'notification derivation failed', {
        event_kind: event.kind,
        seq: event.seq,
        error: String(error),
      });
    }
  }
}
