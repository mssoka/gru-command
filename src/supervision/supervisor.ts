import { existsSync, statSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { DirectiveProducer } from '../runtime/directive-checkpoint.js';
import type { Role, SupervisionConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { AgentHandle, AgentState, PendingTurn, RuntimeEvent, SpawnOptions } from '../runtime/types.js';
import { adapterCessationEvidence } from '../runtime/types.js';
import type { AgentEventEnvelope } from '../runtime/registry.js';
import type { LedgerApi } from '../ledger/api.js';
import { isJobTerminal } from '../ledger/states.js';
import { LIVE_DIRECTIVE_STATES } from '../ledger/directives.js';
import type { NotificationCenter } from '../notifications/center.js';
import type { DecisionService } from '../decisions/types.js';
import {
  DECISION_SURFACE_SUPERVISION,
  deterministicFailureClass,
  supervisionDecisionRequest,
} from '../decisions/questions.js';
import { supervisionGuidance } from '../decisions/effects.js';
import {
  backoffDelayMs,
  isRateLimitErrorText,
  pacingExhaustedPayload,
  pacingRecoveredPayload,
  pacingRetryPayload,
  type PacingExhaustedPayload,
  type PacingGate, type PacingLease, type PacingRecoveredPayload, type PacingRetryPayload,
  type RateLimitBackoffPolicy, type RetrySettlement,
} from '../runtime/pacing.js';
import { WorkerDisposalInProgressError } from '../runtime/worker-errors.js';
import { stageSpawnRegistration } from '../runtime/spawn-registration.js';
import { promptWithTerminalVerdict } from '../runtime/prompt-verdict.js';
import { surfaceDirectiveRecovery } from '../dispatch/directive-progress.js';
import { observeDisposalSettlement } from '../runtime/disposal-observation.js';
import { RestartCleanupJournal, restartCleanupDiagnostic, type RestartCleanupDebt } from './restart-cleanup.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/** A thrown value's text for a reason or detail: never blank, never a second throw. */
function failureText(error: unknown): string {
  try {
    const text = String(error);
    return text.trim() === '' ? 'an error with no text' : text;
  } catch {
    return 'an error that cannot be printed';
  }
}

/** Default backoff sleep: a real, unref'd timer (tests inject a fake). */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * The registry surface supervision consumes (structural — the real
 * RuntimeRegistry satisfies it; tests drive a controllable fake). Keeps
 * the supervisor decoupled from the concrete registry class.
 */
export interface SupervisorRegistry {
  onAgentEvent(listener: (envelope: AgentEventEnvelope) => void): () => void;
  getHandle(agentId: string): AgentHandle | null;
  /** Revoke lookup eligibility for a handle supervision rejected: a
   * quarantined handle is never returned by getHandle, so no dispatch path
   * can hand a supervisor-refused producer new work while its cleanup is
   * outstanding (issue #280 AC1). Implementations make this monotonic;
   * disposal, or registry shutdown, drops the record. */
  quarantineHandle(handle: AgentHandle): void;
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
 * run never trips the watchdog. On top of that:
 *
 * - An OPEN tool call with a live process is activity, never silence:
 *   runtimes emit long-tool heartbeats (tool_update) and expose a
 *   live-process probe; supervision consults both and fails toward NOT
 *   killing a live process.
 * - A wall-clock gap between watchdog ticks means the machine slept:
 *   silence accrued while nothing could run, so every open turn gets a
 *   fresh window instead of a restart.
 * - A restart that kills an open turn snapshots the pending prompt and
 *   re-delivers it on the resumed session; when no snapshot is possible
 *   it posts a durable action-required recoverable-lane note.
 *
 * In-band turn errors (state 'error', next turn recovers — the adapter
 * contract) are NEVER restarts. Only hangs (open turn, silence past the
 * timeout) and fatal runtime errors climb the ladder.
 */

export type SupervisionState = 'watching' | 'restarting' | 'stopped';

/** A tick gap at least this large (beyond jitter) means the process or
 * the whole machine was suspended — silence accrued while NOTHING could
 * run, so it is not hang evidence. */
const WAKE_GAP_MIN_MS = 30_000;

/** Per-agent supervision view (board + /health). */
export interface AgentSupervisionView {
  readonly agentId: string;
  readonly role: Role;
  readonly slotId: string | null;
  readonly state: SupervisionState;
  /** Restarts inside the current window (the breaker ring size). */
  readonly restarts: number;
  readonly breakerOpen: boolean;
  /** Why the agent is stopped (failure class, crash loop, …) — null when
   * running. The board renders this on the job lane instead of a bare
   * "working" so a stopped lane never reads as live work. */
  readonly stopReason: string | null;
  /** When the stop opened (ISO; null/absent while running or on
   * pre-upgrade servers). Stop-recency ordering prefers this over the
   * last frame. */
  readonly stoppedAt?: string | null;
  readonly openTurn: boolean;
  /** Control operations are always emitted by the real supervisor. */
  readonly openControl?: boolean;
  /** Tool calls currently open (a live process here is activity, not a hang). */
  readonly openToolCalls: number;
  /** Background work a replied turn still waits on (claude-code), as the
   * runtime describes it; empty when none. */
  readonly backgroundTasks?: readonly string[];
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
  /** One FYI warning per open native-compaction episode (cleared with the
   * latch by compaction_end / disposal). */
  compactionWarned: boolean;
  /** callId → tool name for tool calls currently executing. */
  openToolCalls: Map<string, string>;
  /** The open turn's latest `background_wait` tasks (read only while open). */
  backgroundTasks: readonly string[];
  /** An interrupted turn awaiting resume on the next live handle. Survives
   * failed rungs and breaker re-arms — the lane must never be forgotten. */
  pendingRecovery: InterruptedTurn | null;
  /** Provider pacing: the abort handle for a restart-recovery delivery
   * waiting on (or running under) a worker admission slot. Aborted when
   * the recovery attempt is superseded, disposed, or a new failure lands;
   * the waiting coroutine then exits without consuming a turn. */
  recoveryAdmission: AbortController | null;
  lastEventAt: number;
  lastFileBytes: number | null;
  /** Restart timestamps (epoch ms) — the breaker ring. */
  restartRing: number[];
  consecutiveFailures: number;
  breakerOpen: boolean;
  /** Why the agent is stopped (null while running) — cleared on re-arm. */
  stopReason: string | null;
  /** When the current stop opened (epoch ms; null while running) — the
   * board/digest stop-recency key: a stop AFTER a later frame still wins
   * the lane's displayed cause (code review 2026-10-04). */
  stoppedAt: number | null;
  breakerNotificationId: string | null;
  /** A fenced re-arm whose fresh alert post FAILED: retried on every tick
   * until the stop has a live bound control again (never a stranded debt). */
  pendingRearmFenceAlert: { readonly reason: string } | null;
  /** A restart rung is executing: disposed envelopes must not evict us. */
  inRestart: boolean;
  /**
   * Retained ordinary predecessor custody (F60-P2). When an ordinary restart
   * is refused because the predecessor's adapter could not attest cessation,
   * the EXACT predecessor handle is kept here — on the existing supervised
   * entity — until positive evidence arrives. Every reachable ordinary
   * ensure/rearm/retry/replacement re-checks it; a null handle, a breaker
   * reset and disposal fulfillment never clear it.
   */
  unprovenStop: { readonly handle: AgentHandle; readonly reason: string } | null;
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
    source: ProviderErrorSource | null;  // carries .typed (r1 #13)
    recovery: InterruptedTurn | null;
    handle: AgentHandle | null;
    activityGeneration: number;
    openTurn: boolean;
    openControl: boolean;
  } | null;
  /** Active automatic rate-limit retry incident (null when none). While set
   * it owns recovery for this agent; the watchdog skips hang detection
   * until its next delivery attempt is actually running. */
  rateLimitRetry: RateLimitRetryIncident | null;
}

/** One active automatic rate-limit retry incident: the failed turn's prompt
 * is re-delivered on the SAME live session after each bounded backoff, and
 * every failure inside the incident spends one retry from the resolved
 * budget. Cleared by recovery, replacement, or a clean delivery. */
interface RateLimitRetryIncident {
  readonly admissionAbort: AbortController;
  /** Retries scheduled so far (attempt numbers are 1-based at schedule). */
  attempts: number;
  readonly maxRetries: number;
  /** The failed turn's prompt, captured synchronously at error time —
   * before the adapter clears its live-turn snapshot. */
  readonly pending: PendingTurn;
  /** Exact interrupted-turn ownership transferred into this retry. */
  readonly recovery: InterruptedTurn;
  /** Startup replay has no recovered-delivery coroutine to settle its failure. */
  readonly startupHandle: AgentHandle | null;
  readonly classifications: Promise<void>[];
  /** A delivery attempt is in flight right now. */
  awaitingDelivery: boolean;
  /** Monotonic per-delivery token; only the owning delivery may clear
   * awaitingDelivery or act on its own settlement. */
  deliveryToken: number;
  /** Token of the delivery currently in flight (null when none). */
  activeDelivery: number | null;
  /** Failure signals observed in this incident: a delivery failed iff this
   * counter moved across (i.e. during) that delivery. */
  failureSeq: number;
  lastError: string;
  /** Resolved exactly once as the incident concludes, so a delivery call
   * site can keep its own lifecycle pending until the bounded recovery
   * succeeded or exhausted (instead of settling/disposing the handle out
   * from under the retry). */
  readonly settled: Promise<Exclude<RetrySettlement, 'none'>>;
  resolveSettled: (disposition: Exclude<RetrySettlement, 'none'>) => void;
}

interface RecoveryAuthority {
  readonly jobId: string | null;
  readonly authorityEpoch: number | null;
  /** Native request identities also change when no retirement ever occurred. */
  readonly producerIdentity: string | null;
}

/** What a restart rung must know to recover a killed open turn. */
interface InterruptedTurn extends RecoveryAuthority {
  /** The prompt to re-deliver, when the runtime could describe it. */
  readonly pending: PendingTurn | null;
  /** The supervisor observed an open turn/control at kill time. */
  readonly hadOpenTurn: boolean;
  /** The agent id at kill time — the lane binding every signal names. A
   * fresh-mint restart may retire the record's current id, but the job /
   * branch / phase context lives under this one. */
  readonly originAgentId: string;
}

interface RestartFlight {
  authority: RecoveryAuthority | null;
  handle: AgentHandle | null;
  publish: (() => void) | null;
  unsubscribe: (() => void) | null;
  superseded: boolean;
  pendingError: Extract<RuntimeEvent, { type: 'error' }> | null;
  /** Canonical adapter event; its observer may run after registry forwarding. */
  pendingErrorSource: Extract<RuntimeEvent, { type: 'error' }> | null;
  /** Best synchronous custody from this native turn; duplicate errors may
   * follow prompt clearance, but a new turn never inherits the old body. */
  pendingErrorSnapshot: InterruptedTurn | null;
  turnGeneration: number;
  openTurn: boolean | null;
  readonly errorTurnGenerations: WeakMap<RuntimeEvent, number>;
}

interface RejectedRestartCleanup {
  readonly jobId: string | null;
  readonly agent: SupervisedAgent;
  readonly recovery: InterruptedTurn | null;
  readonly preserveController: boolean;
  /** true = the replacement's captured authority was superseded, so the
   * controller is abandoned once custody settles. false = an unbound
   * replacement (binding failure) whose controller stays retryable. */
  readonly superseded: boolean;
  disposalAcknowledged: boolean;
  /** The supervisor's own disposal rejected; a re-run may acknowledge it. */
  disposalFailed: boolean;
  redisposing: boolean;
  notificationId: string | null;
  debt: RestartCleanupDebt | null;
  detach: () => void;
  settling: boolean;
}

interface RecoveryDelivery {
  retry: RateLimitRetryIncident | null;
  readonly snapshots: Set<InterruptedTurn>;
  readonly errors: WeakSet<RuntimeEvent>;
  readonly classifications: Promise<void>[];
}

/** The notification re-arm authority must survive each restart attempt and
 * the asynchronous recovery delivery that follows a successful spawn. */
interface RestartRungOptions {
  readonly rearmFence?: boolean;
  readonly rearmNotificationId?: string | null;
}

/** Structured provider identity from a runtime error, when the runtime
 * carried one (the provider-recovery sensor's evidence input; never
 * guessed from prose). */
export interface ProviderErrorSource {
  readonly provider: string | null;
  readonly model: string | null;
  readonly error: string;
  /** Typed provider-response provenance (r1 #13) — absent for arbitrary
   * turn exceptions; the sensor requires it to establish a wait. */
  readonly typed: {
    readonly origin: 'sdk-error' | 'provider-message';
    readonly status?: number;
    readonly bodyCode?: string;
    readonly retryAfterMs?: number;
  } | null;
}

/** The provider-recovery observation sink (the sensor's recorder): the
 * supervisor reports every wall stop with its structured evidence; the
 * sink alone decides eligibility (owner control is preserved for
 * auth/billing/ambiguous/unsupported). */
export interface ProviderWallSink {
  /** Machine-ownership classification BEFORE any owner stop is created
   * (phase3 r1 #2): true only when the sink has ALREADY durably persisted
   * an eligible machine-owned provider wait for this stop. false/absent/
   * throwing keeps the conservative human-controlled needs-owner stop. */
  ownsProviderWall?(input: {
    readonly agentId: string;
    readonly role: Role;
    readonly slotId: string | null;
    readonly jobId: string | null;
    readonly sessionFile: string | null;
    readonly failureClass: string;
    readonly source: ProviderErrorSource | null;
    readonly continuation: { readonly promptText: string | null; readonly promptOwner: string | null; readonly hadOpenTurn: boolean } | null;
  }): Promise<boolean>;
  /** Link the machine-owned stop notice onto the persisted wait (lifecycle). */
  linkProviderWaitIncident?(waitLink: { readonly agentId: string; readonly incidentId: string }): void;
  onProviderWall(input: {
    readonly agentId: string;
    readonly role: Role;
    readonly slotId: string | null;
    readonly jobId: string | null;
    readonly sessionFile: string | null;
    readonly failureClass: string;
    readonly source: ProviderErrorSource | null;
    readonly incidentId: string | null;
    readonly continuation: { readonly promptText: string | null; readonly promptOwner: string | null; readonly hadOpenTurn: boolean } | null;
  }): void;
}

/** A declared supervision slot — a stable identity that outlives handles
 * (the Gru chat session today; E8's dispatch flow declares more). */
export interface SupervisedSlot {
  readonly id: string;
  readonly role: Role;
  /** Spawn (adopting the result); usually wraps registry.spawn. */
  ensure(options?: SpawnOptions & { readonly intent?: 'user' | 'autonomous' }): Promise<AgentHandle>;
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
  /** Optional provider-recovery observation sink: wall stops are reported
   * with their structured evidence; the sink alone decides wait
   * eligibility. Absent = pure observer (no sensor). */
  readonly providerWalls?: ProviderWallSink;
  readonly log?: Log;
  /** Test seam: tick interval override (default: min(silence/4, 5 s)). */
  readonly tickMs?: number;
  /** Test seam: clock (default Date.now). */
  readonly now?: () => number;
  /** Test seam: wall clock used only for sleep/wake gap detection
   * (default Date.now; the `now` seam is free to be a fake clock). */
  readonly wallNow?: () => number;
  /** Resolved rate-limit automatic retry policy (owner heist 2026-09-29);
   * null/omitted = feature off — the failure keeps its current ladder
   * behavior (stop for provider walls, nothing for other in-band errors). */
  readonly rateLimitBackoff?: RateLimitBackoffPolicy | null;
  readonly workerGate?: PacingGate;
  /** Test seam: backoff sleep (default a real unref'd timer). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam: jitter over [0, capMs) added to each backoff delay (default
   * uniform random). Tests pin it for deterministic ladder-shape asserts. */
  readonly jitter?: (capMs: number) => number;
  /**
   * Late-bound per-agent restart specialization (issue #161): the child-
   * worker subsystem is constructed after the supervisor, so this resolver
   * is installed by a setter. Returning `undefined` = default restart;
   * `{ options }` = restart with these spawn options (lane cwd, bounded
   * tools, product-owned agent id); `{ refuse }` = do not restart (the
   * owner has already terminalized the record honestly).
   */
  readonly restartPolicyFor?: (agentId: string, role: Role) => SupervisorRestartPolicy | undefined;
}

/** One restart specialization decision (see SupervisorOptions). */
export type SupervisorRestartPolicy =
  | { readonly options: SpawnOptions }
  | { readonly refuse: string };

export class Supervisor {
  private readonly retainedDirectiveProducers = new Map<AgentHandle, string>(); // original job, independent of logical-agent reassociation
  private readonly cfg: SupervisionConfig;
  private readonly registry: SupervisorRegistry;
  private readonly ledger: LedgerApi;
  private readonly notifications: NotificationCenter;
  private readonly decisions: DecisionService | null;
  private readonly providerWalls: ProviderWallSink | null;
  private readonly log: Log;
  private readonly now: () => number;
  private readonly wallNow: () => number;
  private readonly rateLimitBackoff: RateLimitBackoffPolicy | null;
  private readonly workerGate: PacingGate | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly jitter: (capMs: number) => number;
  /** Late-bound restart specialization (issue #161; see the option doc). */
  private restartPolicyFor: (agentId: string, role: Role) => SupervisorRestartPolicy | undefined;
  /** Late-bound Perkins ownership probe: the review wave is assembled after
   * the supervisor, but notification re-arms must honor its writer fence. */
  private activeReviewFor: (jobId: string) => boolean = () => false;
  /** Late-bound blind-coverage observer (issue #339): a restart-recovered
   * turn is a resume too. The dispatch service that owns the scan is built
   * after the supervisor, so this is installed by `setObserveBlindTurn`. */
  private observeBlindTurn: ((jobId: string, sessionFile: string | null) => void) | null = null;
  private readonly agents = new Map<string, SupervisedAgent>();
  /** Rejected replacements are never job-bound/adopted. Their cleanup
   * ownership must still fence the captured job, including when disposal
   * rejects after the registry has already removed the handle. */
  private readonly rejectedRestartCleanup = new Map<AgentHandle, RejectedRestartCleanup>();
  private readonly rejectedRestartControllers = new WeakSet<SupervisedAgent>();
  private readonly cleanupJournal: RestartCleanupJournal;
  private readonly recoveryDeliveries = new WeakMap<AgentHandle, RecoveryDelivery>();
  /** Rung ownership survives a newer same-id controller replacing its index. */
  private readonly restartingAgents = new Map<SupervisedAgent, RestartFlight>();
  /** Held startup failures must retain their synchronous pending-turn evidence. */
  private readonly restartErrorSnapshots = new WeakMap<RuntimeEvent, InterruptedTurn>();
  private readonly restartSnapshotSources = new WeakMap<InterruptedTurn, RuntimeEvent>();
  /** Durable stop truth for agents whose live record is gone (restart
   * hydration; code review 2026-10-04). viewFor falls back to this map. */
  private restoredStops = new Map<string, AgentSupervisionView>();
  /** Durable breaker controls and alert-post debt paired with restored stops. */
  private readonly restoredRearmControls = new Map<
    string,
    { readonly notificationId: string | null; readonly pendingFenceReason: string | null }
  >();
  private readonly slots = new Map<string, SupervisedSlotInternal>();
  private readonly unsubscribeTap: () => void;
  private readonly tickMs: number;
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** Wall-clock of the previous watchdog tick (sleep/wake detection). */
  private lastTickWallAt: number | null = null;
  private disposed = false;

  constructor(opts: SupervisorOptions) {
    this.cfg = opts.config;
    this.registry = opts.registry;
    this.ledger = opts.ledger;
    this.cleanupJournal = new RestartCleanupJournal(opts.ledger);
    this.notifications = opts.notifications;
    this.decisions = opts.decisions ?? null;
    this.providerWalls = opts.providerWalls ?? null;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? Date.now;
    this.wallNow = opts.wallNow ?? Date.now;
    this.rateLimitBackoff = opts.rateLimitBackoff ?? null;
    this.workerGate = opts.workerGate;
    this.sleep = opts.sleep ?? defaultSleep;
    this.jitter = opts.jitter ?? ((capMs: number) => Math.random() * capMs);
    this.restartPolicyFor = opts.restartPolicyFor ?? (() => undefined);
    // Cadence: a quarter of the silence window, capped at 5 s so a tight
    // window still ticks promptly.
    this.tickMs = opts.tickMs ?? Math.min(this.cfg.turnSilenceMs / 4, 5_000);
    this.unsubscribeTap = this.registry.onAgentEvent((envelope) => this.onEnvelope(envelope));
  }

  /** Late-bound restart specialization (issue #161): the child-worker
   * subsystem is built after the supervisor, so the policy is installed
   * here. Returning undefined = default restart. */
  setRestartPolicy(policy: (agentId: string, role: Role) => SupervisorRestartPolicy | undefined): void {
    this.restartPolicyFor = policy;
  }

  /** Install the late-bound Perkins writer-ownership probe. A throw is
   * treated as unknown ownership and therefore refuses a notification
   * re-arm. */
  setActiveReviewProbe(probe: (jobId: string) => boolean): void {
    this.activeReviewFor = probe;
  }

  /** Issue #339: install the blind-coverage observer for supervisor-recovered
   * turns (late-bound: the dispatch service that owns the scan is built after
   * the supervisor). A restarted blind reviewer's recovered turn is a resume,
   * so its prohibited reads must invalidate coverage exactly like the initial
   * dispatch and re-brief settle seams. */
  setObserveBlindTurn(observe: (jobId: string, sessionFile: string | null) => void): void {
    this.observeBlindTurn = observe;
  }

  /** Start the watchdog ticker. */
  start(): void {
    if (this.disposed || this.ticker !== null) return;
    // Restart hydration: the supervisor is in-process only, so a stopped
    // worker would otherwise lose its waiting truth (and a stalled lane
    // could wake) until the next live event (code review 2026-10-04).
    this.restoredStops = this.hydrateRestoredStops();
    for (const agent of this.agents.values()) this.restoreDurableStop(agent);
    this.ticker = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        // The supervisor observes the runtime; its own faults must never
        // take the service down (unhandled timer throws are fatal in main).
        this.log('error', 'supervision tick failed', { error: String(error) });
      }
    }, this.tickMs);
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
      canReplace: () => {
        const agent = this.slotAgent(internal);
        if (agent === null || agent === undefined) return true;
        // A retained unproven predecessor fails closed (F60-P2): an open
        // breaker was never the only way a replacement may be refused.
        if (this.unprovenPredecessor(agent) !== null) return false;
        return agent.breakerOpen !== true;
      },
      adoptReplacement: (handle) => this.adoptSlotReplacement(internal, handle),
      release: () => {
        // Invalidate in-flight restart rungs before deleting their records.
        internal.generation += 1;
        this.slots.delete(internal.id);
        for (const agent of this.agents.values()) {
          if (agent.slot === internal) {
            if (agent.backoffTimer !== null) clearTimeout(agent.backoffTimer);
            // Retiring the record must conclude its pacing state exactly as
            // the disposed/shutdown funnels do, or a delivery already
            // awaiting `settled` is left hanging.
            this.clearRateLimitRetry(agent, 'superseded');
            this.clearRecoveryAdmission(agent);
            this.agents.delete(agent.agentId);
          }
        }
      },
    };
  }

  private async ensureSlot(
    slot: SupervisedSlotInternal,
    options?: SpawnOptions & { readonly intent?: 'user' | 'autonomous' },
  ): Promise<AgentHandle> {
    const existing = this.slotAgent(slot);
    if (existing?.breakerOpen && options?.intent === 'autonomous') {
      throw new Error(`supervised slot "${slot.id}" breaker is open; autonomous ensure cannot re-arm it`);
    }
    if (existing !== null && existing.handle !== null) return existing.handle;
    if (existing !== null && this.unprovenPredecessor(existing) !== null) {
      // Fail closed (F60-P2): the entity's predecessor stop is unproven, so a
      // later ordinary ensure — user intent and rearm included — must not
      // resume or replace the maybe-live session.
      throw new Error(
        `supervised slot "${slot.id}" predecessor stop is unproven; refusing to spawn until the adapter attests cessation`,
      );
    }
    if (existing !== null && existing.inRestart) {
      // A restart rung owns the respawn; wait for it by polling the slot.
      return await this.waitForSlotHandle(slot);
    }
    if (existing !== null && existing.breakerOpen) {
      if (!this.cfg.enabled) {
        // Supervision off: no re-arm semantics — clear the stale breaker
        // state so the slot serves again (pure registry behavior).
        existing.breakerOpen = false;
        existing.stopReason = null;
        existing.stoppedAt = null;
        existing.breakerNotificationId = null;
        existing.pendingRearmFenceAlert = null;
        existing.restartRing = [];
      } else {
        // A caller-driven action (a chat message) is human intent: re-arm
        // the stopped agent rather than serving it unsupervised — and the
        // escalation row resolves with it (acked by the re-arm itself).
        existing.breakerOpen = false;
        existing.stopReason = null;
        existing.stoppedAt = null;
        const rearming = existing.breakerNotificationId;
        existing.breakerNotificationId = null;
        existing.pendingRearmFenceAlert = null;
        existing.restartRing = [];
        existing.consecutiveFailures = 0;
        existing.state = 'watching';
        this.restoredStops.delete(existing.agentId);
        this.restoredRearmControls.delete(existing.agentId);
        this.log('info', 'breaker re-armed by slot use — resuming supervision', {
          agent_id: existing.agentId,
          slot: slot.id,
        });
        this.ledger.appendCustomEvent({
          kind: 'supervision.rearmed',
          agentId: existing.agentId,
          payload: { by: 'slot-use', slot: slot.id },
        });
        if (rearming !== null) {
          // Owner release 2026-10-11: the escalation row is MACHINE
          // attention now; human intent (this slot use) resumed the lane,
          // so the row resolves by evidence — never acked, never stranded
          // open behind a recovered agent.
          this.ledger.resolveNotificationById(rearming, 'slot-use');
        }
      }
    }
    const ensureGeneration = slot.generation;
    const { intent: _intent, ...spawnOptions } = options ?? {};
    const handle = await slot.spawn(spawnOptions);
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
    // F60-P2: an intentional replacement must not leapfrog a retained
    // unproven predecessor stop, and must not drop its custody by switching
    // the slot generation. Fail closed until the adapter attests cessation.
    const heldPredecessor = [...this.agents.values()].find(
      (agent) => agent.slot === slot && this.unprovenPredecessor(agent) !== null,
    );
    if (heldPredecessor !== undefined) {
      await this.registry.disposeHandle(handle).catch(() => {});
      throw new Error(
        `supervised slot "${slot.id}" predecessor stop is unproven; refusing an intentional replacement until the adapter attests cessation`,
      );
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
      live.stopReason = inheritedBreaker?.stopReason ?? null;
      live.stoppedAt = inheritedBreaker?.stoppedAt ?? null;
      live.breakerNotificationId =
        inheritedBreaker?.breakerNotificationId ?? live.breakerNotificationId;
      live.pendingRearmFenceAlert =
        inheritedBreaker?.pendingRearmFenceAlert ?? live.pendingRearmFenceAlert ?? null;
      // Defence in depth: retained predecessor custody belongs to the stable
      // supervised entity and must never be lost across a replacement.
      if (live.unprovenStop === null) {
        const inheritedHeld = retired.find((agent) => agent.unprovenStop !== null);
        if (inheritedHeld !== undefined) live.unprovenStop = inheritedHeld.unprovenStop;
      }
    }

    for (const agent of retired) {
      if (agent.backoffTimer !== null) clearTimeout(agent.backoffTimer);
      // Intentional session replacement invalidates stale work by generation;
      // it does not erase restart history or acknowledge a human-facing
      // breaker notification. Both follow the stable supervised slot. The
      // pacing state is concluded like every other retirement funnel.
      this.clearRateLimitRetry(agent, 'superseded');
      this.clearRecoveryAdmission(agent);
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

  /**
   * The retained unproven predecessor for an entity, if its stop is still
   * unproven (F60-P2). Returns null once the adapter attests 'ceased', and
   * clears the retained custody at that point. A missing/throwing/UNKNOWN
   * adapter answer keeps the predecessor retained — health, disposal
   * settlement, lock release and native retirement are never proof.
   */
  private unprovenPredecessor(agent: SupervisedAgent): AgentHandle | null {
    const held = agent.unprovenStop;
    if (held === null) return null;
    if (adapterCessationEvidence(held.handle) === 'ceased') {
      agent.unprovenStop = null;
      return null;
    }
    return held.handle;
  }

  /** Retain the exact predecessor handle once, on first refusal. */
  private retainUnprovenPredecessor(agent: SupervisedAgent, handle: AgentHandle, reason: string): void {
    if (agent.unprovenStop === null) agent.unprovenStop = { handle, reason };
  }

  /** Retire dead (null-handle) slot-bound records other than the live
   * one, merging their restart history so the breaker stays truthful. */
  private retireStaleSlotRecords(slot: SupervisedSlotInternal, liveId: string): void {
    const live = this.agents.get(liveId);
    for (const agent of [...this.agents.values()]) {
      if (agent.slot !== slot || agent.handle !== null || agent.agentId === liveId) continue;
      if (live !== undefined) {
        // The retained unproven predecessor is custody of the ENTITY: never
        // drop it when a dead record is merged into the live one (F60-P2).
        if (live.unprovenStop === null && agent.unprovenStop !== null) live.unprovenStop = agent.unprovenStop;
        live.restartRing = [...live.restartRing, ...agent.restartRing].sort((a, b) => a - b);
        if (agent.breakerOpen && !live.breakerOpen) {
          live.breakerOpen = true;
          live.stopReason = agent.stopReason;
          live.stoppedAt = agent.stoppedAt;
          live.breakerNotificationId = agent.breakerNotificationId;
          live.pendingRearmFenceAlert = agent.pendingRearmFenceAlert ?? null;
          live.state = 'stopped';
        }
      }
      if (agent.backoffTimer !== null) clearTimeout(agent.backoffTimer);
      this.clearRateLimitRetry(agent, 'superseded');
      this.clearRecoveryAdmission(agent);
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

  private onEnvelope(envelope: AgentEventEnvelope): Promise<void> | null {
    if (this.disposed) return null;
    try {
      if (envelope.phase === 'spawned') {
        const handle = envelope.handle ?? this.registry.getHandle(envelope.agentId);
        // The awaiting owner, not its tap, adopts its authorized result.
        if (handle !== null && [...this.restartingAgents.values()].some((flight) => flight.handle === handle)) return null;
        this.adopt(handle ?? null, null, envelope.sessionFile, envelope);
        return null;
      }
      const current = this.agents.get(envelope.agentId);
      if (envelope.handle !== undefined && current?.handle !== envelope.handle) return null;
      if (envelope.handle === undefined && current?.handle !== null &&
        [...this.restartingAgents.values()].some((flight) => flight.superseded && flight.handle?.id === envelope.agentId)) return null;
      if (envelope.phase === 'disposed') {
        const agent = this.agents.get(envelope.agentId);
        if (agent === undefined) return null;
        // A disposed handle can never deliver a pending retry: conclude
        // the incident with it (the delivery continuation self-cancels
        // too) and supersede any restart-recovery admission wait.
        this.clearRateLimitRetry(agent, 'superseded');
        this.clearRecoveryAdmission(agent);
        agent.handle = null;
        agent.openTurn = false;
        agent.openControl = false;
        agent.compactionWarned = false;
        // A breaker-STOPPED agent keeps its record: the escalation names
        // it and the ack must find it to re-arm (deleting here would strand
        // the stopped agent — same reasoning as inRestart stickiness).
        if (agent.slot === null && !agent.inRestart && !agent.breakerOpen) {
          this.agents.delete(envelope.agentId); // owner-disposed minion: stop watching
        }
        return null;
      }
      // phase 'event'
      const agent = this.agents.get(envelope.agentId);
      if (agent === undefined) return null;
      const event = envelope.event;
      if (event === undefined) return null;
      agent.lastEventAt = this.now();
      // Adapters emit `error` followed immediately by their sticky
      // `state:error`. The latter is the same failure, not recovery/new
      // activity; letting it advance the token would invalidate the bounded
      // decision started by the error event itself (a known wall stops
      // without one, #492).
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
          agent.openToolCalls.clear();
          agent.backgroundTasks = [];
          break;
        case 'background_wait':
          agent.backgroundTasks = [...event.tasks];
          break;
        case 'compaction_start':
          agent.openControl = true;
          break;
        case 'compaction_end':
          agent.openControl = false;
          agent.compactionWarned = false;
          break;
        case 'tool_start':
          agent.openToolCalls.set(event.callId, event.tool);
          break;
        case 'tool_end':
          agent.openToolCalls.delete(event.callId);
          break;
        case 'state':
          if (event.state === 'disposed') {
            agent.openTurn = false;
            agent.openControl = false;
            agent.compactionWarned = false;
            agent.openToolCalls.clear();
          }
          break;
        case 'error': {
          if (!this.cfg.enabled) {
            // Supervision off = pure registry behavior: errors are the
            // runtime's/owner's business — observed, never acted on.
            this.log('info', 'runtime error observed — supervision disabled, no restart', {
              agent_id: agent.agentId,
              error: event.error,
            });
            break;
          }
          // Publication can replay a startup error while its owner is still
          // settling the rung. Defer that exact error, never another spawn.
          const flight = [...this.restartingAgents.values()].find((item) => item.handle === agent.handle);
          if (flight !== undefined) {
            // A dead session cannot become a same-session retry because a
            // later frame is nonfatal. Equally, generic exit noise must not
            // erase a known provider wall and cause a futile blind restart.
            const previous = flight.pendingError;
            const previousClass = previous === null ? null : deterministicFailureClass(previous.error);
            const nextClass = deterministicFailureClass(event.error);
            const selected = previous !== null &&
              (previousClass === 'authentication_wall' || previousClass === 'quota_wall') &&
              nextClass !== 'authentication_wall' && nextClass !== 'quota_wall' ? previous : event;
            const fatal = (previous?.fatal ?? false) || event.fatal;
            const deferred = fatal && !selected.fatal ? { ...selected, fatal: true } : selected;
            // Look up this canonical event only after all adapter subscribers
            // have run. A merged clone must never outrun synchronous custody.
            flight.pendingErrorSource = selected === previous ? flight.pendingErrorSource ?? selected : selected;
            flight.pendingError = deferred;
            break;
          }
          const retry = agent.rateLimitRetry;
          if (event.fatal) {
            this.log('warn', 'fatal runtime error — climbing restart ladder', {
              agent_id: agent.agentId,
              error: event.error,
            });
            const classification = this.evaluateRecovery(agent, `fatal error: ${event.error}`, true, true, {
              provider: event.provider ?? null,
              model: event.model ?? null,
              error: event.error,
              typed: event.typed ?? null,
            }, this.restartErrorSnapshots.get(event) ?? null);
            retry?.classifications.push(classification);
            return classification;
          } else {
            // Preserve the adapter contract: in-band failures never restart.
            // Rate-limit-class failures first spend the bounded automatic
            // retry budget; everything else enters provider-wall
            // classification so known auth or quota failures produce durable
            // stop/re-arm guidance.
            if (!this.absorbRateLimitFailure(agent, event.error, this.restartErrorSnapshots.get(event))) {
              const classification = this.evaluateRecovery(agent, `runtime error: ${event.error}`, false, true, {
                provider: event.provider ?? null,
                model: event.model ?? null,
                error: event.error,
                typed: event.typed ?? null,
              }, this.restartErrorSnapshots.get(event) ?? null);
              retry?.classifications.push(classification);
              if (agent.handle !== null) this.recoveryDeliveries.get(agent.handle)?.classifications.push(classification);
              return classification;
            }
          }
          break;
        }
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
    return null;
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
    let existing = this.agents.get(agentId);
    const existingHandle = existing?.handle;
    const flight = existing === undefined ? undefined : this.restartingAgents.get(existing) ??
      (existingHandle == null ? undefined : [...this.restartingAgents.values()].find((item) => item.handle === existingHandle));
    if (existing !== undefined && handle !== null && handle !== existing.handle &&
      (this.rejectedRestartControllers.has(existing) ||
        (flight !== undefined ? flight.handle !== handle : existing.backoffTimer !== null))) {
      // A native successor owns a NEW controller even when its logical id
      // is unchanged. The old coroutine must never settle its retry/stop.
      if (flight !== undefined) flight.superseded = true;
      if (existing.backoffTimer !== null) clearTimeout(existing.backoffTimer);
      existing.backoffTimer = null;
      this.clearRateLimitRetry(existing, 'superseded');
      this.clearRecoveryAdmission(existing);
      this.agents.delete(agentId);
      existing = undefined;
    }
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
      this.restoreDurableStop(existing);
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
      compactionWarned: false,
      openToolCalls: new Map(),
      backgroundTasks: [],
      pendingRecovery: null,
      lastEventAt: this.now(),
      lastFileBytes: this.fileSize(sessionFile),
      restartRing: [],
      consecutiveFailures: 0,
      breakerOpen: false,
      stopReason: null,
      stoppedAt: null,
      breakerNotificationId: null,
      pendingRearmFenceAlert: null,
      inRestart: false,
      unprovenStop: null,
      backoffTimer: null,
      activityGeneration: 0,
      decisionPending: false,
      failureTerminalPending: false,
      queuedRecovery: null,
      rateLimitRetry: null,
      recoveryAdmission: null,
    });
    const adopted = this.agents.get(agentId);
    if (adopted !== undefined) this.restoreDurableStop(adopted);
    this.log('info', 'supervising agent', { agent_id: agentId, role, slot: slot?.id ?? null });
    return true;
  }

  // ------------------------------------------------------------------
  // Watchdog tick
  // ------------------------------------------------------------------

  private tick(): void {
    if (this.disposed || !this.cfg.enabled) return;
    const now = this.now();
    this.detectWake(now);
    for (const agent of this.agents.values()) {
      // A fenced stop whose fresh control failed to post must never wait for
      // an unrelated event: retry the bind on every tick. Nullish-safe: one
      // bad carry value must never abort a whole tick pass.
      const pendingFence = agent.pendingRearmFenceAlert;
      if (pendingFence !== null && pendingFence !== undefined) {
        this.raiseFencedAlert(agent, pendingFence.reason, true);
      }
      if (agent.handle === null || agent.state !== 'watching' || agent.breakerOpen) continue;
      // An automatic rate-limit retry waiting out its backoff owns recovery:
      // the failed turn's residual silence must not read as a hang. A
      // delivery that is actually running stays under the watchdog — a hung
      // retry attempt is still a hang.
      if (agent.rateLimitRetry !== null && !agent.rateLimitRetry.awaitingDelivery) continue;
      const busy = this.handleBusy(agent.handle);
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
        if (agent.openControl) {
          // Native compaction is open: silence is NOT hang evidence. Warn
          // once, keep waiting — no dispose, no restart, no pending-turn
          // take, no clock reset (no fake progress).
          this.warnCompactionWait(agent, silence);
          continue;
        }
        if (this.hasLiveProcess(agent.handle)) {
          // An open tool call backed by a live process is ACTIVITY, never
          // silence. Reset the clock and fail toward NOT killing the work.
          agent.lastEventAt = now;
          agent.activityGeneration += 1;
          this.log('info', 'silence with a live tool process — resetting the silence clock', {
            agent_id: agent.agentId,
            silence_ms: silence,
            open_tool_calls: agent.openToolCalls.size,
          });
          continue;
        }
        // Native compaction never reaches this line (the wait branch above
        // continues first): silence past the threshold here is a genuine
        // non-compacting turn hang.
        const reason = 'turn hang';
        this.log('warn', `${reason} detected — climbing restart ladder`, {
          agent_id: agent.agentId,
          silence_ms: silence,
          threshold_ms: this.cfg.turnSilenceMs,
        });
        void this.evaluateRecovery(agent, reason);
      }
    }
    this.retryRestoredControlDebt();
  }

  /**
   * Open native compaction past the silence threshold: post ONE factual
   * FYI per episode and keep waiting (owner ruling: a stalled provider is
   * rare, and while compaction is in progress we wait for it — manual
   * owner controls remain the way to end a truly stalled episode). No
   * second deadline exists on top of this warning, and the silence clock
   * is not reset; compaction_end (success or failure) clears the latch
   * and re-arms the warning for the next episode.
   */
  private warnCompactionWait(agent: SupervisedAgent, silenceMs: number): void {
    if (agent.compactionWarned) return;
    agent.compactionWarned = true;
    this.log('info', 'native compaction still open past the silence threshold — waiting', {
      agent_id: agent.agentId,
      silence_ms: silenceMs,
      threshold_ms: this.cfg.turnSilenceMs,
    });
    try {
      this.notifications.post({
        kind: 'supervision.native-compaction-wait',
        routing: 'fyi',
        severity: 'info',
        title: `Agent ${agent.agentId}: compaction has not reported completion — continuing to wait`,
        detail:
          `Native compaction has been silent for ${Math.round(silenceMs / 1000)}s ` +
          `(threshold ${Math.round(this.cfg.turnSilenceMs / 1000)}s). ` +
          'Silence during an open compaction is not hang evidence; no restart is scheduled. ' +
          'Manual stop/reset remains available.',
        agentId: agent.agentId,
      });
    } catch (error) {
      this.log('warn', 'compaction-wait FYI could not be posted', { error: String(error) });
    }
  }

  /**
   * Sleep/wake (E7 follow-up): a watchdog tick separated from the previous
   * one by a wall-clock gap far beyond the tick cadence means the process
   * was suspended — laptop lid closed, system sleep. Silence accrued while
   * NOTHING could run, so it is not hang evidence: grant every open turn a
   * fresh silence window and leave a durable lane signal, never a restart.
   */
  private detectWake(now: number): void {
    const wall = this.wallNow();
    const previous = this.lastTickWallAt;
    this.lastTickWallAt = wall;
    if (previous === null) return;
    const gap = wall - previous;
    if (gap < Math.max(this.tickMs * 4, WAKE_GAP_MIN_MS)) return;
    const affected: SupervisedAgent[] = [];
    for (const agent of this.agents.values()) {
      if (agent.handle === null || agent.state !== 'watching') continue;
      if (!agent.openTurn && !agent.openControl && !this.handleBusy(agent.handle)) continue;
      agent.lastEventAt = now;
      agent.activityGeneration += 1;
      affected.push(agent);
    }
    this.log('warn', 'wall-clock gap detected (system sleep) — silence grace granted, no restarts', {
      gap_ms: gap,
      agents: affected.map((agent) => agent.agentId),
    });
    this.recordEvent('supervision.wake', null, {
      gap_ms: gap,
      agents: affected.map((agent) => agent.agentId),
    });
    if (affected.length > 0) {
      try {
        this.notifications.post({
          kind: 'supervision.wake',
          routing: 'fyi',
          severity: 'info',
          title: `System sleep ended — ${affected.length} open turn(s) granted a fresh silence window`,
          detail:
            'Watchdog silence across the sleep was not hang evidence. Lanes with open turns: ' +
            affected.map((agent) => this.laneContext(agent.agentId)).join('; '),
        });
      } catch (error) {
        this.log('warn', 'wake lane signal could not be posted', { error: String(error) });
      }
    }
  }

  private handleBusy(handle: AgentHandle): boolean {
    const state = this.handleState(handle);
    return state === 'streaming' || state === 'spawning';
  }

  /** Fail toward NOT killing a live process: probe errors read as live. */
  private hasLiveProcess(handle: AgentHandle | null): boolean {
    if (handle === null) return false;
    try {
      return handle.hasLiveProcess?.() === true;
    } catch (error) {
      this.log('warn', 'live-process probe failed — treating the turn as live', {
        agent_id: handle.id,
        error: String(error),
      });
      return true;
    }
  }

  /** The live job worktree of a minion's job, when it is still on disk. */
  private jobLanePath(agentId: string): string | undefined {
    try {
      const agent = this.ledger.getAgent(agentId);
      if (agent === null || agent.jobId === null) return undefined;
      const lane = this.ledger
        .listWorktrees({ jobId: agent.jobId })
        .find((worktree) => worktree.kind === 'job' && worktree.status !== 'swept');
      return lane !== undefined && existsSync(lane.path) ? lane.path : undefined;
    } catch (error) {
      this.log('warn', 'job lane lookup for restart failed', { agent_id: agentId, error: String(error) });
      return undefined;
    }
  }

  /** Best-effort durable lane context for recoverable-lane signals. */
  private laneContext(agentId: string): string {
    try {
      const agent = this.ledger.getAgent(agentId);
      if (agent === null) return `agent ${agentId}`;
      const parts = [`agent ${agentId}`, `role ${agent.role}`];
      if (agent.jobId !== null) {
        parts.push(`job ${agent.jobId}`);
        const job = this.ledger.getJob(agent.jobId);
        if (job !== null) parts.push(`phase ${job.status}`);
        const lane = this.ledger
          .listWorktrees({ jobId: agent.jobId })
          .find((worktree) => worktree.status !== 'swept');
        if (lane !== undefined) {
          if (lane.branch !== null) parts.push(`branch ${lane.branch}`);
          parts.push(`worktree ${lane.path}`);
        }
      }
      if (agent.roundId !== null) parts.push(`round ${agent.roundId}`);
      return parts.join(', ');
    } catch (error) {
      this.log('warn', 'lane context lookup failed', { agent_id: agentId, error: String(error) });
      return `agent ${agentId}`;
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
  // Automatic rate-limit retry (owner heist 2026-09-29)
  // ------------------------------------------------------------------

  /** Consumption gate for worker delivery call sites: after a prompt
   * resolves, await the bounded outcome of any automatic rate-limit retry
   * that covers the just-ended turn. The adapter tap is synchronous, so an
   * in-band error has already become an incident by the time the prompt
   * promise resolves. Callers MUST release their own worker admission
   * before awaiting — the retry reacquires the slot per attempt — and may
   * then record delivery only for `none`/`recovered`. */
  async awaitRetrySettlement(agentId: string): Promise<RetrySettlement> {
    const incident = this.agents.get(agentId)?.rateLimitRetry ?? null;
    if (incident === null) return 'none';
    return incident.settled;
  }

  /** Conclude the active incident (if any) with a disposition and clear it.
   * Every clear site funnels here so a delivery call site awaiting
   * `settled` is never left hanging. */
  private clearRateLimitRetry(
    agent: SupervisedAgent,
    disposition: Exclude<RetrySettlement, 'none'>,
  ): void {
    const incident = agent.rateLimitRetry;
    if (incident === null) return;
    // Detach first, then abort and settle independently: a throwing abort
    // listener never leaves an awaiter of this incident hanging, and never
    // escapes into the many callers that clear a retry on their way out.
    agent.rateLimitRetry = null;
    try {
      incident.admissionAbort.abort();
    } catch (error) {
      this.log('error', 'rate-limit retry abort failed — the incident is settled anyway', { agent_id: agent.agentId, error: String(error) });
    }
    try {
      incident.resolveSettled(disposition);
    } catch (error) {
      this.log('error', 'rate-limit retry settlement failed', { agent_id: agent.agentId, disposition, error: String(error) });
    }
  }

  /** Supersede a restart-recovery admission wait or in-flight delivery:
   * the waiting coroutine exits without consuming a turn. */
  private clearRecoveryAdmission(agent: SupervisedAgent): void {
    const controller = agent.recoveryAdmission;
    if (controller === null) return;
    agent.recoveryAdmission = null;
    controller.abort();
  }

  /** Consume a non-fatal runtime error through the automatic retry path.
   * True = absorbed (a retry was scheduled, or this duplicates the attempt
   * already being retried); false = hand the failure to the existing
   * recovery ladder. Never intercepts when the policy is off. */
  private absorbRateLimitFailure(agent: SupervisedAgent, errorText: string, snapshot?: InterruptedTurn): boolean {
    const policy = this.rateLimitBackoff;
    if (policy === null) return false;
    if (agent.handle?.reviewIsolation === true) {
      // The isolated workflow owns bounded rate-limit backoff and admission;
      // supervisor disposal would race its next prompt. Other errors still
      // enter the isolated-attempt abort contract.
      return isRateLimitErrorText(errorText, policy.patterns);
    }
    if (!isRateLimitErrorText(errorText, policy.patterns)) return false;
    const incident = agent.rateLimitRetry;
    if (incident !== null) {
      if (incident.awaitingDelivery) {
        // The delivery we were waiting on failed; its error event is the
        // one failure signal for this attempt. The delivery token is
        // consumed here — a stale delivery that settles late must never
        // clear the next rung's flag (per-delivery ownership).
        incident.awaitingDelivery = false;
        incident.activeDelivery = null;
        incident.failureSeq += 1;
        incident.lastError = errorText;
        return this.scheduleRateLimitRetry(agent, incident);
      }
      // Adapters duplicate failure signals (error + sticky state:error, or
      // a second error frame for one failure): never double-count an
      // attempt, and never schedule two rungs for one failure.
      return true;
    }
    const captured = snapshot ?? this.captureInterruptedTurn(agent.handle, agent);
    if (captured === null || captured.pending === null || !this.recoveryAuthorityCurrent(agent, captured)) {
      // Nothing re-deliverable was captured: the failure keeps its existing
      // ladder behavior rather than parking the lane on an undeliverable
      // retry.
      return false;
    }
    let resolveSettled!: (disposition: Exclude<RetrySettlement, 'none'>) => void;
    const settled = new Promise<Exclude<RetrySettlement, 'none'>>((resolve) => {
      resolveSettled = resolve;
    });
    const fresh: RateLimitRetryIncident = {
      attempts: 0,
      admissionAbort: new AbortController(),
      maxRetries: policy.maxRetries,
      pending: captured.pending,
      recovery: captured,
      startupHandle: snapshot !== undefined && agent.pendingRecovery === captured && agent.handle !== null &&
        !this.recoveryDeliveries.has(agent.handle) ? agent.handle : null,
      classifications: [],
      awaitingDelivery: false,
      deliveryToken: 0,
      activeDelivery: null,
      failureSeq: 1,
      lastError: errorText,
      settled,
      resolveSettled,
    };
    agent.rateLimitRetry = fresh;
    const delivery = agent.handle === null ? undefined : this.recoveryDeliveries.get(agent.handle);
    if (delivery !== undefined && delivery.retry === null) delivery.retry = fresh;
    return this.scheduleRateLimitRetry(agent, fresh);
  }

  /** Schedule the next retry rung, or give up (false) when the budget is
   * spent. One ledger event per scheduled retry is the observability
   * contract; exhaustion is recorded before the ladder takes over. */
  private scheduleRateLimitRetry(
    agent: SupervisedAgent,
    incident: RateLimitRetryIncident,
  ): boolean {
    const policy = this.rateLimitBackoff;
    if (policy === null) {
      this.clearRateLimitRetry(agent, 'superseded');
      return false;
    }
    if (incident.attempts >= incident.maxRetries) {
      this.recordEvent('pacing.auto-retry-exhausted', agent.agentId, pacingExhaustedPayload(
        incident.attempts, incident.maxRetries, incident.lastError,
      ));
      this.clearRateLimitRetry(agent, 'exhausted');
      return false;
    }
    incident.attempts += 1;
    const delayMs = backoffDelayMs(incident.attempts, policy.baseMs, policy.maxMs, this.jitter);
    this.recordEvent('pacing.auto-retry', agent.agentId, pacingRetryPayload(
      incident.attempts, incident.maxRetries, delayMs, incident.lastError,
    ));
    this.log('warn', 'rate-limit failure — automatic retry scheduled', {
      agent_id: agent.agentId,
      attempt: incident.attempts,
      max_auto_retries: incident.maxRetries,
      delay_ms: delayMs,
    });
    const retryDelivery = this.deliverRateLimitRetry(agent, incident, delayMs);
    // The original recovered delivery owns ordinary retry failure settlement.
    // Incident disposition can resolve before generic/queued guidance finishes.
    if (agent.handle !== null) this.recoveryDeliveries.get(agent.handle)?.classifications.push(retryDelivery);
    return true;
  }

  /** Wait out the backoff, then re-deliver the captured prompt on the SAME
   * live session. Adapters report model failures in-band (the prompt may
   * resolve while the turn errored), so an attempt's outcome is read from
   * the failure counter, not from the promise alone; a rejection with no
   * event signal is classified directly. */
  private async deliverRateLimitRetry(
    agent: SupervisedAgent,
    incident: RateLimitRetryIncident,
    delayMs: number,
  ): Promise<void> {
    let retryLease: PacingLease | null = null;
    let failure: string | null = null;
    try {
      await this.sleep(delayMs);
      // The incident may have been superseded (recovery, replacement,
      // shutdown) while we waited — the identity check is the cancellation.
      if (this.disposed || agent.rateLimitRetry !== incident) return;
      if (this.agents.get(agent.agentId) !== agent) return;
      if (incident.pending.directive !== undefined) {
        surfaceDirectiveRecovery({ ledger: this.ledger, notifications: this.notifications }, incident.pending.directive.identity.requestId, 'provider retry cannot replay a consumed native directive; inspect its checkpoint');
        this.clearRateLimitRetry(agent, 'superseded');
        return;
      }
      const handle = agent.handle;
      if (handle === null || agent.breakerOpen) {
        this.clearRateLimitRetry(agent, 'superseded');
        return;
      }
      // The captured turn must still match the current native authority
      // across every await: a newer rebrief or directive during the backoff
      // window supersedes this incident, and its prompt must never be
      // re-delivered on the old handle (the same fence the absorb path and
      // every restart await apply).
      if (!this.recoveryAuthorityCurrent(agent, incident.recovery)) {
        this.clearRateLimitRetry(agent, 'superseded');
        // The flight-replay path installs this exact object as
        // pendingRecovery; superseding the incident must consume that same
        // ownership or it strands as a permanent pending-recovery blocker.
        if (agent.pendingRecovery === incident.recovery) agent.pendingRecovery = null;
        return;
      }
      if (agent.role === 'minion' && this.workerGate !== undefined) {
        retryLease = await this.workerGate.acquireWorkerTurn({
          id: agent.agentId, label: `rate-limit retry → ${agent.agentId}`, agentId: agent.agentId,
          jobId: this.ledger.getAgent(agent.agentId)?.jobId ?? null,
          signal: incident.admissionAbort.signal,
        });
        if (this.disposed || agent.rateLimitRetry !== incident || this.agents.get(agent.agentId) !== agent) return;
        // Admission waited on the gate: the authority fence must be re-checked
        // again here, after the awaited admission.
        if (!this.recoveryAuthorityCurrent(agent, incident.recovery)) {
          this.clearRateLimitRetry(agent, 'superseded');
          // Same exact-ownership consumption as the pre-admission fence.
          if (agent.pendingRecovery === incident.recovery) agent.pendingRecovery = null;
          return;
        }
      }
      // Defensive: a scheduled rung must never start while another delivery
      // is still in flight. Its settlement owns the next transition.
      if (incident.awaitingDelivery) {
        this.log('error', 'rate-limit retry rung refused: a delivery is still in flight', {
          agent_id: agent.agentId,
          attempt: incident.attempts,
        });
        return;
      }
      incident.deliveryToken += 1;
      const deliveryToken = incident.deliveryToken;
      incident.activeDelivery = deliveryToken;
      incident.awaitingDelivery = true;
      const failureSeqAtDelivery = incident.failureSeq;
      this.log('info', 'delivering automatic rate-limit retry', {
        agent_id: agent.agentId,
        attempt: incident.attempts,
        owner: incident.pending.owner,
      });
      let rejection: unknown = null;
      try {
        // Delivery truth (#160): a retry that RESOLVES is not a recovery
        // unless the re-delivered turn itself attests success. The verdict
        // is captured per turn; an aborted/unknown/in-band-error settle is
        // a failed attempt and falls to the existing failure ladder below.
        const verdict = await promptWithTerminalVerdict(handle, incident.pending.text, {
          ...(incident.pending.owner !== null ? { owner: incident.pending.owner } : {}),
          ...(incident.pending.images !== undefined ? { images: incident.pending.images } : {}),
        });
        if (!verdict.ok) {
          rejection = new Error(verdict.error ?? 'runtime settled the retry turn with an in-band error');
        }
      } catch (error) {
        rejection = error;
      }
      // Issue #339: this retry turn actually started. Observe its session at
      // its PHYSICAL prompt-completion boundary, BEFORE any logical-disposition
      // or supersession check can return. `clearRateLimitRetry` resolves the
      // incident's logical disposition immediately on supersession/shutdown
      // without awaiting this running prompt, so a logical settlement is never
      // a physical transcript snapshot; a scan tied only to it (or to the
      // recovered turn's bookkeeping authority) would miss a prohibited read
      // appended by this retry.
      this.observeBlindTurnAccess(agent.agentId, handle);
      if (rejection !== null) failure = String(rejection);
      if (agent.rateLimitRetry !== incident) return; // superseded mid-flight
      if (incident.activeDelivery !== deliveryToken) {
        // A newer rung owns the incident now; this stale settlement must
        // not clear its flag, swallow its failure, or claim recovery.
        this.log('warn', 'stale rate-limit retry delivery settled after a newer rung started', {
          agent_id: agent.agentId,
          attempt: incident.attempts,
        });
        return;
      }
      incident.awaitingDelivery = false;
      incident.activeDelivery = null;
      if (incident.failureSeq !== failureSeqAtDelivery) {
        // The attempt failed; its error event already scheduled the next
        // rung — or spent the budget and handed off to the ladder.
        return;
      }
      if (rejection === null) {
        this.recordEvent('pacing.auto-retry-recovered', agent.agentId, pacingRecoveredPayload(
          incident.attempts, incident.maxRetries,
        ));
        this.clearRateLimitRetry(agent, 'recovered');
        // Deferred rung errors transfer a distinct synchronous snapshot.
        // Consume only that exact ownership, never a newer interruption.
        if (agent.pendingRecovery === incident.recovery) agent.pendingRecovery = null;
        this.log('info', 'automatic rate-limit retry recovered the turn', {
          agent_id: agent.agentId,
          attempts: incident.attempts,
        });
        return;
      }
      const text = String(rejection);
      const policy = this.rateLimitBackoff;
      if (policy !== null && isRateLimitErrorText(text, policy.patterns)) {
        incident.failureSeq += 1;
        incident.lastError = text;
        if (this.scheduleRateLimitRetry(agent, incident)) return;
      } else if (rejection instanceof WorkerDisposalInProgressError || handle.health().state === 'disposed') {
        // The session went away under the retry (typed disposal handshake or
        // a persisted disposed state): no failure to ladder, no retry to
        // continue. Arbitrary text containing 'disposed' must NOT land here —
        // a genuine non-rate-limit failure keeps its stop/escalation path.
        failure = null; // Disposal cancellation is not a failed startup turn.
        this.clearRateLimitRetry(agent, 'superseded');
        this.log('warn', 'rate-limit retry delivery ended on a disposed session', {
          agent_id: agent.agentId,
          attempt: incident.attempts,
        });
        return;
      } else {
        this.clearRateLimitRetry(agent, 'exhausted');
      }
      // No adapter event surfaced this failure (or the budget is spent):
      // the existing recovery ladder still owns it.
      incident.classifications.push(this.evaluateRecovery(agent, `runtime error: ${text}`, false, true));
    } catch (error) {
      if (agent.rateLimitRetry !== incident || this.disposed) return;
      failure = String(error);
      this.clearRateLimitRetry(agent, 'exhausted');
      this.log('error', 'rate-limit retry delivery failed internally', { agent_id: agent.agentId, error: String(error) });
      incident.classifications.push(this.evaluateRecovery(agent, `rate-limit retry failed: ${String(error)}`, false, true));
    } finally {
      retryLease?.release();
      if (failure !== null && incident.startupHandle !== null) {
        await Promise.all(incident.classifications);
        this.settleFailedStartupRetry(agent, incident, failure);
      }
    }
  }

  private settleFailedStartupRetry(agent: SupervisedAgent, incident: RateLimitRetryIncident, failure: string): void {
    if (this.disposed || this.agents.get(agent.agentId) !== agent || agent.handle !== incident.startupHandle) return;
    if (agent.pendingRecovery !== incident.recovery || !this.recoveryAuthorityCurrent(agent, incident.recovery)) return;
    if (agent.inRestart || agent.breakerOpen || agent.rateLimitRetry !== null || agent.recoveryAdmission !== null ||
      agent.decisionPending || agent.queuedRecovery !== null || agent.openTurn || agent.openControl || agent.openToolCalls.size > 0) return;
    agent.pendingRecovery = null;
    this.postOrphanedTurn(incident.recovery.originAgentId, 'automatic startup retry failed', failure);
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
    agent.stopReason = 'review aborted';
    agent.stoppedAt = this.now();
    this.rememberStop(agent);
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
   * burning rungs: a known wall stops before any decision is asked (#492). */
  private async evaluateRecovery(
    agent: SupervisedAgent,
    reason: string,
    allowRestart = true,
    runtimeError = false,
    source: ProviderErrorSource | null = null,
    recovery: InterruptedTurn | null = null,
  ): Promise<void> {
    // Recovery guidance supersedes an in-flight automatic retry. Only an
    // actual stop/restart also transfers restart-delivery admission custody;
    // generic nonfatal guidance must leave its failed delivery to settle.
    this.clearRateLimitRetry(agent, 'superseded');
    // A generic nonfatal classification alone transfers no custody. Its
    // failed delivery still owns settlement until stop/restart actually wins.
    if (allowRestart) this.clearRecoveryAdmission(agent);
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
        this.stopForGuidance(agent, deterministicClass, source, recovery);
      } else if (allowRestart) {
        await this.restartRung(agent, reason);
      }
      return;
    }
    if (deterministicWall && !agent.breakerOpen && !agent.inRestart && agent.handle !== null) {
      // A known wall stops now, before any decision is awaited or queued
      // behind a pending one (#492): no answer can change its action
      // (supervisionGuidance stops on a wall unconditionally), and a
      // directive's recovery can dispose the handle while one is pending,
      // which left the stale answer to void the stop.
      try {
        this.ledger.appendCustomEvent({
          kind: 'supervision.guidance',
          agentId: agent.agentId,
          payload: {
            class: deterministicClass,
            restart_advised: false,
            restart_authorized: false,
            source: 'deterministic_guard',
            route: 'fallback',
            requires_confirm: false,
          },
        });
      } catch (error) {
        // The stop is what matters; its guidance record is best-effort.
        this.log('error', 'supervision guidance record failed; stopping the known wall anyway', {
          agent_id: agent.agentId,
          error: String(error),
        });
      }
      this.stopForGuidance(agent, deterministicClass, source, recovery);
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
        source,
        recovery,
        handle: agent.handle,
        activityGeneration: agent.activityGeneration,
        openTurn: agent.openTurn,
        openControl: agent.openControl,
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
    const expectedOpenControl = agent.openControl;
    const request = supervisionDecisionRequest({
      reason,
      agentId: agent.agentId,
      role: agent.role,
      restartCount: agent.restartRing.length,
      breakerLimit: this.cfg.maxRestarts,
    });
    try {
      const outcome = await this.decisions.decide(request, { surface: DECISION_SURFACE_SUPERVISION });
      // The entity may have been stopped/disposed/replaced while Jev was
      // answering. A stale answer never starts a restart. A SILENCE
      // decision is additionally voided once native compaction opened:
      // its silence evidence predates the compaction and must never kill
      // it (compaction_start also bumps the activity generation; the
      // openControl check states the contract explicitly).
      if (
        this.disposed ||
        this.agents.get(agent.agentId) !== agent ||
        agent.handle !== expectedHandle ||
        agent.activityGeneration !== expectedActivityGeneration ||
        (!runtimeError && agent.openTurn !== expectedOpenTurn) ||
        (!runtimeError && agent.openControl !== expectedOpenControl) ||
        agent.breakerOpen
      ) return;
      // The class, advice, authorization and next action are decided by
      // supervisionGuidance — shared with shadow telemetry so a recorded
      // disagreement means this code would have acted differently.
      const { failureClass, restartAdvised, restartAuthorized, action } =
        supervisionGuidance(request.fallback, outcome, deterministicClass);
      const restartRoute = outcome.routes.restart_advised;
      this.ledger.appendCustomEvent({
        kind: 'supervision.guidance',
        agentId: agent.agentId,
        payload: {
          class: failureClass,
          restart_advised: restartAdvised,
          restart_authorized: restartAuthorized,
          source: outcome.provenance.source,
          route: restartRoute.path,
          requires_confirm: restartRoute.requiresConfirm,
        },
      });
      if (action.kind === 'stop') {
        this.stopForGuidance(agent, action.reason, source, recovery);
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
        (runtimeError || agent.openControl === expectedOpenControl) &&
        !agent.breakerOpen
      ) {
        // A known wall never reaches a decision (it stopped above).
        if (allowRestart) await this.restartRung(agent, reason);
      }
    } finally {
      agent.decisionPending = false;
      agent.failureTerminalPending = false;
      const queued = agent.queuedRecovery;
      agent.queuedRecovery = null;
      const queuedTurnStillMatches =
        queued?.runtimeError === true ||
        (queued?.openTurn === agent.openTurn && queued?.openControl === agent.openControl);
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
        // Replay the newest queued trigger INSIDE this classification's
        // lifecycle: a failed recovered delivery awaits the classification
        // promises, and a still-running (or newly queued) replay must stay in
        // that custody. A fire-and-forget replay would let settlement observe
        // `decisionPending` and give up, silently dropping the turn's orphan
        // notice and leaving a phantom pending-recovery blocker.
        const replay = this.evaluateRecovery(agent, queued.reason, queued.allowRestart, queued.runtimeError, queued.source, queued.recovery);
        if (agent.handle !== null) this.recoveryDeliveries.get(agent.handle)?.classifications.push(replay);
        await replay;
      }
    }
  }

  /** Known futile retry walls stop once and require the existing human ack
   * re-arm path; they never burn the restart ring blindly. Wall stops are
   * ALSO reported to the provider-recovery sink (when wired): the sink
   * alone decides whether the stop is an eligible temporary provider wait
   * — the supervisor's stop semantics are identical either way. */
  private stopForGuidance(
    agent: SupervisedAgent,
    failureClass: string,
    source: ProviderErrorSource | null = null,
    recovery: InterruptedTurn | null = null,
  ): void {
    if (agent.breakerOpen) return;
    this.clearRecoveryAdmission(agent);
    agent.breakerOpen = true;
    agent.state = 'stopped';
    agent.stopReason = failureClass;
    agent.stoppedAt = this.now();
    this.rememberStop(agent);
    const handle = agent.handle;
    const recaptured = this.captureInterruptedTurn(handle, agent);
    // Deferred replay carries the exact native-turn snapshot after adapter
    // subscribers have cleared pendingTurn. Only that authority-current
    // canonical turn may strengthen a weak recapture, never an older turn.
    const canonical = recovery !== null && this.recoveryAuthorityCurrent(agent, recovery) ? recovery : null;
    const pending = recaptured?.pending;
    const usableRecapture = pending != null &&
      (pending.text.trim() !== '' || (pending.images !== undefined && pending.images.length > 0));
    const captured = usableRecapture ? recaptured : canonical ?? recaptured;
    if (captured !== null) agent.pendingRecovery = captured;
    agent.openTurn = false;
    agent.openControl = false;
    agent.openToolCalls.clear();
    agent.handle = null;
    this.ledger.appendCustomEvent({
      kind: 'supervision.escalated',
      agentId: agent.agentId,
      payload: { class: failureClass, restarts: agent.restartRing.length },
    });
    const ledgerAgent = this.ledger.getAgent(agent.agentId);
    const observation = {
      agentId: agent.agentId,
      role: agent.role,
      slotId: agent.slot?.id ?? null,
      jobId: ledgerAgent?.jobId ?? null,
      sessionFile: agent.sessionFile,
      failureClass,
      source,
      continuation: captured === null
        ? null
        : {
            promptText: captured.pending?.text ?? null,
            promptOwner: captured.pending?.owner ?? null,
            hadOpenTurn: captured.hadOpenTurn,
          },
    } as const;
    // r1 #2 (phase3) + owner release 2026-10-11: decide MACHINE ownership
    // BEFORE any attention row. The sink persists the eligible wait first.
    // Either way the row is MACHINE attention (action-required, wakes Gru):
    // an eligible wait is owned by the recovery sensor, and an ineligible
    // or failed classification is a decision beyond Silas — Gru determines
    // the direction and asks the owner only if a reserved authority/cost
    // boundary is genuinely involved. Blind restart stays withheld in both
    // cases; the owner bell is never rung by a provider stop.
    const postStopNotice = (machineOwned: boolean) => {
      const notification = this.notifications.postIncident({
        kind: `supervision.provider-wall.${agent.agentId}.${failureClass}`,
        routing: 'action-required',
        severity: 'error',
        title: `Agent ${agent.agentId} stopped: ${failureClass.replaceAll('_', ' ')}`,
        detail: machineOwned
          ? 'Machine-owned temporary provider limit: the recovery sensor owns this stop (no owner ACK required).'
          : 'Blind restart is withheld: this provider stop is not eligible for automatic recovery. ' +
            'Gru decides the direction (fix the provider condition, wait, or escalate a reserved ' +
            'authority/cost decision) before anything re-arms.',
        agentId: agent.agentId,
        dedupe: 'unacked',
      });
      agent.breakerNotificationId = notification.id;
      this.rememberStop(agent);
      if (machineOwned) {
        this.providerWalls?.linkProviderWaitIncident?.({ agentId: agent.agentId, incidentId: notification.id });
      }
      return notification;
    };
    const sink = this.providerWalls;
    if (sink?.ownsProviderWall !== undefined) {
      void sink
        .ownsProviderWall({ ...observation })
        .then((machineOwned) => {
          postStopNotice(machineOwned);
          this.onProviderWallObserved(observation, machineOwned);
        })
        .catch(() => {
          // Classification failure: no unsafe retry — Gru triages.
          postStopNotice(false);
          this.onProviderWallObserved(observation, false);
        });
    } else {
      postStopNotice(false);
      this.onProviderWallObserved(observation, false);
    }
    if (handle !== null) {
      void this.registry.disposeHandle(handle).catch((error: unknown) => {
        this.log('warn', 'dispose after provider-wall escalation failed', {
          agent_id: agent.agentId,
          error: String(error),
        });
      });
    }
  }

  /** The observation report to the sensor sink (fire-and-forget observer). */
  private onProviderWallObserved(
    observation: {
      readonly agentId: string;
      readonly role: Role;
      readonly slotId: string | null;
      readonly jobId: string | null;
      readonly sessionFile: string | null;
      readonly failureClass: string;
      readonly source: ProviderErrorSource | null;
      readonly continuation: { readonly promptText: string | null; readonly promptOwner: string | null; readonly hadOpenTurn: boolean } | null;
    },
    machineOwned: boolean,
  ): void {
    if (this.providerWalls === null) return;
    try {
      if (machineOwned) return; // wait already persisted by ownsProviderWall
      this.providerWalls.onProviderWall({
        ...observation,
        incidentId: null,
      });
    } catch (error) {
      this.log('error', 'provider-wall sink failed', { agent_id: observation.agentId, error: String(error) });
    }
  }

  /** One restart rung. Single-flight per agent: a later trigger while a
   * rung is executing is absorbed (the rung's spawn IS the recovery).
   * Supervision NEVER takes the service down: any internal throw is
   * caught, logged, and the rung settles. */
  private async restartRung(
    agentRef: SupervisedAgent,
    reason: string,
    opts: RestartRungOptions = {},
  ): Promise<void> {
    const agent = agentRef;
    if (this.disposed || !this.cfg.enabled || agent.inRestart || agent.breakerOpen ||
      this.agents.get(agent.agentId) !== agent) return;
    if (this.unprovenPredecessor(agent) !== null) {
      // A retained unproven predecessor owns the entity (F60-P2): no rung —
      // automatic, retry, ack-rearm or provider-rearm — may spawn a
      // replacement against a maybe-live session. The debt stays visible.
      agent.state = 'stopped';
      return;
    }
    const recovery = agent.pendingRecovery ?? this.captureInterruptedTurn(agent.handle, agent);
    if (recovery !== null) agent.pendingRecovery = recovery;
    if (opts.rearmFence === true) {
      // The notification-driven re-arm re-proves the full fence set here:
      // parking, holds, active writers/reviews, provider waits and the epoch
      // all refuse instead of being bypassed by the disposition path.
      const refusal = this.rearmRefusal(agent, recovery);
      if (refusal !== null) {
        this.fenceRearm(agent, opts.rearmNotificationId ?? null, refusal);
        return;
      }
    } else if (!this.recoveryAuthorityCurrent(agent, recovery)) return;
    if (agent.handle?.reviewIsolation === true) {
      this.abortIsolatedReviewAttempt(agent, reason);
      return;
    }
    agent.inRestart = true;
    const flight: RestartFlight = { authority: null, handle: null, publish: null, unsubscribe: null,
      superseded: false, pendingError: null, pendingErrorSource: null, pendingErrorSnapshot: null,
      turnGeneration: 0, openTurn: null, errorTurnGenerations: new WeakMap() };
    this.restartingAgents.set(agent, flight);
    agent.state = 'restarting';
    try {
      flight.authority = recovery ?? this.captureJobAuthority(this.ledger.getAgent(agent.agentId)?.jobId ?? null, agent.agentId);
      await this.restartRungInner(agent, reason, opts);
    } catch (error) {
      // A supervision bug or ledger hiccup must never kill the service
      // (unhandled rejections are fatal in main). An accepted re-arm is
      // different: if the guarded rung fails before retry scheduling, restore
      // the stop with a fresh control instead of reporting a watching lane.
      if (opts.rearmFence === true) {
        this.fenceRearm(agent, opts.rearmNotificationId ?? null, `restart rung failed: ${String(error)}`);
      } else {
        agent.state = agent.breakerOpen ? 'stopped' : 'watching';
      }
      this.log('error', 'restart rung threw — settling', {
        agent_id: agent.agentId,
        reason,
        error: String(error),
      });
    } finally {
      agent.inRestart = agent.backoffTimer !== null;
      if (agent.state === 'restarting' && agent.backoffTimer === null) agent.state = 'watching';
      flight.unsubscribe?.();
      this.restartingAgents.delete(agent);
      const handle = flight.handle;
      const current = handle === null ? undefined : this.agents.get(handle.id);
      if (!this.disposed && handle !== null && current?.handle === handle && !current.breakerOpen && flight.pendingError !== null) {
        const sourceEvent = flight.pendingErrorSource ?? flight.pendingError;
        const selectedSnapshot = flight.errorTurnGenerations.get(sourceEvent) === flight.turnGeneration
          ? this.restartErrorSnapshots.get(sourceEvent) : undefined;
        const snapshot = selectedSnapshot?.pending != null ? selectedSnapshot : flight.pendingErrorSnapshot ?? selectedSnapshot;
        if (snapshot !== undefined) {
          this.restartErrorSnapshots.set(flight.pendingError, snapshot);
          const delivery = this.recoveryDeliveries.get(handle);
          const source = this.restartSnapshotSources.get(snapshot);
          if (source !== undefined && delivery?.errors.has(source)) delivery.snapshots.add(snapshot);
          current.pendingRecovery = snapshot;
        }
        // A startup error replayed here may take its own custody (fatal
        // restart, provider wall, or bounded retry). A plain generic error
        // takes none: settle the retained recovery after the classification
        // concludes, or the interrupted turn strands behind a phantom
        // pending-recovery blocker and is never resumed or visibly orphaned.
        const replayed = this.onEnvelope({ handle, agentId: handle.id, role: handle.role, sessionFile: handle.sessionFile,
          phase: 'event', event: flight.pendingError });
        if (replayed !== null) {
          void replayed
            .then(() => this.settleStrandedStartupRecovery(current, handle, reason))
            .catch((error: unknown) => { this.log('error', 'stranded startup recovery settlement failed', { agent_id: handle.id, error: String(error) }); });
        }
      }
    }
  }

  private async restartRungInner(
    agentRef: SupervisedAgent,
    reason: string,
    opts: RestartRungOptions = {},
  ): Promise<void> {
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
      // registry set drops it; the tap reports the disposal). Snapshot the
      // open turn FIRST: a killed turn must be resumed or visibly orphaned,
      // never silently dead (E7 false-positive follow-up).
      const old = agent.handle;
      this.clearRecoveryAdmission(agent);
      const captured = this.captureInterruptedTurn(old, agent);
      if (captured !== null) agent.pendingRecovery = captured;
      const interruptedDirective = agent.pendingRecovery?.pending?.directive;
      // Capture original ownership before disposal can await or re-associate
      // the logical row. No cleanup fulfillment/row mutation proves cessation.
      if (old !== null && interruptedDirective !== undefined && !this.retainedDirectiveProducers.has(old)) {
        this.retainedDirectiveProducers.set(old, interruptedDirective.identity.jobId);
      }
      // Exact-handle filtering now ignores the retiring object's tap once
      // detached. Conclude its retry explicitly before dropping its handle.
      this.clearRateLimitRetry(agent, 'superseded');
      agent.handle = null;
      agent.openTurn = false;
      agent.openControl = false;
      agent.openToolCalls.clear();
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

      if (interruptedDirective !== undefined) {
        const requestId = interruptedDirective.identity.requestId;
        if (old === null || !this.restartCessationConfirmed(old)) {
          agent.handle = old;
          agent.state = 'stopped';
          this.log('error', 'directive cleanup has unknown cessation — explicit supervisor ownership retained', { agent_id: agent.agentId, request_id: requestId });
          surfaceDirectiveRecovery({ ledger: this.ledger, notifications: this.notifications }, requestId, 'supervisor cleanup retains unknown producer ownership');
          return;
        }
        if (old !== null) this.retainedDirectiveProducers.delete(old); // positive original physical cessation
        if (agent.pendingRecovery?.pending?.directive === interruptedDirective) agent.pendingRecovery = null;
        agent.state = 'watching';
        surfaceDirectiveRecovery({ ledger: this.ledger, notifications: this.notifications }, requestId, 'supervisor ceased the interrupted turn; service must inspect native completion/checkpoint, never replay');
        return;
      }
      if (!this.recoveryAuthorityCurrent(agent, agent.pendingRecovery)) return;
      if (restartSlot !== null && restartSlot.generation !== restartGeneration) return;

      if (opts.rearmFence === true) {
        // Fences are re-proved AFTER the awaits: a parking hold, live
        // directive/re-brief/review writer, provider wait or newer epoch that
        // appeared while the old handle was being disposed must refuse the
        // respawn and keep the stop visible (retryable via supported
        // controls), never replay a saved prompt across it.
        const refusal = this.rearmRefusal(agent, agent.pendingRecovery);
        if (refusal !== null) {
          this.fenceRearm(agent, opts.rearmNotificationId ?? null, refusal);
          return;
        }
      }

      // Issue #161: the owning subsystem may specialize or refuse a restart
      // (a child worker must come back in ITS lane with ITS bounded tools —
      // the default role spawn would widen a read-only child to writing and
      // move it out of its worktree).
      const policy = this.restartPolicyFor(agent.agentId, agent.role);
      if (policy !== undefined && 'refuse' in policy) {
        agent.state = 'stopped';
        agent.stoppedAt = this.now();
        this.log('warn', 'agent restart refused by its owning subsystem', {
          agent_id: agent.agentId,
          reason: policy.refuse,
        });
        return;
      }

      // Option A / single-writer (F60-P2): an eligible ORDINARY session must
      // never resume or replace its predecessor while that predecessor's stop
      // is unproven. Lock release and native/active-file retirement are NOT
      // cessation; only the adapter's own 'ceased' evidence is. This gate is
      // scoped to exactly the ordinary path — isolated reviews were handled
      // above and tracked children were refused above, both before it.
      if (old !== null && adapterCessationEvidence(old) !== 'ceased') {
        // Retain the EXACT predecessor handle in ordinary custody so every
        // later ensure/rearm/retry re-checks the SAME unresolved proof
        // (F60-P2) — a null handle or breaker reset cannot bypass it.
        this.retainUnprovenPredecessor(agent, old, reason);
        agent.state = 'stopped';
        agent.stoppedAt = this.now();
        agent.stopReason = 'restart refused: predecessor stop unproven';
        this.ledger.appendCustomEvent({
          kind: 'supervision.restart-unproven-stop',
          agentId: agent.agentId,
          payload: {
            reason,
            predecessorAgentId: old.id,
            note: 'predecessor disposal did not prove cessation — no replacement or resume was spawned; the unresolved stop remains debt',
          },
        });
        this.log('warn', 'restart blocked — predecessor cessation unproven', {
          agent_id: agent.agentId,
          predecessor: old.id,
          reason,
        });
        return;
      }

      // Snapshot the explicit durable association BEFORE spawning: the tap
      // carries no job context and a resumed spawn may reuse this row's id.
      const predecessor = this.ledger.getAgent(agent.agentId);
      const flight = this.restartingAgents.get(agent)!;
      const restartAuthority = flight.authority!;
      // Respawn with resume (crash = resume, SPEC ruling 3).
      const resumeFile = agent.sessionFile;
      try {
        // A transient ledger fault inside captureJobAuthority leaves the
        // captured job authority unreadable (null epoch) with a non-null job
        // id. Every post-spawn fence would reject such a replacement, so
        // refuse BEFORE the destructive spawn: throwing fails the rung
        // retryably with backoff instead of spawn-then-dispose churn with no
        // retry. (A captured turn with an unreadable authority never reaches
        // here — the rung's entry fence already returned.)
        if (restartAuthority.jobId !== null && restartAuthority.authorityEpoch === null) {
          throw new Error('captured job authority is unreadable; refusing replacement spawn');
        }
        // SPEC ruling 17: a minion resumes in the job lane it serves (which
        // also keeps the lane's bound BMAD runtime, issue #283), unless its
        // owning subsystem's policy names the cwd itself.
        const laneCwd = agent.role === 'minion' ? this.jobLanePath(agent.agentId) : undefined;
        const spawnOptions = stageSpawnRegistration({
          ...(resumeFile !== null ? { resumeFile } : {}),
          ...(laneCwd !== undefined ? { cwd: laneCwd } : {}),
          ...(policy !== undefined && 'options' in policy ? policy.options : {}),
        }, (handle, publish) => {
          flight.handle = handle;
          flight.publish = publish;
          flight.unsubscribe = handle.subscribe((event) => {
            if (event.type === 'turn_start') {
              flight.turnGeneration += 1;
              flight.openTurn = true;
              flight.pendingErrorSnapshot = null;
            } else if (event.type === 'turn_end') {
              flight.openTurn = false;
            }
            if (event.type !== 'error') return;
            flight.errorTurnGenerations.set(event, flight.turnGeneration);
            try {
              // Fresh-ID carry-over leaves agentRef detached. Capture job and
              // native open-turn truth from the exact current controller, or
              // from raw turn frames while publication is still held.
              const current = this.agents.get(handle.id);
              const controller = current?.handle === handle ? current : agentRef;
              const snapshot = this.captureInterruptedTurn(handle, controller,
                (flight.openTurn ?? controller.openTurn) || controller.openControl);
              if (snapshot !== null) {
                this.restartErrorSnapshots.set(event, snapshot);
                this.restartSnapshotSources.set(snapshot, event);
                if (snapshot.pending !== null || flight.pendingErrorSnapshot === null) flight.pendingErrorSnapshot = snapshot;
              }
            } catch (error) {
              this.log('error', 'held restart error snapshot failed', { agent_id: handle.id, error: String(error) });
            }
          });
        });
        const spawned =
          restartSlot !== null
            ? await restartSlot.spawn(spawnOptions)
            : await this.registry.spawn(agent.role, spawnOptions);
        flight.handle = spawned;
        if (
          this.disposed ||
          !this.recoveryAuthorityCurrent(agent, agent.pendingRecovery) ||
          (restartSlot !== null &&
            (this.slots.get(restartSlot.id) !== restartSlot ||
              restartSlot.generation !== restartGeneration))
        ) {
          // Shutdown, release, or an intentional fresh replacement won while
          // this restart was in flight. Dispose the stale result and never
          // adopt it or notify swap listeners.
          await this.rejectRestartReplacement(agent, spawned, reason, restartAuthority);
          return;
        }
        // No tap consumer or dispatch lookup has seen the held result.
        // Refuse before publication, binding, adoption, swaps or delivery.
        if (flight.superseded) {
          await this.rejectRestartReplacement(agent, spawned, reason, restartAuthority);
          return;
        }
        if (opts.rearmFence === true) {
          // The last await is the spawn itself: a hold admitted while the
          // start was in flight disposes the fresh handle UNUSED — never
          // adopt, never replay the recovered prompt across it.
          const refusal = this.rearmRefusal(agent, agent.pendingRecovery);
          if (refusal !== null) {
            // Same exact custody as every rejected replacement (issue #280):
            // quarantine, cleanup journal, audit and the unconfirmed-cleanup
            // owner notice on a failed disposal. The controller stays retryable.
            await this.rejectRestartReplacement(agent, spawned, reason, restartAuthority, false);
            this.fenceRearm(agent, opts.rearmNotificationId ?? null, refusal);
            return;
          }
        }
        if (flight.superseded || !this.recoveryAuthorityCurrent(agent, restartAuthority)) {
          await this.rejectRestartReplacement(agent, spawned, reason, restartAuthority);
          return;
        }
        if (predecessor !== null) {
          try {
            this.ledger.registerAgent({
              id: spawned.id,
              role: predecessor.role,
              label: predecessor.label,
              jobId: predecessor.jobId,
              roundId: predecessor.roundId,
              sessionFile: spawned.sessionFile,
            });
          } catch (error) {
            // Never recover a prompt on a replacement whose known ownership
            // could not be recorded; the existing ladder reports/retries it.
            // Route the unbound replacement through the SAME exact cleanup
            // custody as every rejected replacement (issue #280): a disposal
            // rejection must leave a quarantined, fenced producer with durable
            // debt and a needs-owner notice, never an unaccounted hidden one.
            // This is NOT supersede custody — the controller stays retryable
            // and the rung still fails to the ladder — so a dispose hiccup is
            // reported without masking the actionable binding error (mirrors
            // the stale-result path above).
            const cleanupError = await this.rejectRestartReplacement(agent, spawned, reason, restartAuthority, false);
            if (cleanupError !== null) {
              this.log('warn', 'dispose of the unbound replacement failed — the binding error is preserved', {
                agent_id: spawned.id,
                error: cleanupError,
              });
            }
            throw error;
          }
        }
        this.adopt(spawned, restartSlot, resumeFile);
        // A resumed session keeps its id; a fresh mint does NOT — the
        // supervision history (ring, breaker, slot binding) follows the
        // supervised ENTITY, never the session id.
        agent = this.carryOverSupervision(agent, spawned.id);
        agent.consecutiveFailures = 0;
        agent.state = 'watching';
        flight.publish?.();
        // Synchronous observers may have installed a newer controller/stop.
        if (agent.breakerOpen && this.agents.get(spawned.id) === agent) return;
        if (flight.superseded || this.agents.get(spawned.id)?.handle !== spawned) {
          await this.rejectRestartReplacement(agent, spawned, reason, restartAuthority);
          return;
        }
        if (!this.recoveryAuthorityCurrent(agent, restartAuthority)) {
          await this.rejectRestartReplacement(agent, spawned, reason, restartAuthority);
          return;
        }
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
        // Resume (or visibly orphan) the turn this rung interrupted.
        if (flight.pendingError === null) this.recoverInterruptedTurn(agent, spawned, reason, opts);
      } catch (error) {
        if (flight.superseded || this.disposed || agent.breakerOpen || this.agents.get(agent.agentId) !== agent ||
          (restartSlot !== null && restartSlot.generation !== restartGeneration)) return;
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
          if (!this.disposed && !agent.breakerOpen && !flight.superseded && this.agents.get(agent.agentId) === agent &&
            (restartSlot === null || restartSlot.generation === restartGeneration)) {
            agent.inRestart = false;
            void this.restartRung(agent, reason, opts);
          }
        }, delay);
        agent.backoffTimer.unref?.();
        return;
      }
    } finally {
      // (the outer restartRung owns inRestart/state settlement)
    }
  }

  /** Dispose a replacement that no longer owns its captured job authority.
   * Registry tap adoption is neutral, not permission. Quarantine that
   * record before awaiting cleanup so its events cannot start another rung.
   * Disposal fulfillment and adapter-owned cessation proof are both required;
   * even a disposed event followed by rejection leaves ownership debt. */
  private async rejectRestartReplacement(
    agent: SupervisedAgent,
    spawned: AgentHandle,
    reason: string,
    authority: RecoveryAuthority,
    superseded = true,
  ): Promise<string | null> {
    const recovery = agent.pendingRecovery;
    // Captured before spawn: failed authority reads must not lose cleanup's job.
    const { jobId } = authority;
    const preserveController = agent.breakerOpen && this.agents.get(agent.agentId) === agent;
    const cleanup: RejectedRestartCleanup = { jobId, agent, recovery, preserveController, superseded,
      disposalAcknowledged: false, disposalFailed: false, redisposing: false, notificationId: null, debt: null, detach: () => {}, settling: false };
    this.rejectedRestartCleanup.set(spawned, cleanup);
    // A published-but-rejected replacement is already registry-gettable: its
    // publication preceded these post-spawn fences. Revoke that eligibility
    // synchronously, before the asynchronous disposal, so no directive-routing
    // or dispatch lookup can hand the refused producer new work even when the
    // disposal later rejects (#280 AC1).
    this.registry.quarantineHandle(spawned);
    const observeProof = (): void => {
      if (!cleanup.disposalAcknowledged) { this.redisposeRejectedReplacement(spawned, cleanup); return; }
      if (!this.restartCessationConfirmed(spawned)) return;
      try { this.settleRejectedRestartCleanup(spawned, cleanup); }
      catch (error) { this.log('error', 'restart cleanup proof persistence failed — custody retained', { agent_id: spawned.id, error: String(error) }); }
    };
    const detachSettlement = observeDisposalSettlement(spawned, (acknowledged) => {
      if (acknowledged) cleanup.disposalAcknowledged = true;
      observeProof();
    });
    const detachEvidence = spawned.subscribe((event) => { if (event.type === 'cessation_evidence') observeProof(); });
    cleanup.detach = () => { detachSettlement(); detachEvidence(); };
    // Supersede custody abandons the rejected controller. Unbound custody
    // (a failed binding whose rung still retries) must NOT mark it rejected —
    // the retry's fresh same-id adoption would evict and supersede itself.
    if (!preserveController && superseded) this.rejectedRestartControllers.add(agent);
    const observed = this.agents.get(spawned.id);
    if (observed?.handle === spawned) {
      this.clearRateLimitRetry(observed, 'superseded');
      this.clearRecoveryAdmission(observed);
      if (observed.backoffTimer !== null) clearTimeout(observed.backoffTimer);
      this.agents.delete(spawned.id);
    }
    // Mint the exact physical generation BEFORE the pending write so a failed
    // write keeps one binding: the fallback audit, any retry, and the receipt
    // all carry this SAME generation, while a same-id successor mints its own.
    const custody = this.cleanupJournal.claim(spawned, jobId, agent.agentId);
    const recordRejection = (disposition: string, error: string | null): boolean => {
      try {
        this.ledger.appendCustomEvent({ kind: 'supervision.restart-rejected', agentId: agent.agentId, jobId,
          payload: { reason, generation: custody.generation, origin_seq: cleanup.debt?.originSeq ?? null,
            replacement_agent_id: spawned.id, authority_epoch: authority.authorityEpoch, disposition,
            ...(error !== null ? { error } : {}) } });
        return true;
      } catch (failure) {
        this.log('warn', 'restart rejection audit could not be recorded — custody retained in memory', { agent_id: agent.agentId, error: String(failure) });
        return false;
      }
    };
    let fallbackRecorded = false;
    let journalError: string | null = null;
    try {
      // Journal physical custody before entering the asynchronous disposal.
      cleanup.debt = this.cleanupJournal.begin(spawned, jobId, agent.agentId);
    } catch (error) {
      // The pending-custody write failed. Physical custody stays in memory
      // (rejectedRestartCleanup + the pendingProducerBlockers retry); disposal
      // below must STILL run — a skipped disposal is an unaccounted, live
      // hidden producer.
      journalError = String(error);
      fallbackRecorded = recordRejection('cleanup-unjournaled', journalError);
    }
    let disposalError: string | null = null;
    try {
      await this.registry.disposeHandle(spawned);
      cleanup.disposalAcknowledged = true;
      if (!this.restartCessationConfirmed(spawned)) throw new Error('adapter-owned cessation evidence is unknown after disposal');
      this.settleRejectedRestartCleanup(spawned, cleanup);
    } catch (error) {
      disposalError = String(error);
      cleanup.disposalFailed = true;
      this.redisposeRejectedReplacement(spawned, cleanup);
    }
    // CURRENT custody, never the historical journal error, decides the outcome.
    // The disposal await can retry the pending write and fully settle custody
    // (`pendingProducerBlockers`), and a synchronous settlement observer can
    // settle too. If a failed first pending write survived in `cleanupError`,
    // the appended audit would point at an origin already confirmed and
    // dropped: replay would classify it as permanent generation-null debt and
    // block retirement of an acknowledged, proven-ceased replacement forever.
    // Both failures stay in the diagnostic instead of one masking the other.
    const settled = !this.rejectedRestartCleanup.has(spawned);
    const cleanupError = settled
      ? null
      : [journalError, disposalError].filter((value): value is string => value !== null).join('; ') || null;
    if (cleanupError !== null) {
      // Supersede custody stops the abandoned controller. Unbound custody
      // keeps it retryable, so the rung's failure ladder owns the state.
      if (!preserveController && superseded) {
        agent.state = 'stopped';
        agent.stopReason = `restart cleanup unconfirmed: ${spawned.id}`;
        agent.stoppedAt = this.now();
      }
      this.log('error', 'superseded restart replacement cleanup unconfirmed', {
        agent_id: agent.agentId,
        replacement_agent_id: spawned.id,
        job_id: jobId,
        error: cleanupError,
      });
    }
    // The early fallback already records this refusal. Its later exact receipt
    // settles it; another unconfirmed audit after that receipt would resurrect
    // obsolete custody once replay has dropped the pending origin.
    if (!fallbackRecorded) recordRejection(cleanupError === null ? 'disposed'
      : cleanup.debt !== null ? 'cleanup-unconfirmed' : 'cleanup-unjournaled', cleanupError);
    if (cleanupError !== null) {
      try {
        const notice = this.notifications.post({
          kind: 'supervision.restart-cleanup-unconfirmed',
          routing: 'needs-owner',
          severity: 'error',
          title: `Superseded minion ${spawned.id}: cleanup is unconfirmed`,
          detail: `Replacement ${spawned.id} for job ${jobId ?? '(unbound)'} was refused automatic recovery, but cleanup is unconfirmed: ${cleanupError}. ` +
            'Producer ownership remains unknown. Only the original native owner can persist acknowledgment and positive cessation proof. ' +
            'If that owner is lost in a hard crash, proof is unavailable: ACK, restart and successor cleanup cannot release custody. ' +
            (superseded
              ? 'No automatic restart is authorized.'
              : 'The owning restart rung still retries this binding after its backoff.'),
          agentId: agent.agentId,
        });
        cleanup.notificationId = notice.id;
        // A synchronous notice observer may have persisted proof before post
        // returned its ID. Presentation follows that already-durable receipt.
        if (!this.rejectedRestartCleanup.has(spawned)) this.ledger.resolveNotificationById(notice.id, 'supervision-cleanup-confirmed');
      } catch (error) {
        this.log('error', 'restart cleanup notification could not be posted', { agent_id: agent.agentId, error: String(error) });
      }
    }
    return cleanupError;
  }

  /** A rejected replacement whose disposal failed but whose adapter now
   * attests cessation (a Pi receipt written on a later query, #497) gets its
   * disposal re-run, so custody is acknowledged by a fulfilled disposal and
   * never assumed. Only after the supervisor's own disposal failed, and one
   * re-run at a time. */
  private redisposeRejectedReplacement(handle: AgentHandle, cleanup: RejectedRestartCleanup): void {
    if (!cleanup.disposalFailed || cleanup.disposalAcknowledged || cleanup.redisposing || this.rejectedRestartCleanup.get(handle) !== cleanup) return;
    if (!this.restartCessationConfirmed(handle)) return;
    cleanup.redisposing = true;
    void this.registry.disposeHandle(handle).then(() => {
      cleanup.disposalAcknowledged = true;
      if (!this.restartCessationConfirmed(handle)) return;
      try { this.settleRejectedRestartCleanup(handle, cleanup); }
      catch (error) { this.log('error', 'restart cleanup proof persistence failed — custody retained', { agent_id: handle.id, error: String(error) }); }
    }, (error: unknown) => {
      this.log('warn', 'restart cleanup re-disposal failed — custody retained', { agent_id: handle.id, error: String(error) });
    }).finally(() => { cleanup.redisposing = false; });
  }

  private restartCessationConfirmed(handle: AgentHandle): boolean {
    try { return handle.cessationEvidence?.() === 'ceased'; }
    catch (error) {
      this.log('warn', 'restart cessation evidence unavailable', { agent_id: handle.id, error: String(error) });
      return false;
    }
  }

  private settleRejectedRestartCleanup(handle: AgentHandle, cleanup: RejectedRestartCleanup): void {
    if (this.rejectedRestartCleanup.get(handle) !== cleanup || cleanup.settling) return;
    // Synchronous ledger subscribers can query custody during publication.
    // Neither recursive receipt writes nor failed writes may erase pending debt.
    cleanup.settling = true;
    try {
      cleanup.debt ??= this.cleanupJournal.begin(handle, cleanup.jobId, cleanup.agent.agentId);
      this.cleanupJournal.confirm(cleanup.debt);
    } finally { cleanup.settling = false; }
    cleanup.detach();
    this.rejectedRestartCleanup.delete(handle);
    const { agent, recovery, notificationId } = cleanup;
    // Supersede custody abandons the rejected controller once cleanup settles:
    // its obsolete recovery ownership and live record are released. Unbound
    // custody retains both — the rung's retry still owns the entity.
    if (cleanup.superseded) {
      if (!cleanup.preserveController && agent.pendingRecovery === recovery) agent.pendingRecovery = null;
      if (!cleanup.preserveController && this.agents.get(agent.agentId) === agent && agent.handle === null) this.agents.delete(agent.agentId);
    }
    if (notificationId !== null) {
      try {
        this.ledger.resolveNotificationById(notificationId, 'supervision-cleanup-confirmed');
      } catch (error) {
        this.log('warn', 'restart cleanup confirmation audit failed', { agent_id: handle.id, error: String(error) });
      }
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
    // Enforce the copy-site invariant breakerOpen => stopReason: a carried
    // open breaker keeps its recorded cause, a closed breaker carries none.
    // (Restart rungs never reach this path with an open breaker, but a
    // future adopter cannot silently violate the invariant; followup
    // review, carryOverSupervision.)
    adopted.stopReason = old.breakerOpen ? old.stopReason : null;
    adopted.stoppedAt = old.breakerOpen ? old.stoppedAt : null;
    adopted.breakerNotificationId = old.breakerNotificationId;
    adopted.pendingRearmFenceAlert = old.pendingRearmFenceAlert ?? null;
    // A turn interrupted by an earlier failed rung (or by the breaker
    // stop) still awaits resume on the next live handle.
    adopted.pendingRecovery = old.pendingRecovery;
    this.agents.delete(old.agentId);
    return adopted;
  }

  /** Snapshot an open turn before a restart kills it. */
  private captureInterruptedTurn(
    handle: AgentHandle | null,
    agent: SupervisedAgent,
    hadOpenTurn = agent.openTurn || agent.openControl,
  ): InterruptedTurn | null {
    if (handle === null) return null;
    let pending: PendingTurn | null = null;
    if (handle.pendingTurn !== undefined) {
      try {
        pending = handle.pendingTurn();
      } catch (error) {
        this.log('warn', 'pending-turn snapshot failed — the lane will be signalled instead', {
          agent_id: agent.agentId,
          error: String(error),
        });
      }
    }
    if (pending === null && !hadOpenTurn) return null;
    // A turn that already replied and only waited on background work was
    // not interrupted: there is no prompt to send again and no lost turn.
    if (pending === null && handle.turnAnswered?.() === true) return null;
    const jobId = this.ledger.getAgent(agent.agentId)?.jobId ?? null;
    return { pending, hadOpenTurn, originAgentId: agent.agentId, ...this.captureJobAuthority(jobId, agent.agentId) };
  }

  private nativeProducerIdentity(jobId: string): string {
    return JSON.stringify([
      this.ledger.listPendingRebriefs({ jobId }).map((row) => row.id).sort(),
      this.ledger.listPendingDirectives({ jobId, states: LIVE_DIRECTIVE_STATES }).map((row) => row.requestId).sort(),
      // Live sets can return to empty during spawn. Native acceptance and
      // completion history is monotonic and cannot restore spent permission.
      ...['silas.directive-intent', 'silas.rebrief', 'silas.rebrief-settled', 'silas.rebrief-retired']
        .map((kind) => this.ledger.latestJobEvent(jobId, kind)?.seq ?? 0),
    ]);
  }

  private captureJobAuthority(jobId: string | null, agentId: string): RecoveryAuthority {
    if (jobId === null) return { jobId, authorityEpoch: null, producerIdentity: null };
    try {
      return { jobId, authorityEpoch: this.ledger.directiveRecoveryEpoch(jobId), producerIdentity: this.nativeProducerIdentity(jobId) };
    } catch (error) {
      this.log('warn', 'interrupted turn authority unavailable — automatic recovery fenced', { agent_id: agentId, job_id: jobId, error: String(error) });
      return { jobId, authorityEpoch: null, producerIdentity: null };
    }
  }

  /** A notification ACK is not a new job authority handoff. Captured native
   * retirement AND request identities must survive every restart await. */
  private recoveryAuthorityCurrent(agent: SupervisedAgent, recovery: RecoveryAuthority | null): boolean {
    let jobId = recovery?.jobId ?? null;
    try {
      const currentJobId = this.ledger.getAgent(agent.agentId)?.jobId ?? null;
      if (recovery !== null && recovery.jobId !== currentJobId) return false;
      jobId = recovery?.jobId ?? currentJobId;
      if (jobId === null) return true;
      const job = this.ledger.getJob(jobId);
      if (job === null || isJobTerminal(job.status) || this.ledger.hasOpenDirectiveRecoveryHold(jobId)) return false;
      // No captured turn is not stale authority: an idle agent on a live,
      // unheld job takes its otherwise authorized restart/re-arm path even
      // when that job carries retirement/handoff history (issue #279). A
      // captured turn must still match the current native authority exactly —
      // a stale epoch or unreadable authority stays fenced.
      if (recovery === null) return true;
      const epoch = this.ledger.directiveRecoveryEpoch(jobId);
      const current = recovery.authorityEpoch === epoch &&
        recovery.producerIdentity === this.nativeProducerIdentity(jobId);
      if (!current) this.log('info', 'interrupted turn superseded — automatic recovery fenced', { agent_id: agent.agentId, job_id: jobId });
      return current;
    } catch (error) {
      this.log('warn', 'interrupted turn authority unavailable — automatic recovery fenced', { agent_id: agent.agentId, job_id: jobId, error: String(error) });
      return false;
    }
  }

  /** After a deferred restart replay's classification settles: if no stop,
   * restart, or bounded retry took custody of the retained turn, resume it on
   * the live handle or post its orphan notice. Without this a generic nonfatal
   * startup error leaves the turn behind a permanent pending-recovery blocker. */
  private settleStrandedStartupRecovery(agent: SupervisedAgent, handle: AgentHandle, reason: string): void {
    if (this.disposed || this.agents.get(agent.agentId) !== agent || agent.handle !== handle) return;
    if (agent.inRestart || agent.breakerOpen || agent.rateLimitRetry !== null || agent.recoveryAdmission !== null) return;
    if (agent.pendingRecovery === null) return;
    this.recoverInterruptedTurn(agent, handle, reason);
  }

  /**
   * After a successful restart rung: re-deliver the interrupted turn's
   * prompt on the resumed session, or — when the runtime could not name
   * it — post a durable action-required note naming job + branch + phase
   * so the lane is visibly recoverable, not archaeology.
   */
  private recoverInterruptedTurn(
    agent: SupervisedAgent,
    handle: AgentHandle,
    reason: string,
    opts: RestartRungOptions = {},
  ): void {
    const recovery = agent.pendingRecovery;
    if (recovery === null) return;
    if (opts.rearmFence === true) {
      const refusal = this.rearmRefusal(agent, recovery);
      if (refusal !== null) {
        this.fenceRecoveredHandle(agent, handle, opts.rearmNotificationId ?? null, refusal);
        return;
      }
    } else if (!this.recoveryAuthorityCurrent(agent, recovery)) return;
    if (opts.rearmFence !== true) agent.pendingRecovery = null;
    const laneAgentId = recovery.originAgentId;
    const pending = recovery.pending;
    if (pending?.directive !== undefined) {
      surfaceDirectiveRecovery({ ledger: this.ledger, notifications: this.notifications }, pending.directive.identity.requestId, 'native directive continuation belongs to the service checkpoint coordinator');
      return;
    }
    if (
      pending !== null &&
      (pending.text.trim() !== '' || (pending.images !== undefined && pending.images.length > 0))
    ) {
      this.recordEvent('supervision.turn-recovery', laneAgentId, {
        disposition: 'resume-attempted',
        reason,
        owner: pending.owner,
      });
      this.log('info', 're-delivering the interrupted turn on the restarted session', {
        agent_id: laneAgentId,
        reason,
        owner: pending.owner,
      });
      void this.deliverRecoveredTurn(agent, handle, laneAgentId, pending, reason, recovery, opts);
      return;
    }
    agent.pendingRecovery = null;
    this.postOrphanedTurn(
      laneAgentId,
      reason,
      pending === null
        ? 'the runtime did not expose the pending prompt'
        : 'the pending prompt was empty',
    );
  }

  /**
   * Deliver one interrupted turn on a restarted session under the same
   * worker admission cap as every other minion turn. With the cap occupied
   * the delivery waits FIFO and is cancelled cleanly when the attempt is
   * superseded; the lease is released unconditionally, including on
   * synchronous prompt faults. A rate-limited delivery keeps its lifecycle
   * pending until the bounded retry recovery concludes.
   */
  private async deliverRecoveredTurn(
    agent: SupervisedAgent,
    handle: AgentHandle,
    laneAgentId: string,
    pending: PendingTurn,
    reason: string,
    recovery: InterruptedTurn,
    opts: RestartRungOptions = {},
  ): Promise<void> {
    let lease: PacingLease | null = null;
    const controller = new AbortController();
    this.clearRecoveryAdmission(agent); // supersede any older recovery wait
    agent.recoveryAdmission = controller;
    // Issue #339: set once the recovered prompt is actually delivered to the
    // resumed session. From that point the session may hold tool results that
    // must be observed before this method returns, whatever the authority
    // state is at settle time.
    let turnStarted = false;
    const delivery: RecoveryDelivery = { retry: null, snapshots: new Set([recovery]), errors: new WeakSet(), classifications: [] };
    this.recoveryDeliveries.set(handle, delivery);
    let settleCancelled!: () => void;
    const cancelled = new Promise<void>((resolve) => { settleCancelled = resolve; });
    controller.signal.addEventListener('abort', settleCancelled, { once: true });
    let turnEnded = false;
    const detachDelivery = handle.subscribe((event) => {
      if (event.type === 'turn_end') turnEnded = true;
      // Queued/native subsequent turns on the same object are not this
      // failed delivery's custody, even before its promise continuation runs.
      if (event.type === 'error' && !turnEnded) delivery.errors.add(event);
    });
    const stillCurrent = (): boolean => {
      if (
        this.disposed ||
        controller.signal.aborted ||
        this.agents.get(agent.agentId) !== agent ||
        agent.handle !== handle
      ) return false;
      if (opts.rearmFence !== true) return this.recoveryAuthorityCurrent(agent, recovery);
      const refusal = this.rearmRefusal(agent, recovery);
      if (refusal !== null) {
        this.fenceRecoveredHandle(agent, handle, opts.rearmNotificationId ?? null, refusal);
        return false;
      }
      return true;
    };
    try {
      if (!stillCurrent()) return;
      if (agent.role === 'minion' && this.workerGate !== undefined) {
        lease = await this.workerGate.acquireWorkerTurn({
          id: laneAgentId,
          label: `restart recovery → ${laneAgentId}`,
          agentId: laneAgentId,
          jobId: this.ledger.getAgent(laneAgentId)?.jobId ?? null,
          signal: controller.signal,
        });
        if (!stillCurrent()) return;
      }
      // Delivery truth (#160): the recovered turn must attest its own
      // success. A resolved re-delivery that settled aborted or in-band
      // error is thrown to the catch below, which consults the retry
      // settlement and — when nothing carried the turn — posts the honest
      // recoverable-lane note instead of recording a fabricated 'resumed'.
      turnStarted = true;
      const verdict = await promptWithTerminalVerdict(handle, pending.text, {
        ...(pending.owner !== null ? { owner: pending.owner } : {}),
        ...(pending.images !== undefined ? { images: pending.images } : {}),
      });
      if (!verdict.ok) {
        throw new Error(verdict.error ?? 'runtime settled the recovered turn with an in-band error');
      }
      // The prompt itself succeeded; a later hold may stop follow-through,
      // but must not make the same interrupted prompt eligible for replay.
      if (opts.rearmFence === true && agent.pendingRecovery === recovery) agent.pendingRecovery = null;
      if (!stillCurrent()) return;
      // Release the slot before waiting on a bounded rate-limit retry so
      // the retry can reacquire admission for its next attempt.
      lease?.release();
      lease = null;
      const disposition = await (delivery.retry?.settled ?? this.awaitRetrySettlement(agent.agentId));
      if (!stillCurrent()) return;
      if (disposition === 'exhausted' || disposition === 'superseded') {
        throw new Error(`automatic retry ${disposition} without resumed delivery`);
      }
      if (opts.rearmFence === true && agent.pendingRecovery === recovery) agent.pendingRecovery = null;
      this.recordEvent('supervision.turn-recovery', laneAgentId, {
        disposition: 'resumed',
        reason,
      });
      this.log('info', 'interrupted turn resumed on the restarted session', {
        agent_id: laneAgentId,
        reason,
      });
    } catch (error) {
      // Release admission before awaiting retry deliveries: they reacquire it.
      lease?.release();
      lease = null;
      // Include later retry failures and queued guidance in this exact
      // delivery's lifecycle, not just the classifications present at entry.
      for (let index = 0; index < delivery.classifications.length; index += 1) {
        await Promise.race([delivery.classifications[index], cancelled]);
        if (!stillCurrent()) return;
      }
      // Bare retry rejections have no adapter envelope: their guidance is
      // registered on the exact incident instead of the delivery's tap list.
      await Promise.race([Promise.all(delivery.retry?.classifications ?? []), cancelled]);
      // Cancellation is not an orphan: the attempt was superseded.
      if (!stillCurrent()) return;
      // The rejection may itself have opened a rate-limit incident whose
      // bounded retry is still carrying this turn: consult its settlement
      // before classifying. A recovered retry is recorded as resumed — never
      // escalated to the owner as a failed resume; a spent budget keeps the
      // same ladder truth as the resolve path.
      const disposition = await (delivery.retry?.settled ?? this.awaitRetrySettlement(agent.agentId));
      if (!stillCurrent()) return;
      if (disposition === 'recovered') {
        if (opts.rearmFence === true && agent.pendingRecovery === recovery) agent.pendingRecovery = null;
        this.recordEvent('supervision.turn-recovery', laneAgentId, {
          disposition: 'resumed',
          reason,
        });
        this.log('info', 'interrupted turn resumed on the restarted session', {
          agent_id: laneAgentId,
          reason,
        });
        return;
      }
      if (disposition === 'exhausted' || disposition === 'superseded') {
        if (opts.rearmFence === true && agent.pendingRecovery === recovery) agent.pendingRecovery = null;
        this.log('warn', 'interrupted turn did not resume under its automatic retries', {
          agent_id: laneAgentId,
          reason,
          disposition,
        });
      }
      if (agent.inRestart || agent.breakerOpen || agent.rateLimitRetry !== null || agent.decisionPending || agent.queuedRecovery !== null) return;
      if (agent.pendingRecovery !== null && !delivery.snapshots.has(agent.pendingRecovery)) return;
      if (agent.pendingRecovery !== null) agent.pendingRecovery = null;
      this.log('error', 'interrupted turn could not be resumed — posting recoverable-lane note', {
        agent_id: laneAgentId,
        reason,
        error: String(error),
      });
      this.postOrphanedTurn(laneAgentId, reason, String(error));
    } finally {
      // Issue #339: a recovered turn that actually started (its prompt was
      // delivered to the resumed session) is a resume too — observe its
      // settled session on EVERY exit, including the stillCurrent() guards
      // above. Those guards fence delivery bookkeeping, not the read-only
      // observation: a turn that loses authority mid-flight still ran and may
      // have read prohibited material, and leaving it unscanned would keep
      // contaminated coverage qualifying (and steer the parent to reuse it).
      if (turnStarted) this.observeBlindTurnAccess(laneAgentId, handle);
      controller.signal.removeEventListener('abort', settleCancelled);
      detachDelivery();
      if (this.recoveryDeliveries.get(handle) === delivery) this.recoveryDeliveries.delete(handle);
      if (agent.recoveryAdmission === controller) agent.recoveryAdmission = null;
      lease?.release();
    }
  }

  /** Issue #339: record a finished resume/retry turn's observed tool access
   * against the rule the job was admitted under (no-op for a non-blind job
   * or an agent with no job). This is the supervisor's one call-through to the
   * shared blind-coverage observer for both the restart-recovered turn and the
   * automatic rate-limit retry turn; the production observer owns its own error
   * boundary, and this one keeps a raw port from failing an already-delivered
   * turn. */
  private observeBlindTurnAccess(laneAgentId: string, handle: AgentHandle): void {
    const observe = this.observeBlindTurn;
    if (observe === null) return;
    try {
      // The ledger lookup rides inside the boundary too: a throwing read must
      // not escape as a turn failure (at the resolve path it would re-route
      // the turn into the catch branch; at the catch path it would escape the
      // void'd caller entirely).
      const jobId = this.ledger.getAgent(laneAgentId)?.jobId ?? null;
      if (jobId === null) return;
      observe(jobId, handle.sessionFile);
    } catch (error) {
      this.log('error', 'blind review access observation failed', { agent: laneAgentId, error: String(error) });
    }
  }

  private postOrphanedTurn(laneAgentId: string, reason: string, detail: string): void {
    const lane = this.laneContext(laneAgentId);
    this.recordEvent('supervision.turn-recovery', laneAgentId, {
      disposition: 'orphaned',
      reason,
      note: detail,
    });
    try {
      this.notifications.postIncident({
        kind: `supervision.turn-orphaned.${laneAgentId}`,
        routing: 'action-required',
        severity: 'error',
        title: `Interrupted turn not auto-resumed: ${laneAgentId}`,
        detail:
          `Supervision interrupted an open turn (${reason}) and could not re-deliver its prompt (${detail}). ` +
          `The lane is recoverable: ${lane}.`,
        agentId: laneAgentId,
        dedupe: 'unacked',
      });
    } catch (error) {
      this.log('warn', 'orphaned-turn note could not be posted', {
        agent_id: laneAgentId,
        error: String(error),
      });
    }
  }

  /** Durable ledger event that never breaks the watchdog on a ledger fault.
   * The canonical pacing payloads are typed without an index signature and
   * are part of the accepted event shapes here. */
  private recordEvent(
    kind: string,
    agentId: string | null,
    payload: Record<string, unknown> | PacingRetryPayload | PacingExhaustedPayload | PacingRecoveredPayload,
  ): void {
    try {
      // Job attribution rides the envelope: a supervisor-owned worker retry
      // must be findable by job-scoped queries, exactly like the workflow
      // producer's events. Resolved per event (bounded: retry events are
      // rare) and best-effort (a missing row simply omits the job).
      const jobId = agentId === null ? null : (this.ledger.getAgent(agentId)?.jobId ?? null);
      this.ledger.appendCustomEvent({ kind, agentId, jobId, payload });
    } catch (error) {
      this.log('warn', 'supervision ledger event could not be recorded', {
        kind,
        error: String(error),
      });
    }
  }

  /** Trip the crash-loop breaker: stop the agent, escalate, mark. */
  private tripBreaker(agent: SupervisedAgent): void {
    if (agent.breakerOpen) return; // idempotent — one escalation per trip
    agent.breakerOpen = true;
    agent.state = 'stopped';
    agent.stopReason = 'crash loop';
    agent.stoppedAt = this.now();
    this.rememberStop(agent);
    const handle = agent.handle;
    // The turn this trip kills must survive as a recovery candidate: the
    // ack re-arm resumes it on the next live handle.
    const captured = this.captureInterruptedTurn(handle, agent);
    if (captured !== null) agent.pendingRecovery = captured;
    agent.openTurn = false;
    agent.openControl = false;
    agent.openToolCalls.clear();
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
      // Routine recovery belongs to the machine chain (owner release
      // 2026-10-11): a crash-loop stop is Gru's decision, not an owner
      // chore. Gru's guarded disposition on this action-required row
      // re-arms the restart ladder (supervisor.onNotificationDisposed).
      routing: 'action-required',
      severity: 'error',
      title: `Crash-loop breaker tripped: agent ${agent.agentId} stopped`,
      detail:
        `${agent.restartRing.length} restarts within ${Math.round(this.cfg.restartWindowMs / 1000)}s. ` +
        'The agent is STOPPED; a Gru disposition on this alert can re-arm the guarded restart ladder once the cause is addressed.',
      agentId: agent.agentId,
    });
    agent.breakerNotificationId = notification.id;
    this.rememberStop(agent);
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
   * Ack hook: an ack for an OPEN breaker re-arms it (clears the ring,
   * fresh window, one restart attempt). Acks for anything else — or for a
   * slot deliberately released — are pure records. Breaker alerts are
   * action-required since the owner release (2026-10-11), so this hook is
   * now the pure-record path; the disposition hook is the live one.
   */
  onNotificationAcked(notificationId: string): void {
    void this.reArmFromNotification(notificationId);
  }

  /** Disposition hook (owner release 2026-10-11): Gru's machine
   * disposition on an open breaker alert is the supported re-arm control —
   * same guarded route as the historical ack, never a privilege bypass.
   * Returns a typed outcome: the caller records the disposition ONLY when
   * the guarded control accepted it, so a fence refusal leaves the alert
   * and its retryable debt intact. */
  onNotificationDisposed(
    notificationId: string,
  ): { ok: true; rearmed: boolean; superseded?: true } | { ok: false; reason: string } {
    return this.reArmFromNotification(notificationId);
  }

  /** #385 (owner decision 2026-10-15: close as superseded): a stopped lane's
   * captured turn whose native authority was SUPERSEDED — the job's directive
   * epoch or producer identity moved since capture (an owner park then resume
   * moves the epoch; a fresh directive/re-brief moves the producer) — never
   * replays, so the guarded re-arm can never accept it. When that supersession
   * is the ONLY fence (every other check clears for this live, unheld job),
   * Gru's disposition closes the stop instead of being refused forever: the
   * stale worker is NOT restarted, the parked-over prompt is dropped (it will
   * never replay) and the lane continues through a fresh re-brief/directive.
   * An unreadable capture or current authority, a moved job binding, or any
   * other fence keeps the stop refused with its debt retained. */
  private supersededStopClosure(agent: SupervisedAgent): {
    readonly jobId: string;
    readonly capturedEpoch: number;
    readonly currentEpoch: number;
    readonly producerChanged: boolean;
  } | null {
    const recovery = agent.pendingRecovery;
    if (recovery === null || recovery.jobId === null || recovery.authorityEpoch === null) return null;
    // A live handle or an in-flight restart rung owns the agent: never close it.
    if (agent.handle !== null || agent.inRestart) {
      this.log('info', 'superseded closure deferred: the agent is live or restarting', {
        agent_id: agent.agentId, live_handle: agent.handle !== null, in_restart: agent.inRestart,
      });
      return null;
    }
    const jobId = recovery.jobId;
    try {
      if ((this.ledger.getAgent(agent.agentId)?.jobId ?? null) !== jobId) return null;
      const currentEpoch = this.ledger.directiveRecoveryEpoch(jobId);
      const producer = this.nativeProducerIdentity(jobId);
      if (recovery.authorityEpoch === currentEpoch && recovery.producerIdentity === producer) return null; // current: replay path
      if (this.rearmRefusal(agent, null) !== null) return null; // another fence owns the stop
      return { jobId, capturedEpoch: recovery.authorityEpoch, currentEpoch, producerChanged: recovery.producerIdentity !== producer };
    } catch {
      return null; // unreadable authority is never waived
    }
  }

  /** Records the closure DURABLY first — a failed append throws and leaves
   * the stop exactly as it was — then retires the supervision record
   * in-process. Once the closure is recorded it stands: retirement always
   * removes the record, each cleanup step runs whatever an earlier one did
   * (a failure is logged as an error, never rethrown), and the closure is
   * recorded at most once per alert (atomically, in the ledger). */
  private closeSupersededStop(
    agent: SupervisedAgent,
    notificationId: string,
    closure: NonNullable<ReturnType<Supervisor['supersededStopClosure']>>,
  ): void {
    const recovery = agent.pendingRecovery;
    const stopReason = `stop closed: its captured turn was superseded on job "${closure.jobId}" — it will never replay; continue the lane with a fresh re-brief or directive`;
    const recorded = this.ledger.recordSupervisionStopSuperseded({
      agentId: agent.agentId,
      jobId: closure.jobId,
      payload: {
        notification_id: notificationId,
        job_id: closure.jobId,
        captured_epoch: closure.capturedEpoch,
        current_epoch: closure.currentEpoch,
        producer_changed: closure.producerChanged,
        had_open_turn: recovery?.hadOpenTurn ?? false,
        prompt_named: recovery?.pending !== null && recovery?.pending !== undefined,
        stop_reason: stopReason,
      },
    });
    // The stop is CLOSED, not held: retire this supervision record entirely —
    // in-process exactly as durably (the stop leaves durableSupervisionStops)
    // — so the lane no longer reads as stopped and a fresh re-brief/directive
    // adopts a new watching record instead of being disposed and re-alerted.
    // Only a job minion with no live handle and no restart rung gets here.
    const cleanup: readonly (readonly [string, () => void])[] = [
      ['backoff timer', () => {
        const timer = agent.backoffTimer;
        agent.backoffTimer = null;
        if (timer !== null) clearTimeout(timer);
      }],
      ['rate-limit retry', () => { this.clearRateLimitRetry(agent, 'superseded'); }],
      ['recovery admission', () => { this.clearRecoveryAdmission(agent); }],
    ];
    try {
      for (const [step, run] of cleanup) {
        try {
          run();
        } catch (error) {
          this.log('error', 'superseded stop retirement cleanup step failed — the closure stands', { agent_id: agent.agentId, step, error: String(error) });
        }
      }
    } finally {
      this.agents.delete(agent.agentId);
      this.restoredStops.delete(agent.agentId);
      this.restoredRearmControls.delete(agent.agentId);
    }
    this.log('info', recorded
      ? 'breaker stop closed as superseded — the stale captured turn never replays'
      : 'breaker stop already closed as superseded — its live record is retired', {
      agent_id: agent.agentId,
      job_id: closure.jobId,
      notification_id: notificationId,
    });
  }

  /** The fences a NOTIFICATION-DRIVEN re-arm must re-prove (never a new
   * authority): terminal or missing jobs, an open directive-retirement
   * hold, explicit owner parking, live review writers, in-flight producer
   * admission, open provider recovery, and the shared native recovery
   * authority (directive/re-brief ownership and epoch). Returns the refusal reason, or null when the re-arm
   * may proceed. */
  private rearmRefusal(agent: SupervisedAgent, recovery: InterruptedTurn | null): string | null {
    try {
      // Provider ownership can belong to a jobless logical slot (Silas).
      // Check it before the job-binding fast path so only the sensor's
      // evidence-backed transition can release that wait.
      const wait = this.ledger.openProviderWaitForAgent(agent.agentId);
      if (wait !== null) return `open provider recovery ${wait.id} owns this stop`;
      const jobId = recovery?.jobId ?? this.ledger.getAgent(agent.agentId)?.jobId ?? null;
      if (jobId === null) return null;
      const job = this.ledger.getJob(jobId);
      if (job === null) return `job "${jobId}" is missing`;
      if (isJobTerminal(job.status)) return `job "${jobId}" is ${job.status}`;
      if (this.ledger.hasOpenDirectiveRecoveryHold(jobId)) {
        return `job "${jobId}" has an open directive-retirement hold`;
      }
      if (job.status === 'parked') return `job "${jobId}" is parked (owner/ops hold)`;
      if (this.ledger.listJobAdmissions(jobId).length > 0) {
        return `an in-flight producer owns job "${jobId}"`;
      }
      if (this.activeReviewFor(jobId)) return `active Perkins review owns job "${jobId}"`;
      // Native directive / re-brief ownership and the directive epoch are
      // judged by the one authority predicate every restart path shares
      // (issues #279/#280): a stopped lane's own interrupted directive or
      // re-brief is its legitimate recovery, while a superseded one is not.
      if (!this.recoveryAuthorityCurrent(agent, recovery)) {
        return `recovery authority for job "${jobId}" is no longer current (superseded, held or unreadable)`;
      }
      return null;
    } catch (error) {
      return `re-arm authority unavailable: ${String(error)}`;
    }
  }

  /** Refusal was proved after the disposition request began: keep the stop
   * visible with the fence reason and the recovery debt retryable. When the
   * notification that started the re-arm is already consumed (resolved) or
   * unknown, a FRESH machine alert is raised and bound to this stop so a
   * later Gru disposition retries through the same guarded route — the
   * refusal never strands a stopped lane without a live control. Never
   * replays the saved prompt. */
  private fenceRearm(agent: SupervisedAgent, notificationId: string | null, reason: string): void {
    agent.breakerOpen = true;
    agent.state = 'stopped';
    agent.stopReason = `re-arm fenced: ${reason}`;
    agent.stoppedAt = agent.stoppedAt ?? this.now();
    this.rememberStop(agent);
    this.raiseFencedAlert(agent, reason);
    this.rememberStop(agent);
    this.recordEvent('supervision.rearm-fenced', agent.agentId, {
      notification_id: notificationId,
      control_notification_id: agent.breakerNotificationId,
      pending_rearm_fence_reason: agent.pendingRearmFenceAlert?.reason ?? null,
      reason,
      stop_reason: agent.stopReason,
      restarts: agent.restartRing.length,
    });
    this.log('warn', 'breaker re-arm refused — the stop remains', {
      agent_id: agent.agentId,
      notification_id: notificationId,
      reason,
    });
  }

  /** Stop an adopted replacement when an authority fence appears while its
   * recovered turn is queued or settling. Preserve pendingRecovery so the
   * same supported control can retry it after the hold is lifted. */
  private fenceRecoveredHandle(
    agent: SupervisedAgent,
    handle: AgentHandle,
    notificationId: string | null,
    reason: string,
  ): void {
    if (agent.handle !== handle) return;
    this.clearRecoveryAdmission(agent);
    agent.handle = null;
    agent.openTurn = false;
    agent.openControl = false;
    agent.compactionWarned = false;
    agent.openToolCalls.clear();
    this.fenceRearm(agent, notificationId, reason);
    void this.registry.disposeHandle(handle).catch((error: unknown) => {
      this.log('warn', 'dispose of fenced recovery handle failed', {
        agent_id: agent.agentId,
        error: String(error),
      });
    });
  }

  /** Bind a live retry control to a fenced stop. When the alert that began
   * the re-arm is consumed (resolved) or unknown, a fresh machine alert is
   * raised; a failed post is remembered and retried on every tick, so a
   * ledger hiccup can never strand the stop without a control. Every read
   * here is guarded: this is a fire-and-forget path. */
  private raiseFencedAlert(agent: SupervisedAgent, reason: string, persistRecoveredControl = false): void {
    if (!agent.breakerOpen) {
      agent.pendingRearmFenceAlert = null;
      return;
    }
    if (agent.pendingRearmFenceAlert === null || agent.pendingRearmFenceAlert === undefined) {
      agent.pendingRearmFenceAlert = { reason };
    }
    let bound: ReturnType<LedgerApi['getNotification']> = null;
    if (agent.breakerNotificationId !== null) {
      try {
        bound = this.ledger.getNotification(agent.breakerNotificationId);
      } catch (error) {
        // Treat an unreadable binding as gone: raise a fresh control rather
        // than leaving the stop dependent on a row we cannot verify.
        this.log('warn', 'bound alert lookup failed — raising a fresh control', {
          agent_id: agent.agentId,
          error: String(error),
        });
        bound = null;
      }
    }
    if (bound !== null && bound.resolvedAt === null && bound.ackedAt === null) {
      if (agent.pendingRearmFenceAlert !== null && agent.pendingRearmFenceAlert !== undefined) {
        const pendingReason = agent.pendingRearmFenceAlert.reason;
        agent.pendingRearmFenceAlert = null;
        if (persistRecoveredControl) {
          this.recordEvent('supervision.rearm-fenced', agent.agentId, {
            notification_id: bound.id,
            control_notification_id: bound.id,
            pending_rearm_fence_reason: null,
            reason: pendingReason,
            stop_reason: agent.stopReason,
            restarts: agent.restartRing.length,
          });
          this.rememberStop(agent);
        }
      }
      return; // a live control already exists
    }
    try {
      const posted = this.notifications.post({
        kind: 'supervision.rearm-fenced',
        routing: 'action-required',
        severity: 'error',
        title: `Re-arm fenced: agent ${agent.agentId} stayed stopped`,
        detail:
          `The guarded restart was refused by a hold that appeared during the attempt (${reason}). ` +
          'Resolve the hold, then dispose this alert to retry the re-arm.',
        agentId: agent.agentId,
      });
      const pendingReason = agent.pendingRearmFenceAlert?.reason ?? reason;
      agent.breakerNotificationId = posted.id;
      agent.pendingRearmFenceAlert = null;
      if (persistRecoveredControl) {
        this.recordEvent('supervision.rearm-fenced', agent.agentId, {
          notification_id: posted.id,
          control_notification_id: posted.id,
          pending_rearm_fence_reason: null,
          reason: pendingReason,
          stop_reason: agent.stopReason,
          restarts: agent.restartRing.length,
        });
        this.rememberStop(agent);
      }
    } catch (error) {
      agent.pendingRearmFenceAlert = { reason };
      this.log('error', 'fenced re-arm alert post failed — retrying on tick', {
        agent_id: agent.agentId,
        error: String(error),
      });
    }
  }

  /** Commit an accepted re-arm (breaker cleared, epoch and provider fences
   * re-proved) and run the guarded restart rung with the re-arm fence.
   * Fire-and-forget by the hook: every failure path is contained here —
   * a supervision bug or ledger hiccup must never surface as an unhandled
   * rejection (fatal in main), and a partial commit keeps the stop
   * truthful through the fence path. */
  private async completeRearm(agent: SupervisedAgent, notificationId: string | null): Promise<void> {
    try {
      if (this.disposed || !this.cfg.enabled) return;
      const refusal = this.rearmRefusal(agent, agent.pendingRecovery);
      if (refusal !== null) {
        this.fenceRearm(agent, notificationId, refusal);
        return;
      }
      agent.breakerOpen = false;
      agent.stopReason = null;
      agent.stoppedAt = null;
      agent.breakerNotificationId = null;
      agent.pendingRearmFenceAlert = null;
      agent.restartRing = [];
      agent.consecutiveFailures = 0;
      agent.state = 'watching';
      this.restoredStops.delete(agent.agentId);
      this.restoredRearmControls.delete(agent.agentId);
      this.log('info', 'breaker re-armed by disposition — resuming supervision', {
        agent_id: agent.agentId,
        notification_id: notificationId,
      });
      this.ledger.appendCustomEvent({
        kind: 'supervision.rearmed',
        agentId: agent.agentId,
        payload: { notification_id: notificationId },
      });
      await this.restartRung(agent, 'breaker re-armed', { rearmFence: true, rearmNotificationId: notificationId });
    } catch (error) {
      this.log('error', 're-arm commit failed — the stop stays fenced', {
        agent_id: agent.agentId,
        notification_id: notificationId,
        error: String(error),
      });
      this.fenceRearm(agent, notificationId, `re-arm commit failed: ${String(error)}`);
    }
  }

  private reArmFromNotification(
    notificationId: string,
  ): { ok: true; rearmed: boolean; superseded?: true } | { ok: false; reason: string } {
    // Off = acks are pure records, still labelled with a recorded closure.
    if (this.disposed || !this.cfg.enabled) return this.recordedClosureOutcome(notificationId, 'pure');
    for (const agent of this.agents.values()) {
      if (agent.breakerNotificationId !== notificationId || !agent.breakerOpen) continue;
      const superseded = this.supersededStopClosure(agent);
      if (superseded !== null) {
        try {
          this.closeSupersededStop(agent, notificationId, superseded);
        } catch (error) {
          // Nothing changed: the stop keeps its control and its debt.
          return { ok: false, reason: `superseded stop closure could not be recorded: ${String(error)}` };
        }
        return { ok: true, rearmed: false, superseded: true };
      }
      const refusal = this.rearmRefusal(agent, agent.pendingRecovery);
      if (refusal !== null) {
        this.log('info', 'breaker re-arm refused by the recovery authority fence', {
          agent_id: agent.agentId,
          notification_id: notificationId,
          reason: refusal,
        });
        this.recordEvent('supervision.rearm-fenced', agent.agentId, {
          notification_id: notificationId,
          control_notification_id: agent.breakerNotificationId,
          pending_rearm_fence_reason: agent.pendingRearmFenceAlert?.reason ?? null,
          reason: refusal,
          stop_reason: agent.stopReason,
          restarts: agent.restartRing.length,
        });
        return { ok: false, reason: refusal };
      }
      void this.completeRearm(agent, notificationId);
      return { ok: true, rearmed: true };
    }
    // A durable stop can outlive its runtime handle. Do not consume its only
    // retry control while the agent has not yet been adopted.
    for (const [agentId, control] of this.restoredRearmControls) {
      if (control.notificationId !== notificationId) continue;
      if (this.restoredStops.get(agentId)?.breakerOpen === true) {
        return {
          ok: false,
          reason: 'restored breaker has not been adopted by a live agent yet; keep this control open and retry after adoption',
        };
      }
    }
    // No stopped breaker is bound to this alert: the disposition is a pure
    // record — or the retry of a stop already closed as superseded, which
    // reports that same outcome from the durable record (restarts included).
    // An accepted outcome never claims a re-arm that did not happen.
    return this.recordedClosureOutcome(notificationId, 'refuse');
  }

  /** The outcome of a disposition no live stop answers: superseded when the
   * ledger recorded this alert's closure, else a pure record. When the
   * lookup fails, a breaker alert (whose answer it could change) refuses so
   * the retry asks again; any other alert — or a supervisor that is off
   * (`onFailure: 'pure'`) — stays a pure record. */
  private recordedClosureOutcome(notificationId: string, onFailure: 'refuse' | 'pure'): { ok: true; rearmed: false; superseded?: true } | { ok: false; reason: string } {
    try {
      return this.ledger.hasSupervisionStopSuperseded(notificationId) ? { ok: true, rearmed: false, superseded: true } : { ok: true, rearmed: false };
    } catch (error) {
      const failure = failureText(error);
      // Whether the alert is a breaker decides whether the lost answer
      // matters; a kind that cannot be read is treated as a breaker (fail
      // closed). No alert at all has no stop whose answer could be lost.
      let breaker = true;
      let kindFailure: string | null = null;
      try {
        breaker = this.ledger.getNotification(notificationId)?.kind === 'supervision.breaker';
      } catch (kindError) {
        kindFailure = failureText(kindError);
        this.log('error', 'notification kind lookup failed after a failed closure lookup — treating it as a breaker alert', { notification_id: notificationId, error: kindFailure });
      }
      if (onFailure === 'refuse' && breaker) {
        return { ok: false, reason: `superseded closure lookup failed — retry the disposition: ${failure}${kindFailure === null ? '' : `; its alert kind could not be read either: ${kindFailure}`}` };
      }
      this.log(breaker ? 'error' : 'warn', 'superseded closure lookup failed — reporting a pure record', { notification_id: notificationId, breaker, error: failure, ...(kindFailure === null ? {} : { kind_failure: kindFailure }) });
      return { ok: true, rearmed: false };
    }
  }

  /**
   * Guarded OWNED re-arm for a provider-recovered agent (the provider-recovery
   * sensor's dedicated eligible-state transition — NOT notification-ACK
   * automation): re-arms the open breaker of the exact agent a durable
   * provider wait names, only while that wait is still open and the agent's
   * breaker is genuinely the provider stop. Everything else keeps requiring
   * the human ack path. Returns whether the re-arm happened.
   */
  ownedProviderReArm(agentId: string, waitId: string): boolean {
    if (this.disposed || !this.cfg.enabled) return false;
    const agent = this.agents.get(agentId);
    if (agent === undefined || !agent.breakerOpen || agent.handle !== null) return false;
    // The durable wait must still be open for THIS agent: the ledger, not
    // memory, is the record (restart-safe).
    let open = false;
    try {
      const wait = this.ledger.openProviderWaitForAgent(agentId);
      open = wait !== null && wait.id === waitId;
    } catch (error) {
      this.log('error', 'owned re-arm could not verify the durable wait', {
        agent_id: agentId,
        error: String(error),
      });
      return false;
    }
    if (!open) return false;
    agent.breakerOpen = false;
    // The re-arm clears the stop cause with the breaker: a watching agent
    // must never carry a stale stopReason (the invariant viewFor/health
    // and the board rely on). Every other re-arm path clears it too.
    agent.stopReason = null;
    agent.stoppedAt = null;
    agent.breakerNotificationId = null;
    agent.pendingRearmFenceAlert = null;
    agent.restartRing = [];
    agent.consecutiveFailures = 0;
    agent.state = 'watching';
    this.restoredStops.delete(agent.agentId);
    this.restoredRearmControls.delete(agent.agentId);
    this.log('info', 'breaker re-armed by owned provider recovery', {
      agent_id: agentId,
      wait_id: waitId,
    });
    this.ledger.appendCustomEvent({
      kind: 'supervision.rearmed',
      agentId,
      payload: { by: 'provider-recovery', wait_id: waitId },
    });
    void this.restartRung(agent, 'provider recovery re-arm');
    return true;
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
        stopReason: agent.stopReason,
        stoppedAt:
          agent.stoppedAt === null || agent.stoppedAt === undefined
            ? null
            : new Date(agent.stoppedAt).toISOString(),
        openTurn: agent.openTurn,
        openControl: agent.openControl,
        openToolCalls: agent.openToolCalls.size,
        backgroundTasks: agent.openTurn ? [...agent.backgroundTasks] : [],
        lastEventAt:
          agent.lastEventAt > 0 ? new Date(agent.lastEventAt).toISOString() : null,
        lastFileBytes: agent.lastFileBytes,
      })),
    };
  }

  /** Hydrate the durable stop map from the ledger's supervision events
   * (restart-only; a malformed query must not take the service down). */
  private hydrateRestoredStops(): Map<string, AgentSupervisionView> {
    const stops = new Map<string, AgentSupervisionView>();
    this.restoredRearmControls.clear();
    if (!this.cfg.enabled) return stops;
    try {
      for (const [agentId, stop] of this.ledger.durableSupervisionStops()) {
        const pendingFenceReason =
          stop.pendingFenceReason ??
          (stop.notificationId === null ? stop.reason ?? 'restored supervision stop has no open retry control' : null);
        this.restoredRearmControls.set(agentId, {
          notificationId: stop.notificationId,
          pendingFenceReason,
        });
        stops.set(agentId, {
          agentId,
          role: stop.role,
          slotId: null,
          state: 'stopped',
          restarts: stop.restarts,
          breakerOpen: true,
          stopReason: stop.reason,
          stoppedAt: null,
          openTurn: false,
          openToolCalls: 0,
          lastEventAt: null,
          lastFileBytes: null,
        });
      }
    } catch (error) {
      this.log('error', 'durable supervision stop hydration failed', { error: String(error) });
    }
    return stops;
  }

  /** Retry durable control-post debt even when no runtime handle is currently
   * adopted for the stopped agent. A restart must not make a fenced stop
   * invisible merely because the producer has not been reattached yet. */
  private retryRestoredControlDebt(): void {
    for (const [agentId, control] of this.restoredRearmControls) {
      if (this.agents.has(agentId) || control.pendingFenceReason === null) continue;
      const stop = this.restoredStops.get(agentId);
      if (stop === undefined || !stop.breakerOpen) continue;
      const reason = control.pendingFenceReason;
      let bound: ReturnType<LedgerApi['getNotification']> = null;
      if (control.notificationId !== null) {
        try {
          bound = this.ledger.getNotification(control.notificationId);
        } catch (error) {
          this.log('warn', 'restored alert lookup failed — raising a fresh control', {
            agent_id: agentId,
            error: String(error),
          });
        }
      }
      if (bound !== null && bound.resolvedAt === null && bound.ackedAt === null) {
        this.restoredRearmControls.set(agentId, { notificationId: bound.id, pendingFenceReason: null });
        this.recordEvent('supervision.rearm-fenced', agentId, {
          notification_id: bound.id,
          control_notification_id: bound.id,
          pending_rearm_fence_reason: null,
          reason,
          stop_reason: stop.stopReason,
          restarts: stop.restarts,
        });
        continue;
      }
      try {
        const posted = this.notifications.post({
          kind: 'supervision.rearm-fenced',
          routing: 'action-required',
          severity: 'error',
          title: `Re-arm fenced: agent ${agentId} stayed stopped`,
          detail:
            `The restored supervision stop has no live retry control (${reason}). ` +
            'Resolve the reported condition, then dispose this alert to retry the re-arm.',
          agentId,
        });
        this.restoredRearmControls.set(agentId, { notificationId: posted.id, pendingFenceReason: null });
        this.recordEvent('supervision.rearm-fenced', agentId, {
          notification_id: posted.id,
          control_notification_id: posted.id,
          pending_rearm_fence_reason: null,
          reason,
          stop_reason: stop.stopReason,
          restarts: stop.restarts,
        });
      } catch (error) {
        this.log('error', 'restored control post failed — retrying on tick', {
          agent_id: agentId,
          error: String(error),
        });
      }
    }
  }

  /** Attach the durable stop and its retry control to a newly adopted agent.
   * A handle arriving for a stopped id is disposed, never treated as an
   * implicit re-arm. Missing, closed or acknowledged controls become retryable alert debt. */
  private restoreDurableStop(agent: SupervisedAgent): void {
    if (agent.breakerOpen) return;
    const stop = this.restoredStops.get(agent.agentId);
    if (stop === undefined) return;
    const control = this.restoredRearmControls.get(agent.agentId);
    let notificationId = control?.notificationId ?? null;
    let pendingFenceReason = control?.pendingFenceReason ?? null;
    if (notificationId !== null) {
      try {
        const row = this.ledger.getNotification(notificationId);
        if (row === null || row.resolvedAt !== null || row.ackedAt !== null) notificationId = null;
      } catch (error) {
        notificationId = null;
        pendingFenceReason = `restored stop control lookup failed: ${String(error)}`;
      }
    }
    if (notificationId === null && pendingFenceReason === null) {
      pendingFenceReason = stop.stopReason ?? 'restored supervision stop has no open retry control';
    }
    agent.breakerOpen = true;
    agent.state = 'stopped';
    agent.stopReason = stop.stopReason;
    agent.stoppedAt = null;
    agent.restartRing = Array.from(
      { length: Math.min(Math.max(0, stop.restarts), this.cfg.maxRestarts) },
      () => this.now(),
    );
    agent.breakerNotificationId = notificationId;
    agent.pendingRearmFenceAlert = pendingFenceReason === null ? null : { reason: pendingFenceReason };
    agent.openTurn = false;
    agent.openControl = false;
    agent.openToolCalls.clear();
    const handle = agent.handle;
    if (handle !== null) {
      agent.handle = null;
      void this.registry.disposeHandle(handle).catch((error: unknown) => {
        this.log('warn', 'dispose of restored stopped handle failed', {
          agent_id: agent.agentId,
          error: String(error),
        });
      });
    }
    this.rememberStop(agent);
  }

  /** Mirror an in-process stop into the restored map so the truth survives
   * even if the live record is later removed. */
  private rememberStop(agent: SupervisedAgent): void {
    this.restoredRearmControls.set(agent.agentId, {
      notificationId: agent.breakerNotificationId,
      pendingFenceReason: agent.pendingRearmFenceAlert?.reason ?? null,
    });
    this.restoredStops.set(agent.agentId, {
      agentId: agent.agentId,
      role: agent.role,
      slotId: agent.slot?.id ?? null,
      state: 'stopped',
      restarts: agent.restartRing.length,
      breakerOpen: agent.breakerOpen,
      stopReason: agent.stopReason,
      stoppedAt:
        agent.stoppedAt === null || agent.stoppedAt === undefined
          ? null
          : new Date(agent.stoppedAt).toISOString(),
      openTurn: false,
      openToolCalls: 0,
      lastEventAt: null,
      lastFileBytes: null,
    });
  }

  /** Synchronous cessation evidence for guarded control closure. A timer,
   * queued retry or undecided recovery is still producer ownership even
   * while its durable agent row says idle/error/disposed. */
  pendingProducerBlockers(jobId: string, currentNative?: { readonly handle: AgentHandle; readonly producer: DirectiveProducer }): readonly string[] {
    const retained: string[] = [];
    for (const [handle, originalJobId] of this.retainedDirectiveProducers) {
      if (originalJobId !== jobId) continue;
      if (this.restartCessationConfirmed(handle)) this.retainedDirectiveProducers.delete(handle);
      else retained.push(`unproven directive producer cessation: ${handle.id}`);
    }
    const unjournaled: string[] = [];
    for (const [handle, cleanup] of this.rejectedRestartCleanup) {
      if (cleanup.jobId !== jobId) continue;
      try {
        cleanup.debt ??= this.cleanupJournal.begin(handle, cleanup.jobId, cleanup.agent.agentId);
        if (!cleanup.disposalAcknowledged) this.redisposeRejectedReplacement(handle, cleanup);
        else if (this.restartCessationConfirmed(handle)) this.settleRejectedRestartCleanup(handle, cleanup);
      } catch (error) {
        this.log('error', 'restart cleanup journal unavailable — custody retained', { agent_id: handle.id, error: String(error) });
      }
      if (cleanup.debt === null) unjournaled.push(`restart cleanup unconfirmed: ${handle.id} (pending journal write failed)`);
    }
    const rejected = this.cleanupJournal.unresolved(jobId).map(restartCleanupDiagnostic);
    const supervised = this.ledger.listAgents().filter((row) => row.jobId === jobId).flatMap((row) => {
      const agent = this.agents.get(row.id);
      if (agent === undefined) {
        return this.registry.getHandle(row.id) !== null
          ? [`supervision ownership unknown: ${row.id}`] : [];
      }
      const pending = agent.inRestart || agent.backoffTimer !== null || agent.decisionPending ||
        agent.queuedRecovery !== null || agent.rateLimitRetry !== null || agent.recoveryAdmission !== null ||
        (agent.state !== 'stopped' && !agent.breakerOpen && agent.pendingRecovery !== null);
      const directive = currentNative === undefined ? null : this.ledger.getDirective(currentNative.producer.identity.requestId);
      const start = currentNative === undefined ? null : this.ledger.latestJobEventByRequestId(jobId, 'silas.directive-producer-started', currentNative.producer.identity.requestId);
      const ownNative = currentNative !== undefined && agent.handle === currentNative.handle && this.registry.getHandle(row.id) === currentNative.handle &&
        currentNative.producer.agentId === row.id && currentNative.producer.identity.jobId === jobId && currentNative.handle.sessionFile === row.sessionFile &&
        currentNative.producer.sessionFile === row.sessionFile && directive?.nativeTarget?.agentId === row.id && directive.nativeTarget.sessionFile === row.sessionFile &&
        directive.nativeBinding?.sessionId === currentNative.producer.sessionId &&
        isDeepStrictEqual(currentNative.handle.pendingTurn?.()?.directive?.identity, currentNative.producer.identity) &&
        isDeepStrictEqual((start?.payload as { native_producer?: unknown } | undefined)?.native_producer, currentNative.producer);
      // Only this exact admitted physical turn's own tools are allowed.
      // Restart/retry/control, competing producers and cleanup fences remain.
      const open = agent.openControl || !ownNative && (agent.openTurn || agent.openToolCalls.size > 0);
      return pending || open ? [`supervised producer: ${row.id} (${pending ? 'pending recovery/retry' : 'open turn/control/tool'})`] : [];
    });
    const flights = [...this.restartingAgents].flatMap(([agent, flight]) =>
      flight.authority?.jobId === jobId ? [`restart in flight: ${agent.agentId}`] : []);
    return [...retained, ...rejected, ...unjournaled, ...supervised, ...flights];
  }

  /** Board feed: supervision view for one agent id (or null). */
  viewFor(agentId: string): AgentSupervisionView | null {
    const agent = this.agents.get(agentId);
    // No live record (post-restart, or a record removed after its stop):
    // fall back to the hydrated durable stop truth.
    if (agent === undefined) return this.restoredStops.get(agentId) ?? null;
    return {
      agentId: agent.agentId,
      role: agent.role,
      slotId: agent.slot?.id ?? null,
      state: agent.state,
      restarts: agent.restartRing.length,
      breakerOpen: agent.breakerOpen,
      stopReason: agent.stopReason,
      stoppedAt:
        agent.stoppedAt === null || agent.stoppedAt === undefined
          ? null
          : new Date(agent.stoppedAt).toISOString(),
      openTurn: agent.openTurn,
      openControl: agent.openControl,
      openToolCalls: agent.openToolCalls.size,
      backgroundTasks: agent.openTurn ? [...agent.backgroundTasks] : [],
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
    for (const flight of this.restartingAgents.values()) flight.unsubscribe?.();
    for (const agent of this.agents.values()) {
      this.clearRateLimitRetry(agent, 'superseded');
      this.clearRecoveryAdmission(agent);
      if (agent.backoffTimer !== null) clearTimeout(agent.backoffTimer);
    }
    this.agents.clear();
    this.slots.clear();
  }
}

