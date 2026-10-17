import type { VectorConfig, VectorMode } from '../config.js';
import type { BreakInRecord, RaidRecord } from './ledger.js';

/**
 * Vector's raids on the board (#351): the counts the cockpit's VECTOR RAIDS
 * card shows, projected from the raid and break-in records. Pure, so every
 * state is testable without a clock, a ledger or a running raid.
 */

const DAY_MS = 86_400_000;

/** A raid running right now, with how far it got. */
export interface VectorRunningRaidView {
  readonly repo: string;
  readonly packageDir: string;
  /** Attacks that finished so far; the one in progress is not counted. */
  readonly roundsDone: number;
  readonly maxRounds: number;
  readonly startedAt: string;
}

export interface VectorBoardView {
  /** False when `[vector] enabled = false`: the card says raids are off. */
  readonly enabled: boolean;
  readonly raidMode: VectorMode;
  /** Raids Gru picked that wait for the owner in FOR YOU. */
  readonly proposed: number;
  /** Launched raids waiting in Silas's raid queue. */
  readonly queued: number;
  /** Raids running now, newest start first. One runs per host, so this
   * holds at most one in normal operation; a second is shown, never hidden. */
  readonly running: readonly VectorRunningRaidView[];
  /** Raids that started in the last 24 hours, across every repository. */
  readonly startedLast24h: number;
  /** The per-repository cap on raids in any rolling 24 hours. */
  readonly maxRaidsPerDay: number;
  /** Every confirmed break-in so far. */
  readonly breakIns: number;
  /** Break-ins whose fix heist waits for the owner in FOR YOU. */
  readonly fixesAwaitingOwner: number;
}

export interface VectorBoardInput {
  readonly config: Pick<VectorConfig, 'enabled' | 'raidMode' | 'maxRounds' | 'maxRaidsPerDay'>;
  readonly raids: readonly RaidRecord[];
  readonly breakIns: readonly BreakInRecord[];
  readonly now: Date;
}

export function vectorBoardView(input: VectorBoardInput): VectorBoardView {
  const { config, raids, breakIns, now } = input;
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
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
  return {
    enabled: config.enabled,
    raidMode: config.raidMode,
    proposed: raids.filter((raid) => raid.state === 'proposed').length,
    queued: raids.filter((raid) => raid.state === 'queued').length,
    running,
    startedLast24h: raids.filter((raid) => raid.startedAt !== null && now.getTime() - Date.parse(raid.startedAt) < DAY_MS).length,
    maxRaidsPerDay: config.maxRaidsPerDay,
    breakIns: breakIns.length,
    fixesAwaitingOwner: breakIns.filter((breakIn) => breakIn.fix?.state === 'proposed').length,
  };
}
