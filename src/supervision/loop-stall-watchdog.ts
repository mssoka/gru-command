import { url as inspectorUrl } from 'node:inspector';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type {
  WatchdogEpisode,
  WatchdogRawCapture,
  WatchdogRawFrame,
  WatchdogWorkerData,
  WatchdogWorkerMessage,
  WatchdogWorkerRequest,
} from './loop-stall-watchdog-worker.js';

/**
 * Event-loop stall watchdog: what was the main thread doing while it could
 * not run its own timers?
 *
 * The supervisor already notices a stall — its tick arrives late and the
 * machine did not sleep — but only afterwards, when the blocking work is
 * over and its stack is gone. This module watches from the outside while the
 * stall is happening:
 *
 * - The main thread beats a shared counter every second and, on a beat that
 *   arrives late, reads how its event loop spent the gap (idle in the OS
 *   poll, or active).
 * - A worker thread (`loop-stall-watchdog-worker.ts`) polls the counter.
 *   When it has not moved for ten seconds, it pauses the main thread through
 *   the inspector, reads the JavaScript call frames and resumes it.
 *
 * Together they say which of four things the silence was (see
 * {@link MainThreadState}), and for the two that have a stack, where.
 *
 * Nothing here can stop the service: a watchdog that cannot start, fails or
 * does not answer is logged and reported in the evidence as the reason no
 * stack exists. Frames carry a function name and a source position only —
 * never arguments, scope values or source text.
 *
 * One limit to know: asking the main thread for a stack wakes its event
 * loop. A loop that was parked in the OS poll with timers due — blocked by
 * nothing — therefore runs again at the first request, ten seconds in. Such
 * a silence is reported as `idle-in-poll` with a note saying the request may
 * have ended it; it will usually be too short for the supervisor's
 * 30-second stall record and is found by its own `main thread went silent`
 * log line.
 */

/** What the main thread was doing during a silence. */
export type MainThreadState =
  /** The pause was served at once: the stack is the code that was running. */
  | 'running-javascript'
  /** The pause was served only when a call that cannot be interrupted (a
   * synchronous child process, SQLite, a file read, a blocking write)
   * returned: the stack is where JavaScript resumed, so the blocking call is
   * the one its innermost frames had just made. */
  | 'inside-native-call'
  /** The event loop sat in the OS poll for most of the silence while the
   * watchdog thread kept running: no code of this process was running on
   * the main thread, its timers simply were not woken. Any stack is the
   * first callback that ran afterwards, not a cause. */
  | 'idle-in-poll'
  /** The watchdog thread was late for most of the silence too: the whole
   * process was not running (stopped, suspended or starved by the OS). */
  | 'process-not-running'
  /** No evidence; `note` says why. */
  | 'unknown';

export interface LoopStallStack {
  /** Heartbeat silence when the stack was requested. */
  readonly silentMs: number;
  /** From the request to the pause (see {@link MainThreadState}). */
  readonly pauseLatencyMs: number;
  /** Innermost first: `function (file:line:column)`. A deep stack keeps
   * its twelve innermost and four outermost frames around one marker. */
  readonly frames: readonly string[];
}

/** What the watchdog knows about one supervisor tick gap. */
export interface LoopStallEvidence {
  readonly mainThread: MainThreadState;
  /** The heartbeat silence the watchdog measured inside the gap. */
  readonly silentMs: number | null;
  /** How the main event loop spent that silence. */
  readonly loopActiveMs: number | null;
  readonly loopIdleMs: number | null;
  /** CPU time (user + system) the whole process used during that silence.
   * About the silence: something was computing. Near zero: it was waiting. */
  readonly cpuMs: number | null;
  /** Largest lateness of the watchdog thread's own timer in that silence. */
  readonly watchdogLagMs: number | null;
  /** Up to three stacks of the silence, oldest first. */
  readonly stacks: readonly LoopStallStack[];
  /** Why something above is missing, or null. */
  readonly note: string | null;
}

export interface LoopStallWindow {
  /** Wall clock (ms) of the supervisor tick before the gap. */
  readonly fromWallMs: number;
  /** Wall clock (ms) of the tick that found it. */
  readonly toWallMs: number;
}

/** What the supervisor consumes; disposed with it. */
export interface LoopStallEvidenceSource {
  evidence(window: LoopStallWindow): Promise<LoopStallEvidence>;
  dispose(): void;
}

type Log = (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;

export interface LoopStallWatchdogOptions {
  readonly log?: Log;
  /** Main-thread heartbeat and worker poll cadence (default 1 s). */
  readonly heartbeatMs?: number;
  /** Silence that asks for the first stack (default 10 s). Well under the
   * supervisor's 30 s stall threshold, so every recorded stall has one, and
   * well over any ordinary synchronous step. */
  readonly overdueMs?: number;
  /** Silence between two stacks of one stall (default 30 s). */
  readonly recaptureMs?: number;
  /** How long `evidence` waits for the worker's answer (default 2 s). */
  readonly collectTimeoutMs?: number;
  /** Directory frames are shown relative to (default: the installed package). */
  readonly installRoot?: string;
}

export const LOOP_STALL_HEARTBEAT_MS = 1_000;
export const LOOP_STALL_OVERDUE_MS = 10_000;
export const LOOP_STALL_RECAPTURE_MS = 30_000;
export const LOOP_STALL_MAX_STACKS = 3;
const COLLECT_TIMEOUT_MS = 2_000;
/** Silences kept for a later `evidence` call. */
const SILENCE_HISTORY = 8;
/** A pause served within this is "the main thread was running JavaScript". */
const PROMPT_PAUSE_MS = 1_000;
const FRAME_LIMIT = 200;

// ------------------------------------------------------------------
// Pure helpers
// ------------------------------------------------------------------

/**
 * One frame as `function (file:line:column)`. A file inside the installed
 * package is shown relative to it; Node's own modules keep their `node:`
 * name; any other file keeps its path from `node_modules/` on, or else its
 * file name alone, so no home directory or user name reaches a record; and
 * a script that is not a file (a `data:` module carries its whole source in
 * its URL) is named by its scheme alone.
 */
export function formatStallFrame(frame: WatchdogRawFrame, installRoot: string): string {
  const name = frame.functionName === '' ? '(anonymous)' : frame.functionName;
  const url = frame.url;
  let file: string;
  if (url === '') {
    file = '(unknown script)';
  } else if (url.startsWith('node:')) {
    file = url;
  } else if (/^[a-z][a-z0-9+.-]+:/iu.test(url) && !url.startsWith('file:')) {
    file = `(${url.slice(0, url.indexOf(':'))} script)`;
  } else {
    let path = url;
    if (url.startsWith('file:')) {
      try {
        path = fileURLToPath(url);
      } catch {
        path = url.slice('file:'.length);
      }
    }
    const root = installRoot.endsWith('/') ? installRoot : `${installRoot}/`;
    const segments = path.split(/[\\/]/u).filter((segment) => segment !== '');
    const modules = segments.lastIndexOf('node_modules');
    file = path.startsWith(root)
      ? path.slice(root.length)
      : `…/${(modules >= 0 ? segments.slice(modules) : segments.slice(-1)).join('/')}`;
  }
  return `${name} (${file}:${frame.line}:${frame.column})`.slice(0, FRAME_LIMIT);
}

function formatStack(capture: WatchdogRawCapture, installRoot: string): LoopStallStack {
  const frames = capture.frames.map((frame) => formatStallFrame(frame, installRoot));
  if (capture.omitted !== null) {
    frames.splice(capture.omitted.after, 0, `… ${capture.omitted.count} frames omitted …`);
  }
  return { silentMs: capture.silentMs, pauseLatencyMs: capture.pauseLatencyMs, frames };
}

/** Which of the four things a silence was. Order matters: a process that
 * was not running also shows an idle loop, and an idle loop also yields a
 * (meaningless) promptly served stack. Without the watchdog thread's own
 * lateness an idle loop cannot be told from a process that was not running,
 * so neither is claimed. */
export function classifyMainThread(input: {
  readonly silentMs: number;
  readonly watchdogLagMs: number | null;
  readonly loopIdleMs: number | null;
  readonly firstPauseLatencyMs: number | null;
}): MainThreadState {
  const most = input.silentMs / 2;
  if (input.watchdogLagMs !== null && input.watchdogLagMs >= most) return 'process-not-running';
  if (input.loopIdleMs !== null && input.loopIdleMs >= most) {
    return input.watchdogLagMs === null ? 'unknown' : 'idle-in-poll';
  }
  if (input.firstPauseLatencyMs === null) return 'unknown';
  return input.firstPauseLatencyMs <= PROMPT_PAUSE_MS ? 'running-javascript' : 'inside-native-call';
}

/** Evidence for a gap nothing is known about. */
export function unknownStallEvidence(note: string): LoopStallEvidence {
  return {
    mainThread: 'unknown',
    silentMs: null,
    loopActiveMs: null,
    loopIdleMs: null,
    cpuMs: null,
    watchdogLagMs: null,
    stacks: [],
    note: note.slice(0, 300),
  };
}

/** The evidence as record fields: the `supervision.loop-stall` event
 * payload and the stall log line both carry exactly these. */
export function stallEvidenceFields(evidence: LoopStallEvidence): Record<string, unknown> {
  return {
    main_thread: evidence.mainThread,
    silent_ms: evidence.silentMs,
    loop_active_ms: evidence.loopActiveMs,
    loop_idle_ms: evidence.loopIdleMs,
    cpu_ms: evidence.cpuMs,
    watchdog_lag_ms: evidence.watchdogLagMs,
    stacks: evidence.stacks.map((stack) => ({
      silent_ms: stack.silentMs,
      pause_latency_ms: stack.pauseLatencyMs,
      frames: stack.frames,
    })),
    ...(evidence.note !== null ? { evidence_note: evidence.note } : {}),
  };
}

const seconds = (ms: number | null): string => (ms === null ? 'an unknown time' : `${Math.round(ms / 1_000)} s`);

/** One sentence for the hourly FYI: what the latest stall was, and where. */
export function describeStallEvidence(evidence: LoopStallEvidence): string {
  const first = evidence.stacks[0];
  const where = first === undefined || first.frames.length === 0
    ? null
    : first.frames.slice(0, 4).join(' ← ');
  switch (evidence.mainThread) {
    case 'running-javascript':
      return `The main thread was running JavaScript: ${where ?? 'no frames were captured'}.`;
    case 'inside-native-call':
      return 'The main thread was inside a call that could not be interrupted ' +
        `(for example a synchronous child process, database or file operation); JavaScript resumed at ${where ?? 'an unknown frame'}.`;
    case 'idle-in-poll':
      return `The main thread was idle in the event-loop poll for ${seconds(evidence.loopIdleMs)} of ` +
        `${seconds(evidence.silentMs)}: no code of this service was blocking it, its timers were not woken.`;
    case 'process-not-running':
      return `The whole process was not running: the watchdog thread was ${seconds(evidence.watchdogLagMs)} late too.`;
    case 'unknown':
      return `What blocked it is unknown: ${evidence.note ?? 'the watchdog has no evidence for this gap'}.`;
  }
}

/** One heartbeat silence: the main thread's own measurements of it and,
 * once it arrived, the watchdog thread's episode for the same stretch. */
export interface SilenceFacts {
  readonly silentMs: number;
  readonly loopIdleMs: number | null;
  readonly loopActiveMs: number | null;
  readonly cpuMs: number | null;
  readonly episode: WatchdogEpisode | null;
}

/** The evidence one silence amounts to, with the reason for anything missing. */
export function silenceEvidence(
  silence: SilenceFacts,
  context: {
    /** Why the watchdog thread cannot capture at all, or null. */
    readonly unavailable: string | null;
    /** The thread was asked for its episode and did not answer in time. */
    readonly unanswered: boolean;
    readonly collectTimeoutMs: number;
    readonly installRoot: string;
  },
): LoopStallEvidence {
  const episode = silence.episode;
  const stacks = episode === null ? [] : episode.captures.map((capture) => formatStack(capture, context.installRoot));
  const watchdogLagMs = episode === null ? null : episode.watchdogLagMs;
  let note: string | null = null;
  if (episode === null) {
    note = context.unavailable ??
      (context.unanswered
        ? `no stack: the watchdog thread did not answer within ${context.collectTimeoutMs} ms`
        : 'no stack: the watchdog thread reported no episode for this silence');
  } else if (stacks.length === 0) {
    note = episode.inspectorAttached
      ? 'no stack: an inspector is attached to this process'
      : episode.unservedPause
        ? 'no stack: the pause request was not served before the heartbeat returned'
        : 'no stack: the heartbeat returned before the watchdog thread asked for one';
  }
  const mainThread = classifyMainThread({
    silentMs: silence.silentMs,
    watchdogLagMs,
    loopIdleMs: silence.loopIdleMs,
    firstPauseLatencyMs: episode?.captures[0]?.pauseLatencyMs ?? null,
  });
  if (mainThread === 'idle-in-poll' && stacks.length > 0) {
    note = 'asking for a stack wakes an idle loop, so the request may have ended this silence';
  }
  return {
    mainThread,
    silentMs: silence.silentMs,
    loopActiveMs: silence.loopActiveMs,
    loopIdleMs: silence.loopIdleMs,
    cpuMs: silence.cpuMs,
    watchdogLagMs,
    stacks,
    note,
  };
}

// ------------------------------------------------------------------
// The watchdog
// ------------------------------------------------------------------

interface Silence extends SilenceFacts {
  readonly fromWallMs: number;
  readonly toWallMs: number;
  episode: WatchdogEpisode | null;
  logged: boolean;
}

/** Slots of the buffer shared with the worker (see `WatchdogWorkerData`). */
const BEAT_SLOT = 0;
const INSPECTOR_SLOT = 1;

const overlap = (a: { fromWallMs: number; toWallMs: number }, fromWallMs: number, toWallMs: number): number =>
  Math.min(a.toWallMs, toWallMs) - Math.max(a.fromWallMs, fromWallMs);

class LoopStallWatchdog implements LoopStallEvidenceSource {
  private readonly log: Log;
  private readonly overdueMs: number;
  private readonly collectTimeoutMs: number;
  private readonly installRoot: string;
  private readonly beatView: Int32Array;
  private readonly silences: Silence[] = [];
  private worker: Worker | null = null;
  /** Why no stack can be captured, once that is known. */
  private unavailable: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastBeatAt = performance.now();
  private lastBeatWallMs = Date.now();
  private lastUtilization = performance.eventLoopUtilization();
  private lastCpu = process.cpuUsage();
  private nextCollectId = 1;
  private readonly collects = new Map<number, () => void>();
  private disposed = false;

  constructor(opts: LoopStallWatchdogOptions) {
    this.log = opts.log ?? (() => {});
    const heartbeatMs = opts.heartbeatMs ?? LOOP_STALL_HEARTBEAT_MS;
    this.overdueMs = opts.overdueMs ?? LOOP_STALL_OVERDUE_MS;
    this.collectTimeoutMs = opts.collectTimeoutMs ?? COLLECT_TIMEOUT_MS;
    // This module is `<root>/dist/supervision/…` (or `<root>/src/supervision/…`).
    this.installRoot = opts.installRoot ?? fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/u, '');
    const beat = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
    this.beatView = new Int32Array(beat);
    Atomics.store(this.beatView, INSPECTOR_SLOT, inspectorUrl() === undefined ? 0 : 1);
    this.startWorker({
      beat,
      pollMs: heartbeatMs,
      overdueMs: this.overdueMs,
      recaptureMs: opts.recaptureMs ?? LOOP_STALL_RECAPTURE_MS,
      maxCaptures: LOOP_STALL_MAX_STACKS,
    });
    this.heartbeat = setInterval(() => this.beat(), heartbeatMs);
    this.heartbeat.unref?.();
  }

  private startWorker(data: WatchdogWorkerData): void {
    try {
      // The worker entry sits beside this module with the same extension:
      // `.js` when built, `.ts` when the tests run the source.
      const entry = new URL(
        import.meta.url.endsWith('.ts') ? './loop-stall-watchdog-worker.ts' : './loop-stall-watchdog-worker.js',
        import.meta.url,
      );
      // No inherited options or environment: a worker otherwise re-runs the
      // process's `--import`/`--require` preloads (from NODE_OPTIONS or the
      // command line) inside this thread, and a preload written for the
      // service's main thread has no business in its watchdog.
      const worker = new Worker(entry, {
        workerData: data,
        name: 'gru-loop-stall-watchdog',
        execArgv: [],
        env: {},
      });
      worker.on('message', (message: WatchdogWorkerMessage) => this.onWorkerMessage(message));
      worker.on('error', (error) => this.workerFailed(`the watchdog thread failed: ${String(error)}`));
      worker.on('exit', (code) => {
        if (!this.disposed) this.workerFailed(`the watchdog thread exited (code ${code})`);
      });
      // After the listeners: a `message` listener refs the worker again, and
      // a watchdog must never be what keeps the process alive.
      worker.unref();
      this.worker = worker;
    } catch (error) {
      this.workerFailed(`the watchdog thread could not start: ${String(error)}`);
    }
  }

  private workerFailed(reason: string): void {
    this.worker = null;
    // The first reason is the cause; the exit that follows an error is not.
    if (this.unavailable === null) {
      this.unavailable = `no stack: ${reason}`.slice(0, 300);
      this.log('error', 'event-loop stall watchdog stopped — stalls will be recorded without a stack', { error: reason });
    }
    for (const settle of [...this.collects.values()]) settle();
  }

  private onWorkerMessage(message: WatchdogWorkerMessage): void {
    if (message.type === 'fault') {
      this.log('warn', 'event-loop stall watchdog fault', { error: message.message });
      return;
    }
    if (message.type === 'collected') {
      this.collects.get(message.id)?.();
      return;
    }
    const { episode } = message;
    // The worker sees the heartbeat one poll late, so its episode and the
    // main thread's own measurement of the same silence overlap in time.
    let best: Silence | null = null;
    let bestOverlap = 0;
    for (const silence of this.silences) {
      if (silence.episode !== null) continue;
      const shared = overlap(silence, episode.startedAtMs, episode.endedAtMs);
      if (shared <= bestOverlap) continue;
      best = silence;
      bestOverlap = shared;
    }
    if (best !== null) {
      best.episode = episode;
      return;
    }
    // A silence only the worker measured as overdue (within one poll of the
    // threshold): keep it, without the loop's own account of the gap.
    this.remember({
      fromWallMs: episode.startedAtMs,
      toWallMs: episode.endedAtMs,
      silentMs: episode.endedAtMs - episode.startedAtMs,
      loopIdleMs: null,
      loopActiveMs: null,
      cpuMs: null,
      episode,
      logged: false,
    });
    // No late beat of the main thread's own will settle this one.
    this.logSilences(false);
  }

  private remember(silence: Silence): void {
    this.silences.push(silence);
    if (this.silences.length > SILENCE_HISTORY) this.silences.shift();
  }

  /** One heartbeat. A late one is a silence: note how the loop spent it. */
  private beat(): void {
    if (this.disposed) return;
    const now = performance.now();
    const wallMs = Date.now();
    const utilization = performance.eventLoopUtilization();
    const cpu = process.cpuUsage();
    const silentMs = now - this.lastBeatAt;
    const late = silentMs >= this.overdueMs;
    if (late) {
      this.remember({
        fromWallMs: this.lastBeatWallMs,
        toWallMs: wallMs,
        silentMs: Math.round(silentMs),
        loopIdleMs: Math.round(utilization.idle - this.lastUtilization.idle),
        loopActiveMs: Math.round(utilization.active - this.lastUtilization.active),
        cpuMs: Math.round((cpu.user - this.lastCpu.user + cpu.system - this.lastCpu.system) / 1_000),
        episode: null,
        logged: false,
      });
    }
    this.lastBeatAt = now;
    this.lastBeatWallMs = wallMs;
    this.lastUtilization = utilization;
    this.lastCpu = cpu;
    Atomics.store(this.beatView, INSPECTOR_SLOT, inspectorUrl() === undefined ? 0 : 1);
    Atomics.add(this.beatView, BEAT_SLOT, 1);
    if (late) {
      // Every silence leaves a log line of its own, also one too short for
      // the supervisor's stall record. Asked only now that the counter has
      // moved: the worker closes its episode when it sees that.
      void this.settle().catch((error: unknown) => {
        this.log('warn', 'event-loop stall watchdog could not settle a silence', { error: String(error) });
      });
    }
  }

  /** Ask the worker for the episode it has finished, bounded; then log
   * every silence not yet logged. Answers whether the worker stayed silent. */
  private async settle(): Promise<boolean> {
    const worker = this.worker;
    let unanswered = false;
    if (worker !== null) {
      const id = this.nextCollectId;
      this.nextCollectId += 1;
      unanswered = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          this.collects.delete(id);
          resolve(true);
        }, this.collectTimeoutMs);
        timer.unref?.();
        this.collects.set(id, () => {
          clearTimeout(timer);
          this.collects.delete(id);
          resolve(false);
        });
        worker.postMessage({ type: 'collect', id } satisfies WatchdogWorkerRequest);
      });
    }
    this.logSilences(unanswered);
    return unanswered;
  }

  /** One info line per silence, once. */
  private logSilences(unanswered: boolean): void {
    if (this.disposed) return;
    for (const silence of this.silences) {
      if (silence.logged) continue;
      silence.logged = true;
      this.log('info', 'main thread went silent', {
        from: new Date(silence.fromWallMs).toISOString(),
        ...stallEvidenceFields(this.evidenceOf(silence, unanswered)),
      });
    }
  }

  private evidenceOf(silence: Silence, unanswered: boolean): LoopStallEvidence {
    return silenceEvidence(silence, {
      unavailable: this.unavailable,
      unanswered,
      collectTimeoutMs: this.collectTimeoutMs,
      installRoot: this.installRoot,
    });
  }

  async evidence(window: LoopStallWindow): Promise<LoopStallEvidence> {
    if (this.disposed) return unknownStallEvidence('the watchdog is disposed');
    // Beat now: the caller's timer may have run before the heartbeat's, and
    // the worker closes an episode only once it sees the counter move.
    this.beat();
    const unanswered = await this.settle();
    let best: Silence | null = null;
    let found = 0;
    for (const silence of this.silences) {
      if (overlap(silence, window.fromWallMs, window.toWallMs) <= 0) continue;
      found += 1;
      if (best === null || silence.silentMs > best.silentMs) best = silence;
    }
    if (best === null) {
      return unknownStallEvidence(
        this.unavailable ??
          `the watchdog saw no heartbeat silence of ${this.overdueMs} ms or more in this gap`,
      );
    }
    const evidence = this.evidenceOf(best, unanswered);
    if (found === 1) return evidence;
    const more = `${found} separate silences in this gap; this is the longest`;
    return { ...evidence, note: evidence.note === null ? more : `${evidence.note}; ${more}` };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    for (const settle of [...this.collects.values()]) settle();
    const worker = this.worker;
    this.worker = null;
    if (worker !== null) {
      void worker.terminate().catch(() => {
        /* already gone */
      });
    }
  }
}

/** Start watching the calling (main) thread. Never throws: a watchdog that
 * cannot start reports why in every piece of evidence it gives. */
export function startLoopStallWatchdog(opts: LoopStallWatchdogOptions = {}): LoopStallEvidenceSource {
  return new LoopStallWatchdog(opts);
}
