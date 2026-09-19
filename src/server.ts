import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GruCommandConfig } from './config.js';
import type { InstallIdentity } from './identity.js';
import type { LogLevel } from './logger.js';
import { hashToken, tokenConfigured, tokenMatches } from './auth.js';
import type { RuntimeStatus } from './runtime/registry.js';
import type { SupervisionStatus } from './supervision/supervisor.js';
import type { StaticRoot } from './static.js';
import { SERVICE_NAME, VERSION } from './version.js';

/**
 * Three-signal liveness per the approved architecture amendments:
 * (a) /health reachable, (b) agent-session state + last activity,
 * (c) session-jsonl growth. Since E2 the values are REAL — wired from the
 * runtime registry and the session store's boot report (SPEC rulings 5/12).
 */
export interface LivenessSignal {
  readonly value: unknown;
  readonly stubbed: boolean;
}

export interface LivenessBlock {
  readonly healthy: boolean;
  readonly note: string;
  readonly signals: {
    readonly health_reachable: LivenessSignal;
    readonly agent_session: {
      readonly state: string;
      readonly last_activity: string | null;
      readonly stubbed: boolean;
    };
    readonly session_growth: LivenessSignal;
  };
}

export interface HealthPayload {
  readonly service: string;
  readonly version: string;
  readonly request_id: string;
  readonly uptime_ms: number;  readonly config: {
    readonly workspace_root: string;
    readonly data_dir: string;
  };
  readonly identity: {
    readonly install_id: string;
    readonly created_at: string;
  };
  readonly liveness: LivenessBlock;
  readonly supervision: SupervisionStatus | null;
  readonly session: {
    readonly path: string;
    readonly declared: boolean;
    readonly note: string;
  };
}

/**
 * The UNAUTHENTICATED /health shape (W-C, E9 r3 carry): the pairing
 * surface (LAN, pre-token) gets liveness ONLY. workspace_root,
 * data_dir, the install fingerprint, session paths, and supervision
 * detail are operator material — they move behind the pairing token
 * (full HealthPayload via `Authorization: Bearer <token>`).
 */
export interface PublicHealthPayload {
  readonly service: string;
  readonly version: string;
  readonly request_id: string;
  readonly uptime_ms: number;
  readonly liveness: {
    readonly healthy: boolean;
    readonly note: string;
    readonly signals: {
      readonly health_reachable: LivenessSignal;
    };
  };
}

/** Reduce the full payload to its public shape (W-C): identity, config
 * paths, session paths, and supervision detail never leave unauthed. */
export function toPublicHealth(full: HealthPayload): PublicHealthPayload {
  return {
    service: full.service,
    version: full.version,
    request_id: full.request_id,
    uptime_ms: full.uptime_ms,
    liveness: {
      healthy: full.liveness.healthy,
      note: full.liveness.note,
      signals: { health_reachable: full.liveness.signals.health_reachable },
    },
  };
}

export interface ServiceHandle {
  readonly port: number;
  readonly host: string;
  /** The underlying HTTP server — the chat socket attaches here (E4). */
  readonly httpServer: HttpServer;
  stop(): Promise<void>;
}

/** Hard cap on request bodies; GET /health accepts none but drains politely. */
const MAX_BODY_BYTES = 1_000_000;

class RequestBodyTooLarge extends Error {}

function jsonBody(
  res: import('node:http').ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function readRequestBody(req: IncomingMessage): Promise<void> {
  return new Promise((resolveBody, rejectBody) => {
    let seen = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      seen += chunk.length;
      if (seen > MAX_BODY_BYTES) {
        rejected = true;
        // Keep draining so the client can observe the 413; the response
        // below is written before any socket teardown.
        rejectBody(new RequestBodyTooLarge());
      }
    });
    req.on('end', () => resolveBody());
    req.on('error', (error: Error) => {
      if (!rejected) rejectBody(error);
      else resolveBody();
    });
  });
}

export function buildHealthPayload(
  config: GruCommandConfig,
  identity: InstallIdentity,
  startedAt: bigint,
  requestId: string,
  runtimeStatus: RuntimeStatus | null = null,
  supervisionStatus: SupervisionStatus | null = null,
): HealthPayload {
  const liveness: LivenessBlock =
    runtimeStatus === null
      ? {
          healthy: true,
          note: 'runtime layer not wired in this process; signals declared, not faked',
          signals: {
            health_reachable: { value: true, stubbed: true },
            agent_session: { state: 'no-runtime', last_activity: null, stubbed: true },
            session_growth: { value: 'no-runtime', stubbed: true },
          },
        }
      : {
          healthy: !runtimeStatus.adapters.some((adapter) => adapter.state === 'down'),
          note: 'signals are live values from the runtime registry and session store',
          signals: {
            health_reachable: { value: true, stubbed: false },
            agent_session: {
              state: runtimeStatus.agentSession.state,
              last_activity: runtimeStatus.agentSession.lastActivity,
              stubbed: false,
            },
            session_growth: {
              value:
                runtimeStatus.sessionGrowth === null
                  ? 'not-scanned'
                  : runtimeStatus.sessionGrowth.findings.length === 0
                    ? 'none'
                    : runtimeStatus.sessionGrowth.findings.map((finding) => ({
                        file: finding.file,
                        kind: finding.kind,
                        grew_by_bytes: finding.grewByBytes,
                        previous_bytes: finding.previousBytes,
                        current_bytes: finding.currentBytes,
                      })),
              stubbed: false,
            },
          },
        };
  return {
    service: SERVICE_NAME,
    version: VERSION,
    request_id: requestId,
    uptime_ms: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
    config: {
      workspace_root: config.workspaceRoot,
      data_dir: config.dataDir,
    },
    identity: {
      install_id: identity.installId,
      created_at: identity.createdAt,
    },
    liveness,
    supervision: supervisionStatus,
    session: {
      path: join(config.dataDir, 'sessions'),
      declared: true,
      note:
        runtimeStatus === null
          ? 'session store arrives with the runtime adapter layer (E2); path declared per SPEC ruling 12'
          : 'append-only jsonl under this path; locked while active, hourly rolling backup, boot growth detection',
    },
  };
}

export type ServiceEvent = (
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>,
) => void;

export interface ServiceOptions {
  /** Production static root (built web UI). When omitted, unknown paths
   * keep the JSON 404 — the pre-E4 behavior. */
  readonly staticRoot?: StaticRoot;
  /** Supervision status feed (E7): answers the /health supervision block.
   * Null (or omitted) reports `supervision: null` — pre-E7 shape. */
  readonly supervisionStatus?: () => SupervisionStatus | null;
  /** First claim hook after /health, before static (E6: the board's
   * /api/* routes). Returning true means the request was handled — the
   * service skips static + 404 and does not log it (the hook owns that). */
  readonly requestHook?: (req: IncomingMessage, res: import('node:http').ServerResponse, path: string) => boolean;
}

export function createService(
  config: GruCommandConfig,
  identity: InstallIdentity,
  onEvent: ServiceEvent = () => {},
  runtimeStatus: () => RuntimeStatus | null = () => null,
  options: ServiceOptions = {},
): { start(): Promise<ServiceHandle> } {
  const startedAt = process.hrtime.bigint();
  // W-C gate inputs, resolved once (review r1: per-request hashing was
  // needless work; a missing header short-circuits before any match).
  const tokenHash = hashToken(config.auth.token);
  const tokenConfigured_ = tokenConfigured(config.auth.token);
  const server: HttpServer = createServer(
    (req: IncomingMessage, res: import('node:http').ServerResponse) => {
      const requestStarted = process.hrtime.bigint();
      const requestId = randomUUID();
      let path = '?';
      try {
        path = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        jsonBody(res, 400, { error: 'bad_request', detail: 'malformed request target' });
        onEvent('info', 'request', {
          method: req.method,
          path: '(malformed)',
          status: 400,
          duration_ms: Number(process.hrtime.bigint() - requestStarted) / 1_000_000,
          request_id: requestId,
        });
        return;
      }
      void (async () => {
        if (path === '/health') {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            req.resume();
            jsonBody(
              res,
              405,
              { error: 'method_not_allowed', allowed: ['GET', 'HEAD'] },
              { allow: 'GET, HEAD' },
            );
            return { status: 405 };
          }
          try {
            await readRequestBody(req);
          } catch (error) {
            if (error instanceof RequestBodyTooLarge) {
              jsonBody(res, 413, { error: 'payload_too_large', limit_bytes: MAX_BODY_BYTES });
              return { status: 413 };
            }
            throw error;
          }
          const full = buildHealthPayload(
            config,
            identity,
            startedAt,
            requestId,
            runtimeStatus(),
            options.supervisionStatus !== undefined ? options.supervisionStatus() : null,
          );
          // W-C (E9 r3 carry): the pairing surface gets LIVENESS ONLY —
          // workspace_root / data_dir / install fingerprint / session
          // paths / supervision detail are operator material behind the
          // pairing token. A missing or wrong token still answers 200:
          // /health is the liveness oracle, not an auth gate.
          const bearer = /^Bearer (.+)$/.exec((req.headers.authorization ?? '').trim());
          const tokenKnown =
            tokenConfigured_ &&
            bearer !== null &&
            tokenMatches(bearer[1] ?? '', tokenHash);
          jsonBody(res, 200, tokenKnown ? full : toPublicHealth(full));
          return { status: 200 };
        }
        req.resume();
        if (
          options.requestHook !== undefined &&
          options.requestHook(req, res, path)
        ) {
          return null; // claimed by the hook (board /api/*) — its logs stand
        }
        if (options.staticRoot !== undefined && options.staticRoot.serve(req, res, path)) {
          return { status: 200 };
        }
        jsonBody(res, 404, { error: 'not_found', path });
        return { status: 404 };
      })()
        .then((outcome: { status: number } | null) => {
          if (outcome === null) return; // hook-owned request, hook-owned logs
          onEvent('info', 'request', {
            method: req.method,
            path,
            status: outcome.status,
            duration_ms: Number(process.hrtime.bigint() - requestStarted) / 1_000_000,
            request_id: requestId,
          });
        })
        .catch((error: unknown) => {
          onEvent('error', 'request failed', {
            method: req.method,
            path,
            error: String(error),
            request_id: requestId,
          });
          if (!res.headersSent) {
            jsonBody(res, 500, { error: 'internal_error' });
          } else {
            res.end();
          }
        });
    },
  );

  return {
    async start(): Promise<ServiceHandle> {
      await new Promise<void>((resolveListen, rejectListen) => {
        const onError = (error: Error) => rejectListen(error);
        server.once('error', onError);
        server.listen(config.server.port, config.server.host, () => {
          // The listen-time rejection path is done; from here on, server
          // errors are runtime events that must be logged, never swallowed
          // by a settled promise.
          server.off('error', onError);
          server.on('error', (error: Error) => onEvent('error', 'server error', { error: String(error) }));
          resolveListen();
        });
      });
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error(`unexpected listen address: ${String(address)}`);
      }
      return {
        host: config.server.host,
        port: address.port,
        httpServer: server,
        stop: async () => {
          await new Promise<void>((resolveClose) => {
            const drainTimeout = setTimeout(() => {
              // Wedged or streaming connections: tear them down rather than
              // hanging the shutdown forever.
              server.closeAllConnections();
            }, 2_500);
            server.close(() => {
              clearTimeout(drainTimeout);
              resolveClose();
            });
            // Idle keep-alive sockets never end on their own.
            server.closeIdleConnections();
          });
        },
      };
    },
  };
}
