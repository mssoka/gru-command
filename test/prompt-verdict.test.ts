import { describe, expect, it } from 'vitest';
import { promptVerdictFromHealth } from '../src/runtime/prompt-verdict.js';
import type { AgentHealth } from '../src/runtime/types.js';

/**
 * The settle-time fallback verdict (#160): positive completion requires the
 * runtime's terminal state to be `idle`. An in-band `error` carries its
 * detail; every other state is a failed/unknown terminal outcome that must
 * never mint a delivery merely because the prompt promise resolved.
 */

function handleWith(health: AgentHealth): { health(): AgentHealth } {
  return { health: () => health };
}

describe('promptVerdictFromHealth (#160)', () => {
  it('idle is the only positive completion state', () => {
    expect(promptVerdictFromHealth(handleWith({ state: 'idle', lastActivity: null, sessionFile: null })))
      .toEqual({ ok: true, error: null });
  });

  it('an in-band error carries its own detail', () => {
    expect(promptVerdictFromHealth(handleWith({
      state: 'error', lastActivity: null, sessionFile: null, error: 'assistant stopReason error',
    }))).toEqual({ ok: false, error: 'assistant stopReason error' });
    // A detail-less error is still a failure, never a silent success.
    expect(promptVerdictFromHealth(handleWith({ state: 'error', lastActivity: null, sessionFile: null })))
      .toMatchObject({ ok: false });
  });

  it('streaming and spawning are unknown terminal outcomes, never success', () => {
    for (const state of ['streaming', 'spawning'] as const) {
      const verdict = promptVerdictFromHealth(handleWith({ state, lastActivity: null, sessionFile: null }));
      expect(verdict.ok).toBe(false);
      expect(verdict.error).toContain(state);
    }
  });

  it('a disposed session is not positive completion evidence', () => {
    const verdict = promptVerdictFromHealth(handleWith({ state: 'disposed', lastActivity: null, sessionFile: null }));
    expect(verdict.ok).toBe(false);
    expect(verdict.error).toContain('disposed');
  });

  it('a throwing health read is unproven and never becomes success', () => {
    const handle = {
      health(): AgentHealth {
        throw new Error('health probe exploded');
      },
    };
    expect(promptVerdictFromHealth(handle)).toEqual({
      ok: false,
      error: 'runtime terminal health unreadable: Error: health probe exploded',
    });
  });
});
