import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { LedgerApi } from '../../src/ledger/api.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { inspectDirectiveCheckpoint, inspectDirectiveProducers, prepareDirectiveBinding, prepareDirectiveProducer, readDirectiveCompletion, recordDirectiveCompletion, recordDirectiveProducerCessation, type DirectiveProducer, type DirectiveTurnIdentity } from '../../src/runtime/directive-checkpoint.js';
import type { AgentHandle, PromptOptions, AgentState } from '../../src/runtime/types.js';

/** HTTP/ledger doubles retain real persisted native evidence. Only adapter
 * tests attest the SDK boundary; these fixtures model its accepted user and
 * correlated terminal entries instead of inventing ledger receipts. */
export class DirectiveNativeFixture {
  readonly sessionId: string = randomUUID();
  private parentId: string | null = null;
  private current: DirectiveTurnIdentity | null = null;
  private readonly producers = new Map<string, DirectiveProducer>();
  constructor(readonly file: string, private readonly agentId: string, private readonly completionHead?: (identity: DirectiveTurnIdentity) => string | null, cwd?: string) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file) && readFileSync(file, 'utf8').trim() !== '') {
      const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { type: string; id: string });
      this.sessionId = rows[0]!.id; this.parentId = rows.filter((row) => row.type !== 'session').at(-1)?.id ?? null;
    } else writeFileSync(file, `${JSON.stringify({ type: 'session', id: this.sessionId, version: 3, cwd })}\n`);
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
    if (this.current !== null) {
      const proof = this.inspect(this.current);
      if (ok && this.completionHead !== undefined && proof.state === 'terminal') recordDirectiveCompletion(this.producers.get(this.current.requestId)!, proof.checkpointId, this.completionHead(this.current));
    }
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

/** A job that went terminal before live directives and re-brief markers
 * refused that status write (pre-#493 history): the status row and its
 * `job.status` event are written as that old transaction wrote them. */
export function markLegacyTerminalJobFixture(ledger: LedgerApi, jobId: string, status: 'binned' | 'done'): void {
  const { db } = ledger as unknown as { readonly db: DatabaseSync };
  const from = ledger.getJob(jobId)?.status;
  if (from === undefined) throw new Error(`no job ${jobId}`);
  const ts = new Date().toISOString();
  db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, jobId);
  db.prepare("INSERT INTO events (ts, kind, job_id, payload) VALUES (?, 'job.status', ?, ?)").run(ts, jobId, JSON.stringify({ from, to: status }));
}

/** Fresh retirement expectations for direct ledger callers. Production
 * callers must supply these values from the authenticated direct readback. */
export function directiveRetirementInputs(ledger: LedgerApi, requestId: string) {
  const row = ledger.getDirective(requestId);
  if (row === null) throw new Error(`no directive request ${requestId}`);
  const authority = ledger.directiveCurrentAuthority(row.jobId);
  const obligation = ledger.recoveryObligation(row.jobId, 'directive', requestId);
  return { expectedGeneration: obligation?.generation ?? null, expectedPlanRevision: obligation?.planRevision ?? null,
    expectedObligationState: obligation?.state ?? null, expectedAuthorityEpoch: authority.authorityEpoch,
    expectedWorkRevision: authority.workRevision, expectedContractSha256: authority.contractSha256 } as const;
}

/** The same expectations shaped for the route orchestration's `expected`. */
export function directiveRetirementFreshness(ledger: LedgerApi, requestId: string) {
  return { context: directiveRetirementInputs(ledger, requestId) } as const;
}

/** Persist genuine current-protocol admission for non-runtime ledger consumers. */
export function admitNativeDirectiveFixture(ledger: LedgerApi, requestId: string, minionId: string, file: string,
  completed?: { readonly head: string | null; readonly cwd: string }): number {
  const row = ledger.getDirective(requestId)!;
  ledger.registerAgent({ id: minionId, role: 'minion', jobId: row.jobId, sessionFile: file, parentage: 'top-level' });
  ledger.setAgentState(minionId, 'idle');
  ledger.prepareDirectiveTarget(requestId, { agentId: minionId, sessionFile: file });
  const native = new DirectiveNativeFixture(file, minionId, completed === undefined ? undefined : () => completed.head, completed?.cwd);
  native.begin('exact approved fixture request', { directive: { identity: ledger.directiveTurnIdentity(requestId), beforeAdmission: () => {}, onAdmitted: (binding) => ledger.bindDirectiveNativeAdmission(binding) } });
  if (completed !== undefined) { native.end(); native.ceased(); }
  return ledger.getDirective(requestId)!.admissionSeq!;
}

/** Read already-completed original fixture evidence; never synthesize it in
 * recovery or mistake admission alone for native terminal/physical proof. */
export function nativeDirectiveFixtureDeliveryProof(ledger: LedgerApi, requestId: string) {
  const binding = ledger.getDirective(requestId)?.nativeBinding;
  if (binding == null) throw new Error('fixture delivery lacks its original native admission');
  const identity = ledger.directiveTurnIdentity(requestId);
  const proof = inspectDirectiveCheckpoint(binding.sessionFile, identity);
  const physical = inspectDirectiveProducers(binding.sessionFile, identity);
  if (proof.state !== 'terminal' || !proof.ok || physical.length === 0 || physical.some(({ evidence }) => evidence !== 'ceased')) {
    throw new Error('fixture delivery requires its already-completed and ceased original native turn');
  }
  const receipt = readDirectiveCompletion(binding.sessionFile, identity, proof.checkpointId);
  if (receipt === null) throw new Error('fixture delivery must record its original HEAD or explicit null at completion');
  return { candidate_delivery_proven: receipt.head !== null,
    native_completion: { identity, checkpoint_id: proof.checkpointId, binding: proof.binding, receipt, physical_cessation: physical } };
}

export function withNativeDirectiveFixture(handle: AgentHandle, file: string, onState: (state: AgentState) => void = () => {}, completionHead?: (identity: DirectiveTurnIdentity) => string | null, cwd?: string): AgentHandle {
  const native = new DirectiveNativeFixture(file, handle.id, completionHead, cwd);
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

/** Capture real original SDK ownership at fixture acceptance, never recovery. */
export async function bindOriginalRebriefSdkOwner(ledger: LedgerApi, markers: readonly import('../../src/ledger/api.js').PendingRebriefRecord[], input: { cwd: string; dataDir: string; agentId: string; sessionFile?: string }): Promise<void> {
  const [{ loadConfig }, { PiRuntime }, { SessionStore }, { makeStubModelRuntime, StubScript }] = await Promise.all([
    import('../../src/config.js'), import('../../src/runtime/pi-adapter.js'), import('../../src/sessions/store.js'), import('./stub-model.js'),
  ]);
  const { join } = await import('node:path');
  const marker = markers.find((row) => row.kind === 'silas.rebrief');
  if (marker === undefined || marker.workRevision === null) throw new Error('original SDK fixture requires its accepted marker/revision');
  const home = join(input.dataDir, `original-sdk-${marker.id}`); mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'config.toml'), `workspace_root = ${JSON.stringify(input.cwd)}\n[models]\ndefault = "gru-stub/stub-model"\n`);
  const config = loadConfig({ GRU_COMMAND_HOME: home, GRU_COMMAND_DATA_DIR: home, GRU_COMMAND_WORKSPACE_DIR: input.cwd }, input.cwd);
  const store = new SessionStore(input.dataDir);
  const runtime = new PiRuntime({ config, store, agentDir: home, modelRuntime: await makeStubModelRuntime(new StubScript([{ deltas: ['original accepted legacy SDK turn'] }])) });
  try {
    const handle = await runtime.spawn('minion', { cwd: input.cwd, agentId: input.agentId, ...(input.sessionFile === undefined ? {} : { resumeFile: input.sessionFile }) });
    if (handle.sessionFile === null || handle.prepareDirectiveProducer === undefined) throw new Error('original SDK ownership unavailable');
    ledger.bindPendingRebriefWorker({ ids: markers.map((row) => row.id), agentId: handle.id, sessionFile: handle.sessionFile });
    const identity = { requestId: marker.id, jobId: marker.jobId, payloadHash: marker.payloadHash, workRevision: marker.workRevision,
      authorityEpoch: ledger.directiveRecoveryEpoch(marker.jobId), contractSha256: ledger.directiveCurrentAuthority(marker.jobId).contractSha256 };
    handle.prepareDirectiveProducer(identity);
    await handle.prompt(JSON.stringify({ note: marker.note, briefing: marker.briefing, work_revision: marker.workRevision, phase_id: marker.phaseId }), { directive: { identity, beforeAdmission: () => {}, onAdmitted: () => {} } });
    await handle.dispose();
    if (handle.cessationEvidence?.() !== 'ceased') throw new Error('original SDK did not prove physical cessation');
  } finally { await runtime.dispose(); store.dispose(); }
}
