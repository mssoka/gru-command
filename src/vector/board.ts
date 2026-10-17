import type { VectorConfig, VectorMode } from '../config.js';
import { raidsTowardCap, type BreakInRecord, type RaidRecord } from './ledger.js';

/**
 * Vector's raids on the board (#351): the counts the cockpit's VECTOR RAIDS
 * card shows, projected from the raid and break-in records. Pure, so every
 * state is testable without a clock, a ledger or a running raid.
 */

/** A raid running right now, with how far it got. */
export interface VectorRunningRaidView {
  readonly repo: string;
  readonly packageDir: string;
  /** Attacks that finished so far; the one in progress is not counted. */
  readonly roundsDone: number;
  readonly maxRounds: number;
  readonly startedAt: string;
}

/** One repository's use of its daily cap, counted exactly as a pick is
 * refused (`raidsTowardCap`: started in the last 24 hours, waiting to run,
 * running, or ended before starting). */
export interface VectorCapUseView {
  readonly repo: string;
  readonly used: number;
}

/** Raids off: nothing follows decisions, starts or closes a raid, so the
 * block claims no live counts — only that raids are off. */
export interface VectorOffBoardView {
  readonly enabled: false;
  readonly raidMode: VectorMode;
  readonly maxRaidsPerDay: number;
}

export interface VectorOnBoardView {
  readonly enabled: true;
  readonly raidMode: VectorMode;
  /** Raids Gru picked whose FOR YOU card is open and unanswered. */
  readonly proposed: number;
  /** Launched raids waiting in Silas's raid queue. */
  readonly queued: number;
  /** Raids running now, newest start first. One runs per host, so this
   * holds at most one in normal operation; a second is shown, never hidden. */
  readonly running: readonly VectorRunningRaidView[];
  /** Repositories using their cap now, busiest first (none listed = no
   * repository has used any of it). */
  readonly capUse: readonly VectorCapUseView[];
  /** The per-repository cap on raids in any rolling 24 hours. */
  readonly maxRaidsPerDay: number;
  /** Every confirmed break-in so far. */
  readonly breakIns: number;
  /** Break-ins whose fix card is open and unanswered in FOR YOU. */
  readonly fixesAwaitingOwner: number;
}

export type VectorBoardView = VectorOffBoardView | VectorOnBoardView;

export interface VectorBoardInput {
  readonly config: Pick<VectorConfig, 'enabled' | 'raidMode' | 'maxRounds' | 'maxRaidsPerDay'>;
  readonly raids: readonly RaidRecord[];
  readonly breakIns: readonly BreakInRecord[];
  readonly now: Date;
  /** Whether a FOR YOU card is still open and unanswered: an answered card
   * whose follow-through is pending, or a card closed without an answer,
   * waits for nobody. */
  readonly awaitingOwner: (notificationId: string) => boolean;
}

export function vectorBoardView(input: VectorBoardInput): VectorBoardView {
  const { config, raids, breakIns, now, awaitingOwner } = input;
  if (!config.enabled) return { enabled: false, raidMode: config.raidMode, maxRaidsPerDay: config.maxRaidsPerDay };
  const running = raids
    .filter((raid) => raid.state === 'running')
    .map((raid): VectorRunningRaidView => {
      if (raid.startedAt === null) throw new Error(`raid "${raid.id}" is running but has no start time`);
      return {
        repo: raid.target.repo,
        packageDir: raid.target.packageDir,
        roundsDone: raid.rounds.length,
        maxRounds: config.maxRounds,
        startedAt: raid.startedAt,
      };
    })
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
  const repos = [...new Set(raids.map((raid) => raid.target.repo))];
  const capUse = repos
    .map((repo): VectorCapUseView => ({ repo, used: raidsTowardCap(raids, repo, now) }))
    .filter((entry) => entry.used > 0)
    .sort((left, right) => right.used - left.used || left.repo.localeCompare(right.repo));
  const open = (notificationId: string | null): boolean => notificationId !== null && awaitingOwner(notificationId);
  return {
    enabled: true,
    raidMode: config.raidMode,
    proposed: raids.filter((raid) => raid.state === 'proposed' && open(raid.notificationId)).length,
    queued: raids.filter((raid) => raid.state === 'queued').length,
    running,
    capUse,
    maxRaidsPerDay: config.maxRaidsPerDay,
    breakIns: breakIns.length,
    fixesAwaitingOwner: breakIns.filter((breakIn) => breakIn.fix?.state === 'proposed' && open(breakIn.fix.notificationId)).length,
  };
}
