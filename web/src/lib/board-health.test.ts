import { describe, expect, it } from 'vitest';
import type {
  BoardSnapshot,
  BuildView,
  JobView,
  RoundView,
} from './board-protocol.js';
import {
  alertsCard,
  cureCard,
  deployDriftCard,
  healthCards,
  restartPending,
  reviewCard,
  reviewCounts,
  silasCard,
  verifyCard,
} from './board-health.js';

const NOW = new Date(2026, 8, 23, 12, 0, 0); // local noon — day-boundary tests stay timezone-robust
const ISO = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();

function drift(overrides: Partial<BuildView> = {}): BuildView {
  return {
    buildRev: 'a'.repeat(40),
    buildCommittedAt: ISO(-6 * 3_600_000),
    originMainRev: 'b'.repeat(40),
    originMainCommittedAt: ISO(-3_600_000),
    commitsBehind: 43,
    checkedAt: ISO(-60_000),
    checkError: null,
    ...overrides,
  };
}

describe('deploy drift math — the card that catches a 43-commit-behind service', () => {
  it('flags restart pending exactly when the build is behind origin/main', () => {
    expect(restartPending(drift({ commitsBehind: 43 }))).toBe(true);
    expect(restartPending(drift({ commitsBehind: 1 }))).toBe(true);
    expect(restartPending(drift({ commitsBehind: 0 }))).toBe(false);
    expect(restartPending(drift({ commitsBehind: null }))).toBe(false);
    expect(restartPending(null)).toBe(false);
    expect(restartPending(undefined)).toBe(false);
  });

  it('renders behind count + build age + RESTART PENDING on the alert tone', () => {
    const card = deployDriftCard(drift(), NOW.getTime());
    expect(card.value).toBe('43 behind');
    expect(card.flag).toBe('RESTART PENDING');
    expect(card.tone).toBe('alert');
    expect(card.detail).toContain('6h old');
  });

  it('renders current when the build matches origin/main', () => {
    const card = deployDriftCard(drift({ commitsBehind: 0 }), NOW.getTime());
    expect(card.value).toBe('current');
    expect(card.flag).toBeNull();
    expect(card.tone).toBe('ok');
  });

  it('renders unknown (never a fake zero) when the count could not be proven', () => {
    const card = deployDriftCard(
      drift({ commitsBehind: null, checkError: 'origin unreachable (offline)' }),
      NOW.getTime(),
    );
    expect(card.value).toBe('unknown');
    expect(card.tone).toBe('warn');
    expect(card.detail).toContain('origin unreachable');
    expect(card.flag).toBeNull();
  });

  it('renders n/a on a pre-v4 server that ships no build block', () => {
    const card = deployDriftCard(null, NOW.getTime());
    expect(card.value).toBe('n/a');
    expect(card.tone).toBe('muted');
  });
});

function round(id: string, status: string, updatedAt: string): RoundView {
  return {
    id,
    seq: 1,
    status,
    verdict: null,
    targetRef: null,
    createdAt: updatedAt,
    updatedAt,
    lenses: [],
    lensAttempts: [],
    blockers: 0,
  };
}

function job(id: string, rounds: readonly RoundView[]): JobView {
  return {
    id,
    repo: 'demo',
    title: id,
    status: 'in-review',
    updatedAt: ISO(-60_000),
    prUrl: null,
    prState: null,
    baseBranch: null,
    note: null,
    rounds,
    lane: null,
    lastAgentActivity: null,
  };
}

describe('review throughput — active / failed today / verdicts today', () => {
  it('counts live+pending as active and terminal rounds by today', () => {
    const jobs = [
      job('a', [
        round('live', 'live', ISO(-3_600_000)),
        round('pending', 'pending', ISO(-60_000)),
        round('aborted-today', 'aborted', ISO(-7_200_000)),
        round('aborted-old', 'aborted', ISO(-72 * 3_600_000)),
        round('verdict-today', 'verdict-posted', ISO(-7_200_000)),
        round('verdict-old', 'verdict-posted', ISO(-100 * 3_600_000)),
      ]),
    ];
    expect(reviewCounts(jobs, NOW)).toEqual({ active: 2, failedToday: 1, verdictsToday: 1 });
    const card = reviewCard(jobs, NOW.getTime());
    expect(card.value).toBe('2 active');
    expect(card.detail).toBe('1 failed today · 1 verdict today');
    expect(card.tone).toBe('alert');
    expect(card.flag).toBe('1 FAILED');
  });

  it('is muted-but-real when nothing is running and nothing failed today', () => {
    const card = reviewCard([job('a', [round('v', 'verdict-posted', ISO(-100 * 3_600_000))])], NOW.getTime());
    expect(card.value).toBe('0 active');
    expect(card.tone).toBe('muted');
    expect(card.flag).toBeNull();
  });
});

describe('the remaining health cards render truthfully or n/a', () => {
  it('Silas: last wake age + reconciliations today; n/a when unwired', () => {
    const wired = silasCard({ lastWakeAt: ISO(-240_000), reconciliationsToday: 3, checkedAt: ISO(0) }, NOW.getTime());
    expect(wired.value).toBe('wake 4m ago');
    expect(wired.detail).toBe('3 reconciliations today');
    const never = silasCard({ lastWakeAt: null, reconciliationsToday: 0, checkedAt: ISO(0) }, NOW.getTime());
    expect(never.value).toBe('no wakes yet');
    expect(silasCard(null, NOW.getTime()).value).toBe('n/a');
  });

  it('Alerts: unacked count with the ack flag', () => {
    expect(alertsCard(0)).toMatchObject({ value: '0', tone: 'ok', flag: null });
    expect(alertsCard(2)).toMatchObject({ value: '2', tone: 'alert', flag: 'NEEDS GRU' });
  });

  it('Verify queue: lock/queue/worker headroom, n/a when the api is absent', () => {
    const wired = verifyCard({ lockInUse: true, activeRuns: 1, queuedRuns: 2, workerBudget: 8, workersPerRun: 4 });
    expect(wired.value).toBe('lock held');
    expect(wired.detail).toBe('1 active · 2 queued · 4/8 workers');
    expect(wired.tone).toBe('warn');
    expect(wired.flag).toBe('2 QUEUED');
    expect(verifyCard(null).value).toBe('n/a');
    expect(verifyCard(undefined).tone).toBe('muted');
  });

  it('Cure efficacy: resumed vs orphaned, n/a when data is absent', () => {
    const wired = cureCard({ sessionsResumed: 5, sessionsOrphaned: 1, since: ISO(-3_600_000) });
    expect(wired.value).toBe('5 resumed');
    expect(wired.detail).toBe('1 orphaned since boot');
    expect(wired.tone).toBe('alert');
    expect(cureCard(null).value).toBe('n/a');
  });
});

describe('the health row — fixed order over the snapshot', () => {
  it('renders all six cards in incident order and tolerates pre-v4 snapshots', () => {
    const snapshot = {
      repos: [],
      agents: [],
      notifications: [],
      decisions: {
        enabled: false,
        status: 'disabled',
        reason: null,
        model: 'm',
        endpoint: 'e',
        credentialPresent: false,
        credentialSource: 'none',
        checkedAt: null,
        incarnation: 'x',
        generation: 0,
      },
      unackedActionRequired: 0,
      unackedNeedsOwner: 0,
      wakes: { count: 0, lastAt: null },
    } as BoardSnapshot;
    const cards = healthCards(snapshot, NOW.getTime());
    expect(cards.map((c) => c.id)).toEqual(['deploy', 'reviews', 'silas', 'alerts', 'verify', 'cure']);
    expect(cards.filter((c) => c.value === 'n/a').map((c) => c.id)).toEqual(['deploy', 'silas', 'verify', 'cure']);
  });

  it('wires every v4 block through to its card', () => {
    const snapshot = {
      repos: [],
      agents: [],
      notifications: [],
      decisions: {
        enabled: false,
        status: 'disabled',
        reason: null,
        model: 'm',
        endpoint: 'e',
        credentialPresent: false,
        credentialSource: 'none',
        checkedAt: null,
        incarnation: 'x',
        generation: 0,
      },
      unackedActionRequired: 3,
      unackedNeedsOwner: 0,
      wakes: { count: 0, lastAt: null },
      build: drift(),
      silas: { lastWakeAt: ISO(-60_000), reconciliationsToday: 1, checkedAt: ISO(0) },
      verify: { lockInUse: false, activeRuns: 0, queuedRuns: 0, workerBudget: 8, workersPerRun: 4 },
      selfHeal: { sessionsResumed: 2, sessionsOrphaned: 0, since: ISO(-3_600_000) },
    } as BoardSnapshot;
    const cards = healthCards(snapshot, NOW.getTime());
    expect(cards.map((c) => c.value)).toEqual(['43 behind', '0 active', 'wake 1m ago', '3', 'lock free', '2 resumed']);
  });
});
