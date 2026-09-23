import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { hashToken, tokenConfigured, tokenMatches } from '../auth.js';
import type { GruCommandConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { LedgerApi } from '../ledger/api.js';
import type { WorktreePort } from '../dispatch/worktree-port.js';
import { loadWorktreeManifest, resolveVerifyCommand } from '../worktrees/manifest.js';
import {
  VerificationLockTimeoutError,
  VerificationScheduler,
  type VerificationLease,
  type VerificationProgress,
  type VerificationQueueView,
  type VerificationSchedulerOptions,
} from './scheduler.js';

type Log = (level: LogLevel, msg: string, fields?: Record<string, unknown>) => void;

/**
 * Verification HTTP surface (contention fix, 2026-09-22): the lane-facing
 * door to the scheduler. `POST /api/verify {job_id, scope}` resolves the
 * job's active lane worktree, loads the project's declared verify command
 * from its `.gru-command/worktree.toml`, and runs it under the GLOBAL test
 * budget — streaming NDJSON progress (queued → started → output* →
 * completed | error) until the run settles. Every run is recorded to the
 * ledger so review's tests lens consumes recorded evidence, not pasted
 * reports. Lock-wait timeouts surface as a typed `error` frame (and a
 * `verification.lock-timeout` ledger record) — never a silent hang.
 */

export interface VerificationServerOptions {
  readonly config: GruCommandConfig;
  readonly ledger: LedgerApi;
  readonly worktrees: WorktreePort;
  /** Test seam: an externally-owned scheduler (started/disposed here too). */
  readonly scheduler?: VerificationScheduler;
  readonly log?: Log;
}

export interface VerificationServer {
  /** First-mounted hook: claims POST /api/verify, passes everything else. */
  requestHook(req: IncomingMessage, res: ServerResponse, path: string): boolean;
  /** Board health row (board UX v4): live lock/queue/budget counters. */
  view(): VerificationQueueView;
  dispose(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;

function json(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(body)}\n`);
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

/** The scope a request runs when it names none. */
export const DEFAULT_VERIFY_SCOPE = 'full';

export function createVerificationServer(options: VerificationServerOptions): VerificationServer {
  const log = options.log ?? (() => {});
  const tokenHash = hashToken(options.config.auth.token);
  const configured = tokenConfigured(options.config.auth.token);
  const ledger = options.ledger;
  const worktrees = options.worktrees;

  const scheduler =
    options.scheduler ??
    new VerificationScheduler({
      storageDir: join(options.config.dataDir, 'verify'),
      limits: {
        maxConcurrent: options.config.verify.maxConcurrent,
        workerBudget: options.config.verify.workerBudget,
        lockWaitTimeoutMs: options.config.verify.lockWaitTimeoutMs,
        runTimeoutMs: options.config.verify.runTimeoutMs,
      },
      record: (event) => {
        ledger.appendCustomEvent({
          kind: event.kind,
          jobId: event.jobId,
          payload: event.payload,
        });
      },
      // Lane process tracking (owner incident 2026-09-23): a verification
      // run is the orchestrator's own spawned service. Its pid is recorded
      // against the lane worktree here and reaped by the sweep on teardown
      // (evidence 'registry'); without this a leaked run paused the sweep on
      // a human ask nobody answered, for hours.
      onSpawn: ({ lease, pid, command }) => {
        trackLaneProcess(lease, pid, command, 'live');
      },
      onSettled: ({ lease, pid, command }) => {
        trackLaneProcess(lease, pid, command, 'killed');
      },
      log,
    } satisfies VerificationSchedulerOptions);
  scheduler.start();

  /** Best-effort lane-process registration; never fails the run it reports. */
  function trackLaneProcess(
    lease: VerificationLease,
    pid: number | null,
    command: string,
    state: 'live' | 'killed',
  ): void {
    if (pid === null) return;
    try {
      const lane = worktrees
        .listWorktrees({ jobId: lease.jobId })
        .find(
          (candidate) =>
            candidate.kind === 'job' && candidate.path === lease.cwd && candidate.status !== 'swept',
        );
      if (lane === undefined) return;
      // Ports that are not ledger-backed (test doubles) have no row to hold
      // the process record; nothing to protect there either.
      if (ledger.getWorktree(lane.id) === null) return;
      ledger.recordWorktreeProcesses({
        worktreeId: lane.id,
        processes: [{ pid, command, evidence: 'registry' }],
        state,
      });
    } catch (error) {
      log('error', 'verification lane process tracking failed', {
        job: lease.jobId,
        pid,
        error: String(error),
      });
    }
  }

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
        if (seen > MAX_BODY_BYTES) {
          rejected = true;
          rejectBody(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
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

  async function handleVerify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!authed(req, res)) return;
    const body = await readBody(req);
    const jobId = strField(body, 'job_id');
    const scope = optStrField(body, 'scope') ?? DEFAULT_VERIFY_SCOPE;

    const job = ledger.getJob(jobId);
    if (job === null) {
      json(res, 404, { error: 'job_not_found', detail: `job "${jobId}" not found` });
      return;
    }
    const lane = worktrees
      .listWorktrees({ jobId })
      .find((candidate) => candidate.kind === 'job' && candidate.status !== 'swept');
    if (lane === undefined) {
      json(res, 409, {
        error: 'no_active_lane',
        detail: `job "${jobId}" has no active job worktree lane in the registry`,
      });
      return;
    }
    const manifest = loadWorktreeManifest(lane.path, log);
    if (manifest === null || Object.keys(manifest.verify).length === 0) {
      json(res, 409, {
        error: 'no_verify_command',
        detail:
          `job "${jobId}"'s repository does not declare a verify command; add ` +
          `[verify] scopes (e.g. full = "npm test") to .gru-command/worktree.toml and commit it`,
      });
      return;
    }
    let command: string;
    try {
      command = resolveVerifyCommand(manifest, scope);
    } catch (error) {
      json(res, 400, {
        error: 'unknown_scope',
        detail: String(error instanceof Error ? error.message : error),
        declared_scopes: Object.keys(manifest.verify).sort(),
      });
      return;
    }

    // Streaming begins here: 200 + NDJSON frames. A lock-wait timeout can
    // only land as an `error` frame once the stream has started — the frame
    // is the loud surface, and the ledger carries the record.
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'close',
    });
    let closed = false;
    res.on('close', () => {
      closed = true;
    });
    const writeFrame = async (frame: VerificationProgress | Record<string, unknown>): Promise<void> => {
      if (closed || res.writableEnded) return;
      const payload = `${JSON.stringify(frame)}\n`;
      try {
        if (!res.write(payload)) {
          await new Promise<void>((resolveDrain) => {
            res.once('drain', () => resolveDrain());
            res.once('close', () => resolveDrain());
          });
        }
      } catch {
        closed = true;
      }
    };

    try {
      await scheduler.run(
        { jobId, scope, command, cwd: lane.path },
        writeFrame,
      );
    } catch (error) {
      if (error instanceof VerificationLockTimeoutError) {
        await writeFrame({
          type: 'error',
          code: error.code,
          detail: error.message,
          wait_ms: error.waitMs,
          active: error.active,
          queued: error.queued,
        });
      } else {
        await writeFrame({
          type: 'error',
          code: 'verification_failed',
          detail: String(error instanceof Error ? error.message : error),
        });
      }
    } finally {
      if (!res.writableEnded) res.end();
    }
  }

  return {
    view(): VerificationQueueView {
      return scheduler.view();
    },

    requestHook(req, res, path): boolean {
      if (path !== '/api/verify') return false;
      if (req.method !== 'POST') {
        req.resume();
        json(res, 405, { error: 'method_not_allowed', allowed: ['POST'] });
        return true;
      }
      const startedAt = Date.now();
      handleVerify(req, res)
        .catch((error: unknown) => {
          const message = String(error instanceof Error ? error.message : error);
          log('error', 'verify api handler failed', { path, error: message });
          if (!res.headersSent) json(res, 400, { error: 'bad_request', detail: message });
          else if (!res.writableEnded) res.end();
        })
        .finally(() => {
          log('info', 'verify request', {
            path,
            status: res.statusCode,
            duration_ms: Date.now() - startedAt,
          });
        });
      return true;
    },

    async dispose(): Promise<void> {
      await scheduler.dispose();
    },
  };
}
