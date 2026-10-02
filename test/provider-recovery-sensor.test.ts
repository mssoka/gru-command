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
      // The GLM generation fallback is an explicit ACTIVATION guard
      // (default OFF = zero generation, fail closed). Activated-path tests
      // opt in; the guard's default-off behavior has its own test.
      glmGenerationFallback: true,
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
      typed: { origin: 'provider-message', status: 429, bodyCode: '1302' },
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
  /** Test hook: observe when a check actually reaches the transport. */
  onProbeStart?: () => void;
  /** Test hook: override the live route resolution (rotation mid-check). */
  resolveRouteImpl?: (provider: string, model: string) => Promise<{ endpoint: string; credentialFingerprint: string } | null>;

  probe(route: ProbeRoute): Promise<ProbeOutcome> {
    this.calls.push(route);
    this.onProbeStart?.();
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

  endpoint = 'https://open.bigmodel.cn/api/coding/paas/v4';

  resolveRoute(provider: string, model: string): Promise<{ endpoint: string; credentialFingerprint: string } | null> {
    if (this.resolveRouteImpl !== undefined) return this.resolveRouteImpl(provider, model);
    return Promise.resolve({ endpoint: this.endpoint, credentialFingerprint: this.fingerprint });
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

  /** A check that never settles until RELEASED (crash simulation). */
  queueDeferred(): { resolve: (outcome: ProbeOutcome) => void } {
    let releaseFn!: (outcome: ProbeOutcome) => void;
    const promise = new Promise<ProbeOutcome>((resolve) => {
      releaseFn = resolve;
    });
    this.outcomes.push(promise as unknown as ProbeOutcome);
    return { resolve: (outcome) => releaseFn(outcome) };
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
    expect(
      await h.establishMinionWait({
        failureClass: 'authentication_wall',
        errorMessage: '401: unauthorized',
        typed: { origin: 'provider-message', status: 401 },
      }),
    ).toBeNull();
    expect(
      await h.establishMinionWait({
        errorMessage: '402: {"error":{"code":"1113","message":"Insufficient Balance"}}',
        typed: { origin: 'provider-message', status: 402, bodyCode: '1113' },
      }),
    ).toBeNull();
    expect(
      await h.establishMinionWait({ errorMessage: 'something exploded', typed: { origin: 'provider-message' } }),
    ).toBeNull();
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

  it('the GLM generation fallback is an activation guard: default OFF performs ZERO provider I/O', async () => {
    const h = new Harness({ glmGenerationFallback: false });
    h.makeJob('job-guard');
    // Establishment is independent of the readiness path — the wait is
    // durable and explicit either way...
    const wait = await h.establishMinionWait({ jobId: 'job-guard' });
    expect(wait).not.toBeNull();
    // ...but the check fails CLOSED without a readiness path: no probe I/O.
    await h.sensor.tick();
    expect(h.probe.calls).toHaveLength(0);
    const route = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
    expect(route?.lastResult).toBe('probe-failed');
    expect(h.ledger.listProviderWaits({ status: 'waiting' })).toHaveLength(1);
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
      typed: { origin: 'provider-message', status: 429, bodyCode: '1302' },
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
    // r1 #4: the 60 s base backoff is BELOW the 300 s approval floor — the
    // floor wins on every outcome class (no 60 s path).
    expect(Date.parse(route1?.nextCheckAt ?? '')).toBe(h.now + 300_000);
    expect(h.ledger.listProviderWaits({ status: 'waiting' })).toHaveLength(1);
    // The base doubles per consecutive failure (60 → 120 → 240 → 480 s):
    // still floored at 300 s until it passes the floor.
    let lastDelay = 300_000;
    for (const expected of [300_000, 300_000, 480_000]) {
      h.advance(lastDelay);
      h.probe.outcomes.push({ kind: 'probe-failed', reason: 'timeout', retryAfterMs: null });
      await h.sensor.tick();
      const route = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
      expect(Date.parse(route?.nextCheckAt ?? '')).toBe(h.now + expected);
      lastDelay = expected;
    }
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
    // The job completes (done): no eligible waiters remain, no more probes.
    h.ledger.setJobStatus('job-1', 'done');
    h.advance(300_000);
    await h.sensor.tick();
    expect(h.ledger.listProviderWaits({ status: 'cancelled' })).toHaveLength(1);
    h.advance(300_000);
    await h.sensor.tick();
    expect(h.probe.calls).toHaveLength(1);
    const route = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
    expect(route?.lastResult).toBe('idle');
  });
});

describe('eligibility invalidation (acceptance 2)', () => {
  it('parked (owner hold) cancels; a provider-settled BLOCKED job stays eligible through the churn', async () => {
    for (const status of ['parked', 'blocked'] as const) {
      const h = new Harness();
      h.makeJob('job-1');
      await h.establishMinionWait();
      h.ledger.setJobStatus('job-1', status);
      await h.sensor.tick();
      if (status === 'parked') {
        expect(h.ledger.listProviderWaits({ status: 'cancelled' })).toHaveLength(1);
        expect(h.probe.calls).toHaveLength(0);
      } else {
        // r1 #1: a dispatch-settled BLOCKED job after a provider stop is
        // expected interrupted-turn churn — still checked, never cancelled.
        expect(h.ledger.listProviderWaits({ status: 'cancelled' })).toHaveLength(0);
        expect(h.ledger.listProviderWaits({ status: 'waiting' })).toHaveLength(1);
        expect(h.probe.calls).toHaveLength(1);
      }
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
      typed: { origin: 'provider-message', status: 429, bodyCode: '1302' },
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
      config: { ...DEFAULT_PROVIDER_RECOVERY_CONFIG, enabled: true, glmGenerationFallback: true },
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
    // r1 #9: ONE delivery path — the durable `provider.restored` event
    // rides the ledger bus into the SilasDriver; the sensor never triggers
    // a second explicit wake.
    expect(h.wakes).toHaveLength(0);
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
      typed: { origin: 'provider-message', status: 429, bodyCode: '1302' },
      incidentId: 'i-silas',
      continuation: null,
    });
    h.probe.queueCompleted();
    await h.sensor.tick();
    expect(h.reArms).toHaveLength(1);
    expect(h.reArms[0]?.agentId).toBe('agent-silas');
    // The durable event is the single delivery path (no explicit wake).
    expect(h.wakes).toHaveLength(0);
    expect(h.ledger.listEvents({ limit: 10 }).some((e) => e.kind === 'provider.restored')).toBe(true);
  });

  it('boot reconciliation re-wakes an un-delivered recovery (lost wake)', async () => {
    const h = new Harness();
    h.makeJob('job-1');
    await h.establishMinionWait();
    h.probe.queueCompleted();
    await h.sensor.tick();
    expect(h.wakes).toHaveLength(0); // delivery rides the durable event
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


// ---------------------------------------------------------------------------
// PHASE2 test sources (ruling item 1): 300s floor on ALL outcomes, pre-I/O
// reservation crash/no-refund/idempotency, post-I/O revalidation, atomic
// batch binding, no-eligible-waiter zero I/O, typed-only establishment.
// WRITTEN SOURCE ONLY under the phase ruling — execution deferred.
// ---------------------------------------------------------------------------

describe('phase2 — 300 second floor on ALL outcome classes (r1 #4)', () => {
  it('probe-failed backoff floors at cadenceMinMs (no 60s path)', async () => {
    const h = new Harness();
    h.makeJob('job-f1');
    await h.establishMinionWait({ jobId: 'job-f1' });
    h.probe.outcomes.push({ kind: 'probe-failed', reason: 'fetch failed', retryAfterMs: null });
    await h.sensor.tick();
    const route = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
    expect(Date.parse(route?.nextCheckAt ?? '')).toBe(h.now + 300_000);
  });

  it('still-limited WITHOUT Retry-After waits the full cadence', async () => {
    const h = new Harness();
    h.makeJob('job-f2');
    await h.establishMinionWait({ jobId: 'job-f2' });
    await h.sensor.tick();
    const route = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
    expect(Date.parse(route?.nextCheckAt ?? '')).toBe(h.now + 300_000);
  });
});

describe('phase2 — pre-I/O reservation (r1 #5)', () => {
  it('the attempt is CHARGED before the I/O: crash mid-probe never refunds or duplicates', async () => {
    const h = new Harness();
    h.makeJob('job-r1');
    await h.establishMinionWait({ jobId: 'job-r1' });
    // A probe that never settles until released: the reservation stays open.
    const gate = h.probe.queueDeferred();
    const inFlight = h.sensor.tick();
    await new Promise((resolve) => setTimeout(resolve, 0)); // charge + probe started
    const route = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
    expect(route?.attemptsInWindow).toBe(1); // charged BEFORE the I/O
    expect(Date.parse(route?.nextCheckAt ?? '')).toBe(h.now + 300_000); // cadence advanced pre-I/O
    // A second tick while the (unexpired) reservation is open: no new I/O.
    h.advance(299_999);
    await h.sensor.tick();
    expect(h.probe.calls).toHaveLength(1);
    // Release the hung check so the sensor settles deterministically.
    gate.resolve({ kind: 'probe-failed', reason: 'crash-sim released', retryAfterMs: null });
    await inFlight;
  });

  it('an EXPIRED reservation settles spent-unknown: budget stays charged, next check honors the advanced cadence', async () => {
    const h = new Harness();
    h.makeJob('job-r2');
    await h.establishMinionWait({ jobId: 'job-r2' });
    const gate = h.probe.queueDeferred();
    const inFlight = h.sensor.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Simulate the crash + a later boot past the reservation expiry (the
    // reservation expires at ~95 s; 10 min later is still inside the
    // one-hour budget window, so the charge must survive): a FRESH sensor
    // over the same ledger settles the reservation as spent-unknown; the
    // charge is never refunded and the next check honors the advanced
    // cadence.
    h.advance(600_000);
    const restarted = new ProviderRecoverySensor({
      config: { ...DEFAULT_PROVIDER_RECOVERY_CONFIG, enabled: true, glmGenerationFallback: true },
      ledger: h.ledger,
      probe: h.probe,
      notifications: h.notifications,
      wake: h.wakePort(),
      slotReArm: h.reArmPort(),
      silasHosted: () => true,
      now: () => h.now,
    });
    await restarted.tick();
    const route = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
    expect(route?.lastResult).toBe('probe-unknown-crash');
    expect(route?.attemptsInWindow).toBeGreaterThanOrEqual(1); // never refunded
    gate.resolve({ kind: 'probe-failed', reason: 'crash-sim released', retryAfterMs: null });
    await inFlight;
  });
});

describe('phase2 — post-I/O revalidation (r1 #6)', () => {
  it('a credential rotation landing mid-check fails closed: no recovery, route flagged', async () => {
    const h = new Harness();
    h.makeJob('job-v1');
    await h.establishMinionWait({ jobId: 'job-v1' });
    h.probe.queueCompleted();
    // The binding rotates WHILE the check is in flight (the durable route
    // row is re-bound before the completed outcome lands).
    h.probe.onProbeStart = () => {
      const current = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
      if (current !== null) {
        h.ledger.upsertProviderRoute({
          ...current,
          credentialFingerprint: 'fp00000000000002',
          updatedAt: new Date(h.now).toISOString(),
        });
      }
    };
    await h.sensor.tick();
    expect(h.ledger.listProviderWaits({ status: 'recovered-pending' })).toHaveLength(0);
    expect(h.ledger.listEvents({ limit: 20 }).some((e) => e.kind === 'provider.restored')).toBe(false);
    const route = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
    expect(route?.lastResult).toBe('route-changed-mid-check');
    // The rotation is NOT clobbered by the stale pre-check binding.
    expect(route?.credentialFingerprint).toBe('fp00000000000002');
  });

  it('an owner park landing mid-check keeps the wait un-recovered (revalidated post-I/O)', async () => {
    const h = new Harness();
    h.makeJob('job-v2');
    await h.establishMinionWait({ jobId: 'job-v2' });
    h.probe.queueCompleted();
    h.probe.onProbeStart = () => h.ledger.setJobStatus('job-v2', 'parked');
    await h.sensor.tick();
    expect(h.ledger.listProviderWaits({ status: 'recovered-pending' })).toHaveLength(0);
    expect(h.ledger.listProviderWaits({ status: 'cancelled' })).toHaveLength(1);
  });
});

describe('phase2 — atomic recovery batch binds ALL matching waiters (r1 #7/#8)', () => {
  it('two same-route incidents recover together: every waiter carries the SAME batch id and is claimable', async () => {
    const h = new Harness();
    h.makeJob('job-b1');
    h.makeJob('job-b2');
    await h.establishMinionWait({ jobId: 'job-b1', incidentId: 'incident-b1' });
    await h.establishMinionWait({
      agentId: 'agent-minion-2',
      jobId: 'job-b2',
      incidentId: 'incident-b2',
      sessionFile: '/tmp/minion-b2.jsonl',
    });
    h.probe.queueCompleted();
    await h.sensor.tick();
    const recovered = h.ledger.listProviderWaits({ status: 'recovered-pending' });
    expect(recovered).toHaveLength(2);
    const batches = new Set(recovered.map((wait) => wait.recoveryBatchId));
    expect(batches.size).toBe(1);
    const restored = h.ledger.listEvents({ limit: 10 }).filter((e) => e.kind === 'provider.restored');
    expect(restored).toHaveLength(1);
    expect((restored[0]?.payload as { waiters?: string[] }).waiters).toHaveLength(2);
  });

  it('ONE delivery path: no explicit second wake — the durable event is the wake', async () => {
    const h = new Harness();
    h.makeJob('job-b3');
    await h.establishMinionWait({ jobId: 'job-b3' });
    h.probe.queueCompleted();
    await h.sensor.tick();
    expect(h.wakes).toHaveLength(0); // bus event rides SilasDriver; no double trigger
    expect(h.ledger.listEvents({ limit: 10 }).some((e) => e.kind === 'provider.restored')).toBe(true);
  });
});

describe('phase2 — provider blocker vs generic state churn (r1 #1)', () => {
  it('a provider-settled BLOCKED job remains eligible through the churn (checked, never cancelled)', async () => {
    const h = new Harness();
    h.makeJob('job-h1');
    await h.establishMinionWait({ jobId: 'job-h1' });
    h.ledger.setJobStatus('job-h1', 'blocked');
    h.ledger.appendCustomEvent({
      kind: 'job.minion-error',
      jobId: 'job-h1',
      payload: { error: 'runtime error: 429: ...' },
    });
    await h.sensor.tick();
    expect(h.probe.calls).toHaveLength(1); // eligible: the provider blocker owns this stop
    expect(h.ledger.listProviderWaits({ status: 'waiting' })).toHaveLength(1);
    expect(h.ledger.listProviderWaits({ status: 'cancelled' })).toHaveLength(0);
  });

  it('a job ALREADY blocked at establishment stays held with zero I/O (generic block)', async () => {
    const h = new Harness();
    h.makeJob('job-hb');
    h.ledger.setJobStatus('job-hb', 'blocked');
    await h.establishMinionWait({ jobId: 'job-hb' });
    await h.sensor.tick();
    expect(h.probe.calls).toHaveLength(0);
    expect(h.ledger.listProviderWaits({ status: 'waiting' })).toHaveLength(1);
    expect(h.ledger.listProviderWaits({ status: 'cancelled' })).toHaveLength(0);
  });

  it('a job settled BLOCKED by this wall\'s own failing turn before establishment stays eligible (r4)', async () => {
    const h = new Harness();
    h.makeJob('job-hw');
    h.ledger.registerAgent({ id: 'agent-hw', role: 'minion', jobId: 'job-hw' });
    // The dispatch settle raced the wait: the failing turn's minion error
    // lands first, then the job flips blocked — that block IS this
    // blocker's own settlement, not a generic hold.
    h.ledger.appendCustomEvent({
      kind: 'job.minion-error',
      jobId: 'job-hw',
      payload: { agentId: 'agent-hw', error: 'runtime error: 429: ...' },
    });
    h.ledger.setJobStatus('job-hw', 'blocked');
    const wait = await h.establishMinionWait({ jobId: 'job-hw', agentId: 'agent-hw' });
    expect(wait?.jobStatusAtEstablishment).toBe('blocked');
    await h.sensor.tick();
    expect(h.probe.calls).toHaveLength(1); // eligible: this blocker owns the block
    expect(h.ledger.listProviderWaits({ status: 'waiting' })).toHaveLength(1);
    expect(h.ledger.listProviderWaits({ status: 'cancelled' })).toHaveLength(0);
  });

  it('a block separated from the failing turn by another status hop is never attributed (held)', async () => {
    const h = new Harness();
    h.makeJob('job-hx');
    h.ledger.registerAgent({ id: 'agent-hx', role: 'minion', jobId: 'job-hx' });
    h.ledger.appendCustomEvent({
      kind: 'job.minion-error',
      jobId: 'job-hx',
      payload: { agentId: 'agent-hx', error: 'runtime error: 429: ...' },
    });
    h.ledger.setJobStatus('job-hx', 'blocked');
    // An owner re-opens and re-blocks with no new failing turn: the current
    // block does NOT directly follow the minion error — hold, zero I/O.
    h.ledger.setJobStatus('job-hx', 'working');
    h.ledger.setJobStatus('job-hx', 'blocked');
    await h.establishMinionWait({ jobId: 'job-hx', agentId: 'agent-hx' });
    await h.sensor.tick();
    expect(h.probe.calls).toHaveLength(0);
    expect(h.ledger.listProviderWaits({ status: 'waiting' })).toHaveLength(1);
  });

  it('an unchanged-head late DELIVERY stays eligible and is not superseded', async () => {
    const h = new Harness();
    h.makeJob('job-h2');
    await h.establishMinionWait({ jobId: 'job-h2' });
    h.ledger.setJobStatus('job-h2', 'delivered');
    await h.sensor.tick();
    expect(h.ledger.listProviderWaits({ status: 'waiting' })).toHaveLength(1);
    expect(h.ledger.listProviderWaits({ status: 'superseded' })).toHaveLength(0);
    expect(h.probe.calls).toHaveLength(1);
  });

  it('a job ALREADY delivered at establishment stays held with zero I/O', async () => {
    const h = new Harness();
    h.makeJob('job-hd');
    h.ledger.setJobStatus('job-hd', 'delivered');
    await h.establishMinionWait({ jobId: 'job-hd' });
    await h.sensor.tick();
    expect(h.probe.calls).toHaveLength(0);
    expect(h.ledger.listProviderWaits({ status: 'waiting' })).toHaveLength(1);
  });

  it('parked (explicit manual hold) still retires the wait; done/merged still cancel', async () => {
    const h = new Harness();
    h.makeJob('job-h3');
    await h.establishMinionWait({ jobId: 'job-h3' });
    h.ledger.setJobStatus('job-h3', 'parked');
    await h.sensor.tick();
    expect(h.ledger.listProviderWaits({ status: 'cancelled' })).toHaveLength(1);
  });
});

describe('phase2 — machine-owned incidents resolve with their wait lifecycle (r1 #2)', () => {
  it('a linked machine-owned (action-required) incident resolves when its wait settles — never an ACK', async () => {
    const h = new Harness();
    h.makeJob('job-i1');
    const wait = await h.establishMinionWait({ jobId: 'job-i1', incidentId: null });
    h.ledger.recordNotification({
      id: 'incident-i1',
      kind: 'supervision.provider-wall.agent-minion-1.quota_wall',
      routing: 'action-required',
      severity: 'error',
      title: 'stopped',
    });
    h.ledger.setProviderWaitIncident(wait!.id, 'incident-i1');
    h.ledger.setProviderWaitStatus(wait!.id, 'cancelled', { why: 'test-settle' });
    const incident = h.ledger.getNotification('incident-i1');
    expect(incident?.resolvedAt).not.toBeNull();
    expect(incident?.ackedAt).toBeNull(); // lifecycle resolution, never an owner ACK
  });

  it('an owner-held (needs-owner) stop linked to a wait is NEVER resolved by the machine lifecycle', async () => {
    const h = new Harness();
    h.makeJob('job-i2');
    const wait = await h.establishMinionWait({ jobId: 'job-i2', incidentId: null });
    h.ledger.recordNotification({
      id: 'incident-historic',
      kind: 'supervision.provider-wall.agent-minion-1.quota_wall',
      routing: 'needs-owner',
      severity: 'error',
      title: 'historic owner stop',
    });
    h.ledger.setProviderWaitIncident(wait!.id, 'incident-historic');
    h.ledger.setProviderWaitStatus(wait!.id, 'cancelled', { why: 'test-settle' });
    const incident = h.ledger.getNotification('incident-historic');
    expect(incident?.resolvedAt).toBeNull(); // owner control preserved
  });
});

describe('r4 — async settlement preserves the charge and mid-check updates (finding 4)', () => {
  it('a completed recovery keeps the pre-I/O charge and never reverts mid-check route updates', async () => {
    const h = new Harness();
    h.makeJob('job-w2');
    await h.establishMinionWait({ jobId: 'job-w2' });
    h.probe.queueCompleted();
    // A concurrent establishment/escalation lands MID-CHECK: the route's
    // incident sequence, false-recovery ladder, and suspension advance
    // while the probe is in flight.
    h.probe.onProbeStart = () => {
      const current = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
      if (current !== null) {
        h.ledger.upsertProviderRoute({
          ...current,
          incidentSeq: 7,
          falseRecoveryCount: 2,
          suspendedUntil: '2026-09-28T11:00:00Z',
        });
      }
    };
    await h.sensor.tick();
    const route = h.ledger.getProviderRoute(`zai-coding-cn/glm-5.3@${h.probe.fingerprint}`);
    // The check was CHARGED before the I/O: the recovery write must not
    // refund the attempt (the 12/hour pin would undercount) ...
    expect(route?.attemptsInWindow).toBe(1);
    expect(route?.lastAttemptAt).not.toBeNull();
    // ... and the mid-check updates survive the recovery settle.
    expect(route?.incidentSeq).toBe(7);
    expect(route?.falseRecoveryCount).toBe(2);
    expect(route?.suspendedUntil).toBe('2026-09-28T11:00:00Z');
    expect(route?.lastResult).toBe('recovered');
    // The recovery itself still landed.
    expect(h.ledger.listProviderWaits({ status: 'recovered-pending' })).toHaveLength(1);
  });
});

describe('r4 — endpoint rotation re-binds the route and retires stale waits (finding 8)', () => {
  it('a catalog endpoint change re-binds the route and supersedes waits bound to the old endpoint', async () => {
    const h = new Harness();
    h.makeJob('job-e1');
    const first = await h.establishMinionWait({ jobId: 'job-e1' });
    expect(first?.endpoint).toBe(h.probe.endpoint);
    // The catalog moves the endpoint for the SAME provider/model/credential
    // binding (routeKey unchanged): the old endpoint can never be probed.
    h.probe.endpoint = 'https://open.bigmodel.cn/api/coding/paas/v4-v2';
    h.makeJob('job-e2');
    const second = await h.establishMinionWait({
      agentId: 'agent-minion-2',
      jobId: 'job-e2',
      sessionFile: '/tmp/minion-2.jsonl',
      incidentId: 'supervision.provider-wall.agent-minion-2.quota_wall',
    });
    // The stale wait is retired with a recorded reason; the new wait holds
    // the new binding; the route row is re-bound.
    const stale = h.ledger.getProviderWait(first!.id);
    expect(stale?.status).toBe('superseded');
    expect(second?.endpoint).toBe('https://open.bigmodel.cn/api/coding/paas/v4-v2');
    const route = h.ledger.getProviderRoute(first!.routeKey);
    expect(route?.endpoint).toBe('https://open.bigmodel.cn/api/coding/paas/v4-v2');
    // The next shared check probes the RE-BOUND endpoint — never held forever.
    await h.sensor.tick();
    expect(h.probe.calls).toHaveLength(1);
    expect(h.probe.calls[0]?.endpoint).toBe('https://open.bigmodel.cn/api/coding/paas/v4-v2');
  });
});

describe('r4 — the notifications port uses the dedupe-capable incident path (finding 7)', () => {
  it('two establishments on one route keep exactly ONE waiting row (not one per event)', async () => {
    const h = new Harness();
    h.makeJob('job-d1');
    h.makeJob('job-d2');
    await h.establishMinionWait({ jobId: 'job-d1' });
    await h.establishMinionWait({
      agentId: 'agent-minion-2',
      jobId: 'job-d2',
      sessionFile: '/tmp/minion-d2.jsonl',
      incidentId: 'supervision.provider-wall.agent-minion-2.quota_wall',
    });
    const waitingRows = h.ledger
      .listNotifications()
      .filter((notification) => notification.kind.startsWith('provider.waiting.'));
    expect(waitingRows).toHaveLength(1);
    expect(waitingRows[0]?.routing).toBe('fyi');
  });

  it('repeated false-recovery escalations reuse ONE durable machine row', async () => {
    const h = new Harness({ falseRecoveryEscalateAt: 1, suspensionMs: 1_000 });
    h.makeJob('job-d3');
    await h.establishMinionWait({ jobId: 'job-d3' });
    h.probe.queueCompleted();
    await h.sensor.tick();
    const recovered = h.ledger.listProviderWaits({ status: 'recovered-pending' })[0]!;
    h.ledger.setProviderWaitStatus(recovered.id, 'claimed');
    // Two separate renewals each climb the ladder to the escalation.
    await h.establishMinionWait({ jobId: 'job-d3', incidentId: 'incident-d3-2' });
    await h.establishMinionWait({ jobId: 'job-d3', incidentId: 'incident-d3-3' });
    const rows = h.ledger
      .listNotifications()
      .filter((notification) => notification.kind.startsWith('provider.false-recovery.'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.routing).toBe('action-required');
  });
});
