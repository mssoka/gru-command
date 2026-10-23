import type { EventBus } from '../events/bus.js';
import type { LedgerApi, NotificationRecord, WorktreeRecord } from '../ledger/api.js';
import { NotificationDecisionRefusal } from '../ledger/api.js';
import type { LogLevel } from '../logger.js';
import type { NotificationCenter } from '../notifications/center.js';
import type { PausedProcess, SweepRequest, SweepResult } from './manager.js';
import { STOP_AND_SWEEP_OPTION, SWEEP_PAUSED_KIND_PREFIX, sweepPausedCard, sweepPausedCardOf, sweepPausedKind } from './sweep-card.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

const OWNER_PROVENANCE = { credential: 'internal', declaredActor: null } as const;

type SweepCardLedger = Pick<LedgerApi, 'getWorktree' | 'listOpenNotificationsByKindPrefix' | 'latestEventByPayloadField' | 'resolveOwnerDecision' | 'withdrawOwnerProposal'>;

/** Withdraw a lane's undecided sweep cards (a newer pause asks about what
 * runs now, or the lane was swept without them). Decided ones stay for
 * their follow-through. */
function withdrawUndecided(ledger: SweepCardLedger, laneId: string, keep: string | null, detail: string, log: Log): void {
  for (const card of ledger.listOpenNotificationsByKindPrefix(`${SWEEP_PAUSED_KIND_PREFIX}${laneId}:`)) {
    if (card.id === keep || card.decidedAt !== null || card.decision === null) continue;
    try {
      ledger.withdrawOwnerProposal(card.id, detail);
    } catch (error) {
      if (!(error instanceof NotificationDecisionRefusal)) throw error;
      log('warn', 'a paused sweep\'s card could not be withdrawn', { notification: card.id, error: error.message });
    }
  }
}

/**
 * The owner's card for a paused sweep (#486): one needs-owner row per
 * pause, its id and kind `worktree-sweep-paused:<lane>:<pause>`, naming what
 * still runs and why GC did not stop it, with one action (Stop these N
 * processes and finish the sweep). An older undecided card of the lane is
 * withdrawn: this pause asks about what runs now.
 */
export function postSweepPausedCard(
  deps: { readonly ledger: SweepCardLedger; readonly notifications: Pick<NotificationCenter, 'post'>; readonly log?: Log },
  input: { readonly worktree: WorktreeRecord; readonly pauseId: string; readonly details: readonly PausedProcess[] },
): NotificationRecord {
  const log = deps.log ?? (() => {});
  const id = sweepPausedKind(input.worktree.id, input.pauseId);
  withdrawUndecided(deps.ledger, input.worktree.id, id, 'a newer pause of the lane asks about the processes running now', log);
  const card = sweepPausedCard(input.worktree, input.details);
  return deps.notifications.post({ id, kind: id, routing: 'needs-owner', severity: 'info', ...card });
}

/** A lane was swept: its undecided sweep cards are withdrawn (the
 * processes ended on their own), the rest resolve with the sweep. */
export function withdrawSweptLaneCards(deps: { readonly ledger: SweepCardLedger; readonly log?: Log }, laneId: string): void {
  withdrawUndecided(deps.ledger, laneId, null, 'the lane was swept: nothing it asked about is running', deps.log ?? (() => {}));
}

export interface SweepDecisionFollowerOptions {
  readonly ledger: SweepCardLedger;
  readonly bus: EventBus;
  readonly release: (input: SweepRequest) => Promise<SweepResult>;
  readonly log?: Log;
}

/**
 * Carries out the owner's answer to a paused sweep's card (#486): a release
 * with `confirmKill`, as an operator's `confirm_kill`, limited to the pids
 * that card named (its pause's `worktree.paused` event). A survivor or a
 * process that appeared since is never killed by this answer: the release
 * pauses again and asks with a new card. The card closes with what
 * happened. Followed as answers are recorded and once at start, so an
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
      while (this.followAgain) {
        this.followAgain = false;
        for (const card of this.opts.ledger.listOpenNotificationsByKindPrefix(SWEEP_PAUSED_KIND_PREFIX)) {
          if (card.decidedOption === null) continue;
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
    const listed = (pause?.payload as { readonly processes?: readonly { readonly pid?: unknown }[] } | null)?.processes ?? [];
    const pids = listed.map((proc) => proc.pid).filter((pid): pid is number => typeof pid === 'number');
    if (lane === null || pause === null || pids.length === 0) {
      this.close(card, 'nothing was stopped: GC has no record of this pause');
      return;
    }
    if (lane.status !== 'paused') {
      this.close(card, `nothing was stopped: lane ${lane.id} is ${lane.status}, no longer paused on these processes`);
      return;
    }
    let result: SweepResult;
    try {
      result = await this.opts.release({ worktreeId: lane.id, confirmKill: true, confirmKillPids: pids });
    } catch (error) {
      this.close(card, `the sweep did not finish: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.close(card, result.status === 'swept'
      ? `stopped the processes and swept lane ${lane.id}`
      : `the sweep paused again: ${result.note}`);
  }

  private close(card: NotificationRecord, detail: string): void {
    try {
      this.opts.ledger.resolveOwnerDecision(card.id, detail, OWNER_PROVENANCE);
    } catch (error) {
      if (!(error instanceof NotificationDecisionRefusal)) throw error;
      this.log('warn', 'a paused sweep\'s card could not be closed', { notification: card.id, error: error.message });
    }
  }
}
