import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  CorruptRollRecordError,
  clearRollMarker,
  readRollMarker,
  readRollState,
  rollMarkerPath,
  rollStatePath,
  updateRollState,
  writeRollMarker,
  writeRollState,
  type RollState,
} from '../src/roll/state.js';
import { adoptRollMarker, reconcileStaleRoll } from '../src/roll/adopt.js';

/**
 * Self-roll record IO + boot adoption: atomic state/marker persistence,
 * corrupt-record honesty, and the swap-marker adopt/clear contract (the
 * relaunched process consumes the marker, marks the record done, and
 * leaves the next boot clean).
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function sampleState(_dataDir: string): RollState {
  return {
    schemaVersion: 1,
    rollId: 'roll-fixture-1',
    phase: 'swap',
    reason: 'fixture',
    requestedBy: 'test',
    repoRoot: '/fixture/repo',
    fromSha: 'a'.repeat(40),
    toSha: 'b'.repeat(40),
    startedAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
    preflight: null,
    drain: null,
    error: null,
    verify: null,
  };
}

describe('roll state records', () => {
  it('state round-trips through disk and updates atomically with a fresh updatedAt', () => {
    const dir = tempDir('gru-command-roll-state-');
    const state = sampleState(dir);
    writeRollState(dir, state);
    expect(readRollState(dir)).toEqual(state);
    const next = updateRollState(dir, state, { phase: 'done' }, () => Date.parse('2026-09-23T01:02:03.000Z'));
    expect(next.phase).toBe('done');
    expect(next.updatedAt).toBe('2026-09-23T01:02:03.000Z');
    expect(readRollState(dir)?.phase).toBe('done');
    // Atomic writes leave no staging litter behind.
    expect(readdirSync(dir).filter((name) => name.includes('.tmp-'))).toEqual([]);
  });

  it('a missing record reads as null; a corrupt record throws (never guessed)', () => {
    const dir = tempDir('gru-command-roll-state-corrupt-');
    expect(readRollState(dir)).toBeNull();
    writeFileSync(rollStatePath(dir), '{not json', 'utf-8');
    expect(() => readRollState(dir)).toThrow(CorruptRollRecordError);
    writeFileSync(rollStatePath(dir), JSON.stringify({ schemaVersion: 99, rollId: 'x', phase: 'nope' }), 'utf-8');
    expect(() => readRollState(dir)).toThrow(CorruptRollRecordError);
  });

  it('marker round-trips, clears idempotently, and rejects corrupt content loudly', () => {
    const dir = tempDir('gru-command-roll-marker-');
    expect(readRollMarker(dir)).toBeNull();
    const marker = {
      schemaVersion: 1,
      rollId: 'roll-fixture-1',
      fromSha: 'a'.repeat(40),
      toSha: 'b'.repeat(40),
      markedAt: '2026-09-23T00:00:05.000Z',
      reason: null,
      requestedBy: 'test',
    };
    writeRollMarker(dir, marker);
    expect(readRollMarker(dir)).toEqual(marker);
    clearRollMarker(dir);
    clearRollMarker(dir); // idempotent
    expect(readRollMarker(dir)).toBeNull();
    writeFileSync(rollMarkerPath(dir), 'garbage', 'utf-8');
    expect(() => readRollMarker(dir)).toThrow(CorruptRollRecordError);
  });
});

describe('boot-time marker adoption', () => {
  it('adopts a swap marker: logs "rolled to", flips the record done, clears the marker', () => {
    const dir = tempDir('gru-command-roll-adopt-');
    const state = sampleState(dir);
    writeRollState(dir, state);
    writeRollMarker(dir, {
      schemaVersion: 1,
      rollId: state.rollId,
      fromSha: state.fromSha ?? 'a'.repeat(40),
      toSha: state.toSha ?? 'b'.repeat(40),
      markedAt: '2026-09-23T00:00:05.000Z',
      reason: 'graduate',
      requestedBy: 'cli',
    });
    const logs: string[] = [];
    const adopted = adoptRollMarker({
      dataDir: dir,
      runningSha: state.toSha,
      now: () => Date.parse('2026-09-23T00:10:00.000Z'),
      log: (level, msg) => logs.push(`${level}:${msg}`),
    });
    expect(adopted.marker?.toSha).toBe(state.toSha);
    expect(adopted.corrupt).toBe(false);
    expect(logs.some((line) => line === `info:rolled to ${state.toSha}`)).toBe(true);
    expect(readRollMarker(dir)).toBeNull();
    const record = readRollState(dir);
    expect(record?.phase).toBe('done');
    expect(record?.verify).toEqual({
      at: '2026-09-23T00:10:00.000Z',
      sha: state.toSha,
      pid: process.pid,
      uptimeMs: 0,
    });
  });

  it('is a no-op when no marker exists', () => {
    const dir = tempDir('gru-command-roll-adopt-none-');
    const logs: string[] = [];
    const adopted = adoptRollMarker({ dataDir: dir, runningSha: null, log: (_l, msg) => logs.push(msg) });
    expect(adopted).toEqual({ marker: null, corrupt: false });
    expect(logs).toEqual([]);
  });

  it('a corrupt marker is moved aside, reported, and never blocks boot', () => {
    const dir = tempDir('gru-command-roll-adopt-corrupt-');
    writeFileSync(rollMarkerPath(dir), 'not json at all', 'utf-8');
    const logs: string[] = [];
    const adopted = adoptRollMarker({
      dataDir: dir,
      runningSha: null,
      now: () => 1234,
      log: (level, msg) => logs.push(`${level}:${msg}`),
    });
    expect(adopted.marker).toBeNull();
    expect(adopted.corrupt).toBe(true);
    expect(logs.some((line) => line.startsWith('error:roll marker is corrupt'))).toBe(true);
    expect(existsSync(`${rollMarkerPath(dir)}.corrupt-1234`)).toBe(true);
    expect(existsSync(rollMarkerPath(dir))).toBe(false);
  });

  it('reconciles a mid-roll restart to failed — a stale record never reads as live', () => {
    const dir = tempDir('gru-command-roll-reconcile-');
    writeRollState(dir, { ...sampleState(dir), phase: 'drain' });
    const logs: string[] = [];
    const next = reconcileStaleRoll({ dataDir: dir, now: () => 1234, log: (_l, msg) => logs.push(msg) });
    expect(next?.phase).toBe('failed');
    expect(next?.error?.phase).toBe('drain');
    expect(next?.error?.detail).toContain('restarted before the roll completed');
    expect(logs).toContain('stale roll record reconciled to failed');
    // Terminal records and absent records are left alone.
    expect(reconcileStaleRoll({ dataDir: dir })).toBeNull();
    const empty = tempDir('gru-command-roll-reconcile-none-');
    expect(reconcileStaleRoll({ dataDir: empty })).toBeNull();
  });
});


