import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { GruCommandConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { AgentHandle, RuntimeEvent } from '../runtime/types.js';
import type { ChatFrameLog } from './frame-log.js';
import {
  WS_PATH,
  ephemeralError,
  parseClientFrame,
  type ClientFrame,
  type ErrorFrame,
  type LoggedFrame,
  type ServerFrame,
  type UserFrame,
} from './frames.js';
import type { GruSessionPointer } from './session-state.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/** Prompts from the chat surface share one owner — the single user (SPEC ruling 1). */
const CHAT_OWNER = 'chat';

export interface ChatServerOptions {
  readonly config: GruCommandConfig;
  readonly frameLog: ChatFrameLog;
  readonly pointer: GruSessionPointer;
  /** Spawn (or resume) the single Gru session. Injected: the chat layer
   * never touches a concrete adapter or the registry (runtime-agnostic). */
  readonly spawnGru: (resumeFile: string | null) => Promise<AgentHandle>;
  readonly log?: Log;
  /** First-frame-must-be-auth deadline (mock parity: 5 000 ms). */
  readonly authDeadlineMs?: number;
  /** Transport heartbeat interval; 0 disables. Default 30 000 ms. */
  readonly heartbeatMs?: number;
  /** ws payload cap — the client caps messages at 4 000 chars; 64 KiB is generous. */
  readonly maxPayloadBytes?: number;
}

export interface ChatServer {
  /** Hook the HTTP server's `upgrade` event (path-gated to /ws). */
  attach(httpServer: HttpServer): void;
  /** Best-effort Gru spawn at boot; failures are logged, never fatal. */
  warmup(): void;
  /** Close every client and stop timers; the agent handle is NOT disposed
   * here — the registry owns it (shutdown ladder disposes chat first). */
  dispose(): Promise<void>;
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
  const tokenHash = hashToken(options.config.auth.token);
  const tokenConfigured = options.config.auth.token !== '';

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: options.maxPayloadBytes ?? 64 * 1024,
  });
  const clients = new Set<Client>();

  let handle: AgentHandle | null = null;
  let unsubscribe: (() => void) | null = null;
  let spawning: Promise<AgentHandle> | null = null;
  /** Set by dispose(): a spawn completing after teardown is released, not
   * wired into a dead server (r1 N9). */
  let disposed = false;
  /** True from a prompt delivery until the turn end lands (or the prompt
   * rejects) — the steer-vs-prompt decision for the NEXT message. */
  let turnLive = false;
  /** callId → tool name, for tool_end frames (the contract carries names). */
  const openCalls = new Map<string, string>();

  // -----------------------------------------------------------------------
  // Gru session lifecycle
  // -----------------------------------------------------------------------

  function ensureGru(): Promise<AgentHandle> {
    if (handle !== null) return Promise.resolve(handle);
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
          if (spawning === attempt) spawning = null;
        });
    }
    return spawning;
  }

  async function spawnGru(): Promise<AgentHandle> {
    try {
      // Inside the try (r1 W4): a corrupt resume pointer must surface as
      // a spawn failure and CLEAR the spawn gate — not wedge it forever.
      const resumeFile = options.pointer.resumeCandidate();
      log('info', 'spawning the single Gru session', {
        resume: resumeFile !== null,
      });
      const spawned = await options.spawnGru(resumeFile);
      if (disposed) {
        // The server went down while the spawn was in flight — release the
        // session instead of wiring it into a dead server (r1 N9).
        await spawned.dispose().catch(() => {});
        throw new Error('chat server disposed during gru spawn');
      }
      handle = spawned;
      unsubscribe = spawned.subscribe(onRuntimeEvent);
      if (spawned.sessionFile !== null) options.pointer.record(spawned.sessionFile);
      log('info', 'gru session live', { session_file: spawned.sessionFile });
      return spawned;
    } catch (error) {
      log('error', 'gru spawn failed', { error: String(error) });
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

  function settleOpenTurn(): void {
    for (const closing of frameLog.settleOpenTurn()) broadcast(closing);
    openCalls.clear();
    turnLive = false;
  }

  function onRuntimeEvent(event: RuntimeEvent): void {
    switch (event.type) {
      case 'turn_start':
        turnLive = true;
        emitLogged({ type: 'turn', state: 'start' });
        break;
      case 'turn_end':
        turnLive = false;
        // A fatal error may already have settled this turn — never log a
        // dangling end (replay would render a turn boundary out of nowhere).
        if (!frameLog.hasOpenTurn) break;
        emitLogged({ type: 'turn', state: 'end' });
        break;
      case 'text_delta':
        emitLogged({ type: 'delta', text: event.delta });
        break;
      case 'thinking_delta':
        // The contract has no thinking frame; dropped at the boundary
        // (docs/CHAT.md). E6 transcript views own that surface later.
        break;
      case 'tool_start':
        openCalls.set(event.callId, event.tool);
        emitLogged({ type: 'tool', name: event.tool, state: 'start' });
        break;
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
        }
        break;
      case 'queued':
        log('debug', 'chat delivery queued by the runtime layer', {
          reason: event.reason,
          owner: event.owner,
        });
        break;
      case 'error':
        // r1 B2: the shipped client treats ANY fatal:true frame — live OR
        // replayed — as a pairing-fatal event and closes. Logged runtime
        // deaths therefore NEVER carry the flag (mock parity: the mock
        // never persists fatal frames); the settle frames below already
        // record that the turn died here.
        emitLogged({ type: 'error', message: event.error });
        if (event.fatal) settleOpenTurn();
        break;
    }
  }

  function teardownHandle(): void {
    unsubscribe?.();
    unsubscribe = null;
    handle = null;
    openCalls.clear();
  }

  // -----------------------------------------------------------------------
  // Delivery (prompt when idle, steer mid-turn)
  // -----------------------------------------------------------------------

  function deliver(client: Client, text: string): void {
    void (async () => {
      let gru: AgentHandle;
      try {
        gru = await ensureGru();
      } catch (error) {
        // Ephemeral: a transient spawn failure must not replay forever.
        send(client, ephemeralError(`gru is unavailable: ${(error as Error).message}`));
        return;
      }
      const midTurn = turnLive;
      try {
        if (midTurn) {
          await gru.steer(text, { owner: CHAT_OWNER });
        } else {
          turnLive = true; // optimistic: the turn_start event confirms
          await gru.prompt(text, { owner: CHAT_OWNER });
          turnLive = false;
        }
      } catch (error) {
        const message = (error as Error).message;
        const dead = /disposed/.test(message);
        if (dead) teardownHandle();
        // Conversation-relevant (this message failed to deliver) → logged.
        emitLogged({ type: 'error', message: `message delivery failed: ${message}` });
        // Settle only when the turn is actually over (r1 W2): our prompt
        // dying, or a disposed session, ends the event stream — close the
        // log. A rejected STEER leaves the live runtime turn running:
        // record the failure, never close over it.
        if (dead || !midTurn) {
          turnLive = false;
          settleOpenTurn();
        }
      }
    })();
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
      handleUserFrame(client, frame);
    });
    socket.on('close', () => {
      if (client.authDeadline !== null) clearTimeout(client.authDeadline);
      clients.delete(client);
      if (client.writer) promotePen();
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
    if (!timingSafeEqual(hashToken(frame.token), tokenHash)) {
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
    // Synchronous block: the replay snapshot covers exactly seqs ≤ the
    // high-water mark; live frames (> high-water) arrive after it by
    // per-socket FIFO — gapless by the seq-continuity invariant.
    for (const replayed of frameLog.replayAfter(frame.last_seen_seq ?? 0)) {
      send(client, replayed);
    }
    log('info', 'chat client authenticated', {
      writer: client.writer,
      last_seen_seq: frame.last_seen_seq ?? 0,
      high_water_seq: highWater,
    });
  }

  /** Dedup by client_msg_id: re-received frames get a fresh ack, no re-delivery. */
  function handleUserFrame(client: Client, frame: UserFrame): void {
    if (!client.writer) {
      send(client, ephemeralError('read-only: another client holds the pen'));
      return;
    }
    if (frameLog.hasSeenUserId(frame.client_msg_id)) {
      send(client, frameLog.append({ type: 'ack', client_msg_id: frame.client_msg_id }));
      return;
    }
    broadcast(frameLog.append({ type: 'user', text: frame.text, client_msg_id: frame.client_msg_id }));
    send(client, frameLog.append({ type: 'ack', client_msg_id: frame.client_msg_id }));
    deliver(client, frame.text);
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
          socket.destroy();
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
        // the first message retries, but the boot log must say why.
        log('warn', 'gru warmup failed — first message retries', {
          error: String(error),
        });
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
      unsubscribe?.();
      unsubscribe = null;
      handle = null;
    },
  };
}

/** Length-agnostic constant-time compare: hash both sides first. */
function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf-8').digest();
}
