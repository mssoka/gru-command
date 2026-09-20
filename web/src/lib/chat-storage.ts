import type { StorageLike } from '../theme.js';

export const CHAT_OUTBOX_KEY = 'gru-outbox';

/** Small per-page fallback used when a browser blocks a Storage getter. */
export function memoryStorage(): StorageLike {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}

/** Accessing window.localStorage/sessionStorage can itself throw. */
export function safeStorage(getter: () => StorageLike): StorageLike {
  try {
    const storage = getter();
    // Probe methods too: some privacy modes expose the getter but reject use.
    const probe = '__gru_storage_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return memoryStorage();
  }
}

/**
 * Move the old shared localStorage outbox into this tab's sessionStorage.
 * Destination entries win on duplicate ids; unique legacy entries are
 * retained. The shared source is removed only after the complete merged
 * target was written, so a failed write cannot lose queued words.
 */
export function migrateLegacyOutbox(source: StorageLike, target: StorageLike): boolean {
  let legacy: string | null;
  let current: string | null;
  try {
    legacy = source.getItem(CHAT_OUTBOX_KEY);
    if (legacy === null) return true;
    current = target.getItem(CHAT_OUTBOX_KEY);
  } catch {
    return false;
  }

  try {
    const merged = mergeOutboxes(current, legacy);
    target.setItem(CHAT_OUTBOX_KEY, merged);
    source.removeItem(CHAT_OUTBOX_KEY);
    return true;
  } catch {
    return false;
  }
}

function mergeOutboxes(current: string | null, legacy: string): string {
  if (current === null) return legacy;
  const destination = parseArray(current);
  const source = parseArray(legacy);
  const merged: unknown[] = [...destination];
  const ids = new Set(destination.map(clientMessageId).filter((id): id is string => id !== null));
  for (const entry of source) {
    const id = clientMessageId(entry);
    if (id !== null && ids.has(id)) continue;
    merged.push(entry);
    if (id !== null) ids.add(id);
  }
  return JSON.stringify(merged);
}

function parseArray(raw: string): unknown[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('chat outbox is not an array');
  return parsed;
}

function clientMessageId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const id = (value as Record<string, unknown>).client_msg_id;
  return typeof id === 'string' && id !== '' ? id : null;
}
