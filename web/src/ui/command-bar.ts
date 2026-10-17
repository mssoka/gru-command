/**
 * Command bar (cockpit rework 2026-10-17): the full-width cockpit chrome —
 * logo badge + tagline, the RADAR and ROUND pills, the health pill
 * (rendered by BoardView), the chime, bell, theme and settings. The bar
 * itself lives in index.html; this controller writes the two pills in
 * place — never rebuilding them, so the connection dot inside RADAR keeps
 * the state `renderConnectionDot` gave it — and survives every snapshot
 * push. There is no lens toggle: chat is always docked on desktop and the
 * FAB owns mobile chat.
 */

import type { BoardConnectionState } from '../lib/board-client.js';
import type { BoardSnapshot } from '../lib/board-protocol.js';
import { tickerSegments } from '../lib/command-ticker.js';
import { mustGet } from './dom.js';

export class CommandBar {
  private readonly radar: HTMLElement;
  private readonly radarLabel: HTMLElement;
  private readonly round: HTMLElement;
  private boardState: BoardConnectionState | null = null;
  private snapshot: BoardSnapshot | null = null;

  constructor() {
    this.radar = mustGet('command-radar');
    this.radarLabel = mustGet('command-radar-label');
    this.round = mustGet('command-round');
    this.render();
  }

  setBoardState(state: BoardConnectionState | null): void {
    if (this.boardState === state) return;
    this.boardState = state;
    this.render();
  }

  setSnapshot(snapshot: BoardSnapshot | null): void {
    this.snapshot = snapshot;
    this.render();
  }

  private render(): void {
    const [radar, round] = tickerSegments({ boardState: this.boardState, snapshot: this.snapshot });
    if (radar === undefined || round === undefined) throw new Error('command bar: the ticker must yield the RADAR and ROUND pills');
    this.radar.className = `command-pill command-pill--${radar.tone}`;
    this.radarLabel.textContent = radar.label;
    this.round.className = `command-pill command-pill--round-${round.tone}`;
    this.round.textContent = round.label;
  }
}

/** The chat pane head's connection badge (GRU BRAIN ENGINE · ONLINE). */
export function renderChatOnline(state: BoardConnectionState | string): void {
  const badge = mustGet<HTMLElement>('chat-online');
  const status = state === 'open' ? 'online' : state === 'offline' ? 'offline' : 'syncing';
  badge.dataset.state = status;
  badge.textContent = status.toUpperCase();
}
