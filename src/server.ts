import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GruCommandConfig } from './config.js';
import type { InstallIdentity } from './identity.js';
import type { LogLevel } from './logger.js';
import { SERVICE_NAME, VERSION } from './version.js';

/**
 * Three-signal liveness per the approved architecture amendments:
 * (a) /health reachable, (b) agent-session state + last activity,
 * (c) session-jsonl growth. All three carry their structure with
 * `stubbed: true` until the runtime adapter layer (E2) wires real values —
 * declared, not faked.
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
  readonly session: {
    readonly path: string;
    readonly declared: boolean;
    readonly note: string;
  };
}

export interface ServiceHandle {
  readonly port: number;
  readonly host: string;
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
): HealthPayload {
  const liveness: LivenessBlock = {
    healthy: true,
    note:
      'all three signals are stubbed until the runtime adapter layer (E2); ' +
      'health reachability is self-evident from this response itself',
    signals: {
      health_reachable: { value: true, stubbed: true },
      agent_session: { state: 'no-runtime', last_activity: null, stubbed: true },
      session_growth: { value: 'no-runtime', stubbed: true },
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
    session: {
      path: join(config.dataDir, 'sessions'),
      declared: true,
      note: 'session store arrives with the runtime adapter layer (E2); path declared per SPEC ruling 12',
    },
  };
}

export type ServiceEvent = (
  level: LogLevel,
  msg: string,
  fields?: Record<string, unknown>,
) => void;

export function createService(
  config: GruCommandConfig,
  identity: InstallIdentity,
  onEvent: ServiceEvent = () => {},
): { start(): Promise<ServiceHandle> } {
  const startedAt = process.hrtime.bigint();
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
          jsonBody(res, 200, buildHealthPayload(config, identity, startedAt, requestId));
          return { status: 200 };
        }
        req.resume();
        jsonBody(res, 404, { error: 'not_found', path });
        return { status: 404 };
      })()
        .then((outcome: { status: number }) => {
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
