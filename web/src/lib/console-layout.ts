/**
 * Console layout (board UX v5): the breakpoints, the Gru FAB's mode, the
 * chat pane's persisted collapse state, and the attention-band grid math.
 *
 * One module owns the numbers so the JS-side decisions and the CSS
 * breakpoints stay in step:
 *
 *   >= 1280px  console    chat | board | rail — the FAB toggles the pane
 *   >=  900px  two-pane   board | rail — the FAB opens the chat overlay
 *   <   900px  single     board — the FAB opens the chat overlay
 *
 * Everything here is pure (or a tolerant storage read) so the layout
 * behavior is unit-testable without a DOM.
 */

import type { StorageLike } from '../theme.js';

export const CONSOLE_MIN_WIDTH = 1280;
export const TWO_PANE_MIN_WIDTH = 900;

/** Column widths the CSS mirrors (`--console-chat-col`, `.board-side`). */
export const CHAT_PANE_WIDTH = 380;
export const CHAT_RAIL_WIDTH = 56;
export const SIDE_RAIL_WIDTH = 280;
export const CONSOLE_GAP = 16;

/** Band cards target this width; the grid fits as many as the pane holds,
 * capped so an ultrawide monitor stays a calm 3-column dashboard. */
export const BAND_MIN_CARD_WIDTH = 340;
export const BAND_GRID_GAP = 16;
export const BAND_MAX_COLUMNS = 3;

export const CHAT_PANE_COLLAPSED_KEY = 'gru-chat-pane-collapsed';

export type ConsoleMode = 'single' | 'two-pane' | 'console';
export type FabMode = 'chat-pane' | 'chat-overlay';

export function consoleModeForWidth(width: number): ConsoleMode {
  if (width >= CONSOLE_MIN_WIDTH) return 'console';
  if (width >= TWO_PANE_MIN_WIDTH) return 'two-pane';
  return 'single';
}

/** The FAB's contract per breakpoint: the console toggles/focuses the
 * chat pane; everything below opens the chat overlay over the board. */
export function fabModeForWidth(width: number): FabMode {
  return consoleModeForWidth(width) === 'console' ? 'chat-pane' : 'chat-overlay';
}

/** `auto-fill` column count for a `minmax(340px, 1fr)` card grid at this
 * container width — the JS mirror of the CSS auto-fill rule. */
export function bandColumnsForWidth(
  width: number,
  minCard = BAND_MIN_CARD_WIDTH,
  gap = BAND_GRID_GAP,
  maxColumns = BAND_MAX_COLUMNS,
): number {
  if (width <= 0) return 1;
  return Math.max(1, Math.min(maxColumns, Math.floor((width + gap) / (minCard + gap))));
}

/**
 * Estimated center-pane width when no layout engine has measured one yet
 * (unit tests, the first render before layout): the chat column (pane or
 * slim rail) and the side rail are deducted, mirroring the CSS grid.
 */
export function estimatedCenterWidth(
  viewportWidth: number,
  options: { readonly chatCollapsed?: boolean } = {},
): number {
  if (viewportWidth >= CONSOLE_MIN_WIDTH) {
    const chat = options.chatCollapsed === true ? CHAT_RAIL_WIDTH : CHAT_PANE_WIDTH;
    return Math.max(0, viewportWidth - chat - SIDE_RAIL_WIDTH - 4 * CONSOLE_GAP);
  }
  if (viewportWidth >= TWO_PANE_MIN_WIDTH) {
    return Math.max(0, viewportWidth - SIDE_RAIL_WIDTH - 3 * CONSOLE_GAP);
  }
  return Math.max(0, viewportWidth - 2 * CONSOLE_GAP);
}

/** Chat pane collapse is a durable preference; junk/blocked reads as
 * expanded (the default) — a storage hiccup must never hide the chat. */
export function loadChatPaneCollapsed(storage: StorageLike | null): boolean {
  if (storage === null) return false;
  try {
    return storage.getItem(CHAT_PANE_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function saveChatPaneCollapsed(storage: StorageLike | null, collapsed: boolean): void {
  if (storage === null) return;
  try {
    if (collapsed) storage.setItem(CHAT_PANE_COLLAPSED_KEY, 'true');
    else storage.removeItem(CHAT_PANE_COLLAPSED_KEY);
  } catch {
    /* storage blocked/quota-full — collapse is a convenience, never load-bearing */
  }
}
