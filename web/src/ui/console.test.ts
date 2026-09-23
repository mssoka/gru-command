// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../lib/chat-storage.js';
import { CHAT_PANE_COLLAPSED_KEY } from '../lib/console-layout.js';
import { CONSOLE_QUERY, ConsoleShell, type ChatPaneHandle, type MediaQueryLike } from './console.js';

/**
 * The console shell (v5): the Gru FAB's breakpoint contract and the chat
 * pane's persisted collapse state. The chat view itself is mocked through
 * ChatPaneHandle — this suite pins the shell's behavior alone.
 */

interface ShellFixture {
  readonly shell: ConsoleShell;
  readonly root: HTMLElement;
  readonly fab: HTMLButtonElement;
  readonly rail: HTMLButtonElement;
  readonly collapse: HTMLButtonElement;
  readonly chat: { focusComposer: ReturnType<typeof vi.fn>; openSheet: ReturnType<typeof vi.fn>; closeSheet: ReturnType<typeof vi.fn>; setPaneCollapsed: ReturnType<typeof vi.fn> };
  setConsoleMode(matches: boolean): void;
  readonly storage: ReturnType<typeof memoryStorage>;
}

function mountShell(options: { consoleMatches?: boolean; storage?: ReturnType<typeof memoryStorage>; withCollapseButton?: boolean } = {}): ShellFixture {
  document.body.replaceChildren();
  const root = document.createElement('div');
  const fab = document.createElement('button');
  const rail = document.createElement('button');
  const collapse = document.createElement('button');
  document.body.append(root, fab, rail, collapse);

  let consoleMatches = options.consoleMatches ?? true;
  const listeners: Array<() => void> = [];
  const matchMedia = (query: string): MediaQueryLike => ({
    get matches() {
      return query === CONSOLE_QUERY && consoleMatches;
    },
    addEventListener: (_type: string, listener: () => void) => {
      if (query === CONSOLE_QUERY) listeners.push(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
  });

  const chat = {
    focusComposer: vi.fn(),
    openSheet: vi.fn(),
    closeSheet: vi.fn(),
    setPaneCollapsed: vi.fn(),
  } satisfies ChatPaneHandle;
  const storage = options.storage ?? memoryStorage();
  const shell = new ConsoleShell({
    root,
    fab,
    rail,
    collapseButton: options.withCollapseButton === false ? null : collapse,
    chat,
    storage,
    matchMedia,
  });

  return {
    shell,
    root,
    fab,
    rail,
    collapse,
    chat,
    storage,
    setConsoleMode: (matches: boolean) => {
      consoleMatches = matches;
      for (const listener of listeners) listener();
    },
  };
}

describe('console shell — FAB mode switch (v6)', () => {
  let fixture: ShellFixture;

  beforeEach(() => {
    fixture = mountShell();
  });

  it('at cockpit width the FAB toggles the chat pane; expanding focuses the composer', () => {
    expect(fixture.shell.collapsed).toBe(false);

    fixture.fab.click();
    expect(fixture.shell.collapsed).toBe(true);
    expect(fixture.root.classList.contains('console--chat-collapsed')).toBe(true);
    expect(fixture.chat.setPaneCollapsed).toHaveBeenLastCalledWith(true);
    expect(fixture.chat.focusComposer).not.toHaveBeenCalled();

    fixture.fab.click();
    expect(fixture.shell.collapsed).toBe(false);
    expect(fixture.root.classList.contains('console--chat-collapsed')).toBe(false);
    expect(fixture.chat.setPaneCollapsed).toHaveBeenLastCalledWith(false);
    expect(fixture.chat.focusComposer).toHaveBeenCalledTimes(1);
  });

  it('below the cockpit breakpoint the FAB opens the overlay sheet and leaves the pane state alone', () => {
    fixture = mountShell({ consoleMatches: false });
    fixture.fab.click();
    expect(fixture.chat.openSheet).toHaveBeenCalledTimes(1);
    expect(fixture.shell.collapsed).toBe(false);
    expect(fixture.chat.setPaneCollapsed).toHaveBeenLastCalledWith(false);

    // The pane-head button closes the overlay (it has no pane to collapse).
    fixture.collapse.click();
    expect(fixture.chat.closeSheet).toHaveBeenCalledTimes(1);
    expect(fixture.shell.collapsed).toBe(false);
  });

  it('the pane-head button collapses on the console and switches to close in the overlay', () => {
    expect(fixture.collapse.textContent).toBe('⇤');
    expect(fixture.collapse.getAttribute('aria-label')).toBe('Collapse chat');
    fixture.setConsoleMode(false);
    expect(fixture.collapse.textContent).toBe('✕');
    expect(fixture.collapse.getAttribute('aria-label')).toBe('Close chat');
    fixture.collapse.click();
    expect(fixture.chat.closeSheet).toHaveBeenCalledTimes(1);
    expect(fixture.shell.collapsed).toBe(false);
    fixture.setConsoleMode(true);
    fixture.collapse.click();
    expect(fixture.shell.collapsed).toBe(true);
  });

  it('the in-pane collapse control collapses; the slim rail expands + focuses', () => {
    fixture.collapse.click();
    expect(fixture.shell.collapsed).toBe(true);
    fixture.rail.click();
    expect(fixture.shell.collapsed).toBe(false);
    expect(fixture.chat.focusComposer).toHaveBeenCalledTimes(1);
  });

  it('crossing the breakpoint updates the FAB contract without touching state', () => {
    fixture.fab.setAttribute('aria-expanded', 'true');
    fixture.setConsoleMode(false);
    expect(fixture.fab.getAttribute('aria-expanded')).toBe('false');
    expect(fixture.fab.title).toBe('Chat with Gru');
    fixture.fab.click();
    expect(fixture.chat.openSheet).toHaveBeenCalledTimes(1);
    expect(fixture.shell.collapsed).toBe(false);
  });
});

describe('console shell — chat pane collapse persistence (v5)', () => {
  it('persists the collapsed state in localStorage and restores it', () => {
    const storage = memoryStorage();
    const first = mountShell({ storage });
    first.fab.click();
    expect(storage.getItem(CHAT_PANE_COLLAPSED_KEY)).toBe('true');

    // A fresh load over the same storage = a page reload.
    const second = mountShell({ storage });
    expect(second.shell.collapsed).toBe(true);
    expect(second.root.classList.contains('console--chat-collapsed')).toBe(true);
    expect(second.chat.setPaneCollapsed).toHaveBeenLastCalledWith(true);

    second.rail.click();
    expect(storage.getItem(CHAT_PANE_COLLAPSED_KEY)).toBeNull();
    expect(second.shell.collapsed).toBe(false);
  });

  it('starts expanded when storage holds junk or is absent', () => {
    const storage = memoryStorage();
    storage.setItem(CHAT_PANE_COLLAPSED_KEY, 'nonsense');
    const fixture = mountShell({ storage });
    expect(fixture.shell.collapsed).toBe(false);
    expect(fixture.root.classList.contains('console--chat-collapsed')).toBe(false);
  });
});
