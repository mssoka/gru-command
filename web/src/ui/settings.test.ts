// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initSettings, THEME_EVENT } from './settings.js';

/**
 * Settings rides the themed Gru modal: the toggle opens the panel as a
 * centered dialog wherever the reader is — a reader scrolled deep into
 * the board sees it immediately, where the old inline un-hide showed
 * nothing until they scrolled back to the top of the page.
 */

function installSettingsDom(): void {
  document.body.replaceChildren();
  const main = document.createElement('main');
  const toggle = document.createElement('button');
  toggle.id = 'settings-toggle';
  toggle.type = 'button';
  const view = document.createElement('section');
  view.id = 'settings-view';
  view.hidden = true;
  const endpoint = document.createElement('span');
  endpoint.id = 'settings-endpoint';
  const theme = document.createElement('button');
  theme.id = 'settings-theme';
  theme.type = 'button';
  const unpair = document.createElement('button');
  unpair.id = 'settings-unpair';
  unpair.type = 'button';
  const row = document.createElement('div');
  row.append(endpoint, theme, unpair);
  view.append(row);
  main.append(toggle, view);
  document.body.append(main);
}

function memoryStorage(): Map<string, string> {
  return new Map<string, string>();
}

function storageLike(map: Map<string, string>): StorageLikeShim {
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

interface StorageLikeShim {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function toggle(): HTMLButtonElement {
  return document.getElementById('settings-toggle') as HTMLButtonElement;
}

function view(): HTMLElement {
  return document.getElementById('settings-view') as HTMLElement;
}

beforeEach(() => {
  installSettingsDom();
});

afterEach(() => {
  // Close surviving dialogs through their ✕ so module state unwinds
  // exactly as in production; the host strip is a failed-test net.
  for (const close of [...document.querySelectorAll<HTMLButtonElement>('.gru-modal__close')]) {
    close.click();
  }
  for (const host of [...document.querySelectorAll('.gru-modal')]) host.remove();
  document.documentElement.classList.remove('gru-modal-open');
});

describe('settings dialog', () => {
  it('opens as a centered Gru modal — visible no matter how far down the page the reader is', () => {
    initSettings({ storage: storageLike(memoryStorage()), wsUrl: 'ws://x', onUnpair: () => {} });
    toggle().click();

    const dialog = document.querySelector<HTMLElement>('.gru-modal [role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
    // The panel is borrowed INTO the dialog: it renders center screen at
    // the gesture, not as an inline card at the top of the page.
    expect(dialog!.contains(view())).toBe(true);
    expect(view().hidden).toBe(false);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(document.documentElement.classList.contains('gru-modal-open')).toBe(true);
  });

  it('the toggle closes an open dialog; the panel returns home hidden', () => {
    initSettings({ storage: storageLike(memoryStorage()), wsUrl: 'ws://x', onUnpair: () => {} });
    toggle().click();
    toggle().click();

    expect(document.querySelector('.gru-modal')).toBeNull();
    expect(view().hidden).toBe(true);
    // Home is the original parent (the page keeps the section in the
    // document; re-opening re-borrows it).
    expect(view().parentElement).toBe(toggle().parentElement);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape closes the dialog and re-hides the panel', () => {
    initSettings({ storage: storageLike(memoryStorage()), wsUrl: 'ws://x', onUnpair: () => {} });
    toggle().click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(document.querySelector('.gru-modal')).toBeNull();
    expect(view().hidden).toBe(true);
  });

  it('re-opening after a close borrows the same panel again', () => {
    initSettings({ storage: storageLike(memoryStorage()), wsUrl: 'ws://x', onUnpair: () => {} });
    toggle().click();
    toggle().click();
    toggle().click();
    const dialog = document.querySelector<HTMLElement>('.gru-modal [role="dialog"]');
    expect(dialog?.contains(view())).toBe(true);
  });

  it('the controls inside the modal stay live: endpoint shows, theme toggles, unpair fires', () => {
    const map = memoryStorage();
    const onUnpair = vi.fn();
    initSettings({ storage: storageLike(map), wsUrl: 'ws://gruhq:1', onUnpair });
    toggle().click();

    expect(document.getElementById('settings-endpoint')?.textContent).toBe('ws://gruhq:1');

    const events: string[] = [];
    window.addEventListener(THEME_EVENT, (event) => events.push(String((event as CustomEvent).detail)));

    const theme = document.getElementById('settings-theme') as HTMLButtonElement;
    expect(theme.textContent).toContain('light');
    theme.click();
    expect(map.get('gru-theme')).toBe('dark');
    expect(theme.textContent).toContain('dark');
    expect(events).toEqual(['dark']);

    (document.getElementById('settings-unpair') as HTMLButtonElement).click();
    expect(onUnpair).toHaveBeenCalledTimes(1);
  });
});
