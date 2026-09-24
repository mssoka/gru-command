import { realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import { join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { hashToken, tokenConfigured as isTokenConfigured, tokenMatches } from '../auth.js';
import type { GruCommandConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { AgentHandle, AgentState, RuntimeEvent } from '../runtime/types.js';
import { chipPathAllowed } from '../attachments/resolver.js';
import type { AttachmentChip } from '../attachments/resolver.js';
import type { ChatFrameLog } from './frame-log.js';
import {
  WS_PATH,
  ephemeralError,
  parseClientFrame,
  type ClientFrame,
  type ContextControlState,
  type ContextEventFrame,
  type ContextFrame,
  type ControlFrame,
  type ControlResultCode,
  type ErrorFrame,
  type LoggedFrame,
  type ServerFrame,
  type UserFrame,
} from './frames.js';
import type { GruSessionPointer } from './session-state.js';
import {
  AWARENESS_WAKE_INSTRUCTION,
  type AwarenessInjection,
  type GruAwarenessPort,
} from './awareness.js';
import { SpawnRetryGate } from './spawn-backoff.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/** Prompts from the chat surface share one owner — the single user (SPEC ruling 1). */
const CHAT_OWNER = 'chat';
/** Keep provider failures useful without allowing an unbounded machine error
 * to flood the control row or WebSocket frame. */
const MAX_CONTROL_MESSAGE_CHARS = 240;
const MAX_DEFERRED_CONTROL_FRAMES = 128;
const MAX_PENDING_NOTICES = 128;

function boundedControlMessage(message: string): string {
  if (message.length <= MAX_CONTROL_MESSAGE_CHARS) return message;
  return `${message.slice(0, MAX_CONTROL_MESSAGE_CHARS - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ControlTimeoutError extends Error {
  constructor(readonly operation: string, readonly timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs} ms`);
    this.name = 'ControlTimeoutError';
  }
}

function sameSessionFile(left: string, right: string | null | undefined): boolean {
  if (right === null || right === undefined) return false;
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    if (leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino) return true;
    return realpathSync.native(left) === realpathSync.native(right);
  } catch {
    // Identity checks still need a deterministic fallback for an adapter
    // that reports its path just before materializing the transcript.
    return resolve(left) === resolve(right);
  }
}

function sameNativeSession(
  left: AgentHandle,
  right: AgentHandle | null,
): boolean {
  return right !== null &&
    (left === right ||
      left.id === right.id ||
      (left.sessionFile !== null && sameSessionFile(left.sessionFile, right.sessionFile)));
}

/**
 * Compose the delivered prompt (SPEC ruling 19(d)): the composer text
 * plus a path manifest the AGENT reads itself. No bytes, no inline
 * content — paths only. `visionUnavailable` (runtime cannot host
 * vision) adds the never-guess instruction so a blind model declines
 * gracefully instead of hallucinating image contents.
 */
export function composeDeliveredPrompt(
  text: string,
  attachments?: readonly AttachmentChip[],
  visionUnavailable = false,
): string {
  if (attachments === undefined || attachments.length === 0) return text;
  const lines = attachments.map(
    (chip) => `- ${chip.path}${chip.kind === 'image' ? ' (image)' : ''}`,
  );
  const gate = visionUnavailable
    ? '\nVision is unavailable on the current model: do NOT guess at any image\'s contents — state plainly that you cannot view it.'
    : '';
  return `${text}\n\n[attached files — read them yourself at these paths]\n${lines.join('\n')}${gate}`;
}

export interface ChatServerOptions {
  readonly config: GruCommandConfig;
  readonly frameLog: ChatFrameLog;
  readonly pointer: GruSessionPointer;
  /** Spawn (or resume) the single Gru session. Injected: the chat layer
   * never touches a concrete adapter or the registry (runtime-agnostic). */
  readonly spawnGru: (resumeFile: string | null) => Promise<AgentHandle>;
  /** Mint a native session without resume/transcript context. This is
   * mandatory: reusing spawnGru(null) could return the supervised old handle. */
  readonly spawnFreshGru: () => Promise<AgentHandle>;
  /** Fail-closed preflight for the supervised slot (for example, an open
   * crash-loop breaker). Called immediately before durable activation. */
  readonly canAdoptFreshGru?: () => boolean;
  /** Bind a successfully committed fresh handle to its supervised slot. */
  readonly adoptFreshGru?: (handle: AgentHandle) => Promise<void>;
  readonly log?: Log;
  /** First-frame-must-be-auth deadline (mock parity: 5 000 ms). */
  readonly authDeadlineMs?: number;
  /** Transport heartbeat interval; 0 disables. Default 30 000 ms. */
  readonly heartbeatMs?: number;
  /** Deadline for provider compaction and fresh-session minting. */
  readonly controlTimeoutMs?: number;
  /** ws payload cap — the client caps messages at 4 000 chars; 64 KiB is generous. */
  readonly maxPayloadBytes?: number;
  /** Spawn-retry backoff base (doubles per consecutive failure; default
   * 1 000 ms, 0 disables the gate — tests use small/zero values). */
  readonly spawnBackoffBaseMs?: number;
  /** Spawn-retry backoff cap (default 60 000 ms). */
  readonly spawnBackoffMaxMs?: number;
  /** Upgrade paths owned by SIBLING ws surfaces (the board's /board/ws,
   * E6): the chat handler passes them instead of destroying, so sibling
   * handlers can claim them. Unlisted non-/ws paths still die (standalone
   * behavior unchanged). */
  readonly siblingUpgradePaths?: readonly string[];
  /** Gru awareness (dispatch briefing 2026-09-22): the injection provider
   * whose context block rides each prompt, plus the wake sink target. */
  readonly awareness?: GruAwarenessPort;
}

export interface ChatServer {
  /** Hook the HTTP server's `upgrade` event (path-gated to /ws). */
  attach(httpServer: HttpServer): void;
  /** Best-effort Gru spawn at boot; failures are logged, never fatal. */
  warmup(): void;
  /** Surface a product notice in the chat stream (E7, SPEC ruling 13 —
   * action-required items Gru surfaces in chat). Logged + replayed. */
  surfaceNotice(text: string, onPersist?: () => void): boolean;
  /** Start an awareness turn when the lane is idle (the awareness layer's
   * wake sink calls this). Coalesced: a request arriving mid-turn or
   * mid-wake is served by one trailing turn, never as a mid-turn steer.
   * No-op without an attached awareness layer or when disposed. */
  wakeAwareness(): void;
  /** Adopt a supervisor-restarted Gru handle (E7): re-wire subscription
   * + session pointer onto the new live handle. */
  adoptRestartedGru(handle: AgentHandle): void;
  /** Close every client and stop timers; the agent handle is NOT disposed
   * here — the registry owns it (shutdown ladder disposes chat first). */
  dispose(): Promise<void>;
}

const SPAWN_BACKOFF_BASE_MS = 1_000;
const SPAWN_BACKOFF_MAX_MS = 60_000;

/**
 * Raised by ensureGru() while the bounded spawn-retry gate is cooling down.
 * Distinct from genuine spawn errors: the deferred-frame path must NOT
 * close the socket for this one — closing is the reconnect trigger, and
 * reconnecting during the window is exactly the storm being bounded.
 */
class SpawnBackoffError extends Error {
  constructor(readonly retryInMs: number) {
    super(`Gru session start is backed off; the next attempt is allowed in ${retryInMs} ms`);
    this.name = 'SpawnBackoffError';
  }
}

interface Client {
  readonly socket: WebSocket;
  authed: boolean;
  writer: boolean;
  /** Auth timestamp — the pen promotes to the EARLIEST authenticated
   * reader (r1 N6), not merely the earliest connection. */
  authedAt: number;
  /** Consecutive pings without a pong; two missed → terminate. */
  pongMisses: number;
  authDeadline: ReturnType<typeof setTimeout> | null;
  /** One deferred-frame failure poisons the ordered stream for this socket. */
  deferredFailed: boolean;
}

/**
 * The chat socket server (EPICS E4 stories 1/3): token-authed `/ws`
 * endpoint speaking the E5 frame contract EXACTLY (the mock is the
 * executable spec). One Gru session behind it; first authenticated
 * client holds the pen, later concurrent clients are read-only; the pen
 * promotes FIFO on writer disconnect. Every seq-consuming frame is
 * appended to the durable frame log before broadcast, so reconnect
 * replay and history survive restarts.
 */
export function createChatServer(options: ChatServerOptions): ChatServer {
  const log = options.log ?? (() => {});
  const frameLog = options.frameLog;
  const authDeadlineMs = options.authDeadlineMs ?? 5_000;
  const heartbeatMs = options.heartbeatMs ?? 30_000;
  const controlTimeoutMs = options.controlTimeoutMs ?? 120_000;
  const spawnBackoffMaxMs = options.spawnBackoffMaxMs ?? SPAWN_BACKOFF_MAX_MS;
  const spawnGate = new SpawnRetryGate(
    options.spawnBackoffBaseMs ?? SPAWN_BACKOFF_BASE_MS,
    spawnBackoffMaxMs,
  );
  const siblingUpgradePaths = new Set(options.siblingUpgradePaths ?? []);
  const tokenHash = hashToken(options.config.auth.token);
  const tokenConfigured = isTokenConfigured(options.config.auth.token);

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? 64 * 1024,
  });
  const clients = new Set<Client>();
  const initialBoundary = options.pointer.current();
  let epoch = initialBoundary?.epoch ?? 0;
  let replayFloorSeq = initialBoundary?.replayFloorSeq ?? 0;
  /** A durable boundary whose native session vanished must be repaired before
   * another user frame is logged; otherwise the replacement model and the
   * visible replay would start from different histories. */
  let boundarySessionMissing =
    initialBoundary !== null && options.pointer.resumeCandidate() === null;
  if (replayFloorSeq > frameLog.highWaterSeq) {
    throw new Error(
      `gru session replay floor ${replayFloorSeq} exceeds chat frame high-water ` +
        `${frameLog.highWaterSeq}; refusing a boundary that would hide future frames`,
    );
  }

  let handle: AgentHandle | null = null;
  let unsubscribe: (() => void) | null = null;
  let spawning: Promise<AgentHandle> | null = null;
  /** Set by dispose(): a spawn completing after teardown is released, not
   * wired into a dead server (r1 N9). */
  let disposed = false;
  /** True from a prompt delivery until the turn end lands (or the prompt
   * rejects) — the steer-vs-prompt decision for the NEXT message. */
  let turnLive = false;
  let runtimeCompacting = false;
  let runtimeCompactionBarrier: Promise<void> | null = null;
  let resolveRuntimeCompaction: (() => void) | null = null;
  let controlState: ContextControlState = 'idle';
  let controlBarrier: Promise<void> | null = null;
  let manualCompaction: {
    readonly source: AgentHandle;
    readonly resolve: (event: Extract<RuntimeEvent, { type: 'compaction_end' }>) => void;
  } | null = null;
  let pendingDeliveries = 0;
  let deferredControlFrames = 0;
  let deferredFrameTail: Promise<void> = Promise.resolve();
  /** Awareness wake coalescing: one request → at most one trailing turn. */
  let wakeRequested = false;
  let wakeRunning = false;
  /** Fatal native-writer uncertainty after failed compaction retirement.
   * Only process restart or a confirmed late resume may clear it. */
  let recoveryBlockedReason: string | null = null;
  const pendingNotices: Array<{ readonly text: string; readonly onPersist?: () => void }> = [];
  /** callId → tool name, for tool_end frames (the contract carries names). */
  const openCalls = new Map<string, string>();

  // -----------------------------------------------------------------------
  // Gru session lifecycle
  // -----------------------------------------------------------------------

  function ensureGru(): Promise<AgentHandle> {
    if (handle !== null) return Promise.resolve(handle);
    // Bounded retries: after a failure, a reconnect (or a fresh message)
    // inside the backoff window must NOT reach the spawner again. The gate
    // rejects fast; the durable error was surfaced once per failure episode.
    if (spawnGate.isBlocked()) {
      return Promise.reject(new SpawnBackoffError(spawnGate.blockedFor()));
    }
    if (spawning === null) {
      const attempt = spawnGru();
      // Assign the gate BEFORE any settlement callback can run: a
      // synchronous throw inside spawnGru (corrupt resume pointer) would
      // otherwise complete its cleanup before the assignment lands —
      // pinning a rejected promise on the gate forever (r1 W4).
      spawning = attempt;
      void attempt
        .catch(() => {})
        .finally(() => {
          if (spawning === attempt) {
            spawning = null;
            broadcastContext();
            maybeWake();
          }
        });
    }
    return spawning;
  }

  async function spawnGru(): Promise<AgentHandle> {
    try {
      // Inside the try (r1 W4): a corrupt resume pointer must surface as
      // a spawn failure and CLEAR the spawn gate — not wedge it forever.
      const priorBoundary = options.pointer.current();
      const resumeFile = options.pointer.resumeCandidate();
      const replacingUnrecoverableBoundary =
        boundarySessionMissing || (priorBoundary !== null && resumeFile === null);
      boundarySessionMissing = replacingUnrecoverableBoundary;
      log('info', 'spawning the single Gru session', {
        resume: resumeFile !== null,
        replacing_unrecoverable_boundary: replacingUnrecoverableBoundary,
      });
      const spawned = await options.spawnGru(resumeFile);
      if (disposed) {
        // The server went down while the spawn was in flight — release the
        // session instead of wiring it into a dead server (r1 N9).
        await spawned.dispose().catch(() => {});
        throw new Error('chat server disposed during gru spawn');
      }
      let stagedUnsubscribe: (() => void) | null = null;
      try {
        if (spawned.sessionFile === null || spawned.sessionFile === '') {
          throw new Error('Gru chat session has no durable session file');
        }
        if (resumeFile !== null && !sameSessionFile(spawned.sessionFile, resumeFile)) {
          throw new Error('resumed Gru spawn changed native session identity');
        }
        if (spawned.health().state === 'disposed') {
          throw new Error('Gru spawn returned a disposed session');
        }
        stagedUnsubscribe = subscribeHandle(spawned);
        // A vanished pointed session means the replacement model has no
        // native memory of visible history. Advance the floor before
        // publishing the handle. With no pointer, durable model context was
        // never established; logged spawn failures/notices remain visible.
        const state = replacingUnrecoverableBoundary
          ? options.pointer.advance(spawned.sessionFile, frameLog.highWaterSeq)
          : options.pointer.record(spawned.sessionFile);
        epoch = state.epoch;
        replayFloorSeq = state.replayFloorSeq;
        boundarySessionMissing = false;
        handle = spawned;
        unsubscribe = stagedUnsubscribe;
        spawnGate.reset();
      } catch (error) {
        try {
          stagedUnsubscribe?.();
        } catch (unsubscribeError) {
          log('warn', 'staged Gru unsubscribe failed after spawn rejection', {
            error: String(unsubscribeError),
          });
        } finally {
          await spawned.dispose().catch(() => {});
        }
        throw error;
      }
      // Publish a repaired epoch before its queued notices. A live client
      // clears the retired view on this snapshot, then renders notices above
      // the new replay floor so they remain visible and replayable.
      broadcastContext();
      flushPendingNotices();
      log('info', 'gru session live', { session_file: spawned.sessionFile });
      return spawned;
    } catch (error) {
      const message = errorMessage(error);
      const retryInMs = spawnGate.recordFailure();
      const firstFailure = spawnGate.failureCount === 1;
      log('error', 'gru spawn failed', {
        error: message,
        consecutive_failures: spawnGate.failureCount,
        retry_in_ms: retryInMs,
      });
      if (firstFailure) {
        // ONE durable surface per failure episode (SPEC chat error class:
        // logged, never fatal). Later attempts within the episode log but
        // do not re-surface, so a broken model cannot flood chat.
        try {
          emitLogged({
            type: 'error',
            message:
              `Gru could not start: ${message}. Spawn retries are backed off ` +
              `(exponential, capped at ${spawnBackoffMaxMs} ms); send a message or ` +
              `reconnect after the window to retry.`,
          });
        } catch (surfaceError) {
          log('warn', 'failed to persist the spawn-failure surface', {
            error: errorMessage(surfaceError),
          });
        }
      }
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // Runtime events → frames (all logged, all broadcast)
  // -----------------------------------------------------------------------

  function emitLogged(frame: Parameters<ChatFrameLog['append']>[0]): LoggedFrame {
    const seqed = frameLog.append(frame);
    broadcast(seqed);
    return seqed;
  }

  function flushPendingNotices(): void {
    for (const notice of pendingNotices.splice(0)) {
      try {
        emitLogged({ type: 'notice', text: notice.text });
        notice.onPersist?.();
      } catch (error) {
        log('error', 'failed to persist a deferred Gru notice', {
          error: String(error),
        });
      }
    }
  }

  function settleOpenTurn(): void {
    for (const closing of frameLog.settleOpenTurn()) broadcast(closing);
    openCalls.clear();
    turnLive = false;
  }

  function subscribeHandle(source: AgentHandle): () => void {
    return source.subscribe((event) => {
      // A broken unsubscribe implementation must not let a retired runtime
      // mutate the newly active handle's chat state during disposal.
      if (handle === source) onRuntimeEvent(source, event);
    });
  }

  function onRuntimeEvent(source: AgentHandle, event: RuntimeEvent): void {
    switch (event.type) {
      case 'turn_start':
        turnLive = true;
        emitLogged({ type: 'turn', state: 'start' });
        broadcastContext();
        break;
      case 'turn_end':
        turnLive = false;
        // A fatal error may already have settled this turn — never log a
        // dangling end (replay would render a turn boundary out of nowhere).
        if (frameLog.hasOpenTurn) emitLogged({ type: 'turn', state: 'end' });
        broadcastContext();
        maybeWake();
        break;
      case 'compaction_start':
        runtimeCompacting = true;
        if (runtimeCompactionBarrier === null) {
          runtimeCompactionBarrier = new Promise<void>((resolve) => {
            resolveRuntimeCompaction = resolve;
          });
        }
        broadcastContext();
        break;
      case 'compaction_end': {
        settleRuntimeCompaction();
        const requested = manualCompaction;
        if (requested !== null && requested.source === source) {
          // One terminal authority for an explicit control: runControl waits
          // for this exact event and turns it into one correlated result.
          requested.resolve(event);
        } else {
          // Provider-initiated compaction has no request/control_result. Its
          // terminal outcome still belongs on every live user surface.
          broadcastContextEvent({
            type: 'context_event',
            action: 'compact',
            ok: event.success,
            ...(!event.success
              ? {
                  message: boundedControlMessage(
                    event.error?.trim() !== '' && event.error !== undefined
                      ? event.error
                      : 'Native compaction failed',
                  ),
                }
              : {}),
          });
        }
        broadcastContext();
        break;
      }
      case 'text_delta':
        emitLogged({ type: 'delta', text: event.delta });
        break;
      case 'thinking_delta':
        // The contract has no thinking frame; dropped at the boundary
        // (docs/CHAT.md). E6 transcript views own that surface later.
        break;
      case 'tool_start': {
        // r2 B2'': runtime-supplied strings are unvalidated upstream —
        // clamp BEFORE persisting (anything appendable must survive load).
        const tool = event.tool !== '' ? event.tool : 'unknown';
        openCalls.set(event.callId, tool);
        emitLogged({ type: 'tool', name: tool, state: 'start' });
        break;
      }
      case 'tool_end': {
        const name = openCalls.get(event.callId) ?? 'unknown';
        openCalls.delete(event.callId);
        emitLogged({ type: 'tool', name, state: 'end' });
        break;
      }
      case 'tool_update':
        break; // no contract frame for progress-without-completion
      case 'state':
        if (event.state === 'disposed') {
          // The runtime disposed the session (crash/supervision): the next
          // message respawns from the resume pointer, and a mid-flight
          // turn's event stream just died — settle now so the log never
          // ends inside an open turn (r1 N7).
          log('warn', 'gru session disposed — next message respawns it', {});
          teardownHandle();
          settleOpenTurn();
          broadcastContext();
        } else {
          // Provider health determines whether usage is trustworthy. State
          // transitions therefore invalidate/refresh the snapshot even when
          // no durable chat frame is produced.
          broadcastContext();
        }
        break;
      case 'queued':
        log('debug', 'chat delivery queued by the runtime layer', {
          reason: event.reason,
          owner: event.owner,
        });
        break;
      case 'error': {
        // r1 B2: the shipped client treats ANY fatal:true frame — live OR
        // replayed — as a pairing-fatal event and closes. Logged runtime
        // deaths therefore NEVER carry the flag (mock parity: the mock
        // never persists fatal frames); the settle frames below already
        // record that the turn died here. r2 B2'': clamp empty messages —
        // a degenerate adapter string must never brick the next boot.
        const message = event.error !== '' ? event.error : 'unknown runtime error';
        emitLogged({ type: 'error', message });
        if (event.fatal) settleOpenTurn();
        break;
      }
    }
  }

  function settleRuntimeCompaction(): void {
    runtimeCompacting = false;
    const resolve = resolveRuntimeCompaction;
    resolveRuntimeCompaction = null;
    runtimeCompactionBarrier = null;
    resolve?.();
  }

  function teardownHandle(): void {
    try {
      unsubscribe?.();
    } catch (error) {
      log('warn', 'Gru unsubscribe failed during teardown', { error: String(error) });
    } finally {
      unsubscribe = null;
      handle = null;
      settleRuntimeCompaction();
      openCalls.clear();
    }
  }

  function contextFrame(client: Client): ContextFrame {
    const active = handle;
    let health: AgentState | null = null;
    let healthProbeFailed = false;
    let nativeCompacting = runtimeCompacting;
    if (active !== null) {
      try {
        health = active.health().state;
        nativeCompacting ||= active.isCompacting?.() === true;
      } catch {
        healthProbeFailed = true;
        // Health/usage are advisory. A failed probe makes controls cautious
        // and usage unavailable; it must not disrupt the socket.
      }
    }
    const runtimeBusy =
      recoveryBlockedReason !== null ||
      healthProbeFailed ||
      spawning !== null ||
      pendingDeliveries > 0 ||
      turnLive ||
      frameLog.hasOpenTurn ||
      health === 'spawning' ||
      health === 'streaming';
    const state: ContextControlState =
      controlState !== 'idle'
        ? controlState
        : nativeCompacting
          ? 'compacting'
          : runtimeBusy
            ? 'busy'
            : 'idle';
    let usage: ContextFrame['usage'] = null;
    if (active !== null && state === 'idle' && active.getContextUsage !== undefined) {
      try {
        const measured =
          health === 'idle' || health === 'error' ? active.getContextUsage() : null;
        if (
          measured !== null &&
          Number.isFinite(measured.tokens) && measured.tokens >= 0 &&
          Number.isFinite(measured.contextWindow) && measured.contextWindow > 0 &&
          Number.isFinite(measured.percent)
        ) {
          usage = {
            tokens: measured.tokens,
            context_window: measured.contextWindow,
            percent: Math.max(0, Math.min(100, measured.percent)),
          };
        }
      } catch {
        // A provider usage probe is optional telemetry, never a chat failure.
      }
    }
    const sessionActive = active !== null && health !== 'disposed';
    let compactSupported = sessionActive && active?.compact !== undefined;
    if (compactSupported && active?.canCompact !== undefined) {
      try {
        compactSupported = active.canCompact();
      } catch {
        compactSupported = false;
      }
    }
    return {
      type: 'context',
      epoch,
      replay_floor_seq: replayFloorSeq,
      state,
      usage,
      compact_supported: compactSupported,
      session_active: sessionActive,
      writer: client.writer,
    };
  }

  function broadcastContext(): void {
    for (const client of clients) {
      if (client.authed) send(client, contextFrame(client));
    }
  }

  function broadcastContextEvent(frame: ContextEventFrame): void {
    for (const client of clients) {
      if (client.authed) send(client, frame);
    }
  }

  function controlResult(
    client: Client,
    frame: ControlFrame,
    ok: boolean,
    code?: ControlResultCode,
    message?: string,
  ): void {
    send(client, {
      type: 'control_result',
      action: frame.action,
      request_id: frame.request_id,
      ok,
      epoch,
      ...(code !== undefined ? { code } : {}),
      ...(message !== undefined && message !== ''
        ? { message: boundedControlMessage(message) }
        : {}),
    });
  }

  // -----------------------------------------------------------------------
  // Delivery (prompt when idle, steer mid-turn)
  // -----------------------------------------------------------------------

  /** Awareness context for one prompt; fail-soft — a broken awareness layer
   * must never take message delivery down. */
  function awarenessPrepare(): AwarenessInjection | null {
    if (options.awareness === undefined) return null;
    try {
      return options.awareness.prepare();
    } catch (error) {
      log('error', 'gru awareness prepare failed — delivering without service context', {
        error: errorMessage(error),
      });
      return null;
    }
  }

  function awarenessCommit(injection: AwarenessInjection): void {
    try {
      options.awareness?.commit(injection);
    } catch (error) {
      log('error', 'gru awareness commit failed — context may re-inject', {
        error: errorMessage(error),
      });
    }
  }

  /** Start a coalesced awareness turn when the lane is idle. A request that
   * arrives mid-turn or mid-wake waits for a trailing turn instead of
   * steering into a live conversation; settle hooks call back here. */
  function maybeWake(): void {
    if (disposed || !wakeRequested || wakeRunning || options.awareness === undefined) return;
    if (
      turnLive ||
      frameLog.hasOpenTurn ||
      pendingDeliveries > 0 ||
      spawning !== null ||
      controlBarrier !== null ||
      runtimeCompactionBarrier !== null ||
      recoveryBlockedReason !== null
    ) {
      return;
    }
    wakeRequested = false;
    wakeRunning = true;
    void deliver(null, '', undefined, true).finally(() => {
      wakeRunning = false;
      if (wakeRequested) maybeWake();
    });
  }

  /** SPEC ruling 19(d): the agent ALWAYS receives paths and reads the
   * files itself. The manifest appends the chip paths to the prompt
   * text — no bytes ever ride the prompt in the attach flow. When the
   * runtime cannot host vision (capabilities.images false, SPEC ruling
   * 4) an image chip triggers the GRACEFUL DECLINE: a visible notice for
   * the user + a never-guess instruction for the agent — never an error
   * frame, never a silent drop.
   *
   * `client` is null for an awareness wake (policy-started, no user
   * message: the injected block plus the wake instruction IS the prompt). */
  function deliver(
    client: Client | null,
    text: string,
    attachments?: readonly AttachmentChip[],
    wake = false,
  ): Promise<void> {
    pendingDeliveries += 1;
    broadcastContext();
    // Declared here so BOTH the task-level catch and the inner prompt
    // try/catch can see them (a catch block cannot read the try block's
    // locals — the r3 backstop needs to know what this delivery opened).
    let midTurn = false;
    let ownedOpenTurn = false;
    return (async () => {
      try {
        // Re-enter every current barrier after every await. Provider-native
        // compaction can begin after the user frame was durably acknowledged
        // but before a lazy session spawn returns.
        for (;;) {
          const barriers = activeDeliveryBarriers();
          if (barriers.length === 0) break;
          await (barriers.length === 1 ? barriers[0]! : Promise.all(barriers).then(() => {}));
        }
        if (disposed) return;
        if (recoveryBlockedReason !== null) {
          throw new Error('chat recovery is blocked; restart the service');
        }
        // A wake turn exists only to carry service context: with nothing to
        // inject, do not spawn a session or burn a model turn.
        let wakeInjection: AwarenessInjection | null = null;
        if (wake) {
          wakeInjection = awarenessPrepare();
          if (wakeInjection === null) {
            // Claimed by the policy but nothing left to say (the row was
            // closed in between): report it so the tracker sees the miss.
            options.awareness?.noteWakeOutcome?.(false, 'no awareness context to inject');
            return;
          }
        }
        // Chip-path provenance (review r1): only workspace/uploads paths
        // ride the manifest — a handcrafted chip pointing elsewhere drops
        // GRACEFULLY: a visible notice, never a silent pass, never an error.
        const allowed: AttachmentChip[] = [];
        const rejected: string[] = [];
        for (const chip of attachments ?? []) {
          if (
            chipPathAllowed(
              options.config.workspaceRoot,
              join(options.config.dataDir, 'uploads'),
              chip.path,
            )
          ) {
            allowed.push(chip);
          } else {
            rejected.push(chip.path);
          }
        }
        if (rejected.length > 0) {
          emitLogged({
            type: 'notice',
            text:
              `Attachment path not allowed (outside the workspace and uploads): ${rejected.join(', ')} — ` +
              'dropped from the message Gru receives.',
          });
        }
        if (text.trim() === '' && allowed.length === 0 && !wake) {
          emitLogged({
            type: 'notice',
            text:
              'No deliverable content remained after attachment validation — empty prompt skipped.',
          });
          return;
        }
        let gru: AgentHandle;
        for (;;) {
          try {
            gru = await ensureGru();
          } catch (error) {
            // Ephemeral: a transient spawn failure must not replay forever.
            if (client !== null) {
              send(client, ephemeralError('Gru is temporarily unavailable; retry after reconnect.'));
            }
            log('error', 'Gru delivery spawn failed', { error: errorMessage(error) });
            return;
          }
          const barriers = activeDeliveryBarriers();
          if (barriers.length > 0) {
            await (barriers.length === 1 ? barriers[0]! : Promise.all(barriers).then(() => {}));
            if (disposed) return;
            continue;
          }
          if (recoveryBlockedReason !== null) {
            throw new Error('chat recovery is blocked; restart the service');
          }
          // A supervisor swap can replace the handle while ensureGru awaits.
          if (handle !== gru) continue;
          break;
        }
        const imageChips = allowed.filter((chip) => chip.kind === 'image');
        const visionUnavailable = imageChips.length > 0 && !gru.capabilities.images;
        if (visionUnavailable) {
          emitLogged({
            type: 'notice',
            text:
              `Vision is unavailable on the current model — ${imageChips.length} image attachment(s) ` +
              'sent as paths only; Gru is instructed not to guess at their contents.',
          });
        }
        try {
          if (turnLive) {
            if (wake) {
              // Lost the idle race to a user turn: requeue the wake for the
              // next idle point instead of steering into the conversation.
              wakeRequested = true;
              return;
            }
            midTurn = true;
            // A steer rides the LIVE turn, so no new turn is opened and no
            // injection rides it — the block stays queued for the next prompt.
            await gru.steer(
              composeDeliveredPrompt(text, allowed.length > 0 ? allowed : undefined, visionUnavailable),
              { owner: CHAT_OWNER },
            );
          } else {
            const injection = wake ? wakeInjection : awarenessPrepare();
            const baseText =
              injection === null
                ? text
                : wake
                  ? `${injection.text}\n\n${AWARENESS_WAKE_INSTRUCTION}`
                  : text === ''
                    ? injection.text
                    : `${injection.text}\n\n${text}`;
            const prompt = composeDeliveredPrompt(
              baseText,
              allowed.length > 0 ? allowed : undefined,
              visionUnavailable,
            );
            ownedOpenTurn = true;
            turnLive = true; // optimistic: the turn_start event confirms
            await gru.prompt(prompt, { owner: CHAT_OWNER });
            turnLive = false;
            // Receipt only after the turn accepted the block: a failed
            // delivery retries the same context on the next turn.
            if (injection !== null) awarenessCommit(injection);
            // The policy-started turn opened — the wake-observability
            // receipt the self-heal trackers count.
            if (wake) options.awareness?.noteWakeOutcome?.(true);
          }
        } catch (error) {
          const message = (error as Error).message;
          const dead = /disposed/.test(message);
          if (dead) teardownHandle();
          if (wake) {
            // An autonomous turn failing is an operational degradation, not
            // a user message failure — say so durably; the queued context
            // rides the next user message.
            options.awareness?.noteWakeOutcome?.(false, message);
            emitLogged({
              type: 'notice',
              text:
                `Gru awareness: automatic turn failed (${boundedControlMessage(message)}); ` +
                'the context will ride the next message.',
            });
          } else {
            // Conversation-relevant (this message failed to deliver) → logged.
            emitLogged({ type: 'error', message: `message delivery failed: ${message}` });
          }
          // Settle only when the turn is actually over (r1 W2): our prompt
          // dying, or a disposed session, ends the event stream — close the
          // log. A rejected STEER leaves the live runtime turn running:
          // record the failure, never close over it.
          if (dead || !midTurn) {
            turnLive = false;
            settleOpenTurn();
          }
        }
      } catch (error) {
        // Backstop (r3 blocker): this task used to have try/finally only, so
        // a failed frame-log append (ENOSPC/EACCES) or the recovery-blocked
        // guard rejected unhandled — and the service exits on unhandled
        // rejections. One disk hiccup must never kill chat: log it, settle
        // only the turn THIS delivery opened, and report a bounded error
        // frame through whichever channel still works.
        log('error', 'chat delivery failed', { error: errorMessage(error) });
        if (ownedOpenTurn && turnLive) {
          try {
            settleOpenTurn();
          } catch (settleError) {
            log('warn', 'chat turn settlement failed during delivery failure', {
              error: errorMessage(settleError),
            });
            turnLive = false;
          }
        }
        const message = recoveryBlockedReason !== null
          ? 'chat recovery is blocked; restart the service to continue messaging'
          : 'message delivery failed; the conversation stays usable — re-send if needed';
        try {
          emitLogged({ type: 'error', message });
        } catch (appendError) {
          // The durable log is the failing surface — degrade to an ephemeral
          // per-socket frame instead of dying; retry transport recovers the
          // unacked/outbox word client-side.
          log('error', 'chat delivery failure could not be logged durably', {
            error: errorMessage(appendError),
          });
          if (client !== null) send(client, ephemeralError(message));
        }
      } finally {
        pendingDeliveries -= 1;
        broadcastContext();
        maybeWake();
      }
    })().catch((error: unknown) => {
      // Every operational failure is handled inside the body; this guard is
      // for a bug in the failure path itself — an unhandled rejection would
      // kill the service (main exits on unhandled rejections).
      log('error', 'chat delivery crashed', { error: errorMessage(error) });
    });
  }

  // -----------------------------------------------------------------------
  // Connection lifecycle
  // -----------------------------------------------------------------------

  function send(client: Client, frame: ServerFrame): void {
    if (client.socket.readyState === WebSocket.OPEN) {
      client.socket.send(JSON.stringify(frame));
    }
  }

  function broadcast(frame: LoggedFrame): void {
    for (const client of clients) {
      if (client.authed) send(client, frame);
    }
  }

  /** r2 W2': the writer's own `user` frame is NOT echoed back live — the
   * client renders its message locally at send, the mock never live-sends
   * user frames, and history restores it on replay for everyone. */
  function broadcastExceptSender(frame: LoggedFrame, sender: Client): void {
    for (const client of clients) {
      if (client.authed && client !== sender) send(client, frame);
    }
  }

  function sendError(client: Client, frame: ErrorFrame, logIt: boolean): void {
    if (logIt && !frame.fatal) {
      // seq'd + logged (replays reach everyone later); live it goes only
      // to the offending socket — mock parity.
      send(client, frameLog.append({ type: 'error', message: frame.message }));
      return;
    }
    send(client, frame);
  }

  function onConnection(socket: WebSocket): void {
    const client: Client = {
      socket,
      authed: false,
      writer: false,
      authedAt: 0,
      pongMisses: 0,
      authDeadline: null,
      deferredFailed: false,
    };
    clients.add(client);
    client.authDeadline = setTimeout(() => {
      if (!client.authed) {
        send(client, ephemeralError('auth timeout: first frame must be auth', true));
        socket.close();
      }
    }, authDeadlineMs);

    socket.on('pong', () => {
      client.pongMisses = 0;
    });
    socket.on('message', (data: unknown) => {
      const frame = parseClientFrame(String(data));
      if (frame === null) {
        // r1 W1: an UNAUTHENTICATED socket must never write to the durable
        // log — pre-auth protocol errors are ephemeral (client-visible,
        // same shape); the auth deadline still bounds the connection.
        if (client.authed) {
          sendError(client, ephemeralError('malformed frame'), true);
        } else {
          send(client, ephemeralError('malformed frame'));
        }
        return;
      }
      if (!client.authed) {
        handlePreAuth(client, frame, socket);
        return;
      }
      if (frame.type === 'auth') {
        sendError(client, ephemeralError('already authenticated'), true);
        return;
      }
      if (frame.type === 'control') {
        handleControlFrame(client, frame);
        return;
      }
      queueUserFrame(client, frame);
    });
    socket.on('close', () => {
      if (client.authDeadline !== null) clearTimeout(client.authDeadline);
      const heldPen = client.writer;
      client.authed = false;
      client.writer = false;
      clients.delete(client);
      if (heldPen) promotePen();
    });
    socket.on('error', (error: Error) => {
      // A broken client socket must never take the service down.
      log('debug', 'chat client socket error', { error: String(error) });
    });
  }

  function handlePreAuth(client: Client, frame: ClientFrame, socket: WebSocket): void {
    if (frame.type !== 'auth') {
      send(client, ephemeralError('first frame must be auth', true));
      socket.close();
      return;
    }
    if (client.authDeadline !== null) {
      clearTimeout(client.authDeadline);
      client.authDeadline = null;
    }
    if (!tokenConfigured) {
      send(client, ephemeralError('chat is not configured: set auth.token in the service config', true));
      socket.close();
      return;
    }
    if (!tokenMatches(frame.token, tokenHash)) {
      log('warn', 'chat auth rejected: bad token', {});
      send(client, ephemeralError('unauthorized: bad token', true));
      socket.close();
      return;
    }
    client.authed = true;
    client.authedAt = Date.now();
    client.writer = ![...clients].some((other) => other.authed && other.writer);
    const highWater = frameLog.highWaterSeq;
    send(client, { type: 'auth_ok', seq: highWater });
    // The fresh control snapshot precedes replay. It carries the durable
    // epoch/floor so a client can reset its active view before old frames
    // have any chance to render.
    send(client, contextFrame(client));
    // Synchronous block: the replay snapshot covers exactly seqs ≤ the
    // high-water mark; live frames (> high-water) arrive after it by
    // per-socket FIFO — gapless by the seq-continuity invariant.
    for (const replayed of frameLog.replayAfter(frame.last_seen_seq ?? 0, replayFloorSeq)) {
      send(client, replayed);
    }
    log('info', 'chat client authenticated', {
      writer: client.writer,
      last_seen_seq: frame.last_seen_seq ?? 0,
      high_water_seq: highWater,
      epoch,
      replay_floor_seq: replayFloorSeq,
    });
  }

  function handleControlFrame(client: Client, frame: ControlFrame): void {
    const reject = (code: ControlResultCode, message: string): void => {
      controlResult(client, frame, false, code, message);
      // Reconcile the browser's optimistic progress state even when the
      // request is rejected before a control lifecycle (and therefore has no
      // terminal finally/broadcast of its own).
      send(client, contextFrame(client));
    };
    if (!client.writer) {
      reject('read_only', 'another client holds the pen');
      return;
    }
    const snapshot = contextFrame(client);
    if (
      disposed ||
      recoveryBlockedReason !== null ||
      controlBarrier !== null ||
      snapshot.state !== 'idle'
    ) {
      reject('busy', 'chat is busy');
      return;
    }
    if (frame.action === 'compact') {
      if (handle === null) {
        reject('no_session', 'no active Gru session');
        return;
      }
      if (handle.compact === undefined || !snapshot.compact_supported) {
        reject('unsupported', 'native compaction is unavailable for the current session');
        return;
      }
    }

    controlState = frame.action === 'compact' ? 'compacting' : 'resetting';
    broadcastContext();
    const lifecycle = runControl(frame)
      .then(() => controlResult(client, frame, true))
      .catch((error: unknown) => {
        controlResult(
          client,
          frame,
          false,
          'failed',
          error instanceof Error ? error.message : String(error),
        );
      })
      .finally(() => {
        controlState = 'idle';
        if (disposed) {
          pendingNotices.length = 0;
          return;
        }
        flushPendingNotices();
        broadcastContext();
        if (recoveryBlockedReason !== null) {
          // control_result and the canonical blocked snapshot are queued
          // first; then every accepted client reconnects only after an
          // explicit service-level recovery.
          setTimeout(() => {
            for (const connected of clients) {
              if (!connected.authed) continue;
              try {
                connected.socket.close(1011, 'chat recovery requires service restart');
              } catch {
                /* already gone */
              }
            }
          }, 0).unref();
        }
      });
    // Deferred user frames continue only AFTER the terminal result and fresh
    // idle/epoch snapshot have been queued to sockets. That ordering lets a
    // client clear the retired epoch before an accepted new-epoch user echo.
    controlBarrier = lifecycle.then(
      () => {
        controlBarrier = null;
        maybeWake();
      },
      () => {
        controlBarrier = null;
        maybeWake();
      },
    );
  }

  function withControlDeadline<T>(operation: Promise<T>, label: string): Promise<T> {
    if (controlTimeoutMs <= 0) return operation;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ControlTimeoutError(label, controlTimeoutMs));
      }, controlTimeoutMs);
      timer.unref();
      operation.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  function blockChatRecovery(reason: string, detail: unknown): void {
    recoveryBlockedReason = reason;
    log('error', 'chat recovery blocked after native writer uncertainty', {
      reason,
      error: errorMessage(detail),
    });
    broadcastContext();
  }

  async function retireAndResumeAfterCompactTimeout(
    active: AgentHandle,
    timeout: ControlTimeoutError,
  ): Promise<never> {
    // Detach first: a late native event or a newly arrived message must never
    // target the handle being aborted. The surrounding control barrier stays
    // closed until bounded disposal confirms the native writer is gone.
    if (handle === active) teardownHandle();
    try {
      await withControlDeadline(active.dispose(), 'timed-out Gru disposal');
    } catch (error) {
      blockChatRecovery(
        'Native compaction timed out and the old session could not be retired; restart the service to recover safely.',
        error,
      );
      throw new Error('native compaction recovery is blocked');
    }
    if (disposed) throw timeout;
    const recovery = ensureGru();
    try {
      await withControlDeadline(recovery, 'committed-session recovery');
      recoveryBlockedReason = null;
    } catch (error) {
      blockChatRecovery(
        'Native compaction timed out and the committed session could not be resumed; restart the service to recover safely.',
        error,
      );
      // A safe resume that merely exceeded the deadline may still settle.
      // Clear the block only after that exact committed-session spawn wins.
      void recovery.then(
        () => {
          if (!disposed) {
            recoveryBlockedReason = null;
            broadcastContext();
          }
        },
        () => {},
      );
      throw new Error('native compaction recovery is blocked');
    }
    throw timeout;
  }

  async function finalizeCommittedNewChat(
    staged: AgentHandle,
    retired: AgentHandle | null,
  ): Promise<void> {
    if (disposed) return;
    try {
      if (options.adoptFreshGru !== undefined) {
        await withControlDeadline(
          options.adoptFreshGru(staged),
          'fresh Gru supervision adoption',
        );
      } else if (retired !== null && retired !== staged) {
        await withControlDeadline(retired.dispose(), 'retired Gru disposal');
      }
      log('info', 'new chat post-commit supervision settled', {
        epoch,
        session_file: staged.sessionFile,
      });
    } catch (error) {
      // The durable boundary is already committed and the control result has
      // been released. Report bounded degradation separately; never pin the
      // reset barrier behind supervisor or retired-handle cleanup.
      log('error', 'new chat post-commit supervision degraded', {
        error: errorMessage(error),
        session_file: staged.sessionFile,
      });
      let stagedDisposed = false;
      try {
        stagedDisposed = staged.health().state === 'disposed';
      } catch {
        stagedDisposed = true;
      }
      if (stagedDisposed && handle === staged) teardownHandle();
      broadcastContextEvent({
        type: 'context_event',
        action: 'new_chat',
        ok: false,
        message: 'New chat started, but supervision is degraded; restart the service if chat becomes unavailable.',
      });
      broadcastContext();
    }
  }

  async function runControl(frame: ControlFrame): Promise<void> {
    if (frame.action === 'compact') {
      const active = handle;
      if (active === null || active.compact === undefined) {
        throw new Error('native compaction is unavailable');
      }
      let resolveTerminal!: (
        event: Extract<RuntimeEvent, { type: 'compaction_end' }>,
      ) => void;
      const terminal = new Promise<Extract<RuntimeEvent, { type: 'compaction_end' }>>(
        (resolveTerminalPromise) => {
          resolveTerminal = resolveTerminalPromise;
        },
      );
      const requested = { source: active, resolve: resolveTerminal };
      manualCompaction = requested;
      const nativeCompact = Promise.resolve().then(() => active.compact!());
      const operation = Promise.all([nativeCompact, terminal]).then(([, outcome]) => {
        if (!outcome.success) {
          throw new Error(outcome.error ?? 'native compaction failed');
        }
      });
      try {
        await withControlDeadline(operation, 'native compaction');
      } catch (error) {
        if (error instanceof ControlTimeoutError) {
          await retireAndResumeAfterCompactTimeout(active, error);
        }
        throw error;
      } finally {
        if (manualCompaction === requested) manualCompaction = null;
        // A broken adapter cannot leave an advisory lifecycle gate pinned.
        // The explicit control result above remains authoritative.
        settleRuntimeCompaction();
      }
      return;
    }

    const old = handle;
    const priorSessionFile = options.pointer.current()?.sessionFile ?? null;
    let staged: AgentHandle | null = null;
    try {
      const freshSpawn = options.spawnFreshGru();
      try {
        staged = await withControlDeadline(freshSpawn, 'fresh Gru spawn');
      } catch (error) {
        if (error instanceof ControlTimeoutError) {
          // The spawn itself cannot be cancelled. Clean up a late NEW handle,
          // but never dispose the still-active old handle if a buggy spawner
          // eventually returns it.
          void freshSpawn
            .then((late) => {
              // A buggy late result may be a distinct wrapper over either the
              // captured retiring session or whatever session is active now.
              // Never dispose an alias of a live native writer.
              if (sameNativeSession(late, old) || sameNativeSession(late, handle)) return;
              return late.dispose();
            })
            .catch(() => {});
        }
        throw error;
      }
      if (disposed) throw new Error('chat server disposed during new chat');
      if (staged.sessionFile === null || staged.sessionFile === '') {
        throw new Error('fresh Gru session has no durable session file');
      }
      if (
        staged === old ||
        staged.id === old?.id ||
        sameSessionFile(staged.sessionFile, old?.sessionFile) ||
        sameSessionFile(staged.sessionFile, priorSessionFile)
      ) {
        throw new Error('fresh Gru spawn reused the active native session');
      }
      if (staged.health().state === 'disposed') {
        throw new Error('fresh Gru session was disposed before activation');
      }
      // Prepare the event subscription before the durable activation point;
      // a throwing adapter cannot advance the epoch and then report failure.
      const stagedUnsubscribe = subscribeHandle(staged);
      let activated = false;
      try {
        let oldNativeCompacting = runtimeCompacting;
        try {
          oldNativeCompacting ||= old?.isCompacting?.() === true;
        } catch {
          oldNativeCompacting = true;
        }
        // Revalidate every retirement invariant after the fallible mint. A
        // turn, provider compaction, or supervisor swap that won meanwhile
        // keeps the old durable boundary authoritative.
        if (
          handle !== old ||
          turnLive ||
          frameLog.hasOpenTurn ||
          oldNativeCompacting
        ) {
          throw new Error('retiring Gru became active during fresh-session spawn');
        }
        if (options.canAdoptFreshGru?.() === false) {
          throw new Error('supervision breaker is open; acknowledge it before starting a new chat');
        }
        // This one atomic rename is the activation point: session identity,
        // epoch, and replay floor move together. Old logs/sessions are untouched.
        const state = options.pointer.advance(staged.sessionFile, frameLog.highWaterSeq);
        epoch = state.epoch;
        replayFloorSeq = state.replayFloorSeq;
        boundarySessionMissing = false;
        activated = true;
      } finally {
        if (!activated) stagedUnsubscribe();
      }

      try {
        unsubscribe?.();
      } catch (error) {
        log('warn', 'retired Gru unsubscribe failed during new chat', { error: String(error) });
      }
      unsubscribe = stagedUnsubscribe;
      handle = staged;
      settleRuntimeCompaction();
      turnLive = false;
      openCalls.clear();
      // Publish the committed epoch before any await below. Otherwise a
      // concurrent durable notice can be rendered into the retiring view,
      // then cleared by the delayed boundary snapshot and never shown again.
      broadcastContext();

      // Post-commit adoption/retirement is best-effort and independently
      // bounded. Start it on the next event-loop turn so this control's
      // result, idle snapshot, and barrier release are queued first even if a
      // supplied adopter throws synchronously.
      const committed = staged;
      const postCommit = setTimeout(() => {
        void finalizeCommittedNewChat(committed, old);
      }, 0);
      postCommit.unref();
      log('info', 'new chat activated', {
        epoch,
        replay_floor_seq: replayFloorSeq,
        session_file: staged.sessionFile,
      });
    } catch (error) {
      if (staged !== null && staged !== old && handle !== staged) {
        try {
          await withControlDeadline(staged.dispose(), 'rejected fresh Gru disposal');
        } catch (cleanupError) {
          log('warn', 'rejected fresh Gru cleanup did not settle', {
            error: errorMessage(cleanupError),
          });
        }
      }
      throw error;
    }
  }

  function activeDeliveryBarriers(): Promise<void>[] {
    return [controlBarrier, runtimeCompactionBarrier].filter(
      (pending): pending is Promise<void> => pending !== null,
    );
  }

  function failDeferredUserFrame(client: Client, error: unknown): void {
    if (client.deferredFailed) return;
    if (error instanceof SpawnBackoffError) {
      // Bounded fail-fast: do NOT mark the socket poisoned or close it — a
      // close is the reconnect trigger, and every reconnect re-sends the
      // unacked word. The word stays in the browser outbox and rides the
      // next reconnect once the gate opens; the one durable surface for
      // this episode already named the cause and the backoff policy.
      log('warn', 'deferred chat frame rejected during spawn backoff', {
        retry_in_ms: error.retryInMs,
      });
      send(
        client,
        ephemeralError(
          'Gru is temporarily unavailable (spawn retries are backed off); ' +
            'your message stays queued — retry after the next reconnect.',
        ),
      );
      return;
    }
    client.deferredFailed = true;
    log('error', 'deferred chat frame failed', { error: errorMessage(error) });
    send(client, ephemeralError('Chat delivery could not be reconciled; reconnecting safely.'));
    // A frame accepted behind a mutable boundary has no ack. Closing forces
    // the persisted browser outbox through authoritative epoch reconciliation
    // instead of retrying blindly in a potentially different chat.
    try {
      client.socket.close(1011, 'deferred chat delivery failed');
    } catch {
      /* already gone */
    }
  }

  async function processDeferredUserFrame(
    client: Client,
    frame: UserFrame,
  ): Promise<void> {
    let repairingMissingBoundary = boundarySessionMissing;
    for (;;) {
      if (disposed || !client.authed || client.deferredFailed) return;
      if (recoveryBlockedReason !== null) {
        throw new Error('chat recovery is blocked');
      }
      // Re-read both barriers after every await. A second provider compaction
      // or control may have started while the frame waited behind the first.
      const barriers = activeDeliveryBarriers();
      if (barriers.length > 0) {
        await (barriers.length === 1 ? barriers[0]! : Promise.all(barriers).then(() => {}));
        continue;
      }
      if (handle === null && !boundarySessionMissing) {
        // Detect a vanished pointed session before logging the frame. Pointer
        // read errors also take the same no-ack recovery path below.
        const pointed = options.pointer.current();
        boundarySessionMissing = pointed !== null && options.pointer.resumeCandidate() === null;
        repairingMissingBoundary ||= boundarySessionMissing;
      }
      if (handle === null) {
        pendingDeliveries += 1;
        broadcastContext();
        try {
          await ensureGru();
        } finally {
          pendingDeliveries -= 1;
          broadcastContext();
        }
        // ensureGru may have advanced an unrecoverable boundary and a control
        // may have begun during its await. Revalidate from the top.
        continue;
      }
      // A frame that arrived validly and itself discovered a vanished native
      // boundary follows that repair into the newly minted epoch. This is
      // distinct from a stale resend arriving after an already-committed New
      // chat, which fails the strict epoch check below.
      handleUserFrame(
        client,
        repairingMissingBoundary && frame.epoch !== epoch
          ? { ...frame, epoch }
          : frame,
      );
      return;
    }
  }

  /** Frames arriving while a control is active are held before logging or
   * delivery. Authorization is fixed at arrival, while every mutable runtime
   * gate is revalidated after waits. Deferred processing is one FIFO chain so
   * a failed predecessor can never be overtaken by a later accepted frame. */
  function queueUserFrame(client: Client, frame: UserFrame): void {
    if (!client.writer) {
      send(client, ephemeralError('read-only: another client holds the pen'));
      return;
    }
    if (client.deferredFailed || recoveryBlockedReason !== null) {
      failDeferredUserFrame(client, new Error('chat recovery is blocked'));
      return;
    }
    const barriers = activeDeliveryBarriers();
    if (barriers.length === 0 && handle !== null && deferredControlFrames === 0) {
      try {
        handleUserFrame(client, frame);
      } catch (error) {
        failDeferredUserFrame(client, error);
      }
      return;
    }
    if (deferredControlFrames >= MAX_DEFERRED_CONTROL_FRAMES) {
      send(client, ephemeralError('too many messages are waiting; reconnecting to retry safely.'));
      client.deferredFailed = true;
      try {
        client.socket.close(1013, 'chat recovery queue full');
      } catch {
        /* already gone */
      }
      return;
    }
    deferredControlFrames += 1;
    const task = deferredFrameTail.then(() => processDeferredUserFrame(client, frame));
    deferredFrameTail = task.catch(() => {});
    void task
      .catch((error: unknown) => failDeferredUserFrame(client, error))
      .finally(() => {
        deferredControlFrames -= 1;
      });
  }

  /** Dedup by epoch + client_msg_id. The server, not the official browser,
   * enforces that stale old-epoch resends never enter a fresh conversation. */
  function handleUserFrame(client: Client, frame: UserFrame): void {
    if (frame.epoch !== epoch) {
      throw new Error(
        `user frame epoch ${frame.epoch} does not match active epoch ${epoch}`,
      );
    }
    if (frameLog.hasSeenUserId(frame.client_msg_id, frame.epoch, replayFloorSeq)) {
      send(client, frameLog.append({ type: 'ack', client_msg_id: frame.client_msg_id }));
      return;
    }
    const loggedUser = frameLog.append({
      type: 'user',
      text: frame.text,
      client_msg_id: frame.client_msg_id,
      epoch: frame.epoch,
      ...(frame.attachments !== undefined ? { attachments: frame.attachments } : {}),
    });
    broadcastExceptSender(loggedUser, client);
    send(client, frameLog.append({ type: 'ack', client_msg_id: frame.client_msg_id }));
    void deliver(client, frame.text, frame.attachments);
  }

  /** The pen promotes to the earliest AUTHENTICATED reader (r1 N6):
   * auth order, not connection order — a slow-to-auth early socket must
   * not jump a later one that paired first. */
  function promotePen(): void {
    let best: Client | null = null;
    for (const candidate of clients) {
      if (!candidate.authed) continue;
      if (best === null || candidate.authedAt < best.authedAt) best = candidate;
    }
    if (best !== null) {
      best.writer = true;
      broadcastContext();
      log('info', 'chat pen promoted to the next client', {});
    }
  }

  // -----------------------------------------------------------------------
  // Heartbeat (transport-level ping/pong — invisible to the JSON contract)
  // -----------------------------------------------------------------------

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      for (const client of clients) {
        // Two unanswered pings → the socket is silently dead: terminate so
        // the pen can promote (a live-but-pongless writer would hold it
        // forever). Doc and code agree on "two misses" (r1 N2).
        if (client.pongMisses >= 2) {
          log('info', 'chat client missed heartbeats — terminating', {});
          client.socket.terminate();
          continue;
        }
        client.pongMisses += 1;
        client.socket.ping();
        // Application-level keepalive (contract parity with the web
        // client): the browser cannot observe transport pings, so a JSON
        // ping is the client's liveness evidence. Never logged/replayed;
        // outbox and seq reconciliation never see it.
        send(client, { type: 'ping' });
      }
    }, heartbeatMs);
    heartbeat.unref();
  }

  wss.on('connection', onConnection);

  /** The bound upgrade handler + its server, so dispose can detach —
   * otherwise post-shutdown upgrades reach a closed wss as zombies. */
  let attached: {
    readonly server: HttpServer;
    readonly handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  } | null = null;

  return {
    attach(httpServer: HttpServer): void {
      const handler = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
        let path = '';
        try {
          path = new URL(request.url ?? '/', 'http://localhost').pathname;
        } catch {
          socket.destroy();
          return;
        }
        if (path !== WS_PATH) {
          // Not ours: a declared sibling surface (the board's /board/ws,
          // E6) may claim this upgrade — pass it. Anything else is still
          // destroyed (stray upgrades never linger on a chat-only server).
          if (!siblingUpgradePaths.has(path)) socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      };
      httpServer.on('upgrade', handler);
      attached = { server: httpServer, handler };
    },

    warmup(): void {
      void ensureGru().catch((error: unknown) => {
        // Logged (r1 W4): a warm boot failure is an ops-visible condition —
        // the first message retries (bounded by the spawn-retry gate), but
        // the boot log must say why.
        log('warn', 'gru warmup failed — retries are backed off', {
          error: String(error),
        });
      });
    },

    surfaceNotice(text: string, onPersist?: () => void): boolean {
      if (disposed || text === '') return false;
      if (controlState === 'resetting' || boundarySessionMissing) {
        // New chat commits its replay floor while resetting. Delay notices so
        // an action-required alert can never be logged below that floor.
        if (pendingNotices.length >= MAX_PENDING_NOTICES) {
          log('warn', 'rejecting notice because the reset notice queue is full', {});
          return false;
        }
        pendingNotices.push({ text, ...(onPersist !== undefined ? { onPersist } : {}) });
        return true;
      }
      // Logged first (the log is the source of replay), broadcast second —
      // the standard emitLogged contract. A notice never opens a turn.
      emitLogged({ type: 'notice', text });
      onPersist?.();
      return true;
    },

    wakeAwareness(): void {
      if (disposed || options.awareness === undefined) return;
      wakeRequested = true;
      maybeWake();
    },

    adoptRestartedGru(next: AgentHandle): void {
      if (disposed) return;
      // A restart begun before an intentional New chat must never swap the
      // retired epoch back in. The durable pointer is the activation truth.
      const activeFile = options.pointer.current()?.sessionFile ?? null;
      if (activeFile !== null && !sameSessionFile(activeFile, next.sessionFile)) {
        log('warn', 'ignoring stale supervisor Gru swap', {
          active_session_file: activeFile,
          stale_session_file: next.sessionFile,
        });
        void next.dispose().catch(() => {});
        return;
      }
      if (next.sessionFile === null || next.sessionFile === '') {
        log('error', 'ignoring supervisor Gru swap without a durable session file', {});
        void next.dispose().catch(() => {});
        return;
      }
      // Stage the new subscription before retiring the old one. A throwing
      // adapter must not leave chat advertising an unsubscribed handle.
      let nextUnsubscribe: () => void;
      try {
        nextUnsubscribe = subscribeHandle(next);
      } catch (error) {
        log('error', 'ignoring supervisor Gru swap whose subscription failed', {
          error: String(error),
        });
        void next.dispose().catch(() => {});
        return;
      }
      // A supervisor restart replaced the handle: re-wire this server's
      // subscription + pointer. The old handle was disposed by the
      // supervisor (its pending prompts already rejected).
      try {
        unsubscribe?.();
      } catch (error) {
        log('warn', 'Gru unsubscribe failed during supervisor adoption', { error: String(error) });
      }
      unsubscribe = nextUnsubscribe;
      settleRuntimeCompaction();
      handle = next;
      const state = options.pointer.record(next.sessionFile);
      epoch = state.epoch;
      replayFloorSeq = state.replayFloorSeq;
      // The restarted session may have been mid-conversation: close any
      // turn the OLD handle left open in the frame log so replay stays
      // settled, then tell the user what happened.
      settleOpenTurn();
      emitLogged({
        type: 'notice',
        text: 'Gru session restarted by the supervisor — conversation resumed from the durable session file.',
      });
      broadcastContext();
      log('info', 'adopted supervisor-restarted gru session', {
        session_file: next.sessionFile,
      });
    },

    async dispose(): Promise<void> {
      disposed = true;
      if (attached !== null) {
        attached.server.off('upgrade', attached.handler);
        attached = null;
      }
      if (heartbeat !== null) clearInterval(heartbeat);
      for (const client of clients) {
        if (client.authDeadline !== null) clearTimeout(client.authDeadline);
        try {
          client.socket.close(1001, 'service shutting down');
        } catch {
          /* already gone */
        }
      }
      clients.clear();
      await new Promise<void>((resolveClose) => {
        wss.close(() => resolveClose());
      });
      try {
        unsubscribe?.();
      } catch (error) {
        log('warn', 'Gru unsubscribe failed during chat shutdown', { error: String(error) });
      }
      unsubscribe = null;
      handle = null;
    },
  };
}
