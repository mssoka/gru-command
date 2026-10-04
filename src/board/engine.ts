import type { Role } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { AgentState } from '../runtime/types.js';
import type { AgentEventEnvelope } from '../runtime/registry.js';
import type { EventBus } from '../events/bus.js';
import type { AgentSupervisionView } from '../supervision/supervisor.js';
import type { DecisionRuntimeStatus } from '../decisions/runtime.js';
import type { DeployDriftView } from './deploy-drift.js';
import type { VerificationQueueView } from '../verify/scheduler.js';
import type { PacingGateView } from '../runtime/pacing.js';
import { ownerReadyPr, readBranchEvidence, type OwnerPrView } from './owner-actions.js';
import {
  DEFAULT_LENSES,
  LedgerApi,
  type AgentRecord,
  type JobRecord,
  type RoundRecord,
} from '../ledger/api.js';
import type { JobStatus } from '../ledger/states.js';

/** Newest closed receipts kept in every snapshot (D3): older ones are
 * served by the paged `GET /api/notifications/receipts` route. */
const RECEIPT_WINDOW = 30;

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Board engine (EPICS E6 story 2): maps runtime adapter events into ledger
 * events + rows, derives lens-chip live state, and serves repo-grouped
 * board snapshots. The LEDGER is the source of truth — this engine only
 * translates events and queries; every snapshot is read straight from the
 * record so a restart (or a dropped in-memory cache) can never diverge.
 */

export interface LensChipView {
  readonly lens: string;
  readonly state: string;
  readonly agentId: string | null;
  readonly note: string | null;
  /** Structured verdict parsed off the outcome note (null until a lens
   * records `verdict — evidence`; error/pending chips stay null). */
  readonly verdict: string | null;
}

/** One lens's retry count inside a round (the wave's attempt counter,
 * read back off the child agents registered for the round). */
export interface LensAttemptView {
  readonly lens: string;
  readonly attempts: number;
}

export interface RoundView {
  readonly id: string;
  readonly seq: number;
  readonly status: string;
  readonly verdict: string | null;
  readonly targetRef: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lenses: readonly LensChipView[];
  /** Per-lens attempt counts — only lenses with ≥1 bound child appear. */
  readonly lensAttempts: readonly LensAttemptView[];
  /** Lenses whose recorded outcome verdict is `blocker` (0 until outcomes land). */
  readonly blockers: number;
}

/** The job's managed worktree lane as the board's lane strip renders it
 * (null when the job has no worktree row at all). */
export interface LaneView {
  readonly branch: string | null;
  readonly sha: string;
  readonly status: string;
  readonly createdAt: string;
}

/** PR state the board buckets on (board UX v4). `open`/`merged` are
 * derived from the record today; `conflicting` is the cascade-promoter
 * signal the PR-state sweep will write — the board consumes it the day
 * it appears, and never invents it. */
export type JobPrState = 'open' | 'conflicting' | 'merged';

export interface JobView {
  readonly id: string;
  readonly repo: string;
  readonly title: string;
  readonly status: JobStatus;
  readonly updatedAt: string;
  readonly prUrl: string | null;
  readonly prState: JobPrState | null;
  readonly baseBranch: string | null;
  readonly note: string | null;
  readonly rounds: readonly RoundView[];
  /** The job's lane (active preferred), null when never created. */
  readonly lane: LaneView | null;
  /** Newest lastActivity across the job's bound agents (null when none). */
  readonly lastAgentActivity: string | null;
}

/** Issue #171 runtime ownership: the agent ids the LIVE process owns
 * (registry handles ∪ supervision records ∪ durable stops — the caller
 * unions them). `null` from the probe means "cannot answer" (unwired),
 * which the board reports as `unverified` — never a guessed class. */
export interface RuntimeOwnership {
  readonly ownedAgentIds: ReadonlySet<string>;
}

/** Issue #171 membership classification for one agent record:
 * - `current` — the live runtime owns the record (live handle,
 *   supervision adoption, or a hydrated durable stop — a stopped or
 *   restoring lane stays current, never retired);
 * - `historical` — ownership probes are wired and the record is NOT in
 *   the live ownership set: a previous run/import left it. Transcripts
 *   stay accessible; it is never counted or sorted as an active worker;
 * - `unverified` — no ownership evidence either way (probes unwired or
 *   unavailable): an explicit conservative state, never fabricated
 *   certainty in either direction. */
export type AgentRuntimeClass = 'current' | 'historical' | 'unverified';

export interface AgentView {
  readonly id: string;
  readonly role: Role;
  readonly label: string | null;
  readonly state: AgentState;
  /** Issue #171 truthful display status: the raw adapter state corrected
   * by supervision activity evidence — a raw `idle` with an open turn,
   * open control or open tool call is WORKING and reads `streaming`, so a
   * live agent never presents a settled idle turn. `state` keeps the raw
   * record for the transcript/archaeology surface. */
  readonly status: AgentState;
  /** Issue #171 runtime ownership classification (AgentRuntimeClass). */
  readonly runtime: AgentRuntimeClass;
  readonly lastActivity: string | null;
  /** Row registration stamp: the board's stall clock floor for a fresh
   * worker that has not sent its first frame (twelve-followthrough A1/E1). */
  readonly createdAt: string;
  readonly sessionFile: string | null;
  readonly jobId: string | null;
  readonly roundId: string | null;
  /** E7 supervision view (null when the agent is unsupervised/not live). */
  readonly supervision: AgentSupervisionView | null;
}

export interface NotificationView {
  readonly id: string;
  readonly ts: string;
  readonly kind: string;
  readonly routing: 'fyi' | 'action-required' | 'needs-owner';
  readonly severity: 'info' | 'error';
  readonly title: string;
  readonly detail: string | null;
  readonly agentId: string | null;
  readonly shownAt: string | null;
  readonly ackedAt: string | null;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
}

/** Silas ops health (board UX v4, issue #163): the newest wake (sweep or
 * event), the newest accepted tick/reconciliation observations, the
 * current open model-turn start, and today's state-correction actions —
 * all derived from the durable event stream. `lastWakeAt` is deliberately
 * the wake START marker, never a completed scan; `lastReconcileAt` only
 * advances on a successfully completed deterministic pass. */
export interface SilasView {
  readonly lastWakeAt: string | null;
  /** Newest accepted trigger (timer tick or bus event). */
  readonly lastTickAt: string | null;
  /** Newest SUCCESSFUL deterministic reconciliation pass. */
  readonly lastReconcileAt: string | null;
  /** Newest FAILED deterministic reconciliation pass (never counted as
   * completion). */
  readonly lastReconcileFailedAt: string | null;
  /** True when the newest pass failure is NEWER than the newest pass
   * success (compared by durable event sequence, so same-millisecond
   * passes cannot tie-break wrongly). */
  readonly reconcileFailedNewer: boolean;
  /** Newest state-correction action (register PR, trigger review,
   * directive, rebrief, escalation). */
  readonly lastUsefulActionAt: string | null;
  /** The current open model turn's start (latest wake marker while
   * supervision reports an open turn); null when no turn is open. */
  readonly openTurnSince: string | null;
  readonly reconciliationsToday: number;
  readonly checkedAt: string;
}

/** Self-healing stats (board UX v4): sessions resumed vs orphaned since
 * boot. Null until a producer exists — the board renders `n/a` rather
 * than a fabricated zero. */
export interface SelfHealView {
  readonly sessionsResumed: number;
  readonly sessionsOrphaned: number;
  readonly since: string | null;
}

export interface BoardSnapshot {
  readonly repos: readonly { readonly name: string; readonly jobs: readonly JobView[] }[];
  readonly agents: readonly AgentView[];
  readonly notifications: readonly NotificationView[];
  readonly decisions: DecisionRuntimeStatus;
  /** NEEDS GRU: machine-attention rows still awaiting a disposition
   * (self-clearing machine queue; never rings the owner bell). Counted
   * LIVE: rows bound to a terminal (merged/done) job are closed receipts —
   * the record keeps them, this count (and the banding) does not. Read
   * from the table, not the 30-row feed window, so the tracker is true. */
  readonly unackedActionRequired: number;
  /** FOR YOU: needs-owner rows still awaiting a human ack — the only
   * class that rings the bell. */
  readonly unackedNeedsOwner: number;
  /** Autonomous Gru turns recorded as durable `gru.wake` events. */
  readonly wakes: { readonly count: number; readonly lastAt: string | null };
  /** Running build vs origin/main (null when the tracker is unwired). */
  readonly build: DeployDriftView | null;
  /** Silas ops health, derived from the ledger event stream. */
  readonly silas: SilasView;
  /** Verification scheduler queue (null until its API is wired). */
  readonly verify: VerificationQueueView | null;
  /** Provider pacing gate (limits, running, queued with reasons). Null when
   * the pacing feature is off — the pre-pacing snapshot shape. */
  readonly pacing: PacingGateView | null;
  /** Self-healing session stats (null until its producer exists). */
  readonly selfHeal: SelfHealView | null;
  /** FOR YOU (owner approval 2026-09-28): PRs with exact-head evidence
   * that they are genuinely ready for the owner — approved head-bound
   * review round + clean mergeable state + green CI at the same sha.
   * Fail-closed: absent readiness renders no row, never a guess. */
  readonly ownerPrs: readonly OwnerPrView[];
}

/** Agent-rail ordering: the standing crew first, workers after. */
const ROLE_ORDER: Readonly<Record<Role, number>> = { gru: 0, silas: 1, perkins: 2, minion: 3, bob: 4 };

/** Issue #171 membership bands come FIRST — a historical record must
 * never outrank any current or unverified row, whatever stale state it
 * froze in. `unverified` sits between: not claimed active, not retired. */
const RUNTIME_ORDER: Readonly<Record<AgentRuntimeClass, number>> = {
  current: 0,
  unverified: 1,
  historical: 2,
};

/** Liveness-first rail order INSIDE a membership band: agents actively
 * working float to the top, the graveyard sinks. Liveness IS the primary
 * key inside the band — an old disposed chat epoch must never outrank a
 * streaming lens (role order and recency are only tiebreakers inside one
 * liveness band). Keyed on the DERIVED status (#171): a raw-idle agent
 * with an open supervision turn sorts as the live work it is. */
const STATE_ORDER: Readonly<Record<AgentState, number>> = {
  streaming: 0,
  spawning: 1,
  idle: 2,
  error: 3,
  disposed: 4,
};

/** Lens outcomes mint notes as `${verdict} — ${evidence}` (the Perkins
 * wave); the verdict prefix is the only structured part, so it is parsed
 * ONCE here and every board surface sees one shape. */
const LENS_VERDICTS = ['blocker', 'warning', 'note', 'clean'] as const;

/** Silas event kinds the health card reads: the wake is the activity
 * marker, reconciliations are the state-correction events that moved the
 * board (registering a PR, triggering review, directives, rebriefs,
 * escalations). */
const SILAS_WAKE_KINDS = ['silas.wake'] as const;
/** Tick observations and deterministic-pass outcomes (issue #163). */
const SILAS_TICK_KINDS = ['silas.tick'] as const;
const SILAS_RECONCILE_KINDS = ['silas.reconcile'] as const;
const SILAS_RECONCILE_FAILED_KINDS = ['silas.reconcile-failed'] as const;
/** State-correction and machine-action events that moved the board
 * (registering a PR, triggering review, directives, settlements,
 * rebriefs, escalations). */
const SILAS_ACTION_KINDS = [
  'silas.pr-registered',
  'silas.review-triggered',
  'silas.directive-sent',
  'silas.directive-settled',
  'silas.rebrief',
  'silas.escalated',
] as const;

/** Durable machine follow-through the deterministic pass finishes (issue
 * #163): phase hand-backs and obligation writes/settlements are machine
 * reconciliations even though they are not `silas.*` events. Counted and
 * surfaced consistently with the actions above (the card labels them
 * "machine reconciliations"). */
const MACHINE_ACTION_KINDS = [
  'job.phase-handoff-completed',
  'job.obligation-recorded',
  'job.obligation-settled',
] as const;
const RECONCILE_ACTION_KINDS = [...SILAS_ACTION_KINDS, ...MACHINE_ACTION_KINDS] as const;

/** PR state from the record: a terminal `merged` job is merged; a
 * registered URL is open. `conflicting` has no writer yet — the PR-state
 * sweep will land it, and the board already buckets on it. */
function prStateOf(job: Pick<JobRecord, 'status' | 'prUrl'>): JobView['prState'] {
  if (job.status === 'merged') return 'merged';
  if (job.prUrl !== null) return 'open';
  return null;
}

function lensVerdictFromNote(note: string | null): string | null {
  if (note === null) return null;
  for (const verdict of LENS_VERDICTS) {
    if (note.startsWith(`${verdict} — `)) return verdict;
  }
  return null;
}

/** Issue #171 truthful status: supervision activity evidence wins over a
 * raw `idle` — an open turn, an open control phase or an open tool call
 * IS live work (fresh events/growing session file), never a settled idle
 * turn. Only positive evidence upgrades; absence of supervision never
 * downgrades a raw `streaming` (no hang diagnosis from silence — the
 * watchdog owns that call). */
function derivedStatus(state: AgentState, supervision: AgentSupervisionView | null): AgentState {
  if (supervision === null || state !== 'idle') return state;
  const openWork =
    supervision.openTurn || supervision.openControl === true || supervision.openToolCalls > 0;
  return openWork ? 'streaming' : state;
}

/** Whole-PR review specialists mint bare `lens` labels; a retry appends
 * `#attempt` (`blind#2`). Legacy chunk-era `lens:chunk` labels are still
 * parsed so historical agent rows keep resolving. */
function lensFromAgentLabel(label: string | null): string | null {
  if (label === null || label === '') return null;
  const withoutAttempt = label.split('#', 1)[0]!;
  if (withoutAttempt === '') return null;
  const cut = withoutAttempt.indexOf(':');
  if (cut > 0) return withoutAttempt.slice(0, cut);
  return withoutAttempt.includes('/') || withoutAttempt === 'lead' ? null : withoutAttempt;
}

export interface BoardEngineOptions {
  readonly ledger: LedgerApi;
  readonly bus: EventBus;
  readonly log?: Log;
  /** E7: live supervision views per agent id (late-bound — main wires it
   * to the supervisor after both exist). */
  readonly supervisionFor?: (agentId: string) => AgentSupervisionView | null;
  /** Issue #171: current-runtime ownership probe (live registry handles).
   * Wiring EITHER probe makes absence-of-evidence authoritative for
   * `historical` classification; wiring NEITHER yields `unverified`. */
  readonly runtimeOwnership?: () => RuntimeOwnership | null;
  readonly decisionsStatus?: () => DecisionRuntimeStatus;
  /** Board UX v4: deploy drift view (late-bound tracker). */
  readonly buildDrift?: () => DeployDriftView | null;
  /** Board UX v4: verification queue view (late-bound scheduler). */
  readonly verifyQueue?: () => VerificationQueueView | null;
  /** Provider pacing: gate view (late-bound; null when the feature is off). */
  readonly pacing?: () => PacingGateView | null;
  /** Board UX v4: self-heal stats (no producer yet; null renders n/a). */
  readonly selfHeal?: () => SelfHealView | null;
  /** Clock seam for the day-boundary health derivations. */
  readonly now?: () => number;
}

export class BoardEngine {
  private readonly ledger: LedgerApi;
  private readonly bus: EventBus;
  private readonly log: Log;
  /** listeners fired after any ledger event (snapshot may have changed). */
  private readonly changeListeners = new Set<() => void>();

  constructor(opts: BoardEngineOptions) {
    this.ledger = opts.ledger;
    this.bus = opts.bus;
    this.log = opts.log ?? (() => {});
    this.supervisionFor = opts.supervisionFor ?? (() => null);
    this.ownershipProbe = opts.runtimeOwnership ?? null;
    this.membershipWired = opts.supervisionFor !== undefined || opts.runtimeOwnership !== undefined;
    this.decisionsStatus = opts.decisionsStatus ?? (() => ({
      enabled: false,
      status: 'disabled',
      reason: 'disabled',
      model: '~typesafe/jev-latest',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'board-not-started',
      generation: 0,
    }));
    this.buildDrift = opts.buildDrift ?? (() => null);
    this.verifyQueue = opts.verifyQueue ?? (() => null);
    this.pacing = opts.pacing ?? (() => null);
    this.selfHeal = opts.selfHeal ?? (() => null);
    this.now = opts.now ?? Date.now;
    this.bus.subscribe(() => this.notifyChanged());
  }

  private readonly supervisionFor: (agentId: string) => AgentSupervisionView | null;
  /** Issue #171: the registry-handle ownership probe (null when unwired). */
  private readonly ownershipProbe: (() => RuntimeOwnership | null) | null;
  /** Issue #171: whether ANY ownership probe is wired (supervision feed or
   * the registry probe) — without one, membership is `unverified`. */
  private readonly membershipWired: boolean;
  private readonly decisionsStatus: () => DecisionRuntimeStatus;
  private readonly buildDrift: () => DeployDriftView | null;
  private readonly verifyQueue: () => VerificationQueueView | null;
  private readonly pacing: () => PacingGateView | null;
  private readonly selfHeal: () => SelfHealView | null;
  private readonly now: () => number;

  /** Fired after any event that may have changed the board. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private notifyChanged(): void {
    for (const listener of this.changeListeners) {
      try {
        listener();
      } catch (error) {
        this.log('error', 'board change listener failed', { error: String(error) });
      }
    }
  }

  // ------------------------------------------------------------------
  // Runtime event feed (adapter events → ledger events)
  // ------------------------------------------------------------------

  onRuntimeEvent(envelope: AgentEventEnvelope): void {
    try {
      switch (envelope.phase) {
        case 'spawned':
          this.ledger.registerAgent({
            id: envelope.agentId,
            role: envelope.role,
            sessionFile: envelope.sessionFile,
          });
          break;
        case 'disposed':
          if (this.ledger.getAgent(envelope.agentId) !== null) {
            this.ledger.setAgentState(envelope.agentId, 'disposed');
          }
          break;
        case 'event':
          this.onRuntimeEventInner(envelope);
          break;
      }
    } catch (error) {
      // The board is an observer of the runtime — a ledger hiccup (e.g. a
      // known-but-unregistered id) must never take the runtime path down.
      this.log('error', 'board engine failed to record runtime event', {
        agent_id: envelope.agentId,
        phase: envelope.phase,
        error: String(error),
      });
    }
  }

  private onRuntimeEventInner(envelope: AgentEventEnvelope): void {
    const event = envelope.event;
    if (event === undefined) return;
    if (this.ledger.getAgent(envelope.agentId) === null) {
      // Late subscriber: an agent spawned before the engine attached —
      // register it now so the event below has a row to update.
      this.ledger.registerAgent({
        id: envelope.agentId,
        role: envelope.role,
        sessionFile: envelope.sessionFile,
      });
    }
    switch (event.type) {
      case 'state':
        this.ledger.setAgentState(envelope.agentId, event.state, event.error);
        if (event.state === 'error') this.deriveLensError(envelope.agentId);
        break;
      case 'turn_start': {
        // A live turn keeps last_activity fresh and flips a bound lens chip live.
        const agent = this.ledger.getAgent(envelope.agentId);
        if (agent !== null) this.ledger.setAgentState(envelope.agentId, agent.state);
        this.deriveLensLive(envelope.agentId);
        break;
      }
      case 'turn_end':
        this.ledger.setAgentState(envelope.agentId, 'idle');
        break;
      case 'error':
        if (event.fatal) this.deriveLensError(envelope.agentId);
        this.ledger.appendCustomEvent({
          kind: 'agent.error',
          agentId: envelope.agentId,
          payload: { error: event.error, fatal: event.fatal },
        });
        break;
      default:
        break; // deltas/tool traffic need no ledger rows (bounded history)
    }
  }

  /** All (round, lens) chips bound to this agent id — indexed query. */
  private lensBindingsFor(agentId: string): { roundId: string; lens: string }[] {
    return this.ledger
      .listLensBindings(agentId)
      .filter((binding) => this.ledger.getRound(binding.roundId) !== null);
  }

  private deriveLensLive(agentId: string): void {
    for (const binding of this.lensBindingsFor(agentId)) {
      this.ledger.markLensLive(binding.roundId, binding.lens);
    }
  }

  private deriveLensError(agentId: string): void {
    for (const binding of this.lensBindingsFor(agentId)) {
      const round = this.ledger.getRound(binding.roundId);
      const chip = round?.lenses.find((entry) => entry.lens === binding.lens);
      if (chip !== undefined && (chip.state === 'pending' || chip.state === 'live')) {
        this.ledger.setLensOutcome(binding.roundId, binding.lens, 'error', 'agent session errored');
      }
    }
  }

  // ------------------------------------------------------------------
  // Snapshot (repo-grouped) — read straight from the record
  // ------------------------------------------------------------------

  snapshot(): BoardSnapshot {
    const jobs = this.ledger.listJobs();
    const agentRows = this.ledger.listAgents();
    // Issue #171: ONE ownership read per snapshot (the probe rebuilds a
    // set of every live handle) and ONE supervision lookup per row — the
    // same evidence serves the activity projection and the agent views.
    const ownership = this.ownershipProbe?.() ?? null;
    const supervisionById = new Map<string, AgentSupervisionView | null>(
      agentRows.map((agent) => [agent.id, this.supervisionFor(agent.id)]),
    );
    const runtimeClassOf = (agent: AgentRecord): AgentRuntimeClass =>
      this.classifyRuntime(agent.id, supervisionById.get(agent.id) ?? null, ownership);
    // Per-job newest agent activity and per-round lens attempt counts are
    // derived once per snapshot from the same agent rows (ISO stamps
    // compare lexicographically; lens children mint `lens:chunk` labels).
    const activityByJob = new Map<string, string>();
    const attemptsByRound = new Map<string, Map<string, number>>();
    for (const agent of agentRows) {
      // Issue #171: a verified-historical record's frozen stamp is not
      // current activity — it must never warm the lane's stall clock.
      if (
        agent.jobId !== null &&
        agent.lastActivity !== null &&
        runtimeClassOf(agent) !== 'historical'
      ) {
        const newest = activityByJob.get(agent.jobId);
        if (newest === undefined || agent.lastActivity > newest) activityByJob.set(agent.jobId, agent.lastActivity);
      }
      const lens = lensFromAgentLabel(agent.label);
      if (agent.roundId !== null && lens !== null) {
        const perLens = attemptsByRound.get(agent.roundId) ?? new Map<string, number>();
        perLens.set(lens, (perLens.get(lens) ?? 0) + 1);
        attemptsByRound.set(agent.roundId, perLens);
      }
    }
    // Closed-receipt rule (owner decisions D1/D3): a machine row bound
    // through an agent to a merged/done job is a receipt, not live work.
    const concludedJobs = new Set(
      jobs.filter((job) => job.status === 'merged' || job.status === 'done').map((job) => job.id),
    );
    const agentJob = new Map(
      agentRows.filter((agent) => agent.jobId !== null).map((agent) => [agent.id, agent.jobId as string]),
    );
    const isReceipt = (agentId: string | null): boolean => {
      if (agentId === null || concludedJobs.size === 0) return false;
      const jobId = agentJob.get(agentId);
      return jobId !== undefined && concludedJobs.has(jobId);
    };
    const repos = [...this.jobViews(jobs, activityByJob, attemptsByRound).entries()]
      .map(([name, group]) => ({ name, jobs: group }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const agents = agentRows
      .map((agent) => this.agentView(agent, supervisionById.get(agent.id) ?? null, ownership))
      .sort(
        (a, b) =>
          RUNTIME_ORDER[a.runtime] - RUNTIME_ORDER[b.runtime] ||
          STATE_ORDER[a.status] - STATE_ORDER[b.status] ||
          (ROLE_ORDER[a.role] ?? 99) - (ROLE_ORDER[b.role] ?? 99) ||
          (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''),
      );
    // Issue #163: the open-turn start is a led+supervision fact, never a
    // wake-marker age. A silas record whose live supervision says an open
    // turn exists is the only source of "a turn is open right now".
    const silasTurnOpen = agentRows.some(
      (agent) => agent.role === 'silas' && supervisionById.get(agent.id)?.openTurn === true,
    );
    return {
      repos,
      agents,
      notifications: this.notifications(isReceipt),
      decisions: this.decisionsStatus(),
      unackedActionRequired: this.ledger.countLivePendingActionRequired(),
      unackedNeedsOwner: this.ledger.countPendingNeedsOwner(),
      wakes: {
        count: this.ledger.countEvents('gru.wake'),
        lastAt: this.ledger.latestEventOfKind('gru.wake')?.ts ?? null,
      },
      build: this.buildDrift(),
      silas: this.silasView(silasTurnOpen),
      verify: this.verifyQueue(),
      pacing: this.pacing(),
      selfHeal: this.selfHeal(),
      ownerPrs: this.ownerPrs(repos),
    };
  }

  /** The FOR YOU PR projection: one authoritative, evidence-bound ready
   * list over the snapshot's own job views (deterministic job-id order —
   * a stable row order across pushes). Only in-review jobs with a PR
   * reach the evidence read — the cheap gates run first. */
  private ownerPrs(
    repos: readonly { readonly name: string; readonly jobs: readonly JobView[] }[],
  ): readonly OwnerPrView[] {
    return repos
      .flatMap((repo) => repo.jobs)
      .filter((job) => job.status === 'in-review' && job.prUrl !== null)
      .map((job) => ownerReadyPr(job, readBranchEvidence(this.ledger, job.id)))
      .filter((row): row is OwnerPrView => row !== null)
      .sort((left, right) => left.jobId.localeCompare(right.jobId));
  }

  /** Silas ops health from the durable event stream: newest wake (start
   * marker), newest accepted tick, newest successful/failed deterministic
   * pass, newest corrective action and — when supervision says a turn is
   * open — that turn's start (issue #163). `reconciliationsToday` stays the
   * state-correction count; a tick or a failed pass never claims it. */
  private silasView(openTurn: boolean): SilasView {
    const now = this.now();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    const wake = this.ledger.latestEventOfKinds(SILAS_WAKE_KINDS);
    const reconcileOk = this.ledger.latestEventOfKinds(SILAS_RECONCILE_KINDS);
    const reconcileFailed = this.ledger.latestEventOfKinds(SILAS_RECONCILE_FAILED_KINDS);
    return {
      lastWakeAt: wake?.ts ?? null,
      lastTickAt: this.ledger.latestEventOfKinds(SILAS_TICK_KINDS)?.ts ?? null,
      // The success timestamp only ever advances on a completed pass; a
      // later failure does not erase it, and a failure never sets it.
      lastReconcileAt: reconcileOk?.ts ?? null,
      lastReconcileFailedAt: reconcileFailed?.ts ?? null,
      reconcileFailedNewer:
        reconcileFailed !== null && (reconcileOk === null || reconcileFailed.seq > reconcileOk.seq),
      lastUsefulActionAt: this.ledger.latestEventOfKinds(RECONCILE_ACTION_KINDS)?.ts ?? null,
      openTurnSince: openTurn ? (wake?.ts ?? null) : null,
      reconciliationsToday: this.ledger.countEventsSince(RECONCILE_ACTION_KINDS, dayStart.toISOString()),
      checkedAt: new Date(now).toISOString(),
    };
  }

  /** Repo-grouped job views (the group map preserves ledger job order). */
  private jobViews(
    jobs: readonly JobRecord[],
    activityByJob: ReadonlyMap<string, string>,
    attemptsByRound: ReadonlyMap<string, ReadonlyMap<string, number>>,
  ): Map<string, JobView[]> {
    const byRepo = new Map<string, JobView[]>();
    for (const job of jobs) {
      const view = this.jobView(job, activityByJob.get(job.id) ?? null, attemptsByRound);
      const group = byRepo.get(job.repo) ?? [];
      group.push(view);
      byRepo.set(job.repo, group);
    }
    return byRepo;
  }

  private jobView(
    job: JobRecord,
    lastAgentActivity: string | null,
    attemptsByRound: ReadonlyMap<string, ReadonlyMap<string, number>>,
  ): JobView {
    // Lane strip data (E8 registry): the active lane wins; a swept/paused
    // lane still renders the last known position for the record.
    const lanes = this.ledger.listWorktrees({ jobId: job.id }).filter((lane) => lane.kind === 'job');
    const lane = lanes.find((candidate) => candidate.status === 'active') ?? lanes.at(-1) ?? null;
    return {
      id: job.id,
      repo: job.repo,
      title: job.title,
      status: job.status,
      updatedAt: job.updatedAt,
      prUrl: job.prUrl,
      prState: prStateOf(job),
      baseBranch: job.baseBranch,
      note: job.note,
      rounds: this.ledger
        .listRounds(job.id)
        .map((round) => this.roundView(round, attemptsByRound.get(round.id) ?? new Map<string, number>())),
      lane:
        lane === null
          ? null
          : { branch: lane.branch, sha: lane.sha, status: lane.status, createdAt: lane.createdAt },
      lastAgentActivity,
    };
  }

  private roundView(round: RoundRecord, attemptsByLens: ReadonlyMap<string, number>): RoundView {
    const lenses = round.lenses.map((chip) => ({
      lens: chip.lens,
      state: chip.state,
      agentId: chip.agentId,
      note: chip.note,
      verdict: lensVerdictFromNote(chip.note),
    }));
    return {
      id: round.id,
      seq: round.seq,
      status: round.status,
      verdict: round.verdict,
      targetRef: round.targetRef,
      createdAt: round.createdAt,
      updatedAt: round.updatedAt,
      lenses,
      lensAttempts: [...attemptsByLens.entries()]
        .filter(([lens]) => round.lenses.some((chip) => chip.lens === lens))
        .map(([lens, attempts]) => ({ lens, attempts }))
        .sort((left, right) => left.lens.localeCompare(right.lens)),
      blockers: lenses.filter((chip) => chip.verdict === 'blocker').length,
    };
  }

  private agentView(
    agent: AgentRecord,
    supervision: AgentSupervisionView | null,
    ownership: RuntimeOwnership | null,
  ): AgentView {
    return {
      id: agent.id,
      role: agent.role,
      label: agent.label,
      state: agent.state,
      status: derivedStatus(agent.state, supervision),
      runtime: this.classifyRuntime(agent.id, supervision, ownership),
      lastActivity: agent.lastActivity,
      // The row's registration stamp: the board's stall clock floor for a
      // fresh worker that has not sent its first frame (twelve-followthrough A1/E1).
      createdAt: agent.createdAt,
      sessionFile: agent.sessionFile,
      jobId: agent.jobId,
      roundId: agent.roundId,
      supervision,
    };
  }

  /** Issue #171 membership for one record. A supervision view (live
   * adoption or a hydrated durable stop — a stopped/restoring lane is
   * OWNED, never retired) or a live registry handle proves `current`.
   * With a probe wired and ANSWERING, absence from the ownership set is
   * VERIFIED non-membership → `historical` (the record predates this
   * runtime: unclean stop, restart, or import). A wired probe answering
   * `null` (temporarily unavailable) is missing evidence → `unverified`,
   * as is a board with no witness wired at all. */
  private classifyRuntime(
    agentId: string,
    supervision: AgentSupervisionView | null,
    ownership: RuntimeOwnership | null,
  ): AgentRuntimeClass {
    if (supervision !== null) return 'current';
    if (this.ownershipProbe !== null) {
      // The registry probe is the wired witness: an ANSWER classifies
      // (member → current, verified absence → historical); a null answer
      // is missing evidence → unverified, never a guessed class.
      if (ownership === null) return 'unverified';
      return ownership.ownedAgentIds.has(agentId) ? 'current' : 'historical';
    }
    // No registry probe: the supervision feed (which sees every spawn via
    // the registry tap) is the sole wired witness — its verified absence
    // is authoritative. With no witness at all, unverified.
    return this.membershipWired ? 'historical' : 'unverified';
  }

  /**
   * The closed-receipt rule (owner decisions D1/D3) for out-of-band
   * callers (the paged receipt route): a row bound through an agent to a
   * merged/done job. The snapshot scan uses a map-built predicate instead
   * so the unbounded walk stays one query per page.
   */
  isClosedReceipt(agentId: string | null): boolean {
    if (agentId === null) return false;
    const agent = this.ledger.getAgent(agentId);
    if (agent === null || agent.jobId === null) return false;
    const job = this.ledger.getJob(agent.jobId);
    return job !== null && (job.status === 'merged' || job.status === 'done');
  }

  /**
   * Notification center feed (E7): the durable notification log, newest
   * first. Since E7 the feed is the LEDGER's notifications table —
   * FYI rows derive once at event time (the notification center posts
   * them), action-required rows carry acks; nothing is computed here.
   *
   * Boundedness (owner decision D3, code review 2026-10-04): closed
   * receipts stay unacked forever by design, so the unbounded pending scan
   * now carries LIVE rows only; the newest RECEIPT_WINDOW receipts stay in
   * the snapshot and older ones are served by the paged receipt route.
   */
  notifications(isReceipt?: (agentId: string | null) => boolean, limit = 30): readonly NotificationView[] {
    // The snapshot passes its map-built predicate (one query per page);
    // direct callers keep the single-row lookup fallback.
    const receiptOf =
      isReceipt ?? ((agentId: string | null): boolean => this.isClosedReceipt(agentId));
    const byId = new Map(this.ledger.listNotifications({ limit }).map((row) => [row.id, row]));
    for (const routing of ['needs-owner', 'action-required'] as const) {
      let retainedReceipts = 0;
      for (let offset = 0;; offset += 50) {
        const page = this.ledger.listNotifications({ unackedOnly: true, routing, limit: 50, offset });
        for (const row of page) {
          // needs-owner rows stay on the owner path by contract; only
          // action-required rows participate in the receipt rule.
          if (routing === 'action-required' && receiptOf(row.agentId)) {
            if (retainedReceipts < RECEIPT_WINDOW) {
              byId.set(row.id, row);
              retainedReceipts += 1;
            }
            continue;
          }
          byId.set(row.id, row);
        }
        if (page.length < 50) break;
      }
    }
    return [...byId.values()]
      .sort((a, b) => b.ts.localeCompare(a.ts) || a.id.localeCompare(b.id))
      .map((row) => ({
        id: row.id,
        ts: row.ts,
        kind: row.kind,
        routing: row.routing,
        severity: row.severity,
        title: row.title,
        detail: row.detail,
        agentId: row.agentId,
        shownAt: row.shownAt,
        ackedAt: row.ackedAt,
        resolvedAt: row.resolvedAt,
        resolvedBy: row.resolvedBy,
      }));
  }

  /** Default lens set (exposed for the write API's docs + tests). */
  static get defaultLenses(): readonly string[] {
    return DEFAULT_LENSES;
  }
}
