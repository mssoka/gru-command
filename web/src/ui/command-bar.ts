/**
 * Command bar (cockpit rework 2026-10-17): the full-width cockpit chrome —
 * logo badge + tagline, the RADAR and ROUND pills, the health pill
 * (rendered by BoardView), the chime, bell, theme and settings. The bar
 * itself lives in index.html; this controller writes the two pills in
 * place — never rebuilding them, so the connection dot inside RADAR keeps
 * the state `renderConnectionDot` gave it — and survives every snapshot
 * push. RADAR is the board socket's: its dot and its word follow the
 * board client only (the chat socket's state is the chat pane's ONLINE
 * badge). The pills sit in a polite live region, so each is written only
 * when its own reading changes, and the dot is decoration (aria-hidden): the
 * word beside it says the state. There is no lens toggle: chat is always
 * docked on desktop and the FAB owns mobile chat.
 */

import type { BoardConnectionState } from '../lib/board-client.js';
import type { BoardSnapshot } from '../lib/board-protocol.js';
import { tickerSegments } from '../lib/command-ticker.js';
import { mustGet } from './dom.js';

export class CommandBar {
  private readonly ticker: HTMLElement;
  private readonly radar: HTMLElement;
  private readonly radarLabel: HTMLElement;
  private readonly round: HTMLElement;
  private readonly roundLabel: HTMLElement;
  private boardState: BoardConnectionState | null = null;
  private snapshot: BoardSnapshot | null = null;
  private writtenRadar: string | null = null;
  private writtenRound: string | null = null;

  constructor() {
    this.ticker = mustGet('command-ticker');
    this.radar = mustGet('command-radar');
    this.radarLabel = mustGet('command-radar-label');
    this.round = mustGet('command-round');
    this.roundLabel = mustGet('command-round-label');
    this.render();
  }

  setBoardState(state: BoardConnectionState | null): void {
    if (this.boardState === state) return;
    this.boardState = state;
    // Lost from stale, reconnecting or offline until the socket reopens
    // (connecting and authenticating keep the last word): a phone shows
    // RADAR only while it is lost, so a normal boot never flashes it.
    if (state === 'open') this.ticker.dataset.boardLost = 'false';
    else if (state === 'stale' || state === 'reconnecting' || state === 'offline') this.ticker.dataset.boardLost = 'true';
    this.render();
  }

  /** A new pairing starts RADAR fresh: the replaced board client's own
   * stop reports `offline`, which is not an outage of the new one. */
  reset(): void {
    this.boardState = null;
    this.ticker.dataset.boardLost = 'false';
    this.render();
  }

  setSnapshot(snapshot: BoardSnapshot | null): void {
    this.snapshot = snapshot;
    this.render();
  }

  private render(): void {
    const [radar, round] = tickerSegments({ boardState: this.boardState, snapshot: this.snapshot });
    const radarReading = `${radar.tone}|${radar.label}`;
    if (radarReading !== this.writtenRadar) {
      this.writtenRadar = radarReading;
      this.radar.className = `command-pill command-pill--${radar.tone}`;
      this.radarLabel.textContent = radar.label;
    }
    const roundReading = `${round.tone}|${round.label}`;
    if (roundReading !== this.writtenRound) {
      this.writtenRound = roundReading;
      this.round.className = `command-pill command-pill--round-${round.tone}`;
      if (round.round === null) {
        this.roundLabel.textContent = round.label;
      } else {
        // The number rides a two-digit slot: round 10 never moves the pill.
        const num = document.createElement('span');
        num.className = 'command-pill__num';
        num.textContent = String(round.round.seq);
        this.roundLabel.replaceChildren('ROUND ', num, ` ${round.round.word}`);
      }
    }
  }
}

/** The chat pane head's connection badge (GRU BRAIN ENGINE · ONLINE). */
export function renderChatOnline(state: BoardConnectionState | string): void {
  const badge = mustGet<HTMLElement>('chat-online');
  const status = state === 'open' ? 'online' : state === 'offline' ? 'offline' : 'syncing';
  badge.dataset.state = status;
  badge.textContent = status.toUpperCase();
}
