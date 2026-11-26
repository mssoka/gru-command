import { describe, expect, it } from 'vitest';
import type { BuildView } from './board-protocol.js';
import {
  UPDATE_IDLE,
  followRoll,
  lostContact,
  parseRollReply,
  parseRollView,
  updateControl,
  type RollView,
  type UpdateFollow,
} from './board-update.js';

/**
 * The board's Update button (owner request 2026-11-26): when it is offered,
 * what the deploy reading says at each step of the update, and how a read
 * of the service's update record moves the follow along.
 */

function build(overrides: Partial<BuildView> = {}): BuildView {
  return {
    buildRev: 'a'.repeat(40),
    buildCommittedAt: '2026-11-24T00:00:00.000Z',
    originMainRev: 'b'.repeat(40),
    originMainCommittedAt: '2026-11-26T00:00:00.000Z',
    commitsBehind: 2,
    latestTag: null,
    buildTag: null,
    updateAvailable: null,
    checkedAt: '2026-11-26T00:00:00.000Z',
    checkError: null,
    ...overrides,
  };
}

function roll(phase: RollView['phase'], rollId = 'roll-new', error: RollView['error'] = null): RollView {
  return { rollId, phase, toSha: 'b'.repeat(40), error };
}

const STARTING: UpdateFollow = { step: 'starting', previousRollId: 'roll-old' };

describe('board update button: when it is offered', () => {
  it('offers Update whenever the deploy reading flags, and never on a current or unknown build', () => {
    expect(updateControl(UPDATE_IDLE, build())).toEqual({ offer: true, status: null, tone: null });
    expect(updateControl(UPDATE_IDLE, build({ commitsBehind: 0, updateAvailable: true, latestTag: 'v1.0.3' })).offer).toBe(true);
    expect(updateControl(UPDATE_IDLE, build({ commitsBehind: 0 })).offer).toBe(false);
    expect(updateControl(UPDATE_IDLE, build({ commitsBehind: null })).offer).toBe(false);
    expect(updateControl(UPDATE_IDLE, null).offer).toBe(false);
  });

  it('hides the button while an update runs, and offers it again beside the reason when one fails', () => {
    const behind = build();
    expect(updateControl(STARTING, behind)).toEqual({ offer: false, status: 'updating…', tone: 'work' });
    const preflight = followRoll(STARTING, roll('preflight'));
    expect(updateControl(preflight, behind)).toEqual({ offer: false, status: 'updating: pulling and building…', tone: 'work' });
    for (const phase of ['drain', 'swap', 'verify'] as const) {
      expect(updateControl(followRoll(preflight, roll(phase)), behind).status).toBe('restarting…');
    }
    expect(updateControl(lostContact(preflight), behind).status).toBe('restarting — waiting for the service…');
    expect(updateControl(followRoll(preflight, roll('done')), behind)).toEqual({ offer: false, status: 'updated — reloading…', tone: 'work' });
    const failed = followRoll(preflight, roll('failed', 'roll-new', { phase: 'preflight', detail: 'npm run build failed: exit code 2' }));
    expect(updateControl(failed, behind)).toEqual({ offer: true, status: 'update failed: npm run build failed: exit code 2', tone: 'alert' });
    // A failure on a build that is current again offers nothing new.
    expect(updateControl(failed, build({ commitsBehind: 0 })).offer).toBe(false);
  });
});

describe('board update button: following the update record', () => {
  it('follows its own update to done, through a lost contact (the restart)', () => {
    let follow = followRoll(STARTING, roll('preflight'));
    expect(follow).toEqual({ step: 'running', rollId: 'roll-new', previousRollId: 'roll-old', phase: 'preflight', lostContact: false });
    follow = followRoll(follow, roll('swap'));
    follow = lostContact(follow);
    expect(follow).toEqual({ step: 'running', rollId: 'roll-new', previousRollId: 'roll-old', phase: 'swap', lostContact: true });
    follow = followRoll(follow, roll('done'));
    expect(follow).toEqual({ step: 'done', rollId: 'roll-new' });
  });

  it('never takes the record from before the press for its own update', () => {
    // The POST got no answer: the page does not know its update yet.
    const unknown = lostContact(STARTING);
    expect(unknown).toEqual({ step: 'running', rollId: null, previousRollId: 'roll-old', phase: null, lostContact: true });
    // Last week's done (or failure) is no news.
    for (const old of [roll('done', 'roll-old'), roll('failed', 'roll-old', { phase: 'drain', detail: 'old failure' })]) {
      expect(followRoll(unknown, old)).toEqual({ step: 'running', rollId: null, previousRollId: 'roll-old', phase: null, lostContact: false });
    }
    // A new record is the update the service is doing now.
    expect(followRoll(unknown, roll('preflight', 'roll-new'))).toMatchObject({ step: 'running', rollId: 'roll-new', phase: 'preflight' });
    expect(followRoll(unknown, roll('failed', 'roll-new', { phase: 'preflight', detail: 'refusing to roll a dirty deploy clone' })))
      .toEqual({ step: 'failed', detail: 'refusing to roll a dirty deploy clone' });
    // No record at all yet keeps following.
    expect(followRoll(STARTING, null)).toEqual({ step: 'running', rollId: null, previousRollId: 'roll-old', phase: null, lostContact: false });
  });

  it('settled follows do not move, and a failure without a reason names its phase', () => {
    const done: UpdateFollow = { step: 'done', rollId: 'roll-new' };
    expect(followRoll(done, roll('preflight', 'roll-later'))).toBe(done);
    expect(lostContact(UPDATE_IDLE)).toBe(UPDATE_IDLE);
    const bare = { rollId: 'roll-new', phase: 'failed' as const, toSha: null, error: null };
    expect(followRoll(STARTING, bare)).toEqual({ step: 'failed', detail: 'the update stopped in an unknown phase' });
  });
});

describe('board update button: reading the update record', () => {
  it('reads the fields it needs from the service record and refuses a record it cannot read', () => {
    expect(parseRollReply({ roll: null })).toBeNull();
    expect(parseRollReply({})).toBeNull();
    const record = {
      schemaVersion: 1,
      rollId: 'roll-1',
      phase: 'failed',
      mode: 'update',
      now: true,
      toSha: null,
      error: { phase: 'preflight', detail: 'git fetch failed in the deploy clone' },
    };
    expect(parseRollReply({ roll: record })).toEqual({
      rollId: 'roll-1',
      phase: 'failed',
      toSha: null,
      error: { phase: 'preflight', detail: 'git fetch failed in the deploy clone' },
    });
    expect(() => parseRollReply([])).toThrow('the update reply is not an object');
    expect(() => parseRollView({ phase: 'done' })).toThrow('update record has no rollId');
    expect(() => parseRollView({ rollId: 'r', phase: 'rolling' })).toThrow('update record has an unknown phase: rolling');
    expect(() => parseRollView({ rollId: 'r', phase: 'done', toSha: 7 })).toThrow('update record toSha is not a string');
    expect(() => parseRollView({ rollId: 'r', phase: 'failed', toSha: null, error: { phase: 'swap' } })).toThrow('update record error is malformed');
  });
});
