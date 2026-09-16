/** Settings stub: theme toggle, endpoint display, unpair. Grows in E6+. */

import { getTheme, setTheme, applyTheme, type StorageLike } from '../theme.js';
import { mustGet } from './dom.js';

export interface SettingsOptions {
  readonly storage: StorageLike;
  readonly wsUrl: string;
  readonly onUnpair: () => void;
}

export function initSettings(options: SettingsOptions): void {
  const view = mustGet<HTMLElement>('settings-view');
  mustGet<HTMLButtonElement>('settings-toggle').addEventListener('click', () => {
    view.hidden = !view.hidden;
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
  });
  syncLabel();

  mustGet<HTMLButtonElement>('settings-unpair').addEventListener('click', options.onUnpair);
}
