import type { AgentHandle } from './types.js';

/** Private exact-object settlement edge. Observers survive watchdog shutdown;
 * their failure must never change the adapter's disposal result. */
const observers = new WeakMap<AgentHandle, Set<(acknowledged: boolean) => void>>();

export function observeDisposalSettlement(handle: AgentHandle, listener: (acknowledged: boolean) => void): () => void {
  let listeners = observers.get(handle);
  if (listeners === undefined) { listeners = new Set(); observers.set(handle, listeners); }
  listeners.add(listener);
  return () => { listeners.delete(listener); if (listeners.size === 0) observers.delete(handle); };
}

export function notifyDisposalSettlement(handle: AgentHandle, acknowledged: boolean): void {
  for (const listener of [...(observers.get(handle) ?? [])]) {
    try { listener(acknowledged); } catch { /* observer errors cannot alter disposal truth */ }
  }
}
