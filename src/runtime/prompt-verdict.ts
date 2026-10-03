import type { AgentHandle, PromptOptions, PromptTurnVerdict } from './types.js';

/**
 * Per-prompt terminal evidence plumbing (r5 blocker 1).
 *
 * `health()` alone is NOT safe as a delivery gate: single-writer queues
 * pump the next turn INSIDE the settle path, ahead of the awaiting caller's
 * continuation (the Claude fallback wrapper's `deliver` finally and the Pi
 * adapter's `runTurn` finally), so by the time a caller resumes, the
 * handle's current state can already belong to a queued successor. The
 * adapters capture the verdict for the settled turn before that pump;
 * this module is the one calling convention every delivery site uses so
 * the fallback for non-attesting handles cannot drift between callers.
 */

/** Settle-time health fallback for handles without per-turn capture (and
 * structural/test doubles). Missing health carries no failure evidence;
 * a throwing health read is unproven and never becomes success. */
export function promptVerdictFromHealth(handle: Pick<AgentHandle, 'health'>): PromptTurnVerdict {
  if (typeof handle.health !== 'function') return { ok: true, error: null };
  try {
    const health = handle.health();
    if (health.state === 'error') {
      return { ok: false, error: health.error ?? 'runtime settled the turn with an in-band error' };
    }
    return { ok: true, error: null };
  } catch (error) {
    return { ok: false, error: `runtime terminal health unreadable: ${String(error)}` };
  }
}

/** Prompt through the best available terminal evidence: the handle's
 * captured per-turn verdict when it attests, otherwise the legacy
 * prompt + settle-time health fallback. Rejections propagate unchanged. */
export async function promptWithTerminalVerdict(
  handle: Pick<AgentHandle, 'prompt' | 'health'> & Partial<Pick<AgentHandle, 'promptWithVerdict'>>,
  text: string,
  options?: PromptOptions,
): Promise<PromptTurnVerdict> {
  if (handle.promptWithVerdict !== undefined) {
    return handle.promptWithVerdict(text, options);
  }
  await handle.prompt(text, options);
  return promptVerdictFromHealth(handle);
}
