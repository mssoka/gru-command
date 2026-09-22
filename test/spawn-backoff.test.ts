import { describe, expect, it } from 'vitest';
import { SpawnRetryGate } from '../src/chat/spawn-backoff.js';

describe('SpawnRetryGate (bounded spawn retries)', () => {
  it('doubles the cooldown per consecutive failure and caps it', () => {
    const gate = new SpawnRetryGate(100, 700);
    expect(gate.recordFailure(0)).toBe(100);
    expect(gate.recordFailure(0)).toBe(200);
    expect(gate.recordFailure(0)).toBe(400);
    expect(gate.recordFailure(0)).toBe(700); // 800 capped to 700
    expect(gate.recordFailure(0)).toBe(700);
    expect(gate.failureCount).toBe(5);
  });

  it('blocks only until the window expires, then allows the next attempt', () => {
    const gate = new SpawnRetryGate(100, 1_000);
    gate.recordFailure(1_000);
    expect(gate.isBlocked(1_000)).toBe(true);
    expect(gate.blockedFor(1_050)).toBe(50);
    expect(gate.isBlocked(1_099)).toBe(true);
    expect(gate.isBlocked(1_100)).toBe(false);
    expect(gate.blockedFor(1_200)).toBe(0);
  });

  it('a successful spawn resets the failure episode', () => {
    const gate = new SpawnRetryGate(100, 1_000);
    gate.recordFailure(0);
    gate.recordFailure(0);
    expect(gate.failureCount).toBe(2);
    gate.reset();
    expect(gate.failureCount).toBe(0);
    expect(gate.isBlocked(0)).toBe(false);
    expect(gate.recordFailure(0)).toBe(100); // back to the base, not 400
  });

  it('a zero base or cap disables the gate (test seam)', () => {
    const gate = new SpawnRetryGate(0, 60_000);
    expect(gate.recordFailure(0)).toBe(0);
    expect(gate.isBlocked(0)).toBe(false);
    const capped = new SpawnRetryGate(1_000, 0);
    expect(capped.recordFailure(0)).toBe(0);
    expect(capped.isBlocked(0)).toBe(false);
  });

  it('never overflows a long outage', () => {
    const gate = new SpawnRetryGate(10, 50);
    expect(gate.recordFailure(0)).toBe(10);
    expect(gate.recordFailure(0)).toBe(20);
    expect(gate.recordFailure(0)).toBe(40);
    for (let index = 0; index < 100; index += 1) {
      expect(gate.recordFailure(0)).toBe(50);
    }
  });
});
