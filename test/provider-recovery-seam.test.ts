import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { Supervisor, type SupervisorRegistry } from '../src/supervision/supervisor.js';
import { buildHealthPayload } from '../src/server.js';
import type { GruCommandConfig } from '../src/config.js';
import type { Role } from '../src/config.js';
import type {
  AgentCapabilities,
  AgentHandle,
  AgentState,
  PendingTurn,
  RuntimeEvent,
  SpawnOptions,
} from '../src/runtime/types.js';
import type { AgentEventEnvelope } from '../src/runtime/registry.js';
import { establishProviderWait, ProviderRecoverySensor } from '../src/provider-recovery/sensor.js';
import type { ProviderProbePort, ProbeOutcome, ProbeRoute } from '../src/provider-recovery/probe.js';
import { DEFAULT_PROVIDER_RECOVERY_CONFIG } from '../src/config.js';

/**
 * The supervisor ⇄ sensor seam: a real Supervisor with a real notification
 * center stops a minion on a structured GLM quota rejection; the wall
 * observation reaches the sensor sink and becomes an explicit provider
 * wait; the guarded owned re-arm later re-arms exactly that agent. The
 * provider transport itself is a deterministic fake — no live calls.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

const FAKE_CAPABILITIES: AgentCapabilities = {
  streaming: true,
  steer: 'native',
  resume: 'file',
  images: false,
  thinking: false,
  thinkingLevelControl: false,
  followUp: false,
};

class FakeHandle implements AgentHandle {
  readonly role: Role;
  readonly id: string;
  readonly sessionFile: string | null;
  readonly capabilities = FAKE_CAPABILITIES;
  disposed = false;
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();
  constructor(role: Role, id: string, sessionFile: string | null) {
    this.role = role;
    this.id = id;
    this.sessionFile = sessionFile;
  }
  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  async prompt(): Promise<void> {}
  async steer(): Promise<void> {}
  async followUp(): Promise<void> {}
  readonly pendingTurn = (): PendingTurn | null => ({
    text: 'the interrupted briefing turn',
    owner: 'minion-brief',
  });
  readonly hasLiveProcess = (): boolean => false;
  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  health(): { state: AgentState; lastActivity: string; sessionFile: string | null } {
    return {
      state: this.disposed ? 'disposed' : 'idle',
      lastActivity: new Date().toISOString(),
      sessionFile: this.sessionFile,
    };
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.emit({ type: 'state', state: 'disposed' });
  }
}

class FakeRegistry implements SupervisorRegistry {
  private readonly listeners = new Set<(envelope: AgentEventEnvelope) => void>();
  readonly handles = new Map<string, FakeHandle>();
  private next = 0;
  onAgentEvent(listener: (envelope: AgentEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  emit(envelope: AgentEventEnvelope): void {
    for (const listener of this.listeners) listener(envelope);
  }
  getHandle(agentId: string): AgentHandle | null {
    return this.handles.get(agentId) ?? null;
  }
  spawns = 0;
  async spawn(role: Role, options?: SpawnOptions): Promise<AgentHandle> {
    this.next += 1;
    this.spawns += 1;
    const handle = new FakeHandle(role, `agent-${this.next}`, options?.resumeFile ?? null);
    this.handles.set(handle.id, handle);
    this.emit({ agentId: handle.id, role, sessionFile: handle.sessionFile, phase: 'spawned' });
    this.wireTap(handle, role);
    return handle;
  }
  /** Mirror the real registry: handle events flow through the tap. */
  wireTap(handle: FakeHandle, role: Role): void {
    handle.subscribe((event) => {
      this.emit({ agentId: handle.id, role, sessionFile: handle.sessionFile, phase: 'event', event });
    });
  }
  async disposeHandle(handle: AgentHandle): Promise<void> {
    this.handles.delete(handle.id);
    await handle.dispose();
  }
}

class SensorProbe implements ProviderProbePort {
  fingerprint = 'fp00000000000001';
  endpoint = 'https://open.bigmodel.cn/api/coding/paas/v4';
  outcome: ProbeOutcome = { kind: 'still-limited', status: 429, retryAfterMs: null, detail: 'limited' };
  readonly calls: ProbeRoute[] = [];
  probe(route: ProbeRoute): Promise<ProbeOutcome> {
    this.calls.push(route);
    return Promise.resolve(this.outcome);
  }
  resolveRoute(): Promise<{ endpoint: string; credentialFingerprint: string } | null> {
    return Promise.resolve({ endpoint: this.endpoint, credentialFingerprint: this.fingerprint });
  }
}

class SeamHarness {
  readonly ledger: LedgerApi;
  readonly notifications: NotificationCenter;
  readonly registry = new FakeRegistry();
  readonly probe = new SensorProbe();
  readonly observations: Parameters<
    NonNullable<import('../src/supervision/supervisor.js').ProviderWallSink>['onProviderWall']
  >[0][] = [];
  readonly ownershipChecks: Parameters<
    NonNullable<NonNullable<import('../src/supervision/supervisor.js').ProviderWallSink>['ownsProviderWall']>
  >[0][] = [];
  readonly wakes: { kind: string; routeKey: string }[] = [];
  supervisor: Supervisor;
  sensor: ProviderRecoverySensor;

  constructor() {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-pr-seam-'));
    cleanupDirs.push(dir);
    const db = new LedgerDb(dir);
    const bus = new EventBus();
    this.ledger = new LedgerApi(db.handle, { bus });
    this.notifications = new NotificationCenter({ ledger: this.ledger, bus });
    this.sensor = new ProviderRecoverySensor({
      config: { ...DEFAULT_PROVIDER_RECOVERY_CONFIG, enabled: true },
      ledger: this.ledger,
      probe: this.probe,
      notifications: this.notifications,
      wake: {
        trigger: async (input) => {
          this.wakes.push({ ...input });
        },
      },
      silasHosted: () => true,
    });
    const sensor = this.sensor;
    this.supervisor = new Supervisor({
      config: {
        enabled: true,
        turnSilenceMs: 60_000,
        restartWindowMs: 600_000,
        maxRestarts: 3,
        restartBackoffMs: 1_000,
      },
      registry: this.registry,
      ledger: this.ledger,
      notifications: this.notifications,
      providerWalls: {
        // Mirrors the production wiring: machine-ownership decided BEFORE
        // any owner stop; the persisted wait is the only `true` answer.
        ownsProviderWall: async (input) => {
          this.ownershipChecks.push(input);
          const wait = await establishProviderWait(sensor, {
            agentId: input.agentId,
            role: input.role,
            slotId: input.slotId,
            jobId: input.jobId,
            sessionFile: input.sessionFile,
            failureClass: input.failureClass,
            provider: input.source?.provider ?? null,
            model: input.source?.model ?? null,
            errorMessage: input.source?.error ?? '',
            typed: input.source?.typed ?? null,
            incidentId: null,
            continuation: input.continuation,
          }).catch(() => null);
          return wait !== null;
        },
        linkProviderWaitIncident: ({ agentId, incidentId }) => {
          const wait = this.ledger.openProviderWaitForAgent(agentId);
          if (wait !== null) this.ledger.setProviderWaitIncident(wait.id, incidentId);
        },
        onProviderWall: (observation) => {
          this.observations.push(observation);
          void establishProviderWait(sensor, {
            agentId: observation.agentId,
            role: observation.role,
            slotId: observation.slotId,
            jobId: observation.jobId,
            sessionFile: observation.sessionFile,
            failureClass: observation.failureClass,
            provider: observation.source?.provider ?? null,
            model: observation.source?.model ?? null,
            errorMessage: observation.source?.error ?? '',
            typed: observation.source?.typed ?? null,
            incidentId: observation.incidentId,
            continuation: observation.continuation,
          }).catch(() => {});
        },
      },
      tickMs: 5_000,
      now: () => Date.parse('2026-09-28T10:00:00Z'),
    });
    this.supervisor.start();
  }

  /** A live minion with an open turn, then a structured GLM quota error. */
  async runMinionIntoQuotaWall(jobId: string): Promise<FakeHandle> {
    const sessionDir = mkdtempSync(join(tmpdir(), 'pr-seam-session-'));
    cleanupDirs.push(sessionDir);
    const sessionFile = join(sessionDir, 'minion.jsonl');
    writeFileSync(sessionFile, '{}\n');
    this.ledger.addJob({ id: jobId, repo: 'https://github.com/example/repo', title: 'job' });
    this.ledger.setJobStatus(jobId, 'working');
    const handle = new FakeHandle('minion', `agent-${jobId}`, sessionFile);
    this.registry.handles.set(handle.id, handle);
    this.registry.emit({
      agentId: handle.id,
      role: 'minion',
      sessionFile,
      phase: 'spawned',
    });
    this.registry.wireTap(handle, 'minion');
    this.ledger.registerAgent({ id: handle.id, role: 'minion', jobId, sessionFile });
    // Open turn, then the provider rejection.
    handle.emit({ type: 'turn_start' });
    handle.emit({
      type: 'error',
      error: '429: {"error":{"code":"1302","message":"usage window limit reached"}}',
      fatal: false,
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      typed: { origin: 'provider-message', status: 429, bodyCode: '1302' },
    });
    return handle;
  }

  /** A live minion whose error is an OWNER-controlled auth wall. */
  async runMinionIntoAuthWall(jobId: string): Promise<FakeHandle> {
    const sessionDir = mkdtempSync(join(tmpdir(), 'pr-seam-session-'));
    cleanupDirs.push(sessionDir);
    const sessionFile = join(sessionDir, 'minion.jsonl');
    writeFileSync(sessionFile, '{}\n');
    this.ledger.addJob({ id: jobId, repo: 'https://github.com/example/repo', title: 'job' });
    this.ledger.setJobStatus(jobId, 'working');
    const handle = new FakeHandle('minion', `agent-${jobId}`, sessionFile);
    this.registry.handles.set(handle.id, handle);
    this.registry.emit({ agentId: handle.id, role: 'minion', sessionFile, phase: 'spawned' });
    this.registry.wireTap(handle, 'minion');
    this.ledger.registerAgent({ id: handle.id, role: 'minion', jobId, sessionFile });
    handle.emit({ type: 'turn_start' });
    handle.emit({
      type: 'error',
      error: '401: {"error":{"code":"1002","message":"invalid api key"}}',
      fatal: false,
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      typed: { origin: 'provider-message', status: 401, bodyCode: '1002' },
    });
    return handle;
  }

  settle(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 30));
  }
}

describe('attention surface wiring (acceptance 9)', () => {
  it('the token-gated /health payload carries the concise waiting view', () => {
    const config = {
      workspaceRoot: '/w',
      dataDir: '/d',
    } as unknown as GruCommandConfig;
    const identity = { installId: 'i', createdAt: '2026-01-01T00:00:00Z' } as never;
    const payload = buildHealthPayload(
      config,
      identity,
      process.hrtime.bigint(),
      'req-1',
      null,
      null,
      null,
      null,
      [
        {
          route: 'zai-coding-cn/glm-5.3@fp',
          provider: 'zai-coding-cn',
          model: 'glm-5.3',
          waiters: 2,
          nextCheckAt: '2026-09-28T10:05:00Z',
          lastResult: 'still-limited',
          lastAttemptAt: '2026-09-28T10:00:00Z',
        },
      ],
    );
    expect(payload.providerRecovery).toEqual([
      {
        route: 'zai-coding-cn/glm-5.3@fp',
        provider: 'zai-coding-cn',
        model: 'glm-5.3',
        waiters: 2,
        nextCheckAt: '2026-09-28T10:05:00Z',
        lastResult: 'still-limited',
        lastAttemptAt: '2026-09-28T10:00:00Z',
      },
    ]);
    // Default (sensor not wired) keeps the pre-feature shape: null.
    const bare = buildHealthPayload(config, identity, process.hrtime.bigint(), 'req-2');
    expect(bare.providerRecovery).toBeNull();
  });
});

describe('supervisor ⇄ sensor seam', () => {
  it('a structured GLM quota wall stop becomes an explicit provider wait — machine-owned BEFORE any owner stop', async () => {
    const h = new SeamHarness();
    const handle = await h.runMinionIntoQuotaWall('job-seam-1');
    await h.settle();
    // The supervisor stopped the agent. Machine ownership was decided
    // BEFORE the notice: MACHINE attention (action-required), and ZERO
    // needs-owner chimes for a newly eligible wait (r1 #2, phase3).
    const incident = h.ledger
      .listNotifications({ unackedOnly: true })
      .find((n) => n.kind.startsWith('supervision.provider-wall.'));
    expect(incident).toBeDefined();
    expect(incident?.routing).toBe('action-required');
    expect(h.ledger.listNotifications({ routing: 'needs-owner' })).toHaveLength(0);
    // The ownership decision observed the structured evidence...
    expect(h.ownershipChecks).toHaveLength(1);
    expect(h.ownershipChecks[0]?.source).toMatchObject({ provider: 'zai-coding-cn', model: 'glm-5.3' });
    expect(h.ownershipChecks[0]?.continuation?.promptText).toBe('the interrupted briefing turn');
    // ...and the persisted wait IS that decision: eligible, bound, linked.
    const waits = h.ledger.listProviderWaits({ status: 'waiting' });
    expect(waits).toHaveLength(1);
    expect(waits[0]?.agentId).toBe(handle.id);
    expect(waits[0]?.continuation?.promptOwner).toBe('minion-brief');
    expect(waits[0]?.incidentId).toBe(incident?.id);
    // The stop itself is unchanged: the handle is disposed.
    expect(handle.disposed).toBe(true);
  });

  it('an auth wall keeps the conservative owner stop and never becomes a wait', async () => {
    const h = new SeamHarness();
    await h.runMinionIntoAuthWall('job-auth');
    await h.settle();
    expect(h.observations).toHaveLength(1);
    expect(h.observations[0]?.failureClass).toBe('authentication_wall');
    expect(h.ledger.listProviderWaits()).toHaveLength(0);
    // Owner control preserved: the conservative needs-owner stop still posts.
    expect(h.ledger.listNotifications({ routing: 'needs-owner' })).toHaveLength(1);
  });

  it('an unsupported provider wall keeps the conservative owner stop (no machine notice, no wait)', async () => {
    const h = new SeamHarness();
    const dir = mkdtempSync(join(tmpdir(), 'pr-seam-unsup-'));
    cleanupDirs.push(dir);
    const handle = new FakeHandle('minion', 'agent-unsup', join(dir, 's.jsonl'));
    mkdirSync(dirname(handle.sessionFile as string), { recursive: true });
    writeFileSync(handle.sessionFile as string, '{}\n');
    h.registry.handles.set(handle.id, handle);
    h.registry.emit({ agentId: handle.id, role: 'minion', sessionFile: handle.sessionFile, phase: 'spawned' });
    h.registry.wireTap(handle, 'minion');
    h.ledger.addJob({ id: 'job-unsup', repo: 'https://github.com/example/repo', title: 'job' });
    h.ledger.setJobStatus('job-unsup', 'working');
    h.ledger.registerAgent({ id: handle.id, role: 'minion', jobId: 'job-unsup', sessionFile: handle.sessionFile });
    handle.emit({
      type: 'error',
      error: '429: {"error":{"code":"9999"}}',
      fatal: false,
      provider: 'some-other-provider',
      model: 'model-x',
      typed: { origin: 'provider-message', status: 429, bodyCode: '9999' },
    });
    await h.settle();
    expect(h.ledger.listProviderWaits()).toHaveLength(0);
    expect(h.ledger.listNotifications({ routing: 'needs-owner' })).toHaveLength(1);
    expect(h.ledger.listNotifications({ routing: 'action-required' })).toHaveLength(0);
  });

  it('the guarded owned re-arm clears exactly the provider-stopped breaker', async () => {
    const h = new SeamHarness();
    const handle = await h.runMinionIntoQuotaWall('job-seam-2');
    await h.settle();
    const wait = h.ledger.listProviderWaits({ status: 'waiting' })[0]!;
    // Recovery flips the wait and the service re-arms the same agent.
    h.ledger.setProviderWaitStatus(wait.id, 'recovered-pending');
    const rearmed = h.supervisor.ownedProviderReArm(handle.id, wait.id);
    expect(rearmed).toBe(true);
    const events = h.ledger.listEvents({ limit: 20 }).filter((e) => e.kind === 'supervision.rearmed');
    expect(events.some((e) => e.payload !== null && typeof e.payload === 'object' && (e.payload as { by?: string }).by === 'provider-recovery')).toBe(true);
    // A wrong wait id (not this agent's open wait) is refused.
    expect(h.supervisor.ownedProviderReArm(handle.id, 'not-a-wait')).toBe(false);
  });

  it('an ack re-arm still works independently of the sensor path (owner-held auth stop)', async () => {
    const h = new SeamHarness();
    await h.runMinionIntoAuthWall('job-seam-3');
    await h.settle();
    const incident = h.ledger
      .listNotifications({ unackedOnly: true })
      .find((n) => n.kind.startsWith('supervision.provider-wall.'));
    expect(incident).toBeDefined();
    expect(incident?.routing).toBe('needs-owner');
    // The owner's ack (returned by ackNotification) re-arms as before.
    const acked = h.notifications.ack(incident!.id, 'owner');
    expect(acked?.ackedAt).not.toBeNull();
    h.supervisor.onNotificationAcked(incident!.id);
    await h.settle();
    // The respawn happened through the normal ladder.
    expect(h.registry.spawns).toBeGreaterThanOrEqual(1);
  });
});
