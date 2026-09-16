import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GruCommandConfig } from './config.js';
import type { InstallIdentity } from './identity.js';
import { SERVICE_NAME, VERSION } from './version.js';

/**
 * Three-signal liveness per the approved architecture amendments:
 * (a) /health reachable, (b) agent-session state + last activity,
 * (c) session-jsonl growth. Signals (b) and (c) are structurally present
 * but stubbed until the runtime adapter layer (E2) — declared, not faked.
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
  readonly uptime_ms: number;
  readonly config: {
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

function jsonBody(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf-8');
      if (data.length > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolveBody(data));
    req.on('error', reject);
  });
}

export function buildHealthPayload(
  config: GruCommandConfig,
  identity: InstallIdentity,
  startedAt: bigint,
): HealthPayload {
  const liveness: LivenessBlock = {
    healthy: true,
    note: 'agent_session and session_growth are stubbed until the runtime adapter layer (E2)',
    signals: {
      health_reachable: { value: true, stubbed: false },
      agent_session: { state: 'no-runtime', last_activity: null, stubbed: true },
      session_growth: { value: 'no-runtime', stubbed: true },
    },
  };
  return {
    service: SERVICE_NAME,
    version: VERSION,
    request_id: randomUUID(),
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

export function createService(
  config: GruCommandConfig,
  identity: InstallIdentity,
  onRequest: (msg: string, fields?: Record<string, unknown>) => void = () => {},
): { start(): Promise<ServiceHandle> } {
  const startedAt = process.hrtime.bigint();
  const server: HttpServer = createServer(
    (req: IncomingMessage, res: import('node:http').ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      void (async () => {
        if (url.pathname === '/health') {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            jsonBody(res, 405, { error: 'method_not_allowed', allowed: ['GET', 'HEAD'] });
            return;
          }
          if (req.method === 'GET') {
            await readRequestBody(req).catch(() => '');
          }
          jsonBody(res, 200, buildHealthPayload(config, identity, startedAt));
          return;
        }
        jsonBody(res, 404, { error: 'not_found', path: url.pathname });
      })().catch((error: unknown) => {
        onRequest('request failed', { error: String(error) });
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
        server.once('error', rejectListen);
        server.listen(config.server.port, config.server.host, () => resolveListen());
      });
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error(`unexpected listen address: ${String(address)}`);
      }
      return {
        host: config.server.host,
        port: address.port,
        stop: async () => {
          await new Promise<void>((resolveClose, rejectClose) => {
            server.close((closeError?: Error | null) => {
              if (closeError) rejectClose(closeError);
              else resolveClose();
            });
            server.closeAllConnections();
          });
        },
      };
    },
  };
}
