import type { IncomingMessage, ServerResponse } from 'node:http';
import { hashToken, tokenConfigured, tokenMatches } from '../auth.js';
import type { GruCommandConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { WorktreeManager } from './manager.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Worktree lane HTTP surface (Perkins r4 split): the release/answer
 * endpoints live WITH the manager — the pause-and-ask join and its
 * answer path are one subsystem. Claims only /api/dispatch/release;
 * every other dispatch path belongs to the core's server.
 *
 * The ask/answer contract: a paused response carries the FULL process
 * list (pid, command, how it was tied to the tree) and the ask note —
 * a human acknowledges against that payload. confirm_kill answers the
 * RECORDED ask (see the manager); it is accepted for job, round, or
 * raw worktree ids, so every pause is answerable by construction.
 */

export interface WorktreeServerOptions {
  readonly config: GruCommandConfig;
  readonly manager: WorktreeManager;
  readonly log?: Log;
}

export interface WorktreeServer {
  requestHook(req: IncomingMessage, res: ServerResponse, path: string): boolean;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function strField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function optStrField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

export function createWorktreeServer(options: WorktreeServerOptions): WorktreeServer {
  const log = options.log ?? (() => {});
  const tokenHash = hashToken(options.config.auth.token);
  const configured = tokenConfigured(options.config.auth.token);
  const manager = options.manager;

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
      req.on('data', (chunk: Buffer) => {
        seen += chunk.length;
        if (seen > 512 * 1024) {
          rejectBody(new Error('request body exceeds 512 KiB'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
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
      req.on('error', (error) => rejectBody(error));
    });
  }

  async function handleRelease(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authed(req, res)) return;
    const body = await readBody(req);
    const confirmKill = body['confirm_kill'] === true;
    const baseBranch = optStrField(body, 'base_branch');
    const rawId = optStrField(body, 'worktree_id') ?? optStrField(body, 'round_id');
    // Resolve the lane: an explicit worktree/round id, or the job's lane.
    let worktreeId: string;
    if (rawId !== undefined) {
      worktreeId = rawId;
      if (manager.getWorktree(worktreeId) === null) {
        json(res, 404, { error: 'not_found', detail: `no worktree "${worktreeId}" in the registry` });
        return;
      }
    } else {
      const jobId = strField(body, 'job_id');
      const lanes = manager.listWorktrees({ jobId });
      const active = lanes.find((lane) => lane.status !== 'swept');
      if (active === undefined) {
        json(res, 404, { error: 'not_found', detail: 'no active worktree for this job' });
        return;
      }
      worktreeId = active.id;
    }
    const result = await manager.release({
      worktreeId,
      ...(confirmKill ? { confirmKill: true } : {}),
      ...(baseBranch !== undefined ? { baseBranch } : {}),
    });
    // The answer payload: status, the FULL process list when paused (the
    // human acknowledges against it), the ask note, the preserve record.
    json(res, 200, result);
  }

  return {
    requestHook(req, res, path): boolean {
      if (!(req.method === 'POST' && path === '/api/dispatch/release')) return false;
      const startedAt = Date.now();
      handleRelease(req, res)
        .catch((error: unknown) => {
          const message = String(error instanceof Error ? error.message : error);
          log('error', 'worktree release handler failed', { path, error: message });
          if (!res.headersSent) json(res, 400, { error: 'bad_request', detail: message });
        })
        .finally(() => {
          log('info', 'worktree release request', {
            path,
            status: res.statusCode,
            duration_ms: Date.now() - startedAt,
          });
        });
      return true;
    },
  };
}
