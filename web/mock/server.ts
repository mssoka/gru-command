/**
 * ──────────────────────────── DEV TOOLING ONLY ────────────────────────────
 * Mock Gru chat socket for frontend development (E5). Implements the WS
 * protocol contract (web/src/lib/protocol.ts) exactly as the real E4 socket
 * will: token auth on the first frame, seq'd frames, replay-on-reconnect
 * from its in-memory log, and a scripted deterministic reply.
 *
 * This file is NEVER part of the production service or bundle. Run it with:
 *   npm run mock            (GRU_MOCK_PORT=8787, GRU_MOCK_TOKEN=dev-token)
 * ───────────────────────────────────────────────────────────────────────────
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  parseClientFrame,
  type ErrorFrame,
  type LoggedFrame,
  type ServerFrame,
  type UserFrame,
} from '../src/lib/protocol.js';

const PORT = Number(process.env.GRU_MOCK_PORT ?? 8787);
const TOKEN = process.env.GRU_MOCK_TOKEN ?? 'dev-token';
const AUTH_DEADLINE_MS = 5_000;
const DELTA_INTERVAL_MS = 45;

/** In-memory frame log — the mock's stand-in for the session store. */
const log: LoggedFrame[] = [];
let seq = 0;

function nextSeq(): number {
  seq += 1;
  return seq;
}

function record(frame: LoggedFrame): LoggedFrame {
  log.push(frame);
  return frame;
}

function send(socket: WebSocket, frame: ServerFrame): void {
  socket.send(JSON.stringify(frame));
}

function sendError(socket: WebSocket, message: string, fatal: boolean): void {
  // Every seq-consuming frame is logged: the counter must always equal the
  // log's high-water mark, or replay-end arithmetic wedges for clients.
  let frame: ErrorFrame;
  if (fatal) {
    frame = { type: 'error', message, fatal: true };
  } else {
    frame = { type: 'error', message, seq: nextSeq() };
    record(frame);
  }
  send(socket, frame);
}

/** Deterministic scripted Gru reply: turn → tool activity → deltas → end. */
function scriptedReply(socket: WebSocket, userText: string): void {
  const reply =
    `Mock Gru here, boss! You said: "${userText}". ` +
    'The real brain plugs in when E4 lands — until then I echo with pride. 🪐';
  const tokens = reply.split(/(?<=\s)/); // word-sized chunks, spaces kept

  emit({ type: 'turn', state: 'start', seq: nextSeq() });
  emit({ type: 'tool', name: 'mock-echo', state: 'start', seq: nextSeq() });

  let index = 0;
  let toolEnded = false;
  let settled = false;
  const timer = setInterval(() => {
    if (socket.readyState !== socket.OPEN) {
      finishAborted();
      return;
    }
    if (index === 2 && !toolEnded) {
      toolEnded = true;
      emit({ type: 'tool', name: 'mock-echo', state: 'end', seq: nextSeq() });
    }
    const chunk = tokens[index];
    if (chunk === undefined) {
      settled = true;
      clearInterval(timer);
      socket.off('close', finishAborted);
      emit({ type: 'turn', state: 'end', seq: nextSeq() });
      return;
    }
    emit({ type: 'delta', text: chunk, seq: nextSeq() });
    index += 1;
  }, DELTA_INTERVAL_MS);

  socket.once('close', finishAborted);

  // A dropped socket must not leave an unterminated turn in the log:
  // closing frames are recorded (not sent) so replays see a settled turn.
  function finishAborted(): void {
    if (settled) return;
    settled = true;
    clearInterval(timer);
    if (!toolEnded) {
      toolEnded = true;
      record({ type: 'tool', name: 'mock-echo', state: 'end', seq: nextSeq() });
    }
    record({ type: 'turn', state: 'end', seq: nextSeq() });
  }

  function emit(frame: LoggedFrame): void {
    record(frame);
    send(socket, frame);
  }
}

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  // Dev control plane (tests): POST /__reset clears the frame log;
  // POST /__drop terminates every connected socket.
  if (req.method === 'POST' && req.url === '/__drop') {
    for (const socket of server.clients) socket.terminate();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}\n');
    return;
  }
  if (req.method === 'POST' && req.url === '/__reset') {
    log.length = 0;
    seq = 0;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}\n');
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"mock: ws endpoint is /ws; POST /__reset clears the log"}\n');
});

const server = new WebSocketServer({ server: httpServer, path: '/ws' });

server.on('connection', (socket) => {
  let authed = false;
  const authDeadline = setTimeout(() => {
    if (!authed) {
      sendError(socket, 'auth timeout: first frame must be auth', true);
      socket.close();
    }
  }, AUTH_DEADLINE_MS);

  socket.on('message', (data) => {
    const frame = parseClientFrame(String(data));
    if (frame === null) {
      // Matches the ruled real-server behavior (r1 W1): an UNAUTHENTICATED
      // socket never writes durable history — the pre-auth notice is
      // ephemeral; only authenticated sockets log protocol errors.
      if (authed) {
        sendError(socket, 'malformed frame', false);
      } else {
        socket.send(JSON.stringify({ type: 'error', message: 'malformed frame' }));
      }
      return;
    }

    if (!authed) {
      if (frame.type !== 'auth') {
        sendError(socket, 'first frame must be auth', true);
        socket.close();
        return;
      }
      clearTimeout(authDeadline);
      if (frame.token !== TOKEN) {
        sendError(socket, 'unauthorized: bad token', true);
        socket.close();
        return;
      }
      authed = true;
    const lastSeen = frame.last_seen_seq ?? 0;
      // auth_ok.seq is the log high-water mark; because every seq-consuming
      // frame is logged, counter === max logged seq at all times.
      send(socket, { type: 'auth_ok', seq });
      for (const logged of log) {
        const frameSeq = 'seq' in logged && typeof logged.seq === 'number' ? logged.seq : 0;
        if (frameSeq > lastSeen) send(socket, logged);
      }
      return;
    }

    if (frame.type === 'auth') {
      sendError(socket, 'already authenticated', false);
      return;
    }

    handleUserFrame(socket, frame);
  });

  socket.on('error', () => {
    // A broken client socket must not take the mock down.
  });
});

/** Dedup by client_msg_id: re-received frames get a fresh ack, no re-reply. */
function handleUserFrame(socket: WebSocket, frame: UserFrame): void {
  const prior = log.find(
    (logged): logged is LoggedFrame & { type: 'user' } =>
      logged.type === 'user' && logged.client_msg_id === frame.client_msg_id,
  );
  if (prior !== undefined) {
    send(socket, record({ type: 'ack', client_msg_id: frame.client_msg_id, seq: nextSeq() }));
    return;
  }
  record({ type: 'user', text: frame.text, client_msg_id: frame.client_msg_id, seq: nextSeq() });
  send(socket, record({ type: 'ack', client_msg_id: frame.client_msg_id, seq: nextSeq() }));
  scriptedReply(socket, frame.text);
}

process.stdout.write(
  `gru-command MOCK chat socket (dev-only) listening on ws://localhost:${PORT}/ws ` +
    `(token: ${TOKEN === 'dev-token' ? 'dev-token [default]' : 'from GRU_MOCK_TOKEN'})\n`,
);

const shutdown = (): void => {
  server.close();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

httpServer.listen(PORT);
