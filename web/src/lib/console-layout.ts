/**
 * Console layout (board UX v6, "the cockpit"): the breakpoints, the Gru
 * FAB's mode, the chat pane's persisted collapse state, and the
 * drag-splitter pane-size model.
 *
 * One module owns the numbers so the JS-side decisions and the CSS
 * breakpoints stay in step:
 *
 *   >= 1100px  cockpit    chat | board | agents-rail — drag splitters
 *   >=  900px  two-pane   board | rail — the FAB opens the chat overlay
 *   <   900px  single     board — the FAB opens the chat overlay (phone:
 *                         bottom sheet; the v5 behavior, unchanged)
 *
 * Everything here is pure (or a tolerant storage read) so the layout
 * behavior is unit-testable without a DOM.
 *
 * Pane sizes persist per breakpoint (`gru-pane-sizes` → `{ cockpit: … }`)
 * so a future resizable layout gets its own lane instead of inheriting
 * the cockpit's numbers. Junk/blocked storage degrades to the defaults —
 * a storage hiccup must never blank the cockpit.
 */

import type { StorageLike } from '../theme.js';

export const COCKPIT_MIN_WIDTH = 1100;
export const TWO_PANE_MIN_WIDTH = 900;

/** The collapse rail (🧠) width; the collapsed chat column. */
export const CHAT_RAIL_WIDTH = 56;
/** Default agents-rail width (the v5 side rail). */
export const RAIL_DEFAULT_WIDTH = 280;
/** Hard pane minimums the owner specified; the drag clamps honor them. */
export const CHAT_PANE_MIN_WIDTH = 420;
export const BOARD_PANE_MIN_WIDTH = 480;
export const RAIL_MIN_WIDTH = 240;
/** The chat column's ceiling — an ultrawide cockpit must stay a
 * dashboard, not a chat client. */
export const CHAT_PANE_MAX_WIDTH = 640;
/** Default chat share of the viewport (owner: wider by default, ~30%). */
export const CHAT_PANE_DEFAULT_RATIO = 0.3;
/** Each vertical boundary is a 4px drag handle; two of them. */
export const SPLITTER_WIDTH = 4;
export const PANE_HANDLES_WIDTH = 2 * SPLITTER_WIDTH;

export const CHAT_PANE_COLLAPSED_KEY = 'gru-chat-pane-collapsed';
export const PANE_SIZES_KEY = 'gru-pane-sizes';

/** Breakpoint bucket the persisted pane sizes belong to. There is one
 * resizable layout today; the key keeps the door open without a schema
 * break. */
export type PaneSizeBreakpoint = 'cockpit';
export const COCKPIT_BREAKPOINT: PaneSizeBreakpoint = 'cockpit';

export type ConsoleMode = 'single' | 'two-pane' | 'cockpit';
export type FabMode = 'chat-pane' | 'chat-overlay';

export function consoleModeForWidth(width: number): ConsoleMode {
  if (width >= COCKPIT_MIN_WIDTH) return 'cockpit';
  if (width >= TWO_PANE_MIN_WIDTH) return 'two-pane';
  return 'single';
}

/** The FAB's contract per breakpoint: the cockpit toggles/focuses the
 * chat pane; everything below opens the chat overlay over the board. */
export function fabModeForWidth(width: number): FabMode {
  return consoleModeForWidth(width) === 'cockpit' ? 'chat-pane' : 'chat-overlay';
}

export interface PaneSizes {
  /** Chat column width in px (the board absorbs the remainder). */
  readonly chat: number;
  /** Agents-rail column width in px. */
  readonly rail: number;
}

export interface PaneWidthBounds {
  readonly min: number;
  readonly max: number;
}

/**
 * Drag bounds for the chat pane at this container width. The owner's
 * three minimums (chat 420, board 480, rail 240) sum past the cockpit
 * breakpoint itself — at 1100px the board cannot physically reach 480
 * with both side panes at their floors. Rather than overflow the page,
 * the max degrades softly to the chat pane's own minimum: the board is
 * the 1fr remainder and takes the squeeze.
 */
export function chatWidthBounds(containerWidth: number, railWidth: number): PaneWidthBounds {
  const max = Math.max(
    CHAT_PANE_MIN_WIDTH,
    containerWidth - railWidth - PANE_HANDLES_WIDTH - BOARD_PANE_MIN_WIDTH,
  );
  return { min: CHAT_PANE_MIN_WIDTH, max: Math.min(max, CHAT_PANE_MAX_WIDTH) };
}

export function railWidthBounds(containerWidth: number, chatWidth: number): PaneWidthBounds {
  const max = Math.max(
    RAIL_MIN_WIDTH,
    containerWidth - chatWidth - PANE_HANDLES_WIDTH - BOARD_PANE_MIN_WIDTH,
  );
  return { min: RAIL_MIN_WIDTH, max };
}

function clamp(value: number, bounds: PaneWidthBounds): number {
  return Math.round(Math.min(Math.max(value, bounds.min), bounds.max));
}

export function clampChatWidth(width: number, containerWidth: number, railWidth: number): number {
  return clamp(width, chatWidthBounds(containerWidth, railWidth));
}

export function clampRailWidth(width: number, containerWidth: number, chatWidth: number): number {
  return clamp(width, railWidthBounds(containerWidth, chatWidth));
}

/** Default cockpit panes for a container: chat ~30% (clamped to its
 * floor/ceiling), rail 280 unless the board needs the room — then the
 * rail yields toward its own floor before the chat does. */
export function defaultPaneSizes(containerWidth: number): PaneSizes {
  let chat = clampChatWidth(Math.round(containerWidth * CHAT_PANE_DEFAULT_RATIO), containerWidth, RAIL_DEFAULT_WIDTH);
  let rail = clampRailWidth(RAIL_DEFAULT_WIDTH, containerWidth, chat);
  chat = clampChatWidth(chat, containerWidth, rail);
  rail = clampRailWidth(rail, containerWidth, chat);
  return { chat, rail };
}

/** Clamp a persisted/edited pair into the current container. */
export function clampPaneSizes(sizes: PaneSizes, containerWidth: number): PaneSizes {
  let chat = clampChatWidth(sizes.chat, containerWidth, sizes.rail);
  const rail = clampRailWidth(sizes.rail, containerWidth, chat);
  chat = clampChatWidth(chat, containerWidth, rail);
  return { chat, rail };
}

function isPaneSizes(value: unknown): value is PaneSizes {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.chat === 'number' &&
    Number.isFinite(record.chat) &&
    record.chat > 0 &&
    typeof record.rail === 'number' &&
    Number.isFinite(record.rail) &&
    record.rail > 0
  );
}

/** Persisted pane sizes for one breakpoint; null when absent/junk. */
export function loadPaneSizes(
  storage: StorageLike | null,
  breakpoint: PaneSizeBreakpoint = COCKPIT_BREAKPOINT,
): PaneSizes | null {
  if (storage === null) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(PANE_SIZES_KEY);
  } catch {
    return null;
  }
  if (raw === null || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const entry = (parsed as Record<string, unknown>)[breakpoint];
  return isPaneSizes(entry) ? { chat: entry.chat, rail: entry.rail } : null;
}

/** Persist sizes for one breakpoint without clobbering its siblings. */
export function savePaneSizes(
  storage: StorageLike | null,
  sizes: PaneSizes,
  breakpoint: PaneSizeBreakpoint = COCKPIT_BREAKPOINT,
): void {
  if (storage === null) return;
  let parsed: Record<string, unknown> = {};
  try {
    const raw = storage.getItem(PANE_SIZES_KEY);
    if (raw !== null && raw !== '') {
      const candidate: unknown = JSON.parse(raw);
      if (typeof candidate === 'object' && candidate !== null) {
        parsed = { ...(candidate as Record<string, unknown>) };
      }
    }
    parsed[breakpoint] = { chat: sizes.chat, rail: sizes.rail };
    storage.setItem(PANE_SIZES_KEY, JSON.stringify(parsed));
  } catch {
    /* storage blocked/quota-full — pane sizes are a convenience, never load-bearing */
  }
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
