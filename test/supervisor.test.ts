import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi, type NotificationRecord } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import {
  Supervisor,
  type AgentSupervisionView,
  type SupervisorRegistry,
} from '../src/supervision/supervisor.js';
import type { Role } from '../src/config.js';
import type {
  AgentCapabilities,
  AgentHandle,
  AgentState,
  RuntimeEvent,
  SpawnOptions,
} from '../src/runtime/types.js';
import type { AgentEventEnvelope } from '../src/runtime/registry.js';

/**
 * Supervisor tests (EPICS E7 story 4): a controllable registry + handles
 * drive the ladder, breaker, watchdog, and ack re-arm end to end through
 * the REAL notification center + ledger.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-supervisor-'));
  cleanupDirs.push(dir);
  return dir;
}

class FakeHandle implements AgentHandle {
  readonly role: Role;
  readonly id: string;
  readonly sessionFile: string | null;
  readonly capabilities: AgentCapabilities = {
    streaming: true,
    steer: 'native',
    resume: 'file',
    images: false,
    thinking: false,
    thinkingLevelControl: false,
    followUp: false,
  };
  state: AgentState = 'idle';
  disposed = false;
  promptCount = 0;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();

  constructor(role: Role, id: string, sessionFile: string | null) {
    this.role = role;
    this.id = id;
    this.sessionFile = sessionFile;
  }

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  setState(state: AgentState, error?: string): void {
    this.state = state;
    this.emit({ type: 'state', state, ...(error !== undefined ? { error } : {}) });
  }

  async prompt(): Promise<void> {
    this.promptCount += 1;
  }
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  health() {
    return {
      state: this.state,
      lastActivity: new Date().toISOString(),
      ...(this.state === 'error' ? { error: 'stub' } : {}),
      sessionFile: this.sessionFile,
    };
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.setState('disposed');
  }
}

class FakeRegistry implements SupervisorRegistry {
  private readonly listeners = new Set<(envelope: AgentEventEnvelope) => void>();
  readonly handlesById = new Map<string, FakeHandle>();
  readonly spawnCalls: { role: Role; resumeFile: string | null }[] = [];
  /** Monotonic: a disposed handle's id is never re-minted. */
  private nextId = 0;
  /** Replace to control spawn behavior (default: resume keeps the
   * session id — mirroring the real adapters' resume semantics; a fresh
   * spawn mints a new one). */
  spawnImpl: (role: Role, options?: SpawnOptions) => Promise<FakeHandle> = async (role, options) =>
    options?.resumeFile !== undefined && options.resumeFile !== null
      ? new FakeHandle(role, `${role}-resumed-${++this.nextId}`, options.resumeFile)
      : new FakeHandle(role, `${role}-${++this.nextId}`, null);

  private emit(envelope: AgentEventEnvelope): void {
    for (const listener of this.listeners) listener(envelope);
  }

  onAgentEvent(listener: (envelope: AgentEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getHandle(agentId: string): AgentHandle | null {
    return this.handlesById.get(agentId) ?? null;
  }

  async spawn(role: Role, options?: SpawnOptions): Promise<AgentHandle> {
    this.spawnCalls.push({ role, resumeFile: options?.resumeFile ?? null });
    const handle = await this.spawnImpl(role, options);
    this.adopt(handle);
    return handle;
  }

  /** Mimic the real registry's tap: spawned envelope + event forwarding
   * + a disposed envelope when the handle's state event says disposed. */
  adopt(handle: FakeHandle): void {
    this.handlesById.set(handle.id, handle);
    this.emit({ agentId: handle.id, role: handle.role, sessionFile: handle.sessionFile, phase: 'spawned' });
    handle.subscribe((event) => {
      this.emit({
        agentId: handle.id,
        role: handle.role,
        sessionFile: handle.sessionFile,
        phase: 'event',
        event,
      });
      if (event.type === 'state' && event.state === 'disposed') {
        this.handlesById.delete(handle.id);
        this.emit({ agentId: handle.id, role: handle.role, sessionFile: handle.sessionFile, phase: 'disposed' });
      }
    });
  }

  async disposeHandle(handle: AgentHandle): Promise<void> {
    const fake = this.handlesById.get(handle.id);
    this.handlesById.delete(handle.id);
    await (fake ?? (handle as FakeHandle)).dispose();
  }
}

interface Harness {
  registry: FakeRegistry;
  api: LedgerApi;
  center: NotificationCenter;
  supervisor: Supervisor;
  nowMs: number;
  /** Simulated wall-clock tick: advance + one supervisor tick. */
  advance(ms: number): void;
  notificationsOfKind(kind: string): readonly NotificationRecord[];
  dispose(): void;
}

function boot(): Harness {
  const dir = tmpDir();
  const db = new LedgerDb(dir);
  const bus = new EventBus();
  const api = new LedgerApi(db.handle, { bus });
  const center = new NotificationCenter({ ledger: api, bus });
  const registry = new FakeRegistry();
  let supervisorRef: Supervisor | null = null;
  const harness: Harness = {
    registry,
    api,
    center,
    supervisor: null as unknown as Supervisor,
    nowMs: 1_000_000,
    advance(ms: number) {
      harness.nowMs += ms;
      // One immediate tick stand-in (the interval runs; tests call this
      // to drive deterministic progression).
      (supervisorRef as unknown as { tick(): void } | null)?.tick();
    },
    notificationsOfKind(kind: string) {
      return api.listNotifications({ limit: 100 }).filter((n) => n.kind === kind);
    },
    dispose(): void {
      supervisorRef?.dispose();
      db.close();
    },
  };
  const supervisor = new Supervisor({
    config: {
      enabled: true,
      turnSilenceMs: 50,
      restartWindowMs: 600_000,
      maxRestarts: 3,
      restartBackoffMs: 1,
    },
    registry,
    ledger: api,
    notifications: center,
    tickMs: 5,
    now: () => harness.nowMs,
  });
  supervisorRef = supervisor;
  harness.supervisor = supervisor;
  return harness;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Hang a handle: open a turn, go streaming, then let silence accrue. */
function hang(handle: FakeHandle): void {
  handle.setState('streaming');
  handle.emit({ type: 'turn_start' });
}

describe('supervisor — watchdog + restart ladder', () => {
  let h: Harness;
  beforeAll(() => {
    h = boot();
    h.supervisor.start();
  });
  afterAll(() => h.dispose());

  it('adopts every registry spawn (auto-adoption)', () => {
    const handle = new FakeHandle('gru', 'gru-adopt', null);
    h.registry.adopt(handle);
    const view = h.supervisor.viewFor('gru-adopt');
    expect(view?.state).toBe('watching');
    expect(view?.slotId).toBeNull();
  });

  it('a hung agent climbs the ladder and is restored with resume', async () => {
    const sessionFile = join(tmpDir(), 'gru', 'session.jsonl');
    mkdirSync(join(sessionFile, '..'), { recursive: true });
    writeFileSync(sessionFile, '{}\n', 'utf-8');
    const handle = new FakeHandle('gru', 'gru-hang', sessionFile);
    h.registry.adopt(handle);
    hang(handle);
    h.advance(60); // past turn_silence_ms (50)
    await sleep(20);
    // The wedged handle was disposed...
    expect(handle.disposed).toBe(true);
    // ...a restart spawned with the session file as resume...
    const restartSpawn = h.registry.spawnCalls.find((c) => c.resumeFile === sessionFile);
    expect(restartSpawn).toBeDefined();
    // ...a supervision.restart ledger event landed...
    expect(h.api.listEvents({ limit: 50 }).some((e) => e.kind === 'supervision.restart')).toBe(true);
    // ...and the resumed handle (new session id) is watched, with the
    // ring carried over (the entity, not the session id, is supervised).
    const resumedView = [...h.supervisor.status().agents].find((a) =>
      a.agentId.startsWith('gru-resumed-'),
    );
    expect(resumedView?.state).toBe('watching');
    expect(resumedView?.restarts).toBe(1);
    expect(h.supervisor.viewFor('gru-hang')).toBeNull(); // old id retired
    // The FYI hang notification fired exactly once for the cluster.
    expect(h.notificationsOfKind('supervision.hang').length).toBe(1);
  });

  it('in-band errors NEVER restart (the adapter contract recovers)', async () => {
    const handle = new FakeHandle('minion', 'minion-inband', null);
    h.registry.adopt(handle);
    const spawnsBefore = h.registry.spawnCalls.length;
    handle.setState('streaming');
    handle.emit({ type: 'turn_start' });
    handle.setState('error', 'provider hiccup'); // in-band
    handle.emit({ type: 'turn_end' });
    handle.setState('idle');
    h.advance(60);
    await sleep(20);
    expect(h.registry.spawnCalls.length).toBe(spawnsBefore);
    expect(handle.disposed).toBe(false);
  });

  it('a fatal runtime error climbs the ladder (no silence needed)', async () => {
    const handle = new FakeHandle('perkins', 'perkins-fatal', null);
    h.registry.adopt(handle);
    const spawnsBefore = h.registry.spawnCalls.length;
    handle.emit({ type: 'error', error: 'session stream died', fatal: true });
    await sleep(30);
    expect(h.registry.spawnCalls.length).toBe(spawnsBefore + 1);
    expect(handle.disposed).toBe(true);
    expect(h.notificationsOfKind('supervision.fatal').length).toBe(1);
  });

  it('session-file growth resets the silence clock (alive-but-silent tool run)', async () => {
    const sessionFile = join(tmpDir(), 'gru', 'growing.jsonl');
    mkdirSync(join(sessionFile, '..'), { recursive: true });
    writeFileSync(sessionFile, '{}\n', 'utf-8');
    const handle = new FakeHandle('gru', 'gru-growing', sessionFile);
    h.registry.adopt(handle);
    hang(handle);
    // Growth in three beats, each under the silence threshold.
    for (let beat = 0; beat < 3; beat += 1) {
      h.advance(30); // < 50ms silence
      writeFileSync(sessionFile, `${'x'.repeat(64)}\n`, { flag: 'a' });
      const size = statSync(sessionFile).size;
      expect(size).toBeGreaterThan(0);
    }
    h.advance(30);
    await sleep(20);
    expect(handle.disposed).toBe(false);
    // Silence past the threshold DOES trip.
    h.advance(60);
    await sleep(20);
    expect(handle.disposed).toBe(true);
  });

  it('breaker trips after 3 failed rungs in the window: stop + action-required + board mark', async () => {
    const dir = tmpDir();
    const db = new LedgerDb(dir);
    const bus = new EventBus();
    const api = new LedgerApi(db.handle, { bus });
    const center = new NotificationCenter({ ledger: api, bus });
    const registry = new FakeRegistry();
    let nowMs = 2_000_000;
    // Spawn always fails: the crash loop is instant.
    registry.spawnImpl = async () => {
      throw new Error('spawn exploded');
    };
    const supervisor = new Supervisor({
      config: {
        enabled: true,
        turnSilenceMs: 30,
        restartWindowMs: 600_000,
        maxRestarts: 3,
        restartBackoffMs: 1,
      },
      registry,
      ledger: api,
      notifications: center,
      tickMs: 5,
      now: () => nowMs,
    });
    supervisor.start();

    const handle = new FakeHandle('minion', 'minion-crashloop', null);
    registry.adopt(handle);
    hang(handle);
    nowMs += 60; // silence trips rung 1; failures cascade via backoff
    await sleep(250); // 3 failed rungs + the 4th attempt trips the breaker

    const breakerEvents = api.listEvents({ limit: 50 }).filter((e) => e.kind === 'supervision.breaker');
    expect(breakerEvents.length).toBe(1);
    const escalations = api
      .listNotifications({ limit: 50 })
      .filter((n) => n.kind === 'supervision.breaker');
    expect(escalations.length).toBe(1);
    expect(escalations[0]?.routing).toBe('action-required');
    expect(escalations[0]?.agentId).toBe('minion-crashloop');
    // Exactly 3 spawns attempted, then STOPPED.
    expect(registry.spawnCalls.length).toBe(3);
    const view = supervisor.viewFor('minion-crashloop') as AgentSupervisionView;
    expect(view.state).toBe('stopped');
    expect(view.breakerOpen).toBe(true);

    // ---- ack re-arms: fresh window, the resume attempt succeeds -------
    registry.spawnImpl = async (role) => new FakeHandle(role, 'minion-crashloop-resumed', null);
    supervisor.onNotificationAcked(escalations[0]!.id);
    await sleep(50);
    const rearmView = supervisor.viewFor('minion-crashloop-resumed') as AgentSupervisionView;
    expect(rearmView.state).toBe('watching');
    expect(rearmView.breakerOpen).toBe(false);
    expect(rearmView.restarts).toBe(1); // ring cleared, one fresh rung
    expect(registry.spawnCalls.length).toBe(4);
    // The stopped record for the OLD agent id is gone (new session id) —
    // the re-armed agent is the resumed one.
    expect(supervisor.viewFor('minion-crashloop')).toBeNull();
    // A SECOND trip after re-arm escalates a NEW notification (no silent flapping).
    registry.spawnImpl = async () => {
      throw new Error('spawn exploded again');
    };
    const resumed = registry.getHandle('minion-crashloop-resumed') as FakeHandle;
    hang(resumed);
    nowMs += 60;
    await sleep(250);
    const secondEscalations = api
      .listNotifications({ limit: 50 })
      .filter((n) => n.kind === 'supervision.breaker');
    expect(secondEscalations.length).toBe(2);
    expect(supervisor.viewFor('minion-crashloop-resumed')?.state).toBe('stopped');

    supervisor.dispose();
    db.close();
  });
});

describe('supervisor — hang-loop breaker flavor (successful restarts that keep dying)', () => {
  it('the stopped record SURVIVES the trip dispose; the ack re-arms and resumes', async () => {
    const dir = tmpDir();
    const db = new LedgerDb(dir);
    const bus = new EventBus();
    const api = new LedgerApi(db.handle, { bus });
    const center = new NotificationCenter({ ledger: api, bus });
    const registry = new FakeRegistry();
    let nowMs = 3_000_000;
    // Every respawn SUCCEEDS — and hangs again immediately (the crash
    // loop is behavioral, not spawn failures).
    registry.spawnImpl = async (role, options) => {
      const handle = new FakeHandle(
        role,
        `loop-${registry.handlesById.size + 1}`,
        options?.resumeFile ?? null,
      );
      handle.setState('streaming'); // hangs from birth; the tick's health probe sees it
      return handle;
    };
    const supervisor = new Supervisor({
      config: {
        enabled: true,
        turnSilenceMs: 30,
        restartWindowMs: 600_000,
        maxRestarts: 3,
        restartBackoffMs: 1,
      },
      registry,
      ledger: api,
      notifications: center,
      tickMs: 5,
      now: () => nowMs,
    });
    supervisor.start();
    // Seed a session file so the loop agent has a resume target.
    const sessionFile = join(tmpDir(), 'loop.jsonl');
    mkdirSync(join(sessionFile, '..'), { recursive: true });
    writeFileSync(sessionFile, '{}\n', 'utf-8');
    const first = new FakeHandle('minion', 'loop-first', sessionFile);
    registry.adopt(first);
    hang(first);
    // Rung 1..3: each respawn hangs again (silence 40 > 30); rung 4 trips.
    for (let round = 0; round < 6; round += 1) {
      nowMs += 40;
      await sleep(30);
    }
    const escalation = api
      .listNotifications({ limit: 50 })
      .find((n) => n.kind === 'supervision.breaker');
    expect(escalation).toBeDefined();
    // The STOPPED record (under the carried-over session id) SURVIVED the
    // trip dispose — breaker-open stickiness keeps it for the ack re-arm.
    const view = supervisor.viewFor(escalation!.agentId ?? '');
    expect(view).not.toBeNull();
    expect(view?.state).toBe('stopped');
    expect(view?.breakerOpen).toBe(true);
    // ...and the ack re-arms with a successful resume.
    registry.spawnImpl = async (role, options) =>
      new FakeHandle(role, 'loop-recovered', options?.resumeFile ?? null);
    supervisor.onNotificationAcked(escalation!.id);
    await sleep(50);
    expect(supervisor.viewFor('loop-recovered')?.state).toBe('watching');
    expect(supervisor.viewFor('loop-recovered')?.breakerOpen).toBe(false);
    supervisor.dispose();
    db.close();
  });
});

describe('supervisor — declared slots (the Gru chat session shape)', () => {
  it('ensure returns the live handle; a supervisor restart swaps it and fires onSwap', async () => {
    const h = boot();
    const first = new FakeHandle('gru', 'gru-slot', null);
    h.registry.adopt(first);
    const slot = h.supervisor.declareSlot({
      id: 'gru-main',
      role: 'gru',
      spawn: (options) => h.registry.spawn('gru', options),
    });
    // No handle yet for the SLOT: ensure spawns through the factory.
    const ensured = await slot.ensure({});
    expect(ensured.id).not.toBe('gru-slot');

    // Restart via hang: the slot's CURRENT handle is replaced and swap fires.
    const swapped: FakeHandle[] = [];
    slot.onSwap((handle) => swapped.push(handle as FakeHandle));
    const before = ensured as FakeHandle;
    hang(before);
    h.advance(60);
    await sleep(30);
    expect(before.disposed).toBe(true);
    expect(swapped.length).toBe(1);
    expect(slot.current()?.id).toBe(swapped[0]?.id);
    // The new handle is bound to the slot (restart uses slot.spawn).
    const view = h.supervisor.viewFor(swapped[0]!.id);
    expect(view?.slotId).toBe('gru-main');
    h.dispose();
  });
});

describe('supervisor — /health status shape', () => {
  it('reports config + per-agent views', () => {
    const h = boot();
    h.registry.adopt(new FakeHandle('gru', 'gru-status', null));
    const status = h.supervisor.status();
    expect(status.enabled).toBe(true);
    expect(status.turnSilenceMs).toBe(50);
    expect(status.maxRestarts).toBe(3);
    expect(status.agents.some((a) => a.agentId === 'gru-status' && a.state === 'watching')).toBe(true);
    h.dispose();
  });
});

describe('supervisor — Perkins r1 fixes', () => {
  it('BLOCKER r1-1: a dead slot record never shadows the live handle — no duplicate spawns', async () => {
    const h = boot();
    const slot = h.supervisor.declareSlot({
      id: 'gru-main',
      role: 'gru',
      spawn: (options) => h.registry.spawn('gru', options),
    });
    const first = (await slot.ensure({})) as FakeHandle;
    // Owner teardown (death OUTSIDE a restart rung): disposed envelope,
    // slot-bound record goes stale with a null handle.
    await h.registry.disposeHandle(first);
    // The next ensure spawns a replacement ONCE…
    const second = (await slot.ensure({})) as FakeHandle;
    expect(second.id).not.toBe(first.id);
    expect(h.registry.spawnCalls.length).toBe(2);
    // …and every LATER ensure returns THAT handle — never a third live
    // Gru (single-writer, SPEC ruling 1).
    const third = await slot.ensure({});
    expect(third.id).toBe(second.id);
    expect(h.registry.spawnCalls.length).toBe(2);
    // Exactly one slot-bound record remains, watching the live handle.
    const bound = [...h.supervisor.status().agents].filter((a) => a.slotId === 'gru-main');
    expect(bound.length).toBe(1);
    expect(bound[0]?.state).toBe('watching');
    h.dispose();
  });

  it('r1-2: supervision.enabled=false gates EVERY side-effect — pure registry behavior', async () => {
    const dir = tmpDir();
    const db = new LedgerDb(dir);
    const bus = new EventBus();
    const api = new LedgerApi(db.handle, { bus });
    const center = new NotificationCenter({ ledger: api, bus });
    const registry = new FakeRegistry();
    const supervisor = new Supervisor({
      config: {
        enabled: false,
        turnSilenceMs: 30,
        restartWindowMs: 600_000,
        maxRestarts: 3,
        restartBackoffMs: 1,
      },
      registry,
      ledger: api,
      notifications: center,
      tickMs: 5,
    });
    supervisor.start();
    const handle = new FakeHandle('gru', 'disabled-gru', null);
    registry.adopt(handle);
    // Fatal runtime error: observed, NEVER acted on.
    handle.emit({ type: 'error', error: 'boom', fatal: true });
    await sleep(30);
    expect(registry.spawnCalls.length).toBe(0);
    expect(handle.disposed).toBe(false);
    // A hang past the silence window: the tick is inert.
    hang(handle);
    await sleep(80);
    expect(handle.disposed).toBe(false);
    expect(registry.spawnCalls.length).toBe(0);
    // No supervision notifications, no supervision events, no breaker.
    expect(api.listNotifications({ limit: 50 }).filter((n) => n.kind.startsWith('supervision.'))).toEqual([]);
    expect(api.listEvents({ limit: 100 }).filter((e) => e.kind.startsWith('supervision.'))).toEqual([]);
    const view = supervisor.viewFor('disabled-gru');
    expect(view?.state).toBe('watching'); // observed only
    supervisor.dispose();
    db.close();
  });

  it('r1-15: restarts aged OUT of the window do not trip the breaker', async () => {
    const h = boot();
    const handle = new FakeHandle('minion', 'window-minion', null);
    h.registry.adopt(handle);
    // Two hang-restarts separated by MORE than the window (10 min).
    for (let round = 0; round < 2; round += 1) {
      const current = (h.registry.getHandle('window-minion') ?? h.supervisor.status().agents.find((a) => a.agentId.startsWith('minion-resumed'))) as FakeHandle | undefined;
      const target = current ?? handle;
      hang(target);
      h.advance(60);
      await sleep(30);
      h.advance(601_000); // age the ring out between incidents
    }
    const view = [...h.supervisor.status().agents].find((a) => a.role === 'minion');
    expect(view?.breakerOpen).toBe(false);
    expect((view?.restarts ?? 0)).toBeLessThanOrEqual(1); // the aged ring pruned
    expect(h.notificationsOfKind('supervision.breaker').length).toBe(0);
    h.dispose();
  });

  it('r1-17/#24: slot use on an open breaker re-arms supervision AND acks the escalation row', async () => {
    const h = boot();
    const slot = h.supervisor.declareSlot({
      id: 'gru-main',
      role: 'gru',
      spawn: (options) => h.registry.spawn('gru', options),
    });
    const first = (await slot.ensure({})) as FakeHandle;
    // Burn the ladder to a trip: the handle HANGS and every respawn fails.
    h.registry.spawnImpl = async () => {
      throw new Error('spawn exploded');
    };
    hang(first);
    h.advance(60);
    await sleep(250); // rungs 1-3 fail fast; the 4th need trips
    const escalation = h.notificationsOfKind('supervision.breaker')[0];
    expect(escalation).toBeDefined();
    // Heal spawns; slot use re-arms + acks the escalation row.
    h.registry.spawnImpl = async (role) => new FakeHandle(role, 'slot-recovered', null);
    await slot.ensure({});
    await sleep(20);
    const acked = h.api.getNotification(escalation!.id);
    expect(acked?.ackedAt).not.toBeNull();
    expect(acked?.ackedBy).toBe('slot-use');
    const view = h.supervisor.viewFor('slot-recovered');
    expect(view?.state).toBe('watching');
    expect(view?.breakerOpen).toBe(false);
    h.dispose();
  });
});
