import { describe, expect, it } from 'vitest';
import type {
  AgentView,
  JobPrState,
  JobView,
  RoundView,
} from './board-protocol.js';
import {
  BAND_LABELS,
  JOB_STALLED_AFTER_MS,
  SETTLED_WINDOW_SIZE,
  bandForJob,
  bucketJobs,
  isStalledWorking,
  jobRecency,
  needsYouReasons,
  settledWindow,
  stoppedWorkersByJob,
  workerStopLabel,
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

function agentView(id: string, overrides: Partial<AgentView> = {}): AgentView {
  return {
    id,
    role: 'minion',
    label: null,
    state: 'idle',
    lastActivity: null,
    sessionFile: null,
    jobId: null,
    roundId: null,
    supervision: null,
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
     * own helpers here — the point is to pin the behavior). Terminal jobs
     * (merged/done) are closed receipts: no signal — conflicting PR
     * guesses included — can promote them back into NEEDS YOU. */
    function expected(status: string, fresh: boolean, pr: JobPrState | null): string {
      if (status === 'merged') return fresh ? 'settled' : 'cold';
      if (status === 'done') return 'cold';
      if (pr === 'conflicting') return 'needs-you';
      if (status === 'blocked' || status === 'error') return 'needs-you';
      if (status === 'dispatched' || status === 'in-review') return 'in-flight';
      if (status === 'working') return fresh ? 'in-flight' : 'cold';
      if (status === 'delivered') return 'settled';
      return 'cold'; // parked, unknown
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

  it('cascade promoter: a conflicting PR jumps any LIVE status to NEEDS GRU', () => {
    // Terminal jobs are closed receipts (see the section-truth test below)
    // — the cascade can never pull a merged/done lane back into the queue.
    for (const status of ['working', 'in-review', 'parked', 'delivered']) {
      const conflicting = job({ status, prState: 'conflicting', prUrl: 'https://example.invalid/pr/1' });
      expect(bandForJob(conflicting, { now: NOW }), status).toBe('needs-you');
    }
  });

  it('needs-you causes: unacked action-required, blocked, error, aborted round, failed lens', () => {
    expect(needsYouReasons(job({ status: 'parked' }), 1)).toContain('action-required');
    expect(bandForJob(job({ status: 'parked' }), { now: NOW, unackedByJob: new Map([['job-1', 1]]) })).toBe('needs-you');
    expect(bandForJob(job({ status: 'blocked' }), { now: NOW })).toBe('needs-you');
    expect(bandForJob(job({ status: 'error' }), { now: NOW })).toBe('needs-you');
    expect(bandForJob(job({ status: 'working', rounds: [round({ status: 'aborted' })] }), { now: NOW })).toBe('needs-you');
    const failed = round({ lenses: [{ lens: 'blind', state: 'error', agentId: null, note: null, verdict: null }] });
    expect(bandForJob(job({ status: 'in-review', rounds: [failed] }), { now: NOW })).toBe('needs-you');
    // A verdict-posted round's failed lens is history — it never re-alarms.
    const historical = round({ status: 'verdict-posted', lenses: [{ lens: 'blind', state: 'error', agentId: null, note: null, verdict: null }] });
    expect(bandForJob(job({ status: 'in-review', rounds: [historical] }), { now: NOW })).toBe('in-flight');
    // Blocker verdicts are review work (the lead owns them), not a NEEDS GRU band entry.
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

  it('orders bands NEEDS GRU → IN FLIGHT → SETTLED → COLD and omits empty bands', () => {
    const jobs = [
      job({ id: 'cold-1', status: 'parked' }),
      job({ id: 'settled-1', status: 'delivered' }),
      job({ id: 'flight-1', status: 'in-review' }),
      job({ id: 'needs-1', status: 'blocked' }),
    ];
    const bands = bucketJobs(jobs, { now: NOW });
    expect(bands.map((group) => group.band)).toEqual(['needs-you', 'in-flight', 'settled', 'cold']);
    expect(BAND_LABELS['needs-you']).toBe('NEEDS GRU');
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

describe('board bands — concluded jobs ignore stale review history (owner ruling 2026-09-26)', () => {
  const errorLens = { lens: 'blind', state: 'error', agentId: null, note: 'provider cap hit', verdict: null };
  /** Generic #73/#74-shaped record: an old aborted round r1 full of error
   * lenses, then a newer aborted round r2 with a null (INCOMPLETE)
   * verdict — the exact live pattern that used to promote merged work. */
  const abortedHistory = [
    round({ id: 'r1', seq: 1, status: 'aborted', verdict: null, lenses: [errorLens] }),
    round({ id: 'r2', seq: 2, status: 'aborted', verdict: null, targetRef: 'a'.repeat(40) }),
  ];
  const failedLensRound = round({
    id: 'r1',
    seq: 1,
    status: 'pending',
    verdict: null,
    lenses: [errorLens],
  });

  it('merged/done jobs with aborted newest rounds earn NO historical review reasons', () => {
    const mergedToday = job({
      status: 'merged',
      prState: 'merged',
      prUrl: 'https://example.invalid/pr/1',
      updatedAt: ISO(-600_000),
      rounds: abortedHistory,
    });
    expect(needsYouReasons(mergedToday, 0)).toEqual([]); // not ['round aborted']
    expect(bandForJob(mergedToday, { now: NOW })).toBe('settled'); // merged today

    const mergedOld = job({ status: 'merged', prState: 'merged', updatedAt: ISO(-48 * 3_600_000), rounds: abortedHistory });
    expect(bandForJob(mergedOld, { now: NOW })).toBe('cold'); // merged before today

    const done = job({ status: 'done', rounds: abortedHistory });
    expect(needsYouReasons(done, 0)).toEqual([]);
    expect(bandForJob(done, { now: NOW })).toBe('cold');
  });

  it('concluded jobs with failed-lens (never-verdicted) newest rounds also stay out of NEEDS YOU', () => {
    const merged = job({ status: 'merged', prState: 'merged', updatedAt: ISO(-600_000), rounds: [failedLensRound] });
    expect(needsYouReasons(merged, 0)).toEqual([]); // not ['lens failed']
    expect(bandForJob(merged, { now: NOW })).toBe('settled');
    expect(bandForJob(job({ status: 'done', rounds: [failedLensRound] }), { now: NOW })).toBe('cold');
  });

  it('a leftover unacked action-required row on a concluded job is a closed receipt — it never promotes the lane', () => {
    // Section-truth ruling (2026-09-29) supersedes the 2026-09-26
    // "current-state obligations still promote concluded work" clause:
    // a merged/done job is a closed receipt, so a terminal-bound
    // machine row can never make it live NEEDS GRU work again. Snapshot
    // attribution (unackedByJob) also drops terminal-bound rows, so this
    // count never reaches the bander in production.
    const merged = job({ status: 'merged', prState: 'merged', updatedAt: ISO(-600_000), rounds: abortedHistory });
    expect(needsYouReasons(merged, 2)).toEqual([]);
    expect(bandForJob(merged, { now: NOW, unackedByJob: new Map([['job-1', 2]]) })).toBe('settled');
    expect(bandForJob(job({ status: 'done', rounds: abortedHistory }), { now: NOW, unackedByJob: new Map([['job-1', 1]]) })).toBe('cold');
  });

  it('a conflicting PR on a concluded job is history too — a closed receipt never returns to NEEDS GRU', () => {
    const merged = job({
      status: 'merged',
      prState: 'conflicting',
      prUrl: 'https://example.invalid/pr/1',
      updatedAt: ISO(-600_000),
      rounds: abortedHistory,
    });
    expect(needsYouReasons(merged, 0)).toEqual([]);
    expect(bandForJob(merged, { now: NOW })).toBe('settled');
  });

  it('delivered/parked jobs keep their existing aborted-round promotion (retained behavior)', () => {
    expect(bandForJob(job({ status: 'delivered', rounds: abortedHistory }), { now: NOW })).toBe('needs-you');
    expect(bandForJob(job({ status: 'parked', rounds: abortedHistory }), { now: NOW })).toBe('needs-you');
    expect(needsYouReasons(job({ status: 'delivered', rounds: abortedHistory }), 0)).toContain('round aborted');
  });

  it('active work keeps legitimate NEEDS YOU attention — including a job reopened after a prior merge', () => {
    // A current implementation is not finished just because its previous
    // linked PR merged: status is in-review again, PR state still merged.
    const reopened = job({
      status: 'in-review',
      prState: 'merged',
      prUrl: 'https://example.invalid/pr/1',
      updatedAt: ISO(-600_000),
      rounds: abortedHistory,
    });
    expect(bandForJob(reopened, { now: NOW })).toBe('needs-you');
    expect(bandForJob(job({ status: 'working', rounds: abortedHistory }), { now: NOW })).toBe('needs-you');
    expect(bandForJob(job({ status: 'blocked', rounds: abortedHistory }), { now: NOW })).toBe('needs-you');
    expect(bandForJob(job({ status: 'error', rounds: abortedHistory }), { now: NOW })).toBe('needs-you');
  });

  it('concluded jobs with no rounds at all bucket by day as before', () => {
    expect(bandForJob(job({ status: 'merged', prState: 'merged', updatedAt: ISO(-600_000), rounds: [] }), { now: NOW })).toBe('settled');
    expect(bandForJob(job({ status: 'merged', prState: 'merged', updatedAt: ISO(-48 * 3_600_000), rounds: [] }), { now: NOW })).toBe('cold');
    expect(bandForJob(job({ status: 'done', rounds: [] }), { now: NOW })).toBe('cold');
  });

  it('bucketing never rewrites the review record — rounds ride along untouched', () => {
    const merged = job({ status: 'merged', prState: 'merged', updatedAt: ISO(-600_000), rounds: abortedHistory });
    const [settled] = bucketJobs([merged], { now: NOW });
    expect(settled?.band).toBe('settled');
    expect(settled?.jobs[0]?.job.rounds).toHaveLength(2);
    expect(settled?.jobs[0]?.job.rounds.at(-1)?.status).toBe('aborted');
    expect(settled?.jobs[0]?.job.rounds.at(-1)?.verdict).toBeNull(); // INCOMPLETE stays INCOMPLETE
  });
});

describe('board bands — settled rolling window (v5)', () => {
  /** Recency-sorted settled band, newest first (bucketJobs order). */
  function settledBand(count: number) {
    return bucketJobs(
      Array.from({ length: count }, (_, index) =>
        job({ id: `settled-${String(index).padStart(2, '0')}`, status: 'delivered', updatedAt: ISO(-index * 60_000) }),
      ),
      { now: NOW },
    )[0]!.jobs;
  }

  it('shows the latest N settled jobs and reports the hidden tail', () => {
    const jobs = settledBand(12);
    const window = settledWindow(jobs, false);
    expect(SETTLED_WINDOW_SIZE).toBe(10);
    expect(window.jobs).toHaveLength(10);
    expect(window.jobs[0]?.job.id).toBe('settled-00'); // newest first
    expect(window.jobs[9]?.job.id).toBe('settled-09');
    expect(window.hidden).toBe(2);
  });

  it('expanded (or at/below the limit) shows everything with nothing held back', () => {
    expect(settledWindow(settledBand(12), true).hidden).toBe(0);
    expect(settledWindow(settledBand(12), true).jobs).toHaveLength(12);
    expect(settledWindow(settledBand(10), false)).toEqual({ jobs: settledBand(10), hidden: 0 });
    expect(settledWindow(settledBand(3), false).jobs).toHaveLength(3);
  });

  it('never needs a window for an empty band', () => {
    expect(settledWindow([], false)).toEqual({ jobs: [], hidden: 0 });
  });
});

describe('board bands — section truth: terminal jobs are closed receipts', () => {
  it('merged/done never re-enter NEEDS YOU, whatever is left over', () => {
    for (const status of ['merged', 'done']) {
      const closed = job({
        id: `closed-${status}`,
        status,
        rounds: [round({ status: 'aborted' })], // stale history noise
      });
      expect(needsYouReasons(closed, 2)).toEqual([]);
    }
    // A merged lane from today with leftover unacked escalations is still
    // a closed receipt: SETTLED, never the live queue.
    const mergedToday = job({ id: 'closed-merged', status: 'merged', updatedAt: ISO(-60_000) });
    expect(bandForJob(mergedToday, { now: NOW, unackedByJob: new Map([['closed-merged', 2]]) })).toBe('settled');
    // An older done lane sinks to COLD — closed either way.
    const doneOld = job({ id: 'closed-done', status: 'done', updatedAt: ISO(-26 * 3_600_000) });
    expect(bandForJob(doneOld, { now: NOW, unackedByJob: new Map([['closed-done', 2]]) })).toBe('cold');
  });
});

describe('board bands — stopped-worker truth (waiting, not stalled)', () => {
  const stop = { reason: 'quota_wall', restarts: 2 };

  it('a supervision-stopped working lane waits in IN FLIGHT with its reason — never COLD/stalled', () => {
    const stopped = job({ lastAgentActivity: ISO(-(JOB_STALLED_AFTER_MS + 60_000)) });
    const opts = { now: NOW, stoppedWorkers: new Map([['job-1', stop]]) };
    // Past the stall window, but the silence has a recorded cause.
    expect(isStalledWorking(stopped, opts)).toBe(false);
    expect(bandForJob(stopped, opts)).toBe('in-flight');
    const [group] = bucketJobs([stopped], opts);
    expect(group?.band).toBe('in-flight');
    expect(group?.jobs[0]?.stale).toBe(false);
  });

  it('the waiting truth never masks other signals: an unacked escalation still cascades to NEEDS YOU', () => {
    const opts = {
      now: NOW,
      stoppedWorkers: new Map([['job-1', stop]]),
      unackedByJob: new Map([['job-1', 1]]),
    };
    expect(bandForJob(job(), opts)).toBe('needs-you');
  });

  it('COLD stays for genuinely-silent lanes — the stop map never invents silence', () => {
    const silent = job({ lastAgentActivity: ISO(-(JOB_STALLED_AFTER_MS + 60_000)) });
    expect(isStalledWorking(silent, { now: NOW })).toBe(true);
    expect(bandForJob(silent, { now: NOW })).toBe('cold');
    const [group] = bucketJobs([silent], { now: NOW });
    expect(group?.jobs[0]?.stale).toBe(true);
  });

  it('stoppedWorkersByJob reads bound agents only; workerStopLabel renders the reason', () => {
    const map = stoppedWorkersByJob([
      agentView('m1', { jobId: 'job-1', supervision: { state: 'stopped', restarts: 2, breakerOpen: true, stopReason: 'quota_wall' } }),
      // breaker-open alone marks the lane even before the state settles.
      agentView('m2', { jobId: 'job-2', supervision: { state: 'watching', restarts: 0, breakerOpen: true, stopReason: null } }),
      agentView('m3', { jobId: 'job-3', supervision: { state: 'watching', restarts: 0, breakerOpen: false, stopReason: null } }),
      agentView('m4', { jobId: 'job-4', supervision: null }),
      // An unbound stopped agent stays global — no lane to mark.
      agentView('m5', { supervision: { state: 'stopped', restarts: 0, breakerOpen: true, stopReason: null } }),
    ]);
    expect(map.get('job-1')).toEqual({ reason: 'quota_wall', restarts: 2 });
    expect(map.get('job-2')).toEqual({ reason: null, restarts: 0 });
    expect(map.has('job-3')).toBe(false);
    expect(map.has('job-4')).toBe(false);
    expect(map.size).toBe(2);
    expect(workerStopLabel(map.get('job-1')!)).toBe('waiting · quota wall');
    expect(workerStopLabel({ reason: 'crash loop', restarts: 3 })).toBe('waiting · crash loop');
    expect(workerStopLabel({ reason: null, restarts: 0 })).toBe('waiting');
  });

  it('only the lane worker (minion) speaks for the lane — a workflow-owned review stop never does', () => {
    const map = stoppedWorkersByJob([
      // Perkins review agents are bound to the job too, but an aborted
      // isolated attempt ('review aborted', breaker left closed) is owned
      // by the round workflow — it must never render the working lane as
      // waiting.
      agentView('p1', {
        role: 'perkins',
        jobId: 'job-1',
        roundId: 'r1',
        supervision: { state: 'stopped', restarts: 0, breakerOpen: false, stopReason: 'review aborted' },
      }),
      // Even a breaker-open perkins stop stays off the lane: only the
      // worker's stop says the lane is not running.
      agentView('p2', {
        role: 'perkins',
        jobId: 'job-1',
        roundId: 'r1',
        supervision: { state: 'stopped', restarts: 1, breakerOpen: true, stopReason: 'quota_wall' },
      }),
      // The lane's minion is working — the lane stays working.
      agentView('m1', {
        role: 'minion',
        jobId: 'job-1',
        supervision: { state: 'watching', restarts: 0, breakerOpen: false, stopReason: null },
      }),
      // And when the lane's own minion stops, the lane waits as before.
      agentView('m2', {
        role: 'minion',
        jobId: 'job-2',
        supervision: { state: 'stopped', restarts: 2, breakerOpen: true, stopReason: 'quota_wall' },
      }),
    ]);
    expect(map.has('job-1')).toBe(false);
    expect(map.get('job-2')).toEqual({ reason: 'quota_wall', restarts: 2 });
    expect(map.size).toBe(1);
  });

  it('a live re-dispatched worker clears the previous stopped record — the lane is not waiting', () => {
    const map = stoppedWorkersByJob([
      // The previous worker stopped; its record survives disposal (the Ack
      // must find it to re-arm) and stays stopped while the lane is
      // re-briefed with a fresh worker.
      agentView('old', {
        jobId: 'job-1',
        state: 'idle',
        supervision: { state: 'stopped', restarts: 1, breakerOpen: true, stopReason: 'quota_wall' },
      }),
      // The fresh worker is running: the lane's CURRENT worker decides.
      agentView('fresh', {
        jobId: 'job-1',
        state: 'streaming',
        supervision: { state: 'watching', restarts: 0, breakerOpen: false, stopReason: null },
      }),
    ]);
    expect(map.has('job-1')).toBe(false);
  });

  it('stopped records still mark the lane when every bound worker is stopped', () => {
    const map = stoppedWorkersByJob([
      agentView('old', {
        jobId: 'job-1',
        lastActivity: ISO(-2 * 3_600_000),
        supervision: { state: 'stopped', restarts: 1, breakerOpen: true, stopReason: 'quota_wall' },
      }),
      agentView('newer', {
        jobId: 'job-1',
        lastActivity: ISO(-1 * 3_600_000),
        supervision: { state: 'stopped', restarts: 4, breakerOpen: true, stopReason: 'crash loop' },
      }),
    ]);
    // No live worker remains: the lane waits on its CURRENT (newest) stop —
    // a superseded worker's reason never masquerades as the live one
    // (final independent review B1/C0).
    expect(map.get('job-1')).toEqual({ reason: 'crash loop', restarts: 4 });
  });

  it('an unsupervised fresh worker still clears an older stopped record', () => {
    const map = stoppedWorkersByJob([
      agentView('old', {
        jobId: 'job-1',
        supervision: { state: 'stopped', restarts: 1, breakerOpen: true, stopReason: 'quota_wall' },
      }),
      // A null supervision view is an unsupervised worker, not a stop: the
      // live worker decides, so the lane never reads "waiting" from its
      // previous worker (finding B2, final independent review).
      agentView('fresh', { jobId: 'job-1', state: 'streaming', supervision: null }),
    ]);
    expect(map.has('job-1')).toBe(false);
  });

  it('a disposed unsupervised record does not clear a current stop', () => {
    const map = stoppedWorkersByJob([
      agentView('current', {
        jobId: 'job-1',
        supervision: { state: 'stopped', restarts: 1, breakerOpen: true, stopReason: 'quota_wall' },
      }),
      // A disposed record has no live worker behind it: it must not erase
      // the current worker's stop (finding E0, final independent review).
      agentView('dead', { jobId: 'job-1', state: 'disposed', supervision: null }),
    ]);
    expect(map.get('job-1')).toEqual({ reason: 'quota_wall', restarts: 1 });
  });

  it('a newer stop wins over an older live record', () => {
    const map = stoppedWorkersByJob([
      agentView('stale-live', {
        jobId: 'job-1',
        lastActivity: ISO(-2 * 3_600_000),
        supervision: { state: 'watching', restarts: 0, breakerOpen: false, stopReason: null },
      }),
      agentView('current-stop', {
        jobId: 'job-1',
        lastActivity: ISO(-1 * 3_600_000),
        supervision: { state: 'stopped', restarts: 1, breakerOpen: true, stopReason: 'quota_wall' },
      }),
    ]);
    // The stopped record is the lane's current worker: an older live
    // record must not mask it (final independent review B1).
    expect(map.get('job-1')).toEqual({ reason: 'quota_wall', restarts: 1 });
  });
});
