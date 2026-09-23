import { describe, expect, it } from 'vitest';
import type {
  JobPrState,
  JobView,
  RoundView,
} from './board-protocol.js';
import {
  BAND_LABELS,
  JOB_STALLED_AFTER_MS,
  bandForJob,
  bucketJobs,
  isStalledWorking,
  jobRecency,
  needsYouReasons,
} from './board-bands.js';

const NOW = new Date(2026, 8, 23, 12, 0, 0).getTime(); // local noon — day-boundary tests stay timezone-robust
const ISO = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

function round(overrides: Partial<RoundView> = {}): RoundView {
  return {
    id: 'r1',
    seq: 1,
    status: 'live',
    verdict: null,
    targetRef: null,
    createdAt: ISO(-3_600_000),
    updatedAt: ISO(-60_000),
    lenses: [{ lens: 'blind', state: 'live', agentId: null, note: null, verdict: null }],
    lensAttempts: [],
    blockers: 0,
    ...overrides,
  };
}

function job(overrides: Partial<JobView> = {}): JobView {
  return {
    id: 'job-1',
    repo: 'demo',
    title: 'Demo job',
    status: 'working',
    updatedAt: ISO(-600_000),
    prUrl: null,
    prState: null,
    baseBranch: 'main',
    note: null,
    rounds: [],
    lane: null,
    lastAgentActivity: ISO(-120_000),
    ...overrides,
  };
}

describe('board bands — deterministic bucketing', () => {
  it('assigns every status × recency × PR state by the documented rules', () => {
    const statuses = [
      'dispatched',
      'working',
      'delivered',
      'in-review',
      'blocked',
      'parked',
      'merged',
      'done',
      'error',
    ] as const;
    const prStates: (JobPrState | null)[] = [null, 'open', 'conflicting', 'merged'];

    /** Independent re-statement of the rules (never import the target's
     * own helpers here — the point is to pin the behavior). */
    function expected(status: string, fresh: boolean, pr: JobPrState | null): string {
      if (pr === 'conflicting') return 'needs-you';
      if (status === 'blocked' || status === 'error') return 'needs-you';
      if (status === 'dispatched' || status === 'in-review') return 'in-flight';
      if (status === 'working') return fresh ? 'in-flight' : 'cold';
      if (status === 'delivered') return 'settled';
      if (status === 'merged') return fresh ? 'settled' : 'cold';
      return 'cold'; // parked, done, unknown
    }

    for (const status of statuses) {
      for (const fresh of [true, false]) {
        for (const pr of prStates) {
          const candidate = job({
            status,
            prUrl: pr === null || pr === 'merged' ? null : 'https://example.invalid/pr/1',
            prState: pr,
            updatedAt: fresh ? ISO(-600_000) : ISO(-48 * 3_600_000),
            lastAgentActivity: fresh ? ISO(-120_000) : ISO(-45 * 60_000),
            lane: { branch: 'gru/x', sha: 'abc', status: 'active', createdAt: ISO(-3_600_000) },
            rounds: [],
          });
          const label = `${status}/${fresh ? 'fresh' : 'stale'}/${pr ?? 'no-pr'}`;
          expect(bandForJob(candidate, { now: NOW }), label).toBe(expected(status, fresh, pr));
        }
      }
    }
  });

  it('stalled demoter: working + no frames past 30 min sinks to COLD with a stale flag', () => {
    const fresh = job({ lastAgentActivity: ISO(-(JOB_STALLED_AFTER_MS - 60_000)) });
    const boundary = job({ lastAgentActivity: ISO(-JOB_STALLED_AFTER_MS) });
    const stalled = job({ lastAgentActivity: ISO(-(JOB_STALLED_AFTER_MS + 60_000)) });
    expect(isStalledWorking(fresh, { now: NOW })).toBe(false);
    expect(isStalledWorking(boundary, { now: NOW })).toBe(false); // strictly past the window
    expect(isStalledWorking(stalled, { now: NOW })).toBe(true);
    expect(bandForJob(fresh, { now: NOW })).toBe('in-flight');
    expect(bandForJob(stalled, { now: NOW })).toBe('cold');

    const [cold] = bucketJobs([stalled], { now: NOW });
    expect(cold?.band).toBe('cold');
    expect(cold?.jobs[0]?.stale).toBe(true);
  });

  it('stall stamp falls back to the lane creation; no stamp at all never guesses', () => {
    const laneOnly = job({
      lastAgentActivity: null,
      lane: { branch: null, sha: 'abc', status: 'active', createdAt: ISO(-(JOB_STALLED_AFTER_MS + 1)) },
    });
    expect(isStalledWorking(laneOnly, { now: NOW })).toBe(true);
    expect(isStalledWorking(job({ lastAgentActivity: null, lane: null }), { now: NOW })).toBe(false);
    // Staleness is a WORKING-lane concern only.
    expect(isStalledWorking(job({ status: 'parked', lastAgentActivity: ISO(-10 * 3_600_000) }), { now: NOW })).toBe(false);
  });

  it('cascade promoter: a conflicting PR jumps ANY status to NEEDS YOU', () => {
    for (const status of ['working', 'in-review', 'parked', 'done', 'delivered']) {
      const conflicting = job({ status, prState: 'conflicting', prUrl: 'https://example.invalid/pr/1' });
      expect(bandForJob(conflicting, { now: NOW }), status).toBe('needs-you');
    }
  });

  it('needs-you causes: unacked action-required, blocked, error, aborted round, failed lens', () => {
    expect(needsYouReasons(job({ status: 'parked' }), 1)).toContain('action-required');
    expect(bandForJob(job({ status: 'done' }), { now: NOW, unackedByJob: new Map([['job-1', 1]]) })).toBe('needs-you');
    expect(bandForJob(job({ status: 'blocked' }), { now: NOW })).toBe('needs-you');
    expect(bandForJob(job({ status: 'error' }), { now: NOW })).toBe('needs-you');
    expect(bandForJob(job({ status: 'working', rounds: [round({ status: 'aborted' })] }), { now: NOW })).toBe('needs-you');
    const failed = round({ lenses: [{ lens: 'blind', state: 'error', agentId: null, note: null, verdict: null }] });
    expect(bandForJob(job({ status: 'in-review', rounds: [failed] }), { now: NOW })).toBe('needs-you');
    // A verdict-posted round's failed lens is history — it never re-alarms.
    const historical = round({ status: 'verdict-posted', lenses: [{ lens: 'blind', state: 'error', agentId: null, note: null, verdict: null }] });
    expect(bandForJob(job({ status: 'in-review', rounds: [historical] }), { now: NOW })).toBe('in-flight');
    // Blocker verdicts are review work (the lead owns them), not a NEEDS YOU band entry.
    const blockers = round({ blockers: 2, lenses: [{ lens: 'blind', state: 'done', agentId: null, note: 'blocker — x', verdict: 'blocker' }] });
    expect(bandForJob(job({ status: 'in-review', rounds: [blockers] }), { now: NOW })).toBe('in-flight');
    // Only the NEWEST round drives attention (older failures are history):
    // rounds arrive oldest-first, so the LAST element is the current state.
    const olderFailed = round({ id: 'r0' });
    expect(
      bandForJob(job({ status: 'in-review', rounds: [olderFailed, failed] }), { now: NOW }),
    ).toBe('needs-you');
    expect(
      bandForJob(job({ status: 'in-review', rounds: [olderFailed, round({ id: 'r2' })] }), { now: NOW }),
    ).toBe('in-flight');
  });

  it('settled: delivered always; merged only when it landed today', () => {
    const now = new Date(NOW);
    expect(bandForJob(job({ status: 'delivered' }), { now: NOW })).toBe('settled');
    expect(
      bandForJob(job({ status: 'merged', updatedAt: now.toISOString() }), { now: NOW }),
    ).toBe('settled');
    expect(
      bandForJob(job({ status: 'merged', updatedAt: ISO(-48 * 3_600_000) }), { now: NOW }),
    ).toBe('cold');
  });

  it('orders bands NEEDS YOU → IN FLIGHT → SETTLED → COLD and omits empty bands', () => {
    const jobs = [
      job({ id: 'cold-1', status: 'parked' }),
      job({ id: 'settled-1', status: 'delivered' }),
      job({ id: 'flight-1', status: 'in-review' }),
      job({ id: 'needs-1', status: 'blocked' }),
    ];
    const bands = bucketJobs(jobs, { now: NOW });
    expect(bands.map((group) => group.band)).toEqual(['needs-you', 'in-flight', 'settled', 'cold']);
    expect(BAND_LABELS['needs-you']).toBe('NEEDS YOU');
    expect(bucketJobs([], { now: NOW })).toEqual([]);
    expect(bucketJobs([job({ id: 'only-parked', status: 'parked' })], { now: NOW }).map((g) => g.band)).toEqual(['cold']);
  });

  it('recency orders within a band: newest activity first, id breaks ties', () => {
    const quiet = job({ id: 'quiet', status: 'in-review', updatedAt: ISO(-3_600_000), lastAgentActivity: ISO(-3_600_000) });
    const busy = job({ id: 'busy', status: 'in-review', updatedAt: ISO(-3_600_000), lastAgentActivity: ISO(-60_000) });
    const twinA = job({ id: 'twin-a', status: 'in-review', updatedAt: ISO(-120_000), lastAgentActivity: null });
    const twinB = job({ id: 'twin-b', status: 'in-review', updatedAt: ISO(-120_000), lastAgentActivity: null });
    const [band] = bucketJobs([quiet, twinB, busy, twinA], { now: NOW });
    // busy's newest frame (-60s) outranks the twin's -120s record change;
    // the twins tie and fall back to id.
    expect(band?.jobs.map((entry) => entry.job.id)).toEqual(['busy', 'twin-a', 'twin-b', 'quiet']);
  });

  it('jobRecency takes the newest of updatedAt / activity / lane creation', () => {
    const stake = job({ updatedAt: ISO(-3_600_000), lastAgentActivity: ISO(-60_000), lane: null });
    expect(jobRecency(stake)).toBe(ISO(-60_000));
    const laneNewer = job({
      updatedAt: ISO(-3_600_000),
      lastAgentActivity: ISO(-1_800_000),
      lane: { branch: null, sha: 'abc', status: 'active', createdAt: ISO(-30_000) },
    });
    expect(jobRecency(laneNewer)).toBe(ISO(-30_000));
  });
});
