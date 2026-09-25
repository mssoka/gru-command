import { describe, expect, it } from 'vitest';
import {
  agentStateTone,
  isValidSnapshot,
  jobChipTone,
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
      silas: { lastWakeAt: null, reconciliationsToday: 2, checkedAt: '2026-01-01T00:00:00.000Z' },
      verify: { lockInUse: true, activeRuns: 1, queuedRuns: 0, workerBudget: 8, workersPerRun: 4 },
      selfHeal: { sessionsResumed: 1, sessionsOrphaned: 0, since: null },
    } as unknown;
    expect(isValidSnapshot(wired)).toBe(true);

    // A present-but-malformed block is a server bug — reject loudly.
    for (const [field, broken] of [
      ['build', { ...(wired as { build: object }).build, commitsBehind: '43' }],
      ['silas', { ...(wired as { silas: object }).silas, reconciliationsToday: -1 }],
      ['verify', { ...(wired as { verify: object }).verify, lockInUse: 'yes' }],
      ['selfHeal', { ...(wired as { selfHeal: object }).selfHeal, sessionsResumed: 1.5 }],
    ] as const) {
      expect(isValidSnapshot({ ...(wired as object), [field]: broken }), field).toBe(false);
    }
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

  it('tone mapping covers every chip state with a design-token class', () => {
    expect(lensChipTone('live')).toContain('work');
    expect(lensChipTone('done')).toContain('done');
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
