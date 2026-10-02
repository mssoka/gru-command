import { describe, expect, it } from 'vitest';
import {
  fanOutPermittedFor,
  type ProgressObservation,
} from '../src/provider-recovery/admission-observations.js';

/**
 * The progress-gated fan-out decision (phase3 r1 #4): expansion beyond the
 * FIRST continuation is permitted only for a progress observation whose
 * bindings EXACTLY match the open claim's admission receipt — claim,
 * admitted actor, session turn, route and credential generation. Old or
 * other-turn progress never opens fan-out; the gate is pure and
 * deterministic, independent of the (not-yet-grounded) cap emitter.
 */

const OPEN_CLAIM = {
  claimId: 'claim-1',
  incidentSeq: 3,
  logicalSlot: 'silas-ops' as string | null,
  admittedAgentId: 'agent-9',
  admittedSessionTurn: 'turn-42',
  routeKey: 'zai-coding-cn/glm-5.3@fp1',
  credentialGeneration: 7,
};

function progress(overrides: Partial<ProgressObservation> = {}): ProgressObservation {
  return {
    claimId: 'claim-1',
    agentId: 'agent-9',
    sessionTurn: 'turn-42',
    routeKey: 'zai-coding-cn/glm-5.3@fp1',
    credentialGeneration: 7,
    observedAt: '2026-09-29T10:00:00Z',
    ...overrides,
  };
}

describe('fan-out gate — ALL bindings enforced', () => {
  it('permits progress bound to the same claim/actor/turn/route/credential generation', () => {
    expect(fanOutPermittedFor(OPEN_CLAIM, progress())).toBe(true);
  });

  it('refuses every single-binding mismatch', () => {
    expect(fanOutPermittedFor(OPEN_CLAIM, progress({ claimId: 'claim-2' }))).toBe(false);
    expect(fanOutPermittedFor(OPEN_CLAIM, progress({ agentId: 'agent-other' }))).toBe(false);
    expect(fanOutPermittedFor(OPEN_CLAIM, progress({ sessionTurn: 'turn-41' }))).toBe(false);
    expect(fanOutPermittedFor(OPEN_CLAIM, progress({ routeKey: 'zai-coding-cn/glm-5.3@fp2' }))).toBe(false);
    expect(fanOutPermittedFor(OPEN_CLAIM, progress({ credentialGeneration: 6 }))).toBe(false);
  });

  it('refuses old/other-turn progress and degenerate incident sequences', () => {
    // A late settlement receipt from the PREVIOUS turn of the same actor
    // must not open fan-out.
    const previousTurn = progress({ sessionTurn: 'turn-41' });
    expect(fanOutPermittedFor(OPEN_CLAIM, previousTurn)).toBe(false);
    // The gate only applies to real claims (incident sequence >= 1).
    expect(fanOutPermittedFor({ ...OPEN_CLAIM, incidentSeq: 0 }, progress())).toBe(false);
  });

  it('job-minion claims (no logical slot) share the same exact-binding contract', () => {
    const minionClaim = { ...OPEN_CLAIM, logicalSlot: null };
    expect(fanOutPermittedFor(minionClaim, progress())).toBe(true);
  });
});
