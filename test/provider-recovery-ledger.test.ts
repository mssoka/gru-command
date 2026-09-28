import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';

/**
 * Provider-recovery durable state (migration 9): waits, routes, and the
 * deduplicated pending-recovery marker — the restart-safe delivery
 * handoff. State machine: terminal rows never return to waiting.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function makeLedger(): LedgerApi {
  const dir = mkdtempSync(join(tmpdir(), 'gru-command-pr-ledger-'));
  cleanupDirs.push(dir);
  const db = new LedgerDb(dir);
  return new LedgerApi(db.handle);
}

function waitInput(overrides: Partial<Parameters<LedgerApi['recordProviderWait']>[0]> = {}) {
  return {
    id: 'w1',
    routeKey: 'zai-coding-cn/glm-5.3@fp1',
    provider: 'zai-coding-cn',
    model: 'glm-5.3',
    credentialFingerprint: 'fp1',
    waiterKind: 'job-minion' as const,
    jobId: null,
    agentId: 'agent-1',
    slotId: null,
    sessionFile: '/tmp/session.jsonl',
    continuation: { promptText: 'do the thing', promptOwner: 'minion-brief', hadOpenTurn: true },
    incidentId: 'supervision.provider-wall.agent-1.quota_wall',
    incidentGeneration: 1,
    reasonClass: 'temporary-recoverable:429',
    ...overrides,
  };
}

describe('provider waits (migration 9)', () => {
  it('records an explicit wait with its full route binding and continuation', () => {
    const ledger = makeLedger();
    const wait = ledger.recordProviderWait(waitInput());
    expect(wait.status).toBe('waiting');
    expect(wait.routeKey).toBe('zai-coding-cn/glm-5.3@fp1');
    expect(wait.continuation).toEqual({
      promptText: 'do the thing',
      promptOwner: 'minion-brief',
      hadOpenTurn: true,
    });
    expect(wait.incidentGeneration).toBe(1);
    const events = ledger.listJobEvents('' as never, { limit: 1 });
    void events; // (no job bound; the event carries agentId instead)
    const established = ledger.listEvents({ limit: 5 }).find((event) => event.kind === 'provider.wait-established');
    expect(established).not.toBeNull();
    expect(established?.agentId).toBe('agent-1');
  });

  it('is idempotent per incident: the same incident id updates, not stacks', () => {
    const ledger = makeLedger();
    ledger.recordProviderWait(waitInput());
    const again = ledger.recordProviderWait(
      waitInput({ sessionFile: '/tmp/new-session.jsonl' }),
    );
    expect(again.id).toBe('w1');
    expect(ledger.listProviderWaits({ status: 'waiting' })).toHaveLength(1);
    expect(ledger.getProviderWait('w1')?.sessionFile).toBe('/tmp/new-session.jsonl');
  });

  it('lists and finds the open wait for an agent (guarded re-arm lookup)', () => {
    const ledger = makeLedger();
    ledger.recordProviderWait(waitInput());
    expect(ledger.openProviderWaitForAgent('agent-1')?.id).toBe('w1');
    ledger.setProviderWaitStatus('w1', 'recovered-pending');
    ledger.setProviderWaitStatus('w1', 'claimed');
    expect(ledger.openProviderWaitForAgent('agent-1')).toBeNull();
  });

  it('the wait state machine guards terminal and illegal transitions', () => {
    const ledger = makeLedger();
    ledger.recordProviderWait(waitInput());
    ledger.setProviderWaitStatus('w1', 'recovered-pending');
    ledger.setProviderWaitStatus('w1', 'claimed');
    expect(() => ledger.setProviderWaitStatus('w1', 'waiting')).toThrow(/terminal/);
    expect(() => ledger.setProviderWaitStatus('w1', 'superseded')).toThrow(/terminal/);

    const other = ledger.recordProviderWait(waitInput({ id: 'w2', incidentId: 'incident-2' }));
    expect(() => ledger.setProviderWaitStatus(other.id, 'claimed')).toThrow(
      /can be claimed only from recovered-pending/,
    );
  });

  it('recovered-pending → waiting is legal (renewed quota returns to wait)', () => {
    const ledger = makeLedger();
    ledger.recordProviderWait(waitInput());
    ledger.setProviderWaitStatus('w1', 'recovered-pending');
    const requeued = ledger.setProviderWaitStatus('w1', 'waiting');
    expect(requeued.status).toBe('waiting');
  });
});

describe('provider routes (durable cadence/budget)', () => {
  it('upserts and reloads the shared per-route probe state', () => {
    const ledger = makeLedger();
    const now = new Date('2026-09-28T10:00:00Z').toISOString();
    const route = ledger.upsertProviderRoute({
      routeKey: 'zai-coding-cn/glm-5.3@fp1',
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      credentialFingerprint: 'fp1',
      incidentSeq: 1,
      windowStart: now,
      attemptsInWindow: 3,
      nextCheckAt: now,
      lastAttemptAt: now,
      lastResult: 'still-limited',
      consecutiveProbeFailures: 0,
      falseRecoveryCount: 0,
      suspendedUntil: null,
      updatedAt: now,
    });
    expect(route.attemptsInWindow).toBe(3);
    const reloaded = ledger.getProviderRoute('zai-coding-cn/glm-5.3@fp1');
    expect(reloaded?.lastResult).toBe('still-limited');
    const updated = ledger.upsertProviderRoute({ ...route, attemptsInWindow: 4 });
    expect(updated.attemptsInWindow).toBe(4);
    expect(ledger.listProviderRoutes()).toHaveLength(1);
  });

  it('a route update can ride a probe-result event atomically', () => {
    const ledger = makeLedger();
    const now = new Date('2026-09-28T10:00:00Z').toISOString();
    ledger.upsertProviderRoute({
      routeKey: 'r',
      provider: 'zai-coding-cn',
      model: 'glm-5.3',
      credentialFingerprint: 'fp1',
      incidentSeq: 1,
      windowStart: now,
      attemptsInWindow: 0,
      nextCheckAt: now,
      lastAttemptAt: null,
      lastResult: null,
      consecutiveProbeFailures: 0,
      falseRecoveryCount: 0,
      suspendedUntil: null,
      updatedAt: now,
    });
    const current = ledger.getProviderRoute('r');
    if (current === null) throw new Error('route r missing before update');
    ledger.upsertProviderRoute(
      {
        ...current,
        attemptsInWindow: 1,
        lastResult: 'still-limited',
      },
      { kind: 'provider.probe-result', payload: { route: 'r', result: 'still-limited' } },
    );
    const event = ledger.listEvents({ limit: 5 }).find((e) => e.kind === 'provider.probe-result');
    expect(event?.payload).toMatchObject({ route: 'r', result: 'still-limited' });
  });
});

describe('pending provider recovery (deduplicated delivery marker)', () => {
  it('records once per route+incident generation and returns null on duplicates', () => {
    const ledger = makeLedger();
    const first = ledger.recordProviderRecovery({
      id: 'p1',
      routeKey: 'r',
      incidentGeneration: 1,
      evidence: { stopReason: 'stop', totalTokens: 4 },
      waiterJobIds: [],
    });
    expect(first).not.toBeNull();
    const duplicate = ledger.recordProviderRecovery({
      id: 'p2',
      routeKey: 'r',
      incidentGeneration: 1,
      evidence: { stopReason: 'stop', totalTokens: 5 },
      waiterJobIds: [],
    });
    expect(duplicate).toBeNull();
    expect(ledger.listPendingProviderRecoveries()).toHaveLength(1);
    // A NEW incident generation is a new delivery.
    const second = ledger.recordProviderRecovery({
      id: 'p3',
      routeKey: 'r',
      incidentGeneration: 2,
      evidence: { stopReason: 'stop' },
      waiterJobIds: [],
    });
    expect(second).not.toBeNull();
    expect(ledger.listPendingProviderRecoveries()).toHaveLength(2);
  });

  it('the provider.restored event lands once with its evidence and waiters', () => {
    const ledger = makeLedger();
    ledger.recordProviderRecovery({
      id: 'p1',
      routeKey: 'r',
      incidentGeneration: 1,
      evidence: { stopReason: 'stop' },
      waiterJobIds: ['job-1'],
    });
    const restored = ledger.listEvents({ limit: 5 }).find((e) => e.kind === 'provider.restored');
    expect(restored?.payload).toMatchObject({
      route: 'r',
      incident_generation: 1,
      waiter_jobs: ['job-1'],
    });
  });

  it('clearing a marker deletes only that marker', () => {
    const ledger = makeLedger();
    ledger.recordProviderRecovery({ id: 'p1', routeKey: 'r1', incidentGeneration: 1, evidence: {}, waiterJobIds: [] });
    ledger.recordProviderRecovery({ id: 'p2', routeKey: 'r2', incidentGeneration: 1, evidence: {}, waiterJobIds: [] });
    ledger.clearPendingProviderRecovery('p1');
    const remaining = ledger.listPendingProviderRecoveries();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.routeKey).toBe('r2');
  });
});
