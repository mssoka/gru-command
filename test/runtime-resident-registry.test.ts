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

function harness(capacity: number, shouldFail?: (role: Role) => boolean, closeSettleMs?: number) {
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
        hasLiveProcess: () => false, isCompacting: () => false,
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
  const registry = new TestRegistry({
    config, store: {} as SessionStore,
    canReclaim: (id) => controllers.get(id)?.active === false,
    ...(closeSettleMs === undefined ? {} : { closeSettleMs }),
  });
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

  it('never charges Gru, Silas or Bob to the resident pool, even at full saturation', async () => {
    const h = harness(2);
    try {
      const busyA = await h.registry.spawn('minion');
      const busyB = await h.registry.spawn('minion');
      await busyA.prompt('turn'); await busyB.prompt('turn');
      h.controllers.get(busyA.id)!.active = true;
      h.controllers.get(busyB.id)!.active = true;
      expect(h.registry.residents.occupied).toBe(2);
      expect(h.registry.residents.queued).toBe(0);
      // Core sessions resolve immediately at saturation: no permit charge,
      // no queue wait, and no idle worker is reclaimed to make room.
      const gru = await h.registry.spawn('gru');
      const silas = await h.registry.spawn('silas');
      const bob = await h.registry.spawn('bob');
      expect(h.registry.residents.occupied).toBe(2);
      expect(h.registry.residents.queued).toBe(0);
      expect(h.registry.getHandle(busyA.id)).toBe(busyA);
      expect(h.registry.getHandle(busyB.id)).toBe(busyB);
      // A queued minion still waits behind the saturated pool — the
      // exemption covers core roles only.
      const queued = h.registry.spawn('minion');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.registry.residents.queued).toBe(1);
      h.controllers.get(busyA.id)!.active = false;
      h.registry.residents.changed();
      await new Promise<void>((resolve) => setImmediate(resolve));
      const admitted = await queued;
      expect(h.registry.getHandle(busyA.id)).toBeNull();
      await Promise.all([gru.dispose(), silas.dispose(), bob.dispose(), admitted.dispose(), busyB.dispose()]);
    } finally { h.cleanup(); }
  });

  it('names the round misuse errors: duplicate lead, over-parallel child, overlapping batch', async () => {
    const h = harness(4);
    try {
      const round = await h.registry.reserveReviewRound();
      const leadOpts = { reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] } };
      await round.spawn(leadOpts);
      await expect(round.spawn(leadOpts)).rejects.toThrow(/review reservation already has a lead/);
      // First child takes the pair's child slot; with no extras admitted, a
      // second concurrent child exceeds admitted parallelism.
      const first = await round.spawn({ isolatedReview: { systemPrompt: 'lens', tools: [] } });
      await expect(round.spawn({ isolatedReview: { systemPrompt: 'lens 2', tools: [] } }))
        .rejects.toThrow(/review child exceeded admitted parallelism/);
      // A new batch requires the previous child to have settled.
      await expect(() => round.beginChildren(2)).toThrow(/review child batch overlaps an active batch/);
      await first.dispose();
      const batch = round.beginChildren(2);
      expect(() => round.beginChildren(2)).toThrow(/review child batch overlaps an active batch/);
      batch.finish();
      await round.close();
    } finally { h.cleanup(); }
  });

  it('holds the pair for an unproven live handle at close, then releases exactly once on proven cessation', async () => {
    const h = harness(4);
    try {
      const round = await h.registry.reserveReviewRound();
      const lead = await round.spawn({ reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] } });
      await round.spawn({ isolatedReview: { systemPrompt: 'lens', tools: [] } });
      expect(h.registry.residents.occupied).toBe(2 + 0); // pair only (capacity 4)
      // The lead's dispose REJECTS while its health is still live: the pair
      // is NOT released — the live handle owns its backing count.
      h.events.get(lead.id)!({ type: 'state', state: 'idle' });
      Object.defineProperty(lead, 'dispose', { value: () => Promise.reject(new Error('lead disposal failed')), configurable: true });
      await expect(round.close()).rejects.toThrow(/owned capacity not proven ceased \(worker-1\); retained as cleanup debt/);
      expect(round.cleanupDebt()).toContain(lead.id);
      expect(h.registry.residents.occupied).toBe(2); // debt counted, cap intact
      // A queued implementer can never be admitted above the cap by the debt.
      const leadActivity = h.controllers.get(lead.id)!;
      h.controllers.clear();
      // Proven cessation (terminal health truth) reconciles and releases ONCE.
      leadActivity.disposed = true;
      h.events.get(lead.id)!({ type: 'state', state: 'disposed' });
      round.reconcileCleanup();
      expect(round.cleanupDebt()).toHaveLength(0);
      expect(h.registry.residents.occupied).toBe(0);
      round.reconcileCleanup(); // idempotent: no double release
      expect(h.registry.residents.occupied).toBe(0);
    } finally { h.cleanup(); }
  });

  it('never-settling disposal hits the whole-close deadline and holds capacity as owned debt', async () => {
    const h = harness(2, undefined, 60);
    try {
      const round = await h.registry.reserveReviewRound();
      const lead = await round.spawn({ reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] } });
      Object.defineProperty(lead, 'dispose', { value: () => new Promise<void>(() => {}), configurable: true });
      await expect(round.close()).rejects.toThrow(/close settle window exceeded: capacity retained as owned cleanup debt/);
      expect(h.registry.residents.occupied).toBe(2);
      expect(round.cleanupDebt()).toContain(lead.id);
    } finally { h.cleanup(); }
  });

  it('releases the paired permits even when a round handle disposal fails at close', async () => {
    const h = harness(2);
    try {
      const round = await h.registry.reserveReviewRound();
      const lead = await round.spawn({ reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] } });
      await round.spawn({ isolatedReview: { systemPrompt: 'lens', tools: [] } });
      expect(h.registry.residents.occupied).toBe(2);
      // The lead's adapter refuses disposal; the round's paired permits must
      // still release — the failed handle keeps only what it truly holds.
      Object.defineProperty(lead, 'dispose', {
        value: () => Promise.reject(new Error('lead disposal failed')),
        configurable: true,
      });
      // The adapter refused the dispose CALL, but the child's terminal exit
      // was already observed (health truth): the pair must release, and the
      // close still reports the disposal failure.
      h.controllers.get(lead.id)!.disposed = true;
      await expect(round.close()).rejects.toThrow(/review reservation disposal failed/);
      // The pair is free again: a queued single worker is admitted at once.
      const admitted = h.registry.spawn('minion');
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.registry.residents.queued).toBe(0);
      const handle = await Promise.race([admitted, new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('pair permit was not released')), 2_000))]);
      await handle.dispose();
    } finally { h.cleanup(); }
  });

  it('reclaims a truthful-probe handle on demand and exposes read-only residency snapshot facts', async () => {
    const h = harness(2);
    try {
      const first = await h.registry.spawn('minion');
      await first.prompt('previous turn');
      const second = await h.registry.spawn('minion');
      await second.prompt('previous turn');
      const snapshot = h.registry.residencySnapshot();
      expect(snapshot).toMatchObject({ capacity: 2, occupied: 2, queued: 0, reclaimFailures: 0 });
      expect(snapshot.handles.map((entry) => entry.agentId).sort()).toEqual([first.id, second.id].sort());
      // The snapshot is facts only: no admission record, no fan-out flag.
      expect(Object.keys(snapshot).sort()).toEqual(['capacity', 'handles', 'occupied', 'queued', 'reclaimFailures']);
      // Truthful probes (hasLiveProcess/isCompacting present and false) keep
      // the handle reclaimable; absent probes are ineligible by contract.
      h.controllers.get(first.id)!.active = false;
      const queued = h.registry.spawn('minion');
      await tick();
      expect(h.registry.getHandle(first.id)).toBeNull(); // reclaimed with truthful evidence
      const admitted = await queued;
      await admitted.dispose();
      await second.dispose();
    } finally { h.cleanup(); }
  });

  it('close settles late spawn success within the bound and releases exactly once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resident-close-late-'));
    const config = { ...loadConfig({ GRU_COMMAND_HOME: dir }), concurrency: { maxWorkers: 4 }, };
    const slow: AgentRuntime = {
      id: 'pi', capabilities: caps, health: () => ({ state: 'ok' }), dispose: async () => {},
      spawn: async (role: Role): Promise<AgentHandle> => {
        await new Promise<void>((resolve) => setTimeout(resolve, 5)); // late but inside the settle window
        return {
          id: 'late-child', role, sessionFile: `${dir}/late.jsonl`, capabilities: caps,
          health: () => ({ state: 'idle', lastActivity: null, sessionFile: `${dir}/late.jsonl` }),
          prompt: async () => {}, steer: async () => {}, followUp: async () => {},
          hasLiveProcess: () => false, isCompacting: () => false,
          subscribe: () => () => {}, dispose: async () => {},
        };
      },
    };
    class SlowRegistry extends RuntimeRegistry {
      override runtimeIdFor(): RuntimeId { return 'pi'; }
      override runtimeFor(): AgentRuntime { return slow; }
    }
    const registry = new SlowRegistry({ config, store: {} as SessionStore, closeSettleMs: 250 });
    try {
      const round = await registry.reserveReviewRound();
      const spawnPromise = round.spawn({ isolatedReview: { systemPrompt: 'lens', tools: [] } });
      void spawnPromise; // settles after close begins, within the window
      await round.close(); // no throw: late spawn settled inside the bound
      expect(registry.residents.occupied).toBe(0);
      await registry.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('close settle expiry fails CLOSED: capacity retained as cleanup debt, never released while a spawn may live', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resident-close-expiry-'));
    const config = { ...loadConfig({ GRU_COMMAND_HOME: dir }), concurrency: { maxWorkers: 2 }, };
    const never: AgentRuntime = {
      id: 'pi', capabilities: caps, health: () => ({ state: 'ok' }), dispose: async () => {},
      spawn: (): Promise<AgentHandle> => new Promise<AgentHandle>(() => {}), // never settles
    };
    class NeverRegistry extends RuntimeRegistry {
      override runtimeIdFor(): RuntimeId { return 'pi'; }
      override runtimeFor(): AgentRuntime { return never; }
    }
    const registry = new NeverRegistry({ config, store: {} as SessionStore, closeSettleMs: 10 });
    try {
      const round = await registry.reserveReviewRound();
      void round.spawn({ isolatedReview: { systemPrompt: 'lens', tools: [] } }).catch(() => {});
      await expect(round.close()).rejects.toThrow(/close settle window exceeded: capacity retained/);
      expect(registry.residents.occupied).toBe(2); // permits NOT released — truthful cleanup debt
      const again = round.close(); // repeated close is memoized: same failure, no double effect
      await expect(again).rejects.toThrow(/close settle window exceeded/);
      expect(registry.residents.occupied).toBe(2);
      await registry.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('treats missing, undefined-returning, throwing and alive probes as unknown (ineligible); only explicit false reclaims', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resident-probe-variants-'));
    const config = { ...loadConfig({ GRU_COMMAND_HOME: dir }), concurrency: { maxWorkers: 1 } };
    const caps2 = caps;
    const made: Array<{ id: string; probe: () => boolean | undefined; disposed: boolean }> = [];
    const listeners = new Map<string, (event: RuntimeEvent) => void>();
    const adapter: AgentRuntime = {
      id: 'pi', capabilities: caps2, health: () => ({ state: 'ok' }), dispose: async () => {},
      spawn: async (role: Role): Promise<AgentHandle> => {
        const id = `variant-${made.length + 1}`;
        made.push({ id, probe: () => undefined, disposed: false });
        const entry = made.at(-1)!;
        return {
          id, role, sessionFile: null, capabilities: caps2,
          health: () => ({ state: entry.disposed ? 'disposed' : 'idle', lastActivity: null, sessionFile: null }),
          prompt: async () => {}, steer: async () => {}, followUp: async () => {},
          // Deliberately malformed probe return (models "cannot tell"): the
          // runtime contract declares boolean, the reclaim contract must
          // treat anything but literal false as unknown.
          hasLiveProcess: () => entry.probe() as boolean,
          isCompacting: () => false,
          subscribe: (listener) => { listeners.set(id, listener); return () => { listeners.delete(id); }; },
          dispose: async () => { entry.disposed = true; listeners.get(id)?.({ type: 'state', state: 'disposed' }); },
        };
      },
    };
    class VariantRegistry extends RuntimeRegistry {
      override runtimeIdFor(): RuntimeId { return 'pi'; }
      override runtimeFor(): AgentRuntime { return adapter; }
    }
    const registry = new VariantRegistry({ config, store: {} as SessionStore, canReclaim: () => true });
    try {
      const missing = await registry.spawn('minion');
      await missing.prompt('turn');
      // A competing request is what forces the drain to consider reclaiming;
      // while probes are unknown/alive the slot must be kept.
      const queued = registry.spawn('minion');
      await tick();
      expect(registry.residents.queued).toBe(1);
      // Variant matrix on the SAME logical slot: undefined / throwing / alive all block reclaim.
      for (const variant of [() => undefined, () => { throw new Error('probe blew up'); }, () => true]) {
        made[0]!.probe = variant;
        registry.residents.changed();
        await tick();
        expect(registry.getHandle(missing.id)).toBe(missing); // never reclaimed on unknown/alive
        expect(registry.residents.queued).toBe(1);
      }
      made[0]!.probe = () => false; // explicit false = proof
      registry.residents.changed();
      await tick();
      expect(registry.getHandle(missing.id)).toBeNull(); // reclaimed only now
      const admitted = await queued;
      await admitted.dispose();
      void made; void listeners;
      await registry.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('OPEN-round child disposal never releases the pair; another implementer cannot borrow it', async () => {
    const h = harness(2);
    try {
      const round = await h.registry.reserveReviewRound();
      const lead = await round.spawn({ reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] } });
      const first = await round.spawn({ isolatedReview: { systemPrompt: 'lens', tools: [] } });
      expect(h.registry.residents.occupied).toBe(2);
      await first.dispose(); // child settles during an OPEN round
      await tick();
      expect(h.registry.residents.occupied).toBe(2); // pair STILL reserved for the live lead
      const queued = h.registry.spawn('minion');
      await tick();
      expect(h.registry.residents.queued).toBe(1);  // the pair cannot be borrowed
      await lead.dispose();
      await round.close();
      const admitted = await queued;
      await admitted.dispose();
      expect(h.registry.residents.occupied).toBe(0);
    } finally { h.cleanup(); }
  });

  it('a pending pair spawn stays counted through the close deadline; settling one member cannot release another', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resident-pending-counted-'));
    const config = { ...loadConfig({ GRU_COMMAND_HOME: dir }), concurrency: { maxWorkers: 2 } };
    const late = { release: null as (() => void) | null };
    const slow: AgentRuntime = {
      id: 'pi', capabilities: caps, health: () => ({ state: 'ok' }), dispose: async () => {},
      spawn: () => new Promise<AgentHandle>((resolve) => {
        late.release = () => resolve({
          id: 'late-pair', role: 'perkins', sessionFile: null, capabilities: caps,
          hasLiveProcess: () => false, isCompacting: () => false,
          health: () => ({ state: 'idle', lastActivity: null, sessionFile: null }),
          prompt: async () => {}, steer: async () => {}, followUp: async () => {},
          subscribe: () => () => {}, dispose: async () => {},
        });
      }),
    };
    class SlowRegistry extends RuntimeRegistry {
      override runtimeIdFor(): RuntimeId { return 'pi'; }
      override runtimeFor(): AgentRuntime { return slow; }
    }
    const registry = new SlowRegistry({ config, store: {} as SessionStore, closeSettleMs: 40 });
    try {
      const round = await registry.reserveReviewRound();
      void round.spawn({ reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] } }).catch(() => {});
      await tick();
      await expect(round.close()).rejects.toThrow(/close settle window exceeded/);
      expect(registry.residents.occupied).toBe(2); // pending pair spawn stays counted
      late.release?.(); // LATE success AFTER deadline: owned cleanup, counted until proven
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      round.reconcileCleanup();
      expect(registry.residents.occupied).toBe(0); // proven ceased (explicit-false probes) releases ONCE
      round.reconcileCleanup();
      expect(registry.residents.occupied).toBe(0);
      await registry.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a fulfilled dispose with unknown probes does NOT release; real later cessation releases once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'resident-fulfilled-unknown-'));
    const config = { ...loadConfig({ GRU_COMMAND_HOME: dir }), concurrency: { maxWorkers: 2 } };
    const state = { live: 'unknown' as 'unknown' | 'false', disposed: false };
    const handle: AgentHandle = {
      id: 'opaque', role: 'perkins', sessionFile: null, capabilities: caps,
      // Deliberately malformed probe return (models "cannot tell"): not
      // literal false, so it must never be read as proven cessation.
      hasLiveProcess: () => (state.live === 'false' ? false : undefined) as boolean,
      isCompacting: () => false,
      health: () => ({ state: state.disposed ? 'disposed' : 'idle', lastActivity: null, sessionFile: null }),
      prompt: async () => {}, steer: async () => {}, followUp: async () => {},
      // Fulfills WITHOUT terminal health or explicit-false probes: the debt
      // path, not a positive release.
      subscribe: () => () => {}, dispose: async () => {},
    };
    class OneRegistry extends RuntimeRegistry {
      override runtimeIdFor(): RuntimeId { return 'pi'; }
      override runtimeFor(): AgentRuntime { return { id: 'pi', capabilities: caps, health: () => ({ state: 'ok' }), dispose: async () => {}, spawn: async () => handle }; }
    }
    const registry = new OneRegistry({ config, store: {} as SessionStore, closeSettleMs: 250 });
    try {
      const round = await registry.reserveReviewRound();
      await round.spawn({ reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] } });
      await expect(round.close()).rejects.toThrow(/not proven ceased/); // dispose fulfilled, probes UNKNOWN -> debt, reported
      expect(registry.residents.occupied).toBe(2); // unknown evidence retains capacity
      state.disposed = true; // real later cessation: terminal health truth
      round.reconcileCleanup();
      expect(registry.residents.occupied).toBe(0); // health-truth proof releases ONCE
      await registry.dispose();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('multiple pair members and consumed extras all participate; the queued implementer never exceeds the cap', async () => {
    const h = harness(4);
    try {
      const implementer = await h.registry.spawn('minion');
      await implementer.prompt('previous turn');
      h.controllers.get(implementer.id)!.active = true; // genuinely busy: not reclaimable
      const round = await h.registry.reserveReviewRound();
      const lead = await round.spawn({ reviewLead: { systemPrompt: 'lead', tools: [], nativeTools: [] } });
      const batch = round.beginChildren(2);
      const first = await round.spawn({ isolatedReview: { systemPrompt: 'lens 1', tools: [] } });
      const extra = await round.spawn({ isolatedReview: { systemPrompt: 'lens 2', tools: [] } });
      expect(batch.concurrency).toBe(2);
      expect(h.peak).toBeLessThanOrEqual(4);
      const queued = h.registry.spawn('minion');
      await tick();
      expect(h.registry.residents.queued).toBe(1); // at cap: 4/4 with implementer+lead+pair child+extra
      await Promise.all([extra.dispose(), first.dispose(), lead.dispose()]);
      batch.finish();
      await round.close();
      const admitted = await queued;
      await admitted.dispose();
      await implementer.dispose();
      expect(h.registry.residents.occupied).toBe(0);
    } finally { h.cleanup(); }
  });
});
