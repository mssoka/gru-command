import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import inspector from 'node:inspector';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
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
  silenceEvidence,
  startLoopStallWatchdog,
  stallEvidenceFields,
  unknownStallEvidence,
  type LoopStallEvidence,
  type LoopStallEvidenceSource,
  type LoopStallWindow,
  type SilenceFacts,
} from '../src/supervision/loop-stall-watchdog.js';
import type { WatchdogEpisode, WatchdogRawFrame } from '../src/supervision/loop-stall-watchdog-worker.js';

/**
 * Stall attribution: an event-loop stall record must name what the main
 * thread was doing. The first tests block THIS process's main thread on
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

const WATCHDOG_TEST_CADENCE = { heartbeatMs: 20, overdueMs: 200, recaptureMs: 60_000, collectTimeoutMs: 20_000 } as const;

/** A watchdog on test cadence. */
function startTestWatchdog(logs: LogLine[]): LoopStallEvidenceSource {
  return startLoopStallWatchdog({
    ...WATCHDOG_TEST_CADENCE,
    log: (level, msg, fields) => logs.push({ level, msg, fields: fields ?? {} }),
  });
}

/** Beat now and wait for the watchdog thread's answer. The answer proves the
 * thread is up, and the beat makes the watched silence start HERE — not at
 * whatever synchronous setup ran before. Call it right before blocking. */
async function beatAndSync(watchdog: LoopStallEvidenceSource): Promise<void> {
  const now = Date.now();
  const answer = await watchdog.evidence({ fromWallMs: now - 1, toWallMs: now });
  expect(answer.note ?? '').not.toContain('did not answer');
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
    const watchdog = startTestWatchdog(logs);
    const h = bootSupervisor(watchdog, logs);
    try {
      await beatAndSync(watchdog);
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
      // The loop was busy, not waiting, and it was burning CPU.
      expect(payload['loop_active_ms']).toBeGreaterThanOrEqual(1_000);
      expect(payload['cpu_ms']).toBeGreaterThanOrEqual(200);
      expect(typeof payload['watchdog_lag_ms']).toBe('number');
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
      // The watchdog's own line for the silence.
      const silent = logs.filter(
        (line) => line.msg === 'main thread went silent' && JSON.stringify(line.fields).includes('blockTheMainThreadInABusyLoop'),
      );
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
    const watchdog = startTestWatchdog(logs);
    const h = bootSupervisor(watchdog, logs);
    try {
      await beatAndSync(watchdog);
      h.tick();
      expect(blockTheMainThreadOnASyncChild(2_500)).toBe('done\n');
      h.jumpTwoMinutes();
      h.tick();
      await vi.waitFor(() => expect(h.stallPayloads()).toHaveLength(1), { timeout: 25_000 });

      const payload = h.stallPayloads()[0]!;
      // The pause could only be served once the child had exited.
      expect(payload['main_thread']).toBe('inside-native-call');
      // It was waiting, not computing.
      expect(payload['cpu_ms']).toBeLessThan(1_250);
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
      cpuMs: 12,
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
        cpu_ms: 12,
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
    const watchdog = startTestWatchdog([]);
    try {
      await beatAndSync(watchdog);
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

  it('asks for no stack while an inspector is attached, and again once it is gone', async () => {
    const watchdog = startTestWatchdog([]);
    try {
      await beatAndSync(watchdog);
      // A developer attaches after the service started.
      inspector.open(0, '127.0.0.1');
      try {
        await beatAndSync(watchdog); // the beat that tells the watchdog thread
        const from = Date.now();
        blockTheMainThreadInABusyLoop(800);
        const attached = await watchdog.evidence({ fromWallMs: from, toWallMs: Date.now() });
        // The silence is still measured; only the pause is withheld.
        expect(attached.stacks).toEqual([]);
        expect(attached.note).toContain('no stack: an inspector is attached to this process');
        expect(attached.mainThread).toBe('unknown');
        expect(attached.silentMs).toBeGreaterThanOrEqual(800);
      } finally {
        inspector.close();
      }
      await beatAndSync(watchdog);
      const from = Date.now();
      blockTheMainThreadInABusyLoop(800);
      const detached = await watchdog.evidence({ fromWallMs: from, toWallMs: Date.now() });
      expect(detached.stacks[0]?.frames[0]).toMatch(/^blockTheMainThreadInABusyLoop \(/u);
    } finally {
      watchdog.dispose();
    }
  });

  it('a live watchdog neither holds the process open nor leaves a debugger line at exit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gc-loop-stall-exit-'));
    cleanupDirs.push(dir);
    const script = join(dir, 'watched.mjs');
    const moduleUrl = new URL('../src/supervision/loop-stall-watchdog.ts', import.meta.url).href;
    writeFileSync(
      script,
      [
        `import { startLoopStallWatchdog } from ${JSON.stringify(moduleUrl)};`,
        `const watchdog = startLoopStallWatchdog(${JSON.stringify(WATCHDOG_TEST_CADENCE)});`,
        // The watchdog holds nothing open, so the script's own work does
        // (as the service's listeners do) until it is finished.
        'const work = setInterval(() => {}, 1_000);',
        'await watchdog.evidence({ fromWallMs: Date.now() - 1, toWallMs: Date.now() });',
        'function blockHere(ms) { const until = Date.now() + ms; while (Date.now() < until); }',
        'const from = Date.now();',
        'blockHere(800);',
        'const evidence = await watchdog.evidence({ fromWallMs: from, toWallMs: Date.now() });',
        'console.log(JSON.stringify({ mainThread: evidence.mainThread, top: evidence.stacks[0]?.frames[0] ?? null }));',
        // Never disposed: a crash path, or a caller that forgot.
        "if (process.env.WATCHED_EXIT === 'exit') process.exit(3);",
        'clearInterval(work);',
      ].join('\n'),
    );
    const run = (how: 'exit' | 'drain') =>
      spawnSync(process.execPath, [script], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, WATCHED_EXIT: how },
      });

    // The event loop drains with the watchdog thread still alive.
    const drained = run('drain');
    expect(drained.signal, `the watched process did not exit on its own: ${drained.stderr}`).toBeNull();
    expect(drained.status).toBe(0);
    expect(JSON.parse(drained.stdout)).toEqual({
      mainThread: 'running-javascript',
      top: expect.stringMatching(/^blockHere \(…\/watched\.mjs:\d+:\d+\)$/u),
    });
    expect(drained.stderr).not.toContain('Waiting for the debugger');

    // process.exit with the watchdog thread still alive.
    const exited = run('exit');
    expect(exited.status).toBe(3);
    expect(exited.stderr).not.toContain('Waiting for the debugger');
  });

  it('a gap the watchdog saw no silence in says so instead of inventing a stack', async () => {
    const watchdog = startTestWatchdog([]);
    try {
      await beatAndSync(watchdog);
      // A window that ended before this watchdog existed overlaps nothing.
      const evidence = await watchdog.evidence({ fromWallMs: 1_000, toWallMs: 2_000 });
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
      // The loop waited in the poll while the watchdog thread ran: a
      // promptly served stack is not a cause.
      [{ silentMs: 60_000, watchdogLagMs: 10, loopIdleMs: 59_000, firstPauseLatencyMs: 4 }, 'idle-in-poll'],
      [{ silentMs: 60_000, watchdogLagMs: 10, loopIdleMs: 30_000, firstPauseLatencyMs: null }, 'idle-in-poll'],
      // An idle loop with no word from the watchdog thread could equally be
      // a process that was not running: neither is claimed.
      [{ silentMs: 60_000, watchdogLagMs: null, loopIdleMs: 59_000, firstPauseLatencyMs: null }, 'unknown'],
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
    const frame = (functionName: string, url: string): WatchdogRawFrame => ({ functionName, url, line: 12, column: 7 });
    expect(formatStallFrame(frame('git', 'file:///opt/gru%20command/dist/worktrees/git.js'), root))
      .toBe('git (dist/worktrees/git.js:12:7)');
    expect(formatStallFrame(frame('git', '/opt/gru command/dist/worktrees/git.js'), `${root}/`))
      .toBe('git (dist/worktrees/git.js:12:7)');
    expect(formatStallFrame(frame('spawnSync', 'node:child_process'), root)).toBe('spawnSync (node:child_process:12:7)');
    // Outside the install only the file name survives: a script in a home
    // directory must not name its owner.
    expect(formatStallFrame(frame('', 'file:///home/tester/run.js'), root)).toBe('(anonymous) (…/run.js:12:7)');
    expect(formatStallFrame(frame('f', '/opt/gru command-other/x/y.js'), root)).toBe('f (…/y.js:12:7)');
    // A package outside the install keeps its package path.
    expect(formatStallFrame(frame('g', '/home/tester/lib/node_modules/pkg/lib/x.js'), root))
      .toBe('g (…/node_modules/pkg/lib/x.js:12:7)');
    expect(formatStallFrame(frame('evaluated', ''), root)).toBe('evaluated ((unknown script):12:7)');
    // A data: module's URL is its source text: only the scheme is kept.
    expect(formatStallFrame(frame('inline', 'data:text/javascript,const secret="hunter2"'), root))
      .toBe('inline ((data script):12:7)');
    expect(formatStallFrame(frame('remote', 'https://example.invalid/a/b.js?token=abc'), root))
      .toBe('remote ((https script):12:7)');
    expect(formatStallFrame(frame('vm', 'evalmachine.<anonymous>'), root)).toBe('vm (…/evalmachine.<anonymous>:12:7)');
    expect(formatStallFrame(frame('n'.repeat(500), 'node:fs'), root)).toHaveLength(200);
  });

  it('turns a silence and its episode into evidence, with the reason for whatever is missing', () => {
    const context = { unavailable: null, unanswered: false, collectTimeoutMs: 2_000, installRoot: '/opt/gru' };
    const busy: SilenceFacts = { silentMs: 60_000, loopIdleMs: 30, loopActiveMs: 59_970, cpuMs: 59_000, episode: null };
    const episode = (over: Partial<WatchdogEpisode> = {}): WatchdogEpisode => ({
      startedAtMs: 1_000,
      endedAtMs: 61_000,
      watchdogLagMs: 4,
      captures: [],
      unservedPause: false,
      inspectorAttached: false,
      ...over,
    });
    const frame = (functionName: string): WatchdogRawFrame => ({ functionName, url: '/opt/gru/dist/a.js', line: 1, column: 1 });

    // A deep stack: the marker sits where the worker cut it.
    const deep = silenceEvidence(
      {
        ...busy,
        episode: episode({
          captures: [
            { silentMs: 10_002, pauseLatencyMs: 5, frames: [frame('inner'), frame('outer')], omitted: { count: 31, after: 1 } },
            { silentMs: 40_010, pauseLatencyMs: 7, frames: [frame('inner')], omitted: null },
          ],
        }),
      },
      context,
    );
    expect(deep).toEqual({
      mainThread: 'running-javascript',
      silentMs: 60_000,
      loopActiveMs: 59_970,
      loopIdleMs: 30,
      cpuMs: 59_000,
      watchdogLagMs: 4,
      stacks: [
        { silentMs: 10_002, pauseLatencyMs: 5, frames: ['inner (dist/a.js:1:1)', '… 31 frames omitted …', 'outer (dist/a.js:1:1)'] },
        { silentMs: 40_010, pauseLatencyMs: 7, frames: ['inner (dist/a.js:1:1)'] },
      ],
      note: null,
    });

    // No episode: the thread is gone, or late, or reported nothing.
    expect(silenceEvidence(busy, { ...context, unavailable: 'no stack: the watchdog thread failed: Error: boom' }))
      .toMatchObject({ mainThread: 'unknown', watchdogLagMs: null, stacks: [], note: 'no stack: the watchdog thread failed: Error: boom' });
    expect(silenceEvidence(busy, { ...context, unanswered: true }).note)
      .toBe('no stack: the watchdog thread did not answer within 2000 ms');
    expect(silenceEvidence(busy, context).note).toBe('no stack: the watchdog thread reported no episode for this silence');
    // A dead watchdog thread and an idle loop: not called idle, since the
    // process may not have been running at all.
    expect(silenceEvidence({ ...busy, loopIdleMs: 59_900, loopActiveMs: 100, cpuMs: 3 }, { ...context, unavailable: 'no stack: gone' }))
      .toMatchObject({ mainThread: 'unknown', loopIdleMs: 59_900, note: 'no stack: gone' });

    // An episode without a stack says which of three reasons applies.
    expect(silenceEvidence({ ...busy, episode: episode({ inspectorAttached: true }) }, context).note)
      .toBe('no stack: an inspector is attached to this process');
    expect(silenceEvidence({ ...busy, episode: episode({ unservedPause: true }) }, context).note)
      .toBe('no stack: the pause request was not served before the heartbeat returned');
    expect(silenceEvidence({ ...busy, episode: episode() }, context).note)
      .toBe('no stack: the heartbeat returned before the watchdog thread asked for one');
    // The watchdog thread slept through it too.
    expect(silenceEvidence({ ...busy, episode: episode({ watchdogLagMs: 59_800 }) }, context).mainThread).toBe('process-not-running');

    // An idle loop that was asked for a stack: the request may have woken it.
    const woken = silenceEvidence(
      {
        silentMs: 10_900,
        loopIdleMs: 10_850,
        loopActiveMs: 50,
        cpuMs: 4,
        episode: episode({ captures: [{ silentMs: 10_003, pauseLatencyMs: 880, frames: [frame('processTimers')], omitted: null }] }),
      },
      context,
    );
    expect(woken.mainThread).toBe('idle-in-poll');
    expect(woken.note).toBe('asking for a stack wakes an idle loop, so the request may have ended this silence');
  });

  it('renders the record fields and one sentence per kind of stall', () => {
    const base: LoopStallEvidence = {
      mainThread: 'running-javascript',
      silentMs: 61_000,
      loopActiveMs: 60_990,
      loopIdleMs: 10,
      cpuMs: 60_200,
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
      cpu_ms: 60_200,
      watchdog_lag_ms: 2,
      stacks: [{ silent_ms: 10_001, pause_latency_ms: 3, frames: base.stacks[0]!.frames }],
    });
    expect(stallEvidenceFields({ ...base, note: 'why' })['evidence_note']).toBe('why');
    // The sentence keeps the four innermost frames.
    expect(describeStallEvidence(base)).toBe(
      'The main thread was running JavaScript: a (dist/a.js:1:1) ← b (dist/b.js:2:2) ← c (dist/c.js:3:3) ← d (dist/d.js:4:4).',
    );
    expect(describeStallEvidence({ ...base, mainThread: 'inside-native-call' })).toBe(
      'The main thread was inside a call that could not be interrupted (for example a synchronous child process, database or file operation); ' +
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
