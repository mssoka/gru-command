import { LIVE_DIRECTIVE_STATES } from './directives.js';
import type { LedgerApi } from './api.js';

import type { MailboxDisposition, MailboxItem, MailboxReference, MailboxState } from '../gru-mailbox/types.js';
export type { MailboxDisposition, MailboxItem, MailboxReference, MailboxState, MailboxSnapshot, MailboxReason, MailboxReceipt, MailboxDelivery } from '../gru-mailbox/types.js';
export class MailboxConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'MailboxConflictError'; }
}

function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '' || value.length > 4000) {
    throw new Error(`mailbox ${key} must be a nonblank string (at most 4000 characters)`);
  }
  return value;
}
export function validateMailboxDisposition(
  ledger: LedgerApi, item: MailboxItem, raw: unknown, now: string, allowElapsedRecheck = false,
): MailboxDisposition {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('mailbox disposition must be an object');
  const input = raw as Record<string, unknown>;
  if ('sourceObligationId' in input) throw new Error('mailbox sourceObligationId is server-owned; omit it when recording a disposition');
  const basis = text(input, 'basis');
  if (basis !== item.basis) throw new MailboxConflictError('mailbox basis changed; read the item again before recording a disposition');
  const state = text(input, 'state');
  if (!['needs-gru', 'waiting', 'delegated', 'resolved'].includes(state)) throw new Error('unknown mailbox disposition state');
  const owner = text(input, 'owner');
  const detail = text(input, 'detail');
  const dependency = input['dependency'] === undefined || input['dependency'] === null ? null : text(input, 'dependency');
  const recheckAt = input['recheckAt'] === undefined || input['recheckAt'] === null ? null : text(input, 'recheckAt');
  if (recheckAt !== null && (!Number.isFinite(Date.parse(recheckAt)) || new Date(recheckAt).toISOString() !== recheckAt || (!allowElapsedRecheck && Date.parse(recheckAt) <= Date.parse(now)))) {
    throw new Error('mailbox recheckAt must be a future canonical ISO timestamp');
  }
  if (!Array.isArray(input['references']) || input['references'].length > 50) throw new Error('mailbox references must be an array (at most 50)');
  const references: MailboxReference[] = input['references'].map((rawRef: unknown) => {
    if (typeof rawRef !== 'object' || rawRef === null || Array.isArray(rawRef)) throw new Error('mailbox reference must be an object');
    const ref = rawRef as Record<string, unknown>;
    const kind = text(ref, 'kind');
    const id = text(ref, 'id');
    if (!['decision', 'directive', 'obligation', 'agent', 'event'].includes(kind)) throw new Error(`unsupported mailbox reference kind ${kind}`);
    const record = kind === 'decision' ? ledger.getDecision(id) : kind === 'directive' ? ledger.getDirective(id)
      : kind === 'obligation' ? ledger.getObligation(id) : kind === 'agent' ? ledger.getAgent(id) : ledger.getEvent(Number(id));
    if (record === null || (kind === 'decision' ? !('subject' in record) || record.subject !== item.subject
      : !('jobId' in record) || item.jobId === null || record.jobId !== item.jobId)) {
      throw new MailboxConflictError(`mailbox reference ${kind}:${id} is missing or belongs to another subject`);
    }
    if (kind === 'decision' && ledger.getDecision(id)!.clearedAt !== null) throw new MailboxConflictError(`mailbox reference decision:${id} has been cleared`);
    return { kind: kind as MailboxReference['kind'], id };
  });
  if (state === 'waiting' || state === 'delegated') {
    if (dependency === null || recheckAt === null || references.length === 0) throw new Error('waiting/delegated mailbox items require a dependency, future recheckAt and durable references');
    if (owner === 'gru' || owner === 'code') throw new Error('waiting/delegated mailbox items require the actual next-action owner');
    for (const ref of references) {
      const live = ref.kind === 'obligation' ? ['open', 'waiting'].includes(ledger.getObligation(ref.id)!.state)
        : ref.kind === 'agent' ? ['streaming', 'spawning'].includes(ledger.getAgent(ref.id)!.state)
        : ref.kind === 'directive' ? (LIVE_DIRECTIVE_STATES as readonly string[]).includes(ledger.getDirective(ref.id)!.state) : true;
      if (!live) throw new MailboxConflictError(`mailbox reference ${ref.kind}:${ref.id} no longer supports live follow-up`);
    }
  }
  if (state === 'delegated') {
    const control = references.some((ref) => {
      if (ref.kind === 'directive') {
        const row = ledger.getDirective(ref.id)!;
        return (LIVE_DIRECTIVE_STATES as readonly string[]).includes(row.state) && row.admissionMinion === owner;
      }
      if (ref.kind === 'agent') {
        const row = ledger.getAgent(ref.id)!;
        return row.id === owner && (row.state === 'streaming' || row.state === 'spawning');
      }
      return false;
    });
    const followUp = references.some((ref) => ref.kind === 'obligation' && ['open', 'waiting'].includes(ledger.getObligation(ref.id)!.state));
    if (!control || !followUp) throw new MailboxConflictError('delegation requires actual live control/work owned by owner and an open follow-up obligation');
  }
  if (state === 'resolved') {
    if (item.producerOwned && item.reasons.length > 0) throw new MailboxConflictError('producer-owned incident closes only when its producer succeeds');
    const supported = references.some((ref) => {
      if (ref.kind === 'decision') {
        const row = ledger.getDecision(ref.id)!;
        return row.clearedAt === null && row.basisFingerprint === item.basis && ['acted', 'dismissed', 'superseded'].includes(row.decision)
          && item.reasons.every((reason) => row.covers.includes(reason.signal));
      }
      if (ref.kind === 'obligation') {
        const row = ledger.getObligation(ref.id)!;
        return row.state === 'settled' && row.settlement !== null && row.receiptCorrelation !== null && row.recordedReceipts.length > 0
          && item.reasons.every((reason) => reason.signal === 'obligation' && reason.label === `follow-up ${row.id}`);
      }
      return false;
    });
    if (!supported) throw new MailboxConflictError('resolution requires an exact-basis decision covering every reason or an inspected correlated settled obligation receipt');
  }
  return { basis, state: state as MailboxState, owner, detail, dependency, recheckAt, references, recordedAt: now };
}
