import type { IncomingMessage, ServerResponse } from 'node:http';
import { hashToken, tokenConfigured, tokenMatches } from '../auth.js';
import type { PrMediaConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import { isTerminalJobStatus } from '../ledger/states.js';
import { readGitState } from '../verify/scheduler.js';
import {
  findMedia,
  isFullSha,
  listMedia,
  MEDIA_MAX_FILE_BYTES,
  MediaError,
  readMediaBytes,
  storeMedia,
  validateCaption,
  validateRole,
  type MediaItem,
  type MediaLedger,
} from './store.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * The PR media HTTP surface (owner rulings 2026-11-15, docs/PR-MEDIA.md),
 * token-authed like every service call:
 *
 *   POST /api/media                 — a minion submits one capture of its
 *                                     lane's committed head
 *   GET  /api/media?job_id=<id>     — the job's captures (metadata only)
 *   GET  /api/media/<media id>      — one capture's bytes (the board's
 *                                     FOR YOU previews), hash re-verified
 *
 * A capture binds only when the job's live lane sits at exactly the named
 * head with a clean tracked tree at submission: the record then says which
 * commit the pixels claim to show, and the board and publisher never present
 * it against any other head.
 */

/** Base64 inflates 4/3; wrapped base64 (76-character lines, JSON-escaped
 * newlines) adds about 3% more; plus the JSON fields around it. The decoded
 * capture is bounded separately, exactly. */
export const MEDIA_MAX_BODY_BYTES = Math.ceil(((MEDIA_MAX_FILE_BYTES * 4) / 3) * 1.05) + 64 * 1024;

export interface MediaServerLedger extends MediaLedger {
  getJob(id: string): { readonly id: string; readonly status: string } | null;
  listWorktrees(opts?: { jobId?: string }): readonly {
    readonly kind: string;
    readonly path: string;
    readonly status: string;
  }[];
}

export interface MediaServerOptions {
  readonly ledger: MediaServerLedger;
  readonly dataDir: string;
  readonly token: string;
  /** Read per request, so a config reload is honored without a restart. */
  readonly config: () => PrMediaConfig;
  /** Test seam; production reads the lane with git. */
  readonly gitState?: (cwd: string) => { readonly sha: string | null; readonly trackedDirty: boolean };
  readonly log?: Log;
}

export interface MediaServer {
  requestHook(req: IncomingMessage, res: ServerResponse, path: string): boolean;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** The metadata a caller may see: no store paths. */
export function mediaView(item: MediaItem): Record<string, unknown> {
  return {
    id: item.id,
    job_id: item.jobId,
    head_sha: item.headSha,
    media_type: item.mediaType,
    kind: item.kind,
    role: item.role,
    caption: item.caption,
    bytes: item.bytes,
    sha256: item.sha256,
    captured_by: item.capturedBy,
    recorded_at: item.recordedAt,
  };
}

export function createMediaServer(options: MediaServerOptions): MediaServer {
  const log = options.log ?? (() => {});
  const tokenHash = hashToken(options.token);
  const configured = tokenConfigured(options.token);
  const gitState = options.gitState ?? ((cwd: string) => readGitState(cwd));

  function authed(req: IncomingMessage, res: ServerResponse): boolean {
    if (!configured) {
      json(res, 503, { error: 'not_configured', detail: 'no pairing token configured' });
      return false;
    }
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer (.+)$/u.exec(header.trim()) : null;
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
        if (seen > MEDIA_MAX_BODY_BYTES) {
          rejected = true;
          chunks.length = 0;
          rejectBody(new MediaError(413, 'media_too_large', `request body exceeds ${MEDIA_MAX_BODY_BYTES} bytes; a capture is at most ${MEDIA_MAX_FILE_BYTES} bytes`));
          // Keep draining so the client reads the 413 instead of a reset.
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (rejected) return;
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            rejectBody(new MediaError(400, 'bad_request', 'request body must be a JSON object'));
            return;
          }
          resolveBody(parsed as Record<string, unknown>);
        } catch {
          rejectBody(new MediaError(400, 'bad_request', 'request body is not valid JSON'));
        }
      });
      req.on('error', (error: Error) => {
        if (!rejected) rejectBody(new MediaError(400, 'bad_request', String(error)));
      });
    });
  }

  function requireEnabled(): void {
    if (!options.config().enabled) {
      throw new MediaError(409, 'pr_media_disabled', 'PR media is turned off on this instance ([pr_media] enabled = false)');
    }
  }

  async function handleSubmit(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    requireEnabled();
    const jobId = body['job_id'];
    const headSha = body['head_sha'];
    const content = body['content_base64'];
    if (typeof jobId !== 'string' || jobId === '') throw new MediaError(400, 'bad_request', 'job_id must be a non-empty string');
    if (typeof headSha !== 'string' || !isFullSha(headSha)) {
      throw new MediaError(400, 'bad_request', 'head_sha must be the full 40-character lowercase commit sha of your lane HEAD');
    }
    if (typeof content !== 'string' || content === '') throw new MediaError(400, 'bad_request', 'content_base64 must be a non-empty string');
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(content.replace(/\s+/gu, ''))) {
      throw new MediaError(400, 'bad_request', 'content_base64 is not valid base64');
    }
    const role = validateRole(body['role']);
    const caption = validateCaption(body['caption']);
    const job = options.ledger.getJob(jobId);
    if (job === null) throw new MediaError(404, 'job_not_found', `job "${jobId}" not found`);
    if (isTerminalJobStatus(job.status)) {
      throw new MediaError(409, 'job_terminal', `job "${jobId}" is ${job.status}; captures bind only to a live lane`);
    }
    const lanes = options.ledger
      .listWorktrees({ jobId })
      .filter((candidate) => candidate.kind === 'job' && candidate.status !== 'swept');
    if (lanes.length === 0) {
      throw new MediaError(409, 'no_active_lane', `job "${jobId}" has no active job worktree lane`);
    }
    if (lanes.length > 1) {
      throw new MediaError(409, 'lane_ambiguous', `job "${jobId}" has ${lanes.length} live job lanes; captures bind to exactly one`);
    }
    const lane = lanes[0]!;
    const state = gitState(lane.path);
    if (state.sha === null) throw new MediaError(409, 'lane_unreadable', `could not read HEAD of job "${jobId}"'s lane`);
    if (state.sha !== headSha) {
      res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: 'head_mismatch',
        detail: `the lane is at ${state.sha}, not ${headSha}: capture the lane's current committed head`,
        lane_head: state.sha,
      }));
      return;
    }
    if (state.trackedDirty) {
      throw new MediaError(409, 'dirty_tree', 'the lane has uncommitted tracked changes: commit first, then capture that head');
    }
    const item = storeMedia({
      dataDir: options.dataDir,
      ledger: options.ledger,
      jobId,
      headSha,
      caption,
      role,
      bytes: Buffer.from(content, 'base64'),
    });
    log('info', 'pr media captured', { job: jobId, media: item.id, head: headSha, type: item.mediaType, bytes: item.bytes });
    json(res, 201, mediaView(item));
  }

  function handleList(res: ServerResponse, query: URLSearchParams): void {
    requireEnabled();
    const jobId = query.get('job_id');
    if (jobId === null || jobId === '') throw new MediaError(400, 'bad_request', 'job_id query parameter is required');
    if (options.ledger.getJob(jobId) === null) throw new MediaError(404, 'job_not_found', `job "${jobId}" not found`);
    json(res, 200, { job_id: jobId, media: listMedia(options.ledger, jobId).map(mediaView) });
  }

  function handleBytes(res: ServerResponse, id: string): void {
    requireEnabled();
    const item = findMedia(options.ledger, id);
    if (item === null) throw new MediaError(404, 'media_not_found', `capture "${id}" not found`);
    const bytes = readMediaBytes(options.dataDir, item);
    res.writeHead(200, {
      'content-type': item.mediaType,
      'content-length': String(bytes.length),
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    res.end(bytes);
  }

  async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    let query = new URLSearchParams();
    try {
      query = new URL(req.url ?? '/', 'http://localhost').searchParams;
    } catch {
      /* no query */
    }
    if (path === '/api/media' && req.method === 'POST') {
      if (!authed(req, res)) return true;
      await handleSubmit(req, res);
      return true;
    }
    if (path === '/api/media' && req.method === 'GET') {
      if (!authed(req, res)) return true;
      handleList(res, query);
      return true;
    }
    const byId = /^\/api\/media\/([^/]+)$/u.exec(path);
    if (byId !== null && req.method === 'GET') {
      if (!authed(req, res)) return true;
      let id: string;
      try {
        id = decodeURIComponent(byId[1] ?? '');
      } catch {
        throw new MediaError(404, 'media_not_found', 'capture id is not a valid capture id');
      }
      handleBytes(res, id);
      return true;
    }
    return false;
  }

  return {
    requestHook(req, res, path): boolean {
      if (path !== '/api/media' && !path.startsWith('/api/media/')) return false;
      handle(req, res, path)
        .then((handled) => {
          if (!handled && !res.headersSent) json(res, 405, { error: 'method_not_allowed', path });
        })
        .catch((error: unknown) => {
          if (error instanceof MediaError) {
            if (!res.headersSent) json(res, error.status, { error: error.code, detail: error.message });
            return;
          }
          const message = String(error instanceof Error ? error.message : error);
          log('warn', 'pr media request failed', { path, error: message });
          if (!res.headersSent) json(res, 500, { error: 'media_failed', detail: message });
        });
      return true;
    },
  };
}
