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
    unackedNeedsOwner: 0,
    wakes: { count: 0, lastAt: null },
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
    expect(summary).toEqual({ done: 1, used: 1, unused: 0, ran: 1, total: 3, blockers: 2, failures: 1 });
  });

  it('counts whole-PR used lenses separately from done-as-not-used lenses', () => {
    const summary = roundSummary(
      round({
        blockers: 1,
        lensAttempts: [{ lens: 'blind', attempts: 2 }],
        lenses: [
          { lens: 'security', state: 'done', agentId: null, note: 'blocker — found', verdict: 'blocker' },
          { lens: 'tests', state: 'done', agentId: null, note: 'not used — lead-owned whole-PR review', verdict: 'clean' },
          { lens: 'edge', state: 'done', agentId: null, note: 'not used — lead-owned whole-PR review', verdict: 'clean' },
          { lens: 'blind', state: 'error', agentId: null, note: 'specialist attempts failed', verdict: null },
        ],
      }),
    );
    expect(summary).toEqual({ done: 3, used: 1, unused: 2, ran: 2, total: 4, blockers: 1, failures: 1 });
  });

  it('counts lenses that RAN AND FAILED inside `ran` — an error lens is real work, not "not ran" (R9/N8)', () => {
    const summary = roundSummary(
      round({
        lensAttempts: [{ lens: 'security', attempts: 1 }, { lens: 'edge', attempts: 2 }],
        lenses: [
          { lens: 'security', state: 'done', agentId: null, note: 'blocker — found; earlier failed attempt recorded', verdict: 'blocker' },
          { lens: 'edge', state: 'error', agentId: null, note: 'specialist attempts failed: a1 timeout; a2 timeout', verdict: null },
          { lens: 'tests', state: 'done', agentId: null, note: 'not used — lead-owned whole-PR review', verdict: 'clean' },
          { lens: 'blind', state: 'done', agentId: null, note: 'not used — lead-owned whole-PR review', verdict: 'clean' },
        ],
      }),
    );
    // security ran (valid) and edge ran (failed): 2 lenses actually ran.
    expect(summary.ran).toBe(2);
    expect(summary.used).toBe(1);
    expect(summary.unused).toBe(2);
    expect(summary.failures).toBe(1);
    // An error lens with NO attempts (e.g. interrupted before spawn) did
    // not run and must not inflate `ran`.
    const interrupted = roundSummary(
      round({
        lenses: [
          { lens: 'blind', state: 'error', agentId: null, note: 'review interrupted by service restart', verdict: null },
          { lens: 'security', state: 'done', agentId: null, note: 'blocker — found', verdict: 'blocker' },
        ],
      }),
    );
    expect(interrupted.ran).toBe(1);
  });

  it('classifies unused lenses through the shared classifier: prose alone never downgrades a count', () => {
    const summary = roundSummary(
      round({
        lenses: [
          { lens: 'blind', state: 'done', agentId: null, note: 'not used — lead-owned whole-PR review', verdict: 'clean' },
          { lens: 'edge', state: 'done', agentId: null, note: 'clean — lead said not used', verdict: 'clean' },
          { lens: 'tests', state: 'done', agentId: null, note: null, verdict: null },
          { lens: 'security', state: 'pending', agentId: null, note: 'not used — prose', verdict: null },
        ],
      }),
    );
    // Only the canonical done+notused record is unused; prose on a pending
    // record and a legacy null note keep their normal accounting.
    expect(summary).toEqual({ done: 3, used: 2, unused: 1, ran: 2, total: 4, blockers: 0, failures: 0 });
  });

  it('raw unknown unused records count nowhere: accounting stays non-negative', () => {
    const summary = roundSummary(
      round({
        lenses: [
          { lens: 'blind', state: 'done', agentId: null, note: 'clean — nothing found', verdict: 'clean' },
          { lens: 'edge', state: 'unused', agentId: null, note: null, verdict: null },
          { lens: 'tests', state: 'unused', agentId: null, note: 'not used — prose', verdict: null },
          { lens: 'security', state: 'done', agentId: null, note: 'not used — lead-owned whole-PR review', verdict: 'clean' },
        ],
      }),
    );
    // Only the canonical done record is unused. The two raw drift records
    // count nowhere — pre-fix they inflated `unused` past `done`, driving
    // `used`/`ran` negative.
    expect(summary).toEqual({ done: 2, used: 1, unused: 1, ran: 1, total: 4, blockers: 0, failures: 0 });
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
      title: 'round 2 live — 1/3 lenses settled',
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
    // An errored lens is settled (it will not run again); settled counts
    // done + failed, so the pill cannot read 1/2 beside a failed lens.
    expect(signal?.label).toBe('⛔ 2 blockers · ✕ 1 lens failure · ◉ round 3 · live · 2/2');
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
    expect(signal?.label).toBe('🛠 1 needs Gru · ◉ round 2 · live · 0/0');
    expect(signal?.tone).toBe('alert');
    expect(signal?.title).toContain('1 machine-attention notification awaiting Gru disposition');
  });
});

describe('jobSignal — v5 stale review pills on concluded cards', () => {
  it('suppresses live/pending review liveness on merged and done cards', () => {
    for (const status of ['merged', 'done']) {
      expect(jobSignal(job({ status, rounds: [round({ seq: 2, status: 'live' })] }), 0)).toBeNull();
      expect(jobSignal(job({ status, rounds: [round({ seq: 2, status: 'pending' })] }), 0)).toBeNull();
    }
    // The same rounds still read as live on an in-flight card.
    expect(jobSignal(job({ status: 'in-review', rounds: [round({ seq: 2, status: 'live' })] }), 0)?.label).toContain('live');
  });

  it('keeps attention pills that explain why a concluded card needs Gru', () => {
    const unacked = jobSignal(job({ status: 'merged' }), 2);
    expect(unacked?.label).toBe('🛠 2 needs Gru');
    const aborted = jobSignal(job({ status: 'done', rounds: [round({ seq: 3, status: 'aborted' })] }), 0);
    expect(aborted?.label).toBe('⛔ round 3 aborted');
    const failed = jobSignal(
      job({
        status: 'merged',
        rounds: [round({ status: 'live', lenses: [{ lens: 'tests', state: 'error', agentId: null, note: 'boom', verdict: null }] })],
      }),
      0,
    );
    expect(failed?.label).toBe('✕ 1 lens failure');
  });
});

describe('pluralCount', () => {
  it('singularizes exactly one', () => {
    expect(pluralCount(1, 'blocker')).toBe('1 blocker');
    expect(pluralCount(0, 'blocker')).toBe('0 blockers');
    expect(pluralCount(2, 'lens failure')).toBe('2 lens failures');
  });
});
