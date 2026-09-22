/**
 * Board card disclosure state (v3): which job cards the operator has
 * expanded. Only touched jobs carry an entry — absence means collapsed,
 * so a fresh board is compact by default.
 *
 * Reads tolerate junk (a corrupted/missing key must never blank the
 * board) and writes tolerate blocked storage (persistence is a
 * convenience; the board still renders without it).
 */

import type { StorageLike } from '../theme.js';

export const BOARD_EXPANDED_KEY = 'gru-board-expanded-jobs';

/** Expanded job ids from storage; anything unreadable/malformed → none. */
export function loadExpandedJobs(storage: StorageLike): Set<string> {
  let raw: string | null;
  try {
    raw = storage.getItem(BOARD_EXPANDED_KEY);
  } catch {
    return new Set();
  }
  if (raw === null || raw === '') return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  const ids = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry === 'string' && entry !== '') ids.add(entry);
  }
  return ids;
}

/** Persist the expanded set; the empty set clears the key entirely. */
export function saveExpandedJobs(storage: StorageLike, expanded: ReadonlySet<string>): void {
  try {
    if (expanded.size === 0) storage.removeItem(BOARD_EXPANDED_KEY);
    else storage.setItem(BOARD_EXPANDED_KEY, JSON.stringify([...expanded]));
  } catch {
    /* storage blocked/quota-full — disclosure state is not worth failing the board */
  }
}
