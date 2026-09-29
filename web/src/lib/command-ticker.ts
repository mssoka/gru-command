/**
 * Command-bar ticker (board UX v6): the inline status readout at the top
 * of the cockpit. Three pipe-separated, monospace segments — the layout
 * mode, the board socket's radar state, and the top review round on the
 * board. Pure so every combination is unit-testable without a DOM; the
 * view (`ui/command-bar.ts`) renders the segments into spans. There is
 * no lens segment: v6.1 removed the Chat/Board toggle.
 */

import type { BoardConnectionState } from './board-client.js';
import type { BoardSnapshot } from './board-protocol.js';
import type { ConsoleMode } from './console-layout.js';

export interface TickerInput {
  readonly layout: ConsoleMode;
  /** Board socket state; null before the board client exists (pairing). */
  readonly boardState: BoardConnectionState | null;
  readonly snapshot: BoardSnapshot | null;
}

export interface TickerSegment {
  readonly key: 'mode' | 'radar' | 'round';
  readonly label: string;
  readonly tone: 'plain' | 'ok' | 'warn' | 'alert';
}

const LAYOUT_LABELS: Readonly<Record<ConsoleMode, string>> = {
  cockpit: 'COCKPIT',
  'two-pane': 'DESKTOP',
  single: 'MOBILE',
};

/** Radar = the board socket's health in one word. */
export function radarLabel(state: BoardConnectionState | null): { label: string; tone: TickerSegment['tone'] } {
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

export function roundLabel(round: { seq: number; status: 'live' | 'pending' } | null): string {
  if (round === null) return 'NO ROUND ACTIVE';
  return round.status === 'live' ? `ROUND ${round.seq} ACTIVE` : `ROUND ${round.seq} PENDING`;
}

/** The three ticker segments, in order. */
export function tickerSegments(input: TickerInput): readonly TickerSegment[] {
  const radar = radarLabel(input.boardState);
  const round = topReviewRound(input.snapshot);
  return [
    { key: 'mode', label: `MODE: ${LAYOUT_LABELS[input.layout]}`, tone: 'plain' },
    { key: 'radar', label: `RADAR: ${radar.label}`, tone: radar.tone },
    { key: 'round', label: roundLabel(round), tone: round?.status === 'live' ? 'ok' : 'plain' },
  ];
}
