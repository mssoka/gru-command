import { describe, expect, it } from 'vitest';
import { getTheme, resolveTheme, setTheme, toggleTheme, THEME_STORAGE_KEY, type StorageLike } from './theme.js';

function memStorage(initial: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe('theme', () => {
  it('light is the default face (missing or unknown stored value)', () => {
    expect(resolveTheme(null)).toBe('light');
    expect(resolveTheme('')).toBe('light');
    expect(resolveTheme('purple')).toBe('light');
    expect(getTheme(memStorage())).toBe('light');
  });

  it('persists the manual dark toggle', () => {
    const storage = memStorage();
    expect(toggleTheme(storage)).toBe('dark');
    expect(storage.map.get(THEME_STORAGE_KEY)).toBe('dark');
    expect(toggleTheme(storage)).toBe('light');
    expect(storage.map.get(THEME_STORAGE_KEY)).toBe('light');
  });

  it('setTheme/getTheme round-trip', () => {
    const storage = memStorage();
    setTheme(storage, 'dark');
    expect(getTheme(storage)).toBe('dark');
  });
});
