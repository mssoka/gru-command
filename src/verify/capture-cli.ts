#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pathToFileURL } from 'node:url';
import { parse, TomlError } from 'smol-toml';
import { pidAlive } from './scheduler.js';
import {
  CAPTURE_OWNER_VERSION,
  CAPTURE_RECEIPT_VERSION,
  CaptureOwnerExistsError,
  CaptureSinkExistsError,
  NdjsonCaptureReader,
  captureOwnerPath,
  captureReceiptPath,
  captureReceiptSucceeded,
  captureRefusalDetail,
  capturedOutcomeFields,
  openExclusiveCaptureSink,
  readCaptureOwner,
  removeCaptureOwner,
  withdrawCaptureOwner,
  writeCaptureOwner,
  writeCaptureReceipt,
  type CaptureOutcome,
  type CaptureOwnerRecord,
  type CaptureReceipt,
  type ProcessProbe,
} from './capture.js';

/**
 * `gru-verify-capture` — the SUPPORTED verification capture helper (issue
 * #159). Replaces the hand-rolled "watch-and-fire" orchestration that let
 * multiple helpers truncate one shared NDJSON sink:
 *
 *   node dist/verify/capture-cli.js run --job <id> [--scope full] \
 *     --sink <unique.ndjson> [--request-id <id>] [--expected-head <sha>] \
 *     [--wait-budget-ms <n>] --url <base> --config <config.toml> [--token <token>]
 *
 * The sink is created exclusively BEFORE the POST, every NDJSON frame is
 * streamed to EOF, and the terminal receipt (`<sink>.receipt.json`) binds
 * run id, head/dirty, exit/outcome and output length/hash. A stream that
 * ends without a valid terminal completion is `unknown`, never success.
 * Reconnecting with the same `--request-id` reconciles (attach/replay) on
 * the server — it never replays an unknown-outcome submission blind.
 *
 * `run` never abandons an accepted request (issue #554): a connect +
 * response-headers timeout re-submits the SAME `request_id` and body, so the
 * scheduler attaches it to the in-flight run (and replays the output frames
 * it missed) or replays the completed run's retained output. Its total wait
 * is bounded by `--wait-budget-ms` (default {@link CAPTURE_WAIT_BUDGET_MS});
 * only past that bound is the receipt an honest `unknown` that names the
 * request id and the reconcile path. A completed capture is promotable only
 * when the sink's reassembled output equals the run's recorded output.
 *
 *   node dist/verify/capture-cli.js status --request-id <id> --url <base> --config <c>
 *   node dist/verify/capture-cli.js withdraw --owner <sink>.owner.json
 *
 * `withdraw` validates pid + start time + command/cwd before signalling;
 * malformed records, dead owners and recycled pids never touch an
 * unrelated process, and sink/receipt files are never deleted.
 */

export const CAPTURE_EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  unknown: 3,
  admissionFailed: 4,
} as const;

export type CaptureExitCode = (typeof CAPTURE_EXIT)[keyof typeof CAPTURE_EXIT];

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Connect + response-headers bound for the capture transport (#389). */
export const CAPTURE_RESPONSE_HEADERS_TIMEOUT_MS = 60_000;
/** The errno-style code a response-headers timeout carries into the receipt. */
export const CAPTURE_RESPONSE_TIMEOUT_CODE = 'ERESPONSETIMEOUT';
/**
 * Default bound on ONE capture's total wait for a terminal frame (#554): the
 * shipped `[verify]` defaults, `lock_wait_timeout_ms` (900,000) +
 * `run_timeout_ms` (1,800,000), plus a 120,000 ms margin. The helper never
 * reads the service's configured limits; an operator whose service uses
 * larger bounds passes `--wait-budget-ms` explicitly.
 */
export const CAPTURE_WAIT_BUDGET_MS = 2_820_000;
/** Pause between a headers-timeout re-submit and the next one (#554): a burst
 * of tiny headers bounds must not become a busy loop against the service. */
export const CAPTURE_RESUBMIT_DELAY_MS = 1_000;

/** Node's setTimeout ceiling: a larger delay overflows and fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/** A headers bound that cannot time correctly is refused by name (#389):
 * NaN/infinite, below Node's 1 ms timer floor (which coerces it to 1 ms) or
 * past the timer ceiling (which overflows) would fire at once and fail every
 * request with a misleading timeout. */
export function checkResponseHeadersTimeoutMs(ms: number): number {
  if (!Number.isFinite(ms) || ms < 1 || ms > MAX_TIMER_MS) {
    throw new RangeError(
      `responseHeadersTimeoutMs must be a number of milliseconds from 1 to ${String(MAX_TIMER_MS)} (got ${String(ms)})`,
    );
  }
  return ms;
}

export interface NodeStreamFetchOptions {
  /** Test seam; production uses CAPTURE_RESPONSE_HEADERS_TIMEOUT_MS. */
  readonly responseHeadersTimeoutMs?: number;
}

/**
 * The production streaming transport. Deliberately NOT global fetch:
 * undici's default 5-minute body inactivity timeout can abort a verify
 * stream while the scheduler run is still alive (a long quiet fixture),
 * severing the capture before the terminal frame and leaving an UNKNOWN
 * receipt for a run that later settles. A raw HTTP request has no
 * response idle timeout — the scheduler's run deadline is the only bound
 * — and real socket errors reach the receipt with their errno/cause.
 * The surface matches the FetchLike seam the tests inject: `ok`,
 * `status`, `body` (a byte stream) and `text()`.
 *
 * Connecting and receiving the response HEADERS are bounded (#389): the
 * verify service writes its 200 before any queue wait, so this bound only
 * ends a service that never completes the connection (a refused connection
 * fails at once with ECONNREFUSED) or accepted it and never answered — a
 * named transport error in an UNKNOWN receipt instead of a hang. The
 * body stays unbounded: a long quiet run is never cut off.
 */
export function nodeStreamFetch(input: string, init?: RequestInit, options: NodeStreamFetchOptions = {}): Promise<Response> {
  let responseHeadersTimeoutMs: number;
  try {
    responseHeadersTimeoutMs = checkResponseHeadersTimeoutMs(options.responseHeadersTimeoutMs ?? CAPTURE_RESPONSE_HEADERS_TIMEOUT_MS);
  } catch (error) {
    // A Promise-returning transport fails by rejection, never a sync throw.
    return Promise.reject(error as Error);
  }
  return new Promise((resolve, reject) => {
    const url = new URL(input);
    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const headers: Record<string, string> = {};
    // Structural narrowing, deliberately avoiding DOM-only type names
    // (the project compiles without the DOM lib).
    const initHeaders: unknown = init?.headers;
    if (initHeaders instanceof Headers) {
      for (const [name, value] of initHeaders.entries()) headers[name] = value;
    } else if (Array.isArray(initHeaders)) {
      for (const entry of initHeaders as readonly (readonly [unknown, unknown])[]) {
        const name = entry[0];
        const value = entry[1];
        if (typeof name === 'string' && typeof value === 'string') headers[name] = value;
      }
    } else if (typeof initHeaders === 'object' && initHeaders !== null) {
      for (const [name, value] of Object.entries(initHeaders)) {
        if (value !== undefined) headers[name] = String(value);
      }
    }
    const body = init?.body;
    const bodyText: string | Buffer | null =
      typeof body === 'string' || Buffer.isBuffer(body) ? body : null;
    if (body !== undefined && body !== null && bodyText === null) {
      // The FetchLike surface is narrower than the DOM BodyInit union; a
      // body this transport cannot send is rejected loudly, never dropped.
      reject(new Error('nodeStreamFetch supports only string or Buffer request bodies'));
      return;
    }
    const method = init?.method ?? 'GET';
    let headersTimer: ReturnType<typeof setTimeout> | null = null;
    const clearHeadersTimer = (): void => {
      if (headersTimer !== null) clearTimeout(headersTimer);
      headersTimer = null;
    };
    const request = requestFn(url, { method, headers }, (response) => {
      clearHeadersTimer();
      let cachedBody: ReadableStream<Uint8Array> | null = null;
      let bodyAccessed = false;
      let consumedByText = false;
      const consumedBodyStream = (): ReadableStream<Uint8Array> =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error('response body unavailable: text()/json() already consumed it'));
          },
        });
      const text = (): Promise<string> => {
        // One response, one consumer. Every mixed or repeated consumption
        // fails loud here: the transport has no idle timeout by design, so
        // attaching another `end` listener to an already-ended response
        // would leave the caller hanging forever. Touching the byte-stream
        // surface claims it too (the narrow FetchLike surface is used with
        // exactly one style per response).
        if (consumedByText) {
          return Promise.reject(new Error('response text()/json() is one-shot; it was already consumed'));
        }
        if (bodyAccessed) {
          return Promise.reject(new Error('response body already consumed by the byte stream'));
        }
        consumedByText = true;
        return new Promise((resolveText, rejectText) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => resolveText(Buffer.concat(chunks).toString('utf-8')));
          response.on('error', rejectText);
        });
      };
      const result = {
        ok: response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300,
        status: response.statusCode ?? 0,
        get body(): ReadableStream<Uint8Array> | null {
          if (consumedByText) {
            cachedBody ??= consumedBodyStream();
            return cachedBody;
          }
          bodyAccessed = true;
          if (cachedBody === null) {
            cachedBody = new ReadableStream<Uint8Array>({
              start(controller) {
                response.on('data', (chunk: Buffer) => {
                  controller.enqueue(new Uint8Array(chunk));
                  // Bounded queue: stop reading the socket while the
                  // consumer is behind; pull() resumes it.
                  if (controller.desiredSize !== null && controller.desiredSize <= 0) response.pause();
                });
                response.on('end', () => controller.close());
                response.on('error', (error: Error) => controller.error(error));
              },
              pull() {
                response.resume();
              },
              cancel() {
                request.destroy();
                response.destroy();
              },
            });
          }
          return cachedBody;
        },
        text,
        json: async (): Promise<unknown> => JSON.parse(await text()) as unknown,
      };
      resolve(result as unknown as Response);
    });
    request.on('error', (error: Error) => {
      clearHeadersTimer();
      reject(error);
    });
    headersTimer = setTimeout(() => {
      headersTimer = null;
      request.destroy(Object.assign(
        new Error(
          `${method} ${url.origin}${url.pathname}: no response within ${String(responseHeadersTimeoutMs)} ms ` +
            '(connect + response headers) — the service is unreachable or hung. If the request reached it, it may ' +
            "still have been accepted: the outcome is unknown (run the capture helper's status action with the same " +
            '--request-id before rerunning)',
        ),
        { code: CAPTURE_RESPONSE_TIMEOUT_CODE },
      ));
    }, responseHeadersTimeoutMs);
    const signal = init?.signal;
    if (signal !== undefined && signal !== null) {
      if (signal.aborted) {
        request.destroy(new Error('request aborted'));
      } else {
        signal.addEventListener('abort', () => request.destroy(new Error('request aborted')), { once: true });
      }
    }
    if (bodyText !== null) request.write(bodyText);
    request.end();
  });
}

/** The transport of every command that talks to the verify service (run,
 * status). A headers bound that cannot time correctly is a programming error
 * in the caller's deps: it fails loud here — after the command's flag and
 * owner usage refusals, before its first side effect (stale-owner removal,
 * sink, request or receipt) — and never surfaces as an UNKNOWN receipt
 * mid-run (#389). An injected `fetchImpl` is used as-is: the bound is still
 * validated, but only the default transport applies it. Commands that make
 * no request (withdraw) never consult it. */
function transportFor(deps: CaptureCliDeps): FetchLike {
  if (deps.responseHeadersTimeoutMs !== undefined) checkResponseHeadersTimeoutMs(deps.responseHeadersTimeoutMs);
  return deps.fetchImpl ?? ((input, init) => nodeStreamFetch(input, init, { responseHeadersTimeoutMs: deps.responseHeadersTimeoutMs }));
}

/**
 * A transport whose connect + response-headers bound never outlives the
 * capture's remaining wait budget (#554): each attempt gets the smaller of
 * the configured bound and the budget left, so `--wait-budget-ms 300`
 * against a service that never answers abandons at ~300 ms instead of
 * waiting out the 60 s default bound. An injected transport keeps its own
 * timing (the caller owns it).
 */
function boundedTransportFor(deps: CaptureCliDeps, remainingMs: number): FetchLike {
  if (deps.fetchImpl !== undefined) return deps.fetchImpl;
  const configured = deps.responseHeadersTimeoutMs ?? CAPTURE_RESPONSE_HEADERS_TIMEOUT_MS;
  const effective = Math.max(1, Math.min(configured, Math.floor(remainingMs)));
  checkResponseHeadersTimeoutMs(effective);
  return (input, init) => nodeStreamFetch(input, init, { responseHeadersTimeoutMs: effective });
}

/** Does this transport error mean the response headers never arrived? Only
 * that one case is re-submitted (#554); a refused/reset connection and a
 * stream severed after the headers keep today's single-attempt receipt. */
export function isResponseHeadersTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === CAPTURE_RESPONSE_TIMEOUT_CODE) return true;
  const cause = (error as { readonly cause?: unknown }).cause;
  return (
    typeof cause === 'object' &&
    cause !== null &&
    (cause as NodeJS.ErrnoException).code === CAPTURE_RESPONSE_TIMEOUT_CODE
  );
}

/** Transport errors keep the primary message and add the underlying code
 * (the runtime attaches it either on the error itself or on its cause)
 * so a severed stream is diagnosable from the receipt instead of a bare
 * "terminated". */
export function describeTransportError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const ownCode = (error as NodeJS.ErrnoException).code;
  const base =
    ownCode === undefined || ownCode === '' ? error.message : `${error.message} (code ${String(ownCode)})`;
  const cause = error.cause;
  if (cause === undefined) return base;
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  const causeText =
    cause instanceof Error
      ? `${cause.name}: ${cause.message}${code === undefined || code === '' ? '' : ` (code ${String(code)})`}`
      : String(cause);
  return `${base} — cause: ${causeText}`;
}

export interface CaptureCliDeps {
  readonly fetchImpl?: FetchLike;
  /** Test seam for the default transport's connect + headers bound. */
  readonly responseHeadersTimeoutMs?: number;
  readonly now?: () => number;
  readonly probe?: (pid: number) => ProcessProbe;
  readonly signal?: (pid: number, signal: NodeJS.Signals) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  readonly cwd?: () => string;
  readonly argv?: readonly string[];
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

function printUsage(stream: (text: string) => void): void {
  stream(
    [
      'usage:',
      '  capture run --job <id> [--scope <scope>] --sink <path> [--request-id <id>]',
      '              [--expected-head <sha>] [--wait-budget-ms <n>]',
      '              [--url <base>] [--config <path> | --token <token>]',
      '  capture status --request-id <id> [--url <base>] [--config <path> | --token <token>] [--out <path>]',
      '  capture withdraw --owner <owner.json> [--kill-grace-ms <n>]',
      '',
    ].join('\n'),
  );
}

/** Parse `--name value` / `--name=value` pairs; a bare `--` terminates flags. */
function parseFlags(argv: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === '--') break;
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument "${arg}"`);
    const body = arg.slice(2);
    const equals = body.indexOf('=');
    if (equals >= 0) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new UsageError(`--${body} requires a value`);
    }
    flags.set(body, value);
    index += 1;
  }
  return flags;
}

function required(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined || value === '') throw new UsageError(`--${name} is required`);
  return value;
}

function readTokenFromConfig(path: string): string | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
  // The [auth] table's token, never a `token` key in another table (such
  // as an [env] secret): a TOML read, not a line match.
  let raw: { auth?: { token?: unknown } };
  try {
    raw = parse(text) as typeof raw;
  } catch (error) {
    // The reason and position only: the parser's excerpt quotes the file.
    const where = error instanceof TomlError ? ` (${error.message.split('\n', 1)[0] ?? ''} at line ${error.line}, column ${error.column})` : '';
    throw new UsageError(
      `--config ${path} is not valid TOML${where}, so its [auth] token cannot be read. The running service keeps the config it loaded; the operator must fix this file (do not open or edit it from a job), then retry the same request`,
    );
  }
  const token = raw.auth?.token;
  return typeof token === 'string' && token !== '' ? token : null;
}

/** Resolve the ops base URL + pairing token (flags → env → config file). */
function resolveOps(flags: Map<string, string>): { baseUrl: string; token: string } {
  const baseUrl = (flags.get('url') ?? process.env['GRU_OPS_URL'] ?? '').replace(/\/+$/u, '');
  if (baseUrl === '') throw new UsageError('--url (or GRU_OPS_URL) is required');
  const flagToken = flags.get('token');
  const configPath = flags.get('config') ?? process.env['GRU_COMMAND_CONFIG'];
  const token =
    flagToken !== undefined && flagToken !== ''
      ? flagToken
      : configPath === undefined
        ? process.env['GRU_OPS_TOKEN'] ?? ''
        : readTokenFromConfig(configPath) ?? '';
  if (token === '') {
    throw new UsageError('--token (or GRU_OPS_TOKEN), or --config pointing at a config with [auth] token, is required');
  }
  return { baseUrl, token };
}

/**
 * Parse `ps -o lstart=,command=` output. BSD/macOS lstart uses variable
 * whitespace (`Sun  4 Oct ...`), so the five date fields split on runs of
 * whitespace — a single-space pattern would silently yield no identity.
 */
export function parsePsOutput(output: string): {
  readonly startTime: string | null;
  readonly command: string | null;
} {
  const match = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.*)$/u.exec(output.trim());
  if (match === null) return { startTime: null, command: null };
  return { startTime: match[1] ?? null, command: match[2] ?? null };
}

/** Best-effort live probe: aliveness, start time, command, cwd. */
export function systemProcessProbe(pid: number): ProcessProbe {
  if (!pidAlive(pid)) return { alive: false, startTime: null, cwd: null, command: null };
  let startTime: string | null = null;
  let command: string | null = null;
  try {
    const output = execFileSync('ps', ['-o', 'lstart=,command=', '-p', String(pid)], {
      encoding: 'utf-8',
      timeout: 5_000,
    });
    ({ startTime, command } = parsePsOutput(output));
  } catch {
    /* start time/command unavailable — identity stays unverifiable */
  }
  let cwd: string | null = null;
  try {
    cwd = readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    try {
      const output = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
        encoding: 'utf-8',
        timeout: 5_000,
      });
      const line = output.split('\n').find((candidate) => candidate.startsWith('n'));
      if (line !== undefined) cwd = line.slice(1);
    } catch {
      /* cwd unavailable */
    }
  }
  return { alive: true, startTime, command, cwd };
}

function defaultSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function writeOwnerFor(
  sinkPath: string,
  requestId: string,
  probe: (pid: number) => ProcessProbe,
  cwd: string,
  argv: readonly string[],
  now: () => number,
): void {
  const self = probe(process.pid);
  const record: CaptureOwnerRecord = {
    version: CAPTURE_OWNER_VERSION,
    pid: process.pid,
    start_time: self.startTime,
    cwd,
    // The OS-reported command is the one withdrawal compares against; the
    // local argv is only a fallback when the probe cannot read it.
    command: self.command ?? argv.join(' '),
    request_id: requestId,
    sink: sinkPath,
    run_id: null,
    created_at: new Date(now()).toISOString(),
  };
  writeCaptureOwner(captureOwnerPath(sinkPath), record);
}

async function commandRun(
  flags: Map<string, string>,
  deps: CaptureCliDeps,
  stderr: (text: string) => void,
  stdout: (text: string) => void,
): Promise<CaptureExitCode> {
  const jobId = required(flags, 'job');
  const scope = flags.get('scope') ?? 'full';
  const sinkPath = required(flags, 'sink');
  const requestId = flags.get('request-id') ?? randomUUID();
  const expectedHead = flags.get('expected-head') ?? null;
  const waitBudgetRaw = flags.get('wait-budget-ms') ?? String(CAPTURE_WAIT_BUDGET_MS);
  const waitBudgetMs = Number(waitBudgetRaw);
  if (!Number.isInteger(waitBudgetMs) || waitBudgetMs < 1) {
    throw new UsageError(
      `--wait-budget-ms must be a positive integer number of milliseconds, got ${JSON.stringify(waitBudgetRaw)}`,
    );
  }
  const { baseUrl, token } = resolveOps(flags);
  const probe = deps.probe ?? systemProcessProbe;
  const now = deps.now ?? Date.now;
  const ownerPath = captureOwnerPath(sinkPath);

  // A live owner means ANOTHER capture already watches this sink: never
  // start a second watcher; reconcile with the status action and the same
  // --request-id.
  const ownerRead = readCaptureOwner(ownerPath);
  if (ownerRead.kind === 'malformed') {
    stderr(`capture: ${ownerPath} is malformed (${ownerRead.detail}) — withdraw it explicitly first\n`);
    return CAPTURE_EXIT.usage;
  }
  const ownerAlive = ownerRead.kind === 'owner' && probe(ownerRead.record.pid).alive;
  if (ownerRead.kind === 'owner' && ownerAlive) {
    stderr(
      `capture: sink ${sinkPath} is owned by live helper pid ${String(ownerRead.record.pid)} ` +
        `(request_id ${ownerRead.record.request_id}) — reconnecting is a same-request_id reconcile, ` +
        'not a second watcher\n',
    );
    return CAPTURE_EXIT.usage;
  }
  // After every usage refusal above, before this command's first side effect.
  // Validates the configured headers bound (an injected transport is used
  // as-is; the default one is rebuilt per attempt with the remaining budget).
  transportFor(deps);
  // A live owner returned above; restating !ownerAlive keeps the deletion safe
  // even if that refusal is ever edited. The probe found this claim's owner gone.
  if (ownerRead.kind === 'owner' && !ownerAlive) removeCaptureOwner(ownerPath);

  // Exclusive sink BEFORE the POST (a second capture for the same path is
  // a typed refusal, never a truncating interleave).
  let sink;
  try {
    sink = openExclusiveCaptureSink(sinkPath);
  } catch (error) {
    if (error instanceof CaptureSinkExistsError) {
      stderr(`capture: ${error.message}\n`);
      return CAPTURE_EXIT.usage;
    }
    throw error;
  }
  try {
    writeOwnerFor(sinkPath, requestId, probe, deps.cwd?.() ?? process.cwd(), deps.argv ?? process.argv, now);
  } catch (error) {
    if (error instanceof CaptureOwnerExistsError) {
      try {
        sink.close();
        rmSync(sinkPath, { force: true });
      } catch {
        /* best effort: an empty sink we created */
      }
      stderr(`capture: ${error.message}\n`);
      return CAPTURE_EXIT.usage;
    }
    throw error;
  }

  const captureReader = new NdjsonCaptureReader();
  // Issue #554: a headers timeout is not a lost run. The helper re-submits
  // the SAME request_id and body (the scheduler's single-flight then attaches
  // it to the in-flight attempt or replays the completed one) until it gets a
  // response, and only past the total wait bound abandons loudly.
  const requestBody = JSON.stringify({
    job_id: jobId,
    scope,
    request_id: requestId,
    ...(expectedHead === null ? {} : { expected_head: expectedHead }),
  });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitStartedAt = now();
  let attempts = 0;
  let abandonedAfterMs: number | null = null;
  let lastHeadersTimeout: unknown = null;
  let httpError: string | null = null;
  let transportError: string | null = null;
  for (;;) {
    attempts += 1;
    const remainingMs = waitBudgetMs - (now() - waitStartedAt);
    let response: Response;
    try {
      response = await boundedTransportFor(deps, remainingMs)(`${baseUrl}/api/verify`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: requestBody,
      });
    } catch (error) {
      if (!isResponseHeadersTimeout(error)) {
        // A refused/reset connection is today's UNKNOWN: re-submitting could
        // not recover a request the service never saw as this identity.
        transportError = describeTransportError(error);
        break;
      }
      // Out of scope (#554): a stream severed AFTER the headers already wrote
      // frames into this sink — never re-submit into it.
      if (sink.bytes > 0) {
        transportError = describeTransportError(error);
        break;
      }
      lastHeadersTimeout = error;
      const left = waitBudgetMs - (now() - waitStartedAt);
      if (left <= 0) {
        abandonedAfterMs = now() - waitStartedAt;
        break;
      }
      await sleep(Math.min(CAPTURE_RESUBMIT_DELAY_MS, left));
      if (waitBudgetMs - (now() - waitStartedAt) <= 0) {
        abandonedAfterMs = now() - waitStartedAt;
        break;
      }
      continue;
    }
    // One response ends the re-submit loop: its body is the run's stream, and
    // a body that then severs keeps the pre-existing UNKNOWN outcome.
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      httpError = `HTTP ${String(response.status)}: ${detail.slice(0, 500)}`;
    } else if (response.body !== null) {
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value !== undefined) {
            const text = decoder.decode(value, { stream: true });
            sink.write(text);
            captureReader.push(text);
          }
        }
        const tail = decoder.decode();
        if (tail !== '') {
          sink.write(tail);
          captureReader.push(tail);
        }
      } catch (error) {
        transportError = describeTransportError(error);
      }
    }
    break;
  }
  const digest = sink.close();
  const parsed = captureReader.finish();
  const fields = parsed.outcome === null ? null : capturedOutcomeFields(parsed.outcome);

  let outcome: CaptureOutcome;
  let exitCode: CaptureExitCode;
  let error: string | null = null;
  if (abandonedAfterMs !== null) {
    // Past the bound: loud, never a silent 0-byte "nothing happened". The
    // run may still have been accepted and completed, so the receipt names
    // the identity and the reconcile path instead of inviting a rerun.
    outcome = 'unknown';
    exitCode = CAPTURE_EXIT.unknown;
    error =
      `the service never answered ${String(attempts)} submission(s) of request_id "${requestId}" within ` +
      `--wait-budget-ms ${String(waitBudgetMs)} (abandoned after ${String(abandonedAfterMs)} ms) — the run may ` +
      'still be accepted and complete; reconcile with the capture helper\'s status action ' +
      `(--request-id ${requestId}) and read verification.completed in the ledger before rerunning; last attempt: ` +
      `${lastHeadersTimeout === null ? 'no response' : describeTransportError(lastHeadersTimeout)}`;
  } else if (httpError !== null) {
    outcome = 'unknown';
    exitCode = CAPTURE_EXIT.usage;
    error = httpError;
  } else if (transportError !== null) {
    // A connection severed before clean EOF is UNKNOWN, even when a
    // completed-looking frame arrived: the stream never finished.
    outcome = 'unknown';
    exitCode = CAPTURE_EXIT.unknown;
    error = transportError;
  } else if (fields !== null && parsed.malformed === 0) {
    outcome = 'completed';
    exitCode = fields.ok ? CAPTURE_EXIT.ok : CAPTURE_EXIT.failed;
    if (expectedHead !== null && fields.head !== expectedHead) {
      exitCode = CAPTURE_EXIT.failed;
      error = `head changed: outcome binds ${fields.head ?? 'no head'}, expected ${expectedHead}`;
    } else if (fields.trackedDirty) {
      exitCode = CAPTURE_EXIT.failed;
      error = 'tracked tree was dirty at run start — the run binds to no commit';
    }
  } else if (parsed.errorCode === 'lock_wait_timeout' && !parsed.started) {
    outcome = 'admission-failed';
    exitCode = CAPTURE_EXIT.admissionFailed;
    error = parsed.errorDetail ?? 'lock wait timed out before the run started';
  } else {
    outcome = 'unknown';
    exitCode = CAPTURE_EXIT.unknown;
    error =
      parsed.errorDetail ??
      (parsed.malformed > 0
        ? `capture stream held ${String(parsed.malformed)} malformed record(s) — not a single-run capture`
        : 'stream ended without a terminal completed frame');
  }

  const baseReceipt: CaptureReceipt = {
    version: CAPTURE_RECEIPT_VERSION,
    request_id: requestId,
    sink: sinkPath,
    outcome,
    reconciled: parsed.reconciled,
    frames: parsed.frames,
    pings: parsed.pings,
    capture_bytes: digest.bytes,
    capture_sha256: digest.sha256,
    run_id: fields?.runId ?? null,
    head: fields?.head ?? null,
    expected_head: expectedHead,
    tracked_dirty: fields?.trackedDirty ?? null,
    ok: fields?.ok ?? null,
    exit_code: fields?.exitCode ?? null,
    signal: fields?.signal ?? null,
    timed_out: fields?.timedOut ?? null,
    output_bytes: fields?.outputBytes ?? null,
    output_sha256: fields?.outputSha256 ?? null,
    captured_output_bytes: parsed.capturedOutputBytes,
    captured_output_sha256: parsed.capturedOutputSha256,
    replayed_output: parsed.replayedOutput,
    attempts,
    abandoned_after_ms: abandonedAfterMs,
    started: parsed.started,
    error,
    detail: error,
    completed_at: new Date(now()).toISOString(),
  };
  // Exit 0 ONLY for the complete success predicate (clean exact head, zero
  // exit, the sink's output equal to the run's, and a replay that carried it
  // from byte 0). A completed run that fails it is an honest exit 1 with a
  // receipt that cannot be promoted to evidence.
  if (outcome === 'completed' && !captureReceiptSucceeded(baseReceipt)) {
    exitCode = CAPTURE_EXIT.failed;
    error ??= captureRefusalDetail(baseReceipt);
  }
  const receipt: CaptureReceipt = { ...baseReceipt, error, detail: error };
  writeCaptureReceipt(captureReceiptPath(sinkPath), receipt);
  if (outcome === 'completed') removeCaptureOwner(ownerPath);
  stdout(`${JSON.stringify(receipt, null, 2)}\n`);
  if (error !== null) stderr(`capture: ${error}\n`);
  return exitCode;
}

async function commandStatus(
  flags: Map<string, string>,
  deps: CaptureCliDeps,
  stderr: (text: string) => void,
  stdout: (text: string) => void,
): Promise<CaptureExitCode> {
  const requestId = required(flags, 'request-id');
  const { baseUrl, token } = resolveOps(flags);
  const fetchImpl = transportFor(deps);
  let response: Response;
  try {
    response = await fetchImpl(
      `${baseUrl}/api/verify/status?request_id=${encodeURIComponent(requestId)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
  } catch (error) {
    stderr(`capture: status unreachable: ${String(error instanceof Error ? error.message : error)}\n`);
    return CAPTURE_EXIT.unknown;
  }
  const text = await response.text();
  if (!response.ok) {
    stderr(`capture: status HTTP ${String(response.status)}: ${text.slice(0, 500)}\n`);
    return CAPTURE_EXIT.usage;
  }
  const out = flags.get('out');
  if (out !== undefined) {
    try {
      writeFileSync(out, text, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      stderr(`capture: cannot write --out ${out}: ${String(error)}\n`);
      return CAPTURE_EXIT.usage;
    }
  }
  stdout(text.endsWith('\n') ? text : `${text}\n`);
  return CAPTURE_EXIT.ok;
}

async function commandWithdraw(
  flags: Map<string, string>,
  deps: CaptureCliDeps,
  stderr: (text: string) => void,
  stdout: (text: string) => void,
): Promise<CaptureExitCode> {
  const ownerPath = required(flags, 'owner');
  const killGraceRaw = flags.get('kill-grace-ms') ?? '5000';
  const killGraceMs = Number(killGraceRaw);
  if (!Number.isFinite(killGraceMs) || killGraceMs < 0) {
    throw new UsageError(`--kill-grace-ms must be a non-negative number, got ${JSON.stringify(killGraceRaw)}`);
  }
  const result = await withdrawCaptureOwner(ownerPath, {
    probe: deps.probe ?? systemProcessProbe,
    signal: deps.signal ?? defaultSignal,
    sleep: deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    killGraceMs,
  });
  stdout(`${JSON.stringify(result)}\n`);
  if (result.verdict === 'refused') {
    stderr(`capture: withdrawal refused: ${result.reason}\n`);
    return CAPTURE_EXIT.usage;
  }
  return CAPTURE_EXIT.ok;
}

export async function runCaptureCli(argv: readonly string[], deps: CaptureCliDeps = {}): Promise<CaptureExitCode> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    printUsage(stderr);
    return CAPTURE_EXIT.usage;
  }
  let flags: Map<string, string>;
  try {
    flags = parseFlags(rest);
  } catch (error) {
    stderr(`capture: ${error instanceof Error ? error.message : String(error)}\n`);
    printUsage(stderr);
    return CAPTURE_EXIT.usage;
  }
  try {
    switch (command) {
      case 'run':
        return await commandRun(flags, deps, stderr, stdout);
      case 'status':
        return await commandStatus(flags, deps, stderr, stdout);
      case 'withdraw':
        return await commandWithdraw(flags, deps, stderr, stdout);
      default:
        stderr(`capture: unknown command "${command}"\n`);
        printUsage(stderr);
        return CAPTURE_EXIT.usage;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      stderr(`capture: ${error.message}\n`);
      return CAPTURE_EXIT.usage;
    }
    throw error;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  runCaptureCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`capture: fatal: ${String(error instanceof Error ? error.message : error)}\n`);
      process.exitCode = CAPTURE_EXIT.usage;
    },
  );
}
