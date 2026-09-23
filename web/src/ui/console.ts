/**
 * Console shell (board UX v5): the chat pane's collapse state and the Gru
 * FAB's breakpoint behavior, as one small controller.
 *
 *   >= 1280px  the FAB toggles the chat pane (collapse = slim 🧠 rail)
 *   <  1280px  the FAB opens the chat overlay sheet over the board
 *
 * The collapse preference persists in localStorage; a corrupt/blocked
 * store degrades to "expanded" — never a broken shell. The shell owns no
 * chat internals: it drives the view through {@link ChatPaneHandle}, so
 * the view can be tested/mocked without a socket.
 */

import {
  COCKPIT_MIN_WIDTH,
  loadChatPaneCollapsed,
  saveChatPaneCollapsed,
} from '../lib/console-layout.js';
import type { StorageLike } from '../theme.js';

/** The chat surfaces the shell is allowed to command. */
export interface ChatPaneHandle {
  /** Focus the composer (and bring the latest message into view). */
  focusComposer(): void;
  /** Open the overlay sheet (below console width). */
  openSheet(): void;
  /** Dismiss the overlay sheet. */
  closeSheet(): void;
  /** Tell the view whether the console pane is collapsed — unread
   * counting follows the collapsed rail. */
  setPaneCollapsed(collapsed: boolean): void;
}

/** The matchMedia slice the shell needs (injectable for tests). */
export interface MediaQueryLike {
  readonly matches: boolean;
  addEventListener?(type: 'change', listener: () => void): void;
  removeEventListener?(type: 'change', listener: () => void): void;
}

export interface ConsoleShellOptions {
  /** The element that carries `.console--chat-collapsed`. */
  readonly root: HTMLElement;
  readonly fab: HTMLButtonElement;
  readonly rail: HTMLButtonElement;
  /** The in-pane collapse control (optional — the rail/FAB remain). */
  readonly collapseButton?: HTMLButtonElement | null;
  readonly chat: ChatPaneHandle;
  readonly storage: StorageLike | null;
  readonly matchMedia?: (query: string) => MediaQueryLike;
}

export const CONSOLE_QUERY = `(min-width: ${COCKPIT_MIN_WIDTH}px)`;

export class ConsoleShell {
  private readonly root: HTMLElement;
  private readonly fab: HTMLButtonElement;
  private readonly rail: HTMLButtonElement;
  private readonly collapseButton: HTMLButtonElement | null;
  private readonly chat: ChatPaneHandle;
  private readonly storage: StorageLike | null;
  private readonly consoleQuery: MediaQueryLike;
  private collapsedState: boolean;

  constructor(options: ConsoleShellOptions) {
    this.root = options.root;
    this.fab = options.fab;
    this.rail = options.rail;
    this.collapseButton = options.collapseButton ?? null;
    this.chat = options.chat;
    this.storage = options.storage;
    const matchMedia = options.matchMedia ?? ((query: string) => window.matchMedia(query));
    this.consoleQuery = matchMedia(CONSOLE_QUERY);
    this.collapsedState = loadChatPaneCollapsed(this.storage);

    this.fab.addEventListener('click', () => this.onFabClick());
    this.rail.addEventListener('click', () => this.expand());
    // The pane head's button is collapse on the console and CLOSE in the
    // overlay — the drawer/sheet needs a visible escape hatch.
    this.collapseButton?.addEventListener('click', () => {
      if (this.consoleQuery.matches) this.setCollapsed(true);
      else this.chat.closeSheet();
    });
    // Crossing the console breakpoint swaps the FAB's contract; the visual
    // state (pane vs overlay) is CSS + ChatView's reparenting.
    this.consoleQuery.addEventListener?.('change', () => this.syncFab());
    this.apply();
  }

  get collapsed(): boolean {
    return this.collapsedState;
  }

  /** The FAB's breakpoint contract. */
  private onFabClick(): void {
    if (!this.consoleQuery.matches) {
      this.chat.openSheet();
      return;
    }
    if (this.collapsedState) this.expand();
    else this.setCollapsed(true);
  }

  /** Expand the pane and hand focus to the composer. */
  expand(): void {
    this.setCollapsed(false);
    this.chat.focusComposer();
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsedState = collapsed;
    saveChatPaneCollapsed(this.storage, collapsed);
    this.apply();
  }

  private apply(): void {
    this.root.classList.toggle('console--chat-collapsed', this.collapsedState);
    this.chat.setPaneCollapsed(this.collapsedState);
    this.syncFab();
  }

  private syncFab(): void {
    const consoleMode = this.consoleQuery.matches;
    this.fab.setAttribute('aria-expanded', String(!this.collapsedState && consoleMode));
    this.fab.title = consoleMode
      ? this.collapsedState
        ? 'Open Gru chat'
        : 'Collapse Gru chat'
      : 'Chat with Gru';
    if (this.collapseButton !== null) {
      this.collapseButton.textContent = consoleMode ? '⇤' : '✕';
      this.collapseButton.title = consoleMode ? 'Collapse chat' : 'Close chat';
      this.collapseButton.setAttribute('aria-label', consoleMode ? 'Collapse chat' : 'Close chat');
    }
  }
}
