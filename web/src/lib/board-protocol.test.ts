import { describe, expect, it } from 'vitest';
import {
  agentStateTone,
  isValidSnapshot,
  jobChipTone,
  lensChipTone,
  parseBoardServerFrame,
  type BoardSnapshot,
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
            baseBranch: null,
            note: null,
            rounds: [
              {
                id: 'job-1-r1',
                seq: 1,
                status: 'live',
                verdict: null,
                targetRef: null,
                updatedAt: '2026-01-01T00:00:00.000Z',
                lenses: [
                  { lens: 'blind', state: 'done', agentId: 'a1', note: null },
                  { lens: 'edge', state: 'error', agentId: 'a2', note: 'cap' },
                ],
              },
            ],
          },
        ],
      },
    ],
    agents: [
      { id: 'gru-1', role: 'gru', label: 'gru', state: 'idle', lastActivity: null, sessionFile: null, jobId: null, roundId: null },
    ],
    notifications: [],
  };
}

describe('board server-frame validator', () => {
  it('accepts auth_ok, snapshot, and error frames', () => {
    expect(parseBoardServerFrame({ type: 'auth_ok' })).toEqual({ type: 'auth_ok' });
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
    const empty: Record<string, unknown> = {};
    expect(isValidSnapshot(empty)).toBe(false);
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
    expect(agentStateTone('streaming')).toContain('work');
    expect(agentStateTone('error')).toContain('alert');
  });
});
