import { describe, expect, it } from 'vitest';
import type {
  BoardSnapshot,
  BuildView,
  DiskView,
  JobView,
  RoundView,
} from './board-protocol.js';
import {
  alertsCard,
  cureCard,
  deployDriftCard,
  diskCard,
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
    latestTag: null,
    buildTag: null,
    updateAvailable: null,
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

  it('names the newer release and flags UPDATE AVAILABLE (the tag is the update signal)', () => {
    const card = deployDriftCard(
      drift({ commitsBehind: 12, latestTag: 'v1.0.2', buildTag: 'v1.0.1', updateAvailable: true }),
      NOW.getTime(),
    );
    expect(card.value).toBe('v1.0.2');
    expect(card.flag).toBe('UPDATE AVAILABLE');
    expect(card.tone).toBe('alert');
    expect(card.detail).toContain('contains v1.0.1');
    expect(card.detail).toContain('run gru-service roll');
    expect(card.titleAttr).toContain('older than release v1.0.2');
  });

  it('does not flag an update when the build already contains the newest release', () => {
    const card = deployDriftCard(
      drift({ commitsBehind: 0, latestTag: 'v1.0.2', buildTag: 'v1.0.2', updateAvailable: false }),
      NOW.getTime(),
    );
    expect(card.value).toBe('current');
    expect(card.flag).toBeNull();
    expect(card.detail).toContain('build contains v1.0.2');
  });

  it('keeps the commit count when the newest release is already in the build (unreleased main)', () => {
    const card = deployDriftCard(
      drift({ commitsBehind: 5, latestTag: 'v1.0.2', buildTag: 'v1.0.2', updateAvailable: false }),
      NOW.getTime(),
    );
    expect(card.value).toBe('5 behind');
    expect(card.flag).toBe('RESTART PENDING');
    expect(card.detail).toContain('latest release v1.0.2');
  });

  it('never flags an update from an unknown tag side (only an earned claim)', () => {
    const card = deployDriftCard(
      drift({ commitsBehind: 0, latestTag: 'v1.0.2', buildTag: null, updateAvailable: null }),
      NOW.getTime(),
    );
    expect(card.value).toBe('current');
    expect(card.flag).toBeNull();
    expect(card.detail).toContain('latest release v1.0.2');
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
  const silasBase = {
    lastWakeAt: null as string | null,
    lastTickAt: null as string | null,
    lastReconcileAt: null as string | null,
    lastReconcileFailedAt: null as string | null,
    reconcileFailedNewer: false,
    lastUsefulActionAt: null as string | null,
    nextAction: null as string | null,
    openTurnSince: null as string | null,
    reconciliationsToday: 0,
    checkedAt: ISO(0),
  };

  it('Silas: last wake age + reconciliations today; n/a when unwired', () => {
    const wired = silasCard(
      { ...silasBase, lastWakeAt: ISO(-240_000), reconciliationsToday: 3 },
      NOW.getTime(),
    );
    expect(wired.value).toBe('wake 4m ago');
    expect(wired.detail).toBe('3 machine actions today');
    const never = silasCard({ ...silasBase }, NOW.getTime());
    expect(never.value).toBe('no wakes yet');
    expect(silasCard(null, NOW.getTime()).value).toBe('n/a');
  });

  it('Silas: a completed reconciliation moves the headline while a turn is open (#163)', () => {
    const reconciled = silasCard(
      { ...silasBase, lastWakeAt: ISO(-3_600_000), lastReconcileAt: ISO(-60_000), reconciliationsToday: 1 },
      NOW.getTime(),
    );
    expect(reconciled.value).toBe('reconciled 1m ago');
    const open = silasCard(
      {
        ...silasBase,
        lastWakeAt: ISO(-3_600_000),
        lastReconcileAt: ISO(-60_000),
        openTurnSince: ISO(-3_600_000),
      },
      NOW.getTime(),
    );
    expect(open.value).toBe('turn open 1h');
    // An open turn must not hide whether the loop is still moving.
    expect(open.detail).toBe('reconciled 1m ago · 0 machine actions today');
  });

  it('Silas: a non-null next action renders in the card tooltip (#163 review)', () => {
    const card = silasCard(
      { ...silasBase, lastReconcileAt: ISO(-60_000), nextAction: 'gru-decision: rule on the audit (job-x)' },
      NOW.getTime(),
    );
    expect(card.titleAttr).toContain('next owed: gru-decision: rule on the audit (job-x)');
    const none = silasCard({ ...silasBase, nextAction: null }, NOW.getTime());
    expect(none.titleAttr).toContain('no tracked obligation');
  });

  it('Silas: a pass that failed after the last success is louder than every healthy state (#163)', () => {
    const failed = silasCard(
      {
        ...silasBase,
        lastWakeAt: ISO(-3_600_000),
        lastReconcileAt: ISO(-600_000),
        lastReconcileFailedAt: ISO(-60_000),
        reconcileFailedNewer: true,
      },
      NOW.getTime(),
    );
    expect(failed.value).toBe('pass failed 1m ago');
    expect(failed.tone).toBe('alert');
    expect(failed.flag).toBe('FAILED');
    expect(failed.titleAttr).toContain('last failed pass 1m ago');
  });

  it('Alerts: unacked count with the ack flag', () => {
    expect(alertsCard(0)).toMatchObject({ value: '0', tone: 'ok', flag: null });
    expect(alertsCard(2)).toMatchObject({ value: '2', tone: 'alert', flag: 'NEEDS GRU' });
    // The count is LIVE-only: the card copy says so (A4).
    expect(alertsCard(0).detail).toBe('live machine queue clear');
    expect(alertsCard(2).detail).toBe('live machine attention awaiting Gru');
    expect(alertsCard(0).titleAttr).toContain('0 live machine-attention notifications awaiting a Gru disposition');
    expect(alertsCard(1).titleAttr).toContain('1 live machine-attention notification awaiting a Gru disposition');
    expect(alertsCard(2).titleAttr).toContain('2 live machine-attention notifications awaiting a Gru disposition');
    expect(alertsCard(2).titleAttr).toContain('closed receipts stay in the record and the owner bell is not rung');
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

  it('Disk (#427 PR 3): GC\'s usage, free space, budget and floor; below the floor is an alert with its queue, over budget a warning', () => {
    const GB = 1024 ** 3;
    const disk = (overrides: Partial<DiskView> = {}): DiskView => ({
      usedBytes: 12 * GB,
      sharedBytes: 0,
      categories: { lanes: 9 * GB, reviews: GB, preserves: 0, probes: 0, ledger: GB, logs: GB, other: 0 },
      freeBytes: 100 * GB,
      totalBytes: 500 * GB,
      volumes: [{ names: ['lanes', 'data_dir'], path: '/data/worktrees', freeBytes: 100 * GB, totalBytes: 500 * GB, belowFloor: false }],
      budgetBytes: 30 * GB,
      floorBytes: 10 * GB,
      reclaimMode: 'automatic',
      overBudget: false,
      belowFloor: false,
      queuedLanes: 0,
      floorQueue: [],
      computedAt: ISO(-30_000),
      ...overrides,
    });
    const fine = diskCard(disk());
    expect(fine.value).toBe('12.0 GB');
    expect(fine.detail).toBe('100.0 GB free · budget 30.0 GB · floor 10.0 GB');
    expect(fine.tone).toBe('ok');
    expect(fine.flag).toBeNull();
    expect(fine.titleAttr).toContain('lanes 9.0 · reviews 1.0 · preserves 0.0 · probes 0.0 · ledger 1.0 · logs 1.0 · other 0.0 GB');
    const over = diskCard(disk({ usedBytes: 34 * GB, overBudget: true }));
    expect([over.tone, over.flag]).toEqual(['warn', 'OVER BUDGET']);
    const reason = 'queued: 6.0 GB free is below the 10 GB floor ([worktrees] min_free_disk_gb); the reclaim card is waiting for the owner\'s decision';
    const below = diskCard(disk({
      freeBytes: 6 * GB,
      belowFloor: true,
      queuedLanes: 2,
      reclaimMode: 'proposed',
      floorQueue: [
        { id: 'job-a', label: 'a heist', queuedAt: ISO(-60_000), reason },
        { id: 'child-b', label: 'a writer child', queuedAt: ISO(-30_000), reason },
      ],
    }));
    expect([below.tone, below.flag]).toEqual(['alert', '2 QUEUED']);
    expect(below.flagSplit).toEqual({ num: 2, unit: ' QUEUED' });
    // Every lane waiting at the floor is named, with its reason.
    expect(below.titleAttr).toContain(`waiting at the floor: a heist (job-a): ${reason}; a writer child (child-b): ${reason}`);
    expect(diskCard(disk({ freeBytes: 6 * GB, belowFloor: true })).flag).toBe('BELOW FLOOR');
    // A free space is rounded down: 9.96 GB is never "10.0 GB free" below a 10 GB floor.
    expect(diskCard(disk({ freeBytes: 9.96 * GB, belowFloor: true })).detail).toBe('9.9 GB free · budget 30.0 GB · floor 10.0 GB');
    // Lanes on another disk than data_dir: each disk is named; shared bytes are shown apart.
    const two = diskCard(disk({
      sharedBytes: 2 * GB,
      freeBytes: 6 * GB,
      belowFloor: true,
      volumes: [
        { names: ['lanes'], path: '/mnt/lanes', freeBytes: 6 * GB, totalBytes: 50 * GB, belowFloor: true },
        { names: ['data_dir'], path: '/data', freeBytes: 100 * GB, totalBytes: 500 * GB, belowFloor: false },
      ],
    }));
    expect(two.titleAttr).toContain('the lanes disk (/mnt/lanes) has 6.0 GB free of 50.0 GB, below the floor; the data_dir disk (/data) has 100.0 GB free of 500.0 GB');
    expect(two.titleAttr).toContain('2.0 GB hard-linked from outside, not counted');
    const off = diskCard(disk({ budgetBytes: 0, floorBytes: 0, usedBytes: null, categories: null, freeBytes: null }));
    expect([off.value, off.detail, off.tone]).toEqual(['walking', 'free unknown · budget off · floor off', 'muted']);

    // The pair sits next to the verify queue, and only when the server sends it.
    const snapshot = {
      repos: [], agents: [], notifications: [],
      decisions: { enabled: false, status: 'disabled', reason: null, model: 'm', endpoint: 'e', credentialPresent: false, credentialSource: 'none', checkedAt: null, incarnation: 'x', generation: 0 },
      unackedActionRequired: 0, unackedNeedsOwner: 0, wakes: { count: 0, lastAt: null },
    } as BoardSnapshot;
    expect(healthCards({ ...snapshot, disk: disk() }, NOW.getTime()).map((c) => c.id)).toEqual(['deploy', 'reviews', 'silas', 'alerts', 'verify', 'disk', 'cure']);
    expect(healthCards({ ...snapshot, disk: null }, NOW.getTime()).map((c) => c.id)).toEqual(['deploy', 'reviews', 'silas', 'alerts', 'verify', 'cure']);
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
      silas: {
        lastWakeAt: ISO(-60_000),
        lastTickAt: ISO(-30_000),
        lastReconcileAt: null,
        lastReconcileFailedAt: null,
        reconcileFailedNewer: false,
        lastUsefulActionAt: null,
        nextAction: null,
        openTurnSince: null,
        reconciliationsToday: 1,
        checkedAt: ISO(0),
      },
      verify: { lockInUse: false, activeRuns: 0, queuedRuns: 0, workerBudget: 8, workersPerRun: 4 },
      selfHeal: { sessionsResumed: 2, sessionsOrphaned: 0, since: ISO(-3_600_000) },
    } as BoardSnapshot;
    const cards = healthCards(snapshot, NOW.getTime());
    expect(cards.map((c) => c.value)).toEqual(['43 behind', '0 active', 'wake 1m ago', '3', 'lock free', '2 resumed']);
  });
});
