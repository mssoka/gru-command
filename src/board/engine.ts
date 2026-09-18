import type { Role } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { AgentState } from '../runtime/types.js';
import type { AgentEventEnvelope } from '../runtime/registry.js';
import type { EventBus } from '../events/bus.js';
import type { AgentSupervisionView } from '../supervision/supervisor.js';
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
}

export interface RoundView {
  readonly id: string;
  readonly seq: number;
  readonly status: string;
  readonly verdict: string | null;
  readonly targetRef: string | null;
  readonly updatedAt: string;
  readonly lenses: readonly LensChipView[];
}

export interface JobView {
  readonly id: string;
  readonly repo: string;
  readonly title: string;
  readonly status: JobStatus;
  readonly updatedAt: string;
  readonly prUrl: string | null;
  readonly baseBranch: string | null;
  readonly note: string | null;
  readonly rounds: readonly RoundView[];
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
}

export interface BoardSnapshot {
  readonly repos: readonly { readonly name: string; readonly jobs: readonly JobView[] }[];
  readonly agents: readonly AgentView[];
  readonly notifications: readonly NotificationView[];
}

/** Agent-rail ordering: the standing crew first, workers after. */
const ROLE_ORDER: Readonly<Record<Role, number>> = { gru: 0, silas: 1, perkins: 2, minion: 3, bob: 4 };

export interface BoardEngineOptions {
  readonly ledger: LedgerApi;
  readonly bus: EventBus;
  readonly log?: Log;
  /** E7: live supervision views per agent id (late-bound — main wires it
   * to the supervisor after both exist). */
  readonly supervisionFor?: (agentId: string) => AgentSupervisionView | null;
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
    this.bus.subscribe(() => this.notifyChanged());
  }

  private readonly supervisionFor: (agentId: string) => AgentSupervisionView | null;

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
    const byRepo = new Map<string, JobView[]>();
    for (const job of jobs) {
      const view = this.jobView(job);
      const group = byRepo.get(job.repo) ?? [];
      group.push(view);
      byRepo.set(job.repo, group);
    }
    const repos = [...byRepo.entries()]
      .map(([name, group]) => ({ name, jobs: group }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const agents = this.ledger
      .listAgents()
      .map((agent) => this.agentView(agent))
      .sort(
        (a, b) =>
          (ROLE_ORDER[a.role] ?? 99) - (ROLE_ORDER[b.role] ?? 99) ||
          (b.lastActivity ?? '').localeCompare(a.lastActivity ?? ''),
      );
    return { repos, agents, notifications: this.notifications() };
  }

  private jobView(job: JobRecord): JobView {
    return {
      id: job.id,
      repo: job.repo,
      title: job.title,
      status: job.status,
      updatedAt: job.updatedAt,
      prUrl: job.prUrl,
      baseBranch: job.baseBranch,
      note: job.note,
      rounds: this.ledger.listRounds(job.id).map((round) => this.roundView(round)),
    };
  }

  private roundView(round: RoundRecord): RoundView {
    return {
      id: round.id,
      seq: round.seq,
      status: round.status,
      verdict: round.verdict,
      targetRef: round.targetRef,
      updatedAt: round.updatedAt,
      lenses: round.lenses.map((chip) => ({
        lens: chip.lens,
        state: chip.state,
        agentId: chip.agentId,
        note: chip.note,
      })),
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
      }));
  }

  /** Default lens set (exposed for the write API's docs + tests). */
  static get defaultLenses(): readonly string[] {
    return DEFAULT_LENSES;
  }
}
