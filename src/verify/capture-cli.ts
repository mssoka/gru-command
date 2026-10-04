#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
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
 *     --url <base> --config <config.toml> [--token <token>]
 *
 * The sink is created exclusively BEFORE the POST, every NDJSON frame is
 * streamed to EOF, and the terminal receipt (`<sink>.receipt.json`) binds
 * run id, head/dirty, exit/outcome and output length/hash. A stream that
 * ends without a valid terminal completion is `unknown`, never success.
 * Reconnecting with the same `--request-id` reconciles (attach/replay) on
 * the server — it never replays an unknown-outcome submission blind.
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

export interface CaptureCliDeps {
  readonly fetchImpl?: FetchLike;
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
      '              [--expected-head <sha>] [--url <base>] [--config <path> | --token <token>]',
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
  const match = /^\s*token\s*=\s*"([^"]+)"/mu.exec(text);
  return match?.[1] ?? null;
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
  const { baseUrl, token } = resolveOps(flags);
  const probe = deps.probe ?? systemProcessProbe;
  const fetchImpl: FetchLike = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const ownerPath = captureOwnerPath(sinkPath);

  // A live owner means ANOTHER capture already watches this sink: never
  // start a second watcher; reconcile through `status`/same request id.
  const ownerRead = readCaptureOwner(ownerPath);
  if (ownerRead.kind === 'malformed') {
    stderr(`capture: ${ownerPath} is malformed (${ownerRead.detail}) — withdraw it explicitly first\n`);
    return CAPTURE_EXIT.usage;
  }
  if (ownerRead.kind === 'owner') {
    const live = probe(ownerRead.record.pid);
    if (live.alive) {
      stderr(
        `capture: sink ${sinkPath} is owned by live helper pid ${String(ownerRead.record.pid)} ` +
          `(request_id ${ownerRead.record.request_id}) — reconnecting is a same-request_id reconcile, ` +
          'not a second watcher\n',
      );
      return CAPTURE_EXIT.usage;
    }
    removeCaptureOwner(ownerPath); // stale claim: the owner is gone
  }

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
  let httpError: string | null = null;
  let transportError: string | null = null;
  try {
    const response = await fetchImpl(`${baseUrl}/api/verify`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        job_id: jobId,
        scope,
        request_id: requestId,
        ...(expectedHead === null ? {} : { expected_head: expectedHead }),
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      httpError = `HTTP ${String(response.status)}: ${detail.slice(0, 500)}`;
    } else if (response.body !== null) {
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
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
    }
  } catch (error) {
    transportError = String(error instanceof Error ? error.message : error);
  }
  const digest = sink.close();
  const parsed = captureReader.finish();
  const fields = parsed.outcome === null ? null : capturedOutcomeFields(parsed.outcome);

  let outcome: CaptureOutcome;
  let exitCode: CaptureExitCode;
  let error: string | null = null;
  if (httpError !== null) {
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
    started: parsed.started,
    error,
    completed_at: new Date(now()).toISOString(),
  };
  // Exit 0 ONLY for the complete success predicate (clean exact head, zero
  // exit, bound output, not a replay). A completed run that fails it is an
  // honest exit 1 with a receipt that cannot be promoted to evidence.
  if (outcome === 'completed' && !captureReceiptSucceeded(baseReceipt)) {
    exitCode = CAPTURE_EXIT.failed;
    error ??= baseReceipt.reconciled
      ? 'replayed terminal receipt is not a promotable full capture — the ledger holds the run; do not rerun to recover logs'
      : 'completed run is not a promotable exact-head PASS';
  }
  const receipt: CaptureReceipt = { ...baseReceipt, error };
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
  const fetchImpl: FetchLike = deps.fetchImpl ?? fetch;
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
