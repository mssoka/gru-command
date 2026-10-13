import { randomUUID } from 'node:crypto';
import type { EventRecord, LedgerApi } from '../ledger/api.js';
import type { AgentHandle } from '../runtime/types.js';

const PENDING = 'supervision.restart-cleanup-pending';
const CONFIRMED = 'supervision.restart-cleanup-confirmed';
const KINDS = [PENDING, CONFIRMED, 'supervision.restart-rejected'];
const PAGE_SIZE = 100;

export interface RestartCleanupDebt {
  readonly generation: string | null;
  readonly originSeq: number;
  readonly jobId: string | null;
  readonly agentId: string | null;
  readonly replacementAgentId: string | null;
}

function payload(event: EventRecord): Record<string, unknown> {
  return typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown> : {};
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}
function generation(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
    ? value : null;
}

/** Receipt replay never reconstructs a vanished physical handle. Only its
 * originating native custodian can write the generation-bound proof. */
export class RestartCleanupJournal {
  private cursor = 0;
  private readonly debts = new Map<number, RestartCleanupDebt>();
  private readonly origins = new Map<number, RestartCleanupDebt>();
  private readonly owned = new WeakMap<AgentHandle, RestartCleanupDebt>();
  private readonly writing = new WeakSet<AgentHandle>();

  constructor(private readonly ledger: LedgerApi) {}

  begin(handle: AgentHandle, jobId: string | null, agentId: string): RestartCleanupDebt {
    const previous = this.owned.get(handle);
    if (previous !== undefined) return previous;
    if (this.writing.has(handle)) throw new Error('restart cleanup pending journal write is in progress; custody remains unknown');
    this.writing.add(handle);
    try {
      const generation = randomUUID();
      const event = this.ledger.appendCustomEvent({ kind: PENDING, jobId, agentId,
        payload: { generation, replacement_agent_id: handle.id } });
      const debt = { generation, originSeq: event.seq, jobId, agentId, replacementAgentId: handle.id };
      this.owned.set(handle, debt);
      return debt;
    } finally { this.writing.delete(handle); }
  }

  confirm(debt: RestartCleanupDebt): void {
    if (debt.generation === null) throw new Error('legacy restart cleanup lacks exact physical generation proof');
    this.ledger.appendCustomEvent({ kind: CONFIRMED, jobId: debt.jobId, agentId: debt.agentId,
      payload: { generation: debt.generation, origin_seq: debt.originSeq,
        replacement_agent_id: debt.replacementAgentId, disposal_acknowledged: true, cessation: 'ceased' } });
  }

  unresolved(jobId: string): readonly RestartCleanupDebt[] {
    this.refresh();
    return [...this.debts.values()].filter((debt) => debt.jobId === jobId);
  }

  private refresh(): void {
    for (;;) {
      const page = this.ledger.listEventsAfter(this.cursor, { kinds: KINDS, order: 'asc', limit: PAGE_SIZE });
      for (const event of page) {
        const data = payload(event);
        if (event.kind === PENDING) {
          const debt = { originSeq: event.seq, generation: generation(data.generation),
            jobId: event.jobId, agentId: event.agentId, replacementAgentId: text(data.replacement_agent_id) };
          this.debts.set(event.seq, debt);
          this.origins.set(event.seq, debt);
        } else if (event.kind === 'supervision.restart-rejected' && data.disposition === 'cleanup-unconfirmed') {
          const origin = typeof data.origin_seq === 'number' ? this.origins.get(data.origin_seq) : undefined;
          const bound = origin !== undefined && origin.generation !== null && origin.generation === data.generation &&
            origin.jobId === event.jobId && origin.agentId === event.agentId && origin.replacementAgentId === data.replacement_agent_id;
          // Legacy/malformed audits without an exact originating journal entry
          // retain event-identity debt. ID-only confirmations can never clear it.
          if (!bound) this.debts.set(event.seq, { originSeq: event.seq, generation: null,
            jobId: event.jobId, agentId: event.agentId, replacementAgentId: text(data.replacement_agent_id) });
        } else if (event.kind === CONFIRMED && typeof data.origin_seq === 'number') {
          const debt = this.debts.get(data.origin_seq);
          if (debt !== undefined && debt.generation !== null && debt.replacementAgentId !== null && debt.agentId !== null &&
            event.seq > debt.originSeq && data.generation === debt.generation && event.jobId === debt.jobId &&
            event.agentId === debt.agentId && data.replacement_agent_id === debt.replacementAgentId &&
            data.disposal_acknowledged === true && data.cessation === 'ceased') {
            this.debts.delete(debt.originSeq);
            // The originating pending entry can never be reclassified once its
            // exact generation is confirmed; drop its identity with the debt so
            // the origins map stays bounded (audit events replay in ascending
            // order, so no later audit can still need it).
            this.origins.delete(debt.originSeq);
          }
        }
        this.cursor = event.seq;
      }
      if (page.length < PAGE_SIZE) return;
    }
  }
}

export function restartCleanupDiagnostic(debt: RestartCleanupDebt): string {
  return `restart cleanup unconfirmed: ${debt.replacementAgentId ?? '(unknown minion)'} ` +
    `(generation ${debt.generation ?? 'legacy/unknown'}, originating event ${debt.originSeq}). ` +
    'Only the original native owner can record disposal acknowledgment and positive cessation proof. ' +
    'If that owner was lost in a hard crash, proof is unavailable and custody remains blocked; ACK, restart or successor cleanup cannot release it.';
}
