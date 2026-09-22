import { describe, expect, it } from 'vitest';
import { memoryStorage } from './chat-storage.js';
import { BOARD_EXPANDED_KEY, loadExpandedJobs, saveExpandedJobs } from './board-collapse.js';

function throwingStorage(): {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
} {
  return {
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
}

describe('board collapse state', () => {
  it('loads an empty set when nothing is stored', () => {
    expect(loadExpandedJobs(memoryStorage())).toEqual(new Set());
  });

  it('round-trips expanded ids and clears the key on an empty set', () => {
    const storage = memoryStorage();
    saveExpandedJobs(storage, new Set(['job-1', 'job-2']));
    expect(storage.getItem(BOARD_EXPANDED_KEY)).toBe('["job-1","job-2"]');
    expect(loadExpandedJobs(storage)).toEqual(new Set(['job-1', 'job-2']));

    storage.setItem(BOARD_EXPANDED_KEY, '[]');
    saveExpandedJobs(storage, new Set());
    expect(storage.getItem(BOARD_EXPANDED_KEY)).toBeNull();
  });

  it('tolerates malformed stored values — the board defaults to collapsed, never blank', () => {
    const storage = memoryStorage();
    for (const raw of ['not json', '{"job":true}', '42']) {
      storage.setItem(BOARD_EXPANDED_KEY, raw);
      expect(loadExpandedJobs(storage)).toEqual(new Set());
    }
    // Junk entries inside a valid array are filtered; valid ids stay.
    storage.setItem(BOARD_EXPANDED_KEY, '[1, null, "", "job-9"]');
    expect(loadExpandedJobs(storage)).toEqual(new Set(['job-9']));
  });

  it('survives storage that throws on every access', () => {
    const storage = throwingStorage();
    expect(loadExpandedJobs(storage)).toEqual(new Set());
    expect(() => saveExpandedJobs(storage, new Set(['job-1']))).not.toThrow();
    expect(() => saveExpandedJobs(storage, new Set())).not.toThrow();
  });
});
