import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AgentView, BoardSnapshot, JobView, NotificationView, RoundView } from './board-protocol.js';
import { isJobConcluded } from './board-protocol.js';
import { jobSignal, pluralCount, roundSummary, terminalBoundNotificationIds, unackedByJob } from './board-signals.js';

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

  it('derives truthful coverage for a nine-lens catalog round and an eight-lens explicit no-spec round', () => {
    const full = roundSummary(round({
      lensAttempts: [{ lens: 'tests', attempts: 2 }, { lens: 'performance', attempts: 2 }],
      lenses: [
        { lens: 'blind', state: 'done', agentId: null, note: null, verdict: 'clean' },
        { lens: 'edge', state: 'done', agentId: null, note: null, verdict: 'clean' },
        { lens: 'acceptance', state: 'done', agentId: null, note: 'not used — lead-owned whole-PR review', verdict: 'clean' },
        { lens: 'security', state: 'done', agentId: null, note: 'blocker — found', verdict: 'blocker' },
        { lens: 'architecture', state: 'done', agentId: null, note: 'not used — lead-owned whole-PR review', verdict: 'clean' },
        { lens: 'codebase', state: 'done', agentId: null, note: null, verdict: 'clean' },
        { lens: 'tests', state: 'error', agentId: null, note: 'specialist attempts failed: a1 output; a2 output', verdict: null },
        { lens: 'performance', state: 'done', agentId: null, note: 'note — found; earlier failed attempt recorded', verdict: 'note' },
        { lens: 'operations', state: 'done', agentId: null, note: 'not used — lead-owned whole-PR review', verdict: 'clean' },
      ],
    }));
    expect(full).toEqual({ done: 8, used: 5, unused: 3, ran: 6, total: 9, blockers: 0, failures: 1 });

    // Explicit no-spec: acceptance is absent from the round's own chips, so
    // availability is 8 — never a backfilled historical seven or a forced nine.
    const noSpec = roundSummary(round({
      lensAttempts: [{ lens: 'performance', attempts: 1 }],
      lenses: [
        { lens: 'blind', state: 'done', agentId: null, note: 'not used — lead-owned whole-PR review', verdict: 'clean' },
        { lens: 'edge', state: 'done', agentId: null, note: 'not used — lead-owned whole-PR review', verdict: 'clean' },
        { lens: 'security', state: 'done', agentId: null, note: 'blocker — found', verdict: 'blocker' },
        { lens: 'architecture', state: 'done', agentId: null, note: 'not used — lead-owned whole-PR review', verdict: 'clean' },
        { lens: 'codebase', state: 'done', agentId: null, note: 'not used — lead-owned whole-PR review', verdict: 'clean' },
        { lens: 'tests', state: 'done', agentId: null, note: 'not used — lead-owned whole-PR review', verdict: 'clean' },
        { lens: 'performance', state: 'error', agentId: null, note: 'specialist attempts failed: a1 timeout', verdict: null },
        { lens: 'operations', state: 'done', agentId: null, note: 'not used — lead-owned whole-PR review', verdict: 'clean' },
      ],
    }));
    expect(noSpec).toEqual({ done: 7, used: 1, unused: 6, ran: 2, total: 8, blockers: 0, failures: 1 });
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

  it('section truth: rows bound to a terminal job never attribute — closed receipts, not queue entries', () => {
    const mergedAgent: AgentView = { id: 'am', role: 'minion', label: null, state: 'idle', lastActivity: null, sessionFile: null, jobId: 'merged-1', roundId: null, supervision: null };
    const liveAgent: AgentView = { id: 'al', role: 'minion', label: null, state: 'idle', lastActivity: null, sessionFile: null, jobId: 'live-1', roundId: null, supervision: null };
    const counts = unackedByJob(
      snapshot({
        repos: [
          {
            name: 'demo',
            jobs: [
              job({ id: 'merged-1', status: 'merged' }),
              job({ id: 'done-1', status: 'done' }),
              job({ id: 'live-1', status: 'working' }),
            ],
          },
        ],
        agents: [
          mergedAgent,
          { ...mergedAgent, id: 'ad', jobId: 'done-1' },
          liveAgent,
        ],
        notifications: [
          notification('n-merged-1', { agentId: 'am' }),
          notification('n-merged-2', { agentId: 'am' }),
          notification('n-done-1', { agentId: 'ad' }),
          notification('n-live-1', { agentId: 'al' }),
        ],
      }),
    );
    expect([...counts.entries()]).toEqual([['live-1', 1]]);
    // Pin the concluded set across EVERY job status the web can receive.
    // The backend and the web share no module, so a terminal status added
    // on the ledger side must be mirrored here too; the companion test
    // below reads the ledger declaration and makes drift FAIL instead of
    // relying on this checklist being remembered.
    const statuses = ['dispatched', 'working', 'delivered', 'in-review', 'blocked', 'parked', 'merged', 'done'];
    expect(statuses.filter((status) => isJobConcluded(status))).toEqual(['merged', 'done']);
    expect(isJobConcluded('working')).toBe(false);
  });

  it('the concluded set cannot drift from the ledger terminal statuses (cross-build alarm)', () => {
    // The web bundle cannot import the ledger module (separate builds), so
    // this test reads the server's terminal declaration directly: every
    // status the ledger names terminal must be concluded here. A new
    // terminal status server-side fails THIS test until the web twin
    // mirrors it (final independent review B0/Ar1/T0). The pattern
    // tolerates formatting/type-annotation changes so only a real status
    // drift (or a removed declaration) fails.
    const statesSource = readFileSync(
      fileURLToPath(new URL('../../../src/ledger/states.ts', import.meta.url)),
      'utf-8',
    );
    const declaration = /JOB_TERMINAL\s*(?::[^=]*)?=\s*new Set[^(]*\(\s*\[([^\]]*)\]\s*\)/.exec(statesSource);
    expect(declaration, 'the ledger terminal declaration moved or changed shape').not.toBeNull();
    const terminal = [...declaration![1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
    expect(terminal.length).toBeGreaterThan(0);
    for (const status of terminal) {
      expect(isJobConcluded(status), status).toBe(true);
    }
    // Bidirectional equivalence over the known job-status universe
    // (tracked-review A6): the web twin must conclude EXACTLY the ledger's
    // terminal set. A web-only addition would otherwise keep counting rows
    // the web reclassifies as receipts while every test stayed green.
    const knownStatuses = ['dispatched', 'working', 'delivered', 'in-review', 'blocked', 'parked', 'merged', 'done'];
    const webConcluded = knownStatuses.filter((status) => isJobConcluded(status)).sort();
    expect(webConcluded).toEqual([...terminal].sort());
  });

  it('terminalBoundNotificationIds names the closed receipts — terminal bindings only, never guessing', () => {
    const bound = (id: string, jobId: string): AgentView => ({
      id, role: 'minion', label: null, state: 'idle', lastActivity: null, sessionFile: null, jobId, roundId: null, supervision: null,
    });
    const ids = terminalBoundNotificationIds(
      snapshot({
        repos: [
          {
            name: 'demo',
            jobs: [job({ id: 'merged-1', status: 'merged' }), job({ id: 'live-1', status: 'working' })],
          },
        ],
        agents: [bound('am', 'merged-1'), bound('al', 'live-1'), bound('ax', 'unknown-job')],
        notifications: [
          notification('n-merged', { agentId: 'am' }),
          notification('n-live', { agentId: 'al' }),
          notification('n-unknown', { agentId: 'ax' }),
          notification('n-unbound', { agentId: null }),
          notification('n-acked', { agentId: 'am', ackedAt: '2026-01-01T00:01:00.000Z' }),
          notification('n-fyi', { agentId: 'am', routing: 'fyi' }),
        ],
      }),
    );
    expect([...ids]).toEqual(['n-merged']);
  });

  it('a producer escalation row bound to a terminal lane is a closed receipt (A4 pairing)', () => {
    const bound = (id: string, jobId: string): AgentView => ({
      id, role: 'minion', label: null, state: 'idle', lastActivity: null, sessionFile: null, jobId, roundId: null, supervision: null,
    });
    const snap = snapshot({
      repos: [
        {
          name: 'demo',
          jobs: [job({ id: 'merged-1', status: 'merged' }), job({ id: 'live-1', status: 'working' })],
        },
      ],
      agents: [bound('am', 'merged-1'), bound('al', 'live-1')],
      notifications: [
        notification('n-escal-merged', { kind: 'review-escalation', agentId: 'am' }),
        notification('n-escal-live', { kind: 'review-escalation', agentId: 'al' }),
      ],
    });
    // The producers bind lane rows through the existing agentId
    // (tracked-review A4): the merged lane's escalation is a receipt and
    // never attributes to the banded view; the live lane's stays live.
    expect([...unackedByJob(snap).entries()]).toEqual([['live-1', 1]]);
    expect(terminalBoundNotificationIds(snap).has('n-escal-merged')).toBe(true);
    expect(terminalBoundNotificationIds(snap).has('n-escal-live')).toBe(false);
  });

  it('the shared live/receipt fixture classifies identically for chip and bands', () => {
    // ONE fixture file is consumed by this suite and by
    // test/board-engine.test.ts; the SQL live count and this attribution
    // must agree on the same rows (followup review A4/V4).
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../test/fixtures/live-receipt-classification.json', import.meta.url)),
        'utf-8',
      ),
    ) as {
      readonly jobs: readonly { readonly id: string; readonly status: string }[];
      readonly agents: readonly { readonly id: string; readonly jobId: string }[];
      readonly notifications: readonly {
        readonly id: string;
        readonly kind: string;
        readonly routing: string;
        readonly agentId: string | null;
      }[];
      readonly expected: {
        readonly liveCount: number;
        readonly liveByJob: Readonly<Record<string, number>>;
        readonly receiptIds: readonly string[];
      };
    };
    const snap = snapshot({
      repos: [
        {
          name: 'demo',
          jobs: fixture.jobs.map((entry) => job({ id: entry.id, status: entry.status })),
        },
      ],
      agents: fixture.agents.map((entry) => ({
        id: entry.id, role: 'minion', label: null, state: 'idle', lastActivity: null, sessionFile: null,
        jobId: entry.jobId, roundId: null, supervision: null,
      })),
      notifications: fixture.notifications.map((entry) =>
        notification(entry.id, {
          kind: entry.kind,
          routing: entry.routing as 'action-required' | 'fyi',
          ...(entry.agentId !== null ? { agentId: entry.agentId } : {}),
        }),
      ),
    });
    expect([...unackedByJob(snap).entries()]).toEqual(Object.entries(fixture.expected.liveByJob));
    expect([...terminalBoundNotificationIds(snap)].sort()).toEqual([...fixture.expected.receiptIds].sort());
    // The web live rows mirror the SQL chip count: terminal-bound rows are
    // receipts; unknown-bound and unbound rows stay live.
    const liveRows = snap.notifications.filter(
      (row) =>
        row.routing === 'action-required' &&
        row.ackedAt === null &&
        row.resolvedAt === null &&
        (row.agentId === null || !terminalBoundNotificationIds(snap).has(row.id)),
    );
    expect(liveRows).toHaveLength(fixture.expected.liveCount);
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
    expect(signal?.title).toContain('1 live machine-attention notification awaiting Gru disposition');
  });
});

describe('jobSignal — section truth: concluded cards are closed receipts', () => {
  it('suppresses live/pending review liveness on merged and done cards', () => {
    for (const status of ['merged', 'done']) {
      expect(jobSignal(job({ status, rounds: [round({ seq: 2, status: 'live' })] }), 0)).toBeNull();
      expect(jobSignal(job({ status, rounds: [round({ seq: 2, status: 'pending' })] }), 0)).toBeNull();
    }
    // The same rounds still read as live on an in-flight card.
    expect(jobSignal(job({ status: 'in-review', rounds: [round({ seq: 2, status: 'live' })] }), 0)?.label).toContain('live');
  });

  it('renders NO pills on a concluded card, whatever is left over', () => {
    // Leftover machine-attention rows: the record keeps them; the card is closed.
    expect(jobSignal(job({ status: 'merged' }), 2)).toBeNull();
    expect(jobSignal(job({ status: 'done' }), 2)).toBeNull();
    // Stale history (aborted round, errored lens) never re-alarms a receipt.
    expect(jobSignal(job({ status: 'done', rounds: [round({ seq: 3, status: 'aborted' })] }), 0)).toBeNull();
    expect(
      jobSignal(
        job({
          status: 'merged',
          rounds: [round({ status: 'live', lenses: [{ lens: 'tests', state: 'error', agentId: null, note: 'boom', verdict: null }] })],
        }),
        0,
      ),
    ).toBeNull();
  });
});

describe('pluralCount', () => {
  it('singularizes exactly one', () => {
    expect(pluralCount(1, 'blocker')).toBe('1 blocker');
    expect(pluralCount(0, 'blocker')).toBe('0 blockers');
    expect(pluralCount(2, 'lens failure')).toBe('2 lens failures');
  });
});
