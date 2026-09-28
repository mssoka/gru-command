import { randomUUID } from 'node:crypto';
import type { LogLevel } from '../logger.js';
import type {
  LedgerApi,
  PendingProviderRecoveryRecord,
  ProviderRouteRecord,
  ProviderWaitContinuation,
  ProviderWaitRecord,
} from '../ledger/api.js';
import type { ProviderRecoveryConfig } from '../config.js';
import {
  classifyProviderRejection,
  extractProviderRejectionEvidence,
  providerSupportsSensor,
  type ProviderRejectionEvidence,
} from './classify.js';
import type { ProbeRoute, ProviderProbePort } from './probe.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Provider-recovery sensor (owner-approved 2026-09-28).
 *
 * Deterministic, in-service, provider-aware: it watches EXPLICIT durable
 * provider waits (established only from structured rejection evidence on
 * supported routes), probes each exact provider/model/credential binding
 * on a shared bounded cadence, and on completed producer evidence records
 * a deduplicated recovery + pending delivery, wakes Silas once through the
 * durable wake mechanism, and (for the Silas slot itself) performs the
 * guarded owned re-arm deterministically — the sensor never depends on the
 * stopped LLM to run.
 *
 * Hard invariants (briefing acceptance 1-8):
 * - No wait is ever inferred from generic blocked status, message prose,
 *   backlog membership, or the blanket `quota_wall` text class.
 * - One shared non-overlapping check per exact route; ≥300 s spacing; ≤12
 *   attempts/hour; durable cadence/budget across restarts.
 * - Only fresh completed provider-protocol producer evidence bound to the
 *   current incident and credential generation clears a wait.
 * - Owner control is preserved: auth/permission/billing/ambiguous
 *   failures and unsupported providers never become waits.
 */

/** The canonical route key: exact provider/model + credential binding. */
export function providerRouteKey(provider: string, model: string, fingerprint: string): string {
  return `${provider}/${model}@${fingerprint}`;
}

/** The notifications surface the sensor needs (NotificationCenter fits). */
export interface SensorNotifications {
  post(input: {
    kind: string;
    routing: 'fyi' | 'action-required';
    severity: 'info' | 'error';
    title: string;
    detail?: string | null;
    dedupe?: 'unacked' | 'active' | 'all';
  }): { id: string };
  resolveIncidents(kindPrefix: string, by: string): unknown;
}

/** The Silas wake surface: the existing durable wake mechanism (the
 * SilasDriver's coalescing one-slot queue). */
export interface RecoveryWakePort {
  trigger(input: { kind: 'provider.restored'; routeKey: string }): Promise<void>;
}

/** Guarded owned re-arm for the Silas logical slot (supervisor-owned
 * method; only ever re-arms the SAME slot a wait was established for). */
export interface SlotReArmPort {
  ownedProviderReArm(agentId: string, waitId: string): boolean;
}

export interface ProviderRecoverySensorOptions {
  readonly config: ProviderRecoveryConfig;
  readonly ledger: LedgerApi;
  readonly probe: ProviderProbePort;
  readonly notifications: SensorNotifications;
  readonly wake: RecoveryWakePort;
  readonly slotReArm?: SlotReArmPort;
  /** Whether the silas slot is hosted at all (config gate). */
  readonly silasHosted: () => boolean;
  readonly log?: Log;
  readonly now?: () => number;
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
}

/** One supervisor-observed provider wall, handed to the recorder. */
export interface ProviderWallObservation {
  readonly agentId: string;
  readonly role: string;
  readonly slotId: string | null;
  readonly jobId: string | null;
  readonly sessionFile: string | null;
  /** The supervisor's failure class ('quota_wall' | 'authentication_wall' | ...). */
  readonly failureClass: string;
  /** Structured provider identity when the runtime error carried one. */
  readonly provider: string | null;
  readonly model: string | null;
  /** The raw runtime error line (machine-composed by the transport). */
  readonly errorMessage: string;
  /** The supervision incident id (the provider-wall notification). */
  readonly incidentId: string | null;
  /** The captured interrupted turn, when one existed. */
  readonly continuation: ProviderWaitContinuation | null;
}

/**
 * Establish (or decline) a provider wait from a supervisor wall stop.
 * PURE DECISION + LEDGER WRITE; no timers, no probes. Returns the wait
 * record when an eligible wait was established, null when owner control
 * is preserved (with the decision logged).
 *
 * Async only for the credential fingerprint lookup on the probe port.
 */
export async function establishProviderWait(
  sensor: ProviderRecoverySensor,
  observation: ProviderWallObservation,
): Promise<ProviderWaitRecord | null> {
  if (!sensor.enabled) return null;
  // Waiter scoping: job minions and the Silas ops slot. Everything else
  // (Gru chat, Bob consolidation, review-isolated attempts — which never
  // reach the wall stop anyway) stays owner-controlled.
  const isMinion = observation.role === 'minion' && observation.jobId !== null;
  const isSilas = observation.role === 'silas' && observation.slotId !== null;
  if (!isMinion && !isSilas) return null;
  if (observation.provider === null || observation.model === null) {
    sensor.debugLog('provider wall without structured provider identity — owner control preserved', {
      agent_id: observation.agentId,
    });
    return null;
  }
  if (observation.failureClass !== 'quota_wall') {
    // The supervisor's own class already says auth/unknown/etc. — never a
    // wait. (quota_wall is necessary but NOT sufficient: the explicit
    // classifier below still decides.)
    return null;
  }
  const evidence: ProviderRejectionEvidence = extractProviderRejectionEvidence({
    provider: observation.provider,
    model: observation.model,
    errorMessage: observation.errorMessage,
  });
  const limitClass = classifyProviderRejection(evidence);
  if (limitClass.kind !== 'temporary-recoverable') {
    sensor.debugLog('provider wall classified owner-controlled — no wait', {
      agent_id: observation.agentId,
      reason: limitClass.reason,
      status: evidence.status ?? null,
      body_code: evidence.bodyCode ?? null,
    });
    return null;
  }
  if (!providerSupportsSensor(evidence.provider)) {
    sensor.debugLog('provider has no verified sensor adapter — no wait', {
      agent_id: observation.agentId,
      provider: evidence.provider,
    });
    return null;
  }
  const fingerprint = await sensor.probe.credentialFingerprint(evidence.provider);
  if (fingerprint === null) {
    sensor.debugLog('credential could not be resolved for the route binding — no wait', {
      agent_id: observation.agentId,
      provider: evidence.provider,
    });
    return null;
  }
  return sensor.recordWait(observation, evidence, fingerprint);
}

/** Rolling budget window (1 h, per the approval's 12/hour pin). */
const WINDOW_MS = 3_600_000;

export class ProviderRecoverySensor {
  readonly enabled: boolean;
  private readonly cfg: ProviderRecoveryConfig;
  private readonly ledger: LedgerApi;
  readonly probe: ProviderProbePort;
  private readonly notifications: SensorNotifications;
  private readonly wake: RecoveryWakePort;
  private readonly slotReArm: SlotReArmPort | null;
  private readonly silasHosted: () => boolean;
  private readonly log: Log;
  private readonly now: () => number;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly probing = new Set<string>();
  private disposed = false;

  constructor(opts: ProviderRecoverySensorOptions) {
    this.enabled = opts.config.enabled;
    this.cfg = opts.config;
    this.ledger = opts.ledger;
    this.probe = opts.probe;
    this.notifications = opts.notifications;
    this.wake = opts.wake;
    this.slotReArm = opts.slotReArm ?? null;
    this.silasHosted = opts.silasHosted;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.setIntervalImpl = opts.setInterval ?? setInterval;
    this.clearIntervalImpl = opts.clearInterval ?? clearInterval;
  }

  debugLog(msg: string, fields: Record<string, unknown>): void {
    this.log('info', msg, fields);
  }

  /** Start the deterministic service timer (never an OS daemon). */
  start(): void {
    if (this.disposed || this.timer !== null) return;
    if (!this.enabled) {
      this.log('info', 'provider-recovery sensor disabled by config — no waits, no probes', {});
      return;
    }
    this.timer = this.setIntervalImpl(() => {
      void this.tick().catch((error: unknown) => {
        this.log('error', 'provider-recovery tick failed', { error: String(error) });
      });
    }, this.cfg.tickIntervalMs);
    this.timer.unref?.();
    this.log('info', 'provider-recovery sensor started', {
      tick_interval_ms: this.cfg.tickIntervalMs,
      cadence_min_ms: this.cfg.cadenceMinMs,
      max_attempts_per_hour: this.cfg.maxAttemptsPerHour,
    });
  }

  stop(): void {
    if (this.timer !== null) {
      this.clearIntervalImpl(this.timer);
      this.timer = null;
    }
    this.disposed = true;
  }

  /** One deterministic observation pass over every waiting route. */
  async tick(): Promise<void> {
    if (this.disposed || !this.enabled) return;
    const waiting = this.ledger.listProviderWaits({ status: 'waiting' });
    const byRoute = new Map<string, ProviderWaitRecord[]>();
    for (const wait of waiting) {
      const group = byRoute.get(wait.routeKey);
      if (group === undefined) byRoute.set(wait.routeKey, [wait]);
      else group.push(wait);
    }
    for (const [routeKey, waits] of byRoute) {
      try {
        await this.tickRoute(routeKey, waits);
      } catch (error) {
        this.log('error', 'provider-recovery route tick failed', {
          route: routeKey,
          error: String(error),
        });
      }
    }
    await this.settlePendingRecoveries();
  }

  /** Re-validate waiters, then run the shared check when due. */
  private async tickRoute(routeKey: string, waits: readonly ProviderWaitRecord[]): Promise<void> {
    const eligible: ProviderWaitRecord[] = [];
    for (const wait of waits) {
      const disposition = this.validateWaiter(wait);
      if (disposition === 'eligible') eligible.push(wait);
      else if (disposition === 'cancel') {
        this.ledger.setProviderWaitStatus(wait.id, 'cancelled', { why: 'waiter-invalid' });
      } else if (disposition === 'supersede') {
        this.ledger.setProviderWaitStatus(wait.id, 'superseded', { why: 'replaced' });
      }
    }
    // No eligible waiters on this route: stop polling it (demand-gated —
    // the reference's ungated default probe is deliberately not copied).
    if (eligible.length === 0) {
      const route = this.ledger.getProviderRoute(routeKey);
      if (route !== null && route.lastResult !== 'idle') {
        this.ledger.upsertProviderRoute(
          { ...route, lastResult: 'idle', updatedAt: new Date(this.now()).toISOString() },
          { kind: 'provider.route-idle', payload: { route: routeKey } },
        );
      }
      return;
    }
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    let route = this.ledger.getProviderRoute(routeKey);
    const first = eligible[0];
    if (route === null && first !== undefined) {
      route = {
        routeKey,
        provider: first.provider,
        model: first.model,
        credentialFingerprint: first.credentialFingerprint,
        incidentSeq: first.incidentGeneration,
        windowStart: nowIso,
        attemptsInWindow: 0,
        nextCheckAt: nowIso,
        lastAttemptAt: null,
        lastResult: null,
        consecutiveProbeFailures: 0,
        falseRecoveryCount: 0,
        suspendedUntil: null,
        updatedAt: nowIso,
      };
      this.ledger.upsertProviderRoute(route);
    }
    // Rolling window: a window older than an hour resets the budget.
    if (route === null) return; // no waiters carry this route's identity
    if (nowMs - Date.parse(route.windowStart) >= WINDOW_MS) {
      route = this.ledger.upsertProviderRoute(
        { ...route, windowStart: nowIso, attemptsInWindow: 0, updatedAt: nowIso },
      );
    }
    if (route.suspendedUntil !== null && Date.parse(route.suspendedUntil) > nowMs) return;
    if (route.attemptsInWindow >= this.cfg.maxAttemptsPerHour) {
      // Budget exhausted: next eligibility is the window rollover.
      const nextWindow = new Date(Date.parse(route.windowStart) + WINDOW_MS).toISOString();
      if (route.nextCheckAt !== nextWindow) {
        this.ledger.upsertProviderRoute({ ...route, nextCheckAt: nextWindow, updatedAt: nowIso });
      }
      return;
    }
    if (Date.parse(route.nextCheckAt) > nowMs) return;
    if (this.probing.has(routeKey)) return; // non-overlapping per route
    this.probing.add(routeKey);
    try {
      await this.checkRoute(routeKey, route, eligible);
    } finally {
      this.probing.delete(routeKey);
    }
  }

  /** Eligibility per waiter, re-checked every tick and before any claim:
   * only still-approved unfinished work whose next action can advance. */
  private validateWaiter(wait: ProviderWaitRecord): 'eligible' | 'cancel' | 'supersede' | 'hold' {
    if (wait.waiterKind === 'job-minion') {
      const job = wait.jobId !== null ? this.ledger.getJob(wait.jobId) : null;
      if (job === null || job.status === 'merged' || job.status === 'done') return 'cancel';
      // Owner/ops holds (blocked/parked) and other owner decisions on the
      // lane invalidate automatic recovery: the wall is no longer the
      // operative blocker.
      if (job.status === 'blocked' || job.status === 'parked') return 'cancel';
      // An already-live replacement minion (newer than this wait) owns the
      // lane — the wait is superseded, never double-resumed.
      if (wait.jobId !== null) {
        const newer = this.ledger
          .listAgents()
          .find(
            (agent) =>
              agent.jobId === wait.jobId &&
              agent.role === 'minion' &&
              agent.id !== wait.agentId &&
              agent.createdAt >= wait.createdAt,
          );
        if (newer !== undefined) return 'supersede';
      }
      // A delivered lane means the turn settled without this wait's
      // continuation: the work is not waiting on the provider.
      if (job.status === 'delivered' || job.status === 'in-review') return 'supersede';
      return 'eligible';
    }
    // silas-slot: eligible while silas is hosted; disabling silas retires
    // the wait (owner decision).
    return this.silasHosted() ? 'eligible' : 'cancel';
  }

  /** The shared non-overlapping check for one route. */
  private async checkRoute(
    routeKey: string,
    route: ProviderRouteRecord,
    eligible: readonly ProviderWaitRecord[],
  ): Promise<void> {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const attempts = route.attemptsInWindow + 1;
    const probeRoute: ProbeRoute = {
      provider: route.provider,
      model: route.model,
      baseUrl: '',
      credentialFingerprint: route.credentialFingerprint,
    };
    const outcome = await this.probe.probe(probeRoute);
    const base = {
      ...route,
      attemptsInWindow: attempts,
      lastAttemptAt: nowIso,
      consecutiveProbeFailures: 0,
    };
    if (outcome.kind === 'completed') {
      await this.recoverRoute(route, eligible, outcome.evidence as unknown as Record<string, unknown>, nowMs);
      return;
    }
    if (outcome.kind === 'still-limited') {
      const cadence = this.nextCheckDelay(outcome.retryAfterMs);
      this.ledger.upsertProviderRoute(
        { ...base, lastResult: 'still-limited', nextCheckAt: new Date(nowMs + cadence).toISOString() },
        {
          kind: 'provider.probe-result',
          payload: {
            route: routeKey,
            result: 'still-limited',
            status: outcome.status ?? null,
            body_code: outcome.bodyCode ?? null,
            next_check_at: new Date(nowMs + cadence).toISOString(),
          },
        },
      );
      return;
    }
    // probe-failed: transport/tool failure or closed-envelope failure —
    // backoff bounded, never a recovery. Credential rotation invalidates
    // the waits (route change) instead of probing against a new binding.
    const failures = route.consecutiveProbeFailures + 1;
    const backoff = Math.min(
      this.cfg.probeBackoffBaseMs * 2 ** (failures - 1),
      this.cfg.probeBackoffMaxMs,
    );
    this.ledger.upsertProviderRoute(
      {
        ...base,
        lastResult: 'probe-failed',
        consecutiveProbeFailures: failures,
        nextCheckAt: new Date(nowMs + backoff).toISOString(),
      },
      {
        kind: 'provider.probe-result',
        payload: { route: routeKey, result: 'probe-failed', reason: outcome.reason, retry_in_ms: backoff },
      },
    );
    if (outcome.reason.includes('credential rotated')) {
      for (const wait of eligible) {
        this.ledger.setProviderWaitStatus(wait.id, 'superseded', { why: 'credential-rotated' });
      }
    }
  }

  /** Trustworthy Retry-After honored within the approved cadence policy:
   * never below the 300 s floor, never above the retryAfter cap. */
  private nextCheckDelay(retryAfterMs: number | null): number {
    if (retryAfterMs === null || retryAfterMs <= 0) return this.cfg.cadenceMinMs;
    return Math.max(this.cfg.cadenceMinMs, Math.min(retryAfterMs, this.cfg.retryAfterMaxMs));
  }

  /** Persist the deduplicated recovery, mark waiters, wake Silas once.
   * The marker keys on the newest incident sequence among the waiters the
   * evidence covered — each NEW incident (renewed quota included) gets its
   * own delivery; a duplicate observation of the same sequence never
   * double-delivers. */
  private async recoverRoute(
    route: ProviderRouteRecord,
    eligible: readonly ProviderWaitRecord[],
    evidence: Record<string, unknown>,
    nowMs: number,
  ): Promise<void> {
    const nowIso = new Date(nowMs).toISOString();
    const recoveredSeq = eligible.reduce((max, wait) => Math.max(max, wait.incidentGeneration), 0);
    this.ledger.upsertProviderRoute(
      { ...route, lastResult: 'recovered', nextCheckAt: new Date(nowMs + this.cfg.cadenceMinMs).toISOString(), updatedAt: nowIso },
      {
        kind: 'provider.probe-result',
        payload: { route: route.routeKey, result: 'recovered', incident_seq: recoveredSeq, evidence },
      },
    );
    const recorded = this.ledger.recordProviderRecovery({
      id: randomUUID(),
      routeKey: route.routeKey,
      incidentGeneration: recoveredSeq,
      evidence,
      waiterJobIds: eligible.map((wait) => wait.jobId).filter((jobId): jobId is string => jobId !== null),
    });
    if (recorded === null) {
      // Duplicate observation of the same incident sequence: the delivery
      // marker already exists — never a second event or wake.
      return;
    }
    for (const wait of eligible) {
      if (wait.incidentGeneration > recoveredSeq) continue; // newer incident: not covered by this evidence
      this.ledger.setProviderWaitStatus(wait.id, 'recovered-pending', {
        route: route.routeKey,
        incident_seq: wait.incidentGeneration,
        evidence_completed_at: nowIso,
      });
    }
    this.notifications.resolveIncidents(`provider.waiting.${route.routeKey}`, 'provider-recovery-sensor');
    // The Silas logical slot re-arms deterministically through the guarded
    // owned transition — the sensor never depends on the stopped COO to
    // accept the wake (though the wake still informs it when it can turn).
    for (const wait of eligible) {
      if (wait.waiterKind === 'silas-slot' && wait.agentId !== null && this.slotReArm !== null) {
        const rearmed = this.slotReArm.ownedProviderReArm(wait.agentId, wait.id);
        this.log('info', 'silas slot provider re-arm attempted', {
          route: route.routeKey,
          agent_id: wait.agentId,
          rearmed,
        });
      }
    }
    this.log('info', 'provider recovery recorded — waking silas once', {
      route: route.routeKey,
      waiters: eligible.length,
    });
    await this.wake.trigger({ kind: 'provider.restored', routeKey: route.routeKey }).catch((error: unknown) => {
      this.log('error', 'provider-restored wake could not be delivered — the digest sweep retries', {
        route: route.routeKey,
        error: String(error),
      });
    });
  }

  /** Retire delivery markers whose every waiter settled. */
  private async settlePendingRecoveries(): Promise<void> {
    for (const pending of this.ledger.listPendingProviderRecoveries()) {
      const open = this.ledger
        .listProviderWaits({ routeKey: pending.routeKey })
        .filter((wait) => wait.status === 'recovered-pending');
      if (open.length === 0) {
        this.ledger.clearPendingProviderRecovery(pending.id);
      }
    }
  }

  /** Boot/restart reconciliation: never silently re-baseline away an
   * outstanding wait or delivery. Routes keep their durable cadence; a
   * recovery that was recorded but never delivered re-wakes. */
  async reconcileAtBoot(): Promise<{ rewoken: number }> {
    if (!this.enabled) return { rewoken: 0 };
    let rewoken = 0;
    for (const pending of this.ledger.listPendingProviderRecoveries()) {
      const open = this.ledger
        .listProviderWaits({ routeKey: pending.routeKey })
        .filter((wait) => wait.status === 'recovered-pending');
      if (open.length === 0) {
        this.ledger.clearPendingProviderRecovery(pending.id);
        continue;
      }
      // The delivery may have been lost across the restart boundary: wake
      // once per boot for it (the wake coalescer still guarantees at most
      // one in-flight wake).
      await this.wake.trigger({ kind: 'provider.restored', routeKey: pending.routeKey }).catch(() => {});
      rewoken += 1;
    }
    if (rewoken > 0) {
      this.log('info', 'provider recovery deliveries reconciled at boot', { rewoken });
    }
    return { rewoken };
  }

  /** The wait-recorder half (called by establishProviderWait). */
  recordWait(
    observation: ProviderWallObservation,
    evidence: ProviderRejectionEvidence,
    fingerprint: string,
  ): ProviderWaitRecord {
    const routeKey = providerRouteKey(evidence.provider, evidence.model, fingerprint);
    let route = this.ledger.getProviderRoute(routeKey);
    const nowIso = new Date(this.now()).toISOString();
    // Sink replays of the SAME incident are idempotent: the existing row
    // updates (never a second wait or seq bump).
    const replayed = this.ledger
      .listProviderWaits()
      .find((wait) => wait.incidentId === (observation.incidentId ?? `provider-wall.${observation.agentId}`));
    let generation = replayed?.incidentGeneration ?? 1;
    if (route === null) {
      route = {
        routeKey,
        provider: evidence.provider,
        model: evidence.model,
        credentialFingerprint: fingerprint,
        incidentSeq: replayed?.incidentGeneration ?? 1,
        windowStart: nowIso,
        attemptsInWindow: 0,
        nextCheckAt: nowIso,
        lastAttemptAt: null,
        lastResult: null,
        consecutiveProbeFailures: 0,
        falseRecoveryCount: 0,
        suspendedUntil: null,
        updatedAt: nowIso,
      };
      this.ledger.upsertProviderRoute(route);
    } else if (replayed === undefined) {
      // A NEW incident on this route: the sequence advances so the next
      // recovery delivers exactly once for this incident.
      generation = route.incidentSeq + 1;
      route = this.ledger.upsertProviderRoute({ ...route, incidentSeq: generation, updatedAt: nowIso });
    }
    // Renewed quota after a recovered continuation: a prior claimed or
    // still-pending wait for the same agent+route means the recovery was
    // false (the continuation re-hit the wall) — supersede the prior, climb
    // the bounded false-recovery ladder (escalation suspends the route
    // rather than looping).
    const prior = observation.agentId !== null && replayed === undefined
      ? [
          ...this.ledger.listProviderWaits({ status: 'recovered-pending' }),
          ...this.ledger.listProviderWaits({ status: 'claimed' }),
        ].find((wait) => wait.agentId === observation.agentId && wait.routeKey === routeKey)
      : undefined;
    if (prior !== undefined) {
      if (prior.status === 'recovered-pending') {
        this.ledger.setProviderWaitStatus(prior.id, 'superseded', { why: 'renewed-quota' });
      }
      // (a claimed prior stays claimed — history; only the ladder moves)
      const count = route.falseRecoveryCount + 1;
      this.ledger.upsertProviderRoute({ ...route, falseRecoveryCount: count, updatedAt: nowIso });
      route = { ...route, falseRecoveryCount: count };
      if (count >= this.cfg.falseRecoveryEscalateAt) {
        this.escalateFalseRecovery(route, observation);
      }
    }
    const wait = this.ledger.recordProviderWait({
      id: randomUUID(),
      routeKey,
      provider: evidence.provider,
      model: evidence.model,
      credentialFingerprint: fingerprint,
      waiterKind: observation.role === 'silas' ? 'silas-slot' : 'job-minion',
      jobId: observation.jobId,
      agentId: observation.agentId,
      slotId: observation.slotId,
      sessionFile: observation.sessionFile,
      continuation: observation.continuation,
      incidentId: observation.incidentId ?? `provider-wall.${observation.agentId}`,
      incidentGeneration: generation,
      reasonClass: `temporary-recoverable:${evidence.status ?? evidence.bodyCode ?? 'limit'}`,
    });
    // Concise attention surface (fyi; routine polling never chimes):
    this.notifications.post({
      kind: `provider.waiting.${routeKey}`,
      routing: 'fyi',
      severity: 'info',
      title: `Provider wait: ${evidence.provider}/${evidence.model}`,
      detail: `Automatic recovery watching ${evidence.provider}/${evidence.model}; next check at most every ${Math.round(this.cfg.cadenceMinMs / 1000)}s. Recovery will resume approved work without an owner ACK.`,
      dedupe: 'active',
    });
    this.log('info', 'provider wait established', {
      route: routeKey,
      agent_id: observation.agentId,
      waiter: observation.role,
      incident_generation: generation,
    });
    return wait;
  }

  /** Bounded false-recovery escalation: Gru (machine attention), not an
   * endless probe/continue loop. */
  private escalateFalseRecovery(route: ProviderRouteRecord, observation: ProviderWallObservation): void {
    const until = new Date(this.now() + this.cfg.suspensionMs).toISOString();
    this.ledger.upsertProviderRoute(
      { ...route, suspendedUntil: until, falseRecoveryCount: 0, updatedAt: until },
      {
        kind: 'provider.false-recovery-escalated',
        payload: { route: route.routeKey, suspended_until: until, agent_id: observation.agentId },
      },
    );
    this.notifications.post({
      kind: `provider.false-recovery.${route.routeKey}`,
      routing: 'action-required',
      severity: 'error',
      title: `Repeated false provider recoveries: ${route.provider}/${route.model}`,
      detail:
        `The route recovered ${this.cfg.falseRecoveryEscalateAt} times but its continuations re-hit the provider limit. ` +
        `Route probing is suspended until ${until}. Gru should assess whether the limit is truly temporary.`,
      dedupe: 'active',
    });
    this.log('warn', 'false-recovery ladder escalated — route suspended', {
      route: route.routeKey,
      suspended_until: until,
    });
  }

  /** The concise sensor view for job/attention surfaces. */
  waitingView(): readonly {
    route: string;
    provider: string;
    model: string;
    waiters: number;
    nextCheckAt: string;
    lastResult: string | null;
    lastAttemptAt: string | null;
  }[] {
    const routes = new Map(
      this.ledger.listProviderRoutes().map((route) => [route.routeKey, route]),
    );
    const counts = new Map<string, number>();
    for (const wait of this.ledger.listProviderWaits({ status: 'waiting' })) {
      counts.set(wait.routeKey, (counts.get(wait.routeKey) ?? 0) + 1);
    }
    return [...counts.entries()].map(([routeKey, waiters]) => {
      const route = routes.get(routeKey);
      return {
        route: routeKey,
        provider: route?.provider ?? routeKey.split('/')[0] ?? '',
        model: route?.model ?? '',
        waiters,
        nextCheckAt: route?.nextCheckAt ?? '',
        lastResult: route?.lastResult ?? null,
        lastAttemptAt: route?.lastAttemptAt ?? null,
      };
    });
  }
}

/** Count a pending recovery's still-open waiters (digest surface). */
export function pendingRecoveryRows(
  ledger: Pick<LedgerApi, 'listProviderWaits' | 'listPendingProviderRecoveries'>,
): readonly {
  waitId: string;
  jobId: string | null;
  slotId: string | null;
  route: string;
  recoveredAt: string;
}[] {
  const created = new Map(
    ledger.listPendingProviderRecoveries().map((pending: PendingProviderRecoveryRecord) => [
      `${pending.routeKey}#${pending.incidentGeneration}`,
      pending.createdAt,
    ]),
  );
  return ledger
    .listProviderWaits({ status: 'recovered-pending' })
    .map((wait) => ({
      waitId: wait.id,
      jobId: wait.jobId,
      slotId: wait.slotId,
      route: wait.routeKey,
      recoveredAt: created.get(`${wait.routeKey}#${wait.incidentGeneration}`) ?? wait.updatedAt,
    }));
}
