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
  providerSupportsSensor,
  type ProviderRejectionEvidence,
  type TypedProviderResponse,
} from './classify.js';
import type { ProbeRoute, ProviderProbePort } from './probe.js';
import { blockedByOwnWallSettle } from './settle-attribution.js';
import { isJobTerminal } from '../ledger/states.js';

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

/** The notifications surface the sensor needs (NotificationCenter fits).
 * r4 note: this port DECLARES postIncident, not post — the real center's
 * `post` carries no dedupe, so a `dedupe` field there was silently
 * ignored and every establishment/escalation stacked a new row. The
 * incident post is the center's durable dedupe-capable write path. */
export interface SensorNotifications {
  postIncident(input: {
    kind: string;
    routing: 'fyi' | 'action-required';
    severity: 'info' | 'error';
    title: string;
    detail?: string | null;
    dedupe: 'unacked' | 'active' | 'all';
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

/** A non-generation metadata reader mapped onto the probe vocabulary
 * (Codex/Claude adapters; zero generation). */
export interface MetadataReaderPort {
  read(route: ProbeRoute): Promise<import('./probe.js').ProbeOutcome>;
}

export interface ProviderRecoverySensorOptions {
  readonly config: ProviderRecoveryConfig;
  readonly ledger: LedgerApi;
  /** GLM bounded generation fallback probe (config-gated; the overlay
   * keeps it DISABLED in production). */
  readonly probe: ProviderProbePort;
  /** Non-generation metadata readers keyed by provider id. */
  readonly metadataReaders?: Readonly<Record<string, MetadataReaderPort>>;
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
  /** The raw runtime error line (diagnostics; provider-message origin only). */
  readonly errorMessage: string;
  /** TYPED provider-response provenance (r1 #13) — required to establish a
   * wait: arbitrary turn exceptions carry none and stay owner-controlled. */
  readonly typed: TypedProviderResponse | null;
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
  if (observation.typed === null) {
    // r1 #13: no TYPED provider-response provenance (arbitrary turn
    // exception, lost SDK shape) — never an eligible wait.
    sensor.debugLog('provider wall without typed provider-response provenance — owner control preserved', {
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
  // Typed provenance is authoritative (r1 #13). The composed-line parser
  // only refines a provider-message origin whose typed block lacked the
  // body code; it can never manufacture evidence on its own.
  const evidence: ProviderRejectionEvidence = {
    provider: observation.provider,
    model: observation.model,
    errorMessage: observation.errorMessage,
    ...(observation.typed.status !== undefined ? { status: observation.typed.status } : {}),
    ...(observation.typed.bodyCode !== undefined ? { bodyCode: observation.typed.bodyCode } : {}),
    ...(observation.typed.retryAfterMs !== undefined ? { retryAfterMs: observation.typed.retryAfterMs } : {}),
  };
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
  // Single route-truth source: the shared runtime catalog + auth snapshot
  // resolves BOTH the exact endpoint and the credential fingerprint (r1 #3).
  return sensor.resolveAndRecordWait(observation, evidence);
}

/** Rolling budget window (1 h, per the approval's 12/hour pin). */
const WINDOW_MS = 3_600_000;

export class ProviderRecoverySensor {
  readonly enabled: boolean;
  private readonly cfg: ProviderRecoveryConfig;
  private readonly ledger: LedgerApi;
  readonly probe: ProviderProbePort;
  private readonly metadataReaders: Readonly<Record<string, MetadataReaderPort>>;
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
    this.metadataReaders = opts.metadataReaders ?? {};
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

  /** Reserve the observation BEFORE credential I/O: a stopped actor can
   * still have this producer pending, so its directive cannot retire yet. */
  async resolveAndRecordWait(observation: ProviderWallObservation, evidence: ProviderRejectionEvidence): Promise<ProviderWaitRecord | null> {
    let release: (() => void) | null = null;
    if (observation.role === 'minion' && observation.jobId !== null) {
      const job = this.ledger.getJob(observation.jobId);
      if (job === null || isJobTerminal(job.status) || this.ledger.hasOpenDirectiveRecoveryHold(job.id)) {
        this.debugLog('provider observation has no current job authority — no wait', { agent_id: observation.agentId, job_id: observation.jobId });
        return null;
      }
      release = this.ledger.beginJobAdmission(job.id, `provider wait establishment ${observation.agentId}`);
    }
    try {
      const resolved = await this.probeFor(evidence.provider).resolveRoute(evidence.provider, evidence.model);
      if (resolved === null || this.disposed) {
        this.debugLog('route/credential unavailable or sensor stopped — no wait', { agent_id: observation.agentId, provider: evidence.provider });
        return null;
      }
      return this.recordWait(observation, evidence, resolved.endpoint, resolved.credentialFingerprint);
    } finally {
      release?.();
    }
  }

  private retirementIdentity(wait: ProviderWaitRecord): 'current' | 'superseded' | 'unknown' {
    try {
      return this.ledger.providerWaitRetirementIdentity(wait);
    } catch (error) {
      this.log('error', 'provider retirement identity unreadable — wait held', { wait_id: wait.id, job_id: wait.jobId, error: String(error) });
      return 'unknown';
    }
  }

  /** The readiness port for a provider: a non-generation metadata reader
   * when one exists (Codex/Claude), else the GLM generation fallback ONLY
   * while config enables it (overlay: disabled in production). Returns null
   * (fail closed, no checks) when neither applies. */
  probeFor(provider: string): ProviderProbePort {
    const metadata = this.metadataReaders[provider];
    if (metadata !== undefined) {
      return {
        probe: (route) => metadata.read(route),
        resolveRoute: (p, m) => this.probe.resolveRoute(p, m),
      };
    }
    if (provider === 'zai-coding-cn' && this.cfg.glmGenerationFallback) {
      return this.probe;
    }
    // Fail-closed stub: a supported provider whose only readiness path is
    // the disabled GLM fallback resolves routes (wait establishment stays
    // possible) but every check reports a closed probe — never generation.
    return {
      probe: () =>
        Promise.resolve({
          kind: 'probe-failed',
          reason: 'no readiness path for this provider (GLM generation fallback disabled)',
          retryAfterMs: null,
        }),
      resolveRoute: (p, m) => this.probe.resolveRoute(p, m),
    };
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
      // 'hold': kept, but not probed — ambiguous state never retires the
      // provider blocker and never spends a check on an unactionable wait.
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
        endpoint: first.endpoint,
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

  /** Eligibility per waiter — TYPED distinction (r1 #1 phase3): the wait
   * itself is the durable record that THIS provider blocker stopped an
   * authorized unfinished continuation. Inputs are incident currency,
   * establishment-time evidence, replacement actors and explicit holds —
   * NEVER job.minion-error text, backlog membership, or `working` as
   * permission. Expected interrupted-turn churn (blocked/delivered/
   * in-review AFTER establishment) keeps the continuation ELIGIBLE;
   * pre-existing/generic blocks (those states AT establishment) HOLD with
   * zero I/O — EXCEPT a block that the ledger attributes to this wait's
   * OWN failed turn (the settle raced the wait): that is still this
   * blocker's churn, never a generic hold. Active review gates, stale
   * incidents and suspensions also HOLD. */
  private validateWaiter(wait: ProviderWaitRecord): 'eligible' | 'cancel' | 'supersede' | 'hold' {
    if (wait.waiterKind === 'job-minion') {
      const job = wait.jobId !== null ? this.ledger.getJob(wait.jobId) : null;
      if (job === null || isJobTerminal(job.status)) return 'cancel';
      // Preserve retired debt; capacity checks cannot recreate authority.
      if (this.retirementIdentity(wait) !== 'current') return 'hold';
      if (job.status === 'parked') return 'cancel'; // explicit manual hold
      if (wait.jobId !== null) {
        // Supersession requires a newer IMPLEMENTER (Gru ruling
        // 2026-09-29 + #161 union): a newer review-only session (round-
        // or lens-bound) or a tracked child never replaces the job's
        // writer — listImplementerMinions applies all three exclusions.
        const newer = this.ledger
          .listImplementerMinions(wait.jobId)
          .find((agent) => agent.id !== wait.agentId && agent.createdAt >= wait.createdAt);
        if (newer !== undefined) return 'supersede';
      }
      // Incident currency (rotation/staleness fencing).
      const route = this.ledger.getProviderRoute(wait.routeKey);
      if (
        route === null ||
        route.credentialFingerprint !== wait.credentialFingerprint ||
        route.endpoint !== wait.endpoint
      ) {
        return 'hold'; // binding changed or is being re-established — zero I/O
      }
      if (route.suspendedUntil !== null && Date.parse(route.suspendedUntil) > this.now()) return 'hold';
      // Quality gate: an ACTIVE review round owns the lane (never cleared by
      // provider recovery). Delivered/in-review WITHOUT an active round is
      // expected churn (the round already settled or never opened).
      if (job.status === 'in-review' && this.hasActiveReviewRound(wait.jobId)) return 'hold';
      // Generic/unknown block: the job was ALREADY blocked/delivered/in-review
      // when the provider stop was classified — the interrupted-turn churn
      // explanation does not apply; hold with zero I/O until ruled otherwise.
      // The one exception: a `blocked` status the ledger attributes to THIS
      // wait's own failing turn (the dispatch settle raced the wait) is the
      // blocker's own settlement, not a foreign hold (r4 directive).
      const atEstablishment = wait.jobStatusAtEstablishment;
      if (atEstablishment === 'blocked') {
        if (!blockedByOwnWallSettle(this.ledger, { jobId: wait.jobId, agentId: wait.agentId })) {
          return 'hold';
        }
      } else if (atEstablishment === 'delivered' || atEstablishment === 'in-review') {
        return 'hold';
      }
      // Otherwise: current approved continuation — eligible through the
      // expected post-establishment status churn.
      return 'eligible';
    }
    return this.silasHosted() ? 'eligible' : 'cancel';
  }

  private hasActiveReviewRound(jobId: string | null): boolean {
    if (jobId === null) return false;
    try {
      return this.ledger.listRounds(jobId).some((round) => round.status === 'pending' || round.status === 'live');
    } catch {
      return false; // no rounds readable = no active gate
    }
  }

  /** r4 finding 2: settle an ASYNC check on the FRESH route row. Writing
   * the pre-charge snapshot back would refund the charged attempt and
   * revert incident_seq / false_recovery_count / suspended_until that a
   * concurrent establishment or escalation updated mid-check. */
  private settleRoute(
    routeKey: string,
    changes: Partial<ProviderRouteRecord>,
    nowIso: string,
    event?: { kind: string; payload?: Record<string, unknown> },
  ): void {
    const fresh = this.ledger.getProviderRoute(routeKey);
    if (fresh === null) return; // row gone mid-check — nothing to settle
    this.ledger.upsertProviderRoute({ ...fresh, ...changes, updatedAt: nowIso }, event);
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
      endpoint: route.endpoint,
      credentialFingerprint: route.credentialFingerprint,
    };
    // r1 #5: reserve + CHARGE before the network I/O, in one transaction.
    // A crash after this point leaves the reservation (spent-unknown at
    // reconcile) — the budget and cadence were already advanced.
    const reservationExpiryMs = this.cfg.probeTimeoutMs + this.cfg.tickIntervalMs * 2 + 5_000;
    const blockedBy = this.ledger.reserveProviderProbe({
      routeKey,
      reservedAt: nowIso,
      expiresAt: new Date(nowMs + reservationExpiryMs).toISOString(),
    });
    if (blockedBy !== null) {
      if (Date.parse(blockedBy.expiresAt) <= nowMs) {
        // Interrupted mid-flight (crash): settle spent-unknown; the
        // previously-advanced cadence governs the next attempt.
        this.ledger.markProviderProbeSpentUnknown(routeKey);
        this.ledger.releaseProviderProbeReservation(routeKey);
        this.ledger.upsertProviderRoute(
          {
            ...route,
            lastResult: 'probe-unknown-crash',
            lastAttemptAt: nowIso,
            updatedAt: nowIso,
          },
          { kind: 'provider.probe-result', payload: { route: routeKey, result: 'probe-unknown-crash' } },
        );
      }
      return;
    }
    // The charge itself: budget + cadence advance BEFORE the I/O. Every
    // outcome class floors at the 300 s approval minimum (r1 #4).
    const provisionalDelay = this.cfg.cadenceMinMs;
    const base = {
      ...route,
      attemptsInWindow: attempts,
      lastAttemptAt: nowIso,
      consecutiveProbeFailures: 0,
      nextCheckAt: new Date(nowMs + provisionalDelay).toISOString(),
    };
    this.ledger.upsertProviderRoute(
      {
        ...base,
        updatedAt: nowIso,
      },
    );
    let outcome: Awaited<ReturnType<ProviderProbePort['probe']>>;
    try {
      outcome = await this.probeFor(route.provider).probe(probeRoute);
    } finally {
      this.ledger.releaseProviderProbeReservation(routeKey);
    }
    if (outcome.kind === 'completed') {
      // r1 #6: the check was ASYNC — reload and revalidate everything the
      // recovery is about to bind: fresh waiters (holds/completions/
      // replacements that landed mid-probe), incident currency, and the
      // route/credential binding (rotation = route change, fail closed).
      const revalidated = this.revalidateAfterCheck(route);
      if (revalidated === null) {
        // The route binding changed mid-check: never clobber the (new)
        // binding — mark the FRESH route row and recover nothing.
        const freshRoute = this.ledger.getProviderRoute(routeKey);
        if (freshRoute !== null) {
          this.ledger.upsertProviderRoute(
            { ...freshRoute, lastResult: 'route-changed-mid-check', updatedAt: nowIso },
            { kind: 'provider.probe-result', payload: { route: routeKey, result: 'route-changed-mid-check' } },
          );
        }
        return;
      }
      if (revalidated.length === 0) {
        // Valid evidence but every waiter settled mid-check: nothing to
        // deliver — record the outcome on the fresh route, commit nothing.
        this.settleRoute(routeKey, { lastResult: 'recovered-no-eligible-waiters' }, nowIso, {
          kind: 'provider.probe-result',
          payload: { route: routeKey, result: 'recovered-no-eligible-waiters' },
        });
        return;
      }
      await this.recoverRoute(route, revalidated, outcome.evidence as unknown as Record<string, unknown>, nowMs);
      return;
    }
    if (outcome.kind === 'still-limited') {
      const cadence = this.nextCheckDelay(outcome.retryAfterMs);
      this.settleRoute(
        routeKey,
        { lastResult: 'still-limited', nextCheckAt: new Date(nowMs + cadence).toISOString() },
        nowIso,
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
    // r1 #4: backoff LENGTHENS beyond the cadence floor; it can never go
    // below it — 300 s minimum spacing on every outcome class.
    const backoff = Math.max(
      this.cfg.cadenceMinMs,
      Math.min(this.cfg.probeBackoffBaseMs * 2 ** (failures - 1), this.cfg.probeBackoffMaxMs),
    );
    this.settleRoute(
      routeKey,
      {
        lastResult: 'probe-failed',
        consecutiveProbeFailures: failures,
        nextCheckAt: new Date(nowMs + backoff).toISOString(),
      },
      nowIso,
      {
        kind: 'provider.probe-result',
        payload: { route: routeKey, result: 'probe-failed', reason: outcome.reason, retry_in_ms: backoff },
      },
    );
    if (outcome.reason.includes('credential rotated')) {
      for (const wait of eligible) {
        // The check was ASYNC: only a row still waiting is superseded — an
        // owner/completion transition that landed mid-check already settled
        // it and must not be re-transitioned (terminal guards).
        const current = this.ledger.getProviderWait(wait.id);
        if (current !== null && current.status === 'waiting') {
          this.ledger.setProviderWaitStatus(wait.id, 'superseded', { why: 'credential-rotated' });
        }
      }
    }
  }

  /** Trustworthy Retry-After honored within the approved cadence policy:
   * never below the 300 s floor, never above the retryAfter cap. */
  private nextCheckDelay(retryAfterMs: number | null): number {
    if (retryAfterMs === null || retryAfterMs <= 0) return this.cfg.cadenceMinMs;
    return Math.max(this.cfg.cadenceMinMs, Math.min(retryAfterMs, this.cfg.retryAfterMaxMs));
  }

  /** r1 #6: reload + revalidate AFTER the async check. Returns the
   * still-eligible waiters bound to the SAME route/credential binding, or
   * null when the route itself changed (rotation mid-check). Fresh
   * dispositions are APPLIED here (a hold/cancel/supersede that landed
   * mid-check settles now, never at some later tick). */
  private revalidateAfterCheck(route: ProviderRouteRecord): readonly ProviderWaitRecord[] | null {
    const freshRoute = this.ledger.getProviderRoute(route.routeKey);
    if (
      freshRoute === null ||
      freshRoute.credentialFingerprint !== route.credentialFingerprint ||
      freshRoute.endpoint !== route.endpoint
    ) {
      return null;
    }
    const fresh = this.ledger.listProviderWaits({ status: 'waiting', routeKey: route.routeKey });
    const eligible: ProviderWaitRecord[] = [];
    for (const wait of fresh) {
      const disposition = this.validateWaiter(wait);
      if (disposition === 'eligible') eligible.push(wait);
      else if (disposition === 'cancel') {
        this.ledger.setProviderWaitStatus(wait.id, 'cancelled', { why: 'waiter-invalid-during-check' });
      } else if (disposition === 'supersede') {
        this.ledger.setProviderWaitStatus(wait.id, 'superseded', { why: 'replaced-during-check' });
      }
    }
    return eligible;
  }

  /** Persist the ATOMIC recovery batch (r1 #7/#8): the marker, the single
   * `provider.restored` event (the ONE durable Silas delivery path — the
   * event bus wake rides the existing SilasDriver one-slot coalescing; no
   * second explicit trigger), and EVERY matching waiter's flip commit in
   * one ledger transaction. Duplicate batch = no-op. */
  private async recoverRoute(
    route: ProviderRouteRecord,
    eligible: readonly ProviderWaitRecord[],
    evidence: Record<string, unknown>,
    nowMs: number,
  ): Promise<void> {
    const nowIso = new Date(nowMs).toISOString();
    // r4 finding 2: settle on the FRESH route row — never write the
    // pre-charge snapshot back (it would refund the charged attempt and
    // revert mid-check incident/escalation updates).
    this.settleRoute(
      route.routeKey,
      { lastResult: 'recovered', nextCheckAt: new Date(nowMs + this.cfg.cadenceMinMs).toISOString() },
      nowIso,
      {
        kind: 'provider.probe-result',
        payload: { route: route.routeKey, result: 'recovered', evidence },
      },
    );
    const batchId = `recovery-${route.routeKey}-${nowMs}`;
    const generations = [...new Set(eligible.map((wait) => wait.incidentGeneration))];
    const recorded = this.ledger.commitProviderRecoveryBatch({
      id: batchId,
      routeKey: route.routeKey,
      incidentGenerations: generations,
      evidence,
      waiters: eligible.map((wait) => ({ id: wait.id, jobId: wait.jobId })),
    });
    if (recorded === null) return; // duplicate observation — never a second delivery
    this.notifications.resolveIncidents(`provider.waiting.${route.routeKey}`, 'provider-recovery-sensor');
    // The Silas logical slot re-arms deterministically through the guarded
    // owned transition — never depending on the stopped COO.
    for (const wait of eligible) {
      if (wait.waiterKind === 'silas-slot' && wait.agentId !== null && this.slotReArm !== null) {
        this.slotReArm.ownedProviderReArm(wait.agentId, wait.id);
      }
    }
    this.log('info', 'provider recovery batch committed — one durable event delivery', {
      route: route.routeKey,
      batch: batchId,
      waiters: eligible.length,
    });
  }

  /** Retire delivery markers whose every waiter settled or was superseded. */
  private async settlePendingRecoveries(): Promise<void> {
    for (const pending of this.ledger.listPendingProviderRecoveries()) {
      const open = this.pendingBatchWaits(pending);
      if (open.every((wait) => wait.recoveryBatchId !== null && this.retirementIdentity(wait) === 'superseded')) {
        this.ledger.clearPendingProviderRecovery(pending.id);
      }
    }
  }

  private pendingBatchWaits(pending: PendingProviderRecoveryRecord): readonly ProviderWaitRecord[] {
    return this.ledger.listProviderWaits({ routeKey: pending.routeKey }).filter((wait) =>
      wait.status === 'recovered-pending' && (wait.recoveryBatchId === pending.id || wait.recoveryBatchId === null));
  }

  /** Boot/restart reconciliation: never silently re-baseline away an
   * outstanding wait or delivery. Routes keep their durable cadence; a
   * recovery that was recorded but never delivered re-wakes. */
  async reconcileAtBoot(): Promise<{ rewoken: number }> {
    if (!this.enabled) return { rewoken: 0 };
    let rewoken = 0;
    for (const pending of this.ledger.listPendingProviderRecoveries()) {
      const open = this.pendingBatchWaits(pending);
      if (open.every((wait) => wait.recoveryBatchId !== null && this.retirementIdentity(wait) === 'superseded')) {
        this.ledger.clearPendingProviderRecovery(pending.id);
        continue;
      }
      if (!open.some((wait) => wait.recoveryBatchId === pending.id && this.retirementIdentity(wait) === 'current')) continue;
      // The durable `provider.restored` event predates the restart; the ONE
      // delivery path is re-armed here — a single wake per open batch per
      // boot (request identity = the batch marker; the coalescer dedupes).
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
    endpoint: string,
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
        endpoint,
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
      // r4 note: if the catalog endpoint for this exact provider/model/
      // credential binding changed, re-bind the route row and retire any
      // waiting rows still bound to the old endpoint (they can never be
      // probed again) with a recorded reason — a new wait must not deadlock
      // the route on `route.endpoint !== wait.endpoint` forever.
      if (route.endpoint !== endpoint) {
        for (const stale of this.ledger.listProviderWaits({ status: 'waiting', routeKey })) {
          if (stale.endpoint !== endpoint) {
            this.ledger.setProviderWaitStatus(stale.id, 'superseded', {
              why: 'endpoint-rotated',
              from: stale.endpoint,
              to: endpoint,
            });
          }
        }
        route = this.ledger.upsertProviderRoute({
          ...route,
          endpoint,
          incidentSeq: generation,
          updatedAt: nowIso,
        });
      } else {
        route = this.ledger.upsertProviderRoute({ ...route, incidentSeq: generation, updatedAt: nowIso });
      }
    }
    // Renewed quota after a recovered continuation: a prior claimed or
    // still-pending wait for the same agent+route means the recovery was
    // false (the continuation re-hit the wall) — supersede the prior, climb
    // the bounded false-recovery ladder (escalation suspends the route
    // rather than looping).
    const lineage =
      observation.jobId !== null
        ? `job:${observation.jobId}`
        : observation.slotId !== null
          ? `slot:${observation.slotId}`
          : null;
    const prior = lineage !== null && replayed === undefined
      ? [
          ...this.ledger.listProviderWaits({ status: 'recovered-pending' }),
          ...this.ledger.listProviderWaits({ status: 'claimed' }),
        ].find((wait) => wait.lineageKey === lineage && wait.routeKey === routeKey)
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
    const jobAtStop = observation.jobId !== null ? this.ledger.getJob(observation.jobId) : null;
    const wait = this.ledger.recordProviderWait({
      id: randomUUID(),
      routeKey,
      provider: evidence.provider,
      model: evidence.model,
      endpoint,
      credentialFingerprint: fingerprint,
      jobStatusAtEstablishment: jobAtStop?.status ?? null,
      lineageKey:
        observation.jobId !== null
          ? `job:${observation.jobId}`
          : observation.slotId !== null
            ? `slot:${observation.slotId}`
            : null,
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
    // Concise attention surface (fyi; routine polling never chimes). The
    // incident post is deduped 'active': one row per route until the
    // recovery resolves it, never one row per establishment event.
    this.notifications.postIncident({
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
    this.notifications.postIncident({
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
