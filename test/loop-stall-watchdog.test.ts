import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isMainThread } from 'node:worker_threads';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../src/events/bus.js';
import { LedgerApi } from '../src/ledger/api.js';
import { LedgerDb } from '../src/ledger/db.js';
import { NotificationCenter } from '../src/notifications/center.js';
import { Supervisor, type SupervisorRegistry } from '../src/supervision/supervisor.js';
import {
  classifyMainThread,
  describeStallEvidence,
  formatStallFrame,
  startLoopStallWatchdog,
  stallEvidenceFields,
  unknownStallEvidence,
  type LoopStallEvidence,
  type LoopStallEvidenceSource,
  type LoopStallWindow,
} from '../src/supervision/loop-stall-watchdog.js';

/**
 * Stall attribution: an event-loop stall record must name what the main
 * thread was doing. The first two tests block THIS process's main thread on
 * purpose, under a real watchdog thread and a real supervisor, and read the
 * record the supervisor writes.
 */

const cleanupDirs: string[] = [];
afterAll(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

interface LogLine {
  readonly level: string;
  readonly msg: string;
  readonly fields: Record<string, unknown>;
}

/** No agents: these tests are about the tick gap alone. */
const emptyRegistry: SupervisorRegistry = {
  onAgentEvent: () => () => {},
  getHandle: () => null,
  quarantineHandle: () => {},
  spawn: async () => {
    throw new Error('no agent is spawned in the stall tests');
  },
  disposeHandle: async () => {},
};

interface Harness {
  readonly api: LedgerApi;
  readonly logs: LogLine[];
  /** One supervisor tick, as its interval would run it. */
  tick(): void;
  /** Stand in for the rest of a two-minute stall: both clocks jump. */
  jumpTwoMinutes(): void;
  stallPayloads(): Record<string, unknown>[];
  dispose(): void;
}

function bootSupervisor(stallEvidence: LoopStallEvidenceSource | undefined, logs: LogLine[] = []): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'gc-loop-stall-'));
  cleanupDirs.push(dir);
  const db = new LedgerDb(dir);
  const bus = new EventBus();
  const api = new LedgerApi(db.handle, { bus });
  const notifications = new NotificationCenter({ ledger: api, bus });
  let skewMs = 0;
  const supervisor = new Supervisor({
    config: { enabled: true, turnSilenceMs: 60_000, restartWindowMs: 600_000, maxRestarts: 3, restartBackoffMs: 1 },
    registry: emptyRegistry,
    ledger: api,
    notifications,
    // The real clocks, so the watchdog's own wall-clock times fall inside
    // the gap; the skew is the part of the stall the test does not sit out.
    wallNow: () => Date.now() + skewMs,
    monotonicNow: () => performance.now() + skewMs,
    suspendEvidence: async () => false,
    log: (level, msg, fields) => logs.push({ level, msg, fields: fields ?? {} }),
    tickMs: 5,
    ...(stallEvidence !== undefined ? { stallEvidence } : {}),
  });
  return {
    api,
    logs,
    tick: () => (supervisor as unknown as { tick(): void }).tick(),
    jumpTwoMinutes: () => {
      skewMs += 120_000;
    },
    stallPayloads: () =>
      api
        .listEvents({ limit: 100 })
        .filter((event) => event.kind === 'supervision.loop-stall')
        .map((event) => event.payload as Record<string, unknown>),
    dispose: () => {
      supervisor.dispose();
      db.close();
    },
  };
}

/** A watchdog on test cadence. The first `evidence` answer proves its
 * thread is up, so the block that follows is watched from its first
 * millisecond. */
async function startWatchedWatchdog(logs: LogLine[]): Promise<LoopStallEvidenceSource> {
  const watchdog = startLoopStallWatchdog({
    heartbeatMs: 20,
    overdueMs: 200,
    recaptureMs: 60_000,
    collectTimeoutMs: 20_000,
    log: (level, msg, fields) => logs.push({ level, msg, fields: fields ?? {} }),
  });
  const before = await watchdog.evidence({ fromWallMs: Date.now() - 1, toWallMs: Date.now() });
  expect(before.note).not.toContain('did not answer');
  return watchdog;
}

function blockTheMainThreadInABusyLoop(ms: number): number {
  // Date.now is a native call: the loop itself is the innermost frame.
  const until = Date.now() + ms;
  let spins = 0;
  while (Date.now() < until) spins += 1;
  return spins;
}

function recurseThenBlock(depth: number, ms: number): number {
  return depth === 0 ? blockTheMainThreadInABusyLoop(ms) : recurseThenBlock(depth - 1, ms) + 1;
}

/** The shape of the service's own synchronous git calls. */
function blockTheMainThreadOnASyncChild(ms: number): string {
  return execFileSync(process.execPath, ['-e', `setTimeout(() => console.log('done'), ${ms})`], { encoding: 'utf8' });
}

interface StackField {
  readonly silent_ms: number;
  readonly pause_latency_ms: number;
  readonly frames: readonly string[];
}

const stacksOf = (payload: Record<string, unknown>): readonly StackField[] => payload['stacks'] as readonly StackField[];

describe('event-loop stall attribution', () => {
  it('a main thread blocked in JavaScript leaves a stall record naming the blocking function', async () => {
    expect(isMainThread, 'these tests block the process main thread; run them in the forks pool').toBe(true);
    const logs: LogLine[] = [];
    const watchdog = await startWatchedWatchdog(logs);
    const h = bootSupervisor(watchdog, logs);
    try {
      h.tick(); // the tick before the stall
      const stalledAt = Date.now();
      expect(blockTheMainThreadInABusyLoop(1_200)).toBeGreaterThan(0);
      h.jumpTwoMinutes();
      h.tick(); // the late tick that finds the gap
      await vi.waitFor(() => expect(h.stallPayloads()).toHaveLength(1), { timeout: 25_000 });

      const payload = h.stallPayloads()[0]!;
      expect(payload['gap_ms']).toBeGreaterThanOrEqual(120_000);
      expect(payload['main_thread']).toBe('running-javascript');
      expect(payload['silent_ms']).toBeGreaterThanOrEqual(1_200);
      // The loop was busy, not waiting, and the watchdog thread kept running.
      expect(payload['loop_active_ms']).toBeGreaterThanOrEqual(1_000);
      expect(payload['loop_idle_ms']).toBeLessThan(600);
      expect(payload['watchdog_lag_ms']).toBeLessThan(600);
      expect(payload['evidence_note']).toBeUndefined();
      const stacks = stacksOf(payload);
      expect(stacks.length).toBeGreaterThanOrEqual(1);
      expect(stacks.length).toBeLessThanOrEqual(3);
      const first = stacks[0]!;
      // The innermost frame is the loop itself, in this file, and nothing
      // in a frame is an absolute path.
      expect(first.frames[0]).toMatch(/^blockTheMainThreadInABusyLoop \(test\/loop-stall-watchdog\.test\.ts:\d+:\d+\)$/u);
      expect(first.silent_ms).toBeGreaterThanOrEqual(200);
      expect(first.pause_latency_ms).toBeLessThanOrEqual(1_000);
      expect(first.frames.length).toBeLessThanOrEqual(17);
      for (const frame of first.frames) {
        expect(frame.length).toBeLessThanOrEqual(200);
        expect(frame).not.toContain(process.cwd());
      }

      // The log line carries the same fields as the event.
      const stallLog = logs.find((line) => line.msg === 'event-loop stall detected');
      expect(stallLog?.level).toBe('warn');
      expect(stallLog?.fields).toEqual(payload);
      // The watchdog's own line for the silence, logged once.
      const silent = logs.filter((line) => line.msg === 'main thread went silent');
      expect(silent).toHaveLength(1);
      expect(silent[0]?.level).toBe('info');
      expect(silent[0]?.fields['main_thread']).toBe('running-javascript');
      expect(Date.parse(String(silent[0]?.fields['from']))).toBeLessThanOrEqual(stalledAt);

      // The hourly FYI says where.
      const fyi = h.api.listNotifications({ limit: 10 }).filter((note) => note.kind === 'supervision.loop-stall');
      expect(fyi).toHaveLength(1);
      expect(fyi[0]?.detail).toContain('Latest stall: The main thread was running JavaScript: blockTheMainThreadInABusyLoop (test/loop-stall-watchdog.test.ts:');
    } finally {
      h.dispose();
    }
  });

  it('a main thread blocked inside a synchronous child process is named by the function that started it', async () => {
    const logs: LogLine[] = [];
    const watchdog = await startWatchedWatchdog(logs);
    const h = bootSupervisor(watchdog, logs);
    try {
      h.tick();
      expect(blockTheMainThreadOnASyncChild(2_500)).toBe('done\n');
      h.jumpTwoMinutes();
      h.tick();
      await vi.waitFor(() => expect(h.stallPayloads()).toHaveLength(1), { timeout: 25_000 });

      const payload = h.stallPayloads()[0]!;
      // The pause could only be served once the child had exited.
      expect(payload['main_thread']).toBe('inside-native-call');
      const first = stacksOf(payload)[0]!;
      expect(first.pause_latency_ms).toBeGreaterThan(1_000);
      // JavaScript resumed inside Node's execFileSync, called from the blocker.
      expect(first.frames.some((frame) => frame.startsWith('execFileSync (node:child_process:'))).toBe(true);
      expect(first.frames.some((frame) => frame.startsWith('blockTheMainThreadOnASyncChild (test/loop-stall-watchdog.test.ts:'))).toBe(true);
      const fyi = h.api.listNotifications({ limit: 10 }).filter((note) => note.kind === 'supervision.loop-stall');
      expect(fyi[0]?.detail).toContain('Latest stall: The main thread was inside a call that could not be interrupted');
      expect(fyi[0]?.detail).toContain('JavaScript resumed at');
    } finally {
      h.dispose();
    }
  });

  it('a stall with no watchdog wired keeps the gap-only record', async () => {
    const h = bootSupervisor(undefined);
    try {
      h.tick();
      h.jumpTwoMinutes();
      h.tick();
      await vi.waitFor(() => expect(h.stallPayloads()).toHaveLength(1), { timeout: 5_000 });
      expect(Object.keys(h.stallPayloads()[0]!).sort()).toEqual(['gap_ms', 'monotonic_gap_ms']);
      const fyi = h.api.listNotifications({ limit: 10 }).filter((note) => note.kind === 'supervision.loop-stall');
      expect(fyi[0]?.detail).not.toContain('Latest stall');
    } finally {
      h.dispose();
    }
  });

  it('the supervisor asks for the gap between its two ticks, records what it is told, and survives a failing source', async () => {
    const idle: LoopStallEvidence = {
      mainThread: 'idle-in-poll',
      silentMs: 118_000,
      loopActiveMs: 40,
      loopIdleMs: 117_960,
      watchdogLagMs: 3,
      stacks: [{ silentMs: 10_004, pauseLatencyMs: 6, frames: ['processTimers (node:internal/timers:520:9)'] }],
      note: null,
    };
    const windows: LoopStallWindow[] = [];
    let disposed = 0;
    let fail = false;
    const source: LoopStallEvidenceSource = {
      evidence: async (window) => {
        windows.push(window);
        if (fail) throw new Error('watchdog exploded');
        return idle;
      },
      dispose: () => {
        disposed += 1;
      },
    };
    const h = bootSupervisor(source);
    try {
      const before = Date.now();
      h.tick();
      h.jumpTwoMinutes();
      h.tick();
      await vi.waitFor(() => expect(h.stallPayloads()).toHaveLength(1), { timeout: 5_000 });
      expect(windows).toHaveLength(1);
      expect(windows[0]!.fromWallMs).toBeGreaterThanOrEqual(before);
      expect(windows[0]!.toWallMs - windows[0]!.fromWallMs).toBeGreaterThanOrEqual(120_000);
      const recorded = h.stallPayloads()[0]!;
      expect(recorded).toMatchObject({
        main_thread: 'idle-in-poll',
        silent_ms: 118_000,
        loop_active_ms: 40,
        loop_idle_ms: 117_960,
        watchdog_lag_ms: 3,
        stacks: [{ silent_ms: 10_004, pause_latency_ms: 6, frames: ['processTimers (node:internal/timers:520:9)'] }],
      });
      const fyi = () => h.api.listNotifications({ limit: 10 }).filter((note) => note.kind === 'supervision.loop-stall');
      expect(fyi()[0]?.detail).toContain(
        'Latest stall: The main thread was idle in the event-loop poll for 118 s of 118 s: ' +
          'no code of this service was blocking it, its timers were not woken.',
      );

      // A source that throws is itself the evidence; the stall is still recorded.
      fail = true;
      h.jumpTwoMinutes();
      h.tick();
      await vi.waitFor(() => expect(h.stallPayloads()).toHaveLength(2), { timeout: 5_000 });
      const failed = h.stallPayloads().find((payload) => payload['main_thread'] === 'unknown');
      expect(failed?.['evidence_note']).toBe('the stall watchdog failed: Error: watchdog exploded');
      expect(failed?.['stacks']).toEqual([]);
      expect(fyi()).toHaveLength(1);
      expect(fyi()[0]?.title).toContain('stalled 2 times');
      expect(fyi()[0]?.detail).toContain('Latest stall: What blocked it is unknown: the stall watchdog failed: Error: watchdog exploded.');
    } finally {
      h.dispose();
    }
    expect(disposed).toBe(1);
  });

  it('a deep stack keeps its innermost and outermost frames around one marker', async () => {
    const watchdog = await startWatchedWatchdog([]);
    try {
      const from = Date.now();
      expect(recurseThenBlock(40, 800)).toBeGreaterThan(40);
      const evidence = await watchdog.evidence({ fromWallMs: from, toWallMs: Date.now() });
      const frames = evidence.stacks[0]!.frames;
      // Twelve innermost, the marker, four outermost.
      expect(frames).toHaveLength(17);
      expect(frames[0]).toMatch(/^blockTheMainThreadInABusyLoop \(/u);
      for (const frame of frames.slice(1, 12)) expect(frame).toMatch(/^recurseThenBlock \(/u);
      expect(frames[12]).toMatch(/^… \d+ frames omitted …$/u);
      // 41 recursion frames, the loop and this test's own frame, less the 16 kept.
      expect(Number(/\d+/u.exec(frames[12]!)?.[0])).toBeGreaterThanOrEqual(27);
      expect(frames.slice(13).every((frame) => !frame.startsWith('…'))).toBe(true);
    } finally {
      watchdog.dispose();
    }
  });

  it('a gap the watchdog saw no silence in says so instead of inventing a stack', async () => {
    const logs: LogLine[] = [];
    const watchdog = await startWatchedWatchdog(logs);
    try {
      const evidence = await watchdog.evidence({ fromWallMs: Date.now() - 50, toWallMs: Date.now() });
      expect(evidence).toEqual(unknownStallEvidence('the watchdog saw no heartbeat silence of 200 ms or more in this gap'));
      // Nothing is asked of a disposed watchdog.
      watchdog.dispose();
      expect((await watchdog.evidence({ fromWallMs: 0, toWallMs: Date.now() })).note).toBe('the watchdog is disposed');
    } finally {
      watchdog.dispose();
    }
  });
});

describe('stall evidence helpers', () => {
  it('classifies a silence by who else was not running, then by how the pause was served', () => {
    const cases: readonly [Parameters<typeof classifyMainThread>[0], ReturnType<typeof classifyMainThread>][] = [
      // The watchdog thread was late for most of it: nothing in the process ran.
      [{ silentMs: 60_000, watchdogLagMs: 59_000, loopIdleMs: 59_500, firstPauseLatencyMs: null }, 'process-not-running'],
      [{ silentMs: 60_000, watchdogLagMs: 30_000, loopIdleMs: 0, firstPauseLatencyMs: 4 }, 'process-not-running'],
      // The loop waited in the poll: a promptly served stack is not a cause.
      [{ silentMs: 60_000, watchdogLagMs: 10, loopIdleMs: 59_000, firstPauseLatencyMs: 4 }, 'idle-in-poll'],
      [{ silentMs: 60_000, watchdogLagMs: null, loopIdleMs: 30_000, firstPauseLatencyMs: null }, 'idle-in-poll'],
      // Busy loop: served at once, or only after an uninterruptible call.
      [{ silentMs: 60_000, watchdogLagMs: 10, loopIdleMs: 20, firstPauseLatencyMs: 4 }, 'running-javascript'],
      [{ silentMs: 60_000, watchdogLagMs: 10, loopIdleMs: 20, firstPauseLatencyMs: 1_000 }, 'running-javascript'],
      [{ silentMs: 60_000, watchdogLagMs: 10, loopIdleMs: 20, firstPauseLatencyMs: 1_001 }, 'inside-native-call'],
      [{ silentMs: 60_000, watchdogLagMs: 10, loopIdleMs: 20, firstPauseLatencyMs: 49_000 }, 'inside-native-call'],
      // No stack and a busy loop: nothing to say.
      [{ silentMs: 60_000, watchdogLagMs: 10, loopIdleMs: 20, firstPauseLatencyMs: null }, 'unknown'],
      [{ silentMs: 60_000, watchdogLagMs: null, loopIdleMs: null, firstPauseLatencyMs: null }, 'unknown'],
    ];
    for (const [input, expected] of cases) {
      expect(classifyMainThread(input), JSON.stringify(input)).toBe(expected);
    }
  });

  it('formats a frame as a function and a position that leaks no absolute path', () => {
    const root = '/opt/gru command';
    const frame = (functionName: string, url: string) => ({ functionName, url, line: 12, column: 7 });
    expect(formatStallFrame(frame('git', 'file:///opt/gru%20command/dist/worktrees/git.js'), root))
      .toBe('git (dist/worktrees/git.js:12:7)');
    expect(formatStallFrame(frame('git', '/opt/gru command/dist/worktrees/git.js'), `${root}/`))
      .toBe('git (dist/worktrees/git.js:12:7)');
    expect(formatStallFrame(frame('spawnSync', 'node:child_process'), root)).toBe('spawnSync (node:child_process:12:7)');
    expect(formatStallFrame(frame('', 'file:///Users/someone/elsewhere/tool/run.js'), root))
      .toBe('(anonymous) (…/tool/run.js:12:7)');
    expect(formatStallFrame(frame('evaluated', ''), root)).toBe('evaluated ((unknown script):12:7)');
    // A data: module's URL is its source text: only the scheme is kept.
    expect(formatStallFrame(frame('inline', 'data:text/javascript,const secret="hunter2"'), root))
      .toBe('inline ((data script):12:7)');
    expect(formatStallFrame(frame('remote', 'https://example.invalid/a/b.js?token=abc'), root))
      .toBe('remote ((https script):12:7)');
    expect(formatStallFrame(frame('vm', 'evalmachine.<anonymous>'), root)).toBe('vm (…/evalmachine.<anonymous>:12:7)');
    // A sibling directory that only shares the root's prefix is not inside it.
    expect(formatStallFrame(frame('f', '/opt/gru command-other/x/y.js'), root)).toBe('f (…/x/y.js:12:7)');
    expect(formatStallFrame(frame('n'.repeat(500), 'node:fs'), root)).toHaveLength(200);
  });

  it('renders the record fields and one sentence per kind of stall', () => {
    const base: LoopStallEvidence = {
      mainThread: 'running-javascript',
      silentMs: 61_000,
      loopActiveMs: 60_990,
      loopIdleMs: 10,
      watchdogLagMs: 2,
      stacks: [
        { silentMs: 10_001, pauseLatencyMs: 3, frames: ['a (dist/a.js:1:1)', 'b (dist/b.js:2:2)', 'c (dist/c.js:3:3)', 'd (dist/d.js:4:4)', 'e (dist/e.js:5:5)'] },
      ],
      note: null,
    };
    expect(stallEvidenceFields(base)).toEqual({
      main_thread: 'running-javascript',
      silent_ms: 61_000,
      loop_active_ms: 60_990,
      loop_idle_ms: 10,
      watchdog_lag_ms: 2,
      stacks: [{ silent_ms: 10_001, pause_latency_ms: 3, frames: base.stacks[0]!.frames }],
    });
    expect(stallEvidenceFields({ ...base, note: 'why' })['evidence_note']).toBe('why');
    // The sentence keeps the four innermost frames.
    expect(describeStallEvidence(base)).toBe(
      'The main thread was running JavaScript: a (dist/a.js:1:1) ← b (dist/b.js:2:2) ← c (dist/c.js:3:3) ← d (dist/d.js:4:4).',
    );
    expect(describeStallEvidence({ ...base, mainThread: 'inside-native-call' })).toBe(
      'The main thread was inside a call that could not be interrupted (a synchronous child process, database or file operation); ' +
        'JavaScript resumed at a (dist/a.js:1:1) ← b (dist/b.js:2:2) ← c (dist/c.js:3:3) ← d (dist/d.js:4:4).',
    );
    expect(describeStallEvidence({ ...base, mainThread: 'process-not-running', watchdogLagMs: 60_400, stacks: [] })).toBe(
      'The whole process was not running: the watchdog thread was 60 s late too.',
    );
    expect(describeStallEvidence({ ...base, mainThread: 'running-javascript', stacks: [] })).toBe(
      'The main thread was running JavaScript: no frames were captured.',
    );
    expect(describeStallEvidence(unknownStallEvidence('no stack: an inspector is attached to this process'))).toBe(
      'What blocked it is unknown: no stack: an inspector is attached to this process.',
    );
    expect(unknownStallEvidence('x'.repeat(900)).note).toHaveLength(300);
  });
});
