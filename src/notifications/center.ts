import { randomUUID } from 'node:crypto';
import type { LogLevel } from '../logger.js';
import type { BusEvent, EventBus } from '../events/bus.js';
import type { DecisionService } from '../decisions/types.js';
import { eventDecisionRequest, redactedText } from '../decisions/questions.js';
import {
  LedgerApi,
  isOwnerHeldNotificationKind,
  type NotificationRecord,
  type NotificationRouting,
  type NotificationSeverity,
} from '../ledger/api.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * NotificationCenter (EPICS E7 story 2; SPEC ruling 13; owner routing
 * split 2026-09-23): the single write path for notifications. Everything
 * the operator must see lands here — direct posts (supervisor escalations)
 * and FYI derivation from board events (the E6 notification-center feed,
 * made durable) — and every mutation echoes on the event bus so all
 * surfaces converge. Routing is the attention channel: 'action-required'
 * is MACHINE attention (wakes Gru via the awareness policy; never rings
 * the owner bell), 'needs-owner' is the only human-facing class (FOR YOU
 * + bell + digest), 'fyi' is the standing feed. Ack columns stay the
 * proven-ack contract (nothing is "shown" without a receipt).
 *
 * Derivation is event-time only: one bus event → at most one durable row.
 * Snapshots never derive — the standing feed IS the table.
 */

function transcriptTailOf(payload: Record<string, unknown>): string | null {
  for (const key of ['error', 'detail', 'note', 'text']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim() !== '') {
      // REDACT FIRST, then tail: slicing first could split a secret away
      // from its field-name marker, and the tail's redaction pass cannot
      // match a marker it never sees (the raw secret would ride to the
      // provider). Redaction over the bounded window kills the secret
      // wherever its marker sits; the final slice then bounds the payload.
      return redactedText(value, 4_000).slice(-400);
    }
  }
  return null;
}

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
  /** Fired for action-required rows — the machine attention queue that
   * wakes Gru (the awareness layer subscribes independently; this hook is
   * for machine-side observers). */
  readonly onActionRequired?: (notification: NotificationRecord) => void;
  /** Fired for needs-owner rows — the ONLY human-facing class (the chat
   * notice / owner bell surface rides this). */
  readonly onNeedsOwner?: (notification: NotificationRecord) => void;
  readonly log?: Log;
}

export class NotificationCenter {
  private readonly ledger: LedgerApi;
  private readonly onActionRequired: (notification: NotificationRecord) => void;
  private readonly onNeedsOwner: (notification: NotificationRecord) => void;
  private readonly log: Log;
  private decisions: DecisionService | null = null;
  private decisionsReady: () => boolean = () => false;

  constructor(opts: NotificationCenterOptions) {
    this.ledger = opts.ledger;
    this.onActionRequired = opts.onActionRequired ?? (() => {});
    this.onNeedsOwner = opts.onNeedsOwner ?? (() => {});
    this.log = opts.log ?? (() => {});
    // Upgrade persisted owner-held stops BEFORE decision-runtime dedupe and
    // the awareness backlog bind. The snapshot/bell reads the migrated rows.
    this.ledger.migrateOwnerHeldNotifications();
    // Derive AFTER the write that published the event: the bus delivers
    // synchronously in write order, so the source row is already durable
    // when the FYI row lands.
    opts.bus.subscribe((event) => this.derive(event));
  }

  /** Attach the optional async triage observer after composition. */
  setDecisionService(decisions: DecisionService, ready: () => boolean = () => true): void {
    this.decisions = decisions;
    this.decisionsReady = ready;
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
      routing: isOwnerHeldNotificationKind(input.kind) ? 'needs-owner' : input.routing,
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
    if (record.routing === 'needs-owner') this.onNeedsOwner(record);
    return record;
  }

  /** Incident post with durable restart-safe deduplication. */
  postIncident(input: {
    kind: string;
    routing: NotificationRouting;
    severity: NotificationSeverity;
    title: string;
    detail?: string | null;
    agentId?: string | null;
    dedupe: 'unacked' | 'active' | 'all';
  }): NotificationRecord {
    const existing = this.ledger.findNotificationByKind(
      input.kind,
      input.dedupe === 'all' ? 'any' : input.dedupe,
    );
    if (existing !== null) {
      // An active legacy incident may be returned by kind instead of posted
      // anew. Never preserve an obsolete machine routing for an owner stop.
      if (existing.resolvedAt === null && existing.ackedAt === null &&
          (input.routing === 'needs-owner' || isOwnerHeldNotificationKind(input.kind)) &&
          existing.routing === 'action-required') {
        this.ledger.migrateOwnerHeldNotifications();
        const migrated = this.ledger.getNotification(existing.id);
        if (migrated?.routing !== 'needs-owner') {
          throw new Error(`owner-held incident ${existing.kind} retained machine routing; migrate its kind before reuse`);
        }
        return migrated;
      }
      return existing;
    }
    return this.post(input);
  }

  resolveIncidents(kindPrefix: string, by: string): readonly NotificationRecord[] {
    return this.ledger.resolveNotificationsByKindPrefix(kindPrefix, by);
  }

  /** Display receipt (shown:true doctrine) — idempotent per surface. */
  markShown(id: string, surface: string): NotificationRecord | null {
    return this.ledger.markNotificationShown(id, surface);
  }

  /** Human ack; returns the row (null when unknown). */
  ack(id: string, by: string): NotificationRecord | null {
    return this.ledger.ackNotification(id, by);
  }

  /** Bus derivation: board-worthy events become durable rows, once. */
  private derive(event: BusEvent): void {
    // Ack/shown echoes must never re-derive (no loops, no dupes).
    if (event.kind.startsWith('notification.')) return;
    if (event.kind === 'supervision.restart') return; // posted directly with richer context
    const rule = DERIVED_KINDS[event.kind];
    if (rule === undefined) return;
    // Conditional severities: only the error-ish transitions derive. This
    // filter also prevents model calls on token/runtime traffic.
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    if (event.kind === 'job.status' && String(payload.to ?? '') !== 'blocked') return;
    if (event.kind === 'agent.state' && String(payload.to ?? '') !== 'error') return;
    if (event.kind === 'lens.status' && String(payload.to ?? '') !== 'error') return;
    if (this.decisions === null || !this.decisionsReady()) {
      // Preserve the pre-Jev synchronous durability/order when the optional
      // provider is disabled or degraded. No microtask crash window.
      this.recordDerived(event, payload, 'fyi', null);
      return;
    }
    // Commit a provisional deterministic row BEFORE any fallible work:
    // provider latency never blocks EventBus ordering, and a process crash
    // (or a sensor-read throw) cannot erase the operator-visible incident.
    // Jev may enrich this same row.
    const provisional = this.recordDerived(event, payload, 'fyi', null);
    if (provisional === null) return;
    // Bounded sensor context per the amendment: recent same-source history
    // from the durable ledger (STRICTLY PRIOR events — the triggering event
    // is already committed) plus a redacted tail of the event's primary
    // text — never a whole session history, never unredacted bytes.
    const recentEvents = this.ledger.listEvents({ limit: 40 });
    const request = eventDecisionRequest(event, {
      transcriptTail: transcriptTailOf(payload),
      recentSameSourceEvents: recentEvents.filter(
        (row) => row.seq < event.seq && row.agentId !== null && row.agentId === event.agentId,
      ).length,
      recentSameKindEvents: recentEvents.filter(
        (row) => row.seq < event.seq && row.kind === event.kind,
      ).length,
    });
    void this.decisions
      .decide(request)
      .then((outcome) => {
        const actionRoute = outcome.routes.needs_action;
        const classRoute = outcome.routes.event_class;
        const severityRoute = outcome.routes.severity;
        const classAnswer = classRoute.path === 'fallback'
          ? request.fallback.event_class
          : outcome.answers.event_class;
        const severityAnswer = severityRoute.path === 'fallback'
          ? request.fallback.severity
          : outcome.answers.severity;
        // Jev may only route UP (fyi → action-required). A deterministic
        // provenance, a fallback-band action metric, or any low-confidence
        // answer leaves the safe FYI route in place (fail toward attention).
        const routing: NotificationRouting =
          outcome.provenance.source === 'jev' && actionRoute.path !== 'fallback'
            ? 'action-required'
            : 'fyi';
        const severityLabels = ['low', 'medium', 'high'] as const;
        const severityIndex = Math.min(
          severityLabels.length - 1,
          Math.max(0, Math.round(severityAnswer.score)),
        );
        const detail =
          outcome.provenance.source === 'jev'
            ? `Jev ${classAnswer.choice}/${classRoute.path}; severity ${severityLabels[severityIndex]}/${severityRoute.path}; action ${actionRoute.path} (${actionRoute.metricKind} ${actionRoute.metric.toFixed(2)})`
            : null;
        const original = rule.detail(payload);
        const updated = this.ledger.updateNotificationTriage(
          provisional.id,
          routing,
          [original, detail].filter((part): part is string => part !== null && part !== '').join(' — ') || null,
        );
        if (updated !== null && provisional.routing !== 'action-required' && updated.routing === 'action-required') {
          this.onActionRequired(updated);
        }
      })
      .catch((error: unknown) => {
        this.log('error', 'event decision triage failed; provisional deterministic FYI retained', {
          event_kind: event.kind,
          seq: event.seq,
          error: String(error),
        });
      });
  }

  private recordDerived(
    event: BusEvent,
    payload: Record<string, unknown>,
    routing: NotificationRouting,
    triage: string | null,
  ): NotificationRecord | null {
    const rule = DERIVED_KINDS[event.kind];
    if (rule === undefined) return null;
    try {
      const original = rule.detail(payload);
      return this.post({
        kind: event.kind,
        routing,
        severity: rule.severity,
        title: rule.title(event, payload),
        detail: [original, triage].filter((part): part is string => part !== null && part !== '').join(' — ') || null,
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
      return null;
    }
  }
}
