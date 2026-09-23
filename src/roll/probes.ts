import type { LedgerApi } from '../ledger/api.js';
import type { RuntimeRegistry } from '../runtime/registry.js';
import type { RollWorkItem } from './state.js';

/**
 * Drain probes (graceful self-roll, phase b): what is still in flight when
 * a swap would happen?
 *
 *  - review rounds in a non-terminal state (pending/live) — the Perkins
 *    runner certifies or aborts them; a swap mid-round terminalizes them
 *    INCOMPLETE via startup recovery, so the drain waits politely first.
 *  - agent sessions whose runtime state is `spawning` or `streaming` —
 *    a mid-turn minion/reviewer/lead. Interrupted turns resume under the
 *    existing supervision cure (#42); the drain still prefers to let them
 *    settle inside the bound.
 */
export function createRollProbes(input: {
  readonly ledger: LedgerApi;
  readonly registry: RuntimeRegistry;
}): () => Promise<readonly RollWorkItem[]> {
  return async () => {
    const items: RollWorkItem[] = [];
    for (const round of input.ledger.listActiveRounds()) {
      items.push({ kind: 'round', id: round.id, status: round.status });
    }
    for (const handle of input.registry.listHandles()) {
      const state = handle.health().state;
      if (state !== 'spawning' && state !== 'streaming') continue;
      items.push({ kind: 'minion', id: handle.id, status: state });
    }
    return items;
  };
}
