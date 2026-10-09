import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { hashToken, tokenConfigured, tokenMatches } from '../auth.js';
import type { GruCommandConfig } from '../config.js';
import type { LogLevel } from '../logger.js';
import type { LedgerApi } from '../ledger/api.js';
import type { WorktreePort } from '../dispatch/worktree-port.js';
import { loadWorktreeManifest, resolveVerifyCommand } from '../worktrees/manifest.js';
import {
  VerificationDuplicateError,
  VerificationLockTimeoutError,
  VerificationRequestConflictError,
  VerificationScheduler,
  isValidVerificationRequestId,
  readGitState,
  type VerificationAttemptStatus,
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
 *
 * Single-flight + reconcile (issue #159): an optional client `request_id`
 * gives the submission durable identity; identical (job, lane, scope, head,
 * command) submissions share one producer and a duplicate stream attaches.
 * `GET /api/verify/status` answers accepted/running/completed/unknown by
 * request identity so a lost response is reconciled, never replayed blind.
 *
 * Idle-stream keepalive (incident 2026-10-09): the response body emits an
 * application-level `ping` frame whenever no producer frame has been written
 * for {@link VERIFY_HEARTBEAT_MS}, so a queued slot wait or a quiet producer
 * can never leave the body silent past a streaming client's 300 s default
 * body-idle timeout. The ping is transport liveness only — never producer
 * output, never a terminal frame, and never written after `completed`/`error`.
 */

export interface VerificationServerOptions {
  readonly config: GruCommandConfig;
  readonly ledger: LedgerApi;
  readonly worktrees: WorktreePort;
  /** Test seam: an externally-owned scheduler (started/disposed here too). */
  readonly scheduler?: VerificationScheduler;
  /**
   * Transport heartbeat cadence in milliseconds (test seam; default
   * {@link VERIFY_HEARTBEAT_MS}). Must be a positive integer whose worst-case
   * idle gap (`2 × heartbeatMs`) stays strictly under the client's
   * {@link VERIFY_CLIENT_BODY_IDLE_TIMEOUT_MS}, and at least 10 ms: disabling
   * it, flooding it, or setting it above that bound, is exactly the defect
   * this guards against, so an unusable cadence is refused loudly rather
   * than silently accepted. The guard enforces the hard bounds; the shipped
   * 15,000 ms default keeps an order-of-magnitude margin (≈30 s worst case),
   * and a consumer that configures a non-default HTTP body timeout is not
   * covered by this guard.
   */
  readonly heartbeatMs?: number;
  readonly log?: Log;
}

export interface VerificationServer {
  /** First-mounted hook: claims POST /api/verify and GET /api/verify/status. */
  requestHook(req: IncomingMessage, res: ServerResponse, path: string): boolean;
  /** Board health row (board UX v4): live lock/queue/budget counters. */
  view(): VerificationQueueView;
  dispose(): Promise<void>;
}

const MAX_BODY_BYTES = 64 * 1024;

/**
 * Transport heartbeat cadence (idle-stream keepalive incident, 2026-10-09).
 *
 * A queued slot wait can legitimately last `lock_wait_timeout_ms` (900 s)
 * and a quiet producer can be silent for minutes, while a streaming HTTP
 * client's default body-idle timeout is 300 s (Node 22 / undici built-in
 * `bodyTimeout`): the observer saw queued and quiet-running `/api/verify`
 * streams aborted at a ~301 s silent gap even though the producer kept
 * running. The response body therefore emits an application-level liveness
 * frame whenever it has been silent for one interval, so a valid stream is
 * never truncated for being idle. Idle is measured from `writeHead`; the
 * worst-case gap is 2 × interval (~30 s), an order of magnitude under the
 * client limit.
 */
export const VERIFY_HEARTBEAT_MS = 15_000;

/**
 * The streaming client's default HTTP body-idle timeout (Node 22 / undici
 * `bodyTimeout`). The heartbeat exists to stay strictly under it: a body
 * frame that lands just AFTER a tick skips that tick's ping, so the usable
 * cadence must satisfy `2 × heartbeatMs < this`. Source: the incident report
 * `verify-queued-capture-loss-investigation-20261009` pins Node 22.22.0 /
 * bundled undici 6.23.0's default `bodyTimeout` of 300,000 ms.
 */
export const VERIFY_CLIENT_BODY_IDLE_TIMEOUT_MS = 300_000;

/**
 * Application-level keepalive (same idiom as the chat/board surfaces' `ping`):
 * proves the stream is alive while no producer frame exists. It carries no
 * run identity and no output — it is transport liveness, never producer
 * output, and never a terminal frame.
 */
export interface PingFrame {
  readonly type: 'ping';
}

/** The typed admission failure the surface writes when `scheduler.run` throws. */
export interface VerificationErrorFrame {
  readonly type: 'error';
  readonly code: string;
  readonly detail: string;
  readonly [field: string]: unknown;
}

/**
 * Every frame the `/api/verify` NDJSON stream can carry: the scheduler's
 * progress frames, the transport-liveness {@link PingFrame}, and the typed
 * admission {@link VerificationErrorFrame}. `writeFrame` is typed to exactly
 * this union, so the stream vocabulary is compiler-enforced.
 */
export type VerificationStreamFrame = VerificationProgress | PingFrame | VerificationErrorFrame;

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
  const heartbeatMs = options.heartbeatMs ?? VERIFY_HEARTBEAT_MS;
  if (
    !Number.isInteger(heartbeatMs) ||
    heartbeatMs < 10 ||
    2 * heartbeatMs >= VERIFY_CLIENT_BODY_IDLE_TIMEOUT_MS
  ) {
    throw new Error(
      `verification heartbeat must be an integer of milliseconds in [10, ${String(
        Math.ceil(VERIFY_CLIENT_BODY_IDLE_TIMEOUT_MS / 2) - 1,
      )}] with a worst-case idle gap (2 × heartbeat) strictly under the client's ` +
        `${String(VERIFY_CLIENT_BODY_IDLE_TIMEOUT_MS)} ms body-idle limit, got ${String(heartbeatMs)} — ` +
        'a disabled, flooded or oversized heartbeat reintroduces or worsens the idle-body problem',
    );
  }
  const tokenHash = hashToken(options.config.auth.token);
  const configured = tokenConfigured(options.config.auth.token);
  const ledger = options.ledger;
  const worktrees = options.worktrees;
  /**
   * Every response heartbeat THIS server owns. Per-response cleanup
   * (terminal/close/finally) is not enough: a back-pressured sink can hold
   * scheduler fan-out open, so a run may never settle and 'finally' may
   * never run. dispose() stops them all before awaiting the scheduler.
   */
  const responseHeartbeats = new Set<ReturnType<typeof setInterval>>();

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
    const requestId = optStrField(body, 'request_id');
    if (requestId !== undefined && !isValidVerificationRequestId(requestId)) {
      json(res, 400, {
        error: 'bad_request',
        detail: 'request_id must be 1-128 URL-safe characters ([A-Za-z0-9._:-])',
      });
      return;
    }
    const expectedHead = optStrField(body, 'expected_head');
    if (expectedHead !== undefined && !/^[0-9a-f]{40}$/iu.test(expectedHead)) {
      json(res, 400, {
        error: 'bad_request',
        detail: 'expected_head must be the full 40-character commit sha',
      });
      return;
    }

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

    // Exact-head evidence (issue #159): when the caller names the head it
    // intends to verify, a lane that moved is refused before any producer
    // exists. The run itself still binds the true head it reads at spawn.
    const git = readGitState(lane.path);
    if (expectedHead !== undefined && git.sha !== expectedHead) {
      json(res, 409, {
        error: 'head_changed',
        detail:
          `lane head is ${git.sha ?? 'unknown'}, expected ${expectedHead} — ` +
          'a changed head is a new verification, never a replay',
        expected_head: expectedHead,
        current_head: git.sha,
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
    // Terminal for THIS stream: once `completed`/`error` is written, no
    // transport frame may follow it (a post-terminal frame would be counted
    // malformed and unpromote an otherwise clean capture).
    let terminal = false;
    // Monotonic clock: a wall-clock step must never suppress a heartbeat
    // (or, worse, let a >300 s NTP jump reintroduce the truncation). The
    // idle clock starts at writeHead, so a first frame delayed past one
    // interval (e.g. an attach queued behind a back-pressured sibling) still
    // gets a ping rather than an unbounded silent body.
    let lastBodyWriteAt = performance.now();
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    // One ping write in flight at a time: a tick must not stack drain/close
    // listeners on a stalled socket (Node warns past ten).
    let heartbeatWritePending = false;
    const stopHeartbeat = (): void => {
      if (heartbeat === null) return;
      clearInterval(heartbeat);
      responseHeartbeats.delete(heartbeat);
      heartbeat = null;
    };
    res.on('close', () => {
      closed = true;
      stopHeartbeat();
    });
    const writeFrame = async (frame: VerificationStreamFrame): Promise<void> => {
      const frameType = (frame as { readonly type?: unknown }).type;
      if (frameType === 'completed' || frameType === 'error') {
        terminal = true;
        stopHeartbeat();
      }
      if (closed || res.writableEnded) return;
      const payload = `${JSON.stringify(frame)}\n`;
      try {
        if (!res.write(payload)) {
          await new Promise<void>((resolveDrain) => {
            res.once('drain', () => resolveDrain());
            res.once('close', () => resolveDrain());
          });
        }
        lastBodyWriteAt = performance.now();
      } catch {
        // A synchronous write failure (write-after-end / destroyed stream /
        // serialization): stop the timer now, never leave it ticking for the
        // life of a producer that may not settle for up to run_timeout_ms.
        // A peer disconnect instead surfaces through res' `close` handler.
        closed = true;
        stopHeartbeat();
      }
    };
    // Armed before the run starts: a queued slot wait is the longest
    // legitimate silence the response can have. `unref` so the timer never
    // holds the process open on its own.
    heartbeat = setInterval(() => {
      if (closed || terminal || heartbeatWritePending || res.writableEnded) return;
      if (performance.now() - lastBodyWriteAt < heartbeatMs) return;
      heartbeatWritePending = true;
      void writeFrame({ type: 'ping' } satisfies PingFrame).finally(() => {
        heartbeatWritePending = false;
      });
    }, heartbeatMs);
    heartbeat.unref?.();
    responseHeartbeats.add(heartbeat);

    try {
      await scheduler.run(
        {
          jobId,
          scope,
          command,
          cwd: lane.path,
          head: git.sha,
          ...(requestId === undefined ? {} : { requestId }),
        },
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
          request_id: requestId ?? null,
          started: false,
        });
      } else if (error instanceof VerificationDuplicateError) {
        await writeFrame({
          type: 'error',
          code: error.code,
          detail: error.message,
          run_id: error.runId,
          state: error.state,
          request_id: requestId ?? null,
        });
      } else if (error instanceof VerificationRequestConflictError) {
        await writeFrame({
          type: 'error',
          code: error.code,
          detail: error.message,
          request_id: error.requestId,
        });
      } else {
        await writeFrame({
          type: 'error',
          code: 'verification_failed',
          detail: String(error instanceof Error ? error.message : error),
        });
      }
    } finally {
      stopHeartbeat();
      if (!res.writableEnded) res.end();
    }
  }

  /**
   * Reconcile surface (issue #159): never streams a producer. `unknown` is
   * a real answer — the client learns its submission has no record instead
   * of replaying it blind.
   */
  function handleStatus(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (!authed(req, res)) return;
    const requestId = url.searchParams.get('request_id') ?? undefined;
    const jobId = url.searchParams.get('job_id') ?? undefined;
    if ((requestId ?? '') === '' && (jobId ?? '') === '') {
      json(res, 400, {
        error: 'bad_request',
        detail: 'request_id or job_id query parameter is required',
      });
      return;
    }
    if (requestId !== undefined && !isValidVerificationRequestId(requestId)) {
      json(res, 400, { error: 'bad_request', detail: 'request_id is not a valid identity' });
      return;
    }
    const scope = url.searchParams.get('scope') ?? undefined;
    const cwd = url.searchParams.get('cwd') ?? undefined;
    const head = url.searchParams.get('head') ?? undefined;
    const status: VerificationAttemptStatus = scheduler.attemptStatus({
      ...(requestId === undefined ? {} : { requestId }),
      ...(jobId === undefined ? {} : { jobId }),
      ...(scope === undefined ? {} : { scope }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(head === undefined ? {} : { head }),
    });
    json(res, 200, status);
  }

  return {
    view(): VerificationQueueView {
      return scheduler.view();
    },

    requestHook(req, res, path): boolean {
      if (path === '/api/verify/status') {
        if (req.method !== 'GET') {
          req.resume();
          json(res, 405, { error: 'method_not_allowed', allowed: ['GET'] });
          return true;
        }
        handleStatus(req, res, new URL(req.url ?? '/api/verify/status', 'http://localhost'));
        return true;
      }
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
      // Stop every response heartbeat BEFORE awaiting the scheduler: a
      // back-pressured sink can leave a response's run unsettled, so its
      // terminal/close/finally cleanup may not have run yet. Producer
      // outcomes, scheduler concurrency and budgets are untouched here.
      for (const timer of [...responseHeartbeats]) {
        clearInterval(timer);
        responseHeartbeats.delete(timer);
      }
      await scheduler.dispose();
    },
  };
}
