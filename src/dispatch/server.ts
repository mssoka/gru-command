import type { IncomingMessage, ServerResponse } from 'node:http';
import { hashToken, tokenConfigured, tokenMatches } from '../auth.js';
import type { GruCommandConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { LedgerApi } from '../ledger/api.js';
import type { NotificationCenter } from '../notifications/center.js';
import type { DispatchService } from './service.js';
import type { WaveRunner } from './perkins.js';
import { rebriefFreshMinion, recordFollowUpDelivery, routeFixDirectiveToMinion, type DirectiveRegistry } from './fix-directive.js';
import type { WorktreePort } from './worktree-port.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Dispatch HTTP surface (EPICS E8 story 2): the authenticated, thin API
 * the Gru chat surface (and the phone) drives the heist flow through.
 * Reads live on the board's own /api surface — this hook owns only the
 * flow endpoints under /api/dispatch.
 */

/** Silas's ops surface (E8 follow-through; owner ruling 2026-09-21): the
 * narrow, authenticated endpoints the hosted silas session drives through
 * its bash tool. No new powers beyond the silas authority (dispatch, track,
 * close, escalate) — every action lands in the ledger as a silas.* event. */
export interface SilasOpsSurface {
  readonly registry: DirectiveRegistry;
  readonly worktrees: WorktreePort;
  readonly notifications: NotificationCenter;
}

export interface DispatchServerOptions {
  readonly config: GruCommandConfig;
  readonly dispatch: DispatchService;
  readonly wave: WaveRunner;
  /** The record of record — silas.* attribution events land here. */
  readonly ledger: LedgerApi;
  /** Absent = /api/silas/* answers 503 (silas ops not hosted). */
  readonly silasOps?: SilasOpsSurface;
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
  const directiveControllers = new Set<AbortController>();

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

  /** Validate the optional attribution field: only 'silas' records silas.*
   * ledger events; any other non-empty value is accepted and inert. */
  function byField(body: Record<string, unknown>): string | undefined {
    return optStrField(body, 'by');
  }

  /** The silas ops surface, or null with a 503 already written — the
   * endpoints are hosted only when silas is enabled in config. */
  function silasOpsOr503(res: ServerResponse): SilasOpsSurface | null {
    if (options.silasOps === undefined) {
      json(res, 503, { error: 'silas_ops_not_hosted', detail: 'silas ops are not hosted on this service' });
      return null;
    }
    return options.silasOps;
  }

  /** Re-open the lane for a Silas follow-through: the follow-up turn is the
   * lane working again. `in-review` is the pre-verdict review window; a
   * `delivered` lane (settled before a PR/review request) re-opens the same
   * way — the fresh directive/re-brief supersedes the prior delivery. */
  function flipJobToWorking(ledger: LedgerApi, jobId: string): void {
    const job = ledger.getJob(jobId);
    if (job === null || (job.status !== 'in-review' && job.status !== 'delivered')) return;
    ledger.setJobStatus(jobId, 'working');
    ledger.noteJob(jobId, 'silas follow-through: fix loop re-opened, lane back to working');
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
      const by = byField(body);
      const jobId = strField(body, 'job_id');
      const job = options.dispatch.recordPr(jobId, strField(body, 'url'));
      if (by === 'silas') {
        options.ledger.appendCustomEvent({
          kind: 'silas.pr-registered',
          jobId,
          payload: { url: job.prUrl },
        });
      }
      json(res, 200, job);
      return true;
    }
    if (req.method === 'POST' && path === '/api/dispatch/review') {
      if (!authed(req, res)) return true;
      const body = await readBody(req);
      const by = byField(body);
      const input = {
        jobId: strField(body, 'job_id'),
        ...(optStrField(body, 'target_ref') !== undefined ? { targetRef: optStrField(body, 'target_ref') } : {}),
        ...(optStrArray(body, 'lenses') !== undefined ? { lenses: optStrArray(body, 'lenses') } : {}),
        ...(optBoolField(body, 'no_spec') !== undefined ? { noSpec: optBoolField(body, 'no_spec') } : {}),
      };
      const outcome = await options.wave.requestReview(input);
      if (by === 'silas') {
        options.ledger.appendCustomEvent({
          kind: 'silas.review-triggered',
          jobId: input.jobId,
          payload: {
            route: outcome.route,
            ...(outcome.route === 'perkins' ? { round_id: outcome.round.id } : {}),
          },
        });
      }
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
    if (req.method === 'POST' && path === '/api/silas/directive') {
      if (!authed(req, res)) return true;
      const ops = silasOpsOr503(res);
      if (ops === null) return true;
      const body = await readBody(req);
      const jobId = strField(body, 'job_id');
      const directive = strField(body, 'directive');
      const fingerprint = optStrField(body, 'blocker_fingerprint');
      const job = options.ledger.getJob(jobId);
      if (job === null) throw new Error(`job "${jobId}" not found`);
      if (job.status === 'merged' || job.status === 'done') {
        throw new Error(`job "${jobId}" is ${job.status} — terminal lanes take no directives`);
      }
      const controller = new AbortController();
      directiveControllers.add(controller);
      let delivery: { delivered: boolean; minionId?: string; note?: string };
      try {
        delivery = await routeFixDirectiveToMinion({
          registry: ops.registry,
          ledger: options.ledger,
          worktrees: ops.worktrees,
          jobId,
          directive,
          signal: controller.signal,
          owner: 'silas-ops',
        });
      } finally {
        directiveControllers.delete(controller);
      }
      if (!delivery.delivered) {
        json(res, 502, { error: 'undelivered', detail: delivery.note ?? 'the directive could not reach the implementing minion' });
        return true;
      }
      options.ledger.appendCustomEvent({
        kind: 'silas.directive-sent',
        jobId,
        payload: {
          minion_id: delivery.minionId ?? null,
          ...(fingerprint !== undefined ? { blocker_fingerprint: fingerprint } : {}),
          directive_bytes: Buffer.byteLength(directive, 'utf-8'),
        },
      });
      flipJobToWorking(options.ledger, jobId);
      // The follow-up delivery signal: the directive turn settled, so record
      // the delivery (with the lane head it produced) that re-arms review.
      const followUp = recordFollowUpDelivery({
        ledger: options.ledger,
        worktrees: ops.worktrees,
        jobId,
        agentId: delivery.minionId ?? null,
        source: 'silas-directive',
      });
      if (followUp.note !== null) {
        log('warn', 'silas follow-up delivery has no resolvable lane head', {
          job: jobId,
          lane: followUp.lanePath,
          note: followUp.note,
        });
      }
      json(res, 200, { job_id: jobId, minion_id: delivery.minionId ?? null, delivered_sha: followUp.sha });
      return true;
    }
    if (req.method === 'POST' && path === '/api/silas/rebrief') {
      if (!authed(req, res)) return true;
      const ops = silasOpsOr503(res);
      if (ops === null) return true;
      const body = await readBody(req);
      const jobId = strField(body, 'job_id');
      const note = strField(body, 'note');
      const job = options.ledger.getJob(jobId);
      if (job === null) throw new Error(`job "${jobId}" not found`);
      if (job.status === 'merged' || job.status === 'done') {
        throw new Error(`job "${jobId}" is ${job.status} — terminal lanes are never re-briefed`);
      }
      const controller = new AbortController();
      directiveControllers.add(controller);
      let result: { minionId: string; lanePath: string; prompt: string };
      try {
        result = await rebriefFreshMinion({
          registry: ops.registry,
          ledger: options.ledger,
          worktrees: ops.worktrees,
          jobId,
          note,
          briefing: job.briefing,
        });
      } finally {
        directiveControllers.delete(controller);
      }
      options.ledger.appendCustomEvent({
        kind: 'silas.rebrief',
        jobId,
        payload: { minion_id: result.minionId, lane: result.lanePath, note },
      });
      flipJobToWorking(options.ledger, jobId);
      // The follow-up delivery signal: the fresh minion's re-brief turn
      // settled; record the delivery that re-arms the re-review.
      const followUp = recordFollowUpDelivery({
        ledger: options.ledger,
        worktrees: ops.worktrees,
        jobId,
        agentId: result.minionId,
        source: 'silas-rebrief',
      });
      if (followUp.note !== null) {
        log('warn', 'silas follow-up delivery has no resolvable lane head', {
          job: jobId,
          lane: followUp.lanePath,
          note: followUp.note,
        });
      }
      json(res, 200, { job_id: jobId, minion_id: result.minionId, lane: result.lanePath, delivered_sha: followUp.sha });
      return true;
    }
    if (req.method === 'POST' && path === '/api/silas/escalate') {
      if (!authed(req, res)) return true;
      const ops = silasOpsOr503(res);
      if (ops === null) return true;
      const body = await readBody(req);
      const title = strField(body, 'title');
      if (title.length > 500) throw new Error('title exceeds 500 characters');
      const detail = optStrField(body, 'detail');
      if (detail !== undefined && detail.length > 4000) throw new Error('detail exceeds 4000 characters');
      const jobId = optStrField(body, 'job_id');
      if (jobId !== undefined && options.ledger.getJob(jobId) === null) {
        throw new Error(`job "${jobId}" not found`);
      }
      const notification = ops.notifications.post({
        kind: 'silas.escalation',
        routing: 'action-required',
        severity: 'error',
        title,
        ...(detail !== undefined ? { detail } : {}),
      });
      options.ledger.appendCustomEvent({
        kind: 'silas.escalated',
        ...(jobId !== undefined ? { jobId } : {}),
        payload: { title, notification_id: notification.id },
      });
      json(res, 200, { notification_id: notification.id });
      return true;
    }
    return false;
  }

  return {
    requestHook(req, res, path): boolean {
      if (!path.startsWith('/api/dispatch') && !path.startsWith('/api/silas')) return false;
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
      // Abort any in-flight directive/re-brief turns so shutdown cannot
      // stall on a wedged minion session; tracked lanes settle on abort.
      for (const controller of directiveControllers) controller.abort();
    },
  };
}
