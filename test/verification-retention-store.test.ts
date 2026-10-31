import { describe, expect, it } from 'vitest';
import {
  OutputRetention,
  RETAINED_OUTPUT_PER_RUN_MAX_BYTES,
  RETAINED_OUTPUT_TOTAL_MAX_BYTES,
  RETAINED_OUTPUT_WINDOW_MS,
  type RetainedOutputFrame,
} from '../src/verify/output-retention.js';
import type { VerificationOutcome } from '../src/verify/scheduler.js';

/**
 * Retained-output store (issue #554), the pure half: the per-run and total
 * caps, the 30-minute completion window on an injected clock, and the
 * `complete`/`incomplete`/`none` answer a replay is built from. The scheduler
 * integration is covered by the heavy retention suite.
 */

function frame(runId: string, text: string, stream: 'stdout' | 'stderr' = 'stdout'): RetainedOutputFrame {
  return { type: 'output', runId, stream, text };
}

function outcome(runId: string, outputText: string): VerificationOutcome {
  return {
    runId,
    jobId: 'job-retention',
    scope: 'full',
    command: 'node -e "process.exit(0)"',
    cwd: '/tmp/lane',
    ok: true,
    exitCode: 0,
    signal: null,
    timedOut: false,
    queuedMs: 0,
    durationMs: 1,
    sha: 'a'.repeat(40),
    trackedDirty: false,
    workers: 1,
    outputBytes: Buffer.byteLength(outputText),
    outputSha256: 'b'.repeat(64),
    outputTail: outputText,
    error: null,
  };
}

function store(options: { now?: () => number; perRunMaxBytes?: number; totalMaxBytes?: number } = {}) {
  let clock = 1_000;
  return {
    retention: new OutputRetention({
      now: options.now ?? (() => clock),
      ...(options.perRunMaxBytes === undefined ? {} : { perRunMaxBytes: options.perRunMaxBytes }),
      ...(options.totalMaxBytes === undefined ? {} : { totalMaxBytes: options.totalMaxBytes }),
    }),
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('retained output store (issue #554)', () => {
  it('pins the approved bounds: 30 minutes, 8 MiB per run, 64 MiB across runs', () => {
    expect(RETAINED_OUTPUT_WINDOW_MS).toBe(30 * 60 * 1000);
    expect(RETAINED_OUTPUT_PER_RUN_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(RETAINED_OUTPUT_TOTAL_MAX_BYTES).toBe(64 * 1024 * 1024);
    // A per-run cap above the total cap could never be honoured.
    expect(() => new OutputRetention({ now: () => 0, perRunMaxBytes: 30, totalMaxBytes: 10 })).toThrow(
      /per-run cap 30 exceeds the total cap 10/u,
    );
    expect(() => new OutputRetention({ now: () => 0, windowMs: 0 })).toThrow(/windowMs/u);
  });

  it('retains a running run from the first byte and snapshots the replay', () => {
    const { retention } = store();
    retention.retain(frame('run-a', 'first\n'));
    retention.retain(frame('run-a', 'second\n', 'stderr'));
    expect(retention.bytes).toBe(13);
    const replay = retention.replay('run-a');
    expect(replay.replayed).toBe('complete');
    expect(replay.frames.map((entry) => entry.text)).toEqual(['first\n', 'second\n']);
    // The replay is a snapshot: frames streamed after it are live frames, so
    // re-sending them from the snapshot would duplicate them.
    retention.retain(frame('run-a', 'third\n'));
    expect(replay.frames.map((entry) => entry.text)).toEqual(['first\n', 'second\n']);
    expect(retention.replay('run-a').frames).toHaveLength(3);
    // Nothing was retained under another identity.
    expect(retention.replay('run-other').replayed).toBe('none');
  });

  it('stops at the per-run cap and reports the replay incomplete', () => {
    const { retention } = store({ perRunMaxBytes: 10, totalMaxBytes: 100 });
    retention.retain(frame('run-cap', 'aaaaa'));
    retention.retain(frame('run-cap', 'bbbbb'));
    retention.retain(frame('run-cap', 'ccccc'));
    const replay = retention.replay('run-cap');
    expect(replay.replayed).toBe('incomplete');
    expect(replay.frames.map((entry) => entry.text)).toEqual(['aaaaa', 'bbbbb']);
    expect(retention.bytes).toBe(10);
  });

  it('keeps completed output exactly through the 30-minute window on the injected clock', () => {
    const { retention, advance } = store();
    retention.retain(frame('run-window', 'kept\n'));
    retention.complete('run-window', outcome('run-window', 'kept\n'));
    advance(RETAINED_OUTPUT_WINDOW_MS);
    expect(retention.replay('run-window').replayed).toBe('complete');
    expect(retention.recordedOutcome('run-window')?.runId).toBe('run-window');
    advance(1);
    expect(retention.replay('run-window')).toEqual({ frames: [], replayed: 'none' });
    expect(retention.recordedOutcome('run-window')).toBeNull();
    expect(retention.bytes).toBe(0);
  });

  it('evicts the oldest completed output first under total-cap pressure', () => {
    const { retention } = store({ perRunMaxBytes: 10, totalMaxBytes: 20 });
    retention.retain(frame('run-old', 'aaaaaaaaaa'));
    retention.complete('run-old', outcome('run-old', 'aaaaaaaaaa'));
    retention.retain(frame('run-mid', 'bbbbbbbbbb'));
    retention.complete('run-mid', outcome('run-mid', 'bbbbbbbbbb'));
    retention.retain(frame('run-new', 'cccccccccc'));
    retention.complete('run-new', outcome('run-new', 'cccccccccc'));
    // 30 bytes across three runs against a 20-byte cap: the oldest is gone.
    expect(retention.bytes).toBe(20);
    expect(retention.replay('run-old')).toEqual({ frames: [], replayed: 'none' });
    expect(retention.replay('run-mid').replayed).toBe('complete');
    expect(retention.replay('run-new').replayed).toBe('complete');
  });

  it('clears a live run prefix under pressure but never reports it as none', () => {
    const { retention } = store({ perRunMaxBytes: 10, totalMaxBytes: 20 });
    retention.retain(frame('run-live', 'llllllllll'));
    retention.retain(frame('run-done', 'dddddddddd'));
    retention.complete('run-done', outcome('run-done', 'dddddddddd'));
    retention.retain(frame('run-next', 'nnnnnnnnnn'));
    retention.complete('run-next', outcome('run-next', 'nnnnnnnnnn'));
    // The live run is the oldest: its prefix is dropped, but an attach must
    // learn that output is MISSING, not that nothing was ever produced.
    expect(retention.replay('run-live')).toEqual({ frames: [], replayed: 'incomplete' });
    retention.retain(frame('run-live', 'late'));
    expect(retention.replay('run-live')).toEqual({ frames: [], replayed: 'incomplete' });
  });

  it('replays a completed run with no output as a complete zero-byte capture, and discards a run that never settled', () => {
    const { retention } = store();
    retention.complete('run-silent', outcome('run-silent', ''));
    expect(retention.replay('run-silent').replayed).toBe('complete');
    expect(retention.replay('run-silent').frames).toEqual([]);
    expect(retention.recordedOutcome('run-silent')?.outputBytes).toBe(0);
    retention.retain(frame('run-aborted', 'partial\n'));
    expect(retention.bytes).toBe(8);
    retention.discard('run-aborted');
    expect(retention.bytes).toBe(0);
    expect(retention.replay('run-aborted').replayed).toBe('none');
    expect(retention.recordedOutcome('run-aborted')).toBeNull();
    retention.discard('run-never-seen');
  });
});
