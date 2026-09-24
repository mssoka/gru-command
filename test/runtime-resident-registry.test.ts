import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, type Role, type RuntimeId } from '../src/config.js';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { Supervisor } from '../src/supervision/supervisor.js';
import { RuntimeRegistry } from '../src/runtime/registry.js';
import type { AgentHandle, AgentRuntime, RuntimeEvent, RuntimeEventListener, SpawnOptions } from '../src/runtime/types.js';
import type { SessionStore } from '../src/sessions/store.js';

const caps = { streaming: false, steer: 'queued' as const, resume: 'file' as const, images: false, thinking: false, thinkingLevelControl: false, followUp: false };

function harness(capacity: number, shouldFail?: (role: Role) => boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'gru-resident-'));
  const config = { ...loadConfig({ GRU_COMMAND_HOME: dir }), concurrency: { maxWorkers: capacity } };
  let next = 0;
  let live = 0;
  let peak = 0;
  const controllers = new Map<string, { active: boolean; disposed: boolean }>();
  const events = new Map<string, (event: RuntimeEvent) => void>();
  const made: Array<{ id: string; adapter: string; resumeFile?: string }> = [];
  const adapter = (id: RuntimeId): AgentRuntime => ({
    id, capabilities: caps, health: () => ({ state: 'ok' }), dispose: async () => {},
    spawn: async (role: Role, opts: SpawnOptions = {}): Promise<AgentHandle> => {
      if (shouldFail?.(role) === true) throw new Error('fake adapter refused spawn');
      const agentId = `worker-${++next}`;
      const activity = { active: false, disposed: false };
      controllers.set(agentId, activity);
      made.push({ id: agentId, adapter: id, ...(opts.resumeFile === undefined ? {} : { resumeFile: opts.resumeFile }) });
      live += 1;
      peak = Math.max(peak, live);
      const listeners = new Set<RuntimeEventListener>();
      const emit = (event: RuntimeEvent) => { for (const listener of listeners) listener(event); };
      events.set(agentId, emit);
      return {
        id: agentId, role, sessionFile: `${dir}/${agentId}.jsonl`, capabilities: caps,
        health: () => ({ state: activity.disposed ? 'disposed' : 'idle', lastActivity: null, sessionFile: `${dir}/${agentId}.jsonl` }),
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        prompt: async () => {}, steer: async () => {}, followUp: async () => {},
        dispose: async () => {
          if (activity.disposed) return;
          activity.disposed = true;
          live -= 1;
          emit({ type: 'state', state: 'disposed' });
        },
      };
    },
  });
  const pi = adapter('pi');
  const claude = adapter('claude-code');
  class TestRegistry extends RuntimeRegistry {
    override runtimeIdFor(role: Role): RuntimeId { return role === 'perkins' ? 'claude-code' : 'pi'; }
    override runtimeFor(id: RuntimeId): AgentRuntime { return id === 'pi' ? pi : claude; }
  }
  const registry = new TestRegistry({ config, store: {} as SessionStore, canReclaim: (id) => controllers.get(id)?.active === false });
  return { registry, controllers, events, config, dir, made, get peak() { return peak; }, get live() { return live; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function tick() { await new Promise<void>((resolve) => setImmediate(resolve)); }

describe('registry resident boundary across adapters', () => {
  it('refuses to evict a display-idle minion with supervisor.openTurn=true, then admits after turn end', async () => {
    const h = harness(1);
    const db = new LedgerDb(h.dir);
    const bus = new EventBus();
    const ledger = new LedgerApi(db.handle, { bus });
    const notifications = new NotificationCenter({ ledger, bus });
    const supervisor = new Supervisor({ registry: h.registry, config: h.config.supervision, ledger, notifications });
    h.registry.setReclaimProbe((id) => {
      const view = supervisor.viewFor(id);
      return view !== null && view.state === 'watching' && !view.openTurn &&
        view.openControl === false && view.openToolCalls === 0;
    });
    try {
      const old = await h.registry.spawn('minion');
      await old.prompt('previous turn');
      h.events.get(old.id)!({ type: 'turn_start' });
      expect(old.health().state).toBe('idle');
      expect(supervisor.viewFor(old.id)?.openTurn).toBe(true);
      const waiting = h.registry.spawn('minion');
      await tick();
      expect(h.registry.getHandle(old.id)).toBe(old);
      expect(h.registry.residents.queued).toBe(1);
      h.events.get(old.id)!({ type: 'turn_end' });
      const next = await waiting;
      expect(h.registry.getHandle(old.id)).toBeNull();
      await next.dispose();
    } finally { supervisor.dispose(); db.close(); h.cleanup(); }
  });

  it('never reclaims a new handle before its owner has completed a first prompt', async () => {
    const h = harness(1);
    try {
      const newMinion = await h.registry.spawn('minion');
      const queued = h.registry.spawn('minion');
      await tick();
      expect(h.registry.getHandle(newMinion.id)).toBe(newMinion);
      expect(h.registry.residents.queued).toBe(1);
      await newMinion.prompt('first turn');
      const admitted = await queued;
      expect(h.registry.getHandle(newMinion.id)).toBeNull();
      await admitted.dispose();
    } finally { h.cleanup(); }
  });

  it('releases a failed spawn exactly once and never starts a cancelled queued spawn', async () => {
    let fail = true;
    const h = harness(2, () => { const result = fail; fail = false; return result; });
    try {
      await expect(h.registry.spawn('minion')).rejects.toThrow(/refused spawn/);
      expect(h.registry.residents.occupied).toBe(0);
      const first = await h.registry.spawn('minion');
      const second = await h.registry.spawn('minion');
      h.controllers.get(first.id)!.active = true;
      h.controllers.get(second.id)!.active = true;
      const controller = new AbortController();
      const blocked = h.registry.spawn('minion', { signal: controller.signal });
      controller.abort();
      await expect(blocked).rejects.toThrow(/cancelled/);
      expect(h.made).toHaveLength(2);
      expect(h.registry.residents.occupied).toBe(2);
      await first.dispose(); await second.dispose();
      expect(h.registry.residents.occupied).toBe(0);
    } finally { h.cleanup(); }
  });

  it('holds the queued review lead and child atomically while later minion arrivals wait', async () => {
    const h = harness(4);
    try {
      const minions = await Promise.all(Array.from({ length: 4 }, () => h.registry.spawn('minion')));
      for (const minion of minions) { await minion.prompt('previous turn'); h.controllers.get(minion.id)!.active = true; }
      const reservation = h.registry.reserveReviewRound();
      const fifth = h.registry.spawn('minion');
      await tick();
      expect(h.registry.residents.queued).toBe(2);
      expect(h.peak).toBe(4);
      await minions[0]!.dispose();
      await tick();
      expect(h.registry.residents.queued).toBe(2);
      await minions[1]!.dispose();
      const round = await reservation;
      const lead = await round.spawn({ reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] } });
      const batch = round.beginChildren(2);
      expect(batch.concurrency).toBe(1); // two implementers still resident
      const child = await round.spawn({ isolatedReview: { systemPrompt: 'child', tools: [] } });
      expect(h.peak).toBe(4);
      expect(h.made.at(-1)?.adapter).toBe('claude-code');
      await child.dispose();
      batch.finish();
      await lead.dispose();
      await round.close();
      const worker = await fifth;
      await worker.dispose();
      for (const minion of minions.slice(2)) await minion.dispose();
      expect(h.live).toBe(0);
      expect(h.peak).toBe(4);
    } finally { h.cleanup(); }
  });

  it('runs two children beside one implementer at 4/2, but only serial children at 2/1', async () => {
    for (const cap of [4, 2]) {
      const h = harness(cap);
      try {
        const implementer = await h.registry.spawn('minion');
        await implementer.prompt('previous turn');
        const roundPromise = h.registry.reserveReviewRound();
        if (cap === 2) await implementer.dispose();
        const round = await roundPromise;
        const lead = await round.spawn({ reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] } });
        const batch = round.beginChildren(cap === 4 ? 2 : 1);
        expect(batch.concurrency).toBe(cap === 4 ? 2 : 1);
        const children = await Promise.all(Array.from({ length: batch.concurrency }, () =>
          round.spawn({ isolatedReview: { systemPrompt: 'lens', tools: [] } }),
        ));
        expect(h.peak).toBeLessThanOrEqual(cap);
        await Promise.all(children.map((child) => child.dispose()));
        batch.finish();
        const nextBatch = round.beginChildren(1);
        const nextLens = await round.spawn({ isolatedReview: { systemPrompt: 'next lens', tools: [] } });
        await nextLens.dispose();
        nextBatch.finish();
        await lead.dispose();
        await round.close();
        await implementer.dispose();
        expect(h.live).toBe(0);
      } finally { h.cleanup(); }
    }
  });

  it('notices newly idle workers after a queued round, without requiring another arrival', async () => {
    const h = harness(2);
    try {
      const first = await h.registry.spawn('minion');
      const second = await h.registry.spawn('minion');
      await first.prompt('previous turn'); await second.prompt('previous turn');
      h.controllers.get(first.id)!.active = true;
      h.controllers.get(second.id)!.active = true;
      const review = h.registry.reserveReviewRound();
      h.controllers.get(first.id)!.active = false;
      h.registry.residents.changed();
      await tick();
      expect(h.registry.getHandle(first.id)).toBeNull();
      expect(h.registry.residents.queued).toBe(1);
      h.controllers.get(second.id)!.active = false;
      h.registry.residents.changed();
      const round = await review;
      await round.close();
      expect(h.live).toBe(0);
    } finally { h.cleanup(); }
  });

  it('protects an observed idle label with active supervisor work and preserves a released session file for resume', async () => {
    const h = harness(2);
    try {
      const old = await h.registry.spawn('minion');
      const young = await h.registry.spawn('minion');
      await old.prompt('previous turn'); await young.prompt('previous turn');
      h.controllers.get(old.id)!.active = true;
      const queued = h.registry.spawn('minion');
      const admitted = await queued;
      expect(h.registry.getHandle(old.id)).toBe(old);
      expect(h.registry.getHandle(young.id)).toBeNull();
      expect(h.peak).toBe(2);
      await old.dispose();
      const resumed = await h.registry.spawn('minion', { resumeFile: young.sessionFile! });
      expect(h.made.at(-1)?.resumeFile).toBe(young.sessionFile);
      await admitted.dispose(); await resumed.dispose();
    } finally { h.cleanup(); }
  });
});
