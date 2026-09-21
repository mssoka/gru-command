import type { IncomingMessage, ServerResponse } from 'node:http';
import { hashToken, tokenConfigured, tokenMatches } from '../auth.js';
import type { GruCommandConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { DispatchService } from './service.js';
import type { WaveRunner } from './perkins.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Dispatch HTTP surface (EPICS E8 story 2): the authenticated, thin API
 * the Gru chat surface (and the phone) drives the heist flow through.
 * Reads live on the board's own /api surface — this hook owns only the
 * flow endpoints under /api/dispatch.
 */

export interface DispatchServerOptions {
  readonly config: GruCommandConfig;
  readonly dispatch: DispatchService;
  readonly wave: WaveRunner;
  readonly log?: Log;
}

export interface DispatchServer {
  /** First-mounted hook: claims /api/dispatch*, passes everything else. */
  requestHook(req: IncomingMessage, res: ServerResponse, path: string): boolean;
  dispose(): void;
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

function optBoolField(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${field} must be a boolean`);
  return value;
}

function optStrArray(body: Record<string, unknown>, field: string): readonly string[] | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new Error(`${field} must be an array of non-empty strings`);
  }
  return value as readonly string[];
}

export function createDispatchServer(options: DispatchServerOptions): DispatchServer {
  const log = options.log ?? (() => {});
  const tokenHash = hashToken(options.config.auth.token);
  const configured = tokenConfigured(options.config.auth.token);
  const inFlight = new Set<Promise<unknown>>();

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
        if (seen > 512 * 1024) {
          rejected = true;
          rejectBody(new Error('request body exceeds 512 KiB'));
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

  function track(promise: Promise<unknown>): void {
    inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise)).catch(() => {});
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    if (req.method === 'POST' && path === '/api/dispatch') {
      if (!authed(req, res)) return true;
      const body = await readBody(req);
      const outcome = await options.dispatch.dispatch({
        jobId: strField(body, 'job_id'),
        repoPath: strField(body, 'repo_path'),
        title: strField(body, 'title'),
        briefing: strField(body, 'briefing'),
      });
      // The minion's turn runs in the background; the board carries the
      // lifecycle. Track it so dispose() never orphans a live lane.
      track(outcome.settled);
      json(res, 202, {
        job_id: outcome.job.id,
        status: outcome.job.status,
        worktree: outcome.worktree.path,
        branch: outcome.worktree.branch,
        agent_id: outcome.agentId,
      });
      return true;
    }
    if (req.method === 'POST' && path === '/api/dispatch/pr') {
      if (!authed(req, res)) return true;
      const body = await readBody(req);
      const job = options.dispatch.recordPr(strField(body, 'job_id'), strField(body, 'url'));
      json(res, 200, job);
      return true;
    }
    if (req.method === 'POST' && path === '/api/dispatch/review') {
      if (!authed(req, res)) return true;
      const body = await readBody(req);
      const input = {
        jobId: strField(body, 'job_id'),
        ...(optStrField(body, 'target_ref') !== undefined ? { targetRef: optStrField(body, 'target_ref') } : {}),
        ...(optStrArray(body, 'lenses') !== undefined ? { lenses: optStrArray(body, 'lenses') } : {}),
        ...(optBoolField(body, 'no_spec') !== undefined ? { noSpec: optBoolField(body, 'no_spec') } : {}),
      };
      const outcome = await options.wave.requestReview(input);
      if (outcome.route !== 'perkins') {
        // bmad-review fallback gate: findings, triage, and fix directives run
        // in the background; the response names the failed pre-flight legs.
        track(outcome.run);
        json(res, 202, {
          route: outcome.route,
          clear_to_merge: outcome.clearToMerge,
          skill_installed: outcome.skillInstalled,
          failed_legs: outcome.failedLegs.map((leg) => ({ leg: leg.leg, detail: leg.detail, remediation: leg.remediation })),
          note: outcome.note,
        });
        return true;
      }
      track(outcome.run);
      json(res, 202, {
        route: 'perkins',
        round_id: outcome.round.id,
        status: outcome.round.status,
        lenses: outcome.round.lenses.map((chip) => chip.lens),
      });
      return true;
    }
    const worktreesMatch = /^\/api\/dispatch\/jobs\/([^/]+)\/worktrees$/.exec(path);
    if (req.method === 'GET' && worktreesMatch !== null) {
      if (!authed(req, res)) return true;
      const rows = options.dispatch.worktreesFor(decodeURIComponent(worktreesMatch[1] ?? ''));
      json(res, 200, { worktrees: rows });
      return true;
    }
    return false;
  }

  return {
    requestHook(req, res, path): boolean {
      if (!path.startsWith('/api/dispatch')) return false;
      const startedAt = Date.now();
      handleApi(req, res, path)
        .then((handled) => {
          if (!handled && !res.headersSent) {
            json(res, 404, { error: 'not_found', path });
          }
        })
        .catch((error: unknown) => {
          const message = String(error instanceof Error ? error.message : error);
          log('error', 'dispatch api handler failed', { path, error: message });
          if (!res.headersSent) json(res, 400, { error: 'bad_request', detail: message });
        });
      res.on('close', () => {
        log('info', 'dispatch request', {
          method: req.method,
          path,
          status: res.statusCode,
          duration_ms: Date.now() - startedAt,
        });
      });
      return true;
    },

    dispose(): void {
      // Fire-and-forget lanes are tracked; the manager/service own their
      // own disposal — this surface just stops claiming requests.
    },
  };
}
