import { describe, expect, it } from 'vitest';
import { memoryStorage } from './chat-storage.js';
import {
  BAND_MAX_COLUMNS,
  CONSOLE_MIN_WIDTH,
  CHAT_PANE_COLLAPSED_KEY,
  TWO_PANE_MIN_WIDTH,
  bandColumnsForWidth,
  consoleModeForWidth,
  estimatedCenterWidth,
  fabModeForWidth,
  loadChatPaneCollapsed,
  saveChatPaneCollapsed,
} from './console-layout.js';

describe('console layout — breakpoint modes (v5)', () => {
  it('maps viewport widths to the three console modes at exact boundaries', () => {
    expect(consoleModeForWidth(390)).toBe('single');
    expect(consoleModeForWidth(TWO_PANE_MIN_WIDTH - 1)).toBe('single');
    expect(consoleModeForWidth(TWO_PANE_MIN_WIDTH)).toBe('two-pane');
    expect(consoleModeForWidth(1100)).toBe('two-pane');
    expect(consoleModeForWidth(CONSOLE_MIN_WIDTH - 1)).toBe('two-pane');
    expect(consoleModeForWidth(CONSOLE_MIN_WIDTH)).toBe('console');
    expect(consoleModeForWidth(1440)).toBe('console');
  });

  it('the FAB toggles the chat pane on the console and opens the overlay below it', () => {
    expect(fabModeForWidth(1920)).toBe('chat-pane');
    expect(fabModeForWidth(CONSOLE_MIN_WIDTH)).toBe('chat-pane');
    expect(fabModeForWidth(CONSOLE_MIN_WIDTH - 1)).toBe('chat-overlay');
    expect(fabModeForWidth(1100)).toBe('chat-overlay');
    expect(fabModeForWidth(800)).toBe('chat-overlay');
    expect(fabModeForWidth(390)).toBe('chat-overlay');
  });
});

describe('console layout — band grid columns (v5)', () => {
  it('mirrors auto-fill minmax(340px) math and caps at the calm 3 columns', () => {
    expect(bandColumnsForWidth(0)).toBe(1);
    expect(bandColumnsForWidth(300)).toBe(1);
    expect(bandColumnsForWidth(695)).toBe(1); // just shy of two 340px cards + gap
    expect(bandColumnsForWidth(696)).toBe(2); // 340 + 16 + 340
    expect(bandColumnsForWidth(900)).toBe(2);
    expect(bandColumnsForWidth(1052)).toBe(3); // 3×340 + 2×16
    expect(bandColumnsForWidth(2000)).toBe(BAND_MAX_COLUMNS);
  });

  it('derives the center-pane width from the console chrome at every mode', () => {
    // Console: chat 380 + side rail 280 + 4×16 chrome.
    expect(estimatedCenterWidth(1440)).toBe(716);
    // Collapsed chat rail frees the pane for another column.
    expect(bandColumnsForWidth(estimatedCenterWidth(1440))).toBe(2);
    expect(bandColumnsForWidth(estimatedCenterWidth(1440, { chatCollapsed: true }))).toBe(2);
    // Two-pane: board + rail only.
    expect(estimatedCenterWidth(1100)).toBe(1100 - 280 - 48);
    // Single pane: just the page padding.
    expect(estimatedCenterWidth(390)).toBe(390 - 32);
    expect(bandColumnsForWidth(estimatedCenterWidth(390))).toBe(1);
  });
});

describe('console layout — chat pane collapse storage (v5)', () => {
  it('persists the collapsed preference, clears it on expand, and tolerates junk', () => {
    const storage = memoryStorage();
    expect(loadChatPaneCollapsed(storage)).toBe(false);
    saveChatPaneCollapsed(storage, true);
    expect(storage.getItem(CHAT_PANE_COLLAPSED_KEY)).toBe('true');
    expect(loadChatPaneCollapsed(storage)).toBe(true);
    saveChatPaneCollapsed(storage, false);
    expect(storage.getItem(CHAT_PANE_COLLAPSED_KEY)).toBeNull();
    expect(loadChatPaneCollapsed(storage)).toBe(false);

    storage.setItem(CHAT_PANE_COLLAPSED_KEY, 'yes-please');
    expect(loadChatPaneCollapsed(storage)).toBe(false);
    storage.setItem(CHAT_PANE_COLLAPSED_KEY, JSON.stringify({ collapsed: true }));
    expect(loadChatPaneCollapsed(storage)).toBe(false);
  });

  it('a null/blocked store degrades to expanded and never throws', () => {
    expect(loadChatPaneCollapsed(null)).toBe(false);
    saveChatPaneCollapsed(null, true); // no-op
    const hostile = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(loadChatPaneCollapsed(hostile)).toBe(false);
    saveChatPaneCollapsed(hostile, true); // no throw
  });
});
