import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerDb } from '../src/ledger/db.js';
import { LedgerApi } from '../src/ledger/api.js';
import { EventBus } from '../src/events/bus.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { SessionStore } from '../src/sessions/store.js';
import { PiAgentHandle, PI_CAPABILITIES } from '../src/runtime/pi-adapter.js';
import { inspectDirectiveCheckpoint, inspectDirectiveProducers, prepareDirectiveBinding, prepareDirectiveProducer, recordDirectiveProducerCessation, readDirectiveBinding } from '../src/runtime/directive-checkpoint.js';
import { DirectiveProgressService, executeAcceptedDirective, settleNativeDirective, surfaceDirectiveRecovery } from '../src/dispatch/directive-progress.js';
import { recoverInterruptedDirectiveFromRoute, recoverInterruptedRebriefFromRoute } from '../src/dispatch/directive-recovery.js';
import { reconcilePendingRebriefs } from '../src/dispatch/rebrief-recovery.js';
import type { AgentHandle, SpawnOptions } from '../src/runtime/types.js';
import type { DirectiveRegistry } from '../src/dispatch/fix-directive.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';
import { makeFixtureRepo } from './helpers/fixture-repo.js';
import { resolveGitCommit } from '../src/dispatch/perkins-review/artifacts.js';
import { PacingGate } from '../src/runtime/pacing.js';

const cleanups: (() => void)[] = [];
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
  constructor(file: string, sessionId = 'native-session') {
    this.sessionFile = file;
    this.sessionId = sessionId;
    if (readFileSync(file, 'utf8') === '') writeFileSync(file, `${JSON.stringify({ type: 'session', id: sessionId, version: 3 })}\n`);
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

async function fixture(kind: 'directive' | 'rebrief' = 'directive') {
  const dir = mkdtempSync(join(tmpdir(), 'gru-restart-progress-'));
  const repo = makeFixtureRepo('restart-progress');
  const db = new LedgerDb(dir);
  const bus = new EventBus({});
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  const worktrees = new InMemoryWorktreePort(join(dir, 'lanes'));
  const store = new SessionStore(dir);
  ledger.addJob({ id: 'approved-job', repo: 'fixture', title: 'approved', briefing: 'approved original contract' });
  ledger.setJobStatus('approved-job', 'working');
  ledger.setJobPr('approved-job', 'https://example.test/pull/286');
  const lane = await worktrees.createJobWorktree({ repoPath: repo.path, jobId: 'approved-job' });
  const file = join(store.sessionsDir, 'minion', 'native.jsonl');
  mkdirSync(join(store.sessionsDir, 'minion'), { recursive: true });
  writeFileSync(file, '');
  const native = new NativeFixture(file);
  ledger.registerAgent({ id: 'logical-minion', role: 'minion', jobId: 'approved-job', sessionFile: file, parentage: 'top-level' });
  ledger.setAgentState('logical-minion', 'idle');
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
      handle = new PiAgentHandle('minion', native, file, PI_CAPABILITIES, false, [], store, () => {}, () => { handle = null; }, 60_000, options.agentId ?? 'logical-minion', () => manifest);
      handle.subscribe((event) => { if (event.type === 'state' && ledger.getAgent(handle!.id) !== null) ledger.setAgentState(handle!.id, event.state); });
      return handle;
    },
    async disposeHandle(target) { await target.dispose(); },
  };
  const stop = new AbortController();
  let supervised: readonly string[] = [];
  const deps = { ledger, registry, worktrees, notifications, signal: stop.signal, pendingProducerBlockers: () => supervised };
  const seed = (text = 'accepted native prompt') => {
    ledger.prepareDirectiveTarget(intent.requestId, { agentId: 'logical-minion', sessionFile: file });
    prepareDirectiveBinding({ identity, runtime: 'pi', agentId: 'logical-minion', sessionId: native.sessionId, sessionFile: file, text, authorityManifest: manifest });
    native.append({ role: 'user', content: [{ type: 'text', text }] });
    recordDirectiveProducerCessation(prepareDirectiveProducer({ identity, agentId: 'logical-minion', sessionId: native.sessionId, sessionFile: file }));
    return identity;
  };
  cleanups.push(() => { db.close(); store.dispose(); repo.cleanup(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, repo, db, ledger, bus, notifications, lane, worktrees, store, native, file, intent, identity, registry, spawns, stop, deps, seed,
    manifest: (value: string) => { manifest = value; }, spawnGate: (value: Promise<void> | null) => { spawnGate = value; }, supervised: (value: readonly string[]) => { supervised = value; } };
}

describe('restart-recovery-progress — exact native request matrix', () => {
  it('actual admitted original host exit continues once on the same persisted native lane, including live and frozen-owner refusals', async () => {
    const f = await fixture();
    const root = process.cwd();
    const code = `
      import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
      import { LedgerDb } from ${JSON.stringify(`${process.cwd()}/dist/ledger/db.js`)};
      import { LedgerApi } from ${JSON.stringify(`${process.cwd()}/dist/ledger/api.js`)};
      import { EventBus } from ${JSON.stringify(`${process.cwd()}/dist/events/bus.js`)};
      import { SessionStore } from ${JSON.stringify(`${process.cwd()}/dist/sessions/store.js`)};
      import { PiAgentHandle, PI_CAPABILITIES } from ${JSON.stringify(`${process.cwd()}/dist/runtime/pi-adapter.js`)};
      import { executeAcceptedDirective } from ${JSON.stringify(`${process.cwd()}/dist/dispatch/directive-progress.js`)};
      function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
      const NativeFixture = ${NativeFixture.toString().replace(/__vite_ssr_import_\d+__\./g, '')};
      const db = new LedgerDb(${JSON.stringify(f.dir)});
      const ledger = new LedgerApi(db.handle, { bus: new EventBus({}) });
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
    let stderr = ''; child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
    const ready = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error(`native fixture exited before admission: ${stderr}`); })]);
    expect(ready[0]).toMatchObject({ admitted: 'admitted' });
    const original = f.ledger.getDirective(f.intent.requestId)!;
    const start = f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-producer-started')!;
    const nativePrefix = readFileSync(f.file, 'utf8');
    let resumedHandle: AgentHandle | null = null;
    const registry: DirectiveRegistry = {
      getHandle: () => resumedHandle,
      spawn: vi.fn(async (_role, options = {}) => {
        if (options.directiveRecoveryProducer !== undefined) f.store.acquireLockAfterHostExit(f.file, options.directiveRecoveryProducer.pid);
        resumedHandle = new PiAgentHandle('minion', f.native, f.file, PI_CAPABILITIES, false, [], f.store, () => {}, () => { resumedHandle = null; },
          60_000, options.agentId, () => JSON.stringify({ role: 'minion', cwd: f.lane.path, tools: ['read', 'bash'], model: 'fixture/model' }));
        return resumedHandle;
      }),
      disposeHandle: async (handle) => handle.dispose(),
    };
    let service = new DirectiveProgressService({ ...f.deps, registry });
    try {
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
      await service.dispose();
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

  it('continues a proven user checkpoint once on the original logical session/lane/branch/PR', async () => {
    const f = await fixture(); f.seed();
    const service = new DirectiveProgressService(f.deps); service.reconsider(); service.reconsider(); await service.settled();
    expect(f.native.continuations).toBe(1); expect(f.native.prompts).toEqual([]);
    expect(f.spawns).toHaveLength(1);
    expect(f.spawns[0]).toMatchObject({ resumeFile: f.file, agentId: 'logical-minion', cwd: f.lane.path });
    expect(f.ledger.getJob(f.intent.jobId)).toMatchObject({ prUrl: 'https://example.test/pull/286' });
    expect(f.worktrees.listWorktrees({ jobId: f.intent.jobId })[0]).toMatchObject({ id: f.lane.id, branch: f.lane.branch, path: f.lane.path });
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled');
    new DirectiveProgressService(f.deps).reconsider();
    expect(f.native.continuations).toBe(1);
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
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('dispatching');
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
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
    expect(f.spawns).toEqual([]); expect(f.native.continuations).toBe(0);
    expect(f.ledger.getDirective(f.intent.requestId)?.recoveryCheckpoint).toBe(proof.checkpointId);
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
    const service = new DirectiveProgressService(f.deps); service.reconsider();
    await Promise.resolve(); expect(f.spawns).toHaveLength(1);
    f.ledger.setJobStatus(f.intent.jobId, 'parked'); gate.resolve(); await service.settled();
    expect(f.native.continuations).toBe(0); expect(f.ledger.latestJobEvent(f.intent.jobId, 'job.delivered')).toBeNull();
  });

  it('terminal jobs never revive or infer completion from bookkeeping', async () => {
    const f = await fixture(); f.seed(); f.ledger.setJobStatus(f.intent.jobId, 'done');
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await service.settled();
    expect(f.spawns).toEqual([]); expect(f.ledger.getJob(f.intent.jobId)?.status).toBe('done');
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('dispatching');
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

  it('owner stops refuse a successor; a concrete reserved-owner obligation settles only Gru recovery debt', async () => {
    const f = await fixture(); surfaceDirectiveRecovery(f.deps, f.intent.requestId, 'unknown');
    const debt = f.ledger.listObligations({ jobId: f.intent.jobId })[0]!;
    const reserved = f.ledger.recordBlockedObservation(f.intent.jobId, { logicalStep: 'operation', incidentKey: 'owner-budget', category: { kind: 'known', category: 'owner-hold' }, observedAtSeq: f.ledger.latestEventSeq(), nextAction: { kind: 'owner-decision', decision: 'owner must authorize the destructive operation' } });
    const input = { ledger: f.ledger, worktrees: f.worktrees, pendingProducerBlockers: () => [], requestId: f.intent.requestId, generation: debt.generation,
      expectedPayloadHash: f.intent.payloadHash, expectedHead: resolveGitCommit(f.lane.path, 'HEAD'), expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId), expectedWorkRevision: f.ledger.directiveCurrentAuthority(f.intent.jobId).workRevision, expectedContractSha256: f.ledger.directiveCurrentAuthority(f.intent.jobId).contractSha256, reason: 'destructive step is reserved for owner' };
    expect(() => recoverInterruptedDirectiveFromRoute({ ...input, decision: { kind: 'successor', requestId: 'forbidden-successor', directive: 'run' } })).toThrow(/owner/);
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
    new DirectiveProgressService(f.deps).reconsider(); await service.settled();
    expect(f.native.continuations).toBe(1);
    f.native.isBashRunning = false; service.reconsider(); await service.settled();
    expect(f.ledger.getDirective(f.intent.requestId)?.state).toBe('settled'); expect(f.native.continuations).toBe(1);
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'silas.directive-producer-ceased')).not.toBeNull();
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
        if (!ceasedBeforeRestart || failedCessationPublication) {
          expect(landed, 'unpublished UNKNOWN cleanup must survive a fresh LedgerApi without a handle').toBeNull();
          expect(ledger.getDirective(f.intent.requestId)?.state).toBe('admitted');
          expect(originalHandles[0]!.cessationEvidence!()).toBe(ceasedBeforeRestart ? 'ceased' : 'unknown');
          expect(ledger.getObligation(debt.id)).toMatchObject({ generation: debt.generation, state: 'open', nextAction: { kind: 'gru-decision' } });
          expect(ledger.findNotificationByKind(`silas.directive-unreconciled.${f.intent.requestId}`, 'active')?.detail)
            .toContain(`generation ${debt.generation}`);
        } else {
          expect(landed?.payload).toMatchObject({ request_id: f.intent.requestId, agentId: 'logical-minion', work_revision: f.identity.workRevision });
          expect(landed!.seq).toBeGreaterThan(cleanupHistory[0]!.seq);
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
        expect(ledger.listJobEventsByKinds(f.intent.jobId, ['silas.directive-producer-unknown', 'silas.directive-producer-ceased'])).toEqual(cleanupHistory);
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
      expect(f.ledger.getDirective(f.intent.requestId)?.recoveryCheckpoint !== null).toBe(mode === 'checkpoint');
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
  it('checkpoint start fence storage failure rolls back before spawn or continuation', async () => {
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
      await started.promise;
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

  it('restart preserves UNKNOWN when genuine original cessation publication failed before durability', async () => {
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

  it('an owner amendment during awaited resume prevents old execution despite a durable claim', async () => {
    const f = await fixture(); f.seed(); const gate = deferred<void>(); f.spawnGate(gate.promise);
    const service = new DirectiveProgressService(f.deps); service.reconsider(); await Promise.resolve(); expect(f.spawns).toHaveLength(1);
    expect(f.ledger.addJobAmendment({ jobId: f.intent.jobId, body: 'New approved requirement during spawn.', supersedes: [],
      approval: { by: 'owner', reference: 'GH-286 during-spawn approval' }, effect: 'material', expectedContractSha256: f.identity.contractSha256 }).status).toBe('accepted');
    gate.resolve(); await service.settled();
    expect(f.native.continuations).toBe(0); expect(f.native.prompts).toEqual([]);
    expect(f.ledger.getDirective(f.intent.requestId)?.recoveryCheckpoint).not.toBeNull();
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

  it('historical marker successor is exact-generation guarded and hands off actual authority once', async () => {
    const f = await fixture(); f.ledger.failDirective({ requestId: f.intent.requestId, reason: 'fixture no-effect' });
    const markers = f.ledger.beginPendingRebrief({ jobId: f.intent.jobId, note: 'legacy', briefing: 'original contract' });
    const marker = markers.find((row) => row.kind === 'silas.rebrief')!;
    const debt = f.ledger.openRebriefRecoveryDebt(marker.id, 'unknown native effects');
    const input = { ...f.deps, markerId: marker.id, generation: debt.generation, expectedPayloadHash: marker.payloadHash,
      expectedReceiptEvidenceSha256: f.ledger.rebriefReceiptEvidence(marker.id).sha256,
      expectedEpoch: f.ledger.directiveRecoveryEpoch(f.intent.jobId), expectedWorkRevision: f.ledger.directiveCurrentAuthority(f.intent.jobId).workRevision, expectedContractSha256: f.ledger.directiveCurrentAuthority(f.intent.jobId).contractSha256, expectedHead: resolveGitCommit(f.lane.path, 'HEAD'), reason: 'inspect preserved artifacts and finish under fresh authority',
      decision: { kind: 'successor' as const, requestId: 'marker-successor', directive: 'finish approved historical contract' } };
    expect(() => recoverInterruptedRebriefFromRoute({ ...input, generation: 999 })).toThrow(/stale/);
    expect(f.ledger.listPendingRebriefs()).toEqual(markers);
    const accepted = recoverInterruptedRebriefFromRoute(input);
    expect(f.ledger.listPendingRebriefs()).toEqual([]);
    expect(f.ledger.latestJobEvent(f.intent.jobId, 'silas.rebrief-retired')?.payload).toMatchObject({ markers });
    expect(recoverInterruptedRebriefFromRoute(input).idempotent).toBe(true);
    await executeAcceptedDirective(f.deps, accepted.successor!.requestId);
    expect(f.native.prompts).toHaveLength(1); expect(f.ledger.getObligation(debt.id)?.state).toBe('settled');
  });
  it('lone exact legacy delivery stays partial immutable history; fresh evidence-fenced judgment executes only a distinct successor', async () => {
    const f = await fixture(); f.ledger.failDirective({ requestId: f.intent.requestId, reason: 'fixture never dispatched' });
    f.ledger.beginPendingRebrief({ jobId: f.intent.jobId, note: 'legacy partial delivery', briefing: 'original contract' });
    f.ledger.bindPendingRebriefWorker({ ids: f.ledger.listPendingRebriefs().map((row) => row.id), agentId: 'logical-minion', sessionFile: f.native.sessionFile });
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
    f.ledger.bindPendingRebriefWorker({ ids: f.ledger.listPendingRebriefs().map((row) => row.id), agentId: 'logical-minion', sessionFile: f.native.sessionFile });
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
