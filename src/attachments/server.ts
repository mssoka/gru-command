import type { IncomingMessage, ServerResponse } from 'node:http';
import { hashToken, tokenConfigured, tokenMatches } from '../auth.js';
import type { GruCommandConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import { AttachError, browseWorkspace, materializeUpload } from './resolver.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Attach-flow HTTP surface (SPEC ruling 19, this lane): the token-authed
 * endpoints BOTH composer surfaces (chat today, dispatch riding the same
 * seam) drive. Two routes, one flow:
 *
 *   GET  /api/attach/browse?path=<workspace-relative>  — on-disk picks:
 *        directory metadata under the workspace root. NEVER file bytes
 *        (ruling 19(c): the picked file's path is the reference).
 *   POST /api/attach/uploads                            — clipboard/phone
 *        bytes materialize into <data_dir>/uploads/ and the response
 *        carries the materialized file's absolute path.
 */

export interface AttachmentsServerOptions {
  readonly config: GruCommandConfig;
  readonly log?: Log;
}

export interface AttachmentsServer {
  requestHook(req: IncomingMessage, res: ServerResponse, path: string): boolean;
  dispose(): void;
}

/** Base64 body cap: MAX_UPLOAD_BYTES inflates 4/3 over JSON + headers. */
export const MAX_UPLOAD_BODY_BYTES = Math.ceil((8 * 1024 * 1024 * 4) / 3) + 4096;

export function createAttachmentsServer(options: AttachmentsServerOptions): AttachmentsServer {
  const log = options.log ?? (() => {});
  const tokenHash = hashToken(options.config.auth.token);
  const configured = tokenConfigured(options.config.auth.token);
  const uploadsDir = `${options.config.dataDir}/uploads`;

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

  function json(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  }

  function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolveBody, rejectBody) => {
      let seen = 0;
      const chunks: Buffer[] = [];
      let rejected = false;
      req.on('data', (chunk: Buffer) => {
        if (rejected) return;
        seen += chunk.length;
        if (seen > MAX_UPLOAD_BODY_BYTES) {
          rejected = true;
          chunks.length = 0;
          rejectBody(new AttachError(413, `request body exceeds ${MAX_UPLOAD_BODY_BYTES} bytes`));
          // Keep draining. Destroying races the response write, so real
          // clients observe ECONNRESET instead of the promised HTTP 413.
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
            rejectBody(new AttachError(400, 'request body must be a JSON object'));
            return;
          }
          resolveBody(parsed as Record<string, unknown>);
        } catch {
          rejectBody(new AttachError(400, 'request body is not valid JSON'));
        }
      });
      req.on('error', (error: Error) => {
        if (!rejected) rejectBody(new AttachError(400, String(error)));
      });
    });
  }

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    query: URLSearchParams,
  ): Promise<boolean> {
    if (req.method === 'GET' && path === '/api/attach/browse') {
      if (!authed(req, res)) return true;
      const result = browseWorkspace(options.config.workspaceRoot, query.get('path') ?? '');
      json(res, 200, result);
      return true;
    }
    if (req.method === 'POST' && path === '/api/attach/uploads') {
      if (!authed(req, res)) return true;
      const body = await readBody(req);
      const filename = body['filename'];
      const contentBase64 = body['content_base64'];
      if (typeof filename !== 'string' || filename.trim() === '') {
        throw new AttachError(400, 'filename must be a non-empty string');
      }
      if (typeof contentBase64 !== 'string' || contentBase64 === '') {
        throw new AttachError(400, 'content_base64 must be a non-empty string');
      }
      const bytes = Buffer.from(contentBase64, 'base64');
      const stored = materializeUpload(uploadsDir, { filename, bytes });
      log('info', 'attach upload materialized', {
        path: stored.path,
        bytes: stored.bytes,
      });
      json(res, 201, { path: stored.path, name: stored.name, bytes: stored.bytes });
      return true;
    }
    return false;
  }

  return {
    requestHook(req, res, path): boolean {
      if (!path.startsWith('/api/attach')) return false;
      const startedAt = Date.now();
      let query = new URLSearchParams();
      try {
        query = new URL(req.url ?? '/', 'http://localhost').searchParams;
      } catch {
        /* browse falls back to the root listing */
      }
      handleApi(req, res, path, query)
        .then((handled) => {
          if (!handled && !res.headersSent) {
            json(res, 404, { error: 'not_found', path });
          }
        })
        .catch((error: unknown) => {
          const status = error instanceof AttachError ? error.status : 400;
          const message = String(error instanceof Error ? error.message : error);
          log('warn', 'attach api handler failed', { path, status, error: message });
          if (!res.headersSent) json(res, status, { error: 'attach_failed', detail: message });
        });
      res.on('close', () => {
        log('info', 'attach request', {
          method: req.method,
          path,
          status: res.statusCode,
          duration_ms: Date.now() - startedAt,
        });
      });
      return true;
    },

    dispose(): void {
      // Stateless hook — nothing to release.
    },
  };
}
