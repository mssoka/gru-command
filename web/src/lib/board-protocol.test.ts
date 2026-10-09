import { describe, expect, it } from 'vitest';
import { isValidLessonProposal } from './board-protocol.js';
import {
  agentStateTone,
  isValidSnapshot,
  jobChipTone,
  lensChipState,
  lensChipTone,
  parseBoardServerFrame,
  type BoardSnapshot,
  type NotificationView,
} from './board-protocol.js';

/** A minimal valid snapshot; tests mutate copies to break it. */
function snapshot(): BoardSnapshot {
  return {
    repos: [
      {
        name: 'demo-repo',
        jobs: [
          {
            id: 'job-1',
            repo: 'demo-repo',
            title: 'Sample job',
            status: 'working',
            updatedAt: '2026-01-01T00:00:00.000Z',
            prUrl: null,
            prState: null,
            baseBranch: null,
            note: null,
            rounds: [
              {
                id: 'job-1-r1',
                seq: 1,
                status: 'live',
                verdict: null,
                targetRef: null,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                lensAttempts: [{ lens: 'blind', attempts: 2 }],
                blockers: 0,
                lenses: [
                  { lens: 'blind', state: 'done', agentId: 'a1', note: null, verdict: null },
                  { lens: 'edge', state: 'error', agentId: 'a2', note: 'cap', verdict: null },
                ],
              },
            ],
            lane: { branch: 'gru/job-1', sha: 'abc123', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' },
            lastAgentActivity: null,
          },
        ],
      },
    ],
    agents: [
      { id: 'gru-1', role: 'gru', label: 'gru', state: 'idle', lastActivity: null, sessionFile: null, jobId: null, roundId: null, supervision: null },
    ],
    notifications: [],
    decisions: {
      enabled: false,
      status: 'disabled',
      reason: 'disabled',
      model: '~typesafe/jev-latest',
      endpoint: 'https://openrouter.ai/api/alpha/decisions',
      credentialPresent: false,
      credentialSource: 'none',
      checkedAt: null,
      incarnation: 'test-incarnation',
      generation: 0,
    },
    unackedActionRequired: 0,
    unackedNeedsOwner: 0,
    wakes: { count: 0, lastAt: null, deferred: { count: 0, reasons: {}, truncated: false } },
  };
}

describe('board server-frame validator', () => {
  it('accepts auth_ok, ping, snapshot, and error frames', () => {
    expect(parseBoardServerFrame({ type: 'auth_ok' })).toEqual({ type: 'auth_ok' });
    expect(parseBoardServerFrame({ type: 'ping' })).toEqual({ type: 'ping' });
    const board = parseBoardServerFrame({ type: 'board', snapshot: snapshot() });
    expect(board?.type).toBe('board');
    const error = parseBoardServerFrame({ type: 'error', message: 'bad token', fatal: true });
    expect(error).toEqual({ type: 'error', message: 'bad token', fatal: true });
  });

  it('accepts legacy absent and nullable heist metadata, rejects malformed authored names', () => {
    const board = snapshot();
    const job = board.repos[0]!.jobs[0]! as { displayName?: unknown };
    expect(isValidSnapshot(board)).toBe(true); // older server
    job.displayName = null;
    expect(isValidSnapshot(board)).toBe(true);
    job.displayName = 'Wake & alerts';
    expect(isValidSnapshot(board)).toBe(true);
    // Visible letters behind invisible formatting controls are accepted
    // raw; ignoring the controls before shortening is the renderer's
    // contract (r5 display-correctness warning).
    job.displayName = '\u200b'.repeat(24) + 'wake alerts';
    expect(isValidSnapshot(board)).toBe(true);
    job.displayName = '   ';
    expect(isValidSnapshot(board)).toBe(false);
    job.displayName = 123;
    expect(isValidSnapshot(board)).toBe(false);
    // Invisible-only names would render an empty card (G3): format and
    // combining characters alone are as bad as blank.
    job.displayName = '\u200b\u200d';
    expect(isValidSnapshot(board)).toBe(false);
    job.displayName = '\u0301\u0301';
    expect(isValidSnapshot(board)).toBe(false);
    job.displayName = '🧑\u200d🚀 launch';
    expect(isValidSnapshot(board)).toBe(true);
  });

  it('accepts an absent or null parent job (top-level heist), rejects a malformed one', () => {
    const board = snapshot();
    const job = board.repos[0]!.jobs[0]! as { id: string; parentJobId?: unknown };
    expect(isValidSnapshot(board)).toBe(true); // older server: no field
    job.parentJobId = null;
    expect(isValidSnapshot(board)).toBe(true);
    job.parentJobId = 'impl';
    expect(isValidSnapshot(board)).toBe(true);
    job.parentJobId = '  ';
    expect(isValidSnapshot(board)).toBe(false);
    job.parentJobId = 7;
    expect(isValidSnapshot(board)).toBe(false);
    job.parentJobId = job.id; // a job is never its own megaminion
    expect(isValidSnapshot(board)).toBe(false);
  });

  it('rejects malformed frames (wrong shapes, missing fields, non-objects)', () => {
    expect(parseBoardServerFrame(null)).toBeNull();
    expect(parseBoardServerFrame('board')).toBeNull();
    expect(parseBoardServerFrame({ type: 'nope' })).toBeNull();
    expect(parseBoardServerFrame({ type: 'error', message: 'x' })).toBeNull(); // fatal missing
    expect(parseBoardServerFrame({ type: 'board' })).toBeNull(); // snapshot missing
    expect(parseBoardServerFrame({ type: 'board', snapshot: { repos: 'nope' } })).toBeNull();
  });

  it('snapshot validation catches structural drift at every level', () => {
    expect(isValidSnapshot(snapshot())).toBe(true);
    const noJobs = snapshot();
    (noJobs.repos[0] as unknown as { jobs: unknown }).jobs = 'not-an-array';
    expect(isValidSnapshot(noJobs)).toBe(false);
    const badLens = snapshot();
    (badLens.repos[0]!.jobs[0]!.rounds[0]!.lenses[0] as unknown as { state: unknown }).state = 7;
    expect(isValidSnapshot(badLens)).toBe(false);
    const badDecision = snapshot();
    delete (badDecision.decisions as unknown as Record<string, unknown>).generation;
    expect(isValidSnapshot(badDecision)).toBe(false);
    const coercedDecision = snapshot();
    (coercedDecision.decisions as unknown as { status: unknown }).status = { toString: () => 'ready' };
    expect(isValidSnapshot(coercedDecision)).toBe(false);
    const missingResolution = snapshot();
    (missingResolution.notifications as unknown as Record<string, unknown>[]).push({
      id: 'n1', ts: '2026-01-01T00:00:00.000Z', severity: 'error', routing: 'action-required', title: 'incident', ackedAt: null,
    });
    expect(isValidSnapshot(missingResolution)).toBe(false);
    const badLane = snapshot();
    (badLane.repos[0]!.jobs[0] as unknown as { lane: unknown }).lane = { branch: 7, sha: 'x', status: 'active', createdAt: 'now' };
    expect(isValidSnapshot(badLane)).toBe(false);
    const badAttempts = snapshot();
    (badAttempts.repos[0]!.jobs[0]!.rounds[0] as unknown as { lensAttempts: unknown }).lensAttempts = [{ lens: 'blind', attempts: '2' }];
    expect(isValidSnapshot(badAttempts)).toBe(false);
    const badUnacked = snapshot();
    (badUnacked as unknown as { unackedActionRequired: unknown }).unackedActionRequired = 'none';
    expect(isValidSnapshot(badUnacked)).toBe(false);
    const empty: Record<string, unknown> = {};
    expect(isValidSnapshot(empty)).toBe(false);
  });

  it('rejects missing and malformed owner-bell/wake snapshot fields', () => {
    for (const field of ['unackedNeedsOwner', 'wakes'] as const) {
      const candidate = { ...snapshot() } as Record<string, unknown>;
      delete candidate[field];
      expect(parseBoardServerFrame({ type: 'board', snapshot: candidate })).toBeNull();
    }
    for (const value of [null, '1', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      const candidate = { ...snapshot(), unackedNeedsOwner: value };
      expect(isValidSnapshot(candidate)).toBe(false);
      const wakes = { ...snapshot(), wakes: { count: value, lastAt: null } };
      expect(isValidSnapshot(wakes)).toBe(false);
    }
    for (const lastAt of [1, {}, false]) {
      expect(isValidSnapshot({ ...snapshot(), wakes: { count: 1, lastAt } })).toBe(false);
    }
  });

  it('issue #219 deferred wakes: valid present block accepted, malformed block rejected, absent tolerated', () => {
    const valid = snapshot();
    expect(isValidSnapshot(valid)).toBe(true);
    expect(isValidSnapshot({ ...valid, wakes: { count: 2, lastAt: null, deferred: { count: 5, reasons: { covered: 3, duplicate: 2 }, truncated: false } } })).toBe(true);
    // Absent deferred block: pre-upgrade server, tolerated.
    expect(isValidSnapshot({ ...valid, wakes: { count: 2, lastAt: null } })).toBe(true);
    // Malformed when present: negative count, non-numeric reason count, bad truncated type.
    expect(isValidSnapshot({ ...valid, wakes: { count: 2, lastAt: null, deferred: { count: -1, reasons: {} } } })).toBe(false);
    expect(isValidSnapshot({ ...valid, wakes: { count: 2, lastAt: null, deferred: { count: 1, reasons: { covered: 'many' } } } })).toBe(false);
    expect(isValidSnapshot({ ...valid, wakes: { count: 2, lastAt: null, deferred: { count: 1, reasons: {}, truncated: 'yes' } } })).toBe(false);
  });

  it('tolerates absent v4 blocks (pre-v4 servers) and validates present ones', () => {
    // Absent → fine (rollout tolerance). Null → fine (explicit "not wired").
    expect(isValidSnapshot(snapshot())).toBe(true);
    const nullBlocks = { ...snapshot(), build: null, silas: null, verify: null, selfHeal: null } as unknown;
    expect(isValidSnapshot(nullBlocks)).toBe(true);

    const wired = {
      ...snapshot(),
      build: {
        buildRev: 'a'.repeat(40),
        buildCommittedAt: '2026-01-01T00:00:00.000Z',
        originMainRev: 'b'.repeat(40),
        originMainCommittedAt: null,
        commitsBehind: 43,
        checkedAt: '2026-01-01T00:00:00.000Z',
        checkError: null,
      },
      silas: {
        lastWakeAt: null,
        lastTickAt: null,
        lastReconcileAt: null,
        lastReconcileFailedAt: null,
        reconcileFailedNewer: false,
        lastUsefulActionAt: null,
        nextAction: null,
        openTurnSince: null,
        reconciliationsToday: 2,
        checkedAt: '2026-01-01T00:00:00.000Z',
      },
      verify: { lockInUse: true, activeRuns: 1, queuedRuns: 0, workerBudget: 8, workersPerRun: 4 },
      selfHeal: { sessionsResumed: 1, sessionsOrphaned: 0, since: null },
    } as unknown;
    expect(isValidSnapshot(wired)).toBe(true);

    // A present-but-malformed block is a server bug — reject loudly.
    for (const [field, broken] of [
      ['build', { ...(wired as { build: object }).build, commitsBehind: '43' }],
      ['silas', { ...(wired as { silas: object }).silas, reconciliationsToday: -1 }],
      ['silas', { ...(wired as { silas: object }).silas, reconcileFailedNewer: 'no' }],
      ['silas', { ...(wired as { silas: object }).silas, reconcileFailedNewer: undefined }],
      ['silas', { ...(wired as { silas: object }).silas, nextAction: 7 }],
      ['verify', { ...(wired as { verify: object }).verify, lockInUse: 'yes' }],
      ['selfHeal', { ...(wired as { selfHeal: object }).selfHeal, sessionsResumed: 1.5 }],
    ] as const) {
      expect(isValidSnapshot({ ...(wired as object), [field]: broken }), field).toBe(false);
    }
  });

  it('validates a present supervision block at the parse boundary (known state, boolean breaker, finite restarts; junk rejects)', () => {
    const withSupervision = (supervision: unknown): unknown => {
      const candidate = snapshot();
      (candidate.agents[0] as unknown as { supervision: unknown }).supervision = supervision;
      return candidate;
    };
    // Accept: a stopped lane with a recorded reason, a stop without one
    // (pre-reason server), the watching baseline with stopReason absent,
    // and supervision absent/null (unsupervised).
    expect(
      isValidSnapshot(withSupervision({ state: 'stopped', restarts: 2, breakerOpen: true, stopReason: 'quota_wall' })),
    ).toBe(true);
    expect(
      isValidSnapshot(withSupervision({ state: 'stopped', restarts: 0, breakerOpen: true, stopReason: null })),
    ).toBe(true);
    expect(isValidSnapshot(withSupervision({ state: 'watching', restarts: 0, breakerOpen: false }))).toBe(true);
    expect(isValidSnapshot(withSupervision(null))).toBe(true);
    expect(isValidSnapshot(withSupervision(undefined))).toBe(true);
    // Reject: a present-but-junk block is a server bug, never "no reason".
    expect(
      isValidSnapshot(withSupervision({ state: 'stopped', restarts: 0, breakerOpen: true, stopReason: 7 })),
    ).toBe(false);
    expect(
      isValidSnapshot(withSupervision({ state: 'stopped', restarts: 0, breakerOpen: true, stopReason: {} })),
    ).toBe(false);
    expect(isValidSnapshot(withSupervision('stopped'))).toBe(false);
    // Reject malformed PRESENT fields (tracked-review A9): a truthy
    // non-boolean breaker must never read as a false-live lane, an unknown
    // state is not a state, and a non-finite/negative restart count is not
    // a count.
    expect(isValidSnapshot(withSupervision({ state: 'watching', restarts: 0, breakerOpen: 1 }))).toBe(false);
    expect(isValidSnapshot(withSupervision({ state: 'stopped', restarts: 'x', breakerOpen: true }))).toBe(false);
    expect(isValidSnapshot(withSupervision({ state: 'flying', restarts: 0, breakerOpen: false }))).toBe(false);
    expect(isValidSnapshot(withSupervision({ state: 'watching', restarts: -1, breakerOpen: false }))).toBe(false);
    expect(isValidSnapshot(withSupervision({ state: 'watching', restarts: Number.NaN, breakerOpen: false }))).toBe(false);
  });

  it('#171 agent classification fields validate strictly at the parse boundary (unknown class/status/lastEventAt reject)', () => {
    const withAgent = (patch: Record<string, unknown>): unknown => {
      const candidate = snapshot();
      Object.assign(candidate.agents[0] as unknown as Record<string, unknown>, patch);
      return candidate;
    };
    // Accept: absent (pre-upgrade), the three known classes, a known
    // derived status, and a parseable supervision event clock.
    expect(isValidSnapshot(snapshot())).toBe(true);
    expect(isValidSnapshot(withAgent({ runtime: 'current' }))).toBe(true);
    expect(isValidSnapshot(withAgent({ runtime: 'historical' }))).toBe(true);
    expect(isValidSnapshot(withAgent({ runtime: 'unverified' }))).toBe(true);
    expect(isValidSnapshot(withAgent({ status: 'streaming' }))).toBe(true);
    expect(
      isValidSnapshot(
        withAgent({ supervision: { state: 'watching', restarts: 0, breakerOpen: false, lastEventAt: '2026-01-01T00:00:00.000Z' } }),
      ),
    ).toBe(true);
    // Reject: an unknown ownership class or display status must never be
    // silently tolerated (a junk class would render as live crew; a junk
    // status would reach the chip).
    expect(isValidSnapshot(withAgent({ runtime: 'archived' }))).toBe(false);
    expect(isValidSnapshot(withAgent({ runtime: 'CURRENT' }))).toBe(false);
    expect(isValidSnapshot(withAgent({ status: 'vibing' }))).toBe(false);
    expect(isValidSnapshot(withAgent({ status: 7 }))).toBe(false);
    // Reject: an unparseable supervision event clock would silently
    // displace the valid ledger age in the quiet counter.
    expect(
      isValidSnapshot(
        withAgent({ supervision: { state: 'watching', restarts: 0, breakerOpen: false, lastEventAt: 'not-a-date' } }),
      ),
    ).toBe(false);
  });

  it('pipeline queue: absent/null tolerated, well-formed accepted, malformed rejected', () => {
    expect(isValidSnapshot(snapshot())).toBe(true);
    expect(isValidSnapshot({ ...snapshot(), pipeline: null } as unknown)).toBe(true);
    const entry = {
      id: 'pipe-1',
      repo: 'demo-repo',
      title: 'Approved queued brief',
      priority: 5,
      enqueueSeq: 1,
      state: 'ready',
      reason: null,
      queuedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(isValidSnapshot({ ...snapshot(), pipeline: { entries: [entry], pending: 1 } } as unknown)).toBe(true);
    expect(
      isValidSnapshot({
        ...snapshot(),
        pipeline: { entries: [{ ...entry, state: 'waiting', reason: 'owner hold: deciding' }], pending: 1 },
      } as unknown),
    ).toBe(true);

    // A present-but-malformed block is a server bug — reject loudly.
    for (const broken of [
      { ...entry, id: '' },
      { ...entry, state: 'parked' },
      { ...entry, priority: '5' },
      { ...entry, enqueueSeq: 0 },
      { ...entry, reason: 7 },
      { ...entry, queuedAt: null },
    ]) {
      expect(
        isValidSnapshot({ ...snapshot(), pipeline: { entries: [broken], pending: 1 } } as unknown),
        JSON.stringify(broken),
      ).toBe(false);
    }
    expect(isValidSnapshot({ ...snapshot(), pipeline: { entries: [entry], pending: -1 } } as unknown)).toBe(false);
    expect(isValidSnapshot({ ...snapshot(), pipeline: { entries: 'nope', pending: 0 } } as unknown)).toBe(false);
  });

  it('FOR YOU ownerPrs: absent/null tolerated (pre-upgrade servers), well-formed accepted, malformed rejected', () => {
    expect(isValidSnapshot(snapshot())).toBe(true);
    const nullPrs = { ...snapshot(), ownerPrs: null } as unknown;
    expect(isValidSnapshot(nullPrs)).toBe(true);

    const ready = {
      id: 'owner-pr:job-1',
      jobId: 'job-1',
      jobTitle: 'Ready heist',
      repo: 'demo-repo',
      prUrl: 'https://github.com/example/demo/pull/7',
      sha: 'a'.repeat(40),
      checkedAt: '2026-01-01T00:00:00.000Z',
    };
    expect(isValidSnapshot({ ...snapshot(), ownerPrs: [ready] } as unknown)).toBe(true);

    // Readiness is server authority: a malformed row never reaches the band.
    for (const broken of [
      { ...ready, id: '' },
      { ...ready, jobId: 7 },
      { ...ready, sha: null },
      { ...ready, checkedAt: 12 },
      { ...ready, prUrl: 'javascript:alert(1)' },
    ]) {
      expect(isValidSnapshot({ ...snapshot(), ownerPrs: [broken] } as unknown), JSON.stringify(broken)).toBe(false);
    }
    expect(isValidSnapshot({ ...snapshot(), ownerPrs: { not: 'an array' } } as unknown)).toBe(false);
  });

  it('managed repo overview: absent/null tolerated, well-formed accepted, malformed rejected', () => {
    expect(isValidSnapshot(snapshot())).toBe(true);
    expect(isValidSnapshot({ ...snapshot(), repoOverview: null } as unknown)).toBe(true);

    const run = {
      state: 'passed',
      status: 'completed',
      conclusion: 'success',
      workflow: 'CI',
      branch: 'main',
      runNumber: 12,
      url: 'https://github.com/example/demo/actions/runs/42',
      runCreatedAt: '2026-01-01T00:00:00.000Z',
      runStartedAt: '2026-01-01T00:01:00.000Z',
      runUpdatedAt: '2026-01-01T00:05:00.000Z',
    };
    const row = {
      key: 'demo',
      displayName: 'demo',
      linked: true,
      host: 'github.com',
      link: 'https://github.com/example/demo',
      linkReason: null,
      fullName: 'example/demo',
      openPrs: 0,
      openIssues: 3,
      run,
      freshness: 'fresh',
      checkedAt: '2026-01-01T00:06:00.000Z',
      lastAttemptAt: '2026-01-01T00:06:00.000Z',
      error: null,
    };
    expect(isValidSnapshot({ ...snapshot(), repoOverview: { rows: [row] } } as unknown)).toBe(true);
    // The exact server-emitted absence shapes (no provider strings) pass.
    const absence = { ...run, status: null, conclusion: null, workflow: null, runNumber: null, runCreatedAt: null, runStartedAt: null, runUpdatedAt: null };
    for (const absent of [
      { ...row, run: { ...absence, state: 'never-run' } },
      { ...row, run: { ...absence, state: 'no-workflow' } },
      { ...row, run: { ...absence, state: 'no-branch', branch: null } },
      { ...row, run: { ...absence, state: 'unavailable' } },
    ]) {
      expect(isValidSnapshot({ ...snapshot(), repoOverview: { rows: [absent] } } as unknown), JSON.stringify(absent)).toBe(true);
    }
    expect(isValidSnapshot({ ...snapshot(), repoOverview: { rows: [] } } as unknown)).toBe(true);

    const unlinked = {
      ...row,
      linked: false,
      host: null,
      link: null,
      linkReason: 'non-GitHub remote',
      fullName: null,
      openPrs: null,
      openIssues: null,
      run: null,
      freshness: 'unchecked',
      checkedAt: null,
      lastAttemptAt: null,
    };
    expect(isValidSnapshot({ ...snapshot(), repoOverview: { rows: [unlinked] } } as unknown)).toBe(true);
    // Positive shapes the server emits that a fixture-light suite can
    // miss: a linked but never-observed row (first pass / rotation
    // window) and an aged stale row with no failure marker.
    expect(
      isValidSnapshot({
        ...snapshot(),
        repoOverview: {
          rows: [
            {
              ...row,
              freshness: 'unchecked',
              checkedAt: null,
              lastAttemptAt: null,
              openPrs: null,
              openIssues: null,
              run: null,
              error: null,
            },
          ],
        },
      } as unknown),
    ).toBe(true);
    expect(
      isValidSnapshot({
        ...snapshot(),
        repoOverview: {
          rows: [
            {
              ...row,
              freshness: 'stale',
              checkedAt: '2026-01-01T00:05:00.000Z',
              lastAttemptAt: '2026-01-01T00:05:00.000Z',
              error: null,
            },
          ],
        },
      } as unknown),
    ).toBe(true);

    // Strictness: an unknown state/freshness, a negative or fractional count,
    // a non-https or malformed URL, inconsistent link coherence or an
    // unparseable timestamp must never render.
    for (const broken of [
      { ...row, run: { ...run, state: 'vibes' } },
      { ...row, run: { ...run, url: 'javascript:alert(1)' } },
      { ...row, freshness: 'maybe' },
      { ...row, openPrs: -1 },
      { ...row, openIssues: 1.5 },
      { ...row, link: 'https://evil.example/demo' , linkReason: 'why' },
      { ...row, linked: false },
      { ...unlinked, link: 'https://github.com/example/demo' },
      { ...row, checkedAt: 'not-a-date' },
      { ...row, key: '' },
      { ...row, run: { ...run, runNumber: -2 } },
      { ...row, fullName: '' },
      { ...row, fullName: '../evil' },
      { ...row, link: 'https://github.com/other/repo' },
      { ...row, link: 'https://github.com/example/demo/extra' },
      // r2 hardening: off-host links/run URLs, empty provider strings,
      // invisible names and incoherent freshness claims never validate.
      { ...row, host: 'evil.example' },
      { ...row, run: { ...run, url: 'https://evil.example/actions/runs/42' } },
      // Credentials and alternate ports never validate (fail closed).
      { ...row, run: { ...run, url: 'https://user:secret@github.com/actions/runs/42' } },
      { ...row, run: { ...run, url: 'https://github.com:8443/actions/runs/42' } },
      { ...row, link: 'https://user:secret@github.com/example/demo' },
      { ...row, run: { ...run, status: '' } },
      { ...row, run: { ...run, workflow: '' } },
      { ...row, run: { ...run, branch: '' } },
      { ...row, displayName: '\u200b' },
      { ...row, freshness: 'fresh', checkedAt: null },
      { ...row, freshness: 'unchecked' },
      { ...row, freshness: 'fresh', run: null },
      { ...row, freshness: 'fresh', openPrs: null },
      { ...row, freshness: 'fresh', error: 'HTTP 500' },
      { ...row, freshness: 'stale', checkedAt: null },
      { ...row, freshness: 'unavailable', checkedAt: '2026-01-01T00:06:00.000Z', run: null },
      { ...row, freshness: 'unavailable', checkedAt: null, run: null },
      { ...row, freshness: 'unavailable', checkedAt: null, error: null },
      // Each round-4 guard is discriminated alone: only the counts, run,
      // attempt-stamp or unchecked-data condition rejects these.
      { ...row, freshness: 'unavailable', checkedAt: null, run: null, error: 'HTTP 500' },
      { ...row, freshness: 'unavailable', checkedAt: null, openPrs: null, openIssues: null, run, error: 'HTTP 500' },
      { ...row, freshness: 'fresh', lastAttemptAt: null },
      { ...row, freshness: 'stale', lastAttemptAt: null },
      { ...row, freshness: 'unavailable', checkedAt: null, run: null, error: 'HTTP 500', lastAttemptAt: null },
      // Only the attempt-stamp guard rejects this one (counts/run/error
      // are all coherent).
      { ...row, freshness: 'unavailable', checkedAt: null, openPrs: null, openIssues: null, run: null, error: 'HTTP 500', lastAttemptAt: null },
      { ...row, linkReason: '' },
      { ...row, error: '' },
      { ...unlinked, openPrs: 2 },
      { ...unlinked, run },
      // unchecked must not carry observed data (only the data guard rejects).
      { ...row, freshness: 'unchecked', checkedAt: null, lastAttemptAt: null, run: null, error: null, openPrs: 2 },
      // An unlinked row is always never-observed.
      { ...unlinked, freshness: 'unavailable', error: 'HTTP 500', lastAttemptAt: '2026-01-01T00:06:00.000Z' },
    ]) {
      expect(
        isValidSnapshot({ ...snapshot(), repoOverview: { rows: [broken] } } as unknown),
        JSON.stringify(broken),
      ).toBe(false);
    }
    expect(isValidSnapshot({ ...snapshot(), repoOverview: { rows: 'nope' } } as unknown)).toBe(false);
    expect(isValidSnapshot({ ...snapshot(), repoOverview: { rows: [null] } } as unknown)).toBe(false);
  });

  it('activeDecisions (issue #218): absent/null tolerated, well-formed accepted, malformed rejected', () => {
    expect(isValidSnapshot(snapshot())).toBe(true);
    const nullDecisions = { ...snapshot(), activeDecisions: null, activeDecisionCount: null } as unknown;
    expect(isValidSnapshot(nullDecisions)).toBe(true);

    const decision = {
      id: 'd-1',
      subject: 'pr:example/repo#148',
      decision: 'hold',
      by: 'gru',
      recheckAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    expect(
      isValidSnapshot({ ...snapshot(), activeDecisions: [decision], activeDecisionCount: 1 } as unknown),
    ).toBe(true);

    // A malformed decision row must fail the whole snapshot: the board
    // client discards unparseable frames, so bad rows must never slip in.
    for (const broken of [
      { ...decision, id: '' },
      { ...decision, subject: 7 },
      { ...decision, decision: '' },
      { ...decision, by: null },
      { ...decision, recheckAt: 12 },
      { ...decision, createdAt: '' },
    ]) {
      expect(
        isValidSnapshot({ ...snapshot(), activeDecisions: [broken], activeDecisionCount: 1 } as unknown),
        JSON.stringify(broken),
      ).toBe(false);
    }
    expect(isValidSnapshot({ ...snapshot(), activeDecisions: { not: 'an array' } } as unknown)).toBe(false);
    expect(isValidSnapshot({ ...snapshot(), activeDecisionCount: 1.5 } as unknown)).toBe(false);
    expect(isValidSnapshot({ ...snapshot(), activeDecisionCount: -1 } as unknown)).toBe(false);
    expect(isValidSnapshot({ ...snapshot(), activeDecisionCount: 'many' } as unknown)).toBe(false);
  });

  it('accepts prState present, null, or absent; rejects junk states', () => {
    for (const prState of ['open', 'conflicting', 'merged', null, undefined]) {
      const candidate = snapshot();
      (candidate.repos[0]!.jobs[0] as unknown as { prState: unknown }).prState = prState;
      expect(isValidSnapshot(candidate), String(prState)).toBe(true);
    }
    const junk = snapshot();
    (junk.repos[0]!.jobs[0] as unknown as { prState: unknown }).prState = 'draft';
    expect(isValidSnapshot(junk)).toBe(false);
  });

  it('accepts the needs-owner routing (the human-attention class) and still rejects unknowns', () => {
    const row: NotificationView = {
      id: 'n-owner',
      ts: '2026-09-23T00:00:00.000Z',
      kind: 'owner.request',
      routing: 'needs-owner',
      severity: 'info',
      title: 'Needs the owner',
      detail: null,
      agentId: null,
      shownAt: null,
      ackedAt: null,
      resolvedAt: null,
      resolvedBy: null,
    };
    const valid = snapshot();
    (valid.notifications as NotificationView[]).push(row);
    expect(isValidSnapshot(valid)).toBe(true);

    const unknown = snapshot();
    (unknown.notifications as unknown[]).push({ ...row, id: 'n-unknown', routing: 'mystery' });
    expect(isValidSnapshot(unknown)).toBe(false);
  });

  it('classifies only done+canonical-notused records as unused — no prose downgrade', () => {
    // The canonical record: done + the lead's not-used note.
    expect(lensChipState({ state: 'done', note: 'not used — lead-owned whole-PR review' })).toBe('unused');
    expect(lensChipState({ state: 'done', note: 'not used' })).toBe('unused');
    // Backward compatibility: a done record without the canonical note is a pass.
    expect(lensChipState({ state: 'done', note: null })).toBe('done');
    expect(lensChipState({ state: 'done', note: 'clean — nothing found' })).toBe('done');
    // Words that merely appear in prose are not authority.
    expect(lensChipState({ state: 'done', note: 'clean — lead said not used' })).toBe('done');
    expect(lensChipState({ state: 'pending', note: 'not used — lead-owned whole-PR review' })).toBe('pending');
    expect(lensChipState({ state: 'live', note: 'not used' })).toBe('live');
    expect(lensChipState({ state: 'error', note: 'not used — provider cap' })).toBe('error');
    // Unknown state drift passes through so the defensive rendering still applies.
    expect(lensChipState({ state: 'mystery', note: null })).toBe('mystery');
  });

  it('raw unused state strings never collide with the derived unused classification', () => {
    // Schema drift: a raw record carrying the state string 'unused' is not
    // canonical — only done + the canonical note classifies as unused.
    expect(lensChipState({ state: 'unused', note: null })).toBe('unrecognized');
    expect(lensChipState({ state: 'unused', note: 'not used — prose' })).toBe('unrecognized');
    // Both drift variants keep the old defensive unknown face: '?' label
    // slot (unrecognized is not in LENS_STATE_LABEL) and the park tone —
    // never the derived unused class or the '—' marker.
    expect(lensChipTone(lensChipState({ state: 'unused', note: null }))).toBe('pp-chip--park');
    expect(lensChipTone(lensChipState({ state: 'unused', note: 'not used — prose' }))).toBe('pp-chip--park');
    expect(lensChipTone(lensChipState({ state: 'unused', note: null }))).not.toBe('pp-chip--unused');
    // Other unknown states still pass through untouched (existing behavior).
    expect(lensChipState({ state: 'mystery', note: 'not used' })).toBe('mystery');
  });

  it('tone mapping covers every chip state with a design-token class', () => {
    expect(lensChipTone('live')).toContain('work');
    expect(lensChipTone('done')).toContain('done');
    expect(lensChipTone('unused')).toBe('pp-chip--unused');
    expect(lensChipTone('unused')).not.toContain('done');
    expect(lensChipTone('error')).toContain('alert');
    expect(lensChipTone('pending')).toContain('park');
    expect(lensChipTone('anything-else')).toContain('park');
    expect(jobChipTone('in-review')).toContain('rev');
    expect(jobChipTone('merged')).toContain('done');
    expect(jobChipTone('blocked')).toContain('alert');
    expect(jobChipTone('delivered')).toContain('work');
    expect(jobChipTone('working')).toContain('work');
    expect(jobChipTone('parked')).toContain('park');
    expect(agentStateTone('streaming')).toContain('work');
    expect(agentStateTone('error')).toContain('alert');
  });
});

describe('provider pacing mirror (server parity)', () => {
  /** A valid snapshot carrying the mirrored pacing gate block. */
  function pacingSnapshot(): Record<string, unknown> {
    return {
      ...snapshot(),
      pacing: {
        enabled: true,
        worker: {
          limit: 3,
          running: 1,
          queued: [
            {
              id: 'job-2',
              kind: 'worker',
              label: 'Job 2',
              queuedAt: '2026-01-01T00:00:01.000Z',
              reason: 'queued: 1/3 minion turns running (pacing.max_concurrent_minions)',
            },
          ],
        },
        review: { limit: 0, running: 0, queued: [] },
      },
    };
  }

  it('accepts a valid pacing gate block (queued lanes and honest reasons survive the mirror)', () => {
    const valid = pacingSnapshot();
    expect(isValidSnapshot(valid)).toBe(true);
    expect(parseBoardServerFrame({ type: 'board', snapshot: valid })).not.toBeNull();
  });

  it('rejects a malformed pacing block like every other v4 health read', () => {
    const badKind = pacingSnapshot();
    const kindEntry = (badKind.pacing as { worker: { queued: Record<string, unknown>[] } }).worker.queued[0]!;
    kindEntry.kind = 'nope';
    expect(isValidSnapshot(badKind)).toBe(false);

    const badReason = pacingSnapshot();
    const reasonEntry = (badReason.pacing as { worker: { queued: Record<string, unknown>[] } }).worker.queued[0]!;
    reasonEntry.reason = 42;
    expect(isValidSnapshot(badReason)).toBe(false);

    const badLimit = pacingSnapshot();
    (badLimit.pacing as { review: { limit: number } }).review.limit = -1;
    expect(isValidSnapshot(badLimit)).toBe(false);

    const badQueued = pacingSnapshot();
    (badQueued.pacing as { worker: { queued: unknown } }).worker.queued = 'nope';
    expect(isValidSnapshot(badQueued)).toBe(false);
  });
});

describe('lesson proposal review validator', () => {
  it('an INDEX change must have a side — a both-null entry is refused, one side passes', () => {
    const review = (entry: unknown) => ({
      id: 'prop-1',
      createdAt: '2026-10-07T00:00:00.000Z',
      notificationId: 'lp-1',
      entries: 1,
      throughSeq: 1,
      decision: null,
      recovery: null,
      chapters: [],
      index: [entry],
    });
    expect(isValidLessonProposal(review({ slug: 'ops', before: null, after: null }))).toBe(false);
    expect(isValidLessonProposal(review({ slug: 'ops', before: null, after: { summary: 'S.', tags: [] } }))).toBe(true);
  });
});
