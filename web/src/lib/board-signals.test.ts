import { describe, expect, it } from 'vitest';
import type { BoardSnapshot, JobView, NotificationView, RoundView } from './board-protocol.js';
import { jobSignal, pluralCount, roundSummary, unackedByJob } from './board-signals.js';

function round(overrides: Partial<RoundView> = {}): RoundView {
  return {
    id: 'job-1-r1',
    seq: 1,
    status: 'live',
    verdict: null,
    targetRef: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    lenses: [],
    lensAttempts: [],
    blockers: 0,
    ...overrides,
  };
}

function job(overrides: Partial<JobView> = {}): JobView {
  return {
    id: 'job-1',
    repo: 'demo',
    title: 'Job',
    status: 'working',
    updatedAt: '2026-01-01T00:00:00.000Z',
    prUrl: null,
    prState: null,
    baseBranch: 'main',
    note: null,
    rounds: [],
    lane: null,
    lastAgentActivity: null,
    ...overrides,
  };
}

function notification(id: string, overrides: Partial<NotificationView> = {}): NotificationView {
  return {
    id,
    ts: '2026-01-01T00:00:00.000Z',
    kind: 'test.notice',
    routing: 'action-required',
    severity: 'error',
    title: `Notice ${id}`,
    detail: null,
    agentId: null,
    shownAt: null,
    ackedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    repos: [],
    agents: [],
    notifications: [],
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: null,
      model: 'test',
      endpoint: 'test',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'test',
      generation: 0,
    },
    unackedActionRequired: 0,
    ...overrides,
  };
}

describe('roundSummary', () => {
  it('counts done lenses, total, blockers and errored lenses', () => {
    const summary = roundSummary(
      round({
        blockers: 2,
        lenses: [
          { lens: 'blind', state: 'done', agentId: null, note: 'blocker — x', verdict: 'blocker' },
          { lens: 'security', state: 'error', agentId: null, note: 'boom', verdict: null },
          { lens: 'tests', state: 'live', agentId: null, note: null, verdict: null },
        ],
      }),
    );
    expect(summary).toEqual({ done: 1, total: 3, blockers: 2, failures: 1 });
  });
});

describe('unackedByJob', () => {
  it('attributes unacked action-required notifications through agent → job bindings', () => {
    const counts = unackedByJob(
      snapshot({
        agents: [
          { id: 'a1', role: 'minion', label: null, state: 'idle', lastActivity: null, sessionFile: null, jobId: 'job-1', roundId: null, supervision: null },
          { id: 'a2', role: 'perkins', label: null, state: 'idle', lastActivity: null, sessionFile: null, jobId: null, roundId: null, supervision: null },
        ],
        notifications: [
          notification('n1', { agentId: 'a1' }),
          notification('n2', { agentId: 'a1', severity: 'info' }),
          notification('n3', { agentId: 'a2' }), // no job binding → stays global
          notification('n4', { agentId: null }),
          notification('n5', { agentId: 'a1', ackedAt: '2026-01-01T00:01:00.000Z' }),
          notification('n6', { agentId: 'a1', resolvedAt: '2026-01-01T00:01:00.000Z' }),
          notification('n7', { agentId: 'a1', routing: 'fyi' }),
        ],
      }),
    );
    expect([...counts.entries()]).toEqual([['job-1', 2]]);
  });
});

describe('jobSignal', () => {
  it('is null for a clean, closed job (no rounds)', () => {
    expect(jobSignal(job(), 0)).toBeNull();
  });

  it('is null for a verdict-posted round with review history', () => {
    const closed = job({
      rounds: [round({ status: 'verdict-posted', verdict: 'changes-requested', blockers: 2 })],
    });
    expect(jobSignal(closed, 0)).toBeNull();
  });

  it('shows live progress with the work tone for a healthy live round', () => {
    const signal = jobSignal(
      job({
        rounds: [
          round({
            seq: 2,
            lenses: [
              { lens: 'blind', state: 'done', agentId: null, note: null, verdict: null },
              { lens: 'edge', state: 'live', agentId: null, note: null, verdict: null },
              { lens: 'tests', state: 'pending', agentId: null, note: null, verdict: null },
            ],
          }),
        ],
      }),
      0,
    );
    expect(signal).toEqual({
      label: '◉ round 2 · live · 1/3',
      tone: 'work',
      title: 'round 2 live — 1/3 lenses done',
    });
  });

  it('shows an alert with blocker + failure counts for a failing live round', () => {
    const signal = jobSignal(
      job({
        rounds: [
          round({
            seq: 3,
            blockers: 2,
            lenses: [
              { lens: 'blind', state: 'done', agentId: null, note: 'blocker — x', verdict: 'blocker' },
              { lens: 'security', state: 'error', agentId: null, note: 'boom', verdict: null },
            ],
          }),
        ],
      }),
      0,
    );
    expect(signal?.label).toBe('⛔ 2 blockers · ✕ 1 lens failure · ◉ round 3 · live · 1/2');
    expect(signal?.tone).toBe('alert');
    expect(signal?.title).toContain('round 3: 2 blockers');
  });

  it('flags an aborted round ahead of blocker counts', () => {
    const signal = jobSignal(
      job({ rounds: [round({ seq: 4, status: 'aborted', blockers: 1 })] }),
      0,
    );
    expect(signal?.label).toBe('⛔ round 4 aborted');
    expect(signal?.tone).toBe('alert');
  });

  it('marks a pending round with the park tone', () => {
    const signal = jobSignal(job({ rounds: [round({ seq: 1, status: 'pending' })] }), 0);
    expect(signal).toEqual({ label: '○ round 1 pending', tone: 'park', title: 'round 1 pending' });
  });

  it('leads with unacked action-required and keeps the live round visible', () => {
    const signal = jobSignal(job({ rounds: [round({ seq: 2, status: 'live' })] }), 1);
    expect(signal?.label).toBe('🔔 1 action-required · ◉ round 2 · live · 0/0');
    expect(signal?.tone).toBe('alert');
    expect(signal?.title).toContain('1 notification awaiting ack');
  });
});

describe('pluralCount', () => {
  it('singularizes exactly one', () => {
    expect(pluralCount(1, 'blocker')).toBe('1 blocker');
    expect(pluralCount(0, 'blocker')).toBe('0 blockers');
    expect(pluralCount(2, 'lens failure')).toBe('2 lens failures');
  });
});
