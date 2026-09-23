/**
 * Command bar (board UX v6): the full-width cockpit chrome — brand +
 * tagline, the inline status ticker, the Chat/Board lens toggle, the
 * notification bell, theme and settings. The bar itself lives in
 * index.html; this controller owns the ticker's content (the three
 * pipe-separated segments) and survives every snapshot push.
 */

import type { BoardConnectionState } from '../lib/board-client.js';
import type { BoardSnapshot } from '../lib/board-protocol.js';
import { tickerSegments, type ActiveView } from '../lib/command-ticker.js';
import { consoleModeForWidth, type ConsoleMode } from '../lib/console-layout.js';
import { el, mustGet } from './dom.js';

export class CommandBar {
  private readonly ticker: HTMLElement;
  private view: ActiveView = 'board';
  private layout: ConsoleMode;
  private boardState: BoardConnectionState | null = null;
  private snapshot: BoardSnapshot | null = null;

  constructor() {
    this.ticker = mustGet('command-ticker');
    this.layout = consoleModeForWidth(typeof window === 'undefined' ? 0 : window.innerWidth);
    this.render();
  }

  setView(view: ActiveView): void {
    if (this.view === view) return;
    this.view = view;
    this.render();
  }

  setLayout(layout: ConsoleMode): void {
    if (this.layout === layout) return;
    this.layout = layout;
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
    const segments = tickerSegments({
      view: this.view,
      layout: this.layout,
      boardState: this.boardState,
      snapshot: this.snapshot,
    });
    const nodes: HTMLElement[] = [];
    for (const segment of segments) {
      const node = el('span', `command-ticker__segment command-ticker__segment--${segment.tone}`, segment.label);
      node.dataset.segment = segment.key;
      nodes.push(node);
    }
    this.ticker.replaceChildren();
    nodes.forEach((node, index) => {
      if (index > 0) this.ticker.append(el('span', 'command-ticker__sep', '|'));
      this.ticker.append(node);
    });
  }
}

/** The chat pane head's connection badge (GRU BRAIN ENGINE · ONLINE). */
export function renderChatOnline(state: BoardConnectionState | string): void {
  const badge = mustGet<HTMLElement>('chat-online');
  const status = state === 'open' ? 'online' : state === 'offline' ? 'offline' : 'syncing';
  badge.dataset.state = status;
  badge.textContent = status.toUpperCase();
}
