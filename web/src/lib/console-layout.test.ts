import { describe, expect, it } from 'vitest';
import { memoryStorage } from './chat-storage.js';
import {
  CHAT_PANE_COLLAPSED_KEY,
  CHAT_PANE_MIN_WIDTH,
  COCKPIT_MIN_WIDTH,
  PANE_SIZES_KEY,
  RAIL_DEFAULT_WIDTH,
  RAIL_MIN_WIDTH,
  TWO_PANE_MIN_WIDTH,
  chatWidthBounds,
  clampChatWidth,
  clampRailWidth,
  consoleModeForWidth,
  defaultPaneSizes,
  fabModeForWidth,
  loadChatPaneCollapsed,
  loadPaneSizes,
  railWidthBounds,
  saveChatPaneCollapsed,
  savePaneSizes,
} from './console-layout.js';

describe('console layout — breakpoint modes (v6 cockpit)', () => {
  it('maps viewport widths to the three console modes at exact boundaries', () => {
    expect(consoleModeForWidth(390)).toBe('single');
    expect(consoleModeForWidth(TWO_PANE_MIN_WIDTH - 1)).toBe('single');
    expect(consoleModeForWidth(TWO_PANE_MIN_WIDTH)).toBe('two-pane');
    expect(consoleModeForWidth(COCKPIT_MIN_WIDTH - 1)).toBe('two-pane');
    expect(consoleModeForWidth(COCKPIT_MIN_WIDTH)).toBe('cockpit');
    expect(consoleModeForWidth(1440)).toBe('cockpit');
  });

  it('the FAB toggles the chat pane on the cockpit and opens the overlay below it', () => {
    expect(fabModeForWidth(1920)).toBe('chat-pane');
    expect(fabModeForWidth(COCKPIT_MIN_WIDTH)).toBe('chat-pane');
    expect(fabModeForWidth(COCKPIT_MIN_WIDTH - 1)).toBe('chat-overlay');
    expect(fabModeForWidth(1100)).toBe('chat-pane');
    expect(fabModeForWidth(800)).toBe('chat-overlay');
    expect(fabModeForWidth(390)).toBe('chat-overlay');
  });
});

describe('console layout — pane width model (v6)', () => {
  it('defaults the chat pane to ~30% of the container, floor 420 and ceiling 640', () => {
    // 1440px cockpit: container ≈ 1440 − 24 page padding.
    const sizes = defaultPaneSizes(1440 - 24);
    expect(sizes.chat).toBe(Math.round((1440 - 24) * 0.3));
    expect(sizes.rail).toBe(RAIL_DEFAULT_WIDTH);
    // Narrow edge: the chat floor holds.
    expect(defaultPaneSizes(COCKPIT_MIN_WIDTH - 24).chat).toBe(CHAT_PANE_MIN_WIDTH);
    // Ultrawide: the ceiling holds — the cockpit stays a dashboard.
    expect(defaultPaneSizes(3840).chat).toBe(640);
  });

  it('at the 1100px edge the rail yields before the chat floor (soft degrade)', () => {
    const container = COCKPIT_MIN_WIDTH - 24;
    const sizes = defaultPaneSizes(container);
    expect(sizes.chat).toBe(CHAT_PANE_MIN_WIDTH);
    expect(sizes.rail).toBe(RAIL_MIN_WIDTH);
    // The owner's three minimums cannot all fit at 1100; the board is the
    // 1fr remainder and takes the squeeze rather than overflowing the page.
    expect(container - sizes.chat - sizes.rail).toBeLessThan(480);
  });

  it('boundaries: chat min 420 / rail min 240; drags clamp at both ends', () => {
    const container = 1416;
    const chatBounds = chatWidthBounds(container, RAIL_DEFAULT_WIDTH);
    expect(chatBounds.min).toBe(CHAT_PANE_MIN_WIDTH);
    // Bounded by the board floor AND the ultrawide ceiling (640px).
    expect(chatBounds.max).toBe(640);
    expect(clampChatWidth(100, container, RAIL_DEFAULT_WIDTH)).toBe(CHAT_PANE_MIN_WIDTH);
    expect(clampChatWidth(9999, container, RAIL_DEFAULT_WIDTH)).toBe(chatBounds.max);

    const railBounds = railWidthBounds(container, 450);
    expect(railBounds.min).toBe(RAIL_MIN_WIDTH);
    expect(railBounds.max).toBe(container - 450 - 8 - 480);
    expect(clampRailWidth(10, container, 450)).toBe(RAIL_MIN_WIDTH);
    expect(clampRailWidth(9999, container, 450)).toBe(railBounds.max);
  });

  it('persists pane sizes per breakpoint and tolerates junk/blocked storage', () => {
    const storage = memoryStorage();
    expect(loadPaneSizes(storage)).toBeNull();

    savePaneSizes(storage, { chat: 500, rail: 300 });
    expect(loadPaneSizes(storage)).toEqual({ chat: 500, rail: 300 });
    // A second breakpoint's entry does not clobber the cockpit's.
    savePaneSizes(storage, { chat: 111, rail: 222 }, 'cockpit');
    expect(loadPaneSizes(storage)).toEqual({ chat: 111, rail: 222 });

    storage.setItem(PANE_SIZES_KEY, 'not-json');
    expect(loadPaneSizes(storage)).toBeNull();
    storage.setItem(PANE_SIZES_KEY, JSON.stringify({ cockpit: { chat: 'x', rail: 2 } }));
    expect(loadPaneSizes(storage)).toBeNull();
    storage.setItem(PANE_SIZES_KEY, JSON.stringify({ cockpit: { chat: 100, rail: 200 } }));
    expect(loadPaneSizes(storage)).toEqual({ chat: 100, rail: 200 });

    expect(loadPaneSizes(null)).toBeNull();
    savePaneSizes(null, { chat: 1, rail: 1 }); // no-op, no throw
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
    expect(loadPaneSizes(hostile)).toBeNull();
    savePaneSizes(hostile, { chat: 1, rail: 1 }); // no throw
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
