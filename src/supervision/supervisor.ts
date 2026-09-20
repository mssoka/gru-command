import { statSync } from 'node:fs';
import type { Role, SupervisionConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { AgentHandle, AgentState, SpawnOptions } from '../runtime/types.js';
import type { AgentEventEnvelope } from '../runtime/registry.js';
import type { LedgerApi } from '../ledger/api.js';
import type { NotificationCenter } from '../notifications/center.js';

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
          if (event.fatal) {
            if (!this.cfg.enabled) {
              // Supervision off = pure registry behavior: fatal errors are
              // the runtime's/owner's business — observed, never acted on.
              this.log('info', 'fatal runtime error observed — supervision disabled, no restart', {
                agent_id: agent.agentId,
                error: event.error,
              });
              break;
            }
            this.log('warn', 'fatal runtime error — climbing restart ladder', {
              agent_id: agent.agentId,
              error: event.error,
            });
            void this.restartRung(agent, `fatal error: ${event.error}`);
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
        continue;
      }
      if (bytes !== null) agent.lastFileBytes = bytes;
      const silence = now - agent.lastEventAt;
      if (silence >= this.cfg.turnSilenceMs) {
        const reason = agent.openControl ? 'compaction hang' : 'turn hang';
        this.log('warn', `${reason} detected — climbing restart ladder`, {
          agent_id: agent.agentId,
          silence_ms: silence,
          threshold_ms: this.cfg.turnSilenceMs,
        });
        void this.restartRung(agent, reason);
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
  // Restart ladder + crash-loop breaker
  // ------------------------------------------------------------------

  /** One restart rung. Single-flight per agent: a later trigger while a
   * rung is executing is absorbed (the rung's spawn IS the recovery).
   * Supervision NEVER takes the service down: any internal throw is
   * caught, logged, and the rung settles. */
  private async restartRung(agentRef: SupervisedAgent, reason: string): Promise<void> {
    const agent = agentRef;
    if (this.disposed || !this.cfg.enabled || agent.inRestart || agent.breakerOpen) return;
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

