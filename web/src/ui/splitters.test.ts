// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import { memoryStorage } from '../lib/chat-storage.js';
import { CHAT_PANE_MIN_WIDTH, PANE_SIZES_KEY, RAIL_MIN_WIDTH } from '../lib/console-layout.js';
import { SPLITTER_KEY_STEP, SplitterController } from './splitters.js';

/**
 * The cockpit's drag splitters (v6): dragging a boundary resizes the
 * pane live, the minimums hold, the pair persists per breakpoint, and
 * double-click resets. The handles are inert outside the cockpit.
 */

interface Fixture {
  readonly root: HTMLElement;
  readonly chat: HTMLElement;
  readonly rail: HTMLElement;
  readonly storage: ReturnType<typeof memoryStorage>;
  readonly controller: SplitterController;
}

const VIEWPORT = 1440;
const CONTAINER = VIEWPORT - 24;

function mount(options: { viewport?: number; storage?: ReturnType<typeof memoryStorage> } = {}): Fixture {
  document.body.replaceChildren();
  const root = document.createElement('div');
  const chat = document.createElement('div');
  const rail = document.createElement('div');
  root.append(chat, rail);
  document.body.append(root);
  const storage = options.storage ?? memoryStorage();
  const controller = new SplitterController({
    root,
    chatHandle: chat,
    railHandle: rail,
    storage,
    viewportWidth: () => options.viewport ?? VIEWPORT,
    containerWidth: () => CONTAINER,
  });
  return { root, chat, rail, storage, controller };
}

function pointer(type: string, clientX: number): MouseEvent {
  return new MouseEvent(type, { clientX, button: 0, bubbles: true, cancelable: true });
}

function drag(handle: HTMLElement, from: number, to: number): void {
  handle.dispatchEvent(pointer('pointerdown', from));
  window.dispatchEvent(pointer('pointermove', to));
  window.dispatchEvent(pointer('pointerup', to));
}

function stored(storage: ReturnType<typeof memoryStorage>): unknown {
  const raw = storage.getItem(PANE_SIZES_KEY);
  return raw === null ? null : JSON.parse(raw);
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('splitter controller — drag (v6)', () => {
  it('paints the default pane sizes as CSS vars on construction', () => {
    const fixture = mount();
    expect(fixture.controller.current.chat).toBe(Math.round(CONTAINER * 0.3));
    expect(fixture.controller.current.rail).toBe(280);
    expect(fixture.root.style.getPropertyValue('--pane-chat-width')).toBe(
      `${fixture.controller.current.chat}px`,
    );
    expect(fixture.root.style.getPropertyValue('--pane-rail-width')).toBe('280px');
    expect(fixture.chat.getAttribute('aria-valuenow')).toBe(String(fixture.controller.current.chat));
  });

  it('dragging the chat boundary right widens the pane live', () => {
    const fixture = mount();
    const before = fixture.controller.current.chat;

    fixture.chat.dispatchEvent(pointer('pointerdown', 500));
    window.dispatchEvent(pointer('pointermove', 600));
    expect(fixture.controller.current.chat).toBe(before + 100);
    expect(fixture.root.style.getPropertyValue('--pane-chat-width')).toBe(`${before + 100}px`);
    expect(fixture.root.dataset.paneDragging).toBe('true');

    window.dispatchEvent(pointer('pointerup', 600));
    expect(fixture.root.dataset.paneDragging).toBeUndefined();
    expect(stored(fixture.storage)).toEqual({ cockpit: { chat: before + 100, rail: 280 } });
  });

  it('clamps the chat pane at its 420px floor on a long left drag', () => {
    const fixture = mount();
    drag(fixture.chat, 500, -5000);
    expect(fixture.controller.current.chat).toBe(CHAT_PANE_MIN_WIDTH);
    expect(fixture.controller.current.rail).toBe(280);
  });

  it('the rail boundary moves the rail: dragging left grows it, with the 240px floor', () => {
    const fixture = mount();
    drag(fixture.rail, 1000, 940);
    expect(fixture.controller.current.rail).toBe(340);
    expect(fixture.controller.current.chat).toBe(Math.round(CONTAINER * 0.3));

    drag(fixture.rail, 1000, 5000);
    expect(fixture.controller.current.rail).toBe(RAIL_MIN_WIDTH);
  });

  it('ignores gestures below the cockpit breakpoint (the handles are hidden there)', () => {
    const fixture = mount({ viewport: 800 });
    const before = fixture.controller.current;
    drag(fixture.chat, 500, 700);
    expect(fixture.controller.current).toEqual(before);
    expect(stored(fixture.storage)).toBeNull();
  });

  it('non-primary buttons never start a drag', () => {
    const fixture = mount();
    fixture.chat.dispatchEvent(new MouseEvent('pointerdown', { clientX: 500, button: 2, bubbles: true }));
    window.dispatchEvent(pointer('pointermove', 700));
    expect(stored(fixture.storage)).toBeNull();
  });
});

describe('splitter controller — persistence + reset (v6)', () => {
  it('restores the persisted pair on a fresh controller (reload)', () => {
    const storage = memoryStorage();
    const first = mount({ storage });
    drag(first.chat, 500, 560); // +60
    drag(first.rail, 1000, 960); // +40

    const second = mount({ storage });
    expect(second.controller.current).toEqual(first.controller.current);
    expect(second.root.style.getPropertyValue('--pane-chat-width')).toBe(
      `${first.controller.current.chat}px`,
    );
  });

  it('clamps a persisted pair that no longer fits the window', () => {
    const storage = memoryStorage();
    storage.setItem(PANE_SIZES_KEY, JSON.stringify({ cockpit: { chat: 9999, rail: 9999 } }));
    const fixture = mount({ storage });
    // The pair lands inside the container with the board floor respected —
    // never an overflowing cockpit.
    const { chat, rail } = fixture.controller.current;
    expect(chat).toBeGreaterThanOrEqual(CHAT_PANE_MIN_WIDTH);
    expect(rail).toBeGreaterThanOrEqual(RAIL_MIN_WIDTH);
    expect(chat + rail + 8 + 480).toBeLessThanOrEqual(CONTAINER);
  });

  it('double-click resets BOTH panes to their defaults and persists that', () => {
    const fixture = mount();
    drag(fixture.chat, 500, 600);
    drag(fixture.rail, 1000, 900);
    expect(stored(fixture.storage)).not.toEqual({ cockpit: { chat: 425, rail: 280 } });

    fixture.chat.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(fixture.controller.current).toEqual({ chat: Math.round(CONTAINER * 0.3), rail: 280 });
    expect(stored(fixture.storage)).toEqual({ cockpit: { chat: Math.round(CONTAINER * 0.3), rail: 280 } });
  });

  it('keyboard: arrows nudge the focused boundary, Home resets', () => {
    const fixture = mount();
    const before = fixture.controller.current.chat;
    fixture.chat.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(fixture.controller.current.chat).toBe(before + SPLITTER_KEY_STEP);
    fixture.chat.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    expect(fixture.controller.current.chat).toBe(before);

    fixture.rail.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    expect(fixture.controller.current.rail).toBe(280 + SPLITTER_KEY_STEP);

    fixture.chat.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    expect(fixture.controller.current).toEqual({ chat: Math.round(CONTAINER * 0.3), rail: 280 });
  });
});
