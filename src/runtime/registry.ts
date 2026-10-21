import { captureCwdHandoff } from '../worktrees/handoff.js';
import { RUNTIME_IDS, resolveSpawnPolicy, type Role, type RuntimeId } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { GrowthReport, SessionStore } from '../sessions/store.js';
import type { LedgerApi } from '../ledger/api.js';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PiRuntime, normalizeSessionPath } from './pi-adapter.js';
import { ClaudeCodeRuntime } from './claude-adapter.js';
import type { ClaudeReviewSnapshot } from './claude-review-settings.js';
import { isStreamingState, withFallbacks } from './fallbacks.js';
import type { AgentHandle, AgentRuntime, ManagedSkillSet, ManagedWorkflowSession, RuntimeEvent, SpawnOptions } from './types.js';
import { adapterCessationEvidence } from './types.js';
import { ROLE_DEFINITIONS } from '../roles.js';
import { createWorkflowSessionBinder } from '../workflows/session.js';
import type { WorktreeLane } from '../dispatch/worktree-port.js';
import { ResidentBudget } from './resident-budget.js';
import type { ResidencySnapshot } from './residency-observations.js';
import { QuarantinedPublicationError, WorkerDisposalInProgressError } from './worker-errors.js';
import { disposePhases, type DisposableTarget } from './disposal.js';
import { publishSpawnRegistration } from './spawn-registration.js';
import { notifyDisposalSettlement } from './disposal-observation.js';
import { processTableAsync, type ProcessTable } from '../worktrees/manager.js';
import {
  pidState, processIdentity, proveReviewHostExit,
  type ReviewHostExitEvidence, type ReviewHostExitInput, type ReviewHostExitResult,
} from './review-host-exit.js';

export { WorkerDisposalInProgressError };

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/** Resolve with the awaited value, or null when the finite settle window
 * expires first (fail-closed signal; the losing promise is left to settle
 * on its own — its late result stays tracked by its owner). */
function withSettleBound<T>(awaited: Promise<T>, settleMs: number, _what: string): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), settleMs);
    void awaited.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

/** What /health reports about the runtime layer (SPEC rulings 5 and 12). */
export interface RuntimeStatus {
  /** Aggregate agent-session state: streaming wins, then idle, else none. */
  readonly agentSession: {
    readonly state: 'streaming' | 'idle' | 'no-session';
    readonly lastActivity: string | null;
  };
  /** Boot-time growth report (null before the store has scanned). */
  readonly sessionGrowth: GrowthReport | null;
  readonly activeSessions: number;
  /** Per-adapter health — a 'down' adapter flips liveness.healthy false. */
  readonly adapters: readonly { readonly id: string; readonly state: string }[];
}

interface ResidentClaim {
  readonly release: () => void;
  state: 'idle' | 'spawning' | 'owned' | 'released';
}

/** pi-adapter-only knobs (test seams) — kept out of the agnostic surface. */
export interface PiKnobs {
  readonly agentDir?: string;
  readonly modelRuntime?: PiRuntimeOptionsModelRuntime;
}

type PiRuntimeOptionsModelRuntime = ConstructorParameters<typeof PiRuntime>[0]['modelRuntime'];

/** claude-code-adapter-only knobs (test seams). */
export interface ClaudeKnobs {
  readonly binary?: string;
  readonly killGraceMs?: number;
  readonly reviewSettingsFile?: string;
}

export function validReviewOwnerGeneration(value: unknown): value is string {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

export interface ReviewOwnerMarker {
  readonly roundId: string;
  readonly runtimeId: string;
  readonly pid: number;
  readonly generation: string;
  /** The host process's start identity when it wrote the marker (#464): a
   * live pid with another identity is a reused pid, or this service
   * restarted under it. Absent on markers written before it existed. */
  readonly hostIdentity?: string;
}

function validReviewOwnerMarker(marker: ReviewOwnerMarker | null): marker is ReviewOwnerMarker {
  return marker !== null && Number.isSafeInteger(marker.pid) && marker.pid > 0 &&
    validReviewOwnerGeneration(marker.generation) && marker.roundId.trim() !== '';
}

/** Durable review-owner cessation (#464). The registry owns no ledger; the
 * host binds this to it, so a restarted service keeps what the owning
 * process proved. */
export interface ReviewOwnerCessationLedger {
  /** The owning process saw its adapter report this review session ceased. */
  readonly recordAdapterCessation: (observation: { readonly agentId: string; readonly generation: string }) => void;
  /** A later process proved the marker's host and every session gone. */
  readonly recordHostExit: (marker: ReviewOwnerMarker, evidence: ReviewHostExitEvidence) => void;
  /** Whether a durable record proves `agentId` ('' = the owner before any
   * session registered) ceased under exactly this marker. */
  readonly recorded: (agentId: string, marker: ReviewOwnerMarker) => boolean;
}

/** {@link ReviewOwnerCessationLedger} bound to the ledger, read lazily:
 * the service opens its ledger after the registry. */
export function ledgerReviewOwnerCessation(
  ledger: () => Pick<LedgerApi, 'recordReviewOwnerCessation' | 'reviewOwnerCessationRecorded'>,
): ReviewOwnerCessationLedger {
  return {
    recordAdapterCessation: ({ agentId, generation }) => {
      ledger().recordReviewOwnerCessation({ source: 'adapter', agentId, generation });
    },
    recordHostExit: (marker, evidence) => {
      ledger().recordReviewOwnerCessation({ source: 'host-exit', roundId: marker.roundId, generation: marker.generation,
        pid: marker.pid, hostIdentity: marker.hostIdentity ?? null, evidence: { ...evidence } });
    },
    recorded: (agentId, marker) => ledger().reviewOwnerCessationRecorded(agentId, marker),
  };
}

export interface RuntimeRegistryOptions {
  readonly config: Parameters<typeof resolveSpawnPolicy>[0];
  readonly store: SessionStore;
  readonly log?: Log;
  /** pi adapter overrides (agentDir / model runtime — test seams). */
  readonly pi?: PiKnobs;
  /** claude-code adapter overrides (binary path / kill grace — test seams). */
  readonly claude?: ClaudeKnobs;
  /** Test/ops quiescence probe: the supervisor's open turn/tool/control truth. */
  readonly canReclaim?: (agentId: string) => boolean;
  /** Review-reservation close settle window (default 30s, named
   * CLOSE_SETTLE_MS). Expiration fails closed and retains capacity. */
  readonly closeSettleMs?: number;
  /** OS probe override for deterministic death/live/unknown tests only; the
   * dead-host proof also asks it about session-lock holders. */
  readonly ownerProcessProbe?: (pid: number) => 'dead' | 'alive' | 'unknown';
  /** Durable review-owner cessation (#464); without it a restart keeps no
   * cessation proof and no dead-host proof can be recorded. */
  readonly reviewOwnerCessation?: ReviewOwnerCessationLedger;
  /** Process-table override for the dead-host proof (tests only). */
  readonly processTable?: () => Promise<ProcessTable>;
  /** Process start-identity override for the dead-host proof (tests only). */
  readonly processIdentity?: (pid: number) => Promise<string | null>;
  /** Durable relay for reclaim-failure observations (one per handle per
   * drain epoch). The registry owns no ledger; the host wires this. */
  readonly reclaimFailureSink?: (observation: {
    readonly agentId: string;
    readonly generation: number;
    readonly attempt: number;
    readonly error: string;
  }) => void;
  /**
   * Issue #283: bind a session cwd (the job lane) to the GC-managed BMAD
   * runtime. Called for every non-review spawn of a role that runs BMAD
   * build workflows; a failure fails the spawn loudly. The host wires the
   * real binder; omitted = no managed runtime (unit tests).
   */
  readonly bmadRuntime?: (cwd: string) => ManagedSkillSet;
  /** Production GC-owned selection with an explicit registered assignment. */
  readonly workflowRuntime?: (options: SpawnOptions) => ManagedWorkflowSession;
}

/** New jobs use GC-owned resources; retained historical bindings keep their bytes.
 * The caller supplies ledger/registry authority, never a directory-name guess. */
export function serviceRegistryOptions(
  base: Pick<RuntimeRegistryOptions, 'config' | 'store' | 'log'> & {
    /** Required (#464): a service registry without it loses review-owner
     * cessation on every restart. */
    readonly reviewOwnerCessation: ReviewOwnerCessationLedger;
    readonly config: { readonly dataDir: string };
    readonly workflowLaneFor: (options: SpawnOptions) => WorktreeLane | null;
    readonly workflowBuildFor?: (lane: WorktreeLane) => boolean;
    readonly workflowAgentFor?: (options: SpawnOptions) => string | undefined;
    /** Loaded instance config path for the verification helper next action. */
    readonly verificationConfigFile?: string;
  },
): RuntimeRegistryOptions {
  const { workflowLaneFor, workflowBuildFor, workflowAgentFor, verificationConfigFile, ...options } = base;
  return { ...options, workflowRuntime: createWorkflowSessionBinder(base.config.dataDir, workflowLaneFor, undefined, workflowBuildFor, workflowAgentFor, verificationConfigFile) };
}

/**
 * A runtime event forwarded through the registry tap (E6): `event` is the
 * adapter event verbatim; `phase` wraps spawn/dispose boundaries the raw
 * event stream does not carry. sessionFile is the handle's declared path
 * at tap time (null before the file exists).
 */
export interface AgentEventEnvelope {
  /** In-process provenance only; never persisted or serialized as event data. */
  readonly handle?: AgentHandle;
  readonly agentId: string;
  readonly role: Role;
  readonly sessionFile: string | null;
  readonly phase: 'spawned' | 'event' | 'disposed';
  readonly event?: RuntimeEvent;
}

export type AgentEventListener = (envelope: AgentEventEnvelope) => void;

/** Finite settle bound for closing a review reservation: pending spawns and
 * handle disposals must settle within this window or the close fails CLOSED
 * (capacity retained as truthful cleanup debt; never released while a spawn
 * or handle may still be alive/unknown). Injectable for tests; this is a
 * lifecycle bound, not a model/test timeout. */
const CLOSE_SETTLE_MS = 30_000;

/** Core roles that never consume resident-worker capacity: the resident
 * budget bounds worker sessions only (docs/FLOW.md §4d). One declared set,
 * beside the budget it feeds — a role added here is exempt by name, never
 * by an inline list scattered at the enforcement site. */
const RESIDENT_EXEMPT_ROLES: ReadonlySet<Role> = new Set(['gru', 'silas', 'bob']);

/** A round owns two permits atomically (lead + first child). Optional child
 * permits are taken only when spare capacity exists and no older request is
 * waiting; a tool batch releases them after its last child settles. */
export interface ResidentReviewRound {
  spawn(options: SpawnOptions): Promise<AgentHandle>;
  beginChildren(maxChildren: number): { readonly concurrency: number; finish(): void };
  close(): Promise<void>;
  /** Bounded idempotent re-check of unproven-cessation debt (no timers). */
  reconcileCleanup(): void;
  /** Agent ids still counted as live cleanup debt. */
  cleanupDebt(): readonly string[];
}

/**
 * Runtime registry (EPICS E2 story 4/5; lands E1-deferred N4): resolves
 * which adapter hosts a role from config (default + per-role overrides),
 * creates adapters lazily, applies interface-layer fallbacks, and tracks
 * live handles for /health liveness.
 */
export class RuntimeRegistry {
  private readonly adapters = new Map<RuntimeId, AgentRuntime>();
  private readonly nativeAdapters = new Map<RuntimeId, PiRuntime | ClaudeCodeRuntime>();
  private readonly handles = new Set<AgentHandle>();
  private readonly unpublished = new Set<AgentHandle>();
  private readonly quarantined = new Set<AgentHandle>();
  /** Per unpublished handle: its held-frame count, and the refusal a
   * quarantine applies to its publication (#352). */
  private readonly publications = new Map<AgentHandle, { readonly held: () => number; readonly refuse: () => void }>();
  private readonly ceasedReviewOwners = new Map<string, string>();

  /** Pi isolated review tools and host-native callbacks run inside this
   * hosting process; an OS-proven dead host cannot issue another write.
   * Claude can leave an independently running child, so PID death is NEVER
   * cessation proof for Claude. A live/reused/unknown PID blocks unless
   * adapter-owned cessation for this generation was observed: by this
   * process, or durably by the owning one (#464), whose record also holds
   * a dead-host proof a later process kept ({@link proveReviewHostExit}). */
  reviewOwnerCeased(agentId: string, marker: ReviewOwnerMarker | null): boolean {
    if (!validReviewOwnerMarker(marker)) return false;
    if (marker.pid === process.pid && this.ceasedReviewOwners.get(agentId) === marker.generation) return true;
    if (this.durablyCeased(agentId, marker)) return true;
    if (marker.pid === process.pid || marker.runtimeId !== 'pi') return false;
    try {
      if (this.opts.ownerProcessProbe !== undefined) return this.opts.ownerProcessProbe(marker.pid) === 'dead';
      process.kill(marker.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  private durablyCeased(agentId: string, marker: ReviewOwnerMarker): boolean {
    try {
      return this.opts.reviewOwnerCessation?.recorded(agentId, marker) === true;
    } catch (error) {
      this.log('error', 'durable review-owner cessation is unreadable; ownership stays unproven', {
        round: marker.roundId, agent: agentId, error: String(error),
      });
      return false;
    }
  }

  /** The dead-host proof (#464) for a review owner hosted by ANOTHER
   * process that left no durable cessation record. A passing proof is
   * recorded before it is reported, so the next reconciliation reads the
   * record instead of re-deciding; one that cannot be recorded refuses. */
  async proveReviewHostExit(input: ReviewHostExitInput): Promise<ReviewHostExitResult> {
    const { marker } = input;
    if (!validReviewOwnerMarker(marker)) return { ok: false, problem: 'its owner marker is malformed' };
    const ledger = this.opts.reviewOwnerCessation;
    if (ledger === undefined) return { ok: false, problem: 'no durable cessation record is wired to keep a dead-host proof' };
    const result = await proveReviewHostExit(input, {
      pidState: this.opts.ownerProcessProbe ?? pidState,
      processIdentity: this.opts.processIdentity ?? processIdentity,
      processTable: this.opts.processTable ?? (() => processTableAsync({
        onCwdError: (error) => this.log('warn', 'dead-host proof could not list process working directories', { error: String(error) }),
      })),
      // Review owners are Perkins sessions rooted at the review worktree.
      sessionDir: (cwd) => this.opts.store.sessionDirFor('perkins', cwd),
      lockFileFor: (sessionFile) => this.opts.store.lockFileFor(sessionFile),
      heldHere: (sessionFile) => this.opts.store.isHeld(sessionFile),
    });
    if (!result.ok) return result;
    try {
      ledger.recordHostExit(marker, result.evidence);
    } catch (error) {
      return { ok: false, problem: `the dead-host proof passed but could not be recorded (${String(error)})` };
    }
    this.log('info', 'review owner proven gone by dead-host proof', {
      round: marker.roundId, pid: marker.pid, runtime: marker.runtimeId, host: result.evidence.host,
      sessions: result.evidence.sessionIds.length,
    });
    return result;
  }
  private readonly agentListeners = new Set<AgentEventListener>();
  private readonly opts: RuntimeRegistryOptions;
  private readonly log: Log;
  private growth: GrowthReport | null = null;
  readonly residents: ResidentBudget;
  private reclaimProbe: (agentId: string) => boolean;
  /** Rounds with unresolved cleanup debt register a reconcile observer;
   * EXISTING handle 'disposed' events drive it (no watcher/timer). */
  private readonly cleanupObservers = new Set<() => void>();
  /** Actual shared-permit release notifications (not the pre-release
   * disposed envelope): a capacity consumer must learn that the permit
   * was PROVEN released so it can re-register demand even after a wake
   * refusal (Perkins r3 blocker 4). */
  private readonly residentReleaseListeners = new Set<() => void>();
  private readonly residentClaims = new WeakMap<() => void, ResidentClaim>();

  constructor(opts: RuntimeRegistryOptions) {
    this.opts = opts;
    this.log = opts.log ?? (() => {});
    this.residents = new ResidentBudget(opts.config.concurrency.maxWorkers);
    this.residents.onReclaimFailure = opts.reclaimFailureSink;
    this.reclaimProbe = opts.canReclaim ?? (() => false);
  }

  /** Read-only residency observations for external observers. This is a
   * snapshot of existing runtime facts only — it is not an admission
   * record and grants no fan-out permission. */
  residencySnapshot(): ResidencySnapshot {
    return {
      capacity: this.residents.capacity,
      occupied: this.residents.occupied,
      queued: this.residents.queued,
      reclaimFailures: this.residents.reclaimFailureCount,
      handles: [...this.handles].map((handle) => {
        let state = 'unknown';
        try { state = handle.health().state ?? 'unknown'; } catch { /* retain unknown resident truth */ }
        return {
          agentId: handle.id, role: handle.role,
          sessionFile: handle.sessionFile ?? null, state,
          heldEvents: this.publications.get(handle)?.held() ?? 0,
        };
      }),
    };
  }

  /** Installed after the supervisor is wired; no reclaim is allowed before it. */
  setReclaimProbe(probe: (agentId: string) => boolean): void { this.reclaimProbe = probe; }

  /** Boot sequence: growth detection first (SPEC ruling 12), then backups. */
  boot(): GrowthReport {
    this.growth = this.opts.store.detectGrowth();
    for (const finding of this.growth.findings) {
      this.log('warn', 'session jsonl changed while service was down', {
        file: finding.file,
        kind: finding.kind,
        byte_delta: finding.grewByBytes,
        previous_bytes: finding.previousBytes,
        current_bytes: finding.currentBytes,
      });
    }
    this.opts.store.runBackup();
    this.opts.store.startHourlyBackup();
    return this.growth;
  }

  runtimeIdFor(role: Role): RuntimeId {
    return this.opts.config.runtimes.roles[role] ?? this.opts.config.runtimes.default;
  }

  /** Subscribe to every spawned handle's events (E6 board feed). Additive. */
  onAgentEvent(listener: AgentEventListener): () => void {
    this.agentListeners.add(listener);
    return () => {
      this.agentListeners.delete(listener);
    };
  }

  /** Subscribe to ACTUAL resident-permit releases (after the release has
   * been applied and proven). Additive; listener failures are contained. */
  onResidentReleased(listener: () => void): () => void {
    this.residentReleaseListeners.add(listener);
    return () => {
      this.residentReleaseListeners.delete(listener);
    };
  }

  private emitAgentEvent(envelope: AgentEventEnvelope): void {
    for (const listener of this.agentListeners) {
      try {
        listener(envelope);
      } catch (error) {
        this.log('error', 'agent event listener failed', { error: String(error) });
      }
    }
  }

  /** A request-owned review model proof; no adapter stores it by role. */
  async prepareReviewModel(role: Role): Promise<ClaudeReviewSnapshot | undefined> {
    const id = this.runtimeIdFor(role);
    this.runtimeFor(id);
    const native = this.nativeAdapters.get(id)!;
    if (native instanceof ClaudeCodeRuntime) return native.prepareReviewModel(role);
    return native.prepareReviewModel(role);
  }

  async checkReviewModel(role: Role): Promise<void> {
    await this.prepareReviewModel(role);
  }

  reviewThinkingLevel(role: Role): string {
    const id = this.runtimeIdFor(role);
    return applyThinkingFallback(this.runtimeFor(id), resolveSpawnPolicy(this.opts.config, id, role).thinkingLevel, this.log);
  }

  /** The fallback-wrapped adapter for a runtime id (created on first use). */
  runtimeFor(id: RuntimeId): AgentRuntime {
    if (!(RUNTIME_IDS as readonly string[]).includes(id)) {
      throw new Error(`unknown runtime "${id}" (valid runtimes: ${RUNTIME_IDS.join(', ')})`);
    }
    let adapter = this.adapters.get(id);
    if (adapter === undefined) {
      if (id === 'pi') {
        const native = new PiRuntime({
          config: this.opts.config,
          store: this.opts.store,
          ...(this.opts.pi?.agentDir !== undefined ? { agentDir: this.opts.pi.agentDir } : {}),
          ...(this.opts.pi?.modelRuntime !== undefined ? { modelRuntime: this.opts.pi.modelRuntime } : {}),
          ...(this.opts.log !== undefined ? { log: this.opts.log } : {}),
        });
        this.nativeAdapters.set(id, native);
        adapter = withFallbacks(native);
      } else {
        // E3: the claude-code adapter hosts sessions on the headless CLI;
        // steer-unable, so the interface fallback wrapper serializes it.
        const native = new ClaudeCodeRuntime({
          config: this.opts.config,
          store: this.opts.store,
          ...(this.opts.claude?.binary !== undefined ? { binary: this.opts.claude.binary } : {}),
          ...(this.opts.claude?.killGraceMs !== undefined ? { killGraceMs: this.opts.claude.killGraceMs } : {}),
          ...(this.opts.claude?.reviewSettingsFile !== undefined ? { reviewSettingsFile: this.opts.claude.reviewSettingsFile } : {}),
          ...(this.opts.log !== undefined ? { log: this.opts.log } : {}),
        });
        this.nativeAdapters.set(id, native);
        adapter = withFallbacks(native);
      }
      this.adapters.set(id, adapter);
    }
    return adapter;
  }

  async spawn(role: Role, options: SpawnOptions = {}): Promise<AgentHandle> {
    const assertHandoff = captureCwdHandoff(options.cwd);
    const release = RESIDENT_EXEMPT_ROLES.has(role)
      ? null : await this.residents.acquire(1, options.signal);
    let owned = false;
    try {
      assertHandoff();
      return await this.spawnReserved(role, options, release, () => { owned = true; }, assertHandoff);
    } catch (error) {
      if (!owned) release?.();
      throw error;
    }
  }

  /** Issue #161: reserve one resident worker permit up front (the same
   * FIFO pool `spawn` charges), then spawn against THAT permit — a child
   * admission can no longer race a probe's free-seat observation. */
  async reserveResident(signal?: AbortSignal): Promise<() => void> {
    const raw = await this.residents.acquire(1, signal);
    const claim: ResidentClaim = { release: raw, state: 'idle' };
    const release = (): void => {
      if (claim.state !== 'idle') return; // in-flight or transferred: only owned settlement may release
      claim.state = 'released'; raw();
    };
    this.residentClaims.set(release, claim);
    return release;
  }

  /** Spawn a session on an already-held resident permit (never charges a
   * second one). Pre-resident failure releases it; owned failures retain proof-aware custody. */
  async spawnWithResident(
    role: Role,
    options: SpawnOptions,
    release: () => void,
  ): Promise<AgentHandle> {
    const claim = this.residentClaims.get(release);
    if (claim === undefined) throw new Error('resident reservation is not owned by this registry');
    if (claim.state !== 'idle') throw new Error('resident reservation is already claimed or released');
    claim.state = 'spawning';
    try {
      const assertHandoff = captureCwdHandoff(options.cwd);
      return await this.spawnReserved(role, options, claim.release, () => { claim.state = 'owned'; }, assertHandoff);
    } catch (error) {
      if (claim.state === 'spawning') { claim.state = 'released'; claim.release(); }
      throw error;
    }
  }

  async reserveReviewRound(signal?: AbortSignal): Promise<ResidentReviewRound> {
    // Finite positive validation BEFORE acquiring any capacity.
    if (this.opts.closeSettleMs !== undefined &&
      (!Number.isSafeInteger(this.opts.closeSettleMs) || this.opts.closeSettleMs <= 0)) {
      throw new Error(`closeSettleMs must be a positive safe integer, got ${String(this.opts.closeSettleMs)}`);
    }
    const closeSettleMs = this.opts.closeSettleMs ?? CLOSE_SETTLE_MS;
    const releasePair = await this.residents.acquire(2, signal);
    // ---- ONE ownership model (phase 6; see phase invariants.md) ----
    const spawnPromises = new Set<Promise<AgentHandle>>();
    const pairMembers = new Set<AgentHandle>();   // lead + first child (resolved)
    const extraMembers = new Set<AgentHandle>();  // extra-permit children (resolved)
    let pairPending = 0;                          // in-flight pair-slot spawns
    const unconsumedExtras: Array<() => void> = [];
    const proofOutcomes = new Map<string, 'proved' | 'debt'>(); // agentId -> state
    const disposalFailures: Array<{ agentId: string; reason: string }> = [];
    let leading = false;
    let childRunning = false;
    let closed = false;
    let pairReleased = false;
    let closePromise: Promise<void> | null = null;

    /** Credential-safe reason code for an arbitrary thrown value. */
    const reasonCode = (error: unknown): string =>
      /token|secret|password|api[_-]?key|authorization|bearer|basic\s/iu.test(String(error))
        ? 'credential-shaped'
        : 'rejected';
    /** Adapter-owned cessation proof (Option A, F60-P1): ONLY the adapter's
     * own 'ceased' evidence proves a member stopped. Terminal health, dispose
     * fulfillment/rejection settlement, lock release and native retirement are
     * never proof; a missing/throwing/UNKNOWN answer leaves the member debt. */
    const isProvenCeased = (handle: AgentHandle): boolean =>
      adapterCessationEvidence(handle) === 'ceased';
    const everyMemberProven = (): boolean =>
      [...pairMembers].every((handle) => proofOutcomes.get(handle.id) === 'proved');
    /** THE single release edge for the pair: closed, no in-flight pair
     * spawns, every pair member positively proven. Exactly once. */
    const releasePairIfProven = (): void => {
      if (pairReleased || !closed || pairPending > 0 || !everyMemberProven()) return;
      pairReleased = true;
      for (const extra of unconsumedExtras.splice(0)) extra();
      releasePair();
      this.cleanupObservers.delete(reconcile);
    };
    const prove = (agentId: string): void => {
      proofOutcomes.set(agentId, 'proved');
      releasePairIfProven();
    };
    const markDebt = (agentId: string): void => {
      proofOutcomes.set(agentId, 'debt');
    };
    /** Owned disposal of ONE member: contained on every path; settlement
     * alone is never cessation — only the adapter's own evidence proves it. */
    const ownedDispose = async (handle: AgentHandle): Promise<void> => {
      try {
        await handle.dispose();
      } catch (error) {
        // Contained: attributed, but a rejected (or fulfilled) disposal is
        // never proof. The member stays counted debt unless the adapter
        // attests 'ceased' below.
        disposalFailures.push({ agentId: handle.id, reason: reasonCode(error) });
      }
      if (isProvenCeased(handle)) {
        prove(handle.id);
      } else {
        markDebt(handle.id);
      }
    };
    /** Bounded, idempotent reconciliation (adapter evidence only) — the debt
     * path's production consumer is the registry 'disposed'-event traversal
     * (no watcher/timer). */
    const reconcile = (): void => {
      for (const handle of [...pairMembers]) {
        if (proofOutcomes.get(handle.id) === 'debt' && isProvenCeased(handle)) prove(handle.id);
      }
      releasePairIfProven();
    };
    this.cleanupObservers.add(reconcile);

    const spawn = async (options: SpawnOptions): Promise<AgentHandle> => {
      if (closed) throw new Error('review reservation is closed');
      const assertHandoff = captureCwdHandoff(options.cwd);
      const lead = options.reviewLead !== undefined;
      if (lead && leading) throw new Error('review reservation already has a lead');
      if (lead) leading = true;
      let release: (() => void) | null = null;
      if (!lead) {
        if (!childRunning) childRunning = true;
        else {
          release = unconsumedExtras.shift() ?? null;
          if (release === null) throw new Error('review child exceeded admitted parallelism');
        }
      }
      const spare = release;
      const isPairSlot = spare === null;
      if (isPairSlot) pairPending += 1;
      const ownership: { handle: AgentHandle | null } = { handle: null };
      const operation = this.spawnReserved('perkins', options, spare, (handle) => {
        ownership.handle = handle;
        (isPairSlot ? pairMembers : extraMembers).add(handle);
        handle.subscribe((event) => {
          if (event.type === 'state' && event.state === 'disposed') {
            if (isProvenCeased(handle)) {
              prove(handle.id);
              if (!lead && isPairSlot) childRunning = false;
            }
            if (closed) reconcile();
          }
        });
      }, assertHandoff);
      spawnPromises.add(operation);
      // Track in-flight settlements for close. The derived chain MUST swallow
      // its rejection: the failed spawn is already owned by the awaiting
      // caller (which rethrows to the review engine) and by the
      // late-settlement observer below — an unobserved derivative would exit
      // the service through the process-level unhandledRejection handler.
      void operation.finally(() => { spawnPromises.delete(operation); }).catch(() => {});
      // Owned late-settlement observer (attached at spawn time): post-close
      // resolution enters owned disposal; rejection without an owned resident is
      // no-admission; post-adapter refusal retains its tracked member.
      void operation.then(
        (handle) => {
          (isPairSlot ? pairMembers : extraMembers).add(handle);
          if (closed) void ownedDispose(handle).then(() => releasePairIfProven(), () => {});
        },
        () => {
          // Actual post-adapter residents were tracked before rejection.
          // Only a genuine no-resident failure is positive unused capacity.
          if (closed) releasePairIfProven();
        },
      );
      try {
        const handle = await operation;
        (isPairSlot ? pairMembers : extraMembers).add(handle);
        return handle;
      } catch (error) {
        if (ownership.handle === null) {
          if (lead) leading = false;
          else if (isPairSlot) childRunning = false;
          spare?.(); // genuine pre-adapter/no-resident failure only
        } else if (isProvenCeased(ownership.handle)) {
          prove(ownership.handle.id);
          if (lead) leading = false;
          else if (isPairSlot) childRunning = false;
        } else markDebt(ownership.handle.id);
        throw error;
      } finally {
        // In-flight ends on BOTH paths: success promotes to membership
        // (proof pending); owned rejections retain membership/debt.
        if (isPairSlot) pairPending -= 1;
        if (closed) releasePairIfProven();
      }
    };
    const debtIds = (): string[] => [...pairMembers, ...extraMembers]
      .filter((handle) => proofOutcomes.get(handle.id) !== 'proved' &&
        (closed || proofOutcomes.get(handle.id) === 'debt'))
      .map((handle) => handle.id);
    return {
      spawn,
      beginChildren: (maxChildren) => {
        if (closed || unconsumedExtras.length > 0 || childRunning) throw new Error('review child batch overlaps an active batch');
        for (let i = 1; i < maxChildren; i += 1) {
          const extra = this.residents.tryAcquire();
          if (extra === null) break;
          unconsumedExtras.push(extra);
        }
        const concurrency = 1 + unconsumedExtras.length;
        return {
          concurrency,
          finish: () => { for (const extra of unconsumedExtras.splice(0)) extra(); },
        };
      },
      reconcileCleanup: reconcile,
      cleanupDebt: (): readonly string[] => debtIds(),
      close: () => {
        if (closePromise !== null) return closePromise;
        closed = true;
        closePromise = (async () => {
          // Whole owned operation: ALL pending spawns, then owned disposal
          // of EVERY member (pair AND extras), under ONE finite bound. op
          // RESOLVES {error?} — rejection stays distinct from the deadline.
          const op = (async (): Promise<{ error?: unknown }> => {
            await Promise.allSettled([...spawnPromises]);
            const disposals: Array<Promise<void>> = [];
            for (const handle of [...pairMembers, ...extraMembers]) disposals.push(ownedDispose(handle));
            await Promise.all(disposals); // owned disposals AWAITED, contained
            releasePairIfProven();
            const debt = debtIds();
            if (debt.length > 0) {
              return { error: new Error(`review reservation closed with owned capacity not proven ceased (${debt.join(', ')}); retained as cleanup debt (reconcile via round.reconcileCleanup())`) };
            }
            if (disposalFailures.length > 0) return { error: new AggregateError(disposalFailures.map((entry) => new Error(`${entry.agentId}:${entry.reason}`)), 'review reservation disposal failed') };
            return {};
          })();
          const bounded = await withSettleBound(op, closeSettleMs, 'close');
          if (bounded === null) {
            // Deadline expiry (distinct from rejection): observers continue
            // proof accounting; capacity stays held as visible debt.
            void op.then(
              (outcome) => { if (outcome.error !== undefined) this.log('error', 'late close completion after deadline', { error: String(outcome.error) }); },
              (error: unknown) => { this.log('error', 'late close rejection after deadline', { error: reasonCode(error) }); },
            );
            throw new Error('review reservation close settle window exceeded: capacity retained as owned cleanup debt; reconcile via round.reconcileCleanup()');
          }
          if (bounded.error !== undefined) throw bounded.error;
        })();
        return closePromise;
      },
    };
  }

  /** Issue #283: the lane-bound BMAD runtime for a build-workflow role. */
  private managedSkillsFor(role: Role, options: SpawnOptions): ManagedSkillSet | undefined {
    if (options.managedSkills !== undefined) return options.managedSkills;
    if (!ROLE_DEFINITIONS[role].managedBmadRuntime || this.opts.bmadRuntime === undefined) return undefined;
    if ((options.reviewLead ?? options.isolatedReview) !== undefined) return undefined;
    if (options.cwd === undefined || options.cwd === '') {
      // No project cwd (for example a crash restart whose job lane is gone):
      // there is no lane to bind. Keep the spawn working, visibly without
      // the managed runtime.
      this.log('warn', 'bmad runtime not bound: spawn has no project cwd', {
        role,
        resume_file: options.resumeFile ?? null,
      });
      return undefined;
    }
    const managed = this.opts.bmadRuntime(options.cwd);
    this.log('info', 'bmad runtime bound', {
      role,
      cwd: options.cwd,
      runtime: managed.runtimeId,
      content_sha256: managed.contentSha256,
      lane_bound: managed.laneBound,
    });
    return managed;
  }

  private async spawnReserved(role: Role, options: SpawnOptions, release: (() => void) | null,
    onOwned?: (handle: AgentHandle) => void, beforeSpawn?: () => void): Promise<AgentHandle> {
    if (options.signal?.aborted) throw new Error('resident admission cancelled before spawn');
    if (options.reviewOwnerGeneration !== undefined &&
      ((options.reviewLead ?? options.isolatedReview) === undefined || !validReviewOwnerGeneration(options.reviewOwnerGeneration))) {
      throw new Error('review ownership generation requires an isolated review with a valid generation');
    }
    if (options.reviewModel !== undefined && this.runtimeIdFor(role) === 'pi' &&
      (options.reviewLead ?? options.isolatedReview) === undefined) {
      throw new Error('Pi review model snapshot requires an isolated review lead or lens');
    }
    const adapter = this.runtimeFor(this.runtimeIdFor(role));
    // SPEC ruling 16: resolve the model & thinking policy from config
    // (most specific wins) with spawn options overriding, "default"
    // passing straight through to the runtime harness.
    const policy = resolveSpawnPolicy(
      this.opts.config,
      this.runtimeIdFor(role),
      role,
      options.model !== undefined || options.thinkingLevel !== undefined
        ? {
            ...(options.model !== undefined ? { model: options.model } : {}),
            ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
          }
        : {},
    );
    if (policy.passedOver !== undefined) {
      // Claude Code is always Anthropic: shared-tier pi references never reach
      // its CLI. Logged where production resolves the policy (never silent).
      this.log('info', 'claude-code passed over pi references in shared [models]/[thinking] tiers', {
        role,
        passed_over: policy.passedOver.map(({ tier, ref }) => `${tier} = ${ref}`),
        model: policy.model,
        thinking_level: policy.thinkingLevel,
      });
    }
    const thinkingLevel = applyThinkingFallback(adapter, policy.thinkingLevel, this.log);
    // Assignment lookup must see the same canonical URI/tilde path that both
    // adapters lock/open, otherwise a legitimate recorded resume looks unowned.
    const workflowOptions = options.resumeFile === undefined ? options
      : { ...options, resumeFile: normalizeSessionPath(options.resumeFile) };
    const workflowSession = this.opts.workflowRuntime !== undefined && ROLE_DEFINITIONS[role].managedBmadRuntime &&
      (options.reviewLead ?? options.isolatedReview) === undefined
      ? this.opts.workflowRuntime(workflowOptions) : undefined;
    const managedSkills = workflowSession !== undefined ? workflowSession.managedSkills : this.managedSkillsFor(role, options);
    const cwd = workflowSession?.cwd ?? options.cwd;
    if (managedSkills !== undefined) this.log('info', 'managed workflow bound', {
      role, cwd, runtime: managedSkills.runtimeId, content_sha256: managedSkills.contentSha256,
      artifact_root: managedSkills.workflow?.context.artifactRoot ?? null,
    });
    const assertHandoff = options.cwd === undefined ? captureCwdHandoff(cwd) : beforeSpawn ?? captureCwdHandoff(cwd);
    assertHandoff();
    const handle = await adapter.spawn(role, {
      ...(options.resumeFile !== undefined ? { resumeFile: options.resumeFile } : {}),
      ...(options.directiveRecoveryProducer !== undefined ? { directiveRecoveryProducer: options.directiveRecoveryProducer } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...((workflowSession?.agentId ?? options.agentId) !== undefined ? { agentId: workflowSession?.agentId ?? options.agentId } : {}),
      ...(options.roleTools !== undefined ? { roleTools: options.roleTools } : {}),
      ...((workflowSession?.workerVerification ?? options.workerVerification) !== undefined &&
        (options.reviewLead ?? options.isolatedReview) === undefined
        ? { workerVerification: workflowSession?.workerVerification ?? options.workerVerification } : {}),
      ...(options.isolatedReview !== undefined ? { isolatedReview: options.isolatedReview } : {}),
      ...(options.reviewLead !== undefined ? { reviewLead: options.reviewLead } : {}),
      ...(options.reviewModel !== undefined ? { reviewModel: options.reviewModel } : {}),
      ...(managedSkills !== undefined ? { managedSkills } : {}),
      model: options.reviewModel !== undefined && this.runtimeIdFor(role) === 'pi'
        ? options.reviewModel.modelRef : policy.model,
      thinkingLevel,
    });
    let pending = 0;
    let completedPrompt = false;
    let disposing: Promise<void> | null = null;
    let disposingNow = false;
    let released = false;
    let publicationFailure: { readonly error: unknown } | null = null;
    const releaseHandle = (): void => {
      if (released) return;
      released = true;
      let ceased = false;
      try {
        ceased = options.reviewOwnerGeneration !== undefined && handle.cessationEvidence?.() === 'ceased';
      } catch {
        // Missing or failing adapter evidence remains unknown.
      }
      if (ceased && options.reviewOwnerGeneration !== undefined) {
        this.ceasedReviewOwners.set(handle.id, options.reviewOwnerGeneration);
        // Durable too (#464): a restart must not lose what this owner saw.
        try {
          this.opts.reviewOwnerCessation?.recordAdapterCessation({ agentId: handle.id, generation: options.reviewOwnerGeneration });
        } catch (error) {
          this.log('error', 'review-owner cessation could not be recorded; a restarted service must prove the host gone instead', {
            agent: handle.id, error: String(error),
          });
        }
      }
      this.handles.delete(resident);
      this.unpublished.delete(resident);
      this.quarantined.delete(resident);
      this.publications.delete(resident);
      this.residents.unwatch(resident);
      release?.();
      // AFTER the permit is actually released: notify capacity consumers
      // (the pipeline consumer re-registers demand / admits directly).
      for (const listener of [...this.residentReleaseListeners]) {
        try {
          listener();
        } catch (error) {
          this.log('error', 'resident release listener failed', { error: String(error) });
        }
      }
    };
    const budget = this.residents;
    // One wrapper per tracked method, memoized: handle.prompt ===
    // handle.prompt holds, and no per-access allocation.
    const wrappers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const resident: AgentHandle = new Proxy(handle, {
      get(target, property) {
        if (property === 'dispose') return (): Promise<void> => {
          if (disposing !== null) return disposing;
          disposingNow = true;
          // Cessation proof, not fulfillment (Option A, F60-P1): the permit is
          // released ONLY when the adapter itself attests 'ceased'. Terminal
          // 'disposed' health, a settled or rejected dispose, lock release and
          // native retirement are never proof — missing/throwing/UNKNOWN
          // evidence keeps the slot owned as visible debt, reconciled later by
          // the adapter-evidence event path below if a late positive arrives.
          disposing = Promise.resolve().then(() => target.dispose()).then(
            () => {
              notifyDisposalSettlement(resident, true);
              if (adapterCessationEvidence(target) === 'ceased') releaseHandle();
            },
            (error: unknown) => {
              if (adapterCessationEvidence(target) === 'ceased') releaseHandle();
              disposing = null;
              disposingNow = false;
              notifyDisposalSettlement(resident, false);
              throw error;
            },
          );
          return disposing;
        };
        if (['prompt', 'steer', 'followUp', 'promptWithVerdict', 'compact', 'resumeDirective'].includes(String(property))) {
          if (wrappers.has(String(property))) return wrappers.get(String(property));
          const tracked = String(property);
          const method = Reflect.get(target, property) as ((...args: unknown[]) => Promise<unknown>) | undefined;
          if (method === undefined) {
            // Per-turn evidence is an OPTIONAL capability (r6 architecture):
            // absence means "no attestation", not an adapter defect — callers
            // check for it. Required methods still fail loud.
            if (tracked === 'promptWithVerdict' || tracked === 'resumeDirective') return undefined;
            throw new Error(
              `resident handle was asked for "${String(property)}" but its runtime adapter does not implement it`,
            );
          }
          const wrapper = (...args: unknown[]) => {
            if (disposingNow || released) return Promise.reject(new WorkerDisposalInProgressError());
            if (publicationFailure !== null) return Promise.reject(publicationFailure.error);
            pending += 1;
            budget.changed();
            // Invoke SYNCHRONOUSLY: adapter wrappers (e.g. the claude
            // fallback queue) emit their `queued` events inside the call,
            // and callers observe them immediately after it returns.
            try {
              assertHandoff();
              const operation = method.apply(target, args);
              return Promise.resolve(operation).finally(() => {
                pending -= 1;
                // Only a real prompt delivers the briefing — plain or
                // verdict-carrying: steer/followUp alone must never mark an
                // un-briefed session reclaim-eligible (docs/FLOW.md §4d
                // "as-yet-undelivered first prompt").
                if (tracked === 'prompt' || tracked === 'promptWithVerdict') completedPrompt = true;
                budget.changed();
              });
            } catch (error) {
              pending -= 1;
              budget.changed();
              return Promise.reject(error);
            }
          };
          wrappers.set(tracked, wrapper);
          return wrapper;
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    this.handles.add(resident);
    if (release !== null && role === 'minion') {
      this.residents.watch(resident, () =>
        completedPrompt && pending === 0 && !disposingNow && !released &&
        // Liveness evidence must EXPLICITLY prove absence: probes missing,
        // returning undefined/non-boolean, or THROWING are unknown — never
        // false — and the handle is not reclaimable (docs/FLOW.md §4d).
        (() => {
          try {
            return typeof handle.hasLiveProcess === 'function' && typeof handle.isCompacting === 'function' &&
              handle.hasLiveProcess() === false && handle.isCompacting() === false;
          } catch { return false; }
        })() &&
        this.reclaimProbe(handle.id),
      );
    }
    // An owned recovery result is invisible to dispatch lookups and EVERY
    // tap consumer until its owner grants publication. Capacity/cessation
    // tracking remains live while publication is held, including cleanup.
    this.unpublished.add(resident);
    let published = false;
    let publishing = false;
    const buffered: AgentEventEnvelope[] = [];
    const duringPublication: AgentEventEnvelope[] = [];
    const forward = (envelope: AgentEventEnvelope): void => {
      if (publicationFailure !== null) return;
      if (publishing) duringPublication.push(envelope);
      else if (published) this.emitAgentEvent(envelope);
      else buffered.push(envelope);
    };
    const publish = (): void => {
      if (publicationFailure !== null) throw publicationFailure.error;
      if (published || publishing) return;
      try {
        if (released || !this.handles.has(resident)) throw new WorkerDisposalInProgressError();
        assertHandoff();
        publishing = true;
        published = true;
        this.unpublished.delete(resident);
        this.publications.delete(resident);
        this.emitAgentEvent({ handle: resident, agentId: handle.id, role, sessionFile: handle.sessionFile, phase: 'spawned' });
        assertHandoff();
        // Never forward any pending event until the post-listener custody
        // proof succeeds; then in the order they happened (#353): every frame
        // held before publication, then any frame a `spawned` listener made
        // on this handle, then any frame a listener makes during this drain —
        // still queued, so a reentrant frame never overtakes a held one.
        const queue = [...buffered.splice(0), ...duringPublication.splice(0)];
        while (queue.length > 0) {
          this.emitAgentEvent(queue.shift()!);
          queue.push(...duringPublication.splice(0));
        }
        publishing = false;
      } catch (error) {
        publicationFailure = { error };
        published = false;
        if (this.handles.has(resident)) this.unpublished.add(resident);
        this.publications.delete(resident); // terminal: nothing is held any more
        buffered.length = 0;
        duringPublication.length = 0;
        throw error; // delayed Supervisor retries see the same terminal refusal
      } finally { publishing = false; }
    };
    // A generation its owner rejects before publishing it never publishes:
    // its held frames are released, and later ones are never held (#352).
    // Only the tap copy goes — the handle's own subscribers (the release
    // listener below, cleanup traversal, an owner's disposal and cessation
    // observers) keep receiving every frame. Once publication has begun, or
    // has failed, a quarantine changes nothing here.
    this.publications.set(resident, {
      held: () => buffered.length + duringPublication.length,
      refuse: () => {
        if (published || publishing || publicationFailure !== null) return;
        publicationFailure = { error: new QuarantinedPublicationError(handle.id) };
        buffered.length = 0;
        duringPublication.length = 0;
      },
    });
    // Self-healing membership: a handle disposed by ANY caller leaves the
    // registry set — the status surface must never contradict itself.
    // Registered FIRST (before the emit tap below) so the disposed event
    // releases the resident permit BEFORE any disposed-phase listener
    // runs: a synchronous capacity consumer (the pipeline consumer's
    // reconsider pass) must read the budget AFTER the release, or it can
    // see a full pool, exit, and never receive another trigger.
    handle.subscribe((event) => {
      // Ownership release is adapter-evidence-only (Option A, F60-P1). A
      // disposed state OR a late positive cessation event releases the permit
      // only when the adapter itself attests 'ceased'; metadata never does.
      if (
        (event.type === 'state' && event.state === 'disposed' && !disposingNow) ||
        (event.type === 'cessation_evidence' && event.evidence === 'ceased')
      ) {
        if (adapterCessationEvidence(handle) === 'ceased') releaseHandle();
      }
    });
    handle.subscribe((event) => {
      forward({
        handle: resident,
        agentId: handle.id,
        role,
        sessionFile: handle.sessionFile,
        phase: 'event',
        event,
      });
      if (event.type === 'state' && event.state === 'disposed') {
        forward({ handle: resident, agentId: handle.id, role, sessionFile: handle.sessionFile, phase: 'disposed' });
        // REAL production traversal: the existing handle-event flow drives
        // registered cleanup-debt reconcilers (no watcher/timer). Observer
        // failure is contained; shutdown stops traversal without clearing
        // any round's outstanding debt.
        for (const observer of [...this.cleanupObservers]) {
          try { observer(); } catch { /* contained */ }
        }
      }
      if (event.type === 'state' || event.type === 'turn_start' || event.type === 'turn_end' ||
        event.type === 'tool_start' || event.type === 'tool_end' ||
        event.type === 'compaction_start' || event.type === 'compaction_end') {
        this.residents.changed();
      }
    });
    onOwned?.(resident);
    try {
      assertHandoff();
      publishSpawnRegistration(options, resident, publish);
      assertHandoff();
    } catch (error) {
      try { await resident.dispose(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `${String(error)}; resident cleanup unconfirmed — capacity retained`);
      }
      throw error;
    }
    return resident;
  }

  async disposeHandle(handle: AgentHandle): Promise<void> {
    await handle.dispose();
  }

  /** Live handle by agent id (E7 supervision feed), or null. */
  getHandle(agentId: string): AgentHandle | null {
    for (const handle of this.handles) {
      if (handle.id === agentId && !this.unpublished.has(handle) && !this.quarantined.has(handle)) return handle;
    }
    return null;
  }

  /** Revoke lookup eligibility for a handle its owner rejected: a quarantined
   * handle is no longer returned by getHandle, so no dispatch/consumer path
   * can hand a supervisor-refused producer new work while its cleanup is
   * outstanding (issue #280 AC1). The quarantine is monotonic — disposal, or
   * registry shutdown, drops the record (and the quarantined handle with it).
   * A handle quarantined before its publication is never published, and holds
   * no frames for tap consumers (#352). */
  quarantineHandle(handle: AgentHandle): void {
    if (!this.handles.has(handle)) return;
    this.quarantined.add(handle);
    this.publications.get(handle)?.refuse();
  }

  /** The shared offline pi ModelRuntime for read-only consumers (the
   * provider-recovery probe resolves routes/credentials through the SAME
   * instance spawns use). Creates the pi adapter if needed — offline
   * construction only, no network refresh. */
  piModelRuntime(): Promise<ModelRuntime> {
    const adapter = this.runtimeFor('pi');
    const native = this.nativeAdapters.get('pi');
    if (!(native instanceof PiRuntime)) {
      throw new Error('pi runtime adapter unavailable — the provider-recovery probe requires it');
    }
    void adapter;
    return native.runtimeHandle();
  }

  /** Snapshot of every live handle (roll drain probe: mid-turn sessions). */
  listHandles(): readonly AgentHandle[] {
    return [...this.handles];
  }


  status(): RuntimeStatus {
    let anySession = false;
    let streaming = false;
    let lastActivity: string | null = null;
    for (const handle of this.handles) {
      const health = handle.health();
      if (health.state === 'disposed') continue;
      anySession = true;
      if (isStreamingState(health.state)) streaming = true;
      if (
        health.lastActivity !== null &&
        (lastActivity === null || health.lastActivity > lastActivity)
      ) {
        lastActivity = health.lastActivity;
      }
    }
    return {
      agentSession: {
        state: streaming ? 'streaming' : anySession ? 'idle' : 'no-session',
        lastActivity,
      },
      sessionGrowth: this.growth,
      activeSessions: this.handles.size,
      adapters: [...this.adapters.values()].map((adapter) => ({
        id: adapter.id,
        state: adapter.health().state,
      })),
    };
  }

  async dispose(): Promise<void> {
    this.residents.shutdown();
    // Contain every handle AND adapter (issue #341) in TWO ordered, internally
    // concurrent phases. A plain sequential await aborts on the first
    // CessationIdleTimeoutError, leaving the remaining handles locked and the
    // adapters' bridges/sockets never torn down; and starting both kinds at
    // once lets a native adapter snapshot the same underlying handles before
    // their resident wrappers retire them, re-attributing one handle's
    // timeout as an adapter-only failure.
    //
    // Phase 1 starts every resident handle's disposal concurrently and waits
    // for ALL of them. Phase 2 then starts every adapter concurrently EVEN IF
    // phase 1 failed: by then each underlying handle has retired from the
    // adapter's own set, so the adapter phase does not duplicate the same
    // failure. disposePhases combines the attributed causes of both phases
    // (resident ids first, adapter ids second) and reports them once.
    // Handles go through disposeHandle to preserve the override seam.
    const residentTargets: DisposableTarget[] = [...this.handles].map((handle) => ({
      id: handle.id,
      dispose: (): Promise<void> => this.disposeHandle(handle),
    }));
    const adapterTargets: DisposableTarget[] = [...this.adapters.values()].map((adapter) => ({
      id: adapter.id,
      dispose: (): Promise<void> => adapter.dispose(),
    }));
    try {
      await disposePhases([residentTargets, adapterTargets]);
    } finally {
      this.adapters.clear();
    }
    this.quarantined.clear();
  }
}

/**
 * Ruling-16 degrade: an adapter declaring thinkingLevelControl: false
 * cannot set the level — a non-default request degrades to warn +
 * proceed (the level is omitted, never silently ignored).
 */
export function applyThinkingFallback(
  adapter: AgentRuntime,
  thinkingLevel: string,
  log: Log = () => {},
): string {
  if (thinkingLevel !== 'default' && !adapter.capabilities.thinkingLevelControl) {
    log('warn', 'runtime cannot set thinking level — proceeding without it', {
      runtime: adapter.id,
      requested_thinking_level: thinkingLevel,
    });
    return 'default';
  }
  return thinkingLevel;
}
