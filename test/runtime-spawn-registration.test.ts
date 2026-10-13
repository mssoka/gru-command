import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig, type Role, type RuntimeId } from '../src/config.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { BoardEngine } from '../src/board/engine.js';
import { RuntimeRegistry, type AgentEventEnvelope } from '../src/runtime/registry.js';
import type { AgentHandle, AgentRuntime, PendingTurn, RuntimeEvent, RuntimeEventListener, SpawnOptions } from '../src/runtime/types.js';
import type { SessionStore } from '../src/sessions/store.js';
import { observeDisposalSettlement } from '../src/runtime/disposal-observation.js';
import { Supervisor } from '../src/supervision/supervisor.js';
import { rebriefFreshMinion } from '../src/dispatch/fix-directive.js';
import type { WorktreePort } from '../src/dispatch/worktree-port.js';

const caps = { streaming: true, steer: 'native' as const, resume: 'file' as const, images: false,
  thinking: false, thinkingLevelControl: false, followUp: true };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 48; i += 1) await Promise.resolve(); }

function fixture(options: { readonly sameId?: boolean; readonly holdCleanup?: boolean; readonly holdThirdBirth?: boolean;
  readonly rateLimitSuccessor?: boolean; readonly holdSecondBirth?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gru-spawn-custody-'));
  const config = { ...loadConfig({ GRU_COMMAND_HOME: dir }), concurrency: { maxWorkers: 2 } };
  const db = new LedgerDb(dir);
  const bus = new EventBus();
  const ledger = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger, bus });
  const jobId = 'spawn-custody-job';
  ledger.addJob({ id: jobId, repo: 'fixture', title: 'Spawn custody' });
  ledger.setJobStatus(jobId, 'working');
  const created = deferred<AgentHandle>();
  const secondStarted = deferred<void>();
  const releaseSecond = deferred<void>();
  const releaseSpawn = deferred<void>();
  const releaseCleanup = deferred<void>();
  const thirdStarted = deferred<void>();
  const releaseThird = deferred<void>();
  const releaseTurn = deferred<void>();
  const releaseRetry = deferred<void>();
  const controls: { readonly emit: (event: RuntimeEvent) => void; pending: PendingTurn | null;
    readonly prompts: string[]; cleanupReject: boolean; cessation: 'ceased' | 'unknown' | null }[] = [];
  let count = 0;
  const adapter: AgentRuntime = {
    id: 'pi', capabilities: caps, health: () => ({ state: 'ok' }), dispose: async () => {},
    spawn: async (role: Role, opts: SpawnOptions = {}) => {
      const ordinal = ++count;
      if (ordinal === 2) {
        secondStarted.resolve();
        if (options.holdSecondBirth) await releaseSecond.promise;
      }
      if (ordinal === 3) {
        thirdStarted.resolve();
        if (options.holdThirdBirth) await releaseThird.promise;
      }
      const id = opts.agentId ?? (ordinal === 2 && options.sameId ? 'original' : ordinal === 1 ? 'original' : `worker-${ordinal}`);
      const sessionFile = opts.resumeFile ?? join(dir, `session-${ordinal}.jsonl`);
      let state: 'idle' | 'streaming' | 'error' | 'disposed' = 'idle';
      const listeners = new Set<RuntimeEventListener>();
      const control = { pending: null as PendingTurn | null, prompts: [] as string[], cleanupReject: false, cessation: null as 'ceased' | 'unknown' | null, emit: (event: RuntimeEvent) => {
        if (event.type === 'state') state = event.state as typeof state;
        for (const listener of listeners) listener(event);
      } };
      controls[ordinal - 1] = control;
      const prompt: AgentHandle['prompt'] = async (text, promptOptions) => {
        control.prompts.push(text);
        control.pending = { text, owner: promptOptions?.owner ?? null };
        control.emit({ type: 'state', state: 'streaming' });
        control.emit({ type: 'turn_start' });
        if (ordinal === 3 && options.rateLimitSuccessor && control.prompts.length === 1) {
          control.emit({ type: 'error', error: '429: rate limit', fatal: false });
          control.emit({ type: 'state', state: 'error' });
        } else {
          if (ordinal === 3 && !options.rateLimitSuccessor) await releaseTurn.promise;
          control.emit({ type: 'state', state: 'idle' });
        }
        control.emit({ type: 'turn_end' });
        control.pending = null;
      };
      return {
        id, role, sessionFile, capabilities: caps, prompt,
        promptWithVerdict: async (text, promptOptions) => {
          await prompt(text, promptOptions);
          return { ok: state === 'idle', error: state === 'idle' ? null : '429: rate limit' };
        },
        steer: async () => {}, followUp: async () => {}, pendingTurn: () => control.pending,
        health: () => ({ state, lastActivity: null, sessionFile }),
        hasLiveProcess: () => state === 'streaming', isCompacting: () => false,
        cessationEvidence: () => control.cessation ?? (state === 'disposed' ? 'ceased' : 'unknown'),
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        dispose: async () => {
          if (ordinal === 2 && options.holdCleanup) await releaseCleanup.promise;
          if (control.cleanupReject) throw new Error('owned native disposal rejected');
          control.pending = null;
          control.emit({ type: 'state', state: 'disposed' });
        },
      };
    },
  };
  class TestRegistry extends RuntimeRegistry {
    override runtimeIdFor(): RuntimeId { return 'pi'; }
    override runtimeFor(): AgentRuntime { return adapter; }
    override async spawn(role: Role, opts: SpawnOptions = {}): Promise<AgentHandle> {
      const handle = await super.spawn(role, opts);
      if (opts.resumeFile !== undefined) {
        created.resolve(handle);
        await releaseSpawn.promise;
      }
      return handle;
    }
  }
  const registry = new TestRegistry({ config, store: {} as SessionStore });
  const engine = new BoardEngine({ ledger, bus });
  const envelopes: AgentEventEnvelope[] = [];
  // The production ordering: BoardEngine subscribes BEFORE Supervisor.
  registry.onAgentEvent((envelope) => { envelopes.push(envelope); engine.onRuntimeEvent(envelope); });
  const supervisor = new Supervisor({ registry, ledger, notifications, config: { ...config.supervision, enabled: true },
    ...(options.rateLimitSuccessor ? { rateLimitBackoff: { baseMs: 1, maxMs: 1, maxRetries: 1, patterns: [] },
      sleep: () => releaseRetry.promise, jitter: () => 0 } : {}) });
  const worktrees = { listWorktrees: () => [{ kind: 'job', status: 'active', path: dir }] } as unknown as WorktreePort;
  return { dir, db, config, notifications, registry, supervisor, ledger, envelopes, controls, jobId, created, secondStarted, releaseSecond, thirdStarted, releaseSpawn,
    releaseCleanup, releaseThird, releaseTurn, releaseRetry,
    start: async () => {
      const original = await registry.spawn('minion');
      ledger.registerAgent({ id: original.id, role: 'minion', jobId, sessionFile: original.sessionFile });
      controls[0]!.pending = { text: 'original dispatch briefing', owner: `dispatch:${jobId}` };
      controls[0]!.emit({ type: 'state', state: 'streaming' });
      controls[0]!.emit({ type: 'turn_start' });
      controls[0]!.emit({ type: 'error', error: 'transport died', fatal: true });
      return created.promise;
    },
    rebrief: () => {
      const markers = ledger.beginPendingRebrief({ jobId, note: 'independent authorized briefing', briefing: null });
      const routing = rebriefFreshMinion({ registry, ledger, worktrees, jobId,
        note: 'independent authorized briefing', briefing: null,
        retrySettlement: (id) => supervisor.awaitRetrySettlement(id),
        onSpawned: (handle) => ledger.bindPendingRebriefWorker({ ids: markers.map((row) => row.id), agentId: handle.id, sessionFile: handle.sessionFile }) });
      return { routing, markers };
    },
    dispose: async () => {
      releaseSecond.resolve(); releaseSpawn.resolve(); releaseCleanup.resolve(); releaseThird.resolve(); releaseTurn.resolve(); releaseRetry.resolve();
      await flush();
      supervisor.dispose();
      await registry.dispose();
      await flush();
      db.close(); rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('registry publication and production consumer custody (GH-280)', () => {
  function reader(h: ReturnType<typeof fixture>) {
    const db = new LedgerDb(h.dir); const ledger = new LedgerApi(db.handle); const bus = new EventBus();
    const supervisor = new Supervisor({ registry: new RuntimeRegistry({ config: h.config, store: {} as SessionStore }),
      ledger, notifications: new NotificationCenter({ ledger, bus }), config: { ...h.config.supervision, enabled: false } });
    return { ledger, supervisor, close: () => { supervisor.dispose(); db.close(); } };
  }

  it('records subsequent exact native disposal after watchdog shutdown and replays it across LedgerDb reopen (GH-280)', async () => {
    const h = fixture();
    try {
      const rejected = await h.start();
      h.controls[1]!.cleanupReject = true;
      h.ledger.beginPendingRebrief({ jobId: h.jobId, note: 'superseded', briefing: null });
      h.releaseSpawn.resolve(); await flush();
      expect(h.supervisor.pendingProducerBlockers(h.jobId)).toHaveLength(1);
      const pending = h.ledger.latestJobEvent(h.jobId, 'supervision.restart-cleanup-pending')!;
      h.supervisor.dispose();
      h.controls[1]!.cleanupReject = false;
      await h.registry.dispose();
      expect(rejected.cessationEvidence?.()).toBe('ceased');
      const receipt = h.ledger.latestJobEvent(h.jobId, 'supervision.restart-cleanup-confirmed')!;
      expect(receipt).not.toBeNull();
      expect(pending).not.toBeNull();
      expect(receipt.payload).toMatchObject({ origin_seq: pending.seq, replacement_agent_id: rejected.id,
        generation: (pending.payload as { generation: string }).generation, disposal_acknowledged: true, cessation: 'ceased' });
      h.db.close();
      const next = reader(h);
      try { expect(next.supervisor.pendingProducerBlockers(h.jobId)).toEqual([]); } finally { next.close(); }
    } finally { await h.dispose(); }
  });

  it('refreshes late positive cessation from the original custodian after watchdog disposal (GH-280)', async () => {
    const h = fixture();
    try {
      await h.start();
      h.controls[1]!.cessation = 'unknown';
      h.ledger.beginPendingRebrief({ jobId: h.jobId, note: 'superseded', briefing: null });
      h.releaseSpawn.resolve(); await flush();
      const next = reader(h);
      try {
        expect(next.supervisor.pendingProducerBlockers(h.jobId)).toHaveLength(1);
        h.supervisor.dispose();
        // A claimed event alone is not proof; the exact adapter probe must agree.
        h.controls[1]!.emit({ type: 'cessation_evidence', evidence: 'ceased' });
        expect(next.supervisor.pendingProducerBlockers(h.jobId)).toHaveLength(1);
        h.controls[1]!.cessation = 'ceased';
        h.controls[1]!.emit({ type: 'cessation_evidence', evidence: 'ceased' });
        expect(next.supervisor.pendingProducerBlockers(h.jobId)).toEqual([]);
        h.controls[1]!.emit({ type: 'cessation_evidence', evidence: 'ceased' });
        expect(h.ledger.listJobEvents(h.jobId, { limit: 100 }).filter((event) => event.kind === 'supervision.restart-cleanup-confirmed')).toHaveLength(1);
      } finally { next.close(); }
    } finally { await h.dispose(); }
  });

  it('persists late native confirmation even when posting its cleanup notice failed (GH-280)', async () => {
    const h = fixture();
    try {
      await h.start();
      h.controls[1]!.cessation = 'unknown';
      h.ledger.beginPendingRebrief({ jobId: h.jobId, note: 'superseded', briefing: null });
      const post = vi.spyOn(h.notifications, 'post').mockImplementation(() => { throw new Error('notice storage unavailable'); });
      h.releaseSpawn.resolve(); await flush();
      post.mockRestore();
      expect(h.supervisor.pendingProducerBlockers(h.jobId)).toHaveLength(1);
      expect(h.ledger.listNotifications({ limit: 100 }).filter((notice) => notice.kind === 'supervision.restart-cleanup-unconfirmed')).toEqual([]);
      h.supervisor.dispose();
      h.controls[1]!.cessation = 'ceased';
      h.controls[1]!.emit({ type: 'cessation_evidence', evidence: 'ceased' });
      expect(h.ledger.latestJobEvent(h.jobId, 'supervision.restart-cleanup-confirmed')).not.toBeNull();
      h.db.close(); const next = reader(h);
      try { expect(next.supervisor.pendingProducerBlockers(h.jobId)).toEqual([]); } finally { next.close(); }
    } finally { await h.dispose(); }
  });

  it('does not let a successful same-ID successor disposal release the missing original-generation proof (GH-280)', async () => {
    const h = fixture({ sameId: true });
    let routing: ReturnType<typeof rebriefFreshMinion> | null = null;
    try {
      await h.start();
      h.controls[1]!.cleanupReject = true;
      const native = h.rebrief(); routing = native.routing;
      await flush();
      h.releaseSpawn.resolve(); await flush();
      expect(h.supervisor.pendingProducerBlockers(h.jobId).join(' ')).toContain('cleanup unconfirmed');
      h.releaseTurn.resolve(); await routing;
      const successor = h.registry.getHandle('original')!;
      expect(successor).not.toBeNull();
      await h.registry.disposeHandle(successor);
      h.supervisor.dispose();
      h.controls[1]!.emit({ type: 'cessation_evidence', evidence: 'ceased' });
      const next = reader(h);
      try { expect(next.supervisor.pendingProducerBlockers(h.jobId)).toHaveLength(1); } finally { next.close(); }
      h.controls[1]!.cleanupReject = false; // fixture teardown only, exact original owner
    } finally { h.controls[1]!.cleanupReject = false; await h.dispose(); if (routing !== null) await routing; }
  });

  it('contains disposal-observer failures without changing native fulfillment or rejection (GH-280)', async () => {
    const h = fixture();
    try {
      const handle = await h.registry.spawn('minion');
      const calls: boolean[] = [];
      const detach = observeDisposalSettlement(handle, (acknowledged) => { calls.push(acknowledged); throw new Error('observer failed'); });
      h.controls[0]!.cleanupReject = true;
      await expect(handle.dispose()).rejects.toThrow('owned native disposal rejected');
      h.controls[0]!.cleanupReject = false;
      await expect(handle.dispose()).resolves.toBeUndefined();
      expect(calls).toEqual([false, true]);
      detach();
    } finally { await h.dispose(); }
  });

  it('hides a fresh-id result and its startup error from every consumer until the owner rejects it', async () => {
    const h = fixture();
    try {
      const stale = await h.start();
      h.ledger.beginPendingRebrief({ jobId: h.jobId, note: 'newer native authority', briefing: null });
      h.controls[1]!.emit({ type: 'error', error: 'fatal before spawn return', fatal: true });
      await flush();
      expect(h.registry.getHandle(stale.id)).toBeNull();
      expect(h.supervisor.viewFor(stale.id)).toBeNull();
      expect(h.ledger.getAgent(stale.id)).toBeNull();
      expect(h.envelopes.some((envelope) => envelope.agentId === stale.id)).toBe(false);
      expect(h.controls).toHaveLength(2);
      h.releaseSpawn.resolve();
      await flush();
      expect(stale.cessationEvidence?.()).toBe('ceased');
      expect(h.controls).toHaveLength(2);
      expect(h.ledger.getAgent(stale.id)).toBeNull();
      expect(h.supervisor.pendingProducerBlockers(h.jobId)).toEqual([]);
    } finally { await h.dispose(); }
  });

  it('replays an accepted startup fatal through the actual registry before ever prompting the failed handle', async () => {
    const h = fixture({ sameId: true });
    try {
      const failed = await h.start();
      h.controls[1]!.emit({ type: 'error', error: 'accepted startup transport died', fatal: true });
      expect(h.envelopes.some((envelope) => envelope.handle === failed)).toBe(false);
      h.releaseTurn.resolve();
      h.releaseSpawn.resolve();
      await flush();
      expect(h.envelopes.some((envelope) => envelope.handle === failed && envelope.phase === 'event' &&
        envelope.event?.type === 'error' && envelope.event.fatal)).toBe(true);
      expect(h.controls[1]!.prompts).toEqual([]);
      expect(failed.cessationEvidence?.()).toBe('ceased');
      expect(h.controls).toHaveLength(3);
      expect(h.controls[2]!.prompts).toEqual(['original dispatch briefing']);
      expect(h.supervisor.viewFor('worker-3')).toMatchObject({ state: 'watching', openTurn: false });
      expect(h.ledger.getAgent(failed.id)?.state).toBe('disposed');
    } finally { await h.dispose(); }
  });

  it('retains a native same-id successor born after stale creation while stale cleanup is still pending', async () => {
    const h = fixture({ sameId: true, holdCleanup: true, holdThirdBirth: true, holdSecondBirth: true });
    let routing: ReturnType<typeof rebriefFreshMinion> | null = null;
    try {
      const starting = h.start();
      await h.secondStarted.promise;
      const native = h.rebrief(); routing = native.routing;
      await h.thirdStarted.promise; // authorized creation already in flight
      h.releaseSecond.resolve();
      const stale = await starting; // stale object is indexed FIRST
      h.releaseSpawn.resolve();
      await flush();
      expect(h.supervisor.pendingProducerBlockers(h.jobId).join(' ')).toContain('cleanup unconfirmed');
      h.releaseThird.resolve();
      await flush();
      const successor = h.registry.getHandle('original');
      expect(successor).not.toBeNull();
      expect(successor).not.toBe(stale);
      expect(h.supervisor.viewFor('original')).toMatchObject({ state: 'watching', openTurn: true });
      expect(h.ledger.getAgent('original')).toMatchObject({ sessionFile: successor!.sessionFile, state: 'streaming' });
      h.releaseCleanup.resolve();
      await flush();
      h.controls[1]!.emit({ type: 'error', error: 'late stale error', fatal: true });
      h.controls[1]!.emit({ type: 'state', state: 'disposed' });
      // This predecessor WAS publicly registered, unlike the hidden result.
      h.controls[0]!.emit({ type: 'state', state: 'disposed' });
      await flush();
      expect(h.registry.getHandle('original')).toBe(successor);
      expect(h.ledger.getAgent('original')).toMatchObject({ sessionFile: successor!.sessionFile, state: 'streaming' });
      expect(h.supervisor.viewFor('original')).toMatchObject({ state: 'watching', openTurn: true });
      expect(h.controls).toHaveLength(3);
      h.releaseTurn.resolve();
      await expect(routing).resolves.toMatchObject({ outcome: 'completed', minionId: 'original' });
    } finally { await h.dispose(); if (routing !== null) await routing; }
  });

  it('holds native rebrief delivery through a same-id 429 retry that settles before the stale rung returns', async () => {
    const h = fixture({ sameId: true, rateLimitSuccessor: true });
    let routing: ReturnType<typeof rebriefFreshMinion> | null = null;
    try {
      const stale = await h.start();
      const native = h.rebrief(); routing = native.routing;
      let settled = false;
      void routing.then(() => { settled = true; });
      await flush();
      expect(settled).toBe(false);
      expect(h.controls[2]!.pending).toBeNull(); // adapter has cleared its live snapshot
      expect(h.controls[2]!.prompts).toHaveLength(1);
      expect(h.ledger.latestJobEvent(h.jobId, 'pacing.auto-retry')).not.toBeNull();
      h.releaseRetry.resolve();
      await expect(routing).resolves.toMatchObject({ outcome: 'completed', minionId: 'original' });
      expect(h.controls[2]!.prompts).toHaveLength(2);
      expect(h.controls[2]!.prompts[1]).toBe(h.controls[2]!.prompts[0]);
      // The native caller records these only AFTER the truthful retry result.
      for (const kind of ['silas.rebrief', 'job.delivered']) {
        expect(h.ledger.appendCustomEventIfCurrentRebrief({ kind, jobId: h.jobId,
          payload: { minion_id: 'original', sha: 'fixture-completed-work' } }, native.markers)).not.toBeNull();
      }
      expect(h.ledger.clearPendingRebriefsIfCurrentAndSettle(native.markers)).toBe(true);
      expect(h.supervisor.pendingProducerBlockers(h.jobId).join(' ')).toContain('restart in flight');
      const successor = h.registry.getHandle('original')!;
      h.releaseSpawn.resolve();
      await flush();
      expect(stale.cessationEvidence?.()).toBe('ceased');
      expect(h.registry.getHandle('original')).toBe(successor);
      expect(h.ledger.getAgent('original')).toMatchObject({ sessionFile: successor.sessionFile, state: 'idle' });
      expect(h.supervisor.viewFor('original')).toMatchObject({ state: 'watching', openTurn: false });
      expect(h.controls[1]!.prompts).toEqual([]);
    } finally { await h.dispose(); if (routing !== null) await routing; }
  });
});
