/**
 * Worker-thread half of the event-loop stall watchdog (issue: stalls must
 * name their cause). `loop-stall-watchdog.ts` owns the main-thread half and
 * explains the whole design.
 *
 * This thread watches a heartbeat counter the main thread increments. When
 * the counter has not moved for `overdueMs`, it asks V8 — through an
 * inspector session connected to the main thread — to pause the main thread,
 * reads the JavaScript call frames out of the pause notification, and lets
 * the main thread run again.
 *
 * Three rules keep this from ever being the reason the service hangs:
 *
 * - The pause handler resumes the main thread FIRST, before it reads
 *   anything. The frames travel in the notification itself, so the main
 *   thread never waits on this thread's bookkeeping. (Node swallows a throw
 *   from an inspector listener into a warning; a handler that threw before
 *   resuming would leave the main thread paused for good.)
 * - The inspector session exists only for the duration of one capture. A
 *   session left connected makes Node print "Waiting for the debugger to
 *   disconnect..." at every exit, and wait for it when an inspector is open.
 *   Between captures the main thread pays one counter increment per
 *   heartbeat and nothing else.
 * - No capture is asked for while an inspector is attached to the process
 *   (the main thread says so in the shared buffer on every beat): a
 *   watchdog pause would resume a developer's breakpoint.
 *
 * Self-contained on purpose: Node builtins and erasable TypeScript only, so
 * the same file runs compiled from `dist` and — in the tests — straight from
 * source under Node's type stripping.
 */
import { Session } from 'node:inspector';
import { parentPort, workerData } from 'node:worker_threads';

/** What the main thread hands this worker at start. */
export interface WatchdogWorkerData {
  /** Two Int32. Slot 0: the heartbeat counter the main thread increments.
   * Slot 1: 1 while an inspector is attached to the process, as of the
   * last beat. */
  readonly beat: SharedArrayBuffer;
  /** How often this thread looks at the counter. */
  readonly pollMs: number;
  /** Heartbeat silence that opens an episode and asks for the first stack. */
  readonly overdueMs: number;
  /** Silence between two stacks of one episode. */
  readonly recaptureMs: number;
  /** Most stacks one episode keeps. */
  readonly maxCaptures: number;
}

/** One call frame as V8 reports it; the main thread formats and bounds it. */
export interface WatchdogRawFrame {
  readonly functionName: string;
  readonly url: string;
  /** 1-based. */
  readonly line: number;
  /** 1-based. */
  readonly column: number;
}

export interface WatchdogRawCapture {
  /** Heartbeat silence when the pause was requested. */
  readonly silentMs: number;
  /** From the request to the pause. Small: the main thread was running
   * JavaScript. Large: it was inside a call that could not be interrupted. */
  readonly pauseLatencyMs: number;
  /** Innermost first; a deep stack keeps its innermost and outermost frames. */
  readonly frames: readonly WatchdogRawFrame[];
  /** The middle of a deep stack that was left out: `count` frames, after
   * the first `after` kept ones. */
  readonly omitted: { readonly count: number; readonly after: number } | null;
}

/** One stretch of heartbeat silence, reported when the heartbeat returns. */
export interface WatchdogEpisode {
  /** Wall clock (ms) when this thread last saw the heartbeat move. */
  readonly startedAtMs: number;
  /** Wall clock (ms) when this thread saw it move again. */
  readonly endedAtMs: number;
  /** Largest lateness of this thread's own timer during the silence. About
   * the whole silence: no thread of the process was running. */
  readonly watchdogLagMs: number;
  readonly captures: readonly WatchdogRawCapture[];
  /** A pause was requested and the heartbeat returned before it was served. */
  readonly unservedPause: boolean;
  /** A stack was due and not asked for, because an inspector was attached. */
  readonly inspectorAttached: boolean;
}

export type WatchdogWorkerMessage =
  | { readonly type: 'episode'; readonly episode: WatchdogEpisode }
  | { readonly type: 'collected'; readonly id: number }
  | { readonly type: 'fault'; readonly message: string };

export type WatchdogWorkerRequest = { readonly type: 'collect'; readonly id: number };

const BEAT_SLOT = 0;
const INSPECTOR_SLOT = 1;
/** A deep stack keeps this many innermost frames (the blocking site)… */
const INNER_FRAMES = 12;
/** …and this many outermost ones (the callback that started the work). */
const OUTER_FRAMES = 4;
const NAME_LIMIT = 120;
const URL_LIMIT = 400;

const port = parentPort;
if (port === null) throw new Error('the loop-stall watchdog worker must run as a worker thread');
const config = workerData as WatchdogWorkerData;
const beat = new Int32Array(config.beat);

/** The capture in flight, with the session that exists only for it. */
let capture: { readonly session: Session; readonly requestedAt: number; readonly silentMs: number } | null = null;
let episode: {
  readonly startedAtMs: number;
  readonly captures: WatchdogRawCapture[];
  lastRequestAt: number | null;
  inspectorAttached: boolean;
} | null = null;

let lastCount = Atomics.load(beat, BEAT_SLOT);
let lastBeatSeenAt = performance.now();
let lastBeatSeenWallMs = Date.now();
let lastTickAt = lastBeatSeenAt;
let lagSinceBeatMs = 0;

function send(message: WatchdogWorkerMessage): void {
  port?.postMessage(message);
}

function fault(what: string, error: unknown): void {
  send({ type: 'fault', message: `${what}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300) });
}

/** Drop the capture's session. Disconnecting also makes V8 forget a pause
 * that was asked for and never served. */
function endCapture(session: Session): void {
  if (capture !== null && capture.session === session) capture = null;
  try {
    session.disconnect();
  } catch (error) {
    fault('inspector disconnect failed', error);
  }
}

function requestCapture(now: number, silentMs: number): void {
  if (episode === null) return;
  episode.lastRequestAt = now;
  let session: Session;
  try {
    session = new Session();
    session.connectToMainThread();
  } catch (error) {
    fault('inspector session could not connect', error);
    return;
  }
  /** Script ids of this capture; filled by `Debugger.enable`. */
  const scriptUrls = new Map<string, string>();
  session.on('Debugger.scriptParsed', (message) => {
    scriptUrls.set(message.params.scriptId, message.params.url);
  });
  session.on('Debugger.paused', (message) => {
    // Resume FIRST (see the header): nothing below may delay the main thread.
    session.post('Debugger.resume');
    const request = capture;
    try {
      if (request !== null && request.session === session && episode !== null) {
        const all = message.params.callFrames;
        const kept = all.length <= INNER_FRAMES + OUTER_FRAMES
          ? all
          : [...all.slice(0, INNER_FRAMES), ...all.slice(all.length - OUTER_FRAMES)];
        episode.captures.push({
          silentMs: Math.round(request.silentMs),
          pauseLatencyMs: Math.round(performance.now() - request.requestedAt),
          frames: kept.map((frame) => ({
            functionName: frame.functionName.slice(0, NAME_LIMIT),
            url: (scriptUrls.get(frame.location.scriptId) ?? frame.url).slice(0, URL_LIMIT),
            line: frame.location.lineNumber + 1,
            column: (frame.location.columnNumber ?? 0) + 1,
          })),
          omitted: all.length === kept.length ? null : { count: all.length - kept.length, after: INNER_FRAMES },
        });
      }
    } catch (error) {
      fault('stack capture failed', error);
    } finally {
      session.post('Debugger.disable');
      endCapture(session);
    }
  });
  capture = { session, requestedAt: now, silentMs };
  // Posted back to back, not chained on the first reply: the main thread
  // serves both at the same interrupt, so the pause lands at the statement
  // it was executing (or, after an uninterruptible call, the first one it
  // reaches) instead of one thread hop later. A refusal is reported unless
  // the session was closed first, which answers every open request.
  const refused = (what: string) => (error: Error | null): void => {
    if (error !== null && capture !== null && capture.session === session) fault(what, error);
  };
  session.post('Debugger.enable', { maxScriptsCacheSize: 0 }, refused('Debugger.enable was refused'));
  session.post('Debugger.pause', refused('Debugger.pause was refused'));
}

function closeEpisode(): void {
  if (episode === null) return;
  const unserved = capture;
  if (unserved !== null) endCapture(unserved.session);
  send({
    type: 'episode',
    episode: {
      startedAtMs: episode.startedAtMs,
      endedAtMs: Date.now(),
      watchdogLagMs: Math.round(lagSinceBeatMs),
      captures: episode.captures,
      unservedPause: unserved !== null,
      inspectorAttached: episode.inspectorAttached,
    },
  });
  episode = null;
}

function tick(): void {
  const now = performance.now();
  const lag = Math.max(0, now - lastTickAt - config.pollMs);
  lastTickAt = now;
  lagSinceBeatMs = Math.max(lagSinceBeatMs, lag);
  const silentMs = now - lastBeatSeenAt;
  // Also opened in hindsight: a silence this thread slept through (the whole
  // process was not running) is still a silence the record must explain.
  if (silentMs >= config.overdueMs && episode === null) {
    episode = { startedAtMs: lastBeatSeenWallMs, captures: [], lastRequestAt: null, inspectorAttached: false };
  }
  const count = Atomics.load(beat, BEAT_SLOT);
  if (count !== lastCount) {
    closeEpisode();
    lastCount = count;
    lastBeatSeenAt = now;
    lastBeatSeenWallMs = Date.now();
    lagSinceBeatMs = 0;
    return;
  }
  if (episode === null || capture !== null) return;
  // A tick that was itself very late proves this thread was not running
  // either: the main thread is about to beat, and a pause now would blame
  // whatever callback happens to run first. The next tick asks instead.
  if (lag >= config.overdueMs / 2) return;
  if (episode.captures.length >= config.maxCaptures) return;
  if (episode.lastRequestAt !== null && now - episode.lastRequestAt < config.recaptureMs) return;
  if (Atomics.load(beat, INSPECTOR_SLOT) !== 0) {
    episode.inspectorAttached = true;
    return;
  }
  requestCapture(now, silentMs);
}

port.on('message', (request: WatchdogWorkerRequest) => {
  if (request.type !== 'collect') return;
  // The main thread beats before it asks, so this closes a finished episode
  // now instead of at the next poll.
  try {
    tick();
  } catch (error) {
    fault('watchdog tick failed', error);
  }
  send({ type: 'collected', id: request.id });
});

setInterval(() => {
  try {
    tick();
  } catch (error) {
    fault('watchdog tick failed', error);
  }
}, config.pollMs);
