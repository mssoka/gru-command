import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { LedgerApi } from '../../src/ledger/api.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { inspectDirectiveCheckpoint, prepareDirectiveBinding, prepareDirectiveProducer, recordDirectiveProducerCessation, type DirectiveProducer, type DirectiveTurnIdentity } from '../../src/runtime/directive-checkpoint.js';
import type { AgentHandle, PromptOptions, AgentState } from '../../src/runtime/types.js';

/** HTTP/ledger doubles retain real persisted native evidence. Only adapter
 * tests attest the SDK boundary; these fixtures model its accepted user and
 * correlated terminal entries instead of inventing ledger receipts. */
export class DirectiveNativeFixture {
  readonly sessionId: string = randomUUID();
  private parentId: string | null = null;
  private current: DirectiveTurnIdentity | null = null;
  private readonly producers = new Map<string, DirectiveProducer>();
  constructor(readonly file: string, private readonly agentId: string) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file) && readFileSync(file, 'utf8').trim() !== '') {
      const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { type: string; id: string });
      this.sessionId = rows[0]!.id; this.parentId = rows.filter((row) => row.type !== 'session').at(-1)?.id ?? null;
    } else writeFileSync(file, `${JSON.stringify({ type: 'session', id: this.sessionId, version: 3 })}\n`);
  }
  prepare = (identity: DirectiveTurnIdentity): DirectiveProducer => {
    const existing = this.producers.get(identity.requestId);
    if (existing !== undefined) return existing;
    const producer = prepareDirectiveProducer({ identity, agentId: this.agentId, sessionId: this.sessionId, sessionFile: this.file });
    this.producers.set(identity.requestId, producer);
    return producer;
  };
  ceased(): void { for (const producer of this.producers.values()) recordDirectiveProducerCessation(producer); }
  inspect = (identity: DirectiveTurnIdentity) => inspectDirectiveCheckpoint(this.file, identity);
  begin(text: string, options?: PromptOptions): void {
    this.current = options?.directive?.identity ?? null;
    if (options?.directive !== undefined) {
      options.directive.beforeAdmission();
      this.prepare(options.directive.identity);
      prepareDirectiveBinding({ identity: options.directive.identity, runtime: 'pi', agentId: this.agentId,
        sessionId: this.sessionId, sessionFile: this.file, text, authorityManifest: 'deterministic HTTP fixture' });
    }
    this.append({ role: 'user', content: [{ type: 'text', text }] });
    if (options?.directive !== undefined) {
      const proof = this.inspect(options.directive.identity);
      if (proof.state === 'unknown') throw new Error(proof.reason);
      options.directive.onAdmitted(proof.binding);
    }
  }
  end(ok = true): void {
    this.append({ role: 'assistant', stopReason: ok ? 'stop' : 'error', content: [{ type: 'text', text: 'native fixture terminal' }] });
    // Force durable terminal readback before caller settlement.
    if (this.current !== null) this.inspect(this.current);
    this.current = null;
  }
  private append(message: Record<string, unknown>): void {
    const id = randomUUID();
    appendFileSync(this.file, `${JSON.stringify({ type: 'message', id, parentId: this.parentId, message })}\n`);
    this.parentId = id;
  }
}


/** Explicit pre-native-protocol persisted row for historical event decoders.
 * New-protocol tests must use actual native admission, never this seeding seam. */
export function markHistoricalDirectiveFixture(ledger: LedgerApi, requestId: string): void {
  const { db } = ledger as unknown as { readonly db: DatabaseSync };
  db.prepare('UPDATE pending_directives SET request_kind = NULL, authority_epoch = NULL, contract_snapshot = NULL, contract_sha256 = NULL WHERE request_id = ?').run(requestId);
}

/** Persist genuine current-protocol admission for non-runtime ledger consumers. */
export function admitNativeDirectiveFixture(ledger: LedgerApi, requestId: string, minionId: string, file: string): number {
  const row = ledger.getDirective(requestId)!;
  ledger.registerAgent({ id: minionId, role: 'minion', jobId: row.jobId, sessionFile: file, parentage: 'top-level' });
  ledger.setAgentState(minionId, 'idle');
  ledger.prepareDirectiveTarget(requestId, { agentId: minionId, sessionFile: file });
  const native = new DirectiveNativeFixture(file, minionId);
  native.begin('exact approved fixture request', { directive: { identity: ledger.directiveTurnIdentity(requestId), beforeAdmission: () => {}, onAdmitted: (binding) => ledger.bindDirectiveNativeAdmission(binding) } });
  return ledger.getDirective(requestId)!.admissionSeq!;
}

export function withNativeDirectiveFixture(handle: AgentHandle, file: string, onState: (state: AgentState) => void = () => {}): AgentHandle {
  const native = new DirectiveNativeFixture(file, handle.id);
  let disposed = false;
  return {
    ...handle, sessionFile: file, prepareDirectiveProducer: native.prepare, inspectDirective: native.inspect,
    async prompt(text: string, options?: PromptOptions) {
      onState('idle'); native.begin(text, options); onState('streaming');
      try { await handle.prompt(text, options); native.end(handle.health().state === 'idle'); onState(handle.health().state); }
      catch (error) { native.end(false); onState('error'); throw error; }
    },
    async dispose() { await handle.dispose(); native.ceased(); disposed = true; onState('disposed'); },
    cessationEvidence: () => disposed ? 'ceased' : 'unknown',
  };
}
