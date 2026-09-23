import type { IncomingMessage, ServerResponse } from 'node:http';
import { hashToken, tokenConfigured, tokenMatches } from '../auth.js';
import type { GruCommandConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import { RollBusyError, type RollController } from './controller.js';
import type { RollState } from './state.js';

/** What the roll server needs from the controller (fake-able in tests). */
export type RollControllerPort = Pick<RollController, 'isBusy' | 'state' | 'roll'>;

/**
 * Roll HTTP surface (graceful self-roll): operator-guarded, same pairing
 * token and constant-time comparison as every other write surface.
 *
 *   POST /api/roll   { reason?, requested_by?, force_build? } → 202
 *                    { status: 'accepted', roll } — the roll runs in the
 *                    background; 409 while one is already in progress.
 *   GET  /api/roll   → 200 { roll } — the live record (null before the
 *                    first roll; post-restart reads come from disk).
 *
 * The 202 body is the record AFTER preflight has begun (the controller
 * writes the 'preflight' phase synchronously), so a CLI can follow without
 * racing the first poll.
 */

export interface RollServer {
  requestHook(req: IncomingMessage, res: ServerResponse, path: string): boolean;
}

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

const MAX_BODY_BYTES = 64 * 1024;

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let seen = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      seen += chunk.length;
      if (seen > MAX_BODY_BYTES) {
        rejected = true;
        rejectBody(new Error('request body exceeds 64 KiB'));
        req.destroy();
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
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          rejectBody(new Error('request body must be a JSON object'));
          return;
        }
        resolveBody(parsed as Record<string, unknown>);
      } catch (error) {
        rejectBody(new Error(`request body is not valid JSON: ${String(error)}`));
      }
    });
    req.on('error', (error) => {
      if (!rejected) rejectBody(error);
    });
  });
}

function optStr(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function optBool(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

export function createRollServer(options: {
  readonly config: GruCommandConfig;
  readonly controller: RollControllerPort;
  /** Live-or-on-disk state record (post-restart reads come from disk). */
  readonly loadState: () => RollState | null;
  readonly log?: Log;
}): RollServer {
  const log = options.log ?? (() => {});
  const tokenHash = hashToken(options.config.auth.token);
  const configured = tokenConfigured(options.config.auth.token);

  function authed(req: IncomingMessage, res: ServerResponse): boolean {
    if (!configured) {
      json(res, 503, { error: 'not_configured', detail: 'no pairing token configured' });
      return false;
    }
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (.+)$/.exec(header.trim()) : null;
    const token = match === null ? null : match[1] ?? null;
    if (token === null || !tokenMatches(token, tokenHash)) {
      json(res, 401, { error: 'unauthorized' });
      return false;
    }
    return true;
  }

  return {
    requestHook(req: IncomingMessage, res: ServerResponse, path: string): boolean {
      if (path !== '/api/roll') return false;
      if (req.method !== 'POST' && req.method !== 'GET') {
        req.resume();
        json(res, 405, { error: 'method_not_allowed', allowed: ['GET', 'POST'] });
        return true;
      }
      if (!authed(req, res)) {
        req.resume();
        return true;
      }
      if (req.method === 'GET') {
        req.resume();
        json(res, 200, { roll: options.loadState() });
        return true;
      }
      void (async () => {
        try {
          const body = await readBody(req);
          const reason = optStr(body, 'reason');
          const requestedBy = optStr(body, 'requested_by');
          const forceBuild = optBool(body, 'force_build');
          if (options.controller.isBusy()) {
            json(res, 409, { error: 'roll_in_progress', roll: options.controller.state() });
            return;
          }
          const run = options.controller.roll({
            ...(reason !== undefined ? { reason } : {}),
            ...(requestedBy !== undefined ? { requestedBy } : {}),
            ...(forceBuild !== undefined ? { forceBuild } : {}),
          });
          // The controller sets the preflight record synchronously before
          // its first await; the 202 carries it so followers start aligned.
          const accepted = options.controller.state();
          json(res, 202, { status: 'accepted', roll: accepted });
          const final = await run;
          log('info', 'roll request settled', {
            roll_id: final.rollId,
            phase: final.phase,
            error: final.error?.detail ?? null,
          });
        } catch (error) {
          if (error instanceof RollBusyError) {
            json(res, 409, { error: 'roll_in_progress', roll: options.controller.state() });
            return;
          }
          log('error', 'roll request failed', { error: String(error) });
          if (!res.headersSent) json(res, 400, { error: 'bad_request', detail: String(error) });
        }
      })();
      return true;
    },
  };
}
