import { describe, expect, it } from 'vitest';
import { CHAT_OUTBOX_KEY, memoryStorage, migrateLegacyOutbox, safeStorage } from './chat-storage.js';
import type { StorageLike } from '../theme.js';

function storage(initial?: string): StorageLike & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  if (initial !== undefined) map.set(CHAT_OUTBOX_KEY, initial);
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

const entry = (id: string, text: string) => ({ client_msg_id: id, text, status: 'queued' });

describe('chat outbox storage migration', () => {
  it('moves a legacy queue atomically and survives a tab reload', () => {
    const legacy = JSON.stringify([entry('a', 'legacy word')]);
    const local = storage(legacy);
    const tab = storage();
    expect(migrateLegacyOutbox(local, tab)).toBe(true);
    expect(local.map.has(CHAT_OUTBOX_KEY)).toBe(false);
    expect(tab.getItem(CHAT_OUTBOX_KEY)).toBe(legacy);
    // A reload receives the same tab storage; a different tab remains isolated.
    expect(tab.getItem(CHAT_OUTBOX_KEY)).toContain('legacy word');
    expect(storage().getItem(CHAT_OUTBOX_KEY)).toBeNull();
  });

  it('merges unique legacy words while destination entries win duplicate ids', () => {
    const local = storage(JSON.stringify([entry('same', 'stale'), entry('legacy', 'keep')]));
    const tab = storage(JSON.stringify([entry('same', 'current'), entry('tab', 'tab-only')]));
    expect(migrateLegacyOutbox(local, tab)).toBe(true);
    expect(JSON.parse(tab.getItem(CHAT_OUTBOX_KEY)!)).toEqual([
      entry('same', 'current'),
      entry('tab', 'tab-only'),
      entry('legacy', 'keep'),
    ]);
    expect(local.map.has(CHAT_OUTBOX_KEY)).toBe(false);
  });

  it('retains the legacy source when the target write fails', () => {
    const legacy = JSON.stringify([entry('a', 'do not lose')]);
    const local = storage(legacy);
    const blocked: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {},
    };
    expect(migrateLegacyOutbox(local, blocked)).toBe(false);
    expect(local.getItem(CHAT_OUTBOX_KEY)).toBe(legacy);
  });

  it('falls back when acquiring or probing browser storage throws', () => {
    const acquired = safeStorage(() => {
      throw new Error('SecurityError');
    });
    acquired.setItem('x', '1');
    expect(acquired.getItem('x')).toBe('1');

    const methodsBlocked: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {},
    };
    const probed = safeStorage(() => methodsBlocked);
    probed.setItem('y', '2');
    expect(probed.getItem('y')).toBe('2');
    expect(memoryStorage().getItem('missing')).toBeNull();
  });
});
