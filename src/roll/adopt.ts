import { renameSync } from 'node:fs';
import type { LogLevel } from '../logger.js';
import {
  CorruptRollRecordError,
  clearRollMarker,
  readRollMarker,
  readRollState,
  rollMarkerPath,
  updateRollState,
  type RollMarker,
  type RollState,
} from './state.js';

/**
 * Boot-time swap adoption (graceful self-roll, phase d).
 *
 * The old process wrote `roll-marker.json` immediately before exiting for
 * relaunch. The new binary consumes it on boot: logs "rolled to <sha>",
 * flips the state record to done with the verify record (boot pid + build
 * sha), and clears the marker. Session adoption/resume is the existing
 * boot path (#42 cure) — the drain phase means no turn was mid-flight by
 * design; anything that slipped through still resumes under supervision.
 *
 * A corrupt marker never blocks boot: it is moved aside (`.corrupt-<ts>`)
 * and reported, so the operator sees it and the next boot is clean.
 */
export interface RollAdoption {
  readonly marker: RollMarker | null;
  readonly corrupt: boolean;
}

export function adoptRollMarker(opts: {
  readonly dataDir: string;
  readonly runningSha: string | null;
  readonly now?: () => number;
  readonly log?: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;
}): RollAdoption {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;
  let marker: RollMarker | null;
  try {
    marker = readRollMarker(opts.dataDir);
  } catch (error) {
    if (error instanceof CorruptRollRecordError) {
      const aside = `${rollMarkerPath(opts.dataDir)}.corrupt-${now()}`;
      try {
        renameSync(rollMarkerPath(opts.dataDir), aside);
      } catch {
        /* best effort — the warning below still stands */
      }
      log('error', 'roll marker is corrupt — moved aside, boot continues', {
        file: error.file,
        detail: error.detail,
        moved_to: aside,
      });
      return { marker: null, corrupt: true };
    }
    throw error;
  }
  if (marker === null) return { marker: null, corrupt: false };

  log('info', `rolled to ${marker.toSha}`, {
    roll_id: marker.rollId,
    from_sha: marker.fromSha,
    to_sha: marker.toSha,
    reason: marker.reason,
    requested_by: marker.requestedBy,
    marked_at: marker.markedAt,
  });
  try {
    const state = readRollState(opts.dataDir);
    if (state !== null && state.rollId === marker.rollId) {
      updateRollState(
        opts.dataDir,
        state,
        {
          phase: 'done',
          verify: {
            at: new Date(now()).toISOString(),
            sha: opts.runningSha,
            pid: process.pid,
            uptimeMs: 0,
          },
        },
        now,
      );
    } else if (state === null) {
      log('warn', 'roll state record missing at adoption — marker cleared, record not recreated', {
        roll_id: marker.rollId,
      });
    } else {
      log('warn', 'roll state record belongs to another roll — marker cleared without state update', {
        marker_roll: marker.rollId,
        state_roll: state.rollId,
      });
    }
  } catch (error) {
    log('warn', 'roll state update at adoption failed — marker still cleared', {
      roll_id: marker.rollId,
      error: String(error),
    });
  }
  clearRollMarker(opts.dataDir);
  return { marker, corrupt: false };
}

/**
 * Boot reconciliation for a record that never reached a swap (the service
 * restarted for another reason mid-roll): mark it failed with the phase it
 * stopped in, so GET /api/roll never reports a live roll that is not
 * running. Run AFTER adoptRollMarker — the swap case is adoption's, and an
 * adopted roll is already `done` here (a no-op). Missing/terminal/corrupt
 * records are left alone (corrupt is reported, never overwritten).
 */
export function reconcileStaleRoll(opts: {
  readonly dataDir: string;
  readonly now?: () => number;
  readonly log?: (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;
}): RollState | null {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? Date.now;
  let state: RollState | null;
  try {
    state = readRollState(opts.dataDir);
  } catch (error) {
    log('warn', 'roll record reconciliation skipped: record unreadable', { error: String(error) });
    return null;
  }
  if (state === null) return null;
  if (state.phase !== 'preflight' && state.phase !== 'drain' && state.phase !== 'swap') return null;
  const stoppedIn = state.phase;
  const next = updateRollState(
    opts.dataDir,
    state,
    {
      phase: 'failed',
      error: { phase: stoppedIn, detail: 'service restarted before the roll completed' },
    },
    now,
  );
  log('warn', 'stale roll record reconciled to failed', {
    roll_id: state.rollId,
    stopped_in: stoppedIn,
  });
  return next;
}
