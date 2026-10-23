import type { EventBus } from '../events/bus.js';
import type { LedgerApi, NotificationRecord, WorktreeRecord } from '../ledger/api.js';
import { NotificationDecisionRefusal } from '../ledger/api.js';
import type { LogLevel } from '../logger.js';
import type { NotificationCenter } from '../notifications/center.js';
import type { PausedProcess, SweepRequest, SweepResult } from './manager.js';
import { STOP_AND_SWEEP_OPTION, SWEEP_PAUSED_KIND_PREFIX, sweepPausedCard, sweepPausedCardOf, sweepPausedKind } from './sweep-card.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

const OWNER_PROVENANCE = { credential: 'internal', declaredActor: null } as const;

type SweepCardLedger = Pick<LedgerApi, 'getWorktree' | 'listOpenNotificationsByKindPrefix' | 'latestEventByPayloadField' | 'resolveOwnerDecision' | 'withdrawOwnerProposal' | 'getChildWorker' | 'listChildWorkers'>;

/** The open sweep cards of exactly this lane (a lane whose id merely
 * starts with this one's, `job-b:x`, keeps its own). */
function laneCards(ledger: SweepCardLedger, laneId: string): readonly NotificationRecord[] {
  return ledger.listOpenNotificationsByKindPrefix(`${SWEEP_PAUSED_KIND_PREFIX}${laneId}:`)
    .filter((card) => sweepPausedCardOf(card.kind)?.laneId === laneId);
}

/** Withdraw a lane's unanswered sweep cards, notices written before #486
 * included (a newer pause asks about what runs now, or the lane was swept
 * without them). Answered ones stay for their follow-through. */
function withdrawUndecided(ledger: SweepCardLedger, laneId: string, keep: string | null, detail: string, log: Log): void {
  for (const card of laneCards(ledger, laneId)) {
    if (card.id === keep || card.decidedAt !== null) continue;
    try {
      ledger.withdrawOwnerProposal(card.id, detail);
    } catch (error) {
      if (!(error instanceof NotificationDecisionRefusal)) throw error;
      log('warn', 'a paused sweep\'s card could not be withdrawn', { notification: card.id, error: error.message });
    }
  }
}

function closeCard(ledger: SweepCardLedger, card: NotificationRecord, detail: string, log: Log): void {
  try {
    ledger.resolveOwnerDecision(card.id, detail, OWNER_PROVENANCE);
  } catch (error) {
    if (!(error instanceof NotificationDecisionRefusal)) throw error;
    log('warn', 'a paused sweep\'s card could not be closed', { notification: card.id, error: error.message });
  }
}

/**
 * The owner's card for a paused sweep (#486): one needs-owner row per
 * pause, its id and kind `worktree-sweep-paused:<lane>:<pause>`, naming what
 * still runs and why GC did not stop it, with one action (Stop these N
 * processes and finish the sweep). Once it is posted, the lane's older
 * unanswered cards are withdrawn: this pause asks about what runs now.
 */
export function postSweepPausedCard(
  deps: { readonly ledger: SweepCardLedger; readonly notifications: Pick<NotificationCenter, 'post'>; readonly log?: Log },
  input: { readonly worktree: WorktreeRecord; readonly pauseId: string; readonly details: readonly PausedProcess[] },
): NotificationRecord {
  const id = sweepPausedKind(input.worktree.id, input.pauseId);
  const posted = deps.notifications.post({ id, kind: id, routing: 'needs-owner', severity: 'info', ...sweepPausedCard(input.worktree, input.details) });
  withdrawUndecided(deps.ledger, input.worktree.id, id, 'a newer pause of the lane asks about the processes running now', deps.log ?? (() => {}));
  return posted;
}

/** A lane was swept: its unanswered sweep cards are withdrawn (what they
 * asked about ended), and its answered ones close saying so. */
export function settleSweptLaneCards(deps: { readonly ledger: SweepCardLedger; readonly log?: Log }, laneId: string): void {
  const log = deps.log ?? (() => {});
  withdrawUndecided(deps.ledger, laneId, null, 'the lane was swept: nothing it asked about is running', log);
  for (const card of laneCards(deps.ledger, laneId)) {
    if (card.decidedAt !== null) closeCard(deps.ledger, card, `lane ${laneId} was swept after the answer "${card.decidedOption ?? ''}"`, log);
  }
}

export interface SweepDecisionFollowerOptions {
  readonly ledger: SweepCardLedger;
  readonly bus: EventBus;
  readonly release: (input: SweepRequest) => Promise<SweepResult>;
  /** Once aborted (the service is stopping), no answer is carried out. */
  readonly stopSignal?: AbortSignal;
  readonly log?: Log;
}

/**
 * Carries out the owner's answer to a paused sweep's card (#486): a release
 * with `confirmKill`, as an operator's `confirm_kill`, limited to the pids
 * that card named (its pause's `worktree.paused` event, with the base
 * branch that release named). A survivor or a process that appeared since
 * is never killed by this answer: the release pauses again and asks with a
 * new card. Like an operator's release, it never abandons a child worker
 * that has not finished. The card closes with what happened; a release that
 * fails leaves it open, answered, for the next pass (another answer, or a
 * restart). Followed as answers are recorded and once at start, so an
 * answer a restart interrupted is still carried out.
 */
export class SweepDecisionFollower {
  private readonly log: Log;
  private unsubscribe: (() => void) | null = null;
  private following: Promise<void> | null = null;
  private followAgain = false;

  constructor(private readonly opts: SweepDecisionFollowerOptions) {
    this.log = opts.log ?? (() => {});
  }

  start(): void {
    if (this.unsubscribe !== null) return;
    this.unsubscribe = this.opts.bus.subscribe((event) => {
      if (event.kind !== 'notification.decision') return;
      const id = (event.payload as { readonly id?: unknown } | null)?.id;
      if (typeof id !== 'string' || !id.startsWith(SWEEP_PAUSED_KIND_PREFIX)) return;
      void this.follow();
    });
    void this.follow();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Carry out every answered card; one pass at a time, and an answer that
   * lands during a pass gets another. Never rejects. */
  follow(): Promise<void> {
    this.followAgain = true;
    this.following ??= this.passes();
    return this.following;
  }

  /** Passes until no answer arrived during the last one. The run starts
   * after its promise is stored and clears it in the same step as its last
   * check, so an answer is never left between a finished run and the next. */
  private async passes(): Promise<void> {
    await Promise.resolve();
    try {
      while (this.followAgain && !this.stopping()) {
        this.followAgain = false;
        for (const card of this.opts.ledger.listOpenNotificationsByKindPrefix(SWEEP_PAUSED_KIND_PREFIX)) {
          if (card.decidedOption === null || this.stopping()) continue;
          try {
            await this.carryOut(card);
          } catch (error) {
            this.log('error', 'a paused sweep\'s answer could not be carried out; the next answer or restart retries it', { notification: card.id, error: String(error) });
          }
        }
      }
    } finally {
      this.following = null;
    }
  }

  private async carryOut(card: NotificationRecord): Promise<void> {
    const named = sweepPausedCardOf(card.id);
    if (named === null || card.decidedOption !== STOP_AND_SWEEP_OPTION) {
      this.close(card, 'nothing was stopped: this card names no pause GC recorded');
      return;
    }
    const pause = this.opts.ledger.latestEventByPayloadField('worktree.paused', 'pause_id', named.pauseId);
    const lane = this.opts.ledger.getWorktree(named.laneId);
    const payload = pause?.payload as { readonly processes?: readonly { readonly pid?: unknown }[]; readonly base_branch?: unknown } | null;
    const pids = (payload?.processes ?? []).map((proc) => proc.pid).filter((pid): pid is number => typeof pid === 'number');
    if (lane === null || pause === null || pids.length === 0) {
      this.close(card, 'nothing was stopped: GC has no record of this pause');
      return;
    }
    if (lane.status !== 'paused') {
      this.close(card, `nothing was stopped: lane ${lane.id} is ${lane.status}, no longer paused on these processes`);
      return;
    }
    const children = this.unfinishedChildren(lane);
    if (children.length > 0) {
      this.close(card, `nothing was stopped: ${children.length === 1 ? 'child worker' : 'child workers'} ${children.join(', ')} of this lane ${children.length === 1 ? 'has' : 'have'} not finished; cancel ${children.length === 1 ? 'it' : 'them'} (POST /api/dispatch/children/:id/cancel), then release the lane again`);
      return;
    }
    const baseBranch = typeof payload?.base_branch === 'string' ? payload.base_branch : undefined;
    let result: SweepResult;
    try {
      result = await this.opts.release({ worktreeId: lane.id, confirmKill: true, confirmKillPids: pids, ...(baseBranch !== undefined ? { baseBranch } : {}) });
    } catch (error) {
      // The answer stands: the card stays open, answered, and the next pass
      // tries again. What refused the release says why (and a submodule or
      // sparse-checkout refusal tells Gru).
      this.log('error', 'the answered sweep of a paused lane did not finish; its card stays open for the next pass', {
        notification: card.id, id: lane.id, error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.close(card, result.status === 'swept'
      ? `stopped the processes and swept lane ${lane.id}`
      : `the sweep paused again: ${result.note}`);
  }

  /** The child workers that have not finished and hold this lane, as an
   * operator's release counts them (#161). */
  private unfinishedChildren(lane: WorktreeRecord): readonly string[] {
    if (lane.kind === 'child') {
      const child = this.opts.ledger.getChildWorker(lane.id);
      return child !== null && child.resultState === null ? [child.id] : [];
    }
    if (lane.kind !== 'job' || lane.jobId === null) return [];
    return this.opts.ledger.listChildWorkers({ jobId: lane.jobId }).filter((child) => child.resultState === null).map((child) => child.id);
  }

  private stopping(): boolean {
    return this.opts.stopSignal?.aborted === true;
  }

  private close(card: NotificationRecord, detail: string): void {
    closeCard(this.opts.ledger, card, detail, this.log);
  }
}
