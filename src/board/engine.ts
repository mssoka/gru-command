import type { Role } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { AgentState } from '../runtime/types.js';
import type { AgentEventEnvelope } from '../runtime/registry.js';
import type { EventBus } from '../events/bus.js';
import type { AgentSupervisionView } from '../supervision/supervisor.js';
import type { DecisionRuntimeStatus } from '../decisions/runtime.js';
import type { DeployDriftView } from './deploy-drift.js';
import type { VerificationQueueView } from '../verify/scheduler.js';
import {
  DEFAULT_LENSES,
  LedgerApi,
  type AgentRecord,
  type JobRecord,
  type NotificationRecord,
  type RoundRecord,
} from '../ledger/api.js';
import type { JobStatus } from '../ledger/states.js';

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

export interface AgentView {
  readonly id: string;
  readonly role: Role;
  readonly label: string | null;
  readonly state: AgentState;
  readonly lastActivity: string | null;
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
  readonly routing: 'fyi' | 'action-required';
  readonly severity: 'info' | 'error';
  readonly title: string;
  readonly detail: string | null;
  readonly agentId: string | null;
  readonly shownAt: string | null;
  readonly ackedAt: string | null;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
}

/** Silas ops health (board UX v4): the newest wake (sweep or event) and
 * how many reconciliation events landed today. Derived from the durable
 * event stream — the ledger is the record. */
export interface SilasView {
  readonly lastWakeAt: string | null;
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
  /** Action-required notifications still awaiting a human ack (a
   * system-resolved incident no longer needs human action). Counted from
   * the table, not the 30-row feed window, so the badge stays true. */
  readonly unackedActionRequired: number;
  /** Running build vs origin/main (null when the tracker is unwired). */
  readonly build: DeployDriftView | null;
  /** Silas ops health, derived from the ledger event stream. */
  readonly silas: SilasView;
  /** Verification scheduler queue (null until its API is wired). */
  readonly verify: VerificationQueueView | null;
  /** Self-healing session stats (null until its producer exists). */
  readonly selfHeal: SelfHealView | null;
}

/** Agent-rail ordering: the standing crew first, workers after. */
const ROLE_ORDER: Readonly<Record<Role, number>> = { gru: 0, silas: 1, perkins: 2, minion: 3, bob: 4 };

/** Liveness-first rail order: agents actively working float to the top,
 * the graveyard sinks. Liveness IS the primary key — an old disposed chat
 * epoch must never outrank a streaming lens (role order and recency are
 * only tiebreakers inside one liveness band). */
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
const SILAS_RECONCILE_KINDS = [
  'silas.pr-registered',
  'silas.review-triggered',
  'silas.directive-sent',
  'silas.rebrief',
  'silas.escalated',
] as const;

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
  readonly decisionsStatus?: () => DecisionRuntimeStatus;
  /** Board UX v4: deploy drift view (late-bound tracker). */
  readonly buildDrift?: () => DeployDriftView | null;
  /** Board UX v4: verification queue view (late-bound scheduler). */
  readonly verifyQueue?: () => VerificationQueueView | null;
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
    this.selfHeal = opts.selfHeal ?? (() => null);
    this.now = opts.now ?? Date.now;
    this.bus.subscribe(() => this.notifyChanged());
  }

  private readonly supervisionFor: (agentId: string) => AgentSupervisionView | null;
  private readonly decisionsStatus: () => DecisionRuntimeStatus;
  private readonly buildDrift: () => DeployDriftView | null;
  private readonly verifyQueue: () => VerificationQueueView | null;
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
    // Per-job newest agent activity and per-round lens attempt counts are
    // derived once per snapshot from the same agent rows (ISO stamps
    // compare lexicographically; lens children mint `lens:chunk` labels).
    const activityByJob = new Map<string, string>();
    const attemptsByRound = new Map<string, Map<string, number>>();
    for (const agent of agentRows) {
      if (agent.jobId !== null && agent.lastActivity !== null) {
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
    const repos = [...this.jobViews(jobs, activityByJob, attemptsByRound).entries()]
      .map(([name, group]) => ({ name, jobs: group }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const agents = agentRows
      .map((agent) => this.agentView(agent))
      .sort(
        (a, b) =>
          STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
          (ROLE_ORDER[a.role] ?? 99) - (ROLE_ORDER[b.role] ?? 99) ||
          (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''),
      );
    return {
      repos,
      agents,
      notifications: this.notifications(),
      decisions: this.decisionsStatus(),
      unackedActionRequired: this.ledger.countPendingActionRequired(),
      build: this.buildDrift(),
      silas: this.silasView(),
      verify: this.verifyQueue(),
      selfHeal: this.selfHeal(),
    };
  }

  /** Silas ops health from the durable event stream: newest wake + today's
   * reconciliations (state-correction events, not the wake itself). */
  private silasView(): SilasView {
    const now = this.now();
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);
    return {
      lastWakeAt: this.ledger.latestEventOfKinds(SILAS_WAKE_KINDS)?.ts ?? null,
      reconciliationsToday: this.ledger.countEventsSince(SILAS_RECONCILE_KINDS, dayStart.toISOString()),
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

  private agentView(agent: AgentRecord): AgentView {
    return {
      id: agent.id,
      role: agent.role,
      label: agent.label,
      state: agent.state,
      lastActivity: agent.lastActivity,
      sessionFile: agent.sessionFile,
      jobId: agent.jobId,
      roundId: agent.roundId,
      supervision: this.supervisionFor(agent.id),
    };
  }

  /**
   * Notification center feed (E7): the durable notification log, newest
   * first. Since E7 the feed is the LEDGER's notifications table —
   * FYI rows derive once at event time (the notification center posts
   * them), action-required rows carry acks; nothing is computed here.
   */
  notifications(limit = 30): readonly NotificationView[] {
    return this.ledger
      .listNotifications({ limit })
      .map((row: NotificationRecord) => ({
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
