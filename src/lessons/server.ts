import type { IncomingMessage, ServerResponse } from 'node:http';
import { hashToken, tokenConfigured, tokenMatches } from '../auth.js';
import type { GruCommandConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { BibleStore } from './bible.js';
import type { JournalStore } from './journal.js';
import { JournalError, type JournalKind, type LessonsReferencePort } from './types.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Book of Lessons HTTP surface: the authenticated journal append/list the
 * hosted agents use (Gru and Silas capture through this door), plus the
 * reference lookup that renders pointer lines from the index. Thin by
 * design — the store and the dream own the behavior.
 */

export interface LessonsServerOptions {
  readonly config: GruCommandConfig;
  readonly journal: JournalStore;
  readonly bible: BibleStore;
  readonly references: LessonsReferencePort;
  readonly log?: Log;
}

export interface LessonsServer {
  /** First-mounted hook: claims /api/journal* and /api/lessons*. */
  requestHook(req: IncomingMessage, res: ServerResponse, path: string): boolean;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function createLessonsServer(options: LessonsServerOptions): LessonsServer {
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

  function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolveBody, rejectBody) => {
      let seen = 0;
      const chunks: Buffer[] = [];
      let rejected = false;
      req.on('data', (chunk: Buffer) => {
        if (rejected) return;
        seen += chunk.length;
        if (seen > 256 * 1024) {
          rejected = true;
          rejectBody(new Error('request body exceeds 256 KiB'));
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

  async function handle(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<boolean> {
    if (path === '/api/journal' && req.method === 'POST') {
      if (!authed(req, res)) return true;
      const body = await readBody(req);
      const kind = body['kind'];
      if (typeof kind !== 'string') throw new JournalError('kind must be a string');
      const source = body['source'];
      if (typeof source !== 'string') throw new JournalError('source must be a string');
      const entryBody = body['body'];
      if (typeof entryBody !== 'string') throw new JournalError('body must be a string');
      const tags = body['tags'];
      if (tags !== undefined && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string'))) {
        throw new JournalError('tags must be an array of strings');
      }
      const entry = options.journal.append({
        kind: kind as JournalKind,
        source,
        body: entryBody,
        ...(tags !== undefined ? { tags: tags as readonly string[] } : {}),
      });
      json(res, 201, { entry });
      return true;
    }
    if (path === '/api/journal' && req.method === 'GET') {
      if (!authed(req, res)) return true;
      const after = intParam(url, 'after', 0);
      const limit = intParam(url, 'limit', 100);
      const entries = options.journal.list({ after, limit });
      json(res, 200, { entries, latest_seq: options.journal.latestSeq() });
      return true;
    }
    if (path === '/api/lessons' && req.method === 'GET') {
      if (!authed(req, res)) return true;
      const task = url.searchParams.get('task') ?? '';
      const pointers = task.trim() === '' ? [] : options.references.referencesFor(task);
      json(res, 200, { index: options.bible.readIndexText(), references: pointers });
      return true;
    }
    return false;
  }

  return {
    requestHook(req, res, path): boolean {
      if (!path.startsWith('/api/journal') && !path.startsWith('/api/lessons')) return false;
      const startedAt = Date.now();
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://localhost');
      } catch {
        json(res, 400, { error: 'bad_request', detail: 'malformed request target' });
        return true;
      }
      handle(req, res, path, url)
        .then((handled) => {
          if (!handled && !res.headersSent) json(res, 404, { error: 'not_found', path });
        })
        .catch((error: unknown) => {
          const message = String(error instanceof Error ? error.message : error);
          if (!res.headersSent) json(res, 400, { error: 'bad_request', detail: message });
          log('info', 'lessons api request rejected', { path, detail: message });
        })
        .finally(() => {
          log('info', 'lessons request', {
            method: req.method,
            path,
            status: res.statusCode,
            duration_ms: Date.now() - startedAt,
          });
        });
      return true;
    },
  };
}

function intParam(url: URL, name: string, fallback: number): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new JournalError(`${name} must be a non-negative integer`);
  }
  return value;
}
