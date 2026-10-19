/** Settings stub: theme toggle, endpoint display, unpair. Grows in E6+. */

import { getTheme, setTheme, applyTheme, type StorageLike } from '../theme.js';
import { mustGet } from './dom.js';
import { openModal, type ModalHandle } from './modal.js';

export const THEME_EVENT = 'gru-theme-changed';

export interface SettingsOptions {
  readonly storage: StorageLike;
  readonly wsUrl: string;
  readonly onUnpair: () => void;
}

export function initSettings(options: SettingsOptions): void {
  const view = mustGet<HTMLElement>('settings-view');
  const toggle = mustGet<HTMLButtonElement>('settings-toggle');
  toggle.setAttribute('aria-haspopup', 'dialog');
  toggle.setAttribute('aria-expanded', 'false');

  // The panel is borrowed content inside the themed Gru modal: it opens
  // center screen wherever the reader is. Un-hiding a card at the top of
  // the page (the old behavior) showed nothing to a reader scrolled down
  // into the board — the panel existed off-screen until they scrolled
  // all the way back up.
  let dialog: ModalHandle | null = null;
  toggle.addEventListener('click', () => {
    if (dialog !== null) {
      dialog.close();
      return;
    }
    view.hidden = false;
    dialog = openModal({
      title: 'Settings',
      glyph: '⚙️',
      content: view,
      onClose: () => {
        dialog = null;
        view.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
      },
    });
    toggle.setAttribute('aria-expanded', 'true');
  });

  mustGet<HTMLElement>('settings-endpoint').textContent = options.wsUrl;

  const themeToggle = mustGet<HTMLButtonElement>('settings-theme');
  const syncLabel = (): void => {
    themeToggle.textContent = getTheme(options.storage) === 'dark' ? '🌙 dark' : '☀️ light';
  };
  themeToggle.addEventListener('click', () => {
    const next = getTheme(options.storage) === 'dark' ? 'light' : 'dark';
    setTheme(options.storage, next);
    applyTheme(document, next);
    syncLabel();
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: next }));
  });
  // The nav toggle fires the same event — keep both labels in sync.
  window.addEventListener(THEME_EVENT, syncLabel);
  // Re-sync every time the panel opens (cheap and always correct).
  toggle.addEventListener('click', syncLabel);
  syncLabel();

  mustGet<HTMLButtonElement>('settings-unpair').addEventListener('click', options.onUnpair);
}
