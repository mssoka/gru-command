import { createHash } from 'node:crypto';
import type { EventBus } from '../events/bus.js';
import { NotificationDecisionRefusal, type LedgerApi, type NotificationRecord } from '../ledger/api.js';
import { parseNotificationDecision, type NotificationDecision } from '../ledger/notification-decision.js';
import type { LogLevel } from '../logger.js';
import type { NotificationCenter } from '../notifications/center.js';
import { resolveManagedRepoPathSync, type ManagedRepoPath } from '../repos/managed-names.js';
import type { RepoMoveOutcome, WorktreeManager } from '../worktrees/manager.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Moved repositories (#427 PR 2b). Moving a managed repository's folder
 * (and updating `workspace_root`) used to break every lane that pointed at
 * it. At service start, before any turn runs, and at the hourly maintenance
 * reconcile, the worktree manager checks every lane whose git link no
 * longer reaches its recorded repository
 * ({@link WorktreeManager.checkMovedRepositories}): the managed repository
 * of the same name that holds the same repository (a shared root commit,
 * and the same `origin` when both have one) gets the lane back through
 * `git worktree repair`, and the registry's `repo_path` follows.
 *
 * A different repository under the name gets one FOR YOU card for the lane
 * (kind {@link REPO_MISMATCH_KIND}): discarding the lane loses whatever it
 * holds, so it is the owner's call (owner ruling 2026-10-16). Accept deletes
 * the lane folder and marks the lane swept, unless the lane reaches its
 * repository again by then. Decline keeps the lane; the card is not posted
 * again while the name resolves to that repository. A card whose lane was
 * reconnected or swept before anyone answered is withdrawn.
 */

/** The owner's Accept/Decline on discarding a lane whose repository is not there. */
export const REPO_MISMATCH_KIND = 'worktree.repo-mismatch';

/** A lane's card for one place its repository's name resolves to: a later
 * place gets a new card, the same place never a second one. */
export function repoMismatchCardId(laneId: string, candidate: string): string {
  return `worktree-repo-mismatch:${laneId}:${createHash('sha256').update(candidate).digest('hex').slice(0, 12)}`;
}

const OWNER_PROVENANCE = { credential: 'internal', declaredActor: null } as const;

export interface RepoMoveReconcilerOptions {
  readonly worktrees: Pick<WorktreeManager, 'checkMovedRepositories' | 'discardLane'>;
  readonly ledger: Pick<LedgerApi, 'getWorktree' | 'listOpenNotificationsByKinds' | 'resolveOwnerDecision' | 'withdrawOwnerProposal' | 'appendCustomEvent' | 'latestEventByPayloadField'>;
  readonly bus: EventBus;
  readonly notifications: Pick<NotificationCenter, 'post'>;
  readonly workspaceRoot: string;
  readonly managedRepos: readonly string[];
  /** Resolve a managed repository's name (default resolveManagedRepoPathSync). */
  readonly resolve?: (workspaceRoot: string, name: string) => ManagedRepoPath;
  readonly log?: Log;
}

export class RepoMoveReconciler {
  private readonly log: Log;
  private unsubscribe: (() => void) | null = null;
  private following: Promise<void> | null = null;
  private followAgain = false;

  constructor(private readonly opts: RepoMoveReconcilerOptions) {
    this.log = opts.log ?? (() => {});
  }

  /** Follow the owner's answers as they are recorded. */
  start(): void {
    if (this.unsubscribe !== null) return;
    this.unsubscribe = this.opts.bus.subscribe((event) => {
      if (event.kind !== 'notification.decision') return;
      const id = (event.payload as { readonly id?: unknown } | null)?.id;
      if (typeof id !== 'string' || !id.startsWith('worktree-repo-mismatch:')) return;
      void this.followCards().catch((error: unknown) => this.log('error', 'a lane discard decision could not be carried out; the next reconcile retries it', { error: String(error) }));
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** The check, then the answered cards (at start and every hour). */
  async reconcile(): Promise<void> {
    this.check();
    await this.followCards();
  }

  /** Repair what moved, propose a discard for a lane whose name now holds a
   * different repository, and withdraw the cards of lanes reconnected or
   * swept. Synchronous: main.ts runs it at start before any turn. */
  check(): readonly RepoMoveOutcome[] {
    const resolve = this.opts.resolve ?? resolveManagedRepoPathSync;
    const outcomes = this.opts.worktrees.checkMovedRepositories({
      managedRepos: this.opts.managedRepos,
      resolve: (name) => resolve(this.opts.workspaceRoot, name),
    });
    for (const outcome of outcomes) {
      try {
        if (outcome.status === 'mismatch') this.propose(outcome);
        else if (outcome.status === 'repaired') this.withdraw(outcome.lane.id, null, 'the lane was reconnected to its repository');
      } catch (error) {
        this.log('error', 'a moved-repository outcome could not be followed; the next reconcile retries it', { id: outcome.lane.id, error: String(error) });
      }
    }
    for (const card of this.opts.ledger.listOpenNotificationsByKinds([REPO_MISMATCH_KIND])) {
      const lane = this.opts.ledger.getWorktree(laneOfCard(card.id) ?? '');
      if ((lane === null || lane.status === 'swept') && card.decidedAt === null) this.withdrawCard(card, 'the lane is gone');
    }
    return outcomes;
  }

  /** Carry out the answered cards: Accept discards the lane, Decline keeps
   * it. One pass at a time; an answer during a pass is taken by another. */
  followCards(): Promise<void> {
    if (this.following !== null) {
      this.followAgain = true;
      return this.following;
    }
    this.following = (async () => {
      do {
        this.followAgain = false;
        for (const card of this.opts.ledger.listOpenNotificationsByKinds([REPO_MISMATCH_KIND])) {
          if (card.decidedOption === null) continue;
          try {
            await this.follow(card);
          } catch (error) {
            this.log('error', 'a lane discard decision could not be carried out; the next reconcile retries it', { notification: card.id, error: String(error) });
          }
        }
      } while (this.followAgain);
    })().finally(() => { this.following = null; });
    return this.following;
  }

  private async follow(card: NotificationRecord): Promise<void> {
    const laneId = laneOfCard(card.id);
    const proposal = this.opts.ledger.latestEventByPayloadField('worktree.repo-mismatch-proposed', 'notification_id', card.id);
    if (laneId === null || proposal === null) {
      this.close(card, 'nothing done: this card names no lane GC proposed to discard');
      return;
    }
    if (card.decidedOption !== 'accept') {
      this.opts.ledger.appendCustomEvent({ kind: 'worktree.repo-mismatch-declined', payload: { id: laneId, notification_id: card.id, by: card.decidedBy ?? 'the owner' } });
      this.close(card, 'the lane is kept');
      return;
    }
    const reason = String((proposal.payload as { readonly reason?: unknown }).reason ?? 'its repository is not there');
    const outcome = await this.opts.worktrees.discardLane(laneId, reason);
    this.close(card, outcome === 'discarded' ? `lane ${laneId} discarded`
      : outcome === 'reconnected' ? `nothing discarded: lane ${laneId} reaches its repository again`
      : `nothing discarded: lane ${laneId} is gone`);
  }

  private propose(outcome: Extract<RepoMoveOutcome, { readonly status: 'mismatch' }>): void {
    const { lane, candidate, reason } = outcome;
    const id = repoMismatchCardId(lane.id, candidate);
    // A card about an earlier place of the name asks a question that no longer exists.
    this.withdraw(lane.id, id, `${lane.repoName} now resolves to ${candidate}`);
    if (this.opts.ledger.latestEventByPayloadField('worktree.repo-mismatch-proposed', 'notification_id', id) === null) {
      this.opts.ledger.appendCustomEvent({
        kind: 'worktree.repo-mismatch-proposed',
        jobId: lane.jobId,
        roundId: lane.roundId,
        payload: { id: lane.id, notification_id: id, path: lane.path, repo_path: lane.repoPath, candidate, reason },
      });
    }
    this.opts.notifications.post({
      id,
      kind: REPO_MISMATCH_KIND,
      routing: 'needs-owner',
      severity: 'info',
      title: `Lane ${lane.id} (${lane.repoName}): its repository is not there`,
      detail: [
        `Lane ${lane.id} (job ${lane.jobId ?? 'none'}) at ${lane.path} was made in ${lane.repoPath}, which no longer holds that repository.`,
        `The managed repository ${lane.repoName} now resolves to ${candidate}, which is a different repository: ${reason}.`,
        'GC reconnects a lane only to the same repository (a shared root commit, and the same origin when both have one), so it cannot reconnect this one.',
        `If the repository moved somewhere else, point workspace_root at its new parent folder and restart the service: GC then reconnects the lane itself.`,
      ].join('\n'),
      decision: repoMismatchDecision(lane.id, lane.path, lane.repoName, candidate),
    });
  }

  /** Withdraw the undecided cards of a lane (all but `keep`). */
  private withdraw(laneId: string, keep: string | null, detail: string): void {
    for (const card of this.opts.ledger.listOpenNotificationsByKinds([REPO_MISMATCH_KIND])) {
      if (card.id !== keep && laneOfCard(card.id) === laneId && card.decidedAt === null) this.withdrawCard(card, detail);
    }
  }

  private withdrawCard(card: NotificationRecord, detail: string): void {
    try {
      this.opts.ledger.withdrawOwnerProposal(card.id, detail);
    } catch (error) {
      if (!(error instanceof NotificationDecisionRefusal)) throw error;
      this.log('warn', 'a lane discard card could not be withdrawn', { notification: card.id, error: error.message });
    }
  }

  private close(card: NotificationRecord, detail: string): void {
    try {
      this.opts.ledger.resolveOwnerDecision(card.id, detail, OWNER_PROVENANCE);
    } catch (error) {
      if (!(error instanceof NotificationDecisionRefusal)) throw error;
      this.log('warn', 'a lane discard card could not be closed', { notification: card.id, error: error.message });
    }
  }
}

/** The lane a card is about (its id: `worktree-repo-mismatch:<lane>:<hash>`). */
function laneOfCard(id: string): string | null {
  const prefix = 'worktree-repo-mismatch:';
  const hash = id.lastIndexOf(':');
  return id.startsWith(prefix) && hash > prefix.length ? id.slice(prefix.length, hash) : null;
}

function repoMismatchDecision(laneId: string, path: string, repoName: string, candidate: string): NotificationDecision {
  return parseNotificationDecision({
    question: `Discard lane ${laneId}? Its repository ${repoName} now resolves to a different repository.`,
    context: `The lane's folder ${path} may hold uncommitted work. GC cannot reconnect it to ${candidate}, which is not the repository it was made in.`,
    recommendation: null,
    reservedClass: 'destructive',
    whyNotDelegable: 'Discarding a lane deletes work no other copy may hold, and anything that loses data stays the owner\'s call (owner ruling 2026-10-16).',
    options: [
      { id: 'accept', label: 'Accept: discard the lane', consequence: `GC deletes ${path} with whatever it holds and marks the lane released, unless the lane reaches its repository again by then.` },
      { id: 'decline', label: 'Decline: keep the lane', consequence: `Nothing is deleted. GC does not ask again while ${repoName} resolves to ${candidate}; moving the repository back, or pointing workspace_root at it, lets GC reconnect the lane.` },
    ],
    discussion: false,
  });
}
