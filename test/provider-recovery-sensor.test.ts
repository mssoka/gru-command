import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { DEFAULT_PROVIDER_RECOVERY_CONFIG, type ProviderRecoveryConfig } from '../src/config.js';
import {
  establishProviderWait,
  ProviderRecoverySensor,
  type ProviderWallObservation,
  type RecoveryWakePort,
  type SlotReArmPort,
} from '../src/provider-recovery/sensor.js';
import type { ProbeOutcome, ProviderProbePort, ProbeRoute } from '../src/provider-recovery/probe.js';
import { InMemoryWorktreePort } from './helpers/in-memory-worktrees.js';

/**
 * The provider-recovery sensor contract (owner-approved 2026-09-28),
 * deterministic throughout: a fake clock drives the shared cadence, a
 * scriptable fake probe plays the provider, and the REAL ledger +
 * notification center persist every transition. No live provider calls,
 * no ambient credentials.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

class Harness {
  readonly ledger: LedgerApi;
  readonly bus = new EventBus();
  readonly notifications: NotificationCenter;
  private clockMs = Date.parse('2026-09-28T10:00:00Z');
  readonly probe: FakeProbe;
  readonly wakes: { kind: string; routeKey: string }[] = [];
  readonly reArms: { agentId: string; waitId: string; result: boolean }[] = [];
  private reArmDecision: (agentId: string) => boolean = () => true;
  silasEnabled = true;
  readonly worktrees = new InMemoryWorktreePort(mkdtempSync(join(tmpdir(), 'pr-sensor-wt-')));

  constructor(config: Partial<ProviderRecoveryConfig> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'gru-command-pr-sensor-'));
    cleanupDirs.push(dir);
    const db = new LedgerDb(dir);
    this.ledger = new LedgerApi(db.handle, { bus: this.bus });
    this.notifications = new NotificationCenter({ ledger: this.ledger, bus: this.bus });
    this.probe = new FakeProbe();
    const full: ProviderRecoveryConfig = {
      ...DEFAULT_PROVIDER_RECOVERY_CONFIG,
      enabled: true,
      ...config,
    };
    this.sensor = new ProviderRecoverySensor({
      config: full,
      ledger: this.ledger,
      probe: this.probe,
      notifications: this.notifications,
      wake: this.wakePort(),
      slotReArm: this.reArmPort(),
      silasHosted: () => this.silasEnabled,
      now: () => this.clockMs,
    });
  }

  readonly sensor: ProviderRecoverySensor;

  wakePort(): RecoveryWakePort {
    return {
      trigger: async (input) => {
        this.wakes.push({ ...input });
      },
    };
  }

  reArmPort(): SlotReArmPort {
    return {
      ownedProviderReArm: (agentId, waitId) => {
        const result = this.reArmDecision(agentId);
        this.reArms.push({ agentId, waitId, result });
        return result;
      },
    };
  }

  setReArmDecision(decision: (agentId: string) => boolean): void {
    this.reArmDecision = decision;
  }

  get now(): number {
    return this.clockMs;
  }

  advance(ms: number): void {
    this.clockMs += ms;
  }

  /** A job lane the way the dispatch flow makes one. */
  makeJob(id: string, status = 'working'): void {
    this.ledger.addJob({ id, repo: 'https://github.com/example/repo', title: `job ${id}` });
    if (status !== 'dispatched') this.ledger.setJobStatus(id, status);
  }

  minionObservation(overrides: Partial<ProviderWallObservation> = {}): ProviderWallObservation {
    return {
      agentId: 'agent-minion-1',
      role: 'minion',
      slotId: null,
      jobId: 'job-1',
      sessionFile: '/tmp/minion-1.jsonl',
      failureClass: 'quota_wall',
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      errorMessage: '429: {"error":{"code":"1302","message":"usage window limit"}}',
      incidentId: 'supervision.provider-wall.agent-minion-1.quota_wall',
      continuation: { promptText: 'continue the work', promptOwner: 'minion-brief', hadOpenTurn: true },
      ...overrides,
    };
  }

  async establishMinionWait(overrides: Partial<ProviderWallObservation> = {}) {
    return await establishProviderWait(this.sensor, this.minionObservation(overrides));
  }
}

/** Deterministic fake provider: scripted outcomes + envelope recording. */
class FakeProbe implements ProviderProbePort {
  fingerprint = 'fp00000000000001';
  outcomes: ProbeOutcome[] = [];
  readonly calls: ProbeRoute[] = [];

  probe(route: ProbeRoute): Promise<ProbeOutcome> {
    this.calls.push(route);
    const outcome = this.outcomes.shift();
    if (outcome === undefined) {
      return Promise.resolve({
        kind: 'still-limited',
        status: 429,
        retryAfterMs: null,
        detail: 'still limited',
      });
    }
    return Promise.resolve(outcome);
  }

  credentialFingerprint(): Promise<string | null> {
    return Promise.resolve(this.fingerprint);
  }

  queueCompleted(): void {
    this.outcomes.push({
      kind: 'completed',
      evidence: {
        provider: 'zai-coding-cn',
        model: 'glm-5.3',
        stopReason: 'stop',
        outputTokens: 1,
        totalTokens: 4,
        responseId: 'resp-1',
        responseModel: 'glm-5.3',
        completedAt: '2026-09-28T10:05:00Z',
      },
    });
  }
}

describe('wait establishment (acceptance 1) — explicit evidence only', () => {
  it('a structured 429/GLM-1302 rejection on a supported route establishes a durable wait', async () => {
    const h = new Harness();
    h.makeJob('job-1');
    h.ledger.registerAgent({ id: 'agent-minion-1', role: 'minion', jobId: 'job-1' });
    const wait = await h.establishMinionWait();
    expect(wait).not.toBeNull();
    expect(wait?.routeKey).toBe(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
    expect(wait?.status).toBe('waiting');
    expect(wait?.continuation?.promptText).toBe('continue the work');
    expect(wait?.incidentGeneration).toBe(1);
    const waiting = h.ledger.listProviderWaits({ status: 'waiting' });
    expect(waiting).toHaveLength(1);
    // FYI attention row, never an owner chime.
    const notice = h.ledger.findNotificationByKind(
      `provider.waiting.zai-coding-cn/glm-5.3@${h.probe.fingerprint}`,
      'active',
    );
    expect(notice?.routing).toBe('fyi');
  });

  it('auth walls, billing walls, and ambiguous failures never become waits', async () => {
    const h = new Harness();
    h.makeJob('job-1');
    expect(await h.establishMinionWait({ failureClass: 'authentication_wall', errorMessage: '401: unauthorized' })).toBeNull();
    expect(await h.establishMinionWait({ errorMessage: '402: {"error":{"code":"1113","message":"Insufficient Balance"}}' })).toBeNull();
    expect(await h.establishMinionWait({ errorMessage: 'something exploded' })).toBeNull();
    expect(await h.establishMinionWait({ provider: null, model: null })).toBeNull();
    expect(h.ledger.listProviderWaits()).toHaveLength(0);
  });

  it('unsupported providers and non-quota classes stay owner-controlled', async () => {
    const h = new Harness();
    h.makeJob('job-1');
    expect(await h.establishMinionWait({ provider: 'openai', model: 'gpt-x' })).toBeNull();
    expect(await h.establishMinionWait({ failureClass: 'unknown' })).toBeNull();
  });

  it('roles outside the waiter scope (gru chat, bob) never become waits', async () => {
    const h = new Harness();
    expect(await h.establishMinionWait({ role: 'gru', jobId: null })).toBeNull();
    expect(await h.establishMinionWait({ role: 'bob', jobId: null })).toBeNull();
  });

  it('a prose-only quota wall (no structured provider identity) never becomes a wait', async () => {
    const h = new Harness();
    h.makeJob('job-1');
    expect(await h.establishMinionWait({ provider: null, model: 'glm-5.3', errorMessage: 'quota issues reported in text' })).toBeNull();
  });

  it('disabled config = fully inert recorder', async () => {
    const h = new Harness({ enabled: false });
    h.makeJob('job-1');
    expect(await h.establishMinionWait()).toBeNull();
    expect(h.ledger.listProviderWaits()).toHaveLength(0);
  });

  it('the silas logical slot can establish a wait (COO provider-stopped)', async () => {
    const h = new Harness();
    const wait = await establishProviderWait(h.sensor, {
      agentId: 'agent-silas',
      role: 'silas',
      slotId: 'silas-ops',
      jobId: null,
      sessionFile: '/tmp/silas.jsonl',
      failureClass: 'quota_wall',
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      errorMessage: '429: {"error":{"code":"1302"}}',
      incidentId: 'supervision.provider-wall.agent-silas.quota_wall',
      continuation: { promptText: 'run the sweep', promptOwner: 'silas-driver', hadOpenTurn: true },
    });
    expect(wait?.waiterKind).toBe('silas-slot');
    expect(wait?.slotId).toBe('silas-ops');
  });
});

describe('shared cadence + budget (acceptance 3)', () => {
  it('multiple eligible waiters on one exact route share ONE check per cadence window', async () => {
    const h = new Harness();
    h.makeJob('job-1');
    h.makeJob('job-2');
    h.ledger.registerAgent({ id: 'agent-minion-1', role: 'minion', jobId: 'job-1' });
    h.ledger.registerAgent({ id: 'agent-minion-2', role: 'minion', jobId: 'job-2' });
    await h.establishMinionWait();
    await h.establishMinionWait({
      agentId: 'agent-minion-2',
      jobId: 'job-2',
      sessionFile: '/tmp/minion-2.jsonl',
      incidentId: 'supervision.provider-wall.agent-minion-2.quota_wall',
    });
    await h.sensor.tick();
    expect(h.probe.calls).toHaveLength(1);
    // Not due again inside the 300 s floor...
    h.advance(299_999);
    await h.sensor.tick();
    expect(h.probe.calls).toHaveLength(1);
    // ...but exactly one more shared check after it.
    h.advance(1);
    await h.sensor.tick();
    expect(h.probe.calls).toHaveLength(2);
  });

  it('the rolling budget caps attempts per hour/route (configurable cap, approval ceiling 12)', async () => {
    const h = new Harness({ maxAttemptsPerHour: 2 });
    h.makeJob('job-1');
    await h.establishMinionWait();
    // Budget 2: probes at t=300s and t=600s; t=900s and t=1200s are blocked.
    for (let i = 0; i < 4; i += 1) {
      h.advance(300_000);
      await h.sensor.tick();
    }
    expect(h.probe.calls).toHaveLength(2);
    const capped = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
    // The next eligibility is the window rollover, not the cadence.
    expect(Date.parse(capped?.nextCheckAt ?? '')).toBe(Date.parse(capped?.windowStart ?? '') + 3_600_000);
    // A new hour window re-opens the budget.
    h.advance(3_600_000);
    await h.sensor.tick();
    expect(h.probe.calls).toHaveLength(3);
  });

  it('a trustworthy Retry-After hint schedules within [cadence, cap]', async () => {
    const h = new Harness();
    h.makeJob('job-1');
    await h.establishMinionWait();
    h.probe.outcomes.push({ kind: 'still-limited', status: 429, retryAfterMs: 900_000, detail: 'retry later' });
    await h.sensor.tick();
    const route = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
    expect(Date.parse(route?.nextCheckAt ?? '')).toBe(h.now + 900_000);
    // Below the cadence floor it clamps UP; above the cap it clamps DOWN.
    h.probe.outcomes.push({ kind: 'still-limited', status: 429, retryAfterMs: 10_000, detail: 'soon' });
    h.advance(900_000);
    await h.sensor.tick();
    const clamped = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
    expect(Date.parse(clamped?.nextCheckAt ?? '')).toBe(h.now + 300_000);
    h.probe.outcomes.push({ kind: 'still-limited', status: 429, retryAfterMs: 86_400_000, detail: 'a day' });
    h.advance(300_000);
    await h.sensor.tick();
    const capped = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
    expect(Date.parse(capped?.nextCheckAt ?? '')).toBe(h.now + 3_600_000);
  });

  it('probe (transport) failures back off boundedly and never clear the wait', async () => {
    const h = new Harness();
    h.makeJob('job-1');
    await h.establishMinionWait();
    h.probe.outcomes.push({ kind: 'probe-failed', reason: 'fetch failed', retryAfterMs: null });
    await h.sensor.tick();
    const route1 = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
    expect(route1?.lastResult).toBe('probe-failed');
    expect(Date.parse(route1?.nextCheckAt ?? '')).toBe(h.now + 60_000);
    expect(h.ledger.listProviderWaits({ status: 'waiting' })).toHaveLength(1);
    // Backoff doubles per consecutive failure, capped.
    h.advance(60_000);
    h.probe.outcomes.push({ kind: 'probe-failed', reason: 'timeout', retryAfterMs: null });
    await h.sensor.tick();
    const route2 = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
    expect(Date.parse(route2?.nextCheckAt ?? '')).toBe(h.now + 120_000);
  });

  it('credential rotation during a probe supersedes the waits (route change)', async () => {
    const h = new Harness();
    h.makeJob('job-1');
    await h.establishMinionWait();
    h.probe.outcomes.push({ kind: 'probe-failed', reason: 'credential rotated since the wait was established', retryAfterMs: null });
    await h.sensor.tick();
    expect(h.ledger.listProviderWaits({ status: 'waiting' })).toHaveLength(0);
    expect(h.ledger.listProviderWaits({ status: 'superseded' })).toHaveLength(1);
  });

  it('zero eligible waiters stop polling (demand-gated)', async () => {
    const h = new Harness();
    h.makeJob('job-1');
    await h.establishMinionWait();
    await h.sensor.tick();
    expect(h.probe.calls).toHaveLength(1);
    // The job completes: no waiters remain, no further probes run.
    h.ledger.setJobStatus('job-1', 'delivered');
    h.advance(300_000);
    await h.sensor.tick();
    h.advance(300_000);
    await h.sensor.tick();
    expect(h.probe.calls).toHaveLength(1);
    const route = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
    expect(route?.lastResult).toBe('idle');
  });
});

describe('eligibility invalidation (acceptance 2)', () => {
  it('owner hold (parked) and blocked cancel the wait at the next tick', async () => {
    for (const status of ['parked', 'blocked'] as const) {
      const h = new Harness();
      h.makeJob('job-1');
      await h.establishMinionWait();
      h.ledger.setJobStatus('job-1', status === 'parked' ? 'parked' : 'blocked');
      await h.sensor.tick();
      expect(h.ledger.listProviderWaits({ status: 'cancelled' })).toHaveLength(1);
      expect(h.probe.calls).toHaveLength(0);
    }
  });

  it('cancellation/merging (terminal job states) retire the wait', async () => {
    const h = new Harness();
    h.makeJob('job-1');
    await h.establishMinionWait();
    h.ledger.setJobStatus('job-1', 'done');
    await h.sensor.tick();
    expect(h.ledger.listProviderWaits({ status: 'cancelled' })).toHaveLength(1);
  });

  it('an already-live replacement minion supersedes the wait', async () => {
    const h = new Harness();
    h.makeJob('job-1');
    h.ledger.registerAgent({ id: 'agent-minion-1', role: 'minion', jobId: 'job-1' });
    await h.establishMinionWait();
    // A NEWER minion agent for the same lane appears after the wait.
    h.ledger.registerAgent({ id: 'agent-minion-new', role: 'minion', jobId: 'job-1' });
    await h.sensor.tick();
    expect(h.ledger.listProviderWaits({ status: 'superseded' })).toHaveLength(1);
    expect(h.probe.calls).toHaveLength(0);
  });

  it('a silas-slot wait retires when silas is no longer hosted', async () => {
    const h = new Harness();
    await establishProviderWait(h.sensor, {
      agentId: 'agent-silas',
      role: 'silas',
      slotId: 'silas-ops',
      jobId: null,
      sessionFile: '/tmp/silas.jsonl',
      failureClass: 'quota_wall',
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      errorMessage: '429: {"error":{"code":"1302"}}',
      incidentId: 'i-silas',
      continuation: null,
    });
    h.silasEnabled = false;
    await h.sensor.tick();
    expect(h.ledger.listProviderWaits({ status: 'cancelled' })).toHaveLength(1);
  });

  it('waits survive a service restart without re-baselining (durable cadence)', async () => {
    const h = new Harness();
    h.makeJob('job-1');
    await h.establishMinionWait();
    await h.sensor.tick(); // one attempt spent
    // Simulate the restart: a FRESH sensor instance over the SAME durable
    // ledger (the timer state, wait rows, and budget all reload from it).
    const restartedClock = { ms: h.now + 60_000 };
    const sensor2 = new ProviderRecoverySensor({
      config: { ...DEFAULT_PROVIDER_RECOVERY_CONFIG, enabled: true },
      ledger: h.ledger,
      probe: h.probe,
      notifications: h.notifications,
      wake: h.wakePort(),
      slotReArm: h.reArmPort(),
      silasHosted: () => true,
      now: () => restartedClock.ms,
    });
    // Immediately after the restart the durable cadence is still respected.
    await sensor2.tick();
    expect(h.probe.calls).toHaveLength(1);
    const route = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
    expect(route?.attemptsInWindow).toBe(1);
    restartedClock.ms += 240_001;
    await sensor2.tick();
    expect(h.probe.calls).toHaveLength(2);
  });
});

describe('recovery + delivery (acceptance 5/6)', () => {
  it('completed producer evidence recovers the route once: event, marker, wake, waiter flip', async () => {
    const h = new Harness();
    h.makeJob('job-1');
    await h.establishMinionWait();
    h.probe.queueCompleted();
    await h.sensor.tick();
    const waits = h.ledger.listProviderWaits({ status: 'recovered-pending' });
    expect(waits).toHaveLength(1);
    const restored = h.ledger.listEvents({ limit: 10 }).filter((e) => e.kind === 'provider.restored');
    expect(restored).toHaveLength(1);
    expect(h.ledger.listPendingProviderRecoveries()).toHaveLength(1);
    expect(h.wakes).toEqual([{ kind: 'provider.restored', routeKey: `zai-coding-cn/glm-5.3@${h.probe.fingerprint}` }]);
    // The fyi waiting notice resolves (no stale attention row).
    const waiting = h.ledger.findNotificationByKind(
      `provider.waiting.zai-coding-cn/glm-5.3@${h.probe.fingerprint}`,
      'any',
    );
    expect(waiting?.resolvedAt).not.toBeNull();
  });

  it('a duplicate recovery observation never double-delivers', async () => {
    const h = new Harness();
    h.makeJob('job-1');
    await h.establishMinionWait();
    h.probe.queueCompleted();
    await h.sensor.tick();
    // The waiter is claimed → settled; the marker clears.
    h.ledger.setProviderWaitStatus(h.ledger.listProviderWaits({ status: 'recovered-pending' })[0]!.id, 'claimed');
    await h.sensor.tick(); // settlePendingRecoveries clears the marker
    expect(h.ledger.listPendingProviderRecoveries()).toHaveLength(0);
  });

  it('still-limited and probe-failed outcomes never recover anything', async () => {
    const h = new Harness();
    h.makeJob('job-1');
    await h.establishMinionWait();
    h.probe.outcomes.push({ kind: 'still-limited', status: 429, retryAfterMs: null, detail: 'no' });
    await h.sensor.tick();
    expect(h.ledger.listProviderWaits({ status: 'waiting' })).toHaveLength(1);
    expect(h.ledger.listEvents({ limit: 10 }).filter((e) => e.kind === 'provider.restored')).toHaveLength(0);
    expect(h.wakes).toHaveLength(0);
  });

  it('a silas-slot wait re-arms its own slot deterministically (no LLM needed)', async () => {
    const h = new Harness();
    await establishProviderWait(h.sensor, {
      agentId: 'agent-silas',
      role: 'silas',
      slotId: 'silas-ops',
      jobId: null,
      sessionFile: '/tmp/silas.jsonl',
      failureClass: 'quota_wall',
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      errorMessage: '429: {"error":{"code":"1302"}}',
      incidentId: 'i-silas',
      continuation: null,
    });
    h.probe.queueCompleted();
    await h.sensor.tick();
    expect(h.reArms).toHaveLength(1);
    expect(h.reArms[0]?.agentId).toBe('agent-silas');
    expect(h.wakes).toHaveLength(1);
  });

  it('boot reconciliation re-wakes an un-delivered recovery (lost wake)', async () => {
    const h = new Harness();
    h.makeJob('job-1');
    await h.establishMinionWait();
    h.probe.queueCompleted();
    await h.sensor.tick();
    expect(h.wakes).toHaveLength(1);
    h.wakes.length = 0;
    const result = await h.sensor.reconcileAtBoot();
    expect(result.rewoken).toBe(1);
    expect(h.wakes).toHaveLength(1);
  });

  it('boot reconciliation clears markers whose waiters all settled', async () => {
    const h = new Harness();
    h.makeJob('job-1');
    await h.establishMinionWait();
    h.probe.queueCompleted();
    await h.sensor.tick();
    h.ledger.setProviderWaitStatus(h.ledger.listProviderWaits({ status: 'recovered-pending' })[0]!.id, 'claimed');
    await h.sensor.reconcileAtBoot();
    expect(h.ledger.listPendingProviderRecoveries()).toHaveLength(0);
  });
});

describe('renewed quota + bounded false-recovery escalation (acceptance 7)', () => {
  it('a renewed limit records a new incident, keeps the claimed history, and climbs the ladder', async () => {
    const h = new Harness({ falseRecoveryEscalateAt: 2 });
    h.makeJob('job-1');
    await h.establishMinionWait();
    h.probe.queueCompleted();
    await h.sensor.tick();
    const recoveredId = h.ledger.listProviderWaits({ status: 'recovered-pending' })[0]!.id;
    h.ledger.setProviderWaitStatus(recoveredId, 'claimed');
    // The continuation re-hits the wall: a NEW wait for the same agent.
    const renewed = await h.establishMinionWait({ incidentId: 'supervision.provider-wall.agent-minion-1.quota_wall.2' });
    expect(renewed?.status).toBe('waiting');
    expect(renewed?.incidentGeneration).toBe(2); // a new incident sequence
    // The claimed prior stays claimed (history) — no state laundering.
    expect(h.ledger.getProviderWait(recoveredId)?.status).toBe('claimed');
    expect(h.ledger.listProviderWaits({ status: 'waiting' })).toHaveLength(1);
    const route = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
    expect(route?.falseRecoveryCount).toBe(1);
    expect(route?.incidentSeq).toBe(2);
  });

  it('repeated false recoveries escalate to Gru and suspend the route', async () => {
    const h = new Harness({ falseRecoveryEscalateAt: 2 });
    h.makeJob('job-1');
    // Cycle 1: recover → claim → re-hit.
    await h.establishMinionWait();
    h.probe.queueCompleted();
    await h.sensor.tick();
    const first = h.ledger.listProviderWaits({ status: 'recovered-pending' })[0]!;
    h.ledger.setProviderWaitStatus(first.id, 'claimed');
    await h.establishMinionWait({ incidentId: 'incident-2' });
    // Cycle 2: recover → claim → re-hit → escalation.
    h.advance(300_000);
    h.probe.queueCompleted();
    await h.sensor.tick();
    const second = h.ledger.listProviderWaits({ status: 'recovered-pending' })[0]!;
    h.ledger.setProviderWaitStatus(second.id, 'claimed');
    await h.establishMinionWait({ incidentId: 'incident-3' });
    const escalated = h.ledger.listEvents({ limit: 20 }).find((e) => e.kind === 'provider.false-recovery-escalated');
    expect(escalated).toBeDefined();
    const notice = h.ledger.listNotifications({ unackedOnly: true }).find((n) => n.kind.startsWith('provider.false-recovery.'));
    expect(notice?.routing).toBe('action-required');
    // The route suspends: no probes until suspension_ms elapses.
    h.advance(300_000);
    await h.sensor.tick();
    const after = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
    expect(Date.parse(after?.suspendedUntil ?? '')).toBeGreaterThan(h.now);
    expect(h.probe.calls).toHaveLength(2);
  });
});

describe('sensor lifecycle', () => {
  it('start() is inert when disabled; ticks no-op', async () => {
    const h = new Harness({ enabled: false });
    h.sensor.start();
    h.makeJob('job-1');
    await h.sensor.tick();
    expect(h.probe.calls).toHaveLength(0);
    h.sensor.stop();
  });

  it('the waiting view names route, waiters, next check, and last result', async () => {
    const h = new Harness();
    h.makeJob('job-1');
    await h.establishMinionWait();
    await h.sensor.tick();
    const view = h.sensor.waitingView();
    expect(view).toHaveLength(1);
    expect(view[0]).toMatchObject({
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      waiters: 1,
      lastResult: 'still-limited',
    });
    expect(typeof view[0]?.nextCheckAt).toBe('string');
  });
});
