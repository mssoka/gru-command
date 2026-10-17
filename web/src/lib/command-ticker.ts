/**
 * Command-bar pills (cockpit rework 2026-10-17): the RADAR and ROUND pills
 * beside the logo — the board socket's radar state and the top review
 * round on the board. The old MODE segment is gone (owner pick: the layout
 * is visible on screen). Pure so every combination is unit-testable without
 * a DOM; the view (`ui/command-bar.ts`) writes them into the static pills.
 */

import type { BoardConnectionState } from './board-client.js';
import type { BoardSnapshot } from './board-protocol.js';

export interface TickerInput {
  /** Board socket state; null before the board client exists (pairing). */
  readonly boardState: BoardConnectionState | null;
  readonly snapshot: BoardSnapshot | null;
}

export interface RadarSegment {
  readonly key: 'radar';
  readonly label: string;
  readonly tone: 'plain' | 'ok' | 'warn' | 'alert';
}

export interface RoundSegment {
  readonly key: 'round';
  readonly label: string;
  readonly tone: 'live' | 'pending' | 'none';
  /** The round's number and its state word, which the pill lays out with
   * the number in a two-digit slot; null = no round. */
  readonly round: { readonly seq: number; readonly word: 'LIVE' | 'PENDING' } | null;
}

/** Radar = the board socket's health in one word. */
export function radarLabel(state: BoardConnectionState | null): { label: string; tone: 'plain' | 'ok' | 'warn' | 'alert' } {
  switch (state) {
    case 'open':
      return { label: 'LIVE', tone: 'ok' };
    case 'stale':
      return { label: 'STALE', tone: 'warn' };
    case 'offline':
      return { label: 'DOWN', tone: 'alert' };
    case 'reconnecting':
    case 'connecting':
    case 'authenticating':
      return { label: 'SYNCING', tone: 'warn' };
    default:
      return { label: 'IDLE', tone: 'plain' };
  }
}

/**
 * The top review round across the whole board: the highest live round
 * (any job), else the highest pending one, else null. A round is the
 * board's clock — it is what the operator wants to see at a glance.
 */
export function topReviewRound(snapshot: BoardSnapshot | null): { seq: number; status: 'live' | 'pending' } | null {
  if (snapshot === null) return null;
  let live: number | null = null;
  let pending: number | null = null;
  for (const repo of snapshot.repos) {
    for (const job of repo.jobs) {
      for (const round of job.rounds) {
        if (round.status === 'live' && (live === null || round.seq > live)) live = round.seq;
        if (round.status === 'pending' && (pending === null || round.seq > pending)) pending = round.seq;
      }
    }
  }
  if (live !== null) return { seq: live, status: 'live' };
  if (pending !== null) return { seq: pending, status: 'pending' };
  return null;
}

const ROUND_WORDS = { live: 'LIVE', pending: 'PENDING' } as const;

export function roundLabel(round: { seq: number; status: 'live' | 'pending' } | null): string {
  if (round === null) return 'NO ROUND';
  return `ROUND ${round.seq} ${ROUND_WORDS[round.status]}`;
}

/** The two pills, in order. */
export function tickerSegments(input: TickerInput): readonly [RadarSegment, RoundSegment] {
  const radar = radarLabel(input.boardState);
  const round = topReviewRound(input.snapshot);
  return [
    { key: 'radar', label: `RADAR ${radar.label}`, tone: radar.tone },
    {
      key: 'round',
      label: roundLabel(round),
      tone: round === null ? 'none' : round.status,
      round: round === null ? null : { seq: round.seq, word: ROUND_WORDS[round.status] },
    },
  ];
}
