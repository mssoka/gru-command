import { statSync } from 'node:fs';
import type { Role, SupervisionConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { AgentHandle, AgentState, SpawnOptions } from '../runtime/types.js';
import type { AgentEventEnvelope } from '../runtime/registry.js';
import type { LedgerApi } from '../ledger/api.js';
import type { NotificationCenter } from '../notifications/center.js';
import type { DecisionService } from '../decisions/types.js';
import { deterministicFailureClass, supervisionDecisionRequest } from '../decisions/questions.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * The registry surface supervision consumes (structural — the real
 * RuntimeRegistry satisfies it; tests drive a controllable fake). Keeps
 * the supervisor decoupled from the concrete registry class.
 */
export interface SupervisorRegistry {
  onAgentEvent(listener: (envelope: AgentEventEnvelope) => void): () => void;
  getHandle(agentId: string): AgentHandle | null;
  spawn(role: Role, options?: SpawnOptions): Promise<AgentHandle>;
  disposeHandle(handle: AgentHandle): Promise<void>;
}

/**
 * In-process supervisor (EPICS E7 story 1; SPEC ruling 5): watches every
 * agent the registry hosts — turn-liveness watchdog (E3's named
 * deferral), restart ladder with backoff, crash-loop breaker
 * (max_restarts within a rolling window → stop + escalate + board mark).
 *
 * The OS service manager is the OUT-OF-BAND watcher for the service
 * itself; this supervisor never leaves the process. It consumes only the
 * registry tap, handle health, and session-file size — never a concrete
 * adapter (SPEC ruling 4).
 *
 * Liveness = events OR bytes: any runtime event, or growth of the
 * session jsonl, resets the turn-silence clock — a slow-but-alive tool
 * run never trips the watchdog.
 *
 * In-band turn errors (state 'error', next turn recovers — the adapter
 * contract) are NEVER restarts. Only hangs (open turn, silence past the
 * timeout) and fatal runtime errors climb the ladder.
 */

export type SupervisionState = 'watching' | 'restarting' | 'stopped';

/** Per-agent supervision view (board + /health). */
export interface AgentSupervisionView {
  readonly agentId: string;
  readonly role: Role;
  readonly slotId: string | null;
  readonly state: SupervisionState;
  /** Restarts inside the current window (the breaker ring size). */
  readonly restarts: number;
  readonly breakerOpen: boolean;
  readonly openTurn: boolean;
  readonly lastEventAt: string | null;
  readonly lastFileBytes: number | null;
}

export interface SupervisionStatus {
  readonly enabled: boolean;
  readonly turnSilenceMs: number;
  readonly restartWindowMs: number;
  readonly maxRestarts: number;
  readonly agents: readonly AgentSupervisionView[];
}

interface SupervisedAgent {
  agentId: string;
  role: Role;
  slot: SupervisedSlotInternal | null;
  slotGeneration: number;
  handle: AgentHandle | null;
  sessionFile: string | null;
  state: SupervisionState;
  openTurn: boolean;
  openControl: boolean;
  lastEventAt: number;
  lastFileBytes: number | null;
  /** Restart timestamps (epoch ms) — the breaker ring. */
  restartRing: number[];
  consecutiveFailures: number;
  breakerOpen: boolean;
  breakerNotificationId: string | null;
  /** A restart rung is executing: disposed envelopes must not evict us. */
  inRestart: boolean;
  /** Pending backoff timer (a scheduled next rung). */
  backoffTimer: ReturnType<typeof setTimeout> | null;
  /** Monotonic event/adoption generation; timestamps can collide within one ms. */
  activityGeneration: number;
  /** One classification at a time; watchdog ticks cannot create spend loops. */
  decisionPending: boolean;
  /** True while an adapter's error/state:error/turn_end sequence belongs to
   * the failure currently being classified rather than to new activity. */
  failureTerminalPending: boolean;
  /** Latest failure arriving during classification; replayed only while its
   * captured entity/activity token still describes the same failed handle. */
  queuedRecovery: {
    reason: string;
    allowRestart: boolean;
    runtimeError: boolean;
    handle: AgentHandle | null;
    activityGeneration: number;
    openTurn: boolean;
  } | null;
}

/** A declared supervision slot — a stable identity that outlives handles
 * (the Gru chat session today; E8's dispatch flow declares more). */
export interface SupervisedSlot {
  readonly id: string;
  readonly role: Role;
  /** Spawn (adopting the result); usually wraps registry.spawn. */
  ensure(options?: SpawnOptions): Promise<AgentHandle>;
  /** The current live handle, or null between restarts. */
  current(): AgentHandle | null;
  /** Fired when a supervisor restart produced a new live handle. */
  onSwap(listener: (handle: AgentHandle) => void): () => void;
  /** Whether an intentional replacement may commit now. An open breaker
   * fails closed: chat must not install a handle the watchdog will ignore. */
  canReplace(): boolean;
  /** Intentionally make an already-spawned fresh handle current. This
   * advances the slot generation so an older restart cannot swap back in. */
  adoptReplacement(handle: AgentHandle): Promise<void>;
  /** Deregister the slot (owner shutdown); stops supervision of it. */
  release(): void;
}

interface SupervisedSlotInternal {
  readonly id: string;
  readonly role: Role;
  readonly spawn: (options?: SpawnOptions) => Promise<AgentHandle>;
  readonly swapListeners: Set<(handle: AgentHandle) => void>;
  generation: number;
}

export interface SupervisorOptions {
  readonly config: SupervisionConfig;
  readonly registry: SupervisorRegistry;
  readonly ledger: LedgerApi;
  readonly notifications: NotificationCenter;
  /** Optional decision service: classifies failure signatures for
   * restart-versus-escalate guidance. Counters, ceilings, stop/cancel state,
   * and re-arm remain deterministic here regardless of this service. */
  readonly decisions?: DecisionService;
  readonly log?: Log;
  /** Test seam: tick interval override (default: min(silence/4, 5 s)). */
  readonly tickMs?: number;
  /** Test seam: clock (default Date.now). */
  readonly now?: () => number;
}

export class Supervisor {
  private readonly cfg: SupervisionConfig;
  private readonly registry: SupervisorRegistry;
  private readonly ledger: LedgerApi;
  private readonly notifications: NotificationCenter;
  private readonly decisions: DecisionService | null;
  private readonly log: Log;
  private readonly now: () => number;
  private readonly agents = new Map<string, SupervisedAgent>();
  private readonly slots = new Map<string, SupervisedSlotInternal>();
  private readonly unsubscribeTap: () => void;
  private readonly tickOverride: number | null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(opts: SupervisorOptions) {
    this.cfg = opts.config;
    this.registry = opts.registry;
    this.ledger = opts.ledger;
    this.notifications = opts.notifications;
    this.decisions = opts.decisions ?? null;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.tickOverride = opts.tickMs ?? null;
    this.unsubscribeTap = this.registry.onAgentEvent((envelope) => this.onEnvelope(envelope));
  }

  /** Start the watchdog ticker. */
  start(): void {
    if (this.disposed || this.ticker !== null) return;
    // Cadence: a quarter of the silence window, capped at 5 s so a tight
    // window still ticks promptly.
    const tick = this.tickOverride ?? Math.min(this.cfg.turnSilenceMs / 4, 5_000);
    this.ticker = setInterval(() => this.tick(), tick);
    this.ticker.unref?.();
  }

  /** Declare a supervision slot (stable identity across restarts). */
  declareSlot(input: { id: string; role: Role; spawn: (options?: SpawnOptions) => Promise<AgentHandle> }): SupervisedSlot {
    const internal: SupervisedSlotInternal = {
      id: input.id,
      role: input.role,
      spawn: input.spawn,
      swapListeners: new Set(),
      generation: 0,
    };
    this.slots.set(input.id, internal);
    return {
      id: input.id,
      role: input.role,
      ensure: (options) => this.ensureSlot(internal, options),
      current: () => {
        for (const agent of this.agents.values()) {
          if (
            agent.slot === internal &&
            agent.slotGeneration === internal.generation &&
            agent.handle !== null
          ) return agent.handle;
        }
        return null;
      },
      onSwap: (listener) => {
        internal.swapListeners.add(listener);
        return () => {
          internal.swapListeners.delete(listener);
        };
      },
      canReplace: () => this.slotAgent(internal)?.breakerOpen !== true,
      adoptReplacement: (handle) => this.adoptSlotReplacement(internal, handle),
      release: () => {
        // Invalidate in-flight restart rungs before deleting their records.
        internal.generation += 1;
        this.slots.delete(internal.id);
        for (const agent of this.agents.values()) {
          if (agent.slot === internal) {
            if (agent.backoffTimer !== null) clearTimeout(agent.backoffTimer);
            this.agents.delete(agent.agentId);
          }
        }
      },
    };
  }

  private async ensureSlot(
    slot: SupervisedSlotInternal,
    options?: SpawnOptions,
  ): Promise<AgentHandle> {
    const existing = this.slotAgent(slot);
    if (existing !== null && existing.handle !== null) return existing.handle;
    if (existing !== null && existing.inRestart) {
      // A restart rung owns the respawn; wait for it by polling the slot.
      return await this.waitForSlotHandle(slot);
    }
    if (existing !== null && existing.breakerOpen) {
      if (!this.cfg.enabled) {
        // Supervision off: no re-arm semantics — clear the stale breaker
        // state so the slot serves again (pure registry behavior).
        existing.breakerOpen = false;
        existing.breakerNotificationId = null;
        existing.restartRing = [];
      } else {
        // A caller-driven action (a chat message) is human intent: re-arm
        // the stopped agent rather than serving it unsupervised — and the
        // escalation row resolves with it (acked by the re-arm itself).
        existing.breakerOpen = false;
        const rearming = existing.breakerNotificationId;
        existing.breakerNotificationId = null;
        existing.restartRing = [];
        existing.consecutiveFailures = 0;
        existing.state = 'watching';
        this.log('info', 'breaker re-armed by slot use — resuming supervision', {
          agent_id: existing.agentId,
          slot: slot.id,
        });
        this.ledger.appendCustomEvent({
          kind: 'supervision.rearmed',
          agentId: existing.agentId,
          payload: { by: 'slot-use', slot: slot.id },
        });
        if (rearming !== null) this.notifications.ack(rearming, 'slot-use');
      }
    }
    const ensureGeneration = slot.generation;
    const handle = await slot.spawn(options);
    if (this.disposed || this.slots.get(slot.id) !== slot) {
      await this.registry.disposeHandle(handle).catch(() => {});
      throw new Error(`supervised slot "${slot.id}" is not active`);
    }
    if (slot.generation !== ensureGeneration) {
      // An intentional replacement won while this ordinary ensure spawn was
      // in flight. Never attach the stale result to the replacement's newer
      // generation or leave a second live handle behind.
      await this.registry.disposeHandle(handle).catch(() => {});
      const current = this.slotAgent(slot)?.handle ?? null;
      if (current !== null) return current;
      throw new Error(`supervised slot "${slot.id}" changed generation during ensure`);
    }
    this.adopt(handle, slot, options?.resumeFile ?? null);
    // A handle death outside a restart rung (owner teardown) can leave a
    // stale slot-bound record shadowing the fresh one — retire stale
    // records so the NEXT ensure returns THIS handle (single-writer,
    // SPEC ruling 1), carrying the restart ring onto the live record.
    this.retireStaleSlotRecords(slot, handle.id);
    return handle;
  }

  private async adoptSlotReplacement(
    slot: SupervisedSlotInternal,
    handle: AgentHandle,
  ): Promise<void> {
    if (this.disposed || this.slots.get(slot.id) !== slot) {
      await this.registry.disposeHandle(handle).catch(() => {});
      throw new Error(`supervised slot "${slot.id}" is not active`);
    }
    if ([...this.agents.values()].some((agent) => agent.slot === slot && agent.breakerOpen)) {
      await this.registry.disposeHandle(handle).catch(() => {});
      throw new Error(`supervised slot "${slot.id}" breaker is open`);
    }
    const retired = [...this.agents.values()].filter(
      (agent) => agent.slot === slot && agent.agentId !== handle.id,
    );
    const inheritedRestartRing = retired
      .flatMap((agent) => agent.restartRing)
      .sort((left, right) => left - right);
    const inheritedBreaker = retired.find((agent) => agent.breakerOpen);
    const inheritedFailures = retired.reduce(
      (highest, agent) => Math.max(highest, agent.consecutiveFailures),
      0,
    );

    slot.generation += 1;
    const generation = slot.generation;
    this.adopt(handle, slot, handle.sessionFile);
    const live = this.agents.get(handle.id);
    if (live !== undefined) {
      live.slot = slot;
      live.slotGeneration = generation;
      live.handle = handle;
      live.sessionFile = handle.sessionFile;
      live.state = inheritedBreaker === undefined ? 'watching' : 'stopped';
      live.openTurn = false;
      live.openControl = false;
      live.inRestart = false;
      live.restartRing = [...live.restartRing, ...inheritedRestartRing]
        .sort((left, right) => left - right);
      live.consecutiveFailures = Math.max(live.consecutiveFailures, inheritedFailures);
      live.breakerOpen = inheritedBreaker !== undefined;
      live.breakerNotificationId =
        inheritedBreaker?.breakerNotificationId ?? live.breakerNotificationId;
    }

    for (const agent of retired) {
      if (agent.backoffTimer !== null) clearTimeout(agent.backoffTimer);
      // Intentional session replacement invalidates stale work by generation;
      // it does not erase restart history or acknowledge a human-facing
      // breaker notification. Both follow the stable supervised slot.
      this.agents.delete(agent.agentId);
      const old = agent.handle;
      agent.handle = null;
      if (old !== null) {
        await this.registry.disposeHandle(old).catch((error: unknown) => {
          this.log('warn', 'dispose during intentional slot replacement failed', {
            agent_id: agent.agentId,
            error: String(error),
          });
        });
      }
    }
    this.log('info', 'adopted intentional fresh slot replacement', {
      slot: slot.id,
      agent_id: handle.id,
      generation,
    });
  }

  /**
   * The live record for a slot: one with a live handle wins; a restarting
   * or breaker-open record outranks a dead idle one (ensure must find the
   * in-flight state, not spawn duplicates past it).
   */
  private slotAgent(slot: SupervisedSlotInternal): SupervisedAgent | null {
    let stale: SupervisedAgent | null = null;
    let staleRank = -1;
    for (const agent of this.agents.values()) {
      if (agent.slot !== slot || agent.slotGeneration !== slot.generation) continue;
      if (agent.handle !== null) return agent;
      const rank = agent.inRestart ? 2 : agent.breakerOpen ? 1 : 0;
      if (rank >= staleRank) {
        stale = agent;
        staleRank = rank;
      }
    }
    return stale;
  }

  /** Retire dead (null-handle) slot-bound records other than the live
   * one, merging their restart history so the breaker stays truthful. */
  private retireStaleSlotRecords(slot: SupervisedSlotInternal, liveId: string): void {
    const live = this.agents.get(liveId);
    for (const agent of [...this.agents.values()]) {
      if (agent.slot !== slot || agent.handle !== null || agent.agentId === liveId) continue;
      if (live !== undefined) {
        live.restartRing = [...live.restartRing, ...agent.restartRing].sort((a, b) => a - b);
        if (agent.breakerOpen && !live.breakerOpen) {
          live.breakerOpen = true;
          live.breakerNotificationId = agent.breakerNotificationId;
          live.state = 'stopped';
        }
      }
      if (agent.backoffTimer !== null) clearTimeout(agent.backoffTimer);
      this.agents.delete(agent.agentId);
      this.log('info', 'retired stale slot-bound supervision record', {
        agent_id: agent.agentId,
        slot: slot.id,
        live: liveId,
      });
    }
  }

  private async waitForSlotHandle(slot: SupervisedSlotInternal): Promise<AgentHandle> {
    // Deadline must exceed the backoff cap (60s) so a late rung's respawn
    // is awaited, not reported as a failure.
    const deadline = this.now() + 90_000;
    for (;;) {
      const agent = this.slotAgent(slot);
      if (agent === null || agent.handle !== null) {
        const final = agent?.handle ?? null;
        if (final !== null) return final;
        throw new Error(`supervised slot "${slot.id}" has no live handle`);
      }
      if (this.now() >= deadline) {
        throw new Error(`timed out waiting for supervised slot "${slot.id}" restart`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  // ------------------------------------------------------------------
  // Registry tap feed
  // ------------------------------------------------------------------

  private onEnvelope(envelope: AgentEventEnvelope): void {
    if (this.disposed) return;
    try {
      if (envelope.phase === 'spawned') {
        const handle = this.registry.getHandle(envelope.agentId);
        this.adopt(handle ?? null, null, envelope.sessionFile, envelope);
        return;
      }
      if (envelope.phase === 'disposed') {
        const agent = this.agents.get(envelope.agentId);
        if (agent === undefined) return;
        agent.handle = null;
        agent.openTurn = false;
        agent.openControl = false;
        // A breaker-STOPPED agent keeps its record: the escalation names
        // it and the ack must find it to re-arm (deleting here would strand
        // the stopped agent — same reasoning as inRestart stickiness).
        if (agent.slot === null && !agent.inRestart && !agent.breakerOpen) {
          this.agents.delete(envelope.agentId); // owner-disposed minion: stop watching
        }
        return;
      }
      // phase 'event'
      const agent = this.agents.get(envelope.agentId);
      if (agent === undefined) return;
      const event = envelope.event;
      if (event === undefined) return;
      agent.lastEventAt = this.now();
      // Adapters emit `error` followed immediately by their sticky
      // `state:error`. The latter is the same failure, not recovery/new
      // activity; letting it advance the token would invalidate the bounded
      // provider-wall decision started by the error event itself.
      const expectedFailureTerminal =
        agent.decisionPending &&
        agent.failureTerminalPending &&
        ((event.type === 'state' && event.state === 'error') || event.type === 'turn_end');
      if (!expectedFailureTerminal) {
        agent.activityGeneration += 1;
        if (event.type !== 'error') agent.failureTerminalPending = false;
      }
      switch (event.type) {
        case 'turn_start':
          agent.openTurn = true;
          break;
        case 'turn_end':
          agent.openTurn = false;
          break;
        case 'compaction_start':
          agent.openControl = true;
          break;
        case 'compaction_end':
          agent.openControl = false;
          break;
        case 'state':
          if (event.state === 'disposed') {
            agent.openTurn = false;
            agent.openControl = false;
          }
          break;
        case 'error':
          if (!this.cfg.enabled) {
            // Supervision off = pure registry behavior: errors are the
            // runtime's/owner's business — observed, never acted on.
            this.log('info', 'runtime error observed — supervision disabled, no restart', {
              agent_id: agent.agentId,
              error: event.error,
            });
            break;
          }
          if (event.fatal) {
            this.log('warn', 'fatal runtime error — climbing restart ladder', {
              agent_id: agent.agentId,
              error: event.error,
            });
            void this.evaluateRecovery(agent, `fatal error: ${event.error}`, true, true);
          } else {
            // Preserve the adapter contract: in-band failures never restart.
            // They still enter provider-wall classification so known auth or
            // quota failures produce durable stop/re-arm guidance.
            void this.evaluateRecovery(agent, `runtime error: ${event.error}`, false, true);
          }
          break;
        default:
          break;
      }
    } catch (error) {
      // The supervisor is an observer of the tap: its own bugs must never
      // take the runtime path down.
      this.log('error', 'supervisor failed to process agent event', {
        agent_id: envelope.agentId,
        error: String(error),
      });
    }
  }

  /** Idempotent adoption by agent id; creates or refreshes the record. */
  private adopt(
    handle: AgentHandle | null,
    slot: SupervisedSlotInternal | null,
    resumeFile: string | null,
    envelope?: AgentEventEnvelope,
  ): boolean {
    const agentId = handle?.id ?? envelope?.agentId;
    const role = handle?.role ?? envelope?.role;
    if (agentId === undefined || role === undefined) return false;
    const existing = this.agents.get(agentId);
    if (existing !== undefined) {
      existing.handle = handle ?? existing.handle;
      existing.role = role;
      if (slot !== null) {
        existing.slot = slot;
        existing.slotGeneration = slot.generation;
      }
      if (envelope?.sessionFile !== null && envelope?.sessionFile !== undefined) {
        existing.sessionFile = envelope.sessionFile;
      } else if (existing.sessionFile === null && resumeFile !== null) {
        existing.sessionFile = resumeFile;
      }
      if (handle !== null && handle.sessionFile !== null) existing.sessionFile = handle.sessionFile;
      existing.lastEventAt = this.now();
      existing.activityGeneration += 1;
      return true;
    }
    const sessionFile = handle?.sessionFile ?? envelope?.sessionFile ?? resumeFile ?? null;
    this.agents.set(agentId, {
      agentId,
      role,
      slot,
      slotGeneration: slot?.generation ?? 0,
      handle,
      sessionFile,
      state: 'watching',
      openTurn: false,
      openControl: false,
      lastEventAt: this.now(),
      lastFileBytes: this.fileSize(sessionFile),
      restartRing: [],
      consecutiveFailures: 0,
      breakerOpen: false,
      breakerNotificationId: null,
      inRestart: false,
      backoffTimer: null,
      activityGeneration: 0,
      decisionPending: false,
      failureTerminalPending: false,
      queuedRecovery: null,
    });
    this.log('info', 'supervising agent', { agent_id: agentId, role, slot: slot?.id ?? null });
    return true;
  }

  // ------------------------------------------------------------------
  // Watchdog tick
  // ------------------------------------------------------------------

  private tick(): void {
    if (this.disposed || !this.cfg.enabled) return;
    const now = this.now();
    for (const agent of this.agents.values()) {
      if (agent.handle === null || agent.state !== 'watching' || agent.breakerOpen) continue;
      const health = this.handleState(agent.handle);
      const busy = health === 'streaming' || health === 'spawning';
      if (!busy && !agent.openTurn && !agent.openControl) continue;
      // Liveness = events OR bytes: session-file growth also resets the clock.
      const bytes = this.fileSize(agent.sessionFile);
      if (bytes !== null && agent.lastFileBytes !== null && bytes > agent.lastFileBytes) {
        agent.lastFileBytes = bytes;
        agent.lastEventAt = now;
        agent.activityGeneration += 1;
        continue;
      }
      if (bytes !== null) agent.lastFileBytes = bytes;
      const silence = now - agent.lastEventAt;
      if (silence >= this.cfg.turnSilenceMs) {
        if (agent.handle?.reviewIsolation === true) {
          this.abortIsolatedReviewAttempt(agent, 'turn hang');
          continue;
        }
        const reason = agent.openControl ? 'compaction hang' : 'turn hang';
        this.log('warn', `${reason} detected — climbing restart ladder`, {
          agent_id: agent.agentId,
          silence_ms: silence,
          threshold_ms: this.cfg.turnSilenceMs,
        });
        void this.evaluateRecovery(agent, reason);
      }
    }
  }

  private handleState(handle: AgentHandle): AgentState {
    try {
      return handle.health().state;
    } catch {
      return 'disposed';
    }
  }

  private fileSize(file: string | null): number | null {
    if (file === null) return null;
    try {
      return statSync(file).size;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------
  // Decision-backed recovery guidance + restart ladder
  // ------------------------------------------------------------------

  /** Review attempts are fresh, ambient-free, and owned by the enclosing
   * Perkins workflow. Abort the attempt; never respawn it through the generic
   * resume ladder, which would violate isolation and attempt accounting. */
  private abortIsolatedReviewAttempt(agent: SupervisedAgent, reason: string): void {
    if (agent.inRestart || agent.handle === null) return;
    const handle = agent.handle;
    // Persistent workflow-owned stop guard: late fatal/state events from the
    // detached handle must never enter the generic restart ladder.
    agent.inRestart = true;
    agent.handle = null;
    agent.openTurn = false;
    agent.state = 'stopped';
    this.log('warn', 'isolated review attempt aborted for workflow-owned recovery', {
      agent_id: agent.agentId,
      reason,
    });
    void (async () => {
      try {
        try {
          this.ledger.setAgentState(agent.agentId, 'error', reason);
        } catch (error) {
          this.log('warn', 'isolated review stop state could not be persisted', {
            agent_id: agent.agentId,
            error: String(error),
          });
        }
        try {
          this.ledger.appendCustomEvent({
            kind: 'supervision.review-attempt-aborted',
            agentId: agent.agentId,
            payload: { reason },
          });
        } catch (error) {
          this.log('warn', 'isolated review abort event could not be persisted', {
            agent_id: agent.agentId,
            error: String(error),
          });
        }
      } finally {
        try {
          await this.registry.disposeHandle(handle);
        } catch (error) {
          this.log('warn', 'isolated review attempt disposal failed', {
            agent_id: agent.agentId,
            error: String(error),
          });
        }
      }
    })();
  }

  /** Classify one failure signature and route recovery guidance. The
   * deterministic ladder (counters, ceilings, backoff, breaker, re-arm) stays
   * authoritative: Jev classifies the signature only and can never grant a
   * restart past these guards — an `act`-band restart_advised with requireConfirm
   * still stops for a human, and known auth/quota walls always stop without
   * burning rungs, whatever the model answers. */
  private async evaluateRecovery(
    agent: SupervisedAgent,
    reason: string,
    allowRestart = true,
    runtimeError = false,
  ): Promise<void> {
    // Perkins review attempts are owned by the bounded review workflow. A
    // supervisor resume would drop that attempt's cwd/isolation contract and
    // race the workflow's one permitted retry, so abort the handle only; the
    // workflow records/retries it and owns every replacement.
    if (agent.handle?.reviewIsolation === true) {
      this.abortIsolatedReviewAttempt(agent, reason);
      return;
    }
    const deterministicClass = deterministicFailureClass(reason);
    const deterministicWall = deterministicClass === 'authentication_wall' || deterministicClass === 'quota_wall';
    if (this.decisions === null) {
      if (deterministicWall && !agent.breakerOpen && !agent.inRestart && agent.handle !== null) {
        this.stopForGuidance(agent, deterministicClass);
      } else if (allowRestart) {
        await this.restartRung(agent, reason);
      }
      return;
    }
    if (agent.decisionPending) {
      // Keep only the newest trigger: bounded one-slot replay avoids both a
      // spend loop and the old failure mode where a second error invalidated
      // the first decision then vanished.
      agent.queuedRecovery = {
        reason,
        allowRestart,
        runtimeError,
        handle: agent.handle,
        activityGeneration: agent.activityGeneration,
        openTurn: agent.openTurn,
      };
      if (runtimeError) agent.failureTerminalPending = true;
      return;
    }
    if (agent.inRestart || agent.breakerOpen || agent.handle === null) return;
    agent.decisionPending = true;
    agent.failureTerminalPending = runtimeError;
    const expectedHandle = agent.handle;
    const expectedActivityGeneration = agent.activityGeneration;
    const expectedOpenTurn = agent.openTurn;
    const request = supervisionDecisionRequest({
      reason,
      agentId: agent.agentId,
      role: agent.role,
      restartCount: agent.restartRing.length,
      breakerLimit: this.cfg.maxRestarts,
    });
    try {
      const outcome = await this.decisions.decide(request);
      // The entity may have been stopped/disposed/replaced while Jev was
      // answering. A stale answer never starts a restart.
      if (
        this.disposed ||
        this.agents.get(agent.agentId) !== agent ||
        agent.handle !== expectedHandle ||
        agent.activityGeneration !== expectedActivityGeneration ||
        (!runtimeError && agent.openTurn !== expectedOpenTurn) ||
        agent.breakerOpen
      ) return;
      const classAnswer = outcome.routes.failure_class.path === 'fallback'
        ? request.fallback.failure_class
        : outcome.answers.failure_class;
      const restartAnswer = outcome.routes.restart_advised.path === 'fallback'
        ? request.fallback.restart_advised
        : outcome.answers.restart_advised;
      // Model guidance may refine unknown/transient failures, but it cannot
      // contradict a provider wall that is already evident in the runtime
      // error. Burning restart rungs on known auth/quota walls is futile.
      const failureClass = deterministicWall ? deterministicClass : classAnswer.choice;
      const classifiedWall = failureClass === 'authentication_wall' || failureClass === 'quota_wall';
      const restartAdvised = classifiedWall ? false : restartAnswer.noul >= 0.5;
      const restartRoute = outcome.routes.restart_advised;
      const restartAuthorized =
        restartAdvised && restartRoute.path === 'act' && restartRoute.requiresConfirm === false;
      this.ledger.appendCustomEvent({
        kind: 'supervision.guidance',
        agentId: agent.agentId,
        payload: {
          class: failureClass,
          restart_advised: restartAdvised,
          restart_authorized: restartAuthorized,
          source: deterministicWall ? 'deterministic_guard' : outcome.provenance.source,
          route: deterministicWall ? 'fallback' : restartRoute.path,
          requires_confirm: deterministicWall ? false : restartRoute.requiresConfirm,
        },
      });
      if (
        failureClass === 'authentication_wall' ||
        failureClass === 'quota_wall' ||
        !restartAuthorized
      ) {
        this.stopForGuidance(
          agent,
          restartAdvised && !restartAuthorized ? 'restart_confirmation_required' : failureClass,
        );
        return;
      }
      if (allowRestart) await this.restartRung(agent, reason);
    } catch (error) {
      this.log('error', 'recovery classification failed; using deterministic restart guards', {
        agent_id: agent.agentId,
        error: String(error),
      });
      if (
        !this.disposed &&
        this.agents.get(agent.agentId) === agent &&
        agent.handle === expectedHandle &&
        agent.activityGeneration === expectedActivityGeneration &&
        (runtimeError || agent.openTurn === expectedOpenTurn) &&
        !agent.breakerOpen
      ) {
        if (deterministicWall) this.stopForGuidance(agent, deterministicClass);
        else if (allowRestart) await this.restartRung(agent, reason);
      }
    } finally {
      agent.decisionPending = false;
      agent.failureTerminalPending = false;
      const queued = agent.queuedRecovery;
      agent.queuedRecovery = null;
      const queuedTurnStillMatches = queued?.runtimeError === true || queued?.openTurn === agent.openTurn;
      if (
        queued !== null &&
        !this.disposed &&
        !agent.inRestart &&
        !agent.breakerOpen &&
        agent.handle !== null &&
        agent.handle === queued.handle &&
        agent.activityGeneration === queued.activityGeneration &&
        queuedTurnStillMatches
      ) {
        void this.evaluateRecovery(agent, queued.reason, queued.allowRestart, queued.runtimeError);
      }
    }
  }

  /** Known futile retry walls stop once and require the existing human ack
   * re-arm path; they never burn the restart ring blindly. */
  private stopForGuidance(agent: SupervisedAgent, failureClass: string): void {
    if (agent.breakerOpen) return;
    agent.breakerOpen = true;
    agent.state = 'stopped';
    agent.openTurn = false;
    agent.openControl = false;
    const handle = agent.handle;
    agent.handle = null;
    this.ledger.appendCustomEvent({
      kind: 'supervision.escalated',
      agentId: agent.agentId,
      payload: { class: failureClass, restarts: agent.restartRing.length },
    });
    const notification = this.notifications.postIncident({
      kind: `supervision.provider-wall.${agent.agentId}.${failureClass}`,
      routing: 'action-required',
      severity: 'error',
      title: `Agent ${agent.agentId} stopped: ${failureClass.replaceAll('_', ' ')}`,
      detail: 'Blind restart is withheld. Resolve the provider condition, then ack to re-arm the deterministic restart ladder.',
      agentId: agent.agentId,
      dedupe: 'unacked',
    });
    agent.breakerNotificationId = notification.id;
    if (handle !== null) {
      void this.registry.disposeHandle(handle).catch((error: unknown) => {
        this.log('warn', 'dispose after provider-wall escalation failed', {
          agent_id: agent.agentId,
          error: String(error),
        });
      });
    }
  }

  /** One restart rung. Single-flight per agent: a later trigger while a
   * rung is executing is absorbed (the rung's spawn IS the recovery).
   * Supervision NEVER takes the service down: any internal throw is
   * caught, logged, and the rung settles. */
  private async restartRung(agentRef: SupervisedAgent, reason: string): Promise<void> {
    const agent = agentRef;
    if (this.disposed || !this.cfg.enabled || agent.inRestart || agent.breakerOpen) return;
    if (agent.handle?.reviewIsolation === true) {
      this.abortIsolatedReviewAttempt(agent, reason);
      return;
    }
    agent.inRestart = true;
    agent.state = 'restarting';
    try {
      await this.restartRungInner(agent, reason);
    } catch (error) {
      // A supervision bug or ledger hiccup must never kill the service
      // (unhandled rejections are fatal in main). Settle the rung.
      agent.state = agent.breakerOpen ? 'stopped' : 'watching';
      this.log('error', 'restart rung threw — settling', {
        agent_id: agent.agentId,
        reason,
        error: String(error),
      });
    } finally {
      agent.inRestart = agent.backoffTimer !== null;
      if (agent.state === 'restarting' && agent.backoffTimer === null) agent.state = 'watching';
    }
  }

  private async restartRungInner(agentRef: SupervisedAgent, reason: string): Promise<void> {
    let agent = agentRef;
    const restartSlot = agent.slot;
    const restartGeneration = agent.slotGeneration;
    try {
      if (restartSlot !== null && restartSlot.generation !== restartGeneration) return;
      const windowStart = this.now() - this.cfg.restartWindowMs;
      agent.restartRing = agent.restartRing.filter((ts) => ts >= windowStart);
      if (agent.restartRing.length >= this.cfg.maxRestarts) {
        this.tripBreaker(agent);
        return;
      }
      if (agent.restartRing.length === 0) {
        // A new cluster: one FYI notification per incident, not per rung.
        const kind = reason.startsWith('turn hang') || reason.startsWith('compaction hang')
          ? 'supervision.hang'
          : reason.startsWith('fatal error')
            ? 'supervision.fatal'
            : 'supervision.restart';
        this.notifications.post({
          kind,
          routing: 'fyi',
          severity: 'error',
          title: `Agent ${agent.agentId}: ${reason}`,
          detail: `Restart ladder engaged (${this.cfg.maxRestarts} restarts allowed per ${Math.round(this.cfg.restartWindowMs / 1000)}s).`,
          agentId: agent.agentId,
        });
      }
      const attempt = agent.restartRing.length + 1;
      this.ledger.appendCustomEvent({
        kind: 'supervision.restart',
        agentId: agent.agentId,
        payload: { reason, attempt, max_restarts: this.cfg.maxRestarts },
      });
      agent.restartRing.push(this.now());

      // Dispose the wedged handle (rejects its pending prompts; the
      // registry set drops it; the tap reports the disposal).
      const old = agent.handle;
      agent.handle = null;
      agent.openTurn = false;
      agent.openControl = false;
      if (old !== null) {
        try {
          await this.registry.disposeHandle(old);
        } catch (error) {
          this.log('warn', 'dispose during restart failed — continuing', {
            agent_id: agent.agentId,
            error: String(error),
          });
        }
      }

      if (restartSlot !== null && restartSlot.generation !== restartGeneration) return;

      // Respawn with resume (crash = resume, SPEC ruling 3).
      const resumeFile = agent.sessionFile;
      try {
        const spawned =
          restartSlot !== null
            ? await restartSlot.spawn(resumeFile !== null ? { resumeFile } : {})
            : await this.registry.spawn(agent.role, resumeFile !== null ? { resumeFile } : {});
        if (
          this.disposed ||
          (restartSlot !== null &&
            (this.slots.get(restartSlot.id) !== restartSlot ||
              restartSlot.generation !== restartGeneration))
        ) {
          // Shutdown, release, or an intentional fresh replacement won while
          // this restart was in flight. Dispose the stale result and never
          // adopt it or notify swap listeners.
          await this.registry.disposeHandle(spawned).catch(() => {});
          return;
        }
        this.adopt(spawned, restartSlot, resumeFile);
        // A resumed session keeps its id; a fresh mint does NOT — the
        // supervision history (ring, breaker, slot binding) follows the
        // supervised ENTITY, never the session id.
        agent = this.carryOverSupervision(agent, spawned.id);
        agent.consecutiveFailures = 0;
        agent.state = 'watching';
        this.log('info', 'agent restarted', {
          agent_id: agent.agentId,
          reason,
          attempt,
          resumed: resumeFile !== null,
        });
        for (const listener of restartSlot?.swapListeners ?? []) {
          try {
            listener(spawned);
          } catch (error) {
            this.log('error', 'slot swap listener failed', { error: String(error) });
          }
        }
      } catch (error) {
        if (restartSlot !== null && restartSlot.generation !== restartGeneration) return;
        // Failed rung: count it, back off, schedule the next.
        agent.consecutiveFailures += 1;
        this.log('error', 'restart rung failed', {
          agent_id: agent.agentId,
          attempt,
          consecutive_failures: agent.consecutiveFailures,
          error: String(error),
        });
        const delay = Math.min(
          this.cfg.restartBackoffMs * 2 ** (agent.consecutiveFailures - 1),
          60_000,
        );
        agent.state = 'watching'; // eligible for the scheduled rung
        agent.backoffTimer = setTimeout(() => {
          agent.backoffTimer = null;
          if (!this.disposed && !agent.breakerOpen) {
            agent.inRestart = false;
            void this.restartRung(agent, reason);
          }
        }, delay);
        agent.backoffTimer.unref?.();
        return;
      }
    } finally {
      // (the outer restartRung owns inRestart/state settlement)
    }
  }

  /**
   * Merge supervision bookkeeping onto the (possibly new-id) adopted
   * record after a restart, retiring the old one. Returns the live record.
   */
  private carryOverSupervision(old: SupervisedAgent, newId: string): SupervisedAgent {
    const adopted = this.agents.get(newId);
    if (adopted === undefined || adopted === old) return old;
    adopted.slot = old.slot;
    adopted.slotGeneration = old.slotGeneration;
    adopted.restartRing = old.restartRing;
    adopted.breakerOpen = old.breakerOpen;
    adopted.breakerNotificationId = old.breakerNotificationId;
    this.agents.delete(old.agentId);
    return adopted;
  }

  /** Trip the crash-loop breaker: stop the agent, escalate, mark. */
  private tripBreaker(agent: SupervisedAgent): void {
    if (agent.breakerOpen) return; // idempotent — one escalation per trip
    agent.breakerOpen = true;
    agent.state = 'stopped';
    const handle = agent.handle;
    agent.handle = null;
    this.ledger.appendCustomEvent({
      kind: 'supervision.breaker',
      agentId: agent.agentId,
      payload: {
        restarts: agent.restartRing.length,
        window_ms: this.cfg.restartWindowMs,
        reason: 'crash loop',
      },
    });
    const notification = this.notifications.post({
      kind: 'supervision.breaker',
      routing: 'action-required',
      severity: 'error',
      title: `Crash-loop breaker tripped: agent ${agent.agentId} stopped`,
      detail:
        `${agent.restartRing.length} restarts within ${Math.round(this.cfg.restartWindowMs / 1000)}s. ` +
        'The agent is STOPPED — ack this notification to re-arm supervision and resume.',
      agentId: agent.agentId,
    });
    agent.breakerNotificationId = notification.id;
    this.log('error', 'crash-loop breaker tripped — agent stopped', {
      agent_id: agent.agentId,
      restarts: agent.restartRing.length,
      notification_id: notification.id,
    });
    // Dispose asynchronously; the stop must not depend on a wedged
    // handle's cooperation.
    if (handle !== null) {
      void this.registry.disposeHandle(handle).catch((error: unknown) => {
        this.log('warn', 'dispose at breaker trip failed', {
          agent_id: agent.agentId,
          error: String(error),
        });
      });
    }
  }

  /**
   * Ack hook: an action-required ack re-arms an OPEN breaker (clears the
   * ring, fresh window, one restart attempt). Acks for anything else —
   * or for a slot deliberately released — are pure records.
   */
  onNotificationAcked(notificationId: string): void {
    if (this.disposed || !this.cfg.enabled) return; // off = acks are pure records
    for (const agent of this.agents.values()) {
      if (agent.breakerNotificationId !== notificationId || !agent.breakerOpen) continue;
      agent.breakerOpen = false;
      agent.breakerNotificationId = null;
      agent.restartRing = [];
      agent.consecutiveFailures = 0;
      agent.state = 'watching';
      this.log('info', 'breaker re-armed by ack — resuming supervision', {
        agent_id: agent.agentId,
        notification_id: notificationId,
      });
      this.ledger.appendCustomEvent({
        kind: 'supervision.rearmed',
        agentId: agent.agentId,
        payload: { notification_id: notificationId },
      });
      void this.restartRung(agent, 'breaker re-armed');
      return;
    }
  }

  // ------------------------------------------------------------------
  // Status + lifecycle
  // ------------------------------------------------------------------

  status(): SupervisionStatus {
    return {
      enabled: this.cfg.enabled,
      turnSilenceMs: this.cfg.turnSilenceMs,
      restartWindowMs: this.cfg.restartWindowMs,
      maxRestarts: this.cfg.maxRestarts,
      agents: [...this.agents.values()].map((agent) => ({
        agentId: agent.agentId,
        role: agent.role,
        slotId: agent.slot?.id ?? null,
        state: agent.state,
        restarts: agent.restartRing.length,
        breakerOpen: agent.breakerOpen,
        openTurn: agent.openTurn,
        lastEventAt:
          agent.lastEventAt > 0 ? new Date(agent.lastEventAt).toISOString() : null,
        lastFileBytes: agent.lastFileBytes,
      })),
    };
  }

  /** Board feed: supervision view for one agent id (or null). */
  viewFor(agentId: string): AgentSupervisionView | null {
    const agent = this.agents.get(agentId);
    if (agent === undefined) return null;
    return {
      agentId: agent.agentId,
      role: agent.role,
      slotId: agent.slot?.id ?? null,
      state: agent.state,
      restarts: agent.restartRing.length,
      breakerOpen: agent.breakerOpen,
      openTurn: agent.openTurn,
      lastEventAt:
        agent.lastEventAt > 0 ? new Date(agent.lastEventAt).toISOString() : null,
      lastFileBytes: agent.lastFileBytes,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ticker !== null) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    this.unsubscribeTap();
    for (const agent of this.agents.values()) {
      if (agent.backoffTimer !== null) clearTimeout(agent.backoffTimer);
    }
    this.agents.clear();
    this.slots.clear();
  }
}

