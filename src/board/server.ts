import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { hashToken, tokenConfigured, tokenMatches } from '../auth.js';
import { ROLES, type GruCommandConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { EventBus } from '../events/bus.js';
import { LedgerApi, RecordNotFound } from '../ledger/api.js';
import { isJobStatus, isRoundStatus, isRoundVerdict } from '../ledger/states.js';
import { isAgentState } from '../runtime/types.js';
import type { NotificationCenter } from '../notifications/center.js';
import type { TranscriptService } from '../transcripts/service.js';
import { BOARD_WS_PATH, parseBoardClientFrame, type BoardServerFrame } from './frames.js';
import type { BoardEngine } from './engine.js';
import type { DecisionRuntimeStatus } from '../decisions/runtime.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Board server (EPICS E6 stories 2–4 surface): the HTTP API of record's
 * read/write endpoints + the board WebSocket push. Auth mirrors the chat
 * surface — same token, constant-time compare, empty token = locked door.
 *
 * The write endpoints are the thin validated record API E8's dispatch flow
 * builds on; the board UI itself is read-only (no authorship in E6).
 */

export interface BoardServerOptions {
  readonly config: GruCommandConfig;
  readonly engine: BoardEngine;
  readonly ledger: LedgerApi;
  readonly transcripts: TranscriptService;
  readonly bus: EventBus;
  /** E7: the notification write path (shown receipts + acks). */
  readonly notifications: NotificationCenter;
  /** E7: fired after a successful ack — the supervisor re-arms an open
   * breaker whose notification was acked. */
  readonly onNotificationAck?: (id: string) => void;
  readonly decisionsStatus?: () => DecisionRuntimeStatus;
  readonly onDecisionsRecheck?: () => Promise<DecisionRuntimeStatus>;
  readonly log?: Log;
  /** First-frame-must-be-auth deadline (chat parity: 5 s). */
  readonly authDeadlineMs?: number;
  /** Upgrade paths owned by SIBLING ws surfaces (the chat /ws) — the board
   * handler is the last-attached upgrade terminator for everything else. */
  readonly siblingUpgradePaths?: readonly string[];
  /** Coalesce rapid event bursts into one snapshot push (ms). */
  readonly pushDebounceMs?: number;
  /** Transport heartbeat interval (chat parity: 30 s, 0 disables) —
   * half-open connections are terminated after two missed pongs. */
  readonly heartbeatMs?: number;
}

export interface BoardServer {
  /** HTTP claim hook: true when the request was handled (service skips
   * static/404 for it). Runs after /health, before static — main wires it
   * into createService's requestHook. */
  requestHook(req: IncomingMessage, res: import('node:http').ServerResponse, path: string): boolean;
  attach(httpServer: HttpServer): void;
  dispose(): Promise<void>;
}

interface Client {
  readonly socket: WebSocket;
  authed: boolean;
  authDeadline: ReturnType<typeof setTimeout> | null;
  pongMisses: number;
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function send(socket: WebSocket, frame: BoardServerFrame): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
}

export function createBoardServer(options: BoardServerOptions): BoardServer {
  const log = options.log ?? (() => {});
  const authDeadlineMs = options.authDeadlineMs ?? 5_000;
  const tokenHash = hashToken(options.config.auth.token);
  const configured = tokenConfigured(options.config.auth.token);
  const engine = options.engine;
  const ledger = options.ledger;
  const transcripts = options.transcripts;
  const notifications = options.notifications;
  const onNotificationAck = options.onNotificationAck ?? (() => {});
  const siblings = new Set(options.siblingUpgradePaths ?? []);

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const clients = new Set<Client>();
  let disposed = false;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let attached: {
    readonly server: HttpServer;
    readonly handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
  } | null = null;

  // ------------------------------------------------------------------
  // Auth (chat parity)
  // ------------------------------------------------------------------

  function bearerToken(req: IncomingMessage): string | null {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return null;
    const match = /^Bearer (.+)$/.exec(header.trim());
    return match === null ? null : match[1] ?? null;
  }

  /** 401 on bad token; 503 when no token is configured at all. */
  function authed(req: IncomingMessage, res: import('node:http').ServerResponse): boolean {
    if (!configured) {
      json(res, 503, { error: 'not_configured', detail: 'no pairing token configured' });
      return false;
    }
    const token = bearerToken(req);
    if (token === null || !tokenMatches(token, tokenHash)) {
      json(res, 401, { error: 'unauthorized' });
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------------
  // HTTP API
  // ------------------------------------------------------------------

  const MAX_WRITE_BYTES = 200_000;

  function readBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolveBody, rejectBody) => {
      let seen = 0;
      const chunks: Buffer[] = [];
      let rejected = false;
      req.on('data', (chunk: Buffer) => {
        if (rejected) return;
        seen += chunk.length;
        if (seen > MAX_WRITE_BYTES) {
          rejected = true;
          rejectBody(new Error('payload too large'));
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (rejected) return;
        if (chunks.length === 0) {
          resolveBody({});
          return;
        }
        try {
          resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch (error) {
          rejectBody(new Error(`invalid JSON body: ${String(error)}`));
        }
      });
      req.on('error', (error: Error) => {
        if (!rejected) rejectBody(error);
      });
    });
  }

  function strField(body: Record<string, unknown>, field: string): string {
    const value = body[field];
    if (typeof value !== 'string' || value === '') {
      throw new Error(`field "${field}" must be a non-empty string`);
    }
    return value;
  }

  function optStrField(body: Record<string, unknown>, field: string): string | undefined {
    if (!(field in body)) return undefined;
    const value = body[field];
    // Present-but-wrong-typed input is NEVER silently dropped — the caller
    // asked for something and must learn it did not land.
    if (typeof value !== 'string') throw new Error(`field "${field}" must be a string`);
    return value === '' ? undefined : value;
  }

  function handleApi(
    req: IncomingMessage,
    res: import('node:http').ServerResponse,
    path: string,
  ): boolean {
    if (!path.startsWith('/api/')) return false;
    req.resume(); // the hook claims the stream; body readers drain it
    const startedAt = Date.now();
    void (async () => {
      try {
        // --- reads -----------------------------------------------------
        if (req.method === 'GET' && path === '/api/board') {
          if (!authed(req, res)) return;
          json(res, 200, engine.snapshot());
          return;
        }
        if (req.method === 'GET' && path === '/api/decisions/status') {
          if (!authed(req, res)) return;
          if (options.decisionsStatus === undefined) {
            json(res, 404, { error: 'not_found' });
            return;
          }
          json(res, 200, options.decisionsStatus());
          return;
        }
        if (req.method === 'GET' && path === '/api/transcripts') {
          if (!authed(req, res)) return;
          json(res, 200, { transcripts: transcripts.list() });
          return;
        }
        if (req.method === 'GET' && path === '/api/transcripts/file') {
          if (!authed(req, res)) return;
          const url = new URL(req.url ?? '/', 'http://localhost');
          const file = url.searchParams.get('file') ?? '';
          const q = url.searchParams.get('q');
          if (q !== null && q !== '') {
            json(res, 200, transcripts.search(file, q));
            return;
          }
          const beforeRaw = url.searchParams.get('before');
          const limitRaw = url.searchParams.get('limit');
          // Strict integer params: '' or '1.5' or '-2' are REJECTED, never
          // coerced (Number('') === 0 would silently page nothing).
          const before =
            beforeRaw === null ? undefined : /^\d+$/.test(beforeRaw) ? Number(beforeRaw) : NaN;
          const limit =
            limitRaw === null ? undefined : /^\d+$/.test(limitRaw) ? Number(limitRaw) : NaN;
          if (before !== undefined && !Number.isInteger(before)) {
            json(res, 400, { error: 'bad_request', detail: 'before must be a non-negative integer' });
            return;
          }
          if (limit !== undefined && !Number.isInteger(limit)) {
            json(res, 400, { error: 'bad_request', detail: 'limit must be a positive integer' });
            return;
          }
          json(
            res,
            200,
            transcripts.page(file, {
              ...(before !== undefined ? { before } : {}),
              ...(limit !== undefined ? { limit } : {}),
            }),
          );
          return;
        }

        // --- writes (the thin record API; authorship UI is E8) ----------
        if (req.method === 'POST' && path === '/api/decisions/recheck') {
          if (!authed(req, res)) return;
          if (options.onDecisionsRecheck === undefined) {
            json(res, 404, { error: 'not_found' });
            return;
          }
          json(res, 200, await options.onDecisionsRecheck());
          return;
        }
        if (req.method === 'POST' && (path === '/api/jobs' || path === '/api/rounds' || path === '/api/agents' || path === '/api/agents/state' || path === '/api/lenses/bind' || path === '/api/lenses/outcome')) {
          if (!authed(req, res)) return;
          const body = (await readBody(req)) as Record<string, unknown>;
          if (path === '/api/jobs') {
            const job = ledger.addJob({
              id: strField(body, 'id'),
              repo: strField(body, 'repo'),
              title: strField(body, 'title'),
              ...(optStrField(body, 'baseBranch') !== undefined
                ? { baseBranch: optStrField(body, 'baseBranch') ?? null }
                : {}),
            });
            json(res, 201, job);
            return;
          }
          if (path === '/api/rounds') {
            const lensesRaw = body['lenses'];
            if (
              lensesRaw !== undefined &&
              (!Array.isArray(lensesRaw) ||
                lensesRaw.length === 0 ||
                !lensesRaw.every((l) => typeof l === 'string' && l !== ''))
            ) {
              json(res, 400, { error: 'bad_request', detail: 'lenses must be a non-empty array of non-empty strings' });
              return;
            }
            const round = ledger.addRound({
              jobId: strField(body, 'jobId'),
              ...(Array.isArray(lensesRaw) ? { lenses: lensesRaw as string[] } : {}),
              ...(optStrField(body, 'targetRef') !== undefined
                ? { targetRef: optStrField(body, 'targetRef') ?? null }
                : {}),
            });
            json(res, 201, round);
            return;
          }
          if (path === '/api/agents') {
            const role = strField(body, 'role');
            if (!(ROLES as readonly string[]).includes(role)) {
              json(res, 400, { error: 'bad_request', detail: `unknown role "${role}" (valid: ${ROLES.join(', ')})` });
              return;
            }
            const agent = ledger.registerAgent({
              id: strField(body, 'id'),
              role: role as never,
              ...(optStrField(body, 'label') !== undefined ? { label: optStrField(body, 'label') ?? null } : {}),
              ...(optStrField(body, 'jobId') !== undefined ? { jobId: optStrField(body, 'jobId') ?? null } : {}),
              ...(optStrField(body, 'roundId') !== undefined ? { roundId: optStrField(body, 'roundId') ?? null } : {}),
              ...(optStrField(body, 'sessionFile') !== undefined ? { sessionFile: optStrField(body, 'sessionFile') ?? null } : {}),
            });
            json(res, 201, agent);
            return;
          }
          if (path === '/api/agents/state') {
            const state = strField(body, 'state');
            if (!isAgentState(state)) {
              json(res, 400, { error: 'bad_request', detail: `unknown agent state "${state}"` });
              return;
            }
            const agent = ledger.setAgentState(strField(body, 'id'), state as never);
            json(res, 200, agent);
            return;
          }
          if (path === '/api/lenses/bind') {
            const round = ledger.bindLens(strField(body, 'roundId'), strField(body, 'lens'), strField(body, 'agentId'));
            json(res, 200, round);
            return;
          }
          const state = strField(body, 'state');
          if (state !== 'done' && state !== 'error') {
            json(res, 400, { error: 'bad_request', detail: 'outcome state must be done or error (live derives from agent events)' });
            return;
          }
          const round = ledger.setLensOutcome(
            strField(body, 'roundId'),
            strField(body, 'lens'),
            state,
            optStrField(body, 'note'),
          );
          json(res, 200, round);
          return;
        }
        if (req.method === 'POST' && path.startsWith('/api/jobs/') && path.endsWith('/status')) {
          if (!authed(req, res)) return;
          const id = decodeURIComponent(path.slice('/api/jobs/'.length, -'/status'.length));
          const body = (await readBody(req)) as Record<string, unknown>;
          const status = strField(body, 'status');
          if (!isJobStatus(status)) {
            json(res, 400, { error: 'bad_request', detail: `unknown job status "${status}"` });
            return;
          }
          json(res, 200, ledger.setJobStatus(id, status));
          return;
        }
        if (req.method === 'POST' && path.startsWith('/api/rounds/') && (path.endsWith('/status') || path.endsWith('/verdict'))) {
          if (!authed(req, res)) return;
          const suffix = path.endsWith('/status') ? '/status' : '/verdict';
          const id = decodeURIComponent(path.slice('/api/rounds/'.length, -suffix.length));
          const body = (await readBody(req)) as Record<string, unknown>;
          const value = strField(body, suffix === '/status' ? 'status' : 'verdict');
          if (suffix === '/status' && !isRoundStatus(value)) {
            json(res, 400, { error: 'bad_request', detail: `unknown round status "${value}"` });
            return;
          }
          if (suffix === '/verdict' && !isRoundVerdict(value)) {
            json(res, 400, { error: 'bad_request', detail: `unknown round verdict "${value}"` });
            return;
          }
          json(res, 200, suffix === '/status' ? ledger.setRoundStatus(id, value) : ledger.setRoundVerdict(id, value));
          return;
        }
        if (req.method === 'POST' && path.startsWith('/api/notifications/') && (path.endsWith('/shown') || path.endsWith('/ack'))) {
          if (!authed(req, res)) return;
          const suffix = path.endsWith('/shown') ? '/shown' : '/ack';
          const id = decodeURIComponent(path.slice('/api/notifications/'.length, -suffix.length));
          const body = (await readBody(req)) as Record<string, unknown>;
          if (suffix === '/shown') {
            // Display receipt (the shown:true doctrine): one per surface,
            // idempotent server-side; the client sends each (id, surface)
            // once. A surface id is comma-free (shownBy packs a list).
            const surface = strField(body, 'surface');
            if (surface.includes(',')) {
              json(res, 400, { error: 'bad_request', detail: 'surface must not contain commas' });
              return;
            }
            const row = notifications.markShown(id, surface);
            if (row === null) {
              json(res, 404, { error: 'not_found', detail: `notification "${id}" not found` });
              return;
            }
            json(res, 200, row);
            return;
          }
          const before = ledger.getNotification(id)?.ackedAt ?? null;
          const row = notifications.ack(id, optStrField(body, 'by') ?? 'web');
          if (row === null) {
            json(res, 404, { error: 'not_found', detail: `notification "${id}" not found` });
            return;
          }
          // The hook fires on the FIRST ack (the state change) — a repeat
          // ack is an idempotent no-op for listeners too.
          if (before === null && row.ackedAt !== null) onNotificationAck(id);
          json(res, 200, row);
          return;
        }
        json(res, 404, { error: 'not_found', path });
      } catch (error) {
        const message = String(error instanceof Error ? error.message : error);
        // Typed mapping: the ledger and transcript layers throw
        // RecordNotFound for missing entities; a missing/unreadable
        // transcript FILE is also a not-found. Everything else is a 400.
        const notFound =
          error instanceof RecordNotFound ||
          (error instanceof Error && error.message.includes('transcript unreadable'));
        json(res, notFound ? 404 : 400, { error: notFound ? 'not_found' : 'bad_request', detail: message });
      }
    })().catch((error: unknown) => {
      log('error', 'board api handler failed', { error: String(error) });
      if (!res.headersSent) json(res, 500, { error: 'internal' });
    });
    res.on('close', () => {
      log('info', 'board request', { method: req.method, path, status: res.statusCode, duration_ms: Date.now() - startedAt });
    });
    return true;
  }

  // ------------------------------------------------------------------
  // Board WS (snapshot push)
  // ------------------------------------------------------------------

  function pushSnapshot(): void {
    const snapshot = engine.snapshot();
    for (const client of clients) {
      if (client.authed) send(client.socket, { type: 'board', snapshot });
    }
  }

  function schedulePush(): void {
    if (pushTimer !== null) return; // coalesce bursts
    pushTimer = setTimeout(() => {
      pushTimer = null;
      if (!disposed) pushSnapshot();
    }, options.pushDebounceMs ?? 150);
  }

  const unsubscribeBus = options.bus.subscribe(schedulePush);

  const heartbeatMs = options.heartbeatMs ?? 30_000;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  if (heartbeatMs > 0) {
    heartbeat = setInterval(() => {
      for (const client of clients) {
        if (client.authed) {
          client.pongMisses += 1;
          if (client.pongMisses > 2) {
            // Two unanswered pings: half-open — terminate; the client's
            // reconnect machinery takes over.
            client.socket.terminate();
            continue;
          }
          try {
            client.socket.ping();
          } catch {
            client.socket.terminate();
          }
        }
      }
    }, heartbeatMs);
    heartbeat.unref();
  }

  function onConnection(socket: WebSocket): void {
    const client: Client = { socket, authed: false, authDeadline: null, pongMisses: 0 };
    clients.add(client);
    client.authDeadline = setTimeout(() => {
      send(socket, { type: 'error', message: 'auth deadline exceeded', fatal: true });
      socket.close(1008, 'auth timeout');
    }, authDeadlineMs);
    socket.on('pong', () => {
      client.pongMisses = 0;
    });
    socket.on('message', (data: unknown) => {
      if (disposed || client.authed) return; // post-auth inbound is ignored (clients only listen)
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        if (client.authed) return; // board clients send nothing post-auth; ignore noise
        send(socket, { type: 'error', message: 'first frame must be auth', fatal: true });
        socket.close(1008, 'protocol');
        return;
      }
      const frame = parseBoardClientFrame(parsed);
      if (frame === null) {
        send(socket, { type: 'error', message: 'first frame must be auth', fatal: true });
        socket.close(1008, 'protocol');
        return;
      }
      if (!configured || !tokenMatches(frame.token, tokenHash)) {
        send(socket, { type: 'error', message: configured ? 'invalid token' : 'board not configured', fatal: true });
        socket.close(1008, 'unauthorized');
        return;
      }
      client.authed = true;
      if (client.authDeadline !== null) clearTimeout(client.authDeadline);
      client.authDeadline = null;
      send(socket, { type: 'auth_ok' });
      pushSnapshot(); // current state immediately on (re)connect
    });
    socket.on('close', () => {
      if (client.authDeadline !== null) clearTimeout(client.authDeadline);
      clients.delete(client);
    });
    socket.on('error', () => {
      clients.delete(client);
    });
  }

  wss.on('connection', onConnection);

  return {
    requestHook(req: IncomingMessage, res: import('node:http').ServerResponse, path: string): boolean {
      if (!path.startsWith('/api/')) return false;
      return handleApi(req, res, path);
    },

    attach(httpServer: HttpServer): void {
      const handler = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
        let path = '';
        try {
          path = new URL(request.url ?? '/', 'http://localhost').pathname;
        } catch {
          socket.destroy();
          return;
        }
        if (path === BOARD_WS_PATH) {
          wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
          });
          return;
        }
        if (!siblings.has(path)) {
          // Last-attached upgrade terminator: unclaimed paths die here so
          // nothing hangs. Sibling-owned paths (chat /ws) pass through.
          socket.destroy();
        }
      };
      httpServer.on('upgrade', handler);
      attached = { server: httpServer, handler };
    },

    async dispose(): Promise<void> {
      disposed = true;
      if (pushTimer !== null) clearTimeout(pushTimer);
      if (heartbeat !== null) clearInterval(heartbeat);
      unsubscribeBus();
      if (attached !== null) {
        attached.server.off('upgrade', attached.handler);
        attached = null;
      }
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
    },
  };
}
