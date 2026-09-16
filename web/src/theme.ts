/**
 * Theme service: light is the default face; dark is a manual toggle,
 * persisted in localStorage. Anything unrecognised falls back to light.
 */

export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'gru-theme';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Resolve a stored value into a theme; unknown/missing → light. */
export function resolveTheme(stored: string | null): Theme {
  return stored === 'dark' ? 'dark' : 'light';
}

export function getTheme(storage: StorageLike): Theme {
  return resolveTheme(storage.getItem(THEME_STORAGE_KEY));
}

export function setTheme(storage: StorageLike, theme: Theme): void {
  storage.setItem(THEME_STORAGE_KEY, theme);
}

export function toggleTheme(storage: StorageLike): Theme {
  const next = getTheme(storage) === 'dark' ? 'light' : 'dark';
  setTheme(storage, next);
  return next;
}

/** Apply the theme to the document root (`.dark` flips the token set). */
export function applyTheme(doc: { documentElement: { classList: DOMTokenList } }, theme: Theme): void {
  doc.documentElement.classList.toggle('dark', theme === 'dark');
}
