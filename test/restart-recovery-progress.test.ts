import { bindOriginalRebriefSdkOwner, directiveRetirementFreshness, directiveRetirementInputs, markHistoricalDirectiveFixture, markLegacyTerminalJobFixture } from './helpers/directive-native-fixture.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { appendFileSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerDb } from '../src/ledger/db.js';
import { LedgerApi } from '../src/ledger/api.js';
import { EventBus } from '../src/events/bus.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { SessionStore } from '../src/sessions/store.js';
import { PiAgentHandle, PI_CAPABILITIES } from '../src/runtime/pi-adapter.js';
import { ClaudeCodeHandle, CLAUDE_CODE_CAPABILITIES } from '../src/runtime/claude-adapter.js';
import { DirectiveCheckpointError, inspectDirectiveAdmission, inspectDirectiveCheckpoint, inspectDirectiveProducers, prepareDirectiveBinding, prepareDirectiveProducer, recordDirectiveCompletion, recordDirectiveProducerCessation, readDirectiveBinding, readDirectiveCompletion, readDirectiveSessionHeader, type DirectiveTurnIdentity } from '../src/runtime/directive-checkpoint.js';
import { RuntimeRegistry, WorkerDisposalInProgressError } from '../src/runtime/registry.js';
import { configPathFor, loadConfig } from '../src/config.js';
import { DirectiveProgressService, DirectivePromptRefusedError, executeAcceptedDirective, promptRefusalUnproven, settleNativeDirective, surfaceDirectiveRecovery } from '../src/dispatch/directive-progress.js';
import { admitBlindReview, recordBlindAdmission } from '../src/dispatch/blind-review.js';
import { abandonLiveDirectiveFromRoute, recoverInterruptedDirectiveFromRoute, recoverInterruptedRebriefFromRoute, retireInterruptedDirectiveFromRoute } from '../src/dispatch/directive-recovery.js';
import { DirectiveRetirementError } from '../src/ledger/directives.js';
import { reconcilePendingLegacyDirectives, reconcilePendingRebriefs, settleDirectivesFromEvidence } from '../src/dispatch/rebrief-recovery.js';
import type { AgentHandle, SpawnOptions } from '../src/runtime/types.js';
import { recordFollowUpDelivery, type DirectiveRegistry } from '../src/dispatch/fix-directive.js';
import { rememberManagedLane } from '../src/worktrees/handoff.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { makeFixtureRepo } from './helpers/fixture-repo.js';
import { resolveGitCommit } from '../src/dispatch/perkins-review/artifacts.js';
import { PacingGate } from '../src/runtime/pacing.js';

const cleanups: (() => void)[] = [];
/** The stubbed claude CLI (test/helpers/claude-double.mjs). */
const DOUBLE = join(import.meta.dirname, 'helpers', 'claude-double.mjs');
afterEach(() => { while (cleanups.length > 0) cleanups.pop()!(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Real native JSONL, with SDK emission-before-persistence ordering and
 * controlled preflight/turn settlement. No transcript inference from health. */
class NativeFixture {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly model = { provider: 'fixture', id: 'model' };
  isIdle = true;
  isStreaming = false;
  isCompacting = false;
  isBashRunning = false;
  readonly prompts: string[] = [];
  continuations = 0;
  autoFinish = true;
  preflight: Promise<void> | null = null;
  private readonly listeners = new Set<(event: unknown) => void>();
  private waiting: ReturnType<typeof deferred<void>> | null = null;
  private n = 0;
  readonly agent = { continue: async () => { this.continuations += 1; return this.run(); } };
  constructor(file: string, sessionId = 'native-session', cwd?: string) {
    this.sessionFile = file;
    this.sessionId = sessionId;
    if (readFileSync(file, 'utf8') === '') writeFileSync(file, `${JSON.stringify({ type: 'session', id: sessionId, version: 3, cwd })}\n`);
  }
  subscribe(listener: (event: unknown) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: unknown) { for (const listener of this.listeners) listener(event); }
  append(message: Record<string, unknown>) {
    const rows = readFileSync(this.sessionFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { type: string; id: string });
    const parentId = rows.filter((row) => row.type !== 'session').at(-1)?.id ?? null;
    const id = `entry-${++this.n}-${rows.length}`;
    this.emit({ type: 'message_end', message });
    appendFileSync(this.sessionFile, `${JSON.stringify({ type: 'message', id, parentId, message })}\n`);
    return id;
  }
  async prompt(text: string, rawOptions?: unknown) {
    this.prompts.push(text);
    if (this.preflight !== null) await this.preflight;
    (rawOptions as { preflightResult?: (accepted: boolean) => void })?.preflightResult?.(true);
    this.append({ role: 'user', content: [{ type: 'text', text }] });
    return this.run();
  }
  private async run() {
    this.isIdle = false; this.isStreaming = true;
    this.emit({ type: 'agent_start' });
    this.waiting = deferred<void>();
    if (this.autoFinish) queueMicrotask(() => this.finish());
    await this.waiting.promise;
  }
  finish(stopReason = 'stop') {
    this.append({ role: 'assistant', stopReason, content: [{ type: 'text', text: 'real correlated completion' }] });
    this.isIdle = true; this.isStreaming = false;
    this.emit({ type: 'agent_end' });
    this.waiting?.resolve();
  }
  async dispose() { if (this.waiting !== null && !this.isIdle) this.finish('aborted'); }
  async steer() { throw new Error('native fixture does not simulate steering'); }
  async followUp() { throw new Error('native fixture does not simulate follow-up'); }
  async compact() {}
  getContextUsage() { return undefined; }
}

/** The minion the fixture registers and its registry spawns by default. */
const FIXTURE_MINION = 'logical-minion';

const NATIVE_TRANSCRIPT_LIMIT = 32 * 1024 * 1024;
/** Earlier work past the native transcript limit (#469): `row(index, filler)`
 * appended until the session file is larger than the limit; returns how many. */
function historyPastTranscriptLimit(file: string, row: (index: number, filler: string) => Record<string, unknown>): number {
  const filler = 'x'.repeat(256 * 1024);
  const fd = openSync(file, 'a');
  try {
    let count = 0;
    for (let size = statSync(file).size; size <= NATIVE_TRANSCRIPT_LIMIT + 1024 * 1024; count += 1) size += writeSync(fd, `${JSON.stringify(row(count, filler))}\n`);
    return count;
  } finally { closeSync(fd); }
}

async function fixture(kind: 'directive' | 'rebrief' = 'directive', nativeCwd = true, report = false) {
  const dir = mkdtempSync(join(tmpdir(), 'gru-restart-progress-'));
  const repo = makeFixtureRepo('restart-progress');
  const db = new LedgerDb(dir);
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  const worktrees = new InMemoryWorktreePort(join(dir, 'lanes'), ledger);
  const store = new SessionStore(dir);
  ledger.addJob({ id: 'approved-job', repo: 'fixture', title: 'approved', briefing: 'approved original contract', ...(report ? { deliverable: 'review' as const, commissioner: 'gru' } : {}) });
  ledger.setJobStatus('approved-job', 'working');
  ledger.setJobPr('approved-job', 'https://example.test/pull/286');
  const lane = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'approved-job' });
  const file = join(store.sessionsDir, 'minion', 'native.jsonl');
  mkdirSync(join(store.sessionsDir, 'minion'), { recursive: true });
  writeFileSync(file, '');
  const native = new NativeFixture(file, 'native-session', nativeCwd ? lane.path : undefined);
  ledger.registerAgent({ id: FIXTURE_MINION, role: 'minion', jobId: 'approved-job', sessionFile: file, parentage: 'top-level' });
  ledger.setAgentState(FIXTURE_MINION, 'idle');
  const intent = kind === 'rebrief'
    ? ledger.beginRebriefIntent({ jobId: 'approved-job', requestId: 'approved-request', note: 'approved correction', holder: 'gru' }).record
    : ledger.beginDirectiveIntent({ jobId: 'approved-job', requestId: 'approved-request', directive: 'approved correction', holder: 'gru' }).record;
  const identity = ledger.directiveTurnIdentity(intent.requestId);
  let manifest = JSON.stringify({ role: 'minion', cwd: lane.path, tools: ['read', 'bash'], model: 'fixture/model' });
  let handle: AgentHandle | null = null;
  const spawns: SpawnOptions[] = [];
  let spawnGate: Promise<void> | null = null;
  const registry: DirectiveRegistry = {
    getHandle: () => handle,
    async spawn(_role, options = {}) {
      spawns.push(options);
      if (spawnGate !== null) await spawnGate;
      handle = new PiAgentHandle('minion', native, file, PI_CAPABILITIES, false, (options.nativeTools ?? []).map((tool) => tool.name), store, () => {}, () => { handle = null; }, 60_000, options.agentId ?? FIXTURE_MINION, () => manifest, () => resolveGitCommit(lane.path, 'HEAD'));
      handle.subscribe((event) => { if (event.type === 'state' && ledger.getAgent(handle!.id) !== null) ledger.setAgentState(handle!.id, event.state); });
      return handle;
    },
    async disposeHandle(target) { await target.dispose(); },
  };
  const stop = new AbortController();
  let supervised: readonly string[] = [];
  const deps = { ledger, registry, worktrees, notifications, signal: stop.signal, pendingProducerBlockers: () => supervised };
  /** `beforeReceipt` writes what Pi appends between the baseline and the user
   * receipt; `nativeTools` is the tool set the binding records (absent = a
   * binding from before tool sets were recorded). */
  const seed = (text = 'accepted native prompt', beforeReceipt?: () => void, nativeTools?: readonly string[]) => {
    ledger.prepareDirectiveTarget(intent.requestId, { agentId: 'logical-minion', sessionFile: file });
    prepareDirectiveBinding({ identity, runtime: 'pi', agentId: 'logical-minion', sessionId: native.sessionId, sessionFile: file, text, authorityManifest: manifest,
      ...(nativeTools === undefined ? {} : { nativeTools }) });
    beforeReceipt?.();
    native.append({ role: 'user', content: [{ type: 'text', text }] });
    recordDirectiveProducerCessation(prepareDirectiveProducer({ identity, agentId: 'logical-minion', sessionId: native.sessionId, sessionFile: file }));
    return identity;
  };
  cleanups.push(() => { db.close(); store.dispose(); repo.cleanup(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, repo, db, ledger, bus, notifications, lane, worktrees, store, native, file, intent, identity, registry, spawns, stop, deps, seed,
    manifest: (value: string) => { manifest = value; }, spawnGate: (value: Promise<void> | null) => { spawnGate = value; }, supervised: (value: readonly string[]) => { supervised = value; } };
}

function originalDeliveryPayload(f: Awaited<ReturnType<typeof fixture>>) {
  const proof = inspectDirectiveCheckpoint(f.file, f.identity);
  if (proof.state !== 'terminal' || !proof.ok) throw new Error('fixture delivery requires its actual successful native terminal');
  const receipt = readDirectiveCompletion(f.file, f.identity, proof.checkpointId);
  return { request_id: f.intent.requestId, agentId: 'logical-minion', work_revision: f.identity.workRevision,
    sha: receipt?.head ?? null, candidate_delivery_proven: false,
    native_completion: { identity: f.identity, checkpoint_id: proof.checkpointId, binding: proof.binding,
      receipt, physical_cessation: inspectDirectiveProducers(f.file, f.identity) } };
}

describe('restart-recovery-progress — exact native request matrix', () => {
  async function pr334CompletedOriginalWithRecoveryDebt() {
    const f = await fixture(); void (f.ledger.getWorktree(f.lane.id) ?? f.ledger.registerWorktree(f.lane));
    expect(f.ledger.claimDirectiveDispatch(f.intent.requestId)).toBe(true);
    f.ledger.prepareDirectiveTarget(f.intent.requestId, { agentId: 'logical-minion', sessionFile: f.file });
    prepareDirectiveBinding({ identity: f.identity, runtime: 'pi', agentId: 'logical-minion', sessionId: f.native.sessionId,
      sessionFile: f.file, text: 'original accepted native input', authorityManifest: JSON.stringify({ role: 'minion', cwd: f.lane.path, tools: ['read', 'bash'], model: 'fixture/model' }) });
    f.native.append({ role: 'user', content: [{ type: 'text', text: 'original accepted native input' }] });
    const producer = prepareDirectiveProducer({ identity: f.identity, agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file });
    const start = f.ledger.startDirectiveProducer(f.identity, producer);
    f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, f.identity));
    f.native.finish(); const proof = inspectDirectiveCheckpoint(f.file, f.identity);
    if (proof.state !== 'terminal' || !proof.ok) throw new Error('genuine original native terminal required before testing late publication');
    const head = resolveGitCommit(f.lane.path, 'HEAD'); recordDirectiveCompletion(producer, proof.checkpointId, head);
    recordDirectiveProducerCessation(producer);
    f.ledger.appendCustomEvent({ kind: 'silas.directive-producer-ceased', jobId: f.intent.jobId,
      payload: { request_id: f.intent.requestId, agent_id: producer.agentId, session_file: f.file,
        producer_start_seq: start, producer_identity: f.identity, native_producer: producer, evidence: 'ceased' } });
    surfaceDirectiveRecovery(f.deps, f.intent.requestId, 'original native completion awaits its original ledger publication');
    const debt = f.ledger.listObligations({ jobId: f.intent.jobId }).find((item) => item.incidentKey === `directive-recovery:${f.intent.requestId}`)!;
    const authority = f.ledger.directiveCurrentAuthority(f.intent.jobId);
    const input = { ledger: f.ledger, worktrees: f.worktrees, pendingProducerBlockers: () => [], requestId: f.intent.requestId,
      generation: debt.generation, expectedPayloadHash: f.intent.payloadHash, expectedHead: head,
      expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId), expectedWorkRevision: authority.workRevision,
      expectedContractSha256: authority.contractSha256, reason: 'recover the exact original request without replay' };
    const payload = { request_id: f.intent.requestId, agentId: 'logical-minion', source: 'silas-directive', sha: head,
      work_revision: f.identity.workRevision, candidate_delivery_proven: false, historical_bookkeeping_only: true,
      native_completion: { identity: f.identity, checkpoint_id: proof.checkpointId, binding: proof.binding,
        receipt: readDirectiveCompletion(f.file, f.identity, proof.checkpointId), physical_cessation: inspectDirectiveProducers(f.file) } };
    return { ...f, input, payload, debt };
  }

  it('a directive recovery decision replayed with its properties in another order is the same decision; one recorded before canonical fingerprints still replays (#363 S02-0-02)', async () => {
    const f = await fixture();
    const debt = f.ledger.openDirectiveRecoveryDebt(f.intent.requestId, 'predecessor handoff requires a concrete decision');
    const head = resolveGitCommit(f.lane.path, 'HEAD');
    const base = { requestId: f.intent.requestId, generation: debt.generation, expectedPayloadHash: f.intent.payloadHash, expectedHead: head,
      expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId), expectedWorkRevision: f.identity.workRevision, expectedContractSha256: f.identity.contractSha256,
      reason: 'separately accepted successor', lane: { id: f.lane.id, resolvedHead: head } };
    const first = f.ledger.consumeDirectiveRecoveryDecision({ ...base, decision: { kind: 'successor', requestId: 'canonical-successor', directive: 'new accepted scope' } });
    expect(first.idempotent).toBe(false);
    // The same decision, its properties written in another order.
    const reordered = f.ledger.consumeDirectiveRecoveryDecision({ ...base, decision: { directive: 'new accepted scope', requestId: 'canonical-successor', kind: 'successor' } });
    expect(reordered).toMatchObject({ idempotent: true, successor: { requestId: 'canonical-successor' } });
    // A genuinely different decision still conflicts.
    expect(() => f.ledger.consumeDirectiveRecoveryDecision({ ...base, decision: { kind: 'successor', requestId: 'canonical-successor', directive: 'other scope' } }))
      .toThrow(/conflicts with the consumed decision/);
    // A decision recorded before canonical fingerprints (insertion-order JSON) still replays exactly.
    const facts = [base.requestId, base.generation, base.expectedPayloadHash, base.expectedHead, base.expectedEpoch, base.expectedWorkRevision, base.expectedContractSha256, base.reason,
      { kind: 'successor', requestId: 'canonical-successor', directive: 'new accepted scope' }];
    const legacy = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
    f.db.handle.prepare(`UPDATE events SET payload = json_set(payload, '$.fingerprint', ?) WHERE kind = 'silas.directive-recovery-decided' AND json_extract(payload, '$.request_id') = ?`)
      .run(legacy, f.intent.requestId);
    expect(f.ledger.consumeDirectiveRecoveryDecision({ ...base, decision: { kind: 'successor', requestId: 'canonical-successor', directive: 'new accepted scope' } }))
      .toMatchObject({ idempotent: true });
  });

  it('a directive recovery card reused for a later cause is refreshed in place, never left naming the older one (#363 S07-3-01)', async () => {
    const f = await fixture();
    surfaceDirectiveRecovery(f.deps, f.intent.requestId, 'first blocker: native admission unproven');
    const first = f.ledger.findNotificationByKind(`silas.directive-unreconciled.${f.intent.requestId}`, 'active')!;
    expect(first.detail).toContain('first blocker');
    surfaceDirectiveRecovery(f.deps, f.intent.requestId, 'second blocker: producer ownership unknown');
    const refreshed = f.ledger.findNotificationByKind(`silas.directive-unreconciled.${f.intent.requestId}`, 'active')!;
    expect(refreshed.id).toBe(first.id);
    expect(refreshed.ackedAt).toBe(first.ackedAt);
    expect(refreshed.detail).toContain('second blocker');
    expect(refreshed.detail).not.toContain('first blocker');
    // A surface that cannot refresh a stale card says so by name.
    expect(() => surfaceDirectiveRecovery({ ledger: f.ledger, notifications: { postIncident: (input) => f.notifications.postIncident(input) } }, f.intent.requestId, 'third blocker'))
      .toThrow(/was reused with an older generation's detail, and this notifications surface cannot refresh it/);
  });

  it('PR334 completion successful native truth prevents retirement before its ledger delivery', async () => {
    const f = await pr334CompletedOriginalWithRecoveryDebt();
    const original = f.ledger.getDirective(f.intent.requestId); const watermark = f.ledger.latestEventSeq();
    const bytes = readFileSync(f.file, 'utf8'); const journal = readFileSync(`${f.file}.producers.jsonl`, 'utf8');
    expect(() => recoverInterruptedDirectiveFromRoute({ ...f.input,
      decision: { kind: 'successor', requestId: 'must-not-replay-completed-original', directive: 'new effects must not replace original completion' } })).toThrow(/successful native completion/);
    expect(f.ledger.latestEventSeq()).toBe(watermark); expect(f.ledger.getDirective(f.intent.requestId)).toEqual(original);
    expect(f.ledger.getDirective('must-not-replay-completed-original')).toBeNull();
    expect(settleNativeDirective(f.deps, f.identity)).toBe(true);
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
    expect(f.ledger.listJobEventsByKinds(f.intent.jobId, ['job.delivered'])).toHaveLength(1);
    expect(f.spawns).toEqual([]); expect(f.native.continuations).toBe(0); expect(f.native.prompts).toEqual([]);
    expect(readFileSync(f.file, 'utf8')).toBe(bytes); expect(readFileSync(`${f.file}.producers.jsonl`, 'utf8')).toBe(journal);
  });

  it('PR334 completion original native success prevents obsolete writer clearance preflight', async () => {
    const f = await pr334CompletedOriginalWithRecoveryDebt(); const watermark = f.ledger.latestEventSeq();
    expect(() => f.ledger.validateRecoverySuccessorBeforeWriterClearance({ ...f.input, subjectKind: 'directive',
      lane: { id: f.lane.id, resolvedHead: f.input.expectedHead },
      decision: { kind: 'successor', requestId: 'must-not-clear-before-completion', directive: 'new effects must not replace original completion' } })).toThrow(/successful native completion/);
    expect(f.ledger.latestEventSeq()).toBe(watermark); expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('admitted');
    expect(f.spawns).toEqual([]); expect(f.native.continuations).toBe(0);
  });

  async function assertTransferredOwnerBoundary(boundary: 'delivery' | 'settled-marker') {
    const f = await pr334CompletedOriginalWithRecoveryDebt();
    const target = f.ledger.recordBlockedObservation(f.intent.jobId, { logicalStep: 'operation', incidentKey: 'original-owner-stop',
      category: { kind: 'known', category: 'owner-hold' }, observedAtSeq: f.ledger.latestEventSeq(),
      nextAction: { kind: 'owner-decision', decision: 'owner must resolve this exact stopped recovery context' } });
    recoverInterruptedDirectiveFromRoute({ ...f.input, expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId),
      decision: { kind: 'owner-decision', obligationId: target.id } });
    expect(f.ledger.recoveryOwnerBasis('directive', f.intent.requestId).owned).toBe(true);
    const event = f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.intent.jobId, payload: f.payload });
    const original = f.ledger.getDirective(f.intent.requestId); const owner = f.ledger.recoveryOwnerReadback('directive', f.intent.requestId);
    const watermark = f.ledger.latestEventSeq(); const bytes = readFileSync(f.file, 'utf8');
    expect(() => boundary === 'delivery'
      ? f.ledger.recordDirectiveDelivery({ requestId: f.intent.requestId, eventSeq: event.seq })
      : f.ledger.appendCustomEvent({ kind: 'silas.directive-settled', jobId: f.intent.jobId,
        payload: { request_id: f.intent.requestId, delivery_seq: event.seq, candidate_delivery_proven: false } })).toThrow(/transferred owner context/);
    expect(f.ledger.latestEventSeq()).toBe(watermark); expect(f.ledger.getDirective(f.intent.requestId)).toEqual(original);
    expect(f.ledger.recoveryOwnerReadback('directive', f.intent.requestId)).toEqual(owner);
    expect(f.ledger.recoveryOwnerBasis('directive', f.intent.requestId).owned).toBe(true);
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-settled')).toBeNull();
    expect(f.ledger.getEvent(event.seq)).toEqual(event); expect(readFileSync(f.file, 'utf8')).toBe(bytes);
    expect(f.spawns).toEqual([]); expect(f.native.continuations).toBe(0); expect(f.native.prompts).toEqual([]);
  }
  it('PR334 completion transferred owner context fences shared native delivery settlement', () => assertTransferredOwnerBoundary('delivery'));
  it('PR334 completion transferred owner context fences shared native settled-marker settlement', () => assertTransferredOwnerBoundary('settled-marker'));

  it('PR334 isolation ordinary same-owner inputs cannot enter the live exact native directive', async () => {
    const f = await fixture(); f.seed(); f.native.autoFinish = false;
    const entered = deferred<void>(); const originalContinue = f.native.agent.continue.bind(f.native.agent);
    vi.spyOn(f.native.agent, 'continue').mockImplementation(async () => { const pending = originalContinue(); entered.resolve(); await pending; });
    const steer = vi.spyOn(f.native, 'steer').mockImplementation(async () => { f.native.append({ role: 'user', content: [{ type: 'text', text: 'unbound ordinary steering' }] }); });
    const followUp = vi.spyOn(f.native, 'followUp').mockImplementation(async () => { f.native.append({ role: 'user', content: [{ type: 'text', text: 'unbound ordinary follow-up' }] }); });
    const service = new DirectiveProgressService(f.deps);
    try {
      service.reconsider();
      await Promise.race([entered.promise, service.settled().then(() => { throw new Error('original directive did not enter its genuine live continuation'); })]);
      const handle = f.registry.getHandle('logical-minion')!;
      let queued = 0; handle.subscribe((event) => { if (event.type === 'queued') queued += 1; });
      const snapshot = readFileSync(f.file, 'utf8');
      const outcomes = await Promise.all([
        handle.steer('unbound ordinary steering', { owner: `directive-recovery:${f.intent.requestId}` }),
        handle.followUp('unbound ordinary follow-up', { owner: `directive-recovery:${f.intent.requestId}` }),
      ].map((pending) => pending.then(() => false, (error: unknown) => error instanceof Error && /live exact directive/.test(error.message))));
      expect(steer).not.toHaveBeenCalled(); expect(followUp).not.toHaveBeenCalled();
      expect(outcomes).toEqual([true, true]); expect(queued).toBe(0);
      expect(readFileSync(f.file, 'utf8')).toBe(snapshot);
      f.native.finish(); await service.settled();
      expect(f.native.continuations).toBe(1); expect(f.spawns).toHaveLength(1); expect(f.native.prompts).toEqual([]);
      expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
      expect(f.ledger.listJobEventsByKinds(f.intent.jobId, ['job.delivered'])).toHaveLength(1);
    } finally { if (!f.native.isIdle) f.native.finish(); await service.settled(); await service.dispose(); }
  });

  it('PR334 isolation retained fail-once SDK cleanup retries the exact handle without replay', async () => {
    const f = await fixture(); f.seed();
    const originalDispose = f.native.dispose.bind(f.native);
    const disposal = vi.spyOn(f.native, 'dispose').mockImplementation(originalDispose).mockRejectedValueOnce(new Error('original SDK cleanup transient failure'));
    const service = new DirectiveProgressService(f.deps);
    try {
      service.reconsider(); await service.settled();
      const handle = f.registry.getHandle('logical-minion')!;
      const started = f.ledger.directiveProducerStart(f.identity);
      expect(disposal).toHaveBeenCalledTimes(1); expect(handle.cessationEvidence?.()).toBe('unknown');
      expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('admitted');
      expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
      expect(f.ledger.directiveProgressBlockers(f.intent.requestId, f.lane.id).join(';')).toContain('unproven producer cleanup');
      const nativeBytes = readFileSync(f.file, 'utf8');
      service.reconsider(); await service.settled();
      expect(disposal).toHaveBeenCalledTimes(2); expect(handle.cessationEvidence?.()).toBe('ceased');
      const cessation = f.ledger.latestJobEventByRequestId(f.intent.jobId, 'silas.directive-producer-ceased', f.intent.requestId);
      expect(cessation?.payload).toMatchObject({ producer_start_seq: started, producer_identity: f.identity, agent_id: handle.id, session_file: f.file });
      service.reconsider(); await service.settled(); service.reconsider(); await service.settled();
      expect(disposal).toHaveBeenCalledTimes(2); expect(f.native.continuations).toBe(1); expect(f.spawns).toHaveLength(1); expect(f.native.prompts).toEqual([]);
      expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
      const delivered = f.ledger.listJobEventsByKinds(f.intent.jobId, ['job.delivered']);
      expect(delivered).toHaveLength(1); expect(delivered[0]!.seq).toBeGreaterThan(cessation!.seq);
      expect(readFileSync(f.file, 'utf8')).toBe(nativeBytes);
      expect(f.ledger.listJobEventsByKinds(f.intent.jobId, ['silas.directive-producer-unknown'])).toHaveLength(1);
    } finally { await service.dispose(); disposal.mockRestore(); }
  });

  it('PR334 cessation older ceased incarnations do not misidentify the exact latest absent host lock', async () => {
    const f = await fixture(); void (f.ledger.getWorktree(f.lane.id) ?? f.ledger.registerWorktree(f.lane)); f.seed();
    const first = inspectDirectiveProducers(f.file, f.identity)[0]!.producer;
    const firstStart = f.ledger.startDirectiveProducer(f.identity, first);
    f.ledger.appendCustomEvent({ kind: 'silas.directive-producer-ceased', jobId: f.intent.jobId, payload: {
      request_id: f.intent.requestId, agent_id: first.agentId, session_file: f.file,
      producer_start_seq: firstStart, producer_identity: f.identity, native_producer: first,
    } });
    const code = `
      import { readFileSync, appendFileSync } from 'node:fs';
      import { LedgerDb } from ${JSON.stringify(`${process.cwd()}/dist/ledger/db.js`)};
      import { LedgerApi } from ${JSON.stringify(`${process.cwd()}/dist/ledger/api.js`)};
      import { SessionStore } from ${JSON.stringify(`${process.cwd()}/dist/sessions/store.js`)};
      import { prepareDirectiveProducer, recordDirectiveCompletion } from ${JSON.stringify(`${process.cwd()}/dist/runtime/directive-checkpoint.js`)};
      const db = new LedgerDb(${JSON.stringify(f.dir)}); const ledger = new LedgerApi(db.handle);
      const file = ${JSON.stringify(f.file)}; const store = new SessionStore(${JSON.stringify(f.dir)});
      store.acquireLock(file);
      const producer = prepareDirectiveProducer({ identity: ${JSON.stringify(f.identity)}, agentId: 'logical-minion',
        sessionId: 'native-session', sessionFile: file, lockOwner: store.ownedLockIdentity(file) });
      ledger.startDirectiveProducer(producer.identity, producer);
      const rows = readFileSync(file, 'utf8').trim().split('\\n').map((line) => JSON.parse(line));
      const checkpoint = 'pr334-second-host-terminal';
      appendFileSync(file, JSON.stringify({ type: 'message', id: checkpoint, parentId: rows.at(-1).id,
        message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'original second physical host genuinely finished' }] } }) + '\\n');
      recordDirectiveCompletion(producer, checkpoint, ${JSON.stringify(resolveGitCommit(f.lane.path, 'HEAD'))});
      db.close(); process.exit(0); // genuine host exit, leaving its original exact lock and no invented cessation
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: process.cwd(), timeout: 30_000, killSignal: 'SIGKILL', stdio: 'pipe' });
    const physical = inspectDirectiveProducers(f.file, f.identity);
    expect(physical.map(({ evidence }) => evidence)).toEqual(['ceased', 'host-absent']);
    const latest = physical.at(-1)!.producer; expect(latest.pid).not.toBe(process.pid);
    const lockPath = `${f.file}.lock`; const exactLock = readFileSync(lockPath, 'utf8');
    const lock = JSON.parse(exactLock) as { host: string; pid: number; bootId: string };
    expect(latest.lockOwner).toEqual({ host: lock.host, pid: lock.pid, bootId: lock.bootId });
    writeFileSync(lockPath, JSON.stringify({ ...lock, pid: process.pid }));
    try {
      expect(() => settleNativeDirective(f.deps, f.identity)).toThrow(/native lock owner/);
      expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
    } finally { writeFileSync(lockPath, exactLock); }
    const nativeBytes = readFileSync(f.file, 'utf8'); const journal = readFileSync(`${f.file}.producers.jsonl`, 'utf8');
    let completed = false;
    expect(() => { completed = settleNativeDirective(f.deps, f.identity); }).not.toThrow();
    expect(completed).toBe(true); expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
    expect(f.ledger.listJobEventsByKinds(f.intent.jobId, ['job.delivered'])).toHaveLength(1);
    expect(readFileSync(f.file, 'utf8')).toBe(nativeBytes); expect(readFileSync(`${f.file}.producers.jsonl`, 'utf8')).toBe(journal);
    expect(readFileSync(lockPath, 'utf8')).toBe(exactLock);
    expect(f.spawns).toEqual([]); expect(f.native.continuations).toBe(0); expect(f.native.prompts).toEqual([]);
  });

  it('PR334 cessation a fresh ledger reconciles only its own exact proven UNKNOWN cleanup before settlement', async () => {
    for (const independentUnknown of [false, true]) {
      const f = await fixture(); void (f.ledger.getWorktree(f.lane.id) ?? f.ledger.registerWorktree(f.lane));
      f.ledger.prepareDirectiveTarget(f.intent.requestId, { agentId: 'logical-minion', sessionFile: f.file });
      prepareDirectiveBinding({ identity: f.identity, runtime: 'pi', agentId: 'logical-minion', sessionId: f.native.sessionId,
        sessionFile: f.file, text: 'original admitted native turn', authorityManifest: 'original authority' });
      f.native.append({ role: 'user', content: [{ type: 'text', text: 'original admitted native turn' }] });
      const producer = prepareDirectiveProducer({ identity: f.identity, agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file });
      const start = f.ledger.startDirectiveProducer(f.identity, producer);
      f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, f.identity));
      f.ledger.appendCustomEvent({ kind: 'silas.directive-producer-unknown', jobId: f.intent.jobId, payload: {
        request_id: f.intent.requestId, agent_id: producer.agentId, session_file: f.file,
        producer_start_seq: start, producer_identity: f.identity, native_producer: producer,
      } });
      f.native.finish();
      const proof = inspectDirectiveCheckpoint(f.file, f.identity);
      if (proof.state !== 'terminal' || !proof.ok) throw new Error('fixture must have genuine original successful native terminal');
      recordDirectiveCompletion(producer, proof.checkpointId, resolveGitCommit(f.lane.path, 'HEAD'));
      recordDirectiveProducerCessation(producer);
      if (independentUnknown) f.ledger.appendCustomEvent({ kind: 'silas.directive-producer-unknown', jobId: f.intent.jobId,
        payload: { request_id: 'independent-original-request', agent_id: 'independent-original-minion', session_file: null } });
      const nativeBytes = readFileSync(f.file, 'utf8'); const journal = readFileSync(`${f.file}.producers.jsonl`, 'utf8');
      f.db.close();
      const db = new LedgerDb(f.dir); const bus = new EventBus({}); const ledger = new LedgerApi(db.handle, { bus });
      try {
        const deps = { ...f.deps, ledger, notifications: new NotificationCenter({ ledger, bus }) };
        if (independentUnknown) expect(() => settleNativeDirective(deps, f.identity)).toThrow(/producer fences/);
        else {
          let completed = false; expect(() => { completed = settleNativeDirective(deps, f.identity); }).not.toThrow();
          expect(completed).toBe(true); expect(ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
          expect(ledger.listJobEventsByKinds(f.intent.jobId, ['job.delivered'])).toHaveLength(1);
        }
        expect(ledger.latestJobEventByRequestId(f.intent.jobId, 'silas.directive-producer-ceased', f.intent.requestId)?.payload)
          .toMatchObject({ producer_start_seq: start, producer_identity: f.identity, native_producer: producer });
        if (independentUnknown) {
          expect(ledger.getDirective(f.intent.requestId)?.state).toBe('admitted');
          expect(ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
          expect(ledger.directiveProgressBlockers(f.intent.requestId, f.lane.id).join(';')).toContain('independent-original-minion');
        }
        expect(f.spawns).toEqual([]); expect(f.native.continuations).toBe(0); expect(f.native.prompts).toEqual([]);
        expect(readFileSync(f.file, 'utf8')).toBe(nativeBytes); expect(readFileSync(`${f.file}.producers.jsonl`, 'utf8')).toBe(journal);
      } finally { db.close(); }
    }
  });

  it('PR334 receipt structurally exact reordered cessation identity consumes only its original physical start', async () => {
    const f = await fixture(); f.seed();
    expect(f.ledger.claimDirectiveDispatch(f.intent.requestId)).toBe(true);
    const producer = inspectDirectiveProducers(f.file, f.identity)[0]!.producer;
    const start = f.ledger.startDirectiveProducer(f.identity, producer);
    expect(f.ledger.directiveProgressBlockers(f.intent.requestId, f.lane.id).join(';')).toContain(`start ${start}`);
    const reordered = Object.fromEntries(Object.entries(f.identity).reverse()) as unknown as typeof f.identity;
    expect(reordered).toEqual(f.identity); expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(f.identity));
    const ceased = f.ledger.appendCustomEvent({ kind: 'silas.directive-producer-ceased', jobId: f.intent.jobId, payload: {
      request_id: f.intent.requestId, agent_id: producer.agentId, session_file: f.file,
      producer_start_seq: start, producer_identity: reordered, native_producer: producer,
    } });
    expect(ceased.payload).toMatchObject({ producer_start_seq: start, producer_identity: f.identity });
    expect(f.ledger.directiveProgressBlockers(f.intent.requestId, f.lane.id)).toEqual([]);
    expect(f.native.continuations).toBe(0); expect(f.spawns).toEqual([]); expect(f.native.prompts).toEqual([]);
  });

  it('observes post-commit lost fresh acceptance without replay and protects the synchronous intake reservation gap', async () => {
    const f = await fixture(); f.ledger.failDirective({ requestId: f.intent.requestId, reason: 'fixture intake never submitted' });
    const service = new DirectiveProgressService(f.deps);
    const publish = f.bus.publish.bind(f.bus);
    const failure = vi.spyOn(f.bus, 'publish').mockImplementation((event) => {
      publish(event); if (event.kind === 'silas.directive-intent') { service.reconsider(); throw new Error('post-commit acceptance publication lost its HTTP owner'); }
    });
    expect(() => f.ledger.beginDirectiveIntent({ jobId: f.intent.jobId, requestId: 'lost-fresh', directive: 'never blindly replay', holder: 'silas-ops' })).toThrow(/post-commit/);
    failure.mockRestore(); await service.settled(); service.reconsider(); service.reconsider(); await service.settled();
    expect(f.ledger.getDirective('lost-fresh')).toMatchObject({ state: 'dispatching', nativeTarget: null, dispatchStartedAt: null, attempts: 0 });
    expect(f.ledger.findNotificationByKind('silas.directive-unreconciled.lost-fresh', 'active')).not.toBeNull();
    expect(f.spawns).toEqual([]); expect(f.native.prompts).toEqual([]); await service.dispose();
    const normal = await fixture(); normal.ledger.failDirective({ requestId: normal.intent.requestId, reason: 'fixture unused intake' });
    const ordinary = new DirectiveProgressService(normal.deps);
    normal.ledger.beginDirectiveIntent({ jobId: normal.intent.jobId, requestId: 'normal-fresh', directive: 'normal HTTP-owned intake', holder: 'silas-ops' });
    ordinary.reconsider(); const release = normal.ledger.beginJobAdmission(normal.intent.jobId, 'directive normal-fresh');
    ordinary.reconsider(); await ordinary.settled(); expect(normal.ledger.findNotificationByKind('silas.directive-unreconciled.normal-fresh', 'active')).toBeNull();
    release(); await ordinary.dispose();
  });

  async function assertAdmissionReadback(actual: boolean, damage?: 'partial-tail' | 'malformed-tail' | 'live-owner' | 'foreign-owner' | 'rebound' | 'malformed-association' | 'foreign-session') {
    const f = await fixture(); const debt = f.ledger.openDirectiveRecoveryDebt(f.intent.requestId, 'predecessor handoff requires actual native admission');
    f.ledger.consumeDirectiveRecoveryDecision({ requestId: f.intent.requestId, generation: debt.generation, expectedPayloadHash: f.intent.payloadHash,
      expectedHead: resolveGitCommit(f.lane.path, 'HEAD'), expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId), expectedWorkRevision: f.identity.workRevision,
      expectedContractSha256: f.identity.contractSha256, reason: 'separately accepted successor', lane: { id: f.lane.id, resolvedHead: resolveGitCommit(f.lane.path, 'HEAD') },
      decision: { kind: 'successor', requestId: 'readback-successor', directive: 'new accepted scope' } });
    const identity = f.ledger.directiveTurnIdentity('readback-successor');
    f.ledger.prepareDirectiveTarget(identity.requestId, { agentId: 'logical-minion', sessionFile: f.file });
    const binding = prepareDirectiveBinding({ identity, runtime: 'pi', agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file, text: 'actual successor user', authorityManifest: 'original fixture authority' });
    if (actual || damage !== undefined) {
      f.native.append({ role: 'user', content: [{ type: 'text', text: 'actual successor user' }] });
      f.native.append({ role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'uncertain-effect', name: 'bash', arguments: { command: 'unknown original effect' } }] });
    } else appendFileSync(`${f.file}.directives.jsonl`, `${JSON.stringify({ ...binding, userEntryId: 'absent-native-user' })}\n`);
    const producer = prepareDirectiveProducer({ identity, agentId: binding.agentId, sessionId: binding.sessionId, sessionFile: f.file });
    if (damage !== 'live-owner' && damage !== 'foreign-owner') recordDirectiveProducerCessation(producer);
    if (damage === 'foreign-owner') writeFileSync(`${f.file}.producers.jsonl`, `${JSON.stringify({ state: 'started', producer: { ...producer, host: 'foreign-native-host' } })}\n`);
    if (damage === 'partial-tail') appendFileSync(f.file, '{partial native assistant');
    if (damage === 'malformed-tail') appendFileSync(f.file, 'not JSON\n');
    if (damage === 'rebound') appendFileSync(`${f.file}.directives.jsonl`, `${JSON.stringify({ ...binding, userEntryId: 'rebound-native-user' })}\n`);
    if (damage === 'malformed-association') appendFileSync(`${f.file}.directives.jsonl`, `${JSON.stringify({ ...binding, runtime: 'unsupported-runtime' })}\n`);
    if (damage === 'foreign-session') writeFileSync(f.file, readFileSync(f.file, 'utf8').replace(f.native.sessionId, 'foreign-native-session'));
    const nativeBytes = readFileSync(f.file, 'utf8'); const producerBytes = readFileSync(`${f.file}.producers.jsonl`, 'utf8');
    f.db.close(); const reopened = new LedgerDb(f.dir); const events = new EventBus({}); const ledger = new LedgerApi(reopened.handle, { bus: events });
    try {
      const service = new DirectiveProgressService({ ...f.deps, ledger, notifications: new NotificationCenter({ ledger, bus: events }) });
      service.reconsider(); await service.settled(); service.reconsider(); await service.settled(); await service.dispose();
      expect(ledger.getDirective(identity.requestId)?.state).toBe(actual ? 'admitted' : 'dispatching');
      expect(ledger.getObligation(debt.id)?.state).toBe(actual ? 'settled' : 'open');
      expect(ledger.latestJobEventByRequestId(identity.jobId, 'silas.directive-sent', identity.requestId) === null).toBe(!actual);
      expect(ledger.latestJobEventByRequestId(identity.jobId, 'job.delivered', identity.requestId)).toBeNull();
      expect(f.spawns).toEqual([]); expect(f.native.prompts).toEqual([]);
      expect(readFileSync(f.file, 'utf8')).toBe(nativeBytes); expect(readFileSync(`${f.file}.producers.jsonl`, 'utf8')).toBe(producerBytes);
    } finally { reopened.close(); }
  }
  it('recovery rejects shape-only absent native admission and never settles predecessor debt', () => assertAdmissionReadback(false));
  it('recovery preserves actual native admission and genuine handoff even with UNKNOWN pending tool effects', () => assertAdmissionReadback(true));
  it('callback-loss recovery binds actual user prefix despite a partial later native tail', () => assertAdmissionReadback(true, 'partial-tail'));
  it('callback-loss recovery binds actual user prefix despite malformed later native bytes', () => assertAdmissionReadback(true, 'malformed-tail'));
  it('callback-loss recovery binds actual user prefix while its original physical owner remains live UNKNOWN', () => assertAdmissionReadback(true, 'live-owner'));
  it('callback-loss recovery binds actual user prefix while its original foreign physical host remains UNKNOWN', () => assertAdmissionReadback(true, 'foreign-owner'));
  it('rebound association cannot manufacture actual admission or settle predecessor recovery debt', () => assertAdmissionReadback(false, 'rebound'));
  it('malformed association cannot manufacture actual admission or settle predecessor recovery debt', () => assertAdmissionReadback(false, 'malformed-association'));
  it('foreign native session cannot manufacture actual admission or settle predecessor recovery debt', () => assertAdmissionReadback(false, 'foreign-session'));

  async function completeBeforeOriginalOwnerPark(report = false, parkAfterCompletion = true) {
    const f = await fixture('directive', true, report);
    void (f.ledger.getWorktree(f.lane.id) ?? f.ledger.registerWorktree(f.lane)); // actual original setup, before native execution
    f.seed(); f.native.finish();
    const completed = inspectDirectiveCheckpoint(f.file, f.identity);
    if (completed.state !== 'terminal' || !completed.ok) throw new Error('original fixture must really reach its terminal before owner control');
    const owners = inspectDirectiveProducers(f.file, f.identity);
    if (owners.length !== 1 || owners[0]?.evidence !== 'ceased') throw new Error('original completion must carry its exact original ceased producer');
    recordDirectiveCompletion(owners[0].producer, completed.checkpointId, resolveGitCommit(f.lane.path, 'HEAD')); // original completion, not recovery backfill
    f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, f.identity));
    if (parkAfterCompletion) f.ledger.setJobStatus(f.intent.jobId, 'parked'); // explicit original owner stop, no automatic release
    return f;
  }
  it('R14 protected historical native completion still projects its exact owed current gate debt', async () => {
    const f = await completeBeforeOriginalOwnerPark(); const bytes = readFileSync(f.file, 'utf8');
    expect(settleNativeDirective(f.deps, f.identity)).toBe(true);
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
    const delivery = f.ledger.latestJobEventByRequestId(f.intent.jobId, 'job.delivered', f.intent.requestId)!;
    expect(delivery.payload).toMatchObject({ historical_bookkeeping_only: true, candidate_delivery_proven: false });
    expect(f.ledger.listObligations({ jobId: f.intent.jobId }).find((row) => row.incidentKey === `directive-current-gates:${f.intent.requestId}`)?.state).toBe('suspended');
    expect(f.ledger.correctiveVerificationDebt(f.intent.jobId)).toEqual({ revision: 0, head: null });
    expect(f.ledger.latestCandidateDelivery(f.intent.jobId)).toBeNull();
    expect(f.ledger.getJob(f.intent.jobId)?.status).toBe('parked');
    expect(readFileSync(f.file, 'utf8')).toBe(bytes); expect(f.spawns).toEqual([]); expect(f.native.prompts).toEqual([]);
  });
  it('R14 direct native historical report settlement never opens an unqualified commissioner handback', async () => {
    const f = await completeBeforeOriginalOwnerPark(true); const bytes = readFileSync(f.file, 'utf8');
    expect(settleNativeDirective(f.deps, f.identity)).toBe(true);
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
    expect(f.ledger.latestCandidateDelivery(f.intent.jobId)).toBeNull();
    expect(f.ledger.findReportObligation(f.intent.jobId)).toBeNull();
    expect(f.ledger.findNotificationByKind(`silas.report-handback.${f.intent.jobId}`, 'any')).toBeNull();
    expect(f.ledger.listObligations({ jobId: f.intent.jobId }).find((row) => row.incidentKey === `directive-current-gates:${f.intent.requestId}`)?.state).toBe('suspended');
    expect(f.ledger.getJob(f.intent.jobId)?.status).toBe('parked');
    expect(readFileSync(f.file, 'utf8')).toBe(bytes); expect(f.spawns).toEqual([]); expect(f.native.prompts).toEqual([]);
  });

  it('R14 exact native report completion opens handback without granting code-candidate eligibility', async () => {
    const f = await completeBeforeOriginalOwnerPark(true, false);
    const bytes = readFileSync(f.file, 'utf8');
    writeFileSync(join(f.lane.path, 'report-material-input.ts'), 'export const pendingReportInput = true;\n');
    expect(settleNativeDirective(f.deps, f.identity)).toBe(true);
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
    const delivery = f.ledger.latestJobEventByRequestId(f.intent.jobId, 'job.delivered', f.intent.requestId)!;
    expect(delivery.payload).toMatchObject({ candidate_delivery_proven: false });
    expect(f.ledger.latestCandidateDelivery(f.intent.jobId)).toBeNull();
    expect(f.ledger.findReportObligation(f.intent.jobId)).toMatchObject({ state: 'open', firstOriginSeq: delivery.seq });
    expect(f.ledger.listJobEventsByKinds(f.intent.jobId, ['job.report-handback'])).toHaveLength(1);
    expect(f.ledger.listObligations({ jobId: f.intent.jobId }).find((row) => row.incidentKey === `directive-current-gates:${f.intent.requestId}`)?.state).toBe('open');
    expect(readFileSync(f.file, 'utf8')).toBe(bytes); expect(f.spawns).toEqual([]); expect(f.native.prompts).toEqual([]);
  });

  it('null historical delivery payload remains historical revision zero without granting current admission or crashing debt readers', async () => {
    const f = await fixture(); f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.intent.jobId, payload: null });
    expect(f.ledger.workRevisionState(f.intent.jobId)).toEqual({ required: 0, delivered: 0 }); expect(f.ledger.correctiveVerificationDebt(f.intent.jobId)).toBeNull();
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('dispatching'); expect(f.spawns).toEqual([]);
  });
  it('primitive historical delivery payload remains immutable and cannot manufacture native accepted progress', async () => {
    const f = await fixture(); const event = f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.intent.jobId, payload: 'historical opaque delivery' });
    expect(f.ledger.workRevisionState(f.intent.jobId)).toEqual({ required: 0, delivered: 0 }); expect(f.ledger.correctiveVerificationDebt(f.intent.jobId)).toBeNull();
    expect(f.ledger.getEvent(event.seq)?.payload).toBe('historical opaque delivery'); expect(f.ledger.getDirective(f.intent.requestId)?.nativeBinding).toBeNull();
  });

  it('R14 bounded native inspector refuses a FIFO descriptor before attempting any blocking stream read', async () => {
    const f = await fixture(); rmSync(f.file); execFileSync('mkfifo', [f.file]);
    // Real FIFO and writer descriptor. The original blocking reader is released
    // at its observed read boundary, never allowed to hang the test harness.
    let writer: number | null = openSync(f.file, constants.O_RDWR | constants.O_NONBLOCK);
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const originalRead = fs.readSync; let attempts = 0;
      fs.readSync = (...args) => {
        if (fs.fstatSync(args[0]).isFIFO()) { attempts += 1; process.send({ type: 'read-boundary' }); }
        return originalRead(...args);
      };
      syncBuiltinESMExports();
      const { readDirectiveSessionHeader } = await import(${JSON.stringify(new URL('../dist/runtime/directive-checkpoint.js', import.meta.url).href)});
      let refusal = { name: 'no refusal', message: 'unexpected successful stream inspection' };
      try { readDirectiveSessionHeader(process.argv[1]); } catch (error) { refusal = { name: error.name, message: error.message }; }
      process.send({ type: 'result', attempts, ...refusal }, () => process.disconnect());
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, f.file], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    if (child.stderr === null) { child.kill('SIGTERM'); throw new Error('native FIFO fixture requires its actual stderr pipe'); }
    let diagnostics = ''; child.stderr.on('data', (chunk: Buffer) => { diagnostics += chunk.toString('utf8'); });
    const exited = once(child, 'exit'); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`native FIFO fixture failed to report its bounded result: ${diagnostics}`)); }, 10_000);
        child.once('error', reject);
        child.on('message', (raw) => {
          if (typeof raw !== 'object' || raw === null) return;
          const message = raw as Record<string, unknown>;
          if (message.type === 'read-boundary' && writer !== null) { closeSync(writer); writer = null; }
          if (message.type === 'result') resolve(message);
        });
      });
      expect(await exited).toEqual([0, null]);
      expect(result).toEqual({ type: 'result', attempts: 0, name: 'DirectiveCheckpointError', message: expect.stringContaining('not a regular file') });
      expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('dispatching');
      expect(f.spawns).toEqual([]); expect(f.native.prompts).toEqual([]);
    } finally { if (timer !== undefined) clearTimeout(timer); if (writer !== null) closeSync(writer); child.kill('SIGTERM'); }
  });

  it('refuses an oversized directive turn before checkpointing; its admission and the session header still read (#469)', async () => {
    const f = await fixture(); f.seed();
    truncateSync(f.file, statSync(f.file).size + 32 * 1024 * 1024 + 1);
    expect(() => inspectDirectiveCheckpoint(f.file, f.identity)).toThrow(/native directive turn exceeds the .* inspection limit/);
    // Admission reads only its receipt; the oversized rest is not its evidence.
    expect(inspectDirectiveAdmission(f.file, f.identity)).toMatchObject({ identity: f.identity, userEntryId: expect.any(String) });
    expect(readDirectiveSessionHeader(f.file)).toMatchObject({ type: 'session', id: f.native.sessionId, cwd: f.lane.path });
  });

  it('refuses a native transcript holding invalid UTF-8 instead of decoding it into matching evidence (#363 S04-1-02)', async () => {
    const f = await fixture(); f.seed();
    // A byte that is no UTF-8 at all, inside an otherwise well-formed entry:
    // a lenient decode reads it as U+FFFD and the entry still parses.
    const invalid = (prefix: string) => Buffer.concat([Buffer.from(prefix), Buffer.from([0xff]), Buffer.from('"}\n')]);
    appendFileSync(f.file, invalid('{"type":"custom","note":"'));
    expect(() => inspectDirectiveCheckpoint(f.file, f.identity)).toThrow(/native transcript is not valid UTF-8/);
    // Admission reads only its receipt (#469): the corrupted entry after it is
    // never decoded, so it is never evidence either way.
    expect(inspectDirectiveAdmission(f.file, f.identity)).toMatchObject({ identity: f.identity, userEntryId: expect.any(String) });
    // The header is read alone (#469): the invalid byte must be its own.
    const header = await fixture();
    writeFileSync(header.file, invalid(`{"type":"session","id":"${header.native.sessionId}","cwd":"`));
    expect(() => readDirectiveSessionHeader(header.file)).toThrow(/native transcript is not valid UTF-8/);
    // A leading BOM is decoded exactly as before (kept, never stripped): the
    // header it precedes is still no JSON.
    const bom = await fixture(); bom.seed();
    writeFileSync(bom.file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(bom.file)]));
    expect(() => readDirectiveSessionHeader(bom.file)).toThrow(SyntaxError);
  });

  it('refuses oversized native association and producer journals before parsing', async () => {
    const associations = await fixture(); associations.seed();
    truncateSync(`${associations.file}.directives.jsonl`, 4 * 1024 * 1024 + 1);
    expect(() => readDirectiveBinding(associations.file, associations.identity.requestId)).toThrow(/directive native association exceeds the .* inspection limit/);

    const producers = await fixture(); producers.seed();
    truncateSync(`${producers.file}.producers.jsonl`, 4 * 1024 * 1024 + 1);
    expect(() => inspectDirectiveProducers(producers.file, producers.identity)).toThrow(/native producer journal exceeds the .* inspection limit/);
  });

  it('refuses excessive JSONL entry counts before splitting the evidence into arrays', async () => {
    // A directive turn is read only as far as its walk (#469): the first
    // id-less entry refuses it long before the 250,001st. The turn entry
    // limit itself is pinned in test/directive-transcript-bounds.test.ts.
    const transcript = await fixture(); transcript.seed();
    appendFileSync(transcript.file, '{}\n'.repeat(250_001));
    expect(inspectDirectiveCheckpoint(transcript.file, transcript.identity)).toEqual({ state: 'unknown', reason: 'native checkpoint has a malformed or duplicate entry identity' });

    const association = await fixture(); association.seed();
    writeFileSync(`${association.file}.directives.jsonl`, '{}\n'.repeat(100_001));
    expect(() => readDirectiveBinding(association.file, association.identity.requestId)).toThrow(/directive native association exceeds the entry inspection limit/);

    const producer = await fixture(); producer.seed();
    writeFileSync(`${producer.file}.producers.jsonl`, '{}\n'.repeat(100_001));
    expect(() => inspectDirectiveProducers(producer.file, producer.identity)).toThrow(/native producer journal exceeds the entry inspection limit/);
  });

  it('a pi session past the transcript limit still takes a directive end to end: only its own turn is inspected (#469)', async () => {
    const f = await fixture();
    const count = historyPastTranscriptLimit(f.file, (index, filler) => ({ type: 'message', id: `history-${index}`, parentId: index === 0 ? null : `history-${index - 1}`,
      message: index % 2 === 0 ? { role: 'user', content: [{ type: 'text', text: filler }] } : { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: filler }] } }));
    await executeAcceptedDirective(f.deps, f.intent.requestId);
    const row = f.ledger.getDirective(f.intent.requestId)!;
    expect(row.failReason).toBeNull();
    expect(row).toMatchObject({ state: 'settled', nativeTarget: { sessionFile: f.file }, nativeBinding: { runtime: 'pi', baseline: `history-${count - 1}`, userEntryId: expect.any(String) } });
    expect(inspectDirectiveCheckpoint(f.file, f.identity)).toMatchObject({ state: 'terminal', ok: true });
    expect(statSync(f.file).size).toBeGreaterThan(NATIVE_TRANSCRIPT_LIMIT);
    // The large session itself was resumed, never swapped for a fresh one.
    expect(f.spawns).toEqual([expect.objectContaining({ agentId: FIXTURE_MINION, resumeFile: f.file })]);
    expect(f.native.prompts).toHaveLength(1); expect(f.native.prompts[0]).not.toMatch(/^Fresh minion re-brief/u); expect(f.native.continuations).toBe(0);
  });

  // Kinds are the registered owner-required ones: the attention registry routes
  // any unregistered needs-owner request to Gru, which would void the scenario.
  it('an old open owner stop survives 1001 newer unrelated cards without starving another job or automatic acknowledgement', async () => {
    const f = await fixture();
    const stop = f.notifications.postIncident({ kind: 'supervision.restart-cleanup-unconfirmed', routing: 'needs-owner', severity: 'error', title: 'owner only', agentId: 'logical-minion', dedupe: 'active' });
    f.ledger.addJob({ id: 'independent-job', repo: 'fixture', title: 'independent' }); f.ledger.setJobStatus('independent-job', 'working');
    for (let i = 0; i < 1001; i += 1) f.notifications.postIncident({ kind: `gru.wake-blocked.unrelated-${i}`, routing: 'needs-owner', severity: 'info', title: 'unrelated unbound owner card', dedupe: 'active' });
    expect(() => f.ledger.assertRecoveryJobPermission(f.intent.jobId)).toThrow(/owner-only stop/);
    expect(() => f.ledger.assertRecoveryJobPermission('independent-job')).not.toThrow();
    expect(f.ledger.findNotificationByKind('supervision.restart-cleanup-unconfirmed', 'active')).toMatchObject({ ackedAt: null, resolvedAt: null }); expect(stop).toBeDefined();
  });

  async function assertPhysicalRetirementFence(mode: 'live' | 'missing' | 'foreign') {
    const f = await fixture(); f.seed();
    const physical = prepareDirectiveProducer({ identity: f.identity, agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file });
    if (mode === 'missing') rmSync(`${f.file}.producers.jsonl`);
    if (mode === 'foreign') writeFileSync(`${f.file}.producers.jsonl`, `${JSON.stringify({ state: 'started', producer: { ...physical, host: 'foreign-host' } })}\n`);
    const debt = f.ledger.openDirectiveRecoveryDebt(f.intent.requestId, 'unpublished physical producer start');
    const head = resolveGitCommit(f.lane.path, 'HEAD'); const watermark = f.ledger.latestEventSeq(); const original = f.ledger.getDirective(f.intent.requestId);
    let refusal: unknown;
    try { f.ledger.retireInterruptedDirective({ requestId: f.intent.requestId, expectedJobId: f.intent.jobId, expectedState: 'dispatching', expectedPayloadHash: f.intent.payloadHash,
      expectedHead: head, ...directiveRetirementInputs(f.ledger, f.intent.requestId), lane: { id: f.lane.id, resolvedHead: head },
      reason: 'no unsafe retirement', by: 'gru' }); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ code: 'live_work', blockers: ['original native physical owner cessation remains UNKNOWN'] });
    const input = { ledger: f.ledger, worktrees: f.worktrees, pendingProducerBlockers: () => [], requestId: f.intent.requestId, generation: debt.generation,
      expectedPayloadHash: f.intent.payloadHash, expectedHead: head, expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId), expectedWorkRevision: f.identity.workRevision,
      expectedContractSha256: f.identity.contractSha256, reason: 'physical owner remains unproven' };
    let successorRefusal: unknown;
    try { recoverInterruptedDirectiveFromRoute({ ...input, decision: { kind: 'successor', requestId: 'unsafe-native-successor', directive: 'never start' } }); } catch (error) { successorRefusal = error; }
    expect(successorRefusal).toMatchObject({ code: 'live_work', blockers: ['original native physical owner cessation remains UNKNOWN'] });
    expect(f.ledger.getDirective(f.intent.requestId)).toEqual(original); expect(f.ledger.latestEventSeq()).toBe(watermark);
    const owner = f.ledger.recordBlockedObservation(f.intent.jobId, { logicalStep: 'operation', incidentKey: 'original-native-owner-stop', category: { kind: 'known', category: 'owner-hold' },
      observedAtSeq: watermark, nextAction: { kind: 'owner-decision', decision: 'exact owner must judge unknown native ownership' } });
    const transferred = recoverInterruptedDirectiveFromRoute({ ...input, expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId), decision: { kind: 'owner-decision', obligationId: owner.id } });
    expect(transferred.successor).toBeNull(); expect(() => f.ledger.assertRecoveryJobPermission(f.intent.jobId)).toThrow(/owner-only/); expect(f.spawns).toEqual([]);
  }
  it('retirement and successor inspect a live native owner with no ledger start while owner-only transfer stays stopped', () => assertPhysicalRetirementFence('live'));
  it('retirement and successor reject missing native physical receipts without consuming original control', () => assertPhysicalRetirementFence('missing'));
  it('retirement and successor reject a foreign unprovable native host without granting owner-transfer work permission', () => assertPhysicalRetirementFence('foreign'));

  async function assertOldStreamingNotNormalized(mode: 'replacement-handle' | 'foreign-lock' | 'reused-lock' | 'older-unknown') {
    const f = await fixture(); f.seed(); f.ledger.setAgentState('logical-minion', 'streaming');
    if (mode === 'replacement-handle') f.registry.getHandle = () => ({ id: 'logical-minion', sessionFile: f.file, health: () => ({ state: 'streaming' }) } as unknown as AgentHandle);
    if (mode === 'foreign-lock' || mode === 'reused-lock') writeFileSync(`${f.file}.lock`, JSON.stringify({ host: mode === 'foreign-lock' ? 'foreign-host' : 'unbound-local-host', pid: process.pid, bootId: 'replacement-boot' }));
    if (mode === 'older-unknown') {
      const bytes = readFileSync(`${f.file}.producers.jsonl`, 'utf8');
      prepareDirectiveProducer({ identity: { ...f.identity, requestId: 'older-unaccounted-native-request', payloadHash: 'b'.repeat(64) }, agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file });
      const added = readFileSync(`${f.file}.producers.jsonl`, 'utf8').slice(bytes.length); writeFileSync(`${f.file}.producers.jsonl`, added + bytes);
    }
    const agent = f.ledger.getAgent('logical-minion'); const bytes = readFileSync(f.file, 'utf8'); const journal = readFileSync(`${f.file}.producers.jsonl`, 'utf8');
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled(); await service.dispose();
    expect(f.ledger.getAgent('logical-minion')).toEqual(agent); expect(f.spawns).toEqual([]); expect(f.native.continuations).toBe(0);
    expect(f.ledger.latestJobEventByRequestId(f.intent.jobId, 'job.delivered', f.intent.requestId)).toBeNull();
    expect(readFileSync(f.file, 'utf8')).toBe(bytes); expect(readFileSync(`${f.file}.producers.jsonl`, 'utf8')).toBe(journal);
  }
  it('ceased receipt replay never disposes a different live replacement handle', () => assertOldStreamingNotNormalized('replacement-handle'));
  it('ceased receipt replay never disposes a foreign current native lock owner', () => assertOldStreamingNotNormalized('foreign-lock'));
  it('ceased receipt replay never disposes a reused unbound native lock incarnation', () => assertOldStreamingNotNormalized('reused-lock'));
  it('ceased receipt replay accounts for older UNKNOWN owners from other requests before stream normalization', () => assertOldStreamingNotNormalized('older-unknown'));

  async function assertCeasedStreamingReplay(receipt: boolean) {
    const f = await fixture(); f.seed(); const producer = inspectDirectiveProducers(f.file, f.identity)[0]!.producer;
    const start = f.ledger.startDirectiveProducer(f.identity, producer);
    if (receipt) f.ledger.appendCustomEvent({ kind: 'silas.directive-producer-ceased', jobId: f.intent.jobId,
      payload: { request_id: f.intent.requestId, producer_start_seq: start, producer_identity: f.identity, native_producer: producer, agent_id: producer.agentId, session_file: f.file } });
    f.ledger.setAgentState(producer.agentId, 'streaming');
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled(); await service.dispose();
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled'); expect(f.ledger.getAgent(producer.agentId)?.state).toBe('disposed');
    expect(f.native.continuations).toBe(1); expect(f.native.prompts).toEqual([]);
  }
  it('exact ceased native journal repairs stale streaming state before checkpoint continuation', () => assertCeasedStreamingReplay(false));
  it('already committed cessation receipt replay still repairs its exact stale streaming agent', () => assertCeasedStreamingReplay(true));

  it('rebrief writer-clearance refusal has positive original pre-native deferral and reconsiders only after its real gate settles', async () => {
    const f = await fixture('rebrief'); let blocked = true;
    const deps = { ...f.deps, clearLaneForWriter: async () => { if (blocked) throw new Error('review stop remains unconfirmed'); } };
    await executeAcceptedDirective(deps, f.intent.requestId);
    expect(f.ledger.hasDirectiveDispatchDeferral(f.intent.requestId)).toBe(true); expect(f.spawns).toEqual([]); expect(f.native.prompts).toEqual([]);
    const service = new DirectiveProgressService(deps); service.reconsider(); await service.settled(); expect(f.spawns).toEqual([]);
    blocked = false; service.reconsider(); await service.settled(); await service.dispose();
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled'); expect(f.native.prompts).toHaveLength(1); expect(f.native.continuations).toBe(0);
  });

  it('a runtime that refuses preparation leaves no retained target, so the same request stays retirable (#453)', async () => {
    const f = await fixture();
    const refusing: DirectiveRegistry = {
      getHandle: (agentId) => f.deps.registry.getHandle(agentId),
      async spawn(role, options) {
        const handle = await f.deps.registry.spawn(role, options);
        // The runtime refuses AFTER the route has decided to prepare: the
        // fixture stands in for a busy session or an independent controller.
        Object.defineProperty(handle, 'prepareDirectiveProducer', {
          configurable: true,
          value: () => { throw new DirectiveCheckpointError('native producer preparation requires genuine idle without independent controllers'); },
        });
        return handle;
      },
      async disposeHandle(handle) { await f.deps.registry.disposeHandle(handle); },
    };
    await executeAcceptedDirective({ ...f.deps, registry: refusing }, f.intent.requestId);
    expect(f.native.prompts).toEqual([]);
    // Nothing durable claims a native start, so nothing fenced the request.
    expect(f.ledger.getDirective(f.intent.requestId)?.nativeTarget).toBeNull();
    const head = resolveGitCommit(f.lane.path, 'HEAD');
    const retired = f.ledger.retireInterruptedDirective({ requestId: f.intent.requestId, expectedJobId: f.intent.jobId,
      expectedState: f.ledger.getDirective(f.intent.requestId)!.state as 'dispatching', expectedPayloadHash: f.intent.payloadHash,
      expectedHead: head, ...directiveRetirementInputs(f.ledger, f.intent.requestId), lane: { id: f.lane.id, resolvedHead: head },
      reason: 'preparation refused before any native target', by: 'gru' });
    expect(retired.record.state).toBe('retired');
  });

  it('an interrupted preparation that journaled a producer but retained no target stays retirable (#453)', async () => {
    const f = await fixture();
    // The crash window's durable residue: the physical producer journal was
    // flushed, while the ledger never recorded a target or a start. No native
    // turn can have run, so this must not fence the request forever.
    prepareDirectiveProducer({ identity: f.identity, agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file });
    expect(f.ledger.getDirective(f.intent.requestId)?.nativeTarget).toBeNull();
    expect(f.ledger.latestJobEventByRequestId(f.intent.jobId, 'silas.directive-producer-started', f.intent.requestId)).toBeNull();
    expect(f.native.prompts).toEqual([]);
    const head = resolveGitCommit(f.lane.path, 'HEAD');
    const retired = f.ledger.retireInterruptedDirective({ requestId: f.intent.requestId, expectedJobId: f.intent.jobId,
      expectedState: 'dispatching', expectedPayloadHash: f.intent.payloadHash, expectedHead: head,
      ...directiveRetirementInputs(f.ledger, f.intent.requestId), lane: { id: f.lane.id, resolvedHead: head },
      reason: 'interrupted before any target was retained', by: 'gru' });
    expect(retired.record.state).toBe('retired');
  });

  async function assertStaleTerminalTail(tail: 'user' | 'branch' | 'assistant' | 'partial') {
    const f = await fixture(); f.seed(); f.native.finish();
    expect(inspectDirectiveCheckpoint(f.file, f.identity)).toMatchObject({ state: 'terminal', ok: true });
    if (tail === 'user') f.native.append({ role: 'user', content: [{ type: 'text', text: 'foreign turn' }] });
    if (tail === 'assistant') f.native.append({ role: 'assistant', stopReason: 'stop', content: [] });
    if (tail === 'branch') appendFileSync(f.file, `${JSON.stringify({ type: 'branch', id: 'foreign-control' })}\n`);
    if (tail === 'partial') appendFileSync(f.file, `${JSON.stringify({ type: 'message', id: 'partial', message: { role: 'assistant' } })}\n`);
    const bytes = readFileSync(f.file, 'utf8');
    expect(inspectDirectiveCheckpoint(f.file, f.identity).state).toBe('unknown');
    expect(settleNativeDirective(f.deps, f.identity)).toBe(false);
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
    expect(readFileSync(f.file, 'utf8')).toBe(bytes);
  }
  /** The original's controls tail, then a later prompt bound on it. The
   * original stays unsettled until the tail is read: only a linked tail lets
   * it settle. */
  async function assertBoundControlTail(mode: 'linked' | 'max-thinking' | 'off-thinking' | 'wrong-parent' | 'malformed-compaction' | 'malformed-model' | 'malformed-thinking') {
    const f = await fixture(); f.seed(); f.native.finish();
    const original = inspectDirectiveCheckpoint(f.file, f.identity);
    if (original.state !== 'terminal') throw new Error('original fixture must genuinely complete');
    const model = { type: 'model_change', id: 'later-model-control',
      parentId: mode === 'wrong-parent' ? 'unbound-parent' : original.checkpointId,
      provider: mode === 'malformed-model' ? undefined : 'fixture', modelId: 'later-model' };
    const thinking = { type: 'thinking_level_change', id: 'later-thinking-control', parentId: model.id,
      thinkingLevel: mode === 'malformed-thinking' ? 'turbo' : mode === 'max-thinking' ? 'max' : mode === 'off-thinking' ? 'off' : 'high' };
    // Pi's own compaction shape, but with a blank summary.
    const control = mode === 'malformed-compaction' ? piCompaction(model.id, original.checkpointId, original.checkpointId, { summary: ' ' }) : JSON.stringify(model);
    appendFileSync(f.file, `${control}\n${JSON.stringify(thinking)}\n`);
    const later = bindLaterRequest(f, undefined, true);
    expect(readDirectiveBinding(f.file, later.requestId)?.baseline).toBe(thinking.id);
    const bytes = readFileSync(f.file, 'utf8');
    const observed = inspectDirectiveCheckpoint(f.file, f.identity);
    const reasons = { 'wrong-parent': 'native control is not linked to the completed checkpoint', 'malformed-compaction': 'native compaction lacks a summary',
      'malformed-model': 'native model control is malformed', 'malformed-thinking': 'native thinking-level control is malformed' };
    const linked = mode === 'linked' || mode === 'max-thinking' || mode === 'off-thinking';
    if (linked) expect(observed).toEqual(original);
    else expect(observed).toEqual({ state: 'unknown', reason: reasons[mode] });
    expect(readFileSync(f.file, 'utf8')).toBe(bytes);
    expectSettlement(f, linked, mode);
  }
  it('P46 preserves original completion through linked model and thinking controls into a later bound request', () => assertBoundControlTail('linked'));
  it('P46 preserves original completion through Pi\'s max thinking level into a later bound request, and settles once', () => assertBoundControlTail('max-thinking'));
  it('P46 preserves original completion through Pi\'s off thinking level into a later bound request, and settles once', () => assertBoundControlTail('off-thinking'));
  it('P46 refuses later bound controls whose ancestry does not descend from the original checkpoint', () => assertBoundControlTail('wrong-parent'));
  it('P46 refuses a malformed compaction control even when a later request is independently bound', () => assertBoundControlTail('malformed-compaction'));
  it('P46 refuses malformed model controls before an independently bound later request', () => assertBoundControlTail('malformed-model'));
  it('P46 refuses a malformed thinking-level control before an independently bound later request, and never settles', () => assertBoundControlTail('malformed-thinking'));
  /** Pi's own automatic compaction entry (#481), as the pinned SDK appends it.
   * `tokensBefore: '1e400'` writes the raw JSON number, which parses as Infinity. */
  const piCompaction = (id: string, parentId: string, firstKeptEntryId: string, fields: Record<string, unknown> = {}) =>
    JSON.stringify({ type: 'compaction', id, parentId, timestamp: new Date().toISOString(), summary: 'Pi automatic compaction summary',
      firstKeptEntryId, tokensBefore: 90_000, details: { readFiles: [], modifiedFiles: [] }, fromHook: false, ...fields })
      .replace('"tokensBefore":"1e400"', '"tokensBefore":1e400');
  const appendLine = (file: string, line: string) => appendFileSync(file, `${line}\n`);
  const lastEntryId = (file: string) => (JSON.parse(readFileSync(file, 'utf8').trimEnd().split('\n').at(-1)!) as { id: string }).id;
  /** A terminal settles and delivers exactly once; an UNKNOWN checkpoint neither settles nor delivers. */
  function expectSettlement(f: Awaited<ReturnType<typeof fixture>>, settles: boolean, label: string) {
    expect(settleNativeDirective(f.deps, f.identity), label).toBe(settles);
    expect(f.ledger.getDirective(f.identity.requestId)?.state === 'settled', label).toBe(settles);
    expect(f.ledger.listJobEventsByKinds(f.intent.jobId, ['job.delivered']), label).toHaveLength(settles ? 1 : 0);
  }
  const NOT_LINKED = 'native compaction is not linked to the active checkpoint';
  const OFF_CHAIN = 'native compaction keeps an entry off the active chain';
  const NO_TIMESTAMP = 'native compaction lacks a timestamp';
  const NO_SUMMARY = 'native compaction lacks a summary';
  const BAD_TOKENS = 'native compaction token count is malformed';
  const HOOK_AUTHORED = 'native compaction summary was authored by an extension hook';
  const HOOK_MARKER = 'native compaction hook marker is malformed';
  const NOT_AFTER_ROUND = 'native compaction does not follow a completed tool round';
  const OPEN_ROUND = 'native compaction interrupts an open tool round';
  type TurnCompaction = 'linked' | 'active-ancestor-first-kept' | 'kept-after-directive' | 'second-compaction' | 'overflow-retry' | 'length-retry' |
    'overflow-retry-kept-failed' | 'overflow-retry-hook' | 'wrong-parent' | 'unknown-first-kept' | 'known-sibling-first-kept' | 'session-header-first-kept' | 'self-first-kept' |
    'compaction-first-kept' | 'hook-authored' | 'hook-marker-string' | 'missing-hook-marker' | 'missing-timestamp' |
    'blank-timestamp' | 'missing-summary' | 'blank-summary' | 'tokens-nan' | 'tokens-infinite' | 'tokens-negative' | 'tokens-string' |
    'after-user' | 'open-tool-call' | 'mid-batch' | 'consecutive-compaction' | 'branch-control';
  /** One directive turn with Pi's mid-run compaction after a completed tool
   * round (or a defect in it), then the turn's own terminal. */
  async function assertTurnCompaction(mode: TurnCompaction, refusal: string | null) {
    const f = await fixture();
    const headerId = (JSON.parse(readFileSync(f.file, 'utf8').split('\n')[0]!) as { id: string }).id;
    if (mode === 'active-ancestor-first-kept' || mode === 'known-sibling-first-kept' || mode === 'session-header-first-kept') {
      // A branched prefix: the baseline descends from active-ancestor, never from the sibling.
      const prefixParent = { type: 'message', id: 'prefix-parent', parentId: headerId, message: { role: 'assistant', stopReason: 'stop', content: [] } };
      const activeAncestor = { type: 'message', id: 'active-ancestor', parentId: prefixParent.id, message: { role: 'assistant', stopReason: 'stop', content: [] } };
      const sibling = { type: 'message', id: 'sibling-first-kept', parentId: prefixParent.id, message: { role: 'assistant', stopReason: 'stop', content: [] } };
      const baseline = { type: 'model_change', id: 'active-baseline', parentId: activeAncestor.id, provider: 'fixture', modelId: 'model' };
      appendLine(f.file, [prefixParent, activeAncestor, sibling, baseline].map((entry) => JSON.stringify(entry)).join('\n'));
    }
    f.seed();
    const user = lastEntryId(f.file);
    if (mode === 'after-user') appendLine(f.file, piCompaction('compaction', user, user));
    const call = f.native.append(mode === 'mid-batch' ? { ...bashCall('first'), content: [...bashCall('first').content, ...bashCall('sibling').content] } : bashCall('first'));
    if (mode === 'open-tool-call') appendLine(f.file, piCompaction('compaction', call, user));
    const result = f.native.append(bashResult('first', false));
    if (mode === 'mid-batch') {
      // Between two results of one parallel batch: the round is still open.
      appendLine(f.file, piCompaction('compaction', result, user));
      f.native.append(bashResult('sibling', false));
    }
    if (mode === 'overflow-retry' || mode === 'length-retry' || mode === 'overflow-retry-kept-failed' || mode === 'overflow-retry-hook') {
      // Pi's compact-and-retry: the failed reply, a compaction on it, then
      // finish() as the reply continued from that compaction. A tool call in
      // the failed reply never ran.
      const failed = f.native.append(mode === 'length-retry' ? { role: 'assistant', stopReason: 'length', content: [{ type: 'text', text: 'truncated' }] }
        : { role: 'assistant', stopReason: 'error', errorMessage: 'prompt is too long: 150000 tokens > 100000 maximum', content: bashCall('never-run').content });
      // Pi may keep the failed reply itself in the rebuilt context.
      appendLine(f.file, piCompaction('compaction', failed, mode === 'overflow-retry-kept-failed' ? failed : user, mode === 'overflow-retry-hook' ? { fromHook: true } : {}));
    } else if (mode !== 'after-user' && mode !== 'open-tool-call' && mode !== 'mid-batch') {
      const kept: Partial<Record<TurnCompaction, string>> = { 'active-ancestor-first-kept': 'active-ancestor', 'known-sibling-first-kept': 'sibling-first-kept',
        // Kept after the directive's own user entry: its text leaves the model's
        // context but stays in the transcript, and GC correlates effects only.
        'kept-after-directive': call, 'unknown-first-kept': 'foreign-entry', 'session-header-first-kept': headerId, 'self-first-kept': 'compaction' };
      const fields: Partial<Record<TurnCompaction, Record<string, unknown>>> = { 'hook-authored': { fromHook: true }, 'hook-marker-string': { fromHook: 'false' },
        'missing-hook-marker': { fromHook: undefined },
        'missing-timestamp': { timestamp: undefined }, 'blank-timestamp': { timestamp: ' ' }, 'missing-summary': { summary: undefined }, 'blank-summary': { summary: '\n' },
        // JSON writes NaN as null.
        'tokens-nan': { tokensBefore: Number.NaN }, 'tokens-infinite': { tokensBefore: '1e400' }, 'tokens-negative': { tokensBefore: -1 }, 'tokens-string': { tokensBefore: '90000' } };
      if (mode === 'branch-control') appendLine(f.file, JSON.stringify({ type: 'branch', id: 'compaction', parentId: result }));
      else appendLine(f.file, piCompaction('compaction', mode === 'wrong-parent' ? 'foreign-parent' : result, kept[mode] ?? user, fields[mode]));
      if (mode === 'consecutive-compaction') appendLine(f.file, piCompaction('second-compaction', 'compaction', user));
      if (mode === 'second-compaction' || mode === 'compaction-first-kept') {
        const second = f.native.append(bashCall('second')); f.native.append(bashResult('second', false));
        // Pi keeps a message; the earlier compaction is never a kept entry.
        appendLine(f.file, piCompaction('second-compaction', lastEntryId(f.file), mode === 'second-compaction' ? second : 'compaction'));
      }
    }
    f.native.finish();
    const proof = inspectDirectiveCheckpoint(f.file, f.identity);
    if (refusal === null) expect(proof, mode).toMatchObject({ state: 'terminal', ok: true, checkpointId: lastEntryId(f.file) });
    else expect(proof, mode).toEqual({ state: 'unknown', reason: refusal });
    expectSettlement(f, refusal === null, mode);
  }
  it('P46 walks past Pi compaction linked after a completed tool round and settles the directive once', async () => {
    for (const mode of ['linked', 'active-ancestor-first-kept', 'kept-after-directive', 'second-compaction'] as const) await assertTurnCompaction(mode, null);
  });
  it('P46 walks past Pi\'s overflow compact-and-retry: the failed reply is history and the retried turn settles once', async () => {
    for (const mode of ['overflow-retry', 'length-retry', 'overflow-retry-kept-failed'] as const) await assertTurnCompaction(mode, null);
    // A hook-authored compaction on the failed reply (which carries a tool call) is refused by its own name.
    await assertTurnCompaction('overflow-retry-hook', HOOK_AUTHORED);
  });
  it('P46 refuses by name a compaction that is not Pi\'s own automatic summary, and never settles', async () => {
    for (const [mode, reason] of [['hook-authored', HOOK_AUTHORED], ['hook-marker-string', HOOK_MARKER], ['missing-hook-marker', HOOK_MARKER],
      ['missing-timestamp', NO_TIMESTAMP], ['blank-timestamp', NO_TIMESTAMP], ['missing-summary', NO_SUMMARY], ['blank-summary', NO_SUMMARY],
      ['tokens-nan', BAD_TOKENS], ['tokens-infinite', BAD_TOKENS], ['tokens-negative', BAD_TOKENS], ['tokens-string', BAD_TOKENS]] as const) {
      await assertTurnCompaction(mode, reason);
    }
  });
  it('P46 refuses by name a compaction off the active chain, and never settles', async () => {
    for (const [mode, reason] of [['wrong-parent', NOT_LINKED], ['unknown-first-kept', OFF_CHAIN], ['known-sibling-first-kept', OFF_CHAIN],
      ['session-header-first-kept', OFF_CHAIN], ['self-first-kept', OFF_CHAIN], ['compaction-first-kept', 'native compaction keeps another compaction, not a message']] as const) {
      await assertTurnCompaction(mode, reason);
    }
  });
  it('P46 refuses by name a compaction inside an open tool round or before the first call, and never settles', async () => {
    for (const [mode, reason] of [['after-user', NOT_AFTER_ROUND], ['open-tool-call', OPEN_ROUND], ['mid-batch', OPEN_ROUND],
      ['consecutive-compaction', NOT_AFTER_ROUND], ['branch-control', 'native branch/control/partial checkpoint']] as const) {
      await assertTurnCompaction(mode, reason);
    }
  });

  it('P46 reads a turn the host lost right after Pi\'s mid-run compaction as resumable at the compaction, never settled', async () => {
    const f = await fixture(); f.seed();
    const user = lastEntryId(f.file);
    f.native.append(bashCall('first'));
    const result = f.native.append(bashResult('first', false));
    // crash-after-compaction: Pi wrote the compaction; the next model call never started.
    appendLine(f.file, piCompaction('compaction', result, user));
    expect(inspectDirectiveCheckpoint(f.file, f.identity)).toMatchObject({ state: 'resumable', checkpointId: 'compaction' });
    expectSettlement(f, false, 'crash-after-compaction');
  });

  it('P46 reads a turn the host lost between Pi\'s compaction on a failed reply and the continued reply as that failed reply, never resumed', async () => {
    for (const calls of [false, true]) {
      const f = await fixture(); f.seed();
      const user = lastEntryId(f.file);
      f.native.append(bashCall('first')); f.native.append(bashResult('first', false));
      const overflow = 'prompt is too long: 150000 tokens > 100000 maximum';
      const failed = f.native.append({ role: 'assistant', stopReason: 'error', errorMessage: overflow, content: calls ? bashCall('never-run').content : [] });
      // The run ended on that error: only Pi's compaction ran after it, and
      // continue() would reject the assistant tip. This is the failed reply's
      // terminal, with or without tool calls: an error reply's calls never
      // ran and owe no results (owner ruling 2026-10-22, #483).
      appendLine(f.file, piCompaction('compaction', failed, user));
      expect(inspectDirectiveCheckpoint(f.file, f.identity), `calls: ${String(calls)}`).toMatchObject({ state: 'terminal', ok: false, checkpointId: failed, error: overflow });
      expectSettlement(f, false, calls ? 'lost-continued-reply-with-calls' : 'lost-continued-reply');
    }
  });

  it('P46 admits the receipt after Pi\'s pre-prompt compaction linked on the baseline, and refuses an unlinked one by name', async () => {
    for (const [label, fields, refusal] of [['linked', {}, null], ['no summary', { summary: undefined }, NO_SUMMARY],
      ['wrong parent', { parentId: 'foreign-parent' }, NOT_LINKED]] as const) {
      const f = await fixture();
      f.native.append({ role: 'user', content: [{ type: 'text', text: 'earlier ordinary work' }] });
      // An aborted reply is never compacted after its run, so Pi compacts before the next prompt.
      const baseline = f.native.append({ role: 'assistant', stopReason: 'aborted', content: [] });
      f.seed('accepted native prompt', () => appendLine(f.file, piCompaction('pre-prompt-compaction', baseline, baseline, fields)));
      const user = JSON.parse(readFileSync(f.file, 'utf8').trimEnd().split('\n').at(-1)!) as { id: string; parentId: string };
      expect(user.parentId, label).toBe('pre-prompt-compaction');
      expect(readDirectiveBinding(f.file, f.identity.requestId)?.baseline, label).toBe(baseline);
      if (refusal === null) expect(inspectDirectiveAdmission(f.file, f.identity), label).toMatchObject({ baseline, userEntryId: user.id });
      else expect(() => inspectDirectiveAdmission(f.file, f.identity), label).toThrow(new DirectiveCheckpointError(refusal));
      f.native.finish();
      const proof = inspectDirectiveCheckpoint(f.file, f.identity);
      if (refusal === null) expect(proof, label).toMatchObject({ state: 'terminal', ok: true, binding: { baseline, userEntryId: user.id } });
      else expect(proof, label).toEqual({ state: 'unknown', reason: refusal });
      // Settlement restores admission first, so an unreadable receipt refuses it by the same name.
      if (refusal === null) expectSettlement(f, true, label);
      else {
        expect(() => settleNativeDirective(f.deps, f.identity), label).toThrow(new DirectiveCheckpointError(refusal));
        expect(f.ledger.getDirective(f.identity.requestId)?.state, label).not.toBe('settled');
        expect(f.ledger.listJobEventsByKinds(f.intent.jobId, ['job.delivered']), label).toHaveLength(0);
      }
    }
  });

  /** A later request bound on the same session after the original's terminal.
   * `nativeOnly`: the original is still live in the ledger, which admits no
   * second request; the native association alone binds the later prompt, and
   * that is all checkpoint readback consults. */
  function bindLaterRequest(f: Awaited<ReturnType<typeof fixture>>, beforeReceipt?: () => void, nativeOnly = false): DirectiveTurnIdentity {
    const identity = nativeOnly ? { ...f.identity, requestId: 'later-bound-native-turn', payloadHash: 'b'.repeat(64) }
      : f.ledger.directiveTurnIdentity(f.ledger.beginDirectiveIntent({ jobId: f.intent.jobId, requestId: 'later-bound-native-turn', directive: 'separate accepted turn', holder: 'gru' }).record.requestId);
    if (!nativeOnly) f.ledger.prepareDirectiveTarget(identity.requestId, { agentId: 'logical-minion', sessionFile: f.file });
    prepareDirectiveBinding({ identity, runtime: 'pi', agentId: 'logical-minion', sessionId: f.native.sessionId,
      sessionFile: f.file, text: 'separate accepted turn', authorityManifest: 'separate accepted fixture authority' });
    beforeReceipt?.();
    f.native.append({ role: 'user', content: [{ type: 'text', text: 'separate accepted turn' }] });
    const admitted = inspectDirectiveAdmission(f.file, identity);
    if (!nativeOnly) f.ledger.bindDirectiveNativeAdmission(admitted);
    return identity;
  }
  /** Pi's post-run compaction follows the directive's final assistant (#481):
   * lookahead after the terminal, alone or before a later prompt. */
  async function assertPostRunCompaction(tail: 'alone' | 'hook-authored' | 'unbound-user' | 'bound-after-compaction' | 'bound-before-compaction' |
    'bound-after-control-compaction' | 'hook-after-control' | 'malformed-after-control' | 'compaction-after-compaction') {
    const f = await fixture(); f.seed();
    const user = lastEntryId(f.file);
    f.native.finish();
    const terminal = inspectDirectiveCheckpoint(f.file, f.identity);
    if (terminal.state !== 'terminal' || !terminal.ok) throw new Error('fixture must contain a real successful terminal assistant');
    const compaction = (fields?: Record<string, unknown>) => appendLine(f.file, piCompaction('post-run-compaction', terminal.checkpointId, user, fields));
    if (tail === 'bound-before-compaction') {
      // The compaction is the later request's own pre-prompt compaction: its binding's baseline is the original terminal.
      expect(settleNativeDirective(f.deps, f.identity)).toBe(true);
      const later = bindLaterRequest(f, () => compaction());
      expect(readDirectiveBinding(f.file, later.requestId)?.baseline).toBe(terminal.checkpointId);
      expect(inspectDirectiveCheckpoint(f.file, f.identity)).toEqual(terminal);
      expect(inspectDirectiveCheckpoint(f.file, later)).toMatchObject({ state: 'resumable', binding: { baseline: terminal.checkpointId } });
      return;
    }
    if (tail === 'bound-after-control-compaction') {
      // A later prompt's model change, then that prompt's own pre-prompt compaction on it.
      expect(settleNativeDirective(f.deps, f.identity)).toBe(true);
      appendLine(f.file, JSON.stringify({ type: 'model_change', id: 'later-model-control', parentId: terminal.checkpointId, provider: 'fixture', modelId: 'later-model' }));
      const later = bindLaterRequest(f, () => appendLine(f.file, piCompaction('later-compaction', 'later-model-control', terminal.checkpointId)));
      expect(readDirectiveBinding(f.file, later.requestId)?.baseline).toBe('later-model-control');
      expect(inspectDirectiveCheckpoint(f.file, f.identity)).toEqual(terminal);
      expect(inspectDirectiveCheckpoint(f.file, later)).toMatchObject({ state: 'resumable', binding: { baseline: 'later-model-control' } });
      return;
    }
    if (tail === 'hook-after-control' || tail === 'malformed-after-control' || tail === 'compaction-after-compaction') {
      // A later prompt's own controls, then a compaction Pi never writes there, then that bound prompt.
      if (tail === 'compaction-after-compaction') compaction();
      else appendLine(f.file, JSON.stringify({ type: 'thinking_level_change', id: 'later-thinking-control', parentId: terminal.checkpointId, thinkingLevel: 'high' }));
      const tip = lastEntryId(f.file);
      appendLine(f.file, piCompaction('later-compaction', tip, user, tail === 'hook-after-control' ? { fromHook: true } : tail === 'malformed-after-control' ? { summary: undefined } : {}));
      const later = bindLaterRequest(f, undefined, true);
      expect(readDirectiveBinding(f.file, later.requestId)).toMatchObject({ baseline: 'later-compaction', userEntryId: lastEntryId(f.file) });
      const reason = { 'hook-after-control': HOOK_AUTHORED, 'malformed-after-control': NO_SUMMARY, 'compaction-after-compaction': 'native compaction follows another compaction' }[tail];
      expect(inspectDirectiveCheckpoint(f.file, f.identity)).toEqual({ state: 'unknown', reason });
      expectSettlement(f, false, tail);
      return;
    }
    compaction(tail === 'hook-authored' ? { fromHook: true } : {});
    if (tail === 'alone') {
      expect(inspectDirectiveCheckpoint(f.file, f.identity)).toEqual(terminal);
      expectSettlement(f, true, tail);
      expect(f.ledger.latestJobEventByRequestId(f.intent.jobId, 'job.delivered', f.intent.requestId)?.payload)
        .toMatchObject({ native_completion: { checkpoint_id: terminal.checkpointId } });
    } else if (tail === 'hook-authored') {
      expect(inspectDirectiveCheckpoint(f.file, f.identity)).toEqual({ state: 'unknown', reason: HOOK_AUTHORED });
      expectSettlement(f, false, tail);
    } else if (tail === 'unbound-user') {
      // The same shape as bound-after-compaction; only the later prompt's own durable admission differs.
      f.native.append({ role: 'user', content: [{ type: 'text', text: 'unbound later prompt' }] });
      expect(inspectDirectiveCheckpoint(f.file, f.identity)).toEqual({ state: 'unknown', reason: 'native entries follow the correlated terminal checkpoint without a distinct bound request' });
      expectSettlement(f, false, tail);
    } else {
      expect(settleNativeDirective(f.deps, f.identity)).toBe(true);
      const later = bindLaterRequest(f);
      expect(readDirectiveBinding(f.file, later.requestId)?.baseline).toBe('post-run-compaction');
      expect(inspectDirectiveCheckpoint(f.file, f.identity)).toEqual(terminal);
      expect(inspectDirectiveCheckpoint(f.file, later)).toMatchObject({ state: 'resumable', binding: { baseline: 'post-run-compaction' } });
    }
  }
  it('P46 reads Pi\'s post-run compaction after the terminal as lookahead: the original completion settles once', () => assertPostRunCompaction('alone'));
  it('P46 refuses by name a hook-authored compaction after the terminal, and never settles', () => assertPostRunCompaction('hook-authored'));
  it('P46 refuses an unbound user turn after a valid post-run compaction', () => assertPostRunCompaction('unbound-user'));
  it('P46 keeps the original completion readable when a later request binds after its post-run compaction', () => assertPostRunCompaction('bound-after-compaction'));
  it('P46 keeps the original completion readable when a later request binds before its own pre-prompt compaction', () => assertPostRunCompaction('bound-before-compaction'));
  it('P46 keeps the original completion readable through a later model change and that prompt\'s pre-prompt compaction', () => assertPostRunCompaction('bound-after-control-compaction'));
  it('P46 refuses by name a hook-authored compaction after a later prompt\'s control, and never settles', () => assertPostRunCompaction('hook-after-control'));
  it('P46 refuses by name a malformed compaction after a later prompt\'s control, and never settles', () => assertPostRunCompaction('malformed-after-control'));
  it('P46 refuses by name a compaction on another compaction after the terminal, and never settles', () => assertPostRunCompaction('compaction-after-compaction'));

  it('keeps an exact completed checkpoint readable after a later distinct request is durably admitted on the same session', async () => {
    const f = await fixture(); f.seed(); f.native.finish();
    const original = inspectDirectiveCheckpoint(f.file, f.identity);
    expect(original).toMatchObject({ state: 'terminal', ok: true });
    expect(settleNativeDirective(f.deps, f.identity)).toBe(true);
    const later = f.ledger.beginDirectiveIntent({ jobId: f.intent.jobId, requestId: 'later-bound-native-turn', directive: 'separate accepted turn', holder: 'gru' }).record;
    const identity = f.ledger.directiveTurnIdentity(later.requestId);
    f.ledger.prepareDirectiveTarget(later.requestId, { agentId: 'logical-minion', sessionFile: f.file });
    prepareDirectiveBinding({ identity, runtime: 'pi', agentId: 'logical-minion', sessionId: f.native.sessionId,
      sessionFile: f.file, text: 'separate accepted turn', authorityManifest: 'separate accepted fixture authority' });
    f.native.append({ role: 'user', content: [{ type: 'text', text: 'separate accepted turn' }] });
    f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, identity));
    expect(inspectDirectiveCheckpoint(f.file, f.identity)).toEqual(original);
    expect(inspectDirectiveCheckpoint(f.file, identity).state).toBe('resumable');

    const gap = await fixture(); gap.seed(); gap.native.finish();
    expect(settleNativeDirective(gap.deps, gap.identity)).toBe(true);
    gap.native.append({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'unbound intervening native turn' }] });
    const successor = gap.ledger.beginDirectiveIntent({ jobId: gap.intent.jobId, requestId: 'bound-after-unknown-gap', directive: 'later separately accepted turn', holder: 'gru' }).record;
    const successorIdentity = gap.ledger.directiveTurnIdentity(successor.requestId);
    gap.ledger.prepareDirectiveTarget(successor.requestId, { agentId: 'logical-minion', sessionFile: gap.file });
    prepareDirectiveBinding({ identity: successorIdentity, runtime: 'pi', agentId: 'logical-minion', sessionId: gap.native.sessionId,
      sessionFile: gap.file, text: 'later separately accepted turn', authorityManifest: 'separate accepted fixture authority' });
    gap.native.append({ role: 'user', content: [{ type: 'text', text: 'later separately accepted turn' }] });
    gap.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(gap.file, successorIdentity));
    expect(inspectDirectiveCheckpoint(gap.file, gap.identity).state).toBe('unknown');
  });
  it('rejects a native checkpoint with duplicate entry IDs', async () => {
    const f = await fixture(); f.seed();
    const user = JSON.parse(readFileSync(f.file, 'utf8').trimEnd().split('\n').at(-1)!) as { id: string };
    appendFileSync(f.file, `${JSON.stringify({ type: 'message', id: user.id, parentId: user.id,
      message: { role: 'assistant', stopReason: 'stop', content: [] } })}\n`);
    expect(inspectDirectiveCheckpoint(f.file, f.identity).state).toBe('unknown');
  });
  it('uses the actual Pi ancestry after model and thinking control entries when preparing a directive baseline', async () => {
    const f = await fixture();
    const modelChange = { type: 'model_change', id: 'model-change-before-directive', parentId: null, provider: 'fixture', modelId: 'model', timestamp: Date.now() };
    const thinkingChange = { type: 'thinking_level_change', id: 'thinking-change-before-directive', parentId: modelChange.id, thinkingLevel: 'high', timestamp: Date.now() };
    appendFileSync(f.file, `${JSON.stringify(modelChange)}\n${JSON.stringify(thinkingChange)}\n`);
    f.ledger.prepareDirectiveTarget(f.intent.requestId, { agentId: 'logical-minion', sessionFile: f.file });
    const binding = prepareDirectiveBinding({ identity: f.identity, runtime: 'pi', agentId: 'logical-minion', sessionId: f.native.sessionId,
      sessionFile: f.file, text: 'accepted native prompt', authorityManifest: 'current fixture authority' });
    expect(binding.baseline).toBe(thinkingChange.id);
    f.native.append({ role: 'user', content: [{ type: 'text', text: 'accepted native prompt' }] });
    f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, f.identity));
    expect(inspectDirectiveCheckpoint(f.file, f.identity).state).toBe('resumable');
  });
  const bashCall = (id: string) => ({ role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id, name: 'bash', arguments: { command: 'npm test' } }] });
  const bashResult = (id: string, isError: boolean) => ({ role: 'toolResult', toolCallId: id, toolName: 'bash', isError,
    content: [{ type: 'text', text: isError ? 'Command exited with code 1' : 'ok' }] });
  it('a pi tool error the minion went on to answer is ordinary work: its own stop settles the directive', async () => {
    const f = await fixture(); f.seed();
    f.native.append(bashCall('failing')); f.native.append(bashResult('failing', true));
    f.native.finish();
    expect(inspectDirectiveCheckpoint(f.file, f.identity)).toMatchObject({ state: 'terminal', ok: true });
    expect(settleNativeDirective(f.deps, f.identity)).toBe(true);
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
    expect(f.ledger.listJobEventsByKinds(f.intent.jobId, ['job.delivered'])).toHaveLength(1);
  });
  it('a pi turn that stopped at a tool error it never answered stays UNKNOWN: it may be an interrupted effect #contract:directive-tool-error:pi', async () => {
    const f = await fixture(); f.seed();
    f.native.append(bashCall('first')); f.native.append(bashResult('first', true));
    expect(inspectDirectiveCheckpoint(f.file, f.identity)).toEqual({ state: 'unknown', reason: 'native tool error the turn never answered requires a recovery judgment' });
    expect(settleNativeDirective(f.deps, f.identity)).toBe(false);
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
    // Once answered, the error is history: a later successful batch is an ordinary resumable checkpoint.
    f.native.append(bashCall('second')); f.native.append(bashResult('second', false));
    expect(inspectDirectiveCheckpoint(f.file, f.identity)).toMatchObject({ state: 'resumable' });
  });
  it('a pi turn aborted right after a tool error never completes: the recorded abort is a failed turn', async () => {
    const f = await fixture(); f.seed();
    f.native.append(bashCall('interrupted')); f.native.append(bashResult('interrupted', true));
    f.native.finish('aborted');
    expect(inspectDirectiveCheckpoint(f.file, f.identity)).toMatchObject({ state: 'terminal', ok: false });
    expect(settleNativeDirective(f.deps, f.identity)).toBe(false);
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
  });
  it('a pi batch cut off with one failed and one successful result, in either order, stays UNKNOWN', async () => {
    for (const order of [[true, false], [false, true]] as const) {
      const f = await fixture(); f.seed();
      f.native.append({ role: 'assistant', stopReason: 'toolUse', content: ['a', 'b'].map((id) => ({ type: 'toolCall', id, name: 'bash', arguments: { command: 'npm test' } })) });
      f.native.append(bashResult('a', order[0])); f.native.append(bashResult('b', order[1]));
      expect(inspectDirectiveCheckpoint(f.file, f.identity), String(order)).toEqual({ state: 'unknown', reason: 'native tool error the turn never answered requires a recovery judgment' });
    }
  });
  it('rejects a stale terminal before an unbound later user tail', () => assertStaleTerminalTail('user'));
  it('rejects a stale terminal before a later branch tail', () => assertStaleTerminalTail('branch'));
  it('rejects a stale terminal before a later assistant tail', () => assertStaleTerminalTail('assistant'));
  it('rejects a stale terminal before a later partial tail', () => assertStaleTerminalTail('partial'));

  async function assertForeignAssociation(damage: 'malformed' | 'conflicting' | 'receipt-rebound') {
    const f = await fixture(); f.seed();
    const binding = readDirectiveBinding(f.file, f.identity.requestId)!;
    const foreign = { ...binding, identity: { ...binding.identity, requestId: 'foreign-request' } };
    const records = damage === 'malformed' ? [{ ...foreign, runtime: 'unknown-runtime' }]
      : damage === 'conflicting' ? [foreign, { ...foreign, promptHash: 'b'.repeat(64) }]
      : [{ ...foreign, userEntryId: 'original-native-user' }, { ...foreign, userEntryId: 'changed-native-user' }];
    appendFileSync(`${f.file}.directives.jsonl`, records.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const bytes = readFileSync(`${f.file}.directives.jsonl`, 'utf8');
    expect(() => readDirectiveBinding(f.file, f.identity.requestId)).toThrow(/association/);
    expect(readFileSync(`${f.file}.directives.jsonl`, 'utf8')).toBe(bytes);
  }
  it('rejects malformed foreign association journal records without changing bytes', () => assertForeignAssociation('malformed'));
  it('rejects conflicting foreign association journal records without changing bytes', () => assertForeignAssociation('conflicting'));
  it('rejects receipt-rebound foreign association journal records without changing bytes', () => assertForeignAssociation('receipt-rebound'));

  async function assertPreNativeDeferral(boundary: 'first-fence' | 'post-pacing') {
    const f = await fixture(); const gate = deferred<void>(); let waiting = false;
    const deps = { ...f.deps, ...(boundary === 'post-pacing' ? { workerGate: { acquireWorkerTurn: async () => { waiting = true; await gate.promise; return { release: () => {} }; } } as unknown as PacingGate } : {}) };
    if (boundary === 'first-fence') f.supervised(['transient producer']);
    const attempt = executeAcceptedDirective(deps, f.intent.requestId);
    if (boundary === 'post-pacing') { while (!waiting) await new Promise<void>((resolve) => setImmediate(resolve)); f.supervised(['transient producer']); gate.resolve(); }
    await attempt;
    expect(f.spawns).toEqual([]); expect(f.native.prompts).toEqual([]);
    expect(f.ledger.latestJobEventByRequestId(f.intent.jobId, 'silas.directive-dispatch-deferred', f.intent.requestId)?.payload).toMatchObject({ native_effects: 'none', identity: f.identity });
    const original = f.ledger.getDirective(f.intent.requestId)!;
    f.db.close(); const db = new LedgerDb(f.dir); cleanups.push(() => db.close());
    const bus = new EventBus({}); const ledger = new LedgerApi(db.handle, { bus }); f.supervised([]);
    for (const lane of ledger.listWorktrees()) rememberManagedLane(lane, ledger); // the reopened service re-associates its persisted lanes
    const registry: DirectiveRegistry = { getHandle: () => null, spawn: async (_role, options = {}) => {
      f.spawns.push(options);
      const handle = new PiAgentHandle('minion', f.native, f.file, PI_CAPABILITIES, false, [], f.store, () => {}, () => {}, 60000,
        options.agentId ?? 'logical-minion', () => 'preserved authority');
      handle.subscribe((event) => { if (event.type === 'state') ledger.setAgentState(handle.id, event.state); });
      return handle;
    }, disposeHandle: async (handle) => handle.dispose() };
    const service = new DirectiveProgressService({ ...f.deps, ledger, registry, notifications: new NotificationCenter({ ledger, bus }) });
    try {
      service.reconsider(); await service.settled(); service.reconsider(); await service.settled();
      expect(ledger.getDirective(original.requestId)).toMatchObject({ state: 'settled', payloadHash: original.payloadHash, workRevision: original.workRevision, authorityEpoch: original.authorityEpoch });
      expect(f.spawns).toHaveLength(1); expect(f.native.prompts).toHaveLength(1);
      expect(ledger.listJobEventsByKinds(original.jobId, ['silas.directive-sent'])).toHaveLength(1);
      expect(ledger.hasDirectiveDispatchDeferral(original.requestId)).toBe(false);
    } finally { await service.dispose(); }
  }
  it('positive first-fence deferral resumes the unconsumed original request once after persisted restart', () => assertPreNativeDeferral('first-fence'));
  it('positive post-pacing deferral resumes the unconsumed original request once after persisted restart', () => assertPreNativeDeferral('post-pacing'));

  async function assertDeferralPublication(fault: 'pre-commit' | 'post-commit') {
    const f = await fixture(); f.supervised(['temporary fence']);
    const record = f.ledger.recordDirectiveDispatchDeferral.bind(f.ledger);
    const failure = vi.spyOn(f.ledger, 'recordDirectiveDispatchDeferral').mockImplementation((...args) => {
      if (fault === 'post-commit') record(...args);
      throw new Error('deferral publication failed');
    });
    await executeAcceptedDirective(f.deps, f.intent.requestId); failure.mockRestore(); f.supervised([]);
    const service = new DirectiveProgressService(f.deps);
    try {
      service.reconsider(); await service.settled(); service.reconsider(); await service.settled();
      expect(f.native.prompts).toHaveLength(fault === 'post-commit' ? 1 : 0);
      expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe(fault === 'post-commit' ? 'settled' : 'dispatching');
    } finally { await service.dispose(); }
  }
  it('pre-native deferral publication pre-commit never invents a retry receipt', () => assertDeferralPublication('pre-commit'));
  it('pre-native deferral publication post-commit never invents a retry receipt', () => assertDeferralPublication('post-commit'));

  it('an attempted spawn without onPrepared remains UNKNOWN and is never a no-native deferral', async () => {
    const f = await fixture(); const spawn = vi.spyOn(f.registry, 'spawn').mockRejectedValue(new Error('spawn outcome unknown'));
    await executeAcceptedDirective(f.deps, f.intent.requestId);
    expect(f.ledger.latestJobEventByRequestId(f.intent.jobId, 'silas.directive-dispatch-deferred', f.intent.requestId)).toBeNull();
    const service = new DirectiveProgressService(f.deps);
    try { service.reconsider(); await service.settled(); expect(spawn).toHaveBeenCalledTimes(1); expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('dispatching'); }
    finally { await service.dispose(); }
  });

  it('#364 an admission refusal before any prompt fails the request by name and releases the lane', async () => {
    const f = await fixture();
    await executeAcceptedDirective({ ...f.deps, beforeWriterSideEffect: () => { throw new DirectivePromptRefusedError('an owner hold covers this lane'); } }, f.intent.requestId);
    expect(f.spawns).toEqual([]);
    expect(f.ledger.getDirective(f.intent.requestId)).toMatchObject({ state: 'failed', failReason: 'refused before any prompt: an owner hold covers this lane' });
  });

  it('#364 an untyped fault in the admission re-check is no decision: the request stays live for reconciliation', async () => {
    const f = await fixture();
    await executeAcceptedDirective({ ...f.deps, beforeWriterSideEffect: () => { throw new Error('ledger read failed'); } }, f.intent.requestId);
    expect(f.spawns).toEqual([]);
    expect(f.ledger.getDirective(f.intent.requestId)?.state).not.toBe('failed');
  });

  /** A resident turn prepared its producer, then its prompt was refused by a
   * disposal in progress; the FRESH boundary that follows is refused by the
   * caller. Whether that is a no-effect depends on the prepared producer. */
  async function refuseAfterPreparedResident(cessation: 'ceased' | 'unknown', admitted = false) {
    const f = await fixture();
    const resident = await f.registry.spawn('minion', { agentId: 'logical-minion' });
    const disposing = async (_text: string, options?: { readonly directive?: { onAdmitted?(binding: never): void } }): Promise<never> => {
      // The runtime reported the prompt ADMITTED before the disposal refused
      // it (the fixture binding itself need not be valid: the report is the fact).
      if (admitted) { try { options?.directive?.onAdmitted?.({} as never); } catch { /* fixture binding */ } }
      throw new WorkerDisposalInProgressError();
    };
    Object.assign(resident, { prompt: disposing, promptWithVerdict: disposing, cessationEvidence: () => cessation });
    let boundaries = 0;
    await executeAcceptedDirective({ ...f.deps, beforeWriterSideEffect: () => {
      boundaries += 1;
      if (boundaries > 1) throw new DirectivePromptRefusedError('an owner hold landed');
    } }, f.intent.requestId);
    expect(boundaries, 'refused at the fresh boundary, after the resident one passed').toBe(2);
    return f.ledger.getDirective(f.intent.requestId);
  }
  it('#364 a refusal beside a prepared producer that proved cessation fails the request by name', async () => {
    expect(await refuseAfterPreparedResident('ceased')).toMatchObject({ state: 'failed', failReason: 'refused before any prompt: an owner hold landed' });
  });
  it('#364 a refusal after a native admission was bound stays live, saying why', async () => {
    const row = await refuseAfterPreparedResident('ceased', true);
    expect(row?.state).not.toBe('failed');
    expect(row?.failReason).toContain('kept for reconciliation: a native admission was already bound');
  });
  it('#364 a refusal beside a prepared producer with unproven cessation stays live, saying why', async () => {
    const row = await refuseAfterPreparedResident('unknown');
    expect(row?.state).not.toBe('failed');
    expect(row?.failReason).toContain('kept for reconciliation: prepared producer logical-minion has not proven cessation (unknown)');
  });

  const refusal = new DirectivePromptRefusedError('refused');
  const prepared = (evidence: (() => 'ceased' | 'unknown') | undefined) => ({ id: 'minion-x', ...(evidence === undefined ? {} : { cessationEvidence: evidence }) });
  const unproven = (input: Partial<Parameters<typeof promptRefusalUnproven>[0]>): string | null =>
    promptRefusalUnproven({ error: refusal, failures: 1, admitted: false, prepared: undefined, ...input });
  it('#364 no-effect proof: a lone refusal with no prepared producer is a no-effect', () => expect(unproven({})).toBeNull());
  it('#364 no-effect proof: a prepared producer that proved cessation is a no-effect', () => expect(unproven({ prepared: prepared(() => 'ceased') })).toBeNull());
  it('#364 no-effect proof: a prepared producer with unknown cessation is kept, by name', () =>
    expect(unproven({ prepared: prepared(() => 'unknown') })).toBe('prepared producer minion-x has not proven cessation (unknown)'));
  it('#364 no-effect proof: a prepared producer with no cessation evidence is kept', () =>
    expect(unproven({ prepared: prepared(undefined) })).toMatch(/minion-x has not proven cessation \(no cessation evidence\)/u));
  it('#364 no-effect proof: an unreadable cessation is unproven, never thrown', () =>
    expect(unproven({ prepared: prepared(() => { throw new Error('lock unreadable'); }) })).toBe('prepared producer minion-x has not proven cessation (unreadable: "Error: lock unreadable")'));
  it('#364 no-effect proof: an unreadable cessation is quoted bounded and line-safe, even when it cannot print', () => {
    const long = unproven({ prepared: prepared(() => { throw new Error(`line one\nline two ${'x'.repeat(500)}`); }) })!;
    expect(long).not.toContain('\n');
    expect(long).toMatch(/\(unreadable: "Error: line one\\nline two x+…"\)$/u);
    expect(long.length).toBeLessThan(300);
    const literal = (message: string): string => /\(unreadable: (".*")\)$/u.exec(unproven({ prepared: prepared(() => { throw new Error(message); }) })!)![1]!;
    // Escaping can grow a character six-fold; the literal still stays within 200.
    for (const message of ['\n'.repeat(500), '\u0001'.repeat(500), `${'x'.repeat(170)}${'😀'.repeat(40)}`]) {
      const quoted = literal(message);
      expect(quoted.length, JSON.stringify(message.slice(0, 4))).toBeLessThanOrEqual(200);
      expect(quoted.endsWith('…"')).toBe(true);
      // Cut on a code point: no lone surrogate escape.
      expect(quoted).not.toMatch(/\\ud[89ab]/u);
      expect(() => JSON.parse(quoted)).not.toThrow();
    }
    // Line and paragraph separators, C1 controls and bidi overrides are escaped too.
    expect(literal('a\u2028b\u2029c\u0085d\u202ee\u2066f')).toBe('"Error: a\\u2028b\\u2029c\\u0085d\\u202ee\\u2066f"');
    // DEL, bidi and zero-width marks, the BOM and tag characters are escaped as well.
    expect(literal('a\u007fb\u200ec\u061cd\u200be\ufefff\u{e0041}g')).toBe('"Error: a\\u007fb\\u200ec\\u061cd\\u200be\\ufefff\\udb40\\udc41g"');
    // An empty message still names the error; an empty name reads as Error.
    expect(literal('')).toBe('"Error"');
    expect(unproven({ prepared: prepared(() => { throw Object.assign(new Error(''), { name: '' }); }) })).toBe('prepared producer minion-x has not proven cessation (unreadable: "Error")');
    // A missing name reads as Error; a message that cannot print keeps the name.
    expect(literal('m')).toBe('"Error: m"');
    expect(unproven({ prepared: prepared(() => { throw Object.assign(new Error('m'), { name: undefined }); }) })).toBe('prepared producer minion-x has not proven cessation (unreadable: "Error: m")');
    const silent = new TypeError('x'); Object.defineProperty(silent, 'message', { get() { throw new Error('no'); } });
    expect(unproven({ prepared: prepared(() => { throw silent; }) })).toBe('prepared producer minion-x has not proven cessation (unreadable: "TypeError (its message cannot be printed)")');
    // Private-use and unassigned code points are escaped too.
    expect(literal('a\ue000b\u0378c')).toBe('"Error: a\\ue000b\\u0378c"');
    const hostile = { toString() { throw new Error('no'); } };
    expect(unproven({ prepared: prepared(() => { throw hostile; }) })).toBe('prepared producer minion-x has not proven cessation (unreadable: "an error that cannot be printed")');
  });
  it('#364 no-effect proof: a bound native admission is never a no-effect', () => expect(unproven({ admitted: true })).toMatch(/admission was already bound/u));
  it('#364 no-effect proof: a refusal with a failed cleanup is kept', () => expect(unproven({ failures: 2 })).toMatch(/cleanup also failed/u));
  it('#364 no-effect proof: any other error is not an admission refusal', () => expect(unproven({ error: new Error('x') })).toBe('not an admission refusal'));

  /** Before the physical prompt starts, the native target and the producer
   * start are COMMITTED: read back from a fresh connection to a consistent
   * copy of the ledger, not from the writer's own state (#362). */
  async function assertPreparedBeforePrompt(route: 'fresh' | 'resident') {
    const f = await fixture();
    if (route === 'resident') await f.registry.spawn('minion', { agentId: 'logical-minion' });
    const seen: { readonly target: unknown; readonly started: boolean }[] = [];
    const prompt = f.native.prompt.bind(f.native);
    f.native.prompt = async (text: string, options?: unknown) => {
      const db = new LedgerDb(crashSnapshot(f));
      try {
        const durable = new LedgerApi(db.handle, { bus: new EventBus({}) });
        seen.push({
          target: durable.getDirective(f.intent.requestId)?.nativeTarget ?? null,
          started: durable.latestJobEventByRequestId(f.intent.jobId, 'silas.directive-producer-started', f.intent.requestId) !== null,
        });
      } finally { db.close(); }
      return prompt(text, options);
    };
    await executeAcceptedDirective(f.deps, f.intent.requestId);
    // One spawn either way: the resident route's own setup spawn, or the
    // fresh route's spawn — never a second.
    expect(f.spawns, route).toHaveLength(1);
    expect(seen, route).toEqual([{ target: { agentId: 'logical-minion', sessionFile: f.file }, started: true }]);
  }
  it('#362 the fresh route prompts only after the durable native target and producer start commit', () => assertPreparedBeforePrompt('fresh'));
  it('a minion whose session cannot attest native admission is refused by name before any target binding or prompt (#424)', async () => {
    const f = await fixture();
    const prompts: string[] = [];
    // A directive surface with no producer attestation (a legacy claude-code session).
    f.registry.spawn = async (_role, options = {}) => {
      f.spawns.push(options);
      return { role: 'minion', id: options.agentId ?? FIXTURE_MINION, sessionFile: f.file, capabilities: PI_CAPABILITIES,
        async prompt(text: string) { prompts.push(text); }, async steer() {}, async followUp() {}, subscribe: () => () => {},
        health: () => ({ state: 'idle' as const, lastActivity: null, sessionFile: f.file }),
        inspectDirective: () => ({ state: 'unknown' as const, reason: 'no attestation' }),
        async dispose() {} } as AgentHandle;
    };
    await executeAcceptedDirective(f.deps, f.intent.requestId);
    // A positive no-effect: failed by name, nothing bound, nothing prompted.
    expect(f.ledger.getDirective(f.intent.requestId)).toMatchObject({ state: 'failed', nativeTarget: null, nativeBinding: null,
      failReason: expect.stringMatching(/cannot attest native directive admission or producer ownership .*need a session that can attest them/su) });
    expect(prompts).toEqual([]);
  });

  it('the ledger binds a claude-code admission only when it is complete, names the prepared target and reads back from the session; any other runtime is refused (#424)', async () => {
    const f = await fixture();
    f.ledger.prepareDirectiveTarget(f.intent.requestId, { agentId: FIXTURE_MINION, sessionFile: f.file });
    const binding = { identity: f.identity, runtime: 'claude-code' as const, agentId: FIXTURE_MINION, sessionId: 'cli-session', sessionFile: f.file,
      baseline: `prefix:0:${'0'.repeat(64)}`, promptHash: 'b'.repeat(64), userEntryId: 'echo-uuid', authorityManifest: 'manifest' };
    for (const [label, forged] of [
      ['another agent', { ...binding, agentId: 'someone-else' }],
      ['another session file', { ...binding, sessionFile: `${f.file}.other` }],
      ['no admission receipt', { ...binding, userEntryId: null }],
      ['an unknown runtime', { ...binding, runtime: 'other-cli' }],
    ] as const) {
      expect(() => f.ledger.bindDirectiveNativeAdmission(forged as never), label).toThrow(/actual native admission identity is incomplete\/mismatched/u);
    }
    // A complete binding is still read back from the session's own durable
    // association: one the session never prepared is refused.
    expect(() => f.ledger.bindDirectiveNativeAdmission(binding)).toThrow(/exact native admission association unavailable/u);
  });

  /** A Claude Code minion's job (#424): the real adapter over the CLI
   * double, through the real registry and the production executor. */
  async function claudeDirectiveScene(kind: 'directive' | 'rebrief', text: string) {
    const dir = mkdtempSync(join(tmpdir(), 'gru-claude-directive-'));
    const repo = makeFixtureRepo('claude-directive');
    const home = mkdtempSync(join(tmpdir(), 'gru-claude-directive-home-'));
    const db = new LedgerDb(dir);
    const bus = new EventBus({});
    const ledger = new LedgerApi(db.handle, { bus });
    const notifications = new NotificationCenter({ ledger, bus });
    const worktrees = new InMemoryWorktreePort(join(dir, 'lanes'), ledger);
    ledger.addJob({ id: 'claude-job', repo: 'fixture', title: 'claude directive', briefing: 'approved original contract' });
    ledger.setJobStatus('claude-job', 'working');
    ledger.setJobPr('claude-job', 'https://example.test/pull/424');
    const lane = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'claude-job' });
    if (ledger.getWorktree(lane.id) === null) ledger.registerWorktree(lane);
    writeFileSync(configPathFor(home), `workspace_root = "${dir}"\n[runtimes]\ndefault = "claude-code"\n`);
    const config = loadConfig({ GRU_COMMAND_HOME: home }, '/home/tester');
    const store = new SessionStore(config.dataDir);
    const log = join(home, 'double-log.jsonl');
    process.env['CLAUDE_DOUBLE_LOG'] = log;
    const registry = new RuntimeRegistry({ config, store, claude: { binary: DOUBLE, reviewSettingsFile: join(home, 'absent-review-settings.json') } });
    registry.onAgentEvent((envelope) => {
      if (envelope.phase === 'event' && envelope.event?.type === 'state' && ledger.getAgent(envelope.agentId) !== null) ledger.setAgentState(envelope.agentId, envelope.event.state);
    });
    // The job's minion: a Claude session on the lane, now at rest.
    const first = await registry.spawn('minion', { cwd: lane.path, agentId: 'claude-minion' });
    ledger.registerAgent({ id: first.id, role: 'minion', jobId: 'claude-job', sessionFile: first.sessionFile, parentage: 'top-level' });
    await registry.disposeHandle(first);
    ledger.setAgentState(first.id, 'disposed');
    const intent = kind === 'rebrief'
      ? ledger.beginRebriefIntent({ jobId: 'claude-job', requestId: 'claude-request', note: text, holder: 'gru' }).record
      : ledger.beginDirectiveIntent({ jobId: 'claude-job', requestId: 'claude-request', directive: text, holder: 'gru' }).record;
    const deps = { ledger, registry, worktrees, notifications, signal: new AbortController().signal, pendingProducerBlockers: () => [] };
    const turns = (): readonly { readonly argv: readonly string[] }[] => existsSync(log)
      ? readFileSync(log, 'utf8').trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line) as { argv: string[] }) : [];
    const cleanup = async (): Promise<void> => {
      delete process.env['CLAUDE_DOUBLE_LOG'];
      await registry.dispose(); store.dispose(); db.close(); repo.cleanup();
      rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
    };
    return { db, ledger, lane, store, registry, intent, deps, sessionFile: first.sessionFile!, turns, cleanup };
  }

  async function assertClaudeDirectiveDelivery(kind: 'directive' | 'rebrief') {
    const scene = await claudeDirectiveScene(kind, 'tool:Read finish the approved scope');
    const { ledger, intent, lane } = scene;
    try {
      await executeAcceptedDirective(scene.deps, intent.requestId);
      const row = ledger.getDirective(intent.requestId)!;
      expect(row.failReason, kind).toBeNull();
      expect(row.state, kind).toBe('settled');
      // Admitted at the CLI's own echo, completed at its own result, with the lane HEAD.
      expect(row.nativeBinding, kind).toMatchObject({ runtime: 'claude-code', agentId: 'claude-minion', userEntryId: expect.any(String) });
      const proof = inspectDirectiveCheckpoint(row.nativeTarget!.sessionFile, ledger.directiveTurnIdentity(intent.requestId));
      expect(proof, kind).toMatchObject({ state: 'terminal', ok: true });
      const delivered = ledger.latestJobEventByRequestId('claude-job', 'job.delivered', intent.requestId)!;
      expect(delivered.payload, kind).toMatchObject({ request_id: intent.requestId, agentId: 'claude-minion', sha: resolveGitCommit(lane.path, 'HEAD'),
        native_completion: { binding: { runtime: 'claude-code' }, checkpoint_id: (proof as { checkpointId: string }).checkpointId } });
      // The CLI child proved cessation: every physical producer ceased.
      expect(inspectDirectiveProducers(row.nativeTarget!.sessionFile).map((owner) => owner.evidence), kind).toEqual(['ceased']);
      // One CLI turn, with the echo and the permission ask: never a replay.
      expect(scene.turns().map((turn) => turn.argv.includes('--replay-user-messages')), kind).toEqual([true]);
    } finally { await scene.cleanup(); }
  }
  it('a Claude Code minion takes a Silas directive end to end: admitted at the CLI echo, fenced, settled with its native completion (#424) #contract:native-directive-admission:claude-code', () =>
    assertClaudeDirectiveDelivery('directive'));
  it('a Claude Code minion takes a re-brief end to end through a fresh session (#424)', () =>
    assertClaudeDirectiveDelivery('rebrief'));

  it('a Claude Code session past the transcript limit still takes a directive end to end: only its own turn is inspected (#469)', async () => {
    const scene = await claudeDirectiveScene('directive', 'tool:Read finish the approved scope');
    const { ledger, intent } = scene;
    try {
      // Earlier CLI turns under the session's own id, past the limit.
      const sessionId = readDirectiveSessionHeader(scene.sessionFile).id;
      historyPastTranscriptLimit(scene.sessionFile, (index, filler) => ({ type: 'assistant', uuid: `history-${index}`, session_id: sessionId,
        message: { role: 'assistant', content: [{ type: 'text', text: filler }] } }));
      await executeAcceptedDirective(scene.deps, intent.requestId);
      const row = ledger.getDirective(intent.requestId)!;
      expect(row.failReason).toBeNull();
      expect(row).toMatchObject({ state: 'settled', nativeTarget: { sessionFile: scene.sessionFile }, nativeBinding: { runtime: 'claude-code', userEntryId: expect.any(String) } });
      expect(inspectDirectiveCheckpoint(scene.sessionFile, ledger.directiveTurnIdentity(intent.requestId))).toMatchObject({ state: 'terminal', ok: true });
      expect(statSync(scene.sessionFile).size).toBeGreaterThan(NATIVE_TRANSCRIPT_LIMIT);
      // One CLI turn, with the echo and the permission ask.
      expect(scene.turns().map((turn) => turn.argv.includes('--replay-user-messages'))).toEqual([true]);
    } finally { await scene.cleanup(); }
  });

  it('an interrupted Claude directive is never resumed or replayed: it stays admitted and Gru gets the recovery card (#424)', async () => {
    const scene = await claudeDirectiveScene('directive', 'die-after-echo finish the approved scope');
    const { ledger, intent } = scene;
    try {
      await executeAcceptedDirective(scene.deps, intent.requestId);
      const service = new DirectiveProgressService(scene.deps);
      try { service.reconsider(); await service.settled(); service.reconsider(); await service.settled(); }
      finally { await service.dispose(); }
      const row = ledger.getDirective(intent.requestId)!;
      // Admitted by the CLI's echo; never delivered, never failed as a no-effect.
      expect(row.nativeBinding).toMatchObject({ runtime: 'claude-code', userEntryId: expect.any(String) });
      expect(row.state).not.toBe('settled');
      expect(row.state).not.toBe('failed');
      expect(ledger.latestJobEventByRequestId('claude-job', 'job.delivered', intent.requestId)).toBeNull();
      expect(ledger.findNotificationByKind(`silas.directive-unreconciled.${intent.requestId}`, 'active')).not.toBeNull();
      // One CLI turn: the interrupted directive was never sent again.
      expect(scene.turns()).toHaveLength(1);
    } finally { await scene.cleanup(); }
  });

  it('a service that died mid-directive leaves the CLI child an independent controller: a restarted service never replays it (#424)', async () => {
    const releaseDir = mkdtempSync(join(tmpdir(), 'gru-claude-release-'));
    const release = join(releaseDir, 'go');
    const scene = await claudeDirectiveScene('directive', `held:${release} finish the approved scope`);
    const { ledger } = scene;
    const held = scene.intent;
    const running = executeAcceptedDirective(scene.deps, held.requestId);
    try {
      // Wait until the CLI's echo is admitted: the turn is live, the child running.
      for (let tries = 0; tries < 2000 && ledger.getDirective(held.requestId)?.nativeBinding?.userEntryId == null; tries += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      expect(ledger.getDirective(held.requestId)?.nativeBinding).toMatchObject({ runtime: 'claude-code' });
      // The service "dies" here: what it leaves is the durable ledger and the session's journals.
      const snapshot = mkdtempSync(join(tmpdir(), 'gru-claude-crash-'));
      mkdirSync(join(snapshot, 'ledger'));
      scene.db.handle.prepare('VACUUM INTO ?').run(join(snapshot, 'ledger', 'ledger.db'));
      const restartedDb = new LedgerDb(snapshot);
      try {
        const restarted = new LedgerApi(restartedDb.handle, { bus: new EventBus({}) });
        const before = scene.turns().length;
        const service = new DirectiveProgressService({ ...scene.deps, ledger: restarted, notifications: new NotificationCenter({ ledger: restarted, bus: new EventBus({}) }) });
        try { service.reconsider(); await service.settled(); } finally { await service.dispose(); }
        // The producer's CLI child has no proven cessation: UNKNOWN, never a replay.
        expect(inspectDirectiveProducers(scene.sessionFile, ledger.directiveTurnIdentity(held.requestId)).map((owner) => owner.evidence)).toEqual(['unknown']);
        expect(restarted.getDirective(held.requestId)?.state).not.toBe('settled');
        expect(restarted.findNotificationByKind(`silas.directive-unreconciled.${held.requestId}`, 'active')).not.toBeNull();
        expect(scene.turns()).toHaveLength(before);
      } finally { restartedDb.close(); rmSync(snapshot, { recursive: true, force: true }); }
    } finally {
      writeFileSync(release, '');
      await running.catch(() => {});
      await scene.cleanup();
      rmSync(releaseDir, { recursive: true, force: true });
    }
  });
  it('#362 the resident route prompts only after the durable native target and producer start commit', () => assertPreparedBeforePrompt('resident'));

  /** The durable ledger exactly as it stands NOW — what a process killed at
   * this instant leaves behind (a consistent online copy, never a guess). */
  function crashSnapshot(f: Awaited<ReturnType<typeof fixture>>): string {
    const dir = mkdtempSync(join(tmpdir(), 'gru-crash-snapshot-'));
    // Cleanups run last-in first-out: a db opened on this copy closes first.
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'ledger'));
    f.db.handle.prepare('VACUUM INTO ?').run(join(dir, 'ledger', 'ledger.db'));
    return dir;
  }

  const POST_CRASH_SUCCESSOR = 'post-crash-successor';
  /** The minion the fresh route spawns: the fixture's own. */
  const SPAWNED_MINION = FIXTURE_MINION;

  /** Runs the REAL executor and snapshots the ledger at a crash window between
   * registry.spawn() and onPrepared, then recovers from that snapshot as a
   * restarted service would (#362). */
  async function recoverFromCrash(crashPoint: 'inside-spawn' | 'after-registration') {
    const f = await fixture(); void (f.ledger.getWorktree(f.lane.id) ?? f.ledger.registerWorktree(f.lane));
    let release: () => void = () => {};
    if (crashPoint === 'inside-spawn') f.spawnGate(new Promise<void>((resolve) => { release = resolve; }));
    let snapshot = null as string | null;
    // The crash point is found by what happened, not by counting boundaries:
    // the first admission boundary after the spawned minion's registration is
    // the one immediately before onPrepared.
    let registered = false;
    let registeredAtCrash = false;
    const takeSnapshot = (): void => { snapshot = crashSnapshot(f); registeredAtCrash = registered; };
    // Every failure is kept with where it came from (a thrown null included),
    // and none masks another.
    const failures: { readonly where: string; readonly error: unknown }[] = [];
    let registrations = 0;
    const register = f.ledger.registerAgent.bind(f.ledger);
    const spy = vi.spyOn(f.ledger, 'registerAgent').mockImplementation((input) => {
      const row = register(input);
      if (input.id === SPAWNED_MINION) { registered = true; registrations += 1; }
      return row;
    });
    try {
      // The rejection handler is attached where the run starts: never an
      // unhandled rejection while the spawn wait runs.
      const run = executeAcceptedDirective({ ...f.deps, beforeWriterSideEffect: () => {
        if (crashPoint !== 'after-registration' || !registered || snapshot !== null || failures.length > 0) return;
        // A failing snapshot is kept, never folded into the executor's own recovery.
        try { takeSnapshot(); } catch (error) { failures.push({ where: 'snapshot', error }); }
      } }, f.intent.requestId).catch((error: unknown) => { failures.push({ where: 'executor', error }); });
      try {
        if (crashPoint === 'inside-spawn') {
          await vi.waitFor(() => expect(f.spawns).toHaveLength(1));
          takeSnapshot();
        }
      } catch (error) { failures.push({ where: 'spawn wait', error }); } finally { release(); }
      // The executor is always awaited, so it never runs on into cleanup.
      await run;
    } finally { spy.mockRestore(); }
    const [only] = failures;
    // The failure's own text, whatever it is — never a second throw while reporting it.
    const textOf = (error: unknown): string => {
      if (error instanceof Error) return error.message;
      try { return JSON.stringify(error) ?? String(error); } catch { return Object.prototype.toString.call(error); }
    };
    if (failures.length === 1 && only !== undefined) throw new Error(`fixture: ${only.where} failed at ${crashPoint}: ${textOf(only.error)}`, { cause: only.error });
    if (failures.length > 1) {
      const where = failures.map((failure) => failure.where).join(', ');
      throw new AggregateError(failures.map((failure) => failure.error), `fixture: failures at ${crashPoint} (${where})`);
    }
    if (crashPoint === 'after-registration' && !registered) throw new Error(`fixture: the spawned registration of "${SPAWNED_MINION}" was never reached (did the spawn register another id?)`);
    // Either way the run went on to completion (the inside-spawn run once its
    // gate was released): the spawned minion registered exactly once.
    expect(registrations, `${crashPoint}: registrations of ${SPAWNED_MINION}`).toBe(1);
    if (snapshot === null) throw new Error(crashPoint === 'after-registration' ? 'fixture: no admission boundary followed the spawned registration' : 'fixture: no snapshot inside the spawn');
    // The windows differ by what the executor had done when the snapshot was
    // taken (the fixture pre-registers the same idle row, so the two rows
    // look alike): inside the spawn the registration had NOT run.
    expect(registeredAtCrash, `${crashPoint}: the spawned registration had run`).toBe(crashPoint === 'after-registration');
    const db = new LedgerDb(snapshot); cleanups.push(() => db.close());
    const bus = new EventBus({}); const ledger = new LedgerApi(db.handle, { bus });
    // The crashed state itself: reserved, no native target, no producer start,
    // and no open turn on the agent row that could fence the lane.
    expect(ledger.getDirective(f.intent.requestId), crashPoint).toMatchObject({ state: 'dispatching', nativeTarget: null });
    expect(ledger.latestJobEventByRequestId(f.intent.jobId, 'silas.directive-producer-started', f.intent.requestId), crashPoint).toBeNull();
    expect(ledger.getAgent(SPAWNED_MINION)?.state, `${crashPoint}: the crashed row`).toBe('idle');
    for (const lane of ledger.listWorktrees()) rememberManagedLane(lane, ledger);
    let respawns = 0;
    const registry: DirectiveRegistry = { getHandle: () => null, spawn: async () => { respawns += 1; throw new Error('the reserved original must never respawn'); },
      disposeHandle: async (handle) => handle.dispose() };
    const service = new DirectiveProgressService({ ...f.deps, ledger, registry, notifications: new NotificationCenter({ ledger, bus }) });
    try {
      // Two passes: a second reconsideration must not replay it either.
      service.reconsider(); await service.settled();
      service.reconsider(); await service.settled();
    } finally { await service.dispose(); }
    const original = ledger.getDirective(f.intent.requestId);
    // Never replayed, and no deferral invented from the missing target.
    expect(respawns).toBe(0);
    expect(original).toMatchObject({ state: 'dispatching', nativeTarget: null });
    expect(ledger.hasDirectiveDispatchDeferral(f.intent.requestId)).toBe(false);
    expect(ledger.claimDirectiveDispatch(f.intent.requestId)).toBe(false);
    expect(() => ledger.directiveProducerStart(f.identity)).toThrow(/exact directive producer start receipt missing/u);
    const debt = ledger.listObligations({ jobId: f.intent.jobId }).find((item) => item.incidentKey === `directive-recovery:${f.intent.requestId}`);
    expect(debt, 'the interrupted request is owed a recovery decision').toBeDefined();
    const authority = ledger.directiveCurrentAuthority(f.intent.jobId);
    const decide = () => recoverInterruptedDirectiveFromRoute({ ledger, worktrees: f.worktrees, pendingProducerBlockers: () => [],
      requestId: f.intent.requestId, generation: debt!.generation, expectedPayloadHash: original!.payloadHash,
      expectedHead: resolveGitCommit(f.lane.path, 'HEAD'), expectedEpoch: ledger.directiveRecoveryEpoch(f.intent.jobId),
      expectedWorkRevision: authority.workRevision, expectedContractSha256: authority.contractSha256,
      reason: 'the reserved original never reached a native target', decision: { kind: 'successor', requestId: POST_CRASH_SUCCESSOR, directive: 'approved correction' } });
    return { ledger, decide, debt: debt!, requestId: f.intent.requestId, jobId: f.intent.jobId };
  }

  /** No prompt can precede onPrepared, so neither crash window left a native
   * effect: no open turn fences the lane (the registration leaves the agent
   * idle), and fresh authority may proceed at once — retiring the reserved
   * original, never replaying it. */
  async function assertSuccessorMayProceed(crashPoint: 'inside-spawn' | 'after-registration') {
    const { ledger, decide, requestId, jobId } = await recoverFromCrash(crashPoint);
    // After recovery the row is still idle — no open turn can fence the lane.
    expect(ledger.getAgent(SPAWNED_MINION)?.state, `${crashPoint}: the recovered row`).toBe('idle');
    expect(decide().successor?.requestId, crashPoint).toBe(POST_CRASH_SUCCESSOR);
    expect(ledger.getDirective(requestId)?.state, crashPoint).toBe('retired');
    // Retired by the decision, never by an invented no-native-effect deferral
    // (the durable event itself: the row-state predicate is false for any
    // retired row, so it cannot witness this).
    expect(ledger.latestJobEventByRequestId(jobId, 'silas.directive-dispatch-deferred', requestId), `${crashPoint}: no deferral event`).toBeNull();
  }
  it('#362 a crash inside registry.spawn() is never replayed, and a successor may proceed', () => assertSuccessorMayProceed('inside-spawn'));
  it('#362 a crash after the spawned registration but before onPrepared is never replayed, and a successor may proceed', () => assertSuccessorMayProceed('after-registration'));

  it('positive no-effect closes only the attached awaiting phase without completion', async () => {
    const f = await fixture(); f.ledger.failDirective({ requestId: f.intent.requestId, reason: 'fixture replaced before dispatch' });
    const row = f.ledger.beginDirectiveIntent({ jobId: f.intent.jobId, requestId: 'phase-no-effect', directive: 'approved', holder: 'gru', handoff: { kind: 'gru-decision', decision: 'inspect phase' } }).record;
    const phase = f.ledger.findPhaseHandoffByRequest({ jobId: row.jobId, requestId: row.requestId })!;
    await executeAcceptedDirective({ ...f.deps, registry: { ...f.registry, getHandle: () => null }, worktrees: { ...f.worktrees, listWorktrees: () => [] } as unknown as typeof f.worktrees }, row.requestId);
    expect(f.ledger.getDirective(row.requestId)?.state).toBe('failed');
    expect(f.ledger.getPhaseHandoff(phase.phaseId)).toMatchObject({ state: 'closed', completionSeq: null });
    expect(f.ledger.latestJobEvent(row.jobId, 'job.delivered')).toBeNull();
  });

  it('P47 direct ledger settlement refuses correlated delivery without an original native terminal', async () => {
    const f = await fixture(); f.seed();
    f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, f.identity));
    const event = f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.intent.jobId,
      payload: { request_id: f.intent.requestId, agentId: 'logical-minion', work_revision: f.identity.workRevision } });
    const watermark = f.ledger.latestEventSeq();
    expect(() => f.ledger.recordDirectiveDelivery({ requestId: f.intent.requestId, eventSeq: event.seq })).toThrow(/successful native terminal/);
    expect(f.ledger.getDirective(f.intent.requestId)).toMatchObject({ state: 'admitted', deliverySeq: null });
    expect(f.ledger.latestEventSeq()).toBe(watermark); expect(f.ledger.getEvent(event.seq)).toEqual(event);
  });
  it('P47 direct ledger settlement refuses forged completion provenance despite a genuine terminal', async () => {
    const f = await fixture(); f.seed(); f.native.finish();
    f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, f.identity));
    const original = originalDeliveryPayload(f);
    const event = f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.intent.jobId,
      payload: { ...original, native_completion: { ...original.native_completion, checkpoint_id: 'foreign-checkpoint' } } });
    expect(() => f.ledger.recordDirectiveDelivery({ requestId: f.intent.requestId, eventSeq: event.seq })).toThrow(/native completion provenance/);
    f.ledger.setJobStatus(f.intent.jobId, 'parked');
    const missing = f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.intent.jobId,
      payload: { ...original, native_completion: undefined } });
    expect(() => f.ledger.recordDirectiveDelivery({ requestId: f.intent.requestId, eventSeq: missing.seq })).toThrow(/native completion provenance/);
    expect(f.ledger.getDirective(f.intent.requestId)).toMatchObject({ state: 'admitted', deliverySeq: null });
    expect(f.ledger.getEvent(event.seq)).toEqual(event);
  });
  it('P47 direct ledger settlement retains an unknown physical owner despite a genuine terminal', async () => {
    const f = await fixture(); f.seed(); f.native.finish();
    f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, f.identity));
    const live = prepareDirectiveProducer({ identity: f.identity, agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file });
    try {
      const event = f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.intent.jobId, payload: originalDeliveryPayload(f) });
      expect(() => f.ledger.recordDirectiveDelivery({ requestId: f.intent.requestId, eventSeq: event.seq })).toThrow(/physical ownership/);
      expect(f.ledger.getDirective(f.intent.requestId)).toMatchObject({ state: 'admitted', deliverySeq: null });
    } finally { recordDirectiveProducerCessation(live); }
  });
  it('P47 direct ledger settlement preserves truthful null HEAD and exact idempotent original completion', async () => {
    const f = await fixture(); f.seed(); f.native.finish();
    f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, f.identity));
    const payload = originalDeliveryPayload(f);
    expect(payload.sha).toBeNull(); expect(payload.native_completion.receipt).toBeNull();
    const event = f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.intent.jobId, payload });
    const settled = f.ledger.recordDirectiveDelivery({ requestId: f.intent.requestId, eventSeq: event.seq });
    expect(settled).toMatchObject({ state: 'settled', deliverySeq: event.seq, workRevision: f.identity.workRevision });
    expect(f.ledger.recordDirectiveDelivery({ requestId: f.intent.requestId, eventSeq: event.seq })).toEqual(settled);
    expect(f.ledger.correctiveVerificationDebt(f.intent.jobId)).toEqual({ revision: f.identity.workRevision, head: null });
    expect(f.ledger.getEvent(event.seq)).toEqual(event);
  });
  async function assertFalsePublisherDebt(mode: 'null-head' | 'dirty' | 'head-moved') {
    const f = await fixture(); void (f.ledger.getWorktree(f.lane.id) ?? f.ledger.registerWorktree(f.lane)); // before original native execution
    f.seed(); f.native.finish(); f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, f.identity));
    const proof = inspectDirectiveCheckpoint(f.file, f.identity);
    if (proof.state !== 'terminal' || !proof.ok) throw new Error('original successful native completion required');
    const producer = inspectDirectiveProducers(f.file, f.identity).at(-1)!.producer;
    const head = mode === 'null-head' ? null : resolveGitCommit(f.lane.path, 'HEAD');
    recordDirectiveCompletion(producer, proof.checkpointId, head); // original completion boundary, not recovery
    const receipt = readDirectiveCompletion(f.file, f.identity, proof.checkpointId);
    if (mode === 'dirty') writeFileSync(join(f.lane.path, 'README.md'), 'later tracked changes');
    if (mode === 'head-moved') {
      writeFileSync(join(f.lane.path, 'later.txt'), 'later separately committed work');
      f.repo.git(['add', 'later.txt'], f.lane.path);
      f.repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'later candidate'], f.lane.path);
    }
    const transcript = readFileSync(f.file, 'utf8'); const journal = readFileSync(`${f.file}.producers.jsonl`, 'utf8');
    const delivered = recordFollowUpDelivery({ ledger: f.ledger, worktrees: f.worktrees, jobId: f.intent.jobId,
      agentId: 'logical-minion', source: 'silas-directive', requestId: f.intent.requestId, workRevision: f.identity.workRevision,
      nativeCompletion: { sha: head, provenance: { identity: f.identity, checkpoint_id: proof.checkpointId, binding: proof.binding,
        receipt, physical_cessation: inspectDirectiveProducers(f.file, f.identity) } } });
    const event = f.ledger.getEvent(delivered.eventSeq)!;
    expect(event.payload).toMatchObject({ sha: head, candidate_delivery_proven: false });
    const settled = f.ledger.recordDirectiveDelivery({ requestId: f.intent.requestId, eventSeq: event.seq });
    const root = f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-current-gates-owed');
    expect(root).not.toBeNull();
    expect(root!.payload).toMatchObject({ root_kind: 'original-native-completion', identity: f.identity, delivery_seq: event.seq, sha: head });
    const obligationId = (root!.payload as { obligation_id: string }).obligation_id;
    expect(f.ledger.getObligation(obligationId)?.state).toBe('open');
    expect(f.ledger.latestCandidateDelivery(f.intent.jobId)).toBeNull();
    expect(f.ledger.correctiveVerificationDebt(f.intent.jobId)).toEqual({ revision: f.identity.workRevision, head: null });
    const watermark = f.ledger.latestEventSeq();
    expect(f.ledger.recordDirectiveDelivery({ requestId: f.intent.requestId, eventSeq: event.seq })).toEqual(settled);
    expect(f.ledger.latestEventSeq()).toBe(watermark);
    expect(f.ledger.getEvent(event.seq)).toEqual(event);
    const reopened = new LedgerDb(f.dir);
    try {
      const ledger = new LedgerApi(reopened.handle);
      expect(ledger.getObligation(obligationId)?.state).toBe('open'); expect(ledger.latestCandidateDelivery(f.intent.jobId)).toBeNull();
      expect(ledger.getEvent(root!.seq)).toEqual(root); expect(ledger.getEvent(event.seq)).toEqual(event);
      expect(() => ledger.settleObligation({ obligationId, settlement: { kind: 'accepted-evidence', gate: 'historical delivery', evidenceEventSeq: event.seq, evidenceEventKind: event.kind } })).toThrow();
    } finally { reopened.close(); }
    expect(readFileSync(f.file, 'utf8')).toBe(transcript); expect(readFileSync(`${f.file}.producers.jsonl`, 'utf8')).toBe(journal);
    expect(f.spawns).toEqual([]); expect(f.native.prompts).toEqual([]);
  }
  it('R12 publisher-false null HEAD completion retains a protected current-action duty', () => assertFalsePublisherDebt('null-head'));
  it('R12 publisher-false tracked-dirty lane retains a protected current-action duty', () => assertFalsePublisherDebt('dirty'));
  it('R12 publisher-false moved HEAD retains a protected current-action duty', () => assertFalsePublisherDebt('head-moved'));

  async function assertOriginalLaneCandidate(mode: 'replacement' | 'missing-cwd') {
    const f = await fixture('directive', mode !== 'missing-cwd'); f.seed(); f.native.finish();
    f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, f.identity));
    const proof = inspectDirectiveCheckpoint(f.file, f.identity);
    if (proof.state !== 'terminal') throw new Error('fixture must genuinely complete on its original lane');
    const producer = inspectDirectiveProducers(f.file, f.identity).at(-1)!.producer;
    const head = resolveGitCommit(f.lane.path, 'HEAD'); recordDirectiveCompletion(producer, proof.checkpointId, head);
    const receipt = readDirectiveCompletion(f.file, f.identity, proof.checkpointId);
    const nativeBytes = readFileSync(f.file, 'utf8');
    let worktrees = { listWorktrees: () => [f.lane] };
    if (mode === 'replacement') {
      f.ledger.addJob({ id: 'different-original-lane', repo: 'fixture', title: 'different original lane' });
      const replacement = await f.worktrees.createJobWorktree({ repoPath: f.repo.path, jobId: 'different-original-lane' });
      expect(resolveGitCommit(replacement.path, 'HEAD')).toBe(head);
      worktrees = { listWorktrees: () => [{ ...f.lane, status: 'swept' as const }, { ...replacement, jobId: f.intent.jobId }] };
    }
    const delivery = recordFollowUpDelivery({ ledger: f.ledger, worktrees, jobId: f.intent.jobId, agentId: 'logical-minion',
      source: 'silas-directive', requestId: f.intent.requestId, workRevision: f.identity.workRevision,
      nativeCompletion: { sha: head, provenance: { identity: f.identity, checkpoint_id: proof.checkpointId, binding: proof.binding,
        receipt, physical_cessation: inspectDirectiveProducers(f.file, f.identity) } } });
    expect(delivery.sha).toBe(head);
    expect(f.ledger.getEvent(delivery.eventSeq)?.payload).toMatchObject({ sha: head, candidate_delivery_proven: false,
      work_revision: f.identity.workRevision, native_completion: { binding: proof.binding, receipt } });
    expect(delivery.note).toMatch(/original native.*(cwd|lane)/);
    expect(f.ledger.recordDirectiveDelivery({ requestId: f.intent.requestId, eventSeq: delivery.eventSeq }).state).toBe('settled');
    expect(f.ledger.latestCandidateDelivery(f.intent.jobId)).toBeNull();
    expect(f.ledger.correctiveVerificationDebt(f.intent.jobId)).toEqual({ revision: f.identity.workRevision, head: null });
    expect(readFileSync(f.file, 'utf8')).toBe(nativeBytes);
  }
  it('P50 refuses a same-SHA replacement lane while preserving original native delivery facts', () => assertOriginalLaneCandidate('replacement'));
  it('P50 refuses candidacy when original native cwd was never recorded, without backfilling its header', () => assertOriginalLaneCandidate('missing-cwd'));

  async function assertLedgerCandidate(mode: 'current' | 'head-moved' | 'dirty' | 'untracked' | 'replacement' | 'missing-cwd' | 'amended' | 'parked' | 'actor-moved') {
    const f = await fixture('directive', mode !== 'missing-cwd');
    void (f.ledger.getWorktree(f.lane.id) ?? f.ledger.registerWorktree(f.lane)); // original lane registration, before original native execution
    f.seed(); f.native.finish(); f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, f.identity));
    const proof = inspectDirectiveCheckpoint(f.file, f.identity);
    if (proof.state !== 'terminal' || !proof.ok) throw new Error('original fixture terminal is required');
    const producer = inspectDirectiveProducers(f.file, f.identity).at(-1)!.producer;
    const head = resolveGitCommit(f.lane.path, 'HEAD'); recordDirectiveCompletion(producer, proof.checkpointId, head);
    const payload = { ...originalDeliveryPayload(f), candidate_delivery_proven: true };
    if (mode === 'head-moved') {
      writeFileSync(join(f.lane.path, 'later.txt'), 'a separately changed current lane');
      f.repo.git(['add', 'later.txt'], f.lane.path);
      f.repo.git(['-c', 'user.name=Fixture Tests', '-c', 'user.email=tests@example.invalid', 'commit', '-m', 'later lane'], f.lane.path);
    }
    if (mode === 'dirty') writeFileSync(join(f.lane.path, 'README.md'), 'uncommitted tracked change');
    if (mode === 'untracked') writeFileSync(join(f.lane.path, 'untracked-approved-input.ts'), 'export const materialInput = true;\n');
    if (mode === 'replacement') {
      f.ledger.setWorktreeStatus(f.lane.id, 'swept');
      // A same-SHA checkout the ledger attributes to the original job, distinct from the issued original lane.
      const attributedPath = join(f.dir, 'replacement-attributed');
      f.repo.git(['worktree', 'add', '--detach', attributedPath, head], f.repo.path);
      const replacement = { ...f.lane, id: 'replacement-attributed', path: attributedPath };
      f.ledger.registerWorktree({ ...replacement, jobId: f.intent.jobId });
      expect(resolveGitCommit(replacement.path, 'HEAD')).toBe(head);
    }
    if (mode === 'amended') f.ledger.addJobAmendment({ jobId: f.intent.jobId, body: 'later approved contract', effect: 'administrative', supersedes: [], approval: { by: 'owner', reference: 'P51' }, expectedContractSha256: f.identity.contractSha256 });
    if (mode === 'parked') f.ledger.setJobStatus(f.intent.jobId, 'parked');
    if (mode === 'actor-moved') f.ledger.registerAgent({ id: 'logical-minion', role: 'minion', jobId: f.intent.jobId, sessionFile: join(f.dir, 'replacement-session.jsonl') });
    const bytes = readFileSync(f.file, 'utf8');
    const event = f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.intent.jobId, payload });
    const settled = f.ledger.recordDirectiveDelivery({ requestId: f.intent.requestId, eventSeq: event.seq });
    expect(settled).toMatchObject({ state: 'settled', deliverySeq: event.seq, workRevision: f.identity.workRevision });
    expect(f.ledger.getEvent(event.seq)).toEqual(event); expect(readFileSync(f.file, 'utf8')).toBe(bytes);
    expect(f.ledger.latestJobEventByRequestId(f.intent.jobId, 'silas.directive-settled', f.intent.requestId)?.payload).toMatchObject({ delivery_seq: event.seq, candidate_delivery_proven: mode === 'current' });
    const watermarkBeforeForgery = f.ledger.latestEventSeq();
    expect(() => f.ledger.appendCustomEvent({ kind: 'silas.directive-settled', jobId: f.intent.jobId,
      payload: { request_id: f.intent.requestId, delivery_seq: event.seq, candidate_delivery_proven: true } })).toThrow(/completed history cannot be upgraded/);
    expect(f.ledger.latestEventSeq()).toBe(watermarkBeforeForgery);
    if (mode === 'current') {
      expect(f.ledger.latestCandidateDelivery(f.intent.jobId)).toEqual(event);
      expect(f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-current-gates-owed')).toBeNull();
    } else {
      expect(f.ledger.latestCandidateDelivery(f.intent.jobId)).toBeNull();
      expect(f.ledger.correctiveVerificationDebt(f.intent.jobId)).toEqual({ revision: f.identity.workRevision, head: null });
      const root = f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-current-gates-owed')!;
      expect(root.payload).toMatchObject({ root_kind: 'original-native-completion', identity: f.identity, delivery_seq: event.seq, sha: head });
      const duty = f.ledger.getObligation((root.payload as { obligation_id: string }).obligation_id)!;
      expect(['open', 'waiting', 'suspended']).toContain(duty.state);
      expect(() => f.ledger.settleObligation({ obligationId: duty.id, settlement: { kind: 'accepted-evidence', gate: 'caller says candidate', evidenceEventSeq: event.seq, evidenceEventKind: 'job.delivered' } })).toThrow();
      expect(f.ledger.getObligation(duty.id)?.state).toBe(duty.state);
    }
    const watermark = f.ledger.latestEventSeq();
    expect(f.ledger.recordDirectiveDelivery({ requestId: f.intent.requestId, eventSeq: event.seq })).toEqual(settled);
    expect(f.ledger.latestEventSeq()).toBe(watermark);
    const reopened = new LedgerDb(f.dir);
    try {
      const ledger = new LedgerApi(reopened.handle);
      expect(ledger.latestCandidateDelivery(f.intent.jobId)).toEqual(mode === 'current' ? event : null);
      expect(ledger.getEvent(event.seq)).toEqual(event);
      if (mode !== 'current') expect(ledger.correctiveVerificationDebt(f.intent.jobId)).toEqual({ revision: f.identity.workRevision, head: null });
    } finally { reopened.close(); }
  }
  it('P51 independently qualifies a genuine original current clean native candidate', () => assertLedgerCandidate('current'));
  it('P51 caller candidacy cannot reuse an original HEAD after the current lane moves', () => assertLedgerCandidate('head-moved'));
  it('P51 caller candidacy cannot approve a tracked-dirty original lane', () => assertLedgerCandidate('dirty'));
  it('R13 material untracked inputs cannot qualify native completion against a HEAD that excludes them', () => assertLedgerCandidate('untracked'));
  it('P51 caller candidacy cannot approve a same-SHA replacement lane', () => assertLedgerCandidate('replacement'));
  it('P51 caller candidacy cannot invent an absent original cwd', () => assertLedgerCandidate('missing-cwd'));
  it('P51 caller candidacy cannot approve a changed current contract', () => assertLedgerCandidate('amended'));
  it('P51 caller candidacy cannot release a parked original job', () => assertLedgerCandidate('parked'));
  it('P51 caller candidacy cannot approve a replacement logical minion session', () => assertLedgerCandidate('actor-moved'));

  async function assertPriorCleanupDeferral(mode: 'ceased' | 'unknown' | 'failed') {
    const f = await fixture('rebrief');
    const prior = await f.registry.spawn('minion', { agentId: 'logical-minion', cwd: f.lane.path });
    const originalSpawns = f.spawns.length;
    const dispose = f.registry.disposeHandle.bind(f.registry);
    const cleanup = vi.spyOn(f.registry, 'disposeHandle').mockImplementation(async (handle) => {
      if (mode === 'failed') throw new Error('original prior cleanup failed');
      if (mode === 'ceased') await dispose(handle);
      f.supervised(['temporary later pre-spawn fence']);
    });
    const cessation = mode === 'unknown' ? vi.spyOn(prior as { cessationEvidence(): 'ceased' | 'unknown' }, 'cessationEvidence').mockReturnValue('unknown') : undefined;
    try {
      await executeAcceptedDirective(f.deps, f.intent.requestId);
      expect(f.ledger.getDirective(f.intent.requestId)).toMatchObject({ state: 'dispatching', nativeTarget: null, nativeBinding: null });
      expect(f.native.prompts).toEqual([]); expect(f.spawns).toHaveLength(originalSpawns);
      expect(f.ledger.hasDirectiveDispatchDeferral(f.intent.requestId)).toBe(mode === 'ceased');
      if (mode !== 'ceased') {
        expect(f.ledger.latestJobEventByRequestId(f.intent.jobId, 'silas.directive-producer-unknown', f.intent.requestId)).not.toBeNull();
        if (mode === 'failed') expect(f.ledger.getDirective(f.intent.requestId)?.failReason).toMatch(/original prior cleanup failed/);
        return;
      }
      cleanup.mockRestore(); f.supervised([]);
      const reopened = new LedgerDb(f.dir); const bus = new EventBus({}); const ledger = new LedgerApi(reopened.handle, { bus });
      const service = new DirectiveProgressService({ ...f.deps, ledger, notifications: new NotificationCenter({ ledger, bus }) });
      try {
        service.reconsider(); await service.settled(); service.reconsider(); await service.settled();
        expect(ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
        expect(f.spawns).toHaveLength(originalSpawns + 1); expect(f.native.prompts).toHaveLength(1);
      } finally { await service.dispose(); reopened.close(); }
    } finally { cleanup.mockRestore(); cessation?.mockRestore(); await dispose(prior); }
  }
  it('P52 positively ceased prior cleanup permits a later pre-native deferral and exactly one restart continuation', () => assertPriorCleanupDeferral('ceased'));
  it('P52 UNKNOWN prior cleanup never becomes a no-native deferral', () => assertPriorCleanupDeferral('unknown'));
  it('P52 failed prior cleanup preserves its original failure and never becomes a deferral', () => assertPriorCleanupDeferral('failed'));

  it('P54 exact successful host-absent delivery retries after a ledger settlement failure without native replay', () => {
    return (async () => {
      const f = await fixture(); void (f.ledger.getWorktree(f.lane.id) ?? f.ledger.registerWorktree(f.lane));
      f.ledger.prepareDirectiveTarget(f.intent.requestId, { agentId: 'logical-minion', sessionFile: f.file });
      prepareDirectiveBinding({ identity: f.identity, runtime: 'pi', agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file, text: 'original user', authorityManifest: 'original authority' });
      const producer = prepareDirectiveProducer({ identity: f.identity, agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file });
      f.ledger.startDirectiveProducer(f.identity, producer);
      f.native.append({ role: 'user', content: [{ type: 'text', text: 'original user' }] }); f.native.finish();
      const proof = inspectDirectiveCheckpoint(f.file, f.identity);
      if (proof.state !== 'terminal' || !proof.ok) throw new Error('original successful terminal required');
      recordDirectiveCompletion(producer, proof.checkpointId, resolveGitCommit(f.lane.path, 'HEAD'));
      const probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('fixture exact local host absence'), { code: 'ESRCH' }); });
      const record = vi.spyOn(f.ledger, 'recordDirectiveDelivery').mockImplementationOnce(() => { throw new Error('transient original ledger settlement failure'); });
      try {
        expect(() => settleNativeDirective(f.deps, f.identity)).toThrow(/transient original ledger/);
        const event = f.ledger.latestJobEventByRequestId(f.intent.jobId, 'job.delivered', f.intent.requestId)!;
        const bytes = readFileSync(f.file, 'utf8'); const journal = readFileSync(`${f.file}.producers.jsonl`, 'utf8');
        expect(event.payload).toMatchObject({ native_completion: { physical_cessation: [{ evidence: 'host-absent' }] } });
        record.mockRestore(); let settled = false;
        expect(() => { settled = settleNativeDirective(f.deps, f.identity); }).not.toThrow(); expect(settled).toBe(true);
        expect(f.ledger.getDirective(f.intent.requestId)).toMatchObject({ state: 'settled', deliverySeq: event.seq });
        expect(f.ledger.getEvent(event.seq)).toEqual(event);
        expect(f.ledger.listJobEventsByKinds(f.intent.jobId, ['job.delivered'])).toHaveLength(1);
        expect(readFileSync(f.file, 'utf8')).toBe(bytes); expect(readFileSync(`${f.file}.producers.jsonl`, 'utf8')).toBe(journal);
        expect(f.native.prompts).toEqual([]); expect(f.spawns).toEqual([]);
      } finally { record.mockRestore(); probe.mockRestore(); recordDirectiveProducerCessation(producer); }
    })();
  });

  it('an exact successful completion whose producer probe is EPERM stays UNKNOWN: no delivery, no settlement, nothing disposed (#363 S04-2-01)', async () => {
    const f = await fixture(); void (f.ledger.getWorktree(f.lane.id) ?? f.ledger.registerWorktree(f.lane));
    f.ledger.prepareDirectiveTarget(f.intent.requestId, { agentId: 'logical-minion', sessionFile: f.file });
    prepareDirectiveBinding({ identity: f.identity, runtime: 'pi', agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file, text: 'original user', authorityManifest: 'original authority' });
    const producer = prepareDirectiveProducer({ identity: f.identity, agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file });
    f.ledger.startDirectiveProducer(f.identity, producer);
    f.native.append({ role: 'user', content: [{ type: 'text', text: 'original user' }] }); f.native.finish();
    const proof = inspectDirectiveCheckpoint(f.file, f.identity);
    if (proof.state !== 'terminal' || !proof.ok) throw new Error('original successful terminal required');
    recordDirectiveCompletion(producer, proof.checkpointId, resolveGitCommit(f.lane.path, 'HEAD'));
    // No lock file is left to refuse on its own: the probe alone decides, and EPERM proves nothing.
    expect(existsSync(`${f.file}.lock`)).toBe(false);
    const probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('fixture ambiguous permission'), { code: 'EPERM' }); });
    const disposals = vi.spyOn(f.registry, 'disposeHandle');
    try {
      expect(inspectDirectiveProducers(f.file, f.identity)).toEqual([expect.objectContaining({ evidence: 'unknown' })]);
      const outcome = (() => { try { return settleNativeDirective(f.deps, f.identity); } catch (error) { return error; } })();
      expect(outcome).toBeInstanceOf(DirectiveCheckpointError);
      expect((outcome as Error).message).toMatch(/^exact original physical native producer cessation unproven; start \d+$/u);
      expect(f.ledger.latestJobEventByRequestId(f.intent.jobId, 'job.delivered', f.intent.requestId)).toBeNull();
      expect(f.ledger.getDirective(f.intent.requestId)?.state).not.toBe('settled');
      expect(disposals).not.toHaveBeenCalled();
      expect(f.native.prompts).toEqual([]); expect(f.spawns).toEqual([]);
    } finally { disposals.mockRestore(); probe.mockRestore(); recordDirectiveProducerCessation(producer); }
  });

  async function assertHistoricalMissingHead(mode: 'amended' | 'parked' | 'unknown') {
    const f = await fixture(); f.seed(); f.native.finish();
    f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, f.identity));
    if (mode === 'parked') f.ledger.setJobStatus(f.intent.jobId, 'parked');
    else f.ledger.addJobAmendment({ jobId: f.intent.jobId, body: 'current approved clarification', effect: 'administrative', supersedes: [], approval: { by: 'owner', reference: 'P55' }, expectedContractSha256: f.identity.contractSha256 });
    const unknown = mode === 'unknown' ? prepareDirectiveProducer({ identity: f.identity, agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file }) : null;
    const bytes = readFileSync(f.file, 'utf8'); const job = f.ledger.getJob(f.intent.jobId);
    try {
      if (mode === 'unknown') {
        expect(() => f.ledger.recordHistoricalNativeDirectiveCompletion(f.identity, f.lane.id)).toThrow();
        expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('admitted');
        expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull(); return;
      }
      expect(() => f.ledger.recordHistoricalNativeDirectiveCompletion(f.identity, f.lane.id)).not.toThrow();
      expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
      const event = f.ledger.latestJobEventByRequestId(f.intent.jobId, 'job.delivered', f.intent.requestId)!;
      expect(event.payload).toMatchObject({ sha: null, work_revision: f.identity.workRevision, candidate_delivery_proven: false, historical_bookkeeping_only: true, native_completion: { identity: f.identity, receipt: null } });
      expect(f.ledger.latestCandidateDelivery(f.intent.jobId)).toBeNull();
      const root = f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-current-gates-owed')!;
      expect(root.payload).toMatchObject({ delivery_seq: event.seq, sha: null });
      expect(['open', 'waiting', 'suspended']).toContain(f.ledger.getObligation((root.payload as { obligation_id: string }).obligation_id)!.state);
      const checkpoint = inspectDirectiveCheckpoint(f.file, f.identity);
      if (checkpoint.state !== 'terminal') throw new Error('historical original terminal must remain readable');
      expect(readDirectiveCompletion(f.file, f.identity, checkpoint.checkpointId)).toBeNull();
      const reopened = new LedgerDb(f.dir);
      try { const ledger = new LedgerApi(reopened.handle); expect(ledger.getDirective(f.intent.requestId)?.state).toBe('settled'); expect(ledger.getEvent(event.seq)).toEqual(event); expect(ledger.latestCandidateDelivery(f.intent.jobId)).toBeNull(); }
      finally { reopened.close(); }
    } finally { if (unknown !== null) recordDirectiveProducerCessation(unknown); }
    expect(f.ledger.getJob(f.intent.jobId)).toEqual(job); expect(readFileSync(f.file, 'utf8')).toBe(bytes);
    expect(f.spawns).toEqual([]); expect(f.native.prompts).toEqual([]);
  }
  it('P55 changed-authority historical completion retains truthful null HEAD without sidecar backfill', () => assertHistoricalMissingHead('amended'));
  it('P55 parked historical completion retains truthful null HEAD without changing the job or native history', () => assertHistoricalMissingHead('parked'));
  it('P55 missing historical HEAD never waives an UNKNOWN physical producer', () => assertHistoricalMissingHead('unknown'));

  it('correlated job.delivered cannot settle an admitted native turn without a terminal checkpoint', async () => {
    const f = await fixture(); f.seed();
    f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, f.identity));
    const forged = f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.intent.jobId, payload: { request_id: f.intent.requestId, agentId: 'logical-minion', work_revision: f.identity.workRevision } });
    expect(() => settleNativeDirective(f.deps, f.identity)).toThrow(/successful native terminal checkpoint/u);
    expect(f.ledger.getDirective(f.intent.requestId)).toMatchObject({ state: 'admitted', deliverySeq: null });
    expect(f.ledger.getEvent(forged.seq)).toEqual(forged);
  });

  it('exact correlated native completion event reconciles idempotently only after terminal and cessation proof', async () => {
    const f = await fixture(); f.seed(); f.native.finish();
    f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, f.identity));
    const proof = inspectDirectiveCheckpoint(f.file, f.identity);
    expect(proof.state).toBe('terminal'); if (proof.state !== 'terminal') throw new Error('fixture must produce terminal checkpoint');
    const producer = inspectDirectiveProducers(f.file, f.identity).at(-1)!.producer;
    const head = resolveGitCommit(f.lane.path, 'HEAD');
    recordDirectiveCompletion(producer, proof.checkpointId, head);
    const receipt = readDirectiveCompletion(f.file, f.identity, proof.checkpointId);
    expect(receipt).not.toBeNull();
    const event = recordFollowUpDelivery({ ledger: f.ledger, worktrees: f.worktrees, jobId: f.intent.jobId, agentId: 'logical-minion',
      source: 'silas-directive', requestId: f.intent.requestId, workRevision: f.identity.workRevision,
      nativeCompletion: { sha: head, provenance: { identity: f.identity, checkpoint_id: proof.checkpointId, binding: proof.binding,
        receipt, physical_cessation: inspectDirectiveProducers(f.file, f.identity) } } });
    expect(settleNativeDirective(f.deps, f.identity)).toBe(true);
    expect(f.ledger.getDirective(f.intent.requestId)).toMatchObject({ state: 'settled', deliverySeq: event.eventSeq });
  });

  it('current-protocol event-only sent and delivery cannot bind admission or settle through durable reconciliation', async () => {
    const f = await fixture();
    const sent = f.ledger.appendCustomEvent({ jobId: f.intent.jobId, kind: 'silas.directive-sent', payload: { request_id: f.intent.requestId, minion_id: 'logical-minion' } });
    f.ledger.appendCustomEvent({ jobId: f.intent.jobId, kind: 'job.delivered', payload: { request_id: f.intent.requestId } });
    expect(() => f.ledger.recordDirectiveAdmission({ requestId: f.intent.requestId, minionId: 'logical-minion', eventSeq: sent.seq })).toThrow(/native admission/);
    const { reconcilePendingDirectives } = await import('../src/dispatch/rebrief-recovery.js');
    reconcilePendingDirectives(f.deps);
    expect(f.ledger.getDirective(f.intent.requestId)).toMatchObject({ state: 'dispatching', nativeBinding: null, admissionSeq: null, deliverySeq: null });
  });
  it('durable event-only reconciliation cannot settle a bound current request without native terminal proof', async () => {
    const f = await fixture();
    f.seed();
    f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, f.identity));
    f.ledger.appendCustomEvent({ jobId: f.intent.jobId, kind: 'job.delivered', payload: {
      request_id: f.intent.requestId, agentId: 'logical-minion', work_revision: f.identity.workRevision,
    } });
    const report = settleDirectivesFromEvidence({ ledger: f.ledger });
    expect(report).toMatchObject({ examined: 1, completed: 0, failed: 0 });
    expect(f.ledger.getDirective(f.intent.requestId)).toMatchObject({ state: 'admitted', deliverySeq: null });
  });
  it('boot progress preserves correlated completion recovery for pre-native legacy requests', async () => {
    const f = await fixture();
    markHistoricalDirectiveFixture(f.ledger, f.intent.requestId);
    const sent = f.ledger.appendCustomEvent({ jobId: f.intent.jobId, kind: 'silas.directive-sent',
      payload: { request_id: f.intent.requestId, minion_id: 'logical-minion' } });
    const delivered = f.ledger.appendCustomEvent({ jobId: f.intent.jobId, kind: 'job.delivered',
      payload: { request_id: f.intent.requestId, source: 'silas-directive' } });
    const bootReport = reconcilePendingLegacyDirectives({ ledger: f.ledger, notifications: f.notifications });
    expect(bootReport).toMatchObject({ examined: 1, completed: 1, escalated: 0 });
    const service = new DirectiveProgressService(f.deps);
    service.reconsider();
    await service.settled();
    expect(f.ledger.getDirective(f.intent.requestId)).toMatchObject({ state: 'settled', admissionSeq: sent.seq, deliverySeq: delivered.seq });
    expect(f.ledger.listObligations({ jobId: f.intent.jobId }).filter((row) => row.incidentKey === `directive-recovery:${f.intent.requestId}`)).toEqual([]);
    expect(f.spawns).toEqual([]);
    await service.dispose();
  });
  it('actual admitted original host exit continues once on the same persisted native lane, including live and frozen-owner refusals', async () => {
    const f = await fixture();
    const root = process.cwd();
    const code = `
      import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
      import { LedgerDb } from ${JSON.stringify(`${process.cwd()}/dist/ledger/db.js`)};
      import { LedgerApi } from ${JSON.stringify(`${process.cwd()}/dist/ledger/api.js`)};
      import { EventBus } from ${JSON.stringify(`${process.cwd()}/dist/events/bus.js`)};
      import { SessionStore } from ${JSON.stringify(`${process.cwd()}/dist/sessions/store.js`)};
      import { rememberManagedLane } from ${JSON.stringify(`${process.cwd()}/dist/worktrees/handoff.js`)};
      import { PiAgentHandle, PI_CAPABILITIES } from ${JSON.stringify(`${process.cwd()}/dist/runtime/pi-adapter.js`)};
      import { executeAcceptedDirective } from ${JSON.stringify(`${process.cwd()}/dist/dispatch/directive-progress.js`)};
      function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
      const NativeFixture = ${NativeFixture.toString().replace(/__vite_ssr_import_\d+__\./g, '')};
      const db = new LedgerDb(${JSON.stringify(f.dir)});
      const ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
      for (const lane of ledger.listWorktrees()) rememberManagedLane(lane, ledger);
      const store = new SessionStore(${JSON.stringify(f.dir)});
      const native = new NativeFixture(${JSON.stringify(f.file)}); native.autoFinish = false;
      const manifest = ${JSON.stringify(JSON.stringify({ role: 'minion', cwd: f.lane.path, tools: ['read', 'bash'], model: 'fixture/model' }))};
      const registry = {
        getHandle: () => null,
        spawn: async () => {
          store.acquireLock(native.sessionFile);
          const handle = new PiAgentHandle('minion', native, native.sessionFile, PI_CAPABILITIES, false, [], store, () => {}, () => {}, 60000, 'logical-minion', () => manifest);
          handle.subscribe((event) => { if (event.type === 'state') ledger.setAgentState(handle.id, event.state); });
          native.subscribe((event) => { if (event.type === 'agent_start') setImmediate(() => process.send({ admitted: ledger.getDirective('approved-request').state })); });
          return handle;
        },
        disposeHandle: async (handle) => handle.dispose(),
      };
      await executeAcceptedDirective({ ledger, registry, worktrees: { listWorktrees: () => [${JSON.stringify(f.lane)}] },
        notifications: { postIncident: () => {} }, signal: new AbortController().signal, pendingProducerBlockers: () => [] }, 'approved-request');
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let service: DirectiveProgressService | null = null;
    // Every step after the spawn, readiness included, is inside the child's
    // cleanup boundary (#363 S10-0-02, S10-1-01).
    try {
      let stderr = ''; child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
      let deadline: NodeJS.Timeout | undefined;
      const ready = await Promise.race([
        once(child, 'message'),
        once(child, 'exit').then(() => { throw new Error(`native fixture exited before admission: ${stderr}`); }),
        new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error(`native fixture reported no admission within 20s: ${stderr}`)), 20_000); }),
      ]).finally(() => clearTimeout(deadline));
      expect(ready[0]).toMatchObject({ admitted: 'admitted' });
      const original = f.ledger.getDirective(f.intent.requestId)!;
      const start = f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-producer-started')!;
      const nativePrefix = readFileSync(f.file, 'utf8');
      let resumedHandle: AgentHandle | null = null;
      const registry: DirectiveRegistry = {
        getHandle: () => resumedHandle,
        spawn: vi.fn(async (_role, options = {}) => {
          if (options.directiveRecoveryProducer !== undefined) f.store.acquireLockAfterHostExit(f.file, options.directiveRecoveryProducer.pid, options.directiveRecoveryProducer.lockOwner);
          resumedHandle = new PiAgentHandle('minion', f.native, f.file, PI_CAPABILITIES, false, [], f.store, () => {}, () => { resumedHandle = null; },
            60_000, options.agentId, () => JSON.stringify({ role: 'minion', cwd: f.lane.path, tools: ['read', 'bash'], model: 'fixture/model' }));
          return resumedHandle;
        }),
        disposeHandle: async (handle) => handle.dispose(),
      };
      service = new DirectiveProgressService({ ...f.deps, registry });
      service.reconsider(); await service.settled();
      expect(registry.spawn).not.toHaveBeenCalled(); expect(f.native.continuations).toBe(0);
      child.kill('SIGSTOP'); // frozen-but-live is never dead by heartbeat age
      service.reconsider(); await service.settled();
      expect(registry.spawn).not.toHaveBeenCalled(); expect(readFileSync(f.file, 'utf8')).toBe(nativePrefix);
      const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit;
      await service.dispose(); f.db.close();
      const db = new LedgerDb(f.dir); cleanups.push(() => db.close());
      const bus = new EventBus({}); const ledger = new LedgerApi(db.handle, { bus });
      service = new DirectiveProgressService({ ...f.deps, ledger, registry, notifications: new NotificationCenter({ ledger, bus }) });
      service.reconsider(); await service.settled();
      expect(ledger.getDirective(original.requestId)).toMatchObject({ state: 'settled', nativeTarget: original.nativeTarget,
        nativeBinding: original.nativeBinding, workRevision: original.workRevision, authorityEpoch: original.authorityEpoch });
      expect(f.native.prompts).toEqual([]); expect(f.native.continuations).toBe(1); expect(registry.spawn).toHaveBeenCalledTimes(1);
      expect(ledger.getEvent(start.seq)).toEqual(start);
      expect(ledger.listJobEventsByKinds(f.intent.jobId, ['silas.directive-continuation-claimed'])).toHaveLength(1);
      const delivery = ledger.latestJobEvent(f.intent.jobId, 'job.delivered'); expect(delivery?.payload).toMatchObject({ request_id: original.requestId, agentId: 'logical-minion' });
      expect(ledger.getJob(f.intent.jobId)?.prUrl).toBe('https://example.test/pull/286');
      expect(f.worktrees.listWorktrees({ jobId: f.intent.jobId })).toEqual([f.lane]);
      await service.dispose();
      service = new DirectiveProgressService({ ...f.deps, ledger, registry, notifications: new NotificationCenter({ ledger, bus }) });
      service.reconsider(); await service.settled();
      expect(ledger.listJobEventsByKinds(f.intent.jobId, ['job.delivered'])).toEqual([delivery]);
      expect(f.native.continuations).toBe(1); expect(registry.spawn).toHaveBeenCalledTimes(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill('SIGKILL'); await exit; }
      await service?.dispose();
    }
  });

  it('a later ceased physical incarnation on the same native file cannot erase the original live owner', async () => {
    const f = await fixture(); f.seed();
    const original = prepareDirectiveProducer({ identity: f.identity, agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file });
    const start = f.ledger.startDirectiveProducer(f.identity, original);
    const later = prepareDirectiveProducer({ identity: f.identity, agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file });
    recordDirectiveProducerCessation(later);
    expect(original.incarnation).not.toBe(later.incarnation);
    expect(inspectDirectiveProducers(f.file, f.identity)).toEqual(expect.arrayContaining([
      { producer: original, evidence: 'unknown' }, { producer: later, evidence: 'ceased' },
    ]));
    expect(() => f.ledger.appendCustomEvent({ kind: 'silas.directive-producer-ceased', jobId: f.intent.jobId, payload: {
      request_id: f.intent.requestId, agent_id: 'logical-minion', session_file: f.file,
      producer_start_seq: start, producer_identity: f.identity, native_producer: later,
    } })).toThrow(/exact original start/);
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled(); await service.dispose();
    expect(f.native.continuations).toBe(0); expect(f.spawns).toEqual([]); expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
  });

  it('a torn physical producer journal remains actionable UNKNOWN without rewriting evidence or spawning', async () => {
    const f = await fixture(); f.seed();
    appendFileSync(`${f.file}.producers.jsonl`, '{"state":"ceased"');
    const bytes = readFileSync(`${f.file}.producers.jsonl`, 'utf8');
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled(); await service.dispose();
    expect(f.spawns).toEqual([]); expect(f.native.continuations).toBe(0); expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
    expect(readFileSync(`${f.file}.producers.jsonl`, 'utf8')).toBe(bytes);
    expect(f.ledger.findNotificationByKind(`silas.directive-unreconciled.${f.intent.requestId}`, 'active')?.detail).toContain('partial write');
  });

  it('restores actual admission lost before ledger binding without replay', async () => {
    const f = await fixture(); f.seed();
    f.native.append({ role: 'assistant', stopReason: 'stop', content: [] });
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('dispatching');
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
    expect(f.ledger.getDirective(f.intent.requestId)).toMatchObject({ state: 'settled', admissionMinion: 'logical-minion' });
    expect(f.native.prompts).toEqual([]); expect(f.spawns).toEqual([]);
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')?.payload).toMatchObject({ request_id: f.intent.requestId, work_revision: 0 });
  });

  it('R13 same-HEAD wrong-branch checkpoint refuses before spawn and preserves the original user checkpoint', async () => {
    const f = await fixture(); f.seed();
    const head = resolveGitCommit(f.lane.path, 'HEAD'); const bytes = readFileSync(f.file, 'utf8');
    f.repo.git(['checkout', '-b', 'unapproved-same-head'], f.lane.path);
    expect(resolveGitCommit(f.lane.path, 'HEAD')).toBe(head);
    const service = new DirectiveProgressService(f.deps);
    try {
      service.reconsider(); await service.settled();
      expect(f.spawns).toEqual([]); expect(f.native.continuations).toBe(0);
      expect(f.ledger.getDirective(f.intent.requestId)?.recoveryCheckpoint).toBeNull();
      expect(readFileSync(f.file, 'utf8')).toBe(bytes);
      expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
      expect(f.ledger.findNotificationByKind(`silas.directive-unreconciled.${f.intent.requestId}`, 'active')?.detail).toContain('original registered branch');
      f.repo.git(['checkout', f.lane.branch!], f.lane.path);
      service.reconsider(); await service.settled();
      expect(f.native.continuations).toBe(1); expect(f.native.prompts).toEqual([]);
      expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
    } finally { await service.dispose(); }
  });

  it('R13 same-HEAD branch change during awaited spawn refuses without consuming the checkpoint', async () => {
    const f = await fixture(); f.seed(); const gate = deferred<void>(); f.spawnGate(gate.promise);
    const head = resolveGitCommit(f.lane.path, 'HEAD'); const bytes = readFileSync(f.file, 'utf8');
    const service = new DirectiveProgressService(f.deps);
    try {
      service.reconsider(); await vi.waitFor(() => expect(f.spawns).toHaveLength(1));
      f.repo.git(['checkout', '-b', 'changed-during-spawn'], f.lane.path);
      expect(resolveGitCommit(f.lane.path, 'HEAD')).toBe(head);
      gate.resolve(); await service.settled();
      expect(f.native.continuations).toBe(0); expect(f.native.prompts).toEqual([]);
      expect(f.ledger.getDirective(f.intent.requestId)?.recoveryCheckpoint).toBeNull();
      expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
      expect(readFileSync(f.file, 'utf8')).toBe(bytes);
    } finally { gate.resolve(); await service.dispose(); }
  });

  it('R13 prior completed checkpoint remains terminal when a later exact native admission callback was lost', async () => {
    const f = await fixture(); f.seed(); f.native.finish();
    f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, f.identity));
    const prior = inspectDirectiveCheckpoint(f.file, f.identity);
    expect(prior.state).toBe('terminal');
    expect(settleNativeDirective(f.deps, f.identity)).toBe(true); // first turn actually settled before accepting a distinct later one
    const manifest = readDirectiveBinding(f.file, f.intent.requestId)!.authorityManifest;
    const rejected = f.ledger.beginDirectiveIntent({ jobId: f.intent.jobId, requestId: 'rejected-before-native-user', directive: 'never admitted preparation', holder: 'gru' }).record;
    f.ledger.prepareDirectiveTarget(rejected.requestId, { agentId: 'logical-minion', sessionFile: f.file });
    prepareDirectiveBinding({ identity: f.ledger.directiveTurnIdentity(rejected.requestId), runtime: 'pi', agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file, text: 'never emitted native user', authorityManifest: manifest });
    f.ledger.failDirective({ requestId: rejected.requestId, reason: 'positively failed before emitting any native user or effects' });
    const later = f.ledger.beginDirectiveIntent({ jobId: f.intent.jobId, requestId: 'later-lost-admission', directive: 'distinct later approved request', holder: 'gru' }).record;
    const identity = f.ledger.directiveTurnIdentity(later.requestId);
    f.ledger.prepareDirectiveTarget(later.requestId, { agentId: 'logical-minion', sessionFile: f.file });
    const text = 'distinct later original native user';
    prepareDirectiveBinding({ identity, runtime: 'pi', agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file, text, authorityManifest: manifest });
    const userEntryId = f.native.append({ role: 'user', content: [{ type: 'text', text }] });
    expect(readDirectiveBinding(f.file, later.requestId)?.userEntryId).toBeNull();
    const bytes = readFileSync(f.file, 'utf8');
    expect(inspectDirectiveCheckpoint(f.file, f.identity)).toEqual(prior);
    expect(readDirectiveBinding(f.file, later.requestId)?.userEntryId).toBe(userEntryId);
    expect(readDirectiveBinding(f.file, rejected.requestId)?.userEntryId).toBeNull(); // rejected preparation is never fabricated into admission
    expect(f.ledger.getDirective(later.requestId)?.admissionSeq).toBeNull(); // native readback is not ledger publication
    expect(readFileSync(f.file, 'utf8')).toBe(bytes); expect(f.spawns).toEqual([]);
  });

  it('R13 ambiguous same-hash preparations never manufacture a rejected admission while locating a later request', async () => {
    const f = await fixture(); f.seed(); f.native.finish();
    f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, f.identity));
    const prior = inspectDirectiveCheckpoint(f.file, f.identity);
    expect(settleNativeDirective(f.deps, f.identity)).toBe(true);
    const manifest = readDirectiveBinding(f.file, f.intent.requestId)!.authorityManifest;
    const text = 'same exact text across two distinct accepted preparations';
    const rejected = f.ledger.beginDirectiveIntent({ jobId: f.intent.jobId, requestId: 'same-hash-rejected', directive: text, holder: 'gru' }).record;
    f.ledger.prepareDirectiveTarget(rejected.requestId, { agentId: 'logical-minion', sessionFile: f.file });
    prepareDirectiveBinding({ identity: f.ledger.directiveTurnIdentity(rejected.requestId), runtime: 'pi', agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file, text, authorityManifest: manifest });
    f.ledger.failDirective({ requestId: rejected.requestId, reason: 'positively rejected before native user emission or effects' });
    const later = f.ledger.beginDirectiveIntent({ jobId: f.intent.jobId, requestId: 'same-hash-real-later', directive: text, holder: 'gru' }).record;
    const identity = f.ledger.directiveTurnIdentity(later.requestId);
    f.ledger.prepareDirectiveTarget(later.requestId, { agentId: 'logical-minion', sessionFile: f.file });
    prepareDirectiveBinding({ identity, runtime: 'pi', agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file, text, authorityManifest: manifest });
    const userEntryId = f.native.append({ role: 'user', content: [{ type: 'text', text }] });
    const bytes = readFileSync(`${f.file}.directives.jsonl`, 'utf8');
    expect(inspectDirectiveCheckpoint(f.file, f.identity).state).toBe('unknown');
    expect(readFileSync(`${f.file}.directives.jsonl`, 'utf8')).toBe(bytes);
    // The genuine later request's own callback publishes its exact binding.
    f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, identity));
    expect(inspectDirectiveCheckpoint(f.file, f.identity)).toEqual(prior);
    expect(readDirectiveBinding(f.file, later.requestId)?.userEntryId).toBe(userEntryId);
    expect(readDirectiveBinding(f.file, rejected.requestId)?.userEntryId).toBeNull();
    expect(f.ledger.getDirective(rejected.requestId)?.admissionSeq).toBeNull();
    expect(f.spawns).toEqual([]); expect(f.native.prompts).toEqual([]);
  });

  it('continues a proven user checkpoint once on the original logical session/lane/branch/PR', async () => {
    const f = await fixture(); f.seed();
    const service = new DirectiveProgressService(f.deps); service.reconsider(); service.reconsider(); await service.settled();
    expect(f.native.continuations).toBe(1); expect(f.native.prompts).toEqual([]);
    expect(f.spawns).toHaveLength(1);
    expect(f.spawns[0]).toMatchObject({ resumeFile: f.file, agentId: 'logical-minion', cwd: f.lane.path });
    expect(f.ledger.getJob(f.intent.jobId)).toMatchObject({ prUrl: 'https://example.test/pull/286' });
    expect(f.worktrees.listWorktrees({ jobId: f.intent.jobId })[0]).toMatchObject({ id: f.lane.id, branch: f.lane.branch, path: f.lane.path });
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
    await service.dispose();
    const restarted = new DirectiveProgressService(f.deps);
    try { restarted.reconsider(); await restarted.settled(); expect(f.native.continuations).toBe(1); }
    finally { await restarted.dispose(); }
  });

  it('new rebriefs use the same exact checkpoint protocol and correlated completion', async () => {
    const f = await fixture('rebrief'); f.seed();
    expect(f.ledger.listPendingRebriefs()).toEqual([]);
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
    expect(f.native.continuations).toBe(1);
    expect(f.ledger.getDirective(f.intent.requestId)).toMatchObject({ requestKind: 'rebrief', state: 'settled', contractSnapshot: 'approved original contract' });
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'silas.rebrief')?.payload).toMatchObject({ request_id: f.intent.requestId });
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')?.payload).toMatchObject({ source: 'silas-rebrief', request_id: f.intent.requestId, work_revision: 0 });
  });

  it('resumes complete native tool results but never an unknown external effect', async () => {
    const f = await fixture(); f.seed();
    f.native.append({ role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'known completed work' } }] });
    expect(inspectDirectiveCheckpoint(f.file, f.identity)).toMatchObject({ state: 'unknown' });
    f.native.append({ role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', isError: false, content: [{ type: 'text', text: 'durable real result' }] });
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
    expect(f.native.continuations).toBe(1); expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
  });

  it('keeps malformed/partial native captures UNKNOWN and preserves their bytes', async () => {
    const f = await fixture(); f.seed(); appendFileSync(f.file, '{"type":"message"');
    const before = readFileSync(f.file, 'utf8');
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
    expect(f.spawns).toEqual([]); expect(readFileSync(f.file, 'utf8')).toBe(before);
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('admitted');
    expect(f.ledger.getDirective(f.intent.requestId)?.nativeBinding?.userEntryId).not.toBeNull();
    expect(f.ledger.latestJobEventByRequestId(f.intent.jobId, 'job.delivered', f.intent.requestId)).toBeNull();
    expect(f.ledger.listObligations({ jobId: f.intent.jobId })[0]?.nextAction.kind).toBe('gru-decision');
  });

  it('an error/abort native terminal stays incomplete and never mints delivery', async () => {
    const f = await fixture(); f.seed(); f.native.append({ role: 'assistant', stopReason: 'aborted', content: [] });
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
    expect(f.spawns).toEqual([]); expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('admitted');
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
  });

  it('a durable checkpoint claim is not retried after a second restart or lease age', async () => {
    const f = await fixture(); f.seed();
    const proof = inspectDirectiveCheckpoint(f.file, f.identity);
    if (proof.state !== 'resumable') throw new Error('fixture checkpoint expected');
    f.ledger.bindDirectiveNativeAdmission(proof.binding);
    f.ledger.claimDirectiveCheckpoint(f.identity, proof.checkpointId);
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled(); await service.dispose();
    expect(f.spawns).toEqual([]); expect(f.native.continuations).toBe(0);
    expect(f.ledger.getDirective(f.intent.requestId)?.recoveryCheckpoint).toBe(proof.checkpointId);
    // A second restart reopens the persisted claim from disk, aged far past any lease (#363 S10-0-04).
    f.db.close();
    const db = new LedgerDb(f.dir); cleanups.push(() => db.close());
    const aged = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    // The claim is the row's recovery_checkpoint plus its continuation-claimed event; both age with the job's events.
    expect(db.handle.prepare('UPDATE pending_directives SET created_at = ?, updated_at = ?, dispatch_started_at = ? WHERE request_id = ?')
      .run(aged, aged, aged, f.intent.requestId).changes).toBe(1);
    expect(db.handle.prepare('UPDATE events SET ts = ? WHERE job_id = ?').run(aged, f.intent.jobId).changes).toBeGreaterThan(0);
    const bus = new EventBus({}); const ledger = new LedgerApi(db.handle, { bus });
    const restarted = new DirectiveProgressService({ ...f.deps, ledger, notifications: new NotificationCenter({ ledger, bus }) });
    try {
      restarted.reconsider(); await restarted.settled();
      expect(f.spawns).toEqual([]); expect(f.native.continuations).toBe(0);
      expect(ledger.getDirective(f.intent.requestId)?.recoveryCheckpoint).toBe(proof.checkpointId);
    } finally { await restarted.dispose(); }
  });

  it('live/queued producer ownership blocks recovery and reconsiders after actual settlement', async () => {
    const f = await fixture(); f.seed(); f.supervised(['queued recovery producer']);
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
    expect(f.spawns).toEqual([]);
    f.supervised([]); service.reconsider(); await service.settled();
    expect(f.native.continuations).toBe(1);
  });

  it('rechecks permission after deferred spawn and disposes without executing a superseded checkpoint', async () => {
    const f = await fixture(); f.seed(); const gate = deferred<void>(); f.spawnGate(gate.promise);
    const disposed: AgentHandle[] = [];
    const dispose = f.registry.disposeHandle.bind(f.registry);
    f.registry.disposeHandle = async (handle) => { disposed.push(handle); await dispose(handle); };
    const service = new DirectiveProgressService(f.deps); service.reconsider();
    await Promise.resolve(); expect(f.spawns).toHaveLength(1);
    f.ledger.setJobStatus(f.intent.jobId, 'parked'); gate.resolve(); await service.settled();
    expect(f.native.continuations).toBe(0); expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
    // The handle spawned for the superseded checkpoint is disposed, exactly once (#363 S10-0-06).
    expect(disposed).toHaveLength(1);
    expect(disposed[0]!.id).toBe('logical-minion');
    expect(f.registry.getHandle('logical-minion')).toBeNull();
    await service.dispose();
  });

  it('terminal jobs never revive or infer completion from bookkeeping, and their live requests stay visible', async () => {
    // A merge is accepted over a live request; done and binned predate the
    // refusal of those writes (legacy history).
    for (const terminal of ['merged', 'done', 'binned'] as const) {
      const f = await fixture(); f.seed();
      if (terminal === 'merged') { f.ledger.setJobStatus(f.intent.jobId, 'in-review'); f.ledger.setJobStatus(f.intent.jobId, 'merged'); }
      else markLegacyTerminalJobFixture(f.ledger, f.intent.jobId, terminal);
      const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
      expect(f.spawns, terminal).toEqual([]); expect(f.ledger.getJob(f.intent.jobId)?.status, terminal).toBe(terminal);
      // Exact native admission is bookkeeping and is restored; completion is never inferred.
      expect(f.ledger.getDirective(f.intent.requestId)?.state, terminal).toBe('admitted');
      const card = f.ledger.findNotificationByKind(`silas.directive-unreconciled.${f.intent.requestId}`, 'active');
      expect(card, terminal).toMatchObject({ routing: 'action-required', agentId: null,
        title: `Directive ${f.intent.requestId} is still admitted on ${terminal} job ${f.intent.jobId}` });
      // #523: the owner route is the proposal; the terminal URL is gone.
      expect(card?.detail, terminal).toContain('POST /api/owner-approvals');
      expect(card?.detail, terminal).not.toContain(`/api/silas/directives/${f.intent.requestId}/abandon`);
      await service.dispose();
    }
  });

  it('actual native admission callback replay binds once, with strict actor/request/hash identity', async () => {
    const f = await fixture(); f.seed(); inspectDirectiveCheckpoint(f.file, f.identity);
    const binding = readDirectiveBinding(f.file, f.intent.requestId)!;
    f.ledger.bindDirectiveNativeAdmission(binding); f.ledger.bindDirectiveNativeAdmission(binding);
    expect(f.ledger.listJobEventsByKinds(f.intent.jobId, ['silas.directive-sent'], { limit: 10 })).toHaveLength(1);
    expect(() => f.ledger.bindDirectiveNativeAdmission({ ...binding, agentId: 'another-minion' })).toThrow(/identity|rebound/);
    expect(() => f.ledger.bindDirectiveNativeAdmission({ ...binding, identity: { ...binding.identity, payloadHash: 'b'.repeat(64) } })).toThrow(/match/);
  });

  it('queued prompt options survive until real acceptance; queued calls are not admitted', async () => {
    const f = await fixture(); f.native.autoFinish = false;
    const handle = await f.registry.spawn('minion', { agentId: 'logical-minion' });
    const first = handle.prompt('unrelated first turn');
    f.ledger.prepareDirectiveTarget(f.intent.requestId, { agentId: handle.id, sessionFile: f.file });
    let admitted = 0;
    const second = handle.prompt('queued approved request', { directive: { identity: f.identity,
      beforeAdmission: () => f.ledger.assertDirectiveAuthority(f.identity), onAdmitted: (binding) => { admitted += 1; f.ledger.bindDirectiveNativeAdmission(binding); } } });
    expect(admitted).toBe(0); expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('dispatching');
    f.native.finish(); await first; await Promise.resolve();
    expect(admitted).toBe(1); expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('admitted');
    f.native.finish(); await second; await handle.dispose();
  });

  it('generation/hash/head/epoch-fenced Gru successor executes once and only real admission settles debt', async () => {
    const f = await fixture(); surfaceDirectiveRecovery(f.deps, f.intent.requestId, 'native acceptance unknown');
    const debt = f.ledger.listObligations({ jobId: f.intent.jobId })[0]!;
    const input = { ledger: f.ledger, worktrees: f.worktrees, pendingProducerBlockers: () => [], requestId: f.intent.requestId,
      generation: debt.generation, expectedPayloadHash: f.intent.payloadHash, expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId), expectedWorkRevision: f.ledger.directiveCurrentAuthority(f.intent.jobId).workRevision, expectedContractSha256: f.ledger.directiveCurrentAuthority(f.intent.jobId).contractSha256,
      expectedHead: resolveGitCommit(f.lane.path, 'HEAD'), reason: 'inspect original effects; finish approved scope with fresh authority',
      decision: { kind: 'successor' as const, requestId: 'fresh-successor', directive: 'inspect artifacts then complete approved correction' } };
    for (const changed of [{ generation: debt.generation + 1 }, { expectedPayloadHash: 'b'.repeat(64) }, { expectedEpoch: 99 }, { expectedHead: 'bad-head' }]) {
      expect(() => recoverInterruptedDirectiveFromRoute({ ...input, ...changed })).toThrow();
      expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('dispatching');
    }
    const accepted = recoverInterruptedDirectiveFromRoute(input);
    expect(f.ledger.getObligation(debt.id)?.state).toBe('open');
    expect(recoverInterruptedDirectiveFromRoute(input).idempotent).toBe(true);
    await executeAcceptedDirective(f.deps, accepted.successor!.requestId);
    expect(f.native.prompts).toHaveLength(1); expect(f.native.prompts[0]).toContain('inspect artifacts');
    expect(f.ledger.getObligation(debt.id)?.state).toBe('settled');
    expect(f.ledger.getDirective('fresh-successor')?.state).toBe('settled');
  });

  it('a fresh-session rebrief successor takes every successor fence, runs on a fresh session, and only its actual admission settles the debt (#470)', async () => {
    const f = await fixture(); surfaceDirectiveRecovery(f.deps, f.intent.requestId, 'accepted, never admitted');
    const debt = f.ledger.listObligations({ jobId: f.intent.jobId })[0]!;
    const authority = f.ledger.directiveCurrentAuthority(f.intent.jobId);
    const input = { ...f.deps, requestId: f.intent.requestId, generation: debt.generation, expectedPayloadHash: f.intent.payloadHash,
      expectedHead: resolveGitCommit(f.lane.path, 'HEAD'), expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId),
      expectedWorkRevision: authority.workRevision, expectedContractSha256: authority.contractSha256,
      reason: 'the original session cannot be resumed; finish the approved revision in a fresh session',
      decision: { kind: 'rebrief-successor' as const, requestId: 'fresh-session-successor', note: 'finish the approved revision from current artifacts' } };
    const queued = { view: () => ({ worker: { queued: [{ id: f.intent.jobId, label: 'queued job turn' }] } }) } as never;
    const watermark = f.ledger.latestEventSeq();
    const stale: readonly (readonly [string, Partial<typeof input> & { readonly workerGate?: never }, RegExp])[] = [
      ['generation', { generation: debt.generation + 1 }, /stale/u], ['hash', { expectedPayloadHash: 'b'.repeat(64) }, /stale/u],
      ['head', { expectedHead: 'c'.repeat(40) }, /stale/u], ['epoch', { expectedEpoch: 99 }, /stale/u],
      ['revision', { expectedWorkRevision: authority.workRevision + 1 }, /revision\/contract expectations are stale/u],
      ['contract', { expectedContractSha256: 'd'.repeat(64) }, /revision\/contract expectations are stale/u],
      ['queued producer', { workerGate: queued }, /cessation is not proven/u]];
    for (const [label, changed, refusal] of stale) {
      expect(() => recoverInterruptedDirectiveFromRoute({ ...input, ...changed }), label).toThrow(refusal);
      expect(f.ledger.latestEventSeq(), label).toBe(watermark);
      expect(f.ledger.getDirective(f.intent.requestId)?.state, label).toBe('dispatching');
      expect(f.ledger.getDirective('fresh-session-successor'), label).toBeNull();
    }
    f.supervised(['supervised restart pending']);
    expect(() => recoverInterruptedDirectiveFromRoute(input)).toThrow(/cessation is not proven/u);
    f.supervised([]);
    expect(f.ledger.latestEventSeq()).toBe(watermark);
    const accepted = recoverInterruptedDirectiveFromRoute(input);
    expect(accepted).toMatchObject({ idempotent: false, successor: { requestId: 'fresh-session-successor', requestKind: 'rebrief', state: 'dispatching' } });
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('retired');
    // Accepted is not admitted: the debt stays open until the successor's native admission.
    expect(f.ledger.getObligation(debt.id)?.state).toBe('open');
    const decided = f.ledger.latestEventSeq();
    expect(recoverInterruptedDirectiveFromRoute(input)).toMatchObject({ idempotent: true, successor: { requestId: 'fresh-session-successor' } });
    expect(f.ledger.latestEventSeq()).toBe(decided);
    // The minion is resident on its existing session when the successor runs.
    const resident = await f.registry.spawn('minion', { agentId: FIXTURE_MINION, cwd: f.lane.path, resumeFile: f.file });
    await executeAcceptedDirective(f.deps, 'fresh-session-successor');
    // Fresh session: the resident session is disposed, never prompted, and
    // the successor's minion is spawned without resuming its transcript.
    expect(resident.cessationEvidence!()).toBe('ceased');
    expect(f.spawns).toHaveLength(2); expect(f.spawns[1]?.resumeFile).toBeUndefined();
    expect(f.native.prompts).toHaveLength(1); expect(f.native.prompts[0]).toContain('finish the approved revision from current artifacts');
    const successor = f.ledger.getDirective('fresh-session-successor')!;
    expect(successor).toMatchObject({ requestKind: 'rebrief', state: 'settled' });
    expect(f.ledger.getObligation(debt.id)).toMatchObject({ state: 'settled',
      settlement: { kind: 'executed-action', evidenceEventSeq: successor.admissionSeq, evidenceEventKind: 'silas.directive-sent' } });
    expect(recoverInterruptedDirectiveFromRoute(input).idempotent).toBe(true);
    expect(f.spawns).toHaveLength(2);
  });

  /** A stuck request with Gru's recovery card and debt, and a named successor accepted for it. */
  async function strandableSuccessor(kind: 'successor' | 'rebrief-successor') {
    const f = await fixture(); surfaceDirectiveRecovery(f.deps, f.intent.requestId, 'accepted, never admitted');
    const debt = f.ledger.listObligations({ jobId: f.intent.jobId })[0]!;
    const authority = f.ledger.directiveCurrentAuthority(f.intent.jobId);
    const successor = recoverInterruptedDirectiveFromRoute({ ...f.deps, requestId: f.intent.requestId, generation: debt.generation,
      expectedPayloadHash: f.intent.payloadHash, expectedHead: resolveGitCommit(f.lane.path, 'HEAD'), expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId),
      expectedWorkRevision: authority.workRevision, expectedContractSha256: authority.contractSha256, reason: 'finish the approved work',
      decision: kind === 'successor' ? { kind, requestId: 'unadmitted-successor', directive: 'finish the approved work' }
        : { kind, requestId: 'unadmitted-successor', note: 'finish the approved work fresh' } }).successor!;
    const card = () => f.ledger.findNotificationByKind(`silas.directive-unreconciled.${f.intent.requestId}`, 'active');
    const reconcile = (generation: number, admittedRequestId: string) => recoverInterruptedDirectiveFromRoute({ ...f.deps, requestId: f.intent.requestId, generation,
      expectedPayloadHash: f.intent.payloadHash, expectedHead: resolveGitCommit(f.lane.path, 'HEAD'), expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId),
      reason: 'a later request carried the retired work', decision: { kind: 'reconcile-admitted', admittedRequestId } });
    const admitLater = async (requestId: string) => {
      f.ledger.beginRebriefIntent({ jobId: f.intent.jobId, requestId, note: 'finish the approved work fresh', holder: 'gru' });
      await executeAcceptedDirective(f.deps, requestId);
      const admitted = f.ledger.getDirective(requestId)!;
      expect(admitted.admissionSeq).not.toBeNull();
      return admitted;
    };
    return { ...f, debt, successor, card, reconcile, admitLater };
  }

  async function assertStrandedSuccessorReopensDebt(kind: 'successor' | 'rebrief-successor', end: 'failed' | 'retired') {
    const f = await strandableSuccessor(kind);
    expect(f.card()).not.toBeNull();
    // The named successor ends without native admission, so it can never settle the debt.
    if (end === 'failed') f.ledger.failDirective({ requestId: f.successor.requestId, reason: 'positive no-effect before any prompt' });
    else retireInterruptedDirectiveFromRoute({ ...f.deps, requestId: f.successor.requestId, reason: 'stuck before admission; ceased', by: 'silas-ops',
      expected: { jobId: f.intent.jobId, state: 'dispatching', payloadHash: f.successor.payloadHash,
        head: resolveGitCommit(f.lane.path, 'HEAD'), ...directiveRetirementFreshness(f.ledger, f.successor.requestId) } });
    const reopened = f.ledger.recoveryObligation(f.intent.jobId, 'directive', f.intent.requestId)!;
    expect(f.ledger.getObligation(f.debt.id)).toMatchObject({ state: 'closed', settlement: { kind: 'superseded', byObligationId: reopened.id } });
    expect(reopened).toMatchObject({ state: 'open', nextAction: { kind: 'gru-decision',
      decision: expect.stringMatching(/First inspect the job's later requests: if one carrying the approved work is live or already admitted, use it; only otherwise begin a fresh request.*reconcile-admitted/u) } });
    expect(reopened.generation).toBeGreaterThan(f.debt.generation);
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-recovery-reopened')?.payload).toEqual({ request_id: f.intent.requestId,
      successor_request_id: f.successor.requestId, successor_state: end, superseded_obligation_id: f.debt.id, consumed_generation: f.debt.generation });
    // The old card names the consumed generation and a successor the retired request can no longer take.
    expect(f.card()).toBeNull();
    // Re-running the boot repair finds nothing left to reopen.
    expect(f.ledger.reopenStrandedRecoveryDebts()).toEqual({ reopened: 0, failures: [] });
    // A later request carries the work; only its admission plus Gru's reconciliation settles the reopened debt.
    const admitted = await f.admitLater('later-rebrief');
    expect(f.ledger.getObligation(reopened.id)?.state).toBe('open');
    expect(() => f.reconcile(f.debt.generation, admitted.requestId)).toThrow(/conflicts/u);
    expect(f.reconcile(reopened.generation, admitted.requestId)).toMatchObject({ successor: null, idempotent: false });
    expect(f.ledger.getObligation(reopened.id)).toMatchObject({ state: 'settled',
      settlement: { kind: 'executed-action', evidenceEventSeq: admitted.admissionSeq, evidenceEventKind: 'silas.directive-sent' } });
  }
  it('a fresh-session successor that fails before native admission reopens the retired predecessor debt for reconcile-admitted (#470)', () => assertStrandedSuccessorReopensDebt('rebrief-successor', 'failed'));
  it('a successor retired before native admission reopens the retired predecessor debt for reconcile-admitted (#470)', () => assertStrandedSuccessorReopensDebt('successor', 'retired'));

  it('an owner-abandoned successor reopens the predecessor debt as an owner decision, never as unadmitted (#493)', async () => {
    const f = await strandableSuccessor('successor');
    // The successor's native producer journal never proved cessation: custody unknown.
    f.ledger.prepareDirectiveTarget(f.successor.requestId, { agentId: 'logical-minion', sessionFile: f.file });
    prepareDirectiveProducer({ identity: f.ledger.directiveTurnIdentity(f.successor.requestId), agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file });
    abandonLiveDirectiveFromRoute({ ...f.deps, requestId: f.successor.requestId, reason: 'successor custody unknown', by: 'owner',
      expected: { jobId: f.intent.jobId, state: 'dispatching', payloadHash: f.successor.payloadHash } });
    const reopened = f.ledger.recoveryObligation(f.intent.jobId, 'directive', f.intent.requestId)!;
    expect(f.ledger.getObligation(f.debt.id)).toMatchObject({ state: 'closed', settlement: { kind: 'superseded', byObligationId: reopened.id,
      reason: `named successor ${f.successor.requestId} was abandoned by the owner with its outcome unknown` } });
    expect(reopened.nextAction).toEqual({ kind: 'owner-decision', decision: `named successor ${f.successor.requestId} was abandoned by the owner with its outcome unknown. ` +
      'Whether this retired request\'s approved work still needs doing is the owner\'s decision: nothing records that the successor ran, or that it did not.' });
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-recovery-reopened')?.payload).toMatchObject({ successor_state: 'abandoned' });
    expect(JSON.stringify(f.ledger.listJobEvents(f.intent.jobId))).not.toContain('without native admission');
    expect(f.ledger.reopenStrandedRecoveryDebts()).toEqual({ reopened: 0, failures: [] });
  });

  it('a successor chain reopens the first predecessor when its successor is itself recovered; each debt settles on the final admission (#470)', async () => {
    const f = await strandableSuccessor('rebrief-successor');
    surfaceDirectiveRecovery(f.deps, f.successor.requestId, 'successor stuck before admission');
    const successorDebt = f.ledger.recoveryObligation(f.intent.jobId, 'directive', f.successor.requestId)!;
    const authority = f.ledger.directiveCurrentAuthority(f.intent.jobId);
    // Recovering the stuck successor retires it inside that decision's own transaction.
    const final = recoverInterruptedDirectiveFromRoute({ ...f.deps, requestId: f.successor.requestId, generation: successorDebt.generation,
      expectedPayloadHash: f.successor.payloadHash, expectedHead: resolveGitCommit(f.lane.path, 'HEAD'), expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId),
      expectedWorkRevision: authority.workRevision, expectedContractSha256: authority.contractSha256, reason: 'finish the approved work fresh',
      decision: { kind: 'rebrief-successor', requestId: 'final-successor', note: 'finish the approved work fresh' } }).successor!;
    const reopened = f.ledger.recoveryObligation(f.intent.jobId, 'directive', f.intent.requestId)!;
    expect(reopened.generation).toBeGreaterThan(f.debt.generation); expect(reopened.state).toBe('open');
    // The reopened debt points Gru at the already-live request rather than a duplicate one.
    expect(reopened.nextAction).toMatchObject({ decision: expect.stringContaining('if one carrying the approved work is live or already admitted, use it') });
    expect(f.ledger.getDirective(final.requestId)?.state).toBe('dispatching');
    await executeAcceptedDirective(f.deps, final.requestId);
    const admitted = f.ledger.getDirective(final.requestId)!;
    // The final admission settles its direct predecessor's debt; the first predecessor takes Gru's reconciliation.
    expect(f.ledger.getObligation(successorDebt.id)).toMatchObject({ state: 'settled', settlement: { evidenceEventSeq: admitted.admissionSeq } });
    expect(f.ledger.getObligation(reopened.id)?.state).toBe('open');
    f.reconcile(reopened.generation, final.requestId);
    expect(f.ledger.getObligation(reopened.id)).toMatchObject({ state: 'settled', settlement: { evidenceEventSeq: admitted.admissionSeq } });
  });

  it('a reopened debt keeps a suspension that outlived the job being unparked (#470)', async () => {
    const f = await strandableSuccessor('rebrief-successor');
    f.ledger.setJobStatus(f.intent.jobId, 'parked'); f.ledger.setJobStatus(f.intent.jobId, 'working');
    expect(f.ledger.getObligation(f.debt.id)?.state).toBe('suspended');
    f.ledger.failDirective({ requestId: f.successor.requestId, reason: 'positive no-effect before any prompt' });
    const reopened = f.ledger.recoveryObligation(f.intent.jobId, 'directive', f.intent.requestId)!;
    expect(reopened.id).not.toBe(f.debt.id); expect(reopened.generation).toBeGreaterThan(f.debt.generation);
    expect(reopened.state).toBe('suspended');
    // A suspended debt is not in Gru's mailbox, so its card stays as the pointer.
    expect(f.card()).not.toBeNull();
  });

  it('the boot repair reopens only debts stranded before the hook existed, one row at a time (#470)', async () => {
    const f = await strandableSuccessor('successor');
    // A retirement written by a build without the hook: full audit facts, no reopen.
    const preHookRetire = (requestId: string) => f.db.handle.prepare(`UPDATE pending_directives SET state = 'retired', retired_at = ?, retired_by = 'gru',
      retire_reason = 'pre-#470 build: never admitted', retire_expected_state = 'dispatching', retire_expected_head = ? WHERE request_id = ?`)
      .run(new Date().toISOString(), resolveGitCommit(f.lane.path, 'HEAD'), requestId);
    // An admitted successor settled its predecessor at admission. Its row is
    // flipped to retired directly: the repair keys on admission, never state.
    await executeAcceptedDirective(f.deps, f.successor.requestId);
    expect(f.ledger.getObligation(f.debt.id)?.state).toBe('settled');
    preHookRetire(f.successor.requestId);
    // The production shape: a build without the hook retired the named successor
    // unadmitted and left the predecessor's debt on its consumed generation.
    const strand = (requestId: string) => {
      const stuck = f.ledger.beginDirectiveIntent({ jobId: f.intent.jobId, requestId, directive: 'approved correction', holder: 'gru' }).record;
      surfaceDirectiveRecovery(f.deps, requestId, 'accepted, never admitted');
      const debt = f.ledger.recoveryObligation(f.intent.jobId, 'directive', requestId)!;
      const authority = f.ledger.directiveCurrentAuthority(f.intent.jobId);
      const successor = recoverInterruptedDirectiveFromRoute({ ...f.deps, requestId, generation: debt.generation, expectedPayloadHash: stuck.payloadHash,
        expectedHead: resolveGitCommit(f.lane.path, 'HEAD'), expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId),
        expectedWorkRevision: authority.workRevision, expectedContractSha256: authority.contractSha256, reason: 'finish the approved work',
        decision: { kind: 'rebrief-successor', requestId: `${requestId}-successor`, note: 'finish the approved work fresh' } }).successor!;
      preHookRetire(successor.requestId);
      return debt;
    };
    const first = strand('stranded-one'); const second = strand('stranded-two');
    const card = (requestId: string) => f.ledger.findNotificationByKind(`silas.directive-unreconciled.${requestId}`, 'active');
    // A row that fails AFTER its writes (audit event, superseded debt, new
    // incarnation) rolls all of them back, is reported by name, and leaves
    // the other rows repairing.
    const lookup = f.ledger.findNotificationByKind.bind(f.ledger);
    const failing = vi.spyOn(f.ledger, 'findNotificationByKind').mockImplementation((kind, mode) => {
      if (kind === 'silas.directive-unreconciled.stranded-one') throw new Error('notification store unreadable');
      return lookup(kind, mode);
    });
    const watermark = f.ledger.latestEventSeq();
    expect(f.ledger.reopenStrandedRecoveryDebts()).toEqual({ reopened: 1, failures: [{ jobId: f.intent.jobId, predecessorId: 'stranded-one',
      successorId: 'stranded-one-successor', error: expect.stringContaining('notification store unreadable') }] });
    failing.mockRestore();
    expect(f.ledger.recoveryObligation(f.intent.jobId, 'directive', 'stranded-one')).toMatchObject({ id: first.id, state: 'open', generation: first.generation });
    expect(f.ledger.listEvents({ limit: 500 }).filter((event) => event.seq > watermark && event.kind === 'silas.directive-recovery-reopened')
      .map((event) => (event.payload as { request_id: string }).request_id)).toEqual(['stranded-two']);
    expect(card('stranded-one')).not.toBeNull();
    const reopened = f.ledger.recoveryObligation(f.intent.jobId, 'directive', 'stranded-two')!;
    expect(reopened.generation).toBeGreaterThan(second.generation); expect(f.ledger.getObligation(second.id)?.state).toBe('closed');
    expect(card('stranded-two')).toBeNull();
    expect(f.ledger.reopenStrandedRecoveryDebts()).toEqual({ reopened: 1, failures: [] });
    expect(f.ledger.recoveryObligation(f.intent.jobId, 'directive', 'stranded-one')?.generation).toBeGreaterThan(first.generation);
    expect(f.ledger.reopenStrandedRecoveryDebts()).toEqual({ reopened: 0, failures: [] });
    expect(f.ledger.getObligation(f.debt.id)?.state).toBe('settled');
  });

  it('owner stops refuse a successor; a concrete reserved-owner obligation settles only Gru recovery debt', async () => {
    const f = await fixture(); surfaceDirectiveRecovery(f.deps, f.intent.requestId, 'unknown');
    const debt = f.ledger.listObligations({ jobId: f.intent.jobId })[0]!;
    const reserved = f.ledger.recordBlockedObservation(f.intent.jobId, { logicalStep: 'operation', incidentKey: 'owner-budget', category: { kind: 'known', category: 'owner-hold' }, observedAtSeq: f.ledger.latestEventSeq(), nextAction: { kind: 'owner-decision', decision: 'owner must authorize the destructive operation' } });
    const input = { ledger: f.ledger, worktrees: f.worktrees, pendingProducerBlockers: () => [], requestId: f.intent.requestId, generation: debt.generation,
      expectedPayloadHash: f.intent.payloadHash, expectedHead: resolveGitCommit(f.lane.path, 'HEAD'), expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId), expectedWorkRevision: f.ledger.directiveCurrentAuthority(f.intent.jobId).workRevision, expectedContractSha256: f.ledger.directiveCurrentAuthority(f.intent.jobId).contractSha256, reason: 'destructive step is reserved for owner' };
    expect(() => recoverInterruptedDirectiveFromRoute({ ...input, decision: { kind: 'successor', requestId: 'forbidden-successor', directive: 'run' } })).toThrow(/owner/);
    expect(() => recoverInterruptedDirectiveFromRoute({ ...input, decision: { kind: 'rebrief-successor', requestId: 'forbidden-rebrief', note: 'run fresh' } })).toThrow(/owner/);
    recoverInterruptedDirectiveFromRoute({ ...input, decision: { kind: 'owner-decision', obligationId: reserved.id } });
    expect(f.ledger.getObligation(debt.id)?.state).toBe('settled'); expect(f.ledger.getObligation(reserved.id)?.state).toBe('open');
    expect(f.native.prompts).toEqual([]); expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('dispatching');
  });

  it('UNKNOWN disposal preserves producer ownership until real independent-bash cessation', async () => {
    const f = await fixture(); f.seed();
    const dispose = f.registry.disposeHandle.bind(f.registry);
    f.registry.disposeHandle = async (handle) => { f.native.isBashRunning = true; await dispose(handle); };
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
    expect(f.native.continuations).toBe(1); expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('admitted');
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
    expect(f.ledger.directiveProgressBlockers(f.intent.requestId, f.lane.id).join(';')).toContain('unproven producer cleanup');
    await service.dispose();
    const restarted = new DirectiveProgressService(f.deps);
    try {
      restarted.reconsider(); await restarted.settled();
      expect(f.native.continuations).toBe(1);
      expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('admitted');
      expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
      f.native.isBashRunning = false; restarted.reconsider(); await restarted.settled();
      expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled'); expect(f.native.continuations).toBe(1);
      expect(f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-producer-ceased')).not.toBeNull();
    } finally { await restarted.dispose(); }
  });

  async function assertCleanupPublicationRetry(kind: 'unknown' | 'ceased', afterDurability: boolean): Promise<void> {
    const f = await fixture(); f.seed();
    const dispose = f.registry.disposeHandle.bind(f.registry);
    f.registry.disposeHandle = async (handle) => { f.native.isBashRunning = true; await dispose(handle); };
    const service = new DirectiveProgressService(f.deps);
    const eventKind = `silas.directive-producer-${kind}`;
    const append = f.ledger.appendCustomEvent.bind(f.ledger);
    let failed = false;
    const fault = vi.spyOn(f.ledger, 'appendCustomEvent').mockImplementation((fields) => {
      if (fields.kind !== eventKind || failed) return append(fields);
      failed = true;
      if (afterDurability) append(fields);
      throw new Error(`${kind} cleanup publication failed`);
    });
    try {
      service.reconsider(); await service.settled();
      if (kind === 'unknown') {
        expect(failed).toBe(true);
        expect(f.ledger.findNotificationByKind(`silas.directive-unreconciled.${f.intent.requestId}`, 'active')?.detail)
          .toContain('unknown cleanup publication failed');
      }
      expect(() => settleNativeDirective(f.deps, f.identity)).toThrow(/producer.*(fences|cessation)/u);
      expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('admitted');
      expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
      service.reconsider(); await service.settled(); // publish/reconcile UNKNOWN without re-executing
      const unknown = f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-producer-unknown')!;
      expect(unknown).not.toBeNull();
      expect(f.ledger.directiveProgressBlockers(f.intent.requestId, f.lane.id).join(';')).toContain('unproven producer cleanup');
      expect(f.spawns).toHaveLength(1); expect(f.native.continuations).toBe(1);
      f.native.isBashRunning = false; // actual independent resource cessation, not disposal fulfillment
      if (kind === 'ceased') {
        expect(() => service.reconsider()).toThrow('ceased cleanup publication failed');
        expect(failed).toBe(true);
        expect(() => settleNativeDirective(f.deps, f.identity)).toThrow(/retained producer cleanup/u);
        expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('admitted');
        expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
      }
      service.reconsider(); await service.settled();
      expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
      const events = f.ledger.listJobEventsByKinds(f.intent.jobId, ['silas.directive-producer-unknown', 'silas.directive-producer-ceased']);
      expect(events.map((event) => event.kind)).toEqual(['silas.directive-producer-ceased', 'silas.directive-producer-unknown']);
      expect(events[1]).toEqual(unknown);
      const delivered = f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')!;
      expect(delivered.seq).toBeGreaterThan(events[0]!.seq);
      service.reconsider(); await service.settled();
      expect(f.ledger.listJobEventsByKinds(f.intent.jobId, ['silas.directive-producer-unknown', 'silas.directive-producer-ceased'])).toEqual(events);
      expect(f.ledger.listJobEventsByKinds(f.intent.jobId, ['job.delivered'])).toEqual([delivered]);
      expect(f.spawns).toHaveLength(1); expect(f.native.continuations).toBe(1); expect(f.native.prompts).toEqual([]);
    } finally { fault.mockRestore(); await service.dispose(); }
  }

  it('retains UNKNOWN cleanup ownership when publication fails before durability', async () => {
    await assertCleanupPublicationRetry('unknown', false);
  });
  it('reconciles committed UNKNOWN cleanup after publication fails without duplicate history', async () => {
    await assertCleanupPublicationRetry('unknown', true);
  });
  it('retains genuinely ceased cleanup ownership until failed publication can commit', async () => {
    await assertCleanupPublicationRetry('ceased', false);
  });
  it('reconciles committed genuine cessation after publication fails without losing the retry owner', async () => {
    await assertCleanupPublicationRetry('ceased', true);
  });

  async function assertCleanupAcrossLedgerRestart(ceasedBeforeRestart: boolean, failedCessationPublication = false): Promise<void> {
    const f = await fixture(); f.seed();
    const dispose = f.registry.disposeHandle.bind(f.registry);
    f.registry.disposeHandle = async (handle) => { f.native.isBashRunning = true; await dispose(handle); };
    const originalHandles: AgentHandle[] = [];
    const spawn = f.registry.spawn.bind(f.registry);
    f.registry.spawn = async (role, options) => { const handle = await spawn(role, options); originalHandles.push(handle); return handle; };
    const service = new DirectiveProgressService(f.deps);
    const append = f.ledger.appendCustomEvent.bind(f.ledger);
    let unknownAppends = 0;
    const fault = vi.spyOn(f.ledger, 'appendCustomEvent').mockImplementation((fields) => {
      if (fields.kind === 'silas.directive-producer-unknown') {
        unknownAppends += 1;
        throw new Error('UNKNOWN cleanup failed before durability at restart');
      }
      return append(fields);
    });
    try {
      service.reconsider(); await service.settled();
      expect(unknownAppends).toBe(1);
      expect(f.ledger.findNotificationByKind(`silas.directive-unreconciled.${f.intent.requestId}`, 'active')?.detail)
        .toContain('UNKNOWN cleanup failed before durability at restart');
      expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('admitted');
      expect(f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-producer-unknown')).toBeNull();
      expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
      expect(inspectDirectiveCheckpoint(f.file, f.identity)).toMatchObject({ state: 'terminal', ok: true });
      expect(originalHandles).toHaveLength(1);
      expect(originalHandles[0]!.cessationEvidence!()).toBe('unknown');
      expect(originalHandles[0]!.cessationEvidence!()).toBe('unknown'); // logical disposal is not physical cessation
      expect(f.registry.getHandle('logical-minion')).toBe(originalHandles[0]);
      fault.mockRestore();
      if (ceasedBeforeRestart) {
        // Actual independent-controller cessation, then crash between its
        // committed receipt and delivery. The reopened API may settle this
        // terminal without executing; unknown cleanup must not be bypassed.
        f.native.isBashRunning = false;
        if (failedCessationPublication) {
          const missedCessation = vi.spyOn(f.ledger, 'appendCustomEvent').mockImplementation((fields) => {
            if (fields.kind === 'silas.directive-producer-ceased') throw new Error('genuine cessation publication failed before durability');
            return append(fields);
          });
          try { expect(() => service.reconsider()).toThrow('genuine cessation publication failed before durability'); }
          finally { missedCessation.mockRestore(); }
        } else {
          const delivery = f.ledger.appendCustomEventIfCurrentDirective.bind(f.ledger);
          const missedDelivery = vi.spyOn(f.ledger, 'appendCustomEventIfCurrentDirective').mockImplementation((fields, identity) => {
            if (fields.kind === 'job.delivered') throw new Error('delivery failed before durability after real cessation');
            return delivery(fields, identity);
          });
          try { service.reconsider(); await service.settled(); } finally { missedDelivery.mockRestore(); }
        }
        expect(originalHandles[0]!.cessationEvidence!()).toBe('ceased');
        expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
        const history = f.ledger.listJobEventsByKinds(f.intent.jobId, ['silas.directive-producer-unknown', 'silas.directive-producer-ceased']);
        expect(history.map((event) => event.kind)).toEqual(failedCessationPublication ? ['silas.directive-producer-unknown'] :
          ['silas.directive-producer-ceased', 'silas.directive-producer-unknown']);
        for (const event of history) expect(event.payload).toMatchObject({ request_id: f.intent.requestId, agent_id: 'logical-minion',
          producer_start_seq: f.ledger.directiveProducerStart(f.identity), producer_identity: f.identity, session_file: f.file });
      }
      const request = f.ledger.getDirective(f.intent.requestId)!;
      const debt = f.ledger.listObligations({ jobId: f.intent.jobId }).find((row) => row.incidentKey === `directive-recovery:${f.intent.requestId}`)!;
      expect(debt).toMatchObject({ state: 'open', nextAction: { kind: 'gru-decision' }, firingRule: 'restart-recovery-gru-decision' });
      const nativeBytes = readFileSync(f.file, 'utf8');
      const binding = readDirectiveBinding(f.file, f.intent.requestId);
      const admission = f.ledger.getEvent(request.admissionSeq!);
      const cleanupHistory = f.ledger.listJobEventsByKinds(f.intent.jobId, ['silas.directive-producer-unknown', 'silas.directive-producer-ceased']);
      await service.dispose();
      f.db.close(); // Real persisted SQLite close/reopen, NOT another service on the same API.
      const reopenedDb = new LedgerDb(f.dir);
      cleanups.push(() => reopenedDb.close());
      expect(reopenedDb.dbPath).toBe(f.db.dbPath);
      const bus = new EventBus({});
      const ledger = new LedgerApi(reopenedDb.handle, { bus });
      expect(ledger).not.toBe(f.ledger);
      const freshRegistry: DirectiveRegistry = {
        getHandle: vi.fn(() => null),
        spawn: vi.fn(async () => { throw new Error('restart must not spawn or replay a terminal with unproven cleanup'); }),
        disposeHandle: vi.fn(async () => { throw new Error('fresh registry has no retained cleanup handle'); }),
      };
      const resumed = new DirectiveProgressService({ ...f.deps, ledger, registry: freshRegistry,
        notifications: new NotificationCenter({ ledger, bus }) });
      try {
        resumed.reconsider(); await resumed.settled();
        const landed = ledger.latestJobEvent(f.intent.jobId, 'job.delivered');
        const repairedCessation = ceasedBeforeRestart && failedCessationPublication
          ? ledger.latestJobEventByRequestId(f.intent.jobId, 'silas.directive-producer-ceased', f.intent.requestId) : null;
        if (ceasedBeforeRestart && failedCessationPublication) {
          // The original publication failure stays loud above. A fresh API
          // may repair only this exact positively ceased native incarnation,
          // durably, before any delivery; missing evidence still proves nothing.
          expect(repairedCessation).not.toBeNull();
          expect(repairedCessation!.payload).toMatchObject(cleanupHistory[0]!.payload as Record<string, unknown>);
          expect(repairedCessation!.seq).toBeGreaterThan(cleanupHistory[0]!.seq);
          expect((repairedCessation!.payload as { evidence: string }).evidence).toBe('ceased');
        }
        if (!ceasedBeforeRestart) {
          expect(landed, 'UNKNOWN native ownership must survive a fresh LedgerApi without a handle').toBeNull();
          expect(ledger.getDirective(f.intent.requestId)?.state).toBe('admitted');
          expect(originalHandles[0]!.cessationEvidence!()).toBe(ceasedBeforeRestart ? 'ceased' : 'unknown');
          expect(ledger.getObligation(debt.id)).toMatchObject({ generation: debt.generation, state: 'open', nextAction: { kind: 'gru-decision' } });
          expect(ledger.findNotificationByKind(`silas.directive-unreconciled.${f.intent.requestId}`, 'active')?.detail)
            .toContain(`generation ${debt.generation}`);
        } else {
          expect(landed?.payload).toMatchObject({ request_id: f.intent.requestId, agentId: 'logical-minion', work_revision: f.identity.workRevision });
          expect(landed!.seq).toBeGreaterThan(repairedCessation?.seq ?? cleanupHistory[0]!.seq);
          expect(ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
          expect(ledger.getObligation(debt.id)?.state).toBe('settled');
          resumed.reconsider(); await resumed.settled();
          expect(ledger.listJobEventsByKinds(f.intent.jobId, ['job.delivered'])).toEqual([landed]);
        }
        expect(ledger.getDirective(f.intent.requestId)).toMatchObject({ requestId: request.requestId, jobId: request.jobId,
          payloadHash: request.payloadHash, workRevision: request.workRevision, authorityEpoch: request.authorityEpoch,
          contractSha256: request.contractSha256, nativeTarget: request.nativeTarget, nativeBinding: request.nativeBinding,
          admissionSeq: request.admissionSeq, recoveryCheckpoint: request.recoveryCheckpoint });
        expect(ledger.getEvent(request.admissionSeq!)).toEqual(admission);
        expect(ledger.listJobEventsByKinds(f.intent.jobId, ['silas.directive-producer-unknown', 'silas.directive-producer-ceased']))
          .toEqual(repairedCessation === null ? cleanupHistory : [repairedCessation, ...cleanupHistory]);
        expect(readFileSync(f.file, 'utf8')).toBe(nativeBytes);
        expect(readDirectiveBinding(f.file, f.intent.requestId)).toEqual(binding);
        expect(freshRegistry.spawn).not.toHaveBeenCalled(); expect(freshRegistry.disposeHandle).not.toHaveBeenCalled();
        expect(f.spawns).toHaveLength(1); expect(f.native.continuations).toBe(1); expect(f.native.prompts).toEqual([]);
      } finally { await resumed.dispose(); }
    } finally { fault.mockRestore(); await service.dispose(); f.native.isBashRunning = false; }
  }

  it('restart with a fresh persisted ledger preserves unpublished UNKNOWN cleanup without replay or delivery', async () => {
    await assertCleanupAcrossLedgerRestart(false);
  });
  it('restart with a fresh persisted ledger settles terminal progress only after recorded genuine cleanup cessation', async () => {
    await assertCleanupAcrossLedgerRestart(true);
  });

  async function assertProducerFenceWriteFailure(mode: 'dispatch' | 'checkpoint', afterDurability: boolean): Promise<void> {
    const f = await fixture(); if (mode === 'checkpoint') f.seed();
    const prefix = readFileSync(f.file, 'utf8');
    const publish = f.bus.publish.bind(f.bus);
    const fault = afterDurability ? vi.spyOn(f.bus, 'publish').mockImplementation((event) => {
      publish(event);
      if (event.kind === 'silas.directive-producer-started') throw new Error('producer start publication failed after commit');
    }) : null;
    if (!afterDurability) f.db.handle.exec(`CREATE TRIGGER refuse_producer_start BEFORE INSERT ON events
      WHEN NEW.kind = 'silas.directive-producer-started' BEGIN SELECT RAISE(FAIL, 'producer start storage failed before commit'); END`);
    const service = new DirectiveProgressService(f.deps);
    try {
      if (mode === 'dispatch') await executeAcceptedDirective(f.deps, f.intent.requestId);
      else { service.reconsider(); await service.settled(); }
      const start = f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-producer-started');
      expect(start === null).toBe(!afterDurability);
      expect(f.ledger.getDirective(f.intent.requestId)?.dispatchStartedAt !== null).toBe(mode === 'dispatch');
      expect(f.ledger.getDirective(f.intent.requestId)?.recoveryCheckpoint).toBeNull(); // preparation/publication never entered native continue
      if (start !== null) expect(start.payload).toMatchObject({ request_id: f.intent.requestId, producer_identity: f.identity });
      expect(f.spawns).toHaveLength(1); expect(f.native.prompts).toEqual([]); expect(f.native.continuations).toBe(0);
      expect(readFileSync(f.file, 'utf8')).toBe(prefix);
      expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
      const debt = f.ledger.listObligations({ jobId: f.intent.jobId }).find((row) => row.incidentKey === `directive-recovery:${f.intent.requestId}`)!;
      expect(debt).toMatchObject({ state: 'open', nextAction: { kind: 'gru-decision' } });
      expect(f.ledger.findNotificationByKind(`silas.directive-unreconciled.${f.intent.requestId}`, 'active')?.detail)
        .toContain(afterDurability ? 'producer start publication failed after commit' : 'producer start storage failed before commit');
      if (afterDurability) expect(f.ledger.getEvent(start!.seq)?.kind).toBe('silas.directive-producer-started');
    } finally {
      fault?.mockRestore();
      if (!afterDurability) f.db.handle.exec('DROP TRIGGER refuse_producer_start');
      await service.dispose();
    }
  }
  it('common dispatch checks a live supervised producer before spawning or preparing a native target', async () => {
    const f = await fixture();
    const before = readFileSync(f.file, 'utf8');
    const head = resolveGitCommit(f.lane.path, 'HEAD');
    f.supervised(['a different supervised producer still owns the original job lane']);
    await executeAcceptedDirective(f.deps, f.intent.requestId);
    expect(f.native.prompts).toEqual([]); expect(f.native.continuations).toBe(0);
    expect(readFileSync(f.file, 'utf8')).toBe(before);
    expect(resolveGitCommit(f.lane.path, 'HEAD')).toBe(head);
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
    expect(f.spawns, 'full producer fences must precede native owner spawn, not only beforeAdmission').toEqual([]);
    expect(f.ledger.getDirective(f.intent.requestId)?.nativeTarget,
      'a blocked producer must not mutate the accepted native target').toBeNull();
  });

  it('common dispatch rechecks a real review producer appearing during pacing before spawn or target mutation', async () => {
    const f = await fixture();
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 1 });
    const holder = await gate.acquireWorkerTurn({ id: 'independent-pacing-holder', label: 'independent held pacing slot', signal: new AbortController().signal });
    let holderReleased = false;
    const before = readFileSync(f.file, 'utf8');
    const head = resolveGitCommit(f.lane.path, 'HEAD');
    const execution = executeAcceptedDirective({ ...f.deps, workerGate: gate }, f.intent.requestId);
    try {
      // The real gate registers its waiter before its returned Promise can
      // resolve. No timer or test-only admission implementation is involved.
      expect(gate.view().worker.queued).toHaveLength(1);
      expect(f.spawns).toEqual([]);
      expect(f.ledger.getDirective(f.intent.requestId)?.nativeTarget).toBeNull();
      const round = f.ledger.addRound({ jobId: f.intent.jobId, lenses: ['blind'] });
      holder.release(); holderReleased = true; await execution;
      expect(f.ledger.getRound(round.id)?.status).toBe('pending');
      expect(gate.view().worker.running).toBe(0);
      expect(f.native.prompts).toEqual([]); expect(f.native.continuations).toBe(0);
      expect(readFileSync(f.file, 'utf8')).toBe(before);
      expect(resolveGitCommit(f.lane.path, 'HEAD')).toBe(head);
      expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
      expect(f.spawns, 'a producer appearing across the actual pacing await must block pre-spawn').toEqual([]);
      expect(f.ledger.getDirective(f.intent.requestId)?.nativeTarget,
        'post-await producer refusal must precede target preparation').toBeNull();
    } finally {
      if (!holderReleased) holder.release();
      await execution;
    }
  });

  it('dispatch start fence storage failure rolls back before any native producer effect', async () => {
    await assertProducerFenceWriteFailure('dispatch', false);
  });
  it('dispatch start fence committed publication failure retains uncertainty without starting native work', async () => {
    await assertProducerFenceWriteFailure('dispatch', true);
  });
  it('checkpoint start fence storage failure rolls back before native continuation (the owner handle spawns once, never continues)', async () => {
    await assertProducerFenceWriteFailure('checkpoint', false);
  });
  it('checkpoint start fence committed publication failure retains uncertainty without continuing native work', async () => {
    await assertProducerFenceWriteFailure('checkpoint', true);
  });

  it('actual accepted dispatch at a native user checkpoint stays UNKNOWN after fresh-ledger restart without original producer cessation', async () => {
    const f = await fixture(); f.native.autoFinish = false;
    const started = deferred<void>();
    const unsubscribe = f.native.subscribe((event) => { if ((event as { type: string }).type === 'agent_start') started.resolve(); });
    const original = executeAcceptedDirective(f.deps, f.intent.requestId).catch((error: unknown) => error);
    let resumed: DirectiveProgressService | null = null;
    try {
      // An execution that ends before agent_start fails here by name, never
      // as an admission timeout (#363 S10-0-03).
      await Promise.race([started.promise, original.then((outcome) => { throw new Error(`the accepted dispatch ended before native admission: ${outcome instanceof Error ? `it threw ${outcome.name}: ${outcome.message}` : 'it returned without admitting'}`); })]);
      // The actual protocol, not seed(), has consumed this accepted prompt.
      expect(f.native.prompts).toHaveLength(1); expect(f.native.isIdle).toBe(false);
      const native = inspectDirectiveCheckpoint(f.file, f.identity);
      expect(native.state).toBe('resumable');
      const request = f.ledger.getDirective(f.intent.requestId)!;
      expect(request.state).toBe('admitted');
      const producer = f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-producer-started')!;
      expect(producer.payload).toMatchObject({ request_id: request.requestId, producer_identity: f.identity });
      const prefix = readFileSync(f.file, 'utf8');
      f.db.close(); // Hard restart loses this API/registry, not the producer's effects.
      const db = new LedgerDb(f.dir); cleanups.push(() => db.close());
      const bus = new EventBus({}); const ledger = new LedgerApi(db.handle, { bus });
      const registry: DirectiveRegistry = { getHandle: () => null,
        spawn: vi.fn(async () => { throw new Error('unproven original producer cannot be replaced'); }), disposeHandle: async () => {} };
      resumed = new DirectiveProgressService({ ...f.deps, ledger, registry, notifications: new NotificationCenter({ ledger, bus }) });
      resumed.reconsider(); await resumed.settled();
      expect(ledger.getDirective(request.requestId)).toMatchObject({ state: 'admitted', nativeBinding: request.nativeBinding,
        nativeTarget: request.nativeTarget, workRevision: request.workRevision, contractSha256: request.contractSha256,
        authorityEpoch: request.authorityEpoch, recoveryCheckpoint: null });
      expect(ledger.latestJobEvent(f.intent.jobId, 'silas.directive-producer-started')).toEqual(producer);
      expect(ledger.latestJobEvent(f.intent.jobId, 'silas.directive-producer-ceased')).toBeNull();
      expect(ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
      expect(registry.spawn).not.toHaveBeenCalled(); expect(f.native.continuations).toBe(0); expect(f.native.prompts).toHaveLength(1);
      expect(readFileSync(f.file, 'utf8')).toBe(prefix);
      const debt = ledger.listObligations({ jobId: request.jobId }).find((row) => row.incidentKey === `directive-recovery:${request.requestId}`)!;
      expect(debt).toMatchObject({ state: 'open', nextAction: { kind: 'gru-decision' } });
      expect(debt.description).toContain(`start ${producer.seq}`);
      expect(debt.nextAction).toMatchObject({ decision: expect.stringContaining('exact original producer') });
    } finally {
      await resumed?.dispose(); unsubscribe();
      // Release the controlled original test resource, preserving its abort
      // evidence rather than rewriting the checkpoint used by assertions.
      f.native.finish('aborted'); await original;
    }
  });

  it('active streaming exemption requires the exact physical request, session and current start token, never a generic agent id', async () => {
    const f = await fixture(); f.seed();
    const proof = inspectDirectiveCheckpoint(f.file, f.identity); if (proof.state === 'unknown') throw new Error(proof.reason);
    f.ledger.bindDirectiveNativeAdmission(proof.binding);
    const old = inspectDirectiveProducers(f.file, f.identity)[0]!.producer;
    const oldStart = f.ledger.startDirectiveProducer(f.identity, old);
    f.ledger.appendCustomEvent({ kind: 'silas.directive-producer-ceased', jobId: f.intent.jobId, payload: {
      request_id: f.intent.requestId, agent_id: old.agentId, session_file: f.file, producer_start_seq: oldStart, producer_identity: f.identity, native_producer: old,
    } });
    const current = prepareDirectiveProducer({ identity: f.identity, agentId: old.agentId, sessionId: old.sessionId, sessionFile: f.file });
    const start = f.ledger.startDirectiveProducer(f.identity, current);
    f.ledger.setAgentState(current.agentId, 'streaming');
    expect(f.ledger.directiveProgressBlockers(f.intent.requestId, f.lane.id, undefined, start, current)).toEqual([]);
    expect(f.ledger.directiveProgressBlockers(f.intent.requestId, f.lane.id, current.agentId, start).join(';')).toContain(`${current.agentId} (streaming)`);
    const watermark = f.ledger.latestEventSeq(); const bytes = readFileSync(`${f.file}.producers.jsonl`, 'utf8');
    for (const mismatch of [{ incarnation: 'foreign-incarnation' }, { agentId: 'reused-logical-minion' }, { sessionId: 'foreign-session' },
      { sessionFile: `${f.file}.foreign` }, { identity: { ...f.identity, payloadHash: 'f'.repeat(64) } },
      { identity: { ...f.identity, authorityEpoch: f.identity.authorityEpoch + 1 } }]) {
      expect(() => f.ledger.directiveProgressBlockers(f.intent.requestId, f.lane.id, undefined, start, { ...current, ...mismatch })).toThrow(/exact current physical/);
    }
    expect(() => f.ledger.directiveProgressBlockers(f.intent.requestId, f.lane.id, undefined, start + 1, current)).toThrow(/token/);
    expect(() => f.ledger.directiveProgressBlockers(f.intent.requestId, f.lane.id, undefined, oldStart, old)).toThrow(/token/);
    expect(() => f.ledger.directiveProgressBlockers(f.intent.requestId, f.lane.id, undefined, start, old)).toThrow(/exact current physical/);
    expect(f.ledger.latestEventSeq()).toBe(watermark); expect(readFileSync(`${f.file}.producers.jsonl`, 'utf8')).toBe(bytes);
    expect(() => f.ledger.retireInterruptedDirective({ requestId: f.intent.requestId, expectedJobId: f.intent.jobId, expectedState: 'admitted', expectedPayloadHash: f.intent.payloadHash,
      expectedHead: resolveGitCommit(f.lane.path, 'HEAD'), ...directiveRetirementInputs(f.ledger, f.intent.requestId),
      lane: { id: f.lane.id, resolvedHead: resolveGitCommit(f.lane.path, 'HEAD') }, reason: 'must not exempt an executing native owner', by: 'gru' })).toThrow(/live ownership/);
    expect(f.ledger.latestEventSeq()).toBe(watermark);
  });

  it('an exact current streaming producer cannot hide an older UNKNOWN physical incarnation on the same native session', async () => {
    const f = await fixture(); f.seed();
    const proof = inspectDirectiveCheckpoint(f.file, f.identity); if (proof.state === 'unknown') throw new Error(proof.reason);
    f.ledger.bindDirectiveNativeAdmission(proof.binding);
    const old = prepareDirectiveProducer({ identity: f.identity, agentId: 'logical-minion', sessionId: f.native.sessionId, sessionFile: f.file });
    const oldStart = f.ledger.startDirectiveProducer(f.identity, old);
    f.ledger.appendCustomEvent({ kind: 'silas.directive-producer-unknown', jobId: f.intent.jobId, payload: {
      request_id: f.intent.requestId, agent_id: old.agentId, session_file: f.file, producer_start_seq: oldStart, producer_identity: f.identity, native_producer: old,
    } });
    const current = prepareDirectiveProducer({ identity: f.identity, agentId: old.agentId, sessionId: old.sessionId, sessionFile: f.file });
    // Explicit historical/corrupt dual-owner fixture: the current guarded
    // start API correctly cannot construct this state while old UNKNOWN owns it.
    const start = f.ledger.appendCustomEvent({ kind: 'silas.directive-producer-started', jobId: f.intent.jobId,
      payload: { request_id: f.intent.requestId, producer_identity: f.identity, native_producer: current } }).seq;
    f.ledger.setAgentState(current.agentId, 'streaming');
    const watermark = f.ledger.latestEventSeq(); const bytes = readFileSync(`${f.file}.producers.jsonl`, 'utf8');
    expect(() => f.ledger.directiveProgressBlockers(f.intent.requestId, f.lane.id, undefined, start, current)).toThrow(/another physical incarnation remains UNKNOWN/);
    expect(f.ledger.directiveProgressBlockers(f.intent.requestId, f.lane.id, undefined, start).join(';')).toContain(`start ${oldStart}`);
    expect(f.ledger.latestEventSeq()).toBe(watermark); expect(readFileSync(`${f.file}.producers.jsonl`, 'utf8')).toBe(bytes);
  });

  it('a ceased physical producer never grants an active streaming exemption even with the matching latest start token', async () => {
    const f = await fixture(); f.seed();
    const proof = inspectDirectiveCheckpoint(f.file, f.identity); if (proof.state === 'unknown') throw new Error(proof.reason);
    f.ledger.bindDirectiveNativeAdmission(proof.binding);
    const ceased = inspectDirectiveProducers(f.file, f.identity)[0]!.producer;
    const start = f.ledger.startDirectiveProducer(f.identity, ceased);
    f.ledger.setAgentState(ceased.agentId, 'streaming');
    expect(() => f.ledger.directiveProgressBlockers(f.intent.requestId, f.lane.id, undefined, start, ceased)).toThrow(/ceased\/unbound/);
  });

  it('foreign or mismatched cessation receipts cannot consume the exact original producer start fence', async () => {
    const f = await fixture(); f.seed();
    expect(f.ledger.claimDirectiveDispatch(f.intent.requestId)).toBe(true);
    const producer = inspectDirectiveProducers(f.file, f.identity)[0]!.producer;
    const start = f.ledger.startDirectiveProducer(f.identity, producer);
    const before = f.ledger.latestEventSeq();
    const payload = { request_id: f.intent.requestId, agent_id: 'logical-minion', session_file: f.file,
      producer_start_seq: start, producer_identity: f.identity, native_producer: producer };
    for (const mismatch of [{ request_id: 'foreign-request' }, { agent_id: 'foreign-minion' }, { session_file: `${f.file}.foreign` },
      { producer_start_seq: start + 1 }, { producer_identity: { ...f.identity, payloadHash: 'f'.repeat(64) } },
      { producer_identity: { ...f.identity, authorityEpoch: f.identity.authorityEpoch + 1 } }]) {
      expect(() => f.ledger.appendCustomEvent({ kind: 'silas.directive-producer-ceased', jobId: f.intent.jobId,
        payload: { ...payload, ...mismatch } })).toThrow(/exact original start/);
      expect(f.ledger.latestEventSeq()).toBe(before);
    }
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-producer-ceased')).toBeNull();
    expect(f.ledger.directiveProgressBlockers(f.intent.requestId, f.lane.id).join(';')).toContain(`start ${start}`);
    expect(f.native.continuations).toBe(0); expect(f.spawns).toEqual([]);
  });

  it('resident cleanup preserves the logical native session for the next directive and cannot reuse an old producer token', async () => {
    const f = await fixture();
    await f.registry.spawn('minion', { agentId: 'logical-minion', cwd: f.lane.path });
    await executeAcceptedDirective(f.deps, f.intent.requestId);
    const first = f.ledger.getDirective(f.intent.requestId)!;
    expect(first.state).toBe('settled'); expect(f.registry.getHandle('logical-minion')).toBeNull();
    const originalStart = f.ledger.directiveProducerStart(f.identity);
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-producer-ceased')?.payload)
      .toMatchObject({ producer_start_seq: originalStart, producer_identity: f.identity, agent_id: 'logical-minion', session_file: f.file });
    const second = f.ledger.beginDirectiveIntent({ jobId: f.intent.jobId, requestId: 'second-resident-directive', directive: 'inspect remaining approved progress', holder: 'gru' }).record;
    await executeAcceptedDirective(f.deps, second.requestId);
    const identity = f.ledger.directiveTurnIdentity(second.requestId);
    const secondStart = f.ledger.directiveProducerStart(identity);
    expect(() => f.ledger.directiveProgressBlockers(second.requestId, f.lane.id, undefined, originalStart)).toThrow(/token/);
    expect(secondStart).toBeGreaterThan(originalStart);
    expect(f.ledger.getDirective(second.requestId)).toMatchObject({ state: 'settled', nativeTarget: first.nativeTarget });
    expect(f.ledger.getDirective(second.requestId)?.nativeBinding?.sessionId).toBe(first.nativeBinding?.sessionId);
    expect(f.spawns).toHaveLength(2); expect(f.spawns[1]).toMatchObject({ agentId: 'logical-minion', resumeFile: f.file, cwd: f.lane.path });
    expect(f.native.prompts).toHaveLength(2); expect(f.worktrees.listWorktrees({ jobId: f.intent.jobId })).toEqual([f.lane]);
  });

  it('prior rebrief handle cessation cannot consume the current dispatch producer start fence', async () => {
    const f = await fixture('rebrief');
    const prior = await f.registry.spawn('minion', { agentId: 'logical-minion', cwd: f.lane.path });
    const prepared = deferred<void>(); const gate = deferred<void>(); f.native.preflight = gate.promise;
    const spawn = f.registry.spawn.bind(f.registry);
    f.registry.spawn = async (role, options) => { const handle = await spawn(role, options);
      const prepare = handle.prepareDirectiveProducer!.bind(handle);
      handle.prepareDirectiveProducer = (identity) => { const producer = prepare(identity); queueMicrotask(() => prepared.resolve()); return producer; };
      return handle; };
    const execution = executeAcceptedDirective(f.deps, f.intent.requestId);
    try {
      await Promise.race([prepared.promise, execution.then(() => { throw new Error(f.ledger.findNotificationByKind(`silas.directive-unreconciled.${f.intent.requestId}`, 'active')?.detail ?? 'execution completed without producer'); })]); await Promise.resolve();
      expect(prior.cessationEvidence!()).toBe('ceased');
      const start = f.ledger.directiveProducerStart(f.identity);
      expect(f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-producer-ceased')).toBeNull();
      expect(f.ledger.directiveProgressBlockers(f.intent.requestId, f.lane.id).join(';')).toContain(`start ${start}`);
      gate.resolve(); await execution;
      expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
      expect(f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-producer-ceased')?.payload)
        .toMatchObject({ producer_start_seq: start, agent_id: f.ledger.getDirective(f.intent.requestId)?.admissionMinion });
    } finally { gate.resolve(); await execution; }
  });

  it('restart durably reconciles genuine original cessation after its publication failed without replay', async () => {
    await assertCleanupAcrossLedgerRestart(true, true);
  });

  it('checkpoint continuation preserves primary and disposal failures while releasing pacing and retaining UNKNOWN ownership', async () => {
    const f = await fixture(); f.seed();
    const gate = new PacingGate({ enabled: true, maxConcurrentMinions: 1, maxConcurrentReviewTurns: 1 });
    const spawn = f.registry.spawn.bind(f.registry);
    f.registry.spawn = async (role, options) => {
      const target = await spawn(role, options);
      target.resumeDirective = async () => { throw new Error('original checkpoint continuation failure'); };
      target.cessationEvidence = () => 'unknown'; // the failed cleanup attests no cessation
      return target;
    };
    let disposals = 0;
    f.registry.disposeHandle = async () => { disposals += 1; throw new Error('original checkpoint disposal failure'); };
    const service = new DirectiveProgressService({ ...f.deps, workerGate: gate });
    service.reconsider(); await service.settled();
    expect(disposals).toBe(1); expect(gate.view().worker.running).toBe(0);
    expect(f.ledger.listJobAdmissions(f.intent.jobId)).toEqual([]);
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('admitted');
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-producer-unknown')?.payload)
      .toMatchObject({ request_id: f.intent.requestId, agent_id: 'logical-minion' });
    expect(f.ledger.directiveProgressBlockers(f.intent.requestId, f.lane.id).join(';')).toContain('unproven producer cleanup');
    const card = f.ledger.findNotificationByKind(`silas.directive-unreconciled.${f.intent.requestId}`, 'active');
    expect(card?.detail).toContain('original checkpoint continuation failure');
    expect(card?.detail).toContain('original checkpoint disposal failure');
    expect(card?.detail).toContain('cleanup retains explicit producer ownership');
    // Signal listener cleanup must not dispose the same handle again after
    // the failed attempt, and its durable checkpoint claim is never replayed.
    f.stop.abort(); await service.dispose();
    expect(disposals).toBe(1); expect(f.spawns).toHaveLength(1); expect(f.native.prompts).toEqual([]);
  });

  it('native completion preserves old PASS and partial UNKNOWN verification captures at the same head', async () => {
    const f = await fixture(); f.seed(); f.native.append({ role: 'assistant', stopReason: 'stop', content: [] });
    const head = resolveGitCommit(f.lane.path, 'HEAD'); const artifact = join(f.dir, 'existing-verification-stdout.txt');
    writeFileSync(artifact, 'original partial UNKNOWN stdout; never rewritten\n');
    f.ledger.appendCustomEvent({ kind: 'verification.completed', jobId: f.intent.jobId, payload: { run_id: 'original-pass', source_sha: head, result: 'PASS' } });
    f.ledger.appendCustomEvent({ kind: 'verification.started', jobId: f.intent.jobId, payload: { run_id: 'original-unknown', source_sha: head, stdout_path: artifact } });
    const before = f.ledger.listJobEventsByKinds(f.intent.jobId, ['verification.completed', 'verification.started']);
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('admitted'); expect(f.spawns).toEqual([]);
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
    f.ledger.appendCustomEvent({ kind: 'verification.reconciled', jobId: f.intent.jobId, payload: { run_id: 'original-unknown', result: 'UNKNOWN', stdout_path: artifact } });
    service.reconsider(); await service.settled();
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled'); expect(f.spawns).toEqual([]);
    expect(f.ledger.listJobEventsByKinds(f.intent.jobId, ['verification.completed', 'verification.started'])).toEqual(before);
    expect(readFileSync(artifact, 'utf8')).toBe('original partial UNKNOWN stdout; never rewritten\n');
    expect(resolveGitCommit(f.lane.path, 'HEAD')).toBe(head);
  });

  it('pending review and provider continuation fences retain the exact request without claims or retries', async () => {
    const f = await fixture(); f.seed();
    const round = f.ledger.addRound({ jobId: f.intent.jobId, lenses: ['blind'] });
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
    expect(f.spawns).toEqual([]); expect(f.ledger.getDirective(f.intent.requestId)?.recoveryCheckpoint).toBeNull();
    f.ledger.abortReviewSetupWithoutSpawn(round.id);
    f.ledger.recordProviderWait({ id: 'provider-wait', routeKey: 'fixture/model@fingerprint', provider: 'fixture', model: 'model',
      endpoint: 'https://provider.example.invalid', credentialFingerprint: 'fingerprint', jobStatusAtEstablishment: 'working',
      lineageKey: `job:${f.intent.jobId}`, waiterKind: 'job-minion', jobId: f.intent.jobId, agentId: 'logical-minion', slotId: null,
      sessionFile: f.file, continuation: { promptText: 'saved but never replayed', promptOwner: 'minion-brief', hadOpenTurn: true },
      incidentId: 'provider-incident', incidentGeneration: 1, reasonClass: 'temporary-recoverable:429' });
    service.reconsider(); await service.settled();
    expect(f.spawns).toEqual([]); expect(f.native.prompts).toEqual([]);
    expect(f.ledger.getDirective(f.intent.requestId)?.recoveryCheckpoint).toBeNull();
    expect(f.ledger.listOpenProviderWaitsForJob(f.intent.jobId)).toHaveLength(1);
  });

  it('bounded reconsideration advances unrelated completed work while one request has unknown tool effects', async () => {
    const f = await fixture(); f.seed();
    f.native.append({ role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'unknown', name: 'bash', arguments: { command: 'effect not proven finished' } }] });
    const jobId = 'unrelated-job'; f.ledger.addJob({ id: jobId, repo: 'fixture', title: 'unrelated', briefing: 'approved unrelated contract' });
    f.ledger.setJobStatus(jobId, 'working'); const otherLane = await f.worktrees.createJobWorktree({ repoPath: f.repo.path, jobId });
    const file = join(f.dir, 'other-native.jsonl'); writeFileSync(file, ''); const native = new NativeFixture(file, 'other-native');
    f.ledger.registerAgent({ id: 'other-minion', role: 'minion', jobId, sessionFile: file }); f.ledger.setAgentState('other-minion', 'idle');
    const request = f.ledger.beginDirectiveIntent({ jobId, requestId: 'other-request', directive: 'approved unrelated turn', holder: 'gru' }).record;
    const identity = f.ledger.directiveTurnIdentity(request.requestId); f.ledger.prepareDirectiveTarget(request.requestId, { agentId: 'other-minion', sessionFile: file });
    prepareDirectiveBinding({ identity, runtime: 'pi', agentId: 'other-minion', sessionId: native.sessionId, sessionFile: file, text: 'approved unrelated turn', authorityManifest: 'other authorized fixture' });
    recordDirectiveProducerCessation(prepareDirectiveProducer({ identity, agentId: 'other-minion', sessionId: native.sessionId, sessionFile: file }));
    native.append({ role: 'user', content: [{ type: 'text', text: 'approved unrelated turn' }] }); native.append({ role: 'assistant', stopReason: 'stop', content: [] });
    const service = new DirectiveProgressService(f.deps); service.reconsider(1); await service.settled(); service.reconsider(1); await service.settled();
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('admitted'); expect(f.ledger.getDirective(request.requestId)?.state).toBe('settled');
    expect(f.spawns).toEqual([]); expect(f.worktrees.listWorktrees({ jobId })[0]?.id).toBe(otherLane.id);
  });

  it('owner amendments before recovery forbid old-snapshot continuation and preserve truthful native admission', async () => {
    const f = await fixture('rebrief'); f.seed();
    const old = f.ledger.getDirective(f.intent.requestId)!;
    const amendment = f.ledger.addJobAmendment({ jobId: f.intent.jobId, body: 'Approved material correction; use the new acceptance requirement.',
      supersedes: [], approval: { by: 'owner', reference: 'GH-286 fixture approval' }, effect: 'material', expectedContractSha256: old.contractSha256! });
    expect(amendment.status).toBe('accepted');
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
    expect(f.spawns).toEqual([]); expect(f.native.continuations).toBe(0);
    expect(f.ledger.getDirective(f.intent.requestId)).toMatchObject({ state: 'admitted', workRevision: 0, contractSha256: old.contractSha256 });
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
  });

  it('an owner amendment during awaited resume prevents old execution before the native checkpoint claim', async () => {
    const f = await fixture(); f.seed(); const gate = deferred<void>(); f.spawnGate(gate.promise);
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await Promise.resolve(); expect(f.spawns).toHaveLength(1);
    expect(f.ledger.addJobAmendment({ jobId: f.intent.jobId, body: 'New approved requirement during spawn.', supersedes: [],
      approval: { by: 'owner', reference: 'GH-286 during-spawn approval' }, effect: 'material', expectedContractSha256: f.identity.contractSha256 }).status).toBe('accepted');
    gate.resolve(); await service.settled();
    expect(f.native.continuations).toBe(0); expect(f.native.prompts).toEqual([]);
    expect(f.ledger.getDirective(f.intent.requestId)?.recoveryCheckpoint).toBeNull();
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
  });

  it('an amendment-aware fresh successor gets current authority once without relabeling original history', async () => {
    const f = await fixture(); f.seed();
    expect(f.ledger.addJobAmendment({ jobId: f.intent.jobId, body: 'Current approved material requirement.', supersedes: [],
      approval: { by: 'owner', reference: 'GH-286 new scope' }, effect: 'material', expectedContractSha256: f.identity.contractSha256 }).status).toBe('accepted');
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
    const predecessor = f.ledger.getDirective(f.intent.requestId)!; const debt = f.ledger.listObligations({ jobId: f.intent.jobId })[0]!;
    const current = f.ledger.directiveCurrentAuthority(f.intent.jobId);
    const input = { ...f.deps, requestId: f.intent.requestId, generation: debt.generation, expectedPayloadHash: predecessor.payloadHash,
      expectedHead: resolveGitCommit(f.lane.path, 'HEAD'), expectedEpoch: current.authorityEpoch,
      expectedWorkRevision: current.workRevision, expectedContractSha256: current.contractSha256,
      reason: 'old command ceased; explicitly apply current approved correction without replaying it',
      decision: { kind: 'successor' as const, requestId: 'amendment-successor', directive: 'inspect existing artifacts and implement the current approved requirement' } };
    const before = f.ledger.latestEventSeq();
    for (const stale of [{ expectedEpoch: f.identity.authorityEpoch }, { expectedWorkRevision: 0 }, { expectedContractSha256: f.identity.contractSha256 }]) {
      expect(() => recoverInterruptedDirectiveFromRoute({ ...input, ...stale })).toThrow(); expect(f.ledger.latestEventSeq()).toBe(before);
    }
    const accepted = recoverInterruptedDirectiveFromRoute(input); await executeAcceptedDirective(f.deps, accepted.successor!.requestId);
    await expect(executeAcceptedDirective(f.deps, accepted.successor!.requestId)).rejects.toThrow('terminal');
    expect(f.native.prompts).toHaveLength(1); expect(f.native.prompts[0]).toContain('Current approved material requirement.');
    expect(f.ledger.getDirective(f.intent.requestId)).toMatchObject({ state: 'retired', workRevision: 0, contractSha256: f.identity.contractSha256, nativeBinding: predecessor.nativeBinding });
    expect(f.ledger.getDirective('amendment-successor')).toMatchObject({ state: 'settled', workRevision: 1, contractSha256: current.contractSha256 });
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')?.payload).toMatchObject({ request_id: 'amendment-successor', work_revision: 1 });
    expect(f.ledger.getObligation(debt.id)?.state).toBe('settled'); expect(recoverInterruptedDirectiveFromRoute(input).idempotent).toBe(true);
    expect(() => recoverInterruptedDirectiveFromRoute({ ...input, expectedWorkRevision: 0 })).toThrow(/conflict/);
  });

  it('a hold/stop epoch cannot use the amendment-only successor exception after its gap', async () => {
    const f = await fixture(); surfaceDirectiveRecovery(f.deps, f.intent.requestId, 'unknown');
    expect(f.ledger.addJobAmendment({ jobId: f.intent.jobId, body: 'Approved new scope.', supersedes: [], approval: { by: 'owner', reference: 'GH-286' },
      effect: 'material', expectedContractSha256: f.identity.contractSha256 }).status).toBe('accepted');
    f.ledger.setJobStatus(f.intent.jobId, 'parked'); f.ledger.setJobStatus(f.intent.jobId, 'working');
    const suspended = f.ledger.listObligations({ jobId: f.intent.jobId }).find((row) => row.incidentKey === `directive-recovery:${f.intent.requestId}`)!;
    expect(suspended.state).toBe('suspended');
    const debt = f.ledger.resumeObligation(suspended.id, 'explicit chief resume after the owner unparked the lane');
    expect(debt.state).toBe('open');
    const current = f.ledger.directiveCurrentAuthority(f.intent.jobId);
    const before = f.ledger.latestEventSeq();
    expect(() => recoverInterruptedDirectiveFromRoute({ ...f.deps, requestId: f.intent.requestId, generation: debt.generation,
      expectedPayloadHash: f.intent.payloadHash, expectedHead: resolveGitCommit(f.lane.path, 'HEAD'), expectedEpoch: current.authorityEpoch,
      expectedWorkRevision: current.workRevision, expectedContractSha256: current.contractSha256, reason: 'cannot reuse a revoked control epoch',
      decision: { kind: 'successor', requestId: 'forbidden-after-hold', directive: 'old scope' } })).toThrow(/authority change/);
    expect(f.ledger.latestEventSeq()).toBe(before); expect(f.ledger.getDirective('forbidden-after-hold')).toBeNull();
  });

  it('changed native tool authority refuses continuation before any new native command', async () => {
    const f = await fixture(); f.seed(); f.manifest('changed native role/cwd/tool/model authority');
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
    expect(f.native.continuations).toBe(0); expect(f.native.prompts).toEqual([]);
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
  });

  it('an already-started successor with no native association is unknown, never redispatched', async () => {
    const f = await fixture(); surfaceDirectiveRecovery(f.deps, f.intent.requestId, 'unknown original');
    const debt = f.ledger.listObligations({ jobId: f.intent.jobId })[0]!;
    const result = recoverInterruptedDirectiveFromRoute({ ...f.deps, requestId: f.intent.requestId, generation: debt.generation,
      expectedPayloadHash: f.intent.payloadHash, expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId), expectedWorkRevision: f.ledger.directiveCurrentAuthority(f.intent.jobId).workRevision, expectedContractSha256: f.ledger.directiveCurrentAuthority(f.intent.jobId).contractSha256, expectedHead: resolveGitCommit(f.lane.path, 'HEAD'), reason: 'explicit fresh follow-through',
      decision: { kind: 'successor', requestId: 'attempted-successor', directive: 'inspect preserved artifacts' } });
    expect(f.ledger.claimDirectiveDispatch(result.successor!.requestId)).toBe(true);
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
    expect(f.native.prompts).toEqual([]); expect(f.spawns).toEqual([]);
    expect(f.ledger.getDirective(result.successor!.requestId)?.state).toBe('dispatching');
    expect(f.ledger.getObligation(debt.id)?.state).toBe('open');
  });

  it('historical rebrief restart/refusal preserves marker history and never replays or creates a fresh session', async () => {
    const f = await fixture(); f.ledger.failDirective({ requestId: f.intent.requestId, reason: 'fixture original request never sent' });
    const markers = f.ledger.beginPendingRebrief({ jobId: f.intent.jobId, note: 'legacy interrupted rebrief', briefing: 'historic contract' });
    const deps = { ...f.deps, stopSignal: f.stop.signal };
    await reconcilePendingRebriefs(deps, { limit: 100 });
    await reconcilePendingRebriefs(deps, { limit: 100 });
    expect(f.spawns).toEqual([]); expect(f.native.prompts).toEqual([]);
    expect(f.ledger.listPendingRebriefs()).toEqual(markers);
    expect(f.ledger.listObligations({ jobId: f.intent.jobId }).filter((row) => row.incidentKey.startsWith('rebrief-recovery:'))).toHaveLength(1);
  });

  it('/recover refuses a successor while a queued worker for the job or its agent waits: nothing retired, decided or created (#363 S06-2-01)', async () => {
    const queuedGate = (entryId: string) => ({ view: () => ({ worker: { queued: [{ id: entryId, label: `queued ${entryId}` }] } }) }) as never;
    // Directive recovery: a queued job-ID entry, then a queued agent-ID entry.
    for (const entryId of ['job', 'agent'] as const) {
      const f = await fixture();
      const debt = f.ledger.openDirectiveRecoveryDebt(f.intent.requestId, 'predecessor handoff requires a decision');
      const head = resolveGitCommit(f.lane.path, 'HEAD'); const authority = f.ledger.directiveCurrentAuthority(f.intent.jobId);
      const watermark = f.ledger.latestEventSeq(); const before = f.ledger.getDirective(f.intent.requestId);
      const queuedId = entryId === 'job' ? f.intent.jobId : FIXTURE_MINION;
      let refusal: unknown = null;
      try {
        recoverInterruptedDirectiveFromRoute({ ...f.deps, workerGate: queuedGate(queuedId), requestId: f.intent.requestId, generation: debt.generation,
          expectedPayloadHash: f.intent.payloadHash, expectedHead: head, expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId),
          expectedWorkRevision: authority.workRevision, expectedContractSha256: authority.contractSha256, reason: 'fresh approved successor',
          decision: { kind: 'successor', requestId: `queued-successor-${entryId}`, directive: 'approved correction' } });
      } catch (error) { refusal = error; }
      expect(refusal, entryId).toBeInstanceOf(DirectiveRetirementError);
      expect(String((refusal as Error).message), entryId).toMatch(/recovery successor refused/u);
      expect(f.ledger.latestEventSeq(), entryId).toBe(watermark);
      expect(f.ledger.getDirective(f.intent.requestId), entryId).toEqual(before);
      expect(f.ledger.getDirective(`queued-successor-${entryId}`), entryId).toBeNull();
      expect(f.ledger.recoveryDecisionHistory('directive', f.intent.requestId), entryId).toEqual([]);
    }
    // Historical rebrief recovery: the same fence for a queued job-ID and agent-ID entry, markers untouched.
    for (const entryId of ['job', 'agent'] as const) {
    const f = await fixture(); f.ledger.failDirective({ requestId: f.intent.requestId, reason: 'fixture no-effect' });
    f.ledger.beginPendingRebrief({ jobId: f.intent.jobId, note: 'legacy', briefing: 'original contract' });
    await bindOriginalRebriefSdkOwner(f.ledger, f.ledger.listPendingRebriefs(), { cwd: f.lane.path, dataDir: f.dir, agentId: 'logical-minion', sessionFile: f.file });
    const markers = f.ledger.listPendingRebriefs(); const marker = markers.find((row) => row.kind === 'silas.rebrief')!;
    const debt = f.ledger.openRebriefRecoveryDebt(marker.id, 'unknown native effects');
    const authority = f.ledger.directiveCurrentAuthority(f.intent.jobId);
    const queuedId = entryId === 'job' ? f.intent.jobId : FIXTURE_MINION;
    let refusal: unknown = null;
    try {
      recoverInterruptedRebriefFromRoute({ ...f.deps, workerGate: queuedGate(queuedId), markerId: marker.id, generation: debt.generation,
        expectedPayloadHash: marker.payloadHash, expectedReceiptEvidenceSha256: f.ledger.rebriefReceiptEvidence(marker.id).sha256,
        expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId), expectedWorkRevision: authority.workRevision, expectedContractSha256: authority.contractSha256,
        expectedHead: resolveGitCommit(f.lane.path, 'HEAD'), reason: 'finish under fresh authority',
        decision: { kind: 'successor', requestId: `queued-marker-successor-${entryId}`, directive: 'finish' } });
    } catch (error) { refusal = error; }
    // Refused by the queued entry itself: it is the one blocker named.
    expect(refusal, entryId).toBeInstanceOf(DirectiveRetirementError);
    expect(String((refusal as Error).message), entryId).toMatch(/requires proven producer cessation/u);
    expect((refusal as DirectiveRetirementError).blockers, entryId).toEqual([`queued ${queuedId}`]);
    expect(f.ledger.listPendingRebriefs(), entryId).toEqual(markers);
    expect(f.ledger.getDirective(`queued-marker-successor-${entryId}`), entryId).toBeNull();
    expect(f.ledger.getRebriefRecoveryDecision(marker.id, debt.generation), entryId).toBeNull();
    }
  });

  it('historical marker successor is exact-generation guarded and hands off actual authority once', async () => {
    const f = await fixture(); f.ledger.failDirective({ requestId: f.intent.requestId, reason: 'fixture no-effect' });
    f.ledger.beginPendingRebrief({ jobId: f.intent.jobId, note: 'legacy', briefing: 'original contract' });
    const markers = f.ledger.listPendingRebriefs();
    await bindOriginalRebriefSdkOwner(f.ledger, markers, { cwd: f.lane.path, dataDir: f.dir, agentId: 'logical-minion', sessionFile: f.file });
    const boundMarkers = f.ledger.listPendingRebriefs();
    const marker = boundMarkers.find((row) => row.kind === 'silas.rebrief')!;
    const debt = f.ledger.openRebriefRecoveryDebt(marker.id, 'unknown native effects');
    const input = { ...f.deps, markerId: marker.id, generation: debt.generation, expectedPayloadHash: marker.payloadHash,
      expectedReceiptEvidenceSha256: f.ledger.rebriefReceiptEvidence(marker.id).sha256,
      expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId), expectedWorkRevision: f.ledger.directiveCurrentAuthority(f.intent.jobId).workRevision, expectedContractSha256: f.ledger.directiveCurrentAuthority(f.intent.jobId).contractSha256, expectedHead: resolveGitCommit(f.lane.path, 'HEAD'), reason: 'inspect preserved artifacts and finish under fresh authority',
      decision: { kind: 'successor' as const, requestId: 'marker-successor', directive: 'finish approved historical contract' } };
    expect(() => recoverInterruptedRebriefFromRoute({ ...input, generation: 999 })).toThrow(/stale/);
    expect(f.ledger.listPendingRebriefs()).toEqual(boundMarkers);
    const accepted = recoverInterruptedRebriefFromRoute(input);
    expect(f.ledger.listPendingRebriefs()).toEqual([]);
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'silas.rebrief-retired')?.payload).toMatchObject({ markers: boundMarkers });
    expect(recoverInterruptedRebriefFromRoute(input).idempotent).toBe(true);
    await executeAcceptedDirective(f.deps, accepted.successor!.requestId);
    expect(f.native.prompts).toHaveLength(1); expect(f.ledger.getObligation(debt.id)?.state).toBe('settled');
  });
  it('lone exact legacy delivery stays partial immutable history; fresh evidence-fenced judgment executes only a distinct successor', async () => {
    const f = await fixture(); f.ledger.failDirective({ requestId: f.intent.requestId, reason: 'fixture never dispatched' });
    f.ledger.beginPendingRebrief({ jobId: f.intent.jobId, note: 'legacy partial delivery', briefing: 'original contract' });
    await bindOriginalRebriefSdkOwner(f.ledger, f.ledger.listPendingRebriefs(), { cwd: f.lane.path, dataDir: f.dir, agentId: 'logical-minion', sessionFile: f.file });
    const markers = f.ledger.listPendingRebriefs(); const marker = markers.find((row) => row.kind === 'silas.rebrief')!;
    const delivery = markers.find((row) => row.kind === 'job.delivered')!;
    const receipt = f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: marker.jobId, agentId: 'logical-minion', payload: {
      marker_id: delivery.id, payload_hash: delivery.payloadHash, agentId: 'logical-minion', work_revision: delivery.workRevision, source: 'silas-rebrief', sha: resolveGitCommit(f.lane.path, 'HEAD') } });
    const before = f.ledger.rebriefReceiptEvidence(marker.id);
    expect(before.receipts).toMatchObject([{ seq: receipt.seq, classification: 'accepted' }]);
    const debt = f.ledger.openRebriefRecoveryDebt(marker.id, 'partial evidence needs actual judgment');
    const authority = f.ledger.directiveCurrentAuthority(marker.jobId);
    const input = { ...f.deps, markerId: marker.id, generation: debt.generation, expectedPayloadHash: marker.payloadHash,
      expectedReceiptEvidenceSha256: before.sha256, expectedEpoch: authority.authorityEpoch, expectedWorkRevision: authority.workRevision,
      expectedContractSha256: authority.contractSha256, expectedHead: resolveGitCommit(f.lane.path, 'HEAD'),
      reason: 'inspect existing effects and separately finish current approved scope', decision: { kind: 'successor' as const, requestId: 'partial-successor', directive: 'inspect existing artifacts; finish only remaining approved work' } };
    f.ledger.addJob({ id: 'unrelated-receipt', repo: 'fixture', title: 'other' });
    f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: 'unrelated-receipt', payload: { marker_id: marker.id } });
    f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: marker.jobId, payload: { marker_id: 'different-generation', payload_hash: 'different' } });
    expect(f.ledger.rebriefReceiptEvidence(marker.id).sha256).toBe(before.sha256);
    const unproven = f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: marker.jobId,
      payload: { marker_id: delivery.id, payload_hash: 'wrong-hash', agentId: 'logical-minion', work_revision: delivery.workRevision } });
    expect(() => recoverInterruptedRebriefFromRoute(input)).toThrow(/receipt evidence changed/);
    expect(f.ledger.listPendingRebriefs()).toEqual(markers); expect(f.ledger.getDirective('partial-successor')).toBeNull();
    const fresh = f.ledger.rebriefReceiptEvidence(marker.id);
    expect(fresh.receipts).toMatchObject([{ seq: receipt.seq, classification: 'accepted' }, { seq: unproven.seq, classification: 'unproven' }]);
    const judged = recoverInterruptedRebriefFromRoute({ ...input, expectedReceiptEvidenceSha256: fresh.sha256 });
    expect(f.ledger.latestJobEvent(marker.jobId, 'silas.rebrief')?.seq).toBeUndefined();
    expect(f.ledger.latestJobEvent(marker.jobId, 'silas.rebrief-recovery-decided')?.payload).toMatchObject({ receipt_evidence: fresh });
    expect(f.ledger.getObligation(debt.id)?.state).toBe('open');
    await executeAcceptedDirective(f.deps, judged.successor!.requestId);
    expect(f.native.prompts).toHaveLength(1); expect(f.ledger.getObligation(debt.id)?.state).toBe('settled');
    expect(f.ledger.getEvent(receipt.seq)?.payload).toEqual(receipt.payload);
  });

  it('late genuine legacy completion wins over judgment and never retires or executes the original generation', async () => {
    const f = await fixture(); f.ledger.failDirective({ requestId: f.intent.requestId, reason: 'fixture never dispatched' });
    f.ledger.beginPendingRebrief({ jobId: f.intent.jobId, note: 'late original', briefing: 'contract' });
    await bindOriginalRebriefSdkOwner(f.ledger, f.ledger.listPendingRebriefs(), { cwd: f.lane.path, dataDir: f.dir, agentId: 'logical-minion', sessionFile: f.file });
    const markers = f.ledger.listPendingRebriefs(); const marker = markers.find((row) => row.kind === 'silas.rebrief')!;
    const debt = f.ledger.openRebriefRecoveryDebt(marker.id, 'no receipt yet'); const authority = f.ledger.directiveCurrentAuthority(marker.jobId);
    const input = { ...f.deps, markerId: marker.id, generation: debt.generation, expectedPayloadHash: marker.payloadHash,
      expectedReceiptEvidenceSha256: f.ledger.rebriefReceiptEvidence(marker.id).sha256, expectedEpoch: authority.authorityEpoch,
      expectedWorkRevision: authority.workRevision, expectedContractSha256: authority.contractSha256, expectedHead: resolveGitCommit(f.lane.path, 'HEAD'),
      reason: 'remaining work', decision: { kind: 'successor' as const, requestId: 'never-created', directive: 'never replay completed original' } };
    for (const row of markers) f.ledger.appendCustomEvent({ kind: row.kind, jobId: row.jobId, agentId: 'logical-minion',
      payload: { marker_id: row.id, payload_hash: row.payloadHash, work_revision: row.workRevision, minion_id: 'logical-minion', agentId: 'logical-minion', sha: resolveGitCommit(f.lane.path, 'HEAD') } });
    expect(() => recoverInterruptedRebriefFromRoute(input)).toThrow(/receipt evidence changed/);
    expect(() => recoverInterruptedRebriefFromRoute({ ...input, expectedReceiptEvidenceSha256: f.ledger.rebriefReceiptEvidence(marker.id).sha256 })).toThrow(/settlement owns it/);
    const observed = await reconcilePendingRebriefs(f.deps, { limit: 100 }); await observed.settled;
    expect(observed).toMatchObject({ completed: 1, redispatched: 0, retired: 0 });
    expect(f.native.prompts).toEqual([]); expect(f.spawns).toEqual([]);
    expect(f.ledger.latestJobEvent(marker.jobId, 'silas.rebrief-retired')).toBeNull();
  });

  it('owner transfer rejects foreign, generic, unknown, Gru and limited holds instead of manufacturing ownership', async () => {
    const f = await fixture(); const debt = f.ledger.openDirectiveRecoveryDebt(f.intent.requestId, 'unknown original');
    f.ledger.addJob({ id: 'foreign-owner-job', repo: 'fixture', title: 'foreign' });
    const variants = [
      { jobId: 'foreign-owner-job', logicalStep: 'operation', category: { kind: 'known' as const, category: 'owner-hold' as const }, nextAction: { kind: 'owner-decision' as const, decision: 'foreign' } },
      { jobId: f.intent.jobId, logicalStep: 'operation', category: { kind: 'unknown' as const }, nextAction: { kind: 'owner-decision' as const, decision: 'generic unknown' } },
      { jobId: f.intent.jobId, logicalStep: 'operation', category: { kind: 'known' as const, category: 'restart-recovery' as const }, nextAction: { kind: 'owner-decision' as const, decision: 'generic known' } },
      { jobId: f.intent.jobId, logicalStep: 'operation', category: { kind: 'known' as const, category: 'owner-hold' as const }, nextAction: { kind: 'gru-decision' as const, decision: 'Gru is not owner' } },
      { jobId: f.intent.jobId, logicalStep: 'review', category: { kind: 'known' as const, category: 'owner-hold' as const }, nextAction: { kind: 'owner-decision' as const, decision: 'limited review owner scope' } },
    ] as const;
    for (const [i, variant] of variants.entries()) {
      const target = f.ledger.recordBlockedObservation(variant.jobId, { logicalStep: variant.logicalStep, incidentKey: `unqualified-${i}`,
        category: variant.category, nextAction: variant.nextAction, observedAtSeq: f.ledger.latestEventSeq() });
      expect(() => recoverInterruptedDirectiveFromRoute({ ...f.deps, requestId: f.intent.requestId, generation: debt.generation,
        expectedPayloadHash: f.intent.payloadHash, expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId), expectedHead: resolveGitCommit(f.lane.path, 'HEAD'),
        reason: 'must not manufacture exact reserved owner context', decision: { kind: 'owner-decision', obligationId: target.id } })).toThrow(/real live job-wide/);
      expect(f.ledger.getObligation(target.id)?.state).toBe('open');
    }
    expect(f.ledger.recoveryDecisionHistory('directive', f.intent.requestId)).toEqual([]); expect(f.ledger.getObligation(debt.id)?.state).toBe('open');
    expect(f.spawns).toEqual([]); expect(f.native.prompts).toEqual([]);
  });

});

it('P27 existing exact original delivery settles bookkeeping after material authority changes without reviving work', async () => {
  const f = await fixture(); f.seed(); f.native.append({ role: 'assistant', stopReason: 'stop', content: [] });
  const admitted = inspectDirectiveCheckpoint(f.file, f.identity);
  if (admitted.state !== 'terminal' || !admitted.ok) throw new Error('P27 requires successful original native completion');
  recordDirectiveCompletion(inspectDirectiveProducers(f.file, f.identity).at(-1)!.producer, admitted.checkpointId, resolveGitCommit(f.lane.path, 'HEAD'));
  f.ledger.bindDirectiveNativeAdmission(admitted.binding);
  const delivered = f.ledger.appendCustomEvent({ kind: 'job.delivered', jobId: f.intent.jobId, agentId: 'logical-minion',
    payload: { ...originalDeliveryPayload(f), candidate_delivery_proven: true } });
  f.ledger.addJobAmendment({ jobId: f.intent.jobId, body: 'new approved requirement after original completion', supersedes: [],
    approval: { by: 'owner', reference: 'P27' }, effect: 'material', expectedContractSha256: f.identity.contractSha256 });
  f.ledger.setJobStatus(f.intent.jobId, 'parked');
  const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
  expect(f.ledger.getDirective(f.intent.requestId)).toMatchObject({ state: 'settled', workRevision: 0, deliverySeq: delivered.seq });
  expect(f.ledger.getJob(f.intent.jobId)?.status).toBe('parked'); expect(f.spawns).toEqual([]); expect(f.native.prompts).toEqual([]);
  expect(f.ledger.getEvent(delivered.seq)?.payload).toEqual(delivered.payload); await service.dispose();
});

it('R13 live successor ownership refuses a replacement legacy generation before a newer routine card can exist', async () => {
  const f = await fixture(); f.ledger.failDirective({ requestId: f.intent.requestId, reason: 'original modern intent never dispatched' });
  const original = f.ledger.beginPendingRebrief({ jobId: f.intent.jobId, note: 'original legacy request', briefing: 'original contract' });
  await bindOriginalRebriefSdkOwner(f.ledger, original, { cwd: f.lane.path, dataDir: f.dir, agentId: 'logical-minion', sessionFile: f.file });
  await reconcilePendingRebriefs(f.deps);
  const marker = f.ledger.listPendingRebriefs().find((row) => row.kind === 'silas.rebrief')!;
  const debt = f.ledger.listObligations({ jobId: marker.jobId }).find((row) => row.incidentKey === `rebrief-recovery:${marker.id}`)!;
  const originalCard = f.ledger.findNotificationByKind(`silas.rebrief-unreconciled.${marker.jobId}`, 'active')!;
  const authority = f.ledger.directiveCurrentAuthority(marker.jobId);
  const accepted = recoverInterruptedRebriefFromRoute({ ...f.deps, markerId: marker.id, generation: debt.generation,
    expectedPayloadHash: marker.payloadHash, expectedReceiptEvidenceSha256: f.ledger.rebriefReceiptEvidence(marker.id).sha256,
    expectedEpoch: authority.authorityEpoch, expectedWorkRevision: authority.workRevision, expectedContractSha256: authority.contractSha256,
    expectedHead: resolveGitCommit(f.lane.path, 'HEAD'), reason: 'original ceased; separately accept remaining current work',
    decision: { kind: 'successor', requestId: 'r13-original-successor', directive: 'inspect preserved original artifacts' } });
  const successor = accepted.successor!; const identity = f.ledger.directiveTurnIdentity(successor.requestId);
  f.ledger.prepareDirectiveTarget(successor.requestId, { agentId: 'logical-minion', sessionFile: f.file });
  const text = 'accepted original successor native user';
  const manifest = readDirectiveBinding(f.file, marker.id)!.authorityManifest;
  const header = readDirectiveSessionHeader(f.file);
  if (typeof header.id !== 'string') throw new Error('original native header must name its real session');
  prepareDirectiveBinding({ identity, runtime: 'pi', agentId: 'logical-minion', sessionId: header.id, sessionFile: f.file, text, authorityManifest: manifest });
  const watermark = f.ledger.latestEventSeq();
  expect(() => f.ledger.beginPendingRebrief({ jobId: marker.jobId, note: 'distinct newer historical generation', briefing: 'newer generation' })).toThrow(/live directive request.*owns the lane/);
  expect(f.ledger.latestEventSeq()).toBe(watermark);
  expect(f.ledger.listPendingRebriefs()).toEqual([]);
  expect(f.ledger.getNotification(originalCard.id)).toEqual(originalCard);
  expect(f.ledger.getObligation(debt.id)?.state).toBe('open');
  f.native.append({ role: 'user', content: [{ type: 'text', text }] });
  f.ledger.bindDirectiveNativeAdmission(inspectDirectiveAdmission(f.file, identity));
  expect(f.ledger.getObligation(debt.id)?.state).toBe('settled');
  expect(f.ledger.getNotification(originalCard.id)?.resolvedBy).toBe('rebrief-recovery-evidence');
  expect(f.ledger.listPendingRebriefs()).toEqual([]);
  expect(f.spawns).toEqual([]); expect(f.native.prompts).toEqual([]);
});

it('P28 actual production recovery escalation closes only its exact ordinary guarded generation and survives restart', async () => {
  const f = await fixture(); f.ledger.failDirective({ requestId: f.intent.requestId, reason: 'original native intent never dispatched' });
  const original = f.ledger.beginPendingRebrief({ jobId: f.intent.jobId, note: 'legacy pair', briefing: 'accepted historical contract' });
  await bindOriginalRebriefSdkOwner(f.ledger, original, { cwd: f.lane.path, dataDir: f.dir, agentId: 'logical-minion', sessionFile: f.file });
  const markers = f.ledger.listPendingRebriefs(); const marker = markers.find((row) => row.kind === 'silas.rebrief')!;
  const observed = await reconcilePendingRebriefs(f.deps); await observed.settled;
  const debt = f.ledger.listObligations({ jobId: marker.jobId }).find((row) => row.incidentKey === `rebrief-recovery:${marker.id}`)!;
  const action = f.ledger.findNotificationByKind(`silas.rebrief-unreconciled.${marker.jobId}`, 'active')!;
  expect(action.routing).toBe('action-required'); expect(action.detail).toContain(`/api/silas/rebriefs/${marker.id},`);
  const owner = f.notifications.postIncident({ kind: 'P28-unrelated-owner', routing: 'needs-owner', severity: 'error', title: 'separate owner stop', detail: 'do not acknowledge', dedupe: 'active' });
  const unrelated = f.ledger.recordBlockedObservation(marker.jobId, { logicalStep: 'operation', incidentKey: 'unrelated-P28', observedAtSeq: marker.baselineSeq,
    category: { kind: 'known', category: 'restart-recovery' }, nextAction: { kind: 'gru-decision', decision: 'independent task remains owed' } });
  for (const row of markers) f.ledger.appendCustomEvent({ kind: row.kind, jobId: row.jobId, agentId: 'logical-minion', payload: {
    marker_id: row.id, payload_hash: row.payloadHash, agentId: 'logical-minion', minion_id: 'logical-minion', work_revision: row.workRevision } });
  expect(f.ledger.clearPendingRebriefsIfCurrentAndSettle(markers)).toBe(true);
  expect(f.ledger.getObligation(debt.id)?.state).toBe('settled'); expect(f.ledger.getObligation(unrelated.id)?.state).toBe('open');
  expect(f.ledger.findNotificationByKind(`silas.rebrief-unreconciled.${marker.jobId}`, 'active')).toBeNull();
  expect(f.ledger.getNotification(action.id)).toMatchObject({ ackedAt: null, resolvedBy: 'rebrief-recovery-evidence' });
  const reopenedDb = new LedgerDb(f.dir); const reopened = new LedgerApi(reopenedDb.handle);
  try {
    expect(reopened.getObligation(debt.id)?.state).toBe('settled'); expect(reopened.getNotification(action.id)?.resolvedAt).not.toBeNull();
    expect(reopened.clearPendingRebriefsIfCurrentAndSettle(markers)).toBe(false);
  } finally { reopenedDb.close(); }
  expect(f.ledger.findNotificationByKind('P28-unrelated-owner', 'active')?.id).toBe(owner.id); expect(action.id).not.toBe(owner.id);
  expect(f.ledger.clearPendingRebriefsIfCurrentAndSettle(markers)).toBe(false); expect(f.ledger.listJobEventsByKinds(marker.jobId, ['silas.rebrief-settled'])).toHaveLength(1);
});

it('P29 an idle historical logical minion and absent producer journal never prove physical cessation', async () => {
  const f = await fixture(); f.ledger.failDirective({ requestId: f.intent.requestId, reason: 'not dispatched' });
  const markers = f.ledger.beginPendingRebrief({ jobId: f.intent.jobId, note: 'unproven legacy original', briefing: 'original contract' });
  f.ledger.bindPendingRebriefWorker({ ids: markers.map((row) => row.id), agentId: 'logical-minion', sessionFile: f.file });
  const marker = f.ledger.listPendingRebriefs().find((row) => row.kind === 'silas.rebrief')!;
  expect(f.ledger.rebriefProgressBlockers(marker.id, f.lane.id)).toContain('original historical native physical cessation remains UNKNOWN');
  expect(f.ledger.listPendingRebriefs()).toHaveLength(2); expect(f.spawns).toEqual([]);
});

it('P31 old phase completion may omit revision but a historical delivery may not', async () => {
  const f = await fixture(); f.ledger.failDirective({ requestId: f.intent.requestId, reason: 'not dispatched' });
  const markers = f.ledger.beginPendingRebrief({ jobId: f.intent.jobId, note: 'old phase', briefing: 'original contract', handoff: { kind: 'gru-decision', decision: 'finish original phase' } });
  f.ledger.bindPendingRebriefWorker({ ids: markers.map((row) => row.id), agentId: 'logical-minion', sessionFile: f.file });
  const bound = f.ledger.listPendingRebriefs();
  for (const marker of bound) f.ledger.appendCustomEvent({ kind: marker.kind, jobId: marker.jobId, agentId: 'logical-minion', payload: {
    phase_id: marker.phaseId, marker_id: marker.id, payload_hash: marker.payloadHash, agentId: 'logical-minion', minion_id: 'logical-minion' } });
  expect(f.ledger.pendingRebriefReceipt(bound.find((row) => row.kind === 'silas.rebrief')!)).not.toBeNull();
  expect(f.ledger.pendingRebriefReceipt(bound.find((row) => row.kind === 'job.delivered')!)).toBeNull();
  expect(() => f.ledger.clearPendingRebriefsIfCurrentAndSettle(bound)).toThrow(/guarded event job.delivered/); expect(f.ledger.listPendingRebriefs()).toEqual(bound);
});

it('P35 a positively pre-native HEAD preparation failure leaves the original checkpoint claim unconsumed', async () => {
  const f = await fixture(); f.seed();
  const head = resolveGitCommit(f.lane.path, 'HEAD'); const gitDir = join(f.lane.path, '.git'); const gitPointer = readFileSync(gitDir, 'utf8');
  writeFileSync(gitDir, 'gitdir: /nonexistent/gh286-positively-unavailable\n');
  const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
  expect(f.ledger.getDirective(f.intent.requestId)?.recoveryCheckpoint).toBeNull(); expect(f.spawns).toEqual([]);
  writeFileSync(gitDir, gitPointer); expect(resolveGitCommit(f.lane.path, 'HEAD')).toBe(head);
  service.reconsider(); await service.settled(); expect(f.native.continuations).toBe(1); expect(f.native.prompts).toEqual([]);
  expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled'); await service.dispose();
});

it('P29 exact recorded historical ownership survives current contract changes but missing, conflicting and torn original evidence stays fenced', async () => {
  const f = await fixture(); f.ledger.failDirective({ requestId: f.intent.requestId, reason: 'never dispatched' });
  const original = f.ledger.beginPendingRebrief({ jobId: f.intent.jobId, note: 'original accepted legacy', briefing: 'original contract' });
  await bindOriginalRebriefSdkOwner(f.ledger, original, { cwd: f.lane.path, dataDir: f.dir, agentId: 'logical-minion', sessionFile: f.file });
  const marker = f.ledger.listPendingRebriefs().find((row) => row.kind === 'silas.rebrief')!;
  expect(f.ledger.rebriefProgressBlockers(marker.id, f.lane.id)).toEqual([]);
  const authority = f.ledger.directiveCurrentAuthority(marker.jobId);
  f.ledger.addJobAmendment({ jobId: marker.jobId, body: 'separately approved current scope after original physical cessation', supersedes: [],
    effect: 'material', approval: { by: 'owner', reference: 'P29 current contract' }, expectedContractSha256: authority.contractSha256 });
  expect(f.ledger.directiveCurrentAuthority(marker.jobId).contractSha256).not.toBe(authority.contractSha256);
  expect(f.ledger.rebriefProgressBlockers(marker.id, f.lane.id)).toEqual([]);
  const association = `${f.file}.directives.jsonl`; const saved = readFileSync(association, 'utf8');
  const last = JSON.parse(saved.trimEnd().split('\n').at(-1)!) as { identity: { contractSha256: string } };
  writeFileSync(association, saved + JSON.stringify({ ...last, identity: { ...last.identity, contractSha256: 'f'.repeat(64) } }) + '\n');
  expect(f.ledger.rebriefProgressBlockers(marker.id, f.lane.id).some((message) => message.includes('unreadable'))).toBe(true);
  writeFileSync(association, saved);
  const native = readFileSync(f.file, 'utf8'); appendFileSync(f.file, '{"type":"message"');
  expect(f.ledger.rebriefProgressBlockers(marker.id, f.lane.id).some((message) => message.includes('unreadable'))).toBe(true);
  writeFileSync(f.file, native);
  f.ledger.bindPendingRebriefWorker({ ids: original.map((row) => row.id), agentId: 'logical-minion', sessionFile: null });
  expect(f.ledger.rebriefProgressBlockers(marker.id, f.lane.id)).toContain('original historical native session ownership is unbound/UNKNOWN');
});

it('P28 genuine ordinary settlement rolls back debt and control together on storage failure and retries committed publication idempotently', async () => {
  const f = await fixture(); f.ledger.failDirective({ requestId: f.intent.requestId, reason: 'never dispatched' });
  const accepted = f.ledger.beginPendingRebrief({ jobId: f.intent.jobId, note: 'late pair', briefing: 'original' });
  f.ledger.bindPendingRebriefWorker({ ids: accepted.map((row) => row.id), agentId: 'logical-minion', sessionFile: f.file });
  const markers = f.ledger.listPendingRebriefs();
  const marker = markers.find((row) => row.kind === 'silas.rebrief')!; const debt = f.ledger.openRebriefRecoveryDebt(marker.id, 'old callback missing');
  for (const row of markers) f.ledger.appendCustomEvent({ kind: row.kind, jobId: row.jobId, payload: { marker_id: row.id, payload_hash: row.payloadHash, work_revision: row.workRevision, minion_id: 'logical-minion', agentId: 'logical-minion' } });
  f.db.handle.exec("CREATE TRIGGER refuse_p28_close BEFORE UPDATE ON job_obligations WHEN NEW.state = 'settled' BEGIN SELECT RAISE(FAIL, 'P28 storage closure fault'); END");
  expect(() => f.ledger.clearPendingRebriefsIfCurrentAndSettle(markers)).toThrow(/P28 storage/);
  expect(f.ledger.listPendingRebriefs()).toEqual(markers); expect(f.ledger.getObligation(debt.id)?.state).toBe('open');
  expect(f.ledger.latestJobEvent(marker.jobId, 'silas.rebrief-settled')).toBeNull(); f.db.handle.exec('DROP TRIGGER refuse_p28_close');
  const actual = f.bus.publish.bind(f.bus); const failure = vi.spyOn(f.bus, 'publish').mockImplementation((event) => { actual(event); if (event.kind === 'silas.rebrief-settled') throw new Error('P28 committed publication fault'); });
  expect(() => f.ledger.clearPendingRebriefsIfCurrentAndSettle(markers)).toThrow(/P28 committed/); failure.mockRestore();
  expect(f.ledger.listPendingRebriefs()).toEqual([]); expect(f.ledger.getObligation(debt.id)?.state).toBe('settled');
  expect(f.ledger.clearPendingRebriefsIfCurrentAndSettle(markers)).toBe(false); expect(f.ledger.listJobEventsByKinds(marker.jobId, ['silas.rebrief-settled'])).toHaveLength(1);
});

it('P28 terminal legacy cancellation closes late routine recovery debt administratively without inventing successful completion', async () => {
  const f = await fixture(); f.ledger.failDirective({ requestId: f.intent.requestId, reason: 'never dispatched' });
  const markers = f.ledger.beginPendingRebrief({ jobId: f.intent.jobId, note: 'old interrupted request', briefing: 'original' });
  markLegacyTerminalJobFixture(f.ledger, f.intent.jobId, 'binned'); const debt = f.ledger.openRebriefRecoveryDebt(markers[0]!.id, 'late recovery observation');
  expect(debt.state).toBe('open');
  const result = f.ledger.retirePendingRebriefs({ jobId: f.intent.jobId, reason: 'actual terminal job control', candidates: markers });
  expect(result.retired).toHaveLength(2); expect(f.ledger.getObligation(debt.id)?.state).toBe('settled');
  expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull(); expect(f.ledger.latestJobEvent(f.intent.jobId, 'silas.rebrief')).toBeNull();
  expect(f.ledger.getObligation(debt.id)?.settlement).toMatchObject({ kind: 'executed-action', action: 'exact terminal legacy control administratively retired, not completed' });
});

it('P28 suspended and claimed exact routine debt retains its pointer until explicit release, never expiry', async () => {
  const f = await fixture(); f.ledger.failDirective({ requestId: f.intent.requestId, reason: 'never dispatched' });
  const original = f.ledger.beginPendingRebrief({ jobId: f.intent.jobId, note: 'original', briefing: 'original accepted contract' });
  await bindOriginalRebriefSdkOwner(f.ledger, original, { cwd: f.lane.path, dataDir: f.dir, agentId: 'logical-minion', sessionFile: f.file });
  const markers = f.ledger.listPendingRebriefs(); const marker = markers.find((row) => row.kind === 'silas.rebrief')!;
  const debt = f.ledger.openRebriefRecoveryDebt(marker.id, 'old callback missing');
  for (const row of markers) f.ledger.appendCustomEvent({ kind: row.kind, jobId: row.jobId, payload: { marker_id: row.id, payload_hash: row.payloadHash, work_revision: row.workRevision,
    minion_id: row.agentId, agentId: row.agentId } });
  f.ledger.suspendObligation(debt.id, 'explicit original-context hold');
  expect(() => f.ledger.clearPendingRebriefsIfCurrentAndSettle(markers)).toThrow(/suspended or claimed/);
  f.ledger.resumeObligation(debt.id, 'explicit safe original-context release');
  f.ledger.claimObligation({ obligationId: debt.id, expectedGeneration: debt.generation, requestId: 'original-debt-owner', holder: 'gru', expiresAt: '2000-01-01T00:00:00.000Z' });
  expect(() => f.ledger.clearPendingRebriefsIfCurrentAndSettle(markers)).toThrow(/suspended or claimed/);
  expect(f.ledger.listPendingRebriefs()).toEqual(markers); expect(f.ledger.getObligation(debt.id)?.claim?.requestId).toBe('original-debt-owner');
  f.ledger.releaseClaim({ obligationId: debt.id, requestId: 'original-debt-owner' });
  expect(f.ledger.clearPendingRebriefsIfCurrentAndSettle(markers)).toBe(true); expect(f.ledger.getObligation(debt.id)?.state).toBe('settled');
});

it('P35 positively pre-native parent tool preparation failure later continues the same original checkpoint once', async () => {
  const f = await fixture(); f.seed(); let available = false;
  const service = new DirectiveProgressService({ ...f.deps, parentTools: () => { if (!available) throw new Error('original parent tools temporarily unavailable before spawn'); return []; } });
  service.reconsider(); await service.settled(); expect(f.ledger.getDirective(f.intent.requestId)?.recoveryCheckpoint).toBeNull();
  expect(f.spawns).toEqual([]); expect(f.native.continuations).toBe(0); available = true;
  service.reconsider(); await service.settled(); service.reconsider(); await service.settled();
  expect(f.native.continuations).toBe(1); expect(f.native.prompts).toEqual([]); expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled'); await service.dispose();
});

it('P35 a checkpoint continuation restores the original agent\'s nonempty parent tools, same capability and same identity (#363 S04-2-02)', async () => {
  const f = await fixture(); f.seed();
  const capability = { name: 'request_child_worker', description: 'request a child worker for the original parent', inputSchema: { type: 'object' },
    authorityManifest: 'original-parent:logical-minion', execute: async () => ({ text: 'ok' }) };
  const asked: string[] = [];
  const service = new DirectiveProgressService({ ...f.deps, parentTools: (agentId) => { asked.push(agentId); return [capability]; } });
  service.reconsider(); await service.settled(); service.reconsider(); await service.settled();
  expect(f.native.continuations).toBe(1);
  expect(asked).toEqual(['logical-minion']);
  expect(f.spawns).toHaveLength(1);
  expect(f.spawns[0]).toMatchObject({ agentId: 'logical-minion', resumeFile: f.file, nativeTools: [capability] });
  expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
  await service.dispose();
});

/** Admit the fixture job as an attested blind review; `keepPackage: false`
 * is the legacy shape, admitted before packages were kept. */
function admitFixtureAsBlind(f: Awaited<ReturnType<typeof fixture>>, keepPackage = true): void {
  const targetSha = 'f'.repeat(40);
  const inputPackage = { baseSha: 'a'.repeat(40), targetSha, files: [{ path: 'src/feature.ts', content: 'export const feature = 1;\n' }] };
  const admission = admitBlindReview({ ledger: f.ledger, jobId: f.intent.jobId, title: 'review (blind)', deliverable: 'review',
    briefing: 'Review the immutable package read-only.', targetSha, repoName: 'fixture', inputPackage });
  if (admission === null) throw new Error('the fixture job was not admitted as a blind review');
  recordBlindAdmission(f.ledger, f.intent.jobId, admission, keepPackage ? inputPackage : undefined);
}

it('P35 a blind reviewer\'s checkpoint continuation resumes with the tool set its binding recorded', async () => {
  const capability = { name: 'request_child_worker', description: 'request a child worker for the original parent', inputSchema: { type: 'object' },
    authorityManifest: 'original-parent:logical-minion', execute: async () => ({ text: 'ok' }) };
  // A session bound before tool sets were recorded had the parent tools; one
  // bound with none resumes with none.
  for (const [recorded, expected] of [[undefined, [capability]], [[], undefined]] as const) {
    const f = await fixture(); f.seed(undefined, undefined, recorded); admitFixtureAsBlind(f);
    const service = new DirectiveProgressService({ ...f.deps, parentTools: () => [capability] });
    service.reconsider(); await service.settled(); service.reconsider(); await service.settled();
    expect(f.native.continuations).toBe(1);
    expect(f.spawns).toHaveLength(1);
    expect(f.spawns[0]).toMatchObject({ agentId: 'logical-minion', resumeFile: f.file });
    expect(f.spawns[0]!.nativeTools).toEqual(expected);
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
    await service.dispose();
  }
});

it('a native directive binding records the tool set its session was spawned with', async () => {
  const capability = { name: 'request_child_worker', description: 'request a child worker for the parent', inputSchema: { type: 'object' },
    authorityManifest: 'parent:logical-minion', execute: async () => ({ text: 'ok' }) };
  for (const [blind, expected] of [[false, ['request_child_worker']], [true, []]] as const) {
    const f = await fixture('rebrief');
    if (blind) admitFixtureAsBlind(f);
    await executeAcceptedDirective({ ...f.deps, parentTools: () => [capability] }, f.intent.requestId);
    expect(f.native.prompts).toHaveLength(1);
    expect(readDirectiveBinding(f.file, f.intent.requestId)?.nativeTools).toEqual(expected);
  }
  // A recorded tool set that is not a list of names is a malformed binding.
  const malformed = await fixture(); malformed.seed(undefined, undefined, ['request_child_worker']);
  const journal = `${malformed.file}.directives.jsonl`;
  writeFileSync(journal, readFileSync(journal, 'utf-8').replace('"nativeTools":["request_child_worker"]', '"nativeTools":[7]'));
  expect(() => readDirectiveBinding(malformed.file, malformed.intent.requestId)).toThrow(/directive native association is malformed/);
});

it('a re-brief whose fresh reviewer input git cannot read stays for reconciliation', async () => {
  const f = await fixture('rebrief', true, true);
  f.ledger.appendCustomEvent({ kind: 'job.review-source-verified', jobId: f.intent.jobId, payload: {
    object_store: '/recorded/store', target_sha: resolveGitCommit(f.lane.path, 'HEAD'), target_base: null, range_commits: null, inputs: [], source: 'repository', package_sha256: null,
  } });
  rmSync(f.lane.path, { recursive: true, force: true });
  const cleared: string[] = [];
  await executeAcceptedDirective({ ...f.deps, clearLaneForWriter: async ({ writer }) => { cleared.push(writer); } }, f.intent.requestId);
  expect(cleared).toEqual([]);
  expect(f.spawns).toEqual([]);
  const row = f.ledger.getDirective(f.intent.requestId)!;
  expect(row.state).not.toBe('failed');
  expect(row.failReason).toMatch(/^reconcile: .*git cannot read lane/u);
});

it('a re-brief whose fresh reviewer input cannot be re-delivered fails by name before the lane is cleared for it', async () => {
  const f = await fixture('rebrief'); admitFixtureAsBlind(f, false);
  const cleared: string[] = [];
  await executeAcceptedDirective({ ...f.deps, clearLaneForWriter: async ({ writer }) => { cleared.push(writer); } }, f.intent.requestId);
  expect(cleared).toEqual([]);
  expect(f.spawns).toEqual([]);
  expect(f.ledger.getDirective(f.intent.requestId)).toMatchObject({ state: 'failed', failReason: expect.stringMatching(/^refused before any prompt: fresh reviewer refused before any effect: .*was not kept/u) });
});

it('a review job\'s durable re-brief gives the fresh reviewer the read-only orders', async () => {
  const f = await fixture('rebrief', true, true);
  await executeAcceptedDirective(f.deps, f.intent.requestId);
  expect(f.native.prompts).toHaveLength(1);
  expect(f.native.prompts[0]).toContain('this brief is READ-ONLY');
  expect(f.native.prompts[0]).not.toContain('commit your work to the branch');
});

async function assertLateTerminalRecoveryHold(mode: 'suspended' | 'claimed'): Promise<void> {
  const f = await fixture(); f.ledger.failDirective({ requestId: f.intent.requestId, reason: 'never dispatched' });
  const markers = f.ledger.beginPendingRebrief({ jobId: f.intent.jobId, note: 'old interrupted request', briefing: 'original' });
  markLegacyTerminalJobFixture(f.ledger, f.intent.jobId, 'binned');
  const debt = f.ledger.openRebriefRecoveryDebt(markers[0]!.id, 'late terminal original context');
  const retire = (ledger: LedgerApi) => ledger.retirePendingRebriefs({ jobId: f.intent.jobId, reason: 'actual terminal administrative cancellation', candidates: markers });
  if (mode === 'suspended') f.ledger.suspendObligation(debt.id, 'original context remains held');
  else f.ledger.claimObligation({ obligationId: debt.id, expectedGeneration: debt.generation, requestId: 'late-terminal-holder', holder: 'gru', expiresAt: '2000-01-01T00:00:00.000Z' });
  for (let i = 0; i < 2; i += 1) {
    const db = new LedgerDb(f.dir); const ledger = new LedgerApi(db.handle);
    try {
      expect(() => retire(ledger)).toThrow(mode === 'suspended' ? /suspended or claimed/ : /suspended or claimed|is held by request late-terminal-holder/);
      expect(ledger.listPendingRebriefs()).toEqual(markers);
      expect(ledger.getObligation(debt.id)?.state).toBe(mode === 'suspended' ? 'suspended' : 'open');
      if (mode === 'claimed') expect(ledger.getObligation(debt.id)?.claim?.requestId).toBe('late-terminal-holder');
      expect(ledger.latestJobEvent(f.intent.jobId, 'silas.rebrief-retired')).toBeNull();
    } finally { db.close(); }
  }
  if (mode === 'suspended') f.ledger.resumeObligation(debt.id, 'explicit original suspension release');
  else f.ledger.releaseClaim({ obligationId: debt.id, requestId: 'late-terminal-holder' });
  expect(retire(f.ledger).retired).toHaveLength(2); expect(f.ledger.getObligation(debt.id)?.state).toBe('settled');
  expect(retire(f.ledger).retired).toEqual([]); expect(f.ledger.listJobEventsByKinds(f.intent.jobId, ['silas.rebrief-retired'])).toHaveLength(1);
  expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull(); expect(f.ledger.latestJobEvent(f.intent.jobId, 'silas.rebrief')).toBeNull();
}
it('P28 terminal late suspended recovery debt retains exact pointers across restart until explicit release', () => assertLateTerminalRecoveryHold('suspended'));
it('P28 terminal late expired claimed recovery debt retains exact pointers across restart until explicit release', () => assertLateTerminalRecoveryHold('claimed'));

it('P28 production job incident from a different rebrief generation remains active when older exact routine debt closes', async () => {
  const f = await fixture(); f.ledger.failDirective({ requestId: f.intent.requestId, reason: 'never dispatched' });
  const original = f.ledger.beginPendingRebrief({ jobId: f.intent.jobId, note: 'old original', briefing: 'old original' });
  await bindOriginalRebriefSdkOwner(f.ledger, original, { cwd: f.lane.path, dataDir: f.dir, agentId: 'logical-minion', sessionFile: f.file });
  const markers = f.ledger.listPendingRebriefs(); const marker = markers.find((row) => row.kind === 'silas.rebrief')!;
  const debt = f.ledger.openRebriefRecoveryDebt(marker.id, 'old original observation');
  const originalRows = f.db.handle.prepare('SELECT * FROM pending_rebriefs').all() as Record<string, string | number | null>[];
  // Capture a different generation's card from the real producer, not a hand-written incident.
  f.ledger.clearPendingRebriefs(markers.map((row) => row.id));
  const newer = f.ledger.beginPendingRebrief({ jobId: f.intent.jobId, note: 'newer request', briefing: 'newer contract' });
  await reconcilePendingRebriefs(f.deps);
  const card = f.ledger.findNotificationByKind(`silas.rebrief-unreconciled.${marker.jobId}`, 'active')!;
  expect(card.detail).toContain(`/api/silas/rebriefs/${newer.find((row) => row.kind === 'silas.rebrief')!.id},`);
  // Restore the examined old rows solely to exercise the exact closure boundary
  // with a production newer-generation reservation; receipt truth remains real ledger events.
  f.ledger.clearPendingRebriefs(newer.map((row) => row.id));
  for (const row of originalRows) f.db.handle.prepare(`INSERT INTO pending_rebriefs (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  for (const row of markers) f.ledger.appendCustomEvent({ kind: row.kind, jobId: row.jobId, agentId: row.agentId, payload: {
    marker_id: row.id, payload_hash: row.payloadHash, minion_id: row.agentId, agentId: row.agentId, work_revision: row.workRevision } });
  expect(f.ledger.clearPendingRebriefsIfCurrentAndSettle(markers)).toBe(true); expect(f.ledger.getObligation(debt.id)?.state).toBe('settled');
  expect(f.ledger.getNotification(card.id)).toEqual(card);
});

describe('directive routing to a claude-code minion whose session cannot attest admission (no GC session header, #424)', () => {
  async function assertClaudeMinionRefusal(route: 'resident' | 'respawned', kind: 'directive' | 'rebrief' = 'directive') {
    const f = await fixture(kind);
    // Real claude-code transcripts are raw stream-json frames, never a pi
    // header; with user hooks the first frame carries no cwd at all.
    const first = route === 'resident'
      ? { type: 'system', subtype: 'init', session_id: 'claude-session', cwd: f.lane.path }
      : { type: 'system', subtype: 'hook_started', session_id: 'claude-session' };
    writeFileSync(f.file, `${JSON.stringify(first)}\n`);
    let live: AgentHandle | null = null;
    const claudeHandle = (): AgentHandle => {
      f.store.acquireLock(f.file);
      live = new ClaudeCodeHandle('minion', {
        sessionId: 'claude-session', sessionFile: f.file, cwd: f.lane.path, binary: 'claude-must-never-run',
        spawnProcess: (() => { throw new Error('no native claude turn may start'); }) as unknown as typeof spawn,
        tools: ['Read', 'Bash'], systemPrompt: 'minion', killGraceMs: 10, resume: true,
      }, CLAUDE_CODE_CAPABILITIES, f.store, () => {}, () => { live = null; }, () => {}, 60_000, 'logical-minion');
      return live;
    };
    if (route === 'resident') claudeHandle();
    let spawned = 0;
    const registry: DirectiveRegistry = {
      getHandle: () => live,
      async spawn() { spawned += 1; return claudeHandle(); },
      async disposeHandle(target) { await target.dispose(); },
    };
    const deps = { ...f.deps, registry };
    await executeAcceptedDirective(deps, f.intent.requestId);
    const service = new DirectiveProgressService(deps);
    try { service.reconsider(); await service.settled(); service.reconsider(); await service.settled(); }
    finally { await service.dispose(); }
    const row = f.ledger.getDirective(f.intent.requestId);
    expect(row).toMatchObject({ state: 'failed', nativeTarget: null });
    expect(row?.failReason).toMatch(/claude-code/);
    expect(f.ledger.hasDirectiveDispatchDeferral(f.intent.requestId)).toBe(false);
    expect(f.ledger.listObligations({ jobId: f.intent.jobId }).filter((item) => item.state === 'open')).toEqual([]);
    expect(() => f.ledger.assertRecoveryJobPermission(f.intent.jobId)).not.toThrow();
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
    expect(f.ledger.listPendingRebriefs({ jobId: f.intent.jobId })).toEqual([]);
    // A re-brief always starts a fresh session (the resident one is retired
    // first); a directive reuses the resident. Never a retry loop either way.
    expect(spawned).toBe(route === 'resident' && kind === 'directive' ? 0 : 1);
    expect(live).toBeNull(); // the prepared/spawned session was disposed
  }
  it('a resident claude-code minion refuses the directive as a positive no-effect failure — never a bound target or owner-only stop', () =>
    assertClaudeMinionRefusal('resident'));
  it('a respawned claude-code minion refuses before the pi session-header read — never a deferral loop or recovery debt', () =>
    assertClaudeMinionRefusal('respawned'));
  it('a re-brief to a resident claude-code minion fails cleanly as a positive no-effect', () =>
    assertClaudeMinionRefusal('resident', 'rebrief'));
  it('a re-brief to a respawned claude-code minion fails cleanly as a positive no-effect', () =>
    assertClaudeMinionRefusal('respawned', 'rebrief'));

  it('a refusal whose cleanup fails is never claimed as a no-effect: it stays live for reconcile and recovery', async () => {
    const f = await fixture();
    writeFileSync(f.file, `${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-session', cwd: f.lane.path })}\n`);
    f.store.acquireLock(f.file);
    const live: AgentHandle = new ClaudeCodeHandle('minion', {
      sessionId: 'claude-session', sessionFile: f.file, cwd: f.lane.path, binary: 'claude-must-never-run',
      spawnProcess: (() => { throw new Error('no native claude turn may start'); }) as unknown as typeof spawn,
      tools: ['Read', 'Bash'], systemPrompt: 'minion', killGraceMs: 10, resume: true,
    }, CLAUDE_CODE_CAPABILITIES, f.store, () => {}, () => {}, () => {}, 60_000, 'logical-minion');
    const registry: DirectiveRegistry = {
      getHandle: () => live,
      async spawn() { throw new Error('a refused runtime must not spawn a replacement'); },
      async disposeHandle() { throw new Error('fixture cleanup failure'); },
    };
    await executeAcceptedDirective({ ...f.deps, registry }, f.intent.requestId);
    const row = f.ledger.getDirective(f.intent.requestId);
    expect(row?.state).not.toBe('failed');
    expect(row?.failReason).toMatch(/^reconcile: .*claude-code.*fixture cleanup failure/s);
    expect(f.ledger.listObligations({ jobId: f.intent.jobId }).some((item) =>
      item.incidentKey === `directive-recovery:${f.intent.requestId}` && item.state === 'open')).toBe(true);
    await live.dispose();
  });
});
